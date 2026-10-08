import { describe, expect, it } from 'vitest'
import { Context } from '@vreal/cordis'
import InvariantRegistry from '@vreal/dsh-invariants'
import * as UserIdInvariant from '@vreal/dsh-anonymous-user-id/invariant'

describe('invariant companion', () => {
  it('registers the package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(UserIdInvariant).await()).resolves.toBeDefined()
  })
})
