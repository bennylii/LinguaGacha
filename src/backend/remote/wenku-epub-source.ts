import type { Element } from "domhandler";

import type { Item } from "../../domain/item";
import { AppError } from "../../shared/error/app-error";
import { EpubAst, is_epub_content_item, read_epub_extra } from "../file/epub/epub-ast";
import { split_bilingual_document, type BilingualParagraph } from "../file/epub/epub-bilingual";
import {
  merge_epub_volumes,
  type MergedEpubDocument,
  type MergedEpubVolume,
} from "../file/epub/epub-merge";
import { read_epub_remote_source } from "./epub-remote-source";
import type { NoveliaClient, RemoteNovelMetadata } from "./novelia-client";
import { build_novel_filename, REMOTE_EPUB_MAX_BYTES, type RemoteNovelRef } from "./novelia-source";
import { build_remote_epub_map, type RemoteEpubMap } from "./remote-source";

const AST = new EpubAst();

export type WenkuVolumeFormat = "epub" | "txt";

/** 章节文档的切分结果：段落原文/译文与对应的日文 DOM。 */
export interface WenkuEpubDocumentData {
  paragraphs: BilingualParagraph[];
  root: Element;
}

export interface WenkuEpubPackage {
  bytes: Uint8Array;
  filename: string;
  documents: MergedEpubDocument<WenkuEpubDocumentData>[];
  volumes: MergedEpubVolume[];
}

export interface WenkuEpubImport extends WenkuEpubPackage {
  /** 与合并资产一致的规范正文，用于快照与后续同步基准。 */
  text: string;
  /** 站点 GPT 译文，键为合并资产中 `<p>` 条目的行号。 */
  translations: ReadonlyMap<number, string>;
  chapter_count: number;
  /** 段落无法与工程条目一一对应的文档数；这些文档不播种译文。 */
  mismatched_documents: number;
  /** 章节身份映射，随工程 meta 持久化，供后续同步与工作区上传使用。 */
  map: RemoteEpubMap;
}

/**
 * 分卷下载格式由 `volumeId` 扩展名决定；站点只接受 `.txt`/`.epub` 两种。
 */
export function read_wenku_volume_formats(metadata: RemoteNovelMetadata): WenkuVolumeFormat[] {
  return metadata.volumes.map((volume) =>
    volume.volume_id.toLowerCase().endsWith(".epub") ? "epub" : "txt",
  );
}

/**
 * 整本 EPUB 与 TXT 的段落口径不同，混用时既无法合并也无法按同一行模型同步。
 * 这里只做判定，是否走 EPUB 分支由调用方决定。
 */
export function assert_wenku_volumes_bindable(metadata: RemoteNovelMetadata): WenkuVolumeFormat[] {
  const formats = read_wenku_volume_formats(metadata);
  if (formats.length === 0) {
    throw new AppError("remote.workspace_empty", {
      diagnostic_context: { reason: "no_volumes" },
    });
  }
  if (formats.includes("epub") && formats.includes("txt")) {
    throw new AppError("remote.wenku_mixed_volumes", {
      public_details: {
        volumes: metadata.volumes.map((volume, index) => ({
          volume_id: volume.volume_id,
          format: formats[index] ?? "txt",
        })),
      },
    });
  }
  return formats;
}

export function build_wenku_epub_filename(title: string): string {
  return build_novel_filename(title).replace(/\.txt$/u, ".epub");
}

/**
 * 下载全部分卷、还原日文原文并合并成一本 EPUB。
 * 导入与同步都从这里得到「远端合并包」，保证两端使用同一套分卷布局。
 */
export async function build_wenku_epub_package(input: {
  ref: RemoteNovelRef;
  metadata: RemoteNovelMetadata;
  client: Pick<NoveliaClient, "download_wenku_volume_epub">;
  signal?: AbortSignal;
}): Promise<WenkuEpubPackage> {
  const volumes: Array<{ volume_id: string; volume_title: string; bytes: Uint8Array }> = [];
  let total_bytes = 0;
  for (const volume of input.metadata.volumes) {
    const bytes = await input.client.download_wenku_volume_epub(
      input.ref,
      volume.volume_id,
      input.signal,
    );
    total_bytes += bytes.byteLength;
    if (total_bytes > REMOTE_EPUB_MAX_BYTES) {
      throw new AppError("remote.fetch_failed", {
        message: "The downloaded novel exceeds the size limit.",
        public_details: { max_bytes: REMOTE_EPUB_MAX_BYTES },
      });
    }
    volumes.push({ volume_id: volume.volume_id, volume_title: volume.title, bytes });
  }

  const merged = await merge_epub_volumes<WenkuEpubDocumentData>({
    title: input.metadata.title,
    volumes,
    read_document: (source_doc_path, raw) => {
      const split = split_bilingual_document(raw, source_doc_path);
      return {
        bytes: split.bytes,
        data:
          split.paragraphs.length === 0 ? null : { paragraphs: split.paragraphs, root: split.root },
      };
    },
  });
  return {
    bytes: merged.bytes,
    filename: build_wenku_epub_filename(input.metadata.title),
    documents: merged.documents,
    volumes: merged.volumes,
  };
}

