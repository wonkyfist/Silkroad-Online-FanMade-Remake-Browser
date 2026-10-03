/**
 * Adversarial verification of the converted Jangan world (work/out/world/jangan, `pnpm sro convert-region --preset
 * jangan`). It assumes the output is mirrored, rotated, offset or mis-scaled until independent ground truth says
 * otherwise. Every check compares the output with something the converter did not produce:
 *
 * - the client's own minimap tiles (Media.pk2 minimap/<x>x<z>.ddj): a top-down software render of the OUTPUT
 *   (manifest transforms, terrain bins, glbs; src/world/verify-scene.ts) must match them in the identity orientation,
 *   at zero offset and at scale 1, and the converted object transforms must beat deliberately wrong ones;
 * - the .nvm navmeshes (Data.pk2, a different file set from the Map.pk2 .m/.o2 the converter reads): heights,
 *   object-edge links between neighbouring objects, and the terrain cells that list each object;
 * - the neighbouring lightmap tiles, which must continue across region borders;
 * - a third-party port's own converted Jangan height map and object list (read-only, never copied or run).
 *
 * Skips without the converted output; the client-based checks also need sro.config.json, the port check its folder
 * (SRO_THIRD_PARTY_PORT or the default path below).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { decodeDds, parseBms, parseBsr, parseDdj, parseNvm, parseObjectIfo, type BmsNavMesh, type NvmFile } from '@sro/formats'
import { convertResource } from '../src/gltf/convert.ts'
import { toGltfPosition } from '../src/gltf/space.ts'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'
import { terrainHeightAt, terrainIndices } from '../src/world/format.ts'
import type { WorldPlacement } from '../src/world/manifest.ts'
import { placementRotation } from '../src/world/objects.ts'
import {
  crop,
  DIHEDRAL,
  decodePng,
  dihedralScores,
  boxBlur,
  gradient,
  gray,
  luminance,
  ncc,
  quantile,
  composeTR,
  transformPoint,
  TopDown,
  type Gray,
  type Vec3,
} from '../src/world/verify.ts'
import {
  DOCUMENTED_TILE_UV,
  drawPlacements,
  drawTerrain,
  loadAllModels,
  loadTileMips,
  loadWorld,
  PLACEMENT_VARIANTS,
  regionRect,
  worldView,
  type LoadedWorld,
  type ModelGeometry,
  type Shading,
  type TileUv,
} from '../src/world/verify-scene.ts'

const OUT = join(REPO_ROOT, 'work', 'out', 'world', 'jangan')
const hasOutput = existsSync(join(OUT, 'manifest.json'))
const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const PORT = process.env.SRO_THIRD_PARTY_PORT ??
  '' // set SRO_THIRD_PARTY_PORT to a third-party port's zones/jangan_province folder (skipped without it)
const hasPort = existsSync(join(PORT, 'heights.bin')) && existsSync(join(PORT, 'statics.json'))

/** Minimap pixel = 7.5 file units = 0.75 m (256 px per 1920-unit region). */
const PX = 0.75
/** The client's fixed object light: from +X and up (TERRAIN.md 3.2), glTF (1, 1, 0). */
const EAST_LIGHT: Shading = { dir: [1, 1, 0], ambient: 0.45, diffuse: 0.75 }

const f3 = (v: number) => v.toFixed(3)
/** High-pass luminance (3 px blur minus 25 px blur): texture and object detail, no large-scale shading. */
const highPass = (g: Gray): Gray => {
  const a = boxBlur(g, 1)
  const b = boxBlur(g, 12)
  const out = gray(g.width, g.height)
  for (let i = 0; i < out.data.length; i++) out.data[i] = a.data[i]! - b.data[i]!
  return out
}
/** Edge strength, lightly blurred so a sub-pixel offset does not decorrelate. */
const edges = (g: Gray): Gray => boxBlur(gradient(boxBlur(g, 1)), 2)
const share = (v: number[], f: (x: number) => boolean) => v.filter(f).length / v.length
const pct = (x: number) => `${(100 * x).toFixed(1)}%`

