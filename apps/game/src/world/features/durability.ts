/**
 * World feature of lane DR, durability and repair (docs/SYSTEMS_COMBAT.md §3.4; docs/WAVE_PLAN2.md §6.4). Only that
 * lane edits this file; see world/features.ts for the context and hooks.
 *
 * - M9 slot decorator: a broken item gets the red `icon_item_broken` overlay, an item at <= 10 % the red
 *   `icon_item_warning` pulse (the sheet's 16 glow cells at 12 fps) on every bag, equipment, storage, shop and hotbar
 *   slot.
 * - M2 warnings: while a worn item is low or broken, its icon sits in the retail `GDR_EQUIP_DUR_ERROR_WND` strip
 *   (hudAnchors().durability, 32 px icons 35 px apart, with the same overlays; hover = the item tooltip), and the
 *   `GDR_EQUIP_STATE_WND` figure (hudAnchors().equipState, `ifcommon/com_re_*`) marks the piece yellow (low) or red
 *   (broken).
 * - Sounds: `ui.eqdanger` when a worn item turns low, `ui.eqbreak` when one breaks, `ui.repair` on an accepted repair.
 * - The Blacksmith's shop footer: Repair / Repair all (hud/repair.ts via M6, the hammer via M12, the confirm via M13),
 *   mounted on the NPC feature's ShopWindow the first time it opens.
 * - Refusals: `repair` is claimed (the HUD toasts it); a `broken` attack or skill also prints the retail line.
 */
import type { EquipSlot, ItemStack, ServerMessage } from '@sro/shared'
import { hudAnchors, placeAt, watchLayout } from '../../hud/hud-layout.ts'
import { durabilityState, RepairControls, type DurabilityState } from '../../hud/repair.ts'
import { ShopWindow } from '../../hud/shop.ts'
import { registerSlotDecorator, Tooltip, type SlotDecorator } from '../../hud/slots.ts'
import { t } from '../../i18n/index.ts'
import { el } from '../../ui/dom.ts'
import { openKitWindows } from '../../ui/kit/window.ts'
import type { WorldFeature, WorldFeatureContext, WorldFeatureFactory } from '../features.ts'

/** Worn slots shown in the warning strip, in retail equipment order. */
const WORN: readonly EquipSlot[] = ['weapon', 'shield', 'head', 'shoulders', 'chest', 'hands', 'legs', 'feet', 'earring', 'necklace', 'ring1', 'ring2']
/** The equipment-state figure's overlay per worn slot (`com_re_avatarNN_{r,y}`, matched on the art's regions). */
export const FIGURE_PART: Partial<Record<EquipSlot, string>> = {
  head: 'ifcommon/com_re_avatar01',
  hands: 'ifcommon/com_re_avatar02',
  shoulders: 'ifcommon/com_re_avatar03',
  chest: 'ifcommon/com_re_avatar04',
  legs: 'ifcommon/com_re_avatar05',
  feet: 'ifcommon/com_re_avatar06',
  weapon: 'ifcommon/com_re_sword',
  shield: 'ifcommon/com_re_shield',
}
const ICON_STEP = 35
const PULSE_FRAMES = 16

/** M9: the durability sign of a slot (none for items that never wear, and for full ones: 'ok' draws nothing). */
export const durabilityDecorator: SlotDecorator = (stack, d) => {
  const s = durabilityState(stack, d)
  return s ? { durability: s } : null
}

/** The worn items that are low or broken, in strip order. */
export function wornWarnings(equip: Partial<Record<EquipSlot, ItemStack>>, def: (code: string) => Parameters<typeof durabilityState>[1]): { slot: EquipSlot; stack: ItemStack; state: Exclude<DurabilityState, 'ok'> }[] {
  const out: { slot: EquipSlot; stack: ItemStack; state: Exclude<DurabilityState, 'ok'> }[] = []
  for (const slot of WORN) {
    const stack = equip[slot]
    const state = stack ? durabilityState(stack, def(stack.code)) : null
    if (stack && (state === 'low' || state === 'broken')) out.push({ slot, stack, state })
  }
  return out
}

/** The cue a worn item's change plays: its state got worse on the same item (a swap or a repair is silent). */
export function wearCue(before: { code: string; state: DurabilityState | null } | undefined, now: { code: string; state: DurabilityState | null } | undefined): 'ui.eqbreak' | 'ui.eqdanger' | null {
  if (!before || !now || before.code !== now.code || before.state === now.state) return null
  if (now.state === 'broken') return 'ui.eqbreak'
  if (now.state === 'low' && before.state === 'ok') return 'ui.eqdanger'
  return null
}

