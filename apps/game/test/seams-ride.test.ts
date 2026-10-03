/**
 * Wave 11 step-0 seams of apps/game (docs/WAVE_PLAN7.md §4.4, lane W11-G):
 * - the actor seams (UNIQUES U-SEAM-C): `companion` mirrors every clip call, never resumes its own base while its
 *   driver acts, `lodLeader` copies the leader's animation-LOD decision and cull, the height hook; an actor without
 *   them is today's (its node tree, its clips);
 * - the ride load hook in EntityView.load (a stub ride: `setYaw` and the scale act on the ride's root only);
 * - the notice dispatch (app.ts → hud/unique-notice.ts, the mock's frames reach the stub; en-unique registered);
 * - the town wiring of world/graphics.ts (Town life, the clock and the threats for each town part; nothing on Low);
 * - the town pick (ux-world): a click on the ground with a town pick still yields the move intent.
 */
import {
  Animation,
  AnimationGroup,
  ArcRotateCamera,
  AssetContainer,
  DirectionalLight,
  HemisphericLight,
  MeshBuilder,
  NullEngine,
  PointerEventTypes,
  Quaternion,
  Scene,
  Skeleton,
  TransformNode,
  Vector3,
  type PointerInfo,
} from '@babylonjs/core'
import type { EntityState, ServerMessage } from '@sro/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const rideMock = vi.hoisted(() => ({ load: null as null | ((rider: unknown) => unknown) }))
vi.mock('../src/world/ride-mob.ts', () => ({
  loadRide: async (_ctx: unknown, rider: unknown) => (rideMock.load ? rideMock.load(rider) : null),
}))

import { App } from '../src/app.ts'
import { UNIQUE_ALARM_S, showUniqueNotice, uniqueChatLine, uniqueNoticeLog } from '../src/hud/unique-notice.ts'
import { en } from '../src/i18n/en.ts'
import { enUnique } from '../src/i18n/en-unique.ts'
import { uniquesMock } from '../src/net/mock/uniques.ts'
import { SettingsStore } from '../src/settings.ts'
import { CharacterActor, ModelLibrary } from '../src/three/models.ts'
import { EntityView, type EntityContext } from '../src/world/entities.ts'
import { WORLD_FEATURES } from '../src/world/features.ts'
import { addTownPick, runTownClick, runTownHover, townPickCount } from '../src/world/features/ux-world.ts'
import { townFeature } from '../src/world/features/town.ts'
import { WorldGraphics, characterMeshes, worldTown } from '../src/world/graphics.ts'
import { loadRide } from '../src/world/ride-mob.ts'

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
let library: ModelLibrary
let clock = 0
const hadDocument = 'document' in globalThis
const cleanups: Array<() => void> = []

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
  scene.useConstantAnimationDeltaTime = true // 16 ms of animation time per frame
  const camera = new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 2, 10, Vector3.Zero(), scene)
  camera.minZ = 0.2
  camera.maxZ = 2000
  library = new ModelLibrary(scene)
  library.now = () => clock
  if (!hadDocument) (globalThis as { document?: unknown }).document = { createElement: () => new StubElement() }
})

afterEach(() => {
  rideMock.load = null
  library.animLod = false
  for (const c of cleanups.splice(0)) c()
})

afterAll(() => {
  if (!hadDocument) delete (globalThis as { document?: unknown }).document
  library.dispose()
  scene.dispose()
  engine.dispose()
})

const FRAME_MS = 16
const frame = (n = 1) => {
  for (let i = 0; i < n; i++) {
    clock += FRAME_MS
    scene.render()
  }
}

/**
 * A synthetic actor registered with the library (as ModelLibrary.character does): one joint `J`, a body box of
 * `height` metres, and the clips `frames` (name → 30 fps frame count; STAND1, RUN and STUN loop).
 */
