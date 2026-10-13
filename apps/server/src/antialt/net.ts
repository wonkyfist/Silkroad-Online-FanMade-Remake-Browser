import { isIP } from 'node:net'

/**
 * docs/ANTI_ALT.md §3: addresses, subnets and the real client address behind trusted proxies.
 *
 * An address is kept as text (IPv4 dotted, IPv6 as Node prints it); `::ffff:1.2.3.4` is the IPv4 address. The subnet of
 * an address is its /24 (IPv4) or /64 (IPv6), the usual size of one home or one VPS. A CIDR is parsed once to a range
 * of big integers (IPv4 and IPv6 apart), so a list match is a compare.
 */

export type Family = 4 | 6

export interface IpRange {
  family: Family
  start: bigint
  end: bigint
}

/** The address without an IPv4-mapped prefix, a zone id or brackets; '' when it is no address. */
export function normalizeIp(raw: string | undefined | null): string {
  if (!raw) return ''
  let s = raw.trim()
  if (s.startsWith('[')) s = s.slice(1, s.indexOf(']') > 0 ? s.indexOf(']') : undefined)
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s)
  if (mapped) s = mapped[1]
  const fam = isIP(s)
  if (fam === 4) return s
  if (fam === 6) return s.toLowerCase()
  return ''
}

/** The address as a number (family and value), or null. */
export function ipValue(ip: string): { family: Family; value: bigint } | null {
  const s = normalizeIp(ip)
  if (!s) return null
  if (isIP(s) === 4) {
    const p = s.split('.').map(Number)
    return { family: 4, value: BigInt(((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) }
  }
  // IPv6: expand '::' to the missing groups; an embedded IPv4 tail is two groups
  let text = s
  const v4tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (v4tail) {
    const p = v4tail[1].split('.').map(Number)
    text = text.slice(0, -v4tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16)
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null]
  const hs = head ? head.split(':') : []
  const ts = tail ? tail.split(':') : []
  const groups = tail === null ? hs : [...hs, ...Array<string>(8 - hs.length - ts.length).fill('0'), ...ts]
  if (groups.length !== 8) return null
  let v = 0n
  for (const g of groups) v = (v << 16n) | BigInt(parseInt(g || '0', 16))
  return { family: 6, value: v }
}

export function v4Text(v: bigint): string {
  const n = Number(v)
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

export function v6Text(v: bigint): string {
  const g: string[] = []
  for (let i = 7; i >= 0; i--) g.push(((v >> BigInt(i * 16)) & 0xffffn).toString(16))
  return g.join(':')
}

/** The /24 (IPv4) or /64 (IPv6) of an address, as a CIDR ('1.2.3.0/24', '2001:db8:0:1:0:0:0:0/64'); '' for no address. */
export function subnetOf(ip: string): string {
  const a = ipValue(ip)
  if (!a) return ''
  if (a.family === 4) return `${v4Text(a.value & 0xffffff00n)}/24`
  return `${v6Text(a.value & ~((1n << 64n) - 1n))}/64`
}

/** A CIDR ('10.0.0.0/8', '2001:db8::/32') or one address as a range; null when malformed. */
export function parseCidr(text: string): IpRange | null {
  const [addr, bits] = text.trim().split('/')
  const a = ipValue(addr)
  if (!a) return null
  const width = a.family === 4 ? 32 : 128
  const n = bits === undefined ? width : Number(bits)
  if (!Number.isInteger(n) || n < 0 || n > width || (bits !== undefined && !/^\d+$/.test(bits))) return null
  const host = (1n << BigInt(width - n)) - 1n
  return { family: a.family, start: a.value & ~host, end: (a.value & ~host) | host }
}

/** A range 'a.b.c.d-e.f.g.h' (both ends included) or a CIDR. */
export function parseRange(text: string): IpRange | null {
  const dash = text.indexOf('-')
  if (dash < 0) return parseCidr(text)
  const a = ipValue(text.slice(0, dash))
  const b = ipValue(text.slice(dash + 1))
  if (!a || !b || a.family !== b.family || b.value < a.value) return null
  return { family: a.family, start: a.value, end: b.value }
}

export function inRange(ip: string, r: IpRange): boolean {
  const a = ipValue(ip)
  return !!a && a.family === r.family && a.value >= r.start && a.value <= r.end
}

export function isLoopback(ip: string): boolean {
  const a = ipValue(ip)
  if (!a) return false
  return a.family === 4 ? a.value >> 24n === 127n : a.value === 1n
}

/** Parses a comma/space separated list of CIDRs; returns the ranges and the entries that did not parse. */
export function parseCidrList(text: string): { ranges: IpRange[]; bad: string[] } {
  const ranges: IpRange[] = []
  const bad: string[] = []
  for (const part of text.split(/[\s,]+/)) {
    if (!part) continue
    const r = parseCidr(part)
    if (r) ranges.push(r)
    else bad.push(part)
  }
  return { ranges, bad }
}

export interface ProxyTrust {
  /** The proxies whose forwarding headers are believed (Caddy on this host; Cloudflare's ranges when behind it). */
  trusted: IpRange[]
  /** The header that names the client: 'x-forwarded-for' (default) or 'cf-connecting-ip'. */
  header: 'x-forwarded-for' | 'cf-connecting-ip'
}

/**
 * The client's address (docs/ANTI_ALT.md §3.2). The forwarding header is read only when the socket's peer is a
 * trusted proxy; anyone else's header is ignored, so a player cannot name another address. X-Forwarded-For is walked
 * from the right (the nearest hop) past every trusted proxy: the first untrusted address is the client (a value the
 * client put at the left is never reached while a trusted proxy appended the real one).
 */
export function resolveClientIp(peer: string | undefined, headers: Record<string, string | string[] | undefined>, trust: ProxyTrust | null): string {
  const direct = normalizeIp(peer) || 'unknown'
  if (!trust || !trust.trusted.some((r) => inRange(direct, r))) return direct
  const isTrusted = (ip: string) => trust.trusted.some((r) => inRange(ip, r))
  const one = (h: string | string[] | undefined) => (Array.isArray(h) ? h.join(',') : (h ?? ''))
  if (trust.header === 'cf-connecting-ip') {
    const cf = normalizeIp(one(headers['cf-connecting-ip']).split(',')[0])
    return cf || direct
  }
  const hops = one(headers['x-forwarded-for'])
    .split(',')
    .map((s) => normalizeIp(s))
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]
    if (!hop) return direct // a malformed hop: stop believing the header
    if (!isTrusted(hop)) return hop
  }
  return direct
}
