/**
 * World feature of lane NPC-C: NPC dialog, shops, storage, the item cast bar and item cooldown sweeps
 * (docs/SHOPS.md §3, §4, §5, §8.3; docs/WAVE_PLAN.md §4.6). Only this lane edits this file.
 *
 * Flow: clicking an NPC targets it and sends `npcTalk`; the server walks us there and answers `npcDialog`, which
 * opens the dialog window. "Trade in the shop." opens the shop (browsing needs no round trip), "Deposit into
 * storage." sends `storageOpen` and the storage window fills from the `storage` snapshot. The server may end the
 * conversation at any time (`npcDialogClose`: walked away, died, warped); that closes every window of it. Closing
 * any of them, "End conversation" or Esc sends `npcClose`.
 * Right click on a bag item routes to the storage (deposit) or the shop (sell) while one is open. `itemCooldown`
 * arms `item:<group>` on the HUD's CooldownClock, which draws the sweep on the bag slots; `itemCast`/`itemCastEnd`
 * of our own character drive the cast bar.
 */
import { DEFAULT_LEVEL_CAP, type ClientMessage, type GameplayRequest, type ServerMessage, type StorageGoldDir } from '@sro/shared'
import { genderOf } from '../../content/catalog.ts'
import { ItemCastBar } from '../../hud/item-cast.ts'
import { itemCooldownKey } from '../../hud/cooldowns.ts'
import { actionFailText } from '../../hud/index.ts'
import { intent, parseCount } from '../../hud/intents.ts'
import { formatNumber } from '../../hud/items.ts'
import { NpcDialogWindow, npcQuestHandler, type NpcTalkContext } from '../../hud/npc-dialog.ts'
import { NpcConversation } from '../../hud/npc-state.ts'
import { amountDialog, type AmountRequest } from '../../hud/npc-ui.ts'
import { ShopWindow } from '../../hud/shop.ts'
import { greetingOf, sellValue, SELL_CONFIRM_GOLD, shopFor, unsellable, type Gender } from '../../hud/shop-logic.ts'
import { Tooltip } from '../../hud/slots.ts'
import { StorageWindow } from '../../hud/storage.ts'
import { parseGold, StorageState, storageDropIntent, storageFee, type StorageRef } from '../../hud/storage-state.ts'
import { t } from '../../i18n/index.ts'
import type { WorldFeature, WorldFeatureContext, WorldFeatureFactory } from '../features.ts'
import { intents } from '../intents.ts'
import type { EntityView } from '../entities.ts'

/** Requests whose refusals the HUD toasts for us (shopBuy / shopSell are already the HUD's own). */
const CLAIMED: readonly GameplayRequest[] = ['storageOpen', 'storageDeposit', 'storageWithdraw', 'storageMove', 'storageGold', 'shopBuyback']
/** A second click on the NPC being talked to within this time sends nothing (npcTalk budget: 2/s). */
const TALK_RESEND_MS = 600

type Msg<K extends ServerMessage['t']> = Extract<ServerMessage, { t: K }>

export const npcFeature: WorldFeatureFactory = ctx => {
  // The seam tests start every feature with an empty context: without a HUD there is nothing to drive.
  if (!ctx?.hud || !ctx.session) return {}
  return createNpcFeature(ctx)
}

