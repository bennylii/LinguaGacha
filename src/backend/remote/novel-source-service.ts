import path from "node:path";

import type { JsonRecord, JsonValue } from "../../domain/json";
import type { ItemNameField, ItemStatus } from "../../domain/item";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import { AppError } from "../../shared/error/app-error";
import type { ProjectWriteResult } from "../../shared/project-event";
import { random_id } from "../../shared/utils/identifier";
import type { AppPathService } from "../app/app-path-service";
import type { ProjectDatabase } from "../database/database-operations";
import {
  build_section_revisions_from_meta,
  get_section_revision,
} from "../project/project-data-reader";
import type {
  RemoteAssetReplaceRequest,
  RemoteAssetRowOverride,
} from "../project/project-content-service";
import type { ProjectFileLock } from "../project/project-file-lock";
import type { ProjectSessionState } from "../project/project-session-state";
import { NoveliaClient, type RemoteNovelMetadata } from "./novelia-client";
import {
  align_remote_documents,
  build_add_only_plan,
  build_novel_filename,
  parse_novel_url,
  sha256_text,
  split_remote_document,
  type RemoteAlignmentPlan,
  type RemoteAlignmentStats,
  type RemoteChapterPlan,
  type RemoteNovelRef,
  type RemoteOldItem,
  type RemoteRowDecision,
  type RemoteRowPlan,
} from "./novelia-source";
import {
  build_remote_source_binding,
  read_remote_source_binding,
  REMOTE_SOURCE_META_KEY,
  type RemoteSourceBinding,
} from "./remote-source";
import type { RemoteSnapshotStore } from "./remote-snapshot-store";

const STAGING_DIRECTORY = ["remote", "staging"] as const;
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const SYNC_STASH_TTL_MS = 10 * 60 * 1_000;
const REMOTE_SYNC_MODES = ["add_only", "auto", "manual"] as const;

export type RemoteSyncMode = (typeof REMOTE_SYNC_MODES)[number];

export interface RemoteAssetWriter {
  replace_remote_asset(request: RemoteAssetReplaceRequest): Promise<ProjectWriteResult>;
}

/** 一次已下载但尚未提交的导入；提交快照与清理暂存由调用方决定。 */
export interface RemoteNovelImport {
  source_path: string;
  binding: RemoteSourceBinding;
  content_hash: string;
  text: string;
  /** 工程创建提交成功后写入上次同步快照。 */
  commit_snapshot: (project_path: string) => Promise<void>;
  /** 删除本次暂存目录；重复调用安全。 */
  dispose: () => Promise<void>;
}

/** 生命周期只依赖这个端口，测试可注入不触网的导入实现。 */
export interface RemoteNovelImportPort {
  prepare_import(url: string, signal?: AbortSignal): Promise<RemoteNovelImport>;
}

export interface RemoteNovelPreview {
  origin: string;
  host: string;
  kind: "web" | "wenku";
  title: string;
  title_jp: string;
  title_zh: string | null;
  introduction_jp: string;
  introduction_zh: string | null;
  chapter_count: number;
  filename: string;
}

export interface RemoteSourceSnapshot {
  binding: RemoteSourceBinding | null;
  asset_present: boolean;
  snapshot_present: boolean;
}

export type RemoteSyncBaseSource = "snapshot" | "current_asset";

/** 预览只返回统计与章节级差异；行详情按章读取，避免大书一次传输整本对照。 */
export interface RemoteSyncPreview {
  stash_id: string;
  created_at: string;
  expires_at: string;
  binding: RemoteSourceBinding;
  filename: string;
  remote_hash: string;
  previous_source: RemoteSyncBaseSource;
  snapshot_available: boolean;
  current_asset_changed: boolean;
  stats: RemoteAlignmentStats;
  chapters: RemoteChapterPlan[];
  files_revision: number;
  items_revision: number;
}

