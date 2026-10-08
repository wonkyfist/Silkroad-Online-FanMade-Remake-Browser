/**
 * Siege of Jangan, layers 5-6 on the client (docs/SIEGE.md §7, §8, §9.3, §9.5): player kegs, Wanted, Hunters, the jail.
 *
 * - **The WANTED label**: a red line "WANTED · 40,000" over every Wanted player (EntityState.wanted on spawn,
 *   `entityUpdate.wanted` when it changes; 0 removes it), for everyone. Layer 6: the blue "HUNTER · Tracker" badge over
 *   an on-duty Hunter (EntityState.hunter, `entityUpdate.hunter`, −1 removes it) and "PRISONER" over the jailed.
 * - **Banners** (`lawNotice`) on the one NoticeBanner queue: someone planting a Thunder Keg (no name), the breach that
 *   names the breaker and the bounty (the temple bell tolls), a keg defused, a warrant that lapsed, was pardoned or
 *   ended in a capture. Layer 6: `lawCapture` to the captors (the gold, or the 7-day pair rule) and the prisoner.
 * - **The left column** under the character frame (`lawState`): your warrant (the bounty, the online time left, the
 *   offence, "Hunters can attack you anywhere"), the Hunter panel (duty toggle, rank, captures, the Wanted online, the
 *   Net at the selected Wanted) and the Stockade panel (time left, offence, the clock, chores: Break rocks at the pile
 *   with its progress bar).
 * - **PvP** (layer 6): a click on a player the rule allows (you on duty and they Wanted, or you Wanted and they an
 *   on-duty Hunter) selects them and attacks; the server judges. On-duty Hunters see the Wanted within `senseM` on the
 *   minimap (red dots) and each `wantedPing` as a blue circle for a minute.
 * - **NPCs**: Old Fang (`fence`: the keg), Captain Yun (`hunter`: the licence, duty; his shop sells the Net), Warden
 *   Bae (`warden`: your sentence, or who sits inside).
 * - **The Garrison Stockade's look** (world/siege/stockade.ts) loads within 400 m.
 * - **Planting**: with a Thunder Keg in the bag and standing at the outer foot of a wall segment (the export's
 *   `siege/walls.json`, the shared `kegSpot`), a prompt over the hotbar offers "Plant the keg" (the bag's `itemUse`).
 * - The keg itself, its fuse, the Defuse prompt and the blast are the siege feature's (it draws every `keg`). Outside a
 *   siege this feature puts burning player kegs within 300 m on the minimap (blinking red).
 * - Debug: `window.__sroLaw` (state, the plant spot, open Old Fang's / Yun's / Bae's window, show a notice, a GM line).
 */
import {
  HUNTER_CODES,
  LAW_CODES,
  PILE_REACH_M,
  SIEGE_EVENT_DEFAULTS,
  STOCKADE,
  kegSpot,
  wallOpen,
  type HunterView,
  type JailView,
  type ServerMessage,
  type WallStage,
  type WallsExport,
  type WantedView,
} from '@sro/shared'
import { gameAudio } from '../../audio/index.ts'
import {
  FenceWindow,
  HunterPanel,
  JailPanel,
  PlantPrompt,
  WantedPanel,
  WardenWindow,
  YunWindow,
  captureText,
  hunterLabel,
  lawColumn,
  lawNoticeText,
  wantedLabel,
  type FenceTerms,
  type YunTerms,
} from '../../hud/law-hud.ts'
import { registerNpcService, type NpcTalkContext } from '../../hud/npc-dialog.ts'
import { inWorld } from '../../hud/unique-notice.ts'
import { t } from '../../i18n/index.ts'
import { StockadeView } from '../siege/stockade.ts'
import type { HudMarker, HudMinimap } from '../jangan/minimap.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'

/** HUD refresh (s). */
const HUD_EVERY_S = 0.25
/** Player kegs this close show on the minimap (m). */
const KEG_MAP_M = 300
/** A ping's circle stays on the minimap this long (ms). */
const PING_MS = 60_000
/** The stockade's props load within this range of it (m). */
const STOCKADE_LOAD_M = 400
const BELL_FILE = 'env/bell_towel_3'

/** What the client shows of the terms (the server's numbers are the defaults unless an admin changed them). */
const TERMS: FenceTerms = { ...SIEGE_EVENT_DEFAULTS.keg }
const HUNTER = SIEGE_EVENT_DEFAULTS.hunter
const YUN_TERMS: YunTerms = { licenceGold: HUNTER.licenceGold, minLevel: HUNTER.minLevel, cleanDays: HUNTER.cleanDays, offDutyLockMin: HUNTER.offDutyLockMin, bountyBase: SIEGE_EVENT_DEFAULTS.law.bountyBase }

