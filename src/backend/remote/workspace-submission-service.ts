import type { JsonRecord } from "../../domain/json";
import { Model } from "../../domain/model";
import { normalize_setting_snapshot } from "../../domain/setting";
import { AppError } from "../../shared/error/app-error";
import { random_id } from "../../shared/utils/identifier";
import type { AppSettingService } from "../app/app-setting-service";
import type { LLMClientPort } from "../llm/llm-types";
import { resolve_model_for_usage } from "../model/model-config-resolver";
import type { ProjectDatabase } from "../database/database-operations";
import type { RuntimeOperationGate, RuntimeLease } from "../runtime-operation-gate";
import type { ProjectSessionState } from "../project/project-session-state";
import type { NoveliaClient, RemoteWorkspaceChapter } from "./novelia-client";
import { call_with_credential_refresh } from "./credential-refresh";
import {
  is_missing_remote_translation,
  normalize_match_line,
  parse_novel_url,
  split_remote_document,
  type RemoteChapter,
} from "./novelia-source";
import {
  read_remote_source_binding,
  REMOTE_SOURCE_META_KEY,
  type RemoteSourceBinding,
} from "./remote-source";

const MAX_BATCH_LINES = 80;
const MAX_BATCH_CHARS = 4_000;
const MAX_CHAPTER_FAILURES = 5;
const TRANSLATION_ATTEMPTS = 2;
const SEARCH_WINDOW = 50;

export type RemoteWorkspaceMode = "missing" | "all";
export type RemoteWorkspaceStatus = "idle" | "running" | "completed" | "failed" | "cancelled";
export type RemoteWorkspaceChapterState = "pending" | "working" | "uploaded" | "skipped" | "failed";

export interface RemoteWorkspaceChapterProgress {
  chapter_id: string;
  title: string;
  state: RemoteWorkspaceChapterState;
  existing: number; // 站点旧译或工程已完成译文
  translated: number; // 本次模型补译行数
  missing: number; // 未能取得译文的行数
  message: string | null;
}

export interface RemoteWorkspaceSnapshot {
  status: RemoteWorkspaceStatus;
  mode: RemoteWorkspaceMode | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  totals: {
    chapters: number;
    uploaded: number;
    skipped: number;
    failed: number;
    existing: number;
    translated: number;
  };
  chapters: RemoteWorkspaceChapterProgress[];
}

export interface RemoteWorkspaceSubmissionServiceOptions {
  database: ProjectDatabase;
  session_state: ProjectSessionState;
  runtime_gate: RuntimeOperationGate;
  settings: Pick<AppSettingService, "read_setting">;
  client: NoveliaClient;
  llm: LLMClientPort;
  /** 收到认证拒绝时触发登录链路的 token 续期；CLI 缺席。 */
  refresh_credentials?: ((origin: string) => Promise<boolean>) | undefined;
}

interface AssetItem {
  row: number;
  src: string;
  dst: string;
  status: string;
}

interface RunningSubmission {
  lease: RuntimeLease;
  controller: AbortController;
  completion: Promise<void>;
}

/**
 * 把工程译文提交到站点的 GPT 工作区。
 * 单章按“站点旧译 → 工程已完成译文 → 当前模型补译”的顺序补全，
 * 任一行缺失就跳过该章上传，避免提交长度不一致的数组。
 */
export class RemoteWorkspaceSubmissionService {
  private readonly database: ProjectDatabase;
  private readonly session_state: ProjectSessionState;
  private readonly runtime_gate: RuntimeOperationGate;
  private readonly settings: Pick<AppSettingService, "read_setting">;
  private readonly client: NoveliaClient;
  private readonly llm: LLMClientPort;
  private readonly refresh_credentials: ((origin: string) => Promise<boolean>) | null;
  private readonly listeners = new Set<(snapshot: RemoteWorkspaceSnapshot) => void>();
  private snapshot: RemoteWorkspaceSnapshot = create_idle_snapshot();
  private running: RunningSubmission | null = null;

