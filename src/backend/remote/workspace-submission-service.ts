import JSZip from "jszip";

import { AppError } from "../../shared/error/app-error";
import type { ProjectDatabase } from "../database/database-operations";
import { EpubAst, read_epub_extra } from "../file/epub/epub-ast";
import type { RuntimeOperationGate, RuntimeLease } from "../runtime-operation-gate";
import type { ProjectSessionState } from "../project/project-session-state";
import type { NoveliaClient, RemoteWorkspaceChapter } from "./novelia-client";
import { call_with_credential_refresh } from "./credential-refresh";
import { write_chapter_translation_with_retry } from "./chapter-translation-writer";
import { read_epub_remote_source } from "./epub-remote-source";
import {
  normalize_match_line,
  parse_novel_url,
  same_as_old_translation,
  split_remote_document,
  type RemoteChapter,
} from "./novelia-source";
import {
  build_epub_document_key,
  read_remote_epub_map,
  read_remote_source_binding,
  REMOTE_EPUB_MAP_META_KEY,
  REMOTE_SOURCE_META_KEY,
  type RemoteEpubMap,
  type RemoteSourceBinding,
} from "./remote-source";
import { list_document_paragraph_rows } from "./wenku-epub-source";

const MAX_CHAPTER_FAILURES = 5;
const SEARCH_WINDOW = 50;
const EPUB_AST = new EpubAst();

export type RemoteWorkspaceStatus = "idle" | "running" | "completed" | "failed" | "cancelled";
export type RemoteWorkspaceChapterState =
  | "pending"
  | "reading"
  | "uploading"
  | "uploaded"
  | "skipped"
  | "failed";

export interface RemoteWorkspaceChapterProgress {
  chapter_id: string;
  title: string;
  state: RemoteWorkspaceChapterState;
  ready: number; // 工程中已完成且非空的本地译文行数
  missing: number; // 工程中尚未完成或为空的译文行数
  message: string | null;
}

export interface RemoteWorkspaceSnapshot {
  status: RemoteWorkspaceStatus;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  totals: {
    chapters: number;
    uploaded: number;
    skipped: number;
    failed: number;
  };
  chapters: RemoteWorkspaceChapterProgress[];
}

export interface RemoteWorkspaceSubmissionServiceOptions {
  database: ProjectDatabase;
  session_state: ProjectSessionState;
  runtime_gate: RuntimeOperationGate;
  client: NoveliaClient;
  /** 收到认证拒绝时触发登录链路的 token 续期；CLI 缺席。 */
  refresh_credentials?: ((origin: string) => Promise<boolean>) | undefined;
}

interface AssetItem {
  row: number;
  src: string;
  dst: string;
  status: string;
}

interface RunningSubmission {
  lease: RuntimeLease;
  controller: AbortController;
  completion: Promise<void>;
}

/**
 * 把工程本地译文提交到站点的 GPT 工作区。
 * 单章只用工程中已完成的本地译文；任一行缺失就跳过该章，不调用模型补译。
 */
export class RemoteWorkspaceSubmissionService {
  private readonly database: ProjectDatabase;
  private readonly session_state: ProjectSessionState;
  private readonly runtime_gate: RuntimeOperationGate;
  private readonly client: NoveliaClient;
  private readonly refresh_credentials: ((origin: string) => Promise<boolean>) | null;
  private readonly listeners = new Set<(snapshot: RemoteWorkspaceSnapshot) => void>();
  private snapshot: RemoteWorkspaceSnapshot = create_idle_snapshot();
  private running: RunningSubmission | null = null;

  public constructor(options: RemoteWorkspaceSubmissionServiceOptions) {
    this.database = options.database;
    this.session_state = options.session_state;
    this.runtime_gate = options.runtime_gate;
    this.client = options.client;
    this.refresh_credentials = options.refresh_credentials ?? null;
  }

  public get_snapshot(): RemoteWorkspaceSnapshot {
    return clone_snapshot(this.snapshot);
  }

