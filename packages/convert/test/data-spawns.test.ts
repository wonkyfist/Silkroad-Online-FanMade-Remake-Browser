/**
 * Adversarial check of the exported monster nests (work/out/data/nests.json) against ground truth that does not
 * come from the exporter's own frame fit:
 *  - the client's terrain navmesh (Data.pk2 navmesh/nv_*.nvm) and object collision navmeshes (buildings, walls);
 *  - the world converter's nav.bin (work/out/world/jangan), read through @sro/nav's own glTF frame;
 *  - mirrored / rotated / shifted / rescaled alternatives of the port -> world transform, which must all lose;
 *  - the port's own reference points (teleporters, town safe box) against client NPC positions and the town walls;
 *  - community geography: Tiger Girl's 11 published spawn points (game coordinates, ZsZc wiki "Unique Hunting"),
 *    the South Gate soldier at (6429, 967) (Jangan quest guides), low levels at the gates, levels rising outwards.
 * Skips without sro.config.json, the port data folder or the export output.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { NVM_PLANE_SIZE, NVM_PLANE_TYPE, NVM_PLANES, NVM_TILE_SIZE, NVM_TILES, nvmTerrainHeightAt, parseNvm, parseObjectIfo, type NvmFile } from '@sro/formats'
import { NavGltf, NavWorld, buildNavData, createObjectNavMeshResolver, decodeNavData } from '@sro/nav'
import { defaultPortDataDir } from '../src/data/port-source.ts'
import { loadConfig, openArchive, REPO_ROOT } from '../src/node-io.ts'

const hasConfig = existsSync(join(REPO_ROOT, 'sro.config.json'))
const cfg = hasConfig ? loadConfig() : undefined
const portDir = cfg ? (process.env.SRO_PORT_DATA ?? defaultPortDataDir(cfg.clientDir)) : ''
const dataDir = cfg ? join(cfg.workDir, 'out', 'data') : ''
const navBin = cfg ? join(cfg.workDir, 'out', 'world', 'jangan', 'nav.bin') : ''
const ready = !!cfg && existsSync(join(portDir, 'spawns.json')) && existsSync(join(dataDir, 'nests.json')) && existsSync(join(dataDir, 'towns.json'))

interface Nest {
  id: number
  mob: string
  x: number
  y?: number
  z: number
  region: number
  radius: number
  spawnRadius: number
  count: number
  respawnSec: [number, number]
  uniqueGroup?: string
  inConvertedRegion: boolean
  source: { x: number; z: number; y?: number }
}
interface PortNest { nestId: number; vsroCode: string; x: number; y: number; z: number }
interface Town { spawn: { x: number; y: number; z: number }; safeArea: { x: number; z: number; halfX: number; halfZ: number } }

// Written out independently of frame.ts: port units = 1.5 x SRO game metres; game X = 192 (rx - 135) + lx / 10,
// game Y (north) = 192 (rz - 92) + lz / 10; world (manifest, origin region 168 x 97): x = X - 192 * 33,
// z = -(Y - 192 * 5), metres, z south.
const PORT_SCALE = 1.5
const WORLD_DX = 192 * (168 - 135)
const WORLD_DZ = 192 * (97 - 92)
type Game = { X: number; Y: number; h: number }
const portToGame = (p: { x: number; z: number; y?: number }): Game => ({ X: p.x / PORT_SCALE, Y: p.z / PORT_SCALE, h: (p.y ?? 0) / PORT_SCALE })
const gameToWorld = (g: { X: number; Y: number }) => ({ x: g.X - WORLD_DX, z: -(g.Y - WORLD_DZ) })
const worldToGame = (w: { x: number; z: number }) => ({ X: w.x + WORLD_DX, Y: WORLD_DZ - w.z })
/** Global client file units (dm from region (0, 0)). */
const gameToFile = (g: { X: number; Y: number }) => ({ x: (g.X + 135 * 192) * 10, z: (g.Y + 92 * 192) * 10 })

