/**
 * Validators of the edit layers (docs/WORLD_EDITOR.md §6.2 step 1, §6.3 check 1; docs/WAVE_PLAN8.md §3.3). Publish
 * refuses a layer with any problem; the editor runs the same checks on Save. Each returns `{ ok, problems }`, and a
 * problem names its path (`placements.move[2].to.scale: ...`). The context is optional: the checks that need the
 * export (known placements, exported regions, model kinds, tiles, sounds) run only when it gives them.
 */
import type { Vec3 } from '../protocol.ts'
import { placementKey, regionOfPosition } from './apply.ts'
import {
  WE_BLOCKS, WE_EDITOR_UID_MAX, WE_EDITOR_UID_MIN, WE_FROM_TOLERANCE_M, WE_GRASS, WE_GRID, WE_HEIGHT_MAX_M,
  WE_HEIGHT_MIN_M, WE_HEIGHT_STEPS_PER_M, WE_LAYER_KINDS, WE_LIGHT_KINDS, WE_PROP_SCALE, WE_TILE_ID_MASK, WE_TILES,
  WE_TREE_SCALE, WE_ZONE_WHEN, WORLD_EDITS_FORMAT, WORLD_EDITS_PLACEMENTS_FORMAT, WORLD_EDITS_VERSION,
  type GrassLayer, type HeightLayer, type PaintLayer, type WalkLayer, type WorldEditCheck,
} from './types.ts'

/** How a model may be scaled: trees 0.85-1.15, footprint-free props 0.5-2, anything else with a footprint never. */
export type WorldEditModelKind = 'tree' | 'prop' | 'blocker'

export interface WorldEditsContext {
  /** The export's folder name (e.g. 'jangan-fields'); the files' `world` must match. */
  world?: string
  /** manifest.space.originRegion. */
  originRegion?: { x: number; z: number }
  /** Whether region (rx, rz) is in the export. */
  exported?(rx: number, rz: number): boolean
  /** The export's (pre-pass) placement by key: its source, position, yaw, and whether its nav instance has links. */
  placement?(region: number, uid: number): { source: string; position: Vec3; yaw: number; links?: boolean } | undefined
  /** A model source's scale class; undefined = not a known model. */
  modelKind?(source: string): WorldEditModelKind | undefined
  /** Whether a tile2d id is in the export's tile set. */
  tile?(id: number): boolean
  /** Whether a key is in the exported sound index. */
  sound?(key: string): boolean
  /** Number of flower kinds (the grass layer's B channel must be below it). */
  flowerKinds?: number
}

