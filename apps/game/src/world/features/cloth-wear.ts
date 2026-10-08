/**
 * Dirt and blood on the clothes (docs/CHARACTERS.md §16.9, the pack's Clothes Dirt / Blood masks): wear builds up with
 * combat and travel and fades with rest, a repair or time. Client side only, from what the client already hears:
 * - blood: hits taken (heavy ones much more) and kills made; dirt: fighting, running in the field (faster in rain / mud);
 * - fading: slowly over time, fast while in town (resting), all at once on an accepted repair (your own character).
 * Drawn in WEAR_LEVELS steps per character (licensed-outfit.ts ClothWear; the cloth materials stay shared per level),
 * on the bodies near you only, never on Low / Classic, never on the face (the cloth only).
 */
import type { ServerMessage, WeatherKind } from '@sro/shared'
import { WEAR_LEVELS, type ClothWear } from '../../three/licensed-outfit.ts'
import type { EntityView } from '../entities.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { PERF } from '../perf.ts'

/** The rates (per event, per second); levels at WEAR_STEPS of the 0..1 amounts. */
export const WEAR = {
  /** Blood per hit taken: a base, plus the share of max HP the hit took × this. */
  bloodHit: 0.015,
  bloodHeavy: 1.6,
  /** A hit counts as heavy at this share of max HP (its blood doubles). */
  heavyShare: 0.12,
  bloodKill: 0.06,
  dirtHit: 0.02,
  dirtDealt: 0.008,
  /** Dirt per second running in the field, × rainMul in rain / storm. */
  dirtRun: 1 / 900,
  rainMul: 3,
  /** Fading per second: in the field, in town (resting). */
  fadeField: 1 / 1800,
  fadeTown: 1 / 75,
} as const
export const WEAR_STEPS = [0.12, 0.4, 0.75] as const
/** A level drops only this far under its step (a fighter resting in town hovered on a step and flipped it every second). */
export const WEAR_HYSTERESIS = 0.08

/** One character's wear (pure; tests). */
export class WearModel {
  dirt = 0
  blood = 0
  /** The levels last handed out (levels(): the hysteresis). */
  private shown: ClothWear = { dirt: 0, blood: 0 }

  hitTaken(share: number): void {
    const s = Math.max(0, Math.min(1, share))
    this.blood += (WEAR.bloodHit + s * WEAR.bloodHeavy) * (s >= WEAR.heavyShare ? 2 : 1)
    this.dirt += WEAR.dirtHit + s * 0.3
    this.clamp()
  }

  hitDealt(): void {
    this.dirt += WEAR.dirtDealt
    this.clamp()
  }

  kill(): void {
    this.blood += WEAR.bloodKill
    this.dirt += 0.02
    this.clamp()
  }

  /** `dt` seconds: running in the field (rain: muddier), resting in town fades it fast, the field slowly. */
  tick(dt: number, o: { moving: boolean; inTown: boolean; rain: boolean }): void {
    if (o.moving && !o.inTown) this.dirt += dt * WEAR.dirtRun * (o.rain ? WEAR.rainMul : 1)
    const fade = dt * (o.inTown ? WEAR.fadeTown : WEAR.fadeField)
    this.dirt -= fade
    this.blood -= fade * 1.5
    this.clamp()
  }

  repair(): void {
    this.dirt = 0
    this.blood = 0
    this.shown = { dirt: 0, blood: 0 }
  }

  /** The drawn levels; with `hysteresis` a level drops only WEAR_HYSTERESIS under its step. */
  levels(hysteresis: boolean = PERF.wearLazy): ClothWear {
    const prev = hysteresis ? this.shown : null
    this.shown = { dirt: levelOf(this.dirt, prev?.dirt), blood: levelOf(this.blood, prev?.blood) }
    return this.shown
  }

  private clamp(): void {
    this.dirt = Math.max(0, Math.min(1, this.dirt))
    this.blood = Math.max(0, Math.min(1, this.blood))
  }
}

/** The level of an amount; with the level shown before (`prev`), a step it holds stays until WEAR_HYSTERESIS under it. */
export function levelOf(v: number, prev?: number): number {
  let l = 0
  for (let i = 0; i < WEAR_STEPS.length; i++) if (v >= WEAR_STEPS[i]! || (prev !== undefined && i < prev && v >= WEAR_STEPS[i]! - WEAR_HYSTERESIS)) l++
  return Math.min(WEAR_LEVELS, l)
}

/** Bodies farther than this keep their last drawn level (a change re-dresses the body: only near ones pay). */
export const WEAR_RANGE_M = 40

export function clothWearFeature(ctx: WorldFeatureContext): WorldFeature {
  const models = new Map<number, WearModel>()
  let inTown = false
  let rain = false
  let acc = 0
  const model = (id: number) => {
    let m = models.get(id)
    if (!m) models.set(id, (m = new WearModel()))
    return m
  }
  const isChar = (v: EntityView | undefined): v is EntityView => !!v && (v.kind === 'player' || v.id === ctx.selfId())
  // the level last handed to each body: a body is dressed again only when its level changes (the look check's
  // `__sroLicensed.wear` holds until then)
  const applied = new Map<number, string>()
  const apply = (v: EntityView, m: WearModel, lite: boolean) => {
    const w = lite ? { dirt: 0, blood: 0 } : m.levels()
    const k = `${w.dirt}${w.blood}${v.actor ? v.actor.root.uniqueId : 0}`
    if (applied.get(v.id) === k) return
    applied.set(v.id, k)
    v.actor?.setLicensedWear(w)
  }
  return {
    onCombatHit(msg, index): void {
      const hit = msg.hits[index]
      if (!hit) return
      const target = ctx.view(msg.target)
      const attacker = ctx.view(msg.attacker)
      if (isChar(target) && (hit.outcome === 'hit' || hit.outcome === 'crit')) {
        const max = (target.state.maxHp ?? 0) || 1
        model(target.id).hitTaken(hit.damage / max)
      }
      if (isChar(attacker)) {
        model(attacker.id).hitDealt()
        if (index === msg.hits.length - 1 && msg.killed) model(attacker.id).kill()
      }
    },
    onMessage(msg: ServerMessage): void {
      if (msg.t === 'actionResult' && msg.re === 'repair' && msg.ok) {
        const id = ctx.selfId()
        if (id !== null) model(id).repair()
      } else if (msg.t === 'weather') {
        const k: WeatherKind = msg.weather.to
        rain = k === 'rain' || k === 'storm'
      }
    },
    onTownChange(town): void {
      inTown = town
    },
    onEntityRemoved(v): void {
      models.delete(v.id)
      applied.delete(v.id)
    },
    onFrame(_now, dt): void {
      acc += dt
      if (acc < 1) return
      const step = acc
      acc = 0
      const self = ctx.view(ctx.selfId() ?? -1)
      const here = self?.root.position
      for (const v of ctx.views()) {
        if (!isChar(v)) continue
        const m = model(v.id)
        m.tick(step, { moving: v.moving, inTown, rain })
        const p = v.root.position
        if (here && v !== self && Math.hypot(p.x - here.x, p.z - here.z) > WEAR_RANGE_M) continue
        apply(v, m, !!v.actor?.clothFx?.clock.lite)
      }
    },
  }
}
