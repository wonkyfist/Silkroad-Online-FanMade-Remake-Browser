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
import { RadioGroup } from './check.ts'
import { Frame } from './frame.ts'
import { kitArt } from './host.ts'
import { NumberInput, parseAmount, TextInput } from './input.ts'
import { FRAMES } from './skins.ts'

export const MSGBOX_W = 300
/** The panel behind each radio group of a `choose` box (`ifsetpartymode.txt` GDR_SETPARTYMODE_BG_BOX_0n, 128×52). */
const CHOICE_PANEL = 'messagebox/msgbox_blackbox_03'
export const MSGBOX_H = { simple: 140, count: 180, prompt: 170, choose: 236 } as const

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

/** One choice of a `choose` box group. `hint` shows under the groups while the choice is selected. */
export interface Choice<V extends string> {
  value: V
  label: string
  hint?: string
}

/** One radio group of a `choose` box (a caption over a `msgbox_blackbox_03` panel). */
export interface ChoiceGroup<V extends string> {
  caption: string
  choices: readonly Choice<V>[]
  value: V
}

export interface ChooseOptions<V extends string> {
  title?: string
  text: string
  /** Side by side (two fit the box), as the retail party setting box (`ifsetpartymode.txt`). */
  groups: readonly ChoiceGroup<V>[]
  ok?: string
  cancel?: string
  art?: Art
}

/** The hint lines a `choose` box shows for the current values (one per group that has a hint). */
export function choiceHints<V extends string>(groups: readonly ChoiceGroup<V>[], values: readonly V[]): string[] {
  const out: string[] = []
  groups.forEach((g, i) => {
    const hint = g.choices.find(c => c.value === values[i])?.hint
    if (hint) out.push(hint)
  })
  return out
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

  /**
   * Radio groups side by side (the retail party setting box: "Set the party properties." with an EXP and an item
   * group); resolves with the chosen value of each group in order, or null when cancelled.
   */
  choose<V extends string>(o: ChooseOptions<V>): Promise<V[] | null> {
    return new Promise(resolve => {
      const art = o.art ?? kitArt()
      const done = (v: V[] | null) => {
        box.close()
        resolve(v)
      }
      const values = o.groups.map(g => g.value)
      const submit = () => done([...values])
      const box = openBox(art, o.title, MSGBOX_H.choose, () => done(null), submit)
      const hints = el('div', 'kit-msgbox-hints kit-t-small')
      const showHints = () => hints.replaceChildren(...choiceHints(o.groups, values).map(h => el('div', '', h)))
      const row = el('div', 'kit-msgbox-choose')
      let first: HTMLInputElement | null = null
      o.groups.forEach((g, i) => {
        const radios = new RadioGroup<V>(art, g.choices, { value: g.value, vertical: true })
        radios.onChange = v => {
          values[i] = v
          showHints()
        }
        const panel = el('div', 'kit-msgbox-choice', radios.root)
        if (art.has(CHOICE_PANEL)) panel.style.backgroundImage = art.cssUrl(CHOICE_PANEL)
        else panel.classList.add('no-art')
        row.append(el('div', 'kit-msgbox-group', el('div', 'kit-msgbox-caption kit-t-label', g.caption), panel))
        first ??= radios.root.querySelector('input:checked') ?? radios.root.querySelector('input')
      })
      showHints()
      const ok = button(art, { label: o.ok ?? t('kit.ok'), primary: true }, submit)
      const cancel = button(art, { label: o.cancel ?? t('kit.cancel') }, () => done(null))
      box.frame.body.append(text(o.text), row, hints, buttons(ok, cancel))
      ;(first as HTMLInputElement | null)?.focus()
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
