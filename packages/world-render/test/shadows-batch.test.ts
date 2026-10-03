/**
 * BT-S (docs/BATCHING.md §3.9, docs/WAVE_PLAN6.md §6.1): the shadows of a batched world.
 *
 * - The terrain skin (`terrainSkin`): every 4th vertex, each at the lowest height around it, so the skin stays under the
 *   ground; neighbouring regions' skins share their edge vertices exactly (no cracks).
 * - The proxy of a batched region: the merge worker's mesh as it is when nothing is to be added (Medium); on High one
 *   mesh with the worker's proxy and the terrain skin (one draw per region; the full-resolution terrain no longer
 *   casts); on Ultra the batch's opaque group-3 pieces join; a region without objects casts its skin and is pruned
 *   when it unloads.
 * - The cut-out casters: a table-mode cut-out group casts through a shadow-only mesh on SHADOW_PROXY_LAYER that shares
 *   its geometry, with the standalone CutoutCasterMaterial and its depth wrapper (one depth effect per shadow define
 *   set, shared by every caster); it follows the group's draw range; a material-mode cut-out casts as itself; a region
 *   casts one proxy plus one caster per table cut-out group; Medium (no foliage range) selects none.
 * - The depth shaders: the same samplers and uniforms in both languages, Babylon's shadow-map includes, the table
 *   fetch and the alpha test; the WGSL from Babylon's WGSL processor binds the arrays and writes the depth (no GLSL).
 */
import {
  DirectionalLight,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  RawTexture,
  Scene,
  ShaderLanguage,
  Vector3,
  VertexBuffer,
  type AbstractMesh,
  type Mesh,
} from '@babylonjs/core'
import { WebGPUShaderProcessingContext } from '@babylonjs/core/Engines/WebGPU/webgpuShaderProcessingContext.js'
import { WebGPUShaderProcessorWGSL } from '@babylonjs/core/Engines/WebGPU/webgpuShaderProcessorsWGSL.js'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import type { RegionBatch } from '../src/batch/types.ts'
import type { PlacedModelInfo, RegionData } from '../src/index.ts'
import { SroSurfacePlugin, SurfaceShared, TABLE_TEXEL, type SurfaceTable } from '../src/pbr/surface-plugin.ts'
import { RENDER_PRESETS } from '../src/render/quality.ts'
import {
  CASTER_CULL_KIND,
  CUTOUT_CASTER_SAMPLERS,
  CutoutCasterMaterial,
  SHADOW_PROXY_LAYER,
  SKIN_ONLY_OWNER,
  ShadowProxies,
  WorldShadows,
  cutoutCasterShaders,
  mergeCutoutCasters,
  selectCasters,
  terrainSkin,
} from '../src/render/shadows.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function scene(engine: NullEngine = new NullEngine()): Scene {
  const s = new Scene(engine)
  s.useRightHandedSystem = true
  cleanups.push(() => {
    s.dispose()
    engine.dispose()
  })
  return s
}

function readyTexture(s: Scene): RawTexture {
  const t = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, s)
  t.getInternalTexture()!.isReady = true
  t.isReady = () => true
  return t
}

const tableOf = (s: Scene): SurfaceTable => ({ albedo: readyTexture(s), nrao: readyTexture(s), lightmap: readyTexture(s), table: readyTexture(s) })

/** A table-mode group mesh (BT-M's groupMesh shape): world-space box with uv + packed uv2, a table group material. */
function tableGroup(s: Scene, table: SurfaceTable, name: string, opts: { cutout?: boolean; at?: [number, number, number] } = {}): Mesh {
  const mat = new PBRMaterial(`batch:group:${name}`, s)
  if (opts.cutout) mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
  new SroSurfacePlugin(mat, new SurfaceShared(), { cls: 'wood', table })
  const mesh = MeshBuilder.CreateBox(name, { size: 2 }, s)
  if (opts.at) mesh.position.set(...opts.at)
  mesh.bakeCurrentTransformIntoVertices()
  mesh.setVerticesData(VertexBuffer.UV2Kind, new Float32Array(mesh.getTotalVertices() * 2).fill(2.5), false, 2)
  mesh.material = mat
  mesh.freezeWorldMatrix()
  return mesh
}

