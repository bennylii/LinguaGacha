import { AppError } from "../../shared/error/app-error";
import type { ProjectWriteResult } from "../../shared/project-event";
import { call_with_credential_refresh } from "./credential-refresh";
import type {
  NoveliaClient,
  RemoteChapterTask,
  RemoteWorkspace,
  RemoteWorkspaceChapter,
} from "./novelia-client";
import {
  build_chapter_filename,
  parse_novel_ref,
  REMOTE_NOVEL_MAX_BYTES,
  type RemoteNovelRef,
} from "./novelia-source";
import type { NovelSourceService } from "./novel-source-service";
import type { RemoteSourceBinding } from "./remote-source";

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
 * 读取当前绑定作品在站点的章节缓存，并把指定章节的日文原文导入工作台。
 * 只读站点已缓存内容（`sync=false`），不触发站点向上游同步，也不改写工程绑定。
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

  /** 目录解析与任务读取是导入和纯读取的公共前置；凭据拒绝时先续期再重试一次。 */
  private async read_bound_chapter_task(
    chapter_id: string,
    volume_id: string | null,
    options: { sync: boolean } = { sync: false },
    signal?: AbortSignal,
  ): Promise<{
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
    const task = await call_with_credential_refresh(this.refresh_credentials, ref.origin, () =>
      this.client.read_chapter_task(ref, chapter, options, signal),
    );
    return { ref, chapter, task, file_base_title: binding.title };
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

function build_chapter_not_found(chapter_id: string, volume_id: string | null): AppError {
  return new AppError("remote.chapter_not_found", {
    public_details: { chapter_id, ...(volume_id === null ? {} : { volume_id }) },
  });
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
