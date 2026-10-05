import type { AdminAuditRow, AdminGmAuditRow, AdminPage } from '@sro/shared'
import { get, qs } from '../api.ts'
import { badge, card, dataTable, fmtTime, h, pageHeader, tabs } from '../ui.ts'

/** The audit logs: every admin action (with before / after) and the GM commands (gm_audit). */
export function auditPage(root: HTMLElement): void {
  root.append(
    pageHeader('Audit log', 'Who did what, when; the newest first.'),
    tabs([
      { id: 'admin', label: 'Admin panel', render: adminTab },
      { id: 'gm', label: 'GM commands', render: gmTab },
    ]),
  )
}

function json(v: unknown): HTMLElement | string {
  if (v === null || v === undefined) return ''
  const s = JSON.stringify(v)
  return h('code', { class: 'json-inline', title: s }, s.length > 160 ? `${s.slice(0, 160)}…` : s)
}

function adminTab(root: HTMLElement): void {
  const action = h('select', { class: 'input', 'aria-label': 'Action' }, [
    ['', 'Every action'], ['login', 'Logins'], ['account', 'Accounts'], ['character', 'Characters'], ['storage', 'Storage'], ['settings', 'Settings'],
    ['item', 'Items'], ['drop', 'Drops'], ['nest', 'Spawns'], ['npc', 'NPCs'], ['quest', 'Quests'], ['unique', 'Uniques'], ['notice', 'Notices'], ['player', 'Players'], ['server', 'Server'],
  ].map(([v, l]) => h('option', { value: v }, l)))
  const table = dataTable<AdminAuditRow>({
    placeholder: 'Search by admin, target or detail',
    filters: [action],
    load: (q, page, size) => get<AdminPage<AdminAuditRow>>(`audit${qs({ q, page, size, action: action.value })}`),
    columns: [
      { label: 'When', render: (r) => h('span', { class: 'small' }, fmtTime(r.at)) },
      { label: 'Admin', render: (r) => [r.account, r.ip ? h('div', { class: 'dim small' }, r.ip) : null] },
      { label: 'Action', primary: true, render: (r) => [h('span', { class: 'mono' }, r.action), r.ok ? null : badge('failed', 'bad')] },
      { label: 'Target', render: (r) => h('span', { class: 'mono small' }, r.target) },
      { label: 'Before', render: (r) => json(r.before) },
      { label: 'After', render: (r) => json(r.after) },
      { label: 'Detail', render: (r) => h('span', { class: 'small' }, r.detail) },
    ],
  })
  action.addEventListener('change', () => void table.reload())
  root.append(card(null, table.root))
}

function gmTab(root: HTMLElement): void {
  const table = dataTable<AdminGmAuditRow>({
    search: false,
    load: (_q, page, size) => get<AdminPage<AdminGmAuditRow>>(`gm-audit${qs({ page, size })}`),
    columns: [
      { label: 'When', render: (r) => h('span', { class: 'small' }, fmtTime(r.at)) },
      { label: 'Account', render: (r) => r.account },
      { label: 'Command', primary: true, render: (r) => [h('span', { class: 'mono' }, `${r.command} ${r.args.join(' ')}`), r.ok ? null : badge('failed', 'bad')] },
      { label: 'Result', render: (r) => h('span', { class: 'small' }, r.result.split('\n')[0]) },
    ],
  })
  root.append(card(null, table.root))
}
