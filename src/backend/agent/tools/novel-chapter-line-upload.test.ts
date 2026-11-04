import { agent_tool_call } from "../../../test/agent-tool-fixture";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../../shared/error/app-error";
import {
  create_agent_novel_chapter_line_upload_tool,
  type AgentNovelChapterLineUploadPort,
} from "./novel-chapter-line-upload";

type LineUploadToolResult = {
  output: Array<{ type: "text"; text: string }>;
  details: {
    uploaded: boolean;
    chapter_id: string;
    volume_id: string | null;
    title: string;
    paragraphs: number;
    line: number;
  };
};

const RESULT: Awaited<ReturnType<AgentNovelChapterLineUploadPort>> = {
  uploaded: true,
  chapter_id: "c2",
  volume_id: "v1.txt",
  title: "第二章",
  paragraphs: 3,
  line: 2,
};

describe("Agent novel_chapter_line_upload 工具", () => {
  it("要求整数行号并拒绝额外字段", () => {
    const tool = create_agent_novel_chapter_line_upload_tool(vi.fn());
    for (const args of [
      { chapter_id: "c2", line: 0, text: "译文" },
      { chapter_id: "c2", line: -1, text: "译文" },
      { chapter_id: "c2", line: 1, text: "译文", extra: true },
      { chapter_id: "c2", line: 1 },
    ]) {
      expect(() =>
        validateToolArguments(tool, {
          type: "toolCall",
          id: "line-upload",
          name: tool.name,
          arguments: args,
        } as ToolCall),
      ).toThrow();
    }
  });

  it("调用按行端口并返回行号", async () => {
    const upload_line = vi.fn<AgentNovelChapterLineUploadPort>(async () => RESULT);
    const tool = create_agent_novel_chapter_line_upload_tool(upload_line);
    const signal = new AbortController().signal;

    const result = (await tool.execute(
      { chapter_id: "c2", volume_id: "v1.txt", line: 2, text: "补传译文" },
      ...agent_tool_call("line-upload", signal),
    )) as LineUploadToolResult;

    expect(upload_line).toHaveBeenCalledWith(
      { chapter_id: "c2", volume_id: "v1.txt", line: 2, text: "补传译文" },
      signal,
    );
    expect(result.details).toMatchObject({
      uploaded: true,
      chapter_id: "c2",
      volume_id: "v1.txt",
      paragraphs: 3,
      line: 2,
    });
    expect(result.output[0]?.text).toContain("第二章");
  });

  it("返回未变化回执并规范化空分卷", async () => {
    const upload_line = vi.fn<AgentNovelChapterLineUploadPort>(async () => ({
      ...RESULT,
      uploaded: false,
      unchanged: true,
    }));
    const tool = create_agent_novel_chapter_line_upload_tool(upload_line);

    const result = (await tool.execute(
      { chapter_id: "c2", volume_id: "  ", line: 2, text: "旧二" },
      ...agent_tool_call("line-unchanged", new AbortController().signal),
    )) as LineUploadToolResult;

    expect(upload_line).toHaveBeenCalledWith(
      { chapter_id: "c2", volume_id: null, line: 2, text: "旧二" },
      expect.any(AbortSignal),
    );
    expect(result.details).toMatchObject({
      uploaded: false,
      unchanged: true,
      volume_id: "v1.txt",
      line: 2,
    });
    expect(result.output[0]?.text).toContain('"unchanged":true');
  });

  it("端口错误原样抛出", async () => {
    const failure = new AppError("remote.chapter_line_context_missing");
    const tool = create_agent_novel_chapter_line_upload_tool(async () => {
      throw failure;
    });

    await expect(
      tool.execute(
        { chapter_id: "c2", line: 1, text: "译文" },
        ...agent_tool_call("line-error", new AbortController().signal),
      ),
    ).rejects.toBe(failure);
  });

  it("调用前已取消时不触达端口", async () => {
    const upload_line = vi.fn<AgentNovelChapterLineUploadPort>();
    const controller = new AbortController();
    controller.abort(new Error("提前取消"));

    await expect(
      create_agent_novel_chapter_line_upload_tool(upload_line).execute(
        { chapter_id: "c2", line: 1, text: "译文" },
        ...agent_tool_call("line-upload", controller.signal),
      ),
    ).rejects.toThrow("提前取消");
    expect(upload_line).not.toHaveBeenCalled();
  });
});
