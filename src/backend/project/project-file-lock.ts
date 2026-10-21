import lockfile from "proper-lockfile";

import { default_native_fs } from "../../native/native-fs";
import { AppError } from "../../shared/error";

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_RETRIES = 10;
const MIN_RETRY_MS = 100;
const MAX_RETRY_MS = 2_000;

export interface ProjectFileLockOptions {
  stale_ms?: number; // 进程崩溃后锁目录的回收时间
  retries?: number; // 同进程或跨进程等待次数
}

/**
 * 同一 `.lg` 文件的跨进程写锁。进程内互斥仍由 RuntimeOperationGate 负责，
 * 这里只解决多个应用实例同时同步同一工程的情况。
 */
export class ProjectFileLock {
  private readonly stale_ms: number;
  private readonly retries: number;

  public constructor(options: ProjectFileLockOptions = {}) {
    this.stale_ms = options.stale_ms ?? DEFAULT_STALE_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
  }

  public async run<T>(project_path: string, action: () => Promise<T>): Promise<T> {
    // realpath:false 下 proper-lockfile 不会替调用方检查目标文件，这里先确认工程存在。
    if (!default_native_fs.exists(project_path)) {
      throw new AppError("project.not_found");
    }
    let release: (() => Promise<void>) | null = null;
    try {
      release = await lockfile.lock(project_path, {
        realpath: false,
        stale: this.stale_ms,
        retries: {
          retries: this.retries,
          factor: 1.5,
          minTimeout: MIN_RETRY_MS,
          maxTimeout: MAX_RETRY_MS,
          randomize: true,
        },
      });
    } catch (cause) {
      throw map_lock_error(cause);
    }
    let result: T;
    try {
      result = await action();
    } catch (error) {
      await this.release(release, true);
      throw error;
    }
    await this.release(release);
    return result;
  }

  /** 正常情况下释放失败意味着锁可能残留，必须让调用方重新判断工程状态。 */
  private async release(release: () => Promise<void>, suppress = false): Promise<void> {
    try {
      await release();
    } catch (cause) {
      if (suppress) return;
      throw new AppError("database.busy", {
        message: "The project lock could not be released.",
        cause,
        public_details: { lock_release_failed: true },
      });
    }
  }
}

function map_lock_error(cause: unknown): AppError {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? (cause as { code?: unknown }).code
      : null;
  if (code === "ENOENT") return new AppError("project.not_found", { cause });
  return new AppError("database.busy", { cause });
}
