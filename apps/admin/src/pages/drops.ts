import type { AdminDropDetail, AdminDropRow, AdminPage, DropTable } from '@sro/shared'
import { del, get, put, qs } from '../api.ts'
import { attempt, badge, button, card, clear, confirmDialog, dataTable, errorText, h, icon, navigate, pageHeader, suggestions, toast } from '../ui.ts'
import { itemSuggest } from './characters.ts'

/** Monster drop tables (docs/ADMIN.md §5): a replacement table per monster in DATA_DIR/content/drops.override.json. */
export function dropsPage(root: HTMLElement): void {
  const overridden = h('select', { class: 'input', 'aria-label': 'Overridden' }, [['', 'Monsters with drops'], ['1', 'Overridden only']].map(([v, l]) => h('option', { value: v }, l)))
  const table = dataTable<AdminDropRow>({
    placeholder: 'Search monsters (any monster when searching)',
    filters: [overridden],
    load: (q, page, size) => get<AdminPage<AdminDropRow>>(`drops${qs({ q, page, size, overridden: overridden.value })}`),
    onRow: (r) => navigate(`drops/${encodeURIComponent(r.mob)}`),
    columns: [
      { label: '', render: (r) => icon(r.icon, r.mobName ?? r.mob), class: 'icon-cell' },
      { label: 'Monster', render: (r) => [h('strong', null, r.mobName ?? r.mob), r.overridden ? badge('override', 'gold') : null] },
      { label: 'Code', render: (r) => h('span', { class: 'mono dim small' }, r.mob) },
      { label: 'Level', render: (r) => String(r.level ?? '–'), class: 'num' },
      { label: 'Groups', render: (r) => String(r.groups), class: 'num' },
      { label: 'Items', render: (r) => String(r.items), class: 'num' },
      { label: 'Gold', render: (r) => (r.gold ? 'yes' : 'no') },
    ],
  })
  overridden.addEventListener('change', () => void table.reload())
  root.append(pageHeader('Drops', 'Rates (Settings) multiply these chances; quest items drop through their quests.'), card(null, table.root))
}

interface EditEntry {
  item: string
  weight: number
  min: number
  max: number
}
interface EditGroup {
  chance: number
  entries: EditEntry[]
}

function toEdit(t: DropTable | null): { gold: { on: boolean; chance: number; min: number; max: number }; groups: EditGroup[] } {
  return {
    gold: { on: !!t?.gold, chance: t?.gold?.chance ?? 0.5, min: t?.gold?.amount[0] ?? 1, max: t?.gold?.amount[1] ?? 10 },
    groups: (t?.groups ?? []).map((g) => ({ chance: g.chance, entries: g.entries.map((e) => ({ item: e.item, weight: e.weight, min: e.count?.[0] ?? 1, max: e.count?.[1] ?? 1 })) })),
  }
}