/** A merged caster's vertex layout (a table group with the per-vertex range sphere) on the caster material. */
function casterMesh(s: Scene, table: SurfaceTable, name: string, mat: CutoutCasterMaterial): Mesh {
  const mesh = tableGroup(s, table, name, { cutout: true })
  mesh.setVerticesData(CASTER_CULL_KIND, new Float32Array(mesh.getTotalVertices() * 4).fill(-1), false, 4)
  mesh.material = mat
  return mesh
}

/** A worker proxy stand-in (positions only). */
function workerProxy(s: Scene, at: [number, number, number]): Mesh {
  const m = MeshBuilder.CreateBox('batchProxy', { size: 4 }, s)
  m.position.set(...at)
  m.bakeCurrentTransformIntoVertices()
  m.removeVerticesData(VertexBuffer.NormalKind)
  m.removeVerticesData(VertexBuffer.UVKind)
  m.layerMask = SHADOW_PROXY_LAYER
  return m
}

function batchOf(owner: number, region: number, meshes: AbstractMesh[], proxy: Mesh | null, cutouts: AbstractMesh[]): RegionBatch {
  return { owner, region, meshes, shadowProxy: proxy, cutoutCasters: cutouts, slots: [], min: Vector3.Zero(), max: Vector3.One(), setEmissive: () => {} }
}

const info: PlacedModelInfo = { index: 0, source: 'a.bsr', heightM: 3, isFoliage: false, kind: 'static' }
const placement = (region: number): WorldPlacement => ({ region, group: 2 } as WorldPlacement)
/** A region with a terrain grid of 97 × 97 heights from `h(gx, gz)`. */
function regionData(id: number, origin: [number, number, number], h: (gx: number, gz: number) => number = () => 0): RegionData {
  const heights = new Float32Array(97 * 97)
  for (let gz = 0; gz < 97; gz++) for (let gx = 0; gx < 97; gx++) heights[gz * 97 + gx] = h(gx, gz)
  return { region: { id, origin }, terrain: { heights } } as unknown as RegionData
}
const SKIN_TRIS = 24 * 24 * 2

