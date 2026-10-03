/**
 * The town's crowd runtime (docs/TOWN_LIFE.md §2.2, §3.2, §3.6, §8; docs/WAVE_PLAN7.md §6.1 TL-C, §5.3).
 *
 * Townsfolk are not characters: each variant (one dressed body, one mesh, one material: TL-V's
 * `town/variants/<id>.glb`) draws every instance of it in **one draw** through thin instances, animated by a baked
 * vertex animation texture (VAT, one per skeleton, Babylon's BakedVertexAnimationManager). No live skeleton runs, no CPU
 * animation: a townsperson costs a matrix write per frame, and a 16-byte clip write only when its clip changes.
 *
 * - **The schedule** (`CrowdSchedule`) says where agent i is at server second `nowS` (TL-R's pure `town/schedule.ts`
 *   behind an adapter; town/index.ts's stand-in until it lands). The crowd never keeps state that the schedule owns,
 *   so two clients on the same clock draw the same people (TOWN_LIFE §2.1).
 * - **The time base** (F5): the GPU never sees epoch seconds. `manager.time = nowS − t0` with `t0` re-based before the
 *   hour is up (T stays in [REBASE_MIN_S, REBASE_MAX_S), < 3,600 s), and every drawn instance's offset frame is written
 *   so the frame the GPU draws equals the schedule's clip phase (`vatOffsetFor`, Babylon 9.28's VAT formula replicated by
 *   `vatDrawnFrame`). A re-base rewrites every offset in that frame, so nothing jumps.
 * - **The cap gives way to players** (§8.1, F2): `folkCap` = max(15, preset − 3 × (players beyond 5)) × the Town life
 *   scale; which agents stay is a fixed per-agent rank (agents are walked in rank order), so friends standing together
 *   see the same people. Agents beyond the range, over the cap, inside a `noFolk` circle, or leaving through a door fade
 *   with a 0.6 s screen-door dither (`SroTownFadePlugin`, the instance colour's alpha), so nobody pops.
 * - **Stable slots**: an agent keeps its slot in its variant's buffers while drawn (swap-remove on leave), so the clip
 *   buffer is uploaded only when a clip, a rate, a slot or the time base changes; the matrix and colour buffers once per
 *   variant per frame. A variant with no instance is `isVisible = false` (Babylon would draw the bare template once).
 * - **Bounds**: each variant's bounding box is rebuilt from its drawn agents every frame (the template sits at the
 *   origin; `doNotSyncBoundingInfo`), so the camera frustum culls a variant whose people are all behind it, and the
 *   shadow caster source sees the right sphere.
 * - **The sidestep** (§3.6): a walker whose next 2 m pass within 0.9 m of an actor takes a lateral offset ≤ 0.6 m,
 *   eased over 0.4 s; a standing agent turns ≤ 30° toward an actor within 2 m. Cosmetic and local: never fed back.
 * - No allocation per frame after warm-up: typed arrays, a reused pose, string identity for clip names.
 *
 * Assets: `loadCrowdAssets` reads TL-V's export (`town/index.json`, `town/vat/<skeleton>.{json,bin}`,
 * `town/variants/<id>.glb`); until X1 the stand-in mannequins of `stubCrowdAssets` (procedural, the same VAT path).
 */
import {
  BakedVertexAnimationManager,
  Bone,
  BoundingInfo,
  Color3,
  Constants,
  LoadAssetContainerAsync,
  MaterialPluginBase,
  Matrix,
  Mesh,
  PBRMaterial,
  RawTexture,
  ShaderLanguage,
  Skeleton,
  Texture,
  Vector3,
  VertexData,
  type AssetContainer,
  type BaseTexture,
  type Material,
  type MaterialDefines,
  type Scene,
} from '@babylonjs/core'
import { TOWN_TAG } from './types.ts'

// ---- presets and caps (TOWN_LIFE §8.2, WAVE_PLAN7 §2.5) ------------------------------------------------------------

/** The world quality the crowd follows (World.quality). */
export type TownPresetName = 'low' | 'medium' | 'high' | 'ultra'

export interface TownPreset {
  /** Townsfolk drawn at most (in range), before the player cap and the Town life scale. */
  folk: number
  /** How far from the focus townsfolk are drawn (m). */
  rangeM: number
  /** VAT animals at most (chickens, cats, dogs). */
  animals: number
  /** Dressed folk variants used (one draw each). */
  variants: number
  /** 'blob': one instanced soft blob under each person (Medium); 'cast': the crowd joins the CSM casters. */
  shadows: 'none' | 'blob' | 'cast'
  /** The pond's ducks (a life species). */
  ducks: boolean
  /**
   * The presets whose default AA is TAA (G5-11, WAVE_PLAN7 D4). Informational since H11-NT-1: the town asks for MSAA ×4
   * on every preset and the post swaps only when it runs TAA (the Advanced AA row can turn TAA on for Medium).
   */
  temporalFix: boolean
  /** H11-NT-3 (TOWN_LIFE §7.1): moving lantern lights at most (the nearest holders; only with a night cluster). */
  lanternLights: number
  /**
   * WAVE_PLAN7 §7 cut 20 (applied by I-11 after LAB-11's G1 run): with at least this many players in range no townsfolk
   * are drawn (the pigeons, the animals, the motion and the sound stay). Absent: never.
   */
  noFolkFrom?: number
}

/**
 * Counts per preset [TOWN_LIFE §8.2]. High and Ultra keep blob shadows by default: casting through the CSM is built
 * ('cast') but cannot be limited to cascade 0 without a render/shadows.ts seam, so LAB-11 decides (G2).
 */
export const TOWN_PRESETS: Readonly<Record<TownPresetName, Readonly<TownPreset>>> = {
  low: { folk: 0, rangeM: 0, animals: 0, variants: 0, shadows: 'none', ducks: false, temporalFix: false, lanternLights: 0 },
  medium: { folk: 60, rangeM: 60, animals: 12, variants: 10, shadows: 'blob', ducks: false, temporalFix: false, noFolkFrom: 15, lanternLights: 2 },
  high: { folk: 100, rangeM: 90, animals: 16, variants: 14, shadows: 'blob', ducks: true, temporalFix: true, lanternLights: 4 },
  ultra: { folk: 140, rangeM: 120, animals: 20, variants: 18, shadows: 'blob', ducks: true, temporalFix: true, lanternLights: 4 },
}

/** The crowd never drops below this many folk for players (before the Town life scale). */
export const FOLK_FLOOR = 15
/** Folk given up per player in range beyond FREE_PLAYERS. */
export const FOLK_PER_PLAYER = 3
export const FREE_PLAYERS = 5
/** Beyond this many players in range the VAT animals halve (the pigeons are the life part's and stay). */
export const ANIMAL_HALVE_PLAYERS = 10
/** The dither fade at the range edge, the cap and a door (s). */
export const FADE_S = 0.6

/**
 * Townsfolk drawn for `players` player characters in range (TOWN_LIFE §8.1): max(15, cap − 3 × (players − 5)) × scale;
 * none from the preset's `noFolkFrom` players on (Medium: 15, WAVE_PLAN7 cut 20). `crowded`: the town part's latched
 * decision for that line (crowd-latch.ts, H-12 CR-1: off again only 3 players below it); absent: the plain count.
 */
export function folkCap(preset: Readonly<TownPreset>, players: number, scale = 1, crowded?: boolean): number {
  if (!(preset.folk > 0) || !(scale > 0)) return 0
  const p = Math.max(0, Math.floor(players) || 0)
  if (preset.noFolkFrom !== undefined && (crowded ?? p >= preset.noFolkFrom)) return 0
  const cap = Math.min(preset.folk, Math.max(FOLK_FLOOR, preset.folk - FOLK_PER_PLAYER * Math.max(0, p - FREE_PLAYERS)))
  return Math.max(0, Math.round(cap * Math.min(1, scale)))
}

/** VAT animals drawn: the preset's, halved beyond ANIMAL_HALVE_PLAYERS players, × the Town life scale. */
export function animalCap(preset: Readonly<TownPreset>, players: number, scale = 1): number {
  if (!(preset.animals > 0) || !(scale > 0)) return 0
  const n = (Math.floor(players) || 0) > ANIMAL_HALVE_PLAYERS ? Math.floor(preset.animals / 2) : preset.animals
  return Math.max(0, Math.round(n * Math.min(1, scale)))
}

// ---- the VAT time base (TOWN_LIFE §2.2, F5) ----------------------------------------------------------------------

/** manager.time stays in [REBASE_MIN_S, REBASE_MAX_S): ≥ one loop of the longest clip, < an hour (float32 step ≤ 0.25 ms). */
export const REBASE_MIN_S = 60
export const REBASE_MAX_S = 3540

const fract = (x: number) => x - Math.floor(x)
const glslMod = (x: number, y: number) => x - y * Math.floor(x / y)

/**
 * The VAT row Babylon 9.28 draws (ShadersInclude/bakedVertexAnimation, replicated): manager time `T`, a clip of rows
 * [start, end], the instance's offset frame and speed (frames per second).
 */
export function vatDrawnFrame(T: number, start: number, end: number, offset: number, speed: number): number {
  const total = end - start + 1
  const time = (T * speed) / total
  const corr = time < 1 ? 0 : 1
  const n = total - corr
  return Math.floor(glslMod(fract(time) * n + offset, n)) + start + corr
}

