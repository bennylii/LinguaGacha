import { expect, it, vi } from "vitest";
import type { AgentEntry } from "@shared/agent";
import { AgentTimelineStore } from "./agent-timeline-store";

it("正文更新只通知对应条目，历史与轮次结构保持引用稳定", () => {
  const store = new AgentTimelineStore();
  const history: AgentEntry = {
    kind: "assistant_message",
    id: "history",
    roundId: "round",
    parts: [{ kind: "text", text: "历史" }],
    status: "success",
    createdAt: 1,
  };
  const current: AgentEntry = {
    kind: "assistant_message",
    id: "current",
    roundId: "round",
    parts: [{ kind: "text", text: "开头" }],
    status: "running",
    createdAt: 2,
  };
  store.replace([history, current]);
  store.notify();
  const structure = store.read();
  const old = store.entry("history");
  const structureChanged = vi.fn();
  const oldChanged = vi.fn();
  const currentChanged = vi.fn();
  store.subscribe(structureChanged);
  store.subscribe_entry("history", oldChanged);
  const unsubscribe = store.subscribe_entry("current", currentChanged);
  store.update([{ ...current, parts: [{ kind: "text", text: "开头和后续" }] }]);
  expect(currentChanged).not.toHaveBeenCalled();
  store.notify();
  expect(currentChanged).toHaveBeenCalledOnce();
  expect(structureChanged).not.toHaveBeenCalled();
  expect(oldChanged).not.toHaveBeenCalled();
  expect(store.read()).toBe(structure);
  expect(store.entry("history")).toBe(old);
  expect(store.entry("current")).toMatchObject({ parts: [{ text: "开头和后续" }] });
  unsubscribe();
  store.update([{ ...current, parts: [{ kind: "text", text: "取消订阅后的更新" }] }]);
  store.notify();
  expect(currentChanged).toHaveBeenCalledOnce();
});

it("快照替换清除旧轮次、操作状态和条目，并通知被移除条目的读者", () => {
  const store = new AgentTimelineStore();
  store.replace([
    {
      kind: "user_message",
      id: "round",
      roundId: "round",
      delivery: "round",
      text: "输入",
      attachments: [],
      createdAt: 1,
      status: "running",
      endedAt: null,
      averageTokensPerSecond: null,
      failure: null,
    },
    {
      kind: "tool_call",
      id: "tool",
      roundId: "round",
      toolName: "workspace_apply",
      input: "{}",
      status: "running",
      output: null,
      outputTruncated: false,
      createdAt: 2,
    },
    {
      kind: "context_compaction",
      roundId: "round",
      createdAt: null,
      id: "compact",
      status: "running",
    },
  ]);
  store.notify();
  expect(store.read()).toMatchObject({
    roundIds: ["round"],
    latestCompactionId: "compact",
    workspaceApplyRunning: true,
    compacting: true,
  });
  const removed = vi.fn(() => expect(store.entry("tool")).toBeUndefined());
  store.subscribe_entry("tool", removed);
  store.replace([]);
  store.notify();
  expect(removed).toHaveBeenCalledOnce();
  expect(store.read()).toEqual({
    entryIds: [],
    roundIds: [],
    latestRoundId: null,
    latestCompactionId: null,
    hasEarlier: false,
    nextCursor: null,
    roundHasEarlier: new Map(),
    workspaceApplyRunning: false,
    compacting: false,
  });
  expect(store.round("round")).toEqual([]);
});

it("最近压缩身份随追加更新，旧条目的迟到更新不会覆盖最新身份", () => {
  const store = new AgentTimelineStore();
  const failed: AgentEntry = {
    kind: "context_compaction",
    roundId: "round",
    createdAt: null,
    id: "failed",
    status: "error",
  };
  store.replace([failed]);
  expect(store.read()).toMatchObject({ latestCompactionId: "failed", compacting: false });
  store.update([
    {
      kind: "context_compaction",
      roundId: "round",
      createdAt: null,
      id: "retry",
      status: "running",
    },
  ]);
  expect(store.read()).toMatchObject({ latestCompactionId: "retry", compacting: true });
  store.update([{ ...failed, status: "success" }]);
  expect(store.read()).toMatchObject({ latestCompactionId: "retry", compacting: true });
  store.update([
    {
      kind: "context_compaction",
      roundId: "round",
      createdAt: null,
      id: "retry",
      status: "success",
    },
  ]);
  expect(store.read()).toMatchObject({ latestCompactionId: "retry", compacting: false });
  store.replace([failed]);
  expect(store.read()).toMatchObject({ latestCompactionId: "failed", compacting: false });
});

