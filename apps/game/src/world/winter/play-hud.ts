/**
 * The winter gameplay HUD (docs/WINTER.md §13.7): the warmth bar under the player frame's HP/MP (only while the winter
 * layer is on and the warmth matters), the frost vignette as it gets cold, the white splash when a snowball hits you,
 * the gift box's reward toast with its opening animation, and the snowball scoreboard. Plain DOM in the HUD layer,
 * every piece removed by `dispose` (no leak); nothing is built without a document (tests run the pure helpers).
 */
import { WINTER_PLAY, type ItemStack, type WarmthLevel, type WarmthState, type WinterBoard } from '@sro/shared'
import { t, type StringKey } from '../../i18n/index.ts'

const CSS = `
.wp-warmth { position: absolute; left: 81px; top: 79px; width: 128px; height: 15px; pointer-events: auto; z-index: 6; display: none; }
.wp-warmth.on { display: block; }
.wp-warmth-bar { position: absolute; left: 15px; right: 0; top: 2px; height: 11px; background: rgba(6, 10, 18, 0.85); border: 1px solid rgba(150, 175, 205, 0.55); border-radius: 2px; overflow: hidden; }
.wp-warmth-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; transition: width 0.25s linear, background-color 0.4s; background: #e9a24a; }
.wp-warmth-text { position: absolute; inset: 0; font: bold 9px/11px var(--font-body, sans-serif); color: #ffffff; text-align: center; text-shadow: 0 0 2px #000, 0 0 2px #000; letter-spacing: 0.3px; }
.wp-warmth-icon { position: absolute; left: 0; top: 0; width: 13px; height: 13px; }
.wp-warmth.chilly .wp-warmth-bar { border-color: rgba(150, 200, 255, 0.8); }
.wp-warmth.cold .wp-warmth-bar, .wp-warmth.freezing .wp-warmth-bar { border-color: #9fd2ff; animation: wp-pulse 1.1s ease-in-out infinite; }
.wp-warmth.freezing .wp-warmth-bar { animation-duration: 0.6s; }
.wp-warmth.rising .wp-warmth-fill { box-shadow: inset 0 0 6px rgba(255, 200, 120, 0.9); }
@keyframes wp-pulse { 0%, 100% { box-shadow: 0 0 0 rgba(120, 190, 255, 0); } 50% { box-shadow: 0 0 6px rgba(120, 190, 255, 0.95); } }
.wp-warmth-tip { position: absolute; left: 0; top: 16px; width: 230px; padding: 5px 7px; display: none; font: 11px/15px var(--font-body, sans-serif); color: #dfe8f6;
  background: rgba(8, 10, 16, 0.92); border: 1px solid rgba(156, 131, 80, 0.7); border-radius: 2px; text-shadow: 0 0 2px #000; }
.wp-warmth:hover .wp-warmth-tip { display: block; }
.wp-frost { position: absolute; inset: 0; pointer-events: none; z-index: 1; opacity: 0; transition: opacity 1.2s;
  background: radial-gradient(ellipse at center, rgba(180, 220, 255, 0) 55%, rgba(190, 225, 255, 0.35) 80%, rgba(225, 242, 255, 0.75) 100%); }
.wp-frost.freezing { animation: wp-frost 2.4s ease-in-out infinite; }
@keyframes wp-frost { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.25); } }
.wp-splash { position: absolute; inset: 0; pointer-events: none; z-index: 2; opacity: 0; }
.wp-splash.go { animation: wp-splash 0.9s ease-out forwards; }
@keyframes wp-splash { 0% { opacity: 0.95; } 100% { opacity: 0; } }
.label-line-winter-splat { color: #ffffff; font-weight: bold; font-size: 17px !important; line-height: 20px; text-shadow: 0 0 4px #6fb8ff, 0 0 2px #000; animation: wp-pop 0.25s ease-out; }
@keyframes wp-pop { 0% { transform: scale(0.4); } 70% { transform: scale(1.25); } 100% { transform: scale(1); } }
.wp-gift { position: absolute; left: 50%; bottom: 190px; transform: translateX(-50%); width: 300px; padding: 10px 12px 10px 74px; z-index: 40; pointer-events: none;
  background: linear-gradient(180deg, rgba(20, 28, 44, 0.95), rgba(10, 14, 24, 0.95)); border: 1px solid rgba(200, 170, 100, 0.85); border-radius: 4px;
  font: 12px/17px var(--font-body, sans-serif); color: #e8eef8; text-shadow: 0 0 2px #000; opacity: 0; transition: opacity 0.3s; }
.wp-gift.show { opacity: 1; }
.wp-gift.rare { border-color: #ffd36a; box-shadow: 0 0 14px rgba(255, 205, 90, 0.75); }
.wp-gift b { display: block; color: #ffe2a0; margin-bottom: 4px; }
.wp-gift.rare b { color: #ffd36a; }
.wp-gift-row { display: flex; align-items: center; gap: 6px; margin: 2px 0; opacity: 0; animation: wp-row 0.3s ease-out forwards; }
.wp-gift-row img, .wp-gift-row i { width: 20px; height: 20px; flex: none; border-radius: 2px; }
.wp-gift-row i { background: linear-gradient(135deg, #f7d36b, #b8862c); }
@keyframes wp-row { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: none; } }
.wp-box { position: absolute; left: 14px; top: 12px; width: 46px; height: 46px; }
.wp-box-body { position: absolute; left: 4px; right: 4px; bottom: 0; height: 30px; background: #c8313b; border-radius: 2px; box-shadow: inset 0 -6px 0 rgba(0,0,0,0.2); }
.wp-box-body::after { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 7px; margin-left: -3.5px; background: #f0c64a; }
.wp-box-lid { position: absolute; left: 0; right: 0; top: 10px; height: 10px; background: #d93b45; border-radius: 2px; transform-origin: 10% 100%; }
.wp-box-lid::after { content: ''; position: absolute; left: 50%; top: -9px; width: 16px; height: 10px; margin-left: -8px; border: 3px solid #f0c64a; border-radius: 50% 50% 0 0; border-bottom: 0; box-sizing: border-box; }
.wp-gift.show .wp-box-lid { animation: wp-lid 0.6s cubic-bezier(.2,.9,.3,1.3) 0.1s forwards; }
@keyframes wp-lid { to { transform: translate(-6px, -16px) rotate(-38deg); } }
.wp-box-burst { position: absolute; left: 50%; top: 14px; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: #fff6c8; opacity: 0; }
.wp-gift.show .wp-box-burst { animation: wp-burst 0.7s ease-out 0.25s; }
@keyframes wp-burst { 0% { opacity: 1; box-shadow: 0 0 0 0 #fff6c8; } 100% { opacity: 0; box-shadow: 0 -14px 10px 18px rgba(255, 240, 180, 0); } }
.wp-board { position: absolute; left: 50%; top: 120px; transform: translateX(-50%); width: 260px; z-index: 45; pointer-events: auto;
  background: linear-gradient(180deg, rgba(18, 26, 42, 0.96), rgba(8, 12, 22, 0.96)); border: 1px solid rgba(156, 131, 80, 0.85); border-radius: 3px;
  font: 12px/18px var(--font-body, sans-serif); color: #e2e9f4; text-shadow: 0 0 2px #000; padding: 8px 10px; }
.wp-board h3 { margin: 0 0 6px; font-size: 13px; color: #cfe6ff; text-align: center; }
.wp-board ol { margin: 0; padding: 0; list-style: none; }
.wp-board li { display: flex; justify-content: space-between; padding: 1px 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
.wp-board li.me { color: #ffe2a0; }
.wp-board .wp-me { margin-top: 6px; color: #b9c8dc; font-size: 11px; }
.wp-board button { position: absolute; right: 4px; top: 3px; background: none; border: 0; color: #c9b27a; cursor: pointer; font-size: 13px; }
`
let styled = false

