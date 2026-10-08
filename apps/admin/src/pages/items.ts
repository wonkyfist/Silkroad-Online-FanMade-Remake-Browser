import {
  ADMIN_ITEM_FLAG_FIELDS,
  ADMIN_ITEM_NUMBER_FIELDS,
  ADMIN_ITEM_STAT_FIELDS,
  ADMIN_ITEM_USE_FIELDS,
  type AdminItemDetail,
  type AdminItemPatch,
  type AdminItemRow,
  type AdminPage,
  type ItemDef,
} from '@sro/shared'
import { del, get, put, qs } from '../api.ts'
import { attempt, badge, button, card, clear, confirmDialog, dataTable, errorText, fmtNum, h, icon, navigate, pageHeader, toast } from '../ui.ts'

/** Items (docs/ADMIN.md §5): browse items.json; edit through DATA_DIR/content/items.override.json. */
export function itemsPage(root: HTMLElement): void {
  const category = h('select', { class: 'input', 'aria-label': 'Category' }, ['', 'weapon', 'shield', 'armor', 'accessory', 'potion', 'scroll', 'alchemy', 'quest', 'etc'].map((c) => h('option', { value: c }, c || 'Any category')))
  const overridden = h('select', { class: 'input', 'aria-label': 'Overridden' }, [['', 'All items'], ['1', 'Overridden only']].map(([v, l]) => h('option', { value: v }, l)))
  const table = dataTable<AdminItemRow>({
    placeholder: 'Search by name or code',
    filters: [category, overridden],
    load: (q, page, size) => get<AdminPage<AdminItemRow>>(`items${qs({ q, page, size, category: category.value, overridden: overridden.value })}`),
    onRow: (r) => navigate(`items/${encodeURIComponent(r.code)}`),
    columns: [
      { label: '', render: (r) => icon(r.icon, r.name ?? r.code), class: 'icon-cell' },
      { label: 'Item', render: (r) => [h('strong', null, r.name ?? r.code), r.overridden ? badge('override', 'gold') : null] },
      { label: 'Code', render: (r) => h('span', { class: 'mono dim small' }, r.code) },
      { label: 'Category', render: (r) => `${r.category}${r.slot ? ` · ${r.slot}` : ''}` },
      { label: 'Degree', render: (r) => String(r.degree), class: 'num' },
      // the Climb's re-spacing (docs/CLIMB.md §4.1.2): the client's level beside the one the game uses
      { label: 'Req. level', render: (r) => (r.retailReqLevel != null ? [String(r.reqLevel), h('span', { class: 'dim small' }, ` (retail ${r.retailReqLevel})`)] : String(r.reqLevel)), class: 'num' },
      { label: 'Price', render: (r) => fmtNum(r.price), class: 'num' },
    ],
  })
  for (const s of [category, overridden]) s.addEventListener('change', () => void table.reload())
  root.append(pageHeader('Items', 'Changes go to an override file; the converted export is never edited.'), card(null, table.root))
}

type NumberField = (typeof ADMIN_ITEM_NUMBER_FIELDS)[number]
type FlagField = (typeof ADMIN_ITEM_FLAG_FIELDS)[number]
type StatField = (typeof ADMIN_ITEM_STAT_FIELDS)[number]
type UseField = (typeof ADMIN_ITEM_USE_FIELDS)[number]

const LABELS: Record<string, string> = {
  price: 'Buy price', sellPrice: 'Sell price', reqLevel: 'Required level', maxStack: 'Max stack', degree: 'Degree', keepFee: 'Storage fee', repairCost: 'Repair cost',
  canSell: 'Can sell', canDrop: 'Can drop', canTrade: 'Can trade', canStore: 'Can store',
  physAttack: 'Phy. attack', magAttack: 'Mag. attack', physDefence: 'Phy. defence', magDefence: 'Mag. defence', parryRate: 'Parry rate', blockRate: 'Block rate',
  physAbsorb: 'Phy. absorb', magAbsorb: 'Mag. absorb', durability: 'Durability', hitRate: 'Hit rate', critRate: 'Critical',
  hp: 'HP', mp: 'MP', hpPct: 'HP %', mpPct: 'MP %', cooldownMs: 'Cooldown (ms)',
}

