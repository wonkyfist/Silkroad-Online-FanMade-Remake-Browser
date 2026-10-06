/**
 * Siege of Jangan, layer 0 (docs/SIEGE.md §3.2): the converter's wall step. From the plan (content/siege/jangan.json,
 * ./plan.ts) and the world's nav (nav.bin):
 *
 * 1. **Nav split** (./nav-split.ts): each retail wall collision navmesh (cj_{w,s,e}_stair.bms, cj_n_wall01.bms) is cut
 *    at every third's ends into per-third pieces, plus the fixed pieces (the corners and ends, the gatehouse). Pieces
 *    keep the retail instance's transform and get ids in a reserved range: regionId << 16 | 0xF000 | n (the wall's
 *    region). They are written to `siege/walls-nav.bin` (encodeNavData: models and instances, no regions); the
 *    server and the client add them to their nav at load and switch the four retail wall instances off, so nav.bin and
 *    nav-objects.bin stay as exported [deviation from §3.2, which drops the retail instances from the nav files: this
 *    keeps the step re-runnable without re-exporting 23 MB of nav, and a world without walls.json is unchanged].
 * 2. **Breach tiles** per third: the closed 2 m terrain tiles under its collision footprint, plus those in a corridor
 *    as wide as the third from 10 m inside the inner face to 30 m outside the outer face (the ditch rims), minus tiles
 *    a force-open may never take (world-edits/walk.ts walkRefusals: outside the playable rectangle, under the box of any
 *    other collision footprint: a prop, a building, the gatehouse).
 * 3. **Probe** per third: with only that third down and its tiles open, a straight walk from 30 m outside the outer face
 *    toward 10 m inside the inner face (through the third's middle, else 3 / 6 m to either side) must get through the
 *    wall: arrive, or be stopped past the inner face by an object that is not part of the walls (Jangan's palace wall
 *    stands 1.1 m behind N4-N8, a tent of the west camp right against W3c), and walk back out from there. A third
 *    whose probe fails has its corridor grown by 2 m all round, at most 3 times, then the step stops with an error.
 * 4. **Retail equality** (§14 "the nav split leaks"): straight crossings every 2 m along each wall, 25 m either side,
 *    must end where the retail nav ends them (±1 cm) with every third standing.
 *
 * Output: the WallsExport of packages/shared/src/siege.ts (`siege/walls.json`) and the nav pieces.
 */
import { NVM_REGION_SIZE, NVM_TILE_SIZE, NVM_TILES } from '@sro/formats'
import { NavWorld, editNavInstances, navPiecePuts, type NavData, type NavInstance, type NavModel, type NavPosition } from '@sro/nav'
import type { Vec3 } from '../../../../shared/src/protocol.ts'
import type { WallSide, WallsExport, WallsSegment, WallsSideInfo, WallsThird } from '../../../../shared/src/siege.ts'
import { walkRefusals, type WalkFootprintBox } from '../../../../shared/src/world-edits/walk.ts'
import { splitNavModel } from './nav-split.ts'
import { planThirds, wallInstance, type SiegePlan } from './plan.ts'

/** The breach corridor: this far outside the outer face and inside the inner face (m). */
export const CORRIDOR_OUT_M = 30
export const CORRIDOR_IN_M = 10
/** Corridor growth per failed probe (m) and the most growths. */
export const CORRIDOR_GROW_M = 2
export const CORRIDOR_GROW_MAX = 3
/** Probe offsets along the wall from a third's middle (m). */
const PROBE_OFFSETS = [0, -3, 3, -6, 6]
/** Reserved local uid range of the wall pieces. */
export const PIECE_UID_BASE = 0xf000

export interface WallsBuildInput {
  plan: SiegePlan
  /** The plan's file (repo-relative) and hash, recorded in walls.json. */
  planRef: { file: string; hash: string }
  /** manifest.placements, space.originRegion, stream.playable. */
  placements: ReadonlyArray<{ source: string; position: readonly number[]; region: number; uid: number }>
  originRegion: { x: number; z: number }
  playable?: { x0: number; x1: number; z0: number; z1: number } | null
  /** The world's full nav (nav.bin: regions, models, instances). */
  nav: NavData
  /** Per side: the cut glb and the retail sidecar (manifest-relative), when the cut ran. */
  models?: Partial<Record<WallSide, { glb: string; sidecar: string }>>
  navFile?: string
}

