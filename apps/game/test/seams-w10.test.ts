/**
 * Wave-10 client seams in apps/game (docs/WAVE_PLAN6.md §4.2, W10-G): the movement hooks (KEEP_CLIPS, the empty
 * `playMove` / `movementClip`, the base resume frame, the `jump` branch of EntityView behind `hasMovementClips`, the
 * `jump` intent, the registered movement feature and its string file) and the graphics link's calls (World batching,
 * the wildlife and its threats, the grass style) on a world with and without W10-S's seams.
 */
import { Animation, AnimationGroup, AssetContainer, DirectionalLight, HemisphericLight, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import { validateClientMessage } from '@sro/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../src/i18n/en.ts'
import { enMovement } from '../src/i18n/en-movement.ts'
import { SettingsStore, type GpuHint } from '../src/settings.ts'
import { CharacterActor, KEEP_CLIPS } from '../src/three/models.ts'
import { EntityView } from '../src/world/entities.ts'
import { WORLD_FEATURES, type WorldFeatureContext } from '../src/world/features.ts'
import { movementFeature } from '../src/world/features/movement.ts'
import { BATCHING_AT_LOAD, WorldGraphics, actorThreats } from '../src/world/graphics.ts'
import { intents } from '../src/world/intents.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

// ---- movement (MOVEMENT §6, jump only) -----------------------------------------------------------------------------

describe('movement seams (MV-C fills them)', () => {
  it('KEEP_CLIPS keeps JUMP, JUMP_RUN and JUMP_RUN_FIST, and nothing else new', () => {
    for (const name of ['JUMP', 'JUMP_RUN', 'JUMP_RUN_FIST']) expect(KEEP_CLIPS.test(name), name).toBe(true)
    for (const name of ['JUMPY', 'XJUMP', 'SKILL_JUMP']) expect(KEEP_CLIPS.test(name), name).toBe(false)
    // The wave-9 set is unchanged.
    for (const name of ['STAND1', 'RUN', 'SKILL_3', 'STUN_A', 'VENDOR01']) expect(KEEP_CLIPS.test(name), name).toBe(true)
  })

  /** An actor with STAND1, RUN (y = frame / 10 over 0..30) and a JUMP clip in its groups (a pack MV-C has not wired). */
  function actor() {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const root = new TransformNode('__root__', scene)
    const node = new TransformNode('Bip01 Pelvis', scene)
    node.parent = root
    for (const name of ['STAND1', 'RUN', 'JUMP']) {
      const g = new AnimationGroup(name, scene)
      const an = new Animation(`${name}:y`, 'position.y', 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE)
      an.setKeys([{ frame: 0, value: 0 }, { frame: 30, value: 3 }])
      g.addTargetedAnimation(an, node)
    }
    const c = new AssetContainer(scene)
    c.moveAllFromScene()
    const a = new CharacterActor(scene, { code: 'CHAR_CH_MAN_ADVENTURER', glb: '/out/t.glb' }, { container: c, sidecar: null, packs: null })
    cleanups.push(() => {
      a.dispose()
      scene.dispose()
      engine.dispose()
    })
    return a
  }

  it('no movement pack: nothing plays and nothing throws', () => {
    const a = actor()
    a.play('STAND1')
    expect(a.hasMovementClips).toBe(false)
    expect(a.movementClip('jump')).toBeUndefined()
    expect(a.playMove('jump', { at: 1000, now: 1100 })).toBe(false)
    expect(a.group('JUMP')!.isPlaying).toBeFalsy()
    expect(a.group('STAND1')!.isPlaying).toBe(true)
    // EntityView's jump branch: false for an actor without the clips, a view without an actor, and a corpse.
    const jump = EntityView.prototype.jump
    expect(jump.call({ actor: a, dead: false } as unknown as EntityView, 1000, 1100)).toBe(false)
    expect(jump.call({ actor: null, dead: false } as unknown as EntityView, 1000, 1100)).toBe(false)
    expect(jump.call({ actor: a, dead: true } as unknown as EntityView, 1000, 1100)).toBe(false)
  })

  it('an action can hand the base back at a resume frame (the JUMP_RUN exit phase); without one the base starts over', () => {
    const a = actor()
    a.play('RUN')
    const run = a.group('RUN')!
    const jump = a.group('JUMP')!
    a.playAction(jump, 1, 15)
    expect(run.isPlaying).toBe(false)
    jump.stop() // the end observer restarts the base
    expect(run.isPlaying).toBe(true)
    expect(run.animatables[0]!.masterFrame).toBeCloseTo(15, 3)
    a.playAction(jump)
    jump.stop()
    expect(run.animatables[0]!.masterFrame).toBeCloseTo(0, 3)
    // A resume frame outside the clip is ignored (the loop starts at its first frame).
    a.playAction(jump, 1, 99)
    jump.stop()
    expect(run.animatables[0]!.masterFrame).toBeCloseTo(0, 3)
  })

  it('the jump intent passes the shared validator; the feature is registered last (MV-C fills it: test/movement.test.ts)', () => {
    expect(intents.jump()).toEqual({ t: 'jump' })
    expect(validateClientMessage(intents.jump()).ok).toBe(true)
    expect(WORLD_FEATURES.at(-1)).toBe(movementFeature)
    // MV-C: the feature binds Space in the movement group (its behaviour is pinned in test/movement.test.ts).
    const bound: string[][] = []
    const ctx = { keys: { register: (b: { keys: string[] }) => (bound.push(b.keys), () => {}) }, addAttachment: () => () => {}, views: () => [][Symbol.iterator](), selfId: () => null } as unknown as WorldFeatureContext
    movementFeature(ctx).dispose?.()
    expect(bound).toEqual([[' ']])
    for (const [k, v] of Object.entries(enMovement)) expect((en as Record<string, string>)[k], k).toBe(v)
  })
})

// ---- the graphics link (world/graphics.ts) --------------------------------------------------------------------------

/** A world as World.setQuality & co. see it (bloom-options.test.ts' fake), with W10-S's seams when `seams`. */
function fakeWorld(mode: 'classic' | 'pbr', seams: boolean, preset: 'low' | 'medium' = mode === 'pbr' ? 'medium' : 'low') {
  const life = { setEnabled: vi.fn(), setThreats: vi.fn() }
  const w: Record<string, unknown> & { render: { mode: 'classic' | 'pbr' } } = {
    quality: preset,
    render: {
      mode,
      post: null,
      activeCamera: {},
      gpu: { features: [] as string[] },
      attachCamera: vi.fn(),
      addCharacter: vi.fn(),
      removeCharacter: vi.fn(),
    },
    stream: { setSettings: vi.fn() },
    materials: { pbr: { decorateCharacterMaterial: vi.fn() } },
    skyStyle: 'modern',
    objects: { setRangeScale: vi.fn(), setAnimatedVisible: vi.fn() },
    water: { setVisible: vi.fn() },
    scatter: { setLevel: vi.fn() },
    setQuality: vi.fn(),
    setRenderMode: vi.fn((m: 'classic' | 'pbr') => {
      w.render.mode = m
      if (seams) w.life = m === 'pbr' ? { setEnabled: vi.fn(), setThreats: vi.fn() } : null
    }),
    setSkyStyle: vi.fn(),
    isolateLights: vi.fn(),
  }
  if (seams) {
    w.setBatching = vi.fn()
    w.life = mode === 'pbr' ? life : null
  }
  return w
}

function link(w: Record<string, unknown>, store: SettingsStore, extra: { gpu?: GpuHint; threats?: () => readonly Vector3[] } = {}) {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene)
  const sun = new DirectionalLight('sun', new Vector3(0, -1, 0), scene)
  const g = new WorldGraphics({ world: w as never, camera: {} as never, lights: { hemi, sun }, store, rollout: 'on', ...extra })
  cleanups.push(() => {
    g.dispose()
    scene.dispose()
    engine.dispose()
  })
  return g
}

