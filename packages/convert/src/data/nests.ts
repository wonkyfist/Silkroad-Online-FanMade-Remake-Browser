/**
 * nests.json / all-nests.json: the port's spawns.json (the original Tab_RefNest/Hive/Tactics rows, server-only in
 * vSRO) converted into NestDef in our world frame. The port frame is derived from NPCs both sides place
 * (portFrameAnchors + frame.ts fitPortFrame), never assumed.
 */
import type { NpcPosRow } from '@sro/formats'
import { PROVENANCE_PORT, type NestDef } from '../../../shared/src/content.ts'
import {
  fileRegion,
  fileToWorld,
  mm,
  portDistanceToMetres,
  portToFile,
  regionLocalToFile,
  type FilePos,
  type FrameAnchor,
  type PortFrame,
  type WorldFrame,
} from './frame.ts'
import type { PortData, PortNest } from './port-source.ts'

/** The zone whose nests are enabled by default. */
export const DEFAULT_ZONE = 'jangan_province'

/**
 * Anchors for the port frame: NPCs placed by the port (npcshops.json placements by sroCode; teleporters.json by
 * teleport code -> teleportdata AssocRefObjId) that the client npcpos.txt places exactly once. Only the retail
 * `*_province` zones are used (the port's `*_deprecated` and town-only zones use other frames).
 */
export function portFrameAnchors(
  port: Pick<PortData, 'shops' | 'teleporters'>,
  npcPos: readonly NpcPosRow[],
  charIdByCode: ReadonlyMap<string, number>,
  teleportRefByCode: ReadonlyMap<string, number>,
): FrameAnchor[] {
  const rowsById = new Map<number, NpcPosRow[]>()
  for (const p of npcPos) {
    if (p.region < 0) continue
    const list = rowsById.get(p.refId)
    if (list) list.push(p)
    else rowsById.set(p.refId, [p])
  }
  const single = (id: number | undefined) => {
    const list = id === undefined ? undefined : rowsById.get(id)
    return list && list.length === 1 ? list[0]! : undefined
  }
  const out: FrameAnchor[] = []
  const add = (label: string, x: number, z: number, row: NpcPosRow | undefined) => {
    if (row) out.push({ label, port: { x, z }, file: regionLocalToFile(row.region, row.x, row.y, row.z) })
  }
  for (const s of port.shops) {
    if (!s.sroCode) continue
    const row = single(charIdByCode.get(s.sroCode))
    for (const p of s.placements ?? []) if (/_province$/.test(p.zone)) add(`${s.sroCode}@${p.zone}`, p.x, p.z, row)
  }
  for (const [zone, list] of Object.entries(port.teleporters)) {
    if (!/_province$/.test(zone)) continue
    for (const t of list) add(`${t.id.toUpperCase()}@${zone}`, t.x, t.z, single(teleportRefByCode.get(t.id.toUpperCase())))
  }
  // One anchor per (label): the same NPC listed by both files counts once.
  const seen = new Set<string>()
  return out.filter(a => (seen.has(a.label) ? false : (seen.add(a.label), true)))
}

export type NestRecord = NestDef & { enabled: boolean; inConvertedRegion: boolean; uniqueGroup?: string; level?: number }

export function zoneWorldName(zone: string, world: WorldFrame): string {
  return zone === DEFAULT_ZONE ? world.name : zone.replace(/_province$/, '')
}

export function buildNest(n: PortNest, zone: string, frame: PortFrame, world: WorldFrame, uniqueCodes: ReadonlySet<string>): NestRecord {
  const file: FilePos = portToFile(n, frame)
  const p = fileToWorld(file, world)
  const region = fileRegion(file)
  const m = (d: number) => mm(portDistanceToMetres(d, frame))
  const raw: Record<string, number> = { aggressTypeRaw: n.aggressTypeRaw, sightRangeU: n.sightRangeU, traceBoundaryU: n.traceBoundaryU }
  if (n.staminaRaw !== undefined) raw.staminaRaw = n.staminaRaw
  if (n.staminaVarPct !== undefined) raw.staminaVarPct = n.staminaVarPct
  if (n.respawn !== undefined) raw.respawn = n.respawn
  const nest: NestRecord = {
    id: n.nestId,
    mob: n.vsroCode,
    x: mm(p.x),
    z: mm(p.z),
    region,
    radius: m(n.radius),
    spawnRadius: m(n.spawnRadius),
    count: n.count,
    respawnSec: [n.respawnDelaySec[0], n.respawnDelaySec[1]],
    tactics: {
      id: n.tacticsId,
      aggressive: n.aggressTypeRaw === 0,
      sightRange: m(n.sightRangeU),
      leashRange: m(n.traceBoundaryU),
      raw,
    },
    world: zoneWorldName(zone, world),
    provenance: PROVENANCE_PORT,
    source: { file: 'spawns.json', zone, x: n.x, z: n.z },
    enabled: zone === DEFAULT_ZONE,
    inConvertedRegion: world.regions.has(region),
  }
  if (n.y !== undefined) {
    nest.y = mm(p.y)
    nest.source.y = n.y
  }
  if (n.championPct !== undefined) nest.championPct = n.championPct
  if (n.level !== undefined) nest.level = n.level
  if (uniqueCodes.has(n.vsroCode)) nest.uniqueGroup = n.vsroCode
  return nest
}

export function buildNests(port: Pick<PortData, 'spawns'>, frame: PortFrame, world: WorldFrame, uniqueCodes: ReadonlySet<string>): NestRecord[] {
  const out: NestRecord[] = []
  for (const [zone, list] of Object.entries(port.spawns)) for (const n of list) out.push(buildNest(n, zone, frame, world, uniqueCodes))
  return out
}

/** Terrain probe for the evidence report: undefined when the region's navmesh is not available. */
export type TerrainProbe = (p: FilePos) => { open: boolean; heightM: number } | undefined

export interface TerrainEvidence {
  zone: string
  nests: number
  probed: number
  /** Nest centres on an open (walkable) terrain cell. */
  open: number
  /** |terrain height - nest y| in metres. */
  medianDyM: number
  p90DyM: number
  maxDyM: number
}

export function terrainEvidence(port: Pick<PortData, 'spawns'>, frame: PortFrame, probe: TerrainProbe): TerrainEvidence[] {
  const out: TerrainEvidence[] = []
  for (const [zone, list] of Object.entries(port.spawns)) {
    const dys: number[] = []
    let open = 0
    let probed = 0
    for (const n of list) {
      const f = portToFile(n, frame)
      const t = probe(f)
      if (!t) continue
      probed++
      if (t.open) open++
      if (n.y !== undefined) dys.push(Math.abs(t.heightM - f.y / 10))
    }
    dys.sort((a, b) => a - b)
    const q = (p: number) => (dys.length ? mm(dys[Math.min(dys.length - 1, Math.floor(dys.length * p))]!) : NaN)
    out.push({ zone, nests: list.length, probed, open, medianDyM: q(0.5), p90DyM: q(0.9), maxDyM: q(1) })
  }
  return out
}
