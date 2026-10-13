/**
 * Skill sound audit: every learnable player skill row (not a monster skill, not a basic attack, not a passive) needs
 * a cast sound (stage row, the clip's swing tracks, SND_ACTIVATE or the family fallback) and, when it lands on
 * someone (attack, debuff, imbue), an impact sound played on each target for each hit (SND_DMG, the force family
 * fallback, or the weapon's hit rows for weapon skills). Heals and cures need their soft heal stage.
 *
 *   pnpm exec tsx apps/game/scripts/skill-sound-audit.ts [work/out]
 *
 * `legacy: true` re-runs the lookup as it was before the fallbacks (group = code minus _NN, no SND_ACTIVATE, no
 * fallbacks) for the before/after counts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillDef, SoundIndex } from '@sro/shared'
import { castSoundOf, skillFamilyOf, skillGroupOf, skillHitFile } from '../src/audio/cues.ts'

const WEAPON_FAMILIES = new Set(['SWORD', 'SPEAR', 'BOW'])
const LANDS = new Set(['attack', 'debuff', 'imbue'])

export interface SkillSoundAudit {
  rows: number
  missingCast: string[]
  missingHit: string[]
  /** Weapon skills whose impact is the weapon's generic hit row (no SND_DMG of their own). */
  weaponHit: string[]
  /** Files a skill row names that the index does not have. */
  missingFiles: string[]
  castBy: Record<string, number>
}

export function learnableRows(rows: readonly SkillDef[]): SkillDef[] {
  return rows.filter((r) => !r.mob && !r.basicAttack && r.kind !== 'passive' && r.code.startsWith('SKILL_'))
}

export function auditSkillSounds(rows: readonly SkillDef[], index: SoundIndex, opts: { legacy?: boolean } = {}): SkillSoundAudit {
  const out: SkillSoundAudit = { rows: 0, missingCast: [], missingHit: [], weaponHit: [], missingFiles: [], castBy: {} }
  const rng = () => 0
  for (const r of learnableRows(rows)) {
    out.rows++
    const group = opts.legacy ? r.code.replace(/_\d+$/, '') : skillGroupOf(r.code)!
    const s = index.skills[group]
    let cast: string | null
    if (opts.legacy) {
      const stage = s?.stages?.some((x) => x.begin)
      const clip = Object.keys(s?.swing ?? {}).some((k) => /^snd_swing/.test(k))
      cast = stage ? 'stage' : clip ? 'clip' : null
    } else cast = castSoundOf(index, group, rng)?.source ?? null
    // a clip-driven cast needs an animation to carry the swing tracks
    if (cast === 'clip' && !r.animation) cast = null
    if (cast) out.castBy[cast] = (out.castBy[cast] ?? 0) + 1
    else out.missingCast.push(r.code)
    if (LANDS.has(r.kind)) {
      const own = opts.legacy ? !!s?.dmg : !!skillHitFile(index, group, false, 'n', rng)
      if (!own) {
        if (WEAPON_FAMILIES.has(skillFamilyOf(group) ?? '')) out.weaponHit.push(r.code)
        else out.missingHit.push(r.code)
      }
    }
    if (s) {
      const files = [...(s.stages ?? []).flatMap((x) => [x.begin, x.end]), ...Object.values(s.swing ?? {}).flat(), ...(Array.isArray(s.dmg) ? s.dmg : s.dmg ? [...Object.values(s.dmg.weak), ...Object.values(s.dmg.strong)] : [])]
      for (const f of files) if (f && !index.files[f] && !out.missingFiles.includes(f)) out.missingFiles.push(f)
    }
  }
  return out
}

export function loadAuditInputs(out: string): { rows: SkillDef[]; index: SoundIndex } {
  const skills = JSON.parse(readFileSync(join(out, 'data', 'skills.json'), 'utf8')) as { entries: SkillDef[] }
  const index = JSON.parse(readFileSync(join(out, 'sound', 'index.json'), 'utf8')) as SoundIndex
  return { rows: skills.entries, index }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('skill-sound-audit.ts')) {
  const { rows, index } = loadAuditInputs(process.argv[2] ?? 'work/out')
  const groups = (codes: string[]) => [...new Set(codes.map((c) => skillGroupOf(c)))].join(' ')
  for (const legacy of [true, false]) {
    const a = auditSkillSounds(rows, index, { legacy })
    console.log(`${legacy ? 'before' : 'after '}: ${a.rows} rows; missing cast ${a.missingCast.length}, missing hit ${a.missingHit.length}, weapon-row hit ${a.weaponHit.length}, missing files ${a.missingFiles.length}; cast by ${JSON.stringify(a.castBy)}`)
    if (a.missingCast.length) console.log('  no cast:', groups(a.missingCast))
    if (a.missingHit.length) console.log('  no hit:', groups(a.missingHit))
    if (a.missingFiles.length) console.log('  files:', a.missingFiles.join(' '))
  }
}
