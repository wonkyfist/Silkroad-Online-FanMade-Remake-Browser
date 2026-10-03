import { GUILD_NAME, GUILD_PERMS, codePointLength, type GuildPerm, type GuildRank } from '@sro/shared'
import { fail, type Fail } from '../inventory.ts'

/**
 * Guild rules, pure (docs/SYSTEMS_SOCIAL.md §5.2; lane GU-S): the rights bitmask of migration 9
 * (`guild_members.perms`, bit i = GUILD_PERMS[i]), the permission test, the penalty clocks and the refusals of
 * create / invite / kick / title in the order §5.2 lists them. guild.ts gathers the facts and asks these.
 */

export const HOUR_MS = 3_600_000
export const DAY_MS = 24 * HOUR_MS
/** Every right (the master's implicit set; a former master keeps it, §5.2 Mastership). */
export const ALL_PERMS_BITS = (1 << GUILD_PERMS.length) - 1

/** GuildPerm[] -> the guild_members.perms bitmask (0..15). */
export function permsToBits(perms: readonly GuildPerm[]): number {
  let bits = 0
  for (const p of perms) {
    const i = GUILD_PERMS.indexOf(p)
    if (i >= 0) bits |= 1 << i
  }
  return bits
}

/** The guild_members.perms bitmask -> GuildPerm[] in GUILD_PERMS order. */
export function bitsToPerms(bits: number): GuildPerm[] {
  return GUILD_PERMS.filter((_, i) => (bits & (1 << i)) !== 0)
}

/** A member as the rules see it. */
export interface MemberRights {
  characterId: number
  rank: GuildRank
  perms: readonly GuildPerm[]
}

/** The master implicitly has every right (§5.1). */
export function hasPerm(m: MemberRights, perm: GuildPerm): boolean {
  return m.rank === 'master' || m.perms.includes(perm)
}

/**
 * Time left on a penalty clock: `at` (ms, null = never) plus `span` ms; 0 when it ran out or is off (span 0).
 * Config GUILD_REJOIN_HOURS / GUILD_RECREATE_DAYS (default 0 = off).
 */
export function penaltyLeftMs(at: number | null | undefined, span: number, now: number): number {
  if (at === null || at === undefined || !(span > 0)) return 0
  return Math.max(0, at + span - now)
}

/** "71 hours", "15 days", "5 minutes" (rounded up) for a penalty message; hours up to 3 days (the retail 72 h clock). */
export function formatWait(ms: number): string {
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
  if (ms > 3 * DAY_MS) return unit(Math.ceil(ms / DAY_MS), 'day')
  if (ms >= HOUR_MS) return unit(Math.ceil(ms / HOUR_MS), 'hour')
  return unit(Math.max(1, Math.ceil(ms / 60_000)), 'minute')
}

/** `bad_name` when `name` fails GUILD_NAME (2..12 letters/digits, a leading letter) or is reserved (GM, Admin, ...). */
export function nameRefusal(name: string, reserved: (name: string) => boolean): Fail | null {
  if (!GUILD_NAME.test(name)) return fail('bad_name', 'A guild name has 2 to 12 English letters or digits and starts with a letter.')
  if (reserved(name)) return fail('bad_name', 'That name is reserved.')
  return null
}

/** The facts a `guildCreate` is checked against (after the Guild Manager check). */
export interface CreateFacts {
  inGuild: boolean
  level: number
  minLevel: number
  name: string
  reserved: (name: string) => boolean
  /** A live guild has the name (case-insensitive). */
  taken: boolean
  /** characters.guild_disbanded_at of the creator. */
  disbandedAt: number | null
  recreateDays: number
  gold: number
  cost: number
  now: number
}

/** §5.2 Create, in order: in_guild, requirements, bad_name, name_taken, cooldown, not_enough_gold. */
export function createRefusal(f: CreateFacts): Fail | null {
  if (f.inGuild) return fail('in_guild', 'You are already in a guild.')
  if (f.level < f.minLevel) return fail('requirements', `Requires level ${f.minLevel}.`)
  const bad = nameRefusal(f.name, f.reserved)
  if (bad) return bad
  if (f.taken) return fail('name_taken', 'The selected guild name already exists.')
  const wait = penaltyLeftMs(f.disbandedAt, f.recreateDays * DAY_MS, f.now)
  if (wait > 0) return fail('cooldown', `You disbanded a guild recently. You can create a new one in ${formatWait(wait)}.`)
  if (f.gold < f.cost) return fail('not_enough_gold', `Creating a guild costs ${f.cost} gold.`)
  return null
}

/** `guildKick`: the actor's rights against the target (undefined = not a member). */
export function kickRefusal(actor: MemberRights, target: MemberRights | undefined): Fail | null {
  if (!hasPerm(actor, 'kick')) return fail('no_permission', 'You have no right to expel members.')
  if (target?.characterId === actor.characterId) return fail('invalid_target', 'Use Leave to leave the guild.')
  if (!target) return fail('not_found')
  if (target.rank === 'master') return fail('invalid_target', 'The Guild Master cannot be expelled.')
  // An officer with the kick right cannot expel another one (§5.2, G4); the master can.
  if (actor.rank !== 'master' && target.perms.includes('kick')) return fail('no_permission', 'You cannot expel a member who has the same right.')
  return null
}

/**
 * `guildTitle`: the master, or the `title` right; only the master sets the master's own title (an officer cannot
 * rename their master).
 */
export function titleRefusal(actor: MemberRights, target: MemberRights | undefined): Fail | null {
  if (!hasPerm(actor, 'title')) return fail('no_permission', 'You have no right to grant titles.')
  if (!target) return fail('not_found')
  if (target.rank === 'master' && actor.rank !== 'master') return fail('no_permission', 'Only the Guild Master can change their own title.')
  return null
}

/** `guildPerms` / `guildMaster`: master only, on another member. */
export function masterOnlyRefusal(actor: MemberRights, target: MemberRights | undefined, what: string): Fail | null {
  if (actor.rank !== 'master') return fail('no_permission', `Only the Guild Master can ${what}.`)
  if (target?.characterId === actor.characterId) return fail('invalid_target')
  if (!target) return fail('not_found')
  return null
}

/**
 * A title or notice line as typed: cleaned (`clean`: control and bidi characters stripped, trimmed) and at most `max`
 * code points after cleaning; null when it is too long.
 */
export function cleanText(raw: string, max: number, clean: (s: string) => string): string | null {
  const s = clean(raw)
  return codePointLength(s) <= max ? s : null
}
