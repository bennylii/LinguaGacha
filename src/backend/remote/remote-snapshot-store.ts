import { createHash } from "node:crypto";
import path from "node:path";

import type { AppPathService } from "../app/app-path-service";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import { JsonTool } from "../../shared/utils/json-tool";
import { AppError } from "../../shared/error/app-error";
import { REMOTE_NOVEL_MAX_BYTES, sha256_text, type RemoteNovelKind } from "./novelia-source";

const SNAPSHOT_DIRECTORY = "remote";
const SNAPSHOT_DIRECTORY_NAME = "snapshots";
const SNAPSHOT_VERSION = 1;

/** 快照只记录作品身份与上次下载文本，不保存 token 或条目译文。 */
export interface RemoteSnapshotKey {
  origin: string;
  kind: RemoteNovelKind;
  provider_id: string;
  novel_id: string;
}

export interface RemoteSnapshot {
  key: RemoteSnapshotKey;
  text: string;
  content_hash: string;
  updated_at: string;
}

interface SnapshotMetadata {
  version: number;
  project_path: string;
  remote: RemoteSnapshotKey;
  content_hash: string;
  size: number;
  updated_at: string;
}

export interface RemoteSnapshotStoreOptions {
  paths: Pick<AppPathService, "get_user_data_path">;
  native_fs?: NativeFs;
  platform?: NodeJS.Platform;
}

/**
 * 上次同步文本按工程路径散列存放，供下一次下载做章节与行级 diff。
 * 文本与元数据分文件保存，写入顺序保证失败时旧快照仍然完整。
 */
export class RemoteSnapshotStore {
  private readonly paths: RemoteSnapshotStoreOptions["paths"];
  private readonly native_fs: NativeFs;
  private readonly platform: NodeJS.Platform;

  public constructor(options: RemoteSnapshotStoreOptions) {
    this.paths = options.paths;
    this.native_fs = options.native_fs ?? default_native_fs;
    this.platform = options.platform ?? process.platform;
  }

  /** 缺失、损坏或哈希不一致都按没有快照处理，调用方回退到当前工程源文。 */
  public read(project_path: string): RemoteSnapshot | null {
    const key = this.build_key(project_path);
    const metadata_path = this.get_metadata_path(key);
    const text_path = this.get_text_path(key);
    if (!this.native_fs.exists(metadata_path) || !this.native_fs.exists(text_path)) return null;
    let metadata: SnapshotMetadata;
    try {
      metadata = parse_metadata(JsonTool.parseStrict(this.native_fs.read_file(metadata_path)));
    } catch {
      return null;
    }
    if (metadata.project_path !== this.normalize_project_path(project_path)) return null;
    if (metadata.size > REMOTE_NOVEL_MAX_BYTES) return null;
    const text = this.native_fs.read_text_file(text_path);
    if (sha256_text(text) !== metadata.content_hash) return null;
    return {
      key: metadata.remote,
      text,
      content_hash: metadata.content_hash,
      updated_at: metadata.updated_at,
    };
  }

  /** 先原子替换文本，再原子替换元数据；元数据失败时下次写入会覆盖孤儿文本。 */
  public write(project_path: string, key: RemoteSnapshotKey, text: string): RemoteSnapshot {
    const size = Buffer.byteLength(text, "utf8");
    if (size > REMOTE_NOVEL_MAX_BYTES) {
      throw new AppError("remote.fetch_failed", {
        message: "The remote snapshot exceeds the size limit.",
        public_details: { max_bytes: REMOTE_NOVEL_MAX_BYTES },
      });
    }
    const file_key = this.build_key(project_path);
    const metadata: SnapshotMetadata = {
      version: SNAPSHOT_VERSION,
      project_path: this.normalize_project_path(project_path),
      remote: { ...key },
      content_hash: sha256_text(text),
      size,
      updated_at: new Date().toISOString(),
    };
    this.native_fs.write_file_atomic(this.get_text_path(file_key), text);
    this.native_fs.write_file_atomic(
      this.get_metadata_path(file_key),
      JsonTool.stringifyStrict(metadata, { indent: 4 }),
    );
    return {
      key: { ...key },
      text,
      content_hash: metadata.content_hash,
      updated_at: metadata.updated_at,
    };
  }

  /** 清理失败不阻断同步主流程，孤儿文件会在下次写入时被替换。 */
  public clear(project_path: string): void {
    const file_key = this.build_key(project_path);
    this.native_fs.unlink(this.get_text_path(file_key), { force: true });
    this.native_fs.unlink(this.get_metadata_path(file_key), { force: true });
  }

  private build_key(project_path: string): string {
    return createHash("sha256")
      .update(this.normalize_project_path(project_path), "utf8")
      .digest("hex")
      .slice(0, 32);
  }

  /** Windows 路径大小写不敏感，散列前统一大小写避免同一工程产生两份快照。 */
  private normalize_project_path(project_path: string): string {
    const resolved = path.resolve(project_path);
    return this.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  private get_directory(): string {
    return this.paths.get_user_data_path(SNAPSHOT_DIRECTORY, SNAPSHOT_DIRECTORY_NAME);
  }

  private get_text_path(file_key: string): string {
    return path.join(this.get_directory(), `${file_key}.txt`);
  }

  private get_metadata_path(file_key: string): string {
    return path.join(this.get_directory(), `${file_key}.json`);
  }
}

function parse_metadata(value: unknown): SnapshotMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("remote.fetch_failed");
  }
  const record = value as Record<string, unknown>;
  if (record["version"] !== SNAPSHOT_VERSION) throw new AppError("remote.fetch_failed");
  const remote = record["remote"];
  if (typeof remote !== "object" || remote === null || Array.isArray(remote)) {
    throw new AppError("remote.fetch_failed");
  }
  const remote_record = remote as Record<string, unknown>;
  const kind = remote_record["kind"];
  if (kind !== "web" && kind !== "wenku") throw new AppError("remote.fetch_failed");
  return {
    version: SNAPSHOT_VERSION,
    project_path: require_string(record, "project_path"),
    remote: {
      origin: require_string(remote_record, "origin"),
      kind,
      provider_id: require_string(remote_record, "provider_id"),
      novel_id: require_string(remote_record, "novel_id"),
    },
    content_hash: require_string(record, "content_hash"),
    size: require_number(record, "size"),
    updated_at: require_string(record, "updated_at"),
  };
}

function require_string(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new AppError("remote.fetch_failed");
  return value;
}

function require_number(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError("remote.fetch_failed");
  }
  return value;
}
