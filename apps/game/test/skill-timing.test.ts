/**
 * Skill timing, client side (the timing rule: a projectile's damage number and impact show when it ARRIVES, never
 * before the client's own projectile could have flown there): every Pacheon row and every other row with a projectile
 * cue in the real export, with the real clip events of a retail body (bow and default packs), at 4, 8 and 14 m.
 * The ActionPlayer (skills-view.ts) shows hit i at the server's `combat.at` plus the launch lag; the client launches at
 * the clip's hit event (+ the row's delay) and flies `distance / speed`: shown >= launch + travel, and within a frame
 * or two of it (no hit waits needlessly). The chest's aim (air-stance.ts), bend and recoil
 * (upper-aim.ts) are checked here too.
 */
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { arrivalGroups, hitArrivalsMs, type LevelDef, type MasteryDef, type SkillDef } from '@sro/shared'
import { SkillCatalog } from '../src/content/skills.ts'
import { recoilAt, RECOIL_PEAK_S, RECOIL_RAD, upperPitch } from '../src/three/upper-aim.ts'
import { aimPitchTo, AIM_PITCH_MAX } from '../src/world/air-stance.ts'
import { isFlight, scheduleStages, type FxSkill } from '../src/world/skill-fx.ts'
import { ActionPlayer, segmentEvents, type ActionPort, type CastMessage, type ClipFacts, type PhasePlan, type SkillCombat } from '../src/world/skills-view.ts'

const SKILLS_JSON = 'work/out/data/skills.json'
const MASTERIES_JSON = 'work/out/data/masteries.json'
const BODY_JSON = 'work/out/char/china/chinaman_adventurer.json'
const FX_JSON = 'work/out/fx/skills.json'
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
        // the server (skills/engine.ts fly): hit i lands at release + its cue's offset + travel (shared hitArrivalsMs),
        // one combat per arrival group (zero clock offset here)
        const arrivals = hitArrivalsMs(row2, n, d)!
        const serverAt: number[] = arrivals.map(ms => Math.round(a.release + ms))
        const shown: number[] = []
        for (const g of arrivalGroups(arrivals)) {
          const combat: SkillCombat = { t: 'combat', attacker: 1, target: 50, skill: row2.code, instance: msg.instance, at: Math.round(a.release + g.ms), hits: Array.from({ length: g.count }, () => ({ outcome: 'hit' as const, damage: 1, hp: 1 })) }
          shown.push(...player.hitTimes(a, combat, 0, 0, g.from))
        }
        for (let i = 0; i < n; i++) {
          const at = serverAt[i]!
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
          // server / client agreement: the server's damage lands with the client's arrow (one frame or two)
          // (a clip that throws before the server release, Spear Shoot B: the arrow waits; no agreement to check)
          else if (phase.start + ev >= a.release - 1 && Math.abs(at - lands) > 34) bad.push(`${row2.code} hit ${i} @${d} m: server ${at} vs client arrow ${lands.toFixed(0)}`)
          else if (shown[i]! > Math.max(lands, at) + spread + 34) bad.push(`${row2.code} hit ${i} @${d} m: shown ${shown[i]!.toFixed(0)} waits past landing ${lands.toFixed(0)} / server ${at}`)
        }
       }
      }
    }
    expect(checked).toBeGreaterThan(60)
    expect(bad).toEqual([])
  })
})

