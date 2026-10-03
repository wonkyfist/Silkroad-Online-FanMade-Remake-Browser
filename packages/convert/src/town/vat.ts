/**
 * The crowd's baked animation textures (docs/TOWN_LIFE.md §2.2, §3.2, F11; WAVE_PLAN7 §6.1 lane TL-V): one half-float
 * VAT per skeleton, shared by every variant of that skeleton (the 9 + 9 dressed people share `europeman_skel` /
 * `europewoman_skel`; the two guards share `ch_guard`; each animal and elder has its own), written as
 * `town/vat/<skeleton>.bin` (the texels) + `.json` (the clip table, VatFile).
 *
 * Layout: Babylon 9.28's own baker's (`VertexAnimationBaker.bakeVertexDataSync(ranges, true)` +
 * `textureFromBakedVertexData`), so `RawTexture.CreateRGBATexture(new Uint16Array(bin), width, height, scene, false,
 * false, Texture.NEAREST_NEAREST, Constants.TEXTURETYPE_HALF_FLOAT)` is the texture a `BakedVertexAnimationManager`
 * takes:
 *  - one row per frame, `width = (joints + 1) × 4` RGBA texels: the frame's skin matrix of every joint in the skin's
 *    joint order (texel k of joint j = column k of the column-major 4×4), then one identity matrix (Babylon's
 *    `getTransformMatrices` has it too);
 *  - the skin matrix of joint j = its global matrix (the glb's node tree, the skeleton root's parent space, where the
 *    variant's skinned mesh sits) × its inverse bind matrix: exactly what `Skeleton.getTransformMatrices()` returns for
 *    the variant glb as Babylon loads it, so the VAT replaces the skeleton without any other change;
 *  - IEEE half floats, little-endian, rounded to nearest even. Half floats step 0.98 mm between 1 and 2 m (the bone
 *    translations live there), hence the budget: a VAT frame within 1 mm of the skinned pose at float32, 3 mm after the
 *    quantisation (WAVE_PLAN7 §5.3; `town-vat.test.ts`, NullEngine).
 *
 * Clips: each is sampled uniformly over its true length, `frames = round(duration × fps) + 1` rows from t = 0 to
 * t = duration inclusive (30 fps; VENDOR01 and the chicken's 9.8 s peck at 15), so a looping clip's last row repeats
 * its first. Babylon's VAT shader (ShadersInclude/bakedVertexAnimation) spreads rows start+1..end over
 * `frames / speed` seconds once `bakedVertexAnimationTime × speed` passes one cycle (its `frameCorrection`; rows
 * start..end in the very first cycle), so VatClip.fps = frames / duration (the speed) plays a clip at its true
 * length and a loop never shows its seam pose twice. The rows are not interpolated (the shader floors). The GPU never
 * sees epoch seconds: TL-C keeps `manager.time` < 3,600 s (F5).
 */
import type { Document } from '@gltf-transform/core'
import { channelsOf, findAnimation, globalsOf, localsAt, mul, rigOf, type Channels, type Mat4, type Rig } from '../tools/export-moves.ts'

export const VAT_FORMAT = 'sro-town-vat'
export const VAT_VERSION = 1
/** Rows per second of a clip (TOWN_LIFE §3.2); slow loops say their own (VENDOR01 15). */
export const VAT_FPS = 30
/** WAVE_PLAN7 §5.3 TL-V: each VAT ≤ 2.5 MB at half float. */
export const VAT_MAX_BYTES = 2_500_000
/** Rows a VAT may hold (the texture height; WebGL2 guarantees 2,048, every target here does 4,096+). */
export const VAT_MAX_FRAMES = 4096
/** The VAT budget at float32 and after the half-float quantisation (metres; WAVE_PLAN7 §5.3, TOWN_LIFE F11). */
export const VAT_TOLERANCE_F32 = 0.001
export const VAT_TOLERANCE_F16 = 0.003

