import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Git fixtures for the updater tests (docs/UPDATES.md): a bare repository in a temp folder plays GitHub, `server` is
 * the server's clone of it (origin = the bare path), `dev` is where new commits are made and pushed. Nothing touches
 * the real repository or the network.
 */

export interface Repos {
  base: string
  origin: string
  server: string
  dev: string
  /** Commits `files` in dev (and pushes unless push=false); returns the new commit. */
  commit(message: string, files: Record<string, string>, push?: boolean): string
  /** git in the server clone. */
  git(...args: string[]): string
  head(dir?: string): string
  cleanup(): void
}

const ID = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main']

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...ID, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
  }
}

/** A bare origin with one commit (`initial` files), cloned to server and dev. */
export function makeRepos(initial: Record<string, string> = { 'README.md': 'v1\n' }): Repos {
  const base = mkdtempSync(join(tmpdir(), 'sro-upd-'))
  const origin = join(base, 'origin.git')
  const dev = join(base, 'dev')
  const server = join(base, 'server')
  git(base, 'init', '--bare', '-b', 'main', origin)
  git(base, 'clone', '-q', origin, dev)
  git(dev, 'checkout', '-q', '-b', 'main')
  write(dev, initial)
  git(dev, 'add', '-A')
  git(dev, 'commit', '-q', '-m', 'initial')
  git(dev, 'push', '-q', 'origin', 'main')
  git(base, 'clone', '-q', '-b', 'main', origin, server)
  return {
    base,
    origin,
    server,
    dev,
    commit(message, files, push = true) {
      write(dev, files)
      git(dev, 'add', '-A')
      git(dev, 'commit', '-q', '-m', message)
      if (push) git(dev, 'push', '-q', 'origin', 'main')
      return git(dev, 'rev-parse', 'HEAD')
    },
    git: (...args) => git(server, ...args),
    head: (dir = server) => git(dir, 'rev-parse', 'HEAD'),
    cleanup: () => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  }
}

/** A "What's new" entry file (content/changelog/<id>.md). */
export function changelogEntry(id: string, title: string, summary: string, date = '2026-10-06T12:00'): string {
  return `---\nid: ${id}\ndate: ${date}\ntitle: ${title}\nsummary: ${summary}\n---\n## ${title}\n\nBody of ${title}.\n`
}
