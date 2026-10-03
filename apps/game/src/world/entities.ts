/**
 * Client-side view of server entities (players, mobs, NPCs, ground items): authoritative state from the
 * server, interpolated along MoveState with the server clock, drawn with CharacterActors (or drop markers /
 * placeholders) and DOM labels. Ground height always comes from WorldGround.heightAt via the context.
 */
import { Color3, CreateBox, CreateCapsule, CreateCylinder, Matrix, StandardMaterial, TransformNode, Vector3, type Mesh, type Scene } from '@babylonjs/core'
import { heightScale } from '@sro/appearance'
import { JUMP_LATE_DROP_MS, type EntityState, type EquipSlot, type MoveState, type StarterWeapon, type Vec3 } from '@sro/shared'
import { weaponFamilyOf, type Catalog } from '../content/catalog.ts'
import { t, type StringKey } from '../i18n/index.ts'
import { sampleMove } from '../net/clock.ts'
import type { BaseClip, CharacterActor, DeathClip, Look, ModelLibrary } from '../three/models.ts'
import { toScreen } from '../three/project.ts'
import { el } from '../ui/dom.ts'
import type { DropAssets } from './drops.ts'
import { DropVisual } from './drops.ts'
import type { IdleKind } from './fx/types.ts'
import { LEVEL_BANDS, levelBand } from './level-band.ts'
import { loadRide, type RideMob } from './ride-mob.ts'

/** Above this speed (m/s) the RUN clip plays, below it WALK. */
const RUN_THRESHOLD = 3.2
const TURN_RATE = 12
/** Idle-only actions a move cuts short (the body runs at once instead of gliding in a seated / emote / fidget pose). */
const MOVE_CANCELS = /^(SIT_DOWN|STAND_UP|EMOTION\d+|PICK|STAND[234]|TURN_[LR])(_|$)/
const cancelledByMove = (name: string) => MOVE_CANCELS.test(name)
/** Wave 10 (docs/MOVEMENT.md §6.2): the running jumps; a `stop` after their landing hands back the idle at once. */
const JUMP_RUN_CLIP = /^JUMP_RUN(_|$)/
/** Opacity of an invisible GM, as seen by itself and other GMs. */
const GHOST_ALPHA = 0.4
/** The hover tint of a mob (other kinds take the default warm highlight). */
export const MOB_HIGHLIGHT: Readonly<Color3> = new Color3(1, 0.55, 0.45)
/** Seconds a despawned corpse takes to fade out. */
const FADE_S = 0.9
/** Labels further than this from the camera target are hidden (metres). */
const LABEL_RANGE: Record<EntityState['kind'], number> = { player: 60, npc: 40, mob: 40, item: 22, cos: 40 }
/** Base clip of each idle kind (docs/WAVE_PLAN2.md D7); CharacterActor.clipFor falls back (VENDOR01 -> SIT -> STAND1). */
const IDLE_CLIP: Record<IdleKind, BaseClip> = { stand: 'STAND1', combat: 'ATTREADY', sit: 'SIT', vendor: 'VENDOR01' }
const seated = (k: IdleKind): boolean => k === 'sit' || k === 'vendor'

/** Options of EntityView.attack: `clip` = a named clip (e.g. a mob skill's 'ATTACK2') instead of the basic-attack cycle. */
export interface AttackOptions {
  clip?: string
}

/**
 * Something a lane hangs on every view (docs/WAVE_PLAN.md decision 18): clip sounds, effect loops, quest marks.
 * Created by the view's constructor from `EntityContext.attachments`; `loaded` runs once the model (or its
 * placeholder) is in, `update` every frame with server time and dt in seconds, `dispose` with the view.
 */
export interface EntityAttachment {
  loaded?(): void
  update?(now: number, dt: number): void
  dispose(): void
}

export type EntityAttachmentFactory = (v: EntityView) => EntityAttachment | null

export interface EntityContext {
  scene: Scene
  library: ModelLibrary
  catalog: Catalog
  labels: HTMLElement
  drops: DropAssets
  heightAt(x: number, z: number): number
  selfId(): number
  selfLevel(): number
  serverNow(): number
  /** Per-view attachment factories (read when each view is created). */
  attachments: readonly EntityAttachmentFactory[]
}

