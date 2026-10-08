import {
  siegeScale,
  scaledCount,
  warlordHp,
  type AdminEventInfo,
  type AdminSiegeView,
  type SiegeContribView,
  type SiegeEventSettings,
  type SiegeEventPatch,
  type SiegeEventSummary,
  type SiegeLogLine,
} from '@sro/shared'
import { AdminApiError, get, post, put } from '../api.ts'
import { attempt, badge, button, card, clear, confirmDialog, emptyState, errorText, fmtAgo, fmtDuration, fmtNum, fmtTime, formDialog, h, kv, stackTable, tabs, toast } from '../ui.ts'
import { EVENT_PAGES } from './events.ts'
import { lawTab } from './siege-law.ts'

/**
 * Siege of Jangan (docs/SIEGE.md §11.4), the Events page's sub-page for the `siege` route group. On top, the walls (a
 * top-down plan of the 33 segments coloured by stage and %, queued repair; click one to set its % or repair it; Repair
 * all) and what runs now (phase, countdown, approaches, defenders, the Town Bell's and the Warlord's HP) with Start and
 * Stop. Under them the tabs: the weekly schedule (off by default; the server's time zone), the numbers of §11.2 (each
 * with its default, its bounds, a reset and the server's 422 messages inline; saves carry the rev), and the event log
 * with each siege's timeline and contributors, and the Law tab (layer 6, siege-law.ts: warrants, the Stockade, records,
 * Hunters).
 */

const OUTCOME_KIND: Record<string, 'ok' | 'bad' | 'dim' | 'info' | 'gold'> = { won: 'gold', lost_bell: 'bad', lost_time: 'bad', cancelled: 'dim', restart: 'dim', skipped: 'dim' }
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const PHASE_TEXT: Record<string, string> = { warning: 'Warning: the army musters', wave1: 'Wave 1 of 3', wave2: 'Wave 2 of 3', wave3: 'Wave 3: the Bandit Warlord', ended: 'Ended' }

interface FieldDef {
  path: string
  label: string
  step?: number
  hint?: string
  /** A choice among strings (SIEGE_EVENT_CHOICES), shown as a select. */
  choices?: { value: string; label: string }[]
}

