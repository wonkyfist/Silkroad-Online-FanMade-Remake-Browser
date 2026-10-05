/**
 * Play the Boss (docs/PLAY_THE_BOSS.md §5, §6.2): the client and server message validators, the settings schema
 * (bounds, the zone, the patch helpers and the cross-field rules of layer 4) and the `pilot` block of content/uniques.json (checkUniquesFile on the shipped file and on bad
 * blocks).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACTION_FAIL_REASONS,
  CLIENT_RATE_LIMITS,
  GAMEPLAY_REQUESTS,
  PILOT_BOUNDS,
  PILOT_DEFAULTS,
  PILOT_REQUESTS,
  PILOT_SETTING_PATHS,
  checkPilotDef,
  checkPilotEffective,
  checkPilotSettings,
  checkUniquesFile,
  mergePilotPatch,
  mergePilotSettings,
  prunePilotPatch,
  unsetPilotPaths,
  validTimeZone,
  validateClientMessage,
  validateServerMessage,
  type UniquesFile,
} from '../src/index.ts'

const okC = (v: unknown) => {
  const r = validateClientMessage(v)
  if (!r.ok) throw new Error(r.error)
  return r.msg
}
const badC = (v: unknown) => expect(validateClientMessage(v).ok, JSON.stringify(v)).toBe(false)
const okS = (v: unknown) => {
  const r = validateServerMessage(v)
  if (!r.ok) throw new Error(r.error)
  return r.msg
}
const badS = (v: unknown) => expect(validateServerMessage(v).ok, JSON.stringify(v)).toBe(false)

const FILE = JSON.parse(readFileSync(join(import.meta.dirname, '../../../content/uniques.json'), 'utf8')) as UniquesFile

describe('client -> server (§5.1)', () => {
  it('the five requests are GameplayRequests with budgets and the new fail reasons', () => {
    for (const t of PILOT_REQUESTS) {
      expect(GAMEPLAY_REQUESTS).toContain(t)
      expect(CLIENT_RATE_LIMITS[t]).toBeDefined()
    }
    expect(CLIENT_RATE_LIMITS.pilotAct).toEqual({ perSecond: 5, burst: 10 })
    for (const r of ['piloting', 'not_eligible', 'no_event', 'no_charges'] as const) expect(ACTION_FAIL_REASONS).toContain(r)
  })

  it('accepts the documented shapes', () => {
    expect(okC({ t: 'pilotVolunteer', on: true })).toEqual({ t: 'pilotVolunteer', on: true })
    expect(okC({ t: 'pilotAnswer', event: 3, accept: false })).toEqual({ t: 'pilotAnswer', event: 3, accept: false })
    expect(okC({ t: 'pilotAct', ability: 'claw', target: 12, repeat: true })).toEqual({ t: 'pilotAct', ability: 'claw', target: 12, repeat: true })
    expect(okC({ t: 'pilotAct', ability: 'pounce', x: 10.5, z: -3 })).toEqual({ t: 'pilotAct', ability: 'pounce', x: 10.5, z: -3 })
    expect(okC({ t: 'pilotTaunt', line: 7 })).toEqual({ t: 'pilotTaunt', line: 7 })
    expect(okC({ t: 'pilotQuit' })).toEqual({ t: 'pilotQuit' })
  })

  it('rejects bad abilities, half a point, lines past 15, extra fields, event 0', () => {
    badC({ t: 'pilotAct', ability: 'Claw' })
    badC({ t: 'pilotAct', ability: 'a'.repeat(17) })
    badC({ t: 'pilotAct', ability: 'pounce', x: 1 })
    badC({ t: 'pilotAct', ability: 'claw', text: 'hi' })
    badC({ t: 'pilotTaunt', line: 16 })
    badC({ t: 'pilotTaunt', line: 'hi' })
    badC({ t: 'pilotAnswer', event: 0, accept: true })
    badC({ t: 'pilotQuit', why: 'x' })
  })
})

describe('server -> client (§5.2)', () => {
  it('accepts every message', () => {
    const ev = { id: 4, mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', phase: 'hunt', huntEndsAt: 1e12, downs: 2, downsTarget: 15, hunters: 6, area: 'North-Tiger Mt.', steering: 'ai' }
    expect(okS({ t: 'huntEvent', event: ev })).toEqual({ t: 'huntEvent', event: ev })
    expect(okS({ t: 'huntEvent', event: { id: 4, mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', phase: 'ended', outcome: 'survived', pilot: 'Pixi' } })).toMatchObject({ event: { pilot: 'Pixi' } })
    expect(okS({ t: 'pilotOffer', event: 4, expiresAt: 1e12, surviveMin: 15, downsTarget: 15, idleSec: 20 })).toMatchObject({ t: 'pilotOffer' })
    const kit = [{ id: 'claw', slot: 1, clip: '', rangeM: 2.8, cooldownMs: 3000, target: 'entity' }, { id: 'pack', slot: 6, clip: 'HELP', rangeM: 0, cooldownMs: 30000, charges: 2, target: 'none' }]
    expect(okS({ t: 'pilotStart', event: 0, mob: 9, kit, huntEndsAt: 0, downsTarget: 0, area: { x: 1, z: 2, r: 350 }, taunts: 8, senseM: 60, place: 'palace-steps' })).toMatchObject({ kit })
    expect(okS({ t: 'pilotState', steering: 'player', hunting: 3, downs: 1, charges: { pack: 1 }, ready: { claw: 1e12 }, idleWarnAt: 1e12, enraged: true, stalkUntil: 1e12 })).toMatchObject({ charges: { pack: 1 } })
    expect(okS({ t: 'pilotEnd', event: 4, reason: 'survived', gold: 19500, honor: 'tiger_spirit', downs: 0, steeredMs: 900000 })).toMatchObject({ gold: 19500 })
    expect(okS({ t: 'huntPing', event: 4, x: 1, z: 2, r: 60, at: 1e12 })).toMatchObject({ r: 60 })
    expect(okS({ t: 'huntTrail', points: [[1, 2, 3], [4, 5, 6]] })).toEqual({ t: 'huntTrail', points: [[1, 2, 3], [4, 5, 6]] })
    expect(okS({ t: 'huntRoar', bearing: 1.5, distM: 220, at: 1e12 })).toMatchObject({ distM: 220 })
    expect(okS({ t: 'huntTaunt', id: 9, line: 3 })).toEqual({ t: 'huntTaunt', id: 9, line: 3 })
  })

  it('rejects bad phases, kits, trails and codes', () => {
    badS({ t: 'huntEvent', event: { id: 4, mob: 'M', name: 'X', phase: 'party' } })
    badS({ t: 'pilotStart', event: 0, mob: 9, kit: [{ id: 'Claw', slot: 1, clip: '', rangeM: 1, cooldownMs: 1, target: 'entity' }], huntEndsAt: 0, downsTarget: 0, area: { x: 0, z: 0, r: 1 }, taunts: 8, senseM: 60, place: '' })
    badS({ t: 'huntTrail', points: [[1, 2]] })
    badS({ t: 'pilotEnd', event: 1, reason: 'won' })
    badS({ t: 'pilotEnd', event: 1, reason: 'survived', honor: 'Spirit Of' })
  })

  it('the additive fields: EntityState.trance / piloted / honor, entityUpdate, cast.clip', () => {
    const e = okS({ t: 'spawn', entity: { id: 1, kind: 'player', name: 'Pixi', model: 'CHAR_CH_MAN_ADVENTURER', level: 20, weapon: 'blade', pos: [0, 0, 0], yaw: 0, trance: true, honor: 'tiger_spirit' } })
    expect(e).toMatchObject({ entity: { trance: true, honor: 'tiger_spirit' } })
    expect(okS({ t: 'spawn', entity: { id: 2, kind: 'mob', name: 'Tiger Girl', model: 'MOB_CH_TIGERWOMAN', level: 20, pos: [0, 0, 0], yaw: 0, piloted: true } })).toMatchObject({ entity: { piloted: true } })
    expect(okS({ t: 'entityUpdate', id: 1, trance: false, piloted: false, honor: '' })).toEqual({ t: 'entityUpdate', id: 1, trance: false, piloted: false, honor: '' })
    expect(okS({ t: 'cast', id: 2, skill: 'PILOT_TIGERWOMAN_POUNCE', instance: 1, prepareMs: 0, castMs: 0, actionMs: 900, clip: 'ATTACK1' })).toMatchObject({ clip: 'ATTACK1' })
    badS({ t: 'cast', id: 2, skill: 'X', instance: 1, prepareMs: 0, castMs: 0, actionMs: 900, clip: 'attack one' })
  })
})

describe('settings (§6.2)', () => {
  it('the defaults are a whole, valid PilotSettings; a patch merges per field', () => {
    expect(checkPilotSettings(PILOT_DEFAULTS, true)).toEqual([])
    const s = mergePilotSettings({ win: { downsTarget: 5 }, enabled: true })
    expect(s.win).toEqual({ ...PILOT_DEFAULTS.win, downsTarget: 5 })
    expect(s.enabled).toBe(true)
    expect(PILOT_DEFAULTS.win.downsTarget).toBe(15)
  })

  it('bounds, unknown fields, schedule slots and title codes', () => {
    const paths = (v: unknown) => checkPilotSettings(v).map((i) => i.path)
    expect(paths({ win: { surviveMin: 2 } })).toEqual(['win.surviveMin'])
    expect(paths({ hunt: { speedMul: 2 } })).toEqual(['hunt.speedMul'])
    expect(paths({ hunt: { radius: 3 } })).toEqual(['hunt.radius'])
    expect(paths({ nope: {} })).toEqual(['nope'])
    expect(paths({ schedule: { slots: [{ weekday: 7, time: '21:00' }] } })).toEqual(['schedule.slots[0]'])
    expect(paths({ schedule: { slots: [{ weekday: 6, time: '25:00' }] } })).toEqual(['schedule.slots[0]'])
    expect(paths({ rewards: { title: 'Spirit Of' } })).toEqual(['rewards.title'])
    expect(paths({ rewards: { title: null, cosmetic: 'tiger_dye' } })).toEqual([])
  })

  it('every bound of PILOT_BOUNDS: the ends pass, one step past fails (layer 4)', () => {
    for (const [path, [lo, hi]] of Object.entries(PILOT_BOUNDS)) {
      const [g, k] = path.split('.')
      const at = (v: number) => checkPilotSettings({ [g]: { [k]: v } }).map((i) => i.path)
      expect(at(lo), path).toEqual([])
      expect(at(hi), path).toEqual([])
      expect(at(lo - (Number.isInteger(lo) ? 1 : 0.01)), path).toEqual([path])
      expect(at(hi + (Number.isInteger(hi) ? 1 : 0.01)), path).toEqual([path])
    }
    expect(Object.keys(PILOT_BOUNDS).every((p) => PILOT_SETTING_PATHS.includes(p))).toBe(true)
  })

  it("the schedule's zone: '' (the server's) or an IANA zone this runtime knows", () => {
    const paths = (tz: unknown) => checkPilotSettings({ schedule: { tz } }).map((i) => i.path)
    expect(paths('')).toEqual([])
    expect(paths('Europe/Berlin')).toEqual([])
    expect(paths('America/New_York')).toEqual([])
    expect(paths('UTC')).toEqual([])
    expect(paths('Mars/Olympus_Mons')).toEqual(['schedule.tz'])
    expect(paths(5)).toEqual(['schedule.tz'])
    expect(validTimeZone('Asia/Seoul')).toBe(true)
    expect(validTimeZone('')).toBe(false)
  })

  it('the patch helpers: merge per field (slots whole), unset fields and groups, prune the defaults', () => {
    const base = { win: { downsTarget: 10 }, schedule: { slots: [{ weekday: 1, time: '20:00' }] } }
    expect(mergePilotPatch(base, { win: { surviveMin: 20 }, schedule: { slots: [] }, enabled: true })).toEqual({ win: { downsTarget: 10, surviveMin: 20 }, schedule: { slots: [] }, enabled: true })
    expect(base.win).toEqual({ downsTarget: 10 })
    expect(unsetPilotPaths({ win: { downsTarget: 10, surviveMin: 20 }, enabled: true }, ['win.downsTarget', 'enabled'])).toEqual({ win: { surviveMin: 20 } })
    expect(unsetPilotPaths({ win: { downsTarget: 10 }, hunt: { radiusM: 400 } }, ['win'])).toEqual({ hunt: { radiusM: 400 } })
    expect(unsetPilotPaths({ win: { downsTarget: 10 } }, ['win.downsTarget'])).toEqual({})
    expect(prunePilotPatch({ win: { downsTarget: 15, surviveMin: 20 }, enabled: false, schedule: { slots: [{ weekday: 6, time: '21:00' }] } }, PILOT_DEFAULTS)).toEqual({ win: { surviveMin: 20 } })
    expect(PILOT_SETTING_PATHS).toContain('enabled')
    expect(PILOT_SETTING_PATHS).toContain('schedule.tz')
    expect(PILOT_SETTING_PATHS).toHaveLength(1 + Object.values(PILOT_DEFAULTS).filter((v) => typeof v === 'object').reduce((n, v) => n + Object.keys(v as object).length, 0))
  })

  it('the rules across fields: the level fields within the level cap, the scaling cap at least its base', () => {
    expect(checkPilotEffective(PILOT_DEFAULTS, 110)).toEqual([])
    expect(checkPilotEffective(mergePilotSettings({ eligibility: { minLevel: 120 }, win: { downMinLevel: 111 } }), 110).map((i) => i.path)).toEqual(['eligibility.minLevel', 'win.downMinLevel'])
    expect(checkPilotEffective(mergePilotSettings({ scaling: { baseHunters: 10, capHunters: 9 } })).map((i) => i.path)).toEqual(['scaling.capHunters'])
  })

  it('huntEvent: the call fields (callEndsAt, volunteers, minLevel, you) pass the validator; a bad reason or level does not', () => {
    const ev = { id: 3, mob: 'MOB_CH_TIGERWOMAN', name: 'Tiger Girl', phase: 'call', callEndsAt: 1000, volunteers: 37, minLevel: 20, you: { volunteered: true, eligible: false, why: 'cooldown' } }
    expect(okS({ t: 'huntEvent', event: ev })).toEqual({ t: 'huntEvent', event: ev })
    badS({ t: 'huntEvent', event: { ...ev, minLevel: -1 } })
    badS({ t: 'huntEvent', event: { ...ev, you: { volunteered: true, eligible: false, why: 'tired' } } })
  })
})

describe('content/uniques.json: the pilot block (§5.5)', () => {
  it('the shipped file passes; Tiger Girl has the 7-slot kit of §3.5', () => {
    expect(checkUniquesFile(FILE)).toEqual([])
    const p = FILE.uniques[0].pilot!
    expect(p.trancePlace).toBe('palace-steps')
    expect(p.kit.map((k) => k.id)).toEqual(['claw', 'sweep', 'curse', 'pounce', 'roar', 'pack', 'stalk'])
    expect(checkPilotSettings(p.defaults, true)).toEqual([])
  })

  it('bad blocks are problems: a duplicate slot, a bad id, an unknown kind, a bad number, bad defaults, an unknown row', () => {
    const base = structuredClone(FILE.uniques[0].pilot!)
    const probs = (edit: (p: Record<string, any>) => void, refs = {}) => {
      const p = structuredClone(base) as unknown as Record<string, any>
      edit(p)
      return checkPilotDef(p, 'pilot', refs).join('\n')
    }
    expect(probs((p) => void (p.kit[1].slot = 1))).toMatch(/slot: taken twice/)
    expect(probs((p) => void (p.kit[0].id = 'Claw'))).toMatch(/kit\[0\]\.id/)
    expect(probs((p) => void (p.kit[3].kind = 'fly'))).toMatch(/kind: expected/)
    expect(probs((p) => void (p.kit[3].rangeM = 500))).toMatch(/rangeM/)
    expect(probs((p) => void (p.defaults = { win: { downsTarget: 0 } }))).toMatch(/defaults\.win\.downsTarget/)
    expect(probs(() => {}, { skill: (c: string) => c !== 'MSKILL_CH_TIGERWOMAN_ATTACK03' })).toMatch(/unknown skill row MSKILL_CH_TIGERWOMAN_ATTACK03/)
    const file = structuredClone(FILE)
    ;(file.uniques[0].pilot as unknown as { kit: unknown }).kit = []
    expect(checkUniquesFile(file).join('\n')).toMatch(/pilot\.kit: expected 1\.\.9 abilities/)
  })
})
