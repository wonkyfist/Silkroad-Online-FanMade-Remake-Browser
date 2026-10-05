import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Lightning rods (docs/WEATHER.md §2.7): the tall things of the world a strike prefers, found once from the world
 * export the server already serves (OUT_DIR/world/<WORLD_EXPORT>/manifest.json, the file resolveWorld reads):
 *
 * - **Trees**: a placement whose source lies under a `tree` folder of `res\nature` (or is a `tre_*` model) and whose
 *   model is at least TREE_MIN_M tall. The rod is the crown top (placement y + model top × scale) over the trunk's foot
 *   (the placement's own point: retail trees stand on their origin).
 * - **Walls**: a placement named like a wall (`*_wall*`, `orwall`, or Jangan's four outer walls `jangan_enter\cj_[nsew]`)
 *   whose model box is long (length ≥ 3 × height). Rods are sampled along its long axis every WALL_STEP_M; each takes
 *   its height from the navmesh's highest surface there (the wall walk: 19.5 m on Jangan's walls), and a sample with no
 *   surface at least WALL_MIN_M above the ground is dropped (no guessed tops).
 * - **Towers**: any other placement at least TOWER_MIN_M tall whose footprint is narrower than 0.8 × its height; the
 *   rod is the top of its box centre.
 *
 * The index is a uniform grid (ROD_CELL_M) for `near(x, z, r)`. Loading is lazy and asynchronous (a 6.5 MB manifest on
 * jangan-fields): the service starts it when a storm approaches or a GM strikes, and strikes before it is ready simply
 * see no rods.
 */

export type RodKind = 'tree' | 'wall' | 'tower'

export interface Rod {
  kind: RodKind
  /** glTF metres: the strike point (crown top, wall walk, tower top). */
  x: number
  y: number
  z: number
  /** Height of the ground under it (m): the trunk's or the tower's foot, the wall's foot. */
  ground: number
}

export const TREE_MIN_M = 4
export const WALL_MIN_M = 6
export const WALL_STEP_M = 12
export const TOWER_MIN_M = 20
export const ROD_CELL_M = 32

const TREE_SOURCE = /\\tree\d*\\|\\tre_|_tree\d/i
const WALL_SOURCE = /_wall|orwall|\\jangan_enter\\cj_[nsew]\.bsr$/i

/** The parts of a world manifest (packages/convert world/manifest.ts) the classifier reads. */
export interface RodManifest {
  models: { boundsMin: number[]; boundsMax: number[] }[]
  placements: { source: string; models: number[]; position: number[]; rotation: number[]; scale?: number }[]
}

/** Heights the wall sampler asks: the highest surface at x/z (the navmesh), or null. */
export type TopAt = (x: number, z: number) => number | null

/** Rotates (x, y, z) by the quaternion q = [x, y, z, w]. */
function rotate(q: readonly number[], x: number, y: number, z: number): [number, number, number] {
  const [qx = 0, qy = 0, qz = 0, qw = 1] = q
  // v' = v + 2w (q × v) + 2 q × (q × v)
  const cx = qy * z - qz * y
  const cy = qz * x - qx * z
  const cz = qx * y - qy * x
  const dx = qy * cz - qz * cy
  const dy = qz * cx - qx * cz
  const dz = qx * cy - qy * cx
  return [x + 2 * (qw * cx + dx), y + 2 * (qw * cy + dy), z + 2 * (qw * cz + dz)]
}

/** The union box of a placement's models (model space, m), or null. */
function boxOf(m: RodManifest, models: readonly number[]): { min: number[]; max: number[] } | null {
  let min: number[] | null = null
  let max: number[] | null = null
  for (const i of models) {
    const mod = m.models[i]
    if (!mod || mod.boundsMin.length < 3 || mod.boundsMax.length < 3) continue
    min = min ? min.map((v, k) => Math.min(v, mod.boundsMin[k]!)) : [...mod.boundsMin]
    max = max ? max.map((v, k) => Math.max(v, mod.boundsMax[k]!)) : [...mod.boundsMax]
  }
  return min && max ? { min, max } : null
}

/** The manifest's lightning rods (pure: the caller passes the parsed manifest and the navmesh's highest surface). */
export function rodsFromManifest(m: RodManifest, topAt: TopAt): Rod[] {
  const out: Rod[] = []
  for (const p of m.placements ?? []) {
    if (!p || typeof p.source !== 'string' || !Array.isArray(p.position) || p.position.length < 3) continue
    const box = boxOf(m, p.models ?? [])
    if (!box) continue
    const s = typeof p.scale === 'number' && p.scale > 0 ? p.scale : 1
    const q = Array.isArray(p.rotation) && p.rotation.length === 4 ? p.rotation : [0, 0, 0, 1]
    const [px, py, pz] = p.position as [number, number, number]
    const height = box.max[1]! * s
    const ex = (box.max[0]! - box.min[0]!) * s
    const ez = (box.max[2]! - box.min[2]!) * s
    if (TREE_SOURCE.test(p.source)) {
      if (height >= TREE_MIN_M) out.push({ kind: 'tree', x: px, y: py + height, z: pz, ground: py })
      continue
    }
    const long = Math.max(ex, ez)
    if (WALL_SOURCE.test(p.source) && height >= WALL_MIN_M && long >= 3 * height) {
      const alongX = ex >= ez
      const cx = (box.min[0]! + box.max[0]!) / 2
      const cz = (box.min[2]! + box.max[2]!) / 2
      const from = alongX ? box.min[0]! : box.min[2]!
      const steps = Math.max(1, Math.floor(long / WALL_STEP_M))
      for (let i = 0; i <= steps; i++) {
        const u = from + ((i + 0.5) / (steps + 1)) * (long / s)
        const [lx, , lz] = rotate(q, (alongX ? u : cx) * s, 0, (alongX ? cz : u) * s)
        const x = px + lx
        const z = pz + lz
        const top = topAt(x, z)
        if (top === null || !Number.isFinite(top) || top < py + WALL_MIN_M) continue
        out.push({ kind: 'wall', x, y: top, z, ground: py })
      }
      continue
    }
    if (height >= TOWER_MIN_M && long <= 0.8 * height) {
      const [lx, , lz] = rotate(q, ((box.min[0]! + box.max[0]!) / 2) * s, 0, ((box.min[2]! + box.max[2]!) / 2) * s)
      out.push({ kind: 'tower', x: px + lx, y: py + height, z: pz + lz, ground: py })
    }
  }
  return out
}

/** Rods on a uniform grid. */
export class RodIndex {
  private readonly cells = new Map<string, Rod[]>()
  readonly counts: Record<RodKind, number> = { tree: 0, wall: 0, tower: 0 }

  constructor(readonly rods: readonly Rod[], private readonly cell = ROD_CELL_M) {
    for (const r of rods) {
      const k = this.key(Math.floor(r.x / cell), Math.floor(r.z / cell))
      let list = this.cells.get(k)
      if (!list) this.cells.set(k, (list = []))
      list.push(r)
      this.counts[r.kind]++
    }
  }

  private key(cx: number, cz: number): string {
    return `${cx},${cz}`
  }

  /** Rods within `r` metres of (x, z) (horizontal distance). */
  near(x: number, z: number, r: number): Rod[] {
    const out: Rod[] = []
    const c = this.cell
    for (let cx = Math.floor((x - r) / c); cx <= Math.floor((x + r) / c); cx++) {
      for (let cz = Math.floor((z - r) / c); cz <= Math.floor((z + r) / c); cz++) {
        for (const rod of this.cells.get(this.key(cx, cz)) ?? []) if ((rod.x - x) ** 2 + (rod.z - z) ** 2 <= r * r) out.push(rod)
      }
    }
    return out
  }

  /** The nearest rod of `kind` within `r` of (x, z), or null. */
  nearest(x: number, z: number, r: number, kind?: RodKind): Rod | null {
    let best: Rod | null = null
    let bd = Infinity
    for (const rod of this.near(x, z, r)) {
      if (kind && rod.kind !== kind) continue
      const d = (rod.x - x) ** 2 + (rod.z - z) ** 2
      if (d < bd) {
        bd = d
        best = rod
      }
    }
    return best
  }
}

/**
 * Reads the world manifest of `folder` from the first of `dirs` that has one and classifies its rods. null (with the
 * reason) when there is no manifest or it cannot be read.
 */
export async function loadRods(dirs: readonly string[], folder: string, topAt: TopAt): Promise<{ index: RodIndex | null; problem: string }> {
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
      const m = JSON.parse(text) as RodManifest
      if (!Array.isArray(m.models) || !Array.isArray(m.placements)) {
        problem = `${file} has no models/placements`
        continue
      }
      return { index: new RodIndex(rodsFromManifest(m, topAt)), problem: '' }
    } catch (e) {
      problem = `${file}: ${(e as Error).message}`
    }
  }
  return { index: null, problem }
}
