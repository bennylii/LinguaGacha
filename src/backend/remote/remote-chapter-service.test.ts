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

function read_task(options?: {
  paragraphs?: string[];
  old_paragraph_zh?: string[] | null;
  glossary_id?: string;
  old_glossary_id?: string | null;
}): RemoteChapterTask {
  return {
    paragraph_jp: options?.paragraphs ?? ["第一段", "第二段", "第三段"],
    old_paragraph_zh: options?.old_paragraph_zh ?? null,
    glossary_id: options?.glossary_id ?? "g2",
    glossary: {},
    old_glossary_id: options?.old_glossary_id ?? null,
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

  it("纯读取返回原文与站点旧译文，固定 sync=false", async () => {
    const fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: (_ref, _chapter, options) => {
        expect(options).toEqual({ sync: false });
        return read_task({
          paragraphs: ["第一段", "", "第三段"],
          old_paragraph_zh: ["第一段译文", "", ""],
          glossary_id: "g2",
          old_glossary_id: "g1",
        });
      },
    });
    const result = await fixture.service.read_chapter({ chapter_id: "c2" });
    expect(result).toMatchObject({
      chapter_id: "c2",
      volume_id: null,
      title: "第二章",
      translated: false,
      total_paragraphs: 3,
      glossary_id: "g2",
      old_glossary_id: "g1",
      translation_current: false,
    });
    expect(result.paragraphs).toEqual([
      { n: 1, jp: "第一段", zh: "第一段译文" },
      { n: 2, jp: "", zh: "" },
      { n: 3, jp: "第三段", zh: "" },
    ]);
    expect(fixture.import_under_agent).not.toHaveBeenCalled();
    expect(fixture.staged_files()).toEqual([]);
  });

  it("没有站点旧译文时 zh 为 null 且 translation_current 为 false", async () => {
    const fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: () => read_task({ old_paragraph_zh: null, old_glossary_id: null }),
    });
    const result = await fixture.service.read_chapter({ chapter_id: "c1" });
    expect(result.paragraphs).toEqual([
      { n: 1, jp: "第一段", zh: null },
      { n: 2, jp: "第二段", zh: null },
      { n: 3, jp: "第三段", zh: null },
    ]);
    expect(result.translation_current).toBe(false);
  });

  it("术语表一致时 translation_current 为 true", async () => {
    const fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: () => read_task({ glossary_id: "g1", old_glossary_id: "g1" }),
    });
    const result = await fixture.service.read_chapter({ chapter_id: "c1" });
    expect(result.translation_current).toBe(true);
  });

  it("段落分页保留原始段号并计算 next_offset", async () => {
    const fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: () => read_task({ paragraphs: ["一", "二", "三", "四", "五"] }),
    });
    const page = await fixture.service.read_chapter({ chapter_id: "c1", offset: 2, limit: 2 });
    expect(page.offset).toBe(2);
    expect(page.paragraphs.map((paragraph) => paragraph.n)).toEqual([3, 4]);
    expect(page.next_offset).toBe(4);
    expect(page.truncated).toBe(true);
    const last = await fixture.service.read_chapter({ chapter_id: "c1", offset: 4 });
    expect(last.paragraphs.map((paragraph) => paragraph.n)).toEqual([5]);
    expect(last.next_offset).toBeNull();
    expect(last.truncated).toBe(false);
  });

  it("字符预算在段落之间截断，超长首段仍返回", async () => {
    const fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: () =>
        read_task({
          paragraphs: ["很长".repeat(20), "短一", "短二"],
          old_paragraph_zh: ["翻译".repeat(20), "", ""],
        }),
    });
    const result = await fixture.service.read_chapter({ chapter_id: "c1", max_chars: 80 });
    expect(result.paragraphs.map((paragraph) => paragraph.n)).toEqual([1]);
    expect(result.next_offset).toBe(1);
    expect(result.truncated).toBe(true);
    const rest = await fixture.service.read_chapter({
      chapter_id: "c1",
      offset: 1,
      max_chars: 90,
    });
    expect(rest.paragraphs.map((paragraph) => paragraph.n)).toEqual([2, 3]);
    expect(rest.truncated).toBe(false);
  });

  it("offset 越界返回空页而不是章节错误", async () => {
    const fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: () => read_task(),
    });
    const result = await fixture.service.read_chapter({ chapter_id: "c1", offset: 99 });
    expect(result.total_paragraphs).toBe(3);
    expect(result.paragraphs).toEqual([]);
    expect(result.next_offset).toBeNull();
    expect(result.truncated).toBe(false);
  });

  it("纯读取沿用绑定、消歧与未找到错误", async () => {
    const fixture = create_service({
      binding: WENKU_BINDING,
      chapters: [
        { chapter_id: "001.txt", volume_id: "v1.txt", title: "第一卷 001.txt", translated: true },
        { chapter_id: "001.txt", volume_id: "v2.txt", title: "第二卷 001.txt", translated: false },
      ],
      tasks: () => read_task(),
    });
    await expect(fixture.service.read_chapter({ chapter_id: "001.txt" })).rejects.toThrow(
      expect.objectContaining({ code: "request.validation_failed" }),
    );
    const resolved = await fixture.service.read_chapter({
      chapter_id: "001.txt",
      volume_id: "v2.txt",
    });
    expect(resolved).toMatchObject({ volume_id: "v2.txt", title: "第二卷 001.txt" });
    await expect(fixture.service.read_chapter({ chapter_id: "missing" })).rejects.toThrow(
      expect.objectContaining({ code: "remote.chapter_not_found" }),
    );
  });

  it("未绑定时拒绝纯读取", async () => {
    const fixture = create_service({
      binding: null,
      chapters: [],
      tasks: () => read_task(),
    });
    await expect(fixture.service.read_chapter({ chapter_id: "c1" })).rejects.toThrow(
      expect.objectContaining({ code: "remote.source_not_bound" }),
    );
  });

  it("网页小说空缓存返回 sync_available 提示，非空时不返回", async () => {
    const fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: (_ref, _chapter, options) => {
        expect(options).toEqual({ sync: false });
        return task([]);
      },
    });
    const empty = await fixture.service.read_chapter({ chapter_id: "c1" });
    expect(empty.total_paragraphs).toBe(0);
    expect(empty.sync_available).toBe(true);
    const fixture_with_content = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: () => task(["第一段"]),
    });
    const filled = await fixture_with_content.service.read_chapter({ chapter_id: "c1" });
    expect(filled.sync_available).toBeUndefined();
  });

  it("文库空缓存不返回 sync_available 提示", async () => {
    const fixture = create_service({
      binding: WENKU_BINDING,
      chapters: [
        { chapter_id: "001.txt", volume_id: "v1.txt", title: "第一卷 001.txt", translated: false },
      ],
      tasks: () => task([]),
    });
    const result = await fixture.service.read_chapter({ chapter_id: "001.txt", volume_id: "v1.txt" });
    expect(result.total_paragraphs).toBe(0);
    expect(result.sync_available).toBeUndefined();
  });

  it("章节同步固定 sync=true 且只返回缓存结果", async () => {
    const fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: (_ref, _chapter, options) => {
        expect(options).toEqual({ sync: true });
        return read_task({
          paragraphs: ["同步后的第一段", "同步后的第二段"],
          glossary_id: "g2",
          old_glossary_id: "g1",
        });
      },
    });
    const result = await fixture.service.sync_chapter({ chapter_id: "c2", max_chars: 100 });
    expect(result).toMatchObject({
      chapter_id: "c2",
      volume_id: null,
      title: "第二章",
      total_paragraphs: 2,
      offset: 0,
      translation_current: false,
    });
    expect(result.paragraphs).toEqual([
      { n: 1, jp: "同步后的第一段", zh: null },
      { n: 2, jp: "同步后的第二段", zh: null },
    ]);
    expect(fixture.import_under_agent).not.toHaveBeenCalled();
    expect(fixture.staged_files()).toEqual([]);
  });

  it("文库作品拒绝章节同步", async () => {
    const fixture = create_service({
      binding: WENKU_BINDING,
      chapters: [
        { chapter_id: "001.txt", volume_id: "v1.txt", title: "第一卷 001.txt", translated: false },
      ],
      tasks: () => read_task(),
    });
    await expect(
      fixture.service.sync_chapter({ chapter_id: "001.txt", volume_id: "v1.txt" }),
    ).rejects.toThrow(expect.objectContaining({ code: "remote.sync_unsupported" }));
    // 任务读取发生在类型检查之前：站点请求已发出，但结果不返回给调用方。
    expect(fixture.read_chapter_task).toHaveBeenCalledTimes(1);
  });

  it("章节同步沿用绑定、未找到与凭据续期语义", async () => {
    const fixture = create_service({
      binding: null,
      chapters: [],
      tasks: () => read_task(),
    });
    await expect(fixture.service.sync_chapter({ chapter_id: "c1" })).rejects.toThrow(
      expect.objectContaining({ code: "remote.source_not_bound" }),
    );
    let attempts = 0;
    const auth_fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: () => {
        attempts += 1;
        if (attempts === 1) throw new AppError("remote.auth_rejected");
        return read_task();
      },
      refresh_result: true,
    });
    const result = await auth_fixture.service.sync_chapter({ chapter_id: "c1" });
    expect(result.total_paragraphs).toBe(3);
    expect(auth_fixture.refresh).toHaveBeenCalledWith("https://n.novelia.cc");
    expect(attempts).toBe(2);
    const missing_fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: () => read_task(),
    });
    await expect(missing_fixture.service.sync_chapter({ chapter_id: "missing" })).rejects.toThrow(
      expect.objectContaining({ code: "remote.chapter_not_found" }),
    );
  });

  it("凭据续期同样适用于纯读取", async () => {
    let attempts = 0;
    const fixture = create_service({
      binding: WEB_BINDING,
      chapters: web_chapters(),
      tasks: () => {
        attempts += 1;
        if (attempts === 1) throw new AppError("remote.auth_rejected");
        return read_task();
      },
      refresh_result: true,
    });
    const result = await fixture.service.read_chapter({ chapter_id: "c1" });
    expect(result.total_paragraphs).toBe(3);
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
