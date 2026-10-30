import posix from "node:path/posix";

import JSZip from "jszip";
import { Element, Text, type ChildNode } from "domhandler";

import type { Item } from "../../domain/item";
import { AppError } from "../../shared/error/app-error";
import {
  EpubAst,
  is_epub_content_item,
  read_epub_extra,
  read_epub_text_run,
} from "../file/epub/epub-ast";
import {
  build_wenku_nav,
  build_wenku_ncx,
  read_merged_volume_prefix,
  type MergedEpubVolume,
  type WenkuEpubNavGroup,
} from "../file/epub/epub-merge";
import { write_zip, type ZipContents } from "../file/epub/epub-zip";
import { EpubWriter } from "../file/epub/epub-writer";
import { read_epub_remote_source } from "./epub-remote-source";
import {
  align_remote_documents,
  normalize_match_line,
  sha256_text,
  type RemoteAlignmentPlan,
  type RemoteAlignmentStats,
  type RemoteAssetItemSeed,
  type RemoteChapterPlan,
  type RemoteDocument,
  type RemoteOldItem,
  type RemoteRowPlan,
} from "./novelia-source";
import {
  build_epub_document_key,
  build_remote_epub_map,
  type RemoteEpubMap,
  type RemoteEpubMapDocument,
  type RemoteEpubMapVolume,
} from "./remote-source";
import { list_document_paragraph_rows, type WenkuEpubPackage } from "./wenku-epub-source";

const AST = new EpubAst();
const SOURCE_WRITER = new EpubWriter({ target_language: "JA" });

/** 本地合并包内的文档与它的规范行；`start` 是整本行号起点。 */
export interface WenkuEpubLocalDocument {
  doc_path: string;
  start: number;
  lines: string[];
}

export interface WenkuEpubLocalPackage {
  documents: WenkuEpubLocalDocument[];
  lines: string[];
}

/** 远端合并包内的章节：站点章节 id、文档行与站点译文都由合并结果直接给出。 */
export interface WenkuEpubRemoteDocument {
  chapter_id: string;
  volume_id: string;
  volume_title: string;
  source_doc_path: string;
  doc_path: string;
  title: string;
  linear: boolean;
  media_type: string;
  properties: string;
  lines: string[];
  /** 站点已有译文，键为文档内行号。 */
  translations: Map<number, string>;
}

export interface WenkuEpubRemotePackage {
  filename: string;
  volumes: MergedEpubVolume[];
  documents: WenkuEpubRemoteDocument[];
}

export type WenkuEpubDocumentState = "unchanged" | "updated" | "added" | "retired" | "restored";

export interface WenkuEpubSyncPlanDocument {
  /** 非章节文档（没有站点章节身份）为 null。 */
  chapter_id: string | null;
  volume_id: string | null;
  doc_path: string;
  title: string;
  state: WenkuEpubDocumentState;
  mapped: RemoteEpubMapDocument | null;
  remote: WenkuEpubRemoteDocument | null;
  rows: RemoteRowPlan[];
  /** 该文档中不再出现在远端版本里的条目；退役文档保留全部条目。 */
  removed_items: RemoteOldItem[];
  chapter: RemoteChapterPlan;
}

export interface WenkuEpubSyncPlan {
  documents: WenkuEpubSyncPlanDocument[];
  alignment: RemoteAlignmentPlan;
  /** 应用后的章节映射；只有应用成功的计划才允许写库。 */
  map: RemoteEpubMap;
  /** 新增章节的日文字节取自这份远端合并包。 */
  remote_bytes: Uint8Array;
}

export interface WenkuEpubSyncPlans {
  /** 完整同步：改写、并入新增章节并退役远端已删除的章节。 */
  full: WenkuEpubSyncPlan;
  /** 仅追加：只并入新增章节，既有文档与退役状态保持不动。 */
  add_only: WenkuEpubSyncPlan;
}

export interface WenkuEpubSyncAsset {
  bytes: Uint8Array;
  content_seeds: RemoteAssetItemSeed[];
  fixed_seeds: RemoteAssetItemSeed[];
  /** 重解析后的规范正文，供快照继续使用同一套文本基准。 */
  text: string;
  map: RemoteEpubMap;
}

/** 读取本地合并包，按文档分组正文行；行序即条目顺序。 */
export async function read_wenku_epub_local_package(
  bytes: Uint8Array,
  rel_path: string,
): Promise<WenkuEpubLocalPackage> {
  const source = await read_epub_remote_source(bytes, rel_path);
  const documents: WenkuEpubLocalDocument[] = [];
  const lines = source.lines.map((line) => line.text);
  for (const [index, line] of source.lines.entries()) {
    const epub = read_epub_extra(line.item);
    const doc_path = String(epub?.["doc_path"] ?? "");
    const current = documents.at(-1);
    if (current !== undefined && current.doc_path === doc_path) {
      current.lines.push(line.text);
      continue;
    }
    documents.push({ doc_path, start: index, lines: [line.text] });
  }
  return { documents, lines };
}

/**
 * 远端合并包只暴露同步需要的事实：章节身份、文档行与站点已有译文。
 * 章节文件本身留在 `remote_bytes` 里，只有真正并入时才写出。
 */
