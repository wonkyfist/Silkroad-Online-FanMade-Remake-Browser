/**
 * npcs.json / shops.json from the client: npcpos.txt places the NPCs (characterdata TypeID 1/2/2/x), the refshop*
 * chain gives their shops, teleportdata marks teleport NPCs. NPC facing is not in any client table; it comes from
 * the port's placements (npcshops.json shops[].placements and zones.<province>.npcs, teleporters.json) when one
 * matches (matchFacing; fieldSources.yaw), else 0. Greetings: npcchat.txt's _BS string in
 * textquest_speech&name.txt, which client-source.ts puts into the strings map under npcGreetingKey(code).
 */
import type { CharacterDataRow, NpcPosRow } from '@sro/formats'
import type { NpcDef, ShopDef } from '../../../shared/src/content.ts'
import { npcGreetingKey, textOf } from './client-source.ts'
import { fileToWorld, mm, portToFile, portYawToWorld, regionLocalToFile, type PortFrame, type WorldFrame } from './frame.ts'
import { modelRef, modelSource, type OutExists } from './models.ts'
import type { PortData } from './port-source.ts'

/** refregion.txt: region id (col 0), x (1), z (2), ContinentName (3), AreaName (4). */
export function regionsOfContinent(refregion: readonly string[][], continent: string): Set<number> {
  const out = new Set<number>()
  for (const c of refregion) if (c[3] === continent && Number(c[0]) >= 0) out.add(Number(c[0]))
  return out
}

/**
 * NPCs that repair (docs/SYSTEMS_COMBAT.md §3.3): the Blacksmith and the Protector trader, whose store groups read
 * "Purchase/ Sell/ Repair ..." (textuisystem SN_STORE_SMITH_GROUP1, SN_STORE_ARMOR_GROUP1/2).
 */
export const REPAIR_NPCS: ReadonlySet<string> = new Set(['NPC_CH_SMITH', 'NPC_CH_ARMOR'])

/** Jangan province = the refregion rows of continent CHINA (Town_Jangan is 167-169 x 97-98 among them). */
export const JANGAN_CONTINENT = 'CHINA'

export interface ShopChain {
  /** STORE code -> NPC codes. */
  npcsByStore: Map<string, string[]>
  /** STORE code -> tabs (name key, package codes in slot order). */
  tabsByStore: Map<string, Array<{ code: string; nameKey: string; packages: string[] }>>
  /** PACKAGE_ITEM_* -> ITEM_* code. */
  itemByPackage: Map<string, string>
}

export function shopChain(t: {
  refshopgroup: readonly string[][]
  refmappingshopgroup: readonly string[][]
  refmappingshopwithtab: readonly string[][]
  refshoptab: readonly string[][]
  refshopgoods: readonly string[][]
  refscrapofpackageitem: readonly string[][]
}): ShopChain {
  const live = (c: readonly string[]) => c[0] === '1'
  const npcByGroup = new Map<string, string>()
  for (const c of t.refshopgroup) if (live(c) && c[4] && c[4] !== 'xxx') npcByGroup.set(c[3]!, c[4])
  const npcsByStore = new Map<string, string[]>()
  for (const c of t.refmappingshopgroup) {
    const npc = live(c) ? npcByGroup.get(c[2]!) : undefined
    if (!npc) continue
    const list = npcsByStore.get(c[3]!) ?? []
    if (!list.includes(npc)) list.push(npc)
    npcsByStore.set(c[3]!, list)
  }
  const goodsByTab = new Map<string, Array<{ slot: number; pkg: string }>>()
  for (const c of t.refshopgoods) {
    if (!live(c)) continue
    const list = goodsByTab.get(c[2]!) ?? []
    list.push({ slot: Number(c[4]), pkg: c[3]! })
    goodsByTab.set(c[2]!, list)
  }
  const tabsByGroup = new Map<string, Array<{ code: string; nameKey: string; packages: string[] }>>()
  for (const c of t.refshoptab) {
    if (!live(c)) continue
    const list = tabsByGroup.get(c[4]!) ?? []
    const goods = (goodsByTab.get(c[3]!) ?? []).sort((a, b) => a.slot - b.slot).map(g => g.pkg)
    list.push({ code: c[3]!, nameKey: c[5]!, packages: goods })
    tabsByGroup.set(c[4]!, list)
  }
  const tabsByStore = new Map<string, Array<{ code: string; nameKey: string; packages: string[] }>>()
  for (const c of t.refmappingshopwithtab) {
    if (!live(c)) continue
    const list = tabsByStore.get(c[2]!) ?? []
    list.push(...(tabsByGroup.get(c[3]!) ?? []))
    tabsByStore.set(c[2]!, list)
  }
  const itemByPackage = new Map<string, string>()
  for (const c of t.refscrapofpackageitem) if (live(c) && !itemByPackage.has(c[2]!)) itemByPackage.set(c[2]!, c[3]!)
  return { npcsByStore, tabsByStore, itemByPackage }
}

