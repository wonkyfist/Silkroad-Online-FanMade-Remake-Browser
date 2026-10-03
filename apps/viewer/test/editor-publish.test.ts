// The World Editor's step 2 (WE-A, docs/WORLD_EDITOR.md §2.4, §6.1-§6.4; docs/WAVE_PLAN8.md §6.2, D7, D36, D37):
// Publish's prepare / keep / go back / undo on a fixture export (the converter, the optimizer, the checks and the tests
// injected), the per-file swap with its backup and its rollback, Publish never touching work/out while the convert
// lock is held, the editor's base overlay, the pathspec commit, Test in game's private processes (injected), the Deploy
// refusals (dirty or undeployed converter code, an open publish, nothing kept) and the API routes.
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { PUBLISH_CHECKS, WORLD_EDITS_REPORT_FORMAT, WORLD_EDITS_REPORT_VERSION, type WorldEditsReport } from '../../../packages/convert/src/world/edits/checks.ts'
import { createEditorApi, type EditorApi } from '../editor-api/api.ts'
import { createBaseOverlay } from '../editor-api/base-overlay.ts'
import { DeployHandOff } from '../editor-api/deploy.ts'
import { commitPaths, dirtyPaths } from '../editor-api/git.ts'
import { API_PREFIX, LEASE_HEADER, TOKEN_HEADER, type SessionInfo } from '../editor-api/protocol.ts'
import {
  commitMessage, discardPublish, keepPublish, preparePublish, publishPaths, readPublished, readRecord, swapFiles, undoPublish,
  type PrepareOptions, type PublishPaths,
} from '../editor-api/publish.ts'
import { serverEnv, TestGame } from '../editor-api/test-game.ts'
import { PublishRunner } from '../editor-api/runner.ts'

const WORLD = 'jangan-fields'
const tmps: string[] = []
const apis: EditorApi[] = []
afterEach(() => {
  for (const a of apis.splice(0)) a.close()
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true })
})

const tmp = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `sro-we-a2-${tag}-`))
  tmps.push(d)
  return d
}
const put = (file: string, text: string) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}
const text = (file: string) => readFileSync(file, 'utf8')

// --- a fixture export ------------------------------------------------------------------------------------------------

const MANIFEST = (tag: string) => JSON.stringify({
  tag, space: { originRegion: { x: 168, z: 97 } }, regions: [], tiles: [], placements: [], models: [], warnings: [], places: [],
  spawn: { x: 0, y: 0, z: 0 },
})

function fixture(): { root: string; p: PublishPaths } {
  const root = tmp('pub')
  const repo = join(root, 'repo')
  const work = join(root, 'work')
  const p = publishPaths(repo, work, WORLD)
  mkdirSync(p.layerDir, { recursive: true })
  put(join(p.liveDir, 'manifest.json'), MANIFEST('live'))
  put(join(p.liveDir, 'terrain', 'a.bin'), 'old A')
  put(join(p.liveDir, 'minimap', 'x.png'), 'old X')
  put(join(p.liveDir, 'nav.bin'), 'nav')
  put(join(p.optRoot, 'slim.json'), '{"format":"sro-slim","version":1,"renamed":{}}')
  put(join(p.optRoot, 'world', WORLD, 'manifest.json'), 'opt live manifest')
  put(join(p.optRoot, 'world', WORLD, 'terrain', 'a.bin'), 'opt old A')
  put(join(p.optRoot, 'world', WORLD, 'minimap', 'x.webp'), 'opt old X')
  // one change since the last publish (the journal the API keeps)
  put(join(p.editorDir, 'journal.ndjson'), [
    JSON.stringify({ format: 'sro-editor-journal', version: 1, world: WORLD, head: 1, folded: 0, nextId: 2, files: {} }),
    JSON.stringify({ id: 1, label: 'Raised the ground at 171,97', tool: 'raise', regions: [(97 << 8) | 171], view: [0, 50, 0, 640, 2, -138] }),
  ].join('\n') + '\n')
  return { root, p }
}

const passReport = (): WorldEditsReport => ({
  format: WORLD_EDITS_REPORT_FORMAT, version: WORLD_EDITS_REPORT_VERSION, world: WORLD, verdict: 'pass', complete: true,
  checks: PUBLISH_CHECKS.map(c => ({ id: c.id, key: c.key, title: c.title, status: 'pass' as const, summary: 'ok' })),
  nav: { regions: [], totals: { touched: 0, closed: 0, opened: 0, closedSlope: 0, closedWater: 0, objects: 0 }, problems: [] },
  swim: { deepWaterTiles: 0, deepWaterM2: 0, regions: [] }, timingsMs: {},
})