/**
 * The offset frame that makes the GPU draw clip time `clipT` (s, the schedule's phase at rate 1) at manager time `T`,
 * for a clip of `frames` rows baked at `fps` and played at `rate` (T ≥ one loop: the shader's second branch).
 */
export function vatOffsetFor(clipT: number, fps: number, rate: number, frames: number, T: number): number {
  const n = Math.max(1, frames - 1)
  const want = fract((clipT * fps) / frames)
  const at = fract((T * fps * rate) / frames)
  return glslMod((want - at) * n, n)
}

/** The loop fraction (0..1) the GPU draws for an instance (the inverse view of vatOffsetFor, for the drift check). */
export function vatDrawnPhase(T: number, fps: number, rate: number, frames: number, offset: number): number {
  const n = Math.max(1, frames - 1)
  return fract(fract((T * fps * rate) / frames) + offset / n)
}

// ---- assets ------------------------------------------------------------------------------------------------------

/** A clip in a VAT: rows [start, end] baked at `fps`; `loopM` metres per loop for a gait (WALK, RUN), else 0. */
export interface CrowdClip {
  start: number
  end: number
  fps: number
  loopM: number
}

/** One VAT (one skeleton): its texture, clip table and manager (the shared `time`). */
export interface CrowdVat {
  readonly name: string
  readonly texture: BaseTexture
  readonly clips: ReadonlyMap<string, CrowdClip>
  readonly manager: BakedVertexAnimationManager
}

/** What a variant is drawn for. */
export type CrowdKind = 'folk' | 'guard' | 'elder' | 'chicken' | 'dog' | 'cat' | 'horse'

/** One dressed variant: one mesh with one material, a skeleton (unlinked) and its VAT. */
export interface CrowdVariant {
  readonly id: string
  readonly mesh: Mesh
  readonly vat: CrowdVat
  readonly kind: CrowdKind
  readonly female: boolean
  /** Standing height (m), for the bubbles and the pick. */
  readonly height: number
  /** The lowest preset that draws it (TL-V's index; absent: every preset, limited by the preset's variant count). */
  readonly rank?: TownPresetName
}

export interface CrowdAssets {
  readonly variants: readonly CrowdVariant[]
  readonly vats: readonly CrowdVat[]
  /** The procedural stand-ins (before TL-V's export, X1). */
  readonly stub: boolean
  dispose(): void
}

/** A clip asked for that a VAT lacks falls back along this chain (TOWN_LIFE §3.1: missing clips fall back to STAND1 / SIT). */
const CLIP_FALLBACK: Readonly<Record<string, readonly string[]>> = {
  SIT_CHAIR: ['SIT', 'STAND1'],
  CARRY: ['WALK'],
  TALK: ['EMOTION01', 'STAND3', 'STAND1'],
  SWEEP: ['PICK', 'STAND1'],
  STAND3: ['STAND1'],
  STAND2: ['STAND1'],
  RUN: ['WALK'],
  PICK: ['STAND1'],
  HAMMER: ['PICK', 'STAND1'],
  VENDOR01: ['STAND3', 'STAND1'],
}

/** The clip a VAT draws for `name` (the fallback chain, then STAND1, then the first clip). */
export function resolveClip(clips: ReadonlyMap<string, CrowdClip>, name: string): CrowdClip | null {
  const c = clips.get(name)
  if (c) return c
  for (const alt of CLIP_FALLBACK[name] ?? []) {
    const a = clips.get(alt)
    if (a) return a
  }
  return clips.get('STAND1') ?? clips.get('WALK') ?? clips.values().next().value ?? null
}

// ---- the schedule seam -----------------------------------------------------------------------------------------

/** Roles (packages/shared town.ts TownRole) plus the VAT animals. */
export type CrowdRole =
  | 'walker' | 'chatter' | 'sitter' | 'vendor' | 'porter' | 'guard' | 'child' | 'rider' | 'lanternCarrier' | 'worker'
  | 'elder' | 'chicken' | 'dog' | 'cat' | 'horse'

/** One agent of a schedule (fixed for the town's lifetime). */
export interface CrowdAgent {
  /** Stable id: the rank, the variant pick and the bubbles' lines hash it. */
  readonly id: number
  readonly role: CrowdRole
  readonly female: boolean
  /** Fixed rank 0..1: lower ranks stay when the cap shrinks (the same people on every client). */
  readonly rank: number
  /** Body scale (a child 0.82; default 1). */
  readonly scale?: number
  /** A vendor's goods (the calls' key, TownPlace.goods). */
  readonly goods?: string
  /** The look's seed: the variant and gait style pick (default the id). */
  readonly seed?: number
}

/** Where an agent is: glTF metres, yaw (atan2(dx, dz), the game's), the clip and its phase. */
export interface CrowdPose {
  x: number
  /** Ground height; NaN: the crowd samples it (TownCrowd's heightAt). */
  y: number
  z: number
  yaw: number
  /** A clip name (STAND1, WALK, SIT, VENDOR01, …); missing clips fall back (resolveClip). */
  clip: string
  /** Seconds into the clip at rate 1 (the drawn frame follows it). */
  clipT: number
  /** Playback rate (a walker 10 % fast walks its VAT 10 % fast, so feet do not slide). */
  rate: number
  /**
   * A gait's distance walked (m) and its speed (m/s): with a clip that has a loop length (`CrowdClip.loopM`), the crowd
   * takes the phase and the rate from them (feet never slide, whatever the asset's loop); NaN: use clipT and rate.
   */
  distM: number
  speed: number
  /** 0..1: a door's fade (the schedule's); 1 elsewhere. */
  alpha: number
}

/** The frame's question to a schedule. */
export interface CrowdQuery {
  nowS: number
  /** Solar time 0..1 (0 = midnight; the sky's clock). */
  solarT: number
  /** The appear notice's alarm (server seconds; untilS ≤ nowS: none). */
  alarmFromS: number
  alarmUntilS: number
  /** Rain 0..1 (the weather frame). */
  rain: number
}

/** TL-R's schedule as the crowd reads it (an adapter over `town/schedule.ts`; the stand-in until then). */
export interface CrowdSchedule {
  readonly agents: readonly CrowdAgent[]
  /** Agent i at `q.nowS` into `out`; false: not out (indoors, off duty). Pure: the same answer on every client. */
  pose(i: number, q: Readonly<CrowdQuery>, out: CrowdPose): boolean
  /** The appear notice's alarm, for a schedule that keeps it itself (TL-R's); the stand-ins read it from CrowdQuery. */
  alarm?(nowS: number, sec: number): void
}

export function newPose(): CrowdPose {
  return { x: 0, y: Number.NaN, z: 0, yaw: 0, clip: 'STAND1', clipT: 0, rate: 1, distM: Number.NaN, speed: 0, alpha: 1 }
}

/** A circle townsfolk never enter (TownCircle). */
export interface CrowdCircle {
  x: number
  z: number
  r: number
}

// ---- the dither fade plugin --------------------------------------------------------------------------------------

export const SRO_TOWN_FADE_PLUGIN = 'SroTownFadePlugin'

/**
 * The 0.6 s fade (TOWN_LIFE §3.4, §8.1): a 4 × 4 ordered (Bayer) screen-door discard by the instance colour's alpha, so
 * an opaque townsperson dissolves in and out without blending or sorting. No uniform, no sampler (it shares the
 * material with the surface and fog plugins: no declaration of its own can clash). Off unless the mesh has an instance
 * colour (INSTANCESCOLOR, INSTANCES): every other draw of the material is untouched.
 */
export function townFadeFragmentCode(language: 'glsl' | 'wgsl'): Record<string, string> {
  const head = '#if defined(SRO_TOWN_FADE) && defined(INSTANCESCOLOR) && defined(INSTANCES)\n'
  if (language === 'wgsl') {
    return {
      CUSTOM_FRAGMENT_MAIN_BEGIN: `${head}if (fragmentInputs.vColor.a < 0.999) {
  let sroFa = floor(fragmentInputs.position.xy);
  let sroFh = floor(sroFa * 0.5);
  let sroFt = fract(dot(sroFh, vec2f(0.5, sroFh.y * 0.75))) * 0.25 + fract(dot(sroFa, vec2f(0.5, sroFa.y * 0.75))) + 0.03125;
  if (fragmentInputs.vColor.a < sroFt) { discard; }
}
#endif
`,
    }
  }
  return {
    CUSTOM_FRAGMENT_MAIN_BEGIN: `${head}if (vColor.a < 0.999) {
  vec2 sroFa = floor(gl_FragCoord.xy);
  vec2 sroFh = floor(sroFa * 0.5);
  float sroFt = fract(dot(sroFh, vec2(0.5, sroFh.y * 0.75))) * 0.25 + fract(dot(sroFa, vec2(0.5, sroFa.y * 0.75))) + 0.03125;
  if (vColor.a < sroFt) { discard; }
}
#endif
`,
  }
}

export class SroTownFadePlugin extends MaterialPluginBase {
  private enabled = true

