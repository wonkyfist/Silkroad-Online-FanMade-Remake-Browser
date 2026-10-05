/**
 * Skills client (docs/SKILLS.md §10.3; docs/WAVE_PLAN.md §4.4 SK-C): the SkillCatalog and SkillState, the hotbar
 * rules, the ActionPlayer timeline on a fake clock and actor, the effect book, the fx index helpers, the kept clips,
 * and every message the lane builds against the server's strict parser. DOM-free.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HOTBAR_SLOTS, parseClientMessage, type ClientMessage, type EffectState, type HotbarEntry, type ItemDef, type ItemStack, type LevelDef, type MasteryDef, type SkillDef } from '@sro/shared'
import { fallbackGroup, formatDuration, formatShort, SkillCatalog, SkillState } from '../src/content/skills.ts'
import { EffectBook, isHarmful, targetIcons } from '../src/hud/buffs.ts'
import { CooldownClock, itemCooldownKey, skillCooldownKey } from '../src/hud/cooldowns.ts'
import { bagIndexOf, HOTBAR_KEYS, HOTBAR_PAGE_KEYS, HOTBAR_PAGES, hotbarDrop, hotbarItemAllowed, hotbarSlot, resolveSlot, skillTarget, slotMessage, type HotbarContext } from '../src/hud/hotbar-model.ts'
import { intent } from '../src/hud/intents.ts'
import { KEEP_CLIPS } from '../src/three/models.ts'
import { parseMove, parseOffset, readFxSkills, stageRoll } from '../src/world/skill-fx.ts'
import { ActionPlayer, planPhases, type ActionPort, type CastMessage, type ClipFacts, type PhasePlan, type SkillCombat } from '../src/world/skills-view.ts'

/** The message must survive the server's strict frame parser unchanged. */
function valid<T extends ClientMessage>(msg: T | null | 'need_target'): T {
  if (msg === null || msg === 'need_target') throw new Error(`expected a message, got ${msg}`)
  const parsed = parseClientMessage(JSON.stringify(msg))
  if (!parsed.ok) throw new Error(`${JSON.stringify(msg)} rejected: ${parsed.error}`)
  expect(parsed.msg).toEqual(msg)
  return msg
}

// ---- fixture: skills.json rows as the exporter writes them (docs/SKILLS.md §2.1, §3.2) ------------------------

const sword = ['sword', 'blade'] as SkillDef['weapons']
const enemy = { required: true, groups: ['enemy_mob', 'enemy_player'] } as SkillDef['targets']

function smash(level: number, masteryLevel: number, mp: number): SkillDef {
  return {
    code: `SKILL_CH_SWORD_SMASH_A_0${level}`, id: 3 + level, name: 'Strike Smash', mastery: 'BICHEON', masteryLevel, skillLevel: level, sp: level * 2, mp,
    category: 'melee', castMs: 411, actionMs: 1022, cooldownMs: 3000, range: 0, weapons: sword, icon: '/out/icon/skill/china/sword_smash_a.png',
    group: 'SKILL_CH_SWORD_SMASH_A', animation: { shot: 'SKILL_1' }, damage: { physPct: 143, magPct: 0, flat: [15, 18], hits: 1 }, kind: 'attack',
    targets: enemy, description: 'Swing your sword to inflict great damage to the enemy.', ui: { tab: 'weapon', page: 0, column: 0, row: 0 },
    aniGroup: 'SWORD', hitCues: [{ phase: 'SHOT', event: 1 }], autoAttack: 1,
  }
}

function chain(seg: number, next?: string): SkillDef {
  const actions = [428, 612, 993]
  return {
    code: `SKILL_CH_SWORD_CHAIN_A_${seg}S_01`, id: 5 + seg, name: 'Illusion Chain', mastery: 'BICHEON', masteryLevel: 7, skillLevel: 1, sp: seg === 1 ? 5 : 0, mp: seg === 1 ? 32 : 0,
    category: 'melee', castMs: 0, actionMs: actions[seg - 1]!, cooldownMs: seg === 1 ? 8000 : 0, range: 0, weapons: sword, icon: '/out/icon/skill/china/sword_chain_a.png',
    group: 'SKILL_CH_SWORD_CHAIN_A', ...(next ? { chainNext: next } : {}), animation: { shot: 'SKILL_2' }, damage: { physPct: [30, 53, 120][seg - 1]!, magPct: 0, flat: [18, 22], hits: 1 },
    kind: 'attack', targets: enemy, ...(seg === 1 ? { ui: { tab: 'weapon', page: 0, column: 1, row: 0 } as const } : {}), aniGroup: 'SWORD',
    hitCues: [{ phase: 'SHOT', event: seg }], chainRoot: 'SKILL_CH_SWORD_CHAIN_A_1S_01', chainIndex: seg,
  }
}

const GANGGI: SkillDef = {
  code: 'SKILL_CH_COLD_GANGGI_A_01', id: 93, name: 'Weak Guard of Ice', mastery: 'COLD', masteryLevel: 8, skillLevel: 1, sp: 6, mp: 72, category: 'buff',
  castMs: 1000, actionMs: 1000, cooldownMs: 2000, range: 0, weapons: [], icon: '/out/icon/skill/china/cold_ganggi_a.png', group: 'SKILL_CH_COLD_GANGGI_A',
  animation: { ready: 'READY04', wait: 'WAIT04', shot: 'SKILL_4' }, preparingMs: 1000, kind: 'buff', targets: { required: false, groups: [] },
  ui: { tab: 'force', page: 0, column: 1, row: 0 }, aniGroup: 'DEFAULT', durationMs: 335294, overlap: 2,
}

