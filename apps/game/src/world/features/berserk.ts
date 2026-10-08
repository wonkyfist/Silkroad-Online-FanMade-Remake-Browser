/**
 * Berserk, the client (docs/SYSTEMS_COMBAT.md §5.3, docs/WAVE_PLAN2.md D26/D37; lane BZ):
 *  - the gauge: five orbs around the portrait in `PlayerFrame.berserkHost` (hud/berserk.ts), filled from
 *    `stats.hwan` / `statsDelta.hwan`; at a full gauge the glows pulse and the Berserk button appears;
 *  - Tab (`combat.berserk`, hud.keys; never from a chat input) or the button sends `berserk {}`. A gauge that is not
 *    full, or a Berserk already running, is refused here with the server's own line (no request); the server's
 *    refusals (`mounted`, `trading`, ...) are toasted by the HUD (claimRequests);
 *  - `entityUpdate {berserkMs}` (and `EntityState.berserkMs` for late viewers) drives the look of every berserk
 *    player: the SYSTEM_CH_HWANMODE rows through SystemFx (ACT_S burst on `Bip01`, the ACT_L keep loops on the spine
 *    and limbs, DEACT at the end), the `berserk.start` / `berserk.end` sounds, the 1.1× growth of the keep_s row's
 *    SCT_CHAR_SCALE script, and the hwan hair: the HAIR slot mesh of the character (from @sro/appearance's
 *    equipment manifest) is hidden and chinaman/chinawoman_hwan_hair hangs on `Bip01 Head` by the socket rule, with
 *    its luster_hwan particles. A head item that hides the hair keeps the hwan hair off too.
 * Hits carrying `CombatHit.hwan` pick the HWAN spark in the skills feature (skill-fx.ts), not here.
 */
import { AbstractMesh, Quaternion, TransformNode, Vector3, type AssetContainer, type Node } from '@babylonjs/core'
import { HWAN_MAX, type ClientMessage, type EntityState, type ServerMessage } from '@sro/shared'
import { gameAudio } from '../../audio/index.ts'
import { BERSERK_SYNTH } from '../../audio/synth.ts'
import { BerserkGauge, type BerserkTimer } from '../../hud/berserk.ts'
import { BerserkScreen, berserkHitNumbers } from '../../hud/berserk-screen.ts'
import { actionFailText } from '../../hud/index.ts'
import type { KeyBinding } from '../../hud/keys.ts'
import { registerOptionRow } from '../../hud/options.ts'
import { t } from '../../i18n/index.ts'
import { settings } from '../../settings.ts'
import { characterGender, equipmentLookup } from '../../three/equipment.ts'
import { dummiesFromSidecar, ModelLibrary, type CharacterActor } from '../../three/models.ts'
import type { EntityView } from '../entities.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import {
  HIT_STOP_MS,
  HIT_STOP_SCALE,
  START_FREEZE_MS,
  beatIndex,
  berserkPhase,
  berserkTier,
  flicker,
  glowLevel,
  heartBpm,
  heartbeat,
  hitBump,
  makeoverParts,
  NO_MAKEOVER,
  startCamera,
  type BerserkPhase,
  type MakeoverParts,
} from '../fx/berserk-look.ts'
import { BerserkMakeover, BerserkPool } from '../fx/berserk-makeover.ts'
import { CameraNudge, Flinches, TimeFreeze } from '../fx/berserk-own.ts'
import { ModelParticles, readParticles } from '../fx/model-particles.ts'
import { systemFxFor, type FxHandle, type SystemFx } from '../fx/system-fx.ts'

/** The SYSTEM row of the Berserk effects (fx index v2; docs/EFFECTS.md §3.9). */
export const HWAN_FX = 'SYSTEM_CH_HWANMODE'
/** The Berserk key (docs/SYSTEMS_COMBAT.md §5.3; Tab is free, D37). */
export const BERSERK_KEY = { id: 'combat.berserk', keys: ['tab'], label: 'bz.key', group: 'combat' } as const satisfies Omit<KeyBinding, 'run'>
/** Default Berserk length (HWAN_DURATION_MS) for a timer first seen part-way (a late viewer's countdown). */
export const BERSERK_DEFAULT_MS = 60_000
/** A timer this long past its end without the server's `berserkMs: 0` is dropped (a lost message). */
export const BERSERK_GRACE_MS = 3000
/** SCT_CHAR_SCALE,1.1,1000 (system_hwan_keep_s): the berserk character grows to 1.1× in 1 s. */
export const HWAN_SCALE = 1.1
export const HWAN_SCALE_MS = 1000
/** The hwan hair per gender (EXP converted res/char/china/*_hwan_hair.bsr; REPLACE on the HAIR slot, `_ha`). */
export const HWAN_HAIR = {
  male: { glb: '/out/char/china/chinaman_hwan_hair.glb', sidecar: '/out/char/china/chinaman_hwan_hair.json' },
  female: { glb: '/out/char/china/chinawoman_hwan_hair.glb', sidecar: '/out/char/china/chinawoman_hwan_hair.json' },
} as const
export const HWAN_HAIR_BONE = 'Bip01 Head'

