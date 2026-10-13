import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../config.ts'
import { parseRange, v4Text, v6Text, type IpRange } from '../antialt/net.ts'

/**
 * Refreshes the bundled anti-alt lists (docs/ANTI_ALT.md §4):  pnpm antialt:update
 *
 *   content/antialt/hosting-ranges.txt  datacenter / hosting ranges, merged per provider (`start-end<TAB>provider`)
 *   content/antialt/tor-exits.txt       Tor exit addresses
 *
 * Sources (each file's header repeats them):
 * - client9/ipcat datacenters.csv, MIT licence (https://github.com/client9/ipcat): many hosting providers, last updated 2023.
 * - The ranges the cloud providers publish for anyone to use (no licence stated; lists of facts): AWS, Google Cloud,
 *   Oracle Cloud, DigitalOcean, Linode/Akamai.
 * - The Tor Project's bulk exit list (https://check.torproject.org/torbulkexitlist), public.
 * A source that fails is skipped with a warning (the others still write); the server reads the files at start.
 */

const OUT = join(REPO_ROOT, 'content', 'antialt')

async function text(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'User-Agent': 'jangan-antialt-update' } })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.text()
}

type Source = { name: string; url: string; parse(body: string): string[] }

const SOURCES: Source[] = [
  {
    name: 'ipcat',
    url: 'https://raw.githubusercontent.com/client9/ipcat/master/datacenters.csv',
    // start,end,provider,url → one entry per line, labelled with the line's provider
    parse: (b) => b.split(/\r?\n/).filter(Boolean).map((l) => {
      const [s, e, name] = l.split(',')
      return `${s}-${e}\t${(name ?? 'hosting').trim()}`
    }),
  },
  {
    name: 'Amazon AWS',
    url: 'https://ip-ranges.amazonaws.com/ip-ranges.json',
    parse: (b) => {
      const j = JSON.parse(b) as { prefixes: { ip_prefix: string }[]; ipv6_prefixes: { ipv6_prefix: string }[] }
      return [...j.prefixes.map((p) => p.ip_prefix), ...j.ipv6_prefixes.map((p) => p.ipv6_prefix)]
    },
  },
  {
    name: 'Google Cloud',
    url: 'https://www.gstatic.com/ipranges/cloud.json',
    parse: (b) => (JSON.parse(b) as { prefixes: { ipv4Prefix?: string; ipv6Prefix?: string }[] }).prefixes.map((p) => p.ipv4Prefix ?? p.ipv6Prefix ?? '').filter(Boolean),
  },
  {
    name: 'Oracle Cloud',
    url: 'https://docs.oracle.com/iaas/tools/public_ip_ranges.json',
    parse: (b) => (JSON.parse(b) as { regions: { cidrs: { cidr: string }[] }[] }).regions.flatMap((r) => r.cidrs.map((c) => c.cidr)),
  },
  { name: 'DigitalOcean', url: 'https://digitalocean.com/geo/google.csv', parse: (b) => b.split(/\r?\n/).map((l) => l.split(',')[0].trim()).filter((s) => s.includes('/')) },
  { name: 'Linode', url: 'https://geoip.linode.com/', parse: (b) => b.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split(',')[0].trim()) },
]

function merge(ranges: IpRange[]): IpRange[] {
  const out: IpRange[] = []
  for (const fam of [4, 6] as const) {
    const list = ranges.filter((r) => r.family === fam).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
    let cur: IpRange | null = null
    for (const r of list) {
      if (cur && r.start <= cur.end + 1n) {
        if (r.end > cur.end) cur.end = r.end
      } else {
        if (cur) out.push(cur)
        cur = { ...r }
      }
    }
    if (cur) out.push(cur)
  }
  return out
}

const show = (r: IpRange) => (r.family === 4 ? `${v4Text(r.start)}-${v4Text(r.end)}` : `${v6Text(r.start)}-${v6Text(r.end)}`)

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const lines: string[] = []
  const used: string[] = []
  for (const s of SOURCES) {
    try {
      const entries = s.parse(await text(s.url))
      // group by label (ipcat names each line's provider; the others are one provider), merge, write
      const byLabel = new Map<string, IpRange[]>()
      for (const e of entries) {
        const [range, label = s.name] = e.split('\t')
        const r = parseRange(range)
        if (!r) continue
        let l = byLabel.get(label)
        if (!l) byLabel.set(label, (l = []))
        l.push(r)
      }
      let n = 0
      for (const [label, rs] of byLabel) for (const r of merge(rs)) {
        lines.push(`${show(r)}\t${label.replace(/\t/g, ' ')}`)
        n++
      }
      used.push(`${s.name} (${s.url}): ${n} ranges`)
      console.log(`${s.name}: ${n} ranges`)
    } catch (e) {
      console.warn(`skipped ${s.name}: ${(e as Error).message}`)
    }
  }
  const stamp = new Date().toISOString().slice(0, 10)
  writeFileSync(
    join(OUT, 'hosting-ranges.txt'),
    [
      `# Datacenter and hosting IP ranges for anti-alt detection (docs/ANTI_ALT.md §4). Generated ${stamp} by pnpm antialt:update.`,
      '# Sources: client9/ipcat datacenters.csv (MIT licence, github.com/client9/ipcat); the IP ranges AWS, Google Cloud, Oracle Cloud,',
      '# DigitalOcean and Linode publish for public use (lists of facts, no licence stated).',
      ...used.map((u) => `#   ${u}`),
      '# Format: start-end<TAB>provider (or a CIDR). Lines starting with # are comments.',
      ...lines,
      '',
    ].join('\n'),
  )
  try {
    const tor = (await text('https://check.torproject.org/torbulkexitlist')).split(/\r?\n/).map((s) => s.trim()).filter((s) => parseRange(s))
    writeFileSync(
      join(OUT, 'tor-exits.txt'),
      [`# Tor exit nodes (docs/ANTI_ALT.md §4). Generated ${stamp} by pnpm antialt:update from https://check.torproject.org/torbulkexitlist (public).`, ...tor, ''].join('\n'),
    )
    console.log(`Tor: ${tor.length} exits`)
  } catch (e) {
    console.warn(`skipped the Tor list: ${(e as Error).message}`)
  }
}

await main()
