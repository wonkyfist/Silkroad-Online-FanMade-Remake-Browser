/**
 * World feature of lane SND-C, sound runtime (docs/SOUND.md §5; WAVE_PLAN §4.9). Everything the world screen
 * needs from sound goes through here, so world.ts itself carries no sound code:
 * - per-view clip sounds (footsteps, swings, shouts, moans, death cries) through an EntityAttachment;
 * - the listener at the own character with the camera's heading, the footstep surface world, voice priorities;
 * - hit impacts at each shown hit, level-up fanfare, gold drop and pickup, potion drinks, skill stage sounds;
 * - town/field ambience following the music's town check; the Esc menu's "Sound" entry (order 30).
 * - docs/SOUND.md §10: the imbue, Berserk and shield-buff layers of a hit, Berserk swings, rare/elixir drops, quest
 *   accepted/completed, revival, the Berserk orb, and a quick-slot icon placed.
 * Every sound degrades to silence when the index or a file is missing.
 */
import type { EffectState, EntityState, ServerMessage } from '@sro/shared'
import type { LifePart } from '@sro/world-render'
import type { GameAudio } from '../../audio/index.ts'
import { CarriedSkills } from '../../audio/carried.ts'
import { hwanSwingCue, skillGroupOf, type HitQuery } from '../../audio/cues.ts'
import type { EntitySound } from '../../audio/entity.ts'
import { registerMenuItem } from '../../hud/menu-items.ts'
import { closeSoundSettings, openSoundSettings, soundSettingsWindow } from '../../hud/sound-settings.ts'
import { KEEP_CLIPS } from '../../three/models.ts'
import type { EntityView } from '../entities.ts'
import type { WorldFeatureContext, WorldFeatureFactory } from '../features.ts'

/** Hit rows preloaded at world enter per weapon family (cues.ts WEAPON_HITS). */
const FAMILY_HITS: Record<string, string> = { sword: 'SWORD', blade: 'BLADE', spear: 'SPEAR', glaive: 'SPEAR', bow: 'BOW' }
/** Item cooldown groups of drinkable consumables (SHOPS §4: TypeID4 hp / mp / vigor; cure pills). */
const DRINK_GROUPS = /^(hp|mp|vigor|cure)$/
/** Without an itemCooldown (older server), an ok itemUse plays the drink unless a cast or warp follows this soon (ms). */
const DRINK_FALLBACK_MS = 250
/** A buff's effectAdd plays its stage sound unless the caster's cast already did, this recently (ms). */
const CAST_STAGE_MEMORY_MS = 1500

interface Pending {
  at: number
  fn: () => void
  entity?: number
}

