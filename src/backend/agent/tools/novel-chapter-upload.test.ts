import { agent_tool_call } from "../../../test/agent-tool-fixture";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../../shared/error/app-error";
import {
  create_agent_novel_chapter_upload_tool,
  type AgentNovelChapterUploadPort,
} from "./novel-chapter-upload";

type UploadToolResult = {
  output: Array<{ type: "text"; text: string }>;
  details: {
    uploaded: boolean;
    unchanged?: true;
    chapter_id: string;
    volume_id: string | null;
    title: string;
    paragraphs: number;
  };
};

const RESULT: Awaited<ReturnType<AgentNovelChapterUploadPort>> = {
  uploaded: true,
  chapter_id: "c2",
  volume_id: null,
  title: "第二章",
  paragraphs: 2,
};

describe("Agent novel_chapter_upload 工具", () => {
  it("要求 chapter_id 并拒绝额外字段", () => {
    const tool = create_agent_novel_chapter_upload_tool(vi.fn());
    for (const args of [
      { chapter_id: "", text: "译文" },
      { chapter_id: "c2", text: "译文", extra: true },
      { chapter_id: "c2" },
    ]) {
      expect(() =>
        validateToolArguments(tool, {
          type: "toolCall",
          id: "upload",
          name: tool.name,
          arguments: args,
        } as ToolCall),
      ).toThrow();
    }
  });

  it("规范化空白分卷并返回整章回执", async () => {
    const upload_chapter = vi.fn<AgentNovelChapterUploadPort>(async () => RESULT);
    const tool = create_agent_novel_chapter_upload_tool(upload_chapter);
    const signal = new AbortController().signal;

    const result = (await tool.execute(
      { chapter_id: "c2", volume_id: "  ", text: "第一段译文\n第二段译文" },
      ...agent_tool_call("upload", signal),
    )) as UploadToolResult;

    expect(upload_chapter).toHaveBeenCalledWith(
      { chapter_id: "c2", volume_id: null, text: "第一段译文\n第二段译文" },
      signal,
    );
    expect(result.details).toMatchObject({
      uploaded: true,
      chapter_id: "c2",
      volume_id: null,
      paragraphs: 2,
    });
    expect(result.output[0]?.text).toContain("第二章");
  });

  it("返回未变化回执", async () => {
    const upload_chapter = vi.fn<AgentNovelChapterUploadPort>(async () => ({
      ...RESULT,
      uploaded: false,
      unchanged: true,
    }));
    const tool = create_agent_novel_chapter_upload_tool(upload_chapter);

    const result = (await tool.execute(
      { chapter_id: "c2", text: "旧一\n旧二" },
      ...agent_tool_call("upload-unchanged", new AbortController().signal),
    )) as UploadToolResult;

    expect(result.details).toMatchObject({
      uploaded: false,
      unchanged: true,
      chapter_id: "c2",
      paragraphs: 2,
    });
    expect(result.output[0]?.text).toContain('"unchanged":true');
  });

  it("端口错误原样抛出", async () => {
    const failure = new AppError("remote.chapter_paragraph_empty");
    const tool = create_agent_novel_chapter_upload_tool(async () => {
      throw failure;
    });

    await expect(
      tool.execute(
        { chapter_id: "c2", text: "译文" },
        ...agent_tool_call("upload-error", new AbortController().signal),
      ),
    ).rejects.toBe(failure);
  });

  it("调用前已取消时不触达端口", async () => {
    const upload_chapter = vi.fn<AgentNovelChapterUploadPort>();
    const controller = new AbortController();
    controller.abort(new Error("提前取消"));

    await expect(
      create_agent_novel_chapter_upload_tool(upload_chapter).execute(
        { chapter_id: "c2", text: "译文" },
        ...agent_tool_call("upload", controller.signal),
      ),
    ).rejects.toThrow("提前取消");
    expect(upload_chapter).not.toHaveBeenCalled();
  });
});
