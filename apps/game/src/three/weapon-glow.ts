/**
 * Alchemy glow on weapons and shields (+1 … +7; docs/EFFECTS.md §3.10, docs/SYSTEMS_COMBAT.md §4.6).
 *
 * Retail (vSRO 1.188, `Media.pk2 resinfo/itemoptionefp.txt`): every weapon and shield row names one "enchant" effect
 * on one of its bones: `system/system_enchant_a_01.efp` (swords, spears: `ai_end`), `_b_01` (blades, glaives:
 * `ai_start`), `system_enchantbow_a_01` (bows), `system_enchantshield_a_01` (shields). Each is a run of five pale-blue
 * aura bursts (`oura_18/19`, `color_hall`; colours #8C97FF and #D9FCFF, additive) flashing one after another down the
 * blade, from the tip to the base, once a second. From which + level the client plays it is not in the data (it is
 * in sro_client.exe, which this install does not have; column 5 is 8 on every row, meaning unknown).
 *
 * Ours: a tier per + level (WEAPON_GLOW_TIERS, open-ended: a level takes the last row at or below it), drawn by the
 * weapon's own material, so it costs no draw and no varying (the 16-varying adapters, gpu-guards.ts):
 *  - +1/+2 a faint pale shimmer band sweeping the blade from the base to the tip;
 *  - +3/+4 a soft retail-blue glow over the blade with a rim at the silhouette, the band brighter;
 *  - +5/+6 a stronger glow with a slow pulse;
 *  - +7 bright, a faster pulse, and retail's glint run on the blade (WeaponGlints: one batched draw for all weapons,
 *    Medium and up, your own character and the nearest few only, capped per preset).
 * The material part is a Babylon material plugin (WeaponGlowPlugin) on the weapon's shared glTF material: a mesh that
 * glows turns on SROGLOW for its own submesh (per-mesh defines) and writes its values into the material's uniform
 * buffer when it is bound (hardBindForSubMesh, every draw), so twenty players sharing one sword model can each have
 * their own + level without cloning the material (which would lose the texture sets, the surface plugin and the
 * remaster swaps that track the shared one). The fragment finds the blade from the mesh's world matrix (`world` /
 * `mesh.world`, in both shader languages) and the blade axis in the mesh's space (the sidecar `ai_start` → `ai_end`,
 * else the longest side of the item's box): no extra vertex output.
 * Low (Classic) draws SROGLOW_LITE: the tint, the pulse and a short whole-weapon flash per sweep, no per-pixel band,
 * rim or blade mask, and no glints.
 */
import {
  Color3,
  Constants,
  Material,
  MaterialPluginBase,
  Matrix,
  Mesh,
  PBRMaterial,
  ShaderLanguage,
  StandardMaterial,
  Texture,
  Vector3,
  VertexBuffer,
  type AbstractEngine,
  type AbstractMesh,
  type Camera,
  type MaterialDefines,
  type Nullable,
  type Observer,
  type Scene,
  type SubMesh,
  type TransformNode,
  type UniformBuffer,
} from '@babylonjs/core'
import { sceneExposure } from '@sro/world-render'

// ---- the tiers ----------------------------------------------------------------------------------------------------

export type Rgb = readonly [number, number, number]

export interface WeaponGlowTier {
  /** The + level this row starts at. A level takes the last row at or below it (+8 … draw +7 until rows are added). */
  readonly plus: number
  /** Steady glow and rim colour (sRGB 0..1). */
  readonly color: Rgb
  /** Colour of the shimmer band (sRGB 0..1). */
  readonly shimmerColor: Rgb
  /**
   * Steady emissive over the blade (0 = none). Display-relative: what the tone map sees after the post stack's
   * exposure (the glow divides by it, exposureScale), so a row reads alike by day and by night on the HDR presets;
   * Classic (no post exposure, no tone map) draws the lite code at LITE_GAIN.
   */
  readonly glow: number
  /** Extra at the silhouette, × (1 − |N·V|)³ (0 = none; display-relative like `glow`). */
  readonly rim: number
  /** Peak of the shimmer band that sweeps the blade from the base to the tip. */
  readonly shimmer: number
  /** Seconds from one sweep to the next (the band crosses the blade in SWEEP_SHARE of it). */
  readonly sweepS: number
  /** Depth 0..1 of the slow pulse on the glow and the rim (0 = steady). */
  readonly pulse: number
  /** Seconds per pulse. */
  readonly pulseS: number
  /** Retail glint runs along the blade per second (system_enchant_*.efp; 0 = none). Medium and up, capped. */
  readonly glints: number
}

/** Retail's enchant colours (system_enchant_a_01.efp plate colours): the blue aura and its pale core. */
export const RETAIL_BLUE: Rgb = [0x8c / 255, 0x97 / 255, 1]
export const RETAIL_PALE: Rgb = [0xd9 / 255, 0xfc / 255, 1]
/** +7's hotter glow: the blue halfway to the pale core. */
export const RETAIL_BRIGHT: Rgb = [(RETAIL_BLUE[0] + RETAIL_PALE[0]) / 2, (RETAIL_BLUE[1] + RETAIL_PALE[1]) / 2, 1]

