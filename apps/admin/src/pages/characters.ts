import { CHARACTER_RULES, EQUIP_SLOTS, MAX_GOLD, MAX_ITEM_COUNT, type AdminCharacterDetail, type AdminCharacterRow, type AdminItemRow, type AdminItemSlot, type AdminPage, type AdminStorage } from '@sro/shared'
import { get, post, qs } from '../api.ts'
import { svgIcon } from '../icons.ts'
import { attempt, badge, button, card, clear, confirmDialog, dataTable, emptyState, errorText, fmtAgo, fmtNum, formDialog, h, icon, kv, navigate, pageHeader, stackTable, tabs } from '../ui.ts'

/** Characters: search; per character progress, gold, position, bag, equipment, storage, skills (docs/ADMIN.md §1). */
export function charactersPage(root: HTMLElement): void {
  const online = h('select', { class: 'input', 'aria-label': 'Online' }, [['', 'Everyone'], ['1', 'In the world']].map(([v, l]) => h('option', { value: v }, l)))
  const table = dataTable<AdminCharacterRow>({
    placeholder: 'Search by character or account',
    filters: [online],
    load: (q, page, size) => get<AdminPage<AdminCharacterRow>>(`characters${qs({ q, page, size, online: online.value })}`),
    onRow: (r) => navigate(`characters/${r.id}`),
    columns: [
      { label: 'Character', render: (r) => h('strong', null, r.name) },
      { label: 'Level', render: (r) => String(r.level), class: 'num' },
      { label: 'Account', render: (r) => h('a', { class: 'link', href: `#/accounts/${r.accountId}` }, r.account) },
      { label: 'Status', render: (r) => (r.online ? badge('in the world', 'ok') : badge('offline')) },
      { label: 'Last played', render: (r) => fmtAgo(r.lastPlayed || null) },
    ],
  })
  online.addEventListener('change', () => void table.reload())
  root.append(pageHeader('Characters', 'Change a character: online ones see it at once, offline ones on their next login.'), card(null, table.root))
}

/** Item code suggestions for the give dialogs. */
export const itemSuggest = async (q: string) =>
  q.length < 2 ? [] : (await get<AdminPage<AdminItemRow>>(`items${qs({ q, size: 20 })}`)).rows.map((r) => ({ value: r.code, label: `${r.name ?? r.code} (Lv ${r.reqLevel})`, icon: r.icon }))

function slotLabel(s: AdminItemSlot): HTMLElement {
  return h('span', { class: 'item' }, icon(s.icon, s.name ?? s.code), h('span', { class: 'item-name' }, s.name ?? s.code), s.plus ? h('span', { class: 'plus' }, ` +${s.plus}`) : null, s.count > 1 ? h('span', { class: 'dim' }, ` ×${fmtNum(s.count)}`) : null)
}

function itemTable(items: AdminItemSlot[], remove: (s: AdminItemSlot) => void, empty: string): HTMLElement {
  if (items.length === 0) return emptyState(empty)
  return h(
    'div',
    { class: 'table-scroll' },
    stackTable(h(
      'table',
      { class: 'table compact' },
      h('thead', null, h('tr', null, ['Slot', 'Item', 'Code', 'Durability', ''].map((x, i) => h('th', { class: i === 0 ? 'num' : i === 4 ? 'row-actions' : undefined }, x)))),
      h(
        'tbody',
        null,
        items.map((s) => h('tr', null, h('td', { class: 'num' }, String(s.slot)), h('td', null, slotLabel(s)), h('td', { class: 'mono dim small' }, s.code), h('td', null, s.durability === null ? 'full' : String(s.durability)), h('td', { class: 'row-actions' }, button('Remove…', () => remove(s), 'small')))),
      ),
    ), 1),
  )
}

async function giveDialog(title: string, maxPlus: number, send: (v: { code: string; count: number; plus: number }) => Promise<unknown>): Promise<boolean> {
  const v = await formDialog({
    title,
    fields: [
      { name: 'code', label: 'Item code', required: true, maxlength: 128, placeholder: 'ITEM_CH_BLADE_02_A', suggest: itemSuggest, hint: 'Type part of a name or code.' },
      { name: 'count', label: 'Count', type: 'number', value: 1, min: 1, max: MAX_ITEM_COUNT, required: true },
      { name: 'plus', label: `Plus (equipment, 0-${maxPlus})`, type: 'number', value: 0, min: 0, max: maxPlus },
    ],
    submit: 'Give',
    onSubmit: (vals) => send({ code: String(vals.code).trim().toUpperCase(), count: Number(vals.count), plus: Number.isNaN(vals.plus) ? 0 : Number(vals.plus) }),
  })
  return !!v
}

