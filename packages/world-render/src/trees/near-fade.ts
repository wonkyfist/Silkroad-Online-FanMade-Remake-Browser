/**
 * The camera-near foliage fade (docs/FOREST.md D-F18, §5.5): foliage fragments near the camera, and leaf fragments in
 * the capsule from the camera to the player's head, are screen-door dithered out (a 4 × 4 Bayer threshold, so an
 * alpha-tested card needs no blending or sorting). The game camera (default 9 m, 2.5–40 m) often sits inside a crown in
 * a forest; without the fade the cards in front of the lens fill the view and hide the player.
 *
 * - **Which materials:** foliage only, on both paths and every backend. PBR: a material carrying the foliage plugin
 *   (the retail trees, bushes and flowers ObjectMaterials converts, the region batch's tree groups and the new species'
 *   LOD0 overlay, which all share `PbrFoliage`), never a cloth group. Classic / Low: a StandardMaterial ObjectMaterials
 *   converted for a foliage model (`isFoliageModel`, tagged by `NearFade.attach`'s decorator as `metadata.sroNearFade`).
 *   Leaves (class foliage, or an alpha-tested Classic material) take both fades; wood takes only the near one. Never a
 *   skinned character, the grass field (its own shader) or any other material.
 * - **The fade:** k = min(near, capsule) of two linear ramps, discard when k ≤ the pixel's Bayer threshold.
 *   near = saturate((d − NEAR_GONE_M) / (NEAR_START_M − NEAR_GONE_M)), d = distance to the camera; capsule =
 *   saturate((r − CAPSULE_R_M) / CAPSULE_FEATHER_M), r = distance to the segment camera → target, × the capsule gate.
 *   At k = 1 nothing is discarded, at k = 0 everything; in between the share kept is k.
 * - **Uniforms only:** the camera, the target and the numbers are three vec4s written into the material UBOs at bind
 *   (no allocation, no define change per frame). The defines (`SRO_NFADE`, `SRO_NFADE_CAP`) depend only on the material
 *   and the switch `enabled`, so nothing recompiles from frame to frame. The code runs first in the fragment
 *   (CUSTOM_FRAGMENT_MAIN_BEGIN), so a discarded fragment skips every texture fetch after it.
 * - **The capsule** runs while the active camera has a `target` (the game's ArcRotateCamera aims at the player's head,
 *   1.5 m above the feet) at least CAPSULE_MIN_M away; a free camera (the editors) gets only the near fade.
 * - Shadows are untouched: the casters draw with their own depth shaders, so a faded crown still shades the ground.
 *
 * Registered with Babylon's plugin factory (again on every install: an engine rebuild clears the factories), like the
 * snow plugins (winter/plugin.ts); the plugin goes on every PBR and Standard material of the scene, and its code is
 * behind defines that are on for foliage only.
 */
import {
  ArcRotateCamera,
  MaterialPluginBase,
  PBRBaseMaterial,
  RegisterMaterialPlugin,
  ShaderLanguage,
  StandardMaterial,
  Vector3,
  Vector4,
  type AbstractMesh,
  type Camera,
  type Material,
  type MaterialDefines,
  type Scene,
  type UniformBuffer,
} from '@babylonjs/core'
import { isFoliageModel } from '../pbr/classes.ts'
import { foliagePluginOf } from '../pbr/foliage-plugin.ts'

export const NEAR_FADE_PLUGIN = 'SroNearFadePlugin'
/** Foliage starts to thin this far from the camera (m). */
export const NEAR_START_M = 6
/** ... and is gone this close (m). */
export const NEAR_GONE_M = 2
/** Leaves within this distance of the camera → target segment are gone (m). */
export const CAPSULE_R_M = 1.2
/** ... and fully back this much further out (m): about half are kept at 1.6 m. */
export const CAPSULE_FEATHER_M = 0.8
/** The capsule runs only while the camera is at least this far from its target (m). */
export const CAPSULE_MIN_M = 0.5
/** The defines: the near fade (all foliage) and the capsule (leaves). */
export const NEAR_FADE_DEFINES: readonly string[] = ['SRO_NFADE', 'SRO_NFADE_CAP']
/** The UBO members (vec4): camera xyz + on; target xyz + capsule gate; numbers. */
export const NEAR_FADE_UNIFORMS: readonly string[] = ['sroNfA', 'sroNfB', 'sroNfC']

