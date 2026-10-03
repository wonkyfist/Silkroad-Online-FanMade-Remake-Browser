/**
 * Server select. The window is outer/serverchange_window (250x355), the client's textless server-list
 * frame, laid out like resinfo/pstitle.txt section UnityServer: title static (6,6,238,15), column heads
 * (14,35,84,11) / (129,35,84,11), list (11,54,204,290), scroll lane (222,45,24,280). outer/server_window
 * (240x340, GDR_STA_SERVERWINDOW) is not used: its header reads "Danh sach may chu" in the art.
 * Rows use server_select / server_rollover (204x20). The list pane of this frame is transparent, so a CSS
 * fill stands in for server_window's darkened pane. The frame's right lane (x 224..243) carries the retail scroll bar
 * (GDR_VSC_UNITY_SERVER: server_up / server_mov / server_down); buttons are kit outer buttons (docs/UI.md §4.7).
 */
import type { ServerInfo } from '@sro/shared'
import type { App, Screen } from '../app.ts'
import { t, type StringKey } from '../i18n/index.ts'
import { saveSession } from '../net/resume.ts'
import { openSession } from '../net/transport.ts'
import { anchor, bars } from '../ui/chrome.ts'
import { el, Listeners, place } from '../ui/dom.ts'
import { wordmark } from '../ui/wordmark.ts'
import { describeError } from './login.ts'
import { OuterScroll, outerButton, setDisabled } from './outer-ui.ts'
import { titleScene } from './title.ts'

const REFRESH_MS = 10_000
const WIN_W = 250
const WIN_H = 355

const STATUS_KEY: Record<ServerInfo['status'], StringKey> = {
  online: 'servers.status.online',
  maintenance: 'servers.status.maintenance',
  offline: 'servers.status.offline',
}

export function serversScreen(app: App): Screen {
  titleScene(app)
  const art = app.art
  const root = el('div', 'screen servers')
  const logo = anchor(wordmark('small'), 0.5, 0.2)
  const win = art.window('outer/serverchange_window', 'server-window', WIN_W, WIN_H)
  const pane = place(el('div', 'server-pane'), [11, 54, 204, 290])
  const title = place(el('div', 'server-title kit-t-title', t('servers.title')), [6, 5, 238, 16])
  const heads = [
    place(el('div', 'server-head kit-t-label', t('servers.colServer')), [14, 35, 84, 13]),
    place(el('div', 'server-head kit-t-label right', t('servers.colPlayers')), [129, 35, 84, 13]),
  ]
  const list = place(el('div', 'server-list'), [11, 54, 204, 290])
  const scroll = new OuterScroll(art, list, [224, 31, 20, 316])
  const status = el('div', 'server-status')
  const select = outerButton(art, t('servers.select'), { primary: true })
  const cancel = outerButton(art, t('servers.cancel'))
  const buttons = place(el('div', 'button-row'), [0, WIN_H + 10, WIN_W, 40])
  buttons.append(select, cancel)
  win.append(pane, title, ...heads, list, scroll.root, buttons, place(status, [-35, WIN_H + 58, 320, 20]))
  root.append(...bars(art, 'outer/blackbar_up_18', 'outer/blackbar_down_notext'), logo, anchor(win, 0.5, 0.56))
  app.ui.append(root)

  let servers: ServerInfo[] = []
  let selected: string | null = null
  let busy = false
  let disposed = false

  const rowArt = (key: string) => (art.has(key) ? art.cssUrl(key) : '')
  const render = () => {
    list.replaceChildren()
    for (const s of servers) {
      const row = el('div', `server-row ${s.status}`)
      row.style.setProperty('--row', rowArt('outer/server_select'))
      row.style.setProperty('--row-hover', rowArt('outer/server_rollover'))
      if (s.id === selected) row.classList.add('selected')
      const load = s.status === 'online' ? t('servers.load', { online: s.online, capacity: s.capacity }) : s.status === 'maintenance' ? t('servers.maintenance') : t('servers.offline')
      row.append(el('span', 'name', s.name), el('span', 'load', load))
      row.title = t('servers.rowTitle', { name: s.name, status: t(STATUS_KEY[s.status] ?? 'servers.status.offline'), online: s.online })
      row.addEventListener('click', () => {
        if (s.status !== 'online') return
        selected = s.id
        render()
      })
      row.addEventListener('dblclick', () => {
        if (s.status !== 'online') return
        selected = s.id
        void connect()
      })
      list.append(row)
    }
    if (!servers.length) list.append(el('div', 'server-empty', t('servers.empty')))
    setDisabled([select], busy || !servers.some(s => s.id === selected && s.status === 'online'))
    scroll.refresh()
  }

  const refresh = async () => {
    try {
      servers = await app.transport.api.servers()
      if (disposed) return
      if (!selected || !servers.some(s => s.id === selected && s.status === 'online')) {
        selected = servers.find(s => s.status === 'online')?.id ?? null
      }
      if (!busy) status.textContent = ''
      render()
      if (app.params.auto && selected) {
        app.params.auto = false
        void connect()
      }
    } catch (err) {
      if (disposed) return
      status.textContent = describeError(err)
      status.classList.add('error')
      render()
    }
  }

  const connect = async () => {
    if (busy || !selected) return
    if (!app.token) return app.logout(t('servers.loginFirst'))
    busy = true
    render()
    status.classList.remove('error')
    status.textContent = t('servers.connecting')
    const session = openSession(app.transport, app.token)
    try {
      await session.connect()
      if (disposed) return session.close()
      app.setSession(session)
      saveSession({ token: app.token, username: app.username, expiresAt: app.tokenExpiresAt }, app.transport.mock)
      await app.go('charselect')
    } catch (err) {
      session.close()
      busy = false
      if (disposed) return
      const msg = describeError(err)
      if (/unauthorized/.test(String((err as { code?: string }).code))) return app.logout(msg)
      status.textContent = msg
      status.classList.add('error')
      render()
    }
  }

  const ls = new Listeners()
  ls.on(select, 'click', () => void connect())
  ls.on(cancel, 'click', () => void app.logout())
  ls.on(window, 'keydown', ev => {
    if (ev.key === 'Enter') void connect()
    if (ev.key === 'Escape') void app.logout()
  })
  render()
  void refresh()
  const timer = setInterval(() => void refresh(), REFRESH_MS)

  return {
    dispose() {
      disposed = true
      clearInterval(timer)
      scroll.dispose()
      ls.clear()
    },
  }
}
