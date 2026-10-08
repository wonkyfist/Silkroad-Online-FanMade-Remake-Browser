/**
 * The Climb's death penalty (docs/CLIMB.md §6, layer L4; D46, D51; fact-check F5, F6): the math (1–20 % of the bar,
 * never a de-level, nothing on an empty bar), the levels it applies to (15 to below the cap), the exceptions (PvP,
 * hazards, GM kills, the siege army, Play the Boss and her summons), the grace (10 min, 30 from 21, never restarted by a
 * free death), the resurrection refund capped at the loss, the admin knobs, the GM command and the combat linger
 * (module level here; the socket path end to end at the bottom).
 */
import { CLIMB_PENALTY, climbGraceMs, climbPenaltyLoss, climbPenaltyPct, climbRefundCap, type LevelDef, type ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerConfig } from '../src/config.ts'
import { penaltyEligible } from '../src/climb/penalty.ts'
import { GameData } from '../src/gamedata.ts'
import type { Mob, Player } from '../src/world.ts'
import { ITEMS, MANGNYANG, contentFiles } from './fixtures.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'
import { npcHarness, type NpcHarness } from './npc-harness.ts'

/** 1000 × level EXP per bar, levels 1–25. */
const LEVELS25: LevelDef[] = Array.from({ length: 25 }, (_, i) => ({ level: i + 1, exp: 1000 * (i + 1), masterySp: 1 }))
const BAR = (level: number) => 1000 * level

describe('penalty math (shared)', () => {
  it('rolls a whole percent in the range and never takes more than the bar holds', () => {
    expect(climbPenaltyPct(0, 1, 20)).toBe(1)
    expect(climbPenaltyPct(0.9999, 1, 20)).toBe(20)
    expect(climbPenaltyPct(0.5, 20, 1)).toBe(11)
    for (let r = 0; r < 1; r += 0.01) {
      const p = climbPenaltyPct(r, 1, 20)
      expect(Number.isInteger(p) && p >= 1 && p <= 20).toBe(true)
    }
    expect(climbPenaltyLoss(10_000, 16_000, 13)).toBe(2080)
    expect(climbPenaltyLoss(500, 16_000, 20)).toBe(500)
    expect(climbPenaltyLoss(0, 16_000, 20)).toBe(0)
    expect(climbPenaltyLoss(500, 0, 20)).toBe(0)
  })
  it('grace is 10 min below 21 and 30 min from 21; refunds never pass the loss', () => {
    expect(climbGraceMs(20, CLIMB_PENALTY)).toBe(10 * 60_000)
    expect(climbGraceMs(21, CLIMB_PENALTY)).toBe(30 * 60_000)
    expect(climbRefundCap(1000, 0, 500)).toBe(500)
    expect(climbRefundCap(1000, 500, 1000)).toBe(500)
    expect(climbRefundCap(1000, 1000, 1)).toBe(0)
  })
})

const harnesses: NpcHarness[] = []
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close()
})

function setup(config: Partial<ServerConfig> = {}) {
  const data = new GameData({ mobs: [MANGNYANG], items: ITEMS, levels: LEVELS25, drops: [], npcs: [], shops: [], towns: [] })
  const h = npcHarness({ data, config: { climb: true, levelCap: 25, ...config } })
  harnesses.push(h)
  return h
}

const FIELD: [number, number, number] = [200, 0, 200]

function hero(h: NpcHarness, level: number, exp: number) {
  const { p, inbox } = h.enter(FIELD)
  p.progress = { ...p.progress, level, exp }
  p.level = level
  h.store.saveProgress(p.characterId, p.progress)
  return { p, inbox }
}

function monster(h: NpcHarness, init?: (m: Mob) => void): Mob {
  return h.gameplay.createMob(MANGNYANG, 'normal', FIELD[0] + 2, FIELD[2], 0, null, h.now(), null, undefined, init)
}

/** `a` kills `p` with one hit (revives first if needed). */
function killBy(h: NpcHarness, p: Player, a: Player | Mob) {
  if (p.dead) h.gameplay.gmHeal(p)
  h.gameplay.dealHits(a, p, [{ outcome: 'hit', damage: 1e9, hp: 0 }], {}, h.now())
  expect(p.dead).toBe(true)
}