/** One clip of a VAT (rows `start..end` inclusive). */
export interface VatClip {
  start: number
  end: number
  /** Rows: end − start + 1 (≥ 2). */
  frames: number
  /**
   * The rate the rows play at: frames / durationS, Babylon's `bakedVertexAnimationSettingsInstanced` speed (its 4th
   * component). The shader divides `time × speed` by `frames` and, past the first cycle, spreads rows start+1..end over
   * it, so one cycle lasts `frames / fps` = durationS (TL-C's crowd.ts `vatOffsetFor` takes this `fps`).
   */
  fps: number
  /** The rate the rows were sampled at: (frames − 1) / durationS (30, or 15 for the slow loops). */
  sampleFps: number
  durationS: number
  /** Played as a loop (its last row repeats the first); false: a one-shot the crowd switches away from. */
  loop: boolean
  /** Metres the feet travel per cycle (retail walkLength) for a clip that travels (WALK, RUN, CARRY), else 0. */
  loopM: number
  /** The same as a ground speed (m/s): loopM / durationS; absent when loopM is 0. */
  walkMps?: number
  /**
   * How far the skeleton's root strays on the ground inside the clip (m, the largest XZ distance from its first-row
   * place). Retail gaits are in place (a few cm of sway); the chicken's 9.8 s STAND1 is a pecking wander of its own
   * (~0.5 m), so an agent playing it stands still and lets the clip move the bird.
   */
  rootTravelM: number
  /** The source: `<glb>#<animation>` (relative to the converter output). */
  source: string
  /** TL-A2's hand-keyed town clips only (SIT_CHAIR, CARRY, TALK, SWEEP): what the crowd needs besides the rows. */
  town?: VatTownMeta
}

/**
 * TL-A2's metadata of a hand-keyed town clip, passed through from `moves/<skel>/town/town_clips.json`
 * (tools/town-clips.ts TownClipIndex; TOWN_LIFE §3.1) so the crowd reads one file per skeleton.
 */
export interface VatTownMeta {
  /**
   * STAND1 (a pose of its own) or the retail gait it is a layer on (CARRY: WALK, so its feet, root, cycle and loopM
   * are the WALK's). Not a bake overlay (VatClipSource.base): the pack's clip already holds every joint.
   */
  base: string
  /** SIT_CHAIR: the hip joints' and the seat's height above the feet (m), and the hips' forward offset. */
  seat?: { hipZ: number, hipFwd: number, seatZ?: number }
  /**
   * The clip's prop (CARRY's crate, SWEEP's broom) on joint `bone`: prop = joint world (t) · T(offset) · R(rotation),
   * where joint world (t) = the VAT row's skin matrix of `bone` × the inverse of its inverse bind matrix (the variant
   * glb's skin). The prop's +Y is its up (the broom's handle; its floor end `floorM` down −Y).
   */
  socket?: { bone: string, prop: string, offset: [number, number, number], rotation: [number, number, number, number], floorM?: number }
}

/** `town/vat/<skeleton>.json`. */
export interface VatFile {
  format: typeof VAT_FORMAT
  version: typeof VAT_VERSION
  /** The skeleton's name (the retail .bsk's basename, e.g. 'europeman_skel'). */
  skeleton: string
  /** Joints in VAT order (= the variant glbs' skin order); `width = (bones + 1) × 4`. */
  bones: number
  joints: string[]
  /** Texels per row: (bones + 1) × 4. */
  width: number
  /** Rows (frames of every clip); `height` too. */
  frames: number
  height: number
  /** The .bin holds IEEE half floats (always true here). */
  halfFloat: true
  texel: 'rgba16f'
  /** The texel file next to this one (`<skeleton>.bin`: width × height × 4 half floats, little-endian). */
  bin: string
  bytes: number
  clips: Record<string, VatClip>
}

/** A skeleton to bake: its joints in skin order and their inverse bind matrices. */
export interface VatSkeleton {
  name: string
  joints: readonly string[]
  /** Column-major inverse bind matrices, 16 per joint. */
  ibm: ArrayLike<number>
}

/** One clip to bake from a glb holding the skeleton's joints (by name) and the animation. */
export interface VatClipSource {
  /** The clip's key in the table (e.g. 'WALK', 'STAND1@fighter', 'SIT_CHAIR'). */
  name: string
  doc: Document
  anim: string
  /** Rows per second (default VAT_FPS). */
  fps?: number
  loop: boolean
  /** Metres per cycle the feet travel (retail walkLength / 10); 0 or absent: in place. */
  loopM?: number
  /** Where it came from (the VatClip's `source`). */
  source: string
  /**
   * An overlay clip (the converter's `partial`, e.g. STAND3: an upper-body idle on 26 of 37 joints) layered on a base
   * clip of the same glb, as the game plays it over the current pose: joints the clip does not animate take the base's
   * pose at the same time (the base looping).
   */
  base?: string
  /** A TL-A2 town clip's metadata (VatClip.town). */
  town?: VatTownMeta
}

