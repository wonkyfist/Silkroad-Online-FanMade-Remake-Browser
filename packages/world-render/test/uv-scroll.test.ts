/**
 * Wave 12, UV scroll (uv-scroll.ts; the retail BSR `texAni` transform the converter writes as `SidecarMaterial.uvScroll`):
 * the sidecar value is validated; ObjectMaterials puts the plugin on the converted material on both paths (Classic and
 * PBR), and only on scrolling ones; the offset the plugin binds moves by rate × time on the world clock (fract, so the
 * GPU never sees a large time); the vertex code is the same line in WGSL and GLSL and declares the uniform once; a
 * scrolling material is `separate` for the batcher; a scrolling cut-out casts no shadow; a PBR → Classic → PBR switch
 * leaves one plugin per live material.
 */
import { AssetContainer, Matrix, MeshBuilder, NullEngine, PBRMaterial, RawTexture, Scene, ShaderLanguage, StandardMaterial, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import {
  Assets,
  ObjectMaterials,
  SRO_UV_SCROLL_PLUGIN,
  SroUvScrollPlugin,
  UV_SCROLL_MAX,
  UV_SCROLL_UNIFORM,
  UvScrollShared,
  batchClass,
  uvScrollOf,
  uvScrollPhase,
  uvScrollPluginOf,
  uvScrollVertexCode,
  type PlacedModelInfo,
  type SidecarLite,
  type WorldIO,
} from '../src/index.ts'
import { ShadowProxies } from '../src/render/shadows.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  vi.restoreAllMocks()
})

function setup() {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const io: WorldIO = {
    async bytes(url) {
      throw new Error(`404 ${url}`)
    },
    decodeImage: async () => ({ width: 1, height: 1, data: new Uint8Array(4) as Uint8Array<ArrayBuffer> }),
  }
  const mats = new ObjectMaterials(scene, new Assets('http://mem.test/out/world/w/', io))
  cleanups.push(() => {
    mats.dispose()
    scene.dispose()
    engine.dispose()
  })
  return { scene, mats }
}

/** A glTF-like model: one cut-out two-sided waterfall sheet and one wall, each with a retail texture. */
function model(scene: Scene): AssetContainer {
  const c = new AssetContainer(scene)
  for (const name of ['CJ_WF_dr_01', 'wall']) {
    const mat = new PBRMaterial(name, scene)
    mat.albedoTexture = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, scene)
    if (name !== 'wall') {
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
      mat.backFaceCulling = false
    }
    const mesh = MeshBuilder.CreatePlane(`${name}:mesh`, { size: 1 }, scene)
    mesh.material = mat
    c.meshes.push(mesh)
    c.materials.push(mat)
  }
  return c
}

const SIDECAR: SidecarLite = {
  materials: [
    { name: 'CJ_WF_dr_01', flags: 0, diffuse: [], ambient: [], texture: 'prim\\mtrl\\particle\\pokpo2.ddj', alphaMode: 'MASK', uvScroll: [0, -2.78] },
    { name: 'wall', flags: 0, diffuse: [], ambient: [], texture: 'prim\\mtrl\\bldg\\wall.ddj', alphaMode: 'OPAQUE' },
  ],
}

/** The vec4 the plugin writes into its UBO at `seconds`. */
function bound(p: SroUvScrollPlugin, seconds: number): number[] {
  p.shared.seconds = seconds
  const out: number[] = []
  const ubo = { updateFloat4: (name: string, x: number, y: number, z: number, w: number) => { if (name === UV_SCROLL_UNIFORM) out.push(x, y, z, w) } }
  p.bindForSubMesh(ubo as never, null as never, null as never, null as never)
  return out
}

describe('the sidecar value (uvScrollOf)', () => {
  it('takes two finite rates within ±UV_SCROLL_MAX, not both zero; anything else is no scroll', () => {
    expect(uvScrollOf({ uvScroll: [0, -2.78] })).toEqual([0, -2.78])
    expect(uvScrollOf({ uvScroll: [0.5, 0] })).toEqual([0.5, 0])
    expect(uvScrollOf({ uvScroll: [UV_SCROLL_MAX, -UV_SCROLL_MAX] })).toEqual([UV_SCROLL_MAX, -UV_SCROLL_MAX])
    for (const bad of [undefined, null, [], [1], [1, 2, 3], [0, 0], [NaN, 1], [1, Infinity], ['0', '1'], [UV_SCROLL_MAX + 1, 0], { u: 1, v: 1 }]) {
      expect(uvScrollOf({ uvScroll: bad }), JSON.stringify(bad)).toBeNull()
    }
    expect(uvScrollOf(undefined)).toBeNull()
    expect(uvScrollOf({})).toBeNull()
  })
})

