/**
 * `pnpm verify-install` (apps/server/src/cli/verify-install.ts): a folder copied between PCs turns pnpm's dependency
 * links into real folders, which gives @babylonjs/loaders its own @babylonjs/core and no model loads. The check must
 * see that, and stay quiet on a healthy install and on the `.ignored_*` folders `pnpm install --force` leaves behind.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copiedDependencyLinks, depthProblem, longestRelativePath, report, runChecks } from '../src/cli/verify-install.ts'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }) })

/** A minimal pnpm layout: apps/game links to core and loaders; loaders' own core is a link, or a copy when `copied`. */
function fakeInstall(copied: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'sro-verify-'))
  roots.push(root)
  const store = join(root, 'node_modules', '.pnpm')
  const core = join(store, '@babylonjs+core@9.28.0', 'node_modules', '@babylonjs', 'core')
  const loadersNm = join(store, '@babylonjs+loaders@9.28.0_@_abc', 'node_modules', '@babylonjs')
  mkdirSync(core, { recursive: true })
  mkdirSync(join(loadersNm, 'loaders'), { recursive: true })
  if (copied) mkdirSync(join(loadersNm, 'core'))
  else symlinkSync(core, join(loadersNm, 'core'), 'junction')
  mkdirSync(join(loadersNm, '.ignored_core'))
  const game = join(root, 'apps', 'game', 'node_modules', '@babylonjs')
  mkdirSync(game, { recursive: true })
  symlinkSync(core, join(game, 'core'), 'junction')
  symlinkSync(join(loadersNm, 'loaders'), join(game, 'loaders'), 'junction')
  return root
}

const byName = (root: string) => Object.fromEntries(runChecks(root).map(c => [c.name, c]))

describe('verify-install', () => {
  it('a healthy install: one Babylon, every link intact, leftovers ignored', () => {
    const root = fakeInstall(false)
    expect(copiedDependencyLinks(root)).toEqual([])
    const c = byName(root)
    expect(c['One Babylon.js'].ok).toBe(true)
    expect(c['Package links'].ok).toBe(true)
  })

  it('a copied install: the loader\'s own core is reported and the fix is `pnpm install --force`', () => {
    const root = fakeInstall(true)
    expect(copiedDependencyLinks(root)).toEqual(['@babylonjs+loaders@9.28.0_@_abc -> @babylonjs/core'])
    const c = byName(root)
    expect(c['One Babylon.js'].ok).toBe(false)
    expect(c['Package links'].ok).toBe(false)
    const lines: string[] = []
    expect(report(runChecks(root), l => lines.push(l))).toBe(false)
    expect(lines.at(-1)).toContain('pnpm install --force')
  })

  it('a missing install says to install, nothing else', () => {
    const root = mkdtempSync(join(tmpdir(), 'sro-verify-'))
    roots.push(root)
    const checks = runChecks(root)
    expect(checks.map(c => c.name)).toEqual(['Node', 'Packages installed'])
    expect(checks[1].ok).toBe(false)
  })

  it('a clone folder too deep for Windows paths is caught; Linux and Mac have no such limit', () => {
    // The release's deepest asset path is 135 characters: a 123-character folder is the most Windows allows.
    expect(depthProblem(123, 135, 'win32')).toBeNull()
    expect(depthProblem(124, 135, 'win32')).toContain('keep it under 123')
    expect(depthProblem(300, 135, 'linux')).toBeNull()
    expect(depthProblem(300, 0, 'win32')).toBeNull()
  })

  it('measures the longest file path under the asset folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'sro-verify-'))
    roots.push(root)
    mkdirSync(join(root, 'work', 'out', 'world', 'a-long-folder-name'), { recursive: true })
    writeFileSync(join(root, 'work', 'out', 'world', 'a-long-folder-name', 'x.webp'), '')
    expect(longestRelativePath(root, ['work/out', 'work/out-opt'])).toBe('work/out/world/a-long-folder-name/x.webp'.length)
  })

  it('this repository passes', () => {
    expect(runChecks().filter(c => !c.ok && !c.warn)).toEqual([])
  })
})
