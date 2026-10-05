/**
 * mobs.json: MobDef records from characterdata (client, authoritative for stats, level, EXP and models) for every
 * monster code the exported nests reference. Aggression and champion/giant opt-in come from the port (tactics and
 * mobs.json `variants`) because the client has neither.
 */
import { characterStats, type CharacterDataRow, type SkillDataRow } from '@sro/formats'
import { PROVENANCE_PORT, type MobDef, type MobRarity, type MobVariant, type ModelRef } from '../../../shared/src/content.ts'
import { characterInfoRow } from '../fx/skilleffect.ts'
import { textOf } from './client-source.ts'
import { modelRef, modelSource, type OutExists } from './models.ts'
import type { PortMob, PortNest } from './port-source.ts'
import { mobAttack, type MobAttack } from './skills.ts'

/** Rarity (col 15) -> MobRarity (research report §4.4; 2 = SOX is an item grade and does not occur on monsters). */
export const MOB_RARITY: Readonly<Record<number, MobRarity>> = {
  0: 'normal',
  1: 'champion',
  3: 'unique',
  4: 'giant',
  5: 'titan',
  6: 'elite',
  7: 'strongElite',
  8: 'special',
}

/** Is a Data.pk2 path present? (Used for the *_clon / *_champ model variants.) */
export type DataExists = (pk2Path: string) => boolean

/**
 * Model of a monster row: its own AssocFileObj128; for *_CLON rows (no model, OrgObjCodeName128 = base code,
 * col 93 = 1) the base model's `<name>_clon.bsr` sibling when Data.pk2 has one, else the base model itself.
 */
export function mobModelSource(
  row: CharacterDataRow,
  byCode: ReadonlyMap<string, CharacterDataRow>,
  hasData: DataExists,
): { assoc?: string; rule: string } {
  if (row.assocFileObj) return { assoc: row.assocFileObj, rule: 'client: AssocFileObj128 (col 52)' }
  const base = row.orgObjCodeName ? byCode.get(row.orgObjCodeName) : undefined
  if (!base?.assocFileObj) return { rule: 'no model' }
  const clon = base.assocFileObj.replace(/\.bsr$/i, '_clon.bsr')
  if (hasData('res/' + clon.replace(/\\/g, '/'))) return { assoc: clon, rule: `client: ${row.orgObjCodeName} model + _clon sibling (col 4 base code, col 93 = 1)` }
  return { assoc: base.assocFileObj, rule: `client: ${row.orgObjCodeName} model (col 4 base code; no _clon sibling in Data.pk2)` }
}

/** Champion look: `<model>_champ.bsr` next to the monster's model, when Data.pk2 has one. */
export function championModelSource(assoc: string | undefined, hasData: DataExists): string | undefined {
  if (!assoc) return undefined
  const champ = assoc.replace(/(_clon)?\.bsr$/i, '_champ.bsr')
  return hasData('res/' + champ.replace(/\\/g, '/')) ? champ : undefined
}

/** The joint a ridden mob's rider sits on (docs/UNIQUES.md §2.1: the tiger's `saddle`). */
export const RIDE_JOINT = 'saddle'

/**
 * skilleffect.txt `characterInfo` rows (raw cells, as client-source loads the table) -> CodeName128 -> the ride's BSR
 * relative to res/ like an AssocFileObj128 (col 4, lower case: 'mob/china/bluetiger.bsr'). Only rows with a ride (Tiger
 * Girl's tiger; a few mobs we do not export, docs/UNIQUES.md §1).
 */
