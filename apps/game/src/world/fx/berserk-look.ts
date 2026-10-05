/**
 * The Berserk makeover's rules (docs/EFFECTS.md §3.9 "Makeover"), DOM- and Babylon-free so they are unit-tested:
 * the phases of one Berserk (start, active, the last 5 s, the end), the heartbeat that drives the fire outline and the
 * own screen edge, the last-seconds flicker, the camera moves (the start push-in and shake, the bump of an own hit),
 * the graphics tiers and the own-vs-others split, and the procedural textures (RGBA bytes, no canvas).
 */
import type { GraphicsPreset } from '../../settings.ts'
import type { TrailStyle } from './trail.ts'

// ---- timing -------------------------------------------------------------------------------------------------------

/** The start moment: hit-freeze, push-in, shockwave, flash and roar all happen within this (ms). */
export const START_MS = 900
/** The hit-freeze at the start (own character only): animations stand still this long (ms). */
export const START_FREEZE_MS = 100
/** The last seconds of a Berserk: the glow flickers and the heart beats faster (ms). */
export const LAST_MS = 5000
/** Heart rate (beats per minute) while Berserk runs, and in its last seconds. */
export const HEART_BPM = 74
export const HEART_BPM_LAST = 104
/** An own hit during Berserk: the hit-stop (animation time scale and length) and the camera bump length. */
export const HIT_STOP_MS = 55
export const HIT_STOP_SCALE = 0.05
export const HIT_BUMP_MS = 160

export type BerserkPhase = 'start' | 'active' | 'last' | 'end'

/**
 * The phase `sinceMs` after the look began (a late viewer's look begins in 'active': `burst` false) with `leftMs` of the
 * Berserk to go (null: unknown, as for a timer that was never seen) and `ending` once the server ended it.
 */
export function berserkPhase(sinceMs: number, leftMs: number | null, ending: boolean, burst = true): BerserkPhase {
  if (ending || (leftMs !== null && leftMs <= 0)) return 'end'
  if (burst && sinceMs < START_MS) return 'start'
  if (leftMs !== null && leftMs <= LAST_MS) return 'last'
  return 'active'
}

/** The heart rate of a phase (the last seconds beat faster; nothing beats after the end). */
export function heartBpm(phase: BerserkPhase): number {
  return phase === 'end' ? 0 : phase === 'last' ? HEART_BPM_LAST : HEART_BPM
}

/** 0..1, a heartbeat at `bpm` (a strong "lub" and a softer "dub" 0.28 of a beat later), `tMs` into it. */
export function heartbeat(tMs: number, bpm: number = HEART_BPM): number {
  if (!(bpm > 0)) return 0
  const beat = 60_000 / bpm
  const p = (((tMs % beat) + beat) % beat) / beat
  const bump = (x: number, at: number, w: number) => Math.exp(-((x - at) * (x - at)) / (2 * w * w))
  return Math.min(1, bump(p, 0.06, 0.045) + 0.6 * bump(p, 0.34, 0.05))
}

/** Index of the beat `tMs` falls in (a new index = a beat starts: the own heartbeat sound). */
export function beatIndex(tMs: number, bpm: number): number {
  return bpm > 0 ? Math.floor(tMs / (60_000 / bpm)) : -1
}

