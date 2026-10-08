/** Package-owned invariant companion for the bash seam. @module @vreal/dsh-shell/invariant */

import type { Context } from '@vreal/cordis'
import type { InvariantInstaller } from '@vreal/dsh-invariants'

const PACKAGE_NAME = '@vreal/dsh-shell'

/** Cordis companion plugin name. */
export const name = 'shell-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: this stateless Service Definition owns request/result types, while executors and policy own observations. */
const install: InvariantInstaller = () => {}

/**
 * Register the bash invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
