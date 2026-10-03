/** Builders for synthetic terrain regions and object navmeshes (unit tests only). */
import { NVM_HEIGHTS, NVM_TILES, type NvmObject } from '@sro/formats'
import type { NavMeshInput, NvmInput } from '../src/index.ts'

export const RX = 100
export const RZ = 100
export const REGION_ID = (RZ << 8) | RX
/** World file-space origin of the synthetic region. */
export const OX = 1920 * RX
export const OZ = 1920 * RZ

/** Flat terrain at `height`; tiles for which closed(tx, tz) is true use the closed cell 1. */
export function flatRegion(height = 0, closed: (tx: number, tz: number) => boolean = () => false): NvmInput {
  const tileCells = new Int32Array(NVM_TILES * NVM_TILES)
  for (let tz = 0; tz < NVM_TILES; tz++) for (let tx = 0; tx < NVM_TILES; tx++) tileCells[tz * NVM_TILES + tx] = closed(tx, tz) ? 1 : 0
  return {
    objects: [],
    openCellCount: 1,
    tileCells,
    heights: new Float32Array(NVM_HEIGHTS * NVM_HEIGHTS).fill(height),
  }
}

export function placement(objId: number, localUid: number, x: number, y: number, z: number, yaw = 0,
  links: NvmObject['links'] = []): NvmObject {
  return {
    objId, position: [x, y, z], type: -1, yaw, localUid, unknownShort0: 0, isBig: false, isStruct: false,
    regionId: REGION_ID, links,
  }
}

/**
 * Navmesh from vertices [x, y, z][] and triangles; edges are derived: a side shared by two triangles is an inline
 * edge (src = the lower cell) with inlineFlag(a, b) (default 4), a boundary side an outline edge with outlineFlag.
 * Returns the mesh and the outline edge index of each boundary vertex pair ('a,b' with a < b).
 */
export function mesh(vertices: [number, number, number][], triangles: [number, number, number][],
  outlineFlag: (a: number, b: number) => number = () => 0,
  inlineFlag: (a: number, b: number) => number = () => 4): { nav: NavMeshInput; outlineIndex: Map<string, number> } {
  const sides = new Map<string, number[]>()
  triangles.forEach((t, c) => {
    for (let k = 0; k < 3; k++) {
      const a = t[k]!, b = t[(k + 1) % 3]!
      const key = a < b ? `${a},${b}` : `${b},${a}`
      const list = sides.get(key) ?? []
      list.push(c)
      sides.set(key, list)
    }
  })
  const ov: number[] = [], oc: number[] = [], of: number[] = []
  const iv: number[] = [], ic: number[] = [], inf: number[] = []
  const outlineIndex = new Map<string, number>()
  for (const [key, cells] of sides) {
    const [a, b] = key.split(',').map(Number) as [number, number]
    if (cells.length === 1) {
      outlineIndex.set(key, of.length)
      ov.push(a, b); oc.push(cells[0]!, 0xffff); of.push(outlineFlag(a, b))
    } else {
      iv.push(a, b); ic.push(cells[0]!, cells[1]!); inf.push(inlineFlag(a, b))
    }
  }
  return {
    nav: {
      vertices: Float32Array.from(vertices.flat()),
      cells: Uint16Array.from(triangles.flat()),
      outlineEdges: { vertices: Uint16Array.from(ov), cells: Uint16Array.from(oc), flags: Uint8Array.from(of) },
      inlineEdges: { vertices: Uint16Array.from(iv), cells: Uint16Array.from(ic), flags: Uint8Array.from(inf) },
      events: [],
    },
    outlineIndex,
  }
}

/** Axis-aligned rectangle [x0, x1] x [z0, z1] as a grid of nx x nz quads (2 triangles each), height y(x, z). */
export function grid(x0: number, x1: number, z0: number, z1: number, nx: number, nz: number,
  y: (x: number, z: number) => number = () => 0): { vertices: [number, number, number][]; triangles: [number, number, number][] } {
  const vertices: [number, number, number][] = []
  const triangles: [number, number, number][] = []
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx
      const z = z0 + ((z1 - z0) * j) / nz
      vertices.push([x, y(x, z), z])
    }
  }
  const v = (i: number, j: number) => j * (nx + 1) + i
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      triangles.push([v(i, j), v(i, j + 1), v(i + 1, j + 1)])
      triangles.push([v(i, j), v(i + 1, j + 1), v(i + 1, j)])
    }
  }
  return { vertices, triangles }
}
