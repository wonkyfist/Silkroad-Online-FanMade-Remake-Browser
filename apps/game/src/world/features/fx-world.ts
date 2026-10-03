/**
 * World and system effects (docs/EFFECTS.md §3.5-§3.8, §3.11-§3.12, §6.5), lane FX-C2. A WorldFeature plus the per-view
 * attachments it hangs on every entity:
 *  - level-up: SYSTEM_LEVELUP (`system/system_levelup.efp`, 7.2 s) on the entity, following it;
 *  - consumables: `itemEffect {id, item}` → SYSTEM_HPPOTION / MPPOTION / LIFE by the item's cooldown group (pills: the
 *    cure effect);
 *  - return scroll: SYSTEM_RETURNSCROLL loops on the reader from `itemCast` to `itemCastEnd`; on 'done' the
 *    RETURNSCROLLRESULT flash plays where they stood and SYSTEM_APPEAR where they arrive;
 *  - appear: SYSTEM_APPEAR on yourself when you enter the world and on anyone warping or respawning in view;
 *  - drops: `DropVisual.place` with the spawn's `droppedAt` / `dropFrom` (the toss), held at the corpse until the
 *    victim's death is shown;
 *  - pickup: your own accepted `pickup` plays PICK facing that item when it vanishes near you;
 *  - idle: an IdleDriver per character (NPC idle variants, the combat stance after swings and hits, the seat);
 *  - model particles: the sidecar `particles` of NPC and mob models (the shaman's pipe smoke in STAND2, glows);
 *  - mobs fade in over SPAWN_FADE_MS; Mangnyang and Tombstone swap to their `Die Bsr` model when they die.
 */
import type { ItemDef, ServerMessage, Vec3 } from '@sro/shared'
import { ambientNightSwitch, attachNightLights, type NightLights } from '@sro/world-render'
import { ModelLibrary, type CharacterActor } from '../../three/models.ts'
import { isFreshDrop, type DropVisual } from '../drops.ts'
import type { EntityAttachment, EntityView } from '../entities.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { setHitLightCluster } from '../fx/hit-light.ts'
import { fetchSidecar, ModelParticles, readParticles } from '../fx/model-particles.ts'
import { fxBudget } from '../fx/quality.ts'
import { systemFxFor, viewPose, type FxHandle, type SystemFx } from '../fx/system-fx.ts'
import type { SystemFxKey } from '../fx/types.ts'
import { IdleDriver, idleOf } from '../idle.ts'

/** Mobs fade in over this when they spawn (the retail `monster/system_appear.efp` does not exist: EFFECTS §3.5). */
export const SPAWN_FADE_MS = 400
/** Character models with live ambient particles at once (N100 budget, EFFECTS §6.5). */
export const MAX_AMBIENT_MODELS = 40
/** Two appear effects on one entity closer than this are one (a respawn is a revive plus a warp). */
const APPEAR_DEDUPE_MS = 1500
/** A pickup accepted this long ago still plays PICK when its item vanishes (the walk to it; ms). */
const PICK_WINDOW_MS = 20000
/** The item must vanish this close to you (metres; the server picks up within its PICKUP_RANGE). */
const PICK_REACH_M = 3
/** How long a PICK waits for the character to stand idle (ms). */
const PICK_WAIT_MS = 1500
/** A fresh drop waits at most this long for its victim's death to be shown (ms; lag, a lost combat frame). */
export const DROP_HOLD_MAX_MS = 1500
/** A dying view this close (metres, ground plane) to a fresh drop's `dropFrom` is the victim it waits for. */
const DROP_VICTIM_M = 2.5
/** Pill cure effect (no SYSTEM row; EFFECTS §3.7 our rule). */
export const CURE_EFFECT = 'skill/china/water_cure_effect_a.efp'

