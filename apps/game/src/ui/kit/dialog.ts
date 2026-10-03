/**
 * Message boxes (docs/UI.md §4.6, M13): modal dialogs in the `msgbox2_window_` frame, about 300 px wide.
 *   MessageBox.confirm({text})          → true / false
 *   MessageBox.count({text, max})       → an amount 1..max, or null (the retail MsgBoxDivideCount: spin + field)
 *   MessageBox.prompt({text, maxLength}) → trimmed text, or null
 *   MessageBox.info({text})             → resolves when closed
 * Enter confirms, Esc cancels, a press on the shade cancels. Keys typed while one is open never reach the game.
 * The layer lives on <body> and zooms itself (--ui), so it works on every screen and in the kit gallery.
 */
import { t } from '../../i18n/index.ts'
import type { Art } from '../art.ts'
import { el } from '../dom.ts'
import { button } from './button.ts'
import { Frame } from './frame.ts'
import { kitArt } from './host.ts'
import { NumberInput, parseAmount, TextInput } from './input.ts'
import { FRAMES } from './skins.ts'

export const MSGBOX_W = 300
export const MSGBOX_H = { simple: 140, count: 180, prompt: 170 } as const

export interface ConfirmOptions {
  title?: string
  text: string
  ok?: string
  cancel?: string
  art?: Art
}

export interface CountOptions {
  title?: string
  text: string
  max: number
  min?: number
  initial?: number
  ok?: string
  art?: Art
}

export interface PromptOptions {
  title?: string
  text: string
  maxLength: number
  initial?: string
  ok?: string
  /** Allow an empty answer (default false: OK stays refused until something is typed). */
  allowEmpty?: boolean
  art?: Art
}

/** The amount a count box returns for its field text, or null (refused: not a whole number in range). */
export function countResult(text: string, max: number, min = 1): number | null {
  return max >= min ? parseAmount(text, min, max) : null
}

/** The text a prompt returns for its field text, or null (refused). */
export function promptResult(text: string, maxLength: number, allowEmpty = false): string | null {
  const s = text.trim()
  if (!allowEmpty && !s) return null
  return s.length <= maxLength ? s : null
}

/** A starting amount inside [min, max] (the retail box starts at the whole stack). */
export function initialCount(max: number, initial?: number, min = 1): number {
  const v = initial ?? max
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(v) ? v : max)))
}

let openCount = 0

interface Box {
  frame: Frame
  shade: HTMLElement
  close(): void
}

function openBox(art: Art, title: string | undefined, h: number, onCancel: () => void, onEnter: () => void): Box {
  const shade = el('div', 'kit-modal')
  const frame = new Frame(art, 'dialog', { w: MSGBOX_W, h, className: 'kit-msgbox' })
  const caption = el('div', 'kit-msgbox-title kit-t-title', title ?? '')
  caption.style.height = `${FRAMES.dialog.title}px`
  caption.style.lineHeight = `${FRAMES.dialog.title}px`
  frame.root.append(caption)
  frame.root.setAttribute('role', 'dialog')
  frame.root.setAttribute('aria-modal', 'true')
  if (title) frame.root.setAttribute('aria-label', title)
  shade.append(frame.root)
  shade.addEventListener('keydown', ev => {
    ev.stopPropagation()
    if (ev.key === 'Enter') {
      ev.preventDefault()
      onEnter()
    } else if (ev.key === 'Escape') {
      ev.preventDefault()
      onCancel()
    }
  })
  shade.addEventListener('keyup', ev => ev.stopPropagation())
  shade.addEventListener('pointerdown', ev => {
    if (ev.target === shade) onCancel()
    ev.stopPropagation()
  })
  shade.addEventListener('contextmenu', ev => ev.preventDefault())
  document.body.append(shade)
  openCount++
  let closed = false
  return {
    frame,
    shade,
    close() {
      if (closed) return
      closed = true
      openCount--
      shade.remove()
    },
  }
}