export interface RemoteSyncChapterRow {
  row: number;
  src: string;
  src_hash: string;
  decision: RemoteRowDecision;
  similarity: number;
  review: boolean;
  old_src: string | null;
  old_dst: string | null;
  old_status: ItemStatus | null;
}

export interface RemoteSyncAlignPreview {
  stash_id: string;
  expires_at: string;
  chapter: RemoteChapterPlan;
  rows: RemoteSyncChapterRow[];
}

export interface RemoteSyncApplyResult {
  mode: RemoteSyncMode;
  write: ProjectWriteResult;
  binding: RemoteSourceBinding;
  stats: RemoteAlignmentStats;
  chapters: RemoteChapterPlan[];
  skipped_chapters: string[];
}

interface SyncStash {
  id: string;
  project_path: string;
  binding: RemoteSourceBinding;
  ref: RemoteNovelRef;
  filename: string;
  next_text: string;
  plan: RemoteAlignmentPlan;
  current_asset_hash: string;
  files_revision: number;
  items_revision: number;
  created_at: number;
}

export interface NovelSourceServiceOptions {
  paths: Pick<AppPathService, "get_user_data_path">;
  database: ProjectDatabase;
  session_state: ProjectSessionState;
  client: NoveliaClient;
  snapshots: RemoteSnapshotStore;
  writer: RemoteAssetWriter;
  project_lock: ProjectFileLock;
  native_fs?: NativeFs;
}

/**
 * 小说来源的下载、暂存与绑定读取。
 * 这里不写工程事实；工程创建与同步提交由生命周期和内容服务负责。
 */
export class NovelSourceService implements RemoteNovelImportPort {
  private readonly paths: NovelSourceServiceOptions["paths"];
  private readonly database: ProjectDatabase;
  private readonly session_state: ProjectSessionState;
  private readonly client: NoveliaClient;
  private readonly snapshots: RemoteSnapshotStore;
  private readonly writer: RemoteAssetWriter;
  private readonly project_lock: ProjectFileLock;
  private readonly native_fs: NativeFs;
  private staging_cleaned = false;
  private sync_stash: SyncStash | null = null; // 每个工程只保留最近一次预览

  public constructor(options: NovelSourceServiceOptions) {
    this.paths = options.paths;
    this.database = options.database;
    this.session_state = options.session_state;
    this.client = options.client;
    this.snapshots = options.snapshots;
    this.writer = options.writer;
    this.project_lock = options.project_lock;
    this.native_fs = options.native_fs ?? default_native_fs;
  }

  /** 只读取元数据，不下载整本；页面用它在创建前展示作品信息。 */
  public async preview(url: string, signal?: AbortSignal): Promise<RemoteNovelPreview> {
    const ref = parse_novel_ref(url);
    const metadata = await this.client.read_metadata(ref, signal);
    return build_preview(ref, metadata);
  }

  /** 下载整本到进程私有暂存目录，返回可直接交给源文件解析的路径。 */
  public async prepare_import(url: string, signal?: AbortSignal): Promise<RemoteNovelImport> {
    const ref = parse_novel_ref(url);
    await this.clean_stale_staging();
    const download = await this.client.download(ref, signal);
    const staging_root = this.get_staging_root();
    const staging_directory = path.join(staging_root, random_id(16));
    await this.native_fs.make_dir_async(staging_directory);
    // 文件名已由站点客户端按标题清理；再核对一次边界，避免暂存写到目录外。
    const filename = path.basename(download.filename);
    if (filename !== download.filename || filename === "") {
      throw new AppError("remote.fetch_failed", {
        diagnostic_context: { reason: "invalid_download_filename" },
      });
    }
    const source_path = path.join(staging_directory, filename);
    if (!is_inside(staging_root, source_path)) {
      throw new AppError("remote.fetch_failed", {
        diagnostic_context: { reason: "staging_path_escape" },
      });
    }
    await this.native_fs.write_file(source_path, download.text);
    const binding = build_remote_source_binding({
      ref,
      title: download.metadata.title,
      asset_path: filename,
      remote_hash: download.content_hash,
      chapter_count: download.chapter_count,
      synced_at: new Date().toISOString(),
    });
    let disposed = false;
    return {
      source_path,
      binding,
      content_hash: download.content_hash,
      text: download.text,
      commit_snapshot: async (project_path) => {
        await this.snapshots.write(project_path, binding, download.text);
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await this.remove_staging_directory(staging_directory);
      },
    };
  }

