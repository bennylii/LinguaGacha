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

/** 绑定身份排除标题、哈希和同步时间；等待期间只允许这些派生字段变化。 */
export function same_remote_source_identity(
  left: RemoteSourceBinding,
  right: RemoteSourceBinding,
): boolean {
  return (
    left.origin === right.origin &&
    left.kind === right.kind &&
    left.provider_id === right.provider_id &&
    left.novel_id === right.novel_id &&
    left.url === right.url &&
    left.asset_path === right.asset_path
  );
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

/** 文库整本 EPUB 的章节映射键：站点章节 id 只在卷内唯一，必须与分卷一起索引。 */
export const REMOTE_EPUB_MAP_META_KEY = "remote_epub_map";

export type RemoteEpubDocumentState = "active" | "retired";

export interface RemoteEpubMapVolume {
  volume_id: string;
  volume_title: string;
  prefix: string;
}

/** 站点章节与合并包文档的稳定对应关系；行号不落库，始终由资产字节重算。 */
export interface RemoteEpubMapDocument {
  chapter_id: string;
  volume_id: string;
  /** 分卷包内路径，用于说明章节来自哪个源文档。 */
  source_doc_path: string;
  /** 合并包内路径；缺失表示文档已从资产移除（当前流程不会移除）。 */
  doc_path: string;
  title: string;
  /** 源卷是否把它排进 spine；退役后按该值恢复线性阅读顺序。 */
  linear: boolean;
  state: RemoteEpubDocumentState;
}

export interface RemoteEpubMap {
  version: 1;
  volumes: RemoteEpubMapVolume[];
  documents: RemoteEpubMapDocument[];
}

export function build_epub_document_key(volume_id: string, chapter_id: string): string {
  return `${volume_id}\u0000${chapter_id}`;
}

/**
 * 映射由合并结果生成一次，之后只随同步更新；
 * 站点章节 id 依赖 manifest 原始 href，无法从规范化后的包内路径反推。
 */
export function build_remote_epub_map(input: {
  volumes: readonly RemoteEpubMapVolume[];
  documents: readonly RemoteEpubMapDocument[];
}): RemoteEpubMap {
  return {
    version: 1,
    volumes: input.volumes.map((volume) => ({ ...volume })),
    documents: input.documents.map((document) => ({ ...document })),
  };
}

/**
 * 只接受结构完整且自洽的映射：损坏或手工改写的映射按缺失处理，
 * 由调用方要求重新导入，避免用错误章节身份发起同步或上传。
 */
export function read_remote_epub_map(value: JsonValue | undefined): RemoteEpubMap | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, JsonValue>;
  if (record["version"] !== 1) return null;
  const raw_volumes = record["volumes"];
  const raw_documents = record["documents"];
  if (!Array.isArray(raw_volumes) || !Array.isArray(raw_documents)) return null;

  const volumes: RemoteEpubMapVolume[] = [];
  const volume_ids = new Set<string>();
  for (const entry of raw_volumes) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const item = entry as Record<string, JsonValue>;
    const volume_id = read_string(item, "volume_id");
    const volume_title = read_string(item, "volume_title", true);
    const prefix = read_string(item, "prefix");
    if (volume_id === null || volume_title === null || prefix === null) return null;
    if (volume_ids.has(volume_id)) return null;
    volume_ids.add(volume_id);
    volumes.push({ volume_id, volume_title, prefix });
  }

  const documents: RemoteEpubMapDocument[] = [];
  const keys = new Set<string>();
  for (const entry of raw_documents) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const item = entry as Record<string, JsonValue>;
    const chapter_id = read_string(item, "chapter_id");
    const volume_id = read_string(item, "volume_id");
    const source_doc_path = read_string(item, "source_doc_path");
    const doc_path = read_string(item, "doc_path");
    const title = read_string(item, "title", true);
    const linear = item["linear"];
    const state = item["state"];
    if (
      chapter_id === null ||
      volume_id === null ||
      source_doc_path === null ||
      doc_path === null ||
      title === null ||
      typeof linear !== "boolean" ||
      (state !== "active" && state !== "retired")
    ) {
      return null;
    }
    if (!volume_ids.has(volume_id)) return null;
    const key = build_epub_document_key(volume_id, chapter_id);
    if (keys.has(key)) return null;
    keys.add(key);
    documents.push({ chapter_id, volume_id, source_doc_path, doc_path, title, linear, state });
  }
  return { version: 1, volumes, documents };
}
