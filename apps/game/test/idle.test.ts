/**
 * Idle behaviour (docs/EFFECTS.md §3.11-§3.12, docs/WAVE_PLAN2.md D7; lane FX-C2): the NPC idle-variant schedule
 * (seeded, never two in a row), the idle driver's reasons (combat stance for 5 s, the seat with its SIT_DOWN /
 * STAND_UP transitions, a death clearing both), the posture messages, and the model particles bound to clips (the
 * shaman's pipe smoke in STAND2) or to the model (ambient, night-only ones off at noon).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Animation, AnimationGroup, AssetContainer, NullEngine, Scene, TransformNode } from '@babylonjs/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CharacterActor } from '../src/three/models.ts'
import type { EntityView } from '../src/world/entities.ts'
import { clipMatches, ModelParticles, readParticles, type ModelParticle } from '../src/world/fx/model-particles.ts'
import type { FxHandle, FxPlayOptions, FxRunner } from '../src/world/fx/system-fx.ts'
import type { IdleKind } from '../src/world/fx/types.ts'
import { COMBAT_STANCE_MS, IdleDriver, idleOf, seededRandom, VariantScheduler } from '../src/world/idle.ts'
import { EMOTE_COMMANDS, EMOTE_ICON, EMOTE_ORDER, SIT_COMMAND } from '../src/world/features/posture.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')

let engine: NullEngine
let scene: Scene

beforeAll(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
})

afterAll(() => {
  scene.dispose()
  engine.dispose()
})

describe('idle variants', () => {
  it('the generator is seeded: the same entity rolls the same sequence on every client', () => {
    const a = seededRandom(42)
    const b = seededRandom(42)
    const xs = Array.from({ length: 20 }, () => a())
    expect(Array.from({ length: 20 }, () => b())).toEqual(xs)
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true)
  })

  it('rolls once per STAND1 cycle while standing, about VARIANT_CHANCE of the cycles, never two in a row', () => {
    const s = new VariantScheduler(['STAND2', 'STAND3'], 2000, 0.2, 1234)
    let plays = 0
    let prevCycleVariant = false
    const seen = new Set<string>()
    for (let cycle = 0; cycle < 2000; cycle++) {
      const out = s.tick(2000, true)
      if (out) {
        expect(prevCycleVariant).toBe(false)
        seen.add(out)
        plays++
      }
      prevCycleVariant = !!out
    }
    expect(plays / 2000).toBeGreaterThan(0.1)
    expect(plays / 2000).toBeLessThan(0.25)
    expect([...seen].sort()).toEqual(['STAND2', 'STAND3'])
    // Nothing while walking or seated; the cycle restarts after.
    expect(s.tick(10_000, false)).toBeNull()
    const none = new VariantScheduler([], 1000, 1, 1)
    expect(none.tick(5000, true)).toBeNull()
  })
})

/** A view stand-in that records setIdle calls. */
function fakeView(kind: EntityView['kind'] = 'player', posture?: 'sit'): EntityView & { calls: [IdleKind, string | undefined][] } {
  const calls: [IdleKind, string | undefined][] = []
  const v = {
    id: 9,
    kind,
    state: { id: 9, kind, posture },
    dead: false,
    moving: false,
    actor: null,
    calls,
    setIdle(k: IdleKind, tr?: 'play') {
      calls.push([k, tr])
    },
  }
  return v as unknown as EntityView & { calls: [IdleKind, string | undefined][] }
}

describe('IdleDriver', () => {
  it('the combat stance lasts COMBAT_STANCE_MS after the last swing or hit', () => {
    const v = fakeView()
    const d = new IdleDriver(v)
    expect(idleOf(v)).toBe(d)
    d.combat()
    expect(v.calls.at(-1)).toEqual(['combat', undefined])
    d.update(0, 3)
    d.combat() // another swing extends it
    d.update(0, (COMBAT_STANCE_MS - 500) / 1000)
    expect(d.kind).toBe('combat')
    d.update(0, 1)
    expect(d.kind).toBe('stand')
    expect(v.calls.at(-1)).toEqual(['stand', undefined])
    d.dispose()
    expect(idleOf(v)).toBeNull()
  })

  it('sitting wins over the stance (D7), with SIT_DOWN / STAND_UP when asked for; a death clears the seat', () => {
    const v = fakeView()
    const d = new IdleDriver(v)
    d.combat()
    d.setReason('sit', true, 'play')
    expect(v.calls.at(-1)).toEqual(['sit', 'play'])
    d.setReason('vendor', true)
    expect(d.kind).toBe('vendor')
    d.setReason('vendor', false)
    d.setReason('sit', false, 'play')
    expect(v.calls.at(-1)).toEqual(['combat', 'play'])
    d.setReason('sit', true)
    ;(v as { dead: boolean }).dead = true
    d.update(0, 0.05)
    expect(d.has('sit')).toBe(false)
    expect(d.kind).toBe('stand')
  })

  it('a late joiner that is sitting starts in the SIT loop (no SIT_DOWN)', () => {
    const v = fakeView('player', 'sit')
    const d = new IdleDriver(v)
    d.loaded()
    expect(v.calls).toEqual([['sit', undefined]])
  })
})

