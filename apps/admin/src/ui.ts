import type { AdminPage } from '@sro/shared'
import { AdminApiError, HERE, assetUrl, cachedInfo, servers } from './api.ts'
import { svgIcon, type IconName } from './icons.ts'

/**
 * Small DOM components of the panel: `h` (elements), toasts, confirm and form dialogs, a data table with search and
 * paging, badges and formatters. No inline styles or scripts (the /admin/ CSP forbids them): classes from style.css.
 * Tables built here (and those passed through `stackTable`) turn into stacked cards on phones.
 */

type Child = Node | string | number | null | undefined | false
type Attrs = Record<string, unknown>

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue
      if (k === 'class') el.className = String(v)
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener)
      else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v)
      else if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = !!v
      else if (v === true) el.setAttribute(k, '')
      else el.setAttribute(k, String(v))
    }
  }
  append(el, children)
  return el
}

function append(el: Node, children: (Child | Child[])[]): void {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c)
  }
}

export function clear(el: HTMLElement, ...children: (Child | Child[])[]): HTMLElement {
  el.replaceChildren()
  append(el, children)
  return el
}

// ---- feedback -------------------------------------------------------------------------------------------------

let toasts: HTMLElement | null = null

export function toast(message: string, kind: 'ok' | 'error' | 'info' = 'ok'): void {
  if (!toasts) document.body.appendChild((toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })))
  const close = h('button', { class: 'icon-btn toast-close', type: 'button', 'aria-label': 'Dismiss' }, svgIcon('close'))
  const t = h('div', { class: `toast toast-${kind}` }, svgIcon(kind === 'ok' ? 'check' : kind === 'error' ? 'alert' : 'info', 'svg-icon toast-icon'), h('div', { class: 'toast-text' }, message), close)
  const dismiss = () => {
    t.classList.add('toast-out')
    setTimeout(() => t.remove(), 300)
  }
  close.addEventListener('click', dismiss)
  toasts.appendChild(t)
  setTimeout(dismiss, kind === 'error' ? 7000 : 3500)
}

/** The message of a failed call (with the first issues of a 422). */
export function errorText(e: unknown): string {
  if (e instanceof AdminApiError) {
    const issues = e.issues.slice(0, 4).map((i) => `${i.path ? `${i.path}: ` : ''}${i.message}`)
    return issues.length ? `${e.message}\n${issues.join('\n')}` : e.message
  }
  return e instanceof Error ? e.message : String(e)
}

/** Runs `fn`, toasting its error; returns undefined on failure. */
export async function attempt<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const r = await fn()
    if (success) toast(success, 'ok')
    return r
  } catch (e) {
    toast(errorText(e), 'error')
    return undefined
  }
}

// ---- dialogs ---------------------------------------------------------------------------------------------------

let dialogN = 0

function dialog(title: string, body: Node[], buttons: HTMLButtonElement[], onClose: () => void): HTMLDialogElement {
  const id = `dialog-title-${++dialogN}`
  const x = h('button', { class: 'icon-btn dialog-close', type: 'button', 'aria-label': 'Close' }, svgIcon('close'))
  const d = h(
    'dialog',
    { class: 'dialog', 'aria-labelledby': id },
    h('div', { class: 'dialog-head' }, h('h2', { id }, title), x),
    h('div', { class: 'dialog-body' }, body),
    h('div', { class: 'dialog-buttons' }, buttons),
  )
  x.addEventListener('click', () => d.close())
  d.addEventListener('close', () => {
    onClose()
    d.remove()
  })
  document.body.appendChild(d)
  d.showModal()
  return d
}

/** The name of the active server as the panel shows it (the default profile: the server's own name). */
export function serverLabel(): string {
  const p = servers.active()
  return p.id === HERE.id ? (cachedInfo(p.id)?.name ?? location.host) : p.name
}

/** Whether the active server is (or may be) the live one: anything not known to be a local dev server. */
export function serverIsLive(): boolean {
  return cachedInfo()?.environment !== 'local'
}

/**
 * The server line of a destructive dialog: which server it acts on and, on a LIVE server, a box where the admin types
 * that server's name to confirm (docs/ADMIN.md §2.1). `check` returns the problem, or null.
 */
