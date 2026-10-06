/**
 * Siege of Jangan HUD pieces (docs/SIEGE.md §9.3): the siege panel, the keg prompt (Defuse, with its progress), the
 * reward window and the Warlord's name plate. DOM only: the state comes from world/features/siege.ts, the text from
 * world/siege/model.ts. Native px inside the zoomed `.hud-root`; the windows' look is Play the Boss's (`pl-panel`).
 *
 * The panel sits in the right-hand column under the minimap plate (top 200, right edge W − 4, 200 wide: the quest
 * tracker's column, which the feature pushes down while the panel is open), out of the centre of view and clear of the
 * banners (top centre). It shows the phase, the timer, the Town Bell's HP, the Warlord's HP (and where he is) in the
 * last wave, a strip of the 33 wall segments coloured by stage and the defenders. Its button folds it to the phase, the
 * clock and two slim bars (remembered per browser). The reward window opens under the banners' line, never over them.
 */
import type { SiegeView } from '@sro/shared'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el } from '../ui/dom.ts'
import { button } from '../ui/kit/button.ts'
import type { PipLook } from '../world/siege/model.ts'
import { ensurePilotStyles } from './pilot-style.ts'

const CSS = `
.sg-hud { position: absolute; right: 4px; top: 200px; width: 200px; box-sizing: border-box; padding: 2px 7px 5px; pointer-events: none;
  background: linear-gradient(rgba(26, 10, 6, 0.86), rgba(12, 5, 3, 0.86)); border: 1px solid rgba(214, 128, 82, 0.62);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.8), 0 2px 6px rgba(0, 0, 0, 0.45); border-radius: 3px; text-shadow: 0 0 2px #000, 0 1px 1px #000; }
.sg-hud[hidden] { display: none; }
.sg-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sg-cap { flex: 1 1 auto; min-width: 0; font: 10px/15px var(--font-title); letter-spacing: 0.16em; text-transform: uppercase; color: #f08a5d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-toggle { flex: none; width: 17px; height: 13px; margin: 1px 0 0; padding: 0; box-sizing: border-box; border: 1px solid rgba(201, 163, 92, 0.65); border-radius: 2px;
  background: rgba(0, 0, 0, 0.55); color: #efdaa4; font: 11px/10px var(--font-body); cursor: pointer; pointer-events: auto; }
.sg-toggle:hover { color: #fff3c4; border-color: #e8c66a; background: rgba(60, 30, 12, 0.8); }
.sg-head { flex: 1 1 auto; min-width: 0; font: 13px/17px var(--font-title); color: #fff3c4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-clock { flex: none; font: 12px/17px var(--font-body); color: #ffd953; font-variant-numeric: tabular-nums; }
.sg-clock:empty, .sg-hud:not(.min) .sg-clock { display: none; }
.sg-timer { font: 11px/14px var(--font-body); color: #ffd953; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-timer:empty { display: none; }
.sg-bar { position: relative; margin-top: 3px; height: 13px; background: rgba(0, 0, 0, 0.78); border: 1px solid #000; box-shadow: 0 0 0 1px rgba(201, 163, 92, 0.4); overflow: hidden; }
.sg-bar[hidden] { display: none; }
.sg-bar i { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; transform-origin: 0 50%; transition: transform 0.25s ease-out; }
.sg-bar.bell i { background: linear-gradient(#e8c66a, #9a6a18); }
.sg-bar.bell.low i { background: linear-gradient(#ff7a50, #a02a10); }
.sg-bar.lord i { background: linear-gradient(#ff5a44, #8a1208); }
.sg-bar span { position: absolute; left: 0; right: 0; top: 0; font: 11px/13px var(--font-body); color: #fff; text-align: center; white-space: nowrap; }
.sg-where { font: 11px/14px var(--font-body); color: #ffab88; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-where:empty { display: none; }
.sg-pips { display: flex; justify-content: center; gap: 1px; margin: 5px 0 1px; }
.sg-pip { flex: none; width: 4px; height: 7px; background: #8c8270; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.55); }
.sg-pip.gap { margin-left: 3px; }
.sg-pip.cracked { background: #e3b23c; }
.sg-pip.deep { background: #e9792c; }
.sg-pip.breached { background: #e0281c; box-shadow: 0 0 3px #ff3a20; }
.sg-pip.rubble { background: #6e140c; }
.sg-meta { font: 11px/14px var(--font-body); color: var(--c-label, #efdaa4); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.sg-meta:empty { display: none; }
.sg-hud.min { padding-bottom: 4px; }
.sg-hud.min .sg-timer, .sg-hud.min .sg-where, .sg-hud.min .sg-pips, .sg-hud.min .sg-meta, .sg-hud.min .sg-bar span { display: none; }
.sg-hud.min .sg-bar { height: 4px; margin-top: 2px; }

.sg-keg { position: absolute; left: 50%; bottom: 150px; transform: translateX(-50%); padding: 6px 12px 8px; text-align: center; pointer-events: auto; }
.sg-keg[hidden] { display: none; }
.sg-keg-line { font: 12px/16px var(--font-body); color: #ffd953; margin-bottom: 4px; font-variant-numeric: tabular-nums; }
.sg-keg-bar { width: 160px; height: 6px; margin: 5px auto 0; background: rgba(0, 0, 0, 0.8); border: 1px solid #000; }
.sg-keg-bar i { display: block; height: 100%; background: linear-gradient(#9fe39a, #3c8a36); transform-origin: 0 50%; }
.sg-keg-bar[hidden] { display: none; }

.sg-reward { position: absolute; left: 50%; top: calc(14% + 84px); transform: translateX(-50%); box-sizing: border-box; width: min(380px, calc(100% - 424px)); min-width: 280px;
  max-height: calc(86% - 84px - 76px); overflow-y: auto; padding: 12px 18px 12px; text-align: center; pointer-events: auto; z-index: 30; }
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
.entity-label.siege-warlord { padding: 2px 12px 4px; text-align: center; background: linear-gradient(rgba(52, 8, 5, 0.85), rgba(16, 3, 2, 0.85));
  border: 1px solid rgba(232, 178, 74, 0.9); border-radius: 2px; box-shadow: 0 0 0 1px #000, 0 0 10px rgba(255, 60, 30, 0.5); }
.entity-label.siege-warlord::before, .entity-label.siege-warlord::after { content: ''; position: absolute; top: 50%; width: 7px; height: 7px; margin-top: -4px;
  background: #e8b24a; box-shadow: 0 0 0 1px #000; transform: rotate(45deg); }
.entity-label.siege-warlord::before { left: -5px; }
.entity-label.siege-warlord::after { right: -5px; }
.entity-label.kind-mob.unique.siege-warlord .name { font-size: 16px; color: #ffd36a; letter-spacing: 0.05em; }
.entity-label.kind-mob.siege-warlord .level { color: #f0b080; }
.entity-label.siege-warlord .hp, .entity-label.siege-warlord .hp[hidden] { display: block; width: 132px; height: 6px; margin-top: 3px; border-color: #000; }
.entity-label.siege-warlord .label-line-siege { margin-top: 2px; font: 10px/12px var(--font-title); letter-spacing: 0.14em; text-transform: uppercase; color: #ff8a5a; }
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

/** Where the panel's folded state is remembered (per browser). */
const FOLD_KEY = 'sro.siege.hudFolded'

function readFolded(): boolean {
  try {
    return globalThis.localStorage?.getItem(FOLD_KEY) === '1'
  } catch {
    return false
  }
}

function saveFolded(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(FOLD_KEY, on ? '1' : '0')
  } catch {
    // private window or blocked storage: the panel just forgets
  }
}

/** The siege panel (under the minimap). */
export class SiegeHud {
  readonly root: HTMLElement
  private readonly head: HTMLElement
  private readonly clock: HTMLElement
  private readonly timer: HTMLElement
  private readonly bell: HTMLElement
  private readonly bellFill: HTMLElement
  private readonly bellText: HTMLElement
  private readonly lord: HTMLElement
  private readonly lordFill: HTMLElement
  private readonly lordText: HTMLElement
  private readonly where: HTMLElement
  private readonly pips: HTMLElement
  private readonly meta: HTMLElement
  private readonly toggle: HTMLButtonElement
  private pipKey = ''
  private folded = readFolded()

  constructor() {
    ensureSiegeStyles()
    this.head = el('div', 'sg-head')
    this.clock = el('div', 'sg-clock')
    this.timer = el('div', 'sg-timer')
    this.bellFill = el('i')
    this.bellText = el('span')
    this.bell = el('div', 'sg-bar bell', this.bellFill, this.bellText)
    this.lordFill = el('i')
    this.lordText = el('span')
    this.lord = el('div', 'sg-bar lord', this.lordFill, this.lordText)
    this.where = el('div', 'sg-where')
    this.pips = el('div', 'sg-pips')
    this.meta = el('div', 'sg-meta')
    this.toggle = el('button', 'sg-toggle') as HTMLButtonElement
    this.toggle.type = 'button'
    this.toggle.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    this.toggle.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.setFolded(!this.folded)
      saveFolded(this.folded)
    })
    this.root = el(
      'div',
      'sg-hud',
      el('div', 'sg-row', el('div', 'sg-cap', t('siege.title')), this.toggle),
      el('div', 'sg-row', this.head, this.clock),
      this.timer,
      this.bell,
      this.lord,
      this.where,
      this.pips,
      this.meta,
    )
    this.root.hidden = true
    this.setFolded(this.folded)
  }

  /** Folds the panel to its phase, clock and slim bars (true) or opens it (false). */
  setFolded(on: boolean): void {
    this.folded = on
    this.root.classList.toggle('min', on)
    this.toggle.textContent = on ? '+' : '−'
    const label = t(on ? 'siege.hud.unfold' : 'siege.hud.fold')
    this.toggle.title = label
    this.toggle.setAttribute('aria-label', label)
    this.toggle.setAttribute('aria-expanded', on ? 'false' : 'true')
  }

  get isFolded(): boolean {
    return this.folded
  }

  /** The panel for view `v` (null hides it), with its lines from the model; `where` says where the Warlord is. */
  set(v: SiegeView | null, lines: { head: string; timer: string | null; clock: string | null; meta: string; where?: string | null }): void {
    if (!v) {
      this.root.hidden = true
      return
    }
    this.root.hidden = false
    this.head.textContent = lines.head
    this.head.title = lines.head
    this.clock.textContent = lines.clock ?? ''
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
    this.where.textContent = lp !== undefined ? (lines.where ?? '') : ''
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
