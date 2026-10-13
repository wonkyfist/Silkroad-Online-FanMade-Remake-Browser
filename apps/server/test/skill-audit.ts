/**
 * Skill audit (owner's report "every skill animated correctly and works 100 %"): every learnable player row (not a
 * monster skill, not a basic attack, not a passive: 1,141 rows) is checked for
 *   (a) clips: each phase's clip TYPE_NAME resolves on the Chinese player skeletons (man and woman adventurer
 *       sidecars) in the row's aniGroup, in a pack the client loads for each weapon the row allows;
 *   (b) VFX: the fx index group exists and every effect it references (stages, hit, defence, arrow tail/force) was
 *       converted (fx/index.json url, file on disk);
 *   (c) summoned objects: `.bsr` stage objects (the hawks, flying blades, arrows) have a converted model with the clip
 *       the client plays, and ACT_L objects a lifetime (the buff's duration);
 *   (d) the server effect: the row runs on the real skills engine (skills-fixtures harness, level 30, the row's level
 *       learned) and does what its kind says: damage lands (with the row's hit count), AoE hits several targets,
 *       statuses apply, buffs and imbues apply and expire and change something, imbues proc on the next hit, heals
 *       heal, cures cure, resurrect raises;
 *   (e) timing: each hit cue lands on a hit event of its clip (not before the swing, not after the action) and the
 *       server's release is not later than that frame (else the hit shows late).
 *
 *   pnpm exec tsx apps/server/scripts/skill-audit.ts [--json] [--rows]
 *
 * Categories and their rules are in CATEGORY; documented exceptions in EXCEPTIONS (skill-audit.test.ts).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ItemDef, SkillDef, WeaponType } from '@sro/shared'
import { planPhases } from '../../game/src/world/skills-view.ts'
import { maxMpFor } from '../src/formulas.ts'
import { GameData } from '../src/gamedata.ts'
import { SkillBook, groupOf } from '../src/skills/book.ts'
import { skillHarness } from './skills-fixtures.ts'

export type Check = 'a' | 'b' | 'c' | 'd' | 'e'

/** Failure categories: which check, and what it means. */
export const CATEGORY: Record<string, { check: Check; text: string }> = {
  'clip-mapping': { check: 'a', text: 'the retail aniset has a clip for the row but the row has no animation' },
  'clip-missing': { check: 'a', text: 'a phase clip does not resolve on the player skeleton' },
  'clip-pack': { check: 'a', text: 'the clip lives in a weapon pack the client does not load for an allowed weapon' },
  'fx-group': { check: 'b', text: 'no fx index group for the row' },
  'fx-missing': { check: 'b', text: 'a referenced effect was not converted (no program)' },
  'summon-model': { check: 'c', text: 'a .bsr stage object has no converted model (or lacks the clip played)' },
  'summon-lifetime': { check: 'c', text: 'an ACT_L object has no lifetime (row without a duration)' },
  'effect-refused': { check: 'd', text: 'the server refused the skill' },
  'mp-over-max': { check: 'd', text: 'the row costs more MP than a full-INT character of its mastery level has (numbers: stats lane)' },
  'no-cast': { check: 'd', text: 'no cast message' },
  'no-damage': { check: 'd', text: 'an attack landed no damage' },
  'hit-count': { check: 'd', text: 'hits per combat differ from the row (mc)' },
  'aoe-single': { check: 'd', text: 'an area attack hit one target' },
  'no-status': { check: 'd', text: "none of the row's statuses applied (one status per hit: the first that sticks)" },
  'no-effect': { check: 'd', text: 'a buff/imbue/debuff applied no effect' },
  'no-expire': { check: 'd', text: 'the effect did not expire at its duration' },
  'inert-buff': { check: 'd', text: 'the buff changes nothing the server implements (param tags listed)' },
  'imbue-no-proc': { check: 'd', text: 'the next hit while imbued was not stronger' },
  'no-heal': { check: 'd', text: 'the heal restored nothing' },
  'no-cure': { check: 'd', text: 'the cure left the state on' },
  'no-resurrect': { check: 'd', text: 'the target stayed dead' },
  'timing-no-event': { check: 'e', text: 'the hit cue has no hit event in its clip (shows at the release, off-frame)' },
  'timing-before-swing': { check: 'e', text: 'the hit shows before its swing phase starts' },
  'timing-late': { check: 'e', text: 'the server releases after the clip hit frame (the hit shows late)' },
  'timing-after-action': { check: 'e', text: 'the hit frame falls after the action ends' },
}

