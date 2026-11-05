import { agent_tool_call } from "../../../test/agent-tool-fixture";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
  create_agent_novel_sync_preview_tool,
  type AgentNovelSyncPreviewPort,
} from "./novel-sync-preview";

type PreviewToolResult = {
  output: Array<{ type: "text"; text: string }>;
  details: {
    stash_id: string;
    title: string;
    url: string;
    stats: { added: number; removed: number; requires_alignment: boolean };
    chapters: Array<{ index: number; title: string; status: string }>;
  };
};

function preview_result(): Awaited<ReturnType<AgentNovelSyncPreviewPort>> {
  return {
    stash_id: "stash-1",
    created_at: "2026-11-03T00:00:00.000Z",
    expires_at: "2026-11-03T00:10:00.000Z",
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
      synced_at: "2026-11-01T00:00:00.000Z",
    },
    filename: "测试小说.txt",
    remote_hash: "hash",
    previous_source: "snapshot",
    snapshot_available: true,
    current_asset_changed: false,
    stats: {
      added: 1,
      modified: 0,
      removed: 1,
      inherited: 10,
      remote_inherited: 0,
      would_lose: 0,
      diverged: false,
      requires_alignment: false,
    },
    chapters: [
      {
        index: 1,
        kind: "chapter",
        title: "第一章",
        status: "unchanged",
        old_index: 0,
        start_row: 0,
        end_row: 10,
        added: 0,
        modified: 0,
        removed: 0,
        inherited: 10,
        would_lose: 0,
        removed_lines: [],
      },
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
    files_revision: 1,
    items_revision: 2,
  };
}

describe("Agent novel_sync_preview 工具", () => {
  it("只接受空对象参数并拒绝额外字段", () => {
    const tool = create_agent_novel_sync_preview_tool(vi.fn());
    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "preview",
        name: tool.name,
        arguments: { extra: true },
      } as ToolCall),
    ).toThrow();
  });

  it("调用预览端口并返回章节级差异", async () => {
    const preview_sync = vi.fn<AgentNovelSyncPreviewPort>(async () => preview_result());
    const tool = create_agent_novel_sync_preview_tool(preview_sync);
    const signal = new AbortController().signal;

    const result = (await tool.execute(
      {},
      ...agent_tool_call("preview", signal),
    )) as PreviewToolResult;

    expect(preview_sync).toHaveBeenCalledWith(signal);
    expect(result.details).toMatchObject({
      stash_id: "stash-1",
      title: "测试小说",
      stats: { added: 1, removed: 1, requires_alignment: false },
    });
    expect(result.details.chapters[1]).toMatchObject({ index: 2, status: "added" });
    expect(result.output[0]?.text).toContain("stash-1");
  });

  it("调用前已取消时不触达端口", async () => {
    const preview_sync = vi.fn<AgentNovelSyncPreviewPort>();
    const controller = new AbortController();
    controller.abort(new Error("提前取消"));

    await expect(
      create_agent_novel_sync_preview_tool(preview_sync).execute(
        {},
        ...agent_tool_call("preview", controller.signal),
      ),
    ).rejects.toThrow("提前取消");
    expect(preview_sync).not.toHaveBeenCalled();
  });
});