  /** 读取当前工程的远端绑定；未加载与未绑定都返回空绑定。 */
  public async read_bound_source(): Promise<RemoteSourceSnapshot> {
    const project_path = this.session_state.require_loaded_project_path();
    const meta = await this.database.get_all_meta(project_path);
    const binding = read_remote_source_binding(meta[REMOTE_SOURCE_META_KEY]);
    if (binding === null) {
      return { binding: null, asset_present: false, snapshot_present: false };
    }
    const assets = await this.database.get_all_asset_records(project_path);
    return {
      binding,
      asset_present: assets.some((asset) => asset.path === binding.asset_path),
      snapshot_present: this.snapshots.read(project_path) !== null,
    };
  }

  /**
   * 下载整本并以上次同步文本（缺失时退化为当前资产）为基准生成差异。
   * 预览只保留一份内存暂存，应用时必须携带同一 stash_id。
   */
  public async preview_sync(signal?: AbortSignal): Promise<RemoteSyncPreview> {
    const project_path = this.session_state.require_loaded_project_path();
    const binding = await this.require_binding(project_path);
    const ref = parse_novel_ref(binding.url);
    const download = await this.client.download(ref, signal);
    return await this.project_lock.run(project_path, async () => {
      const current = await this.read_remote_context(project_path, binding);
      const snapshot = this.read_matching_snapshot(project_path, binding);
      const previous_text = snapshot?.text ?? current.text;
      const plan = align_remote_documents({
        previous_text,
        next_text: download.text,
        old_items: current.items,
      });
      const created_at = Date.now();
      const id = random_id(16);
      this.sync_stash = {
        id,
        project_path,
        binding,
        ref,
        filename: download.filename,
        next_text: download.text,
        plan,
        current_asset_hash: current.hash,
        files_revision: current.files_revision,
        items_revision: current.items_revision,
        created_at,
      };
      return {
        stash_id: id,
        created_at: new Date(created_at).toISOString(),
        expires_at: new Date(created_at + SYNC_STASH_TTL_MS).toISOString(),
        binding,
        filename: download.filename,
        remote_hash: download.content_hash,
        previous_source: snapshot === null ? "current_asset" : "snapshot",
        snapshot_available: snapshot !== null,
        current_asset_changed: snapshot !== null && snapshot.content_hash !== current.hash,
        stats: plan.stats,
        chapters: plan.chapters,
        files_revision: current.files_revision,
        items_revision: current.items_revision,
      };
    });
  }

  /** 按章返回行级对照；章节索引来自预览的新文档。 */
  public read_align_preview(body: JsonRecord): RemoteSyncAlignPreview {
    const stash = this.require_stash(require_body_string(body, "stash_id"));
    const chapter_index = require_body_integer(body, "chapter_index");
    const chapter = stash.plan.chapters.find((candidate) => candidate.index === chapter_index);
    if (chapter === undefined) {
      throw new AppError("request.validation_failed", {
        public_details: { field: "chapter_index" },
      });
    }
    return {
      stash_id: stash.id,
      expires_at: new Date(stash.created_at + SYNC_STASH_TTL_MS).toISOString(),
      chapter,
      rows: stash.plan.rows
        .filter((row) => row.chapter_index === chapter_index)
        .map(to_sync_chapter_row),
    };
  }

