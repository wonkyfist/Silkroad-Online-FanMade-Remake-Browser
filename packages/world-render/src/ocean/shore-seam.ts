/**
 * The shore seam (docs/COAST.md §8.8, §12.4 "first commit", §12.5; docs/WAVE_PLAN6.md §6.1 CST-O → CST-S): how shore
 * v1 (CST-S, `shore/**`) plugs into the ocean's two materials (CST-O, `ocean/**`) without editing them.
 *
 * **Code.** `shore/chunks.ts` exports `SHORE_VERTEX` and `SHORE_FRAGMENT` (WGSL and GLSL, each a `definitions` and a
 * `main` string), `SHORE_UNIFORMS` (vec4 uniforms, declared by the ocean) and `SHORE_SAMPLERS` (2D samplers the shore's
 * fragment definitions declare themselves). Empty strings = no shore: the ocean's shaders are then exactly its own.
 * Both ocean materials (the PBR `SroOceanPlugin` on Medium+, the Classic `ShaderMaterial` on Low) insert the code at
 * the same places, under the define `SRO_OCEAN_SHORE`:
 *
 * - vertex `definitions`: after the ocean's own vertex definitions (functions only; no varying, no attribute: the
 *   ocean's one packed varying already carries the swash, COAST §8.6's one-vec4 rule);
 * - vertex `main`: inside the ocean's vertex block, after the waves (and their shallow-water attenuation) are summed
 *   and before the ocean writes the position and the varying;
 * - fragment `definitions`: after the ocean's fragment definitions (the shore declares its own samplers here, e.g.
 *   the lace: WGSL `var sroShoreLace: texture_2d<f32>; var sroShoreLaceSampler: sampler;`, GLSL
 *   `uniform sampler2D sroShoreLace;`), all names starting with `sroShore`;
 * - fragment `main`: in the ocean's fragment block (`CUSTOM_FRAGMENT_MAIN_BEGIN` on the PBR path: uniform control flow,
 *   so a plain `textureSample` is allowed there, COAST F14), after the ocean's taps and before it composes the colour.
 *
 * **Variables** the shore code reads and writes (private variables of the ocean's code, the same names in both
 * languages and on both paths; WGSL `var<private>`, GLSL globals):
 *
 * | name | stage | type | meaning |
 * |---|---|---|---|
 * | `sroOcRest` | both | vec2 | the rest position (glTF x, z metres) of the vertex / fragment, before the waves (read) |
 * | `sroOcField` | both | vec4 | the coast field there, decoded (read; ocean/field.ts): x sea 0..1, y shore distance m (+ at sea, − on land, ±63.75), z the ground's height above the sea level m (− at sea = the bed depth, + on land: continuous across the waterline, ±51), w the retail-water join weight (1 at the join, 0 from 64 m) |
 * | `sroOcPos` | vertex | vec3 | the world position after the waves; the shore may change it (the shore swell, the swash sheet) |
 * | `sroOcFoam` | both | f32 | the foam amount 0..1.5 (the Jacobian whitecaps); the shore may raise it (the band, the breaking line, the bead) |
 * | `sroOcSwash` | both | f32 | the swash sheet's height above the sea level (m); the vertex code writes it, the fragment reads the interpolated value |
 * | `sroOcAlpha` | fragment | f32 | the water's alpha 0..1; the shore may lower it (the thin film) or raise it (foam). The ocean discards the fragment when it is ≤ 0 after the shore ran |
 *
 * Uniforms visible to the shore (vec4, the ocean's): `sroOcA` = (sea level m, time s wrapping at 3,600, Hs m, peak
 * period s) and `sroOcS` = (swell travel direction x, z (unit, glTF), storminess 0..1, rain 0..1); WGSL
 * `uniforms.sroOcA`, GLSL `sroOcA`. The coast field texture itself is `sroOcFieldMap` (+ `sroOcFieldMapSampler` in
 * WGSL) with `sroOcFieldXf` (uv = xz × xy + zw; RGBA8 as `ocean/field.ts` packs it), for a shore that needs more taps
 * (explicit-level taps in the vertex stage; `oceanFieldDecode` there decodes a tap into the `sroOcField` layout).
 *
 * **Runtime.** `shore/index.ts` `createShorePart(host)` (null until CST-S builds one): the ocean makes it once with the
 * field, calls `update` every frame it draws and `bind` for each material bind; `ready` switches `SRO_OCEAN_SHORE` on
 * (a define change: only when it flips).
 */
import type { BaseTexture, Scene, Vector4 } from '@babylonjs/core'
import type { OceanQuality } from '../render/quality.ts'
import type { World } from '../world.ts'
import type { CoastField } from './field.ts'

/** One stage of the shore's shader code in one language. */
export interface ShoreStage {
  /** Functions and (fragment only) sampler declarations. */
  definitions: string
  /** Statements run inside the ocean's block (see the file comment). */
  main: string
}

/** One stage in both languages (the same variables and uniforms in each). */
export interface ShoreCode {
  wgsl: ShoreStage
  glsl: ShoreStage
}

/** The define the ocean sets while the shore's code and part are live. */
export const SHORE_DEFINE = 'SRO_OCEAN_SHORE'

/** Whether a stage has any code (an empty seam leaves the ocean's shaders untouched). */
export function shoreHasCode(code: ShoreCode): boolean {
  return !!(code.wgsl.definitions || code.wgsl.main || code.glsl.definitions || code.glsl.main)
}

/** What the shore gets from the ocean each frame it draws. */
export interface ShoreFrame {
  /** The ocean's clock (s, wrapping at 3,600: the shader's `sroOcA.y`). */
  time: number
  seaLevelM: number
  /** The sea state now: significant wave height (m), the peak period (s), the swell's travel direction (unit xz). */
  hs: number
  periodS: number
  swellDir: readonly [number, number]
  /** 0 calm … 1 storm (COAST §8.7), and the rain 0..1. */
  storm: number
  rain: number
  /** The preset's ocean row (the shore picks `shore: 'vertex' | 'pixel'` and `foam` from it). */
  quality: Readonly<OceanQuality>
  /** Which material draws: the Classic ShaderMaterial (Low) or the PBR plugin. */
  path: 'classic' | 'pbr'
}

/** Sets the shore's uniforms and textures on the material being bound (either path). */
export interface ShoreBinder {
  vec4(name: string, value: Vector4): void
  texture(name: string, texture: BaseTexture): void
}

/** What the shore is made from. */
export interface ShoreHost {
  readonly scene: Scene
  readonly world: World
  /** The coast field (CPU copy and GPU texture). */
  readonly field: CoastField
}

/** CST-S's runtime part (shore/index.ts `createShorePart`). */
export interface ShorePart {
  /** True once everything it binds exists (the lace, …): the ocean then turns `SRO_OCEAN_SHORE` on. */
  readonly ready: boolean
  update(frame: Readonly<ShoreFrame>): void
  /**
   * The material path (the ocean calls it once the field loads, on World.setRenderMode before the rebuild and every
   * frame): the terrain's wet band is installed on 'pbr' and removed on 'classic' whether the sea is in view or not, so
   * the warm-up compiles it and Low never builds a region with it.
   */
  setPath?(path: 'pbr' | 'classic'): void
  /** Sets every name of SHORE_UNIFORMS and SHORE_SAMPLERS. */
  bind(to: ShoreBinder): void
  dispose(): void
}

export type ShoreFactory = (host: ShoreHost) => ShorePart | null
