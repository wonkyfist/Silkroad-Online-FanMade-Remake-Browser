/**
 * The lightning tornado on the client (docs/WEATHER.md §13.7): TornadoFx on a NullEngine at every tier (three meshes,
 * three materials, three textures, never more over a long life with bolts and debris, all freed on dispose: no
 * black-screen leak), the feature's lifecycle (one funnel while a tornado is up, gone after `tornadoEnd`, worldEnter and
 * dispose), the thrown body's arc, the camera shake and its option, the chat and tooltip lines, the synthesized roar.
 */
import { ArcRotateCamera, NullEngine, Scene, TransformNode, Vector3 } from '@babylonjs/core'
import { TORNADO_TABLE, type ServerMessage, type TornadoState } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { ROAR_S, TORNADO_SYNTH, roarGain, roarPcm, whooshPcm } from '../src/audio/tornado.ts'
import { SettingsStore } from '../src/settings.ts'
import type { WorldFeatureContext } from '../src/world/features.ts'
import { tornadoFeature, tornadoShake, tornadoTierFor, tornadoTipLine, tornadoWarnLine } from '../src/world/features/tornado.ts'
import { MAX_STRIKE_ARCS, TORNADO_TIERS, TornadoFx, type TornadoTier } from '../src/world/storm/tornado-fx.ts'
import { compass, tornadoInfo } from '../src/world/storm/tornado-status.ts'

const T0 = Date.UTC(2026, 9, 5, 12)

const STATE: TornadoState = {
  id: 7,
  seed: 1234,
  warnAt: T0,
  touchAt: T0 + 20_000,
  endAt: T0 + 140_000,
  path: [
    [0, 0, -100],
    [0, 0, 100],
  ],
  speedMs: 3,
  pullM: 30,
  coreM: 5,
  strength: 1,
  area: 'Jangan field',
}

function setup() {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const camera = new ArcRotateCamera('cam', 0, 1, 40, new Vector3(0, 0, 0), scene)
  scene.activeCamera = camera
  const count = () => ({ meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length })
  return { engine, scene, camera, count, close: () => (scene.dispose(), engine.dispose()) }
}

describe('TornadoFx on a NullEngine (fixed resources, no leaks)', () => {
  for (const tier of ['low', 'medium', 'high'] as TornadoTier[]) {
    it(`${tier}: three meshes, materials and textures through a whole life with bolts; capacity holds; dispose returns to the baseline`, () => {
      const s = setup()
      const base = s.count()
      const fx = new TornadoFx(s.scene, 99, tier)
      const after = { meshes: base.meshes + 3, materials: base.materials + 3, textures: base.textures + 3 }
      expect(s.count()).toEqual(after)
      const spec = TORNADO_TIERS[tier]
      expect(fx.stats().funnelVerts).toBe(spec.shells * (spec.seg + 1) * spec.rings)
      let maxQuads = 0
      let frame = 0
      for (let t = T0; t < T0 + 90_000; t += 50) {
        const presence = Math.min(1, (t - T0) / 20_000)
        if (frame % 40 === 0) fx.strikeArc([20, 0, (frame % 7) * 3], t + 100)
        fx.update(t, { pos: [0, 0, 0], presence, heading: 0.3, strength: 1, light: 0.6, flash: frame % 50 === 0 ? 2 : 0 }, s.camera)
        if (++frame % 17 === 0) s.scene.render()
        maxQuads = Math.max(maxQuads, fx.stats().quads)
        expect(fx.stats().quads).toBeLessThanOrEqual(spec.debris + spec.dust)
        expect(fx.stats().strikeArcs).toBeLessThanOrEqual(MAX_STRIKE_ARCS)
      }
      expect(maxQuads).toBeGreaterThan(spec.dust)
      expect(s.count()).toEqual(after)
      // nothing shows at presence 0
      fx.update(T0 + 100_000, { pos: [0, 0, 0], presence: 0, heading: 0, strength: 1, light: 1, flash: 0 }, s.camera)
      expect(s.scene.meshes.filter((m) => m.metadata?.sroTornado && m.isVisible)).toHaveLength(0)
      // always enabled (the world's active-mesh candidate list never misses them), hidden with isVisible
      expect(s.scene.meshes.filter((m) => m.metadata?.sroTornado).every((m) => m.isEnabled())).toBe(true)
      fx.dispose()
      fx.dispose()
      expect(fx.isDisposed).toBe(true)
      expect(s.count()).toEqual(base)
      fx.update(T0, { pos: [0, 0, 0], presence: 1, heading: 0, strength: 1, light: 1, flash: 0 }, s.camera) // ignored
      s.close()
    })
  }

  it('Low draws a simpler funnel than Medium and High', () => {
    expect(TORNADO_TIERS.low.shells).toBe(1)
    expect(TORNADO_TIERS.medium.shells).toBeGreaterThan(1)
    expect(TORNADO_TIERS.low.debris).toBeLessThan(TORNADO_TIERS.medium.debris)
    expect(TORNADO_TIERS.high.debris).toBeGreaterThan(TORNADO_TIERS.medium.debris)
    expect(tornadoTierFor('low')).toBe('low')
    expect(tornadoTierFor('medium')).toBe('medium')
    expect(tornadoTierFor('ultra')).toBe('high')
  })
})

