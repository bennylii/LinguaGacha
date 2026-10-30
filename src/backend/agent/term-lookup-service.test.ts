import { describe, expect, it, vi } from "vitest";

import {
  TermLookupService,
  default_term_lookup_providers,
  limit_term_lookup_result,
  term_lookup_wiki_host,
} from "./term-lookup-service";
import type { JmdictProvider } from "./jmdict-provider";
import type { TermLookupCache } from "./term-lookup-cache";
import type {
  TermLookupEntry,
  TermLookupLanguages,
  TermLookupProvider,
  TermLookupResult,
} from "./tools/lookup-term";

const languages: TermLookupLanguages = { source: "JA", target: "ZH", isDefault: false };

function make_cache() {
  return {
    read: vi.fn(
      async (
        _provider: TermLookupProvider,
        _language: string,
        _normalized_query: string,
      ): Promise<TermLookupResult | null> => null,
    ),
    write: vi.fn(
      async (
        _provider: TermLookupProvider,
        _language: string,
        _normalized_query: string,
        _result: TermLookupResult,
      ): Promise<void> => undefined,
    ),
  };
}

function make_jmdict() {
  return { lookup: vi.fn(async () => [] as TermLookupEntry[]) };
}

function make_service(options: {
  fetch: typeof globalThis.fetch;
  cache?: Pick<TermLookupCache, "read" | "write">;
  jmdict?: Pick<JmdictProvider, "lookup">;
}) {
  return new TermLookupService({
    paths: {
      get_user_data_path: (...parts: string[]) => `C:/cache/linguagacha/${parts.join("/")}`,
    },
    userAgent: "LinguaGacha-Test",
    fetch: options.fetch,
    cache: options.cache ?? make_cache(),
    jmdict: options.jmdict ?? make_jmdict(),
  });
}

