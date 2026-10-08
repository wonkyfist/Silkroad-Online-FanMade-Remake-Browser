/**
 * Siege of Jangan, layer 5: player kegs and Wanted (docs/SIEGE.md §7, §8.1, §8.5, §8.6, §14).
 *
 * - pure rules: the offence record and its forgiveness (one level per 30 clean days), bounties (offence, accomplice
 *   half, treason ×2, the cap), sentences (for layer 6), where a keg may go (`kegSpot`: the outer foot, never a
 *   gatehouse or a corner, never inside), the content (the keg is character-bound), the settings;
 * - on a flat world with a stand-in wall: Old Fang crafts a keg (gold, Saltpeter, the carry limit); a plant (the cast,
 *   the server-wide notice without a name, the fuse, the blast's damage); a breach makes the planter Wanted (the notice
 *   names them, the bounty, the WANTED label in EntityState and entityUpdate, lawState); accomplices (an earlier keg on
 *   the same segment within 10 min, not 11 min before) at half; treason during a siege (×2, no siege rewards for them
 *   and their associates); a defuse (not by the planter's alt);
 * - the warrant's lifecycle: the clock runs only online, survives a logout and a restart, lapses (the notice, the label
 *   goes, the offence stays); the capture hook pays the bounty from the server;
 * - the offence record is per account (an alt's breach is offence 2), forgiven after 30 clean days;
 * - abuse: kegs in a safe area, at a gatehouse, at a corner tower, from the inner side, too far, below level 18, under
 *   10 h played, a second plant on another character of the account within 30 min, an already-breached segment;
 * - GM `law`.
 */
