# 开发日志

本文件按时间倒序记录 DSH 插件化 Agent「推理 + 训练双闭环」计划的落地进度，供内部同步使用。设计决策、取舍理由与验收证据以 `.agents/notes/` 下的 Agent Note 为准，本文件只做进度与结论汇总。

## 阶段总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| 一 | 能力固化与标准化（事件溯源、推理态奖励标准化、多模型角色路由） | 进行中：推理态奖励标准化已交付；多模型角色路由未开始 |
| 二 | 数据采样闭环（批量 Rollout、轨迹清洗、数据集导出） | 未开始 |
| 三 | 训练闭环适配（PRM、GRPO/RLVR、奖励劫持防护） | 未开始 |
| 四 | 运维观测与能力固化 | 未开始（观测底座已有部分现成能力） |

## 2026-10-12 · CI 契约按「下游产品仓库」重写

**目标**：让这个仓库的 CI 红灯重新变成有意义的信号。原状是照搬上游的组织级矩阵——付费 runner 标签、`DSH_CI_FAILOVER_*` 仓库变量、自托管待命作业、依赖上游 org Project 的 Issue 工作流——在本仓库里这些要么排不到机器（静默 24 小时超时），要么必然失败，于是红灯被长期忽略。

**变更**：

- `ci.yml`：`node 24 / static`、`node 24 / coverage`、`node 24 / snapshots and artifacts`、`windows-native` 与 `all-checks-passed` 全部改到标准托管 runner（前四项 `ubuntu-latest`，Windows 原生车道 `windows-latest`）；删除故障切换变量、自托管专属步骤与企业级并发覆盖，改由各门禁脚本按标准 runner 自适应默认值。
- `ci-master.yml`：重写为 `push(main)` + `workflow_dispatch`，只保留两件事——为 PR 的 Wine 车道播种 apt 缓存的 `wine-apt-cache`，以及验证合并结果的 `post-merge`（install → build → 单测 → 静态门禁）。上游的自托管串行待命作业与大 runner 基准测试全部移除。
- `e2e.yml`、`release.yml`：改为仅手动触发。前者需要本仓库不持有的 `DEEPSEEK_API_KEY`，后者需要尚未接通的发布工具链；保留为可手动运行的工具，不再参与 PR 判定。
- 删除 `.github/workflows/issue-policy.yml` 与 `.github/workflows/issue-lifecycle.yml`：它们为上游组织的 Project 看板铸造 App token，本仓库没有该看板。`.github/issue-management/` 的 policy 库与其测试保留（静态门禁仍执行 `test:issue-management`），将来建立 fork 自有看板时可以在此基础上重建一层薄工作流。
- 修复 `scripts/prepare-ci-bubblewrap.sh` 的失效固定版本：`bubblewrap 0.9.0-1ubuntu0.1` 已从 archive 下架导致 e2e 在 setup 阶段 404，改为 `0.9.0-1ubuntu0.3` 并更新 sha256（新哈希为本地下载实算）。
- 站点构建改为先清理自身产物：新增 `scripts/clean-doc-site.ts`（含测试），`docs:build` / `docs:build:mpa` 先执行它。原因是投影的覆盖保护会把上一次构建留下的 `website/.dist` 当作他人产物，导致第二次构建必然失败——修复后连续两次构建均通过。
- 让 PR 车道热启动：`ci-master.yml` 的 `post-merge` 现在是默认分支上的缓存写入者——恢复并保存 pnpm store 与 Playwright 浏览器缓存（键与 PR 车道读取的完全一致），并只下载浏览器二进制（apt 依赖仍按次安装）。此前 `ci.yml` 的各车道只做 restore，没有任何保存者，PR 每次都是冷装冷下。

**契约锁定**：`scripts/ci-workflow.spec.ts` 现在钉住下游契约本身——两个工作流的每个作业都运行在标准托管 runner、文件中不出现 `DSH_CI_FAILOVER`、不出现 `self-hosted`、`e2e`/`release` 仅手动触发、两个 org-Project 工作流不存在而 policy 库存在；`.github/AGENTS.md` 同步改写为该契约的常驻说明。这样"回到上游矩阵"或"悄悄重加自托管车道"都会在本地测试里失败。

**验证**：`scripts/ci-workflow.spec.ts` 17 项通过（含新清理脚本的用例；并已加载 ci.yml / ci-master.yml / e2e.yml / release.yml 做结构断言，等价于 YAML 解析校验）；`pnpm run docs:build:mpa` 连续两次均通过（修复前第二次必失败）；`knip` 通过；`test:issue-management` 通过；`verify-md-links`、`verify-md-wrap` 与本次改动双语 Note 的配对校验通过。本地 `check:ci:static` 为 34 通过 / 3 失败，三项失败全部是既有或环境性的，与本改动无关：

- `translation pairing` 与 `archived agent notes`：语料整体陈旧（此前已记录，约 450 对）。
- `documentation site checks`：其符号链接用例需要目录符号链接权限，本机为 EPERM。

**仍未做 / 风险**：

- 这些车道需要在本仓库 GitHub Actions 上真跑一次才能确认标准 runner 的资源是否足够（尤其 `windows-native` 的 `check:ci:windows-complete`，已保留 120 分钟超时；覆盖率车道的分区与 worker 数在标准 runner 上是否够快也需实测）。
- 上游的 `2026-07-26-ci-failover-runbook` 是一份仍在 `implemented/` 的 Agent Note，描述的正是本次移出的故障切换机制；退役它需要走归档三件套与封印哈希流程，作为后续独立改动。
- 本仓库没有分支保护（私有 + 免费计划），所以"必需检查"仍无法真正启用；契约靠 `all-checks-passed` 聚合门与本地测试维持，而不是靠 GitHub 强制。

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
