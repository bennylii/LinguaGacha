import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { RemoteSourceRebindResult } from "../../remote/novel-source-service";
import { agent_tool_result, define_agent_tool } from "../tool-definition";

/** 换源端口只替换绑定身份；绑定、资产与站点前置条件由服务边界校验。 */
export type AgentNovelSourceRebindPort = (
  request: { url: string },
  signal: AbortSignal,
) => Promise<RemoteSourceRebindResult>;

/** 把已绑定的网页小说换到同站点的另一个作品页，保留本地资产与译文。 */
export function create_agent_novel_source_rebind_tool(
  rebind_source: AgentNovelSourceRebindPort,
): ToolRegistration {
  return define_agent_tool({
    name: "novel_source_rebind",
    description: [
      "把当前已绑定的 n.novelia.cc 网页小说换到另一个作品页，只更新来源绑定。",
      "",
      "### 前置条件",
      "",
      "- 工程必须已经有 `remote_source` 绑定；未绑定返回 `remote.source_not_bound`，本工具不创建绑定。",
      '- 当前绑定和新地址都必须是网页小说（`kind === "web"`）；文库作品没有多渠道，EPUB 资产也无法换源。',
      '- EPUB 工程返回 `remote.rebind_unsupported` 与 `reason: "epub_requires_import"`；需要按新地址重新导入。',
      "",
      "### 执行",
      "",
      "- 新旧作品的章节数量必须一致；标题差异只进入回执，不参与拒绝。数量不一致返回 `remote.chapter_structure_mismatch`，不写绑定。",
      "- 换源保留原资产路径、条目和本地译文，不重建文件；成功后清除旧同步快照。",
      "- `text_matches` 表示本地资产文本是否与新作品下载文本一致，仅用于判断是否需要后续同步，不阻止换源。",
      "- 换源会改变后续上传目标；执行前先向用户说明当前绑定、目标 URL 和结构校验结果，是否确认由你根据影响判断。",
      "- 等待期间绑定被其他操作改变时返回 `remote.binding_changed`，重新读取后再决定。",
      "",
      "### 返回",
      "",
      "- `changed` 为 false 表示目标 URL 与当前绑定相同。",
      "- `previous` / `current` 给出换源前后的 URL、标题、类型与章节数。",
    ].join("\n"),
    executionMode: "sequential",
    parameters: Type.Object(
      {
        url: Type.String({
          minLength: 1,
          description: "新作品的 n.novelia.cc 网页小说作品页 URL。",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (params, _api, context) => {
      const signal = context.abortSignal ?? new AbortController().signal;
      signal.throwIfAborted();
      const result = await rebind_source({ url: params.url }, signal);
      return agent_tool_result({
        changed: result.changed,
        previous: result.previous,
        current: result.current,
        asset_path: result.asset_path,
        text_matches: result.text_matches,
      });
    },
  });
}