import {
  LAW_CODES,
  SIEGE_EVENT_DEFAULTS,
  WALL_DEFAULTS,
  addOffence,
  checkSiegeEventSettings,
  fenceNpc,
  installSiegeLawContent,
  kegSpot,
  offenceLevel,
  sentenceMs,
  thunderKegItem,
  wallStage,
  wantedBounty,
  type ServerMessage,
  type Vec3,
  type WallSegView,
  type WallStage,
  type WallsExport,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { GameData } from '../src/gamedata.ts'
import { addGold, addItem } from '../src/inventory.ts'
import type { SiegeWalls } from '../src/siege/event.ts'
import type { KegWalls } from '../src/siege/keg.ts'
import { LawService } from '../src/siege/law.ts'
import type { ApproachLanes, Lane } from '../src/siege/lanes.ts'
import { WallStore } from '../src/siege/store.ts'
import type { WallEvent } from '../src/siege/walls.ts'
import type { Player } from '../src/world.ts'
import { mob } from './fixtures.ts'
import { SAFE_TOWN, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const LAW = SIEGE_EVENT_DEFAULTS.law

// ---- the stand-in wall: N1 (x -60..-20) and N2 (x -20..20) on a north wall at z -100 (outer face -104) ----------------------

function wallsOf(): Pick<WallsExport, 'segments' | 'sides'> {
  const seg = (id: string, from: number) => {
    const third = (k: number) => {
      const a = from + (40 / 3) * k
      const mid = a + 20 / 3
      return { id: `${id}${'abc'[k]}`, from: a, to: a + 40 / 3, instances: [], tiles: [], assault: [mid, 0, -106] as Vec3, rally: [mid, 0, -86] as Vec3 }
    }
    return { id, side: 'N' as const, from, to: from + 40, thirds: [third(0), third(1), third(2)] as const }
  }
  return {
    sides: [
      {
        side: 'N', axis: 'x', line: -100, outer: -104, inner: -96, out: -1, walkY: 20, placement: { region: 1, uid: 1, source: 'w', position: [0, 0, -100] }, retailInstance: 1,
        fixed: [
          { id: 'N-end0', from: -1e6, to: -60, what: 'corner', instances: [] },
          { id: 'N-gate', from: 20, to: 40, what: 'gate', instances: [] },
          { id: 'N-end1', from: 40, to: 1e6, what: 'corner', instances: [] },
        ],
      },
    ],
    segments: [seg('N1', -60) as unknown as WallsExport['segments'][number], seg('N2', -20) as unknown as WallsExport['segments'][number]],
  }
}

/** Both the siege's and the keg's view of the walls; writes wall_log (cause keg) like WallService. */
class StandIn implements SiegeWalls, KegWalls {
  readonly on = true
  readonly walls = wallsOf() as WallsExport
  readonly settings = { maxIp: WALL_DEFAULTS.maxIp }
  readonly ip = new Map<string, number>([['N1', 20_000], ['N2', 20_000]])
  readonly stage = new Map<string, WallStage>([['N1', 'intact'], ['N2', 'intact']])
  private fns: ((e: WallEvent) => void)[] = []
  sieging = () => false
  extraUnsafe: ((x: number, z: number) => boolean) | null = null
  constructor(private readonly log: WallStore | null = null) {}
  stageOf(id: string): WallStage | null {
    return this.stage.get(id) ?? null
  }
  change(id: string, delta: number, cause: string, now: number, opts: { characterId?: number | null; data?: Record<string, unknown> } = {}) {
    const before = this.ip.get(id)!
    const after = Math.max(-10_000, Math.min(20_000, Math.round(before + delta)))
    const stageBefore = this.stage.get(id)!
    const stage = wallStage(after, WALL_DEFAULTS, stageBefore)
    this.ip.set(id, after)
    this.stage.set(id, stage)
    this.log?.log(id, now, cause, after - before, stage, opts.characterId ?? null, opts.data ?? {})
    const e: WallEvent = { id, cause, delta: after - before, stage, stageBefore, characterId: opts.characterId ?? null, data: opts.data ?? {}, at: now }
    for (const f of this.fns) f(e)
    return { id, before, after, stage, stageBefore }
  }
  set(id: string, pct: number): void {
    this.ip.set(id, Math.round((pct / 100) * 20_000))
    this.stage.set(id, wallStage(this.ip.get(id)!, WALL_DEFAULTS))
  }
  onWallEvent(fn: (e: WallEvent) => void): () => void {
    this.fns.push(fn)
    return () => void (this.fns = this.fns.filter((f) => f !== fn))
  }
  refreshZones(): void {}
  views(): WallSegView[] {
    return [...this.ip].map(([id, ip]) => ({ id, stage: this.stage.get(id)!, pct: ip / 200 }))
  }
}

const BANDIT = mob('MOB_CH_BANDIT', { name: 'Bandit', level: 16, hp: 755, attackRange: 0.4, attackIntervalMs: 1500, walkSpeed: 1.5, runSpeed: 5.5, aggressive: true })

let cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

/** The foot of N1 outside the wall (6 m out of the outer face; the town's safe area ends at z -80). */
const FOOT: Vec3 = [-40, 0, -110]

function lawHarness() {
  const data = new GameData({ mobs: [{ ...BANDIT }], items: SKILL_ITEMS, levels: SKILL_LEVELS, towns: [{ ...SAFE_TOWN, safeArea: { x: 0, z: 0, halfX: 80, halfZ: 80 } }] })
  installSiegeLawContent({ items: data.items, drops: data.drops, npcs: data.npcs }, 'jangan')
  const h = skillHarness({ data, config: { uniques: false } })
  cleanups.push(h.cleanup)
  const g = h.gameplay
  const walls = new StandIn(new WallStore(h.store.db, 'jangan'))
  g.kegs.configure({ walls })
  const lane = (seg: string, x: number): Lane => ({ approach: 'N', seg, outer: [[0, -260], [x, -140]], assault: [x, 0, -102], foot: [x, -102], rally: [x, -90], inner: [[x, -30]], axis: 'x', out: -1 })
  const lanes: ApproachLanes[] = [{ approach: 'N', name: 'the north fields', muster: [0, -260], lanes: [lane('N1', -40), lane('N2', 0)], dropped: [] }]
  g.siege.configure({ walls, lanes, bell: [0, 0] })
  g.siege.tick(h.now)
  g.siege.applyPatch({ timing: { approaches: 1 }, waves: { w1Raiders: 0, w1Sappers: 0 } }, 0)
  const law = g.law
  const tick = (ms: number) => h.runTo(h.now + ms)

  /** A level-20 character with 20 h played, optionally on the account of `alt`. */
  const char = (pos: Vec3, o: { name?: string; level?: number; playedH?: number; alt?: Player } = {}) => {
    let characterId: number | undefined
    if (o.alt) {
      const acc = h.store.characterById(o.alt.characterId)!.account_id
      const row = h.store.createCharacter(acc, o.name ?? `Alt${Math.floor(Math.random() * 1e6)}`, 'CHAR_CH_MAN_ADVENTURER', 'sword', 'jangan', 4)
      if (typeof row === 'string') throw new Error(row)
      characterId = row.id
      h.store.saveProgress(row.id, { level: o.level ?? 20, exp: 0, sp: 0, spExp: 0, str: 39, int: 39, statPoints: 0 })
    }
    const r = h.hero({ pos, level: o.level ?? 20, ...(o.name && !o.alt ? { name: o.name } : {}), ...(characterId ? { characterId } : {}) })
    r.p.maxHp = r.p.hp = 100_000
    h.store.db.prepare('UPDATE characters SET played_ms = ? WHERE id = ?').run(Math.round((o.playedH ?? 20) * HOUR), r.p.characterId)
    return r
  }
  const give = (p: Player, code: string, n = 1) => {
    const def = data.item(code)!
    const { draft } = h.store.inventoryTx(p.characterId, (d) => addItem(d, def, n))
    g.afterInventory(p, draft)
  }
  const gold = (p: Player, n: number) => {
    const { draft } = h.store.inventoryTx(p.characterId, (d) => addGold(d, n))
    g.afterInventory(p, draft)
  }
  const count = (p: Player, code: string) => h.store.loadInventory(p.characterId).bag.reduce((s, i) => s + (i?.code === code ? i.count : 0), 0)
  const slotOf = (p: Player, code: string) => h.store.loadInventory(p.characterId).bag.findIndex((i) => i?.code === code)
  /** Uses the keg from the bag; returns the actionResult. */
  const plant = (p: Player, inbox: ServerMessage[]) => {
    if (slotOf(p, LAW_CODES.keg) < 0) give(p, LAW_CODES.keg)
    h.req(p, { t: 'itemUse', bag: slotOf(p, LAW_CODES.keg) })
    return h.result(inbox, 'itemUse')
  }
  /** Plants and lets the keg blow (5 s cast + 15 s fuse). */
  const blow = (p: Player, inbox: ServerMessage[]) => {
    const r = plant(p, inbox)
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true })
    tick(5100)
    tick(15_100)
  }
  const accountOf = (p: Player) => h.store.characterById(p.characterId)!.account_id
  return { h, g, law, walls, tick, char, give, gold, count, slotOf, plant, blow, accountOf, data }
}

