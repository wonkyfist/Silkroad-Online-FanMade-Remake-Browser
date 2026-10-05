/**
 * World feature of the auto potion (world/auto-potion.ts; Options → Controls → Auto potion). It feeds the logic with
 * the HUD's stats, bag, item catalog and cooldown clock, tracks what blocks item use (death, an own stall, an open
 * trade) and the abnormal states on the own character from the server messages, and shows a small badge on the
 * player frame while the feature is on (a click opens Options → Controls).
 */
import type { EffectState, ServerMessage } from '@sro/shared'
import { cooldownNow, itemCooldownKey } from '../../hud/cooldowns.ts'
import { t } from '../../i18n/index.ts'
import { settings } from '../../settings.ts'
import { el } from '../../ui/dom.ts'
import { ABNORMAL_STATUSES, AutoPotion, type RunOut } from '../auto-potion.ts'
import type { WorldFeature, WorldFeatureContext, WorldFeatureFactory } from '../features.ts'

/** A refused `itemUse` this soon after an automatic one counts as ours (the HUD toasts it; we back off). */
const REFUSAL_WINDOW_MS = 2000
/** The potion drawn on the badge. */
const BADGE_ICON = 'ITEM_ETC_HP_POTION_01'

const NOTICES: Record<RunOut, 'autoPotion.noHp' | 'autoPotion.noMp' | 'autoPotion.noPill'> = {
  hp: 'autoPotion.noHp',
  mp: 'autoPotion.noMp',
  pill: 'autoPotion.noPill',
}

const CSS = `
.ap-badge {
  position: absolute; left: 188px; top: 54px; width: 18px; height: 18px; pointer-events: auto; cursor: pointer;
  background: rgba(0, 0, 0, 0.55) no-repeat center / 16px 16px; border: 1px solid #8a6d35; border-radius: 3px;
  box-shadow: 0 0 4px rgba(120, 220, 120, 0.55);
}
.ap-badge[hidden] { display: none; }
.ap-badge::after {
  content: ''; position: absolute; right: -2px; bottom: -2px; width: 6px; height: 6px; border-radius: 50%;
  background: #6fe36f; box-shadow: 0 0 3px #6fe36f;
}
.ap-badge.no-icon::before { content: 'A'; display: block; text-align: center; font: 11px/16px var(--font-title); color: #e8d9a8; }
`

let injected = false
function ensureStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.owner = 'auto-potion'
  style.textContent = CSS
  document.head.append(style)
}

export const autoPotionFeature: WorldFeatureFactory = ctx => {
  // A bare context (tests of the feature list) has no HUD to read.
  if (!ctx?.hud || !ctx.session) return {}
  return createAutoPotionFeature(ctx)
}

function createAutoPotionFeature(ctx: WorldFeatureContext): WorldFeature {
  const { hud } = ctx
  /** Own stall open (the server refuses the owner's item use: `stalling`). */
  let stallOwner = false
  /** An exchange window is open (`trading`). */
  let trading = false
  /** The abnormal states on the own character: effect instance -> cure level and end (local ms; Infinity = until removed). */
  const abnormal = new Map<number, { level: number; endsAt: number }>()

  const selfView = () => {
    const id = ctx.selfId()
    return id === null ? undefined : ctx.view(id)
  }
  const addEffect = (e: EffectState) => {
    if (!e.status || !ABNORMAL_STATUSES.has(e.status)) return
    abnormal.set(e.instance, { level: e.level ?? 0, endsAt: e.remainingMs > 0 ? cooldownNow() + e.remainingMs : Infinity })
  }

  const auto = new AutoPotion({
    settings: () => settings.get().autoPotion,
    vitals: () => hud.stats,
    bagSize: () => hud.inventory.bagSize,
    bag: i => hud.inventory.item(i),
    item: code => hud.items.def(code),
    blocked: () => {
      const v = selfView()
      return !v || v.dead || v.dying || stallOwner || trading
    },
    abnormal: () => {
      const now = cooldownNow()
      const out: number[] = []
      for (const [id, s] of abnormal) {
        if (s.endsAt <= now) abnormal.delete(id)
        else out.push(s.level)
      }
      return out
    },
    cooldownLeft: group => hud.cooldowns.remaining(itemCooldownKey(group), cooldownNow()),
    send: msg => ctx.send(msg),
    notice: kind => hud.toast(t(NOTICES[kind])),
  })

  // ---- the badge: on the player frame's bottom-right corner while the auto potion is on ----------------------------
  ensureStyles()
  const badge = el('button', 'ap-badge')
  badge.type = 'button'
  badge.title = t('autoPotion.badge')
  badge.setAttribute('aria-label', t('autoPotion.badge'))
  const icon = hud.items.icon(BADGE_ICON)
  if (icon) badge.style.backgroundImage = `url("${icon}")`
  else badge.classList.add('no-icon')
  badge.addEventListener('click', () => hud.openOptions('controls'))
  hud.playerFrame?.root.append(badge)
  const showBadge = () => {
    badge.hidden = !settings.get().autoPotion.enabled
  }
  showBadge()
  const offSettings = settings.onChange(showBadge)

  const onMessage = (msg: ServerMessage) => {
    const self = ctx.selfId()
    switch (msg.t) {
      case 'worldEnter':
        auto.reset()
        stallOwner = false
        trading = false
        abnormal.clear()
        for (const e of msg.self.effects ?? []) addEffect(e)
        break
      case 'effectAdd':
        if (msg.id === self) addEffect(msg.effect)
        break
      case 'effectRemove':
        if (msg.id === self) abnormal.delete(msg.instance)
        break
      case 'entityUpdate':
        if (msg.id === self && msg.state === 'dead') abnormal.clear()
        break
      case 'stall':
        stallOwner = !!msg.stall && msg.stall.owner === self
        break
      case 'trade':
        trading = true
        break
      case 'tradeEnd':
        trading = false
        break
      case 'actionResult': {
        const now = cooldownNow()
        if (msg.re === 'itemUse' && !msg.ok && auto.sentWithin(now, REFUSAL_WINDOW_MS)) auto.refused(now)
        break
      }
    }
  }

  return {
    onMessage,
    onFrame() {
      auto.tick(cooldownNow())
    },
    dispose() {
      offSettings()
      badge.remove()
    },
  }
}