function makeActor(code: string, frames: Record<string, number>, height = 2): CharacterActor {
  const root = new TransformNode('__root__', scene)
  const joint = new TransformNode('J', scene)
  joint.parent = root
  const body = MeshBuilder.CreateBox(`${code}_body`, { width: 1, height, depth: 1 }, scene)
  body.position.y = height / 2
  body.parent = root
  const skeleton = new Skeleton(`${code}_skel`, `${code}_skel`, scene)
  body.skeleton = skeleton
  const c = new AssetContainer(scene)
  c.transformNodes.push(root, joint)
  c.meshes.push(body)
  c.skeletons.push(skeleton)
  for (const [name, n] of Object.entries(frames)) {
    const anim = new Animation(`${code}_${name}_x`, 'position', 30, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE)
    anim.setKeys([
      { frame: 0, value: new Vector3(0, 0, 0) },
      { frame: n, value: new Vector3(1, 0, 0) },
    ])
    const g = new AnimationGroup(name, scene)
    g.addTargetedAnimation(anim, joint)
    c.animationGroups.push(g)
  }
  c.removeAllFromScene()
  const a = new CharacterActor(scene, { code, glb: `/out/${code}.glb` }, { container: c, sidecar: null, packs: null })
  const actors = (library as unknown as { actors: Set<CharacterActor> }).actors
  actors.add(a)
  a.root.onDisposeObservable.addOnce(() => actors.delete(a))
  cleanups.push(() => a.dispose())
  return a
}

/** Tiger Girl's clip lengths in miniature: her ATTACK2 4,000 ms, the tiger's 3,333 ms; both have a (typo'd) STUN. */
const RIDER_CLIPS = { STAND1: 30, RUN: 20, ATTACK2: 120, DAMAGE1: 10, DIE1: 30, DIE1_RM: 30, STUN: 30 }
const TIGER_CLIPS = { STAND1: 30, RUN: 20, ATTACK2: 100, DAMAGE1: 10, DIE1: 30, DIE1_RM: 30, STUN: 30 }

function composite() {
  const rider = makeActor('MOB_RIDER', RIDER_CLIPS)
  const tiger = makeActor('MOB_RIDE', TIGER_CLIPS, 3.2)
  const seat = new TransformNode('seat', scene)
  seat.parent = tiger.root
  seat.position.y = 2.6
  rider.root.parent = seat
  rider.companion = tiger
  rider.lodLeader = tiger
  return { rider, tiger, seat }
}

const playing = (a: CharacterActor, name: string) => !!a.group(name)?.isPlaying

/** The node tree under `node`, names with their serials masked. */
function tree(node: TransformNode, depth = 0): string[] {
  const out = [`${'  '.repeat(depth)}${node.name.replace(/\d+/g, '#')}`]
  for (const c of node.getChildren()) if (c instanceof TransformNode) out.push(...tree(c, depth + 1))
  return out
}

// ---- the actor seams (UNIQUES U-SEAM-C) -----------------------------------------------------------------------------

