/**
 * The world edits in memory and the terrain they make (WE-D; docs/WORLD_EDITOR.md §3.1, §3.6, §4.8, §7.3). Node-free:
 * ./index.ts reads the layer folder into a `WorldEditsLayers`, and the editor's worker can build one from its own state.
 *
 * - **One global lattice** (`EditLattice`): a 2 m vertex on a region border belongs to two (or four) regions, and the
 *   editor writes it into every holder (docs/WORLD_EDITOR.md §4.1). The converter reads each global vertex once, from
 *   its first holder that carries it (the region the vertex lies in, then the west, south and south-west neighbours),
 *   so every copy of a seam vertex gets the same edit even when one holder's file lacks it; a holder that disagrees is
 *   a problem (`seamProblems`).
 * - **Heights in file units** (`editedFileHeight`): the .m and the .nvm store dm, and the edit adds `delta x 10` in
 *   float32, as the nav rule's `navHeightsAfter` does, so the terrain and the nav get the same number for an edited
 *   vertex; an untouched vertex keeps its base bits.
 * - **The terrain overlay** (`applyTerrainEdits`): the base region (the coast's or retail) with the edited heights,
 *   painted texture words and water blocks; only a block holding a changed vertex (its 17 x 17, edges included) or a
 *   changed water level is rebuilt, every other block keeps the base object, and a region the edits leave alone comes
 *   back as the base itself (the export stays byte-identical).
 * - **What the edits touch** (`touchedRegions`): the regions whose terrain, lightmap or minimap may change: edited
 *   ground, paint, water, and every region within reach of an edited height's or an edited object's shadow.
 */
import {
  assembleRegionGrid, MAPM_BLOCK_TILES, MAPM_BLOCK_VERTICES, MAPM_BLOCKS, MAPM_TEXTURE_ID_MASK, MAPM_WATER,
  type MapMBlock, type MapMFile,
} from '@sro/formats'
import {
  regionIdOf, regionOfPosition, waterLevelsForRegion, WE_GRID, WE_REGION_M, WE_TILES,
  type GrassLayer, type HeightLayer, type PaintLayer, type WalkLayer, type WorldEditLight, type WorldEditPlacementsFile,
  type WorldEditProbe, type WorldEditsIndex, type WorldEditWater, type WorldEditZone,
} from '../../../../shared/src/world-edits/index.ts'
import type { RegionTerrain } from '../edits-hook.ts'

/** Vertices per region side minus one: global vertex = 96 x region + local (packages/shared WE_TILES). */
const CELLS = WE_TILES
const G = WE_GRID
/** File units (dm) per metre. */
export const FILE_UNITS_PER_M = 10

/** A world's edit layers, decoded (packages/shared/src/world-edits types). Region maps are keyed z << 8 | x. */
export interface WorldEditsLayers {
  world: string
  index: WorldEditsIndex | null
  height: Map<number, HeightLayer>
  paint: Map<number, PaintLayer>
  grass: Map<number, GrassLayer>
  walk: Map<number, WalkLayer>
  placements: WorldEditPlacementsFile | null
  water: WorldEditWater[]
  lights: WorldEditLight[]
  zones: WorldEditZone[]
  probes: WorldEditProbe[]
}

export function emptyWorldEditsLayers(world: string): WorldEditsLayers {
  return {
    world, index: null, height: new Map(), paint: new Map(), grass: new Map(), walk: new Map(), placements: null, water: [], lights: [],
    zones: [], probes: [],
  }
}

/** Whether the layers hold any edit at all (an index alone, or empty lists, edit nothing). */
export function hasEdits(l: WorldEditsLayers): boolean {
  const p = l.placements
  return l.height.size > 0 || l.paint.size > 0 || l.grass.size > 0 || l.walk.size > 0 || l.water.length > 0 || l.lights.length > 0 ||
    l.zones.length > 0 || (!!p && (p.move.length > 0 || p.drop.length > 0 || p.add.length > 0))
}