/** What a consumable's `itemEffect` plays (EFFECTS §4 "Client mapping"): a SYSTEM row, an effect key, or nothing. */
export function itemEffectOf(def: ItemDef | undefined): { system: SystemFxKey } | { efp: string } | null {
  if (!def) return null
  if (def.cureLevel !== undefined && def.cureLevel !== null) return { efp: CURE_EFFECT }
  // Wave 8 (D52, I8): a Recovery Kit heals the horse; the server's itemEffect names the horse's id.
  if (def.use?.target === 'mount') return { system: 'SYSTEM_COS_HPPOTION' }
  const group = def.use?.cooldownGroup
  if (group === 'hp') return { system: 'SYSTEM_HPPOTION' }
  if (group === 'mp') return { system: 'SYSTEM_MPPOTION' }
  if (group === 'vigor') return { system: 'SYSTEM_LIFE' }
  if (def.use?.hp || def.use?.hpPct) return { system: 'SYSTEM_HPPOTION' }
  if (def.use?.mp || def.use?.mpPct) return { system: 'SYSTEM_MPPOTION' }
  return null
}

/** Mob spawn fade: opacity at `ms` after the model arrived. */
export function spawnFade(ms: number): number {
  return Math.min(1, Math.max(0, ms / SPAWN_FADE_MS))
}

/** The ambient budget re-ranks the models this often (ms), and a model keeps its slot until another is this much nearer (m). */
export const AMBIENT_RANK_MS = 500
export const AMBIENT_HYSTERESIS_M = 4

/**
 * Budget of character models playing ambient particles: at most MAX_AMBIENT_MODELS, and the graphics preset's model cap
 * (`ambientModels`, 0 on Low). G1 rescue: the slots go to the models nearest the camera (re-ranked every
 * AMBIENT_RANK_MS, a slot kept until another model is AMBIENT_HYSTERESIS_M nearer; a stopped glow fades out), no longer
 * to the first to arrive (a Yeoha nest far off kept the slots of the ones beside you). Without a camera: arrival order.
 */
export class AmbientBudget {
  private readonly wanting = new Set<AmbientSlot>()
  private cap = -1
  private next = -Infinity
  /** LAB: the cap override (null: the preset's). */
  capOverride: number | null = null

  constructor(private readonly eye: () => { x: number; y: number; z: number } | null = () => null, private readonly now: () => number = () => performance.now()) {}

  /** Slots right now (world/fx/quality.ts). */
  static cap(): number {
    return Math.min(MAX_AMBIENT_MODELS, fxBudget().ambientModels)
  }

  join(a: AmbientSlot): void {
    this.wanting.add(a)
    this.apply()
  }

  leave(a: AmbientSlot): void {
    if (this.wanting.delete(a)) this.apply()
  }

  /** Re-ranks the models every AMBIENT_RANK_MS, and at once when the preset changed the cap (onFrame). */
  check(): void {
    const cap = this.capOverride ?? AmbientBudget.cap()
    if (cap !== this.cap || this.now() >= this.next) this.apply()
  }

  /** Models playing their glow now (tests, the LAB). */
  get playing(): number {
    let n = 0
    for (const a of this.wanting) if (a.slotted) n++
    return n
  }

  private apply(): void {
    const cap = this.capOverride ?? AmbientBudget.cap()
    this.cap = cap
    this.next = this.now() + AMBIENT_RANK_MS
    const eye = this.eye()
    const list = [...this.wanting]
    if (eye) {
      const score = (a: AmbientSlot) => {
        const p = a.position()
        const d = p ? Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z) : Infinity
        return a.slotted ? d - AMBIENT_HYSTERESIS_M : d
      }
      const scores = new Map(list.map(a => [a, score(a)]))
      list.sort((a, b) => scores.get(a)! - scores.get(b)!)
    }
    let n = 0
    for (const a of list) a.setSlot(n++ < cap)
  }
}

/** What the ambient budget ranks (ParticleAttachment). */
export interface AmbientSlot {
  readonly slotted: boolean
  position(): { x: number; y: number; z: number } | null
  setSlot(on: boolean): void
}