  constructor(material: Material) {
    super(material, SRO_TOWN_FADE_PLUGIN, 260, { SRO_TOWN_FADE: false }, true, true)
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  set isEnabled(on: boolean) {
    if (on === this.enabled) return
    this.enabled = on
    this.markAllDefinesAsDirty()
  }

  override getClassName(): string {
    return SRO_TOWN_FADE_PLUGIN
  }

  override isCompatible(_language: ShaderLanguage): boolean {
    return true
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines['SRO_TOWN_FADE'] = this.isEnabled
  }

  override getCustomCode(shaderType: string, language: ShaderLanguage = ShaderLanguage.GLSL): Record<string, string> | null {
    if (shaderType !== 'fragment') return null
    return townFadeFragmentCode(language === ShaderLanguage.WGSL ? 'wgsl' : 'glsl')
  }
}

/**
 * Dresses a crowd material: opaque, lit by 4 lights, the fade plugin (and the host's character decoration). `selfLit`
 * is the retail emissive TL-V zeroed in the glb (set before the decoration, which takes it as the material's own).
 */
export function dressCrowdMaterial(mat: Material, decorate?: ((m: Material) => void) | null, selfLit?: readonly number[] | null): void {
  if (mat instanceof PBRMaterial) {
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE
    mat.maxSimultaneousLights = 4
    mat.emissiveColor.set(selfLit?.[0] ?? 0, selfLit?.[1] ?? 0, selfLit?.[2] ?? 0)
  }
  decorate?.(mat)
  if (!mat.pluginManager?.getPlugin(SRO_TOWN_FADE_PLUGIN)) new SroTownFadePlugin(mat)
}

/** Readies a variant's template mesh for the crowd: tagged 'town', not pickable, at the origin, VAT on, no instances. */
export function prepareCrowdMesh(mesh: Mesh, vat: CrowdVat): void {
  mesh.parent = null
  mesh.position.setAll(0)
  mesh.rotationQuaternion = null
  mesh.rotation.setAll(0)
  mesh.scaling.setAll(1)
  mesh.computeWorldMatrix(true)
  mesh.freezeWorldMatrix()
  mesh.metadata = { ...(mesh.metadata as object | null), sroWorld: TOWN_TAG }
  mesh.isPickable = false
  mesh.receiveShadows = true
  mesh.doNotSyncBoundingInfo = true
  mesh.alwaysSelectAsActiveMesh = false
  mesh.bakedVertexAnimationManager = vat.manager
  mesh.isVisible = false
  mesh.setEnabled(true)
}

// ---- the crowd -----------------------------------------------------------------------------------------------------

/** Most actors the sidestep looks at per frame (the nearest are not sorted: the first within range). */
export const THREATS_MAX = 64
/**
 * Walkers sidestep an actor within this of their next PATH_LOOK_M (m), by at most SIDESTEP_M, eased over SIDESTEP_S.
 * SIDESTEP_M is the route graph's clearance (build-graph TOWN_EDGE_CLEAR_M, 0.4 m): every edge keeps that much free on
 * both sides, so a sidestep never enters a wall (H11 P5: 0.6 m reached into the tea house's wall by edge n837-p1).
 */
export const SIDESTEP_NEAR_M = 0.9
export const PATH_LOOK_M = 2
export const SIDESTEP_M = 0.4
export const SIDESTEP_S = 0.4
/** A standing agent turns ≤ TURN_MAX toward an actor within TURN_NEAR_M. */
export const TURN_NEAR_M = 2
export const TURN_MAX = Math.PI / 6
/** The fastest townsperson (a running child, m/s): out-of-range agents are asked again only when they could be back. */
export const MAX_SPEED = 4
/**
 * The focus (the player's camera target) at most this fast (m/s: a run with a speed buff, a horse); a far agent's skip
 * is budgeted for both closing in, and a faster step (a teleport, a return or revive warp) asks everyone again
 * (H11-DET-3).
 */
export const FOCUS_MAX_SPEED = 12
/** A step back of the server-time estimate by more than this (s) asks everyone again (H11-DET-4). */
export const CLOCK_BACK_S = 0.25
/** Clips that walk (the sidestep applies). */
const GAITS = new Set(['WALK', 'RUN', 'CARRY'])
/** Clips that stand (the turn toward an actor applies). */
const STANDS = new Set(['STAND1', 'STAND2', 'STAND3', 'TALK', 'EMOTION01', 'EMOTION02', 'EMOTION04', 'EMOTION07', 'VENDOR01'])

/** One variant's draw: the template mesh and its thin-instance buffers. */
class VariantDraw {
  readonly mats: Float32Array
  readonly settings: Float32Array
  readonly colors: Float32Array
  /** Agent in each slot. */
  readonly slotAgent: Int32Array
  count = 0
  settingsDirty = false
  readonly min = new Vector3()
  readonly max = new Vector3()

  constructor(readonly variant: CrowdVariant, readonly cap: number) {
    this.mats = new Float32Array(Math.max(1, cap) * 16)
    this.settings = new Float32Array(Math.max(1, cap) * 4)
    this.colors = new Float32Array(Math.max(1, cap) * 4).fill(1)
    this.slotAgent = new Int32Array(Math.max(1, cap)).fill(-1)
    const m = variant.mesh
    m.thinInstanceSetBuffer('matrix', this.mats, 16, false)
    m.thinInstanceSetBuffer('bakedVertexAnimationSettingsInstanced', this.settings, 4, false)
    m.thinInstanceSetBuffer('color', this.colors, 4, false)
    m.thinInstanceCount = 0
    m.isVisible = false
    if (!m.getBoundingInfo()) m.setBoundingInfo(new BoundingInfo(new Vector3(-1, 0, -1), new Vector3(1, 2, 1)))
  }

  /** Uploads this frame's buffers (matrix and colour always, the clip settings when they changed) and the bounds. */
  flush(): void {
    const m = this.variant.mesh
    if (m.thinInstanceCount !== this.count) m.thinInstanceCount = this.count
    const vis = this.count > 0
    if (m.isVisible !== vis) m.isVisible = vis
    if (!vis) return
    m.thinInstanceBufferUpdated('matrix')
    m.thinInstanceBufferUpdated('color')
    if (this.settingsDirty) {
      m.thinInstanceBufferUpdated('bakedVertexAnimationSettingsInstanced')
      this.settingsDirty = false
    }
    this.max.y += this.variant.height + 0.3
    m.getBoundingInfo().reConstruct(this.min, this.max)
  }

  /** Releases the buffers (the mesh is the assets'). */
  detach(): void {
    const m = this.variant.mesh
    m.thinInstanceCount = 0
    m.isVisible = false
  }
}

export interface TownCrowdOptions {
  /** Which variants this crowd draws (folk, or the animals). */
  kinds: readonly CrowdKind[]
  /** Folk variants used (the preset's: Medium 10; the rest of the assets stay unused). */
  variants?: number
  /** The preset: variants with a `rank` above it are not used (TL-V's index ranks them). */
  preset?: TownPresetName
  /** Ground height for poses without one (the world's nav; cached per agent, re-asked after 1 m). */
  heightAt?: ((x: number, z: number) => number | null) | null
}

/** An agent as the crowd drew it (TownCrowd.drawnOf). */
export interface DrawnAgent {
  x: number
  y: number
  z: number
  h: number
  yaw: number
  scale: number
  alpha: number
}

export function newDrawn(): DrawnAgent {
  return { x: 0, y: 0, z: 0, h: 0, yaw: 0, scale: 1, alpha: 0 }
}

/** What the crowd drew last frame (stats). */
export interface CrowdFrame {
  drawn: number
  inRange: number
  draws: number
  /** Drawn within 30 m of the focus (the town bed's count, TL-S). */
  near30: number
  clipWrites: number
}

/**
 * The VAT crowd of one schedule: agents → variants (stable for the crowd's life), the per-frame write of the agents in
 * range, the cap, the fades, the sidestep, the pick.
 */
export class TownCrowd {
  readonly draws: VariantDraw[] = []
  readonly frame: CrowdFrame = { drawn: 0, inRange: 0, draws: 0, near30: 0, clipWrites: 0 }
  private readonly n: number
  /** Agents in rank order. */
  private readonly order: Int32Array
  private readonly drawOf: Int16Array
  private readonly slot: Int32Array
  private readonly fade: Float32Array
  private readonly farUntil: Float64Array
  private readonly side: Float32Array
  private readonly turn: Float32Array
  /** Per agent: the last drawn pose (head bubbles, the pick, a fade-out after the schedule let go). */
  private readonly px: Float32Array
  private readonly py: Float32Array
  private readonly pz: Float32Array
  private readonly pyaw: Float32Array
  /** Height cache (heightAt): where it was asked and the answer. */
  private readonly hx: Float32Array
  private readonly hz: Float32Array
  private readonly hy: Float32Array
  /** The clip written (by object identity), its rate and offset (the drift check). */
  private readonly clipOf: (CrowdClip | null)[]
  private readonly rateOf: Float32Array
  private readonly scaleOf: Float32Array
  /** An agent's gait style: its WALK and STAND1 (null: the plain ones). */
  private readonly walkOf: (CrowdClip | null)[]
  private readonly standOf: (CrowdClip | null)[]
  private readonly pose = newPose()
  private readonly heightAt: ((x: number, z: number) => number | null) | null
  private capValue = 0
  private rangeValue = 0
  /** This frame's VAT time and easing steps (place() reads them). */
  private atT = 0.5
  private sideStep = 0.5
  private turnStep = 0.5
  private noFolk: readonly CrowdCircle[] = []
  private hiddenAll = false
  private disposed = false
  /** The last update's server second and focus (a clock step back or a focus jump clears the skips). */
  private lastNowS = Number.NaN
  private lastFx = Number.NaN
  private lastFz = Number.NaN

