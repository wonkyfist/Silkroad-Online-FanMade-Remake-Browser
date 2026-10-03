/**
 * The in-game HUD: the retail layout of docs/UI.md §4.2 (hud/hud-layout.ts): player frame (HP/MP), the 2009 underbar
 * (quick slots, EXP band, SP, C/I/S and MENU; hud/underbar.ts), target window, floating combat numbers, level-up banner,
 * centre-screen messages, death overlay, and the inventory (I) and character (C) windows.
 *
 * Contract with the world screen (it creates one HUD per world visit and disposes it on leave):
 *   const hud = createHud(app, session, msg => session.send(msg))
 *   hud.setPlayer(stats) / setTarget(t | null) / damage(worldToScreen, amount, kind) / levelUp(level)
 *   hud.showDeath(onRespawn) / hideDeath() / setInventory(inv) / applyInventoryUpdate(msg) / toast(text, kind)
 *
 * The HUD also listens to the session itself for the messages that are only its business, so it stays
 * correct even when the world forwards nothing: `worldEnter` / `entityUpdate` (own name, model, level; a revival
 * hides the death box, the world decides when to show it), `stats` / `statsDelta` (incl. "+EXP" after kills),
 * `inventory` / `inventoryUpdate` (incl. the "obtained" lines for pickups), and failed `actionResult`s of the
 * requests the windows send (item*, shop*, statUp, respawn). Everything it applies is idempotent, so the world
 * calling the setters as well is harmless.
 * Server authority: the windows only send intents (via `send`) and redraw from the server's updates.
 */
import { CHARACTER_RULES, type ActionFailReason, type ClientMessage, type EquipSlot, type GameplayRequest, type Inventory, type PlayerStats, type ServerMessage } from '@sro/shared'
import type { App } from '../app.ts'
import { gameAudio } from '../audio/index.ts'
import { t, type StringKey } from '../i18n/index.ts'
import type { Session } from '../net/session.ts'
import { settings } from '../settings.ts'
import { el, Listeners } from '../ui/dom.ts'
import { MessageBox } from '../ui/kit/dialog.ts'
import { topWindow } from '../ui/kit/window.ts'
import { CharacterWindow } from './character.ts'
import { CooldownClock } from './cooldowns.ts'
import { DeathOverlay } from './death.ts'
import { Floaters, HudMessages, LevelUpBanner, type DamageKind } from './effects.ts'
import { dragIntent, intent, useIntent, type SlotRef } from './intents.ts'
import { InventoryWindow, type SlotEvents } from './inventory.ts'
import { InventoryState } from './inventory-state.ts'
import { canUse, formatNumber, ItemCatalog, loadItemCatalog } from './items.ts'
import { isTypingTarget, KeyMap } from './keys.ts'
import { disposeMainWindow, mainWindowFor } from './main-window.ts'
import { MenuBar } from './menubar.ts'
import { hudAnchors, placeAt, watchLayout, type HudAnchors } from './hud-layout.ts'
import { PlayerFrame, spGained } from './player.ts'
import { DragController, Tooltip, type SlotView } from './slots.ts'
import { TargetFrame, type TargetAction, type TargetEffectIcon, type TargetInfo } from './target.ts'
import { Underbar } from './underbar.ts'
import { createUxShell, type SystemWindow } from './ux-shell.ts'
import type { OptionsTab } from './options.ts'

export type InventorySnapshot = Inventory
export type { TargetInfo, DamageKind }
export { ItemCatalog, loadItemCatalog } from './items.ts'

