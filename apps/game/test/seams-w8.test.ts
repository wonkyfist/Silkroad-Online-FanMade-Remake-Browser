/**
 * Wave-8 client seams (docs/WAVE_PLAN2.md §4.3, §6.2; W8-FC): the seven feature, i18n and mock lines; approachThen;
 * registerEntityKind / createEntityView; beforeGroundMove (the hold-to-move veto; the pointer call in screens/world.ts
 * needs a scene and is covered by the browser check); CharacterActor.useClipGroup('cart') and attachTo.
 * NullEngine; synthetic actors built in memory (no glb, no fetch) and a tiny DOM stub for the view's label.
 */
import {
  Animation,
  AnimationGroup,
  AssetContainer,
  MeshBuilder,
  NullEngine,
  Observable,
  PointerEventTypes,
  Scene,
  TransformNode,
  type PointerInfo,
} from '@babylonjs/core'
import type { ClientMessage, EntityState } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Catalog } from '../src/content/catalog.ts'
import { enAlchemy } from '../src/i18n/en-alchemy.ts'
import { enBerserk } from '../src/i18n/en-berserk.ts'
import { enDurability } from '../src/i18n/en-durability.ts'
import { enGuild } from '../src/i18n/en-guild.ts'
import { enMount } from '../src/i18n/en-mount.ts'
import { enStall } from '../src/i18n/en-stall.ts'
import { enTrade } from '../src/i18n/en-trade.ts'
import { en } from '../src/i18n/en.ts'
import { guildMock } from '../src/net/mock/guild.ts'
import { DEFAULT_MOCK_EXTENSIONS } from '../src/net/mock/index.ts'
import { stallMock } from '../src/net/mock/stall.ts'
import { tradeMock } from '../src/net/mock/trade.ts'
import { CharacterActor } from '../src/three/models.ts'
import { APPROACH_TIMEOUT_MS, approachThen, type ApproachContext } from '../src/world/approach.ts'
import { createEntityView, EntityView, registerEntityKind, type EntityContext } from '../src/world/entities.ts'
import { WORLD_FEATURES, WorldFeatures, type WorldFeatureContext } from '../src/world/features.ts'
import { MoveFeedback, vetoGroundMove, type GroundPoint } from '../src/world/move-feedback.ts'

// ---- a DOM stub for EntityView's label (the game tests run in node) --------------------------------------------------

class StubElement {
  className = ''
  textContent = ''
  hidden = false
  readonly style: Record<string, string> = {}
  readonly children: StubElement[] = []
  readonly classList = {
    toggle: (c: string, on?: boolean) => {
      const has = this.className.split(' ').includes(c)
      const want = on ?? !has
      if (want && !has) this.className = `${this.className} ${c}`.trim()
      if (!want && has) this.className = this.className.split(' ').filter(x => x !== c).join(' ')
      return want
    },
    add: (c: string) => void this.classList.toggle(c, true),
    remove: (c: string) => void this.classList.toggle(c, false),
    contains: (c: string) => this.className.split(' ').includes(c),
  }
  append(...c: unknown[]): void {
    for (const x of c) if (x instanceof StubElement) this.children.push(x)
  }
  insertBefore(c: StubElement): void {
    this.children.unshift(c)
  }
  remove(): void {}
}

let engine: NullEngine
let scene: Scene
const hadDocument = 'document' in globalThis

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  if (!hadDocument) (globalThis as { document?: unknown }).document = { createElement: () => new StubElement() }
})

afterAll(() => {
  if (!hadDocument) delete (globalThis as { document?: unknown }).document
  scene.dispose()
  engine.dispose()
})

// ---- lists ---------------------------------------------------------------------------------------------------------

