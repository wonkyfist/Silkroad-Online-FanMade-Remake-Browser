/**
 * GL-L, the butterflies and where the wildlife lives (docs/GRASS_LIFE.md §5.2, §5.3, §5.5; docs/WAVE_PLAN6.md §6.1
 * GL-L): the TS twin of the flight (life/shaders.ts critterFlight) stays within the wander radius and above the ground
 * the anchor stands for; anchors come from the meadow and from the placed flower models (the stage's beds on paving);
 * dragonflies over inland water; the cells are seeded by (cell, game hour); perches from the manifest bounds lie within
 * 0.5 m of the model's top.
 */
import { describe, expect, it } from 'vitest'
import type { WorldManifest, WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import { DRAGONFLY_FIRST_SPECIES, critterFlight } from '../src/life/shaders.ts'
import { BUILTIN_CRITTERS, critterSpeciesOf } from '../src/life/butterflies.ts'
import {
  BUTTERFLY_MAX_RELIEF_M,
  CANDIDATE_STRIDE,
  LIFE_CELL_M,
  LifeCells,
  LifePlaces,
  buildCell,
  discHeight,
  findLanding,
  isBuildingModel,
  isFlowerModel,
  isTreeModel,
  meadowNoise,
  mulberry32,
  perchPointsOf,
  type LifeGround,
} from '../src/life/spawn.ts'

/** A ground: grass where `grass(x, z)`, paving elsewhere, a gentle tilt, a pond at x < -100. */
function ground(o: { grass?: (x: number, z: number) => boolean; tilt?: number; pond?: boolean } = {}): LifeGround {
  const grass = o.grass ?? (() => true)
  const tilt = o.tilt ?? 0.05
  const h = (x: number, z: number) => tilt * x + Math.sin(z * 0.05) * 0.4
  return {
    heightAt: h,
    surfaceAt: h,
    densityAt: (x, z) => (grass(x, z) && !(o.pond && x < -100) ? 0.9 : 0),
    meadowAt: (x, z) => (grass(x, z) ? 0.9 * meadowNoise(x, z) : 0),
    waterAt: (x, z) => (o.pond && x < -100 ? h(x, z) + 1 : null),
    floorAt: () => false,
  }
}

function manifest(models: Array<Partial<WorldModel> & { source: string }>, placements: Array<{ model: number; at: [number, number, number]; yaw?: number }>): Pick<WorldManifest, 'models' | 'placements'> {
  return {
    models: models.map((m, index) => ({
      index, glb: null, sidecar: null, kind: 'static', animations: [], defaultClip: null, lightmappedMeshes: 0,
      boundsMin: [-1, 0, -1], boundsMax: [1, 1, 1], bytes: 0, validatorErrors: null, ...m,
    }) as WorldModel),
    placements: placements.map((p, uid) => {
      const yaw = p.yaw ?? 0
      return {
        objId: p.model, source: models[p.model]!.source, models: [p.model], compound: false, position: p.at,
        rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], yaw, flags: { static: true, big: false, struct: false }, staticFlag: 0xffff,
        uid, region: 0, group: 2, inConvertedRegion: true,
      } as WorldPlacement
    }),
  }
}