function json_response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("术语外部查证", () => {
  it("按语言选择百科站点并保留全部适用来源", () => {
    expect(term_lookup_wiki_host("ZH-HANT")).toBe("zh");
    expect(term_lookup_wiki_host("unknown")).toBe("en");
    expect(default_term_lookup_providers(languages)).toEqual([
      "wikipedia",
      "wiktionary",
      "jotoba",
      "jmdict",
    ]);
    expect(default_term_lookup_providers({ source: "EN", target: "ZH", isDefault: false })).toEqual(
      ["wikipedia", "wiktionary"],
    );
    expect(
      default_term_lookup_providers({ source: "ALL", target: "ZH", isDefault: false }),
    ).toEqual(["wikipedia", "wiktionary", "jotoba", "jmdict"]);
  });

  it("Wikipedia 同时查询源语言与目标语言，并过滤缺页结果", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const host = new URL(String(input)).host;
      if (host === "ja.wikipedia.org") {
        return json_response({
          query: {
            pages: [
              { title: "セラ", fullurl: "https://ja.wikipedia.org/wiki/セラ", extract: "人物" },
              { title: "欠落" },
            ],
          },
        });
      }
      return json_response({
        query: {
          pages: [{ title: "塞拉", fullurl: "https://zh.wikipedia.org/wiki/塞拉", extract: "" }],
        },
      });
    });
    const service = make_service({ fetch });

    const result = await service.lookup(
      { query: "セラ", sources: ["wikipedia"], languages },
      new AbortController().signal,
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.results).toEqual([
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
      {
        source: "wikipedia",
        language: "ja",
        title: "欠落",
        url: "https://ja.wikipedia.org/wiki/%E6%AC%A0%E8%90%BD",
        summary: "",
        readings: [],
        senses: [],
        names: [],
      },
      {
        source: "wikipedia",
        language: "zh",
        title: "塞拉",
        url: "https://zh.wikipedia.org/wiki/塞拉",
        summary: "",
        readings: [],
        senses: [],
        names: [],
      },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.attribution).toHaveLength(1);
  });

  it("Jotoba 使用 POST 词语与人名接口，并按实际字符串字段组结果", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/search/words")) {
        return json_response({
          words: [{ reading: { kanji: "セラ", kana: "せら" }, senses: [{ glosses: ["Sera"] }] }],
        });
      }
      return json_response({
        names: [{ kanji: "世良", kana: "せら", transcription: "Sera" }],
      });
    });
    const service = make_service({ fetch });

    const result = await service.lookup(
      { query: " セラ ", sources: ["jotoba"], languages },
      new AbortController().signal,
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://jotoba.de/api/search/words");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "セラ",
      language: "English",
      no_english: false,
    });
    expect(result.query).toBe("セラ");
    expect(result.results).toEqual([
      {
        source: "jotoba",
        language: "ja",
        title: "セラ",
        url: "https://jotoba.de/search/0/%E3%82%BB%E3%83%A9",
        summary: "Sera",
        readings: ["せら"],
        senses: ["Sera"],
        names: [],
      },
      {
        source: "jotoba",
        language: "ja",
        title: "世良",
        url: "https://jotoba.de/search/1/%E4%B8%96%E8%89%AF",
        summary: "Sera",
        readings: ["せら"],
        senses: [],
        names: ["世良"],
      },
    ]);
  });

  it("单个来源失败只降级为警告，全部失败返回稳定工具错误", async () => {
    const partial_fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).includes("wikipedia.org")) throw new Error("offline");
      if (String(input).endsWith("/api/search/words"))
        return json_response({
          words: [{ reading: { kana: "せら" }, senses: [{ glosses: ["Sera"] }] }],
        });
      return json_response({}, 404);
    });
    const partial = await make_service({ fetch: partial_fetch }).lookup(
      { query: "セラ", sources: ["wikipedia", "jotoba"], languages },
      new AbortController().signal,
    );
    expect(partial.results).toHaveLength(1);
    expect(partial.warnings).toEqual(["wikipedia: unavailable"]);

    const failing_fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("offline");
    });
    await expect(
      make_service({ fetch: failing_fetch }).lookup(
        { query: "セラ", sources: ["wikipedia"], languages },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ details: { code: "term_lookup.unavailable" } });
  });

  it("缓存命中不再请求网络，缓存写入失败不影响结果", async () => {
    const cached: TermLookupResult = {
      query: "セラ",
      languages,
      results: [
        {
          source: "wikipedia",
          language: "ja",
          title: "セラ",
          url: "https://ja.wikipedia.org/wiki/セラ",
          summary: "缓存",
          readings: [],
          senses: [],
          names: [],
        },
      ],
      attribution: ["cached"],
      warnings: [],
      truncated: false,
    };
    const fetch = vi.fn<typeof globalThis.fetch>();
    const cache = { read: vi.fn(async () => cached), write: vi.fn(async () => undefined) };
    const result = await make_service({ fetch, cache }).lookup(
      { query: "セラ", sources: ["wikipedia"], languages },
      new AbortController().signal,
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(cache.write).not.toHaveBeenCalled();
    expect(result.results[0]?.summary).toBe("缓存");

    const write_failure_fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json_response({
        query: { pages: [{ title: "セラ", fullurl: "https://ja.wikipedia.org/wiki/セラ" }] },
      }),
    );
    const write_failure_cache = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => {
        throw new Error("disk full");
      }),
    };
    const result_after_write_failure = await make_service({
      fetch: write_failure_fetch,
      cache: write_failure_cache,
    }).lookup({ query: "セラ", sources: ["wikipedia"], languages }, new AbortController().signal);
    expect(result_after_write_failure.results.length).toBeGreaterThan(0);
  });

  it("拒绝空查询、空来源与未知来源", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const service = make_service({ fetch });
    await expect(
      service.lookup(
        { query: "  ", sources: ["wikipedia"], languages },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ details: { code: "term_lookup.invalid_query" } });
    await expect(
      service.lookup({ query: "セラ", sources: [], languages }, new AbortController().signal),
    ).rejects.toMatchObject({ details: { code: "term_lookup.invalid_source" } });
    await expect(
      service.lookup(
        { query: "セラ", sources: ["unknown" as never], languages },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ details: { code: "term_lookup.invalid_source" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("结果预算截断保持 JSON 有效并标记 truncated", () => {
    const results = Array.from({ length: 9 }, (_, index): TermLookupEntry => ({
      source: "wikipedia",
      language: "ja",
      title: `标题${index}`,
      url: `https://ja.wikipedia.org/wiki/${index}`,
      summary: "長".repeat(1_000),
      readings: [],
      senses: [],
      names: [],
    }));
    const limited = limit_term_lookup_result({
      query: "q",
      languages,
      results,
      attribution: [],
      warnings: [],
      truncated: false,
    });

    expect(limited.results.length).toBeLessThanOrEqual(8);
    expect(limited.truncated).toBe(true);
    expect(JSON.stringify(limited).length).toBeLessThanOrEqual(6_000);
  });

  it("截断优先压缩摘要，再删除义项，最后移除条目", () => {
    const results = Array.from({ length: 8 }, (_, index): TermLookupEntry => ({
      source: "wikipedia",
      language: "ja",
      title: `标题${index}`,
      url: `https://ja.wikipedia.org/wiki/${index}`,
      summary: "",
      readings: [],
      senses: ["長".repeat(1_000)],
      names: [],
    }));
    const limited = limit_term_lookup_result({
      query: "q",
      languages,
      results,
      attribution: [],
      warnings: [],
      truncated: false,
    });

    expect(limited.truncated).toBe(true);
    expect(JSON.stringify(limited).length).toBeLessThanOrEqual(6_000);
    expect(limited.results.length).toBeLessThan(results.length);
  });

  it("查询按 NFKC 与小写规范化后发送，缓存键和结果保留原始查询", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json_response({ query: { pages: [] } }),
    );
    const cache = make_cache();
    const service = make_service({ fetch, cache });

    const result = await service.lookup(
      {
        query: " ＳＥＲＡ ",
        sources: ["wikipedia"],
        languages: { source: "EN", target: "EN", isDefault: false },
      },
      new AbortController().signal,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get("gsrsearch")).toBe("sera");
    expect(url.searchParams.get("formatversion")).toBe("2");
    expect(url.searchParams.get("gsrlimit")).toBe("2");
    expect(cache.read).toHaveBeenCalledWith("wikipedia", "en>en", "sera");
    expect(cache.write).toHaveBeenCalledWith(
      "wikipedia",
      "en>en",
      "sera",
      expect.objectContaining({ query: "ＳＥＲＡ" }),
    );
    expect(result.query).toBe("ＳＥＲＡ");
  });

  it("同一 wiki 站点只请求一次，显式重复来源只查询一次", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json_response({ query: { pages: [] } }),
    );
    const service = make_service({ fetch });

    await service.lookup(
      {
        query: "セラ",
        sources: ["wikipedia", "wikipedia", "wikipedia"],
        languages: { source: "JA", target: "JA", isDefault: false },
      },
      new AbortController().signal,
    );

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("日文来源或目标涉及日文时默认加入 Jotoba 与 JMdict", () => {
    expect(default_term_lookup_providers({ source: "EN", target: "JA", isDefault: false })).toEqual(
      ["wikipedia", "wiktionary", "jotoba", "jmdict"],
    );
    expect(term_lookup_wiki_host("JA")).toBe("ja");
    expect(term_lookup_wiki_host("KO")).toBe("ko");
  });

  it("缓存读取异常时回退在线查询，来源缓存键按来源类型区分", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).includes("jotoba.de/api/search/words")) return json_response({ words: [] });
      if (String(input).includes("jotoba.de/api/search/names")) return json_response({ names: [] });
      return json_response({ query: { pages: [] } });
    });
    const cache = {
      read: vi.fn(
        async (
          _provider: TermLookupProvider,
          _language: string,
          _normalized_query: string,
        ): Promise<TermLookupResult | null> => {
          throw new Error("cache unavailable");
        },
      ),
      write: vi.fn(async () => undefined),
    };
    const jmdict = make_jmdict();
    const result = await make_service({ fetch, cache, jmdict }).lookup(
      { query: "セラ", languages, sources: ["wikipedia", "jotoba", "jmdict"] },
      new AbortController().signal,
    );

    expect(result.results).toEqual([]);
    expect(cache.read.mock.calls.map(([provider, language]) => [provider, language])).toEqual([
      ["wikipedia", "ja>zh"],
      ["jotoba", "ja"],
      ["jmdict", "ja"],
    ]);
    expect(jmdict.lookup).toHaveBeenCalledTimes(1);
  });

  it("缓存命中与在线来源失败可以共存，来源失败降级为警告", async () => {
    const cached: TermLookupResult = {
      query: "セラ",
      languages,
      results: [
        {
          source: "wikipedia",
          language: "ja",
          title: "セラ",
          url: "https://ja.wikipedia.org/wiki/セラ",
          summary: "缓存",
          readings: [],
          senses: [],
          names: [],
        },
      ],
      attribution: ["Wikimedia"],
      warnings: ["cached warning"],
      truncated: false,
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("offline");
    });
    const cache = {
      read: vi.fn(async (provider: string) => (provider === "wikipedia" ? cached : null)),
      write: vi.fn(async () => undefined),
    };
    const result = await make_service({ fetch, cache }).lookup(
      { query: "セラ", sources: ["wikipedia", "jotoba"], languages },
      new AbortController().signal,
    );

    expect(result.results[0]?.summary).toBe("缓存");
    expect(result.attribution).toEqual(["Wikimedia"]);
    expect(result.warnings).toContain("cached warning");
    expect(result.warnings).toContain("jotoba: unavailable");
  });

  it("Jotoba 人名接口失败不影响已经取得的词语结果", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).endsWith("/api/search/names")) return json_response({}, 500);
      return json_response({
        words: [{ reading: { kana: "せら" }, senses: [{ glosses: ["Sera"] }] }],
      });
    });
    const result = await make_service({ fetch }).lookup(
      { query: "セラ", sources: ["jotoba"], languages },
      new AbortController().signal,
    );

    expect(result.results).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it("调用方取消后立即停止并保留取消原因", async () => {
    const controller = new AbortController();
    const reason = new Error("停止查证");
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const service = make_service({ fetch });
    const pending = service.lookup(
      { query: "セラ", sources: ["wikipedia"], languages },
      controller.signal,
    );
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("来源超时只产生 timeout 警告", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        json_response({ query: { pages: [] } }),
      );
      const cached: TermLookupResult = {
        query: "セラ",
        languages,
        results: [
          {
            source: "jmdict",
            language: "ja",
            title: "セラ",
            url: "https://jisho.org/search/%E3%82%BB%E3%83%A9",
            summary: "cache",
            readings: [],
            senses: [],
            names: [],
          },
        ],
        attribution: [],
        warnings: [],
        truncated: false,
      };
      const cache = {
        read: vi.fn(async (provider: TermLookupProvider) =>
          provider === "jmdict" ? cached : null,
        ),
        write: vi.fn(async () => undefined),
      };
      const result = await make_service({ fetch, cache }).lookup(
        { query: "セラ", sources: ["wikipedia", "jmdict"], languages },
        new AbortController().signal,
      );

      expect(result.warnings).toEqual(["wikipedia: timeout"]);
      expect(result.results[0]?.summary).toBe("cache");
    } finally {
      timeout.mockRestore();
    }
  });

  it("调用前已取消时不读取缓存也不请求网络", async () => {
    const controller = new AbortController();
    const reason = new Error("提前取消");
    controller.abort(reason);
    const cache = make_cache();
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(
      make_service({ fetch, cache }).lookup(
        { query: "セラ", sources: ["wikipedia"], languages },
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(cache.read).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