function serverGuard(): { node: HTMLElement; check: () => string | null } {
  const name = serverLabel()
  const live = serverIsLive()
  const where = h('p', { class: live ? 'guard guard-live' : 'guard' }, 'On ', h('strong', null, name), ` (${servers.display(servers.active())}) `, badge(live ? 'LIVE' : 'LOCAL', live ? 'bad' : 'ok'))
  if (!live) return { node: where, check: () => null }
  const typed = h('input', { class: 'input', 'aria-label': `Type ${name} to confirm`, placeholder: name, autocomplete: 'off' })
  return {
    node: h('div', { class: 'guard-box' }, where, h('label', { class: 'field' }, h('span', { class: 'field-label' }, `Type ${name} to confirm`), typed)),
    check: () => (typed.value.trim().toLowerCase() === name.toLowerCase() ? null : `Type ${name} to confirm this on the live server.`),
  }
}

export function confirmDialog(opts: { title: string; message: string; confirm?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false
    const yes = h('button', { class: opts.danger ? 'btn btn-danger' : 'btn btn-primary', type: 'button' }, opts.confirm ?? 'Confirm')
    const no = h('button', { class: 'btn', type: 'button' }, 'Cancel')
    const guard = opts.danger ? serverGuard() : null
    const problem = h('div', { class: 'form-error', role: 'alert' })
    const d = dialog(opts.title, [h('p', { class: 'pre' }, opts.message), guard?.node ?? null, problem].filter((x): x is HTMLElement => !!x), [no, yes], () => resolve(ok))
    yes.addEventListener('click', () => {
      const p = guard?.check() ?? null
      if (p) {
        problem.textContent = p
        return
      }
      ok = true
      d.close()
    })
    no.addEventListener('click', () => d.close())
    no.focus()
  })
}

export interface Field {
  name: string
  label: string
  type?: 'text' | 'password' | 'number' | 'select' | 'checkbox' | 'textarea'
  value?: string | number | boolean
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  step?: number | 'any'
  required?: boolean
  hint?: string
  placeholder?: string
  maxlength?: number
  rows?: number
  /** Live suggestions (a datalist filled as the user types). */
  suggest?: (q: string) => Promise<Suggestion[]>
}

export function fieldInput(f: Field): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  if (f.type === 'select') {
    return h('select', { name: f.name, class: 'input' }, (f.options ?? []).map((o) => h('option', { value: o.value, selected: String(f.value ?? '') === o.value }, o.label)))
  }
  if (f.type === 'textarea') return h('textarea', { name: f.name, class: 'input mono', rows: f.rows ?? 12, spellcheck: 'false', value: f.value === undefined ? '' : String(f.value) })
  if (f.type === 'checkbox') return h('input', { name: f.name, type: 'checkbox', checked: !!f.value })
  const input = h('input', {
    name: f.name,
    class: 'input',
    type: f.type ?? 'text',
    value: f.value === undefined ? '' : String(f.value),
    min: f.min,
    max: f.max,
    step: f.step,
    required: f.required,
    placeholder: f.placeholder,
    maxlength: f.maxlength,
    autocomplete: f.type === 'password' ? 'new-password' : 'off',
  })
  if (f.suggest) suggestions(input, f.suggest)
  return input
}

let listN = 0

export interface Suggestion {
  value: string
  label: string
  /** Icon path on the active server (/admin/out/...), shown at 32 px. */
  icon?: string | null
}

/**
 * A suggestion list under `input` that `fetch` fills (debounced) as the user types: icon, name and code per row; arrow
 * keys and Enter pick one. Wrapped in a positioned box so the list overlays what follows.
 */
