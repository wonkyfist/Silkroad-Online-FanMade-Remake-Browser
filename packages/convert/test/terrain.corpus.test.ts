import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assembleRegionGrid,
  decodeDds,
  decodeMapTLightmap,
  ENV_GRAPHS,
  isRegionActive,
  listActiveRegions,
  listEnvLeaves,
  parseDdj,
  parseEnvironment,
  parseMapM,
  parseMapT,
  parseMfo,
  parseTile2d,
  readDdsHeader,
  regionId,
  type EnvironmentFile,
  type MapMFile,
  type MfoFile,
  type RegionGrid,
  type Tile2dFile,
} from '@sro/formats'
import { loadConfig, openArchive, REPO_ROOT } from '../src/node-io.ts'

const HAS_CONFIG = existsSync(join(REPO_ROOT, 'sro.config.json'))

/**
 * .m files that do not parse, as Map.pk2 path -> reason. These five sit at the world's corner (x 0..2, z 0..1),
 * are not active in mapinfo.mfo (so the client never loads them) and use an older block layout: 136,128 or
 * 137,128 bytes instead of 92,712, apparently with 11-byte vertices.
 */
const MAPM_ALLOWLIST = new Map([
  ['0/0.m', 'legacy layout, 137,128 bytes, inactive region'],
  ['0/1.m', 'legacy layout, 136,128 bytes, inactive region'],
  ['0/2.m', 'legacy layout, 137,128 bytes, inactive region'],
  ['1/0.m', 'legacy layout, 136,128 bytes, inactive region'],
  ['1/1.m', 'legacy layout, 136,128 bytes, inactive region'],
])

/**
 * Regions whose duplicated block-edge vertices disagree, as "x,z" -> number of conflicting vertices. Everywhere
 * else the copies are bit-identical. The navmesh height map of the active ones holds the later block's value.
 */
const BLOCK_SEAM_ALLOWLIST = new Map([
  ['146,98', 4], // active: a 4-vertex step of up to 13.9 units between blocks (1,4) and (2,4)
  ['191,114', 1], // active: a single 610-unit spike on the block (1,5)/(2,5) edge
  ['192,114', 1], // active: the same spike's neighbour, 616 units
  ['73,94', 47], // inactive (not in mapinfo.mfo)
  ['73,95', 128], // inactive
])

/**
 * Adjacent active region pairs whose shared region edge differs: real cliffs and seams in the data (the list is
 * in the report). All other 5,500-odd active pairs share bit-identical edge vertices.
 */
const EXPECTED_ACTIVE_SEAMS = 66

const TILE2D_PATH = 'tile2d.ifo'

type Edge = 'W' | 'E' | 'S' | 'N'
const EDGES: Edge[] = ['W', 'E', 'S', 'N']

/** Region-edge vertex rows: W = gx 0, E = gx 96, S = gz 0, N = gz 96, each ordered by the other coordinate. */
function regionEdges(grid: RegionGrid): Record<Edge, Float32Array> {
  const W = new Float32Array(97)
  const E = new Float32Array(97)
  const S = new Float32Array(97)
  const N = new Float32Array(97)
  for (let i = 0; i < 97; i++) {
    W[i] = grid.heights[i * 97]!
    E[i] = grid.heights[i * 97 + 96]!
    S[i] = grid.heights[i]!
    N[i] = grid.heights[96 * 97 + i]!
  }
  return { W, E, S, N }
}

const sameEdge = (a: Float32Array, b: Float32Array, reversed: boolean) => {
  for (let i = 0; i < 97; i++) if (a[i] !== b[reversed ? 96 - i : i]) return false
  return true
}
const flatEdge = (a: Float32Array) => a.every(v => v === a[0])

/**
 * Tail of a JMXVNVM 1000 navmesh, read directly (SilkroadDoc JMXVNVM: 96 x 96 tiles of {i32 cell, u16 flag,
 * u16 tile2d id}, 97 x 97 f32 heights, 6 x 6 u8 plane types, 6 x 6 f32 plane heights, then EOF). This is the
 * server-side copy of the terrain, written by Joymax's own tools, so it serves as independent ground truth.
 */
function readNvmTail(bytes: Uint8Array) {
  const sig = new TextDecoder('latin1').decode(bytes.subarray(0, 12))
  if (sig !== 'JMXVNVM 1000') throw new Error(`nvm signature ${JSON.stringify(sig)}`)
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const planeHeights = bytes.length - 36 * 4
  const planeTypes = planeHeights - 36
  const heights = planeTypes - 97 * 97 * 4
  const tiles = heights - 96 * 96 * 8
  // Head (SilkroadDoc JMXVNVM): u16 objects {30 bytes, u16 links, links x 6 bytes}, i32 cellCount, i32 openCount,
  // cells {f32 minX, minZ, maxX, maxZ, u8 n, n x u16}, i32 global edges x 27 bytes, i32 internal edges x 23 bytes.
  // Walking it must land exactly on the tile map, which checks the tail offsets above as well.
  let o = 12
  const objectCount = v.getUint16(o, true)
  o += 2
  for (let i = 0; i < objectCount; i++) o += 32 + v.getUint16(o + 30, true) * 6
  const cellCount = v.getInt32(o, true)
  o += 8
  const cells = new Float32Array(cellCount * 4)
  for (let i = 0; i < cellCount; i++) {
    for (let k = 0; k < 4; k++) cells[i * 4 + k] = v.getFloat32(o + k * 4, true)
    o += 17 + bytes[o + 16]! * 2
  }
  o += 4 + v.getInt32(o, true) * 27
  o += 4 + v.getInt32(o, true) * 23
  if (o !== tiles) throw new Error(`nvm head ends at ${o}, tile map starts at ${tiles}`)
  return {
    height: (g: number) => v.getFloat32(heights + g * 4, true),
    tileCell: (t: number) => v.getInt32(tiles + t * 8, true),
    tileFlag: (t: number) => v.getUint16(tiles + t * 8 + 4, true),
    tileTexture: (t: number) => v.getUint16(tiles + t * 8 + 6, true),
    planeType: (b: number) => bytes[planeTypes + b]!,
    planeHeight: (b: number) => v.getFloat32(planeHeights + b * 4, true),
    cellCount,
    /** [minX, minZ, maxX, maxZ] of a cell, region-local file units. */
    cell: (i: number) => cells.subarray(i * 4, i * 4 + 4),
  }
}

/**
 * Object placements of a Map/<z>/<x>.o2 (JMXVMAPO1001, read directly: 36 blocks x 4 groups of u16 count +
 * 30-byte records {u32 objId, f32 x, y, z, i16, f32 yaw, i16 uid, i16, u8 isBig, u8 isStruct, u16 regionId}).
 * Positions are region-local file units, written by Joymax's editor on top of the terrain: independent ground
 * truth for where a height-grid vertex sits.
 */
