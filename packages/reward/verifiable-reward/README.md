# @vreal/dsh-verifiable-reward

English | [中文](README.zh.md)

Mechanical reward scoring of shell tool outcomes, recorded as one ignorable `reward/check` session event per matched call. Scoring is deterministic — command matching, exit codes, test-count extraction, and penalty patterns only — and no model participates. The records are the verifiable-reward side of a training reward that a sampling or export plugin folds into datasets.

## Plugin (namespace: `verifiable-reward`)

Mount one row beside the tool registry and the shell tools:

```yaml
- id: verifiable-reward
  name: '@vreal/dsh-verifiable-reward'
```

The observer listens to `tools/result`, the pipeline's observe-only stage: the outcome is already final there, and the registry contains a failing observer behind a warning. Scoring therefore cannot change the model-visible result, the durable tool log, or whether a call reports success.

A call is recorded only when its tool name is observed, its arguments carry a non-empty `command` string, that command matches a configured check, and the result is either an error or a foreground shell value. Background starts (`kind: 'background'`), other tools, and calls with no owning agent append nothing.

## Config

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Score shell outcomes at all. |
| `tools` | `['bash', 'pwsh']` | Tool names observed. |
| `checks` | bundled list | Ordered first-match-wins command rules. |
| `forbiddenPatterns` | bundled list | Penalty patterns scanned over scored calls. |

The `Config` schema validates a deployment's types, kinds, and ranges at load. A pattern source is additionally checked to be non-empty and to compile; that check is the only failure the scoring compiler adds.

| Check field | Meaning |
|---|---|
| `name` | Unique label recorded in the audit event. |
| `kind` | `build`, `test`, or `run`; only `test` parses counts. |
| `commandPattern` | RegExp source tested against the command string. |
| `passedPattern`, `failedPattern` | Optional global RegExp sources extracting counts from stdout; empty keeps the default extraction. |
| `weight` | Relative weight inside round aggregation (default `1`). |

A forbidden pattern carries `name`, a RegExp `pattern`, a `penalty` subtracted on a hit (default `1`), and the `scope` it is tested in — `command`, `stdout`, `stderr`, or `any` (default `any`).

Bundled checks run test runners before build commands, so `make test` never scores as a build. Bundled forbidden patterns cover destructive recursive deletes of root or home, forced pushes, and remote content piped straight into a shell.

## Scoring rules

One scored call starts at `1` when the foreground process exited zero without a sandbox denial, and `0` otherwise. A `test` check whose stdout is neither truncated nor spilled replaces that base with `passed / (passed + failed)`; the default extraction reads `N passed` and `N failed` summaries, falls back to the Go `ok`/`FAIL` package markers when no count pattern is configured, and every other kind skips parsing. Each matched forbidden pattern subtracts its penalty, and the result is clamped to `[0, 1]`.

An error result scores `0` with no counts, because no output exists: only command-scoped forbidden patterns can match there.

## Audit event and aggregation

Each record is the `reward/check` session event: call identity, tool, command, the matched check, exit code, parsed counts, forbidden hits, the score, and availability flags for stdout and stderr. Output text never enters the event; a spilled or truncated stream records `{ truncated, spillPath? }` instead. The event is appended with `ignorable: true` because nothing folds it — losing it cannot change session reconstruction.

`computeRoundScore`, `computeFinalScore`, and `combineScores(verifiable, model, alpha)` aggregate the records for a consumer: the first two take weighted and plain means, and `combineScores` implements `alpha * verifiable + (1 - alpha) * model`, yielding the side that exists when only one does.

## Model Experience

None, as the observer registers no prompt, tool, or context and appends only an ignorable audit record.

#### KV Cache effect

None; the observer adds nothing to the request prefix.

## Known Limitations and Deferred Work

- **RegExp matching only** — checks test the command string as text; a script, alias, or gate wrapper that runs tests without matching a configured pattern is unscored.
- **Counts come from printed summaries** — truncated or spilled stdout skips test parsing, and a runner whose summary format differs needs a configured `passedPattern`/`failedPattern`; the Go markers apply only while no count pattern is configured.
- **No consumer yet** — nothing folds these records into a dataset or a training reward; the aggregation helpers exist for the sampling and export plugin that will.
