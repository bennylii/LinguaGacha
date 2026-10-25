import { describe, expect, it } from "vitest";
import {
  type AgentAutoResumePolicy,
  auto_resume_delay_ms,
  is_retryable_model_error,
  read_agent_auto_resume_policy,
} from "./agent-auto-resume";

function policy(overrides: Partial<AgentAutoResumePolicy> = {}): AgentAutoResumePolicy {
  return {
    enabled: true,
    initialDelayMs: 5_000,
    maxDelayMs: 300_000,
    maxAttempts: 0,
    ...overrides,
  };
}

describe("Agent 自动续跑", () => {
  it("默认从五秒开始翻倍并在五分钟封顶", () => {
    expect(
      Array.from({ length: 8 }, (_, index) => auto_resume_delay_ms(index + 1, policy())),
    ).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
    expect(auto_resume_delay_ms(0, policy())).toBe(5_000);
  });

  it("初始间隔与最长间隔由设置决定", () => {
    expect(auto_resume_delay_ms(1, policy({ initialDelayMs: 2_000, maxDelayMs: 9_000 }))).toBe(
      2_000,
    );
    expect(auto_resume_delay_ms(2, policy({ initialDelayMs: 2_000, maxDelayMs: 9_000 }))).toBe(
      4_000,
    );
    expect(auto_resume_delay_ms(3, policy({ initialDelayMs: 2_000, maxDelayMs: 9_000 }))).toBe(
      8_000,
    );
    expect(auto_resume_delay_ms(4, policy({ initialDelayMs: 2_000, maxDelayMs: 9_000 }))).toBe(
      9_000,
    );
  });

  it("最长间隔小于初始间隔时按初始间隔执行", () => {
    expect(auto_resume_delay_ms(1, policy({ initialDelayMs: 30_000, maxDelayMs: 5_000 }))).toBe(
      30_000,
    );
    expect(auto_resume_delay_ms(7, policy({ initialDelayMs: 30_000, maxDelayMs: 5_000 }))).toBe(
      30_000,
    );
  });

  it("超大次数不会产生溢出或超出定时器范围", () => {
    expect(auto_resume_delay_ms(1_000, policy())).toBe(300_000);
    expect(Number.isFinite(auto_resume_delay_ms(Number.MAX_SAFE_INTEGER, policy()))).toBe(true);
  });

  it("从设置读取策略，缺失或非法值回默认", () => {
    expect(read_agent_auto_resume_policy({})).toEqual(policy());
    expect(
      read_agent_auto_resume_policy({
        agent_auto_resume_enabled: false,
        agent_auto_resume_initial_delay: 12,
        agent_auto_resume_max_delay: 600,
        agent_auto_resume_max_attempts: 42,
      }),
    ).toEqual(
      policy({ enabled: false, initialDelayMs: 12_000, maxDelayMs: 600_000, maxAttempts: 42 }),
    );
    expect(
      read_agent_auto_resume_policy({
        agent_auto_resume_initial_delay: "bad",
        agent_auto_resume_max_delay: Number.NaN,
        agent_auto_resume_max_attempts: -1,
      }),
    ).toEqual(policy());
  });

  it.each([
    "429: Too Many Requests",
    "503: Service Unavailable",
    "500: Internal Server Error",
    "Selected model is at capacity",
    "Connection error.",
    "Provider finish_reason: error",
    "Provider finish_reason: network_error",
    "Provider finish_reason: unstable_gateway",
  ])("瞬时模型或传输故障可续跑：%s", (message) => {
    expect(is_retryable_model_error(message)).toBe(true);
  });

  it.each([
    "400: bad request",
    "401: unauthorized",
    "403: forbidden",
    "404: model not found",
    "429: insufficient_quota",
    "billing hard limit reached",
    "quota exceeded",
    "subscription_sharing_usage_limit_exceeded",
    "GoUsageLimitError",
    "FreeUsageLimitError",
    "Provider finish_reason: content_filter",
  ])("确定性或额度错误不续跑：%s", (message) => {
    expect(is_retryable_model_error(message)).toBe(false);
  });
});