export function suggestions(input: HTMLInputElement, fetch: (q: string) => Promise<Suggestion[]>): void {
  const id = `sugg-${++listN}`
  const list = h('div', { class: 'suggest', id, role: 'listbox', hidden: true })
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-controls', id)
  input.setAttribute('aria-autocomplete', 'list')
  let rows: Suggestion[] = []
  let active = -1
  const close = () => {
    list.hidden = true
    active = -1
  }
  const pick = (r: Suggestion) => {
    input.value = r.value
    input.dispatchEvent(new Event('change'))
    close()
  }
  const draw = () => {
    list.replaceChildren(
      ...rows.map((r, i) => {
        const opt = h('div', { class: i === active ? 'suggest-row active' : 'suggest-row', role: 'option' }, icon(r.icon, r.label), h('span', { class: 'suggest-label' }, r.label), h('span', { class: 'mono dim small' }, r.value))
        opt.addEventListener('mousedown', (e) => {
          e.preventDefault()
          pick(r)
        })
        return opt
      }),
    )
    list.hidden = rows.length === 0
  }
  let timer = 0
  let seq = 0
  input.addEventListener('input', () => {
    clearTimeout(timer)
    timer = window.setTimeout(async () => {
      const mine = ++seq
      try {
        const r = await fetch(input.value.trim())
        if (mine !== seq) return
        rows = r
        active = -1
        draw()
      } catch {
        // suggestions are optional
      }
    }, 200)
  })
  input.addEventListener('keydown', (e) => {
    if (list.hidden || rows.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      active = (active + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length
      draw()
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault()
      e.stopPropagation()
      pick(rows[active])
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  })
  input.addEventListener('blur', () => setTimeout(close, 100))
  const attach = () => {
    if (!input.parentNode || list.parentNode) return
    const box = h('div', { class: 'suggest-box' })
    input.replaceWith(box)
    box.append(input, list)
  }
  if (input.parentNode) attach()
  else queueMicrotask(attach)
}

/**
 * A game icon from the active server (lazy; 28 px in tables, 32 px, 44 px in a page header), or a lettered placeholder
 * when there is none or it fails to load.
 */
export function icon(path: string | null | undefined, label: string, size: 'sm' | 'md' | 'lg' = 'sm'): HTMLElement {
  const fallback = () => h('span', { class: `icon icon-${size} icon-none`, 'aria-hidden': 'true' }, (label.trim()[0] ?? '?').toUpperCase())
  const src = assetUrl(path)
  if (!src) return fallback()
  const px = size === 'sm' ? 28 : size === 'md' ? 32 : 44
  const img = h('img', { class: `icon icon-${size}`, src, alt: '', loading: 'lazy', decoding: 'async', width: px, height: px })
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true })
  return img
}

/** Reads a form field: numbers as numbers (NaN when empty), checkboxes as booleans. */
export function fieldValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, f: Field): string | number | boolean {
  if (f.type === 'checkbox') return (el as HTMLInputElement).checked
  if (f.type === 'number') return el.value.trim() === '' ? Number.NaN : Number(el.value)
  return el.value
}

/** A modal form; resolves with the values, or null when cancelled. `submit` may reject to keep the dialog open. */
export function formDialog(opts: {
  title: string
  fields: Field[]
  submit?: string
  danger?: boolean
  intro?: string
  onSubmit?: (values: Record<string, string | number | boolean>) => Promise<unknown>
}): Promise<Record<string, string | number | boolean> | null> {
  return new Promise((resolve) => {
    let result: Record<string, string | number | boolean> | null = null
    const inputs = opts.fields.map((f) => {
      const el = fieldInput(f)
      const n = ++fieldN
      const hint = f.hint ? h('span', { class: 'field-hint', id: `field-hint-${n}` }, f.hint) : null
      const err = h('span', { class: 'field-error', id: `field-error-${n}`, hidden: true })
      el.setAttribute('aria-describedby', [hint?.id, err.id].filter(Boolean).join(' '))
      const reset = () => {
        err.hidden = true
        err.textContent = ''
        el.removeAttribute('aria-invalid')
      }
      el.addEventListener('input', reset)
      el.addEventListener('change', reset)
      return { f, el, hint, err, show: (text: string) => {
        err.textContent = text
        err.hidden = false
        el.setAttribute('aria-invalid', 'true')
      } }
    })
    const error = h('div', { class: 'form-error pre', role: 'alert' })
    const guard = opts.danger ? serverGuard() : null
    const form = h(
      'form',
      { class: 'form', novalidate: true },
      opts.intro ? h('p', { class: 'form-intro' }, opts.intro) : null,
      inputs.map(({ f, el, hint, err }) =>
        h(
          'label',
          { class: f.type === 'checkbox' ? 'field field-check' : 'field' },
          h('span', { class: 'field-label' }, f.label, f.required ? h('span', { class: 'field-req', 'aria-hidden': 'true' }, ' *') : null),
          el,
          hint,
          err,
        ),
      ),
      guard?.node ?? null,
      error,
    )
    const ok = h('button', { class: opts.danger ? 'btn btn-danger' : 'btn btn-primary', type: 'button' }, opts.submit ?? 'Save')
    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel')
    const d = dialog(opts.title, [form], [cancel, ok], () => resolve(result))
    const submit = async () => {
      const values: Record<string, string | number | boolean> = {}
      let first: HTMLElement | null = null
      error.textContent = ''
      for (const { f, el, show } of inputs) {
        const v = fieldValue(el, f)
        const problem = fieldProblem(f, el, v)
        if (problem) {
          show(problem)
          first ??= el
        }
        values[f.name] = v
      }
      if (first) {
        first.focus()
        return
      }
      const p = guard?.check() ?? null
      if (p) {
        error.textContent = p
        return
      }
      if (opts.onSubmit) {
        ok.disabled = true
        try {
          await opts.onSubmit(values)
        } catch (e) {
          error.textContent = errorText(e)
          ok.disabled = false
          return
        }
      }
      result = values
      d.close()
    }
    ok.addEventListener('click', () => void submit())
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      void submit()
    })
    cancel.addEventListener('click', () => d.close())
    ;(inputs[0]?.el ?? ok).focus()
  })
}

