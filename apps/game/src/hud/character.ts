/**
 * The Main window's Character tab (hotkey C; docs/UI.md §4.6, retail `ifplayerinfo.txt` `GDR_PLAYERINFO` 364×356 in
 * `sframe_wnd_`): the level line in the blue caption, current / next EXP on `com_bg_tile_d`, the stat block on
 * `com_bg_tile_b` (stat points, STR and INT with the `com_plus_button`s, the HP / MP gauges `chr_hp` / `chr_mp`), the
 * attack / defence / hit / parry rows, and skill points and gold in the lower box (retail's job box).
 * The equipment panel (retail `ifequipment.txt`, 178×355 in `equip_window_`) is built here too and shown on the
 * Inventory tab beside the bag: 12 slots at the resinfo rects with the `equip_slot_*` silhouettes behind them.
 * The + buttons send `statUp`; the numbers change when the server's `stats` / `statsDelta` arrive.
 */
import { MAX_STAT_POINTS_PER_REQUEST, type EquipSlot, type PlayerStats } from '@sro/shared'
import { t, type StringKey } from '../i18n/index.ts'
import type { Art } from '../ui/art.ts'
import { el, place, type Rect } from '../ui/dom.ts'
import { iconButton, type KitButton } from '../ui/kit/button.ts'
import { Frame } from '../ui/kit/frame.ts'
import { Gauge } from '../ui/kit/gauge.ts'
import { Section } from '../ui/kit/section.ts'
import { CONTROLS } from '../ui/kit/skins.ts'
import type { SlotEvents } from './inventory.ts'
import type { InventoryState } from './inventory-state.ts'
import { formatNumber, type ItemCatalog } from './items.ts'
import { ensureMainStyles, MainPage } from './main-window.ts'
import { SlotView } from './slots.ts'

/**
 * The 32×32 slot rects of the equipment panel (retail `GDR_EQUIPMENT_SLOT_1xx`, panel px) and the empty-slot art.
 * Retail slot 108 (141, 308; the job suit) has no counterpart here.
 */
export const EQUIP_LAYOUT: Record<EquipSlot, { rect: Rect; art: string }> = {
  head: { rect: [5, 86, 32, 32], art: 'equipment/equip_slot_helm' },
  chest: { rect: [5, 129, 32, 32], art: 'equipment/equip_slot_mail' },
  shoulders: { rect: [141, 86, 32, 32], art: 'equipment/equip_slot_shoulderguard' },
  hands: { rect: [141, 129, 32, 32], art: 'equipment/equip_slot_gauntlet' },
  legs: { rect: [5, 172, 32, 32], art: 'equipment/equip_slot_pants' },
  feet: { rect: [141, 172, 32, 32], art: 'equipment/equip_slot_boots' },
  weapon: { rect: [12, 12, 32, 32], art: 'equipment/equip_slot_weapon' },
  shield: { rect: [134, 12, 32, 32], art: 'equipment/equip_slot_shield' },
  earring: { rect: [5, 215, 32, 32], art: 'equipment/equip_slot_earring' },
  necklace: { rect: [141, 215, 32, 32], art: 'equipment/equip_slot_necklace' },
  ring1: { rect: [5, 258, 32, 32], art: 'equipment/equip_slot_l_ring' },
  ring2: { rect: [141, 258, 32, 32], art: 'equipment/equip_slot_r_ring' },
}

/** A plain figure outline (drawn here, not client art) standing in for the 3D character preview. */
const FIGURE_SVG =
  '<svg viewBox="0 0 80 220" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<circle cx="40" cy="22" r="15"/>' +
  '<path d="M22 44 Q40 38 58 44 L70 62 L76 112 L68 114 L60 72 L58 118 L62 206 L50 208 L42 130 L38 130 L30 208 L18 206 L22 118 L20 72 L12 114 L4 112 L10 62 Z"/>' +
  '</svg>'

/**
 * Points one + click spends (UX_GAPS W7, the SRO convention of UIIT_STT_GNGWC_ABILITY_UP_TOLLTIP): 1, Shift 5,
 * Ctrl 10, Alt all that are free; never more than are free or one request allows.
 */
