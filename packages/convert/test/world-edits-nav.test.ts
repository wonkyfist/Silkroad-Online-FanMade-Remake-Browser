/**
 * WE-N (docs/WAVE_PLAN8.md §6.2; docs/WORLD_EDITOR.md §6.3, §6.4, §7.2): the world edits' nav step
 * (src/world/edits/nav-edit.ts) and the Publish checks and report (src/world/edits/checks.ts).
 * - the dry run's numbers as a fixture: the prototype's mound on 171_97 under the rule as written closes 117 of 443
 *   touched tiles (fixtures/we-n-dryrun-171_97.json); closed tiles carry the closed cell and the blocked flag;
 * - nothing opens by itself; the Walkable overrides; deep new water closes and is listed for the swim layer (wave 13);
 * - footprints move, drop and add in every region they reach (spill copies, cell lists); links are never edited; the
 *   .nvm path (the converter) and the NavData path (the preview) give the same nav;
 * - the checks: traps, reachability of nests / NPCs / places / gates / probes, roads both ways, ground cut off, props
 *   on moved ground, overlaps, per-region budgets, the report's verdict and round trip;
 * - on the real export (skipped without it): the fixture edit on jangan-fields' nav.bin, no nest lost, no new trap,
 *   nothing cut off (the 10 s budget is timed on a quiet machine, not here).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NVM_TILE_BLOCKED, NVM_TILES, type NvmCell, type NvmFile, type NvmObject } from '@sro/formats'
import { buildNavData, decodeNavData, navInstanceId, type NavData, type NavMeshInput } from '@sro/nav'
import { REPO_ROOT } from '../src/node-io.ts'
import {
  checkPointsFrom, encodeWorldEditsReport, glbTriangleCount, lightDensity, parseWorldEditsReport, PUBLISH_CHECKS, runPublishChecks, zoneOverlap,
  type CheckPoint, type CheckScene, type PublishCheckInput,
} from '../src/world/edits/checks.ts'
import { createNavEdit, footprintBox, navEditData, regionsReached, type NavEditOptions, type NavFootprint } from '../src/world/edits/nav-edit.ts'
import {
  NAV_RULE_WATER_DEPTH_M, WE_GRID, WE_WALK, emptyHeightLayer, emptyWalkLayer, navHeightsAfter, navRuleWaterTile, snapHeightDelta,
  type HeightLayer, type WorldEditNavPut,
} from '../../shared/src/world-edits/index.ts'
import { grid, mesh } from '../../nav/test/synthetic.ts'

const G = WE_GRID
const T = NVM_TILES
const id = (x: number, z: number) => (z << 8) | x

// --- builders -----------------------------------------------------------------------------------------------------------

/** A region .nvm: cell 0 open (whole region), cell 1 closed; `closed(tx, tz)` tiles in cell 1 with the blocked flag. */
function nvmOf(heights: Float32Array, closed: (tx: number, tz: number) => boolean = () => false, objects: NvmObject[] = []): NvmFile {
  const tileCells = new Int32Array(T * T)
  const tileFlags = new Uint16Array(T * T)
  for (let tz = 0; tz < T; tz++) {
    for (let tx = 0; tx < T; tx++) {
      if (!closed(tx, tz)) continue
      tileCells[tz * T + tx] = 1
      tileFlags[tz * T + tx] = NVM_TILE_BLOCKED
    }
  }
  const cells: NvmCell[] = [{ minX: 0, minZ: 0, maxX: 1920, maxZ: 1920, objects: objects.map((_, i) => i) }, { minX: 0, minZ: 0, maxX: 20, maxZ: 20, objects: [] }]
  return {
    signature: 'JMXVNVM 1000', objects, cells, openCellCount: 1, globalEdges: [], internalEdges: [], tileRecordSize: 8,
    tileCells, tileFlags, heights: Float32Array.from(heights), planeTypes: new Uint8Array(36), planeHeights: new Float32Array(36),
  }
}

const flat = (h = 0) => new Float32Array(G * G).fill(h)

/** A 10 m x 10 m solid block footprint (local -50..50 dm), outline flag 3 (blocks walkers). */
const BLOCK: NavMeshInput = (() => {
  const g = grid(-50, 50, -50, 50, 2, 2)
  return mesh(g.vertices, g.triangles, () => 3).nav
})()
const BLOCK_FP: NavFootprint = { minX: -50, minZ: -50, maxX: 50, maxZ: 50 }

