import { createHash } from "node:crypto";
import posix from "node:path/posix";

import JSZip from "jszip";
import { Element, Text } from "domhandler";

import { AppError } from "../../../shared/error/app-error";
import { EpubAst } from "./epub-ast";
import { EpubWriter } from "./epub-writer";
import { write_zip, type ZipContents } from "./epub-zip";

const AST = new EpubAst();
const SOURCE_WRITER = new EpubWriter({ target_language: "JA" });

const PACKAGE_DIRECTORY = "OEBPS";
const NAV_PATH = `${PACKAGE_DIRECTORY}/nav.xhtml`;
const NCX_PATH = `${PACKAGE_DIRECTORY}/toc.ncx`;
const XHTML_MEDIA_TYPES = new Set(["application/xhtml+xml", "text/html"]);

export interface EpubVolumeInput {
  /** 站点分卷标识（含 `.epub` 扩展名）；合并包路径前缀由它派生。 */
  volume_id: string;
  volume_title: string;
  bytes: Uint8Array;
}

export interface PreparedDocument<T> {
  /** 写进合并包的文档字节。 */
  bytes: Uint8Array;
  /** 章节业务数据；`null` 表示该文档不是站点章节，只随包复制。 */
  data: T | null;
}

export interface MergedEpubDocument<T> {
  volume_id: string;
  volume_index: number;
  volume_title: string;
  /** 分卷包内路径，用于还原站点 `chapterId`。 */
  source_doc_path: string;
  /** 合并包内路径，用于后续同步定位。 */
  doc_path: string;
  chapter_id: string;
  /** 文档第一个 `h1`~`h6`，缺失时用文件名。 */
  title: string;
  /** 源卷是否把它排进 spine；`false` 表示只在 manifest 出现，合并包标 `linear="no"`。 */
  linear: boolean;
  data: T;
}

/** 合并包内一个分卷的稳定前缀；同步据此把新章节放回原卷目录。 */
export interface MergedEpubVolume {
  volume_id: string;
  volume_title: string;
  prefix: string;
  has_ncx: boolean;
}

export interface MergedEpub<T> {
  bytes: Uint8Array;
  documents: MergedEpubDocument<T>[];
  volumes: MergedEpubVolume[];
}

/** 目录重建的输入：按卷分组的章节文档，卷序与文档序都由调用方决定。 */
export interface WenkuEpubNavGroup {
  volume_title: string;
  entries: ReadonlyArray<{ doc_path: string; title: string }>;
}

interface ManifestEntry {
  new_id: string;
  new_path: string;
  new_href: string;
  media_type: string;
  properties: string;
  /** 源卷内路径，用于把文档数据与清单条目对应起来。 */
  source_path: string;
  /** manifest 原始 href，站点 `chapterId` 依赖它而不是规范化路径。 */
  source_href: string;
}

interface RawManifestItem {
  id: string;
  source_href: string;
  source_path: string;
  media_type: string;
  properties: string;
}

interface VolumeLayout<T> {
  input: EpubVolumeInput;
  prefix: string;
  manifest: ManifestEntry[];
  /** 有序 spine：spine 中每个文档对应的新 itemref id。 */
  spine: string[];
  /** 只出现在 manifest、需要 `linear="no"` 的文档。 */
  manifest_only: string[];
  has_ncx: boolean;
  documents: MergedEpubDocument<T>[];
}

/**
 * 把站点分卷合并成一本可导入的 EPUB。
 *
 * 每个分卷整棵子树原样搬到 `OEBPS/vol-<key>/`，卷内相对链接继续成立；分卷自带的
 * `container.xml`、OPF、nav、NCX 丢弃，由合并包统一重建。spine 按「卷顺序 × 卷内
 * spine 顺序」排列，只在 manifest 里出现的文档也进 spine 并标 `linear="no"`，
 * 保证读取端能看到全部章节，同时不把它们当作顺序阅读内容。
 */
