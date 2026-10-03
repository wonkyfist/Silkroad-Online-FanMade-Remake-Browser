/**
 * Fixtures for the world-edits tests (WE-D): a synthetic .m region, a tiny glb writer, models and placements.
 */
import type { MapMBlock, MapMFile } from '@sro/formats'
import { assembleRegionGrid } from '@sro/formats'
import type { RegionTerrain } from '../src/world/edits-hook.ts'
import type { WorldModel, WorldPlacement, WorldRegion } from '../src/world/manifest.ts'

export const ORIGIN = { x: 168, z: 97 }

/** A region whose vertex (gx, gz) has file-unit height `h(ggx, ggz)` and texture word `w(ggx, ggz)` (global lattice). */
export function regionTerrain(rx: number, rz: number, h: (ggx: number, ggz: number) => number, w: (ggx: number, ggz: number) => number = () => 1,
  water: (bx: number, bz: number) => { type: number; height: number } | null = () => null): RegionTerrain {
  const blocks: MapMBlock[] = []
  for (let bz = 0; bz < 6; bz++) {
    for (let bx = 0; bx < 6; bx++) {
      const heights = new Float32Array(289)
      const textures = new Uint16Array(289)
      for (let vz = 0; vz < 17; vz++) {
        for (let vx = 0; vx < 17; vx++) {
          const ggx = rx * 96 + bx * 16 + vx
          const ggz = rz * 96 + bz * 16 + vz
          heights[vz * 17 + vx] = h(ggx, ggz)
          textures[vz * 17 + vx] = w(ggx, ggz)
        }
      }
      const wt = water(bx, bz)
      blocks.push({
        index: bz * 6 + bx, bx, bz, flag: 0, environmentId: 1, heights, textures,
        textureIds: textures.map(t => t & 0x3ff), textureHighBits: Uint8Array.from(textures, t => t >>> 10), brightness: new Uint8Array(289),
        waterType: wt ? wt.type : -1, waterWaveType: wt ? 2 : 0, waterHeight: wt ? wt.height : 0, tileFlags: new Uint16Array(256),
        heightMax: Math.max(...heights), heightMin: Math.min(...heights), unknown: new Uint8Array(20),
      })
    }
  }
  const mapm: MapMFile = { signature: 'JMXVMAPM1000', blocks }
  return { mapm, grid: assembleRegionGrid(mapm) }
}

export const regionEntry = (x: number, z: number, heightMaxM = 10): WorldRegion => ({
  x, z, id: (z << 8) | x,
  origin: [192 * (x - ORIGIN.x), 0, -192 * (z - ORIGIN.z)],
  bounds: { min: [192 * (x - ORIGIN.x), 0, -192 * (z - ORIGIN.z) - 192], max: [192 * (x - ORIGIN.x) + 192, heightMaxM, -192 * (z - ORIGIN.z)] },
  terrain: { file: `terrain/${x}_${z}.bin`, bytes: 1, heightMinM: 0, heightMaxM, layerCount: 1, tileIds: [1] },
  lightmap: { file: `terrain/${x}_${z}_lightmap.png`, width: 512, height: 512 },
  minimap: `minimap/${x}x${z}.png`,
  blocks: Array.from({ length: 36 }, (_, k) => ({ bx: k % 6, bz: Math.floor(k / 6), flag: 0, environmentId: 0, water: null })),
  navmesh: null,
})

export const model = (index: number, source: string, extra: Partial<WorldModel> = {}): WorldModel => ({
  index, source, glb: `models/m${index}.glb`, sidecar: `models/m${index}.json`, kind: 'static', animations: [], defaultClip: null,
  lightmappedMeshes: 0, boundsMin: [-1, 0, -1], boundsMax: [1, 6, 1], bytes: 100, validatorErrors: 0, ...extra,
})

export const placement = (region: number, uid: number, models: number[], source: string, position: [number, number, number],
  objId = 100 + uid): WorldPlacement => ({
  objId, source, models, compound: false, position, rotation: [0, 0, 0, 1], yaw: 0,
  flags: { static: true, big: false, struct: false }, staticFlag: 0xffff, uid, region, group: 3, inConvertedRegion: true,
})

