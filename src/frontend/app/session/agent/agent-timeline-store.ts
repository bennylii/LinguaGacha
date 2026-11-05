import type { AgentEntry, AgentTimelinePage, AgentTimelineSnapshot } from "@shared/agent";

type Listener = () => void;
export type AgentTimelineSlice = Readonly<{
  entryIds: readonly string[];
  roundIds: readonly string[];
  latestRoundId: string | null;
  latestCompactionId: string | null; // 最近追加的压缩身份，供界面定位恢复入口。
  hasEarlier: boolean;
  nextCursor: string | null;
  roundHasEarlier: ReadonlyMap<string, boolean>;
  workspaceApplyRunning: boolean;
  compacting: boolean;
}>;
const EMPTY_IDS: readonly string[] = [];
const EMPTY_ROUNDS: ReadonlyMap<string, boolean> = new Map();

/** 轮次头是可见任务单元；自动继续与普通发送一样开始新轮次。 */
function is_round_header(
  entry: AgentEntry,
): entry is Extract<AgentEntry, { kind: "user_message"; delivery: "round" | "auto_continue" }> {
  return (
    entry.kind === "user_message" &&
    (entry.delivery === "round" || entry.delivery === "auto_continue")
  );
}

/** 条目内容和显示结构分别订阅。组件读到的条目和 ID 数组始终是不可变快照。 */
export class AgentTimelineStore {
  private readonly entries = new Map<string, AgentEntry>(); // 公开条目的唯一内容副本
  private readonly rounds = new Map<string, readonly string[]>(); // 轮次到有序条目身份的索引
  private readonly assistants = new Map<string, string>(); // 各轮次末条助手回复的身份
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly structureListeners = new Set<Listener>();
  private readonly changed = new Set<string>(); // 本批需要通知的条目身份，重复更新只通知一次
  private structureChanged = false;
  private applyCount = 0; // 运行中的工程提交工具数，驱动停止能力
  private snapshot: AgentTimelineSlice = {
    entryIds: [],
    roundIds: [],
    latestRoundId: null,
    latestCompactionId: null,
    hasEarlier: false,
    nextCursor: null,
    roundHasEarlier: EMPTY_ROUNDS,
    workspaceApplyRunning: false,
    compacting: false,
  };

  /** 返回稳定结构快照，供 React 判断是否需要更新容器。 */
  public readonly read = (): AgentTimelineSlice => this.snapshot;
  /** 按当前选择读取条目，未选择或已移除时返回空值。 */
  public entry(id: string | null): AgentEntry | undefined {
    return id === null ? undefined : this.entries.get(id);
  }
  /** 读取一个轮次的条目顺序，缺失轮次共用稳定空数组。 */
  public round(id: string): readonly string[] {
    return this.rounds.get(id) ?? EMPTY_IDS;
  }
  /** 定位轮次末条助手回复，供修订入口判断。 */
  public latest_assistant(id: string): string | undefined {
    return this.assistants.get(id);
  }
  /** 订阅顺序和操作状态变化，返回监听器清理入口。 */
  public readonly subscribe = (listener: Listener): (() => void) => {
    this.structureListeners.add(listener);
    return () => {
      this.structureListeners.delete(listener);
    };
  };
  /** 订阅指定条目，清理时回收已无读者的监听集合。 */
  public subscribe_entry(id: string | null, listener: Listener): () => void {
    if (id === null) return () => {};
    let listeners = this.listeners.get(id);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(id, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
    };
  }

