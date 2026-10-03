/**
 * Horses, client (lane MR-C; docs/SYSTEMS_COMBAT.md §1.5, §8 MR-C tests): the dismount-then-attack intent sequence,
 * click-to-ride and the chat commands; the horse view follows its rider (position, yaw, gait) and the rider sits on
 * the saddle in the `cart` clips, then steps down; the horse frame shows the horse's HP; catalog.cos from cos.json.
 * NullEngine, synthetic actors built in memory (no glb, no fetch) and a small DOM stub.
 */
import { Animation, AnimationGroup, AssetContainer, MeshBuilder, NullEngine, Scene, TransformNode } from '@babylonjs/core'
import type { ClientMessage, CosDef, EntityState, ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Catalog, parseCosJson } from '../src/content/catalog.ts'
import { MountFrame, mountFrameText, type MountFrameInfo } from '../src/hud/mount-frame.ts'
import { CharacterActor } from '../src/three/models.ts'
import { Art } from '../src/ui/art.ts'
import { createEntityView, EntityView, type EntityContext } from '../src/world/entities.ts'
import type { WorldFeature, WorldFeatureContext } from '../src/world/features.ts'
import { applyMountUpdate, DISMOUNT_COMMAND, dismountThenAttack, mountFailText, mountFeature, STOP_HOLD_S, UNSUMMON_COMMAND } from '../src/world/features/mount.ts'
import { ease, HorseView, horseCatalog, MOUNT_TWEEN_MS, registerHorseView, RideLink, SEAT_OFFSET } from '../src/world/mount-view.ts'

// ---- a DOM stub (the game tests run in node) ------------------------------------------------------------------------

class StubElement {
  className = ''
  textContent = ''
  title = ''
  hidden = false
  type = ''
  parentElement: StubElement | null = null
  readonly children: StubElement[] = []
  readonly dataset: Record<string, string> = {}
  readonly attrs: Record<string, string> = {}
  readonly style: Record<string, unknown> & { setProperty(k: string, v: string): void } = {
    setProperty(k: string, v: string) {
      ;(this as Record<string, unknown>)[k] = v
    },
  }
  readonly classList = {
    toggle: (c: string, on?: boolean) => {
      const has = this.className.split(' ').includes(c)
      const want = on ?? !has
      if (want && !has) this.className = `${this.className} ${c}`.trim()
      if (!want && has) this.className = this.className.split(' ').filter(x => x !== c).join(' ')
      return want
    },
    add: (...cs: string[]) => cs.forEach(c => this.classList.toggle(c, true)),
    remove: (...cs: string[]) => cs.forEach(c => this.classList.toggle(c, false)),
    contains: (c: string) => this.className.split(' ').includes(c),
  }
  append(...c: unknown[]): void {
    for (const x of c) {
      if (!(x instanceof StubElement)) continue
      x.remove()
      x.parentElement = this
      this.children.push(x)
    }
  }
  prepend(...c: unknown[]): void {
    this.append(...c)
  }
  replaceChildren(...c: unknown[]): void {
    for (const x of [...this.children]) x.remove()
    this.append(...c)
  }
  insertBefore(c: StubElement): void {
    this.append(c)
  }
  remove(): void {
    const p = this.parentElement
    if (!p) return
    const i = p.children.indexOf(this)
    if (i >= 0) p.children.splice(i, 1)
    this.parentElement = null
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v
  }
  removeAttribute(k: string): void {
    delete this.attrs[k]
  }
  addEventListener(): void {}
  focus(): void {}
  getContext(): null {
    return null
  }
  /** Every descendant with class `c`. */
  find(c: string): StubElement[] {
    const out: StubElement[] = []
    for (const k of this.children) {
      if (k.classList.contains(c)) out.push(k)
      out.push(...k.find(c))
    }
    return out
  }
}

let engine: NullEngine
let scene: Scene
const hadDocument = 'document' in globalThis

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  if (!hadDocument) (globalThis as { document?: unknown }).document = { createElement: () => new StubElement(), head: new StubElement(), body: new StubElement() }
})

afterAll(() => {
  if (!hadDocument) delete (globalThis as { document?: unknown }).document
  scene.dispose()
  engine.dispose()
})

// ---- fixtures -------------------------------------------------------------------------------------------------------

