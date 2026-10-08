/**
 * The Climb's rewards (docs/CLIMB.md §4.2, §5.1, §7.3; build plan §20 layer L7; the rules in
 * packages/shared/src/climb-rewards.ts). A GameplayModule named `climbRewards`, only with CLIMB on.
 *
 * - **Titles** (§7.3, S-TITLE): the achievements of CLIMB_ACHIEVEMENTS grant their title into the titles table the
 *   events already use (`pilot_honors`: Play the Boss's "Spirit of the Tiger", the Siege's "Defender of Jangan"), so a
 *   title is one seam for the wave. Kill counters live in `char_achievements` (migration 22): every player the kill
 *   credits (the quest credit rule) counts it. "Climber" at the cap, "Deathless" at the cap with no penalised death
 *   counted since this layer, "Pioneer" by migration 22. The worn title is `characters.title` (`climbTitle`; null = the
 *   newest), shown as EntityState.honor (the pilot service's and the siege's look-ups read it first).
 * - **Set bonuses** (§4.2, S-SETS): one SkillEngine mod provider over the worn items (climbSetBonus): max HP %, defence
 *   %, damage %.
 * - **Arts** (§5.1, S-ARTS): `climbArt` picks one of two per tree and tier (mastery 10 / 15 / 20; the force tree reads
 *   the best force mastery); the first pick of a tier is free, a change costs CLIMB_ART_RESPEC_GOLD × the tier's index.
 *   Saved in `characters.arts`. The skill engine asks `arts(p)` when it plans a cast (applyClimbArts: the row's numbers)
 *   and at each hit (Executioner); the provider adds the stat Arts (Iron Lung, Ward, Demon Soul); the Soul Rebirth
 *   Art asks `rebirth(caster)` (the whole penalty back). Arts marked `later` are shown but change nothing yet.
 * - **Messages**: `climb` (titles, worn title, Arts, counters) at worldEnter and on every change; a system line per new
 *   title.
 */
import {
  CLIMB_ACHIEVEMENTS,
  CLIMB_ART_RESPEC_GOLD,
  CLIMB_ART_TIERS,
  TITLE_NAMES,
  climbActiveArts,
  climbArt,
  climbArtKey,
  climbSetBonus,
  climbTreeLevel,
  parseClimbArts,
  type ClimbArt,
  type GameplayRequest,
  type ItemDef,
} from '@sro/shared'
import { addGold } from '../inventory.ts'
import type { Gameplay } from '../gameplay.ts'
import type { Answer, GameplayMessage, GameplayModule, KillOwner } from '../modules.ts'
import type { StatMod } from '../skills/mods.ts'
import type { Mob, Player } from '../world.ts'

/** The counter of penalised deaths since level 15 (no title; "Deathless" reads it). */
export const DEATHS_COUNTER = 'deaths15'

interface CharState {
  arts: Record<string, string>
  title: string | null
  titles: string[]
  progress: Map<string, number>
}

export class ClimbRewards implements GameplayModule {
  readonly name = 'climbRewards'
  readonly handles: readonly GameplayRequest[] = ['climbArt', 'climbTitle']
  /** characterId -> its state while in the world. */
  private readonly chars = new Map<number, CharState>()

  constructor(readonly g: Gameplay) {
    g.skills.addModProvider((p) => this.mods(p))
    g.penalty.onTaken.push((p) => this.count(p, DEATHS_COUNTER, 1))
    // a title without the pilot service or the siege (their decorators run first; this fills the gap)
    g.world.decorators.push((e, s) => {
      if (e.kind !== 'player' || s.honor) return
      const st = this.chars.get(e.characterId)
      const h = st ? (st.title ?? st.titles[0] ?? null) : null
      if (h) s.honor = h
    })
  }

  private get on(): boolean {
    return this.g.config.climb === true
  }

  // ---- state ------------------------------------------------------------------------------------------------

  private state(p: Player): CharState {
    let st = this.chars.get(p.characterId)
    if (st) return st
    const db = this.g.store.db
    const row = db.prepare('SELECT title, arts FROM characters WHERE id = ?').get(p.characterId) as { title: string | null; arts: string } | undefined
    const titles = (db.prepare('SELECT code FROM pilot_honors WHERE character_id = ? ORDER BY at DESC').all(p.characterId) as { code: string }[]).map((r) => r.code)
    const progress = new Map((db.prepare('SELECT id, progress FROM char_achievements WHERE character_id = ?').all(p.characterId) as { id: string; progress: number }[]).map((r) => [r.id, r.progress]))
    st = { arts: parseClimbArts(row?.arts), title: row?.title && titles.includes(row.title) ? row.title : null, titles, progress }
    this.chars.set(p.characterId, st)
    return st
  }

