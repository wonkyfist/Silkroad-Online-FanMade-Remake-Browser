/**
 * The job system, layer 1: the jobs core on the server (docs/JOBS.md §2-§4, §9.3-§9.5, §11).
 *
 * - joining: the Trader licence at Jodaesan, the Thief's at Old Fang, the Hunter's at Captain Yun (level 15, gold, one
 *   job per character); one side per account (no Thief beside a Trader or Hunter alt), the 3-day wait after leaving,
 *   the 7-day side change; leaving at the NPC (level and EXP gone);
 * - job mode = the suit: Traders in town, Thieves at Old Fang's camp or the den, Hunters through their duty (jobMode
 *   aliases hunterDuty); the badge (EntityState.job, entityUpdate.job); off locked after a PvP hit;
 * - the PvP matrix live: Thief against Trader or Hunter in job mode on the roads; never in town or a post's / the
 *   den's ring, never Trader against Hunter, Thief against Thief, out of job mode, or associates (party, account, IP);
 * - job EXP: a wall-breaker's capture gives the Hunter 2,000 job EXP (rank 1 = level 2), GM `job level / exp`;
 * - migration 25: existing Bounty Hunters keep licence and duty, rank r -> level r + 1, their accounts on the law's side;
 * - abuse: leaving with a warrant, in job mode, revoked or jailed; the Wanted cannot join; GM `law hunter licence`
 *   respects one job per character; the admin routes (GET, PUT settings, member) are admin-only and audited.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  JOB_SETTINGS_DEFAULTS,
  LAW_CODES,
  fenceNpc,
  installSiegeHunterContent,
  installSiegeLawContent,
  jobLevelOf,
  yunNpc,
  type AdminJobsView,
  type NpcDef,
  type ServerMessage,
  type Vec3,
} from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db.ts'
import type { GameContext } from '../src/game.ts'
import { GameData } from '../src/gamedata.ts'
import { addGold } from '../src/inventory.ts'
import { routeAdminJobs } from '../src/jobs/jobs-admin.ts'
import type { KegWalls } from '../src/siege/keg.ts'
import type { Player } from '../src/world.ts'
import { SAFE_TOWN, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

const MIN = 60_000
const DAY = 86_400_000

let cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

const WALLS: KegWalls = { on: true, walls: { segments: [], sides: [] }, settings: { maxIp: 20_000 }, stageOf: () => 'intact', change: () => null }

/** The export's Specialty Trader Jodaesan (his presence places the posts and licenses Traders). */
const JODAESAN: NpcDef = { code: 'NPC_CH_SPECIAL', name: 'Specialty Trader Jodaesan', x: 176, z: -48, yaw: 0, world: 'jangan', model: null, provenance: 'client' }
/** Old Fang's camp, the den and the posts moved into the ±500 m test world. */
const FANG = { x: -300, z: -200 }
const SPOTS: Record<string, [number, number]> = { jangan: [0, 3], 'south-beach': [100, 420], 'tomb-camp': [420, -100], 'ferry-landing': [-420, 100], 'sea-cliffs': [-200, 420] }
/** On the road: outside the town's safe box (±80 m), far from every post and the den. */
const ROAD: Vec3 = [300, 0, 300]

