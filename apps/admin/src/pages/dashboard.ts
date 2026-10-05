import { ADMIN_NOTICE_MAX, type AdminDashboard } from '@sro/shared'
import { get, post } from '../api.ts'
import { svgIcon, type IconName } from '../icons.ts'
import { attempt, badge, button, card, cardHead, clear, confirmDialog, emptyState, errorText, fmtBytes, fmtDuration, fmtNum, fmtTime, formDialog, h, kv, link, pageHeader, stackTable, toast } from '../ui.ts'

/** Server stats, live players (kick, send to town), the lobby, server details, a notice box. Refreshes every 5 s. */
export function dashboardPage(root: HTMLElement): () => void {
  const info = h('div', { class: 'stats' }, (['Online', 'Uptime', 'Server tick', 'World', 'Release', 'Database'] as const).map((l, i) => stat(STAT_ICONS[i], l, '—', 'loading…')))
  const health = h('div', null, h('p', { class: 'dim' }, 'Loading…'))
  const players = h('div', null, h('p', { class: 'dim' }, 'Loading…'))
  const count = h('span')
  const notice = noticeBox()
  root.append(
    pageHeader('Dashboard', 'The running server and who is on it.'),
    info,
    card(null, cardHead('Players in the world', count), players),
    h('div', { class: 'grid grid-2' }, card('Server', health), card('Broadcast notice', notice)),
  )
  let stopped = false
  const load = async () => {
    try {
      const d = await get<AdminDashboard>('dashboard')
      if (stopped) return
      render(d)
    } catch (e) {
      if (!stopped) clear(players, emptyState(errorText(e), 'alert', true))
    }
  }
  const render = (d: AdminDashboard) => {
    const s = d.server
    const tickOk = s.tickRate === null || s.tickRate >= s.tickHz * 0.9
    const full = s.capacity > 0 ? s.online / s.capacity : 0
    clear(
      info,
      stat('accounts', 'Online', h('span', null, fmtNum(s.online), h('span', { class: 'stat-of' }, ` / ${fmtNum(s.capacity)}`)), `players · ${s.lobby} in the lobby`, full >= 0.9 ? 'bad' : 'none', h('progress', { class: 'meter', max: Math.max(1, s.capacity), value: s.online, 'aria-label': 'Capacity used' })),
      stat('clock', 'Uptime', fmtDuration(s.uptimeS * 1000), `since ${fmtTime(s.startedAt)}`),
      stat('pulse', 'Server tick', s.tickRate === null ? `${s.tickHz} Hz` : `${s.tickRate.toFixed(1)} Hz`, `target ${s.tickHz} Hz · worst ${s.worstTickMs} ms`, tickOk ? 'ok' : 'bad'),
      stat('globe', 'World', s.name, `${s.world} · export ${s.worldExport}`),
      stat('release', 'Release', s.release, s.commit ? `commit ${s.commit.slice(0, 7)}` : 'no commit (a dev build)'),
      stat('database', 'Database', fmtBytes(s.dbBytes), `schema ${s.schema}`),
    )
    clear(
      health,
      kv([
        ['Registration', [s.registration === 'open' ? badge('open', 'ok') : badge('closed', 'bad'), ' ', link('Change in Settings', '#/settings')]],
        ['Node', s.node],
        ['Navigation', s.nav],
        ['Monsters', fmtNum(s.mobs)],
        ['Restart', s.restart ? 'available (systemd)' : 'by hand (no supervisor)'],
      ]),
      s.pendingRestart.length ? h('div', { class: 'notice warn' }, `Saved settings waiting for a restart: ${s.pendingRestart.join(', ')}.`) : null,
      s.restart ? h('div', { class: 'actions' }, button('Restart server…', () => void restart(d), 'danger')) : null,
    )
    clear(count, badge(`${d.players.length} online`, d.players.length ? 'ok' : 'dim'))
    clear(
      players,
      d.players.length === 0
        ? emptyState('Nobody is in the world.', 'users')
        : h(
            'div',
            { class: 'table-scroll' },
            stackTable(
              h(
                'table',
                { class: 'table' },
                h('thead', null, h('tr', null, h('th', null, 'Character'), h('th', null, 'Account'), h('th', { class: 'num' }, 'Level'), h('th', null, 'Where'), h('th', null, 'State'), h('th', { class: 'row-actions' }, h('span', { class: 'sr-only' }, 'Actions')))),
                h(
                  'tbody',
                  null,
                  d.players.map((p) =>
                    h(
                      'tr',
                      null,
                      h('td', null, h('a', { class: 'link strong', href: `#/characters/${p.characterId}` }, p.name), p.role !== 'player' ? badge(p.role.toUpperCase(), 'gold') : null),
                      h('td', null, h('a', { class: 'link', href: `#/accounts/${p.accountId}` }, p.account)),
                      h('td', { class: 'num' }, String(p.level)),
                      h('td', null, `${p.zone || '–'} `, h('span', { class: 'dim small' }, `${p.x}, ${p.z}`)),
                      h('td', null, p.dead ? badge('dead', 'bad') : badge('alive', 'ok'), p.invisible ? badge('invisible', 'dim') : null),
                      h('td', { class: 'row-actions' }, button('To town', () => void toTown(p.characterId, p.name), 'small'), button('Kick…', () => void kick(p.characterId, p.name), 'small')),
                    ),
                  ),
                ),
              ),
            ),
          ),
      d.lobby.length ? h('p', { class: 'dim small lobby' }, `In the lobby: ${d.lobby.map((l) => l.account).join(', ')}`) : null,
    )
  }
  const toTown = async (id: number, name: string) => {
    if (!(await confirmDialog({ title: 'Send to town', message: `Send ${name} to the town spawn now?`, confirm: 'Send to town' }))) return
    if (await attempt(() => post(`players/${id}/town`), `${name} was sent to town.`)) void load()
  }
  const kick = async (id: number, name: string) => {
    const v = await formDialog({ title: `Kick ${name}`, intro: 'The player is disconnected and sees the reason.', fields: [{ name: 'reason', label: 'Reason (optional)', maxlength: 100 }], submit: 'Kick', danger: true })
    if (!v) return
    if (await attempt(() => post(`players/${id}/kick`, { reason: String(v.reason).trim() || undefined }), `${name} was kicked.`)) void load()
  }
  const restart = async (d: AdminDashboard) => {
    const ok = await confirmDialog({
      title: 'Restart the server',
      message: `${d.server.online} player(s) are in the world. Everyone is saved and disconnected; the server is back in about 10 seconds.`,
      confirm: 'Restart now',
      danger: true,
    })
    if (!ok) return
    if (await attempt(() => post('restart'), 'Restarting… the panel reconnects by itself.')) setTimeout(() => void load(), 8000)
  }
  void load()
  const timer = setInterval(() => void load(), 5000)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

const STAT_ICONS: IconName[] = ['accounts', 'clock', 'pulse', 'globe', 'release', 'database']

/** A stat card: icon, label, value, a line under it; `kind` tints it (ok / bad). */
function stat(iconName: IconName, label: string, value: string | Node, sub: string, kind: 'ok' | 'bad' | 'none' = 'none', extra?: Node): HTMLElement {
  return h(
    'div',
    { class: `stat stat-${kind}` },
    h('div', { class: 'stat-top' }, h('div', { class: 'stat-label' }, label), h('span', { class: 'stat-icon' }, svgIcon(iconName))),
    h('div', { class: 'stat-value' }, value),
    extra ?? null,
    h('div', { class: 'stat-sub' }, sub),
  )
}

export function noticeBox(): HTMLElement {
  const text = h('textarea', { class: 'input', rows: 3, maxlength: ADMIN_NOTICE_MAX, placeholder: 'Server maintenance in 10 minutes…', 'aria-label': 'Notice text' })
  const count = h('span', { class: 'dim small' }, `0 / ${ADMIN_NOTICE_MAX}`)
  text.addEventListener('input', () => (count.textContent = `${[...text.value].length} / ${ADMIN_NOTICE_MAX}`))
  const send = button('Send to everyone', async () => {
    const t = text.value.trim()
    if (!t) return toast('Write the notice first.', 'error')
    if (!(await confirmDialog({ title: 'Broadcast notice', message: `Send to every connected player:\n\n${t}`, confirm: 'Send' }))) return
    const r = await attempt(() => post<{ recipients: number }>('notice', { text: t }))
    if (r) {
      toast(`Notice sent to ${r.recipients} connection(s).`)
      text.value = ''
      count.textContent = `0 / ${ADMIN_NOTICE_MAX}`
    }
  }, 'primary')
  return h('div', { class: 'stack' }, text, h('div', { class: 'actions' }, count, h('span', { class: 'spacer' }), send))
}
