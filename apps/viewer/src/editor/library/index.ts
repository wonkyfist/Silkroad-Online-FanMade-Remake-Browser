/**
 * Lane WE-L, the World Editor's library (docs/WORLD_EDITOR.md §4.5, D24–D26; docs/WAVE_PLAN8.md §6.2 WE-L, D16, D17):
 * the classification (classify.ts), the list with the Trees tab of the new species placed as their carriers
 * (library.ts, through T12-E), the thumbnails (thumbs.ts) and the tree preview of a held tree (tree-look.ts).
 * The editor page (WE-U) builds the list rows with `renderLibraryRow`.
 */
import type { EditorLibraryItem } from './library.ts'
import type { LibraryThumbs } from './thumbs.ts'

export { classifyModels, placementSources, speciesIdOfModel, stemOf, tabOfSource, type HiddenWhy, type ModelClass } from './classify.ts'
export { buildLibrary, fetchTreeLibrary, filterLibrary, type EditorLibrary, type EditorLibraryItem, type LibraryOptions } from './library.ts'
export { LibraryThumbs, THUMB_LAYER, THUMB_OWNER, THUMB_SIZE, encodePng, frameBox, thumbKey, type ThumbHost } from './thumbs.ts'
export { TreeLook } from './tree-look.ts'

/** The URL of `content/trees/library.json` as the editor's dev server serves it (the repo file, like palette.json). */
export const TREE_LIBRARY_URL = new URL('../../../../../content/trees/library.json', import.meta.url)

let observer: IntersectionObserver | null = null
const pending = new WeakMap<Element, () => void>()

/** Calls `show` once the element scrolls into the list's view (at once without IntersectionObserver). */
function whenShown(el: Element, show: () => void): void {
  if (typeof IntersectionObserver === 'undefined') return show()
  observer ??= new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      observer!.unobserve(e.target)
      const f = pending.get(e.target)
      pending.delete(e.target)
      f?.()
    }
  }, { rootMargin: '200px' })
  pending.set(el, show)
  observer.observe(el)
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

/**
 * Fills one list row: the thumbnail (the species' own, a cached render, or one asked for when the row shows), the name
 * and a line (tab · uses, or why a species can't be placed yet). Returns false for a row that must not place.
 */
export function renderLibraryRow(el: HTMLElement, item: EditorLibraryItem, thumbs: LibraryThumbs | null): boolean {
  const sub = item.kind === 'species'
    ? `${item.species?.kind === 'plant' ? 'new plant' : 'new tree'} · ${item.uses}×`
    : `${item.tab} · ${item.uses}×`
  el.classList.add('lib-row')
  if (!item.placeable) el.classList.add('lib-off')
  el.title = item.note ? `${item.source}\n${item.note}` : item.source
  el.innerHTML = `<i class="lib-thumb"></i><span>${esc(item.name)}</span><small>${esc(item.placeable ? sub : item.note ?? 'not placeable')}</small>`
  const img = el.querySelector<HTMLElement>('.lib-thumb')!
  const set = (url: string | null) => {
    if (url) img.style.backgroundImage = `url("${url}")`
    else img.classList.add('lib-none')
  }
  const now = thumbs ? thumbs.known(item) : item.thumb ?? null
  if (now !== undefined) set(now)
  else if (thumbs) whenShown(el, () => thumbs.request(item, set))
  return item.placeable
}

/** The rows' look (added once to the page). */
export const LIBRARY_CSS = `
.lib-row { display: grid; grid-template-columns: 40px 1fr; grid-template-rows: auto auto; column-gap: 8px; align-items: center; }
.lib-row > .lib-thumb { grid-row: 1 / span 2; width: 40px; height: 40px; border-radius: 4px; background: rgba(255,255,255,0.06) center / contain no-repeat; }
.lib-row > .lib-thumb.lib-none { background-color: rgba(255,255,255,0.03); }
.lib-row.lib-off { opacity: 0.5; cursor: default; }
`

/** Adds LIBRARY_CSS to the page once. */
export function installLibraryCss(doc: Document = document): void {
  if (doc.getElementById('sro-library-css')) return
  const s = doc.createElement('style')
  s.id = 'sro-library-css'
  s.textContent = LIBRARY_CSS
  doc.head.appendChild(s)
}