let fieldN = 0

/** What is wrong with a field's value (shown under the field), or null. */
function fieldProblem(f: Field, el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, v: string | number | boolean): string | null {
  if (f.type === 'number' && el instanceof HTMLInputElement && el.validity.badInput) return 'Enter a number.'
  if (f.required && (v === '' || (typeof v === 'number' && Number.isNaN(v)))) return `${f.label} is required.`
  if (typeof v === 'number' && !Number.isNaN(v)) {
    if (f.min !== undefined && v < f.min) return `At least ${fmtNum(f.min)}.`
    if (f.max !== undefined && v > f.max) return `At most ${fmtNum(f.max)}.`
  }
  return null
}

// ---- table ------------------------------------------------------------------------------------------------------

export interface Column<T> {
  label: string
  render: (row: T) => Child | Child[]
  class?: string
  /** The column shown as the card title when the table is stacked on phones (default: the first labelled one). */
  primary?: boolean
}

/** Marks a cell that shows nothing (stacked rows on phones hide it rather than show a bare label). */
function markEmpty(td: HTMLTableCellElement): HTMLTableCellElement {
  if (!td.textContent?.trim() && !td.querySelector('img, svg, button, input, select, .icon')) td.classList.add('cell-empty')
  return td
}

export interface TableHandle {
  root: HTMLElement
  reload(): Promise<void>
}