const HEAL: SkillDef = {
  code: 'SKILL_CH_WATER_HEAL_A_01', id: 150, name: 'Heal - Medical Hand', mastery: 'FORCE', masteryLevel: 12, skillLevel: 1, sp: 10, mp: 74, category: 'buff',
  castMs: 1000, actionMs: 1000, cooldownMs: 3000, range: 15, weapons: [], icon: null, group: 'SKILL_CH_WATER_HEAL_A',
  animation: { ready: 'READY01', wait: 'WAIT01', shot: 'SKILL_1' }, preparingMs: 1000, kind: 'heal', targets: { required: true, groups: ['self', 'ally', 'party'] },
  ui: { tab: 'force', page: 3, column: 3, row: 0 }, aniGroup: 'DEFAULT', heal: { hp: 120, hpPct: 0, mp: 0, mpPct: 0 },
}

const GEOMGI: SkillDef = {
  code: 'SKILL_CH_SWORD_GEOMGI_A_01', id: 30, name: 'Soul Cut Blade', mastery: 'BICHEON', masteryLevel: 14, skillLevel: 1, sp: 20, mp: 34, category: 'ranged',
  castMs: 341, actionMs: 792, cooldownMs: 4000, range: 12, weapons: sword, icon: null, group: 'SKILL_CH_SWORD_GEOMGI_A', animation: { shot: 'SKILL_5' },
  damage: { physPct: 200, magPct: 0, flat: [30, 40], hits: 1 }, kind: 'attack', targets: enemy, ui: { tab: 'weapon', page: 0, column: 3, row: 0 }, aniGroup: 'SWORD',
  hitCues: [{ phase: 'SHOT', event: 2, projectile: { move: 'MOV_STRAIGHT', delayMs: 0, speed: 300 } }],
}

const IMBUE: SkillDef = {
  code: 'SKILL_CH_COLD_GIGONGTA_A_01', id: 90, name: 'Ice River Force', mastery: 'COLD', masteryLevel: 5, skillLevel: 1, sp: 2, mp: 52, category: 'buff',
  castMs: 0, actionMs: 0, cooldownMs: 5000, range: 0, weapons: [], icon: null, group: 'SKILL_CH_COLD_GIGONGTA_A', kind: 'imbue', instant: true,
  targets: { required: false, groups: [] }, ui: { tab: 'force', page: 0, column: 0, row: 0 }, durationMs: 5000,
  statuses: [{ status: 'freeze', level: 1, chancePct: 5 }, { status: 'frostbite', level: 1, chancePct: 25 }],
}

const SKILLS: SkillDef[] = [smash(1, 5, 19), smash(2, 7, 22), smash(3, 9, 26), chain(1, 'SKILL_CH_SWORD_CHAIN_A_2S_01'), chain(2, 'SKILL_CH_SWORD_CHAIN_A_3S_01'), chain(3), GANGGI, HEAL, GEOMGI, IMBUE]

const MASTERIES: MasteryDef[] = [
  { code: 'BICHEON', id: 257, name: 'Bicheon', race: 'china', weapons: ['sword', 'blade'], skills: [], tab: 'weapon', page: 0, lines: 9 },
  { code: 'COLD', id: 273, name: 'Cold', race: 'china', weapons: [], skills: [], tab: 'force', page: 0, lines: 8 },
  { code: 'FORCE', id: 276, name: 'Force', race: 'china', weapons: [], skills: [], tab: 'force', page: 3, lines: 8 },
]

const SP_TABLE = [1, 1, 1, 2, 2, 4, 5, 6, 7, 9, 12, 15, 18, 21, 24, 30, 35, 41, 47, 53]
const LEVELS: LevelDef[] = SP_TABLE.map((masterySp, i) => ({ level: i + 1, exp: 100, masterySp }))

const catalog = () => new SkillCatalog(SKILLS, MASTERIES, LEVELS)

function snapshot(state: SkillState, masteries: Partial<Record<string, number>>, skills: string[], hotbar: (HotbarEntry | null)[] = []): void {
  state.applySnapshot({ t: 'skills', masteries: { BICHEON: 0, HEUKSAL: 0, PACHEON: 0, COLD: 0, LIGHTNING: 0, FIRE: 0, FORCE: 0, ...masteries }, skills, hotbar: Array.from({ length: HOTBAR_SLOTS }, (_, i) => hotbar[i] ?? null) })
}

