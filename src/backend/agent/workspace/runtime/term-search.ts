import { normalize_literal_text } from "../../../../shared/text/literal-matcher";

type TermSearchItem = {
  item_id: number;
  file_path: string;
  src: string;
  dst: string;
  name_src: string;
  name_dst: string;
  status: string;
};

type TermSearchGlossaryEntry = {
  id: string;
  src: string;
  dst: string;
  info: string;
  case_sensitive: boolean;
  evidence?: string;
};

type TermSearchField = "src" | "name_src";
type TermSearchMatch = "exact" | "word" | "substring";

type TermSearchOptions = {
  case_sensitive?: boolean;
  file_path?: string;
  include_unconfirmed?: boolean;
  limit?: number;
};

type TermSearchResult = {
  query: string;
  results: {
    field: TermSearchField;
    src: string;
    dst: string;
    occurrences: number;
    item_ids: number[];
    entry_id?: string;
    confirmed: boolean;
    match: TermSearchMatch;
    file_path?: string;
    status?: string;
    info?: string;
    case_sensitive?: boolean;
    evidence?: string;
  }[];
};

type PreparedQuery = {
  original: string;
  text: string;
  case_sensitive: boolean;
  word: boolean;
  word_pattern: RegExp | null;
};

type Candidate = {
  field: TermSearchField;
  src: string;
  dst: string;
  occurrences: number;
  item_ids: number[];
  entry_id: string | undefined;
  confirmed: boolean;
  match: TermSearchMatch;
  file_path: string | undefined;
  status: string | undefined;
  same_file: boolean;
  glossary: boolean;
  info: string | undefined;
  case_sensitive: boolean | undefined;
  evidence: string | undefined;
};

type GroupedCandidate = Candidate & { item_id_set: Set<number> };

const DEFAULT_LIMIT = 8;
const MAX_ITEM_IDS = 3;
const MAX_SNIPPET_LENGTH = 160;
const MATCH_STRENGTH: Record<TermSearchMatch, number> = { exact: 3, word: 2, substring: 1 };

/** 在条目和术语表中检索已有译法，按查询返回聚合结果；输入只消费一次，支持异步流。 */
export async function searchTerms(
  items: Iterable<TermSearchItem> | AsyncIterable<TermSearchItem>,
  glossary: Iterable<TermSearchGlossaryEntry> | AsyncIterable<TermSearchGlossaryEntry>,
  queries: readonly string[],
  options: TermSearchOptions = {},
): Promise<TermSearchResult[]> {
  const prepared_queries = prepare_queries(queries, options.case_sensitive ?? false);
  const include_unconfirmed = options.include_unconfirmed ?? true;
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (prepared_queries.length === 0 || limit <= 0) {
    return prepared_queries.map((query) => ({ query: query.original, results: [] }));
  }

  const groups_by_query = prepared_queries.map(() => new Map<string, GroupedCandidate>());
  for await (const item of items) {
    const fields = [
      { field: "src" as const, src: item.src, dst: item.dst },
      { field: "name_src" as const, src: item.name_src, dst: item.name_dst },
    ];
    for (const value of fields) {
      if (value.src === "") continue;
      prepared_queries.forEach((query, query_index) => {
        const match = match_query(query, value.src);
        if (match === null) return;
        add_candidate(groups_by_query[query_index]!, {
          field: value.field,
          src: value.src,
          dst: value.dst,
          item_id: item.item_id,
          entry_id: undefined,
          confirmed: item.status === "PROCESSED" && value.dst.trim() !== "",
          match,
          file_path: item.file_path,
          status: item.status,
          same_file: item.file_path === options.file_path,
          glossary: false,
          info: undefined,
          case_sensitive: undefined,
          evidence: undefined,
        });
      });
    }
  }

  for await (const entry of glossary) {
    if (entry.src === "") continue;
    const case_sensitive = entry.case_sensitive || (options.case_sensitive ?? false);
    prepared_queries.forEach((query, query_index) => {
      // 查询选项不能放宽术语表自身的敏感规则，也不能把不敏感查询收紧为敏感。
      if (query.case_sensitive !== case_sensitive) return;
      const match = match_query(query, entry.src);
      if (match === null) return;
      add_candidate(groups_by_query[query_index]!, {
        field: "src",
        src: entry.src,
        dst: entry.dst,
        item_id: undefined,
        entry_id: entry.id,
        confirmed: entry.dst.trim() !== "",
        match,
        file_path: undefined,
        status: undefined,
        same_file: false,
        glossary: true,
        info: entry.info,
        case_sensitive: entry.case_sensitive,
        evidence: entry.evidence,
      });
    });
  }

  return prepared_queries.map((query, index) => ({
    query: query.original,
    results: [...groups_by_query[index]!.values()]
      .filter((candidate) => include_unconfirmed || candidate.confirmed)
      .sort(
        (left, right) =>
          MATCH_STRENGTH[right.match] - MATCH_STRENGTH[left.match] ||
          Number(right.confirmed) - Number(left.confirmed) ||
          Number(right.same_file) - Number(left.same_file) ||
          Number(right.glossary) - Number(left.glossary) ||
          right.occurrences - left.occurrences,
      )
      .slice(0, limit)
      .map((candidate) => ({
        field: candidate.field,
        src: snippet(candidate.src),
        dst: snippet(candidate.dst),
        occurrences: candidate.occurrences,
        item_ids: candidate.item_ids,
        ...(candidate.entry_id === undefined ? {} : { entry_id: candidate.entry_id }),
        confirmed: candidate.confirmed,
        match: candidate.match,
        ...(candidate.file_path === undefined ? {} : { file_path: candidate.file_path }),
        ...(candidate.status === undefined ? {} : { status: candidate.status }),
        ...(candidate.info === undefined ? {} : { info: snippet(candidate.info) }),
        ...(candidate.case_sensitive === undefined
          ? {}
          : { case_sensitive: candidate.case_sensitive }),
        ...(candidate.evidence === undefined ? {} : { evidence: snippet(candidate.evidence) }),
      })),
  }));
}

