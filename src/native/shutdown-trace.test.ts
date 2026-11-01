import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { NativeFs } from "./native-fs";
import { create_shutdown_trace } from "./shutdown-trace";

describe("create_shutdown_trace", () => {
  it("按作用域与进程写入独立文件，不改动业务日志", () => {
    using directory = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-shutdown-trace-"));
    const trace = create_shutdown_trace({
      directory: directory.path,
      scope: "main",
      nativeFs: new NativeFs(),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    trace("quit.begin", { exit_code: 0 });
    trace("quit.exit");

    const files = fs.readdirSync(directory.path);
    expect(files).toEqual([`shutdown.main.${String(process.pid)}.log`]);
    expect(fs.readFileSync(path.join(directory.path, files[0]!), "utf-8")).toBe(
      [
        '2026-01-01T00:00:00.000Z main quit.begin {"exit_code":0}',
        "2026-01-01T00:00:00.000Z main quit.exit",
        "",
      ].join("\n"),
    );
  });

  it("日志目录不可用时不创建目录，退化到 stderr", () => {
    using directory = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-shutdown-trace-"));
    const missing = path.join(directory.path, "missing");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      create_shutdown_trace({ directory: missing, scope: "backend", nativeFs: new NativeFs() })(
        "stop_requested",
      );
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("backend stop_requested"));
    } finally {
      stderr.mockRestore();
    }

    expect(fs.existsSync(missing)).toBe(false);
  });
});
