/**
 * Lane CST-A (docs/COAST.md §10, §12.6; docs/WAVE_PLAN6.md §6.1): the COAST area switches at 120 m with hysteresis,
 * at most 4 surf emitters, the gull species over water deeper than 8 m (its shore band and dry-sand loafing aside),
 * and ship routes over water deeper than 8 m in one draw. Synthetic seas, then the real coast field when exported.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NullEngine, Scene } from '@babylonjs/core'
import { afterAll, describe, expect, it } from 'vitest'
import { CoastField, decodePng } from '../../../packages/world-render/src/ocean/field.ts'
import {
  COAST_ENTER_M,
  COAST_LEAVE_M,
  CoastAudio,
  SURF_FILE,
  SURF_MAX_EMITTERS,
  STORM_SURF_FILE,
  coastZone,
  pickEmitters,
  scanShore,
  type CoastAudioOutput,
  type SeaProbe,
} from '../src/audio/coast.ts'
import type { Vec3Like, VoiceHandle } from '../src/audio/backend.ts'
import { GULL, GULL_DEEP_M, GULL_SHORE_BAND_M, GULL_WEIGHT, coastSeaOf, deepCircle, drySand, gullHabitat, registerGulls, type CoastSea } from '../src/world/fx/critters.ts'
import { CoastShips, SHIP, junkGeometry, offshoreOk, planShipRoute, routeOk } from '../src/world/fx/ships.ts'

/** A straight coast: land for z < 0 (rising 1 m per 10 m), sea for z ≥ 0 deepening 1 m per 20 m (8 m at z = 160). */
const straight: CoastSea = {
  seaLevelM: 5,
  seaAt: (_x, z) => z >= 0,
  depthAt: (_x, z) => (z >= 0 ? z / 20 : null),
  shoreDistM: (_x, z) => Math.max(-64, Math.min(64, z)),
  elevationM: (_x, z) => (z >= 0 ? -z / 20 : -z / 10),
}

function rng(seed = 7): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

class FakeVoice implements VoiceHandle {
  stopped = false
  gain: number
  constructor(readonly file: string, public pos: Vec3Like, gain: number) {
    this.gain = gain
  }
  stop(): void {
    this.stopped = true
  }
  setPosition(p: Vec3Like): void {
    this.pos = { ...p }
  }
  setGain(g: number): void {
    this.gain = g
  }
}

function fakeOut(): CoastAudioOutput & { voices: FakeVoice[]; live(): FakeVoice[] } {
  const voices: FakeVoice[] = []
  return {
    voices,
    live: () => voices.filter(v => !v.stopped),
    loopAt(file, o) {
      const v = new FakeVoice(file, o.pos, o.gain)
      voices.push(v)
      return v
    },
  }
}

describe('the COAST area', () => {
  it('measures the distance to the sea along the rays (0 standing in it)', () => {
    const s = scanShore(straight, 0, -50)
    expect(s.distM).toBeGreaterThan(49)
    expect(s.distM).toBeLessThan(51)
    expect(scanShore(straight, 0, 20).distM).toBe(0)
    expect(scanShore(straight, 0, -300).distM).toBe(Infinity)
  })

  it('switches on at 120 m and off beyond 140 m (hysteresis)', () => {
    expect(coastZone(false, COAST_ENTER_M)).toBe(true)
    expect(coastZone(false, COAST_ENTER_M + 1)).toBe(false)
    expect(coastZone(true, COAST_ENTER_M + 10)).toBe(true)
    expect(coastZone(true, COAST_LEAVE_M)).toBe(true)
    expect(coastZone(true, COAST_LEAVE_M + 1)).toBe(false)
  })

  it('walking inland and back flips the area once each way, never on the line', () => {
    const audio = new CoastAudio(fakeOut(), rng())
    const flips: Array<[number, boolean]> = []
    const walk = (zs: number[]) => {
      for (const z of zs) if (audio.update({ x: 0, y: 6, z, sea: straight, hs: 0.5, dt: 1 })) flips.push([z, audio.inZone])
    }
    const dither = [-125, -138, -122, -136, -130]
    walk(Array.from({ length: 60 }, (_, i) => -187 + i * 3)) // in from 187 m inland to the sea
    walk(dither) // in, between the lines: stays on
    walk(Array.from({ length: 30 }, (_, i) => -100 - i * 3)) // out to 187 m
    walk(dither) // out, between the lines: stays off
    expect(flips.map(f => f[1])).toEqual([true, false])
    const on = flips[0]!, off = flips[1]!
    expect(-on[0]).toBeLessThanOrEqual(COAST_ENTER_M)
    expect(-on[0]).toBeGreaterThan(COAST_ENTER_M - 8)
    expect(-off[0]).toBeGreaterThan(COAST_LEAVE_M)
  })
})

