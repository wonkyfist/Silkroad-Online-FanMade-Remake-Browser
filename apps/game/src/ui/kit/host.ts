/**
 * The kit's shared art: `App` registers the loaded manifest once (setKitArt), so controls that open on their own
 * (MessageBox, cursors, the gallery) find it without threading `Art` through every call. Components that are built
 * by a window still take `art` explicitly.
 */
import { Art } from '../art.ts'
import { CONTROLS, FRAMES } from './skins.ts'

let current: Art | null = null

export function setKitArt(art: Art): void {
  current = art
  preloadKitArt(art)
}

/** The registered art, or an empty manifest (every control then draws its CSS stand-in). */
export function kitArt(): Art {
  return (current ??= new Art(null))
}

/** Kept so the preloads are not collected before they land in the image cache. */
const preloaded: HTMLImageElement[] = []

/**
 * Fetches the art every window draws (each frame's nine-slice sheet and fill, the close button, the Main window's
 * side strip and the scroll parts) once at start, so a window opened for the first time never shows its text for a
 * moment without its chrome (I7B: the first I showed a bare Inventory for about half a second).
 */
export function preloadKitArt(art: Art): void {
  if (typeof Image === 'undefined' || preloaded.length) return
  const keys = new Set<string>()
  for (const f of Object.values(FRAMES)) {
    keys.add(`${f.prefix}9`)
    if ('fill' in f && f.fill) keys.add(f.fill)
  }
  for (const k of [CONTROLS.close, CONTROLS.mainTabStrip, CONTROLS.scrollThumb, CONTROLS.scrollTrack, CONTROLS.scrollUp, CONTROLS.scrollDown, CONTROLS.grayLine]) keys.add(k)
  for (const k of keys) {
    if (!art.hasCropped(k)) continue
    const img = new Image()
    img.decoding = 'async'
    img.src = art.url(k)
    preloaded.push(img)
  }
}