/** Pulse keyframes over the warning sheet (8 cells a row, 16 × 16 cells drawn at 2×). */
function pulseKeyframes(name: string, cell: number): string {
  const steps: string[] = []
  for (let i = 0; i < PULSE_FRAMES; i++) steps.push(`${((i / PULSE_FRAMES) * 100).toFixed(2)}% { background-position: ${-(i % 8) * cell}px ${-Math.floor(i / 8) * cell}px; }`)
  return `@keyframes ${name} { ${steps.join(' ')} }`
}

const CSS = `
${pulseKeyframes('dr-pulse32', 32)}
.kit-slot-dur.low { background-size: 256px 128px !important; background-position: 0 0; animation: dr-pulse32 ${Math.round((PULSE_FRAMES / 12) * 1000)}ms steps(1, end) infinite; }
.dr-warn { position: absolute; height: 32px; pointer-events: none; z-index: 5; }
.dr-warn-icon { position: absolute; top: 0; width: 32px; height: 32px; pointer-events: auto; background: no-repeat center / 32px 32px; }
.dr-warn-icon.noicon { background-color: rgba(60, 20, 20, 0.8); box-shadow: inset 0 0 0 1px #6b2b2b; }
.dr-warn-over { position: absolute; inset: 0; background: no-repeat 0 0 / 100% 100%; pointer-events: none; }
.dr-warn-over.low { background-size: 256px 128px; animation: dr-pulse32 ${Math.round((PULSE_FRAMES / 12) * 1000)}ms steps(1, end) infinite; }
.dr-warn-over.low.noart { box-shadow: inset 0 0 0 2px var(--c-warn, #ffd953); }
.dr-warn-over.broken.noart { background: rgba(200, 30, 30, 0.45); }
.dr-state { position: absolute; width: 68px; height: 96px; pointer-events: auto; z-index: 5; }
.dr-state > div { position: absolute; inset: 0; background: no-repeat 0 0 / 68px 96px; pointer-events: none; }
.dr-state > .dr-part.low { animation: dr-blink 1.2s ease-in-out infinite; }
@keyframes dr-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.kit-btn.dr-active { filter: brightness(1.35); }
.dr-warn[hidden], .dr-state[hidden] { display: none; }
`
let cssInjected = false
function ensureStyles(): void {
  if (cssInjected || typeof document === 'undefined') return
  cssInjected = true
  const style = document.createElement('style')
  style.dataset.owner = 'dr-durability'
  style.textContent = CSS
  document.head.append(style)
}

type Msg<K extends ServerMessage['t']> = Extract<ServerMessage, { t: K }>

export const durabilityFeature: WorldFeatureFactory = ctx => {
  // The seam tests start every feature with an empty context: without a HUD there is nothing to drive.
  if (!ctx?.hud || !ctx.session) return {}
  return createDurabilityFeature(ctx)
}