describe('wave-8 lines (W8-FC)', () => {
  const SEVEN = ['mountFeature', 'berserkFeature', 'durabilityFeature', 'alchemyFeature', 'tradeFeature', 'stallFeature', 'guildFeature']

  it('appends the seven wave-8 features after wave 7B, in order', () => {
    expect(WORLD_FEATURES.map(f => f.name).slice(8, 10)).toEqual(['fxWorldFeature', 'postureFeature'])
    expect(WORLD_FEATURES.map(f => f.name).slice(10, 17)).toEqual(SEVEN)
  })

  // I8: the lanes filled the stubs, so the W8-FC "empty stub" checks became order checks.
  it('the lane features are factories; a feature with no beforeGroundMove never consumes a ground move', () => {
    for (const make of WORLD_FEATURES.slice(10)) expect(typeof make, make.name).toBe('function')
    const empty = () => ({})
    const fs = new WorldFeatures({} as WorldFeatureContext, [empty, empty])
    expect(fs.some(f => f.beforeGroundMove?.())).toBe(false)
    fs.dispose()
  })

  it('appends the trade, stall and guild mocks, in that order', () => {
    expect(DEFAULT_MOCK_EXTENSIONS.slice(-3)).toEqual([tradeMock, stallMock, guildMock])
    for (const m of [tradeMock, stallMock, guildMock]) expect(typeof m.handle).toBe('function')
  })

  it('spreads the seven lane string files into en', () => {
    for (const table of [enMount, enDurability, enAlchemy, enBerserk, enTrade, enStall, enGuild] as Record<string, string>[]) {
      for (const [k, v] of Object.entries(table)) expect(en[k as keyof typeof en], k).toBe(v)
    }
  })

  it('catalog.cos is a stub answering null until MR-C fills it', () => {
    expect(new Catalog([], {}, 'test').cos('COS_C_HORSE1')).toBeNull()
  })
})

// ---- approachThen --------------------------------------------------------------------------------------------------

interface FakeView {
  pos: { x: number; z: number }
  dead: boolean
  isDisposed: boolean
}

function approachSetup(self: [number, number], target: [number, number] | null) {
  const sent: ClientMessage[] = []
  const frames = new Observable<Scene>()
  const pointer = new Observable<PointerInfo>()
  const views = new Map<number, FakeView>()
  views.set(1, { pos: { x: self[0], z: self[1] }, dead: false, isDisposed: false })
  if (target) views.set(2, { pos: { x: target[0], z: target[1] }, dead: false, isDisposed: false })
  let now = 1000
  const ctx: ApproachContext = {
    scene: { onBeforeRenderObservable: frames, onPointerObservable: pointer } as unknown as ApproachContext['scene'],
    send: m => (sent.push(m), true),
    selfId: () => 1,
    view: id => views.get(id) as unknown as EntityView | undefined,
    serverNow: () => now,
  }
  const run = vi.fn()
  return {
    ctx,
    sent,
    run,
    views,
    frame: () => frames.notifyObservers(null as unknown as Scene),
    click: (button = 0) => pointer.notifyObservers({ type: PointerEventTypes.POINTERDOWN, event: { button } } as unknown as PointerInfo),
    at: (ms: number) => (now = ms),
    moveSelf: (x: number, z: number) => void (views.get(1)!.pos = { x, z }),
    observed: () => frames.hasObservers() || pointer.hasObservers(),
  }
}

