/**
 * Deterministic scoring core: config compilation, command-to-check matching,
 * test-count extraction, penalty scanning, and the aggregation helpers a
 * downstream sampling or export plugin reuses. Every function is pure and
 * mechanical — no model participates in any score this module produces.
 * @module @vreal/dsh-verifiable-reward
 */

import type {
  CompiledCheck,
  CompiledForbidden,
  CheckSpec,
  ForbiddenSpec,
  RewardCheckMeta,
  RewardForbiddenHit,
  RewardScoreOutcome,
  RewardStreamFlags,
} from './types.ts'

/** Default passed-count extraction, matching vitest, jest, and pytest summaries. */
const DEFAULT_PASSED = /(\d+)\s+passed/gi
/** Default failed-count extraction, matching vitest, jest, and pytest summaries. */
const DEFAULT_FAILED = /(\d+)\s+failed/gi
/** Go test success marker (package line). */
const GO_OK = /^ok\s/m
/** Go test failure marker (package line). */
const GO_FAIL = /^FAIL/m

/**
 * Clamp a score into `[0, 1]`.
 * @param value - raw score.
 * @returns the score inside the closed unit interval; a non-numeric score becomes `0`.
 */
export function clampScore(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Compile one RegExp source, naming the offending field when it is empty or
 * does not parse. Command patterns stay non-global because `test()` advances
 * `lastIndex` on a global pattern; count-extraction patterns need `g` because
 * they are consumed by `matchAll()`.
 */
function compileRegex(source: string, flags: string, label: string): RegExp {
  if (source.length === 0) throw new TypeError(`verifiable-reward: ${label} must be a non-empty RegExp source`)
  try {
    return new RegExp(source, flags)
  } catch (error: unknown) {
    throw new TypeError(`verifiable-reward: ${label} is not a valid RegExp: ${String(error)}`)
  }
}

/** Compile an optional count-extraction override; empty keeps the default extraction. */
function compileCountOverride(source: string | undefined, label: string): RegExp | undefined {
  if (source === undefined || source.length === 0) return undefined
  return compileRegex(source, 'g', label)
}

/**
 * Compile every configured check. Configuration types, kinds, and ranges are
 * the Config schema's job; this step compiles the pattern sources the schema
 * cannot express and materializes the documented per-check defaults.
 * @param specs - configured checks in evaluation order.
 * @returns the compiled checks, in the same order.
 * @throws when a command, passed-count, or failed-count pattern source is empty
 *   or is not a valid RegExp.
 */
export function compileChecks(specs: readonly CheckSpec[]): readonly CompiledCheck[] {
  return specs.map((spec, index) => {
    const label = `checks[${index}] (${spec.name})`
    return {
      name: spec.name,
      kind: spec.kind,
      command: compileRegex(spec.commandPattern, '', `${label} commandPattern`),
      passed: compileCountOverride(spec.passedPattern, `${label} passedPattern`),
      failed: compileCountOverride(spec.failedPattern, `${label} failedPattern`),
      weight: spec.weight ?? 1,
    }
  })
}

/**
 * Compile every configured forbidden pattern, failing fast on a pattern source
 * that is empty or does not parse.
 * @param specs - configured forbidden patterns.
 * @returns the compiled patterns, in the same order.
 * @throws when a pattern source is empty or is not a valid RegExp.
 */
export function compileForbidden(specs: readonly ForbiddenSpec[]): readonly CompiledForbidden[] {
  return specs.map((spec, index) => {
    const label = `forbiddenPatterns[${index}] (${spec.name})`
    return {
      name: spec.name,
      pattern: compileRegex(spec.pattern, '', `${label} pattern`),
      penalty: spec.penalty ?? 1,
      scope: spec.scope ?? 'any',
    }
  })
}

/**
 * Select the first configured check whose command pattern matches.
 * @param command - executed command string.
 * @param checks - compiled checks in evaluation order.
 * @returns the matching check, or `undefined` when none match.
 */
export function matchCheck(command: string, checks: readonly CompiledCheck[]): CompiledCheck | undefined {
  for (const check of checks) {
    if (check.command.test(command)) return check
  }
  return undefined
}

/**
 * Largest captured count over all matches, or `undefined` when none match. A
 * configured pattern without a capture group counts each of its matches as
 * zero.
 */
function maxCaptured(text: string, regex: RegExp): number | undefined {
  let max: number | undefined
  for (const match of text.matchAll(regex)) {
    const parsed = Number.parseInt(match[1] ?? '0', 10)
    if (max === undefined || parsed > max) max = parsed
  }
  return max
}

/**
 * Extract passed/failed counts from test output. Configured patterns take
 * precedence; the Go `ok`/`FAIL` package markers apply only with the default
 * patterns. Returns `undefined` when the output carries no readable counts.
 * @param stdout - captured stdout text.
 * @param check - the matched check, whose optional patterns override the defaults.
 * @returns the extracted counts, or `undefined` when the output carries none.
 */
export function extractTestCounts(stdout: string, check: CompiledCheck): { passed: number; failed: number } | undefined {
  const passed = maxCaptured(stdout, check.passed ?? DEFAULT_PASSED)
  const failed = maxCaptured(stdout, check.failed ?? DEFAULT_FAILED)
  if (passed !== undefined || failed !== undefined) {
    const total = (passed ?? 0) + (failed ?? 0)
    if (total > 0) return { passed: passed ?? 0, failed: failed ?? 0 }
  }
  if (check.passed !== undefined || check.failed !== undefined) return undefined
  if (GO_FAIL.test(stdout)) return { passed: 0, failed: 1 }
  if (GO_OK.test(stdout)) return { passed: 1, failed: 0 }
  return undefined
}

/** Read one output stream into its availability flags and parseable text. */
function readStream(value: unknown): { flags: RewardStreamFlags; text: string } {
  if (typeof value !== 'object' || value === null) return { flags: { truncated: false }, text: '' }
  const stream = value as { text?: unknown; truncated?: unknown; spillPath?: unknown }
  return {
    flags: {
      truncated: stream.truncated === true,
      ...typeof stream.spillPath === 'string' ? { spillPath: stream.spillPath } : {},
    },
    text: typeof stream.text === 'string' ? stream.text : '',
  }
}

/** Whether the sandbox reported the command as denied. */
function readSandboxDenied(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { denied?: unknown }).denied === true
}

