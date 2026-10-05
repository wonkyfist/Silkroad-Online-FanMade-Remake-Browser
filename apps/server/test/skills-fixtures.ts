/**
 * Synthetic skills.json / masteries.json rows for the skills engine tests (docs/SKILLS.md §3.2 shapes). Numbers are
 * made up and round (not retail values); codes follow the client's CodeName128 style so the same code paths run.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GameplayRequest, ClientMessage, ItemDef, LevelDef, MasteryDef, MobDef, ServerMessage, SkillDef, TownDef, Vec3 } from '@sro/shared'
import type { ServerConfig } from '../src/config.ts'
import type { WorldSetup } from '../src/content.ts'
import { openStore } from '../src/db.ts'
import { Gameplay } from '../src/gameplay.ts'
import { GameData } from '../src/gamedata.ts'
import { FlatNav } from '../src/nav.ts'
import { SkillBook } from '../src/skills/book.ts'
import { World, type Player } from '../src/world.ts'
import { ITEMS, item, mob } from './fixtures.ts'
import { testConfig } from './helpers.ts'

type Kind = NonNullable<SkillDef['kind']>

export function skill(code: string, over: Partial<SkillDef> & { kind: Kind }): SkillDef {
  const group = code.replace(/_\d\d$/, '').replace(/_\dS$/, '')
  return {
    code,
    id: 1,
    name: code,
    mastery: 'BICHEON',
    masteryLevel: 1,
    skillLevel: 1,
    sp: 1,
    mp: 10,
    category: 'melee',
    castMs: 0,
    actionMs: 0,
    cooldownMs: 1000,
    range: 0,
    weapons: [],
    icon: null,
    group,
    targets: { required: false, groups: [] },
    ...over,
  }
}

const enemy = { required: true, groups: ['enemy_mob', 'enemy_player'] } as SkillDef['targets']
const friend = { required: true, groups: ['self', 'ally', 'party'] } as SkillDef['targets']
const att = (physPct: number, flat: [number, number] = [10, 10], hits = 1, magPct = 0) => ({ physPct, magPct, flat, hits })
const sword: SkillDef['weapons'] = ['sword', 'blade']

export const SKILLS: SkillDef[] = [
  // basic attacks (docs/WAVE_PLAN.md decision 10)
  skill('SKILL_PUNCH_01', { kind: 'attack', mastery: null, masteryLevel: 0, sp: 0, mp: 0, actionMs: 1500, cooldownMs: 1500, basicAttack: true, damage: att(150, [0, 0]), targets: enemy, group: undefined }),
  skill('SKILL_CH_SWORD_BASE_01', { kind: 'attack', masteryLevel: 0, sp: 0, mp: 0, actionMs: 1000, cooldownMs: 1000, basicAttack: true, weapons: sword, damage: att(50, [0, 0], 2), targets: enemy }),
  skill('SKILL_CH_BOW_BASE_01', { kind: 'attack', mastery: 'PACHEON', masteryLevel: 0, sp: 0, mp: 0, actionMs: 800, cooldownMs: 800, basicAttack: true, weapons: ['bow'], damage: att(80, [0, 0]), targets: enemy, consumes: { typeId3: 4, typeId4: 1, count: 1 } }),
  // Strike Smash: a plain attack with levels
  skill('SKILL_CH_SWORD_SMASH_A_01', { kind: 'attack', masteryLevel: 1, sp: 2, mp: 20, castMs: 400, actionMs: 1000, cooldownMs: 3000, weapons: sword, damage: att(150), targets: enemy, autoAttack: 1, ui: { tab: 'weapon', page: 0, column: 0, row: 0 } }),
  skill('SKILL_CH_SWORD_SMASH_A_02', { kind: 'attack', masteryLevel: 3, skillLevel: 2, sp: 3, mp: 25, castMs: 400, actionMs: 1000, cooldownMs: 3000, weapons: sword, damage: att(150, [20, 20]), targets: enemy, autoAttack: 1 }),
  skill('SKILL_CH_SWORD_SMASH_A_03', { kind: 'attack', masteryLevel: 5, skillLevel: 3, sp: 4, mp: 30, castMs: 400, actionMs: 1000, cooldownMs: 3000, weapons: sword, damage: att(150, [30, 30]), targets: enemy, autoAttack: 1 }),
  // Illusion Chain: three segments, one group; only the head costs and arms the cooldown
  skill('SKILL_CH_SWORD_CHAIN_A_1S_01', { kind: 'attack', group: 'SKILL_CH_SWORD_CHAIN_A', masteryLevel: 2, sp: 2, mp: 30, castMs: 0, actionMs: 400, cooldownMs: 8000, weapons: sword, damage: att(30), targets: enemy, chainNext: 'SKILL_CH_SWORD_CHAIN_A_2S_01', chainRoot: 'SKILL_CH_SWORD_CHAIN_A_1S_01', chainIndex: 1 }),
  skill('SKILL_CH_SWORD_CHAIN_A_2S_01', { kind: 'attack', group: 'SKILL_CH_SWORD_CHAIN_A', masteryLevel: 2, sp: 0, mp: 0, castMs: 0, actionMs: 600, cooldownMs: 0, weapons: sword, damage: att(50), targets: enemy, chainNext: 'SKILL_CH_SWORD_CHAIN_A_3S_01', chainRoot: 'SKILL_CH_SWORD_CHAIN_A_1S_01', chainIndex: 2 }),
  skill('SKILL_CH_SWORD_CHAIN_A_3S_01', { kind: 'attack', group: 'SKILL_CH_SWORD_CHAIN_A', masteryLevel: 2, sp: 0, mp: 0, castMs: 0, actionMs: 1000, cooldownMs: 0, weapons: sword, damage: att(120), targets: enemy, chainRoot: 'SKILL_CH_SWORD_CHAIN_A_1S_01', chainIndex: 3 }),
  // Soul Cut Blade: own range, projectile 300 dm/s
  skill('SKILL_CH_SWORD_GEOMGI_A_01', { kind: 'attack', category: 'ranged', masteryLevel: 1, mp: 30, castMs: 300, actionMs: 800, cooldownMs: 4000, range: 12, weapons: sword, damage: att(110), targets: enemy, hitCues: [{ phase: 'SHOT', event: 2, projectile: { move: 'MOV_STRAIGHT', delayMs: 0, speed: 300 } }] }),
  // Blood Blade Force (knockdown 100 %) and Flower Bloom Blade (needs a knocked-down target, da 125)
  skill('SKILL_CH_SWORD_KNOCKDOWN_A_01', { kind: 'attack', masteryLevel: 1, mp: 40, castMs: 700, actionMs: 1100, cooldownMs: 4000, weapons: sword, damage: att(180), targets: enemy, statuses: [{ status: 'knockdown', level: 19, chancePct: 100 }] }),
  skill('SKILL_CH_SWORD_DOWNATTACK_A_01', { kind: 'attack', masteryLevel: 1, mp: 40, castMs: 700, actionMs: 800, cooldownMs: 4000, weapons: sword, damage: att(150), targets: enemy, requiresTargetState: 1, params: [{ tag: 'da', args: [125] }] }),
  // Castle Shield (zero-length buff, needs a shield) and Shield Protection (passive block while a shield is worn)
  skill('SKILL_CH_SWORD_SHIELD_A_01', { kind: 'buff', category: 'buff', masteryLevel: 1, mp: 20, cooldownMs: 60000, durationMs: 15000, overlap: 0x100004f, requiresItem: { typeId3: 4, typeId4: 1 }, params: [{ tag: 'defp', args: [50] }] }),
  skill('SKILL_CH_SWORD_PASSIVE_A_01', { kind: 'passive', category: 'passive', masteryLevel: 1, mp: 0, cooldownMs: 0, requiresItem: { typeId3: 4, typeId4: 1 }, params: [{ tag: 'br', args: [15, 2] }] }),
  // Heuksal: pierce, area around the target, stun, the HP passive
  skill('SKILL_CH_SPEAR_PIERCE_A_01', { kind: 'attack', mastery: 'HEUKSAL', masteryLevel: 1, mp: 20, castMs: 500, actionMs: 1000, cooldownMs: 4000, weapons: ['spear', 'glaive'], damage: att(160), targets: enemy, area: { shape: 'pierce', distance: 0.2, maxTargets: 2, reductionPct: 35, targetMask: 24, raw: [1, 3, 2, 2, 35, 24] } }),
  skill('SKILL_CH_SPEAR_FRONTAREA_A_01', { kind: 'attack', mastery: 'HEUKSAL', masteryLevel: 1, mp: 40, castMs: 800, actionMs: 1100, cooldownMs: 3000, weapons: ['spear', 'glaive'], damage: att(200), targets: enemy, area: { shape: 'target', distance: 2, maxTargets: 3, reductionPct: 50, targetMask: 24, raw: [1, 2, 20, 3, 50, 24] } }),
  skill('SKILL_CH_SPEAR_STUN_A_01', { kind: 'attack', mastery: 'HEUKSAL', masteryLevel: 1, mp: 40, castMs: 1100, actionMs: 1300, cooldownMs: 4000, weapons: ['spear', 'glaive'], damage: att(250), targets: enemy, statuses: [{ status: 'stun', level: 2, chancePct: 100, durationMs: 5000 }] }),
  skill('SKILL_CH_SPEAR_PASSIVE_A_01', { kind: 'passive', category: 'passive', mastery: 'HEUKSAL', masteryLevel: 1, mp: 0, cooldownMs: 0, params: [{ tag: 'hpi', args: [100] }] }),
  // Pacheon: a charged, arrow-using shot with a critical bonus
  skill('SKILL_CH_BOW_CRITICAL_A_01', { kind: 'attack', category: 'ranged', mastery: 'PACHEON', masteryLevel: 1, mp: 20, preparingMs: 700, castMs: 300, actionMs: 500, cooldownMs: 4000, weapons: ['bow'], damage: att(150), targets: enemy, consumes: { typeId3: 4, typeId4: 1, count: 1 }, params: [{ tag: 'cr', args: [20, 0] }] }),
  // Cold: imbue (frostbite 100 %), buff with READY/WAIT/SHOT, and the toggle wall
  skill('SKILL_CH_COLD_GIGONGTA_A_01', { kind: 'imbue', category: 'buff', mastery: 'COLD', masteryLevel: 1, mp: 50, instant: true, cooldownMs: 5000, durationMs: 5000, overlap: 1, damage: att(0, [40, 40], 1, 100), statuses: [{ status: 'frostbite', level: 30, chancePct: 100 }] }),
  skill('SKILL_CH_COLD_GANGGI_A_01', { kind: 'buff', category: 'buff', mastery: 'COLD', masteryLevel: 1, mp: 70, preparingMs: 1000, castMs: 1000, actionMs: 1000, cooldownMs: 2000, durationMs: 300000, overlap: 2, params: [{ tag: 'dura', args: [300000] }, { tag: 'defp', args: [10] }] }),
  skill('SKILL_CH_COLD_GANGGI_A_02', { kind: 'buff', category: 'buff', mastery: 'COLD', masteryLevel: 2, skillLevel: 2, mp: 80, preparingMs: 1000, castMs: 1000, actionMs: 1000, cooldownMs: 2000, durationMs: 300000, overlap: 2, params: [{ tag: 'defp', args: [15] }] }),
  skill('SKILL_CH_COLD_BINGBYEOK_A_01', { kind: 'buff', category: 'buff', mastery: 'COLD', masteryLevel: 1, mp: 100, castMs: 0, actionMs: 0, cooldownMs: 10000, overlap: 11, toggle: { intervalMs: 5000, mp: 40 }, params: [{ tag: 'onff', args: [5000, 40] }, { tag: 'pw', args: [7, 100, 0, 11] }] }),
  // Lightning: chain imbue, instant move-speed buff
  skill('SKILL_CH_LIGHTNING_GIGONGTA_A_01', { kind: 'imbue', category: 'buff', mastery: 'LIGHTNING', masteryLevel: 1, mp: 50, instant: true, cooldownMs: 5000, durationMs: 5000, overlap: 1, damage: att(0, [30, 30], 1, 100), area: { shape: 'chain', distance: 3.5, maxTargets: 2, reductionPct: 80, targetMask: 24, raw: [1, 6, 35, 2, 80, 24] } }),
  skill('SKILL_CH_LIGHTNING_GYEONGGONG_A_01', { kind: 'buff', category: 'buff', mastery: 'LIGHTNING', masteryLevel: 1, mp: 50, instant: true, cooldownMs: 2000, durationMs: 300000, overlap: 6, params: [{ tag: 'hste', args: [20] }] }),
  // Fire: burn imbue (5 damage per tick)
  skill('SKILL_CH_FIRE_GIGONGTA_A_01', { kind: 'imbue', category: 'buff', mastery: 'FIRE', masteryLevel: 1, mp: 50, instant: true, cooldownMs: 5000, durationMs: 5000, overlap: 1, damage: att(0, [30, 30], 1, 100), statuses: [{ status: 'burn', level: 30, chancePct: 100, extra: [5] }] }),
  // Force (Water): heal another player, resurrect a corpse
  skill('SKILL_CH_WATER_HEAL_A_01', { kind: 'heal', category: 'buff', mastery: 'FORCE', masteryLevel: 1, mp: 70, preparingMs: 1000, castMs: 1000, actionMs: 1000, cooldownMs: 3000, range: 15, targets: friend, heal: { hp: 300, hpPct: 0, mp: 0, mpPct: 0 } }),
  skill('SKILL_CH_WATER_RESURRECTION_A_01', { kind: 'resurrect', category: 'buff', mastery: 'FORCE', masteryLevel: 1, mp: 100, preparingMs: 1000, castMs: 2000, actionMs: 1000, cooldownMs: 4000, range: 15, targets: { required: true, groups: ['ally', 'party'], deadBody: true }, heal: { hp: 0, hpPct: 10, mp: 0, mpPct: 10 } }),
]

export const MASTERIES: MasteryDef[] = (['BICHEON', 'HEUKSAL', 'PACHEON', 'COLD', 'LIGHTNING', 'FIRE', 'FORCE'] as const).map((code, i) => ({
  code,
  id: 257 + i,
  name: code,
  race: 'china',
  weapons: [],
  skills: SKILLS.filter((s) => s.mastery === code).map((s) => s.code),
}))

/** SP per mastery level (docs/SKILLS.md §1.2 table, first levels). */
export const SKILL_LEVELS: LevelDef[] = [1, 1, 1, 2, 2, 4, 5, 6, 7, 9].map((masterySp, i) => ({ level: i + 1, exp: 100 * (i + 1), masterySp }))

