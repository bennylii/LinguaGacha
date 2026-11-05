import { agent_tool_call } from "../../../test/agent-tool-fixture";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
  create_agent_novel_sync_apply_tool,
  type AgentNovelSyncApplyPort,
} from "./novel-sync-apply";

type ApplyToolResult = {
  output: Array<{ type: "text"; text: string }>;
  details: {
    mode: string;
    accepted: boolean;
    updated_sections: string[];
    stats: { added: number; removed: number; would_lose: number };
    chapters: Array<{ index: number; title: string; status: string }>;
    skipped_chapters: string[];
  };
};

function apply_result(): Awaited<ReturnType<AgentNovelSyncApplyPort>> {
  return {
    mode: "auto",
    write: {
      accepted: true,
      changes: [
        {
          type: "project.changed",
          eventId: "event-1",
          source: "remote.sync",
          projectPath: "test.lg",
          projectRevision: 3,
          sectionRevisions: { files: 2, items: 2 },
          updatedSections: ["files", "items"],
          qualityStatisticsScope: "none",
        },
      ],
    },
    binding: {
      origin: "https://n.novelia.cc",
      host: "n.novelia.cc",
      kind: "web",
      provider_id: "novelia",
      novel_id: "n1",
      url: "https://n.novelia.cc/novel/n1",
      title: "测试小说",
      asset_path: "测试小说.txt",
      remote_hash: "hash",
      chapter_count: 2,
      synced_at: "2026-11-03T00:00:00.000Z",
    },
    stats: {
      added: 1,
      modified: 0,
      removed: 0,
      inherited: 10,
      remote_inherited: 0,
      would_lose: 0,
      diverged: false,
      requires_alignment: false,
    },
    chapters: [
      {
        index: 2,
        kind: "chapter",
        title: "新增章",
        status: "added",
        old_index: null,
        start_row: 10,
        end_row: 20,
        added: 1,
        modified: 0,
        removed: 0,
        inherited: 0,
        would_lose: 0,
        removed_lines: [],
      },
    ],
    skipped_chapters: [],
  };
}

describe("Agent novel_sync_apply 工具", () => {
  it("拒绝未知模式与额外字段", () => {
    const tool = create_agent_novel_sync_apply_tool(vi.fn());
    for (const args of [
      { stash_id: "stash-1", mode: "manual" },
      { stash_id: "stash-1", mode: "auto", extra: true },
      { stash_id: "", mode: "auto" },
      { stash_id: "stash-1" },
    ]) {
      expect(() =>
        validateToolArguments(tool, {
          type: "toolCall",
          id: "apply",
          name: tool.name,
          arguments: args,
        } as ToolCall),
      ).toThrow();
    }
  });

  it("提交预览并返回去重后的写入分区", async () => {
    const apply_sync = vi.fn<AgentNovelSyncApplyPort>(async () => apply_result());
    const tool = create_agent_novel_sync_apply_tool(apply_sync);
    const signal = new AbortController().signal;

    const result = (await tool.execute(
      { stash_id: "stash-1", mode: "auto" },
      ...agent_tool_call("apply", signal),
    )) as ApplyToolResult;

    expect(apply_sync).toHaveBeenCalledWith({ stash_id: "stash-1", mode: "auto" }, signal);
    expect(result.details).toMatchObject({
      mode: "auto",
      accepted: true,
      updated_sections: ["files", "items"],
      skipped_chapters: [],
    });
    expect(result.details.chapters[0]).toMatchObject({ index: 2, status: "added" });
  });

  it("调用前已取消时不触达端口", async () => {
    const apply_sync = vi.fn<AgentNovelSyncApplyPort>();
    const controller = new AbortController();
    controller.abort(new Error("提前取消"));

    await expect(
      create_agent_novel_sync_apply_tool(apply_sync).execute(
        { stash_id: "stash-1", mode: "add_only" },
        ...agent_tool_call("apply", controller.signal),
      ),
    ).rejects.toThrow("提前取消");
    expect(apply_sync).not.toHaveBeenCalled();
  });
});
