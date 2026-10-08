/**
 * Rare weapons in the world (docs/RARITY.md §4.3, §5.5): a seal weapon's crits and kills (world/rarity/fx.ts), the server-wide `rareNotice` (a banner in the seal's colour
 * on the notice queue, and a line in the chat's notice channel) and the seal's chime where a fresh rare drop lands
 * (over the retail rare-drop sound the sound feature plays). The looks themselves live with the models
 * (three/weapon-rarity.ts), the drops (world/rarity-beam.ts) and the HUD (tooltip, slot frame).
 */
import { Vector3 } from '@babylonjs/core'
import { RARITY, rarityOf, type RarityTier, type ServerMessage } from '@sro/shared'
import { gameAudio } from '../../audio/index.ts'
import { t } from '../../i18n/index.ts'
import { isFreshDrop } from '../drops.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { CHIME_IDS, RARITY_SYNTH } from '../rarity/chimes.ts'
import { rarityFxOf } from '../rarity/fx.ts'

/** A rare notice's time on screen (ms). */
export const RARE_NOTICE_MS = 7000

type RareNotice = Extract<ServerMessage, { t: 'rareNotice' }>

/** The banner's sentence (and the name to colour in it). */
export function rareNoticeText(msg: RareNotice, itemName: (code: string) => string | undefined = () => undefined): { text: string; name: string } {
  const name = itemName(msg.item) ?? msg.name
  return { text: t('rarity.notice.text', { by: msg.by, seal: RARITY[msg.tier].name, name }), name }
}

export function rarityFeature(ctx: WorldFeatureContext): WorldFeature {
  const audio = gameAudio()
  if (audio) for (const [id, make] of Object.entries(RARITY_SYNTH)) audio.prepareSynth(id, make)
  const itemName = (code: string): string | undefined => ctx.hud.items.def(code)?.name ?? undefined
  const chime = (tier: RarityTier, pos?: { x: number; y: number; z: number }) =>
    gameAudio()?.playFile(CHIME_IDS[tier], pos ? { pos, priority: 1 } : { self: true, waitMs: 1500 })
  const at = new Vector3()
  return {
    // A seal weapon's crit and kill (docs/RARITY.md §5.5): shooting stars, a crescent shockwave, a solar flare.
    onCombatHit(msg, index): void {
      const hit = msg.hits[index]
      if (!hit || (hit.outcome !== 'crit' && hit.outcome !== 'hit')) return
      const attacker = ctx.view(msg.attacker)
      const actor = attacker?.actor
      if (!actor?.weaponRarity) return
      const fx = rarityFxOf(ctx.scene)
      // a rare spear's thrust fires its lance on the hit (basic attacks and skills alike)
      if (index === 0 && fx?.kindOf(actor) === 'spear') fx.thrust(actor)
      if (hit.outcome !== 'crit' && hit.hp > 0) return
      const target = ctx.view(msg.target)
      if (!target) return
      const r = target.root.position
      at.set(r.x, r.y + 1.1, r.z)
      fx?.impact(actor, at, hit.hp <= 0 ? 'kill' : 'crit', r.y)
    },
    onMessage(msg: ServerMessage): void {
      if (msg.t === 'rareNotice') {
        const { text, name } = rareNoticeText(msg, itemName)
        ctx.app.notices.show(text, { title: t('rarity.notice.title'), name, color: RARITY[msg.tier].color, ms: RARE_NOTICE_MS })
        ctx.chat.add('notice', t('rarity.chat', { seal: RARITY[msg.tier].name, by: msg.by, name }))
        return
      }
      if (msg.t === 'spawn' && msg.entity.kind === 'item') {
        const tier = rarityOf(msg.entity.model)
        if (!tier || !isFreshDrop(msg.entity.droppedAt, ctx.serverNow())) return
        const [x, y, z] = msg.entity.pos
        chime(tier, { x, y: y + 0.3, z })
      }
    },
  }
}