const HORSE: CosDef = {
  code: 'COS_C_HORSE1',
  id: 2191,
  name: 'Red Horse',
  level: 20,
  hp: 983,
  walkSpeed: 4.5,
  runSpeed: 9,
  radius: 1.2,
  physAbsorb: 20,
  magAbsorb: 20,
  parryRate: 65,
  hitRate: 65,
  model: { bsr: 'res/cos/c_horse1.bsr', glb: '/out/cos/c_horse1.glb', sidecar: '/out/cos/c_horse1.json' },
  icon: '/out/icon/cos/cos_c_horse1.png',
}
const SELF = 7
const catalog = new Catalog([], {}, 'test', undefined, undefined, [HORSE])

function entityCtx(): EntityContext {
  return {
    scene,
    library: null,
    catalog,
    labels: new StubElement(),
    drops: null,
    heightAt: () => 0,
    selfId: () => SELF,
    selfLevel: () => 12,
    serverNow: () => 0,
    attachments: [],
  } as unknown as EntityContext
}

const cosState = (over: Partial<EntityState> = {}): EntityState => ({ id: 40, kind: 'cos', name: 'Red Horse', model: 'COS_C_HORSE1', level: 20, hp: 983, maxHp: 983, owner: SELF, pos: [5, 0, 5], yaw: 0, ...over })
const playerState = (over: Partial<EntityState> = {}): EntityState => ({ id: SELF, kind: 'player', name: 'Rider', model: 'CHAR_CH_MAN_ADVENTURER', level: 12, weapon: 'sword', pos: [5, 0, 5], yaw: 0, ...over })

function contain(build: () => void): AssetContainer {
  build()
  const c = new AssetContainer(scene)
  c.moveAllFromScene()
  return c
}

function clip(name: string, target: TransformNode): AnimationGroup {
  const g = new AnimationGroup(name, scene)
  const a = new Animation(`${name}:y`, 'position.y', 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE)
  a.setKeys([{ frame: 0, value: 0 }, { frame: 30, value: 0.01 }])
  g.addTargetedAnimation(a, target)
  return g
}

/** A horse: root, a pelvis and the `saddle` joint 1.3 m up and 0.1 m forward, STAND1 / WALK / RUN. */
function horseActor(): CharacterActor {
  const body = contain(() => {
    const root = new TransformNode('__root__', scene)
    const pelvis = new TransformNode('Bip01', scene)
    pelvis.parent = root
    const saddle = new TransformNode('saddle', scene)
    saddle.parent = pelvis
    saddle.position.set(0, 1.3, 0.1)
    MeshBuilder.CreateBox('horse-body', { size: 1 }, scene).parent = root
    for (const c of ['STAND1', 'WALK', 'RUN']) clip(c, root)
  })
  return new CharacterActor(scene, { code: 'COS_C_HORSE1', glb: '/out/cos/c_horse1.glb' }, { container: body, sidecar: null, packs: null })
}

/** A rider: STAND1 / RUN / WALK, the cart clips only in a `cart` pack (loaded on demand). */
function riderActor(): CharacterActor {
  const body = contain(() => {
    const root = new TransformNode('__root__', scene)
    const joint = new TransformNode('Bip01', scene)
    joint.parent = root
    MeshBuilder.CreateBox('rider-body', { size: 1 }, scene).parent = root
    for (const c of ['STAND1', 'RUN', 'WALK']) clip(c, joint)
  })
  const packs = {
    packs: { default: 'char/_anims/skel/default.glb', cart: 'char/_anims/skel/cart.glb' },
    clips: { STAND1_cart_stand01: ['cart', 'cart_stand01'], WALK_cart_walk: ['cart', 'cart_walk'], RUN_cart_walk: ['cart', 'cart_walk'] } as Record<string, [string, string]>,
  }
  const a = new CharacterActor(scene, { code: 'CHAR_CH_MAN_ADVENTURER', glb: '/out/test.glb' }, { container: body, sidecar: null, packs })
  a.loadPack = async () =>
    contain(() => {
      const joint = new TransformNode('Bip01', scene)
      clip('cart_stand01', joint)
      clip('cart_walk', joint)
    })
  return a
}

/** Gives a view its actor the way EntityView.load does. */
function dress<T extends EntityView>(v: T, actor: CharacterActor): T {
  v.actor = actor
  actor.root.parent = v.root
  actor.play('STAND1', true)
  return v
}

const playing = (a: CharacterActor, name: string) => !!a.group(name)?.isPlaying
const flush = () => new Promise(r => setTimeout(r, 0))

// ---- catalog --------------------------------------------------------------------------------------------------------

