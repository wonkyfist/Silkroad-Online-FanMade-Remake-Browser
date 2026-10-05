/**
 * Lightning that strikes, on the client (docs/WEATHER.md §2.7, §7.3b): the deterministic bolt generator, the strike
 * timeline and tiers, the weather flash of a placed strike, the synthesized sounds, and LightningFx on a NullEngine:
 * a long storm of every kind of strike at every tier never makes a mesh, material or texture beyond its fixed six,
 * six and four (no leaks: the 2026-10-05 black screen), stays inside its capacities, and disposes back to the scene's
 * baseline.
 */
import { ArcRotateCamera, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { BOLT_CLOUD_M, strikeStrokes, type LightningStrike, type StrikeKind } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import type { SoundBuffer, StartOptions, VoiceHandle } from '../src/audio/backend.ts'
import { CRACKLE_S, CRACK_MAX_M, LightningAudio, SYNTH_RATE, crackGain, crackSamples, crackleSamples, encodeWav } from '../src/audio/lightning.ts'
import { WeatherClient, strikeFromListener } from '../src/world/features/weather.ts'
import { MAX_BOLT_SEGMENTS, generateBolt, staticArcs } from '../src/world/lightning/bolt.ts'
import { CAP, LightningFx } from '../src/world/lightning/fx.ts'
import { FIRE_MS, SCORCH_MS, SMOKE_TAIL_MS, TIER_FEATURES, boltState, fireLevels, scorchAlpha, telegraphLevel, tierFor, type LightningTier } from '../src/world/lightning/timeline.ts'

const T0 = Date.UTC(2026, 9, 5, 12)

function strike(id: number, kind: StrikeKind, over: Partial<LightningStrike> = {}): LightningStrike {
  const s: LightningStrike = { id, at: T0 + id * 5000 + 1500, warnAt: T0 + id * 5000, kind, pos: [id % 7, 0, -(id % 5)], radiusM: 4, seed: (id * 2654435761) >>> 0, ...over }
  if (kind === 'sky') delete s.warnAt
  return s
}

describe('the bolt generator', () => {
  it('is deterministic: the same seed and impact give the same bolt; another seed another', () => {
    const a = generateBolt(1234, [10, 2, -5])
    expect(generateBolt(1234, [10, 2, -5])).toEqual(a)
    expect(generateBolt(1235, [10, 2, -5])).not.toEqual(a)
  })

  it('a main channel from the cloud down to the impact, with forks that run downward; within the buffer size', () => {
    for (let seed = 1; seed < 300; seed += 13) {
      const b = generateBolt(seed, [0, 5, 0])
      expect(b.segments.length).toBeLessThanOrEqual(MAX_BOLT_SEGMENTS)
      expect(b.main).toBe(64)
      expect(b.top[1]).toBe(5 + BOLT_CLOUD_M)
      expect(b.segments[0]!.a).toEqual(b.top)
      expect(b.segments[b.main - 1]!.b).toEqual([0, 5, 0])
      const forks = b.segments.slice(b.main)
      expect(forks.length).toBeGreaterThan(0)
      for (const f of forks) {
        expect(f.depth).toBeGreaterThan(0)
        expect(f.glow).toBeLessThan(0.7)
      }
      // the main channel is continuous
      for (let i = 1; i < b.main; i++) expect(b.segments[i]!.a).toEqual(b.segments[i - 1]!.b)
    }
  })

  it('static arcs stay around their spot', () => {
    const arcs = staticArcs(9, [100, 0, 100], 3, 5, 1)
    expect(arcs.length).toBe(5 * 4)
    for (const a of arcs) expect(Math.hypot(a.a[0] - 100, a.a[2] - 100)).toBeLessThan(5)
  })
})

describe('the strike timeline', () => {
  it('tiers follow the weather level; the telegraph shows at every tier', () => {
    expect(['off', 'low', 'medium', 'high', 'ultra', null].map(tierFor)).toEqual(['off', 'low', 'medium', 'high', 'high', 'off'])
    expect(TIER_FEATURES.off).toMatchObject({ bolt: false, scorch: false, bursts: false, fire: false })
    expect(TIER_FEATURES.low).toMatchObject({ bolt: true, scorch: true, bursts: false, fire: false })
    expect(TIER_FEATURES.medium).toMatchObject({ bolt: true, scorch: true, bursts: true, fire: true })
    expect(TIER_FEATURES.high.particles).toBeGreaterThan(TIER_FEATURES.medium.particles)
  })

  it('telegraph rises from warnAt to at; the bolt flickers with its strokes and is over by the last + 0.25 s', () => {
    const s = strike(1, 'ground')
    expect(telegraphLevel(s, s.warnAt! - 1)).toBe(0)
    expect(telegraphLevel(s, s.warnAt!)).toBeCloseTo(0.35)
    expect(telegraphLevel(s, s.at - 1)).toBeGreaterThan(0.99)
    expect(telegraphLevel(s, s.at)).toBe(0)
    const strokes = strikeStrokes(s.seed)
    for (const k of strokes) expect(boltState(s, s.at + k.t * 1000 + 0.5).glow).toBeGreaterThanOrEqual(k.peak * 0.98)
    expect(boltState(s, s.at).forks).toBe(true)
    expect(boltState(s, s.at + 200).forks).toBe(false)
    expect(boltState(s, s.at + (strokes.at(-1)!.t + 0.26) * 1000).glow).toBe(0)
  })

  it('a tree burns about a minute, its smoke lingers; a scorch fades out', () => {
    expect(fireLevels(10_000).fire).toBe(1)
    expect(fireLevels(FIRE_MS - 1000).fire).toBeLessThan(0.1)
    expect(fireLevels(FIRE_MS + 1000)).toMatchObject({ fire: 0, embers: 0 })
    expect(fireLevels(FIRE_MS + 1000).smoke).toBeGreaterThan(0)
    expect(fireLevels(FIRE_MS + SMOKE_TAIL_MS + 1)).toEqual({ fire: 0, embers: 0, smoke: 0 })
    expect(scorchAlpha(1000)).toBe(1)
    expect(scorchAlpha(SCORCH_MS - 1000)).toBeLessThan(0.1)
    expect(scorchAlpha(SCORCH_MS)).toBe(0)
  })
})

describe('the weather flash of a placed strike', () => {
  it('follows the return strokes, brighter near, toward the strike; the bolt is the game\'s (boltOwned)', () => {
    const c = new WeatherClient(null, T0)
    const strokes = strikeStrokes(77)
    expect(c.strike(T0 + 1000, 120, 1.2, { strokes, peak: 3 })).toBe(true)
    const f = c.frame(T0 + 1000, 0.016)
    expect(f.flash).toBe(3)
    expect(f.boltOwned).toBe(true)
    expect(f.flashX).toBeCloseTo(Math.cos(1.2))
    const between = c.frame(T0 + 1000 + 1000 * (strokes[0]!.t + strokes[1]!.t) / 2, 0.016).flash
    const at2 = c.frame(T0 + 1000 + 1000 * strokes[1]!.t, 0.016).flash
    expect(at2).toBeGreaterThan(between)
    expect(c.frame(T0 + 3000, 0.016)).toMatchObject({ flash: 0 })
    expect(c.frame(T0 + 3000, 0.016).boltOwned).toBeUndefined()
    // its thunder ~3 s per km
    expect(c.takeThunder(T0 + 1000 + (120 / 343) * 1000)).toHaveLength(1)
  })

  it('distance and bearing from the listener (0 = east, π/2 = north = -Z)', () => {
    expect(strikeFromListener({ pos: [100, 0, 0] }, 0, 0, 0)).toEqual({ distM: 100, bearing: 0 })
    const n = strikeFromListener({ pos: [0, 0, -50] }, 0, 0, 0)
    expect(n.bearing).toBeCloseTo(Math.PI / 2)
    expect(strikeFromListener({ pos: [0, 400, 300] }, 0, 0, 0).distM).toBe(500)
  })
})

describe('synthesized lightning sounds', () => {
  it('crackle and crack: deterministic, in range, the right length; WAV encoding', () => {
    const a = crackleSamples()
    expect(a.length).toBe(Math.round(CRACKLE_S * SYNTH_RATE))
    expect(crackleSamples()).toEqual(a)
    const c = crackSamples()
    let peak = 0
    for (const v of c) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeCloseTo(0.95, 2)
    // the snap is at the very start
    let early = 0
    for (let i = 0; i < SYNTH_RATE * 0.05; i++) early = Math.max(early, Math.abs(c[i]!))
    expect(early).toBeGreaterThan(0.5)
    const wav = new DataView(encodeWav(new Float32Array([0, 1, -1])))
    expect(wav.byteLength).toBe(44 + 6)
    expect(wav.getUint32(24, true)).toBe(SYNTH_RATE)
    expect(wav.getInt16(46, true)).toBe(32767)
    expect(crackGain(30)).toBe(1)
    expect(crackGain(CRACK_MAX_M)).toBeCloseTo(0.25)
  })

  it('LightningAudio: decodes once, crackles on the spot until stopped, cracks only close', async () => {
    const started: StartOptions[] = []
    const stopped: number[] = []
    let decodes = 0
    const buf: SoundBuffer = { duration: 2, bytes: 1 }
    const la = new LightningAudio({
      ready: () => true,
      decode: async () => (decodes++, buf),
      start: (_b, o): VoiceHandle => {
        started.push(o)
        const i = started.length
        return { stop: () => void stopped.push(i), setPosition() {} }
      },
    })
    la.prepare()
    la.prepare()
    await new Promise(r => setTimeout(r, 0))
    expect(decodes).toBe(2)
    const h = la.crackleAt({ x: 1, y: 2, z: 3 })
    expect(started[0]).toMatchObject({ bus: 'sfx', pos: { x: 1, y: 2, z: 3 } })
    h.stop()
    h.stop()
    expect(stopped).toEqual([1])
    la.crackFrom(CRACK_MAX_M + 1)
    expect(started).toHaveLength(1)
    la.crackFrom(50, 0.5)
    expect(started[1]).toMatchObject({ bus: 'ambient', pan: 0.5 })
  })
})

describe('LightningFx on a NullEngine (no leaks, fixed resources)', () => {
  function setup() {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const camera = new ArcRotateCamera('cam', 0, 1, 30, new Vector3(0, 0, 0), scene)
    scene.activeCamera = camera
    const base = { meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length }
    const fx = new LightningFx(scene, { heightAt: (x, z) => 0.02 * x - 0.01 * z, wetness: () => 0.8 })
    return { engine, scene, camera, base, fx }
  }

  it('a long storm of every kind at every tier: never a new mesh, material or texture; capacities hold; dispose returns to the baseline', () => {
    const { engine, scene, camera, base, fx } = setup()
    const own = fx.resources
    expect(own.meshes).toHaveLength(6)
    expect(own.materials).toHaveLength(6)
    expect(own.textures).toHaveLength(4)
    const after = { meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length }
    expect(after).toEqual({ meshes: base.meshes + 6, materials: base.materials + 6, textures: base.textures + 4 })
    const kinds: StrikeKind[] = ['ground', 'tree', 'wall', 'tower', 'entity', 'sky']
    const tiers: LightningTier[] = ['high', 'medium', 'low', 'off', 'high']
    let id = 0
    let maxQuads = 0
    let maxParticles = 0
    let sawBolt = false
    let sawTrees = 0
    let frame = 0
    for (const tier of tiers) {
      fx.setTier(tier)
      for (let k = 0; k < 24; k++) {
        const s = strike(++id, kinds[k % kinds.length]!, { pos: [k * 3, k % 3 === 2 ? 19.5 : 30, -k], groundY: 0 })
        fx.strike(s)
        fx.strike(s) // a repeat is ignored
        for (let t = s.warnAt ?? s.at; t < s.at + 5000; t += 50) {
          fx.update(t, 0.05, camera)
          // render too: the transparent sort reads every sub-mesh's bounding info (a narrowed sub-mesh had none)
          if (++frame % 7 === 0) scene.render()
          const st = fx.stats()
          maxQuads = Math.max(maxQuads, st.quads)
          maxParticles = Math.max(maxParticles, st.particles)
          sawTrees = Math.max(sawTrees, st.trees)
          if (tier !== 'off' && t > s.at && t < s.at + 200 && s.kind !== 'sky' && st.quads > 0) sawBolt = true
          expect(st.scorches).toBeLessThanOrEqual(CAP.scorches)
          expect(st.trees).toBeLessThanOrEqual(CAP.trees)
        }
        expect({ meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length }).toEqual(after)
      }
    }
    expect(sawBolt).toBe(true)
    expect(sawTrees).toBeGreaterThan(0)
    expect(maxParticles).toBeGreaterThan(50)
    expect(maxParticles).toBeLessThanOrEqual(CAP.spritesAdd + CAP.spritesAlpha)
    expect(maxQuads).toBeGreaterThan(0)
    // two minutes later the fires are out and the strikes gone; ~3 more minutes, the scorches too
    const end = T0 + (id + 1) * 5000
    fx.update(end + 120_000, 0.05, camera)
    fx.update(end + 120_000 + 30_000, 0.05, camera)
    expect(fx.stats()).toMatchObject({ strikes: 0, trees: 0 })
    // particles age by frame time: run ten seconds of frames
    for (let t = end + 400_000; t < end + 410_000; t += 50) fx.update(t, 0.05, camera)
    expect(fx.stats()).toMatchObject({ scorches: 0, quads: 0 })
    for (const m of own.meshes) expect(m.isEnabled()).toBe(false)
    fx.dispose()
    fx.dispose()
    expect({ meshes: scene.meshes.length, materials: scene.materials.length, textures: scene.textures.length }).toEqual(base)
    for (const m of own.meshes) expect(m.isDisposed()).toBe(true)
    // updates and strikes after dispose are ignored
    fx.strike(strike(999, 'ground'))
    fx.update(T0, 0.016, camera)
    scene.dispose()
    engine.dispose()
  })

  it('tier off: the telegraph ring still shows (fair warning), no bolt, no scorch', () => {
    const { engine, scene, camera, fx } = setup()
    fx.setTier('off')
    const s = strike(1, 'ground')
    fx.strike(s)
    fx.update(s.warnAt! + 500, 0.016, camera)
    expect(fx.stats().quads).toBeGreaterThan(0) // the ring
    fx.update(s.at + 50, 0.016, camera)
    fx.update(s.at + 100, 0.016, camera)
    expect(fx.stats()).toMatchObject({ quads: 0, scorches: 0 })
    fx.dispose()
    scene.dispose()
    engine.dispose()
  })

  it('a harmless strike (a safe area: radius 0) has no telegraph ring', () => {
    const { engine, scene, camera, fx } = setup()
    fx.setTier('off')
    const s = strike(1, 'ground', { radiusM: 0 })
    fx.strike(s)
    fx.update(s.warnAt! + 500, 0.016, camera)
    expect(fx.stats().quads).toBe(0)
    fx.dispose()
    scene.dispose()
    engine.dispose()
  })
})
