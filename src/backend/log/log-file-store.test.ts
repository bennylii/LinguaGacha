import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NativeFs } from "../../native/native-fs";
import { LogFileStore } from "./log-file-store";
import type { LogFileRecord } from "../../shared/log";

const DATE = "20260913";
const INSTANCE = "1234";
const OTHER = "5678";

/** 生成最小正文，测试只覆盖目标场景所需字段。 */
function record(text: string, window = true): LogFileRecord {
  return {
    created_at: "2026-09-13T08:00:00.000Z",
    level: "info",
    source: "test",
    content: text,
    ...(window ? {} : { window: false as const }),
  };
}

/** 显式指定实例，避免测试随真实 PID 变化。 */
function create_store(directory: string, instance = INSTANCE, native?: NativeFs): LogFileStore {
  return new LogFileStore({
    directory,
    instance,
    ...(native === undefined ? {} : { fs: native }),
  });
}

function body_path(directory: string, instance = INSTANCE, date = DATE): string {
  return path.join(directory, `app.${date}.${instance}.jsonl`);
}

function index_path(directory: string, instance = INSTANCE, date = DATE): string {
  return path.join(directory, `app.${date}.${instance}.idx.jsonl`);
}

function entry_id(line: number, instance = INSTANCE, date = DATE): string {
  return `${date}:${instance}:${String(line)}`;
}