/** Registers Tab → `run` on the KeyMap (group combat); returns the unregister function. */
export function registerBerserkKey(keys: { register(b: KeyBinding): () => void }, run: () => void): () => void {
  return keys.register({ ...BERSERK_KEY, keys: [...BERSERK_KEY.keys], run: () => run() })
}

// ---- state (DOM-free) ----------------------------------------------------------------------------------------------

export interface BerserkIo {
  send(msg: ClientMessage): boolean
  selfId(): number | null
  selfDead(): boolean
  /** Server time (ms). */
  now(): number
  /** An error toast (a refusal). */
  toast(text: string): void
  /** A system line in the chat. */
  line(text: string): void
  /** The own gauge changed. */
  gauge(points: number, timer: BerserkTimer | null): void
  /** Player `id` turned berserk (`burst`: just now, so the activation burst and sound play; false = seen late). */
  start(id: number, burst: boolean): void
  /** Player `id` is no longer berserk (`fade`: the end effect and sound play; false = it left the view). */
  end(id: number, fade: boolean): void
}

export type ActivateResult = 'sent' | 'dead' | 'active' | 'not_ready' | 'offline'

/** Points, Berserk timers per entity and the activation rule; drives the gauge and the looks through BerserkIo. */
export class BerserkController {
  private pts = 0
  private readonly timers = new Map<number, BerserkTimer>()

  constructor(private readonly io: BerserkIo) {}

  get points(): number {
    return this.pts
  }

  timer(id: number): BerserkTimer | null {
    return this.timers.get(id) ?? null
  }

  active(id: number): boolean {
    return this.timers.has(id)
  }

  /** Entity ids that are berserk now. */
  ids(): number[] {
    return [...this.timers.keys()]
  }

  onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'worldEnter':
        // A new world visit rebuilds every view: onEntityRemoved dropped the old looks and onEntityAdded (which runs
        // before this hook) started the snapshot's berserk players, so only the gauge is redrawn here.
        this.pushGauge()
        break
      case 'stats':
        this.setPoints(msg.stats.hwan ?? 0)
        break
      case 'statsDelta':
        if (msg.stats.hwan !== undefined) this.setPoints(msg.stats.hwan)
        break
      case 'entityUpdate':
        if (msg.berserkMs !== undefined) this.setBerserk(msg.id, msg.berserkMs, true)
        break
    }
  }

  /** A view appeared (spawn, worldEnter snapshot): a player already berserk is shown without the burst. */
  added(id: number, state: Pick<EntityState, 'kind' | 'berserkMs'>): void {
    if (state.kind !== 'player' || !state.berserkMs || state.berserkMs <= 0) return
    const had = this.timers.get(id)
    this.timers.set(id, { until: this.io.now() + state.berserkMs, total: had?.total ?? Math.max(state.berserkMs, BERSERK_DEFAULT_MS) })
    // Always (re)start the look: an entityUpdate may have come before the view existed.
    this.io.start(id, false)
    if (id === this.io.selfId()) this.pushGauge()
  }

  /** A view left: its look goes without the end effect. */
  removed(id: number): void {
    if (this.timers.has(id)) this.drop(id, false)
  }

  /** Tab or the button. */
  activate(): ActivateResult {
    const self = this.io.selfId()
    if (self === null) return 'offline'
    if (this.io.selfDead()) return 'dead'
    if (this.timers.has(self)) {
      this.io.toast(actionFailText('berserk_active'))
      return 'active'
    }
    if (this.pts < HWAN_MAX) {
      this.io.toast(actionFailText('berserk_not_ready'))
      return 'not_ready'
    }
    return this.io.send({ t: 'berserk' }) ? 'sent' : 'offline'
  }

  /** Drops timers whose end never arrived (BERSERK_GRACE_MS past `until`). */
  tick(now: number): void {
    for (const [id, tm] of [...this.timers]) if (now > tm.until + BERSERK_GRACE_MS) this.drop(id, true)
  }

  private setPoints(n: number): void {
    const v = Math.max(0, Math.min(HWAN_MAX, Math.floor(Number.isFinite(n) ? n : 0)))
    if (v === this.pts) return
    this.pts = v
    this.pushGauge()
  }

  private setBerserk(id: number, ms: number, live: boolean): void {
    const had = this.timers.get(id)
    if (ms > 0) {
      const total = had?.total ?? (live ? ms : Math.max(ms, BERSERK_DEFAULT_MS))
      this.timers.set(id, { until: this.io.now() + ms, total })
      if (!had) {
        this.io.start(id, live)
        if (live && id === this.io.selfId()) this.io.line(t('bz.started'))
      }
    } else if (had) {
      this.drop(id, live)
      if (live && id === this.io.selfId()) this.io.line(t('bz.ended'))
      return
    }
    if (id === this.io.selfId()) this.pushGauge()
  }

  private drop(id: number, fade: boolean): void {
    this.timers.delete(id)
    this.io.end(id, fade)
    if (id === this.io.selfId()) this.pushGauge()
  }

  private pushGauge(): void {
    const self = this.io.selfId()
    this.io.gauge(this.pts, self === null ? null : (this.timers.get(self) ?? null))
  }
}

