import { is_json_record } from "../../domain/json";
import type { NativeFs } from "../../native/native-fs";
import type { AppPathService } from "../app/app-path-service";
import { JmdictProvider } from "./jmdict-provider";
import { TermLookupCache } from "./term-lookup-cache";
import { AgentToolError } from "./tool-definition";
import {
  TERM_LOOKUP_PROVIDERS,
  normalize_term_lookup_query,
  type AgentTermLookupPort,
  type TermLookupEntry,
  type TermLookupLanguages,
  type TermLookupProvider,
  type TermLookupResult,
} from "./tools/lookup-term";

const PROVIDER_TIMEOUT_MS = 8_000;
const MAX_ENTRIES_PER_PROVIDER = 4;
const MAX_ENTRIES = 8;
const MAX_OUTPUT_CHARS = 6_000;
const WIKI_ATTRIBUTION =
  "Wikipedia and Wiktionary text: Wikimedia contributors; Creative Commons Attribution-ShareAlike license.";
const JOTOBA_ATTRIBUTION =
  "Jotoba: https://jotoba.de; dictionary data credits: https://jotoba.de/about.";
const JMDICT_ATTRIBUTION =
  "JMdict: scriptin/jmdict-simplified and EDRDG; Creative Commons Attribution-ShareAlike 4.0.";

const WIKI_HOSTS: Readonly<Record<string, string>> = {
  ZH: "zh",
  "ZH-HANT": "zh",
  EN: "en",
  JA: "ja",
  KO: "ko",
  RU: "ru",
  AR: "ar",
  DE: "de",
  FR: "fr",
  PL: "pl",
  ES: "es",
  IT: "it",
  PT: "pt",
  HU: "hu",
  TR: "tr",
  TH: "th",
  ID: "id",
  VI: "vi",
};

export type TermLookupServiceOptions = Readonly<{
  paths: Pick<AppPathService, "get_user_data_path">;
  userAgent: string;
  fetch?: typeof globalThis.fetch;
  native_fs?: NativeFs;
  cache?: Pick<TermLookupCache, "read" | "write">;
  jmdict?: Pick<JmdictProvider, "lookup">;
  now?: () => number;
}>;

export function term_lookup_wiki_host(language: string): string {
  return WIKI_HOSTS[language] ?? "en";
}

/** 在线来源固定串行；单源错误只产生安全 warning，全部失败才返回稳定工具错误。 */
export class TermLookupService {
  private readonly fetch: typeof globalThis.fetch;
  private readonly cache: Pick<TermLookupCache, "read" | "write">;
  private readonly jmdict: Pick<JmdictProvider, "lookup">;

  public constructor(private readonly options: TermLookupServiceOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.cache =
      options.cache ?? new TermLookupCache(options.paths, options.now, options.native_fs);
    this.jmdict = options.jmdict ?? new JmdictProvider(options);
  }

