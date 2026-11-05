import type { JsonValue } from "@earendil-works/chord";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import type {
  ConversationId,
  CommitPublication,
  DocumentId,
  LiveState,
  Seq,
  TaskId,
  TaskRecord,
  EntryId,
  EntryRecord,
  SubmissionId,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { AgentChatDoc, AGENT_INPUT_ENTRY_KIND, read_agent_input } from "./agent-chat-data";
import { AgentChatView, slim_entry_record } from "./agent-chat-view";

/** 读取记录里首个工具结果文本块，供瘦化断言使用。 */
function tool_result_text(record: EntryRecord | undefined): string {
  const message = record?.model?.find((item) => item.role === "toolResult");
  if (message === undefined || message.role !== "toolResult") throw new Error("no tool result");
  const part = message.content.find((item) => item.type === "text");
  return part?.type === "text" ? part.text : "";
}

it("瘦化记录裁短工具正文并保留输入结构，提交订阅也只存瘦化值", () => {
  const conversationId = 1 as ConversationId;
  const state = AgentChatDoc.definition.initial(null);
  const input: EntryRecord = {
    id: 1 as EntryId,
    conversationId,
    kind: AGENT_INPUT_ENTRY_KIND,
    data: {
      roundId: "round-1",
      message: { text: "任务", attachments: [] },
      delivery: "round",
      queuedId: null,
    },
  };
  const result: EntryRecord = {
    id: 2 as EntryId,
    conversationId,
    kind: "test",
    model: [
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "query",
        content: [{ type: "text", text: "x".repeat(3000) }],
        isError: false,
        timestamp: 3,
      },
    ],
  };
  const slim = slim_entry_record(result);
  const text = tool_result_text(slim);
  expect(Buffer.byteLength(text, "utf8")).toBeLessThan(3000);
  expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(2048); // 多留一个码点供投影识别截断
  // 输入结构未受影响，计数/分叉/修订仍可只读结构字段。
  expect(read_agent_input(slim_entry_record(input), undefined, state)).toMatchObject({
    roundId: "round-1",
    delivery: "round",
  });

  const view = new AgentChatView();
  view.observe({
    seq: 1 as Seq,
    changes: [
      { type: "entry", value: input },
      { type: "entry", value: result },
    ],
  });
  expect(Buffer.byteLength(tool_result_text(view.records.get(2)), "utf8")).toBeLessThan(3000);
});

it("压缩起始时间可随独立文档提交补入，任务终态与恢复沿用同一时间", () => {
  const conversationId = 1 as ConversationId;
  const state = AgentChatDoc.definition.initial(null);
  const task = {
    ...compaction_task({}),
    state: { status: "running", checkpoint: null },
  } satisfies TaskRecord<JsonValue, JsonValue, JsonValue>;
  const view = new AgentChatView();
  view.observe({ seq: 1 as Seq, changes: [{ type: "task", value: task }] });
  view.refresh(conversationId, state);
  expect(view.entries).toEqual([]);
  const timed = { ...state, compactionStartedAt: { 2: 100_000 } };
  view.refresh(conversationId, timed);
  expect(view.entries[0]?.createdAt).toBe(100_000);
  const completed = {
    ...task,
    state: { status: "terminal", outcome: { status: "completed", result: { entryId: 3 } } },
  } satisfies TaskRecord<JsonValue, JsonValue, JsonValue>;
  view.observe({ seq: 2 as Seq, changes: [{ type: "task", value: completed }] });
  view.refresh(conversationId, timed);
  expect(view.entries[0]).toMatchObject({ status: "success", createdAt: 100_000 });
  const restored = new AgentChatView();
  restored.reset([], new Map(), [completed], {}, timed);
  expect(restored.entries).toEqual(view.entries);
});