/** Sidecar particles of a character's model, fed by its clip starts (the actor's onClip, chained). */
class ParticleAttachment implements EntityAttachment, AmbientSlot {
  private mp: ModelParticles | null = null
  private slot = false
  private disposed = false

  constructor(private readonly view: EntityView, private readonly fx: SystemFx, private readonly budget: AmbientBudget) {}

  loaded(): void {
    const a = this.view.actor
    const url = a?.model.sidecar
    if (!a || !url) return
    void fetchSidecar(url).then(side => {
      const list = readParticles(side)
      if (this.disposed || !list.length || a.isDisposed) return
      const mp = new ModelParticles(this.fx.runner, list, { root: a.root, joint: n => a.joint(n) }, { ambient: false })
      this.mp = mp
      const prev = a.onClip
      a.onClip = name => {
        prev?.(name)
        mp.onClip(name)
      }
      if (list.some(p => p.kind === 'ambient' && !p.night)) this.budget.join(this)
    })
  }

  get slotted(): boolean {
    return this.slot
  }

  position(): { x: number; y: number; z: number } | null {
    return this.disposed || this.view.isDisposed ? null : this.view.pos
  }

  /** The budget gives or takes this model's ambient slot. */
  setSlot(on: boolean): void {
    if (on === this.slot || this.disposed) return
    this.slot = on
    if (on) this.mp?.startAmbient()
    else this.mp?.stopAmbient()
  }

  update(_now: number, dt: number): void {
    this.mp?.update(dt * 1000)
  }

  dispose(): void {
    this.disposed = true
    this.mp?.dispose()
    this.mp = null
    this.slot = false
    this.budget.leave(this)
  }
}

/** Mob extras: the spawn fade-in, and the Die Bsr swap at death (Mangnyang, Tombstone). */
class MobAttachment implements EntityAttachment {
  private fadeMs: number | null = null
  private dieActor: CharacterActor | null = null
  private swapping = false
  /** Arrived as a corpse: its death model lies down at once. */
  private deadAtLoad = false
  private disposed = false

  constructor(private readonly view: EntityView, private readonly fx: SystemFx, private readonly library: () => ModelLibrary) {}

  loaded(): void {
    const v = this.view
    if (!v.actor) return
    this.deadAtLoad = v.dead
    if (!v.dead) {
      this.fadeMs = 0
      v.actor.setOpacity(0)
    }
    // Preload the death model so the swap is instant.
    void this.fx.ready().then(() => {
      const m = this.fx.character(v.state.model)?.dieModel
      if (m && !this.disposed) void this.library().load(m.glb, m.sidecar).catch(() => {})
    })
  }

  update(_now: number, dt: number): void {
    const v = this.view
    if (this.fadeMs !== null && v.actor) {
      this.fadeMs += dt * 1000
      const k = spawnFade(this.fadeMs)
      if (!v.fading) v.actor.setOpacity(k * (v.state.invisible ? 0.4 : 1))
      if (k >= 1) this.fadeMs = null
    }
    if (v.dead && !this.swapping && v.actor) this.swap()
    if (this.dieActor && v.actor) {
      // Follow the view's fade-out (applyOpacity writes the original model's meshes).
      const alpha = v.actor.meshes[0]?.visibility ?? 1
      this.dieActor.setOpacity(alpha)
    }
  }

  private swap(): void {
    this.swapping = true
    const v = this.view
    const m = this.fx.character(v.state.model)?.dieModel
    if (!m) return
    const instant = this.deadAtLoad || v.fading
    void this.library().character({ code: `DIE:${v.state.model}`, glb: m.glb, sidecar: m.sidecar }).then(actor => {
      if (this.disposed || v.isDisposed || !v.actor) return actor.dispose()
      this.dieActor = actor
      actor.root.parent = v.root
      actor.root.scaling.setAll(v.scale)
      actor.setYaw(v.yaw)
      actor.play('STAND1')
      actor.die(instant)
      v.actor.setEnabled(false)
    }, err => console.warn('[fx] die model failed', m.glb, err))
  }