/** A sturdy test dummy: never dies by accident, never dodges much. */
export const DUMMY: MobDef = mob('MOB_CH_DUMMY', { name: 'Dummy', level: 1, hp: 100_000, physDefence: 0, magDefence: 0, parryRate: 0, walkSpeed: 0, runSpeed: 0 })

export const SKILL_ITEMS: ItemDef[] = [
  ...ITEMS.filter((i) => i.code !== 'ITEM_CH_SHIELD_01_A'),
  item('ITEM_CH_SHIELD_01_A', { category: 'shield', slot: 'shield', typeId: [3, 1, 4, 1], reqLevel: 1, race: 'china', stats: { blockRate: [0, 0], physDefence: [10, 10] } }),
  item('ITEM_ETC_AMMO_ARROW_01', { category: 'ammo', typeId: [3, 3, 4, 1], maxStack: 250 }),
]

export const SAFE_TOWN: TownDef = { code: 'TOWN', name: 'Town', world: 'jangan', spawn: { x: 200, y: 0, z: 200 }, safeArea: { x: 200, z: 200, halfX: 10, halfZ: 10 } }

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

/**
 * A Gameplay on a flat 1 km world with the synthetic skills, a constant rng (every hit lands as a plain hit, every
 * 100 % status sticks) and helpers to make characters and dummies. Time is driven by hand (`tick(now)`).
 */