function ensureStyle(): void {
  if (styled || typeof document === 'undefined') return
  styled = true
  const style = document.createElement('style')
  style.dataset.owner = 'winter-play'
  style.textContent = CSS
  document.head.append(style)
}

const hasDom = () => typeof document !== 'undefined'

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement('div')
  d.className = cls
  if (text !== undefined) d.textContent = text
  return d
}

// ---- pure helpers (unit-tested) -----------------------------------------------------------------------------------

/** The warmth now, carried from the last message at its rate (clamped). */
export function warmthNow(w: WarmthState, now: number): number {
  const v = w.value + (w.rate * Math.max(0, now - w.at)) / 1000
  return Math.max(0, Math.min(w.max, v))
}

/** The bar shows while the layer is on and the warmth matters: below full, or falling. */
export function warmthVisible(on: boolean, w: WarmthState | null, now: number): boolean {
  if (!on || !w) return false
  return warmthNow(w, now) < w.max - 0.5 || w.rate < 0
}

/** The bar's colour from cold blue (0) through pale to warm amber (1). */
export function warmthColor(frac: number): string {
  const f = Math.max(0, Math.min(1, frac))
  const c0 = [80, 150, 255]
  const c1 = [190, 215, 235]
  const c2 = [235, 160, 70]
  const mix = (a: number[], b: number[], k: number) => a.map((x, i) => Math.round(x + (b[i]! - x) * k))
  const c = f < 0.5 ? mix(c0, c1, f / 0.5) : mix(c1, c2, (f - 0.5) / 0.5)
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

const ORDER: readonly WarmthLevel[] = ['warm', 'chilly', 'cold', 'freezing']

/** The chat warning when the level changes (worse: what it does and what helps; back to warm: a relief line). */
export function warningFor(prev: WarmthLevel | null, next: WarmthLevel): StringKey | null {
  if (prev === null || prev === next) return null
  if (ORDER.indexOf(next) > ORDER.indexOf(prev)) return `winterPlay.warn.${next}` as StringKey
  return next === 'warm' ? 'winterPlay.warn.warm' : null
}

/** The frost vignette's opacity by level. */
export function frostOpacity(level: WarmthLevel, safe = false): number {
  if (safe) return 0
  return level === 'freezing' ? 0.85 : level === 'cold' ? 0.45 : level === 'chilly' ? 0.15 : 0
}

// ---- the warmth bar -------------------------------------------------------------------------------------------------

const FLAKE_SVG = '<svg viewBox="0 0 13 13" width="13" height="13"><g stroke="#cfe6ff" stroke-width="1.2" stroke-linecap="round"><path d="M6.5 1v11M1.7 3.7l9.6 5.6M1.7 9.3l9.6-5.6"/></g></svg>'
const FLAME_SVG = '<svg viewBox="0 0 13 13" width="13" height="13"><path d="M6.5 12c-2.4 0-4-1.7-4-3.8 0-2.3 2-3.4 2.4-6.2 1.2 1 1.4 2.3 1.2 3.2.8-.5 1.4-1.4 1.5-2.4 1.6 1.4 2.9 3.3 2.9 5.4 0 2.1-1.6 3.8-4 3.8z" fill="#f0a443" stroke="#7a3d10" stroke-width="0.6"/></svg>'

export class WarmthHud {
  private readonly root: HTMLDivElement | null = null
  private readonly fill: HTMLDivElement | null = null
  private readonly text: HTMLDivElement | null = null
  private readonly icon: HTMLDivElement | null = null
  private readonly tip: HTMLDivElement | null = null
  private readonly frost: HTMLDivElement | null = null
  private readonly splash: HTMLDivElement | null = null
  private iconKind: 'flake' | 'flame' | null = null
  private last = ''

  constructor(layer: HTMLElement | null) {
    if (!layer || !hasDom()) return
    ensureStyle()
    this.frost = div('wp-frost')
    this.splash = div('wp-splash')
    this.splash.style.background = splashBackground()
    this.root = div('wp-warmth')
    this.icon = div('wp-warmth-icon')
    const bar = div('wp-warmth-bar')
    this.fill = div('wp-warmth-fill')
    this.text = div('wp-warmth-text')
    bar.append(this.fill, this.text)
    this.tip = div('wp-warmth-tip')
    this.root.append(this.icon, bar, this.tip)
    layer.append(this.frost, this.splash, this.root)
  }

  /** Draws the warmth at `now` (the bar hidden when it does not matter; the vignette by level). */
  update(on: boolean, w: WarmthState | null, now: number, dead = false): void {
    if (!this.root) return
    const show = !dead && warmthVisible(on, w, now)
    const v = w ? warmthNow(w, now) : WINTER_PLAY.warmth.max
    const max = w?.max ?? WINTER_PLAY.warmth.max
    const level = on && w && !w.safe ? (w.level === 'warm' && v < WINTER_PLAY.warmth.chilly ? 'chilly' : w.level) : 'warm'
    const rising = !!w && w.rate > 0
    const key = `${show}|${Math.round(v)}|${level}|${rising}|${w?.source ?? ''}|${w?.safe ?? false}`
    if (key === this.last) return
    this.last = key
    this.root.classList.toggle('on', show)
    for (const l of ORDER) this.root.classList.toggle(l, l === level)
    this.root.classList.toggle('rising', rising)
    this.fill!.style.width = `${(100 * v) / max}%`
    this.fill!.style.backgroundColor = warmthColor(v / max)
    this.text!.textContent = `${t('winterPlay.warmth.label')} ${Math.round(v)}`
    const kind = rising ? 'flame' : 'flake'
    if (kind !== this.iconKind) {
      this.iconKind = kind
      this.icon!.innerHTML = kind === 'flame' ? FLAME_SVG : FLAKE_SVG
    }
    const lines = [t('winterPlay.warmth.tip', { v: Math.round(v), max }), t(`winterPlay.level.${level}` as StringKey)]
    if (w?.source) lines.push(t(`winterPlay.source.${w.source}` as StringKey))
    this.tip!.textContent = lines.join('\n')
    this.tip!.style.whiteSpace = 'pre-line'
    this.frost!.style.opacity = String(on && !dead ? frostOpacity(level, w?.safe) : 0)
    this.frost!.classList.toggle('freezing', level === 'freezing')
  }

  /** A snowball hit you: a white splash over the screen. */
  splashed(): void {
    const s = this.splash
    if (!s) return
    s.classList.remove('go')
    void s.offsetWidth
    s.classList.add('go')
  }

  dispose(): void {
    this.root?.remove()
    this.frost?.remove()
    this.splash?.remove()
  }
}

/** A few soft white blotches near the screen edges (random each session: decoration). */
function splashBackground(): string {
  const spots: string[] = []
  for (let i = 0; i < 7; i++) {
    const x = Math.round(Math.random() * 100)
    const y = Math.round(Math.random() < 0.5 ? Math.random() * 25 : 75 + Math.random() * 25)
    const r = 8 + Math.round(Math.random() * 10)
    spots.push(`radial-gradient(circle at ${x}% ${y}%, rgba(255,255,255,0.95) 0, rgba(240,248,255,0.85) ${r * 0.6}%, rgba(255,255,255,0) ${r}%)`)
  }
  return spots.join(', ')
}

// ---- the gift toast -------------------------------------------------------------------------------------------------

/** What the toast needs to name and draw a reward. */
export interface ItemLookup {
  name(code: string): string
  icon(code: string): string | null
}

/** The toast's lines for an opened box (pure: names, counts and gold). */
export function giftLines(rewards: readonly ItemStack[], gold: number | undefined, items: Pick<ItemLookup, 'name'>): string[] {
  const out = rewards.map((r) => (r.count > 1 ? `${items.name(r.code)} x${r.count}` : items.name(r.code)))
  if (gold && gold > 0) out.push(t('winterPlay.gift.gold', { gold: gold.toLocaleString('en-US') }))
  return out
}

export class GiftToast {
  private el: HTMLDivElement | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly layer: HTMLElement | null,
    private readonly items: ItemLookup,
  ) {}

  show(rewards: readonly ItemStack[], gold: number | undefined, rare: boolean): void {
    if (!this.layer || !hasDom()) return
    ensureStyle()
    this.close()
    const box = div('wp-gift')
    if (rare) box.classList.add('rare')
    const art = div('wp-box')
    art.append(div('wp-box-body'), div('wp-box-lid'), div('wp-box-burst'))
    const title = document.createElement('b')
    title.textContent = rare ? t('winterPlay.gift.rare') : t('winterPlay.gift.title')
    box.append(art, title)
    const lines = giftLines(rewards, gold, this.items)
    lines.forEach((text, i) => {
      const row = div('wp-gift-row')
      row.style.animationDelay = `${0.35 + i * 0.12}s`
      const code = rewards[i]?.code
      const icon = code ? this.items.icon(code) : null
      if (icon) {
        const img = document.createElement('img')
        img.src = icon
        img.alt = ''
        row.append(img)
      } else row.append(document.createElement('i'))
      const span = document.createElement('span')
      span.textContent = text
      row.append(span)
      box.append(row)
    })
    this.layer.append(box)
    this.el = box
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => box.classList.add('show'))
    else box.classList.add('show')
    this.timer = setTimeout(() => this.close(), 4200)
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.el?.remove()
    this.el = null
  }

  dispose(): void {
    this.close()
  }
}

