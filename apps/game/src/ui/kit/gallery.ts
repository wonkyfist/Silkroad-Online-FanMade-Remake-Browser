/**
 * The kit gallery (`?kit=1`, dev only; docs/UI.md §9.1 UI-K): every control in every state, at a chosen UI scale
 * (1×, 1.25×, 1.5×, 2×, 2.5×, 3×), with the real exported art or the CSS stand-ins when a key is missing (the header
 * counts them). Windows and dialogs open for real, so drag, cascade and the message boxes can be tried at each scale.
 */
import type { App } from '../../app.ts'
import { t, type StringKey } from '../../i18n/index.ts'
import type { Art } from '../art.ts'
import { el } from '../dom.ts'
import { button, iconButton } from './button.ts'
import { Checkbox, RadioGroup } from './check.ts'
import { MessageBox } from './dialog.ts'
import { Frame } from './frame.ts'
import { Gauge } from './gauge.ts'
import { Icon } from './icon.ts'
import { NumberInput, TextInput } from './input.ts'
import { Label, Row, TEXT_STYLES } from './label.ts'
import { List } from './list.ts'
import { MainWindow } from './main-window.ts'
import { Notice } from './notice.ts'
import { UI_STEPS } from './scale.ts'
import { ScrollArea } from './scroll.ts'
import { Section } from './section.ts'
import { Select } from './select.ts'
import { BUTTONS, CONTROLS, FRAMES, GAUGES, skinKeys, TABS, type ButtonName, type FrameName, type GaugeName } from './skins.ts'
import { Slider } from './slider.ts'
import { Slot, SlotGrid, type SlotIcons } from './slot.ts'
import { TabBar } from './tabs.ts'
import { ensureKitStyles } from './tokens.ts'
import { Tooltip, type KitTooltipLine } from './tooltip.ts'
import { Window } from './window.ts'

const GALLERY_CSS = `
body[data-screen='kit'] { background: #1b1f24; }
.kit-gallery { position: fixed; inset: 0; overflow: auto; pointer-events: auto; background: #1b1f24; color: var(--c-text); user-select: none; }
.kit-gallery-bar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 12px; padding: 6px 12px; background: #0d0f12; border-bottom: 1px solid var(--c-rim); font: 12px var(--font-body); }
.kit-gallery-bar .kit-gallery-scale.on { box-shadow: inset 0 0 0 2px var(--c-level); }
.kit-gallery-bar .grow { flex: 1; }
.kit-gallery-page { zoom: var(--ui); padding: 12px 16px 80px; }
.kit-gallery-layer { position: fixed; inset: 0; zoom: var(--ui); pointer-events: none; z-index: 30; }
.kit-gallery h2 { margin: 18px 0 8px; font: 14px var(--font-title); color: var(--c-heading); text-shadow: var(--t-outline); }
.kit-gallery-grid { display: flex; flex-wrap: wrap; gap: 14px 18px; align-items: flex-start; }
.kit-gallery-cell { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.kit-gallery-cell > .kit-gallery-cap { font: 10px var(--font-body); color: #8f98a3; }
.kit-gallery-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.kit-gallery .kit-tooltip.static { position: relative; zoom: 1; }
.kit-gallery .kit-notice.static { position: relative; left: 0; top: 0; transform: none; }
`

const STATES = [
  ['normal', ''],
  ['focus', 'is-focus'],
  ['press', 'is-press'],
  ['disabled', 'disabled'],
] as const

const NO_ICONS: SlotIcons = { icon: () => null, name: code => code.replace(/^ITEM_(CH_|ETC_)?/, '').replace(/_/g, ' '), colour: code => `hsl(${[...code].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 45% 32%)` }

function cell(caption: string, ...children: Node[]): HTMLElement {
  return el('div', 'kit-gallery-cell', ...children, el('div', 'kit-gallery-cap', caption))
}

function section(titleKey: StringKey, ...children: Node[]): HTMLElement {
  return el('section', '', el('h2', '', t(titleKey)), el('div', 'kit-gallery-grid', ...children))
}

function stateLabel(state: string): string {
  return t(`gallery.state.${state}` as StringKey)
}

/** Which kit art keys the manifest lacks (the gallery then shows stand-ins). */
export function missingArt(art: Art): string[] {
  const keys = [...skinKeys(), ...Object.values(CONTROLS)]
  return keys.filter(k => !art.has(k))
}

