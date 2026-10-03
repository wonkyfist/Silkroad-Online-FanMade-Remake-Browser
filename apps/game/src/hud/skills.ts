/**
 * The Main window's Skill tab (S, alias K; docs/UI.md §4.6, retail `ifskill.txt` `GDR_SKILL` (13,63,364,333) in
 * `equip_window_`; docs/SKILLS.md §10.3): the Weapon / Force category tabs (`skl_ch_icon1/2_tab`) above the page, the
 * mastery icon tabs (`skl_<mastery>_tab`, 76×28), the board (`int_window_` (6,29,351,270)) with the mastery header
 * (`skl_mastery_subject` 352×44: icon, name, level, the LEVEL UP button `skl_mastery_levelup` that sends `masteryUp`
 * with the SP the next level costs) and the mastery's skill lines in two columns (icon, name, learned level / the
 * highest the mastery allows, the ADD button `skl_button_add` = `skillLearn` of the next row); locked lines are greyed
 * with the reason in the tooltip; learned icons drag onto the hotbar. The bottom box `skl_wnd_box` shows the free
 * skill points (#FFD953) and the mastery total (#97E0FF).
 * The page only sends intents and redraws from `skills` / `skillsUpdate` / `stats`.
 */
import { CHARACTER_RULES, MASTERY_CODES, type MasteryCode, type MasteryDef, type PlayerStats } from '@sro/shared'
import type { SkillCatalog, SkillLine, SkillState } from '../content/skills.ts'
import { t } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, Listeners, place } from '../ui/dom.ts'
import { iconButton, type KitButton } from '../ui/kit/button.ts'
import { Frame } from '../ui/kit/frame.ts'
import { ScrollArea } from '../ui/kit/scroll.ts'
import { skillCooldownKey, type CooldownClock } from './cooldowns.ts'
import type { Hotbar } from './hotbar.ts'
import { intent } from './intents.ts'
import { formatNumber, type TooltipLine } from './items.ts'
import { MainPage } from './main-window.ts'
import { ensureSkillStyles } from './skills-style.ts'
import { CooldownSweep, type Tooltip } from './slots.ts'

const TAB_KEY = 'sro.skills.tab'
type Tab = 'weapon' | 'force'

/** The mastery tab art per mastery (`skill/skl_<name>_tab_{on,off}`, 76×28). */
export const MASTERY_TAB_ART: Record<MasteryCode, string> = {
  BICHEON: 'skill/skl_sword_tab',
  HEUKSAL: 'skill/skl_spear_tab',
  PACHEON: 'skill/skl_bow_tab',
  COLD: 'skill/skl_cold_tab',
  LIGHTNING: 'skill/skl_lightning_tab',
  FIRE: 'skill/skl_fire_tab',
  FORCE: 'skill/skl_water_cure_tab',
}

/** The category tab art (Weapon = the crest, Force = the swirl; `skill/skl_ch_icon{1,2}_tab_{on,off}`, 60×24). */
export const CATEGORY_TAB_ART: Record<Tab, string> = { weapon: 'skill/skl_ch_icon1_tab', force: 'skill/skl_ch_icon2_tab' }

/** The skill board's page offset inside the Main window page area (`GDR_SKILL` (13,63) vs the page origin (13,38)). */
export const SKILL_PANEL_Y = 25

/** Sum of the mastery levels (retail "Mastery total"). */
export function masteryTotal(masteries: Partial<Record<MasteryCode, number>>): number {
  let n = 0
  for (const c of MASTERY_CODES) n += masteries[c] ?? 0
  return n
}

export interface SkillWindowDeps {
  art: Art
  parent: HTMLElement
  catalog: SkillCatalog
  state: SkillState
  cooldowns: CooldownClock
  tooltip: Tooltip
  hotbar: Hotbar
  stats: () => PlayerStats | null
  send: (msg: ReturnType<typeof intent.skillLearn> | ReturnType<typeof intent.masteryUp>) => void
}

function initials(name: string): string {
  return name.split(/\s+/).filter(w => /^[A-Za-z]/.test(w)).slice(0, 2).map(w => w[0]!.toUpperCase()).join('') || '?'
}

