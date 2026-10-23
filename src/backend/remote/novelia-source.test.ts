import { describe, expect, it } from "vitest";

import { split_text_lines_for_items } from "../file/shared/file-format-helpers";
import type { RemoteOldItem } from "./novelia-source";
import {
  align_remote_documents,
  build_add_only_plan,
  build_novel_filename,
  line_similarity,
  normalize_match_line,
  parse_novel_url,
  read_remote_translations,
  sha256_text,
  split_remote_document,
} from "./novelia-source";

function old_items_from(text: string, overrides: Partial<RemoteOldItem> = {}): RemoteOldItem[] {
  return split_remote_document(text).lines.map((line, index) => ({
    item_id: index + 1,
    row: line.row,
    src: line.text,
    dst: `T${index}`,
    name_dst: null,
    status: "PROCESSED",
    extra_field: null,
    ...overrides,
  }));
}

const BOOK = ["Book", "", "# C1", "a", "b", "# C2", "c", "# C3", "d"].join("\n");

describe("parse_novel_url", () => {
  it("归一化网页小说地址并去掉章节子路径与查询串", () => {
    expect(
      parse_novel_url("https://n.novelia.cc/novel/kakuyomu/1234567890/chapter/3?x=1#top"),
    ).toEqual({
      origin: "https://n.novelia.cc",
      host: "n.novelia.cc",
      kind: "web",
      provider_id: "kakuyomu",
      novel_id: "1234567890",
      url: "https://n.novelia.cc/novel/kakuyomu/1234567890",
    });
  });

  it("解析文库地址与旧域名", () => {
    expect(parse_novel_url("https://books.fishhawk.top/wenku/abc/volume/1")).toMatchObject({
      kind: "wenku",
      provider_id: "",
      novel_id: "abc",
      url: "https://books.fishhawk.top/wenku/abc",
    });
    expect(parse_novel_url("http://books1.fishhawk.top/novel/p/1")).toMatchObject({
      origin: "http://books1.fishhawk.top",
      kind: "web",
    });
  });

  it("去除主机尾点并保留显式端口", () => {
    expect(parse_novel_url("https://N.NOVELIA.CC.:8443/novel/p/1")).toMatchObject({
      origin: "https://n.novelia.cc:8443",
      host: "n.novelia.cc",
    });
  });

  it("解码路径段后再编码为规范地址", () => {
    expect(parse_novel_url("https://n.novelia.cc/novel/p/a%20b").url).toBe(
      "https://n.novelia.cc/novel/p/a%20b",
    );
  });

  it("拒绝非白名单主机、非 http(s) 协议与非法路径", () => {
    expect(() => parse_novel_url("https://example.com/novel/p/1")).toThrow(
      "unsupported novel host",
    );
    expect(() => parse_novel_url("ftp://n.novelia.cc/novel/p/1")).toThrow("invalid novel url");
    expect(() => parse_novel_url("https://n.novelia.cc/novel//1")).toThrow("invalid novel url");
    expect(() => parse_novel_url("https://n.novelia.cc/novel/p/%E0%A4")).toThrow(
      "invalid novel url",
    );
    expect(() => parse_novel_url("not a url")).toThrow("invalid novel url");
  });
});

describe("build_novel_filename", () => {
  it("清理路径分隔符与控制字符", () => {
    expect(build_novel_filename("第一章 / 序")).toBe("第一章 _ 序.txt");
    expect(build_novel_filename("a\u0001b")).toBe("a_b.txt");
  });

  it("避开 Windows 保留名与空标题", () => {
    expect(build_novel_filename("CON")).toBe("_CON.txt");
    expect(build_novel_filename("...")).toBe("novel.txt");
    expect(build_novel_filename("   ")).toBe("novel.txt");
  });

  it("按码点截断并做 NFC 归一", () => {
    expect(Array.from(build_novel_filename(`${"あ".repeat(200)}.txt`)).length).toBe(124);
    expect(build_novel_filename("e\u0301")).toBe("é.txt");
  });
});