const penalties = (inbox: ServerMessage[]) => inbox.filter((m): m is Extract<ServerMessage, { t: 'deathPenalty' }> => m.t === 'deathPenalty')
const savedExp = (h: NpcHarness, p: Player) => h.store.characterById(p.characterId)!.exp

describe('the death penalty (module)', () => {
  it('a monster death at 16 takes 1–20 % of the bar, saved, with the message; never a level', () => {
    const h = setup()
    const { p, inbox } = hero(h, 16, 12_000)
    killBy(h, p, monster(h))
    const [msg] = penalties(inbox)
    expect(msg.outcome).toBe('lost')
    expect(msg.pct).toBeGreaterThanOrEqual(1)
    expect(msg.pct).toBeLessThanOrEqual(20)
    expect(msg.exp).toBe(Math.floor((msg.pct / 100) * BAR(16)))
    expect(p.progress.exp).toBe(12_000 - msg.exp)
    expect(p.progress.level).toBe(16)
    expect(savedExp(h, p)).toBe(p.progress.exp)
    expect(msg.graceMs).toBe(10 * 60_000)
    expect(inbox.some((m) => m.t === 'chat' && /You lost \d+ % of your experience/.test(m.text))).toBe(true)
  })

  it('an almost empty bar loses only what it holds; an empty bar loses nothing and starts no grace', () => {
    const h = setup({ penaltyMinPct: 20, penaltyMaxPct: 20 })
    const a = hero(h, 18, 100)
    killBy(h, a.p, monster(h))
    expect(a.p.progress).toMatchObject({ level: 18, exp: 0 })
    const b = hero(h, 18, 0)
    killBy(h, b.p, monster(h))
    expect(penalties(b.inbox)[0]).toMatchObject({ outcome: 'empty', exp: 0, graceMs: 0 })
    expect(h.gameplay.penalty.graceLeft(b.p.characterId, h.now())).toBe(0)
  })

  it('applies from level 15 below the cap only', () => {
    const h = setup()
    const low = hero(h, 14, 5000)
    killBy(h, low.p, monster(h))
    expect(low.p.progress.exp).toBe(5000)
    expect(penalties(low.inbox)).toHaveLength(0)
    const capped = hero(h, 25, 0)
    killBy(h, capped.p, monster(h))
    expect(penalties(capped.inbox)).toHaveLength(0)
    const at15 = hero(h, 15, 5000)
    killBy(h, at15.p, monster(h))
    expect(at15.p.progress.exp).toBeLessThan(5000)
  })

  it('never for PvP, hazards, GM kills, the siege army or Play the Boss (and her summons)', () => {
    const h = setup()
    const { p, inbox } = hero(h, 17, 9000)
    const other = h.enter(FIELD).p
    killBy(h, p, other)
    h.gameplay.gmHeal(p)
    h.gameplay.hazardHit(p, 1e9, 'lightning', h.now())
    h.gameplay.gmHeal(p)
    h.gameplay.gmKill(p, h.now())
    killBy(h, p, monster(h, (m) => (m.siege = { mode: 'engage' } as Mob['siege'])))
    killBy(h, p, monster(h, (m) => (m.pilot = { player: null, steering: 'ai' })))
    expect(p.progress.exp).toBe(9000)
    expect(penalties(inbox)).toHaveLength(0)
    const boss = { kind: 'mob', id: 1, pilot: { player: null, steering: 'ai' } } as unknown as Mob
    const summon = { kind: 'mob', id: 2 } as unknown as Mob
    expect(penaltyEligible(summon, (id) => (id === 2 ? boss : undefined))).toBe(false)
    expect(penaltyEligible(summon, () => undefined)).toBe(true)
    expect(penaltyEligible(undefined, () => undefined)).toBe(false)
  })

  it('grace: one loss per 10 min (30 from 21); a free death never restarts the window', () => {
    const h = setup()
    const { p, inbox } = hero(h, 19, 15_000)
    killBy(h, p, monster(h))
    const after = p.progress.exp
    h.advance(9 * 60_000, 1000)
    killBy(h, p, monster(h))
    expect(p.progress.exp).toBe(after)
    expect(penalties(inbox)[1]).toMatchObject({ outcome: 'grace', exp: 0 })
    expect(penalties(inbox)[1].graceMs).toBeLessThanOrEqual(60_000)
    h.advance(61_000, 1000)
    killBy(h, p, monster(h))
    expect(p.progress.exp).toBeLessThan(after)
    const hi = hero(h, 22, 20_000)
    killBy(h, hi.p, monster(h))
    expect(penalties(hi.inbox)[0].graceMs).toBe(30 * 60_000)
    h.advance(29 * 60_000, 1000)
    const kept = hi.p.progress.exp
    killBy(h, hi.p, monster(h))
    expect(hi.p.progress.exp).toBe(kept)
  })

  it('a resurrection refunds half the loss, and every refund of one death stops at the loss (F5)', () => {
    const h = setup({ penaltyMinPct: 10, penaltyMaxPct: 10 })
    const { p, inbox } = hero(h, 16, 10_000)
    killBy(h, p, monster(h))
    expect(p.progress.exp).toBe(10_000 - 1600)
    // Soul Rebirth on the corpse (skills/engine.ts calls this after standing the body up)
    p.dead = false
    h.gameplay.penalty.resurrected(p)
    expect(p.progress.exp).toBe(10_000 - 800)
    expect(penalties(inbox).at(-1)).toMatchObject({ outcome: 'refund', exp: 800 })
    // a second resurrection pays nothing; a sibling's refund (NEMESIS) gets only what is left
    h.gameplay.penalty.resurrected(p)
    expect(h.gameplay.penalty.refund(p, 1600)).toBe(800)
    expect(h.gameplay.penalty.refund(p, 1)).toBe(0)
    expect(p.progress.exp).toBe(10_000)
    expect(savedExp(h, p)).toBe(10_000)
  })

  it('returning to town forfeits the resurrection refund', () => {
    const h = setup()
    const { p } = hero(h, 16, 10_000)
    killBy(h, p, monster(h))
    const lost = p.progress.exp
    h.gameplay.request(p, { t: 'respawn' }, h.now())
    h.gameplay.penalty.resurrected(p)
    expect(p.progress.exp).toBe(lost)
  })

  it('admin knobs apply live: off, the range, the level', () => {
    const h = setup({ deathPenalty: false })
    const { p } = hero(h, 16, 10_000)
    killBy(h, p, monster(h))
    expect(p.progress.exp).toBe(10_000)
    h.config.deathPenalty = true
    h.config.penaltyMinPct = 5
    h.config.penaltyMaxPct = 5
    killBy(h, p, monster(h))
    expect(p.progress.exp).toBe(10_000 - 800)
    h.config.penaltyFromLevel = 17
    h.gameplay.penalty.gm(p, ['clear'], () => undefined)
    killBy(h, p, monster(h))
    expect(p.progress.exp).toBe(10_000 - 800)
    h.config.climb = false
    h.config.penaltyFromLevel = 1
    killBy(h, p, monster(h))
    expect(p.progress.exp).toBe(10_000 - 800)
  })

  it('GM: status, a test roll, the grace set and cleared', () => {
    const h = setup()
    const { p } = hero(h, 16, 10_000)
    const pen = h.gameplay.penalty
    expect(pen.gm(p, [], () => undefined)).toMatchObject({ ok: true })
    expect(pen.gm(p, ['test', '10'], () => undefined)).toMatchObject({ ok: true, data: { outcome: 'lost', loss: 1600 } })
    expect(p.progress.exp).toBe(8400)
    expect(pen.graceLeft(p.characterId, h.now())).toBe(10 * 60_000)
    pen.gm(p, ['grace', '0'], () => undefined)
    expect(pen.graceLeft(p.characterId, h.now())).toBe(0)
    pen.gm(p, ['grace', '5', 'Nobody'], () => undefined)
    expect(pen.gm(p, ['grace', '5', 'Nobody'], () => undefined).ok).toBe(false)
    expect(pen.gm(p, ['test', '101'], () => undefined).ok).toBe(false)
  })

  it('combat linger (F6): a body hit by a monster stays 10 s, still a target; dying then is penalised and it leaves at once', () => {
    const h = setup()
    const { p } = hero(h, 16, 10_000)
    const m = monster(h)
    h.gameplay.dealHits(m, p, [{ outcome: 'hit', damage: 1, hp: 0 }], {}, h.now())
    let left = 0
    expect(h.gameplay.penalty.linger(p, h.now(), () => left++)).toBe(true)
    expect(h.gameplay.penalty.lingerLeft(p.characterId, h.now())).toBe(10)
    h.advance(5000)
    expect(left).toBe(0)
    h.gameplay.dealHits(m, p, [{ outcome: 'hit', damage: 1e9, hp: 0 }], {}, h.now())
    expect(p.progress.exp).toBeLessThan(10_000)
    h.advance(100)
    expect(left).toBe(1)
    // not hit lately, under 15, or dead: no linger
    const q = hero(h, 16, 10_000).p
    expect(h.gameplay.penalty.linger(q, h.now(), () => {})).toBe(false)
    h.gameplay.dealHits(m, q, [{ outcome: 'hit', damage: 1, hp: 0 }], {}, h.now())
    h.advance(10_100)
    expect(h.gameplay.penalty.linger(q, h.now(), () => {})).toBe(false)
    const low = hero(h, 10, 0).p
    h.gameplay.dealHits(m, low, [{ outcome: 'hit', damage: 1, hp: 0 }], {}, h.now())
    expect(h.gameplay.penalty.linger(low, h.now(), () => {})).toBe(false)
  })

  it('a lingering body that survives leaves after 10 s', () => {
    const h = setup()
    const { p } = hero(h, 16, 10_000)
    h.gameplay.dealHits(monster(h), p, [{ outcome: 'hit', damage: 1, hp: 0 }], {}, h.now())
    let left = 0
    h.gameplay.penalty.linger(p, h.now(), () => left++)
    h.advance(9900)
    expect(left).toBe(0)
    h.advance(200)
    expect(left).toBe(1)
    expect(p.progress.exp).toBe(10_000)
  })
})

