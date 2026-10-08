/**
 * The job system's balance on the real export (docs/JOBS.md "Polish status"; skips without work/out/data): a standard
 * character of level 15 / 20 / 25 (a STR build: 20 + 4 per level; the best sword, shield and light set its level may
 * wear) against the transports (the tier's `transport.thiefDefence`, × `transport.thiefMul`) and a same-level robber
 * (× `robbery.hunterMul`). Two paces: basic attacks only, and a Smash rotation (Smash on its 3 s cooldown, basic attacks
 * between). The targets: a solo same-level Thief takes a Donkey in ≈ 45-90 s; the armoured Ironclad needs a group; a
 * Bounty Hunter subdues a same-level robber in ≈ 20-40 s.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JOB_SETTINGS_DEFAULTS, JOBS_CONTENT, type ItemDef, type ItemStack, type SkillDef } from '@sro/shared'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../src/config.ts'
import { maxHpFor, playerCombatStats, rollSkillHit, type CombatStats } from '../src/formulas.ts'
import { transportCombatVsPlayers } from '../src/jobs/transport.ts'

const DATA = join(REPO_ROOT, 'work/out/data')
const HAVE = ['items.json', 'skills.json'].every((f) => existsSync(join(DATA, f)))
const rows = <T>(f: string): T[] => {
  const j = JSON.parse(readFileSync(join(DATA, f), 'utf8')) as T[] | { entries: T[] }
  return Array.isArray(j) ? j : j.entries
}

/** A standard character of `level`: STR build, the best sword, shield and light set it may wear. */
function standard(items: ItemDef[], level: number): CombatStats & { hp: number } {
  const best = (re: RegExp) => items.filter((i) => re.test(i.code) && (i.reqLevel ?? 1) <= level).sort((a, b) => (b.reqLevel ?? 0) - (a.reqLevel ?? 0))[0]
  const worn = [
    best(/^ITEM_CH_SWORD_0\d_[ABC]$/),
    best(/^ITEM_CH_SHIELD_0\d_[ABC]$/),
    ...['HA', 'SA', 'BA', 'LA', 'AA', 'FA'].map((p) => best(new RegExp(`^ITEM_CH_M_LIGHT_0\\d_${p}_[ABC]$`))),
  ].filter((d): d is ItemDef => !!d)
  const str = 20 + 4 * (level - 1)
  const c = playerCombatStats(level, str, 20 + (level - 1), worn.map((def) => ({ def, stack: { code: def.code, count: 1 } as ItemStack })))
  return { ...c, hp: maxHpFor(level, str) }
}

/** Mean damage of one hit (a fixed seed). */
function mean(att: CombatStats, def: CombatStats, pct: number, flat?: [number, number]): number {
  let seed = 7
  const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  let s = 0
  const n = 20_000
  for (let i = 0; i < n; i++) s += rollSkillHit(att, def, { pct, flat }, rng).damage
  return s / n
}

/** Damage per second: basic attacks (the sword's 2 × 60 % every 1.2 s), and the Smash rotation, × `mul`. */
function dps(att: CombatStats, def: CombatStats, smash: SkillDef | undefined, mul: number): { basic: number; rotation: number } {
  const basic = 2 * mean(att, def, 60)
  const sm = smash?.damage ? mean(att, def, smash.damage.physPct, smash.damage.flat) : 0
  return { basic: (basic / 1.2) * mul, rotation: ((sm + (1.98 / 1.2) * basic) / 3) * mul }
}

describe.skipIf(!HAVE)('job balance on the real export', () => {
  const items = HAVE ? rows<ItemDef>('items.json') : []
  const skills = HAVE ? rows<SkillDef>('skills.json') : []
  const S = JOB_SETTINGS_DEFAULTS
  const smashAt = (level: number) =>
    skills.filter((s) => /^SKILL_CH_SWORD_SMASH_A_\d+$/.test(s.code) && (s.masteryLevel ?? 1) <= level).sort((a, b) => (b.masteryLevel ?? 0) - (a.masteryLevel ?? 0))[0]
  /** Seconds for one attacker: [rotation (fastest), basic attacks (slowest)]. */
  const secs = (hp: number, d: { basic: number; rotation: number }): [number, number] => [Math.round(hp / d.rotation), Math.round(hp / d.basic)]

  const table = [15, 20, 25].map((level) => {
    const p = standard(items, level)
    const smash = smashAt(level)
    const transports = JOBS_CONTENT.transports.map((t) => ({ name: t.name, hp: t.hp, s: secs(t.hp, dps(p, transportCombatVsPlayers(t.tier, S.transport.thiefDefence), smash, S.transport.thiefMul)) }))
    const robber = secs(p.hp, dps(p, p, smash, S.robbery.hunterMul))
    return { level, attack: p.physAttack, hp: p.hp, transports, robber }
  })

  it('a solo same-level Thief takes a Donkey in ≈ 45-90 s; the armoured Ironclad needs a group; a Hunter subdues a robber in ≈ 20-40 s', () => {
    // the numbers documented in docs/JOBS.md "Polish status"
    for (const r of table) console.log(`L${r.level} (attack ${r.attack.join('-')}, HP ${r.hp}): ${r.transports.map((t) => `${t.name} ${t.s[0]}-${t.s[1]} s`).join(', ')}; robber subdued ${r.robber[0]}-${r.robber[1]} s`)
    const l20 = table.find((r) => r.level === 20)!
    const [donkeyFast, donkeySlow] = l20.transports[0]!.s
    expect(donkeyFast).toBeGreaterThanOrEqual(40)
    expect(donkeySlow).toBeLessThanOrEqual(95)
    // the Ironclad: minutes alone, a group of three within ≈ 2 min
    const [ironFast, ironSlow] = l20.transports[3]!.s
    expect(ironFast).toBeGreaterThan(150)
    expect(ironSlow / 3).toBeLessThan(120)
    // the robber: 20-40 s at a mixed pace (the rotation and the basic attacks either side)
    const [robFast, robSlow] = l20.robber
    expect((robFast + robSlow) / 2).toBeGreaterThanOrEqual(20)
    expect((robFast + robSlow) / 2).toBeLessThanOrEqual(40)
    // every level of the job's range robs a Donkey within 2 min and catches a robber within a minute
    for (const r of table) {
      expect(r.transports[0]!.s[1]).toBeLessThanOrEqual(120)
      expect(r.robber[1]).toBeLessThanOrEqual(60)
    }
  })
})
