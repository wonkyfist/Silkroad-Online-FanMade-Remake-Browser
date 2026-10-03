/**
 * Interface click sounds (docs/SOUND.md §5.11): one delegated capture listener for every screen. A click on a
 * `<button>` (Art.button makes real buttons) or on anything with `data-sfx` plays `ui.<data-sfx>`, default
 * `ui.click`; `data-sfx="none"` and disabled buttons stay silent (the window close button plays its own close cue).
 */

/** The cue a click on `target` plays, or null. */
export function clickCue(target: EventTarget | null): string | null {
  const t = target as { closest?: (sel: string) => Element | null } | null
  const b = t && typeof t.closest === 'function' ? t.closest('button, [data-sfx]') : null
  if (!b) return null
  const sfx = (b as HTMLElement).dataset?.sfx
  if (sfx === 'none') return null
  if ((b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true') return null
  return `ui.${sfx || 'click'}`
}

/** Installs the listener; returns its remover. */
export function installUiSounds(play: (cue: string) => void, doc: Document = document): () => void {
  const onClick = (e: Event) => {
    const cue = clickCue(e.target)
    if (cue) play(cue)
  }
  doc.addEventListener('click', onClick, true)
  return () => doc.removeEventListener('click', onClick, true)
}