  dispose(): void {
    this.disposed = true
    this.dieActor?.dispose()
    this.dieActor = null
  }
}

/** A fresh drop held at the corpse of a victim whose death is not shown yet (world.ts marks it `dying`). */
interface HeldDrop {
  drop: DropVisual
  victim: EntityView
  waitedMs: number
}

/**
 * Items: place the drop (toss when fresh) once its view has loaded. The server spawns a kill's loot in the kill tick,
 * but the client shows the killing blow later (at the attack clip's hit event, or when the arrow lands): a fresh drop
 * thrown from a victim still `dying` is held, hidden, until that death is shown (DROP_HOLD_MAX_MS at most).
 */
class DropAttachment implements EntityAttachment {
  constructor(private readonly view: EntityView, private readonly now: () => number, private readonly hold: (from: Vec3, drop: DropVisual) => boolean) {}

  loaded(): void {
    const s = this.view.state
    const drop = this.view.drop
    if (!drop) return
    const now = this.now()
    const held = !!s.dropFrom && isFreshDrop(s.droppedAt, now) && this.hold(s.dropFrom, drop)
    drop.place({ id: s.id, now, ...(s.droppedAt !== undefined ? { droppedAt: s.droppedAt } : {}), ...(s.dropFrom ? { from: s.dropFrom } : {}), at: s.pos, ...(held ? { hold: true } : {}) })
  }

  dispose(): void {}
}

