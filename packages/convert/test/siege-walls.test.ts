/**
 * Siege of Jangan, layer 0 (docs/SIEGE.md §3, §14 "Converter"):
 * - the nav split on a synthetic wall: the pieces cover the retail cells exactly, cut sides block, retail outline flags
 *   are kept, and walks equal the retail wall's until a piece is switched off;
 * - on the real export (skipped without it): the plan has 33 segments; walls.json passes its check; 2,000 random
 *   chords near the walls end where the retail nav ends them (±1 cm) with every third standing; each third's breach
 *   (its piece off, its tiles open) lets a walk from the field through the wall; the cut glbs have one node per piece,
 *   at most 1,500 triangles per third and the lightmap UV1 everywhere.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { NavWorld, buildNavData, decodeNavData, editNavInstances, navPiecePuts, type NavData, type NavPosition } from '@sro/nav'
import { describe, expect, it } from 'vitest'
import { checkWallsExport, thirdsDown, wallNav, type WallsExport } from '../../shared/src/siege.ts'
import { REPO_ROOT } from '../src/node-io.ts'
import { CUT_FLAG, navModelArea, splitNavModel } from '../src/world/siege/nav-split.ts'
import { checkPlan, splitPart, type SiegePlan } from '../src/world/siege/plan.ts'
import { flatRegion, grid, mesh, OX, OZ, placement, REGION_ID } from '../../nav/test/synthetic.ts'

const ground = (x: number, z: number): NavPosition => ({ x, y: 0, z, surface: { kind: 'terrain' } })

/**
 * A wall slab 900 x 160 units along x, raised (nobody stands on it), outline flag 3; with `underpass` one outline edge
 * flagged 16 (walked under: a walker can get inside the footprint there, where retail lets it roam and the split's cut
 * sides stop it; on Jangan the arches are inside the gatehouse pieces, never cut).
 */
function slabWorld(underpass = true): { data: NavData; under: number } {
  const g = grid(-450, 450, -80, 80, 9, 2, () => 200)
  const m = mesh(g.vertices, g.triangles, (a, b) => (underpass && a === 0 && b === 1 ? 16 : 3))
  const nvm = { ...flatRegion(), objects: [placement(0, 0x8001, 960, 0, 960)] }
  const data = buildNavData({ regions: [{ id: REGION_ID, nvm }], objectNavMesh: () => ({ key: 'slab', navMesh: m.nav }) })
  return { data, under: m.outlineIndex.get('0,1')! }
}

describe('splitNavModel (synthetic wall)', () => {
  it('pieces cover the cells exactly; cut sides block; retail outline flags are kept', () => {
    const { data } = slabWorld()
    const model = data.models[0]!
    const cuts = [-301, -150, 0.5, 149, 300]
    const pieces = splitNavModel(model, 0, cuts, (k) => `slab#${k}`)
    expect(pieces).toHaveLength(6)
    const area = pieces.reduce((s, p) => s + (p ? navModelArea(p) : 0), 0)
    expect(area).toBeCloseTo(navModelArea(model), 3)
    for (const p of pieces) {
      expect(p).not.toBeNull()
      // every vertex inside its slab
      const k = pieces.indexOf(p)
      const lo = k === 0 ? -Infinity : cuts[k - 1]!, hi = k === cuts.length ? Infinity : cuts[k]!
      for (let i = 0; i < p!.vertices.length; i += 3) {
        expect(p!.vertices[i]!).toBeGreaterThanOrEqual(lo - 1e-6)
        expect(p!.vertices[i]!).toBeLessThanOrEqual(hi + 1e-6)
      }
      // outline edges on a cut plane block
      const o = p!.outline
      for (let e = 0; e < o.flags.length; e++) {
        const x0 = p!.vertices[o.vertices[e * 2]! * 3]!, x1 = p!.vertices[o.vertices[e * 2 + 1]! * 3]!
        if (x0 === x1 && cuts.includes(x0)) expect(o.flags[e]).toBe(CUT_FLAG)
      }
    }
    // the one retail edge flagged 16 (x -450 .. -350 at z -80) survives in the first piece
    expect([...pieces[0]!.outline.flags]).toContain(16)
  })

  it('walks equal the retail wall with every piece on; a switched-off piece opens a gap', () => {
    const { data } = slabWorld(false)
    const cuts = [-150, 150]
    const pieces = splitNavModel(data.models[0]!, 0, cuts, (k) => `slab#${k}`)
    const piecesData: NavData = {
      version: 1, regions: [], models: pieces.map((p) => p!),
      instances: pieces.map((_, k) => ({ id: 0xf0000 + k, objId: 1, model: k, x: OX + 960, y: 0, z: OZ + 960, yaw: 0, links: [] })),
    }
    const retail = new NavWorld(data)
    const split = new NavWorld(editNavInstances(data, { put: navPiecePuts(piecesData) }).data)
    split.setInstanceEnabled(0, false)
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
    for (let i = 0; i < 400; i++) {
      const x0 = OX + 960 + (rnd() - 0.5) * 1400, z0 = OZ + 960 + (rnd() < 0.5 ? -1 : 1) * (100 + rnd() * 300)
      const x1 = OX + 960 + (rnd() - 0.5) * 1400, z1 = OZ + 960 + (rnd() - 0.5) * 900
      const a = retail.moveStraight(ground(x0, z0), x1, z1)
      const b = split.moveStraight(ground(x0, z0), x1, z1)
      expect(b.blocked).toBe(a.blocked)
      expect(Math.hypot(a.end.x - b.end.x, a.end.z - b.end.z)).toBeLessThan(0.1)
    }
    expect(split.moveStraight(ground(OX + 960, OZ + 700), OX + 960, OZ + 1200).blocked).toBe(true)
    split.setInstanceEnabled(2, false)
    expect(split.moveStraight(ground(OX + 960, OZ + 700), OX + 960, OZ + 1200).blocked).toBe(false)
    expect(split.moveStraight(ground(OX + 1300, OZ + 700), OX + 1300, OZ + 1200).blocked).toBe(true)
  })

  it('splitPart snaps inner ends to half-repeat lines near the equal split', () => {
    expect(splitPart(0, 100, 2, null)).toEqual([0, 50, 100])
    // repeat 12 m, lines every 6 m from phase 1: 50 -> 49
    expect(splitPart(0, 100, 2, { repeatM: 12, phase: 1 })).toEqual([0, 49, 100])
  })
})