export interface Hud {
  /** `name` (optional) is the own character name, which PlayerStats does not carry. */
  setPlayer(stats: PlayerStats & { name?: string }): void
  setTarget(t: TargetInfo | null): void
  damage(worldToScreen: () => { x: number; y: number } | null, amount: number, kind: DamageKind): void
  levelUp(level: number): void
  showDeath(onRespawn: () => void): void
  hideDeath(): void
  setInventory(inv: InventorySnapshot): void
  applyInventoryUpdate(u: unknown): void
  toast(text: string, kind?: 'info' | 'error' | 'loot'): void
  dispose(): void
  // ---- extras (not needed by the contract) ----
  /** Item names, icons and definitions (shared with the world for ground-item labels). */
  readonly items: ItemCatalog
  /** The inventory as the server last described it. */
  readonly inventory: InventoryState
  /** Latest full stats (null before the first `stats`). */
  readonly stats: PlayerStats | null
  toggleInventory(): void
  toggleCharacter(): void
  // ---- wave-3 seams (docs/WAVE_PLAN.md §3.2) ----
  /** Every game key registers here (hud/keys.ts); nobody adds a keydown listener of their own. */
  readonly keys: KeyMap
  /** `skill:<group>` / `item:<cooldownGroup>` cooldowns shared by hotbar, bag slots and skill window. */
  readonly cooldowns: CooldownClock
  /** Parent element for new HUD windows. */
  readonly layer: HTMLElement
  /** The window registry: the underbar's C/I/S buttons and the MENU popup rows (hud/menubar.ts). */
  readonly menubar: MenuBar
  // ---- UI-H (docs/UI.md §4.2, §4.5; mount points M1–M3) ----
  /** The 2009 underbar; `underbar.slots` is the Hotbar's parent. */
  readonly underbar: Underbar
  /** M1: the player frame, with `berserkHost` and `petHost` for the wave-8 Berserk orbs and horse frame. */
  readonly playerFrame: PlayerFrame
  /** M2: the HUD rects for the current layer size (durability, equipState, …; docs/UI.md §4.2). */
  readonly anchors: HudAnchors
  /** M3: adds a button to the target window beside the others (Invite, Exchange, Guild invite); returns its remover. */
  addTargetAction(a: TargetAction): () => void
  /** M3: re-asks every target action's `show` (call when what it depends on changed). */
  refreshTargetActions(): void
  /** The HUD toasts failed `actionResult`s of these requests too (a lane's windows send them). */
  claimRequests(types: readonly GameplayRequest[]): void
  /**
   * Right click on a bag slot: routes run last-registered first (storage, then shop), and the first that returns
   * true consumes the click; otherwise the default use/equip runs. Returns an unregister function.
   */
  routeBagAction(fn: (bag: number) => boolean): () => void
  /** Opens the world map (M); set by FLD-C's feature. */
  openWorldMap?: () => void
  /** SK-C: the target window's effect icons (buffs, statuses) under it. */
  setTargetEffects?(list: readonly TargetEffectIcon[]): void
  /** Deprecated (one wave, D15): replaces the actions set through this call only; use addTargetAction. */
  setTargetActions?(list: readonly TargetAction[]): void
  // ---- NPC-C (docs/WAVE_PLAN.md §4.6) ----
  /** Opens the inventory when it is closed (the shop and the storage open it beside them). */
  openInventory?(): void
  /** The inventory window's view of bag slot `i` (item cooldown sweeps via SlotView.setCooldown). */
  bagSlot?(i: number): SlotView | undefined
  /**
   * M8 (wave 8 trade / stall, decision D16): marks bag slots as locked under `key` (drawn blocked on every inventory
   * render until the owner clears them with an empty set).
   */
  markBagSlots(key: string, slots: ReadonlySet<number>): void
  /** The System window (Esc): screens/world.ts opens it with `menuItems()` (docs/UI.md §4.6). */
  readonly systemWindow: SystemWindow
  // ---- UX-A shell (hud/ux-shell.ts) ----
  /** The Options window (Esc menu, menu bar). */
  openOptions(tab?: OptionsTab): void
  /** The key help window (H). */
  toggleKeyHelp(): void
}

/** Requests whose refusals the HUD reports itself (the windows send them). */
const OWN_REQUESTS: readonly GameplayRequest[] = ['itemMove', 'itemSplit', 'itemEquip', 'itemUnequip', 'itemUse', 'itemDrop', 'statUp', 'respawn', 'shopBuy', 'shopSell']

/** A handler stack: the last one pushed is asked first; the first to return true consumes the call. */
export class RouteStack<T> {
  private routes: ((arg: T) => boolean)[] = []

  push(fn: (arg: T) => boolean): () => void {
    this.routes.push(fn)
    return () => {
      const i = this.routes.lastIndexOf(fn)
      if (i >= 0) this.routes.splice(i, 1)
    }
  }

