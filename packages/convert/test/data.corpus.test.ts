/**
 * The content export against the real client (Media.pk2 textdata, Data.pk2 navmesh) and the port's server data.
 * Skips without sro.config.json or without the port data folder.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { NVM_TILE_SIZE, NVM_TILES, nvmTerrainHeightAt, parseNvm } from '@sro/formats'
import { checkContentFile, CONTENT_FILES, contentEntries, PROVENANCE_PORT, type ContentKind, type DropTable, type ItemDef, type MobDef, type NpcDef, type ShopDef, type SkillDef } from '../../shared/src/index.ts'
import { loadClientSources } from '../src/data/client-source.ts'
import { buildContent, EXTRA_FILES, type ContentOutput, type TownDef } from '../src/data/content.ts'
import { fileRegion, fileToWorld, portToFile, REGION_UNITS, regionXZ, worldFrameFromManifest, type FilePos, type WorldFrame } from '../src/data/frame.ts'
import type { NestRecord } from '../src/data/nests.ts'
import { defaultPortDataDir, loadPortData, type PortData } from '../src/data/port-source.ts'
import { textdataReader } from '../src/data/textdata-source.ts'
import { MAX_SKILL_MASTERY_LEVEL } from '../src/data/skills.ts'
import { loadConfig, openArchive, REPO_ROOT } from '../src/node-io.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const portDir = hasConfig ? (process.env.SRO_PORT_DATA ?? defaultPortDataDir(loadConfig().clientDir)) : ''
const hasPort = hasConfig && existsSync(join(portDir, 'spawns.json'))

describe.skipIf(!hasPort)('content export (vSRO 1.188 client + port server data)', () => {
  let out: ContentOutput
  let port: PortData
  let world: WorldFrame
  let terrain: (p: FilePos) => { open: boolean; heightM: number } | undefined
  const entries = <T>(file: string) => contentEntries<T>(out.files[file])

  beforeAll(() => {
    const cfg = loadConfig()
    const data = openArchive('Data', cfg)
    const manifest = join(cfg.workDir, 'out', 'world', 'jangan', 'manifest.json')
    world = existsSync(manifest)
      ? worldFrameFromManifest(JSON.parse(readFileSync(manifest, 'utf8')))
      : { name: 'jangan', originRegion: { x: 168, z: 97 }, regions: new Set([24743, 24744, 24745, 24999, 25000, 25001, 25255, 25256, 25257]) }
    const nvms = new Map<number, ReturnType<typeof parseNvm> | null>()
    terrain = p => {
      const id = fileRegion(p)
      if (!nvms.has(id)) {
        const f = data.get(`navmesh/nv_${id.toString(16).padStart(4, '0')}.nvm`)
        nvms.set(id, f ? parseNvm(data.read(f)) : null)
      }
      const nvm = nvms.get(id)
      if (!nvm) return undefined
      const { rx, rz } = regionXZ(id)
      const lx = p.x - rx * REGION_UNITS
      const lz = p.z - rz * REGION_UNITS
      const cell = nvm.tileCells[Math.min(95, Math.floor(lz / NVM_TILE_SIZE)) * NVM_TILES + Math.min(95, Math.floor(lx / NVM_TILE_SIZE))]!
      return { open: cell >= 0 && cell < nvm.openCellCount, heightM: nvmTerrainHeightAt(nvm, lx, lz) / 10 }
    }
    port = loadPortData(portDir)
    out = buildContent({
      client: loadClientSources(textdataReader(openArchive('Media', cfg))),
      port,
      world,
      exists: () => true,
      hasData: p => data.get(p) !== undefined,
      terrain,
      generatedAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('derives the port frame from NPCs both sides place: port = 1.5 x SRO game metres, no offset', () => {
    const f = out.report.frame
    expect(f.frame).toEqual({ scale: 1.5, offsetX: 0, offsetZ: 0 })
    expect(f.inliers).toBeGreaterThanOrEqual(50)
    expect(f.inliers / f.anchors).toBeGreaterThan(0.9)
    expect(f.maxM).toBeLessThan(0.01)
    expect(Math.abs(f.fitX.scale - 1.5)).toBeLessThan(1e-5)
    expect(Math.abs(f.fitZ.scale - 1.5)).toBeLessThan(1e-5)
  })

  it('puts the nest centres of every province on the client navmesh terrain', () => {
    expect(out.report.terrain).toHaveLength(Object.keys(port.spawns).length)
    for (const t of out.report.terrain) {
      expect(t.probed, t.zone).toBe(t.nests)
      expect(t.open / t.probed, t.zone).toBeGreaterThan(0.99)
      expect(t.medianDyM, t.zone).toBeLessThan(0.05)
      expect(t.maxDyM, t.zone).toBeLessThan(1)
    }
  })

  it('writes content files that pass the shared checks', () => {
    const kinds = Object.entries(CONTENT_FILES).filter(([k]) => k !== 'levels') as Array<[ContentKind, string]>
    for (const [kind, file] of kinds) {
      expect(checkContentFile(kind, out.files[file]), file).toEqual([])
      expect((out.files[file] as { schema: number }).schema).toBe(1)
    }
    expect(checkContentFile('nests', out.files[EXTRA_FILES.allNests])).toEqual([])
  })

  it('exports every Jangan nest, enabled, and all provinces in all-nests.json', () => {
    const nests = entries<NestRecord>(CONTENT_FILES.nests)
    const all = entries<NestRecord>(EXTRA_FILES.allNests)
    expect(nests).toHaveLength(port.spawns.jangan_province!.length)
    expect(all).toHaveLength(Object.values(port.spawns).flat().length)
    expect(all.filter(n => n.enabled).map(n => n.id)).toEqual(nests.map(n => n.id))
    for (const n of all) expect(n.provenance).toBe(PROVENANCE_PORT)
    const mobs = new Set(entries<MobDef>(CONTENT_FILES.mobs).map(m => m.code))
    for (const n of nests) expect(mobs.has(n.mob), n.mob).toBe(true)
    expect(out.report.jangan.insideConvertedRegions + out.report.jangan.outside).toBe(nests.length)
    // Nest 249 (Mangnyang) south-east of town: port (10201.9, 1786.93) -> region 25258.
    const n249 = nests.find(n => n.id === 249)!
    expect(n249).toMatchObject({ mob: 'MOB_CH_MANGNYANG', x: 465.267, z: -231.287, region: 25258, radius: 50 })
  })

  it('takes monster stats from characterdata (they match the port where both have them)', () => {
    const mobs = entries<MobDef & { attacks?: unknown[]; championModel?: unknown }>(CONTENT_FILES.mobs)
    const m = mobs.find(x => x.code === 'MOB_CH_MANGNYANG')!
    expect(m).toMatchObject({ name: 'Mangyang', level: 1, hp: 54, physDefence: 7, magDefence: 10, hitRate: 27, parryRate: 27, exp: 24, physAttack: [17, 19], attackIntervalMs: 3000, walkSpeed: 0.8, runSpeed: 2.2, radius: 0.6, aggressive: false })
    expect(m.variants).toEqual(['normal', 'champion', 'giant'])
    expect(mobs.find(x => x.code === 'MOB_CH_TIGERWOMAN')).toMatchObject({ rarity: 'unique', level: 20, aggressive: true })
    // Clones borrow the base model's _clon sibling.
    expect(mobs.find(x => x.code === 'MOB_CH_BIGEYEGHOST_CLON')?.model?.bsr).toBe('res/mob/china/bigeyeghost_clon.bsr')
    for (const x of mobs) {
      expect(x.model, x.code).not.toBeNull()
      expect(x.physAttack[1] + x.magAttack[1], x.code).toBeGreaterThan(0)
    }
  })

  it('exports Chinese items with stats, shops that sell only exported items, and drops that reference them', () => {
    const items = entries<ItemDef>(CONTENT_FILES.items)
    const codes = new Set(items.map(i => i.code))
    for (const c of ['ITEM_CH_SWORD_01_A_DEF', 'ITEM_CH_M_HEAVY_03_FA_C', 'ITEM_CH_W_CLOTHES_01_HA_A', 'ITEM_CH_NECKLACE_03_C', 'ITEM_ETC_HP_POTION_01', 'ITEM_ETC_SCROLL_RETURN_01', 'ITEM_ETC_GOLD_01']) expect(codes.has(c), c).toBe(true)
    for (const i of items) {
      expect(i.degree, i.code).toBeLessThanOrEqual(4)
      if (i.category === 'weapon') expect(i.basicAttack, i.code).toMatch(/^SKILL_CH_(SWORD|SPEAR|BOW)_BASE_01$/)
    }
    expect(items.find(i => i.code === 'ITEM_CH_SWORD_01_A')).toMatchObject({ name: 'Copper Sword', price: 890, stats: { physAttack: [15.5, 17], durability: [62, 76] } })
    // docs/SHOPS.md §7.5 (lane F): KeepingFee col 30, Cost_Repair col 27, CanRepair col 22; potion cooldown rule.
    expect(items.find(i => i.code === 'ITEM_CH_SWORD_01_A')).toMatchObject({ keepFee: 21, repairCost: 198, canRepair: true })
    expect(items.find(i => i.category === 'accessory')?.canRepair).toBe(false)
    for (const i of items) if (i.category === 'potion' || i.category === 'pill') expect(i.use?.cooldownMs, i.code).toBe(1000)
    const shops = entries<ShopDef>(CONTENT_FILES.shops)
    // Wave 8 (docs/SYSTEMS_COMBAT.md §8 EXP work 4): the Red Horse and its kits bring Machun's stable in.
    expect(shops.map(s => s.id).sort()).toEqual(['STORE_CH_ACCESSORY', 'STORE_CH_ARMOR', 'STORE_CH_POTION', 'STORE_CH_SMITH', 'STORE_CH_STABLE'])
    for (const s of shops) for (const t of s.tabs) for (const i of t.items) expect(codes.has(i), i).toBe(true)
    const drops = entries<DropTable>(CONTENT_FILES.drops)
    expect(drops).toHaveLength(entries<MobDef>(CONTENT_FILES.mobs).length)
    for (const d of drops) for (const g of d.groups) for (const e of g.entries) expect(codes.has(e.item), e.item).toBe(true)
    expect(drops.find(d => d.mob === 'MOB_CH_MANGNYANG')?.gold).toEqual({ chance: 0.7, amount: [28, 59] })
    expect(out.report.drops.goldCheck.differ).toEqual([])
  })

  it('exports the seven Chinese masteries with real skill rows up to mastery level 25 (the Climb cap, MAX_SKILL_MASTERY_LEVEL)', () => {
    const skills = entries<SkillDef>(CONTENT_FILES.skills)
    const masteries = entries<{ code: string; skills: string[]; weapons: string[] }>(CONTENT_FILES.masteries)
    expect(masteries.map(m => m.code)).toEqual(['BICHEON', 'HEUKSAL', 'PACHEON', 'COLD', 'LIGHTNING', 'FIRE', 'FORCE'])
    expect(masteries[0]!.weapons).toEqual(['sword', 'blade'])
    for (const m of masteries) expect(m.skills.length, m.code).toBeGreaterThan(10)
    // docs/CLIMB.md §5.2: masteries to 25 (was 20); the rows of masteries 21-25 are exported, nothing past them
    expect(MAX_SKILL_MASTERY_LEVEL).toBe(25)
    for (const s of skills) expect(s.masteryLevel, s.code).toBeLessThanOrEqual(MAX_SKILL_MASTERY_LEVEL)
    for (let m = 21; m <= 25; m++) expect(skills.some(s => !s.mob && s.masteryLevel === m), `mastery ${m}`).toBe(true)
    expect(skills.find(s => s.code === 'SKILL_CH_SWORD_SMASH_A_01')).toMatchObject({ name: 'Strike Smash', mastery: 'BICHEON', masteryLevel: 5, sp: 2, mp: 19, castMs: 411, actionMs: 1022, cooldownMs: 3000, category: 'melee', animation: { shot: 'SKILL_1' }, damage: { physPct: 143, flat: [15, 18], hits: 1 } })
    expect(skills.find(s => s.code === 'SKILL_CH_SWORD_BASE_01')).toMatchObject({ basicAttack: true, cooldownMs: 1200, damage: { physPct: 60, hits: 2 } })
    expect(skills.find(s => s.code === 'SKILL_CH_SWORD_CHAIN_A_1S_01')?.chainNext).toBe('SKILL_CH_SWORD_CHAIN_A_2S_01')
    // Every exported 'att' record has its 5 arguments and 'mc' its 2: the FourCC split held.
    for (const s of skills as Array<SkillDef & { params?: Array<{ tag: string; args: number[] }> }>) {
      for (const p of s.params ?? []) {
        if (p.tag === 'att') expect(p.args, s.code).toHaveLength(5)
        if (p.tag === 'mc') expect(p.args, s.code).toHaveLength(2)
        expect(p.tag, s.code).not.toBe('')
      }
    }
  })

  it('turns Jangan NPCs the way the town is laid out (NPC facing: zones.<province>.npcs, yaw = pi - rotY)', () => {
    const npcs = entries<NpcDef & { fieldSources?: Record<string, string>; inConvertedRegion?: boolean }>(CONTENT_FILES.npcs)
    const npc = (code: string) => npcs.find(n => n.code === code)!
    // yaw 0 faces world +z (south); world x east, z south.
    const facing = (code: string) => ({ x: Math.sin(npc(code).yaw), z: Math.cos(npc(code).yaw) })
    const towards = (code: string, x: number, z: number) => {
      const n = npc(code)
      const d = Math.hypot(x - n.x, z - n.z)
      const f = facing(code)
      return (f.x * (x - n.x) + f.z * (z - n.z)) / d
    }
    // Every town NPC the port places has its facing now (only these two are missing from the port's zone list).
    const inTown = npcs.filter(n => n.inConvertedRegion)
    const unfaced = inTown.filter(n => !/^vsro-server-db/.test(n.fieldSources?.yaw ?? '')).map(n => n.code).sort()
    expect(unfaced).toEqual(['NPC_BATTLE_ARENA_MANAGER', 'NPC_CH_EVENT_KISAENG1'])
    // 1. Around the storage fountain (the cj_jang_gate_dragon statue of the world export, (100.8, -83.9)) everyone faces
    //    outwards: Wangu with his storage chest behind him and Sansan sitting on it face north onto the plaza, Magic POP
    //    Guide Gori south. yaw = -rotY would turn all three into the fountain.
    for (const code of ['NPC_CH_WAREHOUSE_M', 'NPC_CH_WAREHOUSE_W', 'NPC_CH_GACHA_OPERATOR']) expect(towards(code, 100.8, -83.9), code).toBeLessThan(-0.8)
    expect(facing('NPC_CH_WAREHOUSE_M').z).toBeLessThan(-0.9)
    expect(facing('NPC_CH_WAREHOUSE_W').z).toBeLessThan(-0.9)
    // The two keepers stand 5 cm apart and face 22 degrees apart: each got its own record (matched by code).
    expect(npc('NPC_CH_WAREHOUSE_M').yaw).toBeCloseTo(-2.742, 3)
    expect(npc('NPC_CH_WAREHOUSE_W').yaw).toBeCloseTo(-3.125, 3)
    // 2. The gate soldiers (east, west, south and palace gates, both of each pair) face into town (the spawn).
    for (const code of ['EA1', 'EA2', 'WE1', 'WE2', 'SO1', 'SO2', 'EM1', 'EM2']) expect(towards(`NPC_CH_SOLDIER_${code}`, 96.9, -136.9), code).toBeGreaterThan(0.5)
    // 3. Shopkeepers face the street with their building behind them: the herbalist at the west front of cj_etc and the
    //    grocer in cj_acce face west, the stable-keeper in front of cj_stab faces east.
    expect(facing('NPC_CH_POTION').x).toBeLessThan(-0.5)
    expect(facing('NPC_CH_ACCESSORY').x).toBeLessThan(-0.9)
    expect(facing('NPC_CH_HORSE').x).toBeGreaterThan(0.9)
  })

  it('places Jangan NPCs from npcpos.txt where the port places them too, and the town spawn on open ground', () => {
    const npcs = entries<NpcDef>(CONTENT_FILES.npcs)
    const potion = npcs.find(n => n.code === 'NPC_CH_POTION')!
    const placed = port.shops.find(s => s.sroCode === 'NPC_CH_POTION')!.placements!.find(p => p.zone === 'jangan_province')!
    const w = fileToWorld(portToFile(placed, out.report.frame.frame), world)
    expect(Math.hypot(potion.x - w.x, potion.z - w.z)).toBeLessThan(0.01)
    expect(potion).toMatchObject({ shop: 'STORE_CH_POTION', world: 'jangan', provenance: 'client' })
    // Greetings (docs/SHOPS.md §1.1), through npcchat.txt: all 46 have one; Wangu's is "...". SHOPS expected none for
    // the arena manager, but npcchat maps it to SN_NPC_SD_ARENA_MANAGER_BS, not SN_<code>_BS, and that string exists.
    expect(potion.greeting).toMatch(/^With consistent patients/)
    expect(npcs.find(n => n.code === 'NPC_CH_WAREHOUSE_M')?.greeting).toBe('...')
    expect(npcs.find(n => n.code === 'NPC_BATTLE_ARENA_MANAGER')?.greeting).toMatch(/^Are you interested in the Arena/)
    expect(npcs.filter(n => n.greeting).length).toBe(npcs.length)
    expect(npcs.filter(n => n.shop).length).toBe(5) // wave 8: + Stable-keeper Machun
    const town = contentEntries<TownDef>(out.files[EXTRA_FILES.towns])[0]!
    expect(town.spawn).toMatchObject({ x: 96.9, z: -136.9 })
    const fx = world.originRegion.x * REGION_UNITS + town.spawn.x * 10
    const fz = world.originRegion.z * REGION_UNITS - town.spawn.z * 10
    expect(terrain({ x: fx, y: 0, z: fz })?.open).toBe(true)
    const box = town.safeArea!
    expect(Math.abs(town.spawn.x - box.x)).toBeLessThan(box.halfX)
    expect(Math.abs(town.spawn.z - box.z)).toBeLessThan(box.halfZ)
  })
})