/**
 * One row per + level from +1. Rows are data: add +8 … rows (or change these) without touching the code; `plus` must
 * rise. The values were set against the Jangan plaza at noon and dusk on Medium (docs: work/tmp/weapon-glow/).
 */
export const WEAPON_GLOW_TIERS: readonly WeaponGlowTier[] = [
  { plus: 1, color: RETAIL_PALE, shimmerColor: RETAIL_PALE, glow: 0, rim: 0, shimmer: 0.45, sweepS: 3.4, pulse: 0, pulseS: 3, glints: 0 },
  { plus: 2, color: RETAIL_PALE, shimmerColor: RETAIL_PALE, glow: 0.02, rim: 0.06, shimmer: 0.6, sweepS: 3, pulse: 0, pulseS: 3, glints: 0 },
  { plus: 3, color: RETAIL_BLUE, shimmerColor: RETAIL_PALE, glow: 0.06, rim: 0.15, shimmer: 0.75, sweepS: 2.6, pulse: 0, pulseS: 3, glints: 0 },
  { plus: 4, color: RETAIL_BLUE, shimmerColor: RETAIL_PALE, glow: 0.11, rim: 0.3, shimmer: 0.9, sweepS: 2.3, pulse: 0, pulseS: 3, glints: 0 },
  { plus: 5, color: RETAIL_BLUE, shimmerColor: RETAIL_PALE, glow: 0.18, rim: 0.48, shimmer: 1.05, sweepS: 2.1, pulse: 0.3, pulseS: 2.6, glints: 0 },
  { plus: 6, color: RETAIL_BLUE, shimmerColor: RETAIL_PALE, glow: 0.27, rim: 0.7, shimmer: 1.25, sweepS: 1.9, pulse: 0.35, pulseS: 2.2, glints: 0 },
  { plus: 7, color: RETAIL_BRIGHT, shimmerColor: RETAIL_PALE, glow: 0.39, rim: 0.95, shimmer: 1.5, sweepS: 1.7, pulse: 0.4, pulseS: 1.8, glints: 1 },
]

/** The tier of `plus` (null below the first row, i.e. +0). */
export function glowTierFor(plus: number | undefined, tiers: readonly WeaponGlowTier[] = WEAPON_GLOW_TIERS): WeaponGlowTier | null {
  if (!plus || !Number.isFinite(plus)) return null
  let hit: WeaponGlowTier | null = null
  for (const t of tiers) {
    if (t.plus <= plus) hit = t
    else break
  }
  return hit
}

/** Equip slots whose item glows (retail: weapons and shields). The fallback weapon takes the weapon's + level. */
export const GLOW_SLOTS = ['weapon', 'shield'] as const

// ---- the render mode --------------------------------------------------------------------------------------------

export interface GlowMode {
  /** Low (Classic): the cheap SROGLOW_LITE code. */
  lite: boolean
  /** Weapons that may show the +7 glint run at once (0: none). */
  glintCap: number
}

/** Glint runs at once per preset: your own character plus the nearest (CHAR_PERF's T1 caps, Ultra trimmed). */
export const GLINT_CAPS: Readonly<Record<'low' | 'medium' | 'high' | 'ultra', number>> = { low: 0, medium: 4, high: 6, ultra: 8 }

/** The glow's mode from the effective graphics of the actors' screen (settings.ts effectiveGraphics). */
export function glowModeFor(g: { render: 'classic' | 'pbr'; renderPreset: 'low' | 'medium' | 'high' | 'ultra' }): GlowMode {
  const lite = g.render !== 'pbr'
  return { lite, glintCap: lite ? 0 : GLINT_CAPS[g.renderPreset] }
}

// ---- the shader -------------------------------------------------------------------------------------------------

export const WEAPON_GLOW_PLUGIN = 'SroWeaponGlow'

/**
 * The plugin's uniforms (vec4 each, in the material's uniform buffer):
 *  sroGlowC glow colour (linear), sroGlowS shimmer colour (linear),
 *  sroGlowO blade origin (mesh space, the base), sroGlowD blade axis (mesh space, base → tip; w = band sharpness),
 *  sroGlowM blade mask edges along t (fade in from x to y, out from z to w),
 *  sroGlowK x glow, y shimmer, z band centre along t, w rim (the pulse folded in).
 */
export const GLOW_UNIFORMS = ['sroGlowC', 'sroGlowS', 'sroGlowO', 'sroGlowD', 'sroGlowM', 'sroGlowK'] as const

export const GLOW_DEFINES = { SROGLOW: false, SROGLOW_LITE: false }

