# Agent Note: 目标轮次终结主张的独立认证

Status: implemented

[English](2026-10-10-goal-round-completion-certification.md) | 中文

## Problem

同会话的目标轮次目前凭模型一面之词结束：执行工作的 agent 以 `action: complete` 或 `blocked` 调用 `update_goal`，[`tool-goal`](../../../../packages/goal/tool-goal/README.zh.md) 校验该主张的权威与参数，[goal-round driver](../../../../packages/goal/goal-round-driver/README.zh.md) 随即停止续跑。于是完成与阻塞都是同一个会因结束轮次而受益的子代理的自申报。

[evaluated Ralph PoC](2026-10-09-evaluated-ralph-independent-evaluator-loop.zh.md) 已经证明第二个全新子代理可以在工作流引擎之上承担终结权威，其记录把 goal 域集成列为后续工作。该集成并不是 PoC 的复制：goal 域额外带来持久状态、revision、续跑抑制、人类权威，以及出货组合面；而且 goal 工具是一个长期存在的会话服务，而不是一次前台工具调用。

## Decision

发布 [`@vreal/dsh-goal-evaluator`](../../../../packages/goal/goal-evaluator/README.zh.md)，作为与 `tool-goal` 并列挂载的独立 Consumer 包。它通过一个全新的独立 evaluator 子代理认证自动目标轮次内提出的每一次终结性 `update_goal` 主张，既不改动 goal 域也不改动 agent loop，并且不触碰其他任何 goal 路径。

### 工具执行策略，而非 goal 域改动

认证是关于一次工具调用的策略决策，因此挂在文档化的 `tools/execute` waterfall 上。[goal 服务](../../../../packages/goal/goal/README.zh.md)、[轮次驱动器](../../../../packages/goal/goal-round-driver/README.zh.md) 与 `tool-goal` 保持各自既有职责：持久状态、续跑调度、主张权威、变更提交，以及重复阻塞阈值。省略该消费者的部署与之前完全一样，仍由模型自行决定。

判断一次调用是否在范围内需要与 `tool-goal` 相同的权威解析，因此该包在 `completionAuthority` 旁导出 [`peekTerminalAuthority`](../../../../packages/goal/tool-goal/src/authority.ts)：它返回直接人类或当前目标轮次的授权，对于权威缺失的调用返回 `undefined`，而不是拒绝。包装者因此把所有无法归属到活跃目标轮次的调用转交出去，由 `tool-goal` 给出自己的拒绝。

直接人类输入仍是逃生通道：`completionAuthority` 对人类回合中的终结主张仍返回 `{ kind: 'direct-human' }`，消费者不做评估直接转交，因此当模型的判断与 evaluator 的 verdict 都与键盘前的人相左时，人仍可结束目标。

### 每次终结主张一个全新 evaluator 子代理

子代理通过配置的 `subagentProvider` 运行，该 provider 必须已注册、支持结构化输出、并声明 `inheritsParentContext: false`；能力在每次评估前即时解析，因为 provider 注册可能随插件生命周期与 HMR 变化。子代理收到一份渲染好的 prompt，包含目标、轮次与上限、所主张的动作、以及报告的阻塞条件；它被要求不要信任该主张，并以只读方式对照共享工作区验证目标。

它的结构化 verdict——`complete | continue | blocked` 加上 `confirmed`、`missing`、`reasons`——是唯一的认证权威。消费者校验解码后的语义（`complete` 需要 confirmed 证据且没有 missing 条目；`continue` 需要至少一条 missing 条目；所有字符串非空且已去除首尾空白）：只有与所主张动作一致的 verdict 才通过，通过后调用 `next()`，因此常规的 `tool-goal` 更新仍会执行。不一致的 verdict 以 `GOAL_EVALUATOR_REJECTED` 拒绝；启动失败、子代理未成功结束、或 verdict 缺失、畸形、语义无效都以 `GOAL_EVALUATOR_FAILED` 拒绝。两种拒绝都把 verdict 或失败详情带进工具结果，并让目标保持活跃，使同一轮次可以针对报告出的缺失工作继续行动。

`blocked` 主张与其他主张一样被认证，但 verdict 不会取代 `tool-goal` 自己的策略：一致通过的 evaluator 仍把重复阻塞阈值留给工具。

### 审计记录只是信息性的

每次评估都会追加一个 `goal/evaluation` 会话事件，列出目标、revision、轮次、请求的动作、verdict、confirmed 与 missing 条目、reasons、provider，以及可能存在的 evaluator 模型覆盖。没有任何 fold 消费它：该事件是审计记录，拒绝反馈通过工具结果到达模型。因此它带有 `ignorable: true` 追加，使不认识该类型的读取方可以跳过它；这要求 [session append](../../../../packages/core/session/src/index.ts) 面接受非 surface 事件携带该标记，而不是把可选参数只留给 surface 元数据。

### 出货接线