describe("split_remote_document", () => {
  it("按 Markdown 标题切分正文并保留前言", () => {
    const document = split_remote_document("Book\r\n\r\n# C1\r\nA\r\n# C2\r\nB");
    expect(document.lines.map((line) => line.text)).toEqual(["Book", "", "# C1", "A", "# C2", "B"]);
    expect(document.chapters).toEqual([
      { index: 0, kind: "preamble", title: "", heading_row: null, start_row: 0, end_row: 2 },
      { index: 1, kind: "chapter", title: "C1", heading_row: 2, start_row: 2, end_row: 4 },
      { index: 2, kind: "chapter", title: "C2", heading_row: 4, start_row: 4, end_row: 6 },
    ]);
  });

  it("没有标题时整篇作为前言", () => {
    const document = split_remote_document("only text\nsecond line");
    expect(document.chapters).toEqual([
      { index: 0, kind: "preamble", title: "", heading_row: null, start_row: 0, end_row: 2 },
    ]);
  });

  it("只把 `# ` 开头的行当作章节标题", () => {
    const document = split_remote_document("#nospace\n## keep\n# real");
    expect(document.chapters.map((chapter) => chapter.title)).toEqual(["", "real"]);
  });

  it("空文本没有章节", () => {
    expect(split_remote_document("")).toMatchObject({ lines: [], chapters: [] });
  });
});

describe("read_remote_translations", () => {
  it("按双语导出的日文行还原每段译文与标题", () => {
    const source = ["# C1", "a", "", "b", "# C2", "c"].join("\n");
    const translated = ["# C1", "# 一", "a", "甲", "", "b", "乙", "# C2", "# 二", "c", "丙"].join(
      "\n",
    );

    expect(read_remote_translations(source, translated)).toEqual(
      new Map([
        [0, "# 一"],
        [1, "甲"],
        [3, "乙"],
        [4, "# 二"],
        [5, "丙"],
      ]),
    );
  });

  it("缺失译文的章节整章跳过，其余章节仍沿用", () => {
    const source = ["# C1", "a", "# C2", "b"].join("\n");
    const translated = ["# C1", "# 一", "a", "gpt翻译缺失。", "# C2", "# 二", "b", "乙"].join("\n");

    expect(read_remote_translations(source, translated)).toEqual(
      new Map([
        [2, "# 二"],
        [3, "乙"],
      ]),
    );
  });

  it("整章缺失标记不写入任何译文", () => {
    const source = ["# C1", "a"].join("\n");
    const translated = ["# C1", "# 该章节缺失。"].join("\n");

    expect(read_remote_translations(source, translated)).toEqual(new Map());
  });

  it("正文行不匹配时放弃整章，避免写错行", () => {
    const source = ["# C1", "a", "b"].join("\n");
    const translated = ["# C1", "# 一", "a", "甲", "x", "乙"].join("\n");

    expect(read_remote_translations(source, translated)).toEqual(new Map());
  });

  it("标题译文与原文相同时不写入", () => {
    const source = ["# C1", "a"].join("\n");
    const translated = ["# C1", "# C1", "a", "甲"].join("\n");

    expect(read_remote_translations(source, translated)).toEqual(new Map([[1, "甲"]]));
  });

  it("没有双语内容时返回空表", () => {
    expect(read_remote_translations("# C1\na", "")).toEqual(new Map());
  });
});