const GLSL_CODE = `
#ifdef SROGLOW
{
#ifdef SROGLOW_LITE
  finalEmissive += sroGlowC.rgb * sroGlowK.x + sroGlowS.rgb * sroGlowK.y;
#else
  vec3 sgO = (world * vec4(sroGlowO.xyz, 1.0)).xyz;
  vec3 sgA = (world * vec4(sroGlowD.xyz, 0.0)).xyz;
  float sgT = dot(vPositionW - sgO, sgA) / max(dot(sgA, sgA), 1e-8);
  float sgMask = smoothstep(sroGlowM.x, sroGlowM.y, sgT) * (1.0 - smoothstep(sroGlowM.z, sroGlowM.w, sgT));
  float sgB = sgT - sroGlowK.z;
  float sgBand = exp2(-sgB * sgB * sroGlowD.w);
  float sgRim = 1.0 - abs(dot(normalW, viewDirectionW));
  sgRim = sgRim * sgRim * sgRim;
  float sgTex = clamp(1.0 - 0.8 * dot(surfaceAlbedo.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.6, 1.0);
  finalEmissive += (sroGlowC.rgb * ((sroGlowK.x + sroGlowK.w * sgRim) * sgTex) + sroGlowS.rgb * (sroGlowK.y * sgBand)) * sgMask;
#endif
}
#endif
`

const WGSL_CODE = `
#ifdef SROGLOW
{
#ifdef SROGLOW_LITE
  finalEmissive = finalEmissive + uniforms.sroGlowC.rgb * uniforms.sroGlowK.x + uniforms.sroGlowS.rgb * uniforms.sroGlowK.y;
#else
  let sgO = (mesh.world * vec4f(uniforms.sroGlowO.xyz, 1.0)).xyz;
  let sgA = (mesh.world * vec4f(uniforms.sroGlowD.xyz, 0.0)).xyz;
  let sgT = dot(fragmentInputs.vPositionW - sgO, sgA) / max(dot(sgA, sgA), 1e-8);
  let sgMask = smoothstep(uniforms.sroGlowM.x, uniforms.sroGlowM.y, sgT) * (1.0 - smoothstep(uniforms.sroGlowM.z, uniforms.sroGlowM.w, sgT));
  let sgB = sgT - uniforms.sroGlowK.z;
  let sgBand = exp2(-sgB * sgB * uniforms.sroGlowD.w);
  var sgRim = 1.0 - abs(dot(normalW, viewDirectionW));
  sgRim = sgRim * sgRim * sgRim;
  let sgTex = clamp(1.0 - 0.8 * dot(surfaceAlbedo.rgb, vec3f(0.2126, 0.7152, 0.0722)), 0.6, 1.0);
  finalEmissive = finalEmissive + (uniforms.sroGlowC.rgb * ((uniforms.sroGlowK.x + uniforms.sroGlowK.w * sgRim) * sgTex) + uniforms.sroGlowS.rgb * (uniforms.sroGlowK.y * sgBand)) * sgMask;
#endif
}
#endif
`

/** The fragment injection points of the glow per language (the same key in both; tests read them). */
export function weaponGlowCode(lang: 'wgsl' | 'glsl'): Readonly<Record<string, string>> {
  return { CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: lang === 'wgsl' ? WGSL_CODE : GLSL_CODE }
}

/** What the plugin asks of its manager. */
export interface GlowSource {
  /** The glow of a mesh (null: none). */
  stateOf(mesh: AbstractMesh): MeshGlow | null
  /** Low (Classic) draws the cheap code. */
  readonly lite: boolean
  /** Writes a glowing mesh's values for this draw. */
  writeUniforms(ubo: UniformBuffer, glow: MeshGlow): void
}

/**
 * The glow on one glTF material (shared by every actor wearing the model): per-mesh defines and per-draw uniforms.
 * Priority 300: after SroSurfacePlugin (250), whose SRO_SELFLIT rewrites finalEmissive at the same point.
 */
export class WeaponGlowPlugin extends MaterialPluginBase {
  constructor(material: Material, readonly source: GlowSource) {
    super(material, WEAPON_GLOW_PLUGIN, 300, { ...GLOW_DEFINES }, true, false)
    // hardBindForSubMesh runs on every draw (bindForSubMesh only when the material rebinds): the per-mesh values.
    this.registerForExtraEvents = true
    this._enable(true)
  }

  override getClassName(): string {
    return WEAPON_GLOW_PLUGIN
  }

  /** WGSL and GLSL both. */
  override isCompatible(): boolean {
    return true
  }

  override prepareDefines(defines: MaterialDefines, _scene?: Scene, mesh?: AbstractMesh): void {
    const d = defines as MaterialDefines & Record<string, unknown>
    const on = !!mesh && this.source.stateOf(mesh) !== null
    // Instances take their world from attributes: the mesh's `world` is not theirs, so they draw the lite code.
    const lite = on && (this.source.lite || d.INSTANCES === true || d.THIN_INSTANCES === true)
    if (d.SROGLOW !== on || d.SROGLOW_LITE !== lite) {
      d.SROGLOW = on
      d.SROGLOW_LITE = lite
      defines.markAsUnprocessed()
    }
  }

  override getUniforms(shaderLanguage?: ShaderLanguage): { ubo: Array<{ name: string; size: number; type: string }>; fragment: string } {
    return {
      ubo: GLOW_UNIFORMS.map(name => ({ name, size: 4, type: 'vec4' })),
      fragment: shaderLanguage === ShaderLanguage.WGSL ? '' : GLOW_UNIFORMS.map(n => `uniform vec4 ${n};`).join('\n'),
    }
  }

