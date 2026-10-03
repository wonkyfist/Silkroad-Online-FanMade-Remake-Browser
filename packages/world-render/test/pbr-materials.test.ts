/**
 * ObjectMaterials' PBR branch (materials.ts `toPbr`; docs/RENDER.md §3.1–3.4, docs/WAVE_PLAN3.md §6.10, D35, D40,
 * D41): the Classic path still builds StandardMaterials; the PBR path builds PBRMaterials with the surface plugin and
 * the class numbers, keeps the object lightmap as baked visibility, leaves BMT 0x8 materials unlit, applies an
 * `sro-remaster` set keyed by the world glb and image (disposing the replaced retail texture), and gives the map
 * textures back on release. A missing index is silent. The part joins WorldRender only on the PBR path. NullEngine,
 * in-memory asset IO.
 */
import { AssetContainer, NullEngine, PBRMaterial, RawTexture, Scene, StandardMaterial, type BaseTexture } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Assets,
  ObjectMaterials,
  SRO_SURFACE_PLUGIN,
  loadWorld,
  surfacePluginOf,
  type MaterialDecoratorInfo,
  type SidecarLite,
  type WorldIO,
} from '../src/index.ts'
import { ROOT_URL, WORLD_NAME, makeFixture } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

const ROOT = 'http://mem.test/out/'
const ROOF = 'prim\\mtrl\\bldg\\china\\jangan03\\cj_pal_roof.ddj'
const WALL = 'prim\\mtrl\\bldg\\china\\jangan_enter\\cj_wall01.ddj'

function setup(files: Record<string, unknown> = {}) {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  const fetched: string[] = []
  const io: WorldIO = {
    async bytes(url) {
      fetched.push(url)
      if (url.endsWith('.png')) return new Uint8Array([137, 80, 78, 71]) as Uint8Array<ArrayBuffer>
      if (!(url in files)) throw new Error(`404 ${url}`)
      return new TextEncoder().encode(JSON.stringify(files[url])) as Uint8Array<ArrayBuffer>
    },
    decodeImage: async () => ({ width: 1, height: 1, data: new Uint8Array(4) as Uint8Array<ArrayBuffer> }),
  }
  const mats = new ObjectMaterials(scene, new Assets(`${ROOT}world/w/`, io))
  return { scene, mats, fetched }
}

/** A glTF-like source material with a retail texture whose image name is `image`. */
function source(scene: Scene, name: string, image: string, lightmap?: string): { mat: PBRMaterial; tex: BaseTexture } {
  const mat = new PBRMaterial(name, scene)
  const tex = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
  tex.getInternalTexture()!.label = image
  mat.albedoTexture = tex
  if (lightmap) mat.metadata = { gltf: { extras: { sroLightmap: { path: lightmap, uri: lightmap, texCoord: 1 } } } }
  return { mat, tex }
}

function sidecar(...m: Array<[string, string, number?]>): SidecarLite {
  return { materials: m.map(([name, texture, flags]) => ({ name, flags: flags ?? 0, diffuse: [0.6, 0.6, 0.6, 1], ambient: [0.6, 0.6, 0.6, 1], texture })) }
}

describe('ObjectMaterials: the Classic path is unchanged', () => {
  it('builds StandardMaterials and fetches no map index', async () => {
    const { scene, mats, fetched } = setup()
    const c = new AssetContainer(scene)
    c.materials.push(source(scene, 'roof', 'cj_pal_roof').mat)
    const out = await mats.convert(c, sidecar(['roof', ROOF]), false)
    expect(out.materials[0]).toBeInstanceOf(StandardMaterial)
    expect(fetched).toEqual([])
  })
})

