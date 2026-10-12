/**
 * The verifiable-reward PLUGIN: a `tools/result` observer that scores shell
 * tool outcomes mechanically and appends one ignorable `reward/check` audit
 * event per matched call. Scoring is deterministic — command matching, exit
 * codes, test-count extraction, and penalty patterns only; no model
 * participates. The events are the verifiable-reward signal a downstream
 * sampling or export plugin folds into training datasets.
 *
 * `tools/result` is the pipeline's observe-only stage: it runs after the
 * outcome is final, and the registry contains a failing observer behind a
 * warning. Scoring therefore cannot change what the model sees, what the
 * durable tool log records, or whether a call reports success. A call scores
 * only when its command matches a configured check; unmatched commands,
 * background starts, and calls without an owning agent produce no event.
 * @module @vreal/dsh-verifiable-reward
 */

import type { Context } from '@vreal/cordis'
import z from '@vreal/schemastery'
import type { ToolExecutionResult } from '@vreal/dsh-tools'
import { defaultChecks, defaultForbiddenPatterns, defaultObservedTools } from './defaults.ts'
import { compileChecks, compileForbidden, matchCheck, scanForbidden, scoreShellResult } from './scoring.ts'
import type { CheckSpec, CompiledCheck, CompiledForbidden, ForbiddenSpec, RewardCheckMeta } from './types.ts'

export type {
  CheckSpec,
  CompiledCheck,
  CompiledForbidden,
  ForbiddenSpec,
  RewardCheckHit,
  RewardCheckKind,
  RewardCheckMeta,
  RewardForbiddenHit,
  RewardScoreOutcome,
  RewardStreamFlags,
} from './types.ts'
export {
  clampScore,
  combineScores,
  compileChecks,
  compileForbidden,
  computeFinalScore,
  computeRoundScore,
  extractTestCounts,
  matchCheck,
  scanForbidden,
  scoreShellResult,
} from './scoring.ts'
export { defaultChecks, defaultForbiddenPatterns, defaultObservedTools } from './defaults.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'verifiable-reward'
/** Require the tool registry: `tools/post-execute` is the only extension point used. */
export const inject = ['tools']

/**
 * Deployment policy for mechanical shell-outcome scoring. The exported schema
 * is the validation boundary: pattern sources are checked here only for being
 * non-empty, and their compilation is checked when the plugin loads.
 */
export interface Config {
  /** Whether shell outcomes are scored (default `true`). */
  readonly enabled?: boolean
  /** Tool names observed (default `['bash', 'pwsh']`). */
  readonly tools?: string[]
  /** Ordered first-match-wins command scoring rules (default `defaultChecks`). */
  readonly checks?: CheckSpec[]
  /** Penalty patterns scanned over scored calls (default `defaultForbiddenPatterns`). */
  readonly forbiddenPatterns?: ForbiddenSpec[]
}

/** Runtime configuration schema for the verifiable-reward plugin. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  tools: z.array(z.string().min(1)).default([...defaultObservedTools]),
  checks: z.array(z.object({
    name: z.string().min(1),
    kind: z.union(['build', 'test', 'run'] as const),
    commandPattern: z.string().min(1),
    passedPattern: z.string().default(''),
    failedPattern: z.string().default(''),
    weight: z.number().min(0).default(1),
  })).default(defaultChecks),
  forbiddenPatterns: z.array(z.object({
    name: z.string().min(1),
    pattern: z.string().min(1),
    penalty: z.number().min(0).default(1),
    scope: z.union(['command', 'stdout', 'stderr', 'any'] as const).default('any'),
  })).default(defaultForbiddenPatterns),
})

interface ResolvedConfig {
  readonly enabled: boolean
  readonly tools: ReadonlySet<string>
  readonly checks: readonly CompiledCheck[]
  readonly forbidden: readonly CompiledForbidden[]
}

/** Resolve the deployment policy against the bundled defaults. */
function resolveConfig(config: Config): ResolvedConfig {
  return {
    enabled: config.enabled ?? true,
    tools: new Set(config.tools ?? defaultObservedTools),
    checks: compileChecks(config.checks ?? defaultChecks),
    forbidden: compileForbidden(config.forbiddenPatterns ?? defaultForbiddenPatterns),
  }
}

/** Read the command string from already-validated tool arguments. */
function readCommand(arguments_: unknown): string | undefined {
  if (typeof arguments_ !== 'object' || arguments_ === null) return undefined
  const command = (arguments_ as { command?: unknown }).command
  return typeof command === 'string' && command.length > 0 ? command : undefined
}

/**
 * Assemble the audit event for a call whose tool result failed before the
 * command could be scored: no output exists, so only command-scoped forbidden
 * patterns can hit and the score is zero.
 */
function errorMeta(
  tool: string,
  command: string,
  check: CompiledCheck,
  forbidden: readonly CompiledForbidden[],
  callId: RewardCheckMeta['callId'],
  rootCallId: RewardCheckMeta['rootCallId'],
): RewardCheckMeta {
  return {
    kind: 'reward/check',
    version: 1,
    callId,
    rootCallId,
    tool,
    command,
    check: { name: check.name, kind: check.kind, weight: check.weight },
    exitCode: null,
    isError: true,
    sandboxDenied: false,
    parsed: false,
    forbiddenHits: scanForbidden(command, undefined, undefined, forbidden),
    score: 0,
  }
}

/**
 * Register the scoring observer over every observed tool's final outcome.
 * @param ctx - context owning the tool registry this observer reads.
 * @param config - deployment policy; omit for the bundled defaults.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return

  ctx.on('tools/result', (exec, result) => {
    if (exec.agent === undefined || !resolved.tools.has(exec.name)) return
    const command = readCommand(exec.arguments)
    if (command === undefined) return
    const check = matchCheck(command, resolved.checks)
    if (check === undefined) return

    const meta = result.isError
      ? errorMeta(exec.name, command, check, resolved.forbidden, exec.callId, exec.rootCallId)
      : buildScoredMeta(exec.name, command, check, resolved, result, exec.callId, exec.rootCallId)
    if (meta !== undefined) exec.agent.session.append('reward/check', meta, { ignorable: true })
  })
}

/** Assemble the audit event for a settled successful result, or `undefined` for unscored shapes. */
function buildScoredMeta(
  tool: string,
  command: string,
  check: CompiledCheck,
  resolved: ResolvedConfig,
  result: ToolExecutionResult & { isError: false },
  callId: RewardCheckMeta['callId'],
  rootCallId: RewardCheckMeta['rootCallId'],
): RewardCheckMeta | undefined {
  const outcome = scoreShellResult(command, check, resolved.forbidden, result.value)
  if (outcome === undefined) return undefined
  return {
    kind: 'reward/check',
    version: 1,
    callId,
    rootCallId,
    tool,
    command,
    check: { name: check.name, kind: check.kind, weight: check.weight },
    exitCode: outcome.exitCode,
    isError: false,
    sandboxDenied: outcome.sandboxDenied,
    parsed: outcome.parsed,
    ...outcome.passed === undefined ? {} : { passed: outcome.passed },
    ...outcome.failed === undefined ? {} : { failed: outcome.failed },
    forbiddenHits: outcome.forbiddenHits,
    score: outcome.score,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
  }
}