// ---- pure rules -------------------------------------------------------------------------------------------------------------

describe('the offence record (§8.5: per account, one level forgiven per 30 clean days)', () => {
  it('forgiveness counts whole 30-day spans since the last offence, never below 0', () => {
    const T = 1_000 * DAY
    expect(offenceLevel(null, T, 30)).toBe(0)
    expect(offenceLevel({ offences: 3, lastAt: T }, T + 29 * DAY, 30)).toBe(3)
    expect(offenceLevel({ offences: 3, lastAt: T }, T + 30 * DAY, 30)).toBe(2)
    expect(offenceLevel({ offences: 3, lastAt: T }, T + 95 * DAY, 30)).toBe(0)
    expect(addOffence({ offences: 3, lastAt: T }, T + 31 * DAY, 30)).toEqual({ offences: 3, lastAt: T + 31 * DAY })
    expect(addOffence(null, T, 30)).toEqual({ offences: 1, lastAt: T })
  })
})

describe('bounties and sentences (§8.1, §8.5)', () => {
  it('bounty 20,000 × offence (cap ×4); an accomplice half; treason ×2', () => {
    expect([1, 2, 3, 4, 5, 9].map((o) => wantedBounty(o, 'breaker', false, LAW))).toEqual([20_000, 40_000, 60_000, 80_000, 80_000, 80_000])
    expect(wantedBounty(1, 'accomplice', false, LAW)).toBe(10_000)
    expect(wantedBounty(1, 'breaker', true, LAW)).toBe(40_000)
    expect(wantedBounty(2, 'accomplice', true, LAW)).toBe(40_000)
  })
  it('sentences 2 / 4 / 8 / 16 / 24 h; an accomplice half (≥ 1 h); treason ×2 capped at 24 h', () => {
    expect([1, 2, 3, 4, 5, 6].map((o) => sentenceMs(o, 'breaker', false, LAW) / HOUR)).toEqual([2, 4, 8, 16, 24, 24])
    expect(sentenceMs(1, 'accomplice', false, LAW) / HOUR).toBe(1)
    expect(sentenceMs(3, 'accomplice', false, LAW) / HOUR).toBe(4)
    expect(sentenceMs(1, 'breaker', true, LAW) / HOUR).toBe(4)
    expect(sentenceMs(4, 'breaker', true, LAW) / HOUR).toBe(24)
  })
})

describe('where a keg may go (§7, §8.6)', () => {
  const w = wallsOf()
  it('the outer foot of a segment, within faceM of the outer face', () => {
    expect(kegSpot(w, -40, -110, 10)).toMatchObject({ ok: true, seg: { id: 'N1' } })
    expect(kegSpot(w, 0, -105, 10)).toMatchObject({ ok: true, seg: { id: 'N2' } })
    expect(kegSpot(w, -40, -115, 10)).toMatchObject({ ok: false, why: 'far' })
  })
  it('never at a gatehouse or a corner tower, never from the inner side', () => {
    expect(kegSpot(w, 30, -110, 10)).toEqual({ ok: false, why: 'gate' })
    expect(kegSpot(w, -70, -110, 10)).toEqual({ ok: false, why: 'gate' })
    expect(kegSpot(w, -40, -92, 10)).toEqual({ ok: false, why: 'inside' })
    expect(kegSpot(w, -40, -50, 10)).toEqual({ ok: false, why: 'far' })
  })
})

describe('content and settings', () => {
  it('the Thunder Keg is character-bound and used from the bag; Old Fang offers the fence service', () => {
    const k = thunderKegItem()
    expect(k).toMatchObject({ canTrade: false, canDrop: false, canStore: false, canSell: false, maxStack: 1, use: { thunderKeg: true } })
    expect(fenceNpc('jangan').roles).toEqual(['fence'])
  })
  it('the keg and law defaults of §11.2 (the plant reach widened to the ditch rim) and their bounds', () => {
    expect(SIEGE_EVENT_DEFAULTS.keg).toMatchObject({ damagePct: 60, plantSec: 5, fuseSec: 15, defuseSec: 3, cooldownMin: 30, minLevel: 18, minPlayHours: 10, gold: 50_000, saltpeter: 3, carry: 2, faceM: 10 })
    expect(SIEGE_EVENT_DEFAULTS.law).toMatchObject({ bountyBase: 20_000, bountyCapMul: 4, wantedOnlineHours: 2, accompliceWindowMin: 10, forgiveDays: 30, treasonMul: 2 })
    expect(checkSiegeEventSettings({ keg: { faceM: 8, gold: 10_000 }, law: { wantedOnlineHours: 1 } })).toEqual([])
    expect(checkSiegeEventSettings({ keg: { faceM: 100 }, law: { treasonMul: 0 } }).map((i) => i.path)).toEqual(['keg.faceM', 'law.treasonMul'])
  })
})

