/**
 * World edits (docs/WAVE_PLAN8.md §4.1, lane W12-P; docs/WORLD_EDITOR.md §3): the layer codecs (LA16 exact incl. 0),
 * the apply functions (pure, deterministic), the placement lowering (a move = drop + add, §F3; fresh editor uids,
 * §F5) and the validators.
 */
import { describe, expect, it } from 'vitest'
import { applyPlacementEdits } from '../../convert/src/world/passes.ts'
import type { WorldPlacement } from '../../convert/src/world/manifest.ts'
import {
  WE_EDITOR_UID_MIN, WE_GRASS, WE_GRID, WE_HEIGHT_MAX_M, WE_HEIGHT_MIN_M, WE_TILES, WE_WALK,
  applyHeightLayer, applyPaintLayer, applyRegionLayers, decodeGrassLayer, decodeHeightLayer, decodePaintLayer,
  decodeWalkLayer, emptyGrassLayer, emptyHeightLayer, emptyPaintLayer, emptyWalkLayer, encodeGrassLayer,
  encodeHeightLayer, encodePaintLayer, encodeWalkLayer, gltfToFile, grassMaskAt, heightCodeDelta, heightDeltaCode,
  lowerPlacementEdits, paintWord, paintWordTile, paintWordTiling, placementNavEdits, regionIdOf, regionOfPosition,
  snapHeightDelta, snapHeightLayer, validateGrassLayer, validateHeightLayer, validatePaintLayer, validateWalkLayer,
  validateWorldEditLights, validateWorldEditPlacements, validateWorldEditProbes, validateWorldEditWater,
  validateWorldEditZones, validateWorldEditsIndex, waterLevelsForRegion, worldEditLayerPath, yawRotation,
  type WorldEditPlacementsFile, type WorldEditsContext,
} from '../src/index.ts'

let seed = 7
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

describe('the height delta code (§F1: exact zero)', () => {
  it('L = 32768 + round(dh * 256); dh = (L - 32768) / 256', () => {
    expect(heightDeltaCode(0)).toBe(32768)
    expect(heightDeltaCode(1)).toBe(33024)
    expect(heightDeltaCode(-0.5)).toBe(32640)
    expect(heightDeltaCode(-1000)).toBe(0)
    expect(heightDeltaCode(1000)).toBe(0xffff)
    expect(heightCodeDelta(32768)).toBe(0)
    expect(WE_HEIGHT_MIN_M).toBe(-128)
    expect(WE_HEIGHT_MAX_M).toBeCloseTo(127.996, 3)
    expect(snapHeightDelta(0.001)).toBe(0)
    expect(snapHeightDelta(0.002)).toBe(1 / 256)
    expect(snapHeightDelta(14.2951)).toBe(Math.round(14.2951 * 256) / 256)
  })

  it('round-trips a layer exactly, zero included, and flips rows (row 0 = north)', () => {
    const layer = emptyHeightLayer()
    for (let i = 0; i < layer.delta.length; i++) {
      if (rnd() < 0.3) continue
      layer.mask[i] = 1
      const r = rnd()
      layer.delta[i] = r < 0.1 ? 0 : r < 0.12 ? WE_HEIGHT_MIN_M : r < 0.14 ? WE_HEIGHT_MAX_M : (rnd() - 0.5) * 60
    }
    snapHeightLayer(layer)
    const px = encodeHeightLayer(layer)
    expect(px.length).toBe(WE_GRID * WE_GRID * 2)
    const back = decodeHeightLayer(px)
    expect(Array.from(back.mask)).toEqual(Array.from(layer.mask))
    expect(Buffer.from(back.delta.buffer).equals(Buffer.from(layer.delta.buffer))).toBe(true)
    // A touched zero is exactly 0 (not +1.95 mm), and encodes as 32768.
    const z = Array.from(layer.mask).findIndex((m, i) => m && layer.delta[i] === 0)
    expect(z).toBeGreaterThanOrEqual(0)
    expect(Object.is(back.delta[z], 0)).toBe(true)
    // Vertex (gx 0, gz 96) is the north-west corner: pixel row 0, column 0.
    const one = emptyHeightLayer()
    one.mask[96 * WE_GRID] = 1
    one.delta[96 * WE_GRID] = 2
    const p1 = encodeHeightLayer(one)
    expect([p1[0], p1[1]]).toEqual([32768 + 512, 0xffff])
    expect(p1[(96 * WE_GRID) * 2 + 1]).toBe(0)
  })

  it('an untouched pixel decodes to 0 whatever its L', () => {
    const px = new Uint16Array(WE_GRID * WE_GRID * 2)
    px[0] = 40000
    const l = decodeHeightLayer(px)
    expect(l.mask.some(Boolean)).toBe(false)
    expect(l.delta.every(d => d === 0)).toBe(true)
    expect(() => decodeHeightLayer(new Uint16Array(10))).toThrow(/expected/)
  })
})

