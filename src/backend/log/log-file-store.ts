import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import { AppError, normalize_log_error } from "../../shared/error";
import {
  format_log_content_text,
  normalize_log_level,
  read_log_content,
  LOG_PAGE_SIZE,
  LOG_WINDOW_MESSAGE_PREVIEW_LENGTH,
  type LogDetail,
  type LogEntry,
  type LogFileRecord,
  type LogFileRef,
  type LogPage,
  type LogPageRequest,
} from "../../shared/log";

const LOG_DATES_TO_KEEP = 3;
const READ_CHUNK_BYTES = 64 * 1024;
const PAGE_SCAN_BYTES = 1024 * 1024;
const DATE_PATTERN = /^\d{8}$/;
// 实例标识取进程 PID；PID 复用时追加启动时间后缀，后缀只含小写字母和数字。
const INSTANCE_PATTERN = /^[0-9a-z]+(?:-[0-9a-z]+)?$/;
const LOG_PATTERN = /^app\.(\d{8})\.([0-9a-z]+(?:-[0-9a-z]+)?)\.(?:jsonl|idx\.jsonl)$/;
const BODY_PATTERN = /^app\.(\d{8})\.([0-9a-z]+(?:-[0-9a-z]+)?)\.jsonl$/;
// 无实例段的旧格式既不展示也不再写入，只参与保留期清理。
const LEGACY_PATTERN = /^app\.(\d{8})\.(?:log|jsonl|idx\.jsonl)$/;
const LF = 10;

type IndexEntry = Omit<LogEntry, "id" | "date" | "instance" | "line" | "revision"> & {
  offset: number;
};
type IndexRecord = {
  line: number; // 隐藏及损坏正文也占一行
  end: number; // 此行末尾 LF 之后的正文字节位置
  entry?: IndexEntry; // 只有窗口可见正文才保存摘要
};
type Line = { start: number; end: number; bytes: Buffer };
type IndexedRecord = { record: IndexRecord | null; start: number; end: number };

type IndexState = {
  line: number; // 已索引的完整正文行数
  end: number; // 最后一条完整正文的末尾位置
  scanned: number; // 已扫描大小可能包含未结束尾行，避免反复重建
  size: number; // 自有实例为索引文件字节数；只读实例为内存索引的记录条数
  revision: string; // 索引建立时的内容代次，读取期间保持快照身份
  records: IndexRecord[] | null; // 只读实例的索引只在内存中存在，不回写磁盘
};

type FileSnapshot = {
  stamp: string | null; // null 表示文件缺失
  dev: number | null;
  ino: number | null;
  size: number;
};

type SourceState = FileSnapshot & {
  revision: string; // 正文编辑或索引失效后更换的内容代次
  append_ready: boolean; // 本次文件状态已完成追加前的尾行检查
};

export interface LogFileStoreOptions {
  directory: string;
  fs?: NativeFs;
  instance?: string; // 显式指定时跳过 PID 复用探测，测试用同一进程模拟多个实例
  process_started_at_ms?: number; // PID 复用的判定依据，显式提供可固定时钟
}

/**
 * 每日正文及其可重建索引的唯一拥有者；不缓存正文或完整摘要集合。
 *
 * 多个窗口实例共用同一日志目录，因此文件名带实例标识。索引由写入方独占：
 * 读取其他实例的文件时只读其索引，缺失或损坏时在内存重建，绝不回写磁盘，
 * 否则并发重建会互相截断。
 */
export class LogFileStore {
  private readonly directory: string;
  private readonly fs: NativeFs;
  private readonly own_instance: string; // 本进程写入的文件身份，构造后固定
  private readonly states = new Map<string, IndexState>(); // 可随时重建的索引进度
  private readonly repairs = new Map<string, Promise<void>>(); // 同一文件的查询共享恢复任务
  private readonly sources = new Map<string, SourceState>(); // 正文状态与代次共同失效
  private cleanup_date: string | null = null; // 每个写入日期只触发一次目录清理

  /** 组装日志目录与输出依赖，资源生命周期由调用方管理。 */
  public constructor(options: LogFileStoreOptions) {
    this.directory = options.directory;
    this.fs = options.fs ?? default_native_fs;
    this.fs.make_dir(this.directory);
    this.own_instance =
      options.instance ??
      this.resolve_instance(options.process_started_at_ms ?? process_started_at_ms());
  }

