import { createHash } from "node:crypto";
import path from "node:path";

import { is_json_record } from "../../domain/json";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import type { AppPathService } from "../app/app-path-service";
import {
  TERM_LOOKUP_PROVIDERS,
  type TermLookupEntry,
  type TermLookupProvider,
  type TermLookupResult,
} from "./tools/lookup-term";

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_DIRECTORY = ["cache", "term-lookup"] as const;

type CacheEnvelope = Readonly<{ createdAt: number; result: TermLookupResult }>;

/** 磁盘缓存是性能优化；损坏、过期或写入失败均不改变在线查询结果。 */
export class TermLookupCache {
  public constructor(
    private readonly paths: Pick<AppPathService, "get_user_data_path">,
    private readonly now: () => number = Date.now,
    private readonly native_fs: NativeFs = default_native_fs,
  ) {}

  public async read(
    provider: TermLookupProvider,
    language: string,
    normalized_query: string,
  ): Promise<TermLookupResult | null> {
    try {
      const envelope = JSON.parse(
        this.native_fs.read_text_file(this.file_path(provider, language, normalized_query)),
      ) as CacheEnvelope;
      const now = this.now();
      if (
        !Number.isFinite(envelope.createdAt) ||
        now - envelope.createdAt >= CACHE_MAX_AGE_MS ||
        now < envelope.createdAt
      )
        return null;
      if (!is_term_lookup_result(envelope.result)) return null;
      return structuredClone(envelope.result);
    } catch {
      return null;
    }
  }

  public async write(
    provider: TermLookupProvider,
    language: string,
    normalized_query: string,
    result: TermLookupResult,
  ): Promise<void> {
    try {
      const envelope: CacheEnvelope = { createdAt: this.now(), result: structuredClone(result) };
      this.native_fs.write_file_atomic(
        this.file_path(provider, language, normalized_query),
        JSON.stringify(envelope),
      );
    } catch {
      // 缓存不可写时在线结果仍然有效。
    }
  }

  private file_path(
    provider: TermLookupProvider,
    language: string,
    normalized_query: string,
  ): string {
    const key = createHash("sha256")
      .update(`${provider}\0${language}\0${normalized_query}`)
      .digest("hex");
    return path.join(this.paths.get_user_data_path(...CACHE_DIRECTORY), `${key}.json`);
  }
}

function is_term_lookup_result(value: unknown): value is TermLookupResult {
  if (!is_json_record(value)) return false;
  const languages = value["languages"];
  return (
    typeof value["query"] === "string" &&
    is_json_record(languages) &&
    typeof languages["source"] === "string" &&
    typeof languages["target"] === "string" &&
    typeof languages["isDefault"] === "boolean" &&
    Array.isArray(value["results"]) &&
    value["results"].every(is_term_lookup_entry) &&
    is_string_array(value["attribution"]) &&
    is_string_array(value["warnings"]) &&
    typeof value["truncated"] === "boolean"
  );
}

function is_term_lookup_entry(value: unknown): value is TermLookupEntry {
  return (
    is_json_record(value) &&
    typeof value["source"] === "string" &&
    TERM_LOOKUP_PROVIDERS.includes(value["source"] as TermLookupProvider) &&
    typeof value["language"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["url"] === "string" &&
    typeof value["summary"] === "string" &&
    is_string_array(value["readings"]) &&
    is_string_array(value["senses"]) &&
    is_string_array(value["names"])
  );
}

function is_string_array(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
