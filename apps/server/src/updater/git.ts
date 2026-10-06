import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { run, type RunResult } from './exec.ts'

/**
 * The git side of self-updates (docs/UPDATES.md §2): what kind of install this is, whether `origin` is the configured
 * repository, fetching its branch and the fast-forward checks. Every command is a fixed `git` argument list with a
 * timeout and no prompts (GIT_TERMINAL_PROMPT=0). The commands that move HEAD (merge --ff-only, reset) run with
 * NO_HOOKS, so no hook (a versioned core.hooksPath included) runs code of the fetched commit. Node-only (no packages):
 * the supervisor runs it with plain `node`.
 */

export const GIT_TIMEOUT_MS = 60_000
/** A fetch may bring hundreds of MB of converted assets (work/). */
export const FETCH_TIMEOUT_MS = 30 * 60_000

export class GitError extends Error {
  readonly result: RunResult | null
  constructor(message: string, result: RunResult | null = null) {
    super(message)
    this.result = result
  }
}

/** `git -c` options that turn every hook off (a hooks folder that does not exist). */
export const NO_HOOKS = ['-c', 'core.hooksPath=.git/sro-updater-no-hooks'] as const

const GIT_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GCM_INTERACTIVE: 'never', LC_ALL: 'C' })

export async function git(root: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS, raw = false): Promise<string> {
  const r = await run('git', args, { cwd: root, timeoutMs, env: GIT_ENV() })
  if (r.timedOut) throw new GitError(`git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s`, r)
  if (r.code !== 0) throw new GitError(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `exit ${r.code}`}`, r)
  return raw ? r.stdout : r.stdout.trim()
}

/** git with a yes/no answer in the exit code (merge-base --is-ancestor, cat-file -e). */
async function gitOk(root: string, args: readonly string[]): Promise<boolean> {
  const r = await run('git', args, { cwd: root, timeoutMs: GIT_TIMEOUT_MS, env: GIT_ENV() })
  if (r.timedOut) throw new GitError(`git ${args[0]} timed out`, r)
  if (r.code === 0) return true
  if (r.code === 1) return false
  throw new GitError(`git ${args[0]} failed: ${r.stderr.trim()}`, r)
}

/**
 * A repository URL the updater accepts: https, a host and an /owner/repo path, no user name or password, no query.
 * `allowLocal` (tests only) also takes a local path (a bare repository in a temp directory). Returns the problem.
 */
export function repoUrlProblem(url: string, allowLocal = false): string | null {
  if (allowLocal && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url.trim() ? null : 'repoUrl is empty'
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'repoUrl must be an https URL like https://github.com/owner/repo'
  }
  if (u.protocol !== 'https:') return 'repoUrl must use https'
  if (u.username || u.password) return 'repoUrl must not contain a user name or password'
  if (u.search || u.hash) return 'repoUrl must not have a query or #fragment'
  if (!/^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?\/?$/.test(u.pathname)) return 'repoUrl must look like https://host/owner/repo'
  return null
}

/** A repository URL for comparing: lower-case host, no trailing slash or .git (local paths: resolved, lower-case on Windows). */
export function normalizeRepoUrl(url: string, allowLocal = false): string | null {
  const s = url.trim()
  if (repoUrlProblem(s, allowLocal) !== null) return null
  if (allowLocal && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let p = resolve(s)
    try {
      p = realpathSync(p)
    } catch {
      // not there (yet)
    }
    p = p.replace(/[\\/]+$/, '').replace(/\.git$/i, '').replace(/\\/g, '/')
    return process.platform === 'win32' ? p.toLowerCase() : p
  }
  const u = new URL(s)
  return `https://${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')}`
}

/** The repository's page (for links): the URL without .git. */
export function webUrlOf(repoUrl: string): string {
  return repoUrl.trim().replace(/\/+$/, '').replace(/\.git$/i, '')
}

export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
export const SHA_RE = /^[0-9a-f]{40}$/

export function branchProblem(branch: string): string | null {
  return BRANCH_RE.test(branch) && !branch.includes('..') && !branch.endsWith('/') && !branch.endsWith('.lock') ? null : 'branch must be a plain branch name like main'
}

