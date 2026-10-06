import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SIEGE_APPROACHES,
  checkSiegeLanes,
  outward,
  type SiegeApproach,
  type SiegeLanesContent,
  type Vec3,
  type WallStage,
  type WallsExport,
  type XZ,
} from '@sro/shared'

/**
 * Siege of Jangan, layer 4: the lanes (docs/SIEGE.md §6.3). content/siege/jangan.json `siege` names, per approach, a
 * muster and per target segment the outer waypoints (to a staging point 30 m in front of it) and the inner ones (from
 * the gap's rally point to the Town Bell). Monsters walk the straight legs; nobody pathfinds. At start every lane is
 * walked on the server's nav:
 *
 * - outer: muster → … → staging, each leg a clear straight walk (all walls standing);
 * - the foot: staging → the segment's assault point ends at the wall (the ditch rim: within FOOT_M of the outer face);
 * - the gap: with that segment breached, the foot → the rally point is clear;
 * - inner: rally → … → the Bell, each leg clear.
 *
 * A lane with a failing leg is dropped (logged, shown on the admin page); an approach without lanes is not used.
 */

/** The walk toward the assault point must end this close to the outer face (m): the rim of the ditch. */
export const FOOT_M = 14
/** A leg counts as walked when it ends this close to its target (m). */
export const LEG_EPS_M = 1

export interface Lane {
  approach: SiegeApproach
  seg: string
  /** muster, then the outer waypoints; the last one is the staging point. */
  outer: XZ[]
  /** The foot of the wall the monsters walk toward (the assault point, 2 m outside the outer face) and its height. */
  assault: Vec3
  /** Where the walk toward the assault point ends (the ditch rim). */
  foot: XZ
  rally: XZ
  /** rally excluded, the Bell excluded. */
  inner: XZ[]
  /** +1 / -1 outward across the wall, and the axis (for spreading along the wall). */
  axis: 'x' | 'z'
  out: 1 | -1
}

export interface ApproachLanes {
  approach: SiegeApproach
  name: string
  muster: XZ
  lanes: Lane[]
  dropped: { seg: string; why: string }[]
}

export interface LaneWalker {
  /** The straight walk a→b on the nav now: whether it got there (within LEG_EPS_M, not blocked) and where it ended. */
  walk(a: XZ, b: XZ): { ok: boolean; end: XZ } | null
  /** Runs `fn` with segment `seg` at `stage` on the nav (then puts the nav back). */
  withStage<T>(seg: string, stage: WallStage, fn: () => T): T
}

/** content/siege/jangan.json `siege`, or null with why. */
export function readSiegeLanes(contentDir: string | undefined): { content: SiegeLanesContent | null; problem: string } {
  if (!contentDir) return { content: null, problem: 'no CONTENT_DIR' }
  const file = join(contentDir, 'siege', 'jangan.json')
  if (!existsSync(file)) return { content: null, problem: `${file} is missing` }
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as { siege?: unknown }
    if (v.siege === undefined) return { content: null, problem: `${file} has no siege lanes` }
    const problems = checkSiegeLanes(v.siege)
    if (problems.length) return { content: null, problem: `${file}: ${problems.slice(0, 3).join('; ')}` }
    return { content: v.siege as SiegeLanesContent, problem: '' }
  } catch (e) {
    return { content: null, problem: `${file}: ${(e as Error).message}` }
  }
}

/** The lanes of `content` that walk on the nav (`w`); the rest dropped with why. */
export function validateLanes(content: SiegeLanesContent, walls: Pick<WallsExport, 'segments' | 'sides'>, w: LaneWalker): ApproachLanes[] {
  const out: ApproachLanes[] = []
  const sides = new Map(walls.sides.map((s) => [s.side, s]))
  for (const approach of SIEGE_APPROACHES) {
    const a = content.approaches[approach]
    if (!a) continue
    const al: ApproachLanes = { approach, name: a.name, muster: a.muster, lanes: [], dropped: [] }
    for (const [seg, l] of Object.entries(a.lanes)) {
      const s = walls.segments.find((x) => x.id === seg)
      const side = s && sides.get(s.side)
      if (!s || !side) {
        al.dropped.push({ seg, why: 'no such segment in walls.json' })
        continue
      }
      const why = (() => {
        const outer: XZ[] = [a.muster, ...l.outer]
        for (let i = 0; i + 1 < outer.length; i++) {
          const r = w.walk(outer[i]!, outer[i + 1]!)
          if (!r?.ok) return `outer leg ${i + 1} (${fmt(outer[i]!)} → ${fmt(outer[i + 1]!)}) is blocked${r ? ` at ${fmt(r.end)}` : ''}`
        }
        const t = s.thirds[1]
        const assault: XZ = [t.assault[0], t.assault[2]]
        const staging = outer[outer.length - 1]!
        const foot = w.walk(staging, assault)
        if (!foot) return 'the staging point is off the nav'
        const face = side.axis === 'x' ? Math.abs(foot.end[1] - side.outer) : Math.abs(foot.end[0] - side.outer)
        if (face > FOOT_M) return `the walk to the wall stops ${face.toFixed(1)} m from it`
        const rally: XZ = [t.rally[0], t.rally[2]]
        const gap = w.withStage(seg, 'breached', () => w.walk(foot.end, rally))
        if (!gap?.ok) return 'the way through the gap is blocked'
        const inner: XZ[] = [rally, ...l.inner, content.bell]
        for (let i = 0; i + 1 < inner.length; i++) {
          const r = w.walk(inner[i]!, inner[i + 1]!)
          if (!r?.ok) return `inner leg ${i + 1} (${fmt(inner[i]!)} → ${fmt(inner[i + 1]!)}) is blocked${r ? ` at ${fmt(r.end)}` : ''}`
        }
        al.lanes.push({ approach, seg, outer, assault: [...t.assault], foot: foot.end, rally, inner: [...l.inner], axis: side.axis, out: side.out })
        return ''
      })()
      if (why) al.dropped.push({ seg, why })
    }
    out.push(al)
  }
  return out
}

const fmt = (p: XZ) => `${p[0].toFixed(0)},${p[1].toFixed(0)}`

/** A point `d` m along the wall from `p` (the lane's axis), and `o` m outward. */
export function alongWall(lane: Pick<Lane, 'axis' | 'out'>, p: XZ, d: number, o = 0): XZ {
  const q: XZ = lane.axis === 'x' ? [p[0] + d, p[1]] : [p[0], p[1] + d]
  return o ? outward({ axis: lane.axis, out: lane.out }, q, o) : q
}