/** Tiger Girl spawn points as published by players (game X, Y), ZsZc wiki "Unique Hunting". */
const TIGER_GIRL_COMMUNITY: Array<[number, number]> = [
  [4853.28, 93.81], [4733.48, -34.13], [4840.09, -122.9], [5038.67, -28.31], [4230.09, 201.44], [4417.63, 599.15],
  [4743.93, 414.49], [5334.82, 359.96], [5354.91, -223.6], [4544.17, -302.55], [4309.47, -151.37],
]

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T
const quantile = (v: number[], q: number) => {
  const s = [...v].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * q))]!
}
function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0])
    const r = new Array<number>(v.length)
    for (let i = 0; i < idx.length; ) {
      let j = i
      while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++
      for (let k = i; k <= j; k++) r[idx[k]![1]] = (i + j) / 2
      i = j + 1
    }
    return r
  }
  const ra = rank(a)
  const rb = rank(b)
  const ma = ra.reduce((s, x) => s + x, 0) / ra.length
  const mb = rb.reduce((s, x) => s + x, 0) / rb.length
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < ra.length; i++) {
    sab += (ra[i]! - ma) * (rb[i]! - mb)
    saa += (ra[i]! - ma) ** 2
    sbb += (rb[i]! - mb) ** 2
  }
  return sab / Math.sqrt(saa * sbb)
}

