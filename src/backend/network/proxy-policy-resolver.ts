import type { NetworkProxyPolicy } from "../../domain/setting";
import type { SystemProxyResolver } from "./system-proxy-http-client";

/**
 * 把设置里的代理模式翻译成系统代理客户端消费的 Chromium 规则串。
 *
 * 每次请求重新读取策略，使设置变更对后端全部出站请求立即生效；`system` 模式把 url 与 signal
 * 原样交给宿主 resolver，保持 Electron session 仍是系统代理规则的唯一来源。
 */
export function create_proxy_policy_resolver(
  host_resolver: SystemProxyResolver,
  read_policy: () => NetworkProxyPolicy,
): SystemProxyResolver {
  return {
    resolveProxy: async (url, signal) => {
      const policy = read_policy();
      if (policy.mode === "direct") return "DIRECT";
      if (policy.mode === "proxy") return `PROXY ${policy.address}`;
      return await host_resolver.resolveProxy(url, signal);
    },
  };
}
