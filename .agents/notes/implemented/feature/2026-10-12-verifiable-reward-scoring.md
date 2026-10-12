# Agent Note: Mechanical verifiable-reward scoring of shell outcomes

Status: implemented

English | [中文](2026-10-12-verifiable-reward-scoring.zh.md)

## Problem

The harness's termination authorities are model judgments. The [evaluated Ralph tool](../../../../packages/workflow/tool-ralph-evaluated/README.md) and the [goal-round certifier](../../../../packages/goal/goal-evaluator/README.md) read the workspace and return a verdict, and that verdict is only as trustworthy as the evaluator that produced it. Nothing turns the observable facts of a run — the command that executed, its exit code, the tests that passed or failed — into a durable score that a dataset builder can filter on, compare across rollouts, or replay. Tool results carry those facts, but only as the model-facing transcript of one call.

## Decision

Ship [`@vreal/dsh-verifiable-reward`](../../../../packages/reward/verifiable-reward/README.md): one observe-only consumer that scores shell outcomes mechanically and appends an ignorable `reward/check` session event per matched call. The score is a pure function of the command string and the canonical tool result — ordered first-match-wins command checks, exit code, sandbox denial, test-count extraction, and forbidden-pattern penalties, clamped to `[0, 1]`. No model participates, so the same log always scores the same.

### The observe-only stage of the tool pipeline

The observer attaches to `tools/result`, which runs after the outcome is final and contains a failing listener behind a warning. `tools/post-execute` can replace or block a result, and a throw there becomes an `isError` result, so an audit-only scorer mounted there would gain the power to fail a call it is supposed to describe. Both stages are scope-filtered by `exec.agent` and receive Code Mode sub-dispatches, which is what a rollout needs: the scored call is the inner shell call that carried the real command.

Scoring never changes a result, so mounting the plugin cannot change what the model sees, what the durable tool log records, or whether a call reports success.

### Configuration belongs to the schema; compilation belongs to the compiler

The `Config` schema validates types, kinds, and ranges at load, so an empty tool name, unknown check kind, negative weight, or unknown scope fails where every other plugin's misconfiguration fails. The scoring compiler adds only what the schema cannot express — a pattern source that is empty or does not compile — and names the offending check or forbidden pattern in the failure.

Count-extraction overrides compile with the `g` flag because `matchAll()` requires it; command patterns stay non-global because `test()` advances `lastIndex` on a global pattern and would then skip matches. A pattern without a capture group counts each match as zero rather than throwing inside the observer.

### A dedicated ignorable event

The record is its own `SessionEventMap` member appended with `ignorable: true`. Session events are typed and versioned per member, so adding reward fields to an existing tool event would force every reader to know the new field; a dedicated member that readers may skip keeps unknown readers working, and losing the record cannot change session reconstruction because nothing folds it. The event carries structured facts only — call identity, tool, command, matched check, exit code, parsed counts, forbidden hits, score, and stream availability flags — never the captured output text.

### How one call scores

A scored call starts at `1` when the foreground process exited zero without a sandbox denial, and `0` otherwise. A `test` check whose stdout is neither truncated nor spilled replaces that base with `passed / (passed + failed)`, using the default `N passed` / `N failed` summaries, a configured override, or the Go `ok`/`FAIL` package markers when no override is configured; every other kind skips parsing. Each matched forbidden pattern subtracts its penalty before the clamp. An error result scores `0` with no counts, because no output exists: only command-scoped forbidden patterns can match there.

## Testing

Package tests drive the real `dsh-tools` registry over a scripted shell body, so the observer sees exactly what production sees: a matched call records one event and leaves the tool result byte-identical, a disabled plugin, an unobserved tool name, an unmatched command, a missing command argument, a non-foreground canonical value, and a call with no owning agent record nothing, and an error result still records the command-scoped forbidden hit it can scan. One case invokes `apply` directly to prove the bundled defaults resolve without Loader normalization, one covers a deployment's own checks, weights, scopes, and penalties, and one disposes the plugin to show the observer is an effect.

The scoring core is covered as pure functions: each default-extraction and override branch, the Go markers, truncated, spilled, denied, and signal-killed results, penalty clamping, weighted round aggregation, and every blend of the verifiable and model sides. Coverage is per-file 100%, the repository gate.

## Alternatives considered

- **Score inside `tool-bash` and `tool-pwsh`** — rejected: one scoring policy would have two owners and drift across POSIX and Windows tools, and every deployment that mounts a shell tool would carry scoring it may not want.
- **Score in `tools/post-execute`** — rejected: a listener failure there becomes a failed call, giving an informational scorer an error channel it must not have.
- **Derive the score inside the goal evaluator** — rejected: that consumer certifies one terminal claim with model judgment, and the reward record has a different subject, cadence, and lifetime.
- **Add reward fields to `tool/result`** — rejected: the session event map is typed per member, so a new field would make the record required knowledge for every reader.
- **Fold the score into a session projection** — rejected: a derived score that affects reconstruction would make a lost record a correctness problem; `ignorable: true` states the opposite.
- **Let a model contribute the base score** — deferred rather than rejected: `combineScores` implements `alpha * verifiable + (1 - alpha) * model`, and nothing produces a model score today.

## Consequences

- Every composition that mounts the base bundle now appends one ignorable event per matched shell call, so session logs grow with test and build activity; a reader that does not know the event type skips it.
- Projection, request derivation, and the model are untouched, so a deployment that removes the row restores the previous log exactly.
- The verifiable half of the training reward now exists in the log; the sampling, filtering, and dataset-export half does not, and the aggregation helpers are exported for it.

## Known limitations and deferred work

- **RegExp matching only** — checks test the command string as text, so a script, alias, or gate wrapper that runs tests without matching a configured pattern stays unscored.
- **Counts come from printed summaries** — truncated or spilled stdout skips test parsing, and a runner whose summary format differs needs a configured count pattern.
- **No consumer** — nothing folds these records into a dataset or a training reward yet; the aggregation helpers have no caller.
