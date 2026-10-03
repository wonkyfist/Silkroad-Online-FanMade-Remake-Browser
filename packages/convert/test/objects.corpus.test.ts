import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  BinaryReader,
  bskMath,
  cpdReferencedPaths,
  mapoInstances,
  mapoLayouts,
  mapoPositionInRegion,
  mapoRegionCoords,
  mapoRegionId,
  mapoUidParts,
  mapoYawQuat,
  MAPO_BLOCK_SIZE,
  MAPO_REGION_SIZE,
  MAPO_STATIC,
  normalizePk2Path,
  parseBms,
  parseBsr,
  parseCpd,
  parseMapO,
  parseObjectExtIfo,
  parseObjectIfo,
  parseObjectStringIfo,
  type BmsNavMesh,
  type CpdCompound,
  type MapO,
  type MapObjectInstance,
  type MapObjectPlacement,
  type ObjectIfo,
  type Pk2Archive,
} from '@sro/formats'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))

/** Files allowed to fail parsing, with the reason. None in vSRO 1.188. */
const PARSE_ALLOWLIST = new Map<string, string>()

/** Jangan: regions X 167..169, Z 96..98 (centre 168,97 = 0x61A8). */
const JANGAN: Array<[x: number, z: number]> = []
for (let z = 96; z <= 98; z++) for (let x = 167; x <= 169; x++) JANGAN.push([x, z])

type Counter = Map<string | number, number>
const inc = (map: Counter, key: string | number, n = 1) => map.set(key, (map.get(key) ?? 0) + n)
const table = (map: Counter) =>
  [...map].sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en', { numeric: true })).map(([k, n]) => `${k}: ${n}`).join(', ')
const hex = (v: number) => `0x${v.toString(16).padStart(4, '0')}`
const key = (regionId: number, uid: number) => regionId * 0x10000 + uid

interface Region {
  id: number
  x: number
  z: number
  o?: MapO
  o2?: MapO
}

/**
 * The object list and terrain cells at the head of a region .nvm, read here directly so this test does
 * not depend on the navmesh parser (packages/formats/src/nvm.ts; layout per the SilkroadDoc JMXVNVM page,
 * checked on the bytes): u16 n, n x { MAPO .o2 record, u16 m, m x (i16 linkedObject, i16 linkedEdge,
 * i16 edge) }, then u32 cells, u32 open cells, per cell f32 minX, minZ, maxX, maxZ, u8 k, k x u16 object.
 */
interface NvmHead {
  objects: Array<MapObjectPlacement & { regionId: number; links: Array<[linkedObject: number, linkedEdge: number, edge: number]> }>
  cells: Array<{ minX: number; minZ: number; maxX: number; maxZ: number; objects: number[] }>
}

function readNvmHead(bytes: Uint8Array): NvmHead {
  const r = new BinaryReader(bytes)
  expect(r.fixedString(12)).toBe('JMXVNVM 1000')
  const objects: NvmHead['objects'] = []
  for (let n = r.u16(), i = 0; i < n; i++) {
    const p = {
      objId: r.u32(), position: [r.f32(), r.f32(), r.f32()] as [number, number, number], staticFlag: r.u16(), yaw: r.f32(),
      uid: r.u16(), unknown0: r.u16(), isBig: r.u8(), isStruct: r.u8(), regionId: r.u16(),
      links: [] as Array<[number, number, number]>,
    }
    for (let m = r.u16(), j = 0; j < m; j++) {
      const a = r.u16(), b = r.u16(), c = r.u16()
      p.links.push([a === 0xffff ? -1 : a, b, c])
    }
    objects.push(p)
  }
  const cells: NvmHead['cells'] = []
  const cellCount = r.u32()
  r.u32()
  for (let i = 0; i < cellCount; i++) {
    const c = { minX: r.f32(), minZ: r.f32(), maxX: r.f32(), maxZ: r.f32(), objects: [] as number[] }
    for (let k = r.u8(), j = 0; j < k; j++) c.objects.push(r.u16())
    cells.push(c)
  }
  return { objects, cells }
}

/**
 * The 97 x 97 terrain height grid (index gz * 97 + gx, vertex spacing 20 units) of a region .m, read here
 * directly so this test is independent of packages/formats/src/mapm.ts (layout per SilkroadDoc JMXVMAPM and
 * terrain.corpus.test.ts): "JMXVMAPM1000", 36 blocks (bz outer, bx inner) of u32 + u16, 17 x 17 vertices
 * (vz outer) of f32 height + u16 + u8, then 6 + 512 + 8 + 20 bytes. null for the few odd-sized files.
 */
