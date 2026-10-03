/**
 * H-12 adversarial hunt, lens "hitches" (docs/WAVE_PLAN8.md §6.7 item 10, D25: "every new effect compiles at world load
 * ... no compile when the first new tree enters band 0 or the first painted region streams in"). Read-only.
 *
 * FINDING (H12-HI-1, browser-observed on the production build, High WebGPU, private server): walking the fields after a
 * respawn (or any teleport: a GM /tp, a return scroll) the effect cache gained `sroCutoutCaster` (both its main and its
 * SM_* depth variant) again in play, in a frame of 88 ms that also built a caster. ShadowProxies disposes a table's
 * CutoutCasterMaterial when its last caster drops (render/shadows.ts dropCaster: `--m.users <= 0` → dispose), which
 * releases its compiled effects; the next caster near the camera makes a new material whose effects compile in play
 * (on WebGPU a synchronous pipeline build). The material holds no VRAM of its own (the casters' buffers are the meshes'),
 * so keeping it costs nothing; dropping it costs a compile on every return.
 */
import { MeshBuilder, NullEngine, PBRMaterial, RawTexture, Scene, Vector3, VertexBuffer, type AbstractMesh, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { RegionBatch } from '../src/batch/types.ts'
import { SroSurfacePlugin, SurfaceShared, type SurfaceTable } from '../src/pbr/surface-plugin.ts'
import { CutoutCasterMaterial, ShadowProxies } from '../src/render/shadows.ts'

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

function readyTexture(s: Scene): RawTexture {
  const t = RawTexture.CreateRGBATexture(new Uint8Array(4), 1, 1, s)
  t.getInternalTexture()!.isReady = true
  t.isReady = () => true
  return t
}

const tableOf = (s: Scene): SurfaceTable => ({ albedo: readyTexture(s), nrao: readyTexture(s), lightmap: readyTexture(s), table: readyTexture(s) })

/** A table-mode cut-out group (shadows-batch.test.ts' tableGroup). */
function tableGroup(s: Scene, table: SurfaceTable, name: string, at: [number, number, number]): Mesh {
  const mat = new PBRMaterial(`batch:group:${name}`, s)
  mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST
  new SroSurfacePlugin(mat, new SurfaceShared(), { cls: 'wood', table })
  const mesh = MeshBuilder.CreateBox(name, { size: 2 }, s)
  mesh.position.set(...at)
  mesh.bakeCurrentTransformIntoVertices()
  mesh.setVerticesData(VertexBuffer.UV2Kind, new Float32Array(mesh.getTotalVertices() * 2).fill(2.5), false, 2)
  mesh.material = mat
  mesh.freezeWorldMatrix()
  return mesh
}

function batchOf(owner: number, region: number, meshes: AbstractMesh[]): RegionBatch {
  return { owner, region, meshes, shadowProxy: null, cutoutCasters: meshes, slots: [], min: Vector3.Zero(), max: Vector3.One(), setEmissive: () => {} } as unknown as RegionBatch
}

describe('hitches: the cut-out caster material across a trip away (D25)', () => {
  it('a caster built after every caster dropped (a teleport, a respawn) reuses the compiled caster material', () => {
    const s = scene()
    const table = tableOf(s)
    const px = new ShadowProxies(s, () => [])
    cleanups.unshift(() => px.dispose())
    // Region 7 by the town, region 9 two kilometres away (the far fields).
    px.batched(7, batchOf(7, 5, [tableGroup(s, table, 'batch:7:2:cutout', [0, 0, 0])]))
    px.batched(9, batchOf(9, 6, [tableGroup(s, table, 'batch:9:2:cutout', [2000, 0, 0])]))
    px.updateCasters(new Vector3(0, 2, 0), 60)
    const first = px.casterOf(7)!
    const material = first.material as CutoutCasterMaterial
    expect(material).toBeInstanceOf(CutoutCasterMaterial)
    // The teleport: the town's caster drops (out of range) before the far region's is built.
    px.updateCasters(new Vector3(2000, 2, 0), 60)
    px.updateCasters(new Vector3(2000, 2, 0), 60)
    const far = px.casterOf(9)!
    expect(far).toBeTruthy()
    // The same compiled material (no new effect to compile in play).
    expect(s.materials).toContain(material)
    expect(far.material).toBe(material)
  })
})
