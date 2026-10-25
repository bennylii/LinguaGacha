/**
 * 校对计划与进度只依赖纯数据，不读写工程，也不引入宿主能力。
 * 进度文件与审校记录由 `workspace_run` 读写，脚本只负责计算。
 */

/** 校对结论的完整取值。范围内每个条目都必须得到其中之一。 */
export const REVIEW_VERDICTS = ["keep", "change", "unresolved"];

/** 单元上限。条目数与序列化字节数共同约束，避免单次请求过大。 */
const DEFAULT_MAX_ITEMS = 50;
const DEFAULT_MAX_BYTES = 32 * 1024;

/** 上下文取同文件前后各三条非空原文。 */
const CONTEXT_NEIGHBORS = 3;

/** 单条条目的尝试上限。达到上限仍无结论的条目记为未决。 */
const MAX_ITEM_ATTEMPTS = 2;

/** 无需人工校对的状态。 */
const EXCLUDED_STATUSES = new Set(["EXCLUDED", "DUPLICATED", "RULE_SKIPPED", "LANGUAGE_SKIPPED"]);

/** 可读取的条目标量字段。 */
const REVIEW_FIELDS = ["src", "dst", "name_src", "name_dst"];

/**
 * 依据工程快照建立校对范围。
 * @param entries 条目数组。每项至少包含 `item_id`、`file_path`、`row_number`、`status`、`src`、`dst`、`name_src`、`name_dst`。
 * @param meta `project_meta.json` 内容，至少包含 `files` 列表。
 * @param warnings 警告数组，每项包含 `item_id` 与 `warnings`。
 * @param options 范围选项。可指定 `file_paths`、`item_ids`、`start_item_id`、`end_item_id`。
 * @returns 范围条目、统计与排除原因。
 */
export function buildReviewPlan(entries, meta, warnings, options = {}) {
  const file_order = read_file_order(meta);
  const sorted = [...entries].sort(
    (left, right) =>
      read_file_index(file_order, left.file_path) - read_file_index(file_order, right.file_path) ||
      read_number(left.row_number) - read_number(right.row_number) ||
      read_number(left.item_id) - read_number(right.item_id),
  );
  const excluded = { status: 0, empty_src: 0, empty_target: 0 };
  const scoped = [];
  for (const entry of sorted) {
    const reason = read_excluded_reason(entry);
    if (reason !== null) {
      excluded[reason] += 1;
      continue;
    }
    if (!read_scope_match(entry, options)) continue;
    scoped.push(entry);
  }
  const files = [];
  for (const entry of scoped) {
    const last = files.at(-1);
    if (last !== undefined && last.file_path === entry.file_path) last.item_count += 1;
    else files.push({ file_path: entry.file_path, item_count: 1 });
  }
  const warning_item_ids = [
    ...new Set(
      (Array.isArray(warnings) ? warnings : [])
        .map((warning) => read_number(warning?.item_id))
        .filter((item_id) => item_id > 0),
    ),
  ];
  return {
    scope: {
      file_paths: read_path_list(options.file_paths),
      item_ids: read_id_list(options.item_ids),
      start_item_id: read_optional_id(options.start_item_id),
      end_item_id: read_optional_id(options.end_item_id),
    },
    scope_item_ids: scoped.map((entry) => read_number(entry.item_id)),
    scope_count: scoped.length,
    file_count: files.length,
    files,
    excluded_counts: excluded,
    warning_item_ids,
  };
}

/**
 * 由范围建立初始进度。进度文件是唯一的续跑依据。
 * @param plan `buildReviewPlan` 的结果。
 * @param task 任务标识，用于进度文件名。
 * @param updated_at 更新时间文本。
 * @returns 初始进度对象。
 */
export function createReviewProgress(plan, task, updated_at = new Date().toISOString()) {
  return {
    version: 1,
    task,
    scope: plan.scope,
    scope_item_ids: [...plan.scope_item_ids],
    scope_count: plan.scope_count,
    visited_item_ids: [],
    unresolved: [],
    attempts: {},
    in_progress: [],
    completed_units: 0,
    updated_at,
  };
}

