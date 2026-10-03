/**
 * The jump (docs/MOVEMENT.md §4.2–§4.3, §8.2 server list; docs/WAVE_PLAN6.md §3, D31; lane MV-P).
 *
 * - A jump never changes the position or the move (no nav call, no `move`/`stop`), next to a wall or at the bounds line.
 * - `jump {id, at}` reaches the jumper and its viewers, never a stranger out of view.
 * - The `move.jump` cooldown with its 150 ms slack; the rate limit (2/s, burst 3) answers `rate_limited`, never a strike.
 * - The lock rules in the dispatcher's order: `dead`; `mounted`; the alchemy gate keeps the fuse (D31: the jump is not a
 *   fuse canceller, like an emote); trading is allowed and keeps the trade; `stalling`; then `cant_act`, `busy`,
 *   `cooldown`. A stall visitor may jump; a sitter stands up first.
 *
 * Most of it runs in the synthetic NPC world with a controlled clock (npc-harness.ts); the skill cast uses the skills
 * harness (a real cast), and the last block goes over real WebSockets (the strict validator on every frame, the real
 * CLIENT_RATE_LIMITS budget).
 */
import { CLIENT_RATE_LIMITS, JUMP_COOLDOWN_KEY, JUMP_COOLDOWN_MS, JUMP_COOLDOWN_SLACK_MS, type CosDef, type ItemDef, type ServerMessage } from '@sro/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { GameData } from '../src/gamedata.ts'
import type { MoveValidator, Player } from '../src/world.ts'
import { DROPS, ITEMS, LEVELS, MANGNYANG, contentFiles, item, seeded } from './fixtures.ts'
import { Client, newAccount, sleep, startTestServer, type TestServer } from './helpers.ts'
import { NPC_DEFS, NPC_ITEMS, RETURN_01, SHOP_DEFS, npcHarness, type Msg, type NpcHarness } from './npc-harness.ts'
import { skillHarness } from './skills-fixtures.ts'

// ---- content (the abuse-w8-gate.test.ts items: a horse, a sword to fuse, an elixir and a powder) -------------------

const RED: CosDef = {
  code: 'COS_C_HORSE1', id: 2191, name: 'Red Horse', level: 20, hp: 983, walkSpeed: 4.5, runSpeed: 9, radius: 1.2,
  physAbsorb: 20, magAbsorb: 20, parryRate: 65, hitRate: 65, model: null, icon: null,
}
const HORSE = item('ITEM_COS_C_HORSE1', { category: 'scroll', maxStack: 50, reqLevel: 10, price: 1200, sellPrice: 360, use: { summon: 'COS_C_HORSE1' } })
const SWORD = item('ITEM_CH_SWORD_01_A', {
  category: 'weapon', slot: 'weapon', weaponType: 'sword', degree: 1, reqLevel: 1, race: 'china', typeId: [3, 1, 6, 2], range: 1.5,
  stats: { physAttack: [20, 30], magAttack: [10, 14], durability: [62, 76] }, perPlus: { physAttack: 2.4, magAttack: 4.1 },
})
const ELIXIR = item('ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A', {
  category: 'alchemy', typeId: [3, 3, 10, 1], degree: 1, maxStack: 1, price: 50000,
  reinforce: { kind: 'elixir', targets: [6], rates: [25, 20, 15, 10, 10, 10, 10, 10, 10, 5, 5, 5] },
})
const POWDER = item('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_01', {
  category: 'alchemy', typeId: [3, 3, 10, 2], degree: 1, maxStack: 50,
  reinforce: { kind: 'powder', degree: 1, rates: [50, 30, 20, 8, 8, 8, 8, 8, 8, 8, 8, 8] },
})
const EXTRA: ItemDef[] = [HORSE, SWORD, ELIXIR, POWDER]

/** Far from town (0,0,0) and from every NPC. */
const FIELD: [number, number, number] = [200, 0, 200]
/** Out of everyone's view (view range 120 m). */
const FAR: [number, number, number] = [-300, 0, -300]

const harnesses: NpcHarness[] = []
afterEach(() => {
  vi.restoreAllMocks()
  while (harnesses.length) harnesses.pop()!.close()
})

interface P {
  p: Player
  inbox: ServerMessage[]
}

