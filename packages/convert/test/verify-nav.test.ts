/**
 * Adversarial verification of the Jangan navigation (docs/NAVIGATION.md, @sro/nav, work/out/world/jangan nav.bin +
 * manifest.spawn) against ground truth that does not come from the navmesh itself:
 *
 * - the RENDERED world: every converted glb placed with its manifest transform (what the viewer draws) plus the
 *   rendered terrain (TerrainBin heights), ray-cast vertically;
 * - the RAW client files: .nvm tile maps / object lists and the collision .bms navmeshes, parsed here again and
 *   transformed with our own code (not the NavData the walker uses);
 * - the original server tables: npcpos.txt (NPC positions) and teleportdata.txt (gates, return points);
 * - optionally a second, independent implementation: the third-party browser port's Jangan data (read-only, own
 *   reader; skipped when the folder is absent; set SRO_THIRD_PARTY_PORT to relocate it).
 *
 * Checks (numbered as in the verification task): 1 nav surfaces vs visible geometry; 2 the fountain; 3 height
 * continuity and "sunk" states on dense walks; 4 blocking fidelity and open walkways; 5 the spawn; 6 the port.
 * Coordinates in names and logs are glTF metres of the world frame (origin = SW corner of region 168x97).
 * Skipped without sro.config.json or without the converted world.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseBms, parseBsr, parseCpd, parseNvm, parseObjectIfo, parseTextdata, type BmsNavMesh } from '@sro/formats'
import { decodeNavData, NavGltf, NavWorld, type NavData, type NavLeg, type NavMoveResult, type NavPosition, type NavSurface } from '@sro/nav'
import { toGltfPosition } from '../src/gltf/space.ts'
import { openArchive, REPO_ROOT } from '../src/node-io.ts'
import { decodeTerrainBin, terrainHeightAt, type TerrainBin } from '../src/world/format.ts'
import type { WorldManifest } from '../src/world/manifest.ts'
import { composeTR, transformPoint } from '../src/world/verify.ts'

const OUT = join(REPO_ROOT, 'work', 'out', 'world', 'jangan')
const hasOutput = existsSync(join(OUT, 'manifest.json')) && existsSync(join(OUT, 'nav.bin'))
const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const PORT = process.env.SRO_THIRD_PARTY_PORT ??
  '' // set SRO_THIRD_PARTY_PORT to a third-party port's zones/jangan_province folder (skipped without it)
const hasPort = existsSync(join(PORT, 'nav.bin')) && existsSync(join(PORT, 'heights.bin'))
const REGION = 1920
/** The lead's test point next to the fountain, and the fountain centre (region-local (979, 856)). */
const PLAZA: [number, number] = [100.84, -71.5]
const FOUNTAIN: [number, number] = [97.9, -85.6]
const PLAZA_MESH = 'cj_jang_gate06.bms'
/** The plaza paving height (m). */
const PLAZA_Y = -3.261
/** In-radius of the fountain's blocked octagon (vertex radius ~10 m): 10 cos(22.5 deg). */
const RIM_R = 9.2

// --- rendered world ---------------------------------------------------------------------------------------------

/** Every rendered object triangle (glb x manifest placement) in a 4 m XZ grid, plus the rendered terrain. */
class RenderedWorld {
  readonly xyz: number[] = []
  readonly owner: number[] = []
  readonly node: string[] = []
  private readonly grid = new Map<number, number[]>()
  terrain: { ox: number; oz: number; t: TerrainBin }[] = []

  add(a: number[], b: number[], c: number[], owner: number, node: string): void {
    const i = this.owner.length
    this.xyz.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, c[0]!, c[1]!, c[2]!)
    this.owner.push(owner)
    this.node.push(node)
    for (let gz = Math.floor(Math.min(a[2]!, b[2]!, c[2]!) / 4); gz <= Math.floor(Math.max(a[2]!, b[2]!, c[2]!) / 4); gz++) {
      for (let gx = Math.floor(Math.min(a[0]!, b[0]!, c[0]!) / 4); gx <= Math.floor(Math.max(a[0]!, b[0]!, c[0]!) / 4); gx++) {
        const k = gx * 100000 + gz
        let l = this.grid.get(k)
        if (!l) this.grid.set(k, (l = []))
        l.push(i)
      }
    }
  }

  /** Rendered terrain height (m) at glTF (x, z), NaN outside. */
  terrainY(x: number, z: number): number {
    for (const { ox, oz, t } of this.terrain) {
      if (x >= ox && x <= ox + 192 && z <= oz && z >= oz - 192) return terrainHeightAt(t.heights, (x - ox) * 10, (oz - z) * 10)
    }
    return NaN
  }

  /** Every rendered object surface crossing the vertical line at glTF (x, z). */
  hits(x: number, z: number): { y: number; owner: number; node: string }[] {
    const out: { y: number; owner: number; node: string }[] = []
    const X = this.xyz
    for (const i of this.grid.get(Math.floor(x / 4) * 100000 + Math.floor(z / 4)) ?? []) {
      const o = i * 9
      const ax = X[o]!, az = X[o + 2]!, bx = X[o + 3]!, bz = X[o + 5]!, cx = X[o + 6]!, cz = X[o + 8]!
      const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az)
      if (Math.abs(det) < 1e-12) continue
      const u = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / det
      const v = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / det
      if (u < -1e-7 || v < -1e-7 || u + v > 1 + 1e-7) continue
      out.push({ y: X[o + 1]! + u * (X[o + 4]! - X[o + 1]!) + v * (X[o + 7]! - X[o + 1]!), owner: this.owner[i]!, node: this.node[i]! })
    }
    return out
  }

  /** Distance (m) from y to the nearest rendered surface (objects or terrain) at (x, z). */
  gap(x: number, z: number, y: number): number {
    let d = Math.abs(this.terrainY(x, z) - y)
    for (const h of this.hits(x, z)) d = Math.min(d, Math.abs(h.y - y))
    return Number.isNaN(d) ? Infinity : d
  }
}

async function loadRendered(m: WorldManifest): Promise<RenderedWorld> {
  const r = new RenderedWorld()
  r.terrain = m.regions.map(reg => ({ ox: reg.origin[0], oz: reg.origin[2], t: decodeTerrainBin(readFileSync(join(OUT, reg.terrain.file))) }))
  const io = new NodeIO()
  const glbs = new Map<string, { node: string; pos: number[][]; idx: ArrayLike<number> }[]>()
  for (let pi = 0; pi < m.placements.length; pi++) {
    const pl = m.placements[pi]!
    const M = composeTR(pl.position, pl.rotation)
    for (const mi of pl.models) {
      const file = m.models[mi]!.glb
      if (!file) continue
      let prims = glbs.get(file)
      if (!prims) {
        prims = []
        const doc = await io.readBinary(readFileSync(join(OUT, file)))
        for (const node of doc.getRoot().listNodes()) {
          const mesh = node.getMesh()
          if (!mesh) continue
          const nm = node.getSkin() ? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] : node.getWorldMatrix()
          for (const prim of mesh.listPrimitives()) {
            const p = prim.getAttribute('POSITION')?.getArray()
            if (prim.getMode() !== 4 || !p) continue
            const pos: number[][] = []
            for (let i = 0; i < p.length; i += 3) pos.push(transformPoint(nm, p[i]!, p[i + 1]!, p[i + 2]!))
            prims.push({ node: node.getName(), pos, idx: prim.getIndices()?.getArray() ?? Uint32Array.from({ length: pos.length }, (_, i) => i) })
          }
        }
        glbs.set(file, prims)
      }
      for (const pr of prims) {
        const P = pr.pos.map(v => transformPoint(M, v[0]!, v[1]!, v[2]!))
        for (let t = 0; t < pr.idx.length; t += 3) r.add(P[pr.idx[t]!]!, P[pr.idx[t + 1]!]!, P[pr.idx[t + 2]!]!, pi, pr.node)
      }
    }
  }
  return r
}

