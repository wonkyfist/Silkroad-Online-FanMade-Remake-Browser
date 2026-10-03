/**
 * The Deploy hand-off (docs/WORLD_EDITOR.md §6.1, D36, §F16; docs/WAVE_PLAN8.md §3.4, D36, D37; lane WE-A): the map
 * edits go to the friends' server only through the existing deploy in its assets-only mode
 * (`pnpm run deploy -- --assets-only`, deploy/deploy.sh), only on the user's click, and never in the middle of a wave:
 *
 * - refused while a publish is open (Keep or Go back first), while a convert runs, or with nothing kept since the
 *   last deploy;
 * - refused when the converter's code (packages/convert, shared, nav, formats) has uncommitted changes: the export was
 *   written by unfinished code ("A build is in progress");
 * - refused when a commit newer than the deployed release changed that code, or when the deployed release cannot be
 *   read (the export may hold data the friends' client cannot read yet; code and map ship together at the release).
 *
 * The deployed release's commit is read from the mini PC (`cat silkroad/current/.deploy-sha` over the deploy's SSH,
 * deploy/lib.sh `remote`) only when the user opens the Deploy dialog. Node only.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CONVERTER_CODE, EDITOR_COMMIT, commitsTouching, dirtyPaths, hasCommit } from './git.ts'
import type { DeployState } from './protocol.ts'

export interface DeployOptions {
  repoRoot: string
  workRoot: string
  world: string
  /** The deployed release's commit, or null when it cannot be read (default: over SSH, deploy/lib.sh). */
  deployedCommit?: () => Promise<string | null>
  /** Starts the assets-only deploy (default: `node --import tsx deploy/run.ts deploy.sh --assets-only`). */
  runDeploy?: (cwd: string) => ChildProcess
  /** Whether a publish is open / a test runs (the API passes its own). */
  openPublish?: () => number | null
  now?: () => Date
}

interface PublishedIndexLite {
  kept: Array<{ n: number; at: string; changes: string[]; undone?: string; commit?: string }>
  deployedThrough: number
  deployedAt?: string
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** Git for Windows' bash (deploy/run.ts's rule), for the one remote read. */
function gitBash(): string {
  if (process.env.SRO_BASH) return process.env.SRO_BASH
  if (process.platform !== 'win32') return 'bash'
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim()
    const b = resolve(exec, '../../../bin/bash.exe')
    if (existsSync(b)) return b
  } catch {
    // fall through
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) if (base && existsSync(join(base, 'Git', 'bin', 'bash.exe'))) return join(base, 'Git', 'bin', 'bash.exe')
  return 'bash'
}

/** The deployed release's commit over the deploy's own SSH settings, or null (no answer in 20 s, no release). */
export function sshDeployedCommit(repoRoot: string): Promise<string | null> {
  return new Promise(res => {
    const child = spawn(gitBash(), ['-c', '. deploy/lib.sh && remote "cat silkroad/current/.deploy-sha 2>/dev/null || true"'], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (b: Buffer) => (out += b.toString()))
    const t = setTimeout(() => child.kill(), 20_000)
    child.on('close', () => {
      clearTimeout(t)
      const sha = out.trim()
      res(/^[0-9a-f]{40}$/.test(sha) ? sha : null)
    })
    child.on('error', () => res(null))
  })
}

export class DeployHandOff {
  private run: { phase: 'running' | 'done' | 'failed'; since: string; log: string[]; code?: number } | null = null
  private child: ChildProcess | null = null
  private readonly editorDir: string

  constructor(private readonly opts: DeployOptions) {
    this.editorDir = join(opts.workRoot, 'editor', opts.world)
  }

  private published(): PublishedIndexLite {
    const j = readJson<Partial<PublishedIndexLite>>(join(this.editorDir, 'published.json'))
    return { kept: j?.kept ?? [], deployedThrough: Number(j?.deployedThrough) || 0, ...(j?.deployedAt ? { deployedAt: j.deployedAt } : {}) }
  }

  /** The kept publishes the friends do not have yet. */
  pending(): PublishedIndexLite['kept'] {
    const idx = this.published()
    return idx.kept.filter(k => !k.undone && k.n > idx.deployedThrough)
  }

