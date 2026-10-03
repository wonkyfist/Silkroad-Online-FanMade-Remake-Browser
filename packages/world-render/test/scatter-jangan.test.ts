/**
 * Grass and plant scatter on the real exports (W5-G), headless. Skips without work/out-opt.
 *  - jangan (3 x 3, whole world): a count per region at medium, nothing on bare tiles (town marble, stone, water),
 *    nothing on an object floor (the plaza), and nothing near the spawn on the plaza;
 *  - jangan-fields (streamed, 307 regions): the total and the per-chunk generation time;
 *  - loadWorld on jangan (NullEngine): every region registers, the retail plant glbs load as the kinds' art, and
 *    chunks grow around the camera as thin instances.
 */
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ArcRotateCamera, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { NavGltf, NavWorld, decodeNavData } from '@sro/nav'
import { afterAll, describe, expect, it } from 'vitest'
import { GRID, decodeTerrainBin } from '../../convert/src/world/format.ts'
import type { WorldManifest } from '../../convert/src/world/manifest.ts'
import { CHUNKS_PER_REGION, SCATTER_PRESETS, loadWorld, scatterChunk, tileDensityTable, type ScatterSource, type World, type WorldIO } from '../src/index.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const OUT = join(REPO, 'work', 'out-opt', 'world')

function load(name: string) {
  const dir = join(OUT, name)
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as WorldManifest
  const navFile = m.nav?.file ?? (m.stream as { navObjects?: { file: string } } | undefined)?.navObjects?.file
  const nb = navFile ? readFileSync(join(dir, navFile)) : null
  const nav = nb ? new NavGltf(new NavWorld(decodeNavData(new Uint8Array(nb.buffer, nb.byteOffset, nb.byteLength))), m.space.originRegion) : null
  const occupied = (x: number, z: number, y: number) => {
    const p = nav?.locate(x, z, Infinity)
    return !!p && p.surface.kind === 'object' && p.y > y - 0.3
  }
  const sources = m.regions.map((r): ScatterSource => {
    const t = decodeTerrainBin(new Uint8Array(readFileSync(join(dir, r.terrain.file))))
    return { id: r.id, origin: r.origin, heights: t.heights, normals: t.normals, textures: t.textures, blocks: r.blocks }
  })
  const density = tileDensityTable(m.tiles)
  return { m, sources, density, occupied }
}

describe.skipIf(!existsSync(join(OUT, 'jangan', 'manifest.json')))('scatter on work/out-opt/world/jangan', () => {
  it('counts plants per region at medium, none on bare tiles, object floors or the plaza spawn', () => {
    const { m, sources, density, occupied } = load('jangan')
    const densityOf = (id: number) => density.get(id) ?? 0
    const perRegion: string[] = []
    let total = 0
    let flowers = 0
    for (const src of sources) {
      let n = 0
      for (let c = 0; c < CHUNKS_PER_REGION; c++) {
        const d = scatterChunk(src, c, densityOf, SCATTER_PRESETS.medium.fraction, occupied)
        n += d.count
        flowers += (d.plants[3]!.length + d.plants[4]!.length) / 5
        d.plants.forEach(p => {
          for (let i = 0; i < p.length; i += 5) {
            const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!
            // The nearest terrain vertex is a plant-bearing tile (never the town marble, stone or water).
            const gx = Math.round((x - src.origin[0]) / 2)
            const gz = Math.round((src.origin[2] - z) / 2)
            expect(densityOf(src.textures[gz * GRID + gx]! & 0x3ff)).toBeGreaterThan(0)
            expect(occupied(x, z, y)).toBe(false)
            if (m.spawn) expect(Math.hypot(x - m.spawn.x, z - m.spawn.z)).toBeGreaterThan(6)
          }
        })
      }
      perRegion.push(`${src.id & 0xff},${src.id >> 8}: ${n}`)
      total += n
    }
    console.log(`[scatter] jangan medium: ${total} plants (${flowers} flowers); ${perRegion.join('  ')}`)
    expect(total).toBeGreaterThan(20_000)
    expect(total).toBeLessThan(150_000)
    expect(flowers).toBeGreaterThan(100)
  })
})