export interface WallsBuildResult {
  walls: WallsExport
  pieces: NavData
  /** Human lines: per side and third, tiles, probes, equality. */
  report: string[]
  /** Problems that should stop the step (failed probes, a leaking split). */
  errors: string[]
}

interface Piece {
  id: string
  side: WallSide
  /** glTF along-axis span. */
  from: number
  to: number
  fixed: string | null
  model: NavModel | null
  instanceId: number
}

const r2 = (v: number) => Math.round(v * 100) / 100

export function buildWalls(input: WallsBuildInput): WallsBuildResult {
  const { plan, nav } = input
  const o = input.originRegion
  const fileX = (x: number) => NVM_REGION_SIZE * o.x + x * 10
  const fileZ = (z: number) => NVM_REGION_SIZE * o.z - z * 10
  const report: string[] = []
  const errors: string[] = []

  // ---- 1. pieces --------------------------------------------------------------------------------------------------
  const sides: WallsSideInfo[] = []
  const pieces: Piece[] = []
  const retail: number[] = []
  const pieceModels: NavModel[] = []
  const pieceInstances: NavInstance[] = []
  for (const ps of plan.sides) {
    const p = input.placements.find(q => q.source === ps.source)
    if (!p) throw new Error(`siege walls: no placement ${ps.source}`)
    const ri = wallInstance(nav, p.region, p.uid)
    retail.push(ri)
    const inst = nav.instances[ri]!
    if (Math.abs(inst.yaw) > 1e-6) throw new Error(`siege walls: ${ps.side} wall has yaw ${inst.yaw}; the split assumes 0`)
    const model = nav.models[inst.model]!
    // glTF along-axis g -> model-local file coordinate; W and E run along -file z
    const axis = ps.axis === 'x' ? 0 : 2
    const toLocal = (g: number) => (ps.axis === 'x' ? fileX(g) - inst.x : fileZ(g) - inst.z)
    // the boundaries along the axis (glTF), with what lies between them
    const spans: { from: number; to: number; id: string; fixed: string | null }[] = []
    const segs = ps.segments
    let last = -Infinity
    const addFixed = (to: number, what: string) => {
      if (to > last) spans.push({ from: last, to, id: `${ps.side}-${what}`, fixed: what })
    }
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k]!
      if (s.from > last + 1e-6) addFixed(s.from, k === 0 ? 'end0' : 'gate')
      planThirds(s).forEach(([a, b], t) => spans.push({ from: a, to: b, id: `${s.id}${'abc'[t]}`, fixed: null }))
      last = s.to
    }
    spans.push({ from: last, to: Infinity, id: `${ps.side}-end1`, fixed: 'end1' })
    // local cuts ascending: for z walls the glTF order reverses
    const glCuts = spans.slice(1).map(s => s.from)
    const local = glCuts.map(toLocal)
    const reversed = ps.axis === 'z'
    const localSorted = reversed ? [...local].reverse() : local
    const split = splitNavModel(model, axis as 0 | 2, localSorted, k => `siege/${model.key}#${spans[reversed ? spans.length - 1 - k : k]!.id}`)
    const regionId = (inst.id >>> 16) & 0xffff
    let n = 0
    const fixedInfo: WallsSideInfo['fixed'] = []
    spans.forEach((sp, i) => {
      const m = split[reversed ? spans.length - 1 - i : i] ?? null
      const instanceId = (((regionId << 16) | (PIECE_UID_BASE | n++)) >>> 0)
      const piece: Piece = { id: sp.id, side: ps.side, from: sp.from, to: sp.to, fixed: sp.fixed, model: m, instanceId }
      pieces.push(piece)
      if (m) {
        pieceModels.push(m)
        pieceInstances.push({ id: instanceId, objId: inst.objId, model: pieceModels.length - 1, x: inst.x, y: inst.y, z: inst.z, yaw: inst.yaw, links: [] })
      }
      if (sp.fixed) fixedInfo.push({ id: sp.id, from: r2(Math.max(sp.from, -1e6)), to: r2(Math.min(sp.to, 1e6)), what: sp.fixed, instances: m ? [instanceId] : [] })
    })
    // faces across the axis (glTF), from the retail collision box
    let minC = Infinity, maxC = -Infinity, maxY = -Infinity
    for (let k = 0; k < model.vertices.length; k += 3) {
      const lx = model.vertices[k]!, lz = model.vertices[k + 2]!
      const c = ps.axis === 'x' ? -((inst.z + lz) - NVM_REGION_SIZE * o.z) / 10 : ((inst.x + lx) - NVM_REGION_SIZE * o.x) / 10
      minC = Math.min(minC, c)
      maxC = Math.max(maxC, c)
      maxY = Math.max(maxY, (inst.y + model.vertices[k + 1]!) / 10)
    }
    const out: 1 | -1 = ps.side === 'N' || ps.side === 'W' ? -1 : 1
    const models = input.models?.[ps.side]
    sides.push({
      side: ps.side, axis: ps.axis, line: r2((minC + maxC) / 2),
      outer: r2(out > 0 ? maxC : minC), inner: r2(out > 0 ? minC : maxC), out, walkY: r2(maxY),
      placement: { region: p.region, uid: p.uid, source: p.source, position: [p.position[0]!, p.position[1]!, p.position[2]!] },
      retailInstance: inst.id >>> 0,
      ...(models ? { glb: models.glb, sidecar: models.sidecar } : {}),
      fixed: fixedInfo,
    })
  }
  const piecesData: NavData = { version: nav.version, regions: [], models: pieceModels, instances: pieceInstances }

  // ---- the split world (retail walls off, pieces on) ----------------------------------------------------------------
  const world = new NavWorld(editNavInstances(nav, { put: navPiecePuts(piecesData) }).data)
  for (const ri of retail) world.setInstanceEnabled(ri, false)
  const indexOf = new Map<number, number>()
  world.data.instances.forEach((inst, i) => indexOf.set(inst.id >>> 0, i))
  const retailWorld = new NavWorld(nav)

  // ---- 2. breach tiles -----------------------------------------------------------------------------------------------
  const sideOf = new Map(sides.map(s => [s.side, s]))
  const wallIds = new Set<number>([...retail.map(i => nav.instances[i]!.id >>> 0), ...pieces.map(p => p.instanceId)])
  const fixedIds = new Set(pieces.filter(p => p.fixed).map(p => p.instanceId))
  // refusal boxes: every collision footprint but the destructible pieces and the retail walls (the fixed pieces count)
  const boxes: WalkFootprintBox[] = []
  world.data.instances.forEach((inst, i) => {
    const id = inst.id >>> 0
    if (wallIds.has(id) && !fixedIds.has(id)) return
    if (!world.isInstanceEnabled(i) && !fixedIds.has(id)) return
    boxes.push(instanceFileBox(world.data, i))
  })
  const refusalCache = new Map<number, Uint8Array>()
  const refused = (regionId: number, tile: number) => {
    let r = refusalCache.get(regionId)
    if (!r) refusalCache.set(regionId, (r = walkRefusals(regionId & 0xff, (regionId >> 8) & 0xff, { playable: input.playable ?? null }, boxes)))
    return r[tile]! !== 0
  }
  const regions = new Map(nav.regions.map(r => [r.id, r]))
  const closedRaw = (tx: number, tz: number): boolean | null => {
    const rx = Math.floor(tx / NVM_TILES), rz = Math.floor(tz / NVM_TILES)
    const r = regions.get((rz << 8) | rx)
    if (!r) return null
    const cell = r.tileCells[(tz - rz * NVM_TILES) * NVM_TILES + (tx - rx * NVM_TILES)]!
    return !(cell >= 0 && cell < r.openCellCount)
  }

  const segments: WallsSegment[] = []
  const pieceById = new Map(pieces.map(p => [p.id, p]))
  for (const ps of plan.sides) {
    const side = sideOf.get(ps.side)!
    for (const s of ps.segments) {
      const thirds = planThirds(s).map(([a, b], t): WallsThird => {
        const id = `${s.id}${'abc'[t]}`
        const piece = pieceById.get(id)!
        return {
          id, from: a, to: b,
          instances: piece.model ? [piece.instanceId] : [],
          tiles: [],
          assault: groundPoint(world, side, (a + b) / 2, side.outer + side.out * 2, o),
          rally: groundPoint(world, side, (a + b) / 2, side.inner - side.out * 10, o),
        }
      }) as [WallsThird, WallsThird, WallsThird]
      segments.push({ id: s.id, side: ps.side, from: s.from, to: s.to, thirds })
    }
  }

  const tilesFor = (t: WallsThird, side: WallsSideInfo, grow: number): [number, number][] => {
    const out = new Map<number, [number, number]>()
    const add = (tx: number, tz: number) => {
      if (closedRaw(tx, tz) !== true) return
      const rx = Math.floor(tx / NVM_TILES), rz = Math.floor(tz / NVM_TILES)
      const regionId = (rz << 8) | rx
      const tile = (tz - rz * NVM_TILES) * NVM_TILES + (tx - rx * NVM_TILES)
      if (refused(regionId, tile)) return
      out.set(regionId * 16384 + tile, [regionId, tile])
    }
    // (a) under the third's collision footprint
    const piece = pieceById.get(t.id)!
    if (piece.model) {
      const inst = pieceInstances.find(i => i.id === piece.instanceId)!
      forFootprintTiles(piece.model, inst, add)
    }
    // (b) the corridor across the ditch rims
    const a0 = t.from - grow, a1 = t.to + grow
    const c0 = side.inner - side.out * (CORRIDOR_IN_M + grow)
    const c1 = side.outer + side.out * (CORRIDOR_OUT_M + grow)
    const [x0, x1, z0, z1] = side.axis === 'x' ? [a0, a1, Math.min(c0, c1), Math.max(c0, c1)] : [Math.min(c0, c1), Math.max(c0, c1), a0, a1]
    const fx0 = fileX(x0), fx1 = fileX(x1), fz0 = fileZ(z1), fz1 = fileZ(z0)
    for (let tz = Math.floor(fz0 / NVM_TILE_SIZE); tz <= Math.floor(fz1 / NVM_TILE_SIZE); tz++) {
      for (let tx = Math.floor(fx0 / NVM_TILE_SIZE); tx <= Math.floor(fx1 / NVM_TILE_SIZE); tx++) add(tx, tz)
    }
    return [...out.values()].sort((p, q) => p[0] - q[0] || p[1] - q[1])
  }

  // ---- 3. probes ---------------------------------------------------------------------------------------------------
  const down = (t: WallsThird, tiles: [number, number][], on: boolean) => {
    for (const id of t.instances) world.setInstanceEnabled(indexOf.get(id)!, !on)
    for (const [r, tile] of tiles) world.setTileOverride(r, tile, on ? 'open' : null)
  }
  const gl = (fx: number, fz: number) => [r2((fx - NVM_REGION_SIZE * o.x) / 10), r2(-(fz - NVM_REGION_SIZE * o.z) / 10)] as const
  const probe = (t: WallsThird, side: WallsSideInfo): { ok: boolean; why: string } => {
    let why = 'no start'
    for (const off of PROBE_OFFSETS) {
      const along = (t.from + t.to) / 2 + off
      if (along < t.from || along > t.to) continue
      const inC = side.inner - side.out * CORRIDOR_IN_M
      const outC = side.outer + side.out * CORRIDOR_OUT_M
      const [ix, iz] = side.axis === 'x' ? [along, inC] : [inC, along]
      const [ox, oz] = side.axis === 'x' ? [along, outC] : [outC, along]
      // from the field into the town: through the gap and past the inner face (a building right behind the wall may
      // stop it there: the gap is open, the town's layout is not the wall's business)
      const start = terrainStart(world, fileX(ox), fileZ(oz))
      if (!start) continue
      const r = world.moveStraight(start, fileX(ix), fileZ(iz))
      const [ex, ez] = gl(r.end.x, r.end.z)
      const past = side.out * (side.inner - (side.axis === 'x' ? ez : ex))
      const what = r.hit?.instance !== undefined ? ` (${world.instanceInfo(r.hit.instance).model.split('/').pop()})` : ''
      const byWall = r.hit?.instance !== undefined && wallIds.has(world.instanceInfo(r.hit.instance).id >>> 0)
      if (r.blocked && (past <= 0 || byWall || r.hit?.kind !== 'edge')) {
        why = `blocked (${r.hit?.kind ?? '?'}${what}) at ${ex}, ${ez}`
        continue
      }
      // and back out from where it got to
      const back = world.moveStraight(r.end, fileX(ox), fileZ(oz))
      if (back.blocked) {
        why = `no way back out (stopped at ${gl(back.end.x, back.end.z).join(', ')})`
        continue
      }
      const notes = [off ? `offset ${off} m` : '', r.blocked ? `stops ${r2(past)} m inside at ${what.trim() || 'an object'}` : ''].filter(Boolean)
      return { ok: true, why: notes.join(', ') }
    }
    return { ok: false, why }
  }
  for (const seg of segments) {
    const side = sideOf.get(seg.side)!
    for (const t of seg.thirds) {
      let grow = 0
      let tiles = tilesFor(t, side, 0)
      let res: { ok: boolean; why: string }
      for (;;) {
        down(t, tiles, true)
        res = probe(t, side)
        down(t, tiles, false)
        if (res.ok || grow >= CORRIDOR_GROW_MAX * CORRIDOR_GROW_M) break
        grow += CORRIDOR_GROW_M
        tiles = tilesFor(t, side, grow)
      }
      t.tiles = tiles
      report.push(`${t.id}: ${r2(t.to - t.from)} m, ${t.instances.length} nav piece(s), ${tiles.length} tiles${grow ? ` (corridor +${grow} m)` : ''}, probe ${res.ok ? 'walks' : 'FAILS'}${res.why ? ` (${res.why})` : ''}`)
      if (!res.ok) errors.push(`${t.id}: the breach probe does not walk through (${res.why})`)
    }
  }

  // ---- 4. retail equality ------------------------------------------------------------------------------------------
  const eq = compareCrossings(retailWorld, world, sides, segments, fileX, fileZ, retail.map(i => instanceFileBox(nav, i)))
  report.push(`retail equality: ${eq.crossings} crossings every 2 m, ${eq.mismatches.length} differ`)
  for (const m of eq.mismatches) report.push(`  differs: ${m}`)
  if (eq.mismatches.length) errors.push(`the nav split differs from the retail walls on ${eq.mismatches.length} of ${eq.crossings} crossings`)

  const walls: WallsExport = {
    version: 1,
    world: plan.world,
    plan: input.planRef,
    navFile: input.navFile ?? 'siege/walls-nav.bin',
    sides,
    segments,
  }
  return { walls, pieces: piecesData, report, errors }
}