/** A small deterministic hash of an integer to 0..1. */
export function hash01(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

/**
 * The last-seconds flicker: 1 = lit, down to ~0.15 = a dropout. Frames are 70 ms buckets; the chance of a dropout
 * grows from 15 % at 5 s left to 65 % at the end, so the glow sputters out. 1 before the last seconds.
 */
export function flicker(tMs: number, leftMs: number | null, seed = 0): number {
  if (leftMs === null || leftMs > LAST_MS) return 1
  const k = 1 - Math.max(0, leftMs) / LAST_MS
  const bucket = Math.floor(tMs / 70)
  const r = hash01(bucket * 31 + seed * 7919)
  return r < 0.15 + 0.5 * k ? 0.15 + 0.35 * hash01(bucket + 101 + seed) : 1
}

/**
 * The outline's strength now (0..1.3): it swells in over the start moment, then rides the heartbeat (0.7 + 0.3 × beat
 * active, flickering in the last seconds), and is 0 at the end.
 */
export function glowLevel(sinceMs: number, phase: BerserkPhase, leftMs: number | null, seed = 0): number {
  if (phase === 'end') return 0
  const beat = heartbeat(sinceMs, heartBpm(phase))
  const base = 0.72 + 0.28 * beat
  if (phase === 'start') return Math.min(1.3, (sinceMs / START_MS) * 1.3)
  return phase === 'last' ? base * flicker(sinceMs, leftMs, seed) : base
}

// ---- camera -------------------------------------------------------------------------------------------------------

/** The start push-in: the camera radius × (1 − push) over the start moment (in 120 ms, out by START_MS). */
export const START_PUSH = 0.12
/** Start shake amplitude (camera screen-offset units, as world/camera-keys.ts SHAKE_AMP). */
export const START_SHAKE = 0.16
/** An own hit's camera bump: radius × (1 − HIT_BUMP). */
export const HIT_BUMP = 0.025

/** The camera of the start moment `tMs` in: the push (radius share) and the shake offset. */
export function startCamera(tMs: number): { push: number; x: number; y: number } {
  if (tMs < 0 || tMs >= START_MS) return { push: 0, x: 0, y: 0 }
  const push = tMs < 120 ? START_PUSH * (tMs / 120) : START_PUSH * (1 - (tMs - 120) / (START_MS - 120)) ** 2
  const shakeS = 0.45
  const left = Math.max(0, shakeS - tMs / 1000)
  const k = (left / shakeS) * START_SHAKE
  const t = tMs / 1000
  return { push, x: Math.sin(t * 63) * k, y: Math.cos(t * 51) * k * 0.6 }
}

/** The camera bump of an own hit `tMs` after it landed (radius share, 0 when over). */
export function hitBump(tMs: number): number {
  if (tMs < 0 || tMs >= HIT_BUMP_MS) return 0
  const u = tMs / HIT_BUMP_MS
  return HIT_BUMP * (u < 0.2 ? u / 0.2 : (1 - (u - 0.2) / 0.8) ** 2)
}

/** The target's flinch `tMs` after an own hit: how far it is pushed back (share of the amplitude; 0 when over). */
export const FLINCH_MS = 220
export function flinch(tMs: number): number {
  if (tMs < 0 || tMs >= FLINCH_MS) return 0
  const u = tMs / FLINCH_MS
  return u < 0.18 ? u / 0.18 : (1 - (u - 0.18) / 0.82) ** 2
}

// ---- tiers --------------------------------------------------------------------------------------------------------

export interface BerserkTier {
  /** The fire outline (shell) on every berserk character. */
  outline: boolean
  /** Embers per second: the own character, the others. */
  embersSelf: number
  embersOther: number
  /** Faint rising heat wisps around the body. */
  heat: boolean
  /** Afterimage slots per character (0: none), and how many other berserk characters (nearest first) get them. */
  afterimages: number
  afterimageOthers: number
  /** Glowing eyes, burning footsteps, the fire ring on the ground under the character. */
  eyes: boolean
  footsteps: boolean
  aura: boolean
  /** The start: the shockwave ring (every tier), the dust and leaves, the own flash. */
  ring: boolean
  dust: boolean
  flash: boolean
  /** The end: the steam puff. */
  steam: boolean
  /** Own screen: the red edge, and the slightly richer colours. */
  vignette: boolean
  richColor: boolean
  /** The retail keep cloud (SYSTEM_CH_HWANMODE ACT_L), toned down: × scale and × opacity. */
  cloudScale: number
  cloudFade: number
}

const FULL: BerserkTier = {
  outline: true,
  embersSelf: 34,
  embersOther: 16,
  heat: true,
  afterimages: 3,
  afterimageOthers: 4,
  eyes: true,
  footsteps: true,
  aura: true,
  ring: true,
  dust: true,
  flash: true,
  steam: true,
  vignette: true,
  richColor: true,
  cloudScale: 0.5,
  cloudFade: 0.28,
}

/**
 * Per graphics preset (Options → Graphics; docs/EFFECTS.md §3.9). Low (Classic) keeps the cheap parts only: the outline,
 * a few embers, the own screen edge and the start ring. Medium has everything with fewer embers and afterimages on two
 * other characters; High and Ultra on four.
 */
export const BERSERK_TIERS: Readonly<Record<GraphicsPreset, Readonly<BerserkTier>>> = {
  low: {
    outline: true,
    embersSelf: 10,
    embersOther: 4,
    heat: false,
    afterimages: 0,
    afterimageOthers: 0,
    eyes: false,
    footsteps: false,
    aura: false,
    ring: true,
    dust: false,
    flash: false,
    steam: false,
    vignette: true,
    richColor: false,
    cloudScale: 0.5,
    cloudFade: 0.28,
  },
  medium: { ...FULL, embersSelf: 24, embersOther: 10, afterimages: 2, afterimageOthers: 2 },
  high: FULL,
  ultra: FULL,
}

export function berserkTier(preset: GraphicsPreset | string): Readonly<BerserkTier> {
  return BERSERK_TIERS[preset as GraphicsPreset] ?? BERSERK_TIERS.medium
}

/** What one berserk character shows on this screen. */
export interface MakeoverParts {
  outline: boolean
  /** The outline of the weapon and the hwan hair too (else the skinned body only): yourself and the nearest others. */
  outlineExtras: boolean
  /** Embers per second. */
  embers: number
  heat: boolean
  /** Afterimage slots (0: none). */
  afterimages: number
  eyes: boolean
  footsteps: boolean
  aura: boolean
  ring: boolean
  dust: boolean
  steam: boolean
  /** Own screen only (the Options toggle "Berserk screen effects" gates them; the camera ones the shake option too). */
  flash: boolean
  vignette: boolean
  heartbeat: boolean
  richColor: boolean
  camera: boolean
  hitStop: boolean
}

export interface SplitOptions {
  /** Options → Interface → Berserk screen effects (settings ui.berserkScreen). */
  screen: boolean
  /** Options → Controls → camera shake (settings controls.cameraShake). */
  shake: boolean
}

/**
 * The own-vs-others split: everyone sees the outline, embers, heat, eyes, footsteps, aura, ring, dust and steam (by
 * tier); afterimages only on the own character and the `afterimageOthers` nearest others (`rank` 0 = nearest other);
 * the flash, the screen edge, the heartbeat, the colours, the camera and the hit-stop only on the own screen for the
 * own character.
 */
export function makeoverParts(tier: Readonly<BerserkTier>, self: boolean, rank: number, o: SplitOptions): MakeoverParts {
  const screen = self && o.screen
  return {
    outline: tier.outline,
    outlineExtras: tier.outline && (self || rank < tier.afterimageOthers),
    embers: self ? tier.embersSelf : tier.embersOther,
    heat: tier.heat,
    afterimages: self || rank < tier.afterimageOthers ? tier.afterimages : 0,
    eyes: tier.eyes,
    footsteps: tier.footsteps,
    aura: tier.aura,
    ring: tier.ring,
    dust: tier.dust,
    steam: tier.steam,
    flash: screen && tier.flash,
    vignette: screen && tier.vignette,
    heartbeat: screen,
    richColor: screen && tier.richColor,
    camera: screen && o.shake,
    hitStop: screen,
  }
}

// ---- the outline ---------------------------------------------------------------------------------------------------

/** Shell (outline) look: extrusion along the normal (m) at rest and its heartbeat swell, the rim power. */
export const SHELL_WIDTH = 0.046
export const SHELL_SWELL = 0.02
export const SHELL_POWER = 1.1
/** The rim over the body (the faces towards the camera): power × SHELL_INNER, × SHELL_INNER_GAIN. */
export const SHELL_INNER = 3
export const SHELL_INNER_GAIN = 0.65
/** Linear colours of the outline: the hot edge (gold-white) and the core (red). */
export const SHELL_EDGE: readonly [number, number, number] = [1.35, 0.95, 0.42]
export const SHELL_CORE: readonly [number, number, number] = [1.0, 0.16, 0.02]
/** Afterimages: their life (ms), the spawn interval while moving or swinging, their starting opacity. */
export const GHOST_LIFE_MS = 320
export const GHOST_EVERY_MS = 95
export const GHOST_ALPHA = 0.45

/** The shell's extrusion for a glow level (m). */
export function shellWidth(level: number): number {
  return SHELL_WIDTH + SHELL_SWELL * Math.max(0, Math.min(1.3, level) - 0.7) / 0.6
}

// ---- the eyes ----------------------------------------------------------------------------------------------------

/** The eye glow comes this far (m) towards the camera: in front of the hwan hair's band over the eyes. */
export const EYE_LIFT = 0.13

/**
 * How much of the eye glow shows for a face turned `cos` (the cosine between the face's forward and the direction to
 * the camera, on the ground plane): full from the front, gone once the face is turned more than ~70° away.
 */
export function eyeFacing(cos: number): number {
  const u = Math.max(0, Math.min(1, (cos - 0.3) / 0.45))
  return u * u * (3 - 2 * u)
}

// ---- the weapon trail ----------------------------------------------------------------------------------------------

/** The HWAN trail made fiery: the retail white (200,255,255,255) tinted fire-orange, opaque and 40 % longer. */
export const FIRE_TRAIL_COLOR: readonly [number, number, number] = [1.0, 0.5, 0.12]
export function fireTrail(style: TrailStyle): TrailStyle {
  return { ...style, lengthMs: Math.round(style.lengthMs * 1.4), color: [FIRE_TRAIL_COLOR[0], FIRE_TRAIL_COLOR[1], FIRE_TRAIL_COLOR[2], 1], blend: 'add' }
}

// ---- procedural textures (RGBA8, size × size) ----------------------------------------------------------------------

function rgba(size: number, fn: (u: number, v: number) => [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = fn(((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1)
      const i = (y * size + x) * 4
      out[i] = Math.round(Math.max(0, Math.min(1, r)) * 255)
      out[i + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255)
      out[i + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255)
      out[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255)
    }
  }
  return out
}

/** A soft round spot (embers, eyes, wisps): white, alpha falling off to the rim. */
export function softDotTexture(size = 32): Uint8Array {
  return rgba(size, (u, v) => {
    const d = Math.hypot(u, v)
    const a = Math.max(0, 1 - d) ** 2.2
    return [1, 1, 1, a]
  })
}

/** The shockwave: a bright ring near the rim with a soft inner trail. */
export function ringTexture(size = 128): Uint8Array {
  return rgba(size, (u, v) => {
    const d = Math.hypot(u, v)
    const band = Math.exp(-((d - 0.86) ** 2) / (2 * 0.045 ** 2))
    const trail = d < 0.86 ? 0.35 * Math.max(0, (d - 0.35) / 0.51) ** 2 : 0
    const a = d > 1 ? 0 : Math.min(1, band + trail)
    return [1, 0.82 + 0.18 * band, 0.55 + 0.45 * band, a]
  })
}

/** A burning footprint: a soft oval, hottest at the heel and the ball of the foot. */
export function stepTexture(size = 32): Uint8Array {
  return rgba(size, (u, v) => {
    const e = Math.hypot(u / 0.55, v / 0.95)
    const pads = Math.exp(-((v - 0.45) ** 2) / 0.05) + Math.exp(-((v + 0.5) ** 2) / 0.04)
    const a = e > 1 ? 0 : (1 - e) ** 1.4 * (0.55 + 0.45 * Math.min(1, pads))
    return [1, 1, 1, a]
  })
}

/** The fire ring on the ground under a berserk character: a red glow with cracks running out from the centre. */
export function sigilTexture(size = 128, seed = 7): Uint8Array {
  const rays = 11
  const angles = Array.from({ length: rays }, (_, i) => ((i + hash01(seed + i) * 0.6) / rays) * Math.PI * 2)
  return rgba(size, (u, v) => {
    const d = Math.hypot(u, v)
    if (d >= 1) return [1, 1, 1, 0]
    const glow = Math.max(0, 1 - d) ** 1.6 * 0.7 + Math.exp(-((d - 0.72) ** 2) / (2 * 0.06 ** 2)) * 0.45
    const a0 = Math.atan2(v, u)
    let crack = 0
    for (let i = 0; i < rays; i++) {
      // A crack zig-zags a little along its ray, thinner and fainter towards the rim.
      const wob = 0.09 * Math.sin(d * 23 + i * 1.7)
      let da = Math.abs(a0 - angles[i]! - wob)
      da = Math.min(da, Math.PI * 2 - da)
      const w = 0.035 * (1.2 - d)
      crack = Math.max(crack, Math.exp(-((da * d) ** 2) / (2 * w * w)) * (d > 0.12 ? 1 - d : 0))
    }
    const hot = Math.min(1, crack * 1.4)
    return [1, 0.55 + 0.45 * hot, 0.35 + 0.65 * hot, Math.min(1, glow + hot)]
  })
}

/** Nothing of the makeover (the LAB switch: the retail look alone). */
export const NO_MAKEOVER: Readonly<MakeoverParts> = {
  outline: false,
  outlineExtras: false,
  embers: 0,
  heat: false,
  afterimages: 0,
  eyes: false,
  footsteps: false,
  aura: false,
  ring: false,
  dust: false,
  steam: false,
  flash: false,
  vignette: false,
  heartbeat: false,
  richColor: false,
  camera: false,
  hitStop: false,
}