describe('paint, grass and walk codecs', () => {
  it('paint: R = id & 0xff, G = (id >> 8) | tiling << 2, A = painted; words round-trip', () => {
    expect(paintWord(0x2ab, 5)).toBe(0x2ab | (5 << 13))
    expect(paintWordTile(paintWord(0x2ab, 5))).toBe(0x2ab)
    expect(paintWordTiling(paintWord(0x2ab, 5))).toBe(5)
    const layer = emptyPaintLayer()
    const g = 96 * WE_GRID + 3
    layer.mask[g] = 1
    layer.words[g] = paintWord(0x2ab, 5)
    for (let i = 0; i < 500; i++) {
      const k = Math.floor(rnd() * layer.words.length)
      layer.mask[k] = 1
      layer.words[k] = paintWord(Math.floor(rnd() * 1024), Math.floor(rnd() * 8))
    }
    const px = encodePaintLayer(layer)
    expect([px[12], px[13], px[14], px[15]]).toEqual([0xab, 2 | (5 << 2), 0, 255])
    const back = decodePaintLayer(px)
    expect(Array.from(back.mask)).toEqual(Array.from(layer.mask))
    expect(Array.from(back.words)).toEqual(Array.from(layer.words))
  })

  it('grass: 192 x 192, untouched = density 128; walk: 96 x 96 codes, rows flipped', () => {
    const grass = emptyGrassLayer()
    const t = 191 * WE_GRASS + 5
    grass.mask[t] = 1
    grass.density[t] = 64
    grass.flowers[t] = 200
    grass.kind[t] = 3
    const gpx = encodeGrassLayer(grass)
    expect([gpx[20], gpx[21], gpx[22], gpx[23]]).toEqual([64, 200, 3, 255])
    expect([gpx[24], gpx[27]]).toEqual([128, 0])
    const gb = decodeGrassLayer(gpx)
    for (const k of ['density', 'flowers', 'kind', 'mask'] as const) expect(Array.from(gb[k])).toEqual(Array.from(grass[k]))
    expect(grassMaskAt(gb, 5.5, 191.2)).toEqual({ density: 0.5, flowers: 200 / 255, kind: 3 })
    expect(grassMaskAt(gb, 6, 191)).toEqual({ density: 1, flowers: 0, kind: 0 })
    expect(grassMaskAt(null, 6, 191).density).toBe(1)

    const walk = emptyWalkLayer()
    walk.codes[95 * WE_TILES + 1] = WE_WALK.open
    walk.codes[2] = WE_WALK.closed
    const wpx = encodeWalkLayer(walk)
    expect(wpx[1]).toBe(1)
    expect(wpx[95 * WE_TILES + 2]).toBe(2)
    expect(Array.from(decodeWalkLayer(wpx).codes)).toEqual(Array.from(walk.codes))
    expect(worldEditLayerPath('walk', 171, 97)).toBe('walk/171_97.png')
  })
})