  override hardBindForSubMesh(ubo: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void {
    const glow = this.source.stateOf(subMesh.getMesh())
    if (glow) this.source.writeUniforms(ubo, glow)
  }

  override getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Record<string, string> | null {
    if (shaderType !== 'fragment') return null
    return { ...weaponGlowCode(shaderLanguage === ShaderLanguage.WGSL ? 'wgsl' : 'glsl') }
  }
}

/** The glow plugin of a material (null: none). */
export function weaponGlowPluginOf(mat: Material | null | undefined): WeaponGlowPlugin | null {
  const p = mat?.pluginManager?.getPlugin(WEAPON_GLOW_PLUGIN)
  return p instanceof WeaponGlowPlugin ? p : null
}

// ---- the manager ------------------------------------------------------------------------------------------------

/** Who wears a glowing item (CharacterActor has all of it). */
export interface GlowOwner {
  readonly root: TransformNode
  /** Your own character (EntityView sets it): glints first. */
  readonly lodFull: boolean
  readonly isOffscreen: boolean
}

/** An item to light: its meshes, its root (the space of the sidecar dummies) and the dummies it carries. */
export interface GlowItemSpec {
  meshes: readonly AbstractMesh[]
  root: TransformNode
  /** Dummy positions in the root's space (glTF metres): `ai_start` / `ai_end` give the blade. */
  dummies: ReadonlyMap<string, { x: number; y: number; z: number }>
  /** × the tier's intensities (default 1; shields SHIELD_STRENGTH). */
  strength?: number
}

/** Shields glow at this share of a weapon: their whole face catches the glow and the rim. */
export const SHIELD_STRENGTH = 0.4

/** The band crosses the blade in this share of a sweep; the rest of the sweep it is off the blade. */
export const SWEEP_SHARE = 0.45
/** exp2(−d² k): the band's sharpness along t (half-height at d ≈ 0.09 of the blade). */
export const BAND_SHARPNESS = 120
/** Lite: the rim folded into the steady glow, and the whole-weapon flash of a sweep, as shares of the full values. */
export const LITE_RIM = 0.3
export const LITE_FLASH = 0.35
/**
 * Lite: × everything. Classic adds the emissive straight to the display colour (no tone map to roll it off) on a lit
 * blade that is already ≈ 0.35 there, so the full values clip to white (+7) and flat blue (+5).
 */
export const LITE_GAIN = 0.5

/** One glowing item (a weapon or shield on one actor). */
export interface ItemGlow {
  readonly owner: GlowOwner
  readonly tier: WeaponGlowTier
  /** The tier's colours in linear space (the uniforms). */
  readonly color: Color3
  readonly shimmerColor: Color3
  readonly meshes: readonly AbstractMesh[]
  /** 0..1, per owner: pulses and sweeps are not in step across players. */
  readonly phase: number
  /** × the tier's glow, rim and shimmer (shields: SHIELD_STRENGTH, their whole face catches the glow). */
  readonly strength: number
  /** Blade base and tip in the first mesh's space (the glint run goes tip → base). */
  readonly base: Vector3
  readonly tip: Vector3
  /** The blade's length (m): the glints' size. */
  readonly length: number
  /** Whether the axis came from the sidecar's blade dummies (else the item's box). */
  readonly blade: boolean
}

/** The glow of one mesh: its item, the blade in the mesh's own space and the mask edges. */
export interface MeshGlow {
  readonly item: ItemGlow
  readonly origin: Vector3
  readonly axis: Vector3
  readonly mask: readonly [number, number, number, number]
}

/** Blade mask along t: the grip fades out below the base, the tip is kept. A box axis covers the whole item. */
const BLADE_MASK = [-0.35, -0.02, 1.15, 1.3] as const
const BOX_MASK = [-1, -0.5, 1.5, 2] as const

const linear = (c: Rgb): Color3 => new Color3(c[0], c[1], c[2]).toLinearSpace()

/** Pulse factor at time `s` (1 ± pulse). */
export function pulseAt(tier: WeaponGlowTier, s: number, phase: number): number {
  if (tier.pulse <= 0) return 1
  return 1 + tier.pulse * Math.sin(2 * Math.PI * (s / tier.pulseS + phase))
}

/** The band centre along t at time `s` (from −0.25 to 1.25 during SWEEP_SHARE of the sweep; far off after). */
export function bandAt(tier: WeaponGlowTier, s: number, phase: number): number {
  const u = (((s / tier.sweepS + phase) % 1) + 1) % 1
  return u < SWEEP_SHARE ? -0.25 + 1.5 * (u / SWEEP_SHARE) : 99
}

/** The post stack's exposure at noon on the HDR presets (measured ×10.9 at the plaza, 13:00, Medium; ≈ ×30 at night). */
export const NOON_EXPOSURE = 11
/** How much brighter the glow reads in the dark: display × (exposure / noon)^NIGHT_LIFT (≈ 1.05× at night). */
export const NIGHT_LIFT = 0.05

/**
 * The factor from the tiers' display-relative values to scene-linear emissive at the post stack's `exposure`: 1 on
 * Classic (no post exposure), 1/11 at noon, and a little more than 1/30 at night (the glow lifts a bit in the dark).
 */
export function exposureScale(exposure: number): number {
  if (!(exposure > 1)) return 1
  return Math.pow(exposure / NOON_EXPOSURE, NIGHT_LIFT) / exposure
}

/** The uniform values of a glowing mesh at time `s` (seconds): [C, S, O, D, M, K], 4 floats each. */
export function glowValues(g: MeshGlow, s: number, lite: boolean, scale = 1, out = new Float32Array(24)): Float32Array {
  const it = g.item
  const t = it.tier
  const p = pulseAt(t, s, it.phase)
  const band = bandAt(t, s, it.phase)
  const c = it.color
  const sc = it.shimmerColor
  out[0] = c.r
  out[1] = c.g
  out[2] = c.b
  out[3] = 1
  out[4] = sc.r
  out[5] = sc.g
  out[6] = sc.b
  out[7] = 1
  out[8] = g.origin.x
  out[9] = g.origin.y
  out[10] = g.origin.z
  out[11] = 0
  out[12] = g.axis.x
  out[13] = g.axis.y
  out[14] = g.axis.z
  out[15] = BAND_SHARPNESS
  for (let i = 0; i < 4; i++) out[16 + i] = g.mask[i]!
  const k = it.strength * scale
  if (lite) {
    // A short whole-weapon flash while the band would cross the blade.
    const flash = band >= 0 && band <= 1 ? Math.sin(Math.PI * band) : 0
    out[20] = (t.glow + t.rim * LITE_RIM) * p * k * LITE_GAIN
    out[21] = t.shimmer * LITE_FLASH * flash * k * LITE_GAIN
    out[22] = 0
    out[23] = 0
  } else {
    out[20] = t.glow * p * k
    out[21] = t.shimmer * k
    out[22] = band
    out[23] = t.rim * p * k
  }
  return out
}

export interface WeaponGlowOptions {
  /** The current mode (Low/Classic → lite; glint cap). Read once a frame. */
  mode?: () => GlowMode
  /** Seconds (default performance.now()). */
  now?: () => number
  /** The post stack's exposure (default @sro/world-render sceneExposure: 1 on Classic). Read once a frame. */
  exposure?: () => number
  /** Where /out/ is served (the glint texture). */
  out?: string
}

const tmpM = new Matrix()
const tmpV = new Vector3()

/**
 * The glow of one scene's actors (ModelLibrary owns one per scene). `light(owner, item, plus)` lights an item's
 * meshes (or clears them at +0); disposing a mesh clears it. Materials get the plugin the first time one of their
 * meshes is prepared (`prepare`, called when an item is hung, before its first draw), so a glow that comes later
 * changes defines only, never the material's uniform layout.
 */
export class WeaponGlow implements GlowSource {
  private readonly meshes = new WeakMap<AbstractMesh, MeshGlow>()
  /** Meshes whose disposal already clears their glow. */
  private readonly hooked = new WeakSet<AbstractMesh>()
  private readonly items = new Set<ItemGlow>()
  private readonly plugins = new WeakMap<Material, WeaponGlowPlugin>()
  private readonly frameObs: Nullable<Observer<Scene>>
  private readonly now: () => number
  private readonly modeOf: () => GlowMode
  private readonly exposureOf: () => number
  private modeNow: GlowMode
  private seconds = 0
  /** exposureScale of this frame. */
  private scale = 1
  private readonly values = new Float32Array(24)
  private glintsPart: WeaponGlints | null = null
  private disposed = false

