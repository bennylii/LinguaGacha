import { createHash } from "node:crypto";
import path from "node:path";

import type { JsonRecord, JsonValue } from "../../domain/json";
import type { ItemNameField, ItemStatus } from "../../domain/item";
import { read_project_language_settings } from "../../domain/project-settings";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import { AppError } from "../../shared/error/app-error";
import type { ProjectWriteResult } from "../../shared/project-event";
import { random_id } from "../../shared/utils/identifier";
import type { AppPathService } from "../app/app-path-service";
import type { ProjectDatabase } from "../database/database-operations";
import type { ProjectAssetRecord } from "../database/project-database-access";
import {
  build_section_revisions_from_meta,
  get_section_revision,
} from "../project/project-data-reader";
import type {
  RemoteAssetReplaceOptions,
  RemoteAssetReplaceRequest,
  RemoteAssetRowOverride,
  RemoteSourceBindOptions,
  RemoteSourceBindRequest,
} from "../project/project-content-service";
import type { ProjectFileLock } from "../project/project-file-lock";
import type { ProjectSessionState } from "../project/project-session-state";
import { call_with_credential_refresh } from "./credential-refresh";
import { NoveliaClient, type RemoteNovelMetadata } from "./novelia-client";
import { build_epub_remote_source, read_epub_remote_source } from "./epub-remote-source";
import {
  align_remote_documents,
  build_add_only_plan,
  build_novel_filename,
  normalize_remote_source_text,
  parse_novel_ref,
  remote_text_lines_match,
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
  read_remote_epub_map,
  read_remote_source_binding,
  REMOTE_EPUB_MAP_META_KEY,
  REMOTE_SOURCE_META_KEY,
  same_remote_source_identity,
  type RemoteEpubMap,
  type RemoteSourceBinding,
} from "./remote-source";
import type { RemoteSnapshotStore } from "./remote-snapshot-store";
import {
  assert_wenku_volumes_bindable,
  build_wenku_epub_import,
  build_wenku_epub_package,
} from "./wenku-epub-source";
import {
  apply_wenku_epub_sync_plan,
  build_wenku_epub_sync_plans,
  read_wenku_epub_local_package,
  read_wenku_epub_remote_package,
  type WenkuEpubSyncPlans,
} from "./wenku-epub-sync";

const STAGING_DIRECTORY = ["remote", "staging"] as const;
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const SYNC_STASH_TTL_MS = 10 * 60 * 1_000;
const REMOTE_SYNC_MODES = ["add_only", "auto", "manual"] as const;

export type RemoteSyncMode = (typeof REMOTE_SYNC_MODES)[number];

export interface RemoteAssetWriter {
  replace_remote_asset(
    request: RemoteAssetReplaceRequest,
    options?: RemoteAssetReplaceOptions,
  ): Promise<ProjectWriteResult>;
  bind_remote_source(
    request: RemoteSourceBindRequest,
    options?: RemoteSourceBindOptions,
  ): Promise<ProjectWriteResult>;
}

/** 一次已下载但尚未提交的导入；提交快照与清理暂存由调用方决定。 */
export interface RemoteNovelImport {
  source_path: string;
  binding: RemoteSourceBinding;
  content_hash: string;
  text: string;
  translations: ReadonlyMap<number, string>; // 站点 GPT 译文，键为源文行号
  /** 文库整本 EPUB 的章节映射；工程创建时随资产一起落库。 */
  epub_map: RemoteEpubMap | null;
  /** 工程创建提交成功后写入上次同步快照。 */
  commit_snapshot: (project_path: string) => Promise<void>;
  /** 删除本次暂存目录；重复调用安全。 */
  dispose: () => Promise<void>;
}

/** 一份暂存在 `userdata/remote/staging` 的源文件；导入完成后必须 dispose。 */
export interface StagedTextFile {
  source_path: string;
  /** 删除本次暂存目录；重复调用安全。 */
  dispose: () => Promise<void>;
}

