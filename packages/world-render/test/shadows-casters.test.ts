/**
 * RND-L's shadow casters (docs/RENDER.md §4.3–4.4, docs/WAVE_PLAN3.md §5.1, §6.12): the CSM per preset; the render
 * list around the camera (proxies within shadowMaxZ + their radius, cut-outs and foliage only within 60 m and only on
 * High+, skinned clones taller than 1 m within 40 m, the terrain on High+, the characters' shown parts within 50 m); no
 * caster beyond shadowMaxZ + radius; the list is rebuilt after 8 m of camera movement or a change, and every 500 ms
 * while characters are registered, not every frame; the cascade filter (on by default since the W9A perf pass) keeps a
 * sphere that overlaps the cascade's light-space extents.
 */
import { DirectionalLight, Matrix, MeshBuilder, NullEngine, PBRMaterial, Scene, Vector3, type AbstractMesh, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import type { PlacedModelInfo, RegionData, RegionListener } from '../src/index.ts'
import { RENDER_PRESETS } from '../src/render/quality.ts'
import {
  CASTER_REFRESH_M,
  CHARACTER_CASTER_M,
  CHARACTER_REFRESH_MS,
  WorldShadows,
  csmSettings,
  inCascade,
  selectCasters,
  type ShadowHost,
  type ShadowProxy,
} from '../src/render/shadows.ts'

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
const proxy = (s: Scene, region: number, at: [number, number, number], radius: number): ShadowProxy => {
  const mesh = box(s, `proxy${region}`, at, 1)
  return { region, owner: 1, mesh, center: Vector3.FromArray(at), radius, triangles: 12 }
}

describe('csmSettings (RENDER §4.3)', () => {
  it('Medium 1024 × 2 to 60 m, High 2048 × 3 to 150 m, Ultra 2048 × 4 to 250 m, with their lambda, blend and PCF', () => {
    expect(csmSettings(RENDER_PRESETS.medium.shadows!)).toEqual({ mapSize: 1024, cascades: 2, maxZ: 60, lambda: 0.7, blend: 0.1, filter: 'low', soft: 0 })
    expect(csmSettings(RENDER_PRESETS.high.shadows!)).toEqual({ mapSize: 2048, cascades: 3, maxZ: 150, lambda: 0.8, blend: 0.08, filter: 'medium', soft: 0 })
    expect(csmSettings(RENDER_PRESETS.ultra.shadows!)).toEqual({ mapSize: 2048, cascades: 4, maxZ: 250, lambda: 0.85, blend: 0.05, filter: 'high', soft: 0 })
  })
})

describe('selectCasters', () => {
  const cam = new Vector3(0, 10, 0)

  it('takes the proxies within shadowMaxZ + radius, never one beyond', () => {
    const s = scene()
    const q = RENDER_PRESETS.high.shadows! // 150 m
    const near = proxy(s, 1, [100, 0, 0], 60)
    const edge = proxy(s, 2, [200, 0, 0], 60) // 190 m to the centre − 60 = 130 < 150
    const far = proxy(s, 3, [300, 0, 0], 60) // 240 − 60 = 180 > 150
    const list = selectCasters(cam, q, { proxies: [near, edge, far], cutouts: [], clones: [], terrain: [], characters: [] })
    expect(list).toEqual([near.mesh, edge.mesh])
    for (const m of list) {
      const p = [near, edge, far].find(x => x.mesh === m)!
      expect(Vector3.Distance(cam, p.center) - p.radius).toBeLessThan(q.distanceM)
    }
  })

  it('cut-outs and foliage only within 60 m and only where foliage casts (High+, not Medium)', () => {
    const s = scene()
    const close = box(s, 'tree30', [30, 0, 0])
    const mid = box(s, 'tree80', [80, 0, 0])
    const inputs = { proxies: [], cutouts: [close, mid], clones: [], terrain: [], characters: [] }
    expect(selectCasters(cam, RENDER_PRESETS.high.shadows!, inputs)).toEqual([close])
    expect(selectCasters(cam, RENDER_PRESETS.medium.shadows!, inputs)).toEqual([])
  })

  it('skinned clones within 40 m (foliage clones only where foliage casts), terrain on High+, and the characters', () => {
    const s = scene()
    const mill = box(s, 'mill', [20, 0, 0])
    const farMill = box(s, 'farMill', [60, 0, 0])
    const willow = box(s, 'willow', [25, 0, 0])
    const ground = box(s, 'terrain', [0, 0, 0], 192)
    const farGround = box(s, 'terrainFar', [900, 0, 0], 192)
    // A character with an equipment child: both cast.
    const hero = box(s, 'hero', [1, 0, 0])
    const sword = box(s, 'sword', [1, 1, 0])
    sword.parent = hero
    const inputs = {
      proxies: [],
      cutouts: [],
      clones: [{ foliage: false, meshes: [mill, farMill] }, { foliage: true, meshes: [willow] }],
      terrain: [ground, farGround],
      characters: [hero, box(s, 'rider', [3, 0, 0])],
    }
    expect(selectCasters(cam, RENDER_PRESETS.high.shadows!, inputs).map(m => m.name)).toEqual(['mill', 'willow', 'terrain', 'hero', 'sword', 'rider'])
    expect(selectCasters(cam, RENDER_PRESETS.medium.shadows!, inputs).map(m => m.name)).toEqual(['mill', 'hero', 'sword', 'rider'])
  })
})

describe('WorldShadows', () => {
  /** A host with no regions: the listener and commit step are recorded, the terrain is one mesh. */
  function host(s: Scene) {
    const listeners: RegionListener[] = []
    const steps: string[] = []
    const terrain = [box(s, 'terrain', [0, 0, 0], 192)]
    const h: ShadowHost = {
      objects: { addRegionListener: l => (listeners.push(l), () => listeners.splice(listeners.indexOf(l), 1)) },
      terrain: { meshes: terrain },
      regions: { regions: [] as RegionData[] },
      addCommitStep: name => (steps.push(name), () => steps.splice(steps.indexOf(name), 1)),
    }
    return { h, listeners, steps, terrain }
  }

  it('registers its listener and commit step, rebuilds the list after 8 m or a change, and cleans up on dispose', () => {
    const s = scene()
    const { h, listeners, steps, terrain } = host(s)
    const light = new DirectionalLight('celestial', new Vector3(0, -1, 0), s)
    const sh = new WorldShadows(s, light, h, { quality: RENDER_PRESETS.high })
    expect(listeners).toHaveLength(1)
    expect(steps).toEqual(['shadowProxy'])
    // A static tree batch through the listener (as WorldObjects reports it).
    const tree = box(s, 'tree', [20, 0, 0])
    tree.material = new PBRMaterial('leaf', s)
    const info: PlacedModelInfo = { index: 3, source: 'tre_maple01.bsr', heightM: 8, isFoliage: true, kind: 'static' }
    listeners[0]!.placed(4, {} as WorldModel, info, [tree], [{ region: 1, group: 2 } as WorldPlacement])
    expect(tree.receiveShadows).toBe(true)
    const cam = { globalPosition: new Vector3(0, 10, 0) } as never
    sh.update(cam)
    expect(sh.casters.map(m => m.name)).toEqual(['tree', 'terrain'])
    expect(terrain[0]!.receiveShadows).toBe(true)
    // Moving 5 m keeps the list (a tree moved out of range meanwhile is still in it); 9 m selects again.
    const first = sh.casters
    tree.position.x = 200
    tree.computeWorldMatrix(true)
    ;(cam as { globalPosition: Vector3 }).globalPosition.x = 5
    sh.update(cam)
    expect(sh.casters).toBe(first)
    ;(cam as { globalPosition: Vector3 }).globalPosition.x = 5 + CASTER_REFRESH_M + 1
    sh.update(cam)
    expect(sh.casters.map(m => m.name)).toEqual(['terrain'])
    // A character is a change: rebuilt at once, and it receives.
    const hero = box(s, 'hero', [0, 0, 0])
    sh.addCharacter(hero)
    expect(hero.receiveShadows).toBe(true)
    sh.update(cam)
    expect(sh.casters.map(m => m.name)).toContain('hero')
    sh.removeCharacter(hero)
    sh.update(cam)
    expect(sh.casters.map(m => m.name)).not.toContain('hero')
    // Medium: no foliage casters (and no terrain).
    sh.setQuality(RENDER_PRESETS.medium)
    sh.update(cam)
    expect(sh.casters).toEqual([])
    sh.dispose()
    expect(listeners).toHaveLength(0)
    expect(steps).toHaveLength(0)
  })

  /**
   * The NullEngine cannot build a CascadedShadowGenerator: a stand-in with one shadow map and `n` cascades, cascade k
   * seeing light-space x in [k·20 − 10, k·20 + 10] (identity view, so light space is world space).
   */
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
        getCascadeMinExtents: (k: number) => new Vector3(k * 20 - 10, -1000, -1000),
        getCascadeMaxExtents: (k: number) => new Vector3(k * 20 + 10, 1000, 1000),
        dispose: () => {},
      } as never,
    }
  }

  it('characters cast within 50 m (never past the shadow distance), only their shown parts, refreshed every 500 ms', () => {
    const s = scene()
    const { h } = host(s)
    const light = new DirectionalLight('celestial', new Vector3(0, -1, 0), s)
    let now = 0
    const sh = new WorldShadows(s, light, h, { quality: RENDER_PRESETS.high, now: () => now })
    const { map, generator } = fakeGenerator(3)
    sh.generator = generator
    const cam = { globalPosition: new Vector3(0, 10, 0) } as never
    const hero = box(s, 'hero', [5, 0, 0])
    const body = box(s, 'body', [5, 0, 0])
    body.parent = hero
    const armour = box(s, 'armour', [5, 0, 0])
    armour.parent = hero
    body.setEnabled(false) // the armour replaces it
    const mob = box(s, 'mob', [45, 0, 0])
    sh.addCharacter(hero)
    sh.addCharacter(mob)
    sh.update(cam)
    const names = () => sh.casters.map(m => m.name).filter(n => n !== 'terrain')
    expect(names()).toEqual(['hero', 'armour', 'mob'])
    expect(map.renderList).toEqual(sh.casters)
    expect(CHARACTER_CASTER_M).toBe(50)
    // The mob walks to 60 m: gone at the next periodic refresh, not before; the camera never moved.
    mob.position.x = 60
    mob.computeWorldMatrix(true)
    now = CHARACTER_REFRESH_MS - 1
    sh.update(cam)
    expect(names()).toContain('mob')
    now = CHARACTER_REFRESH_MS
    sh.update(cam)
    expect(names()).toEqual(['hero', 'armour'])
    // The body part is shown again (the armour taken off): back at the next refresh.
    body.setEnabled(true)
    armour.setEnabled(false)
    now += CHARACTER_REFRESH_MS
    sh.update(cam)
    expect(names()).toEqual(['hero', 'body'])
    // An unchanged refresh keeps the list and the shadow map's list.
    const list = sh.casters
    const mapList = map.renderList
    now += CHARACTER_REFRESH_MS
    sh.update(cam)
    expect(sh.casters).toBe(list)
    expect(map.renderList).toBe(mapList)
    // Medium (60 m) keeps the 50 m rule; the LAB A/B lifts it.
    const all = [
      ...selectCasters(new Vector3(0, 10, 0), RENDER_PRESETS.medium.shadows!, { proxies: [], cutouts: [], clones: [], terrain: [], characters: [mob] }),
      ...selectCasters(new Vector3(0, 10, 0), RENDER_PRESETS.high.shadows!, { proxies: [], cutouts: [], clones: [], terrain: [], characters: [mob], characterM: Infinity }),
    ]
    expect(all.map(m => m.name)).toEqual(['mob'])
    sh.generator = null
    sh.dispose()
  })

  it('culls casters per cascade by default (each cascade gets the casters in its extents); the LAB A/B switches it off', () => {
    const s = scene()
    const { h } = host(s)
    const light = new DirectionalLight('celestial', new Vector3(0, -1, 0), s)
    const sh = new WorldShadows(s, light, h, { quality: RENDER_PRESETS.high })
    expect(sh.cascadeCulling).toBe(true)
    const { map, generator } = fakeGenerator(3)
    sh.generator = generator
    sh.setCascadeCulling(true)
    const a = box(s, 'a', [0, 0, 0])
    const b = box(s, 'b', [20, 0, 0])
    const c = box(s, 'c', [29, 0, 0], 4) // radius √12 ≈ 3.5: reaches into cascade 2 (x ≥ 30)
    const list = [a, b, c]
    const layer = (k: number) => map.getCustomRenderList!(k, list, list.length)!.map(m => m.name)
    expect(layer(0)).toEqual(['a'])
    expect(layer(1)).toEqual(['b', 'c'])
    expect(layer(2)).toEqual(['c'])
    expect(map.getCustomRenderList!(3, list, list.length)).toBeNull() // not a cascade: Babylon's own list
    sh.setCascadeCulling(false)
    expect(map.getCustomRenderList).toBeNull()
    sh.generator = null
    sh.dispose()
  })

  it('the cascade filter keeps a caster whose sphere overlaps the cascade extents in x and y', () => {
    const min = new Vector3(-10, -10, -100)
    const max = new Vector3(10, 10, 100)
    expect(inCascade(new Vector3(0, 0, 500), 1, min, max)).toBe(true) // any depth (depth clamp)
    expect(inCascade(new Vector3(12, 0, 0), 3, min, max)).toBe(true)
    expect(inCascade(new Vector3(14, 0, 0), 3, min, max)).toBe(false)
    expect(inCascade(new Vector3(0, -14, 0), 3, min, max)).toBe(false)
  })
})
