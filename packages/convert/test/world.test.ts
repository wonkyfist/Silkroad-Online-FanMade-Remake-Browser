/**
 * Region converter (src/world) against the real client: converts Jangan's centre region (168, 97) with objects, and
 * its east (169, 97) and north (168, 98) neighbours terrain-only in a second run with the same floating origin, into a
 * temp dir. Skips without sro.config.json.
 *
 * Ground truth used besides the output's self-consistency:
 * - the .nvm height map (Data.pk2, a different file from the .m) exported next to the terrain must coincide with it;
 * - the .nvm object list stores neighbour-owned objects relative to ITS region: our placements (owner-region frame +
 *   region offset) must land on the same spot;
 * - .o2 objects stand on the .m terrain (placement y vs terrain height);
 * - the .t lightmap is dark where objects cast shadows, only under the manifest's documented UV rule;
 * - the terrain layer map, coloured with the tile textures' mean luminance, correlates with the client's own minimap
 *   tile only in the documented orientation (cell (cx, cz) = local x east, z north; minimap north-up).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseNvm } from '@sro/formats'
import { decodeNavData } from '@sro/nav'
import { toGltfPosition } from '../src/gltf/space.ts'
import { validateGlb } from '../src/gltf/validate.ts'
import type { Sidecar } from '../src/gltf/convert.ts'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'
import { convertWorld } from '../src/world/convert-world.ts'
import { decodeNavmeshBin, decodeTerrainBin, GRID, terrainHeightAt, type TerrainBin } from '../src/world/format.ts'
import { validateWorldManifest, type WorldManifest, type WorldRegion } from '../src/world/manifest.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))

/** Minimal PNG reader (8-bit RGBA, non-interlaced, all five filters) for checking our own output. */
function decodePng(buf: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let o = 8
  let width = 0
  let height = 0
  const idat: Uint8Array[] = []
  while (o < buf.length) {
    const len = dv.getUint32(o)
    const type = String.fromCharCode(...buf.subarray(o + 4, o + 8))
    if (type === 'IHDR') {
      width = dv.getUint32(o + 8)
      height = dv.getUint32(o + 12)
      if (buf[o + 16] !== 8 || buf[o + 17] !== 6) throw new Error('decodePng: expected 8-bit RGBA')
    } else if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len))
    o += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const s = width * 4
  const out = new Uint8Array(s * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (s + 1)]!
    for (let i = 0; i < s; i++) {
      const x = raw[y * (s + 1) + 1 + i]!
      const a = i >= 4 ? out[y * s + i - 4]! : 0
      const b = y ? out[(y - 1) * s + i]! : 0
      const c = i >= 4 && y ? out[(y - 1) * s + i - 4]! : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]!
      out[y * s + i] = (x + pred) & 0xff
    }
  }
  return { width, height, rgba: out }
}

const readJson = <T>(file: string) => JSON.parse(readFileSync(file, 'utf8')) as T

