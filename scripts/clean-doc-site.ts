/**
 * Remove the documentation site's generated state so a build starts from a
 * clean output tree.
 *
 * The projection refuses to overwrite `<outDir>/<file>` when the current pass
 * did not claim it, which is what protects `public/` copies and other
 * producers' files. That guard also rejects the *previous* run's output, so a
 * second consecutive build fails unless the output directories are gone first.
 * The documentation build scripts call this cleaner for that reason.
 * @module
 */

import { existsSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Generated site directories, relative to the website package. */
const GENERATED_SITE_PATHS = ['.dist', '.generated', join('.vitepress', '.cache')] as const

/**
 * Remove every generated documentation-site directory under one repository root.
 * @param root - repository root containing `website/`.
 * @returns repository-relative paths that were removed, in listing order.
 */
export function cleanDocSite(root: string): string[] {
  const repositoryRoot = resolve(root)
  const website = join(repositoryRoot, 'website')
  const removed: string[] = []
  for (const path of GENERATED_SITE_PATHS) {
    const target = join(website, path)
    if (!existsSync(target)) continue
    rmSync(target, { recursive: true, force: true })
    removed.push(relative(repositoryRoot, target).split(sep).join('/'))
  }
  return removed
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  const removed = cleanDocSite(resolve(dirname(scriptPath), '..'))
  console.log(removed.length === 0
    ? 'clean-doc-site: already clean'
    : `clean-doc-site: removed ${removed.join(', ')}`)
}
