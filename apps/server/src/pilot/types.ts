import type { HuntOutcome, PilotAbilityDef, PilotDef, PilotSettings, PilotSettingsPatch, PilotSteering, PilotTargetKind, SkillDef } from '@sro/shared'

/**
 * Play the Boss (docs/PLAY_THE_BOSS.md): the module's internal state. One unique carries at most one turn (a player
 * steering her) and one event (call, offer / draw, hunt) at a time.
 */

/** No act closer than this to the last one (§3.2). */
export const ACT_GAP_MS = 500
/** A target this much past an ability's reach: she walks into reach first (§3.2); farther = too_far. */
export const WALK_IN_M = 8
/** Auto-claw chases a hunter this far (§3.2). */
export const CLAW_CHASE_M = 20
/** An act pressed while she is busy waits this long at most for her to be free (§3.2). */
export const QUEUE_MS = 4500
/** A walk into reach gives up after this long. */
export const PENDING_MS = 3000
/** The idle warning comes this long before her AI takes over (§3.4, "warning at 15 s"). */
export const IDLE_WARN_MS = 5000
/** Her chase re-plans at most this often (the AI's CHASE_REPLAN_MS). */
export const REPLAN_MS = 300
/** "Fight": damage to or from her in the last 10 s (HUD only, §2.1). */
export const FIGHT_MS = 10_000
/** HUNTING YOU: hunters who hit her (or her summons) within this window. */
export const HUNTING_MS = 60_000
/** Her exit after a win (§2.3): she roars and leaves this long after. */
export const EXIT_MS = 8000
/** Footprints (§3.6): one every TRAIL_EVERY_MS while she moves, kept TRAIL_KEEP_MS, sent to hunters within TRAIL_NEAR_M. */
export const TRAIL_EVERY_MS = 3000
export const TRAIL_KEEP_MS = 90_000
export const TRAIL_SEND_MS = 2000
export const TRAIL_NEAR_M = 40
/** Ping offset (§3.6): the circle's centre is at most this far from her (the circle always contains her). */
export const PING_OFFSET_M = 40
/** Roars (§3.6): every ROAR_EVERY_MS (and on each Fear Roar) to hunters ROAR_RANGE_M[0]..[1] away. */
export const ROAR_EVERY_MS = 30_000
export const ROAR_RANGE_M: readonly [number, number] = [120, 400]
/** Fear Roar's push speed (m/s, §3.5). */
export const ROAR_PUSH_SPEED = 10
/** pilotState goes out at most this often unless something the HUD shows changed at once. */
export const STATE_EVERY_MS = 1000
/** huntEvent re-broadcasts (hunters count) at most this often. */
export const EVENT_EVERY_MS = 2000
/** The row of an event is saved (downs, steered time) this often. */
export const SAVE_EVERY_MS = 60_000
/** Cast ids of server-built abilities: `PILOT_<unique short name>_<ID>`. */
export const PILOT_SKILL_PREFIX = 'PILOT_'

/** One kit slot, resolved against the skill book. */
export interface KitEntry {
  def: PilotAbilityDef
  id: string
  slot: number
  /** The retail row (Claw, Sweep, Curse) or the row whose roll a leap's landing uses. */
  row: SkillDef | null
  target: PilotTargetKind
  rangeM: number
  cooldownMs: number
  charges?: number
  clip: string
  /** The cast's skill id for server-built abilities (PILOT_TIGERWOMAN_POUNCE). */
  castId: string
}

/** A unique that a player may steer (its `pilot` block, resolved). */
export interface PilotConf {
  code: string
  name: string
  def: PilotDef
  /** In effect: `defaults` with the admin panel's `patch` (pilot_settings, at `rev`; 0 = none stored) over them. */
  settings: PilotSettings
  /** The content's numbers (content/uniques.json `pilot.defaults` over PILOT_DEFAULTS). */
  defaults: PilotSettings
  patch: PilotSettingsPatch
  rev: number
  kit: KitEntry[]
}

/** A walk into reach, then the act. */
export interface PendingAct {
  entry: KitEntry
  target: number | null
  x?: number
  z?: number
  until: number
  planAt: number
}

