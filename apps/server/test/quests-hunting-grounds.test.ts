/**
 * Hunting grounds of "The Tiger's Shadow" on the play export (NEWPLAYER playtest, apps/server/test/soak/newplayer.ts).
 *
 * A player hunts where the quest points: the tracker names the hint location and the minimap draws its circle
 * (apps/game/src/quests/markers.ts). The CT rule "a nest within 150 m of the hint" let five objectives point at a circle
 * with none of their mobs in it (JG_005 Big-Eyed Ghosts, JG_010 Water Ghost Slaves, JG_013 Broken Stone Ghosts,
 * JG_015 Decayed Yeoha, JG_019 Young Tigers): the bot searched the circle and found nothing. Rule here: the nests the
 * server actually spawns (Spawner.nests on jangan-fields) whose centres lie inside the circle, a few metres in from
 * its edge (mobs roam around the centre), keep at least MIN_ALIVE of the objective's mobs alive at once. Encounter
 * kills (JG_025's Tiger Girl, summoned by the Binding Bell) are exempt. Skipped without the export.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuestDef, QuestLocation } from '@sro/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { startTestServer, type TestServer } from './helpers.ts'

const OUT = join(REPO_ROOT, 'work/out')
const OUT_OPT = join(REPO_ROOT, 'work/out-opt')
const CONTENT = join(REPO_ROOT, 'content')
const HAVE_FIELDS = (() => {
  const man = join(OUT, 'world/jangan-fields/manifest.json')
  if (!existsSync(man) || !existsSync(join(OUT, 'data/nests.json')) || !existsSync(join(CONTENT, 'quests/jangan.json'))) return false
  const m = JSON.parse(readFileSync(man, 'utf8')) as { nav?: { file?: string } }
  return typeof m.nav?.file === 'string' && existsSync(join(OUT, 'world/jangan-fields', m.nav.file))
})()

/** Mobs of the objective alive at once from nests inside the circle. */
const MIN_ALIVE = 6
/** A nest counts when its centre lies this far inside the circle's edge (metres). */
const EDGE_M = 10
/** Straight-line limit from a giver outside town (no town portal next to it) to its own quests' places. */
const OUTSIDE_GIVER_M = 400
/** A quest NPC outside town stands this far outside every aggressive nest's roam circle (metres). */
const SAFE_NPC_M = 25