describe('the surf', () => {
  it('picks at most 4 points, the nearest first, 40 m apart', () => {
    const s = scanShore(straight, 0, -30)
    const p = pickEmitters(s.points)
    expect(p.length).toBeGreaterThan(1)
    expect(p.length).toBeLessThanOrEqual(SURF_MAX_EMITTERS)
    expect(p[0]!.d).toBeCloseTo(30, 0)
    for (const a of p) for (const b of p) if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(40)
  })

  it('keeps at most 4 emitters at the shore, louder sources near the sea, faded out inland', () => {
    const out = fakeOut()
    const audio = new CoastAudio(out, rng())
    for (let z = -300; z <= 30; z += 2) {
      audio.update({ x: 0, y: 6, z, sea: straight, hs: 0.5, dt: 0.5 })
      expect(audio.emitterPositions().length).toBeLessThanOrEqual(SURF_MAX_EMITTERS)
      expect(out.live().length).toBeLessThanOrEqual(SURF_MAX_EMITTERS)
    }
    expect(out.live().length).toBeGreaterThan(0)
    for (const v of out.live()) {
      expect(v.file).toBe(SURF_FILE)
      expect(Math.abs(v.pos.z)).toBeLessThan(1)
    }
    for (let z = 30; z >= -300; z -= 4) audio.update({ x: 0, y: 6, z, sea: straight, hs: 0.5, dt: 0.5 })
    expect(out.live()).toHaveLength(0)
    expect(audio.inZone).toBe(false)
  })

  it('adds the storm surf at the nearest emitter while Hs is high, with hysteresis', () => {
    const out = fakeOut()
    const audio = new CoastAudio(out, rng())
    const at = (hs: number) => audio.update({ x: 0, y: 6, z: -20, sea: straight, hs, dt: 1.1 })
    at(0.8)
    expect(out.live().some(v => v.file === STORM_SURF_FILE)).toBe(false)
    at(1.6)
    expect(out.live().filter(v => v.file === STORM_SURF_FILE)).toHaveLength(1)
    at(1.3)
    expect(out.live().filter(v => v.file === STORM_SURF_FILE)).toHaveLength(1)
    at(1.0)
    expect(out.live().some(v => v.file === STORM_SURF_FILE)).toBe(false)
    expect(audio.voices).toBeLessThanOrEqual(SURF_MAX_EMITTERS + 1)
  })

  it('a missing sea fades everything', () => {
    const out = fakeOut()
    const audio = new CoastAudio(out, rng())
    audio.update({ x: 0, y: 6, z: -10, sea: straight, hs: 0, dt: 1 })
    expect(out.live().length).toBeGreaterThan(0)
    audio.update({ x: 0, y: 6, z: -10, sea: null, hs: 0, dt: 1.1 })
    expect(out.live()).toHaveLength(0)
  })
})

describe('the gull', () => {
  const hab = gullHabitat(straight, () => 10)

  it('is a bird species of its own habitat', () => {
    expect(GULL.kind).toBe('bird')
    expect(GULL.habitat).toBe(hab.id)
  })

  it('circles only over water deeper than 8 m or along the shore band; never inland or over the far shallows', () => {
    for (let z = -200; z <= 400; z += 2) {
      const w = hab.weight(0, z)
      if (w > 0.2) {
        const deep = deepCircle(straight, 0, z)
        const band = z >= 0 && z <= GULL_SHORE_BAND_M
        expect(deep || band, `z ${z}`).toBe(true)
        if (deep) expect(straight.depthAt(0, z)! > GULL_DEEP_M).toBe(true)
      }
      if (z > GULL_SHORE_BAND_M && z < 160) expect(w, `z ${z}`).toBe(0)
      if (z < -40) expect(w, `z ${z}`).toBe(0)
    }
    expect(hab.weight(0, 300)).toBe(GULL_WEIGHT.deep)
  })

  it('loafs on dry sand only', () => {
    expect(hab.landing!(0, -30)).toBe(10) // 3 m above the sea, 30 m inland
    expect(hab.landing!(0, -10)).toBeNull() // the swash band (1 m)
    expect(hab.landing!(0, -100)).toBeNull() // inland
    expect(hab.landing!(0, 50)).toBeNull() // the sea
    expect(drySand(straight, 0, -30)).toBe(true)
  })

  it('registers and unregisters on a life part', () => {
    const calls: string[] = []
    const life = {
      addSpecies: (s: { id: string }) => (calls.push(`+${s.id}`), () => calls.push(`-${s.id}`)),
      addHabitat: (h: { id: string }) => (calls.push(`+${h.id}`), () => calls.push(`-${h.id}`)),
    }
    const off = registerGulls(life as never, straight, () => 0)
    off()
    off()
    expect(calls).toEqual(['+coast-gull', '+gull', '-gull', '-coast-gull'])
  })
})