// ---- the scoreboard -------------------------------------------------------------------------------------------------

export class WinterBoardPanel {
  private el: HTMLDivElement | null = null

  constructor(private readonly layer: HTMLElement | null) {}

  get isOpen(): boolean {
    return this.el !== null
  }

  /** Opens (empty until the board arrives) or refreshes it. */
  open(board: WinterBoard | null, myName: string | null): void {
    if (!this.layer || !hasDom()) return
    ensureStyle()
    if (!this.el) {
      this.el = div('wp-board')
      this.layer.append(this.el)
    }
    const el = this.el
    el.textContent = ''
    const close = document.createElement('button')
    close.textContent = 'x'
    close.title = t('winterPlay.board.close')
    close.onclick = () => this.close()
    const h = document.createElement('h3')
    h.textContent = t('winterPlay.board.title', { season: board?.season ?? '' })
    el.append(close, h)
    if (!board) return
    if (board.top.length === 0) el.append(div('wp-me', t('winterPlay.board.empty')))
    else {
      const ol = document.createElement('ol')
      board.top.forEach((r, i) => {
        const li = document.createElement('li')
        if (r.name === myName) li.className = 'me'
        const a = document.createElement('span')
        a.textContent = `${i + 1}. ${r.name}`
        const b = document.createElement('span')
        b.textContent = String(r.hits)
        li.append(a, b)
        ol.append(li)
      })
      el.append(ol)
    }
    const me = board.me
    el.append(div('wp-me', `${t('winterPlay.board.me', { hits: me.hits, thrown: me.thrown, hitBy: me.hitBy })}${me.rank ? ` (${t('winterPlay.board.rank', { rank: me.rank })})` : ''}`))
  }

  close(): void {
    this.el?.remove()
    this.el = null
  }

  dispose(): void {
    this.close()
  }
}