/** An on/off picture tab (category and mastery tabs). */
function artTab(art: Art, key: string, w: number, h: number, title: string, fallback: string): HTMLButtonElement {
  const b = el('button', 'skl-tab')
  b.type = 'button'
  b.title = title
  b.setAttribute('aria-label', title)
  b.setAttribute('role', 'tab')
  b.style.width = `${w}px`
  b.style.height = `${h}px`
  if (art.has(`${key}_on`) && art.has(`${key}_off`)) {
    b.style.setProperty('--on', art.cssUrl(`${key}_on`))
    b.style.setProperty('--off', art.cssUrl(`${key}_off`))
  } else {
    b.classList.add('no-art')
    b.textContent = fallback
  }
  return b
}

export class SkillWindow extends MainPage {
  private tab: Tab = 'weapon'
  private readonly pageOf: Record<Tab, string | null> = { weapon: null, force: null }
  private readonly tabs: Record<Tab, HTMLButtonElement>
  private readonly masteryTabs: HTMLElement
  private readonly headEl: HTMLElement
  private readonly list: ScrollArea
  private readonly spEl: HTMLElement
  private readonly totalEl: HTMLElement
  private sweeps = new Map<string, CooldownSweep>()
  private tipFor: (() => TooltipLine[]) | null = null
  /** Listeners of the elements one render builds (cleared by the next render). */
  private readonly rl = new Listeners()
  private readonly offCooldown: () => void

  constructor(private readonly d: SkillWindowDeps) {
    super(d.art, d.parent, { id: 'skills', tab: 'skill', title: t('skills.win.title') })
    ensureSkillStyles()
    const art = d.art
    const catTab = (tab: Tab, x: number) => {
      const label = t(tab === 'weapon' ? 'skills.win.weapon' : 'skills.win.force')
      const b = place(artTab(art, CATEGORY_TAB_ART[tab], 60, 24, label, label), [x, 1, 60, 24])
      b.classList.add('skl-cat')
      this.ls.on(b, 'click', () => this.setTab(tab))
      return b
    }
    this.tabs = { weapon: catTab('weapon', 2), force: catTab('force', 64) }
    // The board (page px from SKILL_PANEL_Y).
    const panel = place(el('div', 'skl-panel'), [0, SKILL_PANEL_Y, 364, 333])
    const frame = new Frame(art, 'panel', { at: [0, 0, 364, 333], className: 'skl-frame' })
    const tabBg = place(el('div', 'skl-tab-bg'), [27, 12, 319, 17])
    if (art.has('ifcommon/bg_tile/com_bg_tile_d')) tabBg.style.backgroundImage = art.cssUrl('ifcommon/bg_tile/com_bg_tile_d')
    this.masteryTabs = place(el('div', 'skl-mastery-tabs'), [27, 1, 319, 28])
    const board = new Frame(art, 'inner', { at: [6, 29, 351, 270], className: 'skl-board' })
    this.headEl = place(el('div', 'skl-head'), [6, 32, 351, 44])
    if (art.has('skill/skl_mastery_subject')) this.headEl.style.backgroundImage = art.cssUrl('skill/skl_mastery_subject')
    else this.headEl.classList.add('no-art')
    this.list = new ScrollArea(art, { w: 339, h: 214, className: 'skl-list' })
    place(this.list.root, [12, 80, 339, 214])
    const box = place(el('div', 'skl-box'), [0, 299, 364, 36])
    if (art.has('skill/skl_wnd_box')) box.style.backgroundImage = art.cssUrl('skill/skl_wnd_box')
    else box.classList.add('no-art')
    this.spEl = place(el('div', 'skl-sp-num kit-num'), [86, 12, 90, 13])
    this.totalEl = place(el('div', 'skl-total-num kit-num'), [293, 12, 48, 13])
    box.append(place(el('div', 'skl-sp-label', t('skills.win.sp')), [14, 12, 72, 13]), this.spEl, place(el('div', 'skl-total-label', t('skills.win.total')), [183, 12, 110, 13]), this.totalEl)
    // Free SP: the tooltip says where SP comes from.
    box.title = t('skills.win.spHint', { max: formatNumber(CHARACTER_RULES.spExpPerSp) })
    panel.append(frame.root, tabBg, this.masteryTabs, board.root, this.headEl, this.list.root, box)
    this.body.append(this.tabs.weapon, this.tabs.force, panel)
    try {
      const saved = localStorage.getItem(TAB_KEY)
      if (saved === 'weapon' || saved === 'force') this.tab = saved
    } catch {
      // default tab
    }
    this.offCooldown = d.cooldowns.onChange(key => {
      if (!this.isOpen) return
      for (const [group, sweep] of this.sweeps) {
        if (skillCooldownKey(group) !== key) continue
        const cd = d.cooldowns.get(key)
        sweep.set(cd?.readyAt ?? 0, cd?.totalMs ?? 0)
      }
    })
    this.ls.on(this.body, 'pointerleave', () => this.hideTip())
  }

