import { createHash } from "node:crypto";

import type { JsonValue } from "../../domain/json";
import type { ItemNameField, ItemStatus } from "../../domain/item";
import { split_text_lines_for_items } from "../file/shared/file-format-helpers";
import { AppError } from "../../shared/error/app-error";

/** 站点允许的域名；远端抓取和重定向都只能落在这些主机上。 */
export const NOVELIA_HOSTS = ["n.novelia.cc", "books.fishhawk.top", "books1.fishhawk.top"] as const;

/** 单本下载大小上限，避免异常响应耗尽内存。 */
export const REMOTE_NOVEL_MAX_BYTES = 64 * 1024 * 1024;

const NOVEL_PATH_PATTERN = /^\/novel\/([^/]+)\/([^/]+)(?:\/.*)?$/u;
const WENKU_PATH_PATTERN = /^\/wenku\/([^/]+)(?:\/.*)?$/u;
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);
const CHAPTER_HEADING_PATTERN = /^#\s+(.*)$/u;
const MAX_FILENAME_BASE_LENGTH = 120;
const DEFAULT_KEEP_THRESHOLD = 0.6;
const DEFAULT_ALIGN_WINDOW = 50;
// 人工排除与预过滤跳过的行不因站点有译文而恢复翻译。
const REMOTE_TRANSLATION_BLOCKED_STATUSES: ReadonlySet<ItemStatus> = new Set([
  "EXCLUDED",
  "RULE_SKIPPED",
  "LANGUAGE_SKIPPED",
  "DUPLICATED",
]);
// 站点导出对缺失译文写固定标记；带标记的内容不能当作译文写入工程。
const REMOTE_MISSING_TRANSLATION_MARKERS = ["gpt翻译缺失。", "该章节缺失。"] as const;

export type RemoteNovelKind = "web" | "wenku";

/** 解析后的作品身份；origin 同时决定请求域名与凭据归属。 */
export interface RemoteNovelRef {
  origin: string;
  host: string;
  kind: RemoteNovelKind;
  provider_id: string; // 文库作品为空
  novel_id: string;
  url: string;
}

/** 站点下载的整本文本按行切分；行号与 TXT 解析器的 row 语义一致。 */
export interface RemoteLine {
  row: number;
  text: string;
  src_hash: string;
}

export interface RemoteChapter {
  index: number;
  kind: "preamble" | "chapter";
  title: string;
  heading_row: number | null;
  start_row: number;
  end_row: number; // 不含
}

export interface RemoteDocument {
  text: string;
  lines: RemoteLine[];
  chapters: RemoteChapter[];
}

/** 对齐时可复用的工程条目；只携带同步需要保留的业务字段。 */
export interface RemoteOldItem {
  item_id: number;
  row: number;
  src: string;
  dst: string;
  name_dst: ItemNameField;
  status: ItemStatus;
  extra_field: JsonValue;
}

export type RemoteRowDecision = "preserve" | "keep" | "retranslate";

export interface RemoteRowPlan {
  row: number;
  src: string;
  src_hash: string;
  chapter_index: number;
  decision: RemoteRowDecision;
  old_item: RemoteOldItem | null;
  remote_dst: string | null; // 站点已有 GPT 译文；工程可复用译文优先
  similarity: number;
  review: boolean; // 沿用旧译文但源文已变化，界面提示复核
}

export interface RemoteRemovedLine {
  row: number;
  src: string;
  dst: string;
}

export interface RemoteChapterPlan {
  index: number; // 新文档章节索引；删除章节沿用旧索引
  kind: "preamble" | "chapter";
  title: string;
  status: "unchanged" | "modified" | "added" | "removed" | "ambiguous";
  old_index: number | null;
  start_row: number;
  end_row: number;
  added: number;
  modified: number;
  removed: number;
  inherited: number;
  would_lose: number;
  removed_lines: RemoteRemovedLine[];
}

export interface RemoteAlignmentStats {
  added: number;
  modified: number;
  removed: number;
  inherited: number;
  remote_inherited: number; // 工程没有可复用译文、将沿用站点译文的行数
  would_lose: number;
  diverged: boolean; // 工程源文与上次远端快照不一致
  requires_alignment: boolean;
}

export interface RemoteAlignmentPlan {
  previous: RemoteDocument;
  next: RemoteDocument;
  rows: RemoteRowPlan[];
  chapters: RemoteChapterPlan[];
  stats: RemoteAlignmentStats;
}

