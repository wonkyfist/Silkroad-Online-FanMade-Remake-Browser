/** Tiny DOM helpers: the UI is plain DOM/CSS over the canvas. */

type Child = Node | string | null | undefined | false

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (className) e.className = className
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c)
  return e
}

export type Rect = [number, number, number, number]

/** Absolute placement in a window's native pixel space (resinfo rects are x, y, w, h). */
export function place<T extends HTMLElement>(e: T, [x, y, w, h]: Rect): T {
  e.style.position = 'absolute'
  e.style.left = `${x}px`
  e.style.top = `${y}px`
  if (w) e.style.width = `${w}px`
  if (h) e.style.height = `${h}px`
  return e
}

export function input(className: string, type: string, attrs: Record<string, string> = {}): HTMLInputElement {
  const i = el('input', className)
  i.type = type
  i.spellcheck = false
  i.autocomplete = 'off'
  for (const [k, v] of Object.entries(attrs)) i.setAttribute(k, v)
  return i
}

/** Removes listeners registered through it in one go. */
export class Listeners {
  private offs: (() => void)[] = []

  on<K extends keyof WindowEventMap>(target: Window, type: K, fn: (ev: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void
  on<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (ev: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions): void
  on<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (ev: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void
  on(target: EventTarget, type: string, fn: (ev: never) => void, opts?: AddEventListenerOptions): void {
    const f = fn as EventListener
    target.addEventListener(type, f, opts)
    this.offs.push(() => target.removeEventListener(type, f, opts))
  }

  add(off: () => void): void {
    this.offs.push(off)
  }

  clear(): void {
    for (const off of this.offs.splice(0)) off()
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
