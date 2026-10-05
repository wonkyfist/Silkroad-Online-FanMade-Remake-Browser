import {
  pilotScaleFactor,
  pilotScaledSummons,
  type AdminBossView,
  type AdminEventInfo,
  type PilotBlockView,
  type PilotEligibilityView,
  type PilotEventSummary,
  type PilotLogLine,
  type PilotSettings,
  type PilotSettingsPatch,
  type PilotVolunteerView,
} from '@sro/shared'
import { AdminApiError, del, get, post, put } from '../api.ts'
import { attempt, badge, button, card, cardHead, clear, confirmDialog, emptyState, errorText, fmtAgo, fmtDuration, fmtNum, fmtTime, formDialog, h, kv, stackTable, tabs, toast } from '../ui.ts'
import { EVENT_PAGES } from './events.ts'

/**
 * Play the Boss, "Night of the Tiger" (docs/PLAY_THE_BOSS.md §6.4), the Events page's sub-page for the `boss` route
 * group. On top, what runs now (the call with its volunteers, the offer, the hunt with her HP and the crowd) with
 * Start now, Force-pick and Stop; under it the tabs: the weekly schedule (in the server's time zone), the numbers of
 * §6.2 (each with its default, its bounds, a reset and the server's 422 messages inline; saves carry the rev), the event
 * log with each event's timeline and volunteers, the lottery blocks and an eligibility check.
 */

const OUTCOME_KIND: Record<string, 'ok' | 'bad' | 'dim' | 'info' | 'gold'> = { survived: 'gold', downs: 'gold', killed: 'ok', cancelled: 'dim', restart: 'dim', no_volunteers: 'dim' }
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** One editable number (or switch, or code) of §6.2. */
interface FieldDef {
  path: string
  label: string
  kind?: 'bool' | 'code'
  step?: number
  hint?: string
}

const GROUPS: { title: string; about: string; fields: FieldDef[] }[] = [
  {
    title: 'The call and the draw',
    about: 'How long players can volunteer, how long a drawn player has to accept, and how many draws before the night falls back to her normal AI.',
    fields: [
      { path: 'call.minutes', label: 'Call length (min)' },
      { path: 'call.acceptSec', label: 'Time to accept (s)' },
      { path: 'call.maxDraws', label: 'Draws at most' },
    ],
  },
  {
    title: 'Who may volunteer',
    about: 'Checked when a player volunteers and again at the draw.',
    fields: [
      { path: 'eligibility.minLevel', label: 'Lowest level' },
      { path: 'eligibility.minPlayHours', label: 'Play time needed (h)', step: 0.5 },
      { path: 'eligibility.cooldownDays', label: 'Days between two turns' },
      { path: 'eligibility.recentEvents', label: 'Not in the last N turns' },
      { path: 'eligibility.firstTimerWeight', label: 'First-timer draw weight', hint: 'An account that never steered her is this many times as likely to be drawn.' },
    ],
  },
  {
    title: 'How she wins',
    about: 'She wins by surviving the timer or downing enough hunters; the hunters win by killing her.',
    fields: [
      { path: 'win.surviveMin', label: 'Survive for (min)' },
      { path: 'win.downsTarget', label: 'Hunters to down' },
      { path: 'win.downMinLevel', label: 'A down counts from level' },
      { path: 'win.downMinDamage', label: 'A down needs damage dealt ≥' },
    ],
  },
  {
    title: 'The hunt',
    about: 'The circle she is held in, the sightings the hunters get, her idle time before her own AI steers, her speed.',
    fields: [
      { path: 'hunt.radiusM', label: 'Hunt circle (m)' },
      { path: 'hunt.pingSec', label: 'A sighting every (s)' },
      { path: 'hunt.pingRadiusM', label: 'Sighting circle (m)' },
      { path: 'hunt.idleSec', label: 'Idle before her AI (s)' },
      { path: 'hunt.speedMul', label: 'Her speed ×', step: 0.05 },
      { path: 'hunt.senseM', label: 'She senses hunters within (m)' },
    ],
  },
  {
    title: 'Big crowds',
    about: 'Her max HP grows with the hunters who really hit her recently: (hunters / base)^exponent, capped.',
    fields: [
      { path: 'scaling.on', label: 'Scale with the crowd', kind: 'bool' },
      { path: 'scaling.baseHunters', label: 'Hunters at her base HP' },
      { path: 'scaling.capHunters', label: 'Hunters cap' },
      { path: 'scaling.exponent', label: 'Exponent', step: 0.05 },
      { path: 'scaling.windowSec', label: 'Recent hits window (s)' },
      { path: 'scaling.minDamage', label: 'Damage to count as a hunter' },
    ],
  },
  {
    title: "The pilot's reward",
    about: 'Gold = base + per down + per minute steered + the win bonus. A quit, a disconnect or a suspect death pays nothing.',
    fields: [
      { path: 'rewards.baseGold', label: 'Base gold' },
      { path: 'rewards.perDownGold', label: 'Gold per down' },
      { path: 'rewards.perMinuteGold', label: 'Gold per minute steered' },
      { path: 'rewards.winGold', label: 'Win bonus' },
      { path: 'rewards.title', label: 'Title on a win', kind: 'code', hint: 'A title code (a-z, 0-9, _); empty = none.' },
      { path: 'rewards.cosmetic', label: 'Cosmetic on a win', kind: 'code', hint: 'None exist yet; empty = none.' },
    ],
  },
  {
    title: 'Guards',
    about: 'A suspect death pays the pilot nothing and flags the event for you.',
    fields: [
      { path: 'guards.associateDamagePct', label: "Suspect: the pilot's friends did ≥ (%)" },
      { path: 'guards.earlyDeathMin', label: 'Suspect: she dies within (min)' },
      { path: 'guards.tauntCooldownSec', label: 'Taunt cooldown (s)' },
    ],
  },
]