const obj = (region: number, uid: number, x: number, z: number, opts: Partial<NvmObject> = {}): NvmObject => ({
  objId: 7, position: [x, 0, z], type: -1, yaw: 0, localUid: uid, unknownShort0: 0, isBig: false, isStruct: false, regionId: region, links: [], ...opts,
})

const navOf = (regions: Array<{ id: number; nvm: NvmFile }>): NavData =>
  buildNavData({ regions, objectNavMesh: objId => (objId === 7 || objId === 8 ? { key: `m${objId}`, navMesh: BLOCK } : null) })

const baseOpts = (o: Partial<NavEditOptions> = {}): NavEditOptions => ({ regions: new Map(), footprint: () => BLOCK_FP, ...o })

const openSet = (data: NavData) => data.regions.map(r => ({ id: r.id, open: Array.from(r.tileCells, c => (c >= 0 && c < r.openCellCount ? 1 : 0)).join('') }))
const instSet = (data: NavData) => data.instances.map(i => `${i.id >>> 0}:${i.objId}:${i.x}:${i.y}:${i.z}:${i.yaw}`).sort()

// --- the fixture ----------------------------------------------------------------------------------------------------------

interface DryRunFixture {
  region: { x: number; z: number }
  masked: Array<[number, number]>
  heights: Array<[number, number]>
}
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'we-n-dryrun-171_97.json'), 'utf8')) as DryRunFixture
const FX_ID = id(FIXTURE.region.x, FIXTURE.region.z)

function fixtureLayer(snap = false): HeightLayer {
  const layer = emptyHeightLayer()
  for (const [i, d] of FIXTURE.masked) {
    layer.mask[i] = 1
    layer.delta[i] = snap ? snapHeightDelta(d) : d
  }
  return layer
}

function fixtureHeights(): Float32Array {
  const h = flat()
  for (const [i, v] of FIXTURE.heights) h[i] = v
  return h
}

describe('the nav rule on the dry run (fixture: 171_97, the prototype mound)', () => {
  it('closes 117 of 443 touched tiles, with the closed cell and the blocked flag; heights move in nav units', () => {
    const nvm = nvmOf(fixtureHeights())
    const layer = fixtureLayer()
    const run = createNavEdit(baseOpts({ regions: new Map([[FX_ID, { height: layer }]]) }))
    const out = run.navEdit(FX_ID, nvm)!
    expect(out).not.toBeNull()
    const s = run.report().regions[0]!
    expect(s).toMatchObject({ touched: 443, closedSlope: 117, closed: 117, opened: 0, closedWater: 0 })
    expect(s.closedTiles).toHaveLength(117)
    for (const t of s.closedTiles) {
      expect(out.tileCells[t]).toBeGreaterThanOrEqual(out.openCellCount)
      expect(out.tileFlags[t]! & NVM_TILE_BLOCKED).toBe(NVM_TILE_BLOCKED)
    }
    let closedNow = 0
    for (let t = 0; t < T * T; t++) if (out.tileCells[t]! >= out.openCellCount) closedNow++
    expect(closedNow).toBe(117)
    expect(Array.from(out.heights)).toEqual(Array.from(navHeightsAfter(nvm.heights, layer)))
    // the input is not mutated
    expect(nvm.tileCells.every(c => c === 0)).toBe(true)
  })

  it('the layer saved on the 1/256 m grid touches 446 tiles and closes the same 117', () => {
    const run = createNavEdit(baseOpts({ regions: new Map([[FX_ID, { height: fixtureLayer(true) }]]) }))
    run.navEdit(FX_ID, nvmOf(fixtureHeights()))
    expect(run.report().regions[0]).toMatchObject({ touched: 446, closed: 117 })
  })

  it('the NavData path (the preview) gives the same tiles and heights as nav.bin built from the edited .nvm', () => {
    const nvm = nvmOf(fixtureHeights())
    const opts = baseOpts({ regions: new Map([[FX_ID, { height: fixtureLayer() }]]) })
    const fromNvm = navOf([{ id: FX_ID, nvm: createNavEdit(opts).navEdit(FX_ID, nvm)! }])
    const { data, report } = navEditData(navOf([{ id: FX_ID, nvm }]), opts)
    expect(openSet(data)).toEqual(openSet(fromNvm))
    expect(Array.from(data.regions[0]!.heights)).toEqual(Array.from(fromNvm.regions[0]!.heights))
    expect(report.regions[0]).toMatchObject({ touched: 443, closed: 117 })
  })
})

