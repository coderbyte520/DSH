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
- `windows-native` 从 PR 车道移到新的 `ci-nightly.yml`（nightly 定时 + 手动触发，`windows-latest`）。理由是它一次 36.5 分钟、按 Windows 2 倍计费，而失败类目与 Linux 完全相同；PR 上保留 `windows node 24 / wine blocking`（5m27s）作为阻塞面，Windows 专属回归最迟一天内可见。契约测试同步钉住"PR 工作流不再定义 windows-native、nightly 工作流定义它"。
- 消重：`sdk/server/src/server.ts` 的 `createSession` 抽出一个本地 `create()`（原先同一文件内重复三遍 `agents.create`）；`tool-ralph-evaluated` 的刻意克隆与 goal-evaluator 复用的 verdict 解码词表改为带理由的 `jscpd:ignore` 区块。`pnpm run duplication` 从 8 处克隆降到 **0**。
- 覆盖率缺口补齐：修好 `sdk/server` 那个被过宽 `ctx.get` mock 弄坏的用例，并新增 resume 三条路径的用例（100%）；为 `ui-subagent` 增加"菜单随视口/滚动重定位"用例；为 `tool-goal` 增加"peek 在无权威时不抛错"用例。三个包本地均为每文件 100%。

**契约锁定**：`scripts/ci-workflow.spec.ts` 现在钉住下游契约本身——两个工作流的每个作业都运行在标准托管 runner、文件中不出现 `DSH_CI_FAILOVER`、不出现 `self-hosted`、`e2e`/`release` 仅手动触发、两个 org-Project 工作流不存在而 policy 库存在；`.github/AGENTS.md` 同步改写为该契约的常驻说明。这样"回到上游矩阵"或"悄悄重加自托管车道"都会在本地测试里失败。

**验证**：`scripts/ci-workflow.spec.ts` 17 项通过（含新清理脚本的用例；并已加载 ci.yml / ci-master.yml / e2e.yml / release.yml 做结构断言，等价于 YAML 解析校验）；`pnpm run docs:build:mpa` 连续两次均通过（修复前第二次必失败）；`knip` 通过；`test:issue-management` 通过；`verify-md-links`、`verify-md-wrap` 与本次改动双语 Note 的配对校验通过。本地 `check:ci:static` 为 34 通过 / 3 失败，三项失败全部是既有或环境性的，与本改动无关：

- `translation pairing` 与 `archived agent notes`：语料整体陈旧（此前已记录，约 450 对）。
- `documentation site checks`：其符号链接用例需要目录符号链接权限，本机为 EPERM。

**首轮实测定（PR #20，标准托管 runner，整轮墙钟 07:04:50Z → 07:42:29Z ≈ 37.6 分钟）**：

| 车道 | 用时 | 结果 |
|---|---|---|
| `node 24 / static` | 5m03s | 35 通过 / 2 失败：`translation pairing`、`archived agent notes` |
| `node 24 / snapshots and artifacts` | 8m06s | 7 通过 / 3 失败：`lint and duplication`、`test:snapshot`、`web browser snapshot` |
| `node 24 / coverage` | 17m28s | 0 通过 / 2 失败：per-file 100% 未达（`packages/sdk/server/src/server.ts`、`packages/client/ui-subagent/src/client/SubagentHeaderLineage.tsx`） |
| `node 22.19` | 3m51s | 通过 |
| `node 26` | 49s | 通过 |
| `windows node 24 / wine blocking` | 5m27s | 通过 |
| `python 3.10 / keyless SDK` | 20s | 通过 |
| `python runtime`（三条） | 8s / 15s / 6m07s | 通过 |
| `windows node 24 / native complete` | 36m33s | 5 个门禁失败：`test:coverage`、`test:coverage-exempt-heavy`、`translation pairing`、`archived agent notes`、`duplication` |
| `all checks passed` | 3s | 失败（聚合门，符合设计） |

结论一：**标准 runner 容量足够**。最长 Linux 车道 17.5 分钟、Windows 原生 36.5 分钟、整轮约 38 分钟；没有排队超时、没有 OOM、没有缺失环境或密钥，四个原本"永远排不到机器"的车道全部真正跑完。契约本身可用，不需要上游的企业池。

