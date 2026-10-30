import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JMDICT_CACHE_FILE_NAME,
  JMDICT_DEFAULT_LICENSE,
  JMDICT_PACKAGE_SHA256,
  JMDICT_RELEASE_VERSION,
  JmdictProvider,
  build_jmdict_index,
} from "./jmdict-provider";

const cleanup_roots: string[] = [];

afterEach(() => {
  while (cleanup_roots.length > 0)
    fs.rmSync(cleanup_roots.pop()!, { force: true, recursive: true });
});

function create_root(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-jmdict-"));
  cleanup_roots.push(root);
  return root;
}

const default_words = [
  {
    id: "1",
    kanji: [{ common: true, text: "猫" }],
    kana: [
      { common: true, text: "ねこ", appliesToKanji: ["*"] },
      { common: false, text: "ネコ", appliesToKanji: ["*"] },
    ],
    sense: [{ gloss: [{ lang: "eng", text: "cat" }] }],
  },
];

async function create_package(
  version = JMDICT_RELEASE_VERSION,
  words: unknown = default_words,
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "jmdict-eng-common.json",
    JSON.stringify({
      version,
      dictDate: "2026-10-26",
      words,
    }),
  );
  return zip.generateAsync({ type: "uint8array" });
}

function create_provider(
  fetch: typeof globalThis.fetch,
  root: string,
  sha256: (bytes: Uint8Array) => string = () => JMDICT_PACKAGE_SHA256,
) {
  return new JmdictProvider({
    paths: { get_user_data_path: (...parts: string[]) => path.join(root, ...parts) },
    userAgent: "LinguaGacha-Test",
    fetch,
    sha256,
  });
}

