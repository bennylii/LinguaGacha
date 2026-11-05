import { agent_tool_call } from "../../../test/agent-tool-fixture";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
  create_agent_novel_chapter_read_tool,
  type AgentNovelChapterReadPort,
} from "./novel-chapter-read";

type ReadToolResult = {
  output: Array<{ type: "text"; text: string }>;
  details: {
    chapter_id: string;
    volume_id: string | null;
    title: string;
    translated: boolean;
    total_paragraphs: number;
    offset: number;
    paragraphs: Array<{ n: number; jp: string; zh: string | null }>;
    glossary_id: string;
    old_glossary_id: string | null;
    translation_current: boolean;
    next_offset: number | null;
    truncated: boolean;
  };
};

function read_result(): Awaited<ReturnType<AgentNovelChapterReadPort>> {
  return {
    chapter_id: "c1",
    volume_id: null,
    title: "第一章",
    translated: true,
    total_paragraphs: 3,
    offset: 0,
    paragraphs: [
      { n: 1, jp: "第一段", zh: "第一段译文" },
      { n: 2, jp: "", zh: "" },
      { n: 3, jp: "第三段", zh: null },
    ],
    glossary_id: "g2",
    old_glossary_id: "g1",
    translation_current: false,
    next_offset: null,
    truncated: false,
  };
}

describe("Agent novel_chapter_read 工具", () => {
  it("要求非空 chapter_id 并拒绝额外字段", () => {
    const tool = create_agent_novel_chapter_read_tool(vi.fn());
    for (const args of [{ chapter_id: "" }, { chapter_id: "c1", extra: true }]) {
      expect(() =>
        validateToolArguments(tool, {
          type: "toolCall",
          id: "read",
          name: tool.name,
          arguments: args,
        } as ToolCall),
      ).toThrow();
    }
  });

  it("调用读取端口并返回段落与术语表事实", async () => {
    const read_chapter = vi.fn<AgentNovelChapterReadPort>(async () => read_result());
    const tool = create_agent_novel_chapter_read_tool(read_chapter);
    const signal = new AbortController().signal;

    const result = (await tool.execute(
      { chapter_id: "c1", volume_id: "v1.txt", offset: 2, limit: 10, max_chars: 500 },
      ...agent_tool_call("read", signal),
    )) as ReadToolResult;

    expect(read_chapter).toHaveBeenCalledWith(
      {
        chapter_id: "c1",
        volume_id: "v1.txt",
        offset: 2,
        limit: 10,
        max_chars: 500,
      },
      signal,
    );
    expect(result.details).toMatchObject({
      chapter_id: "c1",
      title: "第一章",
      total_paragraphs: 3,
      translation_current: false,
    });
    expect(result.details.paragraphs[1]).toMatchObject({ n: 2, jp: "", zh: "" });
    expect(result.details.paragraphs[2]).toMatchObject({ n: 3, zh: null });
    expect(result.output[0]?.text).toContain("c1");
  });

  it("省略可选参数时使用默认分页并把空 volume_id 归一为 null", async () => {
    const read_chapter = vi.fn<AgentNovelChapterReadPort>(async () => read_result());
    const tool = create_agent_novel_chapter_read_tool(read_chapter);

    await tool.execute({ chapter_id: "c1", volume_id: "  " }, ...agent_tool_call("read"));

    expect(read_chapter).toHaveBeenCalledWith(
      {
        chapter_id: "c1",
        volume_id: null,
        offset: 0,
        limit: 100,
        max_chars: 12000,
      },
      expect.anything(),
    );
  });

  it("调用前已取消时不触达端口", async () => {
    const read_chapter = vi.fn<AgentNovelChapterReadPort>();
    const controller = new AbortController();
    controller.abort(new Error("提前取消"));

    await expect(
      create_agent_novel_chapter_read_tool(read_chapter).execute(
        { chapter_id: "c1" },
        ...agent_tool_call("read", controller.signal),
      ),
    ).rejects.toThrow("提前取消");
    expect(read_chapter).not.toHaveBeenCalled();
  });
});
