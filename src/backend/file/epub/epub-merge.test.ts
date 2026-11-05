import path from "node:path/posix";

import { describe, expect, it } from "vitest";

import { read_zip_fixture, write_zip, zip_text } from "../../../test/zip-fixture";
import { build_wenku_chapter_id, merge_epub_volumes } from "./epub-merge";

interface VolumeDocument {
  href: string;
  title: string;
  in_spine?: boolean;
}

async function create_volume(input: {
  opf_path: string;
  documents: VolumeDocument[];
  with_ncx?: boolean;
}): Promise<Uint8Array> {
  const opf_dir = path.dirname(input.opf_path);
  const zip = new Map<string, string | Uint8Array>();
  zip.set(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${input.opf_path}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  const manifest = input.documents
    .map(
      (document, index) =>
        `<item id="d${index + 1}" href="${document.href}" media-type="application/xhtml+xml"/>`,
    )
    .join("\n    ");
  const spine = input.documents
    .map((document, index) =>
      document.in_spine === false ? "" : `<itemref idref="d${index + 1}"/>`,
    )
    .filter((entry) => entry !== "")
    .join("\n    ");
  zip.set(
    input.opf_path,
    `<?xml version="1.0" encoding="utf-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf">
  <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">卷</dc:title></metadata>
  <manifest>
    ${manifest}
    <item id="css" href="style.css" media-type="text/css"/>
    ${input.with_ncx === true ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : ""}
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine${input.with_ncx === true ? ' toc="ncx"' : ""}>
    ${spine}
  </spine>
</package>`,
  );
  zip.set(path.join(opf_dir, "style.css"), "p { margin: 0; }");
  zip.set(
    path.join(opf_dir, "nav.xhtml"),
    `<html xmlns="http://www.w3.org/1999/xhtml"><body><nav>源目录</nav></body></html>`,
  );
  if (input.with_ncx === true) {
    zip.set(
      path.join(opf_dir, "toc.ncx"),
      `<?xml version="1.0"?><ncx version="2005-1"><navMap><navPoint id="n1"><navLabel><text>源章节</text></navLabel><content src="${input.documents[0]?.href ?? "x"}"/></navPoint></navMap></ncx>`,
    );
  }
  for (const document of input.documents) {
    zip.set(
      path.join(opf_dir, document.href),
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${document.title}</title></head><body><h1>${document.title}</h1><p>${document.title}正文</p></body></html>`,
    );
  }
  return write_zip(zip);
}

function read_document(
  source_doc_path: string,
  raw: Uint8Array,
): {
  bytes: Uint8Array;
  data: { source_doc_path: string } | null;
} {
  const text = new TextDecoder().decode(raw);
  return {
    bytes: raw,
    data: text.includes("<p>") ? { source_doc_path } : null,
  };
}

describe("merge_epub_volumes", () => {
  it("按卷序合并整棵子树并重建 package/spine", async () => {
    const first = await create_volume({
      opf_path: "OEBPS/content.opf",
      documents: [
        { href: "Text/a.xhtml", title: "第一章" },
        { href: "Text/b.xhtml", title: "第二章" },
      ],
    });
    const second = await create_volume({
      opf_path: "OPS/package.opf",
      documents: [{ href: "chapter.xhtml", title: "第三章" }],
    });

    const merged = await merge_epub_volumes({
      title: "テスト小説",
      volumes: [
        { volume_id: "v1.epub", volume_title: "第一卷", bytes: first },
        { volume_id: "v2.epub", volume_title: "第二卷", bytes: second },
      ],
      read_document,
    });

    expect(merged.documents.map((document) => document.chapter_id)).toEqual([
      "OEBPS.Text.a.xhtml",
      "OEBPS.Text.b.xhtml",
      "OPS.chapter.xhtml",
    ]);
    expect(merged.documents.map((document) => document.volume_index)).toEqual([0, 0, 1]);
    expect(merged.documents.map((document) => document.doc_path)).toEqual([
      "OEBPS/vol-v1.epub/OEBPS/Text/a.xhtml",
      "OEBPS/vol-v1.epub/OEBPS/Text/b.xhtml",
      "OEBPS/vol-v2.epub/OPS/chapter.xhtml",
    ]);
    expect(merged.documents.map((document) => document.title)).toEqual([
      "第一章",
      "第二章",
      "第三章",
    ]);

    const zip = await read_zip_fixture(merged.bytes);
    expect(zip.has("mimetype")).toBe(true);
    expect(zip.has("META-INF/container.xml")).toBe(true);
    expect(zip.has("OEBPS/vol-v1.epub/OEBPS/content.opf")).toBe(false);
    expect(zip.has("OEBPS/vol-v1.epub/OEBPS/nav.xhtml")).toBe(false);
    expect(zip.has("OEBPS/vol-v1.epub/OEBPS/style.css")).toBe(true);
    expect(zip.has("OEBPS/vol-v2.epub/OPS/package.opf")).toBe(false);
    expect(zip.has("OEBPS/toc.ncx")).toBe(false);

    const opf = zip_text(zip, "OEBPS/package.opf");
    expect(opf.indexOf("vol-v1.epub/OEBPS/Text/a.xhtml")).toBeLessThan(
      opf.indexOf("vol-v1.epub/OEBPS/Text/b.xhtml"),
    );
    expect(opf.indexOf("vol-v1.epub/OEBPS/Text/b.xhtml")).toBeLessThan(
      opf.indexOf("vol-v2.epub/OPS/chapter.xhtml"),
    );
    const nav = zip_text(zip, "OEBPS/nav.xhtml");
    expect(nav).toContain("第一卷");
    expect(nav).toContain("vol-v2.epub/OPS/chapter.xhtml");
  });

  it("manifest 独有文档进入 spine 并标 linear=no，源卷有 NCX 时重建 NCX", async () => {
    const volume = await create_volume({
      opf_path: "OEBPS/content.opf",
      with_ncx: true,
      documents: [
        { href: "Text/a.xhtml", title: "第一章" },
        { href: "Text/extra.xhtml", title: "番外", in_spine: false },
      ],
    });

    const merged = await merge_epub_volumes({
      title: "テスト小説",
      volumes: [{ volume_id: "v1.epub", volume_title: "第一卷", bytes: volume }],
      read_document,
    });

    expect(merged.documents.map((document) => document.title)).toEqual(["第一章", "番外"]);
    const zip = await read_zip_fixture(merged.bytes);
    const opf = zip_text(zip, "OEBPS/package.opf");
    expect(opf).toMatch(/<itemref idref="vol-v1\.epub--d2" linear="no"\/>/u);
    const ncx = zip_text(zip, "OEBPS/toc.ncx");
    expect(ncx).toContain("番外");
    expect(ncx).toContain("vol-v1.epub/OEBPS/Text/extra.xhtml");
  });

  it("根目录 OPF 的章节 id 保留前导点", async () => {
    const volume = await create_volume({
      opf_path: "content.opf",
      documents: [{ href: "Text/a.xhtml", title: "第一章" }],
    });

    const merged = await merge_epub_volumes({
      title: "テスト小説",
      volumes: [{ volume_id: "root.epub", volume_title: "第一卷", bytes: volume }],
      read_document,
    });

    expect(merged.documents[0]?.chapter_id).toBe(".Text.a.xhtml");
    expect(merged.documents[0]?.doc_path).toBe("OEBPS/vol-root.epub/Text/a.xhtml");
    expect(build_wenku_chapter_id("", "chapter.xhtml")).toBe(".chapter.xhtml");
  });

  it("前缀由分卷标识决定，与传入顺序无关", async () => {
    const first = await create_volume({
      opf_path: "OEBPS/content.opf",
      documents: [{ href: "Text/a.xhtml", title: "第一章" }],
    });
    const second = await create_volume({
      opf_path: "OEBPS/content.opf",
      documents: [{ href: "Text/b.xhtml", title: "第二章" }],
    });

    const merged = await merge_epub_volumes({
      title: "テスト小説",
      volumes: [
        { volume_id: "v2.epub", volume_title: "第二卷", bytes: second },
        { volume_id: "v1.epub", volume_title: "第一卷", bytes: first },
      ],
      read_document,
    });

    expect(merged.documents.map((document) => document.doc_path)).toEqual([
      "OEBPS/vol-v2.epub/OEBPS/Text/b.xhtml",
      "OEBPS/vol-v1.epub/OEBPS/Text/a.xhtml",
    ]);
  });
});