describe("LogFileStore", () => {
  it("另一日期编辑不影响当前游标，拒绝跨日期游标", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-one-date-"));
    const store = create_store(dir.path);
    store.append(DATE, record("当前日期"));
    store.append("20260914", record("下一日期"));
    const current = await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" });
    fs.writeFileSync(body_path(dir.path, INSTANCE, "20260914"), JSON.stringify(record("外部编辑")));
    const unchanged = await store.read_page({
      date: DATE,
      instance: INSTANCE,
      direction: "after",
      cursor: current.after!,
    });
    expect(unchanged.status).toBe("ready");
    expect(unchanged.entries).toEqual([]);
    expect(unchanged.after).toEqual(current.after);
    await expect(
      store.read_page({
        date: "20260914",
        instance: INSTANCE,
        direction: "after",
        cursor: current.after!,
      }),
    ).rejects.toThrow();
    await store.close();
  });

  it("外部改单行后行号身份保持，旧游标与详情失效，随后自身追加不会掩盖编辑", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-edit-"));
    const store = create_store(dir.path);
    store.append(DATE, record("alpha"));
    store.append(DATE, record("第二行"));
    const before = await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" });
    const body = body_path(dir.path);
    fs.writeFileSync(body, fs.readFileSync(body, "utf8").replace("alpha", "更长的内容🙂"));
    store.append(DATE, record("新增"));
    expect(
      (
        await store.read_page({
          date: DATE,
          instance: INSTANCE,
          direction: "after",
          cursor: before.after!,
        })
      ).status,
    ).toBe("cursor_invalid");
    expect(await store.read_detail(before.entries[1]!.id, before.entries[1]!.revision)).toBeNull();
    const after = await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" });
    expect(after.entries.map((entry) => entry.id)).toEqual([
      entry_id(1),
      entry_id(2),
      entry_id(3),
    ]);
    expect(after.entries.map((entry) => entry.message_preview)).toEqual([
      "更长的内容🙂",
      "第二行",
      "新增",
    ]);
    expect(await store.read_detail(after.entries[1]!.id, after.entries[1]!.revision)).toMatchObject(
      { content: "第二行" },
    );
    await store.close();
  });

  it("等字节替换和跨重启编辑都重建摘要，不根据文件长度猜测为追加", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-replace-"));
    const body = body_path(dir.path);
    const store = create_store(dir.path);
    store.append(DATE, record("alpha"));
    const before = await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" });
    const bytes = fs.statSync(body).size;
    fs.writeFileSync(body, fs.readFileSync(body, "utf8").replace("alpha", "bravo"));
    const after = await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" });
    expect(fs.statSync(body).size).toBe(bytes);
    expect(after.entries[0]?.message_preview).toBe("bravo");
    expect(after.after?.revision).not.toBe(before.after?.revision);
    await store.close();
    fs.writeFileSync(body, fs.readFileSync(body, "utf8").replace("bravo", "delta"));
    const reopened = create_store(dir.path);
    const page = await reopened.read_page({ date: DATE, instance: INSTANCE, direction: "latest" });
    expect(page.entries[0]?.message_preview).toBe("delta");
    expect(page.entries[0]?.id).toBe(before.entries[0]?.id);
    expect(
      await reopened.read_detail(before.entries[0]!.id, before.entries[0]!.revision),
    ).toBeNull();
    await reopened.close();
  });

  it("隐藏行、损坏行均计数，插删物理行使旧内容代次失效", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-line-number-"));
    const body = body_path(dir.path);
    fs.writeFileSync(
      body,
      [JSON.stringify(record("隐藏", false)), "broken", JSON.stringify(record("可见")), ""].join(
        "\n",
      ),
    );
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const store = create_store(dir.path);
      const before = await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" });
      expect(before.entries[0]?.line).toBe(3);
      fs.writeFileSync(body, JSON.stringify(record("插入")) + "\n" + fs.readFileSync(body, "utf8"));
      const inserted = await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" });
      expect(inserted.entries.map((entry) => entry.line)).toEqual([1, 4]);
      expect(
        await store.read_detail(before.entries[0]!.id, before.entries[0]!.revision),
      ).toBeNull();
      fs.writeFileSync(body, JSON.stringify(record("删除后")) + "\n");
      expect(
        (
          await store.read_page({
            date: DATE,
            instance: INSTANCE,
            direction: "check",
            cursor: inserted.after!,
          })
        ).status,
      ).toBe("cursor_invalid");
      await store.close();
    } finally {
      stderr.mockRestore();
    }
  });

  it("重建读取期间被编辑时重新扫描，返回完整一致的新内容", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-edit-during-read-"));
    const body = body_path(dir.path);
    fs.writeFileSync(body, JSON.stringify(record("alpha")) + "\n");
    const native = new NativeFs();
    const read = native.read_range.bind(native);
    let edited = false;
    vi.spyOn(native, "read_range").mockImplementation(async (file, start, length) => {
      const bytes = await read(file, start, length);
      if (file === body && !edited) {
        edited = true;
        fs.writeFileSync(body, fs.readFileSync(body, "utf8").replace("alpha", "bravo"));
      }
      return bytes;
    });
    const store = create_store(dir.path, INSTANCE, native);
    expect(
      (await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" })).entries[0]
        ?.message_preview,
    ).toBe("bravo");
    await store.close();
  });

  it("跨多个索引读取块分页时保留每条记录和正确游标", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-chunks-"));
    const store = create_store(dir.path);
    for (let index = 0; index < 240; index++)
      store.append(DATE, record(`${String(index)}:${"内容".repeat(600)}`));
    let page = await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" });
    const entries = [...page.entries];
    while (page.has_more) {
      page = await store.read_page({
        date: DATE,
        instance: INSTANCE,
        direction: "before",
        cursor: page.before!,
      });
      entries.unshift(...page.entries);
    }
    expect(entries).toHaveLength(240);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(240);
    expect(entries[0]?.message_preview).toMatch(/^0:/);
    expect(entries.at(-1)?.message_preview).toMatch(/^239:/);
    await store.close();
  });

  it("中文多行正文跨重启读取，索引只保存摘要与隐藏进度", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-store-"));
    const store = create_store(dir.path);
    store.append(DATE, record("中文\n🙂".repeat(20000)));
    store.append(DATE, record("隐藏正文", false));
    await store.close();
    const reopened = create_store(dir.path);
    const page = await reopened.read_page({ date: DATE, instance: INSTANCE, direction: "latest" });
    expect(page.entries).toHaveLength(1);
    const entry = page.entries[0]!;
    expect(entry.message_preview.length).toBeLessThan(entry.message_length);
    expect(await reopened.read_detail(entry.id, entry.revision)).toMatchObject({
      content: record("中文\n🙂".repeat(20000)).content,
    });
    expect(await reopened.read_detail(entry_id(2), entry.revision)).toBeNull();
    const lines = fs.readFileSync(index_path(dir.path), "utf8").trim().split("\n");
    expect(JSON.parse(lines[1]!)).toEqual({
      line: 2,
      end: fs.statSync(body_path(dir.path)).size,
    });
    expect(fs.readFileSync(body_path(dir.path), "utf8")).not.toContain('"version"');
    await reopened.close();
  });

  it("历史分页和增量读取只访问选中日期", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-pages-"));
    const store = create_store(dir.path);
    for (let index = 0; index < 8; index++) store.append(DATE, record(String(index)));
    const latest = await store.read_page({
      date: DATE,
      instance: INSTANCE,
      direction: "latest",
      limit: 3,
    });
    expect(latest.entries.map((entry) => entry.message_preview)).toEqual(["5", "6", "7"]);
    const older = await store.read_page({
      date: DATE,
      instance: INSTANCE,
      direction: "before",
      cursor: latest.before!,
      limit: 3,
    });
    expect(older.entries.map((entry) => entry.message_preview)).toEqual(["2", "3", "4"]);
    const oldest = await store.read_page({
      date: DATE,
      instance: INSTANCE,
      direction: "before",
      cursor: older.before!,
      limit: 3,
    });
    expect(oldest.entries.map((entry) => entry.message_preview)).toEqual(["0", "1"]);
    expect(oldest.has_more).toBe(false);
    store.append(DATE, record("8"));
    store.append("20260914", record("9"));
    const next = await store.read_page({
      date: DATE,
      instance: INSTANCE,
      direction: "after",
      cursor: latest.after!,
    });
    expect(next.entries.map((entry) => entry.message_preview)).toEqual(["8"]);
    expect(
      (
        await store.read_page({
          date: DATE,
          instance: INSTANCE,
          direction: "after",
          cursor: next.after!,
        })
      ).entries,
    ).toEqual([]);
    await store.close();
  });

  it("缺失、落后和不完整索引从正文恢复，保留详情身份", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-repair-"));
    const store = create_store(dir.path);
    store.append(DATE, record("一"));
    const first = await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" });
    const index = index_path(dir.path);
    fs.appendFileSync(index, '{"end":');
    fs.appendFileSync(body_path(dir.path), JSON.stringify(record("二")) + "\n");
    const recovered = await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" });
    expect(recovered.entries.map((entry) => entry.message_preview)).toEqual(["一", "二"]);
    expect(recovered.entries[0]?.id).toBe(first.entries[0]?.id);
    fs.unlinkSync(index);
    expect(
      (
        await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" })
      ).entries.map((entry) => entry.id),
    ).toEqual(recovered.entries.map((entry) => entry.id));
    fs.writeFileSync(index, "broken\n");
    expect(
      (
        await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" })
      ).entries.map((entry) => entry.id),
    ).toEqual(recovered.entries.map((entry) => entry.id));
    await store.close();
  });

  it("恢复期间继续追加且并发查询共享索引，不产生重复", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-overlap-"));
    const native = new NativeFs();
    const store = create_store(dir.path, INSTANCE, native);
    store.append(DATE, record("起点"));
    fs.unlinkSync(index_path(dir.path));
    const pending = store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" });
    store.append(DATE, record("恢复中追加"));
    const [one, two] = await Promise.all([
      pending,
      store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" }),
    ]);
    expect(one.entries.map((entry) => entry.message_preview)).toEqual(["起点", "恢复中追加"]);
    expect(two.entries).toEqual(one.entries);
    await store.close();
  });

  it("索引写入失败保留正文，后续查询补回记录", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-write-failure-"));
    const native = new NativeFs();
    const store = create_store(dir.path, INSTANCE, native);
    const append = native.append_text_file.bind(native);
    vi.spyOn(native, "append_text_file").mockImplementation((file, text) => {
      if (file === index_path(dir.path)) throw new Error("索引写入失败");
      append(file, text);
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      store.append(DATE, record("必须保留"));
      expect(stderr).toHaveBeenCalled();
    } finally {
      vi.mocked(native.append_text_file).mockRestore();
    }
    expect(
      (await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" })).entries.map(
        (entry) => entry.message_preview,
      ),
    ).toEqual(["必须保留"]);
    stderr.mockRestore();
    await store.close();
  });

  it("未完成尾行跨重启读取只提交完整记录，随后追加不失效已有游标", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-tail-"));
    const body = body_path(dir.path);
    fs.writeFileSync(body, JSON.stringify(record("有效")) + '\n{"content":');
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const store = create_store(dir.path);
      const incomplete = await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" });
      expect(incomplete.entries).toHaveLength(1);
      // 未完成尾行保持同一索引代次，重复检查不能令已有游标失效。
      expect(
        (
          await store.read_page({
            date: DATE,
            instance: INSTANCE,
            direction: "check",
            cursor: incomplete.after!,
          })
        ).status,
      ).toBe("ready");
      store.append(DATE, record("重启后"));
      expect(
        (
          await store.read_page({ date: DATE, instance: INSTANCE, direction: "latest" })
        ).entries.map((entry) => entry.message_preview),
      ).toEqual(["有效", "重启后"]);
      expect(stderr).toHaveBeenCalled();
      await store.close();
    } finally {
      stderr.mockRestore();
    }
  });

  it("三日期清理涵盖全部实例与旧格式，越界游标与非法路径明确拒绝", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-cleanup-"));
    for (const date of ["20260909", "20260910", "20260911", "20260912"]) {
      fs.writeFileSync(path.join(dir.path, `app.${date}.${INSTANCE}.jsonl`), "");
      fs.writeFileSync(path.join(dir.path, `app.${date}.${INSTANCE}.idx.jsonl`), "");
      fs.writeFileSync(path.join(dir.path, `app.${date}.${OTHER}.jsonl`), "");
    }
    // 旧格式没有实例段：不再展示，但必须参与清理。
    fs.writeFileSync(path.join(dir.path, "app.20260910.log"), "旧日志");
    fs.writeFileSync(path.join(dir.path, "app.20260910.jsonl"), "旧正文");
    fs.writeFileSync(path.join(dir.path, "app.20260910.idx.jsonl"), "");
    const store = create_store(dir.path);
    store.append(DATE, record("最新"));
    const names = fs.readdirSync(dir.path);
    expect(names.some((name) => name.includes("20260910"))).toBe(false);
    expect(names.some((name) => name.includes("20260909"))).toBe(false);
    expect(store.list_files()).toEqual([
      { date: DATE, instance: INSTANCE, current: true },
      { date: "20260912", instance: INSTANCE, current: true },
      { date: "20260912", instance: OTHER, current: false },
      { date: "20260911", instance: INSTANCE, current: true },
      { date: "20260911", instance: OTHER, current: false },
    ]);
    expect(
      (
        await store.read_page({ date: "20260909", instance: INSTANCE, direction: "latest" })
      ).status,
    ).toBe("expired");
    await expect(store.read_detail("../secret:0", "rev")).rejects.toThrow();
    await expect(
      store.read_page({ date: DATE, instance: INSTANCE, direction: "latest", limit: -1 }),
    ).rejects.toThrow();
    await expect(
      store.read_page({ date: DATE, instance: "../evil", direction: "latest" }),
    ).rejects.toThrow();
    expect(
      (
        await store.read_page({
          date: DATE,
          instance: INSTANCE,
          direction: "after",
          cursor: { date: DATE, instance: INSTANCE, line: 1, revision: "old" },
        })
      ).status,
    ).toBe("cursor_invalid");
    await store.close();
  });
});

