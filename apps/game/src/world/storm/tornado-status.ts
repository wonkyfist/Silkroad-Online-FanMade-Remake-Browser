/**
 * What the weather icon says about a tornado (docs/WEATHER.md §13.7): the tornado feature publishes where the funnel is
 * from you, the storm feature's icon and tooltip read it. One module-level slot, cleared when the feature goes.
 */

export const COMPASS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const
export type Compass = (typeof COMPASS)[number]

export interface TornadoInfo {
  phase: 'warning' | 'active' | 'lifting'
  /** Horizontal distance from you (m) and the way to it. */
  distM: number
  dir: Compass
  /** Seconds to touchdown (warning only). */
  touchInS: number
  area?: string
}

let source: (() => TornadoInfo | null) | null = null

/** The tornado feature's reader (null clears it). */
export function setTornadoSource(fn: (() => TornadoInfo | null) | null): void {
  source = fn
}

/** The tornado as the icon shows it, or null. */
export function tornadoInfo(): TornadoInfo | null {
  try {
    return source?.() ?? null
  } catch {
    return null
  }
}

/** The compass point of a glTF offset (dx east, dz south: north is −Z). */
export function compass(dx: number, dz: number): Compass {
  const a = Math.atan2(dx, -dz)
  const i = Math.round(a / (Math.PI / 4))
  return COMPASS[((i % 8) + 8) % 8]!
}
