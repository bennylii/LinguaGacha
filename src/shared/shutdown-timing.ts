/**
 * 退出链路的分段上限。日志索引互锁、压缩中的会话或宿主回调都可能永久不结算，
 * 每一段都有界，超时后由上层直接终止 worker 与进程。main 与 worker 共用这些值。
 */
export const SHUTDOWN_STAGE_TIMEOUT_MS = 15_000;
export const SHUTDOWN_TOTAL_TIMEOUT_MS = 25_000;
export const WORKER_STOP_TIMEOUT_MS = 35_000;
export const WORKER_TERMINATE_TIMEOUT_MS = 5_000;
export const APP_QUIT_WATCHDOG_MS = 45_000;
export const RENDERER_QUIT_TIMEOUT_MS = 10_000;
