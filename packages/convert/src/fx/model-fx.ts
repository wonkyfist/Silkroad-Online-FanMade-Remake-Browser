/**
 * Effects bound to a model (docs/EFFECTS.md §1.1 path 2, §5.2): the BSR mod palette's particle sets as sidecar
 * `particles`, and the bone positions of static resources as sidecar `dummies` (weapon trails and enchant glows
 * hang on `ai_start` / `ai_end` / `Bone01`).
 *
 * Particle sets [confirmed on the Jangan BSRs]:
 *   system set named 'ambient' (type AMBIENT)   always on: drop sparkles, Yeoha's green glows, lamps and fires
 *   other system sets (type LOCOMOTION)          played on demand by name: status_bad_burn, ..., system_appear
 *   animation sets (aniSets)                     bound to one clip type (STAND2): the shaman's pipe smoke
 * Positions are file units (dm) in the model's frame; they go through toGltfPosition (x 0.1, z mirrored). Bone ''
 * means the resource origin. bytes[1] = 1 marks night-only particles (world lamps). A particle whose .efp is missing
 * from Particles.pk2 (monster/system_appear.efp, mco_*, msk_waterghost_gas) is dropped with a warning when the
 * caller can tell (`exists`).
 */
import type { BsrResource, BsrModDataParticle } from '@sro/formats'
import { toGltfPosition, type Vec3 } from '../gltf/space.ts'
import { fxKey } from './compile.ts'

export interface ModelParticle {
  /** Set name: 'ambient', 'status_bad_burn', ...; the aniGroup name ('default') for clip-bound sets. */
  set: string
  kind: 'ambient' | 'status' | 'clip'
  /** Clip type the set is bound to ('STAND2'), for kind 'clip'. */
  clip?: string
  /** Particles key, e.g. 'system/item_drop_money.efp'. */
  efp: string
  bone: string | null
  /** glTF metres in the model's (or the bone's) frame. */
  position: [number, number, number]
  birthMs: number
  night: boolean
  /** The extra vector some particles carry (bytes[3] = 1), as stored (radians on the shaman's pipe smoke [likely]). */
  extra?: [number, number, number]
}

/** Rounds to 0.01 mm and drops denormals and negative zero (file floats such as 1.4e-45). */
export function tidy(v: number, digits = 5): number {
  const f = 10 ** digits
  const r = Math.round(v * f) / f
  return r === 0 || !Number.isFinite(r) ? 0 : r
}

export const tidyVec = (v: Readonly<Vec3>): [number, number, number] => [tidy(v[0]), tidy(v[1]), tidy(v[2])]

/** The particles of a BSR's mod palette, in file order (system sets first). */
export function modelParticles(bsr: BsrResource, exists?: (efpKey: string) => boolean): { particles: ModelParticle[]; warnings: string[] } {
  const particles: ModelParticle[] = []
  const warnings: string[] = []
  const sets = [
    ...bsr.modPalette.systemSets.map(s => ({ s, ani: false })),
    ...bsr.modPalette.aniSets.map(s => ({ s, ani: true })),
  ]
  for (const { s, ani } of sets) {
    const kind: ModelParticle['kind'] = ani ? 'clip' : s.name.toLowerCase() === 'ambient' || s.typeName === 'AMBIENT' ? 'ambient' : 'status'
    for (const mod of s.mods) {
      if (mod.kind !== 'particle') continue
      for (const p of (mod as BsrModDataParticle).particles) {
        if (!p.path) continue
        const efp = fxKey(p.path)
        if (exists && !exists(efp)) {
          warnings.push(`particle ${efp} (set ${s.name}) is not in Particles.pk2; dropped`)
          continue
        }
        particles.push({
          set: s.name,
          kind,
          ...(ani && s.animationTypeName ? { clip: s.animationTypeName } : {}),
          efp,
          bone: p.bone ? p.bone : null,
          position: tidyVec(toGltfPosition(p.position)),
          birthMs: p.birthTimeMs,
          night: p.bytes[1] === 1,
          ...(p.extraVector ? { extra: [p.extraVector[0], p.extraVector[1], p.extraVector[2]] as [number, number, number] } : {}),
        })
      }
    }
  }
  return { particles, warnings }
}
