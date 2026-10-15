import type { AdminMaintenanceView } from '@sro/shared'
import { get, post } from '../api.ts'
import { attempt, badge, button, clear, confirmDialog, errorText, fmtTime, formDialog, h, kv, toast } from '../ui.ts'

/**
 * The dashboard's Maintenance card (docs/ADMIN.md §8; server: admin/maintenance-admin.ts, maintenance.ts): the state
 * (off / counting down with the time left / on since when, by whom), Start (a countdown preset or custom minutes, or
 * now; an optional message and expected duration shown to players), Cancel the countdown and End maintenance. The
 * server writes the audit rows; this card only asks.
 */

/** 4:59 / 1:02:03. */
function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

export function maintenanceCard(): { node: HTMLElement; refresh: () => Promise<void>; dispose: () => void } {
  const node = h('div', null, h('p', { class: 'dim' }, 'Loading…'))
  let view: AdminMaintenanceView | null = null
  /** server clock - local clock, from the last answer */
  let offset = 0
  let left: HTMLElement | null = null

  const refresh = async () => {
    try {
      const v = await get<AdminMaintenanceView>('maintenance')
      offset = v.now - Date.now()
      view = v
      render()
    } catch (e) {
      clear(node, h('p', { class: 'dim' }, `Maintenance mode is not available: ${errorText(e)}`))
    }
  }

  const tick = () => {
    if (left && view?.deadline) left.textContent = clock(view.deadline - (Date.now() + offset))
  }
  const timer = setInterval(tick, 1000)

  const render = () => {
    const v = view!
    left = null
    const by = v.by ? `${v.by}${v.via === 'gm' ? ' (GM command)' : v.via === 'panel' ? ' (panel)' : ''}` : '–'
    const rows: [string, Node | string | (Node | string)[]][] = []
    if (v.state === 'off') {
      rows.push(['State', [badge('off', 'ok'), ' Everyone may log in.']])
    } else if (v.state === 'countdown') {
      left = h('strong', null, clock(v.deadline! - (Date.now() + offset)))
      rows.push(['State', [badge('counting down', 'gold'), ' everyone is disconnected in ', left]])
      rows.push(['Started', `${fmtTime(v.startedAt)} by ${by}`])
    } else {
      rows.push(['State', [badge('ON', 'bad'), ' only admins and GMs may log in']])
      rows.push(['Since', `${fmtTime(v.since)} by ${by}`])
    }
    if (v.state !== 'off') {
      rows.push(['Message', v.reason || h('span', { class: 'dim' }, 'none')])
      rows.push(['Expected back', v.backAt ? `${fmtTime(v.backAt)} (about ${v.durationMin} min of downtime)` : h('span', { class: 'dim' }, 'not given')])
    }
    rows.push(['Connected', `${v.players} player(s) · ${v.staff} staff`])
    const actions: HTMLElement[] = []
    if (v.state === 'off') actions.push(button('Start maintenance…', () => void start(v), 'danger'))
    if (v.state === 'countdown') actions.push(button('Cancel countdown', () => void cancel()))
    if (v.state === 'on') actions.push(button('End maintenance…', () => void end(), 'primary'))
    clear(node, kv(rows), h('div', { class: 'actions' }, ...actions))
  }

  const start = async (v: AdminMaintenanceView) => {
    const values = await formDialog({
      title: 'Start maintenance',
      intro: 'Everyone hears a countdown (centre screen and chat) and sees a banner. At zero every player is saved and sent back to the login screen; until you end maintenance only admins and GMs can log in.',
      fields: [
        {
          name: 'preset', label: 'Countdown', type: 'select', value: '10',
          options: [...v.presetsMin.map((m) => ({ value: String(m), label: m === 0 ? 'Now (no countdown)' : `${m} minute${m === 1 ? '' : 's'}` })), { value: 'custom', label: 'Custom…' }],
        },
        { name: 'custom', label: 'Custom countdown (minutes)', type: 'number', min: 0, max: v.limits.countdownMaxMin, step: 1, hint: 'Used when the countdown is Custom.' },
        { name: 'reason', label: 'Message to players (optional)', maxlength: v.limits.reasonMax, placeholder: 'Installing the winter update' },
        { name: 'duration', label: 'Expected downtime in minutes (optional)', type: 'number', min: 0, max: v.limits.durationMaxMin, step: 1, hint: 'Shown as "back in about N minutes".' },
      ],
      submit: 'Start',
      danger: true,
    })
    if (!values) return
    const minutes = values.preset === 'custom' ? Number(values.custom) : Number(values.preset)
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > v.limits.countdownMaxMin) return toast(`The countdown is 0 to ${v.limits.countdownMaxMin} whole minutes.`, 'error')
    const durationMin = values.duration === '' || values.duration === undefined ? 0 : Number(values.duration)
    const reason = String(values.reason ?? '').trim()
    if (minutes === 0 && !(await confirmDialog({ title: 'Maintenance now', message: `${v.players} player connection(s) are disconnected right away. Continue?`, confirm: 'Start now', danger: true }))) return
    const r = await attempt(() => post<{ message: string }>('maintenance/start', { minutes, durationMin, ...(reason ? { reason } : {}) }))
    if (r) {
      toast(r.message)
      void refresh()
    }
  }

  const cancel = async () => {
    if (!(await confirmDialog({ title: 'Cancel the countdown', message: 'Everyone is told the maintenance was cancelled.', confirm: 'Cancel countdown' }))) return
    const r = await attempt(() => post<{ message: string }>('maintenance/cancel', {}))
    if (r) {
      toast(r.message)
      void refresh()
    }
  }

  const end = async () => {
    const values = await formDialog({
      title: 'End maintenance',
      intro: 'The server is online again and players can log in.',
      fields: [{ name: 'announce', label: 'Tell everyone online "Maintenance is over"', type: 'checkbox', value: true }],
      submit: 'End maintenance',
    })
    if (!values) return
    const r = await attempt(() => post<{ message: string }>('maintenance/end', { silent: values.announce !== true }))
    if (r) {
      toast(r.message)
      void refresh()
    }
  }

  return { node, refresh, dispose: () => clearInterval(timer) }
}