function angleLerp(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}

/** Display text of a ground item: "123 Gold", "HP Recovery Herb x3", "Iron Blade +2". */
export function itemLabel(state: EntityState, name: string): string {
  if (/^ITEM_ETC_GOLD_/.test(state.model)) return t('world.label.gold', { amount: state.count ?? 0 })
  let s = name
  if (state.plus) s = t('world.label.plus', { name: s, plus: state.plus })
  if ((state.count ?? 1) > 1) s = t('world.label.stack', { name: s, count: state.count! })
  return s
}

let serial = 0

export class EntityView {
  state: EntityState
  move: MoveState | undefined
  readonly pos = new Vector3()
  yaw: number
  targetYaw: number
  moving = false
  readonly root: TransformNode
  actor: CharacterActor | null = null
  /**
   * Wave 11 (docs/UNIQUES.md §2.3): the ridden mob's ride (Tiger Girl's Blue Tiger; world/ride-mob.ts), null = none.
   * `actor` stays the rider (the clip leader); the ride's root takes her root's place: it is turned and scaled.
   */
  ride: RideMob | null = null
  placeholder: Mesh | null = null
  drop: DropVisual | null = null
  /** Invisible pick proxy (metadata.entityId); disabled for yourself, corpses and fading entities. */
  readonly pick: Mesh
  /** Second proxy over an NPC model reaching well past `pick` (Storage-keeper Wangu's chest), turned with the model. */
  private pickModel: Mesh | null = null
  readonly label: HTMLElement
  private readonly nameEl: HTMLElement
  private readonly levelEl: HTMLElement
  private readonly hpEl: HTMLElement
  private readonly hpFill: HTMLElement
  /** Death shown (DIE1 played). */
  dead = false
  /** A killing blow is on its way (combat.killed): the death is shown with the last hit, not before. */
  dying = false
  private fadeLeft: number | null = null
  private lastAttackAt = 0
  private disposed = false
  private hovered = false
  private readonly badges = new Map<string, HTMLElement>()
  private readonly attached: EntityAttachment[] = []
  /** What the model plays while standing still (setIdle). */
  private idleKind: IdleKind = 'stand'
  scale = 1
  radius = 0.4
  /**
   * Wave 10 (docs/MOVEMENT.md §6.2, fact-check 2): a move cuts the idle actions short, and a standing JUMP too while it
   * is on the ground (before its take-off or after its landing); in the air it plays out over the slide. JUMP_RUN is
   * never cut by a move (it carries its own running legs).
   */
  private readonly moveCancels = (name: string): boolean =>
    cancelledByMove(name) || (name === 'JUMP' && !this.jumpedMoving && this.actor?.movePhase() !== 'air')
  /** The last jump started while moving (a standing JUMP over a walk, MOVEMENT Q1): a move does not cut that one. */
  private jumpedMoving = false
  /** A running jump whose runner stopped: cut to the idle once it has landed (no running in place, §6.2). */
  private readonly stopCancels = (name: string): boolean => JUMP_RUN_CLIP.test(name) && this.actor?.movePhase() === 'after'

