import { describe, expect, it } from "vitest";

import type { JsonValue } from "../../domain/json";
import { parse_novel_url, sha256_text } from "./novelia-source";
import {
  build_epub_document_key,
  build_remote_epub_map,
  build_remote_source_binding,
  read_remote_epub_map,
  read_remote_source_binding,
} from "./remote-source";

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

/** 生成结构完整的章节映射，用例只覆盖被修改的字段。 */
function create_epub_map() {
  return build_remote_epub_map({
    volumes: [{ volume_id: "1.epub", volume_title: "第一卷", prefix: "vol-1.epub" }],
    documents: [
      {
        chapter_id: "OEBPS.Text.ch1.xhtml",
        volume_id: "1.epub",
        source_doc_path: "OEBPS/Text/ch1.xhtml",
        doc_path: "OEBPS/vol-1.epub/Text/ch1.xhtml",
        title: "第一章",
        linear: true,
        state: "active",
      },
    ],
  });
}

describe("remote epub map", () => {
  it("保留分卷与章节身份，章节键包含分卷", () => {
    const map = create_epub_map();
    expect(read_remote_epub_map(map as unknown as JsonValue)).toEqual(map);
    expect(build_epub_document_key("1.epub", "OEBPS.Text.ch1.xhtml")).not.toBe(
      build_epub_document_key("2.epub", "OEBPS.Text.ch1.xhtml"),
    );
  });

  it("接受退役状态并保留线性标记", () => {
    const map = create_epub_map();
    const retired = {
      ...map,
      documents: [{ ...map.documents[0]!, state: "retired", linear: false }],
    };
    expect(read_remote_epub_map(retired as unknown as JsonValue)).toEqual(retired);
  });

  it.each<[string, unknown]>([
    ["空值", null],
    ["非对象", "map"],
    ["未知版本", { ...create_epub_map(), version: 2 }],
    ["缺少分卷", { ...create_epub_map(), volumes: null }],
    [
      "分卷重复",
      {
        ...create_epub_map(),
        volumes: [create_epub_map().volumes[0]!, create_epub_map().volumes[0]!],
      },
    ],
    ["章节指向未知分卷", { ...create_epub_map(), volumes: [] }],
    [
      "未知退役状态",
      {
        ...create_epub_map(),
        documents: [{ ...create_epub_map().documents[0]!, state: "gone" }],
      },
    ],
    [
      "线性标记非布尔",
      {
        ...create_epub_map(),
        documents: [{ ...create_epub_map().documents[0]!, linear: "yes" }],
      },
    ],
    [
      "同一分卷内章节重复",
      {
        ...create_epub_map(),
        documents: [create_epub_map().documents[0]!, create_epub_map().documents[0]!],
      },
    ],
    [
      "缺少文档路径",
      (({ doc_path: _doc_path, ...rest }) => ({
        ...create_epub_map(),
        documents: [rest],
      }))(create_epub_map().documents[0]!),
    ],
  ])("损坏映射按缺失处理：%s", (_label, value) => {
    expect(read_remote_epub_map(value as JsonValue)).toBeNull();
  });
});
