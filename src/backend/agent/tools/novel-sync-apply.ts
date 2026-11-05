import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { RemoteSyncApplyResult, RemoteSyncMode } from "../../remote/novel-source-service";
import { agent_tool_result, define_agent_tool } from "../tool-definition";

/** 提交端口替换绑定资产并重建条目；运行租约与修订校验由服务边界负责。 */
export type AgentNovelSyncApplyPort = (
  request: { stash_id: string; mode: Extract<RemoteSyncMode, "auto" | "add_only"> },
  signal: AbortSignal,
) => Promise<RemoteSyncApplyResult>;

/** 按预览差异整篇替换绑定资产；新增章节和段落随远端位置落位。 */
export function create_agent_novel_sync_apply_tool(
  apply_sync: AgentNovelSyncApplyPort,
): ToolRegistration {
  return define_agent_tool({
    name: "novel_sync_apply",
    description: [
      "按 `novel_sync_preview` 的差异提交同步：整篇替换绑定资产并重建条目。",
      "",
      "### 前置条件",
      "",
      "- 先调用 `novel_sync_preview` 取得 `stash_id`；预览过期或被覆盖时返回 `remote.stash_expired`。",
      "- 预览之后工程被修改（文件或条目修订变化）时返回 `data.revision_conflict` 或 `remote.alignment_stale`，需要重新预览。",
      "",
      "### 模式",
      "",
      "- `auto`：按预览计划应用。站点新增的章节会落在站点对应的位置，章内新增段落落在对应行；远端删除的章节连同译文一起移除。`stats.requires_alignment` 为真时返回 `remote.alignment_required`，不写入。",
      "- `add_only`：只把新增章节追加到文件末尾，已有章节的修改、删除和歧义章节跳过；中间新增的章节不会回到正确位置。",
      "",
      "### 提交前",
      "",
      "- 提交会删除 `chapters[].status` 为 `removed` 的章节及其译文。先把 `stats` 与删除项报告给用户，再决定是否提交。",
      "- 匹配行的条目 id 与译文保留；新增行采用站点已有译文，站点没有译文时落为待译条目。",
      "",
      "### 返回",
      "",
      "- `updated_sections` 含 `files` 与 `items`：工作区快照随之失效，后续操作必须重新 `workspace_run`。",
      "- `skipped_chapters` 是 `add_only` 跳过的章节标题。",
    ].join("\n"),
    executionMode: "sequential",
    parameters: Type.Object(
      {
        stash_id: Type.String({
          minLength: 1,
          description: "`novel_sync_preview` 返回的预览暂存 ID。",
        }),
        mode: Type.Union([Type.Literal("auto"), Type.Literal("add_only")], {
          description: "`auto` 按远端位置增删改；`add_only` 只追加新增章节到末尾。",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (params, _api, context) => {
      const signal = context.abortSignal ?? new AbortController().signal;
      signal.throwIfAborted();
      const result = await apply_sync({ stash_id: params.stash_id, mode: params.mode }, signal);
      const updated_sections = Array.from(
        new Set(result.write.changes.flatMap((change) => change.updatedSections)),
      );
      return agent_tool_result({
        mode: result.mode,
        accepted: result.write.accepted,
        updated_sections,
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
          added: chapter.added,
          modified: chapter.modified,
          removed: chapter.removed,
          inherited: chapter.inherited,
          would_lose: chapter.would_lose,
        })),
        skipped_chapters: [...result.skipped_chapters],
      });
    },
  });
}
