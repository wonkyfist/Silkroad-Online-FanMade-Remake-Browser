import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BMS_NO_BONE, eucKr, normalizePk2Path, parseBms, type BmsMesh, type Pk2Archive } from '@sro/formats'
import { ARCHIVES, openArchive, REPO_ROOT } from '../src/node-io.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))

/** Files that may fail to parse, with the reason. None in vSRO 1.188. */
const PARSE_ALLOWLIST = new Map<string, string>()

/**
 * Meshes whose uv0 holds NaN on some vertices (bit patterns 0xFFFFFFFF, 0x7FFFFFFF and 0xFFFFxxxx such as
 * 0xFFFF4646; every one referenced by faces, and the file still tiles exactly, so this is not a misparse):
 * authored exporter garbage, returned raw by the parser; the glTF writer must sanitize it.
 * Key: archive:path -> number of vertices with a NaN uv0.
 */
const NAN_UV_ALLOWLIST = new Map<string, number>([
  ['Data:prim/mesh/artifact/china/dunhuang/w_cd_ani_boat02.bms', 7],
  ['Data:prim/mesh/artifact/china/dunhuang/w_cd_ani_boat05.bms', 12],
  ['Data:prim/mesh/artifact/china/dunhuang/w_cd_boat02.bms', 7],
  ['Data:prim/mesh/artifact/china/dunhuang/w_cd_boat05.bms', 12],
  ['Data:prim/mesh/artifact/china/jangan/cj_lamp02.bms', 7],
  ['Data:prim/mesh/artifact/oasis/tarim/oas_tarim_house_01.bms', 18],
  ['Data:prim/mesh/bldg/china/cj_ferry/cj_ferry_enter_roof.bms', 3],
  ['Data:prim/mesh/bldg/china/dunhuang/milicamp/w_cd_mcfence01.bms', 3],
  ['Data:prim/mesh/bldg/china/dunhuang/milicamp/w_cd_mcfence01_wall.bms', 3],
  ['Data:prim/mesh/bldg/china/dunhuang/milicamp/w_cd_mcfence02_wall03.bms', 3],
  ['Data:prim/mesh/bldg/china/dunhuang/milicamp/w_cd_mc_cata.bms', 5],
  ['Data:prim/mesh/bldg/oasis/karakorm/oas_kk_brok_wall02.bms', 9],
  ['Data:prim/mesh/npc/china/chinasystem_boatman2_ship02.bms', 7],
  ['Data:prim/mesh/npc/china/chinasystem_boatman2_ship04.bms', 12],
])

const DUMP_BSRS = ['res/char/china/chinaman_adventurer.bsr', 'res/item/china/weapon/blade_01.bsr']

const inc = <K>(m: Map<K, number>, k: K, n = 1) => m.set(k, (m.get(k) ?? 0) + n)
const sortedHist = <K>(m: Map<K, number>) => [...m].sort((a, b) => b[1] - a[1])
const hex = (n: number) => '0x' + n.toString(16)
const fmt = (a: ArrayLike<number>) => Array.from(a, x => (Number.isInteger(x) ? String(x) : x.toFixed(4))).join(' ')

/** Buckets of the raw u16 weight sum of a vertex (65535 = 1.0). */
function sumBucket(s: number): string {
  if (s === 65535) return '1 (65535)'
  if (s > 65535) return '>1'
  if (s >= 65470) return '[0.999, 1)'
  if (s >= 64880) return '[0.99, 0.999)'
  if (s >= 58982) return '[0.9, 0.99)'
  if (s >= 32768) return '[0.5, 0.9)'
  if (s > 0) return '(0, 0.5)'
  return '0 (no influence)'
}

function nonFinite(a: ArrayLike<number>): number {
  let n = 0
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]!)) n++
  return n
}

interface Stats {
  parsed: number
  failures: Array<[string, string]>
  perArchive: Map<string, number>
  signatures: Map<string, number>
  vertexFlags: Map<string, number>
  navFlags: Map<number, number>
  kind: Map<string, number>
  withNav: number
  withCloth: number
  withPortals: number
  withLightmap: number
  maxVertices: { count: number; path: string }
  maxTriangles: { count: number; path: string }
  maxBones: { count: number; path: string }
  totalVertices: number
  totalTriangles: number
  influences: Map<string, number>
  sums: Map<string, number>
  minNonZeroSum: number
  noInfluence: Map<string, number>
  skinnedVertices: number
  nearOne: number
  /** Vertices with exactly one influence, and how many of those store weight 0xFFFF. */
  single: number
  singleFull: number
  nanUv: Map<string, number>
  boundsOutside: Array<[string, number]>
  unknownUInt3MatchesInt0: number
  clothEdgeOrderPermutation: number
  zeroNormals: number
  bad: string[]
}

