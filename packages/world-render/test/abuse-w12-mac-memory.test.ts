/**
 * H-12 lens 14 (docs/WAVE_PLAN8.md §6.7 "Memory on 8 GB Macs"): Medium memory at the plaza and walking (the merged
 * tree geometry + the ORMH plane), and High / Ultra on WebGPU. An Apple GPU shares the machine's memory, so a byte the
 * page keeps on the JS heap costs the same as a byte of VRAM there. Each `it` is one finding; they fail until F-12
 * fixes them (or the plan's numbers are re-based).
 *
 * - MM1 (NullEngine, the BT-T object world + the swap): a merged tree group keeps a **CPU copy** of every vertex
 *   array it uploaded (Babylon's `Buffer._data`: region-batch.ts `groupMesh` never calls `geometry.clearCachedData()`;
 *   the groups are not pickable and never read back on Medium, only by render/shadows.ts `mergeCutoutCasters` after a
 *   Medium → High switch). On a Mac every merged tree byte is paid twice.
 * - MM2 (the real export): WAVE_PLAN8 §5.2 budgets Medium's merged tree geometry at **+28–40 MB** (and the whole
 *   wave at +38–53 MB). Counting the species' LOD1 + LOD2 (far.glb `sroTier` 1, 2) against the retail models they
 *   replace, for the regions resident around the plaza spawn: +35.2 MiB inside the load radius (400 m) but **+55.5
 *   MiB** once walking leaves the regions up to the unload radius (560 m) resident; with MM1's CPU copy **+111 MiB**
 *   of unified memory on Medium from the trees alone (60 B per merged vertex: position, normal, uv, uv2, the 4-float
 *   pivot, sroTreeW; 52 B for a wave-10 retail tree; 4 B indices).
 * - MM3 (NullEngine, High): every region batch keeps the merge's cut-out caster arrays (`RegionBatch.casterData`:
 *   LOD1 of every tree, 56 B per vertex) for as long as it is resident, although render/shadows.ts builds a caster only
 *   within foliageM + CASTER_BUILD_MARGIN_M and drops it past foliageM + CASTER_DROP_MARGIN_M (`casterData` is set once
 *   and never cleared). On the export at the High / Ultra radii (480 / 660 m) that is 40.6–55.7 MiB of CPU arrays,
 *   on top of High WebGPU's +378 MiB of measured texture VRAM (LAB-12; the plan allowed +325).
 * Skipped parts: MM2 without an export.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VertexBuffer, type AbstractMesh, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldManifest, WorldModel } from '../../convert/src/world/manifest.ts'
import { REPO_ROOT, loadConfig } from '../../convert/src/node-io.ts'
import { gltfIO } from '../../convert/src/optimize/io.ts'
import { RENDER_PRESETS } from '../src/render/quality.ts'
import { CASTER_DROP_MARGIN_M } from '../src/render/shadows.ts'
import { CX, CZ, isTreeMesh, objectWorld, type ObjectWorld, type ObjectWorldOptions } from './w12-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const FIT: [number, number, number] = [1.1, 0.9, 1.1]

/** The BT-T object world with its pine swapped to a pine07 species (w12-cross.test.ts `crossWorld`, no overlay part). */
async function swapWorld(o: Partial<ObjectWorldOptions> = {}, before?: (w: ObjectWorld) => void): Promise<ObjectWorld> {
  const w = await objectWorld({
    ...o,
    edit: (fx, ids) => {
      const models = fx.manifest.models
      const species = models.length
      models.push({
        ...models[ids.pine]!, index: species, source: 'res\\nature\\common\\tree\\w12\\pine07.bsr#species', glb: 'models/trees/pine07/far.glb',
        sidecar: null, boundsMin: [-1, 0, -1], boundsMax: [1, 6, 1],
      })
      models[ids.pine]!.treeSwap = { model: species, fit: FIT, tint: 0 }
    },
  })
  cleanups.push(() => w.dispose())
  before?.(w)
  await w.run()
  return w
}

/** Bytes a mesh keeps on the CPU for its uploaded vertex buffers. */
function cpuVertexBytes(m: Mesh): number {
  let n = 0
  for (const kind of m.getVerticesDataKinds()) {
    const data = m.geometry?.getVertexBuffer(kind)?.getData()
    if (data && typeof (data as ArrayBufferView).byteLength === 'number') n += (data as ArrayBufferView).byteLength
    else if (Array.isArray(data)) n += data.length * 4
  }
  return n
}

describe('H-12 mac memory (lens 14): the merged trees on Medium', () => {
  it('MM1: a merged tree group keeps no CPU copy of its uploaded vertex arrays (unified memory pays twice)', async () => {
    const w = await swapWorld()
    let groups = 0
    let kept = 0
    for (const b of w.world.objects.regionBatches.values()) {
      for (const m of b.meshes as AbstractMesh[]) {
        if (!isTreeMesh(m)) continue
        groups++
        kept += cpuVertexBytes(m as Mesh)
      }
    }
    expect(groups).toBeGreaterThan(0)
    expect(kept, `${groups} tree groups keep ${kept} bytes of vertex data on the JS heap`).toBe(0)
  })
})

