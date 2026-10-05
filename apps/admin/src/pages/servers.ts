import { HERE, health, normalizeUrl, servers, session, type Profile } from '../api.ts'
import { badge, button, card, clear, confirmDialog, formDialog, h, pageHeader, toast } from '../ui.ts'

/**
 * Server profiles (docs/ADMIN.md §2.1): which game server the panel edits. Each profile is a name and a server URL; the
 * panel logs in to each with that server's own admin account and keeps the token for this tab only. "This server" is the
 * one that served the page. A server reached from another origin must list this page's origin in ALLOWED_ORIGINS.
 */
export function serversPage(root: HTMLElement): void {
  const list = h('div', { class: 'stack' })
  const switchTo = (p: Profile) => {
    servers.activeId = p.id
    toast(`Now working on ${p.name} (${servers.display(p)}).`, 'info')
    location.hash = '#/dashboard'
    window.dispatchEvent(new Event('sro-admin-reconnect'))
  }
  const render = () => {
    const active = servers.activeId
    clear(
      list,
      servers.list().map((p) => {
        const status = h('span', { class: 'dim small' }, 'checking…')
        void health(p).then((r) => {
          clear(
            status,
            r.ok
              ? [badge(r.info.environment === 'live' ? 'LIVE' : 'LOCAL', r.info.environment === 'live' ? 'bad' : 'ok'), ` ${r.info.name} · world ${r.info.world} · ${r.info.commit ? `${r.info.release} (${r.info.commit.slice(0, 7)})` : r.info.release} · admin API v${r.info.apiVersion}`]
              : [badge('unreachable', 'bad'), ` ${r.reason}`],
          )
        })
        const signedIn = session.token(p.id)
        return h(
          'div',
          { class: p.id === active ? 'server server-active' : 'server' },
          h('div', { class: 'server-main' }, h('div', null, h('strong', null, p.name), p.id === active ? badge('active', 'gold') : null, signedIn ? badge(`signed in as ${session.name(p.id)}`, 'ok') : badge('not signed in')), h('div', { class: 'mono small' }, servers.display(p)), status),
          h(
            'div',
            { class: 'row-actions' },
            p.id !== active ? button('Use this server', () => switchTo(p), 'primary') : null,
            signedIn
              ? button('Forget session', () => {
                  session.clear(p.id)
                  render()
                  if (p.id === active) window.dispatchEvent(new Event('sro-admin-reconnect'))
                }, 'small')
              : null,
            p.id !== HERE.id
              ? button('Remove', async () => {
                  if (!(await confirmDialog({ title: 'Remove server', message: `Remove the profile ${p.name} (${p.url}) from this browser? Nothing changes on the server.`, confirm: 'Remove' }))) return
                  servers.remove(p.id)
                  render()
                  window.dispatchEvent(new Event('sro-admin-reconnect'))
                }, 'small')
              : null,
          ),
        )
      }),
    )
  }
  const add = button('Add server…', async () => {
    let made: Profile | null = null
    const v = await formDialog({
      title: 'Add a server',
      intro: 'A game server with the admin panel (http://<address>:<port>). You log in to it with an admin account of that server.',
      fields: [
        { name: 'name', label: 'Name', required: true, maxlength: 40, placeholder: 'Mini PC (live)' },
        { name: 'url', label: 'Server URL', required: true, placeholder: 'http://192.168.1.50:7000' },
      ],
      submit: 'Add',
      onSubmit: async (vals) => {
        const url = normalizeUrl(String(vals.url))
        if (!url) throw new Error('The URL must look like http://host:port.')
        if (url === location.origin) throw new Error('That is this server: use the "This server" profile.')
        if (servers.list().some((p) => p.url === url)) throw new Error('There is already a profile for that URL.')
        made = servers.add(String(vals.name).trim(), url)
      },
    })
    if (v && made) render()
  }, 'primary')
  root.append(
    pageHeader('Servers', 'Which game server this panel edits. Every change goes to the active server and is stored in that server\'s own data (its database and DATA_DIR).', add),
    card(null, list),
    card(
      'Reaching another server',
      h('p', null, 'A server only answers this page if it lists this page\'s origin. On that server, add to ', h('code', null, '~/silkroad/silkroad.local.env'), ':'),
      h('pre', { class: 'json' }, `ALLOWED_ORIGINS=${location.origin}`),
      h('p', { class: 'dim small' }, 'then restart it (systemctl --user restart silkroad). The development panel (pnpm admin, port 5182) is allowed by default. Sessions stay in this tab; passwords are never stored.'),
    ),
  )
  render()
}