/**
 * 取得下一批待校对条目。已发出的单元优先返回，避免中断后丢失进度。
 * @param progress 当前进度。
 * @param entries 条目数组。
 * @param meta `project_meta.json` 内容。
 * @param warnings 警告数组。
 * @param options 范围选项，可含 `max_items` 与 `max_bytes`。
 * @returns `status` 为 `unit`、`complete` 或 `needs_abandon`。
 */
export function nextReviewUnit(progress, entries, meta, warnings, options = {}) {
  const scope_ids = read_scope_ids(progress, entries, meta, options);
  const visited = new Set(progress.visited_item_ids ?? []);
  const by_id = new Map(entries.map((entry) => [read_number(entry.item_id), entry]));
  const attempts = progress.attempts ?? {};
  const in_progress = read_id_list(progress.in_progress);
  const pending_in_progress = in_progress.filter((item_id) => !visited.has(item_id));
  if (pending_in_progress.length > 0) {
    const blocked = pending_in_progress.filter(
      (item_id) => read_number(attempts[String(item_id)]) >= MAX_ITEM_ATTEMPTS,
    );
    if (blocked.length > 0) {
      return {
        status: "needs_abandon",
        unit: { item_ids: blocked, items: [], contexts: [], warnings: [], attempts },
        remaining_count: scope_ids.filter((item_id) => !visited.has(item_id)).length,
        missing_item_ids: blocked,
      };
    }
    return {
      status: "unit",
      unit: build_unit(pending_in_progress, by_id, entries, warnings, attempts),
      remaining_count: scope_ids.filter((item_id) => !visited.has(item_id)).length,
      missing_item_ids: pending_in_progress,
    };
  }
  const pending = scope_ids.filter((item_id) => !visited.has(item_id));
  if (pending.length === 0) {
    return {
      status: "complete",
      unit: { item_ids: [], items: [], contexts: [], warnings: [], attempts },
      remaining_count: 0,
      missing_item_ids: [],
    };
  }
  const unit_ids = select_unit_ids(pending, by_id, options);
  const next_attempts = { ...attempts };
  for (const item_id of unit_ids) {
    next_attempts[String(item_id)] = read_number(next_attempts[String(item_id)]) + 1;
  }
  return {
    status: "unit",
    unit: build_unit(unit_ids, by_id, entries, warnings, next_attempts),
    remaining_count: pending.length,
    missing_item_ids: unit_ids,
  };
}

/**
 * 合并审校记录并推进进度。
 * @param progress 当前进度。
 * @param records 审校记录数组。每项包含 `item_id` 与 `verdict`。
 * @returns 新进度、仍缺结论的条目、尚未发出的条目与被拒绝的记录。
 */
export function mergeReviewRecords(progress, records) {
  const visited = new Set(progress.visited_item_ids ?? []);
  const unresolved = [...(progress.unresolved ?? [])];
  const rejected = [];
  const accepted = [];
  const scope_ids = read_id_list(progress.scope_item_ids);
  for (const record of Array.isArray(records) ? records : []) {
    const item_id = read_number(record?.item_id);
    const verdict = record?.verdict;
    if (item_id <= 0 || !REVIEW_VERDICTS.includes(verdict)) {
      rejected.push({ record, reason: "invalid_record" });
      continue;
    }
    if (scope_ids.length > 0 && !scope_ids.includes(item_id)) {
      rejected.push({ record, reason: "out_of_scope" });
      continue;
    }
    if (record?.reason !== undefined && typeof record.reason !== "string") {
      rejected.push({ record, reason: "invalid_reason" });
      continue;
    }
    accepted.push({
      item_id,
      verdict,
      reason: typeof record.reason === "string" ? record.reason : "",
      missing: typeof record.missing === "string" ? record.missing : "",
      applied: record.applied === true,
    });
  }
  const in_progress = read_id_list(progress.in_progress).filter(
    (item_id) => !accepted.some((record) => record.item_id === item_id),
  );
  for (const record of accepted) {
    visited.add(record.item_id);
    if (record.verdict === "unresolved") {
      unresolved.push({
        item_id: record.item_id,
        reason: record.reason,
        missing: record.missing,
      });
    }
  }
  const next = {
    ...progress,
    visited_item_ids: scope_ids.filter((item_id) => visited.has(item_id)),
    unresolved,
    in_progress,
    completed_units: read_number(progress.completed_units) + (accepted.length > 0 ? 1 : 0),
    updated_at: new Date().toISOString(),
  };
  return {
    progress: next,
    missing_item_ids: in_progress,
    pending_item_ids: scope_ids.filter(
      (item_id) => !visited.has(item_id) && !in_progress.includes(item_id),
    ),
    rejected,
  };
}

