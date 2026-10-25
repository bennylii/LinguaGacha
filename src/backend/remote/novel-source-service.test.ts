import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "../../domain/json";
import { ProjectDatabase } from "../database/database-operations";
import type { RemoteAssetReplaceRequest } from "../project/project-content-service";
import type { ProjectFileLock } from "../project/project-file-lock";
import { ProjectSessionState } from "../project/project-session-state";
import type { NoveliaClient, RemoteNovelDownload } from "./novelia-client";
import { NovelSourceService, type RemoteAssetWriter } from "./novel-source-service";
import { parse_novel_url, sha256_text } from "./novelia-source";
import { RemoteSnapshotStore } from "./remote-snapshot-store";
import {
  build_remote_source_binding,
  REMOTE_SOURCE_META_KEY,
  type RemoteSourceBinding,
} from "./remote-source";

const NOVEL_URL = "https://n.novelia.cc/novel/kakuyomu/12345";
const ASSET_PATH = "テスト小説.txt";
const CHAPTER_ONE = "# 第一章\n第一行\n第二行";
const CHAPTER_TWO = "# 第二章\n第三行";
const CURRENT_TEXT = `${CHAPTER_ONE}\n${CHAPTER_TWO}`;

interface Fixture {
  service: NovelSourceService;
  database: ProjectDatabase;
  snapshots: RemoteSnapshotStore;
  writer: { requests: RemoteAssetReplaceRequest[] };
  client: { download: ReturnType<typeof vi.fn> };
  lg_path: string;
}

/** 每个用例独立 .lg 与 userdata，避免暂存、快照与修订互相影响。 */
async function create_fixture(options: {
  text: string;
  remote_text: string;
  bound?: boolean;
  translations?: ReadonlyMap<number, string>;
  target_language?: "ZH" | "EN";
}): Promise<Fixture> {
  const database = new ProjectDatabase();
  const lg_path = path.join(temp_dir, "demo.lg");
  await database.create_project(lg_path, "demo");
  const session_state = new ProjectSessionState();
  await session_state.mark_loaded(lg_path);
  const paths = {
    get_user_data_path: (...parts: string[]) => path.join(temp_dir, "userdata", ...parts),
  };
  const snapshots = new RemoteSnapshotStore({ paths });
  const writer = { requests: [] as RemoteAssetReplaceRequest[] };
  const client = {
    download: vi.fn(async (): Promise<RemoteNovelDownload> => ({
      metadata: {
        title: "テスト小説",
        title_jp: "テスト小説",
        title_zh: null,
        introduction_jp: "",
        introduction_zh: null,
        glossary: {},
        chapter_count: 2,
        volumes: [],
      },
      text: options.remote_text,
      translations: options.translations ?? new Map(),
      filename: ASSET_PATH,
      content_hash: sha256_text(options.remote_text),
      chapter_count: 2,
    })),
    read_metadata: vi.fn(),
  };
  const lock = {
    run: async <T>(_project_path: string, action: () => Promise<T>): Promise<T> => await action(),
  };
  const service = new NovelSourceService({
    paths,
    database,
    session_state,
    client: client as unknown as NoveliaClient,
    snapshots,
    writer: {
      replace_remote_asset: async (request) => {
        writer.requests.push(request);
        return { accepted: true as const, changes: [] };
      },
    } satisfies RemoteAssetWriter,
    project_lock: lock as unknown as ProjectFileLock,
  });
  if (options.bound !== false) {
    const binding = create_binding(options.text);
    await database.transaction(lg_path, (database_writer) => {
      database_writer.add_asset(lg_path, ASSET_PATH, Buffer.from(options.text), "TXT", null);
      database_writer.set_items(
        lg_path,
        options.text.split("\n").map((src, row) => ({
          id: row + 1,
          row,
          src,
          dst: `译文:${src}`,
          name_src: null,
          name_dst: null,
          extra_field: "",
          tag: "",
          file_type: "TXT",
          file_path: ASSET_PATH,
          status: "PROCESSED",
          skip_internal_filter: false,
        })),
      );
      database_writer.set_meta(lg_path, REMOTE_SOURCE_META_KEY, binding as unknown as JsonValue);
      if (options.target_language !== undefined) {
        database_writer.set_meta(lg_path, "target_language", options.target_language);
      }
    });
  }
  return { service, database, snapshots, writer, client, lg_path };
}

function create_binding(text: string): RemoteSourceBinding {
  return build_remote_source_binding({
    ref: parse_novel_url(NOVEL_URL),
    title: "テスト小説",
    asset_path: ASSET_PATH,
    remote_hash: sha256_text(text),
    chapter_count: 2,
    synced_at: "2026-10-20T00:00:00.000Z",
  });
}

let temp_dir = "";

beforeEach(() => {
  temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-novel-source-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  fs.rmSync(temp_dir, { recursive: true, force: true });
});