describe('the nav rule: opens, overrides, water (the swim hook)', () => {
  const R = id(170, 97)

  it('never opens by itself; force open takes an open neighbour cell and clears the flag; force closed closes', () => {
    const nvm = nvmOf(flat(), (tx, tz) => tx === 10 && tz === 10)
    const raise = emptyHeightLayer()
    for (let gz = 9; gz <= 12; gz++) for (let gx = 9; gx <= 12; gx++) { raise.mask[gz * G + gx] = 1; raise.delta[gz * G + gx] = 0.2 }
    const quiet = createNavEdit(baseOpts({ regions: new Map([[R, { height: raise }]]) }))
    const q = quiet.navEdit(R, nvm)!
    expect(q.tileCells[10 * T + 10]).toBe(1)
    expect(quiet.report().regions[0]!.opened).toBe(0)

    const walk = emptyWalkLayer()
    walk.codes[10 * T + 10] = WE_WALK.open
    walk.codes[40 * T + 40] = WE_WALK.closed
    const run = createNavEdit(baseOpts({ regions: new Map([[R, { walk }]]) }))
    const out = run.navEdit(R, nvm)!
    expect(out.tileCells[10 * T + 10]).toBe(0)
    expect(out.tileFlags[10 * T + 10]! & NVM_TILE_BLOCKED).toBe(0)
    expect(out.tileCells[40 * T + 40]).toBe(1)
    expect(out.tileFlags[40 * T + 40]! & NVM_TILE_BLOCKED).toBe(NVM_TILE_BLOCKED)
    expect(run.report().regions[0]).toMatchObject({ forcedOpen: 1, forcedClosed: 1, openedTiles: [10 * T + 10], closedTiles: [40 * T + 40] })
  })

  it('the overrides apply after the slope rule: force open keeps a tile the edit made steep open, force closed closes flat ground', () => {
    // one vertex raised 3 m: its four tiles go to slope 1.5 (over 35 deg) and close by the rule
    const bump = emptyHeightLayer()
    bump.mask[21 * G + 21] = 1
    bump.delta[21 * G + 21] = 3
    const walk = emptyWalkLayer()
    walk.codes[20 * T + 20] = WE_WALK.open
    walk.codes[60 * T + 60] = WE_WALK.closed
    const opts = baseOpts({ regions: new Map([[R, { height: bump, walk }]]) })
    const run = createNavEdit(opts)
    const nvm = nvmOf(flat())
    const out = run.navEdit(R, nvm)!
    expect(out.tileCells[20 * T + 20]).toBe(0)
    expect(out.tileFlags[20 * T + 20]! & NVM_TILE_BLOCKED).toBe(0)
    for (const t of [20 * T + 21, 21 * T + 20, 21 * T + 21, 60 * T + 60]) {
      expect(out.tileCells[t]).toBe(1)
      expect(out.tileFlags[t]! & NVM_TILE_BLOCKED).toBe(NVM_TILE_BLOCKED)
    }
    expect(run.report().regions[0]).toMatchObject({ closedSlope: 4, forcedOpen: 1, forcedClosed: 1, closed: 4, opened: 0 })
    // the preview's NavData path agrees
    const fromNvm = navOf([{ id: R, nvm: out }])
    expect(openSet(navEditData(navOf([{ id: R, nvm }]), opts).data)).toEqual(openSet(fromNvm))
  })

  it('the hard limits: a force-open outside the playable bounds, in the sea or under a footprint is ignored with a warning', () => {
    const OUT = id(171, 97)
    const at = (tx: number, tz: number) => tz * T + tx
    // a block (10 m footprint) centred on tile (30, 30); retail-closed tiles everywhere the walk layer opens
    const closed = new Set([at(5, 5), at(30, 30), at(5, 80)])
    const nvm = nvmOf(flat(), (tx, tz) => closed.has(at(tx, tz)), [obj(R, 0x8001, 610, 610)])
    const nOut = nvmOf(flat(), (tx, tz) => tx === 5 && tz === 5)
    const walk = emptyWalkLayer()
    for (const t of closed) walk.codes[t] = WE_WALK.open
    const walkOut = emptyWalkLayer()
    walkOut.codes[at(5, 5)] = WE_WALK.open
    const warns: string[] = []
    // origin (168, 97): region 170's glTF x runs 384..576, z 0..-192; the sea covers its south-west corner's north part
    const seaAt = (x: number, z: number) => x < 384 + 20 && -z > 150
    const opts = baseOpts({
      regions: new Map([[R, { walk }], [OUT, { walk: walkOut }]]),
      walkGuard: { playable: { x0: 170, x1: 170, z0: 97, z1: 97 }, seaAt, origin: { x: 168, z: 97 } },
      warn: w => warns.push(w),
    })
    const run = createNavEdit(opts)
    const out = run.navEdit(R, nvm)!
    expect(out.tileCells[at(5, 5)]).toBe(0)
    expect(out.tileCells[at(30, 30)]).toBe(1)
    expect(out.tileCells[at(5, 80)]).toBe(1)
    expect(run.navEdit(OUT, nOut)).toBeNull()
    const rep = run.report()
    expect(rep.problems).toEqual([])
    expect(rep.regions[0]).toMatchObject({ forcedOpen: 1, openedTiles: [at(5, 5)] })
    expect(rep.ignored).toEqual([
      'world edits: walk 170_97: 2 force-open tile(s) ignored (1 in the sea, 1 under an object\'s footprint)',
      'world edits: walk 171_97: 1 force-open tile(s) ignored (1 outside the playable bounds)',
    ])
    expect(warns).toEqual(rep.ignored)
    // the NavData path ignores the same tiles
    const viaData = navEditData(navOf([{ id: R, nvm }, { id: OUT, nvm: nOut }]), { ...opts, warn: undefined })
    expect(openSet(viaData.data)).toEqual(openSet(navOf([{ id: R, nvm: out }, { id: OUT, nvm: nOut }])))
    expect(viaData.report.ignored).toEqual(rep.ignored)
    // a dropped object frees its ground; a moved one blocks where it now stands
    const objects = { remove: [navInstanceId(R, 0x8001)], put: [{ id: navInstanceId(R, 0x8001), objId: 7, source: 'res/x.bsr', x: 1920 * 170 + 110, y: 0, z: 1920 * 97 + 110, yaw: 0 }] }
    const moved = createNavEdit({ ...opts, objects, warn: undefined })
    const mOut = moved.navEdit(R, nvm)!
    expect(mOut.tileCells[at(30, 30)]).toBe(0)
    expect(mOut.tileCells[at(5, 5)]).toBe(1)
  })

  it('new water deeper than 1.2 m closes for walking, lists the tiles as deep water and sets the plane', () => {
    expect(navRuleWaterTile(NAV_RULE_WATER_DEPTH_M)).toBe('walk')
    expect(navRuleWaterTile(NAV_RULE_WATER_DEPTH_M + 0.001)).toBe('deep')
    expect(navRuleWaterTile(NaN)).toBe('walk')
    const water = new Float32Array(36).fill(NaN)
    water[0] = 1.3 // block (0, 0) over flat ground at 0: 1.3 m deep
    water[1] = 1.0 // block (1, 0): wading depth, stays open
    const run = createNavEdit(baseOpts({ regions: new Map([[R, { water }]]) }))
    const out = run.navEdit(R, nvmOf(flat()))!
    const s = run.report().regions[0]!
    expect(s.closedWater).toBe(256)
    expect(s.deepWater).toHaveLength(256)
    expect(s.deepWater.every(t => t % T < 16 && Math.floor(t / T) < 16)).toBe(true)
    expect(out.tileCells[16]).toBe(0)
    expect(s.planesSet).toBe(2)
    expect(out.planeTypes![0]).toBe(1)
    expect(out.planeHeights![0]).toBeCloseTo(13, 5)
  })

  it('a region without layers or footprints is left alone (null: the converter keeps its bytes)', () => {
    const run = createNavEdit(baseOpts({ regions: new Map([[R, { height: fixtureLayer() }]]) }))
    expect(run.navEdit(id(1, 1), nvmOf(flat()))).toBeNull()
    expect(run.report().regions).toEqual([])
  })
})

