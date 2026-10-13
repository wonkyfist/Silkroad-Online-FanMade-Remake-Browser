import type { SkillDef } from '@sro/shared'
import type { NavPoint, NavProvider } from '../nav.ts'

/**
 * Movement skills: the retail `tele` param (Ghost Walk - Phantom, SKILL_CH_LIGHTNING_GYEONGGONG_B_01..10:
 * `tele [500, 100..190]`). args[0] is the travel time in ms, args[1] the reach in decimetres (10 m at level 1, 19 m at
 * level 10). The caster glides to the clicked ground point (at most the reach), or straight ahead along its facing at
 * the full reach when no point is given. The server picks the end: the straight navmesh walk toward it (it stops at a
 * wall, a cliff edge or the world bounds) and never into water.
 */
export interface TeleParams {
  /** Travel time (ms). */
  ms: number
  /** Reach (metres). */
  maxM: number
}

const MIN_MS = 100
const MAX_MS = 2000
/** Water is sampled along the dash every this many metres. */
const WATER_STEP_M = 0.5

export function teleParams(row: Pick<SkillDef, 'params'> | undefined): TeleParams | null {
  const a = row?.params?.find((p) => p.tag === 'tele')?.args
  if (!a) return null
  const ms = Math.min(MAX_MS, Math.max(MIN_MS, a[0] ?? 500))
  return { ms, maxM: Math.max(0, (a[1] ?? 0) / 10) }
}

/**
 * Where a dash from `from` ends: toward `aim` [x, z] (at most `maxM`), else `maxM` ahead along `yaw`
 * (yaw = atan2(dx, dz)). `clamp` keeps the goal in the world bounds; `wet` cuts the dash before the first water.
 */
export function dashEnd(
  nav: NavProvider,
  from: NavPoint,
  yaw: number,
  aim: readonly [number, number] | undefined,
  maxM: number,
  clamp: (x: number, z: number) => [number, number] = (x, z) => [x, z],
  wet: (x: number, z: number, y: number) => boolean = () => false,
): NavPoint {
  let dx = Math.sin(yaw)
  let dz = Math.cos(yaw)
  let len = maxM
  if (aim) {
    const ax = aim[0] - from.x
    const az = aim[1] - from.z
    const d = Math.hypot(ax, az)
    if (d > 0.05) {
      dx = ax / d
      dz = az / d
      len = Math.min(d, maxM)
    }
  }
  const [gx, gz] = clamp(from.x + dx * len, from.z + dz * len)
  let end = nav.walk(from, gx, gz)?.end ?? from
  // never into water: stop at the last dry sample before the first wet one
  const run = Math.hypot(end.x - from.x, end.z - from.z)
  const at = (k: number): [number, number, number] => [from.x + (end.x - from.x) * k, from.z + (end.z - from.z) * k, from.y + (end.y - from.y) * k]
  for (let s = Math.min(WATER_STEP_M, run); run > 0; s = Math.min(s + WATER_STEP_M, run)) {
    const [x, z, y] = at(s / run)
    if (wet(x, z, y)) {
      const back = Math.max(0, s - WATER_STEP_M) / run
      const [bx, bz] = at(back)
      end = back > 0 ? (nav.walk(from, bx, bz)?.end ?? from) : from
      break
    }
    if (s >= run) break
  }
  return end
}
