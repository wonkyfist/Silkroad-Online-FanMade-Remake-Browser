/**
 * Shader chunk seams (docs/WAVE_PLAN3.md §4.2, D1): the Classic terrain, water and grass shaders (shaders.ts,
 * scatter-assets.ts) are assembled once from their HEAD text plus the chunks of six lane-owned files, so no lane edits
 * the shader files themselves:
 *
 *   sky/chunks.ts           SKY_CHUNKS            (SKY-B: cloud shadow)
 *   weather/chunks.ts       WEATHER_CHUNKS        (WX-R: wetness, puddles, ripples, wind)
 *   night-chunks.ts         NIGHT_CHUNKS          (NL: night-light splat)
 *   coast/chunks.ts         COAST_CHUNKS          (CST-S: the shore's wet band; wave 10, W10-S)
 *   grass/chunks.ts         GRASS_TINT_CHUNKS     (GL-T: the grass tint beyond the carpet; wave 10, W10-S)
 *   render/grass-chunks.ts  RENDER_GRASS_CHUNKS   (RND-W: grass N·L, SH, CSM tap, SRO_HDR, TAA jitter)
 *
 * Within a point the order is fixed: sky → weather → night → coast → grass tint → render. With every chunk empty the
 * generated WGSL and GLSL strings equal HEAD's byte for byte (test/seams-classic.test.ts), so the Low guard holds.
 *
 * Rules for chunk authors:
 * - A snippet is pasted as-is (write your own indentation); a trailing newline is added when missing.
 * - Every snippet exists in both languages (`wgsl` and `glsl`); a point may be empty in both.
 * - WGSL: no textureSample/dpdx/fwidth inside a non-uniform branch (use textureSampleLevel/textureSampleGrad), no swizzle
 *   assignment, no `?:`; force a facet normal up (`n * sign(n.y)`: Babylon rewrites dpdy on WebGPU only).
 * - Runtime switches go through `#ifdef NAME` inside the snippet and `setDefine(name, on)` on the renderer (terrain,
 *   water, scatter), so a disabled feature costs nothing and the default define set stays HEAD's.
 * - Names added to `uniforms` / `samplers` join the ShaderMaterial option lists. Values are bound through the renderer's
 *   `sharedUniforms` (one object for every material, by reference) or, per region, `TerrainRenderer.setRegionTexture`.
 *   A declared sampler with no texture bound gets a 1 x 1 black texture, so a lane that has not bound yet never breaks
 *   a pipeline.
 * - `vWorld: true` adds the world-position varying `vWorld` (vec3, glTF metres) to that shader (the SRO_VWORLD switch of
 *   the plan: it exists only when a chunk asks for it, so HEAD's varying count is unchanged).
 * - Module-scope accumulators go in `samplers` (fragment module scope) as `var<private> x: T;` (WGSL) / a global (GLSL).
 */
import { Matrix, Vector2, Vector3, Vector4, type BaseTexture, type ShaderMaterial } from '@babylonjs/core'

export type ShaderLang = 'wgsl' | 'glsl'

/**
 * Terrain (Classic) points:
 * - `uniforms`   uniform declarations, pasted into the vertex AND the fragment module scope (Babylon merges them into
 *                one UBO; declare each name once per snippet);
 * - `varyings`   varying declarations, pasted into both stages;
 * - `vertexDecl` vertex module scope (helper functions, vertex-stage textures);
 * - `samplers`   fragment module scope: textures, samplers, helper functions, `var<private>` accumulators;
 * - `vertexOut`  end of the vertex main (`wp` = world position vec4; write your varyings);
 * - `layer`      inside the layer loop, after `drawn = k + 1`: `k`, `t` (layer-map texel), `a` (the layer's blend
 *                weight; layer 0 is opaque), `c` (its colour) and `sroClass` (the surface class, pbr/classes.ts
 *                TERRAIN_SURFACE: `i32(t.a * 255 + 0.5) & 63`) are in scope;
 * - `preLight`   after the loop and the debug views, before the lightmap: `color` is the unlit albedo (modify it);
 *                `lp` (region file units), `lm` (the lightmap sample), `dmode` are in scope;
 * - `lightTerm`  inside the lightmap block, before the multiply: modify `lmT` (a mutable copy of `lm`; the line becomes
 *                `color * clamp(lmT + shadowColor)`); `albedo` (the unlit albedo after preLight) is in scope;
 * - `postLight`  after the lightmap multiply, before fog: `color` is lit, `albedo` is the unlit albedo.
 */