export function statStep(free: number, mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): number {
  const want = mods.altKey ? free : mods.ctrlKey || mods.metaKey ? 10 : mods.shiftKey ? 5 : 1
  return Math.max(0, Math.min(free, want, MAX_STAT_POINTS_PER_REQUEST))
}

/** The EXP fraction as the character sheet prints it ("12.34 %"), or the max-level text. */
export function expPercentText(exp: number, expToNext: number): string {
  return expToNext > 0 ? `${((100 * Math.max(0, exp)) / expToNext).toFixed(2)} %` : t('hud.expMax')
}

/** The equipment panel (Inventory tab, right side). */
export class EquipmentPanel {
  readonly root: HTMLElement
  readonly slots = new Map<EquipSlot, SlotView>()
  private readonly nameEl: HTMLElement
  private readonly levelEl: HTMLElement

  constructor(art: Art, items: ItemCatalog, on: (v: SlotView, kind: 'down' | 'context' | 'hover', ev: PointerEvent | MouseEvent | null) => void) {
    this.root = el('div', 'eq-panel')
    this.root.append(new Frame(art, 'panel', { at: [0, 0, 178, 355], className: 'eq-frame' }).root)
    const figure = place(el('div', 'eq-figure'), [49, 70, 80, 220])
    figure.innerHTML = FIGURE_SVG
    this.nameEl = place(el('div', 'eq-name kit-t-value kit-fit'), [50, 18, 78, 15])
    this.levelEl = place(el('div', 'eq-level kit-t-level'), [50, 34, 78, 14])
    this.root.append(figure, this.nameEl, this.levelEl)
    for (const [slot, spec] of Object.entries(EQUIP_LAYOUT) as [EquipSlot, (typeof EQUIP_LAYOUT)[EquipSlot]][]) {
      const [x, y] = spec.rect
      // The silhouette frames the 32×32 slot: 40×40 boxes (4 px rim), 56×56 for weapon and shield.
      const size = art.size(spec.art) ?? [40, 40]
      const sil = place(el('div', `eq-sil eq-sil-${slot}`), [x + 16 - size[0] / 2, y + 16 - size[1] / 2, size[0], size[1]])
      if (art.has(spec.art)) sil.style.backgroundImage = art.cssUrl(spec.art)
      else sil.classList.add('no-art')
      const v = new SlotView(items, { kind: 'equip', slot }, 'hud-equip-slot', art)
      place(v.root, [x - 2, y - 2, 36, 36])
      v.root.addEventListener('pointerdown', ev => on(v, 'down', ev))
      v.root.addEventListener('contextmenu', ev => {
        ev.preventDefault()
        on(v, 'context', ev)
      })
      v.root.addEventListener('pointerenter', ev => on(v, 'hover', ev))
      v.root.addEventListener('pointermove', ev => on(v, 'hover', ev))
      v.root.addEventListener('pointerleave', () => on(v, 'hover', null))
      this.slots.set(slot, v)
      this.root.append(sil, v.root)
    }
  }

  setIdentity(name: string, level: number | null): void {
    this.nameEl.textContent = name
    this.nameEl.title = name
    if (level !== null) this.levelEl.textContent = t('hud.level', { level })
  }
}

type StatRow = { value: HTMLElement }

export class CharacterWindow extends MainPage {
  /** The equipment panel; the HUD mounts it on the Inventory tab. */
  readonly equipment: EquipmentPanel
  private readonly caption: Section
  private readonly rows = new Map<string, StatRow>()
  private readonly plusStr: KitButton
  private readonly plusInt: KitButton
  private readonly hpGauge: Gauge
  private readonly mpGauge: Gauge
  private readonly pointsBox: HTMLElement
  private stats: PlayerStats | null = null
  private gold = 0
  private name = ''