function readO2(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let o = 12
  const out: Array<{ x: number; y: number; z: number; regionId: number }> = []
  for (let g = 0; g < 36 * 4; g++) {
    const n = v.getUint16(o, true)
    o += 2
    for (let i = 0; i < n; i++, o += 30) {
      out.push({ x: v.getFloat32(o + 4, true), y: v.getFloat32(o + 8, true), z: v.getFloat32(o + 12, true), regionId: v.getUint16(o + 28, true) })
    }
  }
  if (o !== bytes.length) throw new Error(`o2 records end at ${o}, file is ${bytes.length} bytes`)
  return out
}

/** Bilinear terrain height at fractional grid coordinates. */
function gridHeightAt(heights: Float32Array, gx: number, gz: number) {
  const x0 = Math.min(95, Math.max(0, Math.floor(gx)))
  const z0 = Math.min(95, Math.max(0, Math.floor(gz)))
  const fx = gx - x0
  const fz = gz - z0
  const h = (x: number, z: number) => heights[z * 97 + x]!
  return (h(x0, z0) * (1 - fx) + h(x0 + 1, z0) * fx) * (1 - fz) + (h(x0, z0 + 1) * (1 - fx) + h(x0 + 1, z0 + 1) * fx) * fz
}

/** Candidate maps from a region-local object position (x, z) to height-grid coordinates (gx, gz). */
const LOCAL_TO_GRID: Record<string, (x: number, z: number) => [number, number]> = {
  'gx = x/20, gz = z/20': (x, z) => [x / 20, z / 20],
  'gx = 96 - x/20 (x mirrored)': (x, z) => [96 - x / 20, z / 20],
  'gz = 96 - z/20 (z mirrored)': (x, z) => [x / 20, 96 - z / 20],
  'gx = z/20, gz = x/20 (transposed)': (x, z) => [z / 20, x / 20],
}

/** Maps normalized grid coordinates (u = gx, v = gz) to normalized image coordinates (x right, y down). */
const ORIENTATIONS: Record<string, (u: number, v: number) => [number, number]> = {
  'gx right, gz down': (u, v) => [u, v],
  'gx right, gz up': (u, v) => [u, 1 - v],
  'gx left, gz down': (u, v) => [1 - u, v],
  'gx left, gz up': (u, v) => [1 - u, 1 - v],
  'gx down, gz right': (u, v) => [v, u],
  'gx up, gz right': (u, v) => [v, 1 - u],
  'gx down, gz left': (u, v) => [1 - v, u],
  'gx up, gz left': (u, v) => [1 - v, 1 - u],
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]!
    mb += b[i]!
  }
  ma /= n
  mb /= n
  let ab = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma
    const db = b[i]! - mb
    ab += da * db
    aa += da * da
    bb += db * db
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0
}

const sample = (img: { width: number; height: number; rgba: Uint8Array }, u: number, v: number, c: number) => {
  const x = Math.min(img.width - 1, Math.max(0, Math.floor(u * img.width)))
  const y = Math.min(img.height - 1, Math.max(0, Math.floor(v * img.height)))
  return img.rgba[(y * img.width + x) * 4 + c]!
}

const bump = (m: Record<string, number>, k: string | number, by = 1) => {
  m[k] = (m[k] ?? 0) + by
}
const sortedByCount = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]))
const round = (v: number, d = 3) => Number(v.toFixed(d))

interface RegionRecord {
  x: number
  z: number
  active: boolean
  edges: Record<Edge, Float32Array>
}

interface Corpus {
  mfo: MfoFile
  backupMfo: MfoFile
  tile2d: Tile2dFile
  env: EnvironmentFile
  regions: Map<string, RegionRecord>
  report: Record<string, unknown>
  failures: string[]
  allowlisted: string[]
  mapm: {
    files: number
    parsed: number
    heightMin: number
    heightMax: number
    heightMinAt: string
    heightMaxAt: string
    nonFinite: number
    deepRegions: string[]
    vertices: number
    unresolvedTextures: number
    rawResolves: number
    distinctIds: Set<number>
    distinctRaw: Set<number>
    maxId: number
    highBits: Record<string, number>
    envIds: Record<string, number>
    badEnv: string[]
    waterTypes: Record<string, number>
    waveTypes: Record<string, number>
    blockFlags: Record<string, number>
    culled: string[]
    unknown0: Record<string, number>
    unknownNonZeroTail: number
    footerBelowVertexMax: number
    footerAboveVertexMin: number
    blocks: number
    seams: Record<string, number>
    /** Block-edge disagreements if vertices were stored vx-outer (first 200 regions): the order is not a guess. */
    transposedSeams: { regions: number; vertices: number }
  }
  mapt: {
    files: number
    parsed: number
    sizeMismatch: string[]
    formats: Record<string, number>
    textureTypes: Record<string, number>
    lightLevels: Record<string, number>
    payloadMismatch: string[]
  }
  mWithoutT: string[]
  tWithoutM: string[]
  nvm: {
    regions: number
    missing: string[]
    heightEqual: number
    heightDiffer: string[]
    transposedEqual: number
    tileFlagEqual: number
    tileFlagSuperset: number
    tileFlagViolations: number
    tileFlagTransposedEqual: number
    tiles: number
    textureCorner: Record<string, number>
    textureInCorners: number
    textureInCornersTransposed: number
    planeAgree: number
    planeTotal: number
    planeCombos: Record<string, number>
    /** .m water blocks the navmesh has no plane for, whose water is not entirely below the block's terrain. */
    hiddenWaterViolations: string[]
    /** Tiles whose navmesh cell rectangle contains the tile centre (20 tx + 10, 20 tz + 10), and transposed. */
    tileInCell: number
    tileInCellTransposed: number
  }
  objects: {
    regions: number
    placements: number
    /** Placements within 1 unit of the bilinear terrain height, per LOCAL_TO_GRID hypothesis. */
    onTerrain: Record<string, number>
  }
}

let corpusCache: Corpus | undefined