  constructor(readonly scene: Scene, private readonly opts: WeaponGlowOptions = {}) {
    this.now = opts.now ?? (() => performance.now() / 1000)
    this.modeOf = opts.mode ?? (() => ({ lite: false, glintCap: GLINT_CAPS.medium }))
    this.exposureOf = opts.exposure ?? (() => sceneExposure(scene))
    this.modeNow = this.modeOf()
    this.seconds = this.now()
    this.scale = exposureScale(this.exposureOf())
    this.frameObs = scene.onBeforeRenderObservable.add(() => this.frame())
  }

  get lite(): boolean {
    return this.modeNow.lite
  }

  get mode(): Readonly<GlowMode> {
    return this.modeNow
  }

  /** Glowing items (tests, the console). */
  get live(): ReadonlySet<ItemGlow> {
    return this.items
  }

  /** The glint batch (created with the first +7 item). */
  get glints(): WeaponGlints | null {
    return this.glintsPart
  }

  stateOf(mesh: AbstractMesh): MeshGlow | null {
    return this.meshes.get(mesh) ?? null
  }

  /** The exposure factor of this frame (tests, the console). */
  get exposureFactor(): number {
    return this.scale
  }

  writeUniforms(ubo: UniformBuffer, glow: MeshGlow): void {
    const v = glowValues(glow, this.seconds, this.modeNow.lite, this.scale, this.values)
    for (let i = 0; i < GLOW_UNIFORMS.length; i++) ubo.updateFloat4(GLOW_UNIFORMS[i]!, v[i * 4]!, v[i * 4 + 1]!, v[i * 4 + 2]!, v[i * 4 + 3]!)
  }

