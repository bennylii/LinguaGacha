import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { agent_tool_call } from "../../../test/agent-tool-fixture";
import {
  create_agent_lookup_term_tool,
  type AgentTermLookupPort,
  type TermLookupResult,
} from "./lookup-term";

type LookupToolResult = {
  output: Array<{ type: "text"; text: string }>;
  details: TermLookupResult;
};

const result: TermLookupResult = {
  query: "セラ",
  languages: { source: "JA", target: "ZH", isDefault: true },
  results: [
    {
      source: "wikipedia",
      language: "ja",
      title: "セラ",
      url: "https://ja.wikipedia.org/wiki/セラ",
      summary: "人物",
      readings: [],
      senses: [],
      names: [],
    },
  ],
  attribution: ["Wikimedia"],
  warnings: [],
  truncated: false,
};

function validate(tool: ReturnType<typeof create_agent_lookup_term_tool>, arguments_: unknown) {
  return () =>
    validateToolArguments(tool, {
      type: "toolCall",
      id: "lookup",
      name: tool.name,
      arguments: arguments_,
    } as ToolCall);
}

describe("Agent lookup_term 工具", () => {
  it("模型参数只接受非空查询、已知且不重复的来源", () => {
    const tool = create_agent_lookup_term_tool(vi.fn());

    expect(validate(tool, { query: "セラ" })).not.toThrow();
    expect(validate(tool, { query: "セラ", sources: ["wikipedia", "jmdict"] })).not.toThrow();

    for (const arguments_ of [
      { query: "" },
      { query: "セラ", extra: true },
      { query: "セラ", sources: [] },
      { query: "セラ", sources: ["unknown"] },
      { query: "セラ", sources: ["jmdict", "jmdict"] },
    ]) {
      expect(validate(tool, arguments_)).toThrow();
    }
  });

  it("省略来源时传递默认语言组合，并投影结构化查证结果", async () => {
    const lookup = vi.fn<AgentTermLookupPort>(async () => result);
    const tool = create_agent_lookup_term_tool(lookup);
    const signal = new AbortController().signal;

    const tool_result = (await tool.execute(
      { query: " セラ " },
      ...agent_tool_call("lookup", signal),
    )) as unknown as LookupToolResult;

    expect(lookup).toHaveBeenCalledWith(
      {
        query: " セラ ",
        languages: { source: "JA", target: "ZH", isDefault: true },
      },
      signal,
    );
    expect(tool_result.details).toEqual(result);
    expect(JSON.parse(tool_result.output[0]?.text ?? "")).toEqual(result);
  });

  it("显式来源原样传递给查询端口", async () => {
    const lookup = vi.fn<AgentTermLookupPort>(async () => result);
    const tool = create_agent_lookup_term_tool(lookup);
    const signal = new AbortController().signal;

    await tool.execute(
      { query: "セラ", sources: ["jmdict"] },
      ...agent_tool_call("lookup", signal),
    );

    expect(lookup).toHaveBeenCalledWith(
      {
        query: "セラ",
        sources: ["jmdict"],
        languages: { source: "JA", target: "ZH", isDefault: true },
      },
      signal,
    );
  });

  it("调用前已取消时不触达查证端口", async () => {
    const lookup = vi.fn<AgentTermLookupPort>();
    const controller = new AbortController();
    controller.abort(new Error("提前取消"));

    await expect(
      create_agent_lookup_term_tool(lookup).execute(
        { query: "不会查询" },
        ...agent_tool_call("lookup", controller.signal),
      ),
    ).rejects.toThrow("提前取消");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("查证端口异常原样传播，不伪造空结果", async () => {
    const lookup = vi.fn<AgentTermLookupPort>(async () => {
      throw new Error("lookup failed");
    });

    await expect(
      create_agent_lookup_term_tool(lookup).execute(
        { query: "セラ" },
        ...agent_tool_call("lookup"),
      ),
    ).rejects.toThrow("lookup failed");
  });
});
