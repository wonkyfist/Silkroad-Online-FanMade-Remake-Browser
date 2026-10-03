/**
 * The skills engine on the REAL export (work/out/data skills.json, masteries.json, levels.json, items.json, mobs.json).
 * Skipped when the export is not there. Every one of the Chinese skill lines up to mastery 20 is learned with the GM
 * path and used by a level-20 character on a real monster; each must do what its kind says (docs/SKILLS.md §2.1) and
 * every message must pass the client parser.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MASTERY_CODES, parseServerMessage, type ItemDef, type ServerMessage } from '@sro/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { GameData } from '../src/gamedata.ts'
import { SkillBook, groupOf } from '../src/skills/book.ts'
import { runSkillCommand } from '../src/skills/gm-skill.ts'
import { checkMasteryUp } from '../src/skills/learn.ts'
import { modsFromParams } from '../src/skills/mods.ts'
import { emptyMasteries } from '../src/skills/store.ts'
import { skillHarness } from './skills-fixtures.ts'

const OUT = join(REPO_ROOT, 'work/out')
const HAVE = ['data/skills.json', 'data/masteries.json', 'data/levels.json', 'data/items.json', 'data/mobs.json'].every((f) => existsSync(join(OUT, f)))

describe.skipIf(!HAVE)('skills on the real export', () => {
  const book = HAVE ? SkillBook.load(OUT) : new SkillBook()
  const data = HAVE ? GameData.load(OUT) : new GameData()
  let h: ReturnType<typeof skillHarness> | null = null
  afterEach(() => {
    h?.cleanup()
    h = null
  })

  it('has the 41 Chinese skill lines up to mastery 20 and the four basic attacks', () => {
    expect(book.masteries.size).toBe(7)
    const lines = [...book.byGroup.keys()]
    expect(lines).toHaveLength(41)
    const per = Object.fromEntries(MASTERY_CODES.map((m) => [m, book.linesOf.get(m)?.length ?? 0]))
    expect(per).toEqual({ BICHEON: 8, HEUKSAL: 6, PACHEON: 6, COLD: 6, LIGHTNING: 5, FIRE: 5, FORCE: 5 })
    for (const code of ['SKILL_PUNCH_01', 'SKILL_CH_SWORD_BASE_01', 'SKILL_CH_SPEAR_BASE_01', 'SKILL_CH_BOW_BASE_01']) expect(book.skill(code)?.basicAttack, code).toBe(true)
    for (const rows of book.byGroup.values()) for (const r of rows) expect(r.masteryLevel).toBeLessThanOrEqual(20)
    expect(book.chain(book.skill('SKILL_CH_SWORD_CHAIN_A_1S_01')!)?.code).toBe('SKILL_CH_SWORD_CHAIN_A_2S_01')
  })

  it('masteryUp costs 1+1+1+2+2 = 7 SP for the first five levels (levels.json masterySp)', () => {
    const m = emptyMasteries()
    let spent = 0
    for (let i = 0; i < 5; i++) {
      const r = checkMasteryUp({ level: 20, sp: 1000 }, m, 'BICHEON', data.levels)
      expect(r.ok).toBe(true)
      if (r.ok) spent += r.sp
      m.BICHEON++
    }
    expect(spent).toBe(7)
  })

  it('every line runs: attacks hit, buffs and imbues land, heals heal, resurrect raises, passives count', () => {
    const shield = [...data.items.values()].find((i: ItemDef) => i.category === 'shield' && i.typeId[2] === 4 && i.typeId[3] === 1 && i.reqLevel <= 20 && i.race !== 'europe')
    const mob = data.mob('MOB_CH_MANGNYANG') ?? [...data.mobs.values()][0]
    expect(shield).toBeTruthy()
    const report: string[] = []
    for (const [group, rows] of book.byGroup) {
      const row = rows[rows.length - 1]
      const weapon = row.weapons.includes('bow') || row.requiresItem?.typeId3 === 6 ? 'bow' : row.weapons.includes('spear') ? 'spear' : 'sword'
      const wear = row.requiresItem?.typeId3 === 4 ? [shield!.code] : []
      h = skillHarness({ data, book, rng: () => 0.3 })
      const { p, inbox } = h.hero({ level: 20, weapon, wear })
      expect(runSkillCommand(h.gameplay.skills, p, ['all', '20'], 20, h.now).ok).toBe(true)
      h.gameplay.setVitals(p, p.maxHp, p.maxMp)
      const m = h.dummy(0, 2, { ...mob, hp: 1_000_000, walkSpeed: 0, runSpeed: 0, attackIntervalMs: 1_000_000 })
      let target: number | undefined
      if (row.kind === 'attack' || row.kind === 'debuff') target = m.id
      if (row.requiresTargetState === 1) h.gameplay.skills.effects.add({ instance: 77_777, carrier: m.id, source: p.id, kind: 'status', status: 'knockdown', overlap: 0, mods: [], startedAt: h.now, until: h.now + 60_000 })
      let friend: ReturnType<typeof h.hero> | null = null
      if (row.kind === 'resurrect') {
        friend = h.hero({ pos: [1, 0, 1] })
        h.gameplay.gmKill(friend.p, h.now)
        target = friend.p.id
      }
      if (row.kind === 'passive') {
        h.req(p, { t: 'useSkill', skill: row.code })
        expect(h.result(inbox, 'useSkill'), group).toMatchObject({ ok: false, reason: 'not_usable' })
        expect(modsFromParams(row.params).length, group).toBeGreaterThan(0)
        report.push(`${group}: passive`)
        h.cleanup()
        h = null
        continue
      }
      inbox.length = 0
      h.req(p, target === undefined ? { t: 'useSkill', skill: row.code } : { t: 'useSkill', skill: row.code, target })
      expect(h.result(inbox, 'useSkill'), `${group} ${JSON.stringify(h.result(inbox, 'useSkill'))}`).toMatchObject({ ok: true })
      h.runTo(h.now + 8000)
      for (const msg of inbox) {
        const r = parseServerMessage(JSON.stringify(msg))
        expect(r.ok, `${group} ${msg.t}: ${r.ok ? '' : r.error}`).toBe(true)
      }
      const mine = (code?: string) => code !== undefined && groupOf(book.head(book.skill(code)!)) === group
      const cast = h.all(inbox, 'cast').find((c) => mine(c.skill))
      expect(cast, group).toBeTruthy()
      switch (row.kind) {
        case 'attack':
        case 'debuff': {
          const hits = h.all(inbox, 'combat').filter((c) => c.attacker === p.id && mine(c.skill))
          expect(hits.length, group).toBeGreaterThan(0)
          if (row.kind === 'attack') expect(hits.some((c) => c.hits.some((x) => x.damage > 0)), group).toBe(true)
          report.push(`${group}: ${hits.length} combat`)
          break
        }
        case 'buff':
        case 'imbue': {
          const add = h.all(inbox, 'effectAdd').find((e) => mine(e.effect.skill))
          expect(add, group).toBeTruthy()
          report.push(`${group}: effect ${add!.effect.remainingMs} ms`)
          break
        }
        case 'resurrect':
          expect(friend!.p.dead, group).toBe(false)
          report.push(`${group}: resurrected`)
          break
        default:
          report.push(`${group}: ${row.kind}`)
      }
      h.cleanup()
      h = null
    }
    expect(report).toHaveLength(41)
  })

  it('basic attacks use the weapon rows (spear 1 hit at the row cadence, sword 2 hits)', () => {
    h = skillHarness({ data, book })
    const { p } = h.hero({ weapon: 'spear' })
    const spear = book.skill('SKILL_CH_SPEAR_BASE_01')!
    expect(h.gameplay.skills.basicFor(p)).toMatchObject({ hits: 1, pct: spear.damage!.physPct, intervalMs: spear.cooldownMs })
    const { p: s } = h.hero({ weapon: 'sword' })
    expect(h.gameplay.skills.basicFor(s)).toMatchObject({ hits: 2, pct: 60, intervalMs: 1200 })
    void ({} as ServerMessage)
  })
})
