/**
 * Interim "SILKROAD ONLINE" wordmark, replacing the Vietnamese logo art (outer/logo-big 720x200 on the
 * splash, outer/logo 400x120 on login and server select). Inline SVG with live text in the client's
 * English font: gold gradient fill, dark outline, a thin light rim and a drop shadow. textLength pins the
 * width, so the layout holds even when the font falls back to a system serif.
 */
import { t } from '../i18n/index.ts'
import { el } from './dom.ts'

const SVG = 'http://www.w3.org/2000/svg'
let nextId = 0

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  if (text !== undefined) e.textContent = text
  return e
}

/** `big`: the splash logo box (720x200). `small`: the title-screen logo box (400x120). */
export function wordmark(size: 'big' | 'small'): HTMLElement {
  const [w, h] = size === 'big' ? [720, 200] : [400, 120]
  const id = `wm${nextId++}`
  const root = el('div', `wordmark wordmark-${size}`)
  root.style.width = `${w}px`
  root.style.height = `${h}px`
  root.setAttribute('role', 'img')
  root.setAttribute('aria-label', t('wordmark.label'))

  // Drawn in the 720x200 box; the small size scales it down (meet, centered).
  const s = svg('svg', { viewBox: '0 0 720 200', width: '100%', height: '100%', 'aria-hidden': 'true' })
  const defs = svg('defs', {})
  const gold = svg('linearGradient', { id: `${id}g`, x1: 0, y1: 0, x2: 0, y2: 1 })
  for (const [o, c] of [
    [0, '#fff7d1'],
    [0.3, '#f6d982'],
    [0.5, '#d9a441'],
    [0.54, '#9c6718'],
    [0.75, '#c98d2a'],
    [1, '#f3cf73'],
  ] as const) {
    gold.append(svg('stop', { offset: o, 'stop-color': c }))
  }
  const rim = svg('linearGradient', { id: `${id}r`, x1: 0, y1: 0, x2: 0, y2: 1 })
  rim.append(svg('stop', { offset: 0, 'stop-color': '#fff1bf' }), svg('stop', { offset: 1, 'stop-color': '#6b4310' }))
  const line = svg('linearGradient', { id: `${id}l`, x1: 0, y1: 0, x2: 1, y2: 0 })
  line.append(svg('stop', { offset: 0, 'stop-color': '#d9a441', 'stop-opacity': 0 }), svg('stop', { offset: 0.5, 'stop-color': '#f6d982' }), svg('stop', { offset: 1, 'stop-color': '#d9a441', 'stop-opacity': 0 }))
  const shadow = svg('filter', { id: `${id}s`, x: '-10%', y: '-30%', width: '120%', height: '160%' })
  shadow.append(svg('feDropShadow', { dx: 0, dy: 5, stdDeviation: 5, 'flood-color': '#000', 'flood-opacity': 0.9 }))
  defs.append(gold, rim, line, shadow)

  const title = { x: 360, y: 124, 'text-anchor': 'middle', 'font-size': 116, textLength: 640, lengthAdjust: 'spacingAndGlyphs', class: 'wordmark-title' }
  const sub = { x: 360, y: 176, 'text-anchor': 'middle', 'font-size': 30, textLength: 250, lengthAdjust: 'spacing', class: 'wordmark-sub' }
  s.append(
    defs,
    // Outline and shadow, then a light rim, then the gold face.
    svg('text', { ...title, fill: '#150b02', stroke: '#150b02', 'stroke-width': 12, 'stroke-linejoin': 'round', filter: `url(#${id}s)` }, t('wordmark.title')),
    svg('text', { ...title, fill: 'none', stroke: `url(#${id}r)`, 'stroke-width': 4, 'stroke-linejoin': 'round' }, t('wordmark.title')),
    svg('text', { ...title, fill: `url(#${id}g)` }, t('wordmark.title')),
    svg('rect', { x: 130, y: 163, width: 90, height: 2, fill: `url(#${id}l)` }),
    svg('rect', { x: 500, y: 163, width: 90, height: 2, fill: `url(#${id}l)` }),
    svg('text', { ...sub, fill: '#f4ecd8', stroke: '#000', 'stroke-width': 4, 'stroke-linejoin': 'round', 'paint-order': 'stroke', filter: `url(#${id}s)` }, t('wordmark.subtitle')),
  )
  root.append(s)
  return root
}