export interface CommitInfo {
  commit: string
  date: number
  author: string
  subject: string
}

const SEP = '\x1f'
const LOG_FORMAT = `--format=%H${SEP}%ct${SEP}%an${SEP}%s`

function parseCommit(line: string): CommitInfo | null {
  const [commit, ct, author, ...rest] = line.split(SEP)
  if (!commit || !SHA_RE.test(commit)) return null
  return { commit, date: Number(ct) * 1000, author: author ?? '', subject: rest.join(SEP) }
}

export interface RepoInfo {
  kind: 'git' | 'zip' | 'deployed'
  /** Why the install is what it is, or what is wrong with the clone. */
  note: string
  head: CommitInfo | null
  /** The checked-out branch (null: detached HEAD). */
  branch: string | null
  /** origin's fetch URL as configured (null: no origin). */
  origin: string | null
  originOk: boolean
  /** Tracked files with local changes (at most 20). */
  dirty: string[]
  /** Windows: core.longpaths (null elsewhere or unset). */
  longPaths: boolean | null
}

/**
 * What kind of install `root` is. Only a git clone whose top level is `root` and whose `origin` is `repoUrl` may update
 * itself; a release unpacked by deploy/*.sh (it has .deploy-sha) is managed by those scripts; anything else is a ZIP.
 */
export async function inspectRepo(root: string, repoUrl: string, branch: string, allowLocal = false): Promise<RepoInfo> {
  const none: RepoInfo = { kind: 'zip', note: '', head: null, branch: null, origin: null, originOk: false, dirty: [], longPaths: null }
  if (existsSync(join(root, '.deploy-sha'))) return { ...none, kind: 'deployed', note: 'This server was installed by the deploy scripts (deploy/*.sh); they update it.' }
  if (!existsSync(join(root, '.git'))) return { ...none, note: 'This install is not a git clone (no .git folder), so it cannot update itself.' }
  let top: string
  try {
    top = await git(root, ['rev-parse', '--show-toplevel'])
  } catch (e) {
    return { ...none, note: `git does not work here: ${(e as Error).message}` }
  }
  const same = (a: string, b: string) => {
    const n = (p: string) => {
      let r = resolve(p)
      try {
        r = realpathSync(r)
      } catch {
        // keep
      }
      r = r.replace(/\\/g, '/').replace(/\/+$/, '')
      return process.platform === 'win32' ? r.toLowerCase() : r
    }
    return n(a) === n(b)
  }
  if (!same(top, root)) return { ...none, note: `The git repository here starts at ${top}, not at the server's folder.` }
  const info: RepoInfo = { ...none, kind: 'git' }
  const headLine = await git(root, ['log', '-1', LOG_FORMAT, 'HEAD']).catch(() => '')
  info.head = parseCommit(headLine)
  info.branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null)
  info.origin = await git(root, ['config', '--get', 'remote.origin.url']).catch(() => null)
  const want = normalizeRepoUrl(repoUrl, allowLocal)
  const have = info.origin ? normalizeRepoUrl(info.origin, allowLocal) : null
  info.originOk = want !== null && have !== null && want === have
  const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=no'], GIT_TIMEOUT_MS, true).catch(() => '')
  info.dirty = status.split('\n').map((l) => l.slice(3).trim()).filter(Boolean).slice(0, 20)
  if (process.platform === 'win32') {
    const lp = await git(root, ['config', '--get', 'core.longpaths']).catch(() => '')
    info.longPaths = lp === '' ? null : lp === 'true'
  }
  if (!info.origin) info.note = `This git clone has no "origin" remote, so it does not follow ${repoUrl}.`
  else if (!info.originOk) info.note = `origin is ${info.origin}, not ${repoUrl}: this clone follows another repository, so it does not update itself.`
  else if (info.branch !== branch) info.note = info.branch ? `The checked-out branch is ${info.branch}, not ${branch}.` : 'HEAD is detached (no branch checked out).'
  else info.note = `A git clone of ${repoUrl} (${branch}).`
  return info
}

