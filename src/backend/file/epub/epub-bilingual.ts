import { Element, isTag } from "domhandler";

import { AppError } from "../../../shared/error/app-error";
import { EpubAst } from "./epub-ast";
import { EpubWriter } from "./epub-writer";

const AST = new EpubAst();
const DOCUMENT_WRITER = new EpubWriter({ target_language: "JA" });

/**
 * 站点 `mode=jp-zh` 导出把日文段的 style 整段覆写成这个标记，中文段紧跟其后插入。
 * 只认整段 style，避免把作品自带的半透明段落误判为双语标记。
 */
const BILINGUAL_DIM_STYLE_PATTERN = /^opacity\s*:\s*0?\.4\s*;?$/iu;

export interface BilingualParagraph {
  jp: string;
  zh: string | null; // 站点该段没有中文译文时为 null
}

export interface BilingualDocumentSplit {
  /** 去掉站点插入的中文段并还原日文段样式后的文档字节。 */
  bytes: Uint8Array;
  /** 文档内非空 body 段落的日文与中文，顺序即文档顺序。 */
  paragraphs: BilingualParagraph[];
  /** 与 `bytes` 对应的日文 DOM，供调用方按 `block_path` 定位段落。 */
  root: Element;
}

/**
 * 把站点双语导出的章节文档还原为日文原文，同时取出与段落同序的中文译文。
 *
 * 站点只在整章有译文时改写该章：所有非空段落都变暗，并在其后紧接一个中文段。
 * 配对只看「变暗 + 紧邻的下一个段落」，因此空译文段也能正确剥除；剥除后若仍有
 * 未变暗的非空段落，说明该章布局不符合导出契约，宁可拒绝也不猜测哪段是译文。
 */
export function split_bilingual_document(
  raw: Uint8Array,
  doc_path: string,
): BilingualDocumentSplit {
  const root = AST.parse_xhtml_or_html(raw);
  const body = AST.find_descendants(root, "body")[0] ?? null;
  if (body === null) return { bytes: raw, paragraphs: [], root };

  const dimmed = AST.find_descendants(body, "p").filter(is_dimmed_block);
  if (dimmed.length === 0) {
    return {
      bytes: raw,
      root,
      paragraphs: AST.find_descendants(body, "p")
        .map(read_paragraph_text)
        .filter((text) => text !== "")
        .map((jp) => ({ jp, zh: null })),
    };
  }

  const paragraphs: BilingualParagraph[] = [];
  const inserted: Element[] = [];
  for (const source of dimmed) {
    const translation = next_element_sibling(source);
    if (
      translation === null ||
      AST.local_name(translation.name) !== "p" ||
      is_dimmed_block(translation)
    ) {
      throw_bilingual_layout_error(doc_path, { reason: "pairing" });
    }
    const zh = read_paragraph_text(translation);
    paragraphs.push({ jp: read_paragraph_text(source), zh: zh === "" ? null : zh });
    delete source.attribs["style"];
    inserted.push(translation);
  }
  for (const block of inserted) {
    const parent = block.parent;
    if (!(parent instanceof Element)) continue;
    AST.replace_element_children(
      parent,
      parent.children.filter((child) => child !== block),
    );
  }

  const sources = new Set(dimmed);
  const leftover = AST.find_descendants(body, "p").filter(
    (block) => !sources.has(block) && read_paragraph_text(block) !== "",
  );
  if (leftover.length > 0) {
    throw_bilingual_layout_error(doc_path, {
      reason: "mixed_document",
      paragraphs: paragraphs.length,
      untranslated: leftover.length,
    });
  }
  return {
    bytes: new TextEncoder().encode(DOCUMENT_WRITER.serialize_document(doc_path, root)),
    paragraphs,
    root,
  };
}

function read_paragraph_text(block: Element): string {
  return AST.build_canonical_block_text(block).trim();
}

function is_dimmed_block(block: Element): boolean {
  const style = block.attribs["style"];
  return typeof style === "string" && BILINGUAL_DIM_STYLE_PATTERN.test(style.trim());
}

/** 同一父节点下紧随其后的元素，中间只跳过文本节点。 */
function next_element_sibling(source: Element): Element | null {
  const parent = source.parent;
  if (parent === null) return null;
  let seen = false;
  for (const child of parent.children) {
    if (child === source) {
      seen = true;
      continue;
    }
    if (!seen || !isTag(child)) continue;
    return child;
  }
  return null;
}

function throw_bilingual_layout_error(doc_path: string, details: Record<string, unknown>): never {
  throw new AppError("remote.epub_layout_unsupported", {
    public_details: { doc_path, ...details },
    diagnostic_context: { reason: "bilingual_layout", doc_path },
  });
}
