/**
 * Character, monster and item models from converted glbs (see docs/CONVENTIONS.md: glTF space, 1 unit = 1 m,
 * characters face +Z). One load per glb per scene (so 50 Mangnyangs load one glb); each actor is an instantiated
 * copy with its own skeleton and animation groups.
 *
 * Asset layout (./slim.ts, docs/ASSETS.md): the slimmed tree under /out-opt/ when it is served, else /out/.
 * Slim actors carry no clips in their glb; the sidecar's `animationPacks` names per-skeleton packs. An actor loads
 * `default` with its mesh and its weapon family's pack (sword, spear, bow) lazily; every pack is loaded once and
 * its clips are retargeted onto each actor by joint name (clones share the pack's key data).
 *
 * Appearance (@sro/appearance): players are dressed from their worn item codes. Armour is skinned to the
 * character's skeleton and hides the body parts it replaces; weapons and shields hang on their attach bone with
 * the SRO socket rule; Height is the root scale (owners set it), Volume a radial per-bone skin factor.
 *
 * Animation layers (docs/CONVENTIONS.md "Partial (overlay) clips"):
 *  - base: STAND1 / WALK / RUN, looping;
 *  - action: a full one-shot clip (ATTACKn) that replaces the base until it ends, then the base resumes;
 *  - overlay: a partial one-shot clip (DAMAGE1) started on top of whatever plays; Babylon applies animatables
 *    in start order, so the overlay wins on the few joints it animates (the viewer's approach);
 *  - death: DIE1 once, holding the last pose until revive().
 *
 * Animation cost (PERF2, docs/RENDER.md §11.6): the clips' key interpolation writes into one scratch value per
 * Animation (`installPooledInterpolation`: Babylon allocates a Quaternion or Vector3 per track per frame, the frame's
 * largest single allocator), and the animation LOD updates small, far or off-screen actors' poses at a lower rate
 * (`ANIM_LOD`, `CharacterActor.lodTick`): the clips keep their clock, so a pose is always where it would be, only held
 * longer.
 */
import {
  Animatable,
  Animation,
  AnimationGroup,
  Color3,
  LoadAssetContainerAsync,
  Matrix,
  Mesh,
  Quaternion,
  TransformNode,
  Vector3,
  VertexBuffer,
  type AbstractMesh,
  type AssetContainer,
  type Bone,
  type Material,
  type Node,
  type Observer,
  type Plane,
  type Scene,
  type Skeleton,
} from '@babylonjs/core'
import { GLTFLoaderAnimationStartMode } from '@babylonjs/loaders/glTF/glTFFileLoader.js'
import '@babylonjs/loaders/glTF/2.0/index.js'
import { composeWorn, heightScale, volumeBoneScales, type BoundItem, type Composition } from '@sro/appearance'
import { HIGHLIGHT_COLOR, setHighlightOverlay } from '@sro/world-render'
import { JUMP_MAX_SEEK_MS, type ClipTrack, type EquipSlot, type StarterWeapon } from '@sro/shared'
import type { WeaponModel } from '../content/catalog.ts'
import { characterGender, equipmentLookup } from './equipment.ts'
import { remasterFor } from './remaster.ts'
import { newLook, settings } from '../settings.ts'
import { actorTexturesFor } from './actor-textures.ts'
import { optPath, optUrl, slimAvailable } from './slim.ts'
import type { ClipCursor, ClipCursors } from '../audio/clips.ts'

/**
 * Clips the client uses; the rest are dropped at load to keep instancing cheap. Skills (docs/SKILLS.md §6): the
 * default group's SKILL_1..7, the weapon packs' tier-A and shot clips (`SKILL_1_skill_ch_sword_smash_a`,
 * `SKILL_40_skill_ch_bow_shoot`; higher tiers are past the level cap), and the crowd-control clips.
 * Wave 7B (docs/EFFECTS.md §2.3, §3.11-§3.12): the idle variants (STAND3/4, TURN_L/R), PICK, DEFENCE, DAMAGE2, REVIVAL,
 * the stall pose VENDOR01 and the mob HELP/FIND clips.
 * Wave 10 (docs/MOVEMENT.md §6.1, W10-G): the movement pack's JUMP and JUMP_RUN (JUMP_RUN_FIST); no retail pack has them.
 */
export const KEEP_CLIPS = /^(?:(STAND[1-4]|RUN|WALK|POSE|ATTREADY|SIT|SIT_DOWN|STAND_UP|EMOTION0[1-8]|WAIT0[1-4]|READY0[1-4]|ATTACK[1-4]|DAMAGE[12]|DIE1|PICK|DEFENCE|TURN_[LR]|REVIVAL|VENDOR01|HELP|FIND|JUMP)(_.*)?|SKILL_[1-7]|SKILL_\d+_skill_ch_\w+_(?:a|shoot)|DOWN\w*|STUN\w*)$/

/** Wave 10 (docs/MOVEMENT.md, jump only): the movement clips an actor can play (MV-C). */
export type MoveKind = 'jump'

/** How `CharacterActor.playMove` starts a movement clip (MOVEMENT §6.2; MV-C fills the rules). */
export interface PlayMoveOptions {
  /** Server time of the jump (ms; the `jump` event's `at`) and now, for the latency seek (≤ JUMP_MAX_SEEK_MS). */
  at?: number
  now?: number
  /** Seconds into the clip to start at (the latency seek plus the JUMP_RUN phase seek, one budget). */
  seekS?: number
  /** Seconds into the base clip where it resumes when the move ends (JUMP_RUN's `exitPhaseS`); default its start. */
  resumeBaseS?: number
}

/** One event of a movement clip (the retail sidecar shape; `p1` 'takeoff' / 'land', docs/MOVEMENT.md §2.2). */
export interface MoveEvent {
  timeMs: number
  type: number
  p1: string
  p2: number
}

/** One clip of the movement index (MV-A's `movement.json`, docs/MOVEMENT.md §2.2, §3.3). */
export interface MoveClipInfo {
  /** The animation's name in `movement.glb` (`chinaman_jump`). */
  anim: string
  durationMs: number
  fps: number
  events: MoveEvent[]
  /** The lowest foot contact per 1/`fps` s (metres over the ground); kept for GRASS_LIFE, unused in v1 (D21). */
  air?: number[]
  /** A running clip: the RUN it was keyed on, and the phases (s) of that RUN it starts from and hands back at. */
  run?: string
  enterPhaseS?: number
  exitPhaseS?: number
}

/** The per-skeleton movement index: the clips by name (JUMP, JUMP_RUN, JUMP_RUN_FIST) and RUN clip → its JUMP_RUN. */
export interface MovementIndex {
  clips: Record<string, MoveClipInfo>
  runJumps: Record<string, string>
}

/** A loaded movement pack: the clips (kept out of the scene) and their index. */
export interface MovementPack {
  container: AssetContainer
  index: MovementIndex
}

/** Where a clip is relative to its take-off and landing: on the ground before, in the air, back on the ground after. */
export type MovePhase = 'before' | 'air' | 'after'

/** The pack of one skeleton, relative to the asset root (/out/ or /out-opt/), and its index next to it. */
export function movementPackPaths(skeleton: string): { glb: string; index: string } {
  return { glb: `char/_anims/${skeleton}/movement.glb`, index: `char/_anims/${skeleton}/movement.json` }
}

/** Blend-in speed of a movement clip (4 evaluations: the crouch starts at once, MOVEMENT §6.2). */
export const MOVE_BLEND_IN = 0.25
/** Blend back to the base after a movement clip (≈ 8 evaluations; the base clips' own speed is 0.08). */
export const MOVE_BLEND_OUT = 0.12
/** The base clips' blending speed (prepareGroup). */
const BASE_BLEND = 0.08
/** JUMP_RUN seeks into its start when the running base is this far (s) past its own right contact (MOVEMENT §6.2). */
export const JUMP_RUN_ENTRY_WINDOW_S = 0.15
/** The landing footstep plays twice this far apart (ms), louder (MOVEMENT §6.4). */
export const JUMP_LAND_ECHO_MS = 30
/** Raw names of the synthetic movement sound tracks (audio/entity.ts plays the land one at +2 dB). */
export const JUMP_TAKEOFF_RAW = 'jump_takeoff'
export const JUMP_LAND_RAW = 'jump_land'
/** The footstep a synthetic track names; audio/cues.ts stepFile swaps it for the surface's run step. */
const JUMP_STEP_FILE = 'player/mvrunground'

const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Parses `movement.json` (MV-A); null when it is not a movement index. Unknown or broken clips are dropped. */
export function parseMovementIndex(raw: unknown): MovementIndex | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { clips?: unknown; runJumps?: unknown }
  if (!r.clips || typeof r.clips !== 'object') return null
  const clips: Record<string, MoveClipInfo> = {}
  for (const [name, v] of Object.entries(r.clips as Record<string, unknown>)) {
    if (!KEEP_CLIPS.test(name) || !/^JUMP/.test(name) || !v || typeof v !== 'object') continue
    const c = v as Record<string, unknown>
    if (typeof c.anim !== 'string' || !finiteNum(c.durationMs) || c.durationMs <= 0) continue
    const events = (Array.isArray(c.events) ? c.events : []).filter((e): e is MoveEvent => {
      const x = e as Partial<MoveEvent> | null
      return !!x && finiteNum(x.timeMs) && typeof x.p1 === 'string'
    }).map(e => ({ timeMs: e.timeMs, type: finiteNum(e.type) ? e.type : 2, p1: e.p1, p2: finiteNum(e.p2) ? e.p2 : 0 }))
    const info: MoveClipInfo = { anim: c.anim, durationMs: c.durationMs, fps: finiteNum(c.fps) && c.fps > 0 ? c.fps : 30, events }
    if (Array.isArray(c.air) && c.air.every(finiteNum)) info.air = c.air as number[]
    if (typeof c.run === 'string') info.run = c.run
    if (finiteNum(c.enterPhaseS)) info.enterPhaseS = c.enterPhaseS
    if (finiteNum(c.exitPhaseS)) info.exitPhaseS = c.exitPhaseS
    clips[name] = info
  }
  if (!Object.keys(clips).length) return null
  const runJumps: Record<string, string> = {}
  if (r.runJumps && typeof r.runJumps === 'object') {
    for (const [run, clip] of Object.entries(r.runJumps as Record<string, unknown>)) if (typeof clip === 'string' && clips[clip]) runJumps[run] = clip
  }
  return { clips, runJumps }
}

/** The take-off and landing times of a movement clip (ms; from its events). */
export function moveEventTimes(info: MoveClipInfo): { takeoffMs: number; landMs: number } {
  const at = (p1: string, dflt: number) => info.events.find(e => e.p1 === p1)?.timeMs ?? dflt
  return { takeoffMs: at('takeoff', 0), landMs: at('land', info.durationMs) }
}

/**
 * Where to start a jump clip (s), one seek budget (MOVEMENT §6.2 "One seek budget"): the viewer's latency seek
 * (`now − at`, capped at JUMP_MAX_SEEK_MS) plus the JUMP_RUN phase seek. When the sum would pass the cap, the phase
 * seek is dropped (the clip then blends in from 0 plus the latency), so a late viewer never skips the take-off.
 */
export function jumpSeekS(latencyMs: number, phaseS = 0): number {
  const lat = Math.min(Math.max(0, Number.isFinite(latencyMs) ? latencyMs : 0), JUMP_MAX_SEEK_MS) / 1000
  const phase = Number.isFinite(phaseS) && phaseS > 0 ? phaseS : 0
  return lat + phase > JUMP_MAX_SEEK_MS / 1000 + 1e-9 ? lat : lat + phase
}

/**
 * How far (s) a running base at `phaseS` of its `cycleS` cycle is past the JUMP_RUN's entry phase, when that is inside
 * JUMP_RUN_ENTRY_WINDOW_S (the first 0.15 s of its own right stance); else 0 (the clip starts at 0 and blends).
 */
export function runEntrySeekS(phaseS: number, enterPhaseS: number, cycleS: number): number {
  if (!(cycleS > 0) || !Number.isFinite(phaseS)) return 0
  const d = (((phaseS - enterPhaseS) % cycleS) + cycleS) % cycleS
  return d < JUMP_RUN_ENTRY_WINDOW_S ? d : 0
}

/** The synthetic sound tracks of a movement clip: a run step at the take-off, and twice at the landing (§6.4). */
export function movementTracksOf(info: MoveClipInfo): ClipTrack[] {
  const out: ClipTrack[] = []
  for (const e of info.events) {
    if (e.p1 === 'takeoff') out.push({ ms: e.timeMs, handle: 'step_run', raw: JUMP_TAKEOFF_RAW, file: JUMP_STEP_FILE })
    else if (e.p1 === 'land') {
      out.push({ ms: e.timeMs, handle: 'step_run', raw: JUMP_LAND_RAW, file: JUMP_STEP_FILE })
      out.push({ ms: e.timeMs + JUMP_LAND_ECHO_MS, handle: 'step_run', raw: JUMP_LAND_RAW, file: JUMP_STEP_FILE })
    }
  }
  return out.sort((a, b) => a.ms - b.ms)
}

/** The weapon-arm joints (clavicle → hand and fingers) of side `L` or `R` (the masked arm layer, MOVEMENT §6.2). */
export function isArmJoint(name: string | undefined, sides: readonly ('L' | 'R')[]): boolean {
  const m = name ? /^Bip01 ([LR]) (Clavicle|UpperArm|Forearm|Hand|Finger)/.exec(name) : null
  return !!m && sides.includes(m[1] as 'L' | 'R')
}

/** The arms the weapon layer holds for a family (sword/blade: the sword arm, plus the left with a shield; else both). */
export function armLayerSides(family: StarterWeapon | null, shield: boolean): ('L' | 'R')[] {
  if (!family) return []
  if (family === 'sword' || family === 'blade') return shield ? ['L', 'R'] : ['R']
  return ['L', 'R']
}
/** Pack groups not loaded at startup (carts, avatar mounts and wings); useClipGroup loads `cart` on demand. */
const SKIP_PACKS = /^(cart|avatar)/
const DEFAULT_ATTACH_BONE = 'Bip01 R HandMid'

/** Weapon families whose characters have their own stand/run clips (named `<CLIP>_<ban file>`). */
const FAMILY_CLIP: Record<StarterWeapon, RegExp | null> = {
  sword: /sword/i,
  blade: /sword/i,
  spear: /spear/i,
  glaive: /spear/i,
  bow: /bow/i,
}

/** Basic-attack clips per weapon family (player models); mobs use the plain ATTACK1..4. Blades share the sword group. */
const FAMILY_ATTACK: Record<StarterWeapon, RegExp> = {
  sword: /^ATTACK\d_sword_base/,
  blade: /^ATTACK\d_sword_base/,
  spear: /^ATTACK\d_skill_ch_spear_base/,
  glaive: /^ATTACK\d_skill_ch_spear_base/,
  bow: /^ATTACK1_skill_ch_bow_normal$/,
}