const GROUPS: { title: string; about: string; fields: FieldDef[] }[] = [
  {
    title: 'Timing',
    about: 'The warning before wave 1, the gap between waves, the deadline, the early-wave rule and the players a scheduled siege needs.',
    fields: [
      { path: 'timing.warningMin', label: 'Warning (min)' },
      { path: 'timing.waveGapMin', label: 'Between waves (min)' },
      { path: 'timing.durationMin', label: 'From wave 1 to the end (min)' },
      { path: 'timing.earlyPct', label: 'Next wave early at % dead' },
      { path: 'timing.minPlayers', label: 'Players online needed (level 10+)' },
      { path: 'timing.approaches', label: 'Approaches per siege (of 4)' },
      { path: 'timing.tigerWaitMin', label: 'Wait for a Night of the Tiger (min)' },
    ],
  },
  {
    title: 'Waves (per approach, at 5 defenders or fewer)',
    about: 'Raiders, archers, sappers and elite raiders grow with the defenders; rams and the Warlord do not.',
    fields: [
      { path: 'waves.w1Raiders', label: 'Wave 1 raiders' },
      { path: 'waves.w1Sappers', label: 'Wave 1 sappers' },
      { path: 'waves.w2Raiders', label: 'Wave 2 raiders' },
      { path: 'waves.w2Archers', label: 'Wave 2 archers' },
      { path: 'waves.w2Sappers', label: 'Wave 2 sappers' },
      { path: 'waves.w2Rams', label: 'Wave 2 Stone Rams' },
      { path: 'waves.w3Elite', label: 'Wave 3 elite raiders' },
      { path: 'waves.w3Rams', label: 'Wave 3 Stone Rams' },
    ],
  },
  {
    title: 'The army',
    about: 'How hard each monster hits the wall (integrity: 20,000 = 100 % of a segment), the Warlord, the scaling with defenders, and the sappers.',
    fields: [
      { path: 'army.marchSpeed', label: 'March speed (m/s)', step: 0.1 },
      { path: 'army.raiderIp', label: "Raider's swing (ip)" },
      { path: 'army.ramIp', label: "Ram's blow (ip)" },
      { path: 'army.ramEverySec', label: 'A ram blow every (s)' },
      { path: 'army.sapperIp', label: "Sapper's keg (ip)" },
      { path: 'army.warlordIp', label: "Warlord's swing (ip)" },
      { path: 'army.warlordHp', label: "Warlord's HP (5 defenders)" },
      { path: 'army.scaleDiv', label: 'Defenders per step' },
      { path: 'army.scaleCap', label: 'Steps at most' },
      { path: 'army.scaleExp', label: 'Exponent', step: 0.05 },
      { path: 'army.expMul', label: 'EXP of siege monsters ×', step: 0.05 },
      { path: 'army.engageM', label: 'Monsters fight defenders within (m)' },
      { path: 'army.leashM', label: 'They chase up to (m)' },
      { path: 'army.plantSec', label: 'Planting a keg (s)' },
      { path: 'army.fuseSec', label: 'Fuse (s)' },
      { path: 'army.defuseSec', label: 'Defusing (s)' },
      { path: 'army.maxMobs', label: 'Siege monsters at most' },
    ],
  },
  {
    title: 'The Town Bell',
    about: 'The siege is lost when the Bell falls. A defender’s hit on it repairs it.',
    fields: [
      { path: 'bell.hp', label: 'Bell HP' },
      { path: 'bell.repairPct', label: 'A repair hit heals (%)', step: 0.1 },
      { path: 'bell.zoneM', label: 'Unsafe ground around it during a wave (m)' },
    ],
  },
  {
    title: 'Rewards',
    about: 'Contribution points: 1 per 100 damage to siege monsters, 20 per sapper stopped, 30 per keg defused, 10 per 1 % repaired with a kit, 5 per 2,000 gold donated (≤ 50), 15 per Bell repair.',
    fields: [
      { path: 'rewards.goldPerPoint', label: 'Gold per point' },
      { path: 'rewards.goldCap', label: 'Gold at most' },
      { path: 'rewards.pointsPerSeal', label: 'Points per Siege Seal' },
      { path: 'rewards.sealCap', label: 'Seals at most' },
      { path: 'rewards.lossShare', label: 'Share of the gold on a loss', step: 0.05 },
      { path: 'rewards.titleTop', label: 'Title to the top N' },
      { path: 'rewards.titlePoints', label: 'Title from points' },
      { path: 'rewards.minPoints', label: 'Nothing under (points)' },
    ],
  },
  {
    title: 'Thunder Kegs (players)',
    about: 'The players’ keg (Old Fang, west of town): its price, who may plant it, where, and what it does. A breach by a player keg makes the planter Wanted.',
    fields: [
      { path: 'keg.gold', label: 'Price (gold)' },
      { path: 'keg.saltpeter', label: 'Saltpeter per keg' },
      { path: 'keg.carry', label: 'Kegs carried at most' },
      { path: 'keg.damagePct', label: 'A blast takes (% of a segment)' },
      { path: 'keg.plantSec', label: 'Planting (s)' },
      { path: 'keg.fuseSec', label: 'Fuse (s)' },
      { path: 'keg.defuseSec', label: 'Defusing (s)' },
      { path: 'keg.cooldownMin', label: 'One plant per account every (min)' },
      { path: 'keg.minLevel', label: 'Planter level at least' },
      { path: 'keg.minPlayHours', label: 'Planter played (h) at least' },
      { path: 'keg.faceM', label: 'Plant within (m) of the outer face', hint: 'the ditch rims keep walkers 6-9 m out' },
      { path: 'keg.noticeMin', label: 'One plant notice per segment every (min)' },
    ],
  },
  {
    title: 'The law',
    about: 'Warrants for wall-breakers: the bounty (paid by the server), how long a warrant runs (online time), accomplices, forgiveness and treason.',
    fields: [
      { path: 'law.bountyBase', label: 'Bounty per offence (gold)' },
      { path: 'law.bountyCapMul', label: 'Bounty grows up to offence' },
      { path: 'law.wantedOnlineHours', label: 'Warrant lapses after (online h)', step: 0.25 },
      { path: 'law.accompliceWindowMin', label: 'Accomplices: kegs within (min)' },
      { path: 'law.forgiveDays', label: 'One offence forgiven per (clean days)' },
      { path: 'law.treasonMul', label: 'Treason (during a siege) ×', step: 0.5 },
    ],
  },
  {
    title: 'Capture and the Stockade',
    about: 'Who shares the bounty, the 7-day pair rule, the jail clock (real time counts offline; online counts only time in the world), chores and the pardon after release. Sentences are 2 / 4 / 8 / 16 / 24 h by offence.',
    fields: [
      { path: 'law.sentenceClock', label: 'The jail clock', choices: [{ value: 'real', label: 'Real time (offline counts)' }, { value: 'online', label: 'Online time only' }] },
      { path: 'law.captureWindowSec', label: 'Bounty: damage in the last (s)' },
      { path: 'law.captureMinPct', label: 'Bounty: at least (% of max HP)' },
      { path: 'law.pairCooldownDays', label: 'Same Bounty Hunter and Wanted: no gold for (days)' },
      { path: 'law.combatLogoutSec', label: 'Logout after a Bounty Hunter hit = capture within (s)' },
      { path: 'law.subdueSec', label: 'Subdued before the Stockade (s)' },
      { path: 'law.choreSec', label: 'A chore takes (s)' },
      { path: 'law.choreMin', label: 'A chore takes off (min)' },
      { path: 'law.choresCapPct', label: 'Chores take off at most (% of the sentence)' },
      { path: 'law.pardonMin', label: 'Pardon after release (min)' },
    ],
  },
  {
    title: 'Anti-collusion',
    about: 'Stops friends farming bounties and Bounty Hunter ranks. Recent contacts (trade, stall sale, party) and lookouts at the keg claim nothing; the same Bounty Hunter and Wanted accounts within the pair window get nothing, no capture; a Wanted caught again pays less; a bounty never beats the keg price; a Bounty Hunter account earns at most the daily cap. Withheld rewards are listed in the Law tab.',
    fields: [
      { path: 'law.contactDays', label: 'Contacts count for (days)' },
      { path: 'law.lookoutM', label: 'Lookouts: within (m) of a keg' },
      { path: 'law.bountyKegPct', label: 'A bounty at most (% of the keg price)' },
      { path: 'law.repeatPct', label: 'Each earlier capture this week takes off (%)' },
      { path: 'law.repeatMax', label: 'Nothing paid from (captures this week)' },
      { path: 'hunter.dailyBountyCap', label: 'Bounties per Bounty Hunter account per 24 h (gold)' },
    ],
  },
  {
    title: 'Bounty Hunters',
    about: 'Captain Yun by the west gate: the licence, duty, pings to Bounty Hunters on duty, PvP damage between Bounty Hunters and the Wanted, the Bounty Hunter’s Net.',
    fields: [
      { path: 'hunter.minLevel', label: 'Licence: level at least' },
      { path: 'hunter.licenceGold', label: 'Licence price (gold)' },
      { path: 'hunter.cleanDays', label: 'Licence: no offence for (days)' },
      { path: 'hunter.revokeDays', label: 'A Bounty Hunter who breaks a wall loses it for (days)' },
      { path: 'hunter.offDutyLockMin', label: 'On duty after a PvP hit for (min)' },
      { path: 'hunter.pingSec', label: 'A ping every (s)' },
      { path: 'hunter.pingR', label: 'Ping circle (m)' },
      { path: 'hunter.pingOffsetM', label: 'Ping centre off the Wanted by up to (m)' },
      { path: 'hunter.senseM', label: 'Wanted on the minimap within (m)' },
      { path: 'hunter.pvpMul', label: 'PvP damage ×', step: 0.05 },
      { path: 'hunter.netGold', label: 'Bounty Hunter’s Net price (gold)', hint: 'the shop price at the next restart' },
      { path: 'hunter.netRangeM', label: 'Net reach (m)' },
      { path: 'hunter.netSec', label: 'Net snare (s)', step: 0.5 },
      { path: 'hunter.netCooldownSec', label: 'Net cooldown (s)' },
    ],
  },
]

