import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { RemoteChapterImportResult } from "../../remote/remote-chapter-service";
import { agent_tool_result, define_agent_tool } from "../tool-definition";

/** 导入端口读取站点缓存并写入工作台；运行租约与前置条件由服务边界校验。 */
export type AgentNovelChapterImportPort = (
  request: { chapter_id: string; volume_id: string | null },
  signal: AbortSignal,
) => Promise<RemoteChapterImportResult>;

/** 读取站点已缓存的章节日文原文，并作为新文件加入工作台。 */
export function create_agent_novel_chapter_import_tool(
  import_chapter: AgentNovelChapterImportPort,
): ToolRegistration {
  return define_agent_tool({
    name: "novel_chapter_import",
    description: [
      "从 n.novelia.cc 读取指定章节在站点已缓存的日文原文，并作为新的 TXT 文件加入工作台。",
      "",
      "### 前置条件",
      "",
      "- 工程由 n.novelia.cc 链接创建；未绑定时返回 `remote.source_not_bound`。",
      "- 程序已登录 n.novelia.cc；未登录返回 `remote.auth_missing`，请提示用户在「远程」页登录。",
      "- 先用 `novel_chapters` 获取 `chapter_id` 与 `volume_id`。",
      "",
      "### 执行",
      "",
      "- 读取站点缓存（网页小说固定 `sync=false`），不触发站点向上游重新抓取。",
      "- 正文按站点段落逐行写入新文件，文件名由作品与章节标题生成；同名时自动追加序号，不覆盖已有文件。",
      "- 只导入日文原文，不导入站点已有译文，也不修改工程绑定或整本资产。",
      "- 文库章节在多卷之间章节 ID 可能重复，此时必须提供 `volume_id`；网页小说传 `null`。",
      '- 章节没有缓存内容时不创建文件，返回 `imported: false` 与 `reason: "chapter_empty"`。',
      "",
      "### 返回",
      "",
      "- `asset_path` 是工作台中的新文件路径；正文不进入本工具回执，需要查看内容时用工作区读取该文件。",
      "- `paragraph_count` 与 `char_count` 描述导入的行数与字符数。",
    ].join("\n"),
    executionMode: "sequential",
    parameters: Type.Object(
      {
        chapter_id: Type.String({
          minLength: 1,
          description: "站点章节 ID，来自 `novel_chapters`。",
        }),
        volume_id: Type.Optional(Type.String({ description: "文库章节所属分卷；网页小说省略。" })),
      },
      { additionalProperties: false },
    ),
    execute: async (params, _api, context) => {
      const signal = context.abortSignal ?? new AbortController().signal;
      signal.throwIfAborted();
      const result = await import_chapter(
        {
          chapter_id: params.chapter_id,
          volume_id: params.volume_id?.trim() || null,
        },
        signal,
      );
      return agent_tool_result({
        imported: result.imported,
        asset_path: result.asset_path,
        chapter_id: result.chapter_id,
        volume_id: result.volume_id,
        title: result.title,
        paragraph_count: result.paragraph_count,
        char_count: result.char_count,
        translated: result.translated,
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
    },
  });
}