it("快照只保留窗口游标，并按轮次提供更早状态", () => {
  const store = new AgentTimelineStore();
  store.replace([round_entry("round-1"), assistant_entry("assistant-1", "round-1")], {
    hasEarlier: true,
    nextCursor: "round-1",
    rounds: [{ id: "round-1", hasEarlier: true }],
  });
  expect(store.read()).toMatchObject({
    hasEarlier: true,
    nextCursor: "round-1",
    roundIds: ["round-1"],
    latestRoundId: "round-1",
    roundHasEarlier: new Map([["round-1", true]]),
  });
  expect(store.round("round-1")).toEqual(["assistant-1"]);
});

it("增量批次先登记轮次头，内容按自身 roundId 归属并忽略未加载轮次", () => {
  const store = new AgentTimelineStore();
  store.update([
    assistant_entry("assistant-b", "round-b"),
    round_entry("round-a"),
    round_entry("round-b"),
  ]);
  expect(store.read().roundIds).toEqual(["round-a", "round-b"]);
  expect(store.round("round-b")).toEqual(["assistant-b"]);
  expect(store.read().latestRoundId).toBe("round-b");

  store.update([assistant_entry("legacy", "")]);
  expect(store.round("round-b")).toEqual(["assistant-b", "legacy"]);

  store.update([assistant_entry("orphan", "missing-round")]);
  expect(store.entry("orphan")).toBeDefined();
  expect(store.round("round-b")).toEqual(["assistant-b", "legacy"]);
});

it("前插更早一页按轮次合并，轮次头只补一次并推进游标", () => {
  const store = new AgentTimelineStore();
  store.replace([round_entry("round-2"), assistant_entry("assistant-2", "round-2")], {
    hasEarlier: true,
    nextCursor: "round-2",
    rounds: [{ id: "round-2", hasEarlier: false }],
  });
  store.prepend_page({
    chatId: "chat",
    revision: 1,
    entries: [
      assistant_entry("assistant-1", "round-1"),
      assistant_entry("assistant-2-older", "round-2"),
    ],
    headers: [round_entry("round-1"), round_entry("round-2")],
    rounds: [
      { id: "round-1", hasEarlier: false },
      { id: "round-2", hasEarlier: false },
    ],
    hasEarlier: false,
    nextCursor: null,
  });
  expect(store.read().roundIds).toEqual(["round-1", "round-2"]);
  expect(store.read().entryIds).toEqual([
    "round-1",
    "assistant-1",
    "assistant-2-older",
    "round-2",
    "assistant-2",
  ]);
  expect(store.round("round-2")).toEqual(["assistant-2-older", "assistant-2"]);
  expect(store.read()).toMatchObject({
    hasEarlier: false,
    nextCursor: null,
    roundHasEarlier: new Map([
      ["round-1", false],
      ["round-2", false],
    ]),
  });
});

it("回到跟随只保留最新内容及其轮次头，并允许继续向上加载", () => {
  const store = new AgentTimelineStore();
  const entries = [round_entry("round-1"), assistant_entry("assistant-1", "round-1")];
  for (let index = 0; index < 5; index++) {
    entries.push(assistant_entry(`round-2-content-${index}`, "round-2"));
  }
  entries.push(round_entry("round-2"), assistant_entry("assistant-2", "round-2"));
  store.replace(entries, {
    hasEarlier: false,
    nextCursor: null,
    rounds: [
      { id: "round-1", hasEarlier: false },
      { id: "round-2", hasEarlier: false },
    ],
  });

  store.trim_to_latest_window(3);
  expect(store.read().roundIds).toEqual(["round-2"]);
  expect(store.read().entryIds).toEqual([
    "round-2",
    "round-2-content-3",
    "round-2-content-4",
    "assistant-2",
  ]);
  expect(store.read()).toMatchObject({
    hasEarlier: true,
    nextCursor: "round-2-content-3",
    roundHasEarlier: new Map([["round-2", true]]),
  });
});

/** 轮次头夹具；自动继续与普通发送一样开始新轮次。 */
function round_entry(id: string, delivery: "round" | "auto_continue" = "round"): AgentEntry {
  return {
    kind: "user_message",
    id,
    roundId: id,
    delivery,
    text: id,
    attachments: [],
    status: "success",
    createdAt: 1,
    endedAt: 2,
    averageTokensPerSecond: null,
    failure: null,
  };
}

/** 轮次内内容条目夹具，`roundId` 为空时模拟旧载荷。 */
function assistant_entry(id: string, roundId: string): AgentEntry {
  return {
    kind: "assistant_message",
    id,
    roundId,
    parts: [{ kind: "text", text: id }],
    status: "success",
    createdAt: 2,
  };
}