function valueAt(s: SiegeEventSettings, path: string): unknown {
  const [g, k] = path.split('.') as [string, string | undefined]
  const grp = (s as unknown as Record<string, unknown>)[g]
  return k === undefined ? grp : (grp as Record<string, unknown>)[k]
}

function inPatch(p: SiegeEventPatch, path: string): boolean {
  const [g, k] = path.split('.') as [string, string | undefined]
  const grp = (p as Record<string, unknown>)[g]
  return k === undefined ? grp !== undefined : typeof grp === 'object' && grp !== null && k in grp
}

function zoneTime(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
  } catch {
    return fmtTime(ms)
  }
}

const lookOf = (stage: string, pct: number) => (stage === 'cracked' && pct <= 35 ? 'deep' : stage)

// ---- the walls ------------------------------------------------------------------------------------------------------

/** Positions through the CSSOM (the /admin/ CSP forbids style attributes). */
function place<T extends HTMLElement>(el: T, css: Partial<Record<'left' | 'top' | 'width' | 'height', number>>): T {
  for (const [k, v] of Object.entries(css)) el.style.setProperty(k, `${Math.round((v as number) * 10) / 10}px`)
  return el
}

/** A top-down plan: north up, each segment a bar coloured by stage, the gates grey, the Bell a gold dot. */
function wallsCard(v: AdminSiegeView, reload: () => void): HTMLElement {
  const g = v.geometry
  const repairAll = button('Repair all…', async () => {
    if (!(await confirmDialog({ title: 'Repair every segment', message: 'Every wall segment goes back to 100 % at once (audited).', confirm: 'Repair all' }))) return
    if (await attempt(() => post('siege/wall', { seg: 'all', repair: true }), 'Every segment repaired.')) reload()
  })
  const counts = new Map<string, number>()
  for (const w of v.walls) counts.set(lookOf(w.stage, w.pct), (counts.get(lookOf(w.stage, w.pct)) ?? 0) + 1)
  const legend = h('div', { class: 'small dim siege-legend' }, ['intact', 'cracked', 'deep', 'breached', 'rubble'].map((k) => h('span', null, h('i', { class: `siege-swatch siege-seg ${k}` }), `${k === 'deep' ? 'deep cracks' : k} ${counts.get(k) ?? 0}`)))
  if (!g) return card('Walls', emptyState('The walls are off on this server (no walls.json in the world export).', 'alert'), h('div', { class: 'row-actions' }, repairAll))
  // the frame: x from the west line to the east line, z from the north line to the south line (glTF z grows south)
  const line = (s: string) => g.sides.find((x) => x.side === s)?.line ?? 0
  const x0 = line('W') - 18
  const x1 = line('E') + 18
  const z0 = line('N') - 18
  const z1 = line('S') + 18
  const W = 560
  const k = W / (x1 - x0)
  const H = (z1 - z0) * k
  const px = (x: number) => (x - x0) * k
  const pz = (z: number) => (z - z0) * k
  const T = 9
  const box = place(h('div', { class: 'siege-map' }), { width: W, height: H })
  const bar = (side: string, from: number, to: number, cls: string, title: string, onclick?: () => void) => {
    const axisX = g.sides.find((x) => x.side === side)?.axis === 'x'
    const l = line(side)
    const len = Math.max(2, Math.abs(to - from) * k - 2)
    const el = h(onclick ? 'button' : 'div', { class: `siege-seg ${cls}`, title, 'aria-label': title })
    place(el, axisX ? { left: px(Math.min(from, to)), width: len, top: pz(l) - T / 2, height: T } : { top: pz(Math.min(from, to)), height: len, left: px(l) - T / 2, width: T })
    if (onclick) el.addEventListener('click', onclick)
    box.append(el)
  }
  for (const f of g.fixed) bar(f.side, f.from, f.to, 'fixed', `${f.id}: indestructible`)
  for (const s of g.segs) {
    const w = v.walls.find((x) => x.id === s.id)
    const stage = w?.stage ?? 'intact'
    const pct = w?.pct ?? 100
    bar(s.id[0]!, s.from, s.to, lookOf(stage, pct), `${s.id}: ${stage} ${pct}%${w?.queued ? `, ${w.queued}% queued for the builders` : ''}`, () => void editSeg(s.id, stage, pct, reload))
  }
  for (const s of g.segs) {
    const side = g.sides.find((x) => x.side === s.id[0])
    if (!side) continue
    const mid = (s.from + s.to) / 2
    const inset = 16
    const at = side.axis === 'x' ? { left: px(mid), top: pz(side.line) + (s.id[0] === 'N' ? inset : -inset) } : { left: px(side.line) + (s.id[0] === 'W' ? inset : -inset), top: pz(mid) }
    box.append(place(h('span', { class: 'mono siege-label' }, s.id), at))
  }
  box.append(place(h('i', { class: 'siege-bell', title: 'Town Bell' }), { left: px(g.bell[0]), top: pz(g.bell[1]) }))
  return card('Walls', h('p', { class: 'dim small' }, 'North is up. Click a segment to set its integrity or repair it.'), box, legend, h('div', { class: 'row-actions' }, repairAll))
}

