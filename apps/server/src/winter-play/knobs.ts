import { WINTER_PLAY } from '@sro/shared'
import type { ServerConfig } from '../config.ts'

/**
 * The winter gameplay numbers in force (docs/WINTER.md §13): WINTER_PLAY's defaults with the ServerConfig knobs (the
 * environment, then the admin panel's "Winter gameplay" group) on top. Read fresh each time, so the panel applies live.
 */
export type WinterKnobConfig = Pick<
  ServerConfig,
  | 'winterPlay'
  | 'warmthLossPerMin'
  | 'warmthBlizzardMul'
  | 'warmthFireMul'
  | 'coldDrainPct'
  | 'snowballCover'
  | 'snowballSlowPct'
  | 'snowSpiritScale'
  | 'yetiRespawnMin'
  | 'yetiHpMul'
  | 'giftDropPct'
  | 'giftYetiCount'
  | 'giftRarePct'
>

export interface WinterKnobs {
  enabled: boolean
  lossPerMin: number
  blizzardMul: number
  fireMul: number
  drainPct: number
  snowballCover: number
  snowballSlowPct: number
  spiritScale: number
  yetiRespawnMin: number
  yetiHpMul: number
  giftDropPct: number
  giftYetiCount: number
  giftRarePct: number
}

const W = WINTER_PLAY

export function winterKnobs(c: Partial<WinterKnobConfig>): WinterKnobs {
  return {
    enabled: c.winterPlay ?? W.enabled,
    lossPerMin: c.warmthLossPerMin ?? W.warmth.lossPerMin,
    blizzardMul: c.warmthBlizzardMul ?? W.warmth.blizzardMul,
    fireMul: c.warmthFireMul ?? 1,
    drainPct: c.coldDrainPct ?? W.warmth.drainPct,
    snowballCover: c.snowballCover ?? W.snowball.cover,
    snowballSlowPct: c.snowballSlowPct ?? W.snowball.slowPct,
    spiritScale: c.snowSpiritScale ?? W.spirits.countScale,
    yetiRespawnMin: c.yetiRespawnMin ?? W.yeti.respawnMin,
    yetiHpMul: c.yetiHpMul ?? W.yeti.hpMul,
    giftDropPct: c.giftDropPct ?? W.gifts.dropPct,
    giftYetiCount: c.giftYetiCount ?? W.gifts.yetiCount,
    giftRarePct: c.giftRarePct ?? W.gifts.rarePct,
  }
}