  public readonly lookup: AgentTermLookupPort = async (request, caller_signal) => {
    caller_signal.throwIfAborted();
    const query = request.query.trim();
    const normalized_query = normalize_term_lookup_query(query);
    if (normalized_query === "") throw new AgentToolError({ code: "term_lookup.invalid_query" });
    const providers = request.sources ?? default_term_lookup_providers(request.languages);
    if (providers.length === 0) throw new AgentToolError({ code: "term_lookup.invalid_source" });
    if (providers.some((provider) => !TERM_LOOKUP_PROVIDERS.includes(provider))) {
      throw new AgentToolError({ code: "term_lookup.invalid_source" });
    }
    const selected = [...new Set(providers)];
    const results: TermLookupEntry[] = [];
    const attribution = new Set<string>();
    const warnings: string[] = [];
    const failures: unknown[] = [];
    for (const provider of selected) {
      caller_signal.throwIfAborted();
      const language = term_lookup_cache_language(provider, request.languages);
      let cached: TermLookupResult | null = null;
      try {
        cached = await this.cache.read(provider, language, normalized_query);
      } catch {
        // 缓存损坏或不可读只放弃复用，在线查询仍然有效。
      }
      if (cached !== null) {
        results.push(...cached.results);
        cached.attribution.forEach((item) => attribution.add(item));
        warnings.push(...cached.warnings);
        continue;
      }
      const timeout_signal = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
      const signal = AbortSignal.any([caller_signal, timeout_signal]);
      try {
        const entries = (
          await this.lookup_provider(provider, normalized_query, request.languages, signal)
        ).slice(0, MAX_ENTRIES_PER_PROVIDER);
        signal.throwIfAborted();
        const provider_result: TermLookupResult = {
          query,
          languages: request.languages,
          results: entries,
          attribution: entries.length === 0 ? [] : [provider_attribution(provider)],
          warnings: [],
          truncated: false,
        };
        try {
          await this.cache.write(provider, language, normalized_query, provider_result);
        } catch {
          // 缓存写入失败不改变本次在线结果。
        }
        results.push(...entries);
        if (entries.length > 0) attribution.add(provider_attribution(provider));
      } catch (error) {
        if (caller_signal.aborted) throw caller_signal.reason;
        failures.push(error);
        warnings.push(`${provider}: ${timeout_signal.aborted ? "timeout" : "unavailable"}`);
      }
    }
    if (results.length === 0 && failures.length === selected.length && selected.length > 0) {
      throw new AgentToolError(
        { code: "term_lookup.unavailable" },
        new AggregateError(failures, "All term lookup providers failed."),
      );
    }
    return limit_term_lookup_result({
      query,
      languages: request.languages,
      results,
      attribution: [...attribution],
      warnings: [...new Set(warnings)],
      truncated: false,
    });
  };

  private async lookup_provider(
    provider: TermLookupProvider,
    query: string,
    languages: TermLookupLanguages,
    signal: AbortSignal,
  ): Promise<TermLookupEntry[]> {
    if (provider === "jmdict") return this.jmdict.lookup(query, signal);
    if (provider === "jotoba") return this.lookup_jotoba(query, signal);
    return this.lookup_wiki(provider, query, languages, signal);
  }

  private async lookup_wiki(
    provider: "wikipedia" | "wiktionary",
    query: string,
    languages: TermLookupLanguages,
    signal: AbortSignal,
  ): Promise<TermLookupEntry[]> {
    const source_host = term_lookup_wiki_host(languages.source);
    const target_host = term_lookup_wiki_host(languages.target);
    const project = provider === "wikipedia" ? "wikipedia" : "wiktionary";
    const entries: TermLookupEntry[] = [];
    for (const language of new Set([source_host, target_host])) {
      const url = `https://${language}.${project}.org/w/api.php?${new URLSearchParams({ action: "query", generator: "search", gsrsearch: query, gsrlimit: "2", prop: "extracts|info", exintro: "1", exlimit: "max", explaintext: "1", inprop: "url", redirects: "1", format: "json", formatversion: "2", origin: "*" })}`;
      const response = await this.fetch(url, { headers: this.headers(), signal });
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`${provider} returned HTTP ${response.status}.`);
      const data: unknown = await response.json();
      if (
        !is_json_record(data) ||
        !is_json_record(data["query"]) ||
        !Array.isArray(data["query"]["pages"])
      )
        continue;
      for (const page of data["query"]["pages"]) {
        if (!is_json_record(page) || typeof page["title"] !== "string") continue;
        const full_url =
          typeof page["fullurl"] === "string"
            ? page["fullurl"]
            : `https://${language}.${project}.org/wiki/${encodeURIComponent(page["title"])}`;
        entries.push({
          source: provider,
          language,
          title: page["title"],
          url: full_url,
          summary: typeof page["extract"] === "string" ? page["extract"] : "",
          readings: [],
          senses: [],
          names: [],
        });
      }
    }
    return entries;
  }

  private async lookup_jotoba(query: string, signal: AbortSignal): Promise<TermLookupEntry[]> {
    const response = await this.fetch("https://jotoba.de/api/search/words", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ query, language: "English", no_english: false }),
      signal,
    });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`Jotoba returned HTTP ${response.status}.`);
    const data: unknown = await response.json();
    if (!is_json_record(data) || !Array.isArray(data["words"])) return [];
    const entries: TermLookupEntry[] = [];
    for (const word of data["words"]) {
      if (!is_json_record(word) || !is_json_record(word["reading"])) continue;
      const reading = word["reading"];
      const title =
        typeof reading["kanji"] === "string"
          ? reading["kanji"]
          : typeof reading["kana"] === "string"
            ? reading["kana"]
            : query;
      const senses = Array.isArray(word["senses"])
        ? word["senses"].flatMap((sense) =>
            is_json_record(sense) && Array.isArray(sense["glosses"])
              ? sense["glosses"].filter((gloss): gloss is string => typeof gloss === "string")
              : [],
          )
        : [];
      const readings = typeof reading["kana"] === "string" ? [reading["kana"]] : [];
      entries.push({
        source: "jotoba",
        language: "ja",
        title,
        url: `https://jotoba.de/search/0/${encodeURIComponent(title)}`,
        summary: senses.join("; "),
        readings,
        senses,
        names: [],
      });
    }
    // 人名结果形状与词语接口不同；该接口失败不影响已经取得的词语结果。
    const names_response = await this.fetch("https://jotoba.de/api/search/names", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ query, language: "English", no_english: false }),
      signal,
    });
    if (names_response.ok) {
      const data: unknown = await names_response.json();
      const names = is_json_record(data) && Array.isArray(data["names"]) ? data["names"] : [];
      for (const name of names) {
        if (!is_json_record(name)) continue;
        const kanji = typeof name["kanji"] === "string" ? [name["kanji"]] : [];
        const kana = typeof name["kana"] === "string" ? [name["kana"]] : [];
        const transcription =
          typeof name["transcription"] === "string" ? name["transcription"] : "";
        const title = kanji[0] ?? kana[0] ?? query;
        entries.push({
          source: "jotoba",
          language: "ja",
          title,
          url: `https://jotoba.de/search/1/${encodeURIComponent(title)}`,
          summary: transcription || kana.join(", "),
          readings: kana,
          senses: [],
          names: kanji,
        });
      }
    } else if (names_response.status !== 404 && entries.length === 0) {
      throw new Error(`Jotoba names returned HTTP ${names_response.status}.`);
    }
    return entries;
  }

  private headers(): Record<string, string> {
    return {
      "User-Agent": this.options.userAgent,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }
}