  /**
   * PID 会在重启后被复用。目录里已有同名实例文件且修改时间早于本进程启动，
   * 说明它由上一个进程写入，改用带启动时间后缀的身份，避免追加进别人的日志。
   */
  private resolve_instance(started_at_ms: number): string {
    const pid = String(process.pid);
    const reused = this.fs.read_dir_names(this.directory).some((name) => {
      const match = BODY_PATTERN.exec(name);
      if (match?.[2] !== pid) return false;
      return this.fs.stat(path.join(this.directory, name)).mtimeMs < started_at_ms;
    });
    // 后缀取启动秒数的 36 进制，足以区分同一 PID 的前后两个进程。
    return reused ? `${pid}-${Math.floor(started_at_ms / 1000).toString(36)}` : pid;
  }

  /** 状态键同时包含日期与实例，两类文件互不影响。 */
  private key(date: string, instance: string): string {
    return `${date}:${instance}`;
  }

  private is_own(instance: string): boolean {
    return instance === this.own_instance;
  }

  /** 仅从受限日期与实例构造路径，避免查询参数成为任意文件路径。 */
  private file(date: string, instance: string, index = false): string {
    if (!DATE_PATTERN.test(date) || !INSTANCE_PATTERN.test(instance))
      throw new AppError("request.validation_failed");
    return path.join(this.directory, `app.${date}.${instance}${index ? ".idx" : ""}.jsonl`);
  }

  /** 缺失文件按零长度参与初始化与清理判断。 */
  private size(file: string): number {
    return this.fs.exists(file) ? this.fs.stat(file).size : 0;
  }

  /** 同时识别文件替换和等字节长度的编辑，并保留追加判定所需的设备与长度。 */
  private snapshot(date: string, instance: string): FileSnapshot {
    const file = this.file(date, instance);
    if (!this.fs.exists(file)) return { stamp: null, dev: null, ino: null, size: 0 };
    const stat = this.fs.stat(file);
    return {
      stamp: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"),
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
    };
  }

  /** 只枚举带实例标识的正文，旧格式不再成为可选文件。 */
  public list_files(): LogFileRef[] {
    const files = this.fs.read_dir_names(this.directory).flatMap((name) => {
      const match = BODY_PATTERN.exec(name);
      return match === null ? [] : [{ date: match[1]!, instance: match[2]! }];
    });
    return files
      .map((file) => ({ ...file, current: this.is_own(file.instance) }))
      .sort((left, right) => {
        // 日期倒序为主键；同一天的多个实例把当前实例排在最前，默认选中因此只取第一个 current。
        if (left.date !== right.date) return right.date.localeCompare(left.date);
        if (left.current !== right.current) return left.current ? -1 : 1;
        return left.instance.localeCompare(right.instance);
      });
  }

  /**
   * 自身追加更新已知状态；未知变化一律视为编辑，不能根据长度增长猜测为追加。
   *
   * 例外是其他实例的正文：它只由写入方追加，因此同一文件变大就是追加，
   * 保留代次与扫描进度，否则查看其他实例的日志会每次轮询都重置游标。
   */
  private check_source(date: string, instance: string): string {
    const key = this.key(date, instance);
    const snapshot = this.snapshot(date, instance);
    const source = this.sources.get(key);
    if (source !== undefined && source.stamp === snapshot.stamp) return source.revision;
    if (source !== undefined && this.is_append(source, snapshot, instance)) {
      Object.assign(source, snapshot);
      return source.revision;
    }
    const next: SourceState = { ...snapshot, revision: randomUUID(), append_ready: false };
    this.sources.set(key, next);
    this.states.delete(key);
    return next.revision;
  }

  /** 其他实例的文件变大视为追加；自有文件的任何变化都必须按编辑重建。 */
  private is_append(source: SourceState, snapshot: FileSnapshot, instance: string): boolean {
    if (this.is_own(instance)) return false;
    return (
      source.dev !== null &&
      source.dev === snapshot.dev &&
      source.ino !== null &&
      source.ino === snapshot.ino &&
      snapshot.size > source.size
    );
  }

