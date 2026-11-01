import path from "node:path";
import process from "node:process";

import { NativeFs, default_native_fs } from "./native-fs";

/**
 * 退出链路埋点。日志系统本身可能正是卡住退出的一环，追踪不能经过 LogManager，
 * 只按进程追加独立文件，让部署件在卡死时也能留下最后到达的退出阶段。
 */
export type ShutdownTrace = (event: string, detail?: Record<string, unknown>) => void;

export interface ShutdownTraceOptions {
  directory: string | null; // 与业务日志同目录；日志目录尚未确定时只写 stderr
  scope: "main" | "backend"; // main 与 worker 同 PID，只能靠作用域区分文件
  nativeFs?: NativeFs;
  now?: () => Date;
}

const TRACE_FILE_PREFIX = "shutdown";

/**
 * 创建退出追踪写入器。目录不可用或写入失败时退化为 stderr，
 * 不创建目录、不重试，避免诊断本身成为新的失败点。
 */
export function create_shutdown_trace(options: ShutdownTraceOptions): ShutdownTrace {
  const native_fs = options.nativeFs ?? default_native_fs;
  const now = options.now ?? (() => new Date());
  const file_path =
    options.directory === null
      ? null
      : path.join(
          options.directory,
          `${TRACE_FILE_PREFIX}.${options.scope}.${String(process.pid)}.log`,
        );
  let is_available = file_path !== null && native_fs.exists(options.directory ?? "");
  return (event, detail) => {
    const line = `${now().toISOString()} ${options.scope} ${event}${format_detail(detail)}\n`;
    if (is_available && file_path !== null) {
      try {
        native_fs.append_text_file(file_path, line);
        return;
      } catch {
        // 目录或磁盘故障后不再重试，后续追踪统一走 stderr。
        is_available = false;
      }
    }
    try {
      process.stderr.write(`[shutdown] ${line}`);
    } catch {
      // stderr 已是最低层出口，写不出去也不能让退出流程再次抛错。
    }
  };
}

/** 详情序列化失败时保留事件本身，避免诊断载荷掩盖退出阶段。 */
function format_detail(detail: Record<string, unknown> | undefined): string {
  if (detail === undefined) return "";
  try {
    return ` ${JSON.stringify(detail)}`;
  } catch {
    return " {}";
  }
}