// ---- the look (Babylon) --------------------------------------------------------------------------------------------

/** Growth of the 1.1× scale: 0..1 → factor. */
export function hwanScale(grow: number): number {
  return 1 + (HWAN_SCALE - 1) * Math.max(0, Math.min(1, grow))
}

/** Meshes of a node (itself when it is one, and its children). */
function meshesOf(n: Node): AbstractMesh[] {
  const own = n instanceof AbstractMesh ? [n] : []
  return [...own, ...n.getChildMeshes(false)]
}

/** The hwan hair on one actor: the HAIR mesh hidden (isVisible, which the dress code never touches) and the hair hung. */
class HwanHair {
  private readonly nodes: Node[]
  private readonly base: Node[]
  private readonly hiddenMeshes: AbstractMesh[] = []
  private readonly particles: ModelParticles | null
  private readonly root: TransformNode | null

  constructor(readonly actor: CharacterActor, asset: { container: AssetContainer; sidecar: Record<string, unknown> | null }, hairMesh: string | null, runner: SystemFx['runner'], scale: () => number) {
    this.base = hairMesh ? actor.root.getDescendants(false).filter(n => n.name === hairMesh) : []
    const bone = actor.skeleton?.bones.find(b => b.name === HWAN_HAIR_BONE || b.getTransformNode()?.name === HWAN_HAIR_BONE)
    const target = bone?.getTransformNode()
    if (!bone || !target) {
      this.nodes = []
      this.root = null
      this.particles = null
      return
    }
    const inst = asset.container.instantiateModelsToScene(n => n, false, { doNotInstantiate: true })
    for (const g of inst.animationGroups) g.dispose()
    for (const s of inst.skeletons) s.dispose()
    this.nodes = inst.rootNodes
    // The SRO socket rule (three/models.ts hangOnSocket): at the bone, only its bind-pose world rotation cancelled.
    for (const r of inst.rootNodes) {
      const tn = r as TransformNode
      tn.parent = target
      tn.position?.setAll(0)
      tn.scaling?.setAll(1)
      tn.rotationQuaternion = Quaternion.Identity()
      bone.getAbsoluteInverseBindMatrix().decompose(undefined, tn.rotationQuaternion, undefined)
      for (const m of meshesOf(tn)) {
        m.isPickable = false
        m.alwaysSelectAsActiveMesh = true
      }
    }
    this.root = (inst.rootNodes[0] as TransformNode | undefined) ?? null
    const dummies = new Map<string, TransformNode>()
    if (this.root) {
      for (const [name, [x, y, z]] of dummiesFromSidecar(asset.sidecar)) {
        const d = new TransformNode(`hwan:${name}`, actor.scene)
        d.parent = this.root
        d.position.set(x, y, z)
        dummies.set(name, d)
      }
    }
    const rows = readParticles(asset.sidecar)
    this.particles = this.root && rows.length ? new ModelParticles(runner, rows, { root: this.root, joint: n => dummies.get(n) }, { scale }) : null
    this.sync()
  }