/**
 * Scan one scored call for forbidden patterns. `stdout`/`stderr` are `undefined`
 * when no output is available (error results), so output-scoped patterns cannot
 * match there; each configured pattern yields at most one hit naming the first
 * scope it matched.
 * @param command - executed command string.
 * @param stdout - captured stdout text, or `undefined` when the result carries none.
 * @param stderr - captured stderr text, or `undefined` when the result carries none.
 * @param forbidden - compiled forbidden patterns.
 * @returns one hit per matching pattern, in configuration order.
 */
export function scanForbidden(
  command: string,
  stdout: string | undefined,
  stderr: string | undefined,
  forbidden: readonly CompiledForbidden[],
): readonly RewardForbiddenHit[] {
  const hits: RewardForbiddenHit[] = []
  for (const spec of forbidden) {
    if (spec.scope === 'command' || spec.scope === 'any') {
      if (spec.pattern.test(command)) {
        hits.push({ name: spec.name, penalty: spec.penalty, scope: 'command' })
        continue
      }
    }
    if ((spec.scope === 'stdout' || spec.scope === 'any') && stdout !== undefined) {
      if (spec.pattern.test(stdout)) {
        hits.push({ name: spec.name, penalty: spec.penalty, scope: 'stdout' })
        continue
      }
    }
    if ((spec.scope === 'stderr' || spec.scope === 'any') && stderr !== undefined) {
      if (spec.pattern.test(stderr)) {
        hits.push({ name: spec.name, penalty: spec.penalty, scope: 'stderr' })
      }
    }
  }
  return hits
}