describe('catalog.cos (cos.json)', () => {
  it('reads the content file and answers by code; unknown codes and a bad file give null / nothing', () => {
    const file = { schema: 1, kind: 'cos', generatedAt: '', sources: [], entries: [{ ...HORSE, model: { bsr: 'x', glb: 'cos/c_horse1.glb', sidecar: 'cos/c_horse1.json' }, icon: 'icon/cos/cos_c_horse1.png' }, { code: 'NO_HP' }] }
    const rows = parseCosJson(file)
    expect(rows.map(r => r.code)).toEqual(['COS_C_HORSE1'])
    expect(rows[0]!.model!.glb).toBe('/out/cos/c_horse1.glb')
    expect(rows[0]!.icon).toBe('/out/icon/cos/cos_c_horse1.png')
    const c = new Catalog([], {}, 'test', undefined, undefined, rows)
    expect(c.cos('COS_C_HORSE1')?.hp).toBe(983)
    expect(c.cos('COS_C_HORSE9')).toBeNull()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseCosJson({ schema: 1, kind: 'items', entries: [] })).toEqual([])
    warn.mockRestore()
  })

  it('a horse view draws the cos model through the catalog npc lookup', () => {
    const c = horseCatalog(catalog)
    expect(c.npc('COS_C_HORSE1')).toEqual({ code: 'COS_C_HORSE1', glb: '/out/cos/c_horse1.glb', sidecar: '/out/cos/c_horse1.json' })
    expect(c.cos('COS_C_HORSE1')).toBe(HORSE)
    expect(c.npc('NPC_CH_SMITH')).toBe(catalog.npc('NPC_CH_SMITH'))
  })
})

// ---- the horse view and the ride link -------------------------------------------------------------------------------

