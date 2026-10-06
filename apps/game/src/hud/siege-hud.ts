/**
 * Siege of Jangan HUD pieces (docs/SIEGE.md §9.3): the siege panel (top centre, under the notices: the phase, the
 * timer, the Town Bell's HP, the Warlord's HP in the last wave, a strip of the 33 wall segments coloured by stage, the
 * defenders), the keg prompt (Defuse, with its progress) and the reward window. DOM only: the state comes from
 * world/features/siege.ts, the text from world/siege/model.ts. Native px inside the zoomed `.hud-root`; the panel look
 * is Play the Boss's (`pl-panel`).
 */
import type { SiegeView } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { button } from '../ui/kit/button.ts'
import type { PipLook } from '../world/siege/model.ts'
import { ensurePilotStyles } from './pilot-style.ts'

const CSS = `
.sg-hud { position: absolute; left: 50%; top: 96px; transform: translateX(-50%); width: 360px; padding: 4px 14px 7px; text-align: center; pointer-events: none; transition: top 0.3s ease;
  background: linear-gradient(90deg, transparent, rgba(16, 7, 4, 0.86) 10%, rgba(16, 7, 4, 0.86) 90%, transparent);
  border-style: solid; border-width: 1px 0; border-image: linear-gradient(90deg, transparent, rgba(226, 120, 80, 0.75) 18%, rgba(226, 120, 80, 0.75) 82%, transparent) 1; }
.sg-hud[hidden] { display: none; }
.sg-hud.below { top: 214px; }
.sg-cap { font: 10px/13px var(--font-title); letter-spacing: 0.22em; text-transform: uppercase; color: #f08a5d; }
.sg-head { font: 15px/20px var(--font-title); color: #fff3c4; text-shadow: 0 0 6px rgba(0, 0, 0, 0.9); white-space: nowrap; }
.sg-timer { font: 12px/15px var(--font-body); color: #ffd953; font-variant-numeric: tabular-nums; text-shadow: 0 1px 1px #000; }
.sg-timer:empty { display: none; }
.sg-bar { position: relative; margin: 4px auto 0; width: 300px; height: 13px; background: rgba(0, 0, 0, 0.78); border: 1px solid #000; box-shadow: 0 0 0 1px rgba(201, 163, 92, 0.45); }
.sg-bar[hidden] { display: none; }
.sg-bar i { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; transform-origin: 0 50%; transition: transform 0.25s ease-out; }
.sg-bar.bell i { background: linear-gradient(#e8c66a, #9a6a18); }
.sg-bar.bell.low i { background: linear-gradient(#ff7a50, #a02a10); }
.sg-bar.lord i { background: linear-gradient(#ff5a44, #8a1208); }
.sg-bar span { position: absolute; left: 0; right: 0; top: 0; font: 10px/13px var(--font-body); color: #fff; text-shadow: 0 0 2px #000, 0 1px 1px #000; white-space: nowrap; }
.sg-pips { display: flex; justify-content: center; gap: 2px; margin: 6px auto 1px; }
.sg-pip { width: 7px; height: 8px; border: 1px solid rgba(0, 0, 0, 0.85); background: #8c8270; }
.sg-pip.gap { margin-left: 5px; }
.sg-pip.cracked { background: #e3b23c; }
.sg-pip.deep { background: #e9792c; }
.sg-pip.breached { background: #e0281c; box-shadow: 0 0 4px #ff3a20; }
.sg-pip.rubble { background: #6e140c; }
.sg-pip.target { outline: 1px solid #fff3c4; }
.sg-meta { font: 11px/14px var(--font-body); color: var(--c-label, #efdaa4); white-space: nowrap; font-variant-numeric: tabular-nums; }
.sg-meta:empty { display: none; }

.sg-keg { position: absolute; left: 50%; bottom: 150px; transform: translateX(-50%); padding: 6px 12px 8px; text-align: center; pointer-events: auto; }
.sg-keg[hidden] { display: none; }
.sg-keg-line { font: 12px/16px var(--font-body); color: #ffd953; margin-bottom: 4px; font-variant-numeric: tabular-nums; }
.sg-keg-bar { width: 160px; height: 6px; margin: 5px auto 0; background: rgba(0, 0, 0, 0.8); border: 1px solid #000; }
.sg-keg-bar i { display: block; height: 100%; background: linear-gradient(#9fe39a, #3c8a36); transform-origin: 0 50%; }
.sg-keg-bar[hidden] { display: none; }

.sg-reward { position: absolute; left: 50%; top: 60%; transform: translate(-50%, -50%); width: 380px; padding: 12px 18px 12px; text-align: center; pointer-events: auto; z-index: 30; }
.sg-reward[hidden] { display: none; }
.sg-reward-cap { font: 10px/14px var(--font-title); letter-spacing: 0.22em; text-transform: uppercase; color: #f08a5d; }
.sg-reward-head { margin: 4px 0 8px; font: 22px/26px var(--font-title); color: #fff3c4; text-shadow: 0 0 6px rgba(0, 0, 0, 0.9); }
.sg-reward-head.won { color: #ffe27a; }
.sg-reward-head.lost { color: #ff9c8a; }
.sg-reward-lines { margin: 0 0 6px; padding: 0; list-style: none; font: 13px/19px var(--font-body); color: var(--c-text, #efe6cf); }
.sg-reward-parts { font: 11px/14px var(--font-body); color: var(--c-label, #efdaa4); margin-bottom: 8px; }
.sg-reward-parts:empty { display: none; }
.sg-reward-top { margin: 0 auto 10px; width: 240px; font: 12px/17px var(--font-body); color: #efe6cf; border-top: 1px solid rgba(201, 163, 92, 0.4); padding-top: 5px; }
.sg-reward-top .sg-reward-sub { font: 10px/14px var(--font-title); letter-spacing: 0.18em; text-transform: uppercase; color: #c9a35c; }
.sg-reward-top div { display: flex; justify-content: space-between; }
.sg-reward-top div.me { color: #ffd953; }
.sg-reward-buttons { display: flex; justify-content: center; }

.entity-label .label-line-siege { color: #f0a070; }
`

