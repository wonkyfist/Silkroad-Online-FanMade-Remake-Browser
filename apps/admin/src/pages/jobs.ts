import {
  JOBS_CONTENT,
  JOB_IDS,
  JOB_NAMES,
  JOB_SETTINGS_LISTS,
  jobLevelName,
  tradeBuyPrice,
  tradeMargin,
  tradeSellPrice,
  type AdminEventInfo,
  type AdminJobsView,
  type CaravanView,
  type JobId,
  type JobSettings,
  type JobSettingsPatch,
} from '@sro/shared'
import { AdminApiError, get, post, put } from '../api.ts'
import { attempt, badge, button, card, cardHead, clear, confirmDialog, emptyState, errorText, fmtAgo, fmtDuration, fmtNum, fmtTime, formDialog, h, kv, pageHeader, stackTable, tabs, toast } from '../ui.ts'
import { svgIcon } from '../icons.ts'
import { EVENT_PAGES } from './events.ts'

/**
 * Jobs & Trade (docs/JOBS.md §9.5, layer 7): the job system's admin page over `/api/admin/jobs/*` (jobs-admin.ts on the
 * server: admin role, a gm_audit row per write).
 *
 * Tabs: **Members** (filters by job, job level, side, account; set the level, revoke / restore the licence, clear the
 * account's waits, suit off, leave, add a member), **Market** (every post's demand and every source's buy multiplier
 * with drift arrows and the price they give now; override one, reset all; the latest trades), **Transports** (an island
 * plan with the posts and the transports, the list with heal / kill / dismiss), **Robbery & law** (open robbery
 * warrants, goods carried outside transports, withheld job rewards = collusion attempts, the robbery log; confiscate,
 * jail, revoke), **Settings** (every job / mode / trade / drift / thief / robbery / EXP / storm / transport / ambush
 * number with its default and bounds; they apply live), **Silk Caravan** (the event: start / stop, the weekly slots,
 * its numbers and its log; also the Events page's sub-page).
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const PLURAL: Record<JobId, string> = { trader: 'Traders', hunter: 'Bounty Hunters', thief: 'Thieves' }
const JOB_KIND: Record<JobId, 'gold' | 'info' | 'bad'> = { trader: 'gold', hunter: 'info', thief: 'bad' }
const RULE_TEXT: Record<string, string> = {
  robbery_pair: 'same Thief and Trader accounts again (pair rule)',
  robbery_contact: 'Thief picked goods of a recent contact',
  recovery_contact: "Bounty Hunter turned in an associate's goods",
  thief_kill_pair: 'same Bounty Hunter killed the same Thief again',
  escort_same_ip: 'escort from the same IP',
}
const TRADE_KIND: Record<string, 'ok' | 'bad' | 'dim' | 'info' | 'gold'> = { buy: 'dim', sell: 'ok', lost: 'bad', robbed: 'bad', stolen: 'bad', den: 'bad', recovered: 'info', turnin: 'info', confiscated: 'info', summon: 'dim', caravan: 'gold' }

interface FieldDef {
  path: string
  label: string
  step?: number
  hint?: string
}

/** Every number of the settings, by group (the event's are on the Silk Caravan tab). */
const GROUPS: { title: string; about: string; fields: FieldDef[] }[] = [
  {
    title: 'Jobs',
    about: 'Joining (Trader at Jodaesan, Thief at Old Fang; the Bounty Hunter licence is the siege’s), waits after leaving a job or changing sides, and job EXP per level 1-7.',
    fields: [
      { path: 'jobs.minLevel', label: 'Join from character level' },
      { path: 'jobs.licenceGold', label: 'Trader / Thief licence (gold)' },
      { path: 'jobs.leaveWaitDays', label: 'Wait after leaving a job (days)' },
      { path: 'jobs.sideChangeDays', label: 'Wait between side changes (days)' },
      { path: 'jobs.levels', label: 'Job EXP for levels 1-7' },
    ],
  },
  {
    title: 'Job mode (the suit)',
    about: 'The suit stays on after a PvP hit; the 12 m safe rings of the posts and the den; where Thieves dress.',
    fields: [
      { path: 'mode.offLockMin', label: 'Suit locked after a PvP hit (min)' },
      { path: 'mode.safeRingM', label: 'Safe ring of posts and den (m)' },
      { path: 'mode.thiefDressM', label: 'Thieves dress within (m) of Old Fang / the den' },
    ],
  },
  {
    title: 'Trade',
    about: 'The sell price is base × (1 + margin) × demand × (1 − tax); margin = base + km × distance + danger × road danger.',
    fields: [
      { path: 'trade.taxPct', label: 'Tax (%)' },
      { path: 'trade.buyCapPerHour', label: 'Crates bought per account per hour' },
      { path: 'trade.starThresholds', label: 'Load value for 2-5 stars' },
      { path: 'trade.maxStars', label: 'Most stars at job levels 1-7' },
      { path: 'trade.marginBase', label: 'Margin: base', step: 0.005 },
      { path: 'trade.marginKm', label: 'Margin: per km', step: 0.005 },
      { path: 'trade.marginDanger', label: 'Margin: per danger step', step: 0.005 },
      { path: 'trade.newsDemand', label: "The day's news: demand ×", step: 0.05 },
    ],
  },
  {
    title: 'Price drift',
    about: 'Each crate sold lowers the post’s demand, each crate bought raises the source’s price; both recover toward 1 per hour.',
    fields: [
      { path: 'drift.sellImpact', label: 'Demand lost per crate sold', step: 0.0005 },
      { path: 'drift.buyImpact', label: 'Price gained per crate bought', step: 0.0005 },
      { path: 'drift.floor', label: 'Demand at least', step: 0.05 },
      { path: 'drift.cap', label: 'Buy price × at most', step: 0.05 },
      { path: 'drift.recoverPerHour', label: 'Recovery per hour', step: 0.005 },
      { path: 'drift.accountDayMax', label: 'Demand one account may move per day', step: 0.05 },
    ],
  },
  {
    title: 'Thieves',
    about: 'What a dead transport drops, what the den pays (of the base price), how long bags lie, and the caravan pings.',
    fields: [
      { path: 'thief.dropPct', label: 'Dead transport drops (%)' },
      { path: 'thief.denPct', label: 'The den pays (% of base)' },
      { path: 'thief.bagLifeMin', label: 'Goods bags last (min)' },
      { path: 'thief.pingSec', label: 'Caravan ping every (s)' },
      { path: 'thief.pingR', label: 'Ping circle (m)' },
      { path: 'thief.pingMinStars', label: 'Pinged from stars' },
    ],
  },
  {
    title: 'Robbery and the law',
    about: 'Robbery warrants (online minutes), the robbery jail ladder, forgiveness, the Bounty Hunters’ recovery reward and the pair rule window.',
    fields: [
      { path: 'robbery.warrantOnlineMin', label: 'Warrant lapses after (online min)' },
      { path: 'robbery.sentencesMin', label: 'Sentences 1st-4th robbery (min)' },
      { path: 'robbery.forgiveDays', label: 'One level forgiven per (clean days)' },
      { path: 'robbery.recoveryPct', label: 'Recovery reward (% of den value)' },
      { path: 'robbery.pairWindowH', label: 'Pair rule window (h)' },
      { path: 'robbery.hunterMul', label: 'Bounty Hunter damage on robbers ×', step: 0.1 },
    ],
  },
  {
    title: 'Job EXP',
    about: 'Job EXP only (never character EXP).',
    fields: [
      { path: 'exp.traderProfitDiv', label: 'Trader: profit ÷' },
      { path: 'exp.traderStarMul', label: 'Trader: × at 1-5 stars' },
      { path: 'exp.hunterEscortPct', label: 'Escort share (%)' },
      { path: 'exp.hunterThiefKill', label: 'Thief killed: × job level' },
      { path: 'exp.hunterWallCapture', label: 'Wall-breaker captured' },
      { path: 'exp.thiefDenDiv', label: 'Thief: den payout ÷' },
      { path: 'exp.thiefTransportKill', label: 'Transport killed: × stars' },
    ],
  },
  {
    title: 'Storms and snow',
    about: 'Tornadoes scatter goods; snow slows transports outside town (Dec 1 – Jan 15).',
    fields: [
      { path: 'storm.tornadoScatterPct', label: 'Tornado scatters (% of crates)' },
      { path: 'storm.snowSpeedPct', label: 'Snow speed (%)' },
    ],
  },
  {
    title: 'Transports',
    about: 'How the pack animal follows its Trader, waits, lingers after a logout or the Trader’s death, the trader ring, and how hard it is to rob (its defence against Thieves per tier, their damage ×; monsters keep the fixed defence).',
    fields: [
      { path: 'transport.leashM', label: 'Follows the trail within (m)' },
      { path: 'transport.waitM', label: 'Stops and waits past (m)' },
      { path: 'transport.lingerS', label: 'Lingers after logout (s)' },
      { path: 'transport.ownerDeathS', label: 'Waits after the Trader’s death (s)' },
      { path: 'transport.ringM', label: 'Summon / load ring (m)' },
      { path: 'transport.gapM', label: 'Keeps behind (m)', step: 0.5 },
      { path: 'transport.thiefDefence', label: 'Defence vs Thieves: Donkey, Horse, Thoroughbred, Ironclad' },
      { path: 'transport.thiefMul', label: 'Thief damage on transports ×', step: 0.05 },
    ],
  },
  {
    title: 'Bandit ambushes',
    about: 'Expected groups per load by stars (the whole part always, the fraction by chance), their size and where on the road.',
    fields: [
      { path: 'ambush.perStar', label: 'Groups at 1-5 stars' },
      { path: 'ambush.groupMin', label: 'Bandits per group, from' },
      { path: 'ambush.groupMax', label: 'Bandits per group, to' },
      { path: 'ambush.fromPct', label: 'From (% of the road)' },
      { path: 'ambush.toPct', label: 'To (% of the road)' },
      { path: 'ambush.offRoadM', label: 'Off the road (m)' },
      { path: 'ambush.farKm', label: 'Far bands past (km)', step: 0.1 },
      { path: 'ambush.lifeMin', label: 'Unkilled bandits leave after (min)' },
    ],
  },
]

