import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "../../domain/json";
import { AppError } from "../../shared/error/app-error";
import { ProjectDatabase } from "../database/database-operations";
import { EpubAst, is_epub_content_item } from "../file/epub/epub-ast";
import type {
  RemoteAssetReplaceOptions,
  RemoteAssetReplaceRequest,
} from "../project/project-content-service";
import {
  create_volume_epub_fixture,
  read_epub_entry_text,
  type VolumeDocumentFixture,
} from "../../test/epub-fixture";
import { read_zip_fixture, write_zip } from "../../test/zip-fixture";
import type { ProjectFileLock } from "../project/project-file-lock";
import { ProjectSessionState } from "../project/project-session-state";
import type { NoveliaClient, RemoteNovelDownload } from "./novelia-client";
import { NovelSourceService, type RemoteAssetWriter } from "./novel-source-service";
import { parse_novel_url, sha256_text } from "./novelia-source";
import { RemoteSnapshotStore } from "./remote-snapshot-store";
import {
  build_remote_source_binding,
  REMOTE_EPUB_MAP_META_KEY,
  REMOTE_SOURCE_META_KEY,
  type RemoteSourceBinding,
} from "./remote-source";
import { build_wenku_epub_map, build_wenku_epub_package } from "./wenku-epub-source";

const NOVEL_URL = "https://n.novelia.cc/novel/kakuyomu/12345";
const WENKU_URL = "https://n.novelia.cc/wenku/67890";
const ASSET_PATH = "テスト小説.txt";
const CHAPTER_ONE = "# 第一章\n第一行\n第二行";
const CHAPTER_TWO = "# 第二章\n第三行";
const CURRENT_TEXT = `${CHAPTER_ONE}\n${CHAPTER_TWO}`;
const EPUB_ASSET_PATH = "テスト小説.epub";

