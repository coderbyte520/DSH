/**
 * Durable audit vocabulary for the goal-round evaluator policy.
 * @module @vreal/dsh-goal-evaluator
 */

import type { GoalId } from '@vreal/dsh-goal/types'

/** What the independent evaluator concluded about one terminal goal-round claim. */
export type GoalEvaluationVerdict = 'complete' | 'continue' | 'blocked' | 'failed'

/**
 * Audit record of one terminal `update_goal` evaluation. Log-only: the event
 * feeds no fold or projection, and rejection feedback reaches the model
 * through the tool result itself, so the event carries `ignorable: true` for
 * readers that do not know the type.
 */
export interface GoalEvaluationMeta {
  readonly kind: 'goal/evaluation'
  readonly version: 1
  /** The goal whose round produced the terminal claim. */
  readonly goalId: GoalId
  /** The goal revision the claim targeted. */
  readonly revision: number
  /** The admitted goal round that produced the claim. */
  readonly round: number
  /** The terminal action the session's agent requested. */
  readonly requestedAction: 'complete' | 'blocked'
  /** The evaluator's conclusion, or `failed` when no valid verdict was produced. */
  readonly verdict: GoalEvaluationVerdict
  /** Workspace-verified evidence the evaluator confirmed. */
  readonly confirmed: readonly string[]
  /** Concrete unmet objective work the evaluator found. */
  readonly missing: readonly string[]
  /** The evaluator's explanation of its verdict. */
  readonly reasons: string
  /** The subagent provider that ran the evaluator child. */
  readonly provider: string
  /** The evaluator's model override, when one was configured. */
  readonly evaluatorModel?: string
}

declare module '@vreal/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One independent evaluator's audit verdict over a terminal goal-round
     * claim. Purely informational: no fold consumes it and losing it cannot
     * change session reconstruction.
     */
    'goal/evaluation': GoalEvaluationMeta
  }
}
