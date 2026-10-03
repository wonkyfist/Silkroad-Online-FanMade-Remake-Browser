// WE-U (docs/WORLD_EDITOR.md §3.1, §3.4, §4.1, §4.3, §4.4, §4.6; docs/WAVE_PLAN8.md §6.2): the World Editor's edit
// models without an engine: brush maths on the global lattice (seams bit-identical), deltas snapped to 1/256 m (the
// preview equals the converter's applyHeightLayer bit for bit), undo / redo exact, revert one change, paint and grass
// strokes, object edits lowered through the shared lowering, the Walkable brush (force open / closed, its hard limits),
// and the Save payload round trip.
import { describe, expect, it } from 'vitest'
import {
  WALK_REFUSAL, WE_HEIGHT_STEPS_PER_M, WE_WALK, applyHeightLayer, applyPaintLayer, decodeHeightLayer, decodeWalkLayer, paintWord,
  regionIdOf, validateWorldEditPlacements, walkRefusalSentence,
} from '../../../packages/shared/src/world-edits/index.ts'
import type { WorldPlacement } from '../../../packages/convert/src/world/manifest.ts'
import { CELLS, GRID, Lattice, falloff } from '../src/editor/lattice.ts'
import { CoastGuard } from '../src/editor/terrain-edits.ts'
import { EditSession, unpackPixels } from '../src/editor/session.ts'
import { addRef, retailRef } from '../src/editor/object-edits.ts'
import { heightLabel, walkLabel } from '../src/editor/history.ts'
import type { WalkMode } from '../src/editor/walk-edits.ts'

const OX = 168, OZ = 97
const REGIONS = [168, 169, 170].flatMap(x => [97, 98].map(z => regionIdOf(x, z)))

/** Heights from one global function: every seam vertex holds the same float32 in both regions, as the export does. */
const globalH = (GX: number, GZ: number) => Math.fround(5 + 0.137 * Math.sin(GX * 0.21) * 7 + 0.0731 * GZ + 0.01 * ((GX * 31 + GZ * 17) % 13))

function makeRegions() {
  const m = new Map<number, { heights: Float32Array; words: Uint16Array }>()
  for (const id of REGIONS) {
    const rx = id & 0xff, rz = id >> 8
    const heights = new Float32Array(GRID * GRID)
    const words = new Uint16Array(GRID * GRID)
    for (let gz = 0; gz < GRID; gz++) {
      for (let gx = 0; gx < GRID; gx++) {
        heights[gz * GRID + gx] = globalH(rx * CELLS + gx, rz * CELLS + gz)
        words[gz * GRID + gx] = paintWord(gx < 48 ? 2 : 0, 1)
      }
    }
    m.set(id, { heights, words })
  }
  return m
}

function placement(region: number, uid: number, source: string, position: [number, number, number], yaw = 0): WorldPlacement {
  return {
    objId: 7, source, models: [0], compound: false, position, rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], yaw,
    flags: { static: true, big: false, struct: false }, staticFlag: 0xffff, uid, region, group: 3, inConvertedRegion: true,
  }
}

const TREE = 'res\\nature\\common\\tree\\tre_tree01.bsr'
const ROCK = 'res\\nature\\common\\stone_field03.bsr'

function setup(placements: WorldPlacement[] = []) {
  const regions = makeRegions()
  const s = new EditSession({
    world: 'jangan-fields', originRegion: { x: OX, z: OZ }, regions: REGIONS, placements,
    host: { heights: id => regions.get(id)?.heights ?? null, words: id => regions.get(id)?.words ?? null },
  })
  // the region filter's capture, as at decode
  for (const [id, r] of regions) {
    s.heights.captureBase(id, r.heights)
    s.paint.captureBase(id, r.words)
  }
  const exported = new Map([...regions].map(([id, r]) => [id, Float32Array.from(r.heights)]))
  return { s, regions, exported }
}

const brush = { radiusM: 14, strength: 0.8, softness: 0.5 }

