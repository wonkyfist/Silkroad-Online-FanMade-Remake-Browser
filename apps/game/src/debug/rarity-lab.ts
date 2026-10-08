/**
 * The rare-weapon lab (docs/RARITY.md §9), dev only: `?rarelab=1` on any world (the lab server in work/tmp/rarelab
 * injects the session). It exposes `window.__sroRareLab` to frame the camera like the concept targets, pose a clip at
 * a frame, freeze the rare effects' clock, and fire the swing / crit / kill / drop / equip moments on demand, so the
 * comparison sheets (rarity-preview/v2) are captured through the real client pipeline.
 */
import { TransformNode, Vector3, type AnimationGroup } from '@babylonjs/core'
import type { RarityTier } from '@sro/shared'
import type { App } from '../app.ts'
import { FrameWatchdog } from '../settings.ts'
import type { ModelLibrary } from '../three/models.ts'
import type { EntityView } from '../world/entities.ts'
import { WORLD_FEATURES, type WorldFeature, type WorldFeatureContext, type WorldFeatureFactory } from '../world/features.ts'
import { rarityFxOf } from '../world/rarity/fx.ts'

const CONTROL = 'http://127.0.0.1:7271'

export class RarityLab {
  ctx: WorldFeatureContext | null = null

  constructor(private readonly app: App) {}

  install(): void {
    ;(FrameWatchdog.prototype as unknown as { sample: () => boolean }).sample = () => false
    const list = WORLD_FEATURES as WorldFeatureFactory[]
    const lab = this
    const rarityLabFeature: WorldFeatureFactory = ctx => lab.attach(ctx)
    if (!list.some(f => f.name === 'rarityLabFeature')) list.push(rarityLabFeature)
    ;(window as unknown as { __sroRareLab?: RarityLab }).__sroRareLab = this
    void this.autoEnter()
  }

  private attach(ctx: WorldFeatureContext): WorldFeature {
    this.ctx = ctx
    return { dispose: () => void (this.ctx === ctx && (this.ctx = null)) }
  }

