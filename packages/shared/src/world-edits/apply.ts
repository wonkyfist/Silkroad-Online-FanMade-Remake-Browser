/**
 * The pure apply functions (docs/WORLD_EDITOR.md §3.6, D19): the editor's preview and the converter's "world edits"
 * pass call the same code, so the two cannot disagree. Deterministic: float32 terrain sums, fixed iteration orders,
 * uids assigned in file order. Nothing here mutates its inputs.
 *
 * Placement edits are lowered to the converter's existing shape (§F3: `PlacementEdits` = drop / resnap / add, the
 * drops freed before the adds): a move is a drop + an add of the same (region, uid) when its origin stays in the owner
 * region, and a drop + an add under a fresh editor uid (0xE000-0xEFFF) of the new owner otherwise (§F5).
 */
import type { Vec3 } from '../protocol.ts'
import {
  WE_BLOCKS, WE_BLOCK_TILES, WE_EDITOR_UID_MAX, WE_EDITOR_UID_MIN, WE_FROM_TOLERANCE_M, WE_GRASS, WE_GRASS_DENSITY_ONE,
  WE_GRID, WE_REGION_M,
  type GrassLayer, type HeightLayer, type PaintLayer, type WorldEditAdd, type WorldEditPlacementRef,
  type WorldEditPlacementsFile, type WorldEditWater,
} from './types.ts'

/** File units (dm) per metre; a file-space region is 1920 units (packages/nav/src/gltf.ts). */
const FILE_PER_M = 10
const FILE_REGION = WE_REGION_M * FILE_PER_M

// --- terrain ----------------------------------------------------------------------------------------------------------

/** Base heights (m, 97 x 97) plus the layer's deltas where touched, summed in float32 (a new array). */
export function applyHeightLayer(base: ArrayLike<number>, layer: HeightLayer | null | undefined): Float32Array {
  const out = Float32Array.from(base)
  if (!layer) return out
  for (let i = 0; i < out.length; i++) if (layer.mask[i]) out[i] = Math.fround(out[i]! + layer.delta[i]!)
  return out
}

/** Per vertex: 1 where the layer moves the ground by more than `minM` (the nav rule's 5 cm uses its own test). */
export function heightLayerMoved(layer: HeightLayer, minM = 0): Uint8Array {
  const out = new Uint8Array(layer.delta.length)
  for (let i = 0; i < out.length; i++) if (layer.mask[i] && Math.abs(layer.delta[i]!) > minM) out[i] = 1
  return out
}

/** Base texture words (97 x 97) with the painted words written where the layer's mask is set (a new array). */
export function applyPaintLayer(base: ArrayLike<number>, layer: PaintLayer | null | undefined): Uint16Array {
  const out = Uint16Array.from(base)
  if (!layer) return out
  for (let i = 0; i < out.length; i++) if (layer.mask[i]) out[i] = layer.words[i]!
  return out
}

/** One region's terrain after its layers: heights (m) and texture words; `changed` when any layer touched it. */
export function applyRegionLayers(
  base: { heights: ArrayLike<number>; textures: ArrayLike<number> },
  layers: { height?: HeightLayer | null; paint?: PaintLayer | null },
): { heights: Float32Array; textures: Uint16Array; changed: boolean } {
  if (base.heights.length !== WE_GRID * WE_GRID || base.textures.length !== WE_GRID * WE_GRID) {
    throw new Error('world edits: a region needs 97 x 97 heights and texture words')
  }
  const heights = applyHeightLayer(base.heights, layers.height)
  const textures = applyPaintLayer(base.textures, layers.paint)
  let changed = false
  for (let i = 0; i < heights.length && !changed; i++) changed = heights[i] !== Math.fround(base.heights[i]!) || textures[i] !== base.textures[i]
  return { heights, textures, changed }
}

/**
 * The grass mask at a region-local point (m, x east, z north, 0..192): density multiplier (R / 128) and flowers
 * (amount 0..1, kind). No layer or an untouched texel: x1, no flowers.
 */