function setup(validator?: MoveValidator) {
  const data = new GameData({ mobs: [MANGNYANG], items: [...NPC_ITEMS, ...EXTRA], levels: LEVELS, drops: [], npcs: NPC_DEFS, shops: SHOP_DEFS, towns: [] })
  // Stalls in the synthetic field (no town safe area here).
  const h = npcHarness({ data, config: { stallTownOnly: 0, rng: seeded(31) }, ...(validator ? { validator } : {}) })
  harnesses.push(h)
  h.gameplay.mounts.defs.set(RED.code, RED)
  const g = h.gameplay
  const all: P[] = []
  /** A level-10 character at FIELD + (dx, dz); every player near FIELD knows every other. */
  const enter = (dx = 0, dz = 0, at: [number, number, number] = FIELD): P => {
    const e = h.enter([at[0] + dx, at[1], at[2] + dz])
    e.p.progress = { ...e.p.progress, level: 10 }
    if (at === FIELD) {
      for (const q of all) {
        q.p.known.add(e.p.id)
        e.p.known.add(q.p.id)
      }
      all.push(e)
    }
    return e
  }
  const jump = (x: P) => h.req(x.p, x.inbox, { t: 'jump' })
  const jumps = (x: P, from = 0) => h.of(x.inbox.slice(from), 'jump')
  const slot = (p: Player, code: string) => h.bag(p).findIndex((it) => it?.code === code)
  return { h, g, enter, jump, jumps, slot }
}
type S = ReturnType<typeof setup>

function openTrade(s: S, a: P, b: P) {
  expect(s.h.req(a.p, a.inbox, { t: 'tradeRequest', target: b.p.id })).toMatchObject({ ok: true })
  expect(s.h.req(b.p, b.inbox, { t: 'tradeRespond', from: a.p.id, accept: true })).toMatchObject({ ok: true })
  expect(s.g.trade.isTrading(a.p)).toBe(true)
}

function startFuse(s: S, x: P) {
  const sword = s.h.give(x.p, SWORD.code, 1, { durability: 70 })
  const el = s.h.give(x.p, ELIXIR.code, 1)
  const pw = s.h.give(x.p, POWDER.code, 5)
  expect(s.h.req(x.p, x.inbox, { t: 'alchemyReinforce', item: sword, elixir: el, powder: pw })).toMatchObject({ ok: true })
  expect(s.g.alchemy.fusing(x.p)).not.toBeNull()
}

function mount(s: S, x: P) {
  let horse = s.slot(x.p, HORSE.code)
  if (horse < 0) horse = s.h.give(x.p, HORSE.code, 5)
  expect(s.h.req(x.p, x.inbox, { t: 'itemUse', bag: horse })).toMatchObject({ ok: true })
  expect(s.g.mounts.ridden(x.p)).not.toBeNull()
}

function stun(s: S, p: Player, status: 'stun' | 'freeze' | 'knockdown' = 'stun', instance = 999) {
  const now = s.h.now()
  s.g.skills.effects.add({ instance, carrier: p.id, source: p.id, kind: 'status', status, overlap: 0, mods: [], startedAt: now, until: now + 3000 })
  expect(s.g.skills.held(p, now)).toBe(true)
}

/** Every method of `obj` (own prototype chain) wrapped in a spy; returns the total call count so far. */
function spyAll(obj: object): () => number {
  const spies: { mock: { calls: unknown[] } }[] = []
  for (let proto = Object.getPrototypeOf(obj); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue
      const d = Object.getOwnPropertyDescriptor(proto, name)
      if (typeof d?.value === 'function') spies.push(vi.spyOn(obj as Record<string, () => unknown>, name))
    }
  }
  return () => spies.reduce((n, sp) => n + sp.mock.calls.length, 0)
}

// ---- the rule: a jump is cosmetic ------------------------------------------------------------------------------------