/** The injected steps: the edited run changes a.bin, adds a grass mask, drops a minimap; the base run gives the old files. */
function stubs(p: PublishPaths, calls: string[] = []): Partial<PrepareOptions> {
  return {
    tests: true,
    convert: async o => {
      calls.push(`convert ${o.edits === null ? 'base' : 'edited'} ${o.only.join(',')}`)
      rmSync(o.stagingDir, { recursive: true, force: true })
      if (o.edits !== null) {
        put(join(o.stagingDir, 'manifest.json'), MANIFEST('edited'))
        put(join(o.stagingDir, 'terrain', 'a.bin'), 'new A')
        put(join(o.stagingDir, 'grass', 'm.png'), 'mask')
        put(join(o.stagingDir, 'nav.bin'), 'nav')
        return { changed: ['grass/m.png', 'manifest.json', 'terrain/a.bin'], removed: ['minimap/x.png'], regions: { core: [(97 << 8) | 171], ring: [], nav: [] }, drift: [], coast: 'snapshot' }
      }
      put(join(o.stagingDir, 'manifest.json'), MANIFEST('base'))
      put(join(o.stagingDir, 'terrain', 'a.bin'), 'old A')
      put(join(o.stagingDir, 'minimap', 'x.png'), 'old X')
      put(join(o.stagingDir, 'nav.bin'), 'nav')
      return { changed: ['manifest.json'], removed: [], regions: { core: [(97 << 8) | 171], ring: [], nav: [] }, drift: [], coast: 'snapshot' }
    },
    optimize: async o => {
      calls.push(`optimize ${o.files.join(',')}`)
      put(join(o.outDir, 'slim.json'), '{"format":"sro-slim","version":1,"renamed":{"new":1}}')
      put(join(o.outDir, 'world', WORLD, 'terrain', 'a.bin'), 'opt new A')
      put(join(o.outDir, 'world', WORLD, 'manifest.json'), 'opt edited manifest')
      return { written: ['slim.json', `world/${WORLD}/manifest.json`, `world/${WORLD}/terrain/a.bin`], removed: [`world/${WORLD}/minimap/x.webp`] }
    },
    runTests: async files => {
      calls.push(`tests ${files.length}`)
      return { ok: true, summary: 'Tests 3 passed' }
    },
    checks: () => passReport(),
  }
}

// --- prepare, keep, the base overlay, undo ---------------------------------------------------------------------------