async function editSeg(id: string, stage: string, pct: number, reload: () => void): Promise<void> {
  const vals = await formDialog({
    title: `Segment ${id}`,
    intro: `Now ${stage}, ${pct} %. Set its integrity (−50 % is rubble, 0 % or less breached, 70 % or less cracked), or tick Repair to set it whole. Audited.`,
    fields: [
      { name: 'pct', label: 'Integrity (%)', type: 'number', value: pct, min: -50, max: 100, step: 1, required: true },
      { name: 'repair', label: 'Repair to 100 %', type: 'checkbox', value: false },
    ],
    submit: 'Apply',
  })
  if (!vals) return
  const body = vals.repair ? { seg: id, repair: true } : { seg: id, pct: Number(vals.pct) }
  if (await attempt(() => post('siege/wall', body), `${id} updated.`)) reload()
}

// ---- now ---------------------------------------------------------------------------------------------------------------

function nowCard(v: AdminSiegeView, reload: () => void): HTMLElement {
  const now = Date.now()
  const c = v.current
  const start = button('Start a siege…', async () => {
    const vals = await formDialog({
      title: 'Start the Siege of Jangan',
      intro: 'Everyone in the world is warned; the army musters at its approaches and wave 1 marches when the warning ends.',
      fields: [{ name: 'minutes', label: 'Warning (minutes)', type: 'number', value: v.settings.effective.timing.warningMin, min: 0, max: 60, step: 1, required: true }],
      submit: 'Start',
    })
    if (!vals) return
    if (await attempt(() => post('siege/start', { warningMin: Number(vals.minutes) }), 'The siege begins.')) reload()
  }, 'primary')
  const stop = button('Stop', async () => {
    if (!(await confirmDialog({ title: 'Stop the siege', message: 'The siege is called off at once: no rewards, the army withdraws, the walls stay as they are.', confirm: 'Stop', danger: true }))) return
    if (await attempt(() => post('siege/stop', {}), 'Stopped.')) reload()
  }, 'danger')
  const rows: [string, Node | string][] = []
  const tz = v.schedule.tz
  if (c && c.phase !== 'ended') {
    const when = c.phase === 'warning' ? `wave 1 in ${fmtDuration(Math.max(0, (c.nextAt ?? now) - now))}` : c.nextAt ? `next wave in ${fmtDuration(Math.max(0, c.nextAt - now))}` : c.endsAt ? `${fmtDuration(Math.max(0, c.endsAt - now))} left` : ''
    rows.push(
      ['Siege', `#${c.id} (${c.origin === 'schedule' ? 'the weekly slot' : `started by ${c.origin === 'gm' ? 'a GM' : 'an admin'}`})`],
      ['Phase', `${PHASE_TEXT[c.phase] ?? c.phase}${when ? `: ${when}` : ''}`],
      ['Approaches', c.approaches.map((a) => v.lanes.find((l) => l.approach === a)?.name ?? a).join(', ') || '—'],
      ['Defenders', `${c.defenders ?? 0} (army × ${c.scale.toFixed(2)})`],
      ['Foes alive', String(c.foes ?? 0)],
      ['Town Bell', c.bellHp === null ? 'gone' : `${fmtNum(c.bellHp)} / ${fmtNum(c.bellMaxHp ?? 0)} (${c.bellPct ?? 0}%)`],
      ['Warlord', c.warlordHp === null ? (c.phase === 'wave3' ? 'fallen' : 'not yet') : `${fmtNum(c.warlordHp)} / ${fmtNum(c.warlordMaxHp ?? 0)}`],
      ['Breaches', String(c.breaches ?? 0)],
      ['Contributors', String(c.contributors)],
    )
  } else {
    rows.push(['Now', c ? `Siege #${c.id} ended: ${c.outcome ?? 'ended'}; the army withdraws.` : 'No siege is running.'])
  }
  rows.push(['Next scheduled', v.next ? `${zoneTime(v.next, tz)} (${tz}), ${fmtAgo(v.next, now)}${v.waitingUntil ? `; waiting for a Night of the Tiger until ${zoneTime(v.waitingUntil, tz)}` : ''}` : v.schedule.enabled ? 'no slots set' : 'the weekly siege is off'])
  if (v.problems.length) rows.push(['Problems', v.problems.join('; ')])
  rows.push(['Lanes', v.lanes.map((l) => `${l.approach}: ${l.segments.join(', ') || 'none'}${l.dropped.length ? ` (dropped ${l.dropped.length})` : ''}`).join(' · ') || 'none'])
  const running = !!c && c.phase !== 'ended'
  return card('Now', kv(rows), h('div', { class: 'row-actions' }, running ? [stop] : [start]))
}