it("已提交历史按用户、助手、工具和后续回答投影，隐藏继续输入不新增条目", () => {
  const state = AgentChatDoc.definition.initial(null);
  state.inputs = {
    input: {
      roundId: "round",
      message: { text: "查询", attachments: [] },
      delivery: "round",
      queuedId: null,
    },
    hidden: {
      roundId: "round",
      message: { text: "继续", attachments: [] },
      delivery: "hidden",
      queuedId: null,
    },
  };
  state.rounds.round = {
    status: "success",
    checkpoint: 0 as EntryId,
    endedAt: 10,
    averageTokensPerSecond: null,
    failure: null,
  };
  const conversationId = 1 as ConversationId;
  const messages: Message[] = [
    { role: "user", content: "查询", timestamp: 1 },
    fauxAssistantMessage([
      fauxText("准备查询"),
      fauxToolCall("query", { value: 1 }, { id: "call" }),
    ]),
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "query",
      content: [{ type: "text", text: "结果" }],
      isError: false,
      timestamp: 3,
    },
    { role: "user", content: "继续", timestamp: 4 },
    fauxAssistantMessage("完成"),
  ];
  const records: EntryRecord[] = messages.map((message, index) => ({
    id: (index + 1) as EntryId,
    conversationId,
    kind: "test",
    model: [message],
  }));
  const submissions = new Map<number, SubmissionRecord>([
    [
      1,
      {
        id: 1 as SubmissionId,
        conversationId,
        requestId: "input",
        type: "input",
        status: "done",
        entry: 1 as EntryId,
        answer: 5 as EntryId,
      },
    ],
    [
      2,
      {
        id: 2 as SubmissionId,
        conversationId,
        requestId: "hidden",
        type: "input",
        status: "done",
        entry: 4 as EntryId,
        answer: 5 as EntryId,
      },
    ],
  ]);
  const view = new AgentChatView();
  view.reset(records, submissions, [], {}, state);
  expect(view.entries).toMatchObject([
    { kind: "user_message", id: "round", text: "查询", status: "success", endedAt: 10 },
    { kind: "assistant_message", parts: [{ kind: "text", text: "准备查询" }], status: "success" },
    {
      kind: "tool_call",
      toolName: "query",
      input: '{"value":1}',
      output: ["结果"],
      status: "success",
    },
    { kind: "assistant_message", parts: [{ kind: "text", text: "完成" }], status: "success" },
  ]);
});

it("失败轮次把原因摘要投影到公开的用户消息", () => {
  const conversationId = 1 as ConversationId;
  const state = AgentChatDoc.definition.initial(null);
  state.rounds.round = {
    status: "error",
    checkpoint: 0 as EntryId,
    endedAt: 10,
    averageTokensPerSecond: null,
    failure: { status: 400, detail: "Upstream request failed: [security_audit_fail]" },
  };
  const view = new AgentChatView();
  view.reset(
    [
      {
        id: 1 as EntryId,
        conversationId,
        kind: AGENT_INPUT_ENTRY_KIND,
        data: {
          roundId: "round",
          message: { text: "问题", attachments: [] },
          delivery: "round",
          queuedId: null,
        },
      },
    ],
    new Map(),
    [],
    {},
    state,
  );
  expect(view.entries).toMatchObject([
    {
      kind: "user_message",
      id: "round",
      text: "问题",
      status: "error",
      failure: { status: 400, detail: "Upstream request failed: [security_audit_fail]" },
    },
  ]);
});