function harness() {
  const data = new GameData({ mobs: [], items: [...SKILL_ITEMS], levels: SKILL_LEVELS, npcs: [JODAESAN], towns: [{ ...SAFE_TOWN, safeArea: { x: 0, z: 0, halfX: 80, halfZ: 80 } }] })
  installSiegeLawContent({ items: data.items, drops: data.drops, npcs: data.npcs }, 'jangan')
  installSiegeHunterContent({ items: data.items, shops: data.shops, npcs: data.npcs }, 'jangan')
  const h = skillHarness({ data, config: { uniques: false } })
  cleanups.push(h.cleanup)
  const g = h.gameplay
  g.kegs.configure({ walls: WALLS })
  const tick = (ms: number) => h.runTo(h.now + ms)
  const jump = (ms: number) => {
    h.now = h.now + ms - 50
    h.runTo(h.now + 50)
  }
  const jod = g.placeNpc({ ...JODAESAN, x: 0, z: 3 }, h.now)!
  const yun = g.placeNpc({ ...yunNpc('jangan'), x: 3, z: 3 }, h.now)!
  const fang = g.placeNpc({ ...fenceNpc('jangan'), ...FANG }, h.now)!
  g.jobs.configure({ content: { den: { ...g.jobs.content.den, x: -400, z: 300 }, posts: g.jobs.content.posts.map((p) => ({ ...p, x: SPOTS[p.id]![0], z: SPOTS[p.id]![1] })) } })
  const char = (pos: Vec3, o: { name?: string; level?: number; alt?: Player; gold?: number } = {}) => {
    let characterId: number | undefined
    if (o.alt) {
      const acc = h.store.characterById(o.alt.characterId)!.account_id
      const row = h.store.createCharacter(acc, o.name ?? `Alt${Math.floor(Math.random() * 1e6)}`, 'CHAR_CH_MAN_ADVENTURER', 'sword', 'jangan', 4)
      if (typeof row === 'string') throw new Error(row)
      characterId = row.id
      h.store.saveProgress(row.id, { level: o.level ?? 20, exp: 0, sp: 0, spExp: 0, str: 39, int: 39, statPoints: 0 })
      g.grantStarterKit(row.id, 'sword', row.model)
    }
    const r = h.hero({ pos, level: o.level ?? 20, ...(o.name && !o.alt ? { name: o.name } : {}), ...(characterId ? { characterId } : {}) })
    r.p.maxHp = r.p.hp = 5000
    const { draft } = h.store.inventoryTx(r.p.characterId, (d) => addGold(d, o.gold ?? 50_000))
    g.afterInventory(r.p, draft)
    return r
  }
  const goldOf = (p: Player) => h.store.loadInventory(p.characterId).gold
  const req = (r: { p: Player; inbox: ServerMessage[] }, msg: Parameters<typeof h.req>[1]) => {
    h.req(r.p, msg)
    return h.result(r.inbox, msg.t)
  }
  /** Joins at the right NPC (walking there and back). */
  const join = (r: { p: Player; inbox: ServerMessage[] }, job: 'trader' | 'hunter' | 'thief') => {
    const [x, , z] = h.world.positionAt(r.p, h.now)
    const npc = job === 'trader' ? jod : job === 'hunter' ? yun : fang
    h.world.warp(r.p, npc.pos[0], 0, npc.pos[2] - 1.5, h.now)
    const out = req(r, { t: 'jobJoin', npc: npc.id, job })
    h.world.warp(r.p, x, 0, z, h.now)
    return out
  }
  const leave = (r: { p: Player; inbox: ServerMessage[] }, job: 'trader' | 'hunter' | 'thief') => {
    const npc = job === 'trader' ? jod : job === 'hunter' ? yun : fang
    const [x, , z] = h.world.positionAt(r.p, h.now)
    h.world.warp(r.p, npc.pos[0], 0, npc.pos[2] - 1.5, h.now)
    const out = req(r, { t: 'jobLeave', npc: npc.id })
    h.world.warp(r.p, x, 0, z, h.now)
    return out
  }
  /** Job mode on where the job dresses (town, or Old Fang's camp), then back to `pos`. */
  const suitUp = (r: { p: Player; inbox: ServerMessage[] }, pos: Vec3 = ROAD) => {
    const thief = g.jobs.jobOf(r.p.characterId) === 'thief'
    h.world.warp(r.p, thief ? FANG.x + 2 : 1, 0, thief ? FANG.z : 1, h.now)
    r.p.lastCombatAt = 0
    const out = req(r, { t: 'jobMode', on: true })
    h.world.warp(r.p, pos[0], 0, pos[2], h.now)
    return out
  }
  const attack = (a: { p: Player; inbox: ServerMessage[] }, t: Player) => req(a, { t: 'attack', target: t.id })
  const stop = (a: { p: Player }) => h.req(a.p, { t: 'stopAction' })
  const accountOf = (p: Player) => h.store.characterById(p.characterId)!.account_id
  const jobState = (r: { inbox: ServerMessage[] }) => h.all(r.inbox, 'jobState').at(-1)
  return { h, g, data, tick, jump, char, goldOf, req, join, leave, suitUp, attack, stop, accountOf, jobState, jod, yun, fang }
}

