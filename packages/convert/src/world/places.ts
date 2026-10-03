/**
 * GM `tp` places of a world export (docs/FIELDS.md §4.6), written to manifest.places (apps/server content.ts
 * manifestPlaces reads them; names must pass its placeName rule /^[a-z0-9_-]{1,32}$/, else they are dropped).
 *
 * - One place per client zone name (textzonename.txt English), grouped case-insensitively through the slug, so
 *   "Chinese Tomb" and "Chinese tomb" become one `chinese-tomb`; client spellings stay (`enterance-of-qin-shi-tomb`).
 * - Only the zone's regions inside the playable rectangle count (the server clamps every move to it); a zone with
 *   none gets no place.
 * - The point is the mean centre of those regions, snapped onto open terrain in the walkable component of the town
 *   spawn (the server's placement rule), searching rings out to PLACE_SEARCH_M; when nothing qualifies there, the
 *   centres of the zone's own regions are tried (nearest to the mean first). No point: no place, and a warning.
 *
 * Node-free: the caller passes the NavWorld of nav.bin and the region names.
 */
import { NAV_UNIT_M, NavGltf, type NavPosition, type NavWorld } from '@sro/nav'
import type { WorldPlace } from './manifest.ts'

/** Search radius around a zone centre (m). */
export const PLACE_SEARCH_M = 60
/** Ring spacing of the search (m). */
const RING_M = 2
const REGION_M = 192

/** Lower case, delete ' and ., every other run of non-[a-z0-9] becomes '-', trimmed. null when empty or > 32 chars. */
export function placeSlug(name: string): string | null {
  const s = name.toLowerCase().replace(/['.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s && s.length <= 32 ? s : null
}

export interface PlacesInput {
  /** NavWorld of the export's nav.bin (file space). */
  world: NavWorld
  /** manifest.space.originRegion. */
  origin: { x: number; z: number }
  /** The town spawn (glTF metres; manifest.spawn): places must share its walkable component. */
  spawn: { x: number; y: number; z: number }
  /** Region id -> zone name (data/zones.ts zoneNameIndex), and the export's regions. */
  zoneNames: ReadonlyMap<number, string>
  regions: ReadonlyArray<{ x: number; z: number }>
  /** Playable rectangle in region units (inclusive); default: every region. */
  playable?: { x0: number; x1: number; z0: number; z1: number }
  warnings?: string[]
}

const round3 = (v: number) => Math.round(v * 1000) / 1000 + 0

/** glTF centre of region (x, z) relative to the origin region's south-west corner. */
const regionCentre = (x: number, z: number, origin: { x: number; z: number }) =>
  ({ x: REGION_M * (x - origin.x) + REGION_M / 2, z: -REGION_M * (z - origin.z) - REGION_M / 2 })

export function buildPlaces(input: PlacesInput): WorldPlace[] {
  const g = new NavGltf(input.world, input.origin)
  const home = (() => {
    const p = g.locate(input.spawn.x, input.spawn.z, input.spawn.y)
    return p ? g.componentOf(p) : -1
  })()
  if (home < 0) input.warnings?.push('places: the spawn has no walkable component; places are not snapped to it')
  const inPlay = (x: number, z: number) => !input.playable ||
    (x >= input.playable.x0 && x <= input.playable.x1 && z >= input.playable.z0 && z <= input.playable.z1)

  // Groups: slug -> the display name first seen and the playable regions.
  const groups = new Map<string, { label: string; regions: Array<{ x: number; z: number }> }>()
  for (const r of input.regions) {
    const name = input.zoneNames.get((r.z << 8) | r.x)
    const slug = name ? placeSlug(name) : null
    if (!slug || !inPlay(r.x, r.z)) continue
    const grp = groups.get(slug) ?? { label: name!, regions: [] }
    grp.regions.push(r)
    groups.set(slug, grp)
  }

  const stand = (x: number, z: number): NavPosition | null => {
    const p = home >= 0 ? g.locateIn(x, z, Infinity, home) : g.locate(x, z, Infinity)
    if (!p || p.surface.kind !== 'terrain') return null
    const fx = g.fileX(x)
    const fz = g.fileZ(z)
    if (!input.world.terrainOpen(fx, fz) || !input.world.canStand(fx, fz, p.y / NAV_UNIT_M, 10)) return null
    return p
  }
  const search = (cx: number, cz: number): NavPosition | null => {
    for (let r = 0; r <= PLACE_SEARCH_M; r += RING_M) {
      const n = r === 0 ? 1 : Math.max(8, Math.round((2 * Math.PI * r) / RING_M))
      for (let k = 0; k < n; k++) {
        const a = (k / n) * 2 * Math.PI
        const p = stand(cx + Math.sin(a) * r, cz + Math.cos(a) * r)
        if (p) return p
      }
    }
    return null
  }

  const out: WorldPlace[] = []
  for (const [name, grp] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const centres = grp.regions.map(r => regionCentre(r.x, r.z, input.origin))
    const mx = centres.reduce((s, c) => s + c.x, 0) / centres.length
    const mz = centres.reduce((s, c) => s + c.z, 0) / centres.length
    let p = search(mx, mz)
    let how = 'the mean centre'
    if (!p) {
      const order = centres.map((c, i) => ({ c, i, d: Math.hypot(c.x - mx, c.z - mz) })).sort((a, b) => a.d - b.d)
      for (const o of order) {
        p = search(o.c.x, o.c.z)
        if (p) {
          const r = grp.regions[o.i]!
          how = `region ${r.x},${r.z}'s centre (nothing within ${PLACE_SEARCH_M} m of the mean centre)`
          break
        }
      }
    }
    if (!p) {
      input.warnings?.push(`places: ${name} (${grp.label}): no open terrain in the spawn's component near any of its ${grp.regions.length} region(s)`)
      continue
    }
    const off = Math.hypot(p.x - mx, p.z - mz)
    out.push({
      name,
      x: round3(p.x),
      y: round3(p.y),
      z: round3(p.z),
      source: `client textzonename.txt "${grp.label}" (${grp.regions.length} playable region(s)); snapped from ${how} ` +
        `onto open terrain in the town spawn's walkable component, ${off.toFixed(1)} m from the mean centre`,
    })
  }
  return out
}
