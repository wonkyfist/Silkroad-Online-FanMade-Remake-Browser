import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BinaryReader, NVM_EDGE_FLAG, NVM_HEIGHTS, NVM_REGION_SIZE, NVM_TILES, NVM_TILE_BLOCKED, NVM_TILE_SIZE,
  nvmCellAt, nvmHeightAt, nvmTerrainHeightAt, parseNvm, type NvmCell, type NvmFile, type Pk2Archive,
} from '@sro/formats'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))

/** Files that may fail to parse, with the reason. None in vSRO 1.188. */
const PARSE_ALLOWLIST = new Map<string, string>()

/**
 * Regions whose Map .m terrain is a different surface from the navmesh height map in every orientation:
 * the .m is flat (1468 or 0) or unrelated while the navmesh has relief. All in the unused area x 35..49,
 * z 35..39.
 */
const HEIGHT_ALLOWLIST = new Map(
  [0x2323, 0x2325, 0x2327, 0x2423, 0x2426, 0x2427, 0x2428, 0x2531, 0x2631, 0x2731].map(id => [
    id,
    'Map .m and navmesh hold different terrain (stale data in an unused area)',
  ]),
)

const JANGAN_CENTRE = 0x61a8
const N = NVM_HEIGHTS - 1
const hex = (n: number) => n.toString(16).padStart(4, '0')
const inc = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1)
const sortedHist = <K>(m: Map<K, number>) => [...m].sort((a, b) => b[1] - a[1])
const regionX = (id: number) => id & 0xff
const regionZ = (id: number) => id >> 8

interface Corpus {
  archive: Pk2Archive
  map: Pk2Archive
  regions: Map<number, NvmFile>
  failures: Array<[string, string]>
}

let corpus: Corpus | undefined

function load(): Corpus {
  if (corpus) return corpus
  const archive = openArchive('Data')
  const map = openArchive('Map')
  const regions = new Map<number, NvmFile>()
  const failures: Array<[string, string]> = []
  for (const [key, entry] of archive.files) {
    const m = /^navmesh\/nv_([0-9a-f]{4})\.nvm$/.exec(key)
    if (!m) continue
    try {
      regions.set(parseInt(m[1]!, 16), parseNvm(archive.read(entry)))
    } catch (e) {
      failures.push([key, (e as Error).message])
    }
  }
  corpus = { archive, map, regions, failures }
  return corpus
}

/**
 * Crude .m reader for the cross-check (the terrain parser lives in mapm.ts): 36 blocks bz outer, bx inner;
 * per block u32 flag, u16 env, 17 x 17 (f32 height, u16 texture, u8 brightness) vz outer, i8 water type,
 * u8 wave, f32 water height, 16 x 16 u16 tile flags, 28 bytes of bounds and reserved.
 */
interface Terrain {
  /** 97 x 97 in (bz * 16 + vz) * 97 + bx * 16 + vx order. */
  heights: Float32Array
  textureIds: Uint16Array
  waterTypes: Int8Array
  waterHeights: Float32Array
  /** 96 x 96 in (bz * 16 + tz) * 96 + bx * 16 + tx order. */
  tileFlags: Uint16Array
}

function readTerrain(bytes: Uint8Array): Terrain | undefined {
  if (bytes.length !== 12 + 36 * 2575) return undefined
  const r = new BinaryReader(bytes, 12)
  const t: Terrain = {
    heights: new Float32Array(97 * 97),
    textureIds: new Uint16Array(97 * 97),
    waterTypes: new Int8Array(36),
    waterHeights: new Float32Array(36),
    tileFlags: new Uint16Array(96 * 96),
  }
  for (let bz = 0; bz < 6; bz++) {
    for (let bx = 0; bx < 6; bx++) {
      r.skip(6)
      for (let vz = 0; vz < 17; vz++) {
        for (let vx = 0; vx < 17; vx++) {
          const i = (bz * 16 + vz) * 97 + bx * 16 + vx
          t.heights[i] = r.f32()
          t.textureIds[i] = r.u16() & 0x3ff
          r.skip(1)
        }
      }
      t.waterTypes[bz * 6 + bx] = (r.u8() << 24) >> 24
      r.skip(1)
      t.waterHeights[bz * 6 + bx] = r.f32()
      for (let tz = 0; tz < 16; tz++) for (let tx = 0; tx < 16; tx++) t.tileFlags[(bz * 16 + tz) * 96 + bx * 16 + tx] = r.u16()
      r.skip(28)
    }
  }
  return t
}

function terrainOf(id: number): Terrain | undefined {
  const { map } = load()
  const path = `${regionZ(id)}/${regionX(id)}.m`
  return map.has(path) ? readTerrain(map.read(path)) : undefined
}

