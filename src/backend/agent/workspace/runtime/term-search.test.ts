import { describe, expect, it } from "vitest";
import { searchTerms } from "./term-search";

type TestItem = {
  item_id: number;
  file_path: string;
  src: string;
  dst: string;
  name_src: string;
  name_dst: string;
  status: string;
};

const make_item = (item_id: number, values: Partial<TestItem> = {}) => ({
  item_id,
  file_path: "chapter.txt",
  src: "",
  dst: "",
  name_src: "",
  name_dst: "",
  status: "NONE",
  ...values,
});

const make_entry = (id: string, src: string, dst = "", values: Record<string, unknown> = {}) => ({
  id,
  src,
  dst,
  info: "",
  case_sensitive: false,
  ...values,
});

describe("工作区术语检索", () => {
  it("区分 exact、word 与 substring，Latin 词边界排除字母数字下划线", async () => {
    const result = await searchTerms(
      [
        make_item(1, { src: "cat", dst: "猫" }),
        make_item(2, { src: "a cat!", dst: "一只猫" }),
        make_item(3, { src: "concatenate", dst: "连接" }),
        make_item(4, { src: "cat2", dst: "非独立词" }),
        make_item(5, { src: "_cat", dst: "非独立词" }),
      ],
      [],
      ["cat"],
    );
    expect(result[0]!.results.map(({ match }) => match)).toEqual([
      "exact",
      "word",
      "substring",
      "substring",
      "substring",
    ]);
  });

  it("CJK 使用子串匹配，不应用 Latin 词边界", async () => {
    const result = await searchTerms(
      [make_item(1, { src: "复活节快乐", dst: "节日" })],
      [],
      ["复活"],
    );
    expect(result[0]!.results[0]).toMatchObject({ match: "substring", dst: "节日" });
  });

  it("按字段、原文和译文聚合，item_ids 去重且最多三个", async () => {
    const result = await searchTerms(
      [
        make_item(4, { src: "HP", dst: "生命" }),
        make_item(2, { src: "HP", dst: "生命" }),
        make_item(3, { src: "HP", dst: "生命" }),
        make_item(1, { src: "HP", dst: "生命" }),
        make_item(2, { src: "HP", dst: "生命" }),
        make_item(5, { src: "HP", dst: "体力" }),
      ],
      [],
      ["HP"],
    );
    expect(result[0]!.results).toEqual([
      expect.objectContaining({ occurrences: 5, item_ids: [4, 2, 3], dst: "生命" }),
      expect.objectContaining({ occurrences: 1, item_ids: [5], dst: "体力" }),
    ]);
    expect(result[0]!.results[0]!.item_ids).toHaveLength(3);
  });

  it("confirmed 同时检查处理状态和目标字段，支持排除未确认结果", async () => {
    const items = [
      make_item(1, { src: "done", dst: "完成", status: "PROCESSED" }),
      make_item(2, { src: "pending", dst: "待定", status: "NONE" }),
      make_item(3, { src: "blank", dst: " ", status: "PROCESSED" }),
    ];
    const glossary = [make_entry("confirmed", "done", "确定"), make_entry("empty", "blank")];
    const all = await searchTerms(items, glossary, ["done", "pending", "blank"]);
    expect(all[0]!.results.every(({ confirmed }) => confirmed)).toBe(true);
    expect(all[1]!.results[0]).toMatchObject({ confirmed: false });
    expect(all[2]!.results.every(({ confirmed }) => confirmed)).toBe(false);
    const confirmed = await searchTerms(items, glossary, ["done", "pending", "blank"], {
      include_unconfirmed: false,
    });
    expect(confirmed.map(({ results }) => results.length)).toEqual([2, 0, 0]);
  });

  it("分别返回正文与 name 字段的匹配和译法", async () => {
    const result = await searchTerms(
      [
        make_item(1, {
          src: "Alice enters",
          dst: "爱丽丝进入",
          name_src: "Alice",
          name_dst: "阿丽斯",
          status: "PROCESSED",
        }),
      ],
      [],
      ["Alice"],
    );
    expect(result[0]!.results.map(({ field, src, dst }) => ({ field, src, dst }))).toEqual([
      { field: "name_src", src: "Alice", dst: "阿丽斯" },
      { field: "src", src: "Alice enters", dst: "爱丽丝进入" },
    ]);
  });

  it("排序依次使用匹配强度、确认、同文件、术语表和出现次数，并保持确定性", async () => {
    const result = await searchTerms(
      [
        make_item(1, { file_path: "other.txt", src: "dragon", dst: "龙", status: "PROCESSED" }),
        make_item(2, { file_path: "current.txt", src: "dragon", dst: "龙", status: "PROCESSED" }),
        make_item(3, {
          file_path: "other.txt",
          src: "a dragon",
          dst: "一条龙",
          status: "PROCESSED",
        }),
        make_item(4, { file_path: "current.txt", src: "draft", dst: "草稿", status: "NONE" }),
        make_item(5, { file_path: "other.txt", src: "draft", dst: "草稿", status: "NONE" }),
      ],
      [
        make_entry("g", "a dragon", "巨龙"),
        make_entry("d", "dragon", ""),
        make_entry("x", "draft", "草稿"),
      ],
      ["dragon", "draft"],
      { file_path: "current.txt" },
    );
    expect(result[0]!.results.map(({ src, entry_id }) => ({ src, entry_id }))).toEqual([
      { src: "dragon", entry_id: undefined },
      { src: "dragon", entry_id: "d" },
      { src: "a dragon", entry_id: "g" },
      { src: "a dragon", entry_id: undefined },
    ]);
    expect(
      result[1]!.results.map(({ entry_id, file_path, occurrences }) => ({
        entry_id,
        file_path,
        occurrences,
      })),
    ).toEqual([{ entry_id: "x", file_path: "current.txt", occurrences: 3 }]);
    expect(result[0]!.results[0]).toMatchObject({ file_path: "other.txt", occurrences: 2 });
  });

  it("同优先级保持聚合首次出现顺序，limit 默认八条并可覆盖", async () => {
    const items = Array.from({ length: 10 }, (_, index) =>
      make_item(index + 1, { src: `term ${index.toString()}`, dst: index.toString() }),
    );
    const result = await searchTerms(items, [], ["term"]);
    expect(result[0]!.results).toHaveLength(8);
    expect(result[0]!.results.map(({ src }) => src)).toEqual(
      Array.from({ length: 8 }, (_, index) => `term ${index.toString()}`),
    );
    const limited = await searchTerms(items, [], ["term"], { limit: 2 });
    expect(limited[0]!.results.map(({ src }) => src)).toEqual(["term 0", "term 1"]);
  });

  it("多查询保持请求顺序，空查询与规范化后重复查询只返回一次", async () => {
    const result = await searchTerms(
      [make_item(1, { src: "Straße", dst: "街道" })],
      [],
      ["STRASSE", "", "straße", "missing"],
    );
    expect(result.map(({ query }) => query)).toEqual(["STRASSE", "missing"]);
    expect(result[0]!.results[0]).toMatchObject({ src: "Straße", match: "exact" });
    expect(result[1]!.results).toEqual([]);
  });

  it("支持条目与术语表异步 iterable，并保留 evidence 等术语信息", async () => {
    async function* items() {
      yield make_item(1, { src: "mana", dst: "魔力" });
    }
    async function* glossary() {
      yield make_entry("entry-1", "mana", "法力", { info: "资源", evidence: "第一章" });
    }
    const result = await searchTerms(items(), glossary(), ["mana"]);
    expect(result[0]!.results[0]).toMatchObject({
      entry_id: "entry-1",
      info: "资源",
      case_sensitive: false,
      evidence: "第一章",
    });
  });

  it("默认不敏感，查询选项可收紧，术语表敏感标志始终生效", async () => {
    const items = [
      make_item(1, { src: "Cat", dst: "猫" }),
      make_item(2, { src: "cat", dst: "小猫" }),
    ];
    const insensitive = await searchTerms(items, [], ["CAT"]);
    expect(insensitive[0]!.results).toHaveLength(2);
    const sensitive = await searchTerms(items, [], ["CAT"], { case_sensitive: true });
    expect(sensitive[0]!.results).toEqual([]);
    const entries = [
      make_entry("s", "Cat", "猫", { case_sensitive: true }),
      make_entry("i", "cat", "小猫"),
    ];
    expect(
      (await searchTerms([], entries, ["cat"]))[0]!.results.map(({ entry_id }) => entry_id),
    ).toEqual(["i"]);
    expect(
      (await searchTerms([], entries, ["cat"], { case_sensitive: true }))[0]!.results.map(
        ({ entry_id }) => entry_id,
      ),
    ).toEqual(["i"]);
  });

  it("返回文本片段有界，limit 为零时不产生结果", async () => {
    const long = "ab".repeat(200);
    const result = await searchTerms([make_item(1, { src: long, dst: long })], [], ["ab"]);
    expect(result[0]!.results[0]!.src.length).toBeLessThanOrEqual(161);
    expect(result[0]!.results[0]!.dst.length).toBeLessThanOrEqual(161);
    const limited = await searchTerms([], [], ["ab"], { limit: 0 });
    expect(limited[0]!.results).toEqual([]);
    expect((await searchTerms([], [], ["ab"], { limit: -1 }))[0]!.results).toEqual([]);
  });

  it("同组任一出现已确认即合并为已确认，并可被未确认过滤保留", async () => {
    const items = [
      make_item(1, { src: "dragon", dst: "龙", status: "NONE" }),
      make_item(2, { src: "dragon", dst: "龙", status: "PROCESSED" }),
    ];
    const all = await searchTerms(items, [], ["dragon"]);
    expect(all[0]!.results).toHaveLength(1);
    expect(all[0]!.results[0]).toMatchObject({
      confirmed: true,
      occurrences: 2,
      item_ids: [1, 2],
    });
    const confirmed = await searchTerms(items, [], ["dragon"], { include_unconfirmed: false });
    expect(confirmed[0]!.results).toHaveLength(1);
  });

  it("同一原文与译文在正文和 name 字段保持独立分组", async () => {
    const result = await searchTerms(
      [
        make_item(1, {
          src: "mana",
          dst: "魔力",
          name_src: "mana",
          name_dst: "玛娜",
          status: "PROCESSED",
        }),
      ],
      [],
      ["mana"],
    );
    expect(result[0]!.results.map(({ field, src, dst }) => ({ field, src, dst }))).toEqual([
      { field: "src", src: "mana", dst: "魔力" },
      { field: "name_src", src: "mana", dst: "玛娜" },
    ]);
  });

  it("术语表结果没有条目引用时返回空 item_ids，并保留完整匹配信息", async () => {
    const result = await searchTerms([], [make_entry("entry-1", "mana", "魔力")], ["mana"]);
    expect(result[0]!.results[0]).toMatchObject({
      field: "src",
      item_ids: [],
      occurrences: 1,
      entry_id: "entry-1",
      confirmed: true,
      match: "exact",
    });
  });

  it("说明和证据分别截断，不互相覆盖", async () => {
    const long = "证".repeat(200);
    const result = await searchTerms(
      [],
      [make_entry("entry-1", "mana", "魔力", { info: `说明${long}`, evidence: `证据${long}` })],
      ["mana"],
    );
    expect(result[0]!.results[0]!.info).toHaveLength(161);
    expect(result[0]!.results[0]!.evidence).toHaveLength(161);
    expect(result[0]!.results[0]!.info).toContain("说明");
    expect(result[0]!.results[0]!.evidence).toContain("证据");
  });

  it("条目和术语表异步输入只消费一次，多个查询共享同一轮扫描", async () => {
    let item_yields = 0;
    let glossary_yields = 0;
    async function* items() {
      item_yields += 1;
      yield make_item(1, { src: "alpha", dst: "甲" });
      item_yields += 1;
      yield make_item(2, { src: "beta", dst: "乙" });
    }
    async function* glossary() {
      glossary_yields += 1;
      yield make_entry("entry-1", "alpha", "阿尔法");
    }

    const result = await searchTerms(items(), glossary(), ["alpha", "beta"]);
    expect(item_yields).toBe(2);
    expect(glossary_yields).toBe(1);
    expect(result[0]!.results).toHaveLength(2);
    expect(result[1]!.results).toHaveLength(1);
  });
});
