import { AppError } from "../../shared/error/app-error";
import {
  NOVELIA_HOSTS,
  REMOTE_NOVEL_MAX_BYTES,
  build_novel_filename,
  read_remote_translations,
  sha256_text,
  split_remote_document,
  type RemoteNovelRef,
} from "./novelia-source";

/** 元数据与目录读取预算，下载与上传使用更宽松的独立预算。 */
const METADATA_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const WORKSPACE_TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const TRANSLATOR_ID = "gpt";
const UPLOAD_RETRY_ATTEMPTS = 3;
const UPLOAD_RETRY_BASE_MS = 1_000;
const UPLOAD_RETRY_MAX_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** 站点客户端只依赖可注入的 fetch 与 token 读取，测试不需要真实网络。 */
export interface NoveliaHttpPort {
  fetch: typeof globalThis.fetch;
}

export type NoveliaTokenReader = (origin: string) => string | null;

export interface RemoteNovelVolume {
  volume_id: string;
  title: string;
}

export interface RemoteNovelMetadata {
  title: string; // 中文标题优先，用于资产文件名
  title_jp: string;
  title_zh: string | null;
  introduction_jp: string;
  introduction_zh: string | null;
  glossary: Record<string, string>;
  chapter_count: number;
  volumes: RemoteNovelVolume[]; // 网页小说为空
}

export interface RemoteNovelDownload {
  metadata: RemoteNovelMetadata;
  text: string;
  translations: ReadonlyMap<number, string>; // 站点 GPT 译文，键为原文行号
  filename: string;
  content_hash: string;
  chapter_count: number;
}

export interface RemoteWorkspaceChapter {
  chapter_id: string;
  volume_id: string | null; // 文库章节所属分卷
  title: string;
  translated: boolean; // 站点已有译文
}

export interface RemoteWorkspace {
  title_jp: string;
  title_zh: string | null;
  introduction_jp: string;
  introduction_zh: string | null;
  glossary_id: string;
  glossary: Record<string, string>;
  chapters: RemoteWorkspaceChapter[];
}

export interface RemoteChapterTask {
  paragraph_jp: string[];
  old_paragraph_zh: string[] | null;
  glossary_id: string;
  glossary: Record<string, string>;
  old_glossary_id: string | null;
}

export interface RemoteChapterTranslation {
  glossary_id: string;
  paragraphs_zh: string[];
}

/**
 * n.novelia.cc 与同源镜像的只读抓取和工作区写入。
 * 所有请求共享代理、超时、重定向白名单与错误归一，不向上层泄漏响应正文。
 */
export class NoveliaClient {
  public constructor(
    private readonly http: NoveliaHttpPort,
    private readonly read_token: NoveliaTokenReader,
  ) {}

  /** 网页小说与文库的元数据都走公开接口；有 token 时仍然携带以便读取受限作品。 */
  public async read_metadata(
    ref: RemoteNovelRef,
    signal?: AbortSignal,
  ): Promise<RemoteNovelMetadata> {
    const timeout = this.resolve_deadline(signal, METADATA_TIMEOUT_MS);
    if (ref.kind === "web") {
      const root = await this.request_json(
        ref,
        `/api/novel/${encodeURIComponent(ref.provider_id)}/${encodeURIComponent(ref.novel_id)}`,
        "optional",
        timeout,
      );
      return this.parse_web_metadata(root);
    }
    const root = await this.request_json(
      ref,
      `/api/wenku/${encodeURIComponent(ref.novel_id)}`,
      "optional",
      timeout,
    );
    return this.parse_wenku_metadata(root);
  }

