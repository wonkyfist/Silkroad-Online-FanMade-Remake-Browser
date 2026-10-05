/**
 * Mock support of lane SK-C (skills) for ?mock=1 (docs/WAVE_PLAN.md §3.3). Optional and first to cut: the
 * real-server e2e tests are the truth. Only that lane edits this file. Import MockServer types with `import type`.
 *
 * A presentation subset of docs/SKILLS.md §10, so the skill window, hotbar and casting can be tried offline:
 * - `skills` after enter; `masteryUp` / `skillLearn` with the SP and mastery rules; `hotbarSet` (items only when
 *   usable, decision 7); state is kept per character until the page reloads;
 * - `useSkill` pays MP, arms the cooldown and sends `cast`; attacks send one `combat {instance}` per hit event at
 *   the release, taking HP from the target but never killing it (the mock's kill path is its own); buffs and imbues
 *   send `effectAdd` and later `effectRemove expired`; `buffCancel` ends them;
 * - GM chat `/skill all` learns every row the masteries allow after raising them to the level; `/sp <n>` sets SP.
 */
import { HOTBAR_SLOTS, isStaff, MASTERY_CODES, MOUSE_SLOT, type ClientMessage, type EffectState, type HotbarEntry, type MasteryCode, type ServerMessage, type SkillDef } from '@sro/shared'
import type { MockConn, MockContext, MockEntity, MockExtension } from '../mock.ts'

interface CharSkills {
  masteries: Record<MasteryCode, number>
  learned: Map<string, SkillDef>
  hotbar: (HotbarEntry | null)[]
  /** The mouse quick slot (MOUSE_SLOT). */
  mouse: HotbarEntry | null
  cooldowns: Map<string, number>
  effects: Map<number, { skill: string; group: string; until: number; carrier: number }>
}

const chars = new Map<number, CharSkills>()
let serial = 1

function charOf(conn: MockConn): CharSkills {
  const id = conn.charId ?? -1
  let c = chars.get(id)
  if (!c) {
    c = {
      masteries: Object.fromEntries(MASTERY_CODES.map(m => [m, 0])) as Record<MasteryCode, number>,
      learned: new Map(),
      hotbar: new Array<HotbarEntry | null>(HOTBAR_SLOTS).fill(null),
      mouse: null,
      cooldowns: new Map(),
      effects: new Map(),
    }
    chars.set(id, c)
  }
  return c
}

const skills = (ctx: MockContext): SkillDef[] => [...ctx.content.skills.values()]
const heads = (ctx: MockContext, group: string) => skills(ctx).filter(s => s.group === group && !s.basicAttack && (s.chainIndex ?? 1) === 1).sort((a, b) => a.skillLevel - b.skillLevel)

function snapshot(c: CharSkills): ServerMessage {
  const msg: ServerMessage = { t: 'skills', masteries: { ...c.masteries }, skills: [...c.learned.values()].map(s => s.code), hotbar: [...c.hotbar] }
  if (c.mouse) msg.mouse = { ...c.mouse }
  return msg
}

function sp(e: MockEntity): number {
  return e.player?.prog.sp ?? 0
}

function setSp(e: MockEntity, value: number): void {
  if (!e.player) return
  e.player.prog.sp = Math.max(0, Math.floor(value))
  e.player.conn.deliver({ t: 'statsDelta', stats: { sp: e.player.prog.sp } })
}

function learnAll(ctx: MockContext, c: CharSkills, level: number): number {
  for (const m of MASTERY_CODES) c.masteries[m] = Math.max(c.masteries[m], level)
  let n = 0
  for (const s of skills(ctx)) {
    if (!s.group || s.basicAttack || (s.chainIndex ?? 1) !== 1 || !s.mastery) continue
    if (s.masteryLevel > (c.masteries[s.mastery as MasteryCode] ?? 0)) continue
    const cur = c.learned.get(s.group)
    if (!cur || cur.skillLevel < s.skillLevel) {
      c.learned.set(s.group, s)
      n++
    }
  }
  return n
}

function gm(ctx: MockContext, conn: MockConn, text: string): boolean {
  const [cmd, arg] = text.slice(1).trim().split(/\s+/)
  if (cmd !== 'skill' && cmd !== 'sp') return false
  const e = ctx.selfOf(conn)
  if (!isStaff(conn.role) || !e?.player) {
    ctx.send(conn, { t: 'error', code: 'forbidden', message: 'GM commands need a GM account.', re: 'chat' })
    return true
  }
  const c = charOf(conn)
  if (cmd === 'sp') {
    const n = Number(arg)
    if (!Number.isFinite(n) || n < 0) ctx.send(conn, { t: 'gmResult', ok: false, cmd: 'sp', message: 'usage: sp <points>' })
    else {
      setSp(e, n)
      ctx.send(conn, { t: 'gmResult', ok: true, cmd: 'sp', message: `SP set to ${Math.floor(n)}.` })
    }
    return true
  }
  const n = learnAll(ctx, c, e.player.prog.level)
  ctx.send(conn, { t: 'skillsUpdate', masteries: { ...c.masteries }, learned: [...c.learned.values()].map(s => s.code) })
  ctx.send(conn, { t: 'gmResult', ok: true, cmd: 'skill', message: `Learned ${n} skill levels (masteries at ${e.player.prog.level}).` })
  return true
}