describe('SkillCatalog', () => {
  it('groups rows, finds the next row and the chain', () => {
    const c = catalog()
    expect(c.rows('SKILL_CH_SWORD_SMASH_A').map(r => r.skillLevel)).toEqual([1, 2, 3])
    // Chain segments after the first are not learnable rows of their own.
    expect(c.rows('SKILL_CH_SWORD_CHAIN_A').map(r => r.code)).toEqual(['SKILL_CH_SWORD_CHAIN_A_1S_01'])
    expect(c.chain('SKILL_CH_SWORD_CHAIN_A_1S_01').map(r => r.chainIndex)).toEqual([1, 2, 3])
    expect(c.nextRow('SKILL_CH_SWORD_SMASH_A', 0)?.code).toBe('SKILL_CH_SWORD_SMASH_A_01')
    expect(c.nextRow('SKILL_CH_SWORD_SMASH_A', 2)?.code).toBe('SKILL_CH_SWORD_SMASH_A_03')
    expect(c.nextRow('SKILL_CH_SWORD_SMASH_A', 3)).toBeNull()
    expect(c.maxLevel('SKILL_CH_SWORD_SMASH_A')).toBe(3)
    expect(c.maxLearnable('SKILL_CH_SWORD_SMASH_A', 7)).toBe(2)
    expect(c.maxLearnable('SKILL_CH_SWORD_SMASH_A', 4)).toBe(0)
    expect(c.groupOf('SKILL_CH_SWORD_CHAIN_A_3S_01')).toBe('SKILL_CH_SWORD_CHAIN_A')
    expect(fallbackGroup('SKILL_CH_SPEAR_PIERCE_A_04')).toBe('SKILL_CH_SPEAR_PIERCE_A')
    expect(fallbackGroup('SKILL_CH_SWORD_CHAIN_A_2S_05')).toBe('SKILL_CH_SWORD_CHAIN_A')
  })

  it('lays out pages by tab and lines by column', () => {
    const c = catalog()
    expect(c.masteries('weapon').map(m => m.code)).toEqual(['BICHEON'])
    expect(c.masteries('force').map(m => m.code)).toEqual(['COLD', 'FORCE'])
    expect(c.lines('BICHEON').map(l => [l.group, l.column])).toEqual([
      ['SKILL_CH_SWORD_SMASH_A', 0],
      ['SKILL_CH_SWORD_CHAIN_A', 1],
      ['SKILL_CH_SWORD_GEOMGI_A', 3],
    ])
  })

  it('explains why a row or a mastery cannot be learned', () => {
    const c = catalog()
    const s = new SkillState(c)
    snapshot(s, { BICHEON: 5 }, [])
    const r1 = c.nextRow('SKILL_CH_SWORD_SMASH_A', 0)
    expect(c.learnBlock(r1, s, 10)).toBeNull()
    expect(c.learnBlock(r1, s, 1)).toBe('sp')
    expect(c.blockText('sp', r1, 1)).toBe('Not enough skill points (1 / 2).')
    // Level 2 needs Bicheon 7.
    snapshot(s, { BICHEON: 5 }, ['SKILL_CH_SWORD_SMASH_A_01'])
    const r2 = c.nextRow('SKILL_CH_SWORD_SMASH_A', s.level('SKILL_CH_SWORD_SMASH_A'))
    expect(r2?.skillLevel).toBe(2)
    expect(c.learnBlock(r2, s, 99)).toBe('mastery')
    expect(c.blockText('mastery', r2)).toBe('Requires Bicheon mastery level 7.')
    expect(c.learnBlock(null, s, 99)).toBe('max')
    // Masteries: cost from levels.json, capped at the character level.
    expect(c.masteryCost(6)).toBe(4)
    expect(c.masteryBlock('BICHEON', s, 10, 5)).toBe('cap')
    expect(c.masteryBlock('BICHEON', s, 3, 20)).toBe('sp')
    expect(c.masteryBlock('BICHEON', s, 4, 20)).toBeNull()
  })

  it('writes the Strike Smash L1 tooltip numbers (19 MP, 411 / 1022 / 3000)', () => {
    const lines = catalog().tooltip('SKILL_CH_SWORD_SMASH_A_01')
    const text = lines.map(l => l.text)
    expect(lines[0]).toEqual({ text: 'Strike Smash  Lv. 1', cls: 'title' })
    expect(text).toContain('MP consumption: 19')
    expect(text).toContain('Cast time: 0.41 sec')
    expect(text).toContain('Cooldown: 3 sec')
    expect(text).toContain('Damage: Physical 143% + 15 ~ 18')
    expect(text).toContain('Required mastery: Bicheon 5')
    expect(text).toContain('Weapon: Sword, Blade')
    expect(text).toContain('Swing your sword to inflict great damage to the enemy.')
    // Learned: no requirement lines; a block reason is shown in red.
    const learned = catalog().tooltip('SKILL_CH_SWORD_SMASH_A_01', { learned: true, block: 'Not enough MP.' })
    expect(learned.some(l => l.text.startsWith('Required mastery'))).toBe(false)
    expect(learned).toContainEqual({ text: 'Not enough MP.', cls: 'bad' })
  })

  it('shows chains, buffs, imbues and heals in the tooltip', () => {
    const c = catalog()
    const ch = c.tooltip('SKILL_CH_SWORD_CHAIN_A_1S_01').map(l => l.text)
    expect(ch).toContain('Attack 1: Physical 30% + 18 ~ 22')
    expect(ch).toContain('Attack 3: Physical 120% + 18 ~ 22')
    expect(ch).toContain('Cooldown: 8 sec')
    const buff = c.tooltip('SKILL_CH_COLD_GANGGI_A_01').map(l => l.text)
    expect(buff).toContain('Cast time: 2 sec')
    expect(buff).toContain('Duration: 5 min 35 sec')
    const imbue = c.tooltip('SKILL_CH_COLD_GIGONGTA_A_01').map(l => l.text)
    expect(imbue).toContain('Freezing: 5% chance (level 1)')
    expect(imbue.some(l => l.startsWith('Cast time'))).toBe(false)
    expect(c.tooltip('SKILL_CH_WATER_HEAL_A_01').map(l => l.text)).toContain('Restores 120 HP')
    expect(formatDuration(411)).toBe('0.41 sec')
    expect(formatShort(335_294)).toBe('5:36')
    expect(formatShort(9_100)).toBe('10s')
  })
})