export async function read_wenku_epub_remote_package(
  pkg: WenkuEpubPackage,
  rel_path: string,
): Promise<WenkuEpubRemotePackage> {
  const source = await read_epub_remote_source(pkg.bytes, rel_path);
  const zip = await JSZip.loadAsync(pkg.bytes);
  const opf_path = await AST.parse_container_opf_path(zip);
  const pkg_info = await AST.parse_opf(zip, opf_path);
  const manifest = await read_manifest_attributes(zip, opf_path, pkg_info.opf_dir);

  const lines_by_doc = new Map<string, string[]>();
  const line_index_by_row = new Map<number, number>();
  const items_by_doc = new Map<string, Item[]>();
  for (const line of source.lines) {
    const epub = read_epub_extra(line.item);
    const doc_path = String(epub?.["doc_path"] ?? "");
    const queue = lines_by_doc.get(doc_path) ?? [];
    line_index_by_row.set(line.item.row, queue.length);
    queue.push(line.text);
    lines_by_doc.set(doc_path, queue);
    const items = items_by_doc.get(doc_path) ?? [];
    items.push(line.item);
    items_by_doc.set(doc_path, items);
  }

  const documents: WenkuEpubRemoteDocument[] = [];
  for (const document of pkg.documents) {
    const media = manifest.get(document.doc_path);
    documents.push({
      chapter_id: document.chapter_id,
      volume_id: document.volume_id,
      volume_title: document.volume_title,
      source_doc_path: document.source_doc_path,
      doc_path: document.doc_path,
      title: document.title,
      linear: document.linear,
      media_type: media?.media_type ?? "application/xhtml+xml",
      properties: media?.properties ?? "",
      lines: lines_by_doc.get(document.doc_path) ?? [],
      translations: read_remote_paragraph_translations({
        paragraphs: document.data.paragraphs,
        items: items_by_doc.get(document.doc_path) ?? [],
        root: document.data.root,
        line_index_by_row,
      }),
    });
  }
  return { filename: pkg.filename, volumes: pkg.volumes, documents };
}

/**
 * 站点译文只在「非空 body `<p>` 顺序」与工程条目顺序都对齐时启用；
 * 任何数量或文本偏差都放弃该文档，避免把中文写到错误的段落。
 */
function read_remote_paragraph_translations(input: {
  paragraphs: ReadonlyArray<{ jp: string; zh: string | null }>;
  items: readonly Item[];
  root: Element;
  line_index_by_row: ReadonlyMap<number, number>;
}): Map<number, string> {
  const result = new Map<number, string>();
  if (input.paragraphs.length === 0) return result;
  const rows = list_document_paragraph_rows(input.items, input.root);
  if (rows.length !== input.paragraphs.length) return result;
  const line_indexes: number[] = [];
  for (const [index, row] of rows.entries()) {
    const paragraph = input.paragraphs[index];
    if (paragraph === undefined || paragraph.jp !== row.text) return result;
    const line_index = input.line_index_by_row.get(row.row);
    if (line_index === undefined) return result;
    line_indexes.push(line_index);
  }
  for (const [index, paragraph] of input.paragraphs.entries()) {
    const zh = paragraph.zh;
    if (zh === null || zh.trim() === "") continue;
    const line_index = line_indexes[index];
    if (line_index !== undefined) result.set(line_index, zh);
  }
  return result;
}

/**
 * 以 `(分卷, 站点章节 id)` 为主键比较本地与远端合并包。
 * 双方都有的章节做文档内行对齐；只有远端的章节并入包；只有本地的章节退役。
 */
export function build_wenku_epub_sync_plans(input: {
  local: WenkuEpubLocalPackage;
  old_items: readonly RemoteOldItem[];
  map: RemoteEpubMap;
  remote: WenkuEpubRemotePackage;
  remote_bytes: Uint8Array;
}): WenkuEpubSyncPlans {
  const local_by_path = new Map(
    input.local.documents.map((document) => [document.doc_path, document] as const),
  );
  for (const mapped of input.map.documents) {
    if (!local_by_path.has(mapped.doc_path)) {
      throw new AppError("remote.epub_document_conflict", {
        public_details: {
          reason: "document_missing",
          chapter_id: mapped.chapter_id,
          doc_path: mapped.doc_path,
        },
      });
    }
  }
  const mapped_by_path = new Map(
    input.map.documents.map((document) => [document.doc_path, document] as const),
  );
  const remote_by_key = new Map(
    input.remote.documents.map(
      (document) =>
        [build_epub_document_key(document.volume_id, document.chapter_id), document] as const,
    ),
  );
  const entries = build_final_document_entries(input.local, input.map, input.remote);
  const base = {
    local: input.local,
    old_items: input.old_items,
    map: input.map,
    mapped_by_path,
    remote_by_key,
    remote_volumes: input.remote.volumes,
    remote_bytes: input.remote_bytes,
  };
  return {
    full: build_plan(entries, { ...base, mode: "full" }),
    add_only: build_plan(entries, { ...base, mode: "add_only" }),
  };
}

interface FinalDocumentEntry {
  type: "local" | "added";
  doc_path: string;
  local: WenkuEpubLocalDocument | null;
  remote: WenkuEpubRemoteDocument | null;
}

/**
 * 最终文档顺序以本地包顺序为骨架：新增章节插到同一分卷最后一篇文档之后，
 * 没有本地文档的新分卷追加在末尾。行号与目录都按这个顺序重算。
 */
