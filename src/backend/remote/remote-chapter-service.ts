import { AppError } from "../../shared/error/app-error";
import type { ProjectWriteResult } from "../../shared/project-event";
import {
  has_text_line_break,
  split_text_lines_for_items,
} from "../file/shared/file-format-helpers";
import { write_chapter_translation_with_retry } from "./chapter-translation-writer";
import { call_with_credential_refresh } from "./credential-refresh";
import type {
  NoveliaClient,
  RemoteChapterTask,
  RemoteWorkspace,
  RemoteWorkspaceChapter,
} from "./novelia-client";
import {
  build_chapter_filename,
  is_empty_translation_line,
  parse_novel_ref,
  REMOTE_NOVEL_MAX_BYTES,
  same_as_old_translation,
  type RemoteNovelRef,
} from "./novelia-source";
import type { NovelSourceService } from "./novel-source-service";
import { same_remote_source_identity, type RemoteSourceBinding } from "./remote-source";

const CHAPTER_LIST_DEFAULT_LIMIT = 50;
const CHAPTER_LIST_MAX_LIMIT = 100;
/** 单章读取的段落分页与字符预算；分页只裁剪模型回执，不改变章节事实。 */
export const CHAPTER_READ_LIMITS = Object.freeze({ default: 100, max: 100 });
export const CHAPTER_READ_CHAR_BUDGET = Object.freeze({ default: 12000, max: 24000 });

/** 站点目录中的一章；`index` 是站点目录顺序，从 1 开始。 */
export interface RemoteCachedChapter {
  index: number;
  chapter_id: string;
  volume_id: string | null; // 文库章节所属分卷；网页小说为 null
  title: string;
  translated: boolean; // 站点已有 GPT 译文
}

export interface RemoteCachedChapterList {
  origin: string;
  host: string;
  kind: "web" | "wenku";
  title: string;
  total: number; // 过滤后的章节总数
  offset: number;
  chapters: RemoteCachedChapter[];
}

export interface RemoteChapterImportRequest {
  chapter_id: string;
  /** 文库章节所属分卷；章节 ID 在多卷间不唯一时必须提供。 */
  volume_id?: string | null;
}

export interface RemoteChapterImportResult {
  imported: boolean;
  asset_path: string | null;
  chapter_id: string;
  volume_id: string | null;
  title: string;
  paragraph_count: number;
  char_count: number;
  translated: boolean;
  reason?: "chapter_empty";
}

export interface RemoteChapterReadRequest {
  chapter_id: string;
  /** 文库章节所属分卷；章节 ID 在多卷间不唯一时必须提供。 */
  volume_id?: string | null;
  offset?: number;
  limit?: number;
  max_chars?: number;
}

/** 站点旧译文按段落位置与原文对齐；本章没有旧译文时 `zh` 为 null。 */
export interface RemoteChapterReadParagraph {
  n: number;
  jp: string;
  zh: string | null;
}

export interface RemoteChapterReadResult {
  chapter_id: string;
  volume_id: string | null;
  title: string;
  translated: boolean;
  total_paragraphs: number;
  offset: number;
  paragraphs: RemoteChapterReadParagraph[];
  glossary_id: string;
  old_glossary_id: string | null;
  /** 旧译文所用术语表是否与当前一致；不表示译文内容本身是最新的。 */
  translation_current: boolean;
  /** 仅网页小说且站点缓存为空时为 true：可用 `novel_chapter_sync` 触发站点抓取。 */
  sync_available?: true;
  /** 下一次读取应使用的段落偏移；已读完时为 null。 */
  next_offset: number | null;
  truncated: boolean;
}

export interface RemoteChapterUploadRequest {
  chapter_id: string;
  /** 文库章节所属分卷；网页小说省略。 */
  volume_id?: string | null;
  text: string;
}

export interface RemoteChapterLineUploadRequest extends RemoteChapterUploadRequest {
  /** 1 起始的段落行号；只替换这一行，其余行沿用站点旧译。 */
  line: number;
}

export interface RemoteChapterUploadResult {
  uploaded: boolean;
  unchanged?: true;
  chapter_id: string;
  volume_id: string | null;
  title: string;
  paragraphs: number;
  line?: number;
}

/** Agent 工具在自身运行租约内导入暂存文本的窄端口。 */
export interface RemoteChapterImporter {
  import_source_file_under_agent(
    request: { source_path: string; file_name: string },
    signal?: AbortSignal,
  ): Promise<{ asset_path: string; write: ProjectWriteResult }>;
}

