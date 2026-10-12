import { describe, expect, it } from 'vitest'
import { CallId } from '@vreal/dsh-llm'
import { defaultChecks, defaultForbiddenPatterns, defaultObservedTools } from '../src/defaults.ts'
import {
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
} from '../src/scoring.ts'
import type { CheckSpec, CompiledCheck, CompiledForbidden, ForbiddenSpec, RewardCheckMeta } from '../src/types.ts'

/** Compile one focused check instead of restating every field at each call site. */
function checkOf(spec: CheckSpec): CompiledCheck {
  const [compiled] = compileChecks([spec])
  if (compiled === undefined) throw new Error('expected one compiled check')
  return compiled
}

/** Compile one focused forbidden pattern. */
function forbiddenOf(spec: ForbiddenSpec): CompiledForbidden {
  const [compiled] = compileForbidden([spec])
  if (compiled === undefined) throw new Error('expected one compiled forbidden pattern')
  return compiled
}

/** Build one audit record for the aggregation helpers. */
function audit(score: number, weight: number): RewardCheckMeta {
  return {
    kind: 'reward/check',
    version: 1,
    callId: CallId('call-1'),
    rootCallId: CallId('call-1'),
    tool: 'bash',
    command: 'pnpm test',
    check: { name: 'package-manager-test', kind: 'test', weight },
    exitCode: 0,
    isError: false,
    sandboxDenied: false,
    parsed: false,
    forbiddenHits: [],
    score,
  }
}

/** One foreground shell canonical value with text-only streams. */
function foreground(
  exitCode: number | undefined,
  stdout: unknown,
  stderr: unknown = { text: '', truncated: false },
  sandbox?: unknown,
): unknown {
  return {
    kind: 'foreground',
    ...exitCode === undefined ? {} : { exitCode },
    stdout,
    stderr,
    ...sandbox === undefined ? {} : { sandbox },
  }
}

describe('bundled defaults', () => {
  it('observes both shell tools and keeps test runners ahead of build commands', () => {
    expect(defaultObservedTools).toEqual(['bash', 'pwsh'])
    expect(defaultChecks.map(check => check.name)).toEqual([
      'go-test',
      'make-test',
      'js-test-runner',
      'package-manager-test',
      'compiler-build',
      'package-manager-build',
      'script-run',
    ])
    expect(defaultForbiddenPatterns.map(pattern => pattern.name)).toEqual([
      'recursive-delete-root',
      'force-push',
      'pipe-to-shell',
    ])
  })
})

describe('clampScore', () => {
  it('clamps, preserves, and zeroes a non-numeric score', () => {
    expect(clampScore(-0.5)).toBe(0)
    expect(clampScore(0.25)).toBe(0.25)
    expect(clampScore(4)).toBe(1)
    expect(clampScore(Number.NaN)).toBe(0)
  })
})

describe('compileChecks', () => {
  it('materializes the documented default weight and leaves overrides unset', () => {
    const check = checkOf({ name: 'unit', kind: 'test', commandPattern: 'vitest' })
    expect(check).toEqual({
      name: 'unit',
      kind: 'test',
      command: /vitest/,
      passed: undefined,
      failed: undefined,
      weight: 1,
    })
    expect(check.command.global).toBe(false)
  })

  it('compiles explicit count overrides as global patterns so matchAll can walk them', () => {
    const check = checkOf({
      name: 'unit',
      kind: 'test',
      commandPattern: 'vitest',
      passedPattern: '(\\d+) ok',
      failedPattern: '(\\d+) bad',
      weight: 2,
    })
    expect(check.weight).toBe(2)
    expect(check.passed?.source).toBe('(\\d+) ok')
    expect(check.passed?.global).toBe(true)
    expect(check.failed?.source).toBe('(\\d+) bad')
  })

  it('treats an empty override as the default extraction', () => {
    const check = checkOf({
      name: 'unit',
      kind: 'test',
      commandPattern: 'vitest',
      passedPattern: '',
      failedPattern: '',
    })
    expect(check.passed).toBeUndefined()
    expect(check.failed).toBeUndefined()
  })

  it('rejects an empty pattern source naming the offending check', () => {
    expect(() => compileChecks([{ name: 'unit', kind: 'test', commandPattern: '' }]))
      .toThrow('checks[0] (unit) commandPattern must be a non-empty RegExp source')
  })

  it('rejects a pattern source that does not compile', () => {
    expect(() => compileChecks([{ name: 'unit', kind: 'test', commandPattern: '[' }]))
      .toThrow('checks[0] (unit) commandPattern is not a valid RegExp: SyntaxError')
  })
})

