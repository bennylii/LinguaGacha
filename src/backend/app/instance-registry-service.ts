import http from "node:http";
import path from "node:path";

import type { AppPathService } from "../app/app-path-service";
import type { ProjectSessionState } from "../project/project-session-state";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import { JsonTool } from "../../shared/utils/json-tool";
import { AppError } from "../../shared/error/app-error";

const INSTANCE_DIRECTORY = "instances";
const INSTANCE_FILE_PATTERN = /^(\d+)\.json$/u;
const HEARTBEAT_INTERVAL_MS = 10_000;
const STALE_AFTER_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;

/** 一个窗口实例的注册项；心跳过期后仍以健康探测结果为准。 */
export interface AppInstanceRecord {
  pid: number;
  api_base_url: string;
  app_version: string;
  project_path: string;
  started_at: string;
  heartbeat_at: string;
}

export interface AppInstanceSnapshot extends AppInstanceRecord {
  current: boolean;
}

export interface AppInstanceOpenResult {
  action: "focused" | "opened";
  instance: AppInstanceSnapshot | null;
}

export interface InstanceRegistryServiceOptions {
  paths: Pick<AppPathService, "get_user_data_path">;
  session_state: Pick<ProjectSessionState, "snapshot" | "subscribe_change">;
  app_version: string;
  focus_window?: () => Promise<void>; // GUI 宿主提供；CLI 缺席时聚焦与开窗均不可用
  open_project_window?: (project_path: string) => Promise<void>;
  native_fs?: NativeFs;
  now?: () => number;
  pid?: number;
  heartbeat_interval_ms?: number;
  stale_after_ms?: number;
  probe_timeout_ms?: number;
}

/**
 * 多进程窗口注册表：每个实例在 userdata/instances/<pid>.json 写入自己的 API 入口与工程，
 * 其他实例据此聚焦已有窗口或复用已打开的工程，避免两个进程同时写同一个 .lg。
 */
export class InstanceRegistryService {
  private readonly paths: InstanceRegistryServiceOptions["paths"];
  private readonly session_state: InstanceRegistryServiceOptions["session_state"];
  private readonly app_version: string;
  private readonly focus_window: (() => Promise<void>) | null;
  private readonly open_project_window: ((project_path: string) => Promise<void>) | null;
  private readonly native_fs: NativeFs;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly heartbeat_interval_ms: number;
  private readonly stale_after_ms: number;
  private readonly probe_timeout_ms: number;

  private api_base_url = "";
  private started_at = "";
  private heartbeat_timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe_session: (() => void) | null = null;
  private stopped = false;

  public constructor(options: InstanceRegistryServiceOptions) {
    this.paths = options.paths;
    this.session_state = options.session_state;
    this.app_version = options.app_version;
    this.focus_window = options.focus_window ?? null;
    this.open_project_window = options.open_project_window ?? null;
    this.native_fs = options.native_fs ?? default_native_fs;
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.heartbeat_interval_ms = options.heartbeat_interval_ms ?? HEARTBEAT_INTERVAL_MS;
    this.stale_after_ms = options.stale_after_ms ?? STALE_AFTER_MS;
    this.probe_timeout_ms = options.probe_timeout_ms ?? PROBE_TIMEOUT_MS;
  }

  /** API 端口在监听成功后才确定，因此注册表在 Gateway 启动后显式开启心跳。 */
  public async start(api_base_url: string): Promise<void> {
    if (this.heartbeat_timer !== null) return;
    this.api_base_url = normalize_api_base_url(api_base_url);
    this.started_at = new Date(this.now()).toISOString();
    this.stopped = false;
    this.native_fs.make_dir(this.get_directory());
    this.write_self();
    this.unsubscribe_session = this.session_state.subscribe_change(() => {
      this.write_self();
    });
    this.heartbeat_timer = setInterval(() => {
      this.write_self_safely();
    }, this.heartbeat_interval_ms);
    this.heartbeat_timer.unref?.();
    await this.remove_stale_instances();
  }