export function skillHarness(opts: { rng?: () => number; skillAmmo?: number; data?: GameData; book?: SkillBook; /** Extra config (wave 11: e.g. `uniques: false`). */ config?: Partial<ServerConfig>; /** The world's straight-walk rule (default: the flat world's; Play the Boss tests put a wall in it). */ move?: (from: Vec3, to: Vec3) => Vec3 | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sro-skills-'))
  const logs: string[] = []
  const rng = opts.rng ?? (() => 0.5)
  const config: ServerConfig = { ...testConfig(root, logs), rng, skillAmmo: opts.skillAmmo ?? 0, ...opts.config }
  const store = openStore(config.dataDir)
  const bounds = { minX: -500, minZ: -500, maxX: 500, maxZ: 500 }
  const nav = new FlatNav(bounds)
  const world = new World('jangan', 5, 20, bounds, opts.move ?? ((f, t) => nav.moveStraight(f, t)))
  const data = opts.data ?? new GameData({ mobs: [DUMMY], items: SKILL_ITEMS, levels: SKILL_LEVELS, towns: [SAFE_TOWN] })
  const setup: WorldSetup = { spawn: { x: 0, y: 0, z: 0 }, spawnSource: 'test', bounds, displayName: 'Test', regionOrigin: null, places: [] }
  const gameplay = new Gameplay({ world, data, store, config, setup, nav, rng })
  gameplay.skills.book = opts.book ?? new SkillBook(SKILLS, MASTERIES)
  let n = 0
  const T0 = 1_000_000
  let clock = T0

  /** A character in the world (starter weapon equipped, `extra` items worn), entered (skills sent). */
  const hero = (o: { pos?: Vec3; weapon?: 'sword' | 'spear' | 'bow' | 'blade'; level?: number; sp?: number; wear?: string[]; name?: string; characterId?: number } = {}) => {
    let id = o.characterId
    if (id === undefined) {
      const acc = store.createAccount(`acc${++n}`, 'x')!
      const row = store.createCharacter(acc, o.name ?? `Hero${n}`, 'CHAR_CH_MAN_ADVENTURER', o.weapon ?? 'sword', 'jangan', 4)
      if (typeof row === 'string') throw new Error(row)
      id = row.id
      gameplay.grantStarterKit(id, o.weapon ?? 'sword', row.model)
      for (const code of o.wear ?? []) {
        const def = data.item(code)!
        store.inventoryTx(id, (d) => {
          d.setEquip(def.slot === 'ring' ? 'ring1' : def.slot!, { code, count: 1, plus: 0, durability: null })
          return { ok: true, value: null }
        })
      }
      if (o.level || o.sp) {
        const r = store.characterById(id)!
        store.saveProgress(id, { level: o.level ?? r.level, exp: 0, sp: o.sp ?? 0, spExp: 0, str: 20 + (o.level ?? 1) - 1, int: 20 + (o.level ?? 1) - 1, statPoints: 0 })
      }
    }
    const row = store.characterById(id)!
    const inbox: ServerMessage[] = []
    const p = world.add({ ...gameplay.playerInit(row), characterId: id, name: row.name, model: row.model, level: row.level, weapon: row.weapon, pos: o.pos ?? [0, 0, 0], yaw: 0, send: (m) => inbox.push(m) })
    const seen = world.snapshotFor(p, clock)
    gameplay.sendEnter(p, clock)
    return { p, inbox, id, seen }
  }

  const dummy = (x: number, z: number, over: Partial<MobDef> = {}) => gameplay.createMob({ ...DUMMY, ...over }, 'normal', x, z, 0, null, clock)

  const req = (p: Player, msg: Extract<ClientMessage, { t: GameplayRequest }>, at = clock) => gameplay.request(p, msg, at)
  const result = (inbox: ServerMessage[], re: GameplayRequest) => inbox.filter((m): m is Msg<'actionResult'> => m.t === 'actionResult' && m.re === re).at(-1)
  const all = <T extends ServerMessage['t']>(inbox: ServerMessage[], t: T) => inbox.filter((m): m is Msg<T> => m.t === t)
  /** Advances the clock to `to` in 50 ms ticks (the 20 Hz server tick). */
  const runTo = (to: number) => {
    while (clock < to) {
      clock = Math.min(to, clock + 50)
      world.tick(clock)
    }
  }
  const learn = (p: Player, codes: string[], mastery = 10) => {
    const masteries = Object.fromEntries(MASTERIES.map((m) => [m.code, mastery]))
    gameplay.skills.gmSet(p, masteries, codes.map((c) => {
      const s = SKILLS.find((x) => x.code === c)!
      return [s.group!, s.skillLevel]
    }), clock)
  }
  const cleanup = () => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
  return {
    store, world, gameplay, data, config, logs, hero, dummy, req, result, all, runTo, learn, cleanup,
    get now() {
      return clock
    },
    set now(v: number) {
      clock = v
    },
    T0,
  }
}
