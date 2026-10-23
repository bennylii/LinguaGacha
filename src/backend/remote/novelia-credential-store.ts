import type { AppPathService } from "../app/app-path-service";
import { JsonTool } from "../../shared/utils/json-tool";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import { AppError } from "../../shared/error/app-error";
import { normalize_novel_origin } from "./novelia-source";

const AUTH_DIRECTORY = "auth";
const AUTH_FILE_NAME = "novelia.json";
const MAX_TOKEN_LENGTH = 8192;

export type NoveliaCredentialSource = "bridge" | "manual";

export interface NoveliaCredentialStatus {
  origin: string;
  token_tail: string; // 只公开末位，界面用于确认同步的是哪一份凭据
  updated_at: string;
  source: NoveliaCredentialSource;
}

interface StoredCredential {
  token: string;
  updated_at: string;
  source: NoveliaCredentialSource;
}

interface StoredAuthFile {
  origins: Record<string, StoredCredential>;
}

export interface NoveliaCredentialStoreOptions {
  paths: Pick<AppPathService, "get_user_data_path">;
  native_fs?: NativeFs;
}

/**
 * 站点凭据按规范化 origin 保存在 userdata/auth/novelia.json。
 * 多实例共享同一文件，读取不做进程缓存，写入使用原子替换。
 */
export class NoveliaCredentialStore {
  private readonly paths: NoveliaCredentialStoreOptions["paths"];
  private readonly native_fs: NativeFs;

  public constructor(options: NoveliaCredentialStoreOptions) {
    this.paths = options.paths;
    this.native_fs = options.native_fs ?? default_native_fs;
  }

  /** 请求期读取当前 token；外部实例刚写入的凭据也能立即生效。 */
  public read_token(origin: string): string | null {
    const normalized = normalize_novel_origin(origin);
    if (normalized === null) return null;
    return this.read_file().origins[normalized]?.token ?? null;
  }

  /** 手动导入与桥接推送共用的唯一写入口。 */
  public save_token(input: {
    origin: string;
    raw_token: string;
    source: NoveliaCredentialSource;
  }): NoveliaCredentialStatus {
    const origin = normalize_novel_origin(input.origin);
    if (origin === null) {
      throw new AppError("request.validation_failed", { public_details: { field: "origin" } });
    }
    const token = extract_novelia_token(input.raw_token);
    if (token === null) {
      throw new AppError("request.validation_failed", { public_details: { field: "token" } });
    }
    const file = this.read_file();
    const credential: StoredCredential = {
      token,
      updated_at: new Date().toISOString(),
      source: input.source,
    };
    file.origins[origin] = credential;
    this.write_file(file);
    return to_status(origin, credential);
  }

  /** 省略 origin 时清空全部站点凭据；返回清除后的状态列表。 */
  public clear(origin?: string): NoveliaCredentialStatus[] {
    const file = this.read_file();
    if (origin === undefined) {
      file.origins = {};
    } else {
      const normalized = normalize_novel_origin(origin);
      if (normalized === null) {
        throw new AppError("request.validation_failed", { public_details: { field: "origin" } });
      }
      delete file.origins[normalized];
    }
    this.write_file(file);
    return this.list();
  }

  /** 凭据状态只暴露尾号与更新时间，任何路径都不返回明文 token。 */
  public list(): NoveliaCredentialStatus[] {
    return Object.entries(this.read_file().origins)
      .map(([origin, credential]) => to_status(origin, credential))
      .sort((left, right) => left.origin.localeCompare(right.origin));
  }

  private get_file_path(): string {
    return this.paths.get_user_data_path(AUTH_DIRECTORY, AUTH_FILE_NAME);
  }

  /** 文件缺失或损坏时按无凭据处理，避免设置页或同步因历史残留完全不可用。 */
  private read_file(): StoredAuthFile {
    const file_path = this.get_file_path();
    if (!this.native_fs.exists(file_path)) return { origins: {} };
    let payload: unknown;
    try {
      payload = JsonTool.parseStrict(this.native_fs.read_file(file_path)) as unknown;
    } catch {
      return { origins: {} };
    }
    if (!is_record(payload)) return { origins: {} };
    const raw_origins = payload["origins"];
    if (!is_record(raw_origins)) return { origins: {} };
    const origins: Record<string, StoredCredential> = {};
    for (const [raw_origin, raw_credential] of Object.entries(raw_origins)) {
      const origin = normalize_novel_origin(raw_origin);
      if (origin === null || !is_record(raw_credential)) continue;
      const raw_token = raw_credential["token"];
      const token = typeof raw_token === "string" ? extract_novelia_token(raw_token) : null;
      if (token === null) continue;
      const source = raw_credential["source"] === "bridge" ? "bridge" : "manual";
      const updated_at =
        typeof raw_credential["updated_at"] === "string" ? raw_credential["updated_at"] : "";
      origins[origin] = { token, updated_at, source };
    }
    return { origins };
  }

  private write_file(file: StoredAuthFile): void {
    this.native_fs.write_file_atomic(
      this.get_file_path(),
      JsonTool.stringifyStrict(file, { indent: 4 }),
    );
  }
}

/** 提取 token 尾号；过短的 token 不暴露任何字符。 */
function to_status(origin: string, credential: StoredCredential): NoveliaCredentialStatus {
  return {
    origin,
    token_tail: credential.token.length <= 8 ? "****" : credential.token.slice(-4),
    updated_at: credential.updated_at,
    source: credential.source,
  };
}

/**
 * 接受原始 JWT、`Bearer` 前缀、auth-v2 JSON、旧 auth.profile 结构与常见 Cookie 串。
 * 任何输入都只保留 token 本体，不接受空白或超长内容。
 */
export function extract_novelia_token(raw: string, depth = 0): string | null {
  if (depth > 3) return null;
  let value = raw.trim();
  if (value === "") return null;
  if (value.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(value);
      const token = read_token_from_record(parsed, depth);
      if (token !== null) return token;
    } catch {
      // JSON 解析失败后继续按普通 token 处理。
    }
    // 看起来是 JSON 却没有可提取字段时不能把整段内容当作 token。
    return null;
  }
  const looks_like_cookie =
    value.includes("=") &&
    (value.includes(";") || /^(?:auth-v2|auth|token|access_token|access-token)\s*=/iu.test(value));
  if (looks_like_cookie) {
    const token = read_token_from_cookies(value, depth);
    if (token !== null) return token;
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") value = parsed.trim();
    } catch {
      return null;
    }
  }
  value = value.replace(/^bearer\s+/iu, "").trim();
  if (value === "" || value.length > MAX_TOKEN_LENGTH || /\s/u.test(value)) return null;
  return value;
}

function read_token_from_record(value: unknown, depth: number): string | null {
  if (!is_record(value)) return null;
  for (const key of ["token", "access_token", "accessToken"]) {
    const direct = value[key];
    if (typeof direct === "string") {
      const token = extract_novelia_token(direct, depth + 1);
      if (token !== null) return token;
    }
  }
  const profile = value["profile"];
  if (is_record(profile)) return read_token_from_record(profile, depth + 1);
  return null;
}

function read_token_from_cookies(value: string, depth: number): string | null {
  for (const part of value.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim().toLowerCase();
    if (!["auth-v2", "auth", "token", "access_token", "access-token"].includes(name)) continue;
    let decoded = part.slice(separator + 1).trim();
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // 保留原值继续尝试。
    }
    const token = extract_novelia_token(decoded, depth + 1);
    if (token !== null) return token;
  }
  return null;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