/** Animation pack of each weapon family's clips (slim layout); blades use the sword group (docs/SKILLS.md §6). */
const FAMILY_PACK: Record<StarterWeapon, string | null> = {
  sword: 'sword',
  blade: 'sword',
  spear: 'spear',
  glaive: 'spear',
  bow: 'bow',
}

/**
 * Looping base clips. The idle ones (EntityView.setIdle, docs/WAVE_PLAN2.md D7) fall back when missing: ATTREADY and
 * SIT to STAND1, VENDOR01 to SIT; WALK falls back to RUN.
 */
export type BaseClip = 'STAND1' | 'RUN' | 'WALK' | 'ATTREADY' | 'SIT' | 'VENDOR01'
/** Death clips (die()); DIE1_RM (the lying rest loop) follows when the actor has it. */
export type DeathClip = 'DIE1' | 'DOWN_DIE'
/** Idle variants played now and then (docs/EFFECTS.md §3.11): NPC STAND2-4 and the soldiers' TURN_L/R, the player's STAND3. */
const IDLE_VARIANT = /^(STAND[234]|TURN_[LR])(_|$)/
/** Clip groups of carts and avatar mounts: never a variant of the actor on foot. */
const MOUNT_CLIP = /cart|avatar|nasrun/i
/**
 * Which clip group the base clips come from (CharacterActor.useClipGroup, docs/WAVE_PLAN2.md D8): 'default' on foot,
 * 'cart' the rider pose on a horse (`STAND1_cart_stand01`, `WALK_cart_walk`, `RUN_cart_walk`).
 */
export type ClipGroup = 'default' | 'cart'

/** Anything with a glb: a player model, a mob, an NPC. */
export interface ModelSource {
  code: string
  glb: string
  sidecar?: string
}

/** How a player looks: what they wear and their body choices (EntityState / CharacterSummary fields). */
export interface Look {
  /** Worn item codes per slot; undefined = unknown (draw `fallbackWeapon` only). */
  equip?: Partial<Record<EquipSlot, string>>
  /** Weapon family: picks the stance/attack clips and their animation pack. */
  family?: StarterWeapon
  /** Weapon model used when the equipment manifest cannot draw the worn weapon (or `equip` is unknown). */
  fallbackWeapon?: WeaponModel
  /** Height choice 0..4 (uniform root scale; applied by character() when given). */
  height?: number
  /** Volume choice 0..4 (per-bone radial skin factor). */
  volume?: number
}

/** Clip facts from the converter sidecar. */
export interface ClipInfo {
  durationMs: number
  partial: boolean
  /** Times (ms from clip start) of the type-1 (hit) events. */
  hits: number[]
  /** Sidecar aniGroup ('default', 'sword', ...) and TYPE_NAME ('SKILL_1'): how skills find their clips. */
  group?: string
  type?: string
}

/** One phase of a skill action (CharacterActor.playSkill): `clip` held for `ms`, looping when `loop`. */
export interface SkillPhase {
  clip: AnimationGroup
  ms: number
  loop?: boolean
  speed?: number
}

/** Sidecar `animationPacks` (docs/ASSETS.md 5.3). */
interface PackIndex {
  packs: Record<string, string>
  clips: Record<string, [string, string]>
  /** The skeleton the packs are for (`europeman_skel`): where the movement pack lives (wave 10). */
  skeleton?: string
}

interface Loaded {
  container: AssetContainer
  sidecar: Record<string, unknown> | null
  /** Slim actors: where their clips live (the container has none). */
  packs: PackIndex | null
}