describe('CharacterActor companion and lodLeader (U-SEAM-C)', () => {
  it('an actor without them is today\'s: its node tree, no companion, its own height and clips', () => {
    const a = makeActor('MOB_PLAIN', RIDER_CLIPS)
    expect(a.companion).toBeNull()
    expect(a.lodLeader).toBeNull()
    expect(a.heightHook).toBeNull()
    expect(tree(a.root)).toEqual(['actor#:MOB_PLAIN', '  __root__', '    J', '    MOB_PLAIN_body'])
    expect(a.height).toBeCloseTo(2, 5)
    a.play('STAND1')
    frame()
    expect(playing(a, 'STAND1')).toBe(true)
    a.playClip('ATTACK2')
    frame(Math.round(4200 / FRAME_MS))
    // Its own base resumes after the one-shot, as before wave 11.
    expect(playing(a, 'STAND1')).toBe(true)
  })

  it('the companion receives every mirrored call with its own clip of the same name', () => {
    const { rider, tiger } = composite()
    expect(rider.companion).toBe(tiger)
    rider.play('STAND1')
    frame()
    expect(playing(tiger, 'STAND1')).toBe(true)
    rider.play('RUN')
    frame()
    expect(playing(rider, 'RUN') && playing(tiger, 'RUN')).toBe(true)
    // playAction by clip name; cancelAction ends both and both go back to the base.
    rider.playClip('ATTACK2')
    frame()
    expect(playing(rider, 'ATTACK2') && playing(tiger, 'ATTACK2')).toBe(true)
    expect(rider.cancelAction(n => n === 'ATTACK2')).toBe(true)
    frame()
    expect(playing(rider, 'RUN') && playing(tiger, 'RUN')).toBe(true)
    expect(playing(tiger, 'ATTACK2')).toBe(false)
    // hurt (a full DAMAGE1 while idle)
    rider.play('STAND1')
    frame()
    rider.hurt()
    frame()
    expect(playing(rider, 'DAMAGE1') && playing(tiger, 'DAMAGE1')).toBe(true)
    frame(20)
    // STUN (a skill action) plays STAND1 on the companion, never its typo'd STUN.
    const token = rider.playSkill([{ clip: rider.group('STUN')!, ms: 400, loop: true }])
    frame()
    expect(playing(rider, 'STUN')).toBe(true)
    expect(playing(tiger, 'STUN')).toBe(false)
    expect(playing(tiger, 'STAND1')).toBe(true)
    rider.stopSkill(token)
    frame()
    expect(playing(rider, 'STAND1') && playing(tiger, 'STAND1')).toBe(true)
    // opacity, highlight, enabled
    rider.setOpacity(0.4)
    expect(tiger.meshes.every(m => m.visibility === 0.4)).toBe(true)
    rider.setHighlight(true)
    expect(tiger.meshes.every(m => m.renderOverlay)).toBe(true)
    rider.setHighlight(false)
    expect(tiger.meshes.some(m => m.renderOverlay)).toBe(false)
    rider.setEnabled(false)
    expect(tiger.root.isEnabled(false)).toBe(false)
    rider.setEnabled(true)
    // die and revive
    rider.die()
    expect(rider.isDead && tiger.isDead).toBe(true)
    frame()
    expect(playing(tiger, 'DIE1')).toBe(true)
    rider.revive()
    expect(rider.isDead || tiger.isDead).toBe(false)
    frame()
    expect(playing(tiger, 'STAND1')).toBe(true)
    // dispose takes both, and cuts the LOD link.
    rider.dispose()
    expect(tiger.isDisposed).toBe(true)
    expect(rider.lodLeader).toBeNull()
  })

  it('the companion never restarts its own base after an action: it holds until the leader resumes, then both resume', () => {
    const { rider, tiger } = composite()
    rider.play('STAND1')
    frame()
    rider.playClip('ATTACK2')
    // 3.5 s: the tiger's ATTACK2 (3.333 s) has ended, hers (4.0 s) still plays: the tiger holds its last frame.
    frame(Math.round(3500 / FRAME_MS))
    expect(playing(rider, 'ATTACK2')).toBe(true)
    expect(playing(tiger, 'ATTACK2')).toBe(false)
    expect(playing(tiger, 'STAND1')).toBe(false)
    // 4.2 s: her ATTACK2 has ended; her resume restarts both bases together.
    frame(Math.round(700 / FRAME_MS))
    expect(playing(rider, 'STAND1') && playing(tiger, 'STAND1')).toBe(true)
  })

  it('a companion\'s own reaction (the leader acting nothing) still resumes its base', () => {
    const { rider, tiger } = composite()
    rider.play('STAND1')
    frame()
    tiger.playClip('DAMAGE1')
    frame(Math.round(500 / FRAME_MS))
    expect(playing(tiger, 'STAND1')).toBe(true)
  })

  it('lodLeader: with the LOD on and the camera far away, the two skip exactly the same frames for 300 frames', () => {
    library.animLod = true
    const { rider, tiger } = composite()
    tiger.root.position.set(0, 0, 400)
    rider.play('RUN')
    frame(5)
    let skipped = 0
    for (let i = 0; i < 300; i++) {
      frame()
      expect(rider.lodSkipping, `frame ${i}`).toBe(tiger.lodSkipping)
      expect(rider.isOffscreen).toBe(tiger.isOffscreen)
      if (tiger.lodSkipping) skipped++
    }
    expect(skipped).toBeGreaterThan(100)
  })

  it('the height hook gives the composite height (a non-finite or zero value falls back)', () => {
    const { rider } = composite()
    expect(rider.height).toBeCloseTo(2, 5)
    rider.heightHook = () => 3.0
    expect(rider.height).toBe(3)
    rider.heightHook = () => Number.NaN
    expect(rider.height).toBeCloseTo(2, 5)
    rider.heightHook = null
  })

  it('setCullSphere takes a composite sphere; a bad one is ignored', () => {
    const a = makeActor('MOB_SPHERE', RIDER_CLIPS)
    a.setCullSphere({ y: 1.6, r: 9 })
    expect(a.cullSphereLocal).toEqual({ y: 1.6, r: 9 })
    a.setCullSphere({ y: 1, r: -1 })
    expect(a.cullSphereLocal).toEqual({ y: 1.6, r: 9 })
  })
})

