import { agent_tool_call } from "../../../test/agent-tool-fixture";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { create_agent_novel_chapters_tool, type AgentNovelChaptersPort } from "./novel-chapters";

type ChaptersToolResult = {
  output: Array<{ type: "text"; text: string }>;
  details: {
    origin: string;
    kind: string;
    total: number;
    offset: number;
    chapters: Array<{
      index: number;
      chapter_id: string;
      volume_id: string | null;
      title: string;
      translated: boolean;
    }>;
  };
};

function list_result(): Awaited<ReturnType<AgentNovelChaptersPort>> {
  return {
    origin: "https://n.novelia.cc",
    host: "n.novelia.cc",
    kind: "web",
    title: "测试小说",
    total: 2,
    offset: 0,
    chapters: [
      { index: 1, chapter_id: "c1", volume_id: null, title: "第一章", translated: true },
      { index: 2, chapter_id: "c2", volume_id: null, title: "第二章", translated: false },
    ],
  };
}

describe("Agent novel_chapters 工具", () => {
  it("只接受对象参数并拒绝额外字段", () => {
    const tool = create_agent_novel_chapters_tool(vi.fn());
    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "list",
        name: tool.name,
        arguments: { query: "x", extra: true },
      } as ToolCall),
    ).toThrow();
  });

  it("调用列表端口并返回章节目录", async () => {
    const list = vi.fn<AgentNovelChaptersPort>(async () => list_result());
    const tool = create_agent_novel_chapters_tool(list);
    const signal = new AbortController().signal;

    const result = (await tool.execute(
      { query: "第一", offset: 0, limit: 20 },
      ...agent_tool_call("list", signal),
    )) as ChaptersToolResult;

    expect(list).toHaveBeenCalledWith({ query: "第一", offset: 0, limit: 20 }, signal);
    expect(result.details).toMatchObject({
      origin: "https://n.novelia.cc",
      kind: "web",
      total: 2,
    });
    expect(result.details.chapters[0]).toMatchObject({ chapter_id: "c1", volume_id: null });
    expect(result.output[0]?.text).toContain("c1");
  });

  it("省略可选参数时使用默认分页", async () => {
    const list = vi.fn<AgentNovelChaptersPort>(async () => list_result());
    const tool = create_agent_novel_chapters_tool(list);

    await tool.execute({}, ...agent_tool_call("list"));

    expect(list).toHaveBeenCalledWith({ query: "", offset: 0, limit: 50 }, expect.anything());
  });

  it("调用前已取消时不触达端口", async () => {
    const list = vi.fn<AgentNovelChaptersPort>();
    const controller = new AbortController();
    controller.abort(new Error("提前取消"));

    await expect(
      create_agent_novel_chapters_tool(list).execute(
        {},
        ...agent_tool_call("list", controller.signal),
      ),
    ).rejects.toThrow("提前取消");
    expect(list).not.toHaveBeenCalled();
  });
});