describe.skipIf(!ready)('monster nests vs independent ground truth (client navmesh, nav.bin, community maps)', () => {
  let nests: Nest[]
  let portNests: PortNest[]
  let town: Town
  let level: Map<string, number>
  let npcs: Map<string, { x: number; z: number; teleports?: string[] }>
  let nav: NavWorld
  /** Terrain probe of the raw client .nvm files, lazily per region (any region, for the alternative frames). */
  let probe: (X: number, Y: number) => { open: boolean; h: number; water: number } | undefined

  beforeAll(() => {
    nests = readJson<{ entries: Nest[] }>(join(dataDir, 'nests.json')).entries
    portNests = readJson<Record<string, PortNest[]>>(join(portDir, 'spawns.json')).jangan_province!
    town = readJson<{ entries: Town[] }>(join(dataDir, 'towns.json')).entries[0]!
    level = new Map(readJson<{ entries: Array<{ code: string; level: number }> }>(join(dataDir, 'mobs.json')).entries.map(m => [m.code, m.level]))
    npcs = new Map(readJson<{ entries: Array<{ code: string; x: number; z: number; teleports?: string[] }> }>(join(dataDir, 'npcs.json')).entries.map(n => [n.code, n]))

    const data = openArchive('Data', cfg)
    const read = (p: string) => {
      const f = data.get(p)
      return f ? data.read(f) : undefined
    }
    const nvmCache = new Map<number, NvmFile | null>()
    const nvmOf = (id: number) => {
      if (!nvmCache.has(id)) {
        const b = read(`navmesh/nv_${id.toString(16).padStart(4, '0')}.nvm`)
        nvmCache.set(id, b ? parseNvm(b) : null)
      }
      return nvmCache.get(id)!
    }
    probe = (X, Y) => {
      const f = gameToFile({ X, Y })
      const rx = Math.floor(f.x / 1920)
      const rz = Math.floor(f.z / 1920)
      const nvm = rx >= 0 && rz >= 0 && rx < 256 && rz < 128 ? nvmOf((rz << 8) | rx) : null
      if (!nvm) return undefined
      const lx = f.x - rx * 1920
      const lz = f.z - rz * 1920
      const cell = nvm.tileCells[Math.min(NVM_TILES - 1, Math.floor(lz / NVM_TILE_SIZE)) * NVM_TILES + Math.min(NVM_TILES - 1, Math.floor(lx / NVM_TILE_SIZE))]!
      let water = -Infinity
      if (nvm.planeTypes && nvm.planeHeights) {
        const i = Math.min(NVM_PLANES - 1, Math.floor(lz / NVM_PLANE_SIZE)) * NVM_PLANES + Math.min(NVM_PLANES - 1, Math.floor(lx / NVM_PLANE_SIZE))
        if (nvm.planeTypes[i] === NVM_PLANE_TYPE.water || nvm.planeTypes[i] === NVM_PLANE_TYPE.waterIce) water = nvm.planeHeights[i]! / 10
      }
      return { open: cell >= 0 && cell < nvm.openCellCount, h: nvmTerrainHeightAt(nvm, lx, lz) / 10, water }
    }

    // Terrain + object collision navmeshes of every region holding a nest, and its neighbours.
    const ids = new Set<number>()
    for (const n of nests) {
      const f = gameToFile(worldToGame(n))
      const rx = Math.floor(f.x / 1920)
      const rz = Math.floor(f.z / 1920)
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) ids.add(((rz + dz) << 8) | (rx + dx))
    }
    const regions = [...ids].flatMap(id => {
      const nvm = nvmOf(id)
      return nvm ? [{ id, nvm }] : []
    })
    const ifo = parseObjectIfo(read('navmesh/object.ifo')!)
    nav = new NavWorld(buildNavData({ regions, objectNavMesh: createObjectNavMeshResolver(ifo, read) }))
  })

  it('reproduces every nest position from the port record with an independently written transform', () => {
    expect(nests).toHaveLength(portNests.length)
    const byId = new Map(portNests.map(p => [p.nestId, p]))
    let maxErr = 0
    for (const n of nests) {
      const p = byId.get(n.id)!
      expect(p.vsroCode, String(n.id)).toBe(n.mob)
      const g = portToGame(p)
      const w = gameToWorld(g)
      maxErr = Math.max(maxErr, Math.abs(w.x - n.x), Math.abs(w.z - n.z), Math.abs(g.h - (n.y ?? NaN)))
      const f = gameToFile(g)
      expect(n.region, String(n.id)).toBe((Math.floor(f.z / 1920) << 8) | Math.floor(f.x / 1920))
    }
    expect(maxErr).toBeLessThan(0.001)
  })

  it('puts nest centres on open client terrain at the terrain height, outside buildings (object navmeshes)', () => {
    const closed: string[] = []
    const onObject: string[] = []
    const dy: number[] = []
    for (const n of nests) {
      const f = gameToFile(worldToGame(n))
      const yFile = (n.y ?? 0) * 10
      if (!nav.terrainOpen(f.x, f.z)) closed.push(`${n.id} ${n.mob}`)
      dy.push(Math.abs(nav.terrainHeight(f.x, f.z) / 10 - (n.y ?? NaN)))
      const at = nav.locate(f.x, f.z, yFile)
      if (at && at.surface.kind === 'object') onObject.push(`${n.id} ${n.mob} ${nav.instanceInfo(at.surface.instance).model}`)
    }
    // Measured: only nest 5498 (Bandit), whose centre is under a bandit-village house (cj_thiefvill_01_01); its
    // 40 m spawn radius is open ground. The server must settle spawn points on open cells anyway.
    expect(closed).toEqual(['5498 MOB_CH_BANDIT'])
    expect(onObject.map(s => s.split(' ')[0])).toEqual(['5498'])
    expect(quantile(dy, 0.5)).toBeLessThan(0.01)
    expect(quantile(dy, 0.99)).toBeLessThan(0.1)
    expect(quantile(dy, 1)).toBeLessThan(1)
  })

  it.skipIf(!existsSync(navBin))('stands the nests inside the converted regions on the world converter nav.bin (glTF frame)', () => {
    const g = new NavGltf(new NavWorld(decodeNavData(new Uint8Array(readFileSync(navBin)))), { x: 168, z: 97 })
    const inside = nests.filter(n => n.inConvertedRegion)
    expect(inside.length).toBe(8)
    for (const n of inside) {
      const at = g.locate(n.x, n.z, n.y ?? 0)
      expect(at?.surface.kind, String(n.id)).toBe('terrain')
      expect(Math.abs(at!.y - n.y!), String(n.id)).toBeLessThan(0.05)
    }
    // Town spawn: on the plaza, y = terrain height (teleportdata stores 0).
    const s = g.locate(town.spawn.x, town.spawn.z, town.spawn.y)
    expect(s).not.toBeNull()
    expect(Math.abs(s!.y - town.spawn.y)).toBeLessThan(0.1)
  })

  it('beats every mirrored, rotated, shifted and rescaled alternative of the port -> world transform', () => {
    const pts = portNests.map(p => ({ ...portToGame(p), rawY: p.y, rawX: p.x, rawZ: p.z }))
    const cx = pts.reduce((a, p) => a + p.X, 0) / pts.length
    const cy = pts.reduce((a, p) => a + p.Y, 0) / pts.length
    type P = (typeof pts)[number]
    const alts: Record<string, (p: P) => Game> = {
      chosen: p => p,
      'mirror X': p => ({ ...p, X: 2 * cx - p.X }),
      'mirror Z': p => ({ ...p, Y: 2 * cy - p.Y }),
      'rotate 180': p => ({ ...p, X: 2 * cx - p.X, Y: 2 * cy - p.Y }),
      'swap X/Z': p => ({ ...p, X: cx + (p.Y - cy), Y: cy + (p.X - cx) }),
      'rotate 90': p => ({ ...p, X: cx - (p.Y - cy), Y: cy + (p.X - cx) }),
      'X +1 region': p => ({ ...p, X: p.X + 192 }),
      'X -1 region': p => ({ ...p, X: p.X - 192 }),
      'Z +1 region': p => ({ ...p, Y: p.Y + 192 }),
      'Z -1 region': p => ({ ...p, Y: p.Y - 192 }),
      'X +20 m': p => ({ ...p, X: p.X + 20 }),
      'Z +20 m': p => ({ ...p, Y: p.Y + 20 }),
      'X +5 m': p => ({ ...p, X: p.X + 5 }),
      'Z -5 m': p => ({ ...p, Y: p.Y - 5 }),
      'port units = metres': p => ({ X: p.rawX, Y: p.rawZ, h: p.rawY }),
      'x1.5 about centroid': p => ({ X: cx + (p.X - cx) * 1.5, Y: cy + (p.Y - cy) * 1.5, h: p.h }),
      'height not /1.5': p => ({ ...p, h: p.rawY }),
    }
    const score: Record<string, { probed: number; open: number; within50cm: number; medianDy: number }> = {}
    for (const [name, f] of Object.entries(alts)) {
      let probed = 0
      let open = 0
      let near = 0
      const dys: number[] = []
      for (const p of pts) {
        const q = f(p)
        const t = probe(q.X, q.Y)
        if (!t) continue
        probed++
        if (t.open) open++
        const d = Math.abs(t.h - q.h)
        dys.push(d)
        if (d < 0.5) near++
      }
      score[name] = { probed, open: open / pts.length, within50cm: near / pts.length, medianDy: quantile(dys, 0.5) }
    }
    const { chosen, ...others } = score
    expect(chosen!.probed).toBe(pts.length)
    expect(chosen!.within50cm).toBeGreaterThan(0.99)
    expect(chosen!.medianDy).toBeLessThan(0.01)
    for (const [name, s] of Object.entries(others)) {
      expect(s.within50cm, name).toBeLessThan(0.7)
      expect(s.within50cm, name).toBeLessThan(chosen!.within50cm - 0.3)
    }
    for (const name of ['mirror X', 'mirror Z', 'rotate 180', 'swap X/Z', 'rotate 90', 'X +1 region', 'X -1 region', 'Z +1 region', 'Z -1 region', 'port units = metres', 'x1.5 about centroid', 'height not /1.5']) {
      expect(score[name]!.within50cm, name).toBeLessThan(0.11)
    }
  })

  it("places the port's own reference points (teleporters, safe box) on the client's Jangan gates and walls", () => {
    const tele = readJson<{ zones: Record<string, Array<{ id: string; x: number; z: number }>> }>(join(portDir, 'teleporters.json')).zones.jangan_province ?? []
    let matched = 0
    for (const t of tele) {
      const w = gameToWorld(portToGame(t))
      if (t.id === 'gate_ch') {
        // The Jangan gate portal itself: the client's GATE_CH arrival point (town spawn) is next to it.
        expect(Math.hypot(w.x - town.spawn.x, w.z - town.spawn.z)).toBeLessThan(40)
        continue
      }
      const npc = [...npcs.values()].find(n => n.teleports?.includes(t.id.toUpperCase()))
      if (!npc) continue
      expect(Math.hypot(w.x - npc.x, w.z - npc.z), t.id).toBeLessThan(0.01)
      // The mirrored frame would put the same teleporter far away.
      const m = gameToWorld({ X: 2 * 5737 - portToGame(t).X, Y: portToGame(t).Y })
      expect(Math.hypot(m.x - npc.x, m.z - npc.z), t.id).toBeGreaterThan(100)
      matched++
    }
    expect(matched).toBeGreaterThanOrEqual(6)
    // The port's safe box hugs the client's town walls: each gate soldier (npcpos.txt) stands within 25 m outside
    // the box edge that faces its gate, and the box holds the whole town (spawn, shops).
    const b = town.safeArea
    const edge = { south: b.z + b.halfZ, north: b.z - b.halfZ, east: b.x + b.halfX, west: b.x - b.halfX }
    const so = npcs.get('NPC_CH_SOLDIER_SO1')!
    const ea = npcs.get('NPC_CH_SOLDIER_EA1')!
    const we = npcs.get('NPC_CH_SOLDIER_WE1')!
    expect(so.z - edge.south).toBeGreaterThan(0)
    expect(so.z - edge.south).toBeLessThan(25)
    expect(ea.x - edge.east).toBeGreaterThan(-25)
    expect(ea.x - edge.east).toBeLessThan(25)
    expect(edge.west - we.x).toBeGreaterThan(-25)
    expect(edge.west - we.x).toBeLessThan(25)
    for (const code of ['NPC_CH_SMITH', 'NPC_CH_POTION', 'NPC_CH_ARMOR', 'NPC_CH_ACCESSORY']) {
      const n = npcs.get(code)!
      expect(Math.abs(n.x - b.x) < b.halfX && Math.abs(n.z - b.z) < b.halfZ, code).toBe(true)
    }
    expect(Math.abs(town.spawn.x - b.x) < b.halfX && Math.abs(town.spawn.z - b.z) < b.halfZ).toBe(true)
    // No nest inside the safe box; the nearest nest centre is > 50 m outside it.
    const margin = nests.map(n => Math.max(Math.abs(n.x - b.x) - b.halfX, Math.abs(n.z - b.z) - b.halfZ))
    expect(Math.min(...margin)).toBeGreaterThan(50)
    // Community: Soldier Jingyo (South Gate) at (6429, 967).
    const jg = worldToGame(so)
    expect(Math.hypot(jg.X - 6429, jg.Y - 967)).toBeLessThan(5)
  })

  it('matches community geography: Tiger Girl camps, Mangyang at the gates, levels rising outwards, WC mobs toward Donwhang', () => {
    // Tiger Girl: all 11 published camps, each matched by one nest to within 5 cm (a mirror or shift cannot do this).
    const tg = nests.filter(n => n.mob === 'MOB_CH_TIGERWOMAN').map(n => worldToGame(n))
    expect(tg).toHaveLength(TIGER_GIRL_COMMUNITY.length)
    const used = new Set<number>()
    for (const [X, Y] of TIGER_GIRL_COMMUNITY) {
      const i = tg.findIndex(g => Math.hypot(g.X - X, g.Y - Y) < 0.05)
      expect(i, `${X} ${Y}`).toBeGreaterThanOrEqual(0)
      used.add(i)
    }
    expect(used.size).toBe(TIGER_GIRL_COMMUNITY.length)

    const gates = ['NPC_CH_SOLDIER_SO1', 'NPC_CH_SOLDIER_EA1', 'NPC_CH_SOLDIER_WE1'].map(c => npcs.get(c)!)
    const gateDist = (n: Nest) => Math.min(...gates.map(g => Math.hypot(n.x - g.x, n.z - g.z)))
    const byMob = new Map<string, number[]>()
    for (const n of nests) byMob.set(n.mob, [...(byMob.get(n.mob) ?? []), gateDist(n)])
    const median = new Map([...byMob].map(([k, v]) => [k, quantile(v, 0.5)]))
    // Mangyang (lv 1): the nearest mob to the gates, south / east / west of town, none north of it.
    const mang = median.get('MOB_CH_MANGNYANG')!
    for (const [k, v] of median) if (k !== 'MOB_CH_MANGNYANG') expect(v, k).toBeGreaterThan(mang)
    expect(mang).toBeLessThan(350)
    const b = town.safeArea
    for (const n of nests.filter(x => x.mob === 'MOB_CH_MANGNYANG')) expect(n.z, String(n.id)).toBeGreaterThan(b.z - b.halfZ)
    // Level rises with distance from the gates.
    const rho = spearman(nests.map(n => level.get(n.mob)!), nests.map(gateDist))
    expect(rho).toBeGreaterThan(0.8)
    // West China mobs (lv 21+) lie toward Donwhang: west and north of Jangan (world -x, -z).
    const west = gates[2]!
    const wc = nests.filter(x => x.mob.startsWith('MOB_WC_') && x.mob !== 'MOB_WC_HYEONGCHEON')
    for (const n of wc) {
      expect(n.x, String(n.id)).toBeLessThan(west.x - 1000)
      expect(n.z, String(n.id)).toBeLessThan(b.z + b.halfZ)
    }
    expect(wc.reduce((a, n) => a + n.z, 0) / wc.length).toBeLessThan(b.z - 300)
    // Water ghosts sit under the client's water planes far more often than any other mob.
    let wg = 0
    let wgWet = 0
    let other = 0
    let otherWet = 0
    for (const n of nests) {
      const g = worldToGame(n)
      const t = probe(g.X, g.Y)!
      const wet = t.water > t.h
      if (n.mob.startsWith('MOB_CH_WATERGHOST')) {
        wg++
        if (wet) wgWet++
      } else {
        other++
        if (wet) otherWet++
      }
    }
    expect(wgWet / wg).toBeGreaterThan(0.3)
    expect(otherWet / other).toBeLessThan(0.02)
  })

  it('has unique nest ids and sane counts, radii and respawn times', () => {
    expect(new Set(nests.map(n => n.id)).size).toBe(nests.length)
    const total = nests.reduce((a, n) => a + n.count, 0)
    expect(total).toBe(7156)
    const perRegion = new Map<number, number>()
    for (const n of nests) perRegion.set(n.region, (perRegion.get(n.region) ?? 0) + n.count)
    expect(Math.max(...perRegion.values())).toBeLessThan(200)
    for (const n of nests) {
      const id = String(n.id)
      expect(n.count, id).toBeGreaterThanOrEqual(1)
      expect(n.count, id).toBeLessThanOrEqual(15)
      expect(n.radius, id).toBeGreaterThanOrEqual(10)
      expect(n.radius, id).toBeLessThanOrEqual(100)
      expect(n.spawnRadius, id).toBeLessThanOrEqual(n.radius)
      const [lo, hi] = n.respawnSec
      expect(lo, id).toBeLessThanOrEqual(hi)
      if (n.uniqueGroup) {
        expect(n.count, id).toBe(1)
        expect([lo, hi], id).toEqual([10800, 21600])
      } else {
        expect(lo, id).toBeGreaterThanOrEqual(8)
        expect(hi, id).toBeLessThanOrEqual(600)
      }
    }
    expect(nests.filter(n => n.uniqueGroup).every(n => n.mob === 'MOB_CH_TIGERWOMAN')).toBe(true)
  })
})
