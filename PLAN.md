# 计划：共享轻量派生索引（降 Agent 大工程常驻内存）

> 任务材料，非长期工程文档。设计意图见 [AGENT_RUNTIME](docs/AGENT_RUNTIME.md#常驻内存与瞬时峰值的边界)。
> 本文记录目标、已验证结论、分阶段改动清单与验收，随实施推进更新，完成后删除。

## 目标

让工程条目（本样本 917793 条）在内存中只保留一份主数据，各子系统不再各自展开一套全量对象索引，降低随条目数线性增长的后-end worker 常驻基线。收益随工程规模线性，普通规模工程应保留现有对象路径。

不做：不改 SQLite 表结构、不引入新运行时/语言、不动模型上下文压缩与时间线分页契约、不重写已证伪的 stage 0/1 / A1 方向。

## 已坐实的事实（本轮只读取证 + 分阶段埋点 + 原型）

- 常驻基线由「同一批 92 万条目被工程缓存、同步输入、校对运行态各建一套对象索引」主导；`src`/`dst` 正文是同一份不可变引用，正文只占约 85–102 MB，多的是对象头与派生字段。
- 冷启动首次 `query_warnings` 触发校对全量同步，是 +419 MB 瞬时分配与约 2m44s 等待的一次性成本，GC 后回落；增量同步路径已生效，不重复触发。
- 时间线只访问最新窗口，与工程条目缓存无关；压缩/分页/工具预览都不释放工程缓存。
- 换语言或引入 Arrow/SAB 等新技术对「N 个对象 × 多套表示」无本质收益；列式/共享派生索引是成熟已存方案（共享索引、按数据源组织索引、不可变快照 + 原子换索引、按窗口取数据）。

## 已完成的原型验证（表示层风险已排除）

| 验证 | 结果 |
|---|---|
| 全量 917793 行「列式 + materialize」与完整对象逐字段 `deepEqual` | mismatches 0 |
| 常驻堆（分进程） | 对象 396 MB → 列式 218 MB（−178 MB / −45%，枚举列再化可到约 149 MB） |
| 全量 materialize 扫描 | 21–56 ms，组装产物为临时值、不常驻 |
| 产品真实查询 17 组（列表/筛选/搜索/排序/窗口/警告/上下文/筛选面板），两种输入逐结果相等 | 2 万 / 10 万 / 30 万行均 PASS，mismatches 0 |
| 查询非平凡性 | 不同谓词命中数不同，非全部短路 |

原型脚本位于系统临时目录（`lg-ab-equivalence2.mjs`、`lg-ab-query.mjs`、`tmp/p1-equivalence.mts` 已删），不进仓库。

结论：按身份惰性组装行喂给既有纯逻辑，判定语义不变；产品改造的回归重点在增量写入、修订一致性与字段访问路径，而非重写筛选/判定。

## 分阶段改动（每阶段独立验证、可回滚）

### P0 — 主数据单一来源
- `ItemCache` 改列式：`item_id` / `row_number` 用 `Uint32Array`，status / file_idx / outcome 用 `Uint8Array`，`src` / `dst` / `name` / `file_path` / `extra_field` / `tag` 各一份数组；`item_id → 行号` O(1) 索引；`read_item(index)` 惰性组装公开记录。
- 保留 `readItems()` 契约给现有消费者并标注 O(N)；`replace` / `applyChange` 改为更新列与索引。
- 按工程规模分流：小工程保留现有对象路径，避免列式复杂度伤及常见场景。
- 验收：`item-cache.test.ts`、`cache-manager.test.ts`；新增「新旧 `readItems()` 逐条相等 + 按 id 随机读相等」对照测试；`typecheck` / `lint` / `check`。

### P1 — 校对 state 轻量化（最大收益，依赖 P0）
- `ProofreadingReaderState.item_by_id` 改为「`item_id → 轻量派生记录`（status、warning 码、outcome、排序键、row_number、internal_file_path）」；`src` / `dst` / `name` / `file_path` 不再存。
- `natural_row_ids` 用 `Uint32Array` 行索引；`resolve_proofreading_rows` / `read_row` / `build_window_rows` / `create_proofreading_client_item` / `read_context_items` 等改为按身份取正文（复用已验证的 materialize 接缝，判定逻辑不动）。
- 验收：`proofreading-reader.test.ts` 全量；筛选 / 搜索 / 排序 / 窗口 / 上下文 / 警告摘要 / 筛选面板逐项等价；新增「列式 state 与对象 state 跑同一查询逐结果相等」行为测试。

### P2 — 一致性与免深拷贝（P1 硬约束）
- 派生索引绑定已提交修订快照；工程写入走新索引 + 原子切换，旧索引在在途查询结束后回收；沿用 `read_freshness` / `stale_proofreading_sync` 语义，防止派生事实读到混合世代正文。
- `build_sync_input` 按列 / 分批构建，`ComputeWorkerClient` 用 Transferable `ArrayBuffer` 免 `structuredClone` 深拷贝（顺带削冷启动瞬时尖峰与等待）。
- 验收：修订漂移 / 中途失败 / 迟到结果 / 取消的补偿测试；真机分阶段埋点复测 `query_warnings` 段增量。

### P3 — 其余消费者迁移
- `project-summary` / `batch-translation-project-store` / `quality-rule-statistics` 去掉各自 `readItems()` / `structuredClone` 全量副本，改按窗口 / 流式读主数据。

### P4 — 真机验收
- 同一份 494 MB / 92 万条 `.lg`，分角色采样（MAIN / 脚本子进程），对比加载 idle 与 `workspace_run` 期间内存；受影响测试与静态检查全过；真实 `.lg` 走查翻页、详情、修订、分叉、计数。

## 边界与风险

- 涉及 `cache/`、`shared/proofreading/`、`backend/worker/`、`project/`、`batch-translation/` 多模块；`row.item.src` 读取点十余处。
- 列式前提是消费方按列 / 按身份访问；逐行 Proxy facade 会抵消收益（已存方案反例）。
- 一致性是硬约束：不可变快照 + 原子换索引。
- 兼容旧 `.lg`：不改存储表结构。
- 原型未覆盖：增量写入 / 原子换索引 / 跨 worker 传输 / PDF 页面行 —— 这些是 P2 与 P1 集成测试重点。

## 当前状态

- 分支 `feat/agent-proofreading-auto-resume`；docs 与 PLAN 结论已推送 fork。
- 保留成果（未接运行时，零风险）：`ItemColumnStore` 独立组件（`23a415ec`）与对照测试、`from_records` 按身份去重修复（`f0c6b7c2`）、增量等价原型结论、双表示等价的产品级验证方法。
- **P0 双表示接入已回滚**（`3c6b5ce7` → `df1c3c7c`）：`ItemCache` 回到纯对象 Map，双表示与 parity 测试移除。
- **真机收益实测（P0 列式版）**：列式路径确认生效（917793 行 ≥ 阈值），但 idle MAIN 588 vs 595 MB（噪声内）、ws_run 峰值 3115 vs 2751/3033 MB（持平）。P0 对常驻与峰值均无可见收益。
- **P0′ 前提已证伪**：装入期 `get_all_items` 的 92 万 `{id,data}` 行 + parse 对象是**瞬时、可完全 GC**（显式 GC 后 heap 917→292 MB），流式化只能削加载尖峰、降不了 idle 稳态。
- **分阶段埋点闭环（22:01 诊断构建，验完已删）**：校对 sync 链路 rss 轨迹 —— `before_build_input` 727 → `after_build_input(upsert=917793)` 874（+147）→ `after_postMessage` 1089（+215）→ `worker:after_evaluate` **2800（评估 66 秒，rss +1665、compute-worker isolate heap 仅 +88）** → `worker_returned` 3051 → `after_sync_state` 1856（GC 回落）。各线程 isolate 的 heap 增长远小于进程 rss 增长。
- **compute worker 执行模式已核实**：生产 GUI 的 Backend runtime（`backend-runtime.ts:141`）注入 `worker_threads`，`ComputeWorkerClient` 构造时 `new Worker` —— compute worker 是**独立 worker_thread**，不是 in_process。埋点里 `pid` 全相同只是因为 `worker_threads` 共享 OS 进程 pid；之前据 pid 判断 in_process 是误判，已修正。`worker_threads` 与后端线程共享进程地址空间，故 rss 是整进程口径。
- **分片方案已证伪**（独立原型，用产品真实 `evaluateProofreadingItem`）：2 万 / 30 万行、片大小 5000 / 20000 / 50000，逐条 `deepEqual` 全 PASS（语义等价成立，须共享 `sample_rule_cache`）；但即使片间 `setImmediate` + 显式 GC，分片 rss 峰值仍**高于**一次性版（+39~41 MB）—— `evaluations` 结果数组必须全量累积，让出与 GC 只增开销。独立原型 30 万行峰值仅 ~370 MB，远小于产品 2800 MB，反证产品的 +2GB 不是单靠评估函数、而是**跨线程全量拷贝 + 大对象空间 + 延迟 GC 的多份数据叠加**。
- **主因收敛**：峰值大头在**跨线程 structuredClone 的原生序列化缓冲、V8 大对象/外部内存、延迟 GC 的未回收页**，而非任一 isolate 的 JS 对象数组。这解释了为何工具正文 / 列式 / 装入流式化 / 评估分片全部打不中。
- **跨线程零拷贝方案已证伪**（独立原型，真实数据双向 postMessage）：20 万行 A 现状 348 MB / B Transferable 478–548 MB / C SAB 593 MB；92 万全量 A **1051 MB** / B **1613 MB（+562）**。原因：零拷贝需 `JSON.stringify` 打包 + `JSON.parse` 解包，两步都在 JS 堆造大对象，比 V8 原生 C++ 层 `structuredClone` 更费；SAB 还额外常驻共享缓冲。**原生 `structuredClone` 已是该链路最省传输方式。**
- **全局收口**：七次方向（stage0/1、A1、P0 列式、装入流式、评估分片、跨线程零拷贝）全部被真机/原型证伪。共同模式是「都在优化 JS 对象/数据表示，而 2GB 大头是运行时内存管理行为（大对象空间 / 延迟 GC）」。在不改 V8 运行时策略或不做架构级改造（评估移出进程、或磁盘/流式管线）的前提下，**没有低风险的显著降内存空间**。
- 安装目录当前为与 HEAD 一致的干净构建，应用正常 idle；工作区干净。

## 下一步（收口）

1. **不建议继续按「改某个模块的数据表示」找下去** —— 已七次证伪。
2. 若仍要解决，只剩两类**架构级**选项，均需重新评估投入产出：
   - 减少单次同步的**输入规模**：按修订增量同步已存在，但冷启动/失效时仍全量；可探索「校对评估按文件/分片增量建立索引、不强求一次建全量 state」，代价是校对功能的查询语义与一致性重写。
   - 改变**运行时内存管理**：GC 参数、`--max-old-space-size`、评估产物复用，属调优而非结构修复，收益不确定。
3. 常驻基线（另一目标）：`ItemColumnStore` 组件已备但未接、实测零收益；仅在「确实想降几十~百 MB 常驻」且有超大工程场景时再启用。
4. 本调查的产物（docs 设计意图 + 原型方法 + 全部证伪证据）已固化；建议**暂停内存专项**，需要时以「架构级重设计」重新立项，而非继续局部优化。
