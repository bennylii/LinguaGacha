import {
  normalize_agent_auto_continue_enabled,
  normalize_agent_auto_continue_max_continues,
} from "../../domain/setting";
import type { JsonRecord } from "../../domain/json";

/** 自动继续的运行策略；`maxContinues` 为 0 表示不限次数。 */
export type AgentAutoContinuePolicy = {
  enabled: boolean;
  maxContinues: number;
};

/** 从应用设置读取自动继续策略，缺失或非法值回默认。 */
export function read_agent_auto_continue_policy(setting: JsonRecord): AgentAutoContinuePolicy {
  return {
    enabled: normalize_agent_auto_continue_enabled(setting["agent_auto_continue_enabled"]),
    maxContinues: normalize_agent_auto_continue_max_continues(
      setting["agent_auto_continue_max_continues"],
    ),
  };
}

/** 连续自动继续次数是否已经用尽；不限次数时永远为真。 */
export function is_agent_auto_continue_exhausted(
  policy: AgentAutoContinuePolicy,
  used: number,
): boolean {
  return policy.maxContinues > 0 && used >= policy.maxContinues;
}
