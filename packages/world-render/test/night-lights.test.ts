/**
 * Night lights (docs/WAVE_PLAN3.md §6.7, D12, D29; docs/SKY.md §7): the light table and the Jangan light count, the
 * splat (black by day and at the radius, lit under a lamp, oriented like the terrain), the grass window, the point
 * lights (the light count never changes while lights are reassigned or night falls; the cluster fallback when
 * `isSupported` is false; a character material's lightSources includes the cluster), the lamp glow, the ambient night
 * hysteresis, the chunks (both languages, same points, everything behind a define) and a Low world.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ClusteredLightContainer,
  Color3,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  PointLight,
  Scene,
  StandardMaterial,
  Vector3,
  type AbstractMesh,
  type BaseTexture,
  type AbstractEngine,
} from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import {
  NIGHT_CHUNKS,
  NIGHT_GRASS_DEFINE,
  NIGHT_LIGHT_KINDS,
  NIGHT_SPLAT_GLSL,
  NIGHT_SPLAT_MAX,
  NIGHT_SPLAT_WGSL,
  NIGHT_TERRAIN_DEFINE,
  NightLights,
  NightPointLights,
  RENDER_PRESETS,
  SharedUniforms,
  ambientNightSwitch,
  bakeSplat,
  loadWorld,
  nightKindOf,
  placeLights,
  scatterShaders,
  splatWindow,
  terrainShaders,
  type NightLight,
  type NightLightsHost,
  type PlacedModelInfo,
  type RegionListener,
} from '../src/index.ts'
import { readAmbientIndex, type AmbientParticle } from '../src/ambient-fx.ts'
import type { NightLightQuality } from '../src/render/quality.ts'
import { ROOT_URL, WORLD_NAME, makeFixture } from './stream-fixture.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function newScene(): Scene {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return scene
}

/** Makes the NullEngine look like a WebGL2 engine with float blending, so clusters are supported. */
function enableClusters(engine: AbstractEngine): void {
  const caps = engine.getCaps() as unknown as Record<string, unknown>
  caps.texelFetch = true
  caps.colorBufferFloat = true
  caps.blendFloat = true
  caps.shaderFloatPrecision = 23
  Object.defineProperty(engine, 'version', { value: 2, configurable: true })
}

const lampRow = (efp: string, y = 3, night = true): AmbientParticle => ({ kind: 'ambient', efp, bone: null, position: [0, y, 0], night })
const at = (x: number, y: number, z: number): Pick<WorldPlacement, 'position' | 'rotation'> => ({ position: [x, y, z], rotation: [0, 0, 0, 1] })
const flat = (h = 0) => new Float32Array(97 * 97).fill(h)
const plc = (x: number, y: number, z: number) => ({ ...at(x, y, z), models: [3] }) as unknown as WorldPlacement

/** A host with fake terrain / scatter / objects that records what NightLights does. */
function fakeHost(scene: Scene, q: NightLightQuality, night = { night: 0 }) {
  const bound = new Map<number, BaseTexture | null>()
  const terrainDefines = new Set<string>()
  const scatterDefines = new Set<string>()
  const listeners: RegionListener[] = []
  const steps: Array<(r: never) => void> = []
  const quality = { nightLights: q }
  const host: NightLightsHost = {
    scene,
    assets: { json: async <T>() => ({ models: {} }) as T },
    objects: { addRegionListener: l => (listeners.push(l), () => listeners.splice(listeners.indexOf(l), 1)) },
    terrain: {
      sharedUniforms: new SharedUniforms(),
      setRegionTexture: (id, _slot, tex) => (bound.set(id, tex), true),
      setDefine: (n, on) => void (on ? terrainDefines.add(n) : terrainDefines.delete(n)),
      onRegionDisposed: { add: () => null, remove: () => true },
    },
    scatter: { sharedUniforms: new SharedUniforms(), setDefine: (n, on) => void (on ? scatterDefines.add(n) : scatterDefines.delete(n)) },
    render: { quality, weather: { rain: 0 } },
    skyState: night,
    addCommitStep: (_name, run) => (steps.push(run as (r: never) => void), () => {}),
  }
  return { host, bound, terrainDefines, scatterDefines, listeners, steps, quality, night }
}