describe('joining (§2.1)', () => {
  it('Trader at Jodaesan, Thief at Old Fang, Hunter at Yun: level 15, 10,000 gold, one job per character', () => {
    const x = harness()
    expect(x.g.jobs.placed).toBe(true)
    // Old Fang licenses Thieves, Jodaesan Traders: the dialog offers it
    expect(x.g.npcs.servicesOf(null, x.jod)).toContain('trader')
    expect(x.g.npcs.servicesOf(null, x.fang)).toEqual(expect.arrayContaining(['fence', 'thief']))
    const low = x.char([0, 0, 1], { level: 14 })
    expect(x.join(low, 'trader')).toMatchObject({ ok: false, reason: 'requirements' })
    const poor = x.char([0, 0, 1], { gold: 0 })
    expect(x.join(poor, 'thief')).toMatchObject({ ok: false, reason: 'not_enough_gold' })
    const t = x.char([0, 0, 1], { name: 'Tess' })
    const g0 = x.goldOf(t.p)
    expect(x.join(t, 'trader')).toMatchObject({ ok: true })
    expect(g0 - x.goldOf(t.p)).toBe(10_000)
    expect(x.jobState(t)).toMatchObject({ job: 'trader', level: 1, exp: 0, next: 2000, mode: false, side: 'law' })
    // one job per character: not another licence, not the Bounty Hunter's either
    expect(x.join(t, 'trader')).toMatchObject({ ok: false, reason: 'not_usable' })
    expect(x.join(t, 'hunter')).toMatchObject({ ok: false, reason: 'not_usable' })
    expect(x.g.npcs.servicesOf(null, x.jod)).not.toContain('thief')
    // the wrong NPC: Jodaesan does not license Thieves
    x.h.world.warp(t.p, 0, 0, 1.5, x.h.now)
    expect(x.req(t, { t: 'jobJoin', npc: x.jod.id, job: 'thief' })).toMatchObject({ ok: false, reason: 'not_found' })
    // too far from the NPC
    const far = x.char([60, 0, 60])
    expect(x.req(far, { t: 'jobJoin', npc: x.jod.id, job: 'trader' })).toMatchObject({ ok: false, reason: 'too_far' })
    // the Hunter's licence through jobJoin is Yun's (the siege's rules: 30 clean days, the Wanted refused)
    const hu = x.char([0, 0, 1], { name: 'Hugo' })
    expect(x.join(hu, 'hunter')).toMatchObject({ ok: true })
    expect(x.jobState(hu)).toMatchObject({ job: 'hunter', level: 1, side: 'law' })
    expect(x.g.hunters.licensed(hu.p.characterId, x.h.now)).toBe(true)
    const th = x.char([0, 0, 1], { name: 'Thea' })
    expect(x.join(th, 'thief')).toMatchObject({ ok: true })
    expect(x.jobState(th)).toMatchObject({ job: 'thief', side: 'outlaw' })
  })

  it('one side per account: no Thief beside a Trader or Hunter alt; leaving waits 3 days, a side change 7', () => {
    const x = harness()
    const a = x.char([0, 0, 1], { name: 'Main' })
    expect(x.join(a, 'trader')).toMatchObject({ ok: true })
    const alt = x.char([0, 0, 1], { alt: a.p, name: 'Alt' })
    const thief = x.join(alt, 'thief')
    expect(thief).toMatchObject({ ok: false, reason: 'requirements' })
    expect(String((thief as { message?: string }).message)).toMatch(/Main \(Trader\)/)
    // the same side is fine: a Bounty Hunter alt
    expect(x.join(alt, 'hunter')).toMatchObject({ ok: true })
    // another account may be a Thief
    const other = x.char([0, 0, 1], { name: 'Other' })
    expect(x.join(other, 'thief')).toMatchObject({ ok: true })
    // leaving at the NPC: level and EXP gone, the account waits 3 days
    x.g.jobs.addExp(a.p.characterId, 7000, x.h.now)
    expect(x.leave(a, 'trader')).toMatchObject({ ok: true })
    expect(x.g.jobs.jobOf(a.p.characterId)).toBeNull()
    expect(x.jobState(a)).toMatchObject({ job: null, level: 0, exp: 0, joinAfter: x.h.now + 3 * DAY })
    expect(x.join(a, 'trader')).toMatchObject({ ok: false, reason: 'cooldown' })
    x.jump(3 * DAY)
    // still a law-side Hunter alt: no Thief
    expect(x.join(a, 'thief')).toMatchObject({ ok: false, reason: 'requirements' })
    expect(x.leave(alt, 'hunter')).toMatchObject({ ok: true })
    x.jump(3 * DAY)
    // the side changed on day 0: 7 days before switching
    expect(x.join(a, 'thief')).toMatchObject({ ok: false, reason: 'cooldown' })
    x.jump(DAY + MIN)
    expect(x.join(a, 'thief')).toMatchObject({ ok: true })
    expect(x.jobState(a)).toMatchObject({ job: 'thief', level: 1, exp: 0, side: 'outlaw' })
    // and now the alt cannot go back to the law
    expect(x.join(alt, 'trader')).toMatchObject({ ok: false, reason: 'requirements' })
  })
})