  /** 已由 check_source 建立文件状态；索引失效也使在途游标过期。 */
  private invalidate(date: string, instance: string): void {
    const key = this.key(date, instance);
    this.states.delete(key);
    const source = this.sources.get(key);
    if (source !== undefined) source.revision = randomUUID();
  }

  /** 正文同步追加后记录自身文件状态，外部保存不会被随后的追加掩盖。 */
  public append(date: string, record: LogFileRecord): void {
    const instance = this.own_instance;
    const key = this.key(date, instance);
    const file = this.file(date, instance);
    this.check_source(date, instance);
    const source = this.sources.get(key)!;
    try {
      if (!source.append_ready) {
        if (this.fs.exists(file)) {
          const last = this.fs.read_last_byte(file);
          if (last !== null && last !== LF) this.fs.append_text_file(file, "\n");
        } else {
          this.fs.write_file_sync(this.file(date, instance, true), "");
          this.states.set(key, {
            line: 0,
            end: 0,
            scanned: 0,
            size: 0,
            revision: source.revision,
            records: null,
          });
        }
        source.append_ready = true;
      }
      const offset = this.size(file);
      const text = `${JSON.stringify(record)}\n`;
      this.fs.append_text_file(file, text);
      Object.assign(source, this.snapshot(date, instance));
      const state = this.states.get(key);
      if (state !== undefined && !this.repairs.has(key) && state.end === offset) {
        try {
          this.record_index(
            date,
            instance,
            this.index_record(record, state.line + 1, offset, offset + Buffer.byteLength(text)),
          );
        } catch (error) {
          this.invalidate(date, instance);
          this.report(error);
        }
      }
    } catch (error) {
      this.invalidate(date, instance);
      this.report(error);
    }
    if (!this.states.has(key) && !this.repairs.has(key) && this.fs.exists(file)) {
      // 恢复任务已报告 IO 故障，后台失败不会丢失正文；查询时可以重试。
      void this.ensure_index(date, instance).catch(() => undefined);
    }
    if (this.cleanup_date !== date) {
      this.cleanup_date = date;
      this.cleanup();
    }
  }

  /** 摘要与进度同条提交，隐藏和损坏行仍计入物理行数。 */
  private index_record(
    record: LogFileRecord | null,
    line: number,
    offset: number,
    end: number,
  ): IndexRecord {
    if (record === null || record.window === false) return { line, end };
    const message = format_log_content_text(record.content).replace(/\r\n?/g, "\n");
    return {
      line,
      end,
      entry: {
        offset,
        created_at: record.created_at,
        level: record.level,
        source: record.source,
        message_preview: message.trim().slice(0, LOG_WINDOW_MESSAGE_PREVIEW_LENGTH),
        message_length: message.length,
      },
    };
  }

  /** 自有实例写磁盘索引，只读实例写内存索引，两条路径共用调用点。 */
  private record_index(date: string, instance: string, record: IndexRecord): void {
    const key = this.key(date, instance);
    const state = this.states.get(key);
    const source = this.sources.get(key);
    if (source === undefined) throw new Error("Log source state is missing.");
    if (this.is_own(instance)) {
      const text = `${JSON.stringify(record)}\n`;
      this.fs.append_text_file(this.file(date, instance, true), text);
      this.states.set(key, {
        line: record.line,
        end: record.end,
        scanned: record.end,
        size: (state?.size ?? 0) + Buffer.byteLength(text),
        revision: source.revision,
        records: null,
      });
      return;
    }
    const records = state?.records ?? [];
    records.push(record);
    this.states.set(key, {
      line: record.line,
      end: record.end,
      scanned: record.end,
      size: records.length,
      revision: source.revision,
      records,
    });
  }

