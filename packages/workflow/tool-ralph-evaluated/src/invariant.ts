/**
 * Package-owned invariant companion for `@vreal/dsh-tool-ralph-evaluated`.
 * @module @vreal/dsh-tool-ralph-evaluated/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@vreal/cordis'
import type { InvariantInstaller } from '@vreal/dsh-invariants'

const PACKAGE_NAME = '@vreal/dsh-tool-ralph-evaluated'

/** Cordis companion plugin name. */
export const name = 'tool-ralph-evaluated-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this model-facing orchestration adapter owns no independent event stream;
 * workflow and subagent owners validate the runs and child lifecycles it starts.
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