describe('Publish on a fixture export (prepare, keep, base overlay, undo)', () => {
  it('prepare builds the staging exports and the report, and never writes the live export', async () => {
    const { p } = fixture()
    const calls: string[] = []
    const rec = await preparePublish({ paths: p, ...stubs(p, calls) })
    expect(rec.phase, rec.sentence).toBe('ready')
    expect(rec.verdict).toBe('pass')
    expect(rec.changes).toEqual(['Raised the ground at 171,97'])
    expect(calls[0]).toBe(`convert edited ${(97 << 8) | 171}`)
    expect(calls[1]).toBe(`convert base ${(97 << 8) | 171}`)
    expect(rec.files).toEqual({
      out: ['grass/m.png', 'manifest.json', 'terrain/a.bin'], outRemoved: ['minimap/x.png'],
      opt: ['slim.json', `world/${WORLD}/manifest.json`, `world/${WORLD}/terrain/a.bin`], optRemoved: [`world/${WORLD}/minimap/x.webp`],
    })
    // the live export and out-opt are untouched
    expect(text(join(p.liveDir, 'terrain', 'a.bin'))).toBe('old A')
    expect(text(join(p.optRoot, 'slim.json'))).toContain('"renamed":{}')
    // Test in game's out-opt staging: the live out-opt linked, the optimized files over it, the removed one gone
    expect(text(join(p.optStagingDir, 'terrain', 'a.bin'))).toBe('opt new A')
    expect(text(join(p.optStagingDir, 'manifest.json'))).toBe('opt edited manifest')
    expect(existsSync(join(p.optStagingDir, 'minimap', 'x.webp'))).toBe(false)
    expect(text(join(p.optRoot, 'world', WORLD, 'manifest.json'))).toBe('opt live manifest')
    // the report files
    const dir = join(p.editorDir, `publish-${rec.n}`)
    expect(existsSync(join(dir, 'report.json'))).toBe(true)
    expect(text(join(dir, 'report.html'))).toContain(`Publish ${rec.n}`)
    expect(rec.views?.[0]).toMatchObject({ id: 1, view: [0, 50, 0, 640, 2, -138] })
  })

  it('keep swaps file by file with a backup, updates the base overlay, commits content/, and undo puts it all back', async () => {
    const { p } = fixture()
    const rec = await preparePublish({ paths: p, ...stubs(p) })
    const commits: Array<{ paths: string[]; message: string }> = []
    const kept = await keepPublish({ paths: p, n: rec.n, commit: (paths, message) => (commits.push({ paths, message }), 'abc1234') })
    expect(kept.phase, kept.sentence).toBe('kept')
    expect(text(join(p.liveDir, 'terrain', 'a.bin'))).toBe('new A')
    expect(text(join(p.liveDir, 'grass', 'm.png'))).toBe('mask')
    expect(existsSync(join(p.liveDir, 'minimap', 'x.png'))).toBe(false)
    expect(JSON.parse(text(join(p.liveDir, 'manifest.json'))).tag).toBe('edited')
    expect(text(join(p.optRoot, 'world', WORLD, 'terrain', 'a.bin'))).toBe('opt new A')
    expect(existsSync(join(p.optRoot, 'world', WORLD, 'minimap', 'x.webp'))).toBe(false)
    expect(text(join(p.optRoot, 'slim.json'))).toContain('"new":1')
    // backups of what was replaced or removed
    const dir = join(p.editorDir, `publish-${rec.n}`)
    expect(text(join(dir, 'backup', 'out', 'terrain', 'a.bin'))).toBe('old A')
    expect(text(join(dir, 'backup', 'out', 'minimap', 'x.png'))).toBe('old X')
    expect(text(join(dir, 'backup', 'opt', 'slim.json'))).toContain('"renamed":{}')
    // the manifests and slim.json went last
    const swap = JSON.parse(text(join(dir, 'swap.json'))) as Array<{ tree: string; rel: string }>
    const order = swap.filter(s => s.tree !== 'base').map(s => `${s.tree}:${s.rel}`)
    expect(order.slice(-3)).toEqual(['opt:slim.json', `opt:world/${WORLD}/manifest.json`, 'out:manifest.json'])
    // the pathspec commit of the layers only, with the changes in words
    expect(commits).toEqual([{ paths: ['content/world-edits/jangan-fields'], message: expect.stringContaining('World edits: Raised the ground at 171,97') }])
    // staging exports gone, the publish recorded
    expect(existsSync(p.stagingDir)).toBe(false)
    expect(existsSync(p.optStagingDir)).toBe(false)
    expect(readPublished(p.editorDir).kept.map(k => k.n)).toEqual([rec.n])

    // the editor's base: the unedited files for what the publish changed
    const overlay = createBaseOverlay(p.editorDir, p.liveDir)
    const serve = (rel: string) => {
      let status = 0
      let body = ''
      const res = new EventEmitter() as EventEmitter & Record<string, unknown>
      Object.assign(res, {
        statusCode: 200, setHeader: () => {}, write: (b: Buffer) => (body += b.toString(), true),
        end: (b?: string | Buffer) => {
          if (b) body += b.toString()
          status = res.statusCode as number
          res.emit('finish')
        },
      })
      const served = overlay.serve(rel, { method: 'GET' } as IncomingMessage, res as unknown as ServerResponse)
      return { served, wait: () => new Promise<{ status: number; body: string }>(r => (served && !status ? res.once('finish', () => r({ status, body })) : r({ status, body }))) }
    }
    const a = serve('terrain/a.bin')
    expect(a.served).toBe(true)
    expect((await a.wait()).body).toBe('old A')
    const mask = serve('grass/m.png')
    expect(mask.served).toBe(true)
    expect((await mask.wait()).status).toBe(404)
    expect(serve('nav.bin').served).toBe(false)
    expect(overlay.stale()).toEqual([])
    // a convert rewrote the live file: the entry no longer applies
    writeFileSync(join(p.liveDir, 'terrain', 'a.bin'), 'converted again')
    expect(serve('terrain/a.bin').served).toBe(false)
    expect(overlay.stale()).toEqual(['terrain/a.bin'])
    writeFileSync(join(p.liveDir, 'terrain', 'a.bin'), 'new A')

    // undo: the live files and the overlay as before the keep
    const undone = await undoPublish(p, rec.n)
    expect(undone.phase).toBe('undone')
    expect(text(join(p.liveDir, 'terrain', 'a.bin'))).toBe('old A')
    expect(text(join(p.liveDir, 'minimap', 'x.png'))).toBe('old X')
    expect(existsSync(join(p.liveDir, 'grass', 'm.png'))).toBe(false)
    expect(JSON.parse(text(join(p.liveDir, 'manifest.json'))).tag).toBe('live')
    expect(text(join(p.optRoot, 'slim.json'))).toContain('"renamed":{}')
    expect(existsSync(join(p.editorDir, 'base', 'index.json'))).toBe(false)
    expect(readPublished(p.editorDir).kept[0]!.undone).toBeTruthy()
    await expect(undoPublish(p, rec.n)).rejects.toThrow(/only the newest kept publish/)
  })

  it('Keep flips painted tiles to hero through texpipe under the GPU lock and commits overrides.json with the layers', async () => {
    const { p } = fixture()
    const rec = await preparePublish({ paths: p, ...stubs(p) })
    const file = join(p.editorDir, `publish-${rec.n}`, 'record.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(text(file)), hero: [{ tile: 'c_grass_fld_05', cover: 0.002 }] }))
    const seen: string[] = []
    const optimized: string[][] = []
    const commits: string[][] = []
    const kept = await keepPublish({
      paths: p, n: rec.n,
      hero: async tiles => {
        seen.push(`${tiles.join(',')} lock:${text(join(p.workRoot, 'tools', 'gpu.lock', 'owner')).startsWith('WE-A editor publish')}`)
        // repo-relative, as TT-B's verb prints them (the fixture's work folder sits beside its repo)
        return { files: ['content/texpipe/overrides.json', relative(p.repoRoot, join(p.workRoot, 'out', 'pbr', 'index.json')).split('\\').join('/')] }
      },
      optimize: async o => (optimized.push([...o.files]), { written: [], removed: [] }),
      commit: paths => (commits.push(paths), 'abc'),
    })
    expect(kept.phase, kept.sentence).toBe('kept')
    expect(seen).toEqual(['c_grass_fld_05 lock:true'])
    expect(existsSync(join(p.workRoot, 'tools', 'gpu.lock'))).toBe(false)
    expect(optimized).toEqual([['pbr/index.json']])
    expect(commits).toEqual([['content/world-edits/jangan-fields', 'content/texpipe/overrides.json']])
  })

  it('Go back removes the staging exports and changes nothing', async () => {
    const { p } = fixture()
    const rec = await preparePublish({ paths: p, ...stubs(p) })
    const r = discardPublish(p, rec.n)
    expect(r.phase).toBe('discarded')
    expect(existsSync(p.stagingDir)).toBe(false)
    expect(existsSync(p.optStagingDir)).toBe(false)
    expect(text(join(p.liveDir, 'terrain', 'a.bin'))).toBe('old A')
    await expect(keepPublish({ paths: p, n: rec.n })).rejects.toThrow(/not ready/)
  })

  it('never touches work/out while another process holds the convert lock', async () => {
    const { p } = fixture()
    const lock = join(p.workRoot, 'out', '.convert.lock')
    mkdirSync(lock, { recursive: true })
    // a live owner that is not this process (the parent runs while the test does)
    writeFileSync(join(lock, 'owner'), `lane_convert pid=${process.ppid} host=${(await import('node:os')).hostname()} ${new Date().toISOString()}\n`)
    const calls: string[] = []
    const rec = await preparePublish({ paths: p, ...stubs(p, calls), lockWaitMs: 0 })
    expect(rec.phase).toBe('failed')
    expect(rec.sentence).toMatch(/convert lock .* is held by lane_convert/)
    expect(calls.filter(c => c.startsWith('convert'))).toEqual([])
    expect(existsSync(p.stagingDir)).toBe(false)
    // a ready publish waits for the lock too, and keeps nothing while it is held
    rmSync(lock, { recursive: true, force: true })
    const ready = await preparePublish({ paths: p, ...stubs(p) })
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner'), `lane_convert pid=${process.ppid} host=${(await import('node:os')).hostname()} ${new Date().toISOString()}\n`)
    const k = await keepPublish({ paths: p, n: ready.n, lockWaitMs: 0, commit: () => 'x' })
    expect(k.phase).toBe('ready')
    expect(k.error).toMatch(/held by lane_convert/)
    expect(text(join(p.liveDir, 'terrain', 'a.bin'))).toBe('old A')
    rmSync(lock, { recursive: true, force: true })
  })

  it('refuses to keep when the live map changed since the publish was built, and stops on invalid layers', async () => {
    const { p } = fixture()
    const rec = await preparePublish({ paths: p, ...stubs(p) })
    writeFileSync(join(p.liveDir, 'manifest.json'), MANIFEST('converted meanwhile'))
    const k = await keepPublish({ paths: p, n: rec.n, commit: () => 'x' })
    expect(k.phase).toBe('ready')
    expect(k.sentence).toMatch(/the map changed since this publish was built/)
    expect(text(join(p.liveDir, 'terrain', 'a.bin'))).toBe('old A')

    put(join(p.layerDir, 'height', '171_97.png'), 'not a png')
    const bad = await preparePublish({ paths: p, ...stubs(p) })
    expect(bad.phase).toBe('stopped')
    expect(bad.verdict).toBe('stop')
    const report = JSON.parse(text(join(p.editorDir, `publish-${bad.n}`, 'report.json'))) as WorldEditsReport
    expect(report.checks[0]!.status).toBe('stop')
    expect(report.checks.slice(1).every(c => c.status === 'skip')).toBe(true)
    // a publish that stops at the layers leaves the open one as it was (its staging export stays)
    expect(readRecord(p, rec.n)!.phase).toBe('ready')
    expect(existsSync(p.stagingDir)).toBe(true)
  })

  it('says there is nothing to publish without layers or changes', async () => {
    const { p } = fixture()
    rmSync(join(p.editorDir, 'journal.ndjson'))
    const rec = await preparePublish({ paths: p, ...stubs(p) })
    expect(rec.phase).toBe('stopped')
    expect(rec.sentence).toMatch(/Nothing to publish/)
  })

  it('a failed swap puts back what it already replaced', () => {
    const { p } = fixture()
    const backup = join(tmp('bk'), 'backup')
    const src = join(tmp('src'), 'a.bin')
    put(src, 'NEW')
    expect(() => swapFiles(p, backup, [
      { tree: 'out', rel: 'terrain/a.bin', from: src },
      { tree: 'out', rel: 'minimap/x.png', from: join(p.liveDir, 'does-not-exist') },
    ])).toThrow(/already replaced were put back/)
    expect(text(join(p.liveDir, 'terrain', 'a.bin'))).toBe('old A')
    expect(text(join(p.liveDir, 'minimap', 'x.png'))).toBe('old X')
  })

  it('the commit message lists the changes', () => {
    expect(commitMessage(['A', 'B'], 3).split('\n')[0]).toBe('World edits: A; B')
    const long = commitMessage(['a', 'b', 'c', 'd', 'e'], 4)
    expect(long.split('\n')[0]).toBe('World edits: a; b; c (+2 more)')
    expect(long).toContain('- e')
  })
})

// --- git ------------------------------------------------------------------------------------------------------------

function gitRepo(): string {
  const dir = tmp('git')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' })
  g('init', '-q')
  g('config', 'user.email', 'editor@test.invalid')
  g('config', 'user.name', 'Editor Test')
  g('config', 'commit.gpgsign', 'false')
  g('config', 'core.autocrlf', 'false')
  put(join(dir, 'packages', 'convert', 'src', 'a.ts'), 'export const a = 1\n')
  put(join(dir, 'README.md'), 'x\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'one')
  return dir
}
const gitOut = (dir: string, ...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()

describe('the pathspec commit (D39)', () => {
  it('commits only the layer folder, whatever else is staged or changed', () => {
    const dir = gitRepo()
    put(join(dir, 'content', 'world-edits', WORLD, 'height', '171_97.png'), 'layer')
    put(join(dir, 'README.md'), 'changed\n')
    put(join(dir, 'staged.txt'), 'staged\n')
    execFileSync('git', ['add', 'staged.txt'], { cwd: dir })
    const sha = commitPaths(dir, [`content/world-edits/${WORLD}`], 'World edits: test\n')
    expect(sha).toMatch(/^[0-9a-f]{7,}$/)
    expect(gitOut(dir, 'show', '--name-only', '--format=%s', 'HEAD').split('\n')).toEqual(['World edits: test', '', `content/world-edits/${WORLD}/height/171_97.png`])
    expect(gitOut(dir, 'diff', '--cached', '--name-only')).toBe('staged.txt')
    expect(dirtyPaths(dir, ['README.md'])).toEqual(['README.md'])
    expect(commitPaths(dir, [`content/world-edits/${WORLD}`], 'again')).toBeNull()
  })
})

// --- Deploy ---------------------------------------------------------------------------------------------------------

function fakeChild(): ChildProcess & { finish(code: number): void } {
  const c = new EventEmitter() as ChildProcess & { finish(code: number): void }
  Object.assign(c, {
    stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, pid: 1,
    kill: () => {
      ;(c as { signalCode: string | null }).signalCode = 'SIGTERM'
      c.emit('exit', null, 'SIGTERM')
      c.emit('close', null)
      return true
    },
    finish: (code: number) => {
      ;(c as { exitCode: number | null }).exitCode = code
      c.emit('exit', code, null)
      c.emit('close', code)
    },
  })
  return c
}

describe('the Deploy hand-off (D36, §F16)', () => {
  const setup = (opts: { deployed: () => string | null; open?: number | null }) => {
    const repo = gitRepo()
    const work = join(repo, 'work')
    put(join(work, 'editor', WORLD, 'published.json'), JSON.stringify({ kept: [{ n: 1, at: 'x', journalId: 3, changes: ['Raised the ground'] }], deployedThrough: 0 }))
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'work'], { cwd: repo })
    const runs: ChildProcess[] = []
    const d = new DeployHandOff({
      repoRoot: repo, workRoot: work, world: WORLD, deployedCommit: async () => opts.deployed(), openPublish: () => opts.open ?? null,
      runDeploy: () => {
        const c = fakeChild()
        runs.push(c)
        return c
      },
    })
    return { repo, work, d, runs }
  }

  it('refuses with converter code newer than the deployed release, dirty converter code, or no answer', async () => {
    let deployed: string | null = null
    const { repo, d } = setup({ deployed: () => deployed })
    const first = gitOut(repo, 'rev-list', '--max-parents=0', 'HEAD')
    expect((await d.plan()).sentence).toMatch(/did not say which version/)
    put(join(repo, 'packages', 'convert', 'src', 'a.ts'), 'export const a = 2\n')
    execFileSync('git', ['commit', '-q', '-am', 'converter change'], { cwd: repo })
    deployed = first
    const newer = await d.plan()
    expect(newer.ok).toBe(false)
    expect(newer.sentence).toMatch(/newer converter code/)
    deployed = gitOut(repo, 'rev-parse', 'HEAD')
    expect((await d.plan()).ok).toBe(true)
    put(join(repo, 'packages', 'shared', 'src', 'b.ts'), 'unfinished\n')
    const dirty = await d.plan()
    expect(dirty.ok).toBe(false)
    expect(dirty.sentence).toMatch(/A build is in progress/)
  })

  it('refuses with an open publish, a running convert, or nothing kept; runs only on the confirmed click', async () => {
    let open: number | null = 2
    const s = setup({ deployed: () => null, open: 2 })
    const d = new DeployHandOff({ repoRoot: s.repo, workRoot: s.work, world: WORLD, openPublish: () => open, deployedCommit: async () => gitOut(s.repo, 'rev-parse', 'HEAD'), runDeploy: () => {
      const c = fakeChild()
      s.runs.push(c)
      return c
    } })
    expect((await d.plan()).sentence).toMatch(/Publish 2 is still open/)
    open = null
    mkdirSync(join(s.work, 'out', '.convert.lock'), { recursive: true })
    expect((await d.plan()).sentence).toMatch(/A convert is running/)
    rmSync(join(s.work, 'out', '.convert.lock'), { recursive: true })
    const plan = await d.plan()
    expect(plan.ok).toBe(true)
    expect(plan.changes).toEqual(['Raised the ground'])
    expect((await d.start(false)).sentence).toMatch(/needs the click/)
    expect(s.runs.length).toBe(0)
    const started = await d.start(true)
    expect(started.run?.phase).toBe('running')
    expect(s.runs.length).toBe(1)
    ;(s.runs[0] as ReturnType<typeof fakeChild>).finish(0)
    expect(d.state()?.run?.phase).toBe('done')
    expect(readPublished(join(s.work, 'editor', WORLD)).deployedThrough).toBe(1)
    expect((await d.plan()).sentence).toMatch(/Nothing to send/)
  })
})

// --- Test in game -----------------------------------------------------------------------------------------------------

describe('Test in game (§2.4, D6)', () => {
  const setup = () => {
    const root = tmp('test')
    const repo = join(root, 'repo')
    const work = join(root, 'work')
    put(join(repo, 'work', 'server', 'game.db'), 'db')
    put(join(repo, 'work', 'server', 'game.db-wal'), 'wal')
    const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv; child: ReturnType<typeof fakeChild> }> = []
    const ports = [41001, 41002]
    const tg = new TestGame({
      repoRoot: repo, workRoot: work, world: WORLD, readyMs: 2000,
      spawnProc: (args, o) => {
        const child = fakeChild()
        spawned.push({ args, env: o.env, child })
        return child
      },
      freePort: async () => ports.shift()!,
      probe: async () => true,
    })
    return { repo, work, tg, spawned }
  }

  it('needs a publish, then runs a private server on a DB copy and a private game, and cleans up', async () => {
    const { work, tg, spawned } = setup()
    expect((await tg.start()).sentence).toMatch(/Publish first/)
    put(join(work, 'out', 'world', `${WORLD}-edit`, 'manifest.json'), '{}')
    const st = await tg.start({ x: 640, z: -138 })
    expect(st.phase, st.sentence).toBe('running')
    expect(st.url).toBe('http://127.0.0.1:41002/')
    expect(st.sentence).toContain('x 640, z -138')
    const [server, game] = spawned
    expect(server!.args).toEqual(['--import', 'tsx', 'apps/server/src/main.ts'])
    expect(server!.env).toMatchObject({ PORT: '41001', HOST: '127.0.0.1', WORLD_EXPORT: `${WORLD}-edit`, ALLOWED_ORIGINS: 'http://127.0.0.1:41002,http://localhost:41002' })
    const dataDir = server!.env.DATA_DIR!
    expect(text(join(dataDir, 'game.db'))).toBe('db')
    expect(text(join(dataDir, 'game.db-wal'))).toBe('wal')
    expect(game!.args.slice(-2)).toEqual(['apps/viewer/editor-api/test-game-vite.ts', '41002'])
    expect(game!.env.SRO_SERVER).toBe('http://127.0.0.1:41001')
    const stopped = await tg.stop()
    expect(stopped.phase).toBe('off')
    expect(spawned.every(s => s.child.signalCode === 'SIGTERM')).toBe(true)
    expect(existsSync(dataDir)).toBe(false)
  })

  it('fails and cleans up when a process stops on its own', async () => {
    const { work, tg, spawned } = setup()
    put(join(work, 'out', 'world', `${WORLD}-edit`, 'manifest.json'), '{}')
    await tg.start()
    spawned[0]!.child.finish(1)
    await new Promise(r => setTimeout(r, 20))
    expect(tg.state().phase).toBe('failed')
    expect(tg.state().sentence).toMatch(/private server stopped \(exit 1\)/)
    expect(spawned[1]!.child.signalCode).toBe('SIGTERM')
  })

  it('the server environment drops the dev server settings', () => {
    const env = serverEnv({ WORLD_EXPORT: 'jangan', PORT: '7000', DATA_DIR: 'x', NODE_ENV: 'production', PATH: 'p' }, { port: 1, dataDir: 'd', world: WORLD, gamePort: 2 })
    expect(env).toMatchObject({ PORT: '1', DATA_DIR: 'd', WORLD_EXPORT: `${WORLD}-edit`, PATH: 'p' })
    expect(env.NODE_ENV).toBeUndefined()
  })
})