let injected = false

export function ensureSiegeStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  ensurePilotStyles()
  const s = document.createElement('style')
  s.dataset.sro = 'siege'
  s.textContent = CSS
  document.head.append(s)
}

/** The siege panel. */
export class SiegeHud {
  readonly root: HTMLElement
  private readonly head: HTMLElement
  private readonly timer: HTMLElement
  private readonly bell: HTMLElement
  private readonly bellFill: HTMLElement
  private readonly bellText: HTMLElement
  private readonly lord: HTMLElement
  private readonly lordFill: HTMLElement
  private readonly lordText: HTMLElement
  private readonly pips: HTMLElement
  private readonly meta: HTMLElement
  private pipKey = ''

  constructor() {
    ensureSiegeStyles()
    this.head = el('div', 'sg-head')
    this.timer = el('div', 'sg-timer')
    this.bellFill = el('i')
    this.bellText = el('span')
    this.bell = el('div', 'sg-bar bell', this.bellFill, this.bellText)
    this.lordFill = el('i')
    this.lordText = el('span')
    this.lord = el('div', 'sg-bar lord', this.lordFill, this.lordText)
    this.pips = el('div', 'sg-pips')
    this.meta = el('div', 'sg-meta')
    this.root = el('div', 'sg-hud', el('div', 'sg-cap', t('siege.title')), this.head, this.timer, this.bell, this.lord, this.pips, this.meta)
    this.root.hidden = true
  }

  /** The panel for view `v` (null hides it), with its lines from the model. */
  set(v: SiegeView | null, lines: { head: string; timer: string | null; meta: string }): void {
    if (!v) {
      this.root.hidden = true
      return
    }
    this.root.hidden = false
    this.head.textContent = lines.head
    this.timer.textContent = lines.timer ?? ''
    const bp = v.bellPct
    this.bell.hidden = bp === undefined
    if (bp !== undefined) {
      this.bellFill.style.transform = `scaleX(${Math.max(0, Math.min(1, bp / 100))})`
      this.bellText.textContent = `${t('siege.bell')} ${bp.toFixed(bp < 10 ? 1 : 0)}%`
      this.bell.classList.toggle('low', bp < 30)
    }
    const lp = v.warlordPct
    this.lord.hidden = lp === undefined
    if (lp !== undefined) {
      this.lordFill.style.transform = `scaleX(${Math.max(0, Math.min(1, lp / 100))})`
      this.lordText.textContent = `${t('siege.warlord')} ${lp.toFixed(lp < 10 ? 1 : 0)}%`
    }
    this.meta.textContent = lines.meta
  }

