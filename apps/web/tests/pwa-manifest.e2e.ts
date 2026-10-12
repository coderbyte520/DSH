import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
  expect(index).toContain('<link rel="icon" type="image/svg+xml" href="/logo-mark.svg" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: 'Vreal',
    short_name: 'DSH',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [{
      src: '/logo-mark.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any',
    }],
  })
})

it('ships the brand mark as the icon: scalable, in its own ink, with no plate or scheme swap', async () => {
  const mark = await readFile(join(DIST_ROOT, 'logo-mark.svg'), 'utf8')
  expect(mark).toContain('viewBox=')
  expect(mark).toContain('fill="#076AF0"')
  expect(mark).not.toContain('#FEFEFE')
  expect(mark).not.toMatch(/prefers-color-scheme/)
})