  /** API 边界：按模式与人工覆盖应用预览，返回最终统计和写入结果。 */
  public async apply_sync_request(body: JsonRecord): Promise<RemoteSyncApplyResult> {
    const mode = body["mode"];
    if (mode !== "add_only" && mode !== "auto" && mode !== "manual") {
      throw new AppError("request.validation_failed", { public_details: { field: "mode" } });
    }
    const stash_id = require_body_string(body, "stash_id");
    const stash = this.require_stash(stash_id);
    const overrides = normalize_sync_overrides(body["overrides"], mode, stash.plan);
    return await this.apply_sync({ mode, stash_id, overrides });
  }

  /**
   * 应用预览：先核对资产与修订未变化，再交给内容服务写入并原子更新快照。
   * add_only 以当前资产为基准重新对齐，其余模式沿用预览计划。
   */
  private async apply_sync(input: {
    mode: RemoteSyncMode;
    stash_id: string;
    overrides: ReadonlyMap<number, RemoteAssetRowOverride>;
  }): Promise<RemoteSyncApplyResult> {
    const project_path = this.session_state.require_loaded_project_path();
    const stash = this.require_stash(input.stash_id);
    if (stash.project_path !== project_path) {
      throw new AppError("remote.stash_expired", {
        public_details: { reason: "project_changed" },
      });
    }
    return await this.project_lock.run(project_path, async () => {
      const current = await this.read_remote_context(project_path, stash.binding);
      if (current.hash !== stash.current_asset_hash) {
        this.sync_stash = null;
        throw new AppError("remote.alignment_stale", {
          public_details: { reason: "asset_changed" },
        });
      }
      const meta = await this.database.get_all_meta(project_path);
      const files_revision = get_section_revision(meta, "files");
      const items_revision = get_section_revision(meta, "items");
      if (files_revision !== stash.files_revision || items_revision !== stash.items_revision) {
        this.sync_stash = null;
        throw new AppError("data.revision_conflict");
      }
      const applied = this.build_sync_application(input.mode, stash, current);
      const binding = build_remote_source_binding({
        ref: stash.ref,
        title: stash.binding.title,
        asset_path: stash.binding.asset_path,
        remote_hash: sha256_text(applied.text),
        chapter_count: split_remote_document(applied.text).chapters.filter(
          (chapter) => chapter.kind === "chapter",
        ).length,
        synced_at: new Date().toISOString(),
      });
      const write = await this.writer.replace_remote_asset({
        assetPath: binding.asset_path,
        content: applied.text,
        binding,
        rows: applied.plan.rows,
        overrides: input.overrides,
        expectedSectionRevisions: {
          files: files_revision,
          items: items_revision,
        },
      });
      try {
        this.snapshots.write(project_path, binding, applied.text);
      } catch (cause) {
        this.sync_stash = null;
        throw new AppError("data.committed_sync_failed", {
          cause,
          public_details: { committed: true, action: "write_remote_snapshot" },
          diagnostic_context: { operation: "write_remote_snapshot_after_sync" },
        });
      }
      this.sync_stash = null;
      return {
        mode: input.mode,
        write,
        binding,
        stats: applied.plan.stats,
        chapters: applied.plan.chapters,
        skipped_chapters: applied.skipped_chapters,
      };
    });
  }

  private async require_binding(project_path: string): Promise<RemoteSourceBinding> {
    const meta = await this.database.get_all_meta(project_path);
    const binding = read_remote_source_binding(meta[REMOTE_SOURCE_META_KEY]);
    if (binding === null) throw new AppError("remote.source_not_bound");
    return binding;
  }

  private read_matching_snapshot(
    project_path: string,
    binding: RemoteSourceBinding,
  ): { text: string; content_hash: string } | null {
    const snapshot = this.snapshots.read(project_path);
    if (snapshot === null) return null;
    if (
      snapshot.key.origin !== binding.origin ||
      snapshot.key.kind !== binding.kind ||
      snapshot.key.provider_id !== binding.provider_id ||
      snapshot.key.novel_id !== binding.novel_id
    ) {
      return null;
    }
    return snapshot;
  }

