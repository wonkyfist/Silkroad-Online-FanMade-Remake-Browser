import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FIRE_KINDS, fireKindOf, type FireKind, type FireSpot } from '@sro/shared'

/**
 * Fires that warm (docs/WINTER.md §13.1): the world's own fire placements (Jangan's gate fires and braziers, the ruins'
 * fire towers, the lamps and shop lights; winter-play.ts FIRE_SOURCES on the manifest `source` paths) and the winter's
 * campfires. A uniform grid answers `warmest(x, y, z)`. The world manifest is read once, lazily and asynchronously (the
 * same file the lightning rods read); until it is in, only the campfires warm.
 */

/** Grid cell (m): larger than the biggest fire radius. */
const CELL_M = 16
/** A fire warms only within this height of the body (a lamp on a wall above does not). */
const REACH_Y_M = 4

/** The manifest fields the loader reads. */
export interface FireManifest {
  placements: { source: string; position: number[] }[]
}

/** The fires of a manifest (pure). */
export function firesFromManifest(m: FireManifest): FireSpot[] {
  const out: FireSpot[] = []
  for (const p of m.placements) {
    const kind = fireKindOf(p.source)
    const [x, y, z] = p.position
    if (kind && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) out.push({ kind, x: x!, y: y!, z: z! })
  }
  return out
}

export interface Warmest {
  kind: FireKind
  /** Points per second before the admin multiplier. */
  gainPerS: number
  distM: number
}

export class FireIndex {
  private readonly grid = new Map<string, FireSpot[]>()
  readonly counts: Record<FireKind, number> = { campfire: 0, brazier: 0, lamp: 0 }

  constructor(spots: Iterable<FireSpot> = []) {
    for (const s of spots) this.add(s)
  }

  add(s: FireSpot): void {
    const k = `${Math.floor(s.x / CELL_M)},${Math.floor(s.z / CELL_M)}`
    const list = this.grid.get(k)
    if (list) list.push(s)
    else this.grid.set(k, [s])
    this.counts[s.kind]++
  }

  get size(): number {
    return this.counts.campfire + this.counts.brazier + this.counts.lamp
  }

  /** The fire warming (x, y, z) the most, or null when none reaches it. */
  warmest(x: number, y: number, z: number): Warmest | null {
    const cx = Math.floor(x / CELL_M)
    const cz = Math.floor(z / CELL_M)
    let best: Warmest | null = null
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const s of this.grid.get(`${cx + i},${cz + j}`) ?? []) {
          const f = FIRE_KINDS[s.kind]
          const d = Math.hypot(s.x - x, s.z - z)
          if (d > f.radiusM || Math.abs(s.y - y) > REACH_Y_M) continue
          if (!best || f.gainPerS > best.gainPerS || (f.gainPerS === best.gainPerS && d < best.distM)) best = { kind: s.kind, gainPerS: f.gainPerS, distM: d }
        }
      }
    }
    return best
  }
}

/** Reads the world's fire placements from OUT_DIR(-opt)/world/<folder>/manifest.json (first that parses). */
export async function loadWorldFires(dirs: readonly string[], folder: string): Promise<{ fires: FireSpot[]; problem: string }> {
  let problem = 'no world manifest'
  for (const dir of dirs) {
    const file = join(dir, 'world', folder, 'manifest.json')
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    try {
      const m = JSON.parse(text) as FireManifest
      if (!Array.isArray(m.placements)) {
        problem = `${file} has no placements`
        continue
      }
      return { fires: firesFromManifest(m), problem: '' }
    } catch (e) {
      problem = `${file}: ${(e as Error).message}`
    }
  }
  return { fires: [], problem }
}