// ---- the flat world ---------------------------------------------------------------------------------------------------------

describe('Old Fang crafts Thunder Kegs (§7)', () => {
  it('50,000 gold and 3 Saltpeter make a keg; at most 2 carried; the level rule', () => {
    const x = lawHarness()
    const fang = x.g.placeNpc({ ...fenceNpc('jangan'), x: -40, z: -120 }, x.h.now)!
    const a = x.char([-40, 0, -118])
    x.gold(a.p, 200_000)
    const gold0 = x.h.store.loadInventory(a.p.characterId).gold
    x.give(a.p, LAW_CODES.saltpeter, 7)
    x.h.req(a.p, { t: 'kegCraft', npc: fang.id })
    expect(x.h.result(a.inbox, 'kegCraft')).toMatchObject({ ok: true })
    expect(x.count(a.p, LAW_CODES.keg)).toBe(1)
    expect(x.count(a.p, LAW_CODES.saltpeter)).toBe(4)
    expect(gold0 - x.h.store.loadInventory(a.p.characterId).gold).toBe(50_000)
    x.h.req(a.p, { t: 'kegCraft', npc: fang.id })
    expect(x.h.result(a.inbox, 'kegCraft')).toMatchObject({ ok: true })
    // a third: the carry limit
    x.h.req(a.p, { t: 'kegCraft', npc: fang.id })
    expect(x.h.result(a.inbox, 'kegCraft')).toMatchObject({ ok: false, reason: 'keg_limit' })
    expect(x.count(a.p, LAW_CODES.keg)).toBe(2)
    // no Saltpeter, a level-15 character
    const b = x.char([-41, 0, -118], { level: 15 })
    x.gold(b.p, 100_000)
    x.h.req(b.p, { t: 'kegCraft', npc: fang.id })
    expect(x.h.result(b.inbox, 'kegCraft')).toMatchObject({ ok: false, reason: 'requirements' })
    const c = x.char([-39, 0, -118])
    x.gold(c.p, 100_000)
    x.h.req(c.p, { t: 'kegCraft', npc: fang.id })
    expect(x.h.result(c.inbox, 'kegCraft')).toMatchObject({ ok: false, reason: 'invalid_count' })
  })
})