function effectOn(ctx: MockContext, c: CharSkills, carrier: MockEntity, def: SkillDef, now: number): void {
  const group = def.group ?? def.code
  for (const [inst, fx] of c.effects) {
    if (fx.carrier !== carrier.state.id || fx.group !== group) continue
    c.effects.delete(inst)
    ctx.broadcast({ t: 'effectRemove', id: carrier.state.id, instance: inst, reason: 'replaced' })
  }
  const dur = def.durationMs ?? 60_000
  const instance = serial++
  c.effects.set(instance, { skill: def.code, group, until: now + dur, carrier: carrier.state.id })
  const effect: EffectState = { instance, skill: def.code, level: def.skillLevel, remainingMs: dur, source: carrier.state.id }
  ctx.broadcast({ t: 'effectAdd', id: carrier.state.id, effect })
}

function useSkill(ctx: MockContext, conn: MockConn, msg: Extract<ClientMessage, { t: 'useSkill' }>): void {
  const e = ctx.selfOf(conn)
  const p = e?.player
  if (!e || !p) return ctx.result(conn, 'useSkill', false, 'not_found')
  if (p.prog.dead) return ctx.result(conn, 'useSkill', false, 'dead')
  const c = charOf(conn)
  const asked = ctx.content.skills.get(msg.skill)
  if (!asked?.group) return ctx.result(conn, 'useSkill', false, 'not_found')
  const def = c.learned.get(asked.group)
  if (!def) return ctx.result(conn, 'useSkill', false, 'not_learned')
  const now = ctx.now()
  if ((c.cooldowns.get(def.group!) ?? 0) > now) return ctx.result(conn, 'useSkill', false, 'cooldown')
  if (p.prog.mp < def.mp) return ctx.result(conn, 'useSkill', false, 'not_enough_mp')
  const target = msg.target !== undefined ? ctx.entity(msg.target) : undefined
  const attack = def.kind === 'attack' || def.kind === 'debuff'
  if (attack && (!target?.mob || target.mob.mode === 'dead')) return ctx.result(conn, 'useSkill', false, 'invalid_target')
  ctx.result(conn, 'useSkill', true)
  p.prog.mp -= def.mp
  conn.deliver({ t: 'statsDelta', stats: { mp: p.prog.mp } })
  if (def.cooldownMs > 0) c.cooldowns.set(def.group!, now + def.cooldownMs)
  const instance = serial++
  const prep = def.preparingMs ?? 0
  const cast: ServerMessage = def.instant
    ? { t: 'cast', id: e.state.id, skill: def.code, instance, instant: true, prepareMs: 0, castMs: 0, actionMs: 0 }
    : { t: 'cast', id: e.state.id, skill: def.code, instance, ...(target ? { target: target.state.id } : {}), prepareMs: prep, castMs: def.castMs, actionMs: def.actionMs }
  ctx.broadcast(cast)
  const release = prep + (def.castMs > 1 ? def.castMs : 0)
  if (attack && target) {
    // Every chain segment in turn, one combat each at its release (presentation only: HP never reaches 0).
    let at = release
    const segs: SkillDef[] = [def]
    for (let s = def; s.chainNext && segs.length < 8; ) {
      const next = ctx.content.skills.get(s.chainNext)
      if (!next) break
      segs.push(next)
      s = next
    }
    segs.forEach((seg, i) => {
      const segInstance = i === 0 ? instance : serial++
      const t0 = at
      setTimeout(() => {
        if (i > 0) ctx.broadcast({ t: 'cast', id: e.state.id, skill: seg.code, instance: segInstance, target: target.state.id, prepareMs: 0, castMs: seg.castMs, actionMs: seg.actionMs })
        setTimeout(() => {
          const hp0 = target.state.hp ?? 1
          const hits = Array.from({ length: seg.damage?.hits ?? 1 }, (_, k) => {
            const dmg = Math.max(1, Math.round((seg.damage?.flat[1] ?? 10) * (1 + (seg.damage?.physPct ?? 100) / 100) * (0.9 + Math.random() * 0.2)))
            const hp = Math.max(1, hp0 - dmg * (k + 1))
            return { damage: dmg, outcome: 'hit' as const, hp }
          })
          target.state.hp = hits[hits.length - 1]!.hp
          ctx.broadcast({ t: 'combat', attacker: e.state.id, target: target.state.id, skill: seg.code, hits, instance: segInstance })
        }, i > 0 ? Math.max(0, seg.castMs) : 0)
      }, t0)
      at += (i === 0 ? seg.actionMs : seg.castMs + seg.actionMs)
    })
    return
  }
  if (def.kind === 'buff' || def.kind === 'imbue') setTimeout(() => effectOn(ctx, c, e, def, ctx.now()), def.instant ? 0 : release)
  if (def.kind === 'heal' && def.heal) {
    setTimeout(() => {
      const heal = def.heal!
      p.prog.hp += heal.hp
      p.prog.mp += heal.mp
      conn.deliver({ t: 'statsDelta', stats: { hp: p.prog.hp, mp: p.prog.mp } })
    }, release)
  }
}