async function fetchSidecar(url: string | undefined): Promise<Record<string, unknown> | null> {
  if (!url) return null
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

function packIndexOf(sidecar: Record<string, unknown> | null): PackIndex | null {
  const p = sidecar?.animationPacks as Partial<PackIndex> & { format?: string } | undefined
  if (!p || p.format !== 'sro-anim-packs' || !p.packs || !p.clips) return null
  return { packs: p.packs, clips: p.clips, ...(typeof p.skeleton === 'string' && p.skeleton ? { skeleton: p.skeleton } : {}) }
}

/**
 * The skeleton an actor's clips are for (wave 10, MOVEMENT §2.2): the slim sidecar's `animationPacks.skeleton`, else
 * the basename of the unslimmed sidecar's `skeleton.bsk` (`prim\skel\char\europe\europeman_skel.bsk`); null when unknown.
 */
export function skeletonNameOf(sidecar: Record<string, unknown> | null): string | null {
  const packs = packIndexOf(sidecar)
  if (packs?.skeleton) return packs.skeleton
  const bsk = (sidecar?.skeleton as { bsk?: unknown } | undefined)?.bsk
  if (typeof bsk !== 'string') return null
  const name = bsk.split(/[\\/]/).pop()?.replace(/\.bsk$/i, '') ?? ''
  return /^[\w-]+$/.test(name) ? name : null
}

/** Per-clip facts (duration, partial flag, hit events) from a sidecar's `animations`. */
export function clipInfoFromSidecar(sidecar: Record<string, unknown> | null): Map<string, ClipInfo> {
  const out = new Map<string, ClipInfo>()
  const anims = sidecar?.animations
  if (!Array.isArray(anims)) return out
  for (const a of anims) {
    if (!a || typeof a !== 'object') continue
    const r = a as Record<string, unknown>
    if (typeof r.name !== 'string') continue
    const events = Array.isArray(r.events) ? (r.events as Record<string, unknown>[]) : []
    out.set(r.name, {
      durationMs: typeof r.durationMs === 'number' ? r.durationMs : 1000,
      partial: r.partial === true,
      hits: events.filter(e => e && e.type === 1 && typeof e.timeMs === 'number').map(e => e.timeMs as number).sort((x, y) => x - y),
      ...(typeof r.group === 'string' ? { group: r.group } : {}),
      ...(typeof r.typeName === 'string' ? { type: r.typeName } : {}),
    })
  }
  return out
}

/** Weighted progress of several parts, reported as one fraction. */
function progressParts(onProgress: ((f: number) => void) | undefined, weights: number[]): Array<(f: number) => void> {
  const total = weights.reduce((a, b) => a + b, 0)
  const done = weights.map(() => 0)
  return weights.map((w, i) => (f: number) => {
    done[i] = Math.max(done[i]!, Math.min(1, f))
    onProgress?.(done.reduce((a, d, j) => a + d * weights[j]!, 0) / total)
  })
}

const LOAD_OPTIONS = { pluginOptions: { gltf: { animationStartMode: GLTFLoaderAnimationStartMode.NONE } } }

/**
 * Runs on every material of every container the library loads (actor glbs, equipment, animation packs), right after
 * the load (docs/WAVE_PLAN3.md D9). Wave 9: WX-C's actor wetness (`attachWetness`), GAME's
 * `world.render.decorateCharacterMaterial`. `glb` is the URL the container came from.
 */
export type ActorMaterialDecorator = (mat: Material, info: { glb: string; container: AssetContainer }) => void

export class ModelLibrary {
  private readonly cache = new Map<string, Promise<Loaded>>()
  private readonly packCache = new Map<string, Promise<AssetContainer>>()
  /** Wave 10: the movement pack per skeleton (movementPack). */
  private readonly movementCache = new Map<string, Promise<MovementPack | null>>()
  private disposed = false
  private readonly decorators: ActorMaterialDecorator[] = []
  /** Containers loaded so far (a decorator added later runs on them too). */
  private readonly loadedContainers: { container: AssetContainer; glb: string }[] = []
  /** Live actors made here, culled against the main camera before each active-mesh evaluation (CharacterActor.cull). */
  private readonly actors = new Set<CharacterActor>()
  private readonly cullObs: Observer<Scene> | null
  /** Main-camera actor culling (W9A perf pass; on by default, false draws every actor always: the LAB A/B). */
  actorCulling = true
  /**
   * Animation LOD (PERF2, ANIM_LOD): on with the new look, off without it (the Low guard: every pose every frame, as
   * before wave 9; W9F LG-5; also in the Low guard's combination, settings.ts `newLook`). Setting it pins it for this
   * library (the LAB A/B; tests).
   */
  get animLod(): boolean {
    return this.animLodPinned ?? newLook(settings.get())
  }

  set animLod(on: boolean) {
    this.animLodPinned = on
  }

  private animLodPinned: boolean | null = null
  /** Clock of the animation LOD (ms; tests). */
  now: () => number = () => performance.now()
  private readonly lodObs: Observer<Scene> | null

  constructor(readonly scene: Scene) {
    installPooledInterpolation()
    this.cullObs = scene.onBeforeActiveMeshesEvaluationObservable.add(() => this.cullActors())
    this.lodObs = scene.onBeforeAnimationsObservable.add(() => this.lodActors())
  }

  /** The pooled-interpolation switch (animationPool; console handle for the LAB A/B). */
  get interpolationPool(): typeof animationPool {
    return animationPool
  }

  /** Before the frame's animations: which actors update their pose this frame (ANIM_LOD). */
  lodActors(): void {
    const eye = this.animLod ? (this.scene.activeCamera?.globalPosition ?? null) : null
    const now = this.now()
    // An actor carrying an every-frame one (the player's horse: attachTo its saddle joint) updates every frame too.
    for (const a of this.actors) a.lodCarrier = false
    for (const a of this.actors) {
      const at = a.lodFull ? a.attachedTo : null
      for (let p: Node | null = at; p; p = p.parent) {
        const carrier = this.actorOfRoot(p)
        if (carrier) {
          carrier.lodCarrier = true
          break
        }
      }
    }
    // Wave 11 (UNIQUES D-U22): a follower (`lodLeader`) copies its leader's decision, so the leaders tick first.
    let followers = false
    for (const a of this.actors) {
      if (a.lodLeader) followers = true
      else a.lodTick(now, eye)
    }
    if (followers) for (const a of this.actors) if (a.lodLeader) a.lodTick(now, eye)
  }

  private actorOfRoot(node: Node): CharacterActor | null {
    for (const a of this.actors) if (a.root === node) return a
    return null
  }

  /** Culls every actor against the frustum the scene is evaluating now (the active camera's, this frame). */
  cullActors(): void {
    const planes = this.actorCulling ? this.scene.frustumPlanes : null
    // Wave 11: a follower (`lodLeader`) takes its leader's cull, so the leaders are culled first.
    let followers = false
    for (const a of this.actors) {
      if (a.lodLeader) followers = true
      else if (planes?.length) a.cull(planes)
      else a.setOffscreen(false)
    }
    if (!followers) return
    for (const a of this.actors) {
      if (!a.lodLeader) continue
      if (planes?.length) a.cull(planes)
      else a.setOffscreen(false)
    }
  }

  /** Live actors made by this library (culling; tests). */
  get liveActors(): ReadonlySet<CharacterActor> {
    return this.actors
  }

  /**
   * Adds a material decorator (D9): it runs at once on every container loaded so far, then on each new one. Returns a
   * remover (materials already decorated stay as they are). A decorator that throws is logged.
   */
  addMaterialDecorator(fn: ActorMaterialDecorator): () => void {
    this.decorators.push(fn)
    for (const e of this.loadedContainers) this.runDecorators(e.container, e.glb, [fn])
    return () => {
      const i = this.decorators.indexOf(fn)
      if (i >= 0) this.decorators.splice(i, 1)
    }
  }

  private noteLoaded(container: AssetContainer, glb: string): void {
    if (this.disposed) return
    this.loadedContainers.push({ container, glb })
    if (this.decorators.length) this.runDecorators(container, glb, this.decorators)
  }

  private runDecorators(container: AssetContainer, glb: string, list: readonly ActorMaterialDecorator[]): void {
    for (const mat of container.materials) {
      for (const fn of list) {
        try {
          fn(mat, { glb, container })
        } catch (err) {
          console.warn('[models] material decorator failed', glb, mat.name, err)
        }
      }
    }
  }

  /** A glb (and its sidecar), from /out-opt/ when available, loaded once per library. */
  load(glb: string, sidecar?: string, onProgress?: (fraction: number) => void): Promise<Loaded> {
    let p = this.cache.get(glb)
    if (!p) {
      p = (async () => {
        const og = (await slimAvailable()) ? optUrl(glb) : null
        if (og) {
          try {
            return await this.loadFrom(og, sidecar ? (optUrl(sidecar) ?? sidecar) : undefined, onProgress)
          } catch (err) {
            console.warn('[models] slim copy unavailable, loading the original', og, err)
          }
        }
        return this.loadFrom(glb, sidecar, onProgress)
      })()
      this.cache.set(glb, p)
      p.catch(() => this.cache.delete(glb))
    } else if (onProgress) {
      void p.then(() => onProgress(1), () => {})
    }
    return p
  }

  private async loadFrom(glb: string, sidecar: string | undefined, onProgress?: (fraction: number) => void): Promise<Loaded> {
    const [side, box] = await Promise.allSettled([
      fetchSidecar(sidecar),
      LoadAssetContainerAsync(glb, this.scene, {
        ...LOAD_OPTIONS,
        onProgress: ev => {
          if (ev.lengthComputable && ev.total > 0) onProgress?.(ev.loaded / ev.total)
        },
      }),
    ])
    if (box.status === 'rejected') throw box.reason
    const container = box.value
    if (side.status === 'rejected') {
      // A glb without its sidecar is only usable when it is the original (clips embedded).
      if (glb.startsWith('/out-opt/')) {
        container.dispose()
        throw side.reason
      }
      console.warn('[models] no sidecar for', glb, side.reason)
    }
    const sidecarData = side.status === 'fulfilled' ? side.value : null
    for (const g of [...container.animationGroups]) {
      if (!KEEP_CLIPS.test(g.name)) {
        container.animationGroups.splice(container.animationGroups.indexOf(g), 1)
        g.dispose()
      }
    }
    // Remastered textures (test switch): swaps this glb's materials for PBR twins while the switch is on.
    remasterFor(this.scene).track(container, glb)
    // Wave 9B (TX-R): the texture tier's sets swap in a moment after the glb appears (three/actor-textures.ts).
    actorTexturesFor(this.scene).track(container, glb, sidecarData)
    this.noteLoaded(container, glb)
    onProgress?.(1)
    return { container, sidecar: sidecarData, packs: packIndexOf(sidecarData) }
  }

  /** An animation pack (slim root relative path), loaded once and kept out of the scene. */
  pack(rel: string, onProgress?: (fraction: number) => void): Promise<AssetContainer> {
    const url = optPath(rel)
    let p = this.packCache.get(url)
    if (!p) {
      p = LoadAssetContainerAsync(url, this.scene, {
        ...LOAD_OPTIONS,
        onProgress: ev => {
          if (ev.lengthComputable && ev.total > 0) onProgress?.(ev.loaded / ev.total)
        },
      })
      p.then(c => this.noteLoaded(c, url), () => {})
      this.packCache.set(url, p)
      p.catch(() => this.packCache.delete(url))
    }
    return p
  }

  /**
   * The movement pack of a skeleton (wave 10, docs/MOVEMENT.md §6.1): `movement.glb` and its index `movement.json`, from
   * /out-opt/ when that is served (else, or when it lacks them, /out/), loaded once per library and kept out of the
   * scene. null when the tree has none (an old export): the jump then plays nothing. Only the world screen asks for it,
   * after worldEnter (CharacterActor.ensureMovementClips; never the character stages, WAVE_PLAN6 D32).
   */
  movementPack(skeleton: string): Promise<MovementPack | null> {
    let p = this.movementCache.get(skeleton)
    if (!p) {
      p = (async () => {
        const rel = movementPackPaths(skeleton)
        const roots = (await slimAvailable()) ? [optPath(''), '/out/'] : ['/out/']
        for (const root of roots) {
          try {
            const res = await fetch(root + rel.index)
            if (!res.ok) continue
            const index = parseMovementIndex(await res.json())
            if (!index) continue
            const container = await LoadAssetContainerAsync(root + rel.glb, this.scene, LOAD_OPTIONS)
            if (this.disposed) {
              container.dispose()
              return null
            }
            this.noteLoaded(container, root + rel.glb)
            return { container, index }
          } catch (err) {
            console.warn('[models] movement pack failed', root + rel.glb, err)
          }
        }
        console.info('[models] no movement pack for', skeleton)
        return null
      })()
      this.movementCache.set(skeleton, p)
    }
    return p
  }

  /**
   * Loads (or reuses) the model and returns a new actor with its clips, dressed as `look` says. Equipment that
   * fails to load is left off (never fatal); the actor appears only when everything it wears is ready.
   */
  async character(model: ModelSource, look: Look = {}, onProgress?: (fraction: number) => void): Promise<CharacterActor> {
    const [pBody, pClips, pDress] = progressParts(onProgress, [1, 4, 2])
    const body = await this.load(model.glb, model.sidecar, pBody)
    if (this.disposed) throw new Error('scene disposed')
    const actor = new CharacterActor(this.scene, model, body)
    // Not drawn while it is dressed (P-STALL): it appears when everything it wears is ready, as documented above. A
    // frame that drew the half-dressed body (its meshes are always active) compiled its materials then and there:
    // 14 shaders and 12 pipelines in one 0.4 s frame when the create screen switched to a new model.
    actor.root.setEnabled(false)
    actor.loadPack = rel => this.pack(rel)
    actor.loadMovement = skeleton => this.movementPack(skeleton)
    this.actors.add(actor)
    actor.root.onDisposeObservable.addOnce(() => this.actors.delete(actor))
    if (look.height !== undefined) actor.root.scaling.setAll(heightScale(look.height))
    await Promise.all([
      this.ensureClips(actor, look.family, pClips).catch(err => console.warn('[models] clips failed', model.code, err)),
      this.dress(actor, look).then(() => pDress(1)),
    ])
    pClips(1)
    if (this.disposed) {
      actor.dispose()
      throw new Error('scene disposed')
    }
    if (!actor.isDisposed) actor.root.setEnabled(true)
    return actor
  }

  /** Loads the animation packs an actor needs (slim layout): default + its weapon family's (players). */
  async ensureClips(actor: CharacterActor, family: StarterWeapon | null | undefined, onProgress?: (fraction: number) => void): Promise<void> {
    const idx = actor.packs
    if (!idx) return
    let groups: string[]
    if (actor.isPlayer) {
      const g = family ? FAMILY_PACK[family] : null
      groups = ['default', ...(g ? [g] : [])]
    } else {
      groups = [...new Set(Object.entries(idx.clips).filter(([name, [g]]) => KEEP_CLIPS.test(name) && !SKIP_PACKS.test(g)).map(([, [g]]) => g))]
    }
    groups = groups.filter(g => idx.packs[g] && !actor.hasPack(g))
    const parts = progressParts(onProgress, groups.map(g => (g === 'default' ? 2 : 1)))
    await Promise.all(groups.map(async (g, i) => {
      const pack = await this.pack(idx.packs[g]!, parts[i])
      parts[i]!(1)
      if (!this.disposed && !actor.isDisposed) actor.addPackClips(g, pack)
    }))
  }

  /**
   * Dresses an actor (again): composes `look.equip` with the equipment manifest, loads the item models and swaps
   * them in at once, and loads the weapon family's clips. A newer call supersedes an older one still loading.
   */
  async dress(actor: CharacterActor, look: Look): Promise<void> {
    const token = actor.beginDress()
    const lookup = await equipmentLookup()
    let comp: Composition | null = null
    if (lookup && look.equip && lookup.characters.has(actor.model.code)) {
      comp = composeWorn(lookup, actor.model.code, look.equip)
      for (const r of comp.rejected) if (r.reason !== 'unknown') console.warn(`[models] ${actor.model.code}: ${r.code} not drawn (${r.detail})`)
    }
    const items = comp?.bind ?? []
    const wornWeapon = look.equip ? look.equip.weapon : undefined
    const fallback = !items.some(b => b.slot === 'weapon') && look.fallbackWeapon && (look.equip === undefined || wornWeapon !== undefined)
      ? look.fallbackWeapon
      : null
    const [loaded, fb] = await Promise.all([
      // Socket items (weapons, shields) load their sidecar too: its `dummies` are the trail points (weaponDummy).
      Promise.all(items.map(b => this.load(b.glb, b.kind === 'socket' ? sidecarOf(b.glb) : undefined).catch(err => (console.warn('[models] item failed', b.code, b.glb, err), null)))),
      fallback ? this.load(fallback.glb, fallback.sidecar).catch(err => (console.warn('[models] weapon failed', fallback.glb, err), null)) : null,
      this.ensureClips(actor, look.family).catch(err => console.warn('[models] weapon clips failed', look.family, err)),
    ])
    if (this.disposed || actor.isDisposed || !actor.isDressToken(token)) return
    actor.applyDress({
      comp,
      items: items.flatMap((b, i) => (loaded[i] ? [{ item: b, container: loaded[i]!.container, sidecar: loaded[i]!.sidecar }] : [])),
      fallback: fb ? { container: fb.container, attachBone: typeof fb.sidecar?.attachBone === 'string' ? fb.sidecar.attachBone : DEFAULT_ATTACH_BONE, sidecar: fb.sidecar } : null,
      family: look.family ?? null,
      gender: characterGender(actor.model.code, lookup),
      volume: look.volume,
    })
  }

  dispose(): void {
    this.disposed = true
    if (this.cullObs) this.scene.onBeforeActiveMeshesEvaluationObservable.remove(this.cullObs)
    if (this.lodObs) this.scene.onBeforeAnimationsObservable.remove(this.lodObs)
    this.actors.clear()
    this.decorators.length = 0
    this.loadedContainers.length = 0
    const remaster = remasterFor(this.scene)
    const textures = actorTexturesFor(this.scene)
    for (const p of this.cache.values()) {
      p.then(l => {
        remaster.untrack(l.container)
        textures.untrack(l.container)
        l.container.dispose()
      }, () => {})
    }
    for (const p of this.packCache.values()) p.then(c => c.dispose(), () => {})
    for (const p of this.movementCache.values()) p.then(m => m?.container.dispose(), () => {})
    this.cache.clear()
    this.packCache.clear()
    this.movementCache.clear()
  }
}

/** Frames per second of a group's key axis (glTF clips are on Babylon's 60 fps axis, MOVEMENT §3.3 finding 2). */
function frameRate(g: AnimationGroup): number {
  return g.targetedAnimations[0]?.animation.framePerSecond || 60
}

function nodeName(b: Bone): string {
  return b.getTransformNode()?.name ?? b.name
}

// ---- Volume: radial per-bone scale on the skin matrix only (children and sockets do not move) -----------------

interface SkeletonInternals {
  _computeTransformMatrices(target: Float32Array, initialSkinMatrix: Matrix | null): void
}

interface VolumeEntry {
  bone: Bone
  /** Index of the bone's 16 floats in the skin matrix array. */
  at: number
  f: number
}

const volumePatches = new WeakMap<Skeleton, { entries: VolumeEntry[] }>()
const volS = new Matrix()
const volM = new Matrix()

/**
 * skin(bone) = inverseBind x S x boneWorld with S = scale(1, f, f) in the bone's own frame (X runs along the bone),
 * written after Babylon's own computation, so only that bone's vertices change (docs/CHARACTER_SCALE.md E9).
 */
function setSkeletonVolume(skeleton: Skeleton, scales: Map<string, number>): void {
  let patch = volumePatches.get(skeleton)
  if (!patch && !scales.size) return
  if (!patch) {
    const p = { entries: [] as VolumeEntry[] }
    patch = p
    volumePatches.set(skeleton, p)
    const sk = skeleton as unknown as SkeletonInternals
    const original = sk._computeTransformMatrices.bind(skeleton)
    sk._computeTransformMatrices = (target, initial) => {
      original(target, initial)
      for (const e of p.entries) {
        Matrix.ScalingToRef(1, e.f, e.f, volS)
        volS.multiplyToRef(e.bone.getFinalMatrix(), volM)
        e.bone.getAbsoluteInverseBindMatrix().multiplyToArray(volM, target, e.at)
      }
    }
  }
  patch.entries = []
  skeleton.bones.forEach((bone, i) => {
    const f = scales.get(nodeName(bone))
    const index = (bone as unknown as { _index: number | null })._index
    if (f === undefined || index === -1) return
    patch.entries.push({ bone, at: (index ?? i) * 16, f })
  })
  skeleton.bones[0]?.markAsDirty()
}

// ---- animation cost (PERF2) --------------------------------------------------------------------------------------

/**
 * Pooled key interpolation (PERF2): `Animation.quaternionInterpolateFunction` / `vector3InterpolateFunction` return a
 * new object per track per frame (Quaternion.Slerp, Vector3.Lerp): about 6,000 per frame at the plaza (the actors'
 * bones and the world's animated objects), ~145 KB a frame, the largest single allocator. Babylon's RuntimeAnimation
 * copies the value it gets (`_currentValue.copyFrom`, a clone on the first frame, or a new blend) before the next track
 * is evaluated, so one scratch value per Animation is enough. Only animations in the CYCLE loop mode (every glTF clip) are
 * pooled: the relative and constant modes keep interpolated values across calls (RuntimeAnimation's offset and
 * high-limit caches). Installed on Animation.prototype once (installPooledInterpolation, by the first ModelLibrary):
 * nothing in the game keeps an `Animation.evaluate()` result. `enabled` false is Babylon's own path (the LAB A/B).
 */
export const animationPool = { enabled: true }

interface PooledAnimation {
  loopMode: number | undefined
  __sroQ?: Quaternion
  __sroV?: Vector3
}

let pooledInstalled = false

/** Installs the pooled interpolation on Animation.prototype (idempotent). */
export function installPooledInterpolation(): void {
  if (pooledInstalled) return
  pooledInstalled = true
  const proto = Animation.prototype
  const slerp = proto.quaternionInterpolateFunction
  const lerp = proto.vector3InterpolateFunction
  const CYCLE = Animation.ANIMATIONLOOPMODE_CYCLE
  proto.quaternionInterpolateFunction = function (this: Animation, a: Quaternion, b: Quaternion, t: number): Quaternion {
    const self = this as unknown as PooledAnimation
    if (!animationPool.enabled || (self.loopMode !== undefined && self.loopMode !== CYCLE)) return slerp.call(this, a, b, t)
    return Quaternion.SlerpToRef(a, b, t, (self.__sroQ ??= new Quaternion()))
  }
  proto.vector3InterpolateFunction = function (this: Animation, a: Vector3, b: Vector3, t: number): Vector3 {
    const self = this as unknown as PooledAnimation
    if (!animationPool.enabled || (self.loopMode !== undefined && self.loopMode !== CYCLE)) return lerp.call(this, a, b, t)
    return Vector3.LerpToRef(a, b, t, (self.__sroV ??= new Vector3()))
  }
}

/**
 * Animation LOD (PERF2): how often an actor's pose updates, from its size on screen (model height × root scale ÷
 * camera distance) and whether it is in view. At or above `fullSize` every frame; below, the first tier whose size it
 * reaches gives the rate in Hz. Off screen (the main-camera cull) `offscreenHz`, or `offscreenNearHz` within
 * `offscreenNearM` (it still casts a shadow into view). A skipped frame skips the actor's animatables and its skin
 * matrices (Skeleton.prepare), and the clips keep their clock: the next update jumps to where the pose would be.
 */
export const ANIM_LOD = {
  fullSize: 0.12,
  tiers: [
    [0.05, 30],
    [0.025, 20],
    [0, 10],
  ] as ReadonlyArray<readonly [number, number]>,
  offscreenHz: 10,
  offscreenNearHz: 20,
  offscreenNearM: 50,
  /** An update is due this much before a whole interval has passed (frame-time jitter). */
  slackMs: 6,
}

/**
 * G1 rescue (world/crowd-budget.ts): an actor's off-screen rule in a crowd. 'normal' is ANIM_LOD's; 'slow' the far
 * off-screen rate at any distance (the actor casts no shadow into view); 'freeze' no update until it is back in view
 * (it is beyond every sound and shadow range as well).
 */
export type CrowdOffscreen = 'normal' | 'slow' | 'freeze'

/** Milliseconds between pose updates (0 = every frame) for a screen size, a camera distance and the cull. */
export function animIntervalMs(size: number, distance: number, offscreen: boolean): number {
  if (offscreen) return 1000 / (distance <= ANIM_LOD.offscreenNearM ? ANIM_LOD.offscreenNearHz : ANIM_LOD.offscreenHz)
  if (!(size < ANIM_LOD.fullSize)) return 0
  for (const [min, hz] of ANIM_LOD.tiers) if (size >= min) return 1000 / hz
  return 1000 / ANIM_LOD.tiers[ANIM_LOD.tiers.length - 1]![1]
}

interface AnimatableInternals {
  _animate(delay: number): boolean
  /** The actor whose LOD this animatable follows (set when its group starts). */
  __sroActor?: CharacterActor
}

/** Babylon's own step (Animatable.prototype._animate). */
const baseAnimate = (Animatable.prototype as unknown as AnimatableInternals)._animate

/** An actor animatable's step: nothing on the actor's skipped frames (still running: the group keeps it). */
function lodAnimate(this: AnimatableInternals, delay: number): boolean {
  if (this.__sroActor?.lodSkipping) return true
  return baseAnimate.call(this, delay)
}

// ---- actors ------------------------------------------------------------------------------------------------------

interface WornItem {
  code: string
  /** Equip slot; 'fallback' = the family weapon drawn when the worn one cannot be. */
  slot: EquipSlot | 'fallback'
  nodes: Node[]
  meshes: AbstractMesh[]
  /** Item skeletons kept alive (bones linked by name to the wearer's joints). */
  skeletons: Skeleton[]
  /** Socket items: nodes at the sidecar `dummies` (trail points ai_start / ai_end), children of the item root. */
  dummies: Map<string, TransformNode>
}

/** Slots Hide Weapon hides (setWeaponVisible). */
const WEAPON_SLOTS: ReadonlySet<WornItem['slot']> = new Set(['weapon', 'shield', 'fallback'])

/** Sidecar `dummies` (docs/EFFECTS.md §5.2): bone name -> model-space glTF metres; malformed entries are skipped. */
export function dummiesFromSidecar(sidecar: Record<string, unknown> | null | undefined): Map<string, [number, number, number]> {
  const out = new Map<string, [number, number, number]>()
  const d = sidecar?.dummies
  if (!d || typeof d !== 'object' || Array.isArray(d)) return out
  for (const [name, v] of Object.entries(d as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n))) out.set(name, [v[0], v[1], v[2]])
  }
  return out
}

