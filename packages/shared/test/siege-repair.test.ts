/**
 * Siege of Jangan, layer 3: the shared repair rules (docs/SIEGE.md §2.4, §2.5, §7, §10.1, §14 "Unit"): donation math
 * (gold and Stone Blocks per %, clipping to the queue's room, blocks first), the "where it is needed" share (worst
 * first, the cap), the builders' and the kit's steps, the kit's reach, the looter nest, the content install, and the
 * wire messages.
 */
import { describe, expect, it } from 'vitest'
import {
  LOOTER_NEST_BASE,
  SIEGE_CODES,
  WALL_DEFAULTS,
  allocateDonation,
  blocksIp,
  builderStepIp,
  checkWallSettings,
  goldForIp,
  goldIp,
  installSiegeContent,
  kitIp,
  looterNest,
  nearestSegment,
  parseClientMessage,
  parseServerMessage,
  planDonation,
  queueCapIp,
  queueRoom,
  repairTerms,
  segmentDistance,
  wallSettings,
  type DropTable,
  type ItemDef,
  type NpcDef,
  type ShopDef,
  type WallsExport,
} from '../src/index.ts'

const S = wallSettings()

describe('donation math (defaults: 1 % = 200 ip = 2,000 gold = 2 Stone Blocks)', () => {
  it('gold and blocks buy work at the spec rate; the price of work rounds up', () => {
    expect(S.maxIp).toBe(20_000)
    expect(goldIp(2000, S)).toBe(200)
    expect(goldIp(2009, S)).toBe(200)
    expect(goldIp(9, S)).toBe(0)
    expect(goldForIp(200, S)).toBe(2000)
    expect(goldForIp(1, S)).toBe(10)
    expect(blocksIp(2, S)).toBe(200)
    expect(blocksIp(1, S)).toBe(100)
    // an odd rate: 3 blocks per % = 66.67 ip a block, rounded on the total
    expect(blocksIp(3, { ...S, blocksPerPct: 3 })).toBe(200)
  })

  it('takes blocks first, then gold for what is left, never more than the room', () => {
    // plenty of room: everything goes
    expect(planDonation(4000, 2, 100_000, S)).toEqual({ blocks: 2, gold: 4000, ip: 600 })
    // room for 2.5 %: 2 blocks (1 %) then 1.5 % of gold (3,000 of the 10,000 offered)
    expect(planDonation(10_000, 2, 500, S)).toEqual({ blocks: 2, gold: 3000, ip: 500 })
    // room for 0.5 %: one block fits, no gold is taken
    expect(planDonation(10_000, 4, 100, S)).toEqual({ blocks: 1, gold: 0, ip: 100 })
    // the last block may round past the room by less than one block
    expect(planDonation(0, 4, 150, S)).toEqual({ blocks: 2, gold: 0, ip: 200 })
    // no room, nothing taken
    expect(planDonation(10_000, 4, 0, S)).toEqual({ blocks: 0, gold: 0, ip: 0 })
    // too little gold to buy anything
    expect(planDonation(5, 0, 1000, S).ip).toBe(0)
  })

  it('queue room: one segment or all, each capped at 50 %', () => {
    const segs = [{ id: 'W1', ip: 20_000, queued: 0 }, { id: 'W2', ip: -10_000, queued: 9_000 }, { id: 'W3', ip: 0, queued: 12_000 }]
    expect(queueCapIp(S)).toBe(10_000)
    expect(queueRoom(segs, 'W1', S)).toBe(10_000)
    expect(queueRoom(segs, 'W2', S)).toBe(1_000)
    expect(queueRoom(segs, 'W3', S)).toBe(0)
    expect(queueRoom(segs, null, S)).toBe(11_000)
  })

  it('"where it is needed" fills the worst segments first and respects the caps', () => {
    const segs = [
      { id: 'N1', ip: 20_000, queued: 0 },
      { id: 'N2', ip: 10_000, queued: 0 },
      { id: 'N3', ip: -10_000, queued: 0 },
      { id: 'N4', ip: 4_000, queued: 0 },
    ]
    // 2 % all to the rubble
    expect([...allocateDonation(segs, 400, null, S)]).toEqual([['N3', 400]])
    // enough to bring N3 up to N4's level (14,000) and then share
    const a = allocateDonation(segs, 16_000, null, S)
    expect(a.get('N3')).toBe(10_000) // capped at 50 %
    expect((a.get('N4') ?? 0) + (a.get('N2') ?? 0) + (a.get('N1') ?? 0)).toBe(6_000)
    expect(a.get('N4')).toBeGreaterThan(a.get('N2') ?? 0)
    // a target takes it all
    expect([...allocateDonation(segs, 300, 'N1', S)]).toEqual([['N1', 300]])
    // nothing in, nothing out
    expect(allocateDonation(segs, 0, null, S).size).toBe(0)
  })

  it('builders and the kit', () => {
    expect(builderStepIp(60_000, S)).toBe(200)
    expect(builderStepIp(15_000, S)).toBe(50)
    expect(builderStepIp(15_000, { ...S, builderPctPerMin: 0 })).toBe(0)
    expect(kitIp(S)).toBe(200)
  })

  it('settings: the repair numbers have bounds; the terms the client sees', () => {
    expect(checkWallSettings({ goldPerPct: 50 })).toEqual(['goldPerPct must be a number in 100..100000'])
    expect(checkWallSettings({ queueCapPct: 151, looters: 11 })).toHaveLength(2)
    expect(checkWallSettings({ kitChannelS: 5, looterRespawnMin: 2 })).toEqual([])
    expect(repairTerms(WALL_DEFAULTS)).toEqual({ goldPerPct: 2000, blocksPerPct: 2, queueCapPct: 50, builderPctPerMin: 1, kitPct: 1, kitChannelS: 10, kitPrice: 1500, kitRangeM: 8 })
  })
})

