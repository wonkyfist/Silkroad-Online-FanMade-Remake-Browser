/**
 * Area names of the world regions (docs/FIELDS.md §5.3, §6.2): /out/data/zones.json (one ZoneDef per region of the
 * jangan-fields export, client textzonename.txt names) indexed by region, for the zone label under the minimap
 * (UX-B, through zoneAt) and the world map's zone labels. Every world export shares one frame (origin region 168, 97;
 * docs/WAVE_PLAN.md decision 45), so the file serves the 3 x 3 'jangan' export as well.
 *
 * Region (rx, rz) covers glTF x in [192 (rx − ox), 192 (rx − ox + 1)] and z in [−192 (rz − oz + 1), −192 (rz − oz)]
 * (manifest space.regionOffsetRule: north is −z).
 */
import type { ZoneDef } from '@sro/shared'

export type ZoneEntry = Pick<ZoneDef, 'region' | 'rx' | 'rz' | 'name' | 'area' | 'continent' | 'town'>

/** The region the glTF origin sits in (manifest space.originRegion). */
export interface OriginRegion {
  x: number
  z: number
}

export const DEFAULT_ORIGIN: OriginRegion = { x: 168, z: 97 }
export const REGION_M = 192
/** Where zones.json is served, in order of preference (the data export; the slim tree has a copy). */
export const ZONES_URLS = ['/out/data/zones.json', '/out-opt/data/zones.json'] as const

/** The region containing glTF (x, z). */
export function regionOf(x: number, z: number, origin: OriginRegion = DEFAULT_ORIGIN): { rx: number; rz: number } {
  return { rx: origin.x + Math.floor(x / REGION_M), rz: origin.z + Math.floor(-z / REGION_M) }
}

/** glTF centre of region (rx, rz). */
export function regionCentre(rx: number, rz: number, origin: OriginRegion = DEFAULT_ORIGIN): { x: number; z: number } {
  return { x: (rx - origin.x + 0.5) * REGION_M, z: -(rz - origin.z + 0.5) * REGION_M }
}

/** Tolerant reader: the ContentFile-shaped wrapper ({ kind: 'zones', entries }) or a bare array; bad rows are skipped. */
export function parseZones(json: unknown): ZoneEntry[] {
  const rows = Array.isArray(json) ? json : (json as { entries?: unknown } | null)?.entries
  if (!Array.isArray(rows)) return []
  const out: ZoneEntry[] = []
  for (const r of rows as Partial<ZoneEntry>[]) {
    if (!r || typeof r !== 'object') continue
    const { rx, rz } = r
    if (!Number.isInteger(rx) || !Number.isInteger(rz)) continue
    if (r.region !== undefined && r.region !== ((rz! << 8) | rx!)) continue
    out.push({
      region: (rz! << 8) | rx!,
      rx: rx!,
      rz: rz!,
      name: typeof r.name === 'string' ? r.name.trim().slice(0, 64) : '',
      area: typeof r.area === 'string' ? r.area : null,
      continent: typeof r.continent === 'string' ? r.continent : null,
      ...(typeof r.town === 'string' ? { town: r.town } : {}),
    })
  }
  return out
}

/** One label per zone name on the world map: the mean of its regions' centres. */
export interface ZoneLabel {
  name: string
  x: number
  z: number
  regions: number
  /** Some of its regions belong to a town (towns.json). */
  town: boolean
}

export class ZoneIndex {
  private readonly byRegion = new Map<number, ZoneEntry>()
  /** Lower-cased name -> the spelling most regions use (the client has 'Chinese tomb' next to 'Chinese Tomb'). */
  private readonly spelling = new Map<string, string>()