/** G1 rescue: an item glb's empty `__root__` mesh draws nothing; hidden, it is not activated every frame. */
function hideEmpty(n: Node): void {
  const m = n as unknown as { getTotalVertices?: () => number; isVisible?: boolean }
  if (typeof m.getTotalVertices === 'function' && m.getTotalVertices() === 0) m.isVisible = false
}

/** Equipment sidecars sit next to their glb (the equipment manifest's `model.sidecar`). */
function sidecarOf(glb: string): string {
  return glb.replace(/\.glb$/i, '.json')
}

interface DressPlan {
  comp: Composition | null
  items: { item: BoundItem; container: AssetContainer; sidecar?: Record<string, unknown> | null }[]
  fallback: { container: AssetContainer; attachBone: string; sidecar?: Record<string, unknown> | null } | null
  family: StarterWeapon | null
  gender: 'male' | 'female'
  volume: number | undefined
}

/** A bind pose whose lowest point is this far above the feet is authored floating; its clips pull it down (metres). */
export const FLOATING_BIND_M = 0.25
/**
 * Actor culling (W9A perf pass): the sphere an actor is tested with is its bind-pose extent around the root axis ×
 * CULL_SPHERE_SCALE + CULL_MARGIN_M, so a clip that reaches past the bind pose (a swing, a lunge) stays inside it.
 */
export const CULL_SPHERE_SCALE = 1.5
export const CULL_MARGIN_M = 1.5
const cullCenter = new Vector3()

/**
 * An actor's culling sphere in root space from its bind-pose extent: centred on the root axis between the ground (or
 * the lowest point) and the top (at least 2 m), with a radius covering every yaw, × CULL_SPHERE_SCALE + CULL_MARGIN_M.
 */
export function cullSphereOf(min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }): { y: number; r: number } {
  const ok = (v: number) => (Number.isFinite(v) ? v : 0)
  const bottom = Math.min(ok(min.y), 0)
  const top = Math.max(ok(max.y), 2)
  const dx = Math.max(Math.abs(ok(min.x)), Math.abs(ok(max.x)))
  const dz = Math.max(Math.abs(ok(min.z)), Math.abs(ok(max.z)))
  return { y: (top + bottom) / 2, r: CULL_SPHERE_SCALE * Math.hypot(dx, dz, (top - bottom) / 2) + CULL_MARGIN_M }
}
/** G1 rescue (CharacterActor.setMergeParts): the vertex kinds a part merge carries (anything else: no merge). */
const MERGE_KINDS: ReadonlySet<string> = new Set([
  VertexBuffer.PositionKind,
  VertexBuffer.NormalKind,
  VertexBuffer.TangentKind,
  VertexBuffer.UVKind,
  VertexBuffer.UV2Kind,
  VertexBuffer.ColorKind,
  VertexBuffer.MatricesIndicesKind,
  VertexBuffer.MatricesWeightsKind,
  VertexBuffer.MatricesIndicesExtraKind,
  VertexBuffer.MatricesWeightsExtraKind,
])

/** The raw bytes of a vertex buffer's data (a plain number array is float data); null when it keeps none. */
function vertexBytes(vb: VertexBuffer): Uint8Array | null {
  const d = vb.getData()
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
  if (d instanceof ArrayBuffer) return new Uint8Array(d)
  if (Array.isArray(d) && vb.type === VertexBuffer.FLOAT) return new Uint8Array(Float32Array.from(d).buffer)
  return null
}

/**
 * One mesh with the vertices and triangles of `parts` (same material, skeleton, parent, local transform and vertex
 * layout: CharacterActor.buildMerge groups them), drawn as they were. The vertex buffers keep the parts' own formats
 * byte for byte (the slim glbs' quantized normals, UVs and weights), so the merged mesh draws through the very render
 * pipeline the parts used: no pipeline or shader is made for it. It takes the first part's material, skeleton,
 * influences, transform, side orientation and flags. null when the parts' buffers differ or keep no data.
 */
export function mergeSkinnedParts(parts: readonly Mesh[]): Mesh | null {
  const first = parts[0]
  if (!first || parts.length < 2) return null
  const scene = first.getScene()
  const kinds = first.getVerticesDataKinds()
  if (!kinds.length || !kinds.every(k => MERGE_KINDS.has(k))) return null
  const counts = parts.map(p => p.getTotalVertices())
  const total = counts.reduce((a, b) => a + b, 0)
  // Every part's data first (nothing is made for a group that cannot merge).
  const datas: Uint8Array[][] = []
  for (const k of kinds) {
    const vb0 = first.getVertexBuffer(k)
    if (!vb0) return null
    const list: Uint8Array[] = []
    for (const p of parts) {
      const vb = p.getVertexBuffer(k)
      if (!vb || vb.type !== vb0.type || vb.normalized !== vb0.normalized || vb.byteStride !== vb0.byteStride || vb.getSize() !== vb0.getSize() || vb.byteOffset !== 0 || vb.getIsInstanced()) return null
      const src = vertexBytes(vb)
      if (!src) return null
      list.push(src)
    }
    datas.push(list)
  }
  const indices: number[] = []
  let base = 0
  for (let i = 0; i < parts.length; i++) {
    const idx = parts[i]!.getIndices()
    if (!idx) return null
    for (let j = 0; j < idx.length; j++) indices.push(idx[j]! + base)
    base += counts[i]!
  }
  const buffers: VertexBuffer[] = []
  kinds.forEach((k, n) => {
    const vb0 = first.getVertexBuffer(k)!
    const stride = vb0.byteStride
    const bytes = new Uint8Array(total * stride)
    let at = 0
    datas[n]!.forEach((src, i) => {
      bytes.set(src.subarray(0, Math.min(counts[i]! * stride, src.length)), at)
      at += counts[i]! * stride
    })
    buffers.push(new VertexBuffer(scene.getEngine(), bytes, k, { updatable: false, stride, size: vb0.getSize(), type: vb0.type, normalized: vb0.normalized, useBytes: true }))
  })
  const m = new Mesh(`${first.name}:merged`, scene)
  for (const b of buffers) m.setVerticesBuffer(b)
  m.setIndices(total > 65535 ? Uint32Array.from(indices) : Uint16Array.from(indices), total)
  m.parent = first.parent
  m.position.copyFrom(first.position)
  if (first.rotationQuaternion) m.rotationQuaternion = first.rotationQuaternion.clone()
  else m.rotation.copyFrom(first.rotation)
  m.scaling.copyFrom(first.scaling)
  m.material = first.material
  m.skeleton = first.skeleton
  m.numBoneInfluencers = first.numBoneInfluencers
  m.sideOrientation = first.sideOrientation
  m.overrideMaterialSideOrientation = first.overrideMaterialSideOrientation
  m.receiveShadows = first.receiveShadows
  m.layerMask = first.layerMask
  m.renderingGroupId = first.renderingGroupId
  m.hasVertexAlpha = first.hasVertexAlpha
  m.useVertexColors = first.useVertexColors
  m.isPickable = false
  m.metadata = first.metadata
  m.refreshBoundingInfo()
  return m
}

/** Wait after a base clip starts before measuring the posed height (its blend-in, 0.08 per frame, is done even at 10 fps). */
export const POSE_SETTLE_MS = 1500

/**
 * Model height (metres, before root scaling) that labels, damage numbers and pick proxies stand on. Most glbs are
 * bound standing on their feet, so the bind-pose top is the height. A few are bound floating (Storage-keeper
 * Sansan's mesh spans 2.4..4.1 m in bind pose and her STAND1 pulls her down to the ground): their label would float
 * metres above the head. Those use the measured standing pose once it is known, else the bind pose's extent.
 */
export function standingHeight(bind: { min: number; max: number }, posed?: { min: number; max: number } | null): number {
  const sane = (h: number) => (h > 0.3 && h < 12 ? h : 1.8)
  if (!(bind.min > FLOATING_BIND_M)) return sane(bind.max)
  if (posed && Number.isFinite(posed.max) && Number.isFinite(posed.min)) return sane(posed.max)
  return sane(bind.max - bind.min)
}

let actorSerial = 0

/** One character or monster in the scene: `root` carries position, yaw and scale; the glb hangs underneath. */
export class CharacterActor {
  readonly root: TransformNode
  readonly groups: AnimationGroup[]
  readonly skeleton: Skeleton | null
  /** Base meshes of the glb (not the equipment). */
  readonly meshes: AbstractMesh[]
  /** Bind-pose vertical extent in metres (before `root` scaling); see `height`. */
  private readonly bind: { min: number; max: number }
  /** Bind-pose extent in `root` space (before scaling and yaw): what the model covers on the ground, e.g. an NPC's chest. */
  readonly footprint: { minX: number; maxX: number; minZ: number; maxZ: number; maxY: number }
  /** Standing-pose extent, measured once for a floating bind (standingHeight); undefined until then. */
  private posed: { min: number; max: number } | null | undefined
  /** Latest measurement while the pose settles, and when it was taken (performance.now). */
  private early: { min: number; max: number } | null = null
  private measuredAt = -Infinity
  /** When the current base clip started (performance.now), for the pose measurement. */
  private baseSince = 0
  readonly clips: Map<string, ClipInfo>
  readonly packs: PackIndex | null
  family: StarterWeapon | null = null
  private readonly nodes: Node[]
  /** Base glb nodes by name (hiding body parts), captured before any equipment is attached. */
  private readonly baseNodes = new Map<string, Node[]>()
  private readonly joints = new Map<string, TransformNode>()
  private readonly packGroups = new Set<string>()
  private worn: WornItem[] = []
  private hidden: Node[] = []
  private dressToken = 0
  private current: AnimationGroup | null = null
  private currentBase: BaseClip | null = null
  private currentSpeed = 1
  private action: AnimationGroup | null = null
  private actionSerial = 0
  private attackIndex = 0
  private dead = false
  private opacity = 1
  private highlight: Readonly<Color3> | null = null
  private disposed = false
  /** Sound runtime (docs/SOUND.md §5.7): starts of each clip group (a restart is not a loop wrap), and a silent death. */
  private readonly clipRuns = new WeakMap<AnimationGroup, number>()
  private silentDeath = false
  /** The death clip on top while dead (DIE1 / DOWN_DIE, then DIE1_RM); null = none (lies down without a clip). */
  private deathClip: AnimationGroup | null = null
  /** Hide Weapon (setWeaponVisible): kept across re-dressing. */
  private weaponsVisible = true
  /** A clip has posed this actor (the first one snaps instead of blending in from the bind pose: D25). */
  private posedOnce = false
  /** Lab hook (docs/EFFECTS.md §2.5 H2): called with the name of every clip that starts on this actor. */
  onClip?: (name: string) => void
  /** Loads an animation pack by its sidecar path (ModelLibrary.pack; set by ModelLibrary.character) for useClipGroup. */
  loadPack?: (rel: string) => Promise<AssetContainer>
  /** Wave 10: loads a skeleton's movement pack (ModelLibrary.movementPack; set by ModelLibrary.character). */
  loadMovement?: (skeleton: string) => Promise<MovementPack | null>
  /** The skeleton the clips are for (`europeman_skel`): which movement pack (players only; null = none). */
  readonly skeletonName: string | null
  /** Wave 10: the movement clips on this actor, their index and synthetic sound tracks (null until loaded). */
  private movement: { index: MovementIndex; clips: Map<string, AnimationGroup>; tracks: Map<string, ClipTrack[]> } | null = null
  private movementLoad: Promise<boolean> | null = null
  /** The masked weapon-arm layers (per family clip and arms), made once on first use and stopped between jumps. */
  private readonly armLayers = new Map<string, AnimationGroup>()
  /** The arm layer over the playing movement clip (null when none). */
  private armLayer: AnimationGroup | null = null
  /** A base clip resumed at MOVE_BLEND_OUT after a movement clip: its shared speed goes back after `left` frames. */
  private blendRestore: { g: AnimationGroup; left: number } | null = null
  /** The action serial of the playing skill action (playSkill), for `skillActing`. */
  private skillToken = -1
  /** The clip group base clips come from (useClipGroup). */
  private clipGroupName: ClipGroup = 'default'
  /** Pack loads started by useClipGroup, one per group. */
  private readonly groupLoads = new Map<string, Promise<void>>()
  /** The parent `root` had before attachTo(node); undefined while not attached. */
  private home: Node | null | undefined
  /** The culling sphere in root space before scaling (centre height, radius): see CULL_SPHERE_SCALE. */
  private cullSphere: { y: number; r: number }
  /** Outside the main camera's view at the last cull (its meshes are then not forced active). */
  private offscreen = false
  /** Animation LOD (ANIM_LOD): this frame's pose update is skipped (clips and skin hold the last update's pose). */
  private lodSkip = false
  /** When the next pose update is due (the library's clock, ms). */
  private lodNext = 0
  /** The pose updates every frame whatever its size (the player's own character; EntityView sets it). */
  lodFull = false
  /**
   * G1 rescue (world/crowd-budget.ts): the crowd's floor on the time between pose updates (ms; 0 = none) and the off-screen
   * rule: 'slow' updates at ANIM_LOD.offscreenHz whatever the distance (it casts no shadow into view), 'freeze' not at all
   * (nothing of it is seen or heard). Only other characters in a crowd get them.
   */
  private lodCrowdMs = 0
  private lodOffscreen: CrowdOffscreen = 'normal'
  /** An every-frame actor rides on this one this frame (ModelLibrary.lodActors): it updates every frame too. */
  lodCarrier = false
  /** Wave 11 (UNIQUES §2.3 step 3): the actor this one's clip calls are mirrored to (`companion`); null = none. */
  private companionActor: CharacterActor | null = null
  /** The actor whose clip calls drive this one (it is that actor's `companion`); null = none. */
  private driver: CharacterActor | null = null
  /** Wave 11 (UNIQUES D-U22): the actor whose animation-LOD decision and cull this one copies (`lodLeader`). */
  private lodLeaderActor: CharacterActor | null = null
  /** Actors that copy this one's LOD decision (their blend keeps this one updating, so both step together). */
  private readonly lodFollowers: CharacterActor[] = []
  /**
   * Wave 11 (UNIQUES §2.3 step 4): when set, `height` returns this instead of the actor's own standing height (a ridden
   * mob's composite height, world/ride-mob.ts). Metres before `root` scaling, like `height`.
   */
  heightHook: (() => number) | null = null

