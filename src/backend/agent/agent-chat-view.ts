import { isDeepStrictEqual } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  CommitPublication,
  ConversationRecord,
  EntryRecord,
  LiveState,
  SubmissionRecord,
  TaskRecord,
  UsageState,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type {
  AgentEntry,
  AgentRunFailure,
  AgentTimelineRound,
  AgentTimelineWindow,
  AgentUsageSnapshot,
} from "../../shared/agent";
import { JsonTool } from "../../shared/utils/json-tool";
import { project_assistant_message_parts, read_agent_tool_result_status } from "./agent-message";
import {
  read_agent_input,
  type AgentInputDelivery,
  type AgentInputRecord,
  type AgentChatData,
} from "./agent-chat-data";
import { read_agent_compaction_result } from "./agent-compaction";

/** 流式与正式响应使用同一任务身份，人工修订使用条目身份。 */
export const assistant_entry_id = (task: number | undefined, entry: number): string =>
  `assistant:${task ?? `entry:${entry}`}`;
/** 游标失效是前端可恢复的分页状态，服务层据此映射公开原因。 */
export class AgentTimelineCursorExpiredError extends Error {
  constructor() {
    super("agent_timeline_cursor_expired");
  }
}
const UNCOMMITTED_ENTRY_ORDER = Number.MAX_SAFE_INTEGER; // 尚无 SDK 条目身份的正文暂居轮次末尾

/** 时间线窗口默认页大小由共享契约拥有。 */
export { AGENT_TIMELINE_PAGE_SIZE } from "../../shared/agent";
/** 工具输出预览上限，完整内容按需读取。 */
export const AGENT_TOOL_OUTPUT_PREVIEW_BYTES = 2048;

type TaskRecordValue = TaskRecord<JsonValue, JsonValue, JsonValue>;
type Row = { order: number; entry: AgentEntry };
export type AgentTimelineChange = { replace: boolean; entries: AgentEntry[] };

/** 轮次头是可见任务单元，`auto_continue` 与普通轮次一样建立新轮次。 */
export function is_round_header(
  entry: AgentEntry,
): entry is Extract<AgentEntry, { kind: "user_message"; delivery: "round" | "auto_continue" }> {
  return (
    entry.kind === "user_message" &&
    (entry.delivery === "round" || entry.delivery === "auto_continue")
  );
}

/** 工具输出按 UTF-8 字节截断，保持文本块顺序并标记是否仍有完整内容。 */
export function to_public_entry(
  entry: AgentEntry,
  preview_bytes = AGENT_TOOL_OUTPUT_PREVIEW_BYTES,
): AgentEntry {
  if (entry.kind !== "tool_call" || entry.output === null) return entry;
  let remaining = preview_bytes;
  let truncated = false;
  const output: string[] = [];
  for (const part of entry.output) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const bytes = Buffer.byteLength(part, "utf8");
    if (bytes <= remaining) {
      output.push(part);
      remaining -= bytes;
      continue;
    }
    output.push(truncate_utf8(part, remaining));
    remaining = 0;
    truncated = true;
  }
  return { ...entry, output, outputTruncated: entry.outputTruncated || truncated };
}

/** 按 UTF-8 字节上限裁剪字符串，不产生半个码点。 */
function truncate_utf8(value: string, max_bytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > max_bytes) break;
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end);
}

/** 用户输入按历史身份标记轮次起点；压缩等无输入条目据此归属轮次。 */
type RoundMark = { id: number; roundId: string };

/** 任务属于其提交位置之前最近的用户轮次，读取顺序和后续轮次都不能改变它。 */
function read_round_at(marks: readonly RoundMark[], order: number): string | undefined {
  let round: string | undefined;
  for (const mark of marks) {
    if (mark.id > order) break;
    round = mark.roundId;
  }
  return round;
}

