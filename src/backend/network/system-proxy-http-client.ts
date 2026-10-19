import {
  Agent,
  Dispatcher,
  ProxyAgent,
  Socks5ProxyAgent,
  fetch as undici_fetch,
  Request as UndiciRequest,
  Response as UndiciResponse,
  Headers as UndiciHeaders,
  FormData as UndiciFormData,
} from "undici";
import { record_http_response_info } from "./http-response-info";

type FetchGlobals = Pick<
  typeof globalThis,
  "fetch" | "Request" | "Response" | "Headers" | "FormData"
>;

// fetch 与其对象构造器必须来自同一 Undici 版本，避免 Node 内置版本的品牌和 dispatcher 协议差异。
const FETCH_CONSTRUCTORS = {
  Request: UndiciRequest,
  Response: UndiciResponse,
  Headers: UndiciHeaders,
  FormData: UndiciFormData,
} as unknown as Omit<FetchGlobals, "fetch">;

export interface SystemProxyResolver {
  resolveProxy: (url: string, signal?: AbortSignal) => Promise<string>; // Electron session 是系统代理规则的唯一来源
}

export type SystemProxyRoute =
  | { kind: "direct" }
  | { kind: "proxy"; uri: string }
  | { kind: "socks5"; uri: string };

// 传输层失败在第三方 SDK 里只剩通用文案，此处保留路由与原始原因供调用方记录。
export interface TransportFailure {
  url: string;
  route: SystemProxyRoute | null; // 路由解析本身失败时没有可用路由
  error: unknown;
}

export interface SystemProxyHttpClientOptions {
  redirects?: "error" | "request";
  onTransportFailure?: (failure: TransportFailure) => void; // 只上报事实，抛出的错误不变
}

/**
 * 当前线程唯一的普通远端 HTTP Client；每次请求重新解析路由，只缓存可复用的代理连接池。
 */
export class SystemProxyHttpClient {
  private readonly redirects: "error" | "request"; // 后端禁止重定向；工作区遵循 fetch 调用者选项
  private readonly on_transport_failure: ((failure: TransportFailure) => void) | null;
  private readonly resolver: SystemProxyResolver; // 请求时读取 Electron 当前路由，不保存启动快照
  private readonly direct_dispatcher: Dispatcher; // loopback 与显式 DIRECT 共用的自有连接池
  private readonly proxy_dispatchers = new Map<string, Dispatcher>(); // 同一路由复用连接池
  private previous_globals: FetchGlobals | null = null; // 安装期保存 fetch 及配套构造器，关闭时统一恢复
  private disposed = false; // 释放后拒绝新请求，避免重建已关闭资源

  /** 创建自有直连池；代理池延迟到首次命中对应路由时创建。 */
  public constructor(resolver: SystemProxyResolver, options: SystemProxyHttpClientOptions = {}) {
    this.redirects = options.redirects ?? "error";
    this.on_transport_failure = options.onTransportFailure ?? null;
    this.resolver = resolver;
    this.direct_dispatcher = new Agent();
  }

  /** 普通远端 HTTP 共用此 Fetch；专用安全下载链路仍显式选择自己的 dispatcher。 */
  public readonly fetch: typeof globalThis.fetch = async (input, init) => {
    if (this.disposed) {
      throw new Error("System proxy HTTP client is disposed.");
    }
    const url = read_request_url(input);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    signal?.throwIfAborted();
    let route: SystemProxyRoute | null = null;
    let response: Response;
    // 只有路由解析与派发属于传输层；响应事实的采集失败不应记成传输失败。
    try {
      route = await resolve_system_proxy_route(this.resolver, url.href, signal);
      const dispatcher = this.resolve_dispatcher(route);
      signal?.throwIfAborted();
      response = (await undici_fetch(input as Parameters<typeof undici_fetch>[0], {
        ...(init as Parameters<typeof undici_fetch>[1]),
        dispatcher,
        ...(this.redirects === "error" ? { redirect: "error" as const } : {}),
      })) as unknown as Response;
    } catch (error) {
      this.report_transport_failure({ url: url.href, route, error }, signal);
      throw error;
    }
    record_http_response_info(response);
    return response;
  };

  /** 主动取消是调用方的正常控制流，只有真正的传输失败才上报。 */
  private report_transport_failure(
    failure: TransportFailure,
    signal: AbortSignal | undefined,
  ): void {
    if (this.on_transport_failure === null) return;
    if (signal?.aborted === true || is_abort_error(failure.error)) return;
    this.on_transport_failure(failure);
  }