/** The file-unit height of a vertex after an edit of `deltaM` metres (float32, the nav rule's arithmetic). */
export const editedFileHeight = (fileUnits: number, deltaM: number) => Math.fround(fileUnits + deltaM * FILE_UNITS_PER_M)

/** Exported metres of file units (convert-world's heightsToMetres, one value). */
export const fileUnitsToMetres = (fileUnits: number) => Math.fround(fileUnits * 0.1)

// --- the global lattice -----------------------------------------------------------------------------------------------

/**
 * The holders of global vertex (ggx, ggz) in lookup order: the region it lies in, then (on a border) the west, the
 * south and the south-west neighbour, each with the vertex's local index there.
 */
export function vertexHolders(ggx: number, ggz: number): Array<{ rx: number; rz: number; i: number }> {
  const rx = Math.floor(ggx / CELLS)
  const rz = Math.floor(ggz / CELLS)
  const gx = ggx - rx * CELLS
  const gz = ggz - rz * CELLS
  const out = [{ rx, rz, i: gz * G + gx }]
  if (gx === 0) out.push({ rx: rx - 1, rz, i: gz * G + CELLS })
  if (gz === 0) out.push({ rx, rz: rz - 1, i: CELLS * G + gx })
  if (gx === 0 && gz === 0) out.push({ rx: rx - 1, rz: rz - 1, i: CELLS * G + CELLS })
  return out
}

/** The edits' heights and paint on the global 2 m lattice (absolute: ggx = 96 x region x + local x). */
export class EditLattice {
  constructor(private readonly height: ReadonlyMap<number, HeightLayer>, private readonly paint: ReadonlyMap<number, PaintLayer>) {}

  /** The height delta (m) at a global vertex, or undefined where no layer touches it. */
  delta(ggx: number, ggz: number): number | undefined {
    for (const h of vertexHolders(ggx, ggz)) {
      const l = this.height.get(regionIdOf(h.rx, h.rz))
      if (l && l.mask[h.i]) return l.delta[h.i]!
    }
    return undefined
  }

  /** The painted texture word at a global vertex, or undefined where none is painted. */
  word(ggx: number, ggz: number): number | undefined {
    for (const h of vertexHolders(ggx, ggz)) {
      const l = this.paint.get(regionIdOf(h.rx, h.rz))
      if (l && l.mask[h.i]) return l.words[h.i]!
    }
    return undefined
  }

  /** The delta (m) bilinear between the global vertices at a fractional lattice point (0 where untouched). */
  deltaAt(fgx: number, fgz: number): number {
    const x0 = Math.floor(fgx)
    const z0 = Math.floor(fgz)
    const tx = fgx - x0
    const tz = fgz - z0
    const d = (x: number, z: number) => this.delta(x, z) ?? 0
    return (d(x0, z0) * (1 - tx) + d(x0 + 1, z0) * tx) * (1 - tz) + (d(x0, z0 + 1) * (1 - tx) + d(x0 + 1, z0 + 1) * tx) * tz
  }

  /** The height delta (m) under a glTF position (x east, z = -north) of the export's frame. */
  deltaAtPosition(position: readonly [number, number, number], origin: { x: number; z: number }): number {
    return this.deltaAt(origin.x * CELLS + position[0] / 2, origin.z * CELLS - position[2] / 2)
  }

  /** Region ids with a height or paint layer. */
  regions(): number[] {
    return [...new Set([...this.height.keys(), ...this.paint.keys()])].sort((a, b) => a - b)
  }