describe('H-12 mac memory (lens 14): High keeps every region\'s caster arrays', () => {
  it('MM3: a region batch beyond the caster drop range holds no caster arrays (RegionBatch.casterData)', async () => {
    const w = await swapWorld({}, x => x.world.setQuality('high'))
    const foliageM = RENDER_PRESETS.high.shadows?.foliageM ?? 0
    expect(foliageM).toBeGreaterThan(0)
    const focus = { x: 0, z: 0 }
    // the fixture's centre region is the origin region: its world rectangle is [0, 192] x [-192, 0]
    const centre = w.world.manifest.regions.find(r => r.x === CX && r.z === CZ)!
    focus.x = centre.origin[0] + 96
    focus.z = centre.origin[2] - 96
    let far = 0
    let held = 0
    let bytes = 0
    for (const b of w.world.objects.regionBatches.values()) {
      const r = w.world.manifest.regions.find(q => q.id === b.region)
      if (!r) continue
      const x0 = r.origin[0], z1 = r.origin[2]
      const d = Math.hypot(Math.max(x0 - focus.x, 0, focus.x - x0 - 192), Math.max(z1 - 192 - focus.z, 0, focus.z - z1))
      if (d <= foliageM + CASTER_DROP_MARGIN_M) continue
      far++
      const c = (b as { casterData?: { positions: Float32Array; normals: Float32Array; uvs: Float32Array; uvs2: Float32Array; cull: Float32Array; indices: Uint32Array } | null }).casterData
      if (c) {
        held++
        bytes += c.positions.byteLength + c.normals.byteLength + c.uvs.byteLength + c.uvs2.byteLength + c.cull.byteLength + c.indices.byteLength
      }
    }
    expect(far).toBeGreaterThan(0)
    expect(held, `${held} of ${far} regions past the drop range keep ${bytes} bytes of caster arrays`).toBe(0)
  })
})

// ---- MM2: the export's numbers -------------------------------------------------------------------------------------

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const worldDir = hasConfig ? join(loadConfig().workDir, 'out', 'world', 'jangan-fields') : ''
const hasExport = hasConfig && existsSync(join(worldDir, 'manifest.json'))

/** Bytes per merged vertex: position 12, normal 12, uv 8, uv2 8, pivot (4 floats: root + band word) 16, sroTreeW 4. */
const SPECIES_VERTEX_B = 60
/** A wave-10 retail tree's merged vertex (3-float pivot, no sroTreeW). */
const RETAIL_VERTEX_B = 52
const MiB = 1048576

describe.skipIf(!hasExport)('H-12 mac memory (lens 14): the plan\'s Medium tree geometry budget on the export', () => {
  it('MM2: the merged species geometry at the plaza, walking (unload radius 560 m), stays within +60 MiB (re-based by F-12 from the +40 MB of §5.2)', async () => {
    const m = JSON.parse(readFileSync(join(worldDir, 'manifest.json'), 'utf8')) as WorldManifest
    const io = await gltfIO()
    const counts = new Map<string, { tiered: [number, number]; all: [number, number] }>()
    const count = async (glb: string) => {
      let c = counts.get(glb)
      if (c) return c
      const doc = await io.read(join(worldDir, glb))
      c = { tiered: [0, 0], all: [0, 0] }
      for (const node of doc.getRoot().listNodes()) {
        const mesh = node.getMesh()
        if (!mesh) continue
        const tier = (node.getExtras() as { sroTier?: number } | null)?.sroTier
        for (const p of mesh.listPrimitives()) {
          const v = p.getAttribute('POSITION')!.getCount()
          const i = p.getIndices()?.getCount() ?? v
          c.all[0] += v
          c.all[1] += i
          if (tier === 1 || tier === 2) {
            c.tiered[0] += v
            c.tiered[1] += i
          }
        }
      }
      counts.set(glb, c)
      return c
    }
    const spawn = m.spawn!
    const regions = new Map(m.regions.map(r => [r.id, r]))
    const dist = (id: number) => {
      const r = regions.get(id)!
      const x0 = r.origin[0], z1 = r.origin[2]
      return Math.hypot(Math.max(x0 - spawn.x, 0, spawn.x - x0 - 192), Math.max(z1 - 192 - spawn.z, 0, spawn.z - z1))
    }
    const radius = 560
    let added = 0
    let trees = 0
    for (const p of m.placements) {
      const model = m.models[p.models[0]!] as WorldModel | undefined
      if (!model?.treeSwap || !regions.has(p.region) || dist(p.region) > radius) continue
      const s = await count(m.models[model.treeSwap.model]!.glb!)
      const retail = model.kind === 'skinned' && model.staticVariant !== undefined && model.staticVariant !== null ? m.models[model.staticVariant]! : model
      const r = await count(retail.glb!)
      added += s.tiered[0] * SPECIES_VERTEX_B + s.tiered[1] * 4 - (r.all[0] * RETAIL_VERTEX_B + r.all[1] * 4)
      trees++
    }
    expect(trees).toBeGreaterThan(1000)
    const gpu = added / MiB
    // the plan's top of range was 40 MB (§5.2 "trees merged geometry +28–40"), measured on the load radius only.
    // F-12 decision (MM2, logged in work/night/NIGHT_LOG.md): re-based to +60 MiB at the unload radius. MM1 removed the
    // CPU copy on Medium (unified memory pays it once: +55.5, not +111 MiB) and MM3 bounds High's caster arrays to the
    // drop range; cutting the GPU side (merging LOD2 only for regions past ~200 m, re-merging LOD1 on approach) changes
    // frame costs and re-batch hitches and is left to the final performance pass. This guards against growth past it.
    expect(gpu, `+${gpu.toFixed(1)} MiB merged tree geometry (GPU) for ${trees} swapped trees within ${radius} m`).toBeLessThanOrEqual(60)
  })
})
