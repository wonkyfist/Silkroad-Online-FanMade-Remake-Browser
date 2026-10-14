/**
 * Every area row of the real skill data (work/out/data/skills.json; private branch only, skipped without it) hits more
 * than one target in the engine: the target / caster circles, the pierce and projectile lines, the chains (nukes,
 * spear and glaive areas, bow multi-arrows) deal damage to the primary and a second monster; the area debuffs (Frost
 * Nova) land on both; the chain imbues (Thunder Force) bounce a basic attack's component to the second one. Chain
 * segments with an area are covered through their chain's first segment.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MasteryCode, SkillDef } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { SkillBook } from '../src/skills/book.ts'
import { MASTERIES, skillHarness } from './skills-fixtures.ts'

const FILE = join(import.meta.dirname, '../../../work/out/data/skills.json')
const ROWS: SkillDef[] = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as { entries: SkillDef[] }).entries : []
const byCode = new Map(ROWS.map((r) => [r.code, r]))

/** Area rows a player can learn (attack / debuff / imbue), as the code cast: a chain segment's chain head. */
function areaCasts(): { cast: SkillDef; rows: string[] }[] {
  const out = new Map<string, string[]>()
  for (const r of ROWS) {
    if (r.mob || r.basicAttack || !r.area || !['attack', 'debuff', 'imbue'].includes(r.kind) || !r.code.startsWith('SKILL_')) continue
    const head = r.chainRoot ?? r.code
    out.set(head, [...(out.get(head) ?? []), r.code])
  }
  return [...out].map(([head, rows]) => ({ cast: byCode.get(head)!, rows }))
}

const weaponOf = (r: SkillDef): 'sword' | 'spear' | 'bow' | 'blade' => {
  const w = r.weapons ?? []
  if (w.includes('spear') || w.includes('glaive')) return 'spear'
  if (w.includes('bow')) return 'bow'
  if (w.includes('blade') && !w.includes('sword')) return 'blade'
  return 'sword'
}

const CASES = areaCasts()

describe.skipIf(ROWS.length === 0)('every area skill row hits more than one target', () => {
  it('lists the area rows by mastery', () => {
    expect(CASES.length).toBeGreaterThan(40) // this build's area rows (more at cap 30)
  })

  it.each(CASES.map((c) => [c.cast.code, c] as const))('%s', (_code, { cast }) => {
    const h = skillHarness({ book: new SkillBook(ROWS, MASTERIES), config: { uniques: false } })
    try {
      const hero = h.hero({ pos: [0, 0, 0], level: 10, weapon: weaponOf(cast) })
      const primary = h.dummy(1, 0)
      const second = h.dummy(1.5, 0)
      h.runTo(h.now + 100)
      const masteries = Object.fromEntries(MASTERIES.map((m) => [m.code, 30])) as Record<MasteryCode, number>
      h.gameplay.skills.gmSet(hero.p, masteries, [[cast.group!, cast.skillLevel]], h.now)
      hero.p.maxMp = hero.p.mp = 1_000_000
      if (cast.kind === 'imbue') {
        h.req(hero.p, { t: 'useSkill', skill: cast.code })
        expect(h.result(hero.inbox, 'useSkill'), 'imbue').toMatchObject({ ok: true })
        h.runTo(h.now + 100)
        h.req(hero.p, { t: 'attack', target: primary.id })
      } else {
        h.req(hero.p, { t: 'useSkill', skill: cast.code, target: primary.id })
        expect(h.result(hero.inbox, 'useSkill'), 'useSkill').toMatchObject({ ok: true })
      }
      h.runTo(h.now + 6000)
      const hit = new Map<number, number>()
      for (const c of h.all(hero.inbox, 'combat')) if (c.attacker === hero.p.id) hit.set(c.target, (hit.get(c.target) ?? 0) + c.hits.reduce((s, x) => s + x.damage, 0))
      expect(hit.has(primary.id), 'primary hit').toBe(true)
      expect(hit.has(second.id), 'second target hit').toBe(true)
      if (cast.kind !== 'debuff') expect(hit.get(second.id)!, 'damage on the second target').toBeGreaterThan(0)
    } finally {
      h.cleanup()
    }
  })
})
