import { createHash } from "node:crypto";
import path from "node:path";

import JSZip from "jszip";

import { is_json_record } from "../../domain/json";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import type { AppPathService } from "../app/app-path-service";
import { normalize_term_lookup_query, type TermLookupEntry } from "./tools/lookup-term";

// 固定发布版本与资产哈希，避免自动跟随上游时在无感知情况下更换词库内容。
const JMDICT_RELEASE_TAG = "3.6.2+20261026175559";
export const JMDICT_RELEASE_VERSION = "3.6.2";
export const JMDICT_CACHE_FILE_NAME = `jmdict-eng-common-${JMDICT_RELEASE_TAG}.json.zip`;
export const JMDICT_PACKAGE_SHA256 =
  "a6b049ec605fa1135f02fa772edee6a71cffcbe6f7e321143667946f93b32dde";
const JMDICT_ZIP_URL = `https://github.com/scriptin/jmdict-simplified/releases/download/${encodeURIComponent(JMDICT_RELEASE_TAG)}/${encodeURIComponent(JMDICT_CACHE_FILE_NAME)}`;
const JMDICT_MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const JMDICT_MAX_EXTRACTED_CHARS = 64 * 1024 * 1024;
const JMDICT_MAX_ENTRY_COUNT = 250_000;
const JMDICT_DIRECTORY = ["dictionaries", "jmdict"] as const;
const JMDICT_ATTRIBUTION =
  "JMdict data: scriptin/jmdict-simplified and Electronic Dictionary Research and Development Group (EDRDG); Creative Commons Attribution-ShareAlike 4.0.";

export const JMDICT_DEFAULT_LICENSE = `${JMDICT_ATTRIBUTION}\nSource: https://github.com/scriptin/jmdict-simplified\nLicense: https://creativecommons.org/licenses/by-sa/4.0/\n`;

type JmdictWord = Readonly<{
  id: string;
  kanji: readonly { common?: boolean; text: string }[];
  kana: readonly { common?: boolean; text: string; appliesToKanji?: readonly string[] }[];
  sense: readonly { gloss: readonly { lang: string; text: string }[] }[];
}>;

export type JmdictProviderOptions = Readonly<{
  paths: Pick<AppPathService, "get_user_data_path">;
  fetch?: typeof globalThis.fetch;
  userAgent: string;
  native_fs?: NativeFs;
  sha256?: (bytes: Uint8Array) => string;
}>;

/** 首次使用才下载常用词包；完整文件与内存索引都属于用户数据而非工程数据。 */
export class JmdictProvider {
  private index: Promise<Map<string, JmdictWord[]>> | null = null;
  private readonly fetch: typeof globalThis.fetch;
  private readonly native_fs: NativeFs;

  public constructor(private readonly options: JmdictProviderOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.native_fs = options.native_fs ?? default_native_fs;
  }

  public async lookup(query: string, signal: AbortSignal): Promise<TermLookupEntry[]> {
    const normalized = normalize_term_lookup_query(query);
    let index = this.index;
    if (index === null) {
      index = this.load_index(signal);
      this.index = index;
    }
    try {
      const words = (await index).get(normalized) ?? [];
      return words.slice(0, 2).map((word) => {
        const readings = [...new Set(word.kana.map(({ text }) => text))];
        const title =
          word.kanji.find(({ common }) => common)?.text ?? word.kanji[0]?.text ?? readings[0]!;
        return {
          source: "jmdict",
          language: "ja",
          title,
          url: `https://jisho.org/search/${encodeURIComponent(title)}`,
          summary: word.sense
            .flatMap((sense) =>
              sense.gloss.filter((gloss) => gloss.lang === "eng").map((gloss) => gloss.text),
            )
            .join("; "),
          readings,
          senses: word.sense
            .map((sense) =>
              sense.gloss
                .filter((gloss) => gloss.lang === "eng")
                .map((gloss) => gloss.text)
                .join("; "),
            )
            .filter(Boolean),
          names: [],
        };
      });
    } catch (error) {
      // 下载失败允许下一次调用重试；内存中已成功的索引继续复用。
      if (this.index === index) this.index = null;
      throw error;
    }
  }