  /**
   * 整本下载：网页小说直接使用站点 TXT 导出；文库没有日语单文件导出，
   * 按分卷目录逐章读取原文后在本机拼装成同一份单文件 TXT。
   */
  public async download(
    ref: RemoteNovelRef,
    signal?: AbortSignal,
    options: { translations?: boolean } = {},
  ): Promise<RemoteNovelDownload> {
    const timeout = this.resolve_deadline(signal, DOWNLOAD_TIMEOUT_MS);
    const metadata = await this.read_metadata(ref, timeout);
    const include_translations = options.translations === true;
    let text: string;
    let translations: ReadonlyMap<number, string>;
    if (ref.kind === "web") {
      // 原文与双语导出并行请求，沿用站点译文不会让整本导入耗时翻倍。
      const [source_text, translated_text] = await Promise.all([
        this.download_web_text(ref, metadata, timeout),
        include_translations
          ? this.download_web_translations(ref, metadata, timeout, signal)
          : Promise.resolve(""),
      ]);
      text = source_text;
      translations = read_remote_translations(source_text, translated_text);
    } else {
      const wenku = await this.download_wenku_text(ref, metadata, timeout, include_translations);
      text = wenku.text;
      translations = wenku.translations;
    }
    const chapter_count = count_chapters(text);
    if (chapter_count === 0) {
      throw new AppError("remote.workspace_empty", {
        message: "The downloaded novel has no readable chapters.",
        diagnostic_context: { origin: ref.origin, novel_id: ref.novel_id },
      });
    }
    return {
      metadata,
      text,
      translations,
      filename: build_novel_filename(metadata.title),
      content_hash: sha256_text(text),
      chapter_count,
    };
  }

  /** 工作区任务为提交提供站点章节顺序与已有译文状态。 */
  public async read_workspace(ref: RemoteNovelRef, signal?: AbortSignal): Promise<RemoteWorkspace> {
    const timeout = this.resolve_deadline(signal, WORKSPACE_TIMEOUT_MS);
    if (ref.kind === "web") {
      const root = await this.request_json(
        ref,
        `/api/novel/${encodeURIComponent(ref.provider_id)}/${encodeURIComponent(ref.novel_id)}/translate-v2/${TRANSLATOR_ID}`,
        "required",
        timeout,
      );
      return this.parse_web_workspace(root);
    }
    const metadata = await this.read_metadata(ref, timeout);
    const workspace: RemoteWorkspace = {
      title_jp: metadata.title_jp,
      title_zh: metadata.title_zh,
      introduction_jp: metadata.introduction_jp,
      introduction_zh: metadata.introduction_zh,
      glossary_id: "no glossary",
      glossary: metadata.glossary,
      chapters: [],
    };
    for (const volume of metadata.volumes) {
      const toc = await this.read_wenku_volume_toc(ref, volume.volume_id, timeout);
      workspace.glossary_id = toc.glossary_id;
      for (const chapter of toc.chapters) {
        workspace.chapters.push({
          chapter_id: chapter.chapter_id,
          volume_id: volume.volume_id,
          title: build_wenku_chapter_title(volume.title, chapter.chapter_id),
          translated: chapter.translated,
        });
      }
    }
    if (workspace.chapters.length === 0) {
      throw new AppError("remote.workspace_empty", {
        message: "The remote novel has no readable chapters.",
        diagnostic_context: { origin: ref.origin, novel_id: ref.novel_id },
      });
    }
    return workspace;
  }

  /** 网页小说提交前刷新外语原文；文库章节来自已上传分卷，没有同步参数。 */
  public async read_chapter_task(
    ref: RemoteNovelRef,
    chapter: RemoteWorkspaceChapter,
    options: { sync: boolean },
    signal?: AbortSignal,
  ): Promise<RemoteChapterTask> {
    const timeout = this.resolve_deadline(signal, WORKSPACE_TIMEOUT_MS);
    const root =
      ref.kind === "web"
        ? await this.request_json(
            ref,
            `/api/novel/${encodeURIComponent(ref.provider_id)}/${encodeURIComponent(ref.novel_id)}/translate-v2/${TRANSLATOR_ID}/chapter-task/${encodeURIComponent(chapter.chapter_id)}?sync=${options.sync ? "true" : "false"}`,
            "required",
            timeout,
            "POST",
          )
        : await this.request_json(
            ref,
            build_wenku_chapter_task_path(ref, chapter),
            "required",
            timeout,
          );
    return parse_chapter_task(root);
  }