const storeWith = (graphics: object) => {
  const s = new SettingsStore(null)
  s.set({ graphics: { firstRun: false, ...graphics } })
  return s
}

describe('graphics link: World batching, wildlife, grass (W10-G)', () => {
  it('batching: nothing at load (the world loads batched), then World.setBatching on each change of the row', () => {
    expect(BATCHING_AT_LOAD).toBe(true)
    const w = fakeWorld('pbr', true)
    const store = storeWith({ preset: 'medium' })
    link(w, store)
    const setBatching = w.setBatching as ReturnType<typeof vi.fn>
    expect(setBatching).not.toHaveBeenCalled()
    store.set({ graphics: { advanced: { batching: 'off' } } })
    expect(setBatching.mock.calls).toEqual([[false]])
    store.set({ graphics: { sight: 1 } }) // another change: no second call
    store.set({ graphics: { advanced: { batching: 'on' } } })
    expect(setBatching.mock.calls).toEqual([[false], [true]])
  })

  it('Low (Classic) never calls World.setBatching; the choice reaches the world just before a switch to PBR', () => {
    const w = fakeWorld('classic', true)
    const store = storeWith({ preset: 'low' })
    link(w, store)
    const setBatching = w.setBatching as ReturnType<typeof vi.fn>
    const setRenderMode = w.setRenderMode as ReturnType<typeof vi.fn>
    store.set({ graphics: { advanced: { batching: 'off' } } })
    store.set({ graphics: { advanced: { batching: 'on' } } })
    store.set({ graphics: { advanced: { batching: 'off' } } })
    expect(setBatching).not.toHaveBeenCalled()
    store.set({ graphics: { preset: 'medium' } })
    expect(setBatching.mock.calls).toEqual([[false]])
    expect(setRenderMode).toHaveBeenLastCalledWith('pbr')
    expect(setBatching.mock.invocationCallOrder[0]!).toBeLessThan(setRenderMode.mock.invocationCallOrder.at(-1)!)
  })

  it('wildlife: World.life.setEnabled follows the row; the threats reach each new life part once', () => {
    const w = fakeWorld('pbr', true)
    const store = storeWith({ preset: 'medium' })
    const threats = () => [] as Vector3[]
    link(w, store, { threats })
    const first = w.life as { setEnabled: ReturnType<typeof vi.fn>; setThreats: ReturnType<typeof vi.fn> }
    expect(first.setEnabled).toHaveBeenLastCalledWith(true)
    expect(first.setThreats.mock.calls).toEqual([[threats]])
    store.set({ graphics: { wildlife: 'off' } })
    expect(first.setEnabled).toHaveBeenLastCalledWith(false)
    store.set({ graphics: { wildlife: 'on' } })
    expect(first.setEnabled).toHaveBeenLastCalledWith(true)
    expect(first.setThreats).toHaveBeenCalledTimes(1)
    // Low and back: the path switch builds a new life part, which gets the threats too.
    store.set({ graphics: { preset: 'low' } })
    expect(w.life).toBeNull()
    store.set({ graphics: { preset: 'medium' } })
    const second = w.life as { setEnabled: ReturnType<typeof vi.fn>; setThreats: ReturnType<typeof vi.fn> }
    expect(second).not.toBe(first)
    expect(second.setThreats.mock.calls).toEqual([[threats]])
    expect(second.setEnabled).toHaveBeenLastCalledWith(true)
  })

  it('a world without the wave-10 seams (HEAD, lane fakes) runs the link unchanged', () => {
    const w = fakeWorld('pbr', false)
    const store = storeWith({ preset: 'medium' })
    expect(() => link(w, store, { threats: () => [] })).not.toThrow()
    expect(() => store.set({ graphics: { advanced: { batching: 'off' }, wildlife: 'off' } })).not.toThrow()
  })

  it('World.setQuality gets the grass style (retail on Classic) and Grass: Low on an Apple GPU', () => {
    const low = fakeWorld('classic', true)
    link(low, storeWith({ preset: 'low' }))
    expect((low.setQuality as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toMatchObject({ grassStyle: 'retail', scatter: 'low' })
    const mac = fakeWorld('pbr', true)
    link(mac, storeWith({ preset: 'medium' }), { gpu: { vendor: 'apple', architecture: 'metal-3' } })
    expect((mac.setQuality as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toMatchObject({ scatter: 'low' })
    const pc = fakeWorld('pbr', true)
    link(pc, storeWith({ preset: 'medium' }), { gpu: { vendor: 'amd', architecture: 'rdna-4' } })
    expect((pc.setQuality as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toMatchObject({ scatter: 'medium' })
  })

  it('actorThreats: the known actors (not items, corpses or fading views), one array refilled per call', () => {
    const view = (kind: string, extra: object = {}) => ({ kind, dead: false, fading: false, isDisposed: false, pos: new Vector3(kind.length, 0, 1), ...extra }) as unknown as EntityView
    const list = [view('player'), view('mob'), view('npc'), view('item'), view('mob', { dead: true }), view('player', { fading: true }), view('cos')]
    const fn = actorThreats(() => list.values())
    const a = fn()
    expect(a.map(p => p.x)).toEqual([6, 3, 3, 3])
    expect(fn()).toBe(a)
  })
})
