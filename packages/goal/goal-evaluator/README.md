# @vreal/dsh-goal-evaluator

English | [中文](README.zh.md)

The goal-round completion certifier. As a [`ctx.on('tools/execute')`](../../core/tools/README.md) policy consumer it intercepts terminal `update_goal` claims made inside an automatic goal round and runs one fresh independent evaluator child before the durable goal mutation is allowed through. The evaluator's structured verdict alone authorizes the terminal update; a disagreeing verdict or a failed evaluation rejects the call with the evaluator's verified feedback and leaves the goal active for the next round. A direct human turn keeps its unconditional terminal authority over the same tools. The [goal-round certification Agent Note](../../../.agents/notes/implemented/feature/2026-10-10-goal-round-completion-certification.md) owns the policy and its deferred work.

## Contract

The consumer narrows each `tools/execute` call to one named `update_goal` whose `action` is `complete` or `blocked` and whose authority is the current admitted goal round, resolved through [`peekTerminalAuthority`](../tool-goal/README.md). Every other call — another tool, `create_goal`/`get_goal`/`edit_goal`/`pause_goal`/`resume_goal`/`clear_goal`, a direct-human terminal claim, or a call carrying no authority at all — delegates to `next()`, so `tool-goal` produces its own result or rejection unchanged.

The configured `subagentProvider` must be registered, report `capabilities.outputSchema`, and report `inheritsParentContext: false`; the plugin resolves those capabilities immediately before each evaluation because provider registration can change under plugin lifecycle and HMR. The child receives one fresh package-rendered prompt naming the objective, the current round and cap, the claimed action, and — for a blocked claim — the model-reported blocking condition. It receives no parent conversation, is told not to trust the claim, and verifies the objective against the shared workspace read-only.

The verdict's decoded form is `verdict: complete | continue | blocked` with `confirmed`, `missing`, and `reasons`. Every string must be non-empty and trimmed; `complete` requires at least one confirmed entry and no missing entries, and `continue` requires at least one missing entry. A verdict equal to the requested action is the only acceptance, and acceptance calls `next()` so the ordinary `tool-goal` update, including its own blocking policy, still runs. A disagreeing verdict rejects with `GOAL_EVALUATOR_REJECTED`; a start failure, an unsuccessful child, a missing or malformed structured output, or a semantically invalid verdict rejects with `GOAL_EVALUATOR_FAILED`. Both rejections carry the verdict's `confirmed`, `missing`, and `reasons` (or the failure detail) in the tool result text and leave the goal active.

Every evaluation appends one `goal/evaluation` session event carrying the goal id and revision, round, requested action, verdict, confirmed and missing entries, reasons, provider, and the evaluator model override when one is configured. The event is marked `ignorable: true`: it is a log-only audit record that no fold consumes, so a reader that does not know the type may skip it and losing it cannot change session reconstruction.

## Lifecycle and cancellation

The calling agent is the evaluator child's parent, so the child keeps the session's cwd and lineage without inheriting its conversation. `exec.signal` enters `ctx.subagents.start`, and the run is awaited and disposed in `finally`, so a cancelled parent step waits for the child's bounded termination before returning. A cancelled evaluation is a certification failure: the claim is rejected and the goal stays active rather than failing the turn.

`apply()` validates and normalizes its configuration when the plugin mounts, including direct application outside Loader schema normalization. Disposal removes both the system-prompt section and the interception with the plugin's fiber; `enabled: false` registers neither.

## Config

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether terminal goal-round claims are certified. |
| `subagentProvider` | `spawn` | Fresh structured-output provider used for every evaluator child. |
| `evaluatorModel` | `''` | Optional model override for the evaluator child; empty means the calling agent's model. |

## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope carries the fixed certification guidance below, so the model knows that an automatic round's terminal claim is verified and that a rejection returns work to perform.

##### Goal certification guidance

```markdown
During an automatic goal round, a terminal update_goal action (complete or blocked) is verified by one independent evaluator child before the goal changes. A rejected update returns the evaluator's verified feedback: perform the listed missing work and request the terminal action again. A direct human turn still decides terminal goal updates without evaluation.
```

#### Token effect

Small fixed guidance cost per request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Activation or disposal may invalidate reuse from this prompt section.

### Evaluator child request and terminal-claim outcome

#### What the model sees

Each evaluator child sees one fresh package-rendered prompt with the objective, the goal round and cap, the claimed terminal action, and, for a blocked claim, the reported blocking condition; it sees no parent conversation and is told not to modify the workspace. The parent model never sees the evaluator child's messages: an accepted certification leaves the ordinary `update_goal` result untouched, and a rejection substitutes one `update_goal` tool result carrying the verdict's `confirmed`, `missing`, and `reasons`, or the failure detail.

#### Token effect

Every certified terminal claim pays for one fresh evaluator child context. The verdict's lists and reasons re-enter the parent only as the text of the rejection result; an accepted certification adds no parent tokens.

#### KV Cache effect

Each evaluator child has an independent request cache. An accepted certification appends nothing to the parent request; a rejection appends one tool result after the reusable parent prefix.

## Known Limitations and Deferred Work

- **Same-kind evaluation by default** — the evaluator is a fresh child of the same model unless `evaluatorModel` overrides it; independence comes from the fresh context, the untrusted-claim instruction, and read-only workspace verification, not from cross-family review. A cross-family evaluator is blocked on external providers reporting structured-output support, not on this policy.
- **A verdict is model judgment, not mechanical proof** — the evaluator is told to verify against the workspace, but nothing forces it to run checks beyond its own discretion, and a confidently wrong verdict remains authoritative.
- **One evaluation per claim** — a failed or disagreeing evaluation rejects that claim once; the round continues and the model may request the terminal action again, but there is no automatic re-evaluation and no retry policy for an unavailable or broken provider.
- **Automatic goal rounds only** — a terminal action recorded on a direct human turn is never evaluated, so a human-directed completion or blockage keeps the caller's authority unchecked.
- **Blocking still obeys `tool-goal`** — an agreeing `blocked` verdict does not bypass `tool-goal`'s own admitted-round threshold for a repeated blocker; the evaluator certifies the claim, not the threshold.
- **Certification costs one child per terminal claim** — every terminal claim inside an automatic round starts one additional fresh child alongside the round's own work, with no token, price, or wall-time budget of its own.