export type TerrainPoint = 'uniforms' | 'varyings' | 'vertexDecl' | 'samplers' | 'vertexOut' | 'layer' | 'preLight' | 'lightTerm' | 'postLight'

/**
 * Water (Classic) points: `uniforms`, `varyings`, `vertexDecl`, `samplers`, `vertexOut` as for the terrain; then
 * - `normal`     after the frame sample: `rgb` (frame × water colour) and `nrm` (a mutable surface normal, (0, 1, 0)
 *                on entry) are in scope; perturb `nrm` (ripples);
 * - `postColor`  before fog: modify `rgb` (reflection, ripple rings) with `nrm`.
 */
export type WaterPoint = 'uniforms' | 'varyings' | 'vertexDecl' | 'samplers' | 'vertexOut' | 'normal' | 'postColor'

/**
 * Grass (scatter-assets.ts) points: `uniforms`, `varyings`, `vertexDecl`, `samplers` as for the terrain; then
 * - `vertexSway`   replaces HEAD's fixed sway line `p = p + vec3f(0.8, 0.0, 0.6) * (bend * s)` (GLSL `p += …`): `root`,
 *                  `wp`, `h`, `s`, `ph`, `t`, `sway`, `bend` and the mutable `p` are in scope; move `p`;
 * - `vertexLight`  end of the vertex main (after vDepth): `finalWorld`, `root`, `p`, `h`, `s`, `ph` in scope; write your
 *                  varyings; may adjust `vertexOutputs.position` (WGSL) / `gl_Position` (GLSL), e.g. the TAA jitter;
 * - `fragmentColor` before fog: modify `rgb`; `c` (texture sample), `lm` (lightmap after the region switch) in scope.
 */
export type GrassPoint = 'uniforms' | 'varyings' | 'vertexDecl' | 'samplers' | 'vertexSway' | 'vertexLight' | 'fragmentColor'

export interface ShaderChunk<P extends string> {
  /** Uniform names this chunk declares (added to the ShaderMaterial `uniforms` option). */
  uniforms?: readonly string[]
  /** Texture names this chunk declares (added to the ShaderMaterial `samplers` option). */
  samplers?: readonly string[]
  /** Needs the world-position varying `vWorld` (vec3, glTF metres). */
  vWorld?: boolean
  wgsl?: Partial<Record<P, string>>
  glsl?: Partial<Record<P, string>>
}

/** One lane's chunks for the three Classic shaders (any may be absent). */
export interface WorldShaderChunks {
  terrain?: ShaderChunk<TerrainPoint>
  water?: ShaderChunk<WaterPoint>
  grass?: ShaderChunk<GrassPoint>
}

type ShaderKey = keyof WorldShaderChunks

/** The chunks of one shader across lanes, in the fixed order. */
export class ChunkSet<P extends string> {
  constructor(readonly list: readonly ShaderChunk<P>[]) {}

  static of<K extends ShaderKey>(lanes: readonly WorldShaderChunks[], key: K): ChunkSet<PointOf<K>> {
    return new ChunkSet(lanes.map(l => l[key] as ShaderChunk<PointOf<K>> | undefined).filter((c): c is ShaderChunk<PointOf<K>> => !!c))
  }

  /** The concatenated snippets at `point` ('' when every lane is empty there). */
  at(lang: ShaderLang, point: P): string {
    let out = ''
    for (const c of this.list) {
      const s = c[lang]?.[point]
      if (!s) continue
      out += s.endsWith('\n') ? s : `${s}\n`
    }
    return out
  }

