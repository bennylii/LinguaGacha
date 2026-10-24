/** 凭据/登录快照变化的事件 topic；载荷形状与 `/api/remote/auth/status` 一致。 */
export const REMOTE_AUTH_SNAPSHOT_EVENT_TOPIC = "remote_auth.snapshot_changed";

/**
 * 内嵌登录窗口与 token 续期的宿主能力，必须在 Electron main 执行。
 * token/Cookie 只经进程内消息回传给凭据存储，不落日志、不回传前端。
 */
export type RemoteAuthHostResult =
  | { status: "succeeded"; token: string; cookie: string }
  | { status: "unauthorized" } // 登录/续期会话失效，需要重新登录
  | { status: "cancelled" } // 用户关闭了登录窗口
  | { status: "timeout" }
  | { status: "unavailable" }; // 宿主没有窗口能力（CLI）

export type RemoteLoginWindowOperation = {
  kind: "open_remote_login_window";
  url: string;
  origin: string;
};

export type RemoteAuthRefreshOperation = {
  kind: "remote_auth_refresh";
  url: string;
  origin: string;
};

export type RemoteAuthHost = (
  operation: RemoteLoginWindowOperation | RemoteAuthRefreshOperation,
  signal?: AbortSignal,
) => Promise<RemoteAuthHostResult>;

/** 认证服务按“auth.<去首段子域>”派生；与站点前端的 baseDomain 规则一致。 */
export function derive_novelia_auth_origin(origin: string): string | null {
  try {
    const url = new URL(origin);
    const parts = url.hostname.split(".");
    if (parts.length < 2) return null;
    return `${url.protocol}//auth.${parts.slice(-2).join(".")}`;
  } catch {
    return null;
  }
}
