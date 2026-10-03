/**
 * World feature of lane QS-C, the quest client (docs/QUESTS.md §2; WAVE_PLAN §5.2). Only that lane edits this file; see
 * world/features.ts for the context and hooks.
 *
 * - Data: the catalog (`GET /api/quests`, refetched on `contentChanged {kind: 'quests'}`) and the quest state
 *   (`quests` / `questUpdate`), both in apps/game/src/quests/.
 * - NPC marks over NPCs through `EntityView.setBadge('quest', ...)` (quests/markers.ts).
 * - The NPC dialog's quest option (decision 1): `setNpcQuestHandler` opens the quest pages (quests/dialog-panel.ts).
 * - The log (Q, alias L, and the menu-bar Quest button), the tracker under the minimap block, minimap circles and pins
 *   (`addMarkerSource`), and the notifications (accepted, progress, ready, completed banner, useItem visions).
 * Quest intents are built by `quests/intents.ts` (`questIntent`); refusals are toasted by the HUD (`claimRequests`).
 */
import { armorClassToken, genderOfModel, type ClientMessage, type GameplayRequest, type QuestObjective, type ServerMessage } from '@sro/shared'
import { prettyCode, type TooltipLine } from '../../hud/items.ts'
import { setNpcQuestHandler, type NpcTalkContext } from '../../hud/npc-dialog.ts'
import { amountDialog } from '../../hud/npc-ui.ts'
import { Tooltip } from '../../hud/slots.ts'
import { t } from '../../i18n/index.ts'
import { el } from '../../ui/dom.ts'
import { httpCatalogLoader, QuestCatalog } from '../../quests/catalog.ts'
import { QuestDialogController, QuestDialogPanel, type IconDeps } from '../../quests/dialog-panel.ts'
import { questTopics, type QuestDialogEnv } from '../../quests/dialog.ts'
import { questNotices, type QuestNames, type QuestNotice, type QuestReader } from '../../quests/format.ts'
import { questIntent } from '../../quests/intents.ts'
import { QuestLogWindow } from '../../quests/log.ts'
import { NpcMarkers, questMapMarkers } from '../../quests/markers.ts'
import { npcIdentity, QuestState } from '../../quests/state.ts'
import { ensureQuestStyles } from '../../quests/style.ts'
import { QuestTracker, TRACK_MAX } from '../../quests/tracker.ts'
import { layerScale } from '../../ui/kit/scale.ts'
import type { EntityView } from '../entities.ts'
import type { WorldFeature, WorldFeatureContext, WorldFeatureFactory } from '../features.ts'

/** The quest requests whose refusals the HUD toasts (docs/QUESTS.md §2.3). */
export const QUEST_REQUESTS: readonly GameplayRequest[] = ['questAccept', 'questTurnIn', 'questAbandon', 'questTalk', 'questUseItem']
/** localStorage: tracked quest ids per character name (per viewer). */
export const TRACKED_KEY = 'sro.quests.tracked'
const VISION_MS = 6000
const BANNER_MS = 3600
/** Seconds between the cheap periodic checks (tracker position, Use buttons, waiting pages). */
const TICK_S = 0.5
/** Seconds between marker refreshes that events do not cover (repeatables coming off cooldown). */
const MARKS_S = 5

/** The placeholder quest page in the NPC dialog: one line, Back (to the services) and End conversation. */
export function placeholderQuestPage(talk: Pick<NpcTalkContext, 'dialog'>): void {
  talk.dialog.setContent(t('npc.noQuest'), [
    { label: t('quest.back'), run: () => talk.dialog.showServices() },
    { label: t('npc.option.end'), run: () => talk.dialog.close(), end: true },
  ])
}

/** Tracked ids per character, from localStorage (empty when blocked or junk). */
export function readTracked(raw: string | null): Record<string, string[]> {
  try {
    const v = JSON.parse(raw ?? '{}') as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    const out: Record<string, string[]> = {}
    for (const [k, ids] of Object.entries(v as Record<string, unknown>)) {
      if (Array.isArray(ids)) out[k] = ids.filter((x): x is string => typeof x === 'string').slice(0, 64)
    }
    return out
  } catch {
    return {}
  }
}

export const questsFeature: WorldFeatureFactory = ctx => {
  // The seam tests start every feature with an empty context: without a HUD there is nothing to drive.
  if (!ctx?.hud || !ctx.session) return {}
  return createQuestsFeature(ctx)
}