async function removeDialog(s: AdminItemSlot, send: (count: number | undefined) => Promise<unknown>): Promise<boolean> {
  if (s.count > 1) {
    const v = await formDialog({
      title: `Remove ${s.name ?? s.code}`,
      fields: [{ name: 'count', label: `How many (of ${s.count})`, type: 'number', value: s.count, min: 1, max: s.count, required: true }],
      submit: 'Remove',
      danger: true,
      onSubmit: (vals) => send(Number(vals.count)),
    })
    return !!v
  }
  if (!(await confirmDialog({ title: 'Remove item', message: `Remove ${s.name ?? s.code}${s.plus ? ` +${s.plus}` : ''}? It is gone for good.`, confirm: 'Remove', danger: true }))) return false
  return !!(await attempt(() => send(undefined)))
}

/** The account's storage with give / remove / gold (also on the account page). */
export function storageCard(accountId: number, st: AdminStorage, reload: () => void, maxPlus = 12): HTMLElement {
  return card(
    `Storage (account-wide, ${st.items.length} / ${st.size} slots, ${fmtNum(st.gold)} gold)`,
    h(
      'div',
      { class: 'actions card-actions' },
      button('Give item…', async () => {
        if (await giveDialog('Give to storage', maxPlus, (v) => post(`accounts/${accountId}/storage`, v))) reload()
      }),
      button('Set gold…', async () => {
        const v = await formDialog({
          title: 'Storage gold',
          fields: [{ name: 'gold', label: 'Gold', type: 'number', value: st.gold, min: 0, max: MAX_GOLD, required: true }],
          onSubmit: (vals) => post(`accounts/${accountId}/storage/gold`, { gold: vals.gold }),
        })
        if (v) reload()
      }),
    ),
    itemTable(st.items, async (s) => {
      if (await removeDialog(s, (count) => post(`accounts/${accountId}/storage/remove`, { where: 'storage', slot: s.slot, ...(count !== undefined && count < s.count ? { count } : {}) }))) reload()
    }, 'Storage is empty.'),
  )
}