/** 规范化站点 origin；桥接、凭据键和请求目标共用同一白名单。 */
export function normalize_novel_origin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!(NOVELIA_HOSTS as readonly string[]).includes(host)) return null;
  return `${url.protocol}//${host}${url.port === "" ? "" : `:${url.port}`}`;
}

/** 路径段解码失败与空段都按非法地址处理，避免把 URIError 泄漏给上层。 */
function decode_path_segment(segment: string): string {
  try {
    return decodeURIComponent(segment).trim();
  } catch {
    throw new Error("invalid novel url");
  }
}

/**
 * 站点 URL 只接受网页小说与文库两种作品页，并归一为不带查询串的规范地址。
 */
export function parse_novel_url(raw: string): RemoteNovelRef {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("invalid novel url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("invalid novel url");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!(NOVELIA_HOSTS as readonly string[]).includes(host)) {
    throw new Error("unsupported novel host");
  }
  // 用规范化 origin 去掉尾点与用户信息，并保留显式端口。
  const origin = normalize_novel_origin(url.href);
  if (origin === null) throw new Error("invalid novel url");
  const web = NOVEL_PATH_PATTERN.exec(url.pathname);
  if (web !== null) {
    const provider_id = decode_path_segment(web[1] ?? "");
    const novel_id = decode_path_segment(web[2] ?? "");
    if (provider_id === "" || novel_id === "") throw new Error("invalid novel url");
    return {
      origin,
      host,
      kind: "web",
      provider_id,
      novel_id,
      url: `${origin}/novel/${encodeURIComponent(provider_id)}/${encodeURIComponent(novel_id)}`,
    };
  }
  const wenku = WENKU_PATH_PATTERN.exec(url.pathname);
  if (wenku !== null) {
    const novel_id = decode_path_segment(wenku[1] ?? "");
    if (novel_id === "") throw new Error("invalid novel url");
    return {
      origin,
      host,
      kind: "wenku",
      provider_id: "",
      novel_id,
      url: `${origin}/wenku/${encodeURIComponent(novel_id)}`,
    };
  }
  throw new Error("invalid novel url");
}

/** 业务入口的 URL 解析都走这里；原始解析错误归一为 `remote.invalid_url`。 */
export function parse_novel_ref(url: string): RemoteNovelRef {
  try {
    return parse_novel_url(url);
  } catch (error) {
    throw new AppError("remote.invalid_url", {
      cause: error,
      diagnostic_context: { reason: "novel_url_rejected" },
    });
  }
}

/**
 * 工程资产名来自远端标题；保留可读性，同时消除路径分隔符、控制字符与 Windows 保留名。
 */
export function build_novel_filename(title: string): string {
  const cleaned = title
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/gu, "");
  const base = Array.from(cleaned === "" ? "novel" : cleaned)
    .slice(0, MAX_FILENAME_BASE_LENGTH)
    .join("")
    .replace(/[.\s]+$/gu, "");
  const safe_base = WINDOWS_RESERVED_NAMES.has(base.toLowerCase()) ? `_${base}` : base;
  return `${safe_base === "" ? "novel" : safe_base}.txt`;
}

/** 章节文件名同时携带作品与章节；清理规则与长度预算和整本文件名一致。 */
export function build_chapter_filename(novel_title: string, chapter_title: string): string {
  return build_novel_filename(`${novel_title} - ${chapter_title}`);
}

/** 章节标题与正文都从同一份文本切出，空行保持为可对齐条目。 */
export function split_remote_document(text: string): RemoteDocument {
  const raw_lines = split_text_lines_for_items(text);
  const lines: RemoteLine[] = raw_lines.map((line, row) => ({
    row,
    text: line,
    src_hash: sha256_text(line),
  }));
  const heading_rows: number[] = [];
  for (let index = 0; index < raw_lines.length; index += 1) {
    if (CHAPTER_HEADING_PATTERN.test(raw_lines[index] ?? "")) heading_rows.push(index);
  }
  const chapters: RemoteChapter[] = [];
  const first_heading = heading_rows[0];
  if (first_heading === undefined) {
    if (lines.length > 0) {
      chapters.push({
        index: 0,
        kind: "preamble",
        title: "",
        heading_row: null,
        start_row: 0,
        end_row: lines.length,
      });
    }
    return { text, lines, chapters };
  }
  if (first_heading > 0) {
    chapters.push({
      index: 0,
      kind: "preamble",
      title: "",
      heading_row: null,
      start_row: 0,
      end_row: first_heading,
    });
  }
  for (let offset = 0; offset < heading_rows.length; offset += 1) {
    const start_row = heading_rows[offset] ?? 0;
    const end_row = heading_rows[offset + 1] ?? raw_lines.length;
    const matched = CHAPTER_HEADING_PATTERN.exec(raw_lines[start_row] ?? "");
    chapters.push({
      index: chapters.length,
      kind: "chapter",
      title: (matched?.[1] ?? "").trim(),
      heading_row: start_row,
      start_row,
      end_row,
    });
  }
  return { text, lines, chapters };
}