describe('horse view (D8)', () => {
  it("registers for the 'cos' kind: radius from cos.json, the owner's HP bar, no pick while ridden", () => {
    const off = registerHorseView()
    const h = createEntityView(cosState({ hp: 500 }), entityCtx())
    expect(h).toBeInstanceOf(HorseView)
    const horse = h as HorseView
    expect(horse.radius).toBe(1.2)
    expect(horse.own).toBe(true)
    const bar = (horse.label as unknown as StubElement).find('cos-hp')[0]!
    expect(bar.hidden).toBe(false)
    expect(bar.children[0]!.style.width).toBe('50.9%')
    expect(horse.selectable).toBe(true)
    horse.state.rider = SELF
    horse.refreshOwner()
    expect(horse.selectable).toBe(false)
    horse.dispose()
    off()
    expect(createEntityView(cosState(), entityCtx())).toBeNull()
    // Someone else's horse: no HP bar.
    const other = new HorseView(cosState({ owner: 99 }), entityCtx())
    expect(other.own).toBe(false)
    expect((other.label as unknown as StubElement).find('cos-hp')).toEqual([])
    other.dispose()
  })

  it('follows its rider (position, yaw, gait); the rider sits on the saddle in the cart clips, then steps down', async () => {
    const ctx = entityCtx()
    const rider = dress(new EntityView(playerState(), ctx), riderActor())
    const horse = dress(new HorseView(cosState({ rider: SELF }), ctx), horseActor())
    const link = new RideLink(horse, rider, scene)
    await flush()
    expect(rider.actor!.clipGroup).toBe('cart')
    expect(rider.actor!.root.parent).toBe(link.seat)

    // The rider runs east at 9.9 m/s: the horse is drawn under it and runs too.
    rider.setMove({ from: [5, 0, 5], to: [25, 0, 5], speed: 9.9, startedAt: 0 })
    for (let t = 0; t <= 500; t += 50) {
      horse.update(t, 0.05)
      rider.update(t, 0.05)
      expect(link.sync(50)).toBe(true)
    }
    expect(horse.root.position.x).toBeCloseTo(rider.root.position.x, 5)
    expect(horse.root.position.z).toBeCloseTo(rider.root.position.z, 5)
    expect(rider.root.position.x).toBeGreaterThan(9)
    expect(horse.yaw).toBeCloseTo(rider.yaw, 5)
    expect(horse.moving).toBe(true)
    expect(playing(horse.actor!, 'RUN')).toBe(true)
    expect(playing(rider.actor!, 'RUN_cart_walk')).toBe(true)
    expect(link.progress).toBe(1)
    // The seat is at the saddle joint (plus SEAT_OFFSET), turned with the horse (yaw ~ +90°: forward is +x).
    const saddle = horse.actor!.joint('saddle')!
    saddle.computeWorldMatrix(true)
    expect(link.seat.position.y).toBeCloseTo(saddle.absolutePosition.y + SEAT_OFFSET.y, 3)
    expect(link.seat.position.x).toBeCloseTo(saddle.absolutePosition.x + Math.sin(horse.yaw) * SEAT_OFFSET.z, 3)
    // Label and camera focus measure from the saddle while riding (seated head 1.25 m, focus 0.6 m above it).
    const standing = Object.getOwnPropertyDescriptor(EntityView.prototype, 'height')!.get!.call(rider) as number
    expect(rider.height).toBeCloseTo(1.3 + SEAT_OFFSET.y + 1.25, 1)
    expect(rider.focusHeight).toBeCloseTo(1.3 + SEAT_OFFSET.y + 0.6, 1)

    // Stopped: the horse stands. Then the dismount tween back to the ground.
    rider.stop([20, 0, 5], rider.yaw)
    horse.update(600, 0.05)
    rider.update(600, 0.05)
    link.sync(16)
    expect(horse.moving).toBe(false)
    expect(playing(horse.actor!, 'STAND1')).toBe(true)
    // The dismount: the rider's stop 1.2 m aside (the horse holds its spot), then mount: null.
    rider.stop([20, 0, 3.8], rider.yaw)
    horse.hold(STOP_HOLD_S)
    horse.update(620, 0.02)
    rider.update(620, 0.02)
    link.sync(20)
    expect(horse.pos.z).toBeCloseTo(5, 5)
    expect(horse.root.position.z).toBeCloseTo(5, 5)
    link.leave()
    expect(horse.rider).toBeNull()
    expect(link.riding).toBe(false)
    expect(link.sync(MOUNT_TWEEN_MS / 2)).toBe(true)
    expect(link.seat.position.y).toBeGreaterThan(0.1)
    expect(link.sync(MOUNT_TWEEN_MS)).toBe(false)
    link.dispose()
    await flush()
    expect(rider.actor!.root.parent).toBe(rider.root)
    expect(rider.actor!.clipGroup).toBe('default')
    expect(rider.height).toBeCloseTo(standing, 5)
    expect(Object.getOwnPropertyDescriptor(rider, 'height')).toBeUndefined()
    // The parked horse stays where the ride ended.
    expect(horse.pos.x).toBeCloseTo(20, 5)
    rider.dispose()
    horse.dispose()
  })

  it('a horse disposed under its rider gives the rider back its actor', () => {
    const ctx = entityCtx()
    const rider = dress(new EntityView(playerState(), ctx), riderActor())
    const horse = dress(new HorseView(cosState({ rider: SELF }), ctx), horseActor())
    const link = new RideLink(horse, rider, scene, true)
    link.sync(16)
    expect(link.progress).toBe(1)
    link.dispose()
    horse.dispose()
    expect(rider.actor!.isDisposed).toBe(false)
    expect(rider.actor!.root.parent).toBe(rider.root)
    rider.dispose()
  })

  it('ease is a smooth 0..1 step', () => {
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    expect(ease(0.5)).toBeCloseTo(0.5)
    expect(ease(-1)).toBe(0)
  })
})

// ---- the frame ------------------------------------------------------------------------------------------------------

const info = (over: Partial<MountFrameInfo> = {}): MountFrameInfo => ({ name: 'Red Horse', level: 20, hp: 500, maxHp: 983, icon: HORSE.icon, mounted: true, dead: false, ...over })

describe('horse frame', () => {
  it('shows name, level and HP; the toggle offers Dismount or Ride', () => {
    expect(mountFrameText(info())).toEqual({ level: 'Lv 20', hp: 'HP 500 / 983', toggle: 'Dismount', toggleTip: expect.any(String) })
    expect(mountFrameText(info({ mounted: false })).toggle).toBe('Ride')
    expect(mountFrameText(info({ dead: true })).hp).toBe('Dead')
  })

  it('lives in the pet host only while there is a horse', () => {
    const actions = { ride: vi.fn(), dismount: vi.fn(), dismiss: vi.fn() }
    const frame = new MountFrame(new Art(null), actions)
    const host = new StubElement()
    frame.attach(host as unknown as HTMLElement)
    expect(host.children).toEqual([])
    frame.set(info())
    expect(frame.visible).toBe(true)
    const root = frame.root as unknown as StubElement
    expect(root.parentElement).toBe(host)
    expect(root.find('mr-pet-name')[0]!.textContent).toBe('Red Horse')
    expect(root.find('mr-pet-level')[0]!.textContent).toBe('Lv 20')
    const gauge = root.find('mr-pet-hp')[0]!
    expect(gauge.title).toBe('HP 500 / 983')
    expect(gauge.attrs['aria-valuenow']).toBe('51')
    expect((frame.toggle as unknown as StubElement).title).toBe(mountFrameText(info()).toggleTip)
    frame.set(null)
    expect(frame.visible).toBe(false)
    expect(host.children).toEqual([])
    frame.dispose()
  })
})

