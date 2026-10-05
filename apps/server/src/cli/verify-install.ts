import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT } from '../config.ts'

/**
 * Install check for a fresh clone, a ZIP download or a folder copied from another PC.  pnpm verify-install
 * (Not `pnpm doctor`: that name is pnpm's own built-in command and would shadow the script.)
 *
 * The one failure a plain clone can't have but a copied folder can: pnpm links each package's dependencies into
 * node_modules/.pnpm/<pkg>/node_modules as symlinks (junctions on Windows). Archivers, cloud sync and some copy tools turn
 * them into real folders, so a package gets its own copy of a dependency. For @babylonjs/loaders that means a second
 * @babylonjs/core: the glTF loader registers on the copy and no model loads ("Unable to find a plugin to load .glb").
 * `pnpm install --force` rebuilds the links.
 *
 * The one failure a clone can have on Windows: the deepest converted asset paths (lightmaps under work/out*) are about
 * 135 characters, so a clone folder deeper than ~123 characters hits the 260-character path limit and git (or
 * Explorer's ZIP extractor) leaves those files out. Exit code 1 when a check fails.
 */

export interface Check {
  name: string
  ok: boolean
  detail: string
  /** A warning does not fail the run (things only some tasks need). */
  warn?: boolean
}

const MIN_NODE_MAJOR = 24

/** Dependency folders under node_modules/.pnpm/<pkg>/node_modules that are real folders instead of links. */
export function copiedDependencyLinks(root: string, limit = 10): string[] {
  const store = join(root, 'node_modules', '.pnpm')
  if (!existsSync(store)) return []
  const found: string[] = []
  for (const pkg of readdirSync(store)) {
    const nm = join(store, pkg, 'node_modules')
    if (!existsSync(nm)) continue
    for (const entry of readdirSync(nm)) {
      if (entry.startsWith('.')) continue
      // `pnpm install --force` parks the folders it replaced as `.ignored_<name>`: leftovers, not links.
      const names = entry.startsWith('@') ? readdirSync(join(nm, entry)).filter(n => !n.startsWith('.')).map(n => join(entry, n)) : [entry]
      for (const name of names) {
        // The package's own folder is real; every other entry is a link to that dependency's .pnpm folder.
        if (isOwnPackage(pkg, name) || lstatSync(join(nm, name)).isSymbolicLink()) continue
        found.push(`${pkg} -> ${name.replace(/\\/g, '/')}`)
        if (found.length >= limit) return found
      }
    }
  }
  return found
}

/** `@babylonjs+core@9.28.0` holds `@babylonjs/core`; `ws@8.22.0_x` holds `ws`. */
function isOwnPackage(storeDir: string, name: string): boolean {
  const base = storeDir.replace(/@[^@+]*?(_.*)?$/, '').replace('+', '/')
  return base === name.replace(/\\/g, '/')
}

function realOrNull(p: string): string | null {
  try { return realpathSync(p) } catch { return null }
}

/** Windows' classic MAX_PATH: 260 characters including the terminating NUL. */
const WIN_MAX_PATH = 259

/** The longest path (in characters, `/`-separated) of any file under the given folders of `root`, relative to `root`. */
export function longestRelativePath(root: string, dirs: string[]): number {
  let longest = 0
  const walk = (rel: string): void => {
    let entries
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const child = `${rel}/${e.name}`
      if (e.isDirectory()) walk(child)
      else if (child.length > longest) longest = child.length
    }
  }
  for (const d of dirs) walk(d)
  return longest
}

/** A clone folder too deep for the longest asset path on Windows (null = fine). */
export function depthProblem(rootLength: number, longestRel: number, platform: string = process.platform): string | null {
  if (platform !== 'win32' || longestRel === 0) return null
  const total = rootLength + 1 + longestRel
  return total > WIN_MAX_PATH ? `the deepest game file would need ${total} characters (Windows allows ${WIN_MAX_PATH}); this folder path is ${rootLength} characters, keep it under ${WIN_MAX_PATH - 1 - longestRel}` : null
}

/** Files git expects but the checkout couldn't create (e.g. too long for Windows), or null without git. */
function missingFromCheckout(root: string): number | null {
  if (!existsSync(join(root, '.git'))) return null
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '--deleted'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return out.split('\n').filter(Boolean).length
  } catch { return null }
}

