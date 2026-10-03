/**
 * W9 finish, adversarial hunt, lens "recompile": weather changes, day and night, the rain start, lightning and the
 * texture swaps must never change a define or compile a shader in play; only Options may (and the PERF2 warm-up behind
 * the loading picture, screens/warmup.ts, is meant to cover what a switch compiles).
 *
 * Headless: a NullEngine World (world-render's synthetic fixture) warmed up by the game's own GraphicsWarmup, then the
 * weather or the textures change and every effect the engine compiles afterwards is listed (AbstractEngine's effect
 * cache, `_compiledEffects`, keyed by shader name + defines). Each test states the rule and fails when it is broken.
 */
import { ArcRotateCamera, MeshBuilder, NullEngine, PBRMaterial, RawTexture, Scene, Vector3, type AbstractEngine, type Mesh } from '@babylonjs/core'
import {
  CLEAR_FRAME,
  PbrMapIndex,
  PbrTextureCache,
  SroSurfacePlugin,
  SurfaceShared,
  applyMapRecord,
  attachNightLights,
  isWeatherMesh,
  loadWorld,
  mapPolicy,
  parsePbrIndex,
  type MapTextureSource,
  type WeatherFrame,
  type WeatherLevel,
  type World,
} from '@sro/world-render'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { weatherParams, type WeatherKind } from '../../../packages/shared/src/weather.ts'
import { keyPath, type PbrSet } from '../../../packages/texpipe/src/format.ts'
import { ROOT_URL, WORLD_NAME, makeFixture } from '../../../packages/world-render/test/stream-fixture.ts'
import { GraphicsWarmup, warmupMeshes } from '../src/screens/warmup.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
  vi.restoreAllMocks()
})