describe.skipIf(!existsSync(join(OUT, 'jangan-fields', 'manifest.json')))('scatter on work/out-opt/world/jangan-fields', () => {
  it('covers the fields and generates a chunk well inside the frame budget', () => {
    const { sources, density, occupied } = load('jangan-fields')
    const densityOf = (id: number) => density.get(id) ?? 0
    let total = 0
    let ms = 0
    let chunks = 0
    let empty = 0
    for (const src of sources) {
      let n = 0
      for (let c = 0; c < CHUNKS_PER_REGION; c++) {
        const t0 = performance.now()
        n += scatterChunk(src, c, densityOf, SCATTER_PRESETS.medium.fraction, occupied).count
        ms += performance.now() - t0
        chunks++
      }
      if (!n) empty++
      total += n
    }
    const avg = ms / chunks
    console.log(`[scatter] jangan-fields medium: ${total} plants in ${sources.length} regions (${empty} bare), ${avg.toFixed(2)} ms per chunk`)
    expect(total).toBeGreaterThan(sources.length * 1000)
    expect(avg).toBeLessThan(3)
  })
})

const io: WorldIO = {
  async bytes(url) {
    const buf = await readFile(fileURLToPath(url))
    return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
  },
  async decodeImage(_bytes, _mime, size) {
    const s = size ?? 4
    return { width: s, height: s, data: new Uint8Array(s * s * 4).fill(128) }
  },
}

describe.skipIf(!existsSync(join(OUT, 'jangan', 'manifest.json')))('loadWorld jangan with scatter (NullEngine)', () => {
  let engine: NullEngine | null = null
  let world: World | null = null
  afterAll(() => {
    world?.dispose()
    engine?.dispose()
  })

  it('registers every region, loads the retail plants and grows chunks around the camera', async () => {
    engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    const cam = new ArcRotateCamera('cam', Math.PI / 2, 1.1, 9, new Vector3(0, 0, 0), scene)
    scene.activeCamera = cam
    world = await loadWorld(scene, { baseUrl: pathToFileURL(join(REPO, 'work', 'out-opt') + '/').href, world: 'jangan', io, minimap: false, stream: false, objects: false })
    const w = world
    expect(w.scatter.stats.regions).toBe(w.manifest.regions.length)
    expect(w.scatter.level).toBe('medium')
    await w.scatter.ready()
    // The Jangan field grass (tile2d c_grass_fld_10 -> grass_single03) and flowers are in the export.
    expect(w.scatter.stats.art).toContain('grass: res/nature/common/grass/grass_single03.bsr')
    expect(w.scatter.stats.art).toContain('flowerY: res/nature/common/flower/flw_g01_yall.bsr')
    // A field south of the town (the gate road's west side).
    const at = { x: w.spawn.x - 60, y: w.spawn.y + 8, z: w.spawn.z + 330 }
    for (let i = 0; i < 40; i++) w.scatter.update(at)
    expect(w.scatter.stats.chunks).toBeGreaterThan(4)
    expect(w.scatter.stats.plants).toBeGreaterThan(1000)
    const meshes = w.scatter.meshes()
    expect(meshes.reduce((s, m) => s + m.thinInstanceCount, 0)).toBe(w.scatter.stats.plants)
    for (const m of meshes) expect(m.getTotalVertices()).toBeGreaterThan(3)
    console.log(`[scatter] loadWorld jangan: ${JSON.stringify(w.scatter.stats)}`)
    w.setQuality('low')
    expect(w.scatter.level).toBe('low')
    expect(w.scatter.stats.chunks).toBe(0)
    w.setQuality({ drawDistance: 1, animated: true, water: true, scatter: 'off' })
    expect(w.scatter.level).toBe('off')
  }, 120_000)
})
