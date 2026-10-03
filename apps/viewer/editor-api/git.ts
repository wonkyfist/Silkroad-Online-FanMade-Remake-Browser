/**
 * The few git calls the editor makes (docs/WORLD_EDITOR.md §6.1, §6.2 step 8, D36, D39): the pathspec commit of a
 * kept publish's `content/` files, and the Deploy refusals (uncommitted converter code, converter code newer than the
 * deployed release). Node only, no other dependency: both the Vite side (./deploy.ts) and the publish process
 * (./publish.ts) use it.
 */
import { execFileSync } from 'node:child_process'

/**
 * The code and content that write the shipped assets (§F16): changes here make an export the friends' client may not
 * read. texpipe writes the PBR index and map sets the assets-only deploy ships; content/texpipe and content/trees are
 * their data (H12-DP-1). Only sources count (`src/`, the content folders): a test, a doc or a fixture never blocks a
 * Deploy (H12-DP-3).
 */
export const CONVERTER_CODE = [
  'packages/convert/src', 'packages/shared/src', 'packages/nav/src', 'packages/formats/src', 'packages/texpipe/src',
  'content/texpipe', 'content/trees',
] as const

/** The editor's own commits ("World edits: ...", D39): a kept publish's layers and its hero flips, never new code. */
export const EDITOR_COMMIT = /^World edits: /

export class GitError extends Error {}

export function git(cwd: string, args: readonly string[], input?: string): string {
  try {
    return execFileSync('git', args as string[], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    })
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    throw new GitError(`git ${args[0]}: ${(err.stderr || err.message).trim().split('\n').slice(-3).join(' ')}`)
  }
}

/** Uncommitted changes (tracked, staged or not; untracked files too) under the paths. */
export function dirtyPaths(cwd: string, paths: readonly string[]): string[] {
  const out = git(cwd, ['status', '--porcelain', '--untracked-files=all', '--', ...paths])
  return out.split('\n').map(l => l.slice(3).trim()).filter(Boolean)
}

export function headCommit(cwd: string): string {
  return git(cwd, ['rev-parse', 'HEAD']).trim()
}

/** True when `sha` names a commit this repository has. */
export function hasCommit(cwd: string, sha: string): boolean {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false
  try {
    git(cwd, ['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

/** Commits after `from` (exclusive) up to HEAD that changed the paths (short hash + subject). */
export function commitsTouching(cwd: string, from: string, paths: readonly string[]): string[] {
  return git(cwd, ['log', '--format=%h %s', `${from}..HEAD`, '--', ...paths]).split('\n').map(l => l.trim()).filter(Boolean)
}

/**
 * Commits only `paths` (D39: "World edits: ..."), whatever else is staged or changed in the tree: the paths are added
 * (new files included, removed files recorded), then `git commit --only` takes exactly them. Returns the short hash, or
 * null when the paths hold no change.
 */
export function commitPaths(cwd: string, paths: readonly string[], message: string): string | null {
  if (!paths.length) return null
  git(cwd, ['add', '-A', '--', ...paths])
  const staged = git(cwd, ['diff', '--cached', '--name-only', '--', ...paths]).trim()
  if (!staged) return null
  git(cwd, [...identityArgs(cwd), 'commit', '--only', '--quiet', '-F', '-', '--', ...paths], message)
  return git(cwd, ['rev-parse', '--short', 'HEAD']).trim()
}

/**
 * `-c user.name=… -c user.email=…` from HEAD's author when the repository has no identity set (git refuses to commit
 * without one: "unable to auto-detect email address"); nothing when git has one.
 */
function identityArgs(cwd: string): string[] {
  try {
    if (git(cwd, ['config', 'user.email']).trim()) return []
  } catch {
    // unset: git config exits 1
  }
  const [name, email] = git(cwd, ['log', '-1', '--format=%an%n%ae']).split('\n').map(s => s.trim())
  return name && email ? ['-c', `user.name=${name}`, '-c', `user.email=${email}`] : []
}
