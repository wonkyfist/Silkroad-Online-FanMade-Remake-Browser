import type { AdminEventInfo, AdminUniqueRow, AdminUniquesView } from '@sro/shared'
import { get, post } from '../api.ts'
import { attempt, badge, button, card, clear, confirmDialog, emptyState, errorText, fmtAgo, fmtDuration, fmtTime, formDialog, h, icon, pageHeader, stackTable, toast } from '../ui.ts'
import { noticeBox } from './dashboard.ts'

/**
 * Events (docs/ADMIN.md §1): the unique bosses, broadcast notices and scheduled events. An event with a route group
 * (`/api/admin/<routes>/*`) gets its own sub-page from EVENT_PAGES; Play the Boss (docs/PLAY_THE_BOSS.md §6.4,
 * "Night of the Tiger") plugs in there once it is built.
 */

/** Sub-pages of scheduled events, by their route group. Play the Boss adds `boss` (its page: now, schedule, numbers, log, blocks). */
export const EVENT_PAGES = new Map<string, (root: HTMLElement, event: AdminEventInfo) => (() => void) | void>()

export function eventsPage(root: HTMLElement): () => void {
  const uniques = h('div')
  const events = h('div')
  root.append(
    pageHeader('Events', 'World bosses, notices and scheduled events.'),
    card('Unique monsters', uniques),
    card('Scheduled events', events),
    card('Broadcast notice', noticeBox()),
  )
  let stopped = false
  let sub: (() => void) | void = undefined
  const loadUniques = async () => {
    try {
      const v = await get<AdminUniquesView>('uniques')
      if (!stopped) renderUniques(v)
    } catch (e) {
      if (!stopped) clear(uniques, emptyState(errorText(e), 'alert', true))
    }
  }
  const act = async (u: AdminUniqueRow, action: 'spawn' | 'kill' | 'despawn' | 'timer', body?: unknown) => {
    const r = await attempt(() => post<{ message: string; uniques: AdminUniquesView }>(`uniques/${encodeURIComponent(u.code)}/${action}`, body))
    if (r) {
      toast(r.message.split('\n')[0])
      renderUniques(r.uniques)
    }
  }
  const renderUniques = (v: AdminUniquesView) => {
    if (!v.enabled) return void clear(uniques, emptyState('Uniques are off on this server (UNIQUES=off in Settings, after a restart).', 'events'))
    if (v.uniques.length === 0) return void clear(uniques, emptyState('No unique monsters on this world (content/uniques.json).', 'events'))
    const now = Date.now()
    clear(
      uniques,
      h(
        'div',
        { class: 'table-scroll' },
        stackTable(h(
          'table',
          { class: 'table' },
          h('thead', null, h('tr', null, ['Unique', 'State', 'Next / where', 'Last kill', 'Spawns', ''].map((x, i) => h('th', { class: i === 4 ? 'num' : i === 5 ? 'row-actions' : undefined }, x)))),
          h(
            'tbody',
            null,
            v.uniques.map((u) =>
              h(
                'tr',
                null,
                h('td', null, h('span', { class: 'item' }, icon(u.icon, u.name ?? u.code), h('strong', null, u.name ?? u.code)), h('div', { class: 'mono dim small' }, u.code)),
                h('td', null, u.phase === 'alive' ? [badge('alive', 'bad'), u.hpPct !== null ? ` ${u.hpPct}% HP` : ''] : badge('waiting', 'dim')),
                h('td', null, u.phase === 'alive' ? `${u.area || 'camp'} (camp ${u.camp ?? '?'})` : u.dueAt ? `spawns ${u.dueAt <= now ? 'any moment' : `in ${fmtDuration(u.dueAt - now)}`} (${fmtTime(u.dueAt)})` : 'not scheduled'),
                h('td', null, u.lastKilledAt ? `${u.lastKiller ?? 'someone'}, ${fmtAgo(u.lastKilledAt, now)}` : 'never'),
                h('td', { class: 'num' }, String(u.spawns)),
                h(
                  'td',
                  { class: 'row-actions' },
                  u.phase === 'alive'
                    ? [
                        button('Kill', async () => {
                          if (await confirmDialog({ title: `Kill ${u.name ?? u.code}`, message: 'She dies without loot or announcement; the respawn timer starts.', confirm: 'Kill', danger: true })) void act(u, 'kill')
                        }, 'small'),
                        button('Despawn', async () => {
                          if (await confirmDialog({ title: `Despawn ${u.name ?? u.code}`, message: 'She vanishes silently; the respawn timer starts.', confirm: 'Despawn', danger: true })) void act(u, 'despawn')
                        }, 'small'),
                      ]
                    : [
                        button('Spawn now…', async () => {
                          const vals = await formDialog({
                            title: `Spawn ${u.name ?? u.code}`,
                            intro: 'Every player in the world sees the announcement.',
                            fields: [{ name: 'camp', label: 'Camp', type: 'select', value: '', options: [{ value: '', label: 'Random camp' }, ...u.camps.map((c) => ({ value: String(c), label: `Camp ${c}` }))] }],
                            submit: 'Spawn',
                          })
                          if (vals) void act(u, 'spawn', vals.camp ? { camp: Number(vals.camp) } : undefined)
                        }, 'small'),
                        button('Timer…', async () => {
                          const vals = await formDialog({
                            title: `${u.name ?? u.code}: next spawn`,
                            fields: [{ name: 'minutes', label: 'Minutes from now (0 = now; empty = a fresh roll)', type: 'number', min: 0, max: 10080, step: 'any' }],
                            submit: 'Set timer',
                          })
                          if (vals) void act(u, 'timer', { minutes: Number.isNaN(vals.minutes) ? 'clear' : Number(vals.minutes) })
                        }, 'small'),
                      ],
                ),
              ),
            ),
          ),
        )),
      ),
    )
  }
  const loadEvents = async () => {
    try {
      const r = await get<{ events: AdminEventInfo[] }>('events')
      if (stopped) return
      clear(
        events,
        r.events.map((e) => {
          const page = e.routes ? EVENT_PAGES.get(e.routes) : undefined
          const slot = h('div', { class: 'event-slot' })
          const node = h(
            'div',
            { class: 'event' },
            h('div', { class: 'event-head' }, h('strong', null, e.name), badge(e.state === 'unavailable' ? 'not built yet' : e.state, e.state === 'running' ? 'bad' : e.state === 'unavailable' ? 'dim' : 'info')),
            h('p', { class: 'dim' }, e.about),
            e.nextAt ? h('p', null, `Next: ${fmtTime(e.nextAt)} (${fmtAgo(e.nextAt)})`) : null,
            e.spec ? h('p', { class: 'dim small' }, 'Design: ', h('code', null, e.spec)) : null,
            page ? button('Open…', () => {
              if (typeof sub === 'function') sub()
              slot.replaceChildren()
              sub = page(slot, e)
            }, 'primary') : h('p', { class: 'dim small' }, 'Its settings, start / stop and event log appear here once the event is built.'),
            slot,
          )
          return node
        }),
      )
    } catch (e) {
      if (!stopped) clear(events, h('p', { class: 'error' }, errorText(e)))
    }
  }
  void loadUniques()
  void loadEvents()
  const timer = setInterval(() => void loadUniques(), 10_000)
  return () => {
    stopped = true
    clearInterval(timer)
    if (typeof sub === 'function') sub()
  }
}
