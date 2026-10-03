/**
 * Item and skill icons (docs/UI.md §5.1) from the icon index (`ItemCatalog.icon(code)` and the skill catalog give the
 * URL). Without a picture: the item's initials on its colour, like today's slots.
 */
import { el } from '../dom.ts'
import { initials } from './slot.ts'

export interface IconOptions {
  size?: number
  /** Shown when there is no URL (a name: its initials are drawn). */
  name?: string
  colour?: string
  title?: string
  className?: string
}

export function Icon(url: string | null | undefined, opts: IconOptions = {}): HTMLElement {
  const size = opts.size ?? 32
  const d = el('div', `kit-icon ${opts.className ?? ''}`.trim())
  d.style.width = `${size}px`
  d.style.height = `${size}px`
  if (opts.title) d.title = opts.title
  if (url) d.style.backgroundImage = `url("${url}")`
  else {
    d.classList.add('fallback')
    if (opts.colour) d.style.backgroundColor = opts.colour
    d.append(el('span', '', initials(opts.name ?? '?')))
  }
  return d
}
