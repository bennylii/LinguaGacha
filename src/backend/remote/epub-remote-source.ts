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
  type EpubSourceContext,
} from "../file/epub/epub-ast";
import { write_zip, type ZipContents } from "../file/epub/epub-zip";
import { EpubWriter } from "../file/epub/epub-writer";
import type { RemoteAlignmentPlan, RemoteAssetItemSeed, RemoteOldItem } from "./novelia-source";

export interface EpubRemoteSourceContext extends EpubSourceContext {
  text: string;
}

export interface EpubRemoteSourceAsset {
  bytes: Uint8Array;
  /** 与 `plan.rows` 一一对应，供内容服务复用译文并保留新 EPUB 的真实行号。 */
  content_seeds: RemoteAssetItemSeed[];
  /** OPF 标题、nav、NCX 等不参与正文对齐的条目。 */
  fixed_seeds: RemoteAssetItemSeed[];
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

const SOURCE_WRITER = new EpubWriter({ target_language: "JA" });
const AST = new EpubAst();

/** 读取 EPUB 并生成与远端行模型一致的规范正文。 */
export async function read_epub_remote_source(
  bytes: Uint8Array,
  rel_path: string,
): Promise<EpubRemoteSourceContext> {
  const context = await AST.read_source_context_from_stream(bytes, rel_path);
  return {
    ...context,
    text: context.lines.map((line) => line.text).join("\n"),
  };
}

/**
 * 按行计划把新原文写回 EPUB。
 * 未修改的块保持原 DOM；修改块只重写块内文本；新增/删除按块处理。
 */
export async function build_epub_remote_source(input: {
  bytes: Uint8Array;
  asset_path: string;
  plan: RemoteAlignmentPlan;
  old_items: readonly RemoteOldItem[];
}): Promise<EpubRemoteSourceAsset> {
  const zip = await JSZip.loadAsync(input.bytes);
  const opf_path = await AST.parse_container_opf_path(zip);
  const pkg = await AST.parse_opf(zip, opf_path);
  const opf_root = AST.parse_opf_xml(
    (await zip.file(opf_path)?.async("uint8array")) ?? new Uint8Array(),
  );
  const docs = new Map<string, DocState>();
  const refs = new Map<number, ItemRef>();
  let opf_changed = false;
  let remote_doc_index = 0;
  let previous_doc: DocState | null = null;

  const get_doc = async (doc_path: string): Promise<DocState | null> => {
    const existing = docs.get(doc_path);
    if (existing !== undefined) return existing;
    const raw = (await zip.file(doc_path)?.async("uint8array")) ?? null;
    if (raw === null) return null;
    const doc: DocState = {
      path: doc_path,
      root: AST.parse_xhtml_or_html(raw),
      changed: false,
    };
    docs.set(doc_path, doc);
    return doc;
  };

  for (const old_item of input.old_items) {
    const epub = read_epub_extra({ extra_field: old_item.extra_field } as Item);
    if (epub === null) continue;
    const doc_path = String(epub["doc_path"] ?? "");
    const doc = doc_path === "" ? null : await get_doc(doc_path);
    if (doc === null) continue;
    const mode = String(epub["mode"] ?? "");
    if (mode === "text_run") {
      const ref = read_epub_text_run(epub);
      if (ref === null) continue;
      const container = AST.find_by_path(doc.root, ref.container_path);
      if (container === null) continue;
      const nodes = container.children.slice(ref.start, ref.end);
      if (nodes.length === 0) continue;
      refs.set(old_item.item_id, { doc, mode, element: container, nodes });
      continue;
    }
    if (mode !== "slot_per_line" && mode !== "block_text") continue;
    const block_path = String(epub["block_path"] ?? "");
    const element = block_path === "" ? null : AST.find_by_path(doc.root, block_path);
    if (element === null) continue;
    refs.set(old_item.item_id, { doc, mode, element, nodes: [] });
  }

  const referenced = new Set<number>();
  let last_anchor: { doc: DocState; element: Element } | null = null;

  for (const [row_index, row] of input.plan.rows.entries()) {
    const heading = row.src.startsWith("# ");
    const text = (heading ? row.src.slice(2) : row.src).trim();
    if (row.old_item !== null) {
      referenced.add(row.old_item.item_id);
      const ref = refs.get(row.old_item.item_id);
      if (ref === undefined) {
        throw new AppError("remote.source_not_bindable", {
          public_details: { reason: "epub_structure_unsupported", row: row.row },
        });
      }
      if (row.old_item.src !== row.src) {
        write_ref_text(ref, text);
      }
      // text_run 不是独立块，不能作为新增块的锚点；后续新增行由下一个块定位。
      last_anchor =
        ref.mode === "text_run" || ref.element === null
          ? null
          : { doc: ref.doc, element: ref.element };
      previous_doc = ref.doc;
      continue;
    }

    if (heading) {
      const created = create_chapter_doc({
        title: text,
        heading: text,
        docs,
        opf_root,
        opf_dir: pkg.opf_dir,
        after_doc_path: previous_doc?.path ?? null,
        zip,
        nextIndex: () => (remote_doc_index += 1),
      });
      opf_changed = true;
      last_anchor = { doc: created.doc, element: created.heading };
      previous_doc = created.doc;
      continue;
    }
    if (last_anchor === null) {
      const next = find_next_block(row_index, row.chapter_index);
      if (next === null) {
        throw new AppError("remote.source_not_bindable", {
          public_details: { reason: "epub_structure_unsupported", row: row.row },
        });
      }
      const block = insert_block(next.doc, next.element, text, false, true);
      last_anchor = { doc: next.doc, element: block };
      previous_doc = next.doc;
      continue;
    }
    const block = insert_block(last_anchor.doc, last_anchor.element, text, false);
    last_anchor = { doc: last_anchor.doc, element: block };
    previous_doc = last_anchor.doc;
  }

  function find_next_block(
    row_index: number,
    chapter_index: number,
  ): { doc: DocState; element: Element } | null {
    for (const candidate of input.plan.rows.slice(row_index + 1)) {
      if (candidate.chapter_index !== chapter_index) return null;
      if (candidate.old_item === null) continue;
      const ref = refs.get(candidate.old_item.item_id);
      // 下一行仍是 text_run 时无法判断应插在它之前还是之后，拒绝结构改动。
      if (ref !== undefined && ref.mode === "text_run") return null;
      if (ref !== undefined && ref.element !== null) {
        return { doc: ref.doc, element: ref.element };
      }
    }
    return null;
  }

  for (const old_item of input.old_items) {
    if (referenced.has(old_item.item_id)) continue;
    const ref = refs.get(old_item.item_id);
    if (ref !== undefined) remove_ref(ref);
  }

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
    const doc = docs.get(name);
    output.set(
      name,
      doc?.changed === true
        ? SOURCE_WRITER.serialize_document(name, doc.root)
        : await file.async("uint8array"),
    );
  }
  for (const doc of docs.values()) {
    if (!output.has(doc.path)) {
      output.set(doc.path, SOURCE_WRITER.serialize_document(doc.path, doc.root));
    }
  }
  const bytes = await write_zip(output);
  const reparsed = await read_epub_remote_source(bytes, input.asset_path);
  const expected = input.plan.rows.map((row) => row.src).join("\n");
  if (reparsed.text !== expected) {
    throw new AppError("remote.source_not_bindable", {
      public_details: { reason: "epub_sync_mismatch" },
    });
  }
  return {
    bytes,
    content_seeds: reparsed.lines.map((line) => to_seed(line.item)),
    fixed_seeds: reparsed.items.filter((item) => !is_epub_content_item(item)).map(to_seed),
  };

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
    before = false,
  ): Element {
    const parent = anchor.parent;
    if (!(parent instanceof Element)) {
      throw new AppError("remote.source_not_bindable", {
        public_details: { reason: "epub_structure_unsupported" },
      });
    }
    const template = find_block_template(doc.root, heading);
    const block =
      template === null ? new Element(heading ? "h1" : "p", {}, []) : AST.clone_element(template);
    for (const key of Object.keys(block.attribs)) {
      if (key === "id" || key === "name" || key.endsWith(":id")) delete block.attribs[key];
    }
    AST.replace_element_children_with_text(block, AST.sanitize_xml_text(text));
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
}

