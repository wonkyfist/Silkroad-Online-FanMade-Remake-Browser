/**
 * H-11 lens 13 (docs/WAVE_PLAN7.md §6.6): placement errors of the living town, against the real export
 * (work/out/world/jangan-fields) and the content files. Each `it` is one finding; they fail until F-11 fixes them.
 *
 * - P1: walkers float above or sink into the ground on ramps and stairs: the schedule interpolates the height linearly
 *   between the graph's nodes (schedule.ts walk legs, crowd.ts uses a finite `y` as is), but many edges cross a slope
 *   break, so the drawn height leaves the navmesh by up to ~2 m (TOWN_LIFE §3.4: feet on the ground).
 * - P2: a chat ring's standing spots all take the ring centre's height: on stepped ground a chatter hovers or is buried.
 * - P3: the hens' yard (town/index.ts plazaStandIn, r 4 m at (165, −155)) straddles a retail wall (cj_etc_wall02):
 *   hens walk inside it.
 * - P4: the cat's straight legs between its fixed spots cut through TL-B's plaza planter at (108.55, −74.96).
 * - P5: the 0.6 m sidestep (crowd.ts SIDESTEP_M) exceeds the graph's 0.4 m clearance: a sidestepping walker enters a
 *   house wall.
 * Skipped without an export.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TownDressingFile, TownFile } from '../../shared/src/town.ts'
import { JANGAN_GRAPH, dressingRows, loadTownNav, type DressingRow, type TownNav } from '../src/town/build-graph.ts'
import { REPO_ROOT, loadConfig } from '../src/node-io.ts'
import { TownSchedule } from '../../world-render/src/town/schedule.ts'
import { AnimalSchedule } from '../../world-render/src/town/animals.ts'
import { SIDESTEP_M } from '../../world-render/src/town/crowd.ts'
import { ScheduleAdapter, plazaStandIn } from '../../world-render/src/town/index.ts'

const FILE = JSON.parse(readFileSync(join(REPO_ROOT, 'content/town/jangan.json'), 'utf8')) as TownFile
const DRESSING = JSON.parse(readFileSync(join(REPO_ROOT, 'content/town/jangan-dressing.json'), 'utf8')) as TownDressingFile
const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const worldDir = hasConfig ? join(loadConfig().workDir, 'out', 'world', 'jangan-fields') : ''
const hasExport = hasConfig && existsSync(join(worldDir, 'nav.bin'))

/** A drawn townsperson may be this far (m) above or below the walkable surface it stands on. */
const HEIGHT_TOL_M = 0.3