let stats: Stats | undefined

function check(key: string, m: BmsMesh, s: Stats): void {
  const bad = (what: string) => s.bad.push(`${key}: ${what}`)
  const { vertexCount } = m
  const k = m.influencesPerVertex

  inc(s.signatures, m.signature)
  inc(s.vertexFlags, hex(m.vertexFlags))
  inc(s.kind, `${m.signature} ${m.boneNames.length > 0 ? 'skinned' : 'static'}`)
  if (m.navMesh) {
    s.withNav++
    inc(s.navFlags, m.header.navFlags)
  }
  if (m.cloth) s.withCloth++
  if (m.occlusionPortals.length) s.withPortals++
  if (m.uv1) s.withLightmap++
  const triangles = m.indices.length / 3
  s.totalVertices += vertexCount
  s.totalTriangles += triangles
  if (vertexCount > s.maxVertices.count) s.maxVertices = { count: vertexCount, path: key }
  if (triangles > s.maxTriangles.count) s.maxTriangles = { count: triangles, path: key }
  if (m.boneNames.length > s.maxBones.count) s.maxBones = { count: m.boneNames.length, path: key }

  // Header constants
  const h = m.header
  if (h.subPrimCount !== 1 || h.unknownUInt0 !== 0 || h.unknownUInt2 !== 0) bad(`header constants ${h.subPrimCount}/${h.unknownUInt0}/${h.unknownUInt2}`)
  if (m.unknown9Count !== 0 || m.skinnedNavMesh) bad('unknown9 or skinned navmesh present')
  // Section order on disk: every section but the navmesh is always present, and the navmesh comes after
  // unknown9 although its header slot precedes it. The parser only checks contiguity, so pin the order here.
  const order = [h.vertexOffset, h.skinOffset, h.faceOffset, h.clothVertexOffset, h.clothEdgeOffset, h.boundingBoxOffset,
    h.occlusionPortalOffset, h.unknown9Offset, ...(h.navMeshOffset ? [h.navMeshOffset] : [])]
  if (order[0] !== h.size || order.some((o, i) => i > 0 && o <= order[i - 1]!)) bad(`section order ${order.join(',')}`)
  if (m.lightmapPath !== undefined && !m.lightmapPath.toLowerCase().endsWith('.ddj')) bad(`lightmap path ${m.lightmapPath}`)
  if (m.uv1?.some(x => !(x >= 0 && x <= 1))) bad('lightmap uv outside [0, 1]')
  let int0Set = 0
  for (const v of m.unknownVertexInt0) if (v !== 0xffffffff) int0Set++
  if (h.unknownUInt3 === int0Set) s.unknownUInt3MatchesInt0++

  // Indices
  if (m.indices.length % 3 !== 0) bad(`index count ${m.indices.length} not a multiple of 3`)
  for (const i of m.indices) {
    if (i >= vertexCount) {
      bad(`index ${i} >= vertexCount ${vertexCount}`)
      break
    }
  }

  // Finite floats
  const nanUv = nonFinite(m.uv0)
  if (nanUv) inc(s.nanUv, key, nanUv / 2)
  const floats: Array<[string, ArrayLike<number>]> = [
    ['positions', m.positions],
    ['normals', m.normals],
    ['uv1', m.uv1 ?? []],
    ['unknownVertexFloat', m.unknownVertexFloat],
    ['extraVertexData', m.extraVertexData ?? []],
    ['bounds', [...m.bounds.min, ...m.bounds.max]],
    ['weights', m.weights ?? []],
  ]
  if (m.cloth) {
    floats.push(['cloth vertex', m.cloth.vertexMaxDistance], ['cloth edge', m.cloth.edgeMaxDistance])
    const p = m.cloth.params
    if (p) floats.push(['cloth params', [p.animationOffsetX, p.animationOffsetY, p.animationOffsetZ, p.fallingSpeed, p.unknownFloat6, p.unknownFloat7, p.elasticity]])
  }
  for (const portal of m.occlusionPortals) floats.push(['portal', portal.vertices])
  if (m.navMesh) floats.push(['nav vertices', m.navMesh.vertices], ['nav grid origin', m.navMesh.grid.origin])
  for (const [what, a] of floats) if (nonFinite(a)) bad(`${nonFinite(a)} non-finite ${what}`)

  // Normals are unit length (checks the field order within the vertex record), except a few zero vectors.
  for (let v = 0; v < vertexCount; v++) {
    const len = Math.hypot(m.normals[v * 3]!, m.normals[v * 3 + 1]!, m.normals[v * 3 + 2]!)
    if (len === 0) s.zeroNormals++
    else if (Math.abs(len - 1) > 0.01) bad(`vertex ${v}: normal length ${len}`)
  }
  for (const portal of m.occlusionPortals) {
    if (portal.indices.some(i => i >= portal.vertices.length / 3)) bad(`portal ${portal.name}: index out of range`)
  }

  // Bounds vs positions (reported only)
  let excess = 0
  for (let v = 0; v < vertexCount; v++) {
    for (let a = 0; a < 3; a++) {
      const p = m.positions[v * 3 + a]!
      excess = Math.max(excess, m.bounds.min[a]! - p, p - m.bounds.max[a]!)
    }
  }
  if (excess > 1e-3) s.boundsOutside.push([key, excess])

  // Skinning
  if (m.boneNames.length > 0) {
    const bones = m.skinBones!
    const raw = m.skinWeights!
    const joints = m.joints!
    const weights = m.weights!
    if (k !== (m.version === 109 ? 4 : 2)) bad(`influencesPerVertex ${k}`)
    for (let v = 0; v < vertexCount; v++) {
      let sum = 0
      let used = 0
      for (let j = 0; j < k; j++) {
        const bone = bones[v * k + j]!
        const w = raw[v * k + j]!
        if (bone === BMS_NO_BONE) {
          if (w !== 0) bad(`vertex ${v} slot ${j}: weight ${w} on bone 0xFF`)
          continue
        }
        used++
        sum += w
        if (bone >= m.boneNames.length) bad(`vertex ${v} slot ${j}: bone ${bone} >= palette ${m.boneNames.length}`)
        if (w === 0) bad(`vertex ${v} slot ${j}: zero weight on bone ${bone}`)
        if (j >= 2) bad(`vertex ${v} uses influence slot ${j}`)
      }
      for (let j = 0; j < 4; j++) {
        if (weights[v * 4 + j]! > 0 && joints[v * 4 + j]! >= m.boneNames.length) bad(`vertex ${v}: joint out of palette`)
      }
      s.skinnedVertices++
      if (used === 1) {
        s.single++
        if (sum === 65535) s.singleFull++
      }
      inc(s.influences, `${m.signature}: ${used}`)
      inc(s.sums, sumBucket(sum))
      if (Math.abs(sum / 65535 - 1) <= 0.01) s.nearOne++
      if (sum > 0 && sum < s.minNonZeroSum) s.minNonZeroSum = sum
      if (used === 0) inc(s.noInfluence, key)
    }
  }

  // Cloth
  if (m.cloth) {
    const c = m.cloth
    const edgeCount = c.edgeMaxDistance.length
    if (c.vertexMaxDistance.length !== vertexCount) bad(`cloth vertex count ${c.vertexMaxDistance.length} != ${vertexCount}`)
    for (const i of c.edges) if (i >= vertexCount) bad(`cloth edge vertex ${i} >= ${vertexCount}`)
    if (edgeCount > 0 && !c.params) bad('cloth edges without parameters')
    if (c.vertexPinned.some(p => p > 1)) bad('cloth pinned flag not 0/1')
    // SilkroadDoc: deformation mode 0/1, movement factor must be non-zero (both u32; the rest are floats).
    if (c.params && (c.params.deformationMode > 1 || c.params.movementFactor === 0 || c.params.movementFactor > 1000)) {
      bad(`cloth params mode ${c.params.deformationMode} movementFactor ${c.params.movementFactor}`)
    }
    const seen = new Set(c.edgeOrder)
    if (seen.size === edgeCount && [...seen].every(i => i < edgeCount)) s.clothEdgeOrderPermutation++
  }

  // Navmesh topology
  const nav = m.navMesh
  if (nav) {
    const nv = nav.vertexBisectors.length
    const nc = nav.cellFlags.length
    const no = nav.outlineEdges.flags.length
    if (nav.cells.some(i => i >= nv)) bad('nav cell vertex out of range')
    if (nav.cellFlags.some(f => f !== 0)) bad('nav cell flag != 0')
    for (const e of [nav.outlineEdges, nav.inlineEdges]) {
      if (e.vertices.some(i => i >= nv)) bad('nav edge vertex out of range')
    }
    // Outline edges border one cell (dst = 0xFFFF); inline edges join two distinct cells.
    const oc = nav.outlineEdges.cells
    for (let i = 0; i < no; i++) {
      if (oc[i * 2]! >= nc || oc[i * 2 + 1] !== 0xffff) bad(`nav outline edge ${i} cells ${oc[i * 2]}/${oc[i * 2 + 1]}`)
    }
    const ic = nav.inlineEdges.cells
    for (let i = 0; i < nav.inlineEdges.flags.length; i++) {
      if (ic[i * 2]! >= nc || ic[i * 2 + 1]! >= nc || ic[i * 2] === ic[i * 2 + 1]) bad(`nav inline edge ${i} cells ${ic[i * 2]}/${ic[i * 2 + 1]}`)
    }
    // Event bytes: low 6 bits index the event name list.
    for (const zones of [nav.cellEventZones, nav.outlineEdges.eventZones, nav.inlineEdges.eventZones]) {
      if (zones?.some(z => z !== 0 && (z & 0x3f) >= nav.events.length)) bad('nav event index out of range')
    }
    if (nav.grid.width * nav.grid.height !== nav.grid.cellStart.length - 1) bad('nav grid cell count != width * height')
    if (nav.grid.cellOutlines.some(o => o >= no)) bad('nav grid outline index out of range')
    // The grid origin is the nav vertices' x/z minimum.
    let minX = Infinity
    let minZ = Infinity
    for (let i = 0; i < nv; i++) {
      minX = Math.min(minX, nav.vertices[i * 3]!)
      minZ = Math.min(minZ, nav.vertices[i * 3 + 2]!)
    }
    if (Math.abs(minX - nav.grid.origin[0]) > 1e-3 || Math.abs(minZ - nav.grid.origin[1]) > 1e-3) bad('nav grid origin != vertex x/z minimum')
  }
}