describe('ObjectMaterials: the PBR path', () => {
  it('builds PBRMaterials with the surface plugin, class numbers, baked lightmap and unlit glows', async () => {
    const { scene, mats, fetched } = setup()
    mats.mode = 'pbr'
    mats.setLightmapMode(2)
    const error = vi.spyOn(console, 'error')
    const seen: Array<[string, MaterialDecoratorInfo]> = []
    mats.addDecorator((m, info) => {
      expect(m).toBeInstanceOf(PBRMaterial)
      seen.push([m.name, info])
    })
    const c = new AssetContainer(scene)
    const roof = source(scene, 'roof', 'cj_pal_roof', 'lm/roof.png')
    const lamp = source(scene, 'lamp', 'cj_lamp')
    c.materials.push(roof.mat, lamp.mat)
    const out = await mats.convert(c, sidecar(['roof', ROOF], ['lamp', 'prim\\mtrl\\lamp.ddj', 0x8]), true, {
      model: 'models/roof.glb', source: 'res\\bldg\\china\\jangan03\\roof.bsr', kind: 'static',
    })
    const [pRoof, pLamp] = out.materials as PBRMaterial[]
    expect(pRoof).toBeInstanceOf(PBRMaterial)
    expect([pRoof!.metallic, pRoof!.roughness]).toEqual([0, 0.55]) // roof_tile
    expect(pRoof!.albedoTexture).toBe(roof.tex)
    expect(roof.tex.level).toBe(1)
    const plugin = surfacePluginOf(pRoof!)!
    expect(plugin.getClassName()).toBe(SRO_SURFACE_PLUGIN)
    expect([plugin.cls, plugin.baked, plugin.roughnessMap]).toEqual(['roof_tile', true, false])
    expect(pRoof!.lightmapTexture).not.toBeNull()
    expect(pRoof!.useLightmapAsShadowmap).toBe(true)
    expect(pRoof!.lightmapTexture!.level).toBe(1) // the 2x mode is a Classic combine only
    expect(pLamp!.unlit).toBe(true)
    expect(surfacePluginOf(pLamp!)).toBeNull()
    expect(seen.map(s => s[0])).toEqual(['roof', 'lamp'])
    // The map sets were looked up once under the asset root; absent = no sets, silently (D40).
    expect(fetched.filter(u => u.endsWith('.json')).sort()).toEqual([`${ROOT}pbr/index.json`, `${ROOT}remaster/manifest.json`])
    expect(error).not.toHaveBeenCalled()
    mats.release(out)
    expect(mats.materials).toHaveLength(0)
    expect(mats.pbr.shared.plugins.size).toBe(0)
  })

  it('applies an sro-remaster set keyed by the world glb and image, disposes the replaced retail texture, and releases the maps', async () => {
    const { scene, mats } = setup({
      [`${ROOT}remaster/manifest.json`]: {
        format: 'sro-remaster', version: 1,
        textures: { 'world/w/models/wall#cj_wall01': { albedo: 'wall/albedo.png', metallicRoughness: 'wall/mr.png', class: 'stone', delit: true } },
      },
    })
    mats.mode = 'pbr'
    const c = new AssetContainer(scene)
    const wall = source(scene, 'wall', 'cj_wall01')
    const door = source(scene, 'door', 'cj_door')
    c.materials.push(wall.mat, door.mat)
    c.textures.push(wall.tex, door.tex)
    const disposed = vi.spyOn(wall.tex, 'dispose')
    const out = await mats.convert(c, sidecar(['wall', WALL], ['door', 'prim\\mtrl\\bldg\\china\\jangan_enter\\cj_door.ddj']), false, {
      model: 'models/wall.glb', source: 'res\\bldg\\wall.bsr', kind: 'static',
    })
    const [pWall, pDoor] = out.materials as PBRMaterial[]
    // TX-R progressive swap: the retail texture draws until the set's maps are uploaded, then it is freed (D41).
    await vi.waitFor(() => expect(pWall!.albedoTexture!.name).toBe(`${ROOT}remaster/wall/albedo.png`))
    expect(pWall!.metallicTexture!.name).toBe(`${ROOT}remaster/wall/mr.png`)
    expect(pWall!.directIntensity).toBe(1) // de-lit set
    expect(surfacePluginOf(pWall!)!.roughnessMap).toBe(true)
    expect(disposed).toHaveBeenCalled() // D41
    expect(c.textures).not.toContain(wall.tex)
    expect(pDoor!.albedoTexture).toBe(door.tex) // no set: the retail texture and class defaults (wood)
    expect(pDoor!.roughness).toBe(0.7)
    expect(mats.pbr.cache.size).toBe(2)
    mats.release(out)
    expect(mats.pbr.cache.size).toBe(0)
  })
})

describe('World wiring', () => {
  it('the part is a render part on the PBR path only, and follows setRenderMode', async () => {
    const fx = makeFixture()
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    const load = (render: 'classic' | 'pbr') => loadWorld(scene, { baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false, stream: false, quality: 'medium', render })
    const pbr = await load('pbr')
    const classic = await load('classic')
    cleanups.push(() => {
      pbr.dispose()
      classic.dispose()
      scene.dispose()
      engine.dispose()
    })
    expect(pbr.render.materials).toBe(pbr.materials.pbr)
    expect(classic.render.materials).toBeNull()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    classic.setRenderMode('pbr')
    expect(classic.render.materials).toBe(classic.materials.pbr)
    classic.setRenderMode('classic')
    expect(classic.render.materials).toBeNull()
    expect(warn).toHaveBeenCalled() // a whole-world load keeps its materials until reloaded
  })
})