const EVENT_FIELDS: FieldDef[] = [
  { path: 'event.durationMin', label: 'Lasts (min)' },
  { path: 'event.demand', label: 'Boosted post: demand ×', step: 0.05 },
  { path: 'event.expMul', label: 'Trader job EXP ×', step: 0.05 },
  { path: 'event.escortMul', label: 'Escort job EXP ×', step: 0.05 },
  { path: 'event.ambushMul', label: 'Ambushes ×', step: 0.1 },
  { path: 'event.denMul', label: 'The den pays ×', step: 0.05 },
  { path: 'event.rewardGold', label: 'Reward per completed run (gold)' },
  { path: 'event.rewardRuns', label: 'Rewarded runs per character' },
  { path: 'event.busyWaitMin', label: 'Waits for a siege / Night (min)' },
]

function valueAt(s: JobSettings | JobSettingsPatch, path: string): unknown {
  const [g, k] = path.split('.') as [string, string]
  const grp = (s as Record<string, Record<string, unknown> | undefined>)[g]
  return grp?.[k]
}

function inPatch(p: JobSettingsPatch, path: string): boolean {
  return valueAt(p, path) !== undefined
}

function table(heads: string[], rows: HTMLElement[], cls = 'table'): HTMLElement {
  return h('div', { class: 'table-scroll' }, stackTable(h('table', { class: cls }, h('thead', null, h('tr', null, heads.map((x) => h('th', null, x)))), h('tbody', null, rows))))
}

function goodName(code: string | null): string {
  if (!code) return '—'
  return JOBS_CONTENT.goods.find((g) => g.code === code)?.name ?? code
}

function zoneTime(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
  } catch {
    return fmtTime(ms)
  }
}

/** A drift arrow: ▲ / ▼ by how far `v` is off 1. */
function drift(v: number, goodWhenUp: boolean): HTMLElement {
  const d = v - 1
  if (Math.abs(d) < 0.0005) return h('span', { class: 'dim' }, '1.000')
  const up = d > 0
  return h('span', { class: up === goodWhenUp ? 'jobs-up' : 'jobs-down', title: `${up ? '+' : ''}${(d * 100).toFixed(1)} %` }, `${up ? '▲' : '▼'} ${v.toFixed(3)}`)
}

// ---- settings fields (the Settings tab and the event's numbers) ---------------------------------------------------------------