export async function merge_epub_volumes<T>(input: {
  title: string;
  volumes: readonly EpubVolumeInput[];
  /** 逐文档预处理；返回 `data: null` 表示该文档不是章节。 */
  read_document: (source_doc_path: string, raw: Uint8Array) => PreparedDocument<T>;
}): Promise<MergedEpub<T>> {
  if (input.volumes.length === 0) {
    throw new AppError("remote.workspace_empty", {
      diagnostic_context: { reason: "empty_volumes" },
    });
  }
  const contents: ZipContents = new Map();
  contents.set("mimetype", "application/epub+zip");
  contents.set("META-INF/container.xml", build_container_xml());

  const used_prefixes = new Set<string>();
  const layouts: VolumeLayout<T>[] = [];
  for (const [index, volume] of input.volumes.entries()) {
    layouts.push(
      await read_volume_layout(volume, index, used_prefixes, input.read_document, contents),
    );
  }

  const has_ncx = layouts.some((layout) => layout.has_ncx);
  const identifier = build_package_identifier(
    input.title,
    input.volumes.map((volume) => volume.volume_id),
  );
  const manifest = layouts.flatMap((layout) => layout.manifest);
  if (has_ncx) {
    manifest.push({
      new_id: "ncx",
      new_path: NCX_PATH,
      new_href: "toc.ncx",
      media_type: "application/x-dtbncx+xml",
      properties: "",
      source_path: "",
      source_href: "",
    });
  }
  manifest.push({
    new_id: "nav",
    new_path: NAV_PATH,
    new_href: "nav.xhtml",
    media_type: "application/xhtml+xml",
    properties: "nav",
    source_path: "",
    source_href: "",
  });

  contents.set(
    `${PACKAGE_DIRECTORY}/package.opf`,
    SOURCE_WRITER.serialize_document(
      `${PACKAGE_DIRECTORY}/package.opf`,
      build_package_opf({
        title: input.title,
        identifier,
        manifest,
        spine: layouts.flatMap((layout) => layout.spine),
        manifest_only: layouts.flatMap((layout) => layout.manifest_only),
        has_ncx,
      }),
    ),
  );
  contents.set(
    NAV_PATH,
    SOURCE_WRITER.serialize_document(
      NAV_PATH,
      build_wenku_nav(input.title, to_nav_groups(layouts)),
    ),
  );
  if (has_ncx) {
    contents.set(
      NCX_PATH,
      SOURCE_WRITER.serialize_document(
        NCX_PATH,
        build_wenku_ncx(input.title, identifier, to_nav_groups(layouts)),
      ),
    );
  }

  const bytes = new Uint8Array(await write_zip(contents));
  // 合并包必须能被读取端按同一套 OPF/spine 规则解析，否则导入后条目与资产对不上。
  await AST.read_from_stream(bytes, "merged.epub");
  return {
    bytes,
    documents: layouts.flatMap((layout) => layout.documents),
    volumes: layouts.map((layout) => ({
      volume_id: layout.input.volume_id,
      volume_title: layout.input.volume_title,
      prefix: layout.prefix,
      has_ncx: layout.has_ncx,
    })),
  };
}

