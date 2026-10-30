import { describe, expect, it, vi } from "vitest";

import { create_volume_epub_fixture, type VolumeDocumentFixture } from "../../test/epub-fixture";
import { read_zip_fixture, zip_text } from "../../test/zip-fixture";
import { read_epub_remote_source } from "./epub-remote-source";
import type { RemoteNovelMetadata } from "./novelia-client";
import { parse_novel_url, type RemoteNovelRef, type RemoteOldItem } from "./novelia-source";
import {
  REMOTE_EPUB_MAP_META_KEY,
  build_remote_epub_map,
  type RemoteEpubMap,
} from "./remote-source";
import {
  apply_wenku_epub_sync_plan,
  build_wenku_epub_sync_plans,
  read_wenku_epub_local_package,
  read_wenku_epub_remote_package,
  type WenkuEpubSyncPlan,
} from "./wenku-epub-sync";
import { build_wenku_epub_map, build_wenku_epub_package } from "./wenku-epub-source";

const REF = parse_novel_url("https://n.novelia.cc/wenku/12345");
const TITLE = "テスト小説";
const FILENAME = "テスト小説.epub";

interface VolumeSpec {
  volume_id: string;
  title: string;
  documents: VolumeDocumentFixture[];
}

/** 合并包由真实导入管线生成；同步用例只改变分卷文档内容。 */
async function create_package(volumes: readonly VolumeSpec[]) {
  const bytes_by_id = new Map<string, Uint8Array>();
  for (const volume of volumes) {
    bytes_by_id.set(volume.volume_id, await create_volume_epub_fixture(volume.documents));
  }
  const metadata: RemoteNovelMetadata = {
    title: TITLE,
    title_jp: TITLE,
    title_zh: null,
    introduction_jp: "",
    introduction_zh: null,
    glossary: {},
    chapter_count: 0,
    volumes: volumes.map((volume) => ({ volume_id: volume.volume_id, title: volume.title })),
  };
  const client = {
    download_wenku_volume_epub: vi.fn(async (_ref: RemoteNovelRef, volume_id: string) => {
      const bytes = bytes_by_id.get(volume_id);
      if (bytes === undefined) throw new Error(`missing volume: ${volume_id}`);
      return bytes;
    }),
  };
  return await build_wenku_epub_package({ ref: REF, metadata, client });
}

/** 工程条目由资产重解析得到；用例只声明哪些原文已有译文。 */
async function read_asset(bytes: Uint8Array, dst_by_src: ReadonlyMap<string, string>) {
  const source = await read_epub_remote_source(bytes, FILENAME);
  const old_items: RemoteOldItem[] = source.lines.map((line, index) => {
    const dst = dst_by_src.get(line.text) ?? "";
    return {
      item_id: index + 1,
      row: line.item.row,
      src: line.text,
      dst,
      name_dst: null,
      status: dst === "" ? "NONE" : "PROCESSED",
      extra_field: line.item.extra_field,
    };
  });
  return {
    text: source.text,
    old_items,
    local: await read_wenku_epub_local_package(bytes, FILENAME),
  };
}

async function plan_pair(input: {
  bytes: Uint8Array;
  map: RemoteEpubMap;
  dst_by_src?: ReadonlyMap<string, string>;
  remote: Awaited<ReturnType<typeof build_wenku_epub_package>>;
}) {
  const local = await read_asset(input.bytes, input.dst_by_src ?? new Map());
  const remote = await read_wenku_epub_remote_package(input.remote, input.remote.filename);
  const plans = build_wenku_epub_sync_plans({
    local: local.local,
    old_items: local.old_items,
    map: input.map,
    remote,
    remote_bytes: input.remote.bytes,
  });
  return { ...local, plans };
}

async function apply(plan: WenkuEpubSyncPlan, bytes: Uint8Array) {
  return await apply_wenku_epub_sync_plan({ bytes, rel_path: FILENAME, plan });
}

async function read_opf_text(bytes: Uint8Array): Promise<string> {
  return zip_text(await read_zip_fixture(bytes), "OEBPS/package.opf");
}

async function read_nav_text(bytes: Uint8Array): Promise<string> {
  return zip_text(await read_zip_fixture(bytes), "OEBPS/nav.xhtml");
}

const DOCS: VolumeDocumentFixture[] = [
  { href: "Text/ch1.xhtml", heading: "第一章", paragraphs: ["日本語一", "日本語二"] },
  { href: "Text/ch2.xhtml", heading: "第二章", paragraphs: ["日本語三"] },
];

function volumes(documents: VolumeDocumentFixture[] = DOCS): VolumeSpec[] {
  return [{ volume_id: "1.epub", title: "第一卷", documents }];
}