describe("LogFileStore 多实例", () => {
  it("两个实例各写各的文件，索引不重复也不互相截断", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-two-instances-"));
    const first = create_store(dir.path, INSTANCE);
    const second = create_store(dir.path, OTHER);
    for (let index = 0; index < 5; index++) {
      first.append(DATE, record(`甲${String(index)}`));
      second.append(DATE, record(`乙${String(index)}`));
    }
    const first_index = index_path(dir.path, INSTANCE);
    const second_index = index_path(dir.path, OTHER);
    // 各自索引恰好覆盖各自正文，不存在另一实例写入的重复记录。
    expect(fs.readFileSync(first_index, "utf8").trim().split("\n")).toHaveLength(5);
    expect(fs.readFileSync(second_index, "utf8").trim().split("\n")).toHaveLength(5);
    expect(fs.readFileSync(body_path(dir.path, INSTANCE), "utf8")).not.toContain("乙");
    expect(fs.readFileSync(body_path(dir.path, OTHER), "utf8")).not.toContain("甲");

    const first_page = await first.read_page({
      date: DATE,
      instance: INSTANCE,
      direction: "latest",
    });
    const second_page = await second.read_page({
      date: DATE,
      instance: OTHER,
      direction: "latest",
    });
    expect(first_page.entries.map((entry) => entry.message_preview)).toEqual([
      "甲0",
      "甲1",
      "甲2",
      "甲3",
      "甲4",
    ]);
    expect(second_page.entries.map((entry) => entry.message_preview)).toEqual([
      "乙0",
      "乙1",
      "乙2",
      "乙3",
      "乙4",
    ]);
    await first.close();
    await second.close();
  });

  it("读取其他实例的文件不写任何索引文件", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-read-other-"));
    const owner = create_store(dir.path, OTHER);
    owner.append(DATE, record("他人的日志"));
    await owner.close();
    // 删除索引，模拟只留下正文的历史文件。
    fs.rmSync(index_path(dir.path, OTHER));

    const reader = create_store(dir.path, INSTANCE);
    const before = fs.readdirSync(dir.path).sort();
    const page = await reader.read_page({ date: DATE, instance: OTHER, direction: "latest" });
    expect(page.entries.map((entry) => entry.message_preview)).toEqual(["他人的日志"]);
    expect(fs.readdirSync(dir.path).sort()).toEqual(before);
    expect(fs.existsSync(index_path(dir.path, OTHER))).toBe(false);
    // 详情同样只读正文。
    const detail = await reader.read_detail(page.entries[0]!.id, page.entries[0]!.revision);
    expect(detail).toMatchObject({ content: "他人的日志", instance: OTHER });
    expect(fs.existsSync(index_path(dir.path, OTHER))).toBe(false);
    await reader.close();
  });

  it("其他实例继续追加时游标保持有效并从尾部续读", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-other-append-"));
    const owner = create_store(dir.path, OTHER);
    const reader = create_store(dir.path, INSTANCE);
    owner.append(DATE, record("第一行"));
    const first = await reader.read_page({ date: DATE, instance: OTHER, direction: "latest" });
    expect(first.entries).toHaveLength(1);

    owner.append(DATE, record("第二行"));
    // 查看仍在运行的其他实例时，追加不能让游标失效，否则日志窗口会被反复重置。
    const check = await reader.read_page({
      date: DATE,
      instance: OTHER,
      direction: "check",
      cursor: first.after!,
    });
    expect(check.status).toBe("ready");
    expect(check.after?.revision).toBe(first.after?.revision);

    const next = await reader.read_page({
      date: DATE,
      instance: OTHER,
      direction: "after",
      cursor: first.after!,
    });
    expect(next.entries.map((entry) => entry.message_preview)).toEqual(["第二行"]);
    await owner.close();
    await reader.close();
  });

  it("其他实例的正文等长改写仍按编辑重建", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-other-edit-"));
    const owner = create_store(dir.path, OTHER);
    const reader = create_store(dir.path, INSTANCE);
    owner.append(DATE, record("alpha"));
    const first = await reader.read_page({ date: DATE, instance: OTHER, direction: "latest" });
    const body = body_path(dir.path, OTHER);
    fs.writeFileSync(body, fs.readFileSync(body, "utf8").replace("alpha", "bravo"));
    const page = await reader.read_page({ date: DATE, instance: OTHER, direction: "latest" });
    expect(page.entries[0]?.message_preview).toBe("bravo");
    expect(page.after?.revision).not.toBe(first.after?.revision);
    await owner.close();
    await reader.close();
  });

  it("旧进程遗留的同一 PID 文件被判为复用，新进程写入独立文件", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-pid-reuse-"));
    const legacy = body_path(dir.path, String(process.pid));
    fs.writeFileSync(legacy, JSON.stringify(record("上一个进程")) + "\n");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(legacy, past, past);

    const store = new LogFileStore({
      directory: dir.path,
      process_started_at_ms: Date.now(),
    });
    store.append(DATE, record("本进程"));
    // 旧文件不被追加，新文件带启动时间后缀。
    expect(fs.readFileSync(legacy, "utf8")).not.toContain("本进程");
    const own = store
      .list_files()
      .find((file) => file.current && file.date === DATE && file.instance !== String(process.pid));
    expect(own).toBeDefined();
    expect(own!.instance.startsWith(`${String(process.pid)}-`)).toBe(true);
    await store.close();
  });

  it("目录里没有同 PID 遗留文件时沿用 PID 本身", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-pid-fresh-"));
    const store = new LogFileStore({ directory: dir.path, process_started_at_ms: Date.now() });
    store.append(DATE, record("首个进程"));
    expect(store.list_files()).toEqual([
      { date: DATE, instance: String(process.pid), current: true },
    ]);
    await store.close();
  });

  it("文件列表按日期倒序，同一天当前实例排在最前", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-list-"));
    for (const [date, instance] of [
      ["20260913", INSTANCE],
      ["20260912", OTHER],
      ["20260913", OTHER],
      ["20260911", INSTANCE],
    ]) {
      fs.writeFileSync(path.join(dir.path, `app.${date}.${instance}.jsonl`), "");
    }
    const store = create_store(dir.path);
    expect(store.list_files()).toEqual([
      { date: "20260913", instance: INSTANCE, current: true },
      { date: "20260913", instance: OTHER, current: false },
      { date: "20260912", instance: OTHER, current: false },
      { date: "20260911", instance: INSTANCE, current: true },
    ]);
    await store.close();
  });

  it("多实例并发清理同一批过期文件不会抛出", async () => {
    using dir = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "log-cleanup-race-"));
    for (const date of ["20260909", "20260910", "20260911", "20260912"]) {
      fs.writeFileSync(path.join(dir.path, `app.${date}.${OTHER}.jsonl`), "");
    }
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      const first = create_store(dir.path, INSTANCE);
      const second = create_store(dir.path, OTHER);
      // 两个实例看到同一批过期文件，后到者拿到 ENOENT 必须被静默忽略。
      first.append(DATE, record("甲"));
      second.append(DATE, record("乙"));
      const errors = vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0]));
      expect(errors.filter((text) => text.includes("ENOENT"))).toEqual([]);
      await first.close();
      await second.close();
    } finally {
      stderr.mockRestore();
    }
  });
});
