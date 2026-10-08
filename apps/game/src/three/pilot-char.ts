// P1 stage 1 (§15.3: the MPFB body): the female pilot base behind `?newchar=1` (docs/CHARACTERS.md §15). Own character only: the body glb
// (work/out/char/pilot/female_pilot.glb, `pnpm tsx packages/convert/src/tools/pilot-char.ts`) replaces the retail
// woman's body, its parts and armour; weapons and shields still hang on the retail sockets, and every retail clip plays
// through the same joint names. Body sliders are morph pairs (`body_<name>_minus` / `_plus`, 50 = neutral) set once.
import { Vector2, type AbstractMesh, type MorphTarget, type PBRMaterial, type TransformNode } from '@babylonjs/core'
import type { ModelSource } from './models.ts'

export const PILOT_MODEL: Omit<ModelSource, 'code'> = {
  glb: '/out/char/pilot/female_pilot.glb',
  sidecar: '/out/char/pilot/female_pilot.json',
}

export const PILOT_SLIDERS = ['breast', 'buttocks', 'hips', 'waist', 'thigh', 'shoulders', 'weight', 'muscle'] as const
export type PilotSlider = (typeof PILOT_SLIDERS)[number]
export type PilotOutfit = 'base' | 'a5'
export type PilotHair = 'ponytail' | 'bob'

export interface PilotPreset {
  outfit: PilotOutfit
  hair: PilotHair
  /** 0–100 per slider, 50 = the base's neutral shape (CHARACTERS §5.2). */
  body: Record<PilotSlider, number>
}

/** The fixed presets: `average` is the base (b2), `slim` and `curvy` the b1 / b3 ends. */
export const PILOT_BODIES: Record<'average' | 'slim' | 'curvy', Record<PilotSlider, number>> = {
  average: { breast: 50, buttocks: 50, hips: 50, waist: 50, thigh: 50, shoulders: 50, weight: 50, muscle: 50 },
  slim: { breast: 0, buttocks: 0, hips: 0, waist: 0, thigh: 0, shoulders: 50, weight: 20, muscle: 50 },
  // a coherent body type: ribcage, shoulders, pelvis and thighs grow with the chest and hips (§15.2)
  curvy: { breast: 100, buttocks: 100, hips: 100, waist: 60, thigh: 100, shoulders: 70, weight: 65, muscle: 50 },
}

/**
 * `?newchar=1` (average, the a5 outfit, ponytail); `newchar=slim|curvy|average`, `ncoutfit=a5|base` (base: unclothed),
 * `nchair=ponytail|bob` pick the others. null when the flag is off.
 */
export function pilotPresetOf(search: string): PilotPreset | null {
  const q = new URLSearchParams(search)
  const v = q.get('newchar')
  if (v === null || v === '0' || v === 'false') return null
  const body = v === 'slim' || v === 'curvy' || v === 'average' ? PILOT_BODIES[v] : PILOT_BODIES.average
  const outfit: PilotOutfit = q.get('ncoutfit') === 'base' ? 'base' : 'a5'
  const hair: PilotHair = q.get('nchair') === 'bob' ? 'bob' : 'ponytail'
  return { outfit, hair, body: { ...body } }
}

/** Morph weights of one slider: below 50 drives `_minus`, above 50 `_plus` (0..1). */
export function sliderWeights(value: number): { minus: number; plus: number } {
  const v = Math.max(0, Math.min(100, value))
  return { minus: v < 50 ? (50 - v) / 50 : 0, plus: v > 50 ? (v - 50) / 50 : 0 }
}

/** Which meshes of the pilot glb are drawn: the outfit's own, the body regions it does not cover, the hair style. */
export function pilotMeshShown(name: string, preset: PilotPreset, covers: ReadonlySet<string>): boolean {
  const m = /^pilot_(body|outfit|hair)_(\w+?)(?:_primitive\d+)?$/.exec(name)
  if (!m) return true
  if (m[1] === 'hair') return m[2] === preset.hair
  if (m[1] === 'outfit') return m[2] === preset.outfit
  return preset.outfit === 'base' || !covers.has(m[2]!)
}

/** Regions each outfit hides (from the sidecar's `pilot.outfits.<name>.covers`). */
export function pilotCovers(sidecar: Record<string, unknown> | null, outfit: PilotOutfit): Set<string> {
  const p = (sidecar?.pilot as { outfits?: Record<string, { covers?: unknown }> } | undefined)?.outfits?.[outfit]?.covers
  return new Set(Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [])
}

/** Shows the preset's meshes and sets every body morph pair on all of them (body, outfit and hair follow together). */
export function applyPilotPreset(root: TransformNode, preset: PilotPreset, covers: ReadonlySet<string>): void {
  const weights = new Map<string, number>()
  for (const s of PILOT_SLIDERS) {
    const w = sliderWeights(preset.body[s])
    weights.set(`body_${s}_minus`, w.minus)
    weights.set(`body_${s}_plus`, w.plus)
  }
  for (const mesh of root.getChildMeshes(false) as AbstractMesh[]) {
    if (!mesh.name.startsWith('pilot_')) continue
    mesh.setEnabled(pilotMeshShown(mesh.name, preset, covers))
    // the hair cards' simple anisotropic highlight (CHARACTERS §6 approximation): stretched along the strands (v)
    const hairMat = mesh.name.startsWith('pilot_hair_') ? (mesh.material as PBRMaterial | null) : null
    if (hairMat?.anisotropy && !hairMat.anisotropy.isEnabled) {
      hairMat.anisotropy.isEnabled = true
      hairMat.anisotropy.intensity = 0.75
      hairMat.anisotropy.direction = new Vector2(0, 1)
    }
    const mtm = mesh.morphTargetManager
    if (!mtm) continue
    for (let i = 0; i < mtm.numTargets; i++) {
      const t: MorphTarget = mtm.getTarget(i)
      const w = weights.get(t.name)
      if (w !== undefined) t.influence = w
    }
  }
}
