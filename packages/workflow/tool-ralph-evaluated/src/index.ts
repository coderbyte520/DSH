/**
 * Model-facing foreground evaluated Ralph loop over the workflow and subagent
 * seams. A fixed script starts one fresh structured-output worker plus one
 * fresh structured-output evaluator per round; the worker reports progress and
 * evidence, and the independent evaluator alone decides completion,
 * continuation, or blockage. Only the immutable objective and the previous
 * evaluator-verified handoff cross rounds.
 * @module @vreal/dsh-tool-ralph-evaluated
 */

import type { Context } from '@vreal/cordis'
import z from '@vreal/schemastery'
import type { ContentBlock } from '@vreal/dsh-llm'
import type { JsonValue } from '@vreal/dsh-session'
import type { SubagentProvider } from '@vreal/dsh-subagent'
import { defineTool } from '@vreal/dsh-tools'
import type { ToolCallView, ToolResultView } from '@vreal/dsh-tools'
import type { WorkflowResult, WorkflowRun } from '@vreal/dsh-workflow'
// Declaration merge only: makes ctx.systemPrompt visible for section registration.
import type {} from '@vreal/dsh-system-prompt'

export const name = 'tool-ralph-evaluated'
export const inject = ['tools', 'workflowEngine', 'subagents', 'systemPrompt']

/** Deployment policy for the fixed evaluated Ralph workflow. */
export interface Config {
  /** Fresh structured-output provider used for every worker and evaluator (default `spawn`). */
  subagentProvider?: string
  /** Default and deployment ceiling for one call's round count (default 256). */
  maxRounds?: number
  /** Maximum serialized characters in one evaluator-verified handoff (default 16384). */
  maxHandoffChars?: number
  /** Maximum characters in a successful parent-facing terminal text (default 16384). */
  maxResultChars?: number
  /** Optional model override for the evaluator child. Empty = use the loop's default model. */
  evaluatorModel?: string
}

/** Schemastery configuration for the evaluated Ralph tool. */
export const Config: z<Config> = z.object({
  subagentProvider: z.string().default('spawn'),
  maxRounds: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(256),
  maxHandoffChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  maxResultChars: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(16_384),
  evaluatorModel: z.string().default(''),
})

interface ResolvedConfig {
  readonly subagentProvider: string
  readonly maxRounds: number
  readonly maxHandoffChars: number
  readonly maxResultChars: number
  readonly evaluatorModel: string
}

type EvaluatedRalphVerdict = 'continue' | 'complete' | 'blocked'

/** The only state that crosses rounds or reaches the parent result. */
interface EvaluatedRalphRoundSummary {
  readonly workerSummary: string
  readonly workerEvidence: string[]
  readonly workerRemaining: string[]
  readonly workerBlocker: string
  readonly evaluatorConfirmed: string[]
  readonly evaluatorMissing: string[]
  readonly evaluatorReasons: string
}

type EvaluatedRalphRunStatus = 'complete' | 'blocked' | 'budget-limited'

interface EvaluatedRalphRunResult {
  readonly status: EvaluatedRalphRunStatus
  readonly roundsStarted: number
  readonly report: EvaluatedRalphRoundSummary
}

interface EvaluatedRalphRoundFailure {
  readonly status: 'round-failed'
  readonly roundsStarted: number
  readonly lastReport?: EvaluatedRalphRoundSummary
}

type EvaluatedRalphTerminalResult = EvaluatedRalphRunResult | EvaluatedRalphRoundFailure

interface EvaluatedRalphCallArgs {
  objective: string
  maxRounds?: number
}

const RALPH_EVALUATED_META = {
  name: 'ralph-evaluated-loop',
  description: 'Iterate toward one objective with a fresh worker and an independent fresh evaluator per round.',
  phases: [{ title: 'Evaluated Ralph rounds', detail: 'One fresh worker and one independent fresh evaluator per round.' }],
}

/**
 * Fixed, deployment-owned orchestration. The model supplies data only; it
 * cannot alter the loop, provider route, evaluator route, schemas, or handoff
 * validation. The worker never decides termination; the evaluator verdict is
 * the only round-status authority.
 */