function build_final_document_entries(
  local: WenkuEpubLocalPackage,
  map: RemoteEpubMap,
  remote: WenkuEpubRemotePackage,
): FinalDocumentEntry[] {
  const mapped_keys = new Set(
    map.documents.map((document) =>
      build_epub_document_key(document.volume_id, document.chapter_id),
    ),
  );
  const additions = new Map<string, WenkuEpubRemoteDocument[]>();
  for (const document of remote.documents) {
    if (mapped_keys.has(build_epub_document_key(document.volume_id, document.chapter_id))) continue;
    const prefix = read_merged_volume_prefix(document.doc_path);
    if (prefix === null) continue;
    const queue = additions.get(prefix) ?? [];
    queue.push(document);
    additions.set(prefix, queue);
  }

  const entries: FinalDocumentEntry[] = [];
  const flush = (prefix: string | null): void => {
    if (prefix === null) return;
    const pending = additions.get(prefix);
    if (pending === undefined) return;
    additions.delete(prefix);
    for (const document of pending) {
      entries.push({ type: "added", doc_path: document.doc_path, local: null, remote: document });
    }
  };
  for (const [index, document] of local.documents.entries()) {
    entries.push({ type: "local", doc_path: document.doc_path, local: document, remote: null });
    const prefix = read_merged_volume_prefix(document.doc_path);
    const next = local.documents[index + 1];
    const next_prefix = next === undefined ? null : read_merged_volume_prefix(next.doc_path);
    if (prefix !== null && prefix !== next_prefix) flush(prefix);
  }
  for (const volume of remote.volumes) flush(volume.prefix);
  for (const prefix of additions.keys()) flush(prefix);
  return entries;
}

function build_plan(
  entries: readonly FinalDocumentEntry[],
  input: {
    local: WenkuEpubLocalPackage;
    old_items: readonly RemoteOldItem[];
    map: RemoteEpubMap;
    mapped_by_path: ReadonlyMap<string, RemoteEpubMapDocument>;
    remote_by_key: ReadonlyMap<string, WenkuEpubRemoteDocument>;
    remote_volumes: readonly MergedEpubVolume[];
    remote_bytes: Uint8Array;
    mode: "full" | "add_only";
  },
): WenkuEpubSyncPlan {
  const local_start_by_path = new Map(
    input.local.documents.map((document) => [document.doc_path, document.start] as const),
  );
  const documents: WenkuEpubSyncPlanDocument[] = [];
  let diverged = false;
  for (const entry of entries) {
    const mapped = input.mapped_by_path.get(entry.doc_path) ?? null;
    const remote =
      mapped === null
        ? entry.remote
        : (input.remote_by_key.get(build_epub_document_key(mapped.volume_id, mapped.chapter_id)) ??
          null);
    const old_items = slice_old_items(
      input.old_items,
      local_start_by_path.get(entry.doc_path) ?? 0,
      entry.local?.lines.length ?? 0,
    );
    if (entry.type === "added") {
      // 同一包内路径被远端当作新章节，说明本地映射与资产已不一致。
      if (local_start_by_path.has(entry.doc_path)) {
        throw new AppError("remote.epub_document_conflict", {
          public_details: { reason: "document_path_reused", doc_path: entry.doc_path },
        });
      }
      documents.push(build_added_document(remote!));
      continue;
    }
    // 仅追加模式不改写、不退役、不恢复既有文档：其余文档一律按当前条目保留。
    if (input.mode === "add_only") {
      documents.push(
        build_kept_document({
          doc_path: entry.doc_path,
          chapter_id: mapped?.chapter_id ?? null,
          volume_id: mapped?.volume_id ?? null,
          title: mapped?.title ?? "",
          old_items,
          state: "unchanged",
          mapped,
        }),
      );
      continue;
    }
    if (mapped === null) {
      documents.push(
        build_kept_document({
          doc_path: entry.doc_path,
          chapter_id: null,
          volume_id: null,
          title: "",
          old_items,
          state: "unchanged",
          mapped: null,
        }),
      );
      continue;
    }
    if (remote === null) {
      documents.push(
        build_kept_document({
          doc_path: entry.doc_path,
          chapter_id: mapped.chapter_id,
          volume_id: mapped.volume_id,
          title: mapped.title,
          old_items,
          state: "retired",
          mapped,
        }),
      );
      continue;
    }
    const aligned = align_document({
      local_lines: entry.local!.lines,
      remote,
      old_items,
    });
    if (aligned.diverged) diverged = true;
    const restored = mapped.state === "retired";
    const changed = aligned.state === "updated" || restored || mapped.title !== remote.title;
    documents.push({
      chapter_id: mapped.chapter_id,
      volume_id: mapped.volume_id,
      doc_path: entry.doc_path,
      title: remote.title,
      state: restored ? "restored" : changed ? "updated" : "unchanged",
      mapped,
      remote,
      rows: aligned.rows,
      removed_items: aligned.removed_items,
      chapter: aligned.chapter,
    });
  }

  const stats = summarize(documents);
  stats.diverged = diverged;
  // 行键与章节索引在这里一次性换成整本编号：预览按章节过滤、应用按行键回写都依赖它们。
  const chapters: RemoteChapterPlan[] = [];
  let base = 0;
  for (const [index, document] of documents.entries()) {
    for (const [offset, row] of document.rows.entries()) {
      row.row = base + offset;
      row.chapter_index = index;
    }
    const chapter = document.chapter;
    chapter.index = index;
    chapter.title = document.title;
    chapter.start_row = base;
    chapter.end_row = base + document.rows.length;
    chapters.push(chapter);
    base += document.rows.length;
  }
  const rows = documents.flatMap((document) => document.rows);
  const previous_lines = input.local.lines;
  const next_lines = rows.map((row) => row.src);
  return {
    documents,
    alignment: {
      previous: build_document_shell(previous_lines),
      next: build_document_shell(next_lines),
      rows,
      chapters,
      stats,
    },
    map: build_plan_map({
      documents,
      map: input.map,
      remote_volumes: input.remote_volumes,
      mode: input.mode,
    }),
    remote_bytes: input.remote_bytes,
  };
}

