/**
 * SRO window frames: the client draws its windows from eight pieces named `<prefix>left_up`, `mid_up`,
 * `right_up`, `left_side`, `right_side`, `left_down`, `mid_down`, `right_down` (resinfo CIFFrame /
 * CIFStretchWnd DDJ prefixes such as interface\inventory\int_window_). Corners keep their size, edges tile.
 * The body is an optional tiled background (ifcommon/bg_tile/*) or plain CSS. Without the art the frame falls
 * back to a CSS border (`no-art`).
 */
import type { Art } from './art.ts'
import { el } from './dom.ts'

const PIECES = ['left_up', 'mid_up', 'right_up', 'left_side', 'right_side', 'left_down', 'mid_down', 'right_down'] as const

export function hasFrame(art: Art, prefix: string): boolean {
  return PIECES.every(p => art.has(prefix + p))
}

/**
 * An absolutely positioned frame layer filling its parent (put it first so content draws above it).
 * `fill`: a tile texture key for the body, drawn inside the corners' inset.
 */
export function frame(art: Art, prefix: string, opts: { fill?: string; className?: string } = {}): HTMLElement {
  const root = el('div', `sro-frame ${opts.className ?? ''}`)
  if (!hasFrame(art, prefix)) {
    root.classList.add('no-art')
    return root
  }
  const size = (p: string): [number, number] => art.size(prefix + p) ?? [16, 16]
  const [luW, luH] = size('left_up')
  const [ruW] = size('right_up')
  const [ldW, ldH] = size('left_down')
  const [rdW] = size('right_down')
  const [lsW] = size('left_side')
  const [rsW] = size('right_side')
  const [, muH] = size('mid_up')
  const [, mdH] = size('mid_down')
  const piece = (p: string, css: Partial<CSSStyleDeclaration>) => {
    const d = el('div', `sro-frame-piece ${p}`)
    d.style.backgroundImage = art.cssUrl(prefix + p)
    Object.assign(d.style, css)
    root.append(d)
  }
  if (opts.fill && art.has(opts.fill)) {
    const body = el('div', 'sro-frame-fill')
    body.style.backgroundImage = art.cssUrl(opts.fill)
    Object.assign(body.style, { left: `${Math.min(lsW, 8)}px`, right: `${Math.min(rsW, 8)}px`, top: `${Math.min(muH, 8)}px`, bottom: `${Math.min(mdH, 8)}px` })
    root.append(body)
  }
  piece('left_up', { left: '0', top: '0', width: `${luW}px`, height: `${luH}px` })
  piece('right_up', { right: '0', top: '0', width: `${ruW}px`, height: `${luH}px` })
  piece('left_down', { left: '0', bottom: '0', width: `${ldW}px`, height: `${ldH}px` })
  piece('right_down', { right: '0', bottom: '0', width: `${rdW}px`, height: `${ldH}px` })
  piece('mid_up', { left: `${luW}px`, right: `${ruW}px`, top: '0', height: `${muH}px`, backgroundRepeat: 'repeat-x' })
  piece('mid_down', { left: `${ldW}px`, right: `${rdW}px`, bottom: '0', height: `${mdH}px`, backgroundRepeat: 'repeat-x' })
  piece('left_side', { left: '0', top: `${luH}px`, bottom: `${ldH}px`, width: `${lsW}px`, backgroundRepeat: 'repeat-y' })
  piece('right_side', { right: '0', top: `${luH}px`, bottom: `${ldH}px`, width: `${rsW}px`, backgroundRepeat: 'repeat-y' })
  return root
}