export function characterRides(skilleffect: readonly (readonly string[])[]): Map<string, string> {
  const out = new Map<string, string>()
  let section = ''
  for (const c of skilleffect) {
    if (c[0] === '#section') {
      section = c[1] ?? ''
      continue
    }
    if (section !== 'characterInfo') continue
    const row = characterInfoRow(c as string[])
    if (row?.ride && !out.has(row.code)) out.set(row.code, row.ride.replace(/^res\//, ''))
  }
  return out
}

export interface MobContext {
  byCode: ReadonlyMap<string, CharacterDataRow>
  skillsById: ReadonlyMap<number, SkillDataRow>
  strings: ReadonlyMap<string, string>
  exists: OutExists
  hasData: DataExists
  /** Nests of every zone (for the aggression default). */
  nests: readonly PortNest[]
  portMobs: readonly PortMob[]
  /** CodeName128 -> the ride's BSR relative to res/ (`characterRides`); absent: no rides. */
  rides?: ReadonlyMap<string, string>
  /**
   * The skeleton joints of a converted model, by its sidecar URL (/out/...json `skeleton.joints`); null when unknown.
   * Absent: a ride cannot be checked and is left out with a warning (docs/UNIQUES.md §2.2).
   */
  jointsOf?: (sidecarUrl: string) => readonly string[] | null
}

const r2 = (v: number) => Math.round(v * 100) / 100 + 0

export interface MobBuild {
  mob: MobDef & Record<string, unknown>
  /** res/... model paths this mob needs converted (own + champion look + ride). */
  models: string[]
  /** Converter warnings (a ride without its joint or glb). */
  warnings: string[]
}

export function buildMobDef(code: string, ctx: MobContext): MobBuild {
  const row = ctx.byCode.get(code)
  if (!row) throw new Error(`mobs: ${code} has no characterdata row`)
  if (row.typeId[0] !== 1 || row.typeId[1] !== 2 || row.typeId[2] !== 1) throw new Error(`mobs: ${code} TypeID ${row.typeId.join('/')} is not a monster (1/2/1/x)`)
  const s = characterStats(row)
  const fieldSources: Record<string, string> = {}
  const attacks: MobAttack[] = []
  for (const id of s.defaultSkills) {
    const sk = ctx.skillsById.get(id)
    if (sk) attacks.push(mobAttack(sk))
  }
  const first = attacks[0]
  let physAttack: [number, number] = [0, 0]
  let magAttack: [number, number] = [0, 0]
  if (first?.damage) {
    const magical = first.damage.magPct > 0
    if (magical) magAttack = first.damage.flat
    else physAttack = first.damage.flat
    fieldSources[magical ? 'magAttack' : 'physAttack'] = `client: ${first.code} 'att' flat min/max`
  } else {
    // Formula fallback for rows without a default-skill 'att' record (none of the exported mobs needs it).
    physAttack = [row.level * 2, row.level * 3]
    fieldSources.physAttack = 'formula: [2 x level, 3 x level] (no default-skill att record)'
  }
  const nests = ctx.nests.filter(n => n.vsroCode === code)
  const aggr = new Set(nests.map(n => n.aggressTypeRaw === 0))
  const aggressive = aggr.size === 1 ? [...aggr][0]! : false
  fieldSources.aggressive = aggr.size === 1 ? `port: tactics aggressTypeRaw ${nests[0]!.aggressTypeRaw} on all ${nests.length} nests (0 = aggressive)` : 'default false (nests disagree or none)'
  const model = mobModelSource(row, ctx.byCode, ctx.hasData)
  const models: string[] = []
  const src = modelSource(model.assoc)
  if (src) models.push(src)
  fieldSources.model = model.rule
  const mob: MobDef & Record<string, unknown> = {
    code,
    id: row.id,
    name: textOf(ctx.strings, row.nameStrId),
    typeId: row.typeId,
    rarity: MOB_RARITY[row.rarity] ?? 'normal',
    level: row.level,
    hp: row.maxHp,
    mp: row.maxMp,
    physAttack,
    magAttack,
    physDefence: s.physDefence,
    magDefence: s.magDefence,
    physAbsorb: s.physAbsorb,
    magAbsorb: s.magAbsorb,
    hitRate: s.hitRate,
    parryRate: s.parryRate,
    blockRate: s.blockRate,
    critRate: s.critRate,
    attackRange: first ? first.range : 1,
    attackIntervalMs: first ? first.cooldownMs : 3000,
    radius: r2(s.bcRadius * 0.1),
    walkSpeed: r2(row.walkSpeed * 0.1),
    runSpeed: r2(row.runSpeed * 0.1),
    aggressive,
    exp: s.exp,
    scale: row.scale,
    model: modelRef(model.assoc, ctx.exists),
  }
  if (!first) {
    fieldSources.attackRange = 'default 1 m (no default skill)'
    fieldSources.attackIntervalMs = 'default 3000 ms (no default skill)'
  }
  if (attacks.length) {
    mob.skills = attacks.map(a => a.code)
    mob.attacks = attacks
  }
  const pm = ctx.portMobs.find(m => nests.some(n => n.mobId === m.id))
  // A passive mob's champion: aggressive when its tactics link a champion tactics row (every one has btAggressType 0).
  if (!aggressive && pm) {
    const link = pm.combat?.championTacticsId ?? 0
    mob.championAggressive = link > 0
    fieldSources.championAggressive = link > 0 ? `${PROVENANCE_PORT}: mobs.json ${pm.id}.combat.championTacticsId ${link} (champion tactics attack on sight)` : `${PROVENANCE_PORT}: mobs.json ${pm.id} links no champion tactics`
  }
  if (pm?.variants && (pm.variants.champion || pm.variants.giant)) {
    const v: MobVariant[] = ['normal']
    if (pm.variants.champion) v.push('champion')
    if (pm.variants.giant) v.push('giant')
    mob.variants = v
    fieldSources.variants = `${PROVENANCE_PORT}: mobs.json ${pm.id}.variants`
  }
  const champ = championModelSource(model.assoc, ctx.hasData)
  if (champ) {
    const champSrc = modelSource(champ)!
    models.push(champSrc)
    const ref: ModelRef | null = modelRef(champ, ctx.exists)
    mob.championModel = ref
    fieldSources.championModel = `client: ${champSrc} (the _champ sibling of the model)`
  }
  const warnings: string[] = []
  const rideAssoc = ctx.rides?.get(code)
  if (rideAssoc) {
    const rideSrc = modelSource(rideAssoc)
    if (rideSrc) models.push(rideSrc)
    const ref = modelRef(rideAssoc, ctx.exists)
    const joints = ref && ctx.jointsOf ? ctx.jointsOf(ref.sidecar) : null
    if (!ref) warnings.push(`mobs: ${code} rides ${rideAssoc}, which is not converted; no ride`)
    else if (!joints) warnings.push(`mobs: ${code} rides ${ref.bsr}, whose skeleton is unknown (${ref.sidecar}); no ride`)
    else if (!joints.includes(RIDE_JOINT)) warnings.push(`mobs: ${code} rides ${ref.bsr}, which has no '${RIDE_JOINT}' joint; no ride`)
    else {
      mob.ride = { model: ref, joint: RIDE_JOINT }
      fieldSources.ride = `client: skilleffect.txt characterInfo ride (col 4) ${ref.bsr}; joint '${RIDE_JOINT}' checked in ${ref.sidecar}`
    }
  }
  mob.fieldSources = fieldSources
  return { mob, models, warnings }
}