  constructor(readonly assets: CrowdAssets, readonly schedule: CrowdSchedule, opts: TownCrowdOptions) {
    const agents = schedule.agents
    this.n = agents.length
    this.heightAt = opts.heightAt ?? null
    this.order = Int32Array.from(agents.map((_, i) => i)).sort((a, b) => agents[a]!.rank - agents[b]!.rank || agents[a]!.id - agents[b]!.id)
    this.drawOf = new Int16Array(this.n).fill(-1)
    this.slot = new Int32Array(this.n).fill(-1)
    this.fade = new Float32Array(this.n)
    this.farUntil = new Float64Array(this.n)
    this.side = new Float32Array(this.n)
    this.turn = new Float32Array(this.n)
    this.px = new Float32Array(this.n)
    this.py = new Float32Array(this.n)
    this.pz = new Float32Array(this.n)
    this.pyaw = new Float32Array(this.n)
    this.hx = new Float32Array(this.n).fill(Number.NaN)
    this.hz = new Float32Array(this.n).fill(Number.NaN)
    this.hy = new Float32Array(this.n).fill(Number.NaN)
    this.clipOf = new Array<CrowdClip | null>(this.n).fill(null)
    this.rateOf = new Float32Array(this.n)
    this.scaleOf = new Float32Array(this.n)
    // Variants: the kinds asked for, ranked at or below the preset; folk variants limited to the preset's count, half
    // men half women (TL-V's index lists Medium's five of each first).
    const order: Record<TownPresetName, number> = { low: 0, medium: 1, high: 2, ultra: 3 }
    const at = order[opts.preset ?? 'ultra']
    const pool = assets.variants.filter(v => opts.kinds.includes(v.kind) && (!v.rank || order[v.rank] <= at))
    const folkMax = opts.variants ?? Infinity
    const men = pool.filter(v => v.kind === 'folk' && !v.female).slice(0, Math.ceil(folkMax / 2))
    const women = pool.filter(v => v.kind === 'folk' && v.female).slice(0, Math.floor(folkMax / 2) || (folkMax > 0 ? 1 : 0))
    const used = [...men, ...women, ...pool.filter(v => v.kind !== 'folk')]
    const assigned = new Array<number>(used.length).fill(0)
    const pick = (a: CrowdAgent): number => {
      const kind = kindOfRole(a.role)
      let list = used.map((v, i) => [v, i] as const).filter(([v]) => v.kind === kind)
      if (kind === 'folk' || !list.length) {
        if (kind !== 'folk' && kind !== 'elder' && kind !== 'guard') return -1 // an animal without its variant: not drawn
        const female = a.role === 'child' ? true : a.female
        list = used.map((v, i) => [v, i] as const).filter(([v]) => v.kind === 'folk' && v.female === female)
        if (!list.length) list = used.map((v, i) => [v, i] as const).filter(([v]) => v.kind === 'folk')
      }
      if (!list.length) return -1
      return list[hash2(a.seed ?? a.id, 0x9e37) % list.length]![1]
    }
    const variantOfAgent = agents.map(pick)
    for (const v of variantOfAgent) if (v >= 0) assigned[v]!++
    const drawIndex = new Map<number, number>()
    used.forEach((v, i) => {
      if (!assigned[i]) return
      drawIndex.set(i, this.draws.length)
      this.draws.push(new VariantDraw(v, assigned[i]!))
    })
    this.walkOf = new Array<CrowdClip | null>(this.n).fill(null)
    this.standOf = new Array<CrowdClip | null>(this.n).fill(null)
    agents.forEach((a, i) => {
      const v = variantOfAgent[i]!
      this.drawOf[i] = v >= 0 ? drawIndex.get(v) ?? -1 : -1
      this.scaleOf[i] = a.scale && a.scale > 0 ? a.scale : a.role === 'child' ? 0.82 : 1
      // Gait variety (TOWN_LIFE §3.2): TL-V's VAT carries `WALK@<style>` and `STAND1@<style>`; each agent keeps one style.
      if (v < 0) return
      const clips = used[v]!.vat.clips
      const styles = [...clips.keys()].filter(k => k.startsWith('WALK@')).map(k => k.slice(5))
      if (!styles.length) return
      const style = styles[hash2(a.seed ?? a.id, 0x51) % (styles.length + 1)]
      if (!style) return // the plain WALK
      this.walkOf[i] = clips.get(`WALK@${style}`) ?? null
      this.standOf[i] = clips.get(`STAND1@${style}`) ?? null
    })
  }

  /** The cap (agents drawn at most) and the range (m). */
  configure(cap: number, rangeM: number, noFolk: readonly CrowdCircle[] = this.noFolk): void {
    this.capValue = Math.max(0, Math.floor(cap))
    this.rangeValue = Math.max(0, rangeM)
    this.noFolk = noFolk
  }

  get cap(): number {
    return this.capValue
  }

  get range(): number {
    return this.rangeValue
  }

  /** Every template mesh this crowd draws. */
  meshes(): Mesh[] {
    return this.draws.map(d => d.variant.mesh)
  }

  /** Hides every instance at once (Town life Off, a disabled part); the next update draws again. */
  hideAll(): void {
    for (let i = 0; i < this.n; i++) {
      this.slot[i] = -1
      this.fade[i] = 0
      this.farUntil[i] = 0
      this.clipOf[i] = null
    }
    for (const d of this.draws) {
      d.count = 0
      d.slotAgent.fill(-1)
      d.flush()
    }
    this.frame.drawn = 0
    this.frame.draws = 0
    this.frame.near30 = 0
    this.hiddenAll = true
  }

  /** Every offset is written again in this frame (the time base moved; the clock may have jumped). */
  invalidateClips(): void {
    for (let i = 0; i < this.n; i++) {
      this.clipOf[i] = null
      this.farUntil[i] = 0
    }
  }

  /**
   * One frame: `T` is the VAT managers' time (nowS − t0, set by the caller), (fx, fz) the focus, `threats` (x, z pairs,
   * `threatCount` of them) the actors near the focus.
   */
  update(q: Readonly<CrowdQuery>, T: number, fx: number, fz: number, dt: number, threats: Float32Array, threatCount: number): void {
    if (this.disposed) return
    this.hiddenAll = false
    const f = this.frame
    f.drawn = 0
    f.inRange = 0
    f.near30 = 0
    f.clipWrites = 0
    for (const d of this.draws) {
      d.min.set(Infinity, Infinity, Infinity)
      d.max.set(-Infinity, -Infinity, -Infinity)
    }
    const range = this.rangeValue
    const range2 = range * range
    const cap = this.capValue
    const fadeStep = dt > 0 ? dt / FADE_S : 1
    // the frame's numbers go to place() through fields (a double argument of a call that is not inlined is boxed)
    this.atT = T
    this.sideStep = dt > 0 ? (dt / SIDESTEP_S) * SIDESTEP_M : SIDESTEP_M
    this.turnStep = dt > 0 ? (dt / SIDESTEP_S) * TURN_MAX : TURN_MAX
    const nowS = q.nowS
    const pose = this.pose
    // The skips (farUntil) assume a steady clock and a focus that moves no faster than FOCUS_MAX_SPEED: a step back of
    // the clock (the server's wall clock stepped; ServerClock follows it) or a teleport asks everyone again this frame.
    const jx = fx - this.lastFx
    const jz = fz - this.lastFz
    const jumpM = FOCUS_MAX_SPEED * Math.max(dt, 1 / 30) + 2
    if (nowS < this.lastNowS - CLOCK_BACK_S || jx * jx + jz * jz > jumpM * jumpM) this.farUntil.fill(0)
    this.lastNowS = nowS
    this.lastFx = fx
    this.lastFz = fz
    let taken = 0
    for (let r = 0; r < this.n; r++) {
      const i = this.order[r]!
      const di = this.drawOf[i]!
      if (di < 0) continue
      const drawnNow = this.slot[i]! >= 0
      if (!drawnNow && nowS < this.farUntil[i]!) continue
      let want = 0
      let ok = false
      if (cap > 0 && range > 0) {
        ok = this.schedule.pose(i, q, pose)
        if (ok) {
          const dx = pose.x - fx
          const dz = pose.z - fz
          const d2 = dx * dx + dz * dz
          if (!drawnNow && d2 > (range + 4) * (range + 4)) {
            this.farUntil[i] = nowS + Math.min(2, (Math.sqrt(d2) - range) / (MAX_SPEED + FOCUS_MAX_SPEED))
            continue
          }
          if (d2 <= range2) {
            f.inRange++
            if (taken < cap && pose.alpha > 0 && !this.inNoFolk(pose.x, pose.z)) {
              want = 1
              taken++
            }
          }
        }
      }
      const fd = this.fade[i]!
      const fade = want > fd ? Math.min(want, fd + fadeStep) : Math.max(want, fd - fadeStep)
      this.fade[i] = fade
      // not out (the schedule faded it at a door already): gone at once; else the crowd's fade × the door's
      const alpha = ok ? fade * Math.min(1, Math.max(0, pose.alpha)) : 0
      if (alpha <= 0.004 || !ok) {
        if (drawnNow) this.release(i)
        // not out (indoors, off duty): asked again in half a second (they come back through a door, fading in)
        if (!ok && cap > 0) this.farUntil[i] = nowS + 0.5
        continue
      }
      const d = this.draws[di]!
      if (!drawnNow) this.take(i, d)
      const s = this.slot[i]!
      this.place(i, d, s, threats, threatCount)
      d.colors[s * 4 + 3] = alpha
      const x = this.px[i]!
      const y = this.py[i]!
      const z = this.pz[i]!
      if (x < d.min.x) d.min.x = x
      if (y < d.min.y) d.min.y = y
      if (z < d.min.z) d.min.z = z
      if (x > d.max.x) d.max.x = x
      if (y > d.max.y) d.max.y = y
      if (z > d.max.z) d.max.z = z
      f.drawn++
      const ex = x - fx
      const ez = z - fz
      if (ex * ex + ez * ez <= 900) f.near30++
    }
    let draws = 0
    for (const d of this.draws) {
      if (d.count > 0) {
        d.min.x -= 1
        d.min.z -= 1
        d.max.x += 1
        d.max.z += 1
        draws++
      }
      d.flush()
    }
    f.draws = draws
  }