describe("JMdict 常用词包", () => {
  it("首次查询下载压缩包并写入常用词与许可证，随后复用缓存", async () => {
    const root = create_root();
    const package_bytes = await create_package();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(package_bytes as unknown as BodyInit),
    );
    const provider = create_provider(fetch, root);

    await expect(provider.lookup("猫", new AbortController().signal)).resolves.toEqual([
      {
        source: "jmdict",
        language: "ja",
        title: "猫",
        url: "https://jisho.org/search/%E7%8C%AB",
        summary: "cat",
        readings: ["ねこ", "ネコ"],
        senses: ["cat"],
        names: [],
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const requested = String(fetch.mock.calls[0]?.[0]);
    expect(requested).toContain("scriptin/jmdict-simplified/releases/download/");
    expect(requested).toContain("jmdict-eng-common-3.6.2");
    const cache_path = path.join(root, "dictionaries", "jmdict", JMDICT_CACHE_FILE_NAME);
    expect(fs.existsSync(cache_path)).toBe(true);
    expect(fs.existsSync(path.join(root, "dictionaries", "jmdict", "LICENSE"))).toBe(true);

    await expect(provider.lookup("ねこ", new AbortController().signal)).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);

    const reopened = create_provider(fetch, root);
    await expect(reopened.lookup("ネコ", new AbortController().signal)).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("版本不匹配的包不写入缓存并允许后续重试", async () => {
    const root = create_root();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response((await create_package("3.6.1")) as unknown as BodyInit),
    );
    const provider = create_provider(fetch, root);

    await expect(provider.lookup("猫", new AbortController().signal)).rejects.toThrow(
      "Invalid JMdict common package structure.",
    );
    expect(fs.existsSync(path.join(root, "dictionaries", "jmdict", JMDICT_CACHE_FILE_NAME))).toBe(
      false,
    );

    fetch.mockImplementationOnce(
      async () => new Response((await create_package()) as unknown as BodyInit),
    );
    await expect(provider.lookup("猫", new AbortController().signal)).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("索引假名写法，保留多义项并限制每个查询最多两条", async () => {
    const root = create_root();
    const words = [
      {
        id: "1",
        kanji: [],
        kana: [
          { common: true, text: "ねこ" },
          { common: true, text: "ねこ" },
        ],
        sense: [
          { gloss: [{ lang: "eng", text: "cat" }] },
          {
            gloss: [
              { lang: "jpn", text: "猫" },
              { lang: "eng", text: "kitty" },
            ],
          },
        ],
      },
      {
        id: "2",
        kanji: [],
        kana: [{ common: false, text: "ねこ" }],
        sense: [{ gloss: [{ lang: "eng", text: "second" }] }],
      },
      {
        id: "3",
        kanji: [],
        kana: [{ common: false, text: "ねこ" }],
        sense: [{ gloss: [{ lang: "eng", text: "third" }] }],
      },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response((await create_package(JMDICT_RELEASE_VERSION, words)) as unknown as BodyInit),
    );
    const provider = create_provider(fetch, root);

    const results = await provider.lookup("ねこ", new AbortController().signal);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: "ねこ",
      readings: ["ねこ"],
      senses: ["cat", "kitty"],
      summary: "cat; kitty",
    });
    expect(await provider.lookup("存在しない", new AbortController().signal)).toEqual([]);
  });

  it("损坏的本地缓存会重新下载并替换为有效词包", async () => {
    const root = create_root();
    const cache_path = path.join(root, "dictionaries", "jmdict", JMDICT_CACHE_FILE_NAME);
    fs.mkdirSync(path.dirname(cache_path), { recursive: true });
    fs.writeFileSync(cache_path, "not a zip");
    const bytes = await create_package();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(bytes as unknown as BodyInit),
    );
    const provider = create_provider(fetch, root);

    await expect(provider.lookup("猫", new AbortController().signal)).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(fs.readFileSync(cache_path))).toEqual(bytes);
  });

  it("校验失败的下载不写入缓存，后续调用可以重试", async () => {
    const root = create_root();
    const bytes = await create_package();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(bytes as unknown as BodyInit),
    );
    const provider = create_provider(fetch, root, () => "mismatch");
    const cache_path = path.join(root, "dictionaries", "jmdict", JMDICT_CACHE_FILE_NAME);

    await expect(provider.lookup("猫", new AbortController().signal)).rejects.toThrow(
      "JMdict checksum mismatch.",
    );
    expect(fs.existsSync(cache_path)).toBe(false);
    await expect(provider.lookup("猫", new AbortController().signal)).rejects.toThrow(
      "JMdict checksum mismatch.",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("下载 HTTP 失败后重置索引，下一次调用重新请求", async () => {
    const root = create_root();
    const bytes = await create_package();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("blocked", { status: 503 }))
      .mockResolvedValueOnce(new Response(bytes as unknown as BodyInit));
    const provider = create_provider(fetch, root);

    await expect(provider.lookup("猫", new AbortController().signal)).rejects.toThrow(
      "JMdict download failed with HTTP 503.",
    );
    await expect(provider.lookup("猫", new AbortController().signal)).resolves.toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("并发查询共享同一次首次下载", async () => {
    const root = create_root();
    const bytes = await create_package();
    let resolve_response!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolve_response = resolve;
        }),
    );
    const provider = create_provider(fetch, root);
    const signal = new AbortController().signal;

    const first = provider.lookup("猫", signal);
    const second = provider.lookup("猫", signal);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve_response(new Response(bytes as unknown as BodyInit));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("调用前取消时不会发起下载", async () => {
    const root = create_root();
    const reason = new Error("提前取消");
    const controller = new AbortController();
    controller.abort(reason);
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(create_provider(fetch, root).lookup("猫", controller.signal)).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("写入许可证说明数据来源和许可协议", async () => {
    const root = create_root();
    const bytes = await create_package();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(bytes as unknown as BodyInit),
    );
    await create_provider(fetch, root).lookup("猫", new AbortController().signal);

    expect(fs.readFileSync(path.join(root, "dictionaries", "jmdict", "LICENSE"), "utf8")).toBe(
      JMDICT_DEFAULT_LICENSE,
    );
    expect(JMDICT_DEFAULT_LICENSE).toContain("https://github.com/scriptin/jmdict-simplified");
    expect(JMDICT_DEFAULT_LICENSE).toContain("https://creativecommons.org/licenses/by-sa/4.0/");
  });

  it("拒绝缺少词形或结构非法的词条", () => {
    expect(() =>
      build_jmdict_index({
        version: JMDICT_RELEASE_VERSION,
        words: [{ id: "1", kanji: [], kana: [], sense: [] }],
      }),
    ).toThrow("Invalid JMdict word entry.");
    expect(() => build_jmdict_index({ version: JMDICT_RELEASE_VERSION, words: "bad" })).toThrow(
      "Invalid JMdict common package structure.",
    );
  });
});
