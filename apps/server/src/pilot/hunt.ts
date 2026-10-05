import type { Mob, Player } from '../world.ts'
import type { Pilot } from './service.ts'
import { bearing } from './steer.ts'
import { HUNT_TRAIL_MAX } from '@sro/shared'
import {
  PING_OFFSET_M,
  ROAR_EVERY_MS,
  ROAR_RANGE_M,
  TRAIL_EVERY_MS,
  TRAIL_KEEP_MS,
  TRAIL_NEAR_M,
  TRAIL_SEND_MS,
  type Associates,
  type HuntEvent,
} from './types.ts'

/**
 * Play the Boss, the hunt's signals (docs/PLAY_THE_BOSS.md §3.6) and the associates (§3.9).
 *
 * - Pings: every `pingSec` (the first one `pingSec` after the start), `huntPing` to every world player but the pilot: a
 *   circle of `pingRadiusM` whose centre is her position plus a random offset of at most 40 m (it always contains her).
 *   Sent while she stalks too.
 * - Footprints: her position every 3 s while she moves, kept 90 s; every 2 s each hunter within 40 m of a point newer
 *   than what he got, who does not see her, gets those points (`huntTrail`).
 * - Roars: every 30 s and on each Fear Roar, hunters 120–400 m away get `huntRoar` (bearing, distance).
 */
export class HuntSignals {
  constructor(readonly s: Pilot) {}

  private get g() {
    return this.s.g
  }

  /** Every world player who hunts her: everyone in the world but the pilot. */
  private hunters(ev: HuntEvent): Player[] {
    const pilot = ev.turn?.player ?? null
    return [...this.g.world.players.values()].filter((p) => p.id !== pilot)
  }

  tick(ev: HuntEvent, m: Mob, now: number): void {
    const w = this.g.world
    if (m.move && now - ev.trailAt >= TRAIL_EVERY_MS) {
      const at = w.positionAt(m, now)
      ev.trail.push({ x: at[0], z: at[2], at: now })
      ev.trailAt = now
    }
    while (ev.trail.length && now - ev.trail[0].at > TRAIL_KEEP_MS) ev.trail.shift()
    if (now - ev.trailSentAt >= TRAIL_SEND_MS && ev.trail.length) {
      ev.trailSentAt = now
      for (const h of this.hunters(ev)) {
        if (h.dead || h.known.has(m.id)) continue
        const seen = ev.trailSeen.get(h.id) ?? 0
        const hp = w.positionAt(h, now)
        const points = ev.trail.filter((p) => p.at > seen && (p.x - hp[0]) ** 2 + (p.z - hp[2]) ** 2 <= TRAIL_NEAR_M ** 2).slice(-HUNT_TRAIL_MAX)
        if (points.length === 0) continue
        ev.trailSeen.set(h.id, points[points.length - 1].at)
        h.send({ t: 'huntTrail', points: points.map((p) => [round1(p.x), round1(p.z), p.at]) })
      }
    }
    if (now >= ev.nextPingAt) {
      ev.nextPingAt = now + ev.conf.settings.hunt.pingSec * 1000
      this.ping(ev, m, now)
    }
    if (now >= ev.nextRoarAt) this.roar(ev, m, now)
  }

  /** A sighting: a circle that contains her, centred off her by at most PING_OFFSET_M. */
  ping(ev: HuntEvent, m: Mob, now: number): void {
    const r = ev.conf.settings.hunt.pingRadiusM
    const at = this.g.world.positionAt(m, now)
    const a = this.s.rng() * Math.PI * 2
    const off = this.s.rng() * Math.min(PING_OFFSET_M, Math.max(0, r - 1))
    const msg = { t: 'huntPing', event: ev.id, x: round1(at[0] + Math.sin(a) * off), z: round1(at[2] + Math.cos(a) * off), r, at: now } as const
    for (const h of this.hunters(ev)) h.send(msg)
  }

  /** Her roar to the hunters 120–400 m away (the next timed one 30 s later). */
  roar(ev: HuntEvent, m: Mob, now: number): void {
    ev.nextRoarAt = now + ROAR_EVERY_MS
    const at = this.g.world.positionAt(m, now)
    for (const h of this.hunters(ev)) {
      const hp = this.g.world.positionAt(h, now)
      const d = Math.hypot(at[0] - hp[0], at[2] - hp[2])
      if (d < ROAR_RANGE_M[0] || d > ROAR_RANGE_M[1]) continue
      h.send({ t: 'huntRoar', bearing: bearing(hp[0], hp[2], at[0], at[2]), distM: Math.round(d), at: now })
    }
  }
}

const round1 = (v: number) => Math.round(v * 10) / 10

/**
 * The pilot's associates (§3.9), frozen at accept: the pilot's party, guild members, the other characters of the
 * pilot's account; plus, checked live, accounts whose game socket shares the pilot's IP.
 */
export function freezeAssociates(s: Pilot, p: Player): Associates {
  const chars = new Set<number>([p.characterId])
  const accounts = new Set<number>()
  const acc = s.accountOf(p.characterId)
  if (acc !== null) {
    accounts.add(acc)
    for (const r of s.g.store.characters(acc)) chars.add(r.id)
  }
  for (const m of s.g.party.partyOf(p)?.members ?? []) chars.add(m.characterId)
  for (const id of s.g.guilds.guildOf(p)?.members.keys() ?? []) chars.add(id)
  return { chars, accounts, ip: s.ipOf(p) }
}

export function isAssociate(s: Pilot, a: Associates, q: Player): boolean {
  if (a.chars.has(q.characterId)) return true
  const acc = s.accountOf(q.characterId)
  if (acc !== null && a.accounts.has(acc)) return true
  if (a.ip !== null && s.ipOf(q) === a.ip) return true
  return false
}
