import type { JsonValue } from "../../domain/json";
import {
  NOVELIA_HOSTS,
  normalize_novel_origin,
  type RemoteNovelKind,
  type RemoteNovelRef,
} from "./novelia-source";

/** 工程 meta 中记录远端绑定的唯一键；缺失表示本地工程。 */
export const REMOTE_SOURCE_META_KEY = "remote_source";

/**
 * 远程绑定保存作品身份与最近一次同步事实。
 * 资产正文仍以 .lg 内 TXT 为准，绑定只说明它来自哪里、属于哪个版本。
 */
export interface RemoteSourceBinding {
  origin: string;
  host: string;
  kind: RemoteNovelKind;
  provider_id: string;
  novel_id: string;
  url: string;
  title: string;
  asset_path: string;
  remote_hash: string;
  chapter_count: number;
  synced_at: string;
}

export interface BuildRemoteSourceBindingInput {
  ref: RemoteNovelRef;
  title: string;
  asset_path: string;
  remote_hash: string;
  chapter_count: number;
  synced_at: string;
}

/** 由站点解析结果生成绑定；字段名称与 API 载荷保持一致。 */
export function build_remote_source_binding(
  input: BuildRemoteSourceBindingInput,
): RemoteSourceBinding {
  return {
    origin: input.ref.origin,
    host: input.ref.host,
    kind: input.ref.kind,
    provider_id: input.ref.provider_id,
    novel_id: input.ref.novel_id,
    url: input.ref.url,
    title: input.title,
    asset_path: input.asset_path,
    remote_hash: input.remote_hash,
    chapter_count: input.chapter_count,
    synced_at: input.synced_at,
  };
}

/**
 * 只接受结构完整且与规范地址一致的绑定。
 * 损坏或被手工改写的 meta 按未绑定处理，避免以错误身份发起远端请求。
 */
export function read_remote_source_binding(
  value: JsonValue | undefined,
): RemoteSourceBinding | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, JsonValue>;
  const kind = record["kind"];
  if (kind !== "web" && kind !== "wenku") return null;
  const origin = read_string(record, "origin");
  const host = read_string(record, "host");
  const provider_id = read_string(record, "provider_id", true);
  const novel_id = read_string(record, "novel_id");
  const url = read_string(record, "url");
  const title = read_string(record, "title", true);
  const asset_path = read_string(record, "asset_path");
  const remote_hash = read_string(record, "remote_hash");
  const synced_at = read_string(record, "synced_at");
  const chapter_count = record["chapter_count"];
  if (
    origin === null ||
    host === null ||
    provider_id === null ||
    novel_id === null ||
    url === null ||
    title === null ||
    asset_path === null ||
    remote_hash === null ||
    synced_at === null ||
    typeof chapter_count !== "number" ||
    !Number.isSafeInteger(chapter_count) ||
    chapter_count < 1
  ) {
    return null;
  }
  if (normalize_novel_origin(origin) !== origin) return null;
  if (!(NOVELIA_HOSTS as readonly string[]).includes(host)) return null;
  if (kind === "web" && provider_id === "") return null;
  if (!/^[0-9a-f]{64}$/u.test(remote_hash)) return null;
  return {
    origin,
    host,
    kind,
    provider_id,
    novel_id,
    url,
    title,
    asset_path,
    remote_hash,
    chapter_count,
    synced_at,
  };
}

function read_string(
  record: Record<string, JsonValue>,
  key: string,
  allow_empty = false,
): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  if (!allow_empty && value.trim() === "") return null;
  return value;
}