const walls: Pick<WallsExport, 'segments' | 'sides'> = {
  sides: [
    { side: 'N', axis: 'x', line: -96, outer: -104, inner: -88, out: -1, walkY: 20, placement: { region: 1, uid: 1, source: '', position: [0, 0, 0] }, retailInstance: 1, fixed: [] },
    { side: 'W', axis: 'z', line: -177, outer: -185, inner: -169, out: -1, walkY: 20, placement: { region: 1, uid: 1, source: '', position: [0, 0, 0] }, retailInstance: 1, fixed: [] },
  ],
  segments: [
    { id: 'N1', side: 'N', from: 0, to: 48, thirds: [] as never },
    { id: 'N2', side: 'N', from: 48, to: 96, thirds: [] as never },
    { id: 'W1', side: 'W', from: -300, to: -250, thirds: [] as never },
  ],
}

describe("the kit's reach", () => {
  it('distance to the body, from either side and past the ends', () => {
    const n = walls.sides[0]!
    expect(segmentDistance(n, walls.segments[0]!, 10, -96)).toBe(0)
    expect(segmentDistance(n, walls.segments[0]!, 10, -80)).toBe(8)
    expect(segmentDistance(n, walls.segments[0]!, 10, -110)).toBe(6)
    expect(segmentDistance(n, walls.segments[0]!, -3, -84)).toBe(5)
  })

  it('the nearest segment within range', () => {
    expect(nearestSegment(walls, 40, -82, 8)?.seg.id).toBe('N1')
    expect(nearestSegment(walls, 50, -82, 8)?.seg.id).toBe('N2')
    expect(nearestSegment(walls, 40, -70, 8)).toBeNull()
    expect(nearestSegment(walls, -165, -260, 8)?.seg.id).toBe('W1')
  })
})