const model = (index: number, source: string): WorldModel => ({
  index, source, glb: `m${index}.glb`, sidecar: null, kind: 'static', animations: [], defaultClip: null, lightmappedMeshes: 0,
  boundsMin: [0, 0, 0], boundsMax: [1, 4, 1],
} as unknown as WorldModel)
const info = (m: WorldModel): PlacedModelInfo => ({ index: m.index, source: m.source, heightM: 4, isFoliage: false, kind: 'static' })

describe('the light table (SKY §7.2)', () => {
  it('maps the lamp and fire effects to their kinds; unknown effects give no light', () => {
    expect(nightKindOf('map/cj_pal_lamp_orange.efp')?.id).toBe('lampOrange')
    expect(nightKindOf('map/cj_pal_lamp_orange_s.efp')?.id).toBe('lampOrange')
    expect(nightKindOf('map/cj_pal_lamp_red_b.efp')?.id).toBe('lampRed')
    expect(nightKindOf('map/cj_pal_lamp_light.efp')?.id).toBe('lampLight')
    expect(nightKindOf('map/light.efp')?.id).toBe('lampLight')
    expect(nightKindOf('MAP\\Frame.efp')?.id).toBe('fire')
    expect(nightKindOf('map/frame2.efp')?.id).toBe('fire')
    expect(nightKindOf('dun/red_orange_flame_glow_3small.efp')?.id).toBe('fire')
    for (const none of ['map/oas_hot_etc_b.efp', 'map/multigi.efp', 'map/cj_pal_potal_blue.efp', 'map/lightning.efp']) expect(nightKindOf(none)).toBeNull()
    expect(NIGHT_LIGHT_KINDS.find(k => k.id === 'fire')).toMatchObject({ radiusM: 8, intensity: 1.2, flicker: 0.12 })
  })

  it('places a model\'s lights and merges those within 0.5 m (a flame and its glow)', () => {
    const rows = [lampRow('dun/red_orange_flame.efp', 2), lampRow('dun/red_orange_flame_glow_3small.efp', 2.3), lampRow('map/oas_hot_etc_b.efp')]
    const out: NightLight[] = []
    const merged = placeLights(rows, [at(10, 0, -5), at(20, 1, -5)], 7, [], out)
    expect(merged).toBe(2)
    expect(out.map(l => [l.x, l.y, l.z, l.owner, l.kind.id])).toEqual([[10, 2, -5, 7, 'fire'], [20, 3, -5, 7, 'fire']])
    // Against lights already placed.
    const again: NightLight[] = []
    expect(placeLights(rows.slice(0, 1), [at(10.2, 0, -5)], 8, out, again)).toBe(1)
    expect(again).toEqual([])
  })
})

const INDEX = join(ROOT, 'work', 'out', 'world', 'jangan', 'ambient.json')
const MANIFEST = join(ROOT, 'work', 'out', 'world', 'jangan', 'manifest.json')
describe.runIf(existsSync(INDEX) && existsSync(MANIFEST))('Jangan (work/out/world/jangan)', () => {
  it('has 109 lights from night emitters (SKY §7.1) minus merged duplicates, plus the day fires and lamps', () => {
    const index = readAmbientIndex(JSON.parse(readFileSync(INDEX, 'utf8')))
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { placements: WorldPlacement[] }
    const lights: NightLight[] = []
    let merged = 0
    for (const p of manifest.placements) {
      for (const mi of p.models) {
        const rows = index.get(mi)
        if (rows) merged += placeLights(rows, [p], -1, lights, lights)
      }
    }
    const night = lights.filter(l => l.fromNight).length
    expect(night + merged).toBeGreaterThanOrEqual(109)
    expect(night).toBeLessThanOrEqual(109)
    expect(night).toBeGreaterThan(95)
    // The day emitters with a kind: frame2 ×6 (the gate braziers), cj_pal_lamp_orange_b ×2, cj_pal_lamp_red_b ×1.
    expect(lights.length - night).toBeLessThanOrEqual(9)
    expect(lights.filter(l => l.kind.id === 'fire').length).toBeGreaterThanOrEqual(8)
  })
})

