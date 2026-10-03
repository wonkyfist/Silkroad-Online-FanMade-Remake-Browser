/**
 * World ambient effects (docs/EFFECTS.md §3.15; lane FX-C2): the ambient.json index of the objects' sidecar particles,
 * emitters placed with their object's transform, the live set (nearest within range, capped, night-only ones off at
 * noon), region unloads, and the real Jangan index (the blacksmith's chimney smoke is there and burns by day).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AmbientFx, pickEmitters, placeEmitter, quatMatrix, readAmbientIndex, type AmbientEmitter } from '../src/ambient-fx.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')

/** Quaternion of a yaw about +Y. */
const yawQuat = (a: number): [number, number, number, number] => [0, Math.sin(a / 2), 0, Math.cos(a / 2)]

describe('emitter placement', () => {
  it('a model-space point turns with the placement and moves with it', () => {
    const p = placeEmitter({ position: [10, 2, 5], rotation: yawQuat(Math.PI / 2) }, [0, 8, 1])
    // +Z forward turned 90 degrees about +Y lands on +X.
    expect(p[0]).toBeCloseTo(11)
    expect(p[1]).toBeCloseTo(10)
    expect(p[2]).toBeCloseTo(5)
    const m = quatMatrix([0, 0, 0, 1])
    expect(m).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1])
  })

  it('reads the ambient rows of the index only', () => {
    const idx = readAmbientIndex({ models: { 3: [{ kind: 'ambient', efp: 'map/frame.efp', bone: null, position: [0, 1, 0], night: true }, { kind: 'status', efp: 'x.efp' }], x: [], 4: 'bad' } })
    expect([...idx.keys()]).toEqual([3])
    expect(idx.get(3)).toEqual([{ kind: 'ambient', efp: 'map/frame.efp', bone: null, position: [0, 1, 0], night: true }])
    expect(readAmbientIndex(null).size).toBe(0)
  })
})

describe('the live set', () => {
  const e = (x: number, night = false): AmbientEmitter => ({ key: `k${x}`, position: [x, 0, 0], rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], night, region: 1 })

  it('nearest first within range, capped; night-only ones only at night', () => {
    const list = [e(50), e(5), e(70), e(20), e(10, true)]
    expect(pickEmitters(list, { x: 0, y: 0, z: 0 }, 2, 60, false).map(x => x.key)).toEqual(['k5', 'k20'])
    expect(pickEmitters(list, { x: 0, y: 0, z: 0 }, 10, 60, false).map(x => x.key)).toEqual(['k5', 'k20', 'k50'])
    expect(pickEmitters(list, { x: 0, y: 0, z: 0 }, 10, 60, true).map(x => x.key)).toEqual(['k5', 'k10', 'k20', 'k50'])
  })

  it('starts and stops effects as the focus moves, regions unload and the player changes', () => {
    const fx = new AmbientFx({ max: 2, range: 30 })
    fx.setIndex(readAmbientIndex({ models: { 1: [{ kind: 'ambient', efp: 'map/oas_hot_etc_b.efp', bone: null, position: [0, 9, 0], night: false }], 2: [{ kind: 'ambient', efp: 'map/cj_pal_lamp_red.efp', bone: null, position: [0, 3, 0], night: true }] } }))
    const live = new Set<string>()
    let started = 0
    fx.setPlayer((key, pos) => {
      const id = `${key}@${pos[0]}`
      live.add(id)
      started++
      return { stop: () => void live.delete(id) }
    })
    fx.add(7, 1, [{ position: [0, 0, 0], rotation: [0, 0, 0, 1] }, { position: [20, 0, 0], rotation: [0, 0, 0, 1] }, { position: [100, 0, 0], rotation: [0, 0, 0, 1] }])
    fx.add(7, 2, [{ position: [1, 0, 0], rotation: [0, 0, 0, 1] }])
    fx.add(8, 3, [{ position: [1, 0, 0], rotation: [0, 0, 0, 1] }]) // no particles
    fx.update({ x: 0, y: 0, z: 0 })
    expect([...live].sort()).toEqual(['map/oas_hot_etc_b.efp@0', 'map/oas_hot_etc_b.efp@20'])
    // Small moves do not re-pick; a move past the refocus distance does.
    fx.update({ x: 1, y: 0, z: 0 })
    expect(started).toBe(2)
    fx.update({ x: 95, y: 0, z: 0 })
    expect([...live]).toEqual(['map/oas_hot_etc_b.efp@100'])
    fx.setNight(true)
    fx.update({ x: 0, y: 0, z: 0 })
    expect([...live].sort()).toEqual(['map/cj_pal_lamp_red.efp@1', 'map/oas_hot_etc_b.efp@0'])
    expect(fx.stats).toMatchObject({ emitters: 4, live: 2, models: 2 })
    fx.removeRegion(7)
    expect(live.size).toBe(0)
    expect(fx.stats.emitters).toBe(0)
    fx.dispose()
  })
})

const INDEX = join(ROOT, 'work', 'out', 'world', 'jangan-fields', 'ambient.json')
describe.runIf(existsSync(INDEX))('the exported Jangan index', () => {
  it('has the torches and the blacksmith\'s smoke (by day), with their programs exported', () => {
    const idx = readAmbientIndex(JSON.parse(readFileSync(INDEX, 'utf8')))
    const rows = [...idx.values()].flat()
    const smoke = rows.filter(r => r.efp === 'map/oas_hot_etc_b.efp')
    expect(smoke.length).toBeGreaterThan(0)
    expect(smoke.every(r => !r.night)).toBe(true)
    // The chimney smoke sits 8-10 m up (decimetres converted).
    expect(Math.max(...smoke.map(r => r.position[1]))).toBeGreaterThan(7)
    expect(rows.some(r => r.efp === 'map/frame.efp')).toBe(true)
    for (const key of new Set(rows.map(r => r.efp))) {
      const file = join(ROOT, 'work', 'out', 'fx', 'efp', key.replace(/\.efp$/, '.json'))
      expect(existsSync(file), key).toBe(true)
    }
  })
})