  constructor(state: EntityState, private readonly ctx: EntityContext) {
    this.state = state
    this.move = state.move
    this.pos.set(state.pos[0], state.pos[1], state.pos[2])
    this.yaw = this.targetYaw = state.yaw
    const id = ++serial
    this.root = new TransformNode(`entity${id}:${state.id}`, ctx.scene)
    this.nameEl = el('span', 'name')
    this.levelEl = el('span', 'level')
    this.hpFill = el('i')
    this.hpEl = el('div', 'hp', this.hpFill)
    this.label = el('div', `entity-label kind-${state.kind}${this.isSelf ? ' self' : ''}`, this.nameEl, this.levelEl, this.hpEl)
    this.label.classList.toggle('ghost', !!state.invisible)
    ctx.labels.append(this.label)
    if (state.kind === 'mob') {
      const mob = ctx.catalog.mob(state.model)
      this.scale = mob.scale
      this.radius = mob.radius
    } else if (state.kind === 'item') {
      this.radius = 0.35
    } else if (state.kind === 'player') {
      // Height choice: uniform scale of the body and everything worn (docs/CHARACTER_SCALE.md).
      this.scale = heightScale(state.height)
    }
    this.pick = CreateCylinder(`pick${id}`, { height: 1, diameter: 1, tessellation: 10 }, ctx.scene)
    this.pick.bakeTransformIntoVertices(Matrix.Translation(0, 0.5, 0))
    this.pick.parent = this.root
    this.pick.isVisible = false
    // G1 rescue: `sroPickOnly`: never drawn, so not an active-mesh candidate (world-render EnabledMeshCandidates);
    // scene.pick computes its world matrix itself.
    this.pick.metadata = { entityId: state.id, sroPickOnly: true }
    this.sizePick()
    this.dead = state.state === 'dead'
    this.refreshLabel()
    for (const make of ctx.attachments) {
      try {
        const a = make(this)
        if (a) this.attached.push(a)
      } catch (err) {
        console.error('[world] entity attachment failed', err)
      }
    }
  }

  /** Runs `fn` on every attachment, isolating a lane's failure from the others and from the view. */
  private eachAttachment(fn: (a: EntityAttachment) => void): void {
    for (const a of this.attached) {
      try {
        fn(a)
      } catch (err) {
        console.error('[world] entity attachment failed', err)
      }
    }
  }

  /** Adds or removes a class on the name label (band colours, party, quest states); refreshLabel keeps it. */
  setLabelClass(cls: string, on: boolean): void {
    this.label.classList.toggle(cls, on)
    // G1 rescue (world/crowd-budget.ts): the party feature tags its members' name tags; they keep full quality.
    if (cls === 'party') this.partyMate = on
  }

  /** A member of the viewer's party (the party feature's name-tag class; never the own character). */
  partyMate = false

  /**
   * One badge span per `key`, placed before the name (`[GM]`, quest marks, party). `text` null removes it.
   * The span has the classes `badge badge-<key>` plus `cls`.
   */
  setBadge(key: string, text: string | null, cls?: string): void {
    let b = this.badges.get(key)
    if (text === null) {
      b?.remove()
      this.badges.delete(key)
      return
    }
    if (!b) {
      b = el('span', '')
      this.badges.set(key, b)
      this.label.insertBefore(b, this.nameEl)
    }
    b.className = `badge badge-${key}${cls ? ` ${cls}` : ''}`
    b.textContent = text
  }

  get id(): number {
    return this.state.id
  }

  get kind(): EntityState['kind'] {
    return this.state.kind
  }