  constructor(readonly scene: Scene, readonly model: ModelSource, loaded: Loaded) {
    const id = ++actorSerial
    this.root = new TransformNode(`actor${id}:${model.code}`, scene)
    this.root.rotationQuaternion = Quaternion.Identity()
    const inst = loaded.container.instantiateModelsToScene(n => n, false, { doNotInstantiate: true })
    this.nodes = inst.rootNodes
    for (const n of inst.rootNodes) n.parent = this.root
    this.groups = inst.animationGroups
    this.skeleton = inst.skeletons[0] ?? null
    this.meshes = this.root.getChildMeshes(false)
    this.clips = clipInfoFromSidecar(loaded.sidecar)
    this.packs = loaded.packs
    this.skeletonName = this.isPlayer ? skeletonNameOf(loaded.sidecar) : null
    for (const n of this.root.getDescendants(false)) {
      this.baseNodes.set(n.name, [...(this.baseNodes.get(n.name) ?? []), n])
      if (n instanceof TransformNode && !this.joints.has(n.name)) this.joints.set(n.name, n)
    }
    for (const g of this.groups) this.prepareGroup(g)
    for (const m of this.meshes) {
      m.alwaysSelectAsActiveMesh = true
      m.isPickable = false
      // G1 rescue: the glb's empty `__root__` draws nothing; hidden, it is not activated every frame (its world
      // matrix still follows: the parts below it ask for it).
      if (m.getTotalVertices() === 0) m.isVisible = false
    }
    const b = this.root.getHierarchyBoundingVectors(true)
    this.bind = { min: b.min.y, max: b.max.y }
    this.footprint = { minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z, maxY: b.max.y }
    this.cullSphere = cullSphereOf(b.min, b.max)
    this.posed = this.bind.min > FLOATING_BIND_M ? undefined : null
    if (this.skeleton) this.lodSkeleton(this.skeleton)
  }

  /** True on the frames the animation LOD skips (the actor's animatables and skin matrices hold). */
  get lodSkipping(): boolean {
    return this.lodSkip
  }

  /**
   * Wave 11 (UNIQUES §2.3 step 3, U-SEAM-C): a second actor driven by this one (a ridden mob's ride: Tiger Girl drives
   * her Blue Tiger). Every clip entry point is mirrored to it with its own clip of the same name (`play`, `playAction`
   * by clip name, `playSkill`, `hurt`, `die`, `revive`, `cancelAction`, `stopSkill` through the base resume) and so are
   * `setOpacity`, `setHighlight`, `setEnabled` and `dispose`. Not `setYaw` or the root scale: the caller turns and
   * scales the companion's root, which carries this one (world/entities.ts). The companion never resumes its own base
   * while this one plays an action: a one-shot that ends first holds its last frame until this one's resume.
   */
  get companion(): CharacterActor | null {
    return this.companionActor
  }

  set companion(c: CharacterActor | null) {
    if (c === this.companionActor || c === this) return
    if (this.companionActor?.driver === this) this.companionActor.driver = null
    this.companionActor = c
    if (c) c.driver = this
  }

  /**
   * Wave 11 (UNIQUES D-U22): this actor copies `lodLeader`'s animation-LOD decision (`lodSkip`, `lodNext`) and its
   * cull (`offscreen`, with the catch-up) every frame, so a composite's two actors step on the same frames. The leader
   * is the bigger one (the ride); give it a culling sphere that covers both (`setCullSphere`).
   */
  get lodLeader(): CharacterActor | null {
    return this.lodLeaderActor
  }

  set lodLeader(l: CharacterActor | null) {
    if (l === this.lodLeaderActor || l === this) return
    const prev = this.lodLeaderActor
    if (prev) {
      const i = prev.lodFollowers.indexOf(this)
      if (i >= 0) prev.lodFollowers.splice(i, 1)
    }
    this.lodLeaderActor = l
    if (l) l.lodFollowers.push(this)
  }

  /** Wave 11: the culling sphere in root space before scaling (a composite's, world/ride-mob.ts); see CULL_SPHERE_SCALE. */
  setCullSphere(sphere: { y: number; r: number }): void {
    if (Number.isFinite(sphere.y) && Number.isFinite(sphere.r) && sphere.r > 0) this.cullSphere = { y: sphere.y, r: sphere.r }
  }

  /** The culling sphere in root space before scaling (tests; world/ride-mob.ts). */
  get cullSphereLocal(): { readonly y: number; readonly r: number } {
    return this.cullSphere
  }

  /** The actor driving this one (its `companion` is this one) plays an action now: this one holds instead of resuming. */
  private get heldByDriver(): boolean {
    const d = this.driver
    return !!d && !d.disposed && !d.dead && d.action !== null
  }

  /** Mirror of a base clip (play): a forced (re)start ends the companion's own action first (the base resumes together). */
  private mirrorPlay(base: BaseClip, force: boolean, speed: number, fromFrame?: number): void {
    if (this.disposed) return
    if (force && this.action && !this.dead) {
      this.actionSerial++
      this.stopArmLayer()
      this.action.stop()
      this.action = null
    }
    this.play(base, force, speed, fromFrame)
  }

  /** The companion's clip for a mirrored one: the same name; STUN* → STAND1 (UNIQUES F20: the tiger's STUN is a retail typo). */
  private mirrorClip(name: string): AnimationGroup | undefined {
    if (/^STUN/.test(name)) return this.clipFor('STAND1')
    return this.group(name)
  }

  /**
   * Animation LOD, before the frame's animations (ModelLibrary.lodActors): skip this frame's pose update unless one is
   * due for the actor's size on screen (ANIM_LOD). `eye` null (LOD off) updates every frame.
   */
  lodTick(now: number, eye: Vector3 | null): void {
    if (this.blendRestore && --this.blendRestore.left <= 0) this.restoreBaseBlend()
    const leader = this.lodLeaderActor
    if (leader && !leader.disposed && !this.disposed) {
      // Wave 11 (D-U22): the leader ticked first this frame (ModelLibrary.lodActors); its decision is this one's.
      this.lodSkip = leader.lodSkip
      this.lodNext = leader.lodNext
      return
    }
    if (!eye || this.lodFull || this.lodCarrier || this.disposed) {
      this.lodSkip = false
      return
    }
    // W9F CPU-2: Babylon advances a clip-change blend per evaluation (blendingSpeed), not per second, so an actor on a
    // held rate would blend 3-6x longer and off the every-frame pose: it updates every frame until the blend is done.
    if (this.blending()) {
      this.lodSkip = false
      this.lodNext = 0
      return
    }
    if (now < this.lodNext) {
      this.lodSkip = true
      return
    }
    this.lodSkip = false
    const interval = this.lodInterval(eye)
    this.lodNext = interval > 0 ? now + interval - ANIM_LOD.slackMs : 0
  }

  /** A playing clip is still blending in (its runtime animations step their blend factor once per evaluation). */
  private blending(): boolean {
    // Wave 11: a follower's blend keeps its leader (and so itself) updating every frame, as its own would.
    for (const f of this.lodFollowers) if (!f.disposed && f.blendingOwn()) return true
    return this.blendingOwn()
  }

  private blendingOwn(): boolean {
    for (const g of this.groups) {
      if (!g.isStarted) continue
      // The group's animatables start together and step in lockstep: the first one tells (a clip started unblended
      // has blending off on its runtime animations).
      const first = g.animatables[0]?.getAnimations()[0] as unknown as { _enableBlending?: boolean; _blendingFactor?: number } | undefined
      if (first?._enableBlending && (first._blendingFactor ?? 2) <= 1) return true
    }
    return false
  }