/** A baked VAT before encoding: float32 skin matrices, row-major by frame. */
export interface BakedVat {
  skeleton: string
  joints: string[]
  width: number
  height: number
  /** height × width × 4 floats. */
  data: Float32Array
  clips: Record<string, VatClip>
}

/** The clip's length in seconds: its last key over every channel. */
export function animationDuration(doc: Document, anim: string): number {
  let d = 0
  for (const s of findAnimation(doc, anim).listSamplers()) {
    const t = s.getInput()!.getArray()!
    d = Math.max(d, t[t.length - 1] ?? 0)
  }
  return d
}

/** Rows of a clip of `durationS` at `fps`: round(duration × fps) + 1, at least 2. */
export function clipFrames(durationS: number, fps: number): number {
  return Math.max(1, Math.round(durationS * fps)) + 1
}

const rigs = new WeakMap<Document, { rig: Rig, channels: Map<string, Channels> }>()
function clipOf(doc: Document, anim: string): { rig: Rig, ch: Channels } {
  let r = rigs.get(doc)
  if (!r) rigs.set(doc, (r = { rig: rigOf(doc), channels: new Map() }))
  let ch = r.channels.get(anim)
  if (!ch) r.channels.set(anim, (ch = channelsOf(r.rig, findAnimation(doc, anim))))
  return { rig: r.rig, ch }
}

/** Nodes of `rig` that `ch` animates (any of translation, rotation, scale). */
function animated(rig: Rig, ch: Channels): boolean[] {
  return rig.rest.map((_, i) => ch.has(`${i}|translation`) || ch.has(`${i}|rotation`) || ch.has(`${i}|scale`))
}

/**
 * The skin matrices (16 floats per joint, VAT order, then the identity) of `doc`'s animation `anim` at time `t`,
 * written into `out` at `offset`. Joints are found by name in `doc` (the clip's glb may list them in any order). With
 * `base`, the nodes `anim` does not animate take the base clip's pose at `t` (looped).
 */
export function skinMatricesAt(skel: VatSkeleton, doc: Document, anim: string, t: number, out: Float32Array | Float64Array, offset = 0, base?: string): [number, number, number] {
  const { rig, ch } = clipOf(doc, anim)
  let locals = localsAt(rig, ch, t)
  if (base) {
    const b = clipOf(doc, base).ch
    const bd = animationDuration(doc, base)
    const bl = localsAt(rig, b, bd > 0 ? t % bd : 0)
    const own = animated(rig, ch)
    locals = locals.map((l, i) => (own[i] ? l : bl[i]!))
  }
  const g = globalsOf(rig, locals)
  skel.joints.forEach((name, j) => {
    const i = rig.byName.get(name)
    if (i === undefined) throw new Error(`${skel.name}: joint ${JSON.stringify(name)} missing in the clip's glb (${anim})`)
    const ibm = new Float64Array(16) as Mat4
    for (let k = 0; k < 16; k++) ibm[k] = skel.ibm[j * 16 + k]!
    const m = mul(g[i]!, ibm)
    for (let k = 0; k < 16; k++) out[offset + j * 16 + k] = m[k]!
  })
  const id = offset + skel.joints.length * 16
  for (let k = 0; k < 16; k++) out[id + k] = k % 5 === 0 ? 1 : 0
  const root = g[rig.byName.get(skel.joints[0]!)!]!
  return [root[12]!, root[13]!, root[14]!]
}