/** 映射以计划文档顺序保存；退役文档保留线性标记，恢复时按它还原 spine。 */
function build_plan_map(input: {
  documents: readonly WenkuEpubSyncPlanDocument[];
  map: RemoteEpubMap;
  remote_volumes: readonly MergedEpubVolume[];
  mode: "full" | "add_only";
}): RemoteEpubMap {
  const volumes: RemoteEpubMapVolume[] = input.map.volumes.map((volume) => ({ ...volume }));
  const known_volumes = new Set(volumes.map((volume) => volume.volume_id));
  const documents: RemoteEpubMapDocument[] = [];
  for (const document of input.documents) {
    if (document.chapter_id === null || document.volume_id === null) continue;
    const previous = document.mapped;
    if (!known_volumes.has(document.volume_id) && document.remote !== null) {
      const volume = input.remote_volumes.find(
        (candidate) => candidate.volume_id === document.volume_id,
      );
      volumes.push({
        volume_id: document.volume_id,
        volume_title: volume?.volume_title ?? document.remote.volume_title,
        prefix: volume?.prefix ?? read_merged_volume_prefix(document.remote.doc_path) ?? "",
      });
      known_volumes.add(document.volume_id);
    }
    if (previous === null) {
      const remote = document.remote;
      if (remote === null) continue;
      documents.push({
        chapter_id: document.chapter_id,
        volume_id: document.volume_id,
        source_doc_path: remote.source_doc_path,
        doc_path: document.doc_path,
        title: document.title,
        linear: remote.linear,
        state: "active",
      });
      continue;
    }
    const state =
      input.mode === "full"
        ? document.state === "retired"
          ? "retired"
          : "active"
        : previous.state;
    documents.push({ ...previous, title: document.title, state });
  }
  return build_remote_epub_map({ volumes, documents });
}

interface AlignedDocument {
  state: "unchanged" | "updated";
  rows: RemoteRowPlan[];
  removed_items: RemoteOldItem[];
  chapter: RemoteChapterPlan;
  diverged: boolean;
}

/**
 * 文档内对齐沿用整本行模型：行号在本文档内从 0 开始，匹配后再由调用方换成整本键。
 * 文本完全一致时直接保留全部条目，避免整本相同却重跑相似度匹配。
 */
function align_document(input: {
  local_lines: readonly string[];
  remote: WenkuEpubRemoteDocument;
  old_items: readonly RemoteOldItem[];
}): AlignedDocument {
  if (
    input.local_lines.length === input.remote.lines.length &&
    input.local_lines.every((line, index) => line === input.remote.lines[index])
  ) {
    const rows = input.remote.lines.map((text, index) => ({
      row: index,
      src: text,
      src_hash: sha256_text(text),
      chapter_index: 0,
      decision: "preserve" as const,
      old_item: input.old_items[index] ?? null,
      remote_dst: input.remote.translations.get(index) ?? null,
      similarity: 1,
      review: false,
    }));
    return {
      state: "unchanged",
      rows,
      removed_items: [],
      chapter: build_chapter_plan({
        title: input.remote.title,
        status: "unchanged",
        rows,
        removed_items: [],
      }),
      diverged: false,
    };
  }
  const local_rows = input.old_items.map((item, index) => ({ ...item, row: index }));
  const plan = align_remote_documents({
    previous_text: input.local_lines.join("\n"),
    next_text: input.remote.lines.join("\n"),
    old_items: local_rows,
    next_translations: input.remote.translations,
  });
  const matched = new Set<number>();
  for (const row of plan.rows) {
    if (row.old_item !== null) matched.add(row.old_item.item_id);
  }
  const removed_items = input.old_items.filter((item) => !matched.has(item.item_id));
  return {
    state: "updated",
    rows: plan.rows,
    removed_items,
    chapter: build_chapter_plan({
      title: input.remote.title,
      status: "modified",
      rows: plan.rows,
      removed_items,
    }),
    diverged: plan.stats.diverged,
  };
}

function build_added_document(remote: WenkuEpubRemoteDocument): WenkuEpubSyncPlanDocument {
  const rows = remote.lines.map((text, index) => ({
    row: index,
    src: text,
    src_hash: sha256_text(text),
    chapter_index: 0,
    decision: "retranslate" as const,
    old_item: null,
    remote_dst: remote.translations.get(index) ?? null,
    similarity: 0,
    review: false,
  }));
  return {
    chapter_id: remote.chapter_id,
    volume_id: remote.volume_id,
    doc_path: remote.doc_path,
    title: remote.title,
    state: "added",
    mapped: null,
    remote,
    rows,
    removed_items: [],
    chapter: build_chapter_plan({
      title: remote.title,
      status: "added",
      rows,
      removed_items: [],
    }),
  };
}

function build_kept_document(input: {
  doc_path: string;
  chapter_id: string | null;
  volume_id: string | null;
  title: string;
  old_items: readonly RemoteOldItem[];
  state: "unchanged" | "retired";
  mapped: RemoteEpubMapDocument | null;
}): WenkuEpubSyncPlanDocument {
  const rows = input.old_items.map((item, index) => ({
    row: index,
    src: item.src,
    src_hash: sha256_text(item.src),
    chapter_index: 0,
    decision: "preserve" as const,
    old_item: item,
    remote_dst: null,
    similarity: 1,
    review: false,
  }));
  const title = read_document_label(input.title, input.doc_path, rows);
  return {
    chapter_id: input.chapter_id,
    volume_id: input.volume_id,
    doc_path: input.doc_path,
    title,
    state: input.state,
    mapped: input.mapped,
    remote: null,
    rows,
    removed_items: [],
    chapter: build_chapter_plan({
      title,
      kind: input.chapter_id === null ? "preamble" : "chapter",
      status: input.state === "retired" ? "removed" : "unchanged",
      rows,
      removed_items: [],
    }),
  };
}

