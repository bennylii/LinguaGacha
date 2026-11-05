import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { RemoteSyncPreview } from "../../remote/novel-source-service";
import { agent_tool_result, define_agent_tool } from "../tool-definition";

/** 预览端口下载远端全文并生成差异；绑定与登录前置条件由服务边界校验。 */
export type AgentNovelSyncPreviewPort = (signal: AbortSignal) => Promise<RemoteSyncPreview>;

/** 下载整本并与上次同步快照比对，返回章节级差异供提交前确认。 */
export function create_agent_novel_sync_preview_tool(
  preview_sync: AgentNovelSyncPreviewPort,
): ToolRegistration {
  return define_agent_tool({
    name: "novel_sync_preview",
    description: [
      "下载当前工程绑定的 n.novelia.cc 作品全文，并与上次同步的远端快照比对，返回章节级差异。",
      "",
      "### 前置条件",
      "",
      "- 工程由 n.novelia.cc 链接创建；未绑定时返回 `remote.source_not_bound`。",
      "- 程序已登录 n.novelia.cc；未登录返回 `remote.auth_missing`，请提示用户在「远程」页登录。",
      "",
      "### 执行",
      "",
      "- 下载整本可能耗时；取消信号会中止下载。",
      "- 只写进程内预览暂存，不修改工程，不需要写租约或审批。",
      "- 预览 10 分钟内有效，进程内只保留最近一次；新的预览（包括界面上的预览）会覆盖旧暂存。",
      "- `remote.stash_expired` 表示暂存已被替换或过期，重新预览即可。",
      "",
      "### 返回",
      "",
      "- `stats` 汇总新增、修改、删除、继承与 `would_lose`；`stats.requires_alignment` 为真时 `auto` 会拒绝提交。",
      "- `chapters[].status`：`added` 站点新增（含中间插入的章节），`modified` 章内有变化，`removed` 站点已删除，`unchanged` 无变化，`ambiguous` 只能按位置配对。",
      "- `current_asset_changed` 表示本地资产在上次同步后被修改，差异以当前资产为基准重新对齐。",
      "- 需要提交时把 `stash_id` 传给 `novel_sync_apply`。",
    ].join("\n"),
    executionMode: "sequential",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async (_params, _api, context) => {
      const signal = context.abortSignal ?? new AbortController().signal;
      signal.throwIfAborted();
      const result = await preview_sync(signal);
      return agent_tool_result({
        stash_id: result.stash_id,
        expires_at: result.expires_at,
        title: result.binding.title,
        url: result.binding.url,
        previous_source: result.previous_source,
        snapshot_available: result.snapshot_available,
        current_asset_changed: result.current_asset_changed,
        stats: {
          added: result.stats.added,
          modified: result.stats.modified,
          removed: result.stats.removed,
          inherited: result.stats.inherited,
          remote_inherited: result.stats.remote_inherited,
          would_lose: result.stats.would_lose,
          diverged: result.stats.diverged,
          requires_alignment: result.stats.requires_alignment,
        },
        chapters: result.chapters.map((chapter) => ({
          index: chapter.index,
          kind: chapter.kind,
          title: chapter.title,
          status: chapter.status,
          old_index: chapter.old_index,
          added: chapter.added,
          modified: chapter.modified,
          removed: chapter.removed,
          inherited: chapter.inherited,
          would_lose: chapter.would_lose,
        })),
      });
    },
  });
}