/** A terrain start at a file point: open terrain, else nothing. */
function terrainStart(world: NavWorld, x: number, z: number): NavPosition | null {
  if (!world.terrainOpen(x, z)) return null
  const y = world.terrainHeight(x, z)
  return Number.isFinite(y) ? { x, y, z, surface: { kind: 'terrain' } } : null
}

/** The ground point (glTF m) at (along, across) of a side. */
function groundPoint(world: NavWorld, side: WallsSideInfo, along: number, across: number, o: { x: number; z: number }): Vec3 {
  const [x, z] = side.axis === 'x' ? [along, across] : [across, along]
  const y = world.terrainHeight(NVM_REGION_SIZE * o.x + x * 10, NVM_REGION_SIZE * o.z - z * 10) / 10
  return [r2(x), Number.isFinite(y) ? r2(y) : 0, r2(z)]
}

/** World file XZ box of an instance's collision mesh. */
export function instanceFileBox(data: NavData, i: number): WalkFootprintBox {
  const inst = data.instances[i]!
  const m = data.models[inst.model]!
  const c = Math.cos(inst.yaw), s = Math.sin(inst.yaw)
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let k = 0; k < m.vertices.length; k += 3) {
    const lx = m.vertices[k]!, lz = m.vertices[k + 2]!
    const x = inst.x + c * lx - s * lz, z = inst.z + s * lx + c * lz
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
  }
  return { minX, maxX, minZ, maxZ }
}