/** 两章 EPUB 夹具：标题用 h2，正文用 p，便于验证同步保留文档结构。 */
async function create_test_epub(): Promise<Buffer> {
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
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`,
  );
  zip.set(
    "OPS/ch1.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h2>第一章</h2><p>第一行</p><p>第二行</p>
</body></html>`,
  );
  zip.set(
    "OPS/ch2.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h2>第二章</h2><p>第三行</p>
</body></html>`,
  );
  return await write_zip(zip);
}

interface Fixture {
  service: NovelSourceService;
  database: ProjectDatabase;
  snapshots: RemoteSnapshotStore;
  writer: {
    requests: RemoteAssetReplaceRequest[];
    replace_options: Array<RemoteAssetReplaceOptions | undefined>;
    bind_requests: RemoteSourceBinding[];
  };
  client: { download: ReturnType<typeof vi.fn> };
  lg_path: string;
}

/** 每个用例独立 .lg 与 userdata，避免暂存、快照与修订互相影响。 */
async function create_fixture(options: {
  text: string;
  remote_text: string;
  bound?: boolean;
  asset_type?: "TXT" | "PDF" | "EPUB" | "NONE";
  asset_path?: string;
  epub?: Buffer;
  fail_bind?: boolean | "committed";
  name?: string;
  on_download?: (context: { database: ProjectDatabase; lg_path: string }) => Promise<void>;
  translations?: ReadonlyMap<number, string>;
  target_language?: "ZH" | "EN";
}): Promise<Fixture> {
  const database = new ProjectDatabase("1.0.0");
  const lg_path = path.join(temp_dir, `${options.name ?? "demo"}.lg`);
  await database.create_project(lg_path, "demo");
  const session_state = new ProjectSessionState();
  await session_state.mark_loaded(lg_path);
  const paths = {
    get_user_data_path: (...parts: string[]) => path.join(temp_dir, "userdata", ...parts),
  };
  const snapshots = new RemoteSnapshotStore({ paths });
  const writer: Fixture["writer"] = { requests: [], replace_options: [], bind_requests: [] };
  const asset_path = options.asset_path ?? ASSET_PATH;
  const client = {
    download: vi.fn(async (): Promise<RemoteNovelDownload> => {
      await options.on_download?.({ database, lg_path });
      return {
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
        filename: asset_path,
        content_hash: sha256_text(options.remote_text),
        chapter_count: 2,
      };
    }),
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
      replace_remote_asset: async (request, options) => {
        writer.requests.push(request);
        writer.replace_options.push(options);
        return { accepted: true as const, changes: [] };
      },
      bind_remote_source: async (request) => {
        writer.bind_requests.push(request.binding);
        if (options.fail_bind === true) {
          throw new Error("bind failed");
        }
        await database.transaction(lg_path, (database_writer) => {
          database_writer.set_meta(
            lg_path,
            REMOTE_SOURCE_META_KEY,
            request.binding as unknown as JsonValue,
          );
        });
        if (options.fail_bind === "committed") {
          throw new AppError("data.committed_sync_failed");
        }
        return { accepted: true as const, changes: [] };
      },
    } satisfies RemoteAssetWriter,
    project_lock: lock as unknown as ProjectFileLock,
  });
  const file_type = options.asset_type ?? "TXT";
  const epub_bytes = options.epub ?? (file_type === "EPUB" ? await create_test_epub() : null);
  const epub_items =
    file_type === "EPUB" && epub_bytes !== null
      ? await new EpubAst().read_from_stream(epub_bytes, asset_path)
      : null;
  await database.transaction(lg_path, (database_writer) => {
    if (file_type !== "NONE") {
      database_writer.add_asset(
        lg_path,
        asset_path,
        file_type === "EPUB" && epub_bytes !== null ? epub_bytes : Buffer.from(options.text),
        file_type,
        null,
      );
      database_writer.set_items(
        lg_path,
        epub_items === null
          ? options.text.split("\n").map((src, row) => ({
              id: row + 1,
              row,
              src,
              dst: `译文:${src}`,
              name_src: null,
              name_dst: null,
              extra_field: "",
              tag: "",
              file_type,
              file_path: asset_path,
              status: "PROCESSED" as const,
              skip_internal_filter: false,
            }))
          : epub_items.map((item, index) => ({
              ...item,
              id: index + 1,
              dst: `译文:${item.src}`,
              status: "PROCESSED" as const,
            })),
      );
    }
    if (options.target_language !== undefined) {
      database_writer.set_meta(lg_path, "target_language", options.target_language);
    }
    if (options.bound !== false) {
      const binding = create_binding(options.text, asset_path);
      database_writer.set_meta(lg_path, REMOTE_SOURCE_META_KEY, binding as unknown as JsonValue);
    }
  });
  return { service, database, snapshots, writer, client, lg_path };
}

/** 文库分卷夹具体：一个已翻译章节，段落带站点双语标记。 */
async function create_bilingual_volume_epub(body: string): Promise<Uint8Array> {
  const zip = new Map<string, string | Uint8Array>();
  zip.set(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  );
  zip.set(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package version="3.0" xmlns="http://www.idpf.org/2007/opf">
  <metadata/>
  <manifest>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`,
  );
  zip.set(
    "OEBPS/Text/ch1.xhtml",
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head><body><h1>第一章</h1>${body}</body></html>`,
  );
  return write_zip(zip);
}

async function create_wenku_service(options: {
  volumes: Array<{ volume_id: string; title: string; bytes?: Uint8Array }>;
}): Promise<{
  service: NovelSourceService;
  database: ProjectDatabase;
  lg_path: string;
  snapshots: RemoteSnapshotStore;
}> {
  const database = new ProjectDatabase("1.0.0");
  const lg_path = path.join(temp_dir, `wenku-${Date.now()}.lg`);
  await database.create_project(lg_path, "wenku");
  const session_state = new ProjectSessionState();
  await session_state.mark_loaded(lg_path);
  const paths = {
    get_user_data_path: (...parts: string[]) => path.join(temp_dir, "userdata", ...parts),
  };
  const snapshots = new RemoteSnapshotStore({ paths });
  const client = {
    read_metadata: vi.fn(async () => ({
      title: "テスト小説",
      title_jp: "テスト小説",
      title_zh: null,
      introduction_jp: "",
      introduction_zh: null,
      glossary: {},
      chapter_count: 1,
      volumes: options.volumes.map((volume) => ({
        volume_id: volume.volume_id,
        title: volume.title,
      })),
    })),
    download_wenku_volume_epub: vi.fn(async (_ref: unknown, volume_id: string) => {
      const volume = options.volumes.find((candidate) => candidate.volume_id === volume_id);
      if (volume?.bytes === undefined) throw new Error("missing volume bytes");
      return volume.bytes;
    }),
    download: vi.fn(),
  };
  const service = new NovelSourceService({
    paths,
    database,
    session_state,
    client: client as unknown as NoveliaClient,
    snapshots,
    writer: {
      replace_remote_asset: async () => ({ accepted: true as const, changes: [] }),
      bind_remote_source: async () => ({ accepted: true as const, changes: [] }),
    },
    project_lock: {
      run: async <T>(_project_path: string, action: () => Promise<T>): Promise<T> => await action(),
    } as unknown as ProjectFileLock,
  });
  return { service, database, lg_path, snapshots };
}

function create_binding(text: string, assetPath = ASSET_PATH): RemoteSourceBinding {
  return build_remote_source_binding({
    ref: parse_novel_url(NOVEL_URL),
    title: "テスト小説",
    asset_path: assetPath,
    remote_hash: sha256_text(text),
    chapter_count: 2,
    synced_at: "2026-10-20T00:00:00.000Z",
  });
}

/**
 * 文库整本 EPUB 的同步夹具：本地资产、章节映射与条目都按导入管线产物构造，
 * 远端只替换分卷文档，用来验证文档级预览与写入。
 */
async function create_wenku_epub_fixture(options: {
  local: VolumeDocumentFixture[];
  remote: VolumeDocumentFixture[];
  with_map?: boolean;
}): Promise<{
  service: NovelSourceService;
  database: ProjectDatabase;
  snapshots: RemoteSnapshotStore;
  writer: Fixture["writer"];
  client: { download: ReturnType<typeof vi.fn> };
  lg_path: string;
}> {
  const database = new ProjectDatabase("1.0.0");
  const lg_path = path.join(temp_dir, "wenku-epub.lg");
  await database.create_project(lg_path, "demo");
  const session_state = new ProjectSessionState();
  await session_state.mark_loaded(lg_path);
  const paths = {
    get_user_data_path: (...parts: string[]) => path.join(temp_dir, "userdata", ...parts),
  };
  const snapshots = new RemoteSnapshotStore({ paths });
  const writer: Fixture["writer"] = { requests: [], replace_options: [], bind_requests: [] };
  const ref = parse_novel_url(WENKU_URL);
  const metadata = {
    title: "テスト小説",
    title_jp: "テスト小説",
    title_zh: null,
    introduction_jp: "",
    introduction_zh: null,
    glossary: {},
    chapter_count: 1,
    volumes: [{ volume_id: "1.epub", title: "第一卷" }],
  };
  const build = async (documents: VolumeDocumentFixture[]) => {
    const volume_bytes = await create_volume_epub_fixture(documents);
    return await build_wenku_epub_package({
      ref,
      metadata,
      client: { download_wenku_volume_epub: async () => volume_bytes },
    });
  };
  const local = await build(options.local);
  const remote_volume = await create_volume_epub_fixture(options.remote);
  const client = {
    download: vi.fn(),
    read_metadata: vi.fn(async () => metadata),
    download_wenku_volume_epub: vi.fn(async () => remote_volume),
  };
  const service = new NovelSourceService({
    paths,
    database,
    session_state,
    client: client as unknown as NoveliaClient,
    snapshots,
    writer: {
      replace_remote_asset: async (request, options) => {
        writer.requests.push(request);
        writer.replace_options.push(options);
        return { accepted: true as const, changes: [] };
      },
      bind_remote_source: async () => ({ accepted: true as const, changes: [] }),
    } satisfies RemoteAssetWriter,
    project_lock: {
      run: async <T>(_project_path: string, action: () => Promise<T>): Promise<T> => await action(),
    } as unknown as ProjectFileLock,
  });

  const items = await new EpubAst().read_from_stream(local.bytes, EPUB_ASSET_PATH);
  await database.transaction(lg_path, (database_writer) => {
    database_writer.add_asset(lg_path, EPUB_ASSET_PATH, local.bytes, "EPUB", null);
    database_writer.set_items(
      lg_path,
      items.map((item, index) => ({
        ...item,
        id: index + 1,
        dst: is_epub_content_item(item) && !item.src.startsWith("# ") ? `译文:${item.src}` : "",
        status: "PROCESSED" as const,
      })) as unknown as JsonValue[],
    );
    const binding = build_remote_source_binding({
      ref,
      title: "テスト小説",
      asset_path: EPUB_ASSET_PATH,
      remote_hash: sha256_text("local"),
      chapter_count: local.documents.length,
      synced_at: "2026-10-20T00:00:00.000Z",
    });
    database_writer.set_meta(lg_path, REMOTE_SOURCE_META_KEY, binding as unknown as JsonValue);
    if (options.with_map !== false) {
      database_writer.set_meta(
        lg_path,
        REMOTE_EPUB_MAP_META_KEY,
        build_wenku_epub_map(local) as unknown as JsonValue,
      );
    }
  });
  return { service, database, snapshots, writer, client, lg_path };
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

  it("未绑定工程在唯一 TXT 与站点文本一致时补写绑定与快照", async () => {
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: CURRENT_TEXT,
      bound: false,
    });
    try {
      const before_items = await fixture.database.get_all_items(fixture.lg_path);
      const source = await fixture.service.bind_existing(NOVEL_URL);
      expect(source.binding).toMatchObject({
        origin: "https://n.novelia.cc",
        kind: "web",
        provider_id: "kakuyomu",
        novel_id: "12345",
        title: "テスト小説",
        asset_path: ASSET_PATH,
        remote_hash: sha256_text(CURRENT_TEXT),
      });
      expect(source.asset_present).toBe(true);
      expect(source.snapshot_present).toBe(true);
      expect(fixture.writer.bind_requests).toHaveLength(1);
      expect(fixture.snapshots.read(fixture.lg_path)?.text).toBe(CURRENT_TEXT);
      expect(await fixture.database.get_all_meta(fixture.lg_path)).toMatchObject({
        [REMOTE_SOURCE_META_KEY]: { asset_path: ASSET_PATH, title: "テスト小説" },
      });
      expect(await fixture.database.get_all_items(fixture.lg_path)).toEqual(before_items);
    } finally {
      await fixture.database.close();
    }
  });

  it("补绑定文本不一致时拒绝且不写绑定或快照", async () => {
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: `${CURRENT_TEXT}\n外部修改`,
      bound: false,
    });
    try {
      const before_items = await fixture.database.get_all_items(fixture.lg_path);
      await expect(fixture.service.bind_existing(NOVEL_URL)).rejects.toMatchObject({
        code: "remote.source_mismatch",
        public_details: { reason: "text_changed" },
      });
      expect(
        (await fixture.database.get_all_meta(fixture.lg_path))[REMOTE_SOURCE_META_KEY],
      ).toBeUndefined();
      expect(fixture.snapshots.read(fixture.lg_path)).toBeNull();
      expect(fixture.writer.bind_requests).toHaveLength(0);
      expect(await fixture.database.get_all_items(fixture.lg_path)).toEqual(before_items);
    } finally {
      await fixture.database.close();
    }
  });

  it("没有资产时拒绝补绑定", async () => {
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: CURRENT_TEXT,
      bound: false,
      asset_type: "NONE",
    });
    try {
      await expect(fixture.service.bind_existing(NOVEL_URL)).rejects.toMatchObject({
        code: "remote.source_not_bindable",
        public_details: { reason: "no_assets", asset_count: 0 },
      });
      expect(fixture.writer.bind_requests).toHaveLength(0);
      expect(fixture.snapshots.read(fixture.lg_path)).toBeNull();
    } finally {
      await fixture.database.close();
    }
  });

  it("唯一资产不是可同步正文（PDF）时拒绝补绑定", async () => {
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: CURRENT_TEXT,
      bound: false,
      asset_type: "PDF",
    });
    try {
      await expect(fixture.service.bind_existing(NOVEL_URL)).rejects.toMatchObject({
        code: "remote.source_not_bindable",
        public_details: {
          reason: "asset_not_supported",
          asset_path: ASSET_PATH,
          file_type: "PDF",
        },
      });
      expect(fixture.writer.bind_requests).toHaveLength(0);
      expect(fixture.snapshots.read(fixture.lg_path)).toBeNull();
    } finally {
      await fixture.database.close();
    }
  });

  it("唯一 EPUB 资产不能补绑定，只能整本导入", async () => {
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: CURRENT_TEXT,
      bound: false,
      asset_type: "EPUB",
      asset_path: EPUB_ASSET_PATH,
    });
    try {
      const before_items = await fixture.database.get_all_items(fixture.lg_path);
      await expect(fixture.service.bind_existing(NOVEL_URL)).rejects.toMatchObject({
        code: "remote.source_not_bindable",
        public_details: { reason: "epub_requires_import", asset_path: EPUB_ASSET_PATH },
      });
      expect(fixture.writer.bind_requests).toHaveLength(0);
      expect(fixture.snapshots.read(fixture.lg_path)).toBeNull();
      expect(await fixture.database.get_all_items(fixture.lg_path)).toEqual(before_items);
    } finally {
      await fixture.database.close();
    }
  });

  it("多个 TXT 资产时拒绝补绑定", async () => {
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: CURRENT_TEXT,
      bound: false,
      name: "multiple-txt",
    });
    try {
      await fixture.database.transaction(fixture.lg_path, (writer) => {
        writer.add_asset(fixture.lg_path, "extra.txt", Buffer.from("extra"), "TXT", null);
      });
      await expect(fixture.service.bind_existing(NOVEL_URL)).rejects.toMatchObject({
        code: "remote.source_not_bindable",
        public_details: { reason: "multiple_assets", asset_count: 2 },
      });
      expect(fixture.writer.bind_requests).toHaveLength(0);
    } finally {
      await fixture.database.close();
    }
  });

  it.each(["EPUB", "PDF"] as const)(
    "唯一 TXT 伴随其他资产（%s）时拒绝补绑定",
    async (extra_type) => {
      const fixture = await create_fixture({
        text: CURRENT_TEXT,
        remote_text: CURRENT_TEXT,
        bound: false,
        name: `mixed-${extra_type.toLowerCase()}`,
      });
      try {
        await fixture.database.transaction(fixture.lg_path, (writer) => {
          writer.add_asset(
            fixture.lg_path,
            `extra.${extra_type.toLowerCase()}`,
            Buffer.from("extra"),
            extra_type,
            null,
          );
        });
        await expect(fixture.service.bind_existing(NOVEL_URL)).rejects.toMatchObject({
          code: "remote.source_not_bindable",
          public_details: {
            reason: "multiple_assets",
            asset_count: 2,
            file_types: ["TXT", extra_type],
          },
        });
        expect(fixture.writer.bind_requests).toHaveLength(0);
        expect(fixture.snapshots.read(fixture.lg_path)).toBeNull();
      } finally {
        await fixture.database.close();
      }
    },
  );

  it("唯一 TXT 内容缺失时拒绝补绑定", async () => {
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: CURRENT_TEXT,
      bound: false,
    });
    try {
      vi.spyOn(fixture.database, "read_asset_content").mockResolvedValueOnce(null);
      await expect(fixture.service.bind_existing(NOVEL_URL)).rejects.toMatchObject({
        code: "remote.source_not_bindable",
        public_details: { reason: "asset_missing", asset_path: ASSET_PATH },
      });
      expect(fixture.writer.bind_requests).toHaveLength(0);
      expect(fixture.snapshots.read(fixture.lg_path)).toBeNull();
    } finally {
      await fixture.database.close();
    }
  });

  it("下载期间新增资产时拒绝补绑定", async () => {
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: CURRENT_TEXT,
      bound: false,
      on_download: async ({ database, lg_path }) => {
        await database.transaction(lg_path, (writer) => {
          writer.add_asset(lg_path, "late.epub", Buffer.from("late"), "EPUB", null);
        });
      },
    });
    try {
      await expect(fixture.service.bind_existing(NOVEL_URL)).rejects.toMatchObject({
        code: "remote.source_not_bindable",
        public_details: { reason: "multiple_assets", asset_count: 2 },
      });
      expect(fixture.writer.bind_requests).toHaveLength(0);
      expect(fixture.snapshots.read(fixture.lg_path)).toBeNull();
    } finally {
      await fixture.database.close();
    }
  });

  it("下载期间唯一 TXT 被替换时拒绝补绑定", async () => {
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: CURRENT_TEXT,
      bound: false,
      on_download: async ({ database, lg_path }) => {
        await database.transaction(lg_path, (writer) => {
          writer.delete_asset(lg_path, ASSET_PATH);
          writer.add_asset(lg_path, "renamed.txt", Buffer.from(CURRENT_TEXT), "TXT", null);
        });
      },
    });
    try {
      await expect(fixture.service.bind_existing(NOVEL_URL)).rejects.toMatchObject({
        code: "remote.source_not_bindable",
        public_details: { reason: "asset_changed", asset_path: "renamed.txt" },
      });
      expect(fixture.writer.bind_requests).toHaveLength(0);
      expect(fixture.snapshots.read(fixture.lg_path)).toBeNull();
    } finally {
      await fixture.database.close();
    }
  });

  it("下载期间 TXT 内容变化时拒绝补绑定", async () => {
    const changed_text = `${CURRENT_TEXT}\n下载期间修改`;
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: CURRENT_TEXT,
      bound: false,
      on_download: async ({ database, lg_path }) => {
        await database.transaction(lg_path, (writer) => {
          writer.update_asset(lg_path, ASSET_PATH, Buffer.from(changed_text), "TXT", null);
        });
      },
    });
    try {
      await expect(fixture.service.bind_existing(NOVEL_URL)).rejects.toMatchObject({
        code: "remote.source_mismatch",
        public_details: { reason: "asset_changed", current_hash: sha256_text(changed_text) },
      });
      expect(fixture.writer.bind_requests).toHaveLength(0);
      expect(fixture.snapshots.read(fixture.lg_path)).toBeNull();
    } finally {
      await fixture.database.close();
    }
  });

  it("已绑定工程拒绝重复补绑定", async () => {
    const fixture = await create_fixture({ text: CURRENT_TEXT, remote_text: CURRENT_TEXT });
    try {
      await expect(fixture.service.bind_existing(NOVEL_URL)).rejects.toMatchObject({
        code: "remote.source_already_bound",
      });
      expect(fixture.writer.bind_requests).toHaveLength(0);
    } finally {
      await fixture.database.close();
    }
  });

  it("绑定写入失败时清理快照并保持未绑定", async () => {
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: CURRENT_TEXT,
      bound: false,
      fail_bind: true,
    });
    try {
      await expect(fixture.service.bind_existing(NOVEL_URL)).rejects.toThrow("bind failed");
      expect(
        (await fixture.database.get_all_meta(fixture.lg_path))[REMOTE_SOURCE_META_KEY],
      ).toBeUndefined();
      expect(fixture.snapshots.read(fixture.lg_path)).toBeNull();
      expect(fixture.writer.bind_requests).toHaveLength(1);
    } finally {
      await fixture.database.close();
    }
  });

  it("绑定已提交但通知失败时保留快照", async () => {
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: CURRENT_TEXT,
      bound: false,
      fail_bind: "committed",
    });
    try {
      await expect(fixture.service.bind_existing(NOVEL_URL)).rejects.toMatchObject({
        code: "data.committed_sync_failed",
      });
      expect(
        (await fixture.database.get_all_meta(fixture.lg_path))[REMOTE_SOURCE_META_KEY],
      ).toMatchObject({ asset_path: ASSET_PATH });
      expect(fixture.snapshots.read(fixture.lg_path)?.text).toBe(CURRENT_TEXT);
    } finally {
      await fixture.database.close();
    }
  });

  it("快照写入失败时不提交绑定", async () => {
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text: CURRENT_TEXT,
      bound: false,
    });
    try {
      vi.spyOn(fixture.snapshots, "write").mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      await expect(fixture.service.bind_existing(NOVEL_URL)).rejects.toThrow("disk full");
      expect(
        (await fixture.database.get_all_meta(fixture.lg_path))[REMOTE_SOURCE_META_KEY],
      ).toBeUndefined();
      expect(fixture.writer.bind_requests).toHaveLength(0);
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

  it("文库 EPUB 分卷整本导入为单个 EPUB 资产并沿用站点译文", async () => {
    const volume = await create_bilingual_volume_epub(
      `<p style="opacity:0.4;">日本語</p><p>中文</p>`,
    );
    const fixture = await create_wenku_service({
      volumes: [{ volume_id: "1.epub", title: "第一卷", bytes: volume }],
    });
    try {
      const prepared = await fixture.service.prepare_import(WENKU_URL, undefined, {
        translations: true,
      });
      expect(prepared.binding).toMatchObject({
        kind: "wenku",
        novel_id: "67890",
        asset_path: "テスト小説.epub",
        chapter_count: 1,
      });
      expect(path.basename(prepared.source_path)).toBe("テスト小説.epub");
      expect(prepared.text).toContain("日本語");
      expect(prepared.text).not.toContain("中文");

      const bytes = fs.readFileSync(prepared.source_path);
      const items = await new EpubAst().read_from_stream(bytes, "テスト小説.epub");
      const src_by_row = new Map(items.map((item) => [item.row, item.src]));
      const translated_rows = [...prepared.translations.keys()];
      expect(translated_rows).toHaveLength(1);
      expect(src_by_row.get(translated_rows[0]!)).toBe("日本語");
      expect(prepared.translations.get(translated_rows[0]!)).toBe("中文");

      await prepared.commit_snapshot(fixture.lg_path);
      expect(fixture.snapshots.read(fixture.lg_path)?.text).toBe(prepared.text);

      const staging_directory = path.dirname(prepared.source_path);
      await prepared.dispose();
      expect(fs.existsSync(staging_directory)).toBe(false);
    } finally {
      await fixture.database.close();
    }
  });

  it("文库分卷 TXT 与 EPUB 混用时拒绝整本导入", async () => {
    const fixture = await create_wenku_service({
      volumes: [
        { volume_id: "1.epub", title: "第一卷" },
        { volume_id: "2.txt", title: "第二卷" },
      ],
    });
    try {
      await expect(fixture.service.prepare_import(WENKU_URL)).rejects.toMatchObject({
        code: "remote.wenku_mixed_volumes",
      });
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
      expect(fixture.writer.replace_options).toEqual([undefined]);
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

  it("Agent 整本同步在写入时声明复用 Agent 写串行", async () => {
    const remote_text = `${CURRENT_TEXT}\n# 第三章\n第四行`;
    const fixture = await create_fixture({ text: CURRENT_TEXT, remote_text });
    try {
      const preview = await fixture.service.preview_sync();
      await fixture.service.apply_sync_request(
        { mode: "auto", stash_id: preview.stash_id },
        { under_agent: true },
      );

      expect(fixture.writer.replace_options).toEqual([{ under_agent: true }]);
    } finally {
      await fixture.database.close();
    }
  });

  it("EPUB 同步写回修改段落并保留未修改章节", async () => {
    const remote_text = `# 第一章\n第一行改\n第二行\n${CHAPTER_TWO}`;
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text,
      asset_type: "EPUB",
      asset_path: EPUB_ASSET_PATH,
    });
    try {
      const preview = await fixture.service.preview_sync();
      expect(preview.stats.modified).toBe(1);
      const applied = await fixture.service.apply_sync_request({
        mode: "auto",
        stash_id: preview.stash_id,
      });
      expect(applied.binding.remote_hash).toBe(sha256_text(remote_text));
      const request = fixture.writer.requests[0]!;
      expect(request.assetPath).toBe(EPUB_ASSET_PATH);
      expect(request.content).toBe(remote_text);
      expect(request.assetBytes).toBeInstanceOf(Uint8Array);
      expect(request.itemSeeds).toHaveLength(5);
      expect(request.itemSeeds?.map((seed) => seed.src)).toEqual([
        "第一章",
        "第一行改",
        "第二行",
        "第二章",
        "第三行",
      ]);
      const ch1 = await read_epub_entry_text(request.assetBytes!, "OPS/ch1.xhtml");
      const ch2 = await read_epub_entry_text(request.assetBytes!, "OPS/ch2.xhtml");
      expect(ch1).toContain("<h2>第一章</h2>");
      expect(ch1).toContain("<p>第一行改</p>");
      expect(ch1).toContain("<p>第二行</p>");
      expect(ch2).toContain("<p>第三行</p>");
      const files = await read_zip_fixture(request.assetBytes!);
      const original = await read_zip_fixture(await create_test_epub());
      expect(files.get("OPS/ch2.xhtml")).toEqual(original.get("OPS/ch2.xhtml"));
      expect(files.get("META-INF/container.xml")).toEqual(original.get("META-INF/container.xml"));
      expect(fixture.snapshots.read(fixture.lg_path)?.text).toBe(remote_text);
    } finally {
      await fixture.database.close();
    }
  });

  it("EPUB 同步新增段落和章节后重解析条目与 OPF", async () => {
    const remote_text = `# 第一章\n第一行\n第一行新增\n第二行\n${CHAPTER_TWO}\n# 第三章\n第四行`;
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text,
      asset_type: "EPUB",
      asset_path: EPUB_ASSET_PATH,
    });
    try {
      const preview = await fixture.service.preview_sync();
      const applied = await fixture.service.apply_sync_request({
        mode: "auto",
        stash_id: preview.stash_id,
      });
      expect(applied.binding.chapter_count).toBe(3);
      const request = fixture.writer.requests[0]!;
      expect(request.itemSeeds).toHaveLength(8);
      const ch1 = await read_epub_entry_text(request.assetBytes!, "OPS/ch1.xhtml");
      expect(ch1).toContain("<p>第一行新增</p>");
      const files = await read_zip_fixture(request.assetBytes!);
      const new_doc_path = [...files.keys()].find((path) => path.includes("remote-sync-"));
      expect(new_doc_path).toBeDefined();
      const new_doc =
        files.get(new_doc_path!) instanceof Uint8Array
          ? new TextDecoder().decode(files.get(new_doc_path!) as Uint8Array)
          : String(files.get(new_doc_path!));
      expect(new_doc).toContain("第三章");
      expect(new_doc).toContain("第四行");
      const opf =
        files.get("OPS/package.opf") instanceof Uint8Array
          ? new TextDecoder().decode(files.get("OPS/package.opf") as Uint8Array)
          : String(files.get("OPS/package.opf"));
      expect(opf).toContain("remote-sync-1.xhtml");
      expect(opf).toContain('idref="remote-sync-1"');
    } finally {
      await fixture.database.close();
    }
  });

  it("EPUB 在已有章节之间插入新章节时按 spine 顺序写回", async () => {
    const remote_text = [
      "# 第一章",
      "第一行",
      "第二行",
      "# 插章",
      "插行",
      "# 第二章",
      "第三行",
    ].join("\n");
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text,
      asset_type: "EPUB",
      asset_path: EPUB_ASSET_PATH,
    });
    try {
      const preview = await fixture.service.preview_sync();
      await fixture.service.apply_sync_request({
        mode: "auto",
        stash_id: preview.stash_id,
      });
      const request = fixture.writer.requests[0]!;
      expect(request.itemSeeds?.map((seed) => seed.src)).toEqual([
        "第一章",
        "第一行",
        "第二行",
        "插章",
        "插行",
        "第二章",
        "第三行",
      ]);
      const files = await read_zip_fixture(request.assetBytes!);
      expect(files.has("OPS/remote-sync-1.xhtml")).toBe(true);
      const opf =
        files.get("OPS/package.opf") instanceof Uint8Array
          ? new TextDecoder().decode(files.get("OPS/package.opf") as Uint8Array)
          : String(files.get("OPS/package.opf"));
      expect(opf.indexOf('idref="ch1"')).toBeLessThan(opf.indexOf('idref="remote-sync-1"'));
      expect(opf.indexOf('idref="remote-sync-1"')).toBeLessThan(opf.indexOf('idref="ch2"'));
    } finally {
      await fixture.database.close();
    }
  });

  it("EPUB 同步删除段落并从条目种子中移除", async () => {
    const remote_text = `# 第一章\n第一行\n${CHAPTER_TWO}`;
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text,
      asset_type: "EPUB",
      asset_path: EPUB_ASSET_PATH,
    });
    try {
      const preview = await fixture.service.preview_sync();
      expect(preview.stats.removed).toBe(1);
      await fixture.service.apply_sync_request({
        mode: "auto",
        stash_id: preview.stash_id,
      });
      const request = fixture.writer.requests[0]!;
      expect(request.itemSeeds).toHaveLength(4);
      expect(request.itemSeeds?.map((seed) => seed.src)).toEqual([
        "第一章",
        "第一行",
        "第二章",
        "第三行",
      ]);
      const ch1 = await read_epub_entry_text(request.assetBytes!, "OPS/ch1.xhtml");
      expect(ch1).not.toContain("第二行");
      expect(ch1).toContain("<p>第一行</p>");
      const ch2 = await read_epub_entry_text(request.assetBytes!, "OPS/ch2.xhtml");
      expect(ch2).toContain("<p>第三行</p>");
    } finally {
      await fixture.database.close();
    }
  });

  it("EPUB 资源变化但正文不变时提交仍判为资产过期", async () => {
    const remote_text = `# 第一章\n第一行改\n第二行\n${CHAPTER_TWO}`;
    const fixture = await create_fixture({
      text: CURRENT_TEXT,
      remote_text,
      asset_type: "EPUB",
      asset_path: EPUB_ASSET_PATH,
    });
    try {
      const preview = await fixture.service.preview_sync();
      const current_bytes = await fixture.database.read_asset_content(
        fixture.lg_path,
        EPUB_ASSET_PATH,
      );
      const files = await read_zip_fixture(current_bytes!);
      files.set("OPS/extra.css", "body { color: red; }");
      const changed_bytes = Buffer.from(await write_zip(files));
      await fixture.database.transaction(fixture.lg_path, (writer) => {
        writer.update_asset(fixture.lg_path, EPUB_ASSET_PATH, changed_bytes, "EPUB", null);
      });
      await expect(
        fixture.service.apply_sync_request({ mode: "auto", stash_id: preview.stash_id }),
      ).rejects.toMatchObject({ code: "remote.alignment_stale" });
      expect(fixture.writer.requests).toHaveLength(0);
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

  it("文库整本 EPUB：预览按文档对齐，应用连同章节映射一次写入", async () => {
    const fixture = await create_wenku_epub_fixture({
      local: [
        { href: "Text/ch1.xhtml", heading: "第一章", paragraphs: ["日本語一", "日本語二"] },
        { href: "Text/ch2.xhtml", heading: "第二章", paragraphs: ["日本語三"] },
      ],
      remote: [
        { href: "Text/ch1.xhtml", heading: "第一章", paragraphs: ["日本語一", "日本語二改"] },
        { href: "Text/ch2.xhtml", heading: "第二章", paragraphs: ["日本語三"] },
        { href: "Text/ch3.xhtml", heading: "第三章", paragraphs: ["日本語四"] },
      ],
    });
    try {
      const preview = await fixture.service.preview_sync();
      expect(fixture.client.download).not.toHaveBeenCalled();
      expect(preview).toMatchObject({
        previous_source: "current_asset",
        snapshot_available: false,
        current_asset_changed: false,
        filename: EPUB_ASSET_PATH,
      });
      expect(preview.chapters.map((chapter) => chapter.title)).toEqual([
        "第一章",
        "第二章",
        "第三章",
      ]);
      expect(preview.chapters.map((chapter) => chapter.status)).toEqual([
        "modified",
        "unchanged",
        "added",
      ]);
      expect(preview.stats.added).toBeGreaterThan(0);

      const applied = await fixture.service.apply_sync_request({
        mode: "auto",
        stash_id: preview.stash_id,
        overrides: [],
      });
      expect(applied.binding.chapter_count).toBe(3);
      expect(fixture.writer.requests).toHaveLength(1);
      const request = fixture.writer.requests[0]!;
      expect(request.assetBytes).toBeInstanceOf(Uint8Array);
      expect(request.content).toContain("日本語二改");
      expect(request.content).toContain("日本語四");
      expect(request.binding.asset_path).toBe(EPUB_ASSET_PATH);
      const map = request.extraMeta?.[REMOTE_EPUB_MAP_META_KEY];
      expect(map).toMatchObject({
        version: 1,
        documents: [
          { title: "第一章", state: "active" },
          { title: "第二章", state: "active" },
          { title: "第三章", state: "active" },
        ],
      });
      const snapshot = fixture.snapshots.read(fixture.lg_path);
      expect(snapshot?.text).toBe(request.content);
      expect(snapshot?.key.novel_id).toBe("67890");
    } finally {
      await fixture.database.close();
    }
  });

  it("文库整本 EPUB：仅追加模式保留既有章节原文", async () => {
    const fixture = await create_wenku_epub_fixture({
      local: [{ href: "Text/ch1.xhtml", heading: "第一章", paragraphs: ["旧原文"] }],
      remote: [
        { href: "Text/ch1.xhtml", heading: "第一章", paragraphs: ["新原文"] },
        { href: "Text/ch2.xhtml", heading: "第二章", paragraphs: ["追加原文"] },
      ],
    });
    try {
      const preview = await fixture.service.preview_sync();
      expect(preview.stats.modified).toBeGreaterThan(0);

      await fixture.service.apply_sync_request({
        mode: "add_only",
        stash_id: preview.stash_id,
        overrides: [],
      });
      const request = fixture.writer.requests[0]!;
      expect(request.content).toContain("旧原文");
      expect(request.content).not.toContain("新原文");
      expect(request.content).toContain("追加原文");
    } finally {
      await fixture.database.close();
    }
  });

  it("文库整本 EPUB：Agent 提交时声明复用 Agent 写串行", async () => {
    const fixture = await create_wenku_epub_fixture({
      local: [{ href: "Text/ch1.xhtml", heading: "第一章", paragraphs: ["旧原文"] }],
      remote: [{ href: "Text/ch1.xhtml", heading: "第一章", paragraphs: ["新原文"] }],
    });
    try {
      const preview = await fixture.service.preview_sync();
      await fixture.service.apply_sync_request(
        { mode: "auto", stash_id: preview.stash_id, overrides: [] },
        { under_agent: true },
      );

      expect(fixture.writer.replace_options).toEqual([{ under_agent: true }]);
    } finally {
      await fixture.database.close();
    }
  });

  it("文库整本 EPUB：缺少章节映射时要求重新导入", async () => {
    const fixture = await create_wenku_epub_fixture({
      local: [{ href: "Text/ch1.xhtml", heading: "第一章", paragraphs: ["日本語一"] }],
      remote: [{ href: "Text/ch1.xhtml", heading: "第一章", paragraphs: ["日本語一"] }],
      with_map: false,
    });
    try {
      await expect(fixture.service.preview_sync()).rejects.toMatchObject({
        code: "remote.epub_map_missing",
      });
      expect(fixture.writer.requests).toHaveLength(0);
    } finally {
      await fixture.database.close();
    }
  });
});