/** What a material is to the fade. */
export type NearFadeKind = 'leaf' | 'wood' | null

// ---- the TS mirror (tests) ----------------------------------------------------------------------------------------

/** The 4 × 4 Bayer value (0..15) of pixel (x, y): the shader's bit form. */
export function bayer4(x: number, y: number): number {
  const ix = x & 3, iy = y & 3, xy = ix ^ iy
  return ((xy & 1) << 3) | ((iy & 1) << 2) | (xy & 2) | ((iy & 2) >> 1)
}

/** The share of a fragment kept (k, 0..1) at `distM` from the camera and `rayM` from the camera → target segment. */
export function nearFadeKeep(distM: number, rayM = Infinity, capsule = 1): number {
  const sat = (v: number) => Math.min(1, Math.max(0, v))
  const near = sat((distM - NEAR_GONE_M) / (NEAR_START_M - NEAR_GONE_M))
  const cap = 1 - capsule * (1 - sat((rayM - CAPSULE_R_M) / CAPSULE_FEATHER_M))
  return Math.min(near, cap)
}

/** Whether the shader keeps a fragment of share `keep` at pixel (x, y). */
export function nearFadeKeeps(keep: number, x: number, y: number): boolean {
  return keep > (bayer4(x, y) + 0.5) / 16
}

// ---- shader code --------------------------------------------------------------------------------------------------

const MAIN_WGSL = /* wgsl */ `#ifdef SRO_NFADE
if (uniforms.sroNfA.w > 0.5) {
  let nfP = fragmentInputs.vPositionW;
  var nfK = clamp((distance(nfP, uniforms.sroNfA.xyz) - uniforms.sroNfC.x) * uniforms.sroNfC.y, 0.0, 1.0);
#ifdef SRO_NFADE_CAP
  let nfAB = uniforms.sroNfB.xyz - uniforms.sroNfA.xyz;
  let nfT = clamp(dot(nfP - uniforms.sroNfA.xyz, nfAB) / max(dot(nfAB, nfAB), 0.0001), 0.0, 1.0);
  let nfR = distance(nfP, uniforms.sroNfA.xyz + nfAB * nfT);
  nfK = min(nfK, 1.0 - uniforms.sroNfB.w * (1.0 - clamp((nfR - uniforms.sroNfC.z) * uniforms.sroNfC.w, 0.0, 1.0)));
#endif
  if (nfK < 1.0) {
    let nfQ = vec2u(fragmentInputs.position.xy) & vec2u(3u);
    let nfX = nfQ.x ^ nfQ.y;
    let nfB = ((nfX & 1u) << 3u) | ((nfQ.y & 1u) << 2u) | (nfX & 2u) | ((nfQ.y & 2u) >> 1u);
    if (nfK <= (f32(nfB) + 0.5) * 0.0625) {
      discard;
    }
  }
}
#endif
`
const MAIN_GLSL = /* glsl */ `#ifdef SRO_NFADE
if (sroNfA.w > 0.5) {
  vec3 nfP = vPositionW;
  float nfK = clamp((distance(nfP, sroNfA.xyz) - sroNfC.x) * sroNfC.y, 0.0, 1.0);
#ifdef SRO_NFADE_CAP
  vec3 nfAB = sroNfB.xyz - sroNfA.xyz;
  float nfT = clamp(dot(nfP - sroNfA.xyz, nfAB) / max(dot(nfAB, nfAB), 0.0001), 0.0, 1.0);
  float nfR = distance(nfP, sroNfA.xyz + nfAB * nfT);
  nfK = min(nfK, 1.0 - sroNfB.w * (1.0 - clamp((nfR - sroNfC.z) * sroNfC.w, 0.0, 1.0)));
#endif
  if (nfK < 1.0) {
    uvec2 nfQ = uvec2(gl_FragCoord.xy) & uvec2(3u);
    uint nfX = nfQ.x ^ nfQ.y;
    uint nfB = ((nfX & 1u) << 3u) | ((nfQ.y & 1u) << 2u) | (nfX & 2u) | ((nfQ.y & 2u) >> 1u);
    if (nfK <= (float(nfB) + 0.5) * 0.0625) {
      discard;
    }
  }
}
#endif
`

