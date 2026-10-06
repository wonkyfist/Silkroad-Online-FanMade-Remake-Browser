/**
 * Siege of Jangan, layer 2: the repair scaffolding (docs/SIEGE.md §2.2, §9.2) as pure data. A timber frame against a
 * third's face: standards (poles) every 2.5 m in two rows, ledgers and plank decks every 2 m up to the wall walk, short
 * transoms tying the rows to the wall, and a diagonal brace per bay at the ends. view.ts draws every beam as one thin
 * instance of a unit timber (one draw call for all scaffolds).
 */
import type { WallsSegment, WallsSideInfo } from '@sro/shared'
import { acrossAt, depthOf, euler, seedOf, sideXZ, type GroundAt } from './rubble.ts'
import { mulberry32 } from '@sro/shared'

export interface Beam {
  /** Centre (m). */
  x: number
  y: number
  z: number
  q: [number, number, number, number]
  /** Length (along the beam's x), height, depth (m). */
  s: [number, number, number]
}

export const SCAFFOLD = {
  /** Pole spacing along the face, row distances off the face (m), lift height (m). */
  bay: 2.5,
  rows: [0.9, 2.2] as const,
  lift: 2,
  pole: 0.16,
  ledger: 0.12,
  plank: [1.5, 0.06] as const,
} as const

/**
 * The beams on one face (`outer` true: the field side) of third `k`. The frame stops a little below the wall walk and
 * every pole stands on the ground under it.
 */
export function scaffoldBeams(seg: WallsSegment, k: number, side: WallsSideInfo, outer: boolean, ground: GroundAt): Beam[] {
  const t = seg.thirds[k]!
  const rnd = mulberry32(seedOf(t.id, outer ? 0x5caf : 0x5cae))
  const depth = depthOf(side)
  const base = side.placement.position[1]
  const top = side.walkY - 0.6
  // w outward from the inner face: the outer face is at w = depth, the inner at 0
  const wOf = (off: number) => (outer ? depth + off : -off)
  const along0 = t.from + 0.6, along1 = t.to - 0.6
  const n = Math.max(1, Math.round((along1 - along0) / SCAFFOLD.bay))
  const yawAlong = side.axis === 'x' ? 0 : -Math.PI / 2
  const yawAcross = side.axis === 'x' ? -Math.PI / 2 : 0
  const out: Beam[] = []
  const g = (along: number, w: number) => {
    const [x, z] = sideXZ(side, along, acrossAt(side, w))
    const h = ground(x, z)
    return Number.isFinite(h) ? h : base
  }
  const lowest = Math.min(g(along0, wOf(SCAFFOLD.rows[0])), g(along1, wOf(SCAFFOLD.rows[1])))
  // standards
  for (let i = 0; i <= n; i++) {
    const along = along0 + ((along1 - along0) * i) / n
    for (const off of SCAFFOLD.rows) {
      const [x, z] = sideXZ(side, along, acrossAt(side, wOf(off)))
      const y0 = g(along, wOf(off))
      const len = top - y0
      out.push({ x, y: y0 + len / 2, z, q: euler(0, 0, Math.PI / 2 + (rnd() - 0.5) * 0.02), s: [len, SCAFFOLD.pole, SCAFFOLD.pole] })
    }
  }
  // ledgers, decks and transoms per lift
  const len = along1 - along0
  const mid = (along0 + along1) / 2
  for (let y = lowest + SCAFFOLD.lift; y < top; y += SCAFFOLD.lift) {
    for (const off of SCAFFOLD.rows) {
      const [x, z] = sideXZ(side, mid, acrossAt(side, wOf(off)))
      out.push({ x, y, z, q: euler(0, yawAlong, 0), s: [len + 0.3, SCAFFOLD.ledger, SCAFFOLD.ledger] })
    }
    const deckOff = (SCAFFOLD.rows[0] + SCAFFOLD.rows[1]) / 2
    const [dx, dz] = sideXZ(side, mid, acrossAt(side, wOf(deckOff)))
    out.push({ x: dx, y: y + 0.09, z: dz, q: euler(0, yawAlong, 0), s: [len, SCAFFOLD.plank[1], SCAFFOLD.plank[0]] })
    for (let i = 0; i <= n; i += 2) {
      const along = along0 + ((along1 - along0) * i) / n
      const [x, z] = sideXZ(side, along, acrossAt(side, wOf(SCAFFOLD.rows[1] / 2 + 0.05)))
      out.push({ x, y: y - 0.12, z, q: euler(0, yawAcross, 0), s: [SCAFFOLD.rows[1] + 0.4, SCAFFOLD.ledger, SCAFFOLD.ledger] })
    }
  }
  // a diagonal brace across the end bays of the outer row
  for (const i of [0, n - 1]) {
    if (i < 0) continue
    const a0 = along0 + ((along1 - along0) * i) / n
    const a1 = along0 + ((along1 - along0) * (i + 1)) / n
    for (let y = lowest; y + SCAFFOLD.lift * 2 <= top; y += SCAFFOLD.lift * 2) {
      const [x, z] = sideXZ(side, (a0 + a1) / 2, acrossAt(side, wOf(SCAFFOLD.rows[1] + 0.12)))
      const dy = SCAFFOLD.lift * 2, da = a1 - a0
      const l = Math.hypot(dy, da)
      const pitchUp = Math.atan2(dy, da)
      out.push({ x, y: y + dy / 2, z, q: braceQ(side, pitchUp), s: [l, 0.1, 0.1] })
    }
  }
  return out
}

/** A brace leaning up along the axis: the beam's x along the wall, tilted up by `angle`. */
function braceQ(side: Pick<WallsSideInfo, 'axis'>, angle: number): [number, number, number, number] {
  // roll lifts the beam's x toward +y, then the yaw turns it to run along z for the W and E walls
  return euler(0, side.axis === 'x' ? 0 : -Math.PI / 2, angle)
}
