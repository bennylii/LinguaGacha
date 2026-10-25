import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../shared/error/app-error";
import type { NoveliaClient, RemoteChapterTask, RemoteWorkspaceChapter } from "./novelia-client";
import {
  RemoteChapterService,
  type RemoteChapterImporter,
  type RemoteChapterImportRequest,
} from "./remote-chapter-service";
import type { NovelSourceService } from "./novel-source-service";
import type { RemoteSourceBinding } from "./remote-source";

const WEB_BINDING: RemoteSourceBinding = {
  origin: "https://n.novelia.cc",
  host: "n.novelia.cc",
  kind: "web",
  provider_id: "kakuyomu",
  novel_id: "123456",
  url: "https://n.novelia.cc/novel/kakuyomu/123456",
  title: "测试小说",
  asset_path: "测试小说.txt",
  remote_hash: "hash",
  chapter_count: 3,
  synced_at: "2026-10-01T10:00:00",
};

const WENKU_BINDING: RemoteSourceBinding = {
  ...WEB_BINDING,
  kind: "wenku",
  provider_id: "",
  novel_id: "abc",
  url: "https://n.novelia.cc/wenku/abc",
};

function web_chapters(): RemoteWorkspaceChapter[] {
  return [
    { chapter_id: "c1", volume_id: null, title: "第一章", translated: true },
    { chapter_id: "c2", volume_id: null, title: "第二章", translated: false },
    { chapter_id: "c3", volume_id: null, title: "第三章", translated: false },
  ];
}

function task(paragraphs: string[]): RemoteChapterTask {
  return {
    paragraph_jp: paragraphs,
    old_paragraph_zh: null,
    glossary_id: "no glossary",
    glossary: {},
    old_glossary_id: null,
  };
}

interface Fixture {
  service: RemoteChapterService;
  read_workspace: ReturnType<typeof vi.fn>;
  read_chapter_task: ReturnType<typeof vi.fn>;
  import_under_agent: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  staged_files: () => string[];
}

function create_service(options: {
  binding: RemoteSourceBinding | null;
  chapters: RemoteWorkspaceChapter[];
  tasks: (
    ref: unknown,
    chapter: RemoteWorkspaceChapter,
    options: { sync: boolean },
  ) => RemoteChapterTask;
  refresh_result?: boolean;
  import_error?: Error;
}): Fixture {
  const read_workspace = vi.fn(async () => ({
    title_jp: "作品",
    title_zh: null,
    introduction_jp: "",
    introduction_zh: null,
    glossary_id: "g1",
    glossary: {},
    chapters: options.chapters,
  }));
  const read_chapter_task = vi.fn(options.tasks);
  const client = { read_workspace, read_chapter_task } as unknown as NoveliaClient;
  const staging_root = fs.mkdtempSync(path.join(os.tmpdir(), "lg-chapter-staging-"));
  const staged: string[] = [];
  const sources = {
    read_bound_source: vi.fn(async () => ({
      binding: options.binding,
      asset_present: options.binding !== null,
      snapshot_present: false,
    })),
    stage_text: vi.fn(async (file_name: string, text: string) => {
      const directory = fs.mkdtempSync(path.join(staging_root, "run-"));
      const source_path = path.join(directory, file_name);
      fs.writeFileSync(source_path, text, "utf8");
      staged.push(source_path);
      return {
        source_path,
        dispose: async () => {
          staged.splice(staged.indexOf(source_path), 1);
          fs.rmSync(directory, { recursive: true, force: true });
        },
      };
    }),
  } as unknown as Pick<NovelSourceService, "read_bound_source" | "stage_text">;
  const import_under_agent = vi.fn(async (request: { source_path: string; file_name: string }) => {
    if (options.import_error !== undefined) throw options.import_error;
    return { asset_path: `工作台/${request.file_name}`, write: { accepted: true, changes: [] } };
  });
  const refresh = vi.fn(async () => options.refresh_result ?? false);
  const service = new RemoteChapterService({
    sources,
    client,
    importer: {
      import_source_file_under_agent: import_under_agent,
    } as unknown as RemoteChapterImporter,
    refresh_credentials: refresh,
  });
  return {
    service,
    read_workspace,
    read_chapter_task,
    import_under_agent,
    refresh,
    staged_files: () => staged,
  };
}

