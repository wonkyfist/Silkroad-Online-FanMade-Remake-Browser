/**
 * Game content export (docs/DATA.md): client textdata + the port's server-only data -> the content files of
 * packages/shared/src/content.ts (mobs, nests, items, skills, masteries, npcs, shops, drops) plus all-nests.json
 * and towns.json. Pure over its inputs; tools/export-data.ts does the I/O.
 */
import {
  CONTENT_FILES,
  CONTENT_SCHEMA_VERSION,
  PROVENANCE_PORT,
  type ContentFile,
  type ContentKind,
  type CosDef,
  type DropTable,
  type ItemDef,
  type MasteryDef,
  type MobDef,
  type ShopDef,
  type SkillDef,
} from '../../../shared/src/content.ts'
import { checkContentFile } from '../../../shared/src/content-check.ts'
import type { SkillDataRow } from '@sro/formats'
import { indexByCode, indexById, type ClientSources } from './client-source.ts'
import { buildCos } from './cos.ts'
import { buildDrops, type DropsResult } from './drops.ts'
import {
  fileToWorld,
  fitPortFrame,
  mm,
  portDistanceToMetres,
  portToFile,
  regionLocalToFile,
  type PortFrameFit,
  type WorldFrame,
} from './frame.ts'
import { buildItems, itemIconSource, JOB_ITEM_CODE, MAX_ITEM_DEGREE } from './items.ts'
import { buildMobDef, characterRides, type DataExists } from './mobs.ts'
import { modelSource, type OutExists } from './models.ts'
import { buildNests, DEFAULT_ZONE, portFrameAnchors, terrainEvidence, type NestRecord, type TerrainEvidence, type TerrainProbe } from './nests.ts'
import { buildNpcs, JANGAN_CONTINENT, regionsOfContinent, shopChain, type NpcRecord } from './npcs.ts'
import { PORT_FILES, type PortData } from './port-source.ts'
import { buildMobSkills, buildSkills, MAX_SKILL_MASTERY_LEVEL } from './skills.ts'

/** Extra files next to the CONTENT_FILES. */
export const EXTRA_FILES = { allNests: 'all-nests.json', towns: 'towns.json' } as const

export interface ContentInput {
  client: ClientSources
  port: PortData
  world: WorldFrame
  exists: OutExists
  hasData: DataExists
  /** Does Media.pk2 have an icon (AssocFileIcon128 / UI_IconFile)? Missing icons export as null. Absent = yes. */
  hasIcon?: (assocIcon: string) => boolean
  /**
   * Skeleton joints of a converted model by sidecar URL (W11-CV, docs/UNIQUES.md §2.2: a ride's `saddle` is checked
   * against it). Absent: rides are left out with a warning.
   */
  jointsOf?: (sidecarUrl: string) => readonly string[] | null
  /** Navmesh probe for the frame evidence (optional; the tool reads the client NVMs). */
  terrain?: TerrainProbe
  generatedAt: string
  maxItemDegree?: number
  maxMasteryLevel?: number
}

export interface TownDef {
  code: string
  name: string | null
  world: string
  /**
   * Arrival point of the town's teleport (client teleportdata GenRegion/X/Y/Z of GATE_<town>). teleportdata stores
   * height 0; y is the navmesh terrain height there when the exporter has the navmesh (the server still settles it).
   */
  spawn: { x: number; y: number; z: number; source: string }
  /** Town safe box (port safe-areas.json), world metres: centre and half extents. */
  safeArea?: { x: number; z: number; halfX: number; halfZ: number; provenance: typeof PROVENANCE_PORT; source: Record<string, number> }
  /** refregion rows with AreaName Town_<name>. */
  regions: number[]
}

export interface ContentReport {
  frame: PortFrameFit
  terrain: TerrainEvidence[]
  counts: Record<string, number>
  jangan: { nests: number; insideConvertedRegions: number; outside: number; mobsInside: string[] }
  /** res/... BSRs the records reference (items: equipment and ground models; cos: the horses, wave 8). */
  models: { mobs: string[]; npcs: string[]; items: string[]; cos: string[] }
  icons: string[]
  drops: Omit<DropsResult, 'drops'>
  shopsDroppedGoods: Record<string, string[]>
  warnings: string[]
}

export interface ContentOutput {
  /** File name -> JSON value. */
  files: Record<string, unknown>
  report: ContentReport
}

function wrap<T>(kind: ContentKind, generatedAt: string, sources: string[], entries: T[], extra: Record<string, unknown> = {}): ContentFile<T> & Record<string, unknown> {
  return { schema: CONTENT_SCHEMA_VERSION, kind, generatedAt, sources, ...extra, entries }
}