  /**
   * Seam vertices whose holders disagree: one holder carries an edit (a non-zero delta, a word) that another exported
   * holder lacks or carries differently. The converter applies the first holder's (see the header); the editor writes
   * every holder. `exported`: whether a region is in the export (default: every region).
   */
  seamProblems(exported: (rx: number, rz: number) => boolean = () => true): string[] {
    const out: string[] = []
    const check = <L extends { mask: Uint8Array }>(kind: 'height' | 'paint', layers: ReadonlyMap<number, L>, value: (l: L, i: number) => number) => {
      for (const id of [...layers.keys()].sort((a, b) => a - b)) {
        const rx = id & 0xff
        const rz = id >> 8
        const own = layers.get(id)!
        let n = 0
        for (let gz = 0; gz < G; gz++) {
          for (let gx = 0; gx < G; gx++) {
            if (gx !== 0 && gx !== CELLS && gz !== 0 && gz !== CELLS) continue
            const i = gz * G + gx
            if (!own.mask[i] || (kind === 'height' && value(own, i) === 0)) continue
            const v = value(own, i)
            for (const h of vertexHolders(rx * CELLS + gx, rz * CELLS + gz)) {
              if (regionIdOf(h.rx, h.rz) === id || !exported(h.rx, h.rz)) continue
              const l = layers.get(regionIdOf(h.rx, h.rz))
              if (!l || !l.mask[h.i] || value(l, h.i) !== v) {
                n++
                break
              }
            }
          }
        }
        if (n) out.push(`${kind}/${rx}_${rz}: ${n} seam vertex(es) differ from a neighbour's layer (the first holder's edit is applied)`)
      }
    }
    check('height', this.height, (l, i) => l.delta[i]!)
    check('paint', this.paint, (l, i) => l.words[i]!)
    return out
  }
}

// --- the terrain overlay ----------------------------------------------------------------------------------------------

export interface TerrainEditResult {
  /** The region after the edits (the base object itself when nothing changed). */
  terrain: RegionTerrain | null
  changed: boolean
  /** Vertices whose height changed / texture word changed. */
  heightVertices: number
  paintVertices: number
  /** Blocks whose water the edits set. */
  waterBlocks: number
}

/**
 * Region (x, z)'s terrain after the edits, given its base (the coast's or retail; null = not exported: nothing to edit).
 * Heights: `editedFileHeight` of the base where the lattice has a delta; words: the painted word; water: water.json's
 * level on its blocks (kind water; the wave type kept from a block that had water).
 */
export function applyTerrainEdits(x: number, z: number, base: RegionTerrain | null, lattice: EditLattice,
  water: readonly WorldEditWater[]): TerrainEditResult {
  const none: TerrainEditResult = { terrain: base, changed: false, heightVertices: 0, paintVertices: 0, waterBlocks: 0 }
  if (!base) return none
  const gh = base.grid.heights
  const gw = base.grid.textures
  const fu = Float32Array.from(gh)
  const words = Uint16Array.from(gw)
  const changedV = new Uint8Array(G * G)
  let heightVertices = 0
  let paintVertices = 0
  for (let gz = 0; gz < G; gz++) {
    for (let gx = 0; gx < G; gx++) {
      const i = gz * G + gx
      const ggx = x * CELLS + gx
      const ggz = z * CELLS + gz
      const d = lattice.delta(ggx, ggz)
      if (d !== undefined && d !== 0) {
        const h = editedFileHeight(gh[i]!, d)
        if (h !== gh[i]) {
          fu[i] = h
          changedV[i] = 1
          heightVertices++
        }
      }
      const w = lattice.word(ggx, ggz)
      if (w !== undefined && w !== gw[i]) {
        words[i] = w
        changedV[i] = 1
        paintVertices++
      }
    }
  }
  const levels = waterLevelsForRegion(water, regionIdOf(x, z))
  let waterBlocks = 0
  const blocks = base.mapm.blocks.map(b => {
    const level = levels[b.bz * MAPM_BLOCKS + b.bx]!
    const waterHeight = Number.isNaN(level) ? null : Math.fround(level * FILE_UNITS_PER_M)
    const waterChanged = waterHeight !== null && (b.waterType !== MAPM_WATER || b.waterHeight !== waterHeight)
    let touched = waterChanged
    for (let vz = 0; vz < MAPM_BLOCK_VERTICES && !touched; vz++) {
      for (let vx = 0; vx < MAPM_BLOCK_VERTICES; vx++) {
        if (changedV[(b.bz * MAPM_BLOCK_TILES + vz) * G + b.bx * MAPM_BLOCK_TILES + vx]) {
          touched = true
          break
        }
      }
    }
    if (!touched) return b
    if (waterChanged) waterBlocks++
    const nb = rebuildBlock(b, fu, words)
    return waterHeight === null ? nb : { ...nb, waterType: MAPM_WATER, waterWaveType: b.waterType === MAPM_WATER ? b.waterWaveType : 0, waterHeight }
  })
  if (!heightVertices && !paintVertices && !waterBlocks) return none
  const mapm: MapMFile = { signature: base.mapm.signature, blocks }
  const terrain: RegionTerrain = { mapm, grid: assembleRegionGrid(mapm), ...(base.synthetic ? { synthetic: true } : {}) }
  return { terrain, changed: true, heightVertices, paintVertices, waterBlocks }
}