// --- the API routes ---------------------------------------------------------------------------------------------------

const TOKEN = 'test-token-0123456789abcdef'
const HOST = '127.0.0.1:5185'

function request(api: EditorApi, opts: { path: string; body?: unknown; lease?: string }): Promise<{ status: number; type: string; body: string; json: () => any }> {
  const method = opts.body === undefined ? 'GET' : 'POST'
  const headers: Record<string, string> = { host: HOST, [TOKEN_HEADER]: TOKEN }
  if (method === 'POST') Object.assign(headers, { origin: `http://${HOST}`, 'content-type': 'application/json' })
  if (opts.lease) headers[LEASE_HEADER] = opts.lease
  const req = Readable.from(opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]) as unknown as IncomingMessage
  Object.assign(req, { method, url: API_PREFIX + opts.path, headers })
  return new Promise((resolve, reject) => {
    const out: Record<string, string> = {}
    const res = {
      statusCode: 200, headersSent: false,
      setHeader: (k: string, v: string) => (out[k.toLowerCase()] = v),
      end: (data?: string | Uint8Array) => {
        const body = Buffer.from(data ?? '').toString('utf8')
        resolve({ status: res.statusCode, type: out['content-type'] ?? '', body, json: () => JSON.parse(body) })
      },
      destroy: () => reject(new Error('destroyed')),
    }
    api.handle(req, res as unknown as ServerResponse, () => resolve({ status: -1, type: '', body: '', json: () => null }))
  })
}