  get isSelf(): boolean {
    return this.state.id === this.ctx.selfId()
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get fading(): boolean {
    return this.fadeLeft !== null
  }

  /** Can be clicked: not yourself, not a corpse, not on its way out. */
  get selectable(): boolean {
    return !this.isSelf && !this.dead && !this.dying && !this.fading && !this.disposed
  }

  get hp(): number {
    return this.state.hp ?? 0
  }

  get maxHp(): number {
    return this.state.maxHp ?? 0
  }

  /** Model height in metres (after scale). */
  get height(): number {
    if (this.kind === 'item') return 0.5
    return (this.actor?.height ?? 1.8) * this.scale
  }

  /** Camera follow target above the feet (metres): 1.5 m scaled by the Height choice for players. */
  get focusHeight(): number {
    return this.kind === 'player' ? 1.5 * this.scale : 1.5
  }

  /** Where damage numbers and labels sit: just above the head. */
  head(out: Vector3): Vector3 {
    return out.set(this.pos.x, this.ctx.heightAt(this.pos.x, this.pos.z) + this.height + 0.2, this.pos.z)
  }

  displayName(): string {
    const s = this.state
    if (s.kind === 'item') return itemLabel(s, this.ctx.catalog.item(s.model)?.name ?? s.name)
    if (s.kind === 'mob' && s.variant && s.variant !== 'normal') return t('world.label.variant', { name: s.name, variant: t(`world.variant.${s.variant}` as StringKey) })
    return s.name
  }

  private sizePick(): void {
    // Characters get a generous proxy (1.2 m wide) so a zoomed-out click on the figure still lands.
    const d = Math.max(this.kind === 'item' ? 0.8 : 1.2, this.radius * 2)
    this.pick.scaling.set(d, this.kind === 'item' ? 0.6 : Math.max(0.8, this.height), d)
    this.pick.setEnabled(this.selectable)
    this.pickModel?.setEnabled(this.selectable)
  }

  /** An NPC whose bind pose reaches over 1 m from its feet gets a box proxy over that footprint (clicking the chest). */
  private fitModelPick(actor: CharacterActor): void {
    this.pickModel?.dispose()
    this.pickModel = null
    const f = actor.footprint
    if (this.kind !== 'npc' || !(Math.max(-f.minX, f.maxX, -f.minZ, f.maxZ) > 1)) return
    const box = CreateBox(`pickm${this.id}`, { width: f.maxX - f.minX, depth: f.maxZ - f.minZ, height: Math.max(0.8, f.maxY) }, this.ctx.scene)
    box.position.set((f.minX + f.maxX) / 2, Math.max(0.8, f.maxY) / 2, (f.minZ + f.maxZ) / 2)
    box.parent = actor.root
    box.isVisible = false
    box.metadata = { entityId: this.id, sroPickOnly: true }
    this.pickModel = box
  }

  refreshLabel(): void {
    const s = this.state
    this.nameEl.textContent = this.displayName()
    this.levelEl.textContent = s.kind === 'player' || s.kind === 'mob' ? ` ${t('world.level', { level: s.level })}` : ''
    // Mob name colour by level difference (docs/UX_GAPS.md §4.2): band-weak2 .. band-strong2.
    const band = s.kind === 'mob' ? levelBand(s.level, this.ctx.selfLevel()) : null
    for (const b of LEVEL_BANDS) this.label.classList.toggle(`band-${b}`, b === band)
    this.label.classList.toggle('dead', this.dead)
    this.label.classList.toggle('unique', s.kind === 'mob' && (s.variant === 'unique' || this.ctx.catalog.content.mobs.get(s.model)?.rarity === 'unique'))
    this.refreshHp()
  }

  private refreshHp(): void {
    const show = this.kind === 'mob' && !this.dead && this.maxHp > 0 && this.hp < this.maxHp
    this.hpEl.hidden = !show
    if (show) this.hpFill.style.width = `${Math.max(0, Math.min(100, (100 * this.hp) / this.maxHp)).toFixed(1)}%`
  }

  setMove(move: MoveState): void {
    this.move = move
  }

  stop(pos: Vec3, yaw: number): void {
    this.move = undefined
    this.pos.set(pos[0], pos[1], pos[2])
    this.targetYaw = yaw
  }

  /** Warp (teleport, summon, respawn): snap to `pos` and `yaw`, dropping any move in progress. */
  warp(pos: Vec3, yaw: number): void {
    this.move = undefined
    this.moving = false
    this.pos.set(pos[0], pos[1], pos[2])
    this.yaw = this.targetYaw = yaw
  }

  /** Turns towards a world point (combat facing). */
  face(x: number, z: number): void {
    const dx = x - this.pos.x
    const dz = z - this.pos.z
    if (dx * dx + dz * dz > 1e-4) this.targetYaw = Math.atan2(dx, dz)
  }

  setLevel(level: number): void {
    this.state.level = level
    this.refreshLabel()
  }

  setName(name: string): void {
    this.state.name = name
    this.refreshLabel()
  }

  setHp(hp: number, maxHp?: number): void {
    this.state.hp = hp
    if (maxHp !== undefined) this.state.maxHp = maxHp
    this.refreshHp()
  }

  /** Invisible GMs reach only GM viewers (and themselves); they are drawn faded. */
  setInvisible(on: boolean): void {
    this.state.invisible = on || undefined
    this.label.classList.toggle('ghost', on)
    this.applyOpacity()
  }

  setHover(on: boolean): void {
    if (on === this.hovered) return
    this.hovered = on
    this.label.classList.toggle('hover', on)
    this.actor?.setHighlight(on, this.highlightColor())
    this.drop?.setHighlight(on)
  }

  /** The hover tint of this entity (W9F R3: the same for a hover and for a model that loads while hovered). */
  private highlightColor(): Readonly<Color3> | undefined {
    return this.kind === 'mob' ? MOB_HIGHLIGHT : undefined
  }

  private applyOpacity(): void {
    let a = this.state.invisible ? GHOST_ALPHA : 1
    if (this.fadeLeft !== null) a *= Math.max(0, this.fadeLeft / FADE_S)
    this.actor?.setOpacity(a)
    if (this.placeholder) this.placeholder.visibility = a
    if (this.fadeLeft !== null) this.label.style.opacity = String(a)
  }

  /** How this player is drawn: worn items, weapon family (clips), Height and Volume. */
  look(): Look {
    const family = this.weaponFamily()
    return {
      equip: this.state.equip,
      family,
      fallbackWeapon: family ? this.ctx.catalog.weapon(family) : undefined,
      height: this.state.height,
      volume: this.state.volume,
    }
  }

  /** Visible equipment changed (appearance): re-dresses the model (armour, weapon, weapon clips). */
  async setEquip(equip: Partial<Record<EquipSlot, string>>): Promise<void> {
    this.state.equip = equip
    if (!this.actor) return
    await this.ctx.library.dress(this.actor, this.look()).catch((err: unknown) => console.warn('[world] re-dress failed', err))
  }

  /** Height/Volume changed: rescales the model (label and pick follow) and re-applies the build. */
  async setBody(height: number | undefined, volume: number | undefined): Promise<void> {
    this.state.height = height
    this.state.volume = volume
    if (this.kind !== 'player') return
    this.scale = heightScale(height)
    this.bodyRoot()?.scaling.setAll(this.scale)
    this.sizePick()
    if (this.actor) await this.ctx.library.dress(this.actor, this.look()).catch((err: unknown) => console.warn('[world] re-dress failed', err))
  }

  private weaponFamily(): StarterWeapon | undefined {
    const equip = this.state.equip
    if (equip) return equip.weapon ? weaponFamilyOf(equip.weapon, this.ctx.catalog.item(equip.weapon)) : undefined
    return this.state.weapon
  }

  /** The current idle kind (setIdle). */
  get idle(): IdleKind {
    return this.idleKind
  }

  /**
   * What the model plays while standing still (docs/WAVE_PLAN2.md D7): 'stand' STAND1, 'combat' the family's ATTREADY,
   * 'sit' SIT, 'vendor' VENDOR01 (SIT when the actor lacks it). With `transition: 'play'` (and not moving) sitting down
   * plays SIT_DOWN first and getting up STAND_UP; without it the idle switches at once. Callers resolve several
   * reasons with `pickIdle` (fx/types.ts: vendor > sit > combat > stand).
   */
  setIdle(kind: IdleKind, transition?: 'play'): void {
    if (kind === this.idleKind) return
    const prev = this.idleKind
    this.idleKind = kind
    const a = this.actor
    if (!a || this.dead || this.moving) return
    a.play(IDLE_CLIP[kind], true)
    if (transition !== 'play') return
    if (seated(kind) && !seated(prev)) a.playClip('SIT_DOWN')
    else if (!seated(kind) && seated(prev)) a.playClip('STAND_UP')
  }

  /**
   * Plays the next basic-attack clip (or `opts.clip` when the actor has it) facing `target` and returns when (ms from
   * now) each of `hits` hits lands: hit i at the clip's i-th type-1 event (docs/PROTOCOL.md section 3), scaled by the
   * playback speed.
   */
  attack(target: EntityView | undefined, hits: number, nowMs: number, opts?: AttackOptions): number[] {
    if (target) this.face(target.pos.x, target.pos.z)
    const named = opts?.clip ? this.actor?.group(opts.clip) : undefined
    const clip = this.dead ? undefined : named ?? this.actor?.nextAttackClip()
    if (!this.actor || !clip) return Array.from({ length: hits }, (_, i) => 200 + i * 180)
    const info = this.actor.clips.get(clip.name)
    const dur = info?.durationMs ?? 800
    const since = nowMs - this.lastAttackAt
    // Swings faster than the clip (fast weapons, lag bursts) speed the clip up instead of cutting it.
    const speed = this.lastAttackAt && since < dur ? Math.min(2.5, Math.max(1, (dur / Math.max(1, since)) * 1.05)) : 1
    this.lastAttackAt = nowMs
    this.actor.playAction(clip, speed)
    const ev = info?.hits ?? []
    const out: number[] = []
    for (let i = 0; i < hits; i++) {
      const at = ev[i] ?? (ev.length ? ev[ev.length - 1]! + (i - ev.length + 1) * 140 : dur * 0.4 + i * 140)
      out.push(at / speed)
    }
    return out
  }

  hurt(): void {
    if (!this.dead) this.actor?.hurt()
  }

  /**
   * Wave 10 (docs/MOVEMENT.md §6.2, jump only): the server's `jump` for this entity (`at` in server ms, `now` the
   * server time). The jump plays only when the actor has its movement clips (the pack the movement feature loads after
   * worldEnter); without them nothing plays and nothing throws. A jump that arrives more than JUMP_LATE_DROP_MS late
   * plays nothing; otherwise the clip seeks by the latency (≤ JUMP_MAX_SEEK_MS, sharing that budget with the JUMP_RUN
   * phase seek: CharacterActor.playMove). JUMP_RUN when this viewer draws the entity running, JUMP otherwise.
   * False when nothing played.
   */
  jump(at: number, now: number): boolean {
    const a = this.actor
    if (!a || this.dead || !a.hasMovementClips) return false
    if (!(now - at <= JUMP_LATE_DROP_MS)) return false
    this.jumpedMoving = this.moving
    return a.playMove('jump', { at, now })
  }

  /** Shows the death: `clip` DOWN_DIE for a knocked-down victim (default DIE1), then the DIE1_RM rest (CharacterActor.die). */
  die(instant = false, clip?: DeathClip): void {
    this.dying = false
    if (this.dead && !instant) return
    this.dead = true
    this.state.state = 'dead'
    this.state.hp = 0
    this.move = undefined
    this.moving = false
    this.actor?.die(instant, clip)
    if (this.placeholder) this.placeholder.rotation.z = Math.PI / 2
    this.sizePick()
    this.refreshLabel()
  }

  revive(): void {
    this.dying = false
    if (!this.dead) return
    this.dead = false
    this.state.state = 'alive'
    this.actor?.revive()
    if (this.placeholder) this.placeholder.rotation.z = 0
    this.sizePick()
    this.refreshLabel()
  }

  /** Despawned corpse: fade out, then the owner disposes it (update() returns false). */
  beginFade(): void {
    if (this.fadeLeft !== null) return
    this.fadeLeft = FADE_S
    this.sizePick()
    this.setHover(false)
  }

  /** Item ownership: may the viewer pick it up now? */
  itemFree(now: number): boolean {
    const s = this.state
    return s.owner === undefined || s.owner === this.ctx.selfId() || (s.ownerUntil !== undefined && now >= s.ownerUntil)
  }

  /** Advances interpolation to server time `now`; false once a fade-out has finished. */
  update(now: number, dt: number): boolean {
    if (this.move) {
      const s = sampleMove(this.move, now)
      this.pos.set(s.pos[0], s.pos[1], s.pos[2])
      if (s.dir[0] || s.dir[1]) this.targetYaw = Math.atan2(s.dir[0], s.dir[1])
      this.moving = !s.arrived
      if (s.arrived) this.move = undefined
    } else {
      this.moving = false
    }
    if (!this.dead) this.yaw = angleLerp(this.yaw, this.targetYaw, Math.min(1, dt * TURN_RATE))
    this.root.position.set(this.pos.x, this.ctx.heightAt(this.pos.x, this.pos.z), this.pos.z)
    if (this.actor) {
      // PERF2: the player's own character is never animation-LOD'd (three/models.ts ANIM_LOD), even zoomed out.
      this.actor.lodFull = this.isSelf
      // Wave 11: a ridden mob turns its ride's root (the rider is seated on it).
      const body = this.ride?.actor ?? this.actor
      body.setYaw(this.yaw)
      if (!this.dead) {
        if (this.moving) {
          this.actor.cancelAction(this.moveCancels)
          this.actor.play((this.move?.speed ?? 0) >= RUN_THRESHOLD ? 'RUN' : 'WALK')
        } else {
          this.actor.cancelAction(this.stopCancels)
          this.actor.play(IDLE_CLIP[this.idleKind])
        }
      }
    } else if (this.placeholder) {
      this.placeholder.rotation.y = this.yaw
    }
    if (this.drop) {
      this.drop.update(dt)
      const free = this.itemFree(now)
      this.drop.setPickable(free)
      this.label.classList.toggle('owned', !free)
    }
    if (this.attached.length) this.eachAttachment(a => a.update?.(now, dt))
    if (this.fadeLeft !== null) {
      this.fadeLeft -= dt
      this.applyOpacity()
      if (this.fadeLeft <= 0) return false
    }
    return true
  }

  async load(onProgress?: (f: number) => void): Promise<void> {
    const { catalog, library, scene } = this.ctx
    const s = this.state
    if (s.kind === 'item') {
      this.drop = new DropVisual(this.ctx.drops, /^ITEM_ETC_GOLD_/.test(s.model), catalog.item(s.model))
      this.drop.root.parent = this.root
      onProgress?.(1)
      this.eachAttachment(a => a.loaded?.())
      return
    }
    let ride: RideMob | null = null
    try {
      let actor: CharacterActor
      if (s.kind === 'player') {
        const model = catalog.characterOrFallback(s.model)
        if (!model) throw new Error(`no model for ${s.model}`)
        actor = await library.character(model, this.look(), onProgress)
      } else {
        const mob = s.kind === 'mob' ? catalog.mob(s.model) : null
        const model = mob ? mob.model : catalog.npc(s.model)
        if (!model) throw new Error(`no model for ${s.model}`)
        actor = await library.character(model, {}, onProgress)
        // Wave 11 (UNIQUES §2.3 step 1): the ride loads in the same load(), before either is shown.
        if (mob?.ride && !this.disposed) ride = await this.loadRide(actor, mob.ride)
      }
      if (this.disposed) {
        ride?.dispose()
        return actor.dispose()
      }
      this.placeholder?.dispose()
      this.placeholder = null
      this.actor = actor
      this.ride = ride
      // The ride's root takes the rider's place under the entity root (the rider hangs under its seat).
      const body = ride?.actor ?? actor
      body.root.parent = this.root
      body.root.scaling.setAll(this.scale)
      body.setYaw(this.yaw)
      actor.play(IDLE_CLIP[this.idleKind])
      if (this.dead) actor.die(true)
      if (this.hovered) actor.setHighlight(true, this.highlightColor()) // W9F R3: the mob tint, as setHover
      this.fitModelPick(actor)
      this.sizePick()
      this.applyOpacity()
    } catch (err) {
      if (s.kind === 'player') console.warn('[world] model failed, using a placeholder', s.model, err)
      onProgress?.(1)
      if (this.disposed) return
      this.makePlaceholder()
    }
    if (!this.disposed) this.eachAttachment(a => a.loaded?.())
  }

  /** Wave 11: the ride for a ridden mob (world/ride-mob.ts); a failed ride leaves the rider standing alone. */
  private async loadRide(rider: CharacterActor, ref: Parameters<typeof loadRide>[2]): Promise<RideMob | null> {
    try {
      return await loadRide({ library: this.ctx.library }, rider, ref)
    } catch (err) {
      console.warn('[world] ride failed, the rider stands alone', this.state.model, err)
      return null
    }
  }

  /** The root that carries the entity's model, scale and yaw: the ride's for a ridden mob, else the actor's. */
  private bodyRoot(): TransformNode | null {
    return (this.ride?.actor ?? this.actor)?.root ?? null
  }

  private makePlaceholder(): void {
    const scene = this.ctx.scene
    const h = this.kind === 'mob' ? 1.2 * this.scale : 1.8
    const cap = CreateCapsule(`ph${this.id}`, { height: h, radius: Math.min(0.5, h / 4) }, scene)
    cap.bakeTransformIntoVertices(Matrix.Translation(0, h / 2, 0))
    const m = new StandardMaterial(`phm${this.id}`, scene)
    m.diffuseColor = this.isSelf
      ? new Color3(0.9, 0.75, 0.3)
      : this.kind === 'mob'
        ? new Color3(0.75, 0.3, 0.25)
        : this.kind === 'npc'
          ? new Color3(0.35, 0.7, 0.4)
          : new Color3(0.5, 0.6, 0.8)
    cap.material = m
    cap.isPickable = false
    cap.parent = this.root
    if (this.dead) cap.rotation.z = Math.PI / 2
    this.placeholder = cap
    this.applyOpacity()
  }

  updateLabel(scene: Scene, tmp: Vector3, focus: Vector3): void {
    const dx = this.pos.x - focus.x
    const dz = this.pos.z - focus.z
    const range = LABEL_RANGE[this.kind] ?? 40
    if (!this.hovered && dx * dx + dz * dz > range * range) {
      if (!this.label.hidden) this.label.hidden = true
      return
    }
    const p = toScreen(scene, this.head(tmp))
    if (this.label.hidden === p.visible) this.label.hidden = !p.visible
    if (!p.visible) return
    // G1 rescue: a label that did not move keeps its style (no style invalidation for a still crowd).
    const tr = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`
    if (tr !== this.labelAt) {
      this.labelAt = tr
      this.label.style.transform = tr
    }
  }

  /** The label's last transform (updateLabel). */
  private labelAt = ''

  dispose(): void {
    if (!this.disposed) this.eachAttachment(a => a.dispose())
    this.attached.length = 0
    this.disposed = true
    this.actor?.dispose()
    this.actor = null
    this.ride?.dispose()
    this.ride = null
    if (this.placeholder) {
      this.placeholder.material?.dispose()
      this.placeholder.dispose()
    }
    this.placeholder = null
    this.drop?.dispose()
    this.drop = null
    this.pick.dispose()
    this.root.dispose()
    this.label.remove()
  }
}

// ---- entity kinds the world does not draw itself (docs/WAVE_PLAN2.md D8, §4.3) --------------------------------------

/** Kinds EntityView draws itself (models from the catalog's characters, mobs, NPCs and drops). */
export type BuiltinEntityKind = 'player' | 'mob' | 'npc' | 'item'
/** Every other kind ('cos': MR-C's horse view) is drawn only when a lane registers a factory for it. */
export type ExtraEntityKind = Exclude<EntityState['kind'], BuiltinEntityKind>
/** Builds the view of one entity: usually a subclass of EntityView that overrides `load` (and `update`). */
export type EntityViewFactory = (state: EntityState, ctx: EntityContext) => EntityView

const BUILTIN_KINDS: ReadonlySet<string> = new Set<BuiltinEntityKind>(['player', 'mob', 'npc', 'item'])
const kindFactories = new Map<string, EntityViewFactory>()

/**
 * Supplies the view of an extra entity kind (world/mount-view.ts: `registerEntityKind('cos', …)`). A later call for
 * the same kind replaces the factory. Returns an unregister function (a no-op once replaced).
 */
export function registerEntityKind(kind: ExtraEntityKind, factory: EntityViewFactory): () => void {
  kindFactories.set(kind, factory)
  return () => {
    if (kindFactories.get(kind) === factory) kindFactories.delete(kind)
  }
}

/**
 * The view of `state` (screens/world.ts): an EntityView for the builtin kinds, the registered factory's view for an
 * extra kind, else null. The world ignores an entity without a view (not drawn, not targetable; its messages are
 * dropped). A throwing factory is logged and counts as unregistered.
 */
export function createEntityView(state: EntityState, ctx: EntityContext): EntityView | null {
  if (BUILTIN_KINDS.has(state.kind)) return new EntityView(state, ctx)
  const make = kindFactories.get(state.kind)
  if (!make) return null
  try {
    return make(state, ctx)
  } catch (err) {
    console.error(`[world] ${state.kind} view failed`, err)
    return null
  }
}