  /** True when a route consumed `arg`. A route that throws counts as not consuming it. */
  run(arg: T): boolean {
    for (let i = this.routes.length - 1; i >= 0; i--) {
      try {
        if (this.routes[i]!(arg)) return true
      } catch (err) {
        console.error('[hud] route failed', err)
      }
    }
    return false
  }
}

/** Short English line for a refused gameplay request (docs/PROTOCOL.md ActionFailReason). */
export function actionFailText(reason: ActionFailReason | undefined, message?: string): string {
  if (!reason) return message ?? t('action.fail.generic')
  const key = `action.fail.${reason}` as StringKey
  const text = t(key)
  return text === key ? message ?? t('action.fail.generic') : text
}

/**
 * Retail puts the inventory beside the shop / storage: the Main window opened for an NPC service goes right of the
 * open NPC window (or left when there is no room), top-aligned. Native px of the HUD layer.
 */
function placeBesideNpcWindow(main: { root: HTMLElement; moveTo(x: number, y: number): void; size: [number, number] }, layer: HTMLElement): void {
  // Wave 8 (I8): the Alchemy window (a plain kit window) takes the inventory beside it too, as in retail.
  const npc = [...layer.querySelectorAll<HTMLElement>('.npc-window, .kit-window-alchemy')].find(w => !w.hidden && !w.classList.contains('hud-window-npc-dialog'))
  if (!npc) return
  const x = parseFloat(npc.style.left) || 0
  const y = parseFloat(npc.style.top) || 0
  const w = npc.offsetWidth
  const [mw] = main.size
  const room = layer.clientWidth || window.innerWidth
  // The Main window's side strip hangs 42 px out on its left.
  const right = x + w + 48
  main.moveTo(right + mw <= room ? right : Math.max(48, x - mw - 8), y)
}