export function showKitGallery(app: App): void {
  ensureKitStyles()
  const art = app.art
  document.body.dataset.screen = 'kit'
  const style = document.createElement('style')
  style.dataset.owner = 'kit-gallery'
  style.textContent = GALLERY_CSS
  document.head.append(style)

  const root = el('div', 'kit-gallery')
  const page = el('div', 'kit-gallery-page')
  const layer = el('div', 'kit-gallery-layer')

  // ---- the scale bar (overrides --ui until the page is reloaded) ----
  let scale = 1
  const scaleButtons: HTMLButtonElement[] = []
  const applyScale = () => {
    document.documentElement.style.setProperty('--ui', String(scale))
    for (const b of scaleButtons) b.classList.toggle('on', Number(b.dataset.scale) === scale)
  }
  // After App's own resize handler, which resets --ui from the setting.
  window.addEventListener('resize', () => applyScale())
  for (const s of UI_STEPS) {
    const b = button(art, { label: `${s * 100}%`, skin: 'small', className: 'kit-gallery-scale' }, () => {
      scale = s
      applyScale()
    })
    b.dataset.scale = String(s)
    scaleButtons.push(b)
  }
  const missing = missingArt(art)
  const bar = el(
    'div',
    'kit-gallery-bar',
    Label(t('gallery.title'), 'title'),
    Label(t('gallery.scale'), 'label'),
    ...scaleButtons,
    el('span', 'grow'),
    Label(missing.length ? t('gallery.missing', { count: missing.length }) : '', 'small'),
  )
  if (missing.length) bar.title = missing.join('\n')

  // ---- frames ----
  const frames = (Object.keys(FRAMES) as FrameName[]).map(name => {
    const f = new Frame(art, name, { w: name === 'main' ? 220 : 170, h: name === 'main' ? 150 : 100 })
    f.body.append(Label(name, 'value'))
    return cell(`${name} · ${FRAMES[name].prefix}`, f.root)
  })
  const sec = new Section(art, { caption: t('gallery.sample.section'), w: 200, h: 110 })
  sec.body.append(Label(t('gallery.sample.text'), 'body'))

  // ---- buttons in every state ----
  const buttonCells: HTMLElement[] = []
  for (const skin of Object.keys(BUTTONS) as ButtonName[]) {
    const row = el('div', 'kit-gallery-row')
    for (const [state, cls] of STATES) {
      const b = button(art, { label: t('gallery.sample.button'), skin, title: stateLabel(state) })
      if (cls === 'disabled') b.setDisabled(true)
      else if (cls) b.classList.add(cls)
      row.append(b)
    }
    row.append(button(art, { label: t('gallery.sample.long'), skin }))
    buttonCells.push(cell(`${skin} · ${BUTTONS[skin].key} (${STATES.map(s => stateLabel(s[0])).join(' / ')} / auto-fit)`, row))
  }
  const icons = el('div', 'kit-gallery-row')
  for (const key of [CONTROLS.close, CONTROLS.closeDark, CONTROLS.plus, CONTROLS.minus, CONTROLS.money, CONTROLS.spinPrev, CONTROLS.spinNext, CONTROLS.sliderPrev, CONTROLS.sliderNext, CONTROLS.scrollUp, CONTROLS.scrollDown]) {
    for (const [state, cls] of STATES) {
      const b = iconButton(art, key, { title: `${key} ${stateLabel(state)}`, fallbackText: '?' })
      if (cls === 'disabled') b.setDisabled(true)
      else if (cls) b.classList.add(cls)
      icons.append(b)
    }
  }
  buttonCells.push(cell('icon buttons (close, plus, minus, money, arrows)', icons))

  // ---- tabs ----
  const tabCells = (Object.keys(TABS) as (keyof typeof TABS)[]).map(skin => {
    const bar = new TabBar(art, skin, [
      { id: 'a', label: t('gallery.tab.a') },
      { id: 'b', label: t('gallery.tab.b') },
      { id: 'c', label: t('gallery.tab.c') },
    ])
    bar.setDisabled('c', true)
    return cell(`${skin} (on / off / disabled)`, bar.root)
  })

  // ---- gauges ----
  const gaugeCells = (Object.keys(GAUGES) as GaugeName[]).map(name => {
    const row = el('div', 'kit-gallery-row')
    for (const v of [0, 0.5, 1]) {
      const g = new Gauge(art, name, { text: name === 'hp' || name === 'mp' ? 'value' : 'none', color: name.toLowerCase().includes('mp') ? 'var(--c-mp)' : undefined })
      g.set(v * 1234, 1234)
      row.append(g.root)
    }
    return cell(`${name} · ${GAUGES[name]} (0 / 50 / 100%)`, row)
  })
  const band = new Gauge(art, 'exp', { segments: { n: 10, pitch: 78, x0: 0 }, text: 'percent' })
  band.set(0.1234 * 5000, 5000)
  gaugeCells.push(cell('exp band 12.34% (segmented)', band.root))

  // ---- slots ----
  const slot = (setup: (s: Slot) => void, caption: string) => {
    const s = new Slot(art, NO_ICONS, { cell: true })
    setup(s)
    return cell(caption, s.root)
  }
  const stack = (code: string, count = 1, plus = 0) => ({ code, count, ...(plus ? { plus } : {}) })
  const slotCells = [
    slot(() => {}, 'empty'),
    slot(s => s.set(stack('ITEM_CH_SWORD_01_A')), 'item'),
    slot(s => s.set(stack('ITEM_ETC_HP_POTION_01', 250)), 'count 250'),
    slot(s => s.set(stack('ITEM_CH_SWORD_01_A', 1, 5)), '+5'),
    slot(s => (s.set(stack('ITEM_CH_BLADE_01_A')), s.setSigns({ magic: true })), 'magic'),
    slot(s => (s.set(stack('ITEM_CH_SPEAR_01_A')), s.setSigns({ rare: true })), 'rare'),
    slot(s => (s.set(stack('ITEM_CH_BOW_01_A')), s.setSigns({ durability: 'low' })), 'durability low'),
    slot(s => (s.set(stack('ITEM_CH_SHIELD_01_A')), s.setSigns({ durability: 'broken' })), 'broken'),
    slot(s => s.set(stack('ITEM_CH_M_HEAVY_01_BA_A'), true), 'blocked'),
    slot(s => (s.set(stack('ITEM_ETC_MP_POTION_01', 12)), s.setCooldown(performance.now() + 20_000, 30_000)), 'cooldown'),
    slot(s => (s.set(stack('ITEM_ETC_HP_POTION_01', 3)), s.root.classList.add('is-hover')), 'hover'),
    slot(s => (s.set(stack('ITEM_ETC_HP_POTION_01', 3)), s.setState('selected', true)), 'selected'),
    slot(s => (s.set(stack('ITEM_ETC_HP_POTION_01', 3)), s.setState('drop-ok', true)), 'valid drop'),
    slot(s => (s.set(stack('ITEM_ETC_HP_POTION_01', 3)), s.setState('drop-bad', true)), 'invalid drop'),
    slot(s => (s.set(stack('ITEM_ETC_HP_POTION_01', 3)), s.setState('dragging', true)), 'picked up'),
    slot(s => (s.set(stack('ITEM_ETC_HP_POTION_01', 3)), s.setState('new', true)), 'new item'),
  ]
  const grid = new SlotGrid(art, NO_ICONS, 4, 2)
  grid.slot(0)?.set(stack('ITEM_ETC_HP_POTION_01', 40))
  grid.slot(5)?.set(stack('ITEM_CH_SWORD_01_A', 1, 3))
  slotCells.push(cell('SlotGrid 4×2 (lattice)', grid.root))
  slotCells.push(cell('Icon (no picture)', Icon(null, { name: 'Hp Potion', colour: '#6a2020' })))

  // ---- fields, toggles, slider, select ----
  const text = new TextInput(art, { w: 160, value: 'Tester', label: 'name' })
  const bad = new TextInput(art, { w: 160, value: '12a' })
  bad.root.classList.add('invalid')
  const num = new NumberInput(art, { min: 1, max: 250, value: 25, w: 110 })
  const checks = el('div', 'kit-gallery-row')
  const c1 = new Checkbox(art, { label: t('gallery.check') })
  const c2 = new Checkbox(art, { label: t('gallery.check'), checked: true })
  const c3 = new Checkbox(art, { label: t('gallery.check'), checked: true, disabled: true })
  checks.append(c1.root, c2.root, c3.root)
  const radios = new RadioGroup(art, [
    { value: 'a', label: t('gallery.radio.a') },
    { value: 'b', label: t('gallery.radio.b') },
  ], { value: 'b' })
  const slider = new Slider(art, { min: 0, max: 100, step: 5, value: 40, label: 'volume' })
  const sliderValue = Label('40', 'value')
  slider.onInput = v => (sliderValue.textContent = String(v))
  const select = new Select(art, [
    { value: 'auto', label: t('options.uiScale.auto') },
    ...UI_STEPS.map(s => ({ value: String(s), label: `${s * 100}%` })),
  ], { w: 120, value: 'auto' })
  const fieldCells = [
    cell('TextInput', text.root),
    cell('TextInput invalid', bad.root),
    cell('NumberInput (spin)', num.root),
    cell('Checkbox off / on / disabled', checks),
    cell('RadioGroup', radios.root),
    cell('Slider', el('div', 'kit-gallery-row', slider.root, sliderValue)),
    cell('Select', select.root),
  ]

  // ---- list and scroll ----
  const list = new List<number>(art, { render: n => el('span', 'kit-t-value', t('gallery.sample.row', { n })), w: 200, h: 150 })
  list.setItems(Array.from({ length: 30 }, (_, i) => i + 1))
  list.select(2)
  const big = new List<number>(art, { render: n => el('span', 'kit-t-value', t('gallery.sample.row', { n })), w: 200, h: 150 })
  big.setItems(Array.from({ length: 1000 }, (_, i) => i + 1))
  const scroll = new ScrollArea(art, { w: 220, h: 150 })
  scroll.view.append(...Array.from({ length: 12 }, () => el('p', 'kit-t-body', t('gallery.sample.text'))))
  const listCells = [cell('List (30 rows, row 3 selected)', list.root), cell('List (1,000 rows, virtualised)', big.root), cell('ScrollArea', scroll.root)]

  // ---- text styles and tooltip ----
  const textCells = TEXT_STYLES.map(s => cell(s, Label(t('gallery.sample.text').slice(0, 28), s)))
  const tipLines: KitTooltipLine[] = [
    { text: 'Iron Sword (+3)', cls: 'title-plus' },
    { text: 'Sword · 1st degree', cls: 'type' },
    { text: '', cls: 'sep' },
    { text: 'Phy. atk. 21 ~ 23', cls: 'stat' },
    { text: 'Durability 3 / 40', cls: 'warn' },
    { text: 'Str 2 increase', cls: 'magic' },
    { text: '', cls: 'sep' },
    { text: 'Required level 12', cls: 'bad' },
    { text: 'Sell price 1,234 gold', cls: 'price' },
    { text: 'Right click: equip', cls: 'hint' },
  ]
  const tooltip = new Tooltip(art)
  const tipTarget = button(art, { label: t('gallery.tooltip'), skin: 'mid' })
  tipTarget.addEventListener('pointerenter', ev => tooltip.show(tipLines, ev.clientX, ev.clientY))
  tipTarget.addEventListener('pointermove', ev => tooltip.move(ev.clientX, ev.clientY))
  tipTarget.addEventListener('pointerleave', () => tooltip.hide())
  const staticTip = new Tooltip(art, { delayMs: 0, parent: page })
  staticTip.root.classList.add('static')
  staticTip.show(tipLines, 0, 0)
  staticTip.root.style.left = staticTip.root.style.top = '0'
  const notice = new Notice(art, { className: 'static' })
  notice.show(t('gallery.notice'), { title: t('notice.title') })
  textCells.push(cell('Tooltip (hover)', tipTarget), cell('Tooltip', staticTip.root), cell('Notice', notice.root))

  // ---- windows and dialogs ----
  const result = Label(t('gallery.result', { value: '-' }), 'value')
  const show = (v: unknown) => (result.textContent = t('gallery.result', { value: JSON.stringify(v) }))
  const win = new Window(art, layer, { id: 'kit-gallery', title: t('gallery.sample.window'), width: 300, height: 220, at: [0.3, 0.3] })
  win.body.append(Row(t('gallery.check'), '12,345'), Label(t('gallery.sample.text'), 'body'))
  const main = new MainWindow(art, layer, { id: 'kit-gallery-main', title: t('gallery.open.main') })
  for (const id of ['character', 'inventory', 'skill', 'party', 'quest']) {
    const pageEl = el('div', '', Label(id, 'title'))
    if (id === 'inventory') pageEl.append(new SlotGrid(art, NO_ICONS, 4, 8).root)
    main.addTab({ id, title: id, page: pageEl })
  }
  const dialogs = el(
    'div',
    'kit-gallery-row',
    button(art, { label: t('gallery.open.window'), skin: 'mid' }, () => win.toggle()),
    button(art, { label: t('gallery.open.main'), skin: 'mid' }, () => main.toggleTab('inventory')),
    button(art, { label: t('gallery.open.confirm'), skin: 'mid' }, () => void MessageBox.confirm({ title: t('gallery.open.confirm'), text: t('gallery.sample.confirm') }).then(show)),
    button(art, { label: t('gallery.open.count'), skin: 'mid' }, () => void MessageBox.count({ title: t('gallery.open.count'), text: t('gallery.sample.count'), max: 250, initial: 250 }).then(show)),
    button(art, { label: t('gallery.open.prompt'), skin: 'mid' }, () => void MessageBox.prompt({ title: t('gallery.open.prompt'), text: t('gallery.sample.prompt'), maxLength: 24 }).then(show)),
    result,
  )

  page.append(
    section('gallery.frames', ...frames, cell('Section', sec.root)),
    section('gallery.buttons', ...buttonCells),
    section('gallery.tabs', ...tabCells),
    section('gallery.gauges', ...gaugeCells),
    section('gallery.slots', ...slotCells),
    section('gallery.fields', ...fieldCells),
    section('gallery.lists', ...listCells),
    section('gallery.text', ...textCells),
    section('gallery.windows', dialogs),
  )
  root.append(bar, page)
  app.ui.append(root, layer)
  applyScale()
}