function load(): Stats {
  if (stats) return stats
  const s: Stats = {
    parsed: 0,
    failures: [],
    perArchive: new Map(),
    signatures: new Map(),
    vertexFlags: new Map(),
    navFlags: new Map(),
    kind: new Map(),
    withNav: 0,
    withCloth: 0,
    withPortals: 0,
    withLightmap: 0,
    maxVertices: { count: 0, path: '' },
    maxTriangles: { count: 0, path: '' },
    maxBones: { count: 0, path: '' },
    totalVertices: 0,
    totalTriangles: 0,
    influences: new Map(),
    sums: new Map(),
    minNonZeroSum: Infinity,
    noInfluence: new Map(),
    skinnedVertices: 0,
    nearOne: 0,
    single: 0,
    singleFull: 0,
    nanUv: new Map(),
    boundsOutside: [],
    unknownUInt3MatchesInt0: 0,
    clothEdgeOrderPermutation: 0,
    zeroNormals: 0,
    bad: [],
  }
  for (const name of ARCHIVES) {
    const archive = openArchive(name)
    for (const [path, entry] of archive.files) {
      if (!path.endsWith('.bms')) continue
      const key = `${name}:${path}`
      inc(s.perArchive, name)
      let mesh: BmsMesh
      try {
        mesh = parseBms(archive.read(entry))
      } catch (e) {
        s.failures.push([key, (e as Error).message])
        continue
      }
      s.parsed++
      check(key, mesh, s)
    }
  }
  stats = s
  return s
}