/** The injection points (fragment only; the same key in both languages, PBR and Standard alike). */
export function nearFadeCode(lang: 'wgsl' | 'glsl'): Readonly<Record<string, string>> {
  return { CUSTOM_FRAGMENT_MAIN_BEGIN: lang === 'wgsl' ? MAIN_WGSL : MAIN_GLSL }
}

// ---- the state and the plugin -------------------------------------------------------------------------------------

/** The fade of one scene: the switch and the shared uniform values. */
export class NearFadeState {
  /** The switch (a define change: one recompile per foliage material when it flips; `setEnabled`). */
  enabled = true
  /** Camera xyz, w = 1 while a camera was seen. */
  readonly a = new Vector4(0, 0, 0, 0)
  /** Target xyz, w = the capsule gate (0 / 1). */
  readonly b = new Vector4(0, 0, 0, 0)
  /** x gone distance, y 1 / (start − gone), z capsule radius, w 1 / feather. */
  readonly c = new Vector4(NEAR_GONE_M, 1 / (NEAR_START_M - NEAR_GONE_M), CAPSULE_R_M, 1 / CAPSULE_FEATHER_M)
  readonly plugins = new Set<SroNearFadePlugin>()
  private readonly offs: Array<() => void> = []

  constructor(readonly scene: Scene) {}

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    for (const p of this.plugins) p.markAllDefinesAsDirty()
  }

  /** Sets the ramps (m); uniforms only. */
  setRange(startM: number, goneM: number, capsuleM = CAPSULE_R_M, featherM = CAPSULE_FEATHER_M): void {
    const gone = Math.max(0, goneM)
    this.c.set(gone, 1 / Math.max(0.01, startM - gone), Math.max(0, capsuleM), 1 / Math.max(0.01, featherM))
  }

  /**
   * Per frame (World.update): the camera and, for an orbit camera, its target. No allocation; uniforms only.
   * `target` overrides the camera's own (null: none).
   */
  update(camera: Camera | null, target?: { x: number; y: number; z: number } | null): void {
    if (!camera) {
      this.a.w = 0
      return
    }
    const p = camera.globalPosition
    this.a.set(p.x, p.y, p.z, 1)
    const t = target !== undefined ? target : camera instanceof ArcRotateCamera ? camera.target : (camera as Camera & { target?: unknown }).target instanceof Vector3 ? (camera as Camera & { target: Vector3 }).target : null
    if (!t) {
      this.b.w = 0
      return
    }
    const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z
    this.b.set(t.x, t.y, t.z, dx * dx + dy * dy + dz * dz >= CAPSULE_MIN_M * CAPSULE_MIN_M ? 1 : 0)
  }

  /**
   * Tags the foliage models' converted materials (ObjectMaterials' decorator seam): `metadata.sroNearFade` = 'leaf' for
   * a cut-out or blended one, 'wood' for an opaque one. The Classic path has no other foliage mark.
   */
  attach(materials: { addDecorator(fn: (mat: Material, info: { source: string; alpha: 'opaque' | 'mask' | 'blend' }) => void): () => void }): void {
    this.offs.push(materials.addDecorator((mat, info) => {
      if (!info.source || !isFoliageModel(info.source)) return
      mat.metadata = { ...(mat.metadata ?? {}), sroNearFade: info.alpha === 'opaque' ? 'wood' : 'leaf' }
      mat.pluginManager?.getPlugin<SroNearFadePlugin>(NEAR_FADE_PLUGIN)?.markAllDefinesAsDirty()
    }))
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off()
  }
}

const STATES = new WeakMap<Scene, NearFadeState>()

/** The scene's fade state (null: not installed). */
export function nearFadeStateOf(scene: Scene): NearFadeState | null {
  return STATES.get(scene) ?? null
}

