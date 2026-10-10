# Agent Note: Evaluated Ralph loop with an independent evaluator

Status: implemented

English | [中文](2026-10-09-evaluated-ralph-independent-evaluator-loop.zh.md)

## Problem

The fresh-agent Ralph tool iterates toward one objective, but completion and blockage are worker self-declarations: the same child that performed the work decides the loop is finished, and the tool envelope says so. The same gap also applied to the same-session goal round driver, whose certification later shipped as the separate [goal-round completion certification](2026-10-10-goal-round-completion-certification.md) consumer. Before wiring evaluator certification into goal lifecycle — which touches durable state, revisions, and continuation policy — the harness needs evidence that an independent evaluator actually improves loop outcomes, at a cost and risk that a removable PoC can establish.

External-agent providers (`claude-code`, `codex`) report no start-time capabilities, so they cannot return a structured verdict today; they are also dormant Profile Bundles in shipped compositions. Any evaluator PoC that wants structured output must run over an in-process provider.

## Decision

Add `@vreal/dsh-tool-ralph-evaluated` as a separate Consumer package under `packages/workflow/`, cloned from the `ralph` tool's fixed-workflow pattern. It registers `ralph_evaluated({ objective, maxRounds? })` and changes neither `dsh-tool-ralph`, the goal domain, nor the agent loop. The PoC answers one question: does moving termination authority from the worker to a second fresh child make fresh-agent iteration trustworthy enough to build on?

### One round is one worker plus one evaluator

Each round starts one fresh worker child and then one fresh evaluator child through the same configured `subagentProvider`, which must support structured output and report `inheritsParentContext: false`. The worker report drops the `status` field entirely — it carries only `summary`, `evidence`, `remaining`, and `blocker` — so the worker structurally cannot declare the loop finished. The evaluator receives the objective, the prior handoff, and the current worker report, is told not to trust the report, and must verify evidence claims against the workspace read-only. Its verdict — `complete | continue | blocked` with `confirmed`, `missing`, and `reasons` — is the only round-status authority; the fixed script validates its semantics (complete needs confirmed evidence and no missing entries; continue needs concrete missing work) and re-checks the merged worker-plus-verdict handoff against `maxHandoffChars`, doubling validation at the consumer boundary as in `ralph`.

### Doubling the child budget, not the round budget

`maxRounds` still bounds worker rounds. Because each round consumes two children, the tool passes `2 * maxRounds` as `WorkflowStartRequest.maxTotalAgents`, keeping the fixed two-child pattern inside the engine's runaway-child backstop. The engine's deployment ceiling (default 1000) therefore halves the reachable round count at its shipped value; deployments that raise the ceiling must account for the doubling.

### Evaluator model override, not evaluator provider routing

The workflow runtime's `agent()` already accepts a `model` option, and `resolveChildAgentOptions` lets a child request override the parent model without catalog validation. The plugin exposes `evaluatorModel` config (default empty): non-empty routes every evaluator child to that model while workers keep the loop's model. Empty means same-model evaluation — the independence guarantees are the fresh context, the status-free worker report, and workspace-only verification. Provider-per-phase routing and external-agent evaluators are deliberately not part of this PoC; the former needs new engine plumbing and the latter is blocked on external providers lacking structured output.

### Failure semantics

A worker or evaluator child that settles unsuccessfully maps to `round-failed` with the failed round and the last successful handoff; an evaluator failure is exactly as terminal as a worker failure because the evaluator is the only status authority. Malformed or semantically invalid structured output, and an oversized merged handoff, fail the workflow rather than being truncated. The parent-facing renderer names the evaluator as the deciding authority (`The evaluator confirmed completion…`), never presenting worker output as certification.

## Testing

Unit tests clone the `ralph` suite's StubEngine/StubProvider boundary: config and call-cap resolution including `evaluatorModel` normalization, the doubled `maxTotalAgents` start request, provider capability rejection, evaluator-model args carriage, all four terminal statuses, malformed and oversized terminal values, abort bridging, disposal, render intent, prompt lifecycle, and namespace-plugin shape. Real-stack integration drives the fixed script through the worker-thread engine and spawn provider: a two-round run where the round-one worker claims `remaining: []` and the evaluator overturns it with concrete missing work, proving the missing items reach only the round-two worker; a configured `evaluatorModel` override observed in the evaluator request's model while workers keep the loop model; blocked, budget-limited, malformed-verdict, invalid-continuation, invalid-completion, oversized-handoff, round-two child failure, and cancellation-to-quiescence scenarios.

## Alternatives considered

- **Wire the evaluator into the goal round driver first** — rejected for the PoC because goal lifecycle adds durable state, revisions, and continuation-suppression policy to any change; a removable workflow tool isolates the hypothesis.
- **Keep the worker `status` field and let the evaluator veto** — rejected because a status field invites worker-decided completion with an approval rubric, which is harder to reason about than a report/verdict split and reintroduces self-declaration by another name.
- **A standalone `evaluate` tool called manually by the parent** — rejected because it leaves the loop unclosed: the model can still accept worker self-declaration and skip the evaluation, so the PoC would not measure closed-loop behavior.
- **Route evaluators through the `claude-code` provider for cross-family verification** — rejected because that provider reports no start-time capabilities, so a structured verdict would require a text-parsing layer outside the validated structured-output runtime; cross-family evaluation stays deferred on the provider capability, not on this tool.
- **Retry a failed evaluator within the round** — rejected because retry policy interacts with budgets and cancellation; the PoC keeps failure terminal and records the gap as deferred work.

## Consequences

- Fresh-agent iteration gains a variant whose completion, continuation, and blockage are decided by a child that never performs the work, moving the deferred "evaluator-backed certification" from concept to a running, testable policy.
- The worker/evaluator report split gives the next iteration (goal-domain certification) a concrete verdict vocabulary (`confirmed`, `missing`, `reasons`) to reuse.
- Two children per round doubles per-round cost and halves the engine-ceiling-reachable round count; deployments pay it only in compositions that enable the tool.
- `ralph` remains the worker-declared loop and is unchanged; the two tools differ only in whether termination authority is delegated, which keeps the comparison measurable.
- Same-model evaluation is the default, so the independence on trial is contextual (fresh context, untrusted-report instruction, workspace-only verification) rather than architectural; deployments with a second model can add cross-model independence by configuration alone.

## Known limitations and deferred work

- The evaluator is a same-kind child unless `evaluatorModel` overrides it; cross-family verification waits on external providers supporting structured output.
- Evaluator verdicts remain model judgment, not mechanically certified proof: the evaluator is told to verify against the workspace, but nothing forces it to run checks beyond its own discretion.
- Foreground only, workspace-only cross-round memory, no within-round fan-out, no retry, and no token/price/time budgets — all inherited from the `ralph` pattern and equally deferred.
- Goal-domain integration shipped outside this PoC: [`@vreal/dsh-goal-evaluator`](../../../../packages/goal/goal-evaluator/README.md) certifies terminal `update_goal` claims over the goal tools and reuses this PoC's verdict vocabulary.
