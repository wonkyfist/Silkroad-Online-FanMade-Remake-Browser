import { WINTER_PLAY, warmthLevel, warmthLossPerS, type ItemDef, type WarmthLevel, type WarmthSource, type WarmthState } from '@sro/shared'
import type { Gameplay } from '../gameplay.ts'
import type { GmResult } from '../gm.ts'
import type { GameplayModule } from '../modules.ts'
import type { Player } from '../world.ts'
import type { WinterPlay } from './service.ts'

/**
 * Body warmth (docs/WINTER.md §13.1). A GameplayModule named `warmth`, only while the winter layer is on (the season
 * or a GM preview):
 *
 * - Once a second every living player outdoors loses warmth (WINTER_PLAY.warmth: 6 a minute by day, faster at night and
 *   in snowfall, 2.5 x in a blizzard); a warm drink's glow halves the loss. Inside a town's safe area it rises 3 a
 *   second; within a fire's reach (fires.ts: campfires, braziers, gate fires, lamps) it rises by the fire's gain.
 * - Levels: chilly below 50 (3/4 regen), cold below 25 (half the regen, 8 % slower running), freezing at 0 (no regen,
 *   12 % slower, and 1 % of max HP every 5 s, never below 10 % of max HP: the cold never kills by itself; potions work).
 *   No penalty ever applies inside a safe area.
 * - The own client gets `warmth` (value, rate, level, source) on a level or source change, every 5 points, and every
 *   10 s while it moves; it draws the bar and the warnings from that. Off: everyone is warm, nothing is sent.
 */

const TICK_MS = 1000

interface Body {
  value: number
  glowUntil: number
  safe: boolean
  source: WarmthSource | null
  rate: number
  nextDrainAt: number
  sent: { value: number; level: WarmthLevel; source: WarmthSource | null; rate: number; safe: boolean; at: number } | null
}

export class WarmthService implements GameplayModule {
  readonly name = 'warmth'
  private readonly bodies = new Map<number, Body>()
  private lastTick = -Infinity

  constructor(
    private readonly g: Gameplay,
    private readonly play: WinterPlay,
  ) {}

  private body(p: Player): Body {
    let b = this.bodies.get(p.id)
    if (!b) this.bodies.set(p.id, (b = { value: WINTER_PLAY.warmth.max, glowUntil: 0, safe: false, source: null, rate: 0, nextDrainAt: 0, sent: null }))
    return b
  }

  /** The warmth of `p` now (max while the layer is off). */
  value(p: Player): number {
    return this.bodies.get(p.id)?.value ?? WINTER_PLAY.warmth.max
  }

  level(p: Player): WarmthLevel {
    const b = this.bodies.get(p.id)
    if (!b || !this.play.isOn || b.safe) return 'warm'
    return warmthLevel(b.value)
  }

  /** Regen multiplier for Gameplay's player regen (1 when warm, off, or in a safe area). */
  regenMul(p: Player): number {
    return WINTER_PLAY.warmth.regenMul[this.level(p)]
  }

  /** Run speed lost to the cold (percent; the service's mod provider adds it to the snowball slows). */
  slowPct(p: Player): number {
    return WINTER_PLAY.warmth.slowPct[this.level(p)]
  }

  // ---- hooks -----------------------------------------------------------------------------------------------

  enter(p: Player, now: number): void {
    const b = this.body(p)
    if (this.play.isOn) this.send(p, b, now, true)
  }

  forget(p: Player): void {
    this.bodies.delete(p.id)
  }

  tick(now: number): void {
    if (now - this.lastTick < TICK_MS && now >= this.lastTick) return
    const dt = Number.isFinite(this.lastTick) ? Math.min(5, Math.max(0, (now - this.lastTick) / 1000)) : TICK_MS / 1000
    this.lastTick = now
    if (!this.play.isOn) return
    const k = this.play.knobs()
    const env = this.play.coldEnv(now)
    const loss = warmthLossPerS(env, { lossPerMin: k.lossPerMin, nightMul: WINTER_PLAY.warmth.nightMul, snowMul: WINTER_PLAY.warmth.snowMul, blizzardMul: k.blizzardMul })
    for (const p of this.g.world.players.values()) {
      if (p.dead || p.trance) continue
      const b = this.body(p)
      const at = this.g.world.positionAt(p, now)
      b.safe = this.g.data.inSafeArea(this.g.config.world, at[0], at[2])
      const fire = this.play.fires.warmest(at[0], at[1], at[2])
      const fireGain = fire ? fire.gainPerS * k.fireMul : 0
      const townGain = b.safe ? WINTER_PLAY.warmth.townGainPerS : 0
      const glow = now < b.glowUntil
      if (fireGain > 0 || townGain > 0) {
        b.rate = Math.max(fireGain, townGain)
        b.source = fireGain >= townGain ? 'fire' : 'town'
      } else {
        b.rate = -loss * (glow ? WINTER_PLAY.tea.glowLossMul : 1)
        b.source = glow ? 'tea' : null
      }
      b.value = Math.min(WINTER_PLAY.warmth.max, Math.max(0, b.value + b.rate * dt))
      const after = this.level(p)
      // the cold slow follows the level (a no-op unless it changed)
      this.play.speedChanged(p, now)
      const drained = after === 'freezing' ? this.drain(p, b, now, k.drainPct) : 0
      if (after !== 'freezing') b.nextDrainAt = now + WINTER_PLAY.warmth.drainEveryMs
      this.send(p, b, now, false, drained)
    }
  }