  /** Puts the plugin on the meshes' PBR materials (once per material). Call when an item is hung. */
  prepare(meshes: readonly AbstractMesh[]): void {
    if (this.disposed) return
    for (const m of meshes) {
      const mat = m.material
      if (!(mat instanceof PBRMaterial) || this.plugins.has(mat)) continue
      const have = weaponGlowPluginOf(mat)
      this.plugins.set(mat, have ?? new WeaponGlowPlugin(mat, this))
    }
  }

  /**
   * Lights `spec`'s meshes at `plus` (glowTierFor; below the first tier: cleared). Returns the item (null: none).
   * A new call for the same meshes replaces the old one.
   */
  light(owner: GlowOwner, spec: GlowItemSpec, plus: number | undefined): ItemGlow | null {
    this.clear(spec.meshes)
    const tier = glowTierFor(plus)
    const meshes = spec.meshes.filter(m => !m.isDisposed() && m.getTotalVertices() > 0)
    if (!tier || !meshes.length || this.disposed) return null
    this.prepare(meshes)
    const space = bladeSpace(spec, meshes)
    const first = meshes[0]!
    const toFirst = itemToMesh(spec.root, first)
    const item: ItemGlow = {
      owner,
      tier,
      color: linear(tier.color),
      shimmerColor: linear(tier.shimmerColor),
      meshes,
      phase: phaseOf(owner.root.uniqueId),
      strength: spec.strength ?? 1,
      base: Vector3.TransformCoordinates(space.base, toFirst),
      tip: Vector3.TransformCoordinates(space.tip, toFirst),
      length: Vector3.Distance(space.base, space.tip),
      blade: space.blade,
    }
    for (const m of meshes) {
      const toMesh = itemToMesh(spec.root, m)
      const o = Vector3.TransformCoordinates(space.base, toMesh)
      const axis = Vector3.TransformCoordinates(space.tip, toMesh).subtractInPlace(o)
      this.meshes.set(m, { item, origin: o, axis, mask: space.blade ? BLADE_MASK : BOX_MASK })
      if (!this.hooked.has(m)) {
        this.hooked.add(m)
        m.onDisposeObservable.addOnce(() => this.clear([m]))
      }
    }
    this.items.add(item)
    if (tier.glints > 0 && !this.glintsPart) this.glintsPart = new WeaponGlints(this.scene, this.opts.out ?? '/out/')
    return item
  }

  /** Clears the glow of these meshes (and their items). */
  clear(meshes: readonly AbstractMesh[]): void {
    for (const m of meshes) {
      const g = this.meshes.get(m)
      if (!g) continue
      this.meshes.delete(m)
      this.items.delete(g.item)
    }
  }

  /** Once a frame (before the render): the clock, the mode, the glints. */
  frame(): void {
    if (this.disposed) return
    this.seconds = this.now()
    this.modeNow = this.modeOf()
    this.scale = exposureScale(this.exposureOf())
    this.glintsPart?.update(this.items, this.modeNow.glintCap, this.seconds)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.frameObs) this.scene.onBeforeRenderObservable.remove(this.frameObs)
    this.items.clear()
    this.glintsPart?.dispose()
    this.glintsPart = null
  }
}

/** A stable 0..1 per owner (golden-ratio spread of the node id). */
function phaseOf(id: number): number {
  return (id * 0.6180339887) % 1
}

/** The matrix taking item-root space to `mesh`'s local space (both under the same bone, so it never changes). */
function itemToMesh(root: TransformNode, mesh: AbstractMesh): Matrix {
  const r = root.computeWorldMatrix(true)
  const w = mesh.computeWorldMatrix(true)
  w.invertToRef(tmpM)
  return r.multiply(tmpM)
}

/**
 * The blade in item-root space: `ai_start` → `ai_end` when the sidecar has both (swords, blades, spears, glaives),
 * else the longest side of the meshes' box through its centre (bows, shields).
 */
function bladeSpace(spec: GlowItemSpec, meshes: readonly AbstractMesh[]): { base: Vector3; tip: Vector3; blade: boolean } {
  const a = spec.dummies.get('ai_start')
  const b = spec.dummies.get('ai_end')
  if (a && b && Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 0.05) return { base: new Vector3(a.x, a.y, a.z), tip: new Vector3(b.x, b.y, b.z), blade: true }
  const inv = spec.root.computeWorldMatrix(true).clone().invert()
  const min = new Vector3(Infinity, Infinity, Infinity)
  const max = new Vector3(-Infinity, -Infinity, -Infinity)
  for (const m of meshes) {
    // A forced world matrix also moves the bounding box's world corners.
    m.computeWorldMatrix(true)
    for (const p of m.getBoundingInfo().boundingBox.vectorsWorld) {
      Vector3.TransformCoordinatesToRef(p, inv, tmpV)
      min.minimizeInPlace(tmpV)
      max.maximizeInPlace(tmpV)
    }
  }
  if (!Number.isFinite(min.x)) return { base: Vector3.Zero(), tip: new Vector3(0, 0, 1), blade: false }
  const size = max.subtract(min)
  const centre = min.add(max).scaleInPlace(0.5)
  const k = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2
  const half = new Vector3(k === 0 ? size.x / 2 : 0, k === 1 ? size.y / 2 : 0, k === 2 ? size.z / 2 : 0)
  return { base: centre.subtract(half), tip: centre.add(half), blade: false }
}