function createQuestsFeature(ctx: WorldFeatureContext): WorldFeature {
  const { app, hud } = ctx
  const content = app.catalog.content
  const items = hud.items
  ensureQuestStyles()
  const quests = new QuestState()
  // The ?mock=1 server has no quest catalog (its quest requests answer not_implemented): an empty one, no fetch.
  const catalog = new QuestCatalog(app.transport.mock ? async () => ({ rev: 0, files: [] }) : httpCatalogLoader(() => app.token))
  const tooltip = new Tooltip(app.art)
  const offs: (() => void)[] = []
  let selfName = ''
  let selfModel = ''
  let level = hud.stats?.level ?? 1
  let closeModal: (() => void) | null = null

  // ---- names, reader, env ------------------------------------------------------------------------------
  const viewOf = (npc: string): EntityView | undefined => {
    for (const v of ctx.views()) if (v.kind === 'npc' && npcIdentity(v.state) === npc) return v
    return undefined
  }
  const names: QuestNames = {
    mob: code => content.mobs.get(code)?.name || prettyCode(code.replace(/^MOB_(CH_|EU_)?/, '')),
    npc: code => content.npcs.get(code)?.name || viewOf(code)?.state.name || prettyCode(code.replace(/^NPCX?_(CH_)?/, '')),
    item: code => catalog.item(code)?.name ?? items.name(code),
    icon: code => {
      const q = catalog.item(code)
      if (q) return q.iconItem ? items.icon(q.iconItem) : null
      return items.icon(code)
    },
  }
  const tip = (code: string, count: number): TooltipLine[] => {
    const q = catalog.item(code)
    if (q) {
      const lines: TooltipLine[] = [{ text: count > 1 ? `${q.name} x${count}` : q.name, cls: 'title' }, { text: t('quest.item.desc'), cls: 'type' }]
      if (q.description) lines.push({ text: q.description, cls: 'desc' })
      return lines
    }
    if (items.def(code)) return items.tooltip({ code, count }, { player: hud.stats, model: selfModel || null })
    return [{ text: count > 1 ? `${names.item(code)} x${count}` : names.item(code), cls: 'title' }]
  }
  const reader = (): QuestReader => {
    const chest = hud.inventory.equipped('chest')
    return {
      name: selfName,
      level,
      gender: genderOfModel(selfModel),
      armor: armorClassToken(chest ? items.def(chest.code)?.armorType : undefined),
    }
  }
  const expToNext = (lv: number) => content.levels[lv - 1]?.exp ?? 0
  const now = () => ctx.serverNow()
  const iconDeps: IconDeps = { art: app.art, tooltip, tip }

  const send = (msg: ClientMessage | null): boolean => {
    if (!msg) return false
    if (ctx.send(msg)) return true
    hud.toast(t('net.notConnected'), 'error')
    return false
  }
  hud.claimRequests(QUEST_REQUESTS)

  // ---- tracked quests (per viewer, per character) ---------------------------------------------------------
  let tracked: string[] = []
  let trackedKnown = false
  const loadTracked = () => {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(TRACKED_KEY)
    } catch {
      raw = null
    }
    const all = readTracked(raw)
    trackedKnown = selfName in all
    tracked = all[selfName] ?? []
  }
  const saveTracked = () => {
    try {
      const all = readTracked(localStorage.getItem(TRACKED_KEY))
      all[selfName] = tracked.filter(id => quests.active.has(id))
      localStorage.setItem(TRACKED_KEY, JSON.stringify(all))
    } catch {
      // storage blocked: tracking lasts this visit only
    }
  }
  /** Tracked and still active, in tracking order. */
  const trackedIds = (): string[] => tracked.filter(id => quests.active.has(id))
  const setTracked = (id: string, on: boolean) => {
    tracked = tracked.filter(x => x !== id && quests.active.has(x))
    if (on) tracked.push(id)
    saveTracked()
    refreshViews()
  }

  // ---- windows ----------------------------------------------------------------------------------------------
  const canUse = (o: Extract<QuestObjective, { type: 'useItem' }>): boolean => {
    const id = ctx.selfId()
    const self = id !== null ? ctx.view(id) : undefined
    if (!self || self.dead) return false
    const loc = catalog.location(o.location)
    if (!loc) return true
    const dx = self.pos.x - loc.x
    const dz = self.pos.z - loc.z
    return dx * dx + dz * dz <= loc.radius * loc.radius
  }
  const use = (quest: string, objective: string) => void send(questIntent.questUseItem(quest, objective))
  const abandon = (id: string) => {
    closeModal?.()
    const title = catalog.quest(id)?.title ?? id
    const close = amountDialog(app.art, app.ui, {
      title: t('quest.abandonTitle'),
      body: t('quest.abandonConfirm', { title }),
      ok: t('quest.abandon'),
      max: 1,
      initial: 1,
      parse: () => 1,
      onOk: () => {
        closeModal = null
        send(questIntent.questAbandon(id))
      },
    })
    closeModal = () => {
      closeModal = null
      close()
    }
  }
  const log = new QuestLogWindow(app.art, hud.layer, {
    ...iconDeps,
    quests,
    catalog,
    names,
    reader,
    expToNext,
    now,
    isTracked: id => trackedIds().includes(id),
    setTracked,
    abandon,
    use,
    canUse,
    catalogLoaded: () => catalog.loaded,
  })
  const tracker = new QuestTracker(hud.layer, {
    art: app.art,
    quests,
    catalog,
    names,
    tracked: trackedIds,
    openLog: id => log.showQuest(id),
    use,
    canUse,
    now,
  })
  offs.push(
    ctx.keys.register({ id: 'window.quests', keys: ['q', 'l'], label: 'keys.window.quests', group: 'windows', run: () => log.toggle() }),
    hud.menubar.register({ id: 'quests', art: 'mainpopup/main_sysbutton_quest', label: 'quest.log.title', hotkey: 'Q', order: 40, toggle: () => log.toggle(), isOpen: () => log.isOpen }),
  )

  // ---- NPC dialog -------------------------------------------------------------------------------------------
  const dialogEnv: QuestDialogEnv = {
    reader,
    now,
    names,
    expToNext,
    request: (msg, quest) => {
      if (!send(msg)) return false
      controller?.sent(quest)
      return true
    },
  }
  /** No topics: "nothing more to tell", or, while the catalog has not arrived yet, "reading..." (and fetch it). */
  const nothingToTell = (talk: NpcTalkContext) => {
    if (catalog.loaded) return placeholderQuestPage(talk)
    void catalog.refresh()
    talk.dialog.setContent(t('quest.log.loading'), [
      { label: t('quest.back'), run: () => talk.dialog.showServices() },
      { label: t('npc.option.end'), run: () => talk.dialog.close(), end: true },
    ])
  }
  let panel: QuestDialogPanel | null = null
  let controller: QuestDialogController | null = null
  let panelHost: NpcTalkContext['dialog'] | null = null
  const openQuestTalk = (talk: NpcTalkContext) => {
    if (!panel || panelHost !== talk.dialog) {
      panel?.dispose()
      panelHost = talk.dialog
      panel = new QuestDialogPanel(talk.dialog, iconDeps)
      controller = new QuestDialogController(panel, c => questTopics(c, quests, catalog, dialogEnv), nothingToTell)
    }
    controller!.open(talk)
  }
  offs.push(setNpcQuestHandler(openQuestTalk))

  // ---- NPC marks and the minimap --------------------------------------------------------------------------------
  const markers = new NpcMarkers(npc => quests.markFor(npc, level, now(), catalog))
  const refreshMarks = () => markers.updateAll(ctx.views())
  const npcAt = (npc: string): { x: number; z: number } | null => {
    const def = content.npcs.get(npc)
    if (def) return { x: def.x, z: def.z }
    const v = viewOf(npc)
    return v ? { x: v.pos.x, z: v.pos.z } : null
  }
  let minimap: ReturnType<WorldFeatureContext['minimap']> = null
  let offMinimap: (() => void) | null = null
  const wireMinimap = () => {
    const m = ctx.minimap()
    if (m === minimap) return
    offMinimap?.()
    offMinimap = null
    minimap = m
    if (m) offMinimap = m.addMarkerSource(() => questMapMarkers(trackedIds(), quests, catalog, npcAt))
  }

  // ---- redraws ----------------------------------------------------------------------------------------------
  const refreshViews = () => {
    tracker.render()
    log.refresh()
  }
  const refreshAll = () => {
    refreshMarks()
    refreshViews()
    controller?.redraw()
  }
  offs.push(catalog.onChange(refreshAll))

  // ---- notifications ------------------------------------------------------------------------------------
  const banner = el('div', 'hud-levelup quest-banner')
  const vision = el('div', 'quest-vision')
  hud.layer.append(banner, vision)
  let bannerTimer: ReturnType<typeof setTimeout> | undefined
  let visionTimer: ReturnType<typeof setTimeout> | undefined
  const showBanner = (title: string) => {
    clearTimeout(bannerTimer)
    banner.replaceChildren(el('div', 'hud-levelup-title', t('quest.banner.title')), el('div', 'hud-levelup-sub', title))
    banner.classList.remove('in')
    void banner.offsetWidth
    banner.classList.add('in')
    bannerTimer = setTimeout(() => banner.classList.remove('in'), BANNER_MS)
  }
  const showVision = (text: string) => {
    clearTimeout(visionTimer)
    vision.textContent = text
    vision.classList.add('in')
    visionTimer = setTimeout(() => vision.classList.remove('in'), VISION_MS)
  }
  const notify = (list: QuestNotice[]) => {
    for (const n of list) {
      if (n.vision) {
        showVision(n.vision)
        ctx.chat.add('system', n.vision)
        continue
      }
      if (n.banner) showBanner(n.banner)
      if (n.text) {
        hud.toast(n.text, n.kind)
        if (n.chat) ctx.chat.add('system', n.text)
      }
    }
  }

  // ---- messages -----------------------------------------------------------------------------------------
  const setLevel = (lv: number | undefined) => {
    if (lv === undefined || !Number.isFinite(lv) || lv === level) return
    level = lv
    refreshMarks()
    log.refresh()
    controller?.redraw()
  }

  const onMessage = (msg: ServerMessage) => {
    switch (msg.t) {
      case 'worldEnter':
        selfName = msg.self.name
        selfModel = msg.self.model
        level = msg.self.level
        quests.apply(msg)
        loadTracked()
        controller?.reset()
        closeModal?.()
        void catalog.refresh()
        refreshAll()
        break
      case 'quests': {
        quests.apply(msg)
        if (catalog.loaded) catalog.ensureRev(msg.rev)
        if (!trackedKnown) {
          // First visit of this character on this browser: track what is active.
          trackedKnown = true
          tracked = quests.activeList().slice(0, TRACK_MAX).map(p => p.quest)
          saveTracked()
        }
        refreshAll()
        break
      }
      case 'questUpdate': {
        const change = quests.apply(msg)
        if (!change) break
        if (msg.event === 'accepted' && !tracked.includes(msg.quest) && trackedIds().length < TRACK_MAX) {
          tracked.push(msg.quest)
          saveTracked()
        }
        if (!msg.progress && tracked.includes(msg.quest)) {
          tracked = tracked.filter(x => x !== msg.quest)
          saveTracked()
        }
        try {
          notify(questNotices(change, catalog.quest(msg.quest), catalog, names, reader()))
        } catch (err) {
          console.error('[quests] notification failed', err)
        }
        refreshMarks()
        refreshViews()
        controller?.questChanged(msg.quest)
        break
      }
      case 'contentChanged':
        if (msg.kind === 'quests') void catalog.refresh()
        break
      case 'stats':
        setLevel(msg.stats.level)
        break
      case 'statsDelta':
        setLevel(msg.stats.level)
        break
      case 'levelUp':
        if (msg.id === ctx.selfId()) setLevel(msg.level)
        break
      case 'entityUpdate':
        if (msg.id === ctx.selfId()) setLevel(msg.level)
        break
      case 'actionResult':
        if (!msg.ok && QUEST_REQUESTS.includes(msg.re)) controller?.refused()
        break
      case 'npcDialog':
      case 'npcDialogClose':
        controller?.reset()
        break
    }
  }

  let tickT = 0
  let marksT = MARKS_S
  const placeTracker = () => {
    const m = minimap
    // Screen px over the HUD layer's zoom = native px in the layer (docs/UI.md §3.2).
    const top = m?.root.isConnected ? (m.root.getBoundingClientRect().bottom - hud.layer.getBoundingClientRect().top) / layerScale(hud.layer) + 10 : 48
    tracker.setTop(Math.max(0, top))
  }

  return {
    onMessage,
    onEntityAdded(v: EntityView) {
      if (v.kind === 'npc') markers.update(v)
    },
    onFrame(_now: number, dt: number) {
      tickT -= dt
      if (tickT > 0) return
      tickT = TICK_S
      wireMinimap()
      placeTracker()
      controller?.tick()
      if (tracker.hasUse) tracker.updateUse()
      if (log.isOpen) log.updateUse()
      marksT -= TICK_S
      if (marksT <= 0) {
        marksT = MARKS_S
        const hudLevel = hud.stats?.level
        if (hudLevel !== undefined && hudLevel !== level) setLevel(hudLevel)
        else refreshMarks()
      }
    },
    escape(): boolean {
      if (closeModal) {
        closeModal()
        return true
      }
      if (!log.isOpen) return false
      log.close()
      return true
    },
    dispose() {
      for (const off of offs.splice(0)) off()
      offMinimap?.()
      closeModal?.()
      clearTimeout(bannerTimer)
      clearTimeout(visionTimer)
      markers.clear(ctx.views())
      controller?.reset()
      panel?.dispose()
      catalog.dispose()
      log.dispose()
      tracker.dispose()
      tooltip.dispose()
      banner.remove()
      vision.remove()
    },
  }
}