  /** The cold's bite at 0 warmth: `pct` of max HP every drainEveryMs, never below drainFloorPct of max HP. */
  private drain(p: Player, b: Body, now: number, pct: number): number {
    if (pct <= 0 || now < b.nextDrainAt) return 0
    b.nextDrainAt = now + WINTER_PLAY.warmth.drainEveryMs
    const floor = Math.ceil((p.maxHp * WINTER_PLAY.warmth.drainFloorPct) / 100)
    const take = Math.min(Math.max(1, Math.round((p.maxHp * pct) / 100)), Math.max(0, Math.floor(p.hp) - floor))
    if (take <= 0) return 0
    this.g.setVitals(p, p.hp - take, p.mp)
    return take
  }

  private send(p: Player, b: Body, now: number, force: boolean, drained = 0): void {
    const level = b.safe ? 'warm' : warmthLevel(b.value)
    // at a bound the value does not move: say so (rate 0), so the client does not run past it
    const rate = (b.value >= WINTER_PLAY.warmth.max && b.rate > 0) || (b.value <= 0 && b.rate < 0) ? 0 : b.rate
    const s = b.sent
    const due =
      force ||
      drained > 0 ||
      !s ||
      s.level !== level ||
      s.source !== b.source ||
      s.safe !== b.safe ||
      Math.abs(s.value - b.value) >= WINTER_PLAY.warmth.sendStep ||
      Math.abs(s.rate - rate) > Math.max(0.02, Math.abs(s.rate) * 0.15) ||
      (rate !== 0 && now - s.at >= WINTER_PLAY.warmth.sendEveryMs)
    if (!due) return
    b.sent = { value: b.value, level, source: b.source, rate, safe: b.safe, at: now }
    p.send({ t: 'warmth', warmth: this.state(b, level, rate, now, drained) })
  }

  private state(b: Body, level: WarmthLevel, rate: number, now: number, drained = 0): WarmthState {
    const w: WarmthState = { value: Math.round(b.value * 10) / 10, max: WINTER_PLAY.warmth.max, rate: Math.round(rate * 1000) / 1000, level, at: Math.round(now) }
    if (b.source) w.source = b.source
    if (b.safe) w.safe = true
    if (drained > 0) w.drained = drained
    return w
  }

  /** The layer went off: everyone is warm again, every penalty ends. */
  reset(now: number): void {
    for (const p of this.g.world.players.values()) {
      this.bodies.delete(p.id)
      this.play.speedChanged(p, now)
    }
  }

  /** The layer came on: everyone hears their warmth. */
  started(now: number): void {
    for (const p of this.g.world.players.values()) this.send(p, this.body(p), now, true)
  }

  // ---- changes from outside ----------------------------------------------------------------------------------

  /** Adds (or with a negative amount takes) warmth now (a drink, the yeti's frost). Returns the new value. */
  add(p: Player, amount: number, now: number): number {
    const b = this.body(p)
    const before = this.level(p)
    b.value = Math.min(WINTER_PLAY.warmth.max, Math.max(0, b.value + amount))
    if (this.level(p) !== before) this.play.speedChanged(p, now)
    if (this.play.isOn) this.send(p, b, now, true)
    return b.value
  }

  /** A warm drink (ItemUse.warmth): warmth now and a glow that slows the loss. */
  drink(p: Player, def: ItemDef, now: number): void {
    const b = this.body(p)
    b.glowUntil = Math.max(b.glowUntil, now + (def.use?.warmthGlowMs ?? 0))
    this.add(p, def.use?.warmth ?? 0, now)
  }

  /** GM `warmth`: show, or set a player's warmth. */
  gm(self: Player | null, args: string[], now: number): GmResult {
    const usage: GmResult = { ok: false, message: `Usage: ${WARMTH_USAGE}` }
    let target = self
    if (args.length === 2) target = this.g.world.byName(args[1]!)
    if (args.length > 2 || !target) return args.length === 2 && !target ? { ok: false, message: `No player named ${args[1]} in the world.` } : usage
    if (args.length === 0) {
      const b = this.body(target)
      return { ok: true, message: `Warmth of ${target.name}: ${b.value.toFixed(1)} / ${WINTER_PLAY.warmth.max} (${this.level(target)}${b.source ? `, ${b.source}` : ''}${this.play.isOn ? '' : '; the winter layer is off now'}).`, data: { value: b.value, level: this.level(target) } }
    }
    const v = Number(args[0])
    if (!Number.isFinite(v) || v < 0 || v > WINTER_PLAY.warmth.max) return usage
    this.add(target, v - this.body(target).value, now)
    return { ok: true, message: `Warmth of ${target.name} set to ${v}${this.play.isOn ? '' : ' (the winter layer is off now: no effect until the season or `winter preview on`)'}.`, data: { value: v } }
  }
}

export const WARMTH_USAGE = 'warmth [0-100 [player]]'