结论二：**所有失败都是既有债务，只是以前车道从未运行所以看不见**。三类：语料级门禁（rebrand 改写 3624 个文件但没有重录约 450 对配对哈希与归档封印）；`duplication` / `lint and duplication` 与快照漂移（`test:snapshot` 的 pwsh header 与会话日志、`web browser snapshot` 的 image-display 用例）；覆盖率 per-file 门槛（`sdk/server/src/server.ts` 来自本仓库自己的 "sdk server: resume persisted sessions" 提交，另一处是 UI 文件）。

结论三：**本次改动在 CI 上自证**。`documentation build` 通过（A1 的清理修复生效，243s），`documentation site checks` 在 Linux 通过（符号链接用例本就依赖该权限）；失败快照日志中不出现 `reward/check`，即 reward 插件没有改变这些快照。

结论四：`windows-native` 是最贵的一条（36.5 分钟 × Windows 2 倍计费），但它跑完了，失败原因与 Linux 完全同类——是否降级只取决于成本与噪音，不取决于时长。

**第二轮实测（提交 8fe23f3，四项收尾之后）**：

| 车道 | 结果 |
|---|---|
| `node 24 / static` | **转绿**：语料配对 1011 对、归档封印 429 件、配置目录全部通过 |
| `node 22.19`、`node 26`、`python 3.10`、python runtime 三条、`windows node 24 / wine blocking` | 绿 |
| `node 24 / coverage` | 每文件阈值缺口**已消失**（日志中不再有 `Uncovered locations`／`ERROR: Coverage`），但整体仍红在一个既有超时簇上：`test:coverage-exempt-heavy`（`--maxWorkers=2`）里 `scripts/oxlint-contract.spec.ts` 与 `scripts/translation-pairing-merge.spec.ts` 共 8 个用例撞上 5 秒默认超时——这两个文件本地 36 项全过，属小 runner 负载问题，与本次改动无关 |
| `node 24 / snapshots and artifacts` | 只剩快照漂移两项：`test:snapshot`、`web browser snapshot` |

静态车道与覆盖率阈值这两类既有债务已经清掉；PR 车道上剩下的红只有"快照内容漂移"与"重型脚本用例在标准 runner 上超时"两处，且都已定位到具体用例。

**快照漂移的诊断（手动诊断作业 `ci-snapshot-diagnose.yml`）**：第一次运行的 refresh 不可信——诊断没有准备 bubblewrap，示例拒绝 workspace-write，重录出的是"no sandbox backend is usable"的错误状态。对齐真实车道的准备步骤（`DSH_EXAMPLE_MODE=lib` + `prepare-ci-bubblewrap.sh`）后重跑，diff 从 23 个文件缩到 20 个，web 的 code-mode／round-trip／turn-tail 三项消失（说明它们本来就是被污染出来的）。可信 diff 的归类：

- **正当重录类**：`job_*` 工具描述里的产品措辞从 "task" 改成了 "job"（"forwarded to the task" → "to the job" 等），会经由 `request/header` 的 toolSchemas 传播进多条 `session.jsonl`。源码变了、钉住的期望没跟上，属于该重录的陈旧快照。
- **需要判断类（不要盲录）**：① `pwsh-tool-turn/tool-schemas.expected.json` 在 Linux 上少掉整个 `pwsh` 工具条目（平台/组合差异，需决定是让 fixture 平台无关还是给期望加平台条件）；② web `steer-all/mid-steer` 录到的是"Ask question waiting / Running"的进行中态，而钉住的是已结算的输入栏（捕获时机或结算谓词问题）；③ `agent-instructions/session.jsonl` 的注入内容不同（fixture 物化差异）。
- **纯噪声**：多次 session 日志 diff 只是新生成的 UUID（refresh 写原始 id、比较时归一化），不属于行为变化。

**覆盖率车道现在剩下的**：不是覆盖率——`test:coverage-exempt-heavy`（`--maxWorkers=2`）里 pwsh 相关用例卡在**产品内部的 20 秒命令超时**（"Your command timed out after 20 seconds"），另有重型脚本用例撞 30/60 秒超时。已把 vitest 超时提到 30 秒，但内部 20 秒那道需要单独查（标准 Linux runner 上 pwsh 会话为何挂起）。

**pwsh 20 秒之谜的根因定位**：拉取最新失败跑（38229243336，node 24 / coverage）的**断言正文**（顶层摘要看不到）后，三条 pwsh 失败指向同一个根因域——真实 pwsh over PTY 的流协议在 Linux 上的行为差异，既不是"会话启动慢"，也不是"沙箱不可用"：

