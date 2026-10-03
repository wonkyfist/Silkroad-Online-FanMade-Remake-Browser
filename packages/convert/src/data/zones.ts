/**
 * data/zones.json (docs/FIELDS.md §6.2): every region of a world export with its client names.
 *
 * - name: textzonename.txt (UTF-16LE; rows `1 <regionId> <Korean> … <English> …`), the column headed `English` in
 *   its `//Service CodeName128 …` header row (tab field 8, 0-based), for the region id; '' when the client has none.
 * - continent / area: refregion.txt `<regionId> <rx> <rz> <ContinentName> <AreaName> …` fields 3 and 4. AreaName
 *   is kept only when it is a readable code (Town_Jangan); in this client the others are literal '?' runs.
 * - town: the towns.json code of the town whose `regions` lists the region.
 * - coast areas (P-DATA, wave 10r polish): a region the client has no name for gets the `area` of its coast section
 *   (content/coast/coast.json, `coastAreaNamer`) when the coast shapes it: a synthetic region, a ring region outside
 *   the playable rectangle (but not the Option A corridor's land), or a playable region inside a height patch (the S1
 *   beach row). So the character list, the HUD and the minimap read 'Jangan South Beach' there, not the town name or
 *   the nearest retail zone. Other nameless regions stay '' (the client and the server take the nearest named
 *   neighbour).
 *
 * The file is a ContentFile-shaped wrapper with kind 'zones' (the towns.json pattern: not part of CONTENT_FILES).
 * Pure over its inputs; tools/export-data.ts does the I/O.
 */
import { CONTENT_SCHEMA_VERSION, ZONES_FILE, type ZoneDef } from '../../../shared/src/content.ts'
import { checkZoneDef } from '../../../shared/src/content-check.ts'
import type { CoastConfig } from '../world/coast/config.ts'
import type { RegionRect } from '../world/coast/lattice.ts'
import { controlPoints } from '../world/coast/sections.ts'

export const ZONES_FILE_NAME = ZONES_FILE

/** One region of the world export with its client names (packages/shared ZoneDef, FIELDS §6.2). */
export type ZoneRecord = ZoneDef

export interface ZonesInput {
  /** The export's regions (manifest.regions order); `synthetic`: made by the coast pass (no retail terrain). */
  regions: ReadonlyArray<{ x: number; z: number; synthetic?: boolean }>
  /** textzonename.txt rows (cells) and its header row (for the 'English' column). */
  zoneNames: ReadonlyArray<readonly string[]>
  zoneHeader?: readonly string[]
  /** refregion.txt rows (cells). */
  refregion: ReadonlyArray<readonly string[]>
  /** Towns with their region ids (towns.json entries). */
  towns?: ReadonlyArray<{ code: string; regions?: readonly number[] }>
  /** The coast's area name of a nameless region (`coastAreaNamer`), or null. */
  coastArea?: (rx: number, rz: number, synthetic: boolean) => string | null
}

/** textzonename.txt tab field of the English name when the header does not say (0-based). */
export const ZONE_NAME_ENGLISH_FIELD = 8
const AREA_CODE = /^[A-Za-z0-9_]{1,64}$/
const MAX_NAME = 64

/** Region id -> English zone name from textzonename.txt (service rows only; the first row of an id wins; '' skipped). */
export function zoneNameIndex(rows: ReadonlyArray<readonly string[]>, header?: readonly string[]): Map<number, string> {
  const h = header?.findIndex(c => c.trim().toLowerCase() === 'english') ?? -1
  const col = h >= 0 ? h : ZONE_NAME_ENGLISH_FIELD
  const out = new Map<number, string>()
  for (const c of rows) {
    if (c[0]?.trim() !== '1') continue
    const id = Number(c[1]?.trim())
    const name = (c[col] ?? '').trim()
    if (!Number.isInteger(id) || !name || out.has(id)) continue
    out.set(id, name.slice(0, MAX_NAME))
  }
  return out
}

