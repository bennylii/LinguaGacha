import { agent_tool_call } from "../../../test/agent-tool-fixture";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../../shared/error/app-error";
import {
  create_agent_novel_source_rebind_tool,
  type AgentNovelSourceRebindPort,
} from "./novel-source-rebind";

type RebindToolResult = {
  output: Array<{ type: "text"; text: string }>;
  details: {
    changed: boolean;
    previous: { url: string; title: string; kind: string };
    current: { url: string; title: string; kind: string; chapter_count: number };
    asset_path: string;
    text_matches: boolean | null;
  };
};

const RESULT: Awaited<ReturnType<AgentNovelSourceRebindPort>> = {
  changed: true,
  previous: {
    url: "https://n.novelia.cc/novel/kakuyomu/12345",
    title: "旧作品",
    kind: "web",
  },
  current: {
    url: "https://n.novelia.cc/novel/kakuyomu/67890",
    title: "新作品",
    kind: "web",
    chapter_count: 2,
  },
  asset_path: "测试小说.txt",
  text_matches: false,
};

describe("Agent novel_source_rebind 工具", () => {
  it("要求非空 URL 并拒绝额外字段", () => {
    const tool = create_agent_novel_source_rebind_tool(vi.fn());
    for (const args of [{ url: "" }, { url: RESULT.current.url, extra: true }, {}]) {
      expect(() =>
        validateToolArguments(tool, {
          type: "toolCall",
          id: "rebind",
          name: tool.name,
          arguments: args,
        } as ToolCall),
      ).toThrow();
    }
  });

  it("调用换源端口并返回前后身份与文本提示", async () => {
    const rebind_source = vi.fn<AgentNovelSourceRebindPort>(async () => RESULT);
    const tool = create_agent_novel_source_rebind_tool(rebind_source);
    const signal = new AbortController().signal;

    const result = (await tool.execute(
      { url: RESULT.current.url },
      ...agent_tool_call("rebind", signal),
    )) as RebindToolResult;

    expect(rebind_source).toHaveBeenCalledWith({ url: RESULT.current.url }, signal);
    expect(result.details).toMatchObject({
      changed: true,
      asset_path: "测试小说.txt",
      text_matches: false,
      current: { title: "新作品", chapter_count: 2 },
    });
    expect(result.output[0]?.text).toContain("新作品");
  });

  it("同 URL 返回不变回执且不提示文本匹配", async () => {
    const rebind_source = vi.fn<AgentNovelSourceRebindPort>(async () => ({
      ...RESULT,
      changed: false,
      text_matches: null,
    }));
    const tool = create_agent_novel_source_rebind_tool(rebind_source);

    const result = (await tool.execute(
      { url: RESULT.current.url },
      ...agent_tool_call("rebind-noop", new AbortController().signal),
    )) as RebindToolResult;

    expect(result.details).toMatchObject({
      changed: false,
      text_matches: null,
      current: { url: RESULT.current.url, chapter_count: 2 },
    });
    expect(result.output[0]?.text).toContain('"text_matches":null');
  });

  it("端口错误原样抛出", async () => {
    const failure = new AppError("remote.source_not_bound");
    const tool = create_agent_novel_source_rebind_tool(async () => {
      throw failure;
    });

    await expect(
      tool.execute(
        { url: RESULT.current.url },
        ...agent_tool_call("rebind-error", new AbortController().signal),
      ),
    ).rejects.toBe(failure);
  });

  it("调用前已取消时不触达端口", async () => {
    const rebind_source = vi.fn<AgentNovelSourceRebindPort>();
    const controller = new AbortController();
    controller.abort(new Error("提前取消"));

    await expect(
      create_agent_novel_source_rebind_tool(rebind_source).execute(
        { url: RESULT.current.url },
        ...agent_tool_call("rebind", controller.signal),
      ),
    ).rejects.toThrow("提前取消");
    expect(rebind_source).not.toHaveBeenCalled();
  });
});