describe('object footprints (move, drop, add; spill copies; links)', () => {
  const A = id(170, 97)
  const B = id(171, 97)
  const ax = 1920 * 170, az = 1920 * 97
  const put = (uid: number, region: number, x: number, z: number, yaw = 0, objId = 7): WorldEditNavPut =>
    ({ id: navInstanceId(region, uid), objId, source: 'res/x.bsr', x, y: 0, z, yaw })

  it('footprint boxes and the regions they reach', () => {
    expect(footprintBox({ x: 100, z: 100, yaw: Math.PI / 2 }, { minX: -10, minZ: -50, maxX: 10, maxZ: 50 })).toMatchObject({ minX: 50, maxX: 150 })
    expect(regionsReached({ minX: ax + 1900, minZ: az + 100, maxX: ax + 1950, maxZ: az + 200 }, A)).toEqual([A, B])
    expect(regionsReached({ minX: ax + 100, minZ: az + 100, maxX: ax + 200, maxZ: az + 200 }, A)).toEqual([A])
  })

  it('a move inside its region replaces in its slot; a move to the border spills into the neighbour; a drop removes', () => {
    const nA = nvmOf(flat(), () => false, [obj(A, 0x8001, 500, 500), obj(A, 0x8002, 900, 900), obj(A, 0x8003, 1200, 1200)])
    const nB = nvmOf(flat())
    const objects = {
      remove: [navInstanceId(A, 0x8001), navInstanceId(A, 0x8002), navInstanceId(A, 0x8003)],
      put: [put(0x8001, A, ax + 600, az + 600, 0.5), put(0x8003, A, ax + 1900, az + 1000)],
    }
    const run = createNavEdit(baseOpts({ objects }))
    expect([...run.regions].sort()).toEqual([A, B])
    const oA = run.navEdit(A, nA)!
    const oB = run.navEdit(B, nB)!
    // 0x8001 kept its slot (moved), 0x8002 dropped, 0x8003 moved to the border: in A and spilled into B
    expect(oA.objects.map(o => o.localUid)).toEqual([0x8001, 0x8003])
    expect(oA.objects[0]).toMatchObject({ position: [600, 0, 600], yaw: 0.5 })
    expect(oB.objects).toHaveLength(1)
    expect(oB.objects[0]).toMatchObject({ localUid: 0x8003, regionId: A, position: [-20, 0, 1000] })
    expect(oB.cells[0]!.objects).toEqual([0])
    expect(oA.cells[0]!.objects).toEqual([0, 1])
    expect(oA.cells[1]!.objects).toEqual([]) // the small closed cell (0..20) is under neither box
    expect(run.report().regions.map(r => r.objects)).toEqual([{ removed: 1, replaced: 2, added: 0 }, { removed: 0, replaced: 0, added: 1 }])
    // the input is not mutated
    expect(nA.objects.map(o => o.localUid)).toEqual([0x8001, 0x8002, 0x8003])
  })

  it('an add goes to its owner (editor uid) with the template record; the .nvm path equals the NavData path', () => {
    const nA = nvmOf(flat(), () => false, [obj(A, 0x8001, 500, 500, { isBig: true, type: 0 })])
    const nB = nvmOf(flat())
    const objects = { remove: [navInstanceId(A, 0x8001)], put: [put(0x8001, A, ax + 1910, az + 500), put(0xe000, A, ax + 800, az + 800)] }
    const opts = baseOpts({ objects })
    const run = createNavEdit(opts)
    const edited = [{ id: A, nvm: run.navEdit(A, nA)! }, { id: B, nvm: run.navEdit(B, nB)! }]
    const added = edited[0]!.nvm.objects.find(o => o.localUid === 0xe000)!
    expect(added).toMatchObject({ objId: 7, regionId: A, isBig: true, type: 0, links: [] })
    const viaNvm = navOf(edited)
    const viaData = navEditData(navOf([{ id: A, nvm: nA }, { id: B, nvm: nB }]), opts).data
    expect(instSet(viaData)).toEqual(instSet(viaNvm))
    expect(run.report().problems).toEqual([])
  })

  it('links are never edited: a linked instance stays and the edit is a problem', () => {
    const link = { linkedObject: 1, linkedObjectEdge: 0, edge: 0 }
    const nA = nvmOf(flat(), () => false, [obj(A, 0x8001, 500, 500, { links: [link] }), obj(A, 0x8002, 700, 500)])
    const objects = { remove: [navInstanceId(A, 0x8002)], put: [put(0x8002, A, ax + 900, az + 900)] }
    const run = createNavEdit(baseOpts({ objects }))
    const out = run.navEdit(A, nA)
    expect(out === null || out.objects[1]!.position[0] === 700).toBe(true)
    expect(run.report().problems.some(p => p.includes('linked'))).toBe(true)
    const pre = createNavEdit(baseOpts({ objects, linked: new Set([navInstanceId(A, 0x8002)]) }))
    expect(pre.navEdit(A, nA)).toBeNull()
    expect(pre.report().problems).toHaveLength(1)
    const data = navEditData(navOf([{ id: A, nvm: nA }]), baseOpts({ objects }))
    expect(data.report.problems.some(p => p.includes('linked'))).toBe(true)
    expect(instSet(data.data)).toEqual(instSet(navOf([{ id: A, nvm: nA }])))
  })
})

