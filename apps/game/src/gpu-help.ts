/**
 * The "3D view is black" help (the 2026-10-05 incident, second part): after Chrome's GPU process crashed (low RAM with
 * other GPU-heavy programs open), Chrome runs its renderers with software compositing, and then both WebGPU and WebGL2
 * canvases can stay black on screen while the page sees nothing wrong (the real adapter, no errors, no lost device).
 * The game cannot repair the browser; this panel says what can: another browser (Edge), or ending Chrome's GPU process
 * in its task manager (Shift+Esc) and reloading, which keeps the other tabs open.
 *
 * Shown by gpu-loss.ts when the watchdog sees black output that switching cannot fix, and on request (Esc menu →
 * "Screen black?", the login screen's link). Non-blocking: a panel over the canvas, the HUD stays usable. One at a time.
 */
import { t } from './i18n/index.ts'
import type { Art } from './ui/art.ts'
import { el } from './ui/dom.ts'
import { button } from './ui/kit/button.ts'

export interface GpuHelpOptions {
  /** The watchdog saw it (the text says so); false: the player opened the help. */
  detected: boolean
  /** WebGPU runs now: offer the compatibility mode (WebGL2 for this tab). */
  webgpu: boolean
  /** Reloads the page (back into the world when there). */
  reload(): void
  /** WebGL2 for this tab, then reload. */
  compatibility(): void
}

let open: HTMLElement | null = null

/** Shows the help (replacing an open one); returns its close function. */
export function showGpuHelp(art: Art, o: GpuHelpOptions): () => void {
  closeGpuHelp()
  const box = el('div', 'gpu-notice gpu-help')
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-label', t('gpu.help.title'))
  const close = () => {
    box.remove()
    if (open === box) open = null
  }
  const buttons = el('div', 'gpu-help-buttons')
  if (o.webgpu) buttons.append(button(art, { label: t('gpu.help.compatibility') }, () => o.compatibility()))
  buttons.append(button(art, { label: t('gpu.reload'), primary: true }, () => o.reload()), button(art, { label: t('gpu.help.close') }, close))
  box.append(
    el('div', 'gpu-help-title', t('gpu.help.title')),
    el('p', '', t(o.detected ? 'gpu.help.detected' : 'gpu.help.intro')),
    el('p', '', t('gpu.help.fixBrowser')),
    el('p', '', t('gpu.help.fixGpuProcess')),
    ...(o.webgpu ? [el('p', '', t('gpu.help.fixCompatibility'))] : []),
    buttons,
  )
  document.body.append(box)
  open = box
  return close
}

/** Closes the open help, if any. */
export function closeGpuHelp(): void {
  open?.remove()
  open = null
}