/** One player steering one boss. `event` null = a GM `attach` session (no event rules). */
export interface Turn {
  conf: PilotConf
  event: HuntEvent | null
  /** Her entity id. */
  mob: number
  /** The pilot's entity id (null once the pilot left; her AI finishes). */
  player: number | null
  characterId: number
  accountId: number
  name: string
  steering: PilotSteering
  lastInputAt: number
  /** Player-steered time so far (ms) and the start of the current stretch. */
  steeredMs: number
  steerSince: number | null
  lastActAt: number
  /** Auto-claw: the hunter she keeps clawing. */
  claw: { target: number; planAt: number } | null
  pending: PendingAct | null
  /** An act pressed while she was busy: it runs (checked again) as soon as she is free, until `until`. */
  queued: { msg: { t: 'pilotAct'; ability: string; target?: number; x?: number; z?: number; repeat?: boolean }; until: number } | null
  /** The kit's own cooldowns (server ms ready) and charges left (new abilities; retail rows: MobSkills). */
  ready: Map<string, number>
  charges: Map<string, number>
  /** A server-built ability's busy window (the leap, the roar). */
  busyUntil: number
  leap: { entry: KitEntry; landAt: number; instance: number } | null
  stalk: { entry: KitEntry; until: number } | null
  tauntAt: number
  /** The hunt circle (steering and abilities clamp into it). */
  area: { x: number; z: number; r: number }
  /** What `attach` changed on her (restored on detach). */
  restore: { home: [number, number]; leashRange: number } | null
  left: boolean
  /** The last pilotState sent (JSON) and when. */
  sentState: string
  stateAt: number
}

/** Per hunter, since his last respawn: damage to her or her summons, and his last hit. */
export interface HunterRecord {
  damage: number
  lastHitAt: number
}

/** The pilot's associates, frozen at accept (§3.9), plus the live IP check. */
export interface Associates {
  chars: Set<number>
  accounts: Set<number>
  ip: string | null
}

/** 'offer' covers the draw too (the database row says 'draw'): an offer is out, or the next draw is due at `drawAt`. */
export type EventPhase = 'call' | 'offer' | 'hunt' | 'ended'

/** Layer 5 (§3.7): the hunters' recent damage to her and the max HP it gives. */
export interface HuntScale {
  /** Her max HP before any scaling (47,898 for Tiger Girl). */
  baseMaxHp: number
  /** Character id -> [server ms, damage] of each hit on her (non-associates), pruned to `windowSec`. */
  hits: Map<number, [number, number][]>
  nextAt: number
  /** N of the last step, and the factor her max HP stands at (maxHp / baseMaxHp). */
  hunters: number
  factor: number
  peakHunters: number
  peakMaxHp: number
}

/** A Play the Boss event (a call with its draw, or a GM / admin pick; then the hunt). */
export interface HuntEvent {
  id: number
  conf: PilotConf
  origin: 'gm' | 'admin' | 'schedule'
  phase: EventPhase
  createdAt: number
  /** Layer 4: the call's end (the draw; server ms), 0 for a pick without a call. */
  callEndsAt: number
  /** The event had a call: a declined or expired offer draws the next volunteer (else it ends: no_volunteers). */
  fromCall: boolean
  /** Lottery draws made (≤ maxDraws), the volunteers count, and when the next draw is due (0 = none pending). */
  draws: number
  volunteers: number
  drawAt: number
  /** The call's per-recipient part of huntEvent: player id -> the last `you` sent (JSON). */
  youSent: Map<number, string>
  /** The offered player; `drawn` = by the lottery (a volunteer row), else a GM / admin force-pick. */
  offer: { playerId: number; characterId: number; accountId: number; name: string; expiresAt: number; drawn?: boolean } | null
  turn: Turn | null
  camp: number | null
  area: string
  huntStartedAt: number
  huntEndsAt: number
  downs: number
  /** Character ids of the distinct non-associates who hit her. */
  hunters: Set<number>
  recent: Map<number, HunterRecord>
  associates: Associates
  /** Associates' share of her damage at the kill (percent), for the suspect flag. */
  associatePct: number
  fightAt: number
  flags: string[]
  outcome: HuntOutcome | null
  // signals
  nextPingAt: number
  nextRoarAt: number
  trail: { x: number; z: number; at: number }[]
  trailAt: number
  trailSentAt: number
  /** Hunter id -> the newest trail point (ms) it was sent. */
  trailSeen: Map<number, number>
  eventAt: number
  eventSent: string
  savedAt: number
  /** Layer 5: HP scaling (null until the hunt starts). */
  scale: HuntScale | null
}

/** Restarts (§2.4): a call resumes if it has this much left at boot, else it ends RESUME_MS after boot. */
export const RESUME_MIN_MS = 120_000
export const RESUME_MS = 180_000
/** A slot whose call should have opened during the downtime opens at boot when it is at most this late. */
export const MISSED_GRACE_MS = 30 * 60_000
/** The hold on her spawn timer outlasts the last possible offer by this much. */
export const HOLD_SLACK_MS = 60_000
