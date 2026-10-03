/**
 * World feature of lane AL, alchemy (docs/SYSTEMS_COMBAT.md §4.7; docs/WAVE_PLAN2.md §6.4, D20, D40, D44). Only that
 * lane edits this file; see world/features.ts for the context and hooks.
 *
 *  - The Alchemy window (hud/alchemy.ts) on `hud.layer`, the MENU → Alchemy row (D20).
 *  - Right-click on an Elixir or a Lucky Powder in the bag opens it with the item in place; while it is open (and on
 *    top of any shop / storage window) right-clicked equipment and materials go into it (`hud.routeBagAction`), and
 *    items dragged from the bag onto it too (`addSlotDropTarget`). The bag slots it holds are drawn locked (M8).
 *  - Fuse sends `alchemyReinforce`; `alchemyStart` plays the prepare sheet, `alchemyResult` the success / fail sheet,
 *    its cue and a system line. Refusals are toasted by the HUD (claimRequests).
 *  - The preview uses `worldEnter.world.alchemyRate` / `alchemyMaxPlus`.
 */
import type { ServerMessage } from '@sro/shared'
import { AlchemyWindow, DEFAULT_ALCHEMY_MAX_PLUS, DEFAULT_ALCHEMY_RATE, slotFor } from '../../hud/alchemy.ts'
import type { MenuBarEntry } from '../../hud/menubar.ts'
import { addSlotDropTarget } from '../../hud/slots.ts'
import { t } from '../../i18n/index.ts'
import { openKitWindows } from '../../ui/kit/window.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'

/** The HUD mark key of the bag slots the window holds (Hud.markBagSlots). */
export const ALCHEMY_MARK = 'alchemy'

/** NPC windows that own a bag right-click while open (hud/shop.ts, hud/storage.ts). */
const NPC_BAG_WINDOWS = new Set(['npc-shop', 'npc-storage'])

/**
 * Who takes a bag right-click (pure, for tests): 'put' into the open alchemy window, 'open' it with a material,
 * or 'pass' (the shop / storage / default use). `npcZ` = the z of each open shop or storage window.
 */
export function bagRoute(open: boolean, ownZ: number, npcZ: readonly number[], kind: ReturnType<typeof slotFor>): 'put' | 'open' | 'pass' {
  if (!kind) return 'pass'
  if (open) return npcZ.some(z => z > ownZ) ? 'pass' : 'put'
  if (kind === 'item' || npcZ.length > 0) return 'pass'
  return 'open'
}

export function alchemyFeature(ctx: WorldFeatureContext): WorldFeature {
  const { hud, chat } = ctx
  const items = hud.items
  const inv = hud.inventory
  const offs: (() => void)[] = []

  const mark = () => hud.markBagSlots(ALCHEMY_MARK, win.model.lockedBags())
  const win = new AlchemyWindow(ctx.app.art, hud.layer, items, { def: code => items.def(code), item: slot => inv.item(slot) }, {
    fuse: msg => {
      if (!ctx.send(msg)) win.refused()
    },
    cancel: () => void ctx.send({ t: 'alchemyCancel' }),
    changed: mark,
    tooltip: stack => items.tooltip(stack, { player: hud.stats }),
  })

  const npcZ = () => openKitWindows().filter(w => NPC_BAG_WINDOWS.has(w.id)).map(w => w.z)
  const kindOf = (bag: number) => {
    const s = inv.item(bag)
    return s ? slotFor(items.def(s.code)) : null
  }

  hud.claimRequests(['alchemyReinforce', 'alchemyCancel'])
  offs.push(
    hud.routeBagAction(bag => {
      const route = bagRoute(win.isOpen, win.z, npcZ(), kindOf(bag))
      if (route === 'pass') return false
      win.put(bag)
      // After the window opened, so the inventory goes beside it (hud placeBesideNpcWindow).
      if (route === 'open') hud.openInventory?.()
      return true
    }),
  )
  offs.push(
    addSlotDropTarget((from, x, y) => {
      if (from.kind !== 'bag' || !win.contains(x, y)) return false
      if (win.put(from.slot) === 'notMaterial') hud.toast(t('alchemy.problem.notMaterial'), 'error')
      return true
    }),
  )

  // D20: the MENU row (UI-H's `icon` field).
  const entry: MenuBarEntry = {
    id: 'alchemy',
    art: 'underbar/ub_new_icon_alchemy',
    icon: 'underbar/ub_new_icon_alchemy',
    label: 'alchemy.menu',
    order: 65,
    toggle: () => {
      const opening = !win.isOpen
      win.toggle()
      if (opening) hud.openInventory?.()
    },
    isOpen: () => win.isOpen,
  }
  offs.push(hud.menubar.register(entry))

  return {
    onMessage(msg: ServerMessage) {
      switch (msg.t) {
        case 'worldEnter':
          win.model.rate = msg.world.alchemyRate ?? DEFAULT_ALCHEMY_RATE
          win.model.maxPlus = msg.world.alchemyMaxPlus ?? DEFAULT_ALCHEMY_MAX_PLUS
          win.model.phase = 'idle'
          win.model.clear()
          win.refresh()
          break
        case 'inventory':
        case 'inventoryUpdate':
          if (win.model.sync()) win.refresh()
          else win.render()
          break
        case 'stats':
          if (win.isOpen) win.render()
          break
        case 'alchemyStart':
          win.started(msg.readyInMs)
          break
        case 'alchemyResult': {
          const view = win.finished(msg.outcome)
          const name = items.name(msg.code)
          if (view === 'success') chat.add('system', t('alchemy.result.success', { name, plus: msg.plus }))
          else if (view === 'fail') chat.add('system', t('alchemy.result.fail'))
          else if (view === 'destroyed') chat.add('error', t('alchemy.result.destroyed'))
          else chat.add('system', t('alchemy.result.cancelled'))
          break
        }
        case 'actionResult':
          if (msg.re === 'alchemyReinforce' && !msg.ok) win.refused()
          break
      }
    },
    dispose() {
      for (const off of offs.splice(0)) off()
      hud.markBagSlots(ALCHEMY_MARK, new Set())
      win.dispose()
    },
  }
}
