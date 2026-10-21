import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";

import type { JsonRecord } from "../../domain/json";
import {
  normalize_agent_auto_resume_enabled,
  normalize_agent_auto_resume_initial_delay,
  normalize_agent_auto_resume_max_attempts,
  normalize_agent_auto_resume_max_delay,
} from "../../domain/setting";

/** 外层自动重试策略；次数为 0 时持续重试，等待间隔按指数增长并封顶。 */
export type AgentAutoResumePolicy = {
  enabled: boolean;
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number; // 0 表示不限
};

/** 读取设置快照中的自动重试策略，缺失或非法值由领域归一化回默认。 */
export function read_agent_auto_resume_policy(setting: JsonRecord): AgentAutoResumePolicy {
  return {
    enabled: normalize_agent_auto_resume_enabled(setting["agent_auto_resume_enabled"]),
    initialDelayMs:
      normalize_agent_auto_resume_initial_delay(setting["agent_auto_resume_initial_delay"]) * 1_000,
    maxDelayMs:
      normalize_agent_auto_resume_max_delay(setting["agent_auto_resume_max_delay"]) * 1_000,
    maxAttempts: normalize_agent_auto_resume_max_attempts(
      setting["agent_auto_resume_max_attempts"],
    ),
  };
}

/** 第 N 次等待从初始间隔开始翻倍，达到最长间隔后固定。 */
export function auto_resume_delay_ms(attempt: number, policy: AgentAutoResumePolicy): number {
  const normalized = Math.max(1, Math.floor(attempt));
  const base = Math.max(1, Math.floor(policy.initialDelayMs));
  const max_delay = Math.max(base, Math.floor(policy.maxDelayMs));
  // 指数超过 31 时 2 的幂已超出 setTimeout 可表示范围，直接使用封顶值。
  if (normalized - 1 >= 31) return max_delay;
  return Math.min(base * 2 ** (normalized - 1), max_delay);
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
