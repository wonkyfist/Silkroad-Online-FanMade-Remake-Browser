/**
 * World feature of the "What's new" window (hud/news.ts; docs/CHANGELOG_WINDOW.md §3). When the last `welcome` said
 * this account has unseen entries, it fetches `GET /api/news` and, once the world has loaded, opens the window on
 * them, once per login (a reconnect or a trip through character select does not show them again). "Got it" posts
 * `POST /api/news/seen` with the newest entry. The Esc menu's "What's new" entry and J reopen it with every entry.
 * Never in the mock (no server).
 */
import type { ApiNewsList, ApiNewsSeenResponse, NewsEntry } from '@sro/shared'
import { t } from '../../i18n/index.ts'
import { registerMenuItem } from '../../hud/menu-items.ts'
import { NewsWindow } from '../../hud/news.ts'
import type { WorldFeature, WorldFeatureContext, WorldFeatureFactory } from '../features.ts'

/** Wait this long after the world has loaded before the window opens (the scene settles, the HUD is drawn). */
const OPEN_DELAY_MS = 1500
/** Open anyway after this long, even when the world never reports loaded (the flat fallback). */
const OPEN_FALLBACK_MS = 20_000

export const newsFeature: WorldFeatureFactory = ctx => {
  // A bare context (tests of the feature list) has no HUD; the mock has no news.
  if (!ctx?.hud || !ctx.session || !ctx.app || ctx.app.transport.mock) return {}
  return createNewsFeature(ctx)
}

function createNewsFeature(ctx: WorldFeatureContext): WorldFeature {
  const { app, session, hud } = ctx
  let disposed = false
  let list: ApiNewsList | null = null
  let readyAt = 0
  const startedAt = performance.now()

  const headers = (): Record<string, string> => (app.token ? { Authorization: `Bearer ${app.token}` } : {})

  const load = async (): Promise<ApiNewsList> => {
    const res = await fetch('/api/news', { headers: headers(), cache: 'no-store' })
    if (!res.ok) throw new Error(`GET /api/news: HTTP ${res.status}`)
    const body = (await res.json()) as ApiNewsList
    if (!body || !Array.isArray(body.entries) || !Array.isArray(body.unseen)) throw new Error('GET /api/news: malformed answer')
    return body
  }

  const win = new NewsWindow(app.art, hud.layer, {
    gotIt: (newest: NewsEntry) => {
      session.news = 0
      if (list) list.unseen = []
      void fetch('/api/news/seen', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ id: newest.id }) })
        .then(async res => {
          if (!res.ok) throw new Error(`POST /api/news/seen: HTTP ${res.status}`)
          const r = (await res.json()) as ApiNewsSeenResponse
          if (list && Array.isArray(r.unseen)) list.unseen = r.unseen
        })
        .catch(err => console.warn('[news]', err))
    },
  })

  /** The full history (the menu entry, J), newest first, with the unseen ones marked. */
  const openAll = async (): Promise<void> => {
    try {
      list = await load()
      if (disposed) return
      win.present('all', list.entries, list.unseen)
    } catch (err) {
      console.warn('[news]', err)
      if (!disposed) hud.toast(t('news.loadFailed'), 'error')
    }
  }
  const toggleAll = () => {
    if (win.isOpen) win.close()
    else void openAll()
  }

  // The unseen entries, fetched now and shown once the world is ready.
  if (session.news > 0 && !session.newsShown) {
    void load()
      .then(l => {
        if (disposed) return
        list = l
        if (l.unseen.length === 0) session.newsShown = true
      })
      .catch(err => console.warn('[news]', err))
  }

  const offs = [
    registerMenuItem({
      id: 'news',
      label: 'menu.news',
      order: 15,
      run: menu => {
        menu.close()
        void openAll()
      },
    }),
    ctx.keys.register({ id: 'window.news', keys: ['j'], label: 'keys.window.news', group: 'windows', run: toggleAll }),
  ]

  return {
    onFrame() {
      if (session.newsShown || !list || list.unseen.length === 0) return
      const now = performance.now()
      if (!readyAt && (ctx.world() || now - startedAt > OPEN_FALLBACK_MS)) readyAt = now
      if (!readyAt || now - readyAt < OPEN_DELAY_MS) return
      session.newsShown = true
      const unseen = new Set(list.unseen)
      const entries = list.entries.filter(e => unseen.has(e.id))
      if (entries.length > 0) win.present('unseen', entries, list.unseen)
    },
    dispose() {
      disposed = true
      for (const off of offs) off()
      win.dispose()
    },
  }
}
