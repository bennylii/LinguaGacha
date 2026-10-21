import { describe, expect, it, vi } from "vitest";

import type { JsonRecord } from "../../domain/json";
import type { AppSettingService } from "../app/app-setting-service";
import type { NoveliaAuthBridge, NoveliaAuthBridgeStatus } from "./novelia-auth-bridge";
import type { NoveliaCredentialStatus, NoveliaCredentialStore } from "./novelia-credential-store";
import { DEFAULT_NOVELIA_ORIGIN, RemoteAuthService } from "./remote-auth-service";

/** 凭据与桥接都是外部资源，这里只记录应用层调用的参数与顺序。 */
function create_service(setting: JsonRecord = {}) {
  const saved: NoveliaCredentialStatus = {
    origin: DEFAULT_NOVELIA_ORIGIN,
    token_tail: "wxyz",
    updated_at: "2026-10-20T00:00:00.000Z",
    source: "manual",
  };
  const credentials = {
    list: vi.fn(() => [saved]),
    save_token: vi.fn(() => saved),
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
  const settings = { read_setting: () => setting } as Pick<AppSettingService, "read_setting">;
  return {
    credentials,
    bridge,
    service: new RemoteAuthService({
      credentials: credentials as unknown as NoveliaCredentialStore,
      bridge: bridge as unknown as NoveliaAuthBridge,
      settings,
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
    const { service, bridge } = create_service({ novelia_bridge_enabled: false });

    await service.start();
    expect(bridge.start).not.toHaveBeenCalled();

    await service.apply_setting();
    expect(bridge.stop).toHaveBeenCalledOnce();
  });

  it("快照只暴露凭据状态与桥接状态", () => {
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
