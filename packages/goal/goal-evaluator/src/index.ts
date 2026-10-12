/**
 * Certified goal-round completion: a `tools/execute` policy consumer that runs
 * one fresh independent evaluator child over every goal-round-terminal
 * `update_goal` claim before the mutation is allowed through. The evaluator's
 * structured verdict alone authorizes the terminal update; a `continue`
 * verdict or a mismatch rejects the call with the evaluator's missing work,
 * keeping the goal active for the round driver's next round.
 * @module @vreal/dsh-goal-evaluator
 */

import type { Context } from '@vreal/cordis'
import z from '@vreal/schemastery'
import type { Agent } from '@vreal/dsh-agent'
import type { GoalView } from '@vreal/dsh-goal/types'
import type { SubagentProvider } from '@vreal/dsh-subagent'
import type { ToolExecutionResult } from '@vreal/dsh-tools'
import type { GoalEvaluationMeta } from './types.ts'
import type { GoalEvaluatorVerdict } from './verdict.ts'
import { goalEvaluatorVerdictSchema, readGoalEvaluatorVerdict } from './verdict.ts'
import { renderGoalEvaluatorPrompt } from './prompt.ts'
import { peekTerminalAuthority } from '@vreal/dsh-tool-goal'

export const name = 'goal-evaluator'
export const inject = ['agents', 'goals', 'subagents', 'systemPrompt', 'tools']

/** Deployment policy for goal-round terminal-claim certification. */
export interface Config {
  /** Whether terminal goal-round claims are certified (default `true`). */
  enabled?: boolean
  /** Fresh structured-output provider used for every evaluator child (default `spawn`). */
  subagentProvider?: string
  /** Optional model override for the evaluator child. Empty = the parent's model. */
  evaluatorModel?: string
}

/** Schemastery configuration for the goal evaluator. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  subagentProvider: z.string().default('spawn'),
  evaluatorModel: z.string().default(''),
})

interface ResolvedConfig {
  readonly enabled: boolean
  readonly subagentProvider: string
  readonly evaluatorModel: string
}

/** Validate defaults even when a caller invokes apply() without Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const enabled = config.enabled ?? true
  const subagentProvider = config.subagentProvider ?? 'spawn'
  const evaluatorModel = config.evaluatorModel ?? ''
  if (subagentProvider.length === 0 || subagentProvider !== subagentProvider.trim()) {
    throw new TypeError('subagentProvider must be a non-empty normalized string')
  }
  if (typeof evaluatorModel !== 'string' || evaluatorModel !== evaluatorModel.trim()) {
    throw new TypeError('evaluatorModel must be a normalized string (empty means no override)')
  }
  return { enabled, subagentProvider, evaluatorModel }
}

/** Require the configured route to mean a genuinely fresh structured child. */
function requireFreshProvider(ctx: Context, providerName: string): SubagentProvider {
  const provider = ctx.subagents.getProvider(providerName)
  if (provider === undefined) {
    throw new Error(`goal evaluator subagent provider "${providerName}" is not registered`)
  }
  if (!provider.capabilities.outputSchema) {
    throw new Error(`goal evaluator subagent provider "${providerName}" does not support structured output`)
  }
  if (provider.inheritsParentContext) {
    throw new Error(
      `goal evaluator subagent provider "${providerName}" inherits parent context; the evaluator requires a fresh provider`,
    )
  }
  return provider
}

interface UpdateGoalArguments {
  readonly action?: unknown
  readonly blocked_reason?: unknown
}

/** Narrow the model's already-logged `update_goal` arguments to the terminal-action fields. */
function readUpdateGoalArguments(value: unknown): UpdateGoalArguments {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value
}