  private inNoFolk(x: number, z: number): boolean {
    for (const c of this.noFolk) {
      const dx = x - c.x
      const dz = z - c.z
      if (dx * dx + dz * dz < c.r * c.r) return true
    }
    return false
  }

  private take(i: number, d: VariantDraw): void {
    if (d.count >= d.cap) return
    const s = d.count++
    d.slotAgent[s] = i
    this.slot[i] = s
    this.clipOf[i] = null
    this.side[i] = 0
    this.turn[i] = 0
    const c = s * 4
    d.colors[c] = 1
    d.colors[c + 1] = 1
    d.colors[c + 2] = 1
  }

  /** Frees agent i's slot: the last slot's agent moves into it (its clip settings with it). */
  private release(i: number): void {
    const di = this.drawOf[i]!
    const d = this.draws[di]!
    const s = this.slot[i]!
    this.slot[i] = -1
    this.clipOf[i] = null
    const last = d.count - 1
    if (s !== last && last >= 0) {
      const j = d.slotAgent[last]!
      d.slotAgent[s] = j
      this.slot[j] = s
      d.mats.copyWithin(s * 16, last * 16, last * 16 + 16)
      d.settings.copyWithin(s * 4, last * 4, last * 4 + 4)
      d.colors.copyWithin(s * 4, last * 4, last * 4 + 4)
      d.settingsDirty = true
    }
    d.slotAgent[last] = -1
    d.count = Math.max(0, last)
  }

  /** Writes agent i's matrix (with the sidestep and the turn) and, when needed, its clip settings. */
  private place(i: number, d: VariantDraw, s: number, threats: Float32Array, threatCount: number): void {
    const p = this.pose
    const T = this.atT
    const sideStep = this.sideStep
    const turnStep = this.turnStep
    let x = p.x
    let z = p.z
    let yaw = p.yaw
    const sin = Math.sin(yaw)
    const cos = Math.cos(yaw)
    // The sidestep (walkers) and the turn (standing agents): local and cosmetic.
    const gait = GAITS.has(p.clip)
    let wantSide = 0
    let wantTurn = 0
    if (threatCount > 0) {
      if (gait) {
        for (let k = 0; k < threatCount; k++) {
          const tx = threats[k * 2]! - x
          const tz = threats[k * 2 + 1]! - z
          const along = tx * sin + tz * cos
          if (along < 0 || along > PATH_LOOK_M) continue
          const lat = tx * cos - tz * sin
          const al = Math.abs(lat)
          if (al >= SIDESTEP_NEAR_M) continue
          const off = -Math.sign(lat || 1) * SIDESTEP_M * (1 - al / SIDESTEP_NEAR_M)
          if (Math.abs(off) > Math.abs(wantSide)) wantSide = off
        }
      } else if (STANDS.has(p.clip)) {
        let best = TURN_NEAR_M * TURN_NEAR_M
        for (let k = 0; k < threatCount; k++) {
          const tx = threats[k * 2]! - x
          const tz = threats[k * 2 + 1]! - z
          const d2 = tx * tx + tz * tz
          if (d2 >= best || d2 < 0.01) continue
          best = d2
          let dy = Math.atan2(tx, tz) - yaw
          dy = Math.atan2(Math.sin(dy), Math.cos(dy))
          wantTurn = Math.max(-TURN_MAX, Math.min(TURN_MAX, dy))
        }
      }
    }
    const sd = this.side[i]!
    const side = wantSide > sd ? Math.min(wantSide, sd + sideStep) : Math.max(wantSide, sd - sideStep)
    this.side[i] = side
    const tn = this.turn[i]!
    const turn = wantTurn > tn ? Math.min(wantTurn, tn + turnStep) : Math.max(wantTurn, tn - turnStep)
    this.turn[i] = turn
    if (side !== 0) {
      // the offset is to the walker's right (+) or left (−) of its heading
      x += cos * side
      z -= sin * side
    }
    yaw += turn
    // Height: the schedule's, else the nav's (cached; asked again after 1 m).
    let y = p.y
    if (!Number.isFinite(y)) {
      const hx = this.hx[i]!
      const hz = this.hz[i]!
      if (!(Math.abs(hx - x) < 1 && Math.abs(hz - z) < 1) || !Number.isFinite(this.hy[i]!)) {
        const h = this.heightAt?.(x, z) ?? null
        this.hx[i] = x
        this.hz[i] = z
        this.hy[i] = h ?? Number.NaN
      }
      y = this.hy[i]!
      if (!Number.isFinite(y)) y = this.py[i]! || 0
    }
    this.px[i] = x
    this.py[i] = y
    this.pz[i] = z
    this.pyaw[i] = yaw
    // The matrix: scale × RotationY(yaw), translation (Babylon's row-major layout).
    const sc = this.scaleOf[i]!
    const c = Math.cos(yaw) * sc
    const sn = Math.sin(yaw) * sc
    const m = d.mats
    const o = s * 16
    m[o] = c
    m[o + 1] = 0
    m[o + 2] = -sn
    m[o + 3] = 0
    m[o + 4] = 0
    m[o + 5] = sc
    m[o + 6] = 0
    m[o + 7] = 0
    m[o + 8] = sn
    m[o + 9] = 0
    m[o + 10] = c
    m[o + 11] = 0
    m[o + 12] = x
    m[o + 13] = y
    m[o + 14] = z
    m[o + 15] = 1
    // The clip: written on a change of clip or rate, a new slot, a re-base, or a drift of more than 1.5 frames.
    const clip = (p.clip === 'WALK' && this.walkOf[i]) || (p.clip === 'STAND1' && this.standOf[i]) || resolveClip(d.variant.vat.clips, p.clip)
    if (!clip) return
    const frames = clip.end - clip.start + 1
    let rate = p.rate > 0 && Number.isFinite(p.rate) ? p.rate : 1
    let clipT = p.clipT
    if (clip.loopM > 0 && Number.isFinite(p.distM) && p.speed > 0) {
      // a gait: the phase from the distance walked, the rate from the speed (the clip's own m/s at this agent's scale:
      // a child at 0.82 covers 0.82 of the loop's metres per cycle, so it steps faster; the phase and the GPU's rate
      // must use the same stride or the drift check keeps snapping the feet, H11-DET-2)
      const natural = (clip.loopM * this.scaleOf[i]!) / (frames / clip.fps)
      clipT = p.distM / natural
      rate = p.speed / natural
    }
    const st = d.settings
    const so = s * 4
    let write = this.clipOf[i] !== clip || Math.abs(this.rateOf[i]! - rate) > 1e-4
    if (!write) {
      const drawn = vatDrawnPhase(T, clip.fps, rate, frames, st[so + 2]!)
      const want = fract((clipT * clip.fps) / frames)
      let e = Math.abs(drawn - want)
      e = Math.min(e, 1 - e)
      write = e * (frames - 1) > 1.5
    }
    if (!write) return
    st[so] = clip.start
    st[so + 1] = clip.end
    st[so + 2] = vatOffsetFor(clipT, clip.fps, rate, frames, T)
    st[so + 3] = clip.fps * rate
    this.clipOf[i] = clip
    this.rateOf[i] = rate
    d.settingsDirty = true
    this.frame.clipWrites++
  }

  /** Agents drawn (alpha ≥ 0.5) within r of (x, z). */
  countNear(x: number, z: number, r: number): number {
    let n = 0
    const r2 = r * r
    for (const d of this.draws) {
      for (let s = 0; s < d.count; s++) {
        const i = d.slotAgent[s]!
        if (i < 0 || d.colors[s * 4 + 3]! < 0.5) continue
        const dx = this.px[i]! - x
        const dz = this.pz[i]! - z
        if (dx * dx + dz * dz <= r2) n++
      }
    }
    return n
  }

