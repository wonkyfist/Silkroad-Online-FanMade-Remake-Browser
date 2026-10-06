/**
 * Siege of Jangan, layer 3 on the client (docs/SIEGE.md §2.4, §9.5): wall repair.
 *
 * - **Master Mason Ko**: his `mason` NPC service (registerNpcService, M7) opens the donation window (hud/mason.ts) beside
 *   his dialog; Donate sends `wallDonate` (the server takes only what the queue can use and answers with a chat line);
 *   Back returns to his dialog. His shop (Mason's Kit, Stone Block) is the ordinary shop service.
 * - **The numbers** come with `walls` (`repair`, WallRepairTerms); each segment's stage, integrity, queued work and
 *   `repairing` with `walls` / `wallUpdate`. The kit's price at the shop follows the server's number.
 * - **The Mason's Kit** needs nothing here: using it from the bag is an ordinary `itemUse`; the server answers with the
 *   item cast bar (`itemCast` / `itemCastEnd`). `wallDonate` / `wallRepair` refusals are toasted by the HUD.
 * - The scaffolding and hammer sounds of a segment being repaired belong to the walls' looks (layer 2, which reads
 *   `repairing`). Debug: `window.__sroMason` (open the window, select, set amounts).
 */
import { SIEGE_CODES, type WallRepairTerms, type WallStage } from '@sro/shared'
import { MasonWindow, type MasonSeg } from '../../hud/mason.ts'
import { registerNpcService, type NpcTalkContext } from '../../hud/npc-dialog.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'

export function siegeRepairFeature(ctx: WorldFeatureContext): WorldFeature {
  if (!ctx.session) return {}
  const segs = new Map<string, MasonSeg>()
  let terms: WallRepairTerms | null = null
  let talk: NpcTalkContext | null = null
  let win: MasonWindow | null = null

  const have = () => ({ gold: ctx.hud.inventory.gold, blocks: ctx.hud.inventory.totals().get(SIEGE_CODES.block) ?? 0 })
  const list = () => [...segs.values()]

  const window = (): MasonWindow => {
    if (win) return win
    const w = new MasonWindow(ctx.app.art, ctx.hud.layer)
    w.onDonate = (seg, gold, blocks) => {
      if (!talk) return
      const msg: { t: 'wallDonate'; npc: number; seg?: string; gold?: number; blocks?: number } = { t: 'wallDonate', npc: talk.npc }
      if (seg) msg.seg = seg
      if (gold > 0) msg.gold = gold
      if (blocks > 0) msg.blocks = blocks
      if (ctx.send(msg)) w.resetAmounts()
    }
    w.onBack = () => {
      w.close()
      talk?.dialog.showServices()
    }
    win = w
    return w
  }

  const open = (t: NpcTalkContext) => {
    talk = t
    window().show(terms, list(), have())
  }

  const redraw = () => {
    if (win?.isOpen) win.update(terms, list(), have())
  }

  /** The kit's shop price follows the server's number (shop window and tooltips read the catalog). */
  const priceKit = (price: number) => {
    const def = ctx.app.catalog.content.items.get(SIEGE_CODES.kit)
    if (!def || def.price === price) return
    def.price = price
    def.sellPrice = Math.floor(price / 4)
  }

  const setSeg = (id: string, stage: WallStage, pct: number, queued: number | undefined, repairing: boolean | undefined) => {
    segs.set(id, { id, stage, pct, queued: queued ?? 0, repairing: !!repairing })
  }

  ctx.hud.claimRequests(['wallDonate', 'wallRepair'])
  const offs = [registerNpcService('mason', open, 'npc.option.mason')]

  if (typeof globalThis.window !== 'undefined') {
    ;(globalThis.window as unknown as { __sroMason?: unknown }).__sroMason = {
      get terms() {
        return terms
      },
      get segs() {
        return list()
      },
      /** Opens the window without Ko (a preview; Donate needs his dialog). */
      open: () => window().show(terms, list(), have()),
      /** Talks to Master Mason Ko when his entity is in view (the server walks there and opens his dialog). */
      talk: () => {
        for (const v of ctx.views()) if (v.kind === 'npc' && (v.state.npc ?? v.state.model) === SIEGE_CODES.mason) return ctx.send({ t: 'npcTalk', npc: v.id })
        return false
      },
      select: (id: string | null) => win?.select(id),
      amounts: (gold: number, blocks: number) => win?.setAmounts(gold, blocks),
    }
  }

  return {
    onMessage(msg) {
      if (msg.t === 'walls') {
        segs.clear()
        for (const s of msg.segs) setSeg(s.id, s.stage, s.pct, s.queued, s.repairing)
        if (msg.repair) {
          terms = msg.repair
          priceKit(msg.repair.kitPrice)
        }
        redraw()
      } else if (msg.t === 'wallUpdate') {
        setSeg(msg.id, msg.stage, msg.pct, msg.queued, msg.repairing)
        redraw()
      } else if (msg.t === 'inventory' || msg.t === 'inventoryUpdate') redraw()
      else if (msg.t === 'npcDialogClose' && talk && msg.npc === talk.npc) {
        win?.close()
        talk = null
      }
    },
    escape() {
      if (win?.isOpen) {
        win.close()
        return true
      }
      return false
    },
    dispose() {
      for (const off of offs.splice(0)) off()
      win?.dispose()
      win = null
      if (typeof globalThis.window !== 'undefined') delete (globalThis.window as unknown as { __sroMason?: unknown }).__sroMason
    },
  }
}
