import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../domain/json";
import { parse_novel_url, sha256_text } from "./novelia-source";
import { build_remote_source_binding, read_remote_source_binding } from "./remote-source";

const NOVEL_URL = "https://n.novelia.cc/novel/kakuyomu/12345";

/** 生成结构完整的绑定，用例只覆盖被修改的字段。 */
function create_binding() {
  return build_remote_source_binding({
    ref: parse_novel_url(NOVEL_URL),
    title: "テスト小説",
    asset_path: "テスト小説.txt",
    remote_hash: sha256_text("本文"),
    chapter_count: 12,
    synced_at: "2026-10-20T00:00:00.000Z",
  });
}

describe("remote source binding", () => {
  it("由规范地址生成与 API 载荷一致的绑定", () => {
    const binding = create_binding();
    expect(binding).toEqual({
      origin: "https://n.novelia.cc",
      host: "n.novelia.cc",
      kind: "web",
      provider_id: "kakuyomu",
      novel_id: "12345",
      url: NOVEL_URL,
      title: "テスト小説",
      asset_path: "テスト小説.txt",
      remote_hash: sha256_text("本文"),
      chapter_count: 12,
      synced_at: "2026-10-20T00:00:00.000Z",
    });
    expect(read_remote_source_binding(binding as unknown as JsonValue)).toEqual(binding);
  });

  it("文库作品允许空的 provider_id", () => {
    const binding = build_remote_source_binding({
      ref: parse_novel_url("https://n.novelia.cc/wenku/777"),
      title: "文库作品",
      asset_path: "文库作品.txt",
      remote_hash: sha256_text("本文"),
      chapter_count: 1,
      synced_at: "2026-10-20T00:00:00.000Z",
    });
    expect(binding.provider_id).toBe("");
    expect(read_remote_source_binding(binding as unknown as JsonValue)).toEqual(binding);
  });

  it.each<[string, JsonValue]>([
    ["非对象", "binding"],
    ["数组", []],
    ["空值", null],
    ["未知类型", { ...create_binding(), kind: "unknown" }],
    ["网页作品缺少 provider", { ...create_binding(), provider_id: "" }],
    ["非规范 origin", { ...create_binding(), origin: "https://N.NOVELIA.CC" }],
    ["未知站点", { ...create_binding(), host: "evil.example" }],
    ["空作品标识", { ...create_binding(), novel_id: " " }],
    ["空资产路径", { ...create_binding(), asset_path: "" }],
    ["非 SHA-256 哈希", { ...create_binding(), remote_hash: "abc" }],
    ["零章节", { ...create_binding(), chapter_count: 0 }],
    ["小数章节", { ...create_binding(), chapter_count: 1.5 }],
    ["缺少同步时间", (({ synced_at: _synced_at, ...rest }) => rest)(create_binding())],
  ])("损坏绑定按未绑定处理：%s", (_label, value) => {
    expect(read_remote_source_binding(value)).toBeNull();
  });
});