/** Paths of the files with the given extension a BSR references: every CP949 lpString ending in it. */
function lpStringRefs(bytes: Uint8Array, ext: string): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const needle = Array.from(ext.toLowerCase(), c => c.charCodeAt(0))
  const out: string[] = []
  for (let i = 0; i + needle.length <= bytes.length; i++) {
    if (!needle.every((c, j) => (bytes[i + j]! | 0x20) === (c | 0x20))) continue
    const end = i + needle.length
    for (let start = i - 1; start >= 4 && end - start <= 260; start--) {
      if (view.getUint32(start - 4, true) === end - start) {
        out.push(eucKr.decode(bytes.subarray(start, end)))
        break
      }
    }
  }
  return out
}

function dumpMesh(ref: string, m: BmsMesh): string[] {
  const lines = [
    `  ${ref}: ${m.signature} "${m.name}" material "${m.materialName}" vertexFlags ${hex(m.vertexFlags)}`,
    `    ${m.vertexCount} vertices, ${m.indices.length / 3} triangles, unknownUInt3 ${m.header.unknownUInt3}` +
      `, navmesh ${m.navMesh ? 'yes' : 'no'}, cloth ${m.cloth ? `${m.cloth.edgeMaxDistance.length} edges` : 'no'}` +
      (m.lightmapPath ? `, lightmap ${m.lightmapPath}` : ''),
    `    bounds min (${fmt(m.bounds.min)}) max (${fmt(m.bounds.max)})`,
  ]
  if (m.boneNames.length) {
    lines.push(`    bone palette (${m.boneNames.length}): ${m.boneNames.map((b, i) => `${i} ${b}`).join(', ')}`)
    const k = m.influencesPerVertex
    const used = new Map<number, number>()
    const sums = new Map<string, number>()
    for (let v = 0; v < m.vertexCount; v++) {
      let n = 0
      let sum = 0
      for (let j = 0; j < k; j++) {
        if (m.skinBones![v * k + j] !== BMS_NO_BONE) {
          n++
          sum += m.skinWeights![v * k + j]!
        }
      }
      inc(used, n)
      inc(sums, sumBucket(sum))
    }
    lines.push(
      `    influences per vertex: ${sortedHist(used).map(([n, c]) => `${n}x${c}`).join(' ')}; weight sums: ` +
        sortedHist(sums).map(([b, c]) => `${b} x${c}`).join(', '),
    )
  } else {
    lines.push('    static (no bones)')
  }
  for (let v = 0; v < Math.min(3, m.vertexCount); v++) {
    let line =
      `    v${v} pos (${fmt(m.positions.subarray(v * 3, v * 3 + 3))}) nrm (${fmt(m.normals.subarray(v * 3, v * 3 + 3))})` +
      ` uv (${fmt(m.uv0.subarray(v * 2, v * 2 + 2))})`
    if (m.uv1) line += ` uv1 (${fmt(m.uv1.subarray(v * 2, v * 2 + 2))})`
    if (m.joints && m.weights) {
      line += ` joints [${fmt(m.joints.subarray(v * 4, v * 4 + 4))}] weights [${fmt(m.weights.subarray(v * 4, v * 4 + 4))}]`
    }
    line += ` unk (${fmt([m.unknownVertexFloat[v]!])}, ${hex(m.unknownVertexInt0[v]!)}, ${m.unknownVertexInt1[v]})`
    lines.push(line)
  }
  return lines
}