  /** The wall strip: one pip per segment, in order, with a gap between sides. */
  setPips(pips: { id: string; look: PipLook; title: string }[]): void {
    const key = pips.map((p) => `${p.id}:${p.look}`).join(',')
    if (key === this.pipKey) return
    this.pipKey = key
    let side = ''
    this.pips.replaceChildren(
      ...pips.map((p) => {
        const d = el('i', `sg-pip ${p.look}${side && p.id[0] !== side ? ' gap' : ''}`)
        side = p.id[0]!
        d.title = p.title
        return d
      }),
    )
  }

  setBelow(on: boolean): void {
    this.root.classList.toggle('below', on)
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }
}

/** The keg prompt over the hotbar: Defuse, then the progress while defusing. */
export class KegPrompt {
  readonly root: HTMLElement
  private readonly line: HTMLElement
  private readonly bar: HTMLElement
  private readonly fill: HTMLElement
  private readonly btn: HTMLElement

  constructor(art: Art, onDefuse: () => void) {
    ensureSiegeStyles()
    this.line = el('div', 'sg-keg-line')
    this.fill = el('i')
    this.bar = el('div', 'sg-keg-bar', this.fill)
    this.btn = button(art, { label: t('siege.keg.defuse'), primary: true, minWidth: 140 }, onDefuse)
    this.root = el('div', 'sg-keg pl-panel', this.line, this.btn, this.bar)
    this.root.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    this.root.hidden = true
  }

  /** Hidden (null), or the fuse left and, while defusing, the progress 0..1 and its time left. */
  set(s: { fuseMs: number; defuse: { frac: number; leftMs: number } | null } | null, clock: (ms: number) => string): void {
    if (!s) {
      this.root.hidden = true
      return
    }
    this.root.hidden = false
    this.line.textContent = s.defuse ? t('siege.keg.defusing', { time: clock(s.defuse.leftMs) }) : t('siege.keg.fuse', { time: clock(s.fuseMs) })
    this.btn.hidden = !!s.defuse
    this.bar.hidden = !s.defuse
    if (s.defuse) this.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, s.defuse.frac))})`
  }
}

/** The reward window. */
export class SiegeRewardWindow {
  readonly root: HTMLElement

  constructor(private readonly art: Art) {
    ensureSiegeStyles()
    this.root = el('div', 'sg-reward pl-panel')
    this.root.hidden = true
    this.root.addEventListener('pointerdown', (ev) => ev.stopPropagation())
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  show(c: { head: string; kind: 'won' | 'lost' | 'over'; lines: string[]; parts: string; top: { name: string; points: number; me: boolean }[] }): void {
    const list = el('ul', 'sg-reward-lines', ...c.lines.map((l) => el('li', '', l)))
    const top = c.top.length
      ? el('div', 'sg-reward-top', el('div', 'sg-reward-sub', t('siege.reward.top')), ...c.top.map((x, i) => el('div', x.me ? 'me' : '', el('span', '', `${i + 1}. ${x.name}`), el('span', '', String(x.points)))))
      : null
    this.root.replaceChildren(
      el('div', 'sg-reward-cap', t('siege.reward.cap')),
      el('div', `sg-reward-head ${c.kind}`, c.head),
      list,
      el('div', 'sg-reward-parts', c.parts),
      ...(top ? [top] : []),
      el('div', 'sg-reward-buttons', button(this.art, { label: t('siege.reward.close'), primary: true, minWidth: 96 }, () => this.close())),
    )
    this.root.hidden = false
  }

  close(): void {
    this.root.hidden = true
  }
}
