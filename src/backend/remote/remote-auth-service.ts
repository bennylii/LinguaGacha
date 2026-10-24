import type { JsonRecord, JsonValue } from "../../domain/json";
import { normalize_setting_snapshot } from "../../domain/setting";
import type { AppSettingService } from "../app/app-setting-service";
import { AppError } from "../../shared/error/app-error";
import { derive_novelia_auth_origin, type RemoteAuthHost } from "../../shared/remote-auth-host";
import type { NoveliaAuthBridge, NoveliaAuthBridgeStatus } from "./novelia-auth-bridge";
import {
  decode_novelia_token_payload,
  type NoveliaCredentialSource,
  type NoveliaCredentialStatus,
  type NoveliaCredentialStore,
} from "./novelia-credential-store";

export const DEFAULT_NOVELIA_ORIGIN = "https://n.novelia.cc";

export interface RemoteAuthSnapshot {
  default_origin: string;
  origins: NoveliaCredentialStatus[];
  bridge: {
    enabled: boolean;
    status: NoveliaAuthBridgeStatus;
  };
  login: {
    running: boolean;
    origin: string | null;
    started_at: string | null;
  };
}

export interface RemoteAuthServiceOptions {
  credentials: NoveliaCredentialStore;
  bridge: NoveliaAuthBridge;
  settings: Pick<AppSettingService, "read_setting">;
  /** 内嵌登录窗口与续期宿主；CLI 缺席时登录拒绝、续期停用。 */
  auth_host?: RemoteAuthHost | undefined;
}

const LOGIN_ATTEMPT_TIMEOUT_MS = 5 * 60_000;
const REFRESH_CHECK_INTERVAL_MS = 15 * 60_000;
// 与站点前端一致：token 签发超过 1 小时才有续期价值，成功续期后 1 小时内不再重复。
const REFRESH_COOLDOWN_SECONDS = 3_600;

interface LoginAttempt {
  origin: string;
  started_at: number;
  controller: AbortController;
  timeout: NodeJS.Timeout;
}

/**
 * 凭据导入、桥接开关、登录窗口与 token 自动续期的应用层入口。
 * token 只经过凭据存储，本服务只返回末位与更新时间。
 */
export class RemoteAuthService {
  private readonly credentials: NoveliaCredentialStore;
  private readonly bridge: NoveliaAuthBridge;
  private readonly settings: Pick<AppSettingService, "read_setting">;
  private readonly auth_host: RemoteAuthHost | null;
  private login_attempt: LoginAttempt | null = null;
  private readonly last_refresh_at = new Map<string, number>();
  private refresh_timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(snapshot: RemoteAuthSnapshot) => void>();

  /** 凭据与登录状态变化推送给事件层；载荷与 snapshot() 一致。 */
  public subscribe(listener: (snapshot: RemoteAuthSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public constructor(options: RemoteAuthServiceOptions) {
    this.credentials = options.credentials;
    this.bridge = options.bridge;
    this.settings = options.settings;
    this.auth_host = options.auth_host ?? null;
  }

  /** 应用启动后按设置决定是否监听；端口失败只体现在状态里。 */
  public async start(): Promise<void> {
    this.ensure_refresh_timer();
    if (this.is_bridge_enabled()) await this.bridge.start();
    // 启动即查：登录来源的凭据立刻尝试一次续期，失败不打断启动。
    void this.refresh_login_credentials();
  }

  /** 设置保存后立即生效；关闭开关会释放本地端口。 */
  public async apply_setting(): Promise<void> {
    this.ensure_refresh_timer();
    if (this.is_bridge_enabled()) await this.bridge.start();
    else await this.bridge.stop();
  }

  public snapshot(): RemoteAuthSnapshot {
    const value: RemoteAuthSnapshot = {
      default_origin: DEFAULT_NOVELIA_ORIGIN,
      origins: this.credentials.list(),
      bridge: {
        enabled: this.is_bridge_enabled(),
        status: this.bridge.get_status(),
      },
      login: {
        running: this.login_attempt !== null,
        origin: this.login_attempt?.origin ?? null,
        started_at:
          this.login_attempt === null
            ? null
            : new Date(this.login_attempt.started_at).toISOString(),
      },
    };
    for (const listener of this.listeners) listener(value);
    return value;
  }

  /** 手动粘贴支持 token、Cookie 串与旧版 localStorage JSON。 */
  public import(body: JsonRecord): RemoteAuthSnapshot {
    const origin = read_origin(body["origin"]) ?? DEFAULT_NOVELIA_ORIGIN;
    const token = body["token"];
    if (typeof token !== "string" || token.trim() === "") {
      throw new AppError("request.validation_failed", { public_details: { field: "token" } });
    }
    this.credentials.save_token({
      origin,
      raw_token: token,
      source: read_source(body["source"]) ?? "manual",
    });
    return this.snapshot();
  }

  /** 指定 origin 时只清除该站点，否则清空全部凭据。 */
  public clear(body: JsonRecord): RemoteAuthSnapshot {
    const origin = read_origin(body["origin"]);
    this.credentials.clear(origin ?? undefined);
    return this.snapshot();
  }

  /**
   * 用户名密码登录：宿主打开 auth.novelia.cc 登录窗口并轮询续期端点，
   * 登录成功（或取消/超时）后回包；成功才落盘凭据。
   */
  public async login(body: JsonRecord): Promise<RemoteAuthSnapshot> {
    const origin = read_origin(body["origin"]) ?? DEFAULT_NOVELIA_ORIGIN;
    if (this.auth_host === null) {
      throw new AppError("remote.window_unsupported", {
        public_details: { reason: "login_window_unavailable" },
      });
    }
    if (this.login_attempt !== null) throw new AppError("remote.login_in_progress");
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("remote login timeout")),
      LOGIN_ATTEMPT_TIMEOUT_MS,
    );
    timeout.unref?.();
    const started_at = Date.now();
    this.login_attempt = { origin, started_at, controller, timeout };
    try {
      const result = await this.auth_host(
        {
          kind: "open_remote_login_window",
          url: build_auth_login_url(origin, body["theme"] === "dark" ? "dark" : "light"),
          origin,
        },
        controller.signal,
      );
      if (result.status === "succeeded") {
        const previous = this.credentials.read_credential(origin);
        this.credentials.save_token({
          origin,
          raw_token: result.token,
          // 宿主只采集站点域 Cookie；空回包时保留旧 Cookie，避免误清登录态。
          cookie: result.cookie.trim() !== "" ? result.cookie : (previous?.cookie ?? ""),
          source: "login",
        });
        this.last_refresh_at.set(origin, Date.now());
      }
    } finally {
      clearTimeout(timeout);
      this.login_attempt = null;
    }
    return this.snapshot();
  }