/** A block with its 17 x 17 heights and texture words from the region's 97 x 97 arrays (./coast/source.ts's rule). */
function rebuildBlock(b: MapMBlock, fu: Float32Array, words: Uint16Array): MapMBlock {
  const n = MAPM_BLOCK_VERTICES * MAPM_BLOCK_VERTICES
  const heights = new Float32Array(n)
  const textures = new Uint16Array(n)
  const textureIds = new Uint16Array(n)
  const textureHighBits = new Uint8Array(n)
  let hMax = -Infinity
  let hMin = Infinity
  for (let vz = 0; vz < MAPM_BLOCK_VERTICES; vz++) {
    for (let vx = 0; vx < MAPM_BLOCK_VERTICES; vx++) {
      const g = (b.bz * MAPM_BLOCK_TILES + vz) * G + b.bx * MAPM_BLOCK_TILES + vx
      const s = vz * MAPM_BLOCK_VERTICES + vx
      heights[s] = fu[g]!
      textures[s] = words[g]!
      textureIds[s] = words[g]! & MAPM_TEXTURE_ID_MASK
      textureHighBits[s] = words[g]! >>> 10
      hMax = Math.max(hMax, fu[g]!)
      hMin = Math.min(hMin, fu[g]!)
    }
  }
  return { ...b, heights, textures, textureIds, textureHighBits, heightMax: hMax, heightMin: hMin }
}

/** The bytes the base hash (edits.json `regions[].base`) is taken over: the base heights in metres, float32 LE. */
export function baseHeightBytes(fileUnits: ArrayLike<number>): Uint8Array {
  const m = new Float32Array(fileUnits.length)
  for (let i = 0; i < m.length; i++) m[i] = fileUnits[i]! * 0.1
  return new Uint8Array(m.buffer)
}

// --- touched regions --------------------------------------------------------------------------------------------------

/**
 * Horizontal reach (m) of an edited object's baked shadow and its minimap footprint: the tallest Jangan building
 * (≈ 40 m) casts ≈ 51 m toward the west at the baked sun's 38° elevation, plus its own half-width; generous on
 * purpose (a touched region the edit does not change costs a compare, a missing one a ghost shadow).
 */
export const OBJECT_REACH_M = 96
/** Shadow length per metre of height at the baked sun (horizontal / vertical of BAKED_LIGHT_DIR, 0.787 / 0.616). */
export const SHADOW_PER_M = 1.28

/** Regions (ids) within `reachM` of a glTF point (square distance to the region's rectangle). */
function regionsNear(px: number, pz: number, reachM: number, origin: { x: number; z: number }, into: Set<number>): void {
  // absolute region-space metres: east = 192 x region x, north = 192 x region z
  const e = origin.x * WE_REGION_M + px
  const n = origin.z * WE_REGION_M - pz
  const x0 = Math.floor((e - reachM) / WE_REGION_M)
  const x1 = Math.floor((e + reachM) / WE_REGION_M)
  const z0 = Math.floor((n - reachM) / WE_REGION_M)
  const z1 = Math.floor((n + reachM) / WE_REGION_M)
  for (let rz = z0; rz <= z1; rz++) for (let rx = x0; rx <= x1; rx++) if (rx >= 0 && rx <= 255 && rz >= 0 && rz <= 255) into.add(regionIdOf(rx, rz))
}