/** Bakes `clips` (in order) into one VAT of `skel`. Throws on a missing joint or animation, or past VAT_MAX_FRAMES. */
export function bakeVat(skel: VatSkeleton, clips: readonly VatClipSource[]): BakedVat {
  const width = (skel.joints.length + 1) * 4
  const perFrame = width * 4
  const plan = clips.map(c => {
    const durationS = animationDuration(c.doc, c.anim)
    const fps = c.fps ?? VAT_FPS
    return { c, durationS, frames: clipFrames(durationS, fps) }
  })
  const height = plan.reduce((s, p) => s + p.frames, 0)
  if (height > VAT_MAX_FRAMES) throw new Error(`${skel.name}: ${height} frames > ${VAT_MAX_FRAMES}`)
  const data = new Float32Array(height * perFrame)
  const table: Record<string, VatClip> = {}
  let row = 0
  for (const { c, durationS, frames } of plan) {
    if (table[c.name]) throw new Error(`${skel.name}: clip ${c.name} twice`)
    const n = frames - 1
    let travel = 0
    let first: [number, number, number] | null = null
    for (let k = 0; k <= n; k++) {
      const r = skinMatricesAt(skel, c.doc, c.anim, (durationS * k) / n, data, (row + k) * perFrame, c.base)
      first ??= r
      travel = Math.max(travel, Math.hypot(r[0] - first[0], r[2] - first[2]))
    }
    const d = durationS > 0 ? durationS : n / (c.fps ?? VAT_FPS)
    const loopM = c.loopM && c.loopM > 0 ? c.loopM : 0
    table[c.name] = {
      start: row,
      end: row + n,
      frames,
      fps: frames / d,
      sampleFps: n / d,
      durationS: d,
      loop: c.loop,
      loopM,
      ...(loopM > 0 ? { walkMps: Math.round((loopM / d) * 1000) / 1000 } : {}),
      rootTravelM: Math.round(travel * 1000) / 1000,
      source: c.source,
      ...(c.town ? { town: c.town } : {}),
    }
    row += frames
  }
  return { skeleton: skel.name, joints: [...skel.joints], width, height, data, clips: table }
}

// ---- half floats ------------------------------------------------------------------------------------------------------

const f32 = new Float32Array(1)
const u32 = new Uint32Array(f32.buffer)

/** A number → IEEE 754 binary16 bits, rounded to nearest even (overflow → ±Infinity, NaN kept). */
export function toHalf(value: number): number {
  f32[0] = value
  const x = u32[0]!
  const sign = (x >>> 16) & 0x8000
  const exp = (x >>> 23) & 0xff
  let mant = x & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0)
  let e = exp - 127 + 15
  if (e >= 0x1f) return sign | 0x7c00
  if (e <= 0) {
    // subnormal half (or zero)
    if (e < -10) return sign
    mant |= 0x800000
    const shift = 14 - e
    let h = mant >>> shift
    const rem = mant & ((1 << shift) - 1)
    const half = 1 << (shift - 1)
    if (rem > half || (rem === half && (h & 1))) h++
    return sign | h
  }
  let h = mant >>> 13
  const rem = mant & 0x1fff
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) {
    h++
    if (h === 0x400) {
      h = 0
      e++
      if (e >= 0x1f) return sign | 0x7c00
    }
  }
  return sign | (e << 10) | h
}

/** IEEE 754 binary16 bits → number. */
export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const e = (h >>> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return sign * m * 2 ** -24
  if (e === 0x1f) return m ? NaN : sign * Infinity
  return sign * (1 + m / 1024) * 2 ** (e - 15)
}

/** The VAT's texels as half floats (the .bin). */
export function encodeHalf(data: Float32Array): Uint16Array {
  const out = new Uint16Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = toHalf(data[i]!)
  return out
}

/** Joint `joint`'s skin matrix at row `frame` of a VAT (float32 or half texels), column-major. */
export function vatMatrix(texels: Float32Array | Uint16Array, width: number, frame: number, joint: number): Float64Array {
  const m = new Float64Array(16)
  const o = frame * width * 4 + joint * 16
  for (let k = 0; k < 16; k++) m[k] = texels instanceof Uint16Array ? fromHalf(texels[o + k]!) : texels[o + k]!
  return m
}

/** The `.json` of a baked VAT whose texels are in `bin`. */
export function vatFile(v: BakedVat, bin: string): VatFile {
  return {
    format: VAT_FORMAT,
    version: VAT_VERSION,
    skeleton: v.skeleton,
    bones: v.joints.length,
    joints: v.joints,
    width: v.width,
    frames: v.height,
    height: v.height,
    halfFloat: true,
    texel: 'rgba16f',
    bin,
    bytes: v.width * v.height * 4 * 2,
    clips: v.clips,
  }
}

/** The .bin bytes (little-endian half floats). */
export function vatBytes(half: Uint16Array): Uint8Array {
  const out = new Uint8Array(half.length * 2)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < half.length; i++) dv.setUint16(i * 2, half[i]!, true)
  return out
}

/** Parses a `.bin` back to half-float texels (tests, the viewer). */
export function readVatBin(bytes: Uint8Array): Uint16Array {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Uint16Array(bytes.byteLength >> 1)
  for (let i = 0; i < out.length; i++) out[i] = dv.getUint16(i * 2, true)
  return out
}
