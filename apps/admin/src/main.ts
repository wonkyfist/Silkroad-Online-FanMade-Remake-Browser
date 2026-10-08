import './style.css'
import { activeInfo, post, servers, session, setUnauthorizedHandler } from './api.ts'
import { loginPage } from './pages/login.ts'
import { dashboardPage } from './pages/dashboard.ts'
import { accountPage, accountsPage } from './pages/accounts.ts'
import { characterPage, charactersPage } from './pages/characters.ts'
import { settingsPage } from './pages/settings.ts'
import { itemPage, itemsPage } from './pages/items.ts'
import { dropPage, dropsPage } from './pages/drops.ts'
import { worldPage } from './pages/world.ts'
import { questsPage } from './pages/quests.ts'
import { eventsPage } from './pages/events.ts'
import { newsEntryPage, newsPage } from './pages/news.ts'
import './pages/boss.ts' // Play the Boss: EVENT_PAGES 'boss' (docs/PLAY_THE_BOSS.md §6.4)
import './pages/siege.ts' // Siege of Jangan: EVENT_PAGES 'siege' (docs/SIEGE.md §11.4)
import { jobsPage } from './pages/jobs.ts' // Jobs & Trade, and EVENT_PAGES 'jobs' (the Silk Caravan; docs/JOBS.md §9.5)
import { auditPage } from './pages/audit.ts'
import { serversPage } from './pages/servers.ts'
import { updatesPage } from './pages/updates.ts'
import { svgIcon, type IconName } from './icons.ts'
import { badge, h, serverIsLive, serverLabel } from './ui.ts'

/**
 * The admin panel (docs/ADMIN.md): a hash-routed single-page app. Every call goes to the active server profile (Servers
 * page); the top bar always says which server that is (LIVE or LOCAL). Without a session for that server the login
 * shows; any 401 brings it back. Each page renders into the content area and may return a cleanup (timers).
 *
 * Layout: a sidebar with the grouped navigation and a top bar (where you are, the connection chip, the account menu).
 * Below 960 px the sidebar is an off-canvas drawer behind the top bar's menu button.
 */

type Page = (root: HTMLElement, args: string[]) => (() => void) | void

interface Route {
  path: string
  label: string
  icon: IconName
  page: Page
  detail?: Page
}

const SECTIONS: { label: string; items: Route[] }[] = [
  { label: 'Overview', items: [{ path: 'dashboard', label: 'Dashboard', icon: 'dashboard', page: dashboardPage }] },
  {
    label: 'Players',
    items: [
      { path: 'accounts', label: 'Accounts', icon: 'accounts', page: accountsPage, detail: accountPage },
      { path: 'characters', label: 'Characters', icon: 'characters', page: charactersPage, detail: characterPage },
    ],
  },
  {
    label: 'Game data',
    items: [
      { path: 'items', label: 'Items', icon: 'items', page: itemsPage, detail: itemPage },
      { path: 'drops', label: 'Drops', icon: 'drops', page: dropsPage, detail: dropPage },
      { path: 'world', label: 'NPCs & spawns', icon: 'world', page: worldPage },
      { path: 'quests', label: 'Quests', icon: 'quests', page: questsPage },
    ],
  },
  {
    label: 'Live',
    items: [
      { path: 'events', label: 'Events', icon: 'events', page: eventsPage },
      { path: 'jobs', label: 'Jobs & Trade', icon: 'swap', page: jobsPage },
      { path: 'news', label: "What's new", icon: 'megaphone', page: newsPage, detail: newsEntryPage },
    ],
  },
  {
    label: 'System',
    items: [
      { path: 'settings', label: 'Settings', icon: 'settings', page: settingsPage },
      { path: 'servers', label: 'Servers', icon: 'servers', page: serversPage },
      { path: 'updates', label: 'Updates', icon: 'download', page: updatesPage },
      { path: 'audit', label: 'Audit log', icon: 'audit', page: auditPage },
    ],
  },
]

const NAV = SECTIONS.flatMap((s) => s.items.map((r) => ({ ...r, section: s.label })))

/** Below this width the sidebar is a drawer (keep in step with style.css). */
const DRAWER = window.matchMedia('(max-width: 959.98px)')

const app = document.getElementById('app')!
let cleanup: (() => void) | void = undefined

interface Frame {
  content: HTMLElement
  nav: HTMLElement
  crumbs: HTMLElement
  chip: HTMLElement
  server: HTMLElement
  account: ReturnType<typeof accountMenu>
  profile: string
  drawer(open: boolean, focus?: boolean): void
}

let frame: Frame | null = null

function brand(): HTMLElement {
  return h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, '絲'), h('div', { class: 'brand-text' }, h('div', { class: 'brand-name' }, 'Silkroad'), h('div', { class: 'brand-sub' }, 'Admin panel')))
}