describe('a keg breaches the wall: the breaker is Wanted (§7.1, §8.1)', () => {
  it('the plant: a 5 s cast, a server-wide notice without a name; the fuse; the blast takes 60 %; a breach names the breaker', () => {
    const x = lawHarness()
    x.walls.set('N1', 50)
    const a = x.char(FOOT, { name: 'Breaker' })
    const o = x.char([0, 0, 0], { name: 'Watcher' })
    expect(x.plant(a.p, a.inbox)).toMatchObject({ ok: true })
    const plantNote = x.h.all(o.inbox, 'lawNotice').at(-1)
    expect(plantNote).toEqual({ t: 'lawNotice', event: 'plant', wall: 'N1' })
    expect(x.h.all(o.inbox, 'chat').some((c) => /Someone is planting a Thunder Keg/.test(c.text) && !c.text.includes('Breaker'))).toBe(true)
    expect(x.g.kegs.castOf(a.p)?.seg).toBe('N1')
    x.tick(5100)
    const keg = x.h.all(o.inbox, 'keg').at(-1)!
    expect(keg).toMatchObject({ seg: 'N1', x: -40, z: -110 })
    expect(keg.sapper).toBeUndefined()
    expect(x.count(a.p, LAW_CODES.keg)).toBe(0)
    expect(x.walls.ip.get('N1')).toBe(10_000)
    x.tick(15_100)
    expect(x.h.all(o.inbox, 'kegEnd').at(-1)).toMatchObject({ id: keg.id, how: 'blast' })
    expect(x.walls.ip.get('N1')).toBe(-2000)
    expect(x.walls.stage.get('N1')).toBe('breached')
    // the breach: everyone told, the breaker named
    expect(x.h.all(o.inbox, 'lawNotice').at(-1)).toEqual({ t: 'lawNotice', event: 'wanted', wall: 'N1', name: 'Breaker', bounty: 20_000 })
    expect(x.h.all(o.inbox, 'chat').some((c) => /Breaker has breached the North wall \(N1\)! A bounty of 20,000 gold/.test(c.text))).toBe(true)
    // the WANTED label: the entity state and an update to everyone in view
    expect(x.h.world.state(a.p).wanted).toBe(20_000)
    expect(x.h.all(o.inbox, 'entityUpdate').some((u) => u.id === a.p.id && u.wanted === 20_000)).toBe(true)
    expect(x.h.all(a.inbox, 'lawState').at(-1)).toEqual({ t: 'lawState', offences: 1, wanted: { bounty: 20_000, lapseMs: 2 * HOUR, offence: 1, role: 'breaker' } })
    expect(x.law.isWanted(a.p.characterId)).toBe(true)
    expect(x.law.offences(x.accountOf(a.p), x.h.now)).toBe(1)
    // a late joiner sees the label in the snapshot
    const late = x.char([10, 0, -110])
    expect(x.h.world.snapshotFor(late.p, x.h.now).find((e) => e.id === a.p.id)?.wanted).toBe(20_000)
  })

  it('a blast that does not breach: no Wanted; a keg at an open segment is refused', () => {
    const x = lawHarness()
    const a = x.char(FOOT)
    x.blow(a.p, a.inbox)
    expect(x.walls.ip.get('N1')).toBe(8000)
    expect(x.law.isWanted(a.p.characterId)).toBe(false)
    expect(x.h.world.state(a.p).wanted).toBeUndefined()
    x.walls.set('N1', -10)
    x.h.store.db.prepare('UPDATE law_records SET last_plant_at = NULL').run()
    expect(x.plant(a.p, a.inbox)).toMatchObject({ ok: false, reason: 'not_usable' })
  })

  it('accomplices: an earlier keg on the segment within 10 min is Wanted at half; one 11 min before is not', () => {
    const x = lawHarness()
    const old = x.char([-30, 0, -110], { name: 'Early' })
    const acc = x.char([-50, 0, -110], { name: 'Helper' })
    const brk = x.char(FOOT, { name: 'Breaker' })
    const o = x.char([0, 0, 0])
    x.blow(old.p, old.inbox) // 100 -> 40 %
    x.walls.set('N1', 100)
    x.tick(11 * MIN)
    x.blow(acc.p, acc.inbox) // 100 -> 40 %
    x.tick(3 * MIN)
    x.blow(brk.p, brk.inbox) // 40 -> -20 %: breached
    expect(x.walls.stage.get('N1')).toBe('breached')
    expect(x.h.all(o.inbox, 'lawNotice').at(-1)).toMatchObject({ event: 'wanted', name: 'Breaker', bounty: 20_000, accomplices: ['Helper'] })
    expect(x.law.wantedOf(brk.p.characterId)).toMatchObject({ bounty: 20_000, role: 'breaker', offence: 1 })
    expect(x.law.wantedOf(acc.p.characterId)).toMatchObject({ bounty: 10_000, role: 'accomplice', offence: 1 })
    expect(x.law.isWanted(old.p.characterId)).toBe(false)
    expect(x.h.world.state(acc.p).wanted).toBe(10_000)
  })

  it('treason: a keg breach during a siege doubles the bounty; the traitor and the associates get no siege rewards', () => {
    const x = lawHarness()
    x.walls.set('N1', 50)
    const r = x.g.siege.start('gm', 10, x.h.now)
    expect(r.ok, r.ok ? '' : r.message).toBe(true)
    const a = x.char(FOOT, { name: 'Traitor' })
    const alt = x.char([0, 0, 0], { alt: a.p, name: 'TraitorAlt' })
    const o = x.char([5, 0, 0], { name: 'Defender' })
    x.blow(a.p, a.inbox)
    expect(x.h.all(o.inbox, 'lawNotice').at(-1)).toMatchObject({ event: 'wanted', name: 'Traitor', bounty: 40_000, treason: true })
    expect(x.law.wantedOf(a.p.characterId)).toMatchObject({ bounty: 40_000, treason: true })
    // the siege counts the breach but leaves the naming to the law
    expect(x.g.siege.ev!.breaches.has('N1')).toBe(true)
    expect(x.h.all(o.inbox, 'siegeNotice').some((n) => n.event === 'breach')).toBe(false)
    const ev = x.g.siege.ev!.id
    expect(x.law.barredFromSiege(ev, a.p.characterId, a.p)).toBe(true)
    expect(x.law.barredFromSiege(ev, alt.p.characterId, alt.p)).toBe(true)
    expect(x.law.barredFromSiege(ev, o.p.characterId, o.p)).toBe(false)
    // the rewards: the traitor's alt earned points but gets nothing; the defender is paid
    const bandit = x.g.createMob(BANDIT, 'normal', 3, 3, 0, null, x.h.now)
    bandit.siege = { event: ev, role: 'raider', approach: 'N', seg: 'N1', wave: 1, mode: 'engage', resume: 'march', path: [], offset: [0, 0], startAt: 0, retried: false, stuck: 0, nextActAt: 0, nextLookAt: 0 } as never
    x.g.siege.onHits(alt.p, bandit, 5000, x.h.now)
    x.g.siege.onHits(o.p, bandit, 5000, x.h.now)
    x.g.siege.end(x.g.siege.ev!, 'won', x.h.now)
    expect(x.h.all(alt.inbox, 'siegeReward').at(-1)?.reward).toMatchObject({ gold: 0, seals: 0, rank: 0 })
    expect(x.h.all(o.inbox, 'siegeReward').at(-1)?.reward.gold).toBeGreaterThan(0)
  })

  it('a stranger defuses the keg (no blast); the planter and the planter’s alt may not', () => {
    const x = lawHarness()
    const a = x.char(FOOT, { name: 'Planter' })
    const alt = x.char([-39, 0, -110], { alt: a.p })
    const d = x.char([-41, 0, -110], { name: 'Hero' })
    expect(x.plant(a.p, a.inbox)).toMatchObject({ ok: true })
    x.tick(5100)
    const k = [...x.g.kegs.kegs.values()][0]!
    // layer 6: the planter and the planter's associates are told the keg is theirs (no Defuse prompt)
    expect(x.h.all(a.inbox, 'keg').at(-1)).toMatchObject({ id: k.id, mine: true })
    expect(x.h.all(alt.inbox, 'keg').at(-1)).toMatchObject({ id: k.id, mine: true })
    expect(x.h.all(d.inbox, 'keg').at(-1)?.mine).toBeUndefined()
    x.h.req(alt.p, { t: 'kegDefuse', id: k.id })
    expect(x.h.result(alt.inbox, 'kegDefuse')).toMatchObject({ ok: false, reason: 'not_usable' })
    x.h.req(a.p, { t: 'kegDefuse', id: k.id })
    expect(x.h.result(a.inbox, 'kegDefuse')).toMatchObject({ ok: false, reason: 'not_usable' })
    x.h.req(d.p, { t: 'kegDefuse', id: k.id })
    expect(x.h.result(d.inbox, 'kegDefuse')).toMatchObject({ ok: true })
    x.tick(3100)
    expect(x.g.kegs.kegs.size).toBe(0)
    expect(x.h.all(d.inbox, 'kegEnd').at(-1)).toMatchObject({ id: k.id, how: 'defused' })
    expect(x.h.all(a.inbox, 'lawNotice').at(-1)).toEqual({ t: 'lawNotice', event: 'defused', wall: 'N1', name: 'Hero' })
    x.tick(20_000)
    expect(x.walls.ip.get('N1')).toBe(20_000)
  })
})