describe('looters and content', () => {
  it('a looter nest at the breach zone, leashed to it', () => {
    const n = looterNest({ seg: 'W3', x: -159, z: -120, r: 50 }, 2, { code: SIEGE_CODES.looter, level: 16, aggressive: true }, 'jangan', S)
    expect(n).toMatchObject({ id: LOOTER_NEST_BASE + 2, mob: 'MOB_CH_BANDIT', x: -159, z: -120, count: 3, respawnSec: [300, 300], world: 'jangan', provenance: 'authored' })
    expect(n.tactics.leashRange).toBe(50)
    expect(looterNest({ seg: 'W3', x: 0, z: 0, r: 0 }, 0, { code: 'M', level: 1, aggressive: false }, 'jangan', { looters: 1, looterRespawnMin: 1 }).tactics.leashRange).toBe(15)
  })

  it('installs Ko, his shop, the two items and the Stone Ghost drop once; existing rows win', () => {
    const ghost: DropTable = { mob: 'MOB_CH_STONEGHOST', groups: [{ chance: 0.1, entries: [{ item: 'ITEM_ETC_HP_POTION_01', weight: 1 }] }], provenance: 'client' }
    const t = { items: new Map<string, ItemDef>(), shops: new Map<string, ShopDef>(), drops: new Map([[ghost.mob, ghost]]), npcs: [] as NpcDef[] }
    expect(installSiegeContent(t, 'jangan', 1800)).toEqual({ items: 2, npc: true, shop: true, drops: 1 })
    expect(t.items.get(SIEGE_CODES.kit)).toMatchObject({ name: "Mason's Kit", price: 1800, maxStack: 20, use: { masonKit: true } })
    expect(t.items.get(SIEGE_CODES.block)).toMatchObject({ name: 'Stone Block', price: 1200, maxStack: 50 })
    expect(t.items.get(SIEGE_CODES.block)!.icon).toMatch(/^\/out\/icons\/item\/etc\/.+\.png$/)
    expect(t.npcs[0]).toMatchObject({ code: SIEGE_CODES.mason, name: 'Master Mason Ko', shop: SIEGE_CODES.shop, world: 'jangan' })
    expect(t.shops.get(SIEGE_CODES.shop)!.tabs[0]!.items).toEqual([SIEGE_CODES.kit, SIEGE_CODES.block])
    const drop = t.drops.get('MOB_CH_STONEGHOST')!.groups.at(-1)!
    expect(drop).toEqual({ chance: 0.08, entries: [{ item: SIEGE_CODES.block, weight: 1 }] })
    // again: nothing new (the drop group is not added twice)
    expect(installSiegeContent(t, 'jangan')).toEqual({ items: 0, npc: false, shop: false, drops: 0 })
    expect(t.drops.get('MOB_CH_STONEGHOST')!.groups).toHaveLength(2)
    // the client's tables keep NPCs in a map
    const m = { items: new Map<string, ItemDef>(), shops: new Map<string, ShopDef>(), drops: new Map<string, DropTable>(), npcs: new Map<string, NpcDef>() }
    expect(installSiegeContent(m, 'jangan').npc).toBe(true)
    expect(m.npcs.get(SIEGE_CODES.mason)?.greeting).toMatch(/mason/i)
  })
})

describe('wire messages (protocol v1, additive)', () => {
  const client = (m: unknown) => parseClientMessage(JSON.stringify(m))
  const server = (m: unknown) => parseServerMessage(JSON.stringify(m))

  it('wallDonate and wallRepair parse; bad ones are refused', () => {
    expect(client({ t: 'wallDonate', npc: 5, gold: 2000 })).toEqual({ ok: true, msg: { t: 'wallDonate', npc: 5, gold: 2000 } })
    expect(client({ t: 'wallDonate', npc: 5, seg: 'W3', blocks: 4, gold: 1 }).ok).toBe(true)
    expect(client({ t: 'wallDonate', npc: 5 }).ok).toBe(false)
    expect(client({ t: 'wallDonate', npc: 5, gold: -2000 }).ok).toBe(false)
    expect(client({ t: 'wallDonate', npc: 5, gold: 0 }).ok).toBe(false)
    expect(client({ t: 'wallDonate', npc: 5, gold: 1.5 }).ok).toBe(false)
    expect(client({ t: 'wallDonate', npc: 5, seg: 'X1', gold: 10 }).ok).toBe(false)
    expect(client({ t: 'wallDonate', npc: 5, gold: 10, extra: 1 }).ok).toBe(false)
    expect(client({ t: 'wallRepair', seg: 'N10' }).ok).toBe(true)
    expect(client({ t: 'wallRepair' }).ok).toBe(false)
  })

  it('walls carry the repair terms; segments and updates carry repairing and queued', () => {
    const terms = repairTerms(WALL_DEFAULTS)
    const r = server({ t: 'walls', segs: [{ id: 'W3', stage: 'breached', pct: -3, repairing: true, queued: 12.5 }], repair: terms })
    expect(r).toEqual({ ok: true, msg: { t: 'walls', segs: [{ id: 'W3', stage: 'breached', pct: -3, repairing: true, queued: 12.5 }], repair: terms } })
    expect(server({ t: 'wallUpdate', id: 'W3', stage: 'breached', pct: -2.5, at: 1, repairing: true, queued: 3 })).toEqual({
      ok: true, msg: { t: 'wallUpdate', id: 'W3', stage: 'breached', pct: -2.5, at: 1, repairing: true, queued: 3 },
    })
    expect(server({ t: 'wallUpdate', id: 'W3', stage: 'breached', pct: -2.5, at: 1, queued: -1 }).ok).toBe(false)
    expect(server({ t: 'npcDialog', npc: 1, code: SIEGE_CODES.mason, services: ['shop', 'mason'] }).ok).toBe(true)
  })
})