describe('job mode = the suit (§2.2)', () => {
  it('Traders dress in town, Thieves at Old Fang or the den, Hunters by their duty; the badge; no job, no suit', () => {
    const x = harness()
    const t = x.char([1, 0, 1], { name: 'Tess' })
    const watcher = x.char([2, 0, 1])
    expect(x.req(t, { t: 'jobMode', on: true })).toMatchObject({ ok: false, reason: 'not_usable' })
    x.join(t, 'trader')
    x.h.world.warp(t.p, ROAD[0], 0, ROAD[2], x.h.now)
    expect(x.req(t, { t: 'jobMode', on: true })).toMatchObject({ ok: false, reason: 'wrong_place' })
    x.h.world.warp(t.p, 1, 0, 1, x.h.now)
    t.p.lastCombatAt = x.h.now - 1000
    expect(x.req(t, { t: 'jobMode', on: true })).toMatchObject({ ok: false, reason: 'in_combat' })
    t.p.lastCombatAt = 0
    expect(x.req(t, { t: 'jobMode', on: true })).toMatchObject({ ok: true })
    expect(x.h.world.state(t.p).job).toEqual({ job: 'trader', level: 1 })
    expect(x.h.all(watcher.inbox, 'entityUpdate').some((u) => u.id === t.p.id && u.job?.job === 'trader')).toBe(true)
    expect(x.jobState(t)).toMatchObject({ mode: true })
    expect(x.req(t, { t: 'jobMode', on: false })).toMatchObject({ ok: true })
    expect(x.h.world.state(t.p).job).toBeUndefined()
    expect(x.h.all(watcher.inbox, 'entityUpdate').at(-1)).toMatchObject({ id: t.p.id, job: null })
    // a Thief: not in town, at Old Fang's camp
    const th = x.char([1, 0, 1], { name: 'Thea' })
    x.join(th, 'thief')
    x.h.world.warp(th.p, 1, 0, 1, x.h.now)
    expect(x.req(th, { t: 'jobMode', on: true })).toMatchObject({ ok: false, reason: 'wrong_place' })
    expect(x.suitUp(th)).toMatchObject({ ok: true })
    expect(x.h.world.state(th.p).job).toEqual({ job: 'thief', level: 1 })
    // a Hunter: jobMode is the duty (the blue badge and the job badge together)
    const hu = x.char([1, 0, 1], { name: 'Hugo' })
    x.join(hu, 'hunter')
    expect(x.suitUp(hu, [1, 0, 1])).toMatchObject({ ok: true })
    expect(x.g.hunters.onDuty(hu.p)).toBe(true)
    expect(x.h.world.state(hu.p)).toMatchObject({ hunter: 0, job: { job: 'hunter', level: 1 } })
    x.h.req(hu.p, { t: 'hunterDuty', on: false })
    expect(x.h.world.state(hu.p).job).toBeUndefined()
    expect(x.h.world.state(hu.p).hunter).toBeUndefined()
  })
})

