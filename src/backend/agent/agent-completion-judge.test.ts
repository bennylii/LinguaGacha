import { describe, expect, it } from "vitest";

import {
  format_agent_completion_judge_prompt,
  parse_agent_completion_verdict,
} from "./agent-completion-judge";

describe("parse_agent_completion_verdict", () => {
  it("识别 DONE 并取下一行作为依据", () => {
    const verdict = parse_agent_completion_verdict(
      "VERDICT: DONE\n账本显示 scope 120 条、visited 120 条、remaining 0。",
    );

    expect(verdict.completed).toBe(true);
    expect(verdict.reason).toBe("账本显示 scope 120 条、visited 120 条、remaining 0。");
  });

  it("识别 CONTINUE 并保留未完成依据", () => {
    const verdict = parse_agent_completion_verdict(
      "VERDICT: CONTINUE\nwork/proofreading-TASK.json 的 remaining_count 仍是 12。",
    );

    expect(verdict.completed).toBe(false);
    expect(verdict.reason).toBe("work/proofreading-TASK.json 的 remaining_count 仍是 12。");
  });

  it("接受全角冒号与大小写混写", () => {
    expect(parse_agent_completion_verdict("verdict：continue\n还有 3 条。").completed).toBe(false);
    expect(parse_agent_completion_verdict("Verdict: Done\n已完成。").completed).toBe(true);
  });

  it("结论行前存在说明文字时仍能定位依据", () => {
    const verdict = parse_agent_completion_verdict(
      "我先看了一下账本。\nVERDICT: CONTINUE\nremaining_count 为 5。",
    );

    expect(verdict.completed).toBe(false);
    expect(verdict.reason).toBe("remaining_count 为 5。");
  });

  it("无法解析结论时按已完成处理", () => {
    const verdict = parse_agent_completion_verdict("看起来差不多了。");

    expect(verdict.completed).toBe(true);
    expect(verdict.reason).toBe("判定结论无法解析，按已完成处理。");
  });

  it("只有结论行没有依据时给出缺省依据", () => {
    const verdict = parse_agent_completion_verdict("VERDICT: DONE");

    expect(verdict.completed).toBe(true);
    expect(verdict.reason).toBe("判定线程未给出依据。");
  });

  it("不采信夹在正文中间的结论词", () => {
    expect(parse_agent_completion_verdict("总 VERDICT: DONE 写在这里。").completed).toBe(true);
  });
});

describe("format_agent_completion_judge_prompt", () => {
  it("任务与答复都进入判定输入", () => {
    const prompt = format_agent_completion_judge_prompt("校对第 3 章", "已经处理完 12 条。");

    expect(prompt).toContain("校对第 3 章");
    expect(prompt).toContain("已经处理完 12 条。");
    expect(prompt).toContain("VERDICT: DONE");
    expect(prompt).toContain("VERDICT: CONTINUE");
  });

  it("超长输入被截断且标注截断", () => {
    const prompt = format_agent_completion_judge_prompt("任".repeat(5_000), "答".repeat(5_000));

    expect(prompt).toContain("已截断");
    expect(prompt).not.toContain("任".repeat(4_001));
    expect(prompt).not.toContain("答".repeat(4_001));
  });

  it("未超长的输入保持原样", () => {
    const prompt = format_agent_completion_judge_prompt("短任务", "短答复");

    expect(prompt).not.toContain("已截断");
    expect(prompt).toContain("短任务");
    expect(prompt).toContain("短答复");
  });
});
