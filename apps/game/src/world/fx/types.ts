/**
 * Shared types of the wave 7B effects lanes (docs/EFFECTS.md §5.1, §6; docs/WAVE_PLAN2.md §5.1): the fx index v2
 * (`/out/fx/skills.json`, `sro-fx-skills` version 2, a superset of v1), the system effect keys, the FX lab log entry
 * and the idle kinds of `EntityView.setIdle`. Types only, plus two small tables fixed by the plan (idle priority, emote
 * clips), so every lane reads the same names.
 */
import type { EmoteKind } from '@sro/shared'
import type { FxSkill, FxStage } from '../skill-fx.ts'

export type FxVec3 = [number, number, number]
/** A converted .bsr model: the glb and its sidecar, as /out/ URLs. */
export interface FxModelRef {
  glb: string
  sidecar: string
}

/** One skilleffect stage row of fx index v2 (docs/EFFECTS.md §1.2 columns). */
export interface FxStageV2 extends FxStage {
  /** Col 5: the hit kinds this row plays for; null = all. */
  damageTypes: ('NOR' | 'CRI' | 'HWAN')[] | null
  /** Col 6: scaled with the caster (CHAR_BASE) or the mob (MOB_BASE) size. */
  scale: 'CHAR_BASE' | 'MOB_BASE' | null
  /** Col 7: the row id (Kill / Trade name it). */
  id: number
  /** Cols 8, 9: attach and trade ids. */
  attach: number
  trade: number
  /** Col 11. */
  createCount: number
  /** Col 12: fade in / out ms ("0,-1" -> outMs -1). */
  fade: { inMs: number; outMs: number }
  /** Col 15. */
  param: [number, number, number]
  /** Col 16, raw. */
  actOption: string
  /** The converted glb of a .bsr object (arrows, the hawk); null/absent = an .efp or not converted. */
  objectModel?: FxModelRef | null
}

/** A weapon trail row (aniset): length, colour (ARGB 0..255), blend and texture (Particles path, `.ddj`). */
export interface FxTrail {
  lengthMs: number
  argb: [number, number, number, number]
  op: 'ONE' | 'INVSRCALPHA'
  texture: string | null
}

/** One skill group of fx index v2. */
export interface FxSkillV2 extends FxSkill {
  stages: FxStageV2[]
  /** Aniset col 3: imbue 2, Berserk 10 (the highest carried wins the trail and DamageEfp). */
  priority: number
  /** Aniset col 5: the weapon is hidden during the action (CharacterActor.setWeaponVisible). */
  hideWeapon: boolean
  trail: FxTrail | null
  /** LIGHT_n key into FxIndexV2.lights. */
  light: string | null
  twist: 'Roll' | 'Yaw' | 'Pitch' | null
  bleeds: boolean
  kind: 'player' | 'mob' | 'system'
}

/** A hit light (LIGHT_n). */
export interface FxLight {
  argb: [number, number, number, number]
  timeMs: number
  range: number
  atten: number
}

/** characterInfo of one CodeName128 (CHAR_CH_*, MOB_*, NPC_*). */
export interface FxCharacterInfo {
  size: number
  damageBone: string | null
  /** DamagePos in the character's own frame (metres). */
  damagePos: FxVec3
  /** Blood effect key, e.g. 'hiteffect/hit_2_redblood.efp'. */
  bloodType: string | null
  /** The `Die Bsr` model swapped in at death (Mangnyang, Tombstone). */
  dieModel: FxModelRef | null
  ride: FxModelRef | null
}

/** The v2 fields of `/out/fx/skills.json` a client reads (v1 readers ignore them). */
export interface FxIndexV2 {
  version: 2
  skills: FxSkillV2[]
  effects: Record<string, { skills: string[]; url: string }>
  lights: Record<string, FxLight>
  characters: Record<string, FxCharacterInfo>
}

/** Retail SYSTEM_* rows the client plays (docs/EFFECTS.md §3.5-§3.9, §3.16). */
export type SystemFxKey =
  | 'SYSTEM_LEVELUP'
  | 'SYSTEM_APPEAR'
  | 'SYSTEM_HPPOTION'
  | 'SYSTEM_MPPOTION'
  | 'SYSTEM_LIFE'
  | 'SYSTEM_RETURNSCROLL'
  | 'SYSTEM_RETURNSCROLLRESULT'
  | 'SYSTEM_CH_HWANMODE'
  | 'SYSTEM_PET_APPEAR'
  | 'SYSTEM_COS_HPPOTION'

export const SYSTEM_FX_KEYS: readonly SystemFxKey[] = [
  'SYSTEM_LEVELUP', 'SYSTEM_APPEAR', 'SYSTEM_HPPOTION', 'SYSTEM_MPPOTION', 'SYSTEM_LIFE', 'SYSTEM_RETURNSCROLL',
  'SYSTEM_RETURNSCROLLRESULT', 'SYSTEM_CH_HWANMODE', 'SYSTEM_PET_APPEAR', 'SYSTEM_COS_HPPOTION',
]

/** Phases of a system effect (ACT_S, ACT_L, DEACT; docs/WAVE_PLAN2.md D26). */
export type SystemFxPhase = 'start' | 'loop' | 'end'

/** One line of the FX lab log (docs/EFFECTS.md §2.5 H2), fed by SkillFx.onSpawn and CharacterActor.onClip. */
export interface FxLabEntry {
  /** Local time (ms). */
  t: number
  kind: 'clip' | 'fx' | 'hit' | 'trail' | 'number'
  name: string
  key?: string
  bone?: string
  pos?: FxVec3
  /** Caster-local metres. */
  local?: FxVec3
  entity: number
}

/**
 * What an entity does while standing still (`EntityView.setIdle`, docs/WAVE_PLAN2.md D7): 'stand' STAND1, 'combat'
 * ATTREADY (the weapon family's), 'sit' SIT_DOWN once then SIT, 'vendor' SIT_DOWN once then VENDOR01 (SIT when missing).
 */
export type IdleKind = 'stand' | 'combat' | 'sit' | 'vendor'

/** D7 priority when several apply: stall (vendor) > posture sit > combat stance > stand. */
export const IDLE_PRIORITY: readonly IdleKind[] = ['vendor', 'sit', 'combat', 'stand']

/** The idle that wins among the kinds that apply (D7 priority); 'stand' when none does. */
export function pickIdle(kinds: Iterable<IdleKind>): IdleKind {
  const set = new Set(kinds)
  return IDLE_PRIORITY.find(k => set.has(k)) ?? 'stand'
}

/** Emote clips by the retail `.ban` names (docs/WAVE_PLAN2.md D36); EMOTION08 (the bow) has no UI entry. */
export const EMOTE_CLIP: Readonly<Record<EmoteKind, string>> = {
  hi: 'EMOTION01',
  greeting: 'EMOTION02',
  rush: 'EMOTION03',
  joy: 'EMOTION04',
  no: 'EMOTION05',
  yes: 'EMOTION06',
  laugh: 'EMOTION07',
}