describe("RemoteChapterService", () => {
  const temp_dirs: string[] = [];

  afterEach(() => {
    for (const dir of temp_dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("列出站点目录并支持过滤与分页", async () => {
    const fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: () => task(["一"]),
    });
    const page = await fixture.service.list_chapters({ query: "第二" });
    expect(page).toMatchObject({
      origin: "https://n.novelia.cc",
      host: "n.novelia.cc",
      kind: "web",
      title: "作品",
      total: 1,
    });
    expect(page.chapters).toEqual([
      { index: 2, chapter_id: "c2", volume_id: null, title: "第二章", translated: false },
    ]);
    const all = await fixture.service.list_chapters({ offset: 1, limit: 1 });
    expect(all.total).toBe(3);
    expect(all.chapters.map((chapter) => chapter.chapter_id)).toEqual(["c2"]);
    expect(fixture.read_workspace).toHaveBeenCalledTimes(2);
  });

  it("未绑定工程时拒绝章节读取", async () => {
    const fixture = create_service({
      binding: null,
      chapters: [],
      tasks: () => task(["一"]),
    });
    await expect(fixture.service.list_chapters()).rejects.toThrow(
      expect.objectContaining({ code: "remote.source_not_bound" }),
    );
    await expect(fixture.service.import_chapter({ chapter_id: "c1" })).rejects.toThrow(
      expect.objectContaining({ code: "remote.source_not_bound" }),
    );
  });

  it("导入网页小说缓存章节并清理暂存", async () => {
    const fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: (_ref, _chapter, options) => {
        expect(options).toEqual({ sync: false });
        return task(["第一段", "第二段"]);
      },
    });
    const result = await fixture.service.import_chapter({ chapter_id: "c2" });
    expect(result).toMatchObject({
      imported: true,
      asset_path: "工作台/测试小说 - 第二章.txt",
      chapter_id: "c2",
      volume_id: null,
      title: "第二章",
      paragraph_count: 2,
      translated: false,
    });
    expect(fixture.read_chapter_task.mock.calls[0]?.[1]).toMatchObject({ chapter_id: "c2" });
    expect(fixture.import_under_agent).toHaveBeenCalledTimes(1);
    expect(fixture.import_under_agent.mock.calls[0]?.[0].file_name).toBe("测试小说 - 第二章.txt");
    expect(fixture.staged_files()).toEqual([]);
  });

  it("导入失败时同样清理暂存", async () => {
    const fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: () => task(["第一段"]),
      import_error: new AppError("remote.fetch_failed"),
    });
    await expect(fixture.service.import_chapter({ chapter_id: "c1" })).rejects.toThrow(
      expect.objectContaining({ code: "remote.fetch_failed" }),
    );
    expect(fixture.staged_files()).toEqual([]);
  });

  it("文库同名章节 ID 必须提供分卷，唯一时自动解析", async () => {
    const chapters: RemoteWorkspaceChapter[] = [
      { chapter_id: "001.txt", volume_id: "v1.txt", title: "第一卷 001.txt", translated: true },
      { chapter_id: "001.txt", volume_id: "v2.txt", title: "第二卷 001.txt", translated: false },
      { chapter_id: "002.txt", volume_id: "v1.txt", title: "第一卷 002.txt", translated: false },
    ];
    const fixture = create_service({
      binding: WENKU_BINDING,
      chapters,
      tasks: () => task(["一"]),
    });
    await expect(fixture.service.import_chapter({ chapter_id: "001.txt" })).rejects.toThrow(
      expect.objectContaining({ code: "request.validation_failed" }),
    );
    const resolved = await fixture.service.import_chapter({
      chapter_id: "001.txt",
      volume_id: "v2.txt",
    });
    expect(resolved).toMatchObject({ volume_id: "v2.txt", title: "第二卷 001.txt" });
    const unique = await fixture.service.import_chapter({ chapter_id: "002.txt" });
    expect(unique).toMatchObject({ volume_id: "v1.txt" });
  });

  it("未知章节与空章节分别返回未找到与不导入", async () => {
    const fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: () => task([]),
    });
    await expect(fixture.service.import_chapter({ chapter_id: "missing" })).rejects.toThrow(
      expect.objectContaining({ code: "remote.chapter_not_found" }),
    );
    const empty = await fixture.service.import_chapter({ chapter_id: "c1" });
    expect(empty).toMatchObject({ imported: false, reason: "chapter_empty", asset_path: null });
    expect(fixture.import_under_agent).not.toHaveBeenCalled();
  });

  it("凭据被拒绝时先续期再重试一次", async () => {
    let attempts = 0;
    const fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: () => {
        attempts += 1;
        if (attempts === 1) throw new AppError("remote.auth_rejected");
        return task(["重试后"]);
      },
      refresh_result: true,
    });
    const result = await fixture.service.import_chapter({ chapter_id: "c1" });
    expect(result).toMatchObject({ imported: true, paragraph_count: 1 });
    expect(fixture.refresh).toHaveBeenCalledWith("https://n.novelia.cc");
    expect(attempts).toBe(2);
  });

  it("续期失败时保持认证拒绝错误", async () => {
    const fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: () => {
        throw new AppError("remote.auth_rejected");
      },
      refresh_result: false,
    });
    const request: RemoteChapterImportRequest = { chapter_id: "c1" };
    await expect(fixture.service.import_chapter(request)).rejects.toThrow(
      expect.objectContaining({ code: "remote.auth_rejected" }),
    );
    expect(fixture.import_under_agent).not.toHaveBeenCalled();
  });
});