function walk(): Corpus {
  if (corpusCache) return corpusCache
  const map = openArchive('Map')
  const data = openArchive('Data')
  const mfo = parseMfo(map.read('mapinfo.mfo'))
  const backupMfo = parseMfo(map.read('_mapinfo.mfo'))
  const tile2d = parseTile2d(map.read(TILE2D_PATH))
  const env = parseEnvironment(map.read('environment.ifo'))
  const failures: string[] = []
  const allowlisted: string[] = []
  const regions = new Map<string, RegionRecord>()
  const m: Corpus['mapm'] = {
    files: 0,
    parsed: 0,
    heightMin: Infinity,
    heightMax: -Infinity,
    heightMinAt: '',
    heightMaxAt: '',
    nonFinite: 0,
    deepRegions: [],
    vertices: 0,
    unresolvedTextures: 0,
    rawResolves: 0,
    distinctIds: new Set(),
    distinctRaw: new Set(),
    maxId: 0,
    highBits: {},
    envIds: {},
    badEnv: [],
    waterTypes: {},
    waveTypes: {},
    blockFlags: {},
    culled: [],
    unknown0: {},
    unknownNonZeroTail: 0,
    footerBelowVertexMax: 0,
    footerAboveVertexMin: 0,
    blocks: 0,
    seams: {},
    transposedSeams: { regions: 0, vertices: 0 },
  }
  const t: Corpus['mapt'] = {
    files: 0,
    parsed: 0,
    sizeMismatch: [],
    formats: {},
    textureTypes: {},
    lightLevels: {},
    payloadMismatch: [],
  }
  const nvm: Corpus['nvm'] = {
    regions: 0,
    missing: [],
    heightEqual: 0,
    heightDiffer: [],
    transposedEqual: 0,
    tileFlagEqual: 0,
    tileFlagSuperset: 0,
    tileFlagViolations: 0,
    tileFlagTransposedEqual: 0,
    tiles: 0,
    textureCorner: {},
    textureInCorners: 0,
    textureInCornersTransposed: 0,
    planeAgree: 0,
    planeTotal: 0,
    planeCombos: {},
    hiddenWaterViolations: [],
    tileInCell: 0,
    tileInCellTransposed: 0,
  }
  const objects: Corpus['objects'] = { regions: 0, placements: 0, onTerrain: {} }
  const mPaths = new Set<string>()
  const tPaths = new Set<string>()
  const regionPath = /^(\d+)\/(\d+)\.(m|t)$/

  for (const file of map.files.values()) {
    const match = regionPath.exec(file.path)
    if (!match) continue
    const z = Number(match[1])
    const x = Number(match[2])
    const key = `${x},${z}`
    const active = isRegionActive(mfo, x, z)
    if (match[3] === 't') {
      t.files++
      tPaths.add(key)
      try {
        const mt = parseMapT(map.read(file))
        const header = readDdsHeader(mt.dds)
        bump(t.formats, `${header.format} ${header.width}x${header.height} mips ${header.mipCount}`)
        bump(t.textureTypes, mt.textureType)
        if (mt.declaredSize !== mt.dds.length + 8) t.sizeMismatch.push(`${file.path} ${mt.declaredSize} vs ${mt.dds.length + 8}`)
        if (header.dataOffset + header.dataSize !== mt.dds.length) t.payloadMismatch.push(file.path)
        for (const level of mt.lightGrid) bump(t.lightLevels, level)
        t.parsed++
      } catch (e) {
        failures.push(`${file.path}: ${(e as Error).message}`)
      }
      continue
    }

    m.files++
    mPaths.add(key)
    let mapm: MapMFile
    try {
      mapm = parseMapM(map.read(file))
    } catch (e) {
      if (MAPM_ALLOWLIST.has(file.path)) allowlisted.push(`${file.path}: ${(e as Error).message}`)
      else failures.push(`${file.path}: ${(e as Error).message}`)
      continue
    }
    if (MAPM_ALLOWLIST.has(file.path)) failures.push(`${file.path}: parsed although allowlisted`)
    m.parsed++
    let deepest = Infinity
    for (const block of mapm.blocks) {
      m.blocks++
      let vmin = Infinity
      let vmax = -Infinity
      for (let i = 0; i < block.heights.length; i++) {
        const h = block.heights[i]!
        if (!Number.isFinite(h)) m.nonFinite++
        if (h < vmin) vmin = h
        if (h > vmax) vmax = h
        const id = block.textureIds[i]!
        m.vertices++
        m.distinctIds.add(id)
        m.distinctRaw.add(block.textures[i]!)
        if (id > m.maxId) m.maxId = id
        if (!tile2d.byId.has(id)) m.unresolvedTextures++
        if (tile2d.byId.has(block.textures[i]!)) m.rawResolves++
        bump(m.highBits, block.textureHighBits[i]!)
      }
      if (vmin < m.heightMin) {
        m.heightMin = vmin
        m.heightMinAt = `${key} block ${block.index}`
      }
      if (vmax > m.heightMax) {
        m.heightMax = vmax
        m.heightMaxAt = `${key} block ${block.index}`
      }
      deepest = Math.min(deepest, vmin)
      if (block.heightMax < vmax) m.footerBelowVertexMax++
      if (block.heightMin > vmin) m.footerAboveVertexMin++
      bump(m.envIds, block.environmentId)
      if (!env.byId.has(block.environmentId)) m.badEnv.push(`${key} block ${block.index}: ${block.environmentId}`)
      bump(m.waterTypes, block.waterType)
      bump(m.waveTypes, block.waterWaveType)
      bump(m.blockFlags, block.flag)
      if (block.flag !== 0) m.culled.push(`${key} block ${block.index} flag ${block.flag}`)
      bump(m.unknown0, `${block.unknown[0]} water ${block.waterType}`)
      if (block.unknown.subarray(1).some(b => b !== 0)) m.unknownNonZeroTail++
    }
    if (deepest < -5000) m.deepRegions.push(`${key} ${round(deepest, 1)}`)

    const grid = assembleRegionGrid(mapm)
    if (grid.edgeConflicts.length) m.seams[key] = grid.edgeConflicts.length
    if (m.transposedSeams.regions < 200) {
      m.transposedSeams.regions++
      for (const b of mapm.blocks) {
        // east edge (vx 16) of block (bx, bz) vs west edge (vx 0) of (bx + 1, bz), reading vertices as vx-outer
        if (b.bx === 5) continue
        const east = mapm.blocks[b.index + 1]!
        for (let k = 0; k < 17; k++) if (b.heights[16 * 17 + k] !== east.heights[k]) m.transposedSeams.vertices++
      }
    }
    regions.set(key, { x, z, active, edges: regionEdges(grid) })

    if (!active) continue
    const o2 = map.get(`${z}/${x}.o2`)
    if (o2) {
      objects.regions++
      const own = regionId(x, z)
      for (const p of readO2(map.read(o2))) {
        // only placements owned by this region and inside it (big objects spill into neighbours)
        if (p.regionId !== own || !(p.x >= 0 && p.x < 1920 && p.z >= 0 && p.z < 1920)) continue
        objects.placements++
        for (const [name, f] of Object.entries(LOCAL_TO_GRID)) {
          const [gx, gz] = f(p.x, p.z)
          if (Math.abs(gridHeightAt(grid.heights, gx, gz) - p.y) < 1) bump(objects.onTerrain, name)
        }
      }
    }
    const nvmPath = `navmesh/nv_${regionId(x, z).toString(16).padStart(4, '0')}.nvm`
    const nvmFile = data.get(nvmPath)
    if (!nvmFile) {
      nvm.missing.push(key)
      continue
    }
    const n = readNvmTail(data.read(nvmFile))
    nvm.regions++
    let differ = 0
    let transposed = 0
    for (let gz = 0; gz < 97; gz++) {
      for (let gx = 0; gx < 97; gx++) {
        const nh = n.height(gz * 97 + gx)
        if (nh !== grid.heights[gz * 97 + gx]) differ++
        if (nh === grid.heights[gx * 97 + gz]) transposed++
      }
    }
    if (differ === 0) nvm.heightEqual++
    else nvm.heightDiffer.push(`${key}: ${differ} vertices`)
    if (transposed === 97 * 97) nvm.transposedEqual++
    for (let tz = 0; tz < 96; tz++) {
      for (let tx = 0; tx < 96; tx++) {
        const i = tz * 96 + tx
        const nf = n.tileFlag(i)
        const mf = grid.tileFlags[i]!
        nvm.tiles++
        if (nf === mf) nvm.tileFlagEqual++
        // the navmesh may add the blocked bit, never remove one
        if ((nf | 1) === (mf | 1) && (mf & 1) <= (nf & 1)) nvm.tileFlagSuperset++
        else nvm.tileFlagViolations++
        if (nf === grid.tileFlags[tx * 96 + tz]) nvm.tileFlagTransposedEqual++
        const c = n.cell(n.tileCell(i))
        const cx = 20 * tx + 10
        const cz = 20 * tz + 10
        if (c.length === 4 && c[0]! <= cx && cx <= c[2]! && c[1]! <= cz && cz <= c[3]!) nvm.tileInCell++
        if (c.length === 4 && c[0]! <= cz && cz <= c[2]! && c[1]! <= cx && cx <= c[3]!) nvm.tileInCellTransposed++
        const nt = n.tileTexture(i)
        const corners = [
          grid.textureIds[tz * 97 + tx]!,
          grid.textureIds[tz * 97 + tx + 1]!,
          grid.textureIds[(tz + 1) * 97 + tx]!,
          grid.textureIds[(tz + 1) * 97 + tx + 1]!,
        ]
        const corner = corners.indexOf(nt)
        bump(nvm.textureCorner, ['(tx,tz)', '(tx+1,tz)', '(tx,tz+1)', '(tx+1,tz+1)'][corner] ?? 'none')
        if (corner >= 0) nvm.textureInCorners++
        const tcorners = [
          grid.textureIds[tx * 97 + tz]!,
          grid.textureIds[tx * 97 + tz + 1]!,
          grid.textureIds[(tx + 1) * 97 + tz]!,
          grid.textureIds[(tx + 1) * 97 + tz + 1]!,
        ]
        if (tcorners.includes(nt)) nvm.textureInCornersTransposed++
      }
    }
    for (const block of mapm.blocks) {
      const pt = n.planeType(block.index)
      const ph = n.planeHeight(block.index)
      const mWater = block.waterType >= 0
      const agree = (pt === 0 && !mWater) || (pt !== 0 && mWater && ph === block.waterHeight)
      nvm.planeTotal++
      if (agree) nvm.planeAgree++
      bump(nvm.planeCombos, `nvm ${pt} / m ${block.waterType}${pt !== 0 && mWater ? (ph === block.waterHeight ? ' same height' : ' other height') : ''}`)
      if (mWater && pt === 0) {
        // the navmesh drops water that lies wholly under the terrain (it still records the same plane height)
        let vmin = Infinity
        for (const h of block.heights) vmin = Math.min(vmin, h)
        if (!(block.waterHeight < vmin) || ph !== block.waterHeight) nvm.hiddenWaterViolations.push(`${key} block ${block.index}`)
      }
    }
  }

  const mWithoutT = [...mPaths].filter(k => !tPaths.has(k))
  const tWithoutM = [...tPaths].filter(k => !mPaths.has(k))
  corpusCache = { mfo, backupMfo, tile2d, env, regions, report: {}, failures, allowlisted, mapm: m, mapt: t, mWithoutT, tWithoutM, nvm, objects }
  return corpusCache
}

