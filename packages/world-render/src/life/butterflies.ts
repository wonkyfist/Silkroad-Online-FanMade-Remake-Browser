/**
 * Butterflies and dragonflies (docs/GRASS_LIFE.md §5.2, §5.5; lane GL-L): one mesh, one draw, GPU-procedural flight
 * (life/shaders.ts, the critter body). The CPU only places anchors:
 *
 * - **Butterflies** by day (Medium 20, High 40 within 30 m; a few at dawn and dusk; none at night or in rain) over the
 *   meadow (grass density ≥ 0.3, more where the meadow mask is high) **and over the placed flower models** (the second
 *   anchor source of GRASS_LIFE §5.2's fact-check: the palace-steps beds and town gardens stand on paving). Drawn 2.2×
 *   life size (X11). Without the grass field's height texture the flight's ground is the anchor's height, so a meadow
 *   anchor stands at the highest ground of its wander disc and discs on a slope steeper than 0.8 m are refused
 *   (life/spawn.ts discHeight): a butterfly never dips into the ground.
 * - **Dragonflies** (6–12 within 25 m of inland water; the anchor's height is the water surface, the flight 0.3–1.2 m
 *   above it; never the coast's open sea).
 *
 * The anchors come from the seeded cells (life/spawn.ts LifeCells), nearest first, so a spot keeps its butterflies
 * while the player stays; they are re-gathered when the focus has moved 6 m, the game hour or the counts change.
 * Rain fades them out over 5 s (crDay.x shrinks every critter) before they are dropped.
 *
 * Instance record (life/shaders.ts): world0 = (seed, species, wander radius, 0), world3 = the anchor (x, y, z, 1).
 */
import type { Vector4 } from '@babylonjs/core'
import type { LifeMesh, LifeTargets } from './life.ts'
import { BUTTERFLY_SCALE, CRITTER_SPECIES, DRAGONFLY_FIRST_SPECIES, DRAGONFLY_SCALE } from './shaders.ts'
import { CANDIDATE_STRIDE, type LifeCells } from './spawn.ts'
import type { LifeSpecies } from './types.ts'

/** The pools (the critter mesh's capacity: High's 40 butterflies and 12 dragonflies, with room). */
export const MAX_BUTTERFLIES = 40
export const MAX_DRAGONFLIES = 12
export const MAX_CRITTERS = 64
/** Butterflies live within this of the focus (§5.1), dragonflies within this of it over water (§5.1). */
export const BUTTERFLY_RANGE_M = 30
export const DRAGONFLY_RANGE_M = 25
/** Seconds of the rain fade (§5.1: "they fade out over 5 s"). */
export const CRITTER_FADE_S = 5
/** Re-gather after the focus moved this far (m); checks at most this often (s). */
const REANCHOR_M = 6
const CHECK_S = 0.5

/** The built-in critter species (GRASS_LIFE §5.2: monarch, cabbage white, brimstone, blue; §5.5: two dragonflies). */
export const BUILTIN_CRITTERS: readonly LifeSpecies[] = [
  { id: 'monarch', kind: 'butterfly', habitat: 'meadow', scale: BUTTERFLY_SCALE, colors: [[0.91, 0.23, 0.01]] },
  { id: 'cabbage-white', kind: 'butterfly', habitat: 'meadow', scale: BUTTERFLY_SCALE, colors: [[0.89, 0.89, 0.79]] },
  { id: 'brimstone', kind: 'butterfly', habitat: 'meadow', scale: BUTTERFLY_SCALE, colors: [[0.96, 0.74, 0.07]] },
  { id: 'blue', kind: 'butterfly', habitat: 'meadow', scale: BUTTERFLY_SCALE, colors: [[0.1, 0.27, 0.89]] },
  { id: 'blue-hawker', kind: 'dragonfly', habitat: 'water', scale: DRAGONFLY_SCALE, colors: [[0.01, 0.08, 0.34]] },
  { id: 'red-darter', kind: 'dragonfly', habitat: 'water', scale: DRAGONFLY_SCALE, colors: [[0.34, 0.01, 0.01]] },
]

const BUILTIN_IDS: Record<string, number> = {
  monarch: CRITTER_SPECIES.monarch, 'cabbage-white': CRITTER_SPECIES.cabbageWhite, brimstone: CRITTER_SPECIES.brimstone, blue: CRITTER_SPECIES.blue,
  'blue-hawker': CRITTER_SPECIES.blueHawker, 'red-darter': CRITTER_SPECIES.redDarter,
}

/** A critter species as the shader knows it: one of its species ids. */
export interface CritterSpecies {
  id: string
  dragonfly: boolean
  /** The shader's species id (world0.y). */
  shader: number
}

/**
 * Maps a species to the critter shader's ids: the built-ins by id, a registered one to the built-in whose wing colour is
 * nearest its first colour (the shader paints four butterfly and two dragonfly patterns; no texture).
 */