function createDurabilityFeature(ctx: WorldFeatureContext): WorldFeature {
  const { app, hud } = ctx
  const art = app.art
  const items = hud.items
  const inv = hud.inventory
  const def = (code: string) => items.def(code)
  ensureStyles()
  const offs: (() => void)[] = []

  // ---- M9: the slot decorator ---------------------------------------------------------------------------------------
  offs.push(registerSlotDecorator(durabilityDecorator))

  // ---- M2: the warning strip and the equipment-state figure ---------------------------------------------------------
  const tooltip = new Tooltip(art)
  const strip = el('div', 'dr-warn')
  strip.hidden = true
  const figure = el('div', 'dr-state')
  figure.hidden = true
  hud.layer.append(strip, figure)
  offs.push(() => {
    strip.remove()
    figure.remove()
    tooltip.dispose()
  })
  offs.push(watchLayout(strip, (W, H) => {
    const a = hudAnchors(W, H)
    placeAt(strip, a.durability, true)
    placeAt(figure, a.equipState)
  }))
  const layer = (key: string | null, cls: string): HTMLElement => {
    const d = el('div', cls)
    if (key && art.has(key)) d.style.backgroundImage = art.cssUrl(key)
    return d
  }
  const tipOn = (e: HTMLElement, lines: () => Parameters<Tooltip['show']>[0]) => {
    e.addEventListener('pointerenter', ev => tooltip.show(lines(), ev.clientX, ev.clientY))
    e.addEventListener('pointermove', ev => tooltip.move(ev.clientX, ev.clientY))
    e.addEventListener('pointerleave', () => tooltip.hide())
  }
  let figureLines: Parameters<Tooltip['show']>[0] = []
  tipOn(figure, () => figureLines)

  const renderWarnings = () => {
    const list = wornWarnings(inv.equip, def)
    tooltip.hide()
    strip.replaceChildren(
      ...list.map(({ slot, stack, state }, i) => {
        const icon = el('div', 'dr-warn-icon')
        const url = items.icon(stack.code)
        if (url) icon.style.backgroundImage = `url("${url}")`
        else icon.classList.add('noicon')
        icon.style.left = `${i * ICON_STEP}px`
        icon.dataset.slot = slot
        const key = state === 'broken' ? 'durabilityerror/broken' : 'durabilityerror/warning'
        const over = layer(key, `dr-warn-over ${state}`)
        if (!art.has(key)) over.classList.add('noart')
        icon.append(over)
        tipOn(icon, () => items.tooltip(stack, { player: hud.stats, equipped: true }))
        return icon
      }),
    )
    strip.hidden = list.length === 0
    figure.replaceChildren(layer('ifcommon/com_re_avatar', 'dr-base'), layer('ifcommon/com_re_arms', 'dr-base'))
    for (const { slot, state } of list) {
      const part = FIGURE_PART[slot]
      if (part) figure.append(layer(`${part}_${state === 'broken' ? 'r' : 'y'}`, `dr-part ${state}`))
    }
    figure.hidden = list.length === 0 || !art.has('ifcommon/com_re_avatar')
    figureLines = [
      { text: t('dur.warnTitle'), cls: 'title' },
      ...list.map(({ stack, state }) => {
        const d = def(stack.code)
        const max = d?.stats?.durability?.[1] ?? 0
        const name = items.name(stack.code)
        return state === 'broken'
          ? { text: t('dur.warnBroken', { name }), cls: 'bad' as const }
          : { text: t('dur.warnLow', { name, cur: Math.round(stack.durability ?? max), max }), cls: 'warn' as const }
      }),
      { text: t('dur.warnHint'), cls: 'hint' },
    ]
  }

  // ---- sounds on wear ------------------------------------------------------------------------------------------------
  let worn = new Map<EquipSlot, { code: string; state: DurabilityState | null }>()
  let primed = false
  const snapshotWorn = () => {
    const next = new Map<EquipSlot, { code: string; state: DurabilityState | null }>()
    for (const slot of WORN) {
      const s = inv.equip[slot]
      if (s) next.set(slot, { code: s.code, state: durabilityState(s, def(s.code)) })
    }
    if (primed) {
      let cue: 'ui.eqbreak' | 'ui.eqdanger' | null = null
      for (const [slot, now] of next) {
        const c = wearCue(worn.get(slot), now)
        if (c === 'ui.eqbreak' || (c && !cue)) cue = c
      }
      if (cue) app.audio?.ui(cue)
    }
    worn = next
    primed = inv.known
  }

  // ---- the shop footer (M6) and the hammer ---------------------------------------------------------------------------
  let npc: number | null = null
  let controls: RepairControls | null = null
  const gold = () => hud.stats?.gold ?? inv.gold
  const attach = () => {
    const shop = openKitWindows().find((w): w is ShopWindow => w instanceof ShopWindow)
    if (!shop) return
    controls = new RepairControls(shop, {
      art,
      inventory: () => inv,
      def,
      gold,
      npc: () => npc,
      send: msg => ctx.send(msg),
      toast: (text, kind) => hud.toast(text, kind ?? 'info'),
    })
  }
  offs.push(() => controls?.dispose())
  // While the hammer is on, a right click on a bag item never uses it.
  offs.push(hud.routeBagAction(() => controls?.hammerOn ?? false))
  hud.claimRequests(['repair'])

  let dirty = true
  const onMessage = (msg: ServerMessage) => {
    switch (msg.t) {
      case 'inventory':
      case 'inventoryUpdate':
      case 'stats':
        dirty = true
        break
      case 'npcDialog':
        npc = (msg as Msg<'npcDialog'>).npc
        break
      case 'npcDialogClose':
        npc = null
        controls?.stopHammer()
        break
      case 'actionResult':
        if (msg.re === 'repair' && msg.ok) app.audio?.ui('ui.repair')
        if (!msg.ok && msg.reason === 'broken') {
          if (msg.re === 'attack' || msg.re === 'useSkill') ctx.chat.add('system', t('dur.brokenWeapon'))
          else if (msg.re === 'itemEquip') ctx.chat.add('system', t('dur.cantEquipBroken'))
        }
        break
    }
  }

  return {
    onMessage,
    onFrame() {
      if (!controls) attach()
      controls?.tick()
      if (!dirty || !inv.known) return
      dirty = false
      renderWarnings()
      snapshotWorn()
      controls?.refresh()
    },
    dispose() {
      for (const off of offs.splice(0).reverse()) {
        try {
          off()
        } catch (err) {
          console.error('[durability] dispose', err)
        }
      }
    },
  }
}