  /** Per frame: the base hair stays hidden; a head item that disabled the hair hides the hwan hair too. */
  sync(): void {
    const capped = this.base.length > 0 && this.base.every(n => !n.isEnabled(false))
    for (const n of this.nodes) if (!n.isDisposed()) n.setEnabled(!capped)
    if (capped) return
    for (const n of this.base) {
      for (const m of meshesOf(n)) {
        if (!m.isVisible) continue
        m.isVisible = false
        this.hiddenMeshes.push(m)
      }
    }
  }

  get attached(): boolean {
    return this.nodes.length > 0
  }

  /** The hwan hair's meshes (the makeover outlines them too). */
  meshes(): AbstractMesh[] {
    return this.nodes.flatMap(n => (n.isDisposed() ? [] : meshesOf(n)))
  }

  dispose(): void {
    this.particles?.dispose()
    for (const m of this.hiddenMeshes) if (!m.isDisposed()) m.isVisible = true
    this.hiddenMeshes.length = 0
    for (const n of this.nodes) if (!n.isDisposed()) n.dispose(false, false)
  }
}

export interface LookDeps {
  fx: SystemFx
  hairFor(actor: CharacterActor): Promise<{ asset: { container: AssetContainer; sidecar: Record<string, unknown> | null }; hairMesh: string | null } | null>
  selfId(): number | null
  /** The scene's makeover pool (made on first use, disposed by the feature once idle). */
  pool(): BerserkPool
  /** The feature's clock (ms). */
  clock(): number
}

/** The roar under the retail start sound: a retail tiger shout, pitched down (docs/EFFECTS.md §3.9). */
export const ROAR_FILE = 'monster/cm_tiger_shout_a'
export const ROAR_RATE = 0.72

/** What a look reads each frame. */
export interface LookFrame {
  /** The feature's clock (ms). */
  now: number
  /** The Berserk left (ms; null: no timer). */
  leftMs: number | null
  parts: MakeoverParts
}

/** An attack or skill clip plays on `actor` (the afterimages trail swings too). */
function swinging(actor: CharacterActor | null): boolean {
  const top = actor && !actor.isDisposed ? actor.clipCursors().top : null
  return !!top && /^(ATTACK|SKILL)/.test(top.name)
}

/**
 * One berserk player's look: the retail keep loops (toned down), the growth and the hair, and the makeover (outline,
 * embers, afterimages, eyes, footsteps; world/fx/berserk-makeover.ts); `end` fades it out.
 */
export class BerserkLook {
  private loop: FxHandle | null = null
  private hair: HwanHair | null = null
  private hairFor: CharacterActor | null = null
  private hairLoading = false
  private grow = 0
  private endingNow = false
  private disposed = false
  private extra: BerserkMakeover | null = null
  /** The actor kept out of the crowd tier (the outline shells need its own parts drawn: docs/CHARACTERS.md §3.5). */
  private held: CharacterActor | null = null
  /** When the look began (the feature's clock, ms), and whether it began with the activation burst. */
  readonly since: number
  readonly burst: boolean
  phase: BerserkPhase = 'start'
  level = 0

  constructor(private readonly deps: LookDeps, readonly view: EntityView, burst: boolean, parts: MakeoverParts, cloud: { scale: number; fade: number }) {
    this.since = deps.clock()
    this.burst = burst
    if (burst) {
      deps.fx.play(HWAN_FX, 'start', view)
      sound(view, 'berserk.start', deps.selfId())
      roar(view, deps.selfId())
    } else this.grow = 1
    // The retail keep cloud, smaller and fainter so the outline reads (docs/EFFECTS.md §3.9).
    this.loop = deps.fx.play(HWAN_FX, 'loop', view, { scale: cloud.scale, fade: cloud.fade })
    if (!view.dead) {
      this.extra = this.makeExtra()
      if (burst) this.extra.start(parts)
    }
  }

  private makeExtra(): BerserkMakeover {
    const view = this.view
    return new BerserkMakeover(
      this.deps.pool(),
      {
        get actor() {
          return view.actor
        },
        feet: () => view.root.position,
        get yaw() {
          return view.yaw
        },
        get moving() {
          return view.moving
        },
        swinging: () => swinging(view.actor),
        height: () => (view.actor && !view.actor.isDisposed ? view.actor.height : 1.8) * (view.scale || 1),
        extraMeshes: () => this.hair?.meshes() ?? [],
      },
      BerserkMakeover.seedOf(view.id),
    )
  }