describe('apply (pure, deterministic)', () => {
  const base = Float32Array.from({ length: WE_GRID * WE_GRID }, (_, i) => 10 + Math.sin(i) * 3.3)
  const words = Uint16Array.from({ length: WE_GRID * WE_GRID }, (_, i) => paintWord(i % 7, 1))
  const layer = () => {
    const l = emptyHeightLayer()
    for (let i = 0; i < 3000; i++) {
      const k = (i * 7919) % l.delta.length
      l.mask[k] = 1
      l.delta[k] = (i % 50) - 20.37
    }
    return snapHeightLayer(l)
  }

  it('heights: base + snapped delta in float32 where touched, the rest bit-identical; inputs untouched', () => {
    const l = layer()
    const baseCopy = Float32Array.from(base)
    const a = applyHeightLayer(base, l)
    const b = applyHeightLayer(base, decodeHeightLayer(encodeHeightLayer(l)))
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true)
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(l.mask[i] ? Math.fround(base[i]! + l.delta[i]!) : base[i])
    expect(Buffer.from(base.buffer).equals(Buffer.from(baseCopy.buffer))).toBe(true)
    // Undo is a subtraction: base + d - d restores every vertex whose sum is exact (the 1/256 grid on a 1/256 base).
    const gridBase = Float32Array.from(base, h => Math.round(h * 256) / 256)
    const up = applyHeightLayer(gridBase, l)
    const neg = { delta: l.delta.map(d => -d), mask: l.mask }
    expect(Array.from(applyHeightLayer(up, neg))).toEqual(Array.from(gridBase))
  })

  it('paint and region layers; an empty layer changes nothing', () => {
    const p = emptyPaintLayer()
    p.mask[100] = 1
    p.words[100] = paintWord(42, 3)
    const out = applyPaintLayer(words, p)
    expect(out[100]).toBe(paintWord(42, 3))
    expect(out[101]).toBe(words[101])
    expect(applyRegionLayers({ heights: base, textures: words }, { height: emptyHeightLayer(), paint: emptyPaintLayer() }).changed).toBe(false)
    expect(applyRegionLayers({ heights: base, textures: words }, { paint: p }).changed).toBe(true)
    expect(() => applyRegionLayers({ heights: new Float32Array(3), textures: words }, {})).toThrow(/97 x 97/)
  })

  it('water levels per region: NaN where unset, later rows win', () => {
    const lv = waterLevelsForRegion([
      { id: 'w1', region: 25003, blocks: [[0, 0], [5, 5]], heightM: 3 },
      { id: 'w2', region: 25003, blocks: [[5, 5]], heightM: 4 },
      { id: 'w3', region: 1, blocks: [[1, 1]], heightM: 9 },
    ], 25003)
    expect(lv[0]).toBe(3)
    expect(lv[35]).toBe(4)
    expect(Number.isNaN(lv[7]!)).toBe(true)
  })

  it('space: owner region, file space, yaw rotation', () => {
    const origin = { x: 168, z: 96 }
    expect(regionOfPosition([600, 0, -150], origin)).toBe(regionIdOf(171, 96))
    expect(regionOfPosition([590.4, 2, -200], origin)).toBe(regionIdOf(171, 97))
    expect(gltfToFile([1, 2, -3], origin)).toEqual([1920 * 168 + 10, 20, 1920 * 96 + 30])
    const q = yawRotation(0.698132)
    expect(q[1]).toBeCloseTo(Math.sin(0.349066), 12)
    expect(q[3]).toBeCloseTo(Math.cos(0.349066), 12)
  })
})

// --- placements -------------------------------------------------------------------------------------------------------

const ORIGIN = { x: 168, z: 97 }
const R171_97 = regionIdOf(171, 97)
const R172_97 = regionIdOf(172, 97)
const TREE = 'res\\nature\\common\\tree\\tre_tree01.bsr'
const STONE = 'res\\nature\\common\\stone_field03.bsr'

function placement(region: number, uid: number, source: string, position: [number, number, number], yaw = 0): WorldPlacement {
  return {
    objId: source === TREE ? 11 : 12, source, models: [source === TREE ? 0 : 1], compound: false, position, rotation: yawRotation(yaw), yaw,
    flags: { static: true, big: false, struct: false }, staticFlag: 0xffff, uid, region, group: 3,
  } as WorldPlacement
}

const placements = (): WorldPlacement[] => [
  placement(R171_97, 32770, TREE, [590.41, 2.08, -150.32]),
  placement(R171_97, 33794, TREE, [600, 3, -160]),
  placement(R171_97, 34818, STONE, [610, 3, -170], 1),
  placement(R172_97, 32770, TREE, [800, 4, -150]),
]

const file = (over: Partial<WorldEditPlacementsFile> = {}): WorldEditPlacementsFile => ({
  format: 'sro-world-edits-placements', version: 1, world: 'jangan-fields',
  move: [{ region: R171_97, uid: 32770, source: TREE, from: { position: [590.41, 2.08, -150.32], yaw: 0 }, to: { position: [621.9236, 4.0306, -138.1684], yaw: 0.698132, scale: 1.1 } }],
  drop: [{ region: R171_97, uid: 33794, source: TREE, from: { position: [600, 3, -160], yaw: 0 } }],
  add: [{ id: 'ed-1', source: STONE, position: [650.2, 6.1, -140], yaw: 1.2, scale: 1.2 }],
  ...over,
})