describe('the tornado feature', () => {
  function ctxFor(s: ReturnType<typeof setup>) {
    const chat: string[] = []
    let now = T0
    const root = new TransformNode('v', s.scene)
    const view = { root, pos: new Vector3(0, 0, -40), yaw: 0, dead: false, move: undefined as unknown, actor: null, ride: null, state: { kind: 'player', id: 1 } }
    root.position.set(0, 0, -40)
    const ctx = {
      session: {},
      scene: s.scene,
      camera: s.camera,
      chat: { add: (_k: string, text: string) => void chat.push(text) },
      selfId: () => 1,
      view: (id: number) => (id === 1 ? view : undefined),
      serverNow: () => now,
      world: () => null,
      minimap: () => null,
    } as unknown as WorldFeatureContext
    return { ctx, chat, view, setNow: (t: number) => (now = t) }
  }

  it('one funnel while a tornado is up: told in chat, shown in the icon, shaken when close, gone after its end; no leak', () => {
    const s = setup()
    const base = s.count()
    const store = new SettingsStore(null)
    store.set({ graphics: { preset: 'low' } })
    const c = ctxFor(s)
    const f = tornadoFeature(c.ctx, { store })
    f.onMessage!({ t: 'tornado', tornado: STATE } as ServerMessage)
    expect(c.chat[0]).toMatch(/^A tornado is forming over Jangan field, 60 m north of you! It touches down in about 20 s/)
    expect(tornadoInfo()).toMatchObject({ phase: 'warning', dir: 'n' })
    f.onFrame!(T0 + 1000, 0.05)
    expect(s.count()).toEqual({ meshes: base.meshes + 3, materials: base.materials + 3, textures: base.textures + 3 })
    // Low: one shell of 20 × 10
    expect(s.scene.meshes.find((m) => m.name === 'tornado:funnel')!.getTotalVertices()).toBe(21 * 10)
    // touchdown then walking south toward the player (at z -40): the camera shakes once it is close
    c.setNow(T0 + 40_000)
    f.onFrame!(T0 + 40_000, 0.05)
    expect(s.camera.targetScreenOffset.length()).toBeGreaterThan(0)
    store.set({ controls: { cameraShake: false } })
    f.onFrame!(T0 + 40_050, 0.05)
    expect(s.camera.targetScreenOffset.length()).toBe(0)
    // a throw lifts the body on its arc at mid-flight
    f.onMessage!({ t: 'displace', id: 1, kind: 'throw', from: [0, 0, -40], to: [20, 0, -40], at: T0 + 41_000, ms: 1200, peakM: 8 } as ServerMessage)
    expect(c.chat.at(-1)).toBe('The tornado throws you!')
    c.view.root.position.y = 0
    f.onFrame!(T0 + 41_600, 0.05)
    expect(c.view.root.position.y).toBeCloseTo(8, 6)
    // the lift and the end
    f.onMessage!({ t: 'tornado', tornado: { ...STATE, liftAt: T0 + 50_000 } } as ServerMessage)
    expect(c.chat.at(-1)).toBe('The tornado lifts back into the clouds.')
    f.onMessage!({ t: 'tornadoEnd', id: 7, at: T0 + 56_000 } as ServerMessage)
    expect(s.count()).toEqual(base)
    expect(tornadoInfo()).toBeNull()
    // a second one, then worldEnter and dispose clear it
    f.onMessage!({ t: 'tornado', tornado: { ...STATE, id: 8 } } as ServerMessage)
    f.onFrame!(T0 + 60_000, 0.05)
    expect(s.count().meshes).toBe(base.meshes + 3)
    f.onMessage!({ t: 'worldEnter' } as unknown as ServerMessage)
    expect(s.count()).toEqual(base)
    f.onMessage!({ t: 'tornado', tornado: { ...STATE, id: 9 } } as ServerMessage)
    f.onFrame!(T0 + 61_000, 0.05)
    f.dispose!()
    expect(s.count()).toEqual(base)
    s.close()
  })

  it('lines, compass, shake curve', () => {
    expect(compass(0, -10)).toBe('n')
    expect(compass(10, 0)).toBe('e')
    expect(compass(-7, 7)).toBe('sw')
    expect(tornadoWarnLine({ ...STATE, area: undefined }, 0, 0, T0)).toBe('A tornado is forming 100 m north of you! It touches down in about 20 s. Keep clear of the funnel.')
    expect(tornadoTipLine({ phase: 'active', distM: 243, dir: 'ne', touchInS: 0 })).toBe('Tornado 240 m north-east: it pulls in and throws whatever it catches')
    expect(tornadoShake(0, 1)).toBeGreaterThan(tornadoShake(30, 1))
    expect(tornadoShake(TORNADO_TABLE.shakeM + 1, 1)).toBe(0)
    expect(tornadoShake(10, 0)).toBe(0)
  })
})

describe('the synthesized roar (audio/tornado.ts)', () => {
  it('is deterministic, the right length, peaks under clipping, fades in and out (segments overlap seamlessly)', () => {
    const a = roarPcm(101)
    expect(a.samples.length).toBe(Math.round(ROAR_S * a.rate))
    expect(roarPcm(101).samples).toEqual(a.samples)
    expect(roarPcm(202).samples).not.toEqual(a.samples)
    let peak = 0
    for (const v of a.samples) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeLessThanOrEqual(0.86)
    expect(peak).toBeGreaterThan(0.5)
    expect(Math.abs(a.samples[0]!)).toBeLessThan(0.01)
    expect(Math.abs(a.samples.at(-1)!)).toBeLessThan(0.01)
    expect(whooshPcm().samples.length).toBeGreaterThan(20_000)
    expect(Object.keys(TORNADO_SYNTH)).toEqual(['synth/tornado_roar_a', 'synth/tornado_roar_b', 'synth/tornado_whoosh'])
    expect(roarGain(0, 900, 1)).toBe(1)
    expect(roarGain(900, 900, 1)).toBe(0)
    expect(roarGain(100, 900, 0.5)).toBeLessThan(roarGain(100, 900, 1))
  })
})