/**
 * 从站点双语整本导出中还原每行译文；键为原文行号。
 * 导出按“日文行、中文行”交替排列，空段只占一行；任一行对不上就整章放弃，
 * 避免站点格式变化时把译文写到错误的行。
 */
export function read_remote_translations(
  source_text: string,
  translated_text: string,
): Map<number, string> {
  const translations = new Map<number, string>();
  if (translated_text === "") return translations;
  const source = split_remote_document(source_text);
  const translated_lines = split_text_lines_for_items(translated_text);
  let cursor = 0;
  for (const chapter of source.chapters) {
    if (chapter.kind !== "chapter" || chapter.heading_row === null) continue;
    const heading = source.lines[chapter.heading_row]?.text ?? "";
    const heading_index = find_translated_line(translated_lines, cursor, heading);
    if (heading_index < 0) continue;
    const heading_translation = read_translated_heading(translated_lines, heading_index);
    if (heading_translation === null || is_missing_remote_translation(heading_translation)) {
      cursor = heading_index + 1;
      continue;
    }
    const chapter_translations = new Map<number, string>();
    let source_row = chapter.heading_row + 1;
    let translated_row = heading_index + 2; // 跳过日文标题与紧随的中文标题
    let valid = true;
    while (source_row < chapter.end_row) {
      const source_line = source.lines[source_row]?.text ?? "";
      if (source_line.trim() === "") {
        if ((translated_lines[translated_row] ?? "").trim() !== "") {
          valid = false;
          break;
        }
        source_row += 1;
        translated_row += 1;
        continue;
      }
      const translated_source = translated_lines[translated_row];
      const translated_dst = translated_lines[translated_row + 1];
      if (
        translated_source !== source_line ||
        translated_dst === undefined ||
        is_missing_remote_translation(translated_dst)
      ) {
        valid = false;
        break;
      }
      if (translated_dst.trim() !== "") chapter_translations.set(source_row, translated_dst);
      source_row += 1;
      translated_row += 2;
    }
    if (valid) {
      if (heading_translation !== heading) {
        translations.set(chapter.heading_row, heading_translation);
      }
      for (const [row, dst] of chapter_translations) translations.set(row, dst);
    }
    cursor = heading_index + 1;
  }
  return translations;
}

function find_translated_line(lines: readonly string[], from: number, target: string): number {
  for (let index = from; index < lines.length; index += 1) {
    if (lines[index] === target) return index;
  }
  return -1;
}

function read_translated_heading(lines: readonly string[], heading_index: number): string | null {
  const next = lines[heading_index + 1];
  if (next === undefined || !CHAPTER_HEADING_PATTERN.test(next)) return null;
  return next;
}

/** 站点对缺失译文写出固定标记；带标记的内容不能当作译文使用。 */
export function is_missing_remote_translation(text: string): boolean {
  return REMOTE_MISSING_TRANSLATION_MARKERS.some((marker) => text.includes(marker));
}