  /** 只读取远端资产与它的条目；其他文件不参与章节与行的判断。 */
  private async read_remote_context(
    project_path: string,
    binding: RemoteSourceBinding,
  ): Promise<{
    text: string;
    hash: string;
    items: RemoteOldItem[];
    files_revision: number;
    items_revision: number;
  }> {
    const bytes = await this.database.read_asset_content(project_path, binding.asset_path);
    if (bytes === null) {
      throw new AppError("remote.source_not_bound", {
        public_details: { reason: "asset_missing", asset_path: binding.asset_path },
      });
    }
    const text = bytes.toString("utf8");
    const raw_items = await this.database.get_all_items(project_path);
    const items: RemoteOldItem[] = [];
    for (const record of raw_items) {
      if (record["file_path"] !== binding.asset_path) continue;
      const item_id = record["id"];
      const row = record["row"];
      if (
        typeof item_id !== "number" ||
        !Number.isSafeInteger(item_id) ||
        typeof row !== "number" ||
        !Number.isSafeInteger(row)
      ) {
        continue;
      }
      items.push({
        item_id,
        row,
        src: String(record["src"] ?? ""),
        dst: String(record["dst"] ?? ""),
        name_dst: (record["name_dst"] ?? null) as ItemNameField,
        status: String(record["status"] ?? "NONE") as ItemStatus,
        extra_field: (record["extra_field"] ?? "") as JsonValue,
      });
    }
    const meta = await this.database.get_all_meta(project_path);
    const revisions = build_section_revisions_from_meta(meta);
    return {
      text,
      hash: sha256_text(text),
      items,
      files_revision: revisions.files ?? 0,
      items_revision: revisions.items ?? 0,
    };
  }

  private require_stash(stash_id: string): SyncStash {
    const stash = this.sync_stash;
    if (stash === null || stash.id !== stash_id) {
      throw new AppError("remote.stash_expired", {
        public_details: { reason: "missing_or_replaced" },
      });
    }
    if (Date.now() - stash.created_at > SYNC_STASH_TTL_MS) {
      this.sync_stash = null;
      throw new AppError("remote.stash_expired", {
        public_details: { reason: "expired" },
      });
    }
    return stash;
  }

  /**
   * add_only 只追加新增章节并重新对齐；auto 超过丢失阈值时拒绝；manual 沿用预览。
   */
  private build_sync_application(
    mode: RemoteSyncMode,
    stash: SyncStash,
    current: { text: string; items: RemoteOldItem[] },
  ): { text: string; plan: RemoteAlignmentPlan; skipped_chapters: string[] } {
    if (mode === "add_only") {
      const appended = build_add_only_plan(current.text, stash.plan);
      const plan = align_remote_documents({
        previous_text: current.text,
        next_text: appended.text,
        old_items: current.items,
      });
      return { text: appended.text, plan, skipped_chapters: appended.skipped };
    }
    if (mode === "auto" && stash.plan.stats.requires_alignment) {
      throw new AppError("remote.alignment_required", {
        public_details: {
          would_lose: stash.plan.stats.would_lose,
          total: stash.plan.next.lines.length,
        },
      });
    }
    return { text: stash.next_text, plan: stash.plan, skipped_chapters: [] };
  }

  private get_staging_root(): string {
    return this.paths.get_user_data_path(...STAGING_DIRECTORY);
  }

  /** 启动后首次导入时清理超过 24 小时的孤儿暂存，失败不影响本次导入。 */
  private async clean_stale_staging(): Promise<void> {
    if (this.staging_cleaned) return;
    this.staging_cleaned = true;
    const staging_root = this.get_staging_root();
    let entries;
    try {
      entries = this.native_fs.read_dirents(staging_root);
    } catch {
      return;
    }
    const deadline = Date.now() - STAGING_MAX_AGE_MS;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(staging_root, entry.name);
      try {
        if (this.native_fs.stat(directory).mtimeMs >= deadline) continue;
        await this.remove_staging_directory(directory);
      } catch {
        // 暂存清理是尽力而为；目录可能已被其他实例删除或正在使用。
      }
    }
  }

  private async remove_staging_directory(directory: string): Promise<void> {
    try {
      await this.native_fs.remove_async(directory, { recursive: true, force: true });
    } catch {
      // 清理失败不会改变已提交事实，下次启动仍会按时间重试。
    }
  }
}