// --- helpers ------------------------------------------------------------------------------------------------------

/** Cells of each instance that a walker can reach from outside (enterable outline edges, links, passable inlines). */
function reachableCells(data: NavData): Set<number>[] {
  const linked = data.instances.map(i => new Set(i.links.map(l => l.edge)))
  for (const i of data.instances) for (const l of i.links) linked[l.target]?.add(l.targetEdge)
  return data.instances.map((inst, ii) => {
    const md = data.models[inst.model]!
    const seen = new Set<number>()
    const stack: number[] = []
    const o = md.outline
    for (let e = 0; e < o.flags.length; e++) {
      const f = o.flags[e]!
      if (!(f & 1) && !(f & 16) && (!(f & 8) || linked[ii]!.has(e)) && !seen.has(o.cells[e * 2]!)) {
        seen.add(o.cells[e * 2]!)
        stack.push(o.cells[e * 2]!)
      }
    }
    const adj = new Map<number, number[]>()
    const push = (a: number, b: number) => { let l = adj.get(a); if (!l) adj.set(a, (l = [])); l.push(b) }
    for (let e = 0; e < md.inline.flags.length; e++) {
      const a = md.inline.cells[e * 2]!, b = md.inline.cells[e * 2 + 1]!, f = md.inline.flags[e]!
      if (!(f & 2)) push(a, b)
      if (!(f & 1)) push(b, a)
    }
    while (stack.length) for (const n of adj.get(stack.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n) }
    return seen
  })
}

/** Surface height every `step` m along the legs, with the leg's surface. */
function legSamples(g: NavGltf, legs: NavLeg[], step = 0.1): { x: number; z: number; y: number; surface: NavSurface }[] {
  const out: { x: number; z: number; y: number; surface: NavSurface }[] = []
  for (const l of legs) {
    const n = Math.max(1, Math.ceil(Math.hypot(l.x1 - l.x0, l.z1 - l.z0) / step))
    for (let i = 0; i <= n; i++) {
      const x = l.x0 + ((l.x1 - l.x0) * i) / n, z = l.z0 + ((l.z1 - l.z0) * i) / n
      out.push({ x, z, y: g.heightOn(l.surface, x, z), surface: l.surface })
    }
  }
  return out
}

const quantile = (a: number[], q: number) => {
  const s = Float64Array.from(a).sort()
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]! : NaN
}

function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// --- the checks ---------------------------------------------------------------------------------------------------