  /** 完整窗口使消失的条目也通知原订阅者，避免详情或编辑器持有旧对象。 */
  public replace(entries: readonly AgentEntry[], timeline?: AgentTimelineSnapshot): void {
    for (const id of this.entries.keys()) this.changed.add(id);
    this.entries.clear();
    this.rounds.clear();
    this.assistants.clear();
    this.applyCount = 0;
    this.snapshot = {
      entryIds: [],
      roundIds: [],
      latestRoundId: null,
      latestCompactionId: null,
      hasEarlier: timeline?.hasEarlier ?? false,
      nextCursor: timeline?.nextCursor ?? null,
      roundHasEarlier: new Map(
        (timeline?.rounds ?? []).map((round) => [round.id, round.hasEarlier]),
      ),
      workspaceApplyRunning: false,
      compacting: false,
    };
    this.structureChanged = true;
    this.update(entries);
  }

  /** 前插更早一页，轮次头只补一次，已加载轮次继续向头部合并。 */
  public prepend_page(page: AgentTimelinePage): void {
    const added_entries: string[] = [];
    const page_rounds: string[] = [];
    for (const header of page.headers) {
      if (!this.entries.has(header.id)) {
        this.entries.set(header.id, header);
        this.changed.add(header.id);
      }
      if (!this.rounds.has(header.id)) {
        this.rounds.set(header.id, EMPTY_IDS);
        page_rounds.push(header.id);
      }
    }
    const by_round = new Map<string, AgentEntry[]>();
    for (const entry of page.entries) {
      const round_id = this.resolve_round(entry);
      if (round_id === null) continue;
      const list = by_round.get(round_id) ?? [];
      list.push(entry);
      by_round.set(round_id, list);
      if (!this.entries.has(entry.id)) {
        this.entries.set(entry.id, entry);
        this.changed.add(entry.id);
      }
    }
    for (const [round_id, additions] of by_round) {
      this.rounds.set(round_id, [...additions.map((entry) => entry.id), ...this.round(round_id)]);
    }
    // 新页按“轮次头 + 该轮次内容”的显示顺序进入全局身份列表。
    for (const header of page.headers) {
      if (!this.snapshot.entryIds.includes(header.id)) added_entries.push(header.id);
      for (const entry of by_round.get(header.id) ?? []) {
        if (!this.snapshot.entryIds.includes(entry.id)) added_entries.push(entry.id);
      }
    }
    const round_has = new Map(this.snapshot.roundHasEarlier);
    for (const round of page.rounds) round_has.set(round.id, round.hasEarlier);
    this.snapshot = {
      ...this.snapshot,
      entryIds: [...added_entries, ...this.snapshot.entryIds],
      roundIds: [...page_rounds, ...this.snapshot.roundIds],
      latestRoundId: this.snapshot.latestRoundId ?? page.rounds.at(-1)?.id ?? null,
      hasEarlier: page.hasEarlier,
      nextCursor: page.nextCursor,
      roundHasEarlier: round_has,
    };
    this.structureChanged = true;
  }

  /** 回到跟随时只保留最新窗口，释放更早页。 */
  public trim_to_latest_window(size: number): void {
    const content_ids = this.snapshot.entryIds.filter((id) => {
      const entry = this.entries.get(id);
      return entry !== undefined && !is_round_header(entry);
    });
    if (content_ids.length <= size) return;
    const kept_content = content_ids.slice(-size);
    const dropped_rounds = new Set<string>();
    for (const id of content_ids.slice(0, content_ids.length - size)) {
      dropped_rounds.add(this.entries.get(id)!.roundId);
    }
    const kept_rounds = new Set<string>();
    for (const id of kept_content) kept_rounds.add(this.entries.get(id)!.roundId);
    const kept = new Set<string>(kept_content);
    for (const round_id of kept_rounds) kept.add(round_id);
    const kept_entries = this.snapshot.entryIds
      .filter((id) => kept.has(id))
      .map((id) => this.entries.get(id)!);
    const earliest = kept_content[0] ?? null;
    this.replace(kept_entries, {
      hasEarlier: earliest !== null,
      nextCursor: earliest,
      rounds: [...kept_rounds].map((id) => ({
        id,
        // 本地丢弃过该轮次内容时，仍可继续向上加载。
        hasEarlier: dropped_rounds.has(id) || (this.snapshot.roundHasEarlier.get(id) ?? false),
      })),
    });
  }