  constructor(readonly entries: readonly ZoneEntry[], readonly origin: OriginRegion = DEFAULT_ORIGIN) {
    const votes = new Map<string, Map<string, number>>()
    for (const e of entries) {
      this.byRegion.set(e.region, e)
      if (!e.name) continue
      const key = e.name.toLowerCase()
      const v = votes.get(key) ?? new Map<string, number>()
      v.set(e.name, (v.get(e.name) ?? 0) + 1)
      votes.set(key, v)
    }
    for (const [key, v] of votes) this.spelling.set(key, [...v].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0])
  }

  /** The display spelling of a zone name. */
  private display(name: string): string {
    return this.spelling.get(name.toLowerCase()) ?? name
  }

  get size(): number {
    return this.byRegion.size
  }

  entry(rx: number, rz: number): ZoneEntry | undefined {
    return this.byRegion.get((rz << 8) | rx)
  }

  /**
   * The area name at glTF (x, z): the region's own name, else the named neighbouring region (of the 8 around it)
   * nearest to the point (docs/FIELDS.md §8, unnamed regions), else null (outside the file or nothing near).
   */
  nameAt(x: number, z: number): string | null {
    const { rx, rz } = regionOf(x, z, this.origin)
    const own = this.entry(rx, rz)
    if (own?.name) return this.display(own.name)
    let best: string | null = null
    let bestD = Infinity
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue
        const e = this.entry(rx + dx, rz + dz)
        if (!e?.name) continue
        const d = distToRegion(x, z, rx + dx, rz + dz, this.origin)
        if (d < bestD) {
          bestD = d
          best = this.display(e.name)
        }
      }
    }
    return best
  }

  /** Zone labels (named regions grouped by name, ignoring case, each at the mean of its region centres), sorted by name. */
  labels(): ZoneLabel[] {
    const groups = new Map<string, { sx: number; sz: number; n: number; town: boolean }>()
    for (const e of this.entries) {
      if (!e.name) continue
      const c = regionCentre(e.rx, e.rz, this.origin)
      const name = this.display(e.name)
      const g = groups.get(name) ?? { sx: 0, sz: 0, n: 0, town: false }
      g.sx += c.x
      g.sz += c.z
      g.n++
      g.town ||= !!e.town || !!e.area?.startsWith('Town_')
      groups.set(name, g)
    }
    return [...groups]
      .map(([name, g]) => ({ name, x: g.sx / g.n, z: g.sz / g.n, regions: g.n, town: g.town }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}

/** Distance (m) from glTF (x, z) to the rectangle of region (rx, rz). */
function distToRegion(x: number, z: number, rx: number, rz: number, origin: OriginRegion): number {
  const x0 = (rx - origin.x) * REGION_M
  const z1 = -(rz - origin.z) * REGION_M
  const dx = Math.max(x0 - x, 0, x - (x0 + REGION_M))
  const dz = Math.max(z1 - REGION_M - z, 0, z - z1)
  return Math.hypot(dx, dz)
}

// ---- the page's zone table (loaded once, lazily) -----------------------------------------------------------

let index: ZoneIndex | null = null
let loading: Promise<ZoneIndex | null> | null = null
let origin: OriginRegion = DEFAULT_ORIGIN

/** Loads zones.json once for the page (null when no URL serves it; the callers fall back to town/field). */
export function loadZones(fetchFn: typeof fetch = fetch, urls: readonly string[] = ZONES_URLS): Promise<ZoneIndex | null> {
  loading ??= (async () => {
    for (const url of urls) {
      try {
        const res = await fetchFn(url, { cache: 'no-cache' })
        if (!res.ok) continue
        const type = res.headers.get('content-type')
        if (type && !type.includes('json')) continue // a dev server's SPA fallback
        const entries = parseZones(await res.json())
        if (!entries.length) continue
        index = new ZoneIndex(entries, origin)
        return index
      } catch {
        // next URL
      }
    }
    console.warn('[map] zones.json unavailable; area names fall back to town/field')
    return null
  })()
  return loading
}

/** The loaded zone table (null until loadZones settled with one). */
export function zoneIndex(): ZoneIndex | null {
  return index
}

/** The world export's origin region (manifest space.originRegion); every export so far uses 168, 97. */
export function setZoneOrigin(o: OriginRegion): void {
  if (o.x === origin.x && o.z === origin.z) return
  origin = { x: o.x, z: o.z }
  if (index) index = new ZoneIndex(index.entries, origin)
}

/**
 * Area name at glTF (x, z) (e.g. 'Jangan', 'North-Tiger Mt.'), or null when unknown or still loading (the first call
 * starts the load). Stable signature: UX-B's minimap label calls it every half second.
 */
export function zoneAt(x: number, z: number): string | null {
  if (!index) {
    if (!loading && typeof fetch === 'function') void loadZones()
    return null
  }
  return index.nameAt(x, z)
}

/** Tests: forget the page's table. */
export function resetZones(): void {
  index = null
  loading = null
  origin = DEFAULT_ORIGIN
}