describe('model particles', () => {
  const plays: { key: string; loop: boolean }[] = []
  const runner = {
    play(key: string, o: FxPlayOptions): FxHandle {
      plays.push({ key, loop: !!o.loop })
      let stopped = false
      return { stop: () => void (stopped = true), get done() { return stopped } }
    },
  } as unknown as FxRunner
  const carrier = { get root() { return new TransformNode('m', scene) }, joint: () => undefined }

  const P = (p: Partial<ModelParticle> & Pick<ModelParticle, 'efp' | 'kind'>): ModelParticle => ({ set: p.kind, bone: null, position: [0, 0, 0], birthMs: 0, night: false, ...p })

  it('reads sidecar rows tolerantly', () => {
    expect(readParticles({ particles: [{ efp: 'a.efp', kind: 'clip', clip: 'STAND2', bone: 'Bone09', position: [0, 1, 2], birthMs: 3206, night: false }, { kind: 'ambient' }, null] })).toEqual([
      { set: 'clip', kind: 'clip', clip: 'STAND2', efp: 'a.efp', bone: 'Bone09', position: [0, 1, 2], birthMs: 3206, night: false },
    ])
    expect(readParticles(null)).toEqual([])
    expect(clipMatches('STAND2', 'STAND2')).toBe(true)
    expect(clipMatches('STAND2', 'STAND2_x')).toBe(true)
    expect(clipMatches('STAND2', 'STAND21')).toBe(false)
  })

  it('ambient loops at once (night-only ones off at noon); clip-bound ones play birthMs into their clip', () => {
    plays.length = 0
    const mp = new ModelParticles(runner, [
      P({ efp: 'map/frame.efp', kind: 'ambient' }),
      P({ efp: 'map/lamp.efp', kind: 'ambient', night: true }),
      P({ efp: 'npc/npc_chinasystem_shaman_pipesmoke.efp', kind: 'clip', clip: 'STAND2', bone: 'Bone09', birthMs: 3206 }),
    ], carrier)
    expect(plays).toEqual([{ key: 'map/frame.efp', loop: true }])
    mp.onClip('STAND1')
    mp.update(5000)
    expect(plays).toHaveLength(1)
    mp.onClip('STAND2')
    mp.update(3000)
    expect(plays).toHaveLength(1)
    mp.update(300)
    expect(plays.at(-1)).toEqual({ key: 'npc/npc_chinasystem_shaman_pipesmoke.efp', loop: false })
    mp.onClip('STAND2')
    mp.dispose()
    mp.update(5000)
    expect(plays).toHaveLength(2)
  })
})