describe('a prepare that dies (V-12: out of memory during the convert)', () => {
  const preparing = (n: number, pid?: number) => JSON.stringify({
    format: 'sro-editor-publish', version: 1, n, world: WORLD, phase: 'preparing', startedAt: 't', sentence: 's', changes: [], journalId: 1,
    steps: [{ key: 'validate', title: 'Check the layers', status: 'done' }, { key: 'convert', title: 'Build', status: 'run' }, { key: 'tests', title: 'Tests', status: 'wait' }],
    ...(pid ? { pid } : {}),
  })

  it('its record becomes failed when its process ends without writing the end, and Deploy no longer waits on it', async () => {
    const { p } = fixture()
    let child: ReturnType<typeof fakeChild> | null = null
    const runner = new PublishRunner({ repoRoot: p.repoRoot, workRoot: p.workRoot, world: WORLD, spawnJob: () => (child = fakeChild()), alive: () => true })
    runner.start('prepare')
    expect(runner.current()).toMatchObject({ n: 1, phase: 'preparing' }) // the placeholder
    put(join(p.editorDir, 'publish-1', 'record.json'), preparing(1, 4242))
    child!.finish(134)
    expect(runner.running).toBe(false)
    const rec = runner.current()!
    expect(rec).toMatchObject({ n: 1, phase: 'failed' })
    expect(rec.error).toMatch(/stopped before it finished \(exit code 134\)/)
    expect(rec.steps.map(s => s.status)).toEqual(['done', 'fail', 'skip'])
    // written, for every reader (the report page, the next editor, Deploy's "open publish")
    expect(JSON.parse(readFileSync(join(p.editorDir, 'publish-1', 'record.json'), 'utf8')).phase).toBe('failed')
  })

  it('a record left preparing by a process that is gone is failed on read; one whose process runs (a CLI prepare) is not', () => {
    const { p } = fixture()
    let alive = true
    const runner = new PublishRunner({ repoRoot: p.repoRoot, workRoot: p.workRoot, world: WORLD, alive: () => alive })
    put(join(p.editorDir, 'publish-3', 'record.json'), preparing(3, 4242))
    expect(runner.current()!.phase).toBe('preparing')
    alive = false
    expect(runner.current()!.phase).toBe('failed')
    expect(runner.state().current!.error).toMatch(/its process is gone/)
    // an older record without the pid is left alone (nothing tells who prepares it)
    put(join(p.editorDir, 'publish-4', 'record.json'), preparing(4))
    expect(runner.current()!.phase).toBe('preparing')
  })
})

