/**
 * Play the Boss tests' world (docs/PLAY_THE_BOSS.md §7): the skills harness (a flat 1 km world, a hand-driven clock,
 * every hit a plain hit) with Tiger Girl's retail rows and numbers, her White Tigers, two camps, the town's safe area,
 * a `palace-steps` place inside it, and a copy of the shipped content/uniques.json (with its `pilot` block).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientMessage, GameplayRequest, MobDef, NestDef, ServerMessage, SkillDef, UniquesFile, Vec3 } from '@sro/shared'
import { REPO_ROOT } from '../src/config.ts'
import { GameData } from '../src/gamedata.ts'
import { SkillBook } from '../src/skills/book.ts'
import type { Mob, Player } from '../src/world.ts'
import { item, mob, nest } from './fixtures.ts'
import { MASTERIES, SAFE_TOWN, SKILLS, SKILL_ITEMS, SKILL_LEVELS, skillHarness } from './skills-fixtures.ts'

export const TG = 'MOB_CH_TIGERWOMAN'
export const REAL_FILE = JSON.parse(readFileSync(join(REPO_ROOT, 'content/uniques.json'), 'utf8')) as UniquesFile

const enemy = { required: true, groups: ['enemy_mob', 'enemy_player'] } as SkillDef['targets']
function mrow(code: string, o: Partial<SkillDef>): SkillDef {
  return {
    code, id: 1, name: null, mastery: null, masteryLevel: 0, skillLevel: 1, sp: 0, mp: 0, category: 'melee', castMs: 0, actionMs: 0, cooldownMs: 0,
    range: 0, weapons: [], icon: null, group: code, kind: 'attack', targets: enemy, aniGroup: 'DEFAULT', mob: true, aiChance: 100, ...o,
  } as SkillDef
}
/** Her retail rows (work/out/data/skills.json, vSRO 1.188). */
export const TG_ROWS: SkillDef[] = [
  mrow('MSKILL_CH_TIGERWOMAN_ATTACK01', { range: 2.8, castMs: 1109, actionMs: 1391, cooldownMs: 3000, aiChance: 100, damage: { physPct: 100, magPct: 0, flat: [181, 217], hits: 2 } }),
  mrow('MSKILL_CH_TIGERWOMAN_ATTACK02', {
    range: 2.8, castMs: 0, actionMs: 4000, cooldownMs: 4500, aiChance: 30, damage: { physPct: 300, magPct: 0, flat: [281, 321], hits: 1 },
    area: { shape: 'caster', distance: 4, maxTargets: 5, reductionPct: 0, targetMask: 24, raw: [1, 1, 40, 5, 0, 24] },
  } as Partial<SkillDef>),
  mrow('MSKILL_CH_TIGERWOMAN_ATTACK03', {
    range: 15, castMs: 3003, actionMs: 1997, cooldownMs: 5500, aiChance: 10, category: 'ranged', damage: { physPct: 0, magPct: 367, flat: [281, 321], hits: 1 },
    statuses: [{ status: 'zombie', level: 72, chancePct: 100 }],
  }),
  ...([80, 60, 40] as const).map((band, i) =>
    mrow(`MSKILL_CH_TIGERWOMAN_SUMMON0${i + 1}`, {
      kind: 'buff', category: 'buff', cooldownMs: 500, aiChance: band, targets: { required: false, groups: [] },
      summon: [{ mob: 'MOB_CH_WHITETIGER', rarity: 0, min: 3, max: 6 }],
    }),
  ),
]
export const MOBS: MobDef[] = [
  mob(TG, {
    name: 'Tiger Girl', level: 20, rarity: 'unique', hp: 598_720, exp: 451_200, spExp: 451_200, physAttack: [181, 217], attackRange: 2.8, attackIntervalMs: 3000,
    radius: 2.8, aggressive: true, runSpeed: 9, walkSpeed: 2, skills: TG_ROWS.map((r) => r.code),
  }),
  mob('MOB_CH_WHITETIGER', { name: 'White Tiger', level: 18, attackRange: 0.9, radius: 1.2, runSpeed: 7.5, walkSpeed: 1.6, hp: 809 }),
]
const tactics = { id: 9, aggressive: true, sightRange: 14, leashRange: 50 }
const camp = (id: number, x: number, z: number) => nest(id, TG, x, z, { uniqueGroup: TG, respawnSec: [10_800, 21_600], radius: 100, spawnRadius: 60, tactics })
/** Two camps; the town's safe area (SAFE_TOWN, 200,200 ±10) lies 300 m from camp 5903, inside her 350 m hunt circle. */
export const CAMPS: NestDef[] = [camp(5903, 0, 0), camp(5904, -300, -300)]
/** Her table's loot (content/uniques.json checks every entry against the items). */
const LOOT = [
  ...['WEAPON', 'ARMOR', 'SHIELD', 'ACCESSARY'].map((k) => item(`ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_${k}_A`, { category: 'alchemy' })),
  item('ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_03', { category: 'alchemy', maxStack: 50 }),
  item('ITEM_ETC_HP_POTION_04', { category: 'potion', maxStack: 50 }),
  item('ITEM_ETC_MP_POTION_04', { category: 'potion', maxStack: 50 }),
]
/** The trance place: inside the town's safe area. */
export const PALACE = { x: 200, z: 205 }