// ---- the ride load hook (world/entities.ts) -------------------------------------------------------------------------

const MOB_STATE: EntityState = { id: 70, kind: 'mob', name: 'Tiger Girl', model: 'MOB_CH_TIGERWOMAN', level: 30, pos: [0, 0, 0], yaw: 1 }

function entityCtx(actors: { rider: CharacterActor }, ride: boolean): EntityContext {
  return {
    scene,
    library: { character: async () => actors.rider },
    catalog: {
      mob: () => ({
        code: 'MOB_CH_TIGERWOMAN',
        name: 'Tiger Girl',
        level: 30,
        model: { code: 'MOB_CH_TIGERWOMAN', glb: '/out/mob/tigerwoman.glb' },
        scale: 1.5,
        radius: 2.8,
        ...(ride ? { ride: { model: { code: 'MOB_CH_TIGERWOMAN#ride', glb: '/out/mob/bluetiger.glb' }, joint: 'saddle' } } : {}),
      }),
      content: { mobs: new Map() },
      item: () => undefined,
    },
    labels: new StubElement(),
    drops: null,
    heightAt: () => 0,
    selfId: () => 1,
    selfLevel: () => 5,
    serverNow: () => 0,
    attachments: [],
  } as unknown as EntityContext
}

describe('EntityView ride load hook', () => {
  it('no ride: the actor hangs under the entity root as today, turned and scaled itself', async () => {
    const rider = makeActor('MOB_CH_TIGERWOMAN', RIDER_CLIPS)
    const v = new EntityView(MOB_STATE, entityCtx({ rider }, false))
    cleanups.push(() => v.dispose())
    await v.load()
    expect(v.ride).toBeNull()
    expect(rider.root.parent).toBe(v.root)
    expect(tree(v.root)).toEqual(['entity#:#', '  pick#', '  actor#:MOB_CH_TIGERWOMAN', '    __root__', '      J', '      MOB_CH_TIGERWOMAN_body'])
    expect(rider.root.scaling.x).toBeCloseTo(1.5, 9)
    v.update(0, 0.016)
    const yaw = rider.root.rotationQuaternion!.toEulerAngles().y
    expect(yaw).toBeCloseTo(1, 5)
  })

  it('the stub ride loader draws no ride (the rider stands alone)', async () => {
    const rider = makeActor('MOB_CH_TIGERWOMAN', RIDER_CLIPS)
    expect(await loadRide({ library }, rider, { model: { code: 'x', glb: '/out/x.glb' }, joint: 'saddle' })).toBeNull()
  })

  it('a ride: its root takes the rider\'s place; setYaw and the scale act on the ride\'s root only; dispose takes both', async () => {
    const rider = makeActor('MOB_CH_TIGERWOMAN', RIDER_CLIPS)
    const tiger = makeActor('MOB_RIDE', TIGER_CLIPS, 3.2)
    const disposeRide = vi.fn()
    rideMock.load = r => {
      const seat = new TransformNode('seat', scene)
      seat.parent = tiger.root
      ;(r as CharacterActor).root.parent = seat
      ;(r as CharacterActor).companion = tiger
      ;(r as CharacterActor).lodLeader = tiger
      return { actor: tiger, dispose: disposeRide }
    }
    const v = new EntityView(MOB_STATE, entityCtx({ rider }, true))
    await v.load()
    expect(v.actor).toBe(rider)
    expect(v.ride?.actor).toBe(tiger)
    expect(tiger.root.parent).toBe(v.root)
    expect(rider.root.parent?.name).toBe('seat')
    expect(tiger.root.scaling.x).toBeCloseTo(1.5, 9)
    expect(rider.root.scaling.x).toBe(1)
    v.update(0, 0.016)
    expect(tiger.root.rotationQuaternion!.toEulerAngles().y).toBeCloseTo(1, 5)
    // The rider's root rotation relative to the seat is unchanged.
    expect(rider.root.rotationQuaternion!.equalsWithEpsilon(Quaternion.Identity(), 1e-9)).toBe(true)
    // The shadow casters and the like see one root carrying both.
    const meshes = characterMeshes(v)
    expect(meshes.some(m => m.name === 'MOB_RIDE_body') && meshes.some(m => m.name === 'MOB_CH_TIGERWOMAN_body')).toBe(true)
    v.dispose()
    expect(disposeRide).toHaveBeenCalledTimes(1)
    expect(rider.isDisposed && tiger.isDisposed).toBe(true)
  })
})