function settingsForm(v: AdminJobsView, groups: { title: string; about: string; fields: FieldDef[] }[], reload: () => Promise<void>, intro: string, extra?: HTMLElement): HTMLElement {
  const { effective, defaults, patch, rev, bounds } = v.settings
  const reads = new Map<string, () => number | number[] | boolean>()
  const errors = new Map<string, HTMLElement>()
  const field = (f: FieldDef) => {
    const cur = valueAt(effective, f.path)
    const def = valueAt(defaults, f.path)
    const b = bounds[f.path]
    const list = JOB_SETTINGS_LISTS[f.path]
    let inp: HTMLInputElement
    if (list) {
      inp = h('input', { class: 'input', type: 'text', value: (cur as number[]).join(', '), 'aria-label': f.label, spellcheck: 'false' })
      reads.set(f.path, () => inp.value.split(/[,\s]+/).filter(Boolean).map(Number))
    } else {
      inp = h('input', { class: 'input num-input', type: 'number', value: String(cur), min: b?.[0], max: b?.[1], step: f.step ?? 1, 'aria-label': f.label })
      reads.set(f.path, () => (inp.value.trim() === '' ? Number.NaN : Number(inp.value)))
    }
    const err = h('div', { class: 'field-error', hidden: true })
    errors.set(f.path, err)
    const changed = inPatch(patch, f.path)
    const reset = changed
      ? button('Reset', async () => {
          if (await attempt(() => post('jobs/settings/reset', { baseRev: rev, paths: [f.path] }), `${f.label}: back to the default.`)) await reload()
        }, 'small')
      : null
    const defText = Array.isArray(def) ? def.join(', ') : typeof def === 'number' ? fmtNum(def) : String(def)
    const range = list ? `${list.length} numbers ${fmtNum(list.min)}–${fmtNum(list.max)}${list.rising ? ', never falling' : ''}` : b ? `${fmtNum(b[0])}–${fmtNum(b[1])}` : ''
    return h(
      'div',
      { class: 'setting' },
      h('div', { class: 'setting-head' }, h('label', { class: 'setting-label' }, f.label), changed ? badge('changed', 'gold') : null),
      h('div', { class: 'setting-control' }, inp, reset),
      h('div', { class: 'setting-meta dim small' }, `default ${defText}${range ? ` · ${range}` : ''}`),
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
      const bad = typeof val === 'number' ? Number.isNaN(val) : Array.isArray(val) ? val.some((n) => Number.isNaN(n)) : false
      if (bad) {
        const e = errors.get(path)!
        e.textContent = Array.isArray(val) ? 'Enter numbers separated by commas.' : 'Enter a number.'
        e.hidden = false
        continue
      }
      if (JSON.stringify(val) === JSON.stringify(valueAt(effective, path))) continue
      const [g, k] = path.split('.') as [string, string]
      ;(delta[g] ??= {})[k] = val
    }
    if ([...errors.values()].some((e) => !e.hidden)) return
    if (Object.keys(delta).length === 0) return toast('Nothing changed.', 'info')
    try {
      await put('jobs/settings', { baseRev: rev, patch: delta })
      toast('Saved; the numbers apply now.')
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
  return h(
    'div',
    null,
    h('p', { class: 'dim' }, intro),
    extra ?? null,
    groups.map((g) => card(g.title, h('p', { class: 'dim small' }, g.about), h('div', { class: 'settings' }, g.fields.map(field)))),
    formError,
    h('div', { class: 'actions end' }, button('Save', () => void saveAll(), 'primary')),
  )
}

// ---- members ----------------------------------------------------------------------------------------------------------------------

function membersTab(root: HTMLElement, v: AdminJobsView, reload: () => Promise<void>, state: { job: string; level: string; side: string; q: string }): void {
  const info = new Map((v.memberInfo ?? []).map((m) => [m.characterId, m]))
  const levels = v.settings.effective.jobs.levels
  const jobSel = h('select', { class: 'input', 'aria-label': 'Job' }, h('option', { value: '' }, 'Every job'), JOB_IDS.map((j) => h('option', { value: j }, `${JOB_NAMES[j]} (${v.counts[j]})`)))
  const lvSel = h('select', { class: 'input', 'aria-label': 'Job level' }, h('option', { value: '' }, 'Every level'), [1, 2, 3, 4, 5, 6, 7].map((n) => h('option', { value: String(n) }, `Level ${n}`)))
  const sideSel = h('select', { class: 'input', 'aria-label': 'Side' }, h('option', { value: '' }, 'Both sides'), h('option', { value: 'law' }, 'Law (Traders, Bounty Hunters)'), h('option', { value: 'outlaw' }, 'Outlaws (Thieves)'))
  const search = h('input', { class: 'input search-input', type: 'search', placeholder: 'Character or account', 'aria-label': 'Character or account' })
  jobSel.value = state.job
  lvSel.value = state.level
  sideSel.value = state.side
  search.value = state.q
  const list = h('div')
  const act = async (body: Record<string, unknown>, done?: string) => {
    if (await attempt(() => post('jobs/member', body), done)) await reload()
  }
  const draw = () => {
    state.job = jobSel.value
    state.level = lvSel.value
    state.side = sideSel.value
    state.q = search.value.trim().toLowerCase()
    const rows = v.members.filter((m) => {
      const i = info.get(m.characterId)
      if (state.job && m.job !== state.job) return false
      if (state.level && m.level !== Number(state.level)) return false
      if (state.side && i?.side !== state.side) return false
      if (state.q && !m.name.toLowerCase().includes(state.q) && !(i?.account ?? '').toLowerCase().includes(state.q) && String(i?.accountId ?? '') !== state.q) return false
      return true
    })
    clear(
      list,
      rows.length === 0
        ? emptyState(v.members.length ? 'No member matches the filters.' : 'Nobody holds a job yet.', 'inbox')
        : table(
            ['Character', 'Job', 'Job level', 'Job EXP', 'Char. level', 'Account', 'Suit', 'Licence', ''],
            rows.map((m) => {
              const i = info.get(m.characterId)
              const next = levels[m.level] ?? null
              return h(
                'tr',
                null,
                h('td', null, h('strong', null, m.name), ' ', m.online ? badge('online', 'ok') : badge('offline', 'dim')),
                h('td', null, badge(JOB_NAMES[m.job], JOB_KIND[m.job])),
                h('td', null, `${m.level} · ${jobLevelName(m.job, m.level)}`),
                h('td', { class: 'num' }, fmtNum(m.exp), next !== null ? h('div', { class: 'dim small' }, `next ${fmtNum(next)}`) : null),
                h('td', { class: 'num' }, String(i?.charLevel ?? '—')),
                h('td', null, i ? `${i.account} (#${i.accountId})` : '—', i?.side ? h('div', { class: 'dim small' }, i.side === 'law' ? 'law side' : 'outlaw side') : null),
                h('td', null, m.mode ? badge('in the suit', 'info') : 'off'),
                h('td', null, m.revokedUntil ? badge(`revoked until ${fmtTime(m.revokedUntil)}`, 'bad') : badge('licensed', 'ok')),
                h(
                  'td',
                  { class: 'row-actions' },
                  button('Level…', async () => {
                    const r = await formDialog({
                      title: `${m.name}: job level`,
                      intro: 'Sets the job EXP to the start of that level (no character EXP changes).',
                      fields: [{ name: 'level', label: 'Job level (1-7)', type: 'number', value: m.level, min: 1, max: 7, required: true }],
                      submit: 'Set level',
                    })
                    if (r) await act({ character: m.characterId, level: Number(r.level) }, `${m.name}: level ${String(r.level)}.`)
                  }, 'small'),
                  m.revokedUntil
                    ? button('Restore', () => void act({ character: m.characterId, restore: true }, `${m.name}'s licence is restored.`), 'small')
                    : button('Revoke…', async () => {
                        if (m.job === 'hunter') {
                          if (await confirmDialog({ title: 'Revoke', message: `Take ${m.name}'s Bounty Hunter licence away for the siege's revoke days (hunter.revokeDays); the suit comes off.`, confirm: 'Revoke', danger: true })) await act({ character: m.characterId, revoke: 1 }, `${m.name}'s licence is revoked.`)
                          return
                        }
                        const r = await formDialog({
                          title: `Revoke ${m.name}'s ${JOB_NAMES[m.job]} licence`,
                          intro: 'The suit comes off and stays off until the licence runs out (or you restore it). Job level and EXP are kept.',
                          fields: [{ name: 'days', label: 'Days', type: 'number', value: 7, min: 0.01, max: 3650, step: 'any', required: true }],
                          submit: 'Revoke',
                          danger: true,
                        })
                        if (r) await act({ character: m.characterId, revoke: Number(r.days) }, `${m.name}'s licence is revoked.`)
                      }, 'small'),
                  button('Reset waits', async () => {
                    if (await confirmDialog({ title: 'Reset the waits', message: `Clear the waits of ${m.name}'s account: it may take a job again and change sides at once (the ${v.settings.effective.jobs.leaveWaitDays}-day leave wait and the ${v.settings.effective.jobs.sideChangeDays}-day side wait).`, confirm: 'Reset' })) await act({ character: m.characterId, resetWaits: true }, 'The waits are cleared.')
                  }, 'small'),
                  m.mode ? button('Suit off', () => void act({ character: m.characterId, mode: false }, `${m.name} is out of the suit.`), 'small') : null,
                  button('Leave job', async () => {
                    if (await confirmDialog({ title: 'Leave the job', message: `${m.name} leaves the job (${JOB_NAMES[m.job]}): the job level and job EXP are gone (no wait).`, confirm: 'Leave', danger: true })) await act({ character: m.characterId, leave: true }, `${m.name} left the job.`)
                  }, 'small'),
                ),
              )
            }),
          ),
    )
  }
  for (const el of [jobSel, lvSel, sideSel]) el.addEventListener('change', draw)
  search.addEventListener('input', draw)
  const add = button('Add a member…', async () => {
    const r = await formDialog({
      title: 'Give a character a job',
      intro: 'No checks but one job per character (as GM `job <name> join`); the account takes that job’s side.',
      fields: [
        { name: 'character', label: 'Character name', required: true, maxlength: 32 },
        { name: 'job', label: 'Job', type: 'select', value: 'trader', options: JOB_IDS.map((j) => ({ value: j, label: JOB_NAMES[j] })) },
      ],
      submit: 'Add',
    })
    if (r) await act({ character: String(r.character), join: String(r.job) }, `${String(r.character)} joined.`)
  }, 'small')
  const accounts = v.accounts
  root.append(
    card(
      cardHead(`Members (${v.members.length})`, add),
      h('div', { class: 'toolbar' }, h('div', { class: 'search' }, svgIcon('search', 'svg-icon search-icon'), search), jobSel, lvSel, sideSel),
      list,
    ),
    card(
      `Accounts on a side (${accounts.length})`,
      accounts.length
        ? table(
            ['Account', 'Side', 'Side since', 'Last left a job'],
            accounts.map((a) => h('tr', null, h('td', { class: 'num' }, `#${a.accountId}`), h('td', null, badge(a.side, a.side === 'law' ? 'info' : 'bad')), h('td', null, a.sideChangedAt ? fmtTime(a.sideChangedAt) : 'waits cleared'), h('td', null, a.leftAt ? fmtTime(a.leftAt) : '—'))),
          )
        : emptyState('No account has a side yet.', 'inbox'),
    ),
  )
  draw()
}

// ---- market -------------------------------------------------------------------------------------------------------------------------

function marketTab(root: HTMLElement, v: AdminJobsView, reload: () => Promise<void>, state: { post: string; kind: string }): void {
  const m = v.market
  if (!m) return void root.append(emptyState('No market on this server.', 'inbox'))
  const s = v.settings.effective
  const posts = v.content.posts
  const postSel = h('select', { class: 'input', 'aria-label': 'Trade point' }, posts.map((p) => h('option', { value: p.id }, `${p.name} (danger ${p.danger})`)))
  postSel.value = state.post || posts[0]?.id || 'jangan'
  const grid = h('div')
  const cellOf = (pid: string, good: string) => m.rows.find((r) => r.post === pid && r.good === good) ?? { post: pid, good, demand: 1, buyMul: 1 }
  const edit = async (pid: string, good: string) => {
    const c = cellOf(pid, good)
    const isSource = JOBS_CONTENT.goods.find((g) => g.code === good)?.origin === pid
    const r = await formDialog({
      title: `${goodName(good)} at ${posts.find((p) => p.id === pid)?.name ?? pid}`,
      intro: 'Overrides the figure now; it drifts back toward 1.00 from here at the recovery rate.',
      fields: [
        { name: 'demand', label: `Demand (${s.drift.floor}–${s.trade.newsDemand > 1 ? 3 : 1})`, type: 'number', value: c.demand, min: 0.1, max: 3, step: 'any', required: true },
        ...(isSource ? [{ name: 'buyMul', label: `Buy price × (1–${s.drift.cap})`, type: 'number' as const, value: c.buyMul, min: 0.5, max: 5, step: 'any' as const, required: true }] : []),
      ],
      submit: 'Set',
    })
    if (!r) return
    const body: Record<string, unknown> = { post: pid, good, demand: Number(r.demand) }
    if (isSource) body.buyMul = Number(r.buyMul)
    if (await attempt(() => post('jobs/market', body), 'Price set.')) await reload()
  }
  const draw = () => {
    state.post = postSel.value
    const at = posts.find((p) => p.id === state.post)
    if (!at) return
    clear(
      grid,
      table(
        ['Good', 'From', 'Base', 'Demand here', 'Sells here for', 'Buy price at source', ''],
        JOBS_CONTENT.goods.map((g) => {
          const c = cellOf(at.id, g.code)
          const src = cellOf(g.origin, g.code)
          const from = posts.find((p) => p.id === g.origin)
          const news = m.news && m.news.post === at.id && m.news.good === g.code
          const ev = v.event?.running && v.event.running.post === at.id ? s.event.demand : 1
          const sell = g.origin === at.id ? tradeSellPrice(g.base, null, 1, s.trade.taxPct, c.buyMul) : from ? tradeSellPrice(g.base, tradeMargin(from, at, s.trade), c.demand * (news ? s.trade.newsDemand : 1) * ev, s.trade.taxPct) : 0
          return h(
            'tr',
            null,
            h('td', null, h('strong', null, g.name), news ? [' ', badge('news', 'gold')] : null, ev > 1 && g.origin !== at.id ? [' ', badge('caravan', 'gold')] : null),
            h('td', null, from?.name ?? g.origin),
            h('td', { class: 'num' }, fmtNum(g.base)),
            h('td', { class: 'num' }, g.origin === at.id ? h('span', { class: 'dim' }, 'source') : drift(c.demand, true)),
            h('td', { class: 'num' }, fmtNum(sell), g.origin !== at.id ? h('div', { class: 'dim small' }, `${(((sell / g.base) - 1) * 100).toFixed(1)} % on base`) : h('div', { class: 'dim small' }, '0.9 × buy')),
            h('td', { class: 'num' }, fmtNum(tradeBuyPrice(g.base, src.buyMul)), ' ', drift(src.buyMul, false)),
            h('td', { class: 'row-actions' }, button('Set…', () => void edit(at.id, g.code), 'small')),
          )
        }),
      ),
    )
  }
  postSel.addEventListener('change', draw)
  draw()
  const kinds = [...new Set((v.trades ?? []).map((t) => t.kind))].sort()
  const kindSel = h('select', { class: 'input', 'aria-label': 'Kind' }, h('option', { value: '' }, 'Every kind'), kinds.map((k) => h('option', { value: k }, k)))
  kindSel.value = state.kind
  const trades = h('div')
  const drawTrades = () => {
    state.kind = kindSel.value
    const rows = (v.trades ?? []).filter((t) => !state.kind || t.kind === state.kind).slice(0, 100)
    clear(
      trades,
      rows.length
        ? table(
            ['When', 'Character', 'Kind', 'Where', 'Good', 'Crates', 'Gold', 'Stars'],
            rows.map((t) => h('tr', null, h('td', null, fmtTime(t.at)), h('td', null, t.name), h('td', null, badge(t.kind, TRADE_KIND[t.kind] ?? 'dim')), h('td', null, posts.find((p) => p.id === t.post)?.name ?? t.post ?? '—'), h('td', null, goodName(t.good)), h('td', { class: 'num' }, t.crates ? fmtNum(t.crates) : '—'), h('td', { class: 'num' }, fmtNum(t.gold)), h('td', null, t.stars ? '★'.repeat(t.stars) : '—'))),
          )
        : emptyState('No trades yet.', 'inbox'),
    )
  }
  kindSel.addEventListener('change', drawTrades)
  drawTrades()
  const moved = m.rows.filter((r) => Math.abs(r.demand - 1) > 0.0005 || Math.abs(r.buyMul - 1) > 0.0005).length
  root.append(
    card(
      cardHead(
        'Prices now',
        button('Reset every price…', async () => {
          if (await confirmDialog({ title: 'Reset the market', message: 'Every demand and buy multiplier goes back to 1.00 at every post.', confirm: 'Reset', danger: true })) {
            if (await attempt(() => post('jobs/market', { reset: true }), 'The market is back to normal.')) await reload()
          }
        }, 'small'),
      ),
      kv([
        ['Drifted figures', `${moved} of ${m.rows.length}`],
        ["Today's news", m.news ? `${goodName(m.news.good)} sells well at ${posts.find((p) => p.id === m.news!.post)?.name ?? m.news.post} (×${s.trade.newsDemand})` : 'none'],
        ['Tax', `${s.trade.taxPct} %`],
      ]),
      h('div', { class: 'toolbar' }, h('label', { class: 'dim small' }, 'Trade point '), postSel),
      grid,
    ),
    card(cardHead('Latest trades', kindSel), trades),
  )
}


// ---- transports ---------------------------------------------------------------------------------------------------------------------

function islandPlan(v: AdminJobsView): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string) => {
    const e = document.createElementNS(NS, tag)
    for (const [k, x] of Object.entries(attrs)) e.setAttribute(k, String(x))
    if (text) e.textContent = text
    return e
  }
  const posts = v.content.posts
  const pts = [...posts.map((p) => ({ x: p.x, z: p.z })), ...(v.transports ?? []).map((t) => ({ x: t.x, z: t.z }))]
  const x0 = Math.min(...pts.map((p) => p.x)) - 420
  const x1 = Math.max(...pts.map((p) => p.x)) + 420
  const z0 = Math.min(...pts.map((p) => p.z)) - 260
  const z1 = Math.max(...pts.map((p) => p.z)) + 200
  const svg = el('svg', { viewBox: `${x0} ${z0} ${x1 - x0} ${z1 - z0}`, class: 'jobs-plan', role: 'img', 'aria-label': 'The island: trade posts and transports' })
  svg.append(el('rect', { x: x0, y: z0, width: x1 - x0, height: z1 - z0, class: 'jobs-plan-sea' }))
  const jangan = posts.find((p) => p.id === 'jangan')
  const k = (x1 - x0) / 900
  for (const p of posts) {
    if (jangan && p.id !== 'jangan') svg.append(el('line', { x1: jangan.x, y1: jangan.z, x2: p.x, y2: p.z, class: 'jobs-plan-road', 'stroke-width': 4 * k }))
  }
  const boosted = v.event?.running?.post
  for (const p of posts) {
    svg.append(el('circle', { cx: p.x, cy: p.z, r: (p.id === 'jangan' ? 16 : 12) * k, class: p.id === boosted ? 'jobs-plan-post boosted' : 'jobs-plan-post' }))
    svg.append(el('text', { x: p.x, y: p.z - 22 * k, 'font-size': 26 * k, class: 'jobs-plan-label', 'text-anchor': 'middle' }, `${p.name}${p.id === 'jangan' ? '' : ` · ${p.danger}`}`))
  }
  for (const t of v.transports ?? []) {
    const g = el('g', { class: t.live ? 'jobs-plan-cart' : 'jobs-plan-cart saved' })
    g.append(el('rect', { x: t.x - 9 * k, y: t.z - 9 * k, width: 18 * k, height: 18 * k, transform: `rotate(45 ${t.x} ${t.z})` }))
    g.append(el('text', { x: t.x + 14 * k, y: t.z + 8 * k, 'font-size': 22 * k, class: 'jobs-plan-label' }, `${t.name}${t.stars ? ` ${'★'.repeat(t.stars)}` : ''}`))
    const title = el('title', {}, `${t.name}: ${t.hp}/${t.maxHp} HP, ${t.crates} crates${t.dest ? ` to ${t.dest}` : ''}${t.live ? '' : ' (saved, offline)'}`)
    g.append(title)
    svg.append(g)
  }
  return svg
}

