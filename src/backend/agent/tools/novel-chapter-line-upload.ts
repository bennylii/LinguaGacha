import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { RemoteChapterUploadResult } from "../../remote/remote-chapter-service";
import { agent_tool_result, define_agent_tool } from "../tool-definition";

/** 按行补传端口仍提交整章数组；其他行全部来自站点旧译文。 */
export type AgentNovelChapterLineUploadPort = (
  request: {
    chapter_id: string;
    volume_id: string | null;
    line: number;
    text: string;
  },
  signal: AbortSignal,
) => Promise<RemoteChapterUploadResult>;

/** 在整章行数无法对齐时替换一行，并沿用站点旧译补齐其余行。 */
export function create_agent_novel_chapter_line_upload_tool(
  upload_line: AgentNovelChapterLineUploadPort,
): ToolRegistration {
  return define_agent_tool({
    name: "novel_chapter_line_upload",
    description: [
      "按行补传当前绑定小说的一行译文，用于整章文本行数与站点原文段落数不一致的章节。",
      "",
      "### 前置条件",
      "",
      "- 工程必须已有 `remote_source` 绑定；未绑定返回 `remote.source_not_bound`。",
      "- 先用 `novel_chapters` 与 `novel_chapter_read` 取得章节身份、原文段数和站点旧译文。",
      "- 只应在整章上传因段落数不一致失败后使用；一次只补一行。",
      "",
      "### 执行",
      "",
      "- `line` 从 1 开始，对应站点 `paragraph_jp` 的段号；`text` 只能是单个段落，包含换行会被拒绝。",
      "- 目标行之外的译文只能来自站点旧译文；旧译缺失、长度不一致或其他非空原文行没有旧译时返回 `remote.chapter_line_context_missing`，不要猜测内容。",
      "- 站点仍按整章数组写入：工具会用旧译补齐其他行，只替换目标行。",
      "- 原文非空而目标译文为空、纯空白或包含缺失标记时返回 `remote.chapter_paragraph_empty`。",
      "- 目标行与站点旧译相同时返回 `uploaded: false` 与 `unchanged: true`。",
      "- 写入前会复查绑定、章节原文与旧译上下文；等待期间变化返回 `remote.binding_changed` 或 `remote.chapter_changed`，重新读取后再决定。",
      "- 覆盖站点旧译前先向用户说明本章与行号；是否确认由你根据影响判断。",
      "",
      "### 返回",
      "",
      "- `line` 确认本次补传行号；`paragraphs` 是整章段数；`uploaded` 表示是否实际提交。",
    ].join("\n"),
    executionMode: "sequential",
    parameters: Type.Object(
      {
        chapter_id: Type.String({
          minLength: 1,
          description: "站点章节 ID，来自 `novel_chapters`。",
        }),
        volume_id: Type.Optional(Type.String({ description: "文库章节所属分卷；网页小说省略。" })),
        line: Type.Integer({
          minimum: 1,
          description: "1 起始的站点段落行号。",
        }),
        text: Type.String({
          description: "该行的单个段落译文；不能包含换行。",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (params, _api, context) => {
      const signal = context.abortSignal ?? new AbortController().signal;
      signal.throwIfAborted();
      const result = await upload_line(
        {
          chapter_id: params.chapter_id,
          volume_id: params.volume_id?.trim() || null,
          line: params.line,
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
        line: result.line ?? params.line,
      });
    },
  });
}