/**
 * Mechanically score one foreground shell outcome. Returns `undefined` when
 * the canonical value is not a foreground result (background starts, foreign
 * shapes), leaving the call unscored.
 * @param command - executed command string.
 * @param check - the matched check.
 * @param forbidden - compiled forbidden patterns.
 * @param value - canonical tool result value.
 * @returns the mechanical outcome, or `undefined` for an unscored value shape.
 */
export function scoreShellResult(
  command: string,
  check: CompiledCheck,
  forbidden: readonly CompiledForbidden[],
  value: unknown,
): RewardScoreOutcome | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const shell = value as { kind?: unknown; exitCode?: unknown; stdout?: unknown; stderr?: unknown; sandbox?: unknown }
  if (shell.kind !== 'foreground') return undefined
  const exitCode = typeof shell.exitCode === 'number' ? shell.exitCode : null
  const sandboxDenied = readSandboxDenied(shell.sandbox)
  const stdout = readStream(shell.stdout)
  const stderr = readStream(shell.stderr)

  const fallback = exitCode === 0 && !sandboxDenied ? 1 : 0
  let base = fallback
  let parsed = false
  let passed: number | undefined
  let failed: number | undefined
  if (check.kind === 'test' && !sandboxDenied && !stdout.flags.truncated && stdout.flags.spillPath === undefined) {
    const counts = extractTestCounts(stdout.text, check)
    if (counts !== undefined) {
      parsed = true
      passed = counts.passed
      failed = counts.failed
      base = counts.passed / (counts.passed + counts.failed)
    }
  }

  const forbiddenHits = scanForbidden(command, stdout.text, stderr.text, forbidden)
  const penalty = forbiddenHits.reduce((sum, hit) => sum + hit.penalty, 0)
  return {
    exitCode,
    sandboxDenied,
    parsed,
    ...passed === undefined ? {} : { passed },
    ...failed === undefined ? {} : { failed },
    forbiddenHits,
    score: clampScore(base - penalty),
    stdout: stdout.flags,
    stderr: stderr.flags,
  }
}

/**
 * Weighted mean score over one round's checks. Every event contributes its
 * matched check's weight; returns `undefined` when no event scores the round.
 * @param events - the round's scored audit records.
 * @returns the weighted mean, or `undefined` for an empty round or all-zero weights.
 */
export function computeRoundScore(events: readonly RewardCheckMeta[]): number | undefined {
  if (events.length === 0) return undefined
  let weighted = 0
  let totalWeight = 0
  for (const event of events) {
    weighted += event.score * event.check.weight
    totalWeight += event.check.weight
  }
  return totalWeight === 0 ? undefined : weighted / totalWeight
}

/**
 * Mean over per-round scores.
 * @param roundScores - one score per scored round.
 * @returns the mean, or `undefined` when no round scored.
 */
export function computeFinalScore(roundScores: readonly number[]): number | undefined {
  if (roundScores.length === 0) return undefined
  let total = 0
  for (const score of roundScores) total += score
  return total / roundScores.length
}

/**
 * Blend one verifiable score with one model-judged score:
 * `alpha * verifiable + (1 - alpha) * model`, clamped to `[0, 1]`. A missing
 * side yields the other side unchanged; both missing yields `undefined`.
 * @param verifiable - mechanical score, or `undefined` when no check matched.
 * @param model - model-judged score, or `undefined` when no judge ran.
 * @param alpha - weight of the verifiable side inside `[0, 1]`.
 * @returns the blended score, or `undefined` when neither side scored.
 */
export function combineScores(
  verifiable: number | undefined,
  model: number | undefined,
  alpha: number,
): number | undefined {
  if (verifiable === undefined) return model === undefined ? undefined : clampScore(model)
  if (model === undefined) return clampScore(verifiable)
  return clampScore(alpha * verifiable + (1 - alpha) * model)
}