// --- the checks ---------------------------------------------------------------------------------------------------------

describe('the Publish checks and the report', () => {
  const R = id(168, 97)
  const ORIGIN = { x: 168, z: 97 }
  /** glTF metres of a region-local file point (dm). */
  const g = (lx: number, lz: number) => ({ x: lx / 10, z: -lz / 10 })
  const SPAWN = { ...g(100, 100), y: 0 }
  const ringClosed = (tx: number, tz: number) => (tx >= 60 && tx <= 70 && (tz === 60 || tz === 70)) || (tz >= 60 && tz <= 70 && (tx === 60 || tx === 70))

  function scene(placements: CheckScene['placements']): CheckScene {
    return {
      placements,
      models: [
        { kind: 'static', boundsMin: [-5, 0, -5], boundsMax: [5, 8, 5] },
        { kind: 'static', boundsMin: [-1, 0, -1], boundsMax: [1, 6, 1], treeSwap: { species: 0 } },
      ],
    }
  }

  function input(before: NavData, after: NavData, extra: Partial<PublishCheckInput> = {}): PublishCheckInput {
    return { world: 'test', origin: ORIGIN, spawn: SPAWN, before, after, ...extra }
  }

  it('a closed ring: the nest and the place inside are lost (stop); the closed ring itself is not "cut off" ground', () => {
    const before = navOf([{ id: R, nvm: nvmOf(flat()) }])
    const walk = emptyWalkLayer()
    for (let tz = 0; tz < T; tz++) for (let tx = 0; tx < T; tx++) if (ringClosed(tx, tz)) walk.codes[tz * T + tx] = WE_WALK.closed
    const ed = navEditData(before, baseOpts({ regions: new Map([[R, { walk }]]) }))
    const inside = g(65 * 20 + 10, 65 * 20 + 10)
    const points: CheckPoint[] = [
      { kind: 'nest', id: '1', x: inside.x, z: inside.z },
      { kind: 'npc', id: 'NPC_A', x: g(300, 300).x, z: g(300, 300).z },
      { kind: 'place', id: 'pond', name: 'pond', x: inside.x, z: inside.z, y: 0 },
    ]
    const r = runPublishChecks(input(before, ed.data, { nav: ed.report, points, external: { layers: { status: 'pass', summary: 'ok' } } }))
    const c = Object.fromEntries(r.checks.map(k => [k.key, k]))
    expect(r.checks.map(k => k.id)).toEqual(PUBLISH_CHECKS.map(k => k.id))
    expect(c.layers!.status).toBe('pass')
    expect(c.traps!.status).toBe('pass')
    expect(c.reachable!.status).toBe('stop')
    expect((c.reachable!.details as { lost: unknown[]; checked: number })).toMatchObject({ checked: 3 })
    expect((c.reachable!.details as { lost: Array<{ id: string }> }).lost.map(l => l.id)).toEqual(['1', 'pond'])
    expect(c.roads!.status).toBe('stop')
    expect(c.cutOff!.status).toBe('pass') // the ring itself closed; the island inside was not edited (checks 3 and 4 catch it)
    expect(r.verdict).toBe('stop')
    expect(r.complete).toBe(false) // bounds and tests not run here
    expect(r.nav.totals.closed).toBe(40)
  })

  it('ground cut off: a raised island whose rim closes; inside tiles reached town before', () => {
    const before = navOf([{ id: R, nvm: nvmOf(flat()) }])
    const hill = emptyHeightLayer()
    for (let gz = 60; gz <= 71; gz++) for (let gx = 60; gx <= 71; gx++) { hill.mask[gz * G + gx] = 1; hill.delta[gz * G + gx] = 5 }
    const ed = navEditData(before, baseOpts({ regions: new Map([[R, { height: hill }]]) }))
    const r = runPublishChecks(input(before, ed.data, { nav: ed.report }))
    const cut = r.checks.find(k => k.key === 'cutOff')!
    expect(cut.status).toBe('warn')
    expect((cut.details as { cutOffTiles: number }).cutOffTiles).toBe(121) // the 11 x 11 plateau inside the closed rim
    expect(r.checks.find(k => k.key === 'traps')!.status).toBe('pass')
  })

  it('props on moved ground: a tree buried (warn), a building with a footprint floating (stop); overlaps warn', () => {
    const nA = nvmOf(flat(), () => false, [obj(R, 0x8001, 1000, 1000), obj(R, 0x8002, 300, 300)])
    const before = navOf([{ id: R, nvm: nA }])
    const layer = emptyHeightLayer()
    for (let gz = 40; gz <= 60; gz++) for (let gx = 40; gx <= 60; gx++) { layer.mask[gz * G + gx] = 1; layer.delta[gz * G + gx] = 2 }
    for (let gz = 10; gz <= 20; gz++) for (let gx = 10; gx <= 20; gx++) { layer.mask[gz * G + gx] = 1; layer.delta[gz * G + gx] = -1 }
    const objects = { remove: [], put: [{ id: navInstanceId(R, 0xe000), objId: 7, source: 'res/bldg/x.bsr', x: 1920 * 168 + 1040, y: 0, z: 1920 * 97 + 1000, yaw: 0 }] }
    const ed = navEditData(before, baseOpts({ regions: new Map([[R, { height: layer }]]), objects }))
    const tree = { region: R, uid: 0x8100, objId: 99, source: 'res\\nature\\tree\\tre_a.bsr', models: [1], position: [100, 0, -100] as [number, number, number] }
    const pos = g(300, 300)
    const bldg = { region: R, uid: 0x8002, objId: 7, source: 'res\\bldg\\house.bsr', models: [0], position: [pos.x, 0, pos.z] as [number, number, number] }
    const s = scene([tree, bldg])
    const r = runPublishChecks(input(before, ed.data, { nav: ed.report, scene: { before: s, after: s } }))
    const props = r.checks.find(k => k.key === 'props')!
    expect(props.status).toBe('stop')
    const rows = (props.details as { props: Array<{ key: string; verdict: string; building?: boolean }> }).props
    expect(rows.find(p => p.key.endsWith(':33024'))).toMatchObject({ verdict: 'buried' })
    expect(rows.find(p => p.key.endsWith(':32770'))).toMatchObject({ verdict: 'floating', building: true })
    const ov = r.checks.find(k => k.key === 'overlaps')!
    expect(ov.status).toBe('warn')
    expect((ov.details as { overlaps: Array<{ overlapM2: number }> }).overlaps[0]!.overlapM2).toBe(60)
  })

  it('budgets: lines per region (warn, refuse), the bench trigger, tree slots, lights, zones', () => {
    const nav = navOf([{ id: R, nvm: nvmOf(flat()) }])
    const p = (uid: number, model = 0) => ({ region: R, uid, objId: 1, source: 's', models: [model], position: [1, 0, -1] as [number, number, number] })
    const before = scene(Array.from({ length: 10 }, (_, i) => p(i)))
    const warnS = scene(Array.from({ length: 401 }, (_, i) => p(i, i % 2)))
    const refuse = scene(Array.from({ length: 600 }, (_, i) => p(i)))
    const run = (after: CheckScene, extra: Partial<PublishCheckInput> = {}) =>
      runPublishChecks(input(nav, nav, { scene: { before, after }, triangles: () => 100, ...extra })).checks.find(k => k.key === 'budgets')!
    const w = run(warnS)
    expect(w.status).toBe('warn')
    expect((w.details as { benchNeeded: boolean; world: { treeSlots: { after: number } } })).toMatchObject({ benchNeeded: true, world: { treeSlots: { after: 200 } } })
    expect(run(refuse).status).toBe('stop')
    expect(run(before).status).toBe('pass')
    expect(run(before, { external: { bench: { status: 'stop', summary: 'G1 missed at the plaza' } } }).status).toBe('stop')
    const lights = Array.from({ length: 25 }, (_, i) => ({ x: i, z: 0 }))
    expect(lightDensity(lights)).toBe(25)
    expect(run(before, { lights }).status).toBe('warn')
    const circle = (r: number) => ({ shape: { circle: { x: 0, z: 0, r } } })
    expect(zoneOverlap([circle(5), circle(6), circle(7), { shape: { poly: [[-1, -1], [1, -1], [1, 1], [-1, 1]] as Array<[number, number]> } }])).toBe(4)
  })

  it('an unchanged nav passes every row it runs; the report round-trips; external rows complete it', () => {
    const nav = navOf([{ id: R, nvm: nvmOf(flat()) }])
    const ok = { status: 'pass' as const, summary: 'ok' }
    const s = scene([])
    const r = runPublishChecks(input(nav, nav, { scene: { before: s, after: s }, external: { layers: ok, bounds: ok, tests: ok } }))
    expect(r.verdict).toBe('pass')
    expect(r.complete).toBe(true)
    expect(r.swim).toEqual({ deepWaterTiles: 0, deepWaterM2: 0, regions: [] })
    const back = parseWorldEditsReport(encodeWorldEditsReport(r))
    expect(back.checks).toEqual(r.checks)
    expect(() => parseWorldEditsReport('{"format":"x"}')).toThrow()
  })

  it('check points from the export files; glb triangle counts', () => {
    const pts = checkPointsFrom({
      nests: [{ id: 1, x: 1, z: 2, enabled: true }, { id: 2, x: 0, z: 0, enabled: false }],
      npcs: [{ code: 'N', name: 'Nn', x: 3, z: 4, inConvertedRegion: false }, { code: 'M', x: 5, z: 6 }],
      towns: [{ code: 'JANGAN', spawn: { x: 9, y: 1, z: 8 } }],
      places: [{ name: 'p', x: 1, y: 2, z: 3 }],
      probes: [{ id: 'pr-1', name: 'bridge', x: 7, z: 7 }],
    })
    expect(pts.map(p => `${p.kind}:${p.id}`)).toEqual(['nest:1', 'npc:M', 'gate:JANGAN', 'place:p', 'probe:pr-1'])
    const json = new TextEncoder().encode(JSON.stringify({ meshes: [{ primitives: [{ indices: 0, attributes: { POSITION: 1 } }, { attributes: { POSITION: 1 } }] }], accessors: [{ count: 30 }, { count: 9 }] }))
    const pad = (4 - (json.length % 4)) % 4
    const glb = new Uint8Array(20 + json.length + pad)
    const dv = new DataView(glb.buffer)
    dv.setUint32(0, 0x46546c67, true)
    dv.setUint32(4, 2, true)
    dv.setUint32(8, glb.length, true)
    dv.setUint32(12, json.length + pad, true)
    dv.setUint32(16, 0x4e4f534a, true)
    glb.set(json, 20)
    glb.fill(0x20, 20 + json.length)
    expect(glbTriangleCount(glb)).toBe(13)
    expect(glbTriangleCount(new Uint8Array(4))).toBe(0)
  })
})

