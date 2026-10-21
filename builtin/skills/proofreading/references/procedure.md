# 逐条校对流程

本流程用于逐条结合上下文校对工程内已有译文，直到范围内最后一条。

- 术语见 `SKILL.md`。
- 译文质量按 `writing-guide` 的 `references/translation.md` 判断。
- 警告含义按 `translation` 技能的 `references/item-review.md` 的「警告速查」核对。
- 格式专属检查点按已加载的格式技能执行。

## 读取工程事实

用一次 `workspace_run` 读取条目、警告与工程元数据：

```js
import { readFile } from 'node:fs/promises';
const entries = (await readFile(ws.contract.datasets.items.path, 'utf8'))
  .split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
const warnings = (await readFile(ws.contract.datasets.warnings.path, 'utf8'))
  .split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
const meta = JSON.parse(await readFile(ws.contract.datasets.project_meta.path, 'utf8'));
```

`items/entries.jsonl` 是完整条目集合，`items/warnings.jsonl` 只包含命中警告的条目。警告只是证据，没有警告不等于译文正确，范围内每条仍需结论。

## 范围

默认范围是全部需要人工校对的条目：

- `src` 非空
- `dst` 或 `name_dst` 至少一个非空
- 状态不是 `EXCLUDED`、`DUPLICATED`、`RULE_SKIPPED`、`LANGUAGE_SKIPPED`

用户指定文件、条目或起止条目时按用户范围收窄，并把收窄条件写入进度文件。范围一经确定不再变动，中途发现范围不合理时先向用户说明再重新开始。

## 进度文件

进度文件是唯一的续跑依据，保存在 `work/proofreading-TASK.json`，审校记录保存在 `work/proofreading-TASK.jsonl`。两个文件在每个单元处理后立即写入，不跨轮补写。

```js
import { readFile, writeFile } from 'node:fs/promises';
const { buildReviewPlan, createReviewProgress } = await import(new URL('scripts/review-progress.mjs', base_url).href);
const plan = buildReviewPlan(entries, meta, warnings, { file_paths: [], item_ids: [] });
const progress = createReviewProgress(plan, 'proofreading-20261020');
await writeFile('work/proofreading-20261020.json', JSON.stringify(progress));
```

进度文件保存 `version`、`task`、`scope`、`scope_item_ids`、`scope_count`、`visited_item_ids`、`unresolved`、`attempts`、`in_progress`、`completed_units` 和 `updated_at`。已存在的进度文件优先于重新计算的范围，保证续跑位置稳定。

## 单元

单元是一次处理的一批条目，同一文件内连续排列，最多 50 条且序列化后不超过约 32 KiB。

```js
const { nextReviewUnit } = await import(new URL('scripts/review-progress.mjs', base_url).href);
const progress = JSON.parse(await readFile('work/proofreading-20261020.json', 'utf8'));
const unit = nextReviewUnit(progress, entries, meta, warnings, { max_items: 50 });
if (unit.status === 'complete') { /* 覆盖完成，进入交付 */ }
if (unit.status === 'needs_abandon') { /* 记为未决后继续 */ }
```

- `unit` 包含条目本身、同文件前后各三条非空原文的邻近语境、关联警告与每条的尝试次数。
- 单元不跨文件。需要跨文件取证时读取对应条目的邻近语境，不用扩大单元。
- 单条正文或译文过长时按字段切片读取，不截断原文或译文：

```js
const { readItemFieldSlice } = await import(new URL('scripts/review-progress.mjs', base_url).href);
const slice = readItemFieldSlice(entries, item_id, 'dst', 0, 4096);
```

## 判断

对单元内每条给出唯一结论：

- `keep`：译文成立，无需修改
- `change`：译文需要修改，提交修改后的 `dst` 或 `name_dst`
- `unresolved`：缺少决定性事实，本次不修改

判断依据：

- 邻近语境确认指代、身份、称谓与前后衔接
- 关联警告确认漏翻、残留、标点、换行、术语与保护文本
- 术语表核对固定译名与适用条件
- 格式技能的检查点确认结构、占位符与格式约束

证据不足时记为 `unresolved`，不猜测改写。不补译空目标，不改动 `src` 与 `extra_field`。

## 写入

需要修改时把变更写入 `changes/items/updates.jsonl`，每行一条记录：

```js
import { writeFile } from 'node:fs/promises';
const updates = changed.map(entry => ({ item_id: entry.item_id, fp: entry.fp, dst: entry.dst }));
await writeFile(ws.contract.changes.items.updates.path, updates.map(line => JSON.stringify(line)).join('\n') + '\n');
```

`fp` 取自当前快照的条目记录。省略的字段保持当前值，`name_dst` 与 `dst` 分开提交。写完后调用 `workspace_apply`，审批由工具按当前模式处理。

## 回执

按回执核对实际结果：

- `applied` 或 `unchanged`：对应条目的结论记为 `change` 且 `applied` 为 `true`
- `partial` 或 `rejected`：只重做被拒条目，最多 2 次；仍被拒的条目记为 `unresolved`
- `data.committed_sync_failed`：数据已提交但同步失败，不要重复提交。重新运行脚本读取最新快照核对当前 `dst` 与 `name_dst`：已生效记为 `change`，未生效记为 `unresolved`

## 记录

把本单元的结论追加到 `work/proofreading-TASK.jsonl`，每行一条记录：

```jsonc
{ "item_id": 12, "verdict": "change", "reason": "术语译名与术语表不一致", "missing": "", "applied": true }
```

然后合并进度：

```js
const { mergeReviewRecords } = await import(new URL('scripts/review-progress.mjs', base_url).href);
const merged = mergeReviewRecords(progress, records);
await writeFile('work/proofreading-20261020.json', JSON.stringify(merged.progress));
await writeFile('work/proofreading-20261020.jsonl', records.map(line => JSON.stringify(line)).join('\n') + '\n');
```

`rejected` 中的记录不计入覆盖，必须重做对应条目。`missing_item_ids` 是本单元仍缺结论的条目，`pending_item_ids` 是尚未发出的条目。

## 循环

重复执行单元处理，直到 `summarizeReviewProgress` 的 `remaining_count` 为 `0` 且 `incomplete_item_ids` 为空：

```js
const { summarizeReviewProgress } = await import(new URL('scripts/review-progress.mjs', base_url).href);
const summary = summarizeReviewProgress(progress);
```

- 尚有条目未处理时继续取下一单元，不询问用户是否继续
- `needs_abandon` 表示某条已尝试 2 次仍无结论，把它记为 `unresolved` 后继续：

```js
const { abandonInProgress } = await import(new URL('scripts/review-progress.mjs', base_url).href);
const progress = abandonInProgress(current, '两次尝试后仍缺少决定性事实');
```

- 轮次因可重试的模型或传输错误中断时，恢复后的第一件事是重新读取进度文件，优先处理 `in_progress` 中的条目
- 轮次因不可重试的错误失败时停止，报告进度文件路径、剩余条目数和未决条目，不得声称已完成

## 完成

覆盖完成后提供进度文件与审校记录链接，并说明：

- 范围内条目数量、已给出结论的数量与未决数量
- 修改条目数量，以及每类修改的主要依据
- 未决条目列表，包含 `item_id`、原因和缺失的事实
- 实际写入结果，区分已写入、写入失败和未修改

## 失败恢复

- 脚本超时：把 `max_items` 与 `max_bytes` 减半后重试。`in_progress` 保证已发出的单元不会丢失
- 写入部分成功：只重做被拒条目，已成功的条目不再重复修改
- 工程在校对期间被外部修改：重新读取快照后按最新 `fp` 提交，不沿用旧指纹
