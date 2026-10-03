/**
 * Checks a finished effects export against docs/EFFECTS.md §6.2 (lane FX-X): work/out/fx/skills.json v2 from
 * `pnpm tsx packages/convert/src/tools/export-fx.ts`, and the model sidecars from `pnpm sro convert --preset fx` (plus
 * the mobs, NPCs and equipment re-converted with particles and dummies). Skips when work/out/fx/skills.json is
 * missing; the v1 byte-equality check also needs sro.config.json (it rebuilds v1 from Media.pk2).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildStringMap, decodeTextdata, loadTextdataTable, skillDataRow, skillDetail } from '@sro/formats'
import { textdataReader, TEXTDATA_DIR } from '../src/data/textdata-source.ts'
import { buildSkillIndex, type FxSkillIndexV2, type SkillEffectStage, type SkillRowLite } from '../src/fx/skills.ts'
import type { ModelParticle } from '../src/fx/model-fx.ts'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'

const OUT = join(REPO_ROOT, 'work', 'out')
const INDEX = join(OUT, 'fx', 'skills.json')
const HAS = existsSync(INDEX)
const HAS_CONFIG = existsSync(join(REPO_ROOT, 'sro.config.json'))
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T
/** A /out/... or out-root-relative URL -> the file under work/out. */
const outFile = (url: string) => join(OUT, ...url.replace(/^\/?out\//, '').replace(/^\//, '').split('/'))
const LEVEL_CAP = 20

interface ModelSidecar {
  particles?: ModelParticle[]
  dummies?: Record<string, [number, number, number]>
}

describe.skipIf(!HAS)('work/out/fx/skills.json v2', () => {
  const idx = HAS ? readJson<FxSkillIndexV2>(INDEX) : (null as unknown as FxSkillIndexV2)
  const g = (group: string) => {
    const s = idx.skills.find(x => x.group === group)
    expect(s, group).toBeDefined()
    return s!
  }

  it('is version 2 and stays readable by a v1 reader', () => {
    expect(idx.format).toBe('sro-fx-skills')
    expect(idx.version).toBe(2)
    expect(idx.skills.every(s => typeof s.group === 'string' && Array.isArray(s.stages))).toBe(true)
    expect(new Set(idx.skills.map(s => s.group)).size).toBe(idx.skills.length)
  })

  it.skipIf(!HAS_CONFIG)('keeps every v1 group and its stages byte-equal', () => {
    const media = openArchive('Media')
    const read = textdataReader(media)
    const rows: SkillRowLite[] = loadTextdataTable('skilldata.txt', read).rows.map(r => {
      const row = skillDataRow(r)
      const d = skillDetail(row)
      return { group: row.group, code: row.code, level: row.level, mastery: d.masteries[0], masteryLevel: d.masteryLevels[0], nameKey: d.nameStrId ?? null }
    })
    const strings = buildStringMap(['textuisystem.txt', 'textdataname.txt'].flatMap(t => loadTextdataTable(t, read).rows), 'english')
    const text = decodeTextdata(media.read(media.get(`${TEXTDATA_DIR}/skilleffect.txt`)!)).text
    const v1 = buildSkillIndex(rows, text, strings, k => !!idx.effects[k]?.url)
    expect(v1.skills.length).toBeGreaterThan(200)
    const stageKeys = Object.keys(v1.skills.find(s => s.stages.length)!.stages[0]!) as Array<keyof SkillEffectStage>
    for (const s1 of v1.skills) {
      const s2 = g(s1.group)
      expect(s2.kind).toBe('player')
      const { stages, ...rest } = s1
      const rest2 = Object.fromEntries(Object.keys(rest).map(k => [k, (s2 as unknown as Record<string, unknown>)[k]]))
      expect(JSON.stringify(rest2), s1.group).toBe(JSON.stringify(rest))
      expect(JSON.stringify(s2.stages.map(st => Object.fromEntries(stageKeys.map(k => [k, st[k]])))), s1.group).toBe(JSON.stringify(stages))
    }
    expect(v1.skills.filter(s => s.masteryLevel <= LEVEL_CAP).length).toBeGreaterThanOrEqual(34)
  })

  it('carries the aniset columns (trail, hide weapon, priority, light, twist)', () => {
    expect(g('SKILL_CH_SWORD_SMASH_A').trail).toEqual({ lengthMs: 120, argb: [200, 255, 255, 255], op: 'ONE', texture: 'textures/mirage_texture_smash.ddj' })
    expect(g('SKILL_CH_SWORD_BASE').trail).toEqual({ lengthMs: 80, argb: [64, 255, 255, 255], op: 'ONE', texture: 'textures/mirage_texture_normal.ddj' })
    expect(g('SKILL_CH_COLD_GANGGI_A').hideWeapon).toBe(true)
    const hidden = idx.skills.filter(s => s.kind === 'player' && s.masteryLevel <= LEVEL_CAP && s.hideWeapon).map(s => s.group)
    expect(hidden).toHaveLength(12)
    expect(g('SKILL_CH_FIRE_GIGONGTA_A')).toMatchObject({ priority: 2, damage: 'hiteffect/hit_4_fire_hit_a.efp', trail: { lengthMs: 160, argb: [200, 255, 128, 0] } })
    expect(g('SKILL_CH_BOW_CRITICAL_A')).toMatchObject({ light: 'LIGHT_4', twist: 'Roll', arrowForce: 'skill/china/force_bow_critical_a.efp' })
    expect(g('SKILL_PUNCH')).toMatchObject({ kind: 'player', damage: 'hiteffect/hit_3_hand.efp' })
    expect(Object.keys(idx.lights)).toEqual(['LIGHT_1', 'LIGHT_2', 'LIGHT_3', 'LIGHT_4', 'LIGHT_5', 'LIGHT_6', 'LIGHT_7', 'LIGHT_8'])
    expect(idx.lights.LIGHT_2).toEqual({ argb: [255, 83, 11, 79], timeMs: 300, range: 1000, atten: 0.2 })
  })

  it('has the MSKILL group of every mob skill in mobs.json and the SYSTEM groups', () => {
    const mobsFile = join(OUT, 'data', 'mobs.json')
    if (existsSync(mobsFile)) {
      const mobs = readJson<{ entries: Array<{ code: string; skills?: string[] }> }>(mobsFile).entries
      for (const m of mobs) for (const code of m.skills ?? []) expect(g(code).kind, code).toBe('mob')
      for (const m of mobs) expect(idx.characters[m.code], m.code).toBeDefined()
    }
    const tomb = g('MSKILL_CH_TOMBSTONE_ATTACK02').stages.filter(s => s.actType === 'AT_MOV_1TAR')
    expect(tomb).toHaveLength(2)
    expect(tomb.filter(s => s.dmg).map(s => s.trade)).toEqual([1])
    const archer = g('MSKILL_CH_BANDITARCHER_ATTACK01')
    expect(archer.stages.map(s => s.objectModel?.glb)).toEqual(['/out/mob/china/banditarcher_arrow.glb', '/out/mob/china/banditarcher_arrow.glb'])
    expect(g('SKILL_CH_BOW_CALL_A').stages[0]!.objectModel?.glb).toBe('/out/npc/animal/whitehawk.glb')
    for (const k of ['SYSTEM_LEVELUP', 'SYSTEM_APPEAR', 'SYSTEM_HPPOTION', 'SYSTEM_MPPOTION', 'SYSTEM_LIFE', 'SYSTEM_RETURNSCROLL', 'SYSTEM_RETURNSCROLLRESULT', 'SYSTEM_CH_HWANMODE', 'SYSTEM_PET_APPEAR', 'SYSTEM_COS_HPPOTION']) {
      expect(g(k).kind, k).toBe('system')
    }
    expect(g('SYSTEM_CH_HWANMODE')).toMatchObject({ priority: 10, damage: 'hiteffect/hit_4_hwan.efp', trail: { texture: 'textures/mirage_texture_hwan.ddj' } })
  })

  it('carries the characterInfo rows', () => {
    expect(idx.characters.MOB_CH_TIGER!.damagePos).toEqual([0, 11, -13])
    expect(idx.characters.CHAR_CH_MAN_ADVENTURER!.size).toBe(2)
    expect(idx.characters.MOB_CH_STONEGHOST!.bloodType).toBe('hiteffect/hit_2_stone.efp')
    expect(idx.characters.MOB_CH_MANGNYANG!.dieModel?.glb).toBe('/out/mob/common/mangnyang_die.glb')
    expect(idx.characters.MOB_CH_TOMBSTONE!.dieModel?.glb).toBe('/out/mob/common/tombstone_die.glb')
    expect(idx.characters.MOB_CH_TIGERWOMAN!.ride?.glb).toBe('/out/mob/china/bluetiger.glb')
  })

  it('points only at files that exist: programs, trail and select textures, models', () => {
    for (const [k, e] of Object.entries(idx.effects)) if (e.url) expect(existsSync(outFile(e.url)), k).toBe(true)
    const trails = new Set(idx.skills.map(s => s.trail?.texture).filter((t): t is string => !!t))
    expect(trails.size).toBe(8)
    for (const t of trails) expect(existsSync(outFile(`fx/tex/${t.replace(/\.ddj$/, '.png')}`)), t).toBe(true)
    for (const n of [1, 2, 3, 4]) expect(existsSync(outFile(`fx/tex/ui/select_0${n}.png`))).toBe(true)
    const models = [
      ...idx.skills.flatMap(s => s.stages.map(st => st.objectModel)),
      ...Object.values(idx.characters).flatMap(c => [c.dieModel, c.ride]),
    ].filter((m): m is { glb: string; sidecar: string } => !!m)
    expect(models.length).toBeGreaterThan(10)
    for (const m of models) {
      expect(existsSync(outFile(m.glb)), m.glb).toBe(true)
      expect(existsSync(outFile(m.sidecar)), m.sidecar).toBe(true)
    }
  })
})

const side = (rel: string): ModelSidecar | null => (existsSync(join(OUT, rel)) ? readJson<ModelSidecar>(join(OUT, rel)) : null)

describe.skipIf(!HAS)('model sidecars: particles and dummies', () => {
  it('drops carry their sparkles, converted to glTF metres', () => {
    expect(side('item/etc/drop_ch_money_small.json')!.particles![0]!.efp).toBe('system/item_drop_money.efp')
    const equip = side('item/etc/drop_ch_equip.json')!.particles!
    expect(equip.map(p => p.efp)).toEqual(['system/item_drop_equip.efp', 'system/item_drop_acc.efp'])
    const [x, y, z] = equip[1]!.position
    expect(x).toBeCloseTo(0, 4)
    expect(y).toBeCloseTo(0.134, 3)
    expect(z).toBeCloseTo(0.0025, 3)
    expect(side('item/etc/drop_archemy_1.json')!.particles!.map(p => p.efp)).toEqual(['item/drop_archemy.efp'])
    expect(side('item/etc/drop_ch_money_large.json')!.particles).toBeUndefined()
  })

  it('mobs and NPCs carry their status, ambient and clip sets; missing .efp are dropped', () => {
    expect(side('mob/china/tombstone.json')!.particles).toBeUndefined()
    const yeoha = side('mob/china/yeoha.json')!.particles!
    expect(yeoha.filter(p => p.kind === 'ambient').map(p => [p.efp, p.bone])).toEqual([
      ['monster/luster_green_ball.efp', 'effect_bone'],
      ['monster/luster_green.efp', 'bone_brilliance_r'],
      ['monster/luster_green.efp', 'bone_brilliance_l'],
    ])
    expect(yeoha.some(p => p.efp === 'monster/system_appear.efp')).toBe(false)
    expect(side('mob/china/mangnyang.json')!.particles!.filter(p => p.kind === 'status').map(p => p.set)).toContain('status_bad_burn')
    expect(side('mob/china/waterghost.json')!.particles!.some(p => p.set.startsWith('mco_') || p.set === 'msk_waterghost_gas')).toBe(false)
    const smoke = side('npc/npc/chinasystem_shaman.json')!.particles!.find(p => p.clip === 'STAND2')!
    expect(smoke).toMatchObject({ kind: 'clip', efp: 'npc/npc_chinasystem_shaman_pipesmoke.efp', bone: 'Bone09', birthMs: 3206 })
  })

  it('static weapons carry their bone positions', () => {
    const sword = side('equipment/china/weapon/sword_01.json')!.dummies!
    expect(Object.keys(sword)).toEqual(expect.arrayContaining(['Bone01', 'ai_start', 'ai_end']))
    expect(sword.ai_end![2]).toBeGreaterThan(sword.ai_start![2])
    const bow = side('equipment/china/weapon/bow_01.json')!.dummies!
    expect(bow.Bone01).toBeDefined()
    expect(bow.ai_end).toBeUndefined()
    expect(side('equipment/china/shield/shield_01.json')!.dummies!.Bone01).toBeDefined()
    expect(side('mob/china/mangnyang.json')!.dummies).toBeUndefined()
  })

  it('the fx preset models exist', () => {
    for (const rel of ['item/china/weapon/cha_arrow_normal', 'item/china/weapon/cha_arrow_lighting', 'mob/china/banditarcher_arrow', 'npc/animal/whitehawk',
      'item/etc/drop_ch_quest', 'item/etc/drop_trade', 'mob/common/mangnyang_die', 'mob/common/tombstone_die']) {
      expect(existsSync(join(OUT, `${rel}.glb`)), rel).toBe(true)
    }
  })
})
