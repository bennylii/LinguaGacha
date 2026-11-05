import type { ProjectItemPublicRecord } from "../../domain/item";
import { build_project_item_duplicate_key } from "../../shared/project/project-item-duplicates";
import type { ProjectCommittedItems } from "../project/project-committed-change";
import { ItemColumnStore } from "./item-column-store";

/** 达到该条目数才启用列式主数据；小工程沿用对象 Map，避免列式固定开销。 */
export const ITEM_COLUMNAR_THRESHOLD = 50_000;

/**
 * 主数据的两种表示共用同一组读取与写入语义：
 * 顺序 = 基线顺序 + 新身份追加顺序；按身份读取返回浅克隆；upsert 在既有身份上保持位置。
 */
interface ItemStore {
  size(): number;
  read_all(): ProjectItemPublicRecord[];
  read_by_id(item_id: number): ProjectItemPublicRecord | null;
  values(): Iterable<ProjectItemPublicRecord>;
  /** 返回变化前的原始记录，供调用方判断重复组键是否失效。 */
  previous(item_id: number): ProjectItemPublicRecord | undefined;
  upsert(item: ProjectItemPublicRecord): void;
}

/** 小规模默认路径：数据库主键顺序由 Map 插入顺序天然维护。 */
class MapItemStore implements ItemStore {
  private readonly items = new Map<number, ProjectItemPublicRecord>();

  public constructor(records: readonly ProjectItemPublicRecord[]) {
    for (const item of records) this.items.set(item.item_id, { ...item });
  }

  public size(): number {
    return this.items.size;
  }
  public read_all(): ProjectItemPublicRecord[] {
    return Array.from(this.items.values(), (item) => ({ ...item }));
  }
  public read_by_id(item_id: number): ProjectItemPublicRecord | null {
    const item = this.items.get(item_id);
    return item === undefined ? null : { ...item };
  }
  public values(): Iterable<ProjectItemPublicRecord> {
    return this.items.values();
  }
  public previous(item_id: number): ProjectItemPublicRecord | undefined {
    return this.items.get(item_id);
  }
  public upsert(item: ProjectItemPublicRecord): void {
    this.items.set(item.item_id, { ...item });
  }
}

/**
 * 大规模路径：列式基线保存全量只读主数据，delta 只落在轻量覆盖层。
 * 覆盖层随写入增长，压实（合并回新基线）属于后续一致性步骤。
 */
class ColumnarItemStore implements ItemStore {
  private readonly base: ItemColumnStore;
  private readonly base_order: number[];
  private readonly known_ids: Set<number>;
  private readonly overlay = new Map<number, ProjectItemPublicRecord>();
  private readonly appended: number[] = [];

  public constructor(records: readonly ProjectItemPublicRecord[]) {
    const seen = new Map<number, ProjectItemPublicRecord>();
    for (const item of records) seen.set(item.item_id, item);
    const normalized = [...seen.values()];
    this.base = ItemColumnStore.from_records(normalized);
    this.base_order = normalized.map((item) => item.item_id);
    this.known_ids = new Set(this.base_order);
  }

  private order(): number[] {
    return [...this.base_order, ...this.appended];
  }
  private is_known(item_id: number): boolean {
    return this.known_ids.has(item_id);
  }

  public size(): number {
    return this.order().length;
  }
  public read_all(): ProjectItemPublicRecord[] {
    const result: ProjectItemPublicRecord[] = [];
    for (const item_id of this.order()) {
      const overlayed = this.overlay.get(item_id);
      if (overlayed !== undefined) {
        result.push({ ...overlayed });
        continue;
      }
      const record = this.base.read_by_id(item_id);
      if (record !== null) result.push(record);
    }
    return result;
  }
  public read_by_id(item_id: number): ProjectItemPublicRecord | null {
    const overlayed = this.overlay.get(item_id);
    if (overlayed !== undefined) return { ...overlayed };
    return this.base.read_by_id(item_id);
  }
  public *values(): Generator<ProjectItemPublicRecord> {
    for (const item_id of this.order()) {
      const overlayed = this.overlay.get(item_id);
      if (overlayed !== undefined) {
        yield overlayed;
        continue;
      }
      const record = this.base.read_by_id(item_id);
      if (record !== null) yield record;
    }
  }
  public previous(item_id: number): ProjectItemPublicRecord | undefined {
    const overlayed = this.overlay.get(item_id);
    if (overlayed !== undefined) return overlayed;
    return this.base.read_by_id(item_id) ?? undefined;
  }
  public upsert(item: ProjectItemPublicRecord): void {
    if (!this.is_known(item.item_id)) {
      this.known_ids.add(item.item_id);
      this.appended.push(item.item_id);
    }
    this.overlay.set(item.item_id, { ...item });
  }
}