/** 生命周期只依赖这个端口，测试可注入不触网的导入实现。 */
export interface RemoteNovelImportPort {
  prepare_import(
    url: string,
    signal?: AbortSignal,
    options?: { translations?: boolean },
  ): Promise<RemoteNovelImport>;
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

/** 换源只更新作品身份，资产路径和本地译文保持不变。 */
export interface RemoteSourceRebindResult {
  changed: boolean;
  previous: {
    url: string;
    title: string;
    kind: RemoteSourceBinding["kind"];
  };
  current: {
    url: string;
    title: string;
    kind: RemoteSourceBinding["kind"];
    chapter_count: number;
  };
  asset_path: string;
  /** 本地资产与下载文本是否一致；仅作为审批信息，不参与拒绝。 */
  text_matches: boolean | null;
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
  remote_dst: string | null;
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
  /** 文库整本 EPUB 走文档级计划；文本来源为 null。 */
  epub_plans: WenkuEpubSyncPlans | null;
  asset_type: string;
  current_asset_hash: string;
  /** EPUB 正文哈希相同也可能只改了图片等资源，提交时用原始字节哈希复查。 */
  asset_hash: string;
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
  /** 站点拒绝凭据时触发登录链路的 token 续期；CLI 缺席。 */
  refresh_credentials?: ((origin: string) => Promise<boolean>) | undefined;
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
  private readonly refresh_credentials: ((origin: string) => Promise<boolean>) | null;
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
    this.refresh_credentials = options.refresh_credentials ?? null;
    this.native_fs = options.native_fs ?? default_native_fs;
  }

  /** 只读取元数据，不下载整本；页面用它在创建前展示作品信息。 */
  public async preview(url: string, signal?: AbortSignal): Promise<RemoteNovelPreview> {
    const ref = parse_novel_ref(url);
    const metadata = await this.client.read_metadata(ref, signal);
    return build_preview(ref, metadata);
  }

  /** 下载整本到进程私有暂存目录，返回可直接交给源文件解析的路径。 */
  public async prepare_import(
    url: string,
    signal?: AbortSignal,
    options: { translations?: boolean } = {},
  ): Promise<RemoteNovelImport> {
    const ref = parse_novel_ref(url);
    if (ref.kind === "wenku") {
      const metadata = await this.client.read_metadata(ref, signal);
      const formats = assert_wenku_volumes_bindable(metadata);
      if (formats.includes("epub")) {
        return await this.prepare_wenku_epub_import(ref, metadata, signal, options);
      }
    }
    const download = await this.client.download(ref, signal, options);
    const staged = await this.stage_text(download.filename, download.text);
    const binding = build_remote_source_binding({
      ref,
      title: download.metadata.title,
      asset_path: download.filename,
      remote_hash: download.content_hash,
      chapter_count: download.chapter_count,
      synced_at: new Date().toISOString(),
    });
    return {
      source_path: staged.source_path,
      binding,
      content_hash: download.content_hash,
      text: download.text,
      translations: download.translations,
      epub_map: null,
      commit_snapshot: async (project_path) => {
        await this.snapshots.write(project_path, binding, download.text);
      },
      dispose: staged.dispose,
    };
  }

  /**
   * 文库整本导入：全部分卷还原日文并合并成一个 EPUB，站点已有中文按条目行号沿用。
   * 合并包正文成为唯一的同步基准，后续不再回落到按章 TXT 拼装。
   */
  private async prepare_wenku_epub_import(
    ref: RemoteNovelRef,
    metadata: RemoteNovelMetadata,
    signal: AbortSignal | undefined,
    options: { translations?: boolean },
  ): Promise<RemoteNovelImport> {
    const epub = await build_wenku_epub_import({
      ref,
      metadata,
      client: this.client,
      include_translations: options.translations === true,
      ...(signal === undefined ? {} : { signal }),
    });
    const staged = await this.stage_bytes(epub.filename, epub.bytes);
    const content_hash = sha256_text(epub.text);
    const binding = build_remote_source_binding({
      ref,
      title: metadata.title,
      asset_path: epub.filename,
      remote_hash: content_hash,
      chapter_count: epub.chapter_count,
      synced_at: new Date().toISOString(),
    });
    return {
      source_path: staged.source_path,
      binding,
      content_hash,
      text: epub.text,
      translations: epub.translations,
      epub_map: epub.map,
      commit_snapshot: async (project_path) => {
        await this.snapshots.write(project_path, binding, epub.text);
      },
      dispose: staged.dispose,
    };
  }