/** Calls `fn(tx, tz)` for every global tile a triangle of the model overlaps (separating axes on XZ). */
export function forFootprintTiles(model: NavModel, inst: Pick<NavInstance, 'x' | 'z' | 'yaw'>, fn: (tx: number, tz: number) => void): void {
  const c = Math.cos(inst.yaw), s = Math.sin(inst.yaw)
  const v = model.vertices
  const seen = new Set<number>()
  const T = NVM_TILE_SIZE
  for (let t = 0; t < model.cells.length; t += 3) {
    const px: number[] = [], pz: number[] = []
    for (let k = 0; k < 3; k++) {
      const i = model.cells[t + k]!
      const lx = v[i * 3]!, lz = v[i * 3 + 2]!
      px.push(inst.x + c * lx - s * lz)
      pz.push(inst.z + s * lx + c * lz)
    }
    const area = (px[1]! - px[0]!) * (pz[2]! - pz[0]!) - (pz[1]! - pz[0]!) * (px[2]! - px[0]!)
    if (Math.abs(area) < 1e-6) continue
    for (let tz = Math.floor(Math.min(...pz) / T); tz <= Math.floor(Math.max(...pz) / T); tz++) {
      for (let tx = Math.floor(Math.min(...px) / T); tx <= Math.floor(Math.max(...px) / T); tx++) {
        const key = tz * 65536 + tx
        if (seen.has(key)) continue
        if (!triangleHitsSquare(px, pz, tx * T, tz * T, T)) continue
        seen.add(key)
        fn(tx, tz)
      }
    }
  }
}

