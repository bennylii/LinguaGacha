import { agent_tool_call } from "../../../test/agent-tool-fixture";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
  create_agent_novel_chapter_sync_tool,
  type AgentNovelChapterSyncPort,
} from "./novel-chapter-sync";

type SyncToolResult = {
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

function sync_result(): Awaited<ReturnType<AgentNovelChapterSyncPort>> {
  return {
    chapter_id: "c1",
    volume_id: null,
    title: "第一章",
    translated: false,
    total_paragraphs: 2,
    offset: 0,
    paragraphs: [
      { n: 1, jp: "同步后的第一段", zh: null },
      { n: 2, jp: "同步后的第二段", zh: "旧译文" },
    ],
    glossary_id: "g2",
    old_glossary_id: "g1",
    translation_current: false,
    next_offset: null,
    truncated: false,
  };
}

describe("Agent novel_chapter_sync 工具", () => {
  it("要求非空 chapter_id 并拒绝额外字段", () => {
    const tool = create_agent_novel_chapter_sync_tool(vi.fn());
    for (const args of [{ chapter_id: "" }, { chapter_id: "c1", extra: true }]) {
      expect(() =>
        validateToolArguments(tool, {
          type: "toolCall",
          id: "sync",
          name: tool.name,
          arguments: args,
        } as ToolCall),
      ).toThrow();
    }
  });

  it("调用同步端口并返回抓取后的段落事实", async () => {
    const sync_chapter = vi.fn<AgentNovelChapterSyncPort>(async () => sync_result());
    const tool = create_agent_novel_chapter_sync_tool(sync_chapter);
    const signal = new AbortController().signal;

    const result = (await tool.execute(
      { chapter_id: "c1", offset: 1, limit: 10, max_chars: 500 },
      ...agent_tool_call("sync", signal),
    )) as SyncToolResult;

    expect(sync_chapter).toHaveBeenCalledWith(
      {
        chapter_id: "c1",
        volume_id: null,
        offset: 1,
        limit: 10,
        max_chars: 500,
      },
      signal,
    );
    expect(result.details).toMatchObject({
      chapter_id: "c1",
      title: "第一章",
      total_paragraphs: 2,
      translation_current: false,
    });
    expect(result.details.paragraphs[1]).toMatchObject({ n: 2, jp: "同步后的第二段", zh: "旧译文" });
    expect(result.output[0]?.text).toContain("c1");
  });

  it("省略可选参数时使用默认分页并把空 volume_id 归一为 null", async () => {
    const sync_chapter = vi.fn<AgentNovelChapterSyncPort>(async () => sync_result());
    const tool = create_agent_novel_chapter_sync_tool(sync_chapter);

    await tool.execute({ chapter_id: "c1", volume_id: "  " }, ...agent_tool_call("sync"));

    expect(sync_chapter).toHaveBeenCalledWith(
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
    const sync_chapter = vi.fn<AgentNovelChapterSyncPort>();
    const controller = new AbortController();
    controller.abort(new Error("提前取消"));

    await expect(
      create_agent_novel_chapter_sync_tool(sync_chapter).execute(
        { chapter_id: "c1" },
        ...agent_tool_call("sync", controller.signal),
      ),
    ).rejects.toThrow("提前取消");
    expect(sync_chapter).not.toHaveBeenCalled();
  });
});
