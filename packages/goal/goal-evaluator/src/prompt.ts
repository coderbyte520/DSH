/**
 * Fresh evaluator prompt for one terminal goal-round claim.
 * @module @vreal/dsh-goal-evaluator
 */

import type { ContentBlock } from '@vreal/dsh-llm'
import type { GoalView } from '@vreal/dsh-goal'

/**
 * Render the complete evaluator instruction. The evaluator receives no parent
 * conversation, so the objective and the claimed terminal action are the only
 * session facts it sees; the workspace is its source of truth.
 * @param goal - the exact goal revision whose round produced the claim.
 * @param requestedAction - the terminal action the session's agent requested.
 * @param blockedReason - the model-reported blocking condition, present only
 *   with `requestedAction: 'blocked'`.
 * @returns a fresh one-block prompt for the one-shot evaluator child.
 */
export function renderGoalEvaluatorPrompt(
  goal: GoalView,
  requestedAction: 'complete' | 'blocked',
  blockedReason?: string,
): ContentBlock[] {
  const claim = requestedAction === 'complete'
    ? 'The session\'s agent claims the objective is complete.'
    : `The session's agent claims the objective is blocked.\nReported blocking condition:\n${
      JSON.stringify(blockedReason ?? '')}`
  return [{
    type: 'text',
    text: 'You are the independent evaluator of one goal-round terminal claim. You receive no parent '
      + 'conversation and no prior child session. Do not modify the workspace.\n\n'
      + `Objective:\n${JSON.stringify(goal.objective)}\n\n`
      + `Goal round: ${goal.roundsStarted} of ${goal.maxGoalRounds}.\n\n`
      + 'The shared workspace is the source of truth. Do not trust the claim below: verify the objective '
      + 'against the workspace yourself, using read-only inspection only. Do not perform the remaining '
      + 'work; only judge it.\n\n'
      + claim
      + '\n\nReturn one verdict with exact normalized strings. verdict complete only when you have '
      + 'verified evidence proving the objective is satisfied, with confirmed listing that verified '
      + 'evidence and no missing entries; verdict continue with concrete actionable missing work; '
      + 'verdict blocked only when an impediment outside the workspace prevents any further progress. '
      + 'reasons must explain your verdict.',
  }]
}
