import { describe, expect, it } from "vitest";

import { split_bilingual_document } from "./epub-bilingual";

const DOC = "OEBPS/Text/chapter.xhtml";

function to_text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function document(body: string): Uint8Array {
  return new TextEncoder().encode(
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>章</title></head><body>${body}</body></html>`,
  );
}

describe("split_bilingual_document", () => {
  it("剥除站点插入的中文段并还原日文段样式", () => {
    const split = split_bilingual_document(
      document(
        `<h1>第一章</h1>
         <p style="opacity:0.4;">日本語一</p><p>中文一</p>
         <p style="opacity:0.4;">日本語二</p><p>中文二</p>`,
      ),
      DOC,
    );

    expect(split.paragraphs).toEqual([
      { jp: "日本語一", zh: "中文一" },
      { jp: "日本語二", zh: "中文二" },
    ]);
    const output = to_text(split.bytes);
    expect(output).not.toContain("中文一");
    expect(output).not.toContain("中文二");
    expect(output).not.toContain("opacity");
    expect(output).toContain("日本語二");
  });

  it("没有双语标记的章节原样返回并按段落给出空译文", () => {
    const raw = document(`<p>日本語一</p><p> </p><p>日本語二</p>`);
    const split = split_bilingual_document(raw, DOC);

    expect(split.bytes).toEqual(raw);
    expect(split.paragraphs).toEqual([
      { jp: "日本語一", zh: null },
      { jp: "日本語二", zh: null },
    ]);
  });

  it("空译文段仍按位置剥除", () => {
    const split = split_bilingual_document(
      document(`<p style="opacity:0.4;">日本語</p><p></p>`),
      DOC,
    );

    expect(split.paragraphs).toEqual([{ jp: "日本語", zh: null }]);
    expect(to_text(split.bytes)).toContain("日本語");
  });

  it("注音按规范正文口径排除", () => {
    const split = split_bilingual_document(
      document(`<p style="opacity:0.4;"><ruby>漢<rt>かん</rt></ruby>字</p><p>汉字</p>`),
      DOC,
    );

    expect(split.paragraphs).toEqual([{ jp: "漢字", zh: "汉字" }]);
  });

  it("同一章既有变暗段又有未变暗段时拒绝猜测", () => {
    expect(() =>
      split_bilingual_document(
        document(`<p style="opacity:0.4;">日本語</p><p>中文</p><p>もう一段</p>`),
        DOC,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "remote.epub_layout_unsupported",
        public_details: expect.objectContaining({ reason: "mixed_document" }),
      }),
    );
  });
});
