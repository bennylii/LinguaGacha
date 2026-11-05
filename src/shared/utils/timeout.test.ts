import { describe, expect, it } from "vitest";

import { is_timeout_error, TimeoutError, with_timeout } from "./timeout";

describe("with_timeout", () => {
  it("在时限内正常结算时返回原结果", async () => {
    await expect(with_timeout("quick", Promise.resolve("done"), 50)).resolves.toBe("done");
  });

  it("超过时限以可识别的超时错误结束等待", async () => {
    const pending = new Promise<never>(() => undefined);
    const error = await with_timeout("slow", pending, 1).catch((caught: unknown) => caught);

    expect(is_timeout_error(error)).toBe(true);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).operation).toBe("slow");
  });

  it("超时后原操作迟到失败不会逃逸成未处理拒绝", async () => {
    const pending = Promise.withResolvers<string>();
    await expect(with_timeout("late", pending.promise, 1)).rejects.toBeInstanceOf(TimeoutError);

    pending.reject(new Error("late failure"));
    await Promise.resolve();
  });
});