  protected override onOpen(): void {
    this.render()
  }

  protected override onHide(): void {
    this.hideTip()
  }

  setTab(tab: Tab): void {
    this.tab = tab
    try {
      localStorage.setItem(TAB_KEY, tab)
    } catch {
      // not remembered
    }
    this.render()
  }

  /** Redraws everything (cheap: one page). */
  render(): void {
    if (!this.isOpen) return
    this.rl.clear()
    const { catalog, state } = this.d
    const stats = this.d.stats()
    const sp = stats?.sp ?? 0
    this.tabs.weapon.classList.toggle('on', this.tab === 'weapon')
    this.tabs.force.classList.toggle('on', this.tab === 'force')
    this.spEl.textContent = formatNumber(sp)
    this.totalEl.textContent = String(masteryTotal(state.masteries))
    const masteries = catalog.masteries(this.tab)
    if (!masteries.length) {
      this.masteryTabs.replaceChildren()
      this.headEl.hidden = true
      this.list.view.replaceChildren(el('div', 'skl-empty', t('skills.win.noData')))
      return
    }
    let page = this.pageOf[this.tab]
    if (!page || !masteries.some(m => m.code === page)) page = this.pageOf[this.tab] = masteries[0]!.code
    this.masteryTabs.replaceChildren(
      ...masteries.map(m => {
        const name = m.name ?? m.code
        const b = artTab(this.d.art, MASTERY_TAB_ART[m.code as MasteryCode] ?? '', 76, 28, t('skills.win.masteryLevel', { name, level: state.masteries[m.code as MasteryCode] ?? 0 }), name)
        b.classList.toggle('on', m.code === page)
        this.rl.on(b, 'click', () => {
          this.pageOf[this.tab] = m.code
          this.render()
        })
        return b
      }),
    )
    const mastery = masteries.find(m => m.code === page)!
    this.renderHead(mastery, sp, stats?.level ?? 1)
    this.renderLines(mastery, sp)
  }

  override dispose(): void {
    this.offCooldown()
    this.rl.clear()
    this.hideTip()
    this.list.dispose()
    super.dispose()
  }

  private renderHead(m: MasteryDef, sp: number, charLevel: number): void {
    const { catalog, state } = this.d
    const code = m.code as MasteryCode
    const level = state.masteries[code] ?? 0
    const block = catalog.masteryBlock(code, state, sp, charLevel)
    const cost = catalog.masteryCost(level + 1)
    const icon = place(el('div', 'skl-mastery-icon'), [10, 6, 32, 32])
    if (m.icon) icon.style.backgroundImage = `url("${m.icon}")`
    const up = iconButton(this.d.art, 'skill/skl_mastery_levelup', { title: t('skills.win.masteryUp', { name: m.name ?? m.code, level: level + 1 }), fallbackText: t('skills.win.levelUp'), w: 64, h: 20, className: 'skl-levelup' }, () => {
      if (!up.isDisabled) this.d.send(intent.masteryUp(code))
    }) as KitButton
    up.setDisabled(block !== null || !state.known)
    place(up, [276, 12, 64, 20])
    const tip = (): TooltipLine[] => {
      const lines: TooltipLine[] = [{ text: t('skills.win.masteryUp', { name: m.name ?? m.code, level: level + 1 }), cls: 'title' }]
      if (cost !== null) lines.push({ text: t('skills.win.cost', { sp: cost }), cls: 'stat' })
      if (block) lines.push({ text: block === 'sp' ? t('skills.lock.sp', { need: cost ?? 0, have: sp }) : catalog.blockText(block, null, sp), cls: 'bad' })
      lines.push({ text: t('skills.win.masteryHint'), cls: 'hint' })
      return lines
    }
    up.removeAttribute('title')
    this.hoverTip(up, tip)
    const costText = block === 'cap' ? t('skills.win.capped') : cost !== null ? t('skills.win.cost', { sp: cost }) : ''
    this.headEl.hidden = false
    this.headEl.replaceChildren(
      icon,
      place(el('div', 'skl-mastery-name kit-fit', m.name ?? m.code), [50, 7, 150, 15]),
      place(el('div', 'skl-mastery-level kit-t-level', t('skills.win.level', { level })), [204, 7, 64, 15]),
      place(el('div', 'skl-mastery-cost kit-fit', costText), [50, 23, 220, 14]),
      up,
    )
  }