it("流式变化只返回当前条目，终帧与提交变化顺序不影响恢复结果", () => {
  const conversationId = 1 as ConversationId;
  const taskId = 5000 as TaskId;
  const state = AgentChatDoc.definition.initial(null);
  state.inputs.input = {
    roundId: "round",
    message: { text: "问题", attachments: [] },
    delivery: "round",
    queuedId: null,
  };
  state.rounds.round = {
    status: "running",
    checkpoint: 0 as EntryId,
    endedAt: null,
    averageTokensPerSecond: null,
    failure: null,
  };
  const view = new AgentChatView();
  view.conversations.set(conversationId, { id: conversationId });
  view.submissions.set(1, {
    id: 1 as SubmissionId,
    conversationId,
    requestId: "input",
    type: "input",
    status: "placed",
    entry: 1 as EntryId,
  });
  view.records.set(1, {
    id: 1 as EntryId,
    conversationId,
    kind: "pi.user",
    model: [{ role: "user", content: "问题", timestamp: 1 }],
  });
  view.records.set(2, {
    id: 2 as EntryId,
    conversationId,
    kind: "pi.assistant",
    model: [fauxAssistantMessage("历史", { timestamp: 2 })],
  });
  view.refresh(conversationId, state);
  view.take_change();
  const oldEntry = view.entries[1];
  const partial = fauxAssistantMessage("开头", { timestamp: 2000 });
  const live: LiveState = {
    run: { taskId, inputs: [1 as SubmissionId] },
    generation: {
      attempt: 0,
      message: partial as NonNullable<NonNullable<LiveState["generation"]>["message"]>,
    },
  };
  const liveChange: Extract<CommitPublication["changes"][number], { type: "document" }> = {
    type: "document",
    record: {
      id: 1 as DocumentId,
      kind: "pi.live",
      scope: { kind: "conversation", conversationId },
      history: "latest",
      fork: "initial",
      createdAt: 1 as Seq,
    },
    conversationId,
    version: 1,
    value: live,
    ops: [],
  };
  view.observe({ seq: 1 as Seq, changes: [liveChange] });
  view.refresh(conversationId, state);
  expect(view.take_change()).toMatchObject({
    replace: false,
    entries: [{ id: "assistant:5000", status: "running" }],
  });
  const failed: EntryRecord = {
    id: 5001 as EntryId,
    conversationId,
    byTaskId: taskId,
    kind: "pi.assistant",
    model: [fauxAssistantMessage("中间失败", { timestamp: 2000, stopReason: "error" })],
  };
  view.observe({
    seq: 2 as Seq,
    changes: [
      { ...liveChange, value: {} },
      { type: "entry", value: failed },
    ],
  });
  view.refresh(conversationId, state);
  view.take_change();
  const retry: LiveState = {
    ...live,
    generation: {
      attempt: 1,
      message: { ...live.generation!.message!, content: [{ type: "text", text: "重试正文" }] },
    },
  };
  view.observe({ seq: 3 as Seq, changes: [{ ...liveChange, value: retry }] });
  view.refresh(conversationId, state);
  expect(view.take_change().entries).toMatchObject([
    { id: "assistant:5000", status: "running", parts: [{ text: "重试正文" }] },
  ]);
  const completed: EntryRecord = {
    id: 5002 as EntryId,
    conversationId,
    byTaskId: taskId,
    kind: "pi.assistant",
    model: [fauxAssistantMessage("完整回答", { timestamp: 2000 })],
  };
  const changes: CommitPublication["changes"] = [
    { ...liveChange, value: {} },
    { type: "entry", value: completed },
  ];
  // `LiveDoc` 在正式条目前出现，消费者仍以整批提交后的事实为准。
  view.observe({ seq: 4 as Seq, changes });
  view.refresh(conversationId, state);
  expect(view.take_change()).toMatchObject({
    replace: false,
    entries: [{ id: "assistant:5000", status: "success", parts: [{ text: "完整回答" }] }],
  });
  expect(view.entries[1]).toBe(oldEntry);
  const restored = new AgentChatView();
  restored.reset(view.branch_records(), view.submissions, [], {}, state);
  expect(restored.entries).toEqual(view.entries);
});

/** 压缩投影使用原生任务身份，状态来自各测试指定的 SDK 事实。 */
function compaction_task(result: JsonValue) {
  return {
    id: 2 as TaskId<JsonValue>,
    conversationId: 1 as ConversationId,
    kind: "pi.compaction",
    version: 1,
    input: { reason: "manual" },
    background: false,
    abortRequested: false,
    state: { status: "terminal", outcome: { status: "completed", result } },
  } satisfies TaskRecord<JsonValue, JsonValue, JsonValue>;
}

it("摘要回执更新已结束任务的时间线，恢复得到相同结果", () => {
  const task = compaction_task({ submissionId: 3 });
  const queued: SubmissionRecord = {
    id: 3 as SubmissionId,
    conversationId: task.conversationId,
    type: "write",
    status: "queued",
  };
  const state = { ...AgentChatDoc.definition.initial(null), compactionStartedAt: { 2: 1000 } };
  const view = new AgentChatView();
  view.observe({
    seq: 1 as Seq,
    changes: [
      { type: "task", value: task },
      { type: "submission", value: queued },
    ],
  });
  view.refresh(task.conversationId, state);
  expect(view.entries[0]?.status).toBe("running");
  const done: SubmissionRecord = { ...queued, status: "done", entry: 4 as EntryId };
  view.observe({ seq: 2 as Seq, changes: [{ type: "submission", value: done }] });
  view.refresh(task.conversationId, state);
  expect(view.entries[0]?.status).toBe("success");
  const restored = new AgentChatView();
  restored.submissions.set(done.id, done);
  restored.reset([], new Map(), [task], {}, state);
  expect(restored.entries).toEqual(view.entries);
});