// ---- helpers ------------------------------------------------------------------------------------------------------

function valueAt(s: PilotSettings, path: string): unknown {
  const [g, k] = path.split('.')
  const grp = (s as unknown as Record<string, unknown>)[g]
  return k === undefined ? grp : (grp as Record<string, unknown>)[k]
}

function inPatch(p: PilotSettingsPatch, path: string): boolean {
  const [g, k] = path.split('.')
  const grp = (p as Record<string, unknown>)[g]
  return k === undefined ? grp !== undefined : typeof grp === 'object' && grp !== null && k in grp
}

function show(v: unknown): string {
  if (v === null || v === '') return 'none'
  if (typeof v === 'boolean') return v ? 'on' : 'off'
  if (typeof v === 'number') return fmtNum(v)
  return String(v)
}

/** "Sat 10 Oct, 21:00" in the server's zone. */
function zoneTime(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
  } catch {
    return fmtTime(ms)
  }
}

// ---- Now ----------------------------------------------------------------------------------------------------------

function phaseText(c: NonNullable<AdminBossView['current']>, now: number): string {
  if (c.phase === 'call') return `Call for volunteers: the draw in ${fmtDuration(Math.max(0, (c.callEndsAt ?? now) - now))}`
  if (c.phase === 'offer' && c.pilotName) return `Offered to ${c.pilotName}${c.offerExpiresAt ? `, ${Math.max(0, Math.ceil((c.offerExpiresAt - now) / 1000))} s left to accept` : ''}`
  if (c.phase === 'offer') return c.drawAt ? `Drawing a volunteer in ${fmtDuration(Math.max(0, c.drawAt - now))} (after a restart)` : 'Drawing a volunteer'
  if (c.phase === 'hunt') return `Hunt: ${fmtDuration(Math.max(0, (c.huntEndsAt ?? now) - now))} left`
  return c.phase
}

