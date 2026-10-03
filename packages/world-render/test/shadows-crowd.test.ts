/**
 * G1 rescue: the renderer side of the crowd budget (apps/game world/crowd-budget.ts).
 * - WorldShadows.setCharacterCascades: a character root at 0 casts nothing; one limited to k ≥ 1 is listed and left out
 *   of cascade k and up (its parts too); Infinity is today's; the same value changes nothing; a root that goes forgets
 *   its count. Without cascade culling, a filter exists only while something is limited. WorldRender keeps the counts
 *   for a shadow part built later.
 * - CharacterBlobs: one thin-instanced draw for every blob, hidden with none, a warm-up hook that compiles it and goes
 *   with it.
 */
import { DirectionalLight, Matrix, MeshBuilder, NullEngine, Scene, Vector3, type AbstractMesh, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { RegionData, RegionListener } from '../src/index.ts'
import { CHARACTER_BLOB_CAP, CharacterBlobs } from '../src/render/character-blobs.ts'
import { RENDER_PRESETS } from '../src/render/quality.ts'
import { WorldShadows, selectCasters, type ShadowHost } from '../src/render/shadows.ts'
import { warmupHooksState } from '../src/warmup-hooks.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function scene(): Scene {
  const engine = new NullEngine()
  const s = new Scene(engine)
  s.useRightHandedSystem = true
  cleanups.push(() => {
    s.dispose()
    engine.dispose()
  })
  return s
}

const box = (s: Scene, name: string, at: [number, number, number], size = 1): Mesh => {
  const m = MeshBuilder.CreateBox(name, { size }, s)
  m.position.set(...at)
  m.computeWorldMatrix(true)
  return m
}

function host(s: Scene): ShadowHost {
  const listeners: RegionListener[] = []
  return {
    objects: { addRegionListener: l => (listeners.push(l), () => listeners.splice(listeners.indexOf(l), 1)) },
    terrain: { meshes: [] },
    regions: { regions: [] as RegionData[] },
    addCommitStep: () => () => {},
  }
}

/** A stand-in generator (the NullEngine cannot build a CSM): n cascades, each seeing everything. */
function fakeGenerator(n: number) {
  const map: { renderList: AbstractMesh[] | null; getCustomRenderList: ((layer: number, list: AbstractMesh[], count: number) => AbstractMesh[] | null) | null } = {
    renderList: null,
    getCustomRenderList: null,
  }
  return {
    map,
    generator: {
      numCascades: n,
      getShadowMap: () => map,
      getCascadeViewMatrix: () => Matrix.Identity(),
      getCascadeMinExtents: () => new Vector3(-1000, -1000, -1000),
      getCascadeMaxExtents: () => new Vector3(1000, 1000, 1000),
      dispose: () => {},
    } as never,
  }
}

describe('selectCasters with cascade counts', () => {
  it('skips a root at 0, lists a limited one (with its parts) in `limited`, leaves the rest alone', () => {
    const s = scene()
    const cam = new Vector3(0, 10, 0)
    const a = box(s, 'a', [2, 0, 0])
    const aSword = box(s, 'aSword', [2, 1, 0])
    aSword.parent = a
    const b = box(s, 'b', [4, 0, 0])
    const c = box(s, 'c', [6, 0, 0])
    const counts = new Map<AbstractMesh, number>([
      [b, 0],
      [c, 1],
    ])
    const limited = new Map<AbstractMesh, number>()
    const list = selectCasters(cam, RENDER_PRESETS.high.shadows!, { proxies: [], cutouts: [], clones: [], terrain: [], characters: [a, b, c], characterCascades: counts, limited })
    expect(list.map(m => m.name)).toEqual(['a', 'aSword', 'c'])
    expect([...limited.entries()].map(([m, k]) => [m.name, k])).toEqual([['c', 1]])
    // A count at or above the shadow's cascades is no limit.
    counts.set(c, 3)
    limited.clear()
    selectCasters(cam, RENDER_PRESETS.high.shadows!, { proxies: [], cutouts: [], clones: [], terrain: [], characters: [c], characterCascades: counts, limited })
    expect(limited.size).toBe(0)
  })
})