// ---- the real export -------------------------------------------------------------------------------------------------

const WORLD = join(REPO_ROOT, 'work', 'out', 'world', 'jangan-fields')
const PLAN = join(REPO_ROOT, 'content', 'siege', 'jangan.json')
const HAVE = existsSync(join(WORLD, 'siege', 'walls.json')) && existsSync(join(WORLD, 'nav.bin')) && existsSync(PLAN)

describe.skipIf(!HAVE)('Jangan walls on the real export', () => {
  const plan = HAVE ? (JSON.parse(readFileSync(PLAN, 'utf8')) as SiegePlan) : null
  const walls = HAVE ? (JSON.parse(readFileSync(join(WORLD, 'siege', 'walls.json'), 'utf8')) as WallsExport) : null
  const load = () => {
    const nav = decodeNavData(new Uint8Array(readFileSync(join(WORLD, 'nav.bin'))))
    const pieces = decodeNavData(new Uint8Array(readFileSync(join(WORLD, ...walls!.navFile.split('/')))))
    const manifest = JSON.parse(readFileSync(join(WORLD, 'manifest.json'), 'utf8')) as { space: { originRegion: { x: number; z: number } } }
    const split = new NavWorld(editNavInstances(nav, { put: navPiecePuts(pieces) }).data)
    const indexOf = new Map<number, number>()
    split.data.instances.forEach((inst, i) => indexOf.set(inst.id >>> 0, i))
    for (const s of walls!.sides) split.setInstanceEnabled(indexOf.get(s.retailInstance)!, false)
    const o = manifest.space.originRegion
    // the retail walls' XZ boxes (file units): a start inside one is no place to stand
    const boxes = walls!.sides.map((sd) => {
      const inst = nav.instances.find((i) => i.id >>> 0 === sd.retailInstance)!
      const v = nav.models[inst.model]!.vertices
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
      for (let k = 0; k < v.length; k += 3) {
        x0 = Math.min(x0, inst.x + v[k]!); x1 = Math.max(x1, inst.x + v[k]!)
        z0 = Math.min(z0, inst.z + v[k + 2]!); z1 = Math.max(z1, inst.z + v[k + 2]!)
      }
      return { x0: x0 - 10, x1: x1 + 10, z0: z0 - 10, z1: z1 + 10 }
    })
    const inWall = (x: number, z: number) => boxes.some((b) => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1)
    return { retail: new NavWorld(nav), split, indexOf, inWall, fx: (x: number) => 1920 * o.x + x * 10, fz: (z: number) => 1920 * o.z - z * 10 }
  }

  it('the plan has 33 segments of about 48 m and walls.json passes its check', () => {
    expect(checkPlan(plan)).toEqual([])
    expect(checkWallsExport(walls)).toEqual([])
    expect(walls!.segments).toHaveLength(33)
    const counts = Object.fromEntries(['N', 'S', 'W', 'E'].map((s) => [s, walls!.segments.filter((g) => g.side === s).length]))
    expect(counts).toEqual({ N: 10, S: 9, W: 7, E: 7 })
    for (const g of walls!.segments) {
      expect(g.to - g.from).toBeGreaterThan(36)
      expect(g.to - g.from).toBeLessThan(60)
      for (const t of g.thirds) expect(t.instances.length).toBe(1)
    }
  })

  it('2,000 random chords near the walls end where the retail walls end them (every third standing)', () => {
    const { retail, split, fx, fz, inWall } = load()
    let seed = 2026
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
    let n = 0
    let tries = 0
    while (n < 2000 && tries < 20000) {
      tries++
      const side = walls!.sides[Math.floor(rnd() * 4)]!
      const segs = walls!.segments.filter((g) => g.side === side.side)
      const a0 = Math.min(...segs.map((g) => g.from)) - 30, a1 = Math.max(...segs.map((g) => g.to)) + 30
      const along = a0 + (a1 - a0) * rnd()
      const across = side.line + (rnd() - 0.5) * 80
      const [x, z] = side.axis === 'x' ? [along, across] : [across, along]
      const sx = fx(x), sz = fz(z)
      if (!retail.terrainOpen(sx, sz)) continue
      // not inside a wall body (no place to stand)
      if (inWall(sx, sz)) continue
      const ang = rnd() * Math.PI * 2, len = 10 + rnd() * 60
      const tx = sx + Math.cos(ang) * len * 10, tz = sz + Math.sin(ang) * len * 10
      const start = { x: sx, y: retail.terrainHeight(sx, sz), z: sz, surface: { kind: 'terrain' as const } }
      const r = retail.moveStraight(start, tx, tz)
      const q = split.moveStraight(start, tx, tz)
      expect(q.blocked, `chord ${n}`).toBe(r.blocked)
      expect(Math.hypot(r.end.x - q.end.x, r.end.z - q.end.z), `chord ${n}`).toBeLessThan(0.1)
      n++
    }
    expect(n).toBe(2000)
  })

  it('each third, down with its breach tiles, lets a walk from the field through the wall', () => {
    const { split, indexOf, fx, fz } = load()
    for (const seg of walls!.segments) {
      const side = walls!.sides.find((s) => s.side === seg.side)!
      for (const [k, t] of seg.thirds.entries()) {
        const nav = wallNav(new Map([[seg.id, k === 1 ? 'breached' : 'rubble']]), walls!)
        // just this third: switch it off with its tiles
        for (const id of t.instances) split.setInstanceEnabled(indexOf.get(id)!, false)
        for (const [r, tile] of t.tiles) split.setTileOverride(r, tile, 'open')
        let through = false
        for (const off of [0, -3, 3, -6, 6]) {
          const along = (t.from + t.to) / 2 + off
          const outC = side.outer + side.out * 30, inC = side.inner - side.out * 10
          const [ox, oz] = side.axis === 'x' ? [along, outC] : [outC, along]
          const [ix, iz] = side.axis === 'x' ? [along, inC] : [inC, along]
          if (!split.terrainOpen(fx(ox), fz(oz))) continue
          const r = split.moveStraight({ x: fx(ox), y: split.terrainHeight(fx(ox), fz(oz)), z: fz(oz), surface: { kind: 'terrain' } }, fx(ix), fz(iz))
          const ex = (r.end.x - (fx(0))) / 10, ez = -(r.end.z - fz(0)) / 10
          const past = side.out * (side.inner - (side.axis === 'x' ? ez : ex))
          if (!r.blocked || past > 0) {
            through = true
            break
          }
        }
        expect(through, `${t.id}`).toBe(true)
        expect(nav.disabled.length).toBeGreaterThan(0)
        for (const id of t.instances) split.setInstanceEnabled(indexOf.get(id)!, true)
        for (const [r, tile] of t.tiles) split.setTileOverride(r, tile, null)
      }
    }
    expect(thirdsDown('breached')).toEqual([1])
  })

  it.skipIf(!existsSync(join(WORLD, 'siege', 'models', 'cj_w_cut.glb')))('the cut glbs: a node per piece, ≤ 1,500 triangles a third, UV1 everywhere', async () => {
    const io = new NodeIO()
    for (const side of walls!.sides) {
      expect(side.glb).toBeTruthy()
      const doc = await io.read(join(WORLD, ...side.glb!.split('/')))
      const names = new Set(doc.getRoot().listNodes().map((n) => n.getName()))
      const thirds = walls!.segments.filter((g) => g.side === side.side).flatMap((g) => g.thirds)
      for (const t of thirds) expect(names.has(t.id), t.id).toBe(true)
      for (const f of side.fixed) expect(names.has(f.id), f.id).toBe(true)
      for (const node of doc.getRoot().listNodes()) {
        const m = node.getMesh()
        if (!m) continue
        for (const p of m.listPrimitives()) expect(p.getAttribute('TEXCOORD_1'), node.getName()).not.toBeNull()
      }
      for (const t of thirds) {
        const holder = doc.getRoot().listNodes().find((n) => n.getName() === t.id)!
        let tris = 0
        for (const c of holder.listChildren()) for (const p of c.getMesh()?.listPrimitives() ?? []) tris += (p.getIndices()?.getCount() ?? 0) / 3
        expect(tris, t.id).toBeGreaterThan(0)
        expect(tris, t.id).toBeLessThanOrEqual(1500)
      }
      // the retail material names are back (no Blender .001 suffix)
      for (const mat of doc.getRoot().listMaterials()) expect(mat.getName()).not.toMatch(/\.\d{3}$/)
    }
  })
})
