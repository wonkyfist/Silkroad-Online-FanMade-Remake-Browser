/**
 * Auto potion (Options → Controls → Auto potion; retail's "Auto potion" / macro potion window, UIIT_PAG_MACROPOTION):
 * below the HP threshold drink an HP potion, below the MP threshold an MP potion, and (optionally) take a Universal
 * Pill while an abnormal state is on the character.
 *
 * - It sends exactly what a hotbar press of that item sends: `itemUse` of the lowest bag slot holding the code
 *   (hud/hotbar-model.ts), so the server's own checks and cooldown groups apply (apps/server/src/item-use.ts).
 * - Never while dead, running a stall or trading (the server refuses item use there: social/stall.ts, trade.ts);
 *   never while the item's cooldown group is cooling down on the client clock or a request of that group is still
 *   unanswered (at least MIN_GAP_MS apart); after a refusal it waits REFUSED_BACKOFF_MS.
 * - Which potion: the plain HP (or MP) potions first; vigor potions (HP and MP, their own cooldown group) only when the
 *   bag has no plain one. Among those, the smallest that restores at least COVER of what is missing, else the biggest.
 *   Which pill: the smallest whose cure level covers the worst state, else the biggest that cures any of them.
 * - Out of potions (or pills while one is needed): one notice, again only after the bag held some in between.
 * Pure logic with injected dependencies (tested without a scene); world/features/auto-potion.ts wires it.
 */
import type { ClientMessage, ItemDef, ItemStack, ItemUse, SkillStatusKind } from '@sro/shared'
import { intent } from '../hud/intents.ts'

/** A potion counts as covering the missing amount when it restores at least this share of it. */
export const COVER = 0.75
/** Checks per second at most (the bag scan is cheap, but no need to run it every frame). */
export const TICK_MS = 100
/** Requests of one cooldown group are at least this far apart, whatever the item's cooldown says. */
export const MIN_GAP_MS = 1000
/** Added to the cooldown before a group is tried again without word from the server (itemCooldown re-arms it). */
export const SLACK_MS = 150
/** After a refused use, nothing is tried for this long (a refusal toasts; it must not repeat every second). */
export const REFUSED_BACKOFF_MS = 3000

/**
 * The abnormal states a Universal Pill cures: the server's STATUS_RULES `abnormal` flag
 * (apps/server/src/skills/effects.ts). Stun and knockdown are crowd control, not abnormal.
 */
export const ABNORMAL_STATUSES: ReadonlySet<SkillStatusKind> = new Set<SkillStatusKind>(['freeze', 'frostbite', 'shock', 'burn', 'poison', 'zombie', 'darkness'])

export type Vital = 'hp' | 'mp'
export type RunOut = Vital | 'pill'

export interface AutoPotionSettings {
  enabled: boolean
  /** Percent of max HP / MP below which a potion is drunk; 0 = never. */
  hp: number
  mp: number
  cure: boolean
}

export interface Vitals {
  hp: number
  maxHp: number
  mp: number
  maxMp: number
}

/** The bag as the auto potion reads it. */
export interface BagView {
  bagSize(): number
  bag(i: number): ItemStack | null
  item(code: string): ItemDef | undefined
}

export interface Candidate {
  code: string
  /** The lowest bag slot holding the code (what a hotbar press would use). */
  bag: number
  /** The server's cooldown group (ItemUse.cooldownGroup, else the code: item-use.ts). */
  group: string
  cooldownMs: number
  /** Potions: HP (or MP) restored now. Pills: their cure level. */
  amount: number
  /** Potions: restores only this vital (not a vigor potion). */
  pure: boolean
}

/** What `use` restores of `kind` for a character with `max` of it. */
export function restoreOf(use: ItemUse, kind: Vital, max: number): number {
  const flat = kind === 'hp' ? use.hp ?? 0 : use.mp ?? 0
  const pct = kind === 'hp' ? use.hpPct ?? 0 : use.mpPct ?? 0
  return flat + (pct * Math.max(0, max)) / 100
}

/** Whether `def` is a potion of the character's own (not a horse kit, scroll or pill). */
function ownPotion(def: ItemDef | undefined): def is ItemDef & { use: ItemUse } {
  const use = def?.use
  if (!def || !use || def.category === 'pill' || def.cureLevel !== undefined) return false
  return !use.target && !use.summon && !use.returnToTown
}

function isPill(def: ItemDef | undefined): def is ItemDef & { use: ItemUse } {
  return !!def?.use && (def.category === 'pill' || def.cureLevel !== undefined) && !def.use.target
}

/** One candidate per item code, at its lowest bag slot. */
function scan(v: BagView, make: (def: ItemDef & { use: ItemUse }, bag: number) => Candidate | null, accept: (def: ItemDef | undefined) => def is ItemDef & { use: ItemUse }): Candidate[] {
  const seen = new Set<string>()
  const out: Candidate[] = []
  const n = v.bagSize()
  for (let i = 0; i < n; i++) {
    const s = v.bag(i)
    if (!s || s.count <= 0 || seen.has(s.code)) continue
    seen.add(s.code)
    const def = v.item(s.code)
    if (!accept(def)) continue
    const c = make(def, i)
    if (c) out.push(c)
  }
  return out
}

