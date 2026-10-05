/**
 * Play the Boss, steering (docs/PLAY_THE_BOSS.md §3.2, §3.6): the pure parts. The hunt circle clamps every move and
 * ability target radially (the circle is the pull-back: she can never be steered into a town, which lies ≥ 1 km from
 * every camp); the server picks her speed.
 */

/** x/z clamped radially into the circle (a point inside stays as it is). */
export function clampToArea(x: number, z: number, area: { x: number; z: number; r: number }): [number, number] {
  const dx = x - area.x
  const dz = z - area.z
  const d = Math.hypot(dx, dz)
  if (d <= area.r || d < 1e-9) return [x, z]
  const k = area.r / d
  return [area.x + dx * k, area.z + dz * k]
}

/** Her steering speed (m/s): her run speed (walk without one) × the setting × Stalk's multiplier. */
export function steerSpeed(def: { runSpeed: number; walkSpeed: number }, speedMul: number, stalkMul: number | null): number {
  const base = def.runSpeed > 0 ? def.runSpeed : def.walkSpeed
  return base * speedMul * (stalkMul ?? 1)
}

/** The bearing (radians 0..2π, as WeatherSync.windDir: 0 = +X east, π/2 = −Z north) from a point toward another. */
export function bearing(fromX: number, fromZ: number, toX: number, toZ: number): number {
  const a = Math.atan2(-(toZ - fromZ), toX - fromX)
  return a < 0 ? a + Math.PI * 2 : a
}

/** mm:ss of a duration (never negative). */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The pilot's gold (§3.9): base + per down + per steered minute + the win bonus. */
export function rewardGold(r: { baseGold: number; perDownGold: number; perMinuteGold: number; winGold: number }, downs: number, steeredMs: number, won: boolean): number {
  return Math.max(0, Math.round(r.baseGold + r.perDownGold * downs + r.perMinuteGold * Math.floor(steeredMs / 60_000) + (won ? r.winGold : 0)))
}