  /** 把一段文本暂存为可导入的源文件；调用方用 `dispose` 清理目录。 */
  public async stage_text(file_name: string, text: string): Promise<StagedTextFile> {
    return await this.stage_bytes(file_name, text);
  }

  /** 二进制资产与文本共用暂存目录和清理语义。 */
  public async stage_bytes(file_name: string, data: string | Uint8Array): Promise<StagedTextFile> {
    await this.clean_stale_staging();
    const staging_root = this.get_staging_root();
    const staging_directory = path.join(staging_root, random_id(16));
    await this.native_fs.make_dir_async(staging_directory);
    // 文件名已由站点客户端按标题清理；再核对一次边界，避免暂存写到目录外。
    const filename = path.basename(file_name);
    if (filename !== file_name || filename === "") {
      throw new AppError("remote.fetch_failed", {
        diagnostic_context: { reason: "invalid_staging_filename" },
      });
    }
    const source_path = path.join(staging_directory, filename);
    if (!is_inside(staging_root, source_path)) {
      throw new AppError("remote.fetch_failed", {
        diagnostic_context: { reason: "staging_path_escape" },
      });
    }
    await this.native_fs.write_file(source_path, data);
    let disposed = false;
    return {
      source_path,
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
   * 补绑定只接受工程唯一的 TXT 正文资产；额外资产会让后续整本同步的替换目标不明确。
   * EPUB 只能整本导入时生成，补绑定无法证明其分卷与章节契约，直接拒绝。
   * 下载前后各调用一次，锁内复查复用同一判定。
   */
  private async require_single_remote_asset(project_path: string): Promise<ProjectAssetRecord> {
    const assets = await this.database.get_all_asset_records(project_path);
    const [asset, ...extra_assets] = assets;
    if (asset === undefined) {
      throw new AppError("remote.source_not_bindable", {
        public_details: { reason: "no_assets", asset_count: 0, file_types: [] },
      });
    }
    if (extra_assets.length > 0) {
      throw new AppError("remote.source_not_bindable", {
        public_details: {
          reason: "multiple_assets",
          asset_count: assets.length,
          file_types: assets.map((candidate) => candidate.file_type),
        },
      });
    }
    if (asset.file_type === "EPUB") {
      throw new AppError("remote.source_not_bindable", {
        public_details: {
          reason: "epub_requires_import",
          asset_path: asset.path,
          file_type: asset.file_type,
        },
      });
    }
    if (asset.file_type !== "TXT") {
      throw new AppError("remote.source_not_bindable", {
        public_details: {
          reason: "asset_not_supported",
          asset_path: asset.path,
          file_type: asset.file_type,
        },
      });
    }
    return asset;
  }

  /**
   * 为已打开且未绑定的工程补写小说来源。
   * 只有工程只有一个资产且该资产为 TXT 或 EPUB、正文与站点一致时才提交，避免把不相关的本地译文挂到远端作品上。
   */
  public async bind_existing(url: string, signal?: AbortSignal): Promise<RemoteSourceSnapshot> {
    const project_path = this.session_state.require_loaded_project_path();
    const meta = await this.database.get_all_meta(project_path);
    if (read_remote_source_binding(meta[REMOTE_SOURCE_META_KEY]) !== null) {
      throw new AppError("remote.source_already_bound");
    }
    const asset = await this.require_single_remote_asset(project_path);
    const current_bytes = await this.database.read_asset_content(project_path, asset.path);
    if (current_bytes === null) {
      throw new AppError("remote.source_not_bindable", {
        public_details: { reason: "asset_missing", asset_path: asset.path },
      });
    }
    const current_text = current_bytes.toString("utf8");
    const current_hash = sha256_text(current_text);
    const ref = parse_novel_ref(url);
    const download = await this.client.download(ref, signal);
    const remote_text = download.text;
    const remote_hash = download.content_hash;
    if (current_text !== remote_text) {
      throw new AppError("remote.source_mismatch", {
        public_details: {
          reason: "text_changed",
          current_hash,
          remote_hash,
        },
      });
    }
    const binding = build_remote_source_binding({
      ref,
      title: download.metadata.title,
      asset_path: asset.path,
      remote_hash,
      chapter_count: download.chapter_count,
      synced_at: new Date().toISOString(),
    });
    return await this.project_lock.run(project_path, async () => {
      const latest_meta = await this.database.get_all_meta(project_path);
      if (read_remote_source_binding(latest_meta[REMOTE_SOURCE_META_KEY]) !== null) {
        throw new AppError("remote.source_already_bound");
      }
      const latest_asset = await this.require_single_remote_asset(project_path);
      if (latest_asset.path !== asset.path) {
        throw new AppError("remote.source_not_bindable", {
          public_details: { reason: "asset_changed", asset_path: latest_asset.path },
        });
      }
      const latest_bytes = await this.database.read_asset_content(project_path, asset.path);
      const latest_text = latest_bytes === null ? null : latest_bytes.toString("utf8");
      if (latest_text === null || latest_text !== current_text) {
        throw new AppError("remote.source_mismatch", {
          public_details: {
            reason: "asset_changed",
            current_hash: latest_text === null ? null : sha256_text(latest_text),
            remote_hash,
          },
        });
      }
      try {
        // 快照先于绑定落盘：绑定一旦可见，后续同步就有同一版本的比较基准。
        this.snapshots.write(project_path, binding, current_text);
        await this.writer.bind_remote_source({ binding });
      } catch (cause) {
        // 写入已提交但通知失败时绑定仍然生效，不能删除刚写入的快照。
        if (!(cause instanceof AppError && cause.code === "data.committed_sync_failed")) {
          try {
            this.snapshots.clear(project_path);
          } catch {
            // 清理失败只会留下无绑定快照；读取绑定后才会使用快照，因此不影响工程事实。
          }
        }
        throw cause;
      }
      return await this.read_bound_source();
    });
  }

  /**
   * 把已绑定网页小说换到同一站点的另一个作品页。
   * 只更新绑定身份，资产路径、条目与译文不动；章节数量不一致时拒绝换源。
   */
  public async rebind_existing(
    url: string,
    signal?: AbortSignal,
    options: RemoteSourceBindOptions = {},
  ): Promise<RemoteSourceRebindResult> {
    signal?.throwIfAborted();
    const project_path = this.session_state.require_loaded_project_path();
    const previous = await this.require_binding(project_path);
    const ref = parse_novel_ref(url);
    if (ref.url === previous.url) {
      return {
        changed: false,
        previous: { url: previous.url, title: previous.title, kind: previous.kind },
        current: {
          url: previous.url,
          title: previous.title,
          kind: previous.kind,
          chapter_count: previous.chapter_count,
        },
        asset_path: previous.asset_path,
        text_matches: null,
      };
    }
    if (ref.kind !== "web") {
      throw new AppError("remote.rebind_unsupported", {
        public_details: { reason: "target_not_web", kind: ref.kind },
      });
    }
    const assets = await this.database.get_all_asset_records(project_path);
    const asset = assets.find((candidate) => candidate.path === previous.asset_path);
    if (asset === undefined) {
      throw new AppError("remote.source_not_bound", {
        public_details: { reason: "asset_missing", asset_path: previous.asset_path },
      });
    }
    if (previous.kind !== "web") {
      throw new AppError("remote.rebind_unsupported", {
        public_details: {
          reason: "wenku_single_channel",
          kind: previous.kind,
          asset_path: previous.asset_path,
        },
      });
    }
    if (asset.file_type !== "TXT") {
      throw new AppError("remote.rebind_unsupported", {
        public_details: {
          reason: asset.file_type === "EPUB" ? "epub_requires_import" : "asset_not_supported",
          asset_path: asset.path,
          file_type: asset.file_type,
        },
      });
    }
    const previous_ref = parse_novel_ref(previous.url);
    const previous_workspace = await call_with_credential_refresh(
      this.refresh_credentials,
      previous_ref.origin,
      () => this.client.read_workspace(previous_ref, signal),
    );
    const next_workspace = await call_with_credential_refresh(
      this.refresh_credentials,
      ref.origin,
      () => this.client.read_workspace(ref, signal),
    );
    const expected_chapters = previous_workspace.chapters.length;
    const actual_chapters = next_workspace.chapters.length;
    if (expected_chapters !== actual_chapters) {
      throw new AppError("remote.chapter_structure_mismatch", {
        public_details: {
          reason: "chapter_count_changed",
          previous_title: previous.title,
          current_title: next_workspace.title_zh ?? next_workspace.title_jp,
          expected: expected_chapters,
          actual: actual_chapters,
        },
      });
    }
    const download = await call_with_credential_refresh(this.refresh_credentials, ref.origin, () =>
      this.client.download(ref, signal),
    );
    signal?.throwIfAborted();
    const current_bytes = await this.database.read_asset_content(project_path, asset.path);
    if (current_bytes === null) {
      throw new AppError("remote.source_not_bound", {
        public_details: { reason: "asset_missing", asset_path: asset.path },
      });
    }
    const text_matches = remote_text_lines_match(current_bytes.toString("utf8"), download.text);
    const binding = build_remote_source_binding({
      ref,
      title: download.metadata.title,
      asset_path: asset.path,
      remote_hash: download.content_hash,
      chapter_count: actual_chapters,
      synced_at: new Date().toISOString(),
    });
    return await this.project_lock.run(project_path, async () => {
      signal?.throwIfAborted();
      const latest = await this.require_binding(project_path);
      if (!same_remote_source_identity(previous, latest)) {
        throw new AppError("remote.binding_changed", {
          public_details: {
            previous_url: previous.url,
            current_url: latest.url,
            asset_path: previous.asset_path,
          },
        });
      }
      const latest_assets = await this.database.get_all_asset_records(project_path);
      const latest_asset = latest_assets.find((candidate) => candidate.path === asset.path);
      if (latest_asset === undefined || latest_asset.file_type !== "TXT") {
        throw new AppError("remote.source_not_bound", {
          public_details: { reason: "asset_changed", asset_path: asset.path },
        });
      }
      await this.writer.bind_remote_source(
        { binding },
        options.under_agent === true ? { under_agent: true } : undefined,
      );
      try {
        this.snapshots.clear(project_path);
      } catch {
        // 清理失败只会留下与新绑定身份不匹配的旧快照；读取绑定后才会使用快照。
      }
      return {
        changed: true,
        previous: { url: previous.url, title: previous.title, kind: previous.kind },
        current: {
          url: binding.url,
          title: binding.title,
          kind: binding.kind,
          chapter_count: binding.chapter_count,
        },
        asset_path: binding.asset_path,
        text_matches,
      };
    });
  }

  /**
   * 下载整本并以上次同步文本（缺失时退化为当前资产）为基准生成差异。
   * 预览只保留一份内存暂存，应用时必须携带同一 stash_id。
   */
  public async preview_sync(signal?: AbortSignal): Promise<RemoteSyncPreview> {
    const project_path = this.session_state.require_loaded_project_path();
    const binding = await this.require_binding(project_path);
    const ref = parse_novel_ref(binding.url);
    const meta = await this.database.get_all_meta(project_path);
    const include_translations = read_project_language_settings(meta).target_language === "ZH";
    // 文库整本 EPUB 的章节身份来自分卷，必须先按文档级计划比对，不能下载 TXT 导出。
    if (ref.kind === "wenku" && (await this.read_asset_type(project_path, binding)) === "EPUB") {
      return await this.preview_wenku_epub_sync(project_path, binding, ref, signal);
    }
    const download = await this.client.download(ref, signal, {
      translations: include_translations,
    });
    return await this.project_lock.run(project_path, async () => {
      const current = await this.read_remote_context(project_path, binding);
      const snapshot = this.read_matching_snapshot(project_path, binding);
      const previous_text = snapshot?.text ?? current.text;
      const normalized =
        current.asset_type === "EPUB" ? normalize_remote_source_text(download.text) : null;
      const next_text = normalized?.text ?? download.text;
      const next_translations = include_translations
        ? normalized === null
          ? download.translations
          : remap_remote_translations(download.translations, normalized.raw_to_canonical)
        : undefined;
      const plan = align_remote_documents({
        previous_text,
        next_text,
        old_items: current.items,
        next_translations,
      });
      const created_at = Date.now();
      const id = random_id(16);
      this.sync_stash = {
        id,
        project_path,
        binding,
        ref,
        filename: download.filename,
        next_text,
        plan,
        epub_plans: null,
        asset_type: current.asset_type,
        current_asset_hash: current.hash,
        asset_hash: current.asset_hash,
        files_revision: current.files_revision,
        items_revision: current.items_revision,
        created_at,
      };
      const remote_hash = normalized === null ? download.content_hash : sha256_text(next_text);
      return {
        stash_id: id,
        created_at: new Date(created_at).toISOString(),
        expires_at: new Date(created_at + SYNC_STASH_TTL_MS).toISOString(),
        binding,
        filename: download.filename,
        remote_hash,
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

  private async read_asset_type(
    project_path: string,
    binding: RemoteSourceBinding,
  ): Promise<string | null> {
    const assets = await this.database.get_all_asset_records(project_path);
    return assets.find((asset) => asset.path === binding.asset_path)?.file_type ?? null;
  }

  /**
   * 文库整本 EPUB 预览：重新合并远端分卷，再按 `(分卷, 章节 id)` 与本地映射逐文档对齐。
   * 完整计划与“仅追加”计划同时生成，应用时按模式取用。
   */
  private async preview_wenku_epub_sync(
    project_path: string,
    binding: RemoteSourceBinding,
    ref: RemoteNovelRef,
    signal: AbortSignal | undefined,
  ): Promise<RemoteSyncPreview> {
    const metadata = await this.client.read_metadata(ref, signal);
    const pkg = await build_wenku_epub_package({
      ref,
      metadata,
      client: this.client,
      ...(signal === undefined ? {} : { signal }),
    });
    const remote = await read_wenku_epub_remote_package(pkg, pkg.filename);
    return await this.project_lock.run(project_path, async () => {
      const current = await this.read_remote_context(project_path, binding);
      if (current.asset_type !== "EPUB") {
        throw new AppError("remote.source_not_bound", {
          public_details: { reason: "asset_changed", asset_path: binding.asset_path },
        });
      }
      const meta = await this.database.get_all_meta(project_path);
      const map = read_remote_epub_map(meta[REMOTE_EPUB_MAP_META_KEY]);
      if (map === null) {
        throw new AppError("remote.epub_map_missing", {
          public_details: { asset_path: binding.asset_path },
        });
      }
      const local = await read_wenku_epub_local_package(current.bytes, binding.asset_path);
      const epub_plans = build_wenku_epub_sync_plans({
        local,
        old_items: current.items,
        map,
        remote,
        remote_bytes: pkg.bytes,
      });
      const { alignment } = epub_plans.full;
      const created_at = Date.now();
      const id = random_id(16);
      this.sync_stash = {
        id,
        project_path,
        binding,
        ref,
        filename: binding.asset_path,
        next_text: alignment.next.text,
        plan: alignment,
        epub_plans,
        asset_type: current.asset_type,
        current_asset_hash: current.hash,
        asset_hash: current.asset_hash,
        files_revision: current.files_revision,
        items_revision: current.items_revision,
        created_at,
      };
      return {
        stash_id: id,
        created_at: new Date(created_at).toISOString(),
        expires_at: new Date(created_at + SYNC_STASH_TTL_MS).toISOString(),
        binding,
        filename: binding.asset_path,
        remote_hash: sha256_text(alignment.next.text),
        previous_source: "current_asset",
        snapshot_available: false,
        current_asset_changed: false,
        stats: alignment.stats,
        chapters: alignment.chapters,
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
  public async apply_sync_request(
    body: JsonRecord,
    options: { under_agent?: boolean } = {},
  ): Promise<RemoteSyncApplyResult> {
    const mode = body["mode"];
    if (mode !== "add_only" && mode !== "auto" && mode !== "manual") {
      throw new AppError("request.validation_failed", { public_details: { field: "mode" } });
    }
    const stash_id = require_body_string(body, "stash_id");
    const stash = this.require_stash(stash_id);
    const overrides = normalize_sync_overrides(body["overrides"], mode, stash.plan);
    return await this.apply_sync({
      mode,
      stash_id,
      overrides,
      under_agent: options.under_agent === true,
    });
  }

  /** 界面提交要求运行时空闲；Agent 提交复用自身回合的写串行。 */
  private async replace_remote_asset(
    request: RemoteAssetReplaceRequest,
    under_agent: boolean,
  ): Promise<ProjectWriteResult> {
    return under_agent
      ? await this.writer.replace_remote_asset(request, { under_agent: true })
      : await this.writer.replace_remote_asset(request);
  }

  /**
   * 应用预览：先核对资产与修订未变化，再交给内容服务写入并原子更新快照。
   * add_only 以当前资产为基准重新对齐，其余模式沿用预览计划。
   */
  private async apply_sync(input: {
    mode: RemoteSyncMode;
    stash_id: string;
    overrides: ReadonlyMap<number, RemoteAssetRowOverride>;
    under_agent: boolean;
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
      if (current.hash !== stash.current_asset_hash || current.asset_hash !== stash.asset_hash) {
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
      if (stash.epub_plans !== null) {
        return await this.apply_wenku_epub_sync({
          mode: input.mode,
          stash,
          current,
          overrides: input.overrides,
          under_agent: input.under_agent,
          files_revision,
          items_revision,
        });
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
      const epub_asset =
        current.asset_type === "EPUB"
          ? await build_epub_remote_source({
              bytes: current.bytes,
              asset_path: binding.asset_path,
              plan: applied.plan,
              old_items: current.items,
            })
          : null;
      const write = await this.replace_remote_asset(
        {
          assetPath: binding.asset_path,
          content: applied.text,
          ...(epub_asset === null
            ? {}
            : {
                assetBytes: epub_asset.bytes,
                itemSeeds: epub_asset.content_seeds,
                fixedItemSeeds: epub_asset.fixed_seeds,
              }),
          binding,
          rows: applied.plan.rows,
          overrides: input.overrides,
          expectedSectionRevisions: {
            files: files_revision,
            items: items_revision,
          },
        },
        input.under_agent,
      );
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

  /**
   * 文库整本 EPUB 应用：按模式取文档级计划，写出合并包后连同章节映射一次提交。
   * `add_only` 只并入新增章节；退役与改写只发生在完整同步计划里。
   */
  private async apply_wenku_epub_sync(input: {
    mode: RemoteSyncMode;
    stash: SyncStash;
    current: { bytes: Uint8Array };
    overrides: ReadonlyMap<number, RemoteAssetRowOverride>;
    under_agent: boolean;
    files_revision: number;
    items_revision: number;
  }): Promise<RemoteSyncApplyResult> {
    const project_path = this.session_state.require_loaded_project_path();
    const plans = input.stash.epub_plans;
    if (plans === null) {
      throw new AppError("remote.stash_expired", {
        public_details: { reason: "missing_or_replaced" },
      });
    }
    if (input.mode === "auto" && plans.full.alignment.stats.requires_alignment) {
      throw new AppError("remote.alignment_required", {
        public_details: {
          would_lose: plans.full.alignment.stats.would_lose,
          total: plans.full.alignment.next.lines.length,
        },
      });
    }
    const plan = input.mode === "add_only" ? plans.add_only : plans.full;
    const asset = await apply_wenku_epub_sync_plan({
      bytes: input.current.bytes,
      rel_path: input.stash.binding.asset_path,
      plan,
    });
    const binding = build_remote_source_binding({
      ref: input.stash.ref,
      title: input.stash.binding.title,
      asset_path: input.stash.binding.asset_path,
      remote_hash: sha256_text(asset.text),
      chapter_count: asset.map.documents.filter((document) => document.state === "active").length,
      synced_at: new Date().toISOString(),
    });
    const write = await this.replace_remote_asset(
      {
        assetPath: binding.asset_path,
        content: asset.text,
        assetBytes: asset.bytes,
        itemSeeds: asset.content_seeds,
        fixedItemSeeds: asset.fixed_seeds,
        binding,
        rows: plan.alignment.rows,
        overrides: input.overrides,
        expectedSectionRevisions: {
          files: input.files_revision,
          items: input.items_revision,
        },
        extraMeta: { [REMOTE_EPUB_MAP_META_KEY]: asset.map as unknown as JsonValue },
      },
      input.under_agent,
    );
    try {
      this.snapshots.write(project_path, binding, asset.text);
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
      stats: plan.alignment.stats,
      chapters: plan.alignment.chapters,
      skipped_chapters: [],
    };
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
    bytes: Uint8Array;
    asset_type: string;
    asset_hash: string;
    files_revision: number;
    items_revision: number;
  }> {
    const assets = await this.database.get_all_asset_records(project_path);
    const asset = assets.find((candidate) => candidate.path === binding.asset_path);
    const bytes = await this.database.read_asset_content(project_path, binding.asset_path);
    if (asset === undefined || bytes === null) {
      throw new AppError("remote.source_not_bound", {
        public_details: { reason: "asset_missing", asset_path: binding.asset_path },
      });
    }
    const raw_items = await this.database.get_all_items(project_path);
    const asset_records = raw_items.filter((record) => record["file_path"] === binding.asset_path);
    const items: RemoteOldItem[] = [];
    let text: string;
    if (asset.file_type === "EPUB") {
      const source = await read_epub_remote_source(bytes, binding.asset_path);
      const records_by_row = new Map<number, JsonRecord>();
      for (const record of asset_records) {
        const row = record["row"];
        if (typeof row === "number" && Number.isSafeInteger(row)) records_by_row.set(row, record);
      }
      for (const [line_index, line] of source.lines.entries()) {
        const record = records_by_row.get(line.item.row);
        if (record === undefined) {
          throw new AppError("remote.source_not_bound", {
            public_details: { reason: "asset_changed", asset_path: binding.asset_path },
          });
        }
        items.push(to_remote_old_item(record, line_index, line.text));
      }
      text = source.text;
    } else {
      text = bytes.toString("utf8");
      for (const record of asset_records) {
        const row = record["row"];
        if (typeof row !== "number" || !Number.isSafeInteger(row)) continue;
        items.push(to_remote_old_item(record, row, String(record["src"] ?? "")));
      }
    }
    const meta = await this.database.get_all_meta(project_path);
    const revisions = build_section_revisions_from_meta(meta);
    return {
      text,
      hash: sha256_text(text),
      items,
      bytes,
      asset_type: asset.file_type,
      asset_hash: sha256_bytes(bytes),
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
      const normalized =
        stash.asset_type === "EPUB" ? normalize_remote_source_text(appended.text) : null;
      const next_text = normalized?.text ?? appended.text;
      const plan = align_remote_documents({
        previous_text: current.text,
        next_text,
        old_items: current.items,
        next_translations:
          normalized === null
            ? appended.translations
            : remap_remote_translations(appended.translations, normalized.raw_to_canonical),
      });
      return { text: next_text, plan, skipped_chapters: appended.skipped };
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

function sha256_bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function to_remote_old_item(record: JsonRecord, row: number, src: string): RemoteOldItem {
  const item_id = record["id"];
  if (typeof item_id !== "number" || !Number.isSafeInteger(item_id)) {
    throw new AppError("remote.source_not_bound", {
      public_details: { reason: "asset_changed" },
    });
  }
  return {
    item_id,
    row,
    src,
    dst: String(record["dst"] ?? ""),
    name_dst: (record["name_dst"] ?? null) as ItemNameField,
    status: String(record["status"] ?? "NONE") as ItemStatus,
    extra_field: (record["extra_field"] ?? "") as JsonValue,
  };
}

/** 站点译文按原始行号返回，规范化后必须同步转键，避免 EPUB 复用译文错行。 */
function remap_remote_translations(
  translations: ReadonlyMap<number, string>,
  raw_to_canonical: ReadonlyMap<number, number>,
): Map<number, string> {
  const result = new Map<number, string>();
  for (const [raw_row, dst] of translations) {
    const row = raw_to_canonical.get(raw_row);
    if (row !== undefined) result.set(row, dst);
  }
  return result;
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
    remote_dst: row.remote_dst,
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