function parse_novel_ref(url: string): RemoteNovelRef {
  try {
    return parse_novel_url(url);
  } catch (error) {
    throw new AppError("remote.invalid_url", {
      cause: error,
      diagnostic_context: { reason: "novel_url_rejected" },
    });
  }
}

function build_preview(ref: RemoteNovelRef, metadata: RemoteNovelMetadata): RemoteNovelPreview {
  return {
    origin: ref.origin,
    host: ref.host,
    kind: ref.kind,
    title: metadata.title,
    title_jp: metadata.title_jp,
    title_zh: metadata.title_zh,
    introduction_jp: metadata.introduction_jp,
    introduction_zh: metadata.introduction_zh,
    chapter_count: metadata.chapter_count,
    filename: build_novel_filename(metadata.title),
  };
}

function is_inside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** 行详情只暴露对照需要的旧译文事实，不返回旧条目扩展字段。 */
function to_sync_chapter_row(row: RemoteRowPlan): RemoteSyncChapterRow {
  return {
    row: row.row,
    src: row.src,
    src_hash: row.src_hash,
    decision: row.decision,
    similarity: row.similarity,
    review: row.review,
    old_src: row.old_item?.src ?? null,
    old_dst: row.old_item?.dst ?? null,
    old_status: row.old_item?.status ?? null,
  };
}

function require_body_string(body: JsonRecord, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError("request.validation_failed", { public_details: { field: key } });
  }
  return value;
}

function require_body_integer(body: JsonRecord, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AppError("request.validation_failed", { public_details: { field: key } });
  }
  return value;
}

/**
 * 人工覆盖只允许针对本次预览中的真实行，并核对行哈希。
 * 任何行号或原文变化都整批拒绝，避免把译文写到另一行。
 */
function normalize_sync_overrides(
  value: JsonValue | undefined,
  mode: RemoteSyncMode,
  plan: RemoteAlignmentPlan,
): Map<number, RemoteAssetRowOverride> {
  const result = new Map<number, RemoteAssetRowOverride>();
  if (value === undefined) return result;
  if (!Array.isArray(value)) {
    throw new AppError("request.validation_failed", { public_details: { field: "overrides" } });
  }
  if (mode === "add_only" && value.length > 0) {
    throw new AppError("request.validation_failed", {
      public_details: { field: "overrides", reason: "add_only_has_no_overrides" },
    });
  }
  const rows_by_row = new Map(plan.rows.map((row) => [row.row, row]));
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new AppError("request.validation_failed", { public_details: { field: "overrides" } });
    }
    const record = entry as Record<string, JsonValue>;
    const row = record["row"];
    const src_hash = record["src_hash"];
    const action = record["action"];
    const dst = record["dst"];
    if (
      typeof row !== "number" ||
      !Number.isSafeInteger(row) ||
      typeof src_hash !== "string" ||
      (action !== "preserve" && action !== "keep" && action !== "retranslate") ||
      (dst !== undefined && typeof dst !== "string")
    ) {
      throw new AppError("request.validation_failed", { public_details: { field: "overrides" } });
    }
    if (result.has(row)) {
      throw new AppError("request.validation_failed", {
        public_details: { field: "overrides", reason: "duplicate_row", row },
      });
    }
    const plan_row = rows_by_row.get(row);
    if (plan_row === undefined || plan_row.src_hash !== src_hash) {
      throw new AppError("remote.alignment_stale", {
        public_details: { reason: "override_row_changed", row },
      });
    }
    if (action !== "retranslate" && plan_row.old_item === null) {
      throw new AppError("request.validation_failed", {
        public_details: { field: "overrides", reason: "no_previous_translation", row },
      });
    }
    result.set(row, { action, ...(dst === undefined ? {} : { dst }) });
  }
  return result;
}