describe("align_remote_documents", () => {
  it("行数变化时按内容保留未变章节的条目身份与译文", () => {
    const next = ["Book", "", "# C1", "a", "x", "b", "# C2", "c", "# C3", "d"].join("\n");
    const plan = align_remote_documents({
      previous_text: BOOK,
      next_text: next,
      old_items: old_items_from(BOOK),
    });

    expect(plan.stats.added).toBe(1);
    expect(plan.stats.modified).toBe(0);
    expect(plan.stats.removed).toBe(0);
    expect(plan.stats.inherited).toBe(9);

    const added = plan.rows.find((row) => row.src === "x");
    expect(added).toMatchObject({ row: 4, decision: "retranslate", old_item: null });

    const c3 = plan.rows.find((row) => row.src === "# C3");
    expect(c3).toMatchObject({
      row: 8,
      decision: "preserve",
      src_hash: sha256_text("# C3"),
    });
    expect(c3?.old_item).toMatchObject({ item_id: 8, row: 7, dst: "T7" });
  });

  it("改写行按相似度决定保留或重翻", () => {
    const low_old = ["# C1", "alpha beta gamma", "tail"].join("\n");
    const low_new = ["# C1", "completely different words", "tail"].join("\n");
    const low = align_remote_documents({
      previous_text: low_old,
      next_text: low_new,
      old_items: old_items_from(low_old),
    });
    expect(low.rows.find((row) => row.src === "completely different words")).toMatchObject({
      decision: "retranslate",
      review: false,
      old_item: { item_id: 2 },
    });
    expect(low.stats).toMatchObject({ modified: 1, would_lose: 1, inherited: 2 });

    const high_old = ["# C1", "これはとても長い文章です。", "tail"].join("\n");
    const high_new = ["# C1", "これはとても長い文章でした。", "tail"].join("\n");
    const high = align_remote_documents({
      previous_text: high_old,
      next_text: high_new,
      old_items: old_items_from(high_old),
    });
    expect(high.rows.find((row) => row.src === "これはとても長い文章でした。")).toMatchObject({
      decision: "keep",
      review: true,
      old_item: { dst: "T1" },
    });
    expect(high.stats).toMatchObject({ modified: 1, inherited: 3, would_lose: 0 });
  });

  it("删除行报告旧原文与旧译文", () => {
    const old_text = ["# C1", "a", "b", "c"].join("\n");
    const new_text = ["# C1", "a", "c"].join("\n");
    const plan = align_remote_documents({
      previous_text: old_text,
      next_text: new_text,
      old_items: old_items_from(old_text),
    });

    expect(plan.stats).toMatchObject({ added: 0, modified: 0, removed: 1, would_lose: 1 });
    expect(plan.chapters.find((chapter) => chapter.title === "C1")).toMatchObject({
      status: "modified",
      removed_lines: [{ row: 2, src: "b", dst: "T2" }],
    });
  });

  it("空白与全半角差异按保留处理且不提示复核", () => {
    const old_text = ["# C1", "ＡＢＣ　１２３"].join("\n");
    const new_text = ["# C1", "ABC 123"].join("\n");
    const plan = align_remote_documents({
      previous_text: old_text,
      next_text: new_text,
      old_items: old_items_from(old_text),
    });
    expect(plan.rows.find((row) => row.src === "ABC 123")).toMatchObject({
      decision: "preserve",
      review: false,
    });
    expect(plan.stats).toMatchObject({ modified: 0, inherited: 2 });
  });

  it("CRLF 与 LF 的相同内容直接保留", () => {
    const plan = align_remote_documents({
      previous_text: "# C1\na\nb",
      next_text: "# C1\r\na\r\nb",
      old_items: old_items_from("# C1\na\nb"),
    });
    expect(plan.stats).toMatchObject({ added: 0, modified: 0, removed: 0, inherited: 3 });
  });

  it("重复行按出现顺序消费旧译文", () => {
    const text = ["# C1", "same", "same"].join("\n");
    const items = old_items_from(text).map((item) => ({ ...item, row: 0 }));
    const plan = align_remote_documents({
      previous_text: text,
      next_text: text,
      old_items: items,
    });
    const preserved = plan.rows.filter((row) => row.src === "same");
    expect(preserved.map((row) => row.old_item?.dst)).toEqual(["T1", "T2"]);
  });

  it("EXCLUDED 行精确匹配保留状态，改写行不自动恢复", () => {
    const old_text = ["# C1", "keep me", "change me"].join("\n");
    const items = old_items_from(old_text).map((item) =>
      item.src === "# C1" ? item : { ...item, status: "EXCLUDED" as const },
    );
    const plan = align_remote_documents({
      previous_text: old_text,
      next_text: ["# C1", "keep me", "changed text"].join("\n"),
      old_items: items,
    });

    expect(plan.rows.find((row) => row.src === "keep me")).toMatchObject({
      decision: "preserve",
      old_item: { status: "EXCLUDED", dst: "T1" },
    });
    expect(plan.rows.find((row) => row.src === "changed text")).toMatchObject({
      decision: "keep",
      review: true,
      old_item: { status: "EXCLUDED" },
    });
    expect(plan.stats.would_lose).toBe(0);
  });

  it("标题改名后仍按位置配对并标记修改", () => {
    const next = BOOK.replace("# C2", "# C2 renamed");
    const plan = align_remote_documents({
      previous_text: BOOK,
      next_text: next,
      old_items: old_items_from(BOOK),
    });
    const chapter = plan.chapters.find((entry) => entry.title === "C2 renamed");
    expect(chapter).toMatchObject({ status: "modified", old_index: 2, start_row: 5, end_row: 7 });
    expect(plan.chapters.some((entry) => entry.status === "removed")).toBe(false);
  });

  it("章节拆分时配对不确定标记 ambiguous，多出的部分记为新增", () => {
    const next = [
      "Book",
      "",
      "# C1",
      "a",
      "b",
      "# C2 part 1",
      "c",
      "# C2 part 2",
      "extra",
      "# C3",
      "d",
    ].join("\n");
    const plan = align_remote_documents({
      previous_text: BOOK,
      next_text: next,
      old_items: old_items_from(BOOK),
    });
    expect(plan.chapters.find((entry) => entry.title === "C2 part 1")).toMatchObject({
      status: "ambiguous",
      old_index: 2,
    });
    expect(plan.chapters.find((entry) => entry.title === "C2 part 2")).toMatchObject({
      status: "added",
      old_index: null,
    });
    expect(plan.chapters.some((entry) => entry.status === "removed")).toBe(false);
  });

  it("单边前言不参与正文配对", () => {
    const old_text = ["Book", "", "# C1", "a", "# C2", "b"].join("\n");
    const new_text = ["# C1", "a", "# C2", "b"].join("\n");
    const plan = align_remote_documents({
      previous_text: old_text,
      next_text: new_text,
      old_items: old_items_from(old_text),
    });
    expect(plan.chapters.find((entry) => entry.kind === "preamble")).toMatchObject({
      status: "removed",
    });
    expect(plan.chapters.find((entry) => entry.title === "C1")).toMatchObject({
      status: "unchanged",
      old_index: 1,
    });
    expect(plan.rows.find((row) => row.src === "a")?.old_item).toMatchObject({ dst: "T3" });
  });

  it("工程条目与上次快照不一致时标记 diverged", () => {
    const items = old_items_from(BOOK);
    const first = items[0];
    if (first === undefined) throw new Error("missing item");
    items[0] = { ...first, src: "different" };
    const plan = align_remote_documents({
      previous_text: BOOK,
      next_text: BOOK,
      old_items: items,
    });
    expect(plan.stats.diverged).toBe(true);
  });

  it("大范围丢失译文时要求手动对齐", () => {
    const old_lines = Array.from({ length: 30 }, (_, index) => "a".repeat(index + 3));
    const new_lines = Array.from({ length: 30 }, (_, index) => "b".repeat(index + 3));
    const old_text = ["# C1", ...old_lines].join("\n");
    const new_text = ["# C1", ...new_lines].join("\n");
    const plan = align_remote_documents({
      previous_text: old_text,
      next_text: new_text,
      old_items: old_items_from(old_text),
    });
    expect(plan.stats.would_lose).toBe(30);
    expect(plan.stats.requires_alignment).toBe(true);
  });

  it("少量丢失不触发手动对齐", () => {
    const old_text = ["# C1", "a", "b", "c"].join("\n");
    const new_text = ["# C1", "a", "x", "c"].join("\n");
    const plan = align_remote_documents({
      previous_text: old_text,
      next_text: new_text,
      old_items: old_items_from(old_text),
    });
    expect(plan.stats.requires_alignment).toBe(false);
  });

  it("站点译文写入行计划，工程已有译文时不重复计数", () => {
    const previous = ["# C1", "a"].join("\n");
    const next = ["# C1", "a", "# C2", "b"].join("\n");
    const plan = align_remote_documents({
      previous_text: previous,
      next_text: next,
      old_items: old_items_from(previous),
      next_translations: new Map([
        [0, "# 一"],
        [1, "甲"],
        [2, "# 二"],
        [3, "乙"],
      ]),
    });
    const rows = new Map(plan.rows.map((row) => [row.row, row]));

    expect(rows.get(0)?.remote_dst).toBe("# 一");
    expect(rows.get(2)?.remote_dst).toBe("# 二");
    // C1 两行沿用工程译文，只有新增的 C2 两行计入站点沿用。
    expect(plan.stats.remote_inherited).toBe(2);
  });

  it("工程译文为空的行也沿用站点译文", () => {
    const previous = ["# C1", "a"].join("\n");
    const next = ["# C1", "a", "# C2", "b"].join("\n");
    const plan = align_remote_documents({
      previous_text: previous,
      next_text: next,
      old_items: old_items_from(previous, { dst: "" }),
      next_translations: new Map([
        [0, "# 一"],
        [1, "甲"],
        [2, "# 二"],
        [3, "乙"],
      ]),
    });

    expect(plan.stats.remote_inherited).toBe(4);
  });

  it("人工排除的行不沿用站点译文", () => {
    const previous = ["# C1", "a"].join("\n");
    const next = ["# C1", "a", "# C2", "b"].join("\n");
    const plan = align_remote_documents({
      previous_text: previous,
      next_text: next,
      old_items: old_items_from(previous, { dst: "", status: "EXCLUDED" }),
      next_translations: new Map([
        [0, "# 一"],
        [1, "甲"],
        [2, "# 二"],
        [3, "乙"],
      ]),
    });

    expect(plan.stats.remote_inherited).toBe(2);
  });
});