describe('compileForbidden', () => {
  it('materializes the default penalty and scope', () => {
    const pattern = forbiddenOf({ name: 'force-push', pattern: '--force' })
    expect(pattern).toEqual({ name: 'force-push', pattern: /--force/, penalty: 1, scope: 'any' })
  })

  it('keeps an explicit penalty and scope', () => {
    const pattern = forbiddenOf({ name: 'noisy', pattern: 'boom', penalty: 0.5, scope: 'stderr' })
    expect(pattern.penalty).toBe(0.5)
    expect(pattern.scope).toBe('stderr')
  })

  it('rejects an unusable pattern source', () => {
    expect(() => compileForbidden([{ name: 'empty', pattern: '' }]))
      .toThrow('forbiddenPatterns[0] (empty) pattern must be a non-empty RegExp source')
    expect(() => compileForbidden([{ name: 'broken', pattern: '(' }]))
      .toThrow('forbiddenPatterns[0] (broken) pattern is not a valid RegExp: SyntaxError')
  })
})

describe('matchCheck', () => {
  const checks = compileChecks([
    { name: 'tester', kind: 'test', commandPattern: '\\bpnpm\\b.*\\btest\\b' },
    { name: 'builder', kind: 'build', commandPattern: '\\bpnpm\\b.*\\bbuild\\b' },
  ])

  it('takes the first matching check in configuration order', () => {
    expect(matchCheck('pnpm run test --watch', checks)?.name).toBe('tester')
    expect(matchCheck('pnpm run build', checks)?.name).toBe('builder')
  })

  it('returns undefined when no check matches', () => {
    expect(matchCheck('ls -la', checks)).toBeUndefined()
  })
})

describe('extractTestCounts', () => {
  const testCheck = checkOf({ name: 'unit', kind: 'test', commandPattern: 'vitest' })

  it('reads the default passed and failed summaries', () => {
    expect(extractTestCounts('Tests  3 passed | 1 failed (4)', testCheck))
      .toEqual({ passed: 3, failed: 1 })
  })

  it('keeps the largest count and ignores a later smaller one', () => {
    expect(extractTestCounts('1 passed\n5 passed', testCheck)).toEqual({ passed: 5, failed: 0 })
    expect(extractTestCounts('5 passed\n2 passed', testCheck)).toEqual({ passed: 5, failed: 0 })
  })

  it('defaults a missing side to zero', () => {
    expect(extractTestCounts('2 failed', testCheck)).toEqual({ passed: 0, failed: 2 })
  })

  it('reads the Go package markers when no counts are printed', () => {
    expect(extractTestCounts('ok  \tgithub.com/vreal/dsh\t0.512s', testCheck)).toEqual({ passed: 1, failed: 0 })
    expect(extractTestCounts('FAIL\tgithub.com/vreal/dsh\t0.512s', testCheck)).toEqual({ passed: 0, failed: 1 })
  })

  it('returns undefined for output with no readable result', () => {
    expect(extractTestCounts('', testCheck)).toBeUndefined()
    expect(extractTestCounts('0 passed, 0 failed', testCheck)).toBeUndefined()
  })

  it('counts a configured pattern without a capture group as zero', () => {
    const noGroup = checkOf({ name: 'unit', kind: 'test', commandPattern: 'vitest', passedPattern: 'passed' })
    expect(extractTestCounts('3 passed', noGroup)).toBeUndefined()
  })

  it('does not fall back to the Go markers once a configured pattern misses', () => {
    const override = checkOf({ name: 'unit', kind: 'test', commandPattern: 'vitest', passedPattern: '(\\d+) passing' })
    expect(extractTestCounts('ok\ngithub.com/vreal/dsh', override)).toBeUndefined()
  })
})