describe("NovelSourceService", () => {
  it("未绑定工程读取空绑定并拒绝同步", async () => {
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: CURRENT_TEXT,
      bound: false,
    });
    try {
      await expect(fixture.service.read_bound_source()).resolves.toEqual({
        binding: null,
        asset_present: false,
        snapshot_present: false,
      });
      await expect(fixture.service.preview_sync()).rejects.toMatchObject({
        code: "remote.source_not_bound",
      });
      expect(fixture.writer.requests).toHaveLength(0);
    } finally {
      await fixture.database.close();
    }
  });

  it("下载整本写入暂存并支持提交快照与重复清理", async () => {
    const fixture = await create_fixture({ text: CURRENT_TEXT, remote_text: CURRENT_TEXT });
    try {
      const prepared = await fixture.service.prepare_import(NOVEL_URL);
      expect(prepared.text).toBe(CURRENT_TEXT);
      expect(prepared.content_hash).toBe(sha256_text(CURRENT_TEXT));
      expect(prepared.binding).toMatchObject({
        origin: "https://n.novelia.cc",
        kind: "web",
        provider_id: "kakuyomu",
        novel_id: "12345",
        asset_path: ASSET_PATH,
      });
      expect(fs.readFileSync(prepared.source_path, "utf8")).toBe(CURRENT_TEXT);

      await prepared.commit_snapshot(fixture.lg_path);
      expect(fixture.snapshots.read(fixture.lg_path)?.text).toBe(CURRENT_TEXT);

      const staging_directory = path.dirname(prepared.source_path);
      await prepared.dispose();
      expect(fs.existsSync(staging_directory)).toBe(false);
      await expect(prepared.dispose()).resolves.toBeUndefined();
    } finally {
      await fixture.database.close();
    }
  });

  it("预览保留章级差异，auto 应用写入快照并消费人工覆盖", async () => {
    const remote_text = `${CURRENT_TEXT}\n# 第三章\n第四行`;
    const fixture = await create_fixture({ text: CURRENT_TEXT, remote_text });
    try {
      const preview = await fixture.service.preview_sync();
      expect(preview).toMatchObject({
        previous_source: "current_asset",
        snapshot_available: false,
        current_asset_changed: false,
        remote_hash: sha256_text(remote_text),
        files_revision: 0,
        items_revision: 0,
      });
      expect(preview.chapters.find((chapter) => chapter.index === 2)).toMatchObject({
        kind: "chapter",
        title: "第三章",
        status: "added",
      });

      const align = fixture.service.read_align_preview({
        stash_id: preview.stash_id,
        chapter_index: 2,
      });
      expect(
        align.rows.map((row) => [row.row, row.src, row.decision, row.old_src, row.old_dst]),
      ).toEqual([
        [5, "# 第三章", "retranslate", null, null],
        [6, "第四行", "retranslate", null, null],
      ]);

      await expect(
        fixture.service.apply_sync_request({
          mode: "auto",
          stash_id: preview.stash_id,
          overrides: [{ row: 1, src_hash: "0".repeat(64), action: "keep" }],
        }),
      ).rejects.toMatchObject({ code: "remote.alignment_stale" });

      const applied = await fixture.service.apply_sync_request({
        mode: "auto",
        stash_id: preview.stash_id,
        overrides: [{ row: 1, src_hash: sha256_text("第一行"), action: "keep", dst: "手改译文" }],
      });
      expect(applied.mode).toBe("auto");
      expect(applied.skipped_chapters).toEqual([]);
      expect(applied.binding.remote_hash).toBe(sha256_text(remote_text));
      expect(applied.binding.chapter_count).toBe(3);
      expect(fixture.writer.requests).toHaveLength(1);
      const request = fixture.writer.requests[0]!;
      expect(request.assetPath).toBe(ASSET_PATH);
      expect(request.content).toBe(remote_text);
      expect(request.expectedSectionRevisions).toEqual({ files: 0, items: 0 });
      expect(request.overrides.get(1)).toEqual({ action: "keep", dst: "手改译文" });
      expect(fixture.snapshots.read(fixture.lg_path)?.text).toBe(remote_text);

      await expect(
        fixture.service.apply_sync_request({ mode: "auto", stash_id: preview.stash_id }),
      ).rejects.toMatchObject({ code: "remote.stash_expired" });
    } finally {
      await fixture.database.close();
    }
  });

  it("目标语言为简体中文时同步预览读取站点译文并写入行计划", async () => {
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: CURRENT_TEXT,
      translations: new Map([[4, "站点第三行"]]),
      target_language: "ZH",
    });
    try {
      const preview = await fixture.service.preview_sync();
      expect(fixture.client.download).toHaveBeenCalledWith(expect.anything(), undefined, {
        translations: true,
      });
      const align = fixture.service.read_align_preview({
        stash_id: preview.stash_id,
        chapter_index: 1,
      });
      expect(align.rows.find((row) => row.row === 4)?.remote_dst).toBe("站点第三行");
    } finally {
      await fixture.database.close();
    }
  });

  it("其他目标语言不读取站点译文", async () => {
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: CURRENT_TEXT,
      translations: new Map([[4, "站点第三行"]]),
      target_language: "EN",
    });
    try {
      const preview = await fixture.service.preview_sync();
      expect(fixture.client.download).toHaveBeenCalledWith(expect.anything(), undefined, {
        translations: false,
      });
      const align = fixture.service.read_align_preview({
        stash_id: preview.stash_id,
        chapter_index: 1,
      });
      expect(align.rows.find((row) => row.row === 4)?.remote_dst).toBeNull();
    } finally {
      await fixture.database.close();
    }
  });

  it("add_only 只追回新增章节并报告被跳过的修改", async () => {
    const remote_text = `# 第一章\n第一行改\n第二行\n${CHAPTER_TWO}\n# 第三章\n第四行`;
    const fixture = await create_fixture({ text: CURRENT_TEXT, remote_text });
    try {
      const preview = await fixture.service.preview_sync();
      expect(preview.chapters.find((chapter) => chapter.index === 0)?.status).toBe("modified");

      await expect(
        fixture.service.apply_sync_request({
          mode: "add_only",
          stash_id: preview.stash_id,
          overrides: [{ row: 1, src_hash: sha256_text("第一行改"), action: "retranslate" }],
        }),
      ).rejects.toMatchObject({ code: "request.validation_failed" });
      expect(fixture.writer.requests).toHaveLength(0);

      const applied = await fixture.service.apply_sync_request({
        mode: "add_only",
        stash_id: preview.stash_id,
      });
      expect(applied.skipped_chapters).toEqual(["第一章"]);
      expect(fixture.writer.requests[0]?.content).toBe(`${CURRENT_TEXT}\n\n# 第三章\n第四行\n`);
      expect(fixture.writer.requests[0]?.overrides.size).toBe(0);
      expect(fixture.snapshots.read(fixture.lg_path)?.text).toBe(
        `${CURRENT_TEXT}\n\n# 第三章\n第四行\n`,
      );
    } finally {
      await fixture.database.close();
    }
  });

  it("预览后资产被替换时整批拒绝并清除暂存", async () => {
    const remote_text = `${CURRENT_TEXT}\n# 第三章\n第四行`;
    const fixture = await create_fixture({ text: CURRENT_TEXT, remote_text });
    try {
      const preview = await fixture.service.preview_sync();
      await fixture.database.transaction(fixture.lg_path, (writer) => {
        writer.update_asset(
          fixture.lg_path,
          ASSET_PATH,
          Buffer.from(`${CURRENT_TEXT}\n外部修改`),
          "TXT",
          null,
        );
      });

      await expect(
        fixture.service.apply_sync_request({ mode: "auto", stash_id: preview.stash_id }),
      ).rejects.toMatchObject({ code: "remote.alignment_stale" });
      expect(fixture.writer.requests).toHaveLength(0);
      await expect(
        fixture.service.apply_sync_request({ mode: "auto", stash_id: preview.stash_id }),
      ).rejects.toMatchObject({ code: "remote.stash_expired" });
    } finally {
      await fixture.database.close();
    }
  });

  it("预览后条目修订推进时拒绝提交", async () => {
    const remote_text = `${CURRENT_TEXT}\n# 第三章\n第四行`;
    const fixture = await create_fixture({ text: CURRENT_TEXT, remote_text });
    try {
      const preview = await fixture.service.preview_sync();
      await fixture.database.transaction(fixture.lg_path, (writer) => {
        writer.set_meta(fixture.lg_path, "project_runtime_revision.items", 2);
      });

      await expect(
        fixture.service.apply_sync_request({ mode: "auto", stash_id: preview.stash_id }),
      ).rejects.toMatchObject({ code: "data.revision_conflict" });
      expect(fixture.writer.requests).toHaveLength(0);
    } finally {
      await fixture.database.close();
    }
  });

  it("暂存超过十分钟后要求重新预览", async () => {
    const remote_text = `${CURRENT_TEXT}\n# 第三章\n第四行`;
    const fixture = await create_fixture({ text: CURRENT_TEXT, remote_text });
    try {
      const preview = await fixture.service.preview_sync();
      const now = Date.now();
      const spy = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1_000);

      await expect(
        fixture.service.apply_sync_request({ mode: "auto", stash_id: preview.stash_id }),
      ).rejects.toMatchObject({ code: "remote.stash_expired" });
      expect(fixture.writer.requests).toHaveLength(0);
      spy.mockRestore();
    } finally {
      await fixture.database.close();
    }
  });
});
