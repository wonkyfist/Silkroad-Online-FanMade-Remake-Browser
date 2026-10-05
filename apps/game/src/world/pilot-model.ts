/**
 * Play the Boss (docs/PLAY_THE_BOSS.md §4): the pure parts of the client, no DOM and no Babylon, so node tests run
 * them: the focus selection, the timers, the kit bar's slot states from `pilotState`, the taunt wheel's sector pick,
 * the steering line, the hunters' banner lines, the ping / footprint fades and the distant roar's gain and pan.
 */
import type { HuntEventView, PilotKitView, PilotServerMessage, PilotSteering } from '@sro/shared'
import { t, type StringKey } from '../i18n/index.ts'

export type PilotStartMessage = Extract<PilotServerMessage, { t: 'pilotStart' }>
export type PilotStateMessage = Extract<PilotServerMessage, { t: 'pilotState' }>
export type PilotEndMessage = Extract<PilotServerMessage, { t: 'pilotEnd' }>
export type PilotOfferMessage = Extract<PilotServerMessage, { t: 'pilotOffer' }>

// ---- focus (§4.1) ------------------------------------------------------------------------------------------------

/** The id input and the "where am I" reads follow: the steered entity while piloting, else the own character. */
export function focusId(selfId: number | null, controlled: number | null | undefined): number | null {
  return controlled ?? selfId
}

/** True while the player steers an entity other than the own character (WorldFeatureContext.controlledId). */
export function isPiloting(ctx: { selfId(): number | null; controlledId?(): number | null }): boolean {
  const c = ctx.controlledId?.()
  return c !== undefined && c !== null && c !== ctx.selfId()
}

// ---- timers ------------------------------------------------------------------------------------------------------

/** "11:42" (minutes may pass 59: "75:00"); negative counts as 0. Rounds up, so 0:01 shows until the last second ends. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "0:42" for a deadline `at` (server ms) seen at `now`, or null when there is none (an attach session: `0`). */
export function countdown(at: number | undefined, now: number): string | null {
  return at && at > 0 ? formatClock(at - now) : null
}

/** Whole seconds left until `at` (≥ 0). */
export function secondsLeft(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000))
}

// ---- kit bar (§4.3) ----------------------------------------------------------------------------------------------

/** One slot of the kit bar as drawn. */
export interface KitSlotState {
  id: string
  slot: number
  /** Server ms the ability is ready again (0 = ready). */
  readyAt: number
  /** The full cooldown, for the sweep. */
  cooldownMs: number
  /** Uses left (absent = unlimited). */
  charges?: number
  /** Cannot be used now: on cooldown, no charges, her AI steers, she is busy/held or dead. */
  disabled: boolean
  /** Why it is greyed (the first that applies). */
  why: 'ready' | 'cooldown' | 'charges' | 'ai' | 'busy'
}

/**
 * The kit bar's slots from the kit (pilotStart) and the latest pilotState at server time `now`. `busy`: she is in an
 * action or held (stun, knockdown), as the client sees it (her skill action, her held statuses).
 */
export function kitSlots(kit: readonly PilotKitView[], state: Pick<PilotStateMessage, 'steering' | 'charges' | 'ready'> | null, now: number, busy = false): KitSlotState[] {
  return [...kit]
    .sort((a, b) => a.slot - b.slot)
    .map(k => {
      const readyAt = state?.ready[k.id] ?? 0
      const charges = state?.charges[k.id] ?? k.charges
      const cooling = readyAt > now
      const empty = charges !== undefined && charges <= 0
      const ai = state?.steering === 'ai'
      const why: KitSlotState['why'] = empty ? 'charges' : cooling ? 'cooldown' : ai ? 'ai' : busy ? 'busy' : 'ready'
      const out: KitSlotState = { id: k.id, slot: k.slot, readyAt: cooling ? readyAt : 0, cooldownMs: k.cooldownMs, disabled: why !== 'ready', why }
      if (charges !== undefined) out.charges = Math.max(0, charges)
      return out
    })
}

/** The kit ability on hotbar key `key` ('1'..'9'), if any. */
export function abilityOnKey(kit: readonly PilotKitView[], key: string): PilotKitView | undefined {
  const n = Number(key)
  return Number.isInteger(n) ? kit.find(k => k.slot === n) : undefined
}

/**
 * The `pilotAct` for ability `k`: an 'entity' ability on the target; a 'point' ability (Pounce) on the target when
 * one is selected, else on the ground under the cursor; a 'none' ability alone (the server picks for Sweep). null when
 * an 'entity' ability has no target, or a 'point' one has neither.
 */
export function actFor(k: PilotKitView, target: number | null, ground: { x: number; z: number } | null): { t: 'pilotAct'; ability: string; target?: number; x?: number; z?: number } | null {
  if (k.target === 'none') return target !== null ? { t: 'pilotAct', ability: k.id, target } : { t: 'pilotAct', ability: k.id }
  if (target !== null) return { t: 'pilotAct', ability: k.id, target }
  if (k.target === 'point' && ground) return { t: 'pilotAct', ability: k.id, x: Math.round(ground.x * 100) / 100, z: Math.round(ground.z * 100) / 100 }
  return null
}

