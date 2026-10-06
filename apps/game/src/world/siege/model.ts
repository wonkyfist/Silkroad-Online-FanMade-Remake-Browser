/**
 * Siege of Jangan, layer 4 on the client (docs/SIEGE.md §9.3): the pure parts of the siege HUD, the banners, the
 * kegs and the reward window (what text, which colour, which keg is in reach). DOM-free, so tests are exact; the
 * drawing is hud/siege-hud.ts, the wiring world/features/siege.ts.
 */
import { WALL_SIDE_NAMES, waveOf, type ServerMessage, type SiegeApproach, type SiegeContribKind, type SiegeRewardView, type SiegeView, type WallSide, type WallStage } from '@sro/shared'
import { t, type StringKey } from '../../i18n/index.ts'

/** "4:07" (m:ss), "1:02:03" past an hour; 0 below zero. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** "the west road and the south fields". */
export function approachText(list: readonly SiegeApproach[]): string {
  const names = list.map((a) => t(`siege.approach.${a}` as StringKey))
  if (names.length <= 1) return names[0] ?? ''
  return t('siege.and', { a: names.slice(0, -1).join(', '), b: names[names.length - 1]! })
}

/** "the West wall (W3)". */
export function wallText(id: string): string {
  return t('siege.wall', { side: WALL_SIDE_NAMES[id[0] as WallSide] ?? '?', id })
}

/** The HUD's head line and timer line at server ms `now`. */
export function siegeLines(v: SiegeView, now: number): { head: string; timer: string | null } {
  const n = waveOf(v.phase)
  const head = v.phase === 'ended' ? (v.outcome ? t(`siege.outcome.${v.outcome}` as StringKey) : t('siege.phase.ended')) : t(`siege.phase.${v.phase}` as StringKey, { n })
  let timer: string | null = null
  if (v.phase === 'warning' && v.nextAt) timer = t('siege.arrives', { time: fmtClock(v.nextAt - now) })
  else if ((v.phase === 'wave1' || v.phase === 'wave2') && v.nextAt) timer = t('siege.nextWave', { time: fmtClock(v.nextAt - now) })
  else if (v.phase === 'wave3' && v.endsAt) timer = t('siege.timeLeft', { time: fmtClock(v.endsAt - now) })
  return { head, timer }
}

/** The meta line: defenders, foes, breaches. */
export function siegeMeta(v: SiegeView): string {
  const parts: string[] = []
  if (v.defenders !== undefined) parts.push(t('siege.defenders', { n: v.defenders }))
  if (v.foes !== undefined && v.phase !== 'ended') parts.push(t('siege.foes', { n: v.foes }))
  if (v.breaches) parts.push(t('siege.breaches', { n: v.breaches }))
  return parts.join(' · ')
}

/** The order of the 33 wall pips: around the town clockwise from the north-west corner (N1..N10, E1..E7, S9..S1, W7..W1). */
export function pipOrder(ids: Iterable<string>): string[] {
  const all = [...ids]
  const num = (id: string) => Number(id.slice(1))
  const by = (side: string, desc: boolean) => all.filter((id) => id[0] === side).sort((a, b) => (desc ? num(b) - num(a) : num(a) - num(b)))
  return [...by('N', false), ...by('E', false), ...by('S', true), ...by('W', true)]
}

export type PipLook = 'intact' | 'cracked' | 'deep' | 'breached' | 'rubble'

/** A pip's colour class: intact, cracked (≤ 70 %), deep (≤ 35 %), breached, rubble. */
export function pipLook(stage: WallStage, pct: number): PipLook {
  if (stage === 'rubble') return 'rubble'
  if (stage === 'breached') return 'breached'
  if (stage === 'cracked') return pct <= 35 ? 'deep' : 'cracked'
  return 'intact'
}

/** A banner's text for a siegeNotice (null: none for this one). */
export function noticeText(m: Extract<ServerMessage, { t: 'siegeNotice' }>): string | null {
  if (m.event === 'phase') {
    if (m.phase === 'warning') return t('siege.notice.warning', { list: approachText(m.approaches ?? []) })
    if (m.phase === 'wave1' || m.phase === 'wave2' || m.phase === 'wave3') return t(`siege.notice.${m.phase}` as StringKey)
    if (m.phase === 'ended' && m.outcome) return t(`siege.outcome.${m.outcome}` as StringKey)
    return null
  }
  const wall = m.wall ? wallText(m.wall) : '?'
  if (m.event === 'defused') return t('siege.notice.defused', { name: m.name ?? '?', wall })
  return t(`siege.notice.${m.event}` as StringKey, { wall })
}

export interface KegState {
  id: number
  seg: string
  x: number
  y: number
  z: number
  fuseEndsAt: number
  defuse: { by: number; endsAt: number } | null
}

/** The keg nearest to (x, z) within `range` m, or null. */
export function kegInReach(kegs: Iterable<KegState>, x: number, z: number, range: number): KegState | null {
  let best: KegState | null = null
  let bd = range
  for (const k of kegs) {
    const d = Math.hypot(k.x - x, k.z - z)
    if (d <= bd) {
      bd = d
      best = k
    }
  }
  return best
}

/** The reward window's lines (head, the points line, what was paid, where the points came from). */
export function rewardLines(r: SiegeRewardView, honor: (code: string) => string): { head: string; lines: string[]; parts: string } {
  const head = r.outcome === 'won' ? t('siege.reward.won') : r.outcome === 'lost_bell' || r.outcome === 'lost_time' ? t('siege.reward.lost') : t('siege.reward.over')
  const lines = [r.rank > 0 ? t('siege.reward.points', { points: r.points, rank: r.rank, of: r.of }) : t('siege.reward.pointsNoRank', { points: r.points })]
  if (r.gold > 0) lines.push(t('siege.reward.gold', { gold: r.gold.toLocaleString('en-US') }))
  if (r.seals > 0) lines.push(t('siege.reward.seals', { seals: r.seals }))
  if (r.title) lines.push(t('siege.reward.title', { title: honor(r.title) }))
  const order: SiegeContribKind[] = ['damage', 'sapper', 'defuse', 'kit', 'donation', 'bell']
  const parts = order.filter((k) => (r.parts[k] ?? 0) > 0).map((k) => t(`siege.reward.part.${k}` as StringKey, { n: r.parts[k]! }))
  return { head, lines, parts: parts.join(' · ') }
}
