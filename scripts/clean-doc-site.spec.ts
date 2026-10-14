import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanDocSite } from './clean-doc-site.ts'

const roots: string[] = []

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-clean-doc-site-'))
  roots.push(root)
  return root
}

function write(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'x')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('cleanDocSite', () => {
  it('removes exactly the generated site directories and keeps authored files', () => {
    const root = fixture()
    write(join(root, 'website/.dist/index.md'))
    write(join(root, 'website/.generated/index.md'))
    write(join(root, 'website/.vitepress/.cache/deps.json'))
    write(join(root, 'website/.vitepress/config.ts'))
    write(join(root, 'website/public/wordmark.svg'))

    expect(cleanDocSite(root)).toEqual(['website/.dist', 'website/.generated', 'website/.vitepress/.cache'])
    expect(existsSync(join(root, 'website/.dist'))).toBe(false)
    expect(existsSync(join(root, 'website/.generated'))).toBe(false)
    expect(existsSync(join(root, 'website/.vitepress/.cache'))).toBe(false)
    expect(existsSync(join(root, 'website/.vitepress/config.ts'))).toBe(true)
    expect(existsSync(join(root, 'website/public/wordmark.svg'))).toBe(true)
  })

  it('is idempotent: a clean tree removes nothing', () => {
    const root = fixture()
    write(join(root, 'website/.dist/index.md'))

    expect(cleanDocSite(root)).toEqual(['website/.dist'])
    expect(cleanDocSite(root)).toEqual([])
  })
})