  /** 上传整章译文；术语表失效时由上层刷新任务后重试一次。 */
  public async write_chapter_translation(
    ref: RemoteNovelRef,
    chapter: RemoteWorkspaceChapter,
    translation: RemoteChapterTranslation,
    signal?: AbortSignal,
  ): Promise<void> {
    const timeout = this.resolve_deadline(signal, UPLOAD_TIMEOUT_MS);
    const path =
      ref.kind === "web"
        ? `/api/novel/${encodeURIComponent(ref.provider_id)}/${encodeURIComponent(ref.novel_id)}/translate-v2/${TRANSLATOR_ID}/chapter/${encodeURIComponent(chapter.chapter_id)}`
        : `${build_wenku_chapter_task_path(ref, chapter).replace(/\/chapter-task\//u, "/chapter/")}`;
    const body = JSON.stringify({
      glossaryId: translation.glossary_id,
      paragraphsZh: translation.paragraphs_zh,
      sakuraVersion: "0.9",
    } satisfies Record<string, unknown>);
    let last_error: unknown = null;
    for (let attempt = 0; attempt < UPLOAD_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const response = await this.request(ref, path, "required", timeout, "POST", body);
        await response.body?.cancel();
        return;
      } catch (error) {
        last_error = error;
        if (!is_retryable_upload_error(error) || attempt + 1 >= UPLOAD_RETRY_ATTEMPTS) break;
        if (signal?.aborted === true) throw signal.reason;
        await delay(read_retry_delay(error, attempt));
      }
    }
    throw last_error;
  }

  private async download_web_text(
    ref: RemoteNovelRef,
    metadata: RemoteNovelMetadata,
    signal: AbortSignal,
  ): Promise<string> {
    const query = new URLSearchParams({
      mode: "jp",
      translationsMode: "parallel",
      type: "txt",
      filename: build_novel_filename(metadata.title),
    });
    const response = await this.request(
      ref,
      `/api/novel/${encodeURIComponent(ref.provider_id)}/${encodeURIComponent(ref.novel_id)}/file?${query.toString()}`,
      "optional",
      signal,
    );
    await assert_not_html(response);
    return read_limited_text(response, REMOTE_NOVEL_MAX_BYTES);
  }

  /**
   * 站点双语导出包含现有 GPT 译文；这是增强信息，导出失败时按无译文导入，
   * 不影响源文。调用方取消仍直接传播。
   */
  private async download_web_translations(
    ref: RemoteNovelRef,
    metadata: RemoteNovelMetadata,
    signal: AbortSignal,
    caller_signal: AbortSignal | undefined,
  ): Promise<string> {
    const query = new URLSearchParams({
      mode: "jp-zh",
      translationsMode: "priority",
      translations: TRANSLATOR_ID,
      type: "txt",
      filename: build_novel_filename(metadata.title),
    });
    try {
      const response = await this.request(
        ref,
        `/api/novel/${encodeURIComponent(ref.provider_id)}/${encodeURIComponent(ref.novel_id)}/file?${query.toString()}`,
        "optional",
        signal,
      );
      await assert_not_html(response);
      return await read_limited_text(response, REMOTE_NOVEL_MAX_BYTES);
    } catch {
      if (caller_signal?.aborted === true) throw caller_signal.reason;
      return "";
    }
  }

  private async download_wenku_text(
    ref: RemoteNovelRef,
    metadata: RemoteNovelMetadata,
    signal: AbortSignal,
    include_translations: boolean,
  ): Promise<{ text: string; translations: Map<number, string> }> {
    const lines: string[] = [];
    const translations = new Map<number, string>();
    let total_bytes = 0;
    let line_cursor = 0;
    // 段落偶尔自带换行，行号按拼接后的文本行推进，和源文件解析保持一致。
    const push_line = (line: string): number => {
      total_bytes += Buffer.byteLength(line, "utf8") + 1;
      if (total_bytes > REMOTE_NOVEL_MAX_BYTES) {
        throw new AppError("remote.fetch_failed", {
          message: "The downloaded novel exceeds the size limit.",
          public_details: { max_bytes: REMOTE_NOVEL_MAX_BYTES },
        });
      }
      const row = line_cursor;
      lines.push(line);
      line_cursor += line.split("\n").length;
      return row;
    };
    push_line(metadata.title_jp);
    if (metadata.title_zh !== null && metadata.title_zh !== "") push_line(metadata.title_zh);
    push_line("");
    push_line("############");
    if (metadata.introduction_jp.trim() !== "") push_line(metadata.introduction_jp);
    push_line("");
    push_line("");
    for (const volume of metadata.volumes) {
      const toc = await this.read_wenku_volume_toc(ref, volume.volume_id, signal);
      for (const chapter of toc.chapters) {
        const task = await this.read_wenku_chapter(
          ref,
          volume.volume_id,
          chapter.chapter_id,
          signal,
        );
        push_line(`# ${build_wenku_chapter_title(volume.title, chapter.chapter_id)}`);
        push_line("");
        for (const [index, paragraph] of task.paragraph_jp.entries()) {
          const dst = task.old_paragraph_zh?.[index];
          const row = push_line(paragraph);
          // 文库章节任务已同时返回原文与旧译，行号按本机拼装顺序记录。
          if (include_translations && dst !== undefined && dst.trim() !== "") {
            translations.set(row, dst);
          }
        }
        push_line("");
      }
    }
    return { text: lines.join("\n"), translations };
  }

  private async read_wenku_volume_toc(
    ref: RemoteNovelRef,
    volume_id: string,
    signal: AbortSignal,
  ): Promise<{
    glossary_id: string;
    chapters: Array<{ chapter_id: string; translated: boolean }>;
  }> {
    const root = await this.request_json(
      ref,
      `/api/wenku/${encodeURIComponent(ref.novel_id)}/translate-v2/${TRANSLATOR_ID}/${encodeURIComponent(volume_id)}`,
      "required",
      signal,
    );
    const toc = require_array(root, "toc", "wenku.toc");
    return {
      glossary_id: optional_string(root, "glossaryId", "wenku") ?? "no glossary",
      chapters: toc.map((item, index) => {
        const entry = require_record(item, `wenku.toc[${index}]`);
        return {
          chapter_id: require_string(entry, "chapterId", `wenku.toc[${index}]`),
          translated: optional_string(entry, "glossaryId", `wenku.toc[${index}]`) !== null,
        };
      }),
    };
  }

  private async read_wenku_chapter(
    ref: RemoteNovelRef,
    volume_id: string,
    chapter_id: string,
    signal: AbortSignal,
  ): Promise<RemoteChapterTask> {
    const root = await this.request_json(
      ref,
      `/api/wenku/${encodeURIComponent(ref.novel_id)}/translate-v2/${TRANSLATOR_ID}/${encodeURIComponent(volume_id)}/chapter-task/${encodeURIComponent(chapter_id)}`,
      "required",
      signal,
    );
    return parse_chapter_task(root);
  }

  private parse_web_metadata(root: Record<string, unknown>): RemoteNovelMetadata {
    const title_jp = require_string(root, "titleJp", "novel");
    const title_zh = optional_string(root, "titleZh", "novel");
    const toc = require_array(root, "toc", "novel.toc");
    let chapter_count = 0;
    for (const [index, item] of toc.entries()) {
      const entry = require_record(item, `novel.toc[${index}]`);
      if (optional_string(entry, "chapterId", `novel.toc[${index}]`) !== null) chapter_count += 1;
    }
    return {
      title: display_title(title_zh, title_jp),
      title_jp,
      title_zh,
      introduction_jp: optional_string(root, "introductionJp", "novel") ?? "",
      introduction_zh: optional_string(root, "introductionZh", "novel"),
      glossary: read_string_map(root, "glossary"),
      chapter_count,
      volumes: [],
    };
  }

  private parse_wenku_metadata(root: Record<string, unknown>): RemoteNovelMetadata {
    const title_jp = require_string(root, "title", "wenku");
    const raw_title_zh = optional_string(root, "titleZh", "wenku");
    const title_zh = raw_title_zh !== null && raw_title_zh.trim() !== "" ? raw_title_zh : null;
    const raw_volumes = require_array(root, "volumes", "wenku.volumes");
    const raw_volume_jp = require_array(root, "volumeJp", "wenku.volumeJp");
    const volumes: RemoteNovelVolume[] = [];
    let chapter_count = 0;
    for (const [index, item] of raw_volume_jp.entries()) {
      const entry = require_record(item, `wenku.volumeJp[${index}]`);
      const volume_id = require_string(entry, "volumeId", `wenku.volumeJp[${index}]`);
      const meta =
        index < raw_volumes.length
          ? require_record(raw_volumes[index], `wenku.volumes[${index}]`)
          : null;
      const volume_title =
        meta === null ? "" : (optional_string(meta, "title", `wenku.volumes[${index}]`) ?? "");
      volumes.push({ volume_id, title: volume_title });
      chapter_count += read_integer(entry, "total", `wenku.volumeJp[${index}]`);
    }
    return {
      title: display_title(title_zh, title_jp),
      title_jp,
      title_zh,
      introduction_jp: optional_string(root, "introduction", "wenku") ?? "",
      introduction_zh: null,
      glossary: read_string_map(root, "glossary"),
      chapter_count,
      volumes,
    };
  }

  private parse_web_workspace(root: Record<string, unknown>): RemoteWorkspace {
    const toc = require_array(root, "toc", "workspace.toc");
    const chapters: RemoteWorkspaceChapter[] = [];
    for (const [index, item] of toc.entries()) {
      const entry = require_record(item, `workspace.toc[${index}]`);
      const chapter_id = optional_string(entry, "chapterId", `workspace.toc[${index}]`);
      // 目录中允许只有标题没有章节内容的分隔项，它们不参与提交。
      if (chapter_id === null) continue;
      chapters.push({
        chapter_id,
        volume_id: null,
        title: require_string(entry, "titleJp", `workspace.toc[${index}]`),
        translated: optional_string(entry, "glossaryUuid", `workspace.toc[${index}]`) !== null,
      });
    }
    if (chapters.length === 0) {
      throw new AppError("remote.workspace_empty", {
        message: "The remote novel has no readable chapters.",
      });
    }
    return {
      title_jp: require_string(root, "titleJp", "workspace"),
      title_zh: optional_string(root, "titleZh", "workspace"),
      introduction_jp: optional_string(root, "introductionJp", "workspace") ?? "",
      introduction_zh: optional_string(root, "introductionZh", "workspace"),
      glossary_id: optional_string(root, "glossaryUuid", "workspace") ?? "no glossary",
      glossary: read_string_map(root, "glossary"),
      chapters,
    };
  }

  /** 请求 JSON；重定向由本方法逐跳校验，响应体大小与形状都在边界收窄。 */
  private async request_json(
    ref: RemoteNovelRef,
    path: string,
    auth: "required" | "optional",
    signal: AbortSignal,
    method: "GET" | "POST" = "GET",
  ): Promise<Record<string, unknown>> {
    const response = await this.request(ref, path, auth, signal, method);
    const content_type = response.headers.get("content-type") ?? "";
    if (!content_type.toLowerCase().includes("json")) {
      await response.body?.cancel();
      throw new AppError("remote.fetch_failed", {
        message: "The novel site returned a non-JSON response.",
        public_details: { path },
      });
    }
    const text = await read_limited_text(response, MAX_JSON_BYTES);
    try {
      return require_record(JSON.parse(text) as unknown, "response");
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("remote.fetch_failed", {
        message: "The novel site returned invalid JSON.",
        cause: error,
        public_details: { path },
      });
    }
  }

  /**
   * 统一请求入口：附带 Bearer token、限制跳转次数并只允许站点域。
   * 上层取消直接传播；自身超时归一为 `remote.fetch_failed`。
   */
  private async request(
    ref: RemoteNovelRef,
    path: string,
    auth: "required" | "optional",
    signal: AbortSignal,
    method: "GET" | "POST" = "GET",
    body?: string,
  ): Promise<Response> {
    signal.throwIfAborted();
    const token = this.read_token(ref.origin);
    if (auth === "required" && token === null) {
      throw new AppError("remote.auth_missing", {
        public_details: { origin: ref.origin },
      });
    }
    const headers = new Headers({
      accept: "application/json, text/plain, */*",
    });
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    if (body !== undefined) headers.set("content-type", "application/json");
    let url = new URL(path, ref.origin);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      assert_allowed_url(url);
      let response: Response;
      try {
        response = await this.http.fetch(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw new AppError("remote.fetch_failed", {
          cause: error,
          diagnostic_context: { origin: ref.origin, path },
        });
      }
      if (!REDIRECT_STATUSES.has(response.status)) {
        this.assert_response_ok(response, token !== null, path);
        return response;
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (location === null) {
        throw new AppError("remote.fetch_failed", {
          message: "The novel site returned a redirect without a location.",
          public_details: { path },
        });
      }
      url = new URL(location, url);
    }
    throw new AppError("remote.fetch_failed", {
      message: "The novel site redirected too many times.",
      public_details: { path },
    });
  }

  /** 认证失败与普通站点失败分开，便于界面提示导入 token 而不是重试。 */
  private assert_response_ok(response: Response, has_token: boolean, path: string): void {
    if (response.ok) return;
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      throw new AppError(has_token ? "remote.auth_rejected" : "remote.auth_missing", {
        public_details: { status: response.status, path },
      });
    }
    throw new AppError("remote.fetch_failed", {
      message: `The novel site returned HTTP ${response.status}.`,
      public_details: { status: response.status, path },
      diagnostic_context: {
        status: response.status,
        retry_after: response.headers.get("retry-after"),
      },
    });
  }

  /** 调用方取消与自身超时合并；任一到点都会中断所有后续请求。 */
  private resolve_deadline(signal: AbortSignal | undefined, timeout_ms: number): AbortSignal {
    const timeout = AbortSignal.timeout(timeout_ms);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  }
}

