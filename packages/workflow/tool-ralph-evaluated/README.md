# @vreal/dsh-tool-ralph-evaluated

English | [中文](README.zh.md)

The model-facing `ralph_evaluated` tool runs a fixed foreground workflow that gives one immutable objective to a sequence of fresh worker agents, each followed by an independent fresh evaluator agent. The worker reports progress and evidence; the evaluator verifies that evidence against the shared workspace and alone decides whether the objective is complete, the loop should continue, or it is blocked. It demonstrates evaluator-decided completion as an ordinary plugin over [`ctx.workflowEngine`](../workflow/README.md) and [`ctx.subagents`](../../subagent/subagent/README.md): no new loop is added to `agent-loop`, and both the worker-declared [`ralph`](../tool-ralph/README.md) tool and the same-session [goal domain](../../goal/goal/README.md) remain independent. The [Evaluated Ralph Agent Note](../../../.agents/notes/implemented/feature/2026-10-09-evaluated-ralph-independent-evaluator-loop.md) owns the policy and deferred work.

## Contract

`ralph_evaluated({ objective, maxRounds? })` waits for the entire run. The deployment config's `maxRounds` is both the default and a ceiling on a call override. Every round starts one fresh worker child then one fresh evaluator child through `subagentProvider`; that provider must exist, support structured output, and report `inheritsParentContext: false`. The resolved round cap is doubled and carried as `WorkflowStartRequest.maxTotalAgents`, coordinating the two-child pattern with the engine's total-child backstop.

Each worker receives only the immutable objective, its current round and cap, and the previous evaluator-verified handoff. The worker report has no status field: it carries `summary`, `evidence`, `remaining`, and `blocker`, so a worker can never declare the loop finished. Each evaluator receives the objective, the prior handoff, and the current worker report, and is instructed to verify every evidence claim against the workspace read-only rather than trusting the report. The evaluator verdict — `verdict: complete | continue | blocked` with `confirmed`, `missing`, and `reasons` — is the only round-status authority. Status-specific semantics and the serialized `maxHandoffChars` ceiling on the merged worker-plus-verdict handoff are validated inside the fixed workflow and again at the consumer boundary. Invalid, missing, or oversized outputs fail the workflow instead of being truncated or mistaken for cap exhaustion.

The successful terminal tool result is `complete`, `blocked`, or `budget-limited`, with the last evaluator-verified summary and the number of rounds started. The canonical envelope is `{ runId, agentsStarted, result }`; completion and blocker labels in its Native renderer name the evaluator as the deciding authority, not the worker. `maxResultChars` bounds only that rendered text including its truncation marker, without altering the validated summary in the canonical value or the cross-round handoff.

A non-empty `evaluatorModel` config routes every evaluator child to that model while workers keep the loop's model; the empty default means no override. An ordinary worker or evaluator failure produces an error naming the failed round and retaining the last successful handoff when one exists. The loop does not retry that round. Fatal provider-start, transport, worker, or workflow failures remain workflow errors and may settle before the fixed script can return a handoff. Cancellation is also an error; partial output is never success.

## Lifecycle and cancellation

The caller's agent is the parent of every fresh worker and evaluator child, preserving cwd and lineage without copying its conversation. `exec.signal` enters the workflow engine and is also bridged to `run.cancel()` for implementation independence. The tool awaits `run.result` and calls `run.dispose()` in `finally`, so a cancelled parent step waits for the engine's bounded termination and child quiescence before returning.

## Render intent

The pending call is a `generic` card titled `ralph_evaluated`; the immutable objective is its `rawInput`. The result keeps the generic card. Both presentation functions depend only on tool arguments and the settled tool envelope.

## Config

| Key | Default | Meaning |
|---|---|---|
| `subagentProvider` | `spawn` | Fresh structured-output provider used for every worker and evaluator. |
| `maxRounds` | `256` | Default and deployment ceiling for one run's worker rounds. |
| `maxHandoffChars` | `16384` | Maximum serialized characters in one merged evaluator-verified handoff. |
| `maxResultChars` | `16384` | Maximum characters in the complete successful parent result. |
| `evaluatorModel` | `''` | Optional model override for the evaluator child; empty means the loop's model. |

All config values are normalized and validated when the plugin applies, including direct application outside Loader schema normalization. Provider capabilities are resolved immediately before each call because provider registration can change under plugin lifecycle and HMR.

## Model Experience

### System prompt

#### What the model sees

Every parent request in this plugin's registration scope receives the fixed routing guidance below.

##### Evaluated Ralph guidance

```markdown
Use the ralph_evaluated tool ONLY when the direct human explicitly asks for an evaluated Ralph loop, a Ralph loop with independent verification, or fresh-agent iteration with a verifier. Each round starts a fresh worker child and a fresh evaluator child with no conversation seed; the shared workspace is durable memory. The worker never decides completion: the evaluator verifies the worker evidence against the workspace and alone decides complete, continue, or blocked. Use ralph when worker-declared completion is acceptable, same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.
```

#### Token effect

Small fixed guidance cost per request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Activation or disposal may invalidate reuse from this prompt section.

### Tool schema

#### What the model sees

The generated [`ralph_evaluated` schema](../../../docs/tool-catalog.md#vrealdsh-tool-ralph-evaluated) exposes one required `objective` string and one optional `maxRounds` number. Provider choice, evaluator model, handoff size, report and verdict schemas, and orchestration behavior are deployment-owned and absent from the call schema.

#### Token effect

Small fixed schema cost on each request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged.

### Worker and evaluator requests and parent result

#### What the model sees

Each worker sees the standalone fixed worker prompt plus the structured-output capture contract; each evaluator sees the standalone fixed evaluator prompt plus its own capture contract. The parent sees only the original call and one terminal result containing the evaluator-decided status, round count, and pretty-printed evaluator-verified summary; intermediate child messages, worker reports, and verdicts do not enter the parent conversation. A failed child instead yields an error with its round number and, after round one, the last successful handoff.

#### Token effect

Every round pays for two fresh child contexts (worker and evaluator). `maxHandoffChars` bounds the merged cross-round state and `maxResultChars` independently bounds the complete successful parent text; all child work remains outside the parent context.

#### KV Cache effect

Each fresh child has an independent request cache. The parent result appends after the reusable request prefix.

## Known Limitations and Deferred Work

- **The evaluator is a same-kind child unless overridden** — independence comes from the fresh context, the status-free worker report, and workspace-only read-only verification; a stronger cross-family evaluator (for example an external Claude Code or Codex child) is blocked on those providers lacking structured-output support, not on this tool's policy.
- **Foreground only** — there is no job id, background collection, process-resume checkpoint, scheduler, or wall-clock start policy.
- **The workspace is the only cross-round long-term memory** — one bounded merged report is the explicit handoff, and uncommitted conversational reasoning disappears with each child.
- **One round is one worker plus one evaluator** — there is no within-round fan-out, per-phase provider choice beyond the evaluator model override, or fork context.
- **Ordinary child failure is terminal for the run** — the fixed script reports the failed round and last successful handoff but does not retry; a failed evaluator is as terminal as a failed worker.
- **Only round count bounds aggregate effort** — token, price, and elapsed-time budgets are deferred; each round consumes two children, so the engine's total-child ceiling effectively halves the reachable round count at its deployment value.