describe("wenku epub sync", () => {
  it("远端与本地一致时保留全部文档与条目", async () => {
    const remote = await create_package(volumes());
    const map = build_wenku_epub_map(remote);
    const { plans, text } = await plan_pair({ bytes: remote.bytes, map, remote });

    expect(plans.full.documents.map((document) => document.state)).toEqual([
      "unchanged",
      "unchanged",
    ]);
    expect(plans.full.alignment.next.text).toBe(text);
    expect(plans.full.alignment.stats).toMatchObject({ added: 0, modified: 0, removed: 0 });
    expect(plans.add_only.documents.map((document) => document.state)).toEqual([
      "unchanged",
      "unchanged",
    ]);
  });

  it("章节段落改写后写回文档并保留未变行的译文", async () => {
    const remote = await create_package(volumes());
    const map = build_wenku_epub_map(remote);
    const next = await create_package(
      volumes([
        { href: "Text/ch1.xhtml", heading: "第一章", paragraphs: ["日本語一", "日本語二改"] },
        DOCS[1]!,
      ]),
    );
    const { plans, old_items } = await plan_pair({
      bytes: remote.bytes,
      map,
      remote: next,
      dst_by_src: new Map([
        ["日本語一", "中文一"],
        ["日本語二", "中文二"],
      ]),
    });

    const first = plans.full.documents[0]!;
    expect(first.state).toBe("updated");
    const kept = first.rows.find((row) => row.src === "日本語一");
    expect(kept?.old_item).not.toBeNull();
    expect(kept?.decision).not.toBe("retranslate");
    expect(first.rows.map((row) => row.old_item).filter((item) => item === null)).toEqual([]);

    const asset = await apply(plans.full, remote.bytes);
    expect(asset.text).toContain("日本語二改");
    expect(asset.text).not.toContain("日本語二\n");
    // 条目与译文由行号对齐保留，行数不因改写而变化。
    expect(asset.content_seeds).toHaveLength(old_items.length);
  });

  it("远端新增章节并入资产、spine 与目录", async () => {
    const remote = await create_package(volumes());
    const map = build_wenku_epub_map(remote);
    const next = await create_package(
      volumes([...DOCS, { href: "Text/ch3.xhtml", heading: "第三章", paragraphs: ["日本語四"] }]),
    );
    const { plans } = await plan_pair({ bytes: remote.bytes, map, remote: next });
    expect(plans.full.documents.map((document) => document.state)).toEqual([
      "unchanged",
      "unchanged",
      "added",
    ]);

    const asset = await apply(plans.full, remote.bytes);
    expect(asset.text).toContain("日本語四");
    expect(asset.map.documents.map((document) => document.title)).toEqual([
      "第一章",
      "第二章",
      "第三章",
    ]);
    expect(asset.map.documents.map((document) => document.state)).toEqual([
      "active",
      "active",
      "active",
    ]);
    const nav = await read_nav_text(asset.bytes);
    expect(nav).toContain("第三章");
    const spine = await read_opf_text(asset.bytes);
    // 新章节紧随同卷最后一篇文档，仍排在卷内。
    expect(spine.indexOf("ch3.xhtml")).toBeGreaterThan(spine.indexOf("ch2.xhtml"));
  });

  it("远端删除章节时退役：保留条目与译文，移出阅读顺序与目录", async () => {
    const remote = await create_package(volumes());
    const map = build_wenku_epub_map(remote);
    const next = await create_package(volumes([DOCS[0]!]));
    const { plans } = await plan_pair({ bytes: remote.bytes, map, remote: next });

    const retired = plans.full.documents[1]!;
    expect(retired.state).toBe("retired");
    expect(retired.rows.map((row) => row.src)).toEqual(["# 第二章", "日本語三"]);

    const asset = await apply(plans.full, remote.bytes);
    expect(asset.map.documents[1]?.state).toBe("retired");
    // 退役文档仍在包里，条目与译文随资产保留。
    expect(asset.text).toContain("日本語三");
    expect(await read_opf_text(asset.bytes)).toMatch(/idref="[^"]+" linear="no"/u);
    expect(await read_nav_text(asset.bytes)).not.toContain("第二章");
  });

  it("远端恢复章节时按映射还原线性阅读顺序", async () => {
    const remote = await create_package(volumes());
    const map = build_wenku_epub_map(remote);
    const shrunk = await create_package(volumes([DOCS[0]!]));
    const retire = await plan_pair({ bytes: remote.bytes, map, remote: shrunk });
    const retired_asset = await apply(retire.plans.full, remote.bytes);

    const restore = await plan_pair({
      bytes: retired_asset.bytes,
      map: retired_asset.map,
      remote,
      dst_by_src: new Map([["日本語三", "中文三"]]),
    });
    expect(restore.plans.full.documents[1]?.state).toBe("restored");

    const restored = await apply(restore.plans.full, retired_asset.bytes);
    // 退役期间文档仍在包里，恢复后正文与退役前的资产逐行一致。
    expect(restored.text).toBe(restore.text);
    expect(restored.text).toContain("日本語三");
    expect(restored.map.documents.map((document) => document.state)).toEqual(["active", "active"]);
    expect(await read_opf_text(restored.bytes)).not.toContain('linear="no"');
    expect(await read_nav_text(restored.bytes)).toContain("第二章");
  });

  it("仅追加模式不改写既有章节，只并入新增章节", async () => {
    const remote = await create_package(volumes());
    const map = build_wenku_epub_map(remote);
    const next = await create_package(
      volumes([
        { href: "Text/ch1.xhtml", heading: "第一章", paragraphs: ["書き換え一"] },
        DOCS[1]!,
        { href: "Text/ch3.xhtml", heading: "第三章", paragraphs: ["日本語四"] },
      ]),
    );
    const { plans } = await plan_pair({ bytes: remote.bytes, map, remote: next });
    expect(plans.full.documents[0]?.state).toBe("updated");
    expect(plans.add_only.documents[0]?.state).toBe("unchanged");

    const asset = await apply(plans.add_only, remote.bytes);
    expect(asset.text).toContain("日本語一");
    expect(asset.text).not.toContain("書き換え一");
    expect(asset.text).toContain("日本語四");
    expect(asset.map.documents.map((document) => document.title)).toEqual([
      "第一章",
      "第二章",
      "第三章",
    ]);
  });

  it("章节内新增与删除段落按块插入、移除并保持顺序", async () => {
    const remote = await create_package(
      volumes([
        {
          href: "Text/ch1.xhtml",
          heading: "第一章",
          paragraphs: ["日本語一", "日本語二", "日本語三"],
        },
        { href: "Text/ch2.xhtml", heading: "第二章", paragraphs: ["別章"] },
      ]),
    );
    const map = build_wenku_epub_map(remote);
    const next = await create_package(
      volumes([
        {
          href: "Text/ch1.xhtml",
          heading: "第一章",
          paragraphs: ["日本語一", "日本語四", "日本語二"],
        },
        { href: "Text/ch2.xhtml", heading: "第二章", paragraphs: ["別章"] },
      ]),
    );
    const { plans } = await plan_pair({ bytes: remote.bytes, map, remote: next });
    expect(plans.full.documents[0]?.rows.map((row) => row.src)).toEqual([
      "# 第一章",
      "日本語一",
      "日本語四",
      "日本語二",
    ]);
    expect(plans.full.documents[0]?.rows.filter((row) => row.old_item === null)).toHaveLength(1);
    expect(plans.full.documents[0]?.removed_items.map((item) => item.src)).toEqual(["日本語三"]);

    const asset = await apply(plans.full, remote.bytes);
    const expected = (await read_asset(next.bytes, new Map())).text;
    // 写回后的规范正文与远端新包逐行一致，块顺序与块数都对。
    expect(asset.text).toBe(expected);
    expect(asset.text).not.toContain("日本語三");
    expect(asset.content_seeds).toHaveLength(plans.full.documents[0]!.rows.length + 2);
  });

  it("映射指向已不在资产内的文档时拒绝同步", async () => {
    const remote = await create_package(volumes());
    const map = build_remote_epub_map({
      volumes: [],
      documents: [
        {
          chapter_id: "OEBPS.Text.missing.xhtml",
          volume_id: "1.epub",
          source_doc_path: "OEBPS/Text/missing.xhtml",
          doc_path: "OEBPS/vol-1.epub/Text/missing.xhtml",
          title: "缺失章",
          linear: true,
          state: "active",
        },
      ],
    });
    await expect(plan_pair({ bytes: remote.bytes, map, remote })).rejects.toMatchObject({
      code: "remote.epub_document_conflict",
    });
  });

  it("映射键包含分卷，章节 id 跨卷相同时仍能区分", async () => {
    const remote = await create_package([
      {
        volume_id: "1.epub",
        title: "第一卷",
        documents: [{ href: "Text/ch1.xhtml", heading: "第一卷第一章", paragraphs: ["一"] }],
      },
      {
        volume_id: "2.epub",
        title: "第二卷",
        documents: [{ href: "Text/ch1.xhtml", heading: "第二卷第一章", paragraphs: ["二"] }],
      },
    ]);
    const map = build_wenku_epub_map(remote);
    expect(map.documents.map((document) => document.chapter_id)).toEqual([
      "OEBPS.Text.ch1.xhtml",
      "OEBPS.Text.ch1.xhtml",
    ]);
    const { plans } = await plan_pair({ bytes: remote.bytes, map, remote });
    expect(plans.full.documents.map((document) => document.state)).toEqual([
      "unchanged",
      "unchanged",
    ]);
    expect(REMOTE_EPUB_MAP_META_KEY).toBe("remote_epub_map");
  });
});
