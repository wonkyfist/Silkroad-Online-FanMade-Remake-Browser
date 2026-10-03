/**
 * Text by token (docs/UI.md §4.3): every label, value and level number takes its font and colour from one class,
 * never from a literal. `Row` is the common "label left, value right" line.
 */
import { el } from '../dom.ts'

export type TextStyle = 'title' | 'caption' | 'label' | 'value' | 'level' | 'gauge' | 'small' | 'button' | 'chat' | 'body' | 'paper'
export const TEXT_STYLES: readonly TextStyle[] = ['title', 'caption', 'label', 'value', 'level', 'gauge', 'small', 'button', 'chat', 'body', 'paper']

/** A text span in a token style; `fit` adds the ellipsis rule and a title with the full text. */
export function Label(text: string, style: TextStyle = 'label', opts: { className?: string; fit?: boolean } = {}): HTMLSpanElement {
  const s = el('span', `kit-t-${style} ${opts.fit ? 'kit-fit' : ''} ${opts.className ?? ''}`.trim(), text)
  if (opts.fit) s.title = text
  return s
}

/** A value (white, tabular numbers). */
export function Value(text: string, opts: { className?: string; fit?: boolean } = {}): HTMLSpanElement {
  return Label(text, 'value', { ...opts, className: `kit-num ${opts.className ?? ''}` })
}

/** A label/value line; `value` may be any element (a control). */
export function Row(label: string, value: Node | string, opts: { className?: string } = {}): HTMLDivElement {
  return el('div', `kit-row ${opts.className ?? ''}`.trim(), Label(label, 'label', { fit: true }), typeof value === 'string' ? Value(value) : value)
}

/** Updates a Label/Value's text (and its title when it is a fitted label). */
export function setText(e: HTMLElement, text: string): void {
  e.textContent = text
  if (e.classList.contains('kit-fit')) e.title = text
}