it("空结果始终隐藏压缩块，恢复也不公开空操作", () => {
  const task = compaction_task({});
  const state = { ...AgentChatDoc.definition.initial(null), compactionStartedAt: { 2: 1000 } };
  const view = new AgentChatView();
  view.observe({ seq: 1 as Seq, changes: [{ type: "task", value: task }] });
  view.refresh(task.conversationId, state);
  expect(view.entries).toEqual([]);
  expect(view.take_change().entries).toEqual([]);
  const restored = new AgentChatView();
  restored.reset([], new Map(), [task], {}, state);
  expect(restored.entries).toEqual([]);
});

it("摘要阶段取消保留起点，选择阶段取消隐藏，失败保留诊断条目", () => {
  const task = {
    ...compaction_task({}),
    state: { status: "terminal", outcome: { status: "aborted" } },
  } satisfies TaskRecord<JsonValue, JsonValue, JsonValue>;
  const state = AgentChatDoc.definition.initial(null);
  const view = new AgentChatView();
  view.reset([], new Map(), [task], {}, state);
  expect(view.entries).toEqual([]);
  view.reset([], new Map(), [task], {}, { ...state, compactionStartedAt: { 2: 1000 } });
  expect(view.entries[0]).toMatchObject({ status: "stopped", createdAt: 1000 });
  const failed = {
    ...task,
    state: {
      status: "terminal",
      outcome: { status: "failed", error: { message: "model unavailable" } },
    },
  } satisfies TaskRecord<JsonValue, JsonValue, JsonValue>;
  view.reset([], new Map(), [failed], {}, state);
  expect(view.entries[0]).toMatchObject({ status: "error", createdAt: null });
});

it("timeline_window 按内容条目分页并额外附带轮次头", () => {
  const { view } = timeline_fixture([
    { id: "round-1", content: 3 },
    { id: "round-2", content: 3 },
    { id: "round-3", content: 2 },
  ]);

  const window = view.timeline_window(null, 4);

  // 4 条内容条目落在第 2、3 轮，轮次头额外附带且不占页预算。
  expect(window.entries.map((entry) => entry.id)).toEqual([
    "assistant:entry:7",
    "assistant:entry:8",
    "assistant:entry:10",
    "assistant:entry:11",
  ]);
  expect(window.headers.map((entry) => entry.id)).toEqual(["round-2", "round-3"]);
  expect(window.rounds).toEqual([
    { id: "round-2", hasEarlier: true },
    { id: "round-3", hasEarlier: false },
  ]);
  expect(window).toMatchObject({ hasEarlier: true, nextCursor: "assistant:entry:7" });
});

it("timeline_window 用游标继续向前读取并收敛到最早一页", () => {
  const { view } = timeline_fixture([
    { id: "round-1", content: 3 },
    { id: "round-2", content: 3 },
    { id: "round-3", content: 2 },
  ]);

  const middle = view.timeline_window("assistant:entry:7", 4);
  expect(middle.entries.map((entry) => entry.id)).toEqual([
    "assistant:entry:2",
    "assistant:entry:3",
    "assistant:entry:4",
    "assistant:entry:6",
  ]);
  expect(middle.headers.map((entry) => entry.id)).toEqual(["round-1", "round-2"]);
  expect(middle.rounds).toEqual([
    { id: "round-1", hasEarlier: false },
    { id: "round-2", hasEarlier: false },
  ]);
  expect(middle).toMatchObject({ hasEarlier: true, nextCursor: "assistant:entry:2" });

  const first = view.timeline_window(middle.nextCursor, 4);
  expect(first.entries).toEqual([]);
  expect(first.headers.map((entry) => entry.id)).toEqual(["round-1"]);
  expect(first.rounds).toEqual([{ id: "round-1", hasEarlier: false }]);
  expect(first).toMatchObject({ hasEarlier: false, nextCursor: null });
});

it("timeline_window 允许轮次头加加载更早的部分轮次", () => {
  const { view } = timeline_fixture([
    { id: "round-1", content: 3 },
    { id: "round-2", content: 3 },
    { id: "round-3", content: 2 },
  ]);

  const window = view.timeline_window(null, 1);

  expect(window.entries.map((entry) => entry.id)).toEqual(["assistant:entry:11"]);
  expect(window.headers.map((entry) => entry.id)).toEqual(["round-3"]);
  expect(window.rounds).toEqual([{ id: "round-3", hasEarlier: true }]);
  expect(window).toMatchObject({ hasEarlier: true, nextCursor: "assistant:entry:11" });
});

