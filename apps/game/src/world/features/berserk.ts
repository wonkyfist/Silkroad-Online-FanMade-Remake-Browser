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
import { AbstractMesh, Quaternion, TransformNode, type AssetContainer, type Node } from '@babylonjs/core'
import { HWAN_MAX, type ClientMessage, type EntityState, type ServerMessage } from '@sro/shared'
import { gameAudio } from '../../audio/index.ts'
import { BerserkGauge, type BerserkTimer } from '../../hud/berserk.ts'
import { actionFailText } from '../../hud/index.ts'
import type { KeyBinding } from '../../hud/keys.ts'
import { t } from '../../i18n/index.ts'
import { characterGender, equipmentLookup } from '../../three/equipment.ts'
import { dummiesFromSidecar, ModelLibrary, type CharacterActor } from '../../three/models.ts'
import type { EntityView } from '../entities.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
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

  dispose(): void {
    this.particles?.dispose()
    for (const m of this.hiddenMeshes) if (!m.isDisposed()) m.isVisible = true
    this.hiddenMeshes.length = 0
    for (const n of this.nodes) if (!n.isDisposed()) n.dispose(false, false)
  }
}

interface LookDeps {
  fx: SystemFx
  hairFor(actor: CharacterActor): Promise<{ asset: { container: AssetContainer; sidecar: Record<string, unknown> | null }; hairMesh: string | null } | null>
  selfId(): number | null
}

/** One berserk player's look: the keep loops, the growth and the hair; `end` fades it out. */
class BerserkLook {
  private loop: FxHandle | null = null
  private hair: HwanHair | null = null
  private hairFor: CharacterActor | null = null
  private hairLoading = false
  private grow = 0
  private endingNow = false
  private disposed = false

  constructor(private readonly deps: LookDeps, readonly view: EntityView, burst: boolean) {
    if (burst) {
      deps.fx.play(HWAN_FX, 'start', view)
      sound(view, 'berserk.start', deps.selfId())
    } else this.grow = 1
    this.loop = deps.fx.play(HWAN_FX, 'loop', view)
  }

  /** Whether the Berserk ended (the look is fading out). */
  get ending(): boolean {
    return this.endingNow || this.disposed
  }

  /** Per frame; false once the end has faded (the owner drops it). */
  update(dtMs: number): boolean {
    if (this.disposed) return false
    const actor = this.view.actor
    this.grow = Math.max(0, Math.min(1, this.grow + ((this.endingNow ? -1 : 1) * dtMs) / HWAN_SCALE_MS))
    if (actor && !actor.isDisposed) actor.root.scaling.setAll(this.view.scale * hwanScale(this.grow))
    if (this.endingNow) {
      if (this.grow > 0) return true
      this.dispose()
      return false
    }
    if (actor && actor !== this.hairFor && !this.hairLoading) this.dress(actor)
    this.hair?.sync()
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

  /** The Berserk ended: the keep loops stop, the hair goes, the scale shrinks back (`fade`: DEACT row and sound). */
  end(fade: boolean): void {
    if (this.endingNow || this.disposed) return
    this.endingNow = true
    this.loop?.stop()
    this.loop = null
    this.hair?.dispose()
    this.hair = null
    if (fade && !this.view.isDisposed) {
      this.deps.fx.play(HWAN_FX, 'end', this.view)
      sound(this.view, 'berserk.end', this.deps.selfId())
    }
    if (!fade) this.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.loop?.stop()
    this.hair?.dispose()
    const actor = this.view.actor
    if (actor && !actor.isDisposed) actor.root.scaling.setAll(this.view.scale)
  }
}

function sound(v: EntityView, cue: string, selfId: number | null): void {
  const audio = gameAudio()
  if (!audio) return
  const self = v.id === selfId
  audio.play(cue, { entity: v.id, self, pos: { x: v.root.position.x, y: v.root.position.y + 1, z: v.root.position.z } })
}

// ---- the feature ---------------------------------------------------------------------------------------------------

export function berserkFeature(ctx: WorldFeatureContext): WorldFeature {
  // A bare context (tests of the feature list) gets nothing.
  if (!ctx.hud || !ctx.app || !ctx.scene) return {}
  const { hud, scene } = ctx
  const offs: (() => void)[] = []
  const looks = new Map<number, BerserkLook>()
  let library: ModelLibrary | null = null
  let fx: SystemFx | null = null
  const systemFx = () => (fx ??= systemFxFor(scene))

  const hairFor: LookDeps['hairFor'] = async actor => {
    if (!/^CHAR_CH_/.test(actor.model.code)) return null
    const lookup = await equipmentLookup()
    const gender = characterGender(actor.model.code, lookup)
    const src = HWAN_HAIR[gender]
    library ??= new ModelLibrary(scene)
    const loaded = await library.load(src.glb, src.sidecar)
    return { asset: loaded, hairMesh: lookup?.characters.get(actor.model.code)?.slots.HAIR ?? null }
  }
  const deps: LookDeps = { get fx() { return systemFx() }, hairFor, selfId: () => ctx.selfId() }

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
      looks.set(id, new BerserkLook(deps, v, burst))
    },
    end: (id, fade) => looks.get(id)?.end(fade),
  })

  hud.claimRequests(['berserk'])
  offs.push(registerBerserkKey(hud.keys, () => void controller.activate()))

  return {
    onMessage(msg) {
      controller.onMessage(msg)
    },
    onEntityAdded(v) {
      if (v.kind === 'player') controller.added(v.id, v.state)
    },
    onEntityRemoved(v) {
      controller.removed(v.id)
      looks.get(v.id)?.dispose()
      looks.delete(v.id)
    },
    onFrame(now, dt) {
      controller.tick(now)
      gauge.tick(now)
      for (const [id, look] of looks) if (!look.update(dt * 1000)) looks.delete(id)
    },
    dispose() {
      for (const off of offs) off()
      for (const look of looks.values()) look.dispose()
      looks.clear()
      gauge.dispose()
      library?.dispose()
    },
  }
}
