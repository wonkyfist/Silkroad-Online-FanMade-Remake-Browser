import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT } from '../config.ts'
import { PLACES_FILE, REGION_SIZE_M, parsePlaceRows, regionAt, resolveWorld, withTownSpawn } from '../content.ts'
import { GameData } from '../gamedata.ts'
import { MeshNav, type NavPoint } from '../nav.ts'
import { placeProblem, snapOpen } from '../places.ts'
import { World } from '../world.ts'

/**
 * The places tool: re-snaps the computed rows of content/places.json on the real world export and checks every row by
 * the server's startup rule (places.ts checkPlaces).  pnpm --filter @sro/server places [--write]
 *
 * A row with a `snap` gets its x/y/z (and `source`) from it; a row without one is hand-authored and only checked:
 * - { near: [x, z], radius?, y? }: the nearest open point to x/z (town spots, default radius 15 m);
 * - { area: '<zones.json name>', aboveSeaM? }: the nearest open point to the mean centre of the area's regions that
 *   lies in the area itself (by the GM `where` name) and, with aboveSeaM, that far above the coast's sea level;
 * - { nest: <nest id>, radius? }: the nearest open point to a nest's centre (the boss camps, default radius 40 m).
 * "Open" (snapOpen): standing by the placement rule in the town spawn's walkable component, an open terrain cell, and
 * 1.5 m of standing ground all around. Without --write it only prints the report. Exit code 1 when a row fails.
 */

type Out = (line: string) => void