describe('WorldShadows.setCharacterCascades', () => {
  it('limits a character to its first cascades through the cascade filter; 0 drops it; Infinity is today', () => {
    const s = scene()
    const light = new DirectionalLight('celestial', new Vector3(0, -1, 0), s)
    const sh = new WorldShadows(s, light, host(s), { quality: RENDER_PRESETS.high })
    const { map, generator } = fakeGenerator(3)
    sh.generator = generator
    sh.setCascadeCulling(true)
    const cam = { globalPosition: new Vector3(0, 10, 0) } as never
    const near = box(s, 'near', [2, 0, 0])
    const far = box(s, 'far', [5, 0, 0])
    const farCape = box(s, 'farCape', [5, 1, 0])
    farCape.parent = far
    const gone = box(s, 'gone', [8, 0, 0])
    for (const m of [near, far, gone]) sh.addCharacter(m)
    sh.update(cam)
    const layer = (k: number) => (map.getCustomRenderList!(k, map.renderList!, map.renderList!.length) ?? map.renderList!).map(m => m.name)
    expect(layer(2)).toEqual(['near', 'far', 'farCape', 'gone'])
    sh.setCharacterCascades(far, 1)
    sh.setCharacterCascades(gone, 0)
    expect(sh.characterCascadesOf(far)).toBe(1)
    sh.update(cam) // a change: rebuilt at once
    expect(sh.casters.map(m => m.name)).toEqual(['near', 'far', 'farCape'])
    expect(layer(0)).toEqual(['near', 'far', 'farCape'])
    expect(layer(1)).toEqual(['near'])
    expect(layer(2)).toEqual(['near'])
    // Back to every cascade.
    sh.setCharacterCascades(far, Infinity)
    sh.setCharacterCascades(gone, Infinity)
    sh.update(cam)
    expect(layer(2)).toEqual(['near', 'far', 'farCape', 'gone'])
    // The same value is no change (no rebuild); a removed root forgets its count.
    const list = sh.casters
    sh.setCharacterCascades(far, Infinity)
    sh.update(cam)
    expect(sh.casters).toBe(list)
    sh.setCharacterCascades(near, 0)
    sh.removeCharacter(near)
    expect(sh.characterCascadesOf(near)).toBe(Infinity)
    sh.generator = null
    sh.dispose()
  })

  it('without cascade culling (the LAB A/B) a filter exists only while a character is limited', () => {
    const s = scene()
    const light = new DirectionalLight('celestial', new Vector3(0, -1, 0), s)
    const sh = new WorldShadows(s, light, host(s), { quality: RENDER_PRESETS.ultra })
    const { map, generator } = fakeGenerator(4)
    sh.generator = generator
    sh.setCascadeCulling(false)
    expect(map.getCustomRenderList).toBeNull()
    const cam = { globalPosition: new Vector3(0, 10, 0) } as never
    const a = box(s, 'a', [2, 0, 0])
    const b = box(s, 'b', [3, 0, 0])
    sh.addCharacter(a)
    sh.addCharacter(b)
    sh.setCharacterCascades(b, 1)
    sh.update(cam)
    expect(map.getCustomRenderList).not.toBeNull()
    expect(map.getCustomRenderList!(0, map.renderList!, map.renderList!.length)!.map(m => m.name)).toEqual(['a', 'b'])
    expect(map.getCustomRenderList!(3, map.renderList!, map.renderList!.length)!.map(m => m.name)).toEqual(['a'])
    sh.setCharacterCascades(b, Infinity)
    sh.update(cam)
    expect(map.getCustomRenderList).toBeNull()
    sh.generator = null
    sh.dispose()
  })
})

describe('CharacterBlobs', () => {
  it('draws every blob in one thin-instanced mesh, hides with none, and its warm-up hook goes with it', () => {
    const s = scene()
    const blobs = new CharacterBlobs(s)
    expect(blobs.cap).toBe(CHARACTER_BLOB_CAP)
    expect(blobs.mesh.isVisible).toBe(false)
    expect(warmupHooksState(s)).not.toBe('loading')
    blobs.begin()
    blobs.add(1, 0, 2, 0.6)
    blobs.add(5, 1, 2, 0.5)
    blobs.add(9, 0, 2, 0) // no radius: no blob
    blobs.end()
    expect(blobs.count).toBe(2)
    expect(blobs.mesh.thinInstanceCount).toBe(2)
    expect(blobs.mesh.isVisible).toBe(true)
    expect(blobs.mesh.material!.needAlphaBlending()).toBe(true)
    // Sized and placed: a 1.2 m disc over (1, 0, 2).
    const m = blobs.mesh.thinInstanceGetWorldMatrices()[0]!
    expect(m.m[0]).toBeCloseTo(1.2, 6)
    expect(m.m[12]).toBe(1)
    expect(m.m[14]).toBe(2)
    blobs.begin()
    blobs.end()
    expect(blobs.mesh.isVisible).toBe(false)
    expect(blobs.mesh.thinInstanceCount).toBe(0)
    blobs.dispose()
    expect(blobs.mesh.isDisposed()).toBe(true)
    expect(warmupHooksState(s)).toBe('ready')
  })
})