export function buildZones(input: ZonesInput): ZoneRecord[] {
  const names = zoneNameIndex(input.zoneNames, input.zoneHeader)
  const ref = new Map<number, readonly string[]>()
  for (const c of input.refregion) {
    const id = Number(c[0]?.trim())
    if (Number.isInteger(id) && !ref.has(id)) ref.set(id, c)
  }
  const townOf = new Map<number, string>()
  for (const t of input.towns ?? []) for (const id of t.regions ?? []) if (!townOf.has(id)) townOf.set(id, t.code)
  return input.regions.map(({ x, z, synthetic }) => {
    const region = (z << 8) | x
    const r = ref.get(region)
    const area = r?.[4]?.trim() ?? ''
    const continent = r?.[3]?.trim() ?? ''
    const town = townOf.get(region)
    return {
      region,
      rx: x,
      rz: z,
      name: names.get(region) ?? input.coastArea?.(x, z, !!synthetic) ?? '',
      area: AREA_CODE.test(area) ? area : null,
      continent: r && continent ? continent : null,
      ...(town ? { town } : {}),
    }
  })
}

/**
 * The coast's area names (see the header) for `buildZones`: `play` is the playable rectangle (manifest stream.playable,
 * regions, inclusive). A region in a height patch takes the section the patch is named after (S1, 'S2-bank' -> S2);
 * any other one the section whose control point (./coast/sections.ts) lies nearest to its centre.
 */
export function coastAreaNamer(cfg: CoastConfig, play: RegionRect): (rx: number, rz: number, synthetic: boolean) => string | null {
  const area = new Map(cfg.sections.filter(s => s.area && s.phase <= cfg.phase).map(s => [s.code, s.area!]))
  const points = controlPoints(cfg, play).filter(p => area.has(p.code))
  const inPlay = (rx: number, rz: number) => rx >= play.x0 && rx <= play.x1 && rz >= play.z0 && rz <= play.z1
  const corr = cfg.corridor
  return (rx, rz) => {
    if (inPlay(rx, rz)) {
      for (const p of cfg.allowHeightPatches) {
        if (p.x[0] < rx + 1 && p.x[1] > rx && p.z[0] < rz + 1 && p.z[1] > rz) return area.get(p.name.split('-')[0]!) ?? null
      }
      return null
    }
    const cx = rx + 0.5
    const cz = rz + 0.5
    if (corr && cx >= corr.x[0] && cx <= corr.x[1] && cz >= corr.z[0] && cz <= corr.z[1]) return null
    let best: string | null = null
    let bestD = Infinity
    for (const p of points) {
      const d = (p.x - cx) ** 2 + (p.z - cz) ** 2
      if (d < bestD) {
        bestD = d
        best = area.get(p.code)!
      }
    }
    return best
  }
}

/** The FIELDS §6.2 check rules; returns the problems (empty = valid). */
export function checkZones(zones: readonly ZoneRecord[]): string[] {
  const out: string[] = []
  const seen = new Set<number>()
  zones.forEach((z, i) => {
    const p = `zones[${i}]`
    // The shared rule (packages/shared content-check.ts), plus uniqueness per region.
    out.push(...checkZoneDef(z, p))
    if (seen.has(z.region)) out.push(`${p}: duplicate region ${z.region}`)
    seen.add(z.region)
  })
  return out
}

/** zones.json text: { schema, kind: 'zones', generatedAt, worldExport, sources, entries } (worldExport: the export folder). */
export function serializeZones(zones: readonly ZoneRecord[], worldExport: string, generatedAt: string, extraSources: readonly string[] = []): string {
  return JSON.stringify({
    schema: CONTENT_SCHEMA_VERSION,
    kind: 'zones',
    generatedAt,
    worldExport,
    sources: ['client:textzonename.txt', 'client:refregion.txt', `world:${worldExport}/manifest.json (regions)`, 'towns.json (town regions)', ...extraSources],
    entries: zones,
  }, null, 2) + '\n'
}
