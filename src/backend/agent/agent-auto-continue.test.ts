import { describe, expect, it } from "vitest";

import {
  is_agent_auto_continue_exhausted,
  read_agent_auto_continue_policy,
} from "./agent-auto-continue";

describe("read_agent_auto_continue_policy", () => {
  it("缺失设置时回落到默认策略", () => {
    expect(read_agent_auto_continue_policy({})).toEqual({
      enabled: false,
      maxContinues: 10,
    });
  });

  it("非法设置按归一化结果读取", () => {
    expect(
      read_agent_auto_continue_policy({
        agent_auto_continue_enabled: "yes",
        agent_auto_continue_max_continues: 9_999,
      }),
    ).toEqual({ enabled: false, maxContinues: 1_000 });
  });

  it("合法设置原样读取", () => {
    expect(
      read_agent_auto_continue_policy({
        agent_auto_continue_enabled: true,
        agent_auto_continue_max_continues: 0,
      }),
    ).toEqual({ enabled: true, maxContinues: 0 });
  });
});

describe("is_agent_auto_continue_exhausted", () => {
  it("不限次数时永远未用尽", () => {
    const policy = { enabled: true, maxContinues: 0 };

    expect(is_agent_auto_continue_exhausted(policy, 0)).toBe(false);
    expect(is_agent_auto_continue_exhausted(policy, 999)).toBe(false);
  });

  it("达到上限即用尽", () => {
    const policy = { enabled: true, maxContinues: 3 };

    expect(is_agent_auto_continue_exhausted(policy, 0)).toBe(false);
    expect(is_agent_auto_continue_exhausted(policy, 2)).toBe(false);
    expect(is_agent_auto_continue_exhausted(policy, 3)).toBe(true);
    expect(is_agent_auto_continue_exhausted(policy, 4)).toBe(true);
  });
});