// ---- the feature ----------------------------------------------------------------------------------------------------

interface Harness {
  f: WorldFeature
  sent: ClientMessage[]
  views: Map<number, EntityView>
  prefixes: Map<string, (rest: string, text: string) => void>
  toasts: string[]
  host: StubElement
  target: () => EntityView | null
  msg(m: ServerMessage): void
}

function harness(): Harness {
  const sent: ClientMessage[] = []
  const views = new Map<number, EntityView>()
  const prefixes = new Map<string, (rest: string, text: string) => void>()
  const toasts: string[] = []
  const host = new StubElement()
  let target: EntityView | null = null
  const ctx = {
    app: { catalog },
    scene,
    hud: { playerFrame: { petHost: host }, toast: (text: string) => toasts.push(text) },
    chat: {
      registerPrefix: (p: string, fn: (rest: string, text: string) => void) => {
        prefixes.set(p, fn)
        return () => prefixes.delete(p)
      },
    },
    send: (m: ClientMessage) => (sent.push(m), true),
    selfId: () => SELF,
    view: (id: number) => views.get(id),
    views: () => views.values(),
    setTarget: (v: EntityView | null) => (target = v),
    serverNow: () => 0,
  } as unknown as WorldFeatureContext
  const f = mountFeature(ctx)
  return { f, sent, views, prefixes, toasts, host, target: () => target, msg: m => f.onMessage?.(m) }
}

function addView(h: Harness, v: EntityView): EntityView {
  h.views.set(v.id, v)
  h.f.onEntityAdded?.(v)
  return v
}

