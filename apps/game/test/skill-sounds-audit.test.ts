/**
 * Skill sounds (apps/game/scripts/skill-sound-audit.ts): every learnable skill row has a cast sound and, when it lands,
 * an impact of its own on each target; chain segments and second variants find their root's effectsound row.
 * The real-data check runs on the private branch only (work/out present).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditSkillSounds, loadAuditInputs } from '../scripts/skill-sound-audit.ts'
import { castSoundOf, hitSound, skillGroupOf } from '../src/audio/cues.ts'

const OUT = join(import.meta.dirname, '../../../work/out')
const HAVE = existsSync(join(OUT, 'data/skills.json')) && existsSync(join(OUT, 'sound/index.json'))

describe('skill sound groups', () => {
  it('chain segments and second variants use their root group', () => {
    expect(skillGroupOf('SKILL_CH_SPEAR_CHAIN_C_2S_07')).toBe('SKILL_CH_SPEAR_CHAIN_C')
    expect(skillGroupOf('SKILL_CH_SWORD_SMASH_C2_03')).toBe('SKILL_CH_SWORD_SMASH_C')
    expect(skillGroupOf('SKILL_CH_SPEAR_FRONTAREA_B2_01')).toBe('SKILL_CH_SPEAR_FRONTAREA_B')
    expect(skillGroupOf('SKILL_CH_COLD_GIGONGTA_A_12')).toBe('SKILL_CH_COLD_GIGONGTA_A')
    expect(skillGroupOf('MSKILL_TIGERWOMAN_01')).toBe('MSKILL_TIGERWOMAN_01')
  })
})

describe.skipIf(!HAVE)('skill sound audit (real data)', () => {
  const { rows, index } = HAVE ? loadAuditInputs(OUT) : { rows: [], index: null as never }

  it('every learnable row has a cast sound and an impact of its own; every named file exists', () => {
    const a = auditSkillSounds(rows, index)
    expect(a.rows).toBeGreaterThan(1000)
    expect(a.missingCast).toEqual([])
    expect(a.missingHit).toEqual([])
    expect(a.weaponHit).toEqual([])
    expect(a.missingFiles).toEqual([])
  })

  it('a force skill without SND_DMG sounds its family (Lion Shout: the lightning crack), not the weapon', () => {
    const s = hitSound(index, { skill: 'SKILL_CH_LIGHTNING_CHUNDUNG_A_01', attacker: { kind: 'player', model: 'CHAR_CH_MAN_ADVENTURER', family: 'sword', clip: null }, victim: { kind: 'mob', model: 'MOB_X', radius: 1 }, outcome: 'hit', rng: () => 0 })
    expect(s?.files[0]).toBe('skill/csk_light_bolt_hit')
  })

  it('a chain segment hits with its chain row SND_DMG; Demon Soul Arrow casts with its SND_ACTIVATE row', () => {
    const s = hitSound(index, { skill: 'SKILL_CH_SPEAR_CHAIN_C_2S_01', attacker: { kind: 'player', model: 'CHAR_CH_MAN_ADVENTURER', family: 'spear', clip: null }, victim: { kind: 'mob', model: 'MOB_X', radius: 1 }, outcome: 'hit', rng: () => 0 })
    const own = index.skills.SKILL_CH_SPEAR_CHAIN_C?.dmg
    expect(own).toBeTruthy()
    expect(Array.isArray(own) ? own : []).toContain(s?.files[0])
    expect(castSoundOf(index, 'SKILL_CH_BOW_NORMAL_A')).toMatchObject({ source: 'activate' })
  })
})