export interface RemoteChapterServiceOptions {
  sources: Pick<NovelSourceService, "read_bound_source" | "stage_text">;
  client: NoveliaClient;
  importer: RemoteChapterImporter;
  /** 站点拒绝凭据时触发登录链路的 token 续期；CLI 缺席。 */
  refresh_credentials?: ((origin: string) => Promise<boolean>) | undefined;
}

/**
 * 读取绑定作品在站点的章节缓存，导入指定章节，或按章提交 GPT 译文。
 * 纯读取默认只取缓存；网页小说的显式同步与上传首次读取会触发站点向上游抓取，文库始终只取缓存。
 */
export class RemoteChapterService {
  private readonly sources: RemoteChapterServiceOptions["sources"];
  private readonly client: NoveliaClient;
  private readonly importer: RemoteChapterImporter;
  private readonly refresh_credentials: ((origin: string) => Promise<boolean>) | null;

  public constructor(options: RemoteChapterServiceOptions) {
    this.sources = options.sources;
    this.client = options.client;
    this.importer = options.importer;
    this.refresh_credentials = options.refresh_credentials ?? null;
  }

  /** 列出站点目录；`query` 按标题或章节 ID 做不区分大小写的包含匹配。 */
  public async list_chapters(
    request: { query?: string | null; offset?: number; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<RemoteCachedChapterList> {
    const binding = await this.require_binding();
    const ref = parse_novel_ref(binding.url);
    const workspace = await call_with_credential_refresh(this.refresh_credentials, ref.origin, () =>
      this.client.read_workspace(ref, signal),
    );
    const query = request.query?.trim().toLowerCase() ?? "";
    const offset = Math.max(request.offset ?? 0, 0);
    const limit = Math.min(
      Math.max(request.limit ?? CHAPTER_LIST_DEFAULT_LIMIT, 1),
      CHAPTER_LIST_MAX_LIMIT,
    );
    const matched = workspace.chapters
      .map((chapter, position) => ({ chapter, index: position + 1 }))
      .filter(
        ({ chapter }) =>
          query === "" ||
          chapter.title.toLowerCase().includes(query) ||
          chapter.chapter_id.toLowerCase().includes(query),
      );
    return {
      origin: ref.origin,
      host: ref.host,
      kind: ref.kind,
      title: workspace.title_zh ?? workspace.title_jp,
      total: matched.length,
      offset,
      chapters: matched.slice(offset, offset + limit).map(({ chapter, index }) => ({
        index,
        chapter_id: chapter.chapter_id,
        volume_id: chapter.volume_id,
        title: chapter.title,
        translated: chapter.translated,
      })),
    };
  }

  /** 读取站点缓存的章节日文原文，并作为新的 TXT 资产加入工作台。 */
  public async import_chapter(
    request: RemoteChapterImportRequest,
    signal?: AbortSignal,
  ): Promise<RemoteChapterImportResult> {
    signal?.throwIfAborted();
    const chapter_id = request.chapter_id.trim();
    if (chapter_id === "") {
      throw new AppError("request.validation_failed", {
        public_details: { field: "chapter_id" },
      });
    }
    const { chapter, task, file_base_title } = await this.read_bound_chapter_task(
      chapter_id,
      request.volume_id ?? null,
      undefined,
      signal,
    );
    const base = {
      chapter_id: chapter.chapter_id,
      volume_id: chapter.volume_id,
      title: chapter.title,
      translated: chapter.translated,
    };
    if (task.paragraph_jp.length === 0) {
      return {
        imported: false,
        asset_path: null,
        paragraph_count: 0,
        char_count: 0,
        reason: "chapter_empty",
        ...base,
      };
    }
    const text = `${task.paragraph_jp.join("\n")}\n`;
    // 单章异常膨胀时按整本体量预算拒绝，避免无界响应进入工程。
    if (Buffer.byteLength(text, "utf8") > REMOTE_NOVEL_MAX_BYTES) {
      throw new AppError("remote.fetch_failed", {
        diagnostic_context: { reason: "chapter_too_large", chapter_id },
      });
    }
    const file_name = build_chapter_filename(file_base_title, chapter.title);
    const staged = await this.sources.stage_text(file_name, text);
    try {
      const imported = await this.importer.import_source_file_under_agent(
        { source_path: staged.source_path, file_name },
        signal,
      );
      return {
        imported: true,
        asset_path: imported.asset_path,
        paragraph_count: task.paragraph_jp.length,
        char_count: text.length,
        ...base,
      };
    } finally {
      await staged.dispose();
    }
  }

  /**
   * 纯读取指定章节的站点缓存原文与旧译文，不导入文件、不写工程、不需要租约。
   * 网页小说缓存为空时返回 `sync_available` 提示，同步抓取属于显式的独立工具。
   */
  public async read_chapter(
    request: RemoteChapterReadRequest,
    signal?: AbortSignal,
  ): Promise<RemoteChapterReadResult> {
    signal?.throwIfAborted();
    const chapter_id = request.chapter_id.trim();
    if (chapter_id === "") {
      throw new AppError("request.validation_failed", {
        public_details: { field: "chapter_id" },
      });
    }
    const { ref, chapter, task } = await this.read_bound_chapter_task(
      chapter_id,
      request.volume_id ?? null,
      undefined,
      signal,
    );
    const page = paginate_chapter_paragraphs(task.paragraph_jp, task.old_paragraph_zh, {
      offset: request.offset ?? undefined,
      limit: request.limit ?? undefined,
      max_chars: request.max_chars ?? undefined,
    });
    return {
      chapter_id: chapter.chapter_id,
      volume_id: chapter.volume_id,
      title: chapter.title,
      translated: chapter.translated,
      total_paragraphs: task.paragraph_jp.length,
      ...page,
      glossary_id: task.glossary_id,
      old_glossary_id: task.old_glossary_id,
      // 站点以术语表身份标记译文代次；没有旧译文时不存在“当前”状态。
      translation_current:
        task.old_glossary_id !== null && task.old_glossary_id === task.glossary_id,
      // 只有网页小说的空缓存可能靠站点同步补救；文库空章节是永久事实。
      ...(task.paragraph_jp.length === 0 && ref.kind === "web" ? { sync_available: true } : {}),
    };
  }

  /**
   * 触发站点向上游抓取指定章节的原文并返回缓存结果；只对网页小说有意义。
   * 抓取由站点执行且消耗站点资源，只能被显式的 `novel_chapter_sync` 调用。
   */
  public async sync_chapter(
    request: RemoteChapterReadRequest,
    signal?: AbortSignal,
  ): Promise<RemoteChapterReadResult> {
    signal?.throwIfAborted();
    const chapter_id = request.chapter_id.trim();
    if (chapter_id === "") {
      throw new AppError("request.validation_failed", {
        public_details: { field: "chapter_id" },
      });
    }
    const { ref, chapter, task } = await this.read_bound_chapter_task(
      chapter_id,
      request.volume_id ?? null,
      { sync: true },
      signal,
    );
    if (ref.kind !== "web") {
      throw new AppError("remote.sync_unsupported", {
        public_details: { kind: ref.kind },
      });
    }
    const page = paginate_chapter_paragraphs(task.paragraph_jp, task.old_paragraph_zh, {
      offset: request.offset ?? undefined,
      limit: request.limit ?? undefined,
      max_chars: request.max_chars ?? undefined,
    });
    return {
      chapter_id: chapter.chapter_id,
      volume_id: chapter.volume_id,
      title: chapter.title,
      translated: chapter.translated,
      total_paragraphs: task.paragraph_jp.length,
      ...page,
      glossary_id: task.glossary_id,
      old_glossary_id: task.old_glossary_id,
      // 同步抓取不改变站点译文；术语表语义与纯读取一致。
      translation_current:
        task.old_glossary_id !== null && task.old_glossary_id === task.glossary_id,
    };
  }

  /**
   * 用工作台或 Agent 提供的整章文本覆盖站点译文。
   * 提交前校验行数、空译文，并在写入前复查绑定与章节原文，避免等待期间的目标漂移。
   */
  public async upload_chapter(
    request: RemoteChapterUploadRequest,
    signal?: AbortSignal,
  ): Promise<RemoteChapterUploadResult> {
    signal?.throwIfAborted();
    const chapter_id = request.chapter_id.trim();
    if (chapter_id === "") {
      throw new AppError("request.validation_failed", {
        public_details: { field: "chapter_id" },
      });
    }
    const volume_id = normalize_volume_id(request.volume_id);
    const { binding, ref, chapter, task } = await this.read_bound_chapter_task(
      chapter_id,
      volume_id,
      { sync: "auto" },
      signal,
    );
    const base = {
      chapter_id: chapter.chapter_id,
      volume_id: chapter.volume_id,
      title: chapter.title,
    };
    if (task.paragraph_jp.length === 0) {
      throw new AppError("remote.chapter_empty", { public_details: base });
    }
    signal?.throwIfAborted();
    const paragraphs_zh = split_text_lines_for_items(request.text);
    if (paragraphs_zh.length !== task.paragraph_jp.length) {
      throw new AppError("remote.chapter_paragraph_mismatch", {
        public_details: {
          ...base,
          expected: task.paragraph_jp.length,
          actual: paragraphs_zh.length,
        },
      });
    }
    assert_non_empty_translations(task.paragraph_jp, paragraphs_zh, base);
    if (
      task.old_paragraph_zh !== null &&
      same_as_old_translation(paragraphs_zh, task.old_paragraph_zh)
    ) {
      return {
        uploaded: false,
        unchanged: true,
        paragraphs: task.paragraph_jp.length,
        ...base,
      };
    }
    await this.assert_binding_unchanged(binding, base);
    const latest_task = await this.read_task_for_write(ref, chapter, signal);
    signal?.throwIfAborted();
    assert_same_chapter_source(task.paragraph_jp, latest_task.paragraph_jp, base);
    await write_chapter_translation_with_retry({
      client: this.client,
      refresh_credentials: this.refresh_credentials,
      ref,
      chapter,
      glossary_id: latest_task.glossary_id,
      paragraphs_zh,
      signal,
    });
    return {
      uploaded: true,
      paragraphs: task.paragraph_jp.length,
      ...base,
    };
  }

  /**
   * 整章行数无法与原文对齐时，用站点旧译文补齐其他行后提交整章数组。
   * 目标行之外的旧译缺失、空译文或章节身份变化都拒绝提交。
   */
  public async upload_line(
    request: RemoteChapterLineUploadRequest,
    signal?: AbortSignal,
  ): Promise<RemoteChapterUploadResult> {
    signal?.throwIfAborted();
    const chapter_id = request.chapter_id.trim();
    if (chapter_id === "") {
      throw new AppError("request.validation_failed", {
        public_details: { field: "chapter_id" },
      });
    }
    if (!Number.isSafeInteger(request.line) || request.line < 1) {
      throw new AppError("request.validation_failed", {
        public_details: { field: "line" },
      });
    }
    if (has_text_line_break(request.text)) {
      throw new AppError("request.validation_failed", {
        public_details: { field: "text", reason: "line_break" },
      });
    }
    const volume_id = normalize_volume_id(request.volume_id);
    const { binding, ref, chapter, task } = await this.read_bound_chapter_task(
      chapter_id,
      volume_id,
      { sync: "auto" },
      signal,
    );
    const base = {
      chapter_id: chapter.chapter_id,
      volume_id: chapter.volume_id,
      title: chapter.title,
      line: request.line,
    };
    if (task.paragraph_jp.length === 0) {
      throw new AppError("remote.chapter_empty", { public_details: base });
    }
    signal?.throwIfAborted();
    if (request.line > task.paragraph_jp.length) {
      throw new AppError("request.validation_failed", {
        public_details: {
          field: "line",
          expected: task.paragraph_jp.length,
          actual: request.line,
        },
      });
    }
    const line_index = request.line - 1;
    assert_line_context(task.paragraph_jp, task.old_paragraph_zh, line_index, base);
    assert_target_translation(task.paragraph_jp[line_index]!, request.text, base);
    if (translation_line_matches(task.old_paragraph_zh![line_index] ?? "", request.text)) {
      return {
        uploaded: false,
        unchanged: true,
        paragraphs: task.paragraph_jp.length,
        ...base,
      };
    }
    await this.assert_binding_unchanged(binding, base);
    const latest_task = await this.read_task_for_write(ref, chapter, signal);
    signal?.throwIfAborted();
    assert_same_chapter_source(task.paragraph_jp, latest_task.paragraph_jp, base);
    assert_line_context(latest_task.paragraph_jp, latest_task.old_paragraph_zh, line_index, base);
    assert_target_translation(latest_task.paragraph_jp[line_index]!, request.text, base);
    if (translation_line_matches(latest_task.old_paragraph_zh![line_index] ?? "", request.text)) {
      return {
        uploaded: false,
        unchanged: true,
        paragraphs: latest_task.paragraph_jp.length,
        ...base,
      };
    }
    const paragraphs_zh = latest_task.old_paragraph_zh!.map((line, index) =>
      index === line_index ? request.text : line,
    );
    await write_chapter_translation_with_retry({
      client: this.client,
      refresh_credentials: this.refresh_credentials,
      ref,
      chapter,
      glossary_id: latest_task.glossary_id,
      paragraphs_zh,
      signal,
    });
    return {
      uploaded: true,
      paragraphs: latest_task.paragraph_jp.length,
      ...base,
    };
  }

  /** 写入前直接刷新章节任务；网站原文变化时不允许沿用等待期间生成的译文。 */
  private async read_task_for_write(
    ref: RemoteNovelRef,
    chapter: RemoteWorkspaceChapter,
    signal?: AbortSignal,
  ): Promise<RemoteChapterTask> {
    return await call_with_credential_refresh(this.refresh_credentials, ref.origin, () =>
      this.client.read_chapter_task(ref, chapter, { sync: false }, signal),
    );
  }

  /** 上传等待期间换源或改绑时拒绝写入，避免把译文提交到旧作品。 */
  private async assert_binding_unchanged(
    binding: RemoteSourceBinding,
    details: { chapter_id: string; volume_id: string | null; title: string },
  ): Promise<void> {
    const latest = await this.require_binding();
    if (same_remote_source_identity(binding, latest)) return;
    throw new AppError("remote.binding_changed", {
      public_details: {
        ...details,
        previous_url: binding.url,
        current_url: latest.url,
      },
    });
  }

  /** 目录解析与任务读取是导入和纯读取的公共前置；凭据拒绝时先续期再重试一次。 */
  private async read_bound_chapter_task(
    chapter_id: string,
    volume_id: string | null,
    options: { sync: boolean | "auto" } = { sync: false },
    signal?: AbortSignal,
  ): Promise<{
    binding: RemoteSourceBinding;
    ref: RemoteNovelRef;
    chapter: RemoteWorkspaceChapter;
    task: RemoteChapterTask;
    file_base_title: string;
  }> {
    const binding = await this.require_binding();
    const ref = parse_novel_ref(binding.url);
    const workspace = await call_with_credential_refresh(this.refresh_credentials, ref.origin, () =>
      this.client.read_workspace(ref, signal),
    );
    const chapter = this.resolve_chapter(workspace, chapter_id, volume_id);
    const sync = options.sync === "auto" ? ref.kind === "web" : options.sync;
    const task = await call_with_credential_refresh(this.refresh_credentials, ref.origin, () =>
      this.client.read_chapter_task(ref, chapter, { sync }, signal),
    );
    return { binding, ref, chapter, task, file_base_title: binding.title };
  }

  /** 章节身份只能来自站点目录；文库同名章节 ID 需要显式分卷消歧。 */
  private resolve_chapter(
    workspace: RemoteWorkspace,
    chapter_id: string,
    volume_id: string | null,
  ): RemoteWorkspaceChapter {
    const candidates = workspace.chapters.filter((chapter) => chapter.chapter_id === chapter_id);
    if (volume_id !== null) {
      const chapter = candidates.find((entry) => entry.volume_id === volume_id);
      if (chapter === undefined) throw build_chapter_not_found(chapter_id, volume_id);
      return chapter;
    }
    if (candidates.length === 0) throw build_chapter_not_found(chapter_id, null);
    if (candidates.length > 1) {
      throw new AppError("request.validation_failed", {
        public_details: { field: "volume_id" },
        diagnostic_context: { reason: "ambiguous_wenku_chapter", chapter_id },
      });
    }
    return candidates[0]!;
  }

  private async require_binding(): Promise<RemoteSourceBinding> {
    const snapshot = await this.sources.read_bound_source();
    if (snapshot.binding === null) throw new AppError("remote.source_not_bound");
    return snapshot.binding;
  }
}

interface ChapterUploadDetails {
  chapter_id: string;
  volume_id: string | null;
  title: string;
  line?: number;
}

function normalize_volume_id(volume_id: string | null | undefined): string | null {
  const normalized = volume_id?.trim() ?? "";
  return normalized === "" ? null : normalized;
}

function build_chapter_not_found(chapter_id: string, volume_id: string | null): AppError {
  return new AppError("remote.chapter_not_found", {
    public_details: { chapter_id, ...(volume_id === null ? {} : { volume_id }) },
  });
}

/** 原文非空时译文不能为空、纯空白或站点缺失标记。 */
function assert_non_empty_translations(
  paragraph_jp: readonly string[],
  paragraphs_zh: readonly string[],
  details: ChapterUploadDetails,
): void {
  const index = paragraph_jp.findIndex(
    (source, line_index) =>
      source.trim() !== "" && is_empty_translation_line(paragraphs_zh[line_index] ?? ""),
  );
  if (index >= 0) {
    throw new AppError("remote.chapter_paragraph_empty", {
      public_details: { ...details, line: index + 1 },
    });
  }
}

function assert_target_translation(
  paragraph_jp: string,
  text: string,
  details: ChapterUploadDetails,
): void {
  if (paragraph_jp.trim() !== "" && is_empty_translation_line(text)) {
    throw new AppError("remote.chapter_paragraph_empty", { public_details: { ...details } });
  }
}

/** 按行补传只信任站点旧译补齐其他行；旧译缺失或长度不一致直接拒绝。 */
function assert_line_context(
  paragraph_jp: readonly string[],
  old_paragraph_zh: readonly string[] | null,
  target_index: number,
  details: ChapterUploadDetails,
): void {
  const missing_lines = paragraph_jp.flatMap((source, index) =>
    index !== target_index &&
    source.trim() !== "" &&
    (old_paragraph_zh === null || is_empty_translation_line(old_paragraph_zh[index] ?? ""))
      ? [index + 1]
      : [],
  );
  if (old_paragraph_zh === null || old_paragraph_zh.length !== paragraph_jp.length) {
    throw new AppError("remote.chapter_line_context_missing", {
      public_details: {
        ...details,
        ...(old_paragraph_zh === null
          ? { reason: "old_translation_missing" }
          : {
              reason: "old_translation_length_mismatch",
              expected: paragraph_jp.length,
              actual: old_paragraph_zh.length,
            }),
        missing_lines,
      },
    });
  }
  const missing = paragraph_jp.flatMap((source, index) =>
    index !== target_index &&
    source.trim() !== "" &&
    is_empty_translation_line(old_paragraph_zh[index] ?? "")
      ? [index + 1]
      : [],
  );
  if (missing.length > 0) {
    throw new AppError("remote.chapter_line_context_missing", {
      public_details: { ...details, missing_lines: missing },
    });
  }
}

/** 目标行与旧译一致时无需写站点；空行与缺失标记也按值相等处理。 */
function translation_line_matches(old_line: string, text: string): boolean {
  return (
    old_line === text || (!is_empty_translation_line(old_line) && old_line.trim() === text.trim())
  );
}

/** 写入前复查原文；段数或正文变化都视为章节已变。 */
function assert_same_chapter_source(
  previous: readonly string[],
  latest: readonly string[],
  details: ChapterUploadDetails,
): void {
  if (same_ordered_strings(previous, latest)) return;
  const changed_line = previous.findIndex((line, index) => line !== latest[index]);
  throw new AppError("remote.chapter_changed", {
    public_details: {
      ...details,
      expected: previous.length,
      actual: latest.length,
      ...(changed_line < 0 ? {} : { changed_line: changed_line + 1 }),
    },
  });
}

function same_ordered_strings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * 按段落分页并施加字符预算；保留原始段号与空段，不截断单段正文。
 * 首段自身超预算时仍返回，避免超长段落永远无法读取。
 */
function paginate_chapter_paragraphs(
  paragraph_jp: readonly string[],
  paragraph_zh: readonly string[] | null,
  request: {
    offset?: number | undefined;
    limit?: number | undefined;
    max_chars?: number | undefined;
  },
): {
  offset: number;
  paragraphs: RemoteChapterReadParagraph[];
  next_offset: number | null;
  truncated: boolean;
} {
  const total = paragraph_jp.length;
  const offset = Math.min(Math.max(request.offset ?? 0, 0), total);
  const limit = Math.min(
    Math.max(request.limit ?? CHAPTER_READ_LIMITS.default, 1),
    CHAPTER_READ_LIMITS.max,
  );
  const max_chars = Math.min(
    Math.max(request.max_chars ?? CHAPTER_READ_CHAR_BUDGET.default, 1),
    CHAPTER_READ_CHAR_BUDGET.max,
  );
  const paragraphs: RemoteChapterReadParagraph[] = [];
  let used_chars = 0;
  let cursor = offset;
  while (cursor < total && paragraphs.length < limit) {
    const jp = paragraph_jp[cursor]!;
    const zh = paragraph_zh === null ? null : (paragraph_zh[cursor] ?? "");
    const cost = jp.length + (zh?.length ?? 0);
    if (paragraphs.length > 0 && used_chars + cost > max_chars) break;
    paragraphs.push({ n: cursor + 1, jp, zh });
    used_chars += cost;
    cursor += 1;
  }
  const next_offset = cursor < total ? cursor : null;
  return { offset, paragraphs, next_offset, truncated: next_offset !== null };
}
