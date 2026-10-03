/**
 * Fireflies (docs/GRASS_LIFE.md §5.4; lane GL-L): one mesh, one draw, additive glow billboards whose drift and blink
 * the vertex shader computes (life/shaders.ts). None by day; from night 0.3 they fade in, and at night 60 (Medium) to
 * 120 (High) of them float over the grass within 40 m of the focus, gathering near trees and water (life/spawn.ts);
 * rain above 0.1 (a drizzle keeps them) or wind above 10 m/s puts them out, fading over 3 s.
 *
 * Instance record: world0 = (seed, 0, 0, 0), world3 = the anchor on the ground (x, y, z, 1). ffParams = (the light
 * 0..1, the size FIREFLY_SIZE_M, the gain 6 in display units × 1 / exposure: the night-light rule, 0).
 */
import type { Vector4 } from '@babylonjs/core'
import type { LifeMesh, LifeTargets } from './life.ts'
import { CANDIDATE_STRIDE, type LifeCells } from './spawn.ts'

export const MAX_FIREFLIES = 120
/**
 * The glow quad's half size (m): the prototype's 0.07 read as a speck at the game camera's 7–9 m in the in-game check
 * (a few lit at a time, the blink is a sharp pulse); a little larger reads as a firefly.
 */
export const FIREFLY_SIZE_M = 0.09
export const FIREFLY_RANGE_M = 40
const FADE_S = 3
const REANCHOR_M = 8
const CHECK_S = 0.5

export class LifeFireflies {
  /** 0..1 (ffParams.x): the light, following the night and the rain. */
  light = 0
  private readonly tmp = new Float32Array(MAX_FIREFLIES * CANDIDATE_STRIDE)
  private at = { x: NaN, z: NaN, hour: NaN, n: -1 }
  private count = 0
  private checkT = CHECK_S
  /** The cells built when last gathered (new cells: gather again). */
  private built = -1

  constructor(readonly mesh: LifeMesh, private readonly ffParams: Vector4) {}

  clear(): void {
    this.count = 0
    this.light = 0
    this.ffParams.x = 0
    this.at = { x: NaN, z: NaN, hour: NaN, n: -1 }
    this.mesh.commit(0)
  }

  update(dt: number, targets: Pick<LifeTargets, 'fireflies' | 'fireflyLight'>, focus: { x: number; z: number }, hour: number, cells: LifeCells): void {
    const n = Math.min(MAX_FIREFLIES, targets.fireflies)
    const goal = n > 0 ? targets.fireflyLight : 0
    const step = dt / FADE_S
    this.light = this.light < goal ? Math.min(goal, this.light + step) : Math.max(goal, this.light - step)
    this.ffParams.x = this.light
    this.checkT += dt
    if (n > 0 && (this.checkT >= CHECK_S || this.count === 0)) {
      this.checkT = 0
      const a = this.at
      if (!(Math.hypot(focus.x - a.x, focus.z - a.z) < REANCHOR_M) || hour !== a.hour || n !== a.n || cells.built !== this.built) this.anchor(focus, hour, n, cells)
    }
    if (this.light <= 0) {
      this.count = 0
      this.at.n = -1
    }
    this.mesh.commit(this.light > 0 ? this.count : 0, false)
  }

  private anchor(focus: { x: number; z: number }, hour: number, n: number, cells: LifeCells): void {
    const got = cells.gather('fireflies', focus.x, focus.z, FIREFLY_RANGE_M, hour, n, this.tmp)
    const buf = this.mesh.buf
    for (let i = 0; i < got; i++) {
      const o = i * 16
      const c = i * CANDIDATE_STRIDE
      buf[o] = this.tmp[c + 3]!
      for (let j = 1; j < 12; j++) buf[o + j] = 0
      buf[o + 12] = this.tmp[c]!
      buf[o + 13] = this.tmp[c + 1]!
      buf[o + 14] = this.tmp[c + 2]!
      buf[o + 15] = 1
    }
    this.count = got
    this.built = cells.built
    this.at = { x: focus.x, z: focus.z, hour, n }
    this.mesh.commit(this.light > 0 ? got : 0, true)
  }
}