/** 章节映射由合并结果一次生成；之后只在同步应用时更新状态与新增章节。 */
export function build_wenku_epub_map(pkg: WenkuEpubPackage): RemoteEpubMap {
  return build_remote_epub_map({
    volumes: pkg.volumes.map((volume) => ({
      volume_id: volume.volume_id,
      volume_title: volume.volume_title,
      prefix: volume.prefix,
    })),
    documents: pkg.documents.map((document) => ({
      chapter_id: document.chapter_id,
      volume_id: document.volume_id,
      source_doc_path: document.source_doc_path,
      doc_path: document.doc_path,
      title: document.title,
      linear: document.linear,
      state: "active",
    })),
  });
}

/**
 * 下载全部分卷、还原日文原文并合并成一本 EPUB，同时把站点已有译文映射到条目行号。
 * 行号来自合并资产重新解析的结果，因此与导入管线写入工程的行号一致。
 */
export async function build_wenku_epub_import(input: {
  ref: RemoteNovelRef;
  metadata: RemoteNovelMetadata;
  client: Pick<NoveliaClient, "download_wenku_volume_epub">;
  include_translations: boolean;
  signal?: AbortSignal;
}): Promise<WenkuEpubImport> {
  const pkg = await build_wenku_epub_package({
    ref: input.ref,
    metadata: input.metadata,
    client: input.client,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const source = await read_epub_remote_source(pkg.bytes, pkg.filename);
  const projected = project_document_translations({
    documents: pkg.documents,
    items: source.items,
    include_translations: input.include_translations,
  });
  return {
    ...pkg,
    text: source.text,
    translations: projected.translations,
    chapter_count: pkg.documents.length,
    mismatched_documents: projected.mismatched,
    map: build_wenku_epub_map(pkg),
  };
}

/**
 * 站点段落与工程条目是两套单位：这里只接受「body 内非空 `<p>` 按文档顺序」的结构投影。
 * 数量或文本对不上时放弃该文档的译文，避免把中文写进错误的行。
 */
export function project_document_translations(input: {
  documents: readonly MergedEpubDocument<WenkuEpubDocumentData>[];
  items: readonly Item[];
  include_translations: boolean;
}): { translations: Map<number, string>; mismatched: number } {
  const items_by_document = new Map<string, Item[]>();
  for (const item of input.items) {
    if (!is_epub_content_item(item)) continue;
    const epub = read_epub_extra(item);
    const doc_path = String(epub?.["doc_path"] ?? "");
    if (doc_path === "") continue;
    const bucket = items_by_document.get(doc_path);
    if (bucket === undefined) items_by_document.set(doc_path, [item]);
    else bucket.push(item);
  }

  const translations = new Map<number, string>();
  let mismatched = 0;
  for (const document of input.documents) {
    const paragraphs = document.data.paragraphs;
    const rows = list_document_paragraph_rows(
      items_by_document.get(document.doc_path) ?? [],
      document.data.root,
    );
    if (
      rows.length !== paragraphs.length ||
      rows.some((row, index) => row.text !== paragraphs[index]!.jp)
    ) {
      mismatched += 1;
      continue;
    }
    if (!input.include_translations) continue;
    for (const [index, paragraph] of paragraphs.entries()) {
      const zh = paragraph.zh;
      if (zh === null || zh.trim() === "") continue;
      translations.set(rows[index]!.row, zh);
    }
  }
  return { translations, mismatched };
}

/**
 * 站点段落只认「body 内非空 `<p>`」；工作区上传也按同一顺序取工程的段落条目。
 * 返回值顺序即站点 `paragraphJp` 顺序，行号用于定位条目。
 */
export function list_document_paragraph_rows(
  items: readonly Item[],
  root: Element,
): Array<{ row: number; text: string }> {
  const rows: Array<{ row: number; text: string }> = [];
  for (const item of items) {
    const epub = read_epub_extra(item);
    if (epub === null) continue;
    const mode = String(epub["mode"] ?? "");
    if (mode !== "block_text" && mode !== "slot_per_line") continue;
    const block_path = String(epub["block_path"] ?? "");
    const element = block_path === "" ? null : AST.find_by_path(root, block_path);
    if (element === null || AST.local_name(element.name) !== "p") continue;
    const text = AST.build_canonical_block_text(element).trim();
    if (text === "") continue;
    rows.push({ row: item.row, text });
  }
  return rows;
}
