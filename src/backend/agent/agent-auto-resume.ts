import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";

/** 外层续跑只承接 SDK 内层重试耗尽后的瞬时故障，次数与等待都必须有界。 */
export const AGENT_AUTO_RESUME_MAX_ATTEMPTS = 5;
export const AGENT_AUTO_RESUME_BASE_DELAY_MS = 5_000;
export const AGENT_AUTO_RESUME_MAX_DELAY_MS = 60_000;

/** 第 1 至 5 次等待分别为 5、10、20、40、60 秒。 */
export function auto_resume_delay_ms(attempt: number): number {
  const normalized = Math.max(1, Math.floor(attempt));
  const delay = AGENT_AUTO_RESUME_BASE_DELAY_MS * 2 ** (normalized - 1);
  return Math.min(delay, AGENT_AUTO_RESUME_MAX_DELAY_MS);
}

/**
 * 复用 SDK 的唯一可重试分类，避免界面或运行时另立一套状态码规则。
 * 分类器只读取 `stopReason` 与 `errorMessage`，这里用最小适配对象隔离完整消息形状。
 */
export function is_retryable_model_error(message: string): boolean {
  return isRetryableAssistantError({
    stopReason: "error",
    errorMessage: message,
  } as AssistantMessage);
}