  public subscribe(listener: (snapshot: RemoteWorkspaceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 启动前先确认绑定；实际工作区读取与上传在后台执行。 */
  public async start(): Promise<RemoteWorkspaceSnapshot> {
    if (this.running !== null) throw new AppError("runtime.busy");
    const project_path = this.session_state.require_loaded_project_path();
    const meta = await this.database.get_all_meta(project_path);
    const binding = read_remote_source_binding(meta[REMOTE_SOURCE_META_KEY]);
    if (binding === null) throw new AppError("remote.source_not_bound");
    const assets = await this.database.get_all_asset_records(project_path);
    const asset = assets.find((candidate) => candidate.path === binding.asset_path);
    if (asset === undefined) {
      throw new AppError("remote.source_not_bound", {
        public_details: { reason: "asset_missing", asset_path: binding.asset_path },
      });
    }
    // 文库整本 EPUB 依赖导入时落库的章节映射；缺失说明工程来自旧流程，需重新导入。
    if (
      asset.file_type === "EPUB" &&
      read_remote_epub_map(meta[REMOTE_EPUB_MAP_META_KEY]) === null
    ) {
      throw new AppError("remote.epub_map_missing", {
        public_details: { asset_path: binding.asset_path },
      });
    }
    if (this.running !== null) throw new AppError("runtime.busy");
    const lease = this.runtime_gate.begin_runtime("remote_workspace");
    const controller = new AbortController();
    this.snapshot = {
      ...create_idle_snapshot(),
      status: "running",
      started_at: new Date().toISOString(),
    };
    this.publish();
    const completion = this.execute(project_path, binding, controller.signal)
      .catch((error: unknown) => {
        this.snapshot = {
          ...this.snapshot,
          status: signal_status(controller.signal, error),
          finished_at: new Date().toISOString(),
          error: signal_error(controller.signal, error),
        };
      })
      .finally(() => {
        this.running = null;
        this.runtime_gate.finish_runtime(lease);
        this.publish();
      });
    this.running = { lease, controller, completion };
    return this.get_snapshot();
  }

  public async cancel(): Promise<RemoteWorkspaceSnapshot> {
    const running = this.running;
    if (running === null) return this.get_snapshot();
    running.controller.abort(new AppError("runtime.disposed"));
    await running.completion;
    return this.get_snapshot();
  }

  /** 关闭时取消并等待收尾，上传已完成的章节保留在站点。 */
  public async dispose(): Promise<void> {
    await this.cancel();
  }

  /**
   * 文库整本 EPUB 的章节段落按「文档内非空 body `<p>` 顺序」取条目；
   * 站点章节与本地文档只按 `(分卷, 章节 id)` 配对，不做文本猜测。
   */
  private async read_epub_chapter_paragraphs(args: {
    project_path: string;
    asset_path: string;
    map: RemoteEpubMap;
    chapters: readonly RemoteWorkspaceChapter[];
  }): Promise<Map<string, AssetItem[]>> {
    const documents_by_key = new Map(
      args.map.documents.map(
        (document) =>
          [build_epub_document_key(document.volume_id, document.chapter_id), document] as const,
      ),
    );
    const doc_paths = new Set<string>();
    for (const chapter of args.chapters) {
      if (chapter.volume_id === null) continue;
      const document = documents_by_key.get(
        build_epub_document_key(chapter.volume_id, chapter.chapter_id),
      );
      if (document !== undefined) doc_paths.add(document.doc_path);
    }
    if (doc_paths.size === 0) return new Map();

    const bytes = await this.database.read_asset_content(args.project_path, args.asset_path);
    if (bytes === null) {
      throw new AppError("remote.source_not_bound", {
        public_details: { reason: "asset_missing", asset_path: args.asset_path },
      });
    }
    const source = await read_epub_remote_source(bytes, args.asset_path);
    const items_by_doc = new Map<string, (typeof source.lines)[number]["item"][]>();
    for (const line of source.lines) {
      const epub = read_epub_extra(line.item);
      const doc_path = String(epub?.["doc_path"] ?? "");
      if (!doc_paths.has(doc_path)) continue;
      const items = items_by_doc.get(doc_path) ?? [];
      items.push(line.item);
      items_by_doc.set(doc_path, items);
    }
    const items_by_row = new Map(
      (await this.read_asset_items(args.project_path, args.asset_path)).map(
        (item) => [item.row, item] as const,
      ),
    );
    const zip = await JSZip.loadAsync(bytes);
    const result = new Map<string, AssetItem[]>();
    for (const doc_path of doc_paths) {
      const raw = await zip.file(doc_path)?.async("uint8array");
      if (raw === undefined) continue;
      const rows = list_document_paragraph_rows(
        items_by_doc.get(doc_path) ?? [],
        EPUB_AST.parse_xhtml_or_html(raw),
      );
      result.set(
        doc_path,
        rows.map((row) => {
          const item = items_by_row.get(row.row);
          if (item === undefined) {
            throw new AppError("remote.source_not_bound", {
              public_details: { reason: "asset_changed", asset_path: args.asset_path },
            });
          }
          return item;
        }),
      );
    }
    return result;
  }

  private async execute(
    project_path: string,
    binding: RemoteSourceBinding,
    signal: AbortSignal,
  ): Promise<void> {
    const ref = parse_novel_url(binding.url);
    const workspace = await this.client.read_workspace(ref, signal);
    const meta = await this.database.get_all_meta(project_path);
    const assets = await this.database.get_all_asset_records(project_path);
    const asset = assets.find((candidate) => candidate.path === binding.asset_path);
    const epub_map =
      asset?.file_type === "EPUB" ? read_remote_epub_map(meta[REMOTE_EPUB_MAP_META_KEY]) : null;
    if (asset?.file_type === "EPUB" && epub_map === null) {
      throw new AppError("remote.epub_map_missing", {
        public_details: { asset_path: binding.asset_path },
      });
    }
    const asset_items = await this.read_asset_items(project_path, binding.asset_path);
    const epub_paragraphs =
      epub_map === null
        ? null
        : await this.read_epub_chapter_paragraphs({
            project_path,
            asset_path: binding.asset_path,
            map: epub_map,
            chapters: workspace.chapters,
          });
    const epub_doc_paths =
      epub_map === null
        ? null
        : new Map(
            epub_map.documents.map(
              (document) =>
                [
                  build_epub_document_key(document.volume_id, document.chapter_id),
                  document.doc_path,
                ] as const,
            ),
          );
    const asset_chapters =
      epub_map === null
        ? split_remote_document(await this.read_asset_text(project_path, binding.asset_path))
            .chapters
        : [];
    const chapter_partners = pair_workspace_chapters(workspace.chapters, asset_chapters);
    this.snapshot = {
      ...this.snapshot,
      totals: { ...this.snapshot.totals, chapters: workspace.chapters.length },
      chapters: workspace.chapters.map((chapter) => ({
        chapter_id: chapter.chapter_id,
        title: chapter.title,
        state: "pending",
        ready: 0,
        missing: 0,
        message: null,
      })),
    };
    this.publish();
    let consecutive_failures = 0;
    for (const [index, chapter] of workspace.chapters.entries()) {
      signal.throwIfAborted();
      this.update_chapter(index, { state: "reading" });
      try {
        const partner = chapter_partners.get(index) ?? null;
        const outcome = await this.process_chapter({
          ref,
          chapter,
          resolve_items:
            epub_map === null || epub_doc_paths === null
              ? (paragraphs) => map_paragraph_items(paragraphs, partner, asset_items)
              : (paragraphs) =>
                  resolve_epub_paragraph_items(
                    epub_doc_paths,
                    epub_paragraphs ?? new Map(),
                    chapter,
                    paragraphs,
                  ),
          signal,
          on_uploading: (progress) => {
            this.update_chapter(index, { state: "uploading", ...progress });
          },
        });
        this.update_totals(outcome.uploaded);
        this.update_chapter(index, {
          state: outcome.uploaded ? "uploaded" : "skipped",
          ready: outcome.ready,
          missing: outcome.missing,
          message: outcome.message,
        });
        consecutive_failures = 0;
      } catch (error) {
        if (signal.aborted) throw error;
        consecutive_failures += 1;
        this.snapshot = {
          ...this.snapshot,
          totals: { ...this.snapshot.totals, failed: this.snapshot.totals.failed + 1 },
        };
        this.update_chapter(index, {
          state: "failed",
          message: error instanceof AppError ? error.code : "remote.fetch_failed",
        });
        if (consecutive_failures >= MAX_CHAPTER_FAILURES) throw error;
      }
    }
    if (this.snapshot.status === "running") {
      this.snapshot = {
        ...this.snapshot,
        status: "completed",
        finished_at: new Date().toISOString(),
      };
    }
  }

  private async process_chapter(args: {
    ref: ReturnType<typeof parse_novel_url>;
    chapter: RemoteWorkspaceChapter;
    /** 段落 → 工程条目；`null` 表示本地文档与站点章节无法一一对应。 */
    resolve_items: (paragraphs: readonly string[]) => Array<AssetItem | null> | null;
    signal: AbortSignal;
    on_uploading: (progress: { ready: number; missing: number }) => void;
  }): Promise<{
    uploaded: boolean;
    ready: number;
    missing: number;
    message: string | null;
  }> {
    const task = await call_with_credential_refresh(this.refresh_credentials, args.ref.origin, () =>
      this.client.read_chapter_task(
        args.ref,
        args.chapter,
        { sync: this.should_sync_chapter(args.ref) },
        args.signal,
      ),
    );
    const paragraphs = task.paragraph_jp;
    if (paragraphs.length === 0) {
      return {
        uploaded: false,
        ready: 0,
        missing: 0,
        message: null,
      };
    }
    // 站点的上传契约要求段落数与工程行数一致；对不上时跳过该章，绝不猜测对应关系。
    const mapped = args.resolve_items(paragraphs);
    if (mapped === null) {
      return {
        uploaded: false,
        ready: 0,
        missing: paragraphs.length,
        message: "local_chapter_mismatch",
      };
    }
    const paragraphs_zh: string[] = [];
    let missing = 0;
    for (const item of mapped) {
      if (item !== null && item.status === "PROCESSED" && item.dst.trim() !== "") {
        paragraphs_zh.push(item.dst);
      } else {
        paragraphs_zh.push("");
        missing += 1;
      }
    }
    // 站点已有旧译时，逐段与旧译比较：全部一致说明上传只是把站点内容原样写回，
    // 对读者没有变化（epub 官方旧译的说明页、目录页就是这种情况），按跳过处理。
    if (
      task.old_paragraph_zh !== null &&
      missing === 0 &&
      same_as_old_translation(paragraphs_zh, task.old_paragraph_zh)
    ) {
      return {
        uploaded: false,
        ready: paragraphs.length,
        missing: 0,
        message: "identical_to_remote_translation",
      };
    }
    const ready = paragraphs.length - missing;
    if (missing > 0) {
      return {
        uploaded: false,
        ready,
        missing,
        message: "local_translation_incomplete",
      };
    }
    args.on_uploading({ ready, missing });
    await write_chapter_translation_with_retry({
      client: this.client,
      refresh_credentials: this.refresh_credentials,
      ref: args.ref,
      chapter: args.chapter,
      glossary_id: task.glossary_id,
      paragraphs_zh,
      signal: args.signal,
    });
    return {
      uploaded: true,
      ready,
      missing: 0,
      message: null,
    };
  }

  private async read_asset_text(project_path: string, asset_path: string): Promise<string> {
    const bytes = await this.database.read_asset_content(project_path, asset_path);
    if (bytes === null) {
      throw new AppError("remote.source_not_bound", {
        public_details: { reason: "asset_missing", asset_path },
      });
    }
    return bytes.toString("utf8");
  }

  private async read_asset_items(project_path: string, asset_path: string): Promise<AssetItem[]> {
    const records = await this.database.get_all_items(project_path);
    return records
      .filter((item) => item["file_path"] === asset_path)
      .flatMap((item) => {
        const row = item["row"];
        if (typeof row !== "number" || !Number.isSafeInteger(row)) return [];
        return [
          {
            row,
            src: String(item["src"] ?? ""),
            dst: String(item["dst"] ?? ""),
            status: String(item["status"] ?? "NONE"),
          },
        ];
      })
      .sort((left, right) => left.row - right.row);
  }

  private should_sync_chapter(ref: ReturnType<typeof parse_novel_url>): boolean {
    return ref.kind === "web";
  }

  private update_chapter(index: number, patch: Partial<RemoteWorkspaceChapterProgress>): void {
    const chapters = this.snapshot.chapters.slice();
    const current = chapters[index];
    if (current === undefined) return;
    chapters[index] = { ...current, ...patch };
    this.snapshot = { ...this.snapshot, chapters };
    this.publish();
  }

  private update_totals(uploaded: boolean): void {
    const totals = this.snapshot.totals;
    this.snapshot = {
      ...this.snapshot,
      totals: {
        ...totals,
        uploaded: totals.uploaded + (uploaded ? 1 : 0),
        skipped: totals.skipped + (uploaded ? 0 : 1),
      },
    };
  }

  private publish(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.get_snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function create_idle_snapshot(): RemoteWorkspaceSnapshot {
  return {
    status: "idle",
    started_at: null,
    finished_at: null,
    error: null,
    totals: { chapters: 0, uploaded: 0, skipped: 0, failed: 0 },
    chapters: [],
  };
}

function clone_snapshot(snapshot: RemoteWorkspaceSnapshot): RemoteWorkspaceSnapshot {
  return {
    ...snapshot,
    totals: { ...snapshot.totals },
    chapters: snapshot.chapters.map((chapter) => ({ ...chapter })),
  };
}

function signal_status(signal: AbortSignal, _error: unknown): RemoteWorkspaceStatus {
  return signal.aborted ? "cancelled" : "failed";
}

function signal_error(signal: AbortSignal, error: unknown): string {
  if (signal.aborted) return "cancelled";
  return error instanceof AppError ? error.code : "runtime.internal_invariant";
}

/**
 * 工作区章节与工程章节按标题配对；没有标题或标题变化时不猜测。
 * 章节数一致时按位置回退，覆盖章节改名但仍保持顺序的常见情况。
 */
function pair_workspace_chapters(
  chapters: readonly RemoteWorkspaceChapter[],
  asset_chapters: readonly RemoteChapter[],
): Map<number, RemoteChapter> {
  const result = new Map<number, RemoteChapter>();
  const by_title = new Map<string, RemoteChapter[]>();
  for (const chapter of asset_chapters) {
    if (chapter.kind !== "chapter") continue;
    const key = normalize_match_line(chapter.title);
    if (key === "") continue;
    const queue = by_title.get(key) ?? [];
    queue.push(chapter);
    by_title.set(key, queue);
  }
  const used = new Set<RemoteChapter>();
  for (const [index, chapter] of chapters.entries()) {
    const queue = by_title.get(normalize_match_line(chapter.title));
    const candidate = queue?.shift();
    if (candidate !== undefined) {
      result.set(index, candidate);
      used.add(candidate);
    }
  }
  const asset_chapters_only = asset_chapters.filter((chapter) => chapter.kind === "chapter");
  if (chapters.length === asset_chapters_only.length) {
    for (const [index, _chapter] of chapters.entries()) {
      if (result.has(index)) continue;
      const candidate = asset_chapters_only[index];
      if (candidate !== undefined && !used.has(candidate)) {
        result.set(index, candidate);
        used.add(candidate);
      }
    }
  }
  return result;
}

/**
 * 章节内按顺序把段落映射到工程条目；允许中间有标题与空行，
 * 但不跨章节、不跨越过长的缺失区段。
 */
function map_paragraph_items(
  paragraphs: readonly string[],
  chapter: RemoteChapter | null,
  items: readonly AssetItem[],
): Array<AssetItem | null> {
  if (chapter === null) return paragraphs.map(() => null);
  const chapter_items = items.filter(
    (item) => item.row >= chapter.start_row && item.row < chapter.end_row,
  );
  const result: Array<AssetItem | null> = [];
  let cursor = 0;
  for (const paragraph of paragraphs) {
    const target = normalize_match_line(paragraph);
    let found = -1;
    for (
      let offset = 0;
      offset < SEARCH_WINDOW && cursor + offset < chapter_items.length;
      offset += 1
    ) {
      const candidate = chapter_items[cursor + offset];
      if (candidate !== undefined && normalize_match_line(candidate.src) === target) {
        found = cursor + offset;
        break;
      }
    }
    if (found >= 0) {
      result.push(chapter_items[found] ?? null);
      cursor = found + 1;
    } else {
      result.push(null);
    }
  }
  return result;
}

/**
 * 文库整本 EPUB：按 `(分卷, 章节 id)` 找本地文档，再按「非空 body `<p>` 顺序」取条目。
 * 站点段落数与本地段落数不一致时返回 null，由调用方跳过该章。
 */
function resolve_epub_paragraph_items(
  doc_paths: ReadonlyMap<string, string>,
  documents: ReadonlyMap<string, readonly AssetItem[]>,
  chapter: RemoteWorkspaceChapter,
  paragraphs: readonly string[],
): Array<AssetItem | null> | null {
  if (chapter.volume_id === null) return null;
  const doc_path = doc_paths.get(build_epub_document_key(chapter.volume_id, chapter.chapter_id));
  if (doc_path === undefined) return null;
  const items = documents.get(doc_path);
  if (items === undefined || items.length !== paragraphs.length) return null;
  return [...items];
}
