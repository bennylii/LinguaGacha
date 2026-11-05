import { BrowserWindow, session } from "electron";

import {
  type RemoteAuthHost,
  type RemoteAuthHostResult,
  type RemoteLoginWindowOperation,
} from "../../shared/remote-auth-host";

const LOGIN_POLL_INTERVAL_MS = 3_000;
const LOGIN_WINDOW_TIMEOUT_MS = 5 * 60_000;

/**
 * 内嵌登录窗口：加载站点入口让用户在站点自身的登录表单中登录，
 * 登录成功（auth 域续期端点返回 JWT）后经分区会话结算回包，并把站点域 Cookie 一并交付落盘。
 * Cookie 保存在持久分区里跨重启复用，因此 dispose 不清理存储。
 */
export function create_remote_login_window_host(): RemoteAuthHost & {
  dispose: () => Promise<void>;
} {
  const open_windows = new Set<BrowserWindow>();

  const get_partition_session = (origin: string): ReturnType<typeof session.fromPartition> => {
    return session.fromPartition(`persist:novelia-auth-${new URL(origin).host}`, { cache: false });
  };

  /** 同一宿主生命周期内复用分区会话；fetch 由 Chromium 网络栈附带 Cookie。 */
  async function refresh_once(url: string, origin: string): Promise<RemoteAuthHostResult> {
    const browser_session = get_partition_session(origin);
    try {
      const response = await browser_session.fetch(url, {
        method: "POST",
        credentials: "include",
      });
      if (response.status === 401) return { status: "unauthorized" };
      if (!response.ok) return { status: "unavailable" };
      const token = (await response.text()).trim();
      if (token === "") return { status: "unavailable" };
      const cookie = await collect_site_cookies(browser_session, new URL(origin).host);
      return { status: "succeeded", token, cookie };
    } catch {
      return { status: "unavailable" }; // 网络失败不应误判为凭据失效。
    }
  }

  function open_login_window(
    operation: RemoteLoginWindowOperation,
    signal?: AbortSignal,
  ): Promise<RemoteAuthHostResult> {
    const { promise, resolve } = Promise.withResolvers<RemoteAuthHostResult>();
    let poll: NodeJS.Timeout | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let settled = false;

    const settle = (value: RemoteAuthHostResult): void => {
      if (settled) return;
      settled = true;
      if (poll !== null) clearInterval(poll);
      if (timeout !== null) clearTimeout(timeout);
      signal?.removeEventListener("abort", on_abort);
      resolve(value);
    };
    // 先写终态再关窗：close 触发的 closed 回调随后只会命中 settled 分支。
    const finish = (value: RemoteAuthHostResult): void => {
      settle(value);
      if (!current.isDestroyed()) current.close();
    };
    const on_abort = (): void => {
      finish({ status: "cancelled" });
    };
    const poll_once = (): void => {
      void refresh_once(operation.refresh_url, operation.origin).then((outcome) => {
        if (outcome.status === "succeeded") finish(outcome);
      });
    };

    const current = new BrowserWindow({
      width: 480,
      height: 680,
      show: false,
      webPreferences: {
        session: get_partition_session(operation.origin),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    current.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    current.once("closed", () => {
      open_windows.delete(current);
      settle({ status: "cancelled" });
    });
    open_windows.add(current);
    signal?.addEventListener("abort", on_abort, { once: true });
    // 站点首屏可能因网络、代理或挑战页长时间不完成；先显示窗口，
    // 让用户至少能看到登录入口和加载状态，而不是等待一个不可见窗口。
    current.show();
    void current
      .loadURL(operation.url)
      .then(() => {
        if (settled) return;
        poll = setInterval(poll_once, LOGIN_POLL_INTERVAL_MS);
        poll.unref?.();
        timeout = setTimeout(() => {
          finish({ status: "timeout" });
        }, LOGIN_WINDOW_TIMEOUT_MS);
        timeout.unref?.();
      })
      .catch(() => {
        // 页面加载失败也结束本次尝试并关闭窗口，避免遗留不可见窗口。
        finish({ status: "unavailable" });
      });
    return promise;
  }

  const host: RemoteAuthHost = async (operation, signal) => {
    if (operation.kind === "remote_auth_refresh") {
      return await refresh_once(operation.url, operation.origin);
    }
    return await open_login_window(operation, signal);
  };

  return Object.assign(host, {
    /** 关闭仍在打开的登录窗口；分区 Cookie 保留以支持重启后的自动续期。 */
    dispose: async () => {
      // Set 迭代期间删除当前项是定义良好的行为，close 触发的 closed 回调无需快照。
      for (const window of open_windows) {
        if (!window.isDestroyed()) window.close();
      }
      open_windows.clear();
    },
  });
}

/** 只交付浏览器会发送给目标 host 的 Cookie（本域与父域），序列化为 Cookie 头。 */
async function collect_site_cookies(
  browser_session: ReturnType<typeof session.fromPartition>,
  host: string,
): Promise<string> {
  const target = host.toLowerCase().replace(/\.$/u, "");
  const cookies = await browser_session.cookies.get({});
  return cookies
    .filter((cookie) => {
      const domain = (cookie.domain ?? "").toLowerCase().replace(/^\./u, "");
      return domain === target || target.endsWith(`.${domain}`);
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}
