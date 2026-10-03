/**
 * NavData <-> bytes, for shipping to the browser and the server (no BSR/BMS/NVM parsing needed there).
 *
 * 'SRNV' version 1, little-endian. Every section starts 4-byte aligned (zero padding after u8/u16 arrays and
 * strings). Strings are u32 byte length + UTF-8. All coordinates are world/object-local FILE space (data.ts).
 *
 *   header     char[4] 'SRNV', u32 version, u32 regionCount, u32 modelCount, u32 instanceCount, u32 totalBytes
 *   region     u32 id (z << 8 | x), u32 openCellCount, u32 hasPlanes,
 *              f32[97 * 97] heights, i32[96 * 96] tileCells, [u8[36] planeTypes, f32[36] planeHeights]
 *   model      string key, u32 vertexCount, cellCount, outlineCount, inlineCount, eventCount,
 *              f32[3 * vertexCount] vertices, u16[3 * cellCount] cells,
 *              outline: u16[2 n] vertices, u16[2 n] cells, u8[n] flags; inline: the same; eventCount x string
 *   instance   u32 id, u32 objId, u32 model, u32 linkCount, f64 x, f64 y, f64 z, f64 yaw,
 *              linkCount x (u32 edge, u32 target instance, u32 targetEdge)
 */
import { NVM_HEIGHTS, NVM_TILES } from '@sro/formats'
import { NAV_DATA_VERSION, regionCoords, type NavData, type NavEdges, type NavInstance, type NavModel, type NavRegion } from './data.ts'

export const NAV_BIN_MAGIC = 'SRNV'

const HEIGHT_COUNT = NVM_HEIGHTS * NVM_HEIGHTS
const TILE_COUNT = NVM_TILES * NVM_TILES
const PLANE_COUNT = 36

class Writer {
  buf = new Uint8Array(1 << 16)
  view = new DataView(this.buf.buffer)
  at = 0
  private need(n: number): void {
    if (this.at + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.at + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.at))
    this.buf = next
    this.view = new DataView(next.buffer)
  }
  u32(v: number): void { this.need(4); this.view.setUint32(this.at, v >>> 0, true); this.at += 4 }
  i32(v: number): void { this.need(4); this.view.setInt32(this.at, v, true); this.at += 4 }
  f32(v: number): void { this.need(4); this.view.setFloat32(this.at, v, true); this.at += 4 }
  f64(v: number): void { this.need(8); this.view.setFloat64(this.at, v, true); this.at += 8 }
  pad(): void { while (this.at & 3) { this.need(1); this.buf[this.at++] = 0 } }
  u16s(a: ArrayLike<number>): void {
    this.need(a.length * 2)
    for (let i = 0; i < a.length; i++, this.at += 2) this.view.setUint16(this.at, a[i]!, true)
    this.pad()
  }
  u8s(a: ArrayLike<number>): void {
    this.need(a.length)
    for (let i = 0; i < a.length; i++) this.buf[this.at++] = a[i]!
    this.pad()
  }
  f32s(a: ArrayLike<number>): void { for (let i = 0; i < a.length; i++) this.f32(a[i]!) }
  str(s: string): void {
    const b = new TextEncoder().encode(s)
    this.u32(b.length)
    this.u8s(b)
  }
}

class Reader {
  readonly view: DataView
  at = 0
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  private need(n: number, what: string): void {
    if (this.at + n > this.bytes.length) throw new Error(`SRNV: truncated ${what} at offset ${this.at}`)
  }
  u32(what = 'u32'): number { this.need(4, what); const v = this.view.getUint32(this.at, true); this.at += 4; return v }
  f64(): number { this.need(8, 'f64'); const v = this.view.getFloat64(this.at, true); this.at += 8; return v }
  pad(): void { this.at = (this.at + 3) & ~3 }
  f32s(n: number, what: string): Float32Array {
    this.need(n * 4, what)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++, this.at += 4) out[i] = this.view.getFloat32(this.at, true)
    return out
  }
  i32s(n: number, what: string): Int32Array {
    this.need(n * 4, what)
    const out = new Int32Array(n)
    for (let i = 0; i < n; i++, this.at += 4) out[i] = this.view.getInt32(this.at, true)
    return out
  }
  u16s(n: number, what: string): Uint16Array {
    this.need(n * 2, what)
    const out = new Uint16Array(n)
    for (let i = 0; i < n; i++, this.at += 2) out[i] = this.view.getUint16(this.at, true)
    this.pad()
    return out
  }
  u8s(n: number, what: string): Uint8Array {
    this.need(n, what)
    const out = this.bytes.slice(this.at, this.at + n)
    this.at += n
    this.pad()
    return out
  }
  str(what: string): string {
    const n = this.u32(what)
    return new TextDecoder().decode(this.u8s(n, what))
  }
}