describe.skipIf(!hasOutput || !hasConfig)('navigation verification against independent ground truth (Jangan)', () => {
  let m: WorldManifest
  let data: NavData
  let w: NavWorld
  let g: NavGltf
  let rendered: RenderedWorld
  let reach: Set<number>[]
  /** Placement index -> nav instance index (same (region, uid)). */
  const instOfPlacement = new Map<number, number>()
  const modelOf = (s: NavSurface) => (s.kind === 'object' ? data.models[data.instances[s.instance]!.model]!.key.split('/').pop()! : 'terrain')
  const placementName = (pi: number) => m.placements[pi]!.source.split(/[\\/]/).pop()!
  const bounds = { x0: 0, x1: 0, z0: 0, z1: 0 }
  /** Flood fill from the spawn: every 2 m grid point reachable by straight moves, per surface (glTF positions). */
  let walked: NavPosition[] = []
  let walkedMoves = 0

  /** Positions a player can reach by walking from the spawn (8-neighbour straight moves on a 2 m grid). */
  function floodFill(): NavPosition[] {
    const STEP = 2
    const key = (p: NavPosition) => `${Math.round(p.x / STEP)},${Math.round(p.z / STEP)},${p.surface.kind === 'object' ? p.surface.instance : -1}`
    const start = g.locate(m.spawn!.x, m.spawn!.z, m.spawn!.y)!
    const seen = new Map<string, NavPosition>([[key(start), start]])
    const queue = [start]
    while (queue.length) {
      const p = queue.pop()!
      const gx = Math.round(p.x / STEP), gz = Math.round(p.z / STEP)
      for (const [dx, dz] of [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const) {
        const tx = (gx + dx) * STEP, tz = (gz + dz) * STEP
        if (tx < bounds.x0 + 0.5 || tx > bounds.x1 - 0.5 || tz < bounds.z0 + 0.5 || tz > bounds.z1 - 0.5) continue
        const r = g.moveStraight(p, tx, tz)
        walkedMoves++
        if (r.blocked) continue
        const k = key(r.end)
        if (!seen.has(k)) {
          seen.set(k, r.end)
          queue.push(r.end)
        }
      }
    }
    return [...seen.values()]
  }

  /** The flood-fill position nearest to glTF (x, z) within 1.5 m (the 2 m grid), or null. */
  function nearestWalked(x: number, z: number): NavPosition | null {
    let best: NavPosition | null = null
    let bd = 1.5
    for (const p of walked) {
      const d = Math.hypot(p.x - x, p.z - z)
      if (d < bd) {
        bd = d
        best = p
      }
    }
    return best
  }

  beforeAll(async () => {
    m = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as WorldManifest
    data = decodeNavData(new Uint8Array(readFileSync(join(OUT, m.nav!.file))))
    w = new NavWorld(data)
    g = new NavGltf(w, m.space.originRegion)
    const t0 = performance.now()
    rendered = await loadRendered(m)
    reach = reachableCells(data)
    const byId = new Map(data.instances.map((d, i) => [d.id, i]))
    m.placements.forEach((pl, pi) => {
      const i = byId.get(pl.region * 0x10000 + pl.uid)
      if (i !== undefined) instOfPlacement.set(pi, i)
    })
    bounds.x0 = Math.min(...m.regions.map(r => r.origin[0]))
    bounds.x1 = bounds.x0 + 3 * 192
    bounds.z1 = Math.max(...m.regions.map(r => r.origin[2]))
    bounds.z0 = bounds.z1 - 3 * 192
    const t1 = performance.now()
    walked = floodFill()
    console.log(`verify-nav: rendered world ${rendered.owner.length} triangles from ${m.placements.length} placements in ${(t1 - t0).toFixed(0)} ms; ` +
      `flood fill from the spawn: ${walked.length} positions, ${walkedMoves} moves in ${(performance.now() - t1).toFixed(0)} ms`)
  }, 60_000)

  it('1a: object nav surfaces lie on the rendered geometry (reachable cells, per model class)', () => {
    // Centroid of every reachable nav triangle, and an area-weighted 0.5 m sample grid over them: distance to the
    // nearest rendered surface (the object's own glb, any other glb, the rendered terrain). Sealed collision
    // footprints (no enterable edge) are nobody's floor and are only counted.
    type Row = { cls: string; model: string; own: number; any: number; x: number; z: number; y: number }
    const centroid: Row[] = []
    const area: { cls: string; any: number }[] = []
    let sealed = 0
    for (let i = 0; i < data.instances.length; i++) {
      const inst = data.instances[i]!
      const md = data.models[inst.model]!
      const pi = [...instOfPlacement].find(([, v]) => v === i)?.[0]
      expect(pi).toBeDefined()
      const cls = m.models[m.placements[pi!]!.models[0]!]!.source.split(/[\\/]/)[1]!
      const c = Math.cos(inst.yaw), s = Math.sin(inst.yaw)
      const V = md.vertices
      const world = (v: number) => [g.gltfX(inst.x + c * V[v * 3]! - s * V[v * 3 + 2]!), g.gltfZ(inst.z + s * V[v * 3]! + c * V[v * 3 + 2]!)] as const
      for (let k = 0; k < md.cells.length / 3; k++) {
        if (!reach[i]!.has(k)) { sealed++; continue }
        const P = [0, 1, 2].map(j => world(md.cells[k * 3 + j]!))
        const surf: NavSurface = { kind: 'object', instance: i, cell: k }
        const x = (P[0]![0] + P[1]![0] + P[2]![0]) / 3, z = (P[0]![1] + P[1]![1] + P[2]![1]) / 3
        const y = g.heightOn(surf, x, z)
        const hs = rendered.hits(x, z)
        const own = hs.filter(h => h.owner === pi).reduce((d, h) => Math.min(d, Math.abs(h.y - y)), Infinity)
        centroid.push({ cls, model: md.key.split('/').pop()!, own, any: rendered.gap(x, z, y), x, z, y })
        // Area samples: barycentric lattice with ~0.5 m spacing.
        const L = Math.max(...[0, 1, 2].map(j => Math.hypot(P[j]![0] - P[(j + 1) % 3]![0], P[j]![1] - P[(j + 1) % 3]![1])))
        const n = Math.max(1, Math.ceil(L / 0.5))
        for (let a = 0; a < n; a++) {
          for (let b = 0; a + b < n; b++) {
            const u = (a + 1 / 3) / n, v = (b + 1 / 3) / n
            const sx = P[0]![0] + (P[1]![0] - P[0]![0]) * u + (P[2]![0] - P[0]![0]) * v
            const sz = P[0]![1] + (P[1]![1] - P[0]![1]) * u + (P[2]![1] - P[0]![1]) * v
            area.push({ cls, any: rendered.gap(sx, sz, g.heightOn(surf, sx, sz)) })
          }
        }
      }
    }
    const frac = (a: number[], t: number) => a.filter(d => d <= t).length / a.length
    const table: string[] = []
    for (const cls of ['bldg', 'artifact', 'nature']) {
      const c = centroid.filter(r => r.cls === cls)
      const ar = area.filter(r => r.cls === cls).map(r => r.any)
      if (!c.length) continue
      table.push(`${cls}: ${c.length} cells | centroid <=0.15 m: own glb ${frac(c.map(r => r.own), 0.15).toFixed(3)}, any rendered ${frac(c.map(r => r.any), 0.15).toFixed(3)}` +
        ` (p50 ${quantile(c.map(r => r.any), 0.5).toFixed(3)}, p90 ${quantile(c.map(r => r.any), 0.9).toFixed(3)}) | area <=0.15 m ${frac(ar, 0.15).toFixed(3)}, <=0.6 m ${frac(ar, 0.6).toFixed(3)}`)
    }
    const outliers = new Map<string, { n: number; of: number; max: number; eg: string }>()
    for (const r of centroid) {
      const o = outliers.get(r.model) ?? { n: 0, of: 0, max: 0, eg: '' }
      o.of++
      if (r.any > 0.15) {
        o.n++
        if (r.any > o.max) { o.max = r.any; o.eg = `(${r.x.toFixed(1)}, ${r.z.toFixed(1)}) nav ${r.y.toFixed(2)}` }
      }
      outliers.set(r.model, o)
    }
    const worst = [...outliers].filter(([, o]) => o.n).sort((a, b) => b[1].max - a[1].max).slice(0, 12)
    console.log(`check 1 (nav vs rendered): ${centroid.length} reachable cells, ${sealed} sealed/island cells skipped\n  ${table.join('\n  ')}\n` +
      `  outlier models (centroid > 0.15 m from anything rendered): ${worst.map(([k, o]) => `${k} ${o.n}/${o.of} max ${o.max.toFixed(2)} m at ${o.eg}`).join('; ')}`)
    const all = centroid.map(r => r.any)
    const allArea = area.map(r => r.any)
    expect(frac(all, 0.15)).toBeGreaterThan(0.85)
    expect(frac(allArea, 0.15)).toBeGreaterThan(0.85)
    // Beyond one stair riser (0.6 m: nav ramps run over rendered steps) the navmesh floats or sinks only in these
    // authored places (same data in the original client), each checked by hand against the raw client meshes:
    // - cj_jang_gate06 (the plaza): stair ramps vs rendered steps (up to one riser), and at the arms' sides the nav
    //   ramps are wider than the rendered staircases (up to 1.3 m above the rendered landing, e.g. x 53.3-55,
    //   z -73.5), so a walker climbing the very edge of a stair floats there;
    // - cj_resta03_floor: the restaurant's east porch (x -77..-74): nav 0.72-0.93 m, only the terrain rendered;
    // - cj_pal_indoor_floor01, cj_mili_mainste01, tre_gagi01: slivers 0.1-0.5 m wide where the nav outline runs past
    //   the rendered edge (palace hall end walls, the military stair platform rims, a fallen-branch prop).
    expect(frac(allArea, 0.6)).toBeGreaterThan(0.95)
    for (const [model, o] of outliers) {
      if (o.max > 0.6) expect(['cj_resta03_floor.bms', 'cj_jang_gate06.bms', 'cj_pal_indoor_floor01.bms', 'cj_mili_mainste01.bms', 'tre_gagi01.bms']).toContain(model)
    }
  })

  it('1b: the rendered plaza floor under (100.84, -71.5) is at the nav height, 1.5 m above the (hidden) terrain', () => {
    const p = g.locate(...PLAZA, Infinity)!
    expect(modelOf(p.surface)).toBe(PLAZA_MESH)
    const hs = rendered.hits(...PLAZA)
    const gate = hs.filter(h => placementName(h.owner) === 'cj_jang_gate.bsr')
    const nearest = gate.reduce((b, h) => (Math.abs(h.y - p.y) < Math.abs(b - p.y) ? h.y : b), Infinity)
    console.log(`check 1b: nav ${p.y.toFixed(3)} m; rendered gate surfaces ${gate.map(h => `${h.node} ${h.y.toFixed(3)}`).join(', ')}; rendered terrain ${rendered.terrainY(...PLAZA).toFixed(3)}`)
    expect(Math.abs(nearest - p.y)).toBeLessThan(0.02)
    expect(p.y).toBeCloseTo(-3.261, 2)
    // Nothing is rendered between the paving and 2 m above it, and the terrain the old walker used is 1.5 m below.
    expect(hs.filter(h => h.y > p.y + 0.05 && h.y < p.y + 2)).toEqual([])
    expect(p.y - rendered.terrainY(...PLAZA)).toBeGreaterThan(1.4)
  })

  it('2: the fountain: moves toward its centre from 16 directions stop at the rim, never in the basin, never below the plaza', () => {
    const rows: string[] = []
    const ends = new Map<string, number>()
    let moves = 0
    for (const radius of [15, 25, 40, 60]) {
      let blocked = 0, minR = Infinity, minY = Infinity
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * 2 * Math.PI
        const sx = FOUNTAIN[0] + radius * Math.cos(a), sz = FOUNTAIN[1] + radius * Math.sin(a)
        // Start where a walker coming from the spawn stands: the nearest flood-fill position (never the terrain
        // hidden under the plaza or its stair landings, which only a teleport with a wrong y hint can reach).
        const start = nearestWalked(sx, sz)
        if (!start) continue
        const r = g.moveStraight(start, ...FOUNTAIN)
        moves++
        if (r.blocked) blocked++
        expect(r.blocked).toBe(true)
        expect(r.hit).toMatchObject({ kind: 'edge', flag: 3 })
        // On the plaza the stop is the rim (the plaza's own flag-3 octagon); from the streets some chords already stop
        // at a stair side (flag 3) before reaching it.
        if (radius <= 25) expect(modelOf(r.end.surface)).toBe(PLAZA_MESH)
        ends.set(modelOf(r.end.surface), (ends.get(modelOf(r.end.surface)) ?? 0) + 1)
        for (const p of legSamples(g, r.legs)) {
          const d = Math.hypot(p.x - FOUNTAIN[0], p.z - FOUNTAIN[1])
          minR = Math.min(minR, d)
          expect(d).toBeGreaterThan(RIM_R)
          // Within the plaza (30 m), never below its paving (-3.26; the terrain it meets at the diagonals is -3.32).
          if (d < 30) {
            minY = Math.min(minY, p.y)
            expect(p.y).toBeGreaterThan(-3.35)
          }
        }
        // The rendered pool (~ -4.3 m) and the terrain under the basin (-5.4 m) are never the ground under the walker.
        expect(r.end.y).toBeGreaterThan(-3.35)
      }
      rows.push(`r ${radius} m: ${blocked}/16 blocked at the rim, closest approach ${minR.toFixed(2)} m, lowest y within 30 m ${minY.toFixed(3)}`)
    }
    // The user's complaint path: spawn -> the lead's test point (the fountain lies between): stops at the rim.
    const sp = g.locate(m.spawn!.x, m.spawn!.z, m.spawn!.y)!
    const direct = g.moveStraight(sp, ...PLAZA)
    expect(direct.blocked).toBe(true)
    expect(Math.hypot(direct.end.x - FOUNTAIN[0], direct.end.z - FOUNTAIN[1])).toBeGreaterThan(RIM_R)
    // Hazard of the native rule, pinned down: the surface is re-guessed from y only on spawn/teleport, and here the
    // terrain hidden under the paving is only 6 cm lower (-3.32 vs -3.26), so a y hint of -3.30 (e.g. a rounded
    // stored height) picks the terrain, and that walker goes straight into the basin: the reported bug. Positions
    // must keep their surface (NAVIGATION.md §5.1); spawn with the stored surface height or +Infinity.
    const low = g.locate(92.2, -71.7, -3.3)!
    expect(low.surface.kind).toBe('terrain')
    expect(g.moveStraight(low, ...FOUNTAIN).blocked).toBe(false)
    expect(modelOf(g.locate(92.2, -71.7, PLAZA_Y)!.surface)).toBe(PLAZA_MESH)
    console.log(`check 2 (fountain, ${moves} moves; end surfaces ${[...ends].map(([k, v]) => `${k} ${v}`).join(', ')}):\n  ${rows.join('\n  ')}\n  hazard: locate(92.2, -71.7, y -3.30) = terrain; that walker enters the basin`)
  })

  it('3: dense straight walks: height steps only at authored open edges with rendered ledges; no sunk end states', () => {
    // Starts: one position per 16 m cell and surface kind among those REACHED BY WALKING from the spawn (the flood
    // fill), x 8 directions x 40 m. Per 0.1 m step the height change; every step > 0.5 m must be a surface change
    // (terrain <-> object across an open outline edge: there is no step limit, NAVIGATION.md §5.4) where the RENDERED
    // world has a surface at both heights (0.15 m before and after): a real ledge, not an invisible one.
    const steps: number[] = []
    const jumps: { dy: number; x: number; z: number; from: string; to: string; before: number; after: number; ok: boolean }[] = []
    const ends: NavPosition[] = []
    let moves = 0
    const starts = new Map<string, NavPosition>()
    for (const p of walked) {
      const k = `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)},${p.surface.kind}`
      if (!starts.has(k)) starts.set(k, p)
    }
    for (const p of starts.values()) {
      const { x, z } = p
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * 2 * Math.PI
        const r: NavMoveResult = g.moveStraight(p, x + 40 * Math.cos(a), z + 40 * Math.sin(a))
        moves++
        expect(Number.isFinite(r.end.y)).toBe(true)
        ends.push(r.end)
        const s = legSamples(g, r.legs)
        for (let i = 1; i < s.length; i++) {
          const dy = Math.abs(s[i]!.y - s[i - 1]!.y)
          steps.push(dy)
          if (dy <= 0.5) continue
          const a0 = s[i - 1]!, a1 = s[i]!
          const dx = a1.x - a0.x, dz = a1.z - a0.z, L = Math.hypot(dx, dz) || 1
          // Nearest rendered surface to each level, 0.15..0.5 m back / ahead (render and nav edges differ by ~0.2 m).
          const at = (p: { x: number; z: number; y: number }, sgn: number) =>
            Math.min(...[0.15, 0.3, 0.5].map(o => rendered.gap(p.x + sgn * (dx / L) * o, p.z + sgn * (dz / L) * o, p.y)))
          const before = at(a0, -1), after = at(a1, 1)
          // A real ledge: an object is involved (the terrain alone is continuous) and rendered geometry exists at both
          // levels, within one stair riser (0.65 m) where nav ramps run over rendered steps.
          const ok = (a0.surface.kind === 'object' || a1.surface.kind === 'object') && before < 0.65 && after < 0.65
          jumps.push({ dy, x: a1.x, z: a1.z, from: modelOf(a0.surface), to: modelOf(a1.surface), before, after, ok })
        }
      }
    }
    const byPair = new Map<string, { n: number; max: number; eg: string; bad: number }>()
    for (const j of jumps) {
      const k = `${j.from} -> ${j.to}`
      const e = byPair.get(k) ?? { n: 0, max: 0, eg: '', bad: 0 }
      e.n++
      if (!j.ok) e.bad++
      if (j.dy > e.max) { e.max = j.dy; e.eg = `(${j.x.toFixed(1)}, ${j.z.toFixed(1)})` }
      byPair.set(k, e)
    }

    // "Sunk" end states. (a) nav: a reachable object floor 0.25..2 m above the feet at the same x/z. (b) rendered:
    // geometry 0.25..1.8 m above the feet at the same x/z (inside a body), except objects the client gives no
    // collision (no navmesh: grass, bushes, some trees), foliage, contacts (a point walker stops 0.2 units from a
    // blocking edge, so wider-than-footprint render overhangs its feet within 0.5 m of an edge: every native
    // client shows the same) and stair steps of the walker's own object (nav ramps over rendered steps, one riser).
    const edgeNear = (x: number, z: number, r: number) => {
      const fx = g.fileX(x), fz = g.fileZ(z)
      for (const e of w.debugEdges(fx - r * 10, fz - r * 10, fx + r * 10, fz + r * 10)) {
        if (!(e.flag & 3)) continue
        const ex = e.bx - e.ax, ez = e.bz - e.az
        const u = Math.max(0, Math.min(1, ((fx - e.ax) * ex + (fz - e.az) * ez) / (ex * ex + ez * ez || 1)))
        if (Math.hypot(e.ax + ex * u - fx, e.az + ez * u - fz) < r * 10) return true
      }
      return false
    }
    let navSunk = 0, noCollision = 0, contact = 0, foliage = 0, stairs = 0
    const inside: string[] = []
    for (const e of ends) {
      const fx = g.fileX(e.x), fz = g.fileZ(e.z)
      for (let hy = e.y + 0.25; hy <= e.y + 2; hy += 0.25) {
        const q = w.locate(fx, fz, hy * 10)
        if (q && q.surface.kind === 'object' && reach[q.surface.instance]!.has(q.surface.cell) && q.y / 10 > e.y + 0.25 && q.y / 10 < e.y + 2 &&
          !(e.surface.kind === 'object' && e.surface.instance === q.surface.instance)) {
          navSunk++
          inside.push(`nav floor ${modelOf(q.surface)} +${(q.y / 10 - e.y).toFixed(2)} m over ${modelOf(e.surface)} at (${e.x.toFixed(1)}, ${e.z.toFixed(1)})`)
          break
        }
      }
      for (const h of rendered.hits(e.x, e.z)) {
        if (h.y <= e.y + 0.25 || h.y >= e.y + 1.8) continue
        const inst = instOfPlacement.get(h.owner)
        if (inst === undefined) { noCollision++; continue }
        if (/leaf|leav/i.test(h.node)) { foliage++; continue }
        if (e.surface.kind === 'object' && e.surface.instance === inst && h.y < e.y + 0.6) { stairs++; continue }
        if (edgeNear(e.x, e.z, 0.5)) { contact++; continue }
        inside.push(`${placementName(h.owner)}/${h.node} +${(h.y - e.y).toFixed(2)} m over ${modelOf(e.surface)} at (${e.x.toFixed(1)}, ${e.y.toFixed(2)}, ${e.z.toFixed(1)})`)
        break
      }
    }
    console.log(`check 3 (${moves} moves of 40 m, ${steps.length} steps of 0.1 m): |dy| p50 ${quantile(steps, 0.5).toFixed(3)}, p99 ${quantile(steps, 0.99).toFixed(3)}, ` +
      `p99.99 ${quantile(steps, 0.9999).toFixed(3)}, max ${quantile(steps, 1).toFixed(3)} m; steps > 0.5 m: ${jumps.length}\n  ` +
      [...byPair].map(([k, v]) => `${k}: ${v.n} (max ${v.max.toFixed(2)} m at ${v.eg}; not a rendered ledge: ${v.bad})`).join('\n  ') +
      `\n  end states: ${ends.length}; inside geometry: ${inside.length}; excluded: no-collision objects ${noCollision}, foliage ${foliage}, own stair steps ${stairs}, edge contacts ${contact}` +
      (inside.length ? `\n  ${inside.join('\n  ')}` : ''))
    expect(quantile(steps, 1)).toBeLessThan(2.8)
    for (const j of jumps.filter(j => !j.ok)) {
      console.log(`  unconfirmed step ${j.from} -> ${j.to} dy ${j.dy.toFixed(2)} m at (${j.x.toFixed(2)}, ${j.z.toFixed(2)}): rendered gap before ${j.before.toFixed(2)}, after ${j.after.toFixed(2)}`)
    }
    // The only steps without a rendered ledge within one riser are at the plaza's stair sides, where its nav ramps are
    // wider than the rendered staircases (see check 1a).
    expect(jumps.filter(j => !j.ok && ![j.from, j.to].includes(PLAZA_MESH))).toEqual([])
    expect(jumps.filter(j => !j.ok).length).toBeLessThan(20)
    expect(navSunk).toBe(0)
    expect(inside).toEqual([])
  })

  describe('4: blocking fidelity (raw client data) and open walkways', () => {
    interface RawInst {
      key: string
      nav: BmsNavMesh
      W: (v: number) => [number, number]
      Y: (v: number) => number
      links: { edge: number; target: string }[]
    }
    const raw = new Map<string, RawInst>()
    const closed = new Set<number>()
    const edgeGrid = new Map<number, { inst: RawInst; e: number }[]>()

    beforeAll(() => {
      // Independent of NavData: the .nvm tile maps and object records, the collision .bms navmeshes, our own yaw rule.
      const archive = openArchive('Data')
      const ifo = parseObjectIfo(archive.read('navmesh/object.ifo'))
      const navOf = new Map<number, BmsNavMesh | null>()
      const meshOf = (objId: number) => {
        if (!navOf.has(objId)) {
          let path = ifo.byIndex.get(objId)?.path ?? ''
          if (path.toLowerCase().endsWith('.cpd')) path = parseCpd(archive.read(path)).collisionPath
          const cp = path && archive.has(path) ? parseBsr(archive.read(path)).collision.meshPath : ''
          navOf.set(objId, cp && archive.has(cp) ? parseBms(archive.read(cp)).navMesh ?? null : null)
        }
        return navOf.get(objId)!
      }
      for (const reg of m.regions) {
        const nvm = parseNvm(archive.read(`navmesh/nv_${reg.id.toString(16).padStart(4, '0')}.nvm`))
        for (let t = 0; t < 96 * 96; t++) {
          const c = nvm.tileCells[t]!
          if (!(c >= 0 && c < nvm.openCellCount)) closed.add((reg.x * 96 + (t % 96)) * 100000 + reg.z * 96 + Math.floor(t / 96))
        }
        for (const o of nvm.objects) {
          const key = `${o.regionId}:${o.localUid}`
          const nav = meshOf(o.objId)
          if (raw.has(key) || !nav) continue
          const px = REGION * reg.x + o.position[0], pz = REGION * reg.z + o.position[2], py = o.position[1]
          const c = Math.cos(o.yaw), s = Math.sin(o.yaw), V = nav.vertices
          const inst: RawInst = {
            key, nav,
            W: v => [px + c * V[v * 3]! - s * V[v * 3 + 2]!, pz + s * V[v * 3]! + c * V[v * 3 + 2]!],
            Y: v => py + V[v * 3 + 1]!,
            links: o.links.filter(l => l.linkedObject >= 0).map(l => ({ edge: l.edge, target: `${nvm.objects[l.linkedObject]!.regionId}:${nvm.objects[l.linkedObject]!.localUid}` })),
          }
          raw.set(key, inst)
          const E = nav.outlineEdges
          for (let e = 0; e < E.flags.length; e++) {
            const [ax, az] = inst.W(E.vertices[e * 2]!), [bx, bz] = inst.W(E.vertices[e * 2 + 1]!)
            for (let gx = Math.floor(Math.min(ax, bx) / 50); gx <= Math.floor(Math.max(ax, bx) / 50); gx++) {
              for (let gz = Math.floor(Math.min(az, bz) / 50); gz <= Math.floor(Math.max(az, bz) / 50); gz++) {
                const k = gx * 100000 + gz
                let l = edgeGrid.get(k)
                if (!l) edgeGrid.set(k, (l = []))
                l.push({ inst, e })
              }
            }
          }
        }
      }
    }, 60_000)

    it('4a: 20,000 random moves never cross closed tiles or blocked outline edges, and follow the raw mesh topology', () => {
      expect(raw.size).toBe(data.instances.length)
      const instKey = data.instances.map(i => `${i.id >>> 16}:${i.id & 0xffff}`)
      const rawOf = (s: NavSurface & { kind: 'object' }) => raw.get(instKey[s.instance]!)!
      /** Largest outside distance of (x, z) from a raw cell triangle (file units; <= 0 inside). */
      const outside = (ri: RawInst, cell: number, x: number, z: number) => {
        const P = [0, 1, 2].map(k => ri.W(ri.nav.cells[cell * 3 + k]!))
        let worst = -Infinity
        for (let k = 0; k < 3; k++) {
          const a = P[k]!, b = P[(k + 1) % 3]!, o = P[(k + 2) % 3]!
          let nx = b[1] - a[1], nz = -(b[0] - a[0])
          const L = Math.hypot(nx, nz) || 1
          nx /= L
          nz /= L
          if (nx * (o[0] - a[0]) + nz * (o[1] - a[1]) > 0) { nx = -nx; nz = -nz }
          worst = Math.max(worst, nx * (x - a[0]) + nz * (z - a[1]))
        }
        return worst
      }
      const outlineNear = (ri: RawInst, cell: number, x: number, z: number, ok: (flag: number, e: number) => boolean) => {
        const E = ri.nav.outlineEdges
        for (let e = 0; e < E.flags.length; e++) {
          if (E.cells[e * 2] !== cell || !ok(E.flags[e]!, e)) continue
          const [ax, az] = ri.W(E.vertices[e * 2]!), [bx, bz] = ri.W(E.vertices[e * 2 + 1]!)
          const ex = bx - ax, ez = bz - az
          const u = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)))
          if (Math.hypot(ax + ex * u - x, az + ez * u - z) < 0.5) return true
        }
        return false
      }
      const rnd = prng(4242)
      const X0 = bounds.x0, Z0 = bounds.z0
      let pos: NavPosition | null = null
      let tileViolations = 0, terrainEdgeViolations = 0, objectLegs = 0, legOutsideCell = 0, badSteps = 0, moves = 0
      const bad: string[] = []
      const foreign = new Map<string, number>()
      for (let i = 0; i < 20000; i++) {
        if (!pos || i % 50 === 0) {
          for (;;) {
            const x = X0 + rnd() * 576, z = Z0 + rnd() * 576
            const p = g.locate(x, z, rnd() < 0.5 ? Infinity : w.terrainHeight(g.fileX(x), g.fileZ(z)) / 10)
            if (p && (p.surface.kind === 'object' ? reach[p.surface.instance]!.has(p.surface.cell) : w.terrainOpen(g.fileX(x), g.fileZ(z)))) { pos = g.toFile(p); break }
          }
        }
        const a = rnd() * 2 * Math.PI, d = rnd() * 500
        const r = w.moveStraight(pos, pos.x + Math.cos(a) * d, pos.z + Math.sin(a) * d)
        moves++
        const legs = r.legs
        for (let li = 0; li < legs.length; li++) {
          const l = legs[li]!
          const dx = l.x1 - l.x0, dz = l.z1 - l.z0, L = Math.hypot(dx, dz)
          if (l.surface.kind === 'terrain') {
            for (let k = 1; k * 0.5 < L; k++) {
              if (closed.has(Math.floor((l.x0 + (dx * k * 0.5) / L) / 20) * 100000 + Math.floor((l.z0 + (dz * k * 0.5) / L) / 20))) { tileViolations++; break }
            }
          } else {
            objectLegs++
            const ri = rawOf(l.surface)
            if (outside(ri, l.surface.cell, l.x0, l.z0) > 0.05 || outside(ri, l.surface.cell, l.x1, l.z1) > 0.05) {
              legOutsideCell++
              if (bad.length < 10) bad.push(`leg outside raw cell ${modelOf(l.surface)} #${l.surface.cell}`)
            }
          }
          // Outline edges properly crossed by this leg.
          const seen = new Set<string>()
          for (let gx = Math.floor(Math.min(l.x0, l.x1) / 50); gx <= Math.floor(Math.max(l.x0, l.x1) / 50); gx++) {
            for (let gz = Math.floor(Math.min(l.z0, l.z1) / 50); gz <= Math.floor(Math.max(l.z0, l.z1) / 50); gz++) {
              for (const { inst, e } of edgeGrid.get(gx * 100000 + gz) ?? []) {
                const id = `${inst.key}#${e}`
                if (seen.has(id)) continue
                seen.add(id)
                const E = inst.nav.outlineEdges, flag = E.flags[e]!
                if (!(flag & 1) || flag & 16) continue
                const [ax, az] = inst.W(E.vertices[e * 2]!), [bx, bz] = inst.W(E.vertices[e * 2 + 1]!)
                const ex = bx - ax, ez = bz - az, den = dx * ez - dz * ex
                if (Math.abs(den) < 1e-12) continue
                const t = ((ax - l.x0) * ez - (az - l.z0) * ex) / den
                const u = ((ax - l.x0) * dz - (az - l.z0) * dx) / den
                if (t <= 1e-6 || t >= 1 - 1e-6 || u < 0 || u > 1) continue
                // Entering = moving toward the edge's src cell.
                const cell = E.cells[e * 2]!
                const C = [0, 1, 2].map(k => inst.W(inst.nav.cells[cell * 3 + k]!))
                const cx = (C[0]![0] + C[1]![0] + C[2]![0]) / 3, cz = (C[0]![1] + C[1]![1] + C[2]![1]) / 3
                const entering = Math.sign(ez * (cx - ax) - ex * (cz - az)) === Math.sign(ez * dx - ex * dz)
                if (!entering) continue
                if (l.surface.kind === 'terrain') {
                  terrainEdgeViolations++
                  if (bad.length < 10) bad.push(`terrain leg enters blocked edge ${inst.key}#${e}`)
                } else if (instKey[l.surface.instance] !== inst.key) {
                  // A walker on object A crossing a blocking edge of object B at A's height: the native "other objects
                  // are not consulted while on an object" rule (NAVIGATION.md §6.3.4, [likely]); recorded, not failed.
                  const hy = inst.Y(E.vertices[e * 2]!) + (inst.Y(E.vertices[e * 2 + 1]!) - inst.Y(E.vertices[e * 2]!)) * u
                  if (Math.abs(w.heightOn(l.surface, l.x0 + dx * t, l.z0 + dz * t) - hy) > 15) continue
                  const k = `${modelOf(l.surface)} walks through ${data.models[data.instances[instKey.indexOf(inst.key)]!.model]!.key.split('/').pop()} (${g.gltfX(l.x0 + dx * t).toFixed(0)}, ${g.gltfZ(l.z0 + dz * t).toFixed(0)})`
                  foreign.set(k, (foreign.get(k) ?? 0) + 1)
                }
              }
            }
          }
          // The step to the next leg must be allowed by the raw data.
          const n = legs[li + 1]
          if (!n) continue
          const A = l.surface, B = n.surface
          let ok = true
          if (A.kind === 'object' && B.kind === 'object' && A.instance === B.instance) {
            if (A.cell !== B.cell) {
              const I = rawOf(A).nav.inlineEdges
              ok = false
              for (let e = 0; e < I.flags.length; e++) {
                const c0 = I.cells[e * 2]!, c1 = I.cells[e * 2 + 1]!, f = I.flags[e]!
                if ((c0 === A.cell && c1 === B.cell && !(f & 2)) || (c1 === A.cell && c0 === B.cell && !(f & 1))) ok = true
              }
            }
          } else if (A.kind === 'object' && B.kind === 'terrain') {
            ok = outlineNear(rawOf(A), A.cell, l.x1, l.z1, f => f === 0)
          } else if (A.kind === 'terrain' && B.kind === 'object') {
            const ri = rawOf(B)
            ok = outlineNear(ri, B.cell, l.x1, l.z1, (f, e) => !(f & 1) && !(f & 16) && (!(f & 8) || ri.links.some(k => k.edge === e)))
          } else if (A.kind === 'object' && B.kind === 'object') {
            ok = rawOf(A).links.some(k => k.target === instKey[B.instance]) || rawOf(B).links.some(k => k.target === instKey[A.instance])
          }
          if (!ok) {
            badSteps++
            if (bad.length < 10) bad.push(`step not allowed by raw data: ${modelOf(A)} -> ${modelOf(B)}`)
          }
        }
        pos = r.end
      }
      console.log(`check 4a (${moves} moves, ${objectLegs} object cell legs): closed-tile crossings ${tileViolations}, terrain legs entering blocked edges ` +
        `${terrainEdgeViolations}, legs outside their raw cell ${legOutsideCell}, steps not allowed by raw data ${badSteps}\n  ` +
        `on-object walk-throughs of other objects' blocking edges (native rule, not failed): ${[...foreign].map(([k, v]) => `${k} x${v}`).join('; ')}` +
        (bad.length ? `\n  ${bad.join('\n  ')}` : ''))
      expect(tileViolations).toBe(0)
      expect(terrainEdgeViolations).toBe(0)
      expect(legOutsideCell).toBe(0)
      expect(badSteps).toBe(0)
      expect(objectLegs).toBeGreaterThan(5000)
    })

    it('4b: walkways are open: a 2 m flood fill of straight moves from the spawn reaches every NPC, teleport point, plaza arm and gate', () => {
      const STEP = 2
      const key = (p: NavPosition) => `${Math.round(p.x / STEP)},${Math.round(p.z / STEP)},${p.surface.kind === 'object' ? p.surface.instance : -1}`
      const start = g.locate(m.spawn!.x, m.spawn!.z, m.spawn!.y)!
      const seen = new Map<string, NavPosition>([[key(start), start]])
      const queue = [start]
      while (queue.length) {
        const p = queue.pop()!
        const gx = Math.round(p.x / STEP), gz = Math.round(p.z / STEP)
        for (const [dx, dz] of [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const) {
          const tx = (gx + dx) * STEP, tz = (gz + dz) * STEP
          if (tx < bounds.x0 + 0.5 || tx > bounds.x1 - 0.5 || tz < bounds.z0 + 0.5 || tz > bounds.z1 - 0.5) continue
          const r = g.moveStraight(p, tx, tz)
          if (r.blocked) continue
          const k = key(r.end)
          if (!seen.has(k)) { seen.set(k, r.end); queue.push(r.end) }
        }
      }
      const grid = new Map<string, NavPosition[]>()
      for (const n of seen.values()) {
        const k = `${Math.floor(n.x / 4)},${Math.floor(n.z / 4)}`
        let l = grid.get(k)
        if (!l) grid.set(k, (l = []))
        l.push(n)
      }
      const reached = (x: number, z: number, y: number, r = 4, dy = 1.5) => {
        for (let i = -1; i <= 1; i++) {
          for (let j = -1; j <= 1; j++) {
            for (const n of grid.get(`${Math.floor(x / 4) + i},${Math.floor(z / 4) + j}`) ?? []) {
              if (Math.hypot(n.x - x, n.z - z) <= r && Math.abs(n.y - y) <= dy) return true
            }
          }
        }
        return false
      }
      const media = openArchive('Media')
      const ids = new Set(m.regions.map(r => r.id))
      const at = (region: number, lx: number, lz: number) => {
        const o = m.space.originRegion
        const p = toGltfPosition([REGION * ((region & 0xff) - o.x) + lx, 0, REGION * ((region >> 8) - o.z) + lz])
        return [p[0], p[2]] as const
      }
      // npcpos.txt: every NPC of the 9 regions (at the surface nearest its stored height; some route points of the
      // wandering NPC 1933 store heights 1-4 m off the ground, so the reached height is compared with that surface).
      const npcs = parseTextdata(media.read('server_dep/silkroad/textdata/npcpos.txt'), 'npcpos.txt').rows.filter(r => ids.has(Number(r.cells[1])))
      const missedNpcs: string[] = []
      for (const { cells } of npcs) {
        const [x, z] = at(Number(cells[1]), Number(cells[2]), Number(cells[4]))
        const s = g.locate(x, z, Number(cells[3]) / 10)
        if (!s || !reached(x, z, s.y)) missedNpcs.push(`${cells[0]} (${x.toFixed(1)}, ${z.toFixed(1)})`)
      }
      // teleportdata.txt: the town's return point and the gate guards' arrival points (outside the gates).
      const tele = parseTextdata(media.read('server_dep/silkroad/textdata/teleportdata.txt'), 'teleportdata.txt').rows.filter(r => ids.has(Number(r.cells[5])))
      const missedTele: string[] = []
      for (const { cells } of tele) {
        const [x, z] = at(Number(cells[5]), Number(cells[6]), Number(cells[8]))
        const s = g.locate(x, z, Infinity)!
        if (!reached(x, z, s.y)) missedTele.push(cells[2]!)
      }
      // Plaza arms out to the streets, and the palace stairs (straight, unblocked).
      const walkways: [string, [number, number], [number, number]][] = [
        ['plaza north arm -> palace street', [98, -120], [98, -165]], ['plaza south arm -> south street', [98, -50], [98, -25]],
        ['plaza east arm -> street', [125, -86], [160, -86]], ['plaza west arm -> street', [70, -86], [35, -86]],
        ['palace centre stairs', [98, -212], [98, -252]],
      ]
      const blockedWalkways = walkways.filter(([, a, b]) => g.moveStraight(g.locate(...a, Infinity)!, ...b).blocked).map(([n]) => n)
      let open = 0, openReached = 0
      for (let x = bounds.x0 + 1; x < bounds.x1; x += 4) {
        for (let z = bounds.z0 + 1; z < bounds.z1; z += 4) {
          if (!w.terrainOpen(g.fileX(x), g.fileZ(z))) continue
          open++
          if (grid.get(`${Math.floor(x / 4)},${Math.floor(z / 4)}`)?.length) openReached++
        }
      }
      console.log(`check 4b: flood fill from the spawn reached ${seen.size} nodes; NPCs ${npcs.length - missedNpcs.length}/${npcs.length}; teleport points ` +
        `${tele.length - missedTele.length}/${tele.length} (${tele.map(r => r.cells[2]).join(', ')}); walkways blocked: ${blockedWalkways.length}/${walkways.length}; ` +
        `open terrain 4 m samples reached ${openReached}/${open}` + (missedNpcs.length ? `; missed NPCs ${missedNpcs.join(', ')}` : ''))
      expect(missedNpcs).toEqual([])
      expect(missedTele).toEqual([])
      expect(tele.length).toBeGreaterThanOrEqual(5)
      expect(blockedWalkways).toEqual([])
      expect(openReached / open).toBeGreaterThan(0.8)
    })
  })

  it('5: the spawn stands on the plaza paving (rendered), in the open, out of the water, at teleportdata GATE_CH', () => {
    const sp = m.spawn!
    const row = parseTextdata(openArchive('Media').read('server_dep/silkroad/textdata/teleportdata.txt'), 'teleportdata.txt').rows
      .find(r => r.cells[2] === 'GATE_CH')!.cells
    const o = m.space.originRegion
    const region = Number(row[5])
    const p = toGltfPosition([REGION * ((region & 0xff) - o.x) + Number(row[6]), 0, REGION * ((region >> 8) - o.z) + Number(row[8])])
    expect(sp.x).toBeCloseTo(p[0], 4)
    expect(sp.z).toBeCloseTo(p[2], 4)
    const at = g.locate(sp.x, sp.z, sp.y)!
    expect(modelOf(at.surface)).toBe(PLAZA_MESH)
    expect(at.y).toBeCloseTo(sp.y, 3)
    // Rendered paving at the feet; nothing rendered 0.25..2 m above on a 0.5 m disc (not inside an object).
    expect(rendered.hits(sp.x, sp.z).some(h => Math.abs(h.y - sp.y) < 0.05)).toBe(true)
    for (let k = 0; k < 9; k++) {
      const [dx, dz] = k ? [0.5 * Math.cos(k * Math.PI / 4), 0.5 * Math.sin(k * Math.PI / 4)] : [0, 0]
      expect(rendered.hits(sp.x + dx, sp.z + dz).filter(h => h.y > sp.y + 0.25 && h.y < sp.y + 2)).toEqual([])
    }
    // Water: no water plane of the spawn's terrain block lies above the feet.
    const reg = m.regions.find(r => r.id === region)!
    const lx = (sp.x - reg.origin[0]) * 10, lz = (reg.origin[2] - sp.z) * 10
    const block = reg.blocks[Math.floor(lz / 320) * 6 + Math.floor(lx / 320)]!
    expect(block.water === null || block.water.heightM < sp.y).toBe(true)
    // A walker starting there is not enclosed: 20 m moves in 16 directions go at least 5 m.
    let far = 0
    for (let k = 0; k < 16; k++) {
      const r = g.moveStraight(at, sp.x + 20 * Math.sin((k / 16) * 2 * Math.PI), sp.z + 20 * Math.cos((k / 16) * 2 * Math.PI))
      if (r.distance > 5) far++
    }
    console.log(`check 5: spawn (${sp.x}, ${sp.y}, ${sp.z}) on ${modelOf(at.surface)}; water ${block.water ? `${block.water.kind} at ${block.water.heightM} m` : 'none'}; ${far}/16 directions walk > 5 m`)
    expect(far).toBe(16)
  })

  describe.skipIf(!hasPort)('6: a second implementation (third-party browser port, read-only data)', () => {
    // Its world frame (fitted to our rendered terrain from its heights.bin: mean |dy| 0.04 m over 400 points):
    // port x = 1.5 x + 9506.5, port z = -1.5 z + 1441, port y = 1.5 y (1 port unit = 1/1.5 m).
    const S = 1.5, BX = 9506.5, BZ = 1441
    let surfaces: { v: Float32Array; t: Uint32Array }[] = []
    /** Its collision: circles and oriented boxes (port units), 40-byte records before the surfaces. */
    let blockers: { cx: number; cz: number; co: number; si: number; circle: boolean; hx: number; hz: number }[] = []

    beforeAll(() => {
      const b = readFileSync(join(PORT, 'nav.bin'))
      const nb = b.readUInt32LE(8), count = b.readUInt32LE(12)
      blockers = []
      for (let i = 0, r = 16; i < nb; i++, r += 40) {
        const x = b.readFloatLE(r), z = b.readFloatLE(r + 4), rot = b.readFloatLE(r + 8), ox = b.readFloatLE(r + 24), oz = b.readFloatLE(r + 28)
        const co = Math.cos(rot), si = Math.sin(rot)
        blockers.push({ cx: x + ox * co + oz * si, cz: z - ox * si + oz * co, co, si, circle: b.readUInt8(r + 12) === 1, hx: b.readFloatLE(r + 16), hz: b.readFloatLE(r + 20) })
      }
      let o = 16 + nb * 40
      surfaces = []
      for (let s = 0; s < count; s++) {
        const vc = b.readUInt32LE(o), tc = b.readUInt32LE(o + 4)
        o += 8
        const v = new Float32Array(vc * 3)
        for (let i = 0; i < v.length; i++) v[i] = b.readFloatLE(o + i * 4)
        o += vc * 12
        const t = new Uint32Array(tc * 3)
        for (let i = 0; i < t.length; i++) t[i] = b.readUInt32LE(o + i * 4)
        o += tc * 12
        surfaces.push({ v, t })
      }
    })

    /** Whether glTF (x, z) lies inside a port blocker (either box axis convention: its sign is not documented). */
    const portBlocked = (x: number, z: number) => {
      const px = S * x + BX, pz = -S * z + BZ
      return blockers.some(k => {
        const dx = px - k.cx, dz = pz - k.cz
        if (Math.abs(dx) > 60 || Math.abs(dz) > 60) return false
        if (k.circle) return Math.hypot(dx, dz) <= k.hx
        return (Math.abs(dx * k.co - dz * k.si) <= k.hx && Math.abs(dx * k.si + dz * k.co) <= k.hz) ||
          (Math.abs(dx * k.co + dz * k.si) <= k.hx && Math.abs(-dx * k.si + dz * k.co) <= k.hz)
      })
    }

    /** Heights (m) of the port's walk surfaces over glTF (x, z). */
    const portSurfaces = (x: number, z: number) => {
      const px = S * x + BX, pz = -S * z + BZ
      const out: number[] = []
      for (const { v: V, t: T } of surfaces) {
        for (let t = 0; t < T.length; t += 3) {
          const a = T[t]! * 3, b = T[t + 1]! * 3, c = T[t + 2]! * 3
          const det = (V[b]! - V[a]!) * (V[c + 2]! - V[a + 2]!) - (V[c]! - V[a]!) * (V[b + 2]! - V[a + 2]!)
          if (Math.abs(det) < 1e-12) continue
          const u = ((px - V[a]!) * (V[c + 2]! - V[a + 2]!) - (V[c]! - V[a]!) * (pz - V[a + 2]!)) / det
          const w2 = ((V[b]! - V[a]!) * (pz - V[a + 2]!) - (px - V[a]!) * (V[b + 2]! - V[a + 2]!)) / det
          if (u < 0 || w2 < 0 || u + w2 > 1) continue
          out.push((V[a + 1]! + u * (V[b + 1]! - V[a + 1]!) + w2 * (V[c + 1]! - V[a + 1]!)) / S)
        }
      }
      return out
    }

    it('agrees on the plaza, spawn, palace and terrace floor heights and on the fountain hole', () => {
      const rows: string[] = []
      for (const [name, x, z] of [['plaza test point', ...PLAZA], ['spawn', m.spawn!.x, m.spawn!.z], ['palace indoor floor', 98, -275],
        ['palace terrace (cj_lamp02 row)', 43.3, -338.7], ['cj_luxury floor', 176, -48]] as [string, number, number][]) {
        const ours = g.locate(x, z, Infinity)!
        const theirs = portSurfaces(x, z)
        const d = theirs.reduce((b, y) => Math.min(b, Math.abs(y - ours.y)), Infinity)
        rows.push(`${name}: ours ${ours.y.toFixed(3)} (${modelOf(ours.surface)}), port [${theirs.map(y => y.toFixed(3)).join(', ')}]`)
        expect(d).toBeLessThan(0.05)
      }
      // The basin is a hole in both: no port surface 8 m from the centre, plaza paving at 9.5 m.
      let hole = 0, ring = 0
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * 2 * Math.PI
        if (!portSurfaces(FOUNTAIN[0] + 8 * Math.cos(a), FOUNTAIN[1] + 8 * Math.sin(a)).length) hole++
        if (portSurfaces(FOUNTAIN[0] + 12 * Math.cos(a), FOUNTAIN[1] + 12 * Math.sin(a)).some(y => Math.abs(y + 3.26) < 0.05)) ring++
      }
      console.log(`check 6 (port):\n  ${rows.join('\n  ')}\n  fountain: no port surface at 8 m ${hole}/16 (ours: none inside the 9.2 m rim), port paving at 12 m ${ring}/16`)
      expect(hole).toBe(16)
      expect(ring).toBeGreaterThanOrEqual(14)
    })

    it('agrees on where walls block: the cj_luxury wall, the south gate pier and arch', () => {
      // Ours: the straight crossing (20, -70) -> (170, -70) stops at the cj_luxury wall; the port has a blocker there.
      const across = g.moveStraight(g.locate(20, -70, 0)!, 170, -70)
      expect(across.blocked).toBe(true)
      const stop = across.end.x
      const portWall = Array.from({ length: 21 }, (_, i) => stop - 1 + i * 0.1).find(x => portBlocked(x, -70))
      // South gate: the pier at x 90 blocks in both, the centre arch at x 98 is open in both.
      const pier = g.moveStraight(g.locate(90, -10, 0)!, 90, 20)
      const arch = g.moveStraight(g.locate(98, -10, 0)!, 98, 20)
      const portPier = Array.from({ length: 31 }, (_, i) => -10 + i).some(z => portBlocked(90, z))
      const portArch = Array.from({ length: 31 }, (_, i) => -10 + i).some(z => portBlocked(98, z))
      console.log(`check 6 (port blocking): luxury wall: ours stops at x ${stop.toFixed(2)}, port blocker first at x ${portWall?.toFixed(2)}; ` +
        `gate pier x 90: ours blocked ${pier.blocked}, port ${portPier}; arch x 98: ours blocked ${arch.blocked}, port ${portArch}`)
      expect(portWall).toBeDefined()
      expect(pier.blocked && portPier).toBe(true)
      expect(arch.blocked || portArch).toBe(false)
    })
  })
})