const RALPH_EVALUATED_SCRIPT = String.raw`
const workerReportSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'string' } },
    blocker: { type: 'string' },
  },
  required: ['summary', 'evidence', 'remaining', 'blocker'],
  additionalProperties: false,
}

const verdictSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['continue', 'complete', 'blocked'] },
    confirmed: { type: 'array', items: { type: 'string' } },
    missing: { type: 'array', items: { type: 'string' } },
    reasons: { type: 'string' },
  },
  required: ['verdict', 'confirmed', 'missing', 'reasons'],
  additionalProperties: false,
}

function normalizedText(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function normalizedList(value) {
  return Array.isArray(value) && value.every(normalizedText)
}

function normalizedString(value) {
  return typeof value === 'string' && value === value.trim()
}

function validateWorkerReport(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Evaluated Ralph worker returned no structured report')
  }
  if (!normalizedText(report.summary)) {
    throw new Error('Evaluated Ralph worker summary must be non-empty and normalized')
  }
  if (!normalizedList(report.evidence) || !normalizedList(report.remaining)) {
    throw new Error('Evaluated Ralph worker evidence and remaining must contain only non-empty normalized strings')
  }
  if (!normalizedString(report.blocker)) {
    throw new Error('Evaluated Ralph worker blocker must be a normalized string')
  }
  return report
}

function validateVerdict(verdict) {
  if (verdict === null || typeof verdict !== 'object' || Array.isArray(verdict)) {
    throw new Error('Evaluated Ralph evaluator returned no structured verdict')
  }
  if (!normalizedText(verdict.reasons)) {
    throw new Error('Evaluated Ralph evaluator reasons must be non-empty and normalized')
  }
  if (!normalizedList(verdict.confirmed) || !normalizedList(verdict.missing)) {
    throw new Error('Evaluated Ralph evaluator confirmed and missing must contain only non-empty normalized strings')
  }
  switch (verdict.verdict) {
    case 'complete':
      if (verdict.missing.length !== 0 || verdict.confirmed.length === 0) {
        throw new Error('a complete evaluated Ralph verdict needs confirmed evidence and no missing entries')
      }
      break
    case 'continue':
      if (verdict.missing.length === 0) {
        throw new Error('a continuing evaluated Ralph verdict needs at least one missing entry')
      }
      break
    case 'blocked':
      break
    default:
      throw new Error('Evaluated Ralph evaluator verdict is invalid')
  }
  return verdict
}

function buildHandoff(workerReport, verdict) {
  const handoff = {
    workerSummary: workerReport.summary,
    workerEvidence: workerReport.evidence,
    workerRemaining: workerReport.remaining,
    workerBlocker: workerReport.blocker,
    evaluatorConfirmed: verdict.confirmed,
    evaluatorMissing: verdict.missing,
    evaluatorReasons: verdict.reasons,
  }
  const serialized = JSON.stringify(handoff)
  if (serialized.length > args.maxHandoffChars) {
    throw new Error('Evaluated Ralph handoff exceeds maxHandoffChars (' + serialized.length + ' > ' + args.maxHandoffChars + ')')
  }
  return handoff
}

let previous
phase('Evaluated Ralph rounds')
for (let round = 1; round <= args.maxRounds; round += 1) {
  const prior = previous === undefined ? '(none — this is the first round)' : JSON.stringify(previous)
  const workerPrompt = [
    'You are one fresh worker in a foreground evaluated Ralph loop. You receive no parent conversation and no prior child session. Do not call the ralph_evaluated tool: this round already is its worker.',
    'Immutable objective:\n' + args.objective,
    'Evaluated Ralph round: ' + round + ' of ' + args.maxRounds + '.',
    'The shared workspace and its current working tree are the long-term memory and source of truth. Inspect them before acting, preserve existing work, perform concrete in-scope work, and verify what you change. Treat the previous evaluator-verified handoff only as a bounded starting point; confirm it against the workspace.',
    'Previous evaluator-verified handoff:\n' + prior,
    'You do not decide whether the objective is complete or blocked; an independent evaluator will judge your report against the workspace. Return one report with exact normalized strings: a summary of your progress, the evidence you can verify in the workspace, the remaining work, and a concrete external blocker (empty unless something outside the workspace prevents progress).',
  ].join('\n\n')
  const rawWorkerReport = await agent(workerPrompt, {
    label: 'Evaluated Ralph worker ' + round,
    phase: 'Evaluated Ralph rounds',
    schema: workerReportSchema,
  })
  if (rawWorkerReport === null) {
    return { status: 'round-failed', roundsStarted: round, lastReport: previous ?? null }
  }
  const workerReport = validateWorkerReport(rawWorkerReport)

  const evaluatorPrompt = [
    'You are the independent evaluator in a foreground evaluated Ralph loop. You receive no parent conversation and no prior child session. Do not call the ralph_evaluated tool and do not modify the workspace.',
    'Immutable objective:\n' + args.objective,
    'Evaluated Ralph round: ' + round + ' of ' + args.maxRounds + '.',
    'The shared workspace is the source of truth. Do not trust the worker report: verify every claim against the workspace yourself, using read-only inspection only. Do not perform the remaining work; only judge it.',
    'Previous evaluator-verified handoff:\n' + prior,
    'Worker report for this round:\n' + JSON.stringify(workerReport),
    'Return one verdict with exact normalized strings. verdict complete only when you have verified evidence proving the objective is satisfied, with confirmed listing that verified evidence and no missing entries; verdict continue with concrete actionable missing work; verdict blocked only when an impediment outside the workspace prevents any further progress. reasons must explain your verdict.',
  ].join('\n\n')
  const evaluatorOptions = {
    label: 'Evaluated Ralph evaluator ' + round,
    phase: 'Evaluated Ralph rounds',
    schema: verdictSchema,
  }
  if (args.evaluatorModel !== undefined && args.evaluatorModel !== '') {
    evaluatorOptions.model = args.evaluatorModel
  }
  const rawVerdict = await agent(evaluatorPrompt, evaluatorOptions)
  if (rawVerdict === null) {
    return { status: 'round-failed', roundsStarted: round, lastReport: previous ?? null }
  }
  const verdict = validateVerdict(rawVerdict)
  const handoff = buildHandoff(workerReport, verdict)

  if (verdict.verdict === 'complete') return { status: 'complete', roundsStarted: round, report: handoff }
  if (verdict.verdict === 'blocked') return { status: 'blocked', roundsStarted: round, report: handoff }
  previous = handoff
}
return { status: 'budget-limited', roundsStarted: args.maxRounds, report: previous }
`

