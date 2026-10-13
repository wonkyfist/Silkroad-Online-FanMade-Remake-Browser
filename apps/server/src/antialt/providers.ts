/**
 * docs/ANTI_ALT.md §4.3, §6: the optional online parts, both off until the owner puts keys in the environment.
 *
 * - An external VPN/proxy lookup (`ANTIALT_LOOKUP=proxycheck` + `PROXYCHECK_KEY`). Answers are cached for 6 hours; a
 *   slow or failing provider counts as "not a proxy" (the bundled lists still apply), so it never locks players out.
 * - Cloudflare Turnstile on register (`TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`).
 */

export interface LookupResult {
  proxy: boolean
  /** e.g. 'VPN', 'Hosting', 'TOR' (the provider's word). */
  kind: string
}

export interface ProxyLookupProvider {
  readonly name: string
  lookup(ip: string): Promise<LookupResult | null>
}

type Fetch = typeof fetch

/** proxycheck.io v2: GET https://proxycheck.io/v2/<ip>?key=…&vpn=1 → {status, <ip>: {proxy: 'yes'|'no', type}}. */
export function proxycheckProvider(key: string, fetchImpl: Fetch = fetch, timeoutMs = 2500): ProxyLookupProvider {
  return {
    name: 'proxycheck.io',
    async lookup(ip) {
      const url = `https://proxycheck.io/v2/${encodeURIComponent(ip)}?key=${encodeURIComponent(key)}&vpn=1`
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return null
      const body = (await res.json()) as Record<string, unknown>
      const row = body[ip] as { proxy?: string; type?: string } | undefined
      if (!row || typeof row.proxy !== 'string') return null
      return { proxy: row.proxy === 'yes', kind: typeof row.type === 'string' ? row.type : 'proxy' }
    },
  }
}

/** The provider the environment asks for, or null. */
export function providerFromEnv(env: NodeJS.ProcessEnv): ProxyLookupProvider | null {
  const which = (env.ANTIALT_LOOKUP ?? '').toLowerCase()
  if (which === 'proxycheck' && env.PROXYCHECK_KEY) return proxycheckProvider(env.PROXYCHECK_KEY)
  return null
}

const CACHE_MS = 6 * 3_600_000
const CACHE_MAX = 20_000

/** A provider with a cache and fail-open errors. `cached` answers without asking (character creation is synchronous). */
export class CachedLookup {
  private readonly cache = new Map<string, { at: number; r: LookupResult | null }>()

  constructor(
    readonly provider: ProxyLookupProvider,
    private readonly log: (m: string) => void,
  ) {}

  cached(ip: string, now = Date.now()): LookupResult | null {
    const c = this.cache.get(ip)
    return c && now - c.at < CACHE_MS ? c.r : null
  }

  async lookup(ip: string, now = Date.now()): Promise<LookupResult | null> {
    const c = this.cache.get(ip)
    if (c && now - c.at < CACHE_MS) return c.r
    let r: LookupResult | null = null
    try {
      r = await this.provider.lookup(ip)
    } catch (e) {
      this.log(`anti-alt: ${this.provider.name} lookup failed: ${(e as Error).message}`)
    }
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(ip, { at: now, r })
    return r
  }
}

export interface Captcha {
  siteKey: string
  verify(token: string, ip: string): Promise<boolean>
}

/** Cloudflare Turnstile (siteverify); null without both keys. A failed call refuses (the player can try again). */
export function turnstileFromEnv(env: NodeJS.ProcessEnv, fetchImpl: Fetch = fetch): Captcha | null {
  const siteKey = env.TURNSTILE_SITE_KEY
  const secret = env.TURNSTILE_SECRET_KEY
  if (!siteKey || !secret) return null
  return {
    siteKey,
    async verify(token, ip) {
      try {
        const body = new URLSearchParams({ secret, response: token, remoteip: ip })
        const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(5000) })
        const j = (await res.json()) as { success?: boolean }
        return j.success === true
      } catch {
        return false
      }
    },
  }
}