/** 非章节文档（封面、说明页等）没有站点标题，用首个标题行或文件名兜底。 */
function read_document_label(
  title: string,
  doc_path: string,
  rows: readonly RemoteRowPlan[],
): string {
  if (title !== "") return title;
  for (const row of rows) {
    if (row.src.startsWith("# ") && row.src.slice(2).trim() !== "") return row.src.slice(2).trim();
  }
  return posix.basename(doc_path);
}

function build_chapter_plan(input: {
  title: string;
  status: RemoteChapterPlan["status"];
  rows: readonly RemoteRowPlan[];
  removed_items: readonly RemoteOldItem[];
  kind?: RemoteChapterPlan["kind"];
}): RemoteChapterPlan {
  return {
    index: 0,
    kind: input.kind ?? "chapter",
    title: input.title,
    status: input.status,
    old_index: null,
    start_row: 0,
    end_row: input.rows.length,
    added: input.rows.filter((row) => row.old_item === null).length,
    modified: input.rows.filter(
      (row) =>
        row.old_item !== null &&
        normalize_match_line(row.src) !== normalize_match_line(row.old_item.src),
    ).length,
    removed: input.removed_items.length,
    inherited: 0,
    would_lose: 0,
    removed_lines: [],
  };
}

function summarize(documents: readonly WenkuEpubSyncPlanDocument[]): RemoteAlignmentStats {
  const stats: RemoteAlignmentStats = {
    added: 0,
    modified: 0,
    removed: 0,
    inherited: 0,
    remote_inherited: 0,
    would_lose: 0,
    diverged: false,
    requires_alignment: false,
  };
  let total = 0;
  for (const document of documents) {
    total += document.rows.length;
    for (const row of document.rows) {
      if (row.old_item === null) stats.added += 1;
      else if (normalize_match_line(row.src) !== normalize_match_line(row.old_item.src)) {
        stats.modified += 1;
      }
      if (row.decision !== "retranslate" && row.old_item !== null && row.old_item.dst !== "") {
        stats.inherited += 1;
      }
      if (row.decision === "retranslate" && row.old_item !== null && row.old_item.dst !== "") {
        stats.would_lose += 1;
      }
      if (uses_remote_translation(row)) stats.remote_inherited += 1;
    }
    // 退役保留文档、条目与译文，不计入删除与丢失。
    if (document.state === "retired") continue;
    stats.removed += document.removed_items.length;
    stats.would_lose += document.removed_items.filter((item) => item.dst !== "").length;
  }
  stats.requires_alignment = stats.would_lose > 20 && stats.would_lose / Math.max(total, 1) > 0.05;
  return stats;
}

function uses_remote_translation(row: RemoteRowPlan): boolean {
  if (row.remote_dst === null || row.remote_dst.trim() === "") return false;
  return row.old_item === null || row.old_item.dst === "";
}

function build_document_shell(lines: readonly string[]): RemoteDocument {
  return {
    text: lines.join("\n"),
    lines: lines.map((line, row) => ({ row, text: line, src_hash: sha256_text(line) })),
    chapters: [],
  };
}

function slice_old_items(
  items: readonly RemoteOldItem[],
  start: number,
  count: number,
): RemoteOldItem[] {
  return items.slice(start, start + count);
}

async function read_manifest_attributes(
  zip: JSZip,
  opf_path: string,
  opf_dir: string,
): Promise<Map<string, { media_type: string; properties: string }>> {
  const result = new Map<string, { media_type: string; properties: string }>();
  const raw = await zip.file(opf_path)?.async("uint8array");
  if (raw === undefined) return result;
  const manifest = AST.find_descendants(AST.parse_opf_xml(raw), "manifest")[0] ?? null;
  if (manifest === null) return result;
  for (const item of AST.iter_children_elements(manifest)) {
    if (AST.local_name(item.name) !== "item") continue;
    const href = item.attribs["href"];
    if (href === undefined) continue;
    result.set(AST.resolve_href(opf_dir, href), {
      media_type: item.attribs["media-type"] ?? "application/xhtml+xml",
      properties: item.attribs["properties"] ?? "",
    });
  }
  return result;
}

/**
 * 把文档级计划写回本地合并包：段落改写/增删、新增章节整篇并入、退役改 spine 线性标记，
 * 最后按最终文档清单重建 nav/NCX。重解析后必须与计划行逐一相等，否则视为结构不支持。
 */
