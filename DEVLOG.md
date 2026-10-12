# 开发日志

本文件按时间倒序记录 DSH 插件化 Agent「推理 + 训练双闭环」计划的落地进度，供内部同步使用。设计决策、取舍理由与验收证据以 `.agents/notes/` 下的 Agent Note 为准，本文件只做进度与结论汇总。

## 阶段总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| 一 | 能力固化与标准化（事件溯源、推理态奖励标准化、多模型角色路由） | 进行中：推理态奖励标准化已交付；多模型角色路由未开始 |
| 二 | 数据采样闭环（批量 Rollout、轨迹清洗、数据集导出） | 未开始 |
| 三 | 训练闭环适配（PRM、GRPO/RLVR、奖励劫持防护） | 未开始 |
| 四 | 运维观测与能力固化 | 未开始（观测底座已有部分现成能力） |

## 2026-10-12 · 阶段一：verifiable-reward 机械打分落地

**目标**：让一次运行的可观察事实（执行的命令、退出码、测试通过/失败数）变成可回放、可筛选的持久分数，为后续采样与训练提供不依赖模型判断的奖励信号。

**交付**：新插件包 `@vreal/dsh-verifiable-reward`（`packages/reward/verifiable-reward/`），单实例挂在 base bundle 上，对经 `ctx.tools` 分发的 shell 调用做确定性打分，每次匹配到的调用追加一个可忽略的 `reward/check` 会话事件。

**关键设计**：

- 观测点选 `tools/result`（只观察阶段）而非 `tools/post-execute`：后者可以替换或阻断结果，且监听器抛错会变成调用失败，纯审计的打分器不应拥有让调用失败的能力；`tools/result` 在结果定型后运行，抛错被注册表隔离为警告。
- 打分是命令字符串与规范工具结果的纯函数：按顺序首次匹配的命令检查、退出码、沙箱拒绝、测试计数提取、罚分模式，结果夹到 `[0, 1]`；`test` 检查在 stdout 未截断且未落盘时用 `passed / (passed + failed)` 替换退出码基线。
- 事件只携带结构化事实（调用标识、工具、命令、匹配到的检查、退出码、计数、罚分命中、得分、流可用性标记），不携带输出文本；以 `ignorable: true` 追加，没有任何 fold 消费它，丢失它不改变会话重建。
- 配置校验由 `Config` schema 在加载时完成（空工具名、未知种类、负权重、未知作用域在此失败）；编译器只补充 schema 无法表达的部分——模式源为空或无法编译——计数覆盖模式以 `g` 编译以适配 `matchAll`，命令模式保持非全局以避免 `lastIndex` 状态。
- 内置检查把测试运行器排在构建命令之前（`make test` 不会被算作构建）；内置罚分模式覆盖对根目录或 home 的破坏性递归删除、强制推送、远端内容直接管道进 shell。

**接线**：`packages/bundle/base/cordis.patch.yml` 新增一行（host 平面，与 `repeat-tool-reminder` 同类，一份实例覆盖 TUI/headless/web），并登记到 `packages/bundle/base/package.json` 与部署清单 `python/sdk-runtime/package.json`；`tsconfig.host.json`、`tsconfig.base.json`、`pnpm-lock.yaml` 同步更新。

**文档与记录**：包 README、组 `packages/reward/` README、`packages/README.md` 表行、Agent Note 均为中英双语并重录配对哈希；再生成 `docs/module-graph.md`、`docs/config-catalog.md`、`docs/persistence-catalog.md`（含 `KNOWN_SESSION_EVENT_TYPES`）与文档图（`apps/cli/composition.md`、`docs/event-producer-consumer.md`），中文侧同步镜像。

**验证**（实际执行）：

- `pnpm exec vitest run packages/reward/verifiable-reward`：53 项通过（含真实 agent loop 集成用例：事件落日志、且不进入模型请求）。
- 该包源码覆盖率 100%（statements / branches / functions / lines，逐文件门禁）。
- `pnpm run build` 全量构建通过；`knip`、包级 `oxlint`、`publint` 通过。
- 通过的门禁：module-graph、config-catalog、persistence-catalog、doc-graphs、package-readme-model-experience、package-readme-limitations、export-jsdoc、agent-note-classification、agent-note-format、doc-budgets、md-wrap、md-links、package-paths、cordis-config、runtime-closure、package-invariants、package-licenses；`packages/bundle` 与 `apps/cli` 单元测试通过。

**仓库既有红灯（与本次改动无关，未处理）**：`verify-translation-pairing` 与 `verify-archived-agent-notes` 的语料整体陈旧（例如 HEAD 未改动的 `.agents/notes/implemented/architecture/2026-06-20-branded-ids.md` 其记录哈希已不符，规模约 450 对）；`verify-node-next-types` 与 doc-site 符号链接用例在本机因无法创建目录符号链接（EPERM）失败；`rescope-vendor:check` 有两条已漂移的 vendor 编辑记录。本次新增与改动的文档对全部通过配对校验。

**遗留与下一步**：

- 聚合辅助函数（`computeRoundScore`、`computeFinalScore`、`combineScores`）目前没有调用方；下一步做阶段二的轨迹清洗与数据集导出插件，由它消费 `reward/check` 与 `goal/evaluation` 两个审计事件。
- 批量 Rollout 计划复用现成底座：`dsh-headless` 一次性 profile（已完成不自动续跑 goal）+ `dsh-sdk` JSON-RPC server + `jobs` 并发控制，不新造进程管理。
- 训练侧（PRM / GRPO / RLVR 训练本体与模型回灌）不进 `packages/`：那里有逐文件 100% 覆盖率、publint、module graph 等门禁，且并非 agent runtime 插件；只通过导出的数据集与 DSH 解耦。
- 未验证的轴：web/GUI e2e（需要浏览器与构建产物）。示例快照轴不受影响——`examples/*` 叶子显式列插件，不加载 base bundle patch。
- 打分仅做文本模式匹配：通过脚本、别名或门禁包装器运行且不匹配任何已配置模式的调用不会被打分；需要更精确的语义时再扩检查表或引入显式标记。