describe('the splat (SKY §7.3.1)', () => {
  it('the window is 1 at the light, falls off, and is 0 at and beyond the radius', () => {
    expect(splatWindow(0, 7)).toBe(1)
    expect(splatWindow(3, 7)).toBeLessThan(splatWindow(1, 7))
    expect(splatWindow(7, 7)).toBe(0)
    expect(splatWindow(9, 7)).toBe(0)
    expect(splatWindow(6.99, 7)).toBeGreaterThan(0)
  })

  it('is lit under a lamp, black at its radius, rows north and columns east', () => {
    const lamp = { ...NIGHT_LIGHT_KINDS[0]!, radiusM: 7 }
    // Region origin (100, 0, −50): it spans x 100..292, z −242..−50. The lamp 3 m above (130, −90): 30 m east, 40 m north.
    const light: NightLight = { x: 130, y: 3, z: -90, kind: lamp, owner: 0, seed: 0.5, fromNight: true }
    const out = new Uint8Array(192 * 192 * 4)
    const lit = bakeSplat(out, { origin: [100, 0, -50], heights: flat() }, [light])
    expect(lit).toBeGreaterThan(20)
    const px = (i: number, j: number) => Array.from(out.subarray((j * 192 + i) * 4, (j * 192 + i) * 4 + 4))
    const under = px(30, 40)
    expect(under[0]).toBeGreaterThan(60)
    expect(under[0]).toBeGreaterThan(under[2]!) // warm
    expect(under[3]).toBe(255)
    // The texel whose centre is 7 m or more away is black; so is the far corner.
    expect(px(37, 40).slice(0, 3)).toEqual([0, 0, 0])
    expect(px(30, 47).slice(0, 3)).toEqual([0, 0, 0])
    expect(px(0, 0).slice(0, 3)).toEqual([0, 0, 0])
    // A lamp below the ground (N·L < 0) lights nothing; no lights: nothing lit.
    expect(bakeSplat(out, { origin: [100, 0, -50], heights: flat(10) }, [light])).toBe(0)
    expect(bakeSplat(out, { origin: [100, 0, -50], heights: flat() }, [])).toBe(0)
  })

  it('adds to the terrain only through nlNight, which is 0 by day and night × NIGHT_SPLAT_MAX at night', () => {
    const scene = newScene()
    const f = fakeHost(scene, RENDER_PRESETS.low.nightLights)
    const nl = new NightLights(f.host, { index: new Map(), autoUpdate: false, focus: () => null })
    cleanups.push(() => nl.dispose())
    nl.update()
    expect(nl.uniform.x).toBe(0)
    f.night.night = 1
    nl.update()
    expect(nl.uniform.x).toBe(NIGHT_SPLAT_MAX)
    f.night.night = NaN
    nl.update()
    expect(nl.uniform.x).toBe(0)
    expect(f.host.terrain.sharedUniforms.get('nlNight')).toBe(nl.uniform)
    expect(f.host.scatter.sharedUniforms.get('nlNight')).toBe(nl.uniform)
  })
})

