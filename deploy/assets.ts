/**
 * Asset sync planner for deploy/deploy.sh (no rsync needed on Windows).
 *
 *   pnpm exec tsx deploy/assets.ts plan --dir work/out --remote <remote-manifest> --work <dir> [--exclude a,b] [--tree out]
 *
 * Hashes every file under --dir (SHA-256, cached by size + mtime in <work>/hash-cache.json so a re-deploy
 * only reads changed files), compares with the manifest of what the mini PC holds (`sha256sum` format:
 * "<hex>  <relative path>") and writes into <work>:
 *   manifest.txt  the new manifest (same format), stored on the mini PC after a successful sync
 *   changed.txt   relative paths to send (new or different content), one per line
 *   deleted.txt   relative paths the mini PC has but the source no longer does
 * and prints one summary line: `files=N bytes=B changed=N changedBytes=B deleted=N`.
 *
 * `--exclude` entries (DEPLOY_ASSET_EXCLUDE): a bare name is a top-level folder of every tree (`debug`); `<tree>:<path>`
 * is a folder or file of that tree only (`out:pbr`), where `*` matches within a path segment and `**` across segments
 * (`out-opt:pbr/**\/*.ktx2`). `--tree` names the tree being planned. Files the rule leaves out that the mini PC still
 * holds are deleted there, like any file gone locally.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

interface Entry {
  rel: string
  size: number
  mtimeMs: number
  sha: string
}

type Cache = Record<string, [size: number, mtimeMs: number, sha: string]>

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function need(args: string[], name: string): string {
  const v = flag(args, name)
  if (!v) throw new Error(`missing ${name}`)
  return v
}

/** A glob over a relative path: `*` and `?` within a segment, `**` any number of segments (`**\/` may match none). */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        i++
        re += '(?:.*/)?'
      } else re += '.*'
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** The exclusion test of one tree: true for a relative path (a folder prunes everything under it). */
export function exclusion(entries: readonly string[], tree = ''): (rel: string) => boolean {
  const res: RegExp[] = []
  for (const raw of entries) {
    const e = raw.trim()
    if (!e) continue
    const colon = e.indexOf(':')
    if (colon < 0) res.push(globToRegExp(e))
    else if (e.slice(0, colon) === tree) res.push(globToRegExp(e.slice(colon + 1).replace(/^\/+|\/+$/g, '')))
  }
  return rel => res.some(r => r.test(rel))
}

/** Relative paths (forward slashes) of every regular file under root, skipping dot-files and excluded paths. */
async function walk(root: string, excluded: (rel: string) => boolean): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string, rel: string): Promise<void> {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue
      const r = rel ? `${rel}/${d.name}` : d.name
      if (excluded(r)) continue
      if (d.isDirectory()) await visit(join(dir, d.name), r)
      else if (d.isFile()) out.push(r)
    }
  }
  await visit(root, '')
  return out.sort()
}

async function hashFile(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
}

/** Parses `sha256sum` output ("<hex>  <path>" or "<hex> *<path>"); lines it does not understand are ignored. */
export function parseManifest(text: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const hit = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
    if (hit) m.set(hit[2].replace(/^\.\//, ''), hit[1])
  }
  return m
}

async function plan(args: string[]): Promise<void> {
  const dir = resolve(need(args, '--dir'))
  const work = resolve(need(args, '--work'))
  const remoteFile = need(args, '--remote')
  const exclude = exclusion((flag(args, '--exclude') ?? '').split(','), flag(args, '--tree') ?? '')
  if (!existsSync(dir)) throw new Error(`no such directory: ${dir}`)
  mkdirSync(work, { recursive: true })

  const cacheFile = join(work, 'hash-cache.json')
  let cache: Cache = {}
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as Cache
  } catch {
    // First run or unreadable cache: hash everything.
  }

  const rels = await walk(dir, exclude)
  const entries: Entry[] = []
  const nextCache: Cache = {}
  await pool(rels, 8, async (rel) => {
    const st = await stat(join(dir, rel))
    const hit = cache[rel]
    const sha = hit && hit[0] === st.size && hit[1] === st.mtimeMs ? hit[2] : await hashFile(join(dir, rel))
    nextCache[rel] = [st.size, st.mtimeMs, sha]
    entries.push({ rel, size: st.size, mtimeMs: st.mtimeMs, sha })
  })
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  writeFileSync(cacheFile, JSON.stringify(nextCache))

  const remote = parseManifest(existsSync(remoteFile) ? readFileSync(remoteFile, 'utf8') : '')
  const local = new Set(entries.map((e) => e.rel))
  const changed = entries.filter((e) => remote.get(e.rel) !== e.sha)
  const deleted = [...remote.keys()].filter((rel) => !local.has(rel) && !rel.split('/').some((s) => s === '..' || s === '')).sort()

  const lines = (xs: string[]): string => (xs.length ? `${xs.join('\n')}\n` : '')
  writeFileSync(join(work, 'manifest.txt'), lines(entries.map((e) => `${e.sha}  ${e.rel}`)))
  writeFileSync(join(work, 'changed.txt'), lines(changed.map((e) => e.rel)))
  writeFileSync(join(work, 'deleted.txt'), lines(deleted))
  const bytes = entries.reduce((s, e) => s + e.size, 0)
  const changedBytes = changed.reduce((s, e) => s + e.size, 0)
  console.log(`files=${entries.length} bytes=${bytes} changed=${changed.length} changedBytes=${changedBytes} deleted=${deleted.length}`)
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'plan') {
  plan(rest).catch((e: unknown) => {
    console.error(`assets.ts: ${(e as Error).message}`)
    process.exitCode = 1
  })
} else {
  console.error('usage: tsx deploy/assets.ts plan --dir <tree> --remote <manifest> --work <dir> [--exclude a,b] [--tree name]')
  process.exitCode = 2
}