/** A stroke of n stamps along a line (glTF metres). */
function stroke(s: EditSession, tool: 'raise' | 'lower' | 'smooth' | 'flatten' | 'noise', x0: number, z0: number, x1: number, z1: number, n = 20) {
  s.heights.begin(tool, brush, { seed: s.history.peekId() })
  for (let i = 0; i < n; i++) {
    const a = n > 1 ? i / (n - 1) : 0
    s.heights.stamp(x0 + (x1 - x0) * a, z0 + (z1 - z0) * a)
  }
  const c = s.heights.end()
  return c ? s.record({ height: c }, heightLabel(tool, c), c.regions) : null
}

function seamsEqual(regions: Map<number, { heights: Float32Array }>) {
  let checked = 0
  for (const [id, r] of regions) {
    const rx = id & 0xff, rz = id >> 8
    const east = regions.get(regionIdOf(rx + 1, rz))
    if (east) for (let gz = 0; gz < GRID; gz++) {
      expect(Object.is(r.heights[gz * GRID + CELLS], east.heights[gz * GRID])).toBe(true)
      checked++
    }
    const north = regions.get(regionIdOf(rx, rz + 1))
    if (north) for (let gx = 0; gx < GRID; gx++) {
      expect(Object.is(r.heights[CELLS * GRID + gx], north.heights[gx])).toBe(true)
      checked++
    }
  }
  return checked
}

describe('the lattice', () => {
  it('lists every region holding a seam or corner vertex, and maps glTF metres both ways', () => {
    const L = new Lattice(OX, OZ, id => REGIONS.includes(id))
    expect(L.holdersOf(169 * 96 + 10, 97 * 96 + 10)).toBe(1)
    expect(L.holdersOf(169 * 96, 97 * 96 + 10)).toBe(2)
    expect(L.holdersOf(169 * 96, 98 * 96)).toBe(4)
    // the export's outer corner: only one region holds it
    expect(L.holdersOf(168 * 96, 97 * 96)).toBe(1)
    expect(L.x(L.toGX(123.5))).toBeCloseTo(123.5, 9)
    expect(L.z(L.toGZ(-77.25))).toBeCloseTo(-77.25, 9)
    // region (169, 97)'s south-west corner is glTF (192, 0)
    expect(L.toGX(192)).toBe(169 * 96)
    expect(L.toGZ(0)).toBe(97 * 96)
  })

  it('fades the brush over the last 8 m before the export edge', () => {
    const L = new Lattice(OX, OZ, id => REGIONS.includes(id))
    expect(L.edgeFade(169 * 96 + 48, 97 * 96 + 48, 8)).toBe(1)
    expect(L.edgeFade(168 * 96, 97 * 96 + 48, 8)).toBe(0)
    expect(L.edgeFade(168 * 96 + 2, 97 * 96 + 48, 8)).toBeCloseTo(0.5, 9)
    expect(falloff(0, 10, 0.5)).toBe(1)
    expect(falloff(10, 10, 0.5)).toBe(0)
  })
})

