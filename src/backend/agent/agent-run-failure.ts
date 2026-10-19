import { is_json_record } from "../../domain/json";
import type { AgentRunFailure } from "../../shared/agent";
import { AppError } from "../../shared/error";
import { create_provider_error } from "../network/provider-error";

/** 摘要只服务界面展示，截断避免把整包错误体写进会话记录。 */
const MAX_DETAIL_LENGTH = 200;
/** Pi 把供应商错误压成 `<status>: <body>`，此处按同一格式取回状态码。 */
const PROVIDER_ERROR_PREFIX = /^(\d{3}): ([\s\S]*)$/;

/** 把轮次失败收敛成可展示的原因摘要；结构化事实优先于文本。 */
export function describe_run_failure(error: unknown): AgentRunFailure {
  if (error instanceof AppError) {
    const status = error.diagnostic_context["status"];
    return {
      status: typeof status === "number" ? status : null,
      detail: truncate_detail(error.message),
    };
  }
  const text = error instanceof Error ? error.message : String(error);
  const matched = PROVIDER_ERROR_PREFIX.exec(text);
  if (matched === null) return { status: null, detail: truncate_detail(text) };
  const status = Number(matched[1]);
  return { status, detail: truncate_detail(read_body_detail(matched[2] ?? "", status)) };
}

/** 供应商错误体多为 JSON，复用共享的供应商错误归一化取其中的说明文本。 */
function read_body_detail(body: string, status: number): string {
  try {
    const value: unknown = JSON.parse(body);
    if (is_json_record(value)) return create_provider_error(value, status).message;
  } catch {
    // 非 JSON 错误体保留原文。
  }
  return body;
}

function truncate_detail(text: string): string {
  return text.length <= MAX_DETAIL_LENGTH ? text : `${text.slice(0, MAX_DETAIL_LENGTH)}…`;
}
