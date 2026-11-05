import { write_zip, read_zip_fixture, zip_text } from "./zip-fixture";

/**
 * 构造最小 EPUB，测试只依赖公开 zip/container/opf/spine 结构
 */
export async function create_epub_fixture(chapter_text: string): Promise<Buffer> {
  const zip = new Map<string, string | Uint8Array>();
  zip.set(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  zip.set(
    "OPS/package.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf">
  <metadata/>
  <manifest>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter"/>
  </spine>
</package>`,
  );
  zip.set(
    "OPS/chapter.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <body><p>${chapter_text}</p></body>
</html>`,
  );
  return write_zip(zip);
}

/**
 * 读取 EPUB 内指定文档文本，断言写回结果时不暴露 ZIP 实现到各测试文件
 */
export async function read_epub_entry_text(
  epub_content: Buffer | Uint8Array,
  entry_path = "OPS/chapter.xhtml",
): Promise<string> {
  const zip = await read_zip_fixture(epub_content);
  return zip_text(zip, entry_path);
}

export interface VolumeDocumentFixture {
  /** 分卷包内路径，例如 `Text/ch1.xhtml`。 */
  href: string;
  heading: string;
  paragraphs: readonly string[];
}

/**
 * 构造与站点分卷结构一致的最小 EPUB：正文文档加 nav/NCX，供整本合并与文档级同步用例复用。
 * 路径与 OPF 布局固定为 `OEBPS/`，站点章节 id 因此是可预期的 `OEBPS.<href 点分>`。
 */
export async function create_volume_epub_fixture(
  documents: readonly VolumeDocumentFixture[],
): Promise<Uint8Array> {
  const zip = new Map<string, string | Uint8Array>();
  zip.set(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  zip.set(
    "OEBPS/package.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:volume</dc:identifier>
    <dc:title>巻</dc:title>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${documents
      .map(
        (document, index) =>
          `<item id="d${index + 1}" href="${document.href}" media-type="application/xhtml+xml"/>`,
      )
      .join("\n    ")}
  </manifest>
  <spine toc="ncx">
    ${documents.map((_document, index) => `<itemref idref="d${index + 1}"/>`).join("\n    ")}
  </spine>
</package>`,
  );
  zip.set(
    "OEBPS/nav.xhtml",
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>目次</title></head>
  <body><nav epub:type="toc" id="toc"><ol>
    ${documents
      .map((document) => `<li><a href="${document.href}">${document.heading}</a></li>`)
      .join("\n    ")}
  </ol></nav></body>
</html>`,
  );
  zip.set(
    "OEBPS/toc.ncx",
    `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:volume"/></head>
  <docTitle><text>巻</text></docTitle>
  <navMap>
    ${documents
      .map(
        (document, index) =>
          `<navPoint id="p${index + 1}" playOrder="${index + 1}"><navLabel><text>${document.heading}</text></navLabel><content src="${document.href}"/></navPoint>`,
      )
      .join("\n    ")}
  </navMap>
</ncx>`,
  );
  for (const document of documents) {
    const paragraphs = document.paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("");
    zip.set(
      `OEBPS/${document.href}`,
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${document.heading}</title></head><body><h1>${document.heading}</h1>${paragraphs}</body></html>`,
    );
  }
  return new Uint8Array(await write_zip(zip));
}