describe.skipIf(!have || !existsSync(FX_JSON))('bow rows: one arrow per hit, each released at its own clip event', () => {
  const skills = have ? (JSON.parse(readFileSync(SKILLS_JSON, 'utf8')) as { entries: SkillDef[] }).entries : []
  const fx = existsSync(FX_JSON) ? (JSON.parse(readFileSync(FX_JSON, 'utf8')) as { skills: FxSkill[] }).skills : []
  const byCode = new Map(skills.map(s => [s.code, s]))
  const clips = have ? bodyClips() : new Map<string, ClipFacts>()

  /** The arrows (damage flights) a row's cast puts in the air, head and segments, with their clip-time launch. */
  function arrows(head: SkillDef): { count: number; hits: number; launches: number[] } {
    const g = fx.find(x => x.group === head.group)!
    const shot = clips.get(`bow:${(head.animation?.shot ?? '').split(',')[0]!.replace(/^ANI_/, '')}`)
    let count = 0
    let hits = 0
    const launches: number[] = []
    for (let seg: SkillDef | undefined = head; seg; seg = seg.chainNext ? byCode.get(seg.chainNext) : undefined) {
      hits += Math.max(1, seg.damage?.hits ?? 1)
      const events = segmentEvents(seg, c => byCode.get(c))
      for (const st of scheduleStages(g, 'SHOT', 0, shot?.hits ?? [], events)) {
        if (!st.stage.dmg || !isFlight(st.stage.actType)) continue
        count++
        launches.push(st.at)
      }
    }
    return { count, hits, launches }
  }

  it('2, 3 and 4 Arrow Combo fly 2, 3 and 4 arrows, one per clip event, in order', () => {
    const got = ['SKILL_CH_BOW_CHAIN_A_01', 'SKILL_CH_BOW_CHAIN_B_01', 'SKILL_CH_BOW_CHAIN_C_01'].map(c => arrows(byCode.get(c)!))
    expect(got.map(a => a.count)).toEqual([2, 3, 4])
    expect(got.map(a => a.hits)).toEqual([2, 3, 4])
    expect(got[2]!.launches).toEqual([522, 809, 1083, 1340])
    // the 4 Arrow Combo: 2 + 2 hits, cues 1-2 then 3-4, each segment's later arrow offset from its own release
    const c1 = byCode.get('SKILL_CH_BOW_CHAIN_C_01')!
    const c2 = byCode.get(c1.chainNext!)!
    expect(c1.hitCues!.map(c => [c.event, c.offsetMs ?? 0])).toEqual([[1, 0], [2, 287]])
    expect(c2.hitCues!.map(c => [c.event, c.offsetMs ?? 0])).toEqual([[3, 0], [4, 257]])
  })

  it('every Pacheon attack row flies at least one arrow per hit cue and the server lands each hit at release + offset + travel', () => {
    const bad: string[] = []
    const rows = skills.filter(s => s.code.startsWith('SKILL_CH_BOW_') && (s.kind ?? 'attack') === 'attack' && !s.basicAttack && (s.chainIndex ?? 1) <= 1 && fx.some(x => x.group === s.group))
    expect(rows.length).toBeGreaterThan(20)
    for (const r of rows) {
      const a = arrows(r)
      const cues = (r.hitCues ?? []).length
      if (a.count < Math.min(cues, a.hits)) bad.push(`${r.code}: ${a.count} arrows for ${a.hits} hits`)
      for (let seg: SkillDef | undefined = r; seg; seg = seg.chainNext ? byCode.get(seg.chainNext) : undefined) {
        const n = Math.max(1, seg.damage?.hits ?? 1)
        const at = hitArrivalsMs(seg, n, 10)
        if (!at) continue
        at.forEach((ms, i) => {
          const cue = seg!.hitCues![i] ?? seg!.hitCues![seg!.hitCues!.length - 1]!
          const p = cue.projectile ?? seg!.hitCues!.find(c => c.projectile)!.projectile!
          const min = (cue.offsetMs ?? 0) + p.delayMs + (10 / (p.speed / 10)) * 1000
          if (ms < min - 1) bad.push(`${seg!.code} hit ${i}: ${ms} < ${min}`)
          if (i > 0 && ms < at[i - 1]!) bad.push(`${seg!.code} hit ${i} lands before hit ${i - 1}`)
        })
      }
    }
    expect(bad).toEqual([])
  })
})

describe('the chest aim (air-stance.ts) and bend (upper-aim.ts)', () => {
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
