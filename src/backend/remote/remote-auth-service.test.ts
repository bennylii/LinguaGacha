import { describe, expect, it, vi } from "vitest";

import type { JsonRecord } from "../../domain/json";
import type { AppSettingService } from "../app/app-setting-service";
import type { NoveliaAuthBridge, NoveliaAuthBridgeStatus } from "./novelia-auth-bridge";
import type { NoveliaCredentialStatus, NoveliaCredentialStore } from "./novelia-credential-store";
import type { RemoteAuthHost, RemoteAuthHostResult } from "../../shared/remote-auth-host";
import { DEFAULT_NOVELIA_ORIGIN, RemoteAuthService } from "./remote-auth-service";

/** 凭据、桥接与登录窗口都是外部资源，这里只记录应用层调用的参数与顺序。 */

/** 构造一个仅用于解码测试的最小 JWT；iat 可控制续期冷却的判定。 */
function encode_token(payload: Record<string, unknown>): string {
  return ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(
    ".",
  );
}

const FRESH_IAT = Math.floor(Date.now() / 1000);
const STALE_IAT = FRESH_IAT - 7_200;

function create_service(
  options: {
    setting?: JsonRecord;
    auth_host?: RemoteAuthHost;
    login_sourced?: boolean;
  } = {},
) {
  const saved: NoveliaCredentialStatus = {
    origin: DEFAULT_NOVELIA_ORIGIN,
    token_tail: "wxyz",
    updated_at: "2026-10-20T00:00:00.000Z",
    source: options.login_sourced === true ? "login" : "manual",
    expired: false,
  };
  const credential = {
    token: encode_token({ sub: "user", iat: STALE_IAT, exp: STALE_IAT + 7_200 }),
    cookie: "refresh-session=abc",
  };
  const credentials = {
    list: vi.fn(() => [saved]),
    read_credential: vi.fn(() => credential),
    // 模拟真实存储：续期成功后凭据替换为刚签发的 token。
    save_token: vi.fn((input: { raw_token: string; cookie?: string }) => {
      credential.token =
        input.raw_token === "new"
          ? encode_token({ sub: "user", iat: FRESH_IAT, exp: FRESH_IAT + 7_200 })
          : credential.token;
      if (input.cookie !== undefined && input.cookie.trim() !== "")
        credential.cookie = input.cookie;
      return saved;
    }),
    mark_expired: vi.fn(),
    clear: vi.fn(() => []),
  };
  const bridge_status: NoveliaAuthBridgeStatus = {
    running: true,
    port: 7331,
    address: "http://127.0.0.1:7331",
    error: null,
  };
  const bridge = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    get_status: vi.fn(() => bridge_status),
  };
  const settings = {
    read_setting: () => options.setting ?? {},
  } as Pick<AppSettingService, "read_setting">;
  return {
    credentials,
    bridge,
    service: new RemoteAuthService({
      credentials: credentials as unknown as NoveliaCredentialStore,
      bridge: bridge as unknown as NoveliaAuthBridge,
      settings,
      auth_host: options.auth_host,
    }),
  };
}

/** 同步入口的校验错误没有返回值，用异常对象断言稳定错误码。 */
function read_error(action: () => unknown): unknown {
  try {
    action();
    return null;
  } catch (error) {
    return error;
  }
}

describe("RemoteAuthService", () => {
  it("默认启用桥接，启动与设置变更都直接作用到监听器", async () => {
    const { service, bridge } = create_service();

    await service.start();
    expect(bridge.start).toHaveBeenCalledOnce();

    await service.apply_setting();
    expect(bridge.start).toHaveBeenCalledTimes(2);
    expect(bridge.stop).not.toHaveBeenCalled();

    await service.dispose();
    expect(bridge.stop).toHaveBeenCalledOnce();
  });

  it("关闭设置后不监听并释放已占用端口", async () => {
    const { service, bridge } = create_service({ setting: { novelia_bridge_enabled: false } });

    await service.start();
    expect(bridge.start).not.toHaveBeenCalled();

    await service.apply_setting();
    expect(bridge.stop).toHaveBeenCalledOnce();
  });

  it("快照只暴露凭据状态、桥接状态与登录状态", () => {
    const { service, credentials } = create_service();

    expect(service.snapshot()).toEqual({
      default_origin: DEFAULT_NOVELIA_ORIGIN,
      origins: credentials.list(),
      bridge: {
        enabled: true,
        status: {
          running: true,
          port: 7331,
          address: "http://127.0.0.1:7331",
          error: null,
        },
      },
      login: { running: false, origin: null, started_at: null },
    });
  });

  it("手动导入默认写入官方站点并标记来源", () => {
    const { service, credentials } = create_service();

    service.import({ token: "  Bearer abc.def.ghi  " });

    expect(credentials.save_token).toHaveBeenCalledWith({
      origin: DEFAULT_NOVELIA_ORIGIN,
      raw_token: "  Bearer abc.def.ghi  ",
      source: "manual",
    });
  });

  it("导入可指定站点与桥接来源", () => {
    const { service, credentials } = create_service();

    service.import({ origin: " https://books.fishhawk.top ", token: "abc", source: "bridge" });

    expect(credentials.save_token).toHaveBeenCalledWith({
      origin: "https://books.fishhawk.top",
      raw_token: "abc",
      source: "bridge",
    });
  });

  it("缺少 token 时拒绝导入且不写凭据", () => {
    const { service, credentials } = create_service();

    expect(read_error(() => service.import({}))).toMatchObject({
      code: "request.validation_failed",
    });
    expect(read_error(() => service.import({ token: "   " }))).toMatchObject({
      code: "request.validation_failed",
    });
    expect(credentials.save_token).not.toHaveBeenCalled();
  });

  it("清除指定站点与全部凭据走同一个入口", () => {
    const { service, credentials } = create_service();

    service.clear({ origin: "https://books.fishhawk.top" });
    expect(credentials.clear).toHaveBeenLastCalledWith("https://books.fishhawk.top");

    service.clear({});
    expect(credentials.clear).toHaveBeenLastCalledWith(undefined);
  });
});