/** 站点章节 id：`opfDir + "/" + href` 后把 `/` 换成 `.`，与站点解包结果一致。 */
export function build_wenku_chapter_id(opf_dir: string, href: string): string {
  return `${opf_dir}/${href}`.replace(/\//gu, ".");
}

/**
 * 合并包内一个分卷的稳定前缀；同步据此把新增章节放回原卷目录。
 * 详情见 `merge_epub_volumes` 的分卷布局契约。
 */
export function read_merged_volume_prefix(doc_path: string): string | null {
  const matched = /^OEBPS\/(vol-[^/]+)\//u.exec(doc_path);
  return matched?.[1] ?? null;
}

async function read_volume_layout<T>(
  volume: EpubVolumeInput,
  layout_index: number,
  used_prefixes: Set<string>,
  read_document: (source_doc_path: string, raw: Uint8Array) => PreparedDocument<T>,
  contents: ZipContents,
): Promise<VolumeLayout<T>> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(volume.bytes);
  } catch (cause) {
    throw new AppError("remote.epub_layout_unsupported", {
      cause,
      public_details: { volume_id: volume.volume_id, reason: "unreadable_volume" },
    });
  }
  const opf_path = await AST.parse_container_opf_path(zip);
  const opf_root = AST.parse_xml_document(await require_text(zip, opf_path));
  const pkg = await AST.parse_opf(zip, opf_path);
  const prefix = allocate_prefix(volume.volume_id, used_prefixes);
  const directory = `${PACKAGE_DIRECTORY}/${prefix}`;

  const items = read_manifest_items(opf_root, pkg.opf_dir).filter(
    (item) =>
      item.source_path !== pkg.nav_path &&
      item.source_path !== pkg.ncx_path &&
      zip.file(item.source_path) !== null,
  );
  const prepared = new Map<string, PreparedDocument<T>>();
  for (const item of items) {
    if (!XHTML_MEDIA_TYPES.has(item.media_type)) continue;
    const raw = await zip.file(item.source_path)!.async("uint8array");
    prepared.set(item.source_path, read_document(item.source_path, raw));
  }

  for (const file of Object.values(zip.files)) {
    if (file.dir) continue;
    const name = file.name;
    if (name === "mimetype" || name.startsWith("META-INF/")) continue;
    if (name === opf_path || name === pkg.nav_path || name === pkg.ncx_path) continue;
    const document = prepared.get(name);
    contents.set(
      `${directory}/${name}`,
      document === undefined ? await file.async("uint8array") : document.bytes,
    );
  }

  const manifest: ManifestEntry[] = items.map((item) => {
    const new_path = `${directory}/${item.source_path}`;
    return {
      new_id: `${prefix}--${item.id}`,
      new_path,
      new_href: posix.relative(PACKAGE_DIRECTORY, new_path),
      media_type: item.media_type,
      properties: item.properties,
      source_path: item.source_path,
      source_href: item.source_href,
    };
  });
  const entry_by_path = new Map(manifest.map((entry) => [entry.source_path, entry] as const));
  const spine_paths = new Set(pkg.spine_paths);
  const spine: string[] = [];
  for (const path of pkg.spine_paths) {
    const entry = entry_by_path.get(path);
    if (entry !== undefined) spine.push(entry.new_id);
  }
  const manifest_only = manifest
    .filter(
      (entry) => !spine_paths.has(entry.source_path) && XHTML_MEDIA_TYPES.has(entry.media_type),
    )
    .map((entry) => entry.new_id);

  const chapters_in_order: Array<ManifestEntry | undefined> = [
    ...pkg.spine_paths.map((path) => entry_by_path.get(path)),
    ...manifest.filter((entry) => !spine_paths.has(entry.source_path)),
  ];
  const documents: MergedEpubDocument<T>[] = [];
  const seen = new Set<string>();
  for (const entry of chapters_in_order) {
    if (entry === undefined || seen.has(entry.source_path)) continue;
    seen.add(entry.source_path);
    const document = prepared.get(entry.source_path);
    if (document === undefined || document.data === null) continue;
    documents.push(
      build_document(
        volume,
        layout_index,
        entry,
        pkg.opf_dir,
        document,
        spine_paths.has(entry.source_path),
      ),
    );
  }

  return {
    input: volume,
    prefix,
    manifest,
    spine,
    manifest_only,
    has_ncx: pkg.ncx_path !== null,
    documents,
  };
}