export function runChecks(root = REPO_ROOT): Check[] {
  const checks: Check[] = []
  const major = Number(process.versions.node.split('.')[0])
  checks.push({ name: 'Node', ok: major >= MIN_NODE_MAJOR, detail: `v${process.versions.node} (needs ${MIN_NODE_MAJOR}+; run Node through pnpm)` })

  const depth = depthProblem(root.length, longestRelativePath(root, ['work/out', 'work/out-opt']))
  const missing = missingFromCheckout(root)
  if (missing !== null) {
    checks.push({
      name: 'Checkout complete',
      ok: missing === 0,
      detail: missing === 0 ? 'every file in the repository is on disk' : `${missing} files are missing from the checkout${depth ? ' (the folder is too deep for Windows paths)' : ''}`,
    })
  }
  if (depth) {
    // With git's core.longpaths and Windows long paths on, a deep folder can still work; then it's only a note.
    checks.push({ name: 'Folder depth', ok: false, warn: missing === 0, detail: depth })
  }

  const installed = existsSync(join(root, 'node_modules', '.pnpm'))
  checks.push({ name: 'Packages installed', ok: installed, detail: installed ? 'node_modules present' : 'run: pnpm install --frozen-lockfile' })
  if (!installed) return checks

  const gameCore = realOrNull(join(root, 'apps', 'game', 'node_modules', '@babylonjs', 'core'))
  const loaders = realOrNull(join(root, 'apps', 'game', 'node_modules', '@babylonjs', 'loaders'))
  const loadersCore = loaders ? realOrNull(join(loaders, '..', 'core')) : null
  const oneBabylon = !!gameCore && gameCore === loadersCore
  checks.push({
    name: 'One Babylon.js',
    ok: oneBabylon,
    detail: oneBabylon ? 'the game and its model loader share @babylonjs/core' : 'the model loader has its own copy of @babylonjs/core: models will not load',
  })

  const copies = copiedDependencyLinks(root)
  checks.push({
    name: 'Package links',
    ok: copies.length === 0,
    detail: copies.length === 0 ? 'all dependency links intact' : `copied instead of linked (first ${copies.length}): ${copies.join(', ')}`,
  })

  let sqlite = ''
  try {
    const req = createRequire(join(root, 'apps', 'server', 'package.json'))
    const Database = req('better-sqlite3') as new (file: string) => { prepare(sql: string): { get(): { v: string } }; close(): void }
    const db = new Database(':memory:')
    sqlite = db.prepare('select sqlite_version() as v').get().v
    db.close()
  } catch (e) {
    sqlite = ''
    checks.push({ name: 'SQLite driver', ok: false, detail: (e as Error).message.split('\n')[0] })
  }
  if (sqlite) checks.push({ name: 'SQLite driver', ok: true, detail: `better-sqlite3 loads (SQLite ${sqlite})` })

  const assets = existsSync(join(root, 'work', 'out-opt', 'world', 'jangan-fields'))
  checks.push({ name: 'Game assets', ok: assets, detail: assets ? 'work/out-opt/world/jangan-fields present' : 'work/out-opt is missing: the clone is incomplete' })

  const config = existsSync(join(root, 'sro.config.json'))
  checks.push({
    name: 'Original client config',
    ok: config,
    warn: true,
    detail: config ? 'sro.config.json present' : 'no sro.config.json: fine for playing and hosting; only the converter and the editor\'s Publish need it',
  })
  return checks
}

export function report(checks: Check[], out: (line: string) => void = console.log): boolean {
  let failed = false
  for (const c of checks) {
    const mark = c.ok ? 'ok  ' : c.warn ? 'note' : 'FAIL'
    if (!c.ok && !c.warn) failed = true
    out(`${mark}  ${c.name}: ${c.detail}`)
  }
  if (failed) {
    const bad = (name: string) => checks.some(c => c.name === name && !c.ok && !c.warn)
    out('')
    if (bad('Checkout complete') || bad('Folder depth')) {
      out('Fix: clone again into a short folder, e.g. `git clone -c core.longpaths=true <repository URL> C:\\dev\\silkroad`.')
      out('     For a ZIP download, extract it into a short folder with 7-Zip (Windows Explorer can\'t extract long paths).')
    } else if (bad('One Babylon.js') || bad('Package links') || bad('SQLite driver')) {
      out('Fix: run `pnpm install --force` in the repository root (rebuilds node_modules; needed after copying an installed folder between PCs).')
    } else {
      out('Fix the FAIL lines above, then run `pnpm verify-install` again.')
    }
  }
  return !failed
}

if (process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(resolve(process.argv[1])).href.toLowerCase()) {
  process.exitCode = report(runChecks()) ? 0 : 1
}
