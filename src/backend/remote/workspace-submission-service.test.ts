import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonValue } from "../../domain/json";
import { AppError } from "../../shared/error/app-error";
import { ProjectDatabase } from "../database/database-operations";
import { ProjectSessionState } from "../project/project-session-state";
import { RuntimeOperationGate } from "../runtime-operation-gate";
import type { NoveliaClient, RemoteChapterTask, RemoteWorkspace } from "./novelia-client";
import { parse_novel_url, sha256_text } from "./novelia-source";
import { build_remote_source_binding, REMOTE_SOURCE_META_KEY } from "./remote-source";
import {
  RemoteWorkspaceSubmissionService,
  type RemoteWorkspaceSnapshot,
} from "./workspace-submission-service";

const NOVEL_URL = "https://n.novelia.cc/novel/kakuyomu/12345";
const ASSET_PATH = "テスト小説.txt";
const ASSET_TEXT = "# 第一章\n本文一\n本文二";

interface Fixture {
  service: RemoteWorkspaceSubmissionService;
  database: ProjectDatabase;
  write_chapter_translation: ReturnType<typeof vi.fn>;
  read_chapter_task: ReturnType<typeof vi.fn>;
}

/** 工作区、项目条目与上传端口都可注入，用例只声明影响提交结果的事实。 */
async function create_fixture(options: {
  workspace: RemoteWorkspace;
  tasks: RemoteChapterTask[];
  items?: Array<{ src: string; dst: string; status: string }>;
  translation_error?: Error;
  task_error?: Error;
  pending_task?: boolean;
  novel_url?: string;
}): Promise<Fixture> {
  const database = new ProjectDatabase();
  const lg_path = path.join(temp_dir, "demo.lg");
  await database.create_project(lg_path, "demo");
  const session_state = new ProjectSessionState();
  await session_state.mark_loaded(lg_path);
  const binding = build_remote_source_binding({
    ref: parse_novel_url(options.novel_url ?? NOVEL_URL),
    title: "テスト小説",
    asset_path: ASSET_PATH,
    remote_hash: sha256_text(ASSET_TEXT),
    chapter_count: 1,
    synced_at: "2026-10-20T00:00:00.000Z",
  });
  const items = options.items ?? [
    { src: "本文一", dst: "工程一", status: "PROCESSED" },
    { src: "本文二", dst: "工程二", status: "PROCESSED" },
  ];
  await database.transaction(lg_path, (writer) => {
    writer.add_asset(lg_path, ASSET_PATH, Buffer.from(ASSET_TEXT), "TXT", null);
    writer.set_items(lg_path, [
      { id: 1, row: 0, src: "# 第一章", dst: "", status: "NONE", file_path: ASSET_PATH },
      ...items.map((item, index) => ({
        id: index + 2,
        row: index + 1,
        src: item.src,
        dst: item.dst,
        status: item.status,
        file_path: ASSET_PATH,
      })),
    ]);
    writer.set_meta(lg_path, REMOTE_SOURCE_META_KEY, binding as unknown as JsonValue);
  });

  let task_index = 0;
  const client = {
    read_workspace: vi.fn(async () => options.workspace),
    read_chapter_task: vi.fn(
      async (
        _ref: unknown,
        _chapter: unknown,
        _options: unknown,
        signal?: AbortSignal,
      ): Promise<RemoteChapterTask> => {
        if (options.task_error !== undefined) throw options.task_error;
        if (options.pending_task === true) {
          return await new Promise<RemoteChapterTask>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        const task = options.tasks[Math.min(task_index, options.tasks.length - 1)]!;
        task_index += 1;
        return task;
      },
    ),
    write_chapter_translation: vi.fn(async () => {
      if (options.translation_error !== undefined) throw options.translation_error;
    }),
  };
  const service = new RemoteWorkspaceSubmissionService({
    database,
    session_state,
    runtime_gate: new RuntimeOperationGate(),
    client: client as unknown as NoveliaClient,
  });
  return {
    service,
    database,
    write_chapter_translation: client.write_chapter_translation,
    read_chapter_task: client.read_chapter_task,
  };
}

function workspace(chapter_count: number): RemoteWorkspace {
  return {
    title_jp: "テスト小説",
    title_zh: null,
    introduction_jp: "",
    introduction_zh: null,
    glossary_id: "glossary-1",
    glossary: {},
    chapters: Array.from({ length: chapter_count }, (_value, index) => ({
      chapter_id: `chapter-${index + 1}`,
      volume_id: null,
      title: "第一章",
      translated: false,
    })),
  };
}

function task(input: Partial<RemoteChapterTask> = {}): RemoteChapterTask {
  return {
    paragraph_jp: ["本文一", "本文二"],
    old_paragraph_zh: null,
    glossary_id: "glossary-1",
    glossary: {},
    old_glossary_id: null,
    ...input,
  };
}

/** 后台提交没有完成回调，轮询到目标状态再断言。 */
async function wait_for_status(
  service: RemoteWorkspaceSubmissionService,
  status: string,
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(service.get_snapshot().status).toBe(status);
    },
    { timeout: 3_000, interval: 10 },
  );
}