export interface NpcContext {
  byId: ReadonlyMap<number, CharacterDataRow>
  strings: ReadonlyMap<string, string>
  exists: OutExists
  world: WorldFrame
  regions: ReadonlySet<number>
  /** teleportdata: NPC characterdata ID -> teleport codes (col 2) whose AssocRefObjId (col 3) is that NPC. */
  teleportsByNpc: ReadonlyMap<number, string[]>
  chain: ShopChain
  /** Items the export has; shop tabs keep only these. */
  itemCodes: ReadonlySet<string>
  /** Item code -> reqGender, to mark the male and female armour tabs. */
  itemGender?: ReadonlyMap<string, string>
  port?: Pick<PortData, 'shops' | 'teleporters' | 'zoneNpcs'>
  portFrame?: PortFrame
}

export type NpcRecord = NpcDef & Record<string, unknown>

export interface NpcsResult {
  npcs: NpcRecord[]
  shops: ShopDef[]
  models: string[]
  /** Shop goods left out because the item is outside items.json, per store. */
  droppedGoods: Record<string, string[]>
}

/** A port placement with a facing, in world metres; `code` = the client NPC code it names, if any. */
export interface Facing {
  x: number
  z: number
  rotY: number
  label: string
  code?: string
}

/**
 * The port facing of the NPC `code` placed at `at`: a record naming that code within 2 m, else the nearest record
 * within 1 m that names no other placed NPC (Storage-keepers Wangu and Sansan stand 5 cm apart and face differently).
 */
export function matchFacing(facings: readonly Facing[], code: string, at: { x: number; z: number }, placedCodes: ReadonlySet<string>): Facing | undefined {
  const dist = (f: Facing) => Math.hypot(f.x - at.x, f.z - at.z)
  const byDist = (a: Facing, b: Facing) => dist(a) - dist(b)
  const named = facings.filter(f => f.code === code && dist(f) < 2).sort(byDist)[0]
  if (named) return named
  return facings.filter(f => dist(f) < 1 && !(f.code && f.code !== code && placedCodes.has(f.code))).sort(byDist)[0]
}

