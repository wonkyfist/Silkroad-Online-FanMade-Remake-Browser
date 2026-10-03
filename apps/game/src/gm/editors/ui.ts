/**
 * Small DOM builders of the GM content editors (lane ED-C), in the GM window's look (ifcommon buttons, gm-field inputs).
 */
import { t } from '../../i18n/index.ts'
import type { Art } from '../../ui/art.ts'
import { el, input } from '../../ui/dom.ts'

let listSeq = 0

export function edButton(art: Art, label: string, w = 76, title?: string): HTMLButtonElement {
  const b = art.button(label, { key: 'ifcommon/com_button', w, h: 24, className: 'gm-button' })
  if (title) b.title = title
  return b
}

export function edSmall(art: Art, label: string, w = 50, title?: string): HTMLButtonElement {
  const b = art.button(label, { key: 'ifcommon/com_s_button', w, h: 20, className: 'gm-button gm-small' })
  if (title) b.title = title
  return b
}

/** A plain small text button (lists inside the Quest Editor form). */
export function miniButton(label: string, title?: string): HTMLButtonElement {
  const b = el('button', 'gm-qe-mini', label)
  b.type = 'button'
  if (title) b.title = title
  return b
}

export function edField(cls: string, aria: string, value = ''): HTMLInputElement {
  const f = input(`gm-field ${cls}`, 'text', { 'aria-label': aria })
  f.value = value
  return f
}

export function edArea(aria: string, value = ''): HTMLTextAreaElement {
  const a = el('textarea', 'gm-field')
  a.setAttribute('aria-label', aria)
  a.spellcheck = true
  a.value = value
  return a
}

export function edSection(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
  return el('div', 'gm-section', el('div', 'gm-section-title', title), ...children)
}

export function edLine(...children: (HTMLElement | string | null)[]): HTMLElement {
  return el('div', 'gm-line', ...children)
}

export function edLabel(text: string): HTMLElement {
  return el('label', 'gm-label', text)
}

/** A native checkbox with a label; `box.checked` is the value. */
export function edCheck(label: string, title?: string): { root: HTMLElement; box: HTMLInputElement } {
  const box = input('gm-ed-checkbox', 'checkbox', { 'aria-label': label })
  const root = el('label', 'gm-check', box, el('span', '', label))
  if (title) root.title = title
  return { root, box }
}

/** A datalist (suggestions for a field: value = code, label = name) with a unique id. */
export function edDatalist(prefix: string): HTMLDataListElement {
  const d = el('datalist')
  d.id = `${prefix}-${++listSeq}`
  return d
}

export function fillDatalist(list: HTMLDataListElement, entries: Iterable<[string, string]>): void {
  const out: HTMLOptionElement[] = []
  for (const [value, label] of entries) {
    const o = el('option', '', label)
    o.value = value
    out.push(o)
  }
  list.replaceChildren(...out)
}

export function edSelect(options: readonly (readonly [string, string])[], value = ''): HTMLSelectElement {
  const s = el('select', 'gm-field')
  setOptions(s, options, value)
  return s
}

export function setOptions(s: HTMLSelectElement, options: readonly (readonly [string, string])[], value = s.value): void {
  s.replaceChildren(
    ...options.map(([v, label]) => {
      const o = el('option', '', label)
      o.value = v
      return o
    }),
  )
  s.value = options.some(([v]) => v === value) ? value : (options[0]?.[0] ?? '')
}

/** "12.3 m" style distance. */
export function fmtDist(m: number): string {
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} m`
}

/** Short label of where a record comes from (list badges). */
export function srcLabel(src: 'export' | 'patched' | 'authored' | 'disabled' | 'hidden' | 'repo' | 'override'): string {
  switch (src) {
    case 'export':
      return t('gm.editor.src.export')
    case 'patched':
      return t('gm.editor.src.patched')
    case 'authored':
      return t('gm.editor.src.authored')
    case 'disabled':
      return t('gm.editor.src.disabled')
    case 'hidden':
      return t('gm.editor.src.hidden')
    case 'repo':
      return t('gm.editor.src.repo')
    case 'override':
      return t('gm.editor.src.override')
  }
}