// ---- the +7 glints ----------------------------------------------------------------------------------------------

/** Glints of one run (retail: five bursts, three frames apart at 20 fps). */
export const GLINTS_PER_RUN = 5
export const GLINT_STEP_S = 0.15
/** A burst's life (s) and the quads it draws (the blue aura and its pale core). */
export const GLINT_LIFE_S = 0.55
const LAYERS = 2
/** Others' weapons farther than this from the camera show no glints (your own always may). */
export const GLINT_RANGE_M = 25
/** The burst size per metre of blade (retail: plate 0.1 m × the table's 130 % on a 0.66 m sword, × ≈ 2–5 over its life). */
const GLINT_SIZE_PER_M = 0.2
/** The retail texture of the bursts. */
export const GLINT_TEXTURE = 'fx/tex/textures/oura_19.png'

const QUAD_IDX = [0, 1, 2, 0, 2, 3]
const QUAD_UV = [0, 0, 1, 0, 1, 1, 0, 1]

/** Size and alpha of a burst at `age` (0..1 of its life): a quick flare, then a soft fade (the retail curves, smoothed). */
export function glintCurve(age: number): { size: number; alpha: number } {
  if (age < 0 || age >= 1) return { size: 0, alpha: 0 }
  const rise = Math.min(1, age / 0.3)
  const alpha = age < 0.3 ? rise * 0.6 : 0.6 * (1 - (age - 0.3) / 0.7) ** 1.5
  const size = 0.8 + 1.4 * Math.sin(Math.min(1, age / 0.6) * Math.PI * 0.5)
  return { size, alpha }
}

/** Which items show glints this frame: your own first, then the nearest on screen within range, at most `cap`. */
export function pickGlinting(items: Iterable<ItemGlow>, cap: number, eye: Vector3 | null): ItemGlow[] {
  if (cap <= 0) return []
  const out: { item: ItemGlow; key: number }[] = []
  for (const it of items) {
    if (it.tier.glints <= 0 || it.owner.isOffscreen) continue
    const m = it.meshes[0]
    if (!m || m.isDisposed() || !m.isEnabled() || !m.isVisible || m.visibility <= 0.05) continue
    const self = it.owner.lodFull
    const d = eye ? Vector3.Distance(eye, it.owner.root.getAbsolutePosition()) : 0
    if (!self && d > GLINT_RANGE_M) continue
    out.push({ item: it, key: self ? -1 : d })
  }
  out.sort((a, b) => a.key - b.key)
  return out.slice(0, cap).map(e => e.item)
}

/**
 * The +7 glint runs of every chosen weapon in one additive draw (the fx renderer's unlit material: texture × vertex
 * colour). Built on the CPU each frame: ≤ cap × 5 bursts × 2 quads.
 */
export class WeaponGlints {
  readonly mesh: Mesh
  private readonly material: StandardMaterial
  private capacity = 0
  private positions = new Float32Array(0)
  private colors = new Float32Array(0)
  private uvs = new Float32Array(0)
  /** Quads drawn last frame (tests). */
  drawn = 0
  /** Items that showed glints last frame (tests). */
  shown: ItemGlow[] = []
  private readonly blue = linear(RETAIL_BLUE)
  private readonly pale = linear(RETAIL_PALE)

  constructor(readonly scene: Scene, out: string) {
    const mat = new StandardMaterial('weaponGlints', scene)
    mat.disableLighting = true
    mat.emissiveColor = Color3.White()
    mat.diffuseColor = Color3.Black()
    mat.specularColor = Color3.Black()
    mat.ambientColor = Color3.Black()
    mat.fogEnabled = false
    const tex = new Texture(out + GLINT_TEXTURE, scene, { invertY: false, samplingMode: Texture.TRILINEAR_SAMPLINGMODE })
    tex.hasAlpha = true
    mat.diffuseTexture = tex
    mat.useAlphaFromDiffuseTexture = true
    mat.transparencyMode = Material.MATERIAL_ALPHABLEND
    mat.alphaMode = Constants.ALPHA_ADD
    mat.disableDepthWrite = true
    mat.backFaceCulling = false
    this.material = mat
    this.mesh = new Mesh('weaponGlints', scene)
    this.mesh.material = mat
    this.mesh.isPickable = false
    this.mesh.alwaysSelectAsActiveMesh = true
    this.mesh.hasVertexAlpha = true
    this.mesh.isVisible = false
  }