  /** 退出时删除自己的注册文件；其他实例立即看到窗口已关闭。 */
  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat_timer !== null) clearInterval(this.heartbeat_timer);
    this.heartbeat_timer = null;
    this.unsubscribe_session?.();
    this.unsubscribe_session = null;
    try {
      this.native_fs.unlink(this.get_self_path(), { force: true });
    } catch {
      // 注册项清理失败只留下一个很快过期的条目，退出流程不应因此失败。
    }
    await Promise.resolve();
  }

  /** 读取存活实例；心跳过期的条目先探测 /api/health，失败才删除。 */
  public async list(): Promise<AppInstanceSnapshot[]> {
    const records = await this.read_live_records();
    return records
      .map((record) => ({ ...record, current: record.pid === this.pid }))
      .sort((left, right) => {
        if (left.current !== right.current) return left.current ? -1 : 1;
        return right.heartbeat_at.localeCompare(left.heartbeat_at);
      });
  }

  /** 工程已由其他实例打开时返回其注册项，调用方据此聚焦并拒绝重复打开。 */
  public async find_project_owner(project_path: string): Promise<AppInstanceSnapshot | null> {
    const target = this.normalize_project_path(project_path);
    const records = await this.list();
    return (
      records.find((record) => {
        return (
          record.project_path !== "" && this.normalize_project_path(record.project_path) === target
        );
      }) ?? null
    );
  }

  /** 聚焦指定实例；目标为自身时直接走宿主窗口端口。 */
  public async focus(pid: number): Promise<void> {
    const target = (await this.list()).find((record) => record.pid === pid);
    if (target === undefined) throw new AppError("remote.instance_unavailable");
    if (target.current) {
      await this.focus_self();
      return;
    }
    try {
      const status = await request_status(
        `${target.api_base_url}/api/app/focus`,
        "POST",
        this.probe_timeout_ms,
      );
      if (status < 200 || status >= 300) throw new Error(`focus status ${status.toString()}`);
    } catch {
      throw new AppError("remote.instance_unavailable", {
        diagnostic_context: { pid: target.pid },
      });
    }
  }

  /** 本实例窗口聚焦由宿主执行；无窗口的 CLI 入口保持无害空操作。 */
  public async focus_self(): Promise<void> {
    if (this.focus_window === null) return;
    await this.focus_window();
  }

  /**
   * 打开工程：优先聚焦已打开它的窗口，否则请求宿主启动带 --project 的新进程。
   * 注册表写入有短暂延迟，因此刚由本实例打开的工程不会在这里命中其他实例。
   */
  public async open(project_path: string): Promise<AppInstanceOpenResult> {
    const resolved_path = path.resolve(project_path.trim());
    if (!this.native_fs.exists(resolved_path)) {
      throw new AppError("project.not_found", { public_details: { path: resolved_path } });
    }
    const owner = await this.find_project_owner(resolved_path);
    if (owner !== null && !owner.current) {
      await this.focus(owner.pid);
      return { action: "focused", instance: owner };
    }
    if (this.open_project_window === null) throw new AppError("remote.window_unsupported");
    // 传回解析后的原始大小写路径，注册表比较才使用平台归一化形式。
    await this.open_project_window(resolved_path);
    return { action: "opened", instance: null };
  }

  public get_directory(): string {
    return this.paths.get_user_data_path(INSTANCE_DIRECTORY);
  }

  private get_self_path(): string {
    return path.join(this.get_directory(), `${this.pid.toString()}.json`);
  }

  private write_self(): void {
    if (this.api_base_url === "") return;
    const heartbeat_at = new Date(this.now()).toISOString();
    const record: AppInstanceRecord = {
      pid: this.pid,
      api_base_url: this.api_base_url,
      app_version: this.app_version,
      project_path: this.session_state.snapshot().projectPath,
      started_at: this.started_at,
      heartbeat_at,
    };
    this.native_fs.write_file_atomic(this.get_self_path(), JsonTool.stringifyStrict(record));
  }

  /** 心跳写失败保留上一次有效记录，下一个周期会重试。 */
  private write_self_safely(): void {
    try {
      this.write_self();
    } catch {
      // 磁盘暂时不可写时仍允许应用继续运行。
    }
  }

  private async read_live_records(): Promise<AppInstanceRecord[]> {
    const directory = this.get_directory();
    if (!this.native_fs.exists(directory)) return [];
    const names = this.native_fs.read_dir_names(directory);
    const records: AppInstanceRecord[] = [];
    for (const name of names) {
      const match = INSTANCE_FILE_PATTERN.exec(name);
      if (match === null) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      const record = this.read_record(path.join(directory, name));
      if (record === null || record.pid !== pid) {
        this.remove_instance_file(path.join(directory, name));
        continue;
      }
      if (this.now() - Date.parse(record.heartbeat_at) <= this.stale_after_ms) {
        records.push(record);
        continue;
      }
      if (await this.probe_health(record)) {
        records.push(record);
        continue;
      }
      this.remove_instance_file(path.join(directory, name));
    }
    return records;
  }

  private async remove_stale_instances(): Promise<void> {
    await this.read_live_records();
  }

  private read_record(record_path: string): AppInstanceRecord | null {
    try {
      const value = JsonTool.parseStrict(this.native_fs.read_file(record_path));
      return parse_instance_record(value);
    } catch {
      return null;
    }
  }

  private remove_instance_file(record_path: string): void {
    try {
      this.native_fs.unlink(record_path, { force: true });
    } catch {
      // 删除失败的文件下次读取会再次尝试，不影响当前列表。
    }
  }

  private async probe_health(record: AppInstanceRecord): Promise<boolean> {
    try {
      return (
        (await request_status(
          `${record.api_base_url}/api/health`,
          "GET",
          this.probe_timeout_ms,
        )) === 200
      );
    } catch {
      return false;
    }
  }

  /** 工程路径按平台比较；Windows 盘符与大小写差异不应产生两个身份。 */
  private normalize_project_path(project_path: string): string {
    const resolved = path.resolve(project_path.trim());
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
}

function parse_instance_record(value: unknown): AppInstanceRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pid = record["pid"];
  const api_base_url = record["api_base_url"];
  const app_version = record["app_version"];
  const project_path = record["project_path"];
  const started_at = record["started_at"];
  const heartbeat_at = record["heartbeat_at"];
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof app_version !== "string" || typeof project_path !== "string") return null;
  if (!is_timestamp(started_at) || !is_timestamp(heartbeat_at)) return null;
  if (typeof api_base_url !== "string") return null;
  try {
    normalize_api_base_url(api_base_url);
  } catch {
    return null;
  }
  return {
    pid,
    api_base_url,
    app_version,
    project_path,
    started_at,
    heartbeat_at,
  };
}

function is_timestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** 注册表只接受本机回环入口，避免损坏文件把请求引向任意主机。 */
function normalize_api_base_url(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.port === "") {
    throw new TypeError("Instance API base URL must be loopback HTTP with an explicit port.");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new TypeError("Instance API base URL must target the loopback host.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

function request_status(
  target_url: string,
  method: "GET" | "POST",
  timeout_ms: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const request = http.request(
      target_url,
      {
        method,
        timeout: timeout_ms,
        headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("Instance request timed out."));
    });
    request.on("error", reject);
    if (method === "POST") request.end("{}");
    else request.end();
  });
}