const create = (a: { source: string; position: [number, number, number]; yaw: number; scale?: number }, region: number, uid: number): WorldPlacement | null =>
  a.source === STONE || a.source === TREE
    ? { ...placement(region, uid, a.source, [...a.position]), rotation: yawRotation(a.yaw), yaw: a.yaw, ...(a.scale !== undefined && a.scale !== 1 ? { scale: a.scale } : {}) } as WorldPlacement
    : null

describe('lowerPlacementEdits (§F3: a move = drop + add of the same key)', () => {
  it('lowers move, drop and add; the converter applies them without a warning', () => {
    const before = placements()
    const snapshot = JSON.stringify(before)
    const low = lowerPlacementEdits(before, file(), { originRegion: ORIGIN, create })
    expect(low.problems).toEqual([])
    expect(low.drop).toEqual([{ region: R171_97, uid: 33794 }, { region: R171_97, uid: 32770 }])
    expect(low.add.map(p => [p.region, p.uid, p.source])).toEqual([[R171_97, 32770, TREE], [R171_97, WE_EDITOR_UID_MIN, STONE]])
    const moved = low.add[0]! as WorldPlacement & { scale?: number }
    expect(moved.position).toEqual([621.9236, 4.0306, -138.1684])
    expect(moved.yaw).toBe(0.698132)
    expect(moved.rotation).toEqual(yawRotation(0.698132))
    expect(moved.scale).toBe(1.1)
    expect(moved.objId).toBe(11)
    expect(low.assigned).toEqual([
      { kind: 'move', key: `${R171_97}:32770`, region: R171_97, uid: 32770 },
      { kind: 'add', key: 'ed-1', region: R171_97, uid: WE_EDITOR_UID_MIN },
    ])
    const warnings: string[] = []
    const applied = applyPlacementEdits(before, { drop: low.drop, resnap: [], add: low.add }, 2, warnings, 'edits')
    expect(warnings).toEqual([])
    expect(applied.placements.length).toBe(4)
    expect(applied.placements.find(p => p.region === R171_97 && p.uid === 32770)!.position).toEqual([621.9236, 4.0306, -138.1684])
    expect(applied.placements.some(p => p.uid === 33794)).toBe(false)
    expect(JSON.stringify(before)).toBe(snapshot)
    // Deterministic.
    expect(JSON.stringify(lowerPlacementEdits(placements(), file(), { originRegion: ORIGIN, create }))).toBe(JSON.stringify(low))
  })

  it('a move out of its region takes a fresh editor uid in the new owner (§F5); stored uids are kept', () => {
    const f = file({
      drop: [],
      move: [{ region: R171_97, uid: 32770, source: TREE, from: { position: [590.41, 2.08, -150.32], yaw: 0 }, to: { position: [790, 4, -150], yaw: 0 } }],
      add: [
        { id: 'ed-1', source: STONE, position: [795, 4, -140], yaw: 0, region: R172_97, uid: 0xe000 },
        { id: 'ed-2', source: STONE, position: [796, 4, -140], yaw: 0 },
      ],
    })
    const low = lowerPlacementEdits(placements(), f, { originRegion: ORIGIN, create, rehome: p => ({ ...p, group: 2 }) })
    expect(low.problems).toEqual([])
    expect(low.assigned.map(a => [a.key, a.region, a.uid])).toEqual([
      [`${R171_97}:32770`, R172_97, 0xe001], ['ed-1', R172_97, 0xe000], ['ed-2', R172_97, 0xe002],
    ])
    expect(low.add[0]!.group).toBe(2)
    // The retail uid 32770 of region 172_97 is untouched.
    const applied = applyPlacementEdits(placements(), { drop: low.drop, resnap: [], add: low.add }, 2, [], 'edits')
    expect(applied.placements.filter(p => p.region === R172_97).map(p => p.uid).sort()).toEqual([32770, 0xe000, 0xe001, 0xe002])
  })

  it('refuses (and skips) an unknown key, a changed source, a moved origin, a taken or out-of-range uid, an unknown model', () => {
    const f = file({
      move: [
        { region: R171_97, uid: 1, source: TREE, from: { position: [0, 0, 0], yaw: 0 }, to: { position: [600, 3, -150], yaw: 0 } },
        { region: R171_97, uid: 34818, source: TREE, from: { position: [610, 3, -170], yaw: 1 }, to: { position: [600, 3, -150], yaw: 0 } },
      ],
      drop: [{ region: R171_97, uid: 33794, source: TREE, from: { position: [600, 3, -159], yaw: 0 } }],
      add: [
        { id: 'ed-1', source: STONE, position: [650, 6, -140], yaw: 0, uid: 0x1234 },
        { id: 'ed-2', source: 'res\\nope.bsr', position: [650, 6, -140], yaw: 0 },
        { id: 'ed-3', source: STONE, position: [650, 6, -140], yaw: 0, region: R172_97 },
      ],
    })
    const low = lowerPlacementEdits(placements(), f, { originRegion: ORIGIN, create })
    expect(low.drop).toEqual([])
    expect(low.add).toEqual([])
    expect(low.problems).toEqual([
      `drop ${R171_97}:33794: the object moved under the edit (1.000 m)`,
      `move ${R171_97}:1: unknown placement`,
      `move ${R171_97}:34818: the object changed under the edit (source ${STONE})`,
      `add ed-3: region ${R172_97} is not the owner of its position (${R171_97})`,
      'add ed-1: uid 4660 is outside the editor range 0xE000-0xEFFF',
      'add ed-2: unknown model source',
    ])
  })

  it('placementNavEdits: footprints only; a move inside its region replaces its id; ids regionId << 16 | uid', () => {
    const before = placements()
    const low = lowerPlacementEdits(before, file(), { originRegion: ORIGIN, create })
    const nav = placementNavEdits(before, low, { originRegion: ORIGIN, footprint: p => p.source === TREE })
    const id = (r: number, u: number) => ((r << 16) | u) >>> 0
    expect(nav.remove).toEqual([id(R171_97, 33794), id(R171_97, 32770)])
    expect(nav.put).toEqual([{ id: id(R171_97, 32770), objId: 11, source: TREE, ...xyz(gltfToFile([621.9236, 4.0306, -138.1684], ORIGIN)), yaw: 0.698132 }])
  })
})

