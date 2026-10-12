# Agent Note: Independent certification of terminal goal-round claims

Status: implemented

English | [中文](2026-10-10-goal-round-completion-certification.zh.md)

## Problem

A same-session goal round currently ends on the model's own word: the agent that performed the work calls `update_goal` with `action: complete` or `blocked`, [`tool-goal`](../../../../packages/goal/tool-goal/README.md) validates the claim's authority and arguments, and the [goal-round driver](../../../../packages/goal/goal-round-driver/README.md) stops continuing. Completion and blockage are therefore self-declarations by the same child that would benefit from ending the round.

The [evaluated Ralph PoC](2026-10-09-evaluated-ralph-independent-evaluator-loop.md) established that a second fresh child can carry termination authority over the workflow engine, and its note deferred goal-domain integration. That integration is not a copy of the PoC: the goal domain adds durable state, revisions, continuation suppression, human authority, and shipped composition surfaces, and the goal tools are one long-lived session service rather than one foreground tool call.

## Decision

Ship [`@vreal/dsh-goal-evaluator`](../../../../packages/goal/goal-evaluator/README.md) as a separate Consumer package mounted beside `tool-goal`. It certifies every terminal `update_goal` claim made inside an automatic goal round through one fresh independent evaluator child, changes neither the goal domain nor the agent loop, and leaves every other goal path untouched.

### A tool-execution policy, not a goal-domain change

Certification is a policy decision about one tool call, so it attaches to the documented `tools/execute` waterfall. The [goal service](../../../../packages/goal/goal/README.md), the [round driver](../../../../packages/goal/goal-round-driver/README.md), and `tool-goal` keep their existing responsibilities: durable state, continuation scheduling, claim authority, mutation, and the repeated-blocker threshold. A deployment that omits the consumer keeps the model-decided behavior exactly as before.

Deciding whether a call is in scope requires the same authority resolution `tool-goal` performs, so that package exports [`peekTerminalAuthority`](../../../../packages/goal/tool-goal/src/authority.ts) beside `completionAuthority`: it returns the direct-human or current-goal-round grant, or `undefined` for a call whose authority is absent, instead of rejecting. A wrapper therefore delegates every call it cannot attribute to a live goal round, and `tool-goal` produces its own rejection for it.

Direct human input stays the escape hatch: `completionAuthority` still returns `{ kind: 'direct-human' }` for a terminal claim in a human turn, the consumer delegates it unevaluated, and a human can end a goal the model and evaluator both misjudge.

### One fresh evaluator child per terminal claim

The child runs through the configured `subagentProvider`, which must be registered, support structured output, and report `inheritsParentContext: false`; capabilities are resolved immediately before each evaluation because provider registration can change under plugin lifecycle and HMR. The child receives one rendered prompt with the objective, the round and cap, the claimed action, and any reported blocking condition, and it is told not to trust the claim and to verify the objective against the shared workspace read-only.

Its structured verdict — `complete | continue | blocked` with `confirmed`, `missing`, and `reasons` — is the only certification authority. The consumer validates the decoded semantics (`complete` needs confirmed evidence and no missing entries; `continue` needs at least one missing entry; all strings non-empty and trimmed): only a verdict equal to the claimed action passes, and passing calls `next()` so the ordinary `tool-goal` update still runs. A disagreeing verdict rejects with `GOAL_EVALUATOR_REJECTED`; a start failure, an unsuccessful child, or a missing, malformed, or semantically invalid verdict rejects with `GOAL_EVALUATOR_FAILED`. Both rejections carry the verdict or failure detail into the tool result and leave the goal active, so the same round can act on the reported missing work.

A `blocked` claim is certified like any other, but the verdict does not replace `tool-goal`'s own policy: an agreeing evaluator still leaves the repeated-blocker threshold to the tool.

### The audit record is informational

Each evaluation appends one `goal/evaluation` session event naming the goal, revision, round, requested action, verdict, confirmed and missing entries, reasons, provider, and any evaluator model override. Nothing folds it: the event is an audit record, and the rejection feedback reaches the model through the tool result. It is therefore appended with `ignorable: true` so a reader that does not know the type may skip it, which required the [session append](../../../../packages/core/session/src/index.ts) seam to accept that marker for non-surface events instead of reserving its optional argument for surface metadata.

### Shipped wiring

