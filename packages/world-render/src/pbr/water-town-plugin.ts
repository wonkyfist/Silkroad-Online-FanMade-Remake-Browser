/**
 * `SroWaterTownPlugin`: the town's touches on the PBR water (docs/TOWN_LIFE.md §5.3, §7.5; docs/WAVE_PLAN7.md D5, §4.3
 * step 5). Written by W11-S; water.ts adds it to the PBR water material **only once a ripple point or a water profile
 * is set** (`WaterRenderer.setRipplePoints`, `setProfile`), so without either the water material, its plugins and its
 * shader strings are exactly today's. The ripple points' source is TL-M's (the fountain's fall, the fish, the ducks);
 * the 'town' profile's numbers are TL-B's data (`content/town/jangan-dressing.json` `pond`).
 *
 * It runs after SroWaterPlugin (priority 241 > 240) at the same injection points, on that plugin's private values
 * (`sroWAlb`, `sroWAlpha`, `sroWN`), in both languages:
 * - `SRO_WATER_POINTS` (`CUSTOM_FRAGMENT_MAIN_BEGIN`): up to RIPPLE_POINTS_MAX "local rain" points (x, z, radius,
 *   strength), each a ring growing from its centre to its radius every RIPPLE_PERIOD_S (a phase per point, so they do
 *   not pulse together), tilting the water normal; no texture, so it shows with the weather off too.
 * - `SRO_WATER_PROFILE` (`CUSTOM_FRAGMENT_MAIN_BEGIN`, `CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS`): where a region's
 *   vertex colour b is 1 (`WaterRenderer.setProfileLookup` said 'town'; 0 elsewhere, as today), the albedo goes toward
 *   the profile's colour and the alpha up with its turbidity (a turbid green-brown pond reads as water, not as wet
 *   ground; the lift fades in over PROFILE_SHORE_M of depth, so the shore stays soft), and the roughness rises as its
 *   reflection falls (reflection 1 = kept).
 */