  /** 用户或界面取消当前登录窗口；没有进行中的登录时静默返回快照。 */
  public async cancel_login(): Promise<RemoteAuthSnapshot> {
    if (this.login_attempt !== null)
      this.login_attempt.controller.abort(new Error("remote login cancelled"));
    return this.snapshot();
  }

  /**
   * 续期登录来源的 Bearer token。遵守 1 小时冷却，`force` 供收到 401 后立即重试。
   * 返回 token 是否发生了更新；会话失效时打过期标记，不删除凭据。
   */
  public async try_refresh(origin: string, options: { force?: boolean } = {}): Promise<boolean> {
    if (this.auth_host === null) return false;
    const previous = this.credentials.read_credential(origin);
    const payload = previous === null ? null : decode_novelia_token_payload(previous.token);
    // 只续期登录链路的凭据；手动/桥接凭据没有续期会话。
    if (previous === null || payload === null || !this.is_login_sourced(origin)) return false;
    const now_seconds = Date.now() / 1000;
    if (!options.force && now_seconds - payload.iat < REFRESH_COOLDOWN_SECONDS) return false;
    const result = await this.auth_host({
      kind: "remote_auth_refresh",
      url: build_auth_refresh_url(origin),
      origin,
    });
    if (result.status !== "succeeded") {
      if (result.status === "unauthorized") this.credentials.mark_expired(origin, true);
      return false;
    }
    this.credentials.save_token({
      origin,
      raw_token: result.token,
      cookie: result.cookie.trim() !== "" ? result.cookie : previous.cookie,
      source: "login",
    });
    this.last_refresh_at.set(origin, Date.now());
    return true;
  }

  /** 关闭时停止续期与监听；凭据文件保留，重新启用后立即可用。 */
  public async dispose(): Promise<void> {
    if (this.refresh_timer !== null) {
      clearInterval(this.refresh_timer);
      this.refresh_timer = null;
    }
    await this.cancel_login();
    await this.bridge.stop();
  }

  private ensure_refresh_timer(): void {
    if (this.refresh_timer !== null || this.auth_host === null) return;
    this.refresh_timer = setInterval(() => {
      void this.refresh_login_credentials();
    }, REFRESH_CHECK_INTERVAL_MS);
    this.refresh_timer.unref?.();
  }

  /** 只为登录来源且未标记过期的凭据续期。 */
  private async refresh_login_credentials(): Promise<void> {
    for (const status of this.credentials.list()) {
      if (status.source !== "login" || status.expired) continue;
      await this.try_refresh(status.origin).catch(() => undefined);
    }
  }

  private is_login_sourced(origin: string): boolean {
    return this.credentials.list().some((c) => c.origin === origin && c.source === "login");
  }

  private is_bridge_enabled(): boolean {
    const setting = normalize_setting_snapshot(this.settings.read_setting());
    return setting.novelia_bridge_enabled !== false;
  }
}

function read_origin(value: JsonValue | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim();
}

function read_source(value: JsonValue | undefined): NoveliaCredentialSource | null {
  return value === "bridge" || value === "manual" ? value : null;
}

function build_auth_login_url(origin: string, theme: "dark" | "light"): string {
  const auth_origin = derive_novelia_auth_origin(origin);
  if (auth_origin === null) {
    throw new AppError("remote.invalid_url", { public_details: { origin } });
  }
  return `${auth_origin}/?app=n&theme=${theme}`;
}

function build_auth_refresh_url(origin: string): string {
  const auth_origin = derive_novelia_auth_origin(origin);
  if (auth_origin === null) {
    throw new AppError("remote.invalid_url", { public_details: { origin } });
  }
  return `${auth_origin}/api/v1/auth/refresh?app=n`;
}
