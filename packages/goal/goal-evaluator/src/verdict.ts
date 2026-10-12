/**
 * The evaluator child's structured verdict: schema, decoded type, and semantic
 * validation, shared by the one-shot child request and the consumer boundary.
 * @module @vreal/dsh-goal-evaluator
 */

import type { ObjectJsonSchema } from '@vreal/dsh-tools'

/** The evaluator's structured conclusion over one terminal goal-round claim. */
export interface GoalEvaluatorVerdict {
  readonly verdict: 'complete' | 'continue' | 'blocked'
  readonly confirmed: readonly string[]
  readonly missing: readonly string[]
  readonly reasons: string
}

/** Object-rooted JSON Schema the evaluator child must satisfy. */
export const goalEvaluatorVerdictSchema: ObjectJsonSchema = {
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

function normalizedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

function normalizedList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(normalizedText)
}

/**
 * Defensively decode one evaluator verdict across the provider boundary.
 * @param value - the child's structured output, already schema-validated by the provider.
 * @returns the validated verdict.
 * @throws when the value is not an object, a field fails normalization, or the
 *   verdict semantics are invalid (`complete` needs confirmed evidence and no
 *   missing entries; `continue` needs at least one missing entry).
 */
export function readGoalEvaluatorVerdict(value: unknown): GoalEvaluatorVerdict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('goal evaluator returned no structured verdict')
  }
  const record = value as Record<string, unknown>
  if (!normalizedText(record['reasons'])) {
    throw new Error('goal evaluator reasons must be non-empty and normalized')
  }
  if (!normalizedList(record['confirmed']) || !normalizedList(record['missing'])) {
    throw new Error('goal evaluator confirmed and missing must contain only non-empty normalized strings')
  }
  const verdict = record['verdict']
  if (verdict !== 'complete' && verdict !== 'continue' && verdict !== 'blocked') {
    throw new Error('goal evaluator verdict is invalid')
  }
  if (verdict === 'complete' && (record['missing'].length !== 0 || record['confirmed'].length === 0)) {
    throw new Error('a complete goal-evaluator verdict needs confirmed evidence and no missing entries')
  }
  if (verdict === 'continue' && record['missing'].length === 0) {
    throw new Error('a continuing goal-evaluator verdict needs at least one missing entry')
  }
  return {
    verdict,
    confirmed: record['confirmed'],
    missing: record['missing'],
    reasons: record['reasons'],
  }
}