describe('terrain brushes', () => {
  it('keeps seams bit-identical and snaps every delta to 1/256 m: the preview equals applyHeightLayer', () => {
    const { s, regions, exported } = setup()
    // across the corner of four regions
    stroke(s, 'raise', 150, -170, 230, -210)
    stroke(s, 'smooth', 170, -200, 200, -185)
    stroke(s, 'noise', 190, -190, 196, -194, 5)
    stroke(s, 'flatten', 180, -180, 205, -205)
    stroke(s, 'lower', 192, -192, 192, -192, 8)
    expect(seamsEqual(regions)).toBeGreaterThan(0)
    const touched = s.heights.touchedRegions()
    expect(touched.length).toBe(4)
    for (const id of touched) {
      const layer = s.heights.layer(id)!
      for (let i = 0; i < layer.delta.length; i++) {
        if (!layer.mask[i]) continue
        const steps = layer.delta[i]! * WE_HEIGHT_STEPS_PER_M
        expect(Number.isInteger(steps)).toBe(true)
      }
      // what the converter computes from the saved layer, bit for bit
      const fromLayer = applyHeightLayer(exported.get(id)!, layer)
      expect(Buffer.from(fromLayer.buffer).equals(Buffer.from(regions.get(id)!.heights.buffer))).toBe(true)
    }
  })

  it('undo / redo are bit-exact, and revert one change keeps the later ones', () => {
    const { s, regions, exported } = setup()
    const snap = () => new Map([...regions].map(([id, r]) => [id, Float32Array.from(r.heights)]))
    const eq = (a: Map<number, Float32Array>, b: Map<number, Float32Array>) =>
      [...a].every(([id, h]) => Buffer.from(h.buffer).equals(Buffer.from(b.get(id)!.buffer)))
    const a = stroke(s, 'raise', 100, -100, 160, -120)!
    const afterA = snap()
    const b = stroke(s, 'raise', 300, -100, 340, -150)!
    stroke(s, 'smooth', 120, -110, 150, -115)
    const afterAll = snap()
    s.undo(); s.undo(); s.undo()
    expect(eq(snap(), exported)).toBe(true)
    s.redo(); s.redo(); s.redo()
    expect(eq(snap(), afterAll)).toBe(true)
    // revert B only (it does not overlap A): A and the smooth stay, B's ground is the export's again
    s.revertOne(b.id)
    const now = snap()
    for (const id of b.height!.regions) {
      const rx = id & 0xff
      if (rx === 169 || rx === 170) {
        // region 169/170 at x 300..340 belong to b only
        const h = now.get(id)!
        const e = exported.get(id)!
        const gx = Math.round((320 - 192 * (rx - OX)) / 2)
        if (gx >= 0 && gx < GRID) expect(h[48 * GRID + gx]).toBe(e[48 * GRID + gx])
      }
    }
    // re-apply B: back to the full edit, bit for bit
    s.revertOne(b.id)
    expect(eq(snap(), afterAll)).toBe(true)
    // revert A under the later smooth: the difference of A comes off, exactly (multiples of 1/256 m)
    s.revertOne(a.id)
    s.revertOne(a.id)
    expect(eq(snap(), afterAll)).toBe(true)
    expect(afterA.size).toBe(6)
  })

  it('the coast guard keeps the sea floor under the sea and the shore above it', () => {
    const { s, regions } = setup()
    // sea: everything west of x = 100; sea level 6 m
    const guard = new CoastGuard({ seaLevelM: 6, seaAt: x => x < 100 })
    s.heights.guard = guard
    for (let i = 0; i < 6; i++) stroke(s, 'raise', 60, -100, 140, -100, 30)
    const L = s.lattice
    const r = regions.get(regionIdOf(168, 97))!
    for (let gx = 0; gx < GRID; gx++) {
      const x = L.x(168 * 96 + gx)
      const h = r.heights[48 * GRID + gx]!
      const base = globalH(168 * 96 + gx, 97 * 96 + 48)
      if (x < 100) expect(h).toBeLessThanOrEqual(Math.max(base, 5.5) + 1 / 256)
    }
    expect(guard.clamped).toBeGreaterThan(0)
    for (let i = 0; i < 6; i++) stroke(s, 'lower', 100, -60, 160, -60, 30)
    for (let gx = 52; gx < GRID; gx++) {
      const h = r.heights[30 * GRID + gx]!
      const base = globalH(168 * 96 + gx, 97 * 96 + 30)
      expect(h).toBeGreaterThanOrEqual(Math.min(base, 6.3) - 1 / 256)
    }
  })

  it('a region streamed in again gets its edits from the filter, and Save / load round-trips', async () => {
    const { s, regions, exported } = setup()
    stroke(s, 'raise', 150, -170, 230, -210)
    const id = regionIdOf(169, 97)
    const edited = Float32Array.from(regions.get(id)!.heights)
    // the region leaves and decodes again: the filter writes the deltas into the fresh export heights
    const fresh = Float32Array.from(exported.get(id)!)
    s.heights.captureBase(id, fresh)
    expect(Buffer.from(fresh.buffer).equals(Buffer.from(edited.buffer))).toBe(true)

    const payload = await s.buildSave()
    expect(payload.files['edits.json'].regions.map(r => `${r.x},${r.z}`)).toEqual(['168,97', '169,97', '168,98', '169,98'].sort((a, b) => {
      const [ax, az] = a.split(',').map(Number), [bx, bz] = b.split(',').map(Number)
      return ((az! << 8) | ax!) - ((bz! << 8) | bx!)
    }))
    expect(payload.files['edits.json'].regions.every(r => /^[0-9a-f]{64}$/.test(r.base))).toBe(true)
    const hl = payload.layers.find(l => l.kind === 'height' && l.x === 169 && l.z === 97)!
    const decoded = decodeHeightLayer(unpackPixels(hl))
    expect(Buffer.from(applyHeightLayer(exported.get(id)!, decoded).buffer).equals(Buffer.from(edited.buffer))).toBe(true)

    // a fresh session on the export loads it back: the same ground, and the journal still undoes
    const b = setup()
    b.s.load(JSON.parse(JSON.stringify(payload)))
    for (const [rid, r] of regions) expect(Buffer.from(b.regions.get(rid)!.heights.buffer).equals(Buffer.from(r.heights.buffer))).toBe(true)
    expect(b.s.history.changes.length).toBe(1)
    b.s.undo()
    for (const [rid, h] of exported) expect(Buffer.from(b.regions.get(rid)!.heights.buffer).equals(Buffer.from(h.buffer))).toBe(true)
  })
})