function readMapMHeights(bytes: Uint8Array): Float32Array | null {
  if (bytes.length !== 12 + 36 * 2575) return null
  const r = new BinaryReader(bytes)
  expect(r.fixedString(12)).toBe('JMXVMAPM1000')
  const heights = new Float32Array(97 * 97)
  for (let bz = 0; bz < 6; bz++) {
    for (let bx = 0; bx < 6; bx++) {
      r.skip(6)
      for (let vz = 0; vz < 17; vz++) {
        for (let vx = 0; vx < 17; vx++) {
          heights[(bz * 16 + vz) * 97 + bx * 16 + vx] = r.f32()
          r.skip(3)
        }
      }
      r.skip(6 + 512 + 8 + 20)
    }
  }
  return heights
}

describe.skipIf(!hasConfig)('world objects corpus (.o, .o2, object.ifo, .cpd)', () => {
  let map: Pk2Archive
  let data: Pk2Archive
  let ifo: ObjectIfo
  const regions = new Map<number, Region>()
  const failures: string[] = []
  const versions: Counter = new Map()
  const layouts: Counter = new Map()
  const ambiguous: string[] = []
  let mapoFiles = 0
  const cpds = new Map<string, CpdCompound>()
  const cpdFailures: string[] = []
  /** objId -> its collision navmesh (null: none), resolved lazily. */
  const navMeshes = new Map<number, BmsNavMesh | null>()

  const regionOf = (id: number): Region => {
    let r = regions.get(id)
    if (!r) regions.set(id, (r = { id, ...mapoRegionCoords(id) }))
    return r
  }
  /** Every record of a file with its block and group (no dedupe). */
  const records = (mo: MapO): MapObjectInstance[] =>
    mo.blocks.flatMap((b, block) => b.groups.flatMap((list, group) => list.map(p => ({ ...p, block, group }))))

  const navMeshOf = (objId: number): BmsNavMesh | null => {
    if (navMeshes.has(objId)) return navMeshes.get(objId)!
    let nav: BmsNavMesh | null = null
    let path = ifo.byIndex.get(objId)?.path ?? ''
    if (/\.cpd$/i.test(path)) path = data.has(path) ? parseCpd(data.read(path)).collisionPath : ''
    if (path && data.has(path)) {
      const meshPath = parseBsr(data.read(path)).collision.meshPath
      if (meshPath && data.has(meshPath)) nav = parseBms(data.read(meshPath)).navMesh ?? null
    }
    navMeshes.set(objId, nav)
    return nav
  }

  beforeAll(() => {
    map = openArchive('Map')
    data = openArchive('Data')
    ifo = parseObjectIfo(map.read('object.ifo'))
    for (const [path, file] of map.files) {
      const ext = /\.(o2?)$/.exec(path)?.[1] as 'o' | 'o2' | undefined
      if (!ext) continue
      mapoFiles++
      const m = /^(\d+)\/(\d+)\.o2?$/.exec(path)
      if (!m) {
        failures.push(`${path}: not a <Z>/<X> region file`)
        continue
      }
      const bytes = map.read(file)
      try {
        const mo = parseMapO(bytes, ext)
        const fits = mapoLayouts(bytes, ext)
        if (fits.length !== 1) ambiguous.push(`${path}: ${fits}`)
        inc(versions, `.${ext} ${mo.signature}`)
        inc(layouts, `.${ext} ${mo.groupsPerBlock} groups`)
        regionOf(mapoRegionId(Number(m[2]), Number(m[1])))[ext] = mo
      } catch (e) {
        if (!PARSE_ALLOWLIST.has(path)) failures.push(`${path}: ${(e as Error).message}`)
      }
    }
    for (const [path, file] of data.files) {
      if (!path.endsWith('.cpd')) continue
      try {
        cpds.set(path, parseCpd(data.read(file)))
      } catch (e) {
        cpdFailures.push(`${path}: ${(e as Error).message}`)
      }
    }
  })

  it('parses every .o, .o2 and .cpd without exceptions', () => {
    console.log(`MAPO: ${mapoFiles} files; ${table(versions)}; layouts ${table(layouts)}`)
    expect(failures).toEqual([])
    expect(ambiguous).toEqual([])
    expect(Object.fromEntries(versions)).toEqual({ '.o JMXVMAPO1001': 3435, '.o JMXVMAPO1000': 7, '.o2 JMXVMAPO1001': 3300 })
    // Every file with objects has 4 groups per block; 18 all-empty 228-byte .o placeholders have 3.
    expect(Object.fromEntries(layouts)).toEqual({ '.o 4 groups': 3424, '.o 3 groups': 18, '.o2 4 groups': 3300 })
    for (const r of regions.values()) {
      if (r.o?.groupsPerBlock === 3) expect(records(r.o)).toEqual([])
    }
    console.log(`object.ifo: ${ifo.entries.length} entries; CPD: ${cpds.size} files`)
    expect(ifo.entries.length).toBe(2767)
    expect(ifo.entries.every((e, i) => e.index === i)).toBe(true)
    expect(cpdFailures).toEqual([])
    expect(cpds.size).toBe(70)
  })

  it('holds field invariants in every placement', () => {
    const bad: string[] = []
    const check = (ok: boolean, what: string) => {
      if (!ok && bad.length < 40) bad.push(what)
    }
    const stats = {
      records: new Map() as Counter, staticFlag: new Map() as Counter, unknown0: new Map() as Counter,
      group: new Map() as Counter, yaw: new Map() as Counter, owner: new Map() as Counter,
    }
    const outOfBlock: string[] = []
    let yawMin = Infinity
    let yawMax = -Infinity
    for (const r of regions.values()) {
      for (const kind of ['o', 'o2'] as const) {
        const mo = r[kind]
        if (!mo) continue
        for (const p of records(mo)) {
          const where = `${r.z}/${r.x}.${kind} uid ${hex(p.uid)}`
          inc(stats.records, `.${kind}`)
          inc(stats.group, `.${kind} g${p.group}`)
          check(p.objId < ifo.entries.length, `${where}: objId ${p.objId}`)
          check(p.position.every(Number.isFinite) && Number.isFinite(p.yaw), `${where}: not finite`)
          check(p.isBig <= 1 && p.isStruct <= 1, `${where}: isBig ${p.isBig} isStruct ${p.isStruct}`)
          check(p.group >= 2, `${where}: group ${p.group}`)
          check(((p.uid >> 8) & 3) === 0 && (p.uid & 0xff) !== 0, `${where}: uid bits`)
          yawMin = Math.min(yawMin, p.yaw)
          yawMax = Math.max(yawMax, p.yaw)
          if (kind === 'o2') {
            const owner = mapoRegionCoords(p.regionId!)
            check(!owner.dungeon, `${where}: dungeon bit`)
            const d = Math.max(Math.abs(owner.x - r.x), Math.abs(owner.z - r.z))
            inc(stats.owner, d === 0 ? 'own' : `${d} away`)
            continue
          }
          // .o only (one entry per object): yaw units, static flag, block membership.
          const q = p.yaw / (Math.PI / 2)
          const deg = (p.yaw * 180) / Math.PI
          inc(stats.yaw, Math.abs(q - Math.round(q)) < 1e-4 ? 'k*pi/2' : Math.abs(deg - Math.round(deg)) < 1e-3 ? 'whole degrees' : 'other')
          inc(stats.staticFlag, p.staticFlag === MAPO_STATIC ? '0xffff' : p.staticFlag === 0 ? '0' : 'other')
          inc(stats.unknown0, p.unknown0 === 0 ? '0' : hex(p.unknown0))
          const block = mo.blocks[p.block]!
          const { blockX, blockZ } = mapoUidParts(p.uid)
          check(blockX === block.x && blockZ === block.z, `${where}: uid block ${blockX},${blockZ} listed in ${block.x},${block.z}`)
          const [x, , z] = p.position
          check(x >= 0 && x < MAPO_REGION_SIZE && z >= 0 && z < MAPO_REGION_SIZE, `${where}: position ${p.position}`)
          if (Math.floor(x / MAPO_BLOCK_SIZE) !== block.x || Math.floor(z / MAPO_BLOCK_SIZE) !== block.z) {
            // Distance from the listing block's cell: objects exactly on a block edge round either way.
            const dx = Math.max(block.x * MAPO_BLOCK_SIZE - x, x - (block.x + 1) * MAPO_BLOCK_SIZE, 0)
            const dz = Math.max(block.z * MAPO_BLOCK_SIZE - z, z - (block.z + 1) * MAPO_BLOCK_SIZE, 0)
            outOfBlock.push(`${where} at (${x}, ${z}) listed in block ${block.x},${block.z}, ${Math.hypot(dx, dz).toExponential(1)} away`)
            check(Math.hypot(dx, dz) < 0.01, `${where}: outside its block by ${Math.hypot(dx, dz)} at ${x}, ${z}`)
          }
        }
      }
    }
    expect(bad).toEqual([])
    const top = (m: Counter, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}: ${v}`).join(', ')
    console.log(`  records ${table(stats.records)}; groups ${table(stats.group)}`)
    console.log(`  .o yaw ${yawMin.toFixed(2)}..${yawMax.toFixed(2)} rad: ${table(stats.yaw)}`)
    console.log(`  .o static flag ${table(stats.staticFlag)}; unknown0 (top) ${top(stats.unknown0, 6)}`)
    console.log(`  .o2 record owner vs file (Chebyshev distance): ${table(stats.owner)}`)
    console.log(`  .o positions on the edge of their listing block: ${outOfBlock.length}`)
    for (const s of outOfBlock) console.log(`      ${s}`)
    expect(stats.records.get('.o')).toBe(50156)
    expect(stats.records.get('.o2')).toBe(151053)
    // Region-local positions: every object lies in the block that lists it (block-local would not);
    // 4 sit on a block edge, less than 0.01 units outside.
    expect(outOfBlock.length).toBe(4)
    // Radians: most yaws are exact multiples of pi/2 or whole degrees.
    expect((stats.yaw.get('k*pi/2') ?? 0) + (stats.yaw.get('whole degrees') ?? 0)).toBeGreaterThan(0.9 * 50156)
  })

  it('stands objects on the .m terrain: x/z order, region-local origin and the .o2 owner frame', () => {
    // Independent ground truth for the position convention: the terrain height under an object.
    const grids = new Map<number, Float32Array | null>()
    const terrain = (wx: number, wz: number): number | null => {
      const rx = Math.floor(wx / MAPO_REGION_SIZE)
      const rz = Math.floor(wz / MAPO_REGION_SIZE)
      const id = mapoRegionId(rx, rz)
      if (!grids.has(id)) {
        const path = `${rz}/${rx}.m`
        grids.set(id, rx >= 0 && rz >= 0 && map.has(path) ? readMapMHeights(map.read(path)) : null)
      }
      const g = grids.get(id)
      if (!g) return null
      const lx = (wx - rx * MAPO_REGION_SIZE) / 20
      const lz = (wz - rz * MAPO_REGION_SIZE) / 20
      const gx = Math.min(95, Math.floor(lx))
      const gz = Math.min(95, Math.floor(lz))
      const fx = lx - gx
      const fz = lz - gz
      const h = (x: number, z: number) => g[z * 97 + x]!
      return (h(gx, gz) * (1 - fx) + h(gx + 1, gz) * fx) * (1 - fz) + (h(gx, gz + 1) * (1 - fx) + h(gx + 1, gz + 1) * fx) * fz
    }
    const S = MAPO_REGION_SIZE
    type Frame = (x: number, z: number, block: { x: number; z: number }) => [number, number]
    const frames: Record<string, Frame> = {
      'region-local (x, z)': (x, z) => [x, z],
      'swapped (z, x)': (x, z) => [z, x],
      'mirrored x': (x, z) => [S - x, z],
      'mirrored z': (x, z) => [x, S - z],
      'block-local': (x, z, b) => [b.x * MAPO_BLOCK_SIZE + x, b.z * MAPO_BLOCK_SIZE + z],
    }
    const onGround: Counter = new Map()
    const evaluated: Counter = new Map()
    const tally = (what: string, y: number, h: number | null) => {
      if (h === null) return
      inc(evaluated, what)
      inc(onGround, what, Math.abs(y - h) < 5 ? 1 : 0)
    }
    for (const r of regions.values()) {
      if (r.o) {
        for (const p of records(r.o)) {
          const [x, y, z] = p.position
          for (const [name, f] of Object.entries(frames)) {
            const [lx, lz] = f(x, z, r.o.blocks[p.block]!)
            tally(`.o ${name}`, y, terrain(r.x * S + lx, r.z * S + lz))
          }
        }
      }
      if (r.o2) {
        // Records owned by a neighbour: relative to the owner region (regionId), not to the file's region.
        for (const p of records(r.o2)) {
          if (p.regionId === r.id) continue
          const owner = mapoRegionCoords(p.regionId!)
          const [x, y, z] = p.position
          tally('.o2 neighbour-owned, owner frame', y, terrain(owner.x * S + x, owner.z * S + z))
          tally('.o2 neighbour-owned, file frame', y, terrain(r.x * S + x, r.z * S + z))
        }
      }
    }
    const share = (what: string) => (onGround.get(what) ?? 0) / (evaluated.get(what) ?? 1)
    for (const what of evaluated.keys()) {
      console.log(`  |y - terrain| < 5: ${String(what).padEnd(40)} ${onGround.get(what)}/${evaluated.get(what)} (${(100 * share(String(what))).toFixed(1)}%)`)
    }
    const right = share('.o region-local (x, z)')
    expect(evaluated.get('.o region-local (x, z)')).toBeGreaterThan(49000)
    expect(right).toBeGreaterThan(0.6)
    for (const name of Object.keys(frames).slice(1)) {
      expect(share(`.o ${name}`)).toBeLessThan(0.3)
      expect(right).toBeGreaterThan(2 * share(`.o ${name}`))
    }
    expect(share('.o2 neighbour-owned, owner frame')).toBeGreaterThan(3 * share('.o2 neighbour-owned, file frame'))
  })

  it('keys objects by (regionId, uid): the dedupe rule for .o2', () => {
    let regionsWithBoth = 0
    const mismatches: string[] = []
    const repeats: Counter = new Map()
    const owners = new Map<number, { isBig: number; files: Set<number> }>()
    let oOnlyObjects = 0
    for (const r of regions.values()) {
      const oRecs = r.o ? records(r.o) : []
      // .o: every uid exactly once.
      const oUids = new Set(oRecs.map(p => p.uid))
      if (oUids.size !== oRecs.length) mismatches.push(`${r.z}/${r.x}.o repeats a uid`)
      if (!r.o2) {
        oOnlyObjects += oRecs.length
        continue
      }
      // .o2: repeats of one (regionId, uid) are identical in every field but the block.
      const first = new Map<number, MapObjectInstance>()
      for (const p of records(r.o2)) {
        const k = key(p.regionId!, p.uid)
        const f = first.get(k)
        if (!f) {
          first.set(k, p)
          const e = owners.get(k) ?? { isBig: p.isBig, files: new Set<number>() }
          e.files.add(r.id)
          owners.set(k, e)
        } else if (JSON.stringify({ ...f, block: 0 }) !== JSON.stringify({ ...p, block: 0 })) {
          mismatches.push(`${r.z}/${r.x}.o2 ${hex(p.regionId!)}:${hex(p.uid)} differs between blocks`)
        }
      }
      if (!r.o) continue
      regionsWithBoth++
      // The records the .o2 owns, deduplicated, are exactly the .o (same order is not required).
      const own = mapoInstances(r.o2, r.id)
      const strip = (p: MapObjectInstance) => JSON.stringify({ ...p, regionId: null, block: 0 })
      const a = oRecs.map(strip).sort()
      const b = own.map(strip).sort()
      if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push(`${r.z}/${r.x}: own .o2 set != .o (${own.length} vs ${oRecs.length})`)
    }
    // Every object is also listed by its owner's own .o2.
    const unlisted = [...owners].filter(([k, e]) => !e.files.has(Math.floor(k / 0x10000)))
    for (const e of owners.values()) inc(repeats, `isBig=${e.isBig} in ${e.files.size >= 5 ? '5+' : e.files.size} region file(s)`)
    console.log(`  ${regionsWithBoth} regions have .o and .o2; ${owners.size} distinct (regionId, uid) across all .o2`)
    console.log(`  objects repeated across region .o2 files: ${table(repeats)}`)
    console.log(`  ${regions.size - regionsWithBoth} regions have only a .o, holding ${oOnlyObjects} objects`)
    expect(mismatches).toEqual([])
    expect(unlisted.length).toBe(0)
    expect(owners.size).toBe(50050)
    expect(oOnlyObjects).toBe(106)
    // isBig does not predict repetition: many non-big objects span regions, some big ones do not.
    const multi = [...owners.values()].filter(e => e.files.size > 1)
    expect(multi.filter(e => e.isBig === 0).length).toBeGreaterThan(1000)
    expect([...owners.values()].filter(e => e.isBig === 1 && e.files.size === 1).length).toBeGreaterThan(0)
  })

  it('resolves object.ifo and compound resource paths in Data.pk2', () => {
    const used: Counter = new Map()
    for (const r of regions.values()) for (const mo of [r.o, r.o2]) if (mo) for (const p of records(mo)) inc(used, p.objId)
    const ext: Counter = new Map()
    const missing: string[] = []
    const missingUsed: string[] = []
    for (const e of ifo.entries) {
      inc(ext, (/\.([a-z0-9]+)$/i.exec(e.path)?.[1] ?? '?').toLowerCase())
      if (data.has(e.path)) continue
      missing.push(`${e.index} ${e.path}`)
      if (used.has(e.index)) missingUsed.push(`${e.index} ${e.path} (${used.get(e.index)} records)`)
    }
    const usedIds = [...used.keys()] as number[]
    const usedResolved = usedIds.filter(id => data.has(ifo.byIndex.get(id)!.path)).length
    console.log(`  object.ifo paths: ${table(ext)}; ${ifo.entries.length - missing.length}/${ifo.entries.length} resolve`)
    console.log(`  referenced by placements: ${usedIds.length} ObjIDs, ${usedResolved} resolve (${((100 * usedResolved) / usedIds.length).toFixed(2)}%)`)
    for (const m of missingUsed.slice(0, 20)) console.log(`      unresolved (used) ${m}`)
    for (const m of missing.filter(m => !missingUsed.some(u => u.startsWith(m))).slice(0, 10)) console.log(`      unresolved (unused) ${m}`)

    // Compounds: every BSR inside every referenced .cpd, then every .cpd of Data.pk2.
    const flags: Counter = new Map()
    for (const e of ifo.entries) inc(flags, `flags ${e.flags}`)
    const referencedCpd = usedIds.map(id => ifo.byIndex.get(id)!.path).filter(p => /\.cpd$/i.test(p))
    let childRefs = 0
    const childMissing: string[] = []
    for (const p of referencedCpd) {
      const cpd = cpds.get(normalizePk2Path(p))
      if (!cpd) continue
      for (const child of cpdReferencedPaths(cpd)) {
        childRefs++
        if (!data.has(child)) childMissing.push(`${p}: ${child}`)
      }
    }
    const allMissing: string[] = []
    const types: Counter = new Map()
    for (const [path, cpd] of cpds) {
      inc(types, `${cpd.typeName}/${cpd.categoryName}${cpd.collisionPath ? ' +collision' : ''}`)
      for (const child of cpdReferencedPaths(cpd)) if (!data.has(child)) allMissing.push(`${path}: ${child}`)
    }
    console.log(`  object.ifo ${table(flags)}`)
    console.log(`  placements use ${referencedCpd.length} .cpd ObjIDs; their ${childRefs} BSR references: ${childRefs - childMissing.length} resolve`)
    console.log(`  all .cpd: ${table(types)}; ${allMissing.length} dangling child paths, e.g. ${allMissing.slice(0, 3).join('; ')}`)
    expect(usedResolved).toBe(usedIds.length)
    expect(childMissing).toEqual([])
    // Dangling in the retail data: equipment of the test character compounds compound/char/china/*.cpd.
    expect(Object.fromEntries(types)).toEqual({
      'BUILDING/COMPOUND': 29,
      'BUILDING/COMPOUND +collision': 27,
      'CHARACTER/COMPOUND': 14,
    })
    // Children share the compound's origin, except attachables of character compounds (socket rule).
    const attach: Counter = new Map()
    for (const cpd of cpds.values()) {
      for (const child of cpd.resourcePaths) {
        const bone = data.has(child) ? parseBsr(data.read(child)).skeleton?.attachBone : undefined
        if (bone) inc(attach, `${cpd.typeName} ${bone}`)
      }
    }
    console.log(`  .cpd children naming an attach bone: ${table(attach)}`)
    expect(Object.fromEntries(attach)).toEqual({
      'CHARACTER Bip01 R HandMid': 5,
      'CHARACTER Bip01 L Hand': 1,
      'CHARACTER Bip01 Head': 1,
      'CHARACTER Bip01 Neck1': 1,
    })
    expect(allMissing.length).toBe(41)
    expect(allMissing.every(m => m.startsWith('compound/char/china/'))).toBe(true)
  })

  it('matches objectstring.ifo and objext.ifo against the placements', () => {
    const strings = parseObjectStringIfo(map.read('objectstring.ifo'))
    const ext = parseObjectExtIfo(map.read('objext.ifo'))
    const byKey = new Map<number, MapObjectInstance>()
    for (const r of regions.values()) if (r.o) for (const p of records(r.o)) byKey.set(key(r.id, p.uid), p)
    const structs = [...regions.values()].flatMap(r => (r.o ? records(r.o).filter(p => p.isStruct).map(p => key(r.id, p.uid)) : []))
    const named = new Set(strings.entries.map(e => key(e.regionId, e.uid)))
    const dungeon = strings.entries.filter(e => e.regionId === 0xffff)
    const result: Counter = new Map()
    const moved: string[] = []
    for (const e of strings.entries) {
      if (e.regionId === 0xffff) continue
      const p = byKey.get(key(e.regionId, e.uid))
      if (!p) {
        inc(result, 'no placement')
        continue
      }
      expect([e.regionX, e.regionZ]).toEqual([e.regionId & 0xff, e.regionId >> 8])
      expect(p.isStruct).toBe(1)
      expect(e.yaw).toBe(p.yaw)
      const same = e.position.every((v, i) => v === p.position[i])
      inc(result, same ? 'same position' : 'one region off')
      if (!same) {
        // Seven fortress gates are stored relative to a neighbouring region: off by exactly 1920 in x.
        const dx = e.position[0] - p.position[0]
        moved.push(`${e.name}: ${e.position.map(v => v.toFixed(1))} vs ${p.position.map(v => v.toFixed(1))}`)
        expect(Math.abs(Math.abs(dx) - MAPO_REGION_SIZE)).toBeLessThan(1e-3)
        expect([e.position[1], e.position[2]]).toEqual([p.position[1], p.position[2]])
      }
    }
    console.log(`  objectstring.ifo: ${strings.entries.length} entries, ${dungeon.length} in dungeons (region 0xFFFF); ${table(result)}`)
    for (const m of moved) console.log(`      ${m}`)
    console.log(`  objext.ifo: ${ext.entries.map(e => `${hex(e.regionId)}:${hex(e.uid)} "${e.unknown}" "${e.value}"`).join(', ')}`)
    // Every placement flagged isStruct is named, and the dungeon entries give a dungeon region (z = 128).
    expect(structs.filter(k => !named.has(k))).toEqual([])
    expect(Object.fromEntries(result)).toEqual({ 'same position': 85, 'one region off': 7, 'no placement': 2 })
    expect(dungeon.every(e => e.regionZ === 128)).toBe(true)
    expect([strings.entries.length, dungeon.length]).toEqual([189, 95])
  })

  it('agrees with the .nvm object lists and object-edge links (yaw turns +X toward +Z)', () => {
    let compared = 0
    const mismatches: string[] = []
    const linkDist = { yaw: [] as number[], mirrored: [] as number[] }
    let cellObjects = 0
    const cellMisses = { yaw: 0, mirrored: 0 }
    const segDist = (p: number[], a: number[], b: number[]) => {
      const dx = b[0]! - a[0]!
      const dz = b[1]! - a[1]!
      const len2 = dx * dx + dz * dz
      const t = len2 ? Math.max(0, Math.min(1, ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dz) / len2)) : 0
      return Math.hypot(p[0]! - a[0]! - t * dx, p[1]! - a[1]! - t * dz)
    }
    const place = (o: NvmHead['objects'][number], nav: BmsNavMesh, vertex: number, sign: number) => {
      const v = bskMath.quatRotate(mapoYawQuat(sign * o.yaw), [nav.vertices[vertex * 3]!, nav.vertices[vertex * 3 + 1]!, nav.vertices[vertex * 3 + 2]!])
      return [o.position[0] + v[0], o.position[2] + v[2]]
    }
    const edge = (o: NvmHead['objects'][number], nav: BmsNavMesh, e: number, sign: number) =>
      [place(o, nav, nav.outlineEdges.vertices[e * 2]!, sign), place(o, nav, nav.outlineEdges.vertices[e * 2 + 1]!, sign)]

    for (const r of regions.values()) {
      const nvPath = `navmesh/nv_${r.id.toString(16).padStart(4, '0')}.nvm`
      if (!r.o2 || !data.has(nvPath)) continue
      const nvm = readNvmHead(data.read(nvPath))
      // The navmesh object list = the .o2 objects with a collision navmesh, in first-appearance order,
      // positions re-expressed relative to this region.
      const expected = mapoInstances(r.o2).filter(p => navMeshOf(p.objId) !== null)
      compared++
      const same = (o: NvmHead['objects'][number], p: MapObjectInstance) => {
        const pos = mapoPositionInRegion(p, r.id)
        return o.objId === p.objId && o.staticFlag === p.staticFlag && o.yaw === p.yaw && o.uid === p.uid &&
          o.unknown0 === p.unknown0 && o.isBig === p.isBig && o.isStruct === p.isStruct && o.regionId === p.regionId &&
          o.position.every((v, i) => Math.abs(v - pos[i]!) < 1e-3)
      }
      if (nvm.objects.length !== expected.length || !nvm.objects.every((o, i) => same(o, expected[i]!))) {
        mismatches.push(`${nvPath}: ${nvm.objects.length} objects vs ${expected.length} expected`)
        continue
      }
      // Linked object edges meet in world space only with the right yaw convention.
      for (const a of nvm.objects) {
        for (const [linked, linkedEdge, ownEdge] of a.links) {
          if (linked < 0) continue
          const b = nvm.objects[linked]!
          const na = navMeshOf(a.objId)!
          const nb = navMeshOf(b.objId)!
          for (const [which, sign] of [['yaw', 1], ['mirrored', -1]] as const) {
            const A = edge(a, na, ownEdge, sign)
            const B = edge(b, nb, linkedEdge, sign)
            const d = Math.min(
              Math.max(segDist(A[0]!, B[0]!, B[1]!), segDist(A[1]!, B[0]!, B[1]!)),
              Math.max(segDist(B[0]!, A[0]!, A[1]!), segDist(B[1]!, A[0]!, A[1]!)),
            )
            linkDist[which].push(d)
          }
        }
      }
      // The terrain cells that list an object contain its whole navmesh (inside this region).
      nvm.objects.forEach((o, index) => {
        if (Math.abs(Math.sin(o.yaw)) < 1e-3) return
        const cells = nvm.cells.filter(c => c.objects.includes(index))
        const nav = navMeshOf(o.objId)!
        cellObjects++
        for (const [which, sign] of [['yaw', 1], ['mirrored', -1]] as const) {
          for (let v = 0; v < nav.vertices.length / 3; v++) {
            const [x, z] = place(o, nav, v, sign) as [number, number]
            if (x < 0 || z < 0 || x > MAPO_REGION_SIZE || z > MAPO_REGION_SIZE) continue
            if (!cells.some(c => x >= c.minX - 0.01 && x <= c.maxX + 0.01 && z >= c.minZ - 0.01 && z <= c.maxZ + 0.01)) {
              cellMisses[which]++
              break
            }
          }
        }
      })
    }
    const summary = (d: number[]) => `max ${Math.max(...d).toFixed(2)}, ${d.filter(v => v < 1).length} < 1, ${d.filter(v => v >= 10).length} >= 10`
    console.log(`  .nvm object lists compared: ${compared}; mismatches ${mismatches.length}`)
    console.log(`  object-edge links (${linkDist.yaw.length}): mapoYawQuat ${summary(linkDist.yaw)}; mirrored yaw ${summary(linkDist.mirrored)}`)
    console.log(`  rotated objects vs the terrain cells listing them (${cellObjects}): outside with mapoYawQuat ${cellMisses.yaw}, mirrored ${cellMisses.mirrored}`)
    expect(mismatches).toEqual([])
    expect(compared).toBe(3300)
    expect(linkDist.yaw.length).toBeGreaterThan(200)
    expect(Math.max(...linkDist.yaw)).toBeLessThan(5)
    expect(linkDist.mirrored.filter(v => v >= 10).length).toBeGreaterThan(100)
    expect(cellMisses.yaw).toBe(0)
    expect(cellMisses.mirrored).toBeGreaterThan(50)
  })

  it('reports the Jangan regions (X 167-169, Z 96-98)', () => {
    const allModels: Counter = new Map()
    let total = 0
    const perRegion: number[] = []
    for (const [x, z] of JANGAN) {
      const r = regions.get(mapoRegionId(x, z))!
      expect(r.o && r.o2).toBeTruthy()
      const own = records(r.o!)
      const o2 = records(r.o2!)
      const unique = mapoInstances(r.o2!)
      const ids = new Set(own.map(p => p.objId))
      const models: Counter = new Map()
      for (const p of own) inc(models, normalizePk2Path(ifo.byIndex.get(p.objId)!.path))
      for (const [m, n] of models) inc(allModels, m, n)
      const cpdCount = own.filter(p => /\.cpd$/i.test(ifo.byIndex.get(p.objId)!.path)).length
      const groups: Counter = new Map()
      for (const p of own) inc(groups, `g${p.group}`)
      const big = own.filter(p => p.isBig).length
      const named = own.filter(p => p.isStruct).length
      total += own.length
      perRegion.push(own.length)
      console.log(
        `  ${z}/${x} (${hex(r.id)}): .o ${own.length} placements (${table(groups)}, isBig ${big}, isStruct ${named}), ` +
          `${ids.size} ObjIDs, ${models.size} models, ${cpdCount} .cpd; .o2 ${o2.length} records = ${unique.length} objects ` +
          `(${unique.length - mapoInstances(r.o2!, r.id).length} owned by neighbours)`,
      )
    }
    const top = [...allModels].sort((a, b) => b[1] - a[1])
    console.log(`  Jangan total: ${total} placements, ${allModels.size} distinct models; top 30:`)
    for (const [m, n] of top.slice(0, 30)) console.log(`    ${String(n).padStart(4)}  ${m}`)
    const cpdModels = top.filter(([m]) => String(m).endsWith('.cpd'))
    console.log(`  .cpd models in Jangan: ${cpdModels.length ? cpdModels.map(([m, n]) => `${m} x${n}`).join(', ') : 'none'}`)
    // Snapshot of vSRO 1.188 (z 96..98 outer, x 167..169 inner).
    expect(perRegion).toEqual([121, 106, 183, 331, 273, 136, 218, 286, 191])
    expect(total).toBe(1845)
    expect(allModels.size).toBe(202)
  })
})