  /** 分块读取完整 LF 记录；大正文的分块只在整条完成时合并一次。 */
  private async *lines(
    file: string,
    start: number,
    end: number,
    reverse = false,
  ): AsyncGenerator<Line> {
    if (!reverse) {
      let line_start = start;
      let parts: Buffer[] = [];
      for (let position = start; position < end; position += READ_CHUNK_BYTES) {
        const length = Math.min(READ_CHUNK_BYTES, end - position);
        const chunk = await this.fs.read_range(file, position, length);
        if (chunk.length !== length) throw new Error("Log file changed during range read");
        let begin = 0;
        let newline = chunk.indexOf(LF);
        while (newline >= 0) {
          parts.push(chunk.subarray(begin, newline + 1));
          yield {
            start: line_start,
            end: position + newline + 1,
            bytes: parts.length === 1 ? parts[0]! : Buffer.concat(parts),
          };
          parts = [];
          begin = newline + 1;
          line_start = position + begin;
          newline = chunk.indexOf(LF, begin);
        }
        if (begin < chunk.length) parts.push(chunk.subarray(begin));
      }
      return;
    }
    // 逆向只读取已提交的索引范围；pending 保留跨块的单行片段。
    let position = end;
    let pending = Buffer.alloc(0);
    while (position > start) {
      const next = Math.max(start, position - READ_CHUNK_BYTES);
      const chunk = await this.fs.read_range(file, next, position - next);
      if (chunk.length !== position - next) throw new Error("Log file changed during range read");
      position = next;
      pending = Buffer.concat([chunk, pending]);
      let stop = pending.length;
      while (stop > 0) {
        const previous = stop <= 1 ? -1 : pending.lastIndexOf(LF, stop - 2);
        if (previous < 0 && position !== start) break;
        const begin = previous + 1;
        yield {
          start: position + begin,
          end: position + stop,
          bytes: pending.subarray(begin, stop),
        };
        stop = begin;
      }
      pending = pending.subarray(0, stop);
    }
  }

  /**
   * 同日期同实例的查询共享恢复任务，只复用与文件状态匹配的索引。
   * 只读实例的索引常驻内存，因此不需要核对索引文件长度。
   */
  private async ensure_index(date: string, instance: string): Promise<void> {
    const key = this.key(date, instance);
    this.check_source(date, instance);
    const pending = this.repairs.get(key);
    if (pending !== undefined) return pending;
    const state = this.states.get(key);
    const body_size = this.size(this.file(date, instance));
    if (state !== undefined) {
      const index_matches =
        state.records !== null || state.size === this.size(this.file(date, instance, true));
      if (index_matches && state.scanned === body_size) return;
      // 其他实例仍在运行的正文只追加，代次未变时续扫尾部即可，游标继续有效。
      if (state.records !== null && state.revision === this.sources.get(key)?.revision) {
        const task = this.scan_tail(date, instance, state.revision).then((restart) => {
          if (restart) return this.repair(date, instance);
        });
        this.repairs.set(key, task);
        try {
          await task;
        } finally {
          this.repairs.delete(key);
        }
        return;
      }
    }
    if (state !== undefined) this.invalidate(date, instance);
    const task = this.repair(date, instance);
    this.repairs.set(key, task);
    try {
      await task;
    } finally {
      this.repairs.delete(key);
    }
  }

  /** 首次访问和外部编辑都重建，省去跨进程信任旧索引的元数据协议。 */
  private async repair(date: string, instance: string): Promise<void> {
    const key = this.key(date, instance);
    const owns = this.is_own(instance);
    try {
      while (true) {
        const revision = this.check_source(date, instance);
        if (owns) {
          // 自有索引可以由本进程随时清空重建。
          this.fs.write_file_sync(this.file(date, instance, true), "");
          this.states.set(key, {
            line: 0,
            end: 0,
            scanned: 0,
            size: 0,
            revision,
            records: null,
          });
        } else {
          this.states.set(key, {
            line: 0,
            end: 0,
            scanned: 0,
            size: 0,
            revision,
            records: [],
          });
        }
        if (!(await this.scan_tail(date, instance, revision))) return;
      }
    } catch (error) {
      this.invalidate(date, instance);
      this.report(error);
      throw error;
    }
  }