it("压缩条目按任务身份归属历史轮次，不被最新轮次覆盖", () => {
  const { view } = timeline_fixture([
    { id: "round-1", content: 2, compaction: true },
    { id: "round-2", content: 2 },
  ]);

  const compaction = view.entries.find((entry) => entry.kind === "context_compaction");
  expect(compaction?.roundId).toBe("round-1");
});

it("历史页按压缩条目真实轮次分页，不把最新轮次标记为更早", () => {
  const { view } = timeline_fixture([
    { id: "round-1", content: 1, compaction: true },
    { id: "round-2", content: 1 },
    { id: "round-3", content: 1 },
  ]);

  const latest = view.timeline_window(null, 1);
  expect(latest.rounds).toEqual([{ id: "round-3", hasEarlier: false }]);

  const middle = view.timeline_window(latest.nextCursor, 1);
  const earliest = view.timeline_window(middle.nextCursor, 1);
  // 含历史压缩的页面只带自己的轮次头，不会把最新轮次头带回来。
  expect(earliest.entries.map((entry) => entry.id)).toEqual(["compaction:3"]);
  expect(earliest.rounds).toEqual([
    { id: "round-1", hasEarlier: true },
    { id: "round-2", hasEarlier: false },
  ]);
});

it("压缩任务晚于后续轮次完成时仍归属创建时的轮次", () => {
  const conversationId = 1 as ConversationId;
  const state = AgentChatDoc.definition.initial(null);
  state.rounds["round-1"] = {
    status: "success",
    checkpoint: 0 as EntryId,
    endedAt: 10,
    averageTokensPerSecond: null,
    failure: null,
  };
  state.rounds["round-2"] = { ...state.rounds["round-1"] };
  const input = (id: number, roundId: string): EntryRecord => ({
    id: id as EntryId,
    conversationId,
    kind: AGENT_INPUT_ENTRY_KIND,
    data: {
      roundId,
      message: { text: roundId, attachments: [] },
      delivery: "round",
      queuedId: null,
    },
  });
  const answer = (id: number): EntryRecord => ({
    id: id as EntryId,
    conversationId,
    kind: "test",
    model: [fauxAssistantMessage(`answer-${id}`, { timestamp: id })],
  });
  const running = {
    id: 2 as TaskId<JsonValue>,
    conversationId,
    kind: "pi.compaction",
    version: 1,
    input: { reason: "manual" },
    background: false,
    abortRequested: false,
    state: { status: "running", checkpoint: null },
  } satisfies TaskRecord<JsonValue, JsonValue, JsonValue>;
  const view = new AgentChatView();
  view.observe({
    seq: 1 as Seq,
    changes: [
      ...([input(1, "round-1"), answer(4), input(5, "round-2"), answer(6)] as EntryRecord[]).map(
        (value) => ({ type: "entry" as const, value }),
      ),
      { type: "task", value: running },
    ],
  });
  view.refresh(conversationId, state);
  const timed = { ...state, compactionStartedAt: { 2: 1000 } };
  view.refresh(conversationId, timed);
  expect(view.entries.find((entry) => entry.kind === "context_compaction")?.roundId).toBe(
    "round-1",
  );
  const completed = {
    ...running,
    state: { status: "terminal", outcome: { status: "completed", result: { entryId: 3 } } },
  } satisfies TaskRecord<JsonValue, JsonValue, JsonValue>;
  view.observe({ seq: 2 as Seq, changes: [{ type: "task", value: completed }] });
  view.refresh(conversationId, timed);
  expect(view.entries.find((entry) => entry.kind === "context_compaction")?.roundId).toBe(
    "round-1",
  );
});

it("timeline_window 拒绝失效游标与非法页大小", () => {
  const { view } = timeline_fixture([{ id: "round-1", content: 1 }]);

  expect(() => view.timeline_window("missing", 4)).toThrow("agent_timeline_cursor_expired");
  expect(() => view.timeline_window(null, 0)).toThrow("Agent timeline page size is invalid.");
});