export function characterPage(root: HTMLElement, args: string[]): void {
  const id = Number(args[0])
  const body = h('div')
  root.append(body)
  let tab = 'bag'
  const load = async () => {
    try {
      render(await get<AdminCharacterDetail>(`characters/${id}`))
    } catch (e) {
      clear(body, pageHeader('Character'), h('p', { class: 'error' }, errorText(e)))
    }
  }
  const render = (c: AdminCharacterDetail) => {
    const p = c.progress
    const edit = button('Edit level / EXP / SP…', async () => {
      const v = await formDialog({
        title: `${c.name}: progress`,
        intro: `Raising the level grants the stat points and typical SP of those levels (like GM setlevel). EXP is into the current level (below ${fmtNum(p.expToNext)}).`,
        fields: [
          { name: 'level', label: `Level (1-${c.levelCap})`, type: 'number', value: p.level, min: 1, max: c.levelCap, required: true },
          { name: 'exp', label: 'EXP', type: 'number', value: p.exp, min: 0 },
          { name: 'sp', label: 'SP', type: 'number', value: p.sp, min: 0 },
          { name: 'spExp', label: `SP-EXP (0-${CHARACTER_RULES.spExpPerSp - 1})`, type: 'number', value: p.spExp, min: 0, max: CHARACTER_RULES.spExpPerSp - 1 },
        ],
        onSubmit: async (vals) => {
          const body: Record<string, number> = {}
          if (vals.level !== p.level) body.level = Number(vals.level)
          if (vals.exp !== p.exp && !Number.isNaN(vals.exp)) body.exp = Number(vals.exp)
          if (vals.sp !== p.sp && !Number.isNaN(vals.sp)) body.sp = Number(vals.sp)
          if (vals.spExp !== p.spExp && !Number.isNaN(vals.spExp)) body.spExp = Number(vals.spExp)
          if (Object.keys(body).length === 0) return
          // A level change resets EXP into the level: send it first, then the rest.
          if (body.level !== undefined) {
            await post(`characters/${id}/progress`, { level: body.level })
            delete body.level
          }
          if (Object.keys(body).length) await post(`characters/${id}/progress`, body)
        },
      })
      if (v) void load()
    })
    const gold = button('Set gold…', async () => {
      const v = await formDialog({
        title: `${c.name}: gold`,
        fields: [{ name: 'gold', label: 'Gold', type: 'number', value: c.gold, min: 0, max: MAX_GOLD, required: true }],
        onSubmit: (vals) => post(`characters/${id}/gold`, { gold: vals.gold }),
      })
      if (v) void load()
    })
    const town = button('Send to town', async () => {
      const msg = c.online ? `${c.name} is warped to the town spawn now.` : `${c.name} logs in at the town spawn next time.`
      if (!(await confirmDialog({ title: 'Send to town', message: msg, confirm: 'Send to town' }))) return
      if (await attempt(() => post(`characters/${id}/town`), `${c.name} was sent to town.`)) void load()
    })
    const pos = c.position ? `${c.position.zone || 'unnamed area'} (${c.position.x.toFixed(1)}, ${c.position.z.toFixed(1)})` : 'town spawn (next login)'
    clear(
      body,
      pageHeader({ text: c.name, icon: svgIcon('characters') }, `Level ${c.level} · ${c.model}`, edit, gold, town),
      h(
        'div',
        { class: 'grid grid-2' },
        card(
          'Character',
          kv([
            ['Account', [h('a', { class: 'link', href: `#/accounts/${c.accountId}` }, c.account), c.role !== 'player' ? badge(c.role.toUpperCase(), 'gold') : null]],
            ['Status', [c.online ? badge('in the world', 'ok') : badge('offline'), c.dead ? badge('dead', 'bad') : null]],
            ['Position', pos],
            ['HP / MP', `${c.hp ?? 'full'} / ${c.mp ?? 'full'}`],
            ['Last played', fmtAgo(c.lastPlayed || null)],
          ]),
        ),
        card(
          'Progress',
          kv([
            ['Level', `${p.level} / ${c.levelCap}`],
            ['EXP', p.expToNext > 0 ? `${fmtNum(p.exp)} / ${fmtNum(p.expToNext)} (${((100 * p.exp) / p.expToNext).toFixed(1)} %)` : `${fmtNum(p.exp)} (cap)`],
            ['SP', `${fmtNum(p.sp)} (+${p.spExp} SP-EXP)`],
            ['STR / INT', `${p.str} / ${p.int} (${p.statPoints} free)`],
            ['Gold', fmtNum(c.gold)],
          ]),
        ),
      ),
      tabs(
        [
          {
            id: 'bag',
            label: `Bag (${c.bag.items.length} / ${c.bag.size})`,
            render: (r) => {
              tab = 'bag'
              r.append(card(
                null,
                h('div', { class: 'actions card-actions' }, button('Give item…', async () => {
                  if (await giveDialog(`Give to ${c.name}`, c.maxPlus, (v) => post(`characters/${id}/items`, v))) void load()
                }, 'primary')),
                itemTable(c.bag.items, async (s) => {
                  if (await removeDialog(s, (count) => post(`characters/${id}/items/remove`, { where: 'bag', slot: s.slot, ...(count !== undefined && count < s.count ? { count } : {}) }))) void load()
                }, 'The bag is empty.'),
              ))
            },
          },
          {
            id: 'equip',
            label: `Equipment (${c.equip.length})`,
            render: (r) => {
              tab = 'equip'
              const order = new Map(EQUIP_SLOTS.map((s, i) => [s as string, i]))
              r.append(card(
                null,
                itemTable([...c.equip].sort((a, b) => (order.get(String(a.slot)) ?? 0) - (order.get(String(b.slot)) ?? 0)), async (s) => {
                  if (await removeDialog({ ...s, count: 1 }, () => post(`characters/${id}/items/remove`, { where: 'equip', slot: s.slot }))) void load()
                }, 'Nothing worn.'),
              ))
            },
          },
          {
            id: 'storage',
            label: `Storage (${c.storage.items.length})`,
            render: (r) => {
              tab = 'storage'
              r.append(storageCard(c.accountId, c.storage, () => void load(), c.maxPlus))
            },
          },
          {
            id: 'skills',
            label: `Skills (${c.skills.length})`,
            render: (r) => {
              tab = 'skills'
              r.append(
                h(
                  'div',
                  { class: 'grid grid-2' },
                  card('Masteries', c.masteries.length ? h('ul', { class: 'list' }, c.masteries.map((m) => h('li', null, h('span', { class: 'mono' }, m.code), ` level ${m.level}`))) : h('p', { class: 'dim' }, 'None.')),
                  card('Skills', c.skills.length ? h('ul', { class: 'list' }, c.skills.map((s) => h('li', null, h('span', { class: 'mono' }, s.group), ` level ${s.level}`))) : h('p', { class: 'dim' }, 'None learned.')),
                ),
                h('p', { class: 'dim small' }, 'Skills are read-only here; a GM edits their own with /skill in game.'),
              )
            },
          },
        ],
        tab,
      ),
    )
  }
  void load()
}