/** The effects the engine has compiled so far (shader name + defines, Babylon's effect cache keys). */
const compiled = (engine: AbstractEngine) => new Set(Object.keys((engine as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects))
/** Effects compiled since `before`, as `shader [DEFINES]` lines (the defines shortened to their names). */
function newEffects(engine: AbstractEngine, before: ReadonlySet<string>): string[] {
  return [...compiled(engine)].filter(k => !before.has(k)).map(k => {
    const name = k.split('+')[0]!.replace(/\r?\n[\s\S]*$/, '')
    const defs = [...k.matchAll(/#define (\w+)/g)].map(m => m[1]).filter(d => d !== undefined)
    return `${name.slice(0, 60)} [${defs.join(' ').slice(0, 120)}]`
  }).sort()
}

function frame(kind: WeatherKind, flash = 0): WeatherFrame {
  const p = weatherParams(kind)
  return {
    cloud: p.cloud, cloudDark: p.cloudDark, cirrus: p.cirrus, rain: p.rain, fog: p.fog, sun: p.sun, desat: p.desat,
    windX: 0.8, windZ: -0.6, windMs: p.windMs, gustMs: p.windMs * 1.3, wet: p.rain, puddle: p.rain * 0.8,
    flash, flashX: 0.6, flashZ: 0.8, time: 100,
  }
}

const FOCUS = { x: 96, z: -96 }

/** A NullEngine world at weather `level` (Classic path at Medium by default; the rain, shelter and bolt are the same on every path). */
async function weatherWorld(level: WeatherLevel, path: 'classic' | 'pbr' = 'classic', quality: 'medium' | 'high' | 'ultra' = path === 'pbr' ? 'high' : 'medium'): Promise<{ engine: NullEngine; scene: Scene; world: World; camera: ArcRotateCamera; render: (n?: number) => void }> {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const camera = new ArcRotateCamera('cam', 0.3, 1.1, 12, new Vector3(FOCUS.x, 0, FOCUS.z), scene)
  scene.activeCamera = camera
  const fx = makeFixture()
  const world = await loadWorld(scene, {
    baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false, stream: false, quality, weatherLevel: level,
    ...(path === 'pbr' ? { render: 'pbr' as const, sky: 'modern' as const } : {}),
  })
  cleanups.push(() => {
    world.dispose()
    scene.dispose()
    engine.dispose()
  })
  const render = (n = 1) => {
    for (let i = 0; i < n; i++) {
      world.update(camera, FOCUS)
      scene.render()
    }
  }
  return { engine, scene, world, camera, render }
}

/** The game's warm-up (stream idle, shaders, a turn of the camera, settle), driven by rendered frames. */
async function warmUp(scene: Scene, engine: AbstractEngine, camera: ArcRotateCamera, render: (n?: number) => void): Promise<void> {
  let clock = 0
  let done = false
  const run = new GraphicsWarmup({ scene, engine, camera, stream: null }, { now: () => (clock += 16) })
  void run.run().then(() => (done = true))
  for (let i = 0; i < 400 && !done; i++) {
    render()
    await Promise.resolve()
  }
  expect(done).toBe(true)
}

describe('weather: the rain start and the first lightning compile nothing in play (only Options may)', () => {
  it('entry in clear weather at Medium: the warm-up never asks the rain, curtain, splash, drip or shelter-map shaders', async () => {
    const { engine, scene, world, camera, render } = await weatherWorld('medium')
    world.setWeather(CLEAR_FRAME)
    render(3)
    // What the warm-up asks: the weather meshes exist (built with the level, D21) but are disabled while dry.
    const weatherMeshes = scene.meshes.filter(isWeatherMesh)
    expect(weatherMeshes.length).toBeGreaterThan(0)
    const asked = new Set(warmupMeshes(scene))
    const skipped = weatherMeshes.filter(m => !asked.has(m)).map(m => m.name).sort()
    await warmUp(scene, engine, camera, render)
    const afterWarmup = compiled(engine)
    // Play: a clear sky clouds over and it starts to rain (a server `weather` message; no Options change).
    world.setWeather(frame('rain'))
    render(5)
    const inPlay = newEffects(engine, afterWarmup)
    expect({ skippedByWarmup: skipped, compiledInPlayOnRainStart: inPlay }).toEqual({ skippedByWarmup: [], compiledInPlayOnRainStart: [] })
  })

  it('High: the first lightning bolt of a storm compiles its shader in play', async () => {
    const { engine, scene, world, camera, render } = await weatherWorld('high')
    // Entered while it already rained: the rain shaders are warmed up, the bolt is not (it is only on during a strike).
    world.setWeather(frame('storm'))
    render(3)
    await warmUp(scene, engine, camera, render)
    render(3)
    const beforeStrike = compiled(engine)
    world.setWeather(frame('storm', 1.2))
    render(2)
    expect(world.weather.rain?.bolt?.isEnabled()).toBe(true)
    expect(newEffects(engine, beforeStrike)).toEqual([])
  })
})

describe('what held: weather kinds, day and night, flashes after the rain effects exist compile nothing', () => {
  for (const path of ['classic', 'pbr'] as const) {
    it(`${path} path: clear, overcast, fog, storm, a strike, noon, dusk, midnight and dawn after a warm-up in a storm`, async () => {
      const { engine, scene, world, camera, render } = await weatherWorld('high', path)
      expect(world.render.mode).toBe(path)
      // The game's fx-world feature: the night lights (splat defines, the point-light pool or cluster), from the start.
      const night = attachNightLights(world, { focus: () => camera.target })
      cleanups.push(() => night.dispose())
      world.setTimeOfDay(0.5)
      world.setWeather(frame('storm'))
      render(3)
      await warmUp(scene, engine, camera, render)
      // The bolt's first strike (the finding above) out of the way.
      world.setWeather(frame('storm', 1.2))
      render(3)
      const settled = compiled(engine)
      const seen: string[] = []
      for (const t of [0.5, 0.27, 0.0, 0.2, 0.75, 0.5]) {
        world.setTimeOfDay(t)
        for (const k of ['clear', 'overcast', 'fog', 'rain', 'storm'] as const) {
          world.setWeather(frame(k))
          render(2)
          world.setWeather(frame(k, k === 'storm' ? 1.5 : 0))
          render(2)
          for (const e of newEffects(engine, settled)) if (!seen.some(x => x.endsWith(e))) seen.push(`t=${t} ${k}: ${e}`)
        }
      }
      expect(seen).toEqual([])
    })
  }
})

describe('Ultra: the cloud-shadow define of the objects follows an asset load, not Options', () => {
  it('SRO_CLOUDSHADOW flips on every surface material when the cloud noise of the sky lands after the warm-up', async () => {
    const { engine, scene, world, camera, render } = await weatherWorld('off', 'pbr', 'ultra')
    // A character on the PBR path (PbrSurfaces.decorateCharacterMaterial: the SroSurfacePlugin, as every object has).
    const mesh = MeshBuilder.CreateBox('npc', {}, scene)
    mesh.position.set(FOCUS.x, 1, FOCUS.z)
    const mat = new PBRMaterial('ch_smith_body', scene)
    mesh.material = mat
    world.materials.pbr.decorateCharacterMaterial(mat)
    // The sky's noise is still loading (SkySystem.loadAssets: sky.json, then cloud-noise.png, decoded).
    expect(world.sky.state.cloudNoise).toBeNull()
    render(3)
    await warmUp(scene, engine, camera, render)
    const sub = mesh.subMeshes[0]!
    const warmed = sub.materialDefines?.toString() ?? ''
    const before = compiled(engine)
    // In play: the decode finishes (what loadAssets does when it lands).
    ;(world.sky.state as { cloudNoise: unknown }).cloudNoise = rawTexture(scene, 'skyCloudNoise', false)
    render(3)
    expect(await readyFor(mesh)).toBe(true)
    const changed = diffDefines(warmed, sub.materialDefines!.toString())
    expect({ definesChangedByAssetLoad: changed, compiledInPlay: newEffects(engine, before) }).toEqual({ definesChangedByAssetLoad: [], compiledInPlay: [] })
  })
})

// ---- texture swaps ------------------------------------------------------------------------------------------------

const WALL = 'prim/mtrl/bldg/china/jangan_enter/cj_wall01.ddj'

function wallSet(): PbrSet {
  const p = keyPath(WALL)
  const tiers: PbrSet['tiers'] = {}
  for (const e of [256, 1024, 2048]) {
    tiers[String(e)] = {
      size: [e, e], albedo: `${p}/albedo@${e}.webp`, bytes: 100,
      nx: `${p}/nx@${e}.webp`, ny: `${p}/ny@${e}.webp`, ao: `${p}/ao@${e}.webp`, rough: `${p}/rough@${e}.webp`, height: `${p}/height@${e}.webp`,
    }
  }
  return { key: WALL, size: [2048, 2048], class: 'stone', tiers, alpha: 'none', wrap: [true, true], status: 'ok', hero: true }
}

/** A 1 x 1 texture the NullEngine reports ready (its uploads never run). */
function rawTexture(scene: Scene, name: string, srgb: boolean): RawTexture {
  const t = RawTexture.CreateRGBATexture(new Uint8Array([128, 128, 128, 255]), 1, 1, scene)
  t.name = name
  t.gammaSpace = srgb
  const internal = t.getInternalTexture()
  if (internal) internal.isReady = true
  return t
}

/** The map textures (decoded pixels land when `gate` resolves: the download and decode of a real set). */
function fakeSource(scene: Scene, gate: Promise<void>): MapTextureSource {
  return {
    texture(url, srgb) {
      return rawTexture(scene, url, srgb)
    },
    async pixels() {
      await gate
      return { width: 2, height: 2, data: new Uint8Array(16).fill(128) as Uint8Array<ArrayBuffer> }
    },
    raw(img) {
      return rawTexture(scene, `raw${img.width}`, false)
    },
  }
}

describe('texture swaps: a set landing after the warm-up must not change a define', () => {
  it('an object material that drew its retail texture keeps its define set when the map set swaps in', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    new ArcRotateCamera('cam', 0, 1, 10, Vector3.Zero(), scene)
    const mesh = MeshBuilder.CreateBox('wall', {}, scene)
    const mat = new PBRMaterial('cj_wall01', scene)
    mat.albedoTexture = rawTexture(scene, 'cj_wall01.dds', true)
    mesh.material = mat
    const idx = new PbrMapIndex({ pbr: parsePbrIndex({
      format: 'sro-pbr', version: 1, pipeline: { rev: 'test', upscaler: 'realesrgan-x4plus', createdAt: '2026-09-28T00:00:00Z' }, sets: { [WALL]: wallSet() },
    }, 'http://mem.test/out-opt/pbr/index.json')! })
    const rec = idx.resolve({ texture: WALL }, mapPolicy('high'))!
    expect(rec).toBeTruthy()
    // The region commits, the warm-up compiles the material with its retail texture (the progressive swap starts).
    let land = () => {}
    const gate = new Promise<void>(r => (land = r))
    // ObjectMaterials.toPbr: the swap starts, the surface plugin goes on, and the swap's onChange re-reads the roughness.
    let plugin: SroSurfacePlugin | null = null
    const applied = applyMapRecord(mat, rec, new PbrTextureCache(fakeSource(scene, gate)), 'stone', {
      onChange: () => {
        if (!plugin) return
        plugin.roughnessMap = applied.roughness
        plugin.refresh()
      },
    })
    plugin = new SroSurfacePlugin(mat, new SurfaceShared(), { cls: 'stone', roughnessMap: applied.roughness })
    const sub = mesh.subMeshes[0]!
    expect(await readyFor(mesh)).toBe(true)
    const warmed = sub.materialDefines!.toString()
    const before = compiled(engine)
    // The set's maps are not in yet (the material may hold neutral stand-ins for them, not the set's normal map).
    expect(applied.swapped).toBe(false)
    const standIn = mat.bumpTexture
    // Later, in play (GraphicsWarmup has no stage that waits for the sets), the maps are in: bound in one go.
    land()
    expect(await applied.ready).toBe(true)
    expect(mat.bumpTexture).not.toBeNull()
    expect(mat.bumpTexture).not.toBe(standIn)
    expect(await readyFor(mesh)).toBe(true)
    const changed = diffDefines(warmed, sub.materialDefines!.toString())
    expect({ definesChangedBySwap: changed, compiledInPlay: newEffects(engine, before) }).toEqual({ definesChangedBySwap: [], compiledInPlay: [] })
  })
})

/** Prepares the defines and waits for the (NullEngine) effect, as the warm-up's isReady(true) does each frame. */
async function readyFor(mesh: Mesh): Promise<boolean> {
  const mat = mesh.material!
  for (let i = 0; i < 50; i++) {
    mesh.getScene().incrementRenderId()
    if (mat.isReadyForSubMesh(mesh, mesh.subMeshes[0]!)) return true
    await new Promise(r => setTimeout(r, 5))
  }
  return false
}

/** The `#define` names that differ between two define strings. */
function diffDefines(a: string, b: string): string[] {
  const set = (s: string) => new Set([...s.matchAll(/#define (\w+)(?: (\S+))?/g)].map(m => `${m[1]}${m[2] !== undefined ? `=${m[2]}` : ''}`))
  const x = set(a), y = set(b)
  return [...[...x].filter(d => !y.has(d)).map(d => `-${d}`), ...[...y].filter(d => !x.has(d)).map(d => `+${d}`)].sort()
}