function nowCard(v: AdminBossView, reload: () => void): HTMLElement {
  const now = Date.now()
  const c = v.current
  const her = v.uniques.find((u) => u.steerable)
  const code = her ? { code: her.code } : {}
  const start = button('Start a call…', async () => {
    const vals = await formDialog({
      title: 'Open a call for volunteers',
      intro: 'Every player in the world is asked who will become Tiger Girl; eligible players volunteer, then one is drawn and has 30 s to accept.',
      fields: [{ name: 'minutes', label: 'Call length (minutes)', type: 'number', value: v.settings.effective.call.minutes, min: 1, max: 60, step: 1, required: true }],
      submit: 'Open the call',
    })
    if (!vals) return
    if (await attempt(() => post('boss/start', { ...code, callMinutes: Number(vals.minutes) }), 'The call is open.')) reload()
  }, 'primary')
  const pick = button('Force-pick…', async () => {
    const vals = await formDialog({
      title: 'Force-pick a pilot',
      intro: 'The player is offered the boss now (no eligibility check; 30 s to accept). During a call this closes the call; if they decline, the draw goes on from the volunteers.',
      fields: [{ name: 'character', label: 'Character name (online)', required: true, maxlength: 12 }],
      submit: 'Offer',
    })
    if (!vals) return
    if (await attempt(() => post<{ message: string }>('boss/pick', { character: String(vals.character).trim(), ...code }), 'Offered.')) reload()
  })
  const stop = button('Stop', async () => {
    if (!(await confirmDialog({ title: 'Stop the event', message: 'The call, the draw or the hunt is cancelled at once: she leaves silently, no rewards, the turn is refunded, her normal timer runs.', confirm: 'Stop', danger: true }))) return
    if (await attempt(() => post('boss/stop', code), 'Stopped.')) reload()
  }, 'danger')
  const rows: [string, Node | string][] = []
  if (c) {
    rows.push(['Event', `#${c.id} (${c.name}${c.origin ? `, ${c.origin === 'schedule' ? 'the weekly night' : `started by ${c.origin === 'gm' ? 'a GM' : 'an admin'}`}` : ''})`], ['Phase', phaseText(c, now)])
    if (c.phase === 'call' || (c.phase === 'offer' && c.volunteers !== undefined)) rows.push(['Volunteers', String(c.volunteers ?? 0)])
    if (c.phase === 'hunt') {
      rows.push(
        ['Pilot', c.pilotName ?? '?'],
        ['Steering', c.steering === 'ai' ? badge('her own AI', 'info') : badge('the player', 'gold')],
        ['Downs', `${c.downs ?? 0} / ${c.downsTarget ?? '?'}`],
        ['Hunters', `${c.hunters ?? 0}${c.scaleHunters !== undefined ? ` (${c.scaleHunters} hit her in the last minute)` : ''}`],
        ['Her HP', c.hpPct === null ? '?' : `${c.hpPct}%${c.maxHp ? ` of ${fmtNum(c.maxHp)}` : ''}`],
        ['Area', c.area || '—'],
      )
    }
    if (c.flags.length) rows.push(['Flags', c.flags.join(', ')])
  } else if (v.attach) {
    rows.push(['GM attach', `${v.attach.pilot} steers her (no event rules), ${v.attach.steering === 'ai' ? 'her AI now' : 'the player now'}, HP ${v.attach.hpPct ?? '?'}%`])
  } else {
    rows.push(['Now', 'Nothing is running.'])
    if (her) rows.push([her.name, her.alive ? `alive, ${her.hpPct ?? '?'}% HP (a hunt takes her over where she stands)` : 'waiting (a hunt spawns her at a random camp)'])
  }
  const tz = v.schedule?.tz ?? ''
  rows.push(['Next night', v.nextNight ? `${zoneTime(v.nextNight, tz)} (${tz}), ${fmtAgo(v.nextNight, now)}` : v.schedule?.enabled ? 'no slots set' : 'the weekly night is off'])
  const canPick = !c || c.phase === 'call' || (c.phase === 'offer' && !c.pilotName)
  const actions = c || v.attach ? [canPick && c ? pick : null, stop] : [start, pick]
  return card('Now', kv(rows), h('div', { class: 'row-actions' }, actions))
}

// ---- Schedule --------------------------------------------------------------------------------------------------------

