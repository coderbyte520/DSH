# @vreal/dsh-tool-ralph-evaluated

[English](README.md) | 中文

模型可见的 `ralph_evaluated` 工具运行一个固定前台工作流：把一个不可变目标交给一序列的全新 worker 子代理，每个 worker 之后跟一个独立的全新 evaluator 子代理。worker 只报告进度与证据；evaluator 对照共享工作区验证这些证据，并独自判定目标是已完成、循环应继续、还是被阻塞。它作为 [`ctx.workflowEngine`](../workflow/README.zh.md) 与 [`ctx.subagents`](../../subagent/subagent/README.zh.md) 之上的普通插件展示"由 evaluator 决定完成"的策略：不向 `agent-loop` 添加任何新循环，worker 自申报完成的 [`ralph`](../tool-ralph/README.zh.md) 工具与同会话 [goal 域](../../goal/goal/README.zh.md) 保持独立。策略与后续工作由 [Evaluated Ralph Agent Note](../../../.agents/notes/implemented/feature/2026-10-09-evaluated-ralph-independent-evaluator-loop.zh.md) 记录。

## Contract

`ralph_evaluated({ objective, maxRounds? })` 等待整个运行结束。部署配置的 `maxRounds` 既是调用覆盖的默认值也是上限。每轮通过 `subagentProvider` 先启动一个全新 worker 子代理，再启动一个全新 evaluator 子代理；该 provider 必须存在、支持结构化输出、且声明 `inheritsParentContext: false`。解析后的轮数上限会翻倍并作为 `WorkflowStartRequest.maxTotalAgents` 传入，使"每轮两个子代理"的模式与引擎的总子代理数兜底协调一致。

每个 worker 只收到不可变目标、当前轮次与上限、以及上一轮经 evaluator 验证的 handoff。worker 报告没有 status 字段：只包含 `summary`、`evidence`、`remaining` 和 `blocker`，因此 worker 永远无法宣布循环结束。每个 evaluator 收到目标、上一轮 handoff 和当前 worker 报告，并被要求以只读方式对照工作区逐条验证证据，而不是信任报告。evaluator 的 verdict——`verdict: complete | continue | blocked` 加上 `confirmed`、`missing`、`reasons`——是唯一的轮次状态权威。状态语义与合并后 worker+verdict handoff 的 `maxHandoffChars` 序列化上限在固定工作流内校验一次，在消费端边界再校验一次。非法、缺失或超限的输出会使工作流失败，而不是被截断或被误认为轮数耗尽。

成功的终止工具结果是 `complete`、`blocked` 或 `budget-limited`，附带最后一份经 evaluator 验证的 summary 和已开始的轮数。规范信封为 `{ runId, agentsStarted, result }`；其 Native 渲染中的完成与阻塞文案明确指认 evaluator 是判定权威，而非 worker。`maxResultChars` 只约束该渲染文本（含截断标记），不改变规范值中已校验的 summary，也不改变跨轮 handoff。

`evaluatorModel` 配置非空时，所有 evaluator 子代理路由到该模型，worker 保持循环自身模型；空字符串默认值表示不覆盖。worker 或 evaluator 的普通失败会产生一个指名失败轮次的错误，并在存在上一轮成功 handoff 时保留它。循环不重试该轮。致命的 provider 启动、传输、worker 或工作流失败仍属于工作流错误，可能在固定脚本返回 handoff 之前就落定。取消同样是错误；部分输出永远不算成功。

## Lifecycle and cancellation

调用方 agent 是每个全新 worker 与 evaluator 子代理的父代理，保持 cwd 与谱系但不复制其对话。`exec.signal` 进入工作流引擎，并桥接到 `run.cancel()` 以保持实现无关。工具等待 `run.result` 并在 `finally` 中调用 `run.dispose()`，因此被取消的父步骤会等待引擎的有界终止与子代理静默后才返回。

## Render intent

进行中的调用是标题为 `ralph_evaluated` 的 `generic` 卡片；不可变目标是其 `rawInput`。结果保持 generic 卡片。两个呈现函数只依赖工具参数与已落定的工具信封。

## Config