  /** Whether agent i is drawn now (its slot). */
  isDrawn(i: number): boolean {
    return i >= 0 && i < this.n && this.slot[i]! >= 0
  }

  /** Agent i as drawn: its feet (x, y, z), height (m), yaw and alpha; false when not drawn. */
  drawnOf(i: number, out: DrawnAgent): boolean {
    if (!this.isDrawn(i)) return false
    const d = this.draws[this.drawOf[i]!]!
    out.x = this.px[i]!
    out.y = this.py[i]!
    out.z = this.pz[i]!
    out.h = d.variant.height * this.scaleOf[i]!
    out.yaw = this.pyaw[i]!
    out.scale = this.scaleOf[i]!
    out.alpha = d.colors[this.slot[i]! * 4 + 3]!
    return true
  }

  /**
   * The nearest drawn agent whose capsule (radius 0.4 m, its height) a ray hits within `maxT`, at most `nearM` from
   * (fx, fz); −1: none. A cheap CPU pick, only on a click or a hover tick (TOWN_LIFE §3.6).
   */
  pick(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, fx: number, fz: number, nearM: number): { agent: number; t: number } {
    let best = -1
    let bestT = maxT
    const R = 0.4
    const a = dx * dx + dz * dz
    for (const d of this.draws) {
      for (let s = 0; s < d.count; s++) {
        const i = d.slotAgent[s]!
        if (i < 0 || d.colors[s * 4 + 3]! < 0.5) continue
        const cx = this.px[i]!
        const cz = this.pz[i]!
        if ((cx - fx) ** 2 + (cz - fz) ** 2 > nearM * nearM) continue
        const h = d.variant.height * this.scaleOf[i]!
        const y0 = this.py[i]!
        // ray vs the capped vertical cylinder: the side's interval [c0, c1] ∩ the height band's [b0, b1] (a ray from a
        // high camera enters through the head's cap and leaves through the feet; H11-CH-2). No allocation.
        const ex = ox - cx
        const ez = oz - cz
        let c0 = -Infinity
        let c1 = Infinity
        if (a > 1e-9) {
          const b = ex * dx + ez * dz
          const c = ex * ex + ez * ez - R * R
          const disc = b * b - a * c
          if (disc < 0) continue
          const sq = Math.sqrt(disc)
          c0 = (-b - sq) / a
          c1 = (-b + sq) / a
        } else if (ex * ex + ez * ez > R * R) continue
        let b0 = -Infinity
        let b1 = Infinity
        if (Math.abs(dy) > 1e-9) {
          const ta = (y0 - oy) / dy
          const tb = (y0 + h - oy) / dy
          b0 = Math.min(ta, tb)
          b1 = Math.max(ta, tb)
        } else if (oy < y0 || oy > y0 + h) continue
        const enter = Math.max(c0, b0)
        const exit = Math.min(c1, b1)
        if (enter > exit || exit < 0) continue
        const t = Math.max(0, enter)
        if (t >= 0 && t < bestT) {
          bestT = t
          best = i
        }
      }
    }
    return { agent: best, t: bestT }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const d of this.draws) d.detach()
  }

  /** True after hideAll until the next update (tests). */
  get hidden(): boolean {
    return this.hiddenAll
  }
}

/** The variant kind of a role. */
export function kindOfRole(role: CrowdRole): CrowdKind {
  switch (role) {
    case 'guard':
      return 'guard'
    case 'elder':
      return 'elder'
    case 'chicken':
    case 'dog':
    case 'cat':
    case 'horse':
      return role
    default:
      return 'folk'
  }
}

/**
 * A 30-bit integer hash of two numbers (the variant pick, the lines; the same on every client). 30 bits: the result is
 * a small integer to V8 (no heap number when a call returns it).
 */
export function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 2
}

/** hash2 as a number in [0, 1). */
export function hash01(a: number, b: number): number {
  return hash2(a, b) / 1073741824
}

// ---- TL-V's export (town/index.json; docs/TOWN_LIFE.md §12.2 TL-V) ---------------------------------------------------

/** `town/index.json` as the crowd reads it (TL-V writes it; unknown keys ignored). */
export interface TownAssetIndex {
  schema?: number
  /** Skeleton name → its VAT (`vat/<name>.json` + `.bin` by default). */
  vats?: Record<string, { json?: string; bin?: string }>
  variants: Array<{
    id: string
    glb?: string
    skeleton: string
    kind?: CrowdKind
    female?: boolean
    height?: number
    rank?: TownPresetName
    /** The retail emissive (zeroed in the glb). */
    selfLit?: [number, number, number]
  }>
}

/** `town/vat/<skeleton>.json`: the texture's shape and the clip table (frames are rows of the .bin). */
export interface TownVatFile {
  bones: number
  frames: number
  /** Half floats (Uint16) in the .bin (default true); else float32. */
  halfFloat?: boolean
  clips: Record<string, { start: number; end: number; fps?: number; loopM?: number }>
}

/** Where the crowd's files are (an Assets-like reader rooted at the export's `town/` folder). */
export interface TownAssetReader {
  json<T>(rel: string): Promise<T>
  bytesOf(rel: string): Promise<Uint8Array>
  url(rel: string): string
}

/**
 * Loads TL-V's export into crowd assets: one RawTexture + manager per skeleton, one template mesh per variant (the
 * glb's first mesh with geometry; its bones unlinked: no live skeleton, F-§8.1). Throws when the index is missing (the
 * caller then uses the stand-ins).
 */
export async function loadCrowdAssets(scene: Scene, reader: TownAssetReader, decorate?: ((m: Material) => void) | null): Promise<CrowdAssets> {
  const index = await reader.json<TownAssetIndex>('index.json')
  if (!index || !Array.isArray(index.variants) || !index.variants.length) throw new Error('town/index.json: no variants')
  const vats = new Map<string, CrowdVat>()
  const disposers: Array<() => void> = []
  try {
    // H11-HI-1: every request in flight at once (was 54 awaited in turn: one round trip each on a remote link); the
    // results are used in the index's order, so the crowd is the same whatever order they arrive in
    const names = [...new Set(index.variants.map(v => v.skeleton))]
    const files = await Promise.all(names.map(async name => {
      const ref = index.vats?.[name]
      const [file, bytes] = await Promise.all([reader.json<TownVatFile>(ref?.json ?? `vat/${name}.json`), reader.bytesOf(ref?.bin ?? `vat/${name}.bin`)])
      return { name, file, bytes }
    }))
    for (const { name, file, bytes } of files) {
      const half = file.halfFloat !== false
      const width = (file.bones + 1) * 4
      const data = half ? new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1) : new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2)
      const tex = RawTexture.CreateRGBATexture(data, width, file.frames, scene, false, false, Texture.NEAREST_NEAREST, half ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_FLOAT)
      tex.name = `town:vat:${name}`
      const manager = new BakedVertexAnimationManager(scene)
      manager.texture = tex
      const clips = new Map<string, CrowdClip>()
      for (const [k, c] of Object.entries(file.clips ?? {})) clips.set(k, { start: c.start, end: c.end, fps: c.fps ?? 30, loopM: c.loopM ?? 0 })
      vats.set(name, { name, texture: tex, clips, manager })
      disposers.push(() => tex.dispose())
    }
    const wanted = index.variants.filter(v => vats.has(v.skeleton))
    const containers = await Promise.allSettled(wanted.map(v => LoadAssetContainerAsync(reader.url(v.glb ?? `variants/${v.id}.glb`), scene)))
    const failed = containers.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) {
      for (const r of containers) if (r.status === 'fulfilled') r.value.dispose()
      throw failed.reason
    }
    const variants: CrowdVariant[] = []
    for (let k = 0; k < wanted.length; k++) {
      const v = wanted[k]!
      const vat = vats.get(v.skeleton)!
      const c = (containers[k] as PromiseFulfilledResult<AssetContainer>).value
      const mesh = c.meshes.find((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0) ?? null
      if (!mesh || !mesh.skeleton) {
        c.dispose()
        continue
      }
      c.addAllToScene()
      for (const g of c.animationGroups) g.dispose()
      for (const b of mesh.skeleton.bones) b.linkTransformNode(null)
      for (const m of c.meshes) if (m !== mesh) m.dispose(true)
      for (const t of [...c.transformNodes]) t.dispose()
      if (mesh.material) dressCrowdMaterial(mesh.material, decorate, v.selfLit)
      mesh.name = `town:${v.id}`
      prepareCrowdMesh(mesh, vat)
      const rank = v.rank === 'medium' || v.rank === 'high' || v.rank === 'ultra' ? v.rank : undefined
      variants.push({ id: v.id, mesh, vat, kind: v.kind ?? 'folk', female: !!v.female, height: v.height ?? (v.female ? 1.65 : 1.75), rank })
      disposers.push(() => {
        mesh.material?.dispose(true, true)
        mesh.skeleton?.dispose()
        mesh.dispose()
      })
    }
    if (!variants.length) throw new Error('town: no variant loaded')
    return {
      variants, vats: [...vats.values()], stub: false,
      dispose: () => {
        for (const fn of disposers.splice(0)) fn()
      },
    }
  } catch (err) {
    for (const fn of disposers.splice(0)) fn()
    throw err
  }
}

// ---- the stand-in mannequins (until X1) --------------------------------------------------------------------------