- `tool-pwsh-persistent/loader-composition.spec.ts` 的 "preserves cwd and environment across calls"：实际收到的是产品内部的 `Your command timed out after 20 seconds`。命令已提交、已回显、提示符也已返回，但 `__DSH_PERSISTENT_PWSH_END_<nonce>:` 完成标记从未被检测到；部分输出混有 PSReadLine 重绘转义序列与 `^C`。
- 同文件 "pins UTF-8 output encoding"：编码钉死用例在同一 runner 上失败，与标记损坏互相印证（编码层）。
- `terminal-bash/tests/local.spec.ts:299`：不是超时——等待原因返回 `inferred_idle` 而期望 `stdin_read`，即 PTY 空闲推断启发式把 Linux pwsh 的提示符误分类。

根因域收窄到 `packages/shell/tool-pwsh-persistent/src/index.ts` 的标记扫描（约 L111–160，"一页足以找到刚发出的完成标记"的假设在 Linux 流式分块下可能失效）与 `packages/terminal/terminal-bash` 的空闲推断。因盲改标记扫描风险高，结论是**先诊断后修**：新增手动诊断工作流 `ci-pwsh-diagnose.yml`（沿用 `ci-snapshot-diagnose.yml` 的形状），在 `ubuntu-latest` 上只跑 `packages/shell/tool-pwsh-persistent` 与 `packages/terminal/terminal-bash` 两个套件（`--maxWorkers=2`，verbose），并把**真实 pwsh over PTY 的原始字节**（Python `pty` 探针，含 marker 是否逐字返回、提示符重绘转义落在哪里）连同完整套件日志一起上传为 artifact——这是覆盖率车道截断掉的断言正文所替代不了的证据。该工作流不属于 `all-checks-passed`，落到 `main` 前靠"只监听自身文件"的 push 触发器从特性分支发起。已被排除的假设：持久会话提交的 wrapper 单行只有约 400 字节，不会撞 Linux PTY 规范模式的 4096 字节行上限。

**同一批拿到的机械问题与杂项**：

- `scripts/merge-translation-pairing-driver.sh` 在 Git 索引里缺执行位（Windows 上 `core.filemode` 掩盖了它），Linux 上 `git merge` 调用该驱动直接 `Permission denied`，令 `translation-pairing-merge.spec.ts` 整文件失败。已改为 `100755`（`git update-index --chmod=+x`，约 5 个失败用例随之消失，且是确定性修复）。
- `code-runtime-worker-thread/runtime.spec.ts:384`（64 MiB 边界用例）撞 vitest 60 秒超时，属 runner 负载而非行为变化，后续按需加该用例的显式超时或纳入 exempt-heavy 名册。
- `typert/generator/type-model.spec.ts:195` 是快照 mismatch，需要先看 diff 才能判断真伪，本轮未动。

**归档退役的故障切换手册**：`2026-07-26-ci-failover-runbook` 三件套已按归档流程移入 `archived/process/`——双语各插入同一 `Archived: 2026-10-12` 行、sidecar 重录为归档路径与当前 blob 哈希、`verify-archived-agent-notes --write` 追加封印（429 → 432 件）。两处活跃 Note（`2026-07-21-serial-cross-platform-ci-reference`、`2026-07-22-evidence-based-larger-hosted-runners`）的入链改指归档路径并重录配对哈希，因此活跃配对从 1011 降到 1010 对，全部一致。

**仍未做 / 风险**：

- 快照漂移已定位到具体用例（`test:snapshot` 的 `pwsh-tool-turn` header 与两处 `session.jsonl`、`web browser snapshot` 的 `image-display`／`hmr-live`），但 CI 日志把断言正文截断，且本机是 Windows——快照车道在 Windows 上有 18 处环境性失败，而 fixture 要求能在 macOS/Linux 重放。因此"修复或重录"必须在 Linux 侧做：可行路径是加一个手动触发的诊断作业，把实际输出作为 artifact 传上来，再决定是修代码还是走 `test:snapshot:refresh`。
- A2 的缓存播种要等本改动落到 `main` 后才会对 PR 车道生效。
- 失败面还剩两处必须在 Linux 侧收口：快照漂移与 pwsh 流协议；两者都要靠手动诊断作业取回真实输出，本地 Windows 无法复现。
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