| 键 | 默认值 | 含义 |
|---|---|---|
| `subagentProvider` | `spawn` | 每个 worker 与 evaluator 使用的全新结构化输出 provider。 |
| `maxRounds` | `256` | 一次运行的 worker 轮数默认值与部署上限。 |
| `maxHandoffChars` | `16384` | 一份合并后经 evaluator 验证的 handoff 的最大序列化字符数。 |
| `maxResultChars` | `16384` | 完成成功的父侧结果的最大字符数。 |
| `evaluatorModel` | `''` | evaluator 子代理的可选模型覆盖；空表示使用循环自身模型。 |

所有配置值在插件应用时即被规范化并校验，包括在 Loader schema 规范化之外的直接 apply。provider 能力在每次调用前即时解析，因为 provider 注册可能随插件生命周期与 HMR 变化。

## Model Experience

### System prompt

#### What the model sees

本插件注册作用域内的每个父请求都会收到下述固定路由指引。

##### Evaluated Ralph guidance

```markdown
Use the ralph_evaluated tool ONLY when the direct human explicitly asks for an evaluated Ralph loop, a Ralph loop with independent verification, or fresh-agent iteration with a verifier. Each round starts a fresh worker child and a fresh evaluator child with no conversation seed; the shared workspace is durable memory. The worker never decides completion: the evaluator verifies the worker evidence against the workspace and alone decides complete, continue, or blocked. Use ralph when worker-declared completion is acceptable, same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.
```

#### Token effect

插件活跃期间，每个请求承担少量固定指引开销。

#### KV Cache effect

在插件作用域与指引文本不变时前缀稳定。激活或卸载可能使该 prompt 段的复用失效。

### Tool schema

#### What the model sees

生成的 [`ralph_evaluated` schema](../../../docs/tool-catalog.zh.md#vrealdsh-tool-ralph-evaluated) 暴露一个必填 `objective` 字符串和一个可选 `maxRounds` 数字。provider 选择、evaluator 模型、handoff 大小、报告与 verdict schema、编排行为均为部署所有，不出现在调用 schema 中。

#### Token effect

工具可见的每个请求承担少量固定 schema 开销。

#### KV Cache effect

定义与可见性不变时前缀稳定。

### Worker and evaluator requests and parent result

#### What the model sees

每个 worker 看到独立的固定 worker prompt 加上结构化输出捕获契约；每个 evaluator 看到独立的固定 evaluator prompt 加上其自己的捕获契约。父代理只看到原始调用和一个终止结果，其中包含 evaluator 判定的状态、轮数和格式化的经 evaluator 验证的 summary；中间的子代理消息、worker 报告与 verdict 不进入父对话。子代理失败则产生一个带轮次的错误，第一轮之后还会附带最后一份成功 handoff。

#### Token effect

每轮支付两个全新子代理上下文（worker 与 evaluator）。`maxHandoffChars` 约束合并后的跨轮状态，`maxResultChars` 独立约束完成成功的父侧文本；所有子代理工作都留在父上下文之外。

#### KV Cache effect

每个全新子代理有独立的请求缓存。父结果追加在可复用请求前缀之后。

## Known Limitations and Deferred Work

- **未覆盖时 evaluator 是同族子代理**——独立性来自全新上下文、无 status 的 worker 报告、以及仅只读的工作区验证；更强的跨家族 evaluator（例如外部 Claude Code 或 Codex 子代理）受限于这些 provider 缺少结构化输出支持，而非本工具的策略。
- **仅前台**——没有 job id、后台收集、进程恢复检查点、调度器或墙钟启动策略。
- **工作区是唯一的跨轮长期记忆**——只有一份有界合并报告是显式 handoff，未提交的对话推理随每个子代理消失。
- **一轮是一个 worker 加一个 evaluator**——没有轮内 fan-out、除 evaluator 模型覆盖之外的按阶段 provider 选择、也没有 fork 上下文。
- **子代理普通失败即终止本次运行**——固定脚本会报告失败轮次与最后成功 handoff，但不重试；evaluator 失败与 worker 失败同样是终止性的。
- **只有轮数约束总投入**——token、价格与耗时预算为后续工作；每轮消耗两个子代理，因此引擎的总子代理上限在部署值下实际把可达轮数减半。