/**
 * ItemCache 维护按数据库顺序插入的 item 主索引。
 * 默认用对象 Map；全量替换达到阈值时切到列式主数据 + delta 覆盖层，对外契约不变。
 */
export class ItemCache {
  private store: ItemStore = new MapItemStore([]);
  private duplicate_groups: Map<string, number[]> | null = null; // 只保留真实重复组，结构变化后按需重建。

  /**
   * before_read 由 CacheManager 注入，用来在读取前恢复缓存。
   * columnar_threshold 仅用于测试：注入较小值即可在两条表示间做等价对照。
   */
  public constructor(
    private readonly before_read: () => void = () => undefined,
    private readonly columnar_threshold: number = ITEM_COLUMNAR_THRESHOLD,
  ) {}

  /**
   * 用完整 item 快照重建索引；按规模选择底层表示。
   */
  public replace(item_records: readonly ProjectItemPublicRecord[]): void {
    const normalized = this.deduplicate(item_records);
    this.store =
      normalized.length >= this.columnar_threshold
        ? new ColumnarItemStore(normalized)
        : new MapItemStore(normalized);
    this.duplicate_groups = null;
  }

  /** 清空全部 item 索引，回到默认小工程表示。 */
  public clear(): void {
    this.store = new MapItemStore([]);
    this.duplicate_groups = null;
  }

  /**
   * 应用已提交的完整替换或规范行增量。
   */
  public applyChange(change: ProjectCommittedItems): void {
    if (change.mode === "full") {
      this.replace(change.records);
      return;
    }
    for (const record of change.records) this.upsert_item(record);
  }

  /** 显式目标总是保留，同组只补入会参与重复协调的成员。 */
  public readWriteScope(item_ids: readonly number[]): number[] {
    this.before_read();
    if (this.duplicate_groups === null) {
      const groups = new Map<string, number[]>();
      for (const item of this.store.values()) {
        const key = build_project_item_duplicate_key(item);
        const group = groups.get(key);
        if (group === undefined) groups.set(key, [item.item_id]);
        else group.push(item.item_id);
      }
      for (const [key, members] of groups) if (members.length < 2) groups.delete(key);
      this.duplicate_groups = groups;
    }
    const ids = new Set(item_ids);
    const visited = new Set<string>();
    for (const id of item_ids) {
      const item = this.store.read_by_id(id);
      if (item === null) continue;
      const key = build_project_item_duplicate_key(item);
      if (visited.has(key)) continue;
      visited.add(key);
      for (const member of this.duplicate_groups.get(key) ?? []) {
        const record = this.store.read_by_id(member);
        const status = record?.status;
        if (
          status === "NONE" ||
          status === "DUPLICATED" ||
          status === "PROCESSED" ||
          status === "ERROR"
        )
          ids.add(member);
      }
    }
    return [...ids].sort((a, b) => a - b);
  }

  /**
   * 读取全部 item，返回浅克隆数组。
   */
  public readItems(): ProjectItemPublicRecord[] {
    this.before_read();
    return this.store.read_all();
  }

  /**
   * 按 item_id 读取单条记录，未命中返回 null。
   */
  public readItem(item_id: number): ProjectItemPublicRecord | null {
    this.before_read();
    return this.store.read_by_id(item_id);
  }

  /**
   * 返回当前缓存中有效 item 数量。
   */
  public size(): number {
    return this.store.size();
  }

  /**
   * 写入单条 item；既有身份保持顺序，新身份追加到末尾。
   */
  private upsert_item(item: ProjectItemPublicRecord): void {
    const previous = this.store.previous(item.item_id);
    if (
      previous === undefined ||
      build_project_item_duplicate_key(previous) !== build_project_item_duplicate_key(item)
    )
      this.duplicate_groups = null;
    this.store.upsert(item);
  }

  /** 与 Map 构造一致：重复身份保留首次位置、值取最后一次。 */
  private deduplicate(records: readonly ProjectItemPublicRecord[]): ProjectItemPublicRecord[] {
    const seen = new Map<number, ProjectItemPublicRecord>();
    for (const item of records) seen.set(item.item_id, item);
    return [...seen.values()];
  }
}