describe('lookouts (layer 6 anti-collusion, §8.6)', () => {
  it('players within 30 m of the plant or the burning keg who never try to defuse it claim no bounty on the planter', () => {
    const x = lawHarness()
    x.walls.set('N1', 50)
    const a = x.char(FOOT, { name: 'Breaker' })
    const look = x.char([-40, 0, -125], { name: 'Lookout' })
    const helper = x.char([-42, 0, -126], { name: 'Helper' })
    const far = x.char([0, 0, -125], { name: 'Far' })
    expect(x.plant(a.p, a.inbox)).toMatchObject({ ok: true })
    x.tick(5100)
    const k = [...x.g.kegs.kegs.values()][0]!
    // the helper walks up and tries to defuse, then runs (the try counts)
    x.h.world.warp(helper.p, -41, 0, -111, x.h.now)
    x.h.req(helper.p, { t: 'kegDefuse', id: k.id })
    expect(x.h.result(helper.inbox, 'kegDefuse')).toMatchObject({ ok: true })
    x.h.world.warp(helper.p, -42, 0, -126, x.h.now)
    x.tick(15_100)
    expect(x.law.isWanted(a.p.characterId)).toBe(true)
    const acc = (p: Player) => x.accountOf(p)
    const since = x.h.now - 86_400_000
    expect(x.law.store.contactSince(acc(look.p), acc(a.p), since)).toBe('lookout')
    expect(x.law.store.contactSince(acc(helper.p), acc(a.p), since)).toBeNull()
    expect(x.law.store.contactSince(acc(far.p), acc(a.p), since)).toBeNull()
    // the lookout catches the breaker: no gold, no credit; the honest helper is paid
    const r = x.law.capture(a.p.characterId, [{ player: look.p, share: 1 }, { player: helper.p, share: 1 }], x.h.now)!
    expect(r.captors).toEqual([
      { characterId: look.p.characterId, name: 'Lookout', gold: 0, credit: false, rule: 'lookout' },
      { characterId: helper.p.characterId, name: 'Helper', gold: 20_000, credit: true },
    ])
  })
})