  /** 从已扫位置续扫到当前末尾；返回是否因正文编辑需要整轮重建。 */
  private async scan_tail(date: string, instance: string, revision: string): Promise<boolean> {
    const key = this.key(date, instance);
    const file = this.file(date, instance);
    while (true) {
      const start = this.states.get(key)!.end;
      const end = this.size(file);
      for await (const line of this.lines(file, start, end)) {
        if (this.sources.get(key)?.revision !== revision) return true;
        const record = read_record(line.bytes);
        const number = this.states.get(key)!.line + 1;
        if (record === null)
          this.report(new Error(`Invalid log record at ${date}:${String(number)}`));
        this.record_index(date, instance, this.index_record(record, number, line.start, line.end));
      }
      if (this.check_source(date, instance) !== revision) return true;
      if (this.size(file) === end) {
        this.states.get(key)!.scanned = end;
        return false;
      }
    }
  }

  /**
   * 统一按位置游标读取索引记录。自有实例从磁盘索引流式读取，
   * 只读实例从内存索引切片；位置域分别是字节与记录序号，调用方无需区分。
   */
  private async *index_records(
    date: string,
    instance: string,
    from: number,
    to: number,
    reverse: boolean,
  ): AsyncGenerator<IndexedRecord> {
    const state = this.states.get(this.key(date, instance));
    const records = state?.records ?? null;
    if (records !== null) {
      const begin = Math.max(0, Math.min(from, records.length));
      const finish = Math.max(begin, Math.min(to, records.length));
      if (!reverse) {
        for (let index = begin; index < finish; index += 1)
          yield { record: records[index]!, start: index, end: index + 1 };
        return;
      }
      for (let index = finish - 1; index >= begin; index -= 1)
        yield { record: records[index]!, start: index, end: index + 1 };
      return;
    }
    const index_file = this.file(date, instance, true);
    const index_size = state?.size ?? 0;
    // 中点在记录内部时先丢弃这条不完整记录，再按完整记录比较。
    let dropping =
      !reverse &&
      from > 0 &&
      from < index_size &&
      (await this.fs.read_range(index_file, from - 1, 1))[0] !== LF;
    for await (const line of this.lines(index_file, from, to, reverse)) {
      if (dropping) {
        dropping = false;
        continue;
      }
      yield { record: read_index(line.bytes), start: line.start, end: line.end };
    }
  }

