import { describe, expect, it } from "vitest";
import { AppError } from "../../shared/error";
import { create_agent_model_error, describe_run_failure } from "./agent-run-failure";

describe("轮次失败摘要", () => {
  it("模型错误携带 SDK 的可重试分类", () => {
    expect(create_agent_model_error("503: Service Unavailable")).toMatchObject({
      message: "503: Service Unavailable",
      retryable: true,
    });
    expect(create_agent_model_error("403: forbidden")).toMatchObject({ retryable: false });
  });

  it("模型错误仍能收敛成公开摘要", () => {
    expect(describe_run_failure(create_agent_model_error("429: Too Many Requests"))).toEqual({
      status: 429,
      detail: "Too Many Requests",
    });
  });

  it("供应商 JSON 错误体取状态码与说明文本", () => {
    const message =
      '400: {"type":"server_error","message":"Upstream request failed: [security_audit_fail] 抱歉，您所输入的内容含有违规信息"}';
    expect(describe_run_failure(new Error(message))).toEqual({
      status: 400,
      detail: "Upstream request failed: [security_audit_fail] 抱歉，您所输入的内容含有违规信息",
    });
  });

  it("非 JSON 错误体保留原文", () => {
    expect(describe_run_failure(new Error("503: Service Unavailable"))).toEqual({
      status: 503,
      detail: "Service Unavailable",
    });
  });

  it("传输失败没有状态码", () => {
    expect(describe_run_failure(new Error("Connection error."))).toEqual({
      status: null,
      detail: "Connection error.",
    });
  });

  it("已分类的异常优先使用结构化状态码", () => {
    const error = new AppError("model.provider_failed", {
      message: "Upstream request failed",
      diagnostic_context: { status: 429 },
    });
    expect(describe_run_failure(error)).toEqual({ status: 429, detail: "Upstream request failed" });
  });

  it("非异常值也能收敛成摘要", () => {
    expect(describe_run_failure('400: {"message":"bad request"}')).toEqual({
      status: 400,
      detail: "bad request",
    });
  });

  it("超长说明截断后保留省略号", () => {
    const failure = describe_run_failure(new Error(`400: {"message":"${"长".repeat(300)}"}`));
    expect(failure.status).toBe(400);
    expect(failure.detail).toBe(`${"长".repeat(200)}…`);
  });
});
