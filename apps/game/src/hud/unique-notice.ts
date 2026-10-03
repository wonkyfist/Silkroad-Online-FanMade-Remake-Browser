/**
 * Wave 11 (docs/UNIQUES.md §3.3, lane U-H): the unique-monster announcements. app.ts dispatches every `uniqueNotice`
 * (world sockets only) to `showUniqueNotice`: the banner on the one NoticeBanner queue in the unique style (the
 * unique's name in the unique pink, its own title, 8 s; a GM notice and a unique notice wait for each other), and the
 * retail cue when the banner appears (`ui.uniqueAppear` = alarm_sound.wav, `ui.uniqueDown` = eventcomplete.wav).
 * screens/world.ts adds `uniqueChatLine` to the chat (the notice channel) and, on an appearance, the town's alarm for
 * UNIQUE_ALARM_S (WAVE_PLAN7 D9, D19).
 *
 * Nothing shows outside the world (the lobby, the character screens): the server sends `uniqueNotice` to world sockets
 * only, and a notice that arrives, or whose turn in the queue comes, while another screen is up is dropped.
 * Only U-H edits this file (with ui/notice.ts and i18n/en-unique.ts).
 */
import type { ServerMessage } from '@sro/shared'
import type { GameAudio } from '../audio/index.ts'
import { t } from '../i18n/index.ts'
import type { NoticeBanner } from '../ui/notice.ts'

/** The `uniqueNotice` server message. */
export type UniqueNoticeMessage = Extract<ServerMessage, { t: 'uniqueNotice' }>

/** What the banner needs from the app (app.ts). */
export interface UniqueNoticeContext {
  notices: NoticeBanner
  /** The sound runtime, for the cue and the roar (null while the audio is not built). */
  audio: (Pick<GameAudio, 'ui'> & Partial<Pick<GameAudio, 'playFile'>>) | null
}

/** The town's cosmetic alarm on an appearance (TOWN_LIFE Q5, WAVE_PLAN7 D19): seconds. */
export const UNIQUE_ALARM_S = 60

/** The sound cues (W11-CV's cue table; the sound export encodes the two retail files at X1). */
export const UNIQUE_CUES = { appeared: 'ui.uniqueAppear', defeated: 'ui.uniqueDown' } as const satisfies Record<UniqueNoticeMessage['event'], string>

/**
 * Her own roar (H11-NL-5, docs/UNIQUES.md §3.3): the sound file a player near the spot hears once at the appearance
 * (`uniqueNotice.roar`, set by the server from `announce.roarRadiusM`), by the unique's mob code.
 */
export const UNIQUE_ROARS: Readonly<Record<string, string>> = { MOB_CH_TIGERWOMAN: 'monster/cm_bluetiger_find' }
/** How long the roar may wait for its buffer (ms): it is a one-shot at the spawn, so a slow fetch still plays it. */
const ROAR_WAIT_MS = 3000

/** Notices the dispatch received (tests: the mock's notice reaches it); the newest last, at most 8. */
export const uniqueNoticeLog: UniqueNoticeMessage[] = []

/** True while the world screen is up (app.ts sets `body.dataset.screen`). */
export function inWorld(): boolean {
  return typeof document !== 'undefined' && document.body?.dataset?.screen === 'world'
}

/** The sentence for one notice (the banner's text; the chat line wraps it). */
export function uniqueNoticeText(msg: UniqueNoticeMessage): string {
  const name = msg.name.trim() || msg.mob
  if (msg.event === 'appeared') {
    const area = msg.area?.trim()
    return area ? t('unique.appeared', { name, area }) : t('unique.appearedNoArea', { name })
  }
  const by = msg.by?.trim()
  if (!by) return t('unique.defeatedNoBy', { name })
  return t(msg.party ? 'unique.defeatedParty' : 'unique.defeated', { name, by })
}

/** Shows the banner (queued behind any notice on screen) and plays the cue when it appears. */
export function showUniqueNotice(msg: UniqueNoticeMessage, ctx: UniqueNoticeContext, live: () => boolean = inWorld): void {
  uniqueNoticeLog.push(msg)
  if (uniqueNoticeLog.length > 8) uniqueNoticeLog.shift()
  if (!live()) return
  // The roar plays at once (it is her voice at the spawn, not part of the queued banner).
  const roar = msg.event === 'appeared' && msg.roar ? UNIQUE_ROARS[msg.mob] : undefined
  if (roar) ctx.audio?.playFile?.(roar, { self: true, waitMs: ROAR_WAIT_MS })
  const cue = UNIQUE_CUES[msg.event]
  ctx.notices.show(uniqueNoticeText(msg), {
    kind: 'unique',
    title: t('unique.title'),
    name: msg.name.trim() || msg.mob,
    live,
    onShow: () => ctx.audio?.ui(cue),
  })
}

/** The chat line for one notice (the notice channel's colour). */
export function uniqueChatLine(msg: UniqueNoticeMessage): string | null {
  return t('unique.chat', { text: uniqueNoticeText(msg) })
}

/** What the world screen's side needs: the chat and the town part (null on Classic). */
export interface WorldUniqueNoticeContext {
  chat: { add(channel: 'notice', text: string): void }
  town: { alarm?(nowS: number, sec: number): void } | null | undefined
  /**
   * H11-DET-1: the world (world-render's `World.townAlarm`), which forwards to the town part and keeps the window for
   * a part made later (a Low -> Medium switch during the alarm). Absent: the town part only.
   */
  world?: { townAlarm?(fromS: number, sec: number): void } | null
  /** Server seconds now (the shared clock). */
  nowS: number
}

/** H11-DET-1: the alarm's start, server s: the notice's server stamp (`at`, ms), else its receipt. */
export function uniqueAlarmFromS(msg: UniqueNoticeMessage, receiptS: number): number {
  return typeof msg.at === 'number' && Number.isFinite(msg.at) && msg.at > 0 ? msg.at / 1000 : receiptS
}

/**
 * The world screen's side of a notice (screens/world.ts; the banner and the cue are app.ts'): the chat line, and on an
 * appearance the town's alarm for UNIQUE_ALARM_S (WAVE_PLAN7 D9, D19). I-11 moved it here from the world screen so the
 * cross-item test runs the same code.
 */
export function worldUniqueNotice(msg: UniqueNoticeMessage, ctx: WorldUniqueNoticeContext): void {
  const line = uniqueChatLine(msg)
  if (line) ctx.chat.add('notice', line)
  if (msg.event !== 'appeared') return
  const fromS = uniqueAlarmFromS(msg, ctx.nowS)
  if (ctx.world?.townAlarm) ctx.world.townAlarm(fromS, UNIQUE_ALARM_S)
  else ctx.town?.alarm?.(fromS, UNIQUE_ALARM_S)
}