function build_document<T>(
  volume: EpubVolumeInput,
  layout_index: number,
  entry: ManifestEntry,
  opf_dir: string,
  prepared: PreparedDocument<T>,
  linear: boolean,
): MergedEpubDocument<T> {
  const heading = read_document_title(prepared.bytes);
  return {
    volume_id: volume.volume_id,
    volume_index: layout_index,
    volume_title: volume.volume_title,
    source_doc_path: entry.source_path,
    doc_path: entry.new_path,
    chapter_id: build_chapter_id(opf_dir, entry),
    title: heading === "" ? strip_extension(posix.basename(entry.source_path)) : heading,
    linear,
    data: prepared.data as T,
  };
}

/**
 * `chapterId` 取自源卷原始 `opfDir/href` 文本，不能用规范化后的路径：
 * 站点直接拼接 manifest 的 href，编码和 `..` 都原样保留。
 */
function build_chapter_id(opf_dir: string, entry: ManifestEntry): string {
  // `posix.dirname` 对根目录 OPF 返回 "."，站点用的是空串；两者拼接结果不同。
  return build_wenku_chapter_id(opf_dir === "." ? "" : opf_dir, entry.source_href);
}

function read_manifest_items(opf_root: Element, opf_dir: string): RawManifestItem[] {
  const manifest = AST.find_descendants(opf_root, "manifest")[0] ?? null;
  if (manifest === null) {
    throw new AppError("remote.epub_layout_unsupported", {
      public_details: { reason: "missing_manifest" },
    });
  }
  const items: RawManifestItem[] = [];
  for (const element of AST.iter_children_elements(manifest)) {
    if (AST.local_name(element.name) !== "item") continue;
    const id = element.attribs["id"];
    const href = element.attribs["href"];
    if (id === undefined || href === undefined || href === "") continue;
    items.push({
      id,
      source_href: href,
      source_path: AST.resolve_href(opf_dir, href),
      media_type: (element.attribs["media-type"] ?? "").toLowerCase(),
      properties: element.attribs["properties"] ?? "",
    });
  }
  return items;
}

function read_document_title(raw: Uint8Array): string {
  const root = AST.parse_xhtml_or_html(raw);
  for (const element of AST.flatten_elements(root)) {
    if (!/^h[1-6]$/u.test(AST.local_name(element.name))) continue;
    const text = AST.build_canonical_block_text(element).trim();
    if (text !== "") return text;
  }
  return "";
}

function build_package_opf(input: {
  title: string;
  identifier: string;
  manifest: readonly ManifestEntry[];
  spine: readonly string[];
  manifest_only: readonly string[];
  has_ncx: boolean;
}): Element {
  const metadata = new Element("metadata", { "xmlns:dc": "http://purl.org/dc/elements/1.1/" }, [
    new Element("dc:identifier", { id: "bookid" }, [new Text(input.identifier)]),
    new Element("dc:title", {}, [new Text(input.title)]),
    new Element("dc:language", {}, [new Text("ja")]),
  ]);
  const manifest = new Element(
    "manifest",
    {},
    input.manifest.map(
      (entry) =>
        new Element(
          "item",
          {
            id: entry.new_id,
            href: entry.new_href,
            "media-type": entry.media_type,
            ...(entry.properties === "" ? {} : { properties: entry.properties }),
          },
          [],
        ),
    ),
  );
  const spine = new Element("spine", input.has_ncx ? { toc: "ncx" } : {}, [
    ...input.spine.map((idref) => new Element("itemref", { idref }, [])),
    ...input.manifest_only.map((idref) => new Element("itemref", { idref, linear: "no" }, [])),
  ]);
  return new Element(
    "package",
    {
      xmlns: "http://www.idpf.org/2007/opf",
      version: "3.0",
      "unique-identifier": "bookid",
    },
    [metadata, manifest, spine],
  );
}

function to_nav_groups<T>(layouts: readonly VolumeLayout<T>[]): WenkuEpubNavGroup[] {
  return layouts.map((layout) => ({
    volume_title: layout.input.volume_title,
    entries: layout.documents.map((document) => ({
      doc_path: document.doc_path,
      title: document.title,
    })),
  }));
}