/** 可重建的公开投影。原始事实和查询索引只在这里保存，正文更新不扫描历史。 */
export class AgentChatView {
  public readonly records = new Map<number, EntryRecord>(); // 已读取的 SDK 历史，供分支恢复与修订定位
  public readonly conversations = new Map<number, ConversationRecord>(); // 分支继承关系，用于计算祖先切点
  public readonly submissions = new Map<number, SubmissionRecord>(); // 产品输入与实际历史条目的关联回执
  public readonly compactions = new Map<number, TaskRecordValue>(); // 公开压缩条目的任务事实
  public readonly live = new Map<number, LiveState>(); // 按分支保存的已提交生成进度
  public readonly pendingUsages = new Map<number, UsageState>(); // 结算后释放的用量回执
  public usage: AgentUsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private conversationId: number | undefined;
  private state!: Readonly<AgentChatData>; // 本次投影采用的已提交产品状态
  private readonly bounds = new Map<number, number>(); // 各祖先分支可见条目的最大身份
  private readonly rows = new Map<string, Row>();
  private readonly inputSubmissions = new Map<number, SubmissionRecord>(); // 旧历史通过条目身份定位原提交回执
  private readonly calls = new Map<string, string>(); // 工具调用身份到公开条目的查询索引
  private readonly userRecords = new Map<string, EntryRecord>(); // 轮次状态变化时定位原用户消息
  private readonly changed = new Map<string, AgentEntry>(); // 尚未发布的条目，同一身份只保留最新值
  private readonly pendingRecords = new Set<number>();
  private readonly pendingTasks = new Set<number>();
  private readonly pendingSubmissions = new Set<number>();
  private readonly totals = new Map<number, AgentUsageSnapshot>(); // 各分支已计入的用量，历史修订继续保留累计消耗
  private order: string[] = [];
  private currentRound: string | undefined; // 按历史顺序推进的当前产品轮次
  private liveId: string | undefined; // 当前流式正文身份，用于处理正文撤回
  private replace = true; // 下一次发布需要整体替换时间线
  private restoring = false; // 恢复期间先收集条目，结束后统一排序
  private liveChanged = false;

  /** 仅快照、修订和停止等低频读者需要物化完整数组。 */
  public get entries(): AgentEntry[] {
    return this.order.map((id) => this.rows.get(id)!.entry);
  }

  /**
   * 读取完整历史中某个位置之前的窗口。`before` 可以是任意公开条目 id；
   * 返回的 `entries` 只含内容条目，轮次头额外附带且不占页预算。
   */
  public timeline_window(before: string | null, limit: number): AgentTimelineWindow {
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new Error("Agent timeline page size is invalid.");
    let end = this.order.length;
    if (before !== null) {
      const index = this.order.indexOf(before);
      if (index < 0) throw new AgentTimelineCursorExpiredError();
      end = index;
    }
    let start = end;
    let content = 0;
    while (start > 0 && content < limit) {
      start--;
      if (!is_round_header(this.rows.get(this.order[start]!)!.entry)) content++;
    }
    const included = this.order.slice(start, end);
    const round_ids = new Set<string>();
    for (const id of included) {
      const entry = this.rows.get(id)!.entry;
      // 页内轮次头即使尚无内容也要保留，否则刚发送的轮次会从快照消失。
      if (is_round_header(entry)) round_ids.add(entry.id);
      else round_ids.add(entry.roundId);
    }
    // 页首可能落在轮次中间，轮次头在页外也要补上，形成“轮次头 + 加载更早”。
    const header_indices = new Map<string, number>();
    for (let index = 0; index < this.order.length; index++) {
      const entry = this.rows.get(this.order[index]!)!.entry;
      if (is_round_header(entry) && round_ids.has(entry.id)) header_indices.set(entry.id, index);
    }
    const has_earlier = start > 0;
    const next_cursor = start > 0 ? this.order[start]! : null;
    // 轮次内更早内容：页首之前是否还有同轮次内容。
    const earlier_rounds = new Set<string>();
    for (let index = 0; index < start; index++) {
      const entry = this.rows.get(this.order[index]!)!.entry;
      if (!is_round_header(entry)) earlier_rounds.add(entry.roundId);
    }
    const rounds: AgentTimelineRound[] = [...header_indices.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => ({ id, hasEarlier: earlier_rounds.has(id) }));
    return {
      entries: included
        .map((id) => this.rows.get(id)!.entry)
        .filter((entry) => !is_round_header(entry))
        .map((entry) => to_public_entry(entry)),
      headers: rounds.map((round) => this.rows.get(round.id)!.entry),
      rounds,
      hasEarlier: has_earlier,
      nextCursor: next_cursor,
    };
  }