describe.skipIf(!hasConfig)('world region converter (168,97 + neighbours)', () => {
  let tmp: string
  let dirA: string
  let dirB: string
  let a: WorldManifest
  let b: WorldManifest
  const terrain = new Map<string, { region: WorldRegion; bin: TerrainBin }>()

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'sro-world-'))
    dirA = join(tmp, 'a')
    dirB = join(tmp, 'b')
    const origin = { x: 168, z: 97 }
    await convertWorld({ name: 'a', regions: [{ x: 168, z: 97 }], origin, outDir: dirA, validate: false })
    await convertWorld({ name: 'b', regions: [{ x: 169, z: 97 }, { x: 168, z: 98 }], origin, outDir: dirB, objects: false })
    a = readJson<WorldManifest>(join(dirA, 'manifest.json'))
    b = readJson<WorldManifest>(join(dirB, 'manifest.json'))
    for (const [dir, m] of [[dirA, a], [dirB, b]] as const) {
      for (const region of m.regions) {
        terrain.set(`${region.x},${region.z}`, { region, bin: decodeTerrainBin(readFileSync(join(dir, region.terrain.file))) })
      }
    }
  }, 300_000)

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  })

  it('writes manifests that validate against the exported types', () => {
    expect(validateWorldManifest(a)).toEqual([])
    expect(validateWorldManifest(b)).toEqual([])
    expect(a.regions.map(r => r.id)).toEqual([0x61a8])
    expect(b.regions.map(r => [r.x, r.z])).toEqual([[169, 97], [168, 98]])
    expect(a.space.originRegion).toEqual({ x: 168, z: 97, id: 0x61a8 })
    expect(a.regions[0]!.origin).toEqual([0, 0, 0])
    // east = +X, north = -Z (space.ts mirror); 192 m regions
    expect(b.regions[0]!.origin).toEqual([192, 0, 0])
    expect(b.regions[1]!.origin).toEqual([0, 0, -192])
    expect(a.report.failedModels).toEqual([])
    expect(a.report.placements).toBeGreaterThan(200)
    expect(a.report.placementRecords).toBeGreaterThan(a.report.placements)
    console.log(`168,97: ${a.report.placementRecords} records -> ${a.report.placements} placements, ${a.report.uniqueModels} models ` +
      `(${a.models.filter(m => m.kind === 'skinned').length} skinned, ${a.models.filter(m => m.lightmappedMeshes).length} lightmapped), ` +
      `${(a.report.sizes.totalBytes / 2 ** 20).toFixed(1)} MiB, ${a.report.timeMs.total} ms; warnings: ${a.warnings.length}`)
  })

  it('matches terrain exactly across the region seams (heights, normals, world positions)', () => {
    const c = terrain.get('168,97')!
    const east = terrain.get('169,97')!
    const north = terrain.get('168,98')!
    let compared = 0
    for (let k = 0; k < GRID; k++) {
      // x seam: centre gx = 96 == east gx = 0
      const i = k * GRID + 96
      const j = k * GRID
      expect(east.bin.heights[j]).toBe(c.bin.heights[i])
      expect([...east.bin.normals.subarray(j * 4, j * 4 + 4)]).toEqual([...c.bin.normals.subarray(i * 4, i * 4 + 4)])
      expect(east.region.origin[0] + 0).toBe(c.region.origin[0] + 2 * 96)
      // z seam: centre gz = 96 == north gz = 0
      const zi = 96 * GRID + k
      expect(north.bin.heights[k]).toBe(c.bin.heights[zi])
      expect([...north.bin.normals.subarray(k * 4, k * 4 + 4)]).toEqual([...c.bin.normals.subarray(zi * 4, zi * 4 + 4)])
      expect(north.region.origin[2]).toBe(c.region.origin[2] - 2 * 96)
      compared += 2
    }
    // A neighbour-mismatch control: the opposite pairing (centre gx = 0 vs east gx = 0) must not match.
    let diff = 0
    for (let k = 0; k < GRID; k++) diff += Math.abs(east.bin.heights[k * GRID]! - c.bin.heights[k * GRID]!)
    expect(diff).toBeGreaterThan(1)
    expect(compared).toBe(2 * GRID)
  })

  it('exports navmesh heights (.nvm) that coincide with the terrain (.m) everywhere', () => {
    for (const [dir, m] of [[dirA, a], [dirB, b]] as const) {
      for (const region of m.regions) {
        const nav = decodeNavmeshBin(readFileSync(join(dir, region.navmesh!.file)))
        const t = terrain.get(`${region.x},${region.z}`)!.bin
        let max = 0
        for (let i = 0; i < GRID * GRID; i++) max = Math.max(max, Math.abs(nav.heights[i]! - t.heights[i]!))
        expect(max).toBe(0)
        expect(nav.cells.length / 4).toBe(region.navmesh!.cells)
        // every tile's cell contains the tile centre; blocked flag <=> closed cell
        let outside = 0
        let flagMismatch = 0
        for (let tz = 0; tz < 96; tz++) {
          for (let tx = 0; tx < 96; tx++) {
            const cell = nav.tileCells[tz * 96 + tx]!
            const [x0, z0, x1, z1] = nav.cells.subarray(cell * 4, cell * 4 + 4)
            const cx = 20 * tx + 10
            const cz = 20 * tz + 10
            if (!(cx >= x0! && cx <= x1! && cz >= z0! && cz <= z1!)) outside++
            if (((nav.tileFlags[tz * 96 + tx]! & 1) === 1) !== (cell >= nav.openCellCount)) flagMismatch++
          }
        }
        expect({ outside, flagMismatch }).toEqual({ outside: 0, flagMismatch: 0 })
      }
    }
  })

  it('ships nav.bin (@sro/nav) for the converted regions, and a spawn only where a return point lies', () => {
    // a: 168,97 with its object list (neighbour-owned objects included); b: two regions without GATE_CH.
    for (const [dir, m] of [[dirA, a], [dirB, b]] as const) {
      expect(m.nav).toBeDefined()
      const bytes = new Uint8Array(readFileSync(join(dir, m.nav!.file)))
      expect(bytes.byteLength).toBe(m.nav!.bytes)
      const nav = decodeNavData(bytes)
      expect(nav.regions.map(r => r.id)).toEqual(m.regions.map(r => r.id))
      expect(m.nav!.regions).toEqual(m.regions.map(r => r.id))
      expect(nav.instances).toHaveLength(m.nav!.instances)
      expect(nav.models).toHaveLength(m.nav!.models)
      // Every instance comes from a converted region's .nvm object list (the same count, after the uid dedupe).
      const listed = new Set<number>()
      for (const r of m.regions) {
        const nvm = parseNvm(openArchive('Data').read(`navmesh/nv_${r.id.toString(16).padStart(4, '0')}.nvm`))
        for (const o of nvm.objects) listed.add(o.regionId * 0x10000 + o.localUid)
      }
      expect(nav.instances.map(i => i.id).sort()).toEqual([...listed].sort())
    }
    // 168,97's .nvm object list names every placement whose object has a navmesh, including the plaza.
    expect(a.nav!.instances).toBe(62)
    expect(decodeNavData(new Uint8Array(readFileSync(join(dirA, a.nav!.file)))).models.some(md => md.key.endsWith('/cj_jang_gate06.bms'))).toBe(true)
    // GATE_CH (teleportdata, region 25000) is the default return point of 168,97; b has none.
    expect(a.spawn).toMatchObject({ x: 96.9, z: -136.9, yaw: 0 })
    expect(a.spawn!.y).toBeCloseTo(-3.261, 3)
    expect(a.spawn!.source).toContain('GATE_CH')
    expect(b.spawn).toBeUndefined()
    expect(b.warnings.some(w => w.startsWith('spawn:'))).toBe(true)
  })

  it('references only files that exist (manifest, sidecars, lightmap uris)', () => {
    const missing: string[] = []
    const check = (dir: string, rel: string | null) => {
      if (rel !== null && !existsSync(join(dir, ...rel.split('/')))) missing.push(rel)
    }
    for (const [dir, m] of [[dirA, a], [dirB, b]] as const) {
      for (const r of m.regions) {
        check(dir, r.terrain.file)
        check(dir, r.lightmap?.file ?? null)
        check(dir, r.minimap)
        check(dir, r.navmesh?.file ?? null)
      }
      for (const t of m.tiles) check(dir, t.file)
      for (const f of [...m.water.frames, ...m.water.waves, m.water.ice]) check(dir, f)
      check(dir, m.environment.file)
      for (const model of m.models) {
        check(dir, model.glb)
        check(dir, model.sidecar)
        if (!model.sidecar) continue
        const sidecar = readJson<Sidecar>(join(dir, model.sidecar))
        for (const mesh of sidecar.meshes) if (mesh.lightmap) check(dir, mesh.lightmap.uri)
      }
    }
    expect(missing).toEqual([])
    expect(a.water.frames).toHaveLength(30)
    const env = readJson<{ profiles: Array<{ id: number }> }>(join(dirA, a.environment.file))
    expect(env.profiles.map(p => p.id)).toEqual(a.environment.profileIds)
    expect(a.environment.profileIds).toContain(15)
  })

  it('passes the glTF validator with 0 errors on 10 object glbs', async () => {
    const converted = a.models.filter(m => m.glb)
    const pick = new Map<number, (typeof converted)[number]>()
    for (const m of converted.filter(m => m.kind === 'skinned').slice(0, 3)) pick.set(m.index, m)
    for (const m of converted.filter(m => m.lightmappedMeshes > 0).slice(0, 4)) pick.set(m.index, m)
    for (let i = 0; pick.size < 10 && i < converted.length; i += Math.max(1, Math.floor(converted.length / 10))) {
      pick.set(converted[i]!.index, converted[i]!)
    }
    expect(pick.size).toBe(10)
    const results: string[] = []
    for (const m of pick.values()) {
      const v = await validateGlb(readFileSync(join(dirA, m.glb!)), m.glb!)
      results.push(`${m.glb} ${v.errors}e/${v.warnings}w`)
      expect(v.errors, m.glb!).toBe(0)
    }
    console.log(`validator: ${results.join(', ')}`)
  })

  it('places objects so they share the .nvm object list positions (neighbour-owned objects too)', () => {
    const nvm = parseNvm(openArchive('Data').read('navmesh/nv_61a8.nvm'))
    const byKey = new Map(a.placements.map(p => [p.region * 0x10000 + p.uid, p]))
    let foreign = 0
    for (const o of nvm.objects) {
      const p = byKey.get(o.regionId * 0x10000 + o.localUid)
      expect(p, `placement ${o.regionId.toString(16)}:${o.localUid}`).toBeDefined()
      expect(p!.objId).toBe(o.objId)
      // .nvm stores positions relative to ITS region (168,97 = the floating origin region)
      const expected = toGltfPosition(o.position)
      for (let k = 0; k < 3; k++) expect(Math.abs(p!.position[k]! - expected[k]!)).toBeLessThan(1e-4)
      if (o.regionId !== 0x61a8) foreign++
    }
    expect(foreign).toBeGreaterThan(0)
    for (const p of a.placements) {
      expect(p.rotation[0]).toBe(0)
      expect(p.rotation[2]).toBe(0)
      expect(Math.abs(p.rotation[1] - Math.sin(p.yaw / 2))).toBeLessThan(1e-12)
    }
  })

  it('stands static non-big objects on the terrain (>= 90% within 3 m)', () => {
    const { region, bin } = terrain.get('168,97')!
    const dys: number[] = []
    for (const p of a.placements) {
      if (!p.flags.static || p.flags.big) continue
      const lx = (p.position[0] - region.origin[0]) / 0.1
      const lz = (region.origin[2] - p.position[2]) / 0.1
      if (lx < 0 || lx > 1920 || lz < 0 || lz > 1920) continue
      dys.push(p.position[1] - terrainHeightAt(bin.heights, lx, lz))
    }
    const abs = dys.map(Math.abs).sort((x, y) => x - y)
    const share = (limit: number) => abs.filter(d => d < limit).length / abs.length
    const q = (f: number) => abs[Math.floor(f * (abs.length - 1))]!
    console.log(
      `placement y - terrain (static, non-big, in 168,97; n=${abs.length}): ` +
        `<1cm ${(share(0.01) * 100).toFixed(1)}%, <10cm ${(share(0.1) * 100).toFixed(1)}%, <1m ${(share(1) * 100).toFixed(1)}%, ` +
        `<3m ${(share(3) * 100).toFixed(1)}%; median ${q(0.5).toFixed(3)} m, p90 ${q(0.9).toFixed(2)} m, max ${q(1).toFixed(2)} m`,
    )
    expect(abs.length).toBeGreaterThan(150)
    expect(share(3)).toBeGreaterThanOrEqual(0.9)
    expect(share(0.01)).toBeGreaterThan(0.5)
  })

  it('has lightmap shadows under objects only with the documented UV rule', () => {
    const region = a.regions[0]!
    const img = decodePng(readFileSync(join(dirA, region.lightmap!.file)))
    expect([img.width, img.height]).toEqual([512, 512])
    const lum = (u: number, v: number) => {
      const x = Math.min(img.width - 1, Math.max(0, Math.floor(u * img.width)))
      const y = Math.min(img.height - 1, Math.max(0, Math.floor(v * img.height)))
      return img.rgba[(y * img.width + x) * 4]!
    }
    let mean = 0
    for (let i = 0; i < img.width * img.height; i++) mean += img.rgba[i * 4]!
    mean /= img.width * img.height
    const variants: Record<string, (u: number, v: number) => number> = {
      documented: (u, v) => lum(u, v),
      flipV: (u, v) => lum(u, 1 - v),
      flipU: (u, v) => lum(1 - u, v),
      swap: (u, v) => lum(v, u),
    }
    const dark: Record<string, number> = { documented: 0, flipV: 0, flipU: 0, swap: 0 }
    let n = 0
    for (const p of a.placements) {
      if (p.region !== region.id || p.group !== 2) continue
      const lx = (p.position[0] - region.origin[0]) / 0.1
      const lz = (region.origin[2] - p.position[2]) / 0.1
      const u = (0.5 + (511 * lx) / 1920) / 512
      const v = (0.5 + (511 * lz) / 1920) / 512
      n++
      for (const k in variants) dark[k]! += mean - variants[k]!(u, v)
    }
    for (const k in dark) dark[k] = dark[k]! / n
    console.log(`lightmap darkening at ${n} group-2 objects (mean ${mean.toFixed(1)}): ${JSON.stringify(dark, (_, v) => (typeof v === 'number' ? +v.toFixed(2) : v))}`)
    expect(dark.documented).toBeGreaterThan(5)
    for (const k of ['flipV', 'flipU', 'swap']) expect(dark.documented).toBeGreaterThan(1.5 * dark[k]!)
  })

  it('has a terrain layer map that matches the client minimap in the documented orientation', () => {
    const lum = (rgba: Uint8Array, i: number) => rgba[i * 4]! * 0.3 + rgba[i * 4 + 1]! * 0.59 + rgba[i * 4 + 2]! * 0.11
    const tileMean = new Map<number, number>()
    for (const t of b.tiles) {
      const img = decodePng(readFileSync(join(dirB, t.file)))
      let sum = 0
      for (let i = 0; i < img.width * img.height; i++) sum += lum(img.rgba, i)
      tileMean.set(t.id, sum / (img.width * img.height))
    }
    const corr = (x: number[], y: number[]) => {
      const mx = x.reduce((s, v) => s + v, 0) / x.length
      const my = y.reduce((s, v) => s + v, 0) / y.length
      let sxy = 0
      let sxx = 0
      let syy = 0
      for (let i = 0; i < x.length; i++) {
        sxy += (x[i]! - mx) * (y[i]! - my)
        sxx += (x[i]! - mx) ** 2
        syy += (y[i]! - my) ** 2
      }
      return sxy / Math.sqrt(sxx * syy)
    }
    for (const region of b.regions) {
      const bin = terrain.get(`${region.x},${region.z}`)!.bin
      const cells: number[] = []
      for (let c = 0; c < 96 * 96; c++) {
        let colour = 0
        for (let k = 0; k < bin.layerCount; k++) {
          const o = (k * 96 * 96 + c) * 4
          if (!bin.layers[o + 3]) break
          const id = bin.layers[o]! | ((bin.layers[o + 1]! & 3) << 8)
          const m = bin.layers[o + 2]!
          const alpha = ((m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1)) / 4
          colour = k === 0 ? tileMean.get(id)! : colour * (1 - alpha) + tileMean.get(id)! * alpha
        }
        cells.push(colour)
      }
      // minimap cell means, reading the PNG as documented: north-up, pixel (col, row) at local x = (col + 0.5) 7.5,
      // z = 1920 - (row + 0.5) 7.5
      const mm = decodePng(readFileSync(join(dirB, region.minimap!)))
      const sum = new Float64Array(96 * 96)
      const count = new Float64Array(96 * 96)
      for (let row = 0; row < mm.height; row++) {
        for (let col = 0; col < mm.width; col++) {
          const cx = Math.floor(((col + 0.5) * 7.5) / 20)
          const cz = Math.floor((1920 - (row + 0.5) * 7.5) / 20)
          sum[cz * 96 + cx]! += lum(mm.rgba, row * mm.width + col)
          count[cz * 96 + cx]! += 1
        }
      }
      const northUp = [...sum].map((v, i) => v / count[i]!)
      const at = (cx: number, cz: number) => northUp[cz * 96 + cx]!
      const variant = (f: (cx: number, cz: number) => number) => {
        const out: number[] = []
        for (let cz = 0; cz < 96; cz++) for (let cx = 0; cx < 96; cx++) out.push(f(cx, cz))
        return out
      }
      const scores = {
        documented: corr(cells, northUp),
        flipZ: corr(cells, variant((cx, cz) => at(cx, 95 - cz))),
        flipX: corr(cells, variant((cx, cz) => at(95 - cx, cz))),
        transposed: corr(cells, variant((cx, cz) => at(cz, cx))),
      }
      console.log(`layer map vs minimap ${region.x},${region.z}: ${Object.entries(scores).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', ')}`)
      expect(scores.documented).toBeGreaterThan(0.25)
      expect(scores.documented).toBeGreaterThan(Math.max(scores.flipZ, scores.flipX, scores.transposed) + 0.05)
    }
  })
})