const DESCRIPTION = 'Run a foreground evaluated fresh-agent Ralph loop toward one immutable objective. '
  + 'Use only when the direct human explicitly asks for an evaluated Ralph loop or fresh-agent iteration with '
  + 'independent verification. Each round opens a fresh worker child and a fresh evaluator child, neither '
  + 'seeded with parent conversation; the worker reports progress and evidence, and the independent evaluator '
  + 'verifies that evidence against the shared workspace and alone decides whether the objective is complete, '
  + 'the loop should continue, or it is blocked. The call returns when the evaluator issues its verdict, or at '
  + 'the round limit. Ordinary long-running same-session work belongs to goal tools.'

/** Validate defaults even when a caller invokes apply() without Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const subagentProvider = config.subagentProvider ?? 'spawn'
  const maxRounds = config.maxRounds ?? 256
  const maxHandoffChars = config.maxHandoffChars ?? 16_384
  const maxResultChars = config.maxResultChars ?? 16_384
  const evaluatorModel = config.evaluatorModel ?? ''
  if (subagentProvider.length === 0 || subagentProvider !== subagentProvider.trim()) {
    throw new TypeError('subagentProvider must be a non-empty normalized string')
  }
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
    throw new TypeError('maxRounds must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxHandoffChars) || maxHandoffChars < 1) {
    throw new TypeError('maxHandoffChars must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxResultChars) || maxResultChars < 1) {
    throw new TypeError('maxResultChars must be a positive safe integer')
  }
  if (typeof evaluatorModel !== 'string' || evaluatorModel !== evaluatorModel.trim()) {
    throw new TypeError('evaluatorModel must be a normalized string (empty means no override)')
  }
  return { subagentProvider, maxRounds, maxHandoffChars, maxResultChars, evaluatorModel }
}

/** Resolve one model-selected cap against the deployment ceiling. */
function resolveMaxRounds(requested: number | undefined, ceiling: number): number {
  const value = requested ?? ceiling
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Evaluated Ralph maxRounds must be a positive safe integer')
  }
  if (value > ceiling) {
    throw new TypeError(`Evaluated Ralph maxRounds ${value} exceeds the deployment ceiling ${ceiling}`)
  }
  return value
}