export function dropPage(root: HTMLElement, args: string[]): void {
  const mob = args[0]
  const body = h('div')
  root.append(body)
  const load = async () => {
    try {
      render(await get<AdminDropDetail>(`drops/${encodeURIComponent(mob)}`))
    } catch (e) {
      clear(body, pageHeader('Drops'), h('p', { class: 'error' }, errorText(e)))
    }
  }
  const render = (d: AdminDropDetail) => {
    const state = toEdit(d.effective)
    const editor = h('div')
    const num = (value: number, set: (v: number) => void, step: string | number = 'any') => {
      const inp = h('input', { class: 'input num-input', type: 'number', value: String(value), step, min: 0 })
      inp.addEventListener('input', () => set(Number(inp.value)))
      return inp
    }
    const draw = () => {
      const goldBox = h('input', { type: 'checkbox', checked: state.gold.on })
      goldBox.addEventListener('change', () => (state.gold.on = goldBox.checked))
      clear(
        editor,
        card(
          'Gold',
          h('div', { class: 'inline-form' }, h('label', { class: 'check' }, goldBox, ' drops gold'), ' chance (0–1) ', num(state.gold.chance, (v) => (state.gold.chance = v)), ' amount ', num(state.gold.min, (v) => (state.gold.min = v), 1), '–', num(state.gold.max, (v) => (state.gold.max = v), 1)),
        ),
        state.groups.map((g, gi) =>
          card(
            `Group ${gi + 1}: rolled once per kill, then one entry by weight`,
            h('div', { class: 'inline-form' }, ' chance (0–1) ', num(g.chance, (v) => (g.chance = v)), h('span', { class: 'spacer' }), button('Remove group', () => {
              state.groups.splice(gi, 1)
              draw()
            }, 'small')),
            h(
              'table',
              { class: 'table compact entry-table' },
              h('thead', null, h('tr', null, ['', 'Item code', 'Weight', 'Count', ''].map((x) => h('th', null, x)))),
              h(
                'tbody',
                null,
                g.entries.map((e, ei) => {
                  const code = h('input', { class: 'input mono', value: e.item, maxlength: 128 })
                  for (const ev of ['input', 'change']) code.addEventListener(ev, () => (e.item = code.value.trim().toUpperCase()))
                  queueMicrotask(() => suggestions(code, itemSuggest))
                  const known = d.items[e.item]
                  const pic = h('td', { class: 'icon-cell', title: known?.name ?? e.item }, icon(known?.icon, known?.name ?? e.item))
                  code.addEventListener('change', () => pic.replaceChildren(icon(null, code.value)))
                  return h('tr', null, pic, h('td', null, code, known?.name ? h('div', { class: 'dim small' }, known.name) : null), h('td', null, num(e.weight, (v) => (e.weight = v))), h('td', null, num(e.min, (v) => (e.min = v), 1), '–', num(e.max, (v) => (e.max = v), 1)), h('td', null, button('×', () => {
                    g.entries.splice(ei, 1)
                    draw()
                  }, 'small')))
                }),
              ),
            ),
            button('Add entry', () => {
              g.entries.push({ item: '', weight: 1, min: 1, max: 1 })
              draw()
            }, 'small'),
          ),
        ),
        button('Add group', () => {
          state.groups.push({ chance: 0.1, entries: [{ item: '', weight: 1, min: 1, max: 1 }] })
          draw()
        }),
      )
    }
    const table = (): unknown => ({
      ...(state.gold.on ? { gold: { chance: state.gold.chance, amount: [state.gold.min, state.gold.max] } } : {}),
      groups: state.groups.map((g) => ({ chance: g.chance, entries: g.entries.map((e) => ({ item: e.item, weight: e.weight, ...(e.min !== 1 || e.max !== 1 ? { count: [e.min, e.max] } : {}) })) })),
    })
    const save = button('Save override', async () => {
      if (state.groups.some((g) => g.entries.some((e) => !e.item))) return toast('Every entry needs an item code.', 'error')
      const r = await attempt(() => put<AdminDropDetail>(`drops/${encodeURIComponent(d.mob)}`, { table: table() }), 'Saved: the next kill uses it.')
      if (r) render(r)
    }, 'primary')
    const revert = button('Revert to export…', async () => {
      if (!(await confirmDialog({ title: 'Revert drops', message: `Back to the exported drop table of ${d.mobName ?? d.mob}?`, confirm: 'Revert', danger: true }))) return
      const r = await attempt(() => del<AdminDropDetail>(`drops/${encodeURIComponent(d.mob)}`), 'Reverted.')
      if (r) render(r)
    }, 'danger')
    clear(
      body,
      pageHeader({ text: d.mobName ?? d.mob, icon: icon(d.icon, d.mobName ?? d.mob, 'lg') }, `${d.mob}${d.level !== null ? ` · level ${d.level}` : ''}`, ...(d.overridden ? [revert] : []), save),
      d.note ? h('div', { class: 'notice warn' }, d.note) : null,
      d.overridden ? h('div', { class: 'notice' }, 'This table is an override; the export keeps its own.') : null,
      editor,
      card('Exported table (read only)', h('pre', { class: 'json' }, d.base ? JSON.stringify(d.base, null, 2) : 'none')),
    )
    draw()
  }
  void load()
}