describe('NightLights on a host', () => {
  function withLamp(q: NightLightQuality) {
    const scene = newScene()
    const f = fakeHost(scene, q)
    const index = new Map<number, AmbientParticle[]>([[3, [lampRow('map/cj_pal_lamp_orange.efp', 4)]]])
    const now = { t: 0 }
    const nl = new NightLights(f.host, { index, autoUpdate: false, now: () => now.t, focus: () => ({ x: 40, y: 0, z: -40 }) })
    cleanups.push(() => nl.dispose())
    const lampModel = model(3, 'res\\artifact\\china\\jangan\\cj_pal_lamp.bsr')
    const mat = new StandardMaterial('CJ_pal_lamp', scene)
    mat.emissiveColor = new Color3(0.1, 0, 0)
    const mesh = MeshBuilder.CreateBox('lamp', { size: 1 }, scene)
    mesh.material = mat
    f.listeners[0]!.placed(-1, lampModel, info(lampModel), [mesh], [plc(40, 0, -40)])
    return { scene, f, nl, mat, now }
  }

  it('Low: splat on the terrain and the grass, no point lights, lamp glow; defines set once at attach', () => {
    const { f, nl, mat } = withLamp(RENDER_PRESETS.low.nightLights)
    expect([...f.terrainDefines]).toEqual([NIGHT_TERRAIN_DEFINE])
    expect([...f.scatterDefines]).toEqual([NIGHT_GRASS_DEFINE])
    expect(nl.points).toBeNull()
    expect(nl.stats).toMatchObject({ lights: 1, fromNight: 1, points: 'none', pointLights: 0, lampMaterials: 1 })
    // The commit step bakes the region; its splat is bound on the terrain.
    f.steps[0]!({ region: { id: 5, origin: [0, 0, 0] }, terrain: { heights: flat() } } as never)
    expect(nl.splatOf(5)).not.toBeNull()
    expect(f.bound.get(5)).toBe(nl.textureOf(5))
    // A region the light does not reach binds nothing.
    f.steps[0]!({ region: { id: 6, origin: [192, 0, 0] }, terrain: { heights: flat() } } as never)
    expect(nl.splatOf(6)).toBeNull()
    expect(f.bound.has(6)).toBe(false)
    // Night: the lamp glows (base + orange × 0.8), the grass window is baked around the focus and bound.
    expect(mat.emissiveColor.asArray()).toEqual([0.1, 0, 0])
    f.night.night = 1
    nl.update()
    expect(mat.emissiveColor.r).toBeCloseTo(0.1 + 0.8, 6)
    expect(mat.emissiveColor.g).toBeCloseTo(0.62 * 0.8, 6)
    expect(nl.grassTexture).not.toBeNull()
    expect(f.host.scatter.sharedUniforms.get('nlGrassSplat')).toBe(nl.grassTexture)
    // The window holds the region's texel under the lamp: world (40, −40) = region texel (40, 40).
    const g = nl.grassUniform
    const u = Math.floor(40 - g.x), v = Math.floor(-40 - g.y)
    const data = (nl as unknown as { grassData: Uint8Array }).grassData
    const s = nl.splatOf(5)!
    expect(data[(v * 256 + u) * 4]).toBe(s[(40 * 192 + 40) * 4])
    expect(data[(v * 256 + u) * 4]).toBeGreaterThan(0)
    // Nightfall changed no define; dispose restores the material and clears the defines.
    expect([...f.terrainDefines]).toEqual([NIGHT_TERRAIN_DEFINE])
    nl.dispose()
    expect(mat.emissiveColor.asArray()).toEqual([0.1, 0, 0])
    expect(f.terrainDefines.size + f.scatterDefines.size).toBe(0)
  })

  it('a neighbour\'s lights arriving later re-bake a region (one per frame)', () => {
    const { f, nl } = withLamp(RENDER_PRESETS.low.nightLights)
    f.steps[0]!({ region: { id: 6, origin: [-192, 0, 0] }, terrain: { heights: flat() } } as never)
    expect(nl.splatOf(6)).toBeNull()
    const m = model(3, 'x')
    f.listeners[0]!.placed(9, m, info(m), [], [plc(-2, 0, -60)])
    nl.update()
    expect(nl.splatOf(6)).not.toBeNull()
    // The owner unloads: its lights go and the region bakes dark again.
    f.listeners[0]!.removed(9)
    nl.update()
    expect(nl.splatOf(6)).toBeNull()
  })

  it('High: no terrain splat (the cluster lights the terrain, D29), grass splat on', () => {
    const { f } = withLamp(RENDER_PRESETS.high.nightLights)
    expect([...f.terrainDefines]).toEqual([])
    expect([...f.scatterDefines]).toEqual([NIGHT_GRASS_DEFINE])
    f.steps[0]!({ region: { id: 5, origin: [0, 0, 0] }, terrain: { heights: flat() } } as never)
    expect(f.bound.has(5)).toBe(false)
  })

  it('Medium without cluster support: a pool of 2 lights; the light count never changes while lights are reassigned', () => {
    const scene = newScene()
    const f = fakeHost(scene, RENDER_PRESETS.medium.nightLights)
    const index = new Map<number, AmbientParticle[]>([[3, [lampRow('map/cj_pal_lamp_orange.efp', 4)]]])
    const now = { t: 0 }
    const focus = { x: 0, y: 0, z: 0 }
    const nl = new NightLights(f.host, { index, autoUpdate: false, now: () => now.t, focus: () => focus })
    cleanups.push(() => nl.dispose())
    expect(nl.points?.mode).toBe('pool')
    expect(nl.points?.lights.length).toBe(2)
    // A character-like mesh: its light sources are fixed from here on.
    const who = MeshBuilder.CreateBox('who', { size: 1 }, scene)
    who.material = new PBRMaterial('skin', scene)
    const m = model(3, 'y')
    f.listeners[0]!.placed(-1, m, info(m), [], [0, 10, 20, 30, 40].map(x => plc(x, 0, 0)))
    const count = () => [scene.lights.length, who.lightSources.length, scene.lights.filter(l => l.isEnabled()).length]
    const before = count()
    expect(before[0]).toBe(2)
    // Day: dark, parked.
    nl.update()
    expect(nl.points!.lights.every(l => l.intensity === 0)).toBe(true)
    // Night falls; walk along the lamps: the nearest two light up, then others take over.
    f.night.night = 1
    const seen = new Set<number>()
    for (let i = 0; i <= 80; i++) {
      now.t = i * 50
      focus.x = i * 0.5
      nl.update()
      for (const l of nl.points!.lights) if (l.intensity > 0) seen.add(Math.round(l.position.x))
      expect(count()).toEqual(before)
    }
    expect(nl.points!.active).toBe(2)
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 10, 20, 30, 40])
    const lit = nl.points!.lights.map(l => Math.round(l.position.x)).sort((a, b) => a - b)
    expect(lit).toEqual([30, 40])
    expect(nl.points!.lights[0]!.range).toBe(10) // lampOrange's point reach (H11-NT-4; the splat keeps radiusM 7)
    // Dawn: dark again, still the same lights.
    f.night.night = 0
    nl.update()
    expect(nl.points!.lights.every(l => l.intensity === 0)).toBe(true)
    expect(count()).toEqual(before)
  })

  it('the cluster (when supported) is one light in a character material\'s lightSources, and holds the preset count', () => {
    const scene = newScene()
    enableClusters(scene.getEngine())
    const who = MeshBuilder.CreateBox('who', { size: 1 }, scene)
    who.material = new PBRMaterial('skin', scene)
    const f = fakeHost(scene, RENDER_PRESETS.medium.nightLights)
    const nl = new NightLights(f.host, { index: new Map(), autoUpdate: false, focus: () => null })
    cleanups.push(() => nl.dispose())
    const c = nl.points!.container
    expect(nl.points!.mode).toBe('cluster')
    expect(c).toBeInstanceOf(ClusteredLightContainer)
    expect(c!.lights.length).toBe(8)
    expect(scene.lights).toEqual([c])
    expect(who.lightSources).toContain(c)
    expect(who.lightSources.some(l => l instanceof PointLight)).toBe(false)
    // A hit light joins the cluster (D12), and goes back to the scene when the lights are disposed.
    const hit = new PointLight('hit', Vector3.Zero(), scene)
    expect(nl.addDynamicLight(hit)).toBe(true)
    expect(c!.lights).toContain(hit)
    expect(scene.lights).toEqual([c])
    nl.dispose()
    expect(scene.lights).toEqual([hit])
    expect(hit.isDisposed()).toBe(false)
  })

  it('the cluster fallback: isSupported false gives the pool, and a preset change swaps the lights once', () => {
    const scene = newScene()
    const f = fakeHost(scene, RENDER_PRESETS.ultra.nightLights)
    const nl = new NightLights(f.host, { index: new Map(), autoUpdate: false, focus: () => null })
    cleanups.push(() => nl.dispose())
    expect(nl.points!.container).toBeNull()
    expect(nl.points!.mode).toBe('pool')
    expect(scene.lights.length).toBe(2)
    expect(nl.addDynamicLight(new PointLight('hit', Vector3.Zero(), scene))).toBe(false)
    const pool = nl.points
    nl.update()
    expect(nl.points).toBe(pool)
    // Options → Low: the point lights go (the only moment the count changes).
    f.quality.nightLights = RENDER_PRESETS.low.nightLights
    nl.update()
    expect(nl.points).toBeNull()
    expect(scene.lights.map(l => l.name)).toEqual(['hit'])
  })

  it('NightPointLights directly: Ultra with clusters holds 64 lights (2 WebGPU batches)', () => {
    const scene = newScene()
    enableClusters(scene.getEngine())
    const p = new NightPointLights(scene, RENDER_PRESETS.ultra.nightLights)
    cleanups.push(() => p.dispose())
    expect(p.container?.lights.length).toBe(64)
    expect(scene.lights.length).toBe(1)
  })
})