export function grassMaskAt(layer: GrassLayer | null | undefined, x: number, z: number): { density: number; flowers: number; kind: number } {
  if (!layer) return { density: 1, flowers: 0, kind: 0 }
  const tx = Math.min(WE_GRASS - 1, Math.max(0, Math.floor(x)))
  const tz = Math.min(WE_GRASS - 1, Math.max(0, Math.floor(z)))
  const i = tz * WE_GRASS + tx
  if (!layer.mask[i]) return { density: 1, flowers: 0, kind: 0 }
  return { density: layer.density[i]! / WE_GRASS_DENSITY_ONE, flowers: layer.flowers[i]! / 255, kind: layer.kind[i]! }
}

/** water.json's levels for one region: 6 x 6 (bz * 6 + bx), NaN where the edits set no water. Later rows win. */
export function waterLevelsForRegion(rows: readonly WorldEditWater[], region: number): Float32Array {
  const out = new Float32Array(WE_BLOCKS * WE_BLOCKS).fill(NaN)
  for (const w of rows) {
    if (w.region !== region) continue
    for (const [bx, bz] of w.blocks) out[bz * WE_BLOCKS + bx] = w.heightM
  }
  return out
}

/** The 32 m block (bz * 6 + bx) of a tile (tz * 96 + tx index pair). */
export const tileBlock = (tx: number, tz: number) => Math.floor(tz / WE_BLOCK_TILES) * WE_BLOCKS + Math.floor(tx / WE_BLOCK_TILES)

// --- space ------------------------------------------------------------------------------------------------------------

/** Region id z << 8 | x. */
export const regionIdOf = (rx: number, rz: number) => ((rz & 0xff) << 8) | (rx & 0xff)

/** The owner region (z << 8 | x) of a glTF position in the export's frame. */
export function regionOfPosition(position: Readonly<Vec3>, originRegion: { x: number; z: number }): number {
  const rx = originRegion.x + Math.floor(position[0] / WE_REGION_M)
  const rz = originRegion.z + Math.floor(-position[2] / WE_REGION_M)
  return regionIdOf(rx, rz)
}

/** glTF metres -> world file space (dm): x = 1920 ox + 10 x, y = 10 y, z = 1920 oz - 10 z (nav/src/gltf.ts). */
export function gltfToFile(position: Readonly<Vec3>, originRegion: { x: number; z: number }): Vec3 {
  return [FILE_REGION * originRegion.x + position[0] * FILE_PER_M, position[1] * FILE_PER_M, FILE_REGION * originRegion.z - position[2] * FILE_PER_M]
}

/** The glTF rotation of a file-space yaw: toGltfQuat(mapoYawQuat(yaw)) = +yaw about +Y (manifest WorldPlacement). */
export const yawRotation = (yaw: number): [number, number, number, number] => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]

export const placementKey = (region: number, uid: number) => `${region}:${uid}`

// --- placements -------------------------------------------------------------------------------------------------------

/** What lowering needs of a placement (structurally the converter's WorldPlacement). */
export interface WorldEditPlacementLike {
  region: number
  uid: number
  source: string
  position: Vec3
  rotation: [number, number, number, number]
  yaw: number
  scale?: number
}

export interface LowerPlacementOptions<P extends WorldEditPlacementLike> {
  originRegion: { x: number; z: number }
  /** A complete placement for an add (models, objId, flags...) at owner `region` and `uid`; null: unknown source. */
  create(add: WorldEditAdd, region: number, uid: number): P | null
  /** Owner-dependent fields of a moved placement after its owner changed (optional). */
  rehome?(p: P, region: number): P
}

export interface LoweredPlacementEdits<P> {
  /** C9's shape: drops first (moves included), then adds. */
  drop: WorldEditPlacementRef[]
  add: P[]
  /** The owner and uid each move (key `region:uid`) and add (its id) ended under. */
  assigned: Array<{ kind: 'move' | 'add'; key: string; region: number; uid: number }>
  /** Edits that were not applied (Publish errors: an unknown key, a source or position mismatch, no free uid...). */
  problems: string[]
}