/** Require the configured route to mean a genuinely fresh structured child. */
function requireFreshProvider(ctx: Context, name: string): SubagentProvider {
  const provider = ctx.subagents.getProvider(name)
  if (provider === undefined) {
    throw new Error(`Evaluated Ralph subagent provider "${name}" is not registered`)
  }
  if (!provider.capabilities.outputSchema) {
    throw new Error(`Evaluated Ralph subagent provider "${name}" does not support structured output`)
  }
  if (provider.inheritsParentContext) {
    throw new Error(`Evaluated Ralph subagent provider "${name}" inherits parent context; the loop requires a fresh provider`)
  }
  return provider
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function normalizedList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(normalizedText)
}

function normalizedString(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim()
}

/** Defensively decode the fixed script's evaluator-verified handoff across a provider boundary. */
function readRoundSummary(
  value: unknown,
  expectedVerdict: EvaluatedRalphVerdict,
  maxChars: number,
): EvaluatedRalphRoundSummary {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',')
      !== 'evaluatorConfirmed,evaluatorMissing,evaluatorReasons,workerBlocker,workerEvidence,workerRemaining,workerSummary'
    || !normalizedText(value['workerSummary'])
    || !normalizedList(value['workerEvidence'])
    || !normalizedList(value['workerRemaining'])
    || !normalizedString(value['workerBlocker'])
    || !normalizedList(value['evaluatorConfirmed'])
    || !normalizedList(value['evaluatorMissing'])
    || !normalizedText(value['evaluatorReasons'])) {
    throw new Error('Evaluated Ralph workflow returned a malformed round summary')
  }
  const summary: EvaluatedRalphRoundSummary = {
    workerSummary: value['workerSummary'],
    workerEvidence: value['workerEvidence'],
    workerRemaining: value['workerRemaining'],
    workerBlocker: value['workerBlocker'],
    evaluatorConfirmed: value['evaluatorConfirmed'],
    evaluatorMissing: value['evaluatorMissing'],
    evaluatorReasons: value['evaluatorReasons'],
  }
  if (expectedVerdict === 'complete'
    && (summary.evaluatorMissing.length !== 0 || summary.evaluatorConfirmed.length === 0)) {
    throw new Error('Evaluated Ralph workflow returned an invalid completion summary')
  }
  if (expectedVerdict === 'continue' && summary.evaluatorMissing.length === 0) {
    throw new Error('Evaluated Ralph workflow returned an invalid continuing summary')
  }
  const chars = JSON.stringify(summary).length
  if (chars > maxChars) {
    throw new Error(`Evaluated Ralph workflow returned an oversized handoff (${chars} > ${maxChars})`)
  }
  return summary
}