export const skillsMock: MockExtension = {
  enter(ctx, conn) {
    const c = charOf(conn)
    c.effects.clear()
    ctx.send(conn, snapshot(c))
  },

  tick(ctx, now) {
    for (const c of chars.values()) {
      for (const [inst, fx] of c.effects) {
        if (fx.until > now) continue
        c.effects.delete(inst)
        ctx.broadcast({ t: 'effectRemove', id: fx.carrier, instance: inst, reason: 'expired' })
      }
    }
  },

  handle(ctx, conn, msg) {
    switch (msg.t) {
      case 'chat':
        return msg.text.startsWith('/') && gm(ctx, conn, msg.text)
      case 'useSkill':
        useSkill(ctx, conn, msg)
        return true
      case 'hotbarSet': {
        const e = msg.entry
        if (e?.kind === 'item' && !ctx.content.items.get(e.code)?.use) {
          ctx.result(conn, 'hotbarSet', false, 'not_usable')
          return true
        }
        if (e?.kind === 'skill' && !ctx.content.skills.get(e.code)) {
          ctx.result(conn, 'hotbarSet', false, 'not_found')
          return true
        }
        const c = charOf(conn)
        if (msg.slot === MOUSE_SLOT) c.mouse = e
        else c.hotbar[msg.slot] = e
        ctx.result(conn, 'hotbarSet', true)
        ctx.send(conn, { t: 'skillsUpdate', hotbar: [{ slot: msg.slot, entry: e }] })
        return true
      }
      case 'masteryUp': {
        const e = ctx.selfOf(conn)
        const c = charOf(conn)
        const level = c.masteries[msg.mastery] ?? 0
        const cost = ctx.content.levels[level]?.masterySp ?? 1
        if (!e?.player) ctx.result(conn, 'masteryUp', false, 'not_found')
        else if (level >= e.player.prog.level) ctx.result(conn, 'masteryUp', false, 'mastery_cap')
        else if (sp(e) < cost) ctx.result(conn, 'masteryUp', false, 'no_sp')
        else {
          ctx.result(conn, 'masteryUp', true)
          c.masteries[msg.mastery] = level + 1
          ctx.send(conn, { t: 'skillsUpdate', masteries: { [msg.mastery]: level + 1 } })
          setSp(e, sp(e) - cost)
        }
        return true
      }
      case 'skillLearn': {
        const e = ctx.selfOf(conn)
        const c = charOf(conn)
        const row = ctx.content.skills.get(msg.skill)
        const cur = row?.group ? c.learned.get(row.group)?.skillLevel ?? 0 : 0
        if (!e?.player || !row?.group || !heads(ctx, row.group).includes(row)) ctx.result(conn, 'skillLearn', false, 'not_found')
        else if (row.skillLevel !== cur + 1) ctx.result(conn, 'skillLearn', false, 'requirements')
        else if ((c.masteries[row.mastery as MasteryCode] ?? 0) < row.masteryLevel) ctx.result(conn, 'skillLearn', false, 'requirements')
        else if (sp(e) < row.sp) ctx.result(conn, 'skillLearn', false, 'no_sp')
        else {
          ctx.result(conn, 'skillLearn', true)
          c.learned.set(row.group, row)
          ctx.send(conn, { t: 'skillsUpdate', learned: [row.code] })
          setSp(e, sp(e) - row.sp)
        }
        return true
      }
      case 'buffCancel': {
        const e = ctx.selfOf(conn)
        const c = charOf(conn)
        const group = ctx.content.skills.get(msg.skill)?.group
        let found = false
        for (const [inst, fx] of c.effects) {
          if (fx.carrier !== e?.state.id || fx.group !== group) continue
          c.effects.delete(inst)
          ctx.broadcast({ t: 'effectRemove', id: fx.carrier, instance: inst, reason: 'cancelled' })
          found = true
        }
        ctx.result(conn, 'buffCancel', found, found ? undefined : 'not_found')
        return true
      }
    }
    return false
  },
}