describe('the warrant (§8.1): online time, logout, restart, lapse', () => {
  it('the clock runs only online; a logout and a restart keep what is left; it lapses after 2 h online, the offence stays', () => {
    const x = lawHarness()
    x.walls.set('N1', 50)
    const a = x.char(FOOT, { name: 'Runner' })
    const o = x.char([0, 0, 0])
    x.blow(a.p, a.inbox)
    expect(x.law.wantedOf(a.p.characterId)?.lapseMs).toBeCloseTo(2 * HOUR, -3)
    x.tick(30 * MIN)
    expect(x.law.wantedOf(a.p.characterId)?.lapseMs).toBeCloseTo(90 * MIN, -3)
    // logout: what is left is saved; five hours offline count for nothing
    x.g.forget(a.p)
    x.h.world.remove(a.p.id)
    const row = () => x.h.store.db.prepare("SELECT online_ms_left AS left, status FROM warrants WHERE character_id = ?").get(a.p.characterId) as { left: number; status: string }
    expect(row().left).toBeCloseTo(90 * MIN, -3)
    x.tick(5 * HOUR)
    expect(row()).toMatchObject({ status: 'open' })
    // a restart: a new law service over the same database
    const law2 = new LawService(x.g)
    const back = x.h.hero({ characterId: a.p.characterId, pos: FOOT })
    law2.enter(back.p, x.h.now)
    expect(law2.wantedOf(back.p.characterId)?.lapseMs).toBeCloseTo(90 * MIN, -3)
    expect(law2.bountyOf(back.p.characterId)).toBe(20_000)
    // the enter-world snapshot came before the law's enter hook: the label follows as an update
    expect(x.h.all(back.inbox, 'entityUpdate').some((u) => u.id === back.p.id && u.wanted === 20_000)).toBe(true)
    // 90 more minutes online: it lapses
    for (let t = 0; t < 91; t++) {
      x.h.now += MIN
      law2.tick(x.h.now)
    }
    expect(row()).toMatchObject({ status: 'lapsed', left: 0 })
    expect(law2.isWanted(back.p.characterId)).toBe(false)
    expect(x.h.all(o.inbox, 'lawNotice').at(-1)).toEqual({ t: 'lawNotice', event: 'lapsed', name: 'Runner' })
    expect(x.h.all(o.inbox, 'entityUpdate').some((u) => u.id === back.p.id && u.wanted === 0)).toBe(true)
    expect(x.h.all(back.inbox, 'lawState').at(-1)).toEqual({ t: 'lawState', offences: 1 })
    expect(law2.offences(x.accountOf(back.p), x.h.now)).toBe(1)
  })

  it('accomplices are found after a restart (wall_log)', () => {
    const x = lawHarness()
    const acc = x.char([-50, 0, -110], { name: 'Before' })
    const brk = x.char(FOOT, { name: 'After' })
    x.blow(acc.p, acc.inbox)
    // the server restarts between the two kegs
    const law2 = new LawService(x.g)
    ;(x.g as { law: LawService }).law = law2
    x.blow(brk.p, brk.inbox)
    expect(x.walls.stage.get('N1')).toBe('breached')
    expect(law2.wantedOf(acc.p.characterId)).toMatchObject({ role: 'accomplice', bounty: 10_000 })
  })

  it('the capture hook (layer 6): the warrant closes captured, the server pays the bounty, the sentence comes back', () => {
    const x = lawHarness()
    x.walls.set('N1', 50)
    const a = x.char(FOOT, { name: 'Caught' })
    const hunter = x.char([0, 0, 0], { name: 'Hunter' })
    const alt = x.char([1, 0, 0], { alt: a.p })
    x.blow(a.p, a.inbox)
    const before = x.h.store.loadInventory(hunter.p.characterId).gold
    const r = x.law.capture(a.p.characterId, [{ player: hunter.p, share: 3 }, { player: alt.p, share: 1 }], x.h.now)!
    expect(r).toMatchObject({ bounty: 20_000, sentenceMs: 2 * HOUR, offence: 1 })
    // the Wanted's own alt is an associate: nothing for it; the Hunter gets it all
    expect(r.paid.get(hunter.p.characterId)).toBe(20_000)
    expect(r.paid.has(alt.p.characterId)).toBe(false)
    expect(x.h.store.loadInventory(hunter.p.characterId).gold - before).toBe(20_000)
    expect(x.law.isWanted(a.p.characterId)).toBe(false)
    expect(x.h.world.state(a.p).wanted).toBeUndefined()
    expect(x.law.capture(a.p.characterId, [], x.h.now)).toBeNull()
  })
})

describe('the record is per account (§8.5, §8.6)', () => {
  it("an alt's breach is the account's second offence (bounty 40,000); 30 clean days forgive a level", () => {
    const x = lawHarness()
    x.walls.set('N1', 50)
    const a = x.char(FOOT, { name: 'Main' })
    x.blow(a.p, a.inbox)
    expect(x.law.wantedOf(a.p.characterId)).toMatchObject({ offence: 1, bounty: 20_000 })
    x.walls.set('N2', 50)
    const alt = x.char([0, 0, -110], { alt: a.p, name: 'MainAlt' })
    // the plant cooldown is the account's: wait it out
    expect(x.plant(alt.p, alt.inbox)).toMatchObject({ ok: false, reason: 'keg_limit' })
    x.tick(31 * MIN)
    x.blow(alt.p, alt.inbox)
    expect(x.walls.stage.get('N2')).toBe('breached')
    expect(x.law.wantedOf(alt.p.characterId)).toMatchObject({ offence: 2, bounty: 40_000 })
    const acc = x.accountOf(a.p)
    expect(x.law.offences(acc, x.h.now)).toBe(2)
    expect(x.law.offences(acc, x.h.now + 30 * DAY)).toBe(1)
    expect(x.law.offences(acc, x.h.now + 60 * DAY)).toBe(0)
  })
})