describe('scanForbidden', () => {
  it('matches a command-scoped pattern once and stops scanning that pattern', () => {
    const pattern = forbiddenOf({ name: 'wipe', pattern: 'rm -rf /\\s', scope: 'command' })
    expect(scanForbidden('rm -rf / now', undefined, undefined, [pattern]))
      .toEqual([{ name: 'wipe', penalty: 1, scope: 'command' }])
    expect(scanForbidden('ls', undefined, undefined, [pattern])).toEqual([])
  })

  it('cannot match an output-scoped pattern without that stream', () => {
    const pattern = forbiddenOf({ name: 'boom', pattern: 'explode', scope: 'stdout' })
    expect(scanForbidden('ls', undefined, 'explode', [pattern])).toEqual([])
    expect(scanForbidden('ls', 'explode', undefined, [pattern]))
      .toEqual([{ name: 'boom', penalty: 1, scope: 'stdout' }])
  })

  it('matches a stderr-scoped pattern', () => {
    const pattern = forbiddenOf({ name: 'boom', pattern: 'explode', scope: 'stderr' })
    expect(scanForbidden('ls', 'explode', 'explode', [pattern]))
      .toEqual([{ name: 'boom', penalty: 1, scope: 'stderr' }])
  })

  it('names the first scope an any-scoped pattern matched', () => {
    const pattern = forbiddenOf({ name: 'boom', pattern: 'explode' })
    expect(scanForbidden('explode', 'explode', 'explode', [pattern]))
      .toEqual([{ name: 'boom', penalty: 1, scope: 'command' }])
    expect(scanForbidden('ls', 'explode', 'explode', [pattern]))
      .toEqual([{ name: 'boom', penalty: 1, scope: 'stdout' }])
    expect(scanForbidden('ls', 'ls', 'explode', [pattern]))
      .toEqual([{ name: 'boom', penalty: 1, scope: 'stderr' }])
    expect(scanForbidden('ls', 'ls', 'ls', [pattern])).toEqual([])
    expect(scanForbidden('ls', undefined, undefined, [pattern])).toEqual([])
  })
})

