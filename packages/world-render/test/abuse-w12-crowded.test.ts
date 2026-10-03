/**
 * H-12 lens 15, the crowded plaza (docs/WAVE_PLAN8.md §6.7 item 15, D24): the crowded-plaza rule's switch at 15
 * players must not flicker.
 *
 * The rule reads one count: the players within the crowd's range (60 m on Medium) of the own character, counted every
 * PLAYER_COUNT_S (0.5 s) by the game's town feature and polled by the trees part every PLAYER_POLL_S (0.5 s). The
 * threshold has no hysteresis and no hold time, so a 15th player standing (or jumping, or idling with a bobbing
 * camera) on the 60 m edge, or the own character walking back and forth across it, flips the rule at every poll:
 *
 * - the trees (wave 12, D24): every tree 23–40 m away goes LOD0 overlay → merged LOD1 → LOD0 … every 0.5 s (a full
 *   band refill and an R8 upload each time), a visible pop on the crowded plaza;
 * - the townsfolk (wave 11 cut 20, the same count, `noFolkFrom: 15`): the cap jumps 33 ↔ 0, so the crowd fades out
 *   and back in (FADE_S 0.6 s is longer than the 0.5 s count) for as long as the player stands there.
 *
 * Expected: one decision per crossing (e.g. on at ≥ 15, off only at ≤ 12, or held ≥ a few seconds), so a count that
 * oscillates 14 ↔ 15 for 10 s flips the rule at most once.
 */
import { NullEngine, Scene, Vector3, type Camera } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import type { RegionListener } from '../src/objects.ts'
import { FADE_S, TOWN_PRESETS, folkCap } from '../src/town/crowd.ts'
import {
  BAND_MID,
  BAND_NEAR,
  CROWD_PLAYERS,
  PLAYER_POLL_S,
  TreesNearField,
  bandFor,
  bandRule,
} from '../src/trees/index.ts'
import type { TreesHost } from '../src/trees/types.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

/** A Medium world with one swapped tree 60 m away and a town part whose player count the test drives. */
function crowdedWorld() {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const listeners: RegionListener[] = []
  const town = { players: 0 }
  const tree = {
    index: 1, source: 'res\\nature\\common\\tree\\w12\\sp1.bsr#species', glb: 'models/trees/sp1/far.glb', sidecar: 'tree',
    kind: 'static', animations: [], defaultClip: null, lightmappedMeshes: 0, boundsMin: [-1, 0, -1], boundsMax: [1, 2, 1], bytes: 0,
    validatorErrors: null,
  } as unknown as WorldModel
  const retail = { index: 3, source: 'res\\nature\\common\\tree\\tre_pine07_03.bsr' } as WorldModel
  const band = { tex: null as unknown }
  const world = {
    quality: 'medium',
    objects: {
      drawRangeScale: 1,
      showStatic: true,
      addRegionListener(l: RegionListener) {
        listeners.push(l)
        return () => listeners.splice(listeners.indexOf(l), 1)
      },
    },
    town: { stats: () => ({ players: town.players }) },
    foliage: { shared: { get band() { return band.tex }, setBand(t: unknown) { band.tex = t } } },
    materials: {},
    assets: {},
    manifest: { models: [tree] },
    batch: { trees: { swapOf: (m: WorldModel) => (m.index === 3 ? { species: tree, fit: [1, 1, 1], tint: 0 } : null), materials: null, tints: null } },
  }
  const part = new TreesNearField({ scene, world } as unknown as TreesHost, { load: async () => null, kindOf: async () => 'tree' })
  cleanups.push(() => {
    part.dispose()
    scene.dispose()
    engine.dispose()
  })
  const ps = [{ position: [60, 0, 0], rotation: [0, 0, 0, 1], region: 0x6464, uid: 1 }] as unknown as WorldPlacement[]
  for (const l of listeners) l.placed(5, retail, { index: 3, source: retail.source, heightM: 2, isFoliage: true, kind: 'static' }, [], ps)
  const cam = { globalPosition: new Vector3(0, 1, 0) } as unknown as Camera
  return { part, town, cam }
}

describe('H-12 lens 15: the crowded rule at the 15-player line', () => {
  it('a count oscillating 14 ↔ 15 (one player on the 60 m edge) flips the trees\' rule at most once in 10 s', () => {
    const w = crowdedWorld()
    w.town.players = CROWD_PLAYERS - 1
    w.part.update(w.cam, 1)
    expect(w.part.crowded).toBe(false)
    let flips = 0
    let last = w.part.crowded
    const refills0 = w.part.stats().refills!
    // 10 s of frames; the game's town feature recounts every 0.5 s and the edge player is in, out, in, …
    const dt = 1 / 60
    let t = 0
    let next = 0
    for (let f = 0; f < 600; f++) {
      t += dt
      if (t >= next) {
        next += 0.5
        w.town.players = w.town.players === CROWD_PLAYERS ? CROWD_PLAYERS - 1 : CROWD_PLAYERS
      }
      w.part.update(w.cam, dt)
      if (w.part.crowded !== last) {
        flips++
        last = w.part.crowded
      }
    }
    const refills = w.part.stats().refills! - refills0
    console.log(`[abuse-w12-crowded] 10 s at the line: ${flips} rule flips, ${refills} band refills with the camera still (poll ${PLAYER_POLL_S} s)`)
    expect(flips).toBeLessThanOrEqual(1)
  })

  it('(context, passes) what each flip does: a tree 25 m away pops LOD0 ↔ LOD1, and the townsfolk cap jumps 33 ↔ 0 (fade 0.6 s > the 0.5 s count)', () => {
    // the band of one tree (distance − radius 25 m, its overlay ready) through the same 14/15 sequence
    let prev = BAND_NEAR
    let pops = 0
    for (let i = 0; i < 20; i++) {
      const crowded = i % 2 === 0
      const b = bandFor(25, false, prev, bandRule(1, crowded), true)
      if (b !== prev) pops++
      prev = b
    }
    expect([BAND_NEAR, BAND_MID]).toContain(prev)
    // the townsfolk (cut 20) on the same count
    const caps = new Set<number>()
    for (let i = 0; i < 20; i++) caps.add(folkCap(TOWN_PRESETS.medium, i % 2 === 0 ? CROWD_PLAYERS : CROWD_PLAYERS - 1))
    console.log(`[abuse-w12-crowded] 20 polls at the line: ${pops} tree pops at 25 m; folk caps seen ${[...caps].join(', ')}; FADE_S ${FADE_S}`)
    // the rules themselves are stateless: every flip of the count is a pop and a crowd fade (the first test's flips)
    expect(pops).toBe(20)
    expect([...caps].sort((a, b) => a - b)).toEqual([0, 33])
    expect(FADE_S).toBeGreaterThan(0.5)
  })
})