class Problems {
  readonly list: string[] = []
  add(path: string, what: string): void {
    this.list.push(`${path}: ${what}`)
  }
  get result(): WorldEditCheck {
    return { ok: this.list.length === 0, problems: this.list }
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum)

function header(p: Problems, json: Record<string, unknown>, format: string, ctx: WorldEditsContext, path: string): void {
  if (json.format !== format) p.add(`${path}.format`, `expected '${format}'`)
  if (json.version !== WORLD_EDITS_VERSION) p.add(`${path}.version`, `expected ${WORLD_EDITS_VERSION}`)
  if (!isStr(json.world)) p.add(`${path}.world`, 'expected a world name')
  else if (ctx.world !== undefined && json.world !== ctx.world) p.add(`${path}.world`, `expected '${ctx.world}'`)
}

function list(p: Problems, json: Record<string, unknown>, key: string, path: string): unknown[] {
  const v = json[key]
  if (v === undefined) return []
  if (!Array.isArray(v)) {
    p.add(`${path}.${key}`, 'expected a list')
    return []
  }
  return v
}

function rows(json: unknown, what: string, p: Problems): unknown[] {
  if (!Array.isArray(json)) {
    p.add(what, 'expected a list')
    return []
  }
  return json
}

function uniqueId(p: Problems, ids: Set<string>, row: Record<string, unknown>, path: string): void {
  if (!isStr(row.id)) return p.add(`${path}.id`, 'expected an id')
  if (ids.has(row.id)) p.add(`${path}.id`, `duplicate id ${row.id}`)
  ids.add(row.id)
}

// --- edits.json -------------------------------------------------------------------------------------------------------

export function validateWorldEditsIndex(json: unknown, ctx: WorldEditsContext = {}): WorldEditCheck {
  const p = new Problems()
  if (!isObj(json)) return { ok: false, problems: ['edits: expected an object'] }
  header(p, json, WORLD_EDITS_FORMAT, ctx, 'edits')
  const seen = new Set<string>()
  list(p, json, 'regions', 'edits').forEach((r, i) => {
    const w = `edits.regions[${i}]`
    if (!isObj(r)) return p.add(w, 'expected an object')
    if (!isInt(r.x, 0, 255) || !isInt(r.z, 0, 255)) return p.add(w, 'expected region coordinates x, z (0..255)')
    const key = `${r.x}_${r.z}`
    if (seen.has(key)) p.add(w, `region ${key} listed twice`)
    seen.add(key)
    if (ctx.exported && !ctx.exported(r.x, r.z)) p.add(w, `region ${key} is not in the export`)
    if (typeof r.base !== 'string' || !/^[0-9a-f]{64}$/.test(r.base)) p.add(`${w}.base`, 'expected the SHA-256 (hex) of the base heights')
    if (!Array.isArray(r.layers) || !r.layers.length) p.add(`${w}.layers`, 'expected a non-empty list of layer kinds')
    else {
      for (const k of r.layers) if (!WE_LAYER_KINDS.includes(k as never)) p.add(`${w}.layers`, `unknown layer kind ${String(k)}`)
      if (new Set(r.layers).size !== r.layers.length) p.add(`${w}.layers`, 'a layer kind listed twice')
    }
  })
  if (json.counts !== undefined && (!isObj(json.counts) || !Object.values(json.counts).every(v => isInt(v, 0, Number.MAX_SAFE_INTEGER)))) {
    p.add('edits.counts', 'expected counts by name')
  }
  if (json.notes !== undefined && typeof json.notes !== 'string') p.add('edits.notes', 'expected text')
  return p.result
}

// --- placements.json --------------------------------------------------------------------------------------------------

/**
 * placements.json: the shape, then against the export (when the context gives it): moves and drops name a known
 * retail placement (16-bit uid; the town dressing's 1,000,000+ props are edited by row id, never here), its source and
 * position match, and it is not a linked bridge piece; each placement is edited once; adds name a known model; a
 * stored owner region matches the position and lies in the export; a stored editor uid is in 0xE000-0xEFFF and unique
 * in its region; scales stay in their class's range.
 */
export function validateWorldEditPlacements(json: unknown, ctx: WorldEditsContext = {}): WorldEditCheck {
  const p = new Problems()
  if (!isObj(json)) return { ok: false, problems: ['placements: expected an object'] }
  header(p, json, WORLD_EDITS_PLACEMENTS_FORMAT, ctx, 'placements')
  const edited = new Set<string>()
  const editorUids = new Set<string>()

  const checkScale = (w: string, scale: unknown, source: unknown) => {
    if (scale === undefined) return
    if (!isNum(scale) || scale <= 0) return p.add(`${w}.scale`, 'expected a positive number')
    const kind = isStr(source) ? ctx.modelKind?.(source) : undefined
    if (!kind) {
      if (scale < WE_PROP_SCALE[0] || scale > WE_PROP_SCALE[1]) p.add(`${w}.scale`, `outside ${WE_PROP_SCALE[0]}-${WE_PROP_SCALE[1]}`)
      return
    }
    if (kind === 'blocker' && scale !== 1) p.add(`${w}.scale`, 'buildings and other walk blockers are never scaled')
    const [lo, hi] = kind === 'tree' ? WE_TREE_SCALE : WE_PROP_SCALE
    if (kind !== 'blocker' && (scale < lo - 1e-9 || scale > hi + 1e-9)) p.add(`${w}.scale`, `a ${kind} scales ${lo}-${hi}`)
  }

  const checkOwner = (w: string, position: Vec3, region: unknown, uid: unknown, keepUid?: number) => {
    let owner: number | undefined
    if (ctx.originRegion) {
      owner = regionOfPosition(position, ctx.originRegion)
      if (ctx.exported && !ctx.exported(owner & 0xff, owner >> 8)) p.add(`${w}.position`, 'outside the exported regions')
    }
    if (region !== undefined) {
      if (!isInt(region, 0, 0xffff)) p.add(`${w}.region`, 'expected a region id')
      else if (owner !== undefined && region !== owner) p.add(`${w}.region`, `the position's owner region is ${owner}`)
    }
    if (uid === undefined || uid === keepUid) return
    if (!isInt(uid, WE_EDITOR_UID_MIN, WE_EDITOR_UID_MAX)) return p.add(`${w}.uid`, 'outside the editor range 0xE000-0xEFFF')
    const r = isInt(region, 0, 0xffff) ? region : owner
    if (r === undefined) return p.add(`${w}.uid`, 'an editor uid needs its owner region')
    const key = placementKey(r, uid)
    if (editorUids.has(key)) p.add(`${w}.uid`, `editor uid ${uid} used twice in region ${r}`)
    editorUids.add(key)
  }

  const checkRetail = (w: string, e: Record<string, unknown>, move: boolean): boolean => {
    if (!isInt(e.region, 0, 0xffff)) return p.add(`${w}.region`, 'expected a region id'), false
    if (!isInt(e.uid, 0, 0xffff)) {
      p.add(`${w}.uid`, Number.isInteger(e.uid) && (e.uid as number) > 0xffff ? 'not a retail uid (town dressing props are edited by row id)' : 'expected a 16-bit uid')
      return false
    }
    const key = placementKey(e.region, e.uid)
    if (edited.has(key)) p.add(w, `placement ${key} edited twice`)
    edited.add(key)
    if (!isStr(e.source)) p.add(`${w}.source`, 'expected the model source path')
    const from = e.from
    if (!isObj(from) || !isVec3(from.position) || !isNum(from.yaw)) p.add(`${w}.from`, 'expected { position, yaw }')
    const known = ctx.placement?.(e.region, e.uid)
    if (ctx.placement && !known) return p.add(w, `unknown placement ${key}`), false
    if (known) {
      if (isStr(e.source) && known.source.toLowerCase() !== e.source.toLowerCase()) p.add(`${w}.source`, `the object changed under the edit (now ${known.source})`)
      if (isObj(from) && isVec3(from.position)) {
        const d = Math.hypot(known.position[0] - from.position[0], known.position[1] - from.position[1], known.position[2] - from.position[2])
        if (d > WE_FROM_TOLERANCE_M) p.add(`${w}.from`, `the object moved under the edit (${d.toFixed(3)} m)`)
      }
      if (known.links) p.add(w, `placement ${key} is joined to its neighbours (a bridge piece) and can't be ${move ? 'moved' : 'removed'} on its own`)
    }
    return true
  }

  list(p, json, 'drop', 'placements').forEach((d, i) => {
    const w = `placements.drop[${i}]`
    if (!isObj(d)) return p.add(w, 'expected an object')
    checkRetail(w, d, false)
  })
  list(p, json, 'move', 'placements').forEach((m, i) => {
    const w = `placements.move[${i}]`
    if (!isObj(m)) return p.add(w, 'expected an object')
    const ok = checkRetail(w, m, true)
    const to = m.to
    if (!isObj(to) || !isVec3(to.position) || !isNum(to.yaw)) return p.add(`${w}.to`, 'expected { position, yaw, scale? }')
    checkScale(`${w}.to`, to.scale, m.source)
    const owner = ctx.originRegion ? regionOfPosition(to.position, ctx.originRegion) : undefined
    const sameOwner = ok && owner !== undefined && owner === m.region
    if (sameOwner && to.uid !== undefined && to.uid !== m.uid) p.add(`${w}.to.uid`, 'a move inside its region keeps its uid')
    checkOwner(`${w}.to`, to.position, to.region, to.uid, sameOwner ? (m.uid as number) : undefined)
  })
  const ids = new Set<string>()
  list(p, json, 'add', 'placements').forEach((a, i) => {
    const w = `placements.add[${i}]`
    if (!isObj(a)) return p.add(w, 'expected an object')
    if (!isStr(a.id) || !/^ed-\d+$/.test(a.id)) p.add(`${w}.id`, "expected 'ed-<n>'")
    else if (ids.has(a.id)) p.add(`${w}.id`, `duplicate id ${a.id}`)
    else ids.add(a.id)
    if (!isStr(a.source)) p.add(`${w}.source`, 'expected the model source path')
    else if (ctx.modelKind && !ctx.modelKind(a.source)) p.add(`${w}.source`, `unknown model ${a.source}`)
    if (!isVec3(a.position) || !isNum(a.yaw)) return p.add(w, 'expected a position and a yaw')
    checkScale(w, a.scale, a.source)
    checkOwner(w, a.position, a.region, a.uid)
  })
  return p.result
}

// --- region layers ----------------------------------------------------------------------------------------------------

function regionCheck(p: Problems, w: string, rx: number, rz: number, ctx: WorldEditsContext): boolean {
  if (!isInt(rx, 0, 255) || !isInt(rz, 0, 255)) return p.add(w, 'bad region coordinates'), false
  if (ctx.exported && !ctx.exported(rx, rz)) return p.add(w, `region ${rx}_${rz} is not in the export (no layer exists outside it)`), false
  return true
}

/**
 * A height layer: every delta on the 1/256 m grid within -128 ... +127.996 m, zero where untouched, and zero on the
 * export's outer edge (a side whose neighbour region is not exported: brushes fade to zero there, §7.3).
 */
export function validateHeightLayer(rx: number, rz: number, layer: HeightLayer, ctx: WorldEditsContext = {}): WorldEditCheck {
  const p = new Problems()
  const w = `height/${rx}_${rz}`
  if (layer.delta.length !== WE_GRID * WE_GRID || layer.mask.length !== WE_GRID * WE_GRID) return { ok: false, problems: [`${w}: expected 97 x 97`] }
  if (!regionCheck(p, w, rx, rz, ctx)) return p.result
  let offGrid = 0, outside = 0, stray = 0, edge = 0
  const outer = ctx.exported
    ? { w: !ctx.exported(rx - 1, rz), e: !ctx.exported(rx + 1, rz), s: !ctx.exported(rx, rz - 1), n: !ctx.exported(rx, rz + 1) }
    : null
  for (let gz = 0; gz < WE_GRID; gz++) {
    for (let gx = 0; gx < WE_GRID; gx++) {
      const i = gz * WE_GRID + gx
      const d = layer.delta[i]!
      if (!layer.mask[i]) {
        if (d !== 0) stray++
        continue
      }
      if (!Number.isFinite(d) || d < WE_HEIGHT_MIN_M || d > WE_HEIGHT_MAX_M) outside++
      else if (!Number.isInteger(d * WE_HEIGHT_STEPS_PER_M)) offGrid++
      if (d !== 0 && outer && ((outer.w && gx === 0) || (outer.e && gx === WE_GRID - 1) || (outer.s && gz === 0) || (outer.n && gz === WE_GRID - 1))) edge++
    }
  }
  if (outside) p.add(w, `${outside} delta(s) outside -128 ... +127.996 m`)
  if (offGrid) p.add(w, `${offGrid} delta(s) off the 1/256 m grid`)
  if (stray) p.add(w, `${stray} untouched vertex(es) carry a delta`)
  if (edge) p.add(w, `${edge} delta(s) outside the export edge (the outermost vertices must stay 0)`)
  return p.result
}

/** A paint layer: painted words name a known tile (bits 10-12 zero, tiling 0-7). */
export function validatePaintLayer(rx: number, rz: number, layer: PaintLayer, ctx: WorldEditsContext = {}): WorldEditCheck {
  const p = new Problems()
  const w = `paint/${rx}_${rz}`
  if (layer.words.length !== WE_GRID * WE_GRID || layer.mask.length !== WE_GRID * WE_GRID) return { ok: false, problems: [`${w}: expected 97 x 97`] }
  if (!regionCheck(p, w, rx, rz, ctx)) return p.result
  const unknown = new Set<number>()
  let reserved = 0
  for (let i = 0; i < layer.words.length; i++) {
    if (!layer.mask[i]) continue
    const word = layer.words[i]!
    if (word & 0x1c00) reserved++
    const id = word & WE_TILE_ID_MASK
    if (ctx.tile && !ctx.tile(id)) unknown.add(id)
  }
  if (reserved) p.add(w, `${reserved} word(s) set the reserved bits 10-12`)
  if (unknown.size) p.add(w, `unknown tile id(s) ${[...unknown].sort((a, b) => a - b).join(', ')}`)
  return p.result
}

/** A grass layer: 192 x 192; flower kinds below `flowerKinds` when given. */
export function validateGrassLayer(rx: number, rz: number, layer: GrassLayer, ctx: WorldEditsContext = {}): WorldEditCheck {
  const p = new Problems()
  const w = `grass/${rx}_${rz}`
  const n = WE_GRASS * WE_GRASS
  if ([layer.density, layer.flowers, layer.kind, layer.mask].some(a => a.length !== n)) return { ok: false, problems: [`${w}: expected 192 x 192`] }
  if (!regionCheck(p, w, rx, rz, ctx)) return p.result
  if (ctx.flowerKinds !== undefined) {
    let bad = 0
    for (let i = 0; i < n; i++) if (layer.mask[i] && layer.flowers[i] && layer.kind[i]! >= ctx.flowerKinds) bad++
    if (bad) p.add(w, `${bad} texel(s) name a flower kind >= ${ctx.flowerKinds}`)
  }
  return p.result
}

/** A walk layer: codes 0 (auto), 1 (force open), 2 (force closed). */
export function validateWalkLayer(rx: number, rz: number, layer: WalkLayer, ctx: WorldEditsContext = {}): WorldEditCheck {
  const p = new Problems()
  const w = `walk/${rx}_${rz}`
  if (layer.codes.length !== WE_TILES * WE_TILES) return { ok: false, problems: [`${w}: expected 96 x 96`] }
  if (!regionCheck(p, w, rx, rz, ctx)) return p.result
  let bad = 0
  for (const c of layer.codes) if (c > 2) bad++
  if (bad) p.add(w, `${bad} tile(s) with an unknown code (0 auto, 1 open, 2 closed)`)
  return p.result
}

// --- water, lights, zones, probes ------------------------------------------------------------------------------------

/** water.json: blocks 0..5 of an exported region, one row per block, a finite level. */
export function validateWorldEditWater(json: unknown, ctx: WorldEditsContext = {}): WorldEditCheck {
  const p = new Problems()
  const ids = new Set<string>()
  const blocks = new Set<string>()
  rows(json, 'water', p).forEach((r, i) => {
    const w = `water[${i}]`
    if (!isObj(r)) return p.add(w, 'expected an object')
    uniqueId(p, ids, r, w)
    if (!isInt(r.region, 0, 0xffff)) p.add(`${w}.region`, 'expected a region id')
    else if (ctx.exported && !ctx.exported(r.region & 0xff, r.region >> 8)) p.add(`${w}.region`, 'not in the export')
    if (!isNum(r.heightM) || r.heightM < WE_HEIGHT_MIN_M || r.heightM > 1000) p.add(`${w}.heightM`, 'expected a water level (m)')
    if (!Array.isArray(r.blocks) || !r.blocks.length) return p.add(`${w}.blocks`, 'expected [[bx, bz], ...]')
    r.blocks.forEach((b, j) => {
      if (!Array.isArray(b) || b.length !== 2 || !isInt(b[0], 0, WE_BLOCKS - 1) || !isInt(b[1], 0, WE_BLOCKS - 1)) {
        return p.add(`${w}.blocks[${j}]`, 'expected [bx, bz] in 0..5')
      }
      const key = `${String(r.region)}:${b[0]},${b[1]}`
      if (blocks.has(key)) p.add(`${w}.blocks[${j}]`, 'block set twice')
      blocks.add(key)
    })
  })
  return p.result
}

/** lights.json: free light points. */
export function validateWorldEditLights(json: unknown): WorldEditCheck {
  const p = new Problems()
  const ids = new Set<string>()
  rows(json, 'lights', p).forEach((r, i) => {
    const w = `lights[${i}]`
    if (!isObj(r)) return p.add(w, 'expected an object')
    uniqueId(p, ids, r, w)
    if (![r.x, r.y, r.z].every(isNum)) p.add(w, 'expected x, y, z')
    if (!WE_LIGHT_KINDS.includes(r.kind as never)) p.add(`${w}.kind`, `expected one of ${WE_LIGHT_KINDS.join(', ')}`)
    if (!Array.isArray(r.colour) || r.colour.length !== 3 || !r.colour.every(c => isNum(c) && c >= 0 && c <= 1)) p.add(`${w}.colour`, 'expected [r, g, b] in 0..1')
    if (!isNum(r.intensity) || r.intensity < 0 || r.intensity > 10) p.add(`${w}.intensity`, 'expected 0..10')
    if (!isNum(r.radiusM) || r.radiusM < 0.5 || r.radiusM > 60) p.add(`${w}.radiusM`, 'expected 0.5..60 m')
  })
  return p.result
}

/** zones.json: sound zones (a circle or a polygon of at least 3 points), a known sound, gain, fade, when. */
export function validateWorldEditZones(json: unknown, ctx: WorldEditsContext = {}): WorldEditCheck {
  const p = new Problems()
  const ids = new Set<string>()
  rows(json, 'zones', p).forEach((r, i) => {
    const w = `zones[${i}]`
    if (!isObj(r)) return p.add(w, 'expected an object')
    uniqueId(p, ids, r, w)
    if (!isStr(r.name)) p.add(`${w}.name`, 'expected a name')
    const s = r.shape
    if (isObj(s) && isObj(s.circle) && !('poly' in s)) {
      const c = s.circle
      if (!isNum(c.x) || !isNum(c.z) || !isNum(c.r) || c.r <= 0) p.add(`${w}.shape.circle`, 'expected { x, z, r > 0 }')
    } else if (isObj(s) && Array.isArray(s.poly) && !('circle' in s)) {
      if (s.poly.length < 3 || !s.poly.every(q => Array.isArray(q) && q.length === 2 && q.every(isNum))) p.add(`${w}.shape.poly`, 'expected at least 3 [x, z] points')
    } else p.add(`${w}.shape`, 'expected { circle } or { poly }')
    if (!isStr(r.sound)) p.add(`${w}.sound`, 'expected a sound key')
    else if (ctx.sound && !ctx.sound(r.sound)) p.add(`${w}.sound`, `unknown sound ${r.sound}`)
    if (!isNum(r.gainDb) || r.gainDb < -60 || r.gainDb > 12) p.add(`${w}.gainDb`, 'expected -60..12 dB')
    if (!isNum(r.fadeM) || r.fadeM < 0 || r.fadeM > 200) p.add(`${w}.fadeM`, 'expected 0..200 m')
    if (!WE_ZONE_WHEN.includes(r.when as never)) p.add(`${w}.when`, `expected one of ${WE_ZONE_WHEN.join(', ')}`)
  })
  return p.result
}

/** probes.json: named points that must stay reachable from town. */
export function validateWorldEditProbes(json: unknown, ctx: WorldEditsContext = {}): WorldEditCheck {
  const p = new Problems()
  const ids = new Set<string>()
  rows(json, 'probes', p).forEach((r, i) => {
    const w = `probes[${i}]`
    if (!isObj(r)) return p.add(w, 'expected an object')
    uniqueId(p, ids, r, w)
    if (!isStr(r.name)) p.add(`${w}.name`, 'expected a name')
    if (!isNum(r.x) || !isNum(r.z) || (r.y !== undefined && !isNum(r.y))) return p.add(w, 'expected x, z (and an optional y)')
    if (ctx.originRegion && ctx.exported) {
      const id = regionOfPosition([r.x, 0, r.z], ctx.originRegion)
      if (!ctx.exported(id & 0xff, id >> 8)) p.add(w, 'outside the exported regions')
    }
  })
  return p.result
}