/** Structured rejection substituted for the terminal update when certification does not pass. */
function rejectionResult(message: string, code: string, detail: string): ToolExecutionResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}\n${detail}` }],
    isError: true,
    error: { message, info: { name: 'GoalEvaluatorRejected', code } },
  }
}

/** Render the evaluator's verified feedback into the rejection detail. */
function verdictDetail(verdict: GoalEvaluatorVerdict): string {
  return JSON.stringify({
    verdict: verdict.verdict,
    confirmed: verdict.confirmed,
    missing: verdict.missing,
    reasons: verdict.reasons,
  }, null, 2)
}

/** Append one ignorable audit event naming the evaluator as the deciding authority. */
function appendEvaluation(agent: Agent, meta: GoalEvaluationMeta): void {
  agent.session.append('goal/evaluation', meta, { ignorable: true })
}

/** One evaluator run's terminal outcome: a valid verdict or the failure detail. */
type EvaluationOutcome =
  | { readonly verdict: GoalEvaluatorVerdict; readonly failure?: undefined }
  | { readonly verdict?: undefined; readonly failure: string }

/**
 * Run the one-shot evaluator child to settlement and decode its verdict.
 * @param ctx - Context carrying the subagent runtime and provider registry.
 * @param resolved - the plugin's materialized configuration.
 * @param goal - the goal revision whose round produced the claim.
 * @param requestedAction - the terminal action being certified.
 * @param blockedReason - the model-reported blocking condition, when supplied.
 * @param parent - the calling agent, also the evaluator child's parent.
 * @param signal - the tool execution's cancellation signal.
 * @returns the validated verdict, or the failure that prevented one.
 */
async function evaluateChild(
  ctx: Context,
  resolved: ResolvedConfig,
  goal: GoalView,
  requestedAction: 'complete' | 'blocked',
  blockedReason: string | undefined,
  parent: Agent,
  signal: AbortSignal,
): Promise<EvaluationOutcome> {
  const evaluatorModel = resolved.evaluatorModel === '' ? undefined : resolved.evaluatorModel
  try {
    void requireFreshProvider(ctx, resolved.subagentProvider)
    const run = await ctx.subagents.start(resolved.subagentProvider, {
      label: `Goal evaluator round ${goal.roundsStarted}`,
      prompt: renderGoalEvaluatorPrompt(goal, requestedAction, blockedReason),
      parent,
      signal,
      outputSchema: goalEvaluatorVerdictSchema,
      ...evaluatorModel === undefined ? {} : { agentOptions: { model: evaluatorModel } },
    })
    let settled
    try {
      settled = await run.result
    } finally {
      await run.dispose()
    }
    if (settled.stopReason !== 'completed' || settled.structured === undefined) {
      return {
        failure: settled.stopReason === 'aborted'
          ? 'the evaluator child was cancelled'
          : `the evaluator child did not produce a structured verdict (stop reason: ${settled.stopReason})`,
      }
    }
    return { verdict: readGoalEvaluatorVerdict(settled.structured) }
  } catch (error: unknown) {
    return { failure: error instanceof Error ? error.message : String(error) }
  }
}

const CERTIFICATION_PROMPT =
  'During an automatic goal round, a terminal update_goal action (complete or blocked) is verified by one '
  + 'independent evaluator child before the goal changes. A rejected update returns the evaluator\'s '
  + 'verified feedback: perform the listed missing work and request the terminal action again. A direct '
  + 'human turn still decides terminal goal updates without evaluation.'

/** Register the certification wrapper over terminal goal-round `update_goal` claims. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return
  ctx.systemPrompt.section({ name: 'goal-evaluator', order: 118, text: CERTIFICATION_PROMPT })

  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    if (exec.name !== 'update_goal' || exec.agent === undefined) return next()
    const args = readUpdateGoalArguments(exec.arguments)
    if (args.action !== 'complete' && args.action !== 'blocked') return next()
    const authority = peekTerminalAuthority(ctx, exec)
    if (authority?.kind !== 'goal-round') return next()
    const goal = authority.goal
    const requestedAction = args.action
    const outcome = await evaluateChild(
      ctx,
      resolved,
      goal,
      requestedAction,
      requestedAction === 'blocked' && typeof args.blocked_reason === 'string' ? args.blocked_reason : undefined,
      exec.agent,
      exec.signal,
    )
    const evaluatorModel = resolved.evaluatorModel === '' ? undefined : resolved.evaluatorModel
    const { verdict } = outcome

    appendEvaluation(exec.agent, {
      kind: 'goal/evaluation',
      version: 1,
      goalId: goal.id,
      revision: goal.revision,
      round: goal.roundsStarted,
      requestedAction,
      verdict: verdict?.verdict ?? 'failed',
      confirmed: verdict?.confirmed ?? [],
      missing: verdict?.missing ?? [],
      reasons: verdict === undefined ? outcome.failure : verdict.reasons,
      provider: resolved.subagentProvider,
      ...evaluatorModel === undefined ? {} : { evaluatorModel },
    })

    if (verdict === undefined) {
      return rejectionResult(
        `the goal evaluator failed to certify the ${requestedAction} update; the goal stays active`,
        'GOAL_EVALUATOR_FAILED',
        outcome.failure,
      )
    }
    if (verdict.verdict !== requestedAction) {
      return rejectionResult(
        `the goal evaluator returned "${verdict.verdict}" for the requested ${requestedAction}; the goal stays active`,
        'GOAL_EVALUATOR_REJECTED',
        verdictDetail(verdict),
      )
    }
    return next()
  })
}