/** 文库没有章节标题接口，用分卷标题加章节文件名生成稳定标题。 */
function build_wenku_chapter_title(volume_title: string, chapter_id: string): string {
  const title = volume_title.trim();
  return title === "" ? chapter_id : `${title} ${chapter_id}`;
}

function build_wenku_chapter_task_path(
  ref: RemoteNovelRef,
  chapter: RemoteWorkspaceChapter,
): string {
  if (chapter.volume_id === null) {
    throw new AppError("remote.fetch_failed", {
      message: "The volume of the remote chapter is missing.",
      public_details: { chapter_id: chapter.chapter_id },
    });
  }
  return `/api/wenku/${encodeURIComponent(ref.novel_id)}/translate-v2/${TRANSLATOR_ID}/${encodeURIComponent(chapter.volume_id)}/chapter-task/${encodeURIComponent(chapter.chapter_id)}`;
}

function display_title(title_zh: string | null, title_jp: string): string {
  const chinese = title_zh?.trim() ?? "";
  return chinese === "" ? title_jp : chinese;
}

function count_chapters(text: string): number {
  return split_remote_document(text).chapters.filter((chapter) => chapter.kind === "chapter")
    .length;
}

function parse_chapter_task(root: Record<string, unknown>): RemoteChapterTask {
  return {
    paragraph_jp: require_string_array(root, "paragraphJp", "chapter"),
    old_paragraph_zh: optional_string_array(root, "oldParagraphZh", "chapter"),
    glossary_id: optional_string(root, "glossaryId", "chapter") ?? "no glossary",
    glossary: read_string_map(root, "glossary"),
    old_glossary_id: optional_string(root, "oldGlossaryId", "chapter"),
  };
}