import {
  MaterialPluginBase,
  ShaderLanguage,
  Vector4,
  type AbstractEngine,
  type Material,
  type MaterialDefines,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from '@babylonjs/core'

export const SRO_WATER_TOWN_PLUGIN = 'SroWaterTownPlugin'
/** Ripple points the water draws at once (more are dropped, nearest-first is the source's job). */
export const RIPPLE_POINTS_MAX = 8
/** One ring's life (s): it grows from the centre to the point's radius and fades. */
export const RIPPLE_PERIOD_S = 1.6
/**
 * A ring's normal gain and sharpness (1 / its half-width in m). H11-W-1: at 0.12 × 6 a full-strength ring peaked at a
 * slope of 0.05, a fifth of the PBR water's own normal noise (RMS 0.24 on the town's wave type), so no ring could be
 * seen; ×5 the gain and a wider ring (≈ 0.25 m) peak at ≈ 0.26, above the noise.
 */
export const RIPPLE_GAIN = 0.6
export const RIPPLE_SHARP = 4.5
/**
 * H11-W-2: the turbid profile's alpha lift fades in over this water depth (m), so a profiled pond keeps a soft shore
 * (0 at the waterline, the full turbidity from here; the depth is the vertex colour r × 9 − 1, as the water decodes it).
 */
export const PROFILE_SHORE_M = 0.6
/** The profiles a region can take (vertex colour b = 1). One slot this wave: the town's ponds. */
export const WATER_PROFILES = ['town'] as const
export type WaterProfileId = (typeof WATER_PROFILES)[number]
/** The roughness a profile with reflection 0 reaches (the water's own is 0.04 dry). */
export const WATER_PROFILE_MAX_ROUGHNESS = 0.4

/** A "local rain" point on the water (glTF metres): rings out to `radiusM`, `strength` 0..1. */
export interface RipplePoint {
  x: number
  z: number
  radiusM: number
  strength: number
}

/** A water profile's numbers (packages/shared town.ts TownPondProfile, without its regions). */
export interface WaterProfile {
  /** Linear RGB 0..1: the colour the albedo goes toward. */
  color: readonly [number, number, number]
  /** 0 = clear (today's water), 1 = opaque. */
  turbidity: number
  /** Reflection strength 0..1 (default 1: kept). */
  reflection?: number
}

const UBO_POINTS = Array.from({ length: RIPPLE_POINTS_MAX }, (_, i) => `sroWaterP${i}`)
/** q: time (s), 0, 0, 0; t: profile colour rgb, turbidity; u: profile roughness, 0, 0, 0. */
const UBO = ['sroWaterQ', 'sroWaterT', 'sroWaterU', ...UBO_POINTS] as const

const ANY = '#if defined(SRO_WATER_POINTS) || defined(SRO_WATER_PROFILE)\n'

function pointCalls(lang: 'wgsl' | 'glsl'): string {
  const w = lang === 'wgsl'
  return UBO_POINTS.map((n, i) => `  sroTS${w ? ' = sroTS +' : ' +='} sroWPoint(${w ? 'uniforms.' : ''}${n}, sroTP, ${(i * 0.37).toFixed(2)});\n`).join('')
}

const DEFS_WGSL = `#ifdef SRO_WATER
#ifdef SRO_WATER_POINTS
fn sroWPoint(p: vec4f, xz: vec2f, off: f32) -> vec2f {
  let d = xz - p.xy;
  let r = max(length(d), 0.001);
  let ph = fract(uniforms.sroWaterQ.x / ${RIPPLE_PERIOD_S.toFixed(2)} + off);
  let q = (r - ph * p.z) * ${RIPPLE_SHARP.toFixed(2)};
  let g = exp(-q * q) * (1.0 - ph) * p.w * step(r, p.z);
  return d / r * (q * g * ${RIPPLE_GAIN.toFixed(3)});
}
#endif
#endif
`
const DEFS_GLSL = `#ifdef SRO_WATER
#ifdef SRO_WATER_POINTS
vec2 sroWPoint(vec4 p, vec2 xz, float off) {
  vec2 d = xz - p.xy;
  float r = max(length(d), 0.001);
  float ph = fract(sroWaterQ.x / ${RIPPLE_PERIOD_S.toFixed(2)} + off);
  float q = (r - ph * p.z) * ${RIPPLE_SHARP.toFixed(2)};
  float g = exp(-q * q) * (1.0 - ph) * p.w * step(r, p.z);
  return d / r * (q * g * ${RIPPLE_GAIN.toFixed(3)});
}
#endif
#endif
`
const MAIN_WGSL = `#ifdef SRO_WATER
${ANY}{
  let sroTP = fragmentInputs.vPositionW.xz;
#ifdef SRO_WATER_POINTS
  var sroTS = vec2f(0.0);
${pointCalls('wgsl')}  sroWN = normalize(sroWN + vec3f(sroTS.x, 0.0, sroTS.y));
#endif
#ifdef SRO_WATER_PROFILE
  let sroTW = clamp(fragmentInputs.vColor.b, 0.0, 1.0) * uniforms.sroWaterT.a;
  sroWAlb = mix(sroWAlb, uniforms.sroWaterT.rgb, sroTW);
  sroWAlpha = max(sroWAlpha, sroTW * smoothstep(0.0, ${PROFILE_SHORE_M.toFixed(2)}, fragmentInputs.vColor.r * 9.0 - 1.0));
#endif
}
#endif
#endif
`
const MAIN_GLSL = `#ifdef SRO_WATER
${ANY}{
  vec2 sroTP = vPositionW.xz;
#ifdef SRO_WATER_POINTS
  vec2 sroTS = vec2(0.0);
${pointCalls('glsl')}  sroWN = normalize(sroWN + vec3(sroTS.x, 0.0, sroTS.y));
#endif
#ifdef SRO_WATER_PROFILE
  float sroTW = clamp(vColor.b, 0.0, 1.0) * sroWaterT.a;
  sroWAlb = mix(sroWAlb, sroWaterT.rgb, sroTW);
  sroWAlpha = max(sroWAlpha, sroTW * smoothstep(0.0, ${PROFILE_SHORE_M.toFixed(2)}, vColor.r * 9.0 - 1.0));
#endif
}
#endif
#endif
`
const ROUGH_WGSL = `#ifdef SRO_WATER
#ifdef SRO_WATER_PROFILE
metallicRoughness = vec2f(metallicRoughness.x, mix(metallicRoughness.y, max(metallicRoughness.y, uniforms.sroWaterU.x), clamp(fragmentInputs.vColor.b, 0.0, 1.0)));
#endif
#endif
`
const ROUGH_GLSL = `#ifdef SRO_WATER
#ifdef SRO_WATER_PROFILE
metallicRoughness.y = mix(metallicRoughness.y, max(metallicRoughness.y, sroWaterU.x), clamp(vColor.b, 0.0, 1.0));
#endif
#endif
`

/** The fragment injection points per language (the same keys in both). */
export function waterTownFragmentCode(lang: 'wgsl' | 'glsl'): Readonly<Record<string, string>> {
  const w = lang === 'wgsl'
  return {
    CUSTOM_FRAGMENT_DEFINITIONS: w ? DEFS_WGSL : DEFS_GLSL,
    CUSTOM_FRAGMENT_MAIN_BEGIN: w ? MAIN_WGSL : MAIN_GLSL,
    CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: w ? ROUGH_WGSL : ROUGH_GLSL,
  }
}

/** The ring's normal tilt of one point at a distance (TS mirror of `sroWPoint`, radial component; tests). */
export function rippleTilt(distM: number, timeS: number, p: Pick<RipplePoint, 'radiusM' | 'strength'>, off = 0): number {
  const r = Math.max(distM, 0.001)
  const t = timeS / RIPPLE_PERIOD_S + off
  const ph = t - Math.floor(t)
  const q = (r - ph * p.radiusM) * RIPPLE_SHARP
  const g = Math.exp(-q * q) * (1 - ph) * p.strength * (r <= p.radiusM ? 1 : 0)
  return q * g * RIPPLE_GAIN
}

// ---- state and plugin -----------------------------------------------------------------------------------------------

/** What the town plugin binds (water.ts writes it: the points and the time each frame, the profile when set). */
export class WaterTownState {
  /** x: the water's animation time (s, < 3600). */
  readonly q = new Vector4(0, 0, 0, 0)
  /** The 'town' profile: colour rgb, turbidity (0: none). */
  readonly t = new Vector4(0, 0, 0, 0)
  /** x: the profile's roughness (from its reflection). */
  readonly u = new Vector4(0, 0, 0, 0)
  /** RIPPLE_POINTS_MAX × (x, z, radius, strength). */
  readonly points = UBO_POINTS.map(() => new Vector4(0, 0, 0, 0))
  pointCount = 0
  profile: WaterProfile | null = null
  readonly plugins = new Set<SroWaterTownPlugin>()

  /** Whether the plugin is needed at all (a point or a profile was ever set: water.ts adds it then). */
  get wanted(): boolean {
    return this.pointCount > 0 || this.profile !== null
  }

  /** The points of this frame (at most RIPPLE_POINTS_MAX; a count change between 0 and more re-prepares the defines). */
  setPoints(list: readonly RipplePoint[] | null): void {
    const n = Math.min(RIPPLE_POINTS_MAX, list?.length ?? 0)
    for (let i = 0; i < RIPPLE_POINTS_MAX; i++) {
      const p = i < n ? list![i]! : null
      const ok = !!p && Number.isFinite(p.x) && Number.isFinite(p.z) && p.radiusM > 0 && p.strength > 0
      this.points[i]!.set(ok ? p!.x : 0, ok ? p!.z : 0, ok ? p!.radiusM : 0, ok ? Math.min(1, p!.strength) : 0)
    }
    const flip = (n > 0) !== (this.pointCount > 0)
    this.pointCount = n
    if (flip) this.dirty()
  }

  /** The 'town' profile's numbers (null: none). */
  setProfile(p: WaterProfile | null): void {
    const flip = (p !== null) !== (this.profile !== null)
    this.profile = p
    if (p) {
      const c = p.color
      this.t.set(c[0], c[1], c[2], Math.min(1, Math.max(0, p.turbidity)))
      const refl = Math.min(1, Math.max(0, p.reflection ?? 1))
      this.u.set((1 - refl) * WATER_PROFILE_MAX_ROUGHNESS, 0, 0, 0)
    } else {
      this.t.set(0, 0, 0, 0)
      this.u.set(0, 0, 0, 0)
    }
    if (flip) this.dirty()
  }

  private dirty(): void {
    for (const pl of this.plugins) pl.markAllDefinesAsDirty()
  }
}

export class SroWaterTownPlugin extends MaterialPluginBase {
  constructor(material: Material, readonly state: WaterTownState) {
    super(material, SRO_WATER_TOWN_PLUGIN, 241, { SRO_WATER_POINTS: false, SRO_WATER_PROFILE: false }, true, true)
    state.plugins.add(this)
  }

  override getClassName(): string {
    return 'SroWaterTownPlugin'
  }

  override isCompatible(_language: ShaderLanguage): boolean {
    return true
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines['SRO_WATER_POINTS'] = this.state.pointCount > 0
    defines['SRO_WATER_PROFILE'] = this.state.profile !== null
  }

  override getUniforms(language: ShaderLanguage = ShaderLanguage.GLSL) {
    const ubo = UBO.map(name => ({ name, size: 4, type: 'vec4' }))
    if (language === ShaderLanguage.WGSL) return { ubo }
    return { ubo, fragment: `${ANY}${UBO.map(n => `uniform vec4 ${n};`).join('\n')}\n#endif` }
  }

  override bindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): void {
    const s = this.state
    ubo.updateVector4('sroWaterQ', s.q)
    ubo.updateVector4('sroWaterT', s.t)
    ubo.updateVector4('sroWaterU', s.u)
    for (let i = 0; i < RIPPLE_POINTS_MAX; i++) ubo.updateVector4(UBO_POINTS[i]!, s.points[i]!)
  }

  override getCustomCode(shaderType: string, language: ShaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType !== 'fragment') return null
    return { ...waterTownFragmentCode(language === ShaderLanguage.WGSL ? 'wgsl' : 'glsl') }
  }

  override dispose(forceDisposeTextures?: boolean): void {
    this.state.plugins.delete(this)
    super.dispose(forceDisposeTextures)
  }
}

/** The town plugin of a material, if it has one. */
export function waterTownPluginOf(mat: Material | null | undefined): SroWaterTownPlugin | null {
  const p = mat?.pluginManager?.getPlugin(SRO_WATER_TOWN_PLUGIN)
  return p instanceof SroWaterTownPlugin ? p : null
}