describe('the step-2 API routes', () => {
  it('starts jobs only for the writing tab, in their own process, and refuses what cannot be done', async () => {
    const { p } = fixture()
    const jobs: string[][] = []
    const api = createEditorApi({
      repoRoot: p.repoRoot, workRoot: p.workRoot, world: WORLD, port: 5185, token: TOKEN,
      step2: { watchMs: 0, spawnJob: args => (jobs.push(args), fakeChild()) },
    })
    apis.push(api)
    expect((await request(api, { path: 'publish/start', body: {} })).status).toBe(409)
    const s = (await request(api, { path: 'session', body: {} })).json() as SessionInfo
    const r = await request(api, { path: 'publish/start', body: {}, lease: s.lease })
    expect(r.status).toBe(202)
    expect(jobs[0]).toEqual(['--import', 'tsx', 'apps/viewer/editor-api/publish-cli.ts', 'prepare', '--world', WORLD])
    expect(r.json().running).toMatchObject({ job: 'prepare', n: 1 })
    // V-12: before the job writes its record, the state answers that publish (preparing), not the previous one or none
    expect(r.json().current).toMatchObject({ n: 1, phase: 'preparing' })
    expect((await request(api, { path: 'publish' })).json().current).toMatchObject({ n: 1, phase: 'preparing' })
    expect((await request(api, { path: 'publish/start', body: {}, lease: s.lease })).status).toBe(409)
    api.publish.stop()
    // a stopped publish cannot be kept; its report page is served
    const rec = await preparePublish({ paths: p, ...stubs(p), checks: () => ({ ...passReport(), verdict: 'stop' }) })
    expect((await request(api, { path: 'publish/keep', body: { n: rec.n }, lease: s.lease })).status).toBe(409)
    expect((await request(api, { path: 'publish/keep', body: { n: 99 }, lease: s.lease })).status).toBe(404)
    const page = await request(api, { path: `publish/page?n=${rec.n}` })
    expect(page.type).toMatch(/text\/html/)
    expect(page.body).toContain(`Publish ${rec.n}`)
    const report = (await request(api, { path: `publish/report?n=${rec.n}` })).json()
    expect(report.report.verdict).toBe('stop')
    // shots: PNG only, under the publish
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).toString('base64')
    expect((await request(api, { path: 'publish/shot', body: { n: rec.n, name: 'before-1', png }, lease: s.lease })).status).toBe(200)
    expect(existsSync(join(p.editorDir, `publish-${rec.n}`, 'shots', 'before-1.png'))).toBe(true)
    expect((await request(api, { path: 'publish/shot', body: { n: rec.n, name: '../x', png }, lease: s.lease })).status).toBe(400)
    expect((await request(api, { path: 'publish/shot', body: { n: rec.n, name: 'x', png: 'aGk=' }, lease: s.lease })).status).toBe(400)
    // Deploy: the plan says why not (a publish is open)
    const plan = (await request(api, { path: 'deploy' })).json()
    expect(plan.ok).toBe(false)
    expect(plan.sentence).toMatch(/still open/)
    expect((await request(api, { path: 'deploy/run', body: { confirm: true } })).status).toBe(409)
    // Test in game needs a ready publish and the lease
    expect((await request(api, { path: 'test' })).json().phase).toBe('off')
    expect((await request(api, { path: 'test/start', body: {} })).status).toBe(409)
  })
})