/**
 * Lowers placements.json onto the pre-pass placement list (pure; neither input is mutated). Editor uids are kept when
 * the file carries them (validated) and assigned otherwise, lowest free first, in file order (moves, then adds).
 */
export function lowerPlacementEdits<P extends WorldEditPlacementLike>(
  placements: readonly P[], file: Pick<WorldEditPlacementsFile, 'move' | 'drop' | 'add'>, opts: LowerPlacementOptions<P>,
): LoweredPlacementEdits<P> {
  const problems: string[] = []
  const byKey = new Map<string, P>()
  const taken = new Map<number, Set<number>>()
  const uidsOf = (region: number) => {
    let s = taken.get(region)
    if (!s) taken.set(region, (s = new Set()))
    return s
  }
  for (const p of placements) {
    byKey.set(placementKey(p.region, p.uid), p)
    uidsOf(p.region).add(p.uid)
  }

  const addressed = new Set<string>()
  const resolve = (what: string, e: { region: number; uid: number; source: string; from: { position: Vec3; yaw: number } }): P | null => {
    const key = placementKey(e.region, e.uid)
    const p = byKey.get(key)
    if (!p) return problems.push(`${what} ${key}: unknown placement`), null
    if (addressed.has(key)) return problems.push(`${what} ${key}: placement edited twice`), null
    if (p.source.toLowerCase() !== e.source.toLowerCase()) return problems.push(`${what} ${key}: the object changed under the edit (source ${p.source})`), null
    const d = Math.hypot(p.position[0] - e.from.position[0], p.position[1] - e.from.position[1], p.position[2] - e.from.position[2])
    if (!(d <= WE_FROM_TOLERANCE_M)) return problems.push(`${what} ${key}: the object moved under the edit (${d.toFixed(3)} m)`), null
    addressed.add(key)
    return p
  }

  const drop: WorldEditPlacementRef[] = []
  for (const d of file.drop) {
    const p = resolve('drop', d)
    if (!p) continue
    drop.push({ region: p.region, uid: p.uid })
    uidsOf(p.region).delete(p.uid)
  }

  // Moves: the drop half, and where each lands.
  type Pending = { kind: 'move' | 'add'; key: string; region: number; uid: number | undefined; make: (region: number, uid: number) => P | null }
  const pending: Pending[] = []
  for (const m of file.move) {
    const p = resolve('move', m)
    if (!p) continue
    drop.push({ region: p.region, uid: p.uid })
    uidsOf(p.region).delete(p.uid)
    const region = regionOfPosition(m.to.position, opts.originRegion)
    const key = placementKey(p.region, p.uid)
    if (m.to.region !== undefined && m.to.region !== region) {
      problems.push(`move ${key}: to.region ${m.to.region} is not the owner of its position (${region})`)
      continue
    }
    const sameOwner = region === p.region
    if (sameOwner && m.to.uid !== undefined && m.to.uid !== p.uid) {
      problems.push(`move ${key}: a move inside its region keeps its uid`)
      continue
    }
    const uid = sameOwner ? p.uid : m.to.uid
    pending.push({
      kind: 'move', key, region, uid,
      make: (r, u) => {
        const { scale: oldScale, ...rest } = p
        const scale = m.to.scale ?? oldScale
        let next = {
          ...rest, region: r, uid: u,
          position: [m.to.position[0], m.to.position[1], m.to.position[2]], rotation: yawRotation(m.to.yaw), yaw: m.to.yaw,
          ...(scale !== undefined && scale !== 1 ? { scale } : {}),
        } as P
        if (r !== p.region && opts.rehome) next = opts.rehome(next, r)
        return next
      },
    })
  }

  const ids = new Set<string>()
  for (const a of file.add) {
    if (ids.has(a.id)) {
      problems.push(`add ${a.id}: duplicate id`)
      continue
    }
    ids.add(a.id)
    const region = regionOfPosition(a.position, opts.originRegion)
    if (a.region !== undefined && a.region !== region) {
      problems.push(`add ${a.id}: region ${a.region} is not the owner of its position (${region})`)
      continue
    }
    pending.push({ kind: 'add', key: a.id, region, uid: a.uid, make: (r, u) => opts.create(a, r, u) })
  }

  // Uids: the file's own first (they must be editor uids and free), then the lowest free editor uid, in file order.
  const uidOk = (u: number) => Number.isInteger(u) && u >= WE_EDITOR_UID_MIN && u <= WE_EDITOR_UID_MAX
  const chosen: Array<number | undefined> = pending.map(e => {
    if (e.uid === undefined) return undefined
    if (e.kind === 'move' && e.region === byKey.get(e.key)?.region) {
      uidsOf(e.region).add(e.uid)
      return e.uid
    }
    if (!uidOk(e.uid)) return problems.push(`${e.kind} ${e.key}: uid ${e.uid} is outside the editor range 0xE000-0xEFFF`), -1
    const s = uidsOf(e.region)
    if (s.has(e.uid)) return problems.push(`${e.kind} ${e.key}: uid ${e.uid} is already used in region ${e.region}`), -1
    s.add(e.uid)
    return e.uid
  })
  const next = new Map<number, number>()
  const add: P[] = []
  const assigned: LoweredPlacementEdits<P>['assigned'] = []
  pending.forEach((e, i) => {
    let uid = chosen[i]
    if (uid === -1) return
    if (uid === undefined) {
      const s = uidsOf(e.region)
      let u = next.get(e.region) ?? WE_EDITOR_UID_MIN
      while (u <= WE_EDITOR_UID_MAX && s.has(u)) u++
      if (u > WE_EDITOR_UID_MAX) return problems.push(`${e.kind} ${e.key}: no free editor uid in region ${e.region}`), undefined
      s.add(u)
      next.set(e.region, u + 1)
      uid = u
    }
    const p = e.make(e.region, uid)
    if (!p) return problems.push(`${e.kind} ${e.key}: unknown model source`), undefined
    add.push(p)
    assigned.push({ kind: e.kind, key: e.key, region: e.region, uid })
  })
  return { drop, add, assigned, problems }
}