export interface RowResult {
  code: string
  group: string
  name: string
  mastery: string
  masteryLevel: number
  kind: string
  fails: { cat: string; detail: string }[]
}

export interface AuditReport {
  rows: RowResult[]
  /** Rows per category (a row counts once per category). */
  counts: Record<string, number>
  /** Rows with any failure per check. */
  byCheck: Record<Check, number>
  total: number
  clean: number
}

interface FxStageJ { phase: string; startEvent: number; actType: string; move: string; object: string | null; effect: string | null; effect2: string | null; objectModel?: { glb: string; sidecar: string } | null; dmg: boolean }
interface FxSkillJ { group: string; aniGroup: string | null; clips: { ready: string | null; wait: string | null; shot: string | null } | null; damage: string | null; defense: string | null; arrowTail: string | null; arrowForce: string | null; stages: FxStageJ[] }
interface Anim { name: string; group: string; typeName: string; durationMs: number; events: { timeMs: number; type: number }[] }

const FAMILY_PACK: Record<string, string> = { sword: 'sword', blade: 'sword', spear: 'spear', glaive: 'spear', bow: 'bow' }
const TOL_MS = 60

export function learnableRows(rows: readonly SkillDef[]): SkillDef[] {
  return rows.filter((r) => !r.mob && !r.basicAttack && r.kind !== 'passive' && r.code.startsWith('SKILL_'))
}

const clipType = (v: string | null | undefined) => v?.split(',')[0]?.trim().replace(/^ANI_/, '') || null
const groupKey = (r: SkillDef) => r.group ?? r.code.replace(/_\d+S?_\d\d$|_\d\d$/, '')