describe('posture commands', () => {
  it('/sitdown and one chat command per emote; retail icons for the seven emotes', () => {
    expect(SIT_COMMAND).toBe('/sitdown')
    expect(EMOTE_COMMANDS['/hi']).toBe('hi')
    expect(Object.keys(EMOTE_COMMANDS).sort()).toEqual(['/greeting', '/hi', '/joy', '/laugh', '/no', '/rush', '/yes'])
    expect([...EMOTE_ORDER].sort()).toEqual(Object.values(EMOTE_COMMANDS).sort())
    for (const e of EMOTE_ORDER) {
      const file = join(ROOT, 'work', EMOTE_ICON[e].replace(/^\//, ''))
      if (existsSync(join(ROOT, 'work', 'out', 'icon', 'action'))) expect(existsSync(file), file).toBe(true)
    }
  })
})

const SHAMAN = join(ROOT, 'work', 'out', 'npc', 'npc', 'chinasystem_shaman.json')
describe.runIf(existsSync(SHAMAN))('exported NPC particles', () => {
  it('the shaman puffs his pipe 3.2 s into STAND2', () => {
    const list = readParticles(JSON.parse(readFileSync(SHAMAN, 'utf8')))
    const smoke = list.find(p => p.kind === 'clip' && p.clip === 'STAND2')
    expect(smoke?.efp).toBe('npc/npc_chinasystem_shaman_pipesmoke.efp')
    expect(smoke?.birthMs).toBeGreaterThan(3000)
  })
})

describe('the T-pose (D25)', () => {
  /** An actor whose clips move one node: bind y = 5, STAND1 holds y = 0, RUN holds y = 2. */
  function actor(): { a: CharacterActor; node: TransformNode } {
    build = () => {
      const root = new TransformNode('__root__', scene)
      const node = new TransformNode('Bip01 L UpperArm', scene)
      node.parent = root
      node.position.y = 5
      for (const [name, y] of [['STAND1', 0], ['RUN', 2]] as const) {
        const g = new AnimationGroup(name, scene)
        const an = new Animation(`${name}:y`, 'position.y', 30, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE)
        an.setKeys([{ frame: 0, value: y }, { frame: 30, value: y }])
        g.addTargetedAnimation(an, node)
      }
    }
    build()
    const c = new AssetContainer(scene)
    c.moveAllFromScene()
    const a = new CharacterActor(scene, { code: 'CHAR_CH_MAN_ADVENTURER', glb: '/out/t.glb' }, { container: c, sidecar: null, packs: null })
    return { a, node: a.joint('Bip01 L UpperArm')! }
  }
  let build = () => {}

  it('the first clip of a fresh actor snaps to its pose; later changes still blend', () => {
    const { a, node } = actor()
    a.play('STAND1')
    scene.animate()
    expect(node.position.y).toBeCloseTo(0, 3)
    a.play('RUN')
    scene.animate()
    scene.animate()
    // Blending from STAND1 towards RUN: part of the way after one frame.
    expect(node.position.y).toBeGreaterThan(0)
    expect(node.position.y).toBeLessThan(1)
    a.dispose()
  })

  it('a corpse that arrives dead lies down at once', () => {
    const { a, node } = actor()
    const g = a.group('STAND1')!
    g.name = 'DIE1'
    a.die(true)
    scene.animate()
    expect(node.position.y).toBeCloseTo(0, 3)
    a.dispose()
  })
})

describe('mock posture (?mock=1)', () => {
  const rig = async () => {
    const { fxMock } = await import('../src/net/mock/fx.ts')
    const sent: unknown[] = []
    const results: [string, boolean, string?][] = []
    let now = 1_000_000
    const self = { state: { id: 42, pos: [0, 0, 0] } as { id: number; pos: number[]; move?: unknown }, player: { prog: { dead: false }, action: null as unknown, casting: null as unknown, lastCombat: 0 } }
    const ctx = {
      now: () => now,
      selfOf: () => self,
      entity: (id: number) => (id === 42 ? self : undefined),
      result: (_c: unknown, re: string, ok: boolean, reason?: string) => results.push(reason ? [re, ok, reason] : [re, ok]),
      broadcast: (m: unknown) => sent.push(m),
    } as unknown as Parameters<NonNullable<typeof fxMock.handle>>[0]
    const conn = {} as Parameters<NonNullable<typeof fxMock.handle>>[1]
    return { fxMock, sent, results, self, ctx, conn, at: (t: number) => (now = t) }
  }

  it('sit / emote answer once, tell every viewer, and a move stands the sitter up', async () => {
    const { fxMock, sent, results, ctx, conn } = await rig()
    expect(fxMock.handle!(ctx, conn, { t: 'sit', on: true })).toBe(true)
    expect(fxMock.handle!(ctx, conn, { t: 'sit', on: true })).toBe(true)
    expect(sent).toEqual([{ t: 'entityUpdate', id: 42, posture: 'sit' }])
    expect(fxMock.handle!(ctx, conn, { t: 'moveTo', pos: [0, 0, 0] } as never)).toBe(false)
    expect(sent.at(-1)).toEqual({ t: 'entityUpdate', id: 42, posture: 'stand' })
    expect(fxMock.handle!(ctx, conn, { t: 'emote', emote: 'hi' })).toBe(true)
    expect(sent.at(-1)).toEqual({ t: 'emote', id: 42, emote: 'hi' })
    expect(results).toEqual([['sit', true], ['sit', true], ['emote', true]])
  })

  it('refuses sit like the server (moving, acting, casting, recent combat) and stands up on a hit while seated (I7B)', async () => {
    const { fxMock, sent, results, self, ctx, conn, at } = await rig()
    self.state.move = { from: [0, 0, 0], to: [10, 0, 0], speed: 5, startedAt: 1_000_000 }
    fxMock.handle!(ctx, conn, { t: 'sit', on: true })
    fxMock.handle!(ctx, conn, { t: 'emote', emote: 'hi' })
    self.state.move = undefined
    self.player.action = { kind: 'attack', target: 7 }
    fxMock.handle!(ctx, conn, { t: 'sit', on: true })
    self.player.action = null
    self.player.lastCombat = 999_000
    fxMock.handle!(ctx, conn, { t: 'sit', on: true })
    expect(results).toEqual([['sit', false, 'busy'], ['emote', false, 'busy'], ['sit', false, 'busy'], ['sit', false, 'in_combat']]) // D30: recent combat is in_combat (I8)
    expect(sent).toEqual([])
    at(1_010_000)
    fxMock.handle!(ctx, conn, { t: 'sit', on: true })
    expect(sent).toEqual([{ t: 'entityUpdate', id: 42, posture: 'sit' }])
    fxMock.tick!(ctx, 1_010_100)
    expect(sent).toHaveLength(1)
    self.player.lastCombat = 1_010_200 // hit while seated
    fxMock.tick!(ctx, 1_010_300)
    expect(sent.at(-1)).toEqual({ t: 'entityUpdate', id: 42, posture: 'stand' })
    // stopAction stands up too (the server's `stopped` hook)
    fxMock.handle!(ctx, conn, { t: 'sit', on: false })
    at(1_020_000)
    fxMock.handle!(ctx, conn, { t: 'sit', on: true })
    expect(fxMock.handle!(ctx, conn, { t: 'stopAction' })).toBe(false)
    expect(sent.at(-1)).toEqual({ t: 'entityUpdate', id: 42, posture: 'stand' })
  })
})