describe('the terrain skin (BT-S, BATCHING §3.9)', () => {
  const rough = (gx: number, gz: number) => 20 * Math.sin(gx * 0.21) * Math.cos(gz * 0.17) + 3 * Math.sin(gx * 1.7 + gz * 2.3) + 0.05 * gx

  /** The skin's height at fine vertex (gx, gz) on its triangulation (cells of 4, split a-c-b / b-c-d). */
  function skinAt(pos: Float32Array, origin: number[], gx: number, gz: number): number {
    const n = 25
    const i = Math.min(23, Math.floor(gx / 4))
    const j = Math.min(23, Math.floor(gz / 4))
    const fx = gx / 4 - i
    const fz = gz / 4 - j
    const y = (a: number, b: number) => pos[(b * n + a) * 3 + 1]! - origin[1]!
    if (fx + fz <= 1) return y(i, j) + fx * (y(i + 1, j) - y(i, j)) + fz * (y(i, j + 1) - y(i, j))
    return y(i + 1, j + 1) + (1 - fx) * (y(i, j + 1) - y(i + 1, j + 1)) + (1 - fz) * (y(i + 1, j) - y(i + 1, j + 1))
  }

  it('keeps every 4th vertex (25 × 25, 1152 triangles) on the terrain mesh\'s grid, under the ground away from the corners', () => {
    const origin = [384, 10, -192]
    const heights = new Float32Array(97 * 97)
    for (let gz = 0; gz < 97; gz++) for (let gx = 0; gx < 97; gx++) heights[gz * 97 + gx] = rough(gx, gz)
    const { positions, indices } = terrainSkin(heights, origin)
    expect(positions.length / 3).toBe(625)
    expect(indices.length / 3).toBe(SKIN_TRIS)
    expect(Math.max(...indices)).toBe(624)
    // Vertex (i, j) sits over terrain vertex (4i, 4j): origin + (2·4i, h, −2·4j).
    expect([positions[(25 * 3 + 2) * 3], positions[(25 * 3 + 2) * 3 + 2]]).toEqual([384 + 16, -192 - 24])
    // Corners keep their exact height.
    expect(positions[1]).toBeCloseTo(10 + heights[0]!, 4)
    let worst = -Infinity
    for (let gz = 0; gz < 97; gz++) {
      for (let gx = 0; gx < 97; gx++) {
        const edge = gx === 0 || gx === 96 || gz === 0 || gz === 96
        // Interior cells are a true lower envelope; on an edge line, every segment but the two at the corners is.
        const interiorCell = gx >= 4 && gx <= 92 && gz >= 4 && gz <= 92
        const edgeLine = edge && (gx === 0 || gx === 96 ? gz >= 4 && gz <= 92 : gx >= 4 && gx <= 92)
        if (!interiorCell && !edgeLine) continue
        worst = Math.max(worst, skinAt(positions, origin, gx, gz) - heights[gz * 97 + gx]!)
      }
    }
    expect(worst).toBeLessThanOrEqual(1e-4)
  })

  it('two neighbouring regions make the same edge vertices (no crack between their skins)', () => {
    // One continuous ground over two regions side by side in x: B's column 0 is A's column 96.
    const a = terrainSkin(Float32Array.from({ length: 97 * 97 }, (_, k) => rough(k % 97, Math.floor(k / 97))), [0, 0, 0])
    const b = terrainSkin(Float32Array.from({ length: 97 * 97 }, (_, k) => rough(96 + (k % 97), Math.floor(k / 97))), [192, 0, 0])
    for (let j = 0; j < 25; j++) {
      const ea = (j * 25 + 24) * 3
      const eb = (j * 25) * 3
      expect([a.positions[ea], a.positions[ea + 1], a.positions[ea + 2]]).toEqual([b.positions[eb], b.positions[eb + 1], b.positions[eb + 2]])
    }
  })

  it('a malformed grid gives no skin', () => {
    expect(terrainSkin(new Float32Array(10), [0, 0, 0]).indices.length).toBe(0)
  })
})

describe('the proxy of a batched region (BT-S: worker proxy + skin)', () => {
  it('Medium: the worker\'s mesh casts as it is; High: one mesh with the worker proxy and the skin; Ultra adds group-3 pieces', () => {
    const s = scene()
    const r = regionData(5, [0, 0, 0])
    const px = new ShadowProxies(s, () => [r])
    cleanups.unshift(() => px.dispose())
    const proxy = workerProxy(s, [96, 2, -96])
    const g3 = MeshBuilder.CreateBox('batch:7:3:opaque', { size: 1 }, s)
    px.placed(7, {} as WorldModel, info, [], [placement(5)])
    px.batched(7, batchOf(7, 5, [g3], proxy, []))
    // Medium (no terrain, no props): nothing to add, no mesh of our own.
    expect(px.build(r)?.mesh).toBe(proxy)
    expect(px.proxies.size).toBe(0)
    expect([...px.allProxies()].map(p => p.mesh)).toEqual([proxy])
    // High: the skin joins the worker's proxy in one mesh; the worker's mesh stays (the batch's) but is not yielded.
    px.terrain = true
    const built = px.build(r)!
    expect(built.mesh).not.toBe(proxy)
    expect(built.triangles).toBe(12 + SKIN_TRIS)
    expect(built.batchOwner).toBe(7)
    expect(built.skin).toBe(true)
    expect(built.owner).toBe(7)
    expect(built.mesh.layerMask).toBe(SHADOW_PROXY_LAYER)
    expect([...px.allProxies()].map(p => p.mesh)).toEqual([built.mesh])
    expect(px.hasSkin(5)).toBe(true)
    // Ultra: the batch's opaque group-3 pieces join (the worker's proxy holds group 2 only).
    px.props = true
    const ultra = px.build(r)!
    expect(built.mesh.isDisposed()).toBe(true)
    expect(ultra.triangles).toBe(12 + 12 + SKIN_TRIS)
    // The region goes: our mesh is disposed, the worker's is not ours.
    px.removed(7)
    expect(ultra.mesh.isDisposed()).toBe(true)
    expect(proxy.isDisposed()).toBe(false)
    expect([...px.allProxies()]).toEqual([])
  })

  it('a region without objects casts its skin on High, and the proxy goes when the region unloads (prune)', () => {
    const s = scene()
    const regions = [regionData(9, [192, 0, 0], () => 4)]
    const px = new ShadowProxies(s, () => regions)
    cleanups.unshift(() => px.dispose())
    expect(px.build(regions[0]!)).toBeNull()
    px.terrain = true
    const p = px.build(regions[0]!)!
    expect(p.owner).toBe(SKIN_ONLY_OWNER)
    expect(p.triangles).toBe(SKIN_TRIS)
    expect(p.center.y).toBeCloseTo(4, 3)
    px.removed(-1) // the whole-world owner never names it
    expect(p.mesh.isDisposed()).toBe(false)
    px.prune()
    expect(p.mesh.isDisposed()).toBe(false)
    regions.length = 0
    px.prune()
    expect(p.mesh.isDisposed()).toBe(true)
    expect(px.proxies.size).toBe(0)
  })
})