/** Whether a triangle overlaps the open square [x0, x0 + size) x [z0, z0 + size) (touching does not count). */
function triangleHitsSquare(px: number[], pz: number[], x0: number, z0: number, size: number): boolean {
  const eps = 1e-6
  const sq = [[x0, z0], [x0 + size, z0], [x0 + size, z0 + size], [x0, z0 + size]] as const
  const axes: [number, number][] = [[1, 0], [0, 1]]
  for (let k = 0; k < 3; k++) {
    const j = (k + 1) % 3
    axes.push([-(pz[j]! - pz[k]!), px[j]! - px[k]!])
  }
  for (const [ax, az] of axes) {
    let t0 = Infinity, t1 = -Infinity, s0 = Infinity, s1 = -Infinity
    for (let k = 0; k < 3; k++) {
      const d = px[k]! * ax + pz[k]! * az
      t0 = Math.min(t0, d); t1 = Math.max(t1, d)
    }
    for (const [x, z] of sq) {
      const d = x * ax + z * az
      s0 = Math.min(s0, d); s1 = Math.max(s1, d)
    }
    const len = Math.hypot(ax, az)
    if (t1 <= s0 + eps * len || s1 <= t0 + eps * len) return false
  }
  return true
}

/**
 * Straight crossings every 2 m along each wall (25 m either side of its line, both ways), walked on the retail world and
 * on the split one (every third standing): the end points (±1 cm) and the blocked flags must agree. Starts that are not
 * open terrain are skipped.
 */