  private renderLines(m: MasteryDef, sp: number): void {
    const { catalog, state } = this.d
    const mLevel = state.masteries[m.code as MasteryCode] ?? 0
    const lines = catalog.lines(m.code)
    this.sweeps = new Map()
    if (!lines.length) {
      this.list.view.replaceChildren(el('div', 'skl-empty', t('skills.win.noSkills')))
      return
    }
    this.list.view.replaceChildren(el('div', 'skl-grid', ...lines.map(line => this.lineEl(line, mLevel, sp))))
    for (const [group, sweep] of this.sweeps) {
      const cd = this.d.cooldowns.get(skillCooldownKey(group))
      sweep.set(cd?.readyAt ?? 0, cd?.totalMs ?? 0)
    }
  }

  private lineEl(line: SkillLine, masteryLevel: number, sp: number): HTMLElement {
    const { catalog, state } = this.d
    const learned = state.level(line.group)
    const code = state.code(line.group) ?? line.head.code
    const max = catalog.maxLevel(line.group)
    const reach = catalog.maxLearnable(line.group, masteryLevel)
    const next = catalog.nextRow(line.group, learned)
    const block = state.known ? catalog.learnBlock(next, state, sp) : 'unknown'
    const passive = line.head.kind === 'passive'

    const iconBox = el('div', `hud-skill-icon${learned ? '' : ' locked'}${learned && !passive ? ' draggable' : ''}`)
    const ico = el('div', 'ico')
    const url = catalog.icon(code)
    if (url) ico.style.backgroundImage = `url("${url}")`
    else {
      ico.classList.add('fallback')
      ico.textContent = initials(catalog.groupName(line.group))
    }
    iconBox.append(ico)
    if (learned && !passive) this.sweeps.set(line.group, new CooldownSweep(iconBox))
    this.rl.on(iconBox, 'pointerdown', ev => {
      if (!learned || passive) return
      this.hideTip()
      this.d.hotbar.drag.begin(ev, { entry: { kind: 'skill', code }, from: null, icon: url }, iconBox)
    })
    this.hoverTip(iconBox, () =>
      catalog.tooltip(code, {
        learned: learned > 0,
        block: learned ? null : block && block !== 'max' ? catalog.blockText(block, next, sp) : null,
        hint: learned && !passive ? t('skills.win.dragHint') : passive && learned ? t('skills.win.passive') : undefined,
      }),
    )

    const levelText = learned ? t('skills.win.lineLevel', { level: learned, max: Math.max(learned, reach) }) : reach > 0 ? t('skills.win.notLearned') : t('skills.win.masteryShort', { level: catalog.rows(line.group)[0]?.masteryLevel ?? 0 })
    const name = catalog.groupName(line.group)
    const lv = el('div', 'lv kit-fit', levelText)
    const text = el('div', 'skl-line-text', el('div', 'name kit-fit', name), el('div', 'skl-line-foot', lv))
    text.title = max ? `${name}  ·  ${t('skills.win.max', { max })}` : name

    const up = iconButton(this.d.art, 'skill/skl_button_add', { fallbackText: '+', w: 32, h: 20, className: 'skl-add' }, () => {
      if (!up.isDisabled && next) this.d.send(intent.skillLearn(next.code))
    })
    up.setDisabled(block !== null)
    up.hidden = !next
    if (next) {
      this.hoverTip(up, () =>
        catalog.tooltip(next.code, {
          learned: false,
          block: block ? catalog.blockText(block, next, sp) : null,
          hint: block ? undefined : t('skills.win.learnHint', { level: next.skillLevel, sp: next.sp }),
        }),
      )
    }
    lv.after(up)
    return el('div', `skl-line${learned ? ' learned' : ''}${!learned && block ? ' locked' : ''}`, iconBox, text)
  }

  private hoverTip(target: HTMLElement, lines: () => TooltipLine[]): void {
    const show = (ev: PointerEvent) => {
      if (this.d.hotbar.drag.dragging) return
      this.tipFor = lines
      this.d.tooltip.show(lines(), ev.clientX, ev.clientY)
    }
    this.rl.on(target, 'pointerenter', show)
    this.rl.on(target, 'pointermove', ev => {
      if (this.tipFor === lines) this.d.tooltip.move(ev.clientX, ev.clientY)
      else show(ev)
    })
    this.rl.on(target, 'pointerleave', () => this.hideTip())
  }

  private hideTip(): void {
    this.tipFor = null
    this.d.tooltip.hide()
  }
}