// ---- notices (app.ts dispatch; hud/unique-notice.ts stub; en-unique.ts) -------------------------------------------

describe('uniqueNotice dispatch', () => {
  it('the mock\'s notices reach showUniqueNotice through app.ts; GM notices still reach the banner', () => {
    // The mock's frames (net/mock/uniques.ts, W11-P).
    const broadcast: ServerMessage[] = []
    let now = 1_000_000
    const ctx = {
      content: { mobs: new Map([['MOB_CH_TIGERWOMAN', { name: 'Tiger Girl' }]]) },
      now: () => now,
      selfOf: () => ({ state: { name: 'Mei' } }),
      send: () => {},
      broadcast: (m: ServerMessage) => broadcast.push(m),
    } as unknown as Parameters<NonNullable<typeof uniquesMock.handle>>[0]
    uniquesMock.handle!(ctx, { role: 'gm' } as Parameters<NonNullable<typeof uniquesMock.handle>>[1], { t: 'chat', text: '/unique spawn tiger' })
    now += 60_000
    uniquesMock.tick!(ctx, now)
    expect(broadcast.map(m => (m.t === 'uniqueNotice' ? m.event : m.t))).toEqual(['appeared', 'defeated'])
    // App.setSession's message hook on a stand-in app (its banner queue and audio).
    let listener: ((m: ServerMessage) => void) | null = null
    const session = { on: (fn: (m: ServerMessage) => void) => ((listener = fn), () => {}), onStatus: () => () => {}, close: () => {} }
    const shown: string[] = []
    const fakeApp = { session: null, sessionOff: null, notices: { show: (text: string) => shown.push(text) }, audio: null, showBanner: () => {} }
    App.prototype.setSession.call(fakeApp as unknown as App, session as never)
    uniqueNoticeLog.length = 0
    for (const m of broadcast) listener!(m)
    listener!({ t: 'notice', text: 'Server restart soon' })
    expect(uniqueNoticeLog.map(m => m.event)).toEqual(['appeared', 'defeated'])
    expect(shown).toEqual(['Server restart soon'])
    // U-H's chat line (unique-notice.test.ts covers the forms); the alarm lasts a minute (D19).
    expect(uniqueChatLine(uniqueNoticeLog[0]!)).toBe('[Unique] Tiger Girl has appeared! Area: North-Tiger Mt.')
    expect(UNIQUE_ALARM_S).toBe(60)
    showUniqueNotice(uniqueNoticeLog[0]!, { notices: {} as never, audio: null })
  })

  it('en-unique.ts is registered in en.ts', () => {
    for (const [k, v] of Object.entries(enUnique)) expect((en as Record<string, string>)[k], k).toBe(v)
    expect(typeof enUnique).toBe('object')
  })
})

