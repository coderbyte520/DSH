import { staticLinked } from '../tsdown.client.ts'

export default staticLinked(
  '@vreal/dsh-client-web',
  ['lib/types/index.js', 'lib/types/invariant.js'],
)
