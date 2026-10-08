#!/usr/bin/env node

import { Context } from '@vreal/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@vreal/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@vreal/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