  private ensure(quads: number): void {
    if (quads <= this.capacity) return
    let cap = Math.max(16, this.capacity)
    while (cap < quads) cap *= 2
    this.capacity = cap
    this.positions = new Float32Array(cap * 12)
    this.colors = new Float32Array(cap * 16)
    this.uvs = new Float32Array(cap * 8)
    const idx = new Uint32Array(cap * 6)
    for (let q = 0; q < cap; q++) {
      for (let k = 0; k < 6; k++) idx[q * 6 + k] = QUAD_IDX[k]! + q * 4
      this.uvs.set(QUAD_UV, q * 8)
    }
    this.mesh.setVerticesData(VertexBuffer.PositionKind, this.positions, true, 3)
    this.mesh.setVerticesData(VertexBuffer.ColorKind, this.colors, true, 4)
    this.mesh.setVerticesData(VertexBuffer.UVKind, this.uvs, false, 2)
    this.mesh.setIndices(idx)
  }

  update(items: Iterable<ItemGlow>, cap: number, seconds: number): void {
    const camera: Camera | null = this.scene.activeCamera
    const chosen = pickGlinting(items, cap, camera?.globalPosition ?? null)
    this.shown = chosen
    if (!chosen.length || !camera) {
      this.drawn = 0
      this.mesh.isVisible = false
      return
    }
    this.ensure(chosen.length * GLINTS_PER_RUN * LAYERS)
    const cw = camera.getWorldMatrix().m
    const right = new Vector3(cw[0]!, cw[1]!, cw[2]!).normalize()
    const up = new Vector3(cw[4]!, cw[5]!, cw[6]!).normalize()
    const tip = new Vector3()
    const base = new Vector3()
    const at = new Vector3()
    let q = 0
    for (const it of chosen) {
      const m = it.meshes[0]!
      const w = m.computeWorldMatrix(true)
      Vector3.TransformCoordinatesToRef(it.tip, w, tip)
      Vector3.TransformCoordinatesToRef(it.base, w, base)
      const length = Vector3.Distance(tip, base)
      const unit = Math.max(0.06, GLINT_SIZE_PER_M * Math.max(0.5, Math.min(1.2, length)))
      const period = 1 / it.tier.glints
      const run = ((((seconds * it.tier.glints + it.phase) % 1) + 1) % 1) * period
      const fade = m.visibility
      for (let i = 0; i < GLINTS_PER_RUN; i++) {
        Vector3.LerpToRef(tip, base, i / (GLINTS_PER_RUN - 1), at)
        for (let layer = 0; layer < LAYERS; layer++) {
          const start = (i + layer) * GLINT_STEP_S
          const life = GLINT_LIFE_S - layer * 0.1
          // This run's burst, or the tail of the previous run's (the last bursts outlive the period).
          let age = (run - start) / life
          if (age < 0) age = (run + period - start) / life
          const { size, alpha } = glintCurve(age)
          if (alpha <= 0.002 || q >= this.capacity) continue
          const s = unit * size * (layer ? 0.55 : 1)
          const spin = (seconds * 0.7 + i * 1.3 + layer) % (2 * Math.PI)
          const col = layer ? this.pale : this.blue
          this.quad(q++, at, right, up, s, spin, col, alpha * fade)
        }
      }
    }
    // Unused quads collapse to nothing.
    this.positions.fill(0, q * 12)
    this.colors.fill(0, q * 16)
    this.drawn = q
    this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.positions)
    this.mesh.updateVerticesData(VertexBuffer.ColorKind, this.colors)
    this.mesh.isVisible = q > 0
  }

  private quad(q: number, c: Vector3, right: Vector3, up: Vector3, size: number, spin: number, col: Color3, alpha: number): void {
    const h = size / 2
    const cs = Math.cos(spin) * h
    const sn = Math.sin(spin) * h
    // The quad's own axes, turned by `spin` in the camera plane.
    const rx = right.x * cs + up.x * sn
    const ry = right.y * cs + up.y * sn
    const rz = right.z * cs + up.z * sn
    const ux = up.x * cs - right.x * sn
    const uy = up.y * cs - right.y * sn
    const uz = up.z * cs - right.z * sn
    const p = this.positions
    const o = q * 12
    p[o] = c.x - rx + ux
    p[o + 1] = c.y - ry + uy
    p[o + 2] = c.z - rz + uz
    p[o + 3] = c.x + rx + ux
    p[o + 4] = c.y + ry + uy
    p[o + 5] = c.z + rz + uz
    p[o + 6] = c.x + rx - ux
    p[o + 7] = c.y + ry - uy
    p[o + 8] = c.z + rz - uz
    p[o + 9] = c.x - rx - ux
    p[o + 10] = c.y - ry - uy
    p[o + 11] = c.z - rz - uz
    const k = q * 16
    for (let v = 0; v < 4; v++) {
      this.colors[k + v * 4] = col.r
      this.colors[k + v * 4 + 1] = col.g
      this.colors[k + v * 4 + 2] = col.b
      this.colors[k + v * 4 + 3] = alpha
    }
  }

  dispose(): void {
    this.mesh.dispose(false, false)
    this.material.diffuseTexture?.dispose()
    this.material.dispose()
  }
}