const lin = (r: number, g: number, b: number): [number, number, number] => [(r / 255) ** 2.2, (g / 255) ** 2.2, (b / 255) ** 2.2]

/** Muted retail-like garment colours (sRGB) for the stand-ins. */
const GARMENTS: ReadonlyArray<[number, number, number]> = [
  lin(64, 74, 110), lin(122, 84, 52), lin(150, 120, 70), lin(86, 104, 82), lin(116, 52, 48),
  lin(196, 182, 150), lin(74, 66, 60), lin(140, 98, 120), lin(60, 96, 104), lin(170, 140, 96),
]
const SKIN = lin(214, 172, 136)
const HAIR = lin(30, 24, 20)
const TROUSERS = lin(52, 48, 44)

/** A rigid part of a stand-in: a box on a bone. */
interface Part {
  bone: number
  size: [number, number, number]
  at: [number, number, number]
  color: [number, number, number]
}

/** A stand-in body: bones (name, pivot) and parts. */
interface Body {
  bones: Array<{ name: string; pivot: [number, number, number] }>
  parts: Part[]
}

function humanBody(female: boolean, garment: [number, number, number], s: number): Body {
  const hip = 0.92 * s
  const sh = 1.42 * s
  const robe = female ? 0.55 : 0.32
  return {
    bones: [
      { name: 'root', pivot: [0, hip, 0] },
      { name: 'legL', pivot: [0.1 * s, hip, 0] },
      { name: 'legR', pivot: [-0.1 * s, hip, 0] },
      { name: 'armL', pivot: [0.23 * s, sh, 0] },
      { name: 'armR', pivot: [-0.23 * s, sh, 0] },
    ],
    parts: [
      { bone: 0, size: [0.38 * s, 0.56 * s, 0.24 * s], at: [0, hip + 0.28 * s, 0], color: garment },
      { bone: 0, size: [0.42 * s, robe * s, 0.28 * s], at: [0, hip - (robe / 2) * s + 0.02, 0], color: garment },
      { bone: 0, size: [0.2 * s, 0.24 * s, 0.22 * s], at: [0, sh + 0.2 * s, 0.01], color: SKIN },
      { bone: 0, size: [0.22 * s, 0.08 * s, 0.24 * s], at: [0, sh + 0.33 * s, -0.01], color: HAIR },
      { bone: 0, size: [0.08 * s, 0.05 * s, 0.04 * s], at: [0, sh + 0.2 * s, 0.12 * s], color: SKIN },
      { bone: 1, size: [0.13 * s, hip, 0.14 * s], at: [0.1 * s, hip / 2, 0], color: TROUSERS },
      { bone: 2, size: [0.13 * s, hip, 0.14 * s], at: [-0.1 * s, hip / 2, 0], color: TROUSERS },
      { bone: 3, size: [0.1 * s, 0.6 * s, 0.11 * s], at: [0.29 * s, sh - 0.3 * s, 0], color: garment },
      { bone: 4, size: [0.1 * s, 0.6 * s, 0.11 * s], at: [-0.29 * s, sh - 0.3 * s, 0], color: garment },
      { bone: 3, size: [0.08 * s, 0.09 * s, 0.09 * s], at: [0.29 * s, sh - 0.64 * s, 0], color: SKIN },
      { bone: 4, size: [0.08 * s, 0.09 * s, 0.09 * s], at: [-0.29 * s, sh - 0.64 * s, 0], color: SKIN },
    ],
  }
}

/** Animal stand-ins: a body, a head (bone 1), front and back legs (bones 2, 3). */
function animalBody(kind: 'chicken' | 'dog' | 'cat'): Body {
  const c = kind === 'chicken' ? lin(226, 214, 190) : kind === 'dog' ? lin(140, 104, 66) : lin(96, 92, 90)
  const L = kind === 'chicken' ? 0.26 : kind === 'dog' ? 0.62 : 0.46
  const H = kind === 'chicken' ? 0.22 : kind === 'dog' ? 0.42 : 0.3
  const leg = kind === 'chicken' ? 0.14 : H * 0.55
  return {
    bones: [
      { name: 'root', pivot: [0, leg, 0] },
      { name: 'head', pivot: [0, leg + H * 0.6, L * 0.45] },
      { name: 'front', pivot: [0, leg, L * 0.35] },
      { name: 'back', pivot: [0, leg, -L * 0.35] },
    ],
    parts: [
      { bone: 0, size: [L * 0.42, H * 0.55, L], at: [0, leg + H * 0.3, 0], color: c },
      { bone: 1, size: [L * 0.3, L * 0.3, L * 0.34], at: [0, leg + H * 0.75, L * 0.58], color: c },
      { bone: 1, size: [L * 0.08, L * 0.08, L * 0.14], at: [0, leg + H * 0.7, L * 0.78], color: kind === 'chicken' ? lin(220, 150, 40) : lin(40, 30, 26) },
      { bone: 2, size: [L * 0.36, leg, L * 0.1], at: [0, leg / 2, L * 0.35], color: kind === 'chicken' ? lin(220, 150, 40) : c },
      { bone: 3, size: [L * 0.36, leg, L * 0.1], at: [0, leg / 2, -L * 0.35], color: kind === 'chicken' ? lin(220, 150, 40) : c },
    ],
  }
}

/** A stand-in clip: frames of per-bone rotations (x, z) and the root's lift, as a function of the loop phase. */
type ClipFn = (u: number, bone: number) => { rx: number; rz: number; y: number; ry?: number }

const HUMAN_CLIPS: Record<string, { dur: number; loopM: number; fn: ClipFn }> = {
  STAND1: { dur: 2.4, loopM: 0, fn: (u, b) => ({ rx: b >= 3 ? Math.sin(u * 6.283) * 0.03 : 0, rz: b === 3 ? 0.05 : b === 4 ? -0.05 : 0, y: b === 0 ? Math.sin(u * 6.283) * 0.006 : 0 }) },
  STAND3: { dur: 2.6, loopM: 0, fn: (u, b) => ({ rx: 0, rz: b === 3 ? 0.35 : b === 4 ? -0.35 : 0, y: b === 0 ? Math.sin(u * 6.283) * 0.008 : 0 }) },
  WALK: { dur: 1.1667, loopM: 1.7, fn: (u, b) => {
    const w = Math.sin(u * 6.283)
    return { rx: b === 1 ? w * 0.45 : b === 2 ? -w * 0.45 : b === 3 ? -w * 0.35 : b === 4 ? w * 0.35 : 0, rz: 0, y: b === 0 ? Math.abs(Math.cos(u * 6.283)) * 0.03 : 0 }
  } },
  RUN: { dur: 0.7, loopM: 2.6, fn: (u, b) => {
    const w = Math.sin(u * 6.283)
    return { rx: b === 1 ? w * 0.8 : b === 2 ? -w * 0.8 : b === 3 ? -w * 0.7 : b === 4 ? w * 0.7 : b === 0 ? 0.12 : 0, rz: 0, y: b === 0 ? Math.abs(Math.cos(u * 6.283)) * 0.06 : 0 }
  } },
  SIT: { dur: 2.67, loopM: 0, fn: (u, b) => ({ rx: b === 1 || b === 2 ? -1.45 : b >= 3 ? -0.5 : 0, rz: b === 1 ? -0.3 : b === 2 ? 0.3 : 0, y: b === 0 ? -0.62 + Math.sin(u * 6.283) * 0.005 : 0 }) },
  SIT_CHAIR: { dur: 3, loopM: 0, fn: (u, b) => ({ rx: b === 1 || b === 2 ? -1.5 : b >= 3 ? -0.6 : 0, rz: 0, y: b === 0 ? -0.45 + Math.sin(u * 6.283) * 0.004 : 0 }) },
  VENDOR01: { dur: 10, loopM: 0, fn: (u, b) => {
    const wave = u > 0.1 && u < 0.35 ? Math.sin(((u - 0.1) / 0.25) * Math.PI) : 0
    return { rx: b === 4 ? -wave * 2.2 : b === 3 ? -0.2 : 0, rz: b === 4 ? -wave * 0.4 : 0, y: 0, ry: b === 0 ? Math.sin(u * 6.283) * 0.3 : 0 }
  } },
  EMOTION01: { dur: 2, loopM: 0, fn: (u, b) => ({ rx: b === 4 ? -2.4 : 0, rz: b === 4 ? -0.3 - Math.sin(u * 18.85) * 0.35 : 0, y: 0 }) },
  EMOTION02: { dur: 2.2, loopM: 0, fn: (u, b) => ({ rx: b === 0 ? Math.sin(u * 3.1416) * 0.45 : b >= 3 ? -0.9 : 0, rz: b === 3 ? -0.5 : b === 4 ? 0.5 : 0, y: 0 }) },
  EMOTION04: { dur: 1.6, loopM: 0, fn: (u, b) => ({ rx: b >= 3 ? -2.6 : 0, rz: b === 3 ? 0.3 : b === 4 ? -0.3 : 0, y: b === 0 ? Math.abs(Math.sin(u * 12.566)) * 0.08 : 0 }) },
  EMOTION07: { dur: 1.8, loopM: 0, fn: (u, b) => ({ rx: b === 0 ? -0.15 + Math.sin(u * 25.13) * 0.05 : b >= 3 ? -0.3 : 0, rz: b === 3 ? 0.4 : b === 4 ? -0.4 : 0, y: b === 0 ? Math.abs(Math.sin(u * 25.13)) * 0.02 : 0 }) },
  PICK: { dur: 2, loopM: 0, fn: (u, b) => ({ rx: b === 0 ? Math.sin(u * 3.1416) * 0.9 : b >= 3 ? -Math.sin(u * 3.1416) * 1.2 : 0, rz: 0, y: 0 }) },
}