/** Defensively decode the fixed script's terminal value. */
function readRunResult(
  value: unknown,
  maxRounds: number,
  maxHandoffChars: number,
): EvaluatedRalphTerminalResult {
  if (!isRecord(value)
    || typeof value['roundsStarted'] !== 'number'
    || !Number.isSafeInteger(value['roundsStarted'])
    || value['roundsStarted'] < 1
    || value['roundsStarted'] > maxRounds) {
    throw new Error('Evaluated Ralph workflow returned a malformed terminal result')
  }
  const roundsStarted = value['roundsStarted']
  switch (value['status']) {
    case 'complete':
      if (Object.keys(value).sort().join(',') !== 'report,roundsStarted,status') {
        throw new Error('Evaluated Ralph workflow returned a malformed terminal result')
      }
      return { status: 'complete', roundsStarted, report: readRoundSummary(value['report'], 'complete', maxHandoffChars) }
    case 'blocked':
      if (Object.keys(value).sort().join(',') !== 'report,roundsStarted,status') {
        throw new Error('Evaluated Ralph workflow returned a malformed terminal result')
      }
      return { status: 'blocked', roundsStarted, report: readRoundSummary(value['report'], 'blocked', maxHandoffChars) }
    case 'budget-limited':
      if (Object.keys(value).sort().join(',') !== 'report,roundsStarted,status') {
        throw new Error('Evaluated Ralph workflow returned a malformed terminal result')
      }
      if (roundsStarted !== maxRounds) {
        throw new Error('Evaluated Ralph workflow returned budget-limited before the round limit')
      }
      return { status: 'budget-limited', roundsStarted, report: readRoundSummary(value['report'], 'continue', maxHandoffChars) }
    case 'round-failed': {
      if (Object.keys(value).sort().join(',') !== 'lastReport,roundsStarted,status') {
        throw new Error('Evaluated Ralph workflow returned a malformed terminal result')
      }
      if (roundsStarted === 1) {
        if (value['lastReport'] !== null) {
          throw new Error('Evaluated Ralph workflow returned an invalid first-round failure')
        }
        return { status: 'round-failed', roundsStarted }
      }
      if (value['lastReport'] === null) {
        throw new Error('Evaluated Ralph workflow returned a round failure without its last handoff')
      }
      return {
        status: 'round-failed',
        roundsStarted,
        lastReport: readRoundSummary(value['lastReport'], 'continue', maxHandoffChars),
      }
    }
    default:
      throw new Error('Evaluated Ralph workflow returned an unknown terminal status')
  }
}

/** A non-clean workflow finish is an error, never a partial evaluated Ralph success. */
function stopReasonError(result: WorkflowResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'cancelled':
      return `Evaluated Ralph workflow was cancelled${result.error === undefined ? '' : ` (${result.error})`}`
    case 'error':
      return `Evaluated Ralph workflow failed: ${result.error ?? 'unknown error'}`
    /* v8 ignore start -- WorkflowStopReason is closed; a future variant must fail loud here. */
    default:
      return `Evaluated Ralph workflow ended abnormally (${String(result.stopReason satisfies never)})`
    /* v8 ignore stop */
  }
}

const TRUNCATION_NOTICE = '\n… [truncated]'

/** Bound complete parent-facing text, including its envelope and truncation marker. */
function boundResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= TRUNCATION_NOTICE.length) return TRUNCATION_NOTICE.slice(0, maxChars)
  return `${text.slice(0, maxChars - TRUNCATION_NOTICE.length)}${TRUNCATION_NOTICE}`
}

/** Render the fixed terminal envelope, naming the evaluator as the deciding authority. */
function renderResult(result: EvaluatedRalphRunResult, maxChars: number): string {
  const rounds = `${result.roundsStarted} round${result.roundsStarted === 1 ? '' : 's'}`
  let text: string
  switch (result.status) {
    case 'complete':
      text = `The evaluator confirmed completion after ${rounds}.\nFinal evaluator-verified report:\n${JSON.stringify(result.report, null, 2)}`
      break
    case 'blocked':
      text = `The evaluator declared a blocker after ${rounds}.\nFinal evaluator-verified report:\n${JSON.stringify(result.report, null, 2)}`
      break
    case 'budget-limited':
      text = `The evaluated Ralph loop reached its ${rounds} limit; the evaluator still listed missing work.\nFinal evaluator-verified report:\n${JSON.stringify(result.report, null, 2)}`
      break
  }
  return boundResult(text, maxChars)
}