  /** 统计当前分支某个轮次内指定 delivery 的输入数。 */
  public count_inputs(roundId: string, delivery: AgentInputDelivery): number {
    let count = 0;
    for (const record of this.branch_records()) {
      const input = this.read_input(record);
      if (input?.roundId === roundId && input.delivery === delivery) count++;
    }
    return count;
  }

  /** 从任务链根开始统计指定 delivery，自动继续按链累计。 */
  public count_chain_inputs(rootId: string, delivery: AgentInputDelivery): number {
    let seen_root = false;
    let count = 0;
    for (const record of this.branch_records()) {
      const input = this.read_input(record);
      if (input === undefined) continue;
      if (input.delivery === "round" && input.roundId === rootId) {
        seen_root = true;
        continue;
      }
      if (!seen_root) continue;
      if (input.delivery === delivery) count++;
    }
    return count;
  }

  /** 找到轮次所属任务链的根：当前轮次之前最近一条普通用户发送。 */
  public find_round_root(roundId: string): string | null {
    let root: string | null = null;
    for (const record of this.branch_records()) {
      const input = this.read_input(record);
      if (input?.delivery !== "round") continue;
      root = input.roundId;
      if (input.roundId === roundId) return root;
    }
    return root;
  }

  /** 实例故障只覆盖当前公开轮次，重开投影仍由持久化回执决定。 */
  public fail_round(id: string | null, endedAt: number, failure: AgentRunFailure | null): void {
    const row = id === null ? undefined : this.rows.get(id);
    if (row?.entry.kind === "user_message" && is_round_header(row.entry))
      this.put({ ...row.entry, status: "error", endedAt, failure }, row.order);
  }
  /** 祖先分支只公开切点以前的事实。 */
  private visible(conversation: number, id: number): boolean {
    return id <= (this.bounds.get(conversation) ?? -1);
  }
  /** 按 SDK 身份排序完整可见历史，供恢复和修订定位。 */
  public branch_records(): EntryRecord[] {
    return [...this.records.values()]
      .filter((record) => this.visible(record.conversationId, record.id))
      .sort((a, b) => a.id - b.id);
  }

  /** 同步提交监听器只记录失效范围，后续刷新在提交线外运行。 */
  public observe(publication: CommitPublication): void {
    for (const change of publication.changes) {
      if (change.type === "entry") {
        this.records.set(change.value.id, change.value);
        this.pendingRecords.add(change.value.id);
      } else if (change.type === "conversation")
        this.conversations.set(change.value.id, change.value);
      else if (change.type === "submission") {
        this.submissions.set(change.value.id, change.value);
        this.pendingSubmissions.add(change.value.id);
        // ponytail: 压缩任务较少，回执扫描任务；长会话出现瓶颈时改为 submissionId 索引。
        for (const task of this.compactions.values()) {
          if (task.state.status !== "terminal" || task.state.outcome.status !== "completed")
            continue;
          const result = task.state.outcome.result;
          if (
            typeof result === "object" &&
            result !== null &&
            !Array.isArray(result) &&
            result["submissionId"] === change.value.id
          )
            this.pendingTasks.add(task.id);
        }
      } else if (change.type === "task" && change.value.kind === "pi.compaction") {
        this.compactions.set(change.value.id, change.value);
        this.pendingTasks.add(change.value.id);
      } else if (
        change.type === "document" &&
        change.value !== null &&
        change.conversationId !== undefined
      ) {
        if (change.record.kind === "pi.live") {
          this.live.set(change.conversationId, change.value as LiveState);
          if (change.conversationId === this.conversationId) this.liveChanged = true;
        }
        if (change.record.kind === "pi.usage") {
          this.pendingUsages.set(change.conversationId, change.value as UsageState);
        }
      }
    }
  }

