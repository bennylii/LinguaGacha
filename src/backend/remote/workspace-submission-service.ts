import { AppError } from "../../shared/error/app-error";
import type { ProjectDatabase } from "../database/database-operations";
import type { RuntimeOperationGate, RuntimeLease } from "../runtime-operation-gate";
import type { ProjectSessionState } from "../project/project-session-state";
import type { NoveliaClient, RemoteWorkspaceChapter } from "./novelia-client";
import { call_with_credential_refresh } from "./credential-refresh";
import {
  is_missing_remote_translation,
  normalize_match_line,
  parse_novel_url,
  split_remote_document,
  type RemoteChapter,
} from "./novelia-source";
import {
  read_remote_source_binding,
  REMOTE_SOURCE_META_KEY,
  type RemoteSourceBinding,
} from "./remote-source";

const MAX_CHAPTER_FAILURES = 5;
const SEARCH_WINDOW = 50;

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

  private async execute(
    project_path: string,
    binding: RemoteSourceBinding,
    signal: AbortSignal,
  ): Promise<void> {
    const ref = parse_novel_url(binding.url);
    const workspace = await this.client.read_workspace(ref, signal);
    const asset_text = await this.read_asset_text(project_path, binding.asset_path);
    const asset_chapters = split_remote_document(asset_text).chapters;
    const asset_items = await this.read_asset_items(project_path, binding.asset_path);
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
          asset_chapter: partner,
          asset_items,
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
    asset_chapter: RemoteChapter | null;
    asset_items: readonly AssetItem[];
    signal: AbortSignal;
    on_uploading: (progress: { ready: number; missing: number }) => void;
  }): Promise<{
    uploaded: boolean;
    ready: number;
    missing: number;
    message: string | null;
  }> {
    let task = await call_with_credential_refresh(this.refresh_credentials, args.ref.origin, () =>
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
    const mapped = map_paragraph_items(paragraphs, args.asset_chapter, args.asset_items);
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
    if (task.old_paragraph_zh !== null && missing === 0 && same_as_old_translation(paragraphs_zh, task.old_paragraph_zh)) {
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
    try {
      await call_with_credential_refresh(this.refresh_credentials, args.ref.origin, () =>
        this.client.write_chapter_translation(
          args.ref,
          args.chapter,
          { glossary_id: task.glossary_id, paragraphs_zh },
          args.signal,
        ),
      );
    } catch (error) {
      if (args.signal.aborted) throw error;
      // 术语表在取任务与上传之间变化时刷新一次；仍失败则记录本章失败。
      const refreshed = await call_with_credential_refresh(
        this.refresh_credentials,
        args.ref.origin,
        () => this.client.read_chapter_task(args.ref, args.chapter, { sync: false }, args.signal),
      );
      if (refreshed.glossary_id === task.glossary_id) throw error;
      task = refreshed;
      await call_with_credential_refresh(this.refresh_credentials, args.ref.origin, () =>
        this.client.write_chapter_translation(
          args.ref,
          args.chapter,
          { glossary_id: task.glossary_id, paragraphs_zh },
          args.signal,
        ),
      );
    }
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
 * 上传内容是否与站点旧译逐段一致；空段不参与比较，长度不同视为有差异。
 * 旧译里的站点缺失标记不是真实译文，遇标记即视为不一致。
 */
function same_as_old_translation(
  paragraphs_zh: readonly string[],
  old_paragraph_zh: readonly string[],
): boolean {
  if (paragraphs_zh.length !== old_paragraph_zh.length) return false;
  return paragraphs_zh.every((paragraph, index) => {
    const old_paragraph = old_paragraph_zh[index] ?? "";
    if (old_paragraph.trim() === "") return false;
    return !is_missing_remote_translation(old_paragraph) && old_paragraph.trim() === paragraph.trim();
  });
}
