/**
 * Siege of Jangan, layer 5 on the client (docs/SIEGE.md §7, §8.1, §9.3, §9.5): player kegs and Wanted.
 *
 * - **The WANTED label**: a red line "WANTED · 40,000" over every Wanted player (EntityState.wanted on spawn,
 *   `entityUpdate.wanted` when it changes; 0 removes it), for everyone.
 * - **Banners** (`lawNotice`) on the one NoticeBanner queue: someone planting a Thunder Keg (no name), the breach that
 *   names the breaker and the bounty (the temple bell tolls), a keg defused, a warrant that lapsed, was pardoned or
 *   ended in a capture. The server's `[Law]` chat lines tell the same.
 * - **Your warrant** (`lawState`): the Wanted panel on the left under the character frame: the bounty, the online time
 *   left before it lapses (counting down while you play), the offence, treason.
 * - **Old Fang the Fence**: his `fence` NPC service opens his window (the price, what you carry, the rules); Pack a keg
 *   sends `kegCraft`.
 * - **Planting**: with a Thunder Keg in the bag and standing at the outer foot of a wall segment (the export's
 *   `siege/walls.json`, the shared `kegSpot`), a prompt over the hotbar offers "Plant the keg" (the bag's `itemUse`; the
 *   server judges and draws the cast bar). Using the keg from the bag anywhere else gets the server's refusal.
 * - The keg itself, its fuse, the Defuse prompt and the blast are the siege feature's (it draws every `keg`). Outside a
 *   siege this feature puts burning player kegs within 300 m on the minimap (blinking red).
 * - Debug: `window.__sroLaw` (state, the plant spot, open Old Fang's window, show a notice).
 */
import { LAW_CODES, SIEGE_EVENT_DEFAULTS, kegSpot, wallOpen, type ServerMessage, type WallStage, type WallsExport, type WantedView } from '@sro/shared'
import { gameAudio } from '../../audio/index.ts'
import { FenceWindow, PlantPrompt, WantedPanel, lawNoticeText, wantedLabel, type FenceTerms } from '../../hud/law-hud.ts'
import { registerNpcService, type NpcTalkContext } from '../../hud/npc-dialog.ts'
import { inWorld } from '../../hud/unique-notice.ts'
import { t } from '../../i18n/index.ts'
import type { HudMarker, HudMinimap } from '../jangan/minimap.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'

/** HUD refresh (s). */
const HUD_EVERY_S = 0.25
/** Player kegs this close show on the minimap (m). */
const KEG_MAP_M = 300
const BELL_FILE = 'env/bell_towel_3'

/** What the client shows of Old Fang's terms (the server's numbers are the defaults unless an admin changed them). */
const TERMS: FenceTerms = { ...SIEGE_EVENT_DEFAULTS.keg }

export function lawFeature(ctx: WorldFeatureContext): WorldFeature {
  if (!ctx.session) return {}
  const { app } = ctx
  let wanted: WantedView | null = null
  /** Client ms the lawState arrived (the lapse clock counts down from it while in the world). */
  let wantedAt = 0
  let offences = 0
  let walls: Pick<WallsExport, 'segments' | 'sides'> | null = null
  let wallsLoading = false
  const stages = new Map<string, WallStage>()
  const kegs = new Map<number, { x: number; z: number; seg: string }>()
  let siegeOn = false
  /** The own keg's plant cast is running (the prompt steps aside). */
  let planting = false
  let hudT = 0
  let minimap: HudMinimap | null = null
  let offMarkers: (() => void) | null = null
  let talk: NpcTalkContext | null = null
  let fence: FenceWindow | null = null
  const offs: (() => void)[] = []

  const panel = new WantedPanel()
  const prompt = new PlantPrompt(app.art, () => plantNow())
  ctx.hud.layer.append(panel.root, prompt.root)
  ctx.hud.claimRequests(['kegCraft'])

  const self = () => {
    const id = ctx.selfId()
    return id === null ? undefined : ctx.view(id)
  }
  const bagSlot = (code: string) => ctx.hud.inventory.bag.findIndex((i) => i?.code === code)
  const have = () => {
    const tot = ctx.hud.inventory.totals()
    return { gold: ctx.hud.inventory.gold, saltpeter: tot.get(LAW_CODES.saltpeter) ?? 0, kegs: tot.get(LAW_CODES.keg) ?? 0 }
  }

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
    if (!walls || !me || me.dead || bagSlot(LAW_CODES.keg) < 0) return null
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

  // ---- Old Fang --------------------------------------------------------------------------------------------------
  const fenceWindow = (): FenceWindow => {
    if (fence) return fence
    const w = new FenceWindow(app.art, ctx.hud.layer)
    w.onCraft = () => {
      if (talk) ctx.send({ t: 'kegCraft', npc: talk.npc })
    }
    w.onBack = () => {
      w.close()
      talk?.dialog.showServices()
    }
    fence = w
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
  )

  // ---- the WANTED label ------------------------------------------------------------------------------------------
  offs.push(
    ctx.addAttachment((v) => {
      if (v.kind !== 'player') return null
      let shown = -1
      const apply = () => {
        const b = v.state.wanted ?? 0
        if (b === shown) return
        shown = b
        v.setLabelLine('wanted', b > 0 ? wantedLabel(b) : null)
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

  // ---- the minimap -------------------------------------------------------------------------------------------------
  function* markers(): Iterable<HudMarker> {
    if (siegeOn || !kegs.size) return
    const me = self()
    if (!me) return
    if (Math.floor(performance.now() / 350) % 2 !== 0) return
    for (const k of kegs.values()) if (Math.hypot(k.x - me.pos.x, k.z - me.pos.z) <= KEG_MAP_M) yield { x: k.x, z: k.z, color: '#ff3a2a', size: 3.5 }
  }
  offs.push(() => offMarkers?.())

  const refresh = () => {
    panel.set(wanted, wanted ? wanted.lapseMs - (performance.now() - wantedAt) : 0)
    prompt.set(planting ? null : plantSeg())
  }

  // ---- debug ---------------------------------------------------------------------------------------------------------
  const debug = {
    state: () => ({ wanted, offences, kegs: [...kegs], siegeOn, walls: !!walls }),
    spot: () => plantSeg(),
    fence: () => fenceWindow().show(TERMS, have()),
    /** Talks to Old Fang when his entity is in view (the server walks there and opens his dialog). */
    talk: () => {
      for (const v of ctx.views()) if (v.kind === 'npc' && (v.state.npc ?? v.state.model) === LAW_CODES.fence) return ctx.send({ t: 'npcTalk', npc: v.id })
      return false
    },
    notice: (m: Extract<ServerMessage, { t: 'lawNotice' }>) => notice(m),
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
        case 'lawState':
          wanted = msg.wanted ?? null
          wantedAt = performance.now()
          offences = msg.offences
          refresh()
          break
        case 'entityUpdate': {
          if (msg.wanted === undefined) break
          const v = ctx.view(msg.id)
          if (!v) break
          if (msg.wanted > 0) v.state.wanted = msg.wanted
          else delete v.state.wanted
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
          break
        case 'npcDialogClose':
          if (talk && msg.npc === talk.npc) {
            fence?.close()
            talk = null
          }
          break
        case 'worldLeft':
          wanted = null
          kegs.clear()
          siegeOn = false
          break
      }
    },

    escape() {
      if (fence?.isOpen) {
        fence.close()
        return true
      }
      return false
    },

    onFrame(_now, dt) {
      loadWalls()
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
      panel.root.remove()
      prompt.root.remove()
      fence?.dispose()
      fence = null
    },
  }
}