describe("RemoteAuthService login", () => {
  it("登录成功后以 login 来源落盘凭据并记录冷却", async () => {
    const auth_host = vi.fn(async (): Promise<RemoteAuthHostResult> => ({
      status: "succeeded",
      token: "t.a.b",
      cookie: "s=1",
    }));
    const { service, credentials } = create_service({ auth_host });

    await service.login({});

    expect(auth_host).toHaveBeenCalledWith(
      {
        kind: "open_remote_login_window",
        url: "https://n.novelia.cc/?app=n&theme=light",
        origin: DEFAULT_NOVELIA_ORIGIN,
      },
      expect.any(AbortSignal),
    );
    expect(credentials.save_token).toHaveBeenCalledWith({
      origin: DEFAULT_NOVELIA_ORIGIN,
      raw_token: "t.a.b",
      cookie: "s=1",
      source: "login",
    });
    expect(service.snapshot().login).toEqual({
      running: false,
      origin: null,
      started_at: null,
    });
  });

  it("环境没有窗口能力时登录被拒绝", async () => {
    const { service } = create_service();

    await expect(service.login({})).rejects.toMatchObject({
      code: "remote.window_unsupported",
    });
  });

  it("取消登录按空闲快照结算且不落盘凭据", async () => {
    const auth_host = vi.fn(
      async (_operation: unknown, signal?: AbortSignal): Promise<RemoteAuthHostResult> =>
        await new Promise<RemoteAuthHostResult>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const { service, credentials } = create_service({ auth_host });

    const pending = service.login({});
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await service.cancel_login();
    const snapshot = await pending;
    expect(snapshot.login).toEqual({ running: false, origin: null, started_at: null });
    expect(credentials.save_token).not.toHaveBeenCalled();
    expect(auth_host).toHaveBeenCalledOnce();
  });
});

describe("RemoteAuthService try_refresh", () => {
  it("只有 login 来源的凭据会续期", async () => {
    const auth_host = vi.fn(async (): Promise<RemoteAuthHostResult> => ({
      status: "succeeded",
      token: "new",
      cookie: "",
    }));
    const { service, credentials } = create_service({ auth_host, login_sourced: false });

    expect(await service.try_refresh(DEFAULT_NOVELIA_ORIGIN, { force: true })).toBe(false);
    expect(auth_host).not.toHaveBeenCalled();
    expect(credentials.save_token).not.toHaveBeenCalled();
  });

  it("签发超过 1 小时的凭据按需续期，未到期时跳过", async () => {
    const auth_host = vi.fn(async (): Promise<RemoteAuthHostResult> => ({
      status: "succeeded",
      token: "new",
      cookie: "",
    }));
    const { service, credentials } = create_service({ auth_host, login_sourced: true });

    // STALE_IAT 距今约 2 小时，冷却已过，应发起续期。
    expect(await service.try_refresh(DEFAULT_NOVELIA_ORIGIN)).toBe(true);
    expect(credentials.save_token).toHaveBeenCalledWith({
      origin: DEFAULT_NOVELIA_ORIGIN,
      raw_token: "new",
      cookie: "refresh-session=abc",
      source: "login",
    });

    // 刚刚成功续期过（iat 被替换为当前时间），冷却期内不再发起。
    expect(await service.try_refresh(DEFAULT_NOVELIA_ORIGIN)).toBe(false);
    expect(auth_host).toHaveBeenCalledOnce();
  });

  it("续期会话失效时只打过期标记", async () => {
    const auth_host = vi.fn(async (): Promise<RemoteAuthHostResult> => ({
      status: "unauthorized",
    }));
    const { service, credentials } = create_service({ auth_host, login_sourced: true });

    expect(await service.try_refresh(DEFAULT_NOVELIA_ORIGIN, { force: true })).toBe(false);
    expect(credentials.mark_expired).toHaveBeenCalledWith(DEFAULT_NOVELIA_ORIGIN, true);
  });
});