describe('the journal', () => {
  it('a reloaded journal redoes its undone changes oldest first', async () => {
    const { s } = setup()
    stroke(s, 'raise', 100, -100, 120, -100)
    stroke(s, 'raise', 300, -100, 320, -100)
    stroke(s, 'lower', 150, -150, 160, -150)
    s.undo()
    s.undo()
    const payload = JSON.parse(JSON.stringify(await s.buildSave()))
    const b = setup()
    b.s.load(payload)
    expect(b.s.history.changes.map(c => c.state)).toEqual(['done', 'undone', 'undone'])
    expect(b.s.redo()!.id).toBe(2)
    expect(b.s.redo()!.id).toBe(3)
    expect(b.s.redo()).toBeNull()
  })
})

describe('texture paint and grass', () => {
  it('paints words on the lattice (seams agree), undoes exactly, reverts one stroke under a later one', () => {
    const { s, regions } = setup()
    const word = paintWord(13, 2)
    s.paint.begin(word, { radiusM: 12, strength: 1, softness: 0.2 })
    s.paint.stamp(192, -192)
    const a = s.paint.end()!
    const ca = s.record({ paint: a }, 'paint a', a.regions)
    expect(a.regions.length).toBe(4)
    for (const id of a.regions) {
      const w = s.paint.wordsFor(id)!
      const layer = s.paint.layer(id)!
      expect(Array.from(applyPaintLayer(regions.get(id)!.words, layer))).toEqual(Array.from(w))
    }
    // the seam vertex at the corner is painted in all four regions
    for (const id of a.regions) {
      const rx = id & 0xff, rz = id >> 8
      const gx = rx === 169 ? 0 : CELLS, gz = rz === 98 ? 0 : CELLS
      expect(s.paint.wordsFor(id)![gz * GRID + gx]).toBe(word)
    }
    const word2 = paintWord(14, 2)
    s.paint.begin(word2, { radiusM: 6, strength: 1, softness: 0.1 })
    s.paint.stamp(196, -196)
    const b = s.paint.end()!
    s.record({ paint: b }, 'paint b', b.regions)
    const L = s.lattice
    expect(s.paint.paintAt(L.toGX(192), L.toGZ(-192))).toBe(word2)
    expect(s.paint.paintAt(L.toGX(186), L.toGZ(-192))).toBe(word)
    s.revertOne(ca.id)
    // b's vertices keep b's word; a's others are the export's again
    expect(s.paint.paintAt(L.toGX(192), L.toGZ(-192))).toBe(word2)
    expect(s.paint.paintAt(L.toGX(186), L.toGZ(-192))).toBe(-1)
    s.undo() // undoes b (the newest in effect): a stays reverted under it
    expect(s.paint.paintAt(L.toGX(192), L.toGZ(-192))).toBe(-1)
    expect(s.paint.touchedRegions()).toEqual([])
    s.redo()
    s.revertOne(ca.id) // re-apply a under b: b's vertices keep b's word
    expect(s.paint.paintAt(L.toGX(192), L.toGZ(-192))).toBe(word2)
    expect(s.paint.paintAt(L.toGX(186), L.toGZ(-192))).toBe(word)
    s.undo()
    expect(s.paint.paintAt(L.toGX(192), L.toGZ(-192))).toBe(word)
  })

  it('grass strokes change the 1 m mask, and the live mask is the bake order (south first)', () => {
    const { s } = setup()
    s.grass.begin('less', { radiusM: 5, strength: 1, softness: 0.5 })
    for (let i = 0; i < 10; i++) s.grass.stamp(100.5, -50.5)
    const c = s.grass.end()!
    s.record({ grass: c }, 'less', c.regions)
    expect(s.grass.sample(100.5, -50.5).density).toBe(0)
    const id = regionIdOf(168, 97)
    const mask = s.grass.mask(id)!
    // texel x 100, z 50 (south first)
    expect(mask[(50 * 192 + 100) * 4]).toBe(0)
    expect(mask[(50 * 192 + 100) * 4 + 3]).toBe(255)
    expect(mask[(0 * 192 + 0) * 4]).toBe(128)
    s.undo()
    expect(s.grass.sample(100.5, -50.5).density).toBe(1)
    expect(s.grass.mask(id)).toBeNull()
  })
})