describe('the PvP matrix live (§4)', () => {
  it('a Thief and a Hunter fight on the road; a Trader and a Hunter cannot; Thieves do not fight Thieves; towns and rings are safe', () => {
    const x = harness()
    const t = x.char([1, 0, 1], { name: 'Tess' })
    const hu = x.char([1, 0, 1], { name: 'Hugo' })
    const th = x.char([1, 0, 1], { name: 'Thea' })
    const th2 = x.char([1, 0, 1], { name: 'Theo' })
    const plain = x.char([ROAD[0] + 1, 0, ROAD[2]], { name: 'Plain' })
    x.join(t, 'trader')
    x.join(hu, 'hunter')
    x.join(th, 'thief')
    x.join(th2, 'thief')
    // out of job mode: no PvP on the road
    for (const r of [t, hu, th, th2]) x.h.world.warp(r.p, ROAD[0], 0, ROAD[2] + 1, x.h.now)
    expect(x.attack(th, hu.p)).toMatchObject({ ok: false, reason: 'invalid_target' })
    for (const r of [t, hu, th, th2]) expect(x.suitUp(r, [ROAD[0], 0, ROAD[2] + 1.5])).toMatchObject({ ok: true })
    // the gate of layer 1: a Thief and a Hunter fight outside town, both ways
    expect(x.attack(th, hu.p)).toMatchObject({ ok: true })
    x.stop(th)
    expect(x.attack(hu, th.p)).toMatchObject({ ok: true })
    x.stop(hu)
    expect(x.attack(th, t.p)).toMatchObject({ ok: true })
    x.stop(th)
    expect(x.attack(t, th.p)).toMatchObject({ ok: true })
    x.stop(t)
    // a Trader and a Hunter cannot; Thieves do not fight Thieves; nobody touches a player out of job mode
    expect(x.attack(t, hu.p)).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(x.attack(hu, t.p)).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(x.attack(th, th2.p)).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(x.attack(th, plain.p)).toMatchObject({ ok: false, reason: 'invalid_target' })
    expect(x.attack(plain, th.p)).toMatchObject({ ok: false, reason: 'invalid_target' })
    // towns are safe for the job war
    x.h.world.warp(th.p, 2, 0, 2, x.h.now)
    x.h.world.warp(hu.p, 3, 0, 2, x.h.now)
    expect(x.attack(th, hu.p)).toMatchObject({ ok: false, reason: 'safe_zone' })
    expect(x.attack(hu, th.p)).toMatchObject({ ok: false, reason: 'safe_zone' })
    // the den's and the posts' 12 m rings too
    const den = x.g.jobs.content.den
    x.h.world.warp(th.p, den.x + 5, 0, den.z, x.h.now)
    x.h.world.warp(hu.p, den.x + 7, 0, den.z, x.h.now)
    expect(x.attack(hu, th.p)).toMatchObject({ ok: false, reason: 'safe_zone' })
    const post = x.g.jobs.content.posts.find((p) => p.id === 'sea-cliffs')!
    x.h.world.warp(th.p, post.x + 15, 0, post.z, x.h.now)
    x.h.world.warp(t.p, post.x + 10, 0, post.z, x.h.now)
    expect(x.attack(th, t.p)).toMatchObject({ ok: false, reason: 'safe_zone' })
    x.h.world.warp(t.p, post.x + 14, 0, post.z, x.h.now)
    expect(x.attack(th, t.p)).toMatchObject({ ok: true })
  })

  it("a Thief's hit lands on a Trader; both suits stay on for 2 min after a PvP hit", () => {
    const x = harness()
    const t = x.char([1, 0, 1], { name: 'Tess' })
    const th = x.char([1, 0, 1], { name: 'Thea' })
    x.join(t, 'trader')
    x.join(th, 'thief')
    x.suitUp(t, ROAD)
    x.suitUp(th, [ROAD[0] + 1.5, 0, ROAD[2]])
    expect(x.attack(th, t.p)).toMatchObject({ ok: true })
    x.tick(3000)
    x.stop(th)
    expect(t.p.hp).toBeLessThan(5000)
    expect(x.req(th, { t: 'jobMode', on: false })).toMatchObject({ ok: false, reason: 'in_combat' })
    expect(x.req(t, { t: 'jobMode', on: false })).toMatchObject({ ok: false, reason: 'in_combat' })
    expect(x.g.jobs.view(t.p, x.h.now).lockUntil).toBeGreaterThan(x.h.now)
    x.jump(2 * MIN + 1000)
    expect(x.req(th, { t: 'jobMode', on: false })).toMatchObject({ ok: true })
  })
})

describe('job EXP and levels (§3)', () => {
  it("a wall-breaker's capture: +2,000 job EXP, level 2 = rank 1, the promotion; GM level and exp; character EXP untouched", () => {
    const x = harness()
    const hu = x.char([1, 0, 1], { name: 'Hugo' })
    const crook = x.char([2, 0, 1], { name: 'Crook' })
    const watcher = x.char([3, 0, 1])
    x.join(hu, 'hunter')
    x.suitUp(hu, [1, 0, 1])
    const charExp = x.h.store.characterById(hu.p.characterId)!.exp
    x.g.law.issue([{ characterId: crook.p.characterId, role: 'breaker' }], 'N1', false, x.h.now)
    expect(x.g.law.gm(null, ['capture', 'Crook', 'Hugo'], x.h.now).ok).toBe(true)
    expect(x.jobState(hu)).toMatchObject({ job: 'hunter', level: 2, exp: 2000, next: 6000 })
    expect(x.h.all(hu.inbox, 'lawState').at(-1)?.hunter).toMatchObject({ rank: 1, captures: 1 })
    expect(x.h.world.state(hu.p)).toMatchObject({ hunter: 1, job: { job: 'hunter', level: 2 } })
    expect(x.h.all(watcher.inbox, 'entityUpdate').some((u) => u.id === hu.p.id && u.hunter === 1 && u.job?.level === 2)).toBe(true)
    expect(x.h.all(hu.inbox, 'chat').some((c) => /promotes you: Bounty Hunter level 2, Tracker/.test(c.text))).toBe(true)
    expect(x.h.store.characterById(hu.p.characterId)!.exp).toBe(charExp)
    // GM: level 7 is Warden of the Roads (rank 6)
    expect(x.g.jobs.gm(['Hugo', 'level', '7'], x.h.now)).toMatchObject({ ok: true })
    expect(x.h.world.state(hu.p)).toMatchObject({ hunter: 6, job: { job: 'hunter', level: 7 } })
    expect(x.g.jobs.gm(['Hugo'], x.h.now).message).toMatch(/Bounty Hunter level 7 \(Warden of the Roads\), 130000 job EXP, job mode on/)
    expect(x.g.jobs.gm(['Hugo', 'exp', '6500'], x.h.now).message).toMatch(/level 3, 6500/)
    expect(x.h.world.state(hu.p).hunter).toBe(2)
    expect(x.g.jobs.gm(['Hugo', 'level', '9'], x.h.now).ok).toBe(false)
    // a Trader's EXP (the trade's own sources come with layer 2): addExp levels and labels
    const t = x.char([1, 0, 1], { name: 'Tess' })
    x.join(t, 'trader')
    expect(x.g.jobs.addExp(t.p.characterId, 35_000, x.h.now)).toEqual({ level: 5, exp: 35_000 })
    expect(x.h.all(t.inbox, 'chat').some((c) => /Trader level 5, Trade Master/.test(c.text))).toBe(true)
  })
})