  /** Clicks "Start" on character select until the world is in. */
  private async autoEnter(): Promise<void> {
    for (let i = 0; i < 400 && !this.ctx; i++) {
      const b = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent?.trim() === 'Start' && (e as HTMLElement).offsetParent)
      if (b) ((b.closest('button,.kit-btn,[role=button]') ?? b) as HTMLElement).click()
      await new Promise(r => setTimeout(r, 750))
    }
  }

  private get models(): ModelLibrary | null {
    return (window as unknown as { __sroModels?: ModelLibrary }).__sroModels ?? null
  }

  status(): { inWorld: boolean; ready: boolean; players: number; loaded: number; mobs: number; fps: number } {
    const ctx = this.ctx
    if (!ctx || ctx.selfId() === null) return { inWorld: false, ready: false, players: 0, loaded: 0, mobs: 0, fps: 0 }
    let players = 0
    let loaded = 0
    let mobs = 0
    for (const v of ctx.views()) {
      if (v.kind === 'player') {
        players++
        if (v.actor) loaded++
      } else if (v.kind === 'mob') mobs++
    }
    const ground = ctx.world() as unknown as { world?: { stream?: { busy?: boolean } | null } } | null
    return { inWorld: true, ready: !!ground && !ground.world?.stream?.busy && !!this.me()?.actor, players, loaded, mobs, fps: ctx.scene.getEngine().getFps() }
  }

  me(): EntityView | null {
    const id = this.ctx?.selfId()
    return id === null || id === undefined ? null : this.ctx?.view(id) ?? null
  }

  gm(cmd: string, ...args: string[]): boolean {
    return this.ctx?.send({ t: 'gm', cmd, args }) ?? false
  }

  async control(path: string): Promise<unknown> {
    return (await fetch(CONTROL + path)).json()
  }

  /** Wears `weapon` (+plus) and optionally a shield / arrows (codes; '' takes it off). */
  async equip(weapon: string, plus = 0, shield?: string): Promise<unknown> {
    const q = new URLSearchParams({ weapon, weaponPlus: String(plus) })
    if (shield !== undefined) q.set('shield', shield)
    return this.control('/equip?' + q.toString())
  }

  /** Orbit camera around the own character: alpha, beta (rad), radius (m), and the look-at height (m). */
  cam(alpha: number, beta: number, radius: number, shiftX = 0, shiftY = 0): void {
    const c = this.ctx?.camera
    if (!c) return
    c.lowerRadiusLimit = Math.min(c.lowerRadiusLimit ?? radius, radius)
    c.targetScreenOffset.set(shiftX, shiftY)
    c.alpha = alpha
    c.beta = beta
    c.radius = radius
    c.inertialAlphaOffset = 0
    c.inertialBetaOffset = 0
    c.inertialRadiusOffset = 0
  }

  private lookObs: import('@babylonjs/core').Observer<import('@babylonjs/core').Camera> | null = null

  /** Holds the orbit camera on the own weapon's blade middle (close-ups); null releases it to the follow. */
  lookAtWeapon(radius: number | null): void {
    const scene = this.ctx?.scene
    const c = this.ctx?.camera
    if (!scene || !c) return
    if (this.lookObs) scene.onBeforeCameraRenderObservable.remove(this.lookObs)
    this.lookObs = null
    if (radius === null) return
    c.lowerRadiusLimit = Math.min(c.lowerRadiusLimit ?? radius, radius)
    this.lookObs = scene.onBeforeCameraRenderObservable.add(() => {
      const a = this.me()?.actor
      const s = a?.weaponDummy('ai_start')
      const t = a?.weaponDummy('ai_end')
      if (!s || !t) return
      c.targetScreenOffset.set(0, 0)
      c.target.copyFrom(s.getAbsolutePosition().add(t.getAbsolutePosition()).scaleInPlace(0.5))
      c.radius = radius
      c.getViewMatrix(true)
    })
  }

  camState():{ alpha: number; beta: number; radius: number; target: number[]; fov: number } | null {
    const c = this.ctx?.camera
    return c ? { alpha: c.alpha, beta: c.beta, radius: c.radius, target: c.target.asArray(), fov: c.fov } : null
  }

  /** The own actor's clip names. */
  clips(): string[] {
    return this.me()?.actor?.groups.map(g => g.name) ?? []
  }

  /** Faces the own character to yaw (rad, glTF: atan2(dx, dz)). */
  face(yaw: number): void {
    const v = this.me()
    if (v) v.root.rotation.y = yaw
  }

  private held: AnimationGroup | null = null

  /** Plays `clip` on the own actor and holds it at `frac` (0..1) of its length (null: release). */
  async pose(clip: string | null, frac = 0.5): Promise<string | null> {
    const a = this.me()?.actor
    if (!a) return null
    if (this.held) {
      this.held.pause()
      this.held = null
    }
    if (!clip) {
      a.play('STAND1', true)
      return null
    }
    const g = a.groups.find(x => x.name === clip) ?? a.groups.find(x => x.name.startsWith(clip))
    if (!g) return null
    a.playAction(g, 1)
    await new Promise(r => setTimeout(r, 120))
    g.goToFrame(g.from + (g.to - g.from) * frac)
    g.pause()
    this.held = g
    return g.name
  }

  /**
   * Plays the attack `clip` from `from` (0..1) at real speed with the rare swing on, and after `ms` freezes the clip
   * and the rare effects' clock (the slash as it is at that instant).
   */
  async swingShot(clip: string, ms: number, from = 0): Promise<string | null> {
    const v = this.me()
    const a = v?.actor
    const fx = this.ctx ? rarityFxOf(this.ctx.scene) : null
    if (!v || !a || !fx) return null
    fx.freeze(false)
    const g = a.groups.find(x => x.name === clip) ?? a.groups.find(x => x.name.startsWith(clip))
    if (!g) return null
    a.playAction(g, 1)
    g.goToFrame(g.from + (g.to - g.from) * from)
    fx.swing(a, ms / 1000 + 0.5)
    // a spear's lance fires on the hit (here: a little before the frozen moment)
    if (fx.kindOf(a) === 'spear') setTimeout(() => fx.thrust(a), Math.max(0, ms - 180))
    await new Promise(r => setTimeout(r, ms))
    g.pause()
    fx.freeze(true)
    this.held = g
    return g.name
  }

  /** Unfreezes the rare clock, releases the pose and clears the lab's drop. */
  release(): void {
    this.lastDrop?.dispose()
    this.lastDrop = null
    const fx = this.ctx ? rarityFxOf(this.ctx.scene) : null
    fx?.freeze(false)
    void this.pose(null)
  }

  /** The rare effects' moments on the own character: 'crit' | 'kill' | 'equip', at a point `dist` m ahead. */
  moment(kind: 'crit' | 'kill' | 'equip', dist = 1.6, freezeAfterMs = 0): boolean {
    const v = this.me()
    const fx = this.ctx ? rarityFxOf(this.ctx.scene) : null
    if (!v || !fx) return false
    fx.freeze(false)
    const yaw = v.root.rotation.y
    const at = new Vector3(v.root.position.x + Math.sin(yaw) * dist, v.root.position.y + 1.1, v.root.position.z + Math.cos(yaw) * dist)
    const a = v.actor
    if (!a) return false
    if (kind === 'equip') fx.equipFlare(a)
    else fx.impact(a, at, kind, v.root.position.y)
    if (freezeAfterMs > 0) setTimeout(() => fx.freeze(true), freezeAfterMs)
    return true
  }

  private lastDrop: TransformNode | null = null

  /** A drop moment of `tier` at a point `dist` m ahead of the own character (local only, no server item). */
  drop(tier: RarityTier, dist = 2.5, freezeAfterMs = 0): boolean {
    const v = this.me()
    const fx = this.ctx ? rarityFxOf(this.ctx.scene) : null
    if (!v || !fx) return false
    fx.freeze(false)
    const yaw = v.root.rotation.y
    this.lastDrop?.dispose()
    const node = new TransformNode('rarelabDrop', v.root.getScene())
    this.lastDrop = node
    node.position.set(v.root.position.x + Math.sin(yaw) * dist, v.root.position.y, v.root.position.z + Math.cos(yaw) * dist)
    fx.labDrop(tier, node)
    setTimeout(() => node.dispose(), 12_500)
    if (freezeAfterMs > 0) setTimeout(() => fx.freeze(true), freezeAfterMs)
    return true
  }

  /** A scripted arrow of the own rare bow flying `dist` m ahead in `s` seconds (the real path: SkillFx.fly). */
  arrow(dist = 12, s = 0.7, freezeAfterMs = 0): boolean {
    const v = this.me()
    const a = v?.actor
    const fx = this.ctx ? rarityFxOf(this.ctx.scene) : null
    if (!v || !a || !fx) return false
    fx.freeze(false)
    const yaw = v.root.rotation.y
    const fx0 = Math.sin(yaw)
    const fz0 = Math.cos(yaw)
    const o = v.root.position.clone()
    const t0 = performance.now()
    const pos = [0, 0, 0]
    const at = () => {
      const k = Math.min(1, (performance.now() - t0) / (s * 1000))
      pos[0] = o.x + fx0 * (0.5 + dist * k)
      pos[1] = o.y + 1.35 + Math.sin(Math.PI * k) * 0.4
      pos[2] = o.z + fz0 * (0.5 + dist * k)
      return { pos }
    }
    fx.arrow(a, at, () => performance.now() - t0 >= s * 1000)
    if (freezeAfterMs > 0) setTimeout(() => fx.freeze(true), freezeAfterMs)
    return true
  }

  /** Attacks the nearest monster (a real attack through the server: swings, arrows, hits). */
  attackNearest(): number | null {
    const me = this.me()
    const ctx = this.ctx
    if (!me || !ctx) return null
    let best: EntityView | null = null
    let bd = Infinity
    for (const v of ctx.views()) {
      if (v.kind !== 'mob' || v.dead) continue
      const d = Vector3.Distance(v.root.position, me.root.position)
      if (d < bd) {
        bd = d
        best = v
      }
    }
    if (!best) return null
    ctx.send({ t: 'attack', target: best.id })
    return best.id
  }

  /** Freezes or resumes the rare effects' clock and the own pose. */
  freeze(on: boolean): void {
    const fx = this.ctx ? rarityFxOf(this.ctx.scene) : null
    fx?.freeze(on)
    const a = this.me()?.actor
    if (!a) return
    for (const g of a.groups) if (g.isStarted) on ? g.pause() : g.play(g.loopAnimation)
    for (const v of this.ctx?.views() ?? []) {
      if (v === this.me() || !v.actor) continue
      for (const g of v.actor.groups) if (g.isStarted) on ? g.pause() : g.play(g.loopAnimation)
    }
  }

  /** Hides the HUD (true) for clean frames. */
  hud(on: boolean): void {
    for (const id of ['ui', 'overlay']) {
      const e = document.getElementById(id)
      if (e) e.style.visibility = on ? '' : 'hidden'
    }
  }

  /** The effects layer on or off (A/B timing). */
  fx(on: boolean): void {
    const fx = this.ctx ? rarityFxOf(this.ctx.scene) : null
    if (fx) fx.enabled = on
  }

  stats(): unknown {
    const fx = this.ctx ? rarityFxOf(this.ctx.scene) : null
    return fx?.stats() ?? null
  }
}

export async function installRarityLab(app: App): Promise<void> {
  new RarityLab(app).install()
}