export function compareCrossings(
  retail: NavWorld, split: NavWorld, sides: readonly WallsSideInfo[], segments: readonly WallsSegment[],
  fileX: (x: number) => number, fileZ: (z: number) => number, solids: readonly WalkFootprintBox[] = [], stepM = 2, reachM = 25,
): { crossings: number; mismatches: string[] } {
  const inSolid = (x: number, z: number) => solids.some(b => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ)
  let crossings = 0
  const mismatches: string[] = []
  for (const side of sides) {
    const segs = segments.filter(s => s.side === side.side)
    if (!segs.length) continue
    const a0 = Math.min(...segs.map(s => s.from), ...side.fixed.map(f => f.from)) - 5
    const a1 = Math.max(...segs.map(s => s.to), ...side.fixed.map(f => f.to)) + 5
    for (let a = Math.ceil(a0 / stepM) * stepM; a <= a1; a += stepM) {
      for (const dir of [1, -1]) {
        const c0 = side.line - dir * reachM, c1 = side.line + dir * reachM
        const [x0, z0] = side.axis === 'x' ? [a, c0] : [c0, a]
        const [x1, z1] = side.axis === 'x' ? [a, c1] : [c1, a]
        // a start inside a wall's body (the corners) is no place to stand
        if (inSolid(fileX(x0), fileZ(z0))) continue
        const s0 = terrainStart(retail, fileX(x0), fileZ(z0))
        if (!s0) continue
        crossings++
        const r = retail.moveStraight(s0, fileX(x1), fileZ(z1))
        const q = split.moveStraight(s0, fileX(x1), fileZ(z1))
        if (r.blocked !== q.blocked || Math.hypot(r.end.x - q.end.x, r.end.z - q.end.z) > 0.1) {
          mismatches.push(`${side.side} at ${a} (${dir * side.out > 0 ? 'outward' : 'inward'}): retail ${r.blocked ? 'blocked' : 'through'} at ${r2(r.end.x)},${r2(r.end.z)}; split ${q.blocked ? 'blocked' : 'through'} at ${r2(q.end.x)},${r2(q.end.z)}`)
        }
      }
    }
  }
  return { crossings, mismatches }
}
