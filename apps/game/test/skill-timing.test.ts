/**
 * Skill timing, client side (the timing rule: a projectile's damage number and impact show when it ARRIVES, never
 * before the client's own projectile could have flown there): every Pacheon row and every other row with a projectile
 * cue in the real export, with the real clip events of a retail body (bow and default packs), at 4, 8 and 14 m.
 * The ActionPlayer (skills-view.ts) shows hit i at the server's `combat.at` plus the launch lag; the client launches at
 * the clip's hit event (+ the row's delay) and flies `distance / speed`: shown >= launch + travel, and within a frame
 * or two of it (no hit waits needlessly). The attack stance in the air (air-stance.ts) and the chest's bend and recoil
 * (upper-aim.ts) are checked here too.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { LevelDef, MasteryDef, SkillDef } from '@sro/shared'
import { SkillCatalog } from '../src/content/skills.ts'
import { recoilAt, RECOIL_PEAK_S, RECOIL_RAD, upperPitch } from '../src/three/upper-aim.ts'
import { aimPitchTo, AIM_PITCH_MAX, airStance, HOVER_ATTACK_PITCH, HOVER_ATTACK_RATE, SWOOP_SPEED } from '../src/world/air-stance.ts'
import { ActionPlayer, type ActionPort, type CastMessage, type ClipFacts, type PhasePlan, type SkillCombat } from '../src/world/skills-view.ts'

const SKILLS_JSON = 'work/out/data/skills.json'
const MASTERIES_JSON = 'work/out/data/masteries.json'
const BODY_JSON = 'work/out/char/china/chinaman_adventurer.json'
const LEVELS: LevelDef[] = Array.from({ length: 30 }, (_, i) => ({ level: i + 1, exp: 100, masterySp: 10 }))

interface Anim { group: string; typeName: string; durationMs: number; events?: { timeMs: number; type: number }[] }

/** The body's clips by pack group and TYPE_NAME (sidecar `animations`; type-1 events are the hit points). */
function bodyClips(): Map<string, ClipFacts> {
  const j = JSON.parse(readFileSync(BODY_JSON, 'utf8')) as { animations: Anim[] | Record<string, Anim> }
  const list = Array.isArray(j.animations) ? j.animations : Object.values(j.animations)
  const out = new Map<string, ClipFacts>()
  for (const a of list) {
    const hits = (a.events ?? []).filter(e => e.type === 1).map(e => e.timeMs).sort((x, y) => x - y)
    const key = `${a.group.toLowerCase()}:${a.typeName}`
    if (!out.has(key)) out.set(key, { durationMs: a.durationMs, hits })
  }
  return out
}

class Port implements ActionPort {
  constructor(private readonly clips: Map<string, ClipFacts>) {}
  clip(group: string | undefined, type: string): ClipFacts | null {
    return this.clips.get(`${(group ?? 'default').toLowerCase()}:${type}`) ?? this.clips.get(`default:${type}`) ?? null
  }
  play(_g: string | undefined, phases: readonly PhasePlan[]): number | null {
    return phases.length ? 1 : null
  }
  stop(): void {}
  playing(): boolean {
    return true
  }
  face(): void {}
}

const have = existsSync(SKILLS_JSON) && existsSync(MASTERIES_JSON) && existsSync(BODY_JSON)

