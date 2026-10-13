/**
 * Arrows on the HUD (docs/SKILLS.md §1.4): while a bow is worn, the worn arrow stack (the shield slot) sits under the
 * durability strip as its icon and count; red at 0. The equipment window's shield slot shows the same count (kit Slot).
 */
import type { ServerMessage } from '@sro/shared'
import { hudAnchors, placeAt, watchLayout } from '../../hud/hud-layout.ts'
import { t } from '../../i18n/index.ts'
import { el } from '../../ui/dom.ts'
import type { WorldFeature, WorldFeatureContext, WorldFeatureFactory } from '../features.ts'

const CSS = `
.ar-hud { position: absolute; width: 32px; height: 32px; pointer-events: auto; z-index: 5; background: no-repeat center / 32px 32px rgba(20, 16, 10, 0.6); box-shadow: inset 0 0 0 1px #6b5a2b; }
.ar-hud-count { position: absolute; right: 1px; bottom: 0; font: bold 11px/1 sans-serif; color: #fff; text-shadow: 0 0 2px #000, 0 0 2px #000; }
.ar-hud.empty .ar-hud-count { color: #ff5a4a; }
`

/** What the HUD shows: null = no bow worn; else the worn arrow count (0 = none). */
export function arrowHud(weaponType: string | undefined, worn: { count: number; category?: string } | undefined): number | null {
  if (weaponType !== 'bow') return null
  return worn && worn.category === 'ammo' ? worn.count : 0
}

export const arrowsFeature: WorldFeatureFactory = ctx => {
  if (!ctx?.hud || !ctx.session) return {}
  return createArrowsFeature(ctx)
}

function createArrowsFeature(ctx: WorldFeatureContext): WorldFeature {
  const { hud } = ctx
  const items = hud.items
  const inv = hud.inventory
  const style = document.createElement('style')
  style.dataset.owner = 'ar-arrows'
  style.textContent = CSS
  document.head.append(style)
  const box = el('div', 'ar-hud')
  const count = el('div', 'ar-hud-count')
  box.append(count)
  box.hidden = true
  hud.layer.append(box)
  const offLayout = watchLayout(box, (W, H) => {
    const a = hudAnchors(W, H).durability
    placeAt(box, { x: a.x + a.w - 32, y: a.y + a.h + 4, w: 32, h: 32 }, true)
  })
  let dirty = true
  const render = () => {
    const w = inv.equip.weapon
    const s = inv.equip.shield
    const n = arrowHud(w ? items.def(w.code)?.weaponType : undefined, s ? { count: s.count, category: items.def(s.code)?.category } : undefined)
    box.hidden = n === null
    if (n === null) return
    const url = s && n > 0 ? items.icon(s.code) : items.icon('ITEM_ETC_AMMO_ARROW_01')
    box.style.backgroundImage = url ? `url("${url}")` : ''
    count.textContent = String(n)
    box.classList.toggle('empty', n === 0)
    box.title = t('hud.arrows.tip', { count: n })
  }
  return {
    onMessage(msg: ServerMessage) {
      if (msg.t === 'inventory' || msg.t === 'inventoryUpdate') dirty = true
    },
    onFrame() {
      if (!dirty || !inv.known) return
      dirty = false
      render()
    },
    dispose() {
      offLayout()
      box.remove()
      style.remove()
    },
  }
}
