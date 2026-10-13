import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ipValue, parseRange, type Family } from './net.ts'

/**
 * docs/ANTI_ALT.md §4: the bundled offline lists. `content/antialt/hosting-ranges.txt` holds datacenter and hosting
 * ranges (one `range<TAB>provider` per line, a range a CIDR or `start-end`), `content/antialt/tor-exits.txt` the Tor exit
 * addresses (one per line). Both are written by `pnpm antialt:update` (cli/antialt-update.ts), which notes the sources
 * and licences at the top of each file. Lines starting with # are comments.
 */

interface Span {
  start: bigint
  end: bigint
  label: string
}

/** Sorted, non-overlapping spans per family; a lookup is a binary search. */
export class RangeList {
  private readonly spans: Record<Family, Span[]> = { 4: [], 6: [] }

  constructor(entries: Iterable<{ range: string; label: string }>) {
    const raw: Record<Family, Span[]> = { 4: [], 6: [] }
    for (const e of entries) {
      const r = parseRange(e.range)
      if (r) raw[r.family].push({ start: r.start, end: r.end, label: e.label })
    }
    for (const fam of [4, 6] as const) {
      const list = raw[fam].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
      const out: Span[] = []
      for (const s of list) {
        const last = out[out.length - 1]
        if (last && s.start <= last.end + 1n) {
          if (s.end > last.end) last.end = s.end
        } else out.push({ ...s })
      }
      this.spans[fam] = out
    }
  }

  get size(): number {
    return this.spans[4].length + this.spans[6].length
  }

  /** The label of the range holding `ip`, or null. */
  match(ip: string): string | null {
    const a = ipValue(ip)
    if (!a) return null
    const list = this.spans[a.family]
    let lo = 0
    let hi = list.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const s = list[mid]
      if (a.value < s.start) hi = mid - 1
      else if (a.value > s.end) lo = mid + 1
      else return s.label
    }
    return null
  }
}

export function parseHostingFile(text: string): RangeList {
  const entries: { range: string; label: string }[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const [range, label] = line.split('\t')
    if (range) entries.push({ range: range.trim(), label: (label ?? 'hosting').trim() || 'hosting' })
  }
  return new RangeList(entries)
}

export function parseTorFile(text: string): RangeList {
  const entries: { range: string; label: string }[] = []
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (s && !s.startsWith('#')) entries.push({ range: s, label: 'Tor exit' })
  }
  return new RangeList(entries)
}

export interface Lists {
  hosting: RangeList
  tor: RangeList
}

/** Loads both lists from `<contentDir>/antialt/`; a missing file is an empty list (logged). */
export function loadLists(contentDir: string, log: (m: string) => void): Lists {
  const read = (name: string): string => {
    const f = join(contentDir, 'antialt', name)
    if (!existsSync(f)) {
      log(`anti-alt: ${name} is missing; that check matches nothing`)
      return ''
    }
    return readFileSync(f, 'utf8')
  }
  const lists = { hosting: parseHostingFile(read('hosting-ranges.txt')), tor: parseTorFile(read('tor-exits.txt')) }
  log(`anti-alt: ${lists.hosting.size} hosting ranges, ${lists.tor.size} Tor exits`)
  return lists
}
