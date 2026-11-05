import { type JSX, memo, useEffect, useState } from "react";

import { is_json_record } from "@domain/json";
import type { AgentToolEntry } from "@shared/agent";
import { useI18n } from "@frontend/app/locale/locale-context";
import { useAgentChatActions } from "@frontend/app/session/agent/agent-chat-context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@frontend/shadcn/tabs";
import { AppButton } from "@frontend/widgets/app-button";
import { AppEditor } from "@frontend/widgets/app-editor/app-editor";
import type {
  AppEditorSyntax,
  AppViewerRange,
} from "@frontend/widgets/app-editor/app-editor-code-mirror";
import { AppPageDialog } from "@frontend/widgets/app-page-dialog";
import {
  AGENT_STATUS_LABEL_KEYS,
  useAgentElapsed,
} from "@frontend/pages/agent-page/agent-entry-status";
import { AgentStatusMark } from "@frontend/pages/agent-page/agent-status-mark";
import { format_agent_tool_output } from "./agent-tool-output";
import { format_agent_tool_label } from "./agent-tool-label";

type AgentToolPayloadChannel = "input" | "output";
type AgentToolPayloadOptions = {
  tool_name: string;
  fallback?: string;
} & (
  | { channel: "input"; content: string }
  | { channel: "output"; content: readonly string[] | null }
);
type AgentToolPayloadDocument = {
  text: string;
  syntax: AppEditorSyntax;
  ranges?: readonly AppViewerRange[];
};

type AgentToolDetailDialogProps = {
  entry: AgentToolEntry;
  on_close: () => void;
};