describe('the jump is cosmetic (MOVEMENT §4.2)', () => {
  it('routes to the movement module and plays for the jumper and its viewers only, with the server time', () => {
    const s = setup()
    const a = s.enter()
    const b = s.enter(3)
    const far = s.enter(0, 0, FAR)
    expect(s.g.routes.get('jump')).toBe(s.g.movement)
    expect(s.jump(a)).toEqual({ t: 'actionResult', re: 'jump', ok: true })
    const want = { t: 'jump', id: a.p.id, at: s.h.now() }
    expect(s.jumps(a)).toEqual([want])
    expect(s.jumps(b)).toEqual([want])
    expect(s.jumps(far)).toEqual([])
    expect(s.h.world.state(a.p)).not.toHaveProperty('jump') // no state in EntityState
  })

  it('never changes pos or move: a moving player keeps the very same move, and nothing moves or stops', () => {
    const s = setup()
    const a = s.enter()
    const b = s.enter(3)
    // Standing.
    const pos0 = [...a.p.pos]
    expect(s.jump(a)).toMatchObject({ ok: true })
    expect([...a.p.pos]).toEqual(pos0)
    expect(a.p.move).toBeNull()
    // Moving (the client plays JUMP_RUN over the move).
    s.h.advance(JUMP_COOLDOWN_MS)
    s.h.world.moveEntity(a.p, 230, 200, s.h.world.moveSpeed, s.h.now())
    s.h.advance(200)
    const move = a.p.move
    expect(move).not.toBeNull()
    const before = JSON.stringify(move)
    const pos1 = [...a.p.pos]
    const from = { a: a.inbox.length, b: b.inbox.length }
    expect(s.jump(a)).toMatchObject({ ok: true })
    expect(a.p.move).toBe(move)
    expect(JSON.stringify(a.p.move)).toBe(before)
    expect([...a.p.pos]).toEqual(pos1)
    for (const [x, n] of [[a, from.a], [b, from.b]] as const) {
      expect(x.inbox.slice(n).filter((m) => m.t === 'move' || m.t === 'stop')).toEqual([])
    }
    expect(s.jumps(b, from.b)).toHaveLength(1)
    // The move carries on to its end as if nothing had happened.
    s.h.advance(10_000)
    expect(a.p.move).toBeNull()
    expect(a.p.pos[0]).toBeCloseTo(230, 3)
  })

  it('next to a wall and at the bounds line: no nav or move-validator call, the position unchanged', () => {
    let validations = 0
    // Every step is a wall: any move at all would be refused.
    const wall: MoveValidator = () => {
      validations++
      return null
    }
    const s = setup(wall)
    const edge = s.enter(0, 0, [499.99, 0, 0]) // on the bounds line (maxX 500)
    const nearWall = s.enter()
    const navCalls = spyAll(s.g.nav)
    const worldNavCalls = spyAll(s.h.world.nav)
    for (const x of [edge, nearWall]) {
      const pos = [...x.p.pos]
      expect(s.jump(x)).toMatchObject({ ok: true })
      expect([...x.p.pos]).toEqual(pos)
      expect(x.p.move).toBeNull()
    }
    expect(validations).toBe(0)
    expect(navCalls()).toBe(0)
    expect(worldNavCalls()).toBe(0)
  })

  it('does not end auto-attack or combat: the action and its target stay', () => {
    const s = setup()
    const a = s.enter()
    const m = s.g.createMob(MANGNYANG, 'normal', FIELD[0] + 2, FIELD[2], 0, null, s.h.now())
    a.p.known.add(m.id)
    expect(s.h.req(a.p, a.inbox, { t: 'attack', target: m.id })).toMatchObject({ ok: true })
    a.p.lastCombatAt = s.h.now()
    const action = a.p.action
    expect(action).toMatchObject({ kind: 'attack', target: m.id })
    expect(s.jump(a)).toMatchObject({ ok: true })
    expect(a.p.action).toBe(action)
  })
})

// ---- cooldown and rate limit ---------------------------------------------------------------------------------------

describe('cooldown (MOVEMENT §4.2)', () => {
  it('a second jump within 850 ms is `cooldown`; one at 850 ms (1 s minus the 150 ms slack) is accepted', () => {
    expect(JUMP_COOLDOWN_MS - JUMP_COOLDOWN_SLACK_MS).toBe(850)
    const s = setup()
    const a = s.enter()
    const b = s.enter(3)
    const t0 = s.h.now()
    expect(s.jump(a)).toMatchObject({ ok: true })
    expect(a.p.cooldowns.get(JUMP_COOLDOWN_KEY)).toBe(t0 + JUMP_COOLDOWN_MS)
    s.h.advance(849)
    expect(s.jump(a)).toMatchObject({ ok: false, reason: 'cooldown' })
    // A refused jump does not re-arm the cooldown.
    expect(a.p.cooldowns.get(JUMP_COOLDOWN_KEY)).toBe(t0 + JUMP_COOLDOWN_MS)
    s.h.advance(1)
    expect(s.jump(a)).toMatchObject({ ok: true })
    // Spent on acceptance: the next one counts from this jump, not from the old ready time.
    expect(a.p.cooldowns.get(JUMP_COOLDOWN_KEY)).toBe(t0 + 850 + JUMP_COOLDOWN_MS)
    s.h.advance(849)
    expect(s.jump(a)).toMatchObject({ ok: false, reason: 'cooldown' })
    s.h.advance(1)
    expect(s.jump(a)).toMatchObject({ ok: true })
    expect(s.jumps(b).map((m) => m.at - t0)).toEqual([0, 850, 1700])
  })

  it('the jump cooldown is its own key: an item cooldown group does not block it, nor it one', () => {
    const s = setup()
    const a = s.enter()
    a.p.cooldowns.set('hp', s.h.now() + 60_000)
    expect(s.jump(a)).toMatchObject({ ok: true })
    expect(a.p.cooldowns.get('hp')).toBe(s.h.now() + 60_000)
  })
})