interface Snap {
  near?: [number, number]
  y?: number
  radius?: number
  area?: string
  aboveSeaM?: number
  /** With area: its shore (the lowest open point above the sea level) rather than the point nearest its centre. */
  shore?: boolean
  nest?: number
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d

/** An area place keeps this far inside the world bounds (not against the edge of the walkable world). */
const AREA_MARGIN_M = 16

export function runPlacesTool(argv: string[], env: NodeJS.ProcessEnv = process.env, out: Out = console.log, err: Out = console.error): number {
  const write = argv.includes('--write')
  const outDir = resolve(env.OUT_DIR || join(REPO_ROOT, 'work/out'))
  const folder = env.WORLD_EXPORT || 'jangan-fields'
  const worldId = env.WORLD || 'jangan'
  const file = join(resolve(env.CONTENT_DIR || join(REPO_ROOT, 'content')), PLACES_FILE)

  const data = GameData.load(outDir)
  const setup = withTownSpawn(resolveWorld(outDir, folder, null, worldId), worldId, data.town(worldId))
  const { nav, problem } = MeshNav.load([outDir], folder)
  if (!nav) {
    err(`No navmesh for ${folder} in ${outDir}: ${problem}`)
    return 1
  }
  const world = new World(worldId, 5.5, 20, setup.bounds, nav)
  const manifest = JSON.parse(readFileSync(join(outDir, 'world', folder, 'manifest.json'), 'utf8')) as {
    coast?: { seaLevelM?: number }
    regions?: { x: number; z: number; origin?: number[]; blocks?: { bx: number; bz: number; water: { heightM: number } | null }[] }[]
  }
  const seaLevel = manifest.coast?.seaLevelM ?? 5
  // Retail water (rivers, ponds, lakes): per 32 m terrain block of each region, its water plane's height.
  const water = new Map<string, number>()
  for (const r of manifest.regions ?? []) {
    if (!r.origin) continue
    for (const bl of r.blocks ?? []) if (bl.water) water.set(`${r.x},${r.z},${bl.bx},${bl.bz}`, bl.water.heightM)
  }
  /** Not under a water plane: no water block there, or the point stands at least 5 cm above it. */
  const dry = (p: NavPoint): boolean => {
    const at = regionAt(setup.regionOrigin, p.x, p.z)
    if (!at || !setup.regionOrigin) return true
    const x0 = (at.rx - setup.regionOrigin.ox) * REGION_SIZE_M
    const z0 = -(at.rz - setup.regionOrigin.oz) * REGION_SIZE_M
    const h = water.get(`${at.rx},${at.rz},${Math.floor((p.x - x0) / 32)},${Math.floor((z0 - p.z) / 32)}`)
    return h === undefined || p.y >= h + 0.05
  }
  const origin = setup.regionOrigin
  if (!origin) {
    err(`${folder}: the manifest has no origin region`)
    return 1
  }

  /** Inside the world bounds with a metre to spare (the ring regions beyond them have navmesh too). */
  const b = setup.bounds
  const inBounds = (x: number, z: number, m: number) => !b || (x >= b.minX + m && x <= b.maxX - m && z >= b.minZ + m && z <= b.maxZ - m)

  const doc = JSON.parse(readFileSync(file, 'utf8')) as { places: Record<string, unknown>[] }
  let failed = 0
  for (const row of doc.places) {
    const snap = row.snap as Snap | undefined
    const name = String(row.name)
    if (snap) {
      const r = snapRow(snap)
      if (!r) {
        failed++
        err(`${name}: no open point for ${JSON.stringify(snap)}`)
        continue
      }
      Object.assign(row, { x: round(r.p.x, 1), y: round(r.p.y, 2), z: round(r.p.z, 1), source: r.source })
    }
    const why = placeProblem({ x: Number(row.x), z: Number(row.z), y: typeof row.y === 'number' ? row.y : undefined }, world, nav)
    const zone = data.zoneName(Number(row.x), Number(row.z), origin)
    if (why) {
      failed++
      err(`${name}: ${why}`)
    } else out(`${name.padEnd(32)} ${String(row.group).padEnd(7)} ${Number(row.x).toFixed(1).padStart(8)} ${Number(row.z).toFixed(1).padStart(8)}  ${zone}${row.source ? `  (${row.source})` : ''}`)
  }
  const parsed = parsePlaceRows(doc.places)
  for (const p of parsed.problems) err(p)
  if (write) {
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
    out(`wrote ${file}`)
  }
  return failed > 0 || parsed.problems.length > 0 ? 1 : 0

  function snapRow(snap: Snap): { p: NavPoint; source: string } | null {
    if (snap.near) {
      const [x, z] = snap.near
      const p = snapOpen(nav!, x, z, { radius: snap.radius ?? 15, yHint: snap.y, accept: dry })
      return p && { p, source: `snapped from ${x}, ${z}: ${Math.hypot(p.x - x, p.z - z).toFixed(1)} m` }
    }
    if (snap.nest !== undefined) {
      const nest = data.nests.find((n) => n.id === snap.nest)
      if (!nest) return null
      const p = snapOpen(nav!, nest.x, nest.z, { radius: snap.radius ?? 40, accept: dry })
      return p && { p, source: `nest ${nest.id} (${nest.mob}): ${Math.hypot(p.x - nest.x, p.z - nest.z).toFixed(1)} m from its centre` }
    }
    if (snap.area) {
      const area = snap.area
      const regions = [...data.zones.values()].filter((zd) => zd.name === area)
      if (regions.length === 0) return null
      // region rx spans x from (rx - ox) * 192; region rz spans z from -(rz - oz) * 192 southwards (z runs south)
      const cx = regions.reduce((s, r) => s + (r.rx - origin!.ox + 0.5) * REGION_SIZE_M, 0) / regions.length
      const cz = regions.reduce((s, r) => s - (r.rz - origin!.oz + 0.5) * REGION_SIZE_M, 0) / regions.length
      const minY = snap.aboveSeaM === undefined ? -Infinity : seaLevel + snap.aboveSeaM
      const opts = {
        where: (x: number, z: number) => inBounds(x, z, AREA_MARGIN_M) && data.zoneName(x, z, origin) === area,
        accept: (q: NavPoint) => q.y >= minY && dry(q),
      }
      if (snap.shore && b) {
        // The beach, not the cliff top behind it: the lowest open point of the area above the sea level, a metre of
        // height weighed as 50 m of distance from the area's mean centre (4 m grid over the bounds).
        let best: { p: NavPoint; score: number } | null = null
        for (let x = b.minX + AREA_MARGIN_M; x <= b.maxX - AREA_MARGIN_M; x += 4) {
          for (let z = b.minZ + AREA_MARGIN_M; z <= b.maxZ - AREA_MARGIN_M; z += 4) {
            if (!opts.where(x, z)) continue
            const p = snapOpen(nav!, x, z, { ...opts, radius: 0 })
            const score = p ? p.y - minY + Math.hypot(p.x - cx, p.z - cz) / 50 : Infinity
            if (p && (!best || score < best.score)) best = { p, score }
          }
        }
        return best && { p: best.p, source: `area '${area}' (${regions.length} regions): its shore, the lowest open point in it ${snap.aboveSeaM} m or more above the sea level (${(best.p.y - seaLevel).toFixed(1)} m), ${Math.hypot(best.p.x - cx, best.p.z - cz).toFixed(0)} m from its mean centre` }
      }
      const p = snapOpen(nav!, cx, cz, { ...opts, radius: 1500, step: 2 })
      const above = snap.aboveSeaM === undefined ? '' : `, at least ${snap.aboveSeaM} m above the sea level`
      return p && { p, source: `area '${area}' (${regions.length} regions): the nearest open point in it to its mean centre${above}, ${Math.hypot(p.x - cx, p.z - cz).toFixed(1)} m away` }
    }
    return null
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runPlacesTool(process.argv.slice(2))
}