describe('the cut-out casters (BT-S: the standalone depth ShaderMaterial)', () => {
  it('a region\'s table cut-out groups merge into one shadow-only caster near the camera; a material-mode group casts as itself', () => {
    const s = scene()
    const table = tableOf(s)
    const px = new ShadowProxies(s, () => [])
    cleanups.unshift(() => px.dispose())
    const fence = tableGroup(s, table, 'batch:7:2:cutout', { cutout: true })
    const g3 = tableGroup(s, table, 'batch:7:3:cutout', { cutout: true, at: [40, 0, 0] })
    const mat = new PBRMaterial('converted', s)
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
    const leaf = MeshBuilder.CreateBox('batch:7:2:leaf', { size: 1 }, s)
    leaf.material = mat
    px.batched(7, batchOf(7, 5, [fence, g3, leaf], workerProxy(s, [0, 0, 0]), [fence, g3, leaf]))
    // Not built until the camera comes near; never on a preset without foliage casting (Medium).
    expect(px.casterOf(7)).toBeNull()
    expect(px.updateCasters(new Vector3(0, 2, 0), 0)).toBe(false)
    expect(px.casterOf(7)).toBeNull()
    expect(px.updateCasters(new Vector3(500, 2, 0), 60)).toBe(false)
    expect(px.casterOf(7)).toBeNull()
    const v = px.version
    px.updateCasters(new Vector3(0, 2, 0), 60)
    const caster = px.casterOf(7)!
    expect(px.version).toBeGreaterThan(v)
    expect(caster.layerMask).toBe(SHADOW_PROXY_LAYER)
    // Never in the main pass: outside Babylon's default camera mask.
    expect(caster.layerMask & 0x0fffffff).toBe(0)
    expect(caster.receiveShadows).toBe(false)
    expect(caster.getTotalVertices()).toBe(fence.getTotalVertices() + g3.getTotalVertices())
    expect(caster.getTotalIndices()).toBe(fence.getTotalIndices() + g3.getTotalIndices())
    // Group 2 never collapses (radius −1); each group-3 vertex carries its sub-chunk's sphere.
    const cull = caster.getVerticesData(CASTER_CULL_KIND)!
    expect(cull[3]).toBe(-1)
    const n2 = fence.getTotalVertices()
    const g3s = g3.getBoundingInfo().boundingSphere
    expect([cull[n2 * 4], cull[n2 * 4 + 3]].map(x => +x!.toFixed(3))).toEqual([+g3s.centerWorld.x.toFixed(3), +g3s.radiusWorld.toFixed(3)])
    // The UV2 (the slot) comes through unchanged.
    expect(caster.getVerticesData(VertexBuffer.UV2Kind)![0]).toBe(2.5)
    const material = caster.material as CutoutCasterMaterial
    expect(material).toBeInstanceOf(CutoutCasterMaterial)
    expect(material.shadowDepthWrapper?.standalone).toBe(true)
    expect(material.backFaceCulling).toBe(false)
    // The eye and the group-3 range reach the material.
    px.setEye(new Vector3(1, 2, 3), 48 * 0.6)
    expect([material.eye.x, material.eye.y, material.eye.z, material.eye.w]).toEqual([1, 2, 3, 48 * 0.6])
    // The list: one caster and the material-mode leaf, never the table groups themselves.
    const cut = px.cutouts()
    expect(cut.filter(m => m === caster || m === leaf)).toHaveLength(2)
    expect(cut).not.toContain(fence)
    expect(cut).not.toContain(g3)
    // A second region on the same table shares the material; one region per refresh (the next is pending).
    const other = tableGroup(s, table, 'batch:8:2:cutout', { cutout: true, at: [10, 0, 0] })
    const third = tableGroup(s, table, 'batch:9:2:cutout', { cutout: true, at: [20, 0, 0] })
    px.batched(8, batchOf(8, 6, [other], null, [other]))
    px.batched(9, batchOf(9, 4, [third], null, [third]))
    expect(px.updateCasters(new Vector3(0, 2, 0), 60)).toBe(true)
    expect(px.updateCasters(new Vector3(0, 2, 0), 60)).toBe(false)
    expect(px.casterOf(8)!.material).toBe(material)
    expect(px.casterOf(9)!.material).toBe(material)
    expect(px.castersBuilt).toBe(3)
    // Far away the casters go (their VRAM with them); the group meshes are untouched.
    px.updateCasters(new Vector3(2000, 2, 0), 60)
    expect(caster.isDisposed()).toBe(true)
    expect(px.casterOf(8)).toBeNull()
    // H-12 HI-1: the material stays (no VRAM of its own; a caster built later reuses its compiled effects, D25)
    expect(s.materials).toContain(material)
    expect(fence.isDisposed()).toBe(false)
    expect(fence.getTotalVertices()).toBe(24)
    // Back near: built again; the region goes: its caster goes.
    px.updateCasters(new Vector3(0, 2, 0), 60)
    const again = px.casterOf(7)!
    px.removed(7)
    expect(again.isDisposed()).toBe(true)
    expect(px.casterOf(7)).toBeNull()
  })

  it('T12-M (WF15): the worker\'s caster arrays are uploaded as they are; a tree group\'s main-thread copy is its LOD1 prefix only', () => {
    const s = scene()
    const table = tableOf(s)
    const px = new ShadowProxies(s, () => [])
    cleanups.unshift(() => px.dispose())
    const leaves = tableGroup(s, table, 'batch:7:2:tree:leaf+cutout', { cutout: true })
    // The box's first two faces (8 vertices, 12 indices) are its LOD1; the rest its LOD2.
    leaves.metadata = { sroWorld: 'object', sroBatch: 'table', sroTree: true, sroCasterPrefix: { vertices: 8, indices: 12 } }
    const copy = mergeCutoutCasters([leaves])!
    expect([copy.positions.length, copy.normals.length, copy.uvs.length, copy.uvs2.length, copy.cull.length, copy.indices.length]).toEqual([24, 24, 16, 16, 32, 12])
    expect(Math.max(...copy.indices)).toBeLessThan(8)
    // From the worker: its arrays as they are (a triangle here), never a copy of the group meshes.
    const casterData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9), uvs: new Float32Array(6),
      uvs2: new Float32Array(6).fill(2.5), cull: new Float32Array(12).fill(-1), indices: new Uint32Array([0, 1, 2]), groups: 1,
    }
    px.batched(7, { ...batchOf(7, 5, [leaves], null, [leaves]), casterData } as RegionBatch)
    px.updateCasters(new Vector3(0, 2, 0), 60)
    const caster = px.casterOf(7)!
    expect([caster.getTotalVertices(), caster.getTotalIndices()]).toEqual([3, 3])
    // Worker data for other sources than the ones this region casts with (a count mismatch): the main-thread copy.
    px.batched(8, { ...batchOf(8, 6, [leaves], null, [leaves]), casterData: { ...casterData, groups: 2 } } as RegionBatch)
    px.updateCasters(new Vector3(0, 2, 0), 60)
    expect([px.casterOf(8)!.getTotalVertices(), px.casterOf(8)!.getTotalIndices()]).toEqual([8, 12])
  })

  it('selection: within the foliage range on High, none on Medium; a region casts one proxy plus at most one cut-out caster', () => {
    const s = scene()
    const table = tableOf(s)
    const px = new ShadowProxies(s, () => [])
    cleanups.unshift(() => px.dispose())
    const fence = tableGroup(s, table, 'batch:7:2:cutout', { cutout: true })
    const leaves = tableGroup(s, table, 'batch:7:2:tree:leaf+cutout', { cutout: true, at: [3, 0, 0] })
    const bush = tableGroup(s, table, 'batch:7:3:tree:leaf+cutout', { cutout: true, at: [6, 0, 0] })
    const proxy = workerProxy(s, [0, 0, 0])
    px.batched(7, batchOf(7, 5, [fence, leaves, bush], proxy, [fence, leaves, bush]))
    px.updateCasters(new Vector3(10, 2, 0), 60)
    const inputs = () => ({ proxies: px.allProxies(), cutouts: px.cutouts(), clones: [], terrain: [], characters: [] })
    const high = selectCasters(new Vector3(10, 2, 0), RENDER_PRESETS.high.shadows!, inputs())
    expect(high).toEqual([proxy, px.casterOf(7)])
    expect(selectCasters(new Vector3(10, 2, 0), RENDER_PRESETS.medium.shadows!, inputs())).toEqual([proxy])
    // Beyond the foliage range (60 m), the caster drops out of the list; the proxy still casts.
    expect(selectCasters(new Vector3(100, 2, 0), RENDER_PRESETS.high.shadows!, inputs())).toEqual([proxy])
  })

  it('WorldShadows on High: a region whose proxy holds its skin casts no terrain mesh; Medium keeps the worker proxy', () => {
    const s = scene()
    const sun = new DirectionalLight('sun', new Vector3(-1, -1, 0), s)
    const regions = [regionData(5, [0, 0, 0]), regionData(6, [192, 0, 0])]
    const steps: Array<(r: RegionData) => void> = []
    const terrain = regions.map(r => {
      const m = MeshBuilder.CreateGround(`terrain_${r.region.id}`, { width: 192, height: 192 }, s)
      m.position.set(r.region.origin[0] + 96, 0, -96)
      m.metadata = { sroRegion: r.region.id, sroWorld: 'terrain' }
      return m
    })
    const host = {
      objects: { addRegionListener: () => () => {} },
      terrain: { meshes: terrain },
      regions: { regions },
      addCommitStep: (_n: string, run: (r: RegionData) => void) => {
        steps.push(run)
        return () => {}
      },
    }
    const sh = new WorldShadows(s, sun, host, { quality: RENDER_PRESETS.high })
    cleanups.unshift(() => sh.dispose())
    expect(sh.proxies.terrain).toBe(true)
    // Region 5 is batched and its step ran; region 6 has not run its step yet: its terrain still casts.
    const proxy = workerProxy(s, [96, 0, -96])
    sh.proxies.batched(11, batchOf(11, 5, [], proxy, []))
    steps[0]!(regions[0]!)
    const list = sh.refreshCasters(new Vector3(96, 2, -96))
    expect(list).not.toContain(terrain[0])
    expect(list).toContain(terrain[1])
    expect(list).not.toContain(proxy)
    expect(list).toContain(sh.proxies.proxies.get(5)!.mesh)
    // Medium: no terrain casting, the skins go, the worker proxy casts as it is.
    sh.setQuality(RENDER_PRESETS.medium)
    expect(sh.proxies.terrain).toBe(false)
    expect(sh.proxies.proxies.size).toBe(0)
    const medium = sh.refreshCasters(new Vector3(96, 2, -96))
    expect(medium).toEqual([proxy])
  })
})