describe('object edits', () => {
  it('moves, deletes and adds lower to the converter shape; a move out of its region takes an editor uid', () => {
    const r0 = regionIdOf(168, 97)
    const ps = [placement(r0, 32770, TREE, [150, 4, -150]), placement(r0, 33794, ROCK, [20, 4, -20]), placement(regionIdOf(169, 97), 32770, TREE, [250, 4, -20])]
    const { s } = setup(ps)
    const o = s.objects
    const tree = retailRef(r0, 32770)
    // move the tree into region 169,97 (whose retail uid 32770 is taken): drop + add under a fresh editor uid
    const before = o.current(tree)!
    const after = { ...before, position: [200, 5, -150] as [number, number, number], yaw: 0.5 }
    o.set(tree, after)
    s.record({ objects: { items: [{ ref: tree, before, after }] } }, 'move', [r0])
    o.set(retailRef(r0, 33794), null)
    const add = o.newAddRef()
    o.set(add, { source: ROCK, position: [30, 4, -30], yaw: 1, scale: 1.2 })
    const file = o.toFile()
    expect(file.move.length).toBe(1)
    expect(file.drop.length).toBe(1)
    expect(file.add).toEqual([{ id: 'ed-1', source: ROCK, position: [30, 4, -30], yaw: 1, scale: 1.2 }])
    const check = validateWorldEditPlacements(file, { world: 'jangan-fields', originRegion: { x: OX, z: OZ } })
    expect(check.problems).toEqual([])
    const low = o.lower()
    expect(low.problems).toEqual([])
    const r1 = low.regions.get(regionIdOf(169, 97))!
    const moved = r1.find(p => p.source === TREE && p.uid !== 32770)!
    expect(moved.uid).toBe(0xe000)
    expect(moved.position).toEqual([200, 5, -150])
    expect(low.keyOf.get(tree)).toBe(`${regionIdOf(169, 97)}:${0xe000}`)
    const own = low.regions.get(r0)!
    expect(own.map(p => p.uid).sort()).toEqual([0xe000])
    expect(own[0]!.scale).toBe(1.2)
    expect(low.keyOf.get(addRef('ed-1'))).toBe(`${r0}:${0xe000}`)
    // undo the move: the tree is the export's again (no override left)
    s.undo()
    expect(o.edited(tree)).toBe(false)
  })

  it('revert this region removes every edit there in one undoable change', () => {
    const r0 = regionIdOf(168, 97)
    const { s, regions, exported } = setup([placement(r0, 5, ROCK, [40, 4, -40])])
    stroke(s, 'raise', 60, -60, 90, -90)
    const ref = retailRef(r0, 5)
    const before = s.objects.current(ref)!
    s.objects.set(ref, null)
    s.record({ objects: { items: [{ ref, before, after: null }] } }, 'delete', [r0])
    const c = s.revertRegion(r0)!
    expect(c.objects!.items.length).toBe(1)
    expect(s.objects.current(ref)).not.toBeNull()
    expect(Buffer.from(regions.get(r0)!.heights.buffer).equals(Buffer.from(exported.get(r0)!.buffer))).toBe(true)
    s.undo()
    expect(s.objects.current(ref)).toBeNull()
  })
})