export async function apply_wenku_epub_sync_plan(input: {
  bytes: Uint8Array;
  rel_path: string;
  plan: WenkuEpubSyncPlan;
}): Promise<WenkuEpubSyncAsset> {
  const zip = await JSZip.loadAsync(input.bytes);
  const opf_path = await AST.parse_container_opf_path(zip);
  const pkg = await AST.parse_opf(zip, opf_path);
  const opf_raw = await zip.file(opf_path)?.async("uint8array");
  const opf_root = AST.parse_opf_xml(opf_raw ?? new Uint8Array());
  const docs = new Map<string, DocState>();
  const added = new Map<string, Uint8Array>();
  let spine = read_spine_refs(opf_root, pkg.opf_dir);
  let opf_changed = false;
  let remote_zip: JSZip | null = null;

  const get_doc = async (doc_path: string): Promise<DocState> => {
    const existing = docs.get(doc_path);
    if (existing !== undefined) return existing;
    const raw = await zip.file(doc_path)?.async("uint8array");
    if (raw === undefined) {
      throw new AppError("remote.epub_document_conflict", {
        public_details: { reason: "document_missing", doc_path },
      });
    }
    const doc: DocState = { path: doc_path, root: AST.parse_xhtml_or_html(raw), changed: false };
    docs.set(doc_path, doc);
    return doc;
  };

  let after_doc_path: string | null = null;
  for (const document of input.plan.documents) {
    switch (document.state) {
      case "added": {
        const remote = document.remote;
        if (remote === null) {
          throw new AppError("remote.epub_document_conflict", {
            public_details: { reason: "added_document_missing", doc_path: document.doc_path },
          });
        }
        remote_zip ??= await JSZip.loadAsync(input.plan.remote_bytes);
        const raw = await remote_zip.file(remote.doc_path)?.async("uint8array");
        if (raw === undefined) {
          throw new AppError("remote.epub_document_conflict", {
            public_details: { reason: "added_document_missing", doc_path: document.doc_path },
          });
        }
        added.set(document.doc_path, raw);
        register_manifest_item({
          opf_root,
          opf_dir: pkg.opf_dir,
          doc_path: document.doc_path,
          media_type: remote.media_type,
          properties: remote.properties,
          after_doc_path,
          spine,
        });
        // 后续新增章节可能紧跟在刚插入的文档之后，spine 需要按最新 OPF 重读。
        spine = read_spine_refs(opf_root, pkg.opf_dir);
        opf_changed = true;
        after_doc_path = document.doc_path;
        continue;
      }
      case "updated": {
        const doc = await get_doc(document.doc_path);
        apply_document_rows(doc, document);
        after_doc_path = document.doc_path;
        continue;
      }
      case "restored": {
        const doc = await get_doc(document.doc_path);
        apply_document_rows(doc, document);
        if (set_spine_linear(spine, document.doc_path, document.mapped?.linear ?? true)) {
          opf_changed = true;
        }
        after_doc_path = document.doc_path;
        continue;
      }
      case "retired": {
        if (set_spine_linear(spine, document.doc_path, false)) opf_changed = true;
        after_doc_path = document.doc_path;
        continue;
      }
      case "unchanged": {
        after_doc_path = document.doc_path;
        continue;
      }
    }
  }

  const title = pkg.opf_title_text ?? "";
  const nav_groups = build_nav_groups(input.plan.map);
  const nav_text =
    pkg.nav_path === null
      ? null
      : SOURCE_WRITER.serialize_document(pkg.nav_path, build_wenku_nav(title, nav_groups));
  const ncx_text =
    pkg.ncx_path === null
      ? null
      : SOURCE_WRITER.serialize_document(
          pkg.ncx_path,
          build_wenku_ncx(title, read_opf_identifier(opf_root), nav_groups),
        );

  const output: ZipContents = new Map();
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    if (name === opf_path) {
      output.set(
        name,
        opf_changed
          ? SOURCE_WRITER.serialize_document(name, opf_root)
          : await file.async("uint8array"),
      );
      continue;
    }
    if (nav_text !== null && name === pkg.nav_path) {
      output.set(name, await replace_if_changed(file, nav_text));
      continue;
    }
    if (ncx_text !== null && name === pkg.ncx_path) {
      output.set(name, await replace_if_changed(file, ncx_text));
      continue;
    }
    const doc = docs.get(name);
    if (doc?.changed === true) {
      output.set(name, SOURCE_WRITER.serialize_document(name, doc.root));
      continue;
    }
    output.set(name, await file.async("uint8array"));
  }
  for (const [path, raw] of added) {
    if (!output.has(path)) output.set(path, raw);
  }
  const bytes = new Uint8Array(await write_zip(output));

  const reparsed = await read_epub_remote_source(bytes, input.rel_path);
  const expected = input.plan.documents.flatMap((document) => document.rows.map((row) => row.src));
  if (reparsed.text !== expected.join("\n")) {
    throw new AppError("remote.source_not_bindable", {
      public_details: { reason: "epub_sync_mismatch" },
    });
  }
  return {
    bytes,
    content_seeds: reparsed.lines.map((line) => to_seed(line.item)),
    fixed_seeds: reparsed.items.filter((item) => !is_epub_content_item(item)).map(to_seed),
    text: reparsed.text,
    map: input.plan.map,
  };
}

interface DocState {
  path: string;
  root: Element;
  changed: boolean;
}

interface ItemRef {
  doc: DocState;
  mode: string;
  element: Element | null;
  nodes: ChildNode[];
}

/** 段落写回：与整本同步一致——未变的块保持原 DOM，变的块只重写块内文本。 */
function apply_document_rows(doc: DocState, document: WenkuEpubSyncPlanDocument): void {
  // 引用必须在任何插入/删除前解析：块路径按当前兄弟序号计算，先改 DOM 会定位到错误的块。
  const refs = new Map<number, ItemRef>();
  for (const row of document.rows) {
    if (row.old_item === null) continue;
    const ref = resolve_ref(doc, row.old_item);
    if (ref === null) {
      throw new AppError("remote.source_not_bindable", {
        public_details: { reason: "epub_structure_unsupported", row: row.row },
      });
    }
    refs.set(row.old_item.item_id, ref);
  }
  const removed_refs = document.removed_items.map((item) => resolve_ref(doc, item));
  let last_anchor: Element | null = null;
  for (const [index, row] of document.rows.entries()) {
    const heading = row.src.startsWith("# ");
    const text = (heading ? row.src.slice(2) : row.src).trim();
    if (row.old_item !== null) {
      const ref = refs.get(row.old_item.item_id)!;
      if (row.old_item.src !== row.src) write_ref_text(ref, text);
      // text_run 不是独立块，不能作为新增块的锚点；后续新增行由下一个块定位。
      last_anchor = ref.mode === "text_run" || ref.element === null ? null : ref.element;
      continue;
    }
    if (last_anchor !== null) {
      last_anchor = insert_block(doc, last_anchor, text, heading, false);
      continue;
    }
    const next = find_next_anchor(document.rows, index, refs);
    if (next !== null) {
      last_anchor = insert_block(doc, next, text, heading, true);
      continue;
    }
    last_anchor = append_block(doc, text, heading);
  }
  for (const ref of removed_refs) {
    if (ref !== null) remove_ref(ref);
  }
}

