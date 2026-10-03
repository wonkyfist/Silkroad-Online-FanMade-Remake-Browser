/**
 * TP-P review previews (docs/TEXPIPE.md §3.8 "lit" and "wet"; the user's check for this lane): the derived maps shaded
 * on a flat plane facing the camera, per texel, so the preview stays in texture space and lines up with every other
 * column of the review. A port of DETAIL's `shade.py` (GGX / Smith / Schlick, a warm grazing key light at azimuth
 * 135° and elevation 22° so relief reads, a cool fill, hemispherical sky ambient, a split-sum environment reflection
 * so metals are not black, ACES tone map). It is not the game's shader: it only puts every set under the same light.
 *
 * The wet preview is the same light on a soaked surface, with the game's rain response (RENDER §9.2, WEATHER §6.2–6.3)
 * and the set's class (world-render `pbr/classes.ts`). The surface has an orientation, `up` = its world N.y (1 = a
 * floor facing the sky, 0 = a wall or a trunk; the texture's +V then points up the wall, as on every retail wall):
 *
 *   exposure = mix(0.6, 1, smoothstep(−0.2, 0.6, up))       WEATHER §6.3: tops soak first, walls get 60 %
 *   w        = wet · exposure
 *   albedo  ×= mix(1, 1 − 0.5 · porosity, w)                 RENDER §9.2: porous surfaces darken
 *   rough    = mix(rough, min(rough, wetRoughness), w)
 *   normal   = normalize(mix(normal, (0, 0, 1), 0.5 · w))     water fills the micro-detail
 *   puddle   = classPuddle · wet · smoothstep(0.965, 0.995, up) · smoothstep(0.3, 0.18, height)
 *              only where the surface faces up (RENDER §9.3 N.y > 0.95; WEATHER §6.2 `flat`), never on a wall or a
 *              trunk; in a puddle roughness 0.03, the normal flat, the albedo a quarter darker.
 *
 * `surfaceUp` (params.ts) picks `up` per set: terrain tiles and world floors 1, roofs 0.7, everything else 0. A cutout
 * is composited over grey. Pure.
 */
import type { MaterialClassParams } from '../../../world-render/src/pbr/classes.ts'
import { clamp01, img, linToSrgb, smoothstep, srgbToLin, type Img } from './image.ts'

export interface PreviewMaps {
  /** sRGB RGBA 0..1. */
  albedo: Img
  /** Unit normals, 3 channels. */
  normal: Img
  ao: Float32Array
  rough: Float32Array
  metal: Float32Array
  height: Float32Array
}

export interface PreviewLight {
  keyAz: number
  keyEl: number
  keyIntensity: number
  fillIntensity: number
  ambient: number
  exposure: number
}

export const PREVIEW_LIGHT: PreviewLight = { keyAz: 135, keyEl: 22, keyIntensity: 3.4, fillIntensity: 0.55, ambient: 0.22, exposure: 1 }
/** The height below which a puddle forms at full rain (then eased over 0.12). */
export const PUDDLE_LEVEL = 0.3
/** Puddles need a surface this flat (world N.y; RENDER §9.3 N.y > 0.95, WEATHER §6.2 smoothstep(0.965, 0.995)). */
export const PUDDLE_FLAT: readonly [number, number] = [0.965, 0.995]
/** Wetness reaching a vertical surface (WEATHER §6.3 "walls get 0.6 w"). */
export const WALL_EXPOSURE = 0.6
/** Share of the micro-normal that water fills at full wetness (RENDER §9.2). */
export const WET_NORMAL_FILL = 0.5

/** WEATHER §6.3 exposure of a surface whose world normal has this N.y: tops soak first, walls get 60 %. */
export function wetExposure(up: number): number {
  return WALL_EXPOSURE + (1 - WALL_EXPOSURE) * smoothstep(-0.2, 0.6, up)
}

/** Puddle eligibility of a surface's orientation (1 only when it faces up). */
export function puddleFlatness(up: number): number {
  return smoothstep(PUDDLE_FLAT[0], PUDDLE_FLAT[1], up)
}

export interface WetState {
  /** 0 = dry, 1 = soaked. */
  wet: number
  cls: Readonly<MaterialClassParams>
  /** Composite a cutout over grey (alpha < 0.5). */
  cutout?: boolean
  /** The surface's world N.y: 1 faces the sky (terrain, floors), 0 is vertical (walls, trunks). Default 0. */
  up?: number
  /** Overrides the orientation's exposure (characters: 1, WEATHER §6.4). */
  exposure?: number
}

const aces = (x: number) => clamp01((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14))