export function fxWorldFeature(ctx: WorldFeatureContext): WorldFeature {
  const fx = systemFxFor(ctx.scene)
  const budget = new AmbientBudget(() => (ctx.camera as typeof ctx.camera | undefined)?.globalPosition ?? null)
  // LAB (G1 rescue): the console handle for the ambient model budget A/B (`__sroAmbient.capOverride`, `.playing`).
  if (typeof window !== 'undefined') (window as unknown as { __sroAmbient?: AmbientBudget }).__sroAmbient = budget
  let dieLibrary: ModelLibrary | null = null
  const library = () => (dieLibrary ??= new ModelLibrary(ctx.scene))
  /** Return-scroll loops by reader id. */
  const reading = new Map<number, FxHandle>()
  /** Readers whose cast just finished (they warp next): the arrival plays SYSTEM_APPEAR. */
  const returning = new Set<number>()
  const lastAppear = new Map<number, number>()
  /** Items in view (for facing the one you picked up). */
  const items = new Map<number, Vec3>()
  let appearSelf = false
  /** Your last accepted pickup (performance.now, and its item): that item vanishing near you then plays PICK. */
  let pickAt = -Infinity
  let pickId: number | null = null

  const itemGone = (id: number) => {
    const at = items.get(id)
    items.delete(id)
    if (id !== pickId) return
    const selfId = ctx.selfId()
    const self = selfId === null ? undefined : ctx.view(selfId)
    if (!at || !self || self.dead || performance.now() - pickAt > PICK_WINDOW_MS) return
    if (Math.hypot(at[0] - self.pos.x, at[2] - self.pos.z) > PICK_REACH_M) return
    pickAt = -Infinity
    pickId = null
    self.face(at[0], at[2])
    // The pickup often lands as the walk (or a swing) ends: bend down as soon as the character stands idle.
    bend = { until: performance.now() + PICK_WAIT_MS }
    tryBend()
  }

  let bend: { until: number } | null = null
  const tryBend = () => {
    if (!bend) return
    const selfId = ctx.selfId()
    const self = selfId === null ? undefined : ctx.view(selfId)
    if (!self || self.dead || performance.now() > bend.until) {
      bend = null
      return
    }
    if (!self.moving && self.actor?.playOverlay('PICK')) bend = null
  }

  const appear = (v: EntityView | undefined) => {
    if (!v || v.dead) return
    const now = performance.now()
    if (now - (lastAppear.get(v.id) ?? -Infinity) < APPEAR_DEDUPE_MS) return
    lastAppear.set(v.id, now)
    fx.play('SYSTEM_APPEAR', 'start', v)
  }

  /** Fresh drops waiting for their victim's death to be shown. */
  let held: HeldDrop[] = []
  const holdDrop = (from: Vec3, drop: DropVisual): boolean => {
    let victim: EntityView | null = null
    let best = DROP_VICTIM_M
    for (const v of ctx.views()) {
      if (!v.dying || v.dead || v.kind === 'item') continue
      const d = Math.hypot(v.pos.x - from[0], v.pos.z - from[2])
      if (d <= best) {
        best = d
        victim = v
      }
    }
    if (!victim) return false
    held.push({ drop, victim, waitedMs: 0 })
    return true
  }
  /** Releases the held drops whose victim's death is shown (killView clears `dying`), gone, or waited too long. */
  const releaseDrops = (dt: number) => {
    if (!held.length) return
    held = held.filter(h => {
      h.waitedMs += dt * 1000
      if (h.victim.dying && !h.victim.dead && !h.victim.isDisposed && h.waitedMs < DROP_HOLD_MAX_MS) return true
      h.drop.release()
      return false
    })
  }

  const offs = [
    ctx.addAttachment(v => {
      if (v.kind === 'item') return new DropAttachment(v, () => ctx.serverNow(), holdDrop)
      return null
    }),
    ctx.addAttachment(v => (v.kind === 'item' ? null : new IdleDriver(v))),
    ctx.addAttachment(v => (v.kind === 'npc' || v.kind === 'mob' ? new ParticleAttachment(v, fx, budget) : null)),
    ctx.addAttachment(v => (v.kind === 'mob' ? new MobAttachment(v, fx, library) : null)),
    ctx.addAttachment(v => {
      // Your own arrival: SYSTEM_APPEAR once your model is in.
      if (!v.isSelf) return null
      return {
        loaded: () => {
          if (appearSelf) {
            appearSelf = false
            appear(v)
          }
        },
        dispose() {},
      }
    }),
  ]

  const stance = (id: number) => {
    const v = ctx.view(id)
    if (v && v.kind !== 'item') idleOf(v)?.combat()
  }

  /** The world whose objects play their ambient effects (torches, lamps, the blacksmith's smoke). */
  let ambientWorld: unknown = null
  /** The ambient budget it was enabled with (Options → Graphics → preset; world/fx/quality.ts). */
  let ambientMax = -1
  /**
   * Wave 9 NL (docs/WAVE_PLAN3.md §6.7): the world's night lights (lamp splat, point lights, lamp glow), and the
   * night-only ambient effects' switch from SkyState.night with hysteresis (on above 0.6, off below 0.4; SKY §7.2).
   */
  let nightLights: NightLights | null = null
  let nightWorld: unknown = null
  let ambientNight = false

  return {
    onFrame(_now: number, dt: number) {
      tryBend()
      releaseDrops(dt)
      budget.check()
      const ground = ctx.world()
      if (!ground) return
      if (nightWorld !== ground) {
        nightWorld = ground
        nightLights?.dispose()
        nightLights = null
        try {
          nightLights = attachNightLights(ground.world, { focus: () => ctx.camera.target })
          setHitLightCluster(nightLights) // GAME: the hit flashes join its cluster on the PBR presets (fx/hit-light.ts)
          // `window.__sroNight` (console, LAB): the handle; `.host` is the World (setTimeOfDay, render.quality).
          if (typeof window !== 'undefined') (window as unknown as { __sroNight?: NightLights }).__sroNight = nightLights
        } catch (err) {
          console.warn('[fx] night lights failed', err)
        }
      }
      ambientNight = ambientNightSwitch(ambientNight, ground.world.skyState?.night ?? 0)
      const objects = ground.world.objects
      const max = fxBudget().ambientMax
      if (ambientWorld !== ground || max !== ambientMax) {
        ambientWorld = ground
        ambientMax = max
        void objects.enableAmbient(max > 0 ? (key, position, rotation) => fx.runner.play(key, { pose: () => ({ position, rotation }), loop: true }) : null, { max })
      }
      const ambient = objects.ambientFx
      if (!ambient) return
      ambient.setNight(ambientNight)
      ambient.update(ctx.camera.target)
    },
    onMessage(msg: ServerMessage) {
      switch (msg.t) {
        case 'worldEnter':
          appearSelf = true
          for (const h of reading.values()) h.stop()
          reading.clear()
          returning.clear()
          break
        case 'levelUp': {
          const v = ctx.view(msg.id)
          if (v) fx.play('SYSTEM_LEVELUP', 'start', v)
          break
        }
        case 'itemEffect': {
          const v = ctx.view(msg.id)
          const what = itemEffectOf(ctx.app.catalog.item(msg.item))
          if (!v || !what) break
          if ('system' in what) fx.play(what.system, 'start', v)
          else fx.runner.play(what.efp, { pose: viewPose(v, null) })
          break
        }
        case 'itemCast': {
          const v = ctx.view(msg.id)
          if (!v || !ctx.app.catalog.item(msg.item)?.use?.returnToTown) break
          reading.get(msg.id)?.stop()
          reading.set(msg.id, fx.play('SYSTEM_RETURNSCROLL', 'start', v))
          break
        }
        case 'itemCastEnd': {
          reading.get(msg.id)?.stop()
          reading.delete(msg.id)
          const v = ctx.view(msg.id)
          if (msg.reason === 'done' && v && ctx.app.catalog.item(msg.item)?.use?.returnToTown) {
            // Where they stood, before the warp that follows.
            const y = v.root.position.y
            fx.playAt('SYSTEM_RETURNSCROLLRESULT', 'start', { pos: [v.pos.x, y, v.pos.z], yaw: v.yaw }, { once: true })
            returning.add(msg.id)
          }
          break
        }
        case 'warp': {
          // world.ts moved the view already: the arrival.
          const v = ctx.view(msg.id)
          if (returning.delete(msg.id) || v?.isSelf || v?.kind === 'player') appear(v)
          break
        }
        case 'entityUpdate':
          if (msg.state === 'alive') {
            const v = ctx.view(msg.id)
            if (v?.kind === 'player') appear(v)
          }
          break
        case 'combat':
          stance(msg.attacker)
          stance(msg.target)
          break
        case 'despawn':
          itemGone(msg.id)
          break
        case 'actionResult':
          if (msg.re === 'pickup' && msg.ok) {
            pickAt = performance.now()
            pickId = ctx.acceptedPickup()
          }
          break
      }
    },
    onEntityAdded(v) {
      if (v.kind === 'item') items.set(v.id, v.state.pos)
    },
    onEntityRemoved(v) {
      if (v.kind === 'item') itemGone(v.id)
      reading.get(v.id)?.stop()
      reading.delete(v.id)
    },
    dispose() {
      for (const off of offs) off()
      for (const h of reading.values()) h.stop()
      reading.clear()
      for (const h of held) h.drop.release()
      held = []
      dieLibrary?.dispose()
      void ctx.world()?.world.objects.enableAmbient(null)
      setHitLightCluster(null)
      // W9F LEAK-3: the console handle would keep this visit's World (`.host`) alive at character select.
      const w = typeof window === 'undefined' ? null : (window as unknown as { __sroNight?: NightLights })
      if (w && nightLights && w.__sroNight === nightLights) delete w.__sroNight
      const wa = w as { __sroAmbient?: AmbientBudget } | null
      if (wa && wa.__sroAmbient === budget) delete wa.__sroAmbient
      nightLights?.dispose()
      nightLights = null
      nightWorld = null
      dieLibrary = null
    },
  }
}