  /** The Arts in effect for `p` (the skill engine's look-up; [] with CLIMB off). */
  arts(p: Player): ClimbArt[] {
    if (!this.on) return []
    return climbActiveArts(this.state(p).arts, this.g.skills.masteriesOf(p))
  }

  /** The Rebirth Art (§5.1): the caster's Soul Rebirth refunds all of the penalty. */
  rebirth(caster: Player): boolean {
    return this.arts(caster).some((a) => a.rebirth)
  }

  private send(p: Player): void {
    const st = this.state(p)
    p.send({ t: 'climb', titles: [...st.titles], title: st.title, arts: { ...st.arts }, progress: Object.fromEntries(st.progress) })
  }

  // ---- hooks --------------------------------------------------------------------------------------------------

  enter(p: Player): void {
    if (!this.on) return
    this.chars.delete(p.characterId)
    this.checkLevel(p, this.g.now)
    this.send(p)
  }

  tickPlayer(p: Player, now: number): void {
    if (!this.on || p.level < this.g.config.levelCap) return
    const st = this.chars.get(p.characterId)
    if (st && !st.titles.includes('climber')) this.checkLevel(p, now)
  }

  forget(p: Player): void {
    this.chars.delete(p.characterId)
  }

  mobDied(m: Mob, now: number, credit: ReadonlySet<number>, _owner: KillOwner): void {
    if (!this.on) return
    const rules = CLIMB_ACHIEVEMENTS.filter((a) => a.rule.kind === 'kill' && a.rule.mobs.includes(m.def.code))
    for (const id of credit) {
      const p = this.g.world.players.get(id)
      if (!p) continue
      for (const a of rules) {
        if (a.rule.kind !== 'kill') continue
        const n = this.count(p, a.code, 1)
        if (n >= a.rule.n) this.grant(p, a.code, now)
        else this.send(p)
      }
      this.checkLevel(p, now)
    }
  }

  /** Climber and Deathless at the cap. */
  private checkLevel(p: Player, now: number): void {
    if (p.level < this.g.config.levelCap) return
    const st = this.state(p)
    if (!st.titles.includes('climber')) this.grant(p, 'climber', now)
    if (!st.titles.includes('deathless') && (st.progress.get(DEATHS_COUNTER) ?? 0) === 0) this.grant(p, 'deathless', now)
  }

  /** Adds `n` to a counter (saved); returns the new value. */
  private count(p: Player, id: string, n: number): number {
    if (!this.on) return 0
    const st = this.state(p)
    const v = (st.progress.get(id) ?? 0) + n
    st.progress.set(id, v)
    this.g.store.db
      .prepare('INSERT INTO char_achievements (character_id, id, progress) VALUES (?, ?, ?) ON CONFLICT(character_id, id) DO UPDATE SET progress = excluded.progress')
      .run(p.characterId, id, v)
    return v
  }

  /** Grants title `code` once (saved, shown, announced to the player). */
  grant(p: Player, code: string, now: number): boolean {
    const st = this.state(p)
    if (st.titles.includes(code)) return false
    const db = this.g.store.db
    if (db.prepare('INSERT OR IGNORE INTO pilot_honors (character_id, code, at) VALUES (?, ?, ?)').run(p.characterId, code, now).changes === 0) return false
    db.prepare('UPDATE char_achievements SET done_at = ? WHERE character_id = ? AND id = ?').run(now, p.characterId, code)
    st.titles.unshift(code)
    p.send({ t: 'chat', channel: 'system', text: `You earned the title "${TITLE_NAMES[code] ?? code}".` })
    this.shown(p)
    this.send(p)
    return true
  }

  /** The worn title changed (or a newer one now leads): every look-up cache and every viewer. */
  private shown(p: Player): void {
    const st = this.state(p)
    const h = st.title ?? st.titles[0] ?? ''
    if (h) this.g.pilot?.honorGranted(p.characterId, h)
    this.g.world.broadcastAbout(p, { t: 'entityUpdate', id: p.id, honor: h })
  }