/** 空查询忽略，重复查询在共享的大小写模式下只保留首次出现。 */
function prepare_queries(queries: readonly string[], case_sensitive: boolean): PreparedQuery[] {
  const seen = new Set<string>();
  const prepared: PreparedQuery[] = [];
  for (const original of queries) {
    const text = normalize_literal_text(original, case_sensitive);
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    const word = /[\p{Script=Latin}]/u.test(original);
    prepared.push({
      original,
      text,
      case_sensitive,
      word,
      // 仅 Latin query 有词边界；完整匹配范围不能与其它字符粘连。
      word_pattern: word
        ? new RegExp(`(?<![\\p{L}\\p{N}_])${escape_regexp(text)}(?![\\p{L}\\p{N}_])`, "u")
        : null,
    });
  }
  return prepared;
}

function match_query(query: PreparedQuery, source: string): TermSearchMatch | null {
  const normalized = normalize_literal_text(source, query.case_sensitive);
  const start = normalized.indexOf(query.text);
  if (start < 0) return null;
  if (start === 0 && normalized.length === query.text.length) return "exact";
  if (query.word_pattern?.test(normalized)) return "word";
  return "substring";
}

function escape_regexp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** 同字段、原文和译文共享证据；item_ids 保持去重后的首次出现顺序。 */
function add_candidate(
  groups: Map<string, GroupedCandidate>,
  input: Omit<Candidate, "occurrences" | "item_ids"> & { item_id: number | undefined },
): void {
  const key = JSON.stringify([input.field, input.src, input.dst]);
  const { item_id, ...values } = input;
  const existing = groups.get(key);
  if (existing === undefined) {
    groups.set(key, {
      ...values,
      occurrences: 1,
      item_ids: item_id === undefined ? [] : [item_id],
      item_id_set: new Set(item_id === undefined ? [] : [item_id]),
    });
    return;
  }
  existing.occurrences += 1;
  existing.confirmed ||= values.confirmed;
  existing.same_file ||= values.same_file;
  existing.glossary ||= values.glossary;
  existing.match =
    MATCH_STRENGTH[values.match] > MATCH_STRENGTH[existing.match] ? values.match : existing.match;
  existing.entry_id ??= values.entry_id;
  existing.file_path ??= values.file_path;
  existing.status ??= values.status;
  existing.info ??= values.info;
  existing.case_sensitive ??= values.case_sensitive;
  existing.evidence ??= values.evidence;
  if (item_id !== undefined && !existing.item_id_set.has(item_id)) {
    existing.item_id_set.add(item_id);
    if (existing.item_ids.length < MAX_ITEM_IDS) existing.item_ids.push(item_id);
  }
}

function snippet(value: string): string {
  return value.length <= MAX_SNIPPET_LENGTH ? value : `${value.slice(0, MAX_SNIPPET_LENGTH)}…`;
}