describe('the critter flight (the TS twin of the shader)', () => {
  it('butterflies stay within their wander radius, 0.3–1.3 m above their anchor, and sit now and then', () => {
    let sat = 0
    for (let k = 0; k < 40; k++) {
      const seed = (k * 0.6180339) % 1
      const r = 2 + (k % 5)
      for (let t = 0; t < 120; t += 0.37) {
        const f = critterFlight(t, seed, k % 4, r)
        expect(Math.hypot(f.x, f.z)).toBeLessThanOrEqual(r + 1e-6)
        expect(f.lift).toBeGreaterThanOrEqual(0.3)
        expect(f.lift).toBeLessThanOrEqual(1.3)
        if (f.sit > 0.9) sat++
      }
    }
    expect(sat).toBeGreaterThan(0)
  })

  it('dragonflies dart within their radius, 0.3–1.2 m over the water', () => {
    for (let k = 0; k < 30; k++) {
      const seed = (k * 0.37) % 1
      for (let t = 0; t < 60; t += 0.13) {
        const f = critterFlight(t, seed, DRAGONFLY_FIRST_SPECIES + (k % 2), 2.5)
        expect(Math.hypot(f.x, f.z)).toBeLessThanOrEqual(2.5 + 1e-6)
        expect(f.lift).toBeGreaterThanOrEqual(0.26)
        expect(f.lift).toBeLessThanOrEqual(1.24)
      }
    }
  })

  it('never dips into the ground: the anchor stands at its disc\'s highest ground, and steep discs are refused', () => {
    const g = ground({ tilt: 0.12 })
    const places = new LifePlaces(manifest([], []))
    let checked = 0
    for (let cx = -3; cx < 3; cx++) {
      for (let cz = -3; cz < 3; cz++) {
        const cell = buildCell(g, places, cx, cz, 7)
        const a = cell.butterflies
        for (let o = 0; o < a.length; o += CANDIDATE_STRIDE) {
          const [x, y, z, seed, r] = [a[o]!, a[o + 1]!, a[o + 2]!, a[o + 3]!, a[o + 4]!]
          for (let t = 0; t < 60; t += 0.23) {
            const f = critterFlight(t, seed, a[o + 5]!, r)
            const under = g.heightAt(x + f.x, z + f.z)!
            expect(y + f.lift - under).toBeGreaterThan(0.2)
            checked++
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000)
    // A steep slope: the wander disc's relief refuses the anchor.
    const steep = ground({ tilt: 0.5 })
    const d = discHeight(steep, 0, 0, 4)!
    expect(d.relief).toBeGreaterThan(BUTTERFLY_MAX_RELIEF_M)
    let n = 0
    for (let cx = 0; cx < 4; cx++) n += buildCell(steep, places, cx, 0, 1).butterflies.length
    expect(n).toBe(0)
  })
})

describe('where the critters live', () => {
  it('butterflies anchor on the meadow, never on paving', () => {
    const g = ground({ grass: x => x >= 0 })
    const places = new LifePlaces(manifest([], []))
    let meadow = 0
    for (let cx = -4; cx < 4; cx++) {
      for (let cz = -4; cz < 4; cz++) {
        const a = buildCell(g, places, cx, cz, 3).butterflies
        for (let o = 0; o < a.length; o += CANDIDATE_STRIDE) {
          expect(a[o]!).toBeGreaterThanOrEqual(0)
          meadow++
        }
      }
    }
    expect(meadow).toBeGreaterThan(10)
  })

  it('butterflies also anchor over the placed flower models, on paving (the stage\'s beds)', () => {
    const g = ground({ grass: () => false })
    const m = manifest(
      [{ source: 'res\\nature\\common\\flower\\flw_g01_yall.bsr' }, { source: 'res\\nature\\common\\flower\\grs_flower_01.bsr' }, { source: 'res\\nature\\common\\grass\\group_grs01.bsr' }],
      [{ model: 0, at: [5, 12.5, 5] }, { model: 1, at: [21, 12.5, 6] }, { model: 2, at: [40, 12.5, 5] }],
    )
    const places = new LifePlaces(m)
    expect(places.flowers.count).toBe(2)
    const cells = new LifeCells(g, places)
    let found = 0
    for (let hour = 0; hour < 24; hour++) {
      cells.fill(20, 5, 40, hour, 1000)
      const out = new Float32Array(20 * CANDIDATE_STRIDE)
      const n = cells.gather('butterflies', 20, 5, 30, hour, 20, out)
      for (let i = 0; i < n; i++) {
        const x = out[i * CANDIDATE_STRIDE]!, y = out[i * CANDIDATE_STRIDE + 1]!
        expect([5, 21]).toContain(Math.round(x))
        expect(y).toBeCloseTo(12.5)
        found++
      }
    }
    // Over a day of hours the beds get their butterflies (a bed is picked 70 % of the hours).
    expect(found).toBeGreaterThan(10)
  })

  it('dragonflies only over inland water, anchored on its surface', () => {
    const g = ground({ pond: true })
    const places = new LifePlaces(manifest([], []))
    let wet = 0
    for (let cx = -12; cx < 2; cx++) {
      const a = buildCell(g, places, cx, 0, 5).dragonflies
      for (let o = 0; o < a.length; o += CANDIDATE_STRIDE) {
        expect(a[o]!).toBeLessThan(-100)
        expect(a[o + 1]!).toBeCloseTo(g.waterAt(a[o]!, a[o + 2]!)!, 4)
        expect(a[o + 5]!).toBeGreaterThanOrEqual(DRAGONFLY_FIRST_SPECIES)
        wet++
      }
    }
    expect(wet).toBeGreaterThan(5)
  })

  it('cells are seeded by (cell, hour): the same spot keeps its animals within an hour, and changes with it', () => {
    const g = ground()
    const places = new LifePlaces(manifest([], []))
    const a = buildCell(g, places, 3, -2, 10)
    const b = buildCell(g, places, 3, -2, 10)
    const c = buildCell(g, places, 3, -2, 11)
    expect(Array.from(a.butterflies)).toEqual(Array.from(b.butterflies))
    expect(Array.from(a.fireflies)).toEqual(Array.from(b.fireflies))
    expect(Array.from(a.butterflies)).not.toEqual(Array.from(c.butterflies))
  })

  it('gather: nearest first, within the radius, at most max; fill builds a few cells per call, nearest first', () => {
    const g = ground()
    const cells = new LifeCells(g, new LifePlaces(manifest([], [])))
    expect(cells.fill(0, 0, 30, 4, 2)).toBe(false)
    expect(cells.built).toBe(2)
    expect(cells.get(-1, -1, 4) ?? cells.get(0, 0, 4) ?? cells.get(-1, 0, 4) ?? cells.get(0, -1, 4)).toBeDefined()
    while (!cells.fill(0, 0, 30, 4, 3)) {
      /* fill */
    }
    const out = new Float32Array(10 * CANDIDATE_STRIDE)
    const n = cells.gather('butterflies', 0, 0, 30, 4, 10, out)
    expect(n).toBe(10)
    let last = 0
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(out[i * CANDIDATE_STRIDE]!, out[i * CANDIDATE_STRIDE + 2]!)
      expect(d).toBeLessThanOrEqual(30)
      expect(d).toBeGreaterThanOrEqual(last - 1e-4)
      last = d
    }
    expect(LIFE_CELL_M).toBe(16)
  })

  it('fireflies gather on grass near trees and water', () => {
    const g = ground({ grass: x => x > -50 })
    const m = manifest([{ source: 'res\\nature\\common\\tree\\new-maple\\tre_tree03.bsr' }], [{ model: 0, at: [8, 0, 8] }])
    const places = new LifePlaces(m)
    expect(places.trees.count).toBe(1)
    const cells = new LifeCells(g, places)
    while (!cells.fill(0, 0, 60, 0, 50)) {
      /* fill */
    }
    const out = new Float32Array(120 * CANDIDATE_STRIDE)
    const n = cells.gather('fireflies', 0, 0, 60, 0, 120, out)
    expect(n).toBeGreaterThan(10)
    let nearTree = 0
    for (let i = 0; i < n; i++) {
      const x = out[i * CANDIDATE_STRIDE]!, z = out[i * CANDIDATE_STRIDE + 2]!
      expect(x).toBeGreaterThan(-50)
      if (Math.hypot(x - 8, z - 8) <= 14) nearTree++
    }
    // Near the tree they are dense; away from it, a thin scatter.
    const area = Math.PI * 14 * 14, rest = Math.PI * 60 * 60 - area
    expect(nearTree / area).toBeGreaterThan(((n - nearTree) / rest) * 2)
  })
})

describe('the critter species', () => {
  it('the built-ins map to the shader\'s ids; a registered one to the nearest wing colour', () => {
    expect(BUILTIN_CRITTERS.map(s => critterSpeciesOf(s).shader)).toEqual([0, 1, 2, 3, 4, 5])
    expect(critterSpeciesOf({ id: 'peacock', kind: 'butterfly', colors: [[0.8, 0.2, 0.02]] }).shader).toBe(0)
    expect(critterSpeciesOf({ id: 'sulphur', kind: 'butterfly', colors: [[0.9, 0.8, 0.1]] }).shader).toBe(2)
    expect(critterSpeciesOf({ id: 'emperor', kind: 'dragonfly', colors: [[0.02, 0.1, 0.4]] }).shader).toBe(4)
  })
})

describe('the placements the wildlife reads', () => {
  it('names: flowers (flw_*, grs_flower*), trees, buildings (res/bldg)', () => {
    expect(isFlowerModel({ source: 'res\\nature\\common\\flower\\flw_g01_wha.bsr' })).toBe(true)
    expect(isFlowerModel({ source: 'res\\nature\\common\\flower\\grs_flower05.bsr' })).toBe(true)
    expect(isFlowerModel({ source: 'res\\nature\\common\\grass\\group_grs01.bsr' })).toBe(false)
    expect(isTreeModel({ source: 'res\\nature\\common\\tree\\new-maple\\tre_tree03.bsr' })).toBe(true)
    expect(isBuildingModel({ source: 'res\\bldg\\china\\jangan01\\cj_house01.bsr' })).toBe(true)
    expect(isBuildingModel({ source: 'res\\nature\\common\\cliff\\x.bsr' })).toBe(false)
  })

  it('perches from the manifest bounds lie within 0.5 m of the model\'s top, on its ridge, rotated with the placement', () => {
    const house = { boundsMin: [-6, 0, -3], boundsMax: [6, 7.5, 3] } as Pick<WorldModel, 'boundsMin' | 'boundsMax'>
    for (const yaw of [0, 0.7, Math.PI / 2, 2.4]) {
      const pl = { position: [100, 20, -50] as [number, number, number], rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] as [number, number, number, number] }
      const pts = perchPointsOf(house, pl)
      expect(pts).toHaveLength(2)
      for (const [x, y, z] of pts) {
        expect(Math.abs(y - (20 + 7.5))).toBeLessThanOrEqual(0.5)
        // On the long axis (x in model space), 3 m from the centre, turned by the yaw.
        expect(Math.hypot(x - 100, z + 50)).toBeCloseTo(3, 4)
      }
      // The two points lie along the model's long axis.
      const ang = Math.atan2(-(pts[1]![2] - pts[0]![2]), pts[1]![0] - pts[0]![0])
      expect(Math.abs(Math.sin(ang - yaw))).toBeLessThan(1e-6)
    }
    // Too low, too short or too long: no perch.
    expect(perchPointsOf({ boundsMin: [-5, 0, -5], boundsMax: [5, 2, 5] }, { position: [0, 0, 0], rotation: [0, 0, 0, 1] })).toEqual([])
    expect(perchPointsOf({ boundsMin: [-1, 0, -1], boundsMax: [1, 5, 1] }, { position: [0, 0, 0], rotation: [0, 0, 0, 1] })).toEqual([])
    expect(perchPointsOf({ boundsMin: [-60, 0, -5], boundsMax: [60, 9, 5] }, { position: [0, 0, 0], rotation: [0, 0, 0, 1] })).toEqual([])
  })

  it('LifePlaces collects the building perches of every placement', () => {
    const m = manifest(
      [{ source: 'res\\bldg\\china\\jangan01\\cj_house01.bsr', boundsMin: [-5, 0, -3], boundsMax: [5, 6, 3] }],
      [{ model: 0, at: [0, 0, 0] }, { model: 0, at: [30, 2, 0], yaw: 1 }],
    )
    const places = new LifePlaces(m)
    expect(places.perches.count).toBe(4)
    const got: number[] = []
    places.perches.near(30, 0, 5, (_x, y) => got.push(y))
    expect(got).toEqual([8, 8])
  })
})

describe('a ground flock\'s landing spot', () => {
  it('open grass 14–24 m from the player, clear of every threat by 13 m', () => {
    const g = ground({ grass: (x, z) => x > 0 && z > -30 })
    const rnd = mulberry32(5)
    const threats = [{ x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 5 }]
    let n = 0
    for (let k = 0; k < 200; k++) {
      const s = findLanding(g, rnd, 0, 0, threats)
      if (!s) continue
      n++
      const d = Math.hypot(s.x, s.z)
      expect(d).toBeGreaterThanOrEqual(14)
      expect(d).toBeLessThanOrEqual(24)
      expect(s.x).toBeGreaterThan(0)
      for (const t of threats) expect(Math.hypot(s.x - t.x, s.z - t.z)).toBeGreaterThanOrEqual(13)
      expect(s.y).toBeCloseTo(g.heightAt(s.x, s.z)!)
    }
    expect(n).toBeGreaterThan(50)
    // No grass at all: nowhere to land.
    expect(findLanding(ground({ grass: () => false }), rnd, 0, 0, [])).toBeNull()
  })
})