// ---- schedule --------------------------------------------------------------------------------------------------------------

function scheduleTab(root: HTMLElement, v: AdminSiegeView, saved: (v: AdminSiegeView) => void): void {
  const s = v.settings.effective
  const tz = v.schedule.tz
  const enabled = h('input', { type: 'checkbox', checked: s.enabled, 'aria-label': 'Weekly siege on' })
  const onText = h('span', { class: 'switch-text' }, s.enabled ? 'On' : 'Off')
  enabled.addEventListener('change', () => (onText.textContent = enabled.checked ? 'On' : 'Off'))
  const list = h('div', { class: 'stack' })
  const slots: { weekday: HTMLSelectElement; time: HTMLInputElement; row: HTMLElement }[] = []
  const add = button('Add a slot', () => addRow(0, '20:00'), 'small')
  const addRow = (weekday: number, time: string) => {
    const wd = h('select', { class: 'input', 'aria-label': 'Weekday' }, WEEKDAYS.map((d, i) => h('option', { value: String(i), selected: i === weekday }, d)))
    const tm = h('input', { class: 'input num-input', type: 'time', value: time, 'aria-label': 'Time', required: true })
    const item = { weekday: wd, time: tm, row: h('div') }
    const remove = button('Remove', () => {
      slots.splice(slots.indexOf(item), 1)
      item.row.remove()
      add.disabled = slots.length >= 7
    }, 'small')
    item.row = h('div', { class: 'inline-form' }, wd, tm, remove)
    slots.push(item)
    list.append(item.row)
    add.disabled = slots.length >= 7
  }
  for (const sl of s.schedule.slots) addRow(sl.weekday, sl.time)
  const error = h('div', { class: 'form-error', role: 'alert' })
  const save = button('Save the schedule', async () => {
    error.textContent = ''
    const out = slots.map((x) => ({ weekday: Number(x.weekday.value), time: x.time.value }))
    if (out.some((x) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(x.time))) return void (error.textContent = 'Every slot needs a time (HH:MM).')
    try {
      await put('siege/settings', { baseRev: v.settings.rev, patch: { enabled: enabled.checked, schedule: { slots: out } } })
      toast('Schedule saved.')
      saved(await get<AdminSiegeView>('siege'))
    } catch (e) {
      error.textContent = errorText(e)
      if (e instanceof AdminApiError && e.status === 409) saved(await get<AdminSiegeView>('siege'))
    }
  }, 'primary')
  clear(
    root,
    card(
      'The weekly siege',
      h('p', { class: 'dim' }, `At each slot the warning starts (${s.timing.warningMin} min), then the waves. A slot is skipped when fewer than ${s.timing.minPlayers} players of level 10+ are online; it waits ${s.timing.tigerWaitMin} min (twice at most) while a Night of the Tiger runs. GM and admin starts always work, on or off.`),
      h('div', { class: 'setting-control' }, h('label', { class: 'switch' }, enabled, h('span', { class: 'switch-track' }), onText)),
      h('h4', null, 'Slots'),
      list,
      h('div', { class: 'actions' }, add),
      h('p', { class: 'dim small' }, `Times are in the server's time zone: ${tz}.`),
      h('p', null, v.next ? `Next siege: ${zoneTime(v.next, tz)} (${fmtAgo(v.next)}).` : s.enabled ? 'No slot set.' : 'The weekly siege is off.'),
      error,
      h('div', { class: 'actions end' }, save),
    ),
  )
}

