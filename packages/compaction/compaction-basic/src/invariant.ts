/**
 * Package-owned invariant companion for `@vreal/dsh-compaction-basic`.
 * @module @vreal/dsh-compaction-basic/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@vreal/cordis'
import type { InvariantInstaller } from '@vreal/dsh-invariants'

const PACKAGE_NAME = '@vreal/dsh-compaction-basic'

/** Cordis companion plugin name. */
export const name = 'compaction-basic-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package exposes no independent event sequence or mutable data relation
 * beyond contracts enforced at its owning seam.
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
