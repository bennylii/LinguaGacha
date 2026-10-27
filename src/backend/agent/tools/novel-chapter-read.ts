import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { RemoteChapterReadResult } from "../../remote/remote-chapter-service";
import { agent_tool_result, define_agent_tool } from "../tool-definition";

/** 纯读取端口只返回站点缓存事实；绑定、消歧与凭据续期由服务边界校验。 */
export type AgentNovelChapterReadPort = (
  request: {
    chapter_id: string;
    volume_id: string | null;
    offset: number;
    limit: number;
    max_chars: number;
  },
  signal: AbortSignal,
) => Promise<RemoteChapterReadResult>;

const CHAPTER_READ_DEFAULT_LIMIT = 100;
const CHAPTER_READ_MAX_LIMIT = 100;
const CHAPTER_READ_DEFAULT_MAX_CHARS = 12000;
const CHAPTER_READ_MAX_CHARS = 24000;

/** 读取指定章节的站点缓存原文与旧译文；纯读取，不导入文件也不修改工程。 */
export function create_agent_novel_chapter_read_tool(
  read_chapter: AgentNovelChapterReadPort,
): ToolRegistration {
  return define_agent_tool({
    name: "novel_chapter_read",
    description: [
      "读取当前工程绑定的 n.novelia.cc 作品指定章节的站点缓存日文原文与已有 GPT 译文。",
      "",
      "### 前置条件",
      "",
      "- 工程由 n.novelia.cc 链接创建；未绑定时返回 `remote.source_not_bound`。",
      "- 程序已登录 n.novelia.cc；未登录返回 `remote.auth_missing`，请提示用户在「远程」页登录。",
      "- 先用 `novel_chapters` 获取 `chapter_id` 与 `volume_id`。",
      "",
      "### 执行",
      "",
      "- 读取站点缓存（固定 `sync=false`），不触发站点向上游重新抓取。",
      "- 网页小说章节站点没有缓存时，站点会拒绝请求（`remote.fetch_failed`）；此时用 `novel_chapter_sync` 触发站点抓取后重试。",
      "- 纯读取：不导入文件、不上传译文、不修改工程绑定或整本资产，无需用户审批。",
      "- `zh` 是站点已有的 GPT 译文，不是本地工程当前译文；本章没有站点译文时为 `null`。",
      "- `translation_current` 只表示旧译文所用术语表与当前一致，不代表译文内容是最新的。",
      "- 需要把单章原文加入工程时改用 `novel_chapter_import`。",
      "",
      "### 参数",
      "",
      "- `offset` 与 `limit` 按段落分页；`limit` 默认 100、最大 100。",
      "- `max_chars` 限制返回正文的字符总量，默认 12000、最大 24000；只计算段落正文。",
      "- 分页保留原始段号与空段；不截断单段正文，首段自身超预算时仍会返回。",
      "",
      "### 返回",
      "",
      "- `total_paragraphs` 是本章完整段数；`paragraphs[].n` 是从 1 开始的原始段号。",
      "- `next_offset` 是继续读取时应使用的段落偏移；已读完时为 `null`。",
      "- 截断后按 `next_offset` 继续调用，不要根据返回段数自行推算位置。",
      '- 网页小说 `total_paragraphs` 为 0 时会返回 `sync_available: true`，需要原文可调用 `novel_chapter_sync` 触发站点抓取。',
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
            maximum: CHAPTER_READ_MAX_LIMIT,
            description: "单页段数，默认 100。",
          }),
        ),
        max_chars: Type.Optional(
          Type.Number({
            minimum: 1,
            maximum: CHAPTER_READ_MAX_CHARS,
            description: "返回正文的字符预算，默认 12000；只计算段落正文。",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (params, _api, context) => {
      const signal = context.abortSignal ?? new AbortController().signal;
      signal.throwIfAborted();
      const result = await read_chapter(
        {
          chapter_id: params.chapter_id,
          volume_id: params.volume_id?.trim() || null,
          offset: params.offset ?? 0,
          limit: params.limit ?? CHAPTER_READ_DEFAULT_LIMIT,
          max_chars: params.max_chars ?? CHAPTER_READ_DEFAULT_MAX_CHARS,
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
        ...(result.sync_available === true ? { sync_available: result.sync_available } : {}),
        next_offset: result.next_offset,
        truncated: result.truncated,
      });
    },
  });
}