it("常驻记录与投影都只保留工具输出预览，完整输出按条目身份按需读回", async () => {
  const conversationId = 1 as ConversationId;
  const state = AgentChatDoc.definition.initial(null);
  state.rounds.round = {
    status: "success",
    checkpoint: 0 as EntryId,
    endedAt: 10,
    averageTokensPerSecond: null,
    failure: null,
  };
  const records: EntryRecord[] = [
    {
      id: 1 as EntryId,
      conversationId,
      kind: AGENT_INPUT_ENTRY_KIND,
      data: {
        roundId: "round",
        message: { text: "查询", attachments: [] },
        delivery: "round",
        queuedId: null,
      },
    },
    {
      id: 2 as EntryId,
      conversationId,
      kind: "test",
      model: [
        fauxAssistantMessage([fauxToolCall("query", { value: 1 }, { id: "call" })], {
          timestamp: 2,
        }),
      ],
    },
    {
      id: 3 as EntryId,
      conversationId,
      kind: "test",
      model: [
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "query",
          content: [{ type: "text", text: "x".repeat(3000) }],
          isError: false,
          timestamp: 3,
        },
      ],
    },
  ];
  const view = new AgentChatView();
  // 生产路径由 restore_records / observe 存入瘦化记录；完整正文只由 reader 提供。
  for (const record of records) view.records.set(record.id, slim_entry_record(record));
  view.set_full_record_reader(async (id) => records.find((record) => record.id === id));
  view.reset(records.map(slim_entry_record), new Map(), [], {}, state);

  const tool_id = "tool:2:call";
  const projection = view.entries.find((entry) => entry.kind === "tool_call");
  const preview = view
    .timeline_window(null, 40)
    .entries.find((entry) => entry.kind === "tool_call");

  // 常驻 rows、分页窗口与瘦化记录都不持有完整正文。
  expect(projection).toMatchObject({ output: ["x".repeat(2048)], outputTruncated: true });
  expect(preview).toMatchObject({ output: ["x".repeat(2048)], outputTruncated: true });
  expect(Buffer.byteLength(tool_result_text(view.records.get(3)), "utf8")).toBeLessThan(3000);
  // 详情弹窗按身份读回完整输出，且清除截断标记。
  await expect(view.read_full_entry(tool_id)).resolves.toMatchObject({
    output: ["x".repeat(3000)],
    outputTruncated: false,
  });
  await expect(view.read_full_entry("missing")).resolves.toBeUndefined();
});

/** 构造按记录身份排序的轮次历史，轮次头后接指定数量的助手内容。 */
function timeline_fixture(rounds: Array<{ id: string; content: number; compaction?: boolean }>): {
  view: AgentChatView;
  state: ReturnType<typeof AgentChatDoc.definition.initial>;
} {
  const conversationId = 1 as ConversationId;
  const state = AgentChatDoc.definition.initial(null);
  const records: EntryRecord[] = [];
  const tasks: TaskRecord<JsonValue, JsonValue, JsonValue>[] = [];
  let next_id = 1;
  for (const round of rounds) {
    records.push({
      id: next_id++ as EntryId,
      conversationId,
      kind: AGENT_INPUT_ENTRY_KIND,
      data: {
        roundId: round.id,
        message: { text: round.id, attachments: [] },
        delivery: "round",
        queuedId: null,
      },
    });
    state.rounds[round.id] = {
      status: "success",
      checkpoint: 0 as EntryId,
      endedAt: 10,
      averageTokensPerSecond: null,
      failure: null,
    };
    for (let index = 0; index < round.content; index++) {
      const id = next_id++;
      records.push({
        id: id as EntryId,
        conversationId,
        kind: "test",
        model: [fauxAssistantMessage(`${round.id}-${index}`, { timestamp: id })],
      });
    }
    // 压缩任务与条目共用身份序列，因此能落在该轮次内容之间。
    if (round.compaction === true) {
      const id = next_id++;
      tasks.push({
        id: id as TaskId<JsonValue>,
        conversationId,
        kind: "pi.compaction",
        version: 1,
        input: { reason: "manual" },
        background: false,
        abortRequested: false,
        state: { status: "terminal", outcome: { status: "completed", result: { entryId: 3 } } },
      });
      state.compactionStartedAt[id] = id;
    }
  }
  const view = new AgentChatView();
  view.reset(records, new Map(), tasks, {}, state);
  return { view, state };
}