function text(s: string): HTMLElement {
  return el('div', 'kit-msgbox-text kit-t-body', s)
}

function buttons(...bs: HTMLElement[]): HTMLElement {
  return el('div', 'kit-msgbox-buttons', ...bs)
}

export const MessageBox = {
  /** True while any message box is open (the game's KeyMap may treat it as modal). */
  isOpen(): boolean {
    return openCount > 0
  },

  confirm(o: ConfirmOptions): Promise<boolean> {
    return new Promise(resolve => {
      const done = (v: boolean) => {
        box.close()
        resolve(v)
      }
      const box = openBox(o.art ?? kitArt(), o.title, MSGBOX_H.simple, () => done(false), () => done(true))
      const art = o.art ?? kitArt()
      const ok = button(art, { label: o.ok ?? t('kit.yes'), primary: true }, () => done(true))
      const no = button(art, { label: o.cancel ?? t('kit.no') }, () => done(false))
      box.frame.body.append(text(o.text), buttons(ok, no))
      ok.focus()
    })
  },

  info(o: Omit<ConfirmOptions, 'cancel'>): Promise<void> {
    return new Promise(resolve => {
      const done = () => {
        box.close()
        resolve()
      }
      const art = o.art ?? kitArt()
      const box = openBox(art, o.title, MSGBOX_H.simple, done, done)
      const ok = button(art, { label: o.ok ?? t('kit.ok'), primary: true }, done)
      box.frame.body.append(text(o.text), buttons(ok))
      ok.focus()
    })
  },

  count(o: CountOptions): Promise<number | null> {
    return new Promise(resolve => {
      const min = o.min ?? 1
      const art = o.art ?? kitArt()
      const done = (v: number | null) => {
        box.close()
        resolve(v)
      }
      const submit = () => {
        const n = countResult(field.input.value, o.max, min)
        if (n === null) {
          err.textContent = t('kit.count.bad', { min, max: o.max })
          field.root.classList.add('invalid')
          return
        }
        done(n)
      }
      const box = openBox(art, o.title, MSGBOX_H.count, () => done(null), submit)
      const field = new NumberInput(art, { min, max: Math.max(min, o.max), value: initialCount(o.max, o.initial, min), label: t('kit.count.label'), w: 110 })
      const err = el('div', 'kit-msgbox-error kit-t-small')
      const row = el('div', 'kit-msgbox-count', el('span', 'kit-t-label', t('kit.count.label')), field.root, el('span', 'kit-t-value kit-num', t('kit.count.max', { max: o.max })))
      const ok = button(art, { label: o.ok ?? t('kit.ok'), primary: true }, submit)
      const cancel = button(art, { label: t('kit.cancel') }, () => done(null))
      box.frame.body.append(text(o.text), row, err, buttons(ok, cancel))
      field.focus()
    })
  },

  prompt(o: PromptOptions): Promise<string | null> {
    return new Promise(resolve => {
      const art = o.art ?? kitArt()
      const done = (v: string | null) => {
        box.close()
        resolve(v)
      }
      const submit = () => {
        const s = promptResult(field.value, o.maxLength, o.allowEmpty)
        if (s === null) {
          field.root.classList.add('invalid')
          return
        }
        done(s)
      }
      const box = openBox(art, o.title, MSGBOX_H.prompt, () => done(null), submit)
      const field = new TextInput(art, { value: o.initial ?? '', maxLength: o.maxLength, w: 260, label: o.text })
      field.input.addEventListener('input', () => field.root.classList.remove('invalid'))
      const ok = button(art, { label: o.ok ?? t('kit.ok'), primary: true }, submit)
      const cancel = button(art, { label: t('kit.cancel') }, () => done(null))
      box.frame.body.append(text(o.text), field.root, buttons(ok, cancel))
      field.focus(true)
    })
  },
}