describe.skipIf(!hasConfig)('BMS corpus (vSRO 1.188, every archive)', () => {
  it('parses every .bms without exceptions (allowlist aside)', () => {
    const s = load()
    const unexpected = s.failures.filter(([key]) => !PARSE_ALLOWLIST.has(key))
    console.log(
      `BMS: ${s.parsed} parsed, ${s.failures.length} failed; per archive`,
      Object.fromEntries(s.perArchive),
      '; signatures',
      Object.fromEntries(s.signatures),
    )
    if (unexpected.length) console.log('unexpected failures', unexpected.slice(0, 20))
    expect(unexpected).toEqual([])
    expect(Object.fromEntries(s.perArchive)).toEqual({ Data: 16853, Particles: 233 })
    expect(Object.fromEntries(s.signatures)).toEqual({ 'JMXVBMS 0110': 17067, 'JMXVBMS 0109': 19 })
  })

  it('reports the corpus shape', () => {
    const s = load()
    console.log(
      [
        `BMS vertexFlags: ${sortedHist(s.vertexFlags).map(([f, n]) => `${f} x${n}`).join(' ')}`,
        `BMS skinned/static: ${sortedHist(s.kind).map(([k, n]) => `${k} x${n}`).join(', ')}`,
        `BMS with navmesh ${s.withNav} (navFlags ${sortedHist(s.navFlags).map(([f, n]) => `${f} x${n}`).join(' ')}),` +
          ` cloth ${s.withCloth} (edge order is a permutation in ${s.clothEdgeOrderPermutation}), occlusion portals ${s.withPortals}, lightmap ${s.withLightmap}`,
        `BMS totals: ${s.totalVertices} vertices, ${s.totalTriangles} triangles; max vertices ${s.maxVertices.count} (${s.maxVertices.path}),` +
          ` max triangles ${s.maxTriangles.count} (${s.maxTriangles.path}), max bones ${s.maxBones.count} (${s.maxBones.path})`,
        `BMS unknownUInt3 == count(unknownVertexInt0 != 0xFFFFFFFF) in ${s.unknownUInt3MatchesInt0}/${s.parsed}`,
        `BMS stored bounds exclude some positions (> 0.001) in ${s.boundsOutside.length} files; worst: ` +
          s.boundsOutside
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([p, e]) => `${p} +${e.toFixed(2)}`)
            .join(', '),
      ].join('\n'),
    )
    expect(s.maxVertices.count).toBeLessThanOrEqual(65536)
    expect(s.withNav).toBe(2103)
    expect([...s.vertexFlags.keys()].sort()).toEqual(['0x0', '0x400'])
    expect(s.clothEdgeOrderPermutation).toBe(s.withCloth)
  })

  it('holds the layout invariants (indices, finite floats, palette, navmesh topology)', () => {
    const s = load()
    if (s.bad.length) console.log(`BMS invariant violations (${s.bad.length}):\n  ${s.bad.slice(0, 30).join('\n  ')}`)
    expect(s.bad.slice(0, 30)).toEqual([])
    const nanUv = sortedHist(s.nanUv)
    console.log(`BMS NaN uv0: ${nanUv.length} files, ${nanUv.reduce((a, [, n]) => a + n, 0)} vertices; zero normals: ${s.zeroNormals}`)
    expect(new Map(s.nanUv)).toEqual(NAN_UV_ALLOWLIST)
    // Zero-length normals (cj3_lion01/02, oas_hot_temple_construction, cj_s_wall02, oas_hot_acc_wall01).
    expect(s.zeroNormals).toBe(50)
  })

  it('reports skin influences and weight sums', () => {
    const s = load()
    const total = s.skinnedVertices
    const pct = (n: number) => `${((100 * n) / total).toFixed(2)}%`
    console.log(
      [
        `BMS skinned vertices: ${total}; used influences: ${sortedHist(s.influences).map(([k, n]) => `${k} x${n}`).join(', ')}`,
        `BMS weight sums (raw u16 / 65535): ${sortedHist(s.sums).map(([b, n]) => `${b} x${n} (${pct(n)})`).join(', ')}`,
        `BMS |sum - 1| <= 0.01: ${s.nearOne} (${pct(s.nearOne)}); smallest non-zero sum ${(s.minNonZeroSum / 65535).toFixed(4)}` +
          `; single-influence vertices storing 0xFFFF: ${s.singleFull}/${s.single}`,
        `BMS vertices with no influence: ${sortedHist(s.noInfluence).map(([k, n]) => `${k} x${n}`).join(', ')}`,
      ].join('\n'),
    )
    // Sums never exceed 1; low sums are two kept influences of a vertex that had more (e.g. 2 x 21838 = 2/3).
    expect(s.sums.has('>1')).toBe(false)
    expect(s.nearOne / total).toBeGreaterThan(0.99)
    expect([...s.noInfluence.values()].reduce((a, b) => a + b, 0)).toBe(136)
  })

  it('dumps the meshes of the test assets', () => {
    const data: Pk2Archive = openArchive('Data')
    for (const bsr of DUMP_BSRS) {
      const refs = lpStringRefs(data.read(bsr), '.bms')
      expect(refs.length).toBeGreaterThan(0)
      const lines = [`== ${bsr} (${refs.length} meshes)`]
      for (const ref of refs) {
        const mesh = parseBms(data.read(normalizePk2Path(ref)))
        lines.push(...dumpMesh(ref, mesh))
        if (bsr.includes('/char/')) expect(mesh.boneNames.length).toBeGreaterThan(0)
      }
      console.log(lines.join('\n'))
    }
  })
})