describe.skipIf(!hasOutput)('verify world output (work/out/world/jangan)', () => {
  let world: LoadedWorld
  let models: Map<number, ModelGeometry>
  /** Terrain only; objects drawn on clones. */
  let base: TopDown
  /** Terrain + static objects, converted transforms, lit from +X. */
  let render: Gray
  const staticOnly = (p: WorldPlacement) => p.models.every(i => world.manifest.models[i]?.kind === 'static')
  const size = () => world.manifest.space.regionSizeM

  beforeAll(async () => {
    world = loadWorld(OUT)
    models = await loadAllModels(world)
    base = worldView(world, PX)
    drawTerrain(base, world, loadTileMips(world))
    const v = base.clone()
    drawPlacements(v, world, models, { filter: staticOnly, shading: EAST_LIGHT })
    render = v.luminance()
  }, 300_000)

  // --- 2. terrain seams, normals, winding, lightmaps (output only + neighbour continuity) -------------------------------

  it('joins terrain across all region borders (heights, normals), with normals and winding facing up in glTF', () => {
    const by = new Map(world.regions.map(d => [`${d.region.x},${d.region.z}`, d]))
    let seams = 0
    let maxDh = 0
    let maxDn = 0
    for (const d of world.regions) {
      const { x, z } = d.region
      for (const [n, pair] of [[by.get(`${x + 1},${z}`), (k: number) => [k * 97 + 96, k * 97]], [by.get(`${x},${z + 1}`), (k: number) => [96 * 97 + k, k]]] as const) {
        if (!n) continue
        seams++
        // the neighbour's origin is exactly one region east (+X) / north (-Z)
        expect(n.region.origin[0] - d.region.origin[0] + (n.region.origin[2] - d.region.origin[2])).toBe(n.region.x > x ? size() : -size())
        for (let k = 0; k < 97; k++) {
          const [i, j] = pair(k)
          maxDh = Math.max(maxDh, Math.abs(d.terrain.heights[i]! - n.terrain.heights[j]!))
          for (let c = 0; c < 3; c++) maxDn = Math.max(maxDn, Math.abs(d.terrain.normals[i * 4 + c]! - n.terrain.normals[j * 4 + c]!))
        }
      }
    }
    // normals against finite differences of the glTF vertex positions (x = 2 gx, z = -2 gz)
    let maxAngle = 0
    let down = 0
    const idx = terrainIndices()
    for (const d of world.regions) {
      const h = d.terrain.heights
      for (let gz = 1; gz < 96; gz++) {
        for (let gx = 1; gx < 96; gx++) {
          const n = [-4 * (h[gz * 97 + gx + 1]! - h[gz * 97 + gx - 1]!), 16, 4 * (h[(gz + 1) * 97 + gx]! - h[(gz - 1) * 97 + gx]!)]
          const o = (gz * 97 + gx) * 4
          const s = [d.terrain.normals[o]!, d.terrain.normals[o + 1]!, d.terrain.normals[o + 2]!]
          const cos = (n[0]! * s[0]! + n[1]! * s[1]! + n[2]! * s[2]!) / Math.hypot(...n) / Math.hypot(...s)
          maxAngle = Math.max(maxAngle, (Math.acos(Math.min(1, cos)) * 180) / Math.PI)
        }
      }
      const p = (i: number) => [2 * (i % 97), h[i]!, -2 * Math.floor(i / 97)]
      for (let t = 0; t < idx.length; t += 3) {
        const [a, b, c] = [p(idx[t]!), p(idx[t + 1]!), p(idx[t + 2]!)]
        if ((b[2]! - a[2]!) * (c[0]! - a[0]!) - (b[0]! - a[0]!) * (c[2]! - a[2]!) <= 0) down++
      }
    }
    console.log(`terrain: ${seams} seams, max |dh| ${maxDh} m, max |dn| ${maxDn}/127; normals vs glTF finite differences max ${maxAngle.toFixed(2)} deg; ` +
      `${down} of ${(idx.length / 3) * world.regions.length} triangles facing down`)
    expect(seams).toBe(12)
    expect(maxDh).toBe(0)
    expect(maxDn).toBe(0)
    expect(maxAngle).toBeLessThan(1)
    expect(down).toBe(0)
  })

  it('has lightmaps that continue across region borders only in the documented orientation (row 0 = south, col 0 = west)', () => {
    const lm = new Map(world.manifest.regions.map(r => [`${r.x},${r.z}`, decodePng(readFileSync(join(OUT, r.lightmap!.file)))]))
    const L = (key: string, c: number, r: number) => lm.get(key)!.rgba[(r * 512 + c) * 4]!
    // [east-seam pairing, north-seam pairing] under each hypothesis; A = this region, B = the neighbour
    type Pair = (a: string, b: string, k: number) => number
    const hyp: Record<string, [Pair, Pair]> = {
      documented: [(a, b, k) => L(a, 511, k) - L(b, 0, k), (a, b, k) => L(a, k, 511) - L(b, k, 0)],
      flipV: [(a, b, k) => L(a, 511, k) - L(b, 0, k), (a, b, k) => L(a, k, 0) - L(b, k, 511)],
      flipU: [(a, b, k) => L(a, 0, k) - L(b, 511, k), (a, b, k) => L(a, k, 511) - L(b, k, 0)],
      transposed: [(a, b, k) => L(a, k, 511) - L(b, k, 0), (a, b, k) => L(a, 511, k) - L(b, 0, k)],
    }
    const result: Record<string, { east: number; north: number }> = {}
    const perSeam: string[] = []
    for (const [name, [east, north]] of Object.entries(hyp)) {
      let se = 0
      let ne = 0
      let sn = 0
      let nn = 0
      for (const r of world.manifest.regions) {
        const a = `${r.x},${r.z}`
        for (const [b, f, isEast] of [[`${r.x + 1},${r.z}`, east, true], [`${r.x},${r.z + 1}`, north, false]] as const) {
          if (!lm.has(b)) continue
          let s = 0
          for (let k = 0; k < 512; k++) s += Math.abs(f(a, b, k))
          if (isEast) {
            se += s
            ne += 512
          } else {
            sn += s
            nn += 512
          }
          if (name === 'documented') perSeam.push(`${a}->${b} ${(s / 512).toFixed(2)}`)
        }
      }
      result[name] = { east: se / ne, north: sn / nn }
    }
    let interior = 0
    for (const key of lm.keys()) for (let k = 0; k < 512; k++) interior += Math.abs(L(key, 255, k) - L(key, 256, k)) / 2 + Math.abs(L(key, k, 255) - L(key, k, 256)) / 2
    interior /= 512 * lm.size
    console.log(`lightmap seam mean |diff| (0..255): ${Object.entries(result).map(([k, v]) => `${k} E ${v.east.toFixed(2)} N ${v.north.toFixed(2)}`).join('; ')}; ` +
      `interior neighbours ${interior.toFixed(2)}\n  documented per seam: ${perSeam.join(', ')}`)
    expect(result.documented!.east).toBeLessThan(interior)
    expect(result.documented!.north).toBeLessThan(interior)
    expect(result.flipU!.east).toBeGreaterThan(5 * interior)
    expect(result.flipV!.north).toBeGreaterThan(5 * interior)
    expect(result.transposed!.east).toBeGreaterThan(5 * interior)
    expect(result.transposed!.north).toBeGreaterThan(5 * interior)
  })

  it('has object lightmaps bright on upward faces only as exported (TEXCOORD_1 as stored, row 0 = v 0, CCW fronts)', async () => {
    const images = new Map<string, ReturnType<typeof decodePng>>()
    const readings: Record<string, (u: number, v: number) => [number, number]> = {
      documented: (u, v) => [u, v],
      flipV: (u, v) => [u, 1 - v],
      flipU: (u, v) => [1 - u, v],
      swapped: (u, v) => [v, u],
    }
    const lm: Record<string, number[]> = Object.fromEntries(Object.keys(readings).map(k => [k, []]))
    const up: number[] = []
    const io = new NodeIO()
    for (const m of world.manifest.models) {
      if (!m.glb || !m.lightmappedMeshes) continue
      const doc = await io.readBinary(readFileSync(join(OUT, m.glb)))
      for (const node of doc.getRoot().listNodes()) {
        const mesh = node.getMesh()
        if (!mesh || node.getSkin()) continue
        const mat4 = node.getWorldMatrix()
        for (const prim of mesh.listPrimitives()) {
          const extras = prim.getMaterial()?.getExtras() as { sroLightmap?: { uri: string | null } } | undefined
          const uri = extras?.sroLightmap?.uri
          const uv = prim.getAttribute('TEXCOORD_1')?.getArray()
          const pos = prim.getAttribute('POSITION')?.getArray()
          const idx = prim.getIndices()?.getArray()
          if (!uri || !uv || !pos || !idx) continue
          if (!images.has(uri)) images.set(uri, decodePng(readFileSync(join(OUT, uri))))
          const img = images.get(uri)!
          const p = (i: number) => transformPoint(mat4, pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!)
          for (let t = 0; t + 2 < idx.length; t += 3) {
            const [a, b, c] = [p(idx[t]!), p(idx[t + 1]!), p(idx[t + 2]!)]
            const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
            const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
            const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
            const len = Math.hypot(...n)
            if (len < 1e-6) continue
            up.push(n[1]! / len)
            const u = (uv[idx[t]! * 2]! + uv[idx[t + 1]! * 2]! + uv[idx[t + 2]! * 2]!) / 3
            const v = (uv[idx[t]! * 2 + 1]! + uv[idx[t + 1]! * 2 + 1]! + uv[idx[t + 2]! * 2 + 1]!) / 3
            for (const [k, f] of Object.entries(readings)) {
              const [su, sv] = f(u, v)
              const x = Math.min(img.width - 1, Math.max(0, Math.floor(su * img.width)))
              const y = Math.min(img.height - 1, Math.max(0, Math.floor(sv * img.height)))
              lm[k]!.push(img.rgba[(y * img.width + x) * 4]!)
            }
          }
        }
      }
    }
    const scores = Object.fromEntries(Object.entries(lm).map(([k, v]) => [k, ncc({ width: v.length, height: 1, data: Float32Array.from(v) }, { width: up.length, height: 1, data: Float32Array.from(up) })]))
    console.log(`object lightmaps: correlation of the lightmap texel with the outward normal's y over ${up.length} triangles in ${images.size} lightmaps: ` +
      Object.entries(scores).map(([k, v]) => `${k} ${f3(v)}`).join(', '))
    expect(scores.documented).toBeGreaterThan(0.3)
    for (const k of ['flipV', 'flipU', 'swapped']) expect(scores.documented! - scores[k]!).toBeGreaterThan(0.25)
  })

  // --- 1 + 4 + 5. the client's minimap ----------------------------------------------------------------------------------

  describe.skipIf(!hasConfig)('against the client minimap tiles (Media.pk2)', () => {
    /** Client minimap tiles in the same north-up frame as the render (tile (x, z) at column x, row maxZ - z). */
    let mosaic: Gray
    const tiles = new Map<string, Gray>()

    beforeAll(() => {
      const media = openArchive('Media')
      mosaic = gray(render.width, render.height)
      const xs = world.manifest.regions.map(r => r.x)
      const zs = world.manifest.regions.map(r => r.z)
      for (let z = Math.min(...zs) - 1; z <= Math.max(...zs) + 1; z++) {
        for (let x = Math.min(...xs) - 1; x <= Math.max(...xs) + 1; x++) {
          const path = `minimap/${x}x${z}.ddj`
          if (media.has(path)) tiles.set(`${x},${z}`, luminance(decodeDds(parseDdj(media.read(path)).dds)))
        }
      }
      for (const r of world.manifest.regions) {
        const t = tiles.get(`${r.x},${r.z}`)!
        expect([t.width, t.height]).toEqual([256, 256])
        const { c0, r0, n } = regionRect(base, r, size())
        expect(n).toBe(256)
        for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) mosaic.data[(r0 + y) * mosaic.width + c0 + x] = t.data[y * 256 + x]!
      }
    })

    it('joins the minimap tiles in the converter\'s arrangement (tile x+1 east, tile z+1 north)', () => {
      const T = (key: string, c: number, r: number) => tiles.get(key)!.data[r * 256 + c]!
      const seam = (a: string, b: string, f: (a: string, b: string, k: number) => number) => {
        let s = 0
        for (let k = 0; k < 256; k++) s += Math.abs(f(a, b, k))
        return s / 256
      }
      const rows: string[] = []
      let worse = 0
      let count = 0
      let docSum = 0
      let altSum = 0
      for (const key of tiles.keys()) {
        const [x, z] = key.split(',').map(Number) as [number, number]
        for (const [b, doc, alt] of [
          // documented: east neighbour's column 0 continues column 255; north neighbour's row 255 continues row 0
          [`${x + 1},${z}`, (a: string, e: string, k: number) => T(a, 255, k) - T(e, 0, k), (a: string, e: string, k: number) => T(a, 0, k) - T(e, 255, k)],
          [`${x},${z + 1}`, (a: string, n: string, k: number) => T(a, k, 0) - T(n, k, 255), (a: string, n: string, k: number) => T(a, k, 255) - T(n, k, 0)],
        ] as const) {
          if (!tiles.has(b)) continue
          const d = seam(key, b, doc)
          const w = seam(key, b, alt)
          count++
          docSum += d
          altSum += w
          if (d >= w) worse++
          rows.push(`${key}->${b} ${d.toFixed(1)}/${w.toFixed(1)}`)
        }
      }
      let interior = 0
      for (const key of tiles.keys()) for (let k = 0; k < 256; k++) interior += (Math.abs(T(key, 127, k) - T(key, 128, k)) + Math.abs(T(key, k, 127) - T(key, k, 128))) / 2
      interior /= 256 * tiles.size
      console.log(`minimap seams (${count}, 5x5 tiles): mean |diff| documented ${(docSum / count).toFixed(2)} vs swapped ${(altSum / count).toFixed(2)} ` +
        `(interior neighbours ${interior.toFixed(2)}); documented worse in ${worse}\n  ${rows.join(', ')}`)
      // A few seams run along a long wall drawn right at a tile edge (e.g. the palace's west wall at 167|168 x 98), where
      // any pairing jumps; the arrangement is decided by the rest.
      expect(worse / count).toBeLessThan(0.1)
      expect(docSum / count).toBeLessThan(1.5 * interior)
      expect(altSum / count).toBeGreaterThan(2 * interior)
    })

    it('renders every region in the minimap\'s orientation (identity wins all 8 flips/rotations)', () => {
      const lines: string[] = []
      for (const r of world.manifest.regions) {
        const { c0, r0, n } = regionRect(base, r, size())
        const mine = crop(render, c0, r0, n, n)
        const ref = tiles.get(`${r.x},${r.z}`)!
        for (const [name, prep, margin] of [['high-pass', highPass, 0.15], ['edges', edges, 0.1]] as const) {
          const s = dihedralScores(mine, ref, prep)
          const best = Math.max(...s.slice(1))
          lines.push(`${r.x},${r.z} ${name.padEnd(9)} identity ${f3(s[0]!)}, best other ${f3(best)} (${DIHEDRAL[s.indexOf(best)]!.name}); ` +
            s.slice(1).map((v, k) => `${DIHEDRAL[k + 1]!.name} ${f3(v)}`).join(' '))
          expect(s[0], `${r.x},${r.z} ${name}`).toBeGreaterThan(0.4)
          expect(s[0]! - best, `${r.x},${r.z} ${name} margin`).toBeGreaterThan(margin)
        }
      }
      console.log(`render vs minimap, per region (NCC):\n  ${lines.join('\n  ')}`)
    })

    it('puts water where the minimap is blue (manifest water blocks, not the .nvm plane types)', () => {
      const media = openArchive('Media')
      const blue = new Float32Array(render.width * render.height)
      for (const r of world.manifest.regions) {
        const img = decodeDds(parseDdj(media.read(`minimap/${r.x}x${r.z}.ddj`)).dds)
        const { c0, r0 } = regionRect(base, r, size())
        for (let y = 0; y < 256; y++) {
          for (let x = 0; x < 256; x++) blue[(r0 + y) * render.width + c0 + x] = img.rgba[(y * 256 + x) * 4 + 2]! - img.rgba[(y * 256 + x) * 4]!
        }
      }
      // surface = terrain + static objects (depth of the render); water is visible where its height is above it
      const surface = base.clone()
      drawPlacements(surface, world, models, { filter: staticOnly })
      const block = (lx: number, lz: number) => Math.min(5, Math.floor(lz / 320)) * 6 + Math.min(5, Math.floor(lx / 320))
      type Hit = NonNullable<ReturnType<LoadedWorld['locate']>>
      const sources: Record<string, (h: Hit) => number | null> = {
        manifest: h => h.data.region.blocks[block(h.lx, h.lz)]!.water?.heightM ?? null,
        nvmPlanes: h => {
          const p = h.data.region.navmesh!.planes![block(h.lx, h.lz)]!
          return p.type ? p.heightM : null
        },
        manifestFlippedNS: h => h.data.region.blocks[block(h.lx, 1919 - h.lz)]!.water?.heightM ?? null,
      }
      const res: Record<string, { n: number; inside: number; outside: number }> = {}
      for (const [name, f] of Object.entries(sources)) {
        let si = 0
        let ni = 0
        let so = 0
        let no = 0
        for (let r = 0; r < surface.height; r++) {
          for (let c = 0; c < surface.width; c++) {
            const [x, z] = surface.centre(c, r)
            const hit = world.locate(x, z)
            if (!hit) continue
            const w = f(hit)
            const i = r * surface.width + c
            if (w !== null && surface.depth[i]! < w) {
              si += blue[i]!
              ni++
            } else {
              so += blue[i]!
              no++
            }
          }
        }
        res[name] = { n: ni, inside: si / ni, outside: so / no }
      }
      console.log(`visible water vs minimap blueness (B - R): ${Object.entries(res).map(([k, v]) => `${k} ${v.n} px, inside ${v.inside.toFixed(1)} / outside ${v.outside.toFixed(1)}`).join('; ')}`)
      expect(res.manifest!.n).toBeGreaterThan(2000)
      expect(res.manifest!.inside - res.manifest!.outside).toBeGreaterThan(25)
      expect(res.nvmPlanes!.inside).toBeLessThan(res.manifest!.inside - 25)
      expect(res.manifestFlippedNS!.inside).toBeLessThan(res.manifest!.inside - 25)
    })

    it('textures the terrain tiles in the minimap\'s orientation (u along +X, v along +Z, row 0 at v = 0)', () => {
      const mips = loadTileMips(world)
      const fine = (g: Gray): Gray => {
        const b = boxBlur(g, 4)
        const out = gray(g.width, g.height)
        for (let i = 0; i < out.data.length; i++) out.data[i] = g.data[i]! - b.data[i]!
        return out
      }
      const readings: Record<string, TileUv> = {
        documented: DOCUMENTED_TILE_UV,
        flipV: (x, z) => [x, -z],
        flipU: (x, z) => [-x, z],
        swapped: (x, z) => [z, x],
        rot180: (x, z) => [-x, -z],
      }
      const per: Record<string, number[]> = {}
      for (const [name, uv] of Object.entries(readings)) {
        const v = worldView(world, PX)
        drawTerrain(v, world, mips, uv)
        const lum = v.luminance()
        per[name] = world.manifest.regions.map(r => {
          const { c0, r0, n } = regionRect(v, r, size())
          return ncc(fine(crop(lum, c0, r0, n, n)), fine(tiles.get(`${r.x},${r.z}`)!))
        })
      }
      const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
      const wins = per.documented!.filter((s, i) => Object.entries(per).every(([k, v]) => k === 'documented' || s > v[i]!)).length
      console.log(`terrain tile texture detail vs minimap (fine high-pass NCC, terrain only), mean over regions: ` +
        `${Object.entries(per).map(([k, v]) => `${k} ${f3(mean(v))}`).join(', ')}; documented best in ${wins}/9 regions`)
      for (const k of Object.keys(readings)) if (k !== 'documented') expect(mean(per.documented!) - mean(per[k]!), k).toBeGreaterThan(0.015)
      expect(wins).toBeGreaterThanOrEqual(7)
    })

    it('is registered to the minimap within a pixel (0.75 m), at model scale 1 and position scale 1', () => {
      const e = edges(render)
      const m = edges(mosaic)
      const inner = render.width - 16
      let best = { s: -2, dx: 0, dy: 0 }
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const s = ncc(crop(e, 8 + dx, 8 + dy, inner, inner), crop(m, 8, 8, inner, inner))
          if (s > best.s) best = { s, dx, dy }
        }
      }
      const score = (matrix: (p: WorldPlacement) => number[]) => {
        const v = base.clone()
        drawPlacements(v, world, models, { filter: staticOnly, shading: EAST_LIGHT, matrix })
        return ncc(edges(v.luminance()), m)
      }
      const modelScale = [0.9, 0.95, 1, 1.05, 1.1].map(s => ({
        s,
        ncc: score(p => {
          const t = composeTR(p.position, p.rotation)
          return t.map((v, i) => (i < 12 && i % 4 < 3 ? v * s : v))
        }),
      }))
      // placements scaled about the centre of the origin region (a wrong metres-per-unit for positions)
      const c = size() / 2
      const positionScale = [0.99, 0.995, 1, 1.005, 1.01].map(s => ({
        s,
        ncc: score(p => composeTR([c + (p.position[0] - c) * s, p.position[1], -c + (p.position[2] + c) * s], p.rotation)),
      }))
      console.log(`registration: best shift (${best.dx}, ${best.dy}) px, NCC ${f3(best.s)}; ` +
        `model scale ${modelScale.map(x => `${x.s}: ${f3(x.ncc)}`).join(', ')}; position scale ${positionScale.map(x => `${x.s}: ${f3(x.ncc)}`).join(', ')}`)
      expect(Math.abs(best.dx)).toBeLessThanOrEqual(1)
      expect(Math.abs(best.dy)).toBeLessThanOrEqual(1)
      const top = (xs: Array<{ s: number; ncc: number }>) => xs.reduce((a, b) => (b.ncc > a.ncc ? b : a)).s
      expect(top(modelScale)).toBe(1)
      expect(top(positionScale)).toBe(1)
    })

    it('matches the minimap best with the object light from +X (east is the client\'s +X)', () => {
      const m = mosaic
      const res = [0, 45, 90, 135, 180, 225, 270, 315].map(az => {
        const a = (az * Math.PI) / 180
        const v = base.clone()
        // azimuth from east toward north (glTF north = -Z)
        drawPlacements(v, world, models, { filter: staticOnly, shading: { ...EAST_LIGHT, dir: [Math.cos(a), 1, -Math.sin(a)] } })
        return { az, ncc: ncc(v.luminance(), m) }
      })
      console.log(`light azimuth (deg from east toward north) vs minimap luminance NCC: ${res.map(r => `${r.az}: ${f3(r.ncc)}`).join(', ')}`)
      const best = res.reduce((a, b) => (b.ncc > a.ncc ? b : a))
      expect(best.az).toBe(0)
      expect(best.ncc - res.find(r => r.az === 180)!.ncc).toBeGreaterThan(0.05)
    })

    it('orients objects like the minimap: the converted transform beats yaw/mirror alternatives where they differ', () => {
      const m = edges(mosaic)
      const lum = PLACEMENT_VARIANTS.map(variant => {
        const v = base.clone()
        drawPlacements(v, world, models, { filter: staticOnly, shading: EAST_LIGHT, variant })
        return v.luminance()
      })
      const e = lum.map(edges)
      const lines: string[] = []
      for (let k = 1; k < PLACEMENT_VARIANTS.length; k++) {
        const differ = gray(render.width, render.height)
        for (let i = 0; i < differ.data.length; i++) differ.data[i] = Math.abs(lum[0]!.data[i]! - lum[k]!.data[i]!) > 8 ? 1 : 0
        const grown = boxBlur(differ, 3)
        const mask = new Uint8Array(differ.data.length)
        let n = 0
        for (let i = 0; i < mask.length; i++) {
          if (grown.data[i]! > 0) {
            mask[i] = 1
            n++
          }
        }
        const conv = ncc(e[0]!, m, mask)
        const alt = ncc(e[k]!, m, mask)
        lines.push(`${PLACEMENT_VARIANTS[k]!.name}: ${n} px differ, converted ${f3(conv)} vs ${f3(alt)} (whole image ${f3(ncc(e[0]!, m))} vs ${f3(ncc(e[k]!, m))})`)
        expect(conv - alt, PLACEMENT_VARIANTS[k]!.name).toBeGreaterThan(0.1)
      }
      console.log(`object transforms vs minimap edges, on the pixels where the variant differs:\n  ${lines.join('\n  ')}`)
    })
  })

  // --- 3 + 4 + 5. the .nvm navmeshes (Data.pk2) ---------------------------------------------------------------------

  describe.skipIf(!hasConfig)('against the .nvm navmeshes and object collision meshes (Data.pk2)', () => {
    const nvms = new Map<number, NvmFile>()
    const navCache = new Map<number, BmsNavMesh | null>()
    let navOf: (objId: number) => BmsNavMesh | null
    const byKey = new Map<number, WorldPlacement>()

    beforeAll(() => {
      const data = openArchive('Data')
      const ifo = parseObjectIfo(openArchive('Map').read('object.ifo'))
      for (const r of world.manifest.regions) nvms.set(r.id, parseNvm(data.read(`navmesh/nv_${r.id.toString(16).padStart(4, '0')}.nvm`)))
      for (const p of world.manifest.placements) byKey.set(p.region * 0x10000 + p.uid, p)
      navOf = objId => {
        if (!navCache.has(objId)) {
          let nav: BmsNavMesh | null = null
          const entry = ifo.byIndex.get(objId)
          if (entry && entry.path.toLowerCase().endsWith('.bsr')) {
            const path = parseBsr(data.read(entry.path)).collision.meshPath
            if (path && data.has(path)) nav = parseBms(data.read(path)).navMesh ?? null
          }
          navCache.set(objId, nav)
        }
        return navCache.get(objId)!
      }
    })

    it('has navmesh heights equal to the terrain, and objects standing on it (per class)', () => {
      let max = 0
      for (const d of world.regions) {
        const nvm = nvms.get(d.region.id)!
        for (let i = 0; i < 97 * 97; i++) max = Math.max(max, Math.abs(Math.fround(nvm.heights[i]! * 0.1) - d.terrain.heights[i]!))
      }
      const cls = (p: WorldPlacement) => {
        const parts = p.source.toLowerCase().split(/[\\/]/)
        const kind = parts[1] === 'nature' ? `nature/${parts[3]}` : parts[1]!
        return `${kind.replace(/\.bsr$/, '')} ${p.flags.static ? 'static' : 'dynamic'}`
      }
      const dy = new Map<string, number[]>()
      const bottom = new Map<string, number[]>()
      const all: number[] = []
      for (const p of world.manifest.placements) {
        const hit = world.locate(p.position[0], p.position[2])
        if (!hit) continue
        const ground = terrainHeightAt(nvms.get(hit.data.region.id)!.heights, hit.lx, hit.lz) * 0.1
        const k = cls(p)
        const d = p.position[1] - ground
        if (!dy.has(k)) {
          dy.set(k, [])
          bottom.set(k, [])
        }
        dy.get(k)!.push(d)
        bottom.get(k)!.push(d + Math.min(...p.models.map(i => world.manifest.models[i]!.boundsMin[1])))
        if (p.flags.static && !p.flags.big) all.push(Math.abs(d))
      }
      const lines = [...dy].sort().map(([k, v]) => `${k.padEnd(24)} n ${String(v.length).padStart(4)}  |dy| < 1 cm ${pct(share(v, x => Math.abs(x) < 0.01)).padStart(6)}, ` +
        `< 1 m ${pct(share(v, x => Math.abs(x) < 1)).padStart(6)}; dy p10/p50/p90 ${[0.1, 0.5, 0.9].map(q => quantile(v, q).toFixed(2)).join('/')} m; ` +
        `model bottom - ground p10/p50/p90 ${[0.1, 0.5, 0.9].map(q => quantile(bottom.get(k)!, q).toFixed(2)).join('/')} m`)
      console.log(`.nvm heights vs terrain: max |diff| ${max} m\nplacement y - .nvm ground, by class:\n  ${lines.join('\n  ')}\n` +
        `  static non-big (n ${all.length}): < 1 cm ${pct(share(all, x => x < 0.01))}, < 1 m ${pct(share(all, x => x < 1))}, < 3 m ${pct(share(all, x => x < 3))}, median ${quantile(all, 0.5).toFixed(3)} m`)
      expect(max).toBe(0)
      expect(quantile(all, 0.5)).toBeLessThan(0.01)
      expect(share(all, x => x < 3)).toBeGreaterThan(0.95)
      // buildings neither float nor sink as a class
      expect(Math.abs(quantile(bottom.get('bldg static')!, 0.5))).toBeLessThan(0.5)
    })

    it('agrees with the .nvm tile textures (texture grid and layer planes) and object yaws', () => {
      let tiles = 0
      let atCorner = 0
      let atMinCorner = 0
      let transposed = 0
      let inLayers = 0
      let yaws = 0
      let sameYaw = 0
      for (const d of world.regions) {
        const nvm = nvms.get(d.region.id)!
        const w = d.terrain.textures
        for (let tz = 0; tz < 96; tz++) {
          for (let tx = 0; tx < 96; tx++) {
            const id = nvm.tileTextures![tz * 96 + tx]!
            tiles++
            const corners = [w[tz * 97 + tx]!, w[tz * 97 + tx + 1]!, w[(tz + 1) * 97 + tx]!, w[(tz + 1) * 97 + tx + 1]!]
            if (corners.some(c => (c & 0x3ff) === id)) atCorner++
            if ((corners[0]! & 0x3ff) === id) atMinCorner++
            if ((w[tx * 97 + tz]! & 0x3ff) === id) transposed++
            for (let k = 0; k < d.terrain.layerCount; k++) {
              const o = ((k * 96 + tz) * 96 + tx) * 4
              if (d.terrain.layers[o + 3] && (d.terrain.layers[o]! | ((d.terrain.layers[o + 1]! & 3) << 8)) === id) {
                inLayers++
                break
              }
            }
          }
        }
        for (const o of nvm.objects) {
          const p = byKey.get(o.regionId * 0x10000 + o.localUid)
          if (!p) continue
          yaws++
          if (p.yaw === o.yaw) sameYaw++
        }
      }
      console.log(`.nvm tile textures (${tiles} tiles): at one of the tile's corners in our texture grid ${pct(atCorner / tiles)}, ` +
        `at its (min x, min z) corner ${pct(atMinCorner / tiles)} (transposed grid ${pct(transposed / tiles)}), drawn by one of the cell's layer planes ` +
        `${pct(inLayers / tiles)}; .nvm object yaw == placement yaw for ${sameYaw}/${yaws}`)
      expect(atCorner).toBe(tiles)
      expect(inLayers).toBe(tiles)
      expect(atMinCorner / tiles).toBeGreaterThan(0.85)
      expect(transposed / tiles).toBeLessThan(0.5)
      expect(yaws).toBeGreaterThan(300)
      expect(sameYaw).toBe(yaws)
    })

    /** Object navmesh outline edge `e` of a placement, in glTF metres (collision BMS via space.ts, then `matrix`). */
    const edgeWorld = (nav: BmsNavMesh, matrix: number[], e: number): [Vec3, Vec3] => {
      const vs = nav.outlineEdges.vertices
      const at = (i: number) => transformPoint(matrix, ...toGltfPosition([nav.vertices[i * 3]!, nav.vertices[i * 3 + 1]!, nav.vertices[i * 3 + 2]!]))
      return [at(vs[e * 2]!), at(vs[e * 2 + 1]!)]
    }
    const gap = (a: [Vec3, Vec3], b: [Vec3, Vec3]) => {
      const d = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[2] - q[2])
      return Math.min(Math.max(d(a[0], b[0]), d(a[1], b[1])), Math.max(d(a[0], b[1]), d(a[1], b[0])))
    }

    it('joins linked object navmeshes edge to edge with the converted transforms (Jangan output and world-wide rule)', () => {
      const jangan: Record<string, number[]> = {}
      for (const nvm of nvms.values()) {
        for (const o of nvm.objects) {
          for (const l of o.links) {
            if (l.linkedObject < 0) continue
            const q = nvm.objects[l.linkedObject]!
            const pa = byKey.get(o.regionId * 0x10000 + o.localUid)
            const pb = byKey.get(q.regionId * 0x10000 + q.localUid)
            const na = navOf(o.objId)
            const nb = navOf(q.objId)
            if (!pa || !pb || !na || !nb) continue
            for (const v of [PLACEMENT_VARIANTS[0]!, PLACEMENT_VARIANTS[1]!, PLACEMENT_VARIANTS[4]!]) {
              ;(jangan[v.name] ??= []).push(gap(edgeWorld(na, v.matrix(pa), l.edge), edgeWorld(nb, v.matrix(pb), l.linkedObjectEdge)))
            }
          }
        }
      }
      // every .nvm of the client, placed with the converter's own functions (objects.ts placementRotation, space.ts)
      const data = openArchive('Data')
      const world2: Record<string, number[]> = { converted: [], yawNegated: [] }
      for (let z = 0; z < 128; z++) {
        for (let x = 0; x < 256; x++) {
          const path = `navmesh/nv_${((z << 8) | x).toString(16).padStart(4, '0')}.nvm`
          if (!data.has(path)) continue
          const nvm = parseNvm(data.read(path))
          for (const o of nvm.objects) {
            for (const l of o.links) {
              if (l.linkedObject < 0) continue
              const q = nvm.objects[l.linkedObject]!
              const na = navOf(o.objId)
              const nb = navOf(q.objId)
              if (!na || !nb) continue
              for (const [name, sign] of [['converted', 1], ['yawNegated', -1]] as const) {
                const m = (ob: typeof o) => composeTR(toGltfPosition(ob.position), placementRotation(sign * ob.yaw))
                world2[name]!.push(gap(edgeWorld(na, m(o), l.edge), edgeWorld(nb, m(q), l.linkedObjectEdge)))
              }
            }
          }
        }
      }
      const fmt = (g: number[]) => `n ${g.length}, median ${quantile(g, 0.5).toFixed(3)} m, max ${Math.max(...g).toFixed(2)} m, > 1 m: ${g.filter(x => x > 1).length}`
      console.log(`object navmesh links, gap between the two linked edges:\n  Jangan output: ${Object.entries(jangan).map(([k, g]) => `${k} ${fmt(g)}`).join('; ')}\n` +
        `  world-wide (converter rule): ${Object.entries(world2).map(([k, g]) => `${k} ${fmt(g)}`).join('; ')}`)
      expect(jangan.converted!.length).toBeGreaterThan(0)
      expect(Math.max(...jangan.converted!)).toBeLessThan(0.5)
      expect(quantile(jangan.yawNegated!, 0.5)).toBeGreaterThan(1)
      expect(Math.min(...jangan.yawPlusPi!)).toBeGreaterThan(1)
      expect(share(world2.converted!, x => x < 0.5)).toBeGreaterThan(0.95)
      expect(share(world2.yawNegated!, x => x > 1)).toBeGreaterThan(0.2)
    })

    it('keeps every object navmesh inside the .nvm terrain cells that list the object', () => {
      const lines: string[] = []
      const results: Record<string, { objects: number; inside: number }> = {}
      for (const v of [PLACEMENT_VARIANTS[0]!, PLACEMENT_VARIANTS[1]!, PLACEMENT_VARIANTS[4]!]) {
        let objects = 0
        let inside = 0
        let verts = 0
        let ok = 0
        for (const r of world.manifest.regions) {
          const nvm = nvms.get(r.id)!
          nvm.objects.forEach((o, index) => {
            const p = byKey.get(o.regionId * 0x10000 + o.localUid)
            const nav = navOf(o.objId)
            if (!p || !nav) return
            const m = v.matrix(p)
            let n = 0
            let good = 0
            for (let i = 0; i < nav.vertices.length; i += 3) {
              const [x, , z] = transformPoint(m, ...toGltfPosition([nav.vertices[i]!, nav.vertices[i + 1]!, nav.vertices[i + 2]!]))
              const lx = (x - r.origin[0]) * 10
              const lz = (r.origin[2] - z) * 10
              if (lx < 0 || lx > 1920 || lz < 0 || lz > 1920) continue
              n++
              if (nvm.cells.some(c => lx >= c.minX - 0.5 && lx <= c.maxX + 0.5 && lz >= c.minZ - 0.5 && lz <= c.maxZ + 0.5 && c.objects.includes(index))) good++
            }
            if (!n) return
            objects++
            verts += n
            ok += good
            if (good === n) inside++
          })
        }
        results[v.name] = { objects, inside }
        lines.push(`${v.name}: ${inside}/${objects} objects fully inside, ${ok}/${verts} vertices`)
      }
      console.log(`object navmesh vertices vs the .nvm cells listing the object: ${lines.join('; ')}`)
      expect(results.converted!.objects).toBeGreaterThan(300)
      expect(results.converted!.inside).toBe(results.converted!.objects)
      expect(results.yawNegated!.inside).toBeLessThan(results.yawNegated!.objects)
      expect(results.yawPlusPi!.inside).toBeLessThan(results.yawPlusPi!.objects)
    })

    it('draws each building\'s glb over its own collision navmesh (not mirrored)', () => {
      const data = openArchive('Data')
      const tally = { converted: 0, mirrored: 0, tie: 0 }
      const losses: string[] = []
      for (const m of world.manifest.models) {
        if (m.kind !== 'static' || !m.glb || !m.source.toLowerCase().endsWith('.bsr')) continue
        const path = parseBsr(data.read(m.source)).collision.meshPath
        if (!path || !data.has(path)) continue
        const nav = parseBms(data.read(path)).navMesh
        if (!nav || nav.cells.length < 3) continue
        const geom = models.get(m.index)!
        // footprint of the glb in its own model space
        const [x0, , z0] = m.boundsMin
        const [x1, , z1] = m.boundsMax
        const px = Math.max(0.1, Math.max(x1 - x0, z1 - z0) / 200)
        const fp = new TopDown(Math.ceil((x1 - x0) / px) + 8, Math.ceil((z1 - z0) / px) + 8, x0 - 4 * px, z0 - 4 * px, px)
        drawFootprint(fp, geom)
        const inside = (x: number, z: number) => {
          const c = Math.floor((x - fp.x0) / px)
          const r = Math.floor((z - fp.z0) / px)
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const cc = c + dc
              const rr = r + dr
              if (cc >= 0 && rr >= 0 && cc < fp.width && rr < fp.height && fp.owner[rr * fp.width + cc] === 0) return true
            }
          }
          return false
        }
        // nav cell centroids (interior points of the walkable/collision surface), as converted and mirrored
        const cent: Vec3[] = []
        for (let c = 0; c + 2 < nav.cells.length; c += 3) {
          const p = [0, 0, 0]
          for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) p[a]! += nav.vertices[nav.cells[c + k]! * 3 + a]! / 3
          cent.push(toGltfPosition(p as Vec3))
        }
        const score = (sx: number, sz: number) => cent.filter(([x, , z]) => inside(sx * x, sz * z)).length / cent.length
        const s = score(1, 1)
        const alt = Math.max(score(-1, 1), score(1, -1))
        if (Math.abs(s - alt) < 0.02) tally.tie++
        else if (s > alt) tally.converted++
        else {
          tally.mirrored++
          losses.push(`${m.source} ${s.toFixed(2)}/${alt.toFixed(2)}`)
        }
      }
      console.log(`collision navmesh inside the glb footprint: converted better ${tally.converted}, a mirrored reading better ${tally.mirrored} ` +
        `(${losses.join(', ')}), indistinguishable ${tally.tie}`)
      expect(tally.converted).toBeGreaterThan(4 * tally.mirrored)
    })

    it('is metric: 1920-unit (192 m) regions in every cross-file offset, a 1.8 m character, doors taller than it', () => {
      // .nvm lists neighbour-owned objects relative to ITS region; the .o2 relative to the owner: the offsets must be
      // exact multiples of the region size, in file units and in the manifest's metres.
      const offsets = new Map<string, number>()
      let checked = 0
      for (const [id, nvm] of nvms) {
        const rx = id & 0xff
        const rz = id >> 8
        for (const o of nvm.objects) {
          const p = byKey.get(o.regionId * 0x10000 + o.localUid)
          if (!p || o.regionId === id) continue
          const ox = o.regionId & 0xff
          const oz = o.regionId >> 8
          const origin = world.manifest.regions.find(r => r.id === id)!.origin
          const nvmWorld = toGltfPosition(o.position)
          const dx = p.position[0] - (origin[0] + nvmWorld[0])
          const dz = p.position[2] - (origin[2] + nvmWorld[2])
          expect(Math.abs(dx)).toBeLessThan(1e-3)
          expect(Math.abs(dz)).toBeLessThan(1e-3)
          const key = `${ox - rx},${oz - rz}`
          offsets.set(key, (offsets.get(key) ?? 0) + 1)
          checked++
        }
      }
      const spacing = new Set<number>()
      for (const a of world.manifest.regions) {
        for (const b of world.manifest.regions) {
          if (b.x === a.x + 1 && b.z === a.z) spacing.add(b.origin[0] - a.origin[0])
          if (b.z === a.z + 1 && b.x === a.x) spacing.add(a.origin[2] - b.origin[2])
        }
      }
      const { sidecar } = convertResource('res/char/china/chinaman_adventurer.bsr', { read: p => openArchive('Data').read(p) })
      const height = sidecar.stats.boundsMax[1] - sidecar.stats.boundsMin[1]
      console.log(`metric: ${checked} neighbour-owned .nvm objects land on their placement (< 1 mm) across region offsets ${JSON.stringify(Object.fromEntries(offsets))}; ` +
        `region spacing ${[...spacing].join(', ')} m (manifest regionSizeM ${size()}); chinaman_adventurer ${height.toFixed(2)} m tall`)
      expect(checked).toBeGreaterThan(10)
      expect([...spacing]).toEqual([192])
      expect(size()).toBe(192)
      expect(height).toBeGreaterThan(1.7)
      expect(height).toBeLessThan(1.9)
    })

    it('leaves a character\'s height of headroom under doors and gates', () => {
      const data = openArchive('Data')
      const lines: string[] = []
      const medians: number[] = []
      for (const m of world.manifest.models) {
        if (m.kind !== 'static' || !m.glb || !/door|gate|^.*[\\/]cj_[nsew]\.bsr$/i.test(m.source)) continue
        const path = parseBsr(data.read(m.source)).collision.meshPath
        if (!path || !data.has(path)) continue
        const nav = parseBms(data.read(path)).navMesh
        if (!nav) continue
        const geom = models.get(m.index)!
        const clear: number[] = []
        for (let c = 0; c + 2 < nav.cells.length; c += 3) {
          const p = [0, 0, 0]
          for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) p[a]! += nav.vertices[nav.cells[c + k]! * 3 + a]! / 3
          const [px, py, pz] = toGltfPosition(p as Vec3)
          let lowest = Infinity
          for (const prim of geom.primitives) {
            const P = prim.positions
            for (let t = 0; t + 2 < prim.indices.length; t += 3) {
              const [a, b, d] = [prim.indices[t]! * 3, prim.indices[t + 1]! * 3, prim.indices[t + 2]! * 3]
              const area = (P[b]! - P[a]!) * (P[d + 2]! - P[a + 2]!) - (P[b + 2]! - P[a + 2]!) * (P[d]! - P[a]!)
              if (Math.abs(area) < 1e-9) continue
              const w1 = ((px - P[a]!) * (P[d + 2]! - P[a + 2]!) - (pz - P[a + 2]!) * (P[d]! - P[a]!)) / area
              const w2 = ((P[b]! - P[a]!) * (pz - P[a + 2]!) - (P[b + 2]! - P[a + 2]!) * (px - P[a]!)) / area
              if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue
              const y = (1 - w1 - w2) * P[a + 1]! + w1 * P[b + 1]! + w2 * P[d + 1]!
              if (y > py + 0.3 && y < lowest) lowest = y
            }
          }
          if (Number.isFinite(lowest)) clear.push(lowest - py)
        }
        if (!clear.length) continue
        medians.push(quantile(clear, 0.5))
        lines.push(`${m.source.split(/[\\/]/).pop()} ${quantile(clear, 0.5).toFixed(1)} m (${clear.length} covered cells)`)
      }
      console.log(`median headroom over covered navmesh cells (character 1.8 m): ${lines.join(', ')}`)
      expect(medians.length).toBeGreaterThan(5)
      expect(share(medians, x => x > 1.8 && x < 40)).toBeGreaterThan(0.8)
    })
  })

  // --- 6. a third-party port's converted Jangan data (read-only) ------------------------------------------------------

  describe.skipIf(!hasPort)('against a third-party port\'s converted Jangan zone (read-only)', () => {
    it('has the same heights (x1.5 units) on the same grid, and the same object positions and rotations', () => {
      // heights.bin: u32 magic 'MMHF', u16 version, i32 originX, originZ, u32 cell, cols, rows @32 i32 heights * 0.01
      // in the port's units; its world unit is 0.15 file units per unit: x = 0.15 (1920 rx + lx) - 38880,
      // z = 0.15 (1920 rz + lz) - 26496 (its server's db.js), so origin (5760, -864) is region (155, 89), 3 = 20 units.
      const buf = readFileSync(join(PORT, 'heights.bin'))
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      const [ox, oz, cell, cols, rows] = [dv.getInt32(8, true), dv.getInt32(12, true), dv.getUint32(16, true), dv.getUint32(20, true), dv.getUint32(24, true)]
      expect(buf.length).toBe(32 + (cols + 1) * (rows + 1) * 4)
      const rx0 = (ox + 38880) / 288
      const rz0 = (oz + 26496) / 288
      expect([cell, rx0, rz0]).toEqual([3, 155, 89])
      const H = (c: number, r: number) => dv.getInt32(32 + (r * (cols + 1) + c) * 4, true) * 0.01
      let maxRes = 0
      let flipped = 0
      let n = 0
      for (const d of world.regions) {
        for (let gz = 0; gz <= 96; gz++) {
          for (let gx = 0; gx <= 96; gx++) {
            const c = (d.region.x - rx0) * 96 + gx
            const r = (d.region.z - rz0) * 96 + gz
            maxRes = Math.max(maxRes, Math.abs(H(c, r) - 1.5 * d.terrain.heights[gz * 97 + gx]!))
            flipped += Math.abs(H(c, (d.region.z - rz0) * 96 + 96 - gz) - 1.5 * d.terrain.heights[gz * 97 + gx]!)
            n++
          }
        }
      }
      // statics.json: {modelKey, x, z, rotY, scale [0.15 x3], yOffset?} in the port's frame (left-handed Babylon, +Z north,
      // models loaded through the glTF loader's (1, 1, -1) root): our glTF (x, z) -> (1.5 x + 9504, 1440 - 1.5 z)
      const statics = JSON.parse(readFileSync(join(PORT, 'statics.json'), 'utf8')) as Array<{ modelKey: string; x: number; z: number; rotY: number; yOffset?: number }>
      const grid = new Map<string, typeof statics>()
      for (const s of statics) {
        const k = `${Math.floor(s.x)},${Math.floor(s.z)}`
        if (!grid.has(k)) grid.set(k, [])
        grid.get(k)!.push(s)
      }
      const wrap = (a: number) => Math.abs(Math.atan2(Math.sin(a), Math.cos(a)))
      let matched = 0
      let sameName = 0
      let rotOk = 0
      let rotNegOk = 0
      const yOurSplit: number[] = []
      const yAntiSplit: number[] = []
      const anti = (h: ArrayLike<number>, lx: number, lz: number) => {
        const gx = Math.min(96, Math.max(0, lx / 20))
        const gz = Math.min(96, Math.max(0, lz / 20))
        const ix = Math.min(Math.floor(gx), 95)
        const iz = Math.min(Math.floor(gz), 95)
        const fx = gx - ix
        const fz = gz - iz
        const [h00, h10, h01, h11] = [h[iz * 97 + ix]!, h[iz * 97 + ix + 1]!, h[(iz + 1) * 97 + ix]!, h[(iz + 1) * 97 + ix + 1]!]
        return fx + fz <= 1 ? h00 + (h10 - h00) * fx + (h01 - h00) * fz : h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz)
      }
      for (const p of world.manifest.placements) {
        const x = 1.5 * p.position[0] + 9504
        const z = 1440 - 1.5 * p.position[2]
        const near = [-1, 0, 1].flatMap(dx => [-1, 0, 1].flatMap(dz => grid.get(`${Math.floor(x) + dx},${Math.floor(z) + dz}`) ?? []))
        const s = near.find(q => Math.hypot(q.x - x, q.z - z) < 0.05)
        if (!s) continue
        matched++
        const stem = p.source.toLowerCase().split(/[\\/]/).pop()!.replace(/\.(bsr|cpd)$/, '')
        if (s.modelKey.toLowerCase().includes(stem)) sameName++
        // predicted: their R(rotY) diag(-1, 1, 1) = diag(1, 1, -1) R(yaw)  =>  rotY = pi - yaw
        if (wrap(s.rotY - (Math.PI - p.yaw)) < 0.01) rotOk++
        if (wrap(s.rotY - (Math.PI + p.yaw)) < 0.01) rotNegOk++
        const hit = world.locate(p.position[0], p.position[2])
        if (s.yOffset !== undefined && hit) {
          yOurSplit.push(Math.abs(s.yOffset / 1.5 - (p.position[1] - terrainHeightAt(hit.data.terrain.heights, hit.lx, hit.lz))))
          yAntiSplit.push(Math.abs(s.yOffset / 1.5 - (p.position[1] - anti(hit.data.terrain.heights, hit.lx, hit.lz))))
        }
      }
      console.log(`third-party port: heights = 1.5 x ours on ${n} grid points, max residual ${maxRes.toFixed(4)} (rows flipped: mean |diff| ${(flipped / n).toFixed(2)}); ` +
        `${matched}/${world.manifest.placements.length} placements match a port static within 3.3 cm (${sameName} same model name), ` +
        `rotY = pi - yaw for ${rotOk} (pi + yaw: ${rotNegOk}); port yOffset vs our y - terrain: median |diff| ${quantile(yOurSplit, 0.5).toFixed(3)} m, ` +
        `p90 ${quantile(yOurSplit, 0.9).toFixed(3)} m on our cell split, ${quantile(yAntiSplit, 0.5).toFixed(3)} / ${quantile(yAntiSplit, 0.9).toFixed(3)} m on the port's ` +
        '(other-diagonal) split')
      expect(maxRes).toBeLessThan(0.006)
      expect(flipped / n).toBeGreaterThan(1)
      expect(matched).toBeGreaterThan(500)
      expect(sameName).toBe(matched)
      expect(rotOk).toBe(matched)
      expect(rotNegOk).toBeLessThan(matched)
    })
  })
})

/** Draws one model at identity into `view` with owner 0 (its top-down footprint). */
function drawFootprint(view: TopDown, geom: ModelGeometry): void {
  for (const prim of geom.primitives) {
    for (let t = 0; t + 2 < prim.indices.length; t += 3) {
      const at = (i: number): Vec3 => [prim.positions[i * 3]!, prim.positions[i * 3 + 1]!, prim.positions[i * 3 + 2]!]
      view.triangle(at(prim.indices[t]!), at(prim.indices[t + 1]!), at(prim.indices[t + 2]!), () => [255, 255, 255], 0)
    }
  }
}