  /** Whether the Berserk ended (the look is fading out). */
  get ending(): boolean {
    return this.endingNow || this.disposed
  }

  /** The makeover's outline meshes (tests, the perf readout). */
  get makeover(): BerserkMakeover | null {
    return this.extra
  }

  /** Per frame; false once the end has faded (the owner drops it). */
  update(dtMs: number, f: LookFrame): boolean {
    if (this.disposed) return false
    const actor = this.view.actor
    if (actor !== this.held) {
      this.held?.holdCrowd?.('berserk', false)
      this.held = actor && !actor.isDisposed ? actor : null
      this.held?.holdCrowd?.('berserk', true)
    }
    this.grow = Math.max(0, Math.min(1, this.grow + ((this.endingNow ? -1 : 1) * dtMs) / HWAN_SCALE_MS))
    if (actor && !actor.isDisposed) actor.root.scaling.setAll(this.view.scale * hwanScale(this.grow))
    if (this.endingNow) {
      if (this.grow > 0) return true
      this.dispose()
      return false
    }
    if (actor && actor !== this.hairFor && !this.hairLoading) this.dress(actor)
    this.hair?.sync()
    const since = f.now - this.since
    this.phase = berserkPhase(since, f.leftMs, false, this.burst)
    this.level = glowLevel(since, this.phase, f.leftMs, this.view.id)
    if (this.view.dead || this.view.isDisposed) {
      // A dead berserk player keeps the retail loop until the server ends it; the makeover goes now.
      this.extra?.dispose()
      this.extra = null
    } else {
      this.extra ??= this.makeExtra()
      this.extra.update(f.now, this.level, f.parts)
    }
    return true
  }

  private dress(actor: CharacterActor): void {
    this.hair?.dispose()
    this.hair = null
    this.hairFor = actor
    this.hairLoading = true
    void this.deps.hairFor(actor).then(
      h => {
        this.hairLoading = false
        if (!h || this.disposed || this.endingNow || actor.isDisposed || this.view.actor !== actor) return
        this.hair = new HwanHair(actor, h.asset, h.hairMesh, this.deps.fx.runner, () => this.view.scale)
      },
      err => {
        this.hairLoading = false
        console.warn('[berserk] hwan hair unavailable', err)
      },
    )
  }

  /** A warp moved the player: what trails behind starts over at the new spot. */
  warped(): void {
    this.extra?.warped()
  }

  /**
   * The Berserk ended: the keep loops stop, the hair goes, the scale shrinks back (`fade`: DEACT row, the retail end
   * sound and the exhale; `steam`: the steam puff).
   */
  end(fade: boolean, steam: boolean): void {
    if (this.endingNow || this.disposed) return
    this.endingNow = true
    this.loop?.stop()
    this.loop = null
    this.hair?.dispose()
    this.hair = null
    const live = fade && !this.view.isDisposed
    if (live) {
      this.deps.fx.play(HWAN_FX, 'end', this.view)
      sound(this.view, 'berserk.end', this.deps.selfId())
      exhale(this.view, this.deps.selfId())
    }
    this.extra?.end(live && steam)
    this.extra = null
    if (!fade) this.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.loop?.stop()
    this.hair?.dispose()
    this.extra?.dispose()
    this.extra = null
    this.held?.holdCrowd?.('berserk', false)
    this.held = null
    const actor = this.view.actor
    if (actor && !actor.isDisposed) actor.root.scaling.setAll(this.view.scale)
  }
}

/** Where a sound of `v` plays: nowhere for yourself (non-spatial), else at its chest. */
function soundAt(v: EntityView, selfId: number | null): { self: boolean; pos?: { x: number; y: number; z: number } } {
  const self = v.id === selfId
  return self ? { self } : { self, pos: { x: v.root.position.x, y: v.root.position.y + 1, z: v.root.position.z } }
}

function sound(v: EntityView, cue: string, selfId: number | null): void {
  const audio = gameAudio()
  if (!audio) return
  const self = v.id === selfId
  audio.play(cue, { entity: v.id, self, pos: { x: v.root.position.x, y: v.root.position.y + 1, z: v.root.position.z } })
}