function scheduleTab(root: HTMLElement, v: AdminBossView, code: string | undefined, saved: (v: AdminBossView) => void): void {
  const s = v.settings.effective
  const tz = v.schedule?.tz ?? 'the server zone'
  const enabled = h('input', { type: 'checkbox', checked: s.enabled, 'aria-label': 'Weekly night on' })
  const onText = h('span', { class: 'switch-text' }, s.enabled ? 'On' : 'Off')
  enabled.addEventListener('change', () => (onText.textContent = enabled.checked ? 'On' : 'Off'))
  const list = h('div', { class: 'stack' })
  const slots: { weekday: HTMLSelectElement; time: HTMLInputElement; row: HTMLElement }[] = []
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
  const add = button('Add a night', () => addRow(6, '21:00'), 'small')
  for (const sl of s.schedule.slots) addRow(sl.weekday, sl.time)
  const error = h('div', { class: 'form-error', role: 'alert' })
  const save = button('Save the schedule', async () => {
    error.textContent = ''
    const out = slots.map((x) => ({ weekday: Number(x.weekday.value), time: x.time.value }))
    if (out.some((x) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(x.time))) return void (error.textContent = 'Every night needs a time (HH:MM).')
    try {
      await put('boss/settings', { ...(code ? { code } : {}), baseRev: v.settings.rev, patch: { enabled: enabled.checked, schedule: { slots: out } } })
      toast('Schedule saved.')
      saved(await get<AdminBossView>('boss'))
    } catch (e) {
      error.textContent = errorText(e)
      if (e instanceof AdminApiError && e.status === 409) saved(await get<AdminBossView>('boss'))
    }
  }, 'primary')
  const next = v.nextNight
  clear(
    root,
    card(
      'The weekly Night of the Tiger',
      h('p', { class: 'dim' }, `The call opens ${s.call.minutes} min before each night's time; the draw is at that time. GM and admin starts always work, on or off.`),
      h('div', { class: 'setting-control' }, h('label', { class: 'switch' }, enabled, h('span', { class: 'switch-track' }), onText)),
      h('h4', null, 'Nights'),
      list,
      h('div', { class: 'actions' }, add),
      h('p', { class: 'dim small' }, `Times are in the server's time zone: ${tz}.`),
      h('p', null, next ? `Next night: ${zoneTime(next, tz)} (${fmtAgo(next)}); its call opens at ${zoneTime(next - s.call.minutes * 60_000, tz)}.` : s.enabled ? 'No night set.' : 'The weekly night is off.'),
      error,
      h('div', { class: 'actions end' }, save),
    ),
  )
}

// ---- Numbers ---------------------------------------------------------------------------------------------------------