describe('lamp glow rules (SKY §7.3.3)', () => {
  it('lamp models glow; other night-emitter owners only on materials named light; unlit materials are left', () => {
    const scene = newScene()
    const f = fakeHost(scene, RENDER_PRESETS.low.nightLights)
    const index = new Map<number, AmbientParticle[]>([[1, [lampRow('map/light.efp')]]])
    const nl = new NightLights(f.host, { index, autoUpdate: false, focus: () => null })
    cleanups.push(() => nl.dispose())
    const mk = (name: string, unlit = false) => {
      const m = new StandardMaterial(name, scene)
      m.disableLighting = unlit
      const mesh = MeshBuilder.CreateBox(name, { size: 1 }, scene)
      mesh.material = m
      return mesh as AbstractMesh
    }
    const shop = model(1, 'res\\bldg\\china\\jangan01\\cj_etc.bsr')
    f.listeners[0]!.placed(-1, shop, info(shop), [mk('CJ_etc_roof'), mk('CJ_etc_light01'), mk('CJ_etc_winlight', true)], [])
    const field = model(2, 'res\\artifact\\china\\jangan\\cj_field_lamp.bsr')
    f.listeners[0]!.placed(-1, field, info(field), [mk('CJ_pal_lamp'), mk('CJ_pal_lamp_al')], [])
    const plain = model(4, 'res\\bldg\\china\\jangan01\\cj_house.bsr')
    f.listeners[0]!.placed(-1, plain, info(plain), [mk('CJ_house_light')], [])
    expect(nl.stats.lampMaterials).toBe(3)
    f.night.night = 0.5
    nl.update()
    const e = (n: string) => (scene.getMaterialByName(n) as StandardMaterial).emissiveColor
    expect(e('CJ_etc_light01').r).toBeCloseTo(0.4, 6)
    expect(e('CJ_etc_roof').r).toBe(0)
    expect(e('CJ_pal_lamp').r).toBeCloseTo(0.4, 6)
    expect(e('CJ_house_light').r).toBe(0)
  })
})