function transportsTab(root: HTMLElement, v: AdminJobsView, reload: () => Promise<void>): void {
  const list = v.transports ?? []
  const act = async (name: string, action: 'heal' | 'kill' | 'dismiss') => {
    const ok =
      action === 'heal' ||
      (await confirmDialog({
        title: action === 'kill' ? 'Kill the transport' : 'Dismiss the transport',
        message: action === 'kill' ? `${name}'s transport dies: its goods drop as bags (${v.settings.effective.thief.dropPct} %).` : `${name}'s transport is dismissed (refused while loaded).`,
        confirm: action === 'kill' ? 'Kill' : 'Dismiss',
        danger: action === 'kill',
      }))
    if (ok && (await attempt(() => post('jobs/transport', { character: name, action }), undefined))) await reload()
  }
  const posts = v.content.posts
  root.append(
    card(
      cardHead(`Transports in the world (${list.filter((t) => t.live).length} live, ${list.filter((t) => !t.live).length} saved)`, button('Refresh', () => void reload(), 'small')),
      h('div', { class: 'jobs-plan-wrap' }, islandPlan(v)),
      h('p', { class: 'dim small' }, 'Posts with their road danger; diamonds are transports (hollow: saved while the Trader is offline); the gold post is the Silk Caravan’s.'),
      list.length
        ? table(
            ['Trader', 'Transport', 'HP', 'Load', 'Stars', 'Going to', 'Where', ''],
            list.map((t) =>
              h(
                'tr',
                null,
                h('td', null, h('strong', null, t.name), ' ', t.live ? badge('live', 'ok') : badge('saved', 'dim')),
                h('td', null, JOBS_CONTENT.transports.find((x) => x.tier === t.tier)?.name ?? `tier ${t.tier}`),
                h('td', null, h('div', { class: 'jobs-hp' }, h('div', { class: 'jobs-hp-fill', style: `width:${Math.round((100 * t.hp) / Math.max(1, t.maxHp))}%` })), h('div', { class: 'dim small' }, `${fmtNum(t.hp)} / ${fmtNum(t.maxHp)}`)),
                h('td', { class: 'num' }, `${t.crates} crates`, h('div', { class: 'dim small' }, `${fmtNum(t.value)} gold`)),
                h('td', null, t.stars ? '★'.repeat(t.stars) : '—'),
                h('td', null, posts.find((p) => p.id === t.dest)?.name ?? '—'),
                h('td', { class: 'mono small' }, `${Math.round(t.x)}, ${Math.round(t.z)}`),
                h('td', { class: 'row-actions' }, t.live ? [button('Heal', () => void act(t.name, 'heal'), 'small'), button('Kill', () => void act(t.name, 'kill'), 'small'), button('Dismiss', () => void act(t.name, 'dismiss'), 'small')] : null),
              ),
            ),
          )
        : emptyState('No transport on the roads.', 'inbox'),
    ),
  )
}

