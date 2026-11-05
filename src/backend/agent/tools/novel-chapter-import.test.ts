import { agent_tool_call } from "../../../test/agent-tool-fixture";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
  create_agent_novel_chapter_import_tool,
  type AgentNovelChapterImportPort,
} from "./novel-chapter-import";

type ImportToolResult = {
  output: Array<{ type: "text"; text: string }>;
  details: {
    imported: boolean;
    asset_path: string | null;
    chapter_id: string;
    volume_id: string | null;
    paragraph_count: number;
    char_count: number;
    reason?: string;
  };
};

function import_result(): Awaited<ReturnType<AgentNovelChapterImportPort>> {
  return {
    imported: true,
    asset_path: "测试小说 - 第一章.txt",
    chapter_id: "c1",
    volume_id: null,
    title: "第一章",
    paragraph_count: 3,
    char_count: 45,
    translated: false,
  };
}

describe("Agent novel_chapter_import 工具", () => {
  it("要求非空 chapter_id 并拒绝额外字段", () => {
    const tool = create_agent_novel_chapter_import_tool(vi.fn());
    for (const args of [{ chapter_id: "" }, { chapter_id: "c1", extra: true }]) {
      expect(() =>
        validateToolArguments(tool, {
          type: "toolCall",
          id: "import",
          name: tool.name,
          arguments: args,
        } as ToolCall),
      ).toThrow();
    }
  });

  it("调用导入端口并返回工作台文件事实", async () => {
    const import_chapter = vi.fn<AgentNovelChapterImportPort>(async () => import_result());
    const tool = create_agent_novel_chapter_import_tool(import_chapter);
    const signal = new AbortController().signal;

    const result = (await tool.execute(
      { chapter_id: "c1", volume_id: "v1.txt" },
      ...agent_tool_call("import", signal),
    )) as ImportToolResult;

    expect(import_chapter).toHaveBeenCalledWith({ chapter_id: "c1", volume_id: "v1.txt" }, signal);
    expect(result.details).toMatchObject({
      imported: true,
      asset_path: "测试小说 - 第一章.txt",
      paragraph_count: 3,
      char_count: 45,
    });
    expect(result.output[0]?.text).toContain("测试小说 - 第一章.txt");
  });

  it("空章节回执保留原因且不构造文件路径", async () => {
    const import_chapter = vi.fn<AgentNovelChapterImportPort>(async () => ({
      imported: false,
      asset_path: null,
      chapter_id: "c2",
      volume_id: null,
      title: "第二章",
      paragraph_count: 0,
      char_count: 0,
      translated: false,
      reason: "chapter_empty" as const,
    }));
    const tool = create_agent_novel_chapter_import_tool(import_chapter);

    const result = (await tool.execute(
      { chapter_id: "c2" },
      ...agent_tool_call("import"),
    )) as ImportToolResult;

    expect(import_chapter).toHaveBeenCalledWith(
      { chapter_id: "c2", volume_id: null },
      expect.anything(),
    );
    expect(result.details).toMatchObject({ imported: false, reason: "chapter_empty" });
    expect(result.details.asset_path).toBeNull();
  });

  it("调用前已取消时不触达端口", async () => {
    const import_chapter = vi.fn<AgentNovelChapterImportPort>();
    const controller = new AbortController();
    controller.abort(new Error("提前取消"));

    await expect(
      create_agent_novel_chapter_import_tool(import_chapter).execute(
        { chapter_id: "c1" },
        ...agent_tool_call("import", controller.signal),
      ),
    ).rejects.toThrow("提前取消");
    expect(import_chapter).not.toHaveBeenCalled();
  });
});
