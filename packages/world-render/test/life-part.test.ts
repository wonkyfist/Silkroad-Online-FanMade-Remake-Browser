/**
 * GL-L, the wildlife part (docs/GRASS_LIFE.md §5; docs/WAVE_PLAN6.md §6.1 GL-L, §5.4 G4) on a NullEngine: each kind is
 * one mesh and one draw (tagged 'life', thin instances, never drawn at count 0, hidden with isVisible and never
 * setEnabled); butterflies by day, fireflies at night, nothing in rain (the critters fade over 5 s); ground flocks land
 * and flush when walked into (onFlush once); `configure({ groundFlocks: false })` spawns none; perchers sit on the
 * manifest's building ridges; a registered species (the coast's gull) lives in its registered habitat; Options →
 * Wildlife off hides everything and stops the updates; the World makes the part on the PBR path only.
 */
import { ArcRotateCamera, NullEngine, Scene, Vector3, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorldManifest, WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import { LIFE_TAG, type LifeFlush, type World, type WorldQuality } from '../src/index.ts'
import { WorldLife } from '../src/life/life.ts'
import { meadowNoise, type LifeGround } from '../src/life/spawn.ts'
import { w10World } from './w10-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

/** Grass everywhere east of x = -60, a pond west of x = -60, flat ground at 10 m. */
function field(): LifeGround {
  return {
    heightAt: () => 10,
    surfaceAt: (x) => (x < -60 ? 11 : 10),
    densityAt: x => (x < -60 ? 0 : 0.9),
    meadowAt: (x, z) => (x < -60 ? 0 : 0.9 * meadowNoise(x, z)),
    waterAt: x => (x < -60 ? 11 : null),
    floorAt: () => false,
  }
}

function manifest(): Pick<WorldManifest, 'models' | 'placements' | 'tiles'> {
  const models = [
    { source: 'res\\bldg\\china\\jangan01\\cj_house01.bsr', boundsMin: [-5, 0, -3], boundsMax: [5, 7, 3] },
    { source: 'res\\nature\\common\\flower\\flw_g01_yall.bsr', boundsMin: [-1, 0, -1], boundsMax: [1, 1, 1] },
    { source: 'res\\nature\\common\\tree\\new-maple\\tre_tree03.bsr', boundsMin: [-3, 0, -3], boundsMax: [3, 9, 3] },
  ].map((m, index) => ({ index, glb: null, sidecar: null, kind: 'static', animations: [], defaultClip: null, lightmappedMeshes: 0, bytes: 0, validatorErrors: null, ...m }) as unknown as WorldModel)
  const placements: WorldPlacement[] = []
  const put = (model: number, x: number, y: number, z: number) => placements.push({
    objId: model, source: models[model]!.source, models: [model], compound: false, position: [x, y, z], rotation: [0, 0, 0, 1], yaw: 0,
    flags: { static: true, big: false, struct: false }, staticFlag: 0xffff, uid: placements.length, region: 0, group: 2, inConvertedRegion: true,
  })
  for (let k = 0; k < 6; k++) put(0, -20 + k * 14, 10, 25)
  put(1, 6, 10, 4)
  // A grove around the player (the fireflies gather near trees).
  for (let k = 0; k < 16; k++) put(2, Math.cos(k * 0.9) * (6 + k * 2), 10, Math.sin(k * 0.9) * (6 + k * 2))
  return { models, placements, tiles: [] }
}

interface Rig {
  scene: Scene
  camera: ArcRotateCamera
  life: WorldLife
  sky: { night: number; t: number; day: number }
  weather: { rain: number; windMs: number }
  world: { quality: WorldQuality }
  adopt: ReturnType<typeof vi.fn>
  step(seconds: number, dt?: number): void
  draws(): Map<Mesh, number>
}

function rig(quality: WorldQuality = 'medium'): Rig {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const camera = new ArcRotateCamera('cam', -Math.PI / 2, 1.1, 9, new Vector3(0, 11, 0), scene)
  const sky = { night: 0, t: 0.5, day: 0 }
  const weather = { rain: 0, windMs: 3 }
  const adopt = vi.fn(() => () => {})
  const world = { quality }
  const fake = {
    scatter: { adopt, groundCover: null },
    manifest: manifest(),
    get skyState() {
      return sky
    },
    get weatherState() {
      return weather
    },
    get quality() {
      return world.quality
    },
  } as unknown as World
  const life = new WorldLife({ scene, world: fake }, { ground: field(), now: () => 1000 })
  // A NullEngine never marks a raw texture ready (a real engine does on upload): the materials would never draw.
  for (const m of life.meshes()) for (const t of m.material!.getActiveTextures()) {
    const it = t.getInternalTexture()
    if (it) it.isReady = true
  }
  cleanups.push(() => {
    life.dispose()
    scene.dispose()
    engine.dispose()
  })
  const step = (seconds: number, dt = 1 / 30) => {
    for (let t = 0; t < seconds; t += dt) life.update(camera, dt)
  }
  const draws = () => {
    const n = new Map<Mesh, number>()
    const obs = life.lifeMeshes().map(m => m.mesh.onBeforeDrawObservable.add(() => n.set(m.mesh, (n.get(m.mesh) ?? 0) + 1)))
    scene.render()
    life.lifeMeshes().forEach((m, i) => m.mesh.onBeforeDrawObservable.remove(obs[i]!))
    return n
  }
  return { scene, camera, life, sky, weather, world, adopt, step, draws }
}

describe('three meshes, one draw each (GRASS_LIFE §5.1, G4: life ≤ 3 draws)', () => {
  it('each kind is one thin-instanced mesh with its own material, tagged life, unpickable, adopted by the scatter', () => {
    const r = rig()
    const meshes = r.life.meshes()
    expect(meshes.map(m => m.name)).toEqual(['life_critters', 'life_birds', 'life_fireflies'])
    const mats = new Set(meshes.map(m => m.material))
    expect(mats.size).toBe(3)
    for (const m of meshes as Mesh[]) {
      expect((m.metadata as { sroWorld: string }).sroWorld).toBe(LIFE_TAG)
      expect(m.subMeshes).toHaveLength(1)
      expect(m.hasThinInstances).toBe(true)
      expect(m.isPickable).toBe(false)
      expect(m.alwaysSelectAsActiveMesh).toBe(true)
      expect(m.receiveShadows).toBe(false)
      expect(m.isVisible).toBe(false)
    }
    // The shared uniforms, defines and depth textures reach every material through WorldScatter.adopt.
    expect(r.adopt).toHaveBeenCalledTimes(3)
  })

  it('a clear noon: butterflies and birds draw, one draw each, the fireflies not at all', () => {
    const r = rig()
    r.step(12)
    const c = r.life.counts()
    expect(c.critters).toBeGreaterThan(10)
    expect(c.critters).toBeLessThanOrEqual(20 + 6)
    expect(c.birds).toBeGreaterThan(0)
    expect(c.fireflies).toBe(0)
    const d = r.draws()
    const [critters, birds, fireflies] = r.life.meshes() as Mesh[]
    expect(d.get(critters!)).toBe(1)
    expect(d.get(birds!)).toBe(1)
    expect(d.get(fireflies!) ?? 0).toBe(0)
    expect(critters!.thinInstanceCount).toBe(c.critters)
    expect(birds!.thinInstanceCount).toBe(c.birds)
  })

  it('High doubles the butterflies (40)', () => {
    const r = rig('high')
    r.step(12)
    expect(r.life.counts().critters).toBeGreaterThan(20)
  })

  it('never uses setEnabled on its meshes (no EnabledMeshCandidates rebuild), hides them with isVisible', () => {
    const r = rig()
    const spies = (r.life.meshes() as Mesh[]).map(m => vi.spyOn(m, 'setEnabled'))
    r.step(5)
    r.sky.night = 1
    r.sky.t = 0
    r.step(8)
    r.life.setEnabled(false)
    r.life.setEnabled(true)
    r.weather.rain = 0.8
    r.step(8)
    for (const s of spies) expect(s).not.toHaveBeenCalled()
    for (const m of r.life.meshes()) expect(m.isEnabled()).toBe(true)
  })
})

describe('time of day and weather', () => {
  it('night: fireflies fade in and draw; butterflies go; the birds leave', () => {
    const r = rig()
    r.step(10)
    r.sky.night = 1
    r.sky.t = 0.02
    r.step(12)
    const c = r.life.counts()
    expect(c.fireflies).toBeGreaterThan(20)
    expect(c.fireflies).toBeLessThanOrEqual(60)
    expect(c.critters).toBe(0)
    expect(r.life.fireflies.light).toBe(1)
    const d = r.draws()
    const [critters, , fireflies] = r.life.meshes() as Mesh[]
    expect(d.get(fireflies!)).toBe(1)
    expect(d.get(critters!) ?? 0).toBe(0)
    // The flocks flew off.
    r.step(30)
    expect(r.life.counts().birds).toBe(0)
  })

  it('rain: the critters fade out over 5 s, the birds fly off, nothing comes back until it clears', () => {
    const r = rig()
    r.step(12)
    expect(r.life.counts().critters).toBeGreaterThan(0)
    r.weather.rain = 0.6
    r.step(2.5)
    expect(r.life.critters.activity).toBeGreaterThan(0.3)
    expect(r.life.critters.activity).toBeLessThan(0.7)
    expect(r.life.counts().critters).toBeGreaterThan(0)
    r.step(3)
    expect(r.life.critters.activity).toBe(0)
    expect(r.life.counts().critters).toBe(0)
    r.step(40)
    expect(r.life.counts().birds).toBe(0)
    expect(r.draws().size).toBe(0)
    // Still under cover at 0.22 (the hysteresis), out again below 0.2.
    r.weather.rain = 0.22
    r.step(3)
    expect(r.life.counts().critters).toBe(0)
    r.weather.rain = 0.1
    r.step(6)
    expect(r.life.counts().critters).toBeGreaterThan(0)
  })
})

describe('the birds', () => {
  it('a ground flock lands in the grass, then flushes when the player walks into it (onFlush once)', () => {
    const r = rig()
    const flushes: LifeFlush[] = []
    r.life.onFlush.add(f => flushes.push({ ...f }))
    // The player stands still; a flock flies in and lands 14–24 m away.
    let spot: { x: number; z: number } | null = null
    for (let t = 0; t < 90 && !spot; t += 0.5) {
      r.step(0.5)
      const f = r.life.birds.flocksOf('ground').find(fl => fl.state === 'ground')
      if (f) spot = { x: f.spot[0]!, z: f.spot[2]! }
    }
    expect(spot).not.toBeNull()
    const d = Math.hypot(spot!.x, spot!.z)
    expect(d).toBeGreaterThanOrEqual(14)
    expect(d).toBeLessThanOrEqual(24)
    expect(flushes).toHaveLength(0)
    // Walk into it (the threats: the known actors, here the player alone).
    const me = { x: 0, y: 10, z: 0 }
    r.life.setThreats(() => [me])
    for (let k = 0; k <= 20 && !flushes.length; k++) {
      me.x = (spot!.x * k) / 20
      me.z = (spot!.z * k) / 20
      r.step(0.2)
    }
    expect(flushes).toHaveLength(1)
    expect(flushes[0]!.count).toBeGreaterThanOrEqual(8)
    expect(Math.hypot(flushes[0]!.x - spot!.x, flushes[0]!.z - spot!.z)).toBeLessThan(0.01)
    expect(Math.hypot(me.x - spot!.x, me.z - spot!.z)).toBeLessThanOrEqual(9.01)
    r.step(1)
    expect(flushes).toHaveLength(1)
  })

  it('configure({ groundFlocks: false }) spawns no ground flock (the stage); perchers still come', () => {
    const r = rig()
    r.life.configure({ groundFlocks: false })
    r.step(40)
    expect(r.life.birds.flocksOf('ground')).toHaveLength(0)
    expect(r.life.birds.birdsOf('perch')).toBeGreaterThan(0)
    // Switched on again, a ground flock comes.
    r.life.configure({ groundFlocks: true })
    r.step(5)
    expect(r.life.birds.flocksOf('ground').length).toBeGreaterThan(0)
  })

  it('perchers fly in and sit on the building ridges from the manifest bounds', () => {
    const r = rig()
    r.life.configure({ groundFlocks: false })
    r.step(40)
    const perched = r.life.birds.flocksOf('perch').filter(f => f.state === 'ground')
    expect(perched.length).toBeGreaterThan(0)
    for (const f of perched) {
      // The ridge top of a 7 m house placed at y 10.
      expect(f.spot[1]).toBeCloseTo(17, 5)
      for (let i = 0; i < f.n; i++) expect(Math.abs(f.pos[i * 3 + 1]! - 17)).toBeLessThanOrEqual(0.5)
    }
  })

  it('a registered species lives in its registered habitat (the coast\'s gull, CST-A)', () => {
    const r = rig()
    r.life.configure({ groundFlocks: false })
    const offS = r.life.addSpecies({ id: 'gull', kind: 'bird', habitat: 'test-sea', colors: [[0.5, 0.5, 0.55], [0.95, 0.95, 0.95]], scale: 2.2, max: 8 })
    r.step(5)
    expect(r.life.birds.flocksOf('habitat')).toHaveLength(0)
    const offH = r.life.addHabitat({ id: 'test-sea', weight: x => (x < -40 ? 1 : 0), landing: (x) => (x < -40 ? 10 : null) })
    r.step(3)
    const gulls = r.life.birds.flocksOf('habitat')
    expect(gulls).toHaveLength(1)
    expect(gulls[0]!.n).toBe(8)
    expect(gulls[0]!.centre[0]).toBeLessThan(-40)
    offS()
    expect(r.life.birds.flocksOf('habitat')).toHaveLength(0)
    offH()
    r.step(3)
    expect(r.life.birds.flocksOf('habitat')).toHaveLength(0)
  })
})

describe('Options → Wildlife and the part\'s life cycle', () => {
  it('off hides every animal and stops the updates; on brings them back', () => {
    const r = rig()
    r.step(12)
    expect(r.life.counts().critters).toBeGreaterThan(0)
    r.life.setEnabled(false)
    expect(r.life.enabled).toBe(false)
    for (const m of r.life.meshes()) expect(m.isVisible).toBe(false)
    const before = r.life.stats.updateMs
    r.step(3)
    expect(r.draws().size).toBe(0)
    expect(r.life.stats.updateMs).toBe(before)
    r.life.setEnabled(true)
    r.step(8)
    expect(r.life.counts().critters).toBeGreaterThan(0)
    expect(r.draws().size).toBeGreaterThan(0)
  })

  it('an explicit focus (the stage) moves the animals with it', () => {
    const r = rig()
    r.life.setFocus(300, 300)
    r.step(12)
    const buf = r.life.lifeMeshes()[0]!.buf
    for (let i = 0; i < r.life.counts().critters; i++) expect(Math.hypot(buf[i * 16 + 12]! - 300, buf[i * 16 + 14]! - 300)).toBeLessThanOrEqual(30)
  })

  it('stays within its CPU budget on a NullEngine (≤ 0.1 ms p95 on the dev PC; generous here)', () => {
    const r = rig('high')
    r.step(20)
    const times: number[] = []
    for (let k = 0; k < 300; k++) {
      r.life.update(r.camera, 1 / 60)
      times.push(r.life.stats.updateMs)
    }
    times.sort((a, b) => a - b)
    // The headless test machine is loaded; the in-browser gate is LAB-10R's.
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(1)
  })

  it('dispose drops the meshes and materials', () => {
    const r = rig()
    r.step(5)
    const meshes = r.life.meshes()
    const mats = meshes.map(m => m.material!)
    r.life.dispose()
    for (const m of meshes) expect(m.isDisposed()).toBe(true)
    for (const m of mats) expect(r.scene.materials.includes(m)).toBe(false)
  })
})

describe('the World wiring (W10-S\'s slot, the default factory)', () => {
  it('the PBR world makes a WorldLife with its three tagged meshes; the Classic world none (the Low guard)', async () => {
    const s = await w10World({ render: 'pbr' })
    cleanups.push(s.dispose)
    expect(s.world.life).toBeInstanceOf(WorldLife)
    const meshes = s.world.life!.meshes()
    expect(meshes).toHaveLength(3)
    for (const m of meshes) expect((m.metadata as { sroWorld: string }).sroWorld).toBe(LIFE_TAG)
    // The world's materials are adopted by its scatter.
    for (const m of meshes) expect(s.world.scatter.adopts(m.material as never)).toBe(true)
    await s.run()
    for (let k = 0; k < 30; k++) expect(() => s.world.update(s.scene.activeCamera ?? null, { x: 96, z: -96 })).not.toThrow()
    const c = await w10World({ render: 'classic' })
    cleanups.push(c.dispose)
    expect(c.world.life).toBeNull()
    // Switching the path drops and remakes it.
    s.world.setRenderMode('classic')
    expect(s.world.life).toBeNull()
    for (const m of meshes) expect(m.isDisposed()).toBe(true)
    s.world.setRenderMode('pbr')
    expect(s.world.life).toBeInstanceOf(WorldLife)
  })
})
