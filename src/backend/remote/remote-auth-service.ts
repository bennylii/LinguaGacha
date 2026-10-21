import type { JsonRecord, JsonValue } from "../../domain/json";
import { normalize_setting_snapshot } from "../../domain/setting";
import type { AppSettingService } from "../app/app-setting-service";
import { AppError } from "../../shared/error/app-error";
import type { NoveliaAuthBridge, NoveliaAuthBridgeStatus } from "./novelia-auth-bridge";
import type {
  NoveliaCredentialSource,
  NoveliaCredentialStatus,
  NoveliaCredentialStore,
} from "./novelia-credential-store";

export const DEFAULT_NOVELIA_ORIGIN = "https://n.novelia.cc";

export interface RemoteAuthSnapshot {
  default_origin: string;
  origins: NoveliaCredentialStatus[];
  bridge: {
    enabled: boolean;
    status: NoveliaAuthBridgeStatus;
  };
}

export interface RemoteAuthServiceOptions {
  credentials: NoveliaCredentialStore;
  bridge: NoveliaAuthBridge;
  settings: Pick<AppSettingService, "read_setting">;
}

/**
 * 凭据导入与桥接开关的应用层入口。
 * token 只经过凭据存储，本服务只返回末位与更新时间。
 */
export class RemoteAuthService {
  private readonly credentials: NoveliaCredentialStore;
  private readonly bridge: NoveliaAuthBridge;
  private readonly settings: Pick<AppSettingService, "read_setting">;

  public constructor(options: RemoteAuthServiceOptions) {
    this.credentials = options.credentials;
    this.bridge = options.bridge;
    this.settings = options.settings;
  }

  /** 应用启动后按设置决定是否监听；端口失败只体现在状态里。 */
  public async start(): Promise<void> {
    if (this.is_bridge_enabled()) await this.bridge.start();
  }

  /** 设置保存后立即生效；关闭开关会释放本地端口。 */
  public async apply_setting(): Promise<void> {
    if (this.is_bridge_enabled()) await this.bridge.start();
    else await this.bridge.stop();
  }

  public snapshot(): RemoteAuthSnapshot {
    return {
      default_origin: DEFAULT_NOVELIA_ORIGIN,
      origins: this.credentials.list(),
      bridge: {
        enabled: this.is_bridge_enabled(),
        status: this.bridge.get_status(),
      },
    };
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

  /** 关闭时停止监听；凭据文件保留，重新启用后立即可用。 */
  public async dispose(): Promise<void> {
    await this.bridge.stop();
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
