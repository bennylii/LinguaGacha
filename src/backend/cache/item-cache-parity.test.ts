import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";

import type { ProjectItemPublicRecord } from "../../domain/item";
import { ItemCache } from "./item-cache";

function item(id: number, over: Partial<ProjectItemPublicRecord> = {}): ProjectItemPublicRecord {
  return {
    item_id: id,
    src: "",
    dst: "",
    name_src: null,
    name_dst: null,
    extra_field: "",
    tag: "",
    row_number: id,
    file_type: "TXT",
    file_path: "",
    status: "NONE",
    skip_internal_filter: false,
    ...over,
  };
}

/** 强制两条表示：阈值 0 = 恒列式，阈值极大 = 恒对象 Map。 */
function pair(): { columnar: ItemCache; map: ItemCache } {
  return {
    columnar: new ItemCache(() => undefined, 0),
    map: new ItemCache(() => undefined, Number.MAX_SAFE_INTEGER),
  };
}

function assert_parity(
  columnar: ItemCache,
  map: ItemCache,
  ids: readonly number[],
  scope_targets: readonly number[],
): void {
  expect(columnar.readItems()).toEqual(map.readItems());
  expect(columnar.size()).toBe(map.size());
  for (const id of ids) expect(columnar.readItem(id)).toEqual(map.readItem(id));
  expect(columnar.readWriteScope(scope_targets)).toEqual(map.readWriteScope(scope_targets));
}

describe("ItemCache 双表示等价", () => {
  it("全量替换、增量、新身份、重复组在两条表示上逐结果相等", () => {
    const { columnar, map } = pair();
    const all_ids = [1, 2, 3, 4, 5, 9, 10, 20, 21, 22, 999];

    const full = [item(3, { src: "同文" }), item(1, { src: "同文" }), item(2, { src: "异文" })];
    for (const cache of [columnar, map]) cache.replace(full);
    assert_parity(columnar, map, all_ids, [1, 3]);

    // 更新既有（重复组键变化 / 不变两种）
    for (const cache of [columnar, map])
      cache.applyChange({ mode: "delta", records: [item(1, { src: "同文", dst: "A" })] });
    assert_parity(columnar, map, all_ids, [1, 3]);

    // 新身份追加
    for (const cache of [columnar, map])
      cache.applyChange({
        mode: "delta",
        records: [item(9, { src: "新" }), item(2, { dst: "B" })],
      });
    assert_parity(columnar, map, all_ids, [1, 3]);

    // 再更新已追加的新身份 + 再次新增
    for (const cache of [columnar, map])
      cache.applyChange({
        mode: "delta",
        records: [item(9, { dst: "N9" }), item(10, { src: "同文" })],
      });
    assert_parity(columnar, map, all_ids, [1, 3, 10]);

    // 全量替换（含重复身份）后再次增量
    const replace = [
      item(20, { src: "first" }),
      item(21),
      item(20, { src: "second", dst: "covered" }),
      item(22, { src: "同文" }),
    ];
    for (const cache of [columnar, map]) cache.replace(replace);
    assert_parity(columnar, map, all_ids, [20, 22]);

    for (const cache of [columnar, map])
      cache.applyChange({
        mode: "delta",
        records: [
          item(21, { dst: "D21" }),
          item(22, { src: "同文", dst: "D22" }),
          item(23, { src: "同文" }),
        ],
      });
    assert_parity(columnar, map, [...all_ids, 23], [20, 22, 23]);

    // clear 后再次全量
    for (const cache of [columnar, map]) cache.clear();
    assert_parity(columnar, map, all_ids, []);
    for (const cache of [columnar, map])
      cache.replace([item(5, { src: "同文" }), item(6, { src: "同文" })]);
    assert_parity(columnar, map, all_ids, [5, 6]);
  });

  it("同一新身份连续增量只追加一次，两条表示顺序一致", () => {
    const { columnar, map } = pair();
    for (const cache of [columnar, map]) cache.replace([item(1), item(2)]);
    for (const cache of [columnar, map]) {
      cache.applyChange({ mode: "delta", records: [item(9, { src: "甲" })] });
      cache.applyChange({ mode: "delta", records: [item(9, { src: "乙" })] });
    }
    expect(columnar.readItems().map((r) => r.item_id)).toEqual([1, 2, 9]);
    expect(columnar.readItems()).toEqual(map.readItems());
    expect(columnar.readItem(9)?.src).toBe("乙");
  });

  it("大规模数据在两条表示上逐条相等", () => {
    const { columnar, map } = pair();
    const records = Array.from({ length: 3000 }, (_, i) =>
      item(i + 1, {
        src: i % 3 === 0 ? "同文" : `原文-${i}`,
        dst: i % 2 === 0 ? `译文-${i}` : "",
        status: (["NONE", "PROCESSED", "ERROR", "DUPLICATED"] as const)[i % 4]!,
        skip_internal_filter: i % 7 === 0,
        name_src: i % 5 === 0 ? ["名", `槽${i}`] : null,
        extra_field: i % 11 === 0 ? { key: i } : "",
      }),
    );
    for (const cache of [columnar, map]) cache.replace(records);
    expect(isDeepStrictEqual(columnar.readItems(), map.readItems())).toBe(true);
    expect(columnar.size()).toBe(map.size());
    for (const id of [1, 1500, 3000, 3001]) expect(columnar.readItem(id)).toEqual(map.readItem(id));
    expect(columnar.readWriteScope([3, 6, 1500])).toEqual(map.readWriteScope([3, 6, 1500]));

    // 增量后再比对
    for (const cache of [columnar, map])
      cache.applyChange({
        mode: "delta",
        records: [
          item(1500, { src: "同文", dst: "改" }),
          item(4000, { src: "新行", status: "ERROR" }),
        ],
      });
    expect(isDeepStrictEqual(columnar.readItems(), map.readItems())).toBe(true);
  });
});
