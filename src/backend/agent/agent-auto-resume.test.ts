import { describe, expect, it } from "vitest";
import {
  AGENT_AUTO_RESUME_MAX_ATTEMPTS,
  auto_resume_delay_ms,
  is_retryable_model_error,
} from "./agent-auto-resume";

describe("Agent 自动续跑", () => {
  it("指数退避在第五次封顶", () => {
    expect(
      Array.from({ length: AGENT_AUTO_RESUME_MAX_ATTEMPTS }, (_, index) =>
        auto_resume_delay_ms(index + 1),
      ),
    ).toEqual([5_000, 10_000, 20_000, 40_000, 60_000]);
    expect(auto_resume_delay_ms(0)).toBe(5_000);
    expect(auto_resume_delay_ms(10)).toBe(60_000);
  });

  it.each([
    "429: Too Many Requests",
    "503: Service Unavailable",
    "500: Internal Server Error",
    "Selected model is at capacity",
    "Connection error.",
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
  ])("确定性或额度错误不续跑：%s", (message) => {
    expect(is_retryable_model_error(message)).toBe(false);
  });
});