describe('the original map on screen (before pictures, the Original button)', () => {
  it('takes every edit out without recording, and puts it back bit for bit', () => {
    const r0 = regionIdOf(168, 97)
    const { s } = setup([placement(r0, 32770, TREE, [150, 4, -150])])
    stroke(s, 'raise', 180, -180, 210, -200)
    s.paint.begin(paintWord(13, 2), { radiusM: 8, strength: 1, softness: 0.2 })
    s.paint.stamp(150, -100)
    const p = s.paint.end()!
    s.record({ paint: p }, 'paint', p.regions)
    const tree = retailRef(r0, 32770)
    const before = s.objects.current(tree)!
    const moved = { ...before, position: [160, 5, -140] as [number, number, number] }
    s.objects.set(tree, moved)
    s.record({ objects: { items: [{ ref: tree, before, after: moved }] } }, 'move', [r0])
    const add = s.objects.newAddRef()
    s.objects.set(add, { source: ROCK, position: [30, 4, -30], yaw: 1, scale: 1 })
    s.record({ objects: { items: [{ ref: add, before: null, after: s.objects.current(add)! }] } }, 'add', [r0])
    const heights = new Map(REGIONS.map(id => [id, Float32Array.from(s.opts.host.heights(id)!)]))
    const words = new Map(REGIONS.map(id => [id, Array.from(s.paint.wordsFor(id) ?? [])]))
    const changes = s.history.changes.length
    const unsaved = s.unsaved
    const hidden = s.hideEdits()
    expect(hidden.length).toBeGreaterThan(0)
    expect(s.heights.touchedRegions()).toEqual([])
    expect(s.paint.touchedRegions()).toEqual([])
    expect(s.objects.current(tree)).toEqual(before)
    expect(s.objects.current(add)).toBeNull()
    for (const id of REGIONS) expect(Array.from(s.opts.host.heights(id)!)).toEqual(Array.from(s.heights.baseOf(id) ?? s.opts.host.heights(id)!))
    expect(s.history.changes.length).toBe(changes)
    s.restoreEdits(hidden)
    for (const id of REGIONS) expect(Array.from(s.opts.host.heights(id)!)).toEqual(Array.from(heights.get(id)!))
    for (const id of REGIONS) expect(Array.from(s.paint.wordsFor(id) ?? [])).toEqual(words.get(id))
    expect(s.objects.current(tree)).toEqual(moved)
    expect(s.objects.current(add)).toMatchObject({ source: ROCK, position: [30, 4, -30] })
    expect(s.unsaved).toBe(unsaved)
    expect(s.history.changes.length).toBe(changes)
    // undo still walks the journal exactly after a round trip
    expect(s.undo()?.label).toBe('add')
    expect(s.objects.current(add)).toBeNull()
  })
})