/**
 * What a placement edit's reach adds to its models' bounds (m): the minimap footprint's pad (../coast/placements.ts
 * DROP_FOOTPRINT_PAD_M, 1.5 m) and the lightmap mask's grow + feather (./shadows.ts, 3 + 5 + 1 texels of up to
 * 0.75 m), rounded up.
 */
export const OBJECT_REACH_PAD_M = 10

/** A model's bounds, as the reach reads them (WorldModel's fields). */
export interface ReachModel {
  kind?: string
  boundsMin: readonly number[]
  boundsMax: readonly number[]
}

/**
 * The horizontal reach (m) of a placement of these models (its parts, placement space) at `scale`: over every part,
 * the farthest horizontal bound from the origin (any yaw) + its height above the origin x SHADOW_PER_M (the baked
 * shadow), scaled, + OBJECT_REACH_PAD_M; 0 when no part has bounds.
 */
export function modelsReachM(models: ReadonlyArray<ReachModel | undefined>, scale = 1): number {
  let r = -1
  for (const m of models) {
    if (!m || m.kind === 'failed' || ![...m.boundsMin, ...m.boundsMax].every(Number.isFinite)) continue
    const hx = Math.max(Math.abs(m.boundsMin[0]!), Math.abs(m.boundsMax[0]!))
    const hz = Math.max(Math.abs(m.boundsMin[2]!), Math.abs(m.boundsMax[2]!))
    r = Math.max(r, (Math.hypot(hx, hz) + Math.max(0, m.boundsMax[1]!) * SHADOW_PER_M) * scale)
  }
  return r < 0 ? 0 : r + OBJECT_REACH_PAD_M
}

/**
 * The reach (m) of one end of a placement edit: its source, its scale, and for a move or drop the placement it names
 * (`region:uid`). Never less than OBJECT_REACH_M.
 */
export type PlacementReach = (source: string, scale: number, key?: string) => number

/**
 * The reach of the placement edits from the export's (or the pre-pass cache's) placements and models: a named
 * placement's own parts, else the first placement of the source (an add's template, ./placements.ts), else
 * OBJECT_REACH_M (a source the export does not know).
 */
export function placementReach(placements: ReadonlyArray<{ source: string; models: readonly number[]; region: number; uid: number; scale?: number }>,
  models: ReadonlyArray<ReachModel | undefined>): PlacementReach {
  const bySource = new Map<string, readonly number[]>()
  const byKey = new Map<string, { models: readonly number[]; scale: number }>()
  for (const p of placements) {
    const k = p.source.toLowerCase()
    if (!bySource.has(k)) bySource.set(k, p.models)
    byKey.set(`${p.region}:${p.uid}`, { models: p.models, scale: p.scale ?? 1 })
  }
  const cache = new Map<string, number>()
  return (source, editScale, key) => {
    const named = key !== undefined ? byKey.get(key) : undefined
    // a named placement: the larger of its own scale (the old end) and the edit's (the new end)
    const scale = named ? Math.max(named.scale, editScale) : editScale
    const parts = named?.models ?? bySource.get(source.toLowerCase())
    if (!parts) return OBJECT_REACH_M
    const c = `${parts.join(',')}@${scale}`
    let r = cache.get(c)
    if (r === undefined) cache.set(c, (r = Math.max(OBJECT_REACH_M, modelsReachM(parts.map(i => models[i]), scale))))
    return r
  }
}

/**
 * The regions the edits may change the terrain, lightmap or minimap of (edits-hook `touched`): every region with a
 * height or paint layer or a water row; around every edited height, the regions its shadow can reach (|delta| x 1.28
 * + 8 m); around every moved (both ends), dropped or added object, the regions within its reach (`reach`, from its
 * models: a tall tree's shadow, a 278 m gate; H12-GH-1), at least OBJECT_REACH_M.
 */
