import type { MobVariant } from '@sro/shared'

/**
 * What a strike does to a body in its radius (docs/WEATHER.md §2.7) [our rule]: a share of the body's max HP, so it
 * scales with level by itself and is never an instant kill from full. CENTRE_PCT at the strike's centre falling to
 * EDGE_PCT at the edge of the radius; new characters (below NEWBIE_LEVEL) take NEWBIE_MUL of it; strong monsters
 * (champion, giant, titan, elite, party) STRONG_MUL; a unique (or the Play the Boss body) BOSS_PCT and never dies of it
 * (the hunters keep their boss). Then a short stun (STUN_MS), but not on a boss.
 */
export const STRIKE_DAMAGE = {
  centrePct: 0.38,
  edgePct: 0.22,
  newbieLevel: 10,
  newbieMul: 0.6,
  strongMul: 0.6,
  bossPct: 0.03,
} as const

export const STRIKE_STUN_MS = 1500

const STRONG: readonly MobVariant[] = ['champion', 'giant', 'titan', 'elite', 'party']

export interface Struck {
  kind: 'player' | 'mob'
  hp: number
  maxHp: number
  level: number
  variant?: MobVariant
  /** A Play the Boss body (Mob.pilot). */
  piloted?: boolean
}

/** The hit a body takes `dist` metres from the strike's centre of a `radius`-metre strike. */
export function strikeDamage(t: Struck, dist: number, radius: number): { damage: number; stun: boolean } {
  const boss = t.kind === 'mob' && (t.variant === 'unique' || !!t.piloted)
  const k = radius > 0 ? Math.min(1, Math.max(0, dist / radius)) : 0
  let pct = STRIKE_DAMAGE.centrePct + (STRIKE_DAMAGE.edgePct - STRIKE_DAMAGE.centrePct) * k
  if (boss) pct = STRIKE_DAMAGE.bossPct
  else if (t.kind === 'player' && t.level < STRIKE_DAMAGE.newbieLevel) pct *= STRIKE_DAMAGE.newbieMul
  else if (t.kind === 'mob' && t.variant && STRONG.includes(t.variant)) pct *= STRIKE_DAMAGE.strongMul
  let damage = Math.max(1, Math.round(Math.max(0, t.maxHp) * pct))
  if (boss) damage = Math.min(damage, Math.max(0, Math.ceil(t.hp) - 1))
  return { damage, stun: !boss }
}
