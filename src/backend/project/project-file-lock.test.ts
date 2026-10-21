import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";

import { ProjectFileLock } from "./project-file-lock";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ProjectFileLock", () => {
  it("同一工程的并发写入串行执行", async () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-project-lock-"));
    const project_path = path.join(root.path, "demo.lg");
    fs.writeFileSync(project_path, "");
    const lock = new ProjectFileLock();
    const order: string[] = [];
    let active = 0;
    let max_active = 0;

    const run = (name: string) =>
      lock.run(project_path, async () => {
        active += 1;
        max_active = Math.max(max_active, active);
        order.push(`${name}:start`);
        await delay(60);
        order.push(`${name}:end`);
        active -= 1;
      });

    await Promise.all([run("a"), run("b")]);

    expect(max_active).toBe(1);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("不同工程可以并行", async () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-project-lock-"));
    const first_path = path.join(root.path, "a.lg");
    const second_path = path.join(root.path, "b.lg");
    fs.writeFileSync(first_path, "");
    fs.writeFileSync(second_path, "");
    const lock = new ProjectFileLock();
    let active = 0;
    let max_active = 0;

    const run = (project_path: string) =>
      lock.run(project_path, async () => {
        active += 1;
        max_active = Math.max(max_active, active);
        await delay(80);
        active -= 1;
      });

    await Promise.all([run(first_path), run(second_path)]);
    expect(max_active).toBe(2);
  });

  it("动作失败后释放锁", async () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-project-lock-"));
    const project_path = path.join(root.path, "demo.lg");
    fs.writeFileSync(project_path, "");
    const lock = new ProjectFileLock();

    await expect(
      lock.run(project_path, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(lock.run(project_path, async () => "ok")).resolves.toBe("ok");
  });

  it("工程文件不存在时返回 not_found", async () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-project-lock-"));
    const lock = new ProjectFileLock();
    await expect(
      lock.run(path.join(root.path, "missing.lg"), async () => "ok"),
    ).rejects.toMatchObject({ code: "project.not_found" });
  });

  it("锁被其他实例持有时返回 busy", async () => {
    using root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-project-lock-"));
    const project_path = path.join(root.path, "demo.lg");
    fs.writeFileSync(project_path, "");
    const release = await lockfile.lock(project_path, { realpath: false });
    try {
      const lock = new ProjectFileLock({ retries: 0 });
      await expect(lock.run(project_path, async () => "ok")).rejects.toMatchObject({
        code: "database.busy",
      });
    } finally {
      await release();
    }
  });
});
