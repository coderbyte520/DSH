# @vreal/dsh-goal-evaluator

[English](README.md) | 中文

目标轮次完成认证器。作为 [`ctx.on('tools/execute')`](../../core/tools/README.zh.md) 策略消费者，它拦截在自动目标轮次内提出的终结性 `update_goal` 主张，并在持久化目标变更被放行之前运行一个全新的独立 evaluator 子代理。只有 evaluator 的结构化 verdict 能授权终结更新；不一致的 verdict 或失败的评估会以 evaluator 已验证的反馈拒绝该调用，并让目标保持活跃以供下一轮继续。直接的人类回合对同一批工具保留无条件的终结权威。策略及其后续工作由 [goal-round certification Agent Note](../../../.agents/notes/implemented/feature/2026-10-10-goal-round-completion-certification.zh.md) 记录。

## Contract

该消费者把每个 `tools/execute` 调用收窄为这样一次 `update_goal`：其 `action` 为 `complete` 或 `blocked`，且其权威来自当前已准入的目标轮次（通过 [`peekTerminalAuthority`](../tool-goal/README.zh.md) 解析）。其他所有调用——别的工具、`create_goal`/`get_goal`/`edit_goal`/`pause_goal`/`resume_goal`/`clear_goal`、直接人类回合的终结主张、或完全不带权威的调用——都转交 `next()`，由 `tool-goal` 原样给出自己的结果或拒绝。

配置的 `subagentProvider` 必须已注册、声明 `capabilities.outputSchema`、并声明 `inheritsParentContext: false`；插件在每次评估前即时解析这些能力，因为 provider 注册可能随插件生命周期与 HMR 变化。子代理收到一份全新的、由本包渲染的 prompt，其中列出目标、当前轮次与上限、所主张的动作，以及（对 blocked 主张）模型报告的阻塞条件。它不接收父对话，被要求不要信任该主张，并以只读方式对照共享工作区验证目标。

verdict 解码后的形式是 `verdict: complete | continue | blocked` 加上 `confirmed`、`missing` 和 `reasons`。所有字符串必须非空且已去除首尾空白；`complete` 要求至少一条 confirmed 条目且没有 missing 条目，`continue` 要求至少一条 missing 条目。只有与所请求动作一致的 verdict 才算通过，通过后会调用 `next()`，因此常规的 `tool-goal` 更新（包括它自己的阻塞策略）仍会执行。不一致的 verdict 以 `GOAL_EVALUATOR_REJECTED` 拒绝；启动失败、子代理未成功结束、结构化输出缺失或畸形、以及语义无效的 verdict 都以 `GOAL_EVALUATOR_FAILED` 拒绝。两种拒绝都会把 verdict 的 `confirmed`、`missing`、`reasons`（或失败详情）放进工具结果文本，并让目标保持活跃。

每次评估都会追加一个 `goal/evaluation` 会话事件，携带目标 id 与 revision、轮次、请求的动作、verdict、confirmed 与 missing 条目、reasons、provider，以及配置了 evaluator 模型覆盖时该覆盖值。该事件标记为 `ignorable: true`：它是只写日志的审计记录，没有任何 fold 消费它，因此不认识该类型的读取方可跳过它，丢失它也不会改变会话重建结果。

## Lifecycle and cancellation

调用方 agent 是 evaluator 子代理的父代理，因此子代理保留会话的 cwd 与谱系，但不继承其对话。`exec.signal` 进入 `ctx.subagents.start`，运行被等待并在 `finally` 中销毁，因此被取消的父步骤会等待子代理的有界终止后才返回。被取消的评估属于认证失败：主张被拒绝、目标保持活跃，而不是让回合失败。

`apply()` 在插件挂载时校验并规范化配置，包括在 Loader schema 规范化之外的直接 apply。销毁会随插件 fiber 同时移除 system prompt 段与拦截；`enabled: false` 则两者都不注册。

## Config

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否对目标轮次的终结主张做认证。 |
| `subagentProvider` | `spawn` | 每个 evaluator 子代理使用的全新结构化输出 provider。 |
| `evaluatorModel` | `''` | evaluator 子代理的可选模型覆盖；空表示使用调用方 agent 的模型。 |

## Model Experience

### System prompt

#### What the model sees

本插件注册作用域内的每个请求都会收到下述固定认证指引，使模型知道自动轮次的终结主张会被验证，且被拒绝的更新会带回需要完成的工作。

##### Goal certification guidance

```markdown
During an automatic goal round, a terminal update_goal action (complete or blocked) is verified by one independent evaluator child before the goal changes. A rejected update returns the evaluator's verified feedback: perform the listed missing work and request the terminal action again. A direct human turn still decides terminal goal updates without evaluation.
```

#### Token effect

插件活跃期间，每个请求承担少量固定指引开销。

#### KV Cache effect

在插件作用域与指引文本不变时前缀稳定。激活或卸载可能使该 prompt 段的复用失效。

### Evaluator child request and terminal-claim outcome

#### What the model sees

每个 evaluator 子代理看到一份全新的、由本包渲染的 prompt，其中包含目标、目标轮次与上限、所主张的终结动作，以及（对 blocked 主张）报告的阻塞条件；它看不到父对话，并被要求不得修改工作区。父模型永远看不到 evaluator 子代理的消息：认证通过时常规 `update_goal` 结果原样保留，被拒绝时则替换为一个 `update_goal` 工具结果，携带 verdict 的 `confirmed`、`missing`、`reasons`，或失败详情。

#### Token effect

每次被认证的终结主张都支付一个全新 evaluator 子代理上下文。verdict 的条目与 reasons 只作为拒绝结果的文本回到父代理；认证通过不增加父请求 token。

#### KV Cache effect

每个 evaluator 子代理有独立的请求缓存。认证通过不会向父请求追加内容；被拒绝时在可复用父前缀之后追加一个工具结果。

## Known Limitations and Deferred Work

- **默认是同族评估**——除非 `evaluatorModel` 覆盖，evaluator 是同一模型的全新子代理；独立性来自全新上下文、不信任主张的指令、以及只读的工作区验证，而非跨家族复核。跨家族 evaluator 受限于外部 provider 尚未声明结构化输出支持，而非本策略。
- **verdict 是模型判断，不是机械证明**——evaluator 被要求对照工作区验证，但没有任何机制强制它超出自身裁量去运行检查，一个自信的错误 verdict 仍然是权威的。
- **每个主张只评估一次**——失败或不一致的评估只拒绝该次主张；轮次继续，模型可以再次请求终结动作，但没有自动重评估，也没有针对 provider 不可用或损坏的重试策略。
- **仅限自动目标轮次**——在直接人类回合上记录的终结动作永远不会被评估，因此由人类主导的完成或阻塞保留调用方未经检查的权威。
- **阻塞仍受 `tool-goal` 约束**——一致的 `blocked` verdict 不会绕过 `tool-goal` 自己对重复阻塞者的已准入轮次阈值；evaluator 认证的是主张，而不是阈值。
- **认证为每个终结主张消耗一个子代理**——自动轮次内的每次终结主张都会在轮次自身工作之外再启动一个全新子代理，且没有自己的 token、价格或墙钟预算。