describe.skipIf(!HAVE_FIELDS)('quest hint circles hold their mobs (jangan-fields)', () => {
  let s: TestServer

  beforeAll(async () => {
    s = await startTestServer({ config: { outDir: OUT, outOptDir: OUT_OPT, serveStatic: false, worldExport: 'jangan-fields', contentDir: CONTENT } })
    expect(s.ctx.nav.kind).toBe('mesh')
  }, 120_000)
  afterAll(async () => s?.stopAndClean())

  it(`every kill/collect objective has >= ${MIN_ALIVE} of its mobs spawning inside its hint circle`, () => {
    const book = s.ctx.gameplay.quests.book
    const nests = s.ctx.gameplay.spawner.nests.map((n) => n.def)
    const quests = [...book.quests.values()] as QuestDef[]
    expect(quests.length).toBeGreaterThanOrEqual(34)
    const problems: string[] = []
    let checked = 0
    for (const q of quests) {
      for (const o of q.objectives) {
        if (o.type !== 'kill' && o.type !== 'collect') continue
        const mobs = o.type === 'kill' ? o.mobs : o.from.map((f) => f.mob)
        const encounter = q.objectives.some((x) => x.type === 'useItem' && x.encounter && x.id === o.after && mobs.includes(x.encounter.mob))
        if (encounter) continue
        const loc: QuestLocation | undefined = o.hint ? book.location(o.hint) : undefined
        if (!loc) {
          problems.push(`${q.id}.${o.id}: no hint location`)
          continue
        }
        checked++
        const alive = nests
          .filter((n) => mobs.includes(n.mob) && Math.hypot(n.x - loc.x, n.z - loc.z) <= Math.max(0, loc.radius - EDGE_M))
          .reduce((sum, n) => sum + n.count, 0)
        if (alive < MIN_ALIVE) problems.push(`${q.id}.${o.id} (${mobs.join('+')}) at ${loc.id} (${loc.x}, ${loc.z}) r${loc.radius}: ${alive} alive at once inside`)
        // the circle's centre is open ground the player can walk to (the tracker's target)
        if (!s.ctx.nav.place(loc.x, loc.z, NaN, 5)) problems.push(`${loc.id}: no open ground near its centre`)
      }
    }
    expect(checked).toBeGreaterThan(30)
    expect(problems).toEqual([])
  })

  it(`a quest giver outside town sends the player at most ${OUTSIDE_GIVER_M} m away and back`, () => {
    // JG_010-JG_012 are three round trips between Exorcist Miaoryeong (west, past the walls) and the swamp. With the
    // swamp north of town (116, -522) each leg was a 720 m, 2.5 minute walk (the NEWPLAYER bot's longest shuttle); the
    // same mobs live in the swamp north-east of her hut.
    const book = s.ctx.gameplay.quests.book
    const npcs = [...s.ctx.world.npcs.values()]
    const problems: string[] = []
    let checked = 0
    for (const q of book.quests.values() as Iterable<QuestDef>) {
      if (q.giver !== q.turnIn) continue
      const npc = npcs.find((n) => n.code === q.giver)
      if (!npc || s.ctx.data.inSafeArea(s.ctx.config.world, npc.pos[0], npc.pos[2])) continue
      for (const o of q.objectives) {
        const id = o.type === 'useItem' || o.type === 'reach' ? o.location : o.type === 'kill' || o.type === 'collect' ? o.hint : undefined
        const loc = id ? book.location(id) : undefined
        if (!loc) continue
        checked++
        const d = Math.hypot(loc.x - npc.pos[0], loc.z - npc.pos[2])
        if (d > OUTSIDE_GIVER_M) problems.push(`${q.id}.${o.id}: ${loc.id} is ${d.toFixed(0)} m from ${npc.name}`)
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3)
    expect(problems).toEqual([])
  })

  it(`a quest NPC outside town stands at least ${SAFE_NPC_M} m outside every aggressive nest's roam circle`, () => {
    // PACE: Exorcist Miaoryeong stood 38 m from the centre of an aggressive level-10 Yeoha camp (roam radius 70 m), so a
    // level-6 player carrying Jeonghye's letter was attacked at her door. content/npcs.override.json moves her to the
    // river bridge (layerRepoOverrides); the Qin-Shi Tomb's entrance pack is salted (content/nests.override.json).
    const book = s.ctx.gameplay.quests.book
    const codes = new Set<string>()
    for (const q of book.quests.values() as Iterable<QuestDef>) {
      codes.add(q.giver).add(q.turnIn)
      for (const o of q.objectives) if (o.type === 'talk' || o.type === 'deliver') codes.add(o.npc)
    }
    const aggressive = s.ctx.gameplay.spawner.nests.map((n) => n.def).filter((d) => d.tactics?.aggressive ?? s.ctx.data.mob(d.mob)?.aggressive)
    const problems: string[] = []
    let checked = 0
    for (const npc of s.ctx.world.npcs.values()) {
      if (!codes.has(npc.code) || s.ctx.data.inSafeArea(s.ctx.config.world, npc.pos[0], npc.pos[2])) continue
      checked++
      for (const d of aggressive) {
        const edge = Math.hypot(d.x - npc.pos[0], d.z - npc.pos[2]) - d.radius
        if (edge < SAFE_NPC_M) problems.push(`${npc.code} (${npc.name}): ${d.mob} nest ${d.id} roams to ${edge.toFixed(0)} m`)
      }
    }
    expect(checked).toBeGreaterThanOrEqual(1)
    expect(problems).toEqual([])
    const miao = [...s.ctx.world.npcs.values()].find((n) => n.code === 'NPC_CH_SHAMAN')!
    expect(Math.hypot(miao.pos[0] + 410, miao.pos[2] + 300)).toBeLessThan(1)
    const salted = s.ctx.gameplay.spawner.nests.find((n) => n.def.id === 5416)
    expect(salted?.def.tactics?.aggressive).toBe(false)
  })
})
