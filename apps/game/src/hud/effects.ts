/**
 * Transient HUD effects: SRO-style floating combat numbers, the level-up banner and the centre-screen
 * message lines (loot, errors such as "Too far away.").
 *
 * Floating numbers follow a world point through the caller's worldToScreen() every frame (null = behind the
 * camera, hidden), rise about 56 px and fade over 1.2 s (crits 1.5 s). They are drawn with the retail hitcount
 * sprites (hud/hitcount.ts, docs/EFFECTS.md §3.1): white digits for your hits, red for hits on you, the
 * "Critical" / "miss" / "Block" art as tags. Heals (no retail sprite) and a missing export stay DOM text.
 */
import { t } from '../i18n/index.ts'
import { el } from '../ui/dom.ts'
import { kitArt } from '../ui/kit/host.ts'
import { drawHitSprites, hitSprites, preloadHitcount } from './hitcount.ts'
import { formatNumber } from './items.ts'

/**
 * Kind of floating number. `hit` / `crit` / `miss` / `block` are your attacks; `taken` and the `*Taken` kinds are
 * attacks on you (red art); `heal` is a green "+N".
 */
export type DamageKind = 'hit' | 'crit' | 'miss' | 'taken' | 'heal' | 'block' | 'critTaken' | 'missTaken' | 'blockTaken'

interface Floater {
  node: HTMLElement
  at: () => { x: number; y: number } | null
  born: number
  life: number
  dx: number
  rise: number
  /** × the size (an own-hit style). */
  size: number
}

/**
 * A look for the numbers of your own attacks while it is set (Berserk: bigger, fire-orange; world/features/berserk.ts):
 * a CSS class on the number and a size factor. null = the retail look.
 */
export interface OwnHitStyle {
  className: string
  scale: number
}

let ownHitStyle: OwnHitStyle | null = null

/** Sets (or clears) the look of your own attacks' numbers from now on (the numbers already shown keep theirs). */
export function setOwnHitStyle(style: OwnHitStyle | null): void {
  ownHitStyle = style
}

const MAX_FLOATERS = 80
/** The art key that tells the hitcount export is there. */
const PROBE_KEY = 'hitcount/hitcount_0'

/** Text of one floating number (pure; tested). */
export function floaterText(amount: number, kind: DamageKind): string {
  if (kind === 'miss' || kind === 'missTaken') return t('hud.miss')
  if (kind === 'block' || kind === 'blockTaken') return t('hud.block')
  if (kind === 'heal') return t('hud.heal', { amount: formatNumber(amount) })
  return formatNumber(amount)
}

/** CSS class of the DOM-text fallback (the style sheet knows the six base kinds). */
function textClass(kind: DamageKind): string {
  return kind === 'critTaken' ? 'crit taken' : kind === 'missTaken' ? 'miss' : kind === 'blockTaken' ? 'block' : kind
}

const isTaken = (kind: DamageKind) => kind === 'taken' || kind === 'critTaken' || kind === 'missTaken' || kind === 'blockTaken'
const isCrit = (kind: DamageKind) => kind === 'crit' || kind === 'critTaken'

export class Floaters {
  readonly root = el('div', 'hud-floaters')
  private readonly list: Floater[] = []
  private raf = 0
  private recent = 0
  private recentAt = 0
  private preloaded = false

  constructor() {
    this.preload()
  }

  /** Starts loading the sprites once the art is registered (App sets it before any screen), so hit one is not blank. */
  private preload(): void {
    const art = kitArt()
    if (this.preloaded || !art.has(PROBE_KEY)) return
    this.preloaded = true
    preloadHitcount(key => art.url(key))
  }