  /**
   * ms between this actor's pose updates as seen from `eye` (0 = every frame): the size rule (ANIM_LOD), never faster
   * than the crowd's floor (G1 rescue), and Infinity while frozen off screen (the cull steps it back: lodCatchUp).
   */
  lodInterval(eye: Vector3): number {
    const p = this.root.getAbsolutePosition()
    const d = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z)
    const s = this.root.absoluteScaling
    const k = Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)) || 1
    const size = d > 1e-3 ? ((this.bind.max - Math.min(0, this.bind.min)) * k) / d : Infinity
    if (this.offscreen && this.lodOffscreen === 'freeze') return Infinity
    let own = animIntervalMs(size, d, this.offscreen)
    if (this.offscreen && this.lodOffscreen === 'slow') own = Math.max(own, 1000 / ANIM_LOD.offscreenHz)
    return this.lodCrowdMs > own ? this.lodCrowdMs : own
  }

  /**
   * G1 rescue (world/crowd-budget.ts): the crowd's pose-rate floor (ms between updates; 0 = none) and the off-screen rule
   * (see `lodOffscreen`). A change takes effect at once: the next frame updates and the new interval starts from there.
   */
  setCrowdLod(minMs: number, offscreen: CrowdOffscreen = 'normal'): void {
    const ms = Number.isFinite(minMs) && minMs > 0 ? minMs : 0
    if (ms === this.lodCrowdMs && offscreen === this.lodOffscreen) return
    this.lodCrowdMs = ms
    this.lodOffscreen = offscreen
    this.lodNext = 0
  }

  /** The crowd's floor and off-screen rule now (tests, the LAB). */
  get crowdLod(): { readonly minMs: number; readonly offscreen: CrowdOffscreen } {
    return { minMs: this.lodCrowdMs, offscreen: this.lodOffscreen }
  }

  /**
   * The pose this frame now, for an actor the LOD skipped this frame that has just come into view (the cull runs after
   * the animations): every playing clip steps to the frame's animation time, so it never shows an old pose.
   */
  private lodCatchUp(): void {
    this.lodSkip = false
    this.lodNext = 0
    const time = (this.scene as unknown as { _animationTime: number })._animationTime
    for (const g of this.groups) {
      if (!g.isStarted) continue
      for (const a of [...g.animatables]) baseAnimate.call(a as unknown as AnimatableInternals, time)
    }
  }

  /** The skin matrices of a skeleton are not recomputed on skipped frames (the bones did not move). */
  private lodSkeleton(skeleton: Skeleton): void {
    const prepare = skeleton.prepare
    let prepared = false
    skeleton.prepare = (dontCheckFrameId?: boolean) => {
      if (this.lodSkip && prepared && !dontCheckFrameId) return
      prepare.call(skeleton, dontCheckFrameId)
      prepared = true
    }
  }

  /** Height in metres (before `root` scaling) where labels sit: standingHeight of the bind pose or the measured pose. */
  get height(): number {
    if (this.heightHook) {
      // Wave 11 (UNIQUES §2.3 step 4): a composite's height (the rider on her ride), when it gives a sane one.
      const h = this.heightHook()
      if (Number.isFinite(h) && h > 0) return h
    }
    if (this.posed === undefined) {
      // Floating bind: follow the pose every 200 ms until a base clip has settled, then keep that measurement.
      const t = performance.now()
      const settled = this.current !== null && !this.action && !this.dead && t - this.baseSince > POSE_SETTLE_MS
      if (settled || t - this.measuredAt > 200) {
        this.measuredAt = t
        const m = this.measurePose()
        if (settled) this.posed = m
        else this.early = m
      }
    }
    return standingHeight(this.bind, this.posed === undefined ? this.early : this.posed)
  }

  /** Vertical extent of the skinned body in its current pose, in root-local metres (null when it cannot be read). */
  private measurePose(): { min: number; max: number } | null {
    try {
      this.skeleton?.prepare(true)
      for (const m of this.meshes) if (m.skeleton) m.refreshBoundingInfo({ applySkeleton: true })
      const b = this.root.getHierarchyBoundingVectors(true, n => this.meshes.includes(n as AbstractMesh))
      const y0 = this.root.absolutePosition.y
      const s = this.root.absoluteScaling.y || 1
      const posed = { min: (b.min.y - y0) / s, max: (b.max.y - y0) / s }
      return Number.isFinite(posed.min) && Number.isFinite(posed.max) && posed.max > posed.min ? posed : null
    } catch (err) {
      console.warn('[models] pose measurement failed', this.model.code, err)
      return null
    }
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get isDead(): boolean {
    return this.dead
  }

  /** Player models (CHAR_*) get weapon-family packs; mobs and NPCs every pack with clips they use. */
  get isPlayer(): boolean {
    return this.model.code.startsWith('CHAR_')
  }

  /** Every mesh drawn for this actor: the body (and its merged parts, G1 rescue) and what it wears. */
  allMeshes(): AbstractMesh[] {
    return [...this.meshes, ...(this.merge?.meshes ?? []), ...this.worn.flatMap(w => w.meshes)]
  }

  // ---- G1 rescue: the part merge (world/crowd-budget.ts) ----------------------------------------------------------

  /**
   * Merges the shown body parts that draw alike into one mesh per group (on) or brings the parts back (off). A group is
   * the glb's own skinned parts (not what is worn) with the same material, skeleton, parent, local transform, vertex
   * layout and bone influences: the same shader on the same skin, so the merged mesh draws the same pixels in one draw
   * where the parts took one each (a Chinese man's face and two arm parts: 3 → 1; most monsters and NPCs: 2–6 → 1–2).
   * Blended materials and hair (Berserk hides it by name) stay apart. A re-dress drops the merge and makes it again; the
   * parts keep every per-mesh setting through `allMeshes` (opacity, the hover tint, the cull). True when it built a merge
   * now (the budget counts those against its per-frame allowance).
   */
  setMergeParts(on: boolean): boolean {
    if (this.disposed) return false
    this.mergeOn = on
    if (!on) {
      this.dropMerge()
      return false
    }
    if (this.merge) return false
    this.merge = this.buildMerge()
    this.mergeVersion++
    return true
  }

  /** The part merge is on (setMergeParts). */
  get mergedParts(): boolean {
    return this.mergeOn
  }

  /** The merged meshes and the parts they stand for (tests, the LAB). */
  get mergeInfo(): { readonly meshes: readonly AbstractMesh[]; readonly parts: readonly AbstractMesh[] } | null {
    return this.merge
  }

  /** Bumped whenever the merge makes or drops meshes (the renderer's character roots change with it). */
  mergeVersion = 0

  private merge: { meshes: Mesh[]; parts: AbstractMesh[] } | null = null
  private mergeOn = false

  private dropMerge(): void {
    const m = this.merge
    if (!m) return
    this.merge = null
    for (const p of m.parts) if (!p.isDisposed()) p.setEnabled(true)
    for (const x of m.meshes) if (!x.isDisposed()) x.dispose(false, false)
    this.mergeVersion++
  }

  private buildMerge(): { meshes: Mesh[]; parts: AbstractMesh[] } {
    const groups = new Map<string, Mesh[]>()
    for (const m of this.meshes) {
      if (!(m instanceof Mesh) || m.isDisposed() || !m.isEnabled() || !m.isVisible || !m.skeleton || !m.material || !m.geometry) continue
      if (m.getTotalVertices() <= 0 || m.subMeshes?.length !== 1 || m.morphTargetManager || m.hasThinInstances || m.instances.length) continue
      if (/hair/i.test(m.name) || m.material.needAlphaBlending()) continue
      const kinds = m.getVerticesDataKinds().slice().sort()
      if (!kinds.every(k => MERGE_KINDS.has(k))) continue
      const q = m.rotationQuaternion
      const key = [
        m.material.uniqueId,
        m.skeleton.uniqueId,
        m.parent?.uniqueId ?? -1,
        m.numBoneInfluencers,
        kinds.join('+'),
        m.position.asArray().join(','),
        q ? q.asArray().join(',') : m.rotation.asArray().join(','),
        m.scaling.asArray().join(','),
        m.sideOrientation ?? '',
        m.overrideMaterialSideOrientation ?? '',
        m.layerMask,
        m.renderingGroupId,
      ].join('|')
      const g = groups.get(key)
      if (g) g.push(m)
      else groups.set(key, [m])
    }
    const out = { meshes: [] as Mesh[], parts: [] as AbstractMesh[] }
    for (const parts of groups.values()) {
      if (parts.length < 2) continue
      const merged = mergeSkinnedParts(parts)
      if (!merged) continue
      // Every per-mesh state the actor keeps on its parts (allMeshes: opacity, the hover tint, the cull).
      merged.visibility = this.opacity
      merged.alwaysSelectAsActiveMesh = parts[0]!.alwaysSelectAsActiveMesh
      if (this.highlight) setHighlightOverlay(merged, this.highlight)
      for (const p of parts) p.setEnabled(false)
      out.meshes.push(merged)
      out.parts.push(...parts)
    }
    return out
  }

  /**
   * Main-camera culling (W9A perf pass; ModelLibrary runs it before each frame's active-mesh evaluation). The meshes
   * of an actor are always selected (`alwaysSelectAsActiveMesh`: skinned bounds do not follow the clips), so every
   * actor was drawn even behind the camera. An actor whose culling sphere lies wholly outside a frustum plane is left
   * to Babylon's own test instead, which may still draw it; one inside is always drawn, as before. Shadows are not
   * affected: the shadow map draws its casters whether they are active or not.
   */
  cull(planes: readonly Plane[]): boolean {
    if (this.disposed) return false
    const leader = this.lodLeaderActor
    let off = false
    if (leader && !leader.disposed) {
      // Wave 11 (D-U22): a follower is where its leader is (a rider on its ride): the leader's sphere covers both.
      off = leader.offscreen
    } else {
      const s = this.root.scaling
      const k = Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z))
      const p = this.root.getAbsolutePosition()
      cullCenter.set(p.x, p.y + this.cullSphere.y * k, p.z)
      const r = this.cullSphere.r * k
      for (const plane of planes) {
        if (plane.dotCoordinate(cullCenter) <= -r) {
          off = true
          break
        }
      }
    }
    const was = this.offscreen
    this.setOffscreen(off)
    // Back in view on a frame the LOD skipped: its pose steps to this frame before anything draws it.
    if (was && !off && this.lodSkip) this.lodCatchUp()
    return off
  }

  /** Off screen: the meshes are no longer forced active (Babylon's frustum test decides); on screen: always drawn. */
  setOffscreen(off: boolean): void {
    if (off === this.offscreen || this.disposed) return
    this.offscreen = off
    for (const m of this.allMeshes()) m.alwaysSelectAsActiveMesh = !off
  }

  get isOffscreen(): boolean {
    return this.offscreen
  }

  /** Codes of the items currently drawn. */
  get wornCodes(): string[] {
    return this.worn.map(w => w.code)
  }

  private prepareGroup(g: AnimationGroup): void {
    g.stop()
    g.enableBlending = true
    g.blendingSpeed = 0.08
    g.onAnimationGroupPlayObservable.add(() => {
      // Animation LOD: the group's animatables (new on every start) follow this actor's skipped frames, and a clip
      // that starts is evaluated on the next frame whatever the rate (it starts on time).
      for (const a of g.animatables) {
        const x = a as unknown as AnimatableInternals
        x.__sroActor = this
        x._animate = lodAnimate
      }
      this.lodNext = 0
      // Wave 11: a follower's new clip is due on the next frame too, so its leader (whose decision it copies) is.
      if (this.lodLeaderActor) this.lodLeaderActor.lodNext = 0
      this.clipRuns.set(g, (this.clipRuns.get(g) ?? 0) + 1)
      if (this.onClip) {
        try {
          this.onClip(g.name)
        } catch (err) {
          console.warn('[models] onClip failed', err)
        }
      }
    })
  }

  hasPack(group: string): boolean {
    return this.packGroups.has(group)
  }

  /** Retargets the clips of one animation pack onto this actor's joints (by name). */
  addPackClips(group: string, pack: AssetContainer): void {
    if (this.disposed || this.packGroups.has(group) || !this.packs) return
    this.packGroups.add(group)
    const byAnim = new Map(pack.animationGroups.map(g => [g.name, g]))
    for (const [clip, [g, anim]] of Object.entries(this.packs.clips)) {
      if (g !== group || !KEEP_CLIPS.test(clip) || this.groups.some(x => x.name === clip)) continue
      const src = byAnim.get(anim)
      if (!src) continue
      const copy = src.clone(clip, t => (t && typeof t.name === 'string' ? this.joints.get(t.name) ?? t : t))
      this.prepareGroup(copy)
      this.groups.push(copy)
    }
    // New variants (a weapon's stance) take over the base clip at once.
    if (this.currentBase && !this.action && !this.dead) this.play(this.currentBase, true, this.currentSpeed)
  }

  beginDress(): number {
    return ++this.dressToken
  }

  isDressToken(token: number): boolean {
    return token === this.dressToken
  }

  private boneByName(name: string): Bone | undefined {
    return this.skeleton?.bones.find(b => b.name === name || nodeName(b) === name)
  }

  /** Replaces everything worn: hides the replaced body parts, binds armour, hangs weapons; sets family and volume. */
  applyDress(plan: DressPlan): void {
    // G1 rescue: the merged parts go first (a hidden part must not stay drawn in a merge); made again at the end.
    this.dropMerge()
    this.removeWorn()
    const drawn = new Set(plan.items.map(i => i.item.code))
    const glbRoot = this.nodes[0] ?? this.root
    if (plan.comp) {
      for (const mesh of plan.comp.hide) {
        // Only when an item that replaces it is actually drawn (a failed load must not open a hole).
        if (!(plan.comp.hiddenBy[mesh] ?? []).some(c => drawn.has(c))) continue
        for (const n of this.baseNodes.get(mesh) ?? []) {
          n.setEnabled(false)
          this.hidden.push(n)
        }
      }
    }
    for (const { item, container, sidecar } of plan.items) {
      if (item.kind === 'skinned') this.bindSkinned(item.code, item.slot, container, glbRoot)
      else this.hangOnSocket(item.code, item.slot, container, item.attachBone ?? DEFAULT_ATTACH_BONE, sidecar)
    }
    if (plan.fallback) this.hangOnSocket('weapon', 'fallback', plan.fallback.container, plan.fallback.attachBone, plan.fallback.sidecar)
    this.family = plan.family
    this.setVolume(plan.gender, plan.volume)
    if (!this.weaponsVisible) this.setWeaponVisible(false)
    if (this.opacity !== 1) this.setOpacity(this.opacity)
    if (this.highlight) this.setHighlight(true, this.highlight)
    if (this.currentBase && !this.action && !this.dead) this.play(this.currentBase, true, this.currentSpeed)
    if (this.mergeOn) {
      this.merge = this.buildMerge()
      this.mergeVersion++
    }
  }

  /** Skinned item: its meshes follow this actor's skeleton (shared when the joints match, else linked by name). */
  private bindSkinned(code: string, slot: WornItem['slot'], container: AssetContainer, parent: Node): void {
    const inst = container.instantiateModelsToScene(n => n, false, { doNotInstantiate: true })
    for (const g of inst.animationGroups) g.dispose()
    const own = inst.skeletons[0]
    const worn: WornItem = { code, slot, nodes: inst.rootNodes, meshes: [], skeletons: [], dummies: new Map() }
    for (const r of inst.rootNodes) {
      r.parent = parent
      hideEmpty(r)
      worn.meshes.push(...r.getChildMeshes(false))
    }
    const skel = this.skeleton
    if (own && skel) {
      const same = own.bones.length === skel.bones.length && own.bones.every((b, i) => nodeName(b) === nodeName(skel.bones[i]!))
      if (same) {
        for (const m of worn.meshes) if (m.skeleton === own) m.skeleton = skel
        own.dispose()
      } else {
        for (const b of own.bones) {
          const target = this.joints.get(nodeName(b))
          if (target) b.linkTransformNode(target)
        }
        worn.skeletons.push(own)
        this.lodSkeleton(own)
      }
    }
    for (const m of worn.meshes) {
      m.alwaysSelectAsActiveMesh = true
      m.isPickable = false
    }
    this.worn.push(worn)
  }

  /**
   * SRO socket attach rule (docs/CONVENTIONS.md "Attach rule"): the item root hangs under its attach bone
   * with only the bone's bind-pose world rotation cancelled; the translation stays at the bone.
   */
  private hangOnSocket(code: string, slot: WornItem['slot'], container: AssetContainer, boneName: string, sidecar?: Record<string, unknown> | null): void {
    const bone = this.boneByName(boneName) ?? this.boneByName(DEFAULT_ATTACH_BONE)
    const target = bone?.getTransformNode()
    if (!bone || !target) {
      console.warn(`[models] ${this.model.code}: no bone ${boneName} for ${code}`)
      return
    }
    const inst = container.instantiateModelsToScene(n => n, false, { doNotInstantiate: true })
    for (const g of inst.animationGroups) g.dispose()
    const worn: WornItem = { code, slot, nodes: inst.rootNodes, meshes: [], skeletons: [...inst.skeletons], dummies: new Map() }
    for (const s of worn.skeletons) this.lodSkeleton(s)
    for (const root of inst.rootNodes) {
      const t = root as TransformNode
      hideEmpty(t)
      t.parent = target
      t.position?.setAll(0)
      t.scaling?.setAll(1)
      t.rotationQuaternion = Quaternion.Identity()
      bone.getAbsoluteInverseBindMatrix().decompose(undefined, t.rotationQuaternion, undefined)
      worn.meshes.push(...t.getChildMeshes(false))
    }
    // Trail points: in the item's model space (glTF metres), like its meshes under the item root.
    const itemRoot = inst.rootNodes[0] as TransformNode | undefined
    if (itemRoot) {
      for (const [name, [x, y, z]] of dummiesFromSidecar(sidecar)) {
        const d = new TransformNode(`${code}:${name}`, this.scene)
        d.parent = itemRoot
        d.position.set(x, y, z)
        worn.dummies.set(name, d)
      }
    }
    for (const m of worn.meshes) {
      m.alwaysSelectAsActiveMesh = true
      m.isPickable = false
    }
    this.worn.push(worn)
  }

  private removeWorn(): void {
    for (const w of this.worn) {
      for (const n of w.nodes) n.dispose(false, false)
      for (const s of w.skeletons) s.dispose()
    }
    this.worn = []
    for (const n of this.hidden) if (!n.isDisposed()) n.setEnabled(true)
    this.hidden = []
  }

  /** Volume (build) 0..4: radial skin factors on the table bones of the gender; 2 = none. */
  setVolume(gender: 'male' | 'female', volume: number | undefined): void {
    const scales = volumeBoneScales(gender, volume)
    const skeletons = new Set<Skeleton>()
    if (this.skeleton) skeletons.add(this.skeleton)
    for (const w of this.worn) for (const s of w.skeletons) skeletons.add(s)
    for (const s of skeletons) setSkeletonVolume(s, scales)
  }

  /** Clip for a base action, preferring the weapon family's variant (e.g. RUN_bow_run_fighter). */
  clipFor(base: BaseClip): AnimationGroup | undefined {
    if (this.clipGroupName !== 'default') {
      const mounted = this.groupClip(base)
      if (mounted) return mounted
    }
    const key = this.family ? FAMILY_CLIP[this.family] : null
    if (key) {
      const variant = this.groups.find(g => g.name.startsWith(`${base}_`) && key.test(g.name) && !MOUNT_CLIP.test(g.name))
      if (variant) return variant
    }
    const own = this.groups.find(g => g.name === base)
    if (own) return own
    // The idle kinds fall back to what the idle would show without them (the family's stand).
    if (base === 'VENDOR01') return this.clipFor('SIT')
    if (base === 'SIT' || base === 'ATTREADY') return this.clipFor('STAND1')
    return (base === 'WALK' ? this.groups.find(g => g.name === 'RUN') : undefined) ?? this.groups.find(g => g.name === 'STAND1')
  }

  /** The actor's clip of TYPE `type` for its weapon family (`STAND3_spear_stand_city02` for a spear), else the plain one. */
  private typedClip(type: string): AnimationGroup | undefined {
    const key = this.family ? FAMILY_CLIP[this.family] : null
    if (key) {
      const variant = this.groups.find(g => g.name.startsWith(`${type}_`) && key.test(g.name) && !MOUNT_CLIP.test(g.name))
      if (variant) return variant
    }
    return this.group(type)
  }

  group(name: string): AnimationGroup | undefined {
    return this.groups.find(g => g.name === name)
  }

  /**
   * `fromFrame` (wave 10, MOVEMENT §3.3): on a (re)start, the frame the base loop starts at instead of its first (a
   * JUMP_RUN hands the RUN back at its `exitPhaseS`); it loops over the whole clip from there.
   */
  play(base: BaseClip, force = false, speed = 1, fromFrame?: number): void {
    this.currentBase = base
    this.currentSpeed = speed
    if (this.dead || this.action) return
    // Wave 11: the companion plays the same base (its own clip); a forced start (this one's resume) ends its action.
    this.companionActor?.mirrorPlay(base, force, speed, fromFrame)
    if (!force && this.current?.isPlaying && this.current === this.clipFor(base)) {
      this.current.speedRatio = speed
      return
    }
    const next = this.clipFor(base)
    if (!next) return
    if (this.current && this.current !== next) this.current.stop()
    this.current = next
    this.baseSince = performance.now()
    // The T-pose (docs/WAVE_PLAN2.md D25): the first clip of a fresh actor must not blend in from the bind pose (arms
    // out), or every model that appears spends its first ~12 frames (half a second on a slow machine, for ever
    // while the page does not render) as a T. The first pose snaps; later changes blend as before.
    this.startUnblended(next, !this.posedOnce, true, speed, fromFrame)
    this.posedOnce = true
  }

  /**
   * Starts `g`; `snap` = without blending from the current pose (the group's animations are shared, so restored at once).
   * `fromFrame`: jump there once started (the loop still covers the whole clip).
   */
  private startUnblended(g: AnimationGroup, snap: boolean, loop: boolean, speed: number, fromFrame?: number): void {
    const seek = fromFrame !== undefined && Number.isFinite(fromFrame) && fromFrame > g.from && fromFrame < g.to
    if (!snap) {
      g.start(loop, speed, g.from, g.to)
      if (seek) g.goToFrame(fromFrame)
      return
    }
    const blend = g.enableBlending
    g.enableBlending = false
    try {
      g.start(loop, speed, g.from, g.to)
      if (seek) g.goToFrame(fromFrame)
    } finally {
      g.enableBlending = blend
    }
  }

  /** The next basic-attack clip for this actor (cycles ATTACK1..n of its weapon family). */
  nextAttackClip(): AnimationGroup | undefined {
    const re = this.family ? FAMILY_ATTACK[this.family] : /^ATTACK\d$/
    let list = this.groups.filter(g => re.test(g.name) && !this.clips.get(g.name)?.partial)
    if (!list.length) list = this.groups.filter(g => /^ATTACK\d/.test(g.name))
    if (!list.length) return undefined
    list.sort((a, b) => a.name.localeCompare(b.name))
    return list[this.attackIndex++ % list.length]
  }

  /**
   * Plays a full one-shot clip over the base; the base resumes when it ends (wave 10: at `resumeBaseFrame` when given,
   * MOVEMENT §3.3's base resume at JUMP_RUN's `exitPhaseS`; with `resumeFor`, only when that clip is the base that
   * resumes: a JUMP_RUN whose runner stopped hands back STAND1 from its start). A movement clip hands the base back at
   * MOVE_BLEND_OUT.
   */
  playAction(group: AnimationGroup, speed = 1, resumeBaseFrame?: number, resumeFor?: AnimationGroup): void {
    if (this.dead) return
    const token = ++this.actionSerial
    const prev = this.action
    this.action = group
    this.stopArmLayer()
    // Stop first: stopping fires end observers, which must only see stale tokens.
    if (prev) prev.stop()
    if (this.current && this.current !== group) this.current.stop()
    this.current = null
    group.stop()
    group.onAnimationGroupEndObservable.addOnce(() => {
      if (token !== this.actionSerial) return
      this.action = null
      this.stopArmLayer()
      // Wave 11: a companion whose driver still acts holds this last frame; the driver's resume restarts its base.
      if (this.heldByDriver) return
      if (!this.dead && this.currentBase) {
        const from = resumeFor && this.clipFor(this.currentBase) !== resumeFor ? undefined : resumeBaseFrame
        this.play(this.currentBase, true, this.currentSpeed, from)
        if (this.isMovementClip(group)) this.blendBaseOut()
      }
    })
    this.startUnblended(group, !this.posedOnce, false, speed)
    this.posedOnce = true
    // Wave 11: the companion plays its clip of the same name (none: it keeps its base clip).
    const c = this.companionActor
    if (c && !c.disposed) {
      const cg = c.mirrorClip(group.name)
      if (cg) c.playAction(cg, speed)
    }
  }

  /**
   * Plays the full one-shot clip `name` (exact group name, e.g. 'SIT_DOWN', 'EMOTION01', 'ATTACK2') over the base, which
   * resumes when it ends. False when the actor has no such clip (or is dead).
   */
  playClip(name: string, speed = 1): boolean {
    const g = this.group(name)
    if (!g || this.dead) return false
    this.playAction(g, speed)
    return true
  }

  // ---- wave 10: movement (docs/MOVEMENT.md §6, jump only; lane MV-C) --------------------------------------------------

  /** The actor has its movement clips (the per-skeleton movement pack, loaded by ensureMovementClips after worldEnter). */
  get hasMovementClips(): boolean {
    return !!this.movement && this.movement.clips.size > 0
  }

  /**
   * Loads and retargets this actor's movement clips, once (players with a known skeleton). The world screen's movement
   * feature calls it after worldEnter and never awaits it in the actor build path (MOVEMENT §6.1); a jump that arrives
   * earlier plays nothing. False when there are none (an old tree without the pack, a mob).
   */
  ensureMovementClips(): Promise<boolean> {
    if (this.movement) return Promise.resolve(this.hasMovementClips)
    if (this.disposed || !this.skeletonName || !this.loadMovement) return Promise.resolve(false)
    this.movementLoad ??= this.loadMovement(this.skeletonName).then(
      pack => {
        if (pack && !this.disposed) this.addMovementClips(pack)
        return this.hasMovementClips
      },
      (err: unknown) => {
        console.warn('[models] movement clips failed', this.model.code, err)
        return false
      },
    )
    return this.movementLoad
  }

  /**
   * Retargets a movement pack's clips onto this actor's joints by name (as addPackClips; the clones share the pack's
   * keys), once. They blend in at MOVE_BLEND_IN; their take-off and landing become synthetic sound tracks.
   */
  addMovementClips(pack: MovementPack): void {
    if (this.disposed || this.movement) return
    const byAnim = new Map(pack.container.animationGroups.map(g => [g.name, g]))
    const clips = new Map<string, AnimationGroup>()
    const tracks = new Map<string, ClipTrack[]>()
    for (const [name, info] of Object.entries(pack.index.clips)) {
      const src = byAnim.get(info.anim)
      if (!src || this.groups.some(g => g.name === name)) continue
      const copy = src.clone(name, t => (t && typeof t.name === 'string' ? this.joints.get(t.name) ?? t : t))
      this.prepareGroup(copy)
      copy.blendingSpeed = MOVE_BLEND_IN
      this.groups.push(copy)
      clips.set(name, copy)
      this.clips.set(name, { durationMs: info.durationMs, partial: false, hits: [] })
      tracks.set(name, movementTracksOf(info))
    }
    this.movement = { index: pack.index, clips, tracks }
  }

  /** The synthetic sound tracks of movement clip `clip` (take-off and landing steps; audio/entity.ts). */
  movementTracks(clip: string): readonly ClipTrack[] | undefined {
    return this.movement?.tracks.get(clip)
  }

  private isMovementClip(g: AnimationGroup | null): boolean {
    return !!g && this.movement?.clips.get(g.name) === g
  }

  /**
   * The movement clip this actor plays for `kind` now (MOVEMENT §6.2): on a RUN base the JUMP_RUN made for the RUN it
   * plays (the index's `runJumps`, so a sword man gets the weapon-cycle clip and an unarmed man the fist one; else the
   * generic JUMP_RUN), otherwise JUMP (standing, walking, the combat stance). None while mounted, or running without a
   * JUMP_RUN (the standing clip over a run slide looks broken, MOVEMENT §10 cut 6).
   */
  movementClip(kind: MoveKind): AnimationGroup | undefined {
    const m = this.movement
    if (!m || kind !== 'jump' || this.clipGroupName !== 'default') return undefined
    if (this.currentBase === 'RUN') {
      const run = this.clipFor('RUN')
      const name = (run ? m.index.runJumps[run.name] : undefined) ?? 'JUMP_RUN'
      return m.clips.get(name)
    }
    return m.clips.get('JUMP')
  }

  /**
   * Plays the movement `kind` over the base (MOVEMENT §6.2); false when nothing played (no pack yet, dead, mounted).
   * The clip replaces the base as an action (blend in MOVE_BLEND_IN) and seeks by one budget (jumpSeekS): the viewer's
   * latency (`now − at`) plus, for a JUMP_RUN entered within the first 0.15 s of its own RUN's right stance, that
   * offset. The same RUN then resumes at the clip's `exitPhaseS`. The masked weapon-arm layer plays on top.
   */
  playMove(kind: MoveKind, opts: PlayMoveOptions = {}): boolean {
    if (this.dead || !this.hasMovementClips) return false
    const g = this.movementClip(kind)
    const m = this.movement
    if (!g || !m) return false
    const info = m.index.clips[g.name]
    const latencyMs = opts.at !== undefined && opts.now !== undefined ? opts.now - opts.at : 0
    const base = this.current
    let phaseS = 0
    let resumeFrame: number | undefined
    let resumeFor: AnimationGroup | undefined
    // The phase rules hold only for the RUN the clip was made for (spear and bow share the sword cycle's legs).
    if (info?.run !== undefined && base && m.index.runJumps[base.name] === g.name) {
      const fps = frameRate(base)
      const frame = base.isPlaying ? base.animatables[0]?.masterFrame : undefined
      if (frame !== undefined) phaseS = runEntrySeekS((frame - base.from) / fps, info.enterPhaseS ?? 0, (base.to - base.from) / fps)
      if (info.exitPhaseS !== undefined) {
        resumeFrame = base.from + info.exitPhaseS * fps
        resumeFor = base
      }
    }
    if (opts.resumeBaseS !== undefined && base) {
      resumeFrame = base.from + opts.resumeBaseS * frameRate(base)
      resumeFor = base
    }
    const seekS = Math.max(0, opts.seekS ?? jumpSeekS(latencyMs, phaseS))
    this.playAction(g, 1, resumeFrame, resumeFor)
    if (seekS > 0) {
      const f = g.from + seekS * frameRate(g)
      if (f < g.to) g.goToFrame(f)
    }
    this.startArmLayer(info, seekS)
    return true
  }

  /** Where the playing movement clip is: before its take-off, in the air, after its landing; null when none plays. */
  movePhase(): MovePhase | null {
    const g = this.action
    const info = g && this.isMovementClip(g) ? this.movement?.index.clips[g.name] : undefined
    const a = g?.animatables[0]
    if (!g || !info || !a || this.dead) return null
    const ms = ((a.masterFrame - g.from) / frameRate(g)) * 1000
    const { takeoffMs, landMs } = moveEventTimes(info)
    return ms < takeoffMs ? 'before' : ms < landMs ? 'air' : 'after'
  }

  /** The name of the movement clip playing now (JUMP, JUMP_RUN, JUMP_RUN_FIST), else null. */
  get moveClip(): string | null {
    return !this.dead && this.isMovementClip(this.action) ? this.action!.name : null
  }

  /** A skill action (playSkill) plays: the own client does not predict a jump over it (MOVEMENT §6.3). */
  get skillActing(): boolean {
    return this.skillToken === this.actionSerial && !!this.action && !this.dead
  }

  /**
   * The masked weapon-arm layer (MOVEMENT §6.2): a clone of the weapon family's own base clip restricted to the arm
   * joints (sword/blade the sword arm, plus the left arm with a shield; spear/glaive/bow both), started after the jump
   * so it wins on those joints (the overlay rule). A JUMP_RUN takes the family RUN at the phase its base cycle is at; a
   * standing JUMP the family stand or combat stance. None where that clip is the default STAND1 / ATTREADY / RUN the
   * jump was keyed from (sword and blade standing, bow out of the combat stance, the unarmed): it would only freeze the
   * polished arms. Made once per clip and arms, stopped (never disposed) between jumps.
   */
  private startArmLayer(info: MoveClipInfo | undefined, seekS: number): void {
    const sides = armLayerSides(this.family, this.worn.some(w => w.slot === 'shield'))
    if (!sides.length) return
    const running = info?.run !== undefined
    const src = running ? this.clipFor('RUN') : this.clipFor(this.currentBase === 'ATTREADY' ? 'ATTREADY' : 'STAND1')
    if (!src || src.name === 'STAND1' || src.name === 'ATTREADY' || src.name === 'RUN' || MOUNT_CLIP.test(src.name)) return
    const layer = this.armLayerOf(src, sides)
    if (!layer) return
    this.armLayer = layer
    layer.start(true, 1, src.from, src.to)
    const span = src.to - src.from
    if (running && span > 0) {
      const f = (((((info?.enterPhaseS ?? 0) + seekS) * frameRate(src)) % span) + span) % span
      if (f > 0) layer.goToFrame(src.from + f)
    }
  }

  private armLayerOf(src: AnimationGroup, sides: readonly ('L' | 'R')[]): AnimationGroup | null {
    const key = `ARMS:${src.name}:${sides.join('')}`
    const had = this.armLayers.get(key)
    if (had) return had
    const kept = src.targetedAnimations.filter(ta => isArmJoint((ta.target as { name?: string } | null)?.name, sides))
    if (!kept.length) return null
    const layer = new AnimationGroup(key, this.scene)
    for (const ta of kept) layer.addTargetedAnimation(ta.animation, ta.target)
    this.prepareGroup(layer)
    this.groups.push(layer)
    this.armLayers.set(key, layer)
    return layer
  }

  private stopArmLayer(): void {
    const l = this.armLayer
    this.armLayer = null
    l?.stop()
  }

  /** The arm layer playing now (tests; null when none). */
  get armLayerName(): string | null {
    return this.armLayer?.name ?? null
  }

  /** The base that just resumed after a movement clip blends in at MOVE_BLEND_OUT (its own speed back afterwards). */
  private blendBaseOut(): void {
    const g = this.current
    if (!g) return
    if (this.blendRestore && this.blendRestore.g !== g) this.restoreBaseBlend()
    g.blendingSpeed = MOVE_BLEND_OUT
    this.blendRestore = { g, left: Math.ceil(1 / MOVE_BLEND_OUT) + 1 }
  }

  private restoreBaseBlend(): void {
    const r = this.blendRestore
    this.blendRestore = null
    if (r) r.g.blendingSpeed = BASE_BLEND
  }

  /** True while no action plays and the base is a standing idle (STAND1 or the combat stance). */
  private get idle(): boolean {
    return !this.action && !this.dead && (this.currentBase === 'STAND1' || this.currentBase === 'ATTREADY')
  }

  /**
   * A one-shot of clip type `type` ('DEFENCE', 'STAND3', 'STAND2', 'TURN_L', 'PICK'; the weapon family's variant first):
   * a partial clip plays on top of whatever plays (like DAMAGE1), a full one only while standing idle (as an action).
   * False when nothing played.
   */
  playOverlay(type: string): boolean {
    if (this.dead) return false
    const g = this.typedClip(type)
    if (!g) return false
    if (this.clips.get(g.name)?.partial) {
      g.stop()
      g.start(false, 1, g.from, g.to)
      return true
    }
    if (!this.idle) return false
    this.playAction(g)
    return true
  }

  /** Names of the idle-variant clips this actor has (STAND2-4, TURN_L/R; mount clips excluded), for playOverlay. */
  idleVariants(): string[] {
    const key = this.family ? FAMILY_CLIP[this.family] : null
    // Per type: the weapon family's variant (STAND3_spear_stand_city02) replaces the plain clip; other families' are skipped.
    const byType = new Map<string, string>()
    for (const g of this.groups) {
      const m = IDLE_VARIANT.exec(g.name)
      if (!m || MOUNT_CLIP.test(g.name)) continue
      const type = m[1]!
      if (g.name === type) {
        if (!byType.has(type)) byType.set(type, g.name)
      } else if (key && key.test(g.name)) {
        byType.set(type, g.name)
      }
    }
    return [...byType.values()]
  }

  /** Hide Weapon (docs/EFFECTS.md M7): hides or shows the worn weapon, shield and fallback weapon meshes. */
  setWeaponVisible(on: boolean): void {
    this.weaponsVisible = on
    for (const w of this.worn) if (WEAPON_SLOTS.has(w.slot)) for (const m of w.meshes) m.isVisible = on
  }

  get weaponVisible(): boolean {
    return this.weaponsVisible
  }

  /**
   * A trail point of the worn weapon ('ai_start', 'ai_end', or any sidecar dummy): a node that follows the weapon.
   * The weapon slot first, then the shield, then the fallback weapon; null when none has it.
   */
  weaponDummy(name: 'ai_start' | 'ai_end' | (string & {})): TransformNode | null {
    for (const slot of ['weapon', 'shield', 'fallback'] as const) {
      for (const w of this.worn) {
        if (w.slot !== slot) continue
        const d = w.dummies.get(name)
        if (d && !d.isDisposed()) return d
      }
    }
    return null
  }

  /** The clip of TYPE_NAME `type` in the skill's aniGroup ('SWORD'), else in 'default' (docs/SKILLS.md §6). */
  skillClip(aniGroup: string | undefined, type: string): AnimationGroup | undefined {
    const find = (g: string): AnimationGroup | undefined => {
      for (const [name, info] of this.clips) {
        if (info.group !== g || info.type !== type) continue
        const clip = this.group(name)
        if (clip) return clip
      }
      return undefined
    }
    const want = (aniGroup ?? 'default').toLowerCase()
    return (want !== 'default' ? find(want) : undefined) ?? find('default') ?? this.group(type)
  }

  /** The clip group base clips come from (useClipGroup). */
  get clipGroup(): ClipGroup {
    return this.clipGroupName
  }

  /**
   * Switches the base clips to clip group `group` (docs/WAVE_PLAN2.md D8): 'cart' = the rider pose on a horse, 'default'
   * = back on foot. A pack the startup filter skipped (SKIP_PACKS) is loaded on demand, once per actor; until it is
   * in, or when the actor has no clips of that group, the default clips stay. The current base clip restarts.
   */
  async useClipGroup(group: ClipGroup): Promise<void> {
    this.clipGroupName = group
    if (group !== 'default') await this.loadClipGroup(group)
    if (this.disposed || this.clipGroupName !== group) return
    if (this.currentBase && !this.action && !this.dead) this.play(this.currentBase, true, this.currentSpeed)
  }

  /** Loads and retargets the pack of clip group `group` (slim layout); a no-op when the glb has the clips or no pack. */
  private loadClipGroup(group: string): Promise<void> {
    const rel = this.packs?.packs[group]
    if (!rel || !this.loadPack || this.packGroups.has(group)) return Promise.resolve()
    let p = this.groupLoads.get(group)
    if (!p) {
      p = this.loadPack(rel).then(
        pack => this.addPackClips(group, pack),
        (err: unknown) => {
          this.groupLoads.delete(group)
          console.warn('[models] clip group failed', this.model.code, group, err)
        },
      )
      this.groupLoads.set(group, p)
    }
    return p
  }

  /** Sidecar aniGroup of a clip ('default', 'cart', ...): the pack index for slim actors, else the clip facts. */
  private clipGroupOf(name: string): string | undefined {
    return this.packs?.clips[name]?.[0] ?? this.clips.get(name)?.group
  }

  /** The base clip of the active non-default group (`RUN_cart_walk`); WALK and RUN stand in for each other, else STAND1. */
  private groupClip(base: BaseClip): AnimationGroup | undefined {
    const want = this.clipGroupName
    const find = (type: string) => this.groups.find(g => g.name.startsWith(`${type}_`) && this.clipGroupOf(g.name) === want)
    return find(base) ?? (base === 'WALK' ? find('RUN') : base === 'RUN' ? find('WALK') : find('STAND1'))
  }

  /**
   * Parents `root` to `node` (a bone node such as the horse's `saddle` joint, docs/WAVE_PLAN2.md D8); position, yaw
   * and scale are then relative to that node. null puts `root` back under the parent it had before. The caller
   * detaches before disposing the node's owner: disposing a parent disposes this actor with it.
   */
  attachTo(node: TransformNode | null): void {
    if (this.disposed) return
    if (node) {
      if (this.home === undefined) this.home = this.root.parent
      this.root.parent = node
    } else if (this.home !== undefined) {
      this.root.parent = this.home && !this.home.isDisposed() ? this.home : null
      this.home = undefined
    }
  }

  /** The node attachTo parented `root` to (null while not attached). */
  get attachedTo(): Node | null {
    return this.home === undefined ? null : this.root.parent
  }

  /** A joint (bone node) by name, e.g. 'Bip01 R Hand', for effects that follow a bone. */
  joint(name: string): TransformNode | undefined {
    return this.joints.get(name)
  }

  /**
   * A skill action (docs/SKILLS.md §5.1): the phases play in turn over the base (READY, WAIT looping, SHOT), each
   * held for its `ms`, then the base resumes. A newer action, death or stopSkill(token) ends it. Returns the token.
   */
  playSkill(phases: readonly SkillPhase[]): number {
    if (this.dead || !phases.length) return -1
    const token = ++this.actionSerial
    this.skillToken = token
    this.stopArmLayer()
    const prevAction = this.action
    this.action = null
    prevAction?.stop()
    if (this.current) this.current.stop()
    this.current = null
    let i = -1
    let until = 0
    const next = (): boolean => {
      const prev = phases[i]?.clip
      const p = phases[++i]
      if (prev && prev !== p?.clip) prev.stop()
      if (!p) {
        this.action = null
        // Wave 11: a companion whose driver still acts holds its last frame (the driver's resume restarts it).
        if (!this.dead && this.currentBase && !this.heldByDriver) this.play(this.currentBase, true, this.currentSpeed)
        return false
      }
      this.action = p.clip
      if (prev !== p.clip) {
        p.clip.stop()
        p.clip.start(!!p.loop, p.speed ?? 1, p.clip.from, p.clip.to)
      }
      until = performance.now() + Math.max(0, p.ms)
      return true
    }
    next()
    // Wave 11: the companion plays the same phases with its own clips (STUN → STAND1; a missing clip: its base clip).
    const c = this.companionActor
    if (c && !c.disposed && !c.dead) {
      const own = phases.map(p => c.mirrorClip(p.clip.name))
      if (own.some(g => g)) {
        const fill = c.clipFor(c.currentBase ?? 'STAND1')
        const mirrored: SkillPhase[] = []
        phases.forEach((p, k) => {
          const g = own[k] ?? fill
          if (g) mirrored.push({ ...p, clip: g, loop: own[k] ? p.loop : true })
        })
        c.playSkill(mirrored)
      }
    }
    const obs = this.scene.onBeforeRenderObservable.add(() => {
      if (token !== this.actionSerial || this.disposed) {
        this.scene.onBeforeRenderObservable.remove(obs)
        return
      }
      while (performance.now() >= until) {
        if (!next()) {
          this.scene.onBeforeRenderObservable.remove(obs)
          return
        }
      }
    })
    return token
  }

  /** Ends the skill action `token` early (castEnd, target lost): back to the base clip. */
  stopSkill(token: number): void {
    if (token !== this.actionSerial || !this.action || this.dead) return
    this.actionSerial++
    this.action.stop()
    this.action = null
    if (this.currentBase) this.play(this.currentBase, true, this.currentSpeed)
  }

  /**
   * Ends the playing action early when `which(name)` says so (a posture change, an emote or an idle fidget cut short by a
   * move): back to the base clip at once. False when no such action plays.
   */
  cancelAction(which: (name: string) => boolean): boolean {
    // Wave 11: with no action of its own, the companion's (a hit reaction only it plays) is asked the same.
    if (!this.action && !this.dead) this.companionActor?.cancelAction(which)
    if (!this.action || this.dead || !which(this.action.name)) return false
    const move = this.isMovementClip(this.action)
    this.actionSerial++
    this.stopArmLayer()
    this.action.stop()
    this.action = null
    if (this.currentBase) this.play(this.currentBase, true, this.currentSpeed)
    if (move) this.blendBaseOut()
    return true
  }

  /** The skill action `token` is still playing. */
  isSkillPlaying(token: number): boolean {
    return token === this.actionSerial && !!this.action && !this.dead
  }

  /** Hit reaction: a partial clip plays on top; a full one only while idle. */
  hurt(): void {
    if (this.dead) return
    const g = this.group('DAMAGE1')
    // Wave 11: the companion reacts too (through playAction's mirror when this one plays a full DAMAGE1).
    const full = !!g && !this.clips.get(g.name)?.partial && this.idle
    if (!full) this.companionActor?.hurt()
    if (!g) return
    if (this.clips.get(g.name)?.partial) {
      g.stop()
      g.start(false, 1, g.from, g.to)
    } else if (this.idle) {
      this.playAction(g)
    }
  }

  /**
   * The death clip once (`clip`, default DIE1; DOWN_DIE for a knocked-down victim, DIE1 when the actor lacks it), then
   * the DIE1_RM rest loop when the actor has it, else the last pose held. `instant` jumps to the end (entities that
   * arrive already dead).
   */
  die(instant = false, clip: DeathClip = 'DIE1'): void {
    // Wave 11: the companion dies with it (DIE1 then DIE1_RM on both: she falls beside the tiger).
    this.companionActor?.die(instant, clip)
    if (this.dead) return
    this.dead = true
    this.silentDeath = instant
    this.actionSerial++
    this.action = null
    this.armLayer = null
    for (const g of this.groups) g.stop()
    this.current = null
    const g = this.group(clip) ?? this.group('DIE1')
    this.deathClip = g ?? null
    if (g) {
      const serial = this.actionSerial
      const rest = this.group('DIE1_RM')
      if (rest && rest !== g) {
        g.onAnimationGroupEndObservable.addOnce(() => {
          if (!this.dead || this.disposed || serial !== this.actionSerial || this.deathClip !== g) return
          this.deathClip = rest
          rest.start(true, 1, rest.from, rest.to)
        })
      }
      // A corpse that arrives dead (or a fresh actor) lies down at once instead of blending from the bind pose (D25).
      this.startUnblended(g, instant || !this.posedOnce, false, instant ? 20 : 1)
      this.posedOnce = true
    } else {
      // No death clip: lie down.
      this.root.rotationQuaternion!.multiplyInPlace(Quaternion.RotationAxis(Vector3.Forward(), Math.PI / 2))
    }
  }

  /**
   * Where the clips are, for the sound runtime (docs/SOUND.md §5.7): the full clip on top (the action or skill phase
   * if one plays, else the base clip; DIE1 when dead, silent after die(true)) and the partial DAMAGE1 overlay.
   */
  clipCursors(): ClipCursors {
    const cursor = (g: AnimationGroup | null | undefined, silent = false): ClipCursor | null => {
      const a = g?.isPlaying ? g.animatables[0] : undefined
      if (!g || !a) return null
      const span = g.to - g.from
      const fps = g.targetedAnimations[0]?.animation.framePerSecond || 30
      const durationMs = this.clips.get(g.name)?.durationMs ?? (span / fps) * 1000
      const f = span > 0 ? Math.min(1, Math.max(0, (a.masterFrame - g.from) / span)) : 0
      return { name: g.name, ms: f * durationMs, durationMs, run: this.clipRuns.get(g) ?? 0, ...(silent ? { silent: true as const } : {}) }
    }
    // The DIE1_RM rest loop is silent (its sounds would repeat every few hundred ms).
    const top = this.dead ? cursor(this.deathClip, this.silentDeath || this.deathClip?.name === 'DIE1_RM') : cursor(this.action) ?? cursor(this.current)
    const dmg = this.group('DAMAGE1')
    const overlay = !this.dead && dmg && dmg !== this.action && this.clips.get(dmg.name)?.partial ? cursor(dmg) : null
    return { top, overlay }
  }

  revive(): void {
    this.companionActor?.revive()
    if (!this.dead) return
    this.dead = false
    this.deathClip = null
    this.actionSerial++
    for (const g of this.groups) g.stop()
    this.current = null
    this.play(this.currentBase ?? 'STAND1', true)
  }

  setEnabled(on: boolean): void {
    this.root.setEnabled(on)
    this.companionActor?.setEnabled(on)
  }

  /** Mesh opacity of the body and everything worn (1 = opaque; an invisible GM is drawn faded). */
  setOpacity(alpha: number): void {
    this.opacity = alpha
    for (const m of this.allMeshes()) m.visibility = alpha
    this.companionActor?.setOpacity(alpha)
  }

  /**
   * Hover highlight: a light colour overlay on every mesh, a tint over the lit model. W9 LOOK's exposure-aware overlay
   * (world-render setHighlightOverlay): on the PBR presets the overlay blends into the scene-linear frame before the
   * post stack's exposure, so the colour is linearised and divided by it (and re-scaled while the exposure moves);
   * as it was, a PBR entity became a solid white silhouette. On Classic (exposure 1) it is HEAD's overlay.
   */
  setHighlight(on: boolean, color: Readonly<Color3> = HIGHLIGHT_COLOR): void {
    this.highlight = on ? color : null
    for (const m of this.allMeshes()) setHighlightOverlay(m, on ? color : null)
    this.companionActor?.setHighlight(on, color)
  }

  get position(): Vector3 {
    return this.root.position
  }

  setYaw(yaw: number): void {
    if (this.dead && !this.group('DIE1')) return
    Quaternion.RotationYawPitchRollToRef(yaw, 0, 0, this.root.rotationQuaternion!)
  }

  dispose(): void {
    this.disposed = true
    this.dressToken++
    this.actionSerial++
    // Wave 11: the LOD links are cut both ways; the companion goes after this one (whose root may hang under it).
    const c = this.companionActor
    this.companion = null
    this.lodLeader = null
    for (const f of [...this.lodFollowers]) f.lodLeader = null
    for (const g of this.groups) g.dispose()
    this.removeWorn()
    for (const s of this.skeleton ? [this.skeleton] : []) s.dispose()
    for (const n of this.nodes) n.dispose(false, false)
    this.root.dispose()
    if (c && !c.disposed) c.dispose()
  }
}
