import { describe, expect, it, vi } from "vitest";

import type { NetworkProxyPolicy } from "../../domain/setting";
import { create_proxy_policy_resolver } from "./proxy-policy-resolver";
import { parse_system_proxy_route } from "./system-proxy-http-client";

describe("create_proxy_policy_resolver", () => {
  it("直连模式给出 DIRECT 且不询问宿主", async () => {
    const host = vi.fn(async () => "PROXY 127.0.0.1:7890");
    const resolver = create_proxy_policy_resolver({ resolveProxy: host }, () => {
      return { mode: "direct", address: "127.0.0.1:6789" };
    });

    await expect(resolver.resolveProxy("https://api.example/v1/chat")).resolves.toBe("DIRECT");
    expect(host).not.toHaveBeenCalled();
  });

  it("自定义代理模式用设置里的地址合成 PROXY 规则", async () => {
    const host = vi.fn(async () => "DIRECT");
    const resolver = create_proxy_policy_resolver({ resolveProxy: host }, () => {
      return { mode: "proxy", address: "10.0.0.5:1080" };
    });

    const rules = await resolver.resolveProxy("https://api.example/v1/chat");

    expect(rules).toBe("PROXY 10.0.0.5:1080");
    expect(host).not.toHaveBeenCalled();
    expect(parse_system_proxy_route(rules)).toEqual({
      kind: "proxy",
      uri: "http://10.0.0.5:1080/",
    });
  });

  it("跟随系统模式把 url 与取消信号原样交给宿主", async () => {
    const host = vi.fn(async () => "PROXY system:8080");
    const resolver = create_proxy_policy_resolver({ resolveProxy: host }, () => {
      return { mode: "system", address: "127.0.0.1:6789" };
    });
    const controller = new AbortController();

    await expect(
      resolver.resolveProxy("https://api.example/v1/models", controller.signal),
    ).resolves.toBe("PROXY system:8080");
    expect(host).toHaveBeenCalledExactlyOnceWith(
      "https://api.example/v1/models",
      controller.signal,
    );
  });

  it("每次解析重新读取策略，改设置后下一次请求即生效", async () => {
    let policy: NetworkProxyPolicy = { mode: "direct", address: "127.0.0.1:6789" };
    const resolver = create_proxy_policy_resolver(
      { resolveProxy: vi.fn(async () => "DIRECT") },
      () => policy,
    );

    await expect(resolver.resolveProxy("https://api.example/v1/chat")).resolves.toBe("DIRECT");
    policy = { mode: "proxy", address: "127.0.0.1:6789" };
    await expect(resolver.resolveProxy("https://api.example/v1/chat")).resolves.toBe(
      "PROXY 127.0.0.1:6789",
    );
  });
});