describe.skipIf(!have)('skill timing: impact >= release + travel (real export, real clip events)', () => {
  const skills = have ? (JSON.parse(readFileSync(SKILLS_JSON, 'utf8')) as { entries: SkillDef[] }).entries : []
  const masteries = have ? (JSON.parse(readFileSync(MASTERIES_JSON, 'utf8')) as { entries: MasteryDef[] }).entries : []
  const rows = skills.filter(s => !s.code.startsWith('MSKILL_') && (s.hitCues ?? []).some(c => c.projectile) && !s.instant && (s.kind ?? 'attack') === 'attack')

  it('covers every Pacheon attack row', () => {
    const bow = rows.filter(s => s.code.startsWith('SKILL_CH_BOW_'))
    expect(bow.length).toBeGreaterThan(20)
    // multi-arrow fans, piercing lines, area rain and the straight power shots all fly
    for (const g of ['CHAIN', 'PIERCE', 'AREA', 'POWER', 'CRITICAL']) expect(bow.some(s => s.code.includes(`_BOW_${g}_`))).toBe(true)
  })

  it('shows every projectile hit no earlier than the client-launched projectile lands, and no later than 2 frames after', () => {
    const catalog = new SkillCatalog(skills, masteries, LEVELS)
    const port = new Port(bodyClips())
    const player = new ActionPlayer(catalog)
    const bad: string[] = []
    let checked = 0
    let instance = 1
    for (const row of rows) {
      // a chain segment plays inside its head's clip: walked from the head below
      if ((row.chainIndex ?? 1) > 1) continue
      for (const d of [4, 8, 14]) {
       // the head, then each segment at the server's time (the previous one's cast + action), one instance
       const inst = instance++
       let t = 0
       for (let seg: SkillDef | undefined = row; seg; seg = seg.chainNext ? skills.find(s => s.code === seg!.chainNext) : undefined) {
        const msg: CastMessage = { t: 'cast', id: 1, skill: seg.code, instance: inst, target: 50, prepareMs: seg.preparingMs ?? 0, castMs: seg.castMs, actionMs: seg.actionMs }
        const a = player.cast(msg, t, port)
        t += (seg.preparingMs ?? 0) + seg.castMs + seg.actionMs
        if (!a || !(seg.hitCues ?? []).some(c => c.projectile)) continue
        const row2 = seg
        const cues = row2.hitCues ?? []
        const n = Math.max(1, row2.damage?.hits ?? cues.length)
        // the server (skills/engine.ts + timing.ts arrivalAt): one combat with every hit, `at` = the first projectile
        // cue's arrival counted from its release (zero clock offset here)
        const first = cues.find(c => c.projectile)!.projectile!
        const at = Math.round(a.release + first.delayMs + (d / (first.speed / 10)) * 1000)
        const combat: SkillCombat = { t: 'combat', attacker: 1, target: 50, skill: row2.code, instance: msg.instance, at, hits: Array.from({ length: n }, () => ({ outcome: 'hit' as const, damage: 1, hp: 1 })) }
        const shown = player.hitTimes(a, combat, 0, 0)
        for (let i = 0; i < n; i++) {
          const cue = cues[i] ?? cues[cues.length - 1]!
          const proj = cue.projectile
          if (!proj) continue
          const phase = a.phases.find(p => p.plan.phase === cue.phase)
          const ev = cue.event > 0 ? phase?.clip?.hits[cue.event - 1] : 0
          if (!phase || ev === undefined) continue
          // the client: launched at the clip's event (+ the row's delay), flying `d` at the row's speed (dm/s)
          const lands = phase.start + ev + proj.delayMs + (d / (proj.speed / 10)) * 1000
          // extra hits of one cue follow 140 ms apart (HIT_GAP)
          const spread = i >= cues.length ? (i - cues.length + 1) * 140 : 0
          checked++
          if (shown[i]! < lands - 1) bad.push(`${row2.code} hit ${i} @${d} m: shown ${shown[i]!.toFixed(0)} < lands ${lands.toFixed(0)} (event ${ev}, release ${a.release})`)
          // the server cannot land it before its own release + travel (a clip that throws before the release: the
          // projectile waits at the victim for the damage, SkillFx HOLD_MS)
          else if (shown[i]! > Math.max(lands, at) + spread + 34) bad.push(`${row2.code} hit ${i} @${d} m: shown ${shown[i]!.toFixed(0)} waits past landing ${lands.toFixed(0)} / server ${at}`)
        }
       }
      }
    }
    expect(checked).toBeGreaterThan(60)
    expect(bad).toEqual([])
  })
})

describe('the attack stance in the air (air-stance.ts) and the chest bend (upper-aim.ts)', () => {
  const glide = { pitch: 1.1, roll: 0.3, clip: 'FLY_GLIDE' as const, rate: 1 }

  it('blends into an upright, slow-beating hover while an upper-body action plays, and back out', () => {
    let w = 0
    let s = airStance(w, glide, [0, 0, 0], true, 0.05)
    expect(s.weight).toBeCloseTo(0.2, 5)
    for (let i = 0; i < 10; i++) s = airStance(s.weight, glide, [0, 0, 0], true, 0.05)
    expect(s.weight).toBe(1)
    expect(s.pitch).toBeCloseTo(HOVER_ATTACK_PITCH, 5)
    expect(s.roll).toBe(0)
    expect(s.clip).toBe('FLY_HOVER')
    expect(s.rate).toBe(HOVER_ATTACK_RATE)
    expect(s.swoop).toBe(false)
    w = s.weight
    for (let i = 0; i < 10; i++) w = airStance(w, glide, [0, 0, 0], false, 0.05).weight
    const out = airStance(w, glide, [0, 0, 0], false, 0.05)
    expect(out.weight).toBe(0)
    expect(out).toMatchObject({ pitch: glide.pitch, roll: glide.roll, clip: 'FLY_GLIDE', rate: 1 })
  })

  it('a fast approach while attacking (the melee dash) leans into a swoop instead', () => {
    const s = airStance(1, glide, [SWOOP_SPEED + 14, 0, 0], true, 0.016)
    expect(s.swoop).toBe(true)
    expect(s.pitch).toBeGreaterThan(0.5)
    expect(s.clip).toBe('FLY_GLIDE')
  })

  it('aims the chest at targets above and below, clamped', () => {
    expect(aimPitchTo(3, 4)).toBeCloseTo(Math.atan2(3, 4), 5)
    expect(aimPitchTo(-3, 8)).toBeLessThan(0)
    expect(aimPitchTo(50, 1)).toBe(AIM_PITCH_MAX)
    expect(aimPitchTo(Number.NaN, 3)).toBe(0)
  })

  it('settles back after the release in the air: a kick peaking at RECOIL_PEAK_S that eases out', () => {
    expect(recoilAt(-0.1)).toBe(0)
    expect(recoilAt(RECOIL_PEAK_S)).toBeCloseTo(RECOIL_RAD, 6)
    expect(recoilAt(0.03)).toBeLessThan(RECOIL_RAD)
    expect(recoilAt(1.2)).toBe(0)
    expect(upperPitch(0.3, 0.5, null)).toBeCloseTo(0.15, 6)
    expect(upperPitch(0, 1, RECOIL_PEAK_S)).toBeCloseTo(RECOIL_RAD, 6)
  })
})