type Msg<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

export interface PilotHarnessOpts {
  /** A wall at x = wallX (any straight walk across it stops 5 cm short). */
  wallX?: number
  file?: (f: UniquesFile) => void
  keep?: boolean
}

export function pilotHarness(o: PilotHarnessOpts = {}) {
  const cleanups: (() => void)[] = []
  const content = mkdtempSync(join(tmpdir(), 'sro-pilot-content-'))
  cleanups.push(() => rmSync(content, { recursive: true, force: true }))
  const file = structuredClone(REAL_FILE)
  o.file?.(file)
  writeFileSync(join(content, 'uniques.json'), JSON.stringify(file))
  const data = new GameData({ mobs: MOBS, items: [...SKILL_ITEMS, ...LOOT], levels: SKILL_LEVELS, towns: [SAFE_TOWN], nests: CAMPS.map((n) => ({ ...n })) })
  const W = o.wallX
  const move =
    W === undefined
      ? undefined
      : (from: Vec3, to: Vec3): Vec3 | null => {
          if (Math.abs(to[0]) > 500 || Math.abs(to[2]) > 500) return null
          if ((from[0] < W) === (to[0] < W)) return [to[0], from[1], to[2]]
          const f = (W - (from[0] < W ? 0.05 : -0.05) - from[0]) / (to[0] - from[0])
          return [from[0] + (to[0] - from[0]) * f, from[1], from[2] + (to[2] - from[2]) * f]
        }
  const h = skillHarness({ data, book: new SkillBook([...SKILLS, ...TG_ROWS], MASTERIES), config: { contentDir: content }, ...(move ? { move } : {}) })
  cleanups.push(h.cleanup)
  ;(h.gameplay.setup as { places: unknown[] }).places = [{ name: 'palace-steps', group: 'town', x: PALACE.x, z: PALACE.z }]
  h.gameplay.start(h.now)
  const g = h.gameplay
  const pilot = g.pilot!
  /** Spawns her now at camp 5903 (a GM spawn). */
  const spawn = (): Mob => {
    const r = g.uniques!.gm(null, ['spawn', 'tiger', 'camp', '5903'], h.now)
    if (!r.ok) throw new Error(r.message)
    return her()!
  }
  const her = (): Mob | undefined => [...h.world.mobs.values()].find((m) => m.def.code === TG && m.ai !== 'dead')
  /** A level-20 character with plenty of HP at x/z. */
  const player = (x: number, z: number, name?: string, hp = 1_000_000) => {
    const r = h.hero({ pos: [x, 0, z], level: 20, ...(name ? { name } : {}) })
    r.p.maxHp = r.p.hp = hp
    return r
  }
  const gm = (...args: string[]) => g.uniques!.gm(null, ['pilot', ...args], h.now)
  const req = (p: Player, msg: ClientMessage) => g.request(p, msg as Extract<ClientMessage, { t: GameplayRequest }>, h.now)
  const result = (inbox: ServerMessage[], re: GameplayRequest) => h.result(inbox, re)
  const last = <T extends ServerMessage['t']>(inbox: ServerMessage[], t: T): Msg<T> | undefined => h.all(inbox, t).at(-1) as Msg<T> | undefined
  /** The pilot's moveTo (connection.ts calls steer first). */
  const moveTo = (p: Player, x: number, z: number) => {
    if (!pilot.steer(p, x, z, h.now) && g.onMoveTo(p, h.now)) h.world.moveTo(p, x, z, h.now)
  }
  const tick = (ms: number) => h.runTo(h.now + ms)
  const cleanup = () => {
    while (cleanups.length) cleanups.pop()!()
  }
  return { h, g, pilot, spawn, her, player, gm, req, result, last, moveTo, tick, cleanup }
}

export type PilotHarness = ReturnType<typeof pilotHarness>
