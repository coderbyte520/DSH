/**
 * Durable audit vocabulary and configuration surface for verifiable-reward
 * scoring: the `reward/check` session event plus the check and forbidden
 * pattern specs a deployment may configure.
 * @module @vreal/dsh-verifiable-reward
 */

import type { CallId } from '@vreal/dsh-llm'

/** Environment outcome classes a shell command may be scored as. */
export type RewardCheckKind = 'build' | 'test' | 'run'

/** The scoring class and weight of the check that matched one command. */
export interface RewardCheckHit {
  readonly name: string
  readonly kind: RewardCheckKind
  readonly weight: number
}

/** One forbidden-pattern match found while scoring a call. */
export interface RewardForbiddenHit {
  readonly name: string
  readonly penalty: number
  readonly scope: 'command' | 'stdout' | 'stderr'
}

/** Availability flags for one output stream; the full text never enters the event. */
export interface RewardStreamFlags {
  readonly truncated: boolean
  readonly spillPath?: string
}

/**
 * Audit record of one mechanically scored shell outcome. Log-only: the event
 * feeds no fold or projection, and the model never sees it, so the event
 * carries `ignorable: true` for readers that do not know the type.
 */
export interface RewardCheckMeta {
  readonly kind: 'reward/check'
  readonly version: 1
  /** The scored call's execution identity. */
  readonly callId: CallId
  /** Root model-requested call owning the scored execution. */
  readonly rootCallId: CallId
  /** The tool the plugin observed (`bash`, `pwsh`, or a configured name). */
  readonly tool: string
  /** The executed command string. */
  readonly command: string
  /** The first configured check whose command pattern matched. */
  readonly check: RewardCheckHit
  /** Foreground exit code, or `null` for signal kills and error results. */
  readonly exitCode: number | null
  /** Whether the tool result itself failed (`isError: true`). */
  readonly isError: boolean
  /** Whether the sandbox reported the command as denied. */
  readonly sandboxDenied: boolean
  /** Whether count-based test scoring succeeded. */
  readonly parsed: boolean
  /** Extracted passed count, present only when `parsed` is `true`. */
  readonly passed?: number
  /** Extracted failed count, present only when `parsed` is `true`. */
  readonly failed?: number
  /** Every forbidden pattern matched by this call. */
  readonly forbiddenHits: readonly RewardForbiddenHit[]
  /** Final mechanical score in `[0, 1]` after penalty subtraction and clamping. */
  readonly score: number
  /** stdout availability flags, omitted on error results. */
  readonly stdout?: RewardStreamFlags
  /** stderr availability flags, omitted on error results. */
  readonly stderr?: RewardStreamFlags
}

declare module '@vreal/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One mechanically computed environment score over a shell tool outcome.
     * Purely informational: no fold consumes it and losing it cannot change
     * session reconstruction.
     */
    'reward/check': RewardCheckMeta
  }
}

/** Deployment-configured scoring rule for one class of commands. */
export interface CheckSpec {
  /** Unique label recorded in the audit event. */
  readonly name: string
  /** How the outcome is scored. */
  readonly kind: RewardCheckKind
  /** RegExp source matched against the command string. */
  readonly commandPattern: string
  /** Optional RegExp source extracting the passed count from stdout (test kind only); empty keeps the default extraction. */
  readonly passedPattern?: string
  /** Optional RegExp source extracting the failed count from stdout (test kind only); empty keeps the default extraction. */
  readonly failedPattern?: string
  /** Relative weight inside round aggregation (default `1`). */
  readonly weight?: number
}

/** Deployment-configured penalty applied when a pattern matches a scored call. */
export interface ForbiddenSpec {
  /** Unique label recorded in the audit event. */
  readonly name: string
  /** RegExp source matched against the configured scope. */
  readonly pattern: string
  /** Score subtracted on a hit before clamping (default `1`). */
  readonly penalty?: number
  /** Where the pattern is tested (default `any`). */
  readonly scope?: 'command' | 'stdout' | 'stderr' | 'any'
}

/** A `CheckSpec` with every pattern compiled, ready for scoring. */
export interface CompiledCheck {
  readonly name: string
  readonly kind: RewardCheckKind
  readonly command: RegExp
  readonly passed: RegExp | undefined
  readonly failed: RegExp | undefined
  readonly weight: number
}

/** A `ForbiddenSpec` with its pattern compiled, ready for scanning. */
export interface CompiledForbidden {
  readonly name: string
  readonly pattern: RegExp
  readonly penalty: number
  readonly scope: 'command' | 'stdout' | 'stderr' | 'any'
}

/** The mechanically computed parts of one scored foreground outcome. */
export interface RewardScoreOutcome {
  readonly exitCode: number | null
  readonly sandboxDenied: boolean
  readonly parsed: boolean
  readonly passed?: number
  readonly failed?: number
  readonly forbiddenHits: readonly RewardForbiddenHit[]
  readonly score: number
  readonly stdout: RewardStreamFlags
  readonly stderr: RewardStreamFlags
}