/** A searchable, paged table over an AdminPage endpoint. */
export function dataTable<T>(opts: {
  columns: Column<T>[]
  load: (q: string, page: number, size: number) => Promise<AdminPage<T>>
  onRow?: (row: T) => void
  placeholder?: string
  size?: number
  filters?: HTMLElement[]
  empty?: string
  search?: boolean
}): TableHandle {
  let q = ''
  let page = 0
  const size = opts.size ?? 50
  const search = h('input', { class: 'input search-input', type: 'search', placeholder: opts.placeholder ?? 'Search', 'aria-label': opts.placeholder ?? 'Search', enterkeyhint: 'search' })
  const tbody = h('tbody')
  const info = h('span', { class: 'pager-info' })
  const prev = h('button', { class: 'btn btn-small', type: 'button', 'aria-label': 'Previous page' }, svgIcon('chevronLeft'), h('span', { class: 'btn-text' }, 'Prev'))
  const next = h('button', { class: 'btn btn-small', type: 'button', 'aria-label': 'Next page' }, h('span', { class: 'btn-text' }, 'Next'), svgIcon('chevronRight'))
  const nav = h('div', { class: 'pager-nav' }, prev, next)
  // The main column (the card title of a stacked row on phones): the marked one, else the first labelled non-icon one.
  const marked = opts.columns.findIndex((c) => c.primary)
  const primary = marked >= 0 ? marked : opts.columns.findIndex((c) => c.label && !/\bicon-cell\b/.test(c.class ?? ''))
  const cellClass = (c: Column<T>, i: number) => [c.class, i === primary ? 'cell-primary' : null].filter(Boolean).join(' ') || undefined
  const table = h(
    'table',
    { class: 'table table-stack' },
    h('thead', null, h('tr', null, opts.columns.map((c) => h('th', { class: c.class, scope: 'col' }, c.label || h('span', { class: 'sr-only' }, /\brow-actions\b/.test(c.class ?? '') ? 'Actions' : 'Icon'))))),
    tbody,
  )
  const state = (node: Node) => h('tr', { class: 'state-row' }, h('td', { class: 'state', colspan: opts.columns.length }, node))
  tbody.append(state(h('span', { class: 'loading-text' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…')))
  const root = h(
    'div',
    { class: 'table-wrap' },
    h('div', { class: 'toolbar' }, opts.search === false ? null : h('div', { class: 'search' }, svgIcon('search', 'svg-icon search-icon'), search), opts.filters ?? []),
    h('div', { class: 'table-scroll table-viewport' }, table),
    h('div', { class: 'pager' }, info, nav),
  )
  let seq = 0
  const reload = async () => {
    const mine = ++seq
    tbody.classList.add('loading')
    tbody.setAttribute('aria-busy', 'true')
    try {
      const r = await opts.load(q, page, size)
      if (mine !== seq) return
      clear(
        tbody,
        r.rows.length === 0
          ? state(emptyState(opts.empty ?? (q ? `Nothing matches “${q}”.` : 'Nothing found.')))
          : r.rows.map((row) => {
              const tr = h('tr', { class: opts.onRow ? 'clickable' : undefined }, opts.columns.map((c, i) => markEmpty(h('td', { class: cellClass(c, i), 'data-label': c.label || undefined }, c.render(row)))))
              if (opts.onRow) tr.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('button, a, input, select')) return
                opts.onRow!(row)
              })
              return tr
            }),
      )
      const from = r.total === 0 ? 0 : r.page * r.size + 1
      info.textContent = r.total === 0 ? '0 results' : `${fmtNum(from)}–${fmtNum(Math.min(r.total, (r.page + 1) * r.size))} of ${fmtNum(r.total)}`
      prev.disabled = r.page === 0
      next.disabled = (r.page + 1) * r.size >= r.total
      nav.hidden = prev.disabled && next.disabled
    } catch (e) {
      if (mine === seq) clear(tbody, state(emptyState(errorText(e), 'alert', true)))
    } finally {
      if (mine === seq) {
        tbody.classList.remove('loading')
        tbody.removeAttribute('aria-busy')
      }
    }
  }
  let timer = 0
  search.addEventListener('input', () => {
    clearTimeout(timer)
    timer = window.setTimeout(() => {
      q = search.value.trim()
      page = 0
      void reload()
    }, 250)
  })
  prev.addEventListener('click', () => {
    page = Math.max(0, page - 1)
    void reload()
  })
  next.addEventListener('click', () => {
    page++
    void reload()
  })
  void reload()
  return {
    root,
    reload: () => {
      page = Math.max(0, page)
      return reload()
    },
  }
}

// ---- bits ---------------------------------------------------------------------------------------------------------

export function badge(text: string, kind: 'gold' | 'ok' | 'bad' | 'dim' | 'info' = 'dim'): HTMLElement {
  return h('span', { class: `badge badge-${kind}` }, text)
}

export function button(label: string, onclick: () => void, kind: 'primary' | 'danger' | 'plain' | 'small' = 'plain'): HTMLButtonElement {
  const cls = kind === 'primary' ? 'btn btn-primary' : kind === 'danger' ? 'btn btn-danger' : kind === 'small' ? 'btn btn-small' : 'btn'
  return h('button', { class: cls, type: 'button', onclick }, label)
}

export function card(title: string | Node | null, ...children: (Child | Child[])[]): HTMLElement {
  return h('section', { class: 'card' }, title ? h('h3', { class: 'card-title' }, title) : null, ...children)
}

/** A card's title row with something on its right (a count, a button). */
export function cardHead(title: string, ...aside: (Child | Child[])[]): HTMLElement {
  return h('div', { class: 'card-head' }, h('h3', { class: 'card-title' }, title), h('div', { class: 'card-aside' }, ...aside))
}

/** The page's title, a one-line description and its primary actions (on the right; below the title on phones). */
export function pageHeader(title: string | { text: string; icon?: Node | null }, sub?: string, ...actions: HTMLElement[]): HTMLElement {
  const t = typeof title === 'string' ? { text: title, icon: null } : title
  return h(
    'header',
    { class: 'page-header' },
    h('div', { class: 'page-heading' }, t.icon ? h('div', { class: 'page-icon' }, t.icon) : null, h('div', { class: 'page-titles' }, h('h1', null, t.text), sub ? h('p', { class: 'page-sub' }, sub) : null)),
    actions.length ? h('div', { class: 'actions page-actions' }, actions) : null,
  )
}

/** A centred icon and line for an empty list or a failed load. */
export function emptyState(text: string, name: IconName = 'inbox', error = false): HTMLElement {
  return h('div', { class: error ? 'empty-state error' : 'empty-state' }, svgIcon(name, 'svg-icon empty-icon'), h('div', { class: 'pre' }, text))
}

/**
 * Labels a hand-built table's cells with their column names so it turns into stacked cards on phones, like dataTable.
 * `primary` is the column shown as each card's title (default: the first labelled column).
 */
export function stackTable(table: HTMLTableElement, primary?: number): HTMLTableElement {
  const heads = [...(table.tHead?.rows[0]?.cells ?? [])].map((c) => c.textContent?.trim() ?? '')
  const main = primary ?? heads.findIndex((x) => x !== '')
  table.classList.add('table-stack')
  for (const body of table.tBodies) {
    for (const tr of body.rows) {
      ;[...tr.cells].forEach((td, i) => {
        if (heads[i]) td.dataset.label = heads[i]
        if (i === main) td.classList.add('cell-primary')
        markEmpty(td)
      })
    }
  }
  return table
}

export function kv(rows: [string, Child | Child[]][]): HTMLElement {
  return h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return 'never'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'never'
  return `${fmtDuration(Math.abs(now - ms))} ${ms <= now ? 'ago' : 'from now'}`
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const hrs = Math.floor(m / 60)
  if (hrs < 48) return `${hrs}h ${m % 60}m`
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`
}

export function fmtNum(n: number): string {
  return n.toLocaleString('en-US')
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function link(label: string, href: string): HTMLAnchorElement {
  return h('a', { href, class: 'link' }, label)
}

export function tabs(items: { id: string; label: string; render: (root: HTMLElement) => void }[], initial?: string): HTMLElement {
  const bar = h('div', { class: 'tabs', role: 'tablist' })
  const body = h('div', { class: 'tab-body', role: 'tabpanel' })
  const show = (id: string) => {
    for (const b of bar.querySelectorAll('button')) {
      const on = b.dataset.tab === id
      b.classList.toggle('active', on)
      b.setAttribute('aria-selected', String(on))
      b.tabIndex = on ? 0 : -1
    }
    const it = items.find((x) => x.id === id) ?? items[0]
    body.replaceChildren()
    it.render(body)
  }
  for (const it of items) {
    const b = h('button', { class: 'tab', type: 'button', role: 'tab', 'data-tab': it.id }, it.label)
    b.addEventListener('click', () => show(it.id))
    bar.appendChild(b)
  }
  // Arrow keys move between tabs (the WAI-ARIA tabs pattern).
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const list = [...bar.querySelectorAll<HTMLButtonElement>('button')]
    const at = list.findIndex((b) => b.classList.contains('active'))
    const to = list[(at + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length]
    show(to.dataset.tab!)
    to.focus()
    to.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
  show(initial ?? items[0].id)
  return h('div', { class: 'tabs-wrap' }, h('div', { class: 'tabs-scroll' }, bar), body)
}

/** Goes to a panel route, e.g. navigate(`accounts/12`). */
export function navigate(path: string): void {
  location.hash = `#/${path}`
}