  /** 索引按物理行号递增，二分定位避免详情从头扫描所有摘要。 */
  private async find_line(
    date: string,
    instance: string,
    number: number,
  ): Promise<IndexedRecord | null> {
    const size = this.states.get(this.key(date, instance))!.size;
    let low = 0;
    let high = size;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      let found = false;
      for await (const item of this.index_records(date, instance, middle, size, false)) {
        if (item.start >= high) break;
        if (item.record === null) {
          this.invalidate(date, instance);
          return null;
        }
        if (item.record.line === number) return item;
        if (item.record.line < number) low = item.end;
        else high = middle;
        found = true;
        break;
      }
      if (!found) high = middle;
    }
    return null;
  }

  /** 将读取期间的清理和外部编辑归一成公开查询状态。 */
  public async read_page(request: LogPageRequest): Promise<LogPage> {
    validate_request(request);
    const { date, instance } = request;
    const file = this.file(date, instance);
    if (!this.fs.exists(file)) return empty_page("expired");
    try {
      const page = await this.read_date_page(request);
      if (!this.fs.exists(file)) return empty_page("expired");
      if (page.after !== null && page.after.revision !== this.check_source(date, instance))
        return empty_page("cursor_invalid");
      return page;
    } catch (error) {
      if (!this.fs.exists(file)) return empty_page("expired");
      throw error;
    }
  }

  /** 在一个日期文件内读取有界索引页，列表不加载完整正文。 */
  private async read_date_page(request: LogPageRequest): Promise<LogPage> {
    const { date, instance } = request;
    await this.ensure_index(date, instance);
    const state = this.states.get(this.key(date, instance))!;
    const cursor = request.cursor;
    if (cursor !== undefined && (cursor.revision !== state.revision || cursor.line > state.line))
      return empty_page("cursor_invalid");
    if (request.direction === "check")
      return { ...empty_page("ready"), before: cursor!, after: cursor! };
    const reverse = request.direction !== "after";
    const initial_line = cursor?.line ?? (reverse ? state.line : 0);
    const at_end = initial_line === state.line;
    const boundary =
      initial_line === 0 || at_end ? null : await this.find_line(date, instance, initial_line);
    if (initial_line > 0 && !at_end && boundary === null) return empty_page("cursor_invalid");
    const position = at_end ? state.size : (boundary?.end ?? 0);
    const initial = { date, instance, line: initial_line, revision: state.revision };
    const result: LogPage = { ...empty_page("ready"), before: initial, after: initial };
    let scanned = 0;
    for await (const item of this.index_records(
      date,
      instance,
      reverse ? 0 : position,
      reverse ? position : state.size,
      reverse,
    )) {
      const record = item.record;
      if (record === null) {
        this.invalidate(date, instance);
        return empty_page("cursor_invalid");
      }
      scanned += item.end - item.start;
      if (reverse) result.before = { ...initial, line: record.line - 1 };
      else result.after = { ...initial, line: record.line };
      if (record.entry !== undefined) {
        const { offset: _offset, ...entry } = record.entry;
        result.entries.push({
          ...entry,
          id: `${date}:${instance}:${String(record.line)}`,
          date,
          instance,
          line: record.line,
          revision: state.revision,
        });
      }
      if (result.entries.length >= (request.limit ?? LOG_PAGE_SIZE) || scanned >= PAGE_SCAN_BYTES) {
        result.has_more = reverse ? record.line > 1 : item.end < state.size;
        break;
      }
    }
    if (reverse) result.entries.reverse();
    return result;
  }

  /** 核对内容代次后定位正文，拒绝编辑前的过期行号请求。 */
  public async read_detail(id: string, revision: string): Promise<LogDetail | null> {
    const match = /^(\d{8}):([0-9a-z]+(?:-[0-9a-z]+)?):([1-9]\d*)$/.exec(id);
    const date = match?.[1];
    const instance = match?.[2];
    const number = Number(match?.[3]);
    if (
      date === undefined ||
      instance === undefined ||
      !is_offset(number) ||
      typeof revision !== "string"
    )
      throw new AppError("request.validation_failed");
    const file = this.file(date, instance);
    if (!this.fs.exists(file)) return null;
    try {
      await this.ensure_index(date, instance);
      if (this.sources.get(this.key(date, instance))?.revision !== revision) return null;
      const indexed = await this.find_line(date, instance, number);
      if (indexed?.record?.entry === undefined) return null;
      const offset = indexed.record.entry.offset;
      const bytes = await this.fs.read_range(file, offset, indexed.record.end - offset);
      if (this.check_source(date, instance) !== revision || bytes.indexOf(LF) !== bytes.length - 1)
        return null;
      const record = read_record(bytes);
      if (record === null || record.window === false) return null;
      const { window: _window, ...detail } = record;
      return { ...detail, id, date, instance, line: number, revision };
    } catch (error) {
      if (!this.fs.exists(file)) return null;
      throw error;
    }
  }

  /** 按日期共同清理正文与附属文件，避开在途恢复任务。 */
  private cleanup(): void {
    const groups = new Map<string, string[]>();
    for (const name of this.fs.read_dir_names(this.directory)) {
      const date = (LOG_PATTERN.exec(name) ?? LEGACY_PATTERN.exec(name))?.[1];
      if (date === undefined) continue;
      const names = groups.get(date) ?? [];
      names.push(name);
      groups.set(date, names);
    }
    const keep = new Set(
      [...groups.keys()].sort().reverse().slice(0, LOG_DATES_TO_KEEP),
    );
    const repairing = new Set([...this.repairs.keys()].map((key) => key.slice(0, 8)));
    for (const [date, names] of groups) {
      if (keep.has(date) || repairing.has(date)) continue;
      for (const name of names) {
        try {
          // 多个实例会同时清理同一批文件，后到者拿到 ENOENT 时直接忽略。
          this.fs.unlink(path.join(this.directory, name), { force: true });
        } catch (error) {
          this.report(error);
        }
      }
      // Map 迭代期间删除当前键是安全的，无需先复制键集合。
      for (const key of this.states.keys()) if (key.startsWith(`${date}:`)) this.states.delete(key);
      for (const key of this.sources.keys()) if (key.startsWith(`${date}:`)) this.sources.delete(key);
    }
  }

  /** 等待在途索引恢复完成后结束资源生命周期。 */
  public async close(): Promise<void> {
    await Promise.allSettled(this.repairs.values());
  }

  /** 日志自身故障使用独立出口，避免递归写日志。 */
  private report(error: unknown): void {
    process.stderr.write(`[log] ${String(error)}\n`);
  }
}