  /** 分支切换或补读历史时重建索引，其余提交增量更新。 */
  public refresh(conversationId: number, state: Readonly<AgentChatData>, restored = false): void {
    if (restored || conversationId !== this.conversationId) {
      this.conversationId = conversationId;
      this.bounds.clear();
      let record = this.conversations.get(conversationId);
      let ceiling = Number.MAX_SAFE_INTEGER;
      this.bounds.set(conversationId, ceiling);
      while (record?.parent !== undefined) {
        ceiling = Math.min(ceiling, record.parent.at);
        this.bounds.set(record.parent.conversationId, ceiling);
        record = this.conversations.get(record.parent.conversationId);
      }
      this.reset(
        this.branch_records(),
        this.submissions,
        [...this.compactions.values()].filter((task) => this.visible(task.conversationId, task.id)),
        this.live.get(conversationId) ?? {},
        state,
      );
    } else {
      const previous = this.state;
      this.state = state;
      for (const id of this.pendingSubmissions) {
        const submission = this.submissions.get(id)!;
        if (
          submission.type !== "input" ||
          submission.entry === undefined ||
          submission.requestId === undefined
        )
          continue;
        this.inputSubmissions.set(submission.entry, submission);
      }
      for (const id of [...this.pendingRecords].sort((a, b) => a - b)) {
        const record = this.records.get(id)!;
        if (this.visible(record.conversationId, id)) this.read_record(record);
      }
      if (previous.rounds !== state.rounds) {
        for (const [id, round] of Object.entries(state.rounds)) {
          if (round === previous.rounds[id]) continue;
          const record = this.userRecords.get(id);
          if (record !== undefined) this.read_user(record, this.read_input(record)!);
        }
      }
      // 时间元数据独立提交时也更新对应条目，覆盖刷新期间新任务到达的情况。
      if (previous.compactionStartedAt !== state.compactionStartedAt) {
        for (const [id, startedAt] of Object.entries(state.compactionStartedAt)) {
          if (startedAt !== previous.compactionStartedAt[id]) this.pendingTasks.add(Number(id));
        }
      }
      if (this.pendingTasks.size > 0) {
        // 压缩任务可能晚于后续轮次提交，按任务身份而不是读取顺序归属轮次。
        const round_marks = this.read_round_marks(this.branch_records());
        for (const id of this.pendingTasks) {
          const task = this.compactions.get(id)!;
          if (this.visible(task.conversationId, id))
            this.read_task(task, read_round_at(round_marks, task.id));
        }
      }
      if (this.liveChanged || previous.rounds !== state.rounds)
        this.read_live(this.live.get(conversationId) ?? {});
    }
    for (const [id, state] of this.pendingUsages) {
      const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const usage of Object.values(state.models)) {
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
          total[key] += usage[key];
      }
      const previous = this.totals.get(id);
      this.usage = { ...this.usage };
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
        this.usage[key] += total[key] - (previous?.[key] ?? 0);
      this.totals.set(id, total);
    }
    this.pendingRecords.clear();
    this.pendingSubmissions.clear();
    this.pendingTasks.clear();
    this.pendingUsages.clear();
    this.liveChanged = false;
  }

  /** 恢复和增量共用条目转换。分支替换只在这里清空公开索引。 */
  public reset(
    records: readonly EntryRecord[],
    submissions: ReadonlyMap<number, SubmissionRecord>,
    tasks: readonly TaskRecordValue[],
    live: Readonly<LiveState>,
    state: Readonly<AgentChatData>,
  ): void {
    this.state = state;
    this.rows.clear();
    this.inputSubmissions.clear();
    this.calls.clear();
    this.userRecords.clear();
    this.changed.clear();
    this.order = [];
    this.currentRound = undefined;
    this.liveId = undefined;
    this.replace = true;
    for (const submission of submissions.values()) {
      if (
        submission.type !== "input" ||
        submission.entry === undefined ||
        submission.requestId === undefined
      )
        continue;
      this.inputSubmissions.set(submission.entry, submission);
    }
    // 恢复时统一排序一次，避免每个历史压缩条目都触发插入和重排。
    this.restoring = true;
    try {
      for (const record of records) this.read_record(record);
      const round_marks = this.read_round_marks(records);
      for (const task of tasks) this.read_task(task, read_round_at(round_marks, task.id));
      this.read_live(live);
    } finally {
      this.restoring = false;
    }
    this.order = [...this.rows.keys()].sort(
      (a, b) => this.rows.get(a)!.order - this.rows.get(b)!.order,
    );
  }

  /** 发布者消费更新，不需要比较上一份完整快照。 */
  public take_change(): AgentTimelineChange {
    const result = { replace: this.replace, entries: [...this.changed.values()] };
    this.replace = false;
    this.changed.clear();
    return result;
  }

  /** 同一身份原位更新，删除或非尾部顺序变化要求发布完整快照。 */
  private put(entry: AgentEntry, order: number): void {
    const previous = this.rows.get(entry.id);
    if (previous?.order === order && isDeepStrictEqual(previous.entry, entry)) return;
    this.rows.set(entry.id, { entry, order });
    if (this.restoring) return;
    if (previous === undefined) {
      const last = this.order.at(-1);
      if (last === undefined || this.rows.get(last)!.order <= order) this.order.push(entry.id);
      else {
        this.order.push(entry.id);
        this.order.sort((a, b) => this.rows.get(a)!.order - this.rows.get(b)!.order);
        this.replace = true;
      }
    } else if (previous.order !== order) {
      const index = this.order.indexOf(entry.id);
      const before = this.order[index - 1];
      const after = this.order[index + 1];
      if (
        (before !== undefined && this.rows.get(before)!.order > order) ||
        (after !== undefined && this.rows.get(after)!.order < order)
      ) {
        this.order.sort((a, b) => this.rows.get(a)!.order - this.rows.get(b)!.order);
        this.replace = true;
      }
    }
    this.changed.set(entry.id, entry);
  }

  /** 移除已撤回的临时正文，并让前端重新取得完整顺序。 */
  private remove(id: string): void {
    if (!this.rows.delete(id)) return;
    this.changed.delete(id);
    this.order = this.order.filter((candidate) => candidate !== id);
    this.replace = true;
  }

  /** 所有投影使用同一新旧输入读取边界。 */
  private read_input(record: EntryRecord): AgentInputRecord | undefined {
    return read_agent_input(record, this.inputSubmissions.get(record.id), this.state);
  }

  /** 按身份顺序记录每个用户输入开启的轮次，供无输入条目归属。 */
  private read_round_marks(records: readonly EntryRecord[]): RoundMark[] {
    const marks: RoundMark[] = [];
    for (const record of records) {
      const input = this.read_input(record);
      if (input !== undefined) marks.push({ id: record.id, roundId: input.roundId });
    }
    return marks;
  }

  /** `hidden`、`auto_resume`、`manual_continue` 留在模型历史，普通输入与 `steer` 按产品身份展示。 */
  private read_user(record: EntryRecord, input: AgentInputRecord): void {
    const createdAt = record.model?.find((message) => message.role === "user")?.timestamp ?? 0;
    const base = {
      kind: "user_message" as const,
      id:
        input.delivery === "round" || input.delivery === "auto_continue"
          ? input.roundId
          : `user:${record.id}`,
      roundId: input.roundId,
      text: input.message.text,
      attachments: structuredClone(input.message.attachments),
      createdAt,
    };
    if (
      input.delivery === "hidden" ||
      input.delivery === "auto_resume" ||
      input.delivery === "manual_continue"
    )
      return;
    const round = this.state.rounds[input.roundId];
    this.put(
      input.delivery === "steer"
        ? { ...base, delivery: "steer", status: "success", endedAt: createdAt }
        : {
            ...base,
            delivery: input.delivery,
            status: round?.status ?? "running",
            endedAt: round?.endedAt ?? null,
            averageTokensPerSecond: round?.averageTokensPerSecond ?? null,
            failure: round?.failure ?? null,
          },
      record.id,
    );
    if (input.delivery === "round" || input.delivery === "auto_continue")
      this.userRecords.set(input.roundId, record);
  }

  /** 按历史顺序转换消息，工具结果归回原调用及其所属轮次。 */
  private read_record(record: EntryRecord): void {
    const input = this.read_input(record);
    if (input !== undefined) {
      this.currentRound = input.roundId;
      this.read_user(record, input);
    }
    if (this.currentRound === undefined) return;
    const round_id = this.currentRound;
    for (const message of record.model ?? []) {
      if (message.role === "assistant") {
        const id = assistant_entry_id(record.byTaskId, record.id);
        const parts = project_assistant_message_parts(message);
        if (parts !== null) {
          this.put(
            {
              kind: "assistant_message",
              id,
              roundId: round_id,
              parts,
              status:
                message.stopReason === "error"
                  ? "error"
                  : message.stopReason === "aborted"
                    ? "stopped"
                    : "success",
              createdAt: message.timestamp,
            },
            record.id,
          );
        }
        if (parts === null) this.remove(id);
        for (const call of message.content) {
          if (call.type !== "toolCall") continue;
          const id = `tool:${record.id}:${call.id}`;
          this.calls.set(call.id, id);
          this.put(
            {
              kind: "tool_call",
              id,
              roundId: round_id,
              toolName: call.name,
              input: JsonTool.stringifyStrict(call.arguments),
              status: "running",
              output: null,
              outputTruncated: false,
              createdAt: message.timestamp,
            },
            record.id,
          );
        }
      } else if (message.role === "toolResult") {
        const id = this.calls.get(message.toolCallId);
        const row = id === undefined ? undefined : this.rows.get(id);
        if (row?.entry.kind !== "tool_call") continue;
        this.put(
          {
            ...row.entry,
            status: read_agent_tool_result_status(record, message),
            output: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
            outputTruncated: false,
          },
          row.order,
        );
      }
    }
  }

  /** 选择切点时隐藏运行块，确认摘要范围后公开，失败保留诊断条目。 */
  private read_task(task: TaskRecordValue, round_id: string | undefined): void {
    const { status } = read_agent_compaction_result(task, this.submissions);
    const startedAt = this.state.compactionStartedAt[task.id];
    const id = `compaction:${task.id}`;
    if (
      status === "skipped" ||
      (startedAt === undefined &&
        (status === "stopped" || (status === "running" && task.state.status !== "terminal")))
    ) {
      this.remove(id);
      return;
    }
    this.put(
      {
        kind: "context_compaction",
        id,
        roundId: round_id ?? "",
        createdAt: startedAt ?? null,
        status,
      },
      task.id,
    );
  }

  /** 流式正文沿用任务身份，正式条目以 SDK 排序身份接替临时位置。 */
  private read_live(live: Readonly<LiveState>): void {
    const message = live.generation?.message as AssistantMessage | undefined;
    const parts = message === undefined ? null : project_assistant_message_parts(message);
    const nextId =
      live.run === undefined || parts === null ? undefined : assistant_entry_id(live.run.taskId, 0);
    if (
      this.liveId !== undefined &&
      this.liveId !== nextId &&
      this.rows.get(this.liveId)?.order === UNCOMMITTED_ENTRY_ORDER
    ) {
      this.remove(this.liveId);
    }
    this.liveId = nextId;
    if (
      nextId === undefined ||
      message === undefined ||
      parts === null ||
      this.currentRound === undefined
    )
      return;
    this.put(
      {
        kind: "assistant_message",
        id: nextId,
        roundId: this.currentRound,
        parts,
        status: "running",
        createdAt: message.timestamp,
      },
      UNCOMMITTED_ENTRY_ORDER,
    );
  }
}