describe('migration 25: the Bounty Hunters become the Hunter job (§2.3, §9.3)', () => {
  it('rank r -> level r + 1 at its threshold; licence, duty, captures and revocations kept; their accounts on the law side', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sro-jobs-mig-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const db = new Database(join(dir, 'game.db'))
    cleanups.push(() => db.close())
    expect(migrate(db, 24)).toBe(24)
    db.exec(`INSERT INTO accounts (id, username, password_hash, created_at, role) VALUES (1, 'a', 'x', 1, 'player'), (2, 'b', 'x', 1, 'player'), (3, 'c', 'x', 1, 'player');
      INSERT INTO characters (id, account_id, name, model, weapon, level, world, created_at) VALUES
        (1, 1, 'Rookie', 'CHAR_CH_MAN_ADVENTURER', 'sword', 20, 'jangan', 1),
        (2, 1, 'RookieAlt', 'CHAR_CH_MAN_ADVENTURER', 'sword', 20, 'jangan', 1),
        (3, 2, 'Veteran', 'CHAR_CH_MAN_ADVENTURER', 'sword', 20, 'jangan', 1),
        (4, 2, 'Sergeant', 'CHAR_CH_MAN_ADVENTURER', 'sword', 20, 'jangan', 1),
        (5, 3, 'Nobody', 'CHAR_CH_MAN_ADVENTURER', 'sword', 20, 'jangan', 1);
      INSERT INTO char_jobs (character_id, job, rank, points, licensed_at, revoked_until, on_duty) VALUES
        (1, 'hunter', 0, 0, 10, NULL, 1),
        (3, 'hunter', 5, 70, 11, 999999, 0),
        (4, 'hunter', 3, 12, 12, NULL, 1);`)
    expect(migrate(db)).toBe(27)
    const rows = db.prepare('SELECT character_id, rank, points, on_duty, revoked_until, job_exp FROM char_jobs ORDER BY character_id').all() as {
      character_id: number
      rank: number
      points: number
      on_duty: number
      revoked_until: number | null
      job_exp: number
    }[]
    expect(rows).toEqual([
      { character_id: 1, rank: 0, points: 0, on_duty: 1, revoked_until: null, job_exp: 0 },
      { character_id: 3, rank: 5, points: 70, on_duty: 0, revoked_until: 999999, job_exp: 70_000 },
      { character_id: 4, rank: 3, points: 12, on_duty: 1, revoked_until: null, job_exp: 15_000 },
    ])
    for (const r of rows) expect(jobLevelOf(r.job_exp, JOB_SETTINGS_DEFAULTS.jobs.levels) - 1).toBe(r.rank)
    expect(db.prepare('SELECT account_id, side, left_at FROM account_jobs ORDER BY account_id').all()).toEqual([
      { account_id: 1, side: 'law', left_at: null },
      { account_id: 2, side: 'law', left_at: null },
    ])
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'job_settings'").get()).toEqual({ name: 'job_settings' })
  })

  it('a migrated Hunter in the game: its level, its badge on duty, and its alt cannot be a Thief', () => {
    const x = harness()
    const hu = x.char([1, 0, 1], { name: 'Old' })
    x.g.hunters.gm('Old', 'licence', undefined, x.h.now)
    // as migration 25 leaves a rank-3 Hunter
    x.h.store.db.prepare('UPDATE char_jobs SET rank = 3, points = 12, job_exp = 15000, on_duty = 1 WHERE character_id = ?').run(hu.p.characterId)
    x.h.store.db.prepare("INSERT INTO account_jobs (account_id, side, side_changed_at, left_at) VALUES (?, 'law', 0, NULL)").run(x.accountOf(hu.p))
    x.g.hunters.invalidate(hu.p.characterId)
    x.g.jobs.invalidate(hu.p.characterId)
    expect(x.g.jobs.levelOf(hu.p.characterId)).toBe(4)
    expect(x.h.world.state(hu.p)).toMatchObject({ hunter: 3, job: { job: 'hunter', level: 4 } })
    expect(x.g.hunters.viewOf(hu.p, x.h.now)).toMatchObject({ rank: 3, captures: 12, onDuty: true })
    const alt = x.char([1, 0, 1], { alt: hu.p })
    expect(x.join(alt, 'thief')).toMatchObject({ ok: false, reason: 'requirements' })
  })
})

