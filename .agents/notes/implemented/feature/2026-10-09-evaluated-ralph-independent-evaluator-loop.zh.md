# Agent Note: 带独立 evaluator 的 Evaluated Ralph 循环

Status: implemented

[English](2026-10-09-evaluated-ralph-independent-evaluator-loop.md) | 中文

## Problem

全新 agent 的 Ralph 工具会向一个目标迭代，但完成与阻塞是 worker 自申报：执行工作的同一个子代理决定循环结束，工具信封也如此声明。同样的缺口也是同会话 goal round driver 的第一条后续工作。在把 evaluator 认证接入 goal 生命周期——那会牵动持久状态、revision 与续跑策略——之前，harness 需要证据证明独立 evaluator 确实能改善循环结果，而这样的成本与风险只有可移除的 PoC 才能承担。

外部 agent provider（`claude-code`、`codex`）不声明任何 start-time 能力，因此今天无法返回结构化 verdict；它们在出货组合中也是 dormant 的 Profile Bundle。任何需要结构化输出的 evaluator PoC 都必须跑在 in-process provider 之上。

## Decision

在 `packages/workflow/` 下新增独立 Consumer 包 `@vreal/dsh-tool-ralph-evaluated`，克隆 `ralph` 工具的固定工作流模式。它注册 `ralph_evaluated({ objective, maxRounds? })`，不改 `dsh-tool-ralph`、goal 域，也不改 agent loop。这个 PoC 回答一个问题：把终止权威从 worker 移交给第二个全新子代理，是否能让全新 agent 迭代可信到值得继续建设。

### 一轮是一个 worker 加一个 evaluator

每轮通过同一个配置的 `subagentProvider` 先启动一个全新 worker 子代理，再启动一个全新 evaluator 子代理；该 provider 必须支持结构化输出并声明 `inheritsParentContext: false`。worker 报告彻底去掉 `status` 字段——只包含 `summary`、`evidence`、`remaining` 与 `blocker`——因此 worker 在结构上就无法宣布循环结束。evaluator 收到目标、上一轮 handoff 和当前 worker 报告，被告知不可信任报告，必须以只读方式对照工作区验证证据主张。它的 verdict——`complete | continue | blocked` 加上 `confirmed`、`missing`、`reasons`——是唯一的轮次状态权威；固定脚本校验其语义（complete 需要已确认证据且无 missing；continue 需要具体的 missing 工作），并像 `ralph` 一样对合并后的 worker+verdict handoff 做 `maxHandoffChars` 校验，且在消费端边界二次校验。

### 翻倍的是子代理预算，不是轮数预算

`maxRounds` 仍只约束 worker 轮数。由于每轮消耗两个子代理，工具把 `2 * maxRounds` 作为 `WorkflowStartRequest.maxTotalAgents` 传入，使固定的"每轮两个子代理"模式保持在引擎的失控子代理兜底之内。引擎的部署上限（默认 1000）因此在出货值下把可达轮数减半；调高上限的部署必须把这个翻倍算进去。

### evaluator 是模型覆盖，不是 provider 路由

workflow 运行时的 `agent()` 已接受 `model` 选项，`resolveChildAgentOptions` 允许子代理请求覆盖父模型而无需目录校验。插件暴露 `evaluatorModel` 配置（默认空）：非空时所有 evaluator 子代理路由到该模型，worker 保持循环自身模型；空表示同模型评测——独立性保证来自全新上下文、无 status 的 worker 报告与仅限工作区的验证。按阶段选择 provider 与外部 agent evaluator 刻意不进入本 PoC；前者需要新的引擎管道，后者受限于外部 provider 缺少结构化输出。

### 失败语义

worker 或 evaluator 子代理落定为不成功时映射为 `round-failed`，附失败轮次与最后一份成功 handoff；evaluator 失败与 worker 失败同样是终止性的，因为 evaluator 是唯一的状态权威。结构化输出畸形或语义非法、合并 handoff 超限，都会使工作流失败而不是截断。面向父代理的渲染指认 evaluator 为判定权威（`The evaluator confirmed completion…`），绝不把 worker 输出呈现为认证。

## Testing

单元测试克隆 `ralph` 套件的 StubEngine/StubProvider 边界：配置与调用上限解析（含 `evaluatorModel` 规范化）、翻倍的 `maxTotalAgents` 启动请求、provider 能力拒绝、evaluator 模型参数传递、全部四种终止状态、畸形与超限的终止值、abort 桥接、dispose、渲染意图、prompt 生命周期与 namespace-plugin 形状。真栈集成通过 worker-thread 引擎与 spawn provider 驱动固定脚本：两轮运行中第一轮 worker 申报 `remaining: []` 而 evaluator 以具体 missing 推翻它，并证明 missing 只到达第二轮 worker；配置的 `evaluatorModel` 覆盖被观察到出现在 evaluator 请求的 model 中而 worker 保持循环模型；以及 blocked、budget-limited、verdict 畸形、continue 语义非法、complete 语义非法、handoff 超限、第二轮子代理失败与取消至静默等场景。

## Alternatives considered

- **先把 evaluator 接进 goal round driver** — 作为 PoC 被否决，因为 goal 生命周期会给任何改动附加持久状态、revision 与续跑抑制策略；一个可移除的工作流工具能隔离假设。
- **保留 worker 的 `status` 字段并让 evaluator 否决** — 否决，因为 status 字段会诱导"worker 决定完成 + 审批仪式"的模式，比报告/判决分离更难推理，并以另一种名义重新引入自申报。
- **独立 `evaluate` 工具由父代理手动调用** — 否决，因为循环没有闭环：模型仍可以接受 worker 自申报并跳过评测，PoC 就测不到闭环行为。
- **evaluator 走 `claude-code` provider 做跨家族验证** — 否决，因为该 provider 不声明任何 start-time 能力，结构化 verdict 需要在经过校验的结构化输出运行时之外加一层文本解析；跨家族评测继续受限于 provider 能力而非本工具。
- **轮内重试失败的 evaluator** — 否决，因为重试策略与预算、取消相互纠缠；PoC 保持失败终止并把该缺口记为后续工作。

## Consequences

- 全新 agent 迭代获得一个变体：完成、继续与阻塞由一个从不执行工作的子代理决定，把后续已久的"evaluator 认证"从概念变成一个可运行、可测试的策略。
- worker/evaluator 的报告分离为下一步（goal 域认证）提供了可复用的判决词汇（`confirmed`、`missing`、`reasons`）。
- 每轮两个子代理让单轮成本翻倍，并使引擎上限下的可达轮数减半；只有启用该工具的组合才支付这笔开销。
- `ralph` 仍是 worker 自申报的循环且保持不变；两个工具的唯一差别是终止权威是否被委托，这让对比可度量。
- 同模型评测是默认值，因此被试验的独立性是上下文性的（全新上下文、不可信报告指令、仅工作区验证）而非架构性的；拥有第二个模型的部署只需配置即可获得跨模型独立性。

## Known limitations and deferred work

- 未覆盖时 evaluator 是同族子代理；跨家族验证等待外部 provider 支持结构化输出。
- evaluator verdict 仍是模型判断而非机械认证的证明：evaluator 被要求对照工作区验证，但没有机制强制它运行超出其自行判断的检查。
- 仅前台、工作区是唯一跨轮记忆、无轮内 fan-out、无重试、无 token/价格/时间预算——全部继承自 `ralph` 模式并同样顺延。
- goal 域集成（在 `goal-round-driver` 中认证 goal 轮次完成）是有意的下一步，不在本 PoC 范围内。