export function encodeNavData(data: NavData): Uint8Array {
  const w = new Writer()
  for (const c of NAV_BIN_MAGIC) w.buf[w.at++] = c.charCodeAt(0)
  w.u32(NAV_DATA_VERSION)
  w.u32(data.regions.length)
  w.u32(data.models.length)
  w.u32(data.instances.length)
  const totalAt = w.at
  w.u32(0)
  for (const r of data.regions) {
    const planes = r.planeTypes && r.planeHeights ? 1 : 0
    w.u32(r.id)
    w.u32(r.openCellCount)
    w.u32(planes)
    w.f32s(r.heights)
    for (let i = 0; i < TILE_COUNT; i++) w.i32(r.tileCells[i]!)
    if (planes) {
      w.u8s(r.planeTypes!)
      w.f32s(r.planeHeights!)
    }
  }
  const edges = (e: NavEdges) => {
    w.u16s(e.vertices)
    w.u16s(e.cells)
    w.u8s(e.flags)
  }
  for (const m of data.models) {
    w.str(m.key)
    w.u32(m.vertices.length / 3)
    w.u32(m.cells.length / 3)
    w.u32(m.outline.flags.length)
    w.u32(m.inline.flags.length)
    w.u32(m.events.length)
    w.f32s(m.vertices)
    w.u16s(m.cells)
    edges(m.outline)
    edges(m.inline)
    for (const e of m.events) w.str(e)
  }
  for (const inst of data.instances) {
    w.u32(inst.id)
    w.u32(inst.objId)
    w.u32(inst.model)
    w.u32(inst.links.length)
    w.f64(inst.x)
    w.f64(inst.y)
    w.f64(inst.z)
    w.f64(inst.yaw)
    for (const l of inst.links) {
      w.u32(l.edge)
      w.u32(l.target)
      w.u32(l.targetEdge)
    }
  }
  w.view.setUint32(totalAt, w.at, true)
  return w.buf.slice(0, w.at)
}

export function decodeNavData(bytes: Uint8Array): NavData {
  const r = new Reader(bytes)
  if (bytes.length < 24) throw new Error('SRNV: truncated header')
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
  if (magic !== NAV_BIN_MAGIC) throw new Error(`SRNV: bad magic ${JSON.stringify(magic)}`)
  r.at = 4
  const version = r.u32()
  if (version !== NAV_DATA_VERSION) throw new Error(`SRNV: unsupported version ${version}`)
  const regionCount = r.u32()
  const modelCount = r.u32()
  const instanceCount = r.u32()
  const total = r.u32()
  if (total !== bytes.length) throw new Error(`SRNV: totalBytes ${total} != ${bytes.length}`)
  const regions: NavRegion[] = []
  for (let i = 0; i < regionCount; i++) {
    const id = r.u32('region id')
    const openCellCount = r.u32()
    const planes = r.u32()
    const region: NavRegion = {
      id, ...regionCoords(id), openCellCount,
      heights: r.f32s(HEIGHT_COUNT, 'heights'),
      tileCells: r.i32s(TILE_COUNT, 'tile cells'),
    }
    if (planes) {
      region.planeTypes = r.u8s(PLANE_COUNT, 'plane types')
      region.planeHeights = r.f32s(PLANE_COUNT, 'plane heights')
    }
    regions.push(region)
  }
  const edges = (n: number, what: string): NavEdges => ({
    vertices: r.u16s(n * 2, what),
    cells: r.u16s(n * 2, what),
    flags: r.u8s(n, what),
  })
  const models: NavModel[] = []
  for (let i = 0; i < modelCount; i++) {
    const key = r.str('model key')
    const nv = r.u32()
    const nc = r.u32()
    const no = r.u32()
    const ni = r.u32()
    const ne = r.u32()
    const vertices = r.f32s(nv * 3, 'vertices')
    const cells = r.u16s(nc * 3, 'cells')
    const outline = edges(no, 'outline edges')
    const inline = edges(ni, 'inline edges')
    const events: string[] = []
    for (let k = 0; k < ne; k++) events.push(r.str('event'))
    models.push({ key, vertices, cells, outline, inline, events })
  }
  const instances: NavInstance[] = []
  for (let i = 0; i < instanceCount; i++) {
    const id = r.u32('instance')
    const objId = r.u32()
    const model = r.u32()
    const linkCount = r.u32()
    const x = r.f64()
    const y = r.f64()
    const z = r.f64()
    const yaw = r.f64()
    if (model >= modelCount) throw new Error(`SRNV: instance ${i} model ${model} out of range`)
    const links = []
    for (let k = 0; k < linkCount; k++) {
      const link = { edge: r.u32(), target: r.u32(), targetEdge: r.u32() }
      if (link.target >= instanceCount) throw new Error(`SRNV: instance ${i} link target out of range`)
      links.push(link)
    }
    instances.push({ id, objId, model, x, y, z, yaw, links })
  }
  if (r.at !== bytes.length) throw new Error(`SRNV: ${bytes.length - r.at} trailing bytes`)
  return { version, regions, models, instances }
}