// ---- taunt wheel (§4.3) ------------------------------------------------------------------------------------------

/** The wheel's dead zone (px from the centre): releasing inside it sends nothing. */
export const TAUNT_DEAD_PX = 26

/**
 * The taunt line under the pointer at (dx, dy) px from the wheel's centre (screen y down): `n` equal sectors, sector 0
 * centred straight up, numbered clockwise. null inside the dead zone.
 */
export function tauntSector(dx: number, dy: number, n: number, dead = TAUNT_DEAD_PX): number | null {
  if (!(n > 0) || Math.hypot(dx, dy) < dead) return null
  // Clockwise angle from straight up, 0..2π.
  const a = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2)
  const step = (Math.PI * 2) / n
  return Math.floor((a + step / 2) / step) % n
}

/** The centre of sector `i` of `n` as a unit offset (screen y down), for laying out the wheel's labels. */
export function tauntSectorDir(i: number, n: number): { x: number; y: number } {
  const a = (i / n) * Math.PI * 2
  return { x: Math.sin(a), y: -Math.cos(a) }
}

// ---- steering line (§4.3) ----------------------------------------------------------------------------------------

export type SteeringLine = { kind: 'idle'; seconds: number } | { kind: 'ai' } | null

/** What the steering line says: the AI steers; or the idle warning with the seconds left; else nothing. */
export function steeringLine(steering: PilotSteering, idleWarnAt: number | undefined, now: number): SteeringLine {
  if (steering === 'ai') return { kind: 'ai' }
  if (idleWarnAt && idleWarnAt > 0 && idleWarnAt - now < 15_000) return { kind: 'idle', seconds: secondsLeft(idleWarnAt, now) }
  return null
}

// ---- hunters (§4.4) ----------------------------------------------------------------------------------------------

/** How long a sighting ring shows on the minimap (s), fading out. */
export const PING_FADE_S = 60
/** How long a footprint shows on the ground (s), fading out. */
export const TRAIL_FADE_S = 90

/** Opacity 1 → 0 over `spanMs` from `at` (server ms); 0 outside. */
export function fadeAt(at: number, now: number, spanMs: number): number {
  const age = now - at
  if (!(spanMs > 0) || age < 0) return age < 0 ? 1 : 0
  return age >= spanMs ? 0 : 1 - age / spanMs
}

/**
 * When the next sighting is due: `lastPingAt` + `pingSec`; before the first ping, `huntStartedAt` + `pingSec`.
 * null when neither is known.
 */
export function nextPingAt(lastPingAt: number | null, huntStartedAt: number | null, pingSec: number, now: number): number | null {
  const from = lastPingAt ?? huntStartedAt
  if (from === null) return null
  let at = from + pingSec * 1000
  // A missed ping (the pilot stalks, a hiccup): the next one is a whole period later.
  while (at < now - 1000) at += pingSec * 1000
  return at
}

/** True when the banner shows for this event (the pilot never sees the hunters' banner). */
export function huntBannerShows(ev: HuntEventView | null, piloting: boolean): boolean {
  return !!ev && !piloting && (ev.phase === 'offer' || ev.phase === 'hunt')
}

/** The hunters' banner line while the turn is offered: "Drawing a volunteer…" after a call, else "The tiger spirit stirs…". */
export function offerLine(ev: Pick<HuntEventView, 'volunteers'>): string {
  return ev.volunteers !== undefined ? t('hunt.drawing') : t('hunt.stirs')
}

// ---- the call (§4.5, layer 4) ------------------------------------------------------------------------------------

/** What the call banner shows: the draw countdown line and the buttons' state ('open': Volunteer / Not this time). */
export interface CallBannerView {
  meta: string
  mode: 'open' | 'volunteered' | 'ineligible'
  /** The reason line when ineligible (pilot.call.why.*). */
  why: string | null
}

/** The call banner for `ev` at server time `now`; null outside the call. */
export function callBanner(ev: HuntEventView | null, now: number): CallBannerView | null {
  if (!ev || ev.phase !== 'call' || !ev.callEndsAt) return null
  const time = formatClock(ev.callEndsAt - now)
  const count = ev.volunteers ?? 0
  const meta = ev.minLevel !== undefined ? t('pilot.call.meta', { time, count, level: ev.minLevel }) : t('pilot.call.metaShort', { time, count })
  const you = ev.you
  if (you?.volunteered) return { meta, mode: 'volunteered', why: null }
  if (you && !you.eligible) {
    const why = you.why ? t(`pilot.call.why.${you.why}` as StringKey, { level: ev.minLevel ?? '' }) : t('action.fail.not_eligible')
    return { meta, mode: 'ineligible', why }
  }
  return { meta, mode: 'open', why: null }
}

/** The chat lines of a call: at the open, then 5 min and 1 min before the draw. */
export const CALL_CHAT_MARKS_MIN: readonly number[] = [5, 1]