describe('SkillState', () => {
  it('applies the snapshot and updates (learned rows by group, masteries, hotbar)', () => {
    const c = catalog()
    const s = new SkillState(c)
    snapshot(s, { BICHEON: 7 }, ['SKILL_CH_SWORD_SMASH_A_02', 'SKILL_CH_SWORD_CHAIN_A_1S_01'], [{ kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' }])
    expect(s.known).toBe(true)
    expect(s.level('SKILL_CH_SWORD_SMASH_A')).toBe(2)
    expect(s.code('SKILL_CH_SWORD_SMASH_A')).toBe('SKILL_CH_SWORD_SMASH_A_02')
    expect(s.isLearned('SKILL_CH_SWORD_CHAIN_A_3S_01')).toBe(true)
    expect(s.hotbar).toHaveLength(HOTBAR_SLOTS)
    const ch = s.applyUpdate({ t: 'skillsUpdate', masteries: { BICHEON: 9 }, learned: ['SKILL_CH_SWORD_SMASH_A_03'], hotbar: [{ slot: 3, entry: { kind: 'item', code: 'ITEM_ETC_HP_POTION_01' } }, { slot: 99, entry: null }] })
    expect(ch).toEqual({ masteries: true, learned: ['SKILL_CH_SWORD_SMASH_A'], hotbar: [3] })
    expect(s.masteries.BICHEON).toBe(9)
    expect(s.level('SKILL_CH_SWORD_SMASH_A')).toBe(3)
    expect(s.hotbar[3]).toEqual({ kind: 'item', code: 'ITEM_ETC_HP_POTION_01' })
  })
})

// ---- hotbar ----------------------------------------------------------------------------------------------

const POTION: ItemDef = {
  code: 'ITEM_ETC_HP_POTION_01', id: 4, name: 'HP Recovery Herb', typeId: [3, 3, 1, 1], category: 'potion', degree: 1, reqLevel: 0, reqGender: 'any', race: 'any',
  maxStack: 50, price: 60, sellPrice: 21, model: null, icon: '/out/icon/item/etc/hp_potion_01.png', use: { hp: 120, cooldownGroup: 'hp', cooldownMs: 1000 },
}
const SWORD_ITEM = { ...POTION, code: 'ITEM_CH_SWORD_01_A', typeId: [3, 1, 6, 2], category: 'weapon', weaponType: 'sword', use: undefined } as ItemDef
const SPEAR_ITEM = { ...SWORD_ITEM, code: 'ITEM_CH_SPEAR_01_A', weaponType: 'spear' } as ItemDef

function hotbarCtx(opts: { bag?: (ItemStack | null)[]; weapon?: string; mp?: number | null; learned?: string[] } = {}): HotbarContext {
  const c = catalog()
  const state = new SkillState(c)
  snapshot(state, { BICHEON: 20 }, opts.learned ?? ['SKILL_CH_SWORD_SMASH_A_02', 'SKILL_CH_WATER_HEAL_A_01'])
  const bag = opts.bag ?? []
  const defs = new Map([POTION, SWORD_ITEM, SPEAR_ITEM].map(d => [d.code, d]))
  return {
    catalog: c,
    state,
    item: code => defs.get(code),
    bagSize: Math.max(bag.length, 8),
    bag: i => bag[i] ?? null,
    equipped: slot => (slot === 'weapon' && opts.weapon ? { code: opts.weapon, count: 1 } : null),
    mp: opts.mp === undefined ? 200 : opts.mp,
    maxMp: 200,
  }
}

describe('hotbar model', () => {
  it('maps pages and keys onto the 40 slots', () => {
    expect(HOTBAR_PAGES).toBe(4)
    expect(HOTBAR_KEYS.join('')).toBe('1234567890')
    expect(HOTBAR_PAGE_KEYS).toEqual(['f1', 'f2', 'f3', 'f4'])
    expect(hotbarSlot(0, 0)).toBe(0)
    expect(hotbarSlot(0, 9)).toBe(9)
    expect(hotbarSlot(2, 4)).toBe(24)
    expect(hotbarSlot(HOTBAR_PAGES - 1, 9)).toBe(HOTBAR_SLOTS - 1)
  })

  it('resolves item entries to the lowest bag slot holding the code, greyed without one (decision 7)', () => {
    const pot = (count: number): ItemStack => ({ code: POTION.code, count })
    const ctx = hotbarCtx({ bag: [null, { code: 'ITEM_CH_SWORD_01_A', count: 1 }, null, pot(5), null, pot(10)] })
    expect(bagIndexOf(ctx, POTION.code)).toBe(3)
    const r = resolveSlot({ kind: 'item', code: POTION.code }, ctx)
    expect(r).toMatchObject({ bag: 3, count: 15, block: null, cooldownKey: itemCooldownKey('hp'), icon: POTION.icon })
    expect(valid(slotMessage(r, undefined, null, 1))).toEqual({ t: 'itemUse', bag: 3 })
    const none = resolveSlot({ kind: 'item', code: POTION.code }, hotbarCtx())
    expect(none.block).toBe('no_item')
    expect(slotMessage(none, undefined, null, 1)).toBeNull()
    expect(hotbarItemAllowed(POTION)).toBe(true)
    expect(hotbarItemAllowed(SWORD_ITEM)).toBe(false)
  })

  it('sends the highest learned row, greyed on MP, weapon or not learned', () => {
    const entry: HotbarEntry = { kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' }
    const ok = resolveSlot(entry, hotbarCtx({ weapon: 'ITEM_CH_SWORD_01_A' }))
    expect(ok).toMatchObject({ code: 'SKILL_CH_SWORD_SMASH_A_02', block: null, cooldownKey: skillCooldownKey('SKILL_CH_SWORD_SMASH_A') })
    expect(resolveSlot(entry, hotbarCtx({ weapon: 'ITEM_CH_SPEAR_01_A' })).block).toBe('weapon')
    expect(resolveSlot(entry, hotbarCtx({})).block).toBe('weapon')
    expect(resolveSlot(entry, hotbarCtx({ weapon: 'ITEM_CH_SWORD_01_A', mp: 21 })).block).toBe('mp')
    expect(resolveSlot(entry, hotbarCtx({ weapon: 'ITEM_CH_SWORD_01_A', mp: null })).block).toBeNull()
    expect(resolveSlot(entry, hotbarCtx({ weapon: 'ITEM_CH_SWORD_01_A', learned: [] })).block).toBe('not_learned')
  })

  it('picks the useSkill target: enemies need a live monster, friendly skills fall back to yourself', () => {
    const c = catalog()
    const mob = { id: 50, kind: 'mob' as const, dead: false }
    expect(skillTarget(c.get('SKILL_CH_SWORD_SMASH_A_01'), mob, 7)).toEqual({ target: 50 })
    expect(skillTarget(c.get('SKILL_CH_SWORD_SMASH_A_01'), null, 7)).toBe('need_target')
    expect(skillTarget(c.get('SKILL_CH_SWORD_SMASH_A_01'), { ...mob, dead: true }, 7)).toBe('need_target')
    expect(skillTarget(c.get('SKILL_CH_WATER_HEAL_A_01'), mob, 7)).toEqual({ target: 7 })
    expect(skillTarget(c.get('SKILL_CH_WATER_HEAL_A_01'), { id: 9, kind: 'player', dead: false }, 7)).toEqual({ target: 9 })
    expect(skillTarget(c.get('SKILL_CH_COLD_GANGGI_A_01'), mob, 7)).toEqual({})
    const ctx = hotbarCtx({ weapon: 'ITEM_CH_SWORD_01_A' })
    const r = resolveSlot({ kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' }, ctx)
    expect(valid(slotMessage(r, c.get(r.code), mob, 7))).toEqual({ t: 'useSkill', skill: 'SKILL_CH_SWORD_SMASH_A_02', target: 50 })
    expect(slotMessage(r, c.get(r.code), null, 7)).toBe('need_target')
    const buff = resolveSlot({ kind: 'skill', code: 'SKILL_CH_COLD_GANGGI_A_01' }, hotbarCtx({ learned: ['SKILL_CH_COLD_GANGGI_A_01'] }))
    expect(valid(slotMessage(buff, c.get(buff.code), mob, 7))).toEqual({ t: 'useSkill', skill: 'SKILL_CH_COLD_GANGGI_A_01' })
  })

  it('moves by swapping two slots and overwrites from outside, with parse-clean hotbarSet frames', () => {
    const bar: (HotbarEntry | null)[] = new Array(HOTBAR_SLOTS).fill(null)
    bar[0] = { kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' }
    bar[5] = { kind: 'item', code: POTION.code }
    const swap = hotbarDrop(bar, bar[0]!, 0, 5)
    expect(swap.map(m => valid(m))).toEqual([
      { t: 'hotbarSet', slot: 5, entry: { kind: 'skill', code: 'SKILL_CH_SWORD_SMASH_A_01' } },
      { t: 'hotbarSet', slot: 0, entry: { kind: 'item', code: POTION.code } },
    ])
    expect(hotbarDrop(bar, bar[0]!, 0, 0)).toEqual([])
    expect(hotbarDrop(bar, { kind: 'item', code: POTION.code }, null, 39).map(m => valid(m))).toEqual([{ t: 'hotbarSet', slot: 39, entry: { kind: 'item', code: POTION.code } }])
    expect(valid(intent.hotbarSet(12, null))).toEqual({ t: 'hotbarSet', slot: 12, entry: null })
    // 40 is MOUSE_SLOT (the mouse quick slot); 41 is past every slot.
    expect(intent.hotbarSet(41, null)).toBeNull()
    expect(valid(intent.skillLearn('SKILL_CH_SWORD_SMASH_A_02'))).toEqual({ t: 'skillLearn', skill: 'SKILL_CH_SWORD_SMASH_A_02' })
    expect(valid(intent.masteryUp('BICHEON'))).toEqual({ t: 'masteryUp', mastery: 'BICHEON' })
    expect(valid(intent.buffCancel('SKILL_CH_COLD_GANGGI_A_01'))).toEqual({ t: 'buffCancel', skill: 'SKILL_CH_COLD_GANGGI_A_01' })
  })

  it('shares the cooldown key names with the clock', () => {
    const clock = new CooldownClock(() => 1000)
    clock.setIn(skillCooldownKey('SKILL_CH_SWORD_SMASH_A'), 3000)
    expect(clock.remaining('skill:SKILL_CH_SWORD_SMASH_A', 2500)).toBe(1500)
    expect(itemCooldownKey('hp')).toBe('item:hp')
  })
})

// ---- ActionPlayer ------------------------------------------------------------------------------------------

/** A fake actor: clip facts per TYPE_NAME, and a log of what it was asked to play. */
class FakePort implements ActionPort {
  plays: { aniGroup: string | undefined; phases: PhasePlan[]; token: number }[] = []
  stopped: number[] = []
  faced: number[] = []
  private serial = 0
  private live = new Set<number>()

  constructor(private readonly clips: Record<string, ClipFacts>) {}

  clip(_g: string | undefined, type: string): ClipFacts | null {
    return this.clips[type] ?? null
  }

  play(aniGroup: string | undefined, phases: readonly PhasePlan[]): number {
    const token = ++this.serial
    this.live = new Set([token])
    this.plays.push({ aniGroup, phases: [...phases], token })
    return token
  }

  stop(token: number): void {
    this.stopped.push(token)
    this.live.delete(token)
  }

  playing(token: number): boolean {
    return this.live.has(token)
  }

  face(id: number): void {
    this.faced.push(id)
  }
}

const cast = (skill: string, instance: number, ms: [number, number, number], extra: Partial<CastMessage> = {}): CastMessage => ({ t: 'cast', id: 1, skill, instance, target: 50, prepareMs: ms[0], castMs: ms[1], actionMs: ms[2], ...extra })
const combat = (skill: string, instance: number, hits = 1, extra: Partial<SkillCombat> = {}): SkillCombat => ({
  t: 'combat', attacker: 1, target: 50, skill, instance, hits: Array.from({ length: hits }, () => ({ damage: 10, outcome: 'hit' as const, hp: 90 })), ...extra,
})

/** Runs `player` to `until` in 10 ms steps, collecting shown hits with their times. */
function run(player: ActionPlayer, from: number, until: number): void {
  for (let t = from; t <= until; t += 10) player.tick(t)
}

describe('ActionPlayer', () => {
  it('plans READY -> WAIT -> SHOT, or SHOT alone for cast + action', () => {
    const c = catalog()
    expect(planPhases(cast(GANGGI.code, 1, [1000, 1000, 1000]), GANGGI, () => null)).toEqual([
      { phase: 'READY', type: 'READY04', ms: 1000, loop: false },
      { phase: 'WAIT', type: 'WAIT04', ms: 1000, loop: true },
      { phase: 'SHOT', type: 'SKILL_4', ms: 1000, loop: false },
    ])
    expect(planPhases(cast('SKILL_CH_SWORD_SMASH_A_01', 1, [0, 411, 1022]), c.get('SKILL_CH_SWORD_SMASH_A_01'), () => null)).toEqual([{ phase: 'SHOT', type: 'SKILL_1', ms: 1433, loop: false }])
    // castMs 1 = "no WAIT" (Self Breathe Heal): READY holds the prepare, SHOT the action.
    const selfHeal = { ...HEAL, animation: { ready: 'READY04', shot: 'SKILL_4' } }
    expect(planPhases({ prepareMs: 1000, castMs: 1, actionMs: 2100 }, selfHeal, () => null)).toEqual([
      { phase: 'READY', type: 'READY04', ms: 1000, loop: false },
      { phase: 'SHOT', type: 'SKILL_4', ms: 2100, loop: false },
    ])
    // A chain head holds its whole clip.
    expect(planPhases(cast(chain(1).code, 1, [0, 0, 428]), chain(1, 'x'), () => ({ durationMs: 2033, hits: [211, 428, 1038] }))).toEqual([{ phase: 'SHOT', type: 'SKILL_2', ms: 2033, loop: false }])
    // Zero-length buffs (Castle Shield) play nothing.
    expect(planPhases({ prepareMs: 0, castMs: 0, actionMs: 0 }, { ...GANGGI, animation: {} }, () => null)).toEqual([])
  })

  it('plays the phases with their durations and faces the target', () => {
    const port = new FakePort({ READY04: { durationMs: 1000, hits: [] }, WAIT04: { durationMs: 2000, hits: [] }, SKILL_4: { durationMs: 1000, hits: [106] } })
    const phases: string[] = []
    const player = new ActionPlayer(catalog(), { onPhase: (_a, p, start) => phases.push(`${p.phase}@${start}`) })
    const a = player.cast(cast(GANGGI.code, 7, [1000, 1000, 1000], { target: 1 }), 0, port)!
    expect(port.plays[0]!.aniGroup).toBe('DEFAULT')
    expect(port.plays[0]!.phases.map(p => [p.type, p.ms, p.loop])).toEqual([['READY04', 1000, false], ['WAIT04', 1000, true], ['SKILL_4', 1000, false]])
    expect(a.release).toBe(2000)
    expect(a.end).toBe(3000)
    expect(port.faced).toEqual([]) // own id: nothing to face
    run(player, 0, 3000)
    expect(phases).toEqual(['READY@0', 'WAIT@1000', 'SHOT@2000'])
    player.cast(cast('SKILL_CH_SWORD_SMASH_A_01', 8, [0, 411, 1022]), 5000, port)
    expect(port.faced).toEqual([50])
  })

  it('shows hit i at hitCues[i] (the N-th hit event of the phase clip)', () => {
    const port = new FakePort({ SKILL_1: { durationMs: 1433, hits: [410] } })
    const player = new ActionPlayer(catalog())
    player.cast(cast('SKILL_CH_SWORD_SMASH_A_01', 11, [0, 411, 1022]), 1000, port)
    const shown: [number, number][] = []
    let now = 1000
    // The combat arrives at the release (server t0 + castMs), a little late.
    expect(player.combat(combat('SKILL_CH_SWORD_SMASH_A_01', 11), 1200, 0, i => shown.push([i, now]))).toBe(true)
    for (now = 1200; now <= 2000; now += 10) player.tick(now)
    expect(shown).toEqual([[0, 1410]])
    // Arriving after its cue, a hit shows at once.
    const late: number[] = []
    player.combat(combat('SKILL_CH_SWORD_SMASH_A_01', 11), 3000, 0, () => late.push(3000))
    player.tick(3000)
    expect(late).toEqual([3000])
    // No instance: the default presentation keeps it.
    expect(player.combat({ ...combat('SKILL_CH_SWORD_BASE_01', 0), instance: undefined }, 0, 0, () => {})).toBe(false)
    // Nor do skills whose cast was never seen, or that have no data (mob skills).
    expect(player.combat(combat('SKILL_CH_SWORD_SMASH_A_01', 999), 0, 0, () => {})).toBe(false)
    expect(player.cast({ ...cast('MSKILL_TIGERWOMAN_01', 12, [0, 1109, 1391]) }, 0, port)).toBeNull()
    expect(player.combat(combat('MSKILL_TIGERWOMAN_01', 12), 0, 0, () => {})).toBe(false)
  })

  it('times multi-hit cues and projectile arrivals (combat.at)', () => {
    const arrows = { ...GEOMGI, code: 'SKILL_CH_BOW_CHAIN_A_01', group: 'SKILL_CH_BOW_CHAIN_A', animation: { shot: 'SKILL_2' }, hitCues: [{ phase: 'SHOT', event: 1 }, { phase: 'SHOT', event: 2 }] }
    const c = new SkillCatalog([...SKILLS, arrows], MASTERIES, LEVELS)
    const port = new FakePort({ SKILL_2: { durationMs: 1166, hits: [440, 790] }, SKILL_5: { durationMs: 1133, hits: [86, 341] } })
    const player = new ActionPlayer(c)
    const a = player.cast(cast(arrows.code, 21, [0, 440, 560]), 0, port)!
    expect(player.hitTimes(a, combat(arrows.code, 21, 2), 440, 0)).toEqual([440, 790])
    // Soul Cut Blade: the server says when the blade lands (server ms -> local ms through the clock offset).
    const b = player.cast(cast(GEOMGI.code, 22, [0, 341, 792]), 10_000, port)!
    expect(player.hitTimes(b, combat(GEOMGI.code, 22, 1, { at: 50_900 }), 10_341, 50_341)).toEqual([10_900])
    // Without `at`, the cue's event 2 of SKILL_5.
    expect(player.hitTimes(b, combat(GEOMGI.code, 22), 10_341, 50_341)).toEqual([10_341])
  })

  it('shows a projectile hit when the client-launched bolt lands: `at` plus the launch lag past the release (I7B)', () => {
    // Cold wave - Arrest: the server lands the bolt `at` counted from the release; the client launches it at the SHOT
    // clip's event 1, 340 ms after the release here, so the hit shows that much later (at most 600 ms).
    const bolt = { ...GEOMGI, code: 'SKILL_CH_COLD_BOLT_A_01', group: 'SKILL_CH_COLD_BOLT_A', animation: { shot: 'SKILL_2' }, hitCues: [{ phase: 'SHOT', event: 1, projectile: { move: '0,300', delayMs: 0, speed: 300 } }] }
    const c = new SkillCatalog([...SKILLS, bolt], MASTERIES, LEVELS)
    const port = new FakePort({ SKILL_2: { durationMs: 1166, hits: [440, 790] } })
    const player = new ActionPlayer(c)
    const a = player.cast(cast(bolt.code, 31, [0, 100, 1066]), 0, port)!
    expect(a.release).toBe(100)
    expect(player.hitTimes(a, combat(bolt.code, 31, 1, { at: 5_400 }), 400, 5_000)).toEqual([800 + 340])
    // A release at (or after) the event: no lag.
    const b = player.cast(cast(bolt.code, 32, [0, 440, 726]), 10_000, port)!
    expect(player.hitTimes(b, combat(bolt.code, 32, 1, { at: 5_400 }), 10_440, 5_000)).toEqual([10_840])
  })

  it('continues a chain without restarting the clip; castEnd stops it', () => {
    const port = new FakePort({ SKILL_2: { durationMs: 2033, hits: [211, 428, 1038] } })
    const ended: string[] = []
    const player = new ActionPlayer(catalog(), { onEnd: (_a, reason) => ended.push(reason) })
    const head = player.cast(cast(chain(1).code, 31, [0, 0, 428]), 0, port)!
    expect(port.plays).toHaveLength(1)
    expect(port.plays[0]!.phases).toEqual([{ phase: 'SHOT', type: 'SKILL_2', ms: 2033, loop: false }])
    const seg2 = player.cast(cast(chain(2).code, 32, [0, 0, 612]), 428, port)
    const seg3 = player.cast(cast(chain(3).code, 33, [0, 0, 993]), 1040, port)
    expect(seg2).toBe(head)
    expect(seg3).toBe(head)
    expect(port.plays).toHaveLength(1)
    // Segment i's damage shows at hit event i of the one clip.
    expect(player.hitTimes(head, combat(chain(2).code, 32), 428, 0)).toEqual([428])
    expect(player.hitTimes(head, combat(chain(3).code, 33), 1040, 0)).toEqual([1038])
    player.castEnd({ t: 'castEnd', id: 1, instance: 33, reason: 'target_lost' }, port)
    expect(port.stopped).toEqual([head.token])
    expect(ended).toEqual(['target_lost'])
    // A new cast after the end starts a new clip.
    player.cast(cast(chain(1).code, 34, [0, 0, 428]), 9000, port)
    expect(port.plays).toHaveLength(2)
  })

  it('leaves instant skills to the effects and replaces a running action', () => {
    const port = new FakePort({ SKILL_1: { durationMs: 1433, hits: [410] } })
    const instants: string[] = []
    const ends: string[] = []
    const player = new ActionPlayer(catalog(), { onInstant: m => instants.push(m.skill), onEnd: (_a, r) => ends.push(r) })
    expect(player.cast(cast(IMBUE.code, 40, [0, 0, 0], { instant: true }), 0, port)).toBeNull()
    expect(instants).toEqual([IMBUE.code])
    expect(port.plays).toHaveLength(0)
    player.cast(cast('SKILL_CH_SWORD_SMASH_A_01', 41, [0, 411, 1022]), 0, port)
    player.cast(cast('SKILL_CH_SWORD_SMASH_A_01', 42, [0, 411, 1022]), 1500, port)
    expect(ends).toEqual(['replaced'])
    player.forget(1)
    expect(ends).toEqual(['replaced', 'gone'])
  })
})

// ---- effects, fx index, clips ----------------------------------------------------------------------

describe('EffectBook', () => {
  it('keeps effects per entity with local end times, harmful ones marked', () => {
    const c = catalog()
    const book = new EffectBook()
    const buff: EffectState = { instance: 1, skill: GANGGI.code, level: 1, remainingMs: 300_000 }
    const stun: EffectState = { instance: 2, status: 'stun', remainingMs: 5000 }
    const toggle: EffectState = { instance: 3, skill: IMBUE.code, remainingMs: 0 }
    book.set(7, [buff, stun], 1000)
    book.add(7, toggle, 2000)
    expect(book.list(7).map(e => [e.effect.instance, e.endsAt])).toEqual([[1, 301_000], [2, 6000], [3, Infinity]])
    expect(book.has(7, 'stun')).toBe(true)
    expect(isHarmful(stun, c)).toBe(true)
    expect(isHarmful(buff, c)).toBe(false)
    const icons = targetIcons(book.list(7), c, 1000)
    expect(icons.map(i => [i.short, i.bad, i.title])).toEqual([
      ['WEA', false, 'Weak Guard of Ice  5:00'],
      ['STU', true, 'Stun  5s'],
      ['ICE', false, 'Ice River Force'],
    ])
    expect(icons[0]!.icon).toBe(GANGGI.icon)
    expect(book.remove(7, 2)?.effect).toEqual(stun)
    expect(book.remove(7, 2)).toBeUndefined()
    expect(book.drop(7)).toHaveLength(2)
    expect(book.ids()).toEqual([])
  })
})

describe('skill fx index', () => {
  it('reads offsets, moves, rolls and the index', () => {
    expect(parseOffset('0,10,-13')).toEqual([0, 1, 1.3])
    expect(parseOffset('')).toEqual([0, 0, 0])
    expect(parseMove('MOV_NONE,0,0,0')).toBeNull()
    expect(parseMove('MOV_STRAIGHT,0,300,300')).toEqual({ delayMs: 0, speed: 30 })
    expect(stageRoll('1035')).toBeCloseTo((315 * Math.PI) / 180)
    expect(stageRoll('0')).toBe(0)
    expect(readFxSkills({ skills: [{ group: 'G', stages: [] }, { nope: 1 }] }).size).toBe(1)
    expect(readFxSkills(null).size).toBe(0)
  })
})

describe('kept clips (three/models.ts, decision 16)', () => {
  it('keeps the skill, prepare and crowd-control clips, not the higher tiers', () => {
    for (const name of ['SKILL_1', 'SKILL_7', 'SKILL_1_skill_ch_sword_smash_a', 'SKILL_2_skill_ch_sword_chain_a', 'SKILL_40_skill_ch_bow_shoot', 'READY04', 'WAIT01_skill_ch_bow_wait', 'READY01_skill_ch_bow_ready', 'DOWN', 'DOWN_RM', 'DOWN_UP', 'STUN', 'ATTACK1_sword_base_01', 'STAND1', 'DIE1']) {
      expect(KEEP_CLIPS.test(name), name).toBe(true)
    }
    for (const name of ['SKILL_8', 'SKILL_100', 'SKILL_8_skill_ch_sword_smash_b', 'SKILL_2_skill_ch_spear_spin_wait', 'EMOTION09']) {
      expect(KEEP_CLIPS.test(name), name).toBe(false)
    }
  })
})

// ---- real data (skipped without the export) ----------------------------------------------------------------

const SKILLS_JSON = 'work/out/data/skills.json'
const MASTERIES_JSON = 'work/out/data/masteries.json'

describe.skipIf(!existsSync(SKILLS_JSON) || !existsSync(MASTERIES_JSON))('SkillCatalog on the real export', () => {
  it('builds every page and resolves the first slice', () => {
    const skills = (JSON.parse(readFileSync(SKILLS_JSON, 'utf8')) as { entries: SkillDef[] }).entries
    const masteries = (JSON.parse(readFileSync(MASTERIES_JSON, 'utf8')) as { entries: MasteryDef[] }).entries
    const c = new SkillCatalog(skills, masteries, LEVELS)
    expect(c.masteries('weapon').map(m => m.code)).toEqual(['BICHEON', 'HEUKSAL', 'PACHEON'])
    expect(c.masteries('force').map(m => m.code)).toEqual(['COLD', 'LIGHTNING', 'FIRE', 'FORCE'])
    for (const m of [...c.masteries('weapon'), ...c.masteries('force')]) expect(c.lines(m.code).length, m.code).toBeGreaterThan(3)
    const text = c.tooltip('SKILL_CH_SWORD_SMASH_A_01').map(l => l.text)
    expect(text).toContain('MP consumption: 19')
    expect(text).toContain('Cast time: 0.41 sec')
    expect(text).toContain('Cooldown: 3 sec')
    expect(c.chain('SKILL_CH_SWORD_CHAIN_A_1S_01')).toHaveLength(3)
    for (const code of ['SKILL_CH_SWORD_GEOMGI_A_01', 'SKILL_CH_COLD_GIGONGTA_A_01', 'SKILL_CH_COLD_GANGGI_A_01', 'SKILL_CH_WATER_HEAL_A_01']) expect(c.get(code), code).toBeTruthy()
    // Every tooltip renders without a missing string key.
    for (const s of skills) for (const l of c.tooltip(s.code)) expect(l.text, s.code).not.toMatch(/skills\.|\{\w+\}/)
  })
})

// ---- the optional ?mock=1 subset (net/mock/skills.ts) --------------------------------------------------

describe('skills mock (?mock=1)', () => {
  it('sends skills after the inventory and answers learning and hotbar requests with parse-clean frames', async () => {
    const { MockServer } = await import('../src/net/mock.ts')
    const { Session } = await import('../src/net/session.ts')
    const { builtinTables, mergeTables } = await import('../src/content/gameplay.ts')
    const { intents } = await import('../src/world/intents.ts')
    const { parseServerMessage } = await import('@sro/shared')
    const store = new Map<string, string>()
    let now = 2_000_000_000
    const server = new MockServer({ getItem: k => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) }, 0, () => now)
    server.content = mergeTables(builtinTables(), {
      skills: { schema: 1, kind: 'skills', generatedAt: '', sources: [], entries: SKILLS },
      masteries: { schema: 1, kind: 'masteries', generatedAt: '', sources: [], entries: MASTERIES },
    })
    server.gmRole = 'gm'
    await server.register({ username: 'skiller', password: 'secret' })
    const { token } = await server.login({ username: 'skiller', password: 'secret' })
    const s = new Session(() => server.wire(), token)
    const log: import('@sro/shared').ServerMessage[] = []
    s.on(m => {
      const back = parseServerMessage(JSON.stringify(m))
      if (!back.ok) throw new Error(`${m.t} does not parse: ${back.error}`)
      log.push(m)
    })
    const flush = async () => {
      for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0))
    }
    await s.connect()
    const { character } = await s.request({ t: 'charCreate', name: 'Skiller', model: 'CHAR_CH_MAN_ADVENTURER', weapon: 'sword' }, ['charCreated'])
    s.send(intents.enterWorld(character.id))
    for (let i = 0; i < 20 && !log.some(m => m.t === 'skills'); i++) {
      now += 100
      server.step()
      await flush()
    }
    const order = log.map(m => m.t)
    expect(order.indexOf('skills')).toBeGreaterThan(order.indexOf('inventory'))
    const send = async (msg: ClientMessage | null) => {
      const from = log.length
      s.send(valid(msg as ClientMessage))
      await flush()
      return log.slice(from)
    }
    const result = (msgs: import('@sro/shared').ServerMessage[]) => msgs.find(m => m.t === 'actionResult') as Extract<import('@sro/shared').ServerMessage, { t: 'actionResult' }>
    expect(result(await send(intent.masteryUp('BICHEON')))).toMatchObject({ ok: false, reason: 'no_sp' })
    await send(intents.chat('/sp 50'))
    const up = await send(intent.masteryUp('BICHEON'))
    expect(result(up).ok).toBe(true)
    expect(up).toContainEqual({ t: 'skillsUpdate', masteries: { BICHEON: 1 } })
    expect(result(await send(intent.masteryUp('BICHEON')))).toMatchObject({ ok: false, reason: 'mastery_cap' })
    const set = await send(intent.hotbarSet(2, { kind: 'item', code: 'ITEM_ETC_HP_POTION_01' }))
    expect(result(set).ok).toBe(true)
    expect(set).toContainEqual({ t: 'skillsUpdate', hotbar: [{ slot: 2, entry: { kind: 'item', code: 'ITEM_ETC_HP_POTION_01' } }] })
    expect(result(await send(intent.useSkill('SKILL_CH_SWORD_SMASH_A_01', 1)))).toMatchObject({ ok: false, reason: 'not_learned' })
  })
})