该插件在三个出货 agent preset（`standard`、`code`、`cordis`）中都挂在 `tool-goal` 之后，并属于 base bundle；web-app bundle 显式禁用它，因为该 bundle 不包含 goal 域。其配置默认为 `enabled: true`、`subagentProvider: spawn` 和空的 `evaluatorModel`，因此默认组合使用调用方 agent 自身的模型进行认证，而部署无需改代码即可把评估路由到另一个模型。

## Testing

基于脚本化 provider 的单元测试覆盖配置校验与规范化、prompt 注册与销毁、完整拦截范围（其他工具、非终结动作、直接人类回合、无权威调用、非对象参数）、两种动作下通过与否决的 verdict、blocked 主张把阈值留给 `tool-goal`、全部失败路径（启动错误、非错误启动失败、被取消的子代理、结构化输出缺失、结构与语义无效的 verdict、provider 缺失/继承上下文/不支持结构化输出）、子代理请求字段，以及模型覆盖。

一个集成测试驱动真实 agent loop、goal 服务、`tool-goal` 与 in-process `spawn` provider：过早的完成主张被拒绝，evaluator 的缺失工作进入重试请求；第二次主张在一致 verdict 下完成；evaluator 请求携带目标事实且不含任何父对话；配置的模型覆盖只出现在 evaluator 请求上；失败的子代理让目标保持活跃；两个 evaluator 子代理是不同的 agent。

keyless ACP snapshot `examples/acp-agent/tests/goal-snapshots/goal-certified-round` 启动挂载了认证器的出货应用并脚本化模型：第一轮的完成主张被 evaluator 的 `continue` verdict 拒绝，第二轮主张在 `complete` verdict 下完成。期望转录固定了拒绝结果、两条 `goal/evaluation` 审计记录、持久化完成，以及收尾消息。

## Alternatives considered

- **把认证并入 `goal-round-driver`**——否决：驱动器决定何时启动下一轮，而认证决定一次工具调用是否可以提交。挂在工具执行 waterfall 上把这个决策留在调用发生之处，使一条策略能覆盖同一轮次内的多次终结主张，也让续跑策略保持可读。
- **让 `tool-goal` 自己运行 evaluator**——否决：该工具将因此依赖 `ctx.subagents` 与一次额外的模型往返，于是每个挂载 goal 工具的组合同样需要全新的结构化输出 provider，而一个包会同时拥有主张的权威规则与其验证。
- **把重复阻塞阈值交给 evaluator**——否决：`tool-goal` 已经在按不同已准入轮次计数同一个阻塞者；移动或复制该计数会让一条策略出现两个拥有者，并使阈值随评估策略变动而变动。
- **连直接人类回合的终结主张也评估**——否决：当模型的判断与 evaluator 的 verdict 都与键盘前的人相左时，人类权威是唯一还能结束目标的路径。
- **把一致的 verdict 直接当作工具结果，而不调用 `next()`**——否决：常规 `update_goal` 结果是模型可见契约，且在通过路径上 `tool-goal` 仍必须校验参数并应用自己的策略。
- **让 evaluator 走外部 provider 以获得跨家族独立性**——否决：`claude-code` 与 `codex` 不声明结构化输出能力，因此 verdict 需要一层的文本解析，落在经过验证的结构化输出运行时之外；今天可用的独立性来自全新上下文、不信任主张的指令与只读工作区验证。
- **在轮次内重试失败或不可用的 evaluator**——否决：重试策略与取消和预算相互作用，且重试会向模型隐藏 provider 不可用的事实；失败对该次主张保持终结性。

## Consequences

- 自动目标轮次不再能仅凭调用方一面之词完成或阻塞：必须先获得第二个全新子代理的同意，拒绝则把具体缺失工作带回同一轮次，同时目标保持活跃。
- 自动轮次内的每次终结主张现在多花一个子代理，且没有自己的预算上限；`enabled: false` 或不挂载该行即可恢复原行为，且无需触碰 goal 域。
- 人类权威与 `tool-goal` 的阈值策略各自保持唯一拥有者，因此认证不会悄悄改变结束目标的规则。
- 会话日志新增只写日志的 `goal/evaluation` 记录，会话 append 面新增非 surface 的 `ignorable` 标记。

## Known limitations and deferred work

- **默认同族评估**——除非设置 `evaluatorModel`，evaluator 是同一模型的全新子代理；跨家族评估仍受限于外部 provider 是否声明结构化输出。
- **verdict 是模型判断**——evaluator 被要求对照工作区验证，但没有任何机制强制它超出自身裁量去运行检查。
- **没有 evaluator 预算或重试**——每个主张只评估一次，provider 损坏或不可用时不重试，子代理也没有 token、价格或墙钟上限。
- **仅限 goal 工具**——该策略覆盖终结性 `update_goal` 主张；经人类命令面完成或阻塞的目标、以及插件直接调用服务达成的目标，按设计不在其范围内。