/** One object instance for the nav (S-NAV's put, without its model, which the caller maps from `source`). */
export interface WorldEditNavPut {
  id: number
  objId: number
  source: string
  /** World file space (dm). */
  x: number
  y: number
  z: number
  yaw: number
}

/**
 * The footprint part of lowered placement edits (§6.3 step 3): nav instance ids to remove and instances to put, for
 * the placements whose model carries a collision navmesh (`footprint`). A move inside its region removes and puts
 * the same id (a replace in place). Ids: regionId << 16 | uid. The nav footprint keeps its unscaled size (D17).
 */
export function placementNavEdits<P extends WorldEditPlacementLike & { objId: number }>(
  placements: readonly P[], lowered: Pick<LoweredPlacementEdits<P>, 'drop' | 'add'>, opts: {
    originRegion: { x: number; z: number }
    footprint(p: P): boolean
  },
): { remove: number[]; put: WorldEditNavPut[] } {
  const byKey = new Map<string, P>()
  for (const p of placements) byKey.set(placementKey(p.region, p.uid), p)
  const id = (region: number, uid: number) => (((region & 0xffff) << 16) | (uid & 0xffff)) >>> 0
  const remove: number[] = []
  for (const d of lowered.drop) {
    const p = byKey.get(placementKey(d.region, d.uid))
    if (p && opts.footprint(p)) remove.push(id(d.region, d.uid))
  }
  const put: WorldEditNavPut[] = []
  for (const p of lowered.add) {
    if (!opts.footprint(p)) continue
    const [x, y, z] = gltfToFile(p.position, opts.originRegion)
    put.push({ id: id(p.region, p.uid), objId: p.objId, source: p.source, x, y, z, yaw: p.yaw })
  }
  return { remove, put }
}