describe('the offset: rate × time on the world clock, wrapped to [0, 1)', () => {
  it('uvScrollPhase is fract(rate × seconds), also for negative rates and epoch-sized times', () => {
    expect(uvScrollPhase(-2.78, 0)).toBe(0)
    expect(uvScrollPhase(-2.78, 10)).toBeCloseTo(0.2, 9)
    expect(uvScrollPhase(0.25, 3)).toBeCloseTo(0.75, 12)
    expect(uvScrollPhase(1, NaN)).toBe(0)
    // Epoch seconds (2026): still in [0, 1) and still moving by rate × dt.
    const t = 1_790_000_000.25
    const a = uvScrollPhase(-2.78, t)
    const b = uvScrollPhase(-2.78, t + 0.1)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(1)
    expect(((b - a) % 1 + 1) % 1).toBeCloseTo(1 - 0.278, 5)
  })

  it('the bound uniform moves by rate × dt between frames; the clock is the one World hands (serverNow)', () => {
    const { scene, mats } = setup()
    scene.createDefaultCamera()
    const mat = new PBRMaterial('sheet', scene)
    const p = mats.uvScroll.attach(mat, [0.5, -2.78])
    const at0 = bound(p, 100)
    const at1 = bound(p, 100.25)
    expect(at0[0]).toBeCloseTo(0, 9)
    expect(at0[1]).toBeCloseTo(uvScrollPhase(-2.78, 100), 12)
    expect(((at1[1]! - at0[1]!) % 1 + 1) % 1).toBeCloseTo(1 - 0.695, 6) // -2.78 × 0.25 = -0.695
    expect(((at1[0]! - at0[0]!) % 1 + 1) % 1).toBeCloseTo(0.125, 9)
    expect([at0[2], at0[3]]).toEqual([0, 0])
    // The frame hook reads the clock: two clients on the same server time bind the same offset.
    let now = 1_790_000_000_000
    mats.uvScroll.clock = () => now
    scene.render()
    expect(mats.uvScroll.seconds).toBe(1_790_000_000)
    const other = new UvScrollShared(scene)
    other.clock = () => now
    other.tick()
    const q = new SroUvScrollPlugin(new PBRMaterial('sheet2', scene), other, [0.5, -2.78])
    expect(bound(q, other.seconds)).toEqual(bound(p, mats.uvScroll.seconds))
    now += 500
    scene.render()
    expect(mats.uvScroll.seconds).toBe(1_790_000_000.5)
    // A throwing clock keeps the last time.
    mats.uvScroll.clock = () => { throw new Error('no clock') }
    scene.render()
    expect(mats.uvScroll.seconds).toBe(1_790_000_000.5)
  })
})

describe('the vertex code: WGSL and GLSL, one uniform', () => {
  it('both languages add the uniform\'s xy to uvUpdated under SRO_UVSCROLL and UV1; the UBO declares it once', () => {
    const glsl = uvScrollVertexCode('glsl')
    const wgsl = uvScrollVertexCode('wgsl')
    expect(glsl).toContain(`uvUpdated += ${UV_SCROLL_UNIFORM}.xy;`)
    expect(wgsl).toContain(`uvUpdated += uniforms.${UV_SCROLL_UNIFORM}.xy;`)
    const shape = (s: string) => s.replace(/uniforms\./g, '')
    expect(shape(wgsl)).toBe(shape(glsl))
    const { scene } = setup()
    const p = new SroUvScrollPlugin(new PBRMaterial('m', scene), new UvScrollShared(scene), [0, 1])
    expect(p.isCompatible(ShaderLanguage.WGSL)).toBe(true)
    expect(p.getUniforms(ShaderLanguage.WGSL).ubo).toEqual([{ name: UV_SCROLL_UNIFORM, size: 4, type: 'vec4' }])
    expect(p.getUniforms(ShaderLanguage.GLSL).vertex).toContain(`uniform vec4 ${UV_SCROLL_UNIFORM};`)
    expect(p.getCustomCode('fragment', ShaderLanguage.WGSL)).toBeNull()
    expect(Object.keys(p.getCustomCode('vertex', ShaderLanguage.WGSL)!)).toEqual(['CUSTOM_VERTEX_UPDATE_WORLDPOS'])
  })
})