  // ---- the mod provider (sets and stat Arts) --------------------------------------------------------------------

  private mods(p: Player): StatMod[] {
    if (!this.on) return []
    const worn: ItemDef[] = []
    for (const st of Object.values(p.equip)) {
      const def = st ? this.g.data.item(st.code) : undefined
      if (def) worn.push(def)
    }
    const set = climbSetBonus(worn).mods
    let { maxHpPct, defencePct, damagePct } = set
    const arts = this.chars.has(p.characterId) ? this.arts(p) : []
    for (const a of arts) {
      const m = a.mods
      if (!m) continue
      const ok = m.when === 'learned' ? m.whileGroups.some((g) => this.g.skills.learned(p, g)) : m.whileGroups.some((g) => this.g.skills.effectActive(p, g))
      if (!ok) continue
      maxHpPct += m.maxHpPct ?? 0
      defencePct += m.defencePct ?? 0
      damagePct += m.damagePct ?? 0
    }
    const out: StatMod[] = []
    if (maxHpPct) out.push({ stat: 'maxHpPct', value: maxHpPct })
    if (defencePct) out.push({ stat: 'physDefencePct', value: defencePct }, { stat: 'magDefencePct', value: defencePct })
    if (damagePct) out.push({ stat: 'physDamagePct', value: damagePct }, { stat: 'magDamagePct', value: damagePct })
    return out
  }

  // ---- requests -------------------------------------------------------------------------------------------------

  request(p: Player, msg: GameplayMessage, answer: Answer, now: number): void {
    if (!this.on) return answer({ ok: false, reason: 'not_found', message: 'The Climb is off on this server.' })
    if (msg.t === 'climbTitle') return answer(this.wear(p, msg.code))
    if (msg.t === 'climbArt') return answer(this.pick(p, msg.tree, msg.tier, msg.art, now))
    answer({ ok: false, reason: 'not_found' })
  }

  private wear(p: Player, code: string): true | { ok: false; reason: 'not_found'; message: string } {
    const st = this.state(p)
    if (code !== '' && !st.titles.includes(code)) return { ok: false, reason: 'not_found', message: 'You do not hold that title.' }
    st.title = code === '' ? null : code
    this.g.store.db.prepare('UPDATE characters SET title = ? WHERE id = ?').run(st.title, p.characterId)
    this.shown(p)
    this.send(p)
    return true
  }

  private pick(p: Player, tree: string, tier: number, id: string, _now: number): true | { ok: false; reason: 'not_found' | 'requirements' | 'not_enough_gold'; message?: string } {
    const a = climbArt(id)
    if (!a || a.tree !== tree || a.tier !== tier) return { ok: false, reason: 'not_found', message: 'No such Art for that tier.' }
    if (climbTreeLevel(a.tree, this.g.skills.masteriesOf(p)) < a.tier) return { ok: false, reason: 'requirements', message: `Needs mastery ${a.tier}.` }
    const st = this.state(p)
    const key = climbArtKey(a.tree, a.tier)
    const had = st.arts[key]
    if (had === a.id) return true
    const cost = had ? CLIMB_ART_RESPEC_GOLD * (CLIMB_ART_TIERS.indexOf(a.tier) + 1) : 0
    const next = { ...st.arts, [key]: a.id }
    const save = () => void this.g.store.db.prepare('UPDATE characters SET arts = ? WHERE id = ?').run(JSON.stringify(next), p.characterId)
    if (cost > 0) {
      const { result, draft } = this.g.store.inventoryTx(p.characterId, (d) => addGold(d, -cost), save)
      if (!result.ok) return { ok: false, reason: 'not_enough_gold', message: `Changing this Art costs ${cost.toLocaleString('en')} gold.` }
      this.g.afterInventory(p, draft)
    } else save()
    st.arts = next
    p.send({ t: 'chat', channel: 'system', text: `Art chosen: ${a.name}${cost ? ` (${cost.toLocaleString('en')} gold)` : ''}.` })
    if (this.g.refresh(p)) p.send({ t: 'stats', stats: this.g.stats(p) })
    else p.send({ t: 'stats', stats: this.g.stats(p) })
    this.send(p)
    return true
  }
}