function numbersTab(root: HTMLElement, v: AdminBossView, code: string | undefined, saved: (v: AdminBossView) => void): void {
  const { effective, defaults, patch = {}, rev, bounds, levelCap } = v.settings
  const reads = new Map<string, () => unknown>()
  const errors = new Map<string, HTMLElement>()
  const reload = async () => saved(await get<AdminBossView>('boss'))
  const field = (f: FieldDef) => {
    const cur = valueAt(effective, f.path)
    const def = valueAt(defaults, f.path)
    let b = bounds[f.path]
    if (b && levelCap && (f.path === 'eligibility.minLevel' || f.path === 'win.downMinLevel')) b = [b[0], Math.min(b[1], levelCap)]
    let control: HTMLElement
    if (f.kind === 'bool') {
      const box = h('input', { type: 'checkbox', checked: cur === true, 'aria-label': f.label })
      const text = h('span', { class: 'switch-text' }, cur ? 'On' : 'Off')
      box.addEventListener('change', () => (text.textContent = box.checked ? 'On' : 'Off'))
      control = h('label', { class: 'switch' }, box, h('span', { class: 'switch-track' }), text)
      reads.set(f.path, () => box.checked)
    } else if (f.kind === 'code') {
      const inp = h('input', { class: 'input', value: cur === null ? '' : String(cur), maxlength: 32, placeholder: 'none', 'aria-label': f.label, autocomplete: 'off' })
      control = inp
      reads.set(f.path, () => (inp.value.trim() === '' ? null : inp.value.trim()))
    } else {
      const inp = h('input', { class: 'input num-input', type: 'number', value: String(cur), min: b?.[0], max: b?.[1], step: f.step ?? 1, 'aria-label': f.label })
      control = inp
      reads.set(f.path, () => (inp.value.trim() === '' ? Number.NaN : Number(inp.value)))
    }
    const err = h('div', { class: 'field-error', hidden: true })
    errors.set(f.path, err)
    const changed = inPatch(patch, f.path)
    const reset = changed
      ? button('Reset', async () => {
          if (await attempt(() => post('boss/settings/reset', { ...(code ? { code } : {}), baseRev: rev, paths: [f.path] }), `${f.label}: back to ${show(def)}.`)) await reload()
        }, 'small')
      : null
    return h(
      'div',
      { class: 'setting' },
      h('div', { class: 'setting-head' }, h('label', { class: 'setting-label' }, f.label), changed ? badge('changed', 'gold') : null),
      h('div', { class: 'setting-control' }, control, reset),
      h('div', { class: 'setting-meta dim small' }, `default ${show(def)}${b ? ` · ${fmtNum(b[0])}–${fmtNum(b[1])}` : ''}`),
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
    const delta: Record<string, Record<string, unknown>> = {}
    for (const [path, read] of reads) {
      const val = read()
      if (typeof val === 'number' && Number.isNaN(val)) {
        const e = errors.get(path)!
        e.textContent = 'Enter a number.'
        e.hidden = false
        continue
      }
      if (JSON.stringify(val) === JSON.stringify(valueAt(effective, path))) continue
      const [g, k] = path.split('.')
      ;(delta[g] ??= {})[k] = val
    }
    if ([...errors.values()].some((e) => !e.hidden)) return
    if (Object.keys(delta).length === 0) return toast('Nothing changed.', 'info')
    try {
      await put('boss/settings', { ...(code ? { code } : {}), baseRev: rev, patch: delta })
      toast('Saved; the numbers apply now (a running event keeps its timers).')
      await reload()
    } catch (e) {
      if (e instanceof AdminApiError && e.issues.length) {
        for (const i of e.issues) {
          const el = errors.get(i.path.replace(/\[\d+\]$/, ''))
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
    if (!(await confirmDialog({ title: 'Reset every number', message: 'Every number (and the schedule) goes back to the defaults in content/uniques.json.', confirm: 'Reset all' }))) return
    if (await attempt(() => post('boss/settings/reset', { ...(code ? { code } : {}), baseRev: rev }), 'Back to the defaults.')) await reload()
  })
  const sc = effective.scaling
  const preview = [10, 20, 40].map((n) => `${n} hunters: ×${pilotScaleFactor(n, sc).toFixed(2)} HP, waves of ${pilotScaledSummons({ perWave: 2, maxAlive: 4 }, pilotScaleFactor(n, sc)).perWave}`).join(' · ')
  clear(
    root,
    h('p', { class: 'dim' }, `Defaults come from content/uniques.json; what you change here is stored on this server (rev ${rev}) and applies at once.`),
    GROUPS.map((g) => card(g.title, h('p', { class: 'dim small' }, g.about), g.title === 'Big crowds' ? h('p', { class: 'small' }, preview) : null, h('div', { class: 'settings' }, g.fields.map(field)))),
    formError,
    h('div', { class: 'actions end' }, Object.keys(patch).length ? resetAll : null, button('Save the numbers', () => void saveAll(), 'primary')),
  )
}

// ---- Event log ----------------------------------------------------------------------------------------------------

function logLine(l: PilotLogLine): string {
  const d = l.data
  const s = (k: string) => (d[k] === undefined || d[k] === null ? '' : String(d[k]))
  switch (l.kind) {
    case 'call':
      return `the call opened (${s('origin')})`
    case 'volunteer':
      return `${s('name')} volunteered`
    case 'withdraw':
      return `${s('name')} withdrew`
    case 'draw':
      return `the draw: ${s('volunteers')} volunteers`
    case 'restart':
      return `resumed after a restart (${s('phase')})`
    case 'offer':
      return `offered to ${s('name')} (${s('origin') === 'draw' ? `draw ${s('draw')}` : s('origin')})`
    case 'accept':
      return `${s('name')} accepted`
    case 'decline':
      return `${s('name')} declined`
    case 'timeout':
      return `${s('name') || 'the player'}: no answer (${s('why') || 'timeout'})`
    case 'spawn':
      return d.ai ? 'she appeared as her normal AI self' : `she spawned at camp ${s('camp')}${s('area') ? ` (${s('area')})` : ''}`
    case 'takeover':
      return `taken over at ${s('hpPct')}% HP${s('area') ? ` (${s('area')})` : ''}`
    case 'ai':
      return `her AI steers (${s('why')})`
    case 'player':
      return 'the pilot took her back'
    case 'down':
      return `${s('name')} downed (${s('downs')})`
    case 'reward':
      return d.cosmetic !== undefined ? `cosmetic ${s('cosmetic')}: not granted (${s('why')})` : `reward: ${fmtNum(Number(d.gold ?? 0))} gold${s('honor') ? `, title ${s('honor')}` : ''}`
    case 'flag':
      return `flag: ${s('flag')}${s('why') ? ` (${s('why')})` : ''}`
    case 'gm':
      return `${s('action')} by ${s('by')}${s('name') ? ` (${s('name')})` : ''}`
    case 'end':
      return `ended: ${s('outcome')}`
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
      const r = await get<{ event: PilotEventSummary; log: PilotLogLine[]; volunteers: PilotVolunteerView[] }>(`boss/events/${id}`)
      clear(
        detail,
        h('h4', null, `Event #${r.event.id}`),
        h('ul', { class: 'timeline' }, r.log.map((l) => h('li', null, h('span', { class: 'mono small dim' }, fmtTime(l.at)), ' ', logLine(l)))),
        r.volunteers.length
          ? [h('h4', null, `Volunteers (${r.volunteers.length}), in draw order`), h('ol', null, r.volunteers.map((x) => h('li', null, x.name, ' ', x.draw ? badge(x.draw, x.draw === 'accepted' ? 'gold' : x.draw.startsWith('skipped') ? 'dim' : 'info') : badge('not drawn', 'dim'))))]
          : null,
      )
    } catch (e) {
      clear(detail, h('p', { class: 'error' }, errorText(e)))
    }
  }
  const load = async () => {
    try {
      const r = await get<{ events: PilotEventSummary[] }>('boss/events?limit=50')
      if (r.events.length === 0) return void clear(table, emptyState('No events yet.', 'events'))
      clear(
        table,
        h(
          'div',
          { class: 'table-scroll' },
          stackTable(
            h(
              'table',
              { class: 'table' },
              h('thead', null, h('tr', null, ['Started', 'Origin', 'Pilot', 'Outcome', 'Length', 'Downs', 'Hunters', 'Gold', 'Flags', ''].map((x) => h('th', null, x)))),
              h(
                'tbody',
                null,
                r.events.map((e) => {
                  const suspect = e.flags.some((f) => f.startsWith('suspect'))
                  const length = e.huntStartedAt && e.endedAt ? fmtDuration(e.endedAt - e.huntStartedAt) : '—'
                  return h(
                    'tr',
                    suspect ? { class: 'row-warn' } : null,
                    h('td', null, fmtTime(e.huntStartedAt ?? e.createdAt)),
                    h('td', null, e.origin),
                    h('td', null, e.pilot ?? '—'),
                    h('td', null, e.phase === 'ended' ? badge(e.outcome ?? 'ended', OUTCOME_KIND[e.outcome ?? ''] ?? 'dim') : badge(e.phase, 'info'), e.refunded ? ' (refunded)' : ''),
                    h('td', null, length),
                    h('td', { class: 'num' }, String(e.downs)),
                    h('td', { class: 'num' }, String(e.hunters)),
                    h('td', { class: 'num' }, fmtNum(e.rewardGold)),
                    h('td', null, e.flags.length ? e.flags.map((f) => badge(f, f.startsWith('suspect') ? 'bad' : 'dim')) : '—'),
                    h('td', { class: 'row-actions' }, button('Timeline', () => void open(e.id), 'small')),
                  )
                }),
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

// ---- Blocks ---------------------------------------------------------------------------------------------------------

function blocksTab(root: HTMLElement): void {
  const body = h('div')
  root.append(body)
  const render = (blocks: PilotBlockView[]) => {
    const add = button('Block an account…', async () => {
      const vals = await formDialog({
        title: 'Block from the lottery',
        intro: 'The account cannot volunteer until the block ends (it can still hunt).',
        fields: [
          { name: 'who', label: 'Character or account name', required: true, maxlength: 32 },
          { name: 'days', label: 'Days', type: 'number', value: 14, min: 0.1, max: 3650, step: 'any', required: true },
          { name: 'reason', label: 'Reason', maxlength: 200 },
        ],
        submit: 'Block',
      })
      if (!vals) return
      const r = await attempt(() => put<{ blocks: PilotBlockView[] }>(`boss/blocks/${encodeURIComponent(String(vals.who).trim())}`, { days: Number(vals.days), reason: String(vals.reason ?? '') }), 'Blocked.')
      if (r) render(r.blocks)
    }, 'primary')
    clear(
      body,
      card(
        cardHead('Lottery blocks', add),
        blocks.length === 0
          ? emptyState('Nobody is blocked.', 'inbox')
          : h(
              'div',
              { class: 'table-scroll' },
              stackTable(
                h(
                  'table',
                  { class: 'table' },
                  h('thead', null, h('tr', null, ['Account', 'Characters', 'Until', 'Reason', 'By', ''].map((x) => h('th', null, x)))),
                  h(
                    'tbody',
                    null,
                    blocks.map((b) =>
                      h(
                        'tr',
                        null,
                        h('td', null, b.username ?? `#${b.account}`),
                        h('td', null, b.characters.join(', ') || '—'),
                        h('td', null, `${fmtTime(b.until)} (${fmtAgo(b.until)})`),
                        h('td', null, b.reason || '—'),
                        h('td', null, b.byName ?? (b.by === null ? 'a GM' : `#${b.by}`)),
                        h('td', { class: 'row-actions' }, button('Remove', async () => {
                          const r = await attempt(() => del<{ blocks: PilotBlockView[] }>(`boss/blocks/%23${b.account}`), 'Block removed.')
                          if (r) render(r.blocks)
                        }, 'small')),
                      ),
                    ),
                  ),
                ),
              ),
            ),
      ),
    )
  }
  void get<{ blocks: PilotBlockView[] }>('boss/blocks').then((r) => render(r.blocks), (e) => clear(body, emptyState(errorText(e), 'alert', true)))
}

// ---- Eligibility ---------------------------------------------------------------------------------------------------

const WHY: Record<string, string> = {
  level: 'level too low',
  playtime: 'not enough play time',
  cooldown: 'steered her too recently (cooldown)',
  recent: 'steered her in one of the last turns',
  blocked: 'blocked',
  dead: 'dead',
  busy: 'busy (a trade, a stall, steering)',
}

function eligibilityTab(root: HTMLElement): void {
  const out = h('div')
  const name = h('input', { class: 'input', placeholder: 'Character name', maxlength: 12, 'aria-label': 'Character name', autocomplete: 'off' })
  const check = async () => {
    const n = name.value.trim()
    if (!n) return
    try {
      const r = await get<PilotEligibilityView>(`boss/eligibility?character=${encodeURIComponent(n)}`)
      clear(
        out,
        kv([
          ['Character', `${r.character} (account #${r.account}, ${r.online ? 'online' : 'offline'}, level ${r.level})`],
          ['May volunteer', r.eligible ? badge('yes', 'ok') : [badge('no', 'bad'), ` ${WHY[r.why ?? ''] ?? r.why ?? ''}`]],
          ['Play time', `${r.playedHours} h`],
          ['Last turn', r.lastTurnAt ? `${fmtTime(r.lastTurnAt)} (${fmtAgo(r.lastTurnAt)})` : 'never'],
          ['Blocked until', r.blockedUntil ? fmtTime(r.blockedUntil) : '—'],
          ['Draw weight', `×${r.weight}`],
        ]),
      )
    } catch (e) {
      clear(out, h('p', { class: 'error' }, errorText(e)))
    }
  }
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void check()
  })
  root.append(card('Eligibility check', h('p', { class: 'dim small' }, 'Why a character may or may not volunteer now (the same rules the call uses).'), h('div', { class: 'inline-form' }, name, button('Check', () => void check(), 'primary')), out))
}

// ---- the page -------------------------------------------------------------------------------------------------------

/** The sub-page (EVENT_PAGES 'boss'); returns its cleanup. */
export function bossPage(root: HTMLElement, _event: AdminEventInfo): () => void {
  const now = h('div')
  const body = h('div')
  root.append(now, body)
  let stopped = false
  let latest: AdminBossView | null = null
  let tab = 'schedule'
  const code = () => latest?.uniques.find((u) => u.steerable)?.code
  /** A tab that edits the settings re-renders after a save (with the fresh view). */
  const saved = (v: AdminBossView) => {
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
          { id: 'schedule', label: 'Schedule', render: (r) => ((tab = 'schedule'), scheduleTab(r, v, code(), saved)) },
          { id: 'numbers', label: 'Numbers', render: (r) => ((tab = 'numbers'), numbersTab(r, v, code(), saved)) },
          { id: 'log', label: 'Event log', render: (r) => ((tab = 'log'), logTab(r)) },
          { id: 'blocks', label: 'Blocks', render: (r) => ((tab = 'blocks'), blocksTab(r)) },
          { id: 'eligibility', label: 'Eligibility', render: (r) => ((tab = 'eligibility'), eligibilityTab(r)) },
        ],
        tab,
      ),
    )
  }
  // The Now card refreshes every 3 s; the tabs only on open and after a save (a form is never replaced under the cursor).
  const load = async (first = false) => {
    try {
      const v = await get<AdminBossView>('boss')
      if (stopped) return
      latest = v
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

EVENT_PAGES.set('boss', bossPage)