const xyz = (v: [number, number, number]) => ({ x: v[0], y: v[1], z: v[2] })

// --- validators -------------------------------------------------------------------------------------------------------

const exported = (rx: number, rz: number) => rx >= 170 && rx <= 172 && rz >= 96 && rz <= 98
const ctx = (): WorldEditsContext => ({
  world: 'jangan-fields',
  originRegion: ORIGIN,
  exported,
  placement: (region, uid) => {
    const p = placements().find(q => q.region === region && q.uid === uid)
    return p && { source: p.source, position: p.position, yaw: p.yaw, links: uid === 34818 && region === R172_97 }
  },
  modelKind: s => (s === TREE ? 'tree' : s === STONE ? 'prop' : s === 'res\\gate.bsr' ? 'blocker' : undefined),
  tile: id => id < 108,
  sound: k => k === 'birds',
  flowerKinds: 4,
})

describe('validators', () => {
  it('edits.json', () => {
    const ok = { format: 'sro-world-edits', version: 1, world: 'jangan-fields', regions: [{ x: 171, z: 97, base: 'a'.repeat(64), layers: ['height', 'paint'] }] }
    expect(validateWorldEditsIndex(ok, ctx())).toEqual({ ok: true, problems: [] })
    const bad = validateWorldEditsIndex({ ...ok, world: 'jangan', regions: [{ x: 171, z: 97, base: 'xyz', layers: ['height', 'sky'] }, { x: 10, z: 97, base: 'a'.repeat(64), layers: ['walk'] }] }, ctx())
    expect(bad.ok).toBe(false)
    expect(bad.problems).toEqual([
      "edits.world: expected 'jangan-fields'",
      'edits.regions[0].base: expected the SHA-256 (hex) of the base heights',
      'edits.regions[0].layers: unknown layer kind sky',
      'edits.regions[1]: region 10_97 is not in the export',
    ])
  })

  it('placements.json: a good file passes', () => {
    expect(validateWorldEditPlacements(file(), ctx())).toEqual({ ok: true, problems: [] })
    expect(validateWorldEditPlacements(file()).ok).toBe(true)
  })

  it('placements.json: a uid outside 0xE000-0xEFFF, an unknown key, a dressing uid, a linked piece, scales, owners', () => {
    const r = validateWorldEditPlacements(file({
      move: [
        { region: R171_97, uid: 32770, source: TREE, from: { position: [590.41, 2.08, -150.32], yaw: 0 }, to: { position: [621, 4, -138], yaw: 0, scale: 1.2 } },
        { region: R172_97, uid: 34818, source: STONE, from: { position: [0, 0, 0], yaw: 0 }, to: { position: [800, 4, -150], yaw: 0 } },
        { region: R171_97, uid: 34818, source: STONE, from: { position: [610, 3, -170], yaw: 1 }, to: { position: [790, 4, -150], yaw: 0, uid: 0xd000 } },
      ],
      drop: [
        { region: R171_97, uid: 1_000_004, source: STONE, from: { position: [0, 0, 0], yaw: 0 } },
        { region: R171_97, uid: 4242, source: STONE, from: { position: [0, 0, 0], yaw: 0 } },
      ],
      add: [
        { id: 'ed-1', source: STONE, position: [650, 6, -140], yaw: 0, uid: 0xf000 },
        { id: 'ed-2', source: STONE, position: [650, 6, -140], yaw: 0, scale: 2.5 },
        { id: 'ed-3', source: 'res\\gate.bsr', position: [650, 6, -140], yaw: 0, scale: 1.1 },
        { id: 'ed-3', source: 'res\\nope.bsr', position: [650, 6, -140], yaw: 0, region: R172_97 },
        { id: 'ed-5', source: STONE, position: [-500, 6, -140], yaw: 0 },
        { id: 'ed-6', source: STONE, position: [795, 6, -140], yaw: 0, uid: 0xe000 },
        { id: 'ed-7', source: STONE, position: [796, 6, -140], yaw: 0, uid: 0xe000 },
      ],
    }), {
      ...ctx(),
      placement: (region, uid) => {
        if (region === R172_97 && uid === 34818) return { source: STONE, position: [0, 0, 0], yaw: 0, links: true }
        return ctx().placement!(region, uid)
      },
    })
    expect(r.ok).toBe(false)
    expect(r.problems).toEqual([
      'placements.drop[0].uid: not a retail uid (town dressing props are edited by row id)',
      `placements.drop[1]: unknown placement ${R171_97}:4242`,
      'placements.move[0].to.scale: a tree scales 0.85-1.15',
      `placements.move[1]: placement ${R172_97}:34818 is joined to its neighbours (a bridge piece) and can't be moved on its own`,
      'placements.move[2].to.uid: outside the editor range 0xE000-0xEFFF',
      'placements.add[0].uid: outside the editor range 0xE000-0xEFFF',
      'placements.add[1].scale: a prop scales 0.5-2',
      'placements.add[2].scale: buildings and other walk blockers are never scaled',
      'placements.add[3].id: duplicate id ed-3',
      'placements.add[3].source: unknown model res\\nope.bsr',
      `placements.add[3].region: the position's owner region is ${R171_97}`,
      'placements.add[4].position: outside the exported regions',
      `placements.add[6].uid: editor uid 57344 used twice in region ${R172_97}`,
    ])
  })

  it('height layer: rejects a delta outside the export edge, off the grid or on an untouched vertex', () => {
    const l = emptyHeightLayer()
    l.mask[50 * WE_GRID + 50] = 1
    l.delta[50 * WE_GRID + 50] = 3.5
    expect(validateHeightLayer(171, 97, l, ctx()).ok).toBe(true)
    expect(validateHeightLayer(160, 97, l, ctx()).problems).toEqual(['height/160_97: region 160_97 is not in the export (no layer exists outside it)'])
    // 170_97: its west neighbour 169_97 is not exported, so column gx 0 must stay 0; 171_97's west side is inside.
    const edge = emptyHeightLayer()
    edge.mask[40 * WE_GRID] = 1
    edge.delta[40 * WE_GRID] = 1
    expect(validateHeightLayer(171, 97, edge, ctx()).ok).toBe(true)
    expect(validateHeightLayer(170, 97, edge, ctx()).problems).toEqual(['height/170_97: 1 delta(s) outside the export edge (the outermost vertices must stay 0)'])
    const bad = emptyHeightLayer()
    bad.mask[1] = 1
    bad.delta[1] = 0.001
    bad.delta[2] = 1
    expect(validateHeightLayer(171, 97, bad, ctx()).problems).toEqual([
      'height/171_97: 1 delta(s) off the 1/256 m grid',
      'height/171_97: 1 untouched vertex(es) carry a delta',
    ])
  })

  it('paint, grass and walk layers', () => {
    const p = emptyPaintLayer()
    p.mask[3] = 1
    p.words[3] = paintWord(200, 1)
    p.mask[4] = 1
    p.words[4] = 0x0400 | 5
    expect(validatePaintLayer(171, 97, p, ctx()).problems).toEqual([
      'paint/171_97: 1 word(s) set the reserved bits 10-12',
      'paint/171_97: unknown tile id(s) 200',
    ])
    const g = emptyGrassLayer()
    g.mask[0] = 1
    g.flowers[0] = 10
    g.kind[0] = 9
    expect(validateGrassLayer(171, 97, g, ctx()).problems).toEqual(['grass/171_97: 1 texel(s) name a flower kind >= 4'])
    const w = emptyWalkLayer()
    w.codes[5] = 3
    expect(validateWalkLayer(171, 97, w, ctx()).problems).toEqual(['walk/171_97: 1 tile(s) with an unknown code (0 auto, 1 open, 2 closed)'])
    w.codes[5] = WE_WALK.closed
    expect(validateWalkLayer(171, 97, w, ctx()).ok).toBe(true)
  })

  it('water, lights, zones, probes', () => {
    expect(validateWorldEditWater([{ id: 'w1', region: R171_97, blocks: [[0, 0], [5, 5]], heightM: 3 }], ctx()).ok).toBe(true)
    expect(validateWorldEditWater([{ id: 'w1', region: regionIdOf(10, 10), blocks: [[6, 0], [1, 1], [1, 1]], heightM: 'x' }], ctx()).problems).toEqual([
      'water[0].region: not in the export',
      'water[0].heightM: expected a water level (m)',
      'water[0].blocks[0]: expected [bx, bz] in 0..5',
      'water[0].blocks[2]: block set twice',
    ])
    expect(validateWorldEditLights([{ id: 'l1', x: 1, y: 2, z: 3, kind: 'lantern', colour: [1, 0.8, 0.5], intensity: 2, radiusM: 8 }]).ok).toBe(true)
    expect(validateWorldEditLights([{ id: 'l1', x: 1, y: 2, z: 3, kind: 'neon', colour: [2, 0, 0], intensity: 2, radiusM: 80 }]).problems).toEqual([
      'lights[0].kind: expected one of lamp, lantern, fire',
      'lights[0].colour: expected [r, g, b] in 0..1',
      'lights[0].radiusM: expected 0.5..60 m',
    ])
    const zone = { id: 'z1', name: 'Pond', shape: { circle: { x: 600, z: -150, r: 20 } }, sound: 'birds', gainDb: -6, fadeM: 10, when: 'day' }
    expect(validateWorldEditZones([zone, { ...zone, id: 'z2', shape: { poly: [[0, 0], [10, 0], [0, 10]] } }], ctx()).ok).toBe(true)
    expect(validateWorldEditZones([{ ...zone, shape: { poly: [[0, 0]] }, sound: 'jazz', when: 'dusk' }, zone], ctx()).problems).toEqual([
      'zones[0].shape.poly: expected at least 3 [x, z] points',
      'zones[0].sound: unknown sound jazz',
      'zones[0].when: expected one of day, night, always',
      'zones[1].id: duplicate id z1',
    ])
    expect(validateWorldEditProbes([{ id: 'spawn', name: 'Town spawn', x: 600, z: -150 }], ctx()).ok).toBe(true)
    expect(validateWorldEditProbes([{ id: 'far', name: 'Far', x: -5000, z: -150 }, { id: 'n', x: 1 }], ctx()).problems).toEqual([
      'probes[0]: outside the exported regions',
      'probes[1].name: expected a name',
      'probes[1]: expected x, z (and an optional y)',
    ])
  })
})
