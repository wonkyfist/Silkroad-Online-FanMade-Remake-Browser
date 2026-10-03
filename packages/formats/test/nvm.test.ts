import { describe, expect, it } from 'vitest'
import {
  NVM_EDGE_FLAG, NVM_PLANE_TYPE, NVM_TILES, nvmCellAt, nvmHeightAt, nvmPlaneIndexAt, nvmTerrainHeightAt, parseNvm,
  type NvmFile,
} from '../src/nvm.ts'

class Writer {
  private readonly parts: number[] = []
  u8(v: number): this {
    this.parts.push(v & 0xff)
    return this
  }
  u16(v: number): this {
    return this.u8(v).u8(v >>> 8)
  }
  u32(v: number): this {
    return this.u16(v & 0xffff).u16(v >>> 16)
  }
  f32(v: number): this {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setFloat32(0, v, true)
    this.parts.push(...b)
    return this
  }
  ascii(s: string): this {
    for (const c of s) this.u8(c.charCodeAt(0))
    return this
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

interface Spec {
  signature?: string
  cells?: Array<[number, number, number, number, number[]]>
  openCells?: number
  objectIndexOverride?: number
  tileRecord?: 8 | 4
  planes?: boolean
  tileCell?: (tx: number, tz: number) => number
  height?: (x: number, z: number) => number
  planeTypes?: number[]
  planeHeights?: number[]
  trailerDelta?: number
}

/** One object with one link, the given cells, one global and two internal edges, then the maps. */
function build(spec: Spec = {}): Uint8Array {
  const w = new Writer().ascii(spec.signature ?? 'JMXVNVM 1000')
  w.u16(1)
  w.u32(702).f32(860.5).f32(-1.75).f32(-155.5).u16(0xffff).f32(1.5).u16(0xa801).u16(7).u8(1).u8(0).u16(0x60a8)
  w.u16(1).u16(0xffff).u16(3).u16(4)
  const cells = spec.cells ?? [
    [0, 0, 960, 1920, [0]],
    [960, 0, 1920, 1920, []],
  ]
  w.u32(cells.length).u32(spec.openCells ?? 1)
  for (const [minX, minZ, maxX, maxZ, objects] of cells) {
    w.f32(minX).f32(minZ).f32(maxX).f32(maxZ).u8(objects.length)
    for (const o of objects) w.u16(spec.objectIndexOverride ?? o)
  }
  w.u32(1).f32(0).f32(1920).f32(960).f32(1920).u8(8).u8(0).u8(2).u16(0).u16(5).u16(0x61a8).u16(0x62a8)
  w.u32(2)
  w.f32(960).f32(0).f32(960).f32(1920).u8(4).u8(1).u8(3).u16(0).u16(1)
  w.f32(0).f32(0).f32(0).f32(1920).u8(2).u8(3).u8(0xff).u16(0).u16(0xffff)
  const tileCell = spec.tileCell ?? ((tx: number) => (tx < 48 ? 0 : 1))
  for (let tz = 0; tz < NVM_TILES; tz++) {
    for (let tx = 0; tx < NVM_TILES; tx++) {
      const cell = tileCell(tx, tz)
      const flag = cell >= (spec.openCells ?? 1) ? 1 : 0
      if (spec.tileRecord === 4) w.u16(cell).u16(flag)
      else w.u32(cell).u16(flag | 0x400).u16(tx + tz)
    }
  }
  const height = spec.height ?? ((x: number, z: number) => x + 1000 * z)
  for (let z = 0; z < 97; z++) for (let x = 0; x < 97; x++) w.f32(height(x, z))
  if (spec.planes !== false) {
    for (let i = 0; i < 36; i++) w.u8(spec.planeTypes?.[i] ?? 0)
    for (let i = 0; i < 36; i++) w.f32(spec.planeHeights?.[i] ?? -20)
  }
  const bytes = w.bytes()
  const delta = spec.trailerDelta ?? 0
  if (delta > 0) return Uint8Array.from([...bytes, ...new Uint8Array(delta)])
  return delta < 0 ? bytes.subarray(0, bytes.length + delta) : bytes
}

describe('parseNvm', () => {
  it('parses objects, cells, edges and the maps of a current file', () => {
    const nvm = parseNvm(build({ planeTypes: [NVM_PLANE_TYPE.ice], planeHeights: [5] }))
    expect(nvm.signature).toBe('JMXVNVM 1000')
    expect(nvm.objects).toEqual([
      {
        objId: 702, position: [860.5, -1.75, -155.5], type: -1, yaw: 1.5, localUid: 0xa801, unknownShort0: 7,
        isBig: true, isStruct: false, regionId: 0x60a8, links: [{ linkedObject: -1, linkedObjectEdge: 3, edge: 4 }],
      },
    ])
    expect(nvm.cells).toEqual([
      { minX: 0, minZ: 0, maxX: 960, maxZ: 1920, objects: [0] },
      { minX: 960, minZ: 0, maxX: 1920, maxZ: 1920, objects: [] },
    ])
    expect(nvm.openCellCount).toBe(1)
    expect(nvm.globalEdges).toEqual([
      { ax: 0, az: 1920, bx: 960, bz: 1920, flag: NVM_EDGE_FLAG.global, directions: [0, 2], cells: [0, 5], regions: [0x61a8, 0x62a8] },
    ])
    expect(nvm.internalEdges).toEqual([
      { ax: 960, az: 0, bx: 960, bz: 1920, flag: NVM_EDGE_FLAG.internal, directions: [1, 3], cells: [0, 1] },
      { ax: 0, az: 0, bx: 0, bz: 1920, flag: NVM_EDGE_FLAG.blockSrc2Dst, directions: [3, -1], cells: [0, -1] },
    ])
    expect(nvm.tileRecordSize).toBe(8)
    // z-major: index = tz * 96 + tx.
    expect(nvm.tileCells[5 * 96 + 47]).toBe(0)
    expect(nvm.tileCells[5 * 96 + 48]).toBe(1)
    expect(nvm.tileFlags[48]).toBe(0x401)
    expect(nvm.tileTextures![5 * 96 + 7]).toBe(12)
    expect(nvm.heights[3 * 97 + 2]).toBe(3002)
    expect(nvm.planeTypes![0]).toBe(NVM_PLANE_TYPE.ice)
    expect(nvm.planeHeights![0]).toBe(5)
    expect(nvm.planeHeights![35]).toBe(-20)
  })

  it('reads legacy 4-byte tile records, with and without the plane map', () => {
    const withPlanes = parseNvm(build({ tileRecord: 4 }))
    expect(withPlanes.tileRecordSize).toBe(4)
    expect(withPlanes.tileTextures).toBeUndefined()
    expect(withPlanes.tileCells[48]).toBe(1)
    expect(withPlanes.tileFlags[48]).toBe(1)
    expect(withPlanes.tileFlags[0]).toBe(0)
    expect(withPlanes.heights[96 * 97 + 96]).toBe(96096)
    expect(withPlanes.planeTypes).toHaveLength(36)
    const bare = parseNvm(build({ tileRecord: 4, planes: false }))
    expect(bare.tileRecordSize).toBe(4)
    expect(bare.heights[96 * 97 + 96]).toBe(96096)
    expect(bare.planeTypes).toBeUndefined()
    expect(bare.planeHeights).toBeUndefined()
  })

  it('throws with the offset on malformed input', () => {
    expect(() => parseNvm(build({ signature: 'JMXVNVM 1001' }))).toThrow(/bad signature .* at offset 0/)
    expect(() => parseNvm(build({ trailerDelta: -1 }))).toThrow(/tile\/height\/plane maps need 111544 .* 111543 left at offset \d+/)
    expect(() => parseNvm(build({ trailerDelta: 4 }))).toThrow(/111548 left/)
    expect(() => parseNvm(build({ tileRecord: 4, planes: false, trailerDelta: 1 }))).toThrow(/74501 left/)
    expect(() => parseNvm(build({ objectIndexOverride: 1 }))).toThrow(/cell 0 object index 1 >= 1 at offset \d+/)
    expect(() => parseNvm(build({ openCells: 3 }))).toThrow(/open cell count 3 > 2 at offset \d+/)
    expect(() => parseNvm(build().subarray(0, 40))).toThrow(/NVM: object count 1 overruns file at offset 12/)
    expect(() => parseNvm(build().subarray(0, 50))).toThrow(/NVM: object 0 link count 1 overruns file at offset 44/)
    expect(() => parseNvm(new Uint8Array(5))).toThrow(/NVM: truncated signature/)
  })
})

describe('nvm helpers', () => {
  const nvm = parseNvm(build({ planeTypes: [NVM_PLANE_TYPE.ice, NVM_PLANE_TYPE.water, NVM_PLANE_TYPE.waterIce], planeHeights: [2500, 2500, 2500] }))

  it('interpolates terrain heights on two triangles per tile (split min corner to max corner), clamped', () => {
    // heights[z * 97 + x] = x + 1000 z: any triangulation reproduces the plane h = x / 20 + 50 z.
    expect(nvmTerrainHeightAt(nvm, 0, 0)).toBe(0)
    expect(nvmTerrainHeightAt(nvm, 30, 50)).toBeCloseTo(1.5 + 2500)
    expect(nvmTerrainHeightAt(nvm, 1920, 1920)).toBe(96096)
    expect(nvmTerrainHeightAt(nvm, -100, 5000)).toBe(96000)
    // One raised vertex at (20, 20): the (0,0)-(20,20) tile's diagonal runs up to it.
    const bump = parseNvm(build({ height: (x, z) => (x === 1 && z === 1 ? 4 : 0) }))
    expect(nvmTerrainHeightAt(bump, 20, 20)).toBe(4)
    // On the diagonal of tile (0, 0): 2 (bilinear would give 1, the other split 0).
    expect(nvmTerrainHeightAt(bump, 10, 10)).toBe(2)
    // Below the diagonal (fx 0.75 > fz 0.5): triangle (0,0) (20,0) (20,20) -> 4 * 0.5 (bilinear 1.5, other split 1).
    expect(nvmTerrainHeightAt(bump, 15, 10)).toBe(2)
    // Above the diagonal (fz 0.75 > fx 0.5): triangle (0,0) (0,20) (20,20) -> 4 * 0.5.
    expect(nvmTerrainHeightAt(bump, 10, 15)).toBe(2)
    // Tile (1, 1) starts at the bump: its diagonal runs down from it.
    expect(nvmTerrainHeightAt(bump, 30, 30)).toBe(2)
    expect(nvmTerrainHeightAt(bump, 30, 20)).toBe(2)
    // Tile (0, 1): the bump is its (maxX, minZ) corner, off the diagonal; on the diagonal the height is 0.
    expect(nvmTerrainHeightAt(bump, 10, 30)).toBe(0)
    expect(nvmTerrainHeightAt(bump, 15, 25)).toBe(2)
  })

  it('stands on ice planes (types 2 and 3), not on water, and keeps terrain above the ice', () => {
    expect(nvmPlaneIndexAt(0, 0)).toBe(0)
    expect(nvmPlaneIndexAt(330, 10)).toBe(1)
    expect(nvmPlaneIndexAt(1920, 1920)).toBe(35)
    expect(nvmPlaneIndexAt(10, 640)).toBe(12)
    expect(nvmHeightAt(nvm, 10, 0)).toBe(2500)
    expect(nvmHeightAt(nvm, 330, 0)).toBeCloseTo(16.5)
    expect(nvmHeightAt(nvm, 650, 0)).toBe(2500)
    expect(nvmHeightAt(nvm, 10, 60)).toBeCloseTo(3000.5)
    const bare: Pick<NvmFile, 'heights'> = { heights: nvm.heights }
    expect(nvmHeightAt(bare, 10, 0)).toBeCloseTo(0.5)
  })

  it('finds the cell under a point through the tile map, with a scan fallback', () => {
    expect(nvmCellAt(nvm, 10, 10)).toBe(0)
    expect(nvmCellAt(nvm, 959.9, 1000)).toBe(0)
    expect(nvmCellAt(nvm, 960, 1000)).toBe(1)
    expect(nvmCellAt(nvm, 1920, 1920)).toBe(1)
    expect(nvmCellAt(nvm, -0.1, 10)).toBe(-1)
    expect(nvmCellAt(nvm, 10, 1920.1)).toBe(-1)
    expect(nvmCellAt(nvm, Number.NaN, 10)).toBe(-1)
    const stale = parseNvm(build({ tileCell: () => 1 }))
    expect(nvmCellAt(stale, 10, 10)).toBe(0)
    expect(nvmCellAt(stale, 1000, 10)).toBe(1)
  })
})