export function critterSpeciesOf(s: LifeSpecies): CritterSpecies {
  const dragonfly = s.kind === 'dragonfly'
  const known = BUILTIN_IDS[s.id]
  if (known !== undefined) return { id: s.id, dragonfly, shader: known }
  const c = s.colors?.[0]
  let best = dragonfly ? DRAGONFLY_FIRST_SPECIES : 0, bd = Infinity
  if (c) {
    for (const b of BUILTIN_CRITTERS) {
      if ((b.kind === 'dragonfly') !== dragonfly) continue
      const bc = b.colors![0]!
      const d = (bc[0] - c[0]) ** 2 + (bc[1] - c[1]) ** 2 + (bc[2] - c[2]) ** 2
      if (d < bd) {
        bd = d
        best = BUILTIN_IDS[b.id]!
      }
    }
  }
  return { id: s.id, dragonfly, shader: best }
}

export class LifeCritters {
  /** 0..1: the rain fade (crDay.x). */
  activity = 0
  private butterflies: number[] = [0, 1, 2, 3]
  private dragonflies: number[] = [4, 5]
  private readonly tmpB = new Float32Array(MAX_BUTTERFLIES * CANDIDATE_STRIDE)
  private readonly tmpD = new Float32Array(MAX_DRAGONFLIES * CANDIDATE_STRIDE)
  private at = { x: NaN, z: NaN, hour: NaN, nb: -1, nd: -1 }
  private count = 0
  private checkT = CHECK_S
  /** The cells built when last gathered (new cells: gather again). */
  private built = -1

  constructor(readonly mesh: LifeMesh, private readonly crDay: Vector4) {}

  /** The species pools (every registered butterfly and dragonfly species). */
  setSpecies(list: readonly CritterSpecies[]): void {
    const b = list.filter(s => !s.dragonfly).map(s => s.shader)
    const d = list.filter(s => s.dragonfly).map(s => s.shader)
    this.butterflies = b.length ? b : [0]
    this.dragonflies = d.length ? d : [DRAGONFLY_FIRST_SPECIES]
    this.at.hour = NaN
  }

  /** Drops every critter (the part switched off). */
  clear(): void {
    this.count = 0
    this.activity = 0
    this.crDay.x = 0
    this.at = { x: NaN, z: NaN, hour: NaN, nb: -1, nd: -1 }
    this.mesh.commit(0)
  }

  /** Critters drawn now. */
  get drawn(): number {
    return this.mesh.count
  }

  update(dt: number, targets: Pick<LifeTargets, 'butterflies' | 'dragonflies'>, focus: { x: number; z: number }, hour: number, cells: LifeCells): void {
    const nb = Math.min(MAX_BUTTERFLIES, targets.butterflies)
    const nd = Math.min(MAX_DRAGONFLIES, targets.dragonflies)
    const want = nb + nd > 0
    this.activity = Math.max(0, Math.min(1, this.activity + (want ? dt : -dt) / CRITTER_FADE_S))
    this.crDay.x = this.activity
    this.checkT += dt
    if (want && (this.checkT >= CHECK_S || this.count === 0)) {
      this.checkT = 0
      const a = this.at
      const moved = !(Math.hypot(focus.x - a.x, focus.z - a.z) < REANCHOR_M)
      if (moved || hour !== a.hour || nb !== a.nb || nd !== a.nd || cells.built !== this.built) this.anchor(focus, hour, nb, nd, cells)
    }
    if (this.activity <= 0) {
      this.count = 0
      this.at.nb = -1
    }
    this.mesh.commit(this.activity > 0 ? this.count : 0, false)
  }

  private anchor(focus: { x: number; z: number }, hour: number, nb: number, nd: number, cells: LifeCells): void {
    const gb = cells.gather('butterflies', focus.x, focus.z, BUTTERFLY_RANGE_M, hour, nb, this.tmpB)
    const gd = cells.gather('dragonflies', focus.x, focus.z, DRAGONFLY_RANGE_M, hour, nd, this.tmpD)
    const buf = this.mesh.buf
    let k = 0
    const put = (src: Float32Array, i: number, species: number) => {
      const o = k * 16
      const c = i * CANDIDATE_STRIDE
      buf[o] = src[c + 3]!
      buf[o + 1] = species
      buf[o + 2] = src[c + 4]!
      buf[o + 3] = 0
      for (let j = 4; j < 12; j++) buf[o + j] = 0
      buf[o + 12] = src[c]!
      buf[o + 13] = src[c + 1]!
      buf[o + 14] = src[c + 2]!
      buf[o + 15] = 1
      k++
    }
    for (let i = 0; i < gb; i++) {
      // The cell rolled a built-in species (0..3); a registered pool spreads over its own ids by the seed.
      const rolled = this.tmpB[i * CANDIDATE_STRIDE + 5]!
      const pool = this.butterflies
      const species = pool.includes(rolled) && pool.length <= 4 ? rolled : pool[Math.floor((this.tmpB[i * CANDIDATE_STRIDE + 3]! * 7.13 % 1) * pool.length)]!
      put(this.tmpB, i, species)
    }
    for (let i = 0; i < gd; i++) {
      const rolled = this.tmpD[i * CANDIDATE_STRIDE + 5]!
      const pool = this.dragonflies
      put(this.tmpD, i, pool.includes(rolled) ? rolled : pool[Math.floor((this.tmpD[i * CANDIDATE_STRIDE + 3]! * 7.13 % 1) * pool.length)]!)
    }
    this.count = k
    this.built = cells.built
    this.at = { x: focus.x, z: focus.z, hour, nb, nd }
    this.mesh.commit(this.activity > 0 ? k : 0, true)
  }
}