  has(lang: ShaderLang, point: P): boolean {
    return this.at(lang, point) !== ''
  }

  get vWorld(): boolean {
    return this.list.some(c => c.vWorld)
  }

  uniforms(base: readonly string[]): string[] {
    return withExtra(base, this.list.flatMap(c => c.uniforms ?? []))
  }

  samplers(base: readonly string[]): string[] {
    return withExtra(base, this.list.flatMap(c => c.samplers ?? []))
  }

  /** The samplers the chunks add (not the base ones). */
  get extraSamplers(): string[] {
    return withExtra([], this.list.flatMap(c => c.samplers ?? []))
  }
}

type PointOf<K extends ShaderKey> = K extends 'terrain' ? TerrainPoint : K extends 'water' ? WaterPoint : GrassPoint

function withExtra(base: readonly string[], extra: readonly string[]): string[] {
  const out = [...base]
  for (const n of extra) if (!out.includes(n)) out.push(n)
  return out
}

// ---- shared values bound by reference -------------------------------------------------------------------------------

/**
 * A value every material of a renderer shares: vectors and matrices are bound by reference (one write per frame
 * reaches every material, the scatter `uCamera`/`uFade` pattern), a `number[]` is a vec4 array (`setArray4`, e.g.
 * `wxSurf`), a texture is a sampler.
 */
export type SharedValue = Vector4 | Vector3 | Vector2 | Matrix | number[] | BaseTexture

/**
 * `sharedUniforms` of TerrainRenderer, WaterRenderer and WorldScatter: a Map whose `set`/`delete` also (re)bind the
 * value on every material the renderer has made so far; materials made later bind every entry on creation. Mutate a
 * vector in place to change its value; call `set` again only to swap the object (or a texture).
 */
export class SharedUniforms extends Map<string, SharedValue> {
  private listener: ((name: string, value: SharedValue | null) => void) | null = null

  /** The renderer's hook (one per map). */
  bindTo(fn: (name: string, value: SharedValue | null) => void): void {
    this.listener = fn
  }

  override set(name: string, value: SharedValue): this {
    super.set(name, value)
    this.listener?.(name, value)
    return this
  }

  override delete(name: string): boolean {
    const had = super.delete(name)
    if (had) this.listener?.(name, null)
    return had
  }
}

/** Binds one shared value on a ShaderMaterial (null: a texture slot falls back to `fallback`, other kinds are left). */
export function bindShared(mat: ShaderMaterial, name: string, value: SharedValue | null, fallback: BaseTexture | null = null): void {
  if (value === null) {
    if (fallback) mat.setTexture(name, fallback)
    return
  }
  if (value instanceof Vector4) mat.setVector4(name, value)
  else if (value instanceof Vector3) mat.setVector3(name, value)
  else if (value instanceof Vector2) mat.setVector2(name, value)
  else if (value instanceof Matrix) mat.setMatrix(name, value)
  else if (Array.isArray(value)) mat.setArray4(name, value)
  else mat.setTexture(name, value)
}

/** Binds every entry of `shared` on `mat`. */
export function bindAllShared(mat: ShaderMaterial, shared: ReadonlyMap<string, SharedValue>): void {
  for (const [name, value] of shared) bindShared(mat, name, value)
}

/** Defines set through a renderer's `setDefine`, applied to every material it makes (ShaderMaterial.setDefine). */
export class DefineSet {
  private readonly on = new Set<string>()

  /** Records the define; true when it changed. */
  set(name: string, value: boolean): boolean {
    if (value === this.on.has(name)) return false
    if (value) this.on.add(name)
    else this.on.delete(name)
    return true
  }

  has(name: string): boolean {
    return this.on.has(name)
  }

  apply(mat: ShaderMaterial): void {
    for (const d of this.on) mat.setDefine(d, true)
  }
}
