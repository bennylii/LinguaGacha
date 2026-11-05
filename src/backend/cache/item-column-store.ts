import type { ProjectItemPublicRecord } from "../../domain/item";

/**
 * 工程条目的列式只读存储。
 *
 * 同一批条目只保留一份主数据：数值与布尔列用 TypedArray，文本与任意 JSON 字段
 * 按列保存原值引用。消费方按行号或条目身份惰性组装出公开的完整记录，组装产物
 * 是临时值、不进入常驻索引。这样避免每个子系统各自展开一套全量对象数组。
 *
 * 当前为独立组件，尚未接入产品运行时；`ItemCache` 的契约与增量写入语义保持不变。
 * 跨修订一致性、原子换索引和按工程规模分流属于后续接入步骤。
 */
export class ItemColumnStore {
  private readonly item_ids: Uint32Array;
  private readonly row_numbers: Uint32Array;
  private readonly skipped: Uint8Array;
  private readonly src: string[];
  private readonly dst: string[];
  private readonly name_src: ProjectItemPublicRecord["name_src"][];
  private readonly name_dst: ProjectItemPublicRecord["name_dst"][];
  private readonly extra_field: ProjectItemPublicRecord["extra_field"][];
  private readonly tag: string[];
  private readonly file_type: ProjectItemPublicRecord["file_type"][];
  private readonly file_path: string[];
  private readonly status: ProjectItemPublicRecord["status"][];
  private readonly index_by_id: Map<number, number>;

  private constructor(records: readonly ProjectItemPublicRecord[]) {
    const count = records.length;
    this.item_ids = new Uint32Array(count);
    this.row_numbers = new Uint32Array(count);
    this.skipped = new Uint8Array(count);
    this.src = Array.from<string>({ length: count });
    this.dst = Array.from<string>({ length: count });
    this.name_src = Array.from<ProjectItemPublicRecord["name_src"]>({ length: count });
    this.name_dst = Array.from<ProjectItemPublicRecord["name_dst"]>({ length: count });
    this.extra_field = Array.from<ProjectItemPublicRecord["extra_field"]>({ length: count });
    this.tag = Array.from<string>({ length: count });
    this.file_type = Array.from<ProjectItemPublicRecord["file_type"]>({ length: count });
    this.file_path = Array.from<string>({ length: count });
    this.status = Array.from<ProjectItemPublicRecord["status"]>({ length: count });
    this.index_by_id = new Map();
    for (let i = 0; i < count; i++) {
      const record = records[i]!;
      this.item_ids[i] = record.item_id;
      this.row_numbers[i] = record.row_number;
      this.skipped[i] = record.skip_internal_filter ? 1 : 0;
      this.src[i] = record.src;
      this.dst[i] = record.dst;
      this.name_src[i] = record.name_src;
      this.name_dst[i] = record.name_dst;
      this.extra_field[i] = record.extra_field;
      this.tag[i] = record.tag;
      this.file_type[i] = record.file_type;
      this.file_path[i] = record.file_path;
      this.status[i] = record.status;
      this.index_by_id.set(record.item_id, i);
    }
  }

  /** 用完整记录快照建立列式主数据；重复身份由后续写入契约保证不出现。 */
  public static from_records(records: readonly ProjectItemPublicRecord[]): ItemColumnStore {
    return new ItemColumnStore(records);
  }

  public size(): number {
    return this.item_ids.length;
  }

  /** 按行号惰性组装一条与公开记录同形的对象。 */
  public read(index: number): ProjectItemPublicRecord | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.item_ids.length) return null;
    return {
      item_id: this.item_ids[index]!,
      src: this.src[index]!,
      dst: this.dst[index]!,
      name_src: this.name_src[index]!,
      name_dst: this.name_dst[index]!,
      extra_field: this.extra_field[index]!,
      tag: this.tag[index]!,
      row_number: this.row_numbers[index]!,
      file_type: this.file_type[index]!,
      file_path: this.file_path[index]!,
      status: this.status[index]!,
      skip_internal_filter: this.skipped[index] === 1,
    };
  }

  /** 按条目身份 O(1) 定位行号后组装；未命中返回 null。 */
  public read_by_id(item_id: number): ProjectItemPublicRecord | null {
    const index = this.index_by_id.get(item_id);
    return index === undefined ? null : this.read(index);
  }

  /** 只读顺序迭代，逐条组装，不构造常驻的完整对象数组。 */
  public *iterate(): Generator<ProjectItemPublicRecord> {
    for (let i = 0; i < this.item_ids.length; i++) yield this.read(i)!;
  }

  /** 一次性返回浅克隆数组；仅供仍需要数组的消费者，标注为 O(N) 物化。 */
  public read_all(): ProjectItemPublicRecord[] {
    return Array.from(this.iterate());
  }
}
