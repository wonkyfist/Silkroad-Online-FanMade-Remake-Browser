import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { formatNewsDate, parseNewsFile, sortNews, type NewsEntry } from '@sro/shared'
import { REPO_ROOT } from '../config.ts'

/**
 * CHANGELOG.md at the repository root, made from the in-game "What's new" entries (content/changelog/*.md, docs/
 * CHANGELOG_WINDOW.md), so GitHub shows the same text and pictures as the game.  pnpm changelog
 * Newest first; drafts are left out; image paths are rewritten from the entries' `img/` to `content/changelog/img/`.
 */

const DIR = join(REPO_ROOT, 'content', 'changelog')
const IMG = 'content/changelog/img/'

/** The repo's published entries, newest first. */
export function loadEntries(dir = DIR): NewsEntry[] {
  const images = new Set(readdirSync(join(dir, 'img')))
  const entries: NewsEntry[] = []
  for (const file of readdirSync(dir).filter(f => f.endsWith('.md')).sort()) {
    const r = parseNewsFile(readFileSync(join(dir, file), 'utf8'), file.slice(0, -3), images)
    if ('problems' in r) throw new Error(`${file}: ${r.problems.join('; ')}`)
    if (!r.entry.draft) entries.push(r.entry)
  }
  return sortNews(entries)
}

/** An entry's Markdown with its image paths pointing at content/changelog/img/. */
export function rebaseImages(md: string): string {
  return md.replace(/\]\((?:img\/)?([a-z0-9][a-z0-9_-]*\.(?:jpg|jpeg|png|webp))/g, `](${IMG}$1`)
}

/** GitHub's heading anchor for a title. */
export function anchor(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-')
}

export function changelogMarkdown(entries: readonly NewsEntry[]): string {
  const out = [
    '# Changelog',
    '',
    'Every update to Jangan, newest first. This is the same text and pictures the game shows in its **What\'s new**',
    'window (press **J** in game). It is generated from `content/changelog/` by `pnpm changelog`; edit the entries there.',
    '',
  ]
  for (const e of entries) out.push(`- [${e.title}](#${anchor(e.title)})`)
  for (const e of entries) {
    out.push('', '---', '', `## ${e.title}`, '', `*${formatNewsDate(e.date)}*`, '', `**${e.summary}**`, '')
    if (e.hero) out.push(`![${e.title}](${IMG}${e.hero})`, '')
    out.push(rebaseImages(e.body).trim())
  }
  return out.join('\n') + '\n'
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const entries = loadEntries()
  writeFileSync(join(REPO_ROOT, 'CHANGELOG.md'), changelogMarkdown(entries))
  console.log(`CHANGELOG.md: ${entries.length} updates`)
}
