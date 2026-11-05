import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { RemoteCachedChapterList } from "../../remote/remote-chapter-service";
import { agent_tool_result, define_agent_tool } from "../tool-definition";

/** 列表端口读取站点目录；绑定与登录前置条件由服务边界校验。 */
export type AgentNovelChaptersPort = (
  request: { query: string | null; offset: number; limit: number },
  signal: AbortSignal,
) => Promise<RemoteCachedChapterList>;

const NOVEL_CHAPTERS_DEFAULT_LIMIT = 50;
const NOVEL_CHAPTERS_MAX_LIMIT = 100;

/** 列出绑定作品的站点章节目录，为 `novel_chapter_import` 提供章节身份。 */
export function create_agent_novel_chapters_tool(list: AgentNovelChaptersPort): ToolRegistration {
  return define_agent_tool({
    name: "novel_chapters",
    description: [
      "列出当前工程绑定的 n.novelia.cc 作品的站点章节目录（站点已缓存内容），不下载正文。",
      "",
      "### 前置条件",
      "",
      "- 工程由 n.novelia.cc 链接创建；未绑定时返回 `remote.source_not_bound`。",
      "- 程序已登录 n.novelia.cc；未登录返回 `remote.auth_missing`，请提示用户在「远程」页登录。",
      "",
      "### 参数",
      "",
      "- `query` 按章节标题或章节 ID 做不区分大小写的包含匹配，省略即返回全部。",
      "- `offset` 与 `limit` 分页；`limit` 默认 50、最大 100。",
      "",
      "### 返回",
      "",
      "- `total` 为过滤后的章节总数，`offset` 为本页起点，`index` 为站点目录顺序（从 1 开始）。",
      "- `chapter_id` 与 `volume_id` 是 `novel_chapter_import` 的定位字段；网页小说的 `volume_id` 为 `null`。",
      "- `translated` 表示站点是否已有该章的 GPT 译文。",
    ].join("\n"),
    executionMode: "sequential",
    parameters: Type.Object(
      {
        query: Type.Optional(
          Type.String({ description: "按标题或章节 ID 过滤的包含匹配，省略即返回全部。" }),
        ),
        offset: Type.Optional(Type.Number({ minimum: 0, description: "分页起点，默认 0。" })),
        limit: Type.Optional(
          Type.Number({
            minimum: 1,
            maximum: NOVEL_CHAPTERS_MAX_LIMIT,
            description: "单页条数，默认 50。",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (params, _api, context) => {
      const signal = context.abortSignal ?? new AbortController().signal;
      signal.throwIfAborted();
      const result = await list(
        {
          query: params.query?.trim() ?? "",
          offset: params.offset ?? 0,
          limit: params.limit ?? NOVEL_CHAPTERS_DEFAULT_LIMIT,
        },
        signal,
      );
      return agent_tool_result({
        origin: result.origin,
        host: result.host,
        kind: result.kind,
        title: result.title,
        total: result.total,
        offset: result.offset,
        chapters: result.chapters.map((chapter) => ({
          index: chapter.index,
          chapter_id: chapter.chapter_id,
          volume_id: chapter.volume_id,
          title: chapter.title,
          translated: chapter.translated,
        })),
      });
    },
  });
}