function createNpcFeature(ctx: WorldFeatureContext): WorldFeature {
  const { app, hud } = ctx
  const content = app.catalog.content
  const items = hud.items
  const inv = hud.inventory
  const conv = new NpcConversation()
  const storage = new StorageState()
  const tooltip = new Tooltip(app.art)
  const castBar = new ItemCastBar(hud.layer)
  const offs: (() => void)[] = []
  let levelCap = DEFAULT_LEVEL_CAP
  let selfModel: string | null = null
  let gold = hud.stats?.gold ?? inv.gold
  let closeModal: (() => void) | null = null
  let lastTalk = { npc: -1, at: -Infinity }
  /** A shopBuyback is on its way: further presses wait for its answer or the next `buyback` list. */
  let buybackPending = false

  const send = (msg: ClientMessage | null): boolean => (msg ? ctx.send(msg) : false)
  const toast = (text: string, kind: 'info' | 'error' | 'loot' = 'info') => hud.toast(text, kind)
  const level = () => hud.stats?.level ?? null
  const gender = (): Gender => {
    const id = ctx.selfId()
    const model = selfModel ?? (id !== null ? ctx.view(id)?.state.model : undefined)
    return model ? genderOf(model) : 'male'
  }
  const ask = (req: AmountRequest) => {
    closeModal?.()
    const close = amountDialog(app.art, app.ui, {
      ...req,
      onOk: n => {
        closeModal = null
        req.onOk(n)
      },
    })
    closeModal = () => {
      closeModal = null
      close()
    }
  }
  const openInventory = () => {
    if (hud.openInventory) return hud.openInventory()
    const win = hud.layer.querySelector<HTMLElement>('.hud-window-inventory')
    if (win?.hidden) hud.toggleInventory()
  }
  const npcName = (talk: { npc: number; code: string }) => ctx.view(talk.npc)?.state.name ?? content.npcs.get(talk.code)?.name ?? talk.code

  // ---- windows ------------------------------------------------------------------------------------
  const dialog = new NpcDialogWindow(app.art, hud.layer)
  const shop = new ShopWindow(app.art, hud.layer, {
    items,
    tooltip,
    bag: inv,
    gold: () => gold,
    level,
    buy: (code, count) => {
      const npc = conv.current?.npc
      if (npc !== undefined) send(intent.shopBuy(npc, code, count))
    },
    buyback: index => {
      const npc = conv.current?.npc
      const e = conv.buyback[index]
      if (npc === undefined || !e || buybackPending) return
      if (e.price > gold) return toast(t('action.fail.not_enough_gold'), 'error')
      if (send(intent.shopBuyback(npc, index, e.item.code))) buybackPending = true
    },
    sell: bag => sell(bag),
    ask,
    toast,
  })
  const storageWin = new StorageWindow(app.art, hud.layer, {
    items,
    tooltip,
    state: storage,
    bag: inv,
    bagGold: () => gold,
    level,
    move: (from, to, split) => moveItem(from, to, split),
    withdraw: (slot, split) => moveItem({ kind: 'storage', slot }, { kind: 'bag', slot: -1 }, split),
    gold: dir => moveGold(dir),
  })

  /** Hides every window of the conversation (no message). */
  const closeWindows = () => {
    closeModal?.()
    tooltip.hide()
    dialog.reset()
    shop.hide()
    storageWin.hide()
    storage.clear()
  }
  /** The player ends the conversation: windows closed, `npcClose` sent. */
  const endConversation = () => {
    const msg = conv.close()
    closeWindows()
    send(msg)
  }
  dialog.onEnd = endConversation
  shop.onEnd = endConversation
  storageWin.onEnd = endConversation

  dialog.onShop = talk => {
    const def = shopFor(talk.code, content.npcs, content.shops) ?? shopFor(ctx.view(talk.npc)?.state.model ?? '', content.npcs, content.shops)
    if (!def) return toast(t('npc.noShop'), 'error')
    if (!conv.show('shop')) return
    dialog.hide()
    storageWin.hide()
    shop.show(talk.name, def, gender(), levelCap)
    shop.setBuyback(conv.buyback)
    openInventory()
  }
  dialog.onStorage = talk => {
    if (!conv.show('storage')) return
    storage.clear()
    dialog.hide()
    shop.hide()
    storageWin.show(talk.name)
    openInventory()
    if (!send(intent.storageOpen(talk.npc))) backToDialog()
  }
  dialog.onQuest = talk => {
    const handler = npcQuestHandler()
    if (handler) handler(talk)
    else toast(t('npc.noQuest'))
  }

  /** The storage could not open (refused): back to the dialog. */
  const backToDialog = () => {
    if (!conv.open) return
    storageWin.hide()
    shop.hide()
    storage.clear()
    conv.show('dialog')
    if (dialog.talk) {
      dialog.showServices()
      dialog.open()
    }
  }

  const openDialog = (msg: Msg<'npcDialog'>) => {
    closeModal?.()
    const talk = conv.opened(msg)
    const view = ctx.view(talk.npc)
    shop.hide()
    storageWin.hide()
    storage.clear()
    const name = npcName(talk)
    const info: Omit<NpcTalkContext, 'dialog'> = { npc: talk.npc, code: talk.code, name, services: talk.services }
    // Wave 11 (docs/UNIQUES.md §3.10): the server's conditional lines (a unique's rumour) follow the greeting.
    const greeting = greetingOf(talk.code, content.npcs, view?.state.model)
    const lines = msg.lines ?? []
    dialog.show(info, lines.length ? [greeting ?? t('npc.greeting.default'), ...lines].join('\n\n') : greeting)
  }

  // ---- selling, storage moves, gold ------------------------------------------------------------------
  const sell = (bag: number) => {
    const npc = conv.current?.npc
    const stack = inv.item(bag)
    if (npc === undefined || conv.panel !== 'shop' || !stack) return
    const def = items.def(stack.code)
    if (unsellable(def)) return toast(t('shop.cantSell'), 'error')
    const name = items.stackName(stack)
    if (stack.count > 1) {
      return ask({
        title: t('shop.sellTitle'),
        body: t('shop.sellBodyCount', { name, max: stack.count, gold: formatNumber(sellValue(def, 1)) }),
        ok: t('shop.sell'),
        max: stack.count,
        initial: stack.count,
        parse: parseCount,
        onOk: n => send(intent.shopSell(npc, bag, n >= stack.count ? undefined : n)),
      })
    }
    const value = sellValue(def, 1)
    if (value >= SELL_CONFIRM_GOLD) {
      return ask({
        title: t('shop.sellTitle'),
        body: t('shop.sellConfirm', { name, gold: formatNumber(value) }),
        ok: t('shop.sell'),
        max: 1,
        initial: 1,
        parse: () => 1,
        onOk: () => send(intent.shopSell(npc, bag)),
      })
    }
    send(intent.shopSell(npc, bag))
  }

  const moveItem = (from: StorageRef, to: StorageRef, split: boolean) => {
    const npc = conv.current?.npc
    if (npc === undefined || conv.panel !== 'storage' || !storage.known) return
    const stack = from.kind === 'bag' ? inv.item(from.slot) : storage.item(from.slot)
    if (!stack) return
    const def = items.def(stack.code)
    if (from.kind === 'bag' && (def?.canStore === false || def?.category === 'quest')) return toast(t('storage.cantStore'), 'error')
    const build = (count?: number) => storageDropIntent(npc, storage, inv, from, to, code => items.def(code), count)
    if (!split || stack.count < 2 || (from.kind === 'storage' && to.kind === 'storage')) return void send(build())
    const deposit = from.kind === 'bag'
    const fee = deposit ? storageFee(def, 1) : 0
    ask({
      title: t(deposit ? 'storage.depositTitle' : 'storage.withdrawTitle'),
      body: fee > 0 ? t('storage.countBodyFee', { name: items.stackName(stack), max: stack.count, gold: formatNumber(fee) }) : t('storage.countBody', { name: items.stackName(stack), max: stack.count }),
      ok: t(deposit ? 'storage.deposit' : 'storage.withdraw'),
      max: stack.count,
      initial: stack.count,
      parse: parseCount,
      onOk: n => send(build(n >= stack.count ? undefined : n)),
    })
  }

  const moveGold = (dir: StorageGoldDir) => {
    const npc = conv.current?.npc
    if (npc === undefined || !storage.known) return
    const max = dir === 'deposit' ? gold : storage.gold
    if (max < 1) return toast(t('action.fail.not_enough_gold'), 'error')
    ask({
      title: t(dir === 'deposit' ? 'storage.goldDepositTitle' : 'storage.goldWithdrawTitle'),
      body: t('storage.goldBody', { max: formatNumber(max) }),
      ok: t(dir === 'deposit' ? 'storage.deposit' : 'storage.withdraw'),
      max,
      initial: max,
      parse: parseGold,
      onOk: n => send(intent.storageGold(npc, dir, n)),
    })
  }

  // Right click on a bag item: deposit while the storage is open, sell while the shop is open.
  offs.push(
    hud.routeBagAction(bag => {
      if (conv.panel === 'storage' && storageWin.isOpen) {
        moveItem({ kind: 'bag', slot: bag }, { kind: 'storage', slot: -1 }, false)
        return true
      }
      if (conv.panel === 'shop' && shop.isOpen) {
        sell(bag)
        return true
      }
      return false
    }),
  )
  hud.claimRequests(CLAIMED)

  // ---- item cooldown sweeps on bag slots ----------------------------------------------------------------
  /** What each bag slot's sweep was last set to (`readyAt|code`), so unchanged slots are left running. */
  const sweeps = new Map<number, string>()
  const cooldownKeyOf = (code: string): string | null => {
    const use = items.def(code)?.use
    return use ? itemCooldownKey(use.cooldownGroup ?? code) : null
  }
  const refreshSweeps = (all = false) => {
    if (!hud.bagSlot) return
    if (all) sweeps.clear()
    const now = performance.now()
    for (let i = 0; i < inv.bagSize; i++) {
      const slot = hud.bagSlot(i)
      if (!slot) continue
      const stack = inv.item(i)
      const key = stack ? cooldownKeyOf(stack.code) : null
      const e = key ? hud.cooldowns.get(key) : null
      const sig = e && e.readyAt > now ? `${e.readyAt}|${stack!.code}` : ''
      if ((sweeps.get(i) ?? '') === sig) continue
      if (sig) {
        slot.setCooldown(e!.readyAt, e!.totalMs)
        sweeps.set(i, sig)
      } else {
        slot.setCooldown(0, 0)
        sweeps.delete(i)
      }
    }
  }
  offs.push(hud.cooldowns.onChange(key => key.startsWith('item:') && refreshSweeps()))

  // ---- gold and bag changes ----------------------------------------------------------------------------
  const goldChanged = () => {
    if (shop.isOpen) shop.refresh()
    if (storageWin.isOpen) storageWin.renderGold()
  }

  const onMessage = (msg: ServerMessage) => {
    switch (msg.t) {
      case 'worldEnter':
        levelCap = msg.world.levelCap ?? DEFAULT_LEVEL_CAP
        selfModel = msg.self.model
        // A re-enter (reconnect) starts without a conversation.
        conv.close()
        closeWindows()
        castBar.reset()
        buybackPending = false
        break
      case 'stats':
        gold = msg.stats.gold
        goldChanged()
        break
      case 'statsDelta':
        if (msg.stats.gold !== undefined) {
          gold = msg.stats.gold
          goldChanged()
        }
        break
      case 'inventory':
        gold = inv.gold
        refreshSweeps(true)
        goldChanged()
        break
      case 'inventoryUpdate':
        if (msg.gold !== undefined) gold = msg.gold
        refreshSweeps()
        goldChanged()
        break
      case 'npcDialog':
        openDialog(msg)
        break
      case 'npcDialogClose':
        if (conv.serverClosed(msg)) closeWindows()
        break
      case 'buyback':
        buybackPending = false
        conv.buyback = msg.entries.map(e => ({ item: { ...e.item }, price: e.price }))
        shop.setBuyback(conv.buyback)
        break
      case 'storage':
        if (conv.panel !== 'storage') break
        storageWin.render(storage.setSnapshot(msg.storage))
        break
      case 'storageUpdate':
        if (!storage.known) break
        storageWin.render(storage.apply(msg))
        break
      case 'itemCooldown':
        hud.cooldowns.setIn(itemCooldownKey(msg.group), msg.readyInMs, msg.totalMs)
        break
      case 'itemCast':
        if (msg.id === ctx.selfId()) castBar.start(msg.item, items.name(msg.item), msg.castMs)
        break
      case 'itemCastEnd':
        if (msg.id !== ctx.selfId()) break
        castBar.end(msg.reason)
        if (msg.reason !== 'done') toast(t('cast.cancelled'), 'error')
        break
      case 'actionResult':
        // A refused buyback sends no new list: the next press may go.
        if (msg.re === 'shopBuyback' && !msg.ok) buybackPending = false
        if (msg.ok) break
        if (msg.re === 'npcTalk' && msg.reason !== 'rate_limited') toast(actionFailText(msg.reason, msg.message), 'error')
        if (msg.re === 'storageOpen' && conv.panel === 'storage' && !storage.known) backToDialog()
        break
    }
  }

  return {
    onMessage,
    clickEntity(v: EntityView): boolean {
      if (v.kind !== 'npc') return false
      ctx.setTarget(v)
      const self = ctx.selfId()
      if (self !== null && ctx.view(self)?.dead) return true
      const now = performance.now()
      if (conv.isWith(v.id)) {
        // Already talking to this NPC: bring its window forward.
        if (shop.isOpen) shop.raise()
        else if (storageWin.isOpen) storageWin.raise()
        else if (dialog.isOpen) dialog.raise()
        return true
      }
      if (lastTalk.npc === v.id && now - lastTalk.at < TALK_RESEND_MS) return true
      // Talking to someone else replaces the open conversation (the server closes the old one).
      if (conv.open) {
        conv.close()
        closeWindows()
      }
      if (send(intents.npcTalk(v.id))) lastTalk = { npc: v.id, at: now }
      return true
    },
    escape(): boolean {
      if (closeModal) {
        closeModal()
        return true
      }
      if (!conv.open && !dialog.isOpen && !shop.isOpen && !storageWin.isOpen) return false
      endConversation()
      return true
    },
    onFrame() {
      castBar.update()
    },
    onEntityRemoved(v: EntityView) {
      // The NPC left our view (warp, despawn): the server ends its side on its own.
      if (conv.isWith(v.id)) {
        conv.close()
        closeWindows()
      }
    },
    dispose() {
      for (const off of offs.splice(0)) off()
      closeModal?.()
      dialog.dispose()
      shop.dispose()
      storageWin.dispose()
      tooltip.dispose()
      castBar.dispose()
    },
  }
}