  /** May the map edits go now? The plan, with the sentence the dialog shows. */
  async plan(): Promise<DeployState> {
    const base = (ok: boolean, sentence: string, extra: Partial<DeployState> = {}): DeployState => ({
      ok, sentence, changes: this.pending().flatMap(k => k.changes.length ? k.changes : [`publish ${k.n}`]),
      ...(this.run ? { run: { ...this.run, log: this.run.log.slice(-40) } } : {}), ...extra,
    })
    if (this.run?.phase === 'running') return base(false, 'A deploy is running.')
    const open = this.opts.openPublish?.() ?? null
    if (open !== null) return base(false, `Publish ${open} is still open: keep it or go back first.`)
    if (existsSync(join(this.opts.workRoot, 'out', '.convert.lock'))) return base(false, 'A convert is running on this PC; deploy when it is done.')
    if (!this.pending().length) return base(false, 'Nothing to send: no publish was kept since the last deploy.')
    const deployed = await (this.opts.deployedCommit ?? (() => sshDeployedCommit(this.opts.repoRoot)))()
    if (!deployed) return base(false, 'The friends\' server did not say which version it runs (is it on, and is Tailscale up?). Nothing was sent.', { deployed: null })
    if (!hasCommit(this.opts.repoRoot, deployed)) {
      return base(false, 'The friends\' server runs a version this PC does not know; the map goes out with the next release.', { deployed })
    }
    // the more specific reason first (H12-DP-3); the editor's own "World edits" commits (hero flips) are not new code
    const newer = commitsTouching(this.opts.repoRoot, deployed, CONVERTER_CODE).filter(l => !EDITOR_COMMIT.test(l.replace(/^\S+\s+/, '')))
    if (newer.length) {
      return base(false, `The map was built by newer converter code than the friends' server runs (${newer.length} commit${newer.length === 1 ? '' : 's'}), so it goes out with the next release, or ask Claude.`, { deployed })
    }
    const dirty = dirtyPaths(this.opts.repoRoot, CONVERTER_CODE)
    if (dirty.length) {
      const list = dirty.slice(0, 3).join(', ') + (dirty.length > 3 ? ` and ${dirty.length - 3} more` : '')
      return base(false, `A build is in progress (unfinished changes in ${list}), so the map goes out with the next release, or ask Claude.`, { deployed })
    }
    return base(true, 'Send these map changes to the friends\' server now? The server restarts (about a minute) and players must reload the page.', { deployed })
  }

  /** The user's click (`confirm: true`): re-checks the plan, then runs the assets-only deploy. */
  async start(confirm: boolean): Promise<DeployState> {
    if (confirm !== true) return { ...(await this.plan()), ok: false, sentence: 'Deploy needs the click on "Deploy" in the dialog.' }
    const p = await this.plan()
    if (!p.ok) return p
    const through = Math.max(...this.pending().map(k => k.n))
    const since = (this.opts.now?.() ?? new Date()).toISOString()
    this.run = { phase: 'running', since, log: [] }
    const run = this.run
    const child = (this.opts.runDeploy ?? (cwd => spawn(process.execPath, ['--import', 'tsx', 'deploy/run.ts', 'deploy.sh', '--assets-only'], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })))(this.opts.repoRoot)
    this.child = child
    const take = (b: Buffer) => {
      // eslint-disable-next-line no-control-regex
      run.log.push(...b.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter(Boolean))
      if (run.log.length > 400) run.log.splice(0, run.log.length - 400)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('close', code => {
      run.code = code ?? -1
      run.phase = code === 0 ? 'done' : 'failed'
      this.child = null
      if (code === 0) {
        const idx = this.published()
        idx.deployedThrough = Math.max(idx.deployedThrough, through)
        idx.deployedAt = new Date().toISOString()
        writePublishedAtomic(join(this.editorDir, 'published.json'), idx)
      }
    })
    return { ...p, ok: false, sentence: 'Deploying the map changes...', run: { ...run } }
  }

  state(): DeployState | null {
    return this.run ? { ok: false, sentence: this.run.phase === 'running' ? 'Deploying the map changes...' : this.run.phase === 'done' ? 'Deployed. The friends reload the page to see it.' : 'The deploy failed; nothing else was changed. See the log.', changes: [], run: { ...this.run, log: this.run.log.slice(-40) } } : null
  }
}

function writePublishedAtomic(file: string, idx: PublishedIndexLite): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(idx, null, 1) + '\n')
  renameSync(tmp, file)
}
