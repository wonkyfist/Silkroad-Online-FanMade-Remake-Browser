/**
 * The world edits' nav step (lane WE-N; docs/WORLD_EDITOR.md §6.3 steps 1-4, §3.6, §F9; docs/WAVE_PLAN8.md §2.2, D40).
 * Node-free and pure: the converter's navmesh step (through ../edits-hook.ts `navEdit`, wired by ./index.ts), the
 * editor's walk preview and the Publish checks (./checks.ts) all apply the same edit.
 *
 * Per region, after the coast's own nav edit (coast/navgen.ts `editRegionNav`, which this extends):
 * 1. heights: the height layer added in the nav's own units (m x 10, `navHeightsAfter`), so the four copies of the
 *    ground (terrain bin, debug navmesh, nav chunk, nav.bin) move together; untouched vertices keep their exact bits;
 * 2. tiles: the nav rule (packages/shared/src/world-edits/nav-rule.ts `navRuleRegion`, one pure function): a tile the
 *    edit made steeper than 35 deg closes, nothing opens by itself, a tile under new water deeper than 1.2 m closes
 *    (`navRuleWaterTile`, the swimming hook below), the Walkable overrides apply last. A closed tile gets the region's
 *    closed cell **and** the blocked tile flag (coast/navgen.ts `close`); a force-opened tile gets an open neighbour's
 *    cell and loses the flag (the coast's openTiles rule). The Walkable brush's hard limits (shared world-edits/walk.ts
 *    `walkRefusals`: outside the playable bounds, in the sea mask, under a collision footprint as it stands after the
 *    edits) turn a force open back to auto, with a warning (`warn`), never a Publish error;
 * 3. water planes: a block the edits give water gets a water plane at that level (the .nvm plane map mirrors the .m
 *    water, docs/formats nvm.ts);
 * 4. object footprints (placements whose model has a collision navmesh; `placementNavEdits` gives the ids): a drop
 *    removes the instance, a move replaces it in its slot (same id) in every region its footprint reaches (the .nvm
 *    spill copies; a region it leaves loses its copy), an add is appended to every such region; the terrain cells'
 *    object lists get the cells under the footprint's box (a superset is safe, NAVIGATION §4.3). Links are never
 *    edited (§4.6): an edit of a linked instance is refused and listed in `problems` (a Publish error), the instance
 *    stays as it was. The footprint keeps its unscaled size (D17).
 *
 * Swimming (wave 13, docs/SWIMMING.md §2.5 SW-D6): deep new water becomes "swimmable, not walkable". The walking
 * answer stays here (closed); every tile the deep-water rule closed is listed per region as `deepWater`, the input the
 * swim layer's builder will read. The depth line itself lives in one function, `navRuleWaterTile`.
 *
 * Spaces: .nvm object positions are relative to the file's region (file units, dm); `WorldEditNavPut` is world file
 * space (`gltfToFile`). Local -> world for a footprint: (x + c lx - s lz, z + s lx + c lz), c = cos yaw, s = sin yaw.
 */
import { NVM_PLANE_TYPE, NVM_REGION_SIZE, NVM_TILE_BLOCKED, NVM_TILES, type NvmCell, type NvmFile, type NvmObject } from '@sro/formats'
import { editNavInstances, type NavData, type NavInstancePut, type NavModel, type NavRegion } from '@sro/nav'
import {
  NAV_TILE_ACTION, WE_BLOCKS, WE_TILES, WE_WALK, guardWalkCodes, navHeightsAfter, navRuleRegion, navRuleWaterTile, tileWaterDepth,
  walkRefusals, type HeightLayer, type NavRuleResult, type WalkGuard, type WalkLayer, type WorldEditNavPut,
} from '../../../../shared/src/world-edits/index.ts'

/** One region's layers as the nav step reads them. */
export interface NavEditRegionLayers {
  height?: HeightLayer | null
  walk?: WalkLayer | null
  /** 6 x 6 (bz * 6 + bx): the level the edits set (m), NaN where none (`waterLevelsForRegion`). */
  water?: ArrayLike<number> | null
}

