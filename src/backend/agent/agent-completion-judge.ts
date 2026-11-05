import { uuidv7 } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Model,
  ModelThinkingLevel,
  MutableModels,
} from "@earendil-works/pi-ai";
import { MemoryStorage, type ToolRegistration } from "@earendil-works/pi-durable";

import { AgentChat } from "./agent-chat";
import { project_assistant_message_parts } from "./agent-message";
import type { AgentRuntimeLog } from "./agent-runtime-log";
import type { RuntimeLease } from "../runtime-operation-gate";

/** 判定线程给出的结论；判定不可用或无法解析时按已完成处理。 */
export type AgentCompletionVerdict = {
  completed: boolean;
  reason: string;
};

/** 判定输入的长度上限，任务与答复各截断到这个长度，避免挤占判定请求。 */
const JUDGE_INPUT_MAX_CHARS = 4_000;

/** 判定结论的固定格式，只有这一种形式会被采信。 */
const JUDGE_VERDICT_PATTERN = /^\s*VERDICT\s*[:：]\s*(DONE|CONTINUE)\s*$/im;

/** 判定线程的等待上限；超时按中止处理，没有结论时回落为已完成。 */
const JUDGE_TIMEOUT_MS = 120_000;

/** 截断过长的判定输入，保留结尾以便看到模型最后的状态描述。 */
function truncate_judge_input(value: string): string {
  if (value.length <= JUDGE_INPUT_MAX_CHARS) return value;
  return `${value.slice(0, JUDGE_INPUT_MAX_CHARS)}\n…（已截断）`;
}

/** 组装判定线程的输入文本；任务与答复都进入判定依据。 */
export function format_agent_completion_judge_prompt(task: string, answer: string): string {
  return [
    "请判定下面这个 Agent 任务是否已经真正完成。",
    "",
    "## 本轮任务",
    truncate_judge_input(task),
    "",
    "## 上一轮助手答复",
    truncate_judge_input(answer),
    "",
    "## 输出要求",
    "只输出两行：",
    "第一行是 `VERDICT: DONE` 或 `VERDICT: CONTINUE`。",
    "第二行是一句话依据，必须引用具体数字或具体文件事实。",
  ].join("\n");
}

/** 解析判定线程的最终答复；没有可识别的结论行时按已完成处理。 */
export function parse_agent_completion_verdict(text: string): AgentCompletionVerdict {
  const matched = JUDGE_VERDICT_PATTERN.exec(text);
  if (matched === null) return { completed: true, reason: "判定结论无法解析，按已完成处理。" };
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const index = lines.findIndex((line) => JUDGE_VERDICT_PATTERN.test(line));
  const reason = index >= 0 ? (lines[index + 1] ?? "") : "";
  return {
    completed: matched[1]!.toUpperCase() === "DONE",
    reason: reason === "" ? "判定线程未给出依据。" : reason,
  };
}

/** 从模型事件里取最后一条助手正文；工具调用后的最终答复覆盖前一次文本。 */
function read_judge_answer(messages: AssistantMessage[]): string {
  const last = messages[messages.length - 1];
  if (last === undefined) return "";
  const parts = project_assistant_message_parts(last);
  if (parts === null) return "";
  return parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .join("\n");
}

/** 判定线程的可装配部件，由调用方提供，避免本模块依赖会话与工程设施。 */
export type AgentCompletionJudgeOptions = {
  models: MutableModels; // 判定线程独占的模型集合，不与主会话共享事件观测。
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  lease: RuntimeLease; // 判定线程借用主执行的租约，不另行占用运行时。
  tools: ToolRegistration[];
  systemPrompt: string;
  skillsPrompt: string;
  log: AgentRuntimeLog;
  cwd: string;
  task: string;
  answer: string;
  signal: AbortSignal;
};

/**
 * 判定线程独立于公开时间线：内存存储不写工程，独立模型集合不污染主会话测速。
 * 任何失败都退化为“已完成”，判定不会让轮次停不下来。
 */
export async function judge_agent_task_completion(
  options: AgentCompletionJudgeOptions,
): Promise<AgentCompletionVerdict> {
  const messages: AssistantMessage[] = [];
  const chat = await AgentChat.open({
    chatId: `auto-continue-judge-${uuidv7()}`,
    storage: new MemoryStorage(),
    cwd: options.cwd,
    models: options.models,
    seed: [],
    tools: options.tools,
    systemPrompt: () => options.systemPrompt,
    skillsPrompt: () => options.skillsPrompt,
    continueText: () => "",
    log: options.log,
    onChange: () => {},
    onModelEvent: (event) => {
      if (event.type === "done") messages.push(event.message);
    },
    onReport: () => {},
  });
  const execution = chat.begin_execution(options.lease);
  // 判定线程持有主执行的租约，超时必须自行收口，避免挂起的判定阻塞后续轮次。
  const timeout = setTimeout(() => execution.controller.abort(), JUDGE_TIMEOUT_MS);
  try {
    // 用户停止主执行时判定线程一并中止，迟到的判定不得再触发继续。
    const abort = (): void => execution.controller.abort();
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
    await chat.configure(options.model, options.thinkingLevel);
    const text = format_agent_completion_judge_prompt(options.task, options.answer);
    const accepted = await chat.submit(
      { text, attachments: [] },
      { text, images: [] },
      execution,
      "round",
    );
    await chat.run(accepted, execution);
    return parse_agent_completion_verdict(read_judge_answer(messages));
  } finally {
    clearTimeout(timeout);
    await chat.close();
  }
}