// ---- robbery & law ------------------------------------------------------------------------------------------------------------------

function robberyTab(root: HTMLElement, v: AdminJobsView, reload: () => Promise<void>): void {
  const now = Date.now()
  const act = async (path: string, body: Record<string, unknown>, done: string) => {
    if (await attempt(() => post(path, body), done)) await reload()
  }
  const jail = async (name: string) => {
    const r = await formDialog({
      title: `Jail ${name}`,
      intro: 'Puts the character in the Garrison Stockade now (online: warped in; offline: at the next login).',
      fields: [{ name: 'minutes', label: 'Minutes', type: 'number', value: v.settings.effective.robbery.sentencesMin[0], min: 1, max: 10_080, required: true }],
      submit: 'Jail',
      danger: true,
    })
    if (r) await act('jobs/robbery', { character: name, action: 'jail', minutes: Number(r.minutes) }, `${name} is jailed.`)
  }
  const confiscate = async (name: string) => {
    if (await confirmDialog({ title: 'Confiscate', message: `Take every good ${name} carries (stolen, recovered, own) and close the robbery warrant (pardoned).`, confirm: 'Confiscate', danger: true })) await act('jobs/robbery', { character: name, action: 'clear' }, `${name}'s goods are confiscated.`)
  }
  const members = new Map(v.members.map((m) => [m.characterId, m]))
  const revoke = async (id: number, name: string) => {
    const m = members.get(id)
    if (!m) return toast(`${name} holds no job.`, 'info')
    if (m.revokedUntil) return toast(`${name}'s licence is revoked already.`, 'info')
    if (await confirmDialog({ title: 'Revoke the licence', message: `Take ${name}'s ${JOB_NAMES[m.job]} licence away (${m.job === 'hunter' ? "the siege's revoke days" : '7 days'}); the suit comes off.`, confirm: 'Revoke', danger: true })) await act('jobs/member', { character: id, revoke: 7 }, `${name}'s licence is revoked.`)
  }
  const robbers = v.robbers ?? []
  const sacks = v.sacks ?? []
  const flags = v.flags ?? []
  const log = v.robberies ?? []
  const counts = new Map<string, number>()
  for (const f of flags) counts.set(`${f.actorAccount}:${f.victimAccount}`, (counts.get(`${f.actorAccount}:${f.victimAccount}`) ?? 0) + 1)
  root.append(
    card(
      cardHead(`Robbery warrants (${robbers.length})`, button('Refresh', () => void reload(), 'small')),
      robbers.length
        ? table(
            ['Robber', 'Bounty', 'Lapses after (online)', 'Issued', ''],
            robbers.map((r) => h('tr', null, h('td', null, h('strong', null, r.name), ' ', r.online ? badge('online', 'ok') : badge('offline', 'dim')), h('td', { class: 'num' }, fmtNum(r.bounty)), h('td', null, fmtDuration(r.onlineLeftMs)), h('td', null, fmtAgo(r.issuedAt, now)), h('td', { class: 'row-actions' }, button('Jail…', () => void jail(r.name), 'small'), button('Confiscate', () => void confiscate(r.name), 'small')))),
          )
        : emptyState('No open robbery warrant.', 'inbox'),
    ),
    card(
      `Goods carried outside transports (${sacks.length})`,
      sacks.length
        ? table(
            ['Carrier', 'Kind', 'Good', 'Crates', 'Robbed from', 'Worth', ''],
            sacks.map((s) => h('tr', null, h('td', null, s.name), h('td', null, badge(s.kind, s.kind === 'stolen' ? 'bad' : s.kind === 'recovered' ? 'info' : 'dim')), h('td', null, goodName(s.good)), h('td', { class: 'num' }, fmtNum(s.crates)), h('td', null, s.owner), h('td', { class: 'num' }, fmtNum(s.value)), h('td', { class: 'row-actions' }, button('Confiscate', () => void confiscate(s.name), 'small')))),
          )
        : emptyState('Nobody carries goods outside a transport.', 'inbox'),
    ),
    card(
      `Suspected collusion: withheld job rewards (${flags.length})`,
      h('p', { class: 'dim small' }, 'Every job reward an anti-collusion rule refused (pair rule, contacts, same IP). The same two accounts again and again are friends farming each other.'),
      flags.length
        ? table(
            ['When', 'Who', 'Against', 'Rule', 'Withheld', 'Pair count', ''],
            flags.slice(0, 100).map((f) =>
              h(
                'tr',
                null,
                h('td', null, fmtTime(f.at)),
                h('td', null, f.actor, h('span', { class: 'dim small' }, ` (#${f.actorAccount ?? '?'})`)),
                h('td', null, f.victim, h('span', { class: 'dim small' }, ` (#${f.victimAccount})`)),
                h('td', null, badge(RULE_TEXT[f.rule] ?? f.rule, 'bad')),
                h('td', { class: 'num' }, fmtNum(f.withheld)),
                h('td', { class: 'num' }, String(counts.get(`${f.actorAccount}:${f.victimAccount}`) ?? 1)),
                h('td', { class: 'row-actions' }, button('Revoke…', () => void revoke(f.actorId, f.actor), 'small'), button('Jail…', () => void jail(f.actor), 'small')),
              ),
            ),
          )
        : emptyState('No job reward was withheld.', 'inbox'),
    ),
    card(
      'Robbery log',
      log.length
        ? table(
            ['When', 'What', 'Actor', 'Victim', 'Robbery #'],
            log.slice(0, 100).map((r) => h('tr', null, h('td', null, fmtTime(r.at)), h('td', null, badge(r.kind === 'rob' ? 'goods picked' : 'Thief killed', r.kind === 'rob' ? 'bad' : 'info')), h('td', null, r.actor, h('span', { class: 'dim small' }, ` (#${r.actorAccount ?? '?'})`)), h('td', null, r.victim, h('span', { class: 'dim small' }, ` (#${r.victimAccount ?? '?'})`)), h('td', { class: 'num' }, r.batch ? String(r.batch) : '—'))),
          )
        : emptyState('No robberies yet.', 'inbox'),
    ),
  )
}

