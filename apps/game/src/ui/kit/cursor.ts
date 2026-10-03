/**
 * Cursors (docs/UI.md §4.10, M12, decision D21). The retail flame hand `Media/cursor/cursor_normal1.tga` (exported as
 * `ui/cursor/normal.png`, hotspot (2, 2)) is the normal cursor. Attack, talk, pick-up and repair have no retail
 * source, so they are the hand with a small retail icon drawn at (16, 16), composed once on a canvas.
 *   setCursor('attack')  → body[data-cursor=attack]
 * CSS cursors do not scale with zoom, so they are drawn at 1×. Without the art the OS cursor stays.
 * Hover rules of the world (canvas.hover-target[data-hover=…]) are more specific and still win until UI-H moves
 * them onto setCursor.
 */
import type { Art } from '../art.ts'
import { kitArt } from './host.ts'
import { CONTROLS } from './skins.ts'

export type CursorKind = 'normal' | 'attack' | 'talk' | 'pickup' | 'repair'
export const CURSOR_KINDS: readonly CursorKind[] = ['normal', 'attack', 'talk', 'pickup', 'repair']
export const CURSOR_HOTSPOT: readonly [number, number] = [2, 2]

/**
 * The overlay icon drawn on the hand per kind (first exported key wins); an empty list draws the glyph. Repair has no
 * retail hammer icon (the durability sheets are 16-cell pulse animations that squash into 16 px), so it is the drawn
 * hammer (I8, DR's request).
 */
export const CURSOR_OVERLAYS: Record<Exclude<CursorKind, 'normal'>, readonly string[]> = {
  attack: ['targetwindow/tw_icon_normal', 'targetwindow/tw_gem_normal'],
  talk: ['chattingwnd/chat_command_button', 'minimap/mm_sign_npc'],
  pickup: ['ifcommon/com_moneybutton'],
  repair: [],
}

/** The CSS `cursor` value for an image URL (with the hotspot and a fallback). */
export function cursorValue(url: string, fallback = 'auto'): string {
  return `url("${url}") ${CURSOR_HOTSPOT[0]} ${CURSOR_HOTSPOT[1]}, ${fallback}`
}

/** The world canvas' `data-hover` kinds (world/features/ux-world.ts hoverCursor) and the kit cursor each shows. */
const HOVER_CURSORS: readonly (readonly [string, CursorKind])[] = [['npc', 'talk'], ['mob', 'attack'], ['item', 'pickup']]

let current: CursorKind | null = null
let style: HTMLStyleElement | null = null
let built: Art | null = null
const urls = new Map<CursorKind, string>()

/** Sets the pointer for the whole page (the canvas and every kit control inherit it). */
export function setCursor(kind: CursorKind): void {
  if (typeof document === 'undefined') return
  current = kind
  document.body.dataset.cursor = kind
  const art = kitArt()
  if (built !== art) build(art)
}

export function cursorKind(): CursorKind | null {
  return current
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

function writeRules(): void {
  if (!style) {
    style = document.createElement('style')
    style.dataset.owner = 'kit-cursor'
    document.head.append(style)
  }
  const rules: string[] = []
  for (const [kind, url] of urls) {
    const fallback = kind === 'normal' ? 'auto' : 'pointer'
    rules.push(`body[data-cursor='${kind}'], body[data-cursor='${kind}'] canvas { cursor: ${cursorValue(url, fallback)}; }`)
  }
  // Something under the pointer in the world (before UI-H sets kinds): the attack hand.
  const hover = urls.get('attack')
  if (hover) rules.push(`body[data-cursor] canvas.hover-target { cursor: ${cursorValue(hover, 'pointer')}; }`)
  // H11-CH-1: the world's canvas[data-hover] kinds (ux-world.ts; 'npc' also over a townsperson, who is no entity),
  // after the hover-target rule so the kind's own hand wins.
  for (const [hoverKind, kind] of HOVER_CURSORS) {
    const url = urls.get(kind)
    if (url) rules.push(`body[data-cursor] canvas[data-hover='${hoverKind}'] { cursor: ${cursorValue(url, 'pointer')}; }`)
  }
  style.textContent = rules.join('\n')
}

function build(art: Art): void {
  built = art
  urls.clear()
  if (!art.has(CONTROLS.cursor)) {
    writeRules()
    return
  }
  const hand = art.url(CONTROLS.cursor)
  urls.set('normal', hand)
  writeRules()
  void (async () => {
    try {
      const base = await loadImage(hand)
      for (const kind of CURSOR_KINDS) {
        if (kind === 'normal') continue
        const key = CURSOR_OVERLAYS[kind].find(k => art.has(k))
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const ctx = canvas.getContext('2d')
        if (!ctx) continue
        ctx.drawImage(base, 0, 0, 32, 32)
        if (key) ctx.drawImage(await loadImage(art.url(key)), 16, 16, 16, 16)
        else drawGlyph(ctx, kind)
        if (built !== art) return
        urls.set(kind, canvas.toDataURL('image/png'))
      }
      writeRules()
    } catch (err) {
      console.warn('[kit] cursor composition failed; the plain hand is used', err)
    }
  })()
}

/** A tiny drawn mark when no overlay art exists (repair: a hammer). */
function drawGlyph(ctx: CanvasRenderingContext2D, kind: CursorKind): void {
  ctx.save()
  ctx.translate(16, 16)
  ctx.lineWidth = 1
  ctx.strokeStyle = '#000'
  if (kind === 'repair') {
    ctx.fillStyle = '#c9c9c9'
    ctx.fillRect(3, 2, 10, 5)
    ctx.strokeRect(3.5, 2.5, 9, 4)
    ctx.fillStyle = '#8a5a2b'
    ctx.fillRect(7, 7, 3, 8)
    ctx.strokeRect(7.5, 7.5, 2, 7)
  } else {
    ctx.fillStyle = '#ffd953'
    ctx.beginPath()
    ctx.arc(8, 8, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
}