  constructor(
    art: Art,
    parent: HTMLElement,
    items: ItemCatalog,
    private readonly inv: InventoryState,
    events: SlotEvents,
    private readonly onStatUp: (stat: 'str' | 'int', points: number) => void,
  ) {
    super(art, parent, { id: 'character', tab: 'character', title: t('hud.char.title') })
    ensureMainStyles()
    this.equipment = new EquipmentPanel(art, items, (v, kind, ev) => {
      if (kind === 'down') events.down(v, ev as PointerEvent)
      else if (kind === 'context') events.context(v, ev as MouseEvent)
      else events.hover(v, ev as PointerEvent | null)
    })

    // ---- the sheet (ifplayerinfo.txt, page px) ---------------------------------------------------------------
    this.caption = new Section(art, { at: [0, 0, 364, 356], caption: '', className: 'chr-sheet' })
    const sheet = this.caption.root
    const img = (key: string, rect: Rect, cls = '') => {
      const e = place(el('div', `chr-deco ${cls}`), rect)
      if (art.has(key)) e.style.backgroundImage = art.cssUrl(key)
      else e.classList.add('no-art')
      sheet.append(e)
      return e
    }
    const tile = (key: string, rect: Rect) => img(key, rect, 'chr-tile')
    tile('ifcommon/bg_tile/com_bg_tile_d', [16, 26, 332, 37])
    tile('ifcommon/bg_tile/com_bg_tile_b', [16, 75, 332, 173])
    tile('ifcommon/bg_tile/com_bg_tile_b', [16, 260, 332, 60])
    img('character/chr_window_mid_mid01', [16, 63, 332, 12], 'chr-strip')
    img('character/chr_window_mid_mid02', [16, 248, 332, 12], 'chr-strip')
    img('character/chr_window_mid_down', [16, 320, 332, 36])
    img('character/chr_window_left_01', [0, 27, 16, 48])
    img('character/chr_window_right_01', [348, 27, 16, 48])
    img('character/chr_window_left_02', [0, 248, 16, 108])
    img('character/chr_window_right_02', [348, 248, 16, 108])
    img('character/chr_stat_window', [15, 107, 332, 24])
    img('character/chr_stat_window', [15, 136, 332, 24])

    const label = (key: StringKey, rect: Rect, cls = 'kit-t-label') => sheet.append(place(el('div', `chr-label ${cls}`, t(key)), rect))
    const value = (id: string, rect: Rect, cls = 'kit-t-value') => {
      const v = place(el('div', `chr-value kit-num ${cls}`), rect)
      this.rows.set(id, { value: v })
      sheet.append(v)
      return v
    }
    // EXP (current / needed for the next level) and the percentage.
    label('chr.exp.current', [32, 34, 64, 14], 'chr-exp-cur')
    value('exp', [96, 34, 76, 14], 'chr-exp-cur')
    label('chr.exp.next', [190, 34, 70, 14], 'chr-exp-next')
    value('expNext', [260, 34, 80, 14], 'chr-exp-next')
    value('expPct', [96, 48, 244, 13], 'chr-exp-pct kit-t-small')
    // Stat points, STR / INT, HP / MP.
    label('hud.stat.points', [17, 84, 100, 14], 'chr-points-label')
    this.pointsBox = value('points', [117, 84, 40, 14], 'chr-points')
    label('hud.stat.str', [22, 112, 38, 14])
    value('str', [84, 112, 36, 14])
    label('hud.stat.int', [22, 141, 38, 14])
    value('int', [84, 141, 36, 14])
    this.plusStr = this.plusButton(t('hud.stat.addStrMods'), 'str', [62, 109, 20, 20])
    this.plusInt = this.plusButton(t('hud.stat.addIntMods'), 'int', [62, 138, 20, 20])
    label('hud.stat.hp', [128, 112, 22, 14], 'kit-t-label chr-gauge-label')
    label('hud.stat.mp', [128, 141, 22, 14], 'kit-t-label chr-gauge-label')
    this.hpGauge = new Gauge(art, 'character/chr_hp', { w: 188, h: 12, text: 'value', color: 'var(--c-hp)', className: 'chr-gauge' })
    this.mpGauge = new Gauge(art, 'character/chr_mp', { w: 188, h: 12, text: 'value', color: 'var(--c-mp)', className: 'chr-gauge' })
    sheet.append(place(this.hpGauge.root, [153, 113, 188, 12]), place(this.mpGauge.root, [153, 142, 188, 12]))
    // Combat rows (label column x 14 / 202, values x 75 / 263).
    const pair = (key: StringKey, id: string, x: number, y: number) => {
      label(key, [x, y, 94, 15])
      value(id, [x + 94, y, 58, 15], 'kit-t-value chr-right')
    }
    pair('hud.stat.physAttack', 'physAttack', 20, 176)
    pair('hud.stat.magAttack', 'magAttack', 190, 176)
    pair('hud.stat.physDefence', 'physDefence', 20, 198)
    pair('hud.stat.magDefence', 'magDefence', 190, 198)
    pair('hud.stat.hitRate', 'hitRate', 20, 220)
    pair('hud.stat.parryRate', 'parryRate', 190, 220)
    // The lower box: skill points and gold.
    label('hud.stat.sp', [32, 272, 110, 14], 'kit-t-label')
    value('sp', [150, 272, 90, 14], 'kit-t-level chr-right')
    label('hud.stat.gold', [32, 294, 110, 14], 'kit-t-label')
    value('gold', [150, 294, 90, 14], 'kit-t-value chr-right')
    this.body.append(sheet)
    this.body.title = ''
    this.renderEquip()
    this.renderStats()
  }

