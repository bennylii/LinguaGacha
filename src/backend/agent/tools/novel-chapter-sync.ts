import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { RemoteChapterReadResult } from "../../remote/remote-chapter-service";
import { agent_tool_result, define_agent_tool } from "../tool-definition";

/** 同步端口触发站点向上游抓取；绑定、消歧与凭据续期由服务边界校验。 */
export type AgentNovelChapterSyncPort = (
  request: {
    chapter_id: string;
    volume_id: string | null;
    offset: number;
    limit: number;
    max_chars: number;
  },
  signal: AbortSignal,
) => Promise<RemoteChapterReadResult>;

const CHAPTER_SYNC_DEFAULT_LIMIT = 100;
const CHAPTER_SYNC_MAX_LIMIT = 100;
const CHAPTER_SYNC_DEFAULT_MAX_CHARS = 12000;
const CHAPTER_SYNC_MAX_CHARS = 24000;

/** 触发站点对网页小说指定章节的上游抓取并返回缓存结果；突变动作，独立于纯读取。 */
export function create_agent_novel_chapter_sync_tool(
  sync_chapter: AgentNovelChapterSyncPort,
): ToolRegistration {
  return define_agent_tool({
    name: "novel_chapter_sync",
    description: [
      "触发 n.novelia.cc 站点向上游抓取当前绑定网页小说的指定章节，并返回抓取后的缓存原文。",
      "",
      "### 前置条件",
      "",
      "- 工程由 n.novelia.cc 网页小说链接创建；未绑定时返回 `remote.source_not_bound`。",
      "- 程序已登录 n.novelia.cc；未登录返回 `remote.auth_missing`，请提示用户在「远程」页登录。",
      "- 只适用于网页小说；文库作品返回 `remote.sync_unsupported`。",
      "- 先用 `novel_chapters` 获取 `chapter_id`。",
      "",
      "### 执行",
      "",
      "- 触发站点向上游源站重新抓取，可能较慢并消耗站点资源；一次只同步一章，不要批量循环调用。",
      "- 站点没有缓存时（`novel_chapter_read` 返回 `remote.fetch_failed`）先调用本工具，再按需用 `novel_chapter_read` 或 `novel_chapter_import` 消费结果。",
      "- 上游也没有该章内容时 `total_paragraphs` 仍为 0，此时不要反复重试。",
      "- 纯读取不改动站点与工程；本工具触发的是站点侧抓取，但不写入工程、不上传译文。",
      "",
      "### 参数与返回",
      "",
      "- `offset` 与 `limit` 按段落分页；`limit` 默认 100、最大 100。",
      "- `max_chars` 限制返回正文的字符总量，默认 12000、最大 24000；只计算段落正文。",
      "- 返回形状与 `novel_chapter_read` 一致：`total_paragraphs`、`paragraphs[].n/.jp/.zh`、`next_offset`。",
      "- 截断后按 `next_offset` 继续读取；续读属于缓存读取，无需再次同步。",
    ].join("\n"),
    executionMode: "sequential",
    parameters: Type.Object(
      {
        chapter_id: Type.String({
          minLength: 1,
          description: "站点章节 ID，来自 `novel_chapters`。",
        }),
        volume_id: Type.Optional(Type.String({ description: "文库章节所属分卷；网页小说省略。" })),
        offset: Type.Optional(Type.Number({ minimum: 0, description: "段落分页起点，默认 0。" })),
        limit: Type.Optional(
          Type.Number({
            minimum: 1,
            maximum: CHAPTER_SYNC_MAX_LIMIT,
            description: "单页段数，默认 100。",
          }),
        ),
        max_chars: Type.Optional(
          Type.Number({
            minimum: 1,
            maximum: CHAPTER_SYNC_MAX_CHARS,
            description: "返回正文的字符预算，默认 12000；只计算段落正文。",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (params, _api, context) => {
      const signal = context.abortSignal ?? new AbortController().signal;
      signal.throwIfAborted();
      const result = await sync_chapter(
        {
          chapter_id: params.chapter_id,
          volume_id: params.volume_id?.trim() || null,
          offset: params.offset ?? 0,
          limit: params.limit ?? CHAPTER_SYNC_DEFAULT_LIMIT,
          max_chars: params.max_chars ?? CHAPTER_SYNC_DEFAULT_MAX_CHARS,
        },
        signal,
      );
      // 服务结果是窄化类型，模型回执按字段显式构造，保持与 details 一致。
      return agent_tool_result({
        chapter_id: result.chapter_id,
        volume_id: result.volume_id,
        title: result.title,
        translated: result.translated,
        total_paragraphs: result.total_paragraphs,
        offset: result.offset,
        paragraphs: result.paragraphs.map((paragraph) => ({
          n: paragraph.n,
          jp: paragraph.jp,
          zh: paragraph.zh,
        })),
        glossary_id: result.glossary_id,
        old_glossary_id: result.old_glossary_id,
        translation_current: result.translation_current,
        next_offset: result.next_offset,
        truncated: result.truncated,
      });
    },
  });
}