// ---- the Silk Caravan ---------------------------------------------------------------------------------------------------------------

function caravanPanel(root: HTMLElement, v: AdminJobsView, reload: () => Promise<void>): void {
  const c: CaravanView | undefined = v.event
  if (!c) return void root.append(emptyState('The Silk Caravan is not on this server.', 'inbox'))
  const s = v.settings.effective.event
  const posts = v.content.posts
  const postName = (id: string | null) => posts.find((p) => p.id === id)?.name ?? id ?? '—'
  const start = async () => {
    const r = await formDialog({
      title: 'Start a Silk Caravan now',
      intro: 'Every player sees the announcement. Refused during a siege or a Night of the Tiger.',
      fields: [
        { name: 'minutes', label: 'Minutes', type: 'number', value: s.durationMin, min: 1, max: 600, required: true },
        { name: 'post', label: 'Boosted post', type: 'select', value: '', options: [{ value: '', label: `Random far post (${c.posts.map(postName).join(' / ')})` }, ...posts.filter((p) => p.id !== 'jangan').map((p) => ({ value: p.id, label: p.name }))] },
      ],
      submit: 'Start',
      danger: true,
    })
    if (r && (await attempt(() => post('jobs/event/start', { minutes: Number(r.minutes), ...(r.post ? { post: String(r.post) } : {}) }), 'The Silk Caravan sets out.'))) await reload()
  }
  const stop = async () => {
    if (await confirmDialog({ title: 'Stop the Silk Caravan', message: 'Prices and multipliers return to normal now; rewards already paid stay paid.', confirm: 'Stop', danger: true })) {
      if (await attempt(() => post('jobs/event/stop', {}), 'The Silk Caravan is stopped.')) await reload()
    }
  }
  const run = c.running
  const now = Date.now()
  const nowCard = card(
    cardHead('Now', run ? button('Stop…', () => void stop(), 'danger') : button('Start now…', () => void start(), 'primary')),
    run
      ? kv([
          ['State', badge('running', 'bad')],
          ['Boosted post', `${postName(run.post)} (demand ×${s.demand})`],
          ['Ends', `${fmtTime(run.endsAt)} (in ${fmtDuration(Math.max(0, run.endsAt - now))})`],
          ['Started by', run.origin],
          ['Runs completed', `${run.runs} (${fmtNum(run.rewarded)} gold rewarded)`],
        ])
      : kv([
          ['State', badge(c.nextAt ? 'scheduled' : 'idle', c.nextAt ? 'info' : 'dim')],
          ['Next', c.nextAt ? `${zoneTime(c.nextAt, c.zone)} (${fmtAgo(c.nextAt)})` : s.enabled ? 'no slot set' : 'the weekly event is off'],
          ['Waiting', c.waitUntil ? `for a siege / Night of the Tiger until ${fmtTime(c.waitUntil)}` : '—'],
        ]),
    h('p', { class: 'dim small' }, `While it runs: one far post pays demand ×${s.demand}; Trader job EXP ×${s.expMul}; escorts ×${s.escortMul}; ambushes ×${s.ambushMul}; the den ×${s.denMul}; ${fmtNum(s.rewardGold)} gold per completed run (up to ${s.rewardRuns} per character).`),
  )
  // the schedule
  const enabled = h('input', { type: 'checkbox', checked: s.enabled, 'aria-label': 'Weekly Silk Caravan on' })
  const onText = h('span', { class: 'switch-text' }, s.enabled ? 'On' : 'Off')
  enabled.addEventListener('change', () => (onText.textContent = enabled.checked ? 'On' : 'Off'))
  const list = h('div', { class: 'stack' })
  const slots: { weekday: HTMLSelectElement; time: HTMLInputElement; row: HTMLElement }[] = []
  const add = button('Add a slot', () => addRow(6, '20:00'), 'small')
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
  for (const sl of s.slots) addRow(sl.weekday, sl.time)
  const tz = h('input', { class: 'input', type: 'text', value: s.tz, placeholder: `server zone (${c.zone})`, 'aria-label': 'Time zone', maxlength: 64 })
  const error = h('div', { class: 'form-error', role: 'alert' })
  const save = button('Save the schedule', async () => {
    error.textContent = ''
    const out = slots.map((x) => ({ weekday: Number(x.weekday.value), time: x.time.value }))
    if (out.some((x) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(x.time))) return void (error.textContent = 'Every slot needs a time (HH:MM).')
    try {
      await put('jobs/settings', { baseRev: v.settings.rev, patch: { event: { enabled: enabled.checked, slots: out, tz: tz.value.trim() } } })
      toast('Schedule saved.')
      await reload()
    } catch (e) {
      error.textContent = errorText(e)
      if (e instanceof AdminApiError && e.status === 409) await reload()
    }
  }, 'primary')
  const schedCard = card(
    'The weekly schedule',
    h('p', { class: 'dim' }, `Off by default. At each slot the event starts for ${s.durationMin} min with an announcement to every player. A slot due during a siege or a Night of the Tiger waits up to ${s.busyWaitMin} min, then is skipped. GM \`caravan start|stop|status\` and Start here work on or off.`),
    h('div', { class: 'setting-control' }, h('label', { class: 'switch' }, enabled, h('span', { class: 'switch-track' }), onText)),
    h('h4', null, 'Slots'),
    list,
    h('div', { class: 'actions' }, add),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Time zone'), tz, h('span', { class: 'field-hint' }, `Empty = the server's zone (${c.zone}).`)),
    error,
    h('div', { class: 'actions end' }, save),
  )
  const hist = card(
    'Past events',
    c.history.length
      ? table(
          ['#', 'Started', 'Ended', 'Outcome', 'Post', 'By', 'Runs', 'Rewarded'],
          c.history.map((e) => h('tr', null, h('td', { class: 'num' }, String(e.id)), h('td', null, fmtTime(e.at)), h('td', null, e.endedAt ? fmtTime(e.endedAt) : '—'), h('td', null, badge(e.outcome, e.outcome === 'running' ? 'bad' : e.outcome === 'ended' ? 'gold' : 'dim'), e.why ? h('div', { class: 'dim small' }, e.why) : null), h('td', null, postName(e.post)), h('td', null, e.origin), h('td', { class: 'num' }, String(e.runs)), h('td', { class: 'num' }, fmtNum(e.rewarded)))),
        )
      : emptyState('No Silk Caravan yet.', 'inbox'),
  )
  root.append(nowCard, schedCard, settingsForm(v, [{ title: 'The event’s numbers', about: 'They apply at once, to a running event too.', fields: EVENT_FIELDS }], reload, ''), hist)
}

// ---- the page --------------------------------------------------------------------------------------------------------------------

export function jobsPage(root: HTMLElement): () => void {
  const status = h('div')
  const body = h('div')
  let latest: AdminJobsView | null = null
  let tab = 'members'
  let stopped = false
  const members = { job: '', level: '', side: '', q: '' }
  const market = { post: 'jangan', kind: '' }
  const reload = async () => {
    try {
      const v = await get<AdminJobsView>('jobs')
      if (stopped) return
      latest = v
      render()
    } catch (e) {
      if (!stopped) clear(body, emptyState(errorText(e), 'alert', true))
    }
  }
  const render = () => {
    const v = latest
    if (!v) return
    const run = v.event?.running
    clear(
      status,
      h(
        'div',
        { class: 'jobs-stats' },
        JOB_IDS.map((j) => h('div', { class: 'jobs-stat' }, h('div', { class: 'jobs-stat-n' }, fmtNum(v.counts[j])), h('div', { class: 'dim small' }, PLURAL[j]))),
        h('div', { class: 'jobs-stat' }, h('div', { class: 'jobs-stat-n' }, fmtNum((v.transports ?? []).filter((t) => t.live).length)), h('div', { class: 'dim small' }, 'transports out')),
        h('div', { class: 'jobs-stat' }, h('div', { class: 'jobs-stat-n' }, fmtNum((v.robbers ?? []).length)), h('div', { class: 'dim small' }, 'robbers wanted')),
        h('div', { class: 'jobs-stat' }, h('div', { class: 'jobs-stat-n' }, run ? badge('running', 'bad') : v.event?.nextAt ? badge('scheduled', 'info') : badge('off', 'dim')), h('div', { class: 'dim small' }, 'Silk Caravan')),
        v.enabled ? null : h('div', { class: 'jobs-stat' }, badge('jobs off', 'bad'), h('div', { class: 'dim small' }, 'jobs.enabled')),
      ),
    )
    clear(
      body,
      tabs(
        [
          { id: 'members', label: `Members (${v.members.length})`, render: (r) => ((tab = 'members'), membersTab(r, v, reload, members)) },
          { id: 'market', label: 'Market', render: (r) => ((tab = 'market'), marketTab(r, v, reload, market)) },
          { id: 'transports', label: `Transports (${(v.transports ?? []).length})`, render: (r) => ((tab = 'transports'), transportsTab(r, v, reload)) },
          { id: 'robbery', label: 'Robbery & law', render: (r) => ((tab = 'robbery'), robberyTab(r, v, reload)) },
          {
            id: 'settings',
            label: 'Settings',
            render: (r) => (
              (tab = 'settings'),
              r.append(
                settingsForm(
                  v,
                  GROUPS,
                  reload,
                  `Stored on this server (rev ${v.settings.rev}) over the built-in defaults; they apply at once. Content: ${v.content.source}.`,
                  card(
                    'The job system',
                    h(
                      'div',
                      { class: 'setting-control' },
                      (() => {
                        const box = h('input', { type: 'checkbox', checked: v.settings.effective.jobs.enabled, 'aria-label': 'Jobs on' })
                        box.addEventListener('change', async () => {
                          if (!box.checked && !(await confirmDialog({ title: 'Turn the jobs off', message: 'No joining, no suits and no job PvP (the Bounty Hunters keep the siege law). Members keep their jobs.', confirm: 'Turn off', danger: true }))) {
                            box.checked = true
                            return
                          }
                          if (await attempt(() => put('jobs/settings', { baseRev: v.settings.rev, patch: { jobs: { enabled: box.checked } } }), box.checked ? 'Jobs are on.' : 'Jobs are off.')) await reload()
                        })
                        return h('label', { class: 'switch' }, box, h('span', { class: 'switch-track' }), h('span', { class: 'switch-text' }, v.settings.effective.jobs.enabled ? 'Jobs on' : 'Jobs off'))
                      })(),
                    ),
                  ),
                ),
              )
            ),
          },
          { id: 'caravan', label: 'Silk Caravan', render: (r) => ((tab = 'caravan'), caravanPanel(r, v, reload)) },
        ],
        tab,
      ),
    )
  }
  root.append(pageHeader({ text: 'Jobs & Trade', icon: svgIcon('swap') }, 'Traders, Bounty Hunters and Thieves; the market, the transports on the roads, robberies and the Silk Caravan.', button('Refresh', () => void reload())), status, body)
  void reload()
  return () => {
    stopped = true
  }
}

/** The Events page's sub-page for the Silk Caravan (routes `jobs`). */
function caravanEventPage(root: HTMLElement, _e: AdminEventInfo): () => void {
  let stopped = false
  const reload = async () => {
    try {
      const v = await get<AdminJobsView>('jobs')
      if (!stopped) {
        root.replaceChildren()
        caravanPanel(root, v, reload)
      }
    } catch (e) {
      if (!stopped) clear(root, emptyState(errorText(e), 'alert', true))
    }
  }
  void reload()
  return () => {
    stopped = true
  }
}

EVENT_PAGES.set('jobs', caravanEventPage)