function find_block_template(root: Element, heading: boolean): Element | null {
  for (const element of AST.flatten_elements(root)) {
    const name = AST.local_name(element.name);
    if (heading ? /^h[1-6]$/u.test(name) : name === "p") return element;
  }
  return null;
}

function create_chapter_doc(input: {
  title: string;
  heading: string;
  docs: Map<string, DocState>;
  opf_root: Element;
  opf_dir: string;
  /** 新章节在 spine 中紧跟在上一行所在文档之后；null 表示插入开头。 */
  after_doc_path: string | null;
  zip: JSZip;
  nextIndex: () => number;
}): { doc: DocState; heading: Element } {
  const template_doc = [...input.docs.values()].find(
    (doc) => AST.find_descendants(doc.root, "body").length > 0,
  );
  const root =
    template_doc === undefined
      ? new Element("html", { xmlns: "http://www.w3.org/1999/xhtml" }, [])
      : AST.clone_element(template_doc.root);
  let head = AST.find_descendants(root, "head")[0] ?? null;
  if (head === null) {
    head = new Element("head", {}, []);
    AST.replace_element_children(root, [head, ...root.children]);
  }
  const title = AST.find_descendants(head, "title")[0] ?? null;
  if (title === null) {
    AST.replace_element_children(head, [
      ...head.children,
      new Element("title", {}, [new Text(AST.sanitize_xml_text(input.title))]),
    ]);
  } else {
    AST.replace_element_children_with_text(title, AST.sanitize_xml_text(input.title));
  }
  let body = AST.find_descendants(root, "body")[0] ?? null;
  if (body === null) {
    body = new Element("body", {}, []);
    AST.replace_element_children(root, [...root.children, body]);
  }
  const heading = new Element("h1", {}, [new Text(AST.sanitize_xml_text(input.heading))]);
  AST.replace_element_children(body, [heading]);
  // 新文档放在模板同目录，复制 head 里的相对 CSS/字体链接才继续成立。
  const doc_dir = template_doc === undefined ? input.opf_dir : posix.dirname(template_doc.path);
  let index = input.nextIndex();
  let doc_path = posix.join(doc_dir, `remote-sync-${index}.xhtml`);
  while (input.docs.has(doc_path) || input.zip.file(doc_path) !== null) {
    index = input.nextIndex();
    doc_path = posix.join(doc_dir, `remote-sync-${index}.xhtml`);
  }
  const doc: DocState = { path: doc_path, root, changed: true };
  input.docs.set(doc_path, doc);
  register_new_doc(input.opf_root, input.opf_dir, doc_path, index, input.after_doc_path);
  return { doc, heading };
}

