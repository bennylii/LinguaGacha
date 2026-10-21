import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonRecord, JsonValue } from "../../domain/json";
import { ProjectDatabase } from "../database/database-operations";
import type { LLMClientPort, LLMRequestResult } from "../llm/llm-types";
import type { AppSettingService } from "../app/app-setting-service";
import { ProjectSessionState } from "../project/project-session-state";
import { RuntimeOperationGate } from "../runtime-operation-gate";
import type { NoveliaClient, RemoteChapterTask, RemoteWorkspace } from "./novelia-client";
import { parse_novel_url, sha256_text } from "./novelia-source";
import { build_remote_source_binding, REMOTE_SOURCE_META_KEY } from "./remote-source";
import { RemoteWorkspaceSubmissionService } from "./workspace-submission-service";

const NOVEL_URL = "https://n.novelia.cc/novel/kakuyomu/12345";
const ASSET_PATH = "テスト小説.txt";
const ASSET_TEXT = "# 第一章\n本文一\n本文二";

interface Fixture {
  service: RemoteWorkspaceSubmissionService;
  database: ProjectDatabase;
  write_chapter_translation: ReturnType<typeof vi.fn>;
  request_llm: ReturnType<typeof vi.fn>;
}

/** 工作区、项目条目与模型端口都可注入，用例只声明影响提交结果的事实。 */
async function create_fixture(options: {
  workspace: RemoteWorkspace;
  tasks: RemoteChapterTask[];
  items?: Array<{ src: string; dst: string; status: string }>;
  settings?: JsonRecord;
  translation_error?: Error;
  pending_task?: boolean;
}): Promise<Fixture> {
  const database = new ProjectDatabase();
  const lg_path = path.join(temp_dir, "demo.lg");
  await database.create_project(lg_path, "demo");
  const session_state = new ProjectSessionState();
  await session_state.mark_loaded(lg_path);
  const binding = build_remote_source_binding({
    ref: parse_novel_url(NOVEL_URL),
    title: "テスト小説",
    asset_path: ASSET_PATH,
    remote_hash: sha256_text(ASSET_TEXT),
    chapter_count: 1,
    synced_at: "2026-10-20T00:00:00.000Z",
  });
  const items = options.items ?? [
    { src: "本文一", dst: "", status: "NONE" },
    { src: "本文二", dst: "", status: "NONE" },
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
  const request_llm = vi.fn(async (): Promise<LLMRequestResult> => ({
    response_think: "",
    response_result: "#1: 模型二",
    input_tokens: 0,
    reasoning_tokens: 0,
    output_tokens: 0,
    cancelled: false,
    timeout: false,
  }));
  const settings = {
    read_setting: () => options.settings ?? {},
  } as Pick<AppSettingService, "read_setting">;
  const service = new RemoteWorkspaceSubmissionService({
    database,
    session_state,
    runtime_gate: new RuntimeOperationGate(),
    settings,
    client: client as unknown as NoveliaClient,
    llm: { request: request_llm } as unknown as LLMClientPort,
  });
  return {
    service,
    database,
    write_chapter_translation: client.write_chapter_translation,
    request_llm,
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
  it("已有译文优先：站点旧译覆盖工程译文，工程完成译文补齐缺失行", async () => {
    const fixture = await create_fixture({
      workspace: workspace(1),
      tasks: [task({ old_paragraph_zh: ["站点一", ""] })],
      items: [
        { src: "本文一", dst: "工程一", status: "PROCESSED" },
        { src: "本文二", dst: "工程二", status: "PROCESSED" },
      ],
    });
    try {
      await fixture.service.start({ mode: "missing" });
      await wait_for_status(fixture.service, "completed");

      expect(fixture.request_llm).not.toHaveBeenCalled();
      expect(fixture.write_chapter_translation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ chapter_id: "chapter-1" }),
        { glossary_id: "glossary-1", paragraphs_zh: ["站点一", "工程二"] },
        expect.any(AbortSignal),
      );
      expect(fixture.service.get_snapshot()).toMatchObject({
        status: "completed",
        mode: "missing",
        totals: { chapters: 1, uploaded: 1, skipped: 0, failed: 0, existing: 2, translated: 0 },
      });
    } finally {
      await fixture.database.close();
    }
  });

  it("缺少译文时调用当前翻译模型补译", async () => {
    const fixture = await create_fixture({
      workspace: workspace(1),
      tasks: [task()],
      items: [
        { src: "本文一", dst: "工程一", status: "PROCESSED" },
        { src: "本文二", dst: "", status: "NONE" },
      ],
      settings: {
        models: [{ id: "model-1", model_id: "test-model" }],
        model_selection: { translation: "model-1" },
      },
    });
    try {
      await fixture.service.start({ mode: "missing" });
      await wait_for_status(fixture.service, "completed");

      expect(fixture.request_llm).toHaveBeenCalledOnce();
      const request = fixture.request_llm.mock.calls[0]![0] as {
        messages: Array<{ content: string }>;
      };
      expect(request.messages.at(-1)?.content).toBe("#1: 本文二");
      expect(fixture.write_chapter_translation).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { glossary_id: "glossary-1", paragraphs_zh: ["工程一", "模型二"] },
        expect.any(AbortSignal),
      );
      expect(fixture.service.get_snapshot()).toMatchObject({
        status: "completed",
        totals: { uploaded: 1, existing: 1, translated: 1 },
      });
    } finally {
      await fixture.database.close();
    }
  });

  it("上传遇到术语表失效时刷新任务并重试一次", async () => {
    let upload_attempts = 0;
    const fixture = await create_fixture({
      workspace: workspace(1),
      tasks: [
        task({ old_paragraph_zh: ["站点一", "站点二"] }),
        task({ old_paragraph_zh: ["站点一", "站点二"], glossary_id: "glossary-2" }),
      ],
      items: [],
      settings: {},
    });
    try {
      fixture.write_chapter_translation.mockImplementation(async () => {
        upload_attempts += 1;
        if (upload_attempts === 1) throw new Error("glossary changed");
      });
      await fixture.service.start({ mode: "missing" });
      await wait_for_status(fixture.service, "completed");

      expect(upload_attempts).toBe(2);
      expect(fixture.write_chapter_translation).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        { glossary_id: "glossary-2", paragraphs_zh: ["站点一", "站点二"] },
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
      items: [],
      settings: {},
    });
    try {
      await fixture.service.start({ mode: "missing" });
      await wait_for_status(fixture.service, "failed");

      const snapshot = fixture.service.get_snapshot();
      expect(snapshot.error).toBe("model.not_found");
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

  it("取消进行中的章节后状态为 cancelled", async () => {
    const fixture = await create_fixture({
      workspace: workspace(1),
      tasks: [task()],
      items: [],
      settings: {},
      pending_task: true,
    });
    try {
      await fixture.service.start({ mode: "missing" });
      await vi.waitFor(
        () => {
          expect(fixture.service.get_snapshot().chapters[0]?.state).toBe("working");
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