export function touchedRegions(l: WorldEditsLayers, origin: { x: number; z: number }, reach?: PlacementReach): Set<number> {
  const out = new Set<number>()
  for (const id of l.paint.keys()) out.add(id)
  for (const w of l.water) out.add(w.region)
  for (const [id, h] of l.height) {
    out.add(id)
    const rx = id & 0xff
    const rz = id >> 8
    let maxAbs = 0
    let gx0 = G
    let gx1 = -1
    let gz0 = G
    let gz1 = -1
    for (let gz = 0; gz < G; gz++) {
      for (let gx = 0; gx < G; gx++) {
        const i = gz * G + gx
        if (!h.mask[i] || h.delta[i] === 0) continue
        maxAbs = Math.max(maxAbs, Math.abs(h.delta[i]!))
        gx0 = Math.min(gx0, gx)
        gx1 = Math.max(gx1, gx)
        gz0 = Math.min(gz0, gz)
        gz1 = Math.max(gz1, gz)
      }
    }
    if (gx1 < 0) continue
    const reach = maxAbs * SHADOW_PER_M + 8
    // the edited box's corners in glTF, grown by the reach
    const e0 = rx * WE_REGION_M + gx0 * 2 - reach
    const e1 = rx * WE_REGION_M + gx1 * 2 + reach
    const n0 = rz * WE_REGION_M + gz0 * 2 - reach
    const n1 = rz * WE_REGION_M + gz1 * 2 + reach
    for (let z = Math.floor(n0 / WE_REGION_M); z <= Math.floor(n1 / WE_REGION_M); z++) {
      for (let x = Math.floor(e0 / WE_REGION_M); x <= Math.floor(e1 / WE_REGION_M); x++) if (x >= 0 && x <= 255 && z >= 0 && z <= 255) out.add(regionIdOf(x, z))
    }
  }
  const p = l.placements
  if (p) {
    const near = (pos: readonly number[], source: string, scale: number, key?: string) =>
      regionsNear(pos[0]!, pos[2]!, Math.max(OBJECT_REACH_M, reach?.(source, scale, key) ?? OBJECT_REACH_M), origin, out)
    for (const m of p.move) {
      const key = `${m.region}:${m.uid}`
      near(m.from.position, m.source, 1, key)
      near(m.to.position, m.source, m.to.scale ?? 1, key)
    }
    for (const d of p.drop) near(d.from.position, d.source, 1, `${d.region}:${d.uid}`)
    for (const a of p.add) near(a.position, a.source, a.scale ?? 1)
  }
  return out
}

/** The owner region of each light point: count per region id. */
export function lightPointCounts(lights: readonly WorldEditLight[], origin: { x: number; z: number }): Map<number, number> {
  const out = new Map<number, number>()
  for (const l of lights) {
    const id = regionOfPosition([l.x, l.y, l.z], origin)
    out.set(id, (out.get(id) ?? 0) + 1)
  }
  return out
}

/** ambient.json `points` (world-render night-lights.ts NightLightPoint) from lights.json, in the file's order. */
export function ambientPointsOf(lights: readonly WorldEditLight[]): Array<Record<string, unknown>> {
  return lights.map(l => ({
    id: l.id, x: l.x, y: l.y, z: l.z, kind: l.kind, colour: [l.colour[0], l.colour[1], l.colour[2]], intensity: l.intensity, radiusM: l.radiusM,
  }))
}

/** The export's sound-zone file (apps/game world/features/sound-zones.ts SOUND_ZONES_FILE). */
export const SOUND_ZONES_FILE = 'sound-zones.json'
export const SOUND_ZONES_FORMAT = 'sro-sound-zones'

/** sound-zones.json: `{ format, version, zones }` (the game reads the list or this wrapper), the layer's rows as they are. */
export function encodeSoundZones(zones: readonly WorldEditZone[]): string {
  return JSON.stringify({ format: SOUND_ZONES_FORMAT, version: 1, zones }, null, 1) + '\n'
}

/** The export path of a region's grass / flower mask (manifest `grassMask`). */
export const grassMaskFile = (rx: number, rz: number) => `grass/${rx}_${rz}.png`

/** Whether a grass layer paints anything (a layer with no touched texel ships no mask). */
export function grassLayerPainted(l: GrassLayer): boolean {
  for (let i = 0; i < l.mask.length; i++) if (l.mask[i]) return true
  return false
}