function find_next_anchor(
  rows: readonly RemoteRowPlan[],
  index: number,
  refs: ReadonlyMap<number, ItemRef>,
): Element | null {
  for (const row of rows.slice(index + 1)) {
    if (row.old_item === null) continue;
    const ref = refs.get(row.old_item.item_id);
    // 下一行仍是 text_run 时无法判断应插在它之前还是之后，放弃定位。
    if (ref === undefined || ref.mode === "text_run") return null;
    if (ref.element !== null) return ref.element;
  }
  return null;
}

function resolve_ref(doc: DocState, item: RemoteOldItem): ItemRef | null {
  const epub = read_epub_extra({ extra_field: item.extra_field } as Item);
  if (epub === null) return null;
  if (String(epub["doc_path"] ?? "") !== doc.path) return null;
  const mode = String(epub["mode"] ?? "");
  if (mode === "text_run") {
    const ref = read_epub_text_run(epub);
    if (ref === null) return null;
    const container = AST.find_by_path(doc.root, ref.container_path);
    if (container === null) return null;
    const nodes = container.children.slice(ref.start, ref.end);
    if (nodes.length === 0) return null;
    return { doc, mode, element: container, nodes };
  }
  if (mode !== "slot_per_line" && mode !== "block_text") return null;
  const block_path = String(epub["block_path"] ?? "");
  const element = block_path === "" ? null : AST.find_by_path(doc.root, block_path);
  if (element === null) return null;
  return { doc, mode, element, nodes: [] };
}

function write_ref_text(ref: ItemRef, text: string): void {
  const safe_text = AST.sanitize_xml_text(text);
  if (ref.mode === "text_run" && ref.element !== null && ref.nodes.length > 0) {
    const children = [...ref.element.children];
    const start = children.indexOf(ref.nodes[0] as ChildNode);
    const end = children.indexOf(ref.nodes[ref.nodes.length - 1] as ChildNode);
    if (start < 0 || end < start) {
      throw new AppError("remote.source_not_bindable", {
        public_details: { reason: "epub_structure_unsupported" },
      });
    }
    children.splice(start, end - start + 1, new Text(safe_text));
    AST.replace_element_children(ref.element, children);
  } else if (ref.element !== null) {
    AST.write_block_translation(ref.element, safe_text);
  }
  ref.doc.changed = true;
}

function remove_ref(ref: ItemRef): void {
  if (ref.element === null) return;
  if (ref.mode === "text_run" && ref.nodes.length > 0) {
    const parent = ref.element;
    const children = [...parent.children];
    const start = children.indexOf(ref.nodes[0] as ChildNode);
    const end = children.indexOf(ref.nodes[ref.nodes.length - 1] as ChildNode);
    if (start >= 0 && end >= start) {
      children.splice(start, end - start + 1);
      AST.replace_element_children(parent, children);
      ref.doc.changed = true;
    }
    return;
  }
  const parent = ref.element.parent;
  if (!(parent instanceof Element)) return;
  const children = [...parent.children];
  const index = children.indexOf(ref.element);
  if (index < 0) return;
  children.splice(index, 1);
  AST.replace_element_children(parent, children);
  ref.doc.changed = true;
}

function insert_block(
  doc: DocState,
  anchor: Element,
  text: string,
  heading: boolean,
  before: boolean,
): Element {
  const parent = anchor.parent;
  if (!(parent instanceof Element)) {
    throw new AppError("remote.source_not_bindable", {
      public_details: { reason: "epub_structure_unsupported" },
    });
  }
  const block = create_block(doc, text, heading);
  const children = [...parent.children];
  const index = children.indexOf(anchor);
  if (index < 0) {
    throw new AppError("remote.source_not_bindable", {
      public_details: { reason: "epub_structure_unsupported" },
    });
  }
  children.splice(before ? index : index + 1, 0, block);
  AST.replace_element_children(parent, children);
  doc.changed = true;
  return block;
}

function append_block(doc: DocState, text: string, heading: boolean): Element {
  const body = AST.find_descendants(doc.root, "body")[0] ?? null;
  if (body === null) {
    throw new AppError("remote.source_not_bindable", {
      public_details: { reason: "epub_structure_unsupported" },
    });
  }
  const block = create_block(doc, text, heading);
  AST.replace_element_children(body, [...body.children, block]);
  doc.changed = true;
  return block;
}

function create_block(doc: DocState, text: string, heading: boolean): Element {
  const template = find_block_template(doc.root, heading);
  const block =
    template === null ? new Element(heading ? "h1" : "p", {}, []) : AST.clone_element(template);
  for (const key of Object.keys(block.attribs)) {
    if (key === "id" || key === "name" || key.endsWith(":id")) delete block.attribs[key];
  }
  AST.replace_element_children_with_text(block, AST.sanitize_xml_text(text));
  return block;
}

