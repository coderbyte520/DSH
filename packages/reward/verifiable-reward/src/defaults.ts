/**
 * Bundled default check and forbidden-pattern specs. A deployment replaces the
 * whole list through config; the defaults are deliberately conservative and
 * ordered so the first matching check wins.
 *
 * Every bundled entry carries the fields the Config schema declares defaults
 * for, so one list is both the schema's `.default()` value and a complete
 * deployment-visible `CheckSpec` / `ForbiddenSpec`.
 * @module @vreal/dsh-verifiable-reward
 */

import type { CheckSpec, ForbiddenSpec, RewardCheckKind } from './types.ts'

/** Tool names observed by default; `pwsh` keeps Windows deployments scored. */
export const defaultObservedTools: string[] = ['bash', 'pwsh']

/** Build one bundled check with the schema's per-field defaults materialized. */
function check(name: string, kind: RewardCheckKind, commandPattern: string): Required<CheckSpec> {
  return { name, kind, commandPattern, passedPattern: '', failedPattern: '', weight: 1 }
}

/** Build one bundled forbidden pattern with the schema's per-field defaults materialized. */
function forbidden(
  name: string,
  pattern: string,
  scope: NonNullable<ForbiddenSpec['scope']>,
): Required<ForbiddenSpec> {
  return { name, pattern, penalty: 1, scope }
}

/**
 * Ordered first-match-wins checks over command strings. Test runners come
 * first so a `make test` never scores as a build; package-manager scripts
 * follow; bare interpreter invocations score as runs.
 */
export const defaultChecks: Array<Required<CheckSpec>> = [
  check('go-test', 'test', '\\bgo\\s+test\\b'),
  check('make-test', 'test', '\\bmake\\s+test\\b'),
  check('js-test-runner', 'test', '\\b(vitest|jest|pytest)\\b'),
  check('package-manager-test', 'test', '\\b(pnpm|npm|yarn|bun)\\b[^&|;]*\\btest\\b'),
  check('compiler-build', 'build', '\\b(tsc|make|cargo\\s+build|go\\s+build|gradle)\\b'),
  check('package-manager-build', 'build', '\\b(pnpm|npm|yarn|bun)\\b[^&|;]*\\bbuild\\b'),
  check('script-run', 'run', '\\b(node|deno|python3?|ruby)\\b|\\bgo\\s+run\\b'),
]

/**
 * Conservative dangerous-operation penalties: destructive recursive deletes of
 * root or home, forced pushes, and remote-content piped straight into a shell.
 */
export const defaultForbiddenPatterns: Array<Required<ForbiddenSpec>> = [
  forbidden('recursive-delete-root', '\\brm\\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\\s+(\\/|~)($|\\s)', 'command'),
  forbidden('force-push', '\\bgit\\s+push\\b[^&|;]*--force($|\\s)', 'command'),
  forbidden('pipe-to-shell', '\\b(curl|wget)\\b[^|]*\\|\\s*(ba)?sh\\b', 'command'),
]
