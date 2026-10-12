/**
 * Package-owned invariant companion for `@vreal/dsh-verifiable-reward`.
 * @module @vreal/dsh-verifiable-reward/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@vreal/cordis'
import type { InvariantInstaller } from '@vreal/dsh-invariants'

const PACKAGE_NAME = '@vreal/dsh-verifiable-reward'

/** Cordis companion plugin name. */
export const name = 'verifiable-reward-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this scoring observer owns no independent state; its
 * audit events are validated by the session envelope and its scoring behavior
 * is package-tested.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