describe('approachThen', () => {
  it('sends one moveTo range - 2 m short of the target and runs once on arrival', () => {
    const s = approachSetup([0, 0], [20, 0])
    approachThen(s.ctx, 2, 10, s.run)
    expect(s.sent).toEqual([{ t: 'moveTo', x: 12, z: 0 }])
    s.frame()
    expect(s.run).not.toHaveBeenCalled()
    s.moveSelf(10.5, 0)
    s.frame()
    expect(s.run).not.toHaveBeenCalled()
    s.moveSelf(11.5, 0)
    s.frame()
    s.frame()
    expect(s.run).toHaveBeenCalledTimes(1)
    expect(s.observed()).toBe(false)
    expect(s.sent.length).toBe(1)
  })

  it('another left click cancels (not the one that started it, not a right click); cancel is idempotent', () => {
    const s = approachSetup([0, 0], [20, 0])
    const cancel = approachThen(s.ctx, 2, 10, s.run)
    s.click()
    s.frame()
    s.click(2)
    expect(s.observed()).toBe(true)
    s.click()
    expect(s.observed()).toBe(false)
    s.moveSelf(19, 0)
    s.frame()
    expect(s.run).not.toHaveBeenCalled()
    expect(() => cancel()).not.toThrow()
  })

  it('gives up after 10 s, when the target despawns, or when a new approach starts', () => {
    const s = approachSetup([0, 0], [20, 0])
    approachThen(s.ctx, 2, 10, s.run)
    s.at(1000 + APPROACH_TIMEOUT_MS - 1)
    s.frame()
    expect(s.observed()).toBe(true)
    s.at(1000 + APPROACH_TIMEOUT_MS)
    s.frame()
    expect(s.observed()).toBe(false)
    s.moveSelf(19, 0)
    s.frame()
    expect(s.run).not.toHaveBeenCalled()

    const d = approachSetup([0, 0], [20, 0])
    approachThen(d.ctx, 2, 10, d.run)
    d.frame()
    d.views.delete(2)
    d.frame()
    expect(d.observed()).toBe(false)
    expect(d.run).not.toHaveBeenCalled()

    const n = approachSetup([0, 0], [20, 0])
    const second = vi.fn()
    approachThen(n.ctx, 2, 10, n.run)
    approachThen(n.ctx, 2, 10, second)
    n.moveSelf(15, 0)
    n.frame()
    expect(n.run).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('already in range: no walk, runs on the next frame; no target: nothing at all', () => {
    const s = approachSetup([0, 0], [5, 0])
    approachThen(s.ctx, 2, 10, s.run)
    expect(s.sent).toEqual([])
    expect(s.run).not.toHaveBeenCalled()
    s.frame()
    expect(s.run).toHaveBeenCalledTimes(1)

    const g = approachSetup([0, 0], null)
    approachThen(g.ctx, 2, 10, g.run)
    expect(g.sent).toEqual([])
    expect(g.observed()).toBe(false)
  })
})

// ---- registerEntityKind --------------------------------------------------------------------------------------------

function entityCtx(): EntityContext {
  return {
    scene,
    library: null,
    catalog: null,
    labels: new StubElement(),
    drops: null,
    heightAt: () => 0,
    selfId: () => 1,
    selfLevel: () => 5,
    serverNow: () => 0,
    attachments: [],
  } as unknown as EntityContext
}

const cosState: EntityState = { id: 40, kind: 'cos', name: 'Red Horse', model: 'COS_C_HORSE1', level: 20, pos: [0, 0, 0], yaw: 0 }
const playerState: EntityState = { id: 41, kind: 'player', name: 'Hero_1', model: 'CHAR_CH_MAN_ADVENTURER', level: 5, weapon: 'sword', pos: [0, 0, 0], yaw: 0 }

describe('registerEntityKind (D8)', () => {
  it('ignores an unregistered kind; a registered factory builds its view; unregister restores', () => {
    const ctx = entityCtx()
    expect(createEntityView(cosState, ctx)).toBeNull()
    class HorseView extends EntityView {}
    const factory = vi.fn((s: EntityState, c: EntityContext) => new HorseView(s, c))
    const off = registerEntityKind('cos', factory)
    const v = createEntityView(cosState, ctx)
    expect(v).toBeInstanceOf(HorseView)
    expect(factory).toHaveBeenCalledWith(cosState, ctx)
    expect(v!.id).toBe(40)
    v!.dispose()
    off()
    expect(createEntityView(cosState, ctx)).toBeNull()
  })

  it('builtin kinds stay plain EntityViews; a throwing factory is logged and ignored', () => {
    const ctx = entityCtx()
    const p = createEntityView(playerState, ctx)
    expect(p?.constructor).toBe(EntityView)
    p!.dispose()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const off = registerEntityKind('cos', () => {
      throw new Error('no horse')
    })
    expect(createEntityView(cosState, ctx)).toBeNull()
    expect(err).toHaveBeenCalled()
    off()
    err.mockRestore()
  })

  it('an older unregister does not remove a newer factory', () => {
    const ctx = entityCtx()
    const offA = registerEntityKind('cos', (s, c) => new EntityView(s, c))
    const offB = registerEntityKind('cos', (s, c) => new EntityView(s, c))
    offA()
    const v = createEntityView(cosState, ctx)
    expect(v).not.toBeNull()
    v!.dispose()
    offB()
    expect(createEntityView(cosState, ctx)).toBeNull()
  })
})

// ---- beforeGroundMove ------------------------------------------------------------------------------------------------

describe('beforeGroundMove', () => {
  function feedback() {
    const sent: ClientMessage[] = []
    let cursor: GroundPoint = { x: 10, z: 0 }
    const fb = new MoveFeedback({
      send: m => (sent.push(m), true),
      self: () => ({ x: 0, z: 0 }),
      cursorGround: () => cursor,
      holdToMove: () => true,
      rtt: () => 50,
      blocked: () => {},
    })
    return { sent, fb, setCursor: (p: GroundPoint) => (cursor = p) }
  }

  it('a consuming feature suppresses the hold-to-move moveTo and ends the hold', () => {
    const { sent, fb, setCursor } = feedback()
    const consume = { on: true }
    const features = new WorldFeatures({} as WorldFeatureContext, [() => ({}), () => ({ beforeGroundMove: () => consume.on })])
    const off = vetoGroundMove(() => features.some(f => f.beforeGroundMove?.()))
    fb.begin({ x: 10, z: 0 }, 0)
    setCursor({ x: 14, z: 3 })
    fb.tick(300)
    expect(sent).toEqual([])
    expect(fb.isHolding).toBe(false)
    consume.on = false
    fb.begin({ x: 14, z: 3 }, 400)
    setCursor({ x: 18, z: 3 })
    fb.tick(700)
    expect(sent).toEqual([{ t: 'moveTo', x: 18, z: 3 }])
    off()
    features.dispose()
  })

  it('a throwing veto is logged and allows', () => {
    const { sent, fb, setCursor } = feedback()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const off = vetoGroundMove(() => {
      throw new Error('veto')
    })
    fb.begin({ x: 10, z: 0 }, 0)
    setCursor({ x: 14, z: 3 })
    fb.tick(300)
    expect(sent.length).toBe(1)
    expect(err).toHaveBeenCalled()
    off()
    err.mockRestore()
  })
})

// ---- CharacterActor.useClipGroup / attachTo ------------------------------------------------------------------------

const JOINT = 'Bip01'

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

/** A slim-style actor: STAND1 / RUN in its glb, the cart clips only in a `cart` pack the startup filter skips. */
function slimActor(): CharacterActor {
  const body = contain(() => {
    const root = new TransformNode('__root__', scene)
    const joint = new TransformNode(JOINT, scene)
    joint.parent = root
    MeshBuilder.CreateBox('body', { size: 1 }, scene).parent = root
    for (const c of ['STAND1', 'RUN', 'WALK']) clip(c, joint)
  })
  const packs = {
    packs: { default: 'char/_anims/skel/default.glb', cart: 'char/_anims/skel/cart.glb' },
    clips: { STAND1_cart_stand01: ['cart', 'cart_stand01'], WALK_cart_walk: ['cart', 'cart_walk'], RUN_cart_walk: ['cart', 'cart_walk'] } as Record<string, [string, string]>,
  }
  return new CharacterActor(scene, { code: 'CHAR_CH_MAN_ADVENTURER', glb: '/out/test.glb' }, { container: body, sidecar: null, packs })
}

function cartPack(): AssetContainer {
  return contain(() => {
    const joint = new TransformNode(JOINT, scene)
    clip('cart_stand01', joint)
    clip('cart_walk', joint)
  })
}

const playing = (a: CharacterActor, name: string) => !!a.group(name)?.isPlaying

describe('CharacterActor clip groups and attachTo (D8)', () => {
  it("useClipGroup('cart') requests the cart pack once and switches the base clips; 'default' switches back", async () => {
    const a = slimActor()
    const loads: string[] = []
    a.loadPack = async rel => (loads.push(rel), cartPack())
    a.play('STAND1', true)
    expect(a.clipGroup).toBe('default')
    await Promise.all([a.useClipGroup('cart'), a.useClipGroup('cart')])
    expect(loads).toEqual(['char/_anims/skel/cart.glb'])
    expect(a.clipGroup).toBe('cart')
    expect(playing(a, 'STAND1_cart_stand01')).toBe(true)
    a.play('RUN')
    expect(playing(a, 'RUN_cart_walk')).toBe(true)
    await a.useClipGroup('default')
    expect(playing(a, 'RUN')).toBe(true)
    expect(playing(a, 'RUN_cart_walk')).toBe(false)
    await a.useClipGroup('cart')
    expect(loads.length).toBe(1)
    expect(playing(a, 'RUN_cart_walk')).toBe(true)
    a.dispose()
  })

  it('without a loader or a cart pack the default clips stay', async () => {
    const a = slimActor()
    a.play('STAND1', true)
    await a.useClipGroup('cart')
    expect(playing(a, 'STAND1')).toBe(true)
    a.dispose()
  })

  it('attachTo parents the root to a node and null puts it back', () => {
    const a = slimActor()
    const home = new TransformNode('view-root', scene)
    const saddle = new TransformNode('saddle', scene)
    a.root.parent = home
    expect(a.attachedTo).toBeNull()
    a.attachTo(saddle)
    expect(a.root.parent).toBe(saddle)
    expect(a.attachedTo).toBe(saddle)
    a.attachTo(saddle)
    a.attachTo(null)
    expect(a.root.parent).toBe(home)
    expect(a.attachedTo).toBeNull()
    a.attachTo(null)
    expect(a.root.parent).toBe(home)
    a.dispose()
    saddle.dispose()
    home.dispose()
  })
})
