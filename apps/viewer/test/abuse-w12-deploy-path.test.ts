/**
 * H-12 lens 16, the deploy path (docs/WAVE_PLAN8.md §6.7 item 16, D36, D37; docs/WORLD_EDITOR.md §6.1, §F16): the
 * editor's Deploy is `pnpm run deploy -- --assets-only`, which syncs ALL of work/out and work/out-opt (deploy.sh
 * `sync_tree`, minus DEPLOY_ASSET_EXCLUDE), not only the kept publish. Its refusals must therefore cover every writer
 * of what it ships:
 *
 * 1. packages/texpipe writes the terrain and tree map sets and the PBR index the client parses (format.ts, the
 *    `cover` field, `hero`); optimize-out copies them into out-opt/pbr, which ships. A texpipe commit newer than the
 *    deployed release (a half-tuned wave-13 re-encode) is not one of CONVERTER_CODE, so Deploy says yes and the
 *    friends get unreviewed sets on the old client.
 * 2. A full `optimize-out run` (≈ 15 min at X2, rewriting thousands of out-opt files) takes no lock, and Deploy's only
 *    "busy" check is work/out/.convert.lock: a Deploy clicked during the run hashes and ships a half-written out-opt.
 * 3. The other way round: an untracked test file under packages/convert/test (today: the hunt's own abuse files)
 *    makes Deploy refuse with "A build is in progress (the converter has unfinished changes)", though no test can
 *    write the export (seen live on 2026-10-02 against the real repo with the deployed release = HEAD's tree).
 */
import { EventEmitter } from 'node:events'
import { execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { optimizeOut } from '../../../packages/convert/src/optimize/run.ts'
import { DeployHandOff } from '../editor-api/deploy.ts'

const WORLD = 'jangan-fields'
const tmps: string[] = []
afterEach(() => {
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true })
})

const tmp = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `sro-h12-deploy-${tag}-`))
  tmps.push(d)
  return d
}
const put = (file: string, text: string) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}
const gitOut = (dir: string, ...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()

function fakeChild(): ChildProcess {
  const c = new EventEmitter() as ChildProcess
  Object.assign(c, { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null, pid: 1, kill: () => true })
  return c
}

/** A repo with the converter, texpipe and a kept publish, the deployed release = its first commit. */
function setup() {
  const repo = tmp('git')
  const g = (...a: string[]) => gitOut(repo, ...a)
  g('init', '-q')
  g('config', 'user.email', 'hunt@test.invalid')
  g('config', 'user.name', 'Hunt Test')
  g('config', 'commit.gpgsign', 'false')
  g('config', 'core.autocrlf', 'false')
  put(join(repo, 'packages', 'convert', 'src', 'a.ts'), 'export const a = 1\n')
  put(join(repo, 'packages', 'texpipe', 'src', 'format.ts'), 'export const TIERS = [512, 1024]\n')
  put(join(repo, 'content', 'texpipe', 'overrides.json'), '{}\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'release')
  const deployed = g('rev-parse', 'HEAD')
  const work = join(repo, 'work')
  put(join(work, 'editor', WORLD, 'published.json'), JSON.stringify({ kept: [{ n: 1, at: 'x', changes: ['Raised the ground'] }], deployedThrough: 0 }))
  // work/ is outside git in the real repo (.gitignore)
  put(join(repo, '.gitignore'), 'work/\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'World edits: raised the ground')
  let runs = 0
  const d = new DeployHandOff({
    repoRoot: repo, workRoot: work, world: WORLD, deployedCommit: async () => deployed, openPublish: () => null,
    runDeploy: () => {
      runs++
      return fakeChild()
    },
  })
  return { repo, work, d, g, runs: () => runs }
}

describe('H-12 lens 16: what the editor\'s assets-only Deploy lets through', () => {
  it('baseline: a kept publish on the deployed release\'s code may go', async () => {
    const s = setup()
    const p = await s.d.plan()
    expect(p.sentence).toMatch(/Send these map changes/)
    expect(p.ok).toBe(true)
  })

  it('refuses when texpipe (which writes the shipped map sets and PBR index) is newer than the deployed release', async () => {
    const s = setup()
    put(join(s.repo, 'packages', 'texpipe', 'src', 'format.ts'), 'export const TIERS = [512, 1024, 2048]\nexport const COVER = true\n')
    s.g('commit', '-q', '-am', 'Wave 13 step 1: terrain re-encode (ungated)')
    const p = await s.d.plan()
    expect(p.ok, p.sentence).toBe(false)
    const started = await s.d.start(true)
    expect(started.run).toBeUndefined()
    expect(s.runs()).toBe(0)
  })

  it('a full optimize-out run takes the lock Deploy checks (else Deploy ships a half-written out-opt)', async () => {
    const root = tmp('opt')
    const inDir = join(root, 'out')
    const outDir = join(root, 'out-opt')
    put(join(inDir, 'world', WORLD, 'town.json'), JSON.stringify({ a: 1 }))
    mkdirSync(outDir, { recursive: true })
    // a live owner holds the export lock (this very process: never stale)
    put(join(inDir, '.convert.lock', 'owner'), `sro convert pid=${process.pid} host=${hostname()} ${new Date().toISOString()}`)
    let threw = false
    try {
      await optimizeOut({ inDir, outDir, only: ['world/'], noCensus: true })
    } catch {
      threw = true
    }
    expect(existsSync(join(outDir, 'world', WORLD, 'town.json')), 'optimize-out wrote work/out-opt while the lock was held').toBe(false)
    expect(threw).toBe(true)
  })

  it('an untracked test file under packages/convert/test does not block Deploy ("A build is in progress")', async () => {
    const s = setup()
    put(join(s.repo, 'packages', 'convert', 'test', 'abuse-w12-x.test.ts'), 'it.todo(\'x\')\n')
    const p = await s.d.plan()
    expect(p.sentence).not.toMatch(/A build is in progress/)
    expect(p.ok).toBe(true)
  })
})