export const soundFeature: WorldFeatureFactory = (ctx: WorldFeatureContext) => {
  // No sound runtime (a synthetic context in tests): no hooks.
  const audio: GameAudio | undefined = ctx.app?.audio
  if (!audio) return {}
  const sounds = new Map<number, EntitySound>()
  const pending: Pending[] = []
  /** Latest cast per entity (group, wall time) for the buff stage de-duplication. */
  const casts = new Map<number, { group: string; at: number; until: number }>()
  let drinkAt = 0
  /** A self itemCast or warp just happened: an ok itemUse then was a scroll, not a drink. */
  let quietUntil = 0
  // docs/SOUND.md §10.3: imbues and shield buffs per entity, who is in Berserk, who is dead, the own Berserk gauge.
  const carried = new CarriedSkills(code => ctx.app.catalog.content.skills.get(code)?.kind === 'imbue')
  const berserk = new Set<number>()
  const dead = new Set<number>()
  let hwanGauge: number | null = null
  const now = () => performance.now()
  const later = (ms: number, fn: () => void, entity?: number) => pending.push({ at: now() + ms, fn, entity })
  // Wave 10 (GL-O, GRASS_LIFE §5.3): a flock's flush plays one bird one-shot at the flock (audio/ambient.ts flush).
  let life: LifePart | null = null
  let offFlush: (() => void) | null = null
  const followLife = (next: LifePart | null): void => {
    if (next === life) return
    offFlush?.()
    offFlush = null
    life = next
    if (!next) return
    const o = next.onFlush.add(f => void audio.ambient.flush(f))
    offFlush = () => next.onFlush.remove(o)
  }

  const offAttach = ctx.addAttachment(view => {
    const s = audio.entity(view)
    if (!s) return null
    audio.preloadModel(view.state.model, KEEP_CLIPS)
    sounds.set(view.id, s)
    if (berserk.has(view.id)) hwanSwing(view, s, true)
    return {
      update: () => s.update(now()),
      dispose: () => {
        s.dispose()
        if (sounds.get(view.id) === s) sounds.delete(view.id)
      },
    }
  })

  const offMenu = registerMenuItem({
    id: 'sound',
    label: 'menu.sound',
    order: 30,
    run: menu => {
      menu.close()
      openSoundSettings(menu.app, ctx.hud.layer)
    },
  })

  const at = (v: EntityView) => ({
    entity: v.id,
    pos: { x: v.root.position.x, y: v.root.position.y + 1, z: v.root.position.z },
    self: v.id === ctx.selfId(),
    priority: audio.priorityOf(v.id, v.kind, v.id === ctx.selfId()),
  })

  const family = (v: EntityView) => (v.kind === 'player' ? v.look().family ?? null : null)

  /** Berserk swings on or off for a view's sound (the weapon's SND_SWING3 HWAN files). */
  function hwanSwing(v: EntityView, s: EntitySound | undefined, on: boolean): void {
    s?.setHwanSwing(on ? audio!.index?.cues[hwanSwingCue(family(v))]?.files ?? null : null)
  }

  const setBerserk = (id: number, on: boolean) => {
    if (on === berserk.has(id)) return
    if (on) berserk.add(id)
    else berserk.delete(id)
    const v = ctx.view(id)
    if (v) hwanSwing(v, sounds.get(id), on)
  }

  /** An entity's state as it arrives (worldEnter, spawn): its effects, Berserk and life. */
  const arrived = (e: EntityState) => {
    carried.set(e.id, e.effects)
    const imbue = carried.imbueOf(e.id)
    if (imbue) audio.preloadSkill(imbue)
    setBerserk(e.id, (e.berserkMs ?? 0) > 0)
    if (e.state === 'dead') dead.add(e.id)
    else dead.delete(e.id)
  }

  /** Skill stage sounds of a cast (skilleffect cols 26/27): READY now, WAIT after the prepare, the action stage after the cast. */
  const onCast = (msg: Extract<ServerMessage, { t: 'cast' }>) => {
    const v = ctx.view(msg.id)
    const group = skillGroupOf(msg.skill)
    if (!v || !group) return
    const total = msg.prepareMs + msg.castMs + msg.actionMs
    sounds.get(v.id)?.setSkill(group, total + 500)
    casts.set(v.id, { group, at: now(), until: now() + total + CAST_STAGE_MEMORY_MS })
    audio.skillStage(group, 'READY', at(v))
    if (msg.prepareMs > 0) later(msg.prepareMs, () => stage(msg.id, group, ['WAIT']), msg.id)
    later(msg.prepareMs + msg.castMs, () => stage(msg.id, group, ['ACT_S', 'ACT_L', 'SHOT']), msg.id)
  }

  const stage = (id: number, group: string, phases: readonly string[]) => {
    const v = ctx.view(id)
    if (!v || v.dead) return
    for (const p of phases) if (audio.skillStage(group, p, at(v))) return
  }

  /** A buff landing (effectAdd) sounds its action stage unless its own cast just did. */
  const onEffect = (id: number, effect: EffectState) => {
    const group = skillGroupOf(effect.skill)
    const v = ctx.view(id)
    if (!group || !v) return
    const caster = casts.get(effect.source ?? id)
    if (caster && caster.group === group && now() < caster.until) return
    stage(id, group, ['ACT_S', 'ACT_L'])
  }

  const drink = () => {
    drinkAt = 0
    audio.ui('ui.potion')
  }

  return {
    onMessage(msg: ServerMessage) {
      switch (msg.t) {
        case 'worldEnter': {
          const self = ctx.view(msg.self.id)
          const f = self ? family(self) : null
          audio.preloadWorld(['PUNCH', ...(f ? [FAMILY_HITS[f]!] : [])])
          carried.clear()
          berserk.clear()
          dead.clear()
          hwanGauge = null
          for (const e of [msg.self, ...msg.entities]) arrived(e)
          break
        }
        case 'despawn':
          carried.forget(msg.id)
          berserk.delete(msg.id)
          dead.delete(msg.id)
          break
        case 'effectRemove':
          carried.remove(msg.id, msg.instance)
          break
        case 'combat':
          if (msg.killed) dead.add(msg.target)
          break
        case 'entityUpdate': {
          if (msg.berserkMs !== undefined) setBerserk(msg.id, msg.berserkMs > 0)
          if (msg.state === 'dead') dead.add(msg.id)
          else if (msg.state === 'alive' && dead.delete(msg.id)) {
            // UI SND_REVIVE (itRevive, "재생소리"): back to life, yours in the interface, others' where they stand.
            const v = ctx.view(msg.id)
            if (msg.id === ctx.selfId() || !v) audio.ui('ui.revive')
            else audio.play('ui.revive', at(v))
          }
          break
        }
        case 'stats':
        case 'statsDelta': {
          // UI SND_HYAN (HyanGet, "환습득소리"): the Berserk gauge gained an orb.
          const h = msg.stats.hwan
          if (typeof h !== 'number') break
          if (hwanGauge !== null && h > hwanGauge) audio.ui('ui.hyan')
          hwanGauge = h
          break
        }
        case 'questUpdate':
          // UI SND_QUEST (QuestOpen, "퀘스트 창 열리기") when a quest is taken, SND_QUEST_END (ItQuest) when it is done.
          if (msg.event === 'accepted') audio.ui('ui.questOpen')
          else if (msg.event === 'completed') audio.ui('ui.questDone')
          break
        case 'skillsUpdate':
          // ITEM SND_EQUIP QUICKSLOT (itQuickicon): an icon placed on the quick bar.
          if (msg.hotbar?.some(h => h.entry)) audio.ui('item.equip.QUICKSLOT')
          break
        case 'levelUp': {
          const v = ctx.view(msg.id)
          if (msg.id === ctx.selfId() || !v) audio.ui('ui.levelUp')
          else audio.play('ui.levelUp', at(v))
          break
        }
        case 'spawn': {
          const e = msg.entity
          if (e.kind === 'item') audio.drop(e.model, { x: e.pos[0], y: e.pos[1] + 0.3, z: e.pos[2] })
          else arrived(e)
          break
        }
        case 'actionResult':
          if (msg.ok && msg.re === 'pickup') audio.ui('item.pickup')
          if (msg.ok && msg.re === 'itemUse' && !drinkAt && now() > quietUntil) drinkAt = now() + DRINK_FALLBACK_MS
          break
        case 'itemCooldown':
          if (DRINK_GROUPS.test(msg.group)) drink()
          else drinkAt = 0
          break
        case 'itemCast':
        case 'warp':
          if (msg.id === ctx.selfId()) {
            drinkAt = 0
            quietUntil = now() + DRINK_FALLBACK_MS
          }
          break
        case 'cast':
          onCast(msg)
          break
        case 'castEnd': {
          sounds.get(msg.id)?.setSkill(null)
          casts.delete(msg.id)
          for (let i = pending.length - 1; i >= 0; i--) if (pending[i]!.entity === msg.id) pending.splice(i, 1)
          break
        }
        case 'effectAdd': {
          carried.add(msg.id, msg.effect)
          const imbue = carried.imbueOf(msg.id)
          if (imbue) audio.preloadSkill(imbue)
          onEffect(msg.id, msg.effect)
          break
        }
      }
    },

    onCombatHit(msg, i) {
      const hit = msg.hits[i]
      const victim = ctx.view(msg.target)
      if (!hit || !victim) return
      const attacker = ctx.view(msg.attacker)
      const q: HitQuery = {
        skill: msg.skill ?? null,
        attacker: attacker
          ? { kind: attacker.kind, model: attacker.state.model, family: family(attacker), clip: attacker.actor?.clipCursors().top?.name ?? null }
          : null,
        victim: { kind: victim.kind, model: victim.state.model, radius: victim.radius, rarity: ctx.app.catalog.content.mobs.get(victim.state.model)?.rarity },
        outcome: hit.outcome,
        imbue: carried.imbueOf(msg.attacker),
        hwan: hit.hwan === true || berserk.has(msg.attacker),
        guards: carried.groupsOf(msg.target),
      }
      if (hit.outcome === 'crit') sounds.get(victim.id)?.critHit(now())
      audio.hit(q, at(victim))
    },

    onFrame() {
      const selfId = ctx.selfId()
      audio.setFocus(selfId ?? -1, ctx.target()?.id ?? -1)
      // Play the Boss (docs/PLAY_THE_BOSS.md §4.1): the listener stands at the steered mob while piloting.
      const focus = ctx.controlledId?.() ?? selfId
      const self = focus !== null ? ctx.view(focus) : undefined
      if (self) {
        const cam = ctx.camera
        audio.setListener(self.root.position, { x: cam.target.x - cam.position.x, y: 0, z: cam.target.z - cam.position.z })
      }
      audio.setWorld(ctx.world()?.world ?? null)
      followLife(ctx.world()?.world?.life ?? null)
      const t = now()
      if (drinkAt && t >= drinkAt) drink()
      if (pending.length) {
        const due = pending.filter(p => p.at <= t)
        if (due.length) {
          for (const p of due) pending.splice(pending.indexOf(p), 1)
          for (const p of due) p.fn()
        }
      }
      for (const [id, c] of casts) if (t > c.until) casts.delete(id)
      audio.tick()
    },

    onTownChange(inTown) {
      audio.setArea(inTown ? 'JANGAN_TOWN' : 'JANGAN_FIELD')
    },

    escape() {
      const w = soundSettingsWindow()
      if (!w?.isOpen) return false
      w.close()
      return true
    },

    dispose() {
      offAttach()
      offMenu()
      closeSoundSettings()
      audio.setArea(null)
      audio.setFocus(-1, -1)
      audio.setWorld(null)
      followLife(null)
      pending.length = 0
      sounds.clear()
      carried.clear()
      berserk.clear()
      dead.clear()
    },
  }
}