/** Shades the maps (see the header). Returns an sRGB RGBA image (alpha 1). */
export function shade(m: PreviewMaps, state: WetState, light: PreviewLight = PREVIEW_LIGHT): Img {
  const { w: width, h } = m.albedo
  const out = img(width, h, 4)
  const dirOf = (az: number, el: number) => {
    const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180
    return [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)] as const
  }
  const lights = [
    { L: dirOf(light.keyAz, light.keyEl), col: [1 * light.keyIntensity, 0.93 * light.keyIntensity, 0.82 * light.keyIntensity] },
    { L: dirOf(light.keyAz + 170, 45), col: [0.55 * light.fillIntensity, 0.65 * light.fillIntensity, 0.9 * light.fillIntensity] },
  ]
  const up = Math.max(-1, Math.min(1, state.up ?? 0))
  const w = state.wet * (state.exposure ?? wetExposure(up))
  const pud = state.wet * state.cls.puddle * puddleFlatness(up)
  const cls = state.cls
  const ac = m.albedo.c
  for (let p = 0; p < width * h; p++) {
    let nx = m.normal.d[p * 3]!, ny = m.normal.d[p * 3 + 1]!, nz = m.normal.d[p * 3 + 2]!
    let r = m.rough[p]!
    const metal = m.metal[p]!
    const ao = m.ao[p]!
    let darken = 1
    if (w > 0) {
      darken = 1 - 0.5 * cls.porosity * w
      r = r + (Math.min(r, cls.wetRoughness) - r) * w
      const f = WET_NORMAL_FILL * w
      nx *= 1 - f
      ny *= 1 - f
      nz = nz * (1 - f) + f
      const puddle = pud * smoothstep(PUDDLE_LEVEL, PUDDLE_LEVEL - 0.12, m.height[p]!)
      if (puddle > 0) {
        r = r + (0.03 - r) * puddle
        nx *= 1 - puddle
        ny *= 1 - puddle
        nz = nz * (1 - puddle) + puddle
        darken *= 1 - 0.25 * puddle
      }
      const l = Math.hypot(nx, ny, nz) || 1
      nx /= l; ny /= l; nz /= l
    }
    const rr = Math.max(0.04, r)
    const a2 = rr ** 4
    const k = (rr + 1) ** 2 / 8
    const NdV = Math.max(1e-4, nz)
    const alb = [0, 1, 2].map(i => srgbToLin(m.albedo.d[p * ac + i]!) * darken)
    const F0 = alb.map(c => 0.04 * (1 - metal) + c * metal)
    const col = [0, 0, 0]
    for (const { L, col: lc } of lights) {
      const hx = L[0], hy = L[1], hz = L[2] + 1
      const hl = Math.hypot(hx, hy, hz)
      const NdL = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2])
      const NdH = Math.max(0, (nx * hx + ny * hy + nz * hz) / hl)
      const VdH = Math.max(0, hz / hl)
      const D = a2 / (Math.PI * (NdH * NdH * (a2 - 1) + 1) ** 2)
      const G = (NdV / (NdV * (1 - k) + k)) * (NdL / (NdL * (1 - k) + k))
      for (let i = 0; i < 3; i++) {
        const F = F0[i]! + (1 - F0[i]!) * (1 - VdH) ** 5
        const spec = (D * G * F) / (4 * NdV * Math.max(NdL, 1e-4) + 1e-4)
        const kd = (1 - F) * (1 - metal)
        col[i] += (kd * alb[i]! / Math.PI + spec) * NdL * lc[i]!
      }
    }
    // Ambient: sky/ground hemisphere by N.y, and a crude environment reflection (Karis' analytic env BRDF).
    const up = ny * 0.5 + 0.5
    const sky = [0.45 * up + 0.2 * (1 - up), 0.52 * up + 0.17 * (1 - up), 0.62 * up + 0.14 * (1 - up)]
    const Ry = 2 * NdV * ny
    const env = [0.55, 0.6, 0.68].map(c => c * (0.6 + 0.4 * Ry) * (1 - 0.6 * rr))
    const rrr = rr * -1 + 1, q = rr * -0.0275 + 0.0425, pp = rr * -0.572 + 1.04, s = rr * 0.022 - 0.04
    const a004 = Math.min(rrr * rrr, 2 ** (-9.28 * NdV)) * rrr + q
    const AB0 = a004 * -1.04 + pp, AB1 = a004 * 1.04 + s
    const scale = light.ambient / 0.22
    for (let i = 0; i < 3; i++) {
      const direct = col[i]! * (0.5 + 0.5 * ao)
      const ambient = (alb[i]! * (1 - metal) * sky[i]! + env[i]! * (F0[i]! * AB0 + AB1)) * scale * ao
      let v = linToSrgb(aces((direct + ambient) * light.exposure))
      if (state.cutout && m.albedo.c === 4 && m.albedo.d[p * 4 + 3]! < 0.5) v = 0.5
      out.d[p * 4 + i] = v
    }
    out.d[p * 4 + 3] = 1
  }
  return out
}