/** The makeover's roar and sub drop under the retail start sound. */
function roar(v: EntityView, selfId: number | null): void {
  const audio = gameAudio()
  if (!audio) return
  const at = soundAt(v, selfId)
  audio.playFile(ROAR_FILE, { ...at, kind: 'voice', gain: 0.55, rate: ROAR_RATE, priority: at.self ? 3 : 1 })
  audio.playFile('synth/bz_boom', { ...at, gain: 0.85, priority: at.self ? 3 : 1 })
}

/** The exhale at the end. */
function exhale(v: EntityView, selfId: number | null): void {
  const audio = gameAudio()
  if (!audio) return
  const at = soundAt(v, selfId)
  audio.playFile('synth/bz_exhale', { ...at, gain: 0.7, priority: at.self ? 3 : 1 })
}

// ---- the feature ---------------------------------------------------------------------------------------------------

/** An own hit pushes a monster back this far (m; crits further). Visual only: the server has no Berserk knockback. */
export const FLINCH_M = 0.13
export const FLINCH_CRIT_M = 0.22

export function berserkFeature(ctx: WorldFeatureContext): WorldFeature {
  // A bare context (tests of the feature list) gets nothing.
  if (!ctx.hud || !ctx.app || !ctx.scene) return {}
  const { hud, scene } = ctx
  const offs: (() => void)[] = []
  const looks = new Map<number, BerserkLook>()
  let library: ModelLibrary | null = null
  let fx: SystemFx | null = null
  const systemFx = () => (fx ??= systemFxFor(scene))
  const clock = () => performance.now()
  let pool: BerserkPool | null = null
  const usePool = () => {
    if (!pool || pool.isDisposed) pool = new BerserkPool(scene, clock)
    return pool
  }

  const hairFor: LookDeps['hairFor'] = async actor => {
    if (!/^CHAR_CH_/.test(actor.model.code)) return null
    const lookup = await equipmentLookup()
    const gender = characterGender(actor.model.code, lookup)
    const src = HWAN_HAIR[gender]
    library ??= new ModelLibrary(scene)
    const loaded = await library.load(src.glb, src.sidecar)
    return { asset: loaded, hairMesh: lookup?.characters.get(actor.model.code)?.slots.HAIR ?? null }
  }
  const deps: LookDeps = { get fx() { return systemFx() }, hairFor, selfId: () => ctx.selfId(), pool: usePool, clock }

  /** The LAB switch (`window.__sroBerserk.makeover = false`: the retail look alone, for an A/B of the frame time). */
  const lab: { makeover: boolean; parts: Partial<MakeoverParts> } = { makeover: true, parts: {} }
  /** What `id` shows on this screen (by the graphics tier, own or not, and its rank among the other berserk players). */
  const partsCache = new Map<string, MakeoverParts>()
  let partsLab = ''
  const partsFor = (id: number, rank = 0): MakeoverParts => {
    if (!lab.makeover) return NO_MAKEOVER
    const s = settings.get()
    const tier = berserkTier(s.graphics.preset)
    const self = id === ctx.selfId()
    // Every frame asks for every look: one object per distinct answer, not per call.
    const labKey = JSON.stringify(lab.parts)
    if (labKey !== partsLab) {
      partsLab = labKey
      partsCache.clear()
    }
    const key = `${s.graphics.preset}|${self}|${rank < tier.afterimageOthers}|${s.ui.berserkScreen}|${s.controls.cameraShake}`
    let parts = partsCache.get(key)
    if (!parts) {
      parts = { ...makeoverParts(tier, self, rank, { screen: s.ui.berserkScreen, shake: s.controls.cameraShake }), ...lab.parts }
      partsCache.set(key, parts)
    }
    return parts
  }

  // ---- own screen: the edge, flash, heartbeat, camera, hit-freeze and hit-stop, the flinch of what you hit ----------
  const nudge = new CameraNudge(ctx.camera)
  const freeze = new TimeFreeze(scene)
  const flinches = new Flinches()
  let screen: BerserkScreen | null = null
  let ownStart = -Infinity
  let lastBeat = -1
  let hitNumbers = false
  const bumps: number[] = []
  const useScreen = (): BerserkScreen | null => {
    if (screen) return screen
    const canvas = scene.getEngine().getRenderingCanvas()
    if (!canvas || typeof document === 'undefined') return null
    return (screen = new BerserkScreen(canvas))
  }
  const ownStarted = (burst: boolean, parts: MakeoverParts) => {
    lastBeat = -1
    if (!burst) return
    const now = clock()
    ownStart = now
    if (parts.hitStop) freeze.freeze(now, START_FREEZE_MS, 0)
    if (parts.flash) useScreen()?.startFlash(now, settings.get().ui.reduceFlashing)
  }
  const ownFrame = (now: number) => {
    const self = ctx.selfId()
    const look = self === null ? undefined : looks.get(self)
    let push = 0
    let x = 0
    let y = 0
    const ownOn = self !== null && !!look && !look.ending && lab.makeover
    if (ownOn !== hitNumbers) berserkHitNumbers((hitNumbers = ownOn))
    if (self !== null && look && !look.ending) {
      const parts = partsFor(self)
      const since = now - look.since
      const timer = controller.timer(self)
      const left = timer ? timer.until - ctx.serverNow() : null
      const bpm = heartBpm(look.phase)
      if (parts.vignette || parts.richColor || screen) {
        const beat = heartbeat(since, bpm)
        const fadeIn = look.burst ? Math.min(1, since / 600) : 1
        const edge = parts.vignette ? fadeIn * (0.4 + 0.45 * beat) * (look.phase === 'last' ? flicker(since, left, self) : 1) : 0
        useScreen()?.update(now, edge, parts.richColor)
      }
      if (parts.heartbeat) {
        const b = beatIndex(since, bpm)
        if (b !== lastBeat) {
          if (lastBeat >= 0) gameAudio()?.playFile('synth/bz_heart', { self: true, gain: look.phase === 'last' ? 0.8 : 0.55, priority: 2 })
          lastBeat = b
        }
      }
      if (parts.camera) {
        const c = startCamera(now - ownStart)
        push += c.push
        x += c.x
        y += c.y
        for (const at of bumps) push += hitBump(now - at)
      }
    } else if (screen) {
      screen.dispose()
      screen = null
    }
    while (bumps.length && now - bumps[0]! > 1000) bumps.shift()
    if (push || x || y || !nudge.idle) nudge.apply(push, x, y)
    freeze.update(now)
    flinches.update(now)
  }

  const gauge = new BerserkGauge(ctx.app.art, hud.playerFrame.berserkHost, () => void controller.activate())
  const controller: BerserkController = new BerserkController({
    send: msg => ctx.send(msg),
    selfId: () => ctx.selfId(),
    selfDead: () => {
      const id = ctx.selfId()
      return id === null || !!ctx.view(id)?.dead
    },
    now: () => ctx.serverNow(),
    toast: text => hud.toast(text, 'error'),
    line: text => ctx.chat.add('system', text),
    gauge: (points, timer) => gauge.set(points, timer, ctx.serverNow()),
    start: (id, burst) => {
      const v = ctx.view(id)
      if (!v) return
      const cur = looks.get(id)
      if (cur && cur.view === v && !cur.ending) return
      // A look still fading out from the last Berserk (or of an older view) is replaced.
      cur?.dispose()
      const parts = partsFor(id)
      const tier = berserkTier(settings.get().graphics.preset)
      looks.set(id, new BerserkLook(deps, v, burst, parts, { scale: tier.cloudScale, fade: tier.cloudFade }))
      if (id === ctx.selfId()) ownStarted(burst, parts)
    },
    end: (id, fade) => looks.get(id)?.end(fade, partsFor(id).steam),
  })

  hud.claimRequests(['berserk'])
  offs.push(
    registerBerserkKey(hud.keys, () => void controller.activate()),
    registerOptionRow('interface', {
      id: 'ui.berserkScreen',
      kind: 'toggle',
      label: 'bz.option.screen',
      get: s => s.ui.berserkScreen,
      patch: v => ({ ui: { berserkScreen: v } }),
    }),
  )
  const audio = gameAudio()
  if (audio) for (const [id, make] of Object.entries(BERSERK_SYNTH)) audio.prepareSynth(id, make)
  if (typeof window !== 'undefined') {
    // Console / LAB handle: the switch, and what the makeover draws now.
    const w = window as unknown as { __sroBerserk?: unknown }
    w.__sroBerserk = {
      get makeover() {
        return lab.makeover
      },
      set makeover(on: boolean) {
        lab.makeover = !!on
      },
      /** Per-part overrides for the LAB (`{ afterimages: 0 }`). */
      get parts() {
        return lab.parts
      },
      set parts(p: Partial<MakeoverParts>) {
        lab.parts = { ...p }
      },
      stats: () => ({
        looks: looks.size,
        shells: [...looks.values()].reduce((n, l) => n + (l.makeover?.shellCount ?? 0), 0),
        ghosts: [...looks.values()].reduce((n, l) => n + (l.makeover?.ghostCount ?? 0), 0),
        pool: pool && !pool.isDisposed ? pool.stats() : null,
      }),
    }
    offs.push(() => {
      delete w.__sroBerserk
    })
  }

  /**
   * Rank of each other berserk player by distance from the camera's target (0 = nearest): who gets the afterimages and
   * the full outline. Sticky: a player in the near group stays in it until two places past the cap, so a crowd at
   * equal distances does not swap its afterimages and outlines every frame.
   */
  const ranks = new Map<number, number>()
  const near = new Set<number>()
  const rankOthers = (self: number | null) => {
    ranks.clear()
    const cap = berserkTier(settings.get().graphics.preset).afterimageOthers
    const target = ctx.camera.target
    const others: { id: number; d: number }[] = []
    for (const [id, look] of looks) {
      if (id === self || look.ending) continue
      others.push({ id, d: Vector3.DistanceSquared(look.view.root.position, target) })
    }
    others.sort((a, b) => a.d - b.d)
    for (const id of [...near]) if (!looks.has(id)) near.delete(id)
    others.forEach((o, i) => {
      if (i < cap && near.size < cap) near.add(o.id)
      else if (i >= cap + 2) near.delete(o.id)
      ranks.set(o.id, near.has(o.id) ? 0 : cap + i)
    })
  }

  return {
    onMessage(msg) {
      controller.onMessage(msg)
      if (msg.t === 'warp') {
        looks.get(msg.id)?.warped()
        flinches.forget(msg.id)
      }
    },
    onEntityAdded(v) {
      if (v.kind === 'player') controller.added(v.id, v.state)
    },
    onEntityRemoved(v) {
      controller.removed(v.id)
      looks.get(v.id)?.dispose()
      looks.delete(v.id)
      flinches.forget(v.id)
    },
    onCombatHit(msg, index) {
      const self = ctx.selfId()
      if (self === null || msg.attacker !== self) return
      const look = looks.get(self)
      const hit = msg.hits[index]
      if (!look || look.ending || !hit || (hit.outcome !== 'hit' && hit.outcome !== 'crit')) return
      const parts = partsFor(self)
      const now = clock()
      if (parts.hitStop) freeze.freeze(now, HIT_STOP_MS, HIT_STOP_SCALE)
      if (parts.camera) bumps.push(now)
      const target = ctx.view(msg.target)
      const me = ctx.view(self)
      // The server's own knockback (hit.pos) and knock-downs move the target themselves.
      if (!target || !me || target.kind !== 'mob' || target.dead || target.dying || hit.pos || hit.down) return
      const root = target.ride?.actor.root ?? target.actor?.root
      if (!root || root.isDisposed() || Math.hypot(root.position.x, root.position.z) > 0.5) return
      flinches.hit(target.id, root, now, target.root.position.x - me.root.position.x, target.root.position.z - me.root.position.z, hit.outcome === 'crit' ? FLINCH_CRIT_M : FLINCH_M)
    },
    onFrame(now, dt) {
      controller.tick(now)
      gauge.tick(now)
      const t = clock()
      const self = ctx.selfId()
      pool?.beginFrame()
      rankOthers(self)
      for (const [id, look] of looks) {
        const timer = controller.timer(id)
        const f: LookFrame = { now: t, leftMs: timer ? timer.until - now : null, parts: partsFor(id, ranks.get(id) ?? 0) }
        if (!look.update(dt * 1000, f)) looks.delete(id)
      }
      ownFrame(t)
      const p = pool as BerserkPool | null
      if (p && !p.isDisposed) {
        p.endFrame()
        if (p.idle) {
          p.dispose()
          pool = null
        }
      }
    },
    dispose() {
      for (const off of offs) off()
      for (const look of looks.values()) look.dispose()
      looks.clear()
      screen?.dispose()
      screen = null
      if (hitNumbers) berserkHitNumbers((hitNumbers = false))
      nudge.dispose()
      freeze.dispose()
      flinches.dispose()
      pool?.dispose()
      pool = null
      gauge.dispose()
      library?.dispose()
    },
  }
}