/** Crude .o2 reader: 36 blocks x 4 LoD groups x (u16 n, n x 30-byte instance). */
interface O2Instance {
  objId: number
  position: [number, number, number]
  type: number
  yaw: number
  localUid: number
  unknownShort0: number
  isBig: boolean
  isStruct: boolean
  regionId: number
}

function readO2(bytes: Uint8Array): O2Instance[] | undefined {
  const r = new BinaryReader(bytes, 12)
  const out: O2Instance[] = []
  for (let g = 0; g < 36 * 4; g++) {
    const n = r.u16()
    for (let i = 0; i < n; i++) {
      out.push({
        objId: r.u32(), position: [r.f32(), r.f32(), r.f32()], type: r.i16(), yaw: r.f32(), localUid: r.u16(),
        unknownShort0: r.u16(), isBig: r.u8() !== 0, isStruct: r.u8() !== 0, regionId: r.u16(),
      })
    }
  }
  return r.remaining === 0 ? out : undefined
}

/** The eight symmetries of the square grid, as (row, col) -> index into a 97 x 97 row-major array. */
const ORIENTATIONS: Record<string, (r: number, c: number) => number> = {
  identity: (r, c) => r * 97 + c,
  transpose: (r, c) => c * 97 + r,
  flipRows: (r, c) => (N - r) * 97 + c,
  flipCols: (r, c) => r * 97 + (N - c),
  rotate180: (r, c) => (N - r) * 97 + (N - c),
  rotate90: (r, c) => (N - c) * 97 + r,
  rotate270: (r, c) => c * 97 + (N - r),
  antiTranspose: (r, c) => (N - c) * 97 + (N - r),
}

/** Sides of a cell a segment lies on (0 north = maxZ, 1 east = maxX, 2 south = minZ, 3 west = minX). */
function sidesOf(c: NvmCell, ax: number, az: number, bx: number, bz: number): number[] {
  const sides: number[] = []
  const inX = ax >= c.minX && bx <= c.maxX
  const inZ = az >= c.minZ && bz <= c.maxZ
  if (az === c.maxZ && bz === c.maxZ && inX) sides.push(0)
  if (ax === c.maxX && bx === c.maxX && inZ) sides.push(1)
  if (az === c.minZ && bz === c.minZ && inX) sides.push(2)
  if (ax === c.minX && bx === c.minX && inZ) sides.push(3)
  return sides
}

/** Offset of the neighbour's origin across each side. */
const SIDE_OFFSET = [
  [0, NVM_REGION_SIZE],
  [NVM_REGION_SIZE, 0],
  [0, -NVM_REGION_SIZE],
  [-NVM_REGION_SIZE, 0],
] as const