/** The bag's potions that restore `kind` (one per code, lowest bag slot). */
export function potionCandidates(v: BagView, kind: Vital, max: number): Candidate[] {
  return scan(
    v,
    (def, bag) => {
      const use = def.use
      const amount = restoreOf(use, kind, max)
      if (!(amount > 0)) return null
      const other = kind === 'hp' ? (use.mp ?? 0) + (use.mpPct ?? 0) : (use.hp ?? 0) + (use.hpPct ?? 0)
      return { code: def.code, bag, group: use.cooldownGroup ?? def.code, cooldownMs: use.cooldownMs ?? 0, amount, pure: !(other > 0) }
    },
    ownPotion,
  )
}

/** The bag's Universal Pills (amount = cure level). */
export function pillCandidates(v: BagView): Candidate[] {
  return scan(v, (def, bag) => ({ code: def.code, bag, group: def.use.cooldownGroup ?? def.code, cooldownMs: def.use.cooldownMs ?? 0, amount: def.cureLevel ?? 0, pure: true }), isPill)
}

/** The smallest potion that restores at least COVER of `missing`, else the biggest (null: none). */
export function pickPotion<T extends { amount: number }>(list: readonly T[], missing: number): T | null {
  if (!list.length) return null
  const sorted = [...list].sort((a, b) => a.amount - b.amount)
  return sorted.find(c => c.amount >= missing * COVER) ?? sorted[sorted.length - 1]!
}

/**
 * The pill for abnormal states of these levels: the smallest whose cure level covers the worst, else the biggest that
 * cures at least one (the server cures every state at or below the pill's level); null when none cures anything.
 */
export function pickPill<T extends { amount: number }>(list: readonly T[], levels: readonly number[]): T | null {
  if (!list.length || !levels.length) return null
  const worst = Math.max(...levels)
  const least = Math.min(...levels)
  const sorted = [...list].sort((a, b) => a.amount - b.amount)
  return sorted.find(p => p.amount >= worst) ?? [...sorted].reverse().find(p => p.amount >= least) ?? null
}

export interface AutoPotionDeps extends BagView {
  settings(): AutoPotionSettings
  /** Own HP/MP (null before the first `stats`). */
  vitals(): Vitals | null
  /** True while no item may be used: dead (or not in the world), running a stall, trading. */
  blocked(): boolean
  /** The levels of the abnormal states on the own character now. */
  abnormal(): readonly number[]
  /** Milliseconds left on item cooldown group `group` (the HUD's CooldownClock). */
  cooldownLeft(group: string): number
  send(msg: ClientMessage): boolean
  /** Out of potions (or pills): shown once per run-out. */
  notice(kind: RunOut): void
}

export class AutoPotion {
  /** Cooldown group -> the time before which it is not tried again (an answer re-arms the CooldownClock). */
  private readonly pending = new Map<string, number>()
  private readonly out = new Set<RunOut>()
  private backoffUntil = -Infinity
  private nextTick = -Infinity
  private lastSentAt = -Infinity

  constructor(private readonly deps: AutoPotionDeps) {}

  /** Every frame (`now` on one clock, e.g. cooldownNow()). */
  tick(now: number): void {
    if (now < this.nextTick) return
    this.nextTick = now + TICK_MS
    const s = this.deps.settings()
    if (!s.enabled || now < this.backoffUntil || this.deps.blocked()) return
    const v = this.deps.vitals()
    if (!v || !(v.hp > 0)) return
    if (s.hp > 0 && v.maxHp > 0 && v.hp * 100 < s.hp * v.maxHp) this.restore('hp', v.maxHp - v.hp, v.maxHp, now)
    if (s.mp > 0 && v.maxMp > 0 && v.mp * 100 < s.mp * v.maxMp) this.restore('mp', v.maxMp - v.mp, v.maxMp, now)
    if (s.cure) this.cure(now)
  }

  /** Whether an auto use went out within `ms` before `now` (a refusal then is most likely ours). */
  sentWithin(now: number, ms: number): boolean {
    return now - this.lastSentAt <= ms
  }

  /** The server refused an item use: wait before trying anything again. */
  refused(now: number): void {
    this.backoffUntil = now + REFUSED_BACKOFF_MS
  }

  /** A new world visit (or a warp): forget the unanswered requests and the run-out notices. */
  reset(): void {
    this.pending.clear()
    this.out.clear()
    this.backoffUntil = -Infinity
    this.nextTick = -Infinity
  }

  private ready(group: string, now: number): boolean {
    return this.deps.cooldownLeft(group) <= 0 && (this.pending.get(group) ?? -Infinity) <= now
  }

  private restore(kind: Vital, missing: number, max: number, now: number): void {
    const all = potionCandidates(this.deps, kind, max)
    if (!all.length) return this.runOut(kind)
    this.out.delete(kind)
    const pure = all.filter(c => c.pure)
    const pick = pickPotion((pure.length ? pure : all).filter(c => this.ready(c.group, now)), missing)
    if (pick) this.use(pick, now)
  }

  private cure(now: number): void {
    const levels = this.deps.abnormal()
    if (!levels.length) return
    const pills = pillCandidates(this.deps)
    if (!pills.length) return this.runOut('pill')
    this.out.delete('pill')
    const pick = pickPill(pills.filter(p => this.ready(p.group, now)), levels)
    if (pick) this.use(pick, now)
  }

  private use(c: Candidate, now: number): void {
    const msg = intent.itemUse(c.bag)
    if (!msg || !this.deps.send(msg)) return
    this.pending.set(c.group, now + Math.max(c.cooldownMs, MIN_GAP_MS) + SLACK_MS)
    this.lastSentAt = now
  }

  private runOut(kind: RunOut): void {
    if (this.out.has(kind)) return
    this.out.add(kind)
    this.deps.notice(kind)
  }
}
