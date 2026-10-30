import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = () => void;

const created_windows: FakeBrowserWindow[] = [];
let load_error: Error | null = null;
let load_pending = false;

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = [];

  webContents = {
    setWindowOpenHandler: vi.fn(),
  };
  destroyed = false;
  visible = false;
  loaded_url: string | null = null;
  loadURL = vi.fn(async (url: string) => {
    this.loaded_url = url;
    if (load_error !== null) throw load_error;
    if (load_pending) await new Promise<void>(() => {});
  });
  private listeners = new Map<string, Listener[]>();

  constructor() {
    created_windows.push(this);
    FakeBrowserWindow.instances.push(this);
  }

  once(event_name: string, listener: Listener): void {
    const listeners = this.listeners.get(event_name) ?? [];
    listeners.push(listener);
    this.listeners.set(event_name, listeners);
  }

  emit(event_name: string): void {
    for (const listener of this.listeners.get(event_name) ?? []) listener();
    this.listeners.delete(event_name);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  show(): void {
    this.visible = true;
  }

  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }
}

const partition_session = {
  fetch: vi.fn(),
  cookies: {
    get: vi.fn(async () => [] as Array<{ name: string; value: string; domain: string }>),
  },
};

vi.mock("electron", () => {
  return {
    BrowserWindow: FakeBrowserWindow,
    session: {
      fromPartition: vi.fn(() => partition_session),
    },
  };
});

const OPERATION = {
  kind: "open_remote_login_window" as const,
  url: "https://n.novelia.cc/?app=n&theme=light",
  refresh_url: "https://auth.novelia.cc/api/v1/auth/refresh?app=n",
  origin: "https://n.novelia.cc",
};

/** 模拟 Chromium 网络栈返回的续期响应；只有 text() 与状态码参与结算。 */
function token_response(token: string, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => token,
  } as Response;
}

async function open_host() {
  const { create_remote_login_window_host } = await import("./remote-login-window-host");
  return create_remote_login_window_host();
}

beforeEach(() => {
  vi.useFakeTimers();
  created_windows.length = 0;
  FakeBrowserWindow.instances.length = 0;
  load_error = null;
  load_pending = false;
  partition_session.fetch.mockReset();
  partition_session.cookies.get.mockReset();
  partition_session.cookies.get.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("远程登录窗口宿主", () => {
  it("打开站点入口并在轮询 auth 域成功后结算 token 与站点 Cookie", async () => {
    partition_session.fetch.mockResolvedValue(token_response("jwt-token"));
    partition_session.cookies.get.mockResolvedValue([
      { name: "session", value: "abc", domain: "n.novelia.cc" },
      { name: "other", value: "x", domain: "evil.example" },
    ]);
    const host = await open_host();

    const pending = host(OPERATION);
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await pending;

    expect(created_windows[0]?.loaded_url).toBe(OPERATION.url);
    expect(partition_session.fetch).toHaveBeenCalledWith(OPERATION.refresh_url, {
      method: "POST",
      credentials: "include",
    });
    expect(result).toEqual({ status: "succeeded", token: "jwt-token", cookie: "session=abc" });
    expect(created_windows[0]?.destroyed).toBe(true);
    expect(created_windows[0]?.visible).toBe(true);
  });

  it("页面加载完成前就显示窗口，避免登录入口长时间不可见", async () => {
    load_pending = true;
    const host = await open_host();
    const controller = new AbortController();
    const pending = host(OPERATION, controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    expect(created_windows[0]?.visible).toBe(true);

    controller.abort();
    await expect(pending).resolves.toEqual({ status: "cancelled" });
  });

  it("用户关闭登录窗口时返回 cancelled 并停止轮询", async () => {
    const host = await open_host();
    const pending = host(OPERATION);
    await vi.advanceTimersByTimeAsync(0);

    created_windows[0]?.close();
    const result = await pending;

    expect(result).toEqual({ status: "cancelled" });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(partition_session.fetch).not.toHaveBeenCalled();
  });

  it("超时返回 timeout 并关闭窗口", async () => {
    const host = await open_host();
    const pending = host(OPERATION);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const result = await pending;

    expect(result).toEqual({ status: "timeout" });
    expect(created_windows[0]?.destroyed).toBe(true);
  });

  it("取消信号返回 cancelled 并关闭窗口", async () => {
    const host = await open_host();
    const controller = new AbortController();
    const pending = host(OPERATION, controller.signal);
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    const result = await pending;

    expect(result).toEqual({ status: "cancelled" });
    expect(created_windows[0]?.destroyed).toBe(true);
  });

  it("页面加载失败返回 unavailable 且不遗留窗口", async () => {
    load_error = new Error("load failed");
    const host = await open_host();
    const result = await host(OPERATION);

    expect(result).toEqual({ status: "unavailable" });
    expect(created_windows[0]?.destroyed).toBe(true);
  });

  it("续期操作直接访问传入的 auth 地址，不创建窗口", async () => {
    partition_session.fetch.mockResolvedValue(token_response("refreshed"));
    const host = await open_host();

    const result = await host({
      kind: "remote_auth_refresh",
      url: "https://auth.novelia.cc/api/v1/auth/refresh?app=n",
      origin: "https://n.novelia.cc",
    });

    expect(result).toEqual({ status: "succeeded", token: "refreshed", cookie: "" });
    expect(created_windows).toHaveLength(0);
  });

  it("续期被拒绝时报告 unauthorized", async () => {
    partition_session.fetch.mockResolvedValue(token_response("", 401));
    const host = await open_host();

    const result = await host({
      kind: "remote_auth_refresh",
      url: "https://auth.novelia.cc/api/v1/auth/refresh?app=n",
      origin: "https://n.novelia.cc",
    });

    expect(result).toEqual({ status: "unauthorized" });
  });
});