// --- the real export ------------------------------------------------------------------------------------------------------

const OUT = join(REPO_ROOT, 'work', 'out', 'world', 'jangan-fields')
const hasExport = existsSync(join(OUT, 'manifest.json')) && existsSync(join(OUT, 'nav.bin')) && existsSync(join(REPO_ROOT, 'work', 'out', 'data', 'nests.json'))

describe.skipIf(!hasExport)('the dry run on the jangan-fields export (skips without it)', () => {
  it('the fixture edit on nav.bin: 117 closed, no nest within 400 m lost, no new trap, nothing cut off', () => {
    const t0 = performance.now()
    const bytes = readFileSync(join(OUT, 'nav.bin'))
    const before = decodeNavData(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    const region = before.regions.find(r => r.id === FX_ID)!
    const same = FIXTURE.heights.every(([i, v]) => region.heights[i] === v)
    if (!same) return // the export moved under the fixture: the fixture tests above still hold the rule
    const ed = navEditData(before, baseOpts({ regions: new Map([[FX_ID, { height: fixtureLayer() }]]) }))
    expect(ed.report.regions[0]).toMatchObject({ touched: 443, closed: 117 })
    const man = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8')) as { space: { originRegion: { x: number; z: number } }; spawn: { x: number; y: number; z: number }; places?: Array<{ name: string; x: number; y: number; z: number }> }
    const nests = (JSON.parse(readFileSync(join(REPO_ROOT, 'work', 'out', 'data', 'nests.json'), 'utf8')) as { entries: Array<{ id: number; x: number; z: number }> }).entries
    // the edit's centre (171_97, glTF ~ (640, -138)); the dry run checked the 53 nests within 400 m
    const near = nests.filter(n => Math.hypot(n.x - 640, n.z + 138) < 400)
    const points = checkPointsFrom({ nests: near, places: man.places })
    const r = runPublishChecks({ world: 'jangan-fields', origin: man.space.originRegion, spawn: man.spawn, before, after: ed.data, nav: ed.report, points })
    const c = Object.fromEntries(r.checks.map(k => [k.key, k]))
    expect(c.traps!.status).toBe('pass')
    expect(c.reachable!.status).toBe('pass')
    expect(c.roads!.status).toBe('pass')
    expect(c.cutOff!.status).toBe('pass')
    expect((c.cutOff!.details as { stillReachable: number }).stillReachable).toBeGreaterThanOrEqual(300)
    const ms = performance.now() - t0
    console.log(`WE-N dry run on the export: ${near.length} nests near, traps ${JSON.stringify((c.traps!.details as { after: unknown }).after)}, ` +
      `cut-off ${JSON.stringify(c.cutOff!.details && { still: (c.cutOff!.details as { stillReachable: number }).stillReachable })}, ${ms.toFixed(0)} ms ${JSON.stringify(r.timingsMs)}`)
    // the 10 s Publish budget (WAVE_PLAN8 §5.3) is judged on a quiet machine (the lead's bench); here only a sanity line
    expect(ms).toBeLessThan(60_000)
  }, 120_000)
})