export function buildContent(input: ContentInput): ContentOutput {
  const { client, port, world } = input
  const warnings: string[] = []
  const charByCode = indexByCode(client.characters)
  const charById = indexById(client.characters)
  const skillsById = new Map<number, SkillDataRow>()
  for (const r of client.skills) if (r.service && !skillsById.has(r.id)) skillsById.set(r.id, r)

  // teleportdata: col 2 code, col 3 AssocRefObjId, cols 5-8 GenRegion / X / Y (height) / Z.
  const teleports = client.tables['teleportdata.txt'].filter(c => c[0] === '1')
  const teleportRefByCode = new Map(teleports.map(c => [c[2]!, Number(c[3])]))
  const teleportsByNpc = new Map<number, string[]>()
  for (const c of teleports) {
    const id = Number(c[3])
    const row = charById.get(id)
    if (!row || row.typeId[0] !== 1) continue
    teleportsByNpc.set(id, [...(teleportsByNpc.get(id) ?? []), c[2]!])
  }

  // 1. The port frame, from NPCs both sides place.
  const charIdByCode = new Map([...charByCode].map(([k, v]) => [k, v.id]))
  const anchors = portFrameAnchors(port, client.npcPos, charIdByCode, teleportRefByCode)
  const fit = fitPortFrame(anchors)
  const frame = fit.frame
  const terrain = input.terrain ? terrainEvidence(port, frame, input.terrain) : []

  // 2. Monsters of the default zone's nests.
  const janganNests = port.spawns[DEFAULT_ZONE] ?? []
  if (!janganNests.length) throw new Error(`port spawns.json has no ${DEFAULT_ZONE} nests`)
  const allPortNests = Object.values(port.spawns).flat()
  const mobCodes = [...new Set(janganNests.map(n => n.vsroCode))]
  const rides = characterRides(client.tables['skilleffect.txt'])
  const mobBuilds = mobCodes.map(code =>
    buildMobDef(code, {
      byCode: charByCode, skillsById, strings: client.strings, exists: input.exists, hasData: input.hasData, nests: allPortNests, portMobs: port.mobs,
      rides, ...(input.jointsOf ? { jointsOf: input.jointsOf } : {}),
    }),
  )
  for (const b of mobBuilds) warnings.push(...b.warnings)
  const mobs = mobBuilds.map(b => b.mob).sort((a, b) => a.level - b.level || a.id - b.id)
  const uniqueCodes = new Set<string>(mobs.filter(m => m.rarity === 'unique').map(m => m.code))
  for (const u of port.uniques) {
    const n = allPortNests.find(x => x.mobId === u.monsterId)
    if (n) uniqueCodes.add(n.vsroCode)
  }

  // 3. Nests: every province, the default zone enabled.
  const allNests = buildNests(port, frame, world, uniqueCodes)
  const nests = allNests.filter(n => n.enabled)
  const mobSet = new Set(mobs.map(m => m.code))
  for (const n of nests) if (!mobSet.has(n.mob)) warnings.push(`nest ${n.id}: mob ${n.mob} not in mobs.json`)

  // 4. Skills and masteries, 5. items.
  const { skills, masteries, basicAttacks } = buildSkills(
    client.skills,
    { skillmasterydata: client.tables['skillmasterydata.txt'], skilleffect: client.tables['skilleffect.txt'] },
    client.strings,
    input.maxMasteryLevel ?? MAX_SKILL_MASTERY_LEVEL,
    input.hasIcon,
  )
  const itemCtx = { strings: client.strings, exists: input.exists, basicAttacks, ...(input.hasIcon ? { hasIcon: input.hasIcon } : {}) }
  const items = buildItems(client.items, itemCtx, input.maxItemDegree ?? MAX_ITEM_DEGREE)
  const itemCodes = new Set(items.map(i => i.code))
  // The job items (docs/JOBS.md §12 layer 0) never enter the retail shops or drop tables: the job modules hand them out.
  const tradeable = new Set([...itemCodes].filter(c => !JOB_ITEM_CODE.test(c)))
  // Wave 8 (docs/SYSTEMS_COMBAT.md §2.4, §6.3; WAVE_PLAN2 D6): the monsters' MSKILL rows join skills.json, and the
  // COS the summon items name go to cos.json.
  const mobSkills = buildMobSkills(client.skills, mobs, { skilleffect: client.tables['skilleffect.txt'] }, client.strings, id => charById.get(id)?.codeName)
  warnings.push(...mobSkills.warnings)
  const cos = buildCos(items, { byCode: charByCode, strings: client.strings, exists: input.exists, ...(input.hasIcon ? { hasIcon: input.hasIcon } : {}) })
  warnings.push(...cos.warnings)
  const itemModels = new Set<string>()
  for (const r of client.items) {
    if (!itemCodes.has(r.codeName)) continue
    for (const assoc of [r.assocFileObj, r.assocFileDrop]) {
      const src = modelSource(assoc)
      if (src) itemModels.add(src)
    }
  }

  // 6. NPCs and shops of the Jangan province.
  const regions = regionsOfContinent(client.tables['refregion.txt'], JANGAN_CONTINENT)
  const chain = shopChain({
    refshopgroup: client.tables['refshopgroup.txt'],
    refmappingshopgroup: client.tables['refmappingshopgroup.txt'],
    refmappingshopwithtab: client.tables['refmappingshopwithtab.txt'],
    refshoptab: client.tables['refshoptab.txt'],
    refshopgoods: client.tables['refshopgoods.txt'],
    refscrapofpackageitem: client.tables['refscrapofpackageitem.txt'],
  })
  const npcResult = buildNpcs(client.npcPos, {
    byId: charById,
    strings: client.strings,
    exists: input.exists,
    world,
    regions,
    teleportsByNpc,
    chain,
    itemCodes: tradeable,
    itemGender: new Map(items.map(i => [i.code, i.reqGender])),
    port,
    portFrame: frame,
  })

  // 7. Drops.
  const dropResult = buildDrops(mobs, port.drops, port.itemMap, tradeable, client.levelGold)
  for (const m of dropResult.missing) warnings.push(`drops: no port drop table for ${m}`)

  // 8. Towns: Jangan's teleport arrival point and safe box.
  const towns: TownDef[] = []
  const gate = teleports.find(c => c[2] === 'GATE_CH')
  if (gate) {
    const file = regionLocalToFile(Number(gate[5]), Number(gate[6]), Number(gate[7]), Number(gate[8]))
    const p = fileToWorld(file, world)
    // teleportdata stores height 0 ("on the ground"): take the terrain height there when the navmesh is at hand.
    const ground = input.terrain?.(file)
    const y = ground ? ground.heightM : p.y
    const town: TownDef = {
      code: 'JANGAN',
      name: 'Jangan',
      world: world.name,
      spawn: {
        x: mm(p.x),
        y: mm(y),
        z: mm(p.z),
        source: `client: teleportdata GATE_CH region ${gate[5]} (${gate[6]}, ${gate[7]}, ${gate[8]})${ground ? '; y = navmesh terrain height' : ''}`,
      },
      regions: client.tables['refregion.txt'].filter(c => c[4] === 'Town_Jangan').map(c => Number(c[0])).sort((a, b) => a - b),
    }
    const box = port.safeAreas[DEFAULT_ZONE]?.[0]
    if (box && box.shape.kind === 'box') {
      const c = fileToWorld(portToFile({ x: box.x + (box.shape.ox ?? 0), z: box.z + (box.shape.oz ?? 0) }, frame), world)
      town.safeArea = {
        x: mm(c.x),
        z: mm(c.z),
        halfX: mm(portDistanceToMetres(box.shape.hx, frame)),
        halfZ: mm(portDistanceToMetres(box.shape.hz, frame)),
        provenance: PROVENANCE_PORT,
        source: { x: box.x, z: box.z, hx: box.shape.hx, hz: box.shape.hz },
      }
    }
    towns.push(town)
  } else warnings.push('teleportdata: no GATE_CH row; towns.json has no Jangan')

  // Files.
  const at = input.generatedAt
  const portSrc = (f: string) => `port:${f}`
  const frameInfo = { portFrame: { ...frame, anchors: fit.anchors, rmsM: fit.rmsM, maxM: fit.maxM }, world: { name: world.name, originRegion: world.originRegion }, terrain }
  const files: Record<string, unknown> = {
    [CONTENT_FILES.mobs]: wrap<MobDef>('mobs', at, ['client:characterdata.txt', 'client:skilldata.txt', 'client:textdataname.txt', portSrc(PORT_FILES.spawns), portSrc(PORT_FILES.mobs)], mobs),
    [CONTENT_FILES.nests]: wrap<NestRecord>('nests', at, [portSrc(PORT_FILES.spawns), 'client:npcpos.txt (frame anchors)', portSrc(PORT_FILES.shops), portSrc(PORT_FILES.teleporters)], nests, frameInfo),
    [EXTRA_FILES.allNests]: wrap<NestRecord>('nests', at, [portSrc(PORT_FILES.spawns)], allNests, frameInfo),
    [CONTENT_FILES.items]: wrap<ItemDef>('items', at, ['client:itemdata.txt', 'client:textdataname.txt'], items),
    [CONTENT_FILES.skills]: wrap<SkillDef>('skills', at, ['client:skilldata.txt', 'client:skilleffect.txt', 'client:textdataname.txt', 'client:characterdata.txt (mob default skills)'], [...skills, ...mobSkills.skills]),
    [CONTENT_FILES.masteries]: wrap<MasteryDef>('masteries', at, ['client:skillmasterydata.txt', 'client:skilldata.txt', 'client:textuisystem.txt'], masteries),
    [CONTENT_FILES.npcs]: wrap<NpcRecord>('npcs', at, ['client:npcpos.txt', 'client:characterdata.txt', 'client:refregion.txt', 'client:teleportdata.txt', portSrc(`${PORT_FILES.shops} (yaw)`)], npcResult.npcs),
    [CONTENT_FILES.shops]: wrap<ShopDef>('shops', at, ['client:refshopgroup.txt', 'client:refmappingshopgroup.txt', 'client:refmappingshopwithtab.txt', 'client:refshoptab.txt', 'client:refshopgoods.txt', 'client:refscrapofpackageitem.txt'], npcResult.shops),
    [CONTENT_FILES.cos]: wrap<CosDef>('cos', at, ['client:characterdata.txt', 'client:itemdata.txt (summon items)', 'client:textdataname.txt'], cos.cos),
    [CONTENT_FILES.drops]: wrap<DropTable>('drops', at, [portSrc(PORT_FILES.drops), portSrc(PORT_FILES.itemMap), 'client:levelgold.txt'], dropResult.drops),
    [EXTRA_FILES.towns]: { schema: CONTENT_SCHEMA_VERSION, kind: 'towns', generatedAt: at, sources: ['client:teleportdata.txt', 'client:refregion.txt', portSrc(PORT_FILES.safeAreas)], entries: towns },
  }

  // Self-check against the shared contracts.
  const problems: string[] = []
  const kinds: Array<[string, ContentKind]> = [
    [CONTENT_FILES.mobs, 'mobs'],
    [CONTENT_FILES.nests, 'nests'],
    [EXTRA_FILES.allNests, 'nests'],
    [CONTENT_FILES.items, 'items'],
    [CONTENT_FILES.skills, 'skills'],
    [CONTENT_FILES.masteries, 'masteries'],
    [CONTENT_FILES.npcs, 'npcs'],
    [CONTENT_FILES.shops, 'shops'],
    [CONTENT_FILES.drops, 'drops'],
    [CONTENT_FILES.cos, 'cos'],
  ]
  for (const [file, kind] of kinds) problems.push(...checkContentFile(kind, files[file]).map(p => `${file}: ${p}`))
  if (problems.length) throw new Error(`content self-check failed:\n  ${problems.slice(0, 20).join('\n  ')}${problems.length > 20 ? `\n  ... ${problems.length - 20} more` : ''}`)

  const inside = nests.filter(n => n.inConvertedRegion)
  const icons = new Set<string>()
  for (const r of client.items) {
    const icon = itemCodes.has(r.codeName) ? itemIconSource(r, input.hasIcon).icon : undefined
    if (icon) icons.add(icon)
  }
  for (const icon of cos.icons) icons.add(icon)
  for (const s of skills) {
    const row = skillsById.get(s.id)
    const icon = row?.cells[61]?.trim()
    if (icon && icon !== 'xxx') icons.add(icon)
  }
  return {
    files,
    report: {
      frame: fit,
      terrain,
      counts: {
        mobs: mobs.length,
        nests: nests.length,
        allNests: allNests.length,
        items: items.length,
        skills: skills.length,
        mobSkills: mobSkills.skills.length,
        cos: cos.cos.length,
        masteries: masteries.length,
        npcs: npcResult.npcs.length,
        shops: npcResult.shops.length,
        drops: dropResult.drops.length,
        dropGroups: dropResult.drops.reduce((a, d) => a + d.groups.length, 0),
        towns: towns.length,
      },
      jangan: {
        nests: nests.length,
        insideConvertedRegions: inside.length,
        outside: nests.length - inside.length,
        mobsInside: [...new Set(inside.map(n => n.mob))],
      },
      models: { mobs: [...new Set(mobBuilds.flatMap(b => b.models))].sort(), npcs: npcResult.models, items: [...itemModels].sort(), cos: cos.models },
      icons: [...icons].sort(),
      drops: { skipped: dropResult.skipped, goldCheck: dropResult.goldCheck, missing: dropResult.missing },
      shopsDroppedGoods: npcResult.droppedGoods,
      warnings,
    },
  }
}

/** File name -> exact contents (2-space JSON, trailing newline). */
export function serializeContent(files: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, v] of Object.entries(files)) out[name] = JSON.stringify(v, null, 2) + '\n'
  return out
}