describe('the ambient-effect night switch (fx-world, SKY §7.2)', () => {
  it('turns on above 0.6 and off below 0.4', () => {
    let on = false
    const walk = (n: number) => (on = ambientNightSwitch(on, n))
    expect([0, 0.3, 0.5, 0.6].map(walk)).toEqual([false, false, false, false])
    expect([0.61, 0.5, 0.41, 0.4].map(walk)).toEqual([true, true, true, true])
    expect([0.39, 0.5].map(walk)).toEqual([false, false])
    expect(ambientNightSwitch(true, NaN)).toBe(true)
  })
})

describe('the chunks (both languages, D1)', () => {
  it('ship WGSL and GLSL with the same points per shader, the splat behind its define', () => {
    for (const shader of ['terrain', 'grass'] as const) {
      const c = NIGHT_CHUNKS[shader]!
      expect(Object.keys(c.wgsl!).sort()).toEqual(Object.keys(c.glsl!).sort())
      for (const lang of ['wgsl', 'glsl'] as const) {
        for (const [point, code] of Object.entries(c[lang]!)) {
          if (point === 'uniforms' || point === 'samplers') continue
          const def = shader === 'terrain' ? NIGHT_TERRAIN_DEFINE : NIGHT_GRASS_DEFINE
          expect(code.trimStart().startsWith(`#ifdef ${def}`), `${shader} ${lang} ${point}`).toBe(true)
          expect(code.trimEnd().endsWith('#endif')).toBe(true)
        }
      }
      expect(c.wgsl!.samplers).not.toMatch(/\btextureSample\(/)
    }
    expect(NIGHT_CHUNKS.terrain!.samplers).toEqual(['nightSplat'])
    expect(NIGHT_SPLAT_WGSL).toContain('fn sroNightSplat(')
    expect(NIGHT_SPLAT_GLSL).toContain('vec3 sroNightSplat(')
  })

  it('WGSL taps are textureSampleLevel only, and no GLSL syntax in the WGSL', () => {
    const t = terrainShaders([NIGHT_CHUNKS])
    const g = scatterShaders([NIGHT_CHUNKS])
    for (const src of [t.fragmentWGSL, g.fragmentWGSL]) {
      const mine = src.slice(src.indexOf('#ifdef SRO_NIGHT'))
      const block = mine.slice(0, mine.indexOf('#endif'))
      expect(block).toContain('textureSampleLevel(')
      expect(block).not.toMatch(/textureSample\(|textureLod|texture\(/)
    }
    expect(t.fragmentGLSL).toContain('textureLod(nightSplat, lp / 1920.0, 0.0)')
    expect(t.uniforms).toContain('nlNight')
    expect(g.uniforms).toEqual(expect.arrayContaining(['nlNight', 'nlGrass']))
    expect(g.samplers).toContain('nlGrassSplat')
    // Neither chunk asks for a new varying (the 16-varying adapters).
    expect(NIGHT_CHUNKS.terrain!.vWorld ?? false).toBe(false)
    expect(NIGHT_CHUNKS.grass!.vWorld ?? false).toBe(false)
  })
})

describe('a Low world (NullEngine)', () => {
  it('binds the splat per region through the terrain, and leaves the world as it was on dispose', async () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    const fx = makeFixture()
    const world = await loadWorld(scene, { baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false, stream: false, quality: 'low' })
    cleanups.push(() => {
      world.dispose()
      scene.dispose()
      engine.dispose()
    })
    const nl = new NightLights(world, { index: new Map(), autoUpdate: false, focus: () => null })
    await world.objectsReady
    await nl.ready
    await new Promise(r => setTimeout(r, 0))
    const data = world.regions.regions[0]!
    const [ox, oy, oz] = data.region.origin
    nl.lights.push({ x: ox + 50, y: oy + (data.terrain.heights[0] ?? 0) + 3, z: oz - 50, kind: NIGHT_LIGHT_KINDS[0]!, owner: -1, seed: 0, fromNight: true })
    nl.bakeRegion(data)
    const tex = nl.textureOf(data.region.id)
    expect(tex).not.toBeNull()
    const gpu = world.terrain.region(data.region.id)!
    expect(gpu.textures.nightSplat).toBe(tex)
    const mat = gpu.material as unknown as { _textures: Record<string, BaseTexture>; options: { defines?: string[] } }
    expect(mat._textures.nightSplat).toBe(tex)
    expect((mat.options.defines ?? []).some(d => d.startsWith(NIGHT_TERRAIN_DEFINE))).toBe(true)
    // The commit step baked every region (none lit: no lights then).
    expect(nl.stats.regions).toBe(world.regions.regions.length)
    nl.dispose()
    expect(gpu.textures.nightSplat).toBeUndefined()
    expect((mat.options.defines ?? []).some(d => d.startsWith(NIGHT_TERRAIN_DEFINE))).toBe(false)
  })
})