describe.skipIf(!HAS_CONFIG)('terrain corpus (vSRO 1.188)', () => {
  it('parses mapinfo.mfo, tile2d.ifo and environment.ifo', () => {
    const { mfo, backupMfo, tile2d, env } = walk()
    const map = openArchive('Map')
    expect([mfo.mapWidth, mfo.mapHeight]).toEqual([256, 128])
    expect(mfo.unknown).toEqual([0, 0, 0, 0])
    const active = listActiveRegions(mfo)
    expect(active.length).toBe(3300)
    expect(mfo.regionData.subarray(4096).every(b => b === 0)).toBe(true)
    // MSB-first bit order: every active region has terrain; LSB-first would point at regions without any
    for (const { x, z } of active) expect(map.has(`${z}/${x}.m`), `${x},${z}`).toBe(true)
    let lsbActive = 0
    let lsbWithTerrain = 0
    for (let id = 0; id < 0x8000; id++) {
      if (mfo.regionData[id >> 3]! & (1 << (id & 7))) {
        lsbActive++
        if (map.has(`${id >> 8}/${id & 0xff}.m`)) lsbWithTerrain++
      }
    }
    expect(lsbWithTerrain).toBeLessThan(lsbActive * 0.85)
    const backupActive = listActiveRegions(backupMfo)
    const backupOnly = backupActive.filter(r => !isRegionActive(mfo, r.x, r.z)).length
    const liveOnly = active.filter(r => !isRegionActive(backupMfo, r.x, r.z)).length

    expect(tile2d.declaredCount).toBe(603)
    expect(tile2d.entries.map(e => e.id)).toEqual(tile2d.entries.map((_, i) => i))
    for (const e of tile2d.entries) expect(map.has(e.path), e.path).toBe(true)

    expect(env.profiles.length).toBe(60)
    expect([...env.byId.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i))
    const leaves = listEnvLeaves(env)
    expect(leaves.map(l => l.profileId).sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i))
    const keyCounts: Record<string, number> = {}
    for (const p of env.profiles) {
      for (const [name, kind] of ENV_GRAPHS) {
        const keys = p[name] as Array<{ time: number; r?: number; g?: number; b?: number; value?: number }>
        bump(keyCounts, keys.length)
        expect(keys.length).toBeGreaterThanOrEqual(2)
        expect(keys[0]!.time).toBe(0)
        expect(keys[keys.length - 1]!.time).toBe(1)
        for (let i = 1; i < keys.length; i++) expect(keys[i]!.time).toBeGreaterThanOrEqual(keys[i - 1]!.time)
        for (const k of keys) {
          const values = kind === 'color' ? [k.r!, k.g!, k.b!] : [k.value!]
          for (const v of values) {
            expect(v).toBeGreaterThanOrEqual(kind === 'color' ? 0 : -1)
            expect(v).toBeLessThanOrEqual(1)
          }
        }
      }
    }
    console.log(
      JSON.stringify(
        {
          mfo: { active: active.length, lsbFirstActive: lsbActive, lsbFirstWithTerrain: lsbWithTerrain, backup_mapinfo: { active: backupActive.length, backupOnly, liveOnly } },
          tile2d: {
            records: tile2d.entries.length,
            types: sortedByCount(tile2d.entries.reduce<Record<string, number>>((m, e) => (bump(m, e.typeName ?? e.type), m), {})),
            withGrass: tile2d.entries.filter(e => e.grass.length).length,
          },
          environment: { profiles: env.profiles.length, leaves: leaves.length, graphKeyCounts: keyCounts },
        },
        null,
        2,
      ),
    )
  })

  it('parses every .m and .t in Map.pk2 with per-block invariants', () => {
    const c = walk()
    const { mapm: m, mapt: t } = c
    const report = {
      mapm: {
        files: m.files,
        parsed: m.parsed,
        blocks: m.blocks,
        heights: { min: m.heightMin, minAt: m.heightMinAt, max: m.heightMax, maxAt: m.heightMaxAt, nonFinite: m.nonFinite, deepRegions: m.deepRegions },
        textures: {
          vertices: m.vertices,
          resolvedWithLow10Bits: m.vertices - m.unresolvedTextures,
          resolvedPercent: round((100 * (m.vertices - m.unresolvedTextures)) / m.vertices, 4),
          resolvedWithRawU16Percent: round((100 * m.rawResolves) / m.vertices, 2),
          distinctIds: m.distinctIds.size,
          distinctRawWords: m.distinctRaw.size,
          maxId: m.maxId,
          highBits: m.highBits,
        },
        environmentIds: m.envIds,
        waterTypes: m.waterTypes,
        waveTypes: m.waveTypes,
        blockFlags: m.blockFlags,
        culled: m.culled,
        unknownByte0: m.unknown0,
        unknownBytes1to19NonZero: m.unknownNonZeroTail,
        footer: { heightMaxBelowVertexMax: m.footerBelowVertexMax, heightMinAboveVertexMin: m.footerAboveVertexMin },
        blockSeams: m.seams,
        transposedVertexOrderSeams: m.transposedSeams,
      },
      mapt: t,
      mWithoutT: c.mWithoutT,
      tWithoutM: c.tWithoutM,
      failures: c.failures,
      allowlisted: c.allowlisted,
    }
    c.report.corpus = report
    console.log(JSON.stringify(report, null, 2))

    expect(c.failures).toEqual([])
    expect(c.allowlisted.length).toBe(MAPM_ALLOWLIST.size)
    expect(m.files).toBe(3442)
    expect(m.parsed).toBe(3437)
    expect(t.files).toBe(3432)
    expect(t.parsed).toBe(3432)
    // heights: finite and within +-25,000 units (2.5 km); the one deep pit (to -21,589) is region (162,104)
    expect(m.nonFinite).toBe(0)
    expect(m.heightMin).toBeGreaterThan(-25_000)
    expect(m.heightMax).toBeLessThan(10_000)
    expect(m.deepRegions.map(r => r.split(' ')[0])).toEqual(['162,104'])
    // every texture id resolves with the 10-bit mask; bits 10..12 are never set
    expect(m.unresolvedTextures).toBe(0)
    expect(Object.keys(m.highBits).map(Number).every(h => (h & 7) === 0 && h <= 32)).toBe(true)
    expect(m.badEnv).toEqual([])
    expect(Object.keys(m.waterTypes).sort()).toEqual(['-1', '0', '1'])
    expect(Object.keys(m.waveTypes).every(w => Number(w) >= 0 && Number(w) <= 3)).toBe(true)
    expect(m.culled).toEqual(['168,97 block 14 flag 1', '168,97 block 15 flag 1'])
    expect(m.unknownNonZeroTail).toBe(0)
    // byte 0 of the unknown tail is only ever 1 on water blocks
    expect(Object.keys(m.unknown0).filter(k => k.startsWith('1 ') && k !== '1 water 0')).toEqual([])
    // block seams: duplicated edge vertices are identical except in the allowlisted regions
    expect(m.seams).toEqual(Object.fromEntries(BLOCK_SEAM_ALLOWLIST))
    expect(m.transposedSeams.vertices).toBeGreaterThan(m.transposedSeams.regions * 100)
    // .t: the size word counts itself and the type word (DDJ convention), one DXT1 512x512 mip everywhere
    expect(t.sizeMismatch).toEqual([])
    expect(t.payloadMismatch).toEqual([])
    expect(t.formats).toEqual({ 'DXT1 512x512 mips 1': 3432 })
    expect(t.textureTypes).toEqual({ 3: 3432 })
    expect(c.tWithoutM).toEqual([])
    // .m without .t: the 5 legacy files, (73,94), (73,95), (122,100), (122,101), (122,104); none is active
    expect(c.mWithoutT.length).toBe(10)
    expect(c.mWithoutT.filter(k => isRegionActive(c.mfo, ...(k.split(',').map(Number) as [number, number])))).toEqual([])
  })

  it('pins the axis orientation: region (x,z) east edge = (x+1,z) west edge, north edge = (x,z+1) south edge', () => {
    const { regions } = walk()
    const tally = { x: {} as Record<string, number>, z: {} as Record<string, number> }
    const pairs = { x: 0, z: 0 }
    const seams: string[] = []
    for (const r of regions.values()) {
      if (!r.active) continue
      for (const [axis, dx, dz] of [['x', 1, 0], ['z', 0, 1]] as const) {
        const s = regions.get(`${r.x + dx},${r.z + dz}`)
        if (!s?.active) continue
        const expected = axis === 'x' ? sameEdge(r.edges.E, s.edges.W, false) : sameEdge(r.edges.N, s.edges.S, false)
        if (!expected) seams.push(`${r.x},${r.z} -> ${s.x},${s.z}`)
        // only edges with relief can tell the candidate pairings apart
        if (EDGES.every(e => flatEdge(r.edges[e]) || flatEdge(s.edges[e]))) continue
        pairs[axis]++
        for (const ea of EDGES) {
          for (const eb of EDGES) {
            for (const rev of [false, true]) {
              if (flatEdge(r.edges[ea])) continue
              if (sameEdge(r.edges[ea], s.edges[eb], rev)) bump(tally[axis], `${ea}->${rev ? 'reversed ' : ''}${eb}`)
            }
          }
        }
      }
    }
    const ranked = (m: Record<string, number>, n: number) =>
      Object.entries(m)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${k} ${v}/${n} (${round((100 * v) / n, 1)}%)`)
    const report = { pairsWithRelief: pairs, xNeighbour: ranked(tally.x, pairs.x), zNeighbour: ranked(tally.z, pairs.z), seams: seams.length, seamList: seams }
    walk().report.regionEdges = report
    console.log(JSON.stringify(report, null, 2))
    const best = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1])
    const [bx, bx2] = best(tally.x)
    const [bz, bz2] = best(tally.z)
    expect(bx![0]).toBe('E->W')
    expect(bz![0]).toBe('N->S')
    expect(bx![1] / pairs.x).toBeGreaterThan(0.95)
    expect(bz![1] / pairs.z).toBeGreaterThan(0.95)
    expect(bx2![1] / pairs.x).toBeLessThan(0.3)
    expect(bz2![1] / pairs.z).toBeLessThan(0.3)
    // genuine cliffs between adjacent active regions (listed in the report)
    expect(seams.length).toBe(EXPECTED_ACTIVE_SEAMS)
  })

  it('matches the server navmesh: height map, tile flags, tile textures, water planes', () => {
    const { nvm } = walk()
    const report = {
      ...nvm,
      tileFlagEqualPercent: round((100 * nvm.tileFlagEqual) / nvm.tiles, 2),
      tileFlagTransposedEqualPercent: round((100 * nvm.tileFlagTransposedEqual) / nvm.tiles, 2),
      textureInCornersPercent: round((100 * nvm.textureInCorners) / nvm.tiles, 4),
      textureInCornersTransposedPercent: round((100 * nvm.textureInCornersTransposed) / nvm.tiles, 2),
      planeAgreePercent: round((100 * nvm.planeAgree) / nvm.planeTotal, 2),
    }
    walk().report.navmesh = report
    console.log(JSON.stringify(report, null, 2))
    expect(nvm.regions).toBeGreaterThan(3200)
    // the stitched 97x97 grid (later block wins on seams) is bit-identical to the navmesh height map
    expect(nvm.heightDiffer).toEqual([])
    expect(nvm.transposedEqual).toBeLessThan(nvm.regions * 0.1)
    // tile flags: the navmesh copies the .m flags and only ever adds the blocked bit
    expect(nvm.tileFlagViolations).toBe(0)
    expect(nvm.tileFlagSuperset).toBe(nvm.tiles)
    expect(nvm.tileFlagTransposedEqual).toBeLessThan(nvm.tileFlagEqual)
    // tile textures: always one of the tile's corner vertex ids (mostly its (tx, tz) corner)
    expect(nvm.textureInCorners).toBe(nvm.tiles)
    expect(nvm.textureInCornersTransposed).toBeLessThan(nvm.tiles * 0.9)
    expect(nvm.planeAgree / nvm.planeTotal).toBeGreaterThan(0.85)
    // where both have a plane, water <-> nvm 1 and ice <-> nvm 2/3, always at the same height; .m water the navmesh
    // lacks lies wholly under the terrain. (Navmesh water where the .m has none remains unexplained.)
    const both = Object.keys(nvm.planeCombos).filter(k => !k.startsWith('nvm 0') && !k.endsWith('m -1'))
    expect(both.sort()).toEqual(['nvm 1 / m 0 same height', 'nvm 2 / m 1 same height', 'nvm 3 / m 1 same height'])
    expect(nvm.hiddenWaterViolations).toEqual([])
    // the navmesh's own cell rectangles put tile index tz * 96 + tx at region-local (20 tx .. 20 tx + 20, 20 tz ..)
    expect(nvm.tileInCell).toBe(nvm.tiles)
    expect(nvm.tileInCellTransposed).toBeLessThan(nvm.tiles * 0.5)
  })

  it('matches the object placements: .o2 objects stand on the terrain at gx = x / 20, gz = z / 20', () => {
    const { objects } = walk()
    const ranked = Object.entries(objects.onTerrain)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]): [string, number] => [k, round(v / objects.placements)])
    walk().report.objectsOnTerrain = { regions: objects.regions, placements: objects.placements, fractionWithin1Unit: Object.fromEntries(ranked) }
    console.log(JSON.stringify(walk().report.objectsOnTerrain, null, 2))
    expect(objects.regions).toBeGreaterThan(3000)
    expect(objects.placements).toBeGreaterThan(50_000)
    // buildings stand on floors and plinths, so not every placement touches the terrain, but the true mapping
    // wins by far over the mirrored and transposed ones
    expect(ranked[0]![0]).toBe('gx = x/20, gz = z/20')
    expect(ranked[0]![1]).toBeGreaterThan(0.35)
    expect(ranked[1]![1]).toBeLessThan(ranked[0]![1] / 2)
  })

  it('matches the minimap: tile2d colours line up with gx to the right and gz up (north)', () => {
    const map = openArchive('Map')
    const media = openArchive('Media')
    const { tile2d, mfo } = walk()
    const colours = new Map<number, [number, number, number]>()
    const colour = (id: number) => {
      let c = colours.get(id)
      if (!c) {
        const img = decodeDds(parseDdj(map.read(tile2d.byId.get(id)!.path)).dds)
        const sum = [0, 0, 0]
        for (let i = 0; i < img.rgba.length; i += 4) for (let ch = 0; ch < 3; ch++) sum[ch]! += img.rgba[i + ch]!
        const n = img.width * img.height
        c = [sum[0]! / n, sum[1]! / n, sum[2]! / n]
        colours.set(id, c)
      }
      return c
    }
    // Jangan's 3x3 plus every 150th active region that has a minimap tile
    const picks: Array<[number, number]> = []
    for (let z = 96; z <= 98; z++) for (let x = 167; x <= 169; x++) picks.push([x, z])
    listActiveRegions(mfo).forEach((r, i) => {
      if (i % 150 === 0 && media.has(`minimap/${r.x}x${r.z}.ddj`)) picks.push([r.x, r.z])
    })
    const texScore: Record<string, number> = {}
    const lightScore: Record<string, number> = {}
    const gridScore: Record<string, number> = {}
    const texWins: Record<string, number> = {}
    const lightWins: Record<string, number> = {}
    const argmax = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]![0]
    for (const [x, z] of picks) {
      const grid = assembleRegionGrid(parseMapM(map.read(`${z}/${x}.m`)))
      const mt = parseMapT(map.read(`${z}/${x}.t`))
      const light = decodeMapTLightmap(mt)
      const mini = decodeDds(parseDdj(media.read(`minimap/${x}x${z}.ddj`)).dds)
      const tex: Record<string, number> = {}
      const lum: Record<string, number> = {}
      for (const [name, f] of Object.entries(ORIENTATIONS)) {
        // terrain texture colour vs minimap colour, mean of the per-channel correlations
        let r = 0
        for (let ch = 0; ch < 3; ch++) {
          const a: number[] = []
          const b: number[] = []
          for (let gz = 0; gz < 97; gz++) {
            for (let gx = 0; gx < 97; gx++) {
              a.push(colour(grid.textureIds[gz * 97 + gx]!)[ch]!)
              const [u, v] = f((gx + 0.5) / 97, (gz + 0.5) / 97)
              b.push(sample(mini, u, v, ch))
            }
          }
          r += pearson(a, b) / 3
        }
        tex[name] = r
        // lightmap luminance vs minimap luminance, |r| (the lightmap is dark where the minimap shows roofs)
        const a: number[] = []
        const b: number[] = []
        for (let py = 0; py < 128; py++) {
          for (let px = 0; px < 128; px++) {
            const u = (px + 0.5) / 128
            const v = (py + 0.5) / 128
            a.push(sample(light, u, v, 0) + sample(light, u, v, 1) + sample(light, u, v, 2))
            const [mu, mv] = f(u, v)
            b.push(sample(mini, mu, mv, 0) + sample(mini, mu, mv, 1) + sample(mini, mu, mv, 2))
          }
        }
        lum[name] = Math.abs(pearson(a, b))
        // light grid (96x96, index tz * 96 + tx) vs the lightmap image
        const ga: number[] = []
        const gb: number[] = []
        for (let tz = 0; tz < 96; tz++) {
          for (let tx = 0; tx < 96; tx++) {
            ga.push(mt.lightGrid[tz * 96 + tx]!)
            const [u, v] = f((tx + 0.5) / 96, (tz + 0.5) / 96)
            gb.push(sample(light, u, v, 0))
          }
        }
        bump(gridScore, name, pearson(ga, gb))
        bump(texScore, name, tex[name]!)
        bump(lightScore, name, lum[name]!)
      }
      bump(texWins, argmax(tex))
      bump(lightWins, argmax(lum))
    }
    const clean = (s: Record<string, number>) =>
      Object.fromEntries(
        Object.entries(s)
          .map(([k, v]): [string, number] => [k, round(v / picks.length)])
          .sort((a, b) => b[1] - a[1]),
      )
    const report = {
      regions: picks.length,
      textureVsMinimapMeanR: clean(texScore),
      textureVsMinimapWins: texWins,
      lightmapVsMinimapMeanAbsR: clean(lightScore),
      lightmapVsMinimapWins: lightWins,
      lightGridVsLightmapMeanR: clean(gridScore),
    }
    walk().report.orientation = report
    console.log(JSON.stringify(report, null, 2))
    const top = (s: Record<string, number>) => Object.entries(clean(s))
    const [tex1, tex2] = top(texScore)
    expect(tex1![0]).toBe('gx right, gz up')
    expect(tex1![1]).toBeGreaterThan(2 * tex2![1])
    expect(texWins['gx right, gz up']!).toBeGreaterThan(picks.length * 0.75)
    // weak on its own (see the border-continuity test for the lightmap), but it points the same way
    expect(top(lightScore)[0]![0]).toBe('gx right, gz up')
    // the 96x96 light grid is the lightmap at 1/5.33 scale in the same orientation (row tz = image row)
    const [grid1, grid2] = top(gridScore)
    expect(grid1![0]).toBe('gx right, gz down')
    expect(grid1![1]).toBeGreaterThan(0.8)
    expect(grid2![1]).toBeLessThan(0.5)
  })

  it('lightmaps and minimaps continue across region borders (lightmap rows grow north, minimap rows grow south)', () => {
    const map = openArchive('Map')
    const media = openArchive('Media')
    const { mfo } = walk()
    const luminance = (img: { width: number; height: number; rgba: Uint8Array }) => {
      const l = new Float32Array(img.width * img.height)
      for (let i = 0; i < l.length; i++) l[i] = (img.rgba[i * 4]! + img.rgba[i * 4 + 1]! + img.rgba[i * 4 + 2]!) / 3
      return { size: img.width, l }
    }
    const cache = new Map<string, { size: number; l: Float32Array }>()
    const load = (kind: 'light' | 'mini', x: number, z: number) => {
      const key = `${kind} ${x},${z}`
      let v = cache.get(key)
      if (!v) {
        v =
          kind === 'light'
            ? luminance(decodeMapTLightmap(parseMapT(map.read(`${z}/${x}.t`))))
            : luminance(decodeDds(parseDdj(media.read(`minimap/${x}x${z}.ddj`)).dds))
        cache.set(key, v)
      }
      return v
    }
    const line = (img: { size: number; l: Float32Array }, which: 'row' | 'col', i: number) =>
      Array.from({ length: img.size }, (_, k) => (which === 'row' ? img.l[i * img.size + k]! : img.l[k * img.size + i]!))
    const mad = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]!), 0) / a.length
    const flat = (a: number[]) => a.every(v => v === a[0])
    const scores: Record<string, number[]> = {}
    const add = (k: string, a: number[], b: number[]) => (scores[k] ??= []).push(mad(a, b))
    let pairs = 0
    const active = listActiveRegions(mfo)
    for (let i = 0; i < active.length && pairs < 600; i += 5) {
      const { x, z } = active[i]!
      for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
        if (!isRegionActive(mfo, x + dx, z + dz) || !media.has(`minimap/${x + dx}x${z + dz}.ddj`) || !media.has(`minimap/${x}x${z}.ddj`)) continue
        const a = load('light', x, z)
        const b = load('light', x + dx, z + dz)
        const ma = load('mini', x, z)
        const mb = load('mini', x + dx, z + dz)
        const last = a.size - 1
        const mlast = ma.size - 1
        if (dx) {
          if (flat(line(a, 'col', last)) && flat(line(b, 'col', 0))) continue
          add('lightmap x: A last col = B first col', line(a, 'col', last), line(b, 'col', 0))
          add('lightmap x: A first col = B last col', line(a, 'col', 0), line(b, 'col', last))
          add('lightmap x: A last col vs A second-last col', line(a, 'col', last), line(a, 'col', last - 1))
          add('minimap x: A last col = B first col', line(ma, 'col', mlast), line(mb, 'col', 0))
          add('minimap x: A first col = B last col', line(ma, 'col', 0), line(mb, 'col', mlast))
        } else {
          if (flat(line(a, 'row', last)) && flat(line(b, 'row', 0))) continue
          add('lightmap z: A last row = B first row', line(a, 'row', last), line(b, 'row', 0))
          add('lightmap z: A first row = B last row', line(a, 'row', 0), line(b, 'row', last))
          add('lightmap z: A last row vs A second-last row', line(a, 'row', last), line(a, 'row', last - 1))
          add('minimap z: A last row = B first row', line(ma, 'row', mlast), line(mb, 'row', 0))
          add('minimap z: A first row = B last row', line(ma, 'row', 0), line(mb, 'row', mlast))
        }
        pairs++
      }
      if (cache.size > 64) cache.clear()
    }
    const median = (v: number[]) => [...v].sort((p, q) => p - q)[v.length >> 1]!
    const report = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { pairs: v.length, medianAbsDiff: round(median(v), 2) }]))
    walk().report.borderContinuity = report
    console.log(JSON.stringify(report, null, 2))
    const m = (k: string) => median(scores[k]!)
    expect(pairs).toBeGreaterThan(300)
    // lightmap: columns grow east (+X), rows grow north (+Z)
    expect(m('lightmap x: A last col = B first col')).toBeLessThan(0.2 * m('lightmap x: A first col = B last col'))
    expect(m('lightmap z: A last row = B first row')).toBeLessThan(0.2 * m('lightmap z: A first row = B last row'))
    // the border texels are shared: A's last column equals B's first more closely than A's last two columns agree,
    // so texel centres (not texel edges) lie on the region border
    expect(m('lightmap x: A last col = B first col')).toBeLessThan(0.5 * m('lightmap x: A last col vs A second-last col'))
    expect(m('lightmap z: A last row = B first row')).toBeLessThan(0.5 * m('lightmap z: A last row vs A second-last row'))
    // minimap: columns grow east, rows grow south (north up)
    expect(m('minimap x: A last col = B first col')).toBeLessThan(0.5 * m('minimap x: A first col = B last col'))
    expect(m('minimap z: A first row = B last row')).toBeLessThan(0.5 * m('minimap z: A last row = B first row'))
  })

  it('lightmap and light grid are dark where .o2 objects stand only when image row 0 / grid row 0 is the south edge', () => {
    const map = openArchive('Map')
    const { mfo } = walk()
    const hyps: Record<string, (u: number, v: number) => [number, number]> = {
      'row 0 south (v = z)': (u, v) => [u, v],
      'row 0 north (v = 1 - z)': (u, v) => [u, 1 - v],
      'x mirrored': (u, v) => [1 - u, v],
      transposed: (u, v) => [v, u],
    }
    const lightmap: Record<string, number> = {}
    const grid: Record<string, number> = {}
    let regions = 0
    listActiveRegions(mfo).forEach(({ x, z }, i) => {
      if (i % 11 !== 0 || !map.has(`${z}/${x}.o2`) || !map.has(`${z}/${x}.t`)) return
      const own = regionId(x, z)
      const placed = readO2(map.read(`${z}/${x}.o2`)).filter(p => p.regionId === own && p.x >= 0 && p.x < 1920 && p.z >= 0 && p.z < 1920)
      if (placed.length < 10) return
      const mt = parseMapT(map.read(`${z}/${x}.t`))
      const img = decodeMapTLightmap(mt)
      const lum = (k: number) => img.rgba[k * 4]! + img.rgba[k * 4 + 1]! + img.rgba[k * 4 + 2]!
      let mean = 0
      for (let k = 0; k < img.width * img.height; k++) mean += lum(k)
      mean /= img.width * img.height
      const gridMean = mt.lightGrid.reduce((s, g) => s + g, 0) / mt.lightGrid.length
      regions++
      for (const [name, f] of Object.entries(hyps)) {
        let s = 0
        let gs = 0
        for (const p of placed) {
          const [u, v] = f(p.x / 1920, p.z / 1920)
          s += lum(Math.min(img.height - 1, Math.floor(v * img.height)) * img.width + Math.min(img.width - 1, Math.floor(u * img.width)))
          gs += mt.lightGrid[Math.min(95, Math.floor(v * 96)) * 96 + Math.min(95, Math.floor(u * 96))]!
        }
        bump(lightmap, name, mean - s / placed.length)
        bump(grid, name, gridMean - gs / placed.length)
      }
    })
    const ranked = (s: Record<string, number>) => Object.entries(s).map(([k, v]): [string, number] => [k, round(v / regions, 2)]).sort((a, b) => b[1] - a[1])
    const report = { regions, lightmapDarkeningAtObjects: Object.fromEntries(ranked(lightmap)), lightGridDarkeningAtObjects: Object.fromEntries(ranked(grid)) }
    walk().report.lightmapVsObjects = report
    console.log(JSON.stringify(report, null, 2))
    expect(regions).toBeGreaterThan(100)
    for (const s of [lightmap, grid]) {
      const [first, second] = ranked(s)
      expect(first![0]).toBe('row 0 south (v = z)')
      expect(second![1]).toBeLessThan(first![1] / 4)
    }
  })

  it('summarizes Jangan (regions X 167..169, Z 96..98; centre 168,97 = 0x61A8)', () => {
    const map = openArchive('Map')
    const { tile2d, env, mfo, report } = walk()
    const leaves = new Map(listEnvLeaves(env).map(l => [l.profileId, l.path.join('/')]))
    const summarize = (x: number, z: number) => {
      const mapm = parseMapM(map.read(`${z}/${x}.m`))
      const grid = assembleRegionGrid(mapm)
      let min = Infinity
      let max = -Infinity
      for (const h of grid.heights) {
        min = Math.min(min, h)
        max = Math.max(max, h)
      }
      const counts: Record<string, number> = {}
      for (const id of grid.textureIds) bump(counts, id)
      const textures = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([id, n]) => {
          const e = tile2d.byId.get(Number(id))!
          return `${id} ${e.file} (${e.typeName ?? e.type}, ${e.category}) ${round((100 * n) / grid.heights.length, 1)}%`
        })
      const water = mapm.blocks
        .filter(b => b.waterType >= 0)
        .map(b => `(${b.bx},${b.bz}) ${b.waterType === 0 ? 'water' : 'ice'} h=${round(b.waterHeight, 2)} wave ${b.waterWaveType}`)
      const envCounts: Record<string, number> = {}
      for (const b of mapm.blocks) bump(envCounts, b.environmentId)
      const profiles = Object.entries(envCounts).map(([id, n]) => `${id} "${env.byId.get(Number(id))!.name}" [${leaves.get(Number(id))}] x${n} blocks`)
      const blocked = grid.tileFlags.filter(f => f & 1).length
      return {
        region: `${x},${z}`,
        id: `0x${regionId(x, z).toString(16).toUpperCase()}`,
        active: isRegionActive(mfo, x, z),
        height: { min: round(min, 2), max: round(max, 2) },
        topTextures: textures,
        waterBlocks: water,
        environment: profiles,
        culledBlocks: mapm.blocks.filter(b => b.flag !== 0).map(b => `(${b.bx},${b.bz}) flag ${b.flag}`),
        blockedTiles: `${blocked}/9216`,
        edgeConflicts: grid.edgeConflicts.length,
      }
    }
    const centre = summarize(168, 97)
    const around: ReturnType<typeof summarize>[] = []
    for (let z = 96; z <= 98; z++) for (let x = 167; x <= 169; x++) if (x !== 168 || z !== 97) around.push(summarize(x, z))
    const profile = env.byId.get(15)!
    const noon = {
      sunColor: profile.sunColor.find(k => k.time >= 0.5),
      fogColor: profile.fogColor.find(k => k.time >= 0.5),
    }
    report.jangan = { centre, around, profile15Noon: noon }
    console.log(`\n=== Jangan centre (168,97) ===\n${JSON.stringify(centre, null, 2)}`)
    console.log(
      `=== Jangan 3x3 ===\n${around
        .map(r => `${r.region}: h ${r.height.min}..${r.height.max}, water ${r.waterBlocks.length}, env ${r.environment.join('; ')}, top ${r.topTextures.slice(0, 3).join(', ')}`)
        .join('\n')}`,
    )
    expect(centre.active).toBe(true)
    expect(centre.id).toBe('0x61A8')
    expect(centre.culledBlocks).toEqual(['(2,2) flag 1', '(3,2) flag 1'])
    expect(around.every(r => r.active)).toBe(true)
    const outDir = join(loadConfig().workDir, 'out', 'debug')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'terrain-corpus.json'), JSON.stringify(report, null, 2))
  })
})