let temp_dir = "";

beforeEach(() => {
  temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), "linguagacha-workspace-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  fs.rmSync(temp_dir, { recursive: true, force: true });
});

describe("RemoteWorkspaceSubmissionService", () => {
  it("只上传工程中已完成的本地译文，不采用站点旧译", async () => {
    const fixture = await create_fixture({
      workspace: workspace(1),
      tasks: [task({ old_paragraph_zh: ["站点一", "站点二"] })],
    });
    try {
      await fixture.service.start();
      await wait_for_status(fixture.service, "completed");

      expect(fixture.write_chapter_translation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ chapter_id: "chapter-1" }),
        { glossary_id: "glossary-1", paragraphs_zh: ["工程一", "工程二"] },
        expect.any(AbortSignal),
      );
      expect(fixture.service.get_snapshot()).toMatchObject({
        status: "completed",
        totals: { chapters: 1, uploaded: 1, skipped: 0, failed: 0 },
        chapters: [{ state: "uploaded", ready: 2, missing: 0, message: null }],
      });
    } finally {
      await fixture.database.close();
    }
  });

  it("逐章发布 reading、uploading 与 uploaded 进度", async () => {
    const fixture = await create_fixture({
      workspace: workspace(1),
      tasks: [task()],
    });
    const snapshots: RemoteWorkspaceSnapshot[] = [];
    const unsubscribe = fixture.service.subscribe((snapshot) => snapshots.push(snapshot));
    try {
      await fixture.service.start();
      await wait_for_status(fixture.service, "completed");
      unsubscribe();

      const states = new Set(
        snapshots.flatMap((snapshot) => snapshot.chapters.map((chapter) => chapter.state)),
      );
      expect(states).toEqual(new Set(["pending", "reading", "uploading", "uploaded"]));
      const first_uploaded = snapshots.find((snapshot) =>
        snapshot.chapters.some((chapter) => chapter.state === "uploaded"),
      );
      expect(first_uploaded?.totals.uploaded).toBe(1);
    } finally {
      await fixture.database.close();
    }
  });

  it("本地译文缺行时跳过该章并记录缺失行数", async () => {
    const fixture = await create_fixture({
      workspace: workspace(1),
      tasks: [task()],
      items: [
        { src: "本文一", dst: "工程一", status: "PROCESSED" },
        { src: "本文二", dst: "", status: "NONE" },
      ],
    });
    try {
      await fixture.service.start();
      await wait_for_status(fixture.service, "completed");

      expect(fixture.write_chapter_translation).not.toHaveBeenCalled();
      expect(fixture.service.get_snapshot()).toMatchObject({
        status: "completed",
        totals: { chapters: 1, uploaded: 0, skipped: 1, failed: 0 },
        chapters: [
          { state: "skipped", ready: 1, missing: 1, message: "local_translation_incomplete" },
        ],
      });
    } finally {
      await fixture.database.close();
    }
  });

  it("未完成的本地译文不参与上传", async () => {
    const fixture = await create_fixture({
      workspace: workspace(1),
      tasks: [task()],
      items: [
        { src: "本文一", dst: "草稿一", status: "PROCESSING" },
        { src: "本文二", dst: "草稿二", status: "PROCESSING" },
      ],
    });
    try {
      await fixture.service.start();
      await wait_for_status(fixture.service, "completed");

      expect(fixture.write_chapter_translation).not.toHaveBeenCalled();
      expect(fixture.service.get_snapshot().chapters[0]).toMatchObject({
        state: "skipped",
        ready: 0,
        missing: 2,
      });
    } finally {
      await fixture.database.close();
    }
  });

  it("上传遇到术语表失效时刷新任务并重试一次", async () => {
    let upload_attempts = 0;
    const fixture = await create_fixture({
      workspace: workspace(1),
      tasks: [task(), task({ glossary_id: "glossary-2" })],
    });
    try {
      fixture.write_chapter_translation.mockImplementation(async () => {
        upload_attempts += 1;
        if (upload_attempts === 1) throw new Error("glossary changed");
      });
      await fixture.service.start();
      await wait_for_status(fixture.service, "completed");

      expect(upload_attempts).toBe(2);
      expect(fixture.write_chapter_translation).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        { glossary_id: "glossary-2", paragraphs_zh: ["工程一", "工程二"] },
        expect.any(AbortSignal),
      );
      expect(fixture.service.get_snapshot().chapters[0]?.state).toBe("uploaded");
    } finally {
      await fixture.database.close();
    }
  });

  it("连续五章失败后停止并保留失败进度", async () => {
    const fixture = await create_fixture({
      workspace: workspace(6),
      tasks: [task()],
      task_error: new AppError("remote.fetch_failed"),
    });
    try {
      await fixture.service.start();
      await wait_for_status(fixture.service, "failed");

      const snapshot = fixture.service.get_snapshot();
      expect(snapshot.error).toBe("remote.fetch_failed");
      expect(snapshot.totals.failed).toBe(5);
      expect(snapshot.chapters.slice(0, 5).map((chapter) => chapter.state)).toEqual([
        "failed",
        "failed",
        "failed",
        "failed",
        "failed",
      ]);
      expect(snapshot.chapters[5]?.state).toBe("pending");
    } finally {
      await fixture.database.close();
    }
  });

  it("文库形态提交：读取章节任务不带 sync", async () => {
    const fixture = await create_fixture({
      novel_url: "https://n.novelia.cc/wenku/12345",
      workspace: {
        ...workspace(1),
        chapters: [
          { chapter_id: "001.txt", volume_id: "v1.txt", title: "第一章", translated: false },
        ],
      },
      tasks: [task()],
    });
    try {
      await fixture.service.start();
      await wait_for_status(fixture.service, "completed");

      expect(fixture.read_chapter_task).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { sync: false },
        expect.any(AbortSignal),
      );
      expect(fixture.service.get_snapshot().totals.uploaded).toBe(1);
    } finally {
      await fixture.database.close();
    }
  });

  it("取消进行中的章节后状态为 cancelled", async () => {
    const fixture = await create_fixture({
      workspace: workspace(1),
      tasks: [task()],
      pending_task: true,
    });
    try {
      await fixture.service.start();
      await vi.waitFor(
        () => {
          expect(fixture.service.get_snapshot().chapters[0]?.state).toBe("reading");
        },
        { timeout: 3_000, interval: 10 },
      );

      const snapshot = await fixture.service.cancel();
      expect(snapshot).toMatchObject({ status: "cancelled", error: "cancelled" });
      expect(fixture.write_chapter_translation).not.toHaveBeenCalled();
    } finally {
      await fixture.database.close();
    }
  });
});