  /** Backend 线程只有一个普通 HTTP transport，第三方 SDK 也从同一全局入口取用。 */
  public install_as_global_fetch(): void {
    if (this.disposed || this.previous_globals !== null) {
      throw new Error("System proxy HTTP client cannot be installed in its current state.");
    }
    const { fetch, Request, Response, Headers, FormData } = globalThis;
    this.previous_globals = { fetch, Request, Response, Headers, FormData };
    Object.assign(globalThis, FETCH_CONSTRUCTORS);
    globalThis.fetch = this.fetch;
  }

  /** 先恢复线程原 transport，再关闭本 Client 创建的全部连接池。 */
  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.previous_globals !== null) {
      Object.assign(globalThis, this.previous_globals);
      this.previous_globals = null;
    }
    const dispatchers = [this.direct_dispatcher, ...this.proxy_dispatchers.values()];
    this.proxy_dispatchers.clear();
    const results = await Promise.allSettled(dispatchers.map((dispatcher) => dispatcher.close()));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "System proxy HTTP client failed to close.");
    }
  }

  /** 按已解析路由返回直连池，或复用对应协议与地址的代理池。 */
  private resolve_dispatcher(route: SystemProxyRoute): Dispatcher {
    if (route.kind === "direct") return this.direct_dispatcher;
    const key = `${route.kind}:${route.uri}`;
    const existing = this.proxy_dispatchers.get(key);
    if (existing !== undefined) return existing;
    const dispatcher =
      route.kind === "socks5" ? new Socks5ProxyAgent(route.uri) : new ProxyAgent(route.uri);
    this.proxy_dispatchers.set(key, dispatcher);
    return dispatcher;
  }
}

/** 按 Chromium 返回顺序选择首个可执行路由；只有显式 DIRECT 才允许直连。 */
export function parse_system_proxy_route(proxy_rules: string): SystemProxyRoute {
  for (const rule of proxy_rules.split(";")) {
    const trimmed_rule = rule.trim();
    if (trimmed_rule === "") continue;
    const [raw_type = "", ...target_parts] = trimmed_rule.split(/\s+/u);
    const type = raw_type.toUpperCase();
    if (type === "DIRECT") return { kind: "direct" };
    const target = target_parts.join(" ");
    if (type === "PROXY") {
      const uri = build_proxy_uri("http", target);
      if (uri !== null) return { kind: "proxy", uri };
    }
    if (type === "HTTPS") {
      const uri = build_proxy_uri("https", target);
      if (uri !== null) return { kind: "proxy", uri };
    }
    if (type === "SOCKS" || type === "SOCKS5") {
      const uri = build_proxy_uri("socks5", target);
      if (uri !== null) return { kind: "socks5", uri };
    }
  }
  throw new Error("System proxy returned no supported route.");
}

/** Electron session 是系统路线权威；本机端点保持直连，其余 URL 每次读取当前代理事实。 */
export async function resolve_system_proxy_route(
  resolver: SystemProxyResolver,
  url: string,
  signal?: AbortSignal,
): Promise<SystemProxyRoute> {
  const target = new URL(url);
  if (is_loopback_hostname(target.hostname)) return { kind: "direct" };
  return parse_system_proxy_route(await resolver.resolveProxy(target.href, signal));
}

/** fetch 同时接受 URL 文本、URL 和 Request，这里统一为代理解析所需的 URL。 */
function read_request_url(input: Parameters<typeof globalThis.fetch>[0]): URL {
  if (typeof input === "string" || input instanceof URL) return new URL(input);
  return new URL(input.url);
}

/** Chromium 代理目标通常省略 scheme；无效目标留给后续候选继续匹配。 */
function build_proxy_uri(protocol: "http" | "https" | "socks5", target: string): string | null {
  const trimmed_target = target.trim();
  if (trimmed_target === "") return null;
  try {
    const url = new URL(
      trimmed_target.includes("://") ? trimmed_target : `${protocol}://${trimmed_target}`,
    );
    return url.hostname === "" ? null : url.toString();
  } catch {
    return null;
  }
}

/** Node 与 Undici 的取消错误都归入 AbortError 语义，避免把调用方取消记成传输失败。 */
function is_abort_error(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (
    (error as { name?: unknown }).name === "AbortError" ||
    (error as { code?: unknown }).code === "UND_ERR_ABORTED"
  );
}

/** 本机模型端点不经过外部代理，覆盖 localhost、IPv6 loopback 与完整 127/8。 */
function is_loopback_hostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}