/**
 * 把仍在处理中且没有结论的条目记为未决。
 * @param progress 当前进度。
 * @param reason 未决原因。
 * @returns 新进度。
 */
export function abandonInProgress(progress, reason) {
  const unresolved = [...(progress.unresolved ?? [])];
  for (const item_id of read_id_list(progress.in_progress)) {
    unresolved.push({ item_id, reason: String(reason ?? ""), missing: "" });
  }
  return {
    ...progress,
    unresolved,
    in_progress: [],
    updated_at: new Date().toISOString(),
  };
}

/**
 * 汇总当前覆盖程度。
 * @param progress 当前进度。
 * @returns 覆盖数量、剩余数量、缺少结论的条目与未决数量。
 */
export function summarizeReviewProgress(progress) {
  const scope_ids = read_id_list(progress.scope_item_ids);
  const visited = new Set(progress.visited_item_ids ?? []);
  const reviewed = scope_ids.filter((item_id) => visited.has(item_id)).length;
  const incomplete_item_ids = read_id_list(progress.in_progress).filter(
    (item_id) => !visited.has(item_id),
  );
  return {
    scope_count: scope_ids.length,
    reviewed_count: reviewed,
    remaining_count: Math.max(0, scope_ids.length - reviewed),
    incomplete_item_ids,
    unresolved_count: (progress.unresolved ?? []).length,
  };
}

/**
 * 读取超大条目的字段切片，避免单次请求携带完整正文。
 * @param entries 条目数组。
 * @param item_id 目标条目。
 * @param field 字段名。
 * @param offset 起始字符位置。
 * @param limit 读取字符数。
 * @returns 切片文本与剩余长度。
 */
export function readItemFieldSlice(entries, item_id, field, offset = 0, limit = 4096) {
  if (!REVIEW_FIELDS.includes(field)) throw new Error(`Unknown review field: ${field}`);
  const target = (Array.isArray(entries) ? entries : []).find(
    (entry) => read_number(entry?.item_id) === read_number(item_id),
  );
  if (target === undefined) throw new Error(`Unknown review item: ${item_id}`);
  const text = read_field_text(target, field);
  const start = Math.max(0, Math.floor(read_number(offset)));
  const size = Math.max(1, Math.floor(read_number(limit)));
  const end = Math.min(text.length, start + size);
  return {
    item_id: read_number(item_id),
    field,
    start,
    end,
    total_length: text.length,
    has_more: end < text.length,
    text: text.slice(start, end),
  };
}

/** 读取范围条目。进度文件已有范围时以进度为准，避免中途改变覆盖对象。 */
function read_scope_ids(progress, entries, meta, options) {
  const recorded = read_id_list(progress.scope_item_ids);
  if (recorded.length > 0) return recorded;
  return buildReviewPlan(entries, meta, [], options).scope_item_ids;
}

/** 选取同一文件内连续的未处理条目，单元不跨文件。 */
function select_unit_ids(pending, by_id, options) {
  const max_items = Math.max(1, Math.floor(read_number(options.max_items)) || DEFAULT_MAX_ITEMS);
  const max_bytes = Math.max(1024, Math.floor(read_number(options.max_bytes)) || DEFAULT_MAX_BYTES);
  const selected = [];
  let file_path = null;
  let bytes = 0;
  for (const item_id of pending) {
    const entry = by_id.get(item_id);
    if (entry === undefined) continue;
    if (file_path === null) file_path = entry.file_path;
    else if (entry.file_path !== file_path) break;
    if (selected.length >= max_items) break;
    const size = JSON.stringify(entry).length;
    if (selected.length > 0 && bytes + size > max_bytes) break;
    selected.push(item_id);
    bytes += size;
  }
  return selected;
}