async function assert_not_html(response: Response): Promise<void> {
  const content_type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (content_type.includes("html")) {
    await response.body?.cancel();
    throw new AppError("remote.fetch_failed", {
      message: "The novel site returned an HTML page instead of a novel file.",
      public_details: { status: response.status },
    });
  }
}

/** 下载与 JSON 共用有上限的流式读取，避免异常响应占满内存。 */
async function read_limited_text(response: Response, max_bytes: number): Promise<string> {
  const content_length = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(content_length) && content_length > max_bytes) {
    await response.body?.cancel();
    throw new AppError("remote.fetch_failed", {
      message: "The novel site response exceeds the size limit.",
      public_details: { max_bytes },
    });
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parts: string[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max_bytes) {
        await reader.cancel();
        throw new AppError("remote.fetch_failed", {
          message: "The novel site response exceeds the size limit.",
          public_details: { max_bytes },
        });
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return parts.join("");
}

function assert_allowed_url(url: URL): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppError("remote.fetch_failed", {
      message: "The novel site redirected to an unsupported protocol.",
      public_details: { origin: url.origin },
    });
  }
  if (url.username !== "" || url.password !== "") {
    throw new AppError("remote.fetch_failed", {
      message: "The novel site redirected to a URL with credentials.",
      public_details: { origin: url.origin },
    });
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!(NOVELIA_HOSTS as readonly string[]).includes(host)) {
    throw new AppError("remote.fetch_failed", {
      message: "The novel site redirected to an unsupported host.",
      public_details: { host },
    });
  }
}