  /** 应用批次中的条目，追加身份时按条目自身 `roundId` 归属。 */
  public update(entries: readonly AgentEntry[]): void {
    const addedIds: string[] = [];
    const addedRounds: string[] = [];
    let latestRoundId = this.snapshot.latestRoundId;
    let latestCompactionId = this.snapshot.latestCompactionId;
    const roundAdditions = new Map<string, string[]>();
    // 先登记轮次头，再归属内容，避免同一批次内内容先于头部到达。
    const ordered = [...entries].sort(
      (a, b) => Number(is_round_header(b)) - Number(is_round_header(a)),
    );
    for (const entry of ordered) {
      const previous = this.entries.get(entry.id);
      if (previous === entry) continue;
      if (
        previous?.kind === "tool_call" &&
        previous.toolName === "workspace_apply" &&
        previous.status === "running"
      )
        this.applyCount--;
      if (
        entry.kind === "tool_call" &&
        entry.toolName === "workspace_apply" &&
        entry.status === "running"
      )
        this.applyCount++;
      this.entries.set(entry.id, entry);
      this.changed.add(entry.id);
      // 迟到终帧只更新内容，只有新条目推进轮次与压缩身份。
      if (previous !== undefined) continue;
      addedIds.push(entry.id);
      if (entry.kind === "context_compaction") latestCompactionId = entry.id;
      if (is_round_header(entry)) {
        latestRoundId = entry.id;
        if (!this.rounds.has(entry.id)) {
          addedRounds.push(entry.id);
          this.rounds.set(entry.id, EMPTY_IDS);
        }
        continue;
      }
      const round_id = this.resolve_round(entry, latestRoundId);
      if (round_id === null) continue;
      const additions = roundAdditions.get(round_id) ?? [];
      additions.push(entry.id);
      roundAdditions.set(round_id, additions);
      if (entry.kind === "assistant_message") this.assistants.set(round_id, entry.id);
    }
    for (const [id, additions] of roundAdditions)
      this.rounds.set(id, [...this.round(id), ...additions]);
    const compacting = this.entry(latestCompactionId)?.status === "running";
    const workspaceApplyRunning = this.applyCount > 0;
    if (
      addedIds.length > 0 ||
      compacting !== this.snapshot.compacting ||
      workspaceApplyRunning !== this.snapshot.workspaceApplyRunning
    ) {
      this.snapshot = {
        entryIds:
          addedIds.length === 0 ? this.snapshot.entryIds : [...this.snapshot.entryIds, ...addedIds],
        roundIds:
          addedRounds.length === 0
            ? this.snapshot.roundIds
            : [...this.snapshot.roundIds, ...addedRounds],
        latestRoundId,
        latestCompactionId,
        hasEarlier: this.snapshot.hasEarlier,
        nextCursor: this.snapshot.nextCursor,
        roundHasEarlier: this.snapshot.roundHasEarlier,
        compacting,
        workspaceApplyRunning,
      };
      this.structureChanged = true;
    }
  }

  /** 同一传输批次的其他切片已更新后，才通知组件读取。 */
  public notify(): void {
    const ids = [...this.changed];
    this.changed.clear();
    const structureChanged = this.structureChanged;
    this.structureChanged = false;
    if (structureChanged) for (const listener of this.structureListeners) listener();
    for (const id of ids) for (const listener of this.listeners.get(id) ?? []) listener();
  }

  /** 条目归属优先使用自身 `roundId`；旧载荷缺少归属时回退到当前最新轮次。 */
  private resolve_round(entry: AgentEntry, fallback = this.snapshot.latestRoundId): string | null {
    if (entry.roundId === "") return fallback;
    return this.rounds.has(entry.roundId) ? entry.roundId : null;
  }
}