export function itemPage(root: HTMLElement, args: string[]): void {
  const code = args[0]
  const body = h('div')
  root.append(body)
  const load = async () => {
    try {
      render(await get<AdminItemDetail>(`items/${encodeURIComponent(code)}`))
    } catch (e) {
      clear(body, pageHeader('Item'), h('p', { class: 'error' }, errorText(e)))
    }
  }
  const render = (d: AdminItemDetail) => {
    const b = d.base
    const e = d.effective
    const name = h('input', { class: 'input', value: e.name ?? '', maxlength: 64 })
    const nums = new Map<NumberField, HTMLInputElement>()
    const flags = new Map<FlagField, HTMLInputElement>()
    const stats = new Map<StatField, [HTMLInputElement, HTMLInputElement]>()
    const uses = new Map<UseField, HTMLInputElement>()
    const numRow = (k: NumberField) => {
      const inp = h('input', { class: 'input num-input', type: 'number', value: String(e[k] ?? 0), min: 0, step: 1 })
      nums.set(k, inp)
      return row(LABELS[k], inp, String(b[k] ?? 0))
    }
    const flagRow = (k: FlagField) => {
      const box = h('input', { type: 'checkbox', checked: e[k] !== false })
      flags.set(k, box)
      return row(LABELS[k], box, b[k] === false ? 'no' : 'yes')
    }
    const statKeys = ADMIN_ITEM_STAT_FIELDS.filter((k) => b.stats?.[k] !== undefined)
    const statRow = (k: StatField) => {
      const [lo, hi] = e.stats?.[k] ?? [0, 0]
      const a = h('input', { class: 'input num-input', type: 'number', value: String(lo), min: 0, step: 'any' })
      const z = h('input', { class: 'input num-input', type: 'number', value: String(hi), min: 0, step: 'any' })
      stats.set(k, [a, z])
      const base = b.stats?.[k]
      return row(LABELS[k], h('span', { class: 'range' }, a, '–', z), base ? `${base[0]}–${base[1]}` : '–')
    }
    const useRow = (k: UseField) => {
      const inp = h('input', { class: 'input num-input', type: 'number', value: String(e.use?.[k] ?? 0), min: 0, step: 'any' })
      uses.set(k, inp)
      return row(LABELS[k], inp, String(b.use?.[k] ?? 0))
    }
    const patch = (): AdminItemPatch | string => {
      const p: AdminItemPatch = {}
      const n = name.value.trim()
      if (n !== (b.name ?? '')) p.name = n
      for (const [k, inp] of nums) {
        const v = Number(inp.value)
        if (inp.value.trim() === '' || !Number.isFinite(v)) return `${LABELS[k]}: a number`
        if (v !== (b[k] ?? 0)) p[k] = v
      }
      for (const [k, box] of flags) if (box.checked !== (b[k] !== false)) p[k] = box.checked
      for (const [k, [a, z]] of stats) {
        const lo = Number(a.value)
        const hi = Number(z.value)
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return `${LABELS[k]}: min must not exceed max`
        const base = b.stats?.[k]
        if (!base || base[0] !== lo || base[1] !== hi) (p.stats ??= {})[k] = [lo, hi]
      }
      for (const [k, inp] of uses) {
        const v = Number(inp.value)
        if (!Number.isFinite(v)) return `${LABELS[k]}: a number`
        if (v !== (b.use?.[k] ?? 0)) (p.use ??= {})[k] = v
      }
      return p
    }
    const save = button('Save override', async () => {
      const p = patch()
      if (typeof p === 'string') return toast(p, 'error')
      if (Object.keys(p).length === 0) {
        if (d.patch) return void revert()
        return toast('Nothing differs from the export.', 'info')
      }
      const r = await attempt(() => put<AdminItemDetail>(`items/${encodeURIComponent(b.code)}`, { patch: p, baseRev: d.rev }), 'Saved: the server uses it now.')
      if (r) render(r)
    }, 'primary')
    const revert = async () => {
      if (!(await confirmDialog({ title: 'Revert item', message: `Back to the exported ${b.name ?? b.code}?`, confirm: 'Revert', danger: true }))) return
      const r = await attempt(() => del<AdminItemDetail>(`items/${encodeURIComponent(b.code)}`), 'Reverted to the export.')
      if (r) render(r)
    }
    clear(
      body,
      pageHeader({ text: e.name ?? b.code, icon: icon(d.icon, e.name ?? b.code, 'lg') }, `${b.code} · ${b.category}${b.slot ? ` · ${b.slot}` : ''} · degree ${b.degree}`, ...(d.patch ? [button('Revert to export…', () => void revert(), 'danger')] : []), save),
      d.patch ? h('div', { class: 'notice' }, 'This item has an override. Fields that differ from the export are saved; the rest follow the export.') : null,
      h(
        'div',
        { class: 'grid grid-2' },
        card('Basics', h('table', { class: 'table compact form-table' }, head(), h('tbody', null, row('Name', name, b.name ?? '–'), ADMIN_ITEM_NUMBER_FIELDS.map(numRow)))),
        h(
          'div',
          null,
          card('Flags', h('table', { class: 'table compact form-table' }, head(), h('tbody', null, ADMIN_ITEM_FLAG_FIELDS.map(flagRow)))),
          statKeys.length ? card('Stats [min–max]', h('table', { class: 'table compact form-table' }, head(), h('tbody', null, statKeys.map(statRow)))) : null,
          b.use ? card('Use effect', h('table', { class: 'table compact form-table' }, head(), h('tbody', null, ADMIN_ITEM_USE_FIELDS.map(useRow)))) : null,
        ),
      ),
      h('p', { class: 'dim small' }, 'Worn copies update for online players at once; the game client reads the merged list on its next load.'),
      card('Effective record (read only)', h('pre', { class: 'json' }, JSON.stringify(trim(e), null, 2))),
    )
  }
  void load()
}

function head(): HTMLElement {
  return h('thead', null, h('tr', null, h('th', null, 'Field'), h('th', null, 'Value'), h('th', null, 'Export')))
}

function row(label: string, control: HTMLElement, base: string): HTMLElement {
  return h('tr', null, h('td', null, label), h('td', null, control), h('td', { class: 'dim' }, base))
}

function trim(e: ItemDef): Partial<ItemDef> {
  const { fieldSources: _f, model: _m, dropModel: _d, ...rest } = e
  return rest
}