/** A collision navmesh's XZ bounds, object-local file units (unscaled). */
export interface NavFootprint {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

/** The footprint part of the placement edits (`placementNavEdits`): ids to remove, instances to put. */
export interface NavEditObjects {
  remove: readonly number[]
  put: readonly WorldEditNavPut[]
}

/** The record fields of a new .nvm object that the put does not carry. */
export type NavObjectRecord = Pick<NvmObject, 'type' | 'unknownShort0' | 'isBig' | 'isStruct'>

export interface NavEditOptions {
  /** Layers by region id (z << 8 | x); a region without an entry keeps its ground and tiles. */
  regions: ReadonlyMap<number, NavEditRegionLayers>
  objects?: NavEditObjects | null
  /** The collision navmesh bounds of an object.ifo id; null: unknown (the instance goes to its owner region only). */
  footprint(objId: number): NavFootprint | null
  /** The record fields of an added object (the .o2 / object.ifo flags); default: another record of the same objId in
   *  the region, else static (type -1, not big, not struct). */
  record?(objId: number): NavObjectRecord | null
  /** Ids of the linked instances (the export's nav.bin; links are never edited): their edits are refused up front.
   *  Without it each region still refuses an edit of an instance it lists as linked. */
  linked?: ReadonlySet<number>
  /** The Walkable brush's hard limits besides the footprints (always checked): the playable bounds and the sea mask. */
  walkGuard?: WalkGuard | null
  /** Where an ignored force-open is said (the converter's warnings). */
  warn?(line: string): void
}

export interface NavEditRegionStats {
  region: number
  x: number
  z: number
  /** The nav rule's counts (tiles). */
  touched: number
  closedSlope: number
  closedWater: number
  forcedOpen: number
  forcedClosed: number
  closed: number
  opened: number
  /** Tile indices (tz * 96 + tx), ascending. */
  closedTiles: number[]
  openedTiles: number[]
  /** Tiles under new water deeper than 1.2 m (closed for walking): the future swim layer's editor tiles (wave 13). */
  deepWater: number[]
  /** Blocks whose water plane the edits set. */
  planesSet: number
  objects: { removed: number; replaced: number; added: number }
}

export interface NavEditReport {
  regions: NavEditRegionStats[]
  /** Edits not applied: Publish errors (a linked instance, a force-open tile with no open cell in its region...). */
  problems: string[]
  /** Force-open tiles the hard limits ignored (bounds, sea, footprints): warnings, not errors. */
  ignored?: string[]
}

const TILE_COUNT = NVM_TILES * NVM_TILES
const idOf = (o: Pick<NvmObject, 'regionId' | 'localUid'>) => (((o.regionId & 0xffff) << 16) | (o.localUid & 0xffff)) >>> 0
const regionName = (id: number) => `${id & 0xff}_${(id >> 8) & 0xff}`
const STATIC_RECORD: NavObjectRecord = { type: -1, unknownShort0: 0, isBig: false, isStruct: false }

/** World file-space XZ box of a put's footprint (a point when the footprint is unknown). */
export function footprintBox(put: Pick<WorldEditNavPut, 'x' | 'z' | 'yaw'>, fp: NavFootprint | null): NavFootprint {
  if (!fp) return { minX: put.x, minZ: put.z, maxX: put.x, maxZ: put.z }
  const c = Math.cos(put.yaw)
  const s = Math.sin(put.yaw)
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
  for (const lx of [fp.minX, fp.maxX]) {
    for (const lz of [fp.minZ, fp.maxZ]) {
      const x = put.x + c * lx - s * lz
      const z = put.z + s * lx + c * lz
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
  }
  return { minX, minZ, maxX, maxZ }
}

/** Region ids a box reaches (every region whose 1920-unit square it overlaps), plus the owner; ascending. */
export function regionsReached(box: NavFootprint, owner: number): number[] {
  const out = new Set<number>([owner])
  const x0 = Math.floor(box.minX / NVM_REGION_SIZE), x1 = Math.ceil(box.maxX / NVM_REGION_SIZE) - 1
  const z0 = Math.floor(box.minZ / NVM_REGION_SIZE), z1 = Math.ceil(box.maxZ / NVM_REGION_SIZE) - 1
  for (let rz = z0; rz <= Math.max(z0, z1); rz++) {
    for (let rx = x0; rx <= Math.max(x0, x1); rx++) out.add(((rz & 0xff) << 8) | (rx & 0xff))
  }
  return [...out].sort((a, b) => a - b)
}

/** The open cell of a 4-neighbour tile, nearest along the axes first, or 0 when the region has open cells, else -1
 *  (coast/navgen.ts `openNeighbourCell`, the same rule). */
export function openNeighbourCell(tileCells: ArrayLike<number>, openCellCount: number, tx: number, tz: number): number {
  const ok = (c: number) => c >= 0 && c < openCellCount
  for (let r = 1; r < NVM_TILES; r++) {
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
      const x = tx + dx
      const z = tz + dz
      if (x < 0 || z < 0 || x >= NVM_TILES || z >= NVM_TILES) continue
      if (ok(tileCells[z * NVM_TILES + x]!)) return tileCells[z * NVM_TILES + x]!
    }
  }
  return openCellCount > 0 ? 0 : -1
}

// --- the ground: heights, the nav rule, water planes (shared by the .nvm and the NavData paths) ----------------------

interface GroundEdit {
  heights: Float32Array | null
  rule: NavRuleResult | null
  deepWater: number[]
  /** Blocks (bz * 6 + bx) and levels (m) of the edits' water. */
  water: Array<[number, number]>
}

function groundEdit(navHeights: Float32Array, tileCells: ArrayLike<number>, openCellCount: number, layers: NavEditRegionLayers | undefined): GroundEdit {
  const none: GroundEdit = { heights: null, rule: null, deepWater: [], water: [] }
  if (!layers || (!layers.height && !layers.walk && !layers.water)) return none
  const heights = layers.height ? navHeightsAfter(navHeights, layers.height) : null
  // metres exactly as the terrain bin holds them (terrain.ts heightsToMetres: f32(units x 0.1)), so the editor's
  // preview, which reads the terrain, and this step see the same numbers
  const before = Float32Array.from(navHeights, h => h * 0.1)
  const after = heights ? Float32Array.from(heights, h => h * 0.1) : before
  const open = new Uint8Array(TILE_COUNT)
  for (let t = 0; t < TILE_COUNT; t++) open[t] = tileCells[t]! >= 0 && tileCells[t]! < openCellCount ? 1 : 0
  const water = layers.water ?? null
  const rule = navRuleRegion({ before, after, open, water, walk: layers.walk?.codes ?? null })
  const deepWater: number[] = []
  const levels: Array<[number, number]> = []
  if (water) {
    for (let b = 0; b < WE_BLOCKS * WE_BLOCKS; b++) if (!Number.isNaN(water[b]!)) levels.push([b, water[b]!])
    if (levels.length) {
      for (let tz = 0; tz < WE_TILES; tz++) {
        for (let tx = 0; tx < WE_TILES; tx++) {
          if (navRuleWaterTile(tileWaterDepth(after, water, tx, tz)) === 'deep') deepWater.push(tz * WE_TILES + tx)
        }
      }
    }
  }
  return { heights, rule, deepWater, water: levels }
}

/** Applies the rule's actions to a tile map (closes first, then opens; ascending). Returns the changed tiles. */
function applyTileActions(
  rule: NavRuleResult, tileCells: Int32Array, openCellCount: number, close: (t: number) => void, open: (t: number, cell: number) => void,
  problems: string[], region: number,
): { closed: number[]; opened: number[] } {
  const closed: number[] = []
  const opened: number[] = []
  for (let t = 0; t < TILE_COUNT; t++) {
    if (rule.actions[t] !== NAV_TILE_ACTION.close) continue
    close(t)
    closed.push(t)
  }
  for (let t = 0; t < TILE_COUNT; t++) {
    if (rule.actions[t] !== NAV_TILE_ACTION.open) continue
    const cell = openNeighbourCell(tileCells, openCellCount, t % NVM_TILES, Math.floor(t / NVM_TILES))
    if (cell < 0) {
      problems.push(`nav ${regionName(region)}: tile ${t % NVM_TILES},${Math.floor(t / NVM_TILES)} cannot be forced open (the region has no open cell)`)
      continue
    }
    open(t, cell)
    opened.push(t)
  }
  return { closed, opened }
}

/**
 * The region's layers with every force-open the hard limits refuse set back to auto (shared `walkRefusals`); says so
 * through `warn` and `ignored`. `footprints`: the collision boxes reaching the region after the edits (read only when
 * the walk layer forces a tile open).
 */
function guardWalk(
  regionId: number, layers: NavEditRegionLayers | undefined, footprints: () => NavFootprint[],
  opts: Pick<NavEditOptions, 'walkGuard' | 'warn'>, ignored: string[],
): NavEditRegionLayers | undefined {
  const walk = layers?.walk
  if (!walk || !walk.codes.includes(WE_WALK.open)) return layers
  const g = guardWalkCodes(walk.codes, walkRefusals(regionId & 0xff, (regionId >> 8) & 0xff, opts.walkGuard ?? {}, footprints()))
  const { bounds, sea, object } = g.refused
  if (!bounds && !sea && !object) return layers
  const why = [bounds ? `${bounds} outside the playable bounds` : '', sea ? `${sea} in the sea` : '', object ? `${object} under an object's footprint` : '']
  const line = `world edits: walk ${regionName(regionId)}: ${bounds + sea + object} force-open tile(s) ignored (${why.filter(Boolean).join(', ')})`
  ignored.push(line)
  opts.warn?.(line)
  return { ...layers, walk: { codes: g.codes } }
}

/** The collision boxes in a region's .nvm after the footprint plan (kept, moved and added; a linked one stays). */
function nvmFootprints(regionId: number, nvm: NvmFile, plan: ObjectPlan, footprint: NavEditOptions['footprint']): NavFootprint[] {
  const ox = NVM_REGION_SIZE * (regionId & 0xff)
  const oz = NVM_REGION_SIZE * ((regionId >> 8) & 0xff)
  const linked = linkedIds(nvm.objects)
  const out: NavFootprint[] = []
  for (const o of nvm.objects) {
    const id = idOf(o)
    if (plan.drop.has(id) && !linked.has(id)) continue
    out.push(footprintBox({ x: ox + o.position[0], z: oz + o.position[2], yaw: o.yaw }, footprint(o.objId)))
  }
  for (const { box } of plan.byRegion.get(regionId) ?? []) out.push(box)
  return out
}

/** The same boxes on decoded NavData (every instance; removes and puts applied, links kept). */
function dataFootprints(data: NavData, opts: Pick<NavEditOptions, 'objects' | 'footprint' | 'linked'>): NavFootprint[] {
  const linked = new Set<number>(opts.linked ?? [])
  data.instances.forEach(inst => {
    if (inst.links.length) linked.add(inst.id >>> 0)
    for (const l of inst.links) if (data.instances[l.target]) linked.add(data.instances[l.target]!.id >>> 0)
  })
  const gone = new Set<number>()
  for (const id of opts.objects?.remove ?? []) if (!linked.has(id >>> 0)) gone.add(id >>> 0)
  const out: NavFootprint[] = []
  for (const p of opts.objects?.put ?? []) {
    if (linked.has(p.id >>> 0)) continue
    gone.add(p.id >>> 0)
    out.push(footprintBox(p, opts.footprint(p.objId)))
  }
  for (const inst of data.instances) if (!gone.has(inst.id >>> 0)) out.push(footprintBox(inst, opts.footprint(inst.objId)))
  return out
}

function emptyStats(region: number): NavEditRegionStats {
  return {
    region, x: region & 0xff, z: (region >> 8) & 0xff,
    touched: 0, closedSlope: 0, closedWater: 0, forcedOpen: 0, forcedClosed: 0, closed: 0, opened: 0,
    closedTiles: [], openedTiles: [], deepWater: [], planesSet: 0, objects: { removed: 0, replaced: 0, added: 0 },
  }
}

function ruleStats(s: NavEditRegionStats, g: GroundEdit, tiles: { closed: number[]; opened: number[] }): void {
  if (g.rule) {
    s.touched = g.rule.touched
    s.closedSlope = g.rule.closedSlope
    s.closedWater = g.rule.closedWater
    s.forcedOpen = g.rule.forcedOpen
    s.forcedClosed = g.rule.forcedClosed
  }
  s.closed = tiles.closed.length
  s.opened = tiles.opened.length
  s.closedTiles = tiles.closed
  s.openedTiles = tiles.opened
  s.deepWater = g.deepWater
}

/** Sets the edits' water planes on a plane map (new arrays when one changes); counts the changed blocks. */
function setPlanes(types: Uint8Array | undefined, heights: Float32Array | undefined, levels: Array<[number, number]>):
  { types: Uint8Array | undefined; heights: Float32Array | undefined; set: number } {
  if (!types || !heights || !levels.length) return { types, heights, set: 0 }
  let t = types, h = heights, set = 0
  for (const [b, levelM] of levels) {
    const y = Math.fround(levelM * 10)
    if (t[b] === NVM_PLANE_TYPE.water && h[b] === y) continue
    if (t === types) t = Uint8Array.from(types)
    if (h === heights) h = Float32Array.from(heights)
    t[b] = NVM_PLANE_TYPE.water
    h[b] = y
    set++
  }
  return { types: t, heights: h, set }
}

// --- the object footprints ---------------------------------------------------------------------------------------------

interface ObjectPlan {
  /** Ids whose old copies leave every region (drops and moves; a put with the same id re-enters where it reaches). */
  drop: Set<number>
  /** Puts by region id, with their world box. */
  byRegion: Map<number, Array<{ put: WorldEditNavPut; box: NavFootprint }>>
}

const linkedProblem = (region: number, id: number) =>
  `nav ${regionName(region)}: object ${id >>> 16}:${id & 0xffff} is linked (a bridge piece); links are never edited`

function planObjects(opts: Pick<NavEditOptions, 'objects' | 'footprint' | 'linked'>, problems: string[]): ObjectPlan {
  const plan: ObjectPlan = { drop: new Set(), byRegion: new Map() }
  const objects = opts.objects
  if (!objects) return plan
  const linked = opts.linked ?? new Set<number>()
  for (const id of objects.remove) {
    if (linked.has(id >>> 0)) problems.push(linkedProblem(id >>> 16, id >>> 0))
    else plan.drop.add(id >>> 0)
  }
  const seen = new Set<number>()
  for (const put of objects.put) {
    const id = put.id >>> 0
    if (linked.has(id)) {
      problems.push(linkedProblem(id >>> 16, id))
      continue
    }
    if (seen.has(id)) {
      problems.push(`nav: object ${id >>> 16}:${id & 0xffff} is put twice`)
      continue
    }
    seen.add(id)
    plan.drop.add(id)
    const fp = opts.footprint(put.objId)
    if (!fp) problems.push(`nav: object ${id >>> 16}:${id & 0xffff} (${put.source}): no collision navmesh bounds; only its owner region gets it`)
    const box = footprintBox(put, fp)
    for (const r of regionsReached(box, id >>> 16)) {
      let list = plan.byRegion.get(r)
      if (!list) plan.byRegion.set(r, (list = []))
      list.push({ put, box })
    }
  }
  return plan
}

/** Ids of the linked instances of one object list (with links, or the target of another's link). */
function linkedIds(objects: readonly NvmObject[]): Set<number> {
  const out = new Set<number>()
  objects.forEach(o => {
    if (o.links.length) out.add(idOf(o))
    for (const l of o.links) if (l.linkedObject >= 0 && objects[l.linkedObject]) out.add(idOf(objects[l.linkedObject]!))
  })
  return out
}

/** The region's objects and cells after the footprint plan (new arrays; the input is not mutated), or null. */
function editRegionObjects(
  regionId: number, nvm: NvmFile, cells: NvmCell[], plan: ObjectPlan, record: NavEditOptions['record'], stats: NavEditRegionStats, problems: string[],
): { objects: NvmObject[]; cells: NvmCell[] } | null {
  const puts = plan.byRegion.get(regionId) ?? []
  const touches = nvm.objects.some(o => plan.drop.has(idOf(o)))
  if (!touches && !puts.length) return null
  const linked = linkedIds(nvm.objects)
  const putById = new Map(puts.map(p => [p.put.id >>> 0, p]))
  const rx = regionId & 0xff
  const rz = (regionId >> 8) & 0xff
  const ox = NVM_REGION_SIZE * rx
  const oz = NVM_REGION_SIZE * rz

  const objects: NvmObject[] = []
  const remap = new Int32Array(nvm.objects.length).fill(-1)
  /** New index -> world box, for the objects whose cell membership is recomputed. */
  const placed = new Map<number, NavFootprint>()
  const done = new Set<number>()
  nvm.objects.forEach((o, i) => {
    const id = idOf(o)
    if (!plan.drop.has(id)) {
      remap[i] = objects.length
      objects.push(o)
      return
    }
    if (linked.has(id)) {
      problems.push(linkedProblem(regionId, id))
      remap[i] = objects.length
      objects.push(o)
      done.add(id)
      return
    }
    const p = putById.get(id)
    if (p && !done.has(id)) {
      remap[i] = objects.length
      placed.set(objects.length, p.box)
      objects.push({ ...o, objId: p.put.objId, position: [p.put.x - ox, p.put.y, p.put.z - oz], yaw: p.put.yaw, links: [] })
      done.add(id)
      stats.objects.replaced++
      return
    }
    stats.objects.removed++
  })
  for (const { put, box } of puts) {
    const id = put.id >>> 0
    if (done.has(id)) continue
    done.add(id)
    const tmpl = record?.(put.objId) ?? nvm.objects.find(o => o.objId === put.objId) ?? STATIC_RECORD
    placed.set(objects.length, box)
    objects.push({
      objId: put.objId, position: [put.x - ox, put.y, put.z - oz], type: tmpl.type, yaw: put.yaw, localUid: id & 0xffff,
      unknownShort0: tmpl.unknownShort0, isBig: tmpl.isBig, isStruct: tmpl.isStruct, regionId: id >>> 16, links: [],
    })
    stats.objects.added++
  }

  for (let n = 0; n < objects.length; n++) {
    const o = objects[n]!
    if (!o.links.some(l => l.linkedObject >= 0 && remap[l.linkedObject] !== l.linkedObject)) continue
    objects[n] = { ...o, links: o.links.map(l => ({ ...l, linkedObject: l.linkedObject < 0 ? l.linkedObject : remap[l.linkedObject]! })) }
  }
  const outCells = cells.map((c, ci) => {
    const list: number[] = []
    for (const k of c.objects) {
      const n = remap[k]!
      if (n >= 0 && !placed.has(n)) list.push(n)
    }
    for (const [n, box] of placed) {
      if (box.maxX - ox < c.minX || box.minX - ox > c.maxX || box.maxZ - oz < c.minZ || box.minZ - oz > c.maxZ) continue
      list.push(n)
    }
    list.sort((a, b) => a - b)
    return list.length === c.objects.length && list.every((v, k) => v === c.objects[k]) ? cells[ci]! : { ...c, objects: list }
  })
  return { objects, cells: outCells }
}

// --- the .nvm path (the converter's navmesh step) ---------------------------------------------------------------------

/** One region's .nvm after the edits (a new NvmFile; the input is not mutated), or null when nothing changes. */
function navEditRegion(
  regionId: number, nvm: NvmFile, layers: NavEditRegionLayers | undefined, plan: ObjectPlan, record: NavEditOptions['record'], problems: string[],
): { nvm: NvmFile; stats: NavEditRegionStats } | null {
  const stats = emptyStats(regionId)
  const g = groundEdit(nvm.heights, nvm.tileCells, nvm.openCellCount, layers)
  const tileCells = Int32Array.from(nvm.tileCells)
  const tileFlags = Uint16Array.from(nvm.tileFlags)
  let cells: NvmCell[] = nvm.cells.slice()
  let closedCell = cells.length > nvm.openCellCount ? nvm.openCellCount : -1
  const tiles = g.rule
    ? applyTileActions(g.rule, tileCells, nvm.openCellCount, t => {
      if (closedCell < 0) {
        closedCell = cells.length
        cells.push({ minX: 0, minZ: 0, maxX: NVM_REGION_SIZE, maxZ: NVM_REGION_SIZE, objects: [] })
      }
      tileCells[t] = closedCell
      tileFlags[t] = tileFlags[t]! | NVM_TILE_BLOCKED
    }, (t, cell) => {
      tileCells[t] = cell
      tileFlags[t] = tileFlags[t]! & ~NVM_TILE_BLOCKED
    }, problems, regionId)
    : { closed: [], opened: [] }
  ruleStats(stats, g, tiles)
  const planes = setPlanes(nvm.planeTypes, nvm.planeHeights, g.water)
  stats.planesSet = planes.set
  const obj = editRegionObjects(regionId, nvm, cells, plan, record, stats, problems)
  if (obj) cells = obj.cells

  const changed = g.heights !== null || tiles.closed.length || tiles.opened.length || planes.set || obj
  if (!changed) return null
  return {
    nvm: {
      ...nvm,
      heights: g.heights ?? nvm.heights,
      tileCells, tileFlags, cells,
      objects: obj ? obj.objects : nvm.objects,
      ...(planes.types ? { planeTypes: planes.types } : {}),
      ...(planes.heights ? { planeHeights: planes.heights } : {}),
    },
    stats,
  }
}

/** The converter's `navEdit` hook (../edits-hook.ts) and its report, for one convert. */
export interface NavEditRun {
  /** The region's .nvm after the edits (null: unchanged). Called once per region by the navmesh step. */
  navEdit(regionId: number, nvm: NvmFile): NvmFile | null
  /** What the nav step did so far (regions in call order) and the problems (Publish errors). */
  report(): NavEditReport
  /** Regions the plan changes for sure: layered regions and every region an edited footprint reaches (a region an
   *  old copy leaves shows up when the navmesh step calls for it). */
  readonly regions: ReadonlySet<number>
}

/** Builds the nav step of one convert from the layers and the footprint edits. */
export function createNavEdit(opts: NavEditOptions): NavEditRun {
  const problems: string[] = []
  const ignored: string[] = []
  const plan = planObjects(opts, problems)
  const stats: NavEditRegionStats[] = []
  const regions = new Set<number>([...opts.regions.keys(), ...plan.byRegion.keys()])
  return {
    regions,
    navEdit(regionId, nvm) {
      const layers = guardWalk(regionId, opts.regions.get(regionId), () => nvmFootprints(regionId, nvm, plan, opts.footprint), opts, ignored)
      const r = navEditRegion(regionId, nvm, layers, plan, opts.record, problems)
      if (!r) return null
      stats.push(r.stats)
      return r.nvm
    },
    report: () => ({ regions: stats.slice(), problems: [...new Set(problems)], ...(ignored.length ? { ignored: [...new Set(ignored)] } : {}) }),
  }
}

// --- the NavData path (the walk preview, the in-memory dry run, the checks' fixtures) --------------------------------

/**
 * The same edit on decoded NavData (nav.bin): ground and tiles per region (a closed tile gets cell openCellCount,
 * the first closed index), water planes, and the footprints through S-NAV's `editNavInstances` (a move keeps its
 * slot). The tile openness, heights, planes and instances equal what nav.bin holds after the .nvm path (tested).
 * `navModel` gives the collision navmesh of an objId no instance uses yet (else the add is a problem).
 */
export function navEditData(data: NavData, opts: NavEditOptions & { navModel?(objId: number): NavModel | null }): { data: NavData; report: NavEditReport } {
  const problems: string[] = []
  const ignored: string[] = []
  const report: NavEditReport = { regions: [], problems }
  let boxes: NavFootprint[] | null = null
  const regions = data.regions.map((r): NavRegion => {
    const layers = guardWalk(r.id, opts.regions.get(r.id), () => (boxes ??= dataFootprints(data, opts)), opts, ignored)
    const g = groundEdit(r.heights, r.tileCells, r.openCellCount, layers)
    if (!g.rule) return r
    const stats = emptyStats(r.id)
    const tileCells = Int32Array.from(r.tileCells)
    const tiles = g.rule
      ? applyTileActions(g.rule, tileCells, r.openCellCount, t => { tileCells[t] = r.openCellCount }, (t, cell) => { tileCells[t] = cell }, problems, r.id)
      : { closed: [], opened: [] }
    ruleStats(stats, g, tiles)
    const planes = setPlanes(r.planeTypes, r.planeHeights, g.water)
    stats.planesSet = planes.set
    if (!g.heights && !tiles.closed.length && !tiles.opened.length && !planes.set) return r
    report.regions.push(stats)
    return {
      ...r, heights: g.heights ?? r.heights, tileCells,
      ...(planes.types ? { planeTypes: planes.types } : {}), ...(planes.heights ? { planeHeights: planes.heights } : {}),
    }
  })

  let out: NavData = { ...data, regions }
  if (opts.objects && (opts.objects.remove.length || opts.objects.put.length)) {
    const linked = new Set<number>(opts.linked ?? [])
    data.instances.forEach(inst => {
      if (inst.links.length) linked.add(inst.id >>> 0)
      for (const l of inst.links) if (data.instances[l.target]) linked.add(data.instances[l.target]!.id >>> 0)
    })
    const exists = new Set(data.instances.map(i => i.id >>> 0))
    const refuse = (id: number) => problems.push(linkedProblem(id >>> 16, id))
    const remove: number[] = []
    for (const id of opts.objects.remove) {
      if (linked.has(id >>> 0)) refuse(id >>> 0)
      else remove.push(id >>> 0)
    }
    const put: NavInstancePut[] = []
    const putIds = new Set<number>()
    for (const p of opts.objects.put) {
      const id = p.id >>> 0
      if (putIds.has(id)) {
        problems.push(`nav: object ${id >>> 16}:${id & 0xffff} is put twice`)
        continue
      }
      putIds.add(id)
      if (linked.has(id)) {
        if (!remove.includes(id) && !opts.objects.remove.includes(id)) refuse(id)
        continue
      }
      const same = data.instances.find(i => i.objId === p.objId)
      const model = same ? same.model : opts.navModel?.(p.objId) ?? null
      if (model === null) {
        problems.push(`nav: object ${id >>> 16}:${id & 0xffff} (${p.source}): no collision navmesh for objId ${p.objId}`)
        continue
      }
      put.push({ id, objId: p.objId, model, x: p.x, y: p.y, z: p.z, yaw: p.yaw })
    }
    const result = editNavInstances(out, { remove: remove.filter(id => exists.has(id) || putIds.has(id)), put })
    out = result.data
    // per-region object counts on the owner region (the .nvm path counts every spill copy)
    const removedIds = new Set(remove.filter(id => !putIds.has(id) && exists.has(id)))
    const byRegion = new Map<number, NavEditRegionStats>(report.regions.map(s => [s.region, s]))
    const statsOf = (region: number) => {
      let s = byRegion.get(region)
      if (!s) {
        s = emptyStats(region)
        byRegion.set(region, s)
        report.regions.push(s)
      }
      return s
    }
    for (const id of removedIds) statsOf(id >>> 16).objects.removed++
    for (const p of put) statsOf(p.id >>> 16).objects[exists.has(p.id) ? 'replaced' : 'added']++
    report.regions.sort((a, b) => a.region - b.region)
  }
  report.problems = [...new Set(problems)]
  if (ignored.length) report.ignored = [...new Set(ignored)]
  return { data: out, report }
}