describe("build_add_only_plan", () => {
  it("只追加新增章节并报告被跳过的修改章节", () => {
    const next = [
      "Book",
      "",
      "# C1",
      "a",
      "b",
      "# C2",
      "c changed",
      "# C3",
      "d",
      "# C4",
      "new",
    ].join("\n");
    const plan = align_remote_documents({
      previous_text: BOOK,
      next_text: next,
      old_items: old_items_from(BOOK),
    });
    const result = build_add_only_plan(BOOK, plan);

    expect(result.appended).toEqual(["# C4\nnew"]);
    expect(result.skipped).toEqual(["C2"]);
    expect(result.text).not.toContain("c changed");
    expect(result.text.endsWith("# C4\nnew\n")).toBe(true);
  });

  it("追加章节时把站点译文重映射到新行号", () => {
    const current = ["Book", "", "# C1", "a", "", "extra"].join("\n");
    const next = ["Book", "", "# C1", "a", "", "# C2", "b"].join("\n");
    const plan = align_remote_documents({
      previous_text: current,
      next_text: next,
      old_items: old_items_from(current),
      next_translations: new Map([
        [5, "# 二"],
        [6, "乙"],
      ]),
    });
    const result = build_add_only_plan(current, plan);
    const lines = split_text_lines_for_items(result.text);

    expect(result.translations).toEqual(
      new Map([
        [7, "# 二"],
        [8, "乙"],
      ]),
    );
    expect(lines[7]).toBe("# C2");
    expect(lines[8]).toBe("b");
  });
});

describe("normalize_match_line / line_similarity", () => {
  it("规范化只消除排版差异", () => {
    expect(normalize_match_line("  Ａ　Ｂ  ")).toBe("A B");
  });

  it("短文本按相等判断，长文本按 bigram 计算", () => {
    expect(line_similarity("あ", "あ")).toBe(1);
    expect(line_similarity("あ", "い")).toBe(0);
    expect(line_similarity("abcdef", "abcdef")).toBe(1);
    expect(line_similarity("abcdef", "abcxyz")).toBeCloseTo(0.4);
  });
});