/** Canonical evaluated Ralph result fields shared by schema inference and rendering. */
const RALPH_EVALUATED_OUTPUT_PROPERTIES = {
  runId: { type: 'string', required: true },
  agentsStarted: { type: 'integer', required: true },
  result: { type: 'json', required: true },
} as const

/** Render an ordinary worker or evaluator failure with the most recent durable handoff. */
function renderRoundFailure(result: EvaluatedRalphRoundFailure, maxChars: number): string {
  const header = `Evaluated Ralph round ${result.roundsStarted} child failed before producing its structured output.`
  const text = result.lastReport === undefined
    ? `${header}\nNo previous handoff was available.`
    : `${header}\nLast successful handoff:\n${JSON.stringify(result.lastReport, null, 2)}`
  return boundResult(text, maxChars)
}

function presentCall(args: EvaluatedRalphCallArgs): ToolCallView {
  return { card: 'generic', title: 'ralph_evaluated', rawInput: args.objective }
}

function presentResult(_args: EvaluatedRalphCallArgs, result: { content: ContentBlock[]; isError: boolean }): ToolResultView {
  void result
  return { card: 'generic' }
}

/** Register the fixed evaluated Ralph tool and its explicit-ask usage policy. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:ralph_evaluated',
    order: 117,
    text: 'Use the ralph_evaluated tool ONLY when the direct human explicitly asks for an evaluated Ralph loop, a Ralph loop with independent verification, or fresh-agent iteration with a verifier. Each round starts a fresh worker child and a fresh evaluator child with no conversation seed; the shared workspace is durable memory. The worker never decides completion: the evaluator verifies the worker evidence against the workspace and alone decides complete, continue, or blocked. Use ralph when worker-declared completion is acceptable, same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.',
  })
  ctx.tools.register(defineTool({
    name: 'ralph_evaluated',
    description: DESCRIPTION,
    parameters: {
      objective: {
        type: 'string',
        required: true,
        description: 'The immutable completion objective for every fresh worker and evaluator round.',
      },
      maxRounds: {
        type: 'number',
        description: 'Optional positive safe-integer round cap, bounded by the deployment ceiling.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: RALPH_EVALUATED_OUTPUT_PROPERTIES,
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderResult(value.result as unknown as EvaluatedRalphRunResult, resolved.maxResultChars),
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('Evaluated Ralph tool requires a calling agent (exec.agent was undefined)')
      }
      const objective = args.objective.trim()
      if (objective.length === 0) throw new Error('Evaluated Ralph objective must be a non-empty string')
      const maxRounds = resolveMaxRounds(args.maxRounds, resolved.maxRounds)
      void requireFreshProvider(ctx, resolved.subagentProvider)
      const evaluatorModel = resolved.evaluatorModel === '' ? undefined : resolved.evaluatorModel

      const run: WorkflowRun = ctx.workflowEngine.start({
        script: RALPH_EVALUATED_SCRIPT,
        meta: RALPH_EVALUATED_META,
        args: { objective, maxRounds, maxHandoffChars: resolved.maxHandoffChars, evaluatorModel },
        subagentProvider: resolved.subagentProvider,
        maxTotalAgents: 2 * maxRounds,
        parent,
        signal: exec.signal,
      })
      const onAbort = (): void => { run.cancel('parent step aborted') }
      exec.signal.addEventListener('abort', onAbort, { once: true })
      if (exec.signal.aborted) run.cancel('parent step aborted')

      try {
        const settled = await run.result
        const error = stopReasonError(settled)
        if (error !== undefined) throw new Error(error)
        const value = readRunResult(settled.value, maxRounds, resolved.maxHandoffChars)
        if (value.status === 'round-failed') throw new Error(renderRoundFailure(value, resolved.maxResultChars))
        return {
          runId: run.id,
          agentsStarted: settled.agentsStarted,
          result: value as unknown as JsonValue,
        }
      } finally {
        exec.signal.removeEventListener('abort', onAbort)
        await run.dispose()
      }
    },
    presentCall,
    presentResult,
  }))
}