// ---- the town: graphics link, feature stub, town pick ---------------------------------------------------------------

/** A world as WorldGraphics sees it (seams-w10.test.ts' fake) with W11-S's town seams. */
function fakeWorld(mode: 'classic' | 'pbr', preset: 'low' | 'medium' = mode === 'pbr' ? 'medium' : 'low') {
  const makeTown = () => ({ setClock: vi.fn(), setThreats: vi.fn(), configure: vi.fn(), alarm: vi.fn(), setEnabled: vi.fn() })
  const w: Record<string, unknown> & { render: { mode: 'classic' | 'pbr' }; town: ReturnType<typeof makeTown> | null } = {
    quality: preset,
    render: { mode, post: null, activeCamera: {}, gpu: { features: [] as string[] }, attachCamera: vi.fn(), addCharacter: vi.fn(), removeCharacter: vi.fn() },
    stream: { setSettings: vi.fn() },
    materials: { pbr: { decorateCharacterMaterial: vi.fn() } },
    skyStyle: 'modern',
    objects: { setRangeScale: vi.fn(), setAnimatedVisible: vi.fn() },
    water: { setVisible: vi.fn() },
    scatter: { setLevel: vi.fn() },
    setQuality: vi.fn(),
    setRenderMode: vi.fn((m: 'classic' | 'pbr') => {
      w.render.mode = m
      w.town = m === 'pbr' ? makeTown() : null
    }),
    setSkyStyle: vi.fn(),
    isolateLights: vi.fn(),
    setBatching: vi.fn(),
    life: null,
    setTownLife: vi.fn(),
    town: mode === 'pbr' ? makeTown() : null,
  }
  return w
}

function link(w: Record<string, unknown>, store: SettingsStore, extra: object = {}) {
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
  const sun = new DirectionalLight('sun', new Vector3(0, -1, 0), scene)
  const g = new WorldGraphics({ world: w as never, camera: {} as never, lights: { hemi, sun }, store, rollout: 'on', ...extra })
  cleanups.push(() => {
    g.dispose()
    hemi.dispose()
    sun.dispose()
  })
  return g
}

const storeWith = (graphics: object) => {
  const s = new SettingsStore(null)
  s.set({ graphics: { firstRun: false, ...graphics } })
  return s
}