/** The connection chip: which server every action goes to (its URL on hover); a link to the Servers page. */
function chip(): HTMLElement {
  const url = servers.display(servers.active())
  const live = serverIsLive()
  const name = serverLabel()
  return h(
    'a',
    { class: live ? 'conn-chip conn-live' : 'conn-chip', href: '#/servers', title: `Connected to ${name} (${url}). Every action goes to this server; click to switch.`, 'aria-label': `Connected to ${name}, ${live ? 'live' : 'local'} server, ${url}. Switch server` },
    h('span', { class: 'conn-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'conn-name' }, name),
    badge(live ? 'LIVE' : 'LOCAL', live ? 'bad' : 'ok'),
  )
}

/** The drawer's footer: the server again, with its URL (no hover on phones). */
function serverBox(): HTMLElement[] {
  const live = serverIsLive()
  return [
    h('div', { class: 'sidebar-server-label' }, 'Connected to'),
    h('div', { class: 'sidebar-server-name' }, h('strong', null, serverLabel()), badge(live ? 'LIVE' : 'LOCAL', live ? 'bad' : 'ok')),
    h('div', { class: 'sidebar-server-url mono' }, servers.display(servers.active())),
  ]
}

async function logout(): Promise<void> {
  await post('logout').catch(() => {})
  session.clear()
  void route()
}

/** The account menu: who is signed in (and where), Switch server, Log out. */
function accountMenu() {
  const avatar = h('span', { class: 'avatar', 'aria-hidden': 'true' })
  const name = h('span', { class: 'account-name' })
  const btn = h('button', { class: 'account-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'account-menu' }, avatar, name, svgIcon('chevronDown', 'svg-icon account-chevron'))
  const who = h('div', { class: 'menu-head' })
  const switcher = h('a', { class: 'menu-item', role: 'menuitem', href: '#/servers' }, svgIcon('swap'), 'Switch server')
  const out = h('button', { class: 'menu-item', role: 'menuitem', type: 'button' }, svgIcon('logout'), 'Log out')
  const panel = h('div', { class: 'menu', id: 'account-menu', role: 'menu', hidden: true }, who, switcher, out)
  const root = h('div', { class: 'account' }, btn, panel)
  const items: HTMLElement[] = [switcher, out]
  let isOpen = false
  const set = (open: boolean, focus = false) => {
    isOpen = open
    panel.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    if (open) items[0].focus()
    else if (focus) btn.focus()
  }
  btn.addEventListener('click', () => set(!isOpen))
  switcher.addEventListener('click', () => set(false))
  out.addEventListener('click', () => {
    set(false)
    void logout()
  })
  panel.addEventListener('keydown', (e) => {
    const at = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus()
    } else if (e.key === 'Tab') set(false)
  })
  return {
    root,
    isOpen: () => isOpen,
    close: (focus = false) => set(false, focus),
    contains: (n: Node) => root.contains(n),
    update() {
      const user = session.name()
      avatar.textContent = (user.trim()[0] ?? '?').toUpperCase()
      name.textContent = user
      btn.setAttribute('aria-label', `Account: ${user}`)
      who.replaceChildren(h('div', { class: 'menu-label' }, 'Signed in as'), h('strong', null, user), h('div', { class: 'menu-sub' }, `on ${serverLabel()}`))
    },
  }
}

function shell(): Frame {
  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': 'Sections' },
    SECTIONS.map((s) =>
      h(
        'div',
        { class: 'nav-section' },
        h('div', { class: 'nav-heading' }, s.label),
        s.items.map((n) => h('a', { href: `#/${n.path}`, class: 'nav-link', 'data-path': n.path }, svgIcon(n.icon, 'svg-icon nav-icon'), h('span', null, n.label))),
      ),
    ),
  )
  const menuBtn = h('button', { class: 'icon-btn menu-btn', type: 'button', 'aria-label': 'Open the menu', 'aria-controls': 'sidebar', 'aria-expanded': 'false' }, svgIcon('menu'))
  const closeBtn = h('button', { class: 'icon-btn drawer-close', type: 'button', 'aria-label': 'Close the menu' }, svgIcon('close'))
  const backdrop = h('div', { class: 'backdrop', 'aria-hidden': 'true' })
  const server = h('a', { class: 'sidebar-server', href: '#/servers', title: 'Switch server' })
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Navigation' }, h('div', { class: 'sidebar-top' }, brand(), closeBtn), h('div', { class: 'sidebar-scroll' }, nav), server)
  const crumbs = h('div', { class: 'crumbs' })
  const chipSlot = h('div', { class: 'chip-slot' })
  const account = accountMenu()
  const content = h('main', { class: 'content', id: 'content', tabindex: '-1' })
  const skip = h('button', { class: 'skip-link', type: 'button' }, 'Skip to content')
  skip.addEventListener('click', () => content.focus())
  const main = h('div', { class: 'main-col' }, h('header', { class: 'topbar' }, menuBtn, crumbs, h('div', { class: 'topbar-end' }, chipSlot, account.root)), content)
  const layout = h('div', { class: 'layout' }, sidebar, backdrop, main)
  const drawer = (open: boolean, focus = true) => {
    const was = layout.classList.contains('nav-open')
    layout.classList.toggle('nav-open', open)
    document.body.classList.toggle('drawer-open', open)
    menuBtn.setAttribute('aria-expanded', String(open))
    // While the drawer is open on a narrow screen, the page behind it is out of reach (focus stays in the drawer).
    main.inert = open && DRAWER.matches
    if (open && focus) (nav.querySelector<HTMLElement>('.nav-link.active') ?? nav.querySelector<HTMLElement>('a'))?.focus()
    else if (!open && was && focus) menuBtn.focus()
  }
  menuBtn.addEventListener('click', () => drawer(true))
  closeBtn.addEventListener('click', () => drawer(false))
  backdrop.addEventListener('click', () => drawer(false))
  // A tap on the current page's link changes no hash (so no route): close here as well.
  nav.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) drawer(false, false)
  })
  server.addEventListener('click', () => drawer(false, false))
  app.replaceChildren(skip, layout)
  return { content, nav, crumbs, chip: chipSlot, server, account, profile: servers.activeId, drawer }
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !frame || document.querySelector('dialog[open]')) return
  if (frame.account.isOpen()) frame.account.close(true)
  else if (document.querySelector('.layout.nav-open')) frame.drawer(false)
})
document.addEventListener('pointerdown', (e) => {
  if (frame?.account.isOpen() && !frame.account.contains(e.target as Node)) frame.account.close()
})
DRAWER.addEventListener('change', () => frame?.drawer(false, false))