describe('scoreShellResult', () => {
  const buildCheck = checkOf({ name: 'build', kind: 'build', commandPattern: 'build' })
  const testCheck = checkOf({ name: 'unit', kind: 'test', commandPattern: 'vitest' })

  it('leaves a non-foreground canonical value unscored', () => {
    expect(scoreShellResult('pnpm test', testCheck, [], null)).toBeUndefined()
    expect(scoreShellResult('pnpm test', testCheck, [], 'nonsense')).toBeUndefined()
    expect(scoreShellResult('pnpm test', testCheck, [], { kind: 'background', jobId: 'job-1' })).toBeUndefined()
  })

  it('scores a clean exit without parsing a build command', () => {
    const outcome = scoreShellResult('pnpm build', buildCheck, [], foreground(0, { text: 'done', truncated: false }))
    expect(outcome).toEqual({
      exitCode: 0,
      sandboxDenied: false,
      parsed: false,
      forbiddenHits: [],
      score: 1,
      stdout: { truncated: false },
      stderr: { truncated: false },
    })
  })

  it('scores a signal kill and a failing exit code as zero', () => {
    expect(scoreShellResult('pnpm build', buildCheck, [], foreground(undefined, 'text'))?.exitCode).toBeNull()
    expect(scoreShellResult('pnpm build', buildCheck, [], foreground(2, null))?.score).toBe(0)
  })

  it('treats a stream object without text as empty output', () => {
    const outcome = scoreShellResult('pnpm build', buildCheck, [], foreground(0, { truncated: false }))
    expect(outcome?.score).toBe(1)
    expect(outcome?.stdout).toEqual({ truncated: false })
  })

  it('scores a sandbox denial as zero even on exit code zero', () => {
    const outcome = scoreShellResult('pnpm build', buildCheck, [], foreground(0, { text: '', truncated: false }, { text: '', truncated: false }, { mode: 'local', denied: true }))
    expect(outcome?.sandboxDenied).toBe(true)
    expect(outcome?.score).toBe(0)
  })

  it('ignores sandbox facts that report no denial', () => {
    expect(scoreShellResult('pnpm build', buildCheck, [], foreground(0, { text: '', truncated: false }, { text: '', truncated: false }, { mode: 'local' }))?.sandboxDenied).toBe(false)
    expect(scoreShellResult('pnpm build', buildCheck, [], foreground(0, { text: '', truncated: false }, { text: '', truncated: false }, 'unconfined'))?.sandboxDenied).toBe(false)
    expect(scoreShellResult('pnpm build', buildCheck, [], foreground(0, { text: '', truncated: false }, { text: '', truncated: false }, null))?.sandboxDenied).toBe(false)
  })

  it('parses passed/failed counts into a ratio', () => {
    const outcome = scoreShellResult('pnpm test', testCheck, [], foreground(1, { text: '3 passed | 1 failed', truncated: false }))
    expect(outcome?.parsed).toBe(true)
    expect(outcome?.passed).toBe(3)
    expect(outcome?.failed).toBe(1)
    expect(outcome?.score).toBe(0.75)
  })

  it('parses a one-sided summary into a perfect or zero ratio', () => {
    const perfect = scoreShellResult('pnpm test', testCheck, [], foreground(0, { text: '2 passed', truncated: false }))
    expect(perfect?.passed).toBe(2)
    expect(perfect?.failed).toBe(0)
    expect(perfect?.score).toBe(1)
  })

  it('keeps the exit-code score when counts are unreadable', () => {
    const outcome = scoreShellResult('pnpm test', testCheck, [], foreground(0, { text: 'no summary here', truncated: false }))
    expect(outcome?.parsed).toBe(false)
    expect(outcome?.passed).toBeUndefined()
    expect(outcome?.failed).toBeUndefined()
    expect(outcome?.score).toBe(1)
  })

  it('never parses a truncated or spilled stdout stream', () => {
    const truncated = scoreShellResult('pnpm test', testCheck, [], foreground(0, { text: '3 passed', truncated: true }))
    expect(truncated?.parsed).toBe(false)
    expect(truncated?.stdout).toEqual({ truncated: true })

    const spilled = scoreShellResult('pnpm test', testCheck, [], foreground(0, { text: '3 passed', truncated: false, spillPath: '/tmp/out' }))
    expect(spilled?.parsed).toBe(false)
    expect(spilled?.stdout).toEqual({ truncated: false, spillPath: '/tmp/out' })
  })

  it('never parses a denied test command', () => {
    const outcome = scoreShellResult('pnpm test', testCheck, [], foreground(0, { text: '9 passed', truncated: false }, { text: '', truncated: false }, { denied: true }))
    expect(outcome?.parsed).toBe(false)
    expect(outcome?.score).toBe(0)
  })

  it('subtracts forbidden penalties and clamps at zero', () => {
    const forbidden = compileForbidden([{ name: 'wipe', pattern: 'rm -rf /\\s', scope: 'command' }])
    const outcome = scoreShellResult('rm -rf / now', buildCheck, forbidden, foreground(0, { text: '', truncated: false }))
    expect(outcome?.forbiddenHits).toEqual([{ name: 'wipe', penalty: 1, scope: 'command' }])
    expect(outcome?.score).toBe(0)

    const heavier = compileForbidden([{ name: 'wipe', pattern: 'rm -rf /\\s', scope: 'command', penalty: 4 }])
    expect(scoreShellResult('rm -rf / now', buildCheck, heavier, foreground(0, { text: '', truncated: false }))?.score).toBe(0)
  })
})

describe('aggregation', () => {
  it('weights round scores by the matched check', () => {
    expect(computeRoundScore([])).toBeUndefined()
    expect(computeRoundScore([audit(1, 0), audit(0, 0)])).toBeUndefined()
    expect(computeRoundScore([audit(1, 1), audit(0, 1)])).toBe(0.5)
    expect(computeRoundScore([audit(1, 3), audit(0, 1)])).toBe(0.75)
  })

  it('means the per-round scores', () => {
    expect(computeFinalScore([])).toBeUndefined()
    expect(computeFinalScore([1, 0])).toBe(0.5)
  })

  it('blends the two reward sides and clamps the result', () => {
    expect(combineScores(undefined, undefined, 0.5)).toBeUndefined()
    expect(combineScores(undefined, 0.4, 0.5)).toBe(0.4)
    expect(combineScores(0.8, undefined, 0.5)).toBe(0.8)
    expect(combineScores(1, 0, 0.25)).toBe(0.25)
    expect(combineScores(2, 2, 0.5)).toBe(1)
  })
})