// ---- numbers ---------------------------------------------------------------------------------------------------------------

function numbersTab(root: HTMLElement, v: AdminSiegeView, saved: (v: AdminSiegeView) => void): void {
  const { effective, defaults, patch = {}, rev, bounds } = v.settings
  const reads = new Map<string, () => number | string>()
  const errors = new Map<string, HTMLElement>()
  const reload = async () => saved(await get<AdminSiegeView>('siege'))
  const field = (f: FieldDef) => {
    const cur = valueAt(effective, f.path) as number
    const def = valueAt(defaults, f.path) as number
    const b = bounds[f.path]
    let inp: HTMLInputElement | HTMLSelectElement
    if (f.choices) {
      const sel = h('select', { class: 'input', 'aria-label': f.label }, f.choices.map((c) => h('option', { value: c.value }, c.label)))
      sel.value = String(cur)
      inp = sel
      reads.set(f.path, () => sel.value)
    } else {
      const num = h('input', { class: 'input num-input', type: 'number', value: String(cur), min: b?.[0], max: b?.[1], step: f.step ?? 1, 'aria-label': f.label })
      inp = num
      reads.set(f.path, () => (num.value.trim() === '' ? Number.NaN : Number(num.value)))
    }
    const err = h('div', { class: 'field-error', hidden: true })
    errors.set(f.path, err)
    const changed = inPatch(patch, f.path)
    const reset = changed
      ? button('Reset', async () => {
          if (await attempt(() => post('siege/settings/reset', { baseRev: rev, paths: [f.path] }), `${f.label}: back to ${typeof def === 'number' ? fmtNum(def) : String(def)}.`)) await reload()
        }, 'small')
      : null
    return h(
      'div',
      { class: 'setting' },
      h('div', { class: 'setting-head' }, h('label', { class: 'setting-label' }, f.label), changed ? badge('changed', 'gold') : null),
      h('div', { class: 'setting-control' }, inp, reset),
      h('div', { class: 'setting-meta dim small' }, `default ${typeof def === 'number' ? fmtNum(def) : (f.choices?.find((c) => c.value === String(def))?.label ?? String(def))}${b ? ` · ${fmtNum(b[0])}–${fmtNum(b[1])}` : ''}`),
      f.hint ? h('div', { class: 'setting-note dim small' }, f.hint) : null,
      err,
    )
  }
  const formError = h('div', { class: 'form-error pre', role: 'alert' })
  const saveAll = async () => {
    formError.textContent = ''
    for (const e of errors.values()) {
      e.hidden = true
      e.textContent = ''
    }
    const delta: Record<string, Record<string, number | string>> = {}
    for (const [path, read] of reads) {
      const val = read()
      if (typeof val === 'number' && Number.isNaN(val)) {
        const e = errors.get(path)!
        e.textContent = 'Enter a number.'
        e.hidden = false
        continue
      }
      if (val === valueAt(effective, path)) continue
      const [g, k] = path.split('.') as [string, string]
      ;(delta[g] ??= {})[k] = val
    }
    if ([...errors.values()].some((e) => !e.hidden)) return
    if (Object.keys(delta).length === 0) return toast('Nothing changed.', 'info')
    try {
      await put('siege/settings', { baseRev: rev, patch: delta })
      toast('Saved; the numbers apply now (a running siege keeps its timers and its army).')
      await reload()
    } catch (e) {
      if (e instanceof AdminApiError && e.issues.length) {
        for (const i of e.issues) {
          const el = errors.get(i.path)
          if (el) {
            el.textContent = i.message
            el.hidden = false
          } else formError.textContent += `${i.path}: ${i.message}\n`
        }
      } else formError.textContent = errorText(e)
      if (e instanceof AdminApiError && e.status === 409) {
        toast('Someone saved in the meantime; reloaded.', 'info')
        await reload()
      }
    }
  }
  const resetAll = button('Reset all to the defaults…', async () => {
    if (!(await confirmDialog({ title: 'Reset every number', message: 'Every number (and the schedule) goes back to the defaults in content/siege/jangan.json.', confirm: 'Reset all' }))) return
    if (await attempt(() => post('siege/settings/reset', { baseRev: rev }), 'Back to the defaults.')) await reload()
  })
  const a = effective.army
  const preview = [5, 10, 20, 30]
    .map((n) => {
      const s = siegeScale(n, a)
      return `${n} defenders: ×${s.toFixed(2)}, ${scaledCount(effective.waves.w1Raiders, s)} raiders / ${scaledCount(effective.waves.w1Sappers, s)} sappers in wave 1, Warlord ${fmtNum(warlordHp(s, a))} HP`
    })
    .join(' · ')
  clear(
    root,
    h('p', { class: 'dim' }, `Defaults come from content/siege/jangan.json; what you change here is stored on this server (rev ${rev}) and applies at once.`),
    GROUPS.map((g) => card(g.title, h('p', { class: 'dim small' }, g.about), g.title === 'The army' ? h('p', { class: 'small' }, preview) : null, h('div', { class: 'settings' }, g.fields.map(field)))),
    formError,
    h('div', { class: 'actions end' }, Object.keys(patch).length ? resetAll : null, button('Save the numbers', () => void saveAll(), 'primary')),
  )
}