/** Fetches the branch into refs/remotes/origin/<branch> (no tags) and returns its commit. */
export async function fetchBranch(root: string, branch: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  await git(root, ['-c', 'gc.auto=0', 'fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], timeoutMs)
  return remoteHead(root, branch)
}

export async function remoteHead(root: string, branch: string): Promise<string> {
  const sha = await git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`])
  if (!SHA_RE.test(sha)) throw new GitError(`origin/${branch} is not a commit`)
  return sha
}

/** The latest commit of the branch on the remote without a clone (ZIP installs): `git ls-remote`. */
export async function lsRemote(repoUrl: string, branch: string, cwd: string): Promise<string | null> {
  const out = await git(cwd, ['ls-remote', '--heads', repoUrl, `refs/heads/${branch}`], GIT_TIMEOUT_MS)
  const sha = out.split(/\s+/)[0] ?? ''
  return SHA_RE.test(sha) ? sha : null
}

export async function headCommit(root: string): Promise<string> {
  const sha = await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (!SHA_RE.test(sha)) throw new GitError('HEAD is not a commit')
  return sha
}

export async function commitInfo(root: string, sha: string): Promise<CommitInfo | null> {
  return parseCommit(await git(root, ['log', '-1', LOG_FORMAT, sha]).catch(() => ''))
}

export async function hasCommit(root: string, sha: string): Promise<boolean> {
  return SHA_RE.test(sha) && gitOk(root, ['cat-file', '-e', `${sha}^{commit}`])
}

/** `a` is an ancestor of (or equal to) `b`: moving from a to b is a fast-forward. */
export function isAncestor(root: string, a: string, b: string): Promise<boolean> {
  return gitOk(root, ['merge-base', '--is-ancestor', a, b])
}

/** Commits in b that a lacks (`git rev-list --count a..b`). */
export async function countBetween(root: string, a: string, b: string): Promise<number> {
  return Number(await git(root, ['rev-list', '--count', `${a}..${b}`])) || 0
}

/** The newest `max` commits in b that a lacks, newest first. */
export async function commitsBetween(root: string, a: string, b: string, max = 50): Promise<CommitInfo[]> {
  const out = await git(root, ['log', LOG_FORMAT, `--max-count=${max}`, `${a}..${b}`])
  return out.split('\n').map(parseCommit).filter((c): c is CommitInfo => c !== null)
}

/** Files added or changed from a to b under `path` (no renames: a rename is an add). */
export async function changedFiles(root: string, a: string, b: string, path: string): Promise<string[]> {
  const out = await git(root, ['diff', '--name-status', '--no-renames', a, b, '--', path])
  return out.split('\n').map((l) => l.split('\t')).filter((p) => p.length === 2 && (p[0] === 'A' || p[0] === 'M')).map((p) => p[1])
}

export async function listFiles(root: string, sha: string, path: string): Promise<string[]> {
  const out = await git(root, ['ls-tree', '--name-only', `${sha}:${path}`]).catch(() => '')
  return out.split('\n').filter(Boolean)
}

/** Moves the checked-out branch forward to `sha` (fast-forward only, no hooks). */
export async function mergeFastForward(root: string, sha: string): Promise<void> {
  await git(root, [...NO_HOOKS, 'merge', '--ff-only', '--no-edit', '--quiet', sha], 10 * 60_000)
}

/**
 * Moves the checked-out branch back to `sha` (a rollback). `reset --keep` first (it refuses to drop local changes);
 * `--hard` only when that fails, which drops just what the update itself changed (an update starts only from a clean tree).
 */
export async function resetTo(root: string, sha: string, log: (line: string) => void): Promise<void> {
  try {
    await git(root, [...NO_HOOKS, 'reset', '--keep', '--quiet', sha], 10 * 60_000)
  } catch (e) {
    log(`git reset --keep failed (${(e as Error).message}); using reset --hard`)
    await git(root, [...NO_HOOKS, 'reset', '--hard', '--quiet', sha], 10 * 60_000)
  }
}

/** A file's text at a commit (the fetched commit is never checked out to read it). */
export function showFile(root: string, sha: string, path: string): Promise<string> {
  return git(root, ['show', `${sha}:${path}`])
}