/** 进程启动时刻，用于识别重启后被复用的 PID。 */
function process_started_at_ms(): number {
  return Date.now() - process.uptime() * 1000;
}

/** 统一空页协议，由调用方填充状态与游标。 */
function empty_page(status: LogPage["status"]): LogPage {
  return { status, entries: [], before: null, after: null, has_more: false };
}

/** 解析单行 JSON 对象，损坏位置由调用方报告。 */
function read_object(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf-8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    // 外部损坏的日志行由调用方报告位置，不尝试猜测或修补正文。
    return null;
  }
}

/** 将磁盘正文收窄为当前契约，保留可序列化诊断。 */
function read_record(bytes: Buffer): LogFileRecord | null {
  const value = read_object(bytes);
  if (value === null) return null;
  const content = read_log_content(value.content);
  if (
    content === null ||
    typeof value.created_at !== "string" ||
    typeof value.source !== "string" ||
    value.level !== normalize_log_level(value.level)
  )
    return null;
  return {
    created_at: value.created_at,
    source: value.source,
    level: normalize_log_level(value.level),
    content,
    ...(value.window === false ? { window: false as const } : {}),
    ...(value.error === undefined
      ? {}
      : { error: normalize_log_error(value.error, "unknown_log_error") ?? undefined }),
    ...(typeof value.context === "object" && value.context !== null && !Array.isArray(value.context)
      ? { context: value.context as Record<string, unknown> }
      : {}),
  };
}

/** 校验进度及摘要位置，避免损坏索引指向错误范围。 */
function read_index(bytes: Buffer): IndexRecord | null {
  const value = read_object(bytes);
  if (
    value === null ||
    !is_offset(value.end) ||
    value.end === 0 ||
    !is_offset(value.line) ||
    value.line === 0
  )
    return null;
  if (value.entry === undefined) return { line: value.line, end: value.end };
  if (typeof value.entry !== "object" || value.entry === null) return null;
  const entry = value.entry as Record<string, unknown>;
  if (
    !is_offset(entry.offset) ||
    entry.offset >= value.end ||
    typeof entry.created_at !== "string" ||
    typeof entry.source !== "string" ||
    typeof entry.message_preview !== "string" ||
    !is_offset(entry.message_length) ||
    entry.level !== normalize_log_level(entry.level)
  )
    return null;
  return {
    line: value.line,
    end: value.end,
    entry: {
      offset: entry.offset,
      created_at: entry.created_at,
      source: entry.source,
      level: normalize_log_level(entry.level),
      message_preview: entry.message_preview,
      message_length: entry.message_length,
    },
  };
}

/** 字节位置与行数只接受非负安全整数。 */
function is_offset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** API 与内部调用共用参数约束，日期与实例永远不能变成任意文件路径。 */
function validate_request(request: LogPageRequest): void {
  if (
    !["latest", "before", "after", "check"].includes(request.direction) ||
    typeof request.date !== "string" ||
    !DATE_PATTERN.test(request.date) ||
    typeof request.instance !== "string" ||
    !INSTANCE_PATTERN.test(request.instance) ||
    (request.limit !== undefined &&
      (!is_offset(request.limit) || request.limit < 1 || request.limit > LOG_PAGE_SIZE)) ||
    (request.direction === "latest" ? request.cursor !== undefined : request.cursor === undefined)
  )
    throw new AppError("request.validation_failed");
  if (request.cursor !== undefined) {
    const cursor = request.cursor;
    if (
      cursor === null ||
      typeof cursor !== "object" ||
      typeof cursor.date !== "string" ||
      !DATE_PATTERN.test(cursor.date) ||
      typeof cursor.instance !== "string" ||
      !INSTANCE_PATTERN.test(cursor.instance) ||
      !is_offset(cursor.line) ||
      typeof cursor.revision !== "string" ||
      cursor.date !== request.date ||
      cursor.instance !== request.instance
    )
      throw new AppError("request.validation_failed");
  }
}