/** What `mat` is to the fade (see the file comment). */
export function nearFadeKindOf(mat: Material): NearFadeKind {
  const meta = (mat.metadata ?? null) as { sroNearFade?: NearFadeKind; sroFoliage?: boolean } | null
  if (meta?.sroNearFade === 'leaf' || meta?.sroNearFade === 'wood') return meta.sroNearFade
  const fol = foliagePluginOf(mat)
  if (fol && !fol.cloth) return fol.leaf ? 'leaf' : 'wood'
  if (meta?.sroFoliage) return mat.needAlphaTesting() || mat.needAlphaBlending() ? 'leaf' : 'wood'
  return null
}

export class SroNearFadePlugin extends MaterialPluginBase {
  constructor(material: Material, readonly state: NearFadeState) {
    super(material, NEAR_FADE_PLUGIN, 270, { SRO_NFADE: false, SRO_NFADE_CAP: false }, true, true)
    state.plugins.add(this)
  }

  override getClassName(): string {
    return NEAR_FADE_PLUGIN
  }

  override isCompatible(language: ShaderLanguage): boolean {
    return language === ShaderLanguage.WGSL || language === ShaderLanguage.GLSL
  }

  override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    const kind = this.state.enabled && !mesh?.skeleton ? nearFadeKindOf(this._material) : null
    defines['SRO_NFADE'] = kind !== null
    defines['SRO_NFADE_CAP'] = kind === 'leaf'
  }

  override getUniforms(): { ubo: Array<{ name: string; size: number; type: string }>; fragment: string } {
    return {
      ubo: NEAR_FADE_UNIFORMS.map(name => ({ name, size: 4, type: 'vec4' })),
      fragment: `#ifdef SRO_NFADE\n${NEAR_FADE_UNIFORMS.map(n => `uniform vec4 ${n};`).join('\n')}\n#endif\n`,
    }
  }

  override bindForSubMesh(ubo: UniformBuffer): void {
    if (!this.state.enabled) return
    const { a, b, c } = this.state
    ubo.updateFloat4('sroNfA', a.x, a.y, a.z, a.w)
    ubo.updateFloat4('sroNfB', b.x, b.y, b.z, b.w)
    ubo.updateFloat4('sroNfC', c.x, c.y, c.z, c.w)
  }

  override getCustomCode(shaderType: string, language: ShaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    return shaderType === 'fragment' ? { ...nearFadeCode(language === ShaderLanguage.WGSL ? 'wgsl' : 'glsl') } : null
  }

  override dispose(force?: boolean): void {
    this.state.plugins.delete(this)
    super.dispose(force)
  }
}

function ensureRegistered(): void {
  RegisterMaterialPlugin(NEAR_FADE_PLUGIN, material => {
    const s = STATES.get(material.getScene())
    return s && (material instanceof PBRBaseMaterial || material instanceof StandardMaterial) ? new SroNearFadePlugin(material, s) : null
  })
}

/** Attaches the plugin to one material (idempotent; null for other material kinds or without a state). */
export function attachNearFade(material: Material): SroNearFadePlugin | null {
  const s = STATES.get(material.getScene())
  if (!s || !(material instanceof PBRBaseMaterial || material instanceof StandardMaterial)) return null
  return material.pluginManager?.getPlugin<SroNearFadePlugin>(NEAR_FADE_PLUGIN) ?? new SroNearFadePlugin(material, s)
}

/** The scene's fade, made on the first call (World's constructor, before any world material). */
export function installNearFade(scene: Scene): NearFadeState {
  ensureRegistered()
  let s = STATES.get(scene)
  if (s) return s
  s = new NearFadeState(scene)
  STATES.set(scene, s)
  for (const m of scene.materials) attachNearFade(m)
  return s
}

/** Drops the scene's state (World disposal): the plugins stay on their materials, switched off. */
export function uninstallNearFade(scene: Scene): void {
  const s = STATES.get(scene)
  if (!s) return
  s.setEnabled(false)
  s.dispose()
  STATES.delete(scene)
}