/** 组装单元内容：条目、同文件邻近语境、关联警告与尝试次数。 */
function build_unit(item_ids, by_id, entries, warnings, attempts) {
  const warning_by_id = new Map();
  for (const warning of Array.isArray(warnings) ? warnings : [])
    warning_by_id.set(read_number(warning?.item_id), warning);
  const contexts = item_ids.map((item_id) => ({
    item_id,
    before: read_neighbors(entries, item_id, "before"),
    after: read_neighbors(entries, item_id, "after"),
  }));
  return {
    item_ids,
    items: item_ids.map((item_id) => by_id.get(item_id)).filter((entry) => entry !== undefined),
    contexts,
    warnings: item_ids
      .map((item_id) => warning_by_id.get(item_id))
      .filter((warning) => warning !== undefined),
    attempts: Object.fromEntries(
      item_ids.map((item_id) => [String(item_id), read_number(attempts[String(item_id)])]),
    ),
  };
}

/** 读取同文件内相邻的非空原文条目。 */
function read_neighbors(entries, item_id, direction) {
  const list = Array.isArray(entries) ? entries : [];
  const index = list.findIndex((entry) => read_number(entry?.item_id) === read_number(item_id));
  if (index < 0) return [];
  const neighbors = [];
  const step = direction === "before" ? -1 : 1;
  for (let cursor = index + step; cursor >= 0 && cursor < list.length; cursor += step) {
    const entry = list[cursor];
    if (entry?.file_path !== list[index]?.file_path) break;
    if (String(entry?.src ?? "").trim() === "") continue;
    neighbors.push({
      item_id: read_number(entry.item_id),
      row_number: read_number(entry.row_number),
      src: entry.src,
      dst: entry.dst,
    });
    if (neighbors.length >= CONTEXT_NEIGHBORS) break;
  }
  return neighbors;
}

/** 条目字段文本。姓名数组只取可见槽位。 */
function read_field_text(entry, field) {
  const value = entry?.[field];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return "";
}

/** 排除原因。返回 null 表示条目进入范围。 */
function read_excluded_reason(entry) {
  if (EXCLUDED_STATUSES.has(String(entry?.status ?? ""))) return "status";
  if (String(entry?.src ?? "").trim() === "") return "empty_src";
  const has_dst = String(entry?.dst ?? "").trim() !== "";
  const has_name = read_field_text(entry, "name_dst").trim() !== "";
  if (!has_dst && !has_name) return "empty_target";
  return null;
}

/** 范围筛选。用户给出的条件与默认条件同时生效。 */
function read_scope_match(entry, options) {
  const file_paths = read_path_list(options.file_paths);
  if (file_paths.length > 0 && !file_paths.includes(String(entry?.file_path ?? ""))) return false;
  const item_ids = read_id_list(options.item_ids);
  if (item_ids.length > 0 && !item_ids.includes(read_number(entry?.item_id))) return false;
  const start = read_optional_id(options.start_item_id);
  const end = read_optional_id(options.end_item_id);
  const item_id = read_number(entry?.item_id);
  if (start !== null && item_id < start) return false;
  if (end !== null && item_id > end) return false;
  return true;
}

/** 文件顺序来自工程文件索引，缺失文件排在末尾。 */
function read_file_order(meta) {
  const files = Array.isArray(meta?.files) ? meta.files : [];
  return new Map(files.map((file, index) => [String(file?.file_path ?? ""), index]));
}

/** 文件顺序索引。未知文件使用最大序号。 */
function read_file_index(file_order, file_path) {
  const index = file_order.get(String(file_path ?? ""));
  return index === undefined ? Number.MAX_SAFE_INTEGER : index;
}

/** 路径列表。空值表示不限定文件。 */
function read_path_list(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((path) => typeof path === "string" && path !== ""))];
}

/** 条目身份列表。空值表示不限定条目。 */
function read_id_list(value) {
  if (!Array.isArray(value)) return [];
  const ids = value.map((item) => read_number(item)).filter((item) => item > 0);
  return [...new Set(ids)];
}

/** 可选条目身份。 */
function read_optional_id(value) {
  if (value === undefined || value === null) return null;
  const id = read_number(value);
  return id > 0 ? id : null;
}

/** 安全整数读取。 */
function read_number(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}
