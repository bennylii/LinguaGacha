import { AppError } from "../../shared/error/app-error";
import type { ProjectWriteResult } from "../../shared/project-event";
import { call_with_credential_refresh } from "./credential-refresh";
import type { NoveliaClient, RemoteWorkspace, RemoteWorkspaceChapter } from "./novelia-client";
import { build_chapter_filename, parse_novel_ref, REMOTE_NOVEL_MAX_BYTES } from "./novelia-source";
import type { NovelSourceService } from "./novel-source-service";
import type { RemoteSourceBinding } from "./remote-source";

const CHAPTER_LIST_DEFAULT_LIMIT = 50;
const CHAPTER_LIST_MAX_LIMIT = 100;

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
    const binding = await this.require_binding();
    const ref = parse_novel_ref(binding.url);
    const workspace = await call_with_credential_refresh(this.refresh_credentials, ref.origin, () =>
      this.client.read_workspace(ref, signal),
    );
    const chapter = this.resolve_chapter(workspace, chapter_id, request.volume_id ?? null);
    const task = await call_with_credential_refresh(this.refresh_credentials, ref.origin, () =>
      this.client.read_chapter_task(ref, chapter, { sync: false }, signal),
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
    const file_name = build_chapter_filename(binding.title, chapter.title);
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