The plugin mounts after `tool-goal` in all three shipped agent presets (`standard`, `code`, `cordis`) and is part of the base bundle; the web-app bundle disables it explicitly because it ships no goal domain. Its config defaults to `enabled: true`, `subagentProvider: spawn`, and an empty `evaluatorModel`, so the default composition certifies with the calling agent's own model and a deployment can route evaluation to a different model without code changes.

## Testing

Unit tests over a scripted provider cover configuration validation and normalization, prompt registration and disposal, the full interception scope (other tools, non-terminal actions, direct-human turns, calls without authority, non-object arguments), agreeing and disagreeing verdicts for both actions, blocked claims leaving the threshold to `tool-goal`, every failure path (start error, non-error start failure, cancelled child, missing structured output, structurally and semantically invalid verdicts, missing/context-inheriting/schema-less providers), child request carriage, and the model override.

An integration test drives the real agent loop, goal service, `tool-goal`, and the in-process `spawn` provider: a premature completion claim is rejected with the evaluator's missing work carried into the retry request, the second claim completes on an agreeing verdict, the evaluator requests carry the goal facts and none of the parent conversation, the configured model override appears only on evaluator requests, a failed child keeps the goal active, and the two evaluator children are distinct agents.

The keyless ACP snapshot `examples/acp-agent/tests/goal-snapshots/goal-certified-round` boots the shipped application with the certifier mounted and the model scripted: the round-one completion claim is rejected with the evaluator's `continue` verdict, and the round-two claim completes on a `complete` verdict. The expected transcript pins the rejection result, both `goal/evaluation` audit records, the durable completion, and the wrap-up closing message.

## Alternatives considered

- **Fold certification into `goal-round-driver`** — rejected: the driver decides when to start the next round, while certification decides whether one tool call may commit. Attaching it to the tool-execution waterfall keeps that decision where the call is, lets one policy cover several terminal claims inside a single round, and keeps continuation policy readable.
- **Let `tool-goal` run the evaluator itself** — rejected: the tool would then depend on `ctx.subagents` and a second model round-trip, so every composition that mounts the goal tools would also need a fresh structured-output provider, and one package would own both the claim's authority rules and its verification.
- **Give the evaluator the repeated-blocker threshold** — rejected: `tool-goal` already counts distinct admitted rounds for the same blocker; moving or duplicating that accounting would create two owners for one policy and make the threshold move whenever the evaluation policy changes.
- **Evaluate direct-human terminal claims too** — rejected: human authority is the only path that can stop a goal when the model's claims and the evaluator's verdicts both disagree with the person at the keyboard.
- **Treat an agreeing verdict as the tool result instead of calling `next()`** — rejected: the ordinary `update_goal` result is the model-visible contract, and `tool-goal` must still validate arguments and apply its own policy on the accepted path.
- **Route evaluators through an external provider for cross-family independence** — rejected: `claude-code` and `codex` report no structured-output capability, so a verdict would need a text-parsing layer outside the validated structured-output runtime; the independence available today is the fresh context, the untrusted-claim instruction, and read-only workspace verification.
- **Retry a failed or unavailable evaluator inside the round** — rejected: retry policy interacts with cancellation and budgets, and a retried failure would hide an unavailable provider from the model; failure stays terminal for that claim.

## Consequences

- An automatic goal round can no longer complete or block on the caller's word alone: a second fresh child must agree first, and a rejection returns concrete missing work into the same round while the goal stays active.
- Every terminal claim inside an automatic round now costs one additional child, bounded by no budget of its own; `enabled: false` or leaving the row out restores the previous behavior without touching the goal domain.
- Human authority and `tool-goal`'s threshold policy keep single owners, so certification cannot silently change the rules for ending a goal.
- The session log gains a log-only `goal/evaluation` record and the session append seam gains the non-surface `ignorable` marker.

## Known limitations and deferred work

- **Same-kind evaluation by default** — the evaluator is a fresh child of the same model unless `evaluatorModel` is set; cross-family evaluation stays blocked on external providers reporting structured output.
- **A verdict is model judgment** — the evaluator is instructed to verify against the workspace, but nothing forces it to run checks beyond its own discretion.
- **No evaluator budget or retry** — one evaluation per claim, no retry for a broken or unavailable provider, and no token, price, or wall-time ceiling for the child.
- **Goal tools only** — the policy covers terminal `update_goal` claims; goals completed or blocked through the human command surface or by a plugin calling the service directly are outside its scope by design.