describe('graphics link: Town life (W11-G)', () => {
  it('Medium: World.setTownLife full, the clock and the threats reach the town once; Low halves; Off', () => {
    const w = fakeWorld('pbr')
    const store = storeWith({ preset: 'medium' })
    const townClock = () => 12
    const threats = () => []
    link(w, store, { townClock, threats })
    const town = w.town!
    expect(w.setTownLife).toHaveBeenLastCalledWith('full')
    expect(town.setClock).toHaveBeenCalledWith(townClock)
    expect(town.setThreats).toHaveBeenCalledWith(threats)
    store.set({ graphics: { townLife: 'low' } })
    expect(w.setTownLife).toHaveBeenLastCalledWith('low')
    store.set({ graphics: { townLife: 'off' } })
    expect(w.setTownLife).toHaveBeenLastCalledWith('off')
    store.set({ graphics: { sight: 1 } })
    expect(w.setTownLife).toHaveBeenCalledTimes(3)
    expect(town.setClock).toHaveBeenCalledTimes(1)
    expect(worldTown(w as never)).toBe(town)
  })

  it('Low: no town and Off; a switch to PBR wires the new town part', () => {
    const w = fakeWorld('classic')
    const store = storeWith({ preset: 'low' })
    const townClock = () => 1
    link(w, store, { townClock })
    expect(w.town).toBeNull()
    expect(w.setTownLife).toHaveBeenLastCalledWith('off')
    store.set({ graphics: { preset: 'medium' } })
    expect(w.setRenderMode).toHaveBeenLastCalledWith('pbr')
    expect(w.town!.setClock).toHaveBeenCalledWith(townClock)
    expect(w.setTownLife).toHaveBeenLastCalledWith('full')
    store.set({ graphics: { preset: 'low' } })
    expect(w.town).toBeNull()
    expect(w.setTownLife).toHaveBeenLastCalledWith('off')
  })

  it('a town part the world makes outside apply() is wired on its next frame', () => {
    const w = fakeWorld('pbr')
    const g = link(w, storeWith({ preset: 'medium' }), { townClock: () => 3 })
    const next = { setClock: vi.fn(), setThreats: vi.fn() }
    w.town = next as never
    g.frame(16, false)
    expect(next.setClock).toHaveBeenCalledTimes(1)
  })
})

describe('the town feature stub and the town pick (D11)', () => {
  it('the town feature is registered before the jump (which stays last) and does nothing yet', () => {
    expect(WORLD_FEATURES).toContain(townFeature)
    expect(WORLD_FEATURES.indexOf(townFeature)).toBe(WORLD_FEATURES.length - 2)
    expect(townFeature({} as never)).toEqual({})
  })

  it('a click on the ground with a town pick still yields the move intent (the pick runs after it and never consumes it)', () => {
    const sent: string[] = []
    // The world screen's pointer observer first (screens/world.ts: entity pick, else the move intent) …
    const screenObs = scene.onPointerObservable.add(pi => {
      if (pi.type === PointerEventTypes.POINTERDOWN && pi.event.button === 0) sent.push('moveTo')
    })
    // … then ux-world's, which asks the town pick.
    const uxObs = scene.onPointerObservable.add(pi => {
      if (pi.type === PointerEventTypes.POINTERDOWN && pi.event.button === 0) runTownClick(1, 2)
    })
    const order: string[] = []
    const off = addTownPick({
      click: (x, y) => {
        order.push(`town ${x},${y} after ${sent.length}`)
        return true as never // a pick that claims the click changes nothing
      },
      hover: () => true,
    })
    const offBad = addTownPick({
      click: () => {
        throw new Error('broken pick')
      },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(townPickCount()).toBe(2)
    scene.onPointerObservable.notifyObservers({ type: PointerEventTypes.POINTERDOWN, event: { button: 0 } } as PointerInfo)
    scene.onPointerObservable.notifyObservers({ type: PointerEventTypes.POINTERDOWN, event: { button: 0 } } as PointerInfo)
    expect(sent).toEqual(['moveTo', 'moveTo'])
    expect(order).toEqual(['town 1,2 after 1', 'town 1,2 after 2'])
    expect(runTownHover(0, 0)).toBe(true)
    off()
    offBad()
    warn.mockRestore()
    expect(townPickCount()).toBe(0)
    expect(runTownHover(0, 0)).toBe(false)
    scene.onPointerObservable.remove(screenObs)
    scene.onPointerObservable.remove(uxObs)
  })
})
