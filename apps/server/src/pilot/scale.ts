import { PILOT_SCALE_EVERY_MS, pilotKeepFraction, pilotNextMaxHp, pilotScaleFactor, pilotScaledMaxHp } from '@sro/shared'
import type { Mob } from '../world.ts'
import type { Pilot } from './service.ts'
import type { HuntEvent } from './types.ts'

/**
 * Play the Boss, layer 5: big crowds (docs/PLAY_THE_BOSS.md §3.7). N = distinct non-associate players who dealt at
 * least `minDamage` to her in the last `windowSec`; s = (clamp(N, baseHunters, capHunters) / baseHunters)^exponent.
 * Every 5 s her max HP moves toward round(base × s): up at once, down by at most 10 % per step; her HP keeps its
 * fraction (so the 80/60/40 % summon bands and the 20 % enrage are unchanged) and the change goes out as
 * `entityUpdate {hp, maxHp}` to everyone who sees her. Band summons follow s through Uniques.summonPolicy (the Pack
 * does not). Scaling off: she falls back to her base the same way.
 */
export class HuntScaler {
  constructor(readonly s: Pilot) {}

  /** The hunt starts: her current max HP is the base. */
  start(ev: HuntEvent, m: Mob, now: number): void {
    ev.scale = { baseMaxHp: m.maxHp, hits: new Map(), nextAt: now + PILOT_SCALE_EVERY_MS, hunters: 0, factor: 1, peakHunters: 0, peakMaxHp: m.maxHp }
  }

  /** A non-associate hunter's damage to her. */
  hit(ev: HuntEvent, characterId: number, dealt: number, now: number): void {
    const sc = ev.scale
    if (!sc || dealt <= 0) return
    let list = sc.hits.get(characterId)
    if (!list) sc.hits.set(characterId, (list = []))
    list.push([now, dealt])
  }

  /** N now: the hunters with at least `minDamage` in the window (old hits are dropped). */
  hunters(ev: HuntEvent, now: number): number {
    const sc = ev.scale
    if (!sc) return 0
    const s = ev.conf.settings.scaling
    const from = now - s.windowSec * 1000
    let n = 0
    for (const [id, list] of sc.hits) {
      let k = 0
      while (k < list.length && list[k][0] < from) k++
      if (k > 0) list.splice(0, k)
      if (list.length === 0) {
        sc.hits.delete(id)
        continue
      }
      let sum = 0
      for (const [, d] of list) sum += d
      if (sum >= s.minDamage) n++
    }
    return n
  }

  /** Every 5 s of the hunt: her max HP toward the crowd's. */
  tick(ev: HuntEvent, m: Mob, now: number): void {
    const sc = ev.scale
    if (!sc || now < sc.nextAt || m.ai === 'dead') return
    sc.nextAt = now + PILOT_SCALE_EVERY_MS
    sc.hunters = this.hunters(ev, now)
    const target = pilotScaledMaxHp(sc.baseMaxHp, pilotScaleFactor(sc.hunters, ev.conf.settings.scaling))
    const next = pilotNextMaxHp(m.maxHp, target)
    if (next !== m.maxHp) {
      m.hp = pilotKeepFraction(m.hp, m.maxHp, next)
      m.maxHp = next
      this.s.g.world.broadcastAbout(m, { t: 'entityUpdate', id: m.id, hp: Math.round(m.hp), maxHp: m.maxHp })
    }
    sc.factor = m.maxHp / sc.baseMaxHp
    sc.peakHunters = Math.max(sc.peakHunters, sc.hunters)
    sc.peakMaxHp = Math.max(sc.peakMaxHp, m.maxHp)
  }

  /** Uniques.summonPolicy's question: her factor while a hunt scales her, else null. */
  factorOf(m: Mob): number | null {
    const ev = this.s.event
    return ev && ev.phase === 'hunt' && ev.turn?.mob === m.id && ev.scale ? ev.scale.factor : null
  }
}