function find_block_template(root: Element, heading: boolean): Element | null {
  for (const element of AST.flatten_elements(root)) {
    const name = AST.local_name(element.name);
    if (heading ? /^h[1-6]$/u.test(name) : name === "p") return element;
  }
  return null;
}

interface SpineRef {
  doc_path: string;
  element: Element;
}

function read_spine_refs(opf_root: Element, opf_dir: string): SpineRef[] {
  const manifest = AST.find_descendants(opf_root, "manifest")[0] ?? null;
  const spine = AST.find_descendants(opf_root, "spine")[0] ?? null;
  if (manifest === null || spine === null) return [];
  const path_by_id = new Map<string, string>();
  for (const item of AST.iter_children_elements(manifest)) {
    if (AST.local_name(item.name) !== "item") continue;
    const id = item.attribs["id"];
    const href = item.attribs["href"];
    if (id === undefined || href === undefined) continue;
    path_by_id.set(id, AST.resolve_href(opf_dir, href));
  }
  const refs: SpineRef[] = [];
  for (const itemref of AST.iter_children_elements(spine)) {
    if (AST.local_name(itemref.name) !== "itemref") continue;
    const idref = itemref.attribs["idref"];
    const doc_path = idref === undefined ? undefined : path_by_id.get(idref);
    if (doc_path !== undefined) refs.push({ doc_path, element: itemref });
  }
  return refs;
}

function set_spine_linear(spine: readonly SpineRef[], doc_path: string, linear: boolean): boolean {
  const entry = spine.find((candidate) => candidate.doc_path === doc_path);
  if (entry === undefined) {
    throw new AppError("remote.epub_document_conflict", {
      public_details: { reason: "spine_missing", doc_path },
    });
  }
  const current = entry.element.attribs["linear"];
  if (linear) {
    if (current === undefined) return false;
    delete entry.element.attribs["linear"];
    return true;
  }
  if (current === "no") return false;
  entry.element.attribs["linear"] = "no";
  return true;
}

function register_manifest_item(input: {
  opf_root: Element;
  opf_dir: string;
  doc_path: string;
  media_type: string;
  properties: string;
  after_doc_path: string | null;
  spine: readonly SpineRef[];
}): void {
  const manifest = AST.find_descendants(input.opf_root, "manifest")[0] ?? null;
  const spine_element = AST.find_descendants(input.opf_root, "spine")[0] ?? null;
  if (manifest === null || spine_element === null) {
    throw new AppError("remote.source_not_bindable", {
      public_details: { reason: "epub_structure_unsupported" },
    });
  }
  const items = AST.iter_children_elements(manifest).filter(
    (element) => AST.local_name(element.name) === "item",
  );
  const existing_ids = new Set(
    items
      .map((element) => element.attribs["id"])
      .filter((value): value is string => typeof value === "string"),
  );
  const base = read_merged_volume_prefix(input.doc_path) ?? "sync";
  let id = `${base}--sync`;
  let suffix = 1;
  while (existing_ids.has(id)) {
    suffix += 1;
    id = `${base}--sync-${suffix}`;
  }
  const item = new Element(
    "item",
    {
      id,
      href: posix.relative(input.opf_dir, input.doc_path),
      "media-type": input.media_type,
      ...(input.properties === "" ? {} : { properties: input.properties }),
    },
    [],
  );
  AST.replace_element_children(manifest, [...manifest.children, item]);

  const anchor =
    input.after_doc_path === null
      ? -1
      : input.spine.findIndex((entry) => entry.doc_path === input.after_doc_path);
  const children = [...spine_element.children];
  const insert_at =
    anchor >= 0
      ? children.indexOf(input.spine[anchor]!.element) + 1
      : children.findIndex(
          (child) => child instanceof Element && AST.local_name(child.name) === "itemref",
        );
  children.splice(
    insert_at < 0 ? children.length : insert_at,
    0,
    new Element("itemref", { idref: id }, []),
  );
  AST.replace_element_children(spine_element, children);
}

function build_nav_groups(map: RemoteEpubMap): WenkuEpubNavGroup[] {
  const groups: WenkuEpubNavGroup[] = [];
  for (const volume of map.volumes) {
    const entries = map.documents
      .filter((document) => document.volume_id === volume.volume_id && document.state === "active")
      .map((document) => ({ doc_path: document.doc_path, title: document.title }));
    if (entries.length === 0) continue;
    groups.push({ volume_title: volume.volume_title, entries });
  }
  return groups;
}

function read_opf_identifier(opf_root: Element): string {
  const metadata = AST.find_descendants(opf_root, "metadata")[0] ?? null;
  if (metadata === null) return "";
  for (const element of AST.iter_children_elements(metadata)) {
    if (AST.local_name(element.name) !== "identifier") continue;
    const text = AST.read_text_slot(element).trim();
    if (text !== "") return text;
  }
  return "";
}

async function replace_if_changed(
  file: JSZip.JSZipObject,
  next: string,
): Promise<string | Uint8Array> {
  const current = await file.async("uint8array");
  const encoded = new TextEncoder().encode(next);
  if (current.byteLength === encoded.byteLength) {
    let same = true;
    for (let index = 0; index < current.byteLength; index += 1) {
      if (current[index] !== encoded[index]) {
        same = false;
        break;
      }
    }
    if (same) return current;
  }
  return next;
}

function to_seed(item: Item): RemoteAssetItemSeed {
  return {
    src: item.src,
    extra_field: item.extra_field,
    tag: item.tag,
    file_type: item.file_type,
    row_number: item.row,
  };
}