describe('the ships', () => {
  const engine = new NullEngine()
  afterAll(() => engine.dispose())

  it('plans passes whose every sample is over water deeper than 8 m, clear of land', () => {
    const r = rng(11)
    let found = 0
    for (let i = 0; i < 30; i++) {
      const route = planShipRoute(straight, 0, -10, r)
      if (!route) continue
      found++
      expect(routeOk(straight, route)).toBe(true)
      for (let t = 0; t <= 1; t += 0.05) {
        const x = route.ax + (route.bx - route.ax) * t, z = route.az + (route.bz - route.az) * t
        expect(straight.depthAt(x, z)!).toBeGreaterThan(SHIP.deepM)
        expect(z).toBeGreaterThanOrEqual(160) // the 8 m line
      }
    }
    expect(found).toBeGreaterThan(5)
    expect(planShipRoute(straight, 0, -2000, rng())).toBeNull()
    expect(offshoreOk(straight, 0, 100)).toBe(false)
  })

  it('sails at most 3 junks as thin instances of one mesh (one draw)', () => {
    const scene = new Scene(engine)
    const ships = new CoastShips(scene, straight, { waveHeightAt: (x, z) => 5 + 0.3 * Math.sin(x * 0.1 + z * 0.07) }, rng(3))
    let max = 0
    for (let i = 0; i < 4000; i++) {
      ships.update(0, -10, 0.25)
      max = Math.max(max, ships.count)
      expect(ships.count).toBeLessThanOrEqual(SHIP.max)
      for (const route of ships.routes()) expect(routeOk(straight, route)).toBe(true)
    }
    expect(max).toBeGreaterThan(0)
    expect(scene.meshes.filter(m => m.metadata?.sroCoast === 'ships')).toHaveLength(1)
    expect(ships.mesh.thinInstanceCount).toBe(ships.count)
    ships.dispose()
    expect(scene.meshes).toHaveLength(0)
    expect(scene.materials.filter(m => m.name === 'sroCoastShip')).toHaveLength(0)
    scene.dispose()
  })

  it('the junk is a small flat-shaded mesh', () => {
    const g = junkGeometry()
    expect(g.indices.length / 3).toBeLessThan(150)
    expect(g.positions.length).toBe(g.normals.length)
    expect(g.colors.length / 4).toBe(g.positions.length / 3)
  })
})

describe('on the real coast field (work/out/world/jangan-fields)', () => {
  const dir = join(import.meta.dirname, '..', '..', '..', 'work', 'out', 'world', 'jangan-fields')
  const manifestPath = join(dir, 'manifest.json')
  const manifest = existsSync(manifestPath) ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as { coast?: { field: { file: string } } & Record<string, unknown> }) : null
  const has = !!manifest?.coast && existsSync(join(dir, manifest.coast.field.file))
  // The south beach S1 (COAST §3.5): the waterline near z 1285 at x 300, the 8 m line ≈ 175 m out.
  const BEACH = { x: 300, z: 1278 }

  it.skipIf(!has)('S1: the area is on at the beach, gulls find a circle near the player, ships sail over > 8 m', async () => {
    const image = await decodePng(new Uint8Array(readFileSync(join(dir, manifest!.coast!.field.file))))
    const field = new CoastField(manifest!.coast as never, image)
    const sea = coastSeaOf(field)
    const probe: SeaProbe = sea
    const scan = scanShore(probe, BEACH.x, BEACH.z)
    expect(scan.distM).toBeLessThan(COAST_ENTER_M)
    expect(pickEmitters(scan.points).length).toBeGreaterThan(0)
    // The life director's search (life/birds.ts bestHabitat: 18 samples at 25 / 50 / 75 m, weight > 0.2).
    const hab = gullHabitat(sea, () => 6)
    let best = 0
    for (const r of [25, 50, 75]) for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + r * 0.013
      best = Math.max(best, hab.weight(BEACH.x + Math.cos(a) * r, BEACH.z + Math.sin(a) * r))
    }
    expect(best).toBeGreaterThan(0.2)
    const r = rng(5)
    let routes = 0
    for (let i = 0; i < 20; i++) {
      const route = planShipRoute(sea, BEACH.x, BEACH.z, r)
      if (!route) continue
      routes++
      for (let t = 0; t <= 1; t += 0.025) expect(sea.depthAt(route.ax + (route.bx - route.ax) * t, route.az + (route.bz - route.az) * t)!).toBeGreaterThan(SHIP.deepM)
    }
    expect(routes).toBeGreaterThan(3)
    // Inland at the town (0, 0): no coast.
    expect(scanShore(probe, 0, 0).distM).toBe(Infinity)
    expect(planShipRoute(sea, 0, 0, rng())).toBeNull()
  })
})