describe('abuse (§7, §11 abuse-jobs)', () => {
  it('associates never fight in the job war: the same party, the same IP (another account), alts are refused at the join', () => {
    const x = harness()
    const t = x.char([1, 0, 1], { name: 'Tess' })
    const th = x.char([1, 0, 1], { name: 'Thea' })
    x.join(t, 'trader')
    x.join(th, 'thief')
    x.suitUp(t, ROAD)
    x.suitUp(th, [ROAD[0] + 1.5, 0, ROAD[2]])
    x.h.req(t.p, { t: 'partyInvite', target: th.p.id })
    x.h.req(th.p, { t: 'partyRespond', inviter: t.p.id, accept: true })
    expect(x.g.party.sameParty(t.p, th.p)).toBe(true)
    const r = x.attack(th, t.p)
    expect(r).toMatchObject({ ok: false, reason: 'invalid_target' })
    x.h.req(th.p, { t: 'partyLeave' })
    expect(x.attack(th, t.p)).toMatchObject({ ok: true })
    x.stop(th)
    // the same connection (two accounts behind one IP)
    const ips = new Map<number, string>([
      [t.p.id, '203.0.113.7'],
      [th.p.id, '203.0.113.7'],
    ])
    x.g.law.connect({ ipOf: (p) => ips.get(p.id) ?? null })
    expect(x.attack(th, t.p)).toMatchObject({ ok: false, reason: 'invalid_target' })
  })

  it('no leaving with a warrant, in the suit, jailed or revoked; the Wanted cannot join; GM licences keep one job', () => {
    const x = harness()
    const th = x.char([1, 0, 1], { name: 'Thea' })
    x.join(th, 'thief')
    x.suitUp(th, [1, 0, 1])
    expect(x.leave(th, 'thief')).toMatchObject({ ok: false, reason: 'not_usable' })
    x.h.world.warp(th.p, FANG.x + 2, 0, FANG.z, x.h.now)
    expect(x.req(th, { t: 'jobMode', on: false })).toMatchObject({ ok: true })
    x.g.law.issue([{ characterId: th.p.characterId, role: 'breaker' }], 'N1', false, x.h.now)
    expect(x.leave(th, 'thief')).toMatchObject({ ok: false, reason: 'not_usable' })
    x.g.law.close(th.p.characterId, 'pardoned', x.h.now)
    expect(x.g.law.gm(null, ['jail', 'Thea', '30'], x.h.now).ok).toBe(true)
    expect(x.leave(th, 'thief')).toMatchObject({ ok: false, reason: 'jailed' })
    expect(x.g.law.gm(null, ['release', 'Thea'], x.h.now).ok).toBe(true)
    // the Wanted cannot join
    const crook = x.char([1, 0, 1], { name: 'Crook' })
    x.g.law.issue([{ characterId: crook.p.characterId, role: 'breaker' }], 'N1', false, x.h.now)
    expect(x.join(crook, 'thief')).toMatchObject({ ok: false, reason: 'not_usable' })
    // a revoked Bounty Hunter keeps the revocation: no leaving to rejoin clean
    const hu = x.char([1, 0, 1], { name: 'Hugo' })
    x.join(hu, 'hunter')
    expect(x.g.hunters.revokeFor(hu.p.characterId, x.h.now, 'test')).toBe(true)
    expect(x.leave(hu, 'hunter')).toMatchObject({ ok: false, reason: 'not_usable' })
    // GM `law hunter licence` on a Trader: one job per character
    const t = x.char([1, 0, 1], { name: 'Tess' })
    x.join(t, 'trader')
    expect(x.g.hunters.gm('Tess', 'licence', undefined, x.h.now)).toMatchObject({ ok: false })
    expect(x.g.jobs.gm(['Tess', 'join', 'thief'], x.h.now)).toMatchObject({ ok: false })
    // a Thief cannot dress in town and walk the Thief's suit off mid-fight (covered above); a job-mode Thief in town is safe
    expect(x.g.jobs.inJobSafe(1, 1)).toBe(true)
    expect(x.g.jobs.inJobSafe(ROAD[0], ROAD[2])).toBe(false)
  })

  it('jobs off (admin): no joining, no suits, no job PvP; the Bounty Hunters keep hunting the Wanted', async () => {
    const x = harness()
    const t = x.char([1, 0, 1], { name: 'Tess' })
    const th = x.char([1, 0, 1], { name: 'Thea' })
    x.join(t, 'trader')
    x.join(th, 'thief')
    x.suitUp(t, ROAD)
    x.suitUp(th, [ROAD[0] + 1.5, 0, ROAD[2]])
    x.g.jobs.savePatch({ jobs: { enabled: false } }, null, x.h.now)
    expect(x.attack(th, t.p)).toMatchObject({ ok: false, reason: 'invalid_target' })
    const late = x.char([1, 0, 1])
    expect(x.join(late, 'trader')).toMatchObject({ ok: false, reason: 'not_found' })
    // the siege law is untouched: an on-duty Bounty Hunter still fights the Wanted
    const hu = x.char([ROAD[0], 0, ROAD[2] + 3], { name: 'Hugo' })
    x.g.hunters.gm('Hugo', 'licence', undefined, x.h.now)
    x.g.hunters.gm('Hugo', 'duty', 'on', x.h.now)
    x.g.law.issue([{ characterId: t.p.characterId, role: 'breaker' }], 'N1', false, x.h.now)
    expect(x.attack(hu, t.p)).toMatchObject({ ok: true })
  })
})