describe('ObjectMaterials: the scroll on both paths, only on scrolling materials', () => {
  for (const path of ['classic', 'pbr'] as const) {
    it(`${path}: the scrolling sheet gets the plugin and the record; the wall does not; batchClass says separate`, async () => {
      const { scene, mats } = setup()
      mats.mode = path
      const out = await mats.convert(model(scene), SIDECAR, false, { model: 'models/nature/particle/cj_wf_dr_01.glb', source: 'res\\nature\\particle\\cj_wf_dr_01.bsr', kind: 'static' })
      const [sheet, wall] = out.materials
      expect(sheet).toBeInstanceOf(path === 'pbr' ? PBRMaterial : StandardMaterial)
      const p = uvScrollPluginOf(sheet)!
      expect(p).toBeInstanceOf(SroUvScrollPlugin)
      expect([p.u, p.v]).toEqual([0, -2.78])
      expect(uvScrollPluginOf(wall)).toBeNull()
      expect(wall!.pluginManager?.getPlugin(SRO_UV_SCROLL_PLUGIN) ?? null).toBeNull()
      const [rs, rw] = out.records
      expect(rs!.uvScroll).toEqual([0, -2.78])
      expect(rw!.uvScroll).toBeUndefined()
      expect(batchClass(rs!)).toBe('separate')
      if (path === 'pbr') {
        expect(batchClass(rw!)).toBe('merge')
        // The same cut-out lit record without the scroll would merge into the table.
        expect(batchClass({ ...rs!, uvScroll: undefined })).toBe('merge')
      }
      expect(mats.uvScroll.plugins.size).toBe(1)
      mats.release(out)
      expect(mats.uvScroll.plugins.size).toBe(0)
    })
  }

  it('a live path switch (PBR → Classic → PBR re-converts) leaves one plugin per live material, never two on one', async () => {
    const { scene, mats } = setup()
    for (const path of ['pbr', 'classic', 'pbr'] as const) {
      mats.mode = path
      const out = await mats.convert(model(scene), SIDECAR, false)
      const sheet = out.materials[0]!
      const plugins = (sheet.pluginManager as unknown as { _plugins: Array<{ name: string }> })._plugins.filter(x => x.name === SRO_UV_SCROLL_PLUGIN)
      expect(plugins).toHaveLength(1)
      expect(mats.uvScroll.plugins.size).toBe(1)
      mats.release(out)
    }
    expect(mats.uvScroll.plugins.size).toBe(0)
  })
})

describe('shadows: a scrolling cut-out casts nothing (its mask would stand still in the shadow pass)', () => {
  it('ShadowProxies.cutouts skips a chunk whose material scrolls; a still cut-out stays', () => {
    const { scene, mats } = setup()
    const px = new ShadowProxies(scene, () => [])
    cleanups.unshift(() => px.dispose())
    const chunk = (name: string, scroll: boolean): Mesh => {
      const m = MeshBuilder.CreateBox(name, { size: 1 }, scene)
      m.thinInstanceSetBuffer('matrix', Matrix.Identity().toArray() as unknown as Float32Array, 16, true)
      const mat = new PBRMaterial(name, scene)
      mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
      if (scroll) mats.uvScroll.attach(mat, [0, -1])
      m.material = mat
      return m
    }
    const still = chunk('fence', false)
    const sheet = chunk('waterfall', true)
    const info: PlacedModelInfo = { index: 0, source: 'm0.bsr', heightM: 4, isFoliage: false, kind: 'static' }
    px.placed(1, {} as WorldModel, info, [still, sheet], [{ region: 5, group: 2 } as WorldPlacement])
    expect(px.cutouts()).toEqual([still])
  })
})
