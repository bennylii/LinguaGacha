import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { RemoteChapterUploadResult } from "../../remote/remote-chapter-service";
import { agent_tool_result, define_agent_tool } from "../tool-definition";

/** 整章上传端口把 Agent 文本写入站点；行数和身份校验由服务边界负责。 */
export type AgentNovelChapterUploadPort = (
  request: { chapter_id: string; volume_id: string | null; text: string },
  signal: AbortSignal,
) => Promise<RemoteChapterUploadResult>;

/** 按站点段落逐行提交一章译文；一次只写一章。 */
export function create_agent_novel_chapter_upload_tool(
  upload_chapter: AgentNovelChapterUploadPort,
): ToolRegistration {
  return define_agent_tool({
    name: "novel_chapter_upload",
    description: [
      "把一章译文上传到当前绑定小说在 n.novelia.cc 的 GPT 工作区。",
      "",
      "### 前置条件",
      "",
      "- 工程必须已有 `remote_source` 绑定；未绑定返回 `remote.source_not_bound`。",
      "- 程序已登录 n.novelia.cc；未登录返回 `remote.auth_missing`，请提示用户在「远程」页登录。",
      "- 先用 `novel_chapters` 与 `novel_chapter_read` 取得 `chapter_id`、`volume_id` 和站点原文段数；文库章节 ID 重复时必须提供 `volume_id`。",
      "",
      "### 执行",
      "",
      "- 一次只上传一章，不要在一个工具调用里循环多章。",
      "- `text` 是整章译文：每一行对应站点 `paragraph_jp` 的一段，行数必须完全一致。",
      "- 行数不一致返回 `remote.chapter_paragraph_mismatch`，不要提交；需要按行补齐时改用 `novel_chapter_line_upload`。",
      "- 站点原文非空而行译文为空、纯空白或包含缺失标记时返回 `remote.chapter_paragraph_empty`。",
      "- 若与站点旧译完全相同，返回 `uploaded: false` 与 `unchanged: true`，不重复写入。",
      "- 写入前会复查绑定与章节原文；等待期间变化返回 `remote.binding_changed` 或 `remote.chapter_changed`，重新读取后再决定。",
      "- 覆盖站点旧译或连续上传多章前，先向用户说明范围；是否确认由你根据影响判断。",
      "",
      "### 返回",
      "",
      "- `uploaded` 表示是否实际提交；`paragraphs` 是整章段数；`title`、`chapter_id` 与 `volume_id` 确认目标章节。",
    ].join("\n"),
    executionMode: "sequential",
    parameters: Type.Object(
      {
        chapter_id: Type.String({
          minLength: 1,
          description: "站点章节 ID，来自 `novel_chapters`。",
        }),
        volume_id: Type.Optional(Type.String({ description: "文库章节所属分卷；网页小说省略。" })),
        text: Type.String({
          description: "整章译文，一行对应站点原文一段；保留空行并避免额外结尾行。",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (params, _api, context) => {
      const signal = context.abortSignal ?? new AbortController().signal;
      signal.throwIfAborted();
      const result = await upload_chapter(
        {
          chapter_id: params.chapter_id,
          volume_id: params.volume_id?.trim() || null,
          text: params.text,
        },
        signal,
      );
      return agent_tool_result({
        uploaded: result.uploaded,
        ...(result.unchanged === true ? { unchanged: result.unchanged } : {}),
        chapter_id: result.chapter_id,
        volume_id: result.volume_id,
        title: result.title,
        paragraphs: result.paragraphs,
      });
    },
  });
}