  private plusButton(title: string, stat: 'str' | 'int', rect: Rect): KitButton {
    const b = iconButton(this.art, CONTROLS.plus, { title, fallbackText: '+', w: 20, h: 20, className: 'chr-plus' }, ev => {
      const free = this.stats?.statPoints ?? 0
      if (free <= 0) return
      this.onStatUp(stat, statStep(free, ev))
    })
    b.setAttribute('aria-label', title)
    this.caption.root.append(place(b, rect))
    return b
  }

  protected override onOpen(): void {
    this.renderStats()
  }

  setIdentity(name: string, level: number | null): void {
    this.name = name
    this.equipment.setIdentity(name, level)
    this.renderCaption(level)
  }

  renderEquip(slots?: EquipSlot[]): void {
    for (const [slot, v] of this.equipment.slots) if (!slots || slots.includes(slot)) v.set(this.inv.equipped(slot))
  }

  setStats(stats: PlayerStats | null): void {
    this.stats = stats
    if (stats) this.gold = stats.gold
    this.renderStats()
  }

  setGold(gold: number): void {
    this.gold = gold
    this.value('gold', formatNumber(gold))
  }

  private renderCaption(level: number | null): void {
    const lv = level ?? this.stats?.level ?? null
    this.caption.setCaption(lv !== null ? t('chr.caption', { level: lv, name: this.name }) : this.name)
  }

  private value(id: string, text: string): void {
    const r = this.rows.get(id)
    if (r && r.value.textContent !== text) r.value.textContent = text
  }

  private renderStats(): void {
    const s = this.stats
    const range = (r: [number, number] | undefined) => (r ? t('hud.stat.range', { min: r[0], max: r[1] }) : '-')
    if (!s) {
      for (const r of this.rows.values()) r.value.textContent = '-'
      this.plusStr.setDisabled(true)
      this.plusInt.setDisabled(true)
      this.hpGauge.set(0, 1)
      this.mpGauge.set(0, 1)
      return
    }
    this.renderCaption(s.level)
    this.equipment.setIdentity(this.name, s.level)
    this.value('exp', formatNumber(s.exp))
    this.value('expNext', s.expToNext > 0 ? formatNumber(s.expToNext) : '-')
    this.value('expPct', expPercentText(s.exp, s.expToNext))
    this.value('sp', formatNumber(s.sp))
    this.value('str', String(s.str))
    this.value('int', String(s.int))
    this.value('points', String(s.statPoints))
    this.pointsBox.classList.toggle('has-points', s.statPoints > 0)
    this.hpGauge.set(s.hp, s.maxHp)
    this.mpGauge.set(s.mp, s.maxMp)
    this.value('physAttack', range(s.physAttack))
    this.value('magAttack', range(s.magAttack))
    this.value('physDefence', String(s.physDefence))
    this.value('magDefence', String(s.magDefence))
    this.value('hitRate', String(s.hitRate))
    this.value('parryRate', String(s.parryRate))
    this.value('gold', formatNumber(this.gold))
    this.plusStr.setDisabled(s.statPoints <= 0)
    this.plusInt.setDisabled(s.statPoints <= 0)
  }

  slot(slot: EquipSlot): SlotView | undefined {
    return this.equipment.slots.get(slot)
  }
}
