import { ADMIN_NOTICE_MAX, type AdminDashboard } from '@sro/shared'
import { get, post } from '../api.ts'
import { svgIcon, type IconName } from '../icons.ts'
import { maintenanceCard } from './maintenance.ts'
import { attempt, badge, button, card, cardHead, clear, confirmDialog, emptyState, errorText, fmtBytes, fmtDuration, fmtNum, fmtTime, formDialog, h, kv, link, pageHeader, stackTable, toast } from '../ui.ts'

/** Server stats, live players (kick, send to town), the lobby, server details, a notice box. Refreshes every 5 s. */
export function dashboardPage(root: HTMLElement): () => void {
  const info = h('div', { class: 'stats' }, (['Online', 'Uptime', 'Server tick', 'World', 'Release', 'Database'] as const).map((l, i) => stat(STAT_ICONS[i], l, '—', 'loading…')))
  const health = h('div', null, h('p', { class: 'dim' }, 'Loading…'))
  const players = h('div', null, h('p', { class: 'dim' }, 'Loading…'))
  const perf = h('div', null, h('p', { class: 'dim' }, 'Loading…'))
  const count = h('span')
  const notice = noticeBox()
  // docs/ADMIN.md §8: maintenance mode
  const maint = maintenanceCard()
  root.append(
    pageHeader('Dashboard', 'The running server and who is on it.'),
    info,
    card(null, cardHead('Players in the world', count), players),
    h('div', { class: 'grid grid-2' }, card('Server', health), card('Performance', perf)),
    h('div', { class: 'grid grid-2' }, card('Maintenance', maint.node), card('Broadcast notice', notice)),
  )
  let stopped = false
  const load = async () => {
    try {
      const d = await get<AdminDashboard>('dashboard')
      if (stopped) return
      render(d)
      void maint.refresh()
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
      stat('accounts', 'Online', h('span', null, fmtNum(s.online), h('span', { class: 'stat-of' }, ` / ${fmtNum(s.capacity)}`)), `players · ${s.lobby} in the lobby${s.maxVisiblePlayers ? ` · each sees the nearest ${s.maxVisiblePlayers}` : ''}`, full >= 0.9 ? 'bad' : 'none', h('progress', { class: 'meter', max: Math.max(1, s.capacity), value: s.online, 'aria-label': 'Capacity used' })),
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
    clear(perf, perfView(d.perf))
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
    maint.dispose()
  }
}

const STAT_ICONS: IconName[] = ['accounts', 'clock', 'pulse', 'globe', 'release', 'database']

/**
 * The performance tile (docs/SERVER_ARCHITECTURE.md §3.11): tick percentiles against the budget, where the tick time goes
 * (the server's built-in phase timers, heaviest first), messages per second, the outbound backlog and the event loop.
 */
function perfView(p: AdminDashboard['perf']): Node {
  if (!p) return h('p', { class: 'dim' }, 'This server does not report its tick timers.')
  const t = p.tick
  const ms = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`
  const tickKind = t.p95 > t.budgetMs ? 'bad' : t.p95 > t.budgetMs / 2 ? 'gold' : 'ok'
  const rows: [string, Node | string | (Node | string)[]][] = [
    ['Tick', [badge(`p95 ${ms(t.p95)}`, tickKind), ` p50 ${ms(t.p50)} · max ${ms(t.max)} · budget ${ms(t.budgetMs)}`]],
  ]
  if (p.phases) {
    const busy = p.phases.reduce((s, x) => s + x.avgMs, 0)
    rows.push(['Per tick', `${ms(busy)} busy: ${p.phases.filter((x) => x.avgMs >= 0.05).slice(0, 6).map((x) => `${x.name} ${ms(x.avgMs)}`).join(' · ') || 'idle'}`])
  }
  if (p.modules?.length) rows.push(['Modules', p.modules.slice(0, 4).map((m) => `${m.name} ${ms(m.avgMs)}`).join(' · ')])
  if (p.rates) rows.push(['Messages', `${fmtNum(p.rates.inPerS)}/s in · ${fmtNum(p.rates.outPerS)}/s out (${fmtNum(p.rates.outKBps)} kB/s) · ${fmtNum(p.rates.encodesPerS)} encodes/s`])
  if (p.queue) rows.push(['Send queue', `${fmtBytes(p.queue.bufferedBytes)} over ${fmtNum(p.queue.sockets)} sockets (worst ${fmtBytes(p.queue.maxBufferedBytes)})`])
  if (p.loop) rows.push(['Event loop', `delay p50 ${ms(p.loop.p50Ms)} · p99 ${ms(p.loop.p99Ms)} · max ${ms(p.loop.maxMs)}`])
  // docs/SERVER_ARCHITECTURE.md P2: the DB writer's queue (journaled in memory, not yet on disk), the services, the transfers
  if (p.db) {
    const d = p.db
    const qKind = !d.up || d.oldestMs > 500 ? 'bad' : d.queued > 1000 ? 'gold' : 'ok'
    const trouble = [d.restarts ? `${d.restarts} restart(s)` : '', d.resyncs ? `${d.resyncs} resync(s)` : '', d.divergences ? `${d.divergences} divergence(s)` : '', d.external ? `${d.external} external write(s)` : ''].filter(Boolean)
    rows.push(['DB writer', [
      badge(d.up ? `${fmtNum(d.queued)} queued` : 'down', qKind),
      ` ${fmtNum(d.queuedOps)} statements · oldest ${ms(d.oldestMs)} · commit p95 ${ms(d.commitP95Ms)} · to disk p95 ${ms(d.latencyP95Ms)} · ${fmtNum(d.groupOps)}/group · WAL ${fmtNum(d.walMb)} MB · in memory ${fmtNum(d.memDbMb)} MB`,
      ...(trouble.length ? [' ', badge(trouble.join(' · '), 'gold')] : []),
    ]])
  }
  if (p.economy) rows.push(['Transfers', `${fmtNum(p.economy.transfers)} · ${fmtNum(p.economy.pending)} waiting for the disk · answered p95 ${ms(p.economy.ackP95Ms)}`])
  if (p.services?.length) rows.push(['Services', p.services.filter((x) => x.requests > 0).slice(0, 6).map((x) => `${x.name} ${fmtNum(x.requests)} (p95 ${ms(x.p95Ms)})`).join(' · ') || 'idle'])
  const off = Object.entries(p.switches ?? {}).filter(([, on]) => !on).map(([k]) => k)
  if (off.length) rows.push(['Switched off', off.map((k) => badge(k, 'dim'))])
  return kv(rows)
}

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
  const text = h('textarea', { class: 'input', rows: 3, maxlength: ADMIN_NOTICE_MAX, placeholder: 'The arena opens in 10 minutes…', 'aria-label': 'Notice text' })
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