function invalid_shape(field: string): AppError {
  return new AppError("remote.fetch_failed", {
    message: "The novel site returned unexpected data.",
    diagnostic_context: { field },
  });
}

function require_record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid_shape(field);
  }
  return value as Record<string, unknown>;
}

function require_string(record: Record<string, unknown>, key: string, field: string): string {
  const value = record[key];
  if (typeof value !== "string") throw invalid_shape(`${field}.${key}`);
  return value;
}

function optional_string(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid_shape(`${field}.${key}`);
  return value;
}

function require_array(record: Record<string, unknown>, key: string, field: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw invalid_shape(`${field}.${key}`);
  return value;
}

function require_string_array(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalid_shape(`${field}.${key}`);
  }
  return value as string[];
}

function optional_string_array(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string[] | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalid_shape(`${field}.${key}`);
  }
  return value as string[];
}

function read_string_map(record: Record<string, unknown>, key: string): Record<string, string> {
  const value = record[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw invalid_shape(key);
  const result: Record<string, string> = {};
  for (const [entry_key, entry_value] of Object.entries(value)) {
    if (typeof entry_value !== "string") throw invalid_shape(`${key}.${entry_key}`);
    result[entry_key] = entry_value;
  }
  return result;
}

function read_integer(record: Record<string, unknown>, key: string, field: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid_shape(`${field}.${key}`);
  return Math.max(0, Math.trunc(value));
}

/** 上传限流与网关错误可重试；认证、参数与长度错误直接失败。 */
function is_retryable_upload_error(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.code !== "remote.fetch_failed") return false;
  const status = error.public_details.status;
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function read_retry_delay(error: unknown, attempt: number): number {
  if (error instanceof AppError) {
    const retry_after = error.diagnostic_context.retry_after;
    if (typeof retry_after === "string") {
      const seconds = Number(retry_after);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1_000, UPLOAD_RETRY_MAX_MS);
      }
      const date = Date.parse(retry_after);
      if (Number.isFinite(date)) {
        return Math.min(Math.max(0, date - Date.now()), UPLOAD_RETRY_MAX_MS);
      }
    }
  }
  return Math.min(UPLOAD_RETRY_BASE_MS * 2 ** attempt, UPLOAD_RETRY_MAX_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