// ---- the event log ---------------------------------------------------------------------------------------------------------

function logLine(l: SiegeLogLine): string {
  const d = l.data
  const s = (k: string) => (d[k] === undefined || d[k] === null ? '' : String(d[k]))
  switch (l.kind) {
    case 'start':
      return `started (${s('origin')}) from ${Array.isArray(d.approaches) ? (d.approaches as string[]).join(', ') : '?'}; the Warlord at ${s('lead')}`
    case 'wave':
      return `wave ${s('wave')}: ${s('spawned')} monsters, ${s('defenders')} defenders (× ${s('scale')})`
    case 'breach':
      return `${s('seg')} breached (${s('cause')})`
    case 'plant':
      return `a sapper planted a keg at ${s('seg')}`
    case 'defused':
      return `${s('by')} defused the keg at ${s('seg')}`
    case 'blast':
      return `a keg blew at ${s('seg')}`
    case 'reward':
      return d.granted === false ? `Seals for #${s('character')} not granted (${s('why')})` : `rewards: ${s('defenders')} defenders, ${fmtNum(Number(d.gold ?? 0))} gold, ${s('seals')} Seals, ${s('titles')} titles`
    case 'restart':
      return `resumed after a restart (${s('phase')})`
    case 'skipped':
      return `skipped: ${s('why')}`
    case 'end':
      return `ended: ${s('outcome')}${s('why') ? ` (${s('why')})` : ''}`
    default:
      return `${l.kind} ${JSON.stringify(d)}`
  }
}

