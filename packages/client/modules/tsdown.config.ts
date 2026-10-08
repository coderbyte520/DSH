import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@vreal/dsh-client-modules',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