function register_new_doc(
  opf_root: Element,
  opf_dir: string,
  doc_path: string,
  index: number,
  after_doc_path: string | null,
): void {
  const manifest = AST.find_descendants(opf_root, "manifest")[0] ?? null;
  const spine = AST.find_descendants(opf_root, "spine")[0] ?? null;
  if (manifest === null || spine === null) {
    throw new AppError("remote.source_not_bindable", {
      public_details: { reason: "epub_structure_unsupported" },
    });
  }
  const manifest_items = AST.find_descendants(manifest, "item");
  const existing_ids = new Set(
    manifest_items
      .map((item) => item.attribs["id"])
      .filter((value): value is string => typeof value === "string"),
  );
  let id = `remote-sync-${index}`;
  while (existing_ids.has(id)) id = `${id}-x`;
  const href = posix.relative(opf_dir, doc_path);
  const manifest_prefix = manifest.name.includes(":")
    ? manifest.name.slice(0, manifest.name.indexOf(":") + 1)
    : "";
  const spine_prefix = spine.name.includes(":")
    ? spine.name.slice(0, spine.name.indexOf(":") + 1)
    : "";
  const item = new Element(
    `${manifest_prefix}item`,
    { id, href, "media-type": "application/xhtml+xml" },
    [],
  );
  const itemref = new Element(`${spine_prefix}itemref`, { idref: id }, []);
  AST.replace_element_children(manifest, [...manifest.children, item]);

  const path_by_id = new Map<string, string>();
  for (const entry of manifest_items) {
    const entry_id = entry.attribs["id"];
    const entry_href = entry.attribs["href"];
    if (entry_id !== undefined && entry_href !== undefined) {
      path_by_id.set(entry_id, AST.resolve_href(opf_dir, entry_href));
    }
  }
  const spine_children = [...spine.children];
  let insert_at = spine_children.length;
  if (after_doc_path === null) {
    const first = spine_children.findIndex(
      (child) => child instanceof Element && AST.local_name(child.name) === "itemref",
    );
    if (first >= 0) insert_at = first;
  } else {
    const anchor = spine_children.findIndex((child) => {
      if (!(child instanceof Element) || AST.local_name(child.name) !== "itemref") return false;
      const idref = child.attribs["idref"];
      return idref !== undefined && path_by_id.get(idref) === after_doc_path;
    });
    if (anchor < 0) {
      throw new AppError("remote.source_not_bindable", {
        public_details: { reason: "epub_structure_unsupported" },
      });
    }
    insert_at = anchor + 1;
  }
  spine_children.splice(insert_at, 0, itemref);
  AST.replace_element_children(spine, spine_children);
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