/** Where you are, in the top bar: section / page (/ the record on a detail page, the page then a link back). */
function crumbs(entry: (typeof NAV)[number], detail: string | null): Node[] {
  const sep = () => h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/')
  return [
    h('span', { class: 'crumb crumb-section' }, entry.section),
    sep(),
    detail === null ? h('span', { class: 'crumb crumb-page', 'aria-current': 'page' }, entry.label) : h('a', { class: 'crumb crumb-page crumb-link', href: `#/${entry.path}` }, entry.label),
    detail === null ? null : sep(),
    detail === null ? null : h('span', { class: 'crumb crumb-detail', 'aria-current': 'page' }, detail),
  ].filter((x): x is HTMLElement => !!x)
}

let seq = 0

async function route(): Promise<void> {
  const mine = ++seq
  if (typeof cleanup === 'function') cleanup()
  cleanup = undefined
  // Which server this is (LIVE / LOCAL, its name) before anything is shown or confirmed.
  await activeInfo().catch(() => null)
  if (mine !== seq) return
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  if (!session.token()) {
    frame = null
    document.body.classList.remove('drawer-open')
    app.replaceChildren()
    if (parts[0] === 'servers') {
      document.title = 'Servers · Silkroad Admin'
      const root = h('main', { class: 'content solo', id: 'content' })
      app.append(h('div', { class: 'solo-bar' }, brand(), h('a', { class: 'btn btn-small', href: '#/login' }, svgIcon('chevronLeft'), 'Back to sign in')), root)
      cleanup = serversPage(root)
      return
    }
    document.title = 'Sign in · Silkroad Admin'
    loginPage(app, () => {
      if (!location.hash || location.hash === '#/' || location.hash === '#/servers' || location.hash === '#/login') location.hash = '#/dashboard'
      void route()
    })
    return
  }
  if (!frame || !app.contains(frame.content) || frame.profile !== servers.activeId) frame = shell()
  const entry = NAV.find((n) => n.path === parts[0]) ?? NAV[0]
  const detail = parts.length > 1 && entry.detail ? parts[1] : null
  frame.chip.replaceChildren(chip())
  frame.server.replaceChildren(...serverBox())
  frame.account.update()
  frame.account.close()
  frame.crumbs.replaceChildren(...crumbs(entry, detail))
  frame.drawer(false, false)
  for (const a of frame.nav.querySelectorAll<HTMLAnchorElement>('a')) {
    const on = a.dataset.path === entry.path
    a.classList.toggle('active', on)
    if (on) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
  document.title = `${detail ? `${detail} · ` : ''}${entry.label} · Silkroad Admin`
  frame.content.replaceChildren()
  window.scrollTo(0, 0)
  const page = detail !== null ? entry.detail! : entry.page
  cleanup = page(frame.content, parts.slice(1))
}

/** Re-renders everything for the active profile (after a switch on the Servers page). */
export function reconnect(): void {
  frame = null
  void route()
}

setUnauthorizedHandler(() => void route())
window.addEventListener('hashchange', () => void route())
window.addEventListener('sro-admin-reconnect', () => reconnect())
void route()
