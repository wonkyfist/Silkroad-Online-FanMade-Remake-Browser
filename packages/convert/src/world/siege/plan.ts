/**
 * Siege of Jangan, layer 0 (docs/SIEGE.md §2.1, §3): the segment plan of Jangan's four outer walls, measured on the
 * world export and written to content/siege/jangan.json (committed: it names the segments the server, the client, the
 * cut and the nav split all use).
 *
 * Per side (glTF metres; N and S run along x, W and E along z, numbered with the axis: N1 is the west end, W1 the
 * north end):
 * - the **run** is the stretch of the wall's own collision navmesh between the bodies of the two walls that cross it
 *   (the corners, 1 m clear): the corners stay whole and indestructible;
 * - the **gate** (S, W, E) is the span of the gatehouse meshes (door, roof, crenels and trim around the arch) plus
 *   GATE_MARGIN_M on each side: indestructible, so the three known ways in stay;
 * - each part of the run left of / right of the gate is split into the spec's segment counts (N 10, S 5 + 4, W 4 + 3,
 *   E 4 + 3: 33), equal lengths, then every inner end is moved to the nearest half-repeat line of the wall texture
 *   (cj_wall01, 11.3-12 m per repeat along the wall; half, so an end moves at most a quarter repeat, ≈ 3 m, and the
 *   lengths stay near the target; the bricks are a fraction of a metre, so a half line is as clean as a whole one)
 *   [decision §2.1: "cut at the wall texture's repeat"];
 * - thirds are equal thirds of a segment (a, b, c in the axis direction).
 *
 * Everything the plan does not cover (the corners, the gate, the model's ends past the run) is drawn and collides as
 * fixed, indestructible pieces (walls.ts).
 */
import type { NavData } from '@sro/nav'
import type { WallSide } from '../../../../shared/src/siege.ts'

export const SIEGE_PLAN_VERSION = 1

/** The spec's segment counts per part of each side (docs/SIEGE.md §2.1): one part (N) or west|north, east|south. */
export const SEGMENT_COUNTS: Readonly<Record<WallSide, readonly number[]>> = { N: [10], S: [5, 4], W: [4, 3], E: [4, 3] }
/** Kept clear of the gatehouse meshes on each side (m). */
export const GATE_MARGIN_M = 10
/** Kept clear of a crossing wall's body at a corner (m). */
export const CORNER_MARGIN_M = 1
/** Retail model of each side (manifest placement source). */
export const WALL_SOURCES: Readonly<Record<WallSide, RegExp>> = {
  N: /\\jangan_enter\\cj_n\.bsr$/i,
  S: /\\jangan_enter\\cj_s\.bsr$/i,
  W: /\\jangan_enter\\cj_w\.bsr$/i,
  E: /\\jangan_enter\\cj_e\.bsr$/i,
}
/** The gatehouse meshes (by glb node name): everything around the arch, not the full-length wall-walk pieces. */
export const GATE_NODES = /^CJ_[swe]_(door|roof|alpha|wall03|wall04|wall05)$/i

export interface PlanSegment {
  id: string
  from: number
  to: number
}

export interface PlanSide {
  side: WallSide
  /** Manifest placement source of the retail wall. */
  source: string
  axis: 'x' | 'z'
  /** The destructible stretch [from, to] along the axis. */
  run: [number, number]
  /** The gatehouse span (indestructible), or null (N). */
  gate: [number, number] | null
  segments: PlanSegment[]
}

export interface SiegePlan {
  version: number
  world: string
  about: string
  /** Per side: the wall texture's repeat along the wall (m) and its phase (a repeat line lies at phase + k * repeatM). */
  texture: Record<WallSide, { repeatM: number; phase: number } | null>
  /** Live numbers (docs/SIEGE.md §11.2), a sparse patch over packages/shared/src/siege.ts WALL_DEFAULTS. */
  settings: { walls: Record<string, unknown> }
  sides: PlanSide[]
}

/** What the planner reads of the export. */
export interface PlanInput {
  world: string
  /** manifest.placements (source, position). */
  placements: ReadonlyArray<{ source: string; position: readonly number[]; region: number; uid: number }>
  /** The nav (instances and models; regions may be empty). */
  nav: NavData
  originRegion: { x: number; z: number }
  /** Per side: the retail glb's mesh nodes with their vertices along the axis and TEXCOORD_0 (model frame, m). */
  meshes(side: WallSide): ReadonlyArray<{ name: string; positions: Float32Array; uvs: Float32Array | null; indices: Uint32Array | Uint16Array | null }>
}

/** The nav instance of a retail wall placement (by id = regionId << 16 | uid). */
export function wallInstance(nav: NavData, region: number, uid: number): number {
  const id = (((region & 0xffff) << 16) | (uid & 0xffff)) >>> 0
  const i = nav.instances.findIndex(inst => inst.id >>> 0 === id)
  if (i < 0) throw new Error(`siege plan: no nav instance 0x${id.toString(16)} for the wall placement`)
  return i
}