export function createHud(app: App, session: Session, send: (msg: ClientMessage) => void): Hud {
  const art = app.art
  const ls = new Listeners()
  const root = el('div', 'hud-root')
  // Starts with the content tables the app already has (export over the builtin stand-ins, so mock-only items
  // have names and slots too); items.json and the icon index are adopted over them once loaded.
  const items = new ItemCatalog([...app.catalog.content.items.values()])
  const inv = new InventoryState()
  let stats: PlayerStats | null = null
  let gold = 0
  let selfId = -1
  let name = ''
  let model: string | null = null
  let disposed = false
  let modal: HTMLElement | null = null
  const ownRequests = new Set<string>(OWN_REQUESTS)
  const bagRoutes = new RouteStack<number>()
  const cooldowns = new CooldownClock()

  // ---- pieces ---------------------------------------------------------------------------------
  const player = new PlayerFrame(art, () => charWin.open())
  const target = new TargetFrame(art)
  const floaters = new Floaters()
  const banner = new LevelUpBanner()
  const messages = new HudMessages()
  const death = new DeathOverlay(art)
  const tooltip = new Tooltip(art)
  const windows = el('div', 'hud-windows')
  const menubar = new MenuBar(art)
  const underbar = new Underbar(art, menubar)
  root.append(player.root, target.root, underbar.root, banner.root, messages.root, windows, death.root)
  // UI-H: the retail layout (hud/hud-layout.ts), re-applied on every resize and UI-scale change.
  let anchors = hudAnchors(1024, 768)
  const stopLayout = watchLayout(root, (W, H) => {
    anchors = hudAnchors(W, H)
    placeAt(player.root, anchors.player)
    placeAt(target.root, anchors.target)
    placeAt(underbar.root, anchors.underbar)
    underbar.setDecorations(anchors.decoLeft !== null)
  })
  // The damage floaters sit at projected screen px, so they stay outside the zoomed .hud-root (docs/UI.md §3.2).
  app.ui.append(floaters.root, root)

  const toast = (text: string, kind: 'info' | 'error' | 'loot' = 'info') => {
    if (!disposed) messages.show(text, kind)
    if (!disposed && kind === 'error') gameAudio()?.ui('ui.error')
  }

  const sendIntent = (msg: ClientMessage | null) => {
    if (!msg || disposed) return
    if (session.status !== 'online') {
      toast(t('net.notConnected'), 'error')
      return
    }
    send(msg)
  }

  // ---- modal count / confirm dialogs (kit MessageBox, the retail msgbox2 window) -------------
  const closeModal = () => {
    modal?.remove()
    modal = null
  }
  /** Confirm box, or the retail count box (MsgBoxDivideCount) when `max` > 1. Resolves the amount through `onOk`. */
  const askCount = (opts: { title: string; body: string; ok: string; max: number; initial: number; onOk: (count: number) => void }) => {
    if (MessageBox.isOpen()) return
    const done = (n: number | null) => {
      if (n !== null && !disposed) opts.onOk(n)
    }
    if (opts.max > 1) void MessageBox.count({ title: opts.title, text: opts.body, max: opts.max, initial: opts.initial, ok: opts.ok, art }).then(done)
    else void MessageBox.confirm({ title: opts.title, text: opts.body, ok: opts.ok, cancel: t('hud.dialog.cancel'), art }).then(yes => done(yes ? 1 : null))
  }

  const confirmDrop = (bag: number) => {
    const stack = inv.item(bag)
    if (!stack) return
    const itemName = items.stackName(stack)
    askCount({
      title: t('hud.drop.title'),
      body: stack.count > 1 ? t('hud.drop.bodyCount', { name: itemName, max: stack.count }) : t('hud.drop.body', { name: itemName }),
      ok: t('hud.drop.confirm'),
      max: stack.count,
      initial: stack.count,
      onOk: n => sendIntent(n >= stack.count ? intent.itemDrop(bag) : intent.itemDrop(bag, n)),
    })
  }

  const askSplit = (from: number, to: number) => {
    const stack = inv.item(from)
    if (!stack || stack.count < 2) return
    askCount({
      title: t('hud.split.title'),
      body: t('hud.split.body', { name: items.stackName(stack), max: stack.count - 1 }),
      ok: t('hud.split.confirm'),
      max: stack.count - 1,
      initial: Math.floor(stack.count / 2),
      onOk: n => sendIntent(intent.itemSplit(from, to, n)),
    })
  }

  // ---- slots: drag, right click, tooltips ----------------------------------------------------
  const drag = new DragController({
    onDrop(from: SlotRef, to: SlotRef, ev: PointerEvent) {
      const r = dragIntent(inv, items, from, to, { split: ev.shiftKey })
      if (r === 'split') askSplit((from as { slot: number }).slot, (to as { slot: number }).slot)
      else if (r === 'nofit') toast(t('action.fail.invalid_slot'), 'error')
      else sendIntent(r)
    },
    onDropOutside(from: SlotRef) {
      if (from.kind === 'bag') confirmDrop(from.slot)
    },
  })
  drag.onStart = () => tooltip.hide()

  const slotEvents: SlotEvents = {
    down(view: SlotView, ev: PointerEvent) {
      if (ev.button === 0) drag.begin(view, ev)
    },
    context(view: SlotView) {
      tooltip.hide()
      if (view.ref.kind === 'bag') {
        if (!bagRoutes.run(view.ref.slot)) sendIntent(useIntent(inv, items, view.ref.slot))
      }
      else if (inv.equipped(view.ref.slot)) sendIntent(intent.itemUnequip(view.ref.slot))
    },
    hover(view: SlotView, ev: PointerEvent | null) {
      if (!ev || drag.dragging) return tooltip.hide()
      if (view.stack) tooltip.show(items.tooltip(view.stack, { player: stats, equipped: view.ref.kind === 'equip', model }), ev.clientX, ev.clientY)
      else if (view.ref.kind === 'equip') tooltip.show([{ text: t('equip.empty', { slot: t(`equip.${view.ref.slot}` as StringKey) }), cls: 'desc' }], ev.clientX, ev.clientY)
      else tooltip.hide()
    },
  }

  const invWin = new InventoryWindow(art, windows, items, inv, slotEvents)
  const charWin = new CharacterWindow(art, windows, items, inv, slotEvents, (stat, points) => sendIntent(intent.statUp(stat, points)))
  invWin.onClose = charWin.onClose = () => tooltip.hide()
  // The Main window (C/I/S/P/Q tabs): the equipment panel sits on the Inventory tab beside the bag.
  const mainWin = mainWindowFor(art, windows)
  invWin.equipHost.append(charWin.equipment.root)
  // Items the character cannot wear (level, gender, race) are tinted red (UX_GAPS W3).
  invWin.usable = stack => canUse(items.def(stack.code), stats, model)

  void loadItemCatalog().then(loaded => {
    if (disposed) return
    items.adopt(loaded)
    invWin.render()
    charWin.renderEquip()
  })

  // ---- state application ---------------------------------------------------------------------
  const renderGold = () => {
    invWin.renderMoney(gold)
    charWin.setGold(gold)
  }

  const setIdentity = (n: string | undefined, m: string | undefined, level?: number) => {
    if (n) name = n
    if (m && m !== model) {
      model = m
      invWin.render()
    }
    player.setIdentity(name, model)
    charWin.setIdentity(name, level ?? stats?.level ?? null)
  }

  const setPlayer = (s: PlayerStats & { name?: string }) => {
    const maybeName = s.name
    if (typeof maybeName === 'string' && maybeName && maybeName !== name) setIdentity(maybeName, undefined)
    const levelChanged = stats?.level !== s.level
    // SP-EXP rolled over (kill, quest) or a GM setlevel granted SP: "+1 SP" rises from the SP counter.
    const spUp = spGained(stats?.sp, s.sp)
    stats = { ...s, physAttack: [...s.physAttack] as [number, number], magAttack: [...s.magAttack] as [number, number] }
    if (levelChanged) invWin.render()
    gold = s.gold
    player.setStats(stats)
    underbar.setStats(stats, CHARACTER_RULES.spExpPerSp)
    if (spUp > 0) underbar.spGain(spUp)
    charWin.setStats(stats)
    renderGold()
  }

  const applyStatsDelta = (delta: Partial<PlayerStats>) => {
    if (!stats) return
    setPlayer({ ...stats, ...delta })
  }

  const setInventory = (snapshot: Inventory) => {
    const change = inv.setSnapshot(snapshot)
    gold = inv.gold
    invWin.render()
    charWin.renderEquip()
    renderGold()
    announceGains(change.gained, change.gold)
  }

  const applyInventoryUpdate = (u: unknown) => {
    const change = inv.apply(u)
    if (change.bag.length) invWin.update(change.bag)
    if (change.equip.length) charWin.renderEquip(change.equip as EquipSlot[])
    if (change.equip.length) gameAudio()?.equip(change.equip.map(s => inv.equipped(s as EquipSlot)?.code))
    if (change.gold !== 0) gold = inv.gold
    invWin.renderMoney(gold)
    renderGold()
    announceGains(change.gained, change.gold)
  }

  const announceGains = (gained: { code: string; count: number }[], goldDelta: number) => {
    if (goldDelta > 0) toast(t('hud.loot.gold', { gold: formatNumber(goldDelta) }), 'loot')
    for (const g of gained) toast(g.count > 1 ? t('hud.loot.items', { name: items.name(g.code), count: g.count }) : t('hud.loot.item', { name: items.name(g.code) }), 'loot')
  }

  const showDeath = (onRespawn: () => void) => death.show(onRespawn)
  const respawnSelf = () => sendIntent(intent.respawn())

  // ---- session messages ----------------------------------------------------------------------
  const onMessage = (msg: ServerMessage) => {
    if (disposed) return
    switch (msg.t) {
      case 'worldEnter':
        selfId = msg.self.id
        setIdentity(msg.self.name, msg.self.model, msg.self.level)
        if (msg.self.state === 'dead') {
          if (!death.shown) showDeath(respawnSelf)
        } else death.hide()
        break
      case 'entityUpdate':
        if (msg.id !== selfId) break
        if (msg.name !== undefined || msg.level !== undefined) setIdentity(msg.name, undefined, msg.level)
        if (msg.state === 'alive') death.hide()
        break
      case 'stats':
        setPlayer(msg.stats)
        break
      case 'statsDelta':
        applyStatsDelta(msg.stats)
        if (msg.gain) underbar.gain(msg.gain.exp, msg.gain.spExp)
        break
      case 'inventory':
        setInventory(msg.inventory)
        break
      case 'inventoryUpdate':
        applyInventoryUpdate(msg)
        break
      case 'actionResult':
        if (msg.ok || !ownRequests.has(msg.re)) break
        if (msg.re === 'respawn') {
          if (msg.reason === 'not_dead') death.hide()
          else death.enable()
        }
        toast(actionFailText(msg.reason, msg.message), 'error')
        break
    }
  }
  ls.add(session.on(onMessage))

  // ---- keys ----------------------------------------------------------------------------------
  // Esc closes the top window of every open kit window (Main, Options, System, Action, GM, NPC, shop, map, …).
  ls.on(
    window,
    'keydown',
    ev => {
      if (disposed) return
      if (ev.key === 'Escape') {
        if (drag.dragging) {
          drag.cancel()
          ev.stopImmediatePropagation()
          return
        }
        if (modal) {
          closeModal()
          ev.stopImmediatePropagation()
          return
        }
        // A message box handles its own Esc (its shade stops the key).
        if (MessageBox.isOpen()) return
        // A widget that handles Esc itself (an open kit Select popup, the quest editor) gets the key first.
        const t0 = ev.target as { closest?: (sel: string) => Element | null } | null
        if (typeof t0?.closest === 'function' && t0.closest('[data-own-esc]')) return
        const top = topWindow()
        if (top && !isTypingTarget(ev.target)) {
          top.close()
          ev.stopImmediatePropagation()
        }
        return
      }
    },
    { capture: true },
  )
  // Game keys (after the Esc listener above, which stops the event when it closes something).
  const keys = new KeyMap({ blocked: () => disposed || !!modal || MessageBox.isOpen() })
  keys.attach(window)
  keys.register({ id: 'window.inventory', keys: ['i'], label: 'keys.window.inventory', group: 'windows', run: () => invWin.toggle() })
  keys.register({ id: 'window.character', keys: ['c'], label: 'keys.window.character', group: 'windows', run: () => charWin.toggle() })
  // UX-A: Options and Key help windows, their menu entries, the menu bar buttons and the H / Ctrl+Shift+F keys.
  const shell = createUxShell({ app, layer: windows, keys, menubar, inventory: invWin, character: charWin, toast: text => toast(text) })

  // Initial empty state.
  player.setIdentity(name, model)
  renderGold()

  return {
    setPlayer,
    setTarget: tgt => target.set(tgt),
    setTargetEffects: list => target.setEffects(list),
    setTargetActions: list => target.setActions(list),
    addTargetAction: a => target.addAction(a),
    refreshTargetActions: () => target.refreshActions(),
    underbar,
    playerFrame: player,
    get anchors() {
      return anchors
    },
    damage: (at, amount, kind) => {
      if (!disposed && settings.get().ui.damageNumbers) floaters.add(at, amount, kind)
    },
    levelUp: level => {
      if (!disposed) banner.show(level)
    },
    showDeath,
    hideDeath: () => death.hide(),
    setInventory,
    applyInventoryUpdate,
    toast,
    dispose() {
      if (disposed) return
      disposed = true
      ls.clear()
      keys.dispose()
      shell.dispose()
      closeModal()
      drag.dispose()
      tooltip.dispose()
      invWin.dispose()
      charWin.dispose()
      disposeMainWindow(windows)
      floaters.dispose()
      banner.dispose()
      messages.dispose()
      death.dispose()
      menubar.dispose()
      stopLayout()
      underbar.dispose()
      root.remove()
    },
    items,
    inventory: inv,
    get stats() {
      return stats
    },
    toggleInventory: () => invWin.toggle(),
    toggleCharacter: () => charWin.toggle(),
    keys,
    cooldowns,
    layer: windows,
    menubar,
    claimRequests: types => {
      for (const r of types) ownRequests.add(r)
    },
    routeBagAction: fn => bagRoutes.push(fn),
    openWorldMap: undefined,
    openInventory: () => {
      const wasOpen = mainWin.isOpen
      invWin.open()
      if (!wasOpen) placeBesideNpcWindow(mainWin, windows)
    },
    bagSlot: i => invWin.slot(i),
    markBagSlots: (key, slots) => invWin.markSlots(key, slots),
    systemWindow: shell.system,
    openOptions: tab => shell.openOptions(tab),
    toggleKeyHelp: () => shell.toggleKeyHelp(),
  }
}