  public constructor(options: RemoteWorkspaceSubmissionServiceOptions) {
    this.database = options.database;
    this.session_state = options.session_state;
    this.runtime_gate = options.runtime_gate;
    this.settings = options.settings;
    this.client = options.client;
    this.llm = options.llm;
    this.refresh_credentials = options.refresh_credentials ?? null;
  }

  public get_snapshot(): RemoteWorkspaceSnapshot {
    return clone_snapshot(this.snapshot);
  }

  public subscribe(listener: (snapshot: RemoteWorkspaceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 启动前先确认绑定；实际工作区读取与翻译在后台执行。 */
  public async start(body: JsonRecord): Promise<RemoteWorkspaceSnapshot> {
    if (this.running !== null) throw new AppError("runtime.busy");
    const mode = body["mode"] ?? "missing";
    if (mode !== "missing" && mode !== "all") {
      throw new AppError("request.validation_failed", { public_details: { field: "mode" } });
    }
    const project_path = this.session_state.require_loaded_project_path();
    const meta = await this.database.get_all_meta(project_path);
    const binding = read_remote_source_binding(meta[REMOTE_SOURCE_META_KEY]);
    if (binding === null) throw new AppError("remote.source_not_bound");
    if (this.running !== null) throw new AppError("runtime.busy");
    const lease = this.runtime_gate.begin_runtime("remote_workspace");
    const controller = new AbortController();
    this.snapshot = {
      ...create_idle_snapshot(),
      status: "running",
      mode,
      started_at: new Date().toISOString(),
    };
    this.publish();
    const completion = this.execute(project_path, binding, mode, controller.signal)
      .catch((error: unknown) => {
        this.snapshot = {
          ...this.snapshot,
          status: signal_status(controller.signal, error),
          finished_at: new Date().toISOString(),
          error: signal_error(controller.signal, error),
        };
      })
      .finally(() => {
        this.running = null;
        this.runtime_gate.finish_runtime(lease);
        this.publish();
      });
    this.running = { lease, controller, completion };
    return this.get_snapshot();
  }

  public async cancel(): Promise<RemoteWorkspaceSnapshot> {
    const running = this.running;
    if (running === null) return this.get_snapshot();
    running.controller.abort(new AppError("runtime.disposed"));
    await running.completion;
    return this.get_snapshot();
  }

  /** 关闭时取消并等待收尾，上传已完成的章节保留在站点。 */
  public async dispose(): Promise<void> {
    await this.cancel();
  }

  private async execute(
    project_path: string,
    binding: RemoteSourceBinding,
    mode: RemoteWorkspaceMode,
    signal: AbortSignal,
  ): Promise<void> {
    const ref = parse_novel_url(binding.url);
    const workspace = await this.client.read_workspace(ref, signal);
    const asset_text = await this.read_asset_text(project_path, binding.asset_path);
    const asset_chapters = split_remote_document(asset_text).chapters;
    const asset_items = await this.read_asset_items(project_path, binding.asset_path);
    const chapter_partners = pair_workspace_chapters(workspace.chapters, asset_chapters);
    this.snapshot = {
      ...this.snapshot,
      totals: { ...this.snapshot.totals, chapters: workspace.chapters.length },
      chapters: workspace.chapters.map((chapter) => ({
        chapter_id: chapter.chapter_id,
        title: chapter.title,
        state: "pending",
        existing: 0,
        translated: 0,
        missing: 0,
        message: null,
      })),
    };
    this.publish();
    let consecutive_failures = 0;
    for (const [index, chapter] of workspace.chapters.entries()) {
      signal.throwIfAborted();
      this.update_chapter(index, { state: "working" });
      try {
        const partner = chapter_partners.get(index) ?? null;
        const outcome = await this.process_chapter({
          ref,
          chapter,
          asset_chapter: partner,
          asset_items,
          mode,
          glossary: workspace.glossary,
          signal,
        });
        this.update_totals(outcome);
        this.update_chapter(index, {
          state: outcome.uploaded ? "uploaded" : "skipped",
          existing: outcome.existing,
          translated: outcome.translated,
          missing: outcome.missing,
          message: outcome.message,
        });
        if (outcome.uploaded) consecutive_failures = 0;
        else if (outcome.failed) consecutive_failures += 1;
        if (consecutive_failures >= MAX_CHAPTER_FAILURES) {
          throw new AppError("remote.fetch_failed", {
            message: "Too many consecutive workspace chapter failures.",
            public_details: { consecutive_failures },
          });
        }
      } catch (error) {
        if (signal.aborted) throw error;
        consecutive_failures += 1;
        this.update_chapter(index, {
          state: "failed",
          message: error instanceof AppError ? error.code : "remote.fetch_failed",
        });
        this.snapshot = {
          ...this.snapshot,
          totals: { ...this.snapshot.totals, failed: this.snapshot.totals.failed + 1 },
        };
        this.publish();
        if (consecutive_failures >= MAX_CHAPTER_FAILURES) throw error;
      }
    }
    if (this.snapshot.status === "running") {
      this.snapshot = {
        ...this.snapshot,
        status: "completed",
        finished_at: new Date().toISOString(),
      };
    }
  }

  private async process_chapter(args: {
    ref: ReturnType<typeof parse_novel_url>;
    chapter: RemoteWorkspaceChapter;
    asset_chapter: RemoteChapter | null;
    asset_items: readonly AssetItem[];
    mode: RemoteWorkspaceMode;
    glossary: Record<string, string>;
    signal: AbortSignal;
  }): Promise<{
    uploaded: boolean;
    failed: boolean;
    existing: number;
    translated: number;
    missing: number;
    message: string | null;
  }> {
    let task = await call_with_credential_refresh(this.refresh_credentials, args.ref.origin, () =>
      this.client.read_chapter_task(
        args.ref,
        args.chapter,
        { sync: this.should_sync_chapter(args.ref) },
        args.signal,
      ),
    );
    const paragraphs = task.paragraph_jp;
    if (paragraphs.length === 0) {
      return {
        uploaded: false,
        failed: false,
        existing: 0,
        translated: 0,
        missing: 0,
        message: null,
      };
    }
    const mapped = map_paragraph_items(paragraphs, args.asset_chapter, args.asset_items);
    const site_old =
      task.old_paragraph_zh !== null && task.old_paragraph_zh.length === paragraphs.length
        ? task.old_paragraph_zh
        : null;
    const resolved: Array<string | null> = Array.from({ length: paragraphs.length }, () => null);
    let existing = 0;
    const missing_indexes: number[] = [];
    for (let index = 0; index < paragraphs.length; index += 1) {
      if (args.mode === "missing") {
        const from_site = site_old?.[index]?.trim() ?? "";
        // 站点旧译可能是“gpt翻译缺失。”这类缺失标记，按缺失处理并交给模型补译。
        if (from_site !== "" && !is_missing_remote_translation(from_site)) {
          resolved[index] = from_site;
          existing += 1;
          continue;
        }
        const item = mapped[index] ?? null;
        if (item !== null && item.status === "PROCESSED" && item.dst.trim() !== "") {
          resolved[index] = item.dst;
          existing += 1;
          continue;
        }
      }
      missing_indexes.push(index);
    }
    let translated = 0;
    if (missing_indexes.length > 0) {
      const translated_map = await this.translate_missing({
        paragraphs,
        indexes: missing_indexes,
        glossary: task.glossary,
        signal: args.signal,
      });
      if (translated_map === null) {
        return {
          uploaded: false,
          failed: true,
          existing,
          translated: 0,
          missing: missing_indexes.length,
          message: "translation_incomplete",
        };
      }
      for (const index of missing_indexes) {
        const text = translated_map.get(index);
        if (text === undefined || text.trim() === "") {
          return {
            uploaded: false,
            failed: true,
            existing,
            translated,
            missing: missing_indexes.length,
            message: "translation_incomplete",
          };
        }
        resolved[index] = text;
        translated += 1;
      }
    }
    const paragraphs_zh = resolved.map((value) => value ?? "");
    try {
      await call_with_credential_refresh(this.refresh_credentials, args.ref.origin, () =>
        this.client.write_chapter_translation(
          args.ref,
          args.chapter,
          { glossary_id: task.glossary_id, paragraphs_zh },
          args.signal,
        ),
      );
    } catch (error) {
      if (args.signal.aborted) throw error;
      // 术语表在取任务与上传之间变化时刷新一次；仍失败则记录本章失败。
      const refreshed = await call_with_credential_refresh(
        this.refresh_credentials,
        args.ref.origin,
        () => this.client.read_chapter_task(args.ref, args.chapter, { sync: false }, args.signal),
      );
      if (refreshed.glossary_id === task.glossary_id) throw error;
      task = refreshed;
      await call_with_credential_refresh(this.refresh_credentials, args.ref.origin, () =>
        this.client.write_chapter_translation(
          args.ref,
          args.chapter,
          { glossary_id: task.glossary_id, paragraphs_zh },
          args.signal,
        ),
      );
    }
    return {
      uploaded: true,
      failed: false,
      existing,
      translated,
      missing: 0,
      message: null,
    };
  }

  /**
   * 按行分块翻译；单块失败时递归二分，直到单行仍失败才返回 null。
   */
  private async translate_missing(args: {
    paragraphs: readonly string[];
    indexes: readonly number[];
    glossary: Record<string, string>;
    signal: AbortSignal;
  }): Promise<Map<number, string> | null> {
    const settings = this.settings.read_setting();
    // 模型配置不在 SettingSnapshot 中，先按原始设置解析，再冻结公开设置快照。
    const raw_model = resolve_model_for_usage(settings, "translation");
    if (raw_model === null) throw new AppError("model.not_found");
    const config_snapshot = normalize_setting_snapshot(settings);
    const model = Model.from_json(raw_model, "").to_json();
    const result = new Map<number, string>();
    for (const batch of build_batches(args.indexes, args.paragraphs)) {
      const texts = batch.map((index) => args.paragraphs[index] ?? "");
      const translated = await this.translate_batch({
        texts,
        glossary: args.glossary,
        model,
        config_snapshot,
        signal: args.signal,
      });
      if (translated === null) return null;
      for (const [offset, index] of batch.entries()) {
        result.set(index, translated[offset] ?? "");
      }
    }
    return result;
  }

  private async translate_batch(args: {
    texts: readonly string[];
    glossary: Record<string, string>;
    model: ReturnType<typeof Model.from_json> extends never ? never : JsonRecord;
    config_snapshot: JsonRecord;
    signal: AbortSignal;
  }): Promise<string[] | null> {
    const is_sakura = String(args.model["api_format"] ?? "") === "SakuraLLM";
    for (let attempt = 0; attempt < TRANSLATION_ATTEMPTS; attempt += 1) {
      args.signal.throwIfAborted();
      const response = await this.llm.request(
        {
          run_id: random_id(12),
          work_unit_id: random_id(12),
          model: args.model,
          config_snapshot: args.config_snapshot,
          messages: build_translation_messages(args.texts, args.glossary, is_sakura),
        },
        args.signal,
      );
      if (response.cancelled) return null;
      if (response.request_error !== undefined || response.timeout) continue;
      const parsed = parse_translation_output(
        response.response_result,
        args.texts.length,
        is_sakura,
      );
      if (parsed !== null) return parsed;
    }
    if (args.texts.length <= 1) return null;
    const middle = Math.ceil(args.texts.length / 2);
    const left = await this.translate_batch({
      ...args,
      texts: args.texts.slice(0, middle),
    });
    if (left === null) return null;
    const right = await this.translate_batch({
      ...args,
      texts: args.texts.slice(middle),
    });
    return right === null ? null : [...left, ...right];
  }

  private async read_asset_text(project_path: string, asset_path: string): Promise<string> {
    const bytes = await this.database.read_asset_content(project_path, asset_path);
    if (bytes === null) {
      throw new AppError("remote.source_not_bound", {
        public_details: { reason: "asset_missing", asset_path },
      });
    }
    return bytes.toString("utf8");
  }

  private async read_asset_items(project_path: string, asset_path: string): Promise<AssetItem[]> {
    const records = await this.database.get_all_items(project_path);
    return records
      .filter((item) => item["file_path"] === asset_path)
      .flatMap((item) => {
        const row = item["row"];
        if (typeof row !== "number" || !Number.isSafeInteger(row)) return [];
        return [
          {
            row,
            src: String(item["src"] ?? ""),
            dst: String(item["dst"] ?? ""),
            status: String(item["status"] ?? "NONE"),
          },
        ];
      })
      .sort((left, right) => left.row - right.row);
  }

  private should_sync_chapter(ref: ReturnType<typeof parse_novel_url>): boolean {
    return ref.kind === "web";
  }

  private update_chapter(index: number, patch: Partial<RemoteWorkspaceChapterProgress>): void {
    const chapters = this.snapshot.chapters.slice();
    const current = chapters[index];
    if (current === undefined) return;
    chapters[index] = { ...current, ...patch };
    this.snapshot = { ...this.snapshot, chapters };
    this.publish();
  }

  private update_totals(outcome: {
    uploaded: boolean;
    failed: boolean;
    existing: number;
    translated: number;
  }): void {
    const totals = this.snapshot.totals;
    this.snapshot = {
      ...this.snapshot,
      totals: {
        ...totals,
        uploaded: totals.uploaded + (outcome.uploaded ? 1 : 0),
        skipped: totals.skipped + (!outcome.uploaded && !outcome.failed ? 1 : 0),
        failed: totals.failed + (outcome.failed ? 1 : 0),
        existing: totals.existing + outcome.existing,
        translated: totals.translated + outcome.translated,
      },
    };
  }

  private publish(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.get_snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function create_idle_snapshot(): RemoteWorkspaceSnapshot {
  return {
    status: "idle",
    mode: null,
    started_at: null,
    finished_at: null,
    error: null,
    totals: { chapters: 0, uploaded: 0, skipped: 0, failed: 0, existing: 0, translated: 0 },
    chapters: [],
  };
}

function clone_snapshot(snapshot: RemoteWorkspaceSnapshot): RemoteWorkspaceSnapshot {
  return {
    ...snapshot,
    totals: { ...snapshot.totals },
    chapters: snapshot.chapters.map((chapter) => ({ ...chapter })),
  };
}

function signal_status(signal: AbortSignal, _error: unknown): RemoteWorkspaceStatus {
  return signal.aborted ? "cancelled" : "failed";
}

function signal_error(signal: AbortSignal, error: unknown): string {
  if (signal.aborted) return "cancelled";
  return error instanceof AppError ? error.code : "runtime.internal_invariant";
}

/**
 * 工作区章节与工程章节按标题配对；没有标题或标题变化时不猜测。
 * 章节数一致时按位置回退，覆盖章节改名但仍保持顺序的常见情况。
 */
function pair_workspace_chapters(
  chapters: readonly RemoteWorkspaceChapter[],
  asset_chapters: readonly RemoteChapter[],
): Map<number, RemoteChapter> {
  const result = new Map<number, RemoteChapter>();
  const by_title = new Map<string, RemoteChapter[]>();
  for (const chapter of asset_chapters) {
    if (chapter.kind !== "chapter") continue;
    const key = normalize_match_line(chapter.title);
    if (key === "") continue;
    const queue = by_title.get(key) ?? [];
    queue.push(chapter);
    by_title.set(key, queue);
  }
  const used = new Set<RemoteChapter>();
  for (const [index, chapter] of chapters.entries()) {
    const queue = by_title.get(normalize_match_line(chapter.title));
    const candidate = queue?.shift();
    if (candidate !== undefined) {
      result.set(index, candidate);
      used.add(candidate);
    }
  }
  const asset_chapters_only = asset_chapters.filter((chapter) => chapter.kind === "chapter");
  if (chapters.length === asset_chapters_only.length) {
    for (const [index, _chapter] of chapters.entries()) {
      if (result.has(index)) continue;
      const candidate = asset_chapters_only[index];
      if (candidate !== undefined && !used.has(candidate)) {
        result.set(index, candidate);
        used.add(candidate);
      }
    }
  }
  return result;
}

/**
 * 章节内按顺序把段落映射到工程条目；允许中间有标题与空行，
 * 但不跨章节、不跨越过长的缺失区段。
 */
function map_paragraph_items(
  paragraphs: readonly string[],
  chapter: RemoteChapter | null,
  items: readonly AssetItem[],
): Array<AssetItem | null> {
  if (chapter === null) return paragraphs.map(() => null);
  const chapter_items = items.filter(
    (item) => item.row >= chapter.start_row && item.row < chapter.end_row,
  );
  const result: Array<AssetItem | null> = [];
  let cursor = 0;
  for (const paragraph of paragraphs) {
    const target = normalize_match_line(paragraph);
    let found = -1;
    for (
      let offset = 0;
      offset < SEARCH_WINDOW && cursor + offset < chapter_items.length;
      offset += 1
    ) {
      const candidate = chapter_items[cursor + offset];
      if (candidate !== undefined && normalize_match_line(candidate.src) === target) {
        found = cursor + offset;
        break;
      }
    }
    if (found >= 0) {
      result.push(chapter_items[found] ?? null);
      cursor = found + 1;
    } else {
      result.push(null);
    }
  }
  return result;
}

/** 按行数与字符预算切块，保持原始顺序。 */
function build_batches(indexes: readonly number[], paragraphs: readonly string[]): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let chars = 0;
  for (const index of indexes) {
    const size = (paragraphs[index] ?? "").length;
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_LINES || chars + size > MAX_BATCH_CHARS)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(index);
    chars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function build_translation_messages(
  texts: readonly string[],
  glossary: Record<string, string>,
  is_sakura: boolean,
): Array<{ role: "system" | "user"; content: string }> {
  const glossary_lines = Object.entries(glossary)
    .filter(([source]) => texts.some((text) => text.includes(source)))
    .slice(0, 200)
    .map(([source, target]) => `${source}=${target}`);
  const glossary_block =
    glossary_lines.length === 0 ? "" : `\n术语表（必须沿用）：\n${glossary_lines.join("\n")}\n`;
  if (is_sakura) {
    return [
      { role: "system", content: "请将下面的日文逐行翻译成简体中文，只输出译文。" },
      { role: "user", content: texts.join("\n") },
    ];
  }
  return [
    {
      role: "system",
      content:
        "你是专业的日文小说翻译。把每个编号行翻译成简体中文，保持编号和行数完全一致。" +
        "输出格式为 `#N: 译文`，不要合并、拆分、省略或解释。" +
        glossary_block,
    },
    {
      role: "user",
      content: texts.map((text, index) => `#${index + 1}: ${text}`).join("\n"),
    },
  ];
}

/** 编号输出按序号取值；缺失或多余行都判为失败，交给上层重试。 */
function parse_translation_output(
  output: string,
  expected: number,
  is_sakura: boolean,
): string[] | null {
  if (is_sakura) {
    const lines = output.split(/\r?\n/u).filter((line) => line.trim() !== "");
    return lines.length === expected ? lines : null;
  }
  const values = new Map<number, string>();
  for (const line of output.split(/\r?\n/u)) {
    const matched = /^\s*#?\s*(\d+)\s*[:：]\s?(.*)$/u.exec(line);
    if (matched === null) continue;
    const index = Number(matched[1]);
    if (!Number.isSafeInteger(index) || index < 1 || index > expected) continue;
    values.set(index, matched[2] ?? "");
  }
  if (values.size !== expected) return null;
  const result: string[] = [];
  for (let index = 1; index <= expected; index += 1) {
    const value = values.get(index);
    if (value === undefined || value.trim() === "") return null;
    result.push(value.trim());
  }
  return result;
}