export function lawFeature(ctx: WorldFeatureContext): WorldFeature {
  if (!ctx.session) return {}
  const { app } = ctx
  let wanted: WantedView | null = null
  /** Client ms the lawState arrived (the lapse and jail clocks count down from it while in the world). */
  let wantedAt = 0
  let offences = 0
  let hunter: HunterView | null = null
  let jail: JailView | null = null
  let jailAt = 0
  let walls: Pick<WallsExport, 'segments' | 'sides'> | null = null
  let wallsLoading = false
  const stages = new Map<string, WallStage>()
  const kegs = new Map<number, { x: number; z: number; seg: string }>()
  const pings = new Map<number, { x: number; z: number; r: number; name: string; at: number }>()
  let siegeOn = false
  /** The own keg's plant cast is running (the prompt steps aside). */
  let planting = false
  let hudT = 0
  let minimap: HudMinimap | null = null
  let offMarkers: (() => void) | null = null
  let talk: NpcTalkContext | null = null
  let fence: FenceWindow | null = null
  let yun: YunWindow | null = null
  let warden: WardenWindow | null = null
  let stockade: StockadeView | null = null
  const offs: (() => void)[] = []

  const panel = new WantedPanel()
  const hunterPanel = new HunterPanel(app.art)
  const jailPanel = new JailPanel(app.art)
  const column = lawColumn(panel.root, hunterPanel.root, jailPanel.root)
  const prompt = new PlantPrompt(app.art, () => plantNow())
  ctx.hud.layer.append(column, prompt.root)
  ctx.hud.claimRequests(['kegCraft', 'hunterLicence', 'hunterDuty', 'hunterNet', 'jailChore'])

  const self = () => {
    const id = ctx.selfId()
    return id === null ? undefined : ctx.view(id)
  }
  const bagSlot = (code: string) => ctx.hud.inventory.bag.findIndex((i) => i?.code === code)
  const have = () => {
    const tot = ctx.hud.inventory.totals()
    return { gold: ctx.hud.inventory.gold, saltpeter: tot.get(LAW_CODES.saltpeter) ?? 0, kegs: tot.get(LAW_CODES.keg) ?? 0 }
  }
  const nets = () => ctx.hud.inventory.totals().get(HUNTER_CODES.net) ?? 0
  const jailLeft = () => (jail ? jail.leftMs - (performance.now() - jailAt) : 0)

  // ---- the walls' plan (for the plant prompt) ---------------------------------------------------------------------
  const loadWalls = () => {
    const g = ctx.world()
    if (walls || wallsLoading || !g) return
    wallsLoading = true
    g.world.assets
      .json<WallsExport>('siege/walls.json')
      .then((w) => {
        walls = w
      })
      .catch(() => {
        // a world without destructible walls: no prompt
      })
  }

  /** The segment a keg planted here would go to (null: none, or no keg in the bag). */
  const plantSeg = (): string | null => {
    const me = self()
    if (!walls || !me || me.dead || bagSlot(LAW_CODES.keg) < 0 || jail || hunter?.onDuty) return null
    const spot = kegSpot(walls, me.pos.x, me.pos.z, SIEGE_EVENT_DEFAULTS.keg.faceM)
    if (!spot.ok) return null
    const st = stages.get(spot.seg.id)
    if (st && wallOpen(st)) return null
    // a keg already burning right here: the Defuse prompt has the spot
    for (const k of kegs.values()) if (Math.hypot(k.x - me.pos.x, k.z - me.pos.z) < 3) return null
    return spot.seg.id
  }

  const plantNow = () => {
    const slot = bagSlot(LAW_CODES.keg)
    if (slot >= 0) ctx.send({ t: 'itemUse', bag: slot })
  }

  // ---- NPC windows: Old Fang, Captain Yun, Warden Bae -------------------------------------------------------------
  const backToDialog = (w: { close(): void }) => {
    w.close()
    talk?.dialog.showServices()
  }
  const fenceWindow = (): FenceWindow => {
    if (fence) return fence
    const w = new FenceWindow(app.art, ctx.hud.layer)
    w.onCraft = () => {
      if (talk) ctx.send({ t: 'kegCraft', npc: talk.npc })
    }
    w.onBack = () => backToDialog(w)
    fence = w
    return w
  }
  const yunWindow = (): YunWindow => {
    if (yun) return yun
    const w = new YunWindow(app.art, ctx.hud.layer)
    w.onBuy = () => {
      if (talk) ctx.send({ t: 'hunterLicence', npc: talk.npc })
    }
    w.onDuty = (on) => ctx.send({ t: 'hunterDuty', on })
    w.onBack = () => backToDialog(w)
    yun = w
    return w
  }
  const inside = () => [...ctx.views()].filter((v) => v.kind === 'player' && v.state.jailed).map((v) => v.displayName())
  const wardenWindow = (): WardenWindow => {
    if (warden) return warden
    const w = new WardenWindow(app.art, ctx.hud.layer)
    w.onBack = () => backToDialog(w)
    warden = w
    return w
  }
  offs.push(
    registerNpcService(
      'fence',
      (c) => {
        talk = c
        fenceWindow().show(TERMS, have())
      },
      'npc.option.fence',
    ),
    registerNpcService(
      'hunter',
      (c) => {
        talk = c
        yunWindow().show(YUN_TERMS, hunter, ctx.hud.inventory.gold, ctx.serverNow())
      },
      'npc.option.hunter',
    ),
    registerNpcService(
      'warden',
      (c) => {
        talk = c
        wardenWindow().show(jail, jailLeft(), inside())
      },
      'npc.option.warden',
    ),
  )

  // ---- the labels: WANTED, HUNTER, PRISONER ------------------------------------------------------------------------
  offs.push(
    ctx.addAttachment((v) => {
      if (v.kind !== 'player') return null
      let shown = ''
      const apply = () => {
        const b = v.state.wanted ?? 0
        const h = v.state.hunter
        const j = v.state.jailed === true
        const key = `${b}|${h ?? ''}|${j}`
        if (key === shown) return
        shown = key
        v.setLabelLine('wanted', b > 0 ? wantedLabel(b) : null)
        v.setLabelLine('hunter', h !== undefined ? hunterLabel(h) : null)
        v.setLabelLine('jailed', j ? t('jail.label') : null)
      }
      return {
        loaded: apply,
        update: apply,
        dispose() {},
      }
    }),
  )

  // ---- banners -----------------------------------------------------------------------------------------------------
  const bell = () => {
    const a = gameAudio()
    if (a?.index?.files?.[BELL_FILE]) a.playFile(BELL_FILE, { gain: 0.9, bus: 'ambient', kind: 'other', self: true, priority: 1 })
  }
  const notice = (m: Extract<ServerMessage, { t: 'lawNotice' }>) => {
    app.notices.show(lawNoticeText(m), {
      kind: 'unique',
      title: t('law.title'),
      ...(m.name ? { name: m.name } : {}),
      live: inWorld,
      ms: m.event === 'wanted' ? 9000 : 6000,
      onShow: m.event === 'wanted' ? bell : undefined,
    })
  }
  const captured = (m: Extract<ServerMessage, { t: 'lawCapture' }>) => {
    app.notices.show(captureText(m), { kind: 'unique', title: t('law.capture.title'), name: m.name, live: inWorld, ms: 8000, onShow: m.prisoner ? undefined : bell })
  }

  // ---- PvP: who the rule lets us attack (the server judges) --------------------------------------------------------
  const canFight = (v: { kind: string; state: { wanted?: number; hunter?: number; jailed?: true } }): boolean => {
    if (v.kind !== 'player' || v.state.jailed || jail) return false
    if (hunter?.onDuty && (v.state.wanted ?? 0) > 0) return true
    return wanted !== null && v.state.hunter !== undefined
  }

  // ---- the minimap -------------------------------------------------------------------------------------------------
  function* markers(): Iterable<HudMarker> {
    const me = self()
    if (!me) return
    const blink = Math.floor(performance.now() / 350) % 2 === 0
    if (!siegeOn && kegs.size && blink) {
      for (const k of kegs.values()) if (Math.hypot(k.x - me.pos.x, k.z - me.pos.z) <= KEG_MAP_M) yield { x: k.x, z: k.z, color: '#ff3a2a', size: 3.5 }
    }
    if (!hunter?.onDuty) return
    const now = performance.now()
    for (const [id, p] of pings) {
      if (now - p.at > PING_MS) {
        pings.delete(id)
        continue
      }
      yield { x: p.x, z: p.z, color: 'rgba(90, 160, 255, 0.85)', radius: p.r }
    }
    for (const v of ctx.views()) {
      if (v.kind !== 'player' || v === me || !(v.state.wanted ?? 0)) continue
      if (Math.hypot(v.pos.x - me.pos.x, v.pos.z - me.pos.z) <= HUNTER.senseM) yield { x: v.pos.x, z: v.pos.z, color: '#ff3a2a', size: 4 }
    }
  }
  offs.push(() => offMarkers?.())

  // ---- the panels ----------------------------------------------------------------------------------------------------
  hunterPanel.onDuty = (on) => ctx.send({ t: 'hunterDuty', on })
  hunterPanel.onNet = () => {
    const v = ctx.target()
    if (v && v.kind === 'player' && (v.state.wanted ?? 0) > 0) ctx.send({ t: 'hunterNet', target: v.id })
  }
  jailPanel.onChore = () => ctx.send({ t: 'jailChore' })

  const refresh = () => {
    const now = ctx.serverNow()
    panel.set(wanted, wanted ? wanted.lapseMs - (performance.now() - wantedAt) : 0)
    prompt.set(planting ? null : plantSeg())
    const me = self()
    // the Wanted we know of: in view, or pinged in the last minute
    for (const [id, p] of pings) if (performance.now() - p.at > PING_MS) pings.delete(id)
    const known = new Set(pings.keys())
    for (const v of ctx.views()) if (v.kind === 'player' && (v.state.wanted ?? 0) > 0 && v !== me) known.add(v.id)
    const wantedOnline = known.size
    const tgt = ctx.target()
    const inReach = !!me && !!tgt && tgt.kind === 'player' && (tgt.state.wanted ?? 0) > 0 && Math.hypot(tgt.pos.x - me.pos.x, tgt.pos.z - me.pos.z) <= HUNTER.netRangeM
    hunterPanel.set(hunter, now, wantedOnline, { can: inReach, waitMs: hunter?.netAt ? Math.max(0, hunter.netAt - now) : 0, have: nets() })
    const chore = jail?.choreEndsAt ? 1 - (jail.choreEndsAt - now) / (SIEGE_EVENT_DEFAULTS.law.choreSec * 1000) : null
    const atPile = !!me && Math.hypot(me.pos.x - STOCKADE.pile.x, me.pos.z - STOCKADE.pile.z) <= PILE_REACH_M
    jailPanel.set(jail, jailLeft(), SIEGE_EVENT_DEFAULTS.law.choreMin, chore, atPile)
    if (warden?.isOpen) warden.update(jail, jailLeft(), inside())
  }

  // ---- the stockade's look ---------------------------------------------------------------------------------------------
  const loadStockade = () => {
    const g = ctx.world()
    const me = self()
    if (stockade || !g || !me || Math.hypot(me.pos.x - STOCKADE.gate.x, me.pos.z - STOCKADE.gate.z) > STOCKADE_LOAD_M) return
    stockade = new StockadeView(ctx.scene, g.world, (x, z) => g.heightAt(x, z))
    stockade.load().catch((err) => console.warn('[law] the stockade failed to load', err))
  }

  // ---- debug ---------------------------------------------------------------------------------------------------------
  const debug = {
    state: () => ({ wanted, offences, hunter, jail, jailLeft: jailLeft(), pings: [...pings], kegs: [...kegs], siegeOn, walls: !!walls, stockade: stockade?.loaded ?? false }),
    spot: () => plantSeg(),
    fence: () => fenceWindow().show(TERMS, have()),
    yun: () => yunWindow().show(YUN_TERMS, hunter, ctx.hud.inventory.gold, ctx.serverNow()),
    warden: () => wardenWindow().show(jail, jailLeft(), inside()),
    /** Talks to an NPC in view by code (default Old Fang): the server walks there and opens the dialog. */
    talk: (code: string = LAW_CODES.fence) => {
      for (const v of ctx.views()) if (v.kind === 'npc' && (v.state.npc ?? v.state.model) === code) return ctx.send({ t: 'npcTalk', npc: v.id })
      return false
    },
    notice: (m: Extract<ServerMessage, { t: 'lawNotice' }>) => notice(m),
    /** Selects player `id` and attacks it, as a click would (the server's PvP rule decides). */
    hunt: (id: number) => {
      const v = ctx.view(id)
      if (!v) return false
      ctx.setTarget(v)
      return ctx.send({ t: 'attack', target: id })
    },
    /** Players in view: id, name, the law's state. */
    players: () => [...ctx.views()].filter((v) => v.kind === 'player').map((v) => ({ id: v.id, name: v.displayName(), wanted: v.state.wanted, hunter: v.state.hunter, jailed: v.state.jailed, x: v.pos.x, z: v.pos.z })),
    capture: (m: Extract<ServerMessage, { t: 'lawCapture' }>) => captured(m),
    /** A GM command (the server checks the role): `gm('law', 'status')`. */
    gm: (cmd: string, ...args: string[]) => ctx.send({ t: 'gm', cmd, args }),
  }
  if (typeof window !== 'undefined') (window as unknown as { __sroLaw?: unknown }).__sroLaw = debug
  offs.push(() => {
    const w = typeof window !== 'undefined' ? (window as unknown as { __sroLaw?: unknown }) : null
    if (w && w.__sroLaw === debug) delete w.__sroLaw
  })

  return {
    onMessage(msg) {
      switch (msg.t) {
        case 'lawNotice':
          notice(msg)
          break
        case 'lawCapture':
          captured(msg)
          break
        case 'wantedPing':
          pings.set(msg.id, { x: msg.x, z: msg.z, r: msg.r, name: msg.name, at: performance.now() })
          break
        case 'lawState':
          wanted = msg.wanted ?? null
          wantedAt = performance.now()
          offences = msg.offences
          hunter = msg.hunter ?? null
          jail = msg.jail ?? null
          jailAt = performance.now()
          if (yun?.isOpen) yun.update(YUN_TERMS, hunter, ctx.hud.inventory.gold, ctx.serverNow())
          refresh()
          break
        case 'entityUpdate': {
          const v = ctx.view(msg.id)
          if (!v) break
          if (msg.wanted !== undefined) {
            if (msg.wanted > 0) v.state.wanted = msg.wanted
            else delete v.state.wanted
          }
          if (msg.hunter !== undefined) {
            if (msg.hunter >= 0) v.state.hunter = msg.hunter
            else delete v.state.hunter
          }
          if (msg.jailed !== undefined) {
            if (msg.jailed) v.state.jailed = true
            else delete v.state.jailed
          }
          break
        }
        case 'keg':
          if (!msg.sapper) kegs.set(msg.id, { x: msg.x, z: msg.z, seg: msg.seg })
          break
        case 'kegEnd':
          kegs.delete(msg.id)
          break
        case 'walls':
          stages.clear()
          for (const s of msg.segs) stages.set(s.id, s.stage)
          break
        case 'wallUpdate':
          stages.set(msg.id, msg.stage)
          break
        case 'itemCast':
          if (msg.id === ctx.selfId() && msg.item === LAW_CODES.keg) planting = true
          break
        case 'itemCastEnd':
          if (msg.id === ctx.selfId() && msg.item === LAW_CODES.keg) planting = false
          break
        case 'siegeEvent':
          siegeOn = msg.view.phase !== 'ended'
          break
        case 'inventory':
        case 'inventoryUpdate':
          if (fence?.isOpen) fence.update(TERMS, have())
          if (yun?.isOpen) yun.update(YUN_TERMS, hunter, ctx.hud.inventory.gold, ctx.serverNow())
          break
        case 'npcDialogClose':
          if (talk && msg.npc === talk.npc) {
            fence?.close()
            yun?.close()
            warden?.close()
            talk = null
          }
          break
        case 'worldLeft':
          wanted = null
          hunter = null
          jail = null
          kegs.clear()
          pings.clear()
          siegeOn = false
          break
      }
    },

    clickEntity(v) {
      // the Hunter / Wanted fight: select and attack (the server's rule decides)
      if (v.kind !== 'player' || v.id === ctx.selfId() || !canFight(v)) return false
      ctx.setTarget(v)
      ctx.send({ t: 'attack', target: v.id })
      return true
    },

    escape() {
      for (const w of [fence, yun, warden]) {
        if (w?.isOpen) {
          w.close()
          return true
        }
      }
      return false
    },

    onFrame(_now, dt) {
      loadWalls()
      loadStockade()
      const m = ctx.minimap()
      if (m && m !== minimap) {
        offMarkers?.()
        minimap = m
        offMarkers = m.addMarkerSource(markers)
      }
      hudT -= dt
      if (hudT > 0) return
      hudT = HUD_EVERY_S
      refresh()
    },

    dispose() {
      for (const off of offs.splice(0)) {
        try {
          off()
        } catch (err) {
          console.warn('[law] dispose step failed', err)
        }
      }
      column.remove()
      prompt.root.remove()
      fence?.dispose()
      fence = null
      yun?.dispose()
      yun = null
      warden?.dispose()
      warden = null
      stockade?.dispose()
      stockade = null
    },
  }
}
