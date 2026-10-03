/**
 * Character Height and Volume (build) choices, docs/CHARACTER_SCALE.md.
 *  - Height h (0..4) is a uniform scale of the whole character and its equipment: 0.94 + 0.03 h (heightScale in
 *    @sro/shared). It also scales the follow-camera target (20 units = 2.0 m at h = 2).
 *  - Volume v (0..4) is not a uniform scale: a few bones get a radial factor on their local Y/Z axes (X runs along
 *    the bone) applied to their skin matrix only, so children and sockets do not move and the height stays.
 *    Factors are linear from `low` (v = 0) to 1 (v = 2) to `high` (v = 4).
 *  - The wire byte (create packet / character list) packs both: (v << 4) | h, default 0x22.
 */
import { APPEARANCE_STEPS, DEFAULT_HEIGHT, DEFAULT_VOLUME, heightScale } from '@sro/shared'
import type { Gender } from './manifest.ts'

export { heightScale }

/** Clamps a Height/Volume choice to 0..4 (default for anything that is not a number). */
export function clampStep(v: number | undefined, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.min(APPEARANCE_STEPS - 1, Math.max(0, Math.round(v)))
}

/** Follow-camera / select-screen focus height in metres for a Height choice (native: 20 units x heightScale). */
export function cameraTargetHeight(h: number | undefined): number {
  return 2.0 * heightScale(h)
}

/** Packs Height and Volume into the original client's Scale byte. */
export function packScaleByte(height: number | undefined, volume: number | undefined): number {
  return (clampStep(volume, DEFAULT_VOLUME) << 4) | clampStep(height, DEFAULT_HEIGHT)
}

/** Unpacks the Scale byte (0xFF means the default body; volume nibbles >= 8 read as 0, others clamp). */
export function unpackScaleByte(byte: number): { height: number; volume: number } {
  if ((byte & 0xff) === 0xff) return { height: DEFAULT_HEIGHT, volume: DEFAULT_VOLUME }
  const h = byte & 0x0f
  const v = (byte >> 4) & 0x0f
  return { height: clampStep(h, DEFAULT_HEIGHT), volume: v >= 8 ? 0 : clampStep(v, DEFAULT_VOLUME) }
}

export interface VolumeBone {
  /** Joint name in the character skeleton. */
  bone: string
  /** Radial factor at v = 0. */
  low: number
  /** Radial factor at v = 4. */
  high: number
}

const both = (name: string, low: number, high: number): VolumeBone[] => [
  { bone: `Bip01 L ${name}`, low, high },
  { bone: `Bip01 R ${name}`, low, high },
]

/** docs/CHARACTER_SCALE.md E9 (native tables CCCF08/CCCF68). */
export const VOLUME_BONES: Record<Gender, readonly VolumeBone[]> = {
  male: [
    { bone: 'Bip01 Spine', low: 0.88, high: 1.10 },
    { bone: 'Bip01 Spine1', low: 0.95, high: 1.11 },
    ...both('UpperArm', 0.92, 1.20),
    ...both('Thigh', 0.90, 1.15),
    { bone: 'Bip01 Pelvis', low: 0.90, high: 1.00 },
  ],
  female: [
    { bone: 'Bip01 Spine', low: 0.95, high: 1.10 },
    { bone: 'Bip01 Spine1', low: 0.95, high: 1.00 },
    ...both('UpperArm', 0.95, 1.15),
    ...both('Thigh', 0.90, 1.15),
    { bone: 'Bip01 Pelvis', low: 0.90, high: 1.08 },
    { bone: 'Bone01', low: 0.80, high: 1.18 },
  ],
}

/** Radial factor of one bone for Volume v: low at 0, 1 at 2, high at 4, linear in between. */
export function volumeFactor(low: number, high: number, v: number | undefined): number {
  const s = clampStep(v, DEFAULT_VOLUME)
  return s <= 2 ? low + ((1 - low) * s) / 2 : 1 + ((high - 1) * (s - 2)) / 2
}

/**
 * Per-bone radial factors for a Volume choice: joint name -> factor for the bone's local Y and Z axes
 * (the local X axis, along the bone, keeps 1). Bones at 1.0 are left out, so the default build is empty.
 */
export function volumeBoneScales(gender: Gender, v: number | undefined): Map<string, number> {
  const out = new Map<string, number>()
  for (const b of VOLUME_BONES[gender]) {
    const f = volumeFactor(b.low, b.high, v)
    if (Math.abs(f - 1) > 1e-6) out.set(b.bone, f)
  }
  return out
}

/** The bone-local scale for a radial factor: [x, y, z] = [1, f, f]. */
export function radialScale(f: number): [number, number, number] {
  return [1, f, f]
}
