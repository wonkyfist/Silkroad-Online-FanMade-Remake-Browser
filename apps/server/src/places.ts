import { PLACE_GROUPS, type Place, type PlaceGroup } from './content.ts'
import type { MeshNav, NavPoint, NavProvider } from './nav.ts'
import type { Npc } from './world.ts'

/**
 * The GM teleport places at runtime (docs/PLAYTEST.md "Teleport places"): the startup check that keeps only places a
 * GM can stand on, the lookup by name or alias, the NPC search behind `tp npc <name>`, and the snapping helpers the
 * places tool (src/cli/places.ts) uses to author content/places.json on the real export.
 */

/** What the startup check needs of the world (World implements it). */
export interface PlaceWorld {
  placeFor(x: number, z: number, yHint: number): NavPoint | null
  clamp(x: number, z: number): [number, number]
}

/**
 * Keeps the places `tp` can use: inside the world bounds and on open ground (an open terrain cell or a walkable,
 * non-solid object floor) in the town spawn's walkable component within WARP_SEARCH_M, by the very rule `tp` uses
 * (World.placeFor). The world name and `spawn` are the town point and always kept. Each skipped place is logged with
 * the reason, then one summary line. In a flat world (no navmesh) every place is kept.
 */
export function checkPlaces(places: Place[], world: PlaceWorld, nav: NavProvider, town: readonly string[], log: (msg: string) => void): Place[] {
  if (nav.kind !== 'mesh') return places
  const mesh = nav as MeshNav
  const kept: Place[] = []
  const skipped = new Map<string, string[]>()
  for (const p of places) {
    const why = town.includes(p.name) ? null : placeProblem(p, world, mesh)
    if (!why) kept.push(p)
    else skipped.set(why, [...(skipped.get(why) ?? []), p.name])
  }
  const counts = PLACE_GROUPS.map((g) => [g, kept.filter((p) => p.group === g).length] as const).filter(([, n]) => n > 0)
  log(`places: ${kept.length} GM teleport places (${counts.map(([g, n]) => `${g} ${n}`).join(', ')})`)
  for (const [why, names] of skipped) log(`places: skipped ${names.length} (${why}): ${names.join(', ')}`)
  return kept
}

/** Why `tp` cannot use a place (null: it can). */
export function placeProblem(p: Pick<Place, 'x' | 'z' | 'y'>, world: PlaceWorld, nav: MeshNav): string | null {
  const [cx, cz] = world.clamp(p.x, p.z)
  if (Math.abs(cx - p.x) > 0.01 || Math.abs(cz - p.z) > 0.01) return 'outside the world bounds'
  const at = world.placeFor(p.x, p.z, p.y ?? Infinity)
  if (!at || !at.surface) return "no open ground within 10 m in the town spawn's walkable component"
  if (at.surface.kind === 'terrain' && !nav.terrainOpen(at.x, at.z)) return 'on a closed terrain cell'
  return null
}

/** A place by its name or one of its aliases. */
export function findPlace(places: readonly Place[], name: string): Place | undefined {
  return places.find((p) => p.name === name) ?? places.find((p) => p.aliases?.includes(name))
}

/** The `tp` list text: one line per group, in PLACE_GROUPS order. */
export function placesText(places: readonly Place[]): string {
  const lines = PLACE_GROUPS.flatMap((g) => {
    const names = places.filter((p) => p.group === g).map((p) => (p.aliases?.length ? `${p.name} (${p.aliases.join(', ')})` : p.name))
    return names.length ? [`${GROUP_LABEL[g]}: ${names.join(', ')}`] : []
  })
  return [`${places.length} places (tp <place>, tp npc <name>):`, ...lines].join('\n')
}

export const GROUP_LABEL: Record<PlaceGroup, string> = { town: 'Town', fields: 'Fields', coast: 'Coast', bosses: 'Bosses', other: 'Other' }

/**
 * NPCs for `tp npc <query>`: case-insensitive; an NPC whose whole name (or code) equals the query wins, else every NPC
 * whose name or code contains it. Several NPCs of one name (two storage-keepers are two names) are one match only when
 * they share the name exactly.
 */
export function findNpcs(npcs: Iterable<Npc>, query: string): Npc[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!q) return []
  const all = [...npcs]
  const exact = all.filter((n) => n.name.toLowerCase() === q || n.code.toLowerCase() === q)
  if (exact.length > 0) return exact
  return all.filter((n) => n.name.toLowerCase().includes(q) || n.code.toLowerCase().includes(q))
}

// ---- snapping (the places tool) ----------------------------------------------------------------------

export interface SnapOptions {
  /** Search radius (m) around the target. */
  radius: number
  /** Ring step (m). Default 1. */
  step?: number
  /** Cheap condition on a candidate x/z, checked first (e.g. inside its area). */
  where?: (x: number, z: number) => boolean
  /** Condition on a standing candidate (e.g. above the sea level). */
  accept?: (p: NavPoint) => boolean
  /** Height hint at the target (default: the highest open surface). */
  yHint?: number
  /** Free radius (m): every point this far around must stand too (default 1.5; 0 = none). */
  clearance?: number
}

/**
 * The nearest open point to (x, z) by the startup check's rule: it stands by MeshNav.place (the town spawn's walkable
 * component, not inside a solid footprint), an open terrain cell when on terrain, and the ground `clearance` around it
 * stands too (no landing wedged against a wall). Rings outwards; null when none within `radius`.
 */
export function snapOpen(nav: MeshNav, x: number, z: number, opts: SnapOptions): NavPoint | null {
  const step = opts.step ?? 1
  const clearance = opts.clearance ?? 1.5
  const hint = opts.yHint ?? Infinity
  const good = (cx: number, cz: number): NavPoint | null => {
    if (opts.where && !opts.where(cx, cz)) return null
    const p = nav.place(cx, cz, hint)
    if (!p || !p.surface) return null
    if (p.surface.kind === 'terrain' && !nav.terrainOpen(p.x, p.z)) return null
    if (opts.accept && !opts.accept(p)) return null
    if (clearance > 0) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * 2 * Math.PI
        const q = nav.place(cx + Math.sin(a) * clearance, cz + Math.cos(a) * clearance, p.y)
        if (!q || Math.abs(q.y - p.y) > 1) return null
      }
    }
    return p
  }
  const here = good(x, z)
  if (here) return here
  for (let r = step; r <= opts.radius; r += step) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / step))
    for (let k = 0; k < n; k++) {
      const a = (k / n) * 2 * Math.PI
      const p = good(x + Math.sin(a) * r, z + Math.cos(a) * r)
      if (p) return p
    }
  }
  return null
}