/** World XZ box (glTF m) of a nav instance's collision mesh. */
export function instanceBox(nav: NavData, index: number, origin: { x: number; z: number }): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const inst = nav.instances[index]!
  const m = nav.models[inst.model]!
  const c = Math.cos(inst.yaw), s = Math.sin(inst.yaw)
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let k = 0; k < m.vertices.length; k += 3) {
    const lx = m.vertices[k]!, lz = m.vertices[k + 2]!
    const fx = inst.x + c * lx - s * lz
    const fz = inst.z + s * lx + c * lz
    const x = (fx - 1920 * origin.x) / 10
    const z = -(fz - 1920 * origin.z) / 10
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
  }
  return { minX, maxX, minZ, maxZ }
}

const AX = { N: 'x', S: 'x', W: 'z', E: 'z' } as const
const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * The texture repeat along the axis and its phase (where TEXCOORD_0 crosses an integer), from the wall01 mesh's
 * long edges: the most common (position mod repeat) in 0.25 m bins.
 */
export function textureRepeat(mesh: { positions: Float32Array; uvs: Float32Array | null; indices: Uint32Array | Uint16Array | null }, axis: 'x' | 'z', offset: number): { repeatM: number; phase: number } | null {
  const { positions: p, uvs, indices } = mesh
  if (!uvs || !indices) return null
  const a = axis === 'x' ? 0 : 2
  const ratios: number[] = []
  const lines: number[] = []
  for (let t = 0; t + 2 < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const i = indices[t + k]!, j = indices[t + ((k + 1) % 3)]!
      const d = p[j * 3 + a]! - p[i * 3 + a]!
      const len = Math.hypot(p[j * 3]! - p[i * 3]!, p[j * 3 + 1]! - p[i * 3 + 1]!, p[j * 3 + 2]! - p[i * 3 + 2]!)
      if (Math.abs(d) < 2 || Math.abs(d) < 0.95 * len) continue
      // the UV coordinate that runs along the edge
      const du0 = uvs[j * 2]! - uvs[i * 2]!, du1 = uvs[j * 2 + 1]! - uvs[i * 2 + 1]!
      const c = Math.abs(du0) >= Math.abs(du1) ? 0 : 1
      const ua = uvs[i * 2 + c]!, ub = uvs[j * 2 + c]!
      if (Math.abs(ub - ua) < 1e-4) continue
      ratios.push(Math.abs(d / (ub - ua)))
      const lo = Math.min(ua, ub), hi = Math.max(ua, ub)
      for (let n = Math.ceil(lo); n <= Math.floor(hi); n++) lines.push(offset + p[i * 3 + a]! + ((n - ua) / (ub - ua)) * d)
    }
  }
  if (!ratios.length || !lines.length) return null
  ratios.sort((x, y) => x - y)
  const repeatM = ratios[ratios.length >> 1]!
  const bins = new Map<number, number>()
  for (const l of lines) {
    const b = Math.round((((l % repeatM) + repeatM) % repeatM) * 4)
    bins.set(b, (bins.get(b) ?? 0) + 1)
  }
  let best = 0, bestN = -1
  for (const [b, n] of [...bins].sort((x, y) => x[0] - y[0])) if (n > bestN) { best = b; bestN = n }
  return { repeatM: r2(repeatM), phase: r2(best / 4) }
}

/** Equal split of [a, b] into n, inner ends snapped to the nearest half-repeat line (kept ordered and ≥ 60 % long). */
export function splitPart(a: number, b: number, n: number, repeat: { repeatM: number; phase: number } | null): number[] {
  const ends = [a]
  const len = (b - a) / n
  for (let k = 1; k < n; k++) {
    let e = a + len * k
    if (repeat && repeat.repeatM > 0) {
      const grid = repeat.repeatM / 2
      const snapped = repeat.phase + Math.round((e - repeat.phase) / grid) * grid
      if (snapped - ends[ends.length - 1]! >= 0.6 * len && b - snapped >= 0.6 * len * (n - k)) e = snapped
    }
    ends.push(r2(e))
  }
  ends.push(b)
  return ends
}

