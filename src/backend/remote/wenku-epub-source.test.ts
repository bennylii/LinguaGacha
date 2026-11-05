import { describe, expect, it, vi } from "vitest";

import { write_zip } from "../../test/zip-fixture";
import { read_epub_remote_source } from "./epub-remote-source";
import type { RemoteNovelMetadata } from "./novelia-client";
import { parse_novel_url } from "./novelia-source";
import {
  assert_wenku_volumes_bindable,
  build_wenku_epub_import,
  read_wenku_volume_formats,
} from "./wenku-epub-source";

const REF = parse_novel_url("https://n.novelia.cc/wenku/12345");

async function create_volume(input: {
  volume_id: string;
  documents: Array<{ href: string; body: string }>;
}): Promise<Uint8Array> {
  const zip = new Map<string, string | Uint8Array>();
  zip.set(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  zip.set(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf">
  <metadata/>
  <manifest>
    ${input.documents
      .map(
        (document, index) =>
          `<item id="d${index + 1}" href="${document.href}" media-type="application/xhtml+xml"/>`,
      )
      .join("\n    ")}
  </manifest>
  <spine>
    ${input.documents.map((_, index) => `<itemref idref="d${index + 1}"/>`).join("\n    ")}
  </spine>
</package>`,
  );
  for (const document of input.documents) {
    zip.set(
      `OEBPS/${document.href}`,
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>章</title></head><body>${document.body}</body></html>`,
    );
  }
  return write_zip(zip);
}

function metadata(volume_ids: string[]): RemoteNovelMetadata {
  return {
    title: "テスト小説",
    title_jp: "テスト小説",
    title_zh: null,
    introduction_jp: "",
    introduction_zh: null,
    glossary: {},
    chapter_count: 2,
    volumes: volume_ids.map((volume_id, index) => ({
      volume_id,
      title: `第${index + 1}卷`,
    })),
  };
}

describe("wenku epub import", () => {
  it("合并分卷、还原日文并把站点译文按条目行号投影", async () => {
    const volume = await create_volume({
      volume_id: "1.epub",
      documents: [
        {
          href: "Text/ch1.xhtml",
          body: `<h1>第一章</h1><p style="opacity:0.4;">日本語一</p><p>中文一</p><p style="opacity:0.4;">日本語二</p><p>中文二</p>`,
        },
        { href: "Text/ch2.xhtml", body: "<h1>第二章</h1><p>未翻訳</p>" },
      ],
    });
    const client = {
      download_wenku_volume_epub: vi.fn(async () => volume),
    };

    const imported = await build_wenku_epub_import({
      ref: REF,
      metadata: metadata(["1.epub"]),
      client,
      include_translations: true,
    });

    expect(imported.filename).toBe("テスト小説.epub");
    expect(imported.chapter_count).toBe(2);
    expect(imported.mismatched_documents).toBe(0);
    expect(imported.text).toContain("日本語一");
    expect(imported.text).not.toContain("中文一");
    expect(imported.documents.map((document) => document.chapter_id)).toEqual([
      "OEBPS.Text.ch1.xhtml",
      "OEBPS.Text.ch2.xhtml",
    ]);

    const source = await read_epub_remote_source(imported.bytes, imported.filename);
    const row_of = (text: string): number => {
      const line = source.lines.find((candidate) => candidate.text === text);
      expect(line).toBeDefined();
      return line!.item.row;
    };
    expect([...imported.translations.entries()]).toEqual([
      [row_of("日本語一"), "中文一"],
      [row_of("日本語二"), "中文二"],
    ]);
    expect(client.download_wenku_volume_epub).toHaveBeenCalledWith(REF, "1.epub", undefined);
  });

  it("目标语言不需要译文时不投影站点译文", async () => {
    const volume = await create_volume({
      volume_id: "1.epub",
      documents: [
        {
          href: "Text/ch1.xhtml",
          body: `<p style="opacity:0.4;">日本語</p><p>中文</p>`,
        },
      ],
    });
    const imported = await build_wenku_epub_import({
      ref: REF,
      metadata: metadata(["1.epub"]),
      client: { download_wenku_volume_epub: vi.fn(async () => volume) },
      include_translations: false,
    });

    expect(imported.translations.size).toBe(0);
    expect(imported.text).not.toContain("中文");
  });

  it("TXT 与 EPUB 分卷混用时拒绝整本导入", () => {
    expect(() => assert_wenku_volumes_bindable(metadata(["1.epub", "2.txt"]))).toThrowError(
      expect.objectContaining({ code: "remote.wenku_mixed_volumes" }),
    );
  });

  it("按分卷扩展名判断格式", () => {
    expect(read_wenku_volume_formats(metadata(["1.epub", "2.EPUB", "3.txt"]))).toEqual([
      "epub",
      "epub",
      "txt",
    ]);
    expect(assert_wenku_volumes_bindable(metadata(["1.epub", "2.epub"]))).toEqual(["epub", "epub"]);
  });
});
