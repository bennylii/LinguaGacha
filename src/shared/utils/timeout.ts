/**
 * 给可能永久不结算的操作加上界。只改变调用方等待，不取消底层操作，
 * 因此调用方仍须按真实业务语义决定超时后是否继续（例如退出阶段直接终止）。
 */
export class TimeoutError extends Error {
  public readonly operation: string;
  public readonly timeout_ms: number;

  public constructor(operation: string, timeout_ms: number) {
    super(`Operation timed out after ${timeout_ms.toString()} ms: ${operation}`);
    this.name = "TimeoutError";
    this.operation = operation;
    this.timeout_ms = timeout_ms;
  }
}

/** 区分调用方主动设置的上界与业务自身抛出的同名错误。 */
export function is_timeout_error(error: unknown): error is TimeoutError {
  return error instanceof TimeoutError;
}

export async function with_timeout<T>(
  operation: string,
  promise: Promise<T>,
  timeout_ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(operation, timeout_ms)), timeout_ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    // 竞速失败分支之后原操作仍会结算，必须就地消费，避免逃逸成未处理拒绝。
    void promise.catch(() => undefined);
  }
}
