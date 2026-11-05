import type { AppPathService } from "../app/app-path-service";
import { JsonTool } from "../../shared/utils/json-tool";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import { AppError } from "../../shared/error/app-error";
import { normalize_novel_origin } from "./novelia-source";

const AUTH_DIRECTORY = "auth";
const AUTH_FILE_NAME = "novelia.json";
const MAX_TOKEN_LENGTH = 8192;

export type NoveliaCredentialSource = "bridge" | "manual" | "login";
const CREDENTIAL_SOURCES: readonly NoveliaCredentialSource[] = ["bridge", "manual", "login"];

export interface NoveliaCredentialStatus {
  origin: string;
  token_tail: string; // 只公开末位，界面用于确认同步的是哪一份凭据
  updated_at: string;
  source: NoveliaCredentialSource;
  expired: boolean; // 登录来源续期失败后的标记，提示重新登录
}

/** 请求期凭据：Bearer token 与可选的 auth 域 Cookie 串。 */
export interface NoveliaCredential {
  token: string;
  cookie: string;
}

interface StoredCredential {
  token: string;
  cookie: string;
  updated_at: string;
  source: NoveliaCredentialSource;
  expired: boolean;
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
    return this.read_credential(origin)?.token ?? null;
  }

  /** 请求期读取完整凭据；token 与 Cookie 一起供客户端注入请求头。 */
  public read_credential(origin: string): NoveliaCredential | null {
    const normalized = normalize_novel_origin(origin);
    if (normalized === null) return null;
    const credential = this.read_file().origins[normalized];
    if (credential === undefined) return null;
    return { token: credential.token, cookie: credential.cookie };
  }

  /** 手动导入、桥接推送与登录续期共用的唯一写入口；cookie 仅登录链路提供。 */
  public save_token(input: {
    origin: string;
    raw_token: string;
    cookie?: string;
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
    // 重新保存（含续期成功）视为凭据恢复有效。
    const credential: StoredCredential = {
      token,
      cookie: input.cookie?.trim() ?? "",
      updated_at: new Date().toISOString(),
      source: input.source,
      expired: false,
    };
    file.origins[origin] = credential;
    this.write_file(file);
    return to_status(origin, credential);
  }

  /** 续期失败时只打过期标记，不删除凭据；恢复有效由 save_token 完成。 */
  public mark_expired(origin: string, expired: boolean): void {
    const normalized = normalize_novel_origin(origin);
    if (normalized === null) {
      throw new AppError("request.validation_failed", { public_details: { field: "origin" } });
    }
    const file = this.read_file();
    const credential = file.origins[normalized];
    if (credential === undefined || credential.expired === expired) return;
    file.origins[normalized] = { ...credential, expired };
    this.write_file(file);
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
      const raw_source = raw_credential["source"];
      const source =
        typeof raw_source === "string" &&
        (CREDENTIAL_SOURCES as readonly string[]).includes(raw_source)
          ? (raw_source as NoveliaCredentialSource)
          : "manual";
      const raw_cookie = raw_credential["cookie"];
      origins[origin] = {
        token,
        cookie: typeof raw_cookie === "string" ? raw_cookie : "",
        updated_at:
          typeof raw_credential["updated_at"] === "string" ? raw_credential["updated_at"] : "",
        source,
        expired: raw_credential["expired"] === true,
      };
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
    expired: credential.expired,
  };
}

export interface NoveliaTokenPayload {
  sub: string;
  iat: number; // 签发时间（秒），续期冷却的判定依据
  exp: number; // 过期时间（秒），仅用于状态显示
}

/**
 * 只解码 JWT payload 用于调度与状态显示，不验证签名；
 * 解析失败或缺少关键字段时返回 null，调用方按无载荷处理。
 */
export function decode_novelia_token_payload(token: string): NoveliaTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (!is_record(parsed)) return null;
    const iat = read_seconds(parsed["iat"]);
    const exp = read_seconds(parsed["exp"]);
    if (iat === null || exp === null || typeof parsed["sub"] !== "string" || parsed["sub"] === "") {
      return null;
    }
    return { sub: parsed["sub"], iat, exp };
  } catch {
    return null;
  }
}

function read_seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
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