const ANIMAL_CLIPS: Record<string, { dur: number; loopM: number; fn: ClipFn }> = {
  STAND1: { dur: 2.4, loopM: 0, fn: (u, b) => ({ rx: b === 1 ? Math.sin(u * 6.283) * 0.08 : 0, rz: 0, y: 0 }) },
  WALK: { dur: 0.8, loopM: 0.7, fn: (u, b) => {
    const w = Math.sin(u * 6.283)
    return { rx: b === 2 ? w * 0.5 : b === 3 ? -w * 0.5 : b === 1 ? w * 0.06 : 0, rz: 0, y: b === 0 ? Math.abs(Math.cos(u * 6.283)) * 0.015 : 0 }
  } },
  RUN: { dur: 0.45, loopM: 1.1, fn: (u, b) => {
    const w = Math.sin(u * 6.283)
    return { rx: b === 2 ? w * 0.9 : b === 3 ? -w * 0.9 : 0, rz: 0, y: b === 0 ? Math.abs(Math.cos(u * 6.283)) * 0.04 : 0 }
  } },
  PICK: { dur: 1.2, loopM: 0, fn: (u, b) => ({ rx: b === 1 ? (u < 0.5 ? Math.sin(u * 6.283) * 1.1 : 0) : 0, rz: 0, y: 0 }) },
  SIT: { dur: 3, loopM: 0, fn: (u, b) => ({ rx: b === 3 ? 1.2 : b === 1 ? Math.sin(u * 6.283) * 0.05 : 0, rz: 0, y: b === 0 ? -0.06 : 0 }) },
}

/** The VAT rows of a stand-in body (Babylon's bone transform matrices: bind⁻¹ × pose, + the extra identity). */
function bakeStub(body: Body, clips: Record<string, { dur: number; loopM: number; fn: ClipFn }>, fps: number): { data: Float32Array; frames: number; table: Map<string, CrowdClip> } {
  const bones = body.bones.length
  const per = (bones + 1) * 16
  const rows: number[][] = []
  const table = new Map<string, CrowdClip>()
  const m = new Matrix()
  const r = new Matrix()
  const t0 = new Matrix()
  const t1 = new Matrix()
  for (const [name, c] of Object.entries(clips)) {
    const n = Math.max(2, Math.round(c.dur * fps))
    const start = rows.length
    for (let f = 0; f < n; f++) {
      const u = f / n
      const row: number[] = []
      for (let b = 0; b < bones; b++) {
        const k = c.fn(u, b)
        const p = body.bones[b]!.pivot
        // the root carries the whole body: its lift and lean apply to every bone (rigid parts on a rigid trunk)
        const root = c.fn(u, 0)
        Matrix.TranslationToRef(-p[0], -p[1], -p[2], t0)
        Matrix.RotationYawPitchRollToRef(k.ry ?? 0, k.rx, k.rz, r)
        t0.multiplyToRef(r, m)
        Matrix.TranslationToRef(p[0], p[1], p[2], t1)
        m.multiplyToRef(t1, m)
        if (b !== 0) {
          // then the root's own transform (about its pivot)
          const rp = body.bones[0]!.pivot
          Matrix.TranslationToRef(-rp[0], -rp[1], -rp[2], t0)
          Matrix.RotationYawPitchRollToRef(root.ry ?? 0, root.rx, root.rz, r)
          const mr = t0.multiply(r)
          Matrix.TranslationToRef(rp[0], rp[1] + root.y, rp[2], t1)
          mr.multiplyToRef(t1, mr)
          m.multiplyToRef(mr, m)
        } else {
          m.addTranslationFromFloats(0, k.y, 0)
        }
        row.push(...m.asArray())
      }
      row.push(...Matrix.IdentityReadOnly.asArray())
      rows.push(row)
    }
    table.set(name, { start, end: rows.length - 1, fps, loopM: c.loopM })
  }
  const data = new Float32Array(per * rows.length)
  rows.forEach((row, i) => data.set(row, i * per))
  return { data, frames: rows.length, table }
}

/** A stand-in mesh: the body's boxes, rigidly skinned (one bone each), vertex coloured, with a 5-bone skeleton. */
function stubMesh(name: string, body: Body, scene: Scene): Mesh {
  const all: VertexData[] = []
  for (const p of body.parts) {
    const vd = VertexData.CreateBox({ width: p.size[0], height: p.size[1], depth: p.size[2] })
    vd.transform(Matrix.Translation(p.at[0], p.at[1], p.at[2]))
    const nv = vd.positions!.length / 3
    vd.colors = new Float32Array(nv * 4)
    vd.matricesIndices = new Float32Array(nv * 4)
    vd.matricesWeights = new Float32Array(nv * 4)
    for (let v = 0; v < nv; v++) {
      vd.colors[v * 4] = p.color[0]
      vd.colors[v * 4 + 1] = p.color[1]
      vd.colors[v * 4 + 2] = p.color[2]
      vd.colors[v * 4 + 3] = 1
      vd.matricesIndices[v * 4] = p.bone
      vd.matricesWeights[v * 4] = 1
    }
    all.push(vd)
  }
  const merged = all[0]!.merge(all.slice(1), true)
  const mesh = new Mesh(name, scene)
  merged.applyToMesh(mesh, false)
  const skel = new Skeleton(`${name}:skel`, `${name}:skel`, scene)
  body.bones.forEach(b => new Bone(b.name, skel, null, Matrix.Identity()))
  mesh.skeleton = skel
  mesh.numBoneInfluencers = 1
  return mesh
}

/**
 * The stand-in assets (procedural, before TL-V's export): 10 folk variants (5 men, 5 women), a guard, an elder and
 * the three animals, on two VATs (human, animal) with the clip names of TOWN_LIFE §3.1, through the same VAT path.
 */
export function stubCrowdAssets(scene: Scene, decorate?: ((m: Material) => void) | null): CrowdAssets {
  const fps = 30
  const made: Array<{ mesh: Mesh; mat: Material }> = []
  const vats: CrowdVat[] = []
  const vatOf = (name: string, body: Body, clips: Record<string, { dur: number; loopM: number; fn: ClipFn }>): CrowdVat => {
    const baked = bakeStub(body, clips, fps)
    const tex = RawTexture.CreateRGBATexture(baked.data, (body.bones.length + 1) * 4, baked.frames, scene, false, false, Texture.NEAREST_NEAREST, Constants.TEXTURETYPE_FLOAT)
    tex.name = `town:vat:${name}`
    const manager = new BakedVertexAnimationManager(scene)
    manager.texture = tex
    const vat: CrowdVat = { name, texture: tex, clips: baked.table, manager }
    vats.push(vat)
    return vat
  }
  const human = vatOf('stub-human', humanBody(false, GARMENTS[0]!, 1), HUMAN_CLIPS)
  const variants: CrowdVariant[] = []
  const add = (id: string, body: Body, vat: CrowdVat, kind: CrowdKind, female: boolean, height: number) => {
    const mesh = stubMesh(`town:${id}`, body, scene)
    const mat = new PBRMaterial(`town:${id}`, scene)
    mat.albedoColor = Color3.White()
    mat.metallic = 0
    mat.roughness = 0.85
    mesh.material = mat
    dressCrowdMaterial(mat, decorate)
    prepareCrowdMesh(mesh, vat)
    made.push({ mesh, mat })
    variants.push({ id, mesh, vat, kind, female, height })
  }
  // The bone pivots of every human stand-in match the VAT's (one shared VAT per skeleton, as TL-V's): only the boxes'
  // sizes and colours vary (a woman's robe is longer); the 0.95 scale of a woman is the instance's, not the mesh's.
  for (let k = 0; k < 10; k++) {
    const female = k >= 5
    add(`stub-${female ? 'w' : 'm'}${k % 5}`, humanBody(female, GARMENTS[k]!, 1), human, 'folk', female, female ? 1.68 : 1.76)
  }
  add('stub-guard', humanBody(false, lin(150, 40, 36), 1), human, 'guard', false, 1.76)
  add('stub-elder', humanBody(false, lin(110, 104, 96), 1), human, 'elder', false, 1.72)
  // Each animal its own small VAT (their pivots differ).
  for (const [kind, h] of [['chicken', 0.42], ['dog', 0.7], ['cat', 0.5]] as const) {
    add(`stub-${kind}`, animalBody(kind), vatOf(`stub-${kind}`, animalBody(kind), ANIMAL_CLIPS), kind, false, h)
  }
  return {
    variants, vats, stub: true,
    dispose: () => {
      for (const { mesh, mat } of made.splice(0)) {
        mat.dispose()
        mesh.skeleton?.dispose()
        mesh.dispose()
      }
      for (const v of vats.splice(0)) {
        v.texture.dispose()
        v.manager.dispose(true)
      }
    },
  }
}