  add(at: () => { x: number; y: number } | null, amount: number, kind: DamageKind): void {
    const node = el('div', `hud-float ${textClass(kind)}`)
    const art = kitArt()
    const layout = art.has(PROBE_KEY) ? hitSprites(amount, kind) : null
    if (layout) {
      this.preload()
      drawHitSprites(node, layout, key => art.url(key))
    } else if (isCrit(kind)) {
      node.append(el('span', 'hud-float-tag', t('hud.critical')), el('span', 'hud-float-num', floaterText(amount, kind)))
    } else {
      node.append(el('span', 'hud-float-num', floaterText(amount, kind)))
    }
    // Several numbers at once (multi-hit swings) fan out a little instead of stacking exactly.
    const now = performance.now()
    this.recent = now - this.recentAt < 250 ? this.recent + 1 : 0
    this.recentAt = now
    const spread = [0, 14, -14, 24, -24, 8, -8][this.recent % 7]!
    const dx = (isTaken(kind) ? -18 : 12) + spread
    const crit = isCrit(kind)
    const own = ownHitStyle && !isTaken(kind) && kind !== 'heal' ? ownHitStyle : null
    if (own) node.classList.add(own.className)
    this.list.push({ node, at, born: now, life: crit ? 1500 : 1200, dx, rise: crit ? 70 : 56, size: own?.scale ?? 1 })
    this.root.append(node)
    while (this.list.length > MAX_FLOATERS) this.list.shift()!.node.remove()
    this.place(this.list[this.list.length - 1]!, now)
    if (!this.raf) this.raf = requestAnimationFrame(this.tick)
  }

  private place(f: Floater, now: number): boolean {
    const age = (now - f.born) / f.life
    if (age >= 1) return false
    const p = f.at()
    if (!p) {
      f.node.style.visibility = 'hidden'
      return true
    }
    const ease = 1 - (1 - age) * (1 - age)
    const pop = (age < 0.12 ? 1.5 - (age / 0.12) * 0.5 : 1) * f.size
    f.node.style.visibility = ''
    f.node.style.opacity = age < 0.6 ? '1' : String(Math.max(0, 1 - (age - 0.6) / 0.4))
    f.node.style.transform = `translate(${(p.x + f.dx).toFixed(1)}px, ${(p.y - ease * f.rise).toFixed(1)}px) translate(-50%, -100%) scale(calc(var(--ui) * ${pop.toFixed(3)}))`
    return true
  }

  private readonly tick = (): void => {
    this.raf = 0
    const now = performance.now()
    for (let i = this.list.length - 1; i >= 0; i--) {
      const f = this.list[i]!
      if (!this.place(f, now)) {
        f.node.remove()
        this.list.splice(i, 1)
      }
    }
    if (this.list.length) this.raf = requestAnimationFrame(this.tick)
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    this.list.length = 0
    this.root.remove()
  }
}

/** Centre-screen "LEVEL UP" banner. */
export class LevelUpBanner {
  readonly root = el('div', 'hud-levelup')
  private timer: ReturnType<typeof setTimeout> | undefined

  show(level: number): void {
    clearTimeout(this.timer)
    this.root.replaceChildren(
      el('div', 'hud-levelup-title', t('hud.levelUp')),
      el('div', 'hud-levelup-sub', t('hud.levelUpSub', { level })),
      el('div', 'hud-levelup-hint', t('hud.levelUpPoints')),
    )
    this.root.classList.remove('in')
    void this.root.offsetWidth
    this.root.classList.add('in')
    this.timer = setTimeout(() => this.root.classList.remove('in'), 3600)
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.root.remove()
  }
}

/** Short system lines in the middle of the screen, newest at the bottom; at most five at a time. */
export class HudMessages {
  readonly root = el('div', 'hud-messages')
  private last = ''
  private lastAt = 0

  show(text: string, kind: 'info' | 'error' | 'loot' = 'info'): void {
    const now = performance.now()
    // The same line twice within a moment (e.g. repeated clicks) is shown once.
    if (text === this.last && now - this.lastAt < 800) return
    this.last = text
    this.lastAt = now
    const line = el('div', `hud-message ${kind}`, text)
    this.root.append(line)
    while (this.root.childElementCount > 5) this.root.firstElementChild?.remove()
    setTimeout(() => line.classList.add('out'), kind === 'error' ? 2400 : 3200)
    setTimeout(() => line.remove(), kind === 'error' ? 3000 : 3800)
  }

  dispose(): void {
    this.root.remove()
  }
}