describe('mount feature (MR-C)', () => {
  it('dismount-then-attack: stopAction, mountDismount, attack (the last two on the stop while moving)', () => {
    expect(dismountThenAttack(9, false)).toEqual({ now: [{ t: 'stopAction' }, { t: 'mountDismount' }, { t: 'attack', target: 9 }], afterStop: [] })
    expect(dismountThenAttack(9, true)).toEqual({ now: [{ t: 'stopAction' }], afterStop: [{ t: 'mountDismount' }, { t: 'attack', target: 9 }] })
  })

  it('clicking a monster while mounted steps down, then attacks, in order', () => {
    const h = harness()
    const self = addView(h, new EntityView(playerState({ mount: 40 }), entityCtx()))
    const mob = addView(h, new EntityView({ id: 9, kind: 'mob', name: 'Mangyang', model: 'MOB_CH_MANGNYANG', level: 3, pos: [8, 0, 5], yaw: 0 }, entityCtx()))
    expect(h.f.clickEntity?.(mob)).toBe(true)
    expect(h.sent).toEqual(dismountThenAttack(9, false).now)
    expect(h.target()).toBe(mob)

    // Moving: stop first; the rest goes out when our stop arrives (or the stopAction's answer, whichever first).
    h.sent.length = 0
    self.setMove({ from: [5, 0, 5], to: [30, 0, 5], speed: 9.9, startedAt: 0 })
    expect(h.f.clickEntity?.(mob)).toBe(true)
    expect(h.sent).toEqual([{ t: 'stopAction' }])
    h.msg({ t: 'stop', id: 99, pos: [0, 0, 0], yaw: 0 })
    expect(h.sent.length).toBe(1)
    h.msg({ t: 'stop', id: SELF, pos: [6, 0, 5], yaw: 0 })
    expect(h.sent).toEqual([{ t: 'stopAction' }, { t: 'mountDismount' }, { t: 'attack', target: 9 }])
    h.msg({ t: 'actionResult', re: 'stopAction', ok: true })
    expect(h.sent.length).toBe(3)

    // A ground click in between drops the waiting dismount.
    h.sent.length = 0
    expect(h.f.clickEntity?.(mob)).toBe(true)
    expect(h.f.beforeGroundMove?.()).toBe(false)
    h.msg({ t: 'stop', id: SELF, pos: [6, 0, 5], yaw: 0 })
    expect(h.sent).toEqual([{ t: 'stopAction' }])

    // On foot, the click is the world's (the default attack).
    h.sent.length = 0
    self.stop([6, 0, 5], 0)
    self.update(0, 0.016)
    applyMountUpdate(self.state, { mount: null })
    expect(self.state.mount).toBeUndefined()
    expect(h.f.clickEntity?.(mob)).toBe(false)
    expect(h.sent).toEqual([])
    h.f.dispose?.()
  })

  it('clicking your own parked horse rides it; a ridden one or someone else’s does nothing', () => {
    const h = harness()
    addView(h, new EntityView(playerState(), entityCtx()))
    const own = addView(h, new HorseView(cosState(), entityCtx())) as HorseView
    const other = addView(h, new HorseView(cosState({ id: 41, owner: 99 }), entityCtx())) as HorseView
    expect(h.f.clickEntity?.(own)).toBe(true)
    expect(h.sent).toEqual([{ t: 'mountRide', cos: 40 }])
    expect(h.f.clickEntity?.(other)).toBe(true)
    h.msg({ t: 'entityUpdate', id: 40, rider: SELF })
    expect(own.state.rider).toBe(SELF)
    expect(h.f.clickEntity?.(own)).toBe(true)
    expect(h.sent).toEqual([{ t: 'mountRide', cos: 40 }])
    h.f.dispose?.()
  })

  it("a ridden horse holds its spot on the rider's stop (the dismount's step aside); a warp releases it", () => {
    const h = harness()
    addView(h, new EntityView(playerState({ mount: 40 }), entityCtx()))
    const horse = addView(h, new HorseView(cosState({ rider: SELF }), entityCtx())) as HorseView
    h.msg({ t: 'stop', id: 99, pos: [0, 0, 0], yaw: 0 })
    expect(horse.held).toBe(false)
    h.msg({ t: 'stop', id: SELF, pos: [5, 0, 3.8], yaw: 0 })
    expect(horse.held).toBe(true)
    h.msg({ t: 'warp', id: SELF, pos: [50, 0, 50], yaw: 0 })
    expect(horse.held).toBe(false)
    h.f.dispose?.()
  })

  it('/dismount and /unsummon send the requests; refusals get the retail lines', () => {
    const h = harness()
    addView(h, new EntityView(playerState({ mount: 40 }), entityCtx()))
    h.prefixes.get(DISMOUNT_COMMAND)!('', DISMOUNT_COMMAND)
    h.prefixes.get(UNSUMMON_COMMAND)!('', UNSUMMON_COMMAND)
    expect(h.sent).toEqual([{ t: 'stopAction' }, { t: 'mountDismount' }, { t: 'mountDismiss' }])
    h.msg({ t: 'actionResult', re: 'mountRide', ok: false, reason: 'in_combat' })
    h.msg({ t: 'actionResult', re: 'mountDismount', ok: false, reason: 'moving' })
    h.msg({ t: 'actionResult', re: 'mountDismiss', ok: false, reason: 'rate_limited' })
    h.msg({ t: 'actionResult', re: 'attack', ok: false, reason: 'mounted' })
    expect(h.toasts).toEqual(['Cannot board a transport for 20 seconds after the end of combat.', 'Cannot step down while the transport is moving.'])
    expect(mountFailText('mounted')).toBe('Cannot do that while on a horse.')
    h.f.dispose?.()
    expect(h.prefixes.size).toBe(0)
  })

  it('the frame shows your horse’s HP in the pet host, and leaves with the horse', () => {
    const h = harness()
    addView(h, new EntityView(playerState({ mount: 40 }), entityCtx()))
    h.f.onFrame?.(0, 0.016)
    expect(h.host.children).toEqual([])
    const horse = addView(h, new HorseView(cosState({ rider: SELF, hp: 700 }), entityCtx())) as HorseView
    h.f.onFrame?.(16, 0.2)
    const frame = h.host.children[0]!
    expect(frame.find('mr-pet-hp')[0]!.title).toBe('HP 700 / 983')
    expect(frame.find('kit-btn-label')[0]!.textContent).toBe('Dismount')
    horse.setHp(250)
    h.f.onFrame?.(32, 0.2)
    expect(frame.find('mr-pet-hp')[0]!.title).toBe('HP 250 / 983')
    h.views.delete(40)
    h.f.onEntityRemoved?.(horse)
    horse.dispose()
    h.f.onFrame?.(48, 0.2)
    expect(h.host.children).toEqual([])
    h.f.dispose?.()
  })

  it('starts nothing on a bare context', () => {
    expect(mountFeature({} as WorldFeatureContext)).toEqual({})
  })
})