describe('the Walkable brush (force open / force closed)', () => {
  /** One stamp of the walk brush at glTF (x, z), recorded as a change. */
  function walkStroke(s: EditSession, mode: WalkMode, x: number, z: number, radiusM = 6) {
    s.walk.begin(mode, radiusM)
    s.walk.stamp(x, z)
    const c = s.walk.end()
    return c ? s.record({ walk: c }, walkLabel(c), c.regions) : null
  }
  const code = (s: EditSession, x: number, z: number) => {
    const { TX, TZ } = s.walk.tileAt(x, z)
    return s.walk.at(TX, TZ)
  }
  const snapshot = (s: EditSession) => new Map(REGIONS.map(id => [id, Array.from(s.walk.codesOf(id) ?? [])]))

  it('marks 2 m tiles open, closed or auto; undo, redo and revert one are exact', () => {
    const { s } = setup()
    const a = walkStroke(s, 'open', 100, -100)!
    expect(a.label).toMatch(/^Opened ground for walking in 168,97 \(\d+ tiles\)$/)
    expect(a.walk!.regions).toEqual([regionIdOf(168, 97)])
    expect(code(s, 100, -100)).toBe(WE_WALK.open)
    expect(code(s, 104.5, -100.5)).toBe(WE_WALK.open)
    expect(code(s, 110.5, -100.5)).toBe(WE_WALK.auto)
    // the tile (50, 50) of region 168,97 holds the code (tz * 96 + tx)
    expect(s.walk.codesOf(regionIdOf(168, 97))![50 * 96 + 50]).toBe(WE_WALK.open)
    const P = [104.5, -100.5] as const, Q = [100.5, -100.5] as const
    const b = walkStroke(s, 'close', 104, -100, 2)!
    expect(b.walk!.keys.length).toBe(4)
    expect(code(s, ...P)).toBe(WE_WALK.closed)
    s.revertOne(a.id)
    // b's tiles keep b's code; a's others are auto again
    expect(code(s, ...P)).toBe(WE_WALK.closed)
    expect(code(s, ...Q)).toBe(WE_WALK.auto)
    s.undo() // undoes b (the newest in effect): a stays reverted under it
    expect(code(s, ...P)).toBe(WE_WALK.auto)
    expect(s.walk.touchedRegions()).toEqual([])
    s.redo()
    s.revertOne(a.id) // re-apply a under b
    expect(code(s, ...P)).toBe(WE_WALK.closed)
    expect(code(s, ...Q)).toBe(WE_WALK.open)
    s.undo()
    expect(code(s, ...P)).toBe(WE_WALK.open)
    // a whole undo / redo cycle lands on the same bytes
    const now = snapshot(s)
    s.undo()
    expect(s.walk.touchedRegions()).toEqual([])
    s.redo()
    expect(snapshot(s)).toEqual(now)
    // Auto gives the tiles back to the rule; a cancelled stroke leaves nothing
    walkStroke(s, 'auto', 100, -100, 60)
    expect(s.walk.touchedRegions()).toEqual([])
    s.walk.begin('open', 10)
    s.walk.stamp(300, -300)
    s.walk.cancel()
    expect(s.walk.touchedRegions()).toEqual([])
  })

  it('refuses the hard limits (objects, bounds) with a plain sentence and writes nothing there; force closed is never refused', () => {
    const { s } = setup()
    const objectsWest = new Uint8Array(96 * 96)
    for (let tz = 0; tz < 96; tz++) for (let tx = 0; tx < 10; tx++) objectsWest[tz * 96 + tx] = WALK_REFUSAL.object
    s.walk.guard = id => id === regionIdOf(168, 97) ? objectsWest : id === regionIdOf(170, 98) ? new Uint8Array(96 * 96).fill(WALK_REFUSAL.bounds) : null
    expect(walkStroke(s, 'open', 8, -100, 6)).toBeNull()
    expect(s.walk.refused.object).toBeGreaterThan(0)
    expect(s.walk.refused.bounds).toBe(0)
    expect(walkRefusalSentence(s.walk.refused)).toMatch(/can't be opened: \d+ under a building or object/)
    expect(code(s, 8, -100)).toBe(WE_WALK.auto)
    // the brush's edge reaches open ground: only those tiles change
    const c = walkStroke(s, 'open', 20, -100, 6)!
    expect(s.walk.refused.object).toBeGreaterThan(0)
    expect(code(s, 20, -100)).toBe(WE_WALK.open)
    expect(code(s, 18.5, -100.5)).toBe(WE_WALK.auto)
    expect(c.walk!.after.every(v => v === WE_WALK.open)).toBe(true)
    expect(walkStroke(s, 'close', 8, -100, 2)).not.toBeNull()
    expect(code(s, 8, -100)).toBe(WE_WALK.closed)
    // region 170,98 (glTF x 384..576, z -192..-384) lies outside the playable bounds here
    expect(walkStroke(s, 'open', 480, -288, 4)).toBeNull()
    expect(s.walk.refused).toMatchObject({ bounds: expect.any(Number), object: 0, sea: 0 })
    expect(walkRefusalSentence(s.walk.refused)).toMatch(/outside the playable area/)
  })

  it('Save writes walk/<x>_<z>.png (96 x 96 R8), load and the journal bring it back; revert region and the original map include it', async () => {
    const { s } = setup()
    walkStroke(s, 'open', 100, -100)
    walkStroke(s, 'close', 300, -100)
    const before = snapshot(s)
    const payload = await s.buildSave()
    const walkFiles = payload.layers.filter(l => l.kind === 'walk')
    expect(walkFiles.map(l => `${l.x},${l.z}`)).toEqual(['168,97', '169,97'])
    for (const l of walkFiles) {
      expect([l.width, l.height, l.channels, l.depth]).toEqual([96, 96, 1, 8])
      expect(Array.from(decodeWalkLayer(unpackPixels(l)).codes)).toEqual(Array.from(s.walk.layer((l.z << 8) | l.x)!.codes))
    }
    expect(payload.files['edits.json'].regions.map(r => r.layers)).toEqual([['walk'], ['walk']])
    expect(payload.files['edits.json'].counts).toMatchObject({ walk: 2 })

    const b = setup()
    b.s.load(JSON.parse(JSON.stringify(payload)))
    expect(snapshot(b.s)).toEqual(before)
    expect(b.s.history.changes.map(c => c.walk?.after instanceof Uint8Array)).toEqual([true, true])
    b.s.undo()
    expect(code(b.s, 300, -100)).toBe(WE_WALK.auto)
    expect(code(b.s, 100, -100)).toBe(WE_WALK.open)
    b.s.redo()
    expect(snapshot(b.s)).toEqual(before)

    // the layers the last Save wrote are deleted when their overrides go away
    s.markSaved(payload)
    s.undo()
    s.undo()
    const gone = await s.buildSave()
    expect(gone.layers.filter(l => l.kind === 'walk').map(l => l.pixels)).toEqual([null, null])
    s.redo()
    s.redo()

    const r = s.revertRegion(regionIdOf(168, 97))!
    expect(r.walk!.regions).toEqual([regionIdOf(168, 97)])
    expect(code(s, 100, -100)).toBe(WE_WALK.auto)
    expect(code(s, 300, -100)).toBe(WE_WALK.closed)
    s.undo()
    expect(snapshot(s)).toEqual(before)

    const hidden = s.hideEdits()
    expect(s.walk.touchedRegions()).toEqual([])
    s.restoreEdits(hidden)
    expect(snapshot(s)).toEqual(before)
  })
})