/** 对齐只消除排版差异，不改写新原文本身。 */
export function normalize_match_line(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

/** 两个值得相似度；短文本按相等判断，避免 bigram 对单字失效。 */
export function line_similarity(left: string, right: string): number {
  const a = normalize_match_line(left);
  const b = normalize_match_line(right);
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const left_counts = new Map<string, number>();
  for (let index = 0; index < a.length - 1; index += 1) {
    const gram = a.slice(index, index + 2);
    left_counts.set(gram, (left_counts.get(gram) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const gram = b.slice(index, index + 2);
    const count = left_counts.get(gram) ?? 0;
    if (count > 0) {
      overlap += 1;
      left_counts.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

export function sha256_text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 以上次同步快照为基准对齐新旧文本；工程条目只提供译文与身份，不参与结构判断。
 */
export function align_remote_documents(args: {
  previous_text: string;
  next_text: string;
  old_items: readonly RemoteOldItem[];
  next_translations?: ReadonlyMap<number, string> | undefined;
  keep_threshold?: number;
  window?: number;
}): RemoteAlignmentPlan {
  const previous = split_remote_document(args.previous_text);
  const next = split_remote_document(args.next_text);
  const old_index = build_old_item_index(previous, args.old_items);
  const chapter_pairs = pair_chapters(previous, next);
  const next_translations = args.next_translations ?? new Map<number, string>();
  const plans_by_new_chapter = new Map<number, RemoteChapterPlan>();
  const rows: RemoteRowPlan[] = [];
  const removed_chapters: RemoteChapterPlan[] = [];
  const keep_threshold = args.keep_threshold ?? DEFAULT_KEEP_THRESHOLD;
  const window = args.window ?? DEFAULT_ALIGN_WINDOW;
  const used_item_ids = new Set<number>();

  for (const chapter of next.chapters) {
    const pair = chapter_pairs.by_new_index.get(chapter.index);
    if (pair === undefined) {
      const added = build_added_chapter_plan(chapter, next, next_translations);
      plans_by_new_chapter.set(chapter.index, added.chapter);
      rows.push(...added.rows);
      continue;
    }
    const old_chapter = previous.chapters[pair.old_index];
    if (old_chapter === undefined) continue;
    const chapter_plan = pair_lines({
      previous,
      next,
      old_chapter,
      new_chapter: chapter,
      old_index,
      used_item_ids,
      next_translations,
      keep_threshold,
      window,
      ambiguous: pair.ambiguous,
    });
    plans_by_new_chapter.set(chapter.index, chapter_plan.chapter);
    rows.push(...chapter_plan.rows);
  }
  for (const [old_index_value, chapter] of previous.chapters.entries()) {
    if (chapter_pairs.matched_old.has(old_index_value)) continue;
    removed_chapters.push(build_removed_chapter_plan(chapter, old_index, used_item_ids));
  }
  rows.sort((left, right) => left.row - right.row);
  const chapters = next.chapters
    .map((chapter) => plans_by_new_chapter.get(chapter.index))
    .filter((chapter): chapter is RemoteChapterPlan => chapter !== undefined)
    .concat(removed_chapters);
  const stats = summarize_plan(next, chapters, old_index.diverged, rows);
  return { previous, next, rows, chapters, stats };
}

/**
 * 仅追加模式把新增章节放到文件末尾；已有内容与已删除章节保持不动，保证零丢失。
 * 同时把站点译文行号重映射到追加后的文本，供重新对齐时继续沿用。
 */
export function build_add_only_plan(
  current_text: string,
  plan: RemoteAlignmentPlan,
): {
  text: string;
  appended: string[];
  skipped: string[];
  translations: Map<number, string>;
} {
  const appended_chapters = plan.chapters
    .filter((chapter) => chapter.status === "added" && chapter.kind === "chapter")
    .map((chapter) => ({
      chapter,
      text: plan.next.lines
        .slice(chapter.start_row, chapter.end_row)
        .map((line) => line.text)
        .join("\n"),
    }))
    .filter((entry) => entry.text.trim() !== "");
  const appended = appended_chapters.map((entry) => entry.text);
  const skipped = plan.chapters
    .filter(
      (chapter) =>
        chapter.kind === "chapter" &&
        (chapter.status === "modified" || chapter.status === "ambiguous"),
    )
    .map((chapter) => chapter.title);
  const base = current_text.replace(/\s+$/u, "");
  const translations = new Map<number, string>();
  if (appended.length === 0) return { text: current_text, appended: [], skipped, translations };
  const body = appended.join("\n\n");
  const text = base === "" ? body : `${base}\n\n${body}\n`;
  const base_lines = base === "" ? 0 : split_text_lines_for_items(base).length;
  let target_start = base === "" ? 0 : base_lines + 1;
  for (const entry of appended_chapters) {
    const { chapter } = entry;
    const line_count = chapter.end_row - chapter.start_row;
    for (const row of plan.rows) {
      if (row.remote_dst === null) continue;
      if (row.row < chapter.start_row || row.row >= chapter.end_row) continue;
      translations.set(target_start + (row.row - chapter.start_row), row.remote_dst);
    }
    target_start += line_count + 1; // 章之间以一个空行分隔
  }
  return { text, appended, skipped, translations };
}

/** 工程条目按 row 建索引；源文不一致时保留按原文回退的队列。 */
function build_old_item_index(
  previous: RemoteDocument,
  old_items: readonly RemoteOldItem[],
): {
  by_row: Map<number, RemoteOldItem>;
  by_src: Map<string, RemoteOldItem[]>;
  diverged: boolean;
} {
  const by_row = new Map<number, RemoteOldItem>();
  const by_src = new Map<string, RemoteOldItem[]>();
  let diverged = false;
  for (const item of old_items) {
    const line = previous.lines[item.row];
    if (line === undefined || line.text !== item.src) diverged = true;
    by_row.set(item.row, item);
    const queue = by_src.get(item.src) ?? [];
    queue.push(item);
    by_src.set(item.src, queue);
  }
  if (old_items.length !== previous.lines.length) diverged = true;
  return { by_row, by_src, diverged };
}

interface ChapterPair {
  old_index: number;
  new_index: number;
  ambiguous: boolean;
}

/** 标题唯一且顺序一致的章节先做锚点，其余区段按位置配对。 */
function pair_chapters(
  previous: RemoteDocument,
  next: RemoteDocument,
): {
  by_new_index: Map<number, ChapterPair>;
  matched_old: Set<number>;
} {
  const old_titles = previous.chapters.map((chapter) => normalize_match_line(chapter.title));
  const new_titles = next.chapters.map((chapter) => normalize_match_line(chapter.title));
  const old_unique = unique_title_indexes(old_titles);
  const new_unique = unique_title_indexes(new_titles);
  const anchors: Array<{ old_index: number; new_index: number }> = [];
  const old_anchor_sequence = [...old_unique.entries()]
    .filter(([title]) => title !== "" && new_unique.has(title))
    .map(([title, old_index_value]) => ({ title, old_index: old_index_value }))
    .sort((left, right) => left.old_index - right.old_index);
  const new_anchor_sequence = [...new_unique.entries()]
    .filter(([title]) => title !== "" && old_unique.has(title))
    .map(([title, new_index_value]) => ({ title, new_index: new_index_value }))
    .sort((left, right) => left.new_index - right.new_index);
  const lcs = longest_common_subsequence(
    old_anchor_sequence.map((entry) => entry.title),
    new_anchor_sequence.map((entry) => entry.title),
  );
  for (const [left, right] of lcs) {
    const old_entry = old_anchor_sequence[left];
    const new_entry = new_anchor_sequence[right];
    if (old_entry === undefined || new_entry === undefined) continue;
    const last = anchors.at(-1);
    if (
      last !== undefined &&
      (old_entry.old_index <= last.old_index || new_entry.new_index <= last.new_index)
    ) {
      continue;
    }
    anchors.push({ old_index: old_entry.old_index, new_index: new_entry.new_index });
  }
  anchors.sort((left, right) => left.old_index - right.old_index);
  const by_new_index = new Map<number, ChapterPair>();
  const matched_old = new Set<number>();
  // 前言只与前言配对；单边存在时留作新增/删除，避免和正文章节错位。
  let old_cursor = previous.chapters[0]?.kind === "preamble" ? 1 : 0;
  let new_cursor = next.chapters[0]?.kind === "preamble" ? 1 : 0;
  if (old_cursor === 1 && new_cursor === 1) {
    by_new_index.set(0, { old_index: 0, new_index: 0, ambiguous: false });
    matched_old.add(0);
  }
  const fill_gap = (old_end: number, new_end: number): void => {
    const old_gap = Math.max(0, old_end - old_cursor);
    const new_gap = Math.max(0, new_end - new_cursor);
    const paired = Math.min(old_gap, new_gap);
    const ambiguous = old_gap !== new_gap && old_gap > 0 && new_gap > 0;
    for (let offset = 0; offset < paired; offset += 1) {
      const old_index_value = old_cursor + offset;
      const new_index_value = new_cursor + offset;
      by_new_index.set(new_index_value, {
        old_index: old_index_value,
        new_index: new_index_value,
        ambiguous,
      });
      matched_old.add(old_index_value);
    }
    old_cursor += paired;
    new_cursor += paired;
  };
  for (const anchor of anchors) {
    fill_gap(anchor.old_index, anchor.new_index);
    // 锚点本身必须成对，跳过区段里按位置配对后剩余的前缀。
    if (old_cursor < anchor.old_index) old_cursor = anchor.old_index;
    if (new_cursor < anchor.new_index) new_cursor = anchor.new_index;
    by_new_index.set(anchor.new_index, {
      old_index: anchor.old_index,
      new_index: anchor.new_index,
      ambiguous: false,
    });
    matched_old.add(anchor.old_index);
    old_cursor = Math.max(old_cursor, anchor.old_index + 1);
    new_cursor = Math.max(new_cursor, anchor.new_index + 1);
  }
  fill_gap(previous.chapters.length, next.chapters.length);
  return { by_new_index, matched_old };
}

/** 只返回在各自文档中出现一次的标题，重复标题交给位置配对。 */
function unique_title_indexes(titles: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of titles) {
    if (title === "") continue;
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  const result = new Map<string, number>();
  for (const [index, title] of titles.entries()) {
    if (title !== "" && counts.get(title) === 1) result.set(title, index);
  }
  return result;
}

function longest_common_subsequence(
  left: readonly string[],
  right: readonly string[],
): Array<[number, number]> {
  if (left.length === 0 || right.length === 0) return [];
  const rows = left.length + 1;
  const columns = right.length + 1;
  if (rows * columns > 4_000_000) {
    // 超大目录退化为顺序扫描，仍能保留同名锚点。
    const indexes = new Map<string, number>();
    for (const [index, value] of right.entries()) indexes.set(value, index);
    const pairs: Array<[number, number]> = [];
    let last = -1;
    for (const [index, value] of left.entries()) {
      const match = indexes.get(value);
      if (match !== undefined && match > last) {
        pairs.push([index, match]);
        last = match;
      }
    }
    return pairs;
  }
  const table = new Uint32Array(rows * columns);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] =
        left[i] === right[j]
          ? table[(i + 1) * columns + j + 1]! + 1
          : Math.max(table[(i + 1) * columns + j]!, table[i * columns + j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * columns + j]! >= table[i * columns + j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** 章内按内容重同步，无法匹配的区段按位置成对并做相似度判断。 */
function pair_lines(args: {
  previous: RemoteDocument;
  next: RemoteDocument;
  old_chapter: RemoteChapter;
  new_chapter: RemoteChapter;
  old_index: ReturnType<typeof build_old_item_index>;
  used_item_ids: Set<number>;
  next_translations: ReadonlyMap<number, string>;
  keep_threshold: number;
  window: number;
  ambiguous: boolean;
}): { chapter: RemoteChapterPlan; rows: RemoteRowPlan[] } {
  const old_lines = args.previous.lines.slice(args.old_chapter.start_row, args.old_chapter.end_row);
  const new_lines = args.next.lines.slice(args.new_chapter.start_row, args.new_chapter.end_row);
  const rows: RemoteRowPlan[] = [];
  const removed_lines: RemoteRemovedLine[] = [];
  const pairs = greedy_line_pairs(
    old_lines.map((line) => line.text),
    new_lines.map((line) => line.text),
    args.window,
  );
  let added = 0;
  let modified = 0;
  let removed = 0;
  let inherited = 0;
  let would_lose = 0;
  for (const pair of pairs) {
    if (pair.old_index === null) {
      added += 1;
      const new_line = pair.new_index === null ? undefined : new_lines[pair.new_index];
      if (new_line !== undefined) {
        rows.push({
          row: new_line.row,
          src: new_line.text,
          src_hash: new_line.src_hash,
          chapter_index: args.new_chapter.index,
          decision: "retranslate",
          old_item: null,
          remote_dst: args.next_translations.get(new_line.row) ?? null,
          similarity: 0,
          review: false,
        });
      }
      continue;
    }
    if (pair.new_index === null) {
      removed += 1;
      const old_line = old_lines[pair.old_index];
      const old_item = resolve_old_item(
        args.old_index,
        args.used_item_ids,
        old_line?.row ?? -1,
        old_line?.text ?? "",
      );
      if (old_item !== null && old_item.dst !== "") {
        would_lose += 1;
        removed_lines.push({
          row: old_line?.row ?? -1,
          src: old_line?.text ?? "",
          dst: old_item.dst,
        });
      }
      continue;
    }
    const new_line = new_lines[pair.new_index];
    const old_line = old_lines[pair.old_index];
    if (new_line === undefined || old_line === undefined) continue;
    const old_item = resolve_old_item(
      args.old_index,
      args.used_item_ids,
      old_line.row,
      old_line.text,
    );
    const exact = new_line.text === old_line.text;
    const normalized = normalize_match_line(new_line.text) === normalize_match_line(old_line.text);
    const similarity = exact ? 1 : line_similarity(new_line.text, old_line.text);
    let decision: RemoteRowDecision = "retranslate";
    let review = false;
    if (old_item !== null) {
      if (exact || normalized) {
        decision = "preserve";
      } else if (old_item.status === "EXCLUDED") {
        decision = "keep";
        review = true;
      } else if (old_item.dst !== "" && similarity >= args.keep_threshold) {
        decision = "keep";
        review = true;
      }
    }
    if (!exact && !normalized) modified += 1;
    if (decision !== "retranslate" && old_item !== null && old_item.dst !== "") inherited += 1;
    if (decision === "retranslate" && old_item !== null && old_item.dst !== "") would_lose += 1;
    rows.push({
      row: new_line.row,
      src: new_line.text,
      src_hash: new_line.src_hash,
      chapter_index: args.new_chapter.index,
      decision,
      old_item,
      remote_dst: args.next_translations.get(new_line.row) ?? null,
      similarity,
      review,
    });
  }
  const chapter: RemoteChapterPlan = {
    index: args.new_chapter.index,
    kind: args.new_chapter.kind,
    title: args.new_chapter.title,
    status: args.ambiguous
      ? "ambiguous"
      : added > 0 || modified > 0 || removed > 0
        ? "modified"
        : "unchanged",
    old_index: args.old_chapter.index,
    start_row: args.new_chapter.start_row,
    end_row: args.new_chapter.end_row,
    added,
    modified,
    removed,
    inherited,
    would_lose,
    removed_lines,
  };
  return { chapter, rows };
}

/**
 * 先找窗口内的精确锚点，再把锚点之间的未匹配行按位置成对。
 * 位置配对让“改写一行”成为一次相似度判断，而不是删除加新增。
 */
function greedy_line_pairs(
  old_lines: readonly string[],
  new_lines: readonly string[],
  window: number,
): Array<{ old_index: number | null; new_index: number | null }> {
  const pairs: Array<{ old_index: number | null; new_index: number | null }> = [];
  const normalized_old = old_lines.map(normalize_match_line);
  const normalized_new = new_lines.map(normalize_match_line);
  let old_cursor = 0;
  let new_cursor = 0;
  let pending_old: number[] = [];
  let pending_new: number[] = [];
  const flush_pending = (): void => {
    const paired = Math.min(pending_old.length, pending_new.length);
    for (let offset = 0; offset < paired; offset += 1) {
      pairs.push({
        old_index: pending_old[offset] ?? null,
        new_index: pending_new[offset] ?? null,
      });
    }
    for (let offset = paired; offset < pending_old.length; offset += 1) {
      pairs.push({ old_index: pending_old[offset] ?? null, new_index: null });
    }
    for (let offset = paired; offset < pending_new.length; offset += 1) {
      pairs.push({ old_index: null, new_index: pending_new[offset] ?? null });
    }
    pending_old = [];
    pending_new = [];
  };
  while (old_cursor < old_lines.length && new_cursor < new_lines.length) {
    if (normalized_old[old_cursor] === normalized_new[new_cursor]) {
      flush_pending();
      pairs.push({ old_index: old_cursor, new_index: new_cursor });
      old_cursor += 1;
      new_cursor += 1;
      continue;
    }
    let best: { old_skip: number; new_skip: number; cost: number } | null = null;
    const old_limit = Math.min(window, old_lines.length - old_cursor);
    const new_limit = Math.min(window, new_lines.length - new_cursor);
    for (let old_skip = 1; old_skip <= old_limit; old_skip += 1) {
      const target = normalized_old[old_cursor + old_skip];
      for (let new_skip = 0; new_skip <= new_limit; new_skip += 1) {
        if (normalized_new[new_cursor + new_skip] !== target) continue;
        const cost = old_skip + new_skip;
        if (best === null || cost < best.cost) best = { old_skip, new_skip, cost };
        break;
      }
    }
    for (let new_skip = 1; new_skip <= new_limit; new_skip += 1) {
      const target = normalized_new[new_cursor + new_skip];
      for (let old_skip = 0; old_skip <= old_limit; old_skip += 1) {
        if (normalized_old[old_cursor + old_skip] !== target) continue;
        const cost = old_skip + new_skip;
        if (best === null || cost < best.cost) best = { old_skip, new_skip, cost };
        break;
      }
    }
    if (best === null) {
      // 窗口内没有可锚定的行：当前两行留到下一个锚点做位置配对。
      pending_old.push(old_cursor);
      pending_new.push(new_cursor);
      old_cursor += 1;
      new_cursor += 1;
      continue;
    }
    for (let offset = 0; offset < best.old_skip; offset += 1) {
      pending_old.push(old_cursor + offset);
    }
    for (let offset = 0; offset < best.new_skip; offset += 1) {
      pending_new.push(new_cursor + offset);
    }
    old_cursor += best.old_skip;
    new_cursor += best.new_skip;
  }
  while (old_cursor < old_lines.length) {
    pending_old.push(old_cursor);
    old_cursor += 1;
  }
  while (new_cursor < new_lines.length) {
    pending_new.push(new_cursor);
    new_cursor += 1;
  }
  flush_pending();
  return pairs;
}

/** 优先用同一 row 的条目；源文不一致时按原文队列回退，已消费条目不再复用。 */
function resolve_old_item(
  index: ReturnType<typeof build_old_item_index>,
  used_item_ids: Set<number>,
  row: number,
  src: string,
): RemoteOldItem | null {
  const candidate = index.by_row.get(row);
  if (candidate !== undefined && candidate.src === src && !used_item_ids.has(candidate.item_id)) {
    used_item_ids.add(candidate.item_id);
    return candidate;
  }
  const queue = index.by_src.get(src);
  while (queue !== undefined && queue.length > 0) {
    const item = queue.shift();
    if (item === undefined || used_item_ids.has(item.item_id)) continue;
    used_item_ids.add(item.item_id);
    return item;
  }
  if (candidate !== undefined && !used_item_ids.has(candidate.item_id)) {
    used_item_ids.add(candidate.item_id);
    return candidate;
  }
  return null;
}

function build_added_chapter_plan(
  chapter: RemoteChapter,
  next: RemoteDocument,
  next_translations: ReadonlyMap<number, string>,
): {
  chapter: RemoteChapterPlan;
  rows: RemoteRowPlan[];
} {
  const rows: RemoteRowPlan[] = [];
  for (let row = chapter.start_row; row < chapter.end_row; row += 1) {
    const line = next.lines[row];
    if (line === undefined) continue;
    rows.push({
      row: line.row,
      src: line.text,
      src_hash: line.src_hash,
      chapter_index: chapter.index,
      decision: "retranslate",
      old_item: null,
      remote_dst: next_translations.get(line.row) ?? null,
      similarity: 0,
      review: false,
    });
  }
  return {
    chapter: {
      index: chapter.index,
      kind: chapter.kind,
      title: chapter.title,
      status: "added",
      old_index: null,
      start_row: chapter.start_row,
      end_row: chapter.end_row,
      added: rows.length,
      modified: 0,
      removed: 0,
      inherited: 0,
      would_lose: 0,
      removed_lines: [],
    },
    rows,
  };
}

function build_removed_chapter_plan(
  chapter: RemoteChapter,
  index: ReturnType<typeof build_old_item_index>,
  used_item_ids: Set<number>,
): RemoteChapterPlan {
  const removed_lines: RemoteRemovedLine[] = [];
  let would_lose = 0;
  for (let row = chapter.start_row; row < chapter.end_row; row += 1) {
    const item = index.by_row.get(row);
    // 该条目已被新章节按内容匹配时不计入删除损失。
    if (item === undefined || used_item_ids.has(item.item_id)) continue;
    removed_lines.push({ row, src: item.src, dst: item.dst });
    if (item.dst !== "") would_lose += 1;
  }
  return {
    index: chapter.index,
    kind: chapter.kind,
    title: chapter.title,
    status: "removed",
    old_index: chapter.index,
    start_row: chapter.start_row,
    end_row: chapter.end_row,
    added: 0,
    modified: 0,
    removed: chapter.end_row - chapter.start_row,
    inherited: 0,
    would_lose,
    removed_lines,
  };
}

function summarize_plan(
  next: RemoteDocument,
  chapters: readonly RemoteChapterPlan[],
  diverged: boolean,
  rows: readonly RemoteRowPlan[],
): RemoteAlignmentStats {
  const stats: RemoteAlignmentStats = {
    added: 0,
    modified: 0,
    removed: 0,
    inherited: 0,
    remote_inherited: 0,
    would_lose: 0,
    diverged,
    requires_alignment: false,
  };
  // 章计划已经汇总行级结果；按章累加可避免新增章节被重复计数。
  for (const chapter of chapters) {
    stats.added += chapter.added;
    stats.modified += chapter.modified;
    stats.removed += chapter.removed;
    stats.inherited += chapter.inherited;
    stats.would_lose += chapter.would_lose;
  }
  for (const row of rows) {
    if (uses_remote_translation(row)) stats.remote_inherited += 1;
  }
  const total = Math.max(next.lines.length, 1);
  stats.requires_alignment = stats.would_lose > 20 && stats.would_lose / total > 0.05;
  return stats;
}

/** 站点译文只在工程没有可复用译文、且该行未被人工排除或过滤时生效。 */
function uses_remote_translation(row: RemoteRowPlan): boolean {
  if (row.remote_dst === null || row.remote_dst.trim() === "") return false;
  const previous = row.old_item;
  if (previous === null) return true;
  if (previous.dst !== "") return false;
  return !REMOTE_TRANSLATION_BLOCKED_STATUSES.has(previous.status);
}
