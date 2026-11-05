import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { default_native_fs } from "../../native/native-fs";
import { TermLookupCache } from "./term-lookup-cache";
import type { TermLookupResult } from "./tools/lookup-term";

const cleanup_roots: string[] = [];

afterEach(() => {
  while (cleanup_roots.length > 0)
    fs.rmSync(cleanup_roots.pop()!, { force: true, recursive: true });
});

function create_cache(now: () => number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-term-cache-"));
  cleanup_roots.push(root);
  const cache = new TermLookupCache(
    { get_user_data_path: (...parts: string[]) => path.join(root, ...parts) },
    now,
    default_native_fs,
  );
  return { cache, root };
}

const result: TermLookupResult = {
  query: "セラ",
  languages: { source: "JA", target: "ZH", isDefault: false },
  results: [
    {
      source: "wikipedia",
      language: "ja",
      title: "セラ",
      url: "https://ja.wikipedia.org/wiki/セラ",
      summary: "人物",
      readings: [],
      senses: [],
      names: [],
    },
  ],
  attribution: ["Wikimedia"],
  warnings: [],
  truncated: false,
};

describe("术语查证磁盘缓存", () => {
  it("按来源与语言隔离写入并读回结果", async () => {
    const { cache } = create_cache(() => 1_000);
    await cache.write("wikipedia", "ja>zh", "せら", result);

    await expect(cache.read("wikipedia", "ja>zh", "せら")).resolves.toEqual(result);
    await expect(cache.read("wiktionary", "ja>zh", "せら")).resolves.toBeNull();
    await expect(cache.read("wikipedia", "ja>en", "せら")).resolves.toBeNull();
  });

  it("超过有效期、系统时钟回拨或缓存损坏时视为未命中", async () => {
    let now = 1_000;
    const { cache } = create_cache(() => now);
    await cache.write("jotoba", "ja", "せら", result);

    now += 8 * 24 * 60 * 60 * 1000;
    await expect(cache.read("jotoba", "ja", "せら")).resolves.toBeNull();

    now = 1_000;
    await cache.write("jotoba", "ja", "せら", result);
    now = 0;
    await expect(cache.read("jotoba", "ja", "せら")).resolves.toBeNull();

    const file_path = (
      cache as unknown as {
        file_path(provider: string, language: string, normalized_query: string): string;
      }
    ).file_path("jotoba", "ja", "せら");
    fs.writeFileSync(file_path, "{", "utf8");
    now = 1_000;
    await expect(cache.read("jotoba", "ja", "せら")).resolves.toBeNull();
  });

  it("写入失败只放弃缓存", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-term-cache-"));
    cleanup_roots.push(root);
    const failing_fs = {
      ...default_native_fs,
      write_file_atomic: () => {
        throw new Error("disk full");
      },
    } as unknown as typeof default_native_fs;
    const cache = new TermLookupCache(
      { get_user_data_path: (...parts: string[]) => path.join(root, ...parts) },
      () => 1_000,
      failing_fs,
    );
    await expect(cache.write("wikipedia", "ja>zh", "せら", result)).resolves.toBeUndefined();
  });

  it("有效期边界按完整七天计算，边界前一毫秒仍可命中", async () => {
    let now = 1_000;
    const { cache } = create_cache(() => now);
    await cache.write("wikipedia", "ja>zh", "せら", result);

    now += 7 * 24 * 60 * 60 * 1000 - 1;
    await expect(cache.read("wikipedia", "ja>zh", "せら")).resolves.toEqual(result);

    now += 1;
    await expect(cache.read("wikipedia", "ja>zh", "せら")).resolves.toBeNull();
  });

  it("非法时间戳或嵌套结果结构按未命中处理", async () => {
    const { cache } = create_cache(() => 1_000);
    const file_path = cache_file_path(cache, "wikipedia", "ja>zh", "せら");
    fs.mkdirSync(path.dirname(file_path), { recursive: true });
    const write_envelope = (envelope: unknown) =>
      fs.writeFileSync(file_path, JSON.stringify(envelope), "utf8");

    for (const envelope of [
      { createdAt: "1000", result },
      { createdAt: null, result },
      { createdAt: 1_000, result: { ...result, languages: {} } },
      { createdAt: 1_000, result: { ...result, results: [null] } },
      { createdAt: 1_000, result: { ...result, attribution: [1] } },
      { createdAt: 1_000, result: { ...result, warnings: [false] } },
      {
        createdAt: 1_000,
        result: { ...result, results: [{ ...result.results[0], source: "unknown" }] },
      },
      {
        createdAt: 1_000,
        result: { ...result, results: [{ ...result.results[0], senses: [1] }] },
      },
      {
        createdAt: 1_000,
        result: { ...result, results: [{ ...result.results[0], names: "bad" }] },
      },
    ]) {
      write_envelope(envelope);
      await expect(cache.read("wikipedia", "ja>zh", "せら")).resolves.toBeNull();
    }
  });

  it("读取异常只放弃缓存，不向调用方抛出磁盘错误", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-term-cache-"));
    cleanup_roots.push(root);
    const failing_fs = {
      ...default_native_fs,
      read_text_file: () => {
        throw new Error("permission denied");
      },
    } as unknown as typeof default_native_fs;
    const cache = new TermLookupCache(
      { get_user_data_path: (...parts: string[]) => path.join(root, ...parts) },
      () => 1_000,
      failing_fs,
    );

    await expect(cache.read("wikipedia", "ja>zh", "せら")).resolves.toBeNull();
  });

  it("缓存文件按内容哈希寻址，写入时创建独立缓存目录", async () => {
    const { cache, root } = create_cache(() => 1_000);
    await cache.write("wikipedia", "ja>zh", "せら", result);

    const file_path = cache_file_path(cache, "wikipedia", "ja>zh", "せら");
    expect(path.dirname(file_path)).toBe(path.join(root, "cache", "term-lookup"));
    expect(path.basename(file_path)).toMatch(/^[a-f0-9]{64}\.json$/u);
    expect(file_path).not.toContain("せら");
    expect(cache_file_path(cache, "wikipedia", "ja>en", "せら")).not.toBe(file_path);
  });

  it("写入与读回使用独立的值副本，调用方后续修改不污染缓存", async () => {
    const { cache } = create_cache(() => 1_000);
    const mutable = {
      ...result,
      results: result.results.map((entry) => ({ ...entry })),
    };
    mutable.results[0]!.summary = "调用方修改";
    await cache.write("wikipedia", "ja>zh", "せら", mutable);
    mutable.results[0]!.summary = "写入后修改";

    const read = await cache.read("wikipedia", "ja>zh", "せら");
    expect(read?.results[0]?.summary).toBe("调用方修改");
    expect(read).not.toBe(mutable);
  });
});

function cache_file_path(
  cache: TermLookupCache,
  provider: "wikipedia" | "wiktionary" | "jotoba" | "jmdict",
  language: string,
  normalized_query: string,
): string {
  return (
    cache as unknown as {
      file_path(provider: string, language: string, normalized_query: string): string;
    }
  ).file_path(provider, language, normalized_query);
}