/** 工具详情只挂载当前输入或输出面板，避免长载荷进入会话信息流 DOM。 */
export function AgentToolDetailDialog(props: AgentToolDetailDialogProps): JSX.Element {
  const { t } = useI18n();
  const actions = useAgentChatActions();
  const entry = props.entry;
  const [loaded, set_loaded] = useState<AgentToolEntry | null>(null);
  const [loading_full, set_loading_full] = useState(false);
  const [load_failed, set_load_failed] = useState(false);
  const [read_attempt, set_read_attempt] = useState(0);
  const read_entry = actions.readEntry;

  // 终帧到达后按条目身份读取完整输出；运行中继续使用预览。
  useEffect(() => {
    if (entry.status === "running") {
      set_loaded(null);
      set_loading_full(false);
      set_load_failed(false);
      return;
    }
    let cancelled = false;
    set_loading_full(true);
    set_load_failed(false);
    void read_entry(entry.id)
      .then(
        (value) => {
          if (!cancelled && value.kind === "tool_call") set_loaded(value);
        },
        () => {
          if (!cancelled) set_load_failed(true);
        },
      )
      .finally(() => {
        if (!cancelled) set_loading_full(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry, read_attempt, read_entry]);

  const display = loaded ?? entry;
  const label = format_agent_tool_label(display.toolName, display.input);
  const [initial_channel] = useState<AgentToolPayloadChannel>(
    display.output === null ? "input" : "output",
  );
  // 缓存只属于本次弹窗，两个标签各保留一份结果，关闭即释放；隐藏标签不提前解析。
  const [read_payload] = useState(() => {
    const cache = new Map<
      AgentToolPayloadChannel,
      { options: AgentToolPayloadOptions; document: AgentToolPayloadDocument }
    >();
    /** 标签卸载后仍复用文档，空输出的状态文案也参与失效判断。 */
    return (options: AgentToolPayloadOptions): AgentToolPayloadDocument => {
      const previous = cache.get(options.channel);
      if (
        previous?.options.content === options.content &&
        previous.options.tool_name === options.tool_name &&
        previous.options.fallback === options.fallback
      )
        return previous.document;
      const document = resolve_agent_tool_payload(options);
      cache.set(options.channel, { options, document });
      return document;
    };
  });
  const active = entry.status === "running";
  const duration = useAgentElapsed(entry.createdAt, active);
  const status_label = t(AGENT_STATUS_LABEL_KEYS[entry.status]);
  const title = t("agent_page.tool.details", { tool: label });
  return (
    <AppPageDialog
      open
      size="xl"
      title={title}
      onClose={props.on_close}
      bodyClassName="overflow-hidden p-0"
    >
      <div className="agent-tool-detail__header">
        <div className="agent-tool-detail__identity">
          <h2>{label}</h2>
          <span>
            {status_label}
            {active ? ` · ${duration}` : ""}
          </span>
        </div>
        <AgentStatusMark status={entry.status} label={status_label} />
      </div>

      <Tabs defaultValue={initial_channel} className="agent-tool-detail__tabs">
        <div className="agent-tool-detail__toolbar">
          <TabsList aria-label={title}>
            <TabsTrigger value="input">{t("agent_page.tool.input")}</TabsTrigger>
            <TabsTrigger value="output">{t("agent_page.tool.output")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="input" className="agent-tool-detail__panel">
          <AgentToolPayload
            read_payload={read_payload}
            tool_name={display.toolName}
            channel="input"
            content={display.input}
            aria_label={t("agent_page.tool.input")}
          />
        </TabsContent>
        <TabsContent value="output" className="agent-tool-detail__panel">
          {loading_full ? (
            <div className="agent-tool-detail__notice" role="status">
              {t("agent_page.tool.loading_full")}
            </div>
          ) : load_failed ? (
            <div className="agent-tool-detail__notice" role="status">
              <span>{t("agent_page.tool.load_failed")}</span>
              <AppButton
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => set_read_attempt((attempt) => attempt + 1)}
              >
                {t("agent_page.tool.retry")}
              </AppButton>
            </div>
          ) : null}
          <AgentToolPayload
            read_payload={read_payload}
            tool_name={display.toolName}
            channel="output"
            content={display.output}
            fallback={status_label}
            aria_label={t("agent_page.tool.output")}
          />
        </TabsContent>
      </Tabs>
    </AppPageDialog>
  );
}

/** 当前标签页复用只读编辑器展示大载荷，不复制编辑与校验能力。 */
const AgentToolPayload = memo(function AgentToolPayload(
  props: AgentToolPayloadOptions & {
    read_payload: (options: AgentToolPayloadOptions) => AgentToolPayloadDocument;
    aria_label: string;
  },
): JSX.Element {
  const payload = props.read_payload(props);
  return (
    <AppEditor
      variant="viewer"
      value={payload.text}
      syntax={payload.syntax}
      ranges={payload.ranges}
      aria_label={props.aria_label}
      class_name="agent-tool-detail__viewer"
    />
  );
});

/** JSON 载荷按语义格式化，工作区脚本输入直接展示实际执行的 JavaScript 正文。 */
function resolve_agent_tool_payload(options: AgentToolPayloadOptions): AgentToolPayloadDocument {
  if (options.content === null) {
    return { text: options.fallback ?? "", syntax: "plain" };
  }

  if (options.channel === "output") {
    return { ...format_agent_tool_output(options.content), syntax: "plain" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(options.content) as unknown;
  } catch {
    return { text: options.content, syntax: "plain" };
  }

  if (options.tool_name === "workspace_run") {
    const script = read_workspace_run(parsed);
    if (script !== null) {
      return { text: script, syntax: "typescript" };
    }
  }

  return {
    text: JSON.stringify(parsed, null, 2),
    syntax: "json",
  };
}

/** 只在结构完整匹配当前工具契约时提取脚本，使显示内容覆盖调用的全部输入。 */
function read_workspace_run(value: unknown): string | null {
  if (!is_json_record(value) || Object.keys(value).length !== 1) {
    return null;
  }

  const script = value["script"];
  return typeof script === "string" && script.length > 0 ? script : null;
}