describe.skipIf(!hasExport)('H-11 placements on the export (lens 13)', () => {
  let cache: { nav: TownNav; rows: DressingRow[] } | null = null
  const load = () => {
    if (cache) return cache
    const { nav, manifest } = loadTownNav(worldDir, JANGAN_GRAPH)
    cache = { nav, rows: dressingRows(DRESSING, manifest) }
    return cache
  }
  const nodes = new Map(FILE.graph.nodes.map((n) => [n.id, n]))
  const isHouse = (key: string) => JANGAN_GRAPH.buildingKey.test(key) && !JANGAN_GRAPH.notBuildingKey.test(key.split('/').pop()!)

  it('P1: a walker\'s height (linear between the nodes) stays on the walkable surface along every graph edge', () => {
    const { nav } = load()
    const bad: string[] = []
    for (const e of FILE.graph.edges) {
      const a = nodes.get(e.a)!
      const b = nodes.get(e.b)!
      if (a.y === undefined || b.y === undefined) continue
      const len = Math.hypot(b.x - a.x, b.z - a.z)
      const steps = Math.max(1, Math.ceil(len / 0.5))
      let prev = a.y
      let worst = 0
      let at = ''
      for (let i = 0; i <= steps; i++) {
        const f = i / steps
        const x = a.x + (b.x - a.x) * f
        const z = a.z + (b.z - a.z) * f
        const drawn = a.y + (b.y - a.y) * f
        // F-11: the visible surface (TownNav.surfaceAt), not locateIn alone: where an object's floor is laid over the
        // terrain (n576-n612's 0.45 m deck), locateIn from the lower side keeps following the hidden terrain under it
        const p = nav.surfaceAt(x, z, prev)
        if (!p) continue
        prev = p.y
        if (Math.abs(drawn - p.y) > Math.abs(worst)) {
          worst = drawn - p.y
          at = `(${x.toFixed(1)}, ${z.toFixed(1)}) drawn ${drawn.toFixed(2)} ground ${p.y.toFixed(2)}`
        }
      }
      if (Math.abs(worst) > HEIGHT_TOL_M) bad.push(`${e.a}-${e.b}: ${worst > 0 ? 'floats' : 'sinks'} ${Math.abs(worst).toFixed(2)} m at ${at}`)
    }
    // found: 200+ edges, 48 of them by more than 1 m (n911-n890 by the stable sinks 1.9 m; n174-n201 by the temple floats 1.95 m)
    expect(bad, bad.slice(0, 12).join('\n')).toEqual([])
  }, 120_000)

  it('P2: every chat-ring and pond-edge standing spot is at its own ground height', () => {
    const { nav } = load()
    const bad: string[] = []
    for (const p of FILE.places) {
      for (const [i, s] of (p.seats ?? []).entries()) {
        if (s.pose !== 'stand' || s.y === undefined) continue
        const g = nav.g.locate(s.x, s.z, s.y)
        if (g && Math.abs(g.y - s.y) > 0.2) bad.push(`${p.id} spot ${i} at (${s.x}, ${s.z}): y ${s.y}, ground ${g.y.toFixed(2)}`)
      }
    }
    // found: chat-2 (16 m from the spawn) spot 3 hovers 0.66 m, spot 1 is 0.44 m under the paving; chat-13/14/17; pond-1/2
    expect(bad, bad.join('\n')).toEqual([])
  }, 60_000)

  const animals = () => {
    const folk = new ScheduleAdapter(new TownSchedule(FILE))
    const base = plazaStandIn({ manifest: { name: 'jangan-fields' } } as never)!
    const plan = { ...base.animals!, dogOwner: folk.agents.findIndex((a) => a.role === 'walker') }
    return { plan, schedule: new AnimalSchedule(plan, folk), kinds: (s: AnimalSchedule) => (s as unknown as { kind: string[] }).kind }
  }
  const pose = () => ({ x: 0, y: Number.NaN, z: 0, yaw: 0, clip: '', clipT: 0, rate: 1, distM: Number.NaN, speed: 0, alpha: 1 })
  const T0 = Date.UTC(2026, 9, 1, 12) / 1000

  it('P3: no hen ever stands inside a retail wall or building (a whole hour)', () => {
    const { nav } = load()
    const { schedule, kinds } = animals()
    const p = pose()
    const inside = new Map<string, number>()
    let ex = ''
    for (let t = T0; t < T0 + 3600; t += 1) {
      const q = { nowS: t, solarT: 0.5, alarmFromS: 0, alarmUntilS: 0, rain: 0 }
      schedule.agents.forEach((_, i) => {
        if (kinds(schedule)[i] !== 'hen' || !schedule.pose(i, q, p)) return
        const g = nav.g.locate(p.x, p.z, Infinity)
        const sol = nav.solids.at(p.x, p.z, g ? g.y : 0)
        if (sol < 0) return
        const key = nav.solids.key[sol]!.split('/').pop()!
        inside.set(key, (inside.get(key) ?? 0) + 1)
        ex ||= `hen ${i} at (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) in ${key}`
      })
    }
    // found: ~3 % of hen-seconds inside cj_etc_wall02 at (167.5, −152.4); the yard is also 1.0 m from a walkers' edge
    expect([...inside], ex).toEqual([])
  }, 60_000)

  it('P4: the cat never walks through a dressing prop (its legs are straight lines between fixed spots)', () => {
    const { rows } = load()
    const { schedule, kinds } = animals()
    const p = pose()
    const solid = rows.filter((r) => r.max[1] - r.min[1] > 0.3)
    const inProp = (x: number, z: number) => solid.find((r) => {
      const dx = x - r.x
      const dz = z - r.z
      const c = Math.cos(r.yaw)
      const s = Math.sin(r.yaw)
      const lx = dx * c - dz * s
      const lz = dx * s + dz * c
      return lx > r.min[0] && lx < r.max[0] && lz > r.min[2] && lz < r.max[2]
    })
    const hits: string[] = []
    for (let t = T0; t < T0 + 3600; t += 1) {
      const q = { nowS: t, solarT: 0.5, alarmFromS: 0, alarmUntilS: 0, rain: 0 }
      schedule.agents.forEach((_, i) => {
        if (kinds(schedule)[i] !== 'cat' || !schedule.pose(i, q, p)) return
        const r = inProp(p.x, p.z)
        if (r) hits.push(`cat ${p.clip} at (${p.x.toFixed(2)}, ${p.z.toFixed(2)}) inside ${r.name} at (${r.x}, ${r.z})`)
      })
    }
    // found: every lap, ~15 s inside the plaza planter at (108.55, −74.96) on the leg (75, −70) → (124, −76)
    expect(hits.length, hits.slice(0, 3).join('\n')).toBe(0)
  }, 60_000)

  it('P5: a walker sidestepping by SIDESTEP_M on any graph edge stays out of the houses', () => {
    const { nav } = load()
    const bad: string[] = []
    for (const e of FILE.graph.edges) {
      const a = nodes.get(e.a)!
      const b = nodes.get(e.b)!
      const len = Math.hypot(b.x - a.x, b.z - a.z)
      if (len < 1e-6) continue
      const nx = -(b.z - a.z) / len
      const nz = (b.x - a.x) / len
      const steps = Math.max(1, Math.ceil(len / 0.5))
      for (let i = 0; i <= steps; i++) {
        const x = a.x + ((b.x - a.x) * i) / steps
        const z = a.z + ((b.z - a.z) * i) / steps
        const p = nav.g.locateIn(x, z, Infinity, nav.home)
        if (!p) continue
        const hit = [SIDESTEP_M, -SIDESTEP_M].map((s) => {
          const qx = x + nx * s
          const qz = z + nz * s
          const q = nav.g.locate(qx, qz, p.y)
          const sol = nav.solids.at(qx, qz, q ? q.y : p.y)
          return sol >= 0 && isHouse(nav.solids.key[sol]!) ? `(${qx.toFixed(1)}, ${qz.toFixed(1)}) in ${nav.solids.key[sol]!.split('/').pop()}` : ''
        }).find((s) => s)
        if (hit) {
          bad.push(`${e.a}-${e.b}: ${hit}`)
          break
        }
      }
    }
    // found: n837-p1 by the tea house: (−63.0, −52.0) inside cj_resta01_wall01
    expect(bad).toEqual([])
  }, 120_000)
})