describe('combat linger end to end (connection.ts)', () => {
  let s: TestServer
  afterEach(async () => {
    await s?.stopAndClean()
  })

  it('closing the socket in a fight keeps the body; a relog waits; a death meanwhile costs EXP and saves it', async () => {
    s = await startTestServer({ config: { climb: true, levelCap: 25 }, files: contentFiles({ mobs: [MANGNYANG], items: ITEMS, levels: LEVELS25 }) })
    const acc = await newAccount(s.url, 'linger')
    const c = await Client.login(s.url, acc.token)
    c.send({ t: 'charCreate', name: 'Lingerer', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    await c.next('worldEnter')
    const { world, gameplay, store } = s.ctx
    const p = [...world.players.values()].find((x) => x.characterId === ch.id)!
    p.progress = { ...p.progress, level: 16, exp: 10_000 }
    p.level = 16
    store.saveProgress(p.characterId, p.progress)
    const at = world.positionAt(p, Date.now())
    const m = gameplay.createMob(gameplay.data.mob(MANGNYANG.code)!, 'normal', at[0] + 1, at[2], at[1], null, Date.now())
    gameplay.dealHits(m, p, [{ outcome: 'hit', damage: 1, hp: 0 }], {}, Date.now())
    c.close()
    await sleep(150)
    expect(world.players.get(p.id)).toBe(p)
    const c2 = await Client.login(s.url, acc.token)
    c2.send({ t: 'enterWorld', id: ch.id })
    const err = await c2.next('error')
    expect(err).toMatchObject({ code: 'already_in_world' })
    gameplay.dealHits(m, p, [{ outcome: 'hit', damage: 1e9, hp: 0 }], {}, Date.now())
    await sleep(300)
    expect(world.players.has(p.id)).toBe(false)
    const row = store.characterById(ch.id)!
    expect(row.exp).toBeLessThan(10_000)
    expect(row.dead).toBe(1)
    c2.send({ t: 'enterWorld', id: ch.id })
    await c2.next('worldEnter')
    c2.close()
  })
})