describe('the cut-out caster\'s depth shaders', () => {
  it('both languages: the same samplers, the table fetch, the alpha test and Babylon\'s shadow-map includes under SM_FLOAT', () => {
    const src = cutoutCasterShaders()
    expect(src.samplers).toEqual([...CUTOUT_CASTER_SAMPLERS])
    for (const [vert, frag, lang] of [[src.vertexWGSL, src.fragmentWGSL, 'wgsl'], [src.vertexGLSL, src.fragmentGLSL, 'glsl']] as const) {
      for (const inc of ['shadowMapVertexExtraDeclaration', 'shadowMapVertexNormalBias', 'shadowMapVertexMetric']) expect(vert).toContain(`#include<${inc}>`)
      // The group-3 collapse: past the range from the eye, a vertex goes to its piece's centre (before the projection).
      expect(vert).toMatch(/distance\((uniforms\.)?sroEye\.xyz, sroC(ull)?\.xyz\) - sroC(ull)?\.w > (uniforms\.)?sroEye\.w/)
      expect(vert.indexOf('sroEye.w')).toBeLessThan(vert.indexOf('viewProjection *'))
      for (const inc of ['shadowMapFragmentExtraDeclaration', 'shadowMapFragment']) expect(frag).toContain(`#include<${inc}>`)
      expect(vert.match(/#ifdef SM_FLOAT/g)).toHaveLength(3)
      expect(frag).toMatch(/#ifdef SM_FLOAT[\s\S]*#include<shadowMapFragment>\n#else/)
      expect(frag).toContain(lang === 'wgsl' ? `textureLoad(sroTable, vec2i(${TABLE_TEXEL.albedo}, sroSlot), 0)` : `texelFetch(sroTable, ivec2(${TABLE_TEXEL.albedo}, sroSlot), 0)`)
      expect(frag).toContain(lang === 'wgsl' ? `vec2i(${TABLE_TEXEL.misc}, sroSlot)` : `ivec2(${TABLE_TEXEL.misc}, sroSlot)`)
      expect(frag).toContain(lang === 'wgsl' ? 'textureSampleGrad(sroAlbArr' : 'textureGrad(sroAlbArr')
      expect(frag).toContain('discard')
      // The derivatives come first (uniform control flow), before the discard.
      expect(frag.indexOf(lang === 'wgsl' ? 'dpdx' : 'dFdx')).toBeLessThan(frag.indexOf('discard'))
      for (const s of CUTOUT_CASTER_SAMPLERS) expect(frag).toContain(s)
    }
    expect(src.vertexWGSL + src.fragmentWGSL).not.toMatch(/gl_|texture2D|texelFetch/)
  })

  it('the depth wrapper: one depth effect per shadow define set, shared by every caster; each submesh its own draw wrapper', async () => {
    const s = scene()
    const table = tableOf(s)
    const mat = new CutoutCasterMaterial('cutoutCaster', s, table)
    const a = casterMesh(s, table, 'a', mat)
    const b = casterMesh(s, table, 'b', mat)
    const defines = ['#define SM_FLOAT 1', '#define SM_ESM 0', '#define SM_DEPTHTEXTURE 1', '#define SM_NORMALBIAS 1', '#define SM_DIRECTIONINLIGHTDATA 1', '#define SM_USEDISTANCE 0', '#define SM_SOFTTRANSPARENTSHADOW 0', '#define SM_DEPTHCLAMP 1']
    const w = mat.depth
    const readyAll = async (list: string[]) => {
      for (let i = 0; i < 100; i++) {
        s.incrementRenderId()
        const ok = [a, b].map(m => w.isReadyForSubMesh(m.subMeshes[0]!, list, null, false, 0))
        if (ok.every(Boolean)) return true
        await new Promise(r => setTimeout(r, 3))
      }
      return false
    }
    expect(await readyAll(defines)).toBe(true)
    expect(w.effectCount).toBe(1)
    const da = w.getEffect(a.subMeshes[0]!, null, 0)!
    const db = w.getEffect(b.subMeshes[0]!, null, 0)!
    expect(da).not.toBe(db)
    expect(da.effect).toBe(db.effect)
    // The depth effect is made from the caster shader with the generator's defines (the material's own has none).
    const depth = da.effect!
    expect(depth.defines).toContain('#define SM_DEPTHCLAMP 1')
    expect(depth.getUniformNames()).toEqual(expect.arrayContaining(['world', 'viewProjection', 'biasAndScaleSM', 'depthValuesSM', 'lightDataSM']))
    expect(a.subMeshes[0]!.effect!.defines).not.toContain('SM_FLOAT')
    // Another define set (no normal bias) makes a second effect; the submesh switches to it.
    expect(await readyAll(defines.map(d => d.replace('SM_NORMALBIAS 1', 'SM_NORMALBIAS 0')))).toBe(true)
    expect(w.effectCount).toBe(2)
    expect(w.getEffect(a.subMeshes[0]!, null, 0)!.effect).not.toBe(depth)
    // Not ready without the table's textures.
    const missing = new CutoutCasterMaterial('noTable', s, { albedo: null, nrao: null, lightmap: null, table: readyTexture(s) })
    expect(missing.isReady(a, false, a.subMeshes[0]!)).toBe(false)
    missing.dispose()
    mat.dispose()
    expect(w.effectCount).toBe(0)
  })

  it('WebGPU: Babylon\'s WGSL processor assembles the depth effect: the array and table bindings, the depth write, no GLSL', async () => {
    const engine = new NullEngine()
    const e = engine as unknown as Record<string, unknown>
    e._isWebGPU = true
    e._webGLVersion = 2
    Object.defineProperty(engine, 'supportsUniformBuffers', { get: () => true })
    Object.defineProperty(engine, 'shaderPlatformName', { get: () => 'WEBGPU' })
    Object.defineProperty(engine, 'isNDCHalfZRange', { get: () => true })
    const wgsl = new WebGPUShaderProcessorWGSL()
    const orig = engine._getShaderProcessor.bind(engine)
    e._getShaderProcessor = (lang: ShaderLanguage) => (lang === ShaderLanguage.WGSL ? wgsl : orig(lang))
    e._getShaderProcessingContext = (lang: ShaderLanguage, pure: boolean) => new WebGPUShaderProcessingContext(lang, pure)
    const s = scene(engine)
    const table = tableOf(s)
    const mat = new CutoutCasterMaterial('cutoutCaster', s, table)
    expect(mat.shaderLanguage).toBe(ShaderLanguage.WGSL)
    const mesh = casterMesh(s, table, 'a', mat)
    const defines = ['#define SM_FLOAT 1', '#define SM_ESM 0', '#define SM_DEPTHTEXTURE 1', '#define SM_NORMALBIAS 1', '#define SM_DIRECTIONINLIGHTDATA 1', '#define SM_USEDISTANCE 0', '#define SM_SOFTTRANSPARENTSHADOW 0', '#define SM_DEPTHCLAMP 1']
    type Sources = { _vertexSourceCode: string; _fragmentSourceCode: string }
    let fx: Sources | null = null
    for (let i = 0; i < 200 && !fx?._fragmentSourceCode; i++) {
      s.incrementRenderId()
      mat.depth.isReadyForSubMesh(mesh.subMeshes[0]!, defines, null, false, 0)
      fx = (mat.depth.getEffect(mesh.subMeshes[0]!, null, 0)?.effect ?? null) as unknown as Sources | null
      await new Promise(r => setTimeout(r, 3))
    }
    const frag = fx!._fragmentSourceCode
    const vert = fx!._vertexSourceCode
    expect(frag).toMatch(/@binding\(\d+\)\s*var\s+sroAlbArr\s*:\s*texture_2d_array<f32>/)
    expect(frag).toMatch(/@binding\(\d+\)\s*var\s+sroTable\s*:\s*texture_2d<f32>/)
    expect(frag).toContain('textureSampleGrad(sroAlbArr')
    expect(frag).toMatch(/frag_depth/)
    expect(frag).toContain('fragmentOutputs.fragDepth')
    expect(vert).toContain('vDepthMetricSM')
    expect(vert).toContain('normalBiasSM')
    expect(vert).toContain('vertexInputs.sroCull')
    expect(vert).toContain('uniforms.sroEye')
    expect(vert + frag).not.toMatch(/gl_Position|gl_FragColor|texture2D\(/)
    mat.dispose()
  }, 60_000)
})
