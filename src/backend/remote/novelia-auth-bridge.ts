import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { AppError, resolve_app_error_http_status } from "../../shared/error";
import type { LogManager } from "../log/log-manager";
import type { NoveliaCredentialStore } from "./novelia-credential-store";
import { normalize_novel_origin } from "./novelia-source";

const BRIDGE_HOST = "127.0.0.1";
const DEFAULT_PORT_START = 7331;
const DEFAULT_PORT_END = 7341;
const MAX_BODY_BYTES = 64 * 1024;

export interface NoveliaAuthBridgeStatus {
  running: boolean;
  port: number | null;
  address: string | null;
  error: string | null;
}

export interface NoveliaAuthBridgeOptions {
  credentials: NoveliaCredentialStore;
  log?: Pick<LogManager, "info" | "warning">;
  port_start?: number; // 默认从 ntr-toolbox 的 7331 开始顺延
  port_end?: number;
}

/**
 * 只监听回环的凭据桥接，兼容 ntr-toolbox「同步 Daemon」的
 * `POST /auth {token, workers, origin}`，并对手动导入提供同一份凭据快照。
 */
export class NoveliaAuthBridge {
  private readonly credentials: NoveliaCredentialStore;
  private readonly log: Pick<LogManager, "info" | "warning"> | null;
  private readonly port_start: number;
  private readonly port_end: number;
  private server: Server | null = null;
  private port: number | null = null;
  private last_error: string | null = null;
  private starting: Promise<void> | null = null;

  public constructor(options: NoveliaAuthBridgeOptions) {
    this.credentials = options.credentials;
    this.log = options.log ?? null;
    this.port_start = options.port_start ?? DEFAULT_PORT_START;
    this.port_end = options.port_end ?? DEFAULT_PORT_END;
  }

  /** 端口全部占用时只记录禁用原因，不让应用启动失败。 */
  public async start(): Promise<void> {
    if (this.server !== null) return;
    if (this.starting !== null) return await this.starting;
    this.starting = this.listen_available_port().finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  /** 停止监听并让出端口；已接收的请求随连接关闭一起结束。 */
  public async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server === null) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  public get_status(): NoveliaAuthBridgeStatus {
    return {
      running: this.server !== null,
      port: this.port,
      address: this.port === null ? null : `http://${BRIDGE_HOST}:${this.port}`,
      error: this.last_error,
    };
  }

  private async listen_available_port(): Promise<void> {
    for (let port = this.port_start; port <= this.port_end; port += 1) {
      try {
        const server = await this.listen(port);
        const address = server.address();
        this.server = server;
        this.port = address !== null && typeof address !== "string" ? address.port : port;
        this.last_error = null;
        this.log?.info("Novel credential bridge is listening.", {
          source: "remote-bridge",
          context: { port: this.port },
        });
        return;
      } catch {
        // 端口占用或权限不足时继续尝试下一个本地端口。
      }
    }
    this.last_error = `No local port is available between ${this.port_start} and ${this.port_end}.`;
    this.log?.warning("Novel credential bridge could not start.", {
      source: "remote-bridge",
      context: { port_start: this.port_start, port_end: this.port_end },
    });
  }

  private async listen(port: number): Promise<Server> {
    return await new Promise<Server>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle_request(request, response);
      });
      server.headersTimeout = 5_000;
      server.requestTimeout = 10_000;
      server.once("error", reject);
      server.listen(port, BRIDGE_HOST, () => {
        server.off("error", reject);
        resolve(server);
      });
    });
  }

  /** 所有响应共用 no-store 与 JSON 头，CORS 只对白名单 origin 回显。 */
  private async handle_request(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw_origin = read_header(request, "origin");
    const allowed_origin = raw_origin === null ? null : normalize_novel_origin(raw_origin);
    if (raw_origin !== null && allowed_origin === null) {
      respond_json(response, 403, { ok: false, error: "origin_not_allowed" });
      return;
    }
    if (allowed_origin !== null) {
      response.setHeader("access-control-allow-origin", allowed_origin);
      response.setHeader("vary", "origin");
    }
    if (request.method === "OPTIONS") {
      if (allowed_origin === null) {
        respond_json(response, 403, { ok: false, error: "origin_not_allowed" });
        return;
      }
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader("access-control-allow-headers", "Content-Type");
      response.setHeader("access-control-max-age", "600");
      response.statusCode = 204;
      response.end();
      return;
    }
    const pathname = new URL(request.url ?? "/", `http://${BRIDGE_HOST}`).pathname;
    if (request.method === "GET" && pathname === "/status") {
      respond_json(response, 200, {
        ok: true,
        ...this.get_status(),
        origins: this.credentials.list(),
      });
      return;
    }
    if (request.method === "POST" && pathname === "/auth") {
      await this.handle_auth(request, response, allowed_origin ?? raw_origin);
      return;
    }
    respond_json(response, 404, { ok: false, error: "not_found" });
  }

  /** 兼容 userscript 的 `{token, workers, origin}`；token 只写入凭据文件。 */
  private async handle_auth(
    request: IncomingMessage,
    response: ServerResponse,
    fallback_origin: string | null,
  ): Promise<void> {
    try {
      const body = await read_json_body(request);
      if (!is_record(body)) {
        throw new AppError("request.validation_failed", {
          public_details: { field: "body" },
        });
      }
      const origin = read_body_string(body, "origin") ?? fallback_origin;
      if (origin === null || normalize_novel_origin(origin) === null) {
        throw new AppError("request.validation_failed", {
          public_details: { field: "origin" },
        });
      }
      const raw_token =
        read_body_string(body, "token") ?? read_header(request, "authorization") ?? "";
      const status = this.credentials.save_token({ origin, raw_token, source: "bridge" });
      const workers = Array.isArray(body["workers"]) ? body["workers"].length : 0;
      respond_json(response, 200, {
        ok: true,
        origin: status.origin,
        token_tail: status.token_tail,
        workers,
      });
    } catch (error) {
      const app_error =
        error instanceof AppError
          ? error
          : new AppError("remote.bridge_unavailable", { cause: error });
      respond_json(response, resolve_app_error_http_status(app_error), {
        ok: false,
        error: app_error.code,
      });
    }
  }
}

/** 读取带上限的 JSON 请求体，超限或损坏都返回稳定错误码。 */
async function read_json_body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new AppError("request.validation_failed", {
        message: "The bridge request body is too large.",
        public_details: { max_bytes: MAX_BODY_BYTES },
      });
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new AppError("request.invalid_json", { cause: error });
  }
}

function respond_json(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(payload);
}

function read_header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

function read_body_string(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" ? value : null;
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
