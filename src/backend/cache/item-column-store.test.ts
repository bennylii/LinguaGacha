import { describe, expect, it } from "vitest";

import type { ProjectItemPublicRecord } from "../../domain/item";
import { ItemCache } from "./item-cache";
import { ItemColumnStore } from "./item-column-store";

function create_item(
  item_id: number,
  overrides: Partial<ProjectItemPublicRecord> = {},
): ProjectItemPublicRecord {
  return {
    item_id,
    src: "",
    dst: "",
    name_src: null,
    name_dst: null,
    extra_field: "",
    tag: "",
    row_number: item_id,
    file_type: "TXT",
    file_path: "",
    status: "NONE",
    skip_internal_filter: false,
    ...overrides,
  };
}

describe("ItemColumnStore", () => {
  it("逐行组装与 ItemCache.readItems() 逐字段相等，含任意类型字段", () => {
    const records: ProjectItemPublicRecord[] = [
      create_item(3, { src: "原文", dst: "译文", name_src: ["甲", "乙"] }),
      create_item(1, { src: "同文", status: "PROCESSED", skip_internal_filter: true }),
      create_item(7, {
        name_dst: ["译名"],
        extra_field: { trans_ref: { file_key: "k" } },
        file_type: "EPUB",
        file_path: "a/b.txt",
        status: "ERROR",
        row_number: 42,
      }),
      create_item(5, { extra_field: [1, "x", null], tag: "loc", status: "DUPLICATED" }),
    ];
    const cache = new ItemCache();
    cache.replace(records);
    const store = ItemColumnStore.from_records(records);

    expect(store.size()).toBe(cache.size());
    const from_cache = cache.readItems();
    const from_store = store.read_all();
    expect(from_store).toEqual(from_cache);
    // 逐条独立相等，不依赖数组整体短路
    for (let i = 0; i < records.length; i++) expect(store.read(i)).toEqual(from_cache[i]);
  });

  it("按身份读取与 ItemCache.readItem() 相等，缺失返回 null", () => {
    const records = [create_item(11, { src: "甲" }), create_item(99, { src: "乙" })];
    const cache = new ItemCache();
    cache.replace(records);
    const store = ItemColumnStore.from_records(records);

    for (const id of [11, 99, 12, -1]) {
      expect(store.read_by_id(id)).toEqual(cache.readItem(id));
    }
    expect(store.read_by_id(999)).toBeNull();
  });

  it("迭代顺序与 read_all 一致，read 越界返回 null", () => {
    const records = [create_item(2), create_item(1), create_item(3)];
    const store = ItemColumnStore.from_records(records);
    expect([...store.iterate()]).toEqual(store.read_all());
    expect([...store.iterate()].map((item) => item.item_id)).toEqual([2, 1, 3]);
    expect(store.read(-1)).toBeNull();
    expect(store.read(3)).toBeNull();
    expect(store.read(1.5)).toBeNull();
  });

  it("大量记录与对象缓存逐条相等", () => {
    const records = Array.from({ length: 5000 }, (_, i) =>
      create_item(i + 1, {
        src: `原文-${i}`,
        dst: i % 3 === 0 ? "" : `译文-${i}`,
        status: (["NONE", "PROCESSED", "ERROR", "DUPLICATED"] as const)[i % 4]!,
        skip_internal_filter: i % 7 === 0,
        name_src: i % 5 === 0 ? ["名", `槽${i}`] : null,
        extra_field: i % 11 === 0 ? { key: i } : "",
      }),
    );
    const cache = new ItemCache();
    cache.replace(records);
    const store = ItemColumnStore.from_records(records);
    const expected = cache.readItems();
    expect(store.read_all()).toEqual(expected);
    for (const id of [1, 2500, 5000]) expect(store.read_by_id(id)).toEqual(cache.readItem(id));
  });
});