/** A mesh of the glb writer: positions, indices, optional uvs and an alpha-tested material. */
export interface FixtureMesh {
  positions: number[]
  indices: number[]
  uvs?: number[]
  masked?: boolean
}

/** A .glb with one node per mesh (TRS `translation` optional, `tier` written as extras.sroTier). */
export function writeGlb(nodes: Array<{ mesh: FixtureMesh; translation?: [number, number, number]; tier?: number }>): Uint8Array {
  const chunks: Uint8Array[] = []
  let offset = 0
  const views: Array<{ buffer: number; byteOffset: number; byteLength: number }> = []
  const add = (bytes: Uint8Array) => {
    const pad = (4 - (bytes.byteLength % 4)) % 4
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength })
    chunks.push(bytes, new Uint8Array(pad))
    offset += bytes.byteLength + pad
    return views.length - 1
  }
  const accessors: unknown[] = []
  const meshes: unknown[] = []
  const gltfNodes: unknown[] = []
  const image = add(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  for (const n of nodes) {
    const pos = new Float32Array(n.mesh.positions)
    const min = [0, 1, 2].map(c => Math.min(...n.mesh.positions.filter((_, i) => i % 3 === c)))
    const max = [0, 1, 2].map(c => Math.max(...n.mesh.positions.filter((_, i) => i % 3 === c)))
    accessors.push({ bufferView: add(new Uint8Array(pos.buffer)), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max })
    const attributes: Record<string, number> = { POSITION: accessors.length - 1 }
    accessors.push({ bufferView: add(new Uint8Array(new Uint16Array(n.mesh.indices).buffer)), componentType: 5123, count: n.mesh.indices.length, type: 'SCALAR' })
    const indices = accessors.length - 1
    if (n.mesh.uvs) {
      accessors.push({ bufferView: add(new Uint8Array(new Float32Array(n.mesh.uvs).buffer)), componentType: 5126, count: n.mesh.uvs.length / 2, type: 'VEC2' })
      attributes.TEXCOORD_0 = accessors.length - 1
    }
    meshes.push({ primitives: [{ attributes, indices, material: n.mesh.masked ? 1 : 0, mode: 4 }] })
    gltfNodes.push({ mesh: meshes.length - 1, ...(n.translation ? { translation: n.translation } : {}), ...(n.tier !== undefined ? { extras: { sroTier: n.tier } } : {}) })
  }
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: gltfNodes.map((_, i) => i) }], nodes: gltfNodes, meshes, accessors,
    bufferViews: views, buffers: [{ byteLength: offset }],
    materials: [{ name: 'bark' }, { name: 'leaf', alphaMode: 'MASK', alphaCutoff: 0.5, pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }], images: [{ bufferView: image, mimeType: 'image/png' }],
  }
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4
  const bin = new Uint8Array(offset)
  let o = 0
  for (const c of chunks) {
    bin.set(c, o)
    o += c.byteLength
  }
  const total = 12 + 8 + jsonBytes.byteLength + jsonPad + 8 + bin.byteLength
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonBytes.byteLength + jsonPad, true)
  dv.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonBytes.byteLength + jsonPad)
  const b = 20 + jsonBytes.byteLength + jsonPad
  dv.setUint32(b, bin.byteLength, true)
  dv.setUint32(b + 4, 0x004e4942, true)
  out.set(bin, b + 8)
  return out
}

/** An axis-aligned box mesh (12 triangles). */
export function boxMesh(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): FixtureMesh {
  const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
  const f = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]]
  const indices: number[] = []
  for (const [a, b, c, d] of f) indices.push(a!, b!, c!, a!, c!, d!)
  return { positions: p.flat(), indices }
}

/** A horizontal leaf card (a square at height y, half side s) with uvs 0..1. */
export function cardMesh(y: number, s: number, masked = true): FixtureMesh {
  return { positions: [-s, y, -s, s, y, -s, s, y, s, -s, y, s], indices: [0, 1, 2, 0, 2, 3], uvs: [0, 0, 1, 0, 1, 1, 0, 1], masked }
}