/** Plans the 33 segments of Jangan's walls from the export (see the header). */
export function planWalls(input: PlanInput): SiegePlan {
  const sides: PlanSide[] = []
  const texture: Record<WallSide, { repeatM: number; phase: number } | null> = { N: null, S: null, W: null, E: null }
  // Each side's placement and collision box first (the corners need the crossing walls' bodies).
  const info = new Map<WallSide, { source: string; pos: readonly number[]; box: ReturnType<typeof instanceBox> }>()
  for (const side of ['N', 'S', 'W', 'E'] as const) {
    const p = input.placements.find(q => WALL_SOURCES[side].test(q.source))
    if (!p) throw new Error(`siege plan: no ${side} wall placement in the manifest`)
    const inst = wallInstance(input.nav, p.region, p.uid)
    info.set(side, { source: p.source, pos: p.position, box: instanceBox(input.nav, inst, input.originRegion) })
  }
  for (const side of ['N', 'S', 'W', 'E'] as const) {
    const me = info.get(side)!
    const axis = AX[side]
    // a box's extent along this side's axis (for a crossing wall: its body's thickness)
    const span = (b: ReturnType<typeof instanceBox>) => (axis === 'x' ? [b.minX, b.maxX] : [b.minZ, b.maxZ]) as [number, number]
    let [lo, hi] = span(me.box)
    const crossing = (axis === 'x' ? (['W', 'E'] as const) : (['N', 'S'] as const)).map(s => span(info.get(s)!.box))
    for (const [a, b] of crossing) {
      const mid = (a + b) / 2
      if (mid < (lo + hi) / 2) lo = Math.max(lo, b + CORNER_MARGIN_M)
      else hi = Math.min(hi, a - CORNER_MARGIN_M)
    }
    const meshes = input.meshes(side)
    const off = axis === 'x' ? me.pos[0]! : me.pos[2]!
    let gate: [number, number] | null = null
    if (side !== 'N') {
      let g0 = Infinity, g1 = -Infinity
      for (const m of meshes) {
        if (!GATE_NODES.test(m.name)) continue
        const a = axis === 'x' ? 0 : 2
        for (let k = a; k < m.positions.length; k += 3) {
          g0 = Math.min(g0, off + m.positions[k]!)
          g1 = Math.max(g1, off + m.positions[k]!)
        }
      }
      if (!(g1 > g0)) throw new Error(`siege plan: no gatehouse meshes on the ${side} wall`)
      gate = [r2(g0 - GATE_MARGIN_M), r2(g1 + GATE_MARGIN_M)]
    }
    const wall01 = meshes.find(m => /_wall01$/i.test(m.name))
    const rep = wall01 ? textureRepeat(wall01, axis, off) : null
    texture[side] = rep
    const counts = SEGMENT_COUNTS[side]
    const parts: [number, number][] = gate ? [[lo, gate[0]], [gate[1], hi]] : [[lo, hi]]
    if (parts.length !== counts.length) throw new Error(`siege plan: ${side} has ${parts.length} parts, expected ${counts.length}`)
    const segments: PlanSegment[] = []
    parts.forEach(([a, b], i) => {
      if (!(b > a)) throw new Error(`siege plan: ${side} part ${i} is empty (${a}..${b})`)
      const ends = splitPart(r2(a), r2(b), counts[i]!, rep)
      for (let k = 0; k + 1 < ends.length; k++) segments.push({ id: `${side}${segments.length + 1}`, from: ends[k]!, to: ends[k + 1]! })
    })
    sides.push({ side, source: me.source, axis, run: [r2(lo), r2(hi)], gate, segments })
  }
  return {
    version: SIEGE_PLAN_VERSION,
    world: input.world,
    about: 'Siege of Jangan (docs/SIEGE.md §2.1): the 33 destructible wall segments, glTF metres along each wall (N/S: x, W/E: z). Written by `pnpm sro siege-walls plan`; the cut (Blender), the nav split, the server and the client read it. Segments split into equal thirds a, b, c.',
    texture,
    settings: { walls: {} },
    sides,
  }
}

/** Problems of a plan read back from content/ (empty: usable). */
export function checkPlan(v: unknown): string[] {
  const p = v as Partial<SiegePlan> | null
  const out: string[] = []
  if (!p || typeof p !== 'object') return ['plan must be an object']
  if (p.version !== SIEGE_PLAN_VERSION) out.push(`plan version must be ${SIEGE_PLAN_VERSION}`)
  if (!Array.isArray(p.sides)) return [...out, 'plan sides must be a list']
  const ids = new Set<string>()
  for (const s of p.sides) {
    if (!s || !['N', 'S', 'W', 'E'].includes(s.side)) {
      out.push('bad side')
      continue
    }
    let last = -Infinity
    for (const g of s.segments ?? []) {
      if (ids.has(g.id)) out.push(`segment ${g.id} twice`)
      ids.add(g.id)
      if (!(g.from < g.to) || g.from < last - 1e-6) out.push(`segment ${g.id}: ends out of order`)
      if (s.gate && g.to > s.gate[0] + 1e-6 && g.from < s.gate[1] - 1e-6) out.push(`segment ${g.id} overlaps the gate`)
      last = g.to
    }
  }
  if (ids.size !== 33) out.push(`expected 33 segments, got ${ids.size}`)
  return out
}

/** A plan's segments with their thirds (equal thirds). */
export function planThirds(seg: PlanSegment): [number, number][] {
  const l = (seg.to - seg.from) / 3
  return [[seg.from, r2(seg.from + l)], [r2(seg.from + l), r2(seg.from + 2 * l)], [r2(seg.from + 2 * l), seg.to]]
}