describe.skipIf(!hasConfig)('NVM corpus (vSRO 1.188 Data.pk2 navmesh/)', () => {
  it('parses every nv_*.nvm without exceptions (allowlist aside)', () => {
    const { regions, failures } = load()
    const unexpected = failures.filter(([key]) => !PARSE_ALLOWLIST.has(key))
    const variants = new Map<string, number>()
    const legacyIds: number[] = []
    let objects = 0
    let cells = 0
    let globalEdges = 0
    let internalEdges = 0
    for (const [id, nvm] of regions) {
      inc(variants, `tiles ${nvm.tileRecordSize} B, ${nvm.planeTypes ? 'with' : 'without'} plane map`)
      if (nvm.tileRecordSize === 4) legacyIds.push(id)
      expect(nvm.signature).toBe('JMXVNVM 1000')
      objects += nvm.objects.length
      cells += nvm.cells.length
      globalEdges += nvm.globalEdges.length
      internalEdges += nvm.internalEdges.length
    }
    legacyIds.sort((a, b) => a - b)
    console.log(
      `NVM: ${regions.size} files parsed, ${failures.length} failed; ${objects} objects, ${cells} cells, ` +
        `${globalEdges} global + ${internalEdges} internal edges;`,
      Object.fromEntries(variants),
      `legacy ids ${hex(legacyIds[0]!)}..${hex(legacyIds.at(-1)!)}`,
    )
    if (unexpected.length) console.log('unexpected failures', unexpected.slice(0, 20))
    expect(unexpected).toEqual([])
    expect(regions.size + failures.length).toBe(5040)
    expect(Object.fromEntries(variants)).toEqual({
      'tiles 8 B, with plane map': 4939,
      'tiles 4 B, with plane map': 41,
      'tiles 4 B, without plane map': 60,
    })
    // Legacy records are u16 cell + u16 flag, not zero padding: they hold real cell indices.
    const legacyCells = legacyIds.map(id => Math.max(...regions.get(id)!.tileCells))
    expect(Math.max(...legacyCells)).toBeGreaterThan(0)
  })

  it('cells partition the region, agree with the tile map, and open = not blocked', () => {
    const bad: string[] = []
    const cellCounts: number[] = []
    let blockedTiles = 0
    let tiles = 0
    let cellObjectRefs = 0
    for (const [id, nvm] of load().regions) {
      const where = `nv_${hex(id)}`
      cellCounts.push(nvm.cells.length)
      // Rasterize the rectangles: every tile covered exactly once, by the cell the tile map names.
      const cover = new Int32Array(NVM_TILES * NVM_TILES).fill(-1)
      nvm.cells.forEach((c, i) => {
        cellObjectRefs += c.objects.length
        const coords = [c.minX, c.minZ, c.maxX, c.maxZ]
        if (!coords.every(v => v >= 0 && v <= NVM_REGION_SIZE && v % NVM_TILE_SIZE === 0) || c.minX >= c.maxX || c.minZ >= c.maxZ) {
          bad.push(`${where} cell ${i}: rectangle ${coords.join(' ')}`)
          return
        }
        for (let tz = c.minZ / NVM_TILE_SIZE; tz < c.maxZ / NVM_TILE_SIZE; tz++) {
          for (let tx = c.minX / NVM_TILE_SIZE; tx < c.maxX / NVM_TILE_SIZE; tx++) {
            const t = tz * NVM_TILES + tx
            if (cover[t] !== -1) bad.push(`${where} tile ${tx},${tz}: cells ${cover[t]} and ${i} overlap`)
            cover[t] = i
          }
        }
      })
      for (let t = 0; t < cover.length; t++) {
        const cell = nvm.tileCells[t]!
        if (cover[t] !== cell) {
          bad.push(`${where} tile ${t % NVM_TILES},${Math.floor(t / NVM_TILES)}: tile map says ${cell}, rectangles say ${cover[t]}`)
          break
        }
        const blocked = (nvm.tileFlags[t]! & NVM_TILE_BLOCKED) !== 0
        if (blocked !== cell >= nvm.openCellCount) bad.push(`${where} tile ${t}: blocked=${blocked} but cell ${cell}/${nvm.openCellCount}`)
        if (blocked) blockedTiles++
        tiles++
      }
      // nvmCellAt agrees with the rectangles at tile centres and at a region corner.
      for (const [x, z] of [[10, 10], [955, 1333], [1910, 1910], [NVM_REGION_SIZE, NVM_REGION_SIZE]] as const) {
        const i = nvmCellAt(nvm, x, z)
        const c = nvm.cells[i]
        if (!c || x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) bad.push(`${where}: nvmCellAt(${x}, ${z}) = ${i}`)
      }
    }
    cellCounts.sort((a, b) => a - b)
    console.log(
      `NVM cells: ${cellCounts.length} regions, cells per region min ${cellCounts[0]} median ${cellCounts[cellCounts.length >> 1]} ` +
        `max ${cellCounts.at(-1)}; ${blockedTiles}/${tiles} tiles blocked (all in closed cells); ${cellObjectRefs} cell->object refs`,
    )
    expect(bad.slice(0, 20)).toEqual([])
  })

  it('edges lie on the sides their directions name; blocked edges face the void', () => {
    const { regions } = load()
    const bad: string[] = []
    const internalFlags = new Map<number, number>()
    const globalFlags = new Map<number, number>()
    const internalShape = new Map<string, number>()
    for (const [id, nvm] of regions) {
      const where = `nv_${hex(id)}`
      const check = (kind: string, i: number, e: NvmFile['internalEdges'][number]) => {
        const at = `${where} ${kind} ${i}`
        if (!(e.ax <= e.bx && e.az <= e.bz) || (e.ax !== e.bx && e.az !== e.bz) || (e.ax === e.bx && e.az === e.bz)) {
          bad.push(`${at}: not an axis-aligned min/max segment ${e.ax},${e.az} ${e.bx},${e.bz}`)
        }
        const c0 = nvm.cells[e.cells[0]]
        if (!c0) bad.push(`${at}: cells[0] ${e.cells[0]} out of range`)
        else if (!sidesOf(c0, e.ax, e.az, e.bx, e.bz).includes(e.directions[0])) bad.push(`${at}: not on side ${e.directions[0]} of cell ${e.cells[0]}`)
      }
      nvm.internalEdges.forEach((e, i) => {
        check('internal', i, e)
        inc(internalFlags, e.flag)
        const blocked = (e.flag & NVM_EDGE_FLAG.blocked) !== 0
        inc(internalShape, `flag ${e.flag} cells[1] ${e.cells[1] === -1 ? '-1' : 'cell'} directions[1] ${e.directions[1] === -1 ? '-1' : 'side'}`)
        const voidSide = e.cells[1] === -1
        if (blocked !== voidSide || voidSide !== (e.directions[1] === -1)) {
          bad.push(`${where} internal ${i}: flag ${e.flag} cells ${e.cells} dirs ${e.directions}`)
        }
        if (e.cells[1] !== -1) {
          const c1 = nvm.cells[e.cells[1]]
          if (!c1) bad.push(`${where} internal ${i}: cells[1] ${e.cells[1]} out of range`)
          else if (!sidesOf(c1, e.ax, e.az, e.bx, e.bz).includes(e.directions[1])) {
            bad.push(`${where} internal ${i}: not on side ${e.directions[1]} of cell ${e.cells[1]}`)
          }
        }
      })
      nvm.globalEdges.forEach((e, i) => {
        check('global', i, e)
        inc(globalFlags, e.flag)
        if (e.regions[0] !== id) bad.push(`${where} global ${i}: regions[0] ${hex(e.regions[0])}`)
        const S = NVM_REGION_SIZE
        const onBorder = [e.az === S && e.bz === S, e.ax === S && e.bx === S, e.az === 0 && e.bz === 0, e.ax === 0 && e.bx === 0]
        if (!onBorder[e.directions[0]]) bad.push(`${where} global ${i}: side ${e.directions[0]} but at ${e.ax},${e.az} ${e.bx},${e.bz}`)
      })
    }
    console.log('NVM internal edge flags:', Object.fromEntries(internalFlags), '| global edge flags:', Object.fromEntries(globalFlags))
    console.log('NVM internal edge shapes:', Object.fromEntries(sortedHist(internalShape)))
    expect(bad.slice(0, 20)).toEqual([])
    expect([...internalFlags.keys()].sort()).toEqual([NVM_EDGE_FLAG.blockSrc2Dst, NVM_EDGE_FLAG.internal])
    expect([...globalFlags.keys()]).toEqual([NVM_EDGE_FLAG.global])
  })

  it('every global edge has its mirror image in the neighbour file (legacy files aside)', () => {
    const { regions } = load()
    const result = new Map<string, number>()
    const oddNeighbour = new Map<string, number>()
    const oddZ: number[] = []
    for (const [id, nvm] of regions) {
      const legacy = nvm.tileRecordSize === 4
      for (const e of nvm.globalEdges) {
        const side = e.directions[0]
        const other = regions.get(e.regions[1])
        const [dx, dz] = SIDE_OFFSET[side]!
        const mirror = other?.globalEdges.find(
          f =>
            f.regions[1] === id && f.cells[0] === e.cells[1] && f.cells[1] === e.cells[0] &&
            f.directions[0] === e.directions[1] && f.directions[1] === e.directions[0] && f.flag === e.flag &&
            f.ax + dx === e.ax && f.az + dz === e.az && f.bx + dx === e.bx && f.bz + dz === e.bz,
        )
        const c1 = other?.cells[e.cells[1]]
        const onNeighbourSide = c1 !== undefined && sidesOf(c1, e.ax - dx, e.az - dz, e.bx - dx, e.bz - dz).includes(e.directions[1])
        inc(result, `${legacy ? 'legacy' : 'modern'}: mirrored=${!!mirror} onNeighbourCell=${onNeighbourSide}`)
        if (!legacy) {
          const expected = id + [0x100, 1, -0x100, -1][side]!
          if (e.regions[1] !== expected) {
            inc(oddNeighbour, `side ${side}: neighbour = id ${e.regions[1] - id > 0 ? '+' : '-'} 0x${Math.abs(e.regions[1] - id).toString(16)}`)
            oddZ.push(regionZ(id))
          }
        }
      }
    }
    console.log('NVM global edge mirrors:', Object.fromEntries(result))
    console.log(
      'NVM neighbours not at id +- 1 / 0x100:', Object.fromEntries(oddNeighbour),
      `(regions z ${Math.min(...oddZ)}..${Math.max(...oddZ)})`,
    )
    expect(result.get('modern: mirrored=false onNeighbourCell=true') ?? 0).toBe(0)
    expect(result.get('modern: mirrored=false onNeighbourCell=false') ?? 0).toBe(0)
    expect(result.get('modern: mirrored=true onNeighbourCell=true')).toBe(151596)
    // Legacy files (unused regions) point at neighbours that do not point back.
    expect(result.get('legacy: mirrored=false onNeighbourCell=false')! + (result.get('legacy: mirrored=false onNeighbourCell=true') ?? 0)).toBe(255)
    // In the z 17..47 band the north neighbour is id + 0x80 (heights continue there: see the border test).
    expect([...oddNeighbour.keys()].sort()).toEqual(['side 0: neighbour = id + 0x80', 'side 2: neighbour = id - 0x80'])
    expect([Math.min(...oddZ), Math.max(...oddZ)]).toEqual([17, 47])
  })

  it('objects: links in range, positions relative to this region, same records as the .o2', () => {
    const { regions, map } = load()
    const bad: string[] = []
    const hist = new Map<string, number>()
    const types = new Map<number, number>()
    for (const [id, nvm] of regions) {
      const where = `nv_${hex(id)}`
      const path = `${regionZ(id)}/${regionX(id)}.o2`
      const o2 = map.has(path) ? readO2(map.read(path)) : undefined
      nvm.objects.forEach((o, i) => {
        inc(types, o.type)
        for (const l of o.links) if (l.linkedObject < -1 || l.linkedObject >= nvm.objects.length) bad.push(`${where} object ${i}: link ${l.linkedObject}`)
        const [x, , z] = o.position
        const inside = x >= 0 && x <= NVM_REGION_SIZE && z >= 0 && z <= NVM_REGION_SIZE
        const owned = o.regionId === id
        inc(hist, `${owned ? 'owned' : 'foreign'} ${inside ? 'inside' : 'outside'} the region`)
        if (!o2) return
        const twin = o2.find(p => p.localUid === o.localUid && p.regionId === o.regionId && p.objId === o.objId)
        if (!twin) {
          inc(hist, `${owned ? 'owned' : 'foreign'}: not in .o2`)
          return
        }
        const d = [0, 1, 2].map(k => o.position[k]! - twin.position[k]!)
        const sameFields = twin.yaw === o.yaw && twin.type === o.type && twin.unknownShort0 === o.unknownShort0 && twin.isBig === o.isBig && twin.isStruct === o.isStruct
        // f32 positions in two frames: allow float noise on the whole-region offset.
        const wholeRegions = (v: number) => Math.abs(v - Math.round(v / NVM_REGION_SIZE) * NVM_REGION_SIZE) < 0.01
        const offset = owned ? 'same position' : d[1] === 0 && wholeRegions(d[0]!) && wholeRegions(d[2]!) ? 'offset by whole regions' : 'other'
        inc(hist, `${owned ? 'owned' : 'foreign'} in .o2: ${owned && d.some(v => v !== 0) ? 'moved' : offset}, other fields ${sameFields ? 'equal' : 'differ'}`)
      })
    }
    console.log('NVM objects:', Object.fromEntries(sortedHist(hist)))
    console.log('NVM object type field:', sortedHist(types).slice(0, 6).map(([k, n]) => `${k}x${n}`).join(' '), `... (${types.size} values)`)
    expect(bad.slice(0, 20)).toEqual([])
    expect(hist.get('owned outside the region') ?? 0).toBe(0)
    expect(hist.get('foreign inside the region') ?? 0).toBe(0)
    expect(hist.get('owned in .o2: moved, other fields equal') ?? 0).toBe(0)
    expect([...hist.keys()].filter(k => k.includes('differ') || k.includes('other,'))).toEqual([])
    expect(hist.get('owned in .o2: same position, other fields equal')).toBeGreaterThan(17000)
  })

  it('height map equals the .m terrain grid; the orientation is pinned', () => {
    const { regions } = load()
    const stats = Object.fromEntries(Object.keys(ORIENTATIONS).map(k => [k, { max: 0, sum: 0, n: 0, exact: 0 }]))
    const mismatched: string[] = []
    let compared = 0
    let onlyIdentity = 0
    let noTerrain = 0
    const tileAgreement = { identity: 0, transpose: 0, blockedKept: 0, blockedLost: 0, blockedAdded: 0, tiles: 0 }
    const textureCorner = { minCorner: 0, anyCorner: 0, tiles: 0 }
    const water = new Map<string, number>()
    for (const [id, nvm] of regions) {
      const terrain = terrainOf(id)
      if (!terrain) {
        noTerrain++
        continue
      }
      if (HEIGHT_ALLOWLIST.has(id)) continue
      compared++
      const exact: string[] = []
      for (const [name, index] of Object.entries(ORIENTATIONS)) {
        const s = stats[name]!
        let max = 0
        for (let r = 0; r <= N; r++) {
          for (let c = 0; c <= N; c++) {
            const d = Math.abs(nvm.heights[r * 97 + c]! - terrain.heights[index(r, c)]!)
            if (d > max) max = d
            s.sum += d
          }
        }
        s.n += 97 * 97
        s.max = Math.max(s.max, max)
        if (max === 0) {
          s.exact++
          exact.push(name)
        }
      }
      if (!exact.includes('identity')) mismatched.push(`nv_${hex(id)}`)
      if (exact.length === 1 && exact[0] === 'identity') onlyIdentity++
      // Tile flags: nvm = .m flags, plus bit 0 where the generator blocked the tile.
      for (let t = 0; t < 96 * 96; t++) {
        const tz = Math.floor(t / 96)
        const tx = t % 96
        const nf = nvm.tileFlags[t]!
        const mf = terrain.tileFlags[t]!
        if ((nf & ~1) === (mf & ~1)) tileAgreement.identity++
        if ((nf & ~1) === (terrain.tileFlags[tx * 96 + tz]! & ~1)) tileAgreement.transpose++
        if (mf & 1) tileAgreement[nf & 1 ? 'blockedKept' : 'blockedLost']++
        else if (nf & 1) tileAgreement.blockedAdded++
        tileAgreement.tiles++
        if (nvm.tileTextures) {
          const tex = nvm.tileTextures[t]!
          const corners = [tz * 97 + tx, tz * 97 + tx + 1, (tz + 1) * 97 + tx, (tz + 1) * 97 + tx + 1].map(i => terrain.textureIds[i])
          if (tex === corners[0]) textureCorner.minCorner++
          if (corners.includes(tex)) textureCorner.anyCorner++
          textureCorner.tiles++
        }
      }
      if (nvm.planeTypes && nvm.planeHeights) {
        for (let p = 0; p < 36; p++) {
          inc(water, `nvm type ${nvm.planeTypes[p]} / .m water ${terrain.waterTypes[p]}`)
          inc(water, `height ${nvm.planeHeights[p] === terrain.waterHeights[p] ? 'equal' : 'differs'}`)
          const q = (p % 6) * 6 + Math.floor(p / 6)
          inc(water, `transposed height ${nvm.planeHeights[p] === terrain.waterHeights[q] ? 'equal' : 'differs'}`)
          // Plane-grid orientation, where it is observable: blocks whose .m water type differs from the
          // transposed block's. The plane type follows the .m type (-1 -> 0, 0 -> 1, 1 -> 2 or 3).
          if (terrain.waterTypes[p] !== terrain.waterTypes[q]) {
            const t = nvm.planeTypes[p]!
            const follows = (w: number) => (w === -1 ? t === 0 : w === 0 ? t === 1 : t >= 2)
            inc(water, `asymmetric: follows .m ${follows(terrain.waterTypes[p]!)}`)
            inc(water, `asymmetric: follows transposed .m ${follows(terrain.waterTypes[q]!)}`)
          }
        }
      }
    }
    const lines = Object.entries(stats).map(
      ([k, s]) => `  ${k.padEnd(13)} max ${s.max.toFixed(3).padStart(9)} mean ${(s.sum / s.n).toFixed(4).padStart(9)} exact in ${s.exact} regions`,
    )
    const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(2)}%`
    console.log(
      `NVM heights vs Map .m: ${compared} regions compared (${noTerrain} navmeshes without a .m, ${HEIGHT_ALLOWLIST.size} allowlisted); ` +
        `identity is the only exact orientation in ${onlyIdentity} (the rest are symmetric or flat)\n${lines.join('\n')}`,
    )
    console.log(
      `NVM tile flags vs .m (bits above 0): identity ${pct(tileAgreement.identity, tileAgreement.tiles)}, transposed ${pct(tileAgreement.transpose, tileAgreement.tiles)}; ` +
        `.m blocked kept ${tileAgreement.blockedKept}, lost ${tileAgreement.blockedLost}, added by the navmesh ${tileAgreement.blockedAdded}; ` +
        `texture = .m vertex texture at the min corner ${pct(textureCorner.minCorner, textureCorner.tiles)}, ` +
        `at one of the 4 corners ${textureCorner.anyCorner}/${textureCorner.tiles}`,
    )
    console.log('NVM planes vs .m water:', Object.fromEntries(sortedHist(water)))
    expect(mismatched).toEqual([])
    expect(stats.identity!.max).toBe(0)
    expect(stats.identity!.exact).toBe(compared)
    expect(compared).toBe(3300)
    for (const [k, s] of Object.entries(stats)) if (k !== 'identity') expect(s.sum / s.n).toBeGreaterThan(50)
    expect(tileAgreement.identity).toBe(tileAgreement.tiles)
    expect(tileAgreement.transpose).toBeLessThan(tileAgreement.tiles)
    expect(tileAgreement.blockedLost).toBe(0)
    expect(textureCorner.anyCorner).toBe(textureCorner.tiles)
    expect(water.get('height equal')).toBe(36 * compared)
    expect(water.get('height equal')!).toBeGreaterThan(water.get('transposed height equal')!)
    const follows = water.get('asymmetric: follows .m true')!
    const followsT = water.get('asymmetric: follows transposed .m true') ?? 0
    expect(follows).toBeGreaterThan(3 * followsT)
    expect(follows / (follows + water.get('asymmetric: follows .m false')!)).toBeGreaterThan(0.7)
  })

  it('height map continues across the borders the global edges name, in z-major order only', () => {
    const { regions } = load()
    const result = new Map<string, number>()
    const h = (n: NvmFile, x: number, z: number) => n.heights[z * NVM_HEIGHTS + x]!
    for (const [, a] of regions) {
      if (a.tileRecordSize === 4) continue
      const neighbours = new Map<number, number>()
      for (const e of a.globalEdges) if (e.directions[0] === 0 || e.directions[0] === 1) neighbours.set(e.directions[0], e.regions[1])
      for (const [side, bid] of neighbours) {
        const b = regions.get(bid)
        if (!b || b.tileRecordSize === 4) continue
        let zMajor = 0
        let xMajor = 0
        for (let k = 0; k <= N; k++) {
          // z-major: the north border is row z = 96 (a) / z = 0 (b); the east border is column x = 96 / x = 0.
          const zm = side === 0 ? h(a, k, N) - h(b, k, 0) : h(a, N, k) - h(b, 0, k)
          const xm = side === 0 ? h(a, N, k) - h(b, 0, k) : h(a, k, N) - h(b, k, 0)
          zMajor = Math.max(zMajor, Math.abs(zm))
          xMajor = Math.max(xMajor, Math.abs(xm))
        }
        inc(result, `z-major ${zMajor === 0 ? 'exact' : 'differs'}, x-major ${xMajor === 0 ? 'exact' : 'differs'}`)
      }
    }
    console.log('NVM border continuity (north/east neighbour pairs):', Object.fromEntries(sortedHist(result)))
    const total = [...result.values()].reduce((a, b) => a + b, 0)
    expect(result.get('z-major differs, x-major exact') ?? 0).toBe(0)
    expect((result.get('z-major exact, x-major differs') ?? 0) / total).toBeGreaterThan(0.9)
    expect(((result.get('z-major exact, x-major differs') ?? 0) + (result.get('z-major exact, x-major exact') ?? 0)) / total).toBeGreaterThan(0.99)
  })

  it('static objects stand on the terrain under the z-major reading', () => {
    const offsets: number[] = []
    const transposed: number[] = []
    for (const [id, nvm] of load().regions) {
      for (const o of nvm.objects) {
        if (o.regionId !== id || o.type !== -1) continue
        const [x, y, z] = o.position
        offsets.push(Math.abs(y - nvmTerrainHeightAt(nvm, x, z)))
        transposed.push(Math.abs(y - nvmTerrainHeightAt(nvm, z, x)))
      }
    }
    offsets.sort((a, b) => a - b)
    transposed.sort((a, b) => a - b)
    const q = (a: number[], p: number) => a[Math.floor(p * (a.length - 1))]!
    console.log(
      `NVM |object y - terrain| over ${offsets.length} owned static objects: z-major median ${q(offsets, 0.5).toFixed(2)} ` +
        `(p25 ${q(offsets, 0.25).toFixed(2)}), transposed median ${q(transposed, 0.5).toFixed(2)} (p25 ${q(transposed, 0.25).toFixed(2)})`,
    )
    expect(q(offsets, 0.5)).toBeLessThan(5)
    expect(q(transposed, 0.5)).toBeGreaterThan(4 * q(offsets, 0.5))
  })

  it('the terrain surface is two triangles per tile, split min corner to max corner (placed objects sit on it)', () => {
    // Independent ground truth: the world editor snapped many placements exactly onto the rendered ground.
    // Compare them with the three candidate surfaces where the two possible splits differ noticeably.
    const { regions, map } = load()
    const H = (h: Float32Array, x: number, z: number) => h[z * NVM_HEIGHTS + x]!
    const counts = { compared: 0, library: 0, bilinear: 0, otherSplit: 0 }
    for (const [id, nvm] of regions) {
      const path = `${regionZ(id)}/${regionX(id)}.o2`
      const o2 = map.has(path) ? readO2(map.read(path)) : undefined
      if (!o2) continue
      const seen = new Set<number>()
      for (const p of o2) {
        if (p.regionId !== id || seen.has(p.localUid)) continue
        seen.add(p.localUid)
        const [x, y, z] = p.position
        if (!(x > 0 && z > 0 && x < NVM_REGION_SIZE && z < NVM_REGION_SIZE)) continue
        const ix = Math.floor(x / NVM_TILE_SIZE)
        const iz = Math.floor(z / NVM_TILE_SIZE)
        const fx = x / NVM_TILE_SIZE - ix
        const fz = z / NVM_TILE_SIZE - iz
        const h00 = H(nvm.heights, ix, iz)
        const h10 = H(nvm.heights, ix + 1, iz)
        const h01 = H(nvm.heights, ix, iz + 1)
        const h11 = H(nvm.heights, ix + 1, iz + 1)
        const library = nvmTerrainHeightAt(nvm, x, z)
        const bilinear = (h00 + (h10 - h00) * fx) * (1 - fz) + (h01 + (h11 - h01) * fx) * fz
        const otherSplit = fx + fz <= 1 ? h00 + (h10 - h00) * fx + (h01 - h00) * fz : h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz)
        if (Math.abs(library - otherSplit) < 0.5) continue
        counts.compared++
        if (Math.abs(y - library) < 0.02) counts.library++
        if (Math.abs(y - bilinear) < 0.02) counts.bilinear++
        if (Math.abs(y - otherSplit) < 0.02) counts.otherSplit++
      }
    }
    console.log('NVM owned .o2 placements exactly (|dy| < 0.02) on each candidate terrain surface:', counts)
    expect(counts.compared).toBeGreaterThan(3000)
    expect(counts.library).toBeGreaterThan(600)
    expect(counts.library).toBeGreaterThan(50 * Math.max(1, counts.bilinear, counts.otherSplit))
  })

  it('summarizes Jangan (regions x 167..169, z 96..98; centre nv_61a8)', () => {
    const { regions } = load()
    const lines: string[] = []
    for (let z = 98; z >= 96; z--) {
      for (let x = 167; x <= 169; x++) {
        const id = (z << 8) | x
        const nvm = regions.get(id)!
        const owned = nvm.objects.filter(o => o.regionId === id).length
        const blocked = nvm.tileFlags.reduce((n, f) => n + (f & NVM_TILE_BLOCKED), 0)
        const hs = [...nvm.heights]
        const planes = new Map<number, number>()
        for (const t of nvm.planeTypes ?? []) inc(planes, t)
        const terrain = terrainOf(id)
        const dh = terrain ? Math.max(...hs.map((v, i) => Math.abs(v - terrain.heights[i]!))) : NaN
        lines.push(
          `  nv_${hex(id)} (${x},${z}): ${nvm.objects.length} objects (${owned} owned), ${nvm.cells.length} cells (${nvm.openCellCount} open), ` +
            `${nvm.globalEdges.length} global + ${nvm.internalEdges.length} internal edges, ${blocked} blocked tiles, ` +
            `heights ${Math.min(...hs).toFixed(1)}..${Math.max(...hs).toFixed(1)} (max |nvm - .m| ${dh}), planes ${JSON.stringify(Object.fromEntries(planes))}`,
        )
        expect(dh).toBe(0)
      }
    }
    const c = regions.get(JANGAN_CENTRE)!
    const flags = new Map<string, number>()
    for (const e of c.internalEdges) inc(flags, `internal ${e.flag}`)
    for (const e of c.globalEdges) inc(flags, `global ${e.flag} -> ${hex(e.regions[1])}`)
    const owners = new Map<string, number>()
    for (const o of c.objects) inc(owners, hex(o.regionId))
    const centre = nvmCellAt(c, 960, 960)
    const big = c.objects.filter(o => o.isBig).map(o => o.objId)
    const linked = c.objects.filter(o => o.links.length).length
    lines.push(
      `  nv_61a8 detail: owners ${JSON.stringify(Object.fromEntries(owners))}; big objects (objId) ${big.join(',')}; ${linked} with links; ` +
        `edges ${JSON.stringify(Object.fromEntries(flags))}; centre (960, 960): cell ${centre} ` +
        `${centre < c.openCellCount ? 'open' : 'closed'} ${JSON.stringify(c.cells[centre])}, height ${nvmHeightAt(c, 960, 960).toFixed(2)}`,
    )
    console.log(`NVM Jangan:\n${lines.join('\n')}`)
    expect(c.objects.length).toBe(62)
    expect([c.cells.length, c.openCellCount, c.globalEdges.length]).toEqual([73, 71, 43])
  })
})