/** nav 与 NCX 共用同一份分组，合并与后续同步都能重建出相同结构。 */
export function build_wenku_nav(title: string, groups: readonly WenkuEpubNavGroup[]): Element {
  const body = new Element("body", {}, [
    new Element("nav", { "epub:type": "toc", id: "toc" }, [
      new Element("h1", {}, [new Text("目录")]),
      new Element(
        "ol",
        {},
        groups.map(
          (group) =>
            new Element("li", {}, [
              new Element("span", {}, [new Text(group.volume_title)]),
              new Element(
                "ol",
                {},
                group.entries.map(
                  (entry) =>
                    new Element("li", {}, [
                      new Element(
                        "a",
                        { href: posix.relative(PACKAGE_DIRECTORY, entry.doc_path) },
                        [new Text(entry.title)],
                      ),
                    ]),
                ),
              ),
            ]),
        ),
      ),
    ]),
  ]);
  return new Element(
    "html",
    {
      xmlns: "http://www.w3.org/1999/xhtml",
      "xmlns:epub": "http://www.idpf.org/2007/ops",
    },
    [new Element("head", {}, [new Element("title", {}, [new Text(title)])]), body],
  );
}

export function build_wenku_ncx(
  title: string,
  identifier: string,
  groups: readonly WenkuEpubNavGroup[],
): Element {
  let play_order = 0;
  const nav_map = new Element(
    "navMap",
    {},
    groups
      .filter((group) => group.entries.length > 0)
      .map((group, group_index) => {
        const first = group.entries[0]!;
        const volume_order = (play_order += 1);
        const children = group.entries.map((entry, index) => {
          const order = (play_order += 1);
          return new Element(
            "navPoint",
            { id: `sec-${group_index + 1}-c${index + 1}`, playOrder: String(order) },
            [
              new Element("navLabel", {}, [new Text(entry.title)]),
              new Element("content", { src: posix.relative(PACKAGE_DIRECTORY, entry.doc_path) }),
            ],
          );
        });
        return new Element(
          "navPoint",
          { id: `sec-${group_index + 1}-s`, playOrder: String(volume_order) },
          [
            new Element("navLabel", {}, [new Text(group.volume_title)]),
            new Element("content", { src: posix.relative(PACKAGE_DIRECTORY, first.doc_path) }),
            ...children,
          ],
        );
      }),
  );
  return new Element("ncx", { xmlns: "http://www.daisy.org/z3986/2005/ncx/", version: "2005-1" }, [
    new Element("head", {}, [new Element("meta", { name: "dtb:uid", content: identifier }, [])]),
    new Element("docTitle", {}, [new Text(title)]),
    nav_map,
  ]);
}

function build_container_xml(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${PACKAGE_DIRECTORY}/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
}

function build_package_identifier(title: string, volume_ids: readonly string[]): string {
  const digest = createHash("sha1")
    .update([title, ...volume_ids].join("\u0000"), "utf8")
    .digest("hex");
  return `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

function allocate_prefix(volume_id: string, used: Set<string>): string {
  const base = `vol-${sanitize_volume_key(volume_id)}`;
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

/** 分卷标识来自站点，直接当路径段前去掉路径分隔符与控制字符。 */
function sanitize_volume_key(volume_id: string): string {
  const unsafe = '\\/:*?"<>|';
  let key = "";
  for (const char of volume_id) {
    key += unsafe.includes(char) || (char.codePointAt(0) ?? 0) < 0x20 ? "_" : char;
  }
  return key;
}

function strip_extension(name: string): string {
  return name.replace(/\.[^.]+$/u, "");
}

async function require_text(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (file === null) {
    throw new AppError("file.invalid_structure", {
      public_details: { format: "EPUB", path },
      diagnostic_context: { entry: path, reason: "missing_opf" },
    });
  }
  return await file.async("string");
}