describe('abuse (§8.6)', () => {
  it('refused: a safe area, a gatehouse, a corner tower, the inner side, too far, below level 18, under 10 h played', () => {
    const x = lawHarness()
    const cases: [Vec3, string][] = [
      [[-40, 0, -70], 'safe_zone'],
      [[30, 0, -110], 'wrong_place'],
      [[-70, 0, -110], 'wrong_place'],
      [[-40, 0, -92], 'wrong_place'],
      [[-40, 0, -130], 'too_far'],
    ]
    for (const [pos, reason] of cases) {
      const c = x.char(pos)
      expect(x.plant(c.p, c.inbox), JSON.stringify(pos)).toMatchObject({ ok: false, reason })
    }
    const low = x.char(FOOT, { level: 17 })
    expect(x.plant(low.p, low.inbox)).toMatchObject({ ok: false, reason: 'requirements' })
    const fresh = x.char(FOOT, { playedH: 9 })
    expect(x.plant(fresh.p, fresh.inbox)).toMatchObject({ ok: false, reason: 'requirements' })
    expect(x.g.kegs.kegs.size).toBe(0)
  })

  it('one plant per account per 30 min (another character of the account too); moving breaks the cast', () => {
    const x = lawHarness()
    const a = x.char(FOOT)
    expect(x.plant(a.p, a.inbox)).toMatchObject({ ok: true })
    x.h.world.moveTo(a.p, -40, -112, x.h.now)
    x.tick(200)
    expect(x.g.kegs.castOf(a.p)).toBeNull()
    expect(x.h.all(a.inbox, 'itemCastEnd').at(-1)).toMatchObject({ reason: 'interrupted' })
    x.h.world.warp(a.p, FOOT[0], 0, FOOT[2], x.h.now)
    expect(x.plant(a.p, a.inbox)).toMatchObject({ ok: true })
    x.tick(5100)
    expect(x.g.kegs.kegs.size).toBe(1)
    const alt = x.char([-30, 0, -110], { alt: a.p })
    expect(x.plant(alt.p, alt.inbox)).toMatchObject({ ok: false, reason: 'keg_limit' })
    x.tick(29 * MIN)
    expect(x.plant(alt.p, alt.inbox)).toMatchObject({ ok: false, reason: 'keg_limit' })
    x.tick(MIN + 1000)
    expect(x.plant(alt.p, alt.inbox)).toMatchObject({ ok: true })
  })

  it('the plant notice is rate-limited per segment (one per 2 min)', () => {
    const x = lawHarness()
    const o = x.char([0, 0, 0])
    const a = x.char(FOOT)
    const b = x.char([-45, 0, -110])
    x.plant(a.p, a.inbox)
    x.plant(b.p, b.inbox)
    expect(x.h.all(o.inbox, 'lawNotice').filter((n) => n.event === 'plant')).toHaveLength(1)
  })
})

describe('GM law (§12)', () => {
  it('status, record, wanted / off, lapse, forgive, capture, cooldown', () => {
    const x = lawHarness()
    const a = x.char(FOOT, { name: 'Suspect' })
    const gm = x.char([0, 0, 0], { name: 'Gm' })
    const run = (...args: string[]) => x.law.gm(gm.p, args, x.h.now)
    expect(run('wanted', 'Suspect')).toMatchObject({ ok: true })
    expect(x.h.world.state(a.p).wanted).toBe(20_000)
    expect(run('status').message).toMatch(/Suspect breaker offence 1, 20,000 gold/)
    // a GM warrant records no offence
    expect(run('record', 'Suspect').data).toMatchObject({ offences: 0 })
    expect(run('lapse', 'Suspect', '1')).toMatchObject({ ok: true })
    expect(x.law.wantedOf(a.p.characterId)?.lapseMs).toBe(MIN)
    x.tick(MIN + 100)
    expect(x.law.isWanted(a.p.characterId)).toBe(false)
    run('wanted', 'Suspect')
    expect(run('wanted', 'Suspect', 'off')).toMatchObject({ ok: true })
    expect(x.law.isWanted(a.p.characterId)).toBe(false)
    expect(x.h.all(gm.inbox, 'lawNotice').at(-1)).toMatchObject({ event: 'pardoned', name: 'Suspect' })
    run('wanted', 'Suspect')
    expect(run('capture', 'Suspect').data).toMatchObject({ bounty: 20_000, sentenceMs: 2 * HOUR })
    // layer 6: the capture jails; out again and back at the wall
    expect(x.g.jail.jailedNow(a.p)).toBe(true)
    expect(run('release', 'Suspect')).toMatchObject({ ok: true })
    x.h.world.warp(a.p, FOOT[0], FOOT[1], FOOT[2], x.h.now)
    x.h.store.db.prepare('INSERT INTO law_records (account_id, offences, last_offence_at) VALUES (?, 3, ?) ON CONFLICT (account_id) DO UPDATE SET offences = 3').run(x.accountOf(a.p), x.h.now)
    expect(run('forgive', 'Suspect').message).toMatch(/3 -> 2/)
    expect(run('forgive', 'Suspect', 'all').message).toMatch(/2 -> 0/)
    expect(x.plant(a.p, a.inbox)).toMatchObject({ ok: true })
    x.tick(5100)
    expect(run('record', 'Suspect').message).toMatch(/keg cooldown 30 min/)
    expect(run('cooldown', 'Suspect')).toMatchObject({ ok: true })
    expect(run('record', 'Suspect').message).toMatch(/keg cooldown free/)
    expect(run('kegs').message).toMatch(/N1 by Suspect/)
    expect(run('nope', 'Suspect')).toMatchObject({ ok: false })
    expect(run('record', 'Nobody')).toMatchObject({ ok: false })
  })
})