// ---- the lock rules (MOVEMENT §4.3; WAVE_PLAN6 D31) ---------------------------------------------------------------

describe('lock rules (MOVEMENT §4.3)', () => {
  it('mounted gives `mounted`; a stall owner gives `stalling`; neither is broadcast', () => {
    const s = setup()
    const a = s.enter()
    const c = s.enter(-4)
    const b = s.enter(3)
    mount(s, a)
    expect(s.jump(a)).toMatchObject({ ok: false, reason: 'mounted' })
    expect(s.h.req(c.p, c.inbox, { t: 'stallCreate', title: 'Jump test' })).toMatchObject({ ok: true })
    expect(s.jump(c)).toMatchObject({ ok: false, reason: 'stalling' })
    expect(s.jumps(b)).toEqual([])
    expect(a.p.cooldowns.has(JUMP_COOLDOWN_KEY)).toBe(false)
  })

  it('a trading player jumps: accepted, broadcast, and the trade stays open for both', () => {
    const s = setup()
    const a = s.enter()
    const b = s.enter(2)
    openTrade(s, a, b)
    expect(s.jump(a)).toMatchObject({ ok: true })
    expect(s.jumps(b)).toEqual([{ t: 'jump', id: a.p.id, at: s.h.now() }])
    expect(s.g.trade.isTrading(a.p)).toBe(true)
    expect(s.g.trade.isTrading(b.p)).toBe(true)
    expect(s.jump(b)).toMatchObject({ ok: true })
    expect(s.g.trade.isTrading(a.p)).toBe(true)
  })

  it('the order: a stunned mounted player gets `mounted`; a stunned player with a fuse keeps it (D31) and gets `cant_act`', () => {
    const s = setup()
    const a = s.enter()
    mount(s, a)
    stun(s, a.p)
    expect(s.jump(a)).toMatchObject({ ok: false, reason: 'mounted' })
    const c = s.enter(4)
    startFuse(s, c)
    const fuse = s.g.alchemy.fusing(c.p)
    stun(s, c.p, 'stun', 1001)
    expect(s.jump(c)).toMatchObject({ ok: false, reason: 'cant_act' })
    expect(s.g.alchemy.fusing(c.p)).toEqual(fuse)
  })

  it('D31: a jump never cancels an alchemy fuse, accepted or refused, and the fuse still completes', () => {
    const s = setup()
    const a = s.enter()
    startFuse(s, a)
    const fuse = s.g.alchemy.fusing(a.p)
    expect(s.jump(a)).toMatchObject({ ok: true })
    expect(s.g.alchemy.fusing(a.p)).toEqual(fuse)
    expect(s.jump(a)).toMatchObject({ ok: false, reason: 'cooldown' })
    expect(s.g.alchemy.fusing(a.p)).toEqual(fuse)
    s.h.advance(10_000)
    expect(s.g.alchemy.fusing(a.p)).toBeNull()
    expect(s.h.of(a.inbox, 'alchemyResult').filter((m) => m.outcome === 'cancelled')).toEqual([])
    expect(s.h.of(a.inbox, 'alchemyResult')).toHaveLength(1)
  })

  it('a stall visitor may jump, and the visit is unchanged', () => {
    const s = setup()
    const owner = s.enter()
    const v = s.enter(2)
    expect(s.h.req(owner.p, owner.inbox, { t: 'stallCreate', title: 'Jump test' })).toMatchObject({ ok: true })
    expect(s.h.req(v.p, v.inbox, { t: 'stallVisit', owner: owner.p.id })).toMatchObject({ ok: true })
    expect(s.g.stalls.visitOf(v.p)).toBe(owner.p.id)
    const visitors = [...s.g.stalls.stallOf(owner.p)!.visitors]
    expect(s.jump(v)).toMatchObject({ ok: true })
    expect(s.jumps(owner)).toHaveLength(1)
    s.h.advance(1000) // the stall's distance check runs on the tick
    expect(s.g.stalls.visitOf(v.p)).toBe(owner.p.id)
    expect([...s.g.stalls.stallOf(owner.p)!.visitors]).toEqual(visitors)
  })

  it('dead gives `dead`; stunned, frozen or knocked down gives `cant_act`', () => {
    const s = setup()
    const a = s.enter()
    a.p.dead = true
    expect(s.jump(a)).toMatchObject({ ok: false, reason: 'dead' })
    a.p.dead = false
    let instance = 2000
    for (const status of ['stun', 'freeze', 'knockdown'] as const) {
      stun(s, a.p, status, ++instance)
      expect(s.jump(a), status).toMatchObject({ ok: false, reason: 'cant_act' })
      s.g.skills.effects.remove(a.p.id, instance)
    }
    expect(s.jump(a)).toMatchObject({ ok: true })
    expect(s.jumps(a)).toHaveLength(1)
  })

  it('a return-scroll cast gives `busy`, and the cast goes on', () => {
    const s = setup()
    const a = s.enter()
    const scroll = s.h.give(a.p, RETURN_01.code, 1)
    expect(s.h.req(a.p, a.inbox, { t: 'itemUse', bag: scroll })).toMatchObject({ ok: true })
    const cast = s.g.itemUses.casting(a.p)
    expect(cast).not.toBeNull()
    expect(s.jump(a)).toMatchObject({ ok: false, reason: 'busy' })
    expect(s.g.itemUses.casting(a.p)).toEqual(cast)
    s.h.advance(100)
    expect(s.g.itemUses.casting(a.p)).toEqual(cast)
  })

  it('a sitter stands up, then jumps (the viewers see stand before the jump)', () => {
    const s = setup()
    const a = s.enter()
    const b = s.enter(3)
    expect(s.h.req(a.p, a.inbox, { t: 'sit', on: true })).toMatchObject({ ok: true })
    expect(s.g.posture.isSitting(a.p)).toBe(true)
    const from = b.inbox.length
    expect(s.jump(a)).toMatchObject({ ok: true })
    expect(s.g.posture.isSitting(a.p)).toBe(false)
    const seen = b.inbox.slice(from).filter((m) => m.t === 'jump' || (m.t === 'entityUpdate' && m.posture))
    expect(seen).toEqual([{ t: 'entityUpdate', id: a.p.id, posture: 'stand' }, { t: 'jump', id: a.p.id, at: s.h.now() }])
  })

  it('a refused jump does not stand a sitter up', () => {
    const s = setup()
    const a = s.enter()
    expect(s.jump(a)).toMatchObject({ ok: true })
    expect(s.h.req(a.p, a.inbox, { t: 'sit', on: true })).toMatchObject({ ok: true })
    expect(s.jump(a)).toMatchObject({ ok: false, reason: 'cooldown' })
    expect(s.g.posture.isSitting(a.p)).toBe(true)
  })
})