function logTab(root: HTMLElement): void {
  const table = h('div')
  const detail = h('div', { class: 'event-slot' })
  root.append(table, detail)
  const open = async (id: number) => {
    try {
      const r = await get<{ event: SiegeEventSummary; log: SiegeLogLine[]; contributors: SiegeContribView[] }>(`siege/events/${id}`)
      clear(
        detail,
        h('h4', null, `Siege #${r.event.id}`),
        h('ul', { class: 'timeline' }, r.log.map((l) => h('li', null, h('span', { class: 'mono small dim' }, fmtTime(l.at)), ' ', logLine(l)))),
        r.contributors.length
          ? [h('h4', null, `Defenders (${r.contributors.length})`), h('ol', null, r.contributors.map((c) => h('li', null, `${c.name}: ${fmtNum(c.points)} points, ${fmtNum(c.gold)} gold, ${c.seals} Seals`)))]
          : null,
      )
    } catch (e) {
      clear(detail, h('p', { class: 'error' }, errorText(e)))
    }
  }
  const load = async () => {
    try {
      const r = await get<{ events: SiegeEventSummary[] }>('siege/events?limit=50')
      if (r.events.length === 0) return void clear(table, emptyState('No sieges yet.', 'events'))
      clear(
        table,
        h(
          'div',
          { class: 'table-scroll' },
          stackTable(
            h(
              'table',
              { class: 'table' },
              h('thead', null, h('tr', null, ['Started', 'Origin', 'Outcome', 'Length', 'Approaches', 'Defenders', 'Breaches', 'Top', ''].map((x) => h('th', null, x)))),
              h(
                'tbody',
                null,
                r.events.map((e) =>
                  h(
                    'tr',
                    null,
                    h('td', null, fmtTime(e.createdAt)),
                    h('td', null, e.origin),
                    h('td', null, e.phase === 'ended' ? badge(e.outcome ?? 'ended', OUTCOME_KIND[e.outcome ?? ''] ?? 'dim') : badge(e.phase, 'info')),
                    h('td', null, e.wave1At && e.endedAt ? fmtDuration(e.endedAt - e.wave1At) : '—'),
                    h('td', null, e.approaches.join(', ') || '—'),
                    h('td', { class: 'num' }, String(e.defenders)),
                    h('td', { class: 'num' }, String(e.breaches)),
                    h('td', null, e.top.map((t) => `${t.name} ${t.points}`).join(', ') || '—'),
                    h('td', { class: 'row-actions' }, button('Timeline', () => void open(e.id), 'small')),
                  ),
                ),
              ),
            ),
            2,
          ),
        ),
      )
    } catch (e) {
      clear(table, emptyState(errorText(e), 'alert', true))
    }
  }
  void load()
}

// ---- the page --------------------------------------------------------------------------------------------------------------

export function siegePage(root: HTMLElement, _event: AdminEventInfo): () => void {
  const walls = h('div')
  const now = h('div')
  const body = h('div')
  root.append(walls, now, body)
  let stopped = false
  let latest: AdminSiegeView | null = null
  let tab = 'schedule'
  const saved = (v: AdminSiegeView) => {
    latest = v
    renderTabs()
  }
  const renderTabs = () => {
    const v = latest
    if (!v) return
    clear(
      body,
      tabs(
        [
          { id: 'schedule', label: 'Schedule', render: (r) => ((tab = 'schedule'), scheduleTab(r, v, saved)) },
          { id: 'numbers', label: 'Numbers', render: (r) => ((tab = 'numbers'), numbersTab(r, v, saved)) },
          { id: 'log', label: 'Sieges', render: (r) => ((tab = 'log'), logTab(r)) },
          { id: 'law', label: 'Law', render: (r) => ((tab = 'law'), lawTab(r)) },
        ],
        tab,
      ),
    )
  }
  const load = async (first = false) => {
    try {
      const v = await get<AdminSiegeView>('siege')
      if (stopped) return
      latest = v
      clear(walls, wallsCard(v, () => void load()))
      clear(now, nowCard(v, () => void load()))
      if (first) renderTabs()
    } catch (e) {
      if (!stopped) clear(now, h('p', { class: 'error' }, errorText(e)))
    }
  }
  void load(true)
  const timer = setInterval(() => void load(), 3000)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

EVENT_PAGES.set('siege', siegePage)

