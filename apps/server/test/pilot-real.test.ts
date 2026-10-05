/**
 * Play the Boss on the real export (docs/PLAY_THE_BOSS.md §8 layer 2 gate: "Pounce never crosses a wall"): the jangan
 * fields with their navmesh, content/uniques.json and the real skill rows. Tiger Girl is steered by an in-process
 * player; a leap toward a point behind a blocking edge near one of her camps stops where the navmesh walk stops, and
 * her kit resolves completely from the real tables. Skipped without the export.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerMessage } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import type { NavPoint } from '../src/nav.ts'
import { startTestServer, type TestServer } from './helpers.ts'

const OUT = join(REPO_ROOT, 'work/out')
const OUT_OPT = join(REPO_ROOT, 'work/out-opt')
const CONTENT = join(REPO_ROOT, 'content')
const DATA = ['mobs', 'nests', 'items', 'levels', 'drops', 'towns', 'skills', 'masteries'].map((f) => join(OUT, `data/${f}.json`))
const HAVE = (() => {
  const man = join(OUT, 'world/jangan-fields/manifest.json')
  if (!existsSync(man) || !DATA.every((f) => existsSync(f))) return false
  const m = JSON.parse(readFileSync(man, 'utf8')) as { nav?: { file?: string } }
  return typeof m.nav?.file === 'string' && existsSync(join(OUT, 'world/jangan-fields', m.nav.file))
})()

describe.skipIf(!HAVE)('Play the Boss on the real jangan fields', () => {
  let s: TestServer
  beforeAll(async () => {
    s = await startTestServer({ config: { outDir: OUT, outOptDir: OUT_OPT, serveStatic: false, tickHz: 20, worldExport: 'jangan-fields', contentDir: CONTENT, uniques: true, spawnMobs: false } })
  }, 120_000)
  afterAll(async () => {
    await s?.stopAndClean()
  })

  it('her whole kit resolves from the real tables; the trance place is the palace steps', () => {
    const conf = s.ctx.gameplay.pilot!.conf('')
    if (typeof conf === 'string') throw new Error(conf)
    expect(conf.kit.map((k) => k.id)).toEqual(['claw', 'sweep', 'curse', 'pounce', 'roar', 'pack', 'stalk'])
    expect(conf.kit.find((k) => k.id === 'sweep')!.target).toBe('none')
    expect(s.ctx.setup.places.some((p) => p.name === 'palace-steps')).toBe(true)
  })

  it('a Pounce toward a point behind a blocking edge stops where the navmesh walk stops', () => {
    const g = s.ctx.gameplay
    const w = s.ctx.world
    const now = Date.now()
    const inbox: ServerMessage[] = []
    const acc = s.ctx.store.createAccount('pilotreal', 'x')!
    const row = s.ctx.store.createCharacter(acc, 'PilotReal', 'CHAR_CH_WOMAN_ADVENTURER', 'blade', 'jangan', 4)
    if (typeof row === 'string') throw new Error(row)
    const town = g.townPoint()!
    const p = w.add({ ...g.playerInit(s.ctx.store.characterById(row.id)!), characterId: row.id, name: 'PilotReal', model: row.model, level: 20, weapon: 'blade', pos: [town.x, town.y, town.z], surface: town.surface, yaw: 0, send: (m) => inbox.push(m) })
    g.sendEnter(p, now)
    const u = g.uniques!
    // Her camps lie in open fields: look for a blocking edge (a rock, a tree, a wall) inside a camp's hunt circle, from a
    // 10 m grid of open points, and put her there.
    const r = u.gm(null, ['spawn', 'tiger', 'camp', String(u.camps(u.uniques[0].def)[0].id)], now)
    expect(r.ok, r.message).toBe(true)
    const m = [...w.mobs.values()].find((x) => x.def.code === 'MOB_CH_TIGERWOMAN' && x.ai !== 'dead')!
    let found: { from: NavPoint; to: { x: number; z: number }; end: NavPoint } | null = null
    for (let gx = -300; gx <= 300 && !found; gx += 10) {
      for (let gz = -300; gz <= 300 && !found; gz += 10) {
        if (Math.hypot(gx, gz) > 300) continue
        const from = s.ctx.nav.place(m.home[0] + gx, m.home[1] + gz, m.pos[1], 2)
        if (!from) continue
        for (let i = 0; i < 16 && !found; i++) {
          const a = (i / 16) * Math.PI * 2
          const to = { x: from.x + Math.sin(a) * 11.5, z: from.z + Math.cos(a) * 11.5 }
          const walk = s.ctx.nav.walk(from, to.x, to.z)
          if (walk && walk.blocked && Math.hypot(walk.end.x - from.x, walk.end.z - from.z) > 1) found = { from, to, end: walk.end }
        }
      }
    }
    expect(found, 'a blocking edge inside her hunt circle').not.toBeNull()
    const { from, to, end } = found!
    w.warp(m, from.x, from.y, from.z, now, from)
    expect(g.pilot!.attach('', 'PilotReal', now).ok).toBe(true)
    expect(p.viewFrom).toBe(m.id)
    g.request(p, { t: 'pilotAct', ability: 'pounce', x: to.x, z: to.z }, now)
    expect(inbox.filter((x) => x.t === 'actionResult' && x.re === 'pilotAct').at(-1)).toMatchObject({ ok: true })
    expect(m.move!.to[0]).toBeCloseTo(end.x, 3)
    expect(m.move!.to[2]).toBeCloseTo(end.z, 3)
    w.tick(now + 2000)
    const at = w.livePoint(m, now + 2000)
    expect(Math.hypot(at.x - end.x, at.z - end.z)).toBeLessThan(0.01)
    expect(Math.hypot(at.x - to.x, at.z - to.z)).toBeGreaterThan(0.5)
    expect(g.pilot!.detach(now + 2000).ok).toBe(true)
  })
})