describe('a skill cast (the skills harness, a real cast)', () => {
  let k: ReturnType<typeof skillHarness> | undefined
  afterEach(() => k?.cleanup())

  it('gives `busy`, and the cast is not interrupted', () => {
    k = skillHarness()
    const { p, inbox } = k.hero({ level: 10 })
    const m = k.dummy(0, 2)
    k.learn(p, ['SKILL_CH_SWORD_SMASH_A_01'])
    k.req(p, { t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_01', target: m.id })
    expect(k.result(inbox, 'useSkill')).toMatchObject({ ok: true })
    k.runTo(k.now + 100) // inside the 400 ms cast
    expect(k.gameplay.skills.busy(p)).toBe(true)
    k.req(p, { t: 'jump' })
    expect(k.result(inbox, 'jump')).toMatchObject({ ok: false, reason: 'busy' })
    expect(k.gameplay.skills.busy(p)).toBe(true)
    expect(k.all(inbox, 'castEnd').filter((c) => c.reason === 'interrupted')).toEqual([])
    expect(k.all(inbox, 'jump')).toEqual([])
    // The cast runs to its end, then the jump is accepted.
    k.runTo(k.now + 3000)
    expect(k.gameplay.skills.busy(p)).toBe(false)
    expect(k.all(inbox, 'castEnd').filter((c) => c.reason === 'interrupted')).toEqual([])
    p.action = null
    k.req(p, { t: 'jump' })
    expect(k.result(inbox, 'jump')).toMatchObject({ ok: true })
  })
})

describe('cost (WAVE_PLAN6 §6: ≤ 0.05 ms server CPU per jump)', () => {
  it('an accepted jump with a viewer stays within the 0.05 ms budget (measured ~0.001 ms)', () => {
    const s = setup()
    const a = s.enter()
    s.enter(3)
    const N = 2000
    const run = () => {
      const t0 = performance.now()
      for (let i = 0; i < N; i++) {
        a.p.cooldowns.delete(JUMP_COOLDOWN_KEY)
        s.g.request(a.p, { t: 'jump' }, s.h.now())
      }
      return (performance.now() - t0) / N
    }
    run() // warm up
    const perJump = Math.min(run(), run(), run())
    expect(perJump).toBeLessThan(0.05)
  })
})

// ---- over real WebSockets: the strict validator on every frame, and the per-type budget --------------------------

describe('over the wire', () => {
  const SPAWN: [number, number, number] = [50, 0, -50]
  let t: TestServer

  beforeAll(async () => {
    t = await startTestServer({
      config: { moveSpeed: 30, tickHz: 20, viewRange: 60, spawnMobs: false },
      files: {
        'out/world/jangan/manifest.json': JSON.stringify({ name: 'jangan', spawn: SPAWN, bounds: { min: [0, 0, -400], max: [400, 0, 0] } }),
        ...contentFiles({ mobs: [MANGNYANG], nests: [], items: ITEMS, levels: LEVELS, drops: DROPS, npcs: [], shops: [] }),
      },
    })
  })
  afterAll(async () => {
    await t.stopAndClean()
  })

  let n = 0
  async function player() {
    const acc = await newAccount(t.url, 'jz')
    const c = await Client.login(t.url, acc.token)
    c.send({ t: 'charCreate', name: `Jumper${++n}`, model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'blade' })
    const ch = (await c.next('charCreated')).character
    c.send({ t: 'enterWorld', id: ch.id })
    const enter = await c.next('worldEnter')
    return { c, id: enter.self.id }
  }

  it('a friend sees the jump; spam past the budget (2/s, burst 3) is `rate_limited`, never a strike', async () => {
    expect(CLIENT_RATE_LIMITS.jump).toEqual({ perSecond: 2, burst: 3 })
    const a = await player()
    const b = await player()
    await a.c.next('spawn', (m) => m.entity.id === b.id)
    a.c.send({ t: 'jump' })
    const ok = await a.c.next('actionResult', (m) => m.re === 'jump')
    expect(ok).toMatchObject({ ok: true })
    const own = await a.c.next('jump', (m) => m.id === a.id)
    const seen = await b.c.next('jump', (m) => m.id === a.id)
    expect(seen).toEqual(own)
    expect(Number.isInteger(seen.at)).toBe(true)
    expect(Math.abs(seen.at - Date.now())).toBeLessThan(5000)
    // Five more back to back: the bucket's two tokens left (plus any refill) reach the module and are refused `cooldown`;
    // the rest are `rate_limited`, and nothing is a strike.
    for (let i = 0; i < 5; i++) a.c.send({ t: 'jump' })
    await sleep(200)
    const answers = a.c.queue.filter((m): m is Msg<'actionResult'> => m.t === 'actionResult' && m.re === 'jump')
    expect(answers).toHaveLength(5)
    expect(answers.filter((x) => x.ok)).toHaveLength(0)
    const cooldowns = answers.filter((x) => x.reason === 'cooldown').length
    expect(cooldowns).toBeGreaterThanOrEqual(2)
    expect(answers.filter((x) => x.reason === 'rate_limited')).toHaveLength(5 - cooldowns)
    expect(5 - cooldowns).toBeGreaterThanOrEqual(2)
    expect(a.c.isClosed).toBe(false)
    // After the cooldown and a refill the next jump goes through again.
    await sleep(1100)
    a.c.send({ t: 'jump' })
    expect(await a.c.next('actionResult', (m) => m.re === 'jump' && m.ok)).toBeTruthy()
    await b.c.next('jump', (m) => m.id === a.id && m.at > seen.at)
    a.c.close()
    b.c.close()
    await Promise.all([a.c.closed, b.c.closed])
  })
})