export function default_term_lookup_providers(
  languages: TermLookupLanguages,
): readonly TermLookupProvider[] {
  // ALL 表示来源语言自动识别，可能包含日文，因此同样提供日文专用来源。
  return languages.source === "JA" || languages.source === "ALL" || languages.target === "JA"
    ? TERM_LOOKUP_PROVIDERS
    : (["wikipedia", "wiktionary"] as const);
}

function term_lookup_cache_language(
  provider: TermLookupProvider,
  languages: TermLookupLanguages,
): string {
  return provider === "jotoba" || provider === "jmdict"
    ? "ja"
    : `${term_lookup_wiki_host(languages.source)}>${term_lookup_wiki_host(languages.target)}`;
}

function provider_attribution(provider: TermLookupProvider): string {
  if (provider === "jotoba") return JOTOBA_ATTRIBUTION;
  if (provider === "jmdict") return JMDICT_ATTRIBUTION;
  return WIKI_ATTRIBUTION;
}

/** 字符串预算截断在 JSON 序列化之前完成，结果始终是有效结构而非半截 JSON。 */
export function limit_term_lookup_result(input: TermLookupResult): TermLookupResult {
  const result: TermLookupResult = { ...input, results: input.results.slice(0, MAX_ENTRIES) };
  let truncated = input.truncated || result.results.length < input.results.length;
  const lengths = () => JSON.stringify(result).length;
  while (lengths() > MAX_OUTPUT_CHARS && result.results.length > 0) {
    const entries = result.results.map((entry) => ({ ...entry }));
    const entry = entries.at(-1)!;
    const overflow = lengths() - MAX_OUTPUT_CHARS + 32;
    if (entry.summary.length > 0)
      entry.summary = entry.summary.slice(0, Math.max(0, entry.summary.length - overflow));
    else if (entry.senses.length > 0) entry.senses = entry.senses.slice(0, -1);
    else entries.pop();
    Object.assign(result, { results: entries });
    truncated = true;
  }
  return { ...result, truncated };
}