export function buildNpcs(npcPos: readonly NpcPosRow[], ctx: NpcContext): NpcsResult {
  const storeByNpc = new Map<string, string>()
  for (const [store, npcs] of ctx.chain.npcsByStore) for (const n of npcs) if (!storeByNpc.has(n)) storeByNpc.set(n, store)
  // Port placements with facing, in world metres. `code` = the client code the record names, when it names one.
  const facings: Facing[] = []
  if (ctx.port && ctx.portFrame) {
    const f = ctx.portFrame
    const push = (x: number, z: number, rotY: number | undefined, label: string, code?: string) => {
      if (rotY === undefined) return
      const w = fileToWorld(portToFile({ x, z }, f), ctx.world)
      facings.push({ x: w.x, z: w.z, rotY, label, code })
    }
    const province = (zone: string) => /_province$/.test(zone)
    for (const s of ctx.port.shops) for (const p of s.placements ?? []) if (province(p.zone)) push(p.x, p.z, p.rotY, `npcshops.json ${s.id}`, s.sroCode)
    // zones.<province>.npcs: every placed NPC (storage keepers, soldiers, quest NPCs...), not only the shops.
    const sroCode = new Map(ctx.port.shops.map(s => [s.id, s.sroCode]))
    for (const [zone, list] of Object.entries(ctx.port.zoneNpcs ?? {})) {
      if (province(zone)) for (const n of list) push(n.x, n.z, n.rotY, `npcshops.json zones.${zone} ${n.npcId}`, sroCode.get(n.npcId) ?? n.npcId.toUpperCase())
    }
    for (const [zone, list] of Object.entries(ctx.port.teleporters)) if (province(zone)) for (const t of list) push(t.x, t.z, t.rotY, `teleporters.json ${t.id}`)
  }
  const placedCodes = new Set<string>()
  for (const p of npcPos) {
    const row = ctx.byId.get(p.refId)
    if (row) placedCodes.add(row.codeName)
  }
  const npcs: NpcRecord[] = []
  const models = new Set<string>()
  const usedStores = new Set<string>()
  for (const p of npcPos) {
    if (!ctx.regions.has(p.region)) continue
    const row = ctx.byId.get(p.refId)
    if (!row || row.typeId[0] !== 1 || row.typeId[1] !== 2 || row.typeId[2] !== 2) continue
    const w = fileToWorld(regionLocalToFile(p.region, p.x, p.y, p.z), ctx.world)
    const npc: NpcRecord = {
      code: row.codeName,
      name: textOf(ctx.strings, row.nameStrId),
      x: mm(w.x),
      z: mm(w.z),
      y: mm(w.y),
      yaw: 0,
      world: ctx.world.name,
      model: modelRef(row.assocFileObj, ctx.exists),
      provenance: 'client',
    }
    const greeting = textOf(ctx.strings, npcGreetingKey(row.codeName))
    if (greeting) npc.greeting = greeting
    const fieldSources: Record<string, string> = { position: `client: npcpos.txt region ${p.region} (${p.x}, ${p.y}, ${p.z})` }
    const near = matchFacing(facings, row.codeName, w, placedCodes)
    if (near) {
      npc.yaw = mm(portYawToWorld(near.rotY))
      fieldSources.yaw = `vsro-server-db via third-party port: ${near.label} rotY ${near.rotY} (yaw = pi - rotY, frame.ts portYawToWorld)`
    } else fieldSources.yaw = 'default 0: no facing in client data and no port placement within 1 m'
    const roles: string[] = []
    const store = storeByNpc.get(row.codeName)
    if (store) {
      npc.shop = store
      usedStores.add(store)
      roles.push('shop')
    }
    const tele = ctx.teleportsByNpc.get(row.id)
    if (tele?.length) {
      roles.push('teleport')
      npc.teleports = tele
    }
    if (/WAREHOUSE/.test(row.codeName)) roles.push('storage')
    if (REPAIR_NPCS.has(row.codeName)) roles.push('repair')
    if (roles.length) npc.roles = roles
    npc.region = p.region
    npc.inConvertedRegion = ctx.world.regions.has(p.region)
    npc.fieldSources = fieldSources
    const src = modelSource(row.assocFileObj)
    if (src) models.add(src)
    npcs.push(npc)
  }
  const shops: ShopDef[] = []
  const droppedGoods: Record<string, string[]> = {}
  for (const store of [...usedStores].sort()) {
    const tabs: ShopDef['tabs'] = []
    const dropped: string[] = []
    for (const tab of ctx.chain.tabsByStore.get(store) ?? []) {
      const items: string[] = []
      for (const pkg of tab.packages) {
        const item = ctx.chain.itemByPackage.get(pkg) ?? pkg.replace(/^PACKAGE_/, '')
        if (ctx.itemCodes.has(item)) items.push(item)
        else dropped.push(item)
      }
      if (!items.length) continue
      const t: ShopDef['tabs'][number] & { reqGender?: 'male' | 'female' } = { name: textOf(ctx.strings, tab.nameKey) ?? tab.code, items }
      const genders = new Set(items.map(i => ctx.itemGender?.get(i) ?? 'any'))
      if (genders.size === 1 && !genders.has('any')) t.reqGender = [...genders][0] as 'male' | 'female'
      tabs.push(t)
    }
    if (dropped.length) droppedGoods[store] = dropped
    if (!tabs.length) {
      for (const n of npcs) if (n.shop === store) {
        delete n.shop
        n.roles = (n.roles ?? []).filter(r => r !== 'shop')
        if (!n.roles.length) delete n.roles
      }
      continue
    }
    shops.push({ id: store, npcs: ctx.chain.npcsByStore.get(store) ?? [], tabs, provenance: 'client' })
  }
  return { npcs, shops, models: [...models].sort(), droppedGoods }
}