  private async load_index(signal: AbortSignal): Promise<Map<string, JmdictWord[]>> {
    const directory = this.options.paths.get_user_data_path(...JMDICT_DIRECTORY);
    const file_path = path.join(directory, JMDICT_CACHE_FILE_NAME);
    const hash = this.options.sha256 ?? sha256_bytes;
    let bytes: Uint8Array;
    let index: Map<string, JmdictWord[]>;
    try {
      bytes = this.native_fs.read_file(file_path);
      if (hash(bytes) !== JMDICT_PACKAGE_SHA256) throw new Error("JMdict checksum mismatch.");
      index = await parse_jmdict_package(bytes);
    } catch {
      signal.throwIfAborted();
      const response = await this.fetch(JMDICT_ZIP_URL, {
        headers: { "User-Agent": this.options.userAgent, Accept: "application/zip" },
        signal,
      });
      if (!response.ok) throw new Error(`JMdict download failed with HTTP ${response.status}.`);
      bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > JMDICT_MAX_DOWNLOAD_BYTES)
        throw new Error("JMdict package is too large.");
      if (hash(bytes) !== JMDICT_PACKAGE_SHA256) throw new Error("JMdict checksum mismatch.");
      // 完整结构校验先于原子落盘，坏包不会替换已有可用词库。
      index = await parse_jmdict_package(bytes);
      this.native_fs.write_file_atomic(file_path, bytes);
    }
    try {
      this.native_fs.write_file_atomic(path.join(directory, "LICENSE"), JMDICT_DEFAULT_LICENSE);
    } catch {
      // 词库已可用，附加说明写入失败不影响查询。
    }
    signal.throwIfAborted();
    return index;
  }
}

/** 解压并校验常用词包，格式、版本和条目数量共同限定可接受输入。 */
async function parse_jmdict_package(bytes: Uint8Array): Promise<Map<string, JmdictWord[]>> {
  const zip = await JSZip.loadAsync(bytes);
  const member = Object.values(zip.files).find(
    (entry) => !entry.dir && entry.name.toLowerCase().endsWith(".json"),
  );
  if (member === undefined) throw new Error("JMdict package has no JSON member.");
  const text = await member.async("string");
  if (text.length > JMDICT_MAX_EXTRACTED_CHARS) throw new Error("JMdict package is too large.");
  return build_jmdict_index(JSON.parse(text) as unknown);
}

/** 只索引规范化写法，内存大小受常用词包条数与输入体积共同约束。 */
export function build_jmdict_index(value: unknown): Map<string, JmdictWord[]> {
  if (
    !is_json_record(value) ||
    value["version"] !== JMDICT_RELEASE_VERSION ||
    !Array.isArray(value["words"])
  ) {
    throw new Error("Invalid JMdict common package structure.");
  }
  if (value["words"].length > JMDICT_MAX_ENTRY_COUNT)
    throw new Error("JMdict package has too many entries.");
  const index = new Map<string, JmdictWord[]>();
  for (const candidate of value["words"]) {
    if (!is_jmdict_word(candidate)) throw new Error("Invalid JMdict word entry.");
    const forms = [...candidate.kanji, ...candidate.kana].map(({ text }) =>
      normalize_term_lookup_query(text),
    );
    for (const text of forms) {
      const entries = index.get(text);
      if (entries === undefined) index.set(text, [candidate]);
      else entries.push(candidate);
    }
  }
  return index;
}

function is_jmdict_word(value: unknown): value is JmdictWord {
  if (
    !is_json_record(value) ||
    typeof value["id"] !== "string" ||
    !Array.isArray(value["kanji"]) ||
    !Array.isArray(value["kana"]) ||
    !Array.isArray(value["sense"])
  )
    return false;
  const forms = (form: unknown): boolean =>
    is_json_record(form) && typeof form["text"] === "string";
  const senses = (sense: unknown): boolean =>
    is_json_record(sense) &&
    Array.isArray(sense["gloss"]) &&
    sense["gloss"].every(
      (gloss) =>
        is_json_record(gloss) &&
        typeof gloss["lang"] === "string" &&
        typeof gloss["text"] === "string",
    );
  return (
    value["kanji"].every(forms) &&
    value["kana"].every(forms) &&
    value["kana"].length + value["kanji"].length > 0 &&
    value["sense"].every(senses)
  );
}

/** 发布包数据完整性由哈希端口验证；默认实现不依赖额外包。 */
export function sha256_bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