describe('GM job and the admin routes (§9.5)', () => {
  it('GM job join / mode / side / leave; admin GET, PUT settings (bounds, rev), POST member; admin only, audited', async () => {
    const x = harness()
    const root = x.char([0, 0, 0], { name: 'Root' })
    const c = x.char([1, 0, 1], { name: 'Cid' })
    const run = (...a: string[]) => x.g.jobs.gm(a, x.h.now)
    expect(run('Cid').message).toMatch(/no job/)
    expect(run('Cid', 'join', 'pirate').ok).toBe(false)
    expect(run('Cid', 'join', 'thief').ok).toBe(true)
    expect(run('Cid', 'mode', 'on').ok).toBe(true)
    expect(x.h.world.state(c.p).job).toEqual({ job: 'thief', level: 1 })
    expect(run('Cid', 'side', 'law').ok).toBe(true)
    expect(run('Cid', 'leave').ok).toBe(true)
    expect(x.h.world.state(c.p).job).toBeUndefined()
    expect(run('Nobody').ok).toBe(false)
    const ctx = { gameplay: x.g, world: x.h.world, data: x.h.data, store: x.h.store, config: x.h.config } as unknown as GameContext
    const actor = { accountId: x.accountOf(root.p), role: 'admin' as const, username: 'root' }
    const call = async <T = Record<string, unknown>>(method: string, sub: string, body?: unknown, role: 'admin' | 'gm' = 'admin') =>
      (await routeAdminJobs(ctx, { method, path: `/api/admin/jobs${sub}`, query: new URLSearchParams(''), body, actor: { ...actor, role } })) as { status: number; body: T }
    expect((await call('GET', '', undefined, 'gm')).status).toBe(403)
    expect((await call('POST', '/member', { character: 'Cid', join: 'trader' })).status).toBe(200)
    const v = (await call<AdminJobsView>('GET', '')).body
    expect(v.enabled).toBe(true)
    expect(v.counts).toEqual({ trader: 1, hunter: 0, thief: 0 })
    expect(v.members).toEqual([expect.objectContaining({ name: 'Cid', job: 'trader', level: 1, mode: false, online: true })])
    expect(v.content.posts.map((p) => p.id)).toEqual(['jangan', 'south-beach', 'tomb-camp', 'ferry-landing', 'sea-cliffs'])
    expect(v.settings.rev).toBe(0)
    expect((await call('PUT', '/settings', { baseRev: 0, patch: { jobs: { minLevel: 0 } } })).status).toBe(422)
    expect((await call('PUT', '/settings', { baseRev: 3, patch: { jobs: { minLevel: 18 } } })).status).toBe(409)
    expect((await call('PUT', '/settings', { baseRev: 0, patch: { jobs: { minLevel: 18 } } })).status).toBe(200)
    expect(x.g.jobs.settings.jobs.minLevel).toBe(18)
    const low = x.char([1, 0, 1], { level: 17 })
    expect(x.join(low, 'thief')).toMatchObject({ ok: false, reason: 'requirements' })
    expect((await call('POST', '/settings/reset', { paths: ['jobs.minLevel'] })).status).toBe(200)
    expect(x.g.jobs.settings.jobs.minLevel).toBe(15)
    expect((await call('POST', '/member', { character: 'Cid', level: 4 })).status).toBe(200)
    expect(x.g.jobs.levelOf(c.p.characterId)).toBe(4)
    expect((await call('POST', '/member', { character: 'Cid', level: 4, leave: true })).status).toBe(400)
    expect((await call('GET', '/nope')).status).toBe(404)
    const audit = x.h.store.db.prepare("SELECT args FROM gm_audit WHERE command = 'job'").all() as { args: string }[]
    expect(audit.length).toBeGreaterThanOrEqual(5)
  })
})
