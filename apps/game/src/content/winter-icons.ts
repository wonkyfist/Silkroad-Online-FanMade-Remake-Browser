/**
 * Icons of the winter items (docs/WINTER.md §13.5): the retail client has no gift box or ginger tea, so the two icons are
 * painted once on a 32² canvas (the retail icon size) and kept as data URLs in the items' ItemDef.icon. Nothing is
 * downloaded; without a document (tests) the items keep `icon: null` (the HUD draws its coloured square).
 */
import { WINTER_CODES, type ItemDef } from '@sro/shared'

type Paint = (c: CanvasRenderingContext2D) => void

function frame(c: CanvasRenderingContext2D, top: string, bottom: string): void {
  const g = c.createLinearGradient(0, 0, 0, 32)
  g.addColorStop(0, top)
  g.addColorStop(1, bottom)
  c.fillStyle = g
  c.fillRect(0, 0, 32, 32)
  c.strokeStyle = 'rgba(0, 0, 0, 0.6)'
  c.strokeRect(0.5, 0.5, 31, 31)
}

const gift: Paint = (c) => {
  frame(c, '#20314f', '#0c1424')
  // snow flecks
  c.fillStyle = 'rgba(255, 255, 255, 0.7)'
  for (const [x, y] of [[4, 5], [26, 4], [7, 27], [28, 24], [15, 3]]) c.fillRect(x!, y!, 1.5, 1.5)
  // the box and its lid
  c.fillStyle = '#c3303a'
  c.fillRect(7, 15, 18, 13)
  c.fillStyle = '#de4550'
  c.fillRect(6, 11, 20, 5)
  c.fillStyle = 'rgba(0, 0, 0, 0.18)'
  c.fillRect(7, 16, 18, 2)
  // the ribbon and the bow
  c.fillStyle = '#f1c84b'
  c.fillRect(14.5, 11, 3, 17)
  c.fillRect(6, 13, 20, 2)
  c.strokeStyle = '#f1c84b'
  c.lineWidth = 2
  c.beginPath()
  c.ellipse(12.5, 8.5, 3.5, 2.5, -0.5, 0, Math.PI * 2)
  c.ellipse(19.5, 8.5, 3.5, 2.5, 0.5, 0, Math.PI * 2)
  c.stroke()
  c.strokeStyle = 'rgba(80, 50, 10, 0.6)'
  c.lineWidth = 1
  c.strokeRect(6.5, 11.5, 19, 16)
}

const tea: Paint = (c) => {
  frame(c, '#3a2a1c', '#140d08')
  // steam
  c.strokeStyle = 'rgba(235, 240, 250, 0.75)'
  c.lineWidth = 1.4
  for (const x of [12, 16, 20]) {
    c.beginPath()
    c.moveTo(x, 13)
    c.bezierCurveTo(x - 3, 10, x + 3, 8, x, 4)
    c.stroke()
  }
  // the cup: a pale celadon bowl with amber tea
  c.fillStyle = '#cfe1d2'
  c.beginPath()
  c.moveTo(6, 15)
  c.lineTo(26, 15)
  c.quadraticCurveTo(25, 27, 16, 27)
  c.quadraticCurveTo(7, 27, 6, 15)
  c.fill()
  c.fillStyle = '#c98a2c'
  c.beginPath()
  c.ellipse(16, 15.5, 9.5, 2.2, 0, 0, Math.PI * 2)
  c.fill()
  c.strokeStyle = '#6f8a74'
  c.lineWidth = 1
  c.beginPath()
  c.moveTo(6, 15)
  c.quadraticCurveTo(7, 27, 16, 27)
  c.quadraticCurveTo(25, 27, 26, 15)
  c.stroke()
  // a slice of ginger
  c.fillStyle = '#efd38a'
  c.beginPath()
  c.ellipse(20, 15.3, 2.5, 1.2, 0.3, 0, Math.PI * 2)
  c.fill()
}

const PAINTS: Readonly<Record<string, Paint>> = { [WINTER_CODES.gift]: gift, [WINTER_CODES.tea]: tea }

/** The icon of a winter item as a PNG data URL (null without a document, or for another item). */
export function winterIcon(code: string): string | null {
  const paint = PAINTS[code]
  if (!paint || typeof document === 'undefined') return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 32
    const c = canvas.getContext('2d')
    if (!c) return null
    paint(c)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/** Gives the winter items without an icon their painted one (in place). Returns how many were set. */
export function applyWinterIcons(items: Map<string, ItemDef>): number {
  let n = 0
  for (const code of Object.keys(PAINTS)) {
    const def = items.get(code)
    if (!def || def.icon) continue
    const url = winterIcon(code)
    if (url) {
      def.icon = url
      n++
    }
  }
  return n
}