/**
 * The call's chat lines due at `now` (`done` remembers what this event said already; it is updated): 'open' once, then
 * 'soon' as the draw comes within 5 min and 1 min. The open line covers the marks already passed (a late joiner gets
 * one line), and marks crossed together say it once.
 */
export function callChatLines(callEndsAt: number, now: number, done: Set<string>): ('open' | 'soon')[] {
  const left = callEndsAt - now
  if (!(left > 0)) return []
  const out: ('open' | 'soon')[] = []
  if (!done.has('open')) {
    done.add('open')
    for (const m of CALL_CHAT_MARKS_MIN) if (left <= m * 60_000 + 1000) done.add(`m${m}`)
    out.push('open')
  }
  let soon = false
  for (const m of CALL_CHAT_MARKS_MIN) {
    if (done.has(`m${m}`) || left > m * 60_000) continue
    done.add(`m${m}`)
    soon = true
  }
  if (soon) out.push('soon')
  return out
}

/** Gain (0.25..1) of her distant roar `distM` away (the server sends 120–400 m). */
export function roarGain(distM: number): number {
  return Math.max(0.25, Math.min(1, 1.15 - Math.max(0, distM) / 450))
}

/**
 * Stereo pan (-1 left .. 1 right) of a sound from `bearing` (radians in the glTF XZ plane, 0 = +X, π/2 = −Z, as
 * WeatherSync.windDir and `lightning`) for a camera looking along (fx, fz). Same rule as the thunder's panToward.
 */
export function roarPan(bearing: number, fx: number, fz: number): number {
  const len = Math.hypot(fx, fz)
  if (!(len > 1e-6)) return 0
  const dx = Math.cos(bearing)
  const dz = -Math.sin(bearing)
  return 0.8 * (dx * (fz / len) - dz * (fx / len))
}

export type Compass = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'
const COMPASS: readonly Compass[] = ['e', 'ne', 'n', 'nw', 'w', 'sw', 's', 'se']

/** The compass word of a bearing (0 = +X east, π/2 = −Z north). */
export function compassOf(bearing: number): Compass {
  const step = Math.PI / 4
  const i = Math.round((((bearing % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / step) % 8
  return COMPASS[i]!
}

/** The result banner's sentence for an ended event (outcome, then the pilot's name when the server reveals it). */
export function huntEndText(ev: Pick<HuntEventView, 'outcome' | 'pilot' | 'downs'>, name: string): string | null {
  let s: string
  switch (ev.outcome) {
    case 'killed':
      s = t('hunt.end.killed', { name })
      break
    case 'survived':
      s = t('hunt.end.survived', { name })
      break
    case 'downs':
      s = t('hunt.end.downs', { name, downs: ev.downs ?? 0 })
      break
    case 'cancelled':
      s = t('hunt.end.cancelled', { name })
      break
    case 'no_volunteers':
      s = t('hunt.end.noVolunteers', { name })
      break
    case 'restart':
      s = t('hunt.end.restart', { name })
      break
    default:
      return null
  }
  const pilot = ev.pilot?.trim()
  return pilot ? `${s} ${t('hunt.end.pilot', { pilot, name })}` : s
}

/** The point `distM` (capped at `capM`) from (x, z) toward `bearing`: where a roar is heard from. */
export function bearingPoint(x: number, z: number, bearing: number, distM: number, capM = 60): { x: number; z: number } {
  const d = Math.min(capM, Math.max(0, distM))
  return { x: x + Math.cos(bearing) * d, z: z - Math.sin(bearing) * d }
}

/** The result window's lines from `pilotEnd` (§4.3). */
export interface PilotResult {
  won: boolean
  reason: PilotEndMessage['reason']
  gold: number
  downs: number | null
  steeredMs: number | null
  honor: string | null
  forfeit: boolean
}

export function pilotResult(m: Pick<PilotEndMessage, 'reason' | 'gold' | 'honor' | 'downs' | 'steeredMs'>): PilotResult {
  return {
    won: m.reason === 'survived' || m.reason === 'downs',
    reason: m.reason,
    gold: m.gold ?? 0,
    downs: m.downs ?? null,
    steeredMs: m.steeredMs ?? null,
    honor: m.honor ?? null,
    forfeit: m.reason === 'quit',
  }
}

/** The players the pilot's minimap shows: hunters within `senseM` of her (x, z). */
export function sensed<T extends { kind: string; dead?: boolean; pos: { x: number; z: number } }>(views: Iterable<T>, x: number, z: number, senseM: number, skip: ReadonlySet<number> | ((v: T) => boolean) = () => false): T[] {
  const out: T[] = []
  const skipped = typeof skip === 'function' ? skip : (v: T) => skip.has((v as unknown as { id: number }).id)
  for (const v of views) {
    if (v.kind !== 'player' || v.dead || skipped(v)) continue
    if (Math.hypot(v.pos.x - x, v.pos.z - z) <= senseM) out.push(v)
  }
  return out
}