/** Static checks (a, b, c, e) on the export. */
export function staticChecks(out: string, rows: readonly SkillDef[]): Map<string, { cat: string; detail: string }[]> {
  const fx = JSON.parse(readFileSync(join(out, 'fx/skills.json'), 'utf8')) as { skills: FxSkillJ[]; effects: Record<string, { url: string | null }> }
  const fxIndex = JSON.parse(readFileSync(join(out, 'fx/index.json'), 'utf8')) as { effects: { key: string; url: string }[] }
  const converted = new Map(fxIndex.effects.map((e) => [e.key.toLowerCase(), e.url]))
  const byGroup = new Map(fx.skills.map((s) => [s.group, s]))
  const bodies = ['char/china/chinaman_adventurer.json', 'char/china/chinawoman_adventurer.json'].map((f) => (JSON.parse(readFileSync(join(out, f), 'utf8')) as { animations: Anim[] }).animations)
  const sidecars = new Map<string, Anim[] | null>()
  const modelClips = (sidecar: string): Anim[] | null => {
    if (!sidecars.has(sidecar)) {
      const f = join(out, sidecar.replace(/^\/out\//, ''))
      sidecars.set(sidecar, existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { animations: Anim[] }).animations : null)
    }
    return sidecars.get(sidecar)!
  }
  const effectOk = (key: string) => {
    const url = converted.get(key.toLowerCase())
    return !!url && existsSync(join(out, url))
  }
  const res = new Map<string, { cat: string; detail: string }[]>()
  const byCode = new Map(rows.map((r) => [r.code, r]))
  for (const r of rows) {
    const fails: { cat: string; detail: string }[] = []
    const add = (cat: string, detail: string) => {
      if (!fails.some((f) => f.cat === cat && f.detail === detail)) fails.push({ cat, detail })
    }
    const g = byGroup.get(groupKey(r))
    // (a) clips
    const anim = r.animation ?? {}
    if (g?.clips) for (const ph of ['ready', 'wait', 'shot'] as const) if (clipType(g.clips[ph]) && !anim[ph]) add('clip-mapping', `${ph}: aniset ${g.clips[ph]}`)
    const want = (r.aniGroup ?? 'DEFAULT').toLowerCase()
    const weapons: string[] = r.weapons.length ? r.weapons : ['sword', 'spear', 'bow']
    const resolve = (body: Anim[], type: string) => (want !== 'default' ? body.find((a) => a.group === want && a.typeName === type) : undefined) ?? body.find((a) => a.group === 'default' && a.typeName === type)
    for (const ph of ['ready', 'wait', 'shot'] as const) {
      const type = clipType(anim[ph])
      if (!type) continue
      for (const body of bodies) {
        const a = resolve(body, type)
        if (!a) add('clip-missing', `${ph} ${type} in ${want}`)
        else if (a.group !== 'default') for (const w of weapons) if (FAMILY_PACK[w] !== a.group) add('clip-pack', `${type} (${a.group}) with ${w}`)
      }
    }
    // (b) VFX
    if (!g) add('fx-group', groupKey(r))
    else {
      const keys = [g.damage, g.defense, g.arrowTail, g.arrowForce, ...g.stages.flatMap((s) => [s.effect, s.effect2])].filter((k): k is string => !!k)
      for (const k of keys) if (!effectOk(k)) add('fx-missing', k)
      for (const s of g.stages) if (s.object && /\.efp$/i.test(s.object) && !s.effect) add('fx-missing', s.object)
      // (c) summoned / spawned objects
      for (const s of g.stages) {
        if (!s.object || !/\.bsr$/i.test(s.object)) continue
        const m = s.objectModel
        const clips = m ? modelClips(m.sidecar) : null
        if (!m || !clips || !existsSync(join(out, m.glb.replace(/^\/out\//, '')))) add('summon-model', s.object)
        else if (s.phase === 'ACT_L' && /hawk/i.test(s.object) && !clips.some((c) => c.name === 'WALK')) add('summon-model', `${s.object}: no WALK clip`)
        if (s.phase === 'ACT_L' && !(r.durationMs && r.durationMs > 0) && !r.toggle) add('summon-lifetime', s.object)
      }
    }
    // (e) timing (rows that land on someone)
    // A chain segment (SKILLS.md §5.2) continues the head's clip: its cue is an event of the head's SHOT clip, and the
    // server releases it after the earlier segments' whole actions.
    const head = r.chainRoot ? byCode.get(r.chainRoot) : undefined
    let chainOffset = 0
    if (head && head !== r) {
      for (let c: SkillDef | undefined = head; c && c !== r; c = c.chainNext ? byCode.get(c.chainNext) : undefined) chainOffset += Math.max(0, c.preparingMs ?? 0) + Math.max(0, c.castMs) + Math.max(0, c.actionMs)
    }
    const lead = head ?? r
    if ((r.kind === 'attack' || r.kind === 'debuff') && (lead.animation ?? {}).shot) {
      const body = bodies[0]!
      const clipOf = (type: string) => {
        const a = resolve(body, type)
        return a ? { durationMs: a.durationMs, hits: a.events.filter((e) => e.type === 1).map((e) => e.timeMs) } : null
      }
      const lmsg = { prepareMs: Math.max(0, lead.preparingMs ?? 0), castMs: Math.max(0, lead.castMs), actionMs: Math.max(0, lead.actionMs) }
      const msg = { prepareMs: Math.max(0, r.preparingMs ?? 0), castMs: Math.max(0, r.castMs), actionMs: Math.max(0, r.actionMs) }
      const plans = planPhases(lmsg, lead, clipOf)
      let t = 0
      const phases = plans.map((p) => {
        const x = { ...p, start: t, clip: clipOf(p.type) }
        t += p.ms
        return x
      })
      const release = chainOffset + msg.prepareMs + msg.castMs
      const end = release + msg.actionMs
      const shot = phases.find((p) => p.phase === 'SHOT')
      const cues = r.hitCues?.length ? r.hitCues : [{ phase: 'SHOT' as const, event: 1 }]
      for (const cue of cues) {
        const ph = phases.find((p) => p.phase === cue.phase) ?? phases[phases.length - 1]
        if (!ph || cue.event === 0) continue
        const ev = ph.clip?.hits[cue.event - 1]
        if (ev === undefined) {
          add('timing-no-event', `${cue.phase} event ${cue.event} of ${ph.type}`)
          continue
        }
        const at = ph.start + ev
        const swing = cue.phase === 'SHOT' ? (shot?.start ?? 0) : ph.start
        if (at < swing - TOL_MS) add('timing-before-swing', `${ph.type} ev ${ev} ms < swing ${swing} ms`)
        if (!cue.projectile && release > at + TOL_MS) add('timing-late', `release ${release} ms > frame ${at} ms (${ph.type})`)
        if (!r.chainRoot && at > Math.max(end, ph.start + ph.ms) + TOL_MS) add('timing-after-action', `frame ${at} ms > end ${end} ms (${ph.type})`)
      }
    }
    res.set(r.code, fails)
  }
  return res
}

/** Param tags of buffs whose mechanic lives outside the effect (Ghost Walk's teleport: the movement lane). */
const MECHANIC_TAGS = new Set(['tele'])

/** (d) on the real engine, one harness per row. */
export function serverChecks(out: string, rows: readonly SkillDef[], o: { rng?: () => number } = {}): Map<string, { cat: string; detail: string }[]> {
  const book = SkillBook.load(out)
  const data = GameData.load(out)
  const shield = [...data.items.values()].find((i: ItemDef) => i.category === 'shield' && i.typeId[2] === 4 && i.typeId[3] === 1 && i.race !== 'europe')
  const mobDef = data.mob('MOB_CH_MANGNYANG') ?? [...data.mobs.values()][0]!
  const res = new Map<string, { cat: string; detail: string }[]>()
  const rng = o.rng ?? (() => 0.05)
  for (const r of rows) {
    const fails: { cat: string; detail: string }[] = []
    const add = (cat: string, detail: string) => fails.push({ cat, detail })
    // chain segments run with their head (the head's run checks every segment's combat)
    if (r.chainRoot && r.chainRoot !== r.code) {
      res.set(r.code, fails)
      continue
    }
    const weapon: 'sword' | 'spear' | 'bow' = r.weapons.includes('bow') || r.requiresItem?.typeId3 === 6 ? 'bow' : r.weapons.some((w: WeaponType) => w === 'spear' || w === 'glaive') ? 'spear' : 'sword'
    const wear = r.requiresItem?.typeId3 === 4 && shield ? [shield.code] : []
    // MP: what a full-INT character (+1 INT a level and 3 points) of the row's mastery level has
    const L = Math.max(1, r.masteryLevel)
    const cost = Math.round(r.mp + ((r.mpPct ?? 0) / 100) * maxMpFor(L, 20 + 4 * (L - 1)))
    if (cost > maxMpFor(L, 20 + 4 * (L - 1))) add('mp-over-max', `${cost} MP > ${maxMpFor(L, 20 + 4 * (L - 1))} at level ${L}`)
    const h = skillHarness({ data, book, rng, config: { levelCap: 30 } })
    try {
      // the effect checks run on a level-30 full-INT character (enough MP for every row)
      const { p, inbox } = h.hero({ level: 30, weapon, wear, int: 20 + 4 * 29 })
      const group = groupOf(book.head(r))
      const masteries = Object.fromEntries([...book.masteries.keys()].map((m) => [m, 30]))
      h.gameplay.skills.gmSet(p, masteries, [[group, r.skillLevel]], h.now)
      h.gameplay.setVitals(p, p.maxHp, p.maxMp)
      const sturdy = { ...mobDef, hp: 1_000_000, walkSpeed: 0, runSpeed: 0, attackIntervalMs: 1_000_000 }
      const m = h.dummy(0, 2, sturdy)
      const lands = r.kind === 'attack' || r.kind === 'debuff'
      const area = lands && r.area && r.area.maxTargets !== 1
      if (area) for (const [x, z] of [[0.6, 2.3], [-0.6, 2.3], [0, 2.8]] as const) h.dummy(x, z, sturdy)
      if (r.requiresTargetState === 1) h.gameplay.skills.effects.add({ instance: 77_777, carrier: m.id, source: p.id, kind: 'status', status: 'knockdown', overlap: 0, mods: [], startedAt: h.now, until: h.now + 60_000 })
      let target: number | undefined = lands ? m.id : undefined
      let friend: ReturnType<typeof h.hero> | null = null
      if (r.kind === 'resurrect') {
        friend = h.hero({ pos: [1, 0, 1] })
        h.gameplay.gmKill(friend.p, h.now)
        target = friend.p.id
      }
      if (r.kind === 'heal') h.gameplay.setVitals(p, Math.max(1, Math.round(p.maxHp / 3)), Math.max(1, Math.round(p.maxMp / 3)))
      let cureStatus: string | null = null
      if (r.kind === 'cure') {
        // a state the row cures: the first abnormal state of its level
        const st = (['poison', 'frostbite', 'burn', 'shock', 'zombie', 'darkness'] as const)[0]
        h.gameplay.skills.effects.add({ instance: 88_888, carrier: p.id, source: m.id, kind: 'status', status: st, level: 1, overlap: 0, mods: [], startedAt: h.now, until: h.now + 60_000 })
        cureStatus = st
      }
      // the imbue's proc: one basic hit before, one while imbued
      const basicDamage = () => {
        const before = h.all(inbox, 'combat').length
        p.action = { kind: 'attack', target: m.id, chaseAt: 0, chaseTo: null }
        h.runTo(h.now + 2500)
        p.action = null
        const c = h.all(inbox, 'combat').slice(before).find((x) => x.attacker === p.id && x.target === m.id)
        return c ? c.hits.reduce((s, x) => s + x.damage, 0) : 0
      }
      const plain = r.kind === 'imbue' ? basicDamage() : 0
      const hp0 = p.hp
      const mp0 = p.mp
      inbox.length = 0
      const use = (t: number | undefined) => {
        h.req(p, t === undefined ? { t: 'useSkill', skill: r.code } : { t: 'useSkill', skill: r.code, target: t })
        return h.result(inbox, 'useSkill') as { ok: boolean; reason?: string } | undefined
      }
      let ans = use(target)
      if (!ans?.ok && target === undefined && r.targets?.required) ans = use(p.id)
      if (!ans?.ok) {
        add('effect-refused', ans?.reason ?? 'no answer')
        res.set(r.code, fails)
        continue
      }
      // an imbue lasts 5 s: its proc is checked on the next basic hit, right away
      let imbued = 0
      if (r.kind === 'imbue') {
        h.runTo(h.now + 100)
        imbued = basicDamage()
      }
      h.runTo(h.now + 6000)
      const mine = (code?: string) => !!code && groupOf(book.head(book.skill(code) ?? r)) === group
      if (!h.all(inbox, 'cast').some((c) => mine(c.skill)) && !r.instant) add('no-cast', '')
      const combats = h.all(inbox, 'combat').filter((c) => c.attacker === p.id && mine(c.skill))
      switch (r.kind) {
        case 'attack': {
          if (!combats.some((c) => c.hits.some((x) => x.damage > 0))) add('no-damage', `${combats.length} combat`)
          const want = Math.max(1, r.damage?.hits ?? 1)
          const segs = new Map<string, number>()
          for (const c of combats) if (c.target === m.id) segs.set(c.skill!, Math.max(segs.get(c.skill!) ?? 0, c.hits.length))
          for (const [code, n] of segs) {
            const row = book.skill(code)
            const w = Math.max(1, row?.damage?.hits ?? want)
            if (n !== w) add('hit-count', `${code}: ${n} hits, row ${w}`)
          }
          if (area && new Set(combats.map((c) => c.target)).size < 2) add('aoe-single', `${r.area!.shape} ${r.area!.distance} m`)
          break
        }
        case 'debuff':
          break
        case 'heal':
          if (!(p.hp > hp0 || p.mp > mp0)) add('no-heal', JSON.stringify(r.heal ?? null))
          break
        case 'cure':
          if (cureStatus && h.gameplay.skills.effects.status(p.id, cureStatus as 'poison', h.now)) add('no-cure', cureStatus)
          break
        case 'resurrect':
          if (friend!.p.dead) add('no-resurrect', '')
          break
      }
      // statuses of the row (attacks and debuffs): each kind must show up on a victim
      if (lands) {
        const kinds = new Set((r.statuses ?? []).filter((s) => s.chancePct > 5).map((s) => s.status))
        const seen = new Set(h.all(inbox, 'effectAdd').map((e) => e.effect.status).filter(Boolean))
        if (kinds.size && ![...kinds].some((k) => seen.has(k))) add('no-status', [...kinds].join(','))
      }
      if (r.kind === 'buff' || r.kind === 'imbue' || (r.kind === 'debuff' && !r.statuses?.length)) {
        const add0 = h.all(inbox, 'effectAdd').find((e) => mine(e.effect.skill))
        if (!add0) add('no-effect', '')
        else {
          const carrier = add0.id
          const e = h.gameplay.skills.effects.get(carrier, add0.effect.instance)
          const tags = (r.params ?? []).map((x) => x.tag).filter((t) => !['dura', 'reqi', 'efr'].includes(t))
          if (e && !e.mods.length && !e.wall && !e.tick && !tags.some((t) => MECHANIC_TAGS.has(t)) && r.kind === 'buff') add('inert-buff', tags.join(',') || '(none)')
          if (r.kind === 'imbue' && !(imbued > plain)) add('imbue-no-proc', `${plain} -> ${imbued}`)
          if (e && e.until > 0) {
            h.now = Math.max(h.now, e.until - 60)
            h.runTo(e.until + 200)
            if (h.gameplay.skills.effects.get(carrier, add0.effect.instance)) add('no-expire', `${r.durationMs} ms`)
          }
        }
      }
    } finally {
      h.cleanup()
    }
    res.set(r.code, fails)
  }
  return res
}

export function runSkillAudit(out: string, o: { server?: boolean } = {}): AuditReport {
  const all = (JSON.parse(readFileSync(join(out, 'data/skills.json'), 'utf8')) as { entries: SkillDef[] }).entries
  const rows = learnableRows(all)
  const st = staticChecks(out, rows)
  const sv = o.server === false ? new Map() : serverChecks(out, rows)
  const results: RowResult[] = rows.map((r) => ({
    code: r.code,
    group: groupKey(r),
    name: r.name,
    mastery: r.mastery ?? '-',
    masteryLevel: r.masteryLevel,
    kind: r.kind ?? '?',
    fails: [...(st.get(r.code) ?? []), ...(sv.get(r.code) ?? [])],
  }))
  const counts: Record<string, number> = {}
  const byCheck: Record<Check, number> = { a: 0, b: 0, c: 0, d: 0, e: 0 }
  for (const r of results) {
    const cats = new Set(r.fails.map((f) => f.cat))
    for (const c of cats) counts[c] = (counts[c] ?? 0) + 1
    for (const ch of new Set([...cats].map((c) => CATEGORY[c]!.check))) byCheck[ch]++
  }
  return { rows: results, counts, byCheck, total: results.length, clean: results.filter((r) => !r.fails.length).length }
}

/** Plain-text summary: counts per check and category, then failing rows grouped by cause (most common skills first). */
export function formatAudit(rep: AuditReport, o: { exceptions?: Record<string, string>; rows?: boolean } = {}): string {
  const lines = [`skill audit: ${rep.total} learnable rows, ${rep.clean} clean`]
  lines.push(`rows failing per check: ${(['a', 'b', 'c', 'd', 'e'] as const).map((c) => `${c}=${rep.byCheck[c]}`).join(' ')}`)
  for (const [cat, n] of Object.entries(rep.counts).sort((x, y) => y[1] - x[1])) {
    lines.push(`  (${CATEGORY[cat]!.check}) ${cat}: ${n} rows: ${CATEGORY[cat]!.text}`)
    const failing = rep.rows.filter((r) => r.fails.some((f) => f.cat === cat))
    const groups = new Map<string, RowResult[]>()
    for (const r of failing) groups.set(r.group, [...(groups.get(r.group) ?? []), r])
    for (const [g, rs] of [...groups].sort((x, y) => x[1][0]!.masteryLevel - y[1][0]!.masteryLevel)) {
      const det = [...new Set(rs.flatMap((r) => r.fails.filter((f) => f.cat === cat).map((f) => f.detail)))].slice(0, 3).join('; ')
      const ex = o.exceptions?.[`${cat}:${g}`]
      lines.push(`      ${g} (${rs[0]!.name}, M${rs[0]!.masteryLevel}, ${rs.length} rows)${det ? `: ${det}` : ''}${ex ? `  [exception: ${ex}]` : ''}`)
      if (o.rows) for (const r of rs) lines.push(`        ${r.code}`)
    }
  }
  return lines.join('\n')
}
