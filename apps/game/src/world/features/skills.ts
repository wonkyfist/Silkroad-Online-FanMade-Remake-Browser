/**
 * World feature of lane SK-C, skills (docs/SKILLS.md §10.3; WAVE_PLAN §4.4). It owns the skills client for one world
 * visit and wires it to the server messages:
 * - `skills` / `skillsUpdate` -> SkillState -> the skill window (S, alias K) and the hotbar (1-0, pages F1-F4);
 *   the underbar's mouse quick slot is used by the middle mouse button on the world canvas (kept per character name);
 * - `cast` / `castEnd` / `combat {instance}` -> the ActionPlayer (clips per phase, hits at their cues) and SkillFx
 *   (effect stages, hit sparks); own casts arm the CooldownClock (`skill:<group>`), `itemCooldown` the item keys;
 * - `EntityState.effects` / `effectAdd` / `effectRemove` -> EffectBook -> the buff bar under the player frame, the
 *   target window's row, ACT_S/ACT_L effects on carriers and the DOWN/STUN reaction clips.
 * - wave 7B (docs/EFFECTS.md §6.4, FX-C1): weapon trails on basic attacks and SHOT phases, Hide Weapon during the
 *   action (M7), heal/cure/resurrect ACT_S on the target at the release (M6), chain segments' own slashes (M21), and the
 *   mob presentation (docs/WAVE_PLAN2.md D4): a mob `cast` + `combat {instance}` plays through the same ActionPlayer
 *   with a SkillDef built from the fx index's MSKILL group; a mob `combat` without an instance plays its MSKILL
 *   group's clip, stages, projectile and impact (the skill it names, else the mob's default skills in turn).
 * The server decides everything; this only sends intents (`useSkill`, `itemUse`, `hotbarSet`, `skillLearn`,
 * `masteryUp`, `buffCancel`) and presents what comes back.
 */
import { MOUSE_SLOT, type EffectState, type EntityState, type ServerMessage, type SkillDef } from '@sro/shared'
import { SkillCatalog, SkillState } from '../../content/skills.ts'
import { BuffBar, EffectBook, targetIcons } from '../../hud/buffs.ts'
import { cooldownNow, itemCooldownKey, skillCooldownKey } from '../../hud/cooldowns.ts'
import { Hotbar } from '../../hud/hotbar.ts'
import { HOTBAR_KEYS, HOTBAR_PAGE_KEYS, slotMessage, type HotbarContext, type ResolvedSlot } from '../../hud/hotbar-model.ts'
import { intent } from '../../hud/intents.ts'
import { browserMouseSlotStorage, isMiddlePress, MouseSlotStore } from '../../hud/mouse-slot.ts'
import { SkillWindow } from '../../hud/skills.ts'
import { Tooltip } from '../../hud/slots.ts'
import { t } from '../../i18n/index.ts'
import { settings } from '../../settings.ts'
import { fxBudget } from '../fx/quality.ts'
import type { SkillPhase } from '../../three/models.ts'
import type { EntityView } from '../entities.ts'
import type { CombatMessage, WorldFeatureContext, WorldFeatureFactory } from '../features.ts'
import { isPiloting } from '../pilot-model.ts'
import { damageFlight, isFlight, parseMove, SkillFx, type FxSkill, type StatusParticle } from '../skill-fx.ts'
import { ActionPlayer, clipTypeOf, mobSkillDef, type ActionPort, type PhasePlan, type SkillAction } from '../skills-view.ts'

/** Requests whose refusals the HUD toasts for us. */
const SKILL_REQUESTS = ['useSkill', 'skillLearn', 'masteryUp', 'buffCancel', 'hotbarSet'] as const
/** A hotbar key pressed while this much cooldown is left does nothing (no request, no toast). */
const COOLDOWN_SLACK_MS = 120
/** Knockdown lasts this long without an effect saying otherwise (SKILLS.md §10.1). */
const DOWN_MS = 2000
/** Skill kinds whose ACT_S plays on the target at the release (they send no effectAdd; docs/EFFECTS.md M6). */
const RELEASE_ACT_S = new Set(['heal', 'cure', 'resurrect'])

/** The basic-attack group of a weapon family (skillaniset2 Basic_Group; fists: SKILL_PUNCH). */
export function basicGroup(family: string | null | undefined): string {
  if (family === 'sword' || family === 'blade') return 'SKILL_CH_SWORD_BASE'
  if (family === 'spear' || family === 'glaive') return 'SKILL_CH_SPEAR_BASE'
  if (family === 'bow') return 'SKILL_CH_BOW_BASE'
  return 'SKILL_PUNCH'
}

/** A mob's clip of `type`: the named one, else ATTACK1 (the three `_clon` clip gaps, docs/SYSTEMS_COMBAT.md §2.1). */
function mobClip(v: EntityView, aniGroup: string | undefined, type: string) {
  const a = v.actor
  if (!a) return undefined
  return a.skillClip(aniGroup, type) ?? (v.kind === 'mob' ? a.skillClip('default', 'ATTACK1') : undefined)
}

/** The ActionPlayer's view of an entity: its actor's skill clips, facing its target. */
export function portOf(v: EntityView | undefined, view: (id: number) => EntityView | undefined): ActionPort | null {
  if (!v) return null
  return {
    clip(aniGroup, type) {
      const a = v.actor
      const c = mobClip(v, aniGroup, type)
      if (!a || !c) return null
      const info = a.clips.get(c.name)
      return { durationMs: info?.durationMs ?? 1000, hits: info?.hits ?? [] }
    },
    play(aniGroup, phases) {
      const a = v.actor
      if (!a || v.dead) return null
      const list: SkillPhase[] = []
      for (const p of phases) {
        const clip = mobClip(v, aniGroup, p.type)
        // A missing clip holds the previous one for its time (the hit cues keep their timing).
        if (!clip) {
          const prev = list[list.length - 1]
          if (prev) prev.ms += p.ms
          continue
        }
        list.push({ clip, ms: p.ms, loop: p.loop })
      }
      if (!list.length) return null
      const token = a.playSkill(list)
      return token < 0 ? null : token
    },
    stop: token => v.actor?.stopSkill(token),
    playing: token => !!v.actor?.isSkillPlaying(token),
    face(targetId) {
      const tv = view(targetId)
      if (tv && tv !== v) v.face(tv.pos.x, tv.pos.z)
    },
  }
}

/**
 * The ActionPlayer wired to SkillFx the way the skills feature presents actions (the H1 retail harness drives this
 * same code): stage rows per phase, the weapon trail of the SHOT phase, Hide Weapon from the first phase to the end
 * (M7), heal/cure/resurrect ACT_S on the target at the release (M6), chain segments' own slashes (M21), and mob
 * skills without data rows through a SkillDef built from their MSKILL group (D4).
 */
export function createSkillPresenter(catalog: SkillCatalog, fx: SkillFx, view: (id: number) => EntityView | undefined): {
  player: ActionPlayer
  mobDef(code: string): SkillDef | undefined
  forgetCaster(id: number): void
} {
  /** SkillDef stand-ins of mob skills (MSKILL_*), from the fx index (D4). */
  const mobDefs = new Map<string, SkillDef | null>()
  const mobDef = (code: string): SkillDef | undefined => {
    if (!code.startsWith('MSKILL_')) return undefined
    let d = mobDefs.get(code)
    if (d === undefined) {
      const g = fx.skill(code)
      if (!g) return undefined
      d = clipTypeOf(g.clips?.shot) || clipTypeOf(g.clips?.ready) ? mobSkillDef(g) : null
      mobDefs.set(code, d)
    }
    return d ?? undefined
  }
  /** Hide Weapon (M7): how many running actions hide each caster's weapon. */
  const hidden = new Map<number, number>()
  const hideWeapon = (a: SkillAction, on: boolean) => {
    const g = fx.skill(a.group)
    if (!g?.hideWeapon) return
    const v = view(a.caster)
    const n = (hidden.get(a.caster) ?? 0) + (on ? 1 : -1)
    if (n <= 0) hidden.delete(a.caster)
    else hidden.set(a.caster, n)
    v?.actor?.setWeaponVisible(n <= 0)
  }
  /** Actions whose weapon is hidden now (so each is shown again exactly once). */
  const hiding = new WeakSet<SkillAction>()
  const showWeapon = (a: SkillAction) => {
    if (!hiding.has(a)) return
    hiding.delete(a)
    hideWeapon(a, false)
  }
  const player = new ActionPlayer(catalog, {
    fallbackDef: mobDef,
    onPhase(a, phase: PhasePlan, start, clip) {
      const caster = view(a.caster)
      if (!caster) return
      if (a.phases[0]?.plan === phase && !hiding.has(a) && fx.skill(a.group)?.hideWeapon) {
        hiding.add(a)
        hideWeapon(a, true)
      }
      const shot = a.phases.find(p => p.plan.phase === 'SHOT')
      const loopUntil = phase.phase === 'SHOT' ? start + phase.ms : shot ? shot.start : a.release
      const target = a.target !== undefined ? view(a.target) : undefined
      // A chain head plays its first slash; each segment's cast plays its own (M21).
      const chainHead = phase.phase === 'SHOT' && !!a.def?.chainNext && (a.def.chainIndex ?? 1) <= 1
      const events = chainHead ? new Set([0, 1]) : undefined
      fx.stages(a.group, phase.phase, { caster, ...(target ? { target } : {}), start, hits: clip?.hits ?? [], loopUntil, imbue: fx.imbueOf(a.caster), ...(events ? { events } : {}) })
      // M6: heal / cure / resurrect play their ACT_S on the target at the release (they send no effectAdd). The
      // server applies the HP / cure / revival at the release too (engine.ts release), so the effect and the target's
      // bars change together; the clip's first hit point comes 100-250 ms later on these clips (the FX lab checks it).
      if (a.phases[0]?.plan === phase && a.def?.kind && RELEASE_ACT_S.has(a.def.kind)) {
        player.schedule(a.release, () => {
          if (a.ended) return
          const tv = a.target !== undefined ? view(a.target) : view(a.caster)
          if (tv && !tv.isDisposed) fx.buffStart(a.group, tv)
        })
      }
      if (phase.phase === 'SHOT') fx.swing(caster, a.group, start + phase.ms)
    },
    onSegment(a, index, now) {
      const caster = view(a.caster)
      const shot = a.phases.find(p => p.plan.phase === 'SHOT')
      if (!caster || !shot) return
      const target = a.target !== undefined ? view(a.target) : undefined
      fx.stages(a.group, 'SHOT', { caster, ...(target ? { target } : {}), start: shot.start, hits: shot.clip?.hits ?? [], loopUntil: Math.max(now, shot.start + shot.plan.ms), imbue: fx.imbueOf(a.caster), events: new Set([index]) })
    },
    onEnd(a) {
      fx.stopCasterLoops(a.caster)
      showWeapon(a)
    },
    onFinish(a) {
      showWeapon(a)
    },
  })
  return { player, mobDef, forgetCaster: id => hidden.delete(id) }
}

/** The Skills window key (MV-WASD: K only; S walks back, world/features/keymove.ts) and its menu-bar caption. */
export const SKILLS_WINDOW_KEYS: readonly string[] = ['k']
export const SKILLS_WINDOW_HOTKEY = 'K'

export const skillsFeature: WorldFeatureFactory = (ctx: WorldFeatureContext) => {
  const { hud, app } = ctx
  // A bare context (tests of the feature list) gets no skills.
  if (!hud || !app?.catalog) return {}
  const content = app.catalog.content
  const catalog = new SkillCatalog(content.skills.values(), content.masteries.values(), content.levels)
  const state = new SkillState(catalog)
  const effects = new EffectBook()
  const tooltip = new Tooltip(app.art)
  const fx = new SkillFx(ctx.scene)
  void fx.load()
  // LAB (G-11): the console handle for the effect budget A/B (`__sroSkillFx.setOtherHits(n)`, `.stats`)
  if (typeof window !== 'undefined') (window as unknown as { __sroSkillFx?: SkillFx }).__sroSkillFx = fx
  // Hit lights (M12) and weapon trails (M1) follow the graphics preset's effect budget (world/fx/quality.ts).
  const applyQuality = () => {
    const b = fxBudget(settings.get().graphics.preset)
    fx.setLightsEnabled(b.hitLights)
    fx.setTrailsEnabled(b.trails)
    fx.setOtherHits(b.otherHits, id => id === ctx.selfId())
    fx.setOtherTrails(b.otherTrails)
  }
  applyQuality()
  // Mob status visuals come from the model's own status sets (sidecar particles, docs/EFFECTS.md §3.2).
  const statusSets = new Map<string, Map<string, StatusParticle> | null>()
  const statusLoading = new Set<string>()
  fx.setStatusSource(v => {
    const code = v.state.model
    if (statusSets.has(code)) return statusSets.get(code)
    const url = content.mobs.get(code)?.model?.sidecar
    if (!url) return null
    if (!statusLoading.has(code)) {
      statusLoading.add(code)
      fetch(url)
        .then(r => (r.ok ? r.json() : null))
        .then((j: { particles?: { set: string; kind: string; efp: string; bone: string | null; position: [number, number, number] }[] } | null) => {
          const m = new Map<string, StatusParticle>()
          for (const p of j?.particles ?? []) if (p.kind === 'status' && !m.has(p.set)) m.set(p.set, { efp: p.efp, bone: p.bone, position: p.position })
          statusSets.set(code, m.size ? m : null)
        })
        .catch(() => statusSets.set(code, null))
    }
    return undefined
  })
  /** The group each skill-less mob combat was presented with (onCombatHit reads it). */
  const mobCombat = new WeakMap<CombatMessage, { group: string; cues: NonNullable<SkillDef['hitCues']>; basic?: boolean }>()
  /** The next default skill of each mob (they take turns). */
  const mobTurn = new Map<number, number>()
  const offs: (() => void)[] = []
  /**
   * The own character's name. The server keeps the mouse quick slot (MOUSE_SLOT); an entry an older client left in this
   * browser (hud/mouse-slot.ts, per name) is moved to the server once, when the server has none.
   */
  let selfName = ''
  const mouseSlots = new MouseSlotStore(browserMouseSlotStorage())
  let hotbarDirty = true
  let buffsDirty = true
  let lastSp = -1
  let lastLevel = -1
  let uiTick = 0
  let qualityTick = 2
  /** Crowd-control clips playing per entity: which, and the actor token. */
  const reactions = new Map<number, { kind: 'down' | 'stun'; token: number; until?: number }>()
  /** Victims lying knocked down when a combat message arrived (its hits play DOWN_DAMAGE / DOWN_DIE, M20). */
  const downWhen = new WeakMap<CombatMessage, boolean>()

  hud.claimRequests(SKILL_REQUESTS)

  const send = (msg: Parameters<WorldFeatureContext['send']>[0] | null) => {
    if (!msg) return
    if (!ctx.send(msg)) hud.toast(t('net.notConnected'), 'error')
  }

  const hotbarContext = (): HotbarContext => {
    const inv = hud.inventory
    const s = hud.stats
    return {
      catalog,
      state,
      item: code => hud.items.def(code),
      bagSize: inv.bagSize,
      bag: i => inv.item(i),
      equipped: slot => inv.equipped(slot),
      mp: s ? s.mp : null,
      maxMp: s ? s.maxMp : null,
    }
  }

  const selfView = () => {
    const id = ctx.selfId()
    return id === null ? undefined : ctx.view(id)
  }

  /** A hotbar slot pressed: useSkill with the fitting target, or itemUse of the lowest bag slot (decision 7). */
  const useSlot = (r: ResolvedSlot) => {
    const self = selfView()
    if (self?.dead) return
    if (r.cooldownKey && hud.cooldowns.remaining(r.cooldownKey, cooldownNow()) > COOLDOWN_SLACK_MS) return
    if (r.block === 'no_item') return hud.toast(t('skills.hotbar.noItem'), 'error')
    if (r.block === 'not_learned') return hud.toast(t('action.fail.not_learned'), 'error')
    const tv = ctx.target()
    const selected = tv && tv.kind !== 'item' && tv.kind !== 'cos' ? { id: tv.id, kind: tv.kind, dead: tv.dead || tv.dying } : null
    const def = r.entry.kind === 'skill' ? catalog.get(r.code) : undefined
    const msg = slotMessage(r, def, selected, ctx.selfId())
    if (msg === 'need_target') return hud.toast(t('skills.needTarget'), 'error')
    send(msg)
  }

  const hotbar = new Hotbar({
    art: app.art,
    // UI-H's underbar hosts the quick slots (docs/WAVE_PLAN2.md §5.0 hook line; hud/hotbar.ts underbar mode).
    parent: hud.underbar?.slots ?? hud.layer,
    catalog,
    state,
    items: hud.items,
    cooldowns: hud.cooldowns,
    tooltip,
    context: hotbarContext,
    send,
    use: useSlot,
    toast: text => hud.toast(text, 'error'),
    itemTooltip: code => hud.items.tooltip({ code, count: 1 }, { player: hud.stats }),
    onMouseChange: entry => {
      const m = intent.hotbarSet(MOUSE_SLOT, entry)
      if (m) send(m)
    },
  })

  // ---- the mouse quick slot: the middle mouse button (the wheel) in the world uses it, like its key would ----------
  // A native listener on the canvas: Babylon's camera only takes the right button (screens/world.ts), the scene's
  // pick handlers only the left, and windows over the canvas get their own events, so a press there never lands here.
  const canvas = ctx.scene?.getEngine?.()?.getRenderingCanvas?.() ?? null
  if (canvas) {
    const onMiddle = (ev: PointerEvent) => {
      if (!isMiddlePress(ev)) return
      // No autoscroll (or paste) from the wheel button on the game view.
      ev.preventDefault()
      // A camera drag captures the pointer to the canvas: over a window the press still does nothing.
      if (typeof document !== 'undefined' && document.elementFromPoint(ev.clientX, ev.clientY) !== canvas) return
      hotbar.pressMouse()
    }
    const noAutoscroll = (ev: MouseEvent) => {
      if (ev.button === 1) ev.preventDefault()
    }
    canvas.addEventListener('pointerdown', onMiddle)
    canvas.addEventListener('pointermove', onMiddle)
    canvas.addEventListener('mousedown', noAutoscroll)
    canvas.addEventListener('auxclick', noAutoscroll)
    offs.push(() => {
      canvas.removeEventListener('pointerdown', onMiddle)
      canvas.removeEventListener('pointermove', onMiddle)
      canvas.removeEventListener('mousedown', noAutoscroll)
      canvas.removeEventListener('auxclick', noAutoscroll)
    })
  }

  const win = new SkillWindow({
    art: app.art,
    parent: hud.layer,
    catalog,
    state,
    cooldowns: hud.cooldowns,
    tooltip,
    hotbar,
    stats: () => hud.stats,
    send,
  })
  win.onClose = () => tooltip.hide()

  const buffs = new BuffBar({
    parent: hud.layer,
    catalog,
    tooltip,
    cancel: skill => send(intent.buffCancel(skill)),
  })

  // ---- keys and the menu bar ----------------------------------------------------------------------
  offs.push(ctx.keys.register({ id: 'window.skills', keys: [...SKILLS_WINDOW_KEYS], label: 'skills.keys.window', group: 'windows', run: () => win.toggle() }))
  HOTBAR_KEYS.forEach((key, i) => {
    // Play the Boss (docs/PLAY_THE_BOSS.md §4.1): off while piloting, so the pilot's kit keys win without a warning.
    offs.push(ctx.keys.register({ id: `hotbar.${i + 1}`, keys: [key], label: 'skills.keys.hotbar', group: 'combat', when: () => !isPiloting(ctx), run: () => hotbar.press(i) }))
  })
  HOTBAR_PAGE_KEYS.forEach((key, i) => {
    offs.push(ctx.keys.register({ id: `hotbar.page${i + 1}`, keys: [key], label: 'skills.keys.page', group: 'combat', run: () => hotbar.setPage(i) }))
  })
  offs.push(hud.menubar.register({ id: 'skills', art: 'mainpopup/main_sysbutton_skill', label: 'skills.win.title', hotkey: SKILLS_WINDOW_HOTKEY, toggle: () => win.toggle(), isOpen: () => win.isOpen }))

  // ---- cooldowns -------------------------------------------------------------------------------------
  /** Own cast: the group's cooldown starts now (SKILLS.md §5.1: from t0, per group). */
  const armCooldown = (skill: string) => {
    const def = catalog.get(skill)
    if (!def || def.basicAttack || !(def.cooldownMs > 0)) return
    hud.cooldowns.setIn(skillCooldownKey(def.group ?? catalog.groupOf(skill)), def.cooldownMs, def.cooldownMs)
  }

  // ---- presentation ------------------------------------------------------------------------------------
  const { player, mobDef, forgetCaster } = createSkillPresenter(catalog, fx, id => ctx.view(id))

  const clipMs = (v: EntityView, type: string): { clip: SkillPhase['clip']; ms: number } | null => {
    const a = v.actor
    const clip = a?.skillClip('default', type)
    if (!a || !clip) return null
    return { clip, ms: a.clips.get(clip.name)?.durationMs ?? 1000 }
  }

  /** DOWN -> DOWN_RM (held) -> DOWN_UP for `ms` in all (knockdown), unless already down. */
  const knockdown = (v: EntityView, ms: number) => {
    const cur = reactions.get(v.id)
    if (cur?.kind === 'down' && v.actor?.isSkillPlaying(cur.token)) return
    const down = clipMs(v, 'DOWN')
    if (!down || v.dead || !v.actor) return
    const rm = clipMs(v, 'DOWN_RM')
    const up = clipMs(v, 'DOWN_UP')
    const phases: SkillPhase[] = [{ clip: down.clip, ms: down.ms }]
    const hold = Math.max(0, ms - down.ms - (up?.ms ?? 0))
    if (rm && hold > 0) phases.push({ clip: rm.clip, ms: hold, loop: true })
    if (up) phases.push({ clip: up.clip, ms: up.ms })
    const token = v.actor.playSkill(phases)
    if (token >= 0) reactions.set(v.id, { kind: 'down', token, until: cooldownNow() + Math.max(ms, down.ms + (up?.ms ?? 0)) })
  }

  /** Is `v` lying knocked down (its DOWN clips playing)? */
  const isDown = (v: EntityView): boolean => {
    const cur = reactions.get(v.id)
    return cur?.kind === 'down' && !!v.actor?.isSkillPlaying(cur.token)
  }

  /** M20: a hit on a knocked-down victim plays DOWN_DAMAGE, then it lies on for the rest of the knockdown. */
  const downDamage = (v: EntityView) => {
    const cur = reactions.get(v.id)
    const dmg = clipMs(v, 'DOWN_DAMAGE')
    if (!cur || cur.kind !== 'down' || !dmg || !v.actor || v.dead) return
    const rm = clipMs(v, 'DOWN_RM')
    const up = clipMs(v, 'DOWN_UP')
    const left = Math.max(0, (cur.until ?? 0) - cooldownNow())
    const phases: SkillPhase[] = [{ clip: dmg.clip, ms: dmg.ms }]
    const hold = Math.max(0, left - dmg.ms - (up?.ms ?? 0))
    if (rm && hold > 0) phases.push({ clip: rm.clip, ms: hold, loop: true })
    if (up) phases.push({ clip: up.clip, ms: up.ms })
    const token = v.actor.playSkill(phases)
    if (token >= 0) reactions.set(v.id, { kind: 'down', token, until: cur.until ?? 0 })
  }

  /** M20: a victim killed while knocked down dies with DOWN_DIE instead of DIE1 (world.ts already started DIE1). */
  const downDie = (v: EntityView) => {
    const a = v.actor
    if (!a || !a.group('DOWN_DIE')) return
    a.revive()
    a.die(false, 'DOWN_DIE')
  }

  /** STUN looped for `ms`. */
  const stun = (v: EntityView, ms: number) => {
    const s = clipMs(v, 'STUN')
    if (!s || v.dead || !v.actor) return
    const token = v.actor.playSkill([{ clip: s.clip, ms: Math.max(ms, 300), loop: true }])
    if (token >= 0) reactions.set(v.id, { kind: 'stun', token })
  }

  /** A knockdown or stun ended early: stand up / stop. */
  const endReaction = (v: EntityView | undefined, kind: 'down' | 'stun') => {
    if (!v) return
    const cur = reactions.get(v.id)
    if (!cur || cur.kind !== kind) return
    reactions.delete(v.id)
    if (!v.actor?.isSkillPlaying(cur.token)) return
    const up = kind === 'down' ? clipMs(v, 'DOWN_UP') : null
    if (up) v.actor.playSkill([{ clip: up.clip, ms: up.ms }])
    else v.actor.stopSkill(cur.token)
  }

  const loopHandle = (id: number, instance: number) => `${id}:${instance}`

  const effectAdded = (id: number, e: EffectState, fresh: boolean) => {
    const v = ctx.view(id)
    if (!v) return
    if (e.skill) {
      const group = catalog.groupOf(e.skill)
      if (fresh) fx.buffStart(group, v)
      fx.startLoop(loopHandle(id, e.instance), group, v)
    }
    if (e.status) fx.status(loopHandle(id, e.instance), e.status, v, fresh) // W5-V: status loops (stopLoop on remove)
    if (e.status === 'knockdown') knockdown(v, e.remainingMs || DOWN_MS)
    if (e.status === 'stun' && fresh) stun(v, e.remainingMs)
  }

  const setEntityEffects = (s: EntityState) => {
    const now = cooldownNow()
    for (const old of effects.drop(s.id)) fx.stopLoop(loopHandle(s.id, old.effect.instance))
    effects.set(s.id, s.effects, now)
    for (const e of s.effects ?? []) effectAdded(s.id, e, false)
  }

  const forgetEntity = (id: number) => {
    mobTurn.delete(id)
    forgetCaster(id)
    for (const old of effects.drop(id)) fx.stopLoop(loopHandle(id, old.effect.instance))
    fx.forget(id)
    player.forget(id)
    reactions.delete(id)
    if (id === ctx.selfId()) buffsDirty = true
  }

  const refreshTarget = () => {
    const tv = ctx.target()
    hud.setTargetEffects?.(tv ? targetIcons(effects.list(tv.id), catalog, cooldownNow()) : [])
  }

  const onMessage = (msg: ServerMessage) => {
    const self = ctx.selfId()
    switch (msg.t) {
      case 'worldEnter': {
        selfName = msg.self.name
        player.clear()
        for (const id of effects.ids()) forgetEntity(id)
        effects.clear()
        reactions.clear()
        setEntityEffects(msg.self)
        for (const e of msg.entities) setEntityEffects(e)
        buffsDirty = true
        break
      }
      case 'spawn':
        setEntityEffects(msg.entity)
        break
      case 'despawn':
        forgetEntity(msg.id)
        break
      case 'skills': {
        state.applySnapshot(msg)
        hotbar.setMouseEntry(state.mouse)
        // A mouse slot this browser kept before the server stored it: hand it over once, then forget it here.
        const legacy = state.mouse ? null : mouseSlots.get(selfName)
        if (legacy) {
          const m = intent.hotbarSet(MOUSE_SLOT, legacy)
          if (m) send(m)
        }
        if (selfName) mouseSlots.set(selfName, null)
        for (const c of msg.cooldowns ?? []) {
          const total = catalog.rows(c.group)[0]?.cooldownMs ?? c.readyInMs
          hud.cooldowns.setIn(skillCooldownKey(c.group), c.readyInMs, Math.max(total, c.readyInMs))
        }
        hotbarDirty = true
        win.render()
        break
      }
      case 'skillsUpdate': {
        const change = state.applyUpdate(msg)
        if (change.mouse) hotbar.setMouseEntry(state.mouse)
        hotbarDirty = true
        if (change.masteries || change.learned.length) win.render()
        break
      }
      case 'cast': {
        const now = cooldownNow()
        player.cast(msg, now, portOf(ctx.view(msg.id), id => ctx.view(id)))
        if (msg.id === self) armCooldown(msg.skill)
        break
      }
      case 'castEnd':
        player.castEnd(msg, portOf(ctx.view(msg.id), id => ctx.view(id)))
        break
      case 'effectAdd': {
        effects.add(msg.id, msg.effect, cooldownNow())
        effectAdded(msg.id, msg.effect, true)
        if (msg.id === self) buffsDirty = true
        break
      }
      case 'effectRemove': {
        const e = effects.remove(msg.id, msg.instance)
        fx.stopLoop(loopHandle(msg.id, msg.instance))
        // DEACT rows (docs/EFFECTS.md §3.3) play when a buff ends.
        const carrier = ctx.view(msg.id)
        if (e?.effect.skill && carrier) fx.buffEnd(catalog.groupOf(e.effect.skill), carrier)
        if (e?.effect.status === 'knockdown' && !effects.has(msg.id, 'knockdown')) endReaction(ctx.view(msg.id), 'down')
        if (e?.effect.status === 'stun' && !effects.has(msg.id, 'stun')) endReaction(ctx.view(msg.id), 'stun')
        if (msg.id === self) buffsDirty = true
        break
      }
      case 'itemCooldown':
        hud.cooldowns.setIn(itemCooldownKey(msg.group), msg.readyInMs, msg.totalMs)
        break
      case 'stats':
      case 'statsDelta': {
        hotbarDirty = true
        const s = hud.stats
        if (s && (s.sp !== lastSp || s.level !== lastLevel)) {
          lastSp = s.sp
          lastLevel = s.level
          win.render()
        }
        break
      }
      case 'inventory':
      case 'inventoryUpdate':
      case 'appearance':
        hotbarDirty = true
        break
      case 'entityUpdate':
        if (msg.state === 'dead') {
          reactions.delete(msg.id)
          player.forget(msg.id)
        }
        // Wave 8 (BZ, I8): Berserk on/off drives the HWAN weapon trail (SkillFx priority 10).
        if (msg.berserkMs !== undefined) fx.setBerserk(msg.id, msg.berserkMs > 0)
        break
    }
  }

  /** The MSKILL group a skill-less mob attack shows: the mob's default skills in turn (same reach as its first). */
  const mobGroup = (v: EntityView): FxSkill | undefined => {
    const skills = (content.mobs.get(v.state.model)?.skills ?? []).map(c => fx.skill(c)).filter((g): g is FxSkill => !!g && !!clipTypeOf(g.clips?.shot) && !/_SUMMON/.test(g.group))
    if (!skills.length) return undefined
    const ranged = (g: FxSkill) => g.stages.some(st => isFlight(st.actType))
    const same = skills.filter(g => ranged(g) === ranged(skills[0]!))
    const n = mobTurn.get(v.id) ?? 0
    mobTurn.set(v.id, n + 1)
    return same[n % same.length]
  }

  /**
   * A mob attack without an instance (docs/WAVE_PLAN2.md D4): the skill's (or the mob's default) MSKILL clip through
   * EntityView.attack({clip}), its stages (nocked arrow, force bolts, gas) from the clip's hit events, and each hit
   * shown at its event, or when its projectile arrives. False when the mob has no fx group (today's cycle).
   */
  const presentMobAttack = (msg: CombatMessage): boolean => {
    const attacker = ctx.view(msg.attacker)
    const victim = ctx.view(msg.target)
    if (!attacker || attacker.kind !== 'mob' || attacker.dead || !attacker.actor) return false
    const g = (msg.skill ? fx.skill(msg.skill) : undefined) ?? mobGroup(attacker)
    const type = clipTypeOf(g?.clips?.shot)
    if (!g || !type) return false
    const def = mobDef(g.group)
    const cues = def?.hitCues ?? [{ phase: 'SHOT', event: 1 }]
    const now = cooldownNow()
    const clip = mobClip(attacker, 'default', type)
    const delays = attacker.attack(victim, msg.hits.length, now, clip ? { clip: clip.name } : {})
    const info = clip ? attacker.actor.clips.get(clip.name) : undefined
    const ev = info?.hits ?? []
    // EntityView.attack may speed the clip up: stage events follow the same speed.
    const speed = ev.length && delays[0] ? Math.max(1, ev[0]! / delays[0]) : 1
    const hits = ev.map(e => e / speed)
    const durMs = (info?.durationMs ?? 1000) / speed
    if (victim && victim !== attacker) victim.face(attacker.pos.x, attacker.pos.z)
    fx.stages(g.group, 'SHOT', { caster: attacker, ...(victim ? { target: victim } : {}), start: now, hits, loopUntil: now + durMs })
    fx.swing(attacker, g.group, now + durMs)
    mobCombat.set(msg, { group: g.group, cues })
    const flight = damageFlight(g)
    msg.hits.forEach((_, i) => {
      const cue = cues[i] ?? cues[cues.length - 1]
      const extra = cues.length && i >= cues.length ? (i - cues.length + 1) * 140 : 0
      const ev0 = cue && cue.event > 0 ? hits[cue.event - 1] : undefined
      let at = now + (ev0 !== undefined ? ev0 + extra : delays[i] ?? 0)
      if (flight && cue && flight.startEvent === cue.event && victim) {
        const move = parseMove(flight.move)
        const d = Math.hypot(victim.pos.x - attacker.pos.x, victim.pos.z - attacker.pos.z)
        if (move) at += move.delayMs + Math.min(3000, (d / Math.max(1, move.speed)) * 1000)
      }
      player.schedule(at, () => ctx.presentHit(msg, i))
    })
    return true
  }

  /**
   * A bow basic attack (world.ts's default swing, taken over): the arrow leaves at each hit event of the attack clip
   * and the hit (number, hurt, HP, impact) shows when it lands, not while the arrow is still in the air (FX lab H2).
   */
  const presentBasicArrow = (msg: CombatMessage, group: string, attacker: EntityView, victim: EntityView): boolean => {
    const now = cooldownNow()
    const delays = attacker.attack(victim, msg.hits.length, now)
    victim.face(attacker.pos.x, attacker.pos.z)
    msg.hits.forEach((_, i) => {
      player.schedule(now + (delays[i] ?? i * 180), () => {
        const v = ctx.view(msg.target)
        const a = ctx.view(msg.attacker)
        const ms = a && v ? fx.shootBasic(group, a, v) : null
        if (ms === null) ctx.presentHit(msg, i)
        else player.schedule(cooldownNow() + ms, () => ctx.presentHit(msg, i))
      })
    })
    return true
  }

  return {
    onMessage,
    combat(msg) {
      const target = ctx.view(msg.target)
      if (target && isDown(target)) downWhen.set(msg, true)
      if (msg.instance !== undefined) {
        const shown = player.combat(msg, cooldownNow(), ctx.serverNow(), i => {
          const victim = ctx.view(msg.target)
          const attacker = ctx.view(msg.attacker)
          if (victim && attacker && victim !== attacker && victim.kind === 'mob') victim.face(attacker.pos.x, attacker.pos.z)
          ctx.presentHit(msg, i)
        })
        if (shown) return true
      }
      const attacker = ctx.view(msg.attacker)
      if (!attacker) return false
      if (attacker.kind === 'mob') return presentMobAttack(msg)
      // A player's basic attack: world.ts plays the swing; its trail follows that clip (M1). Without a skill code
      // (older servers, the offline mock) the weapon family names the basic-attack group.
      const def = msg.skill ? catalog.get(msg.skill) : undefined
      if (msg.instance !== undefined) return false
      const group = def?.basicAttack ? catalog.groupOf(def.code) : !msg.skill ? basicGroup(attacker.actor?.family) : null
      if (group) {
        if (!def) mobCombat.set(msg, { group, cues: [{ phase: 'SHOT', event: 1 }], basic: true })
        fx.swing(attacker, group)
        const g = fx.skill(group)
        const victim = ctx.view(msg.target)
        if (g?.arrowTail && !g.stages.length && victim && victim !== attacker && !attacker.dead) return presentBasicArrow(msg, group, attacker, victim)
      }
      return false
    },
    onCombatHit(msg, i) {
      const hit = msg.hits[i]
      const victim = ctx.view(msg.target)
      if (!hit || !victim) return
      const mob = mobCombat.get(msg)
      const group = mob?.group ?? (msg.skill ? catalog.groupOf(msg.skill) : null)
      if (group) {
        // The hit's DMG stages (its hitCue), projectile landing, arrows of bow basic attacks, then the impact.
        const def = msg.skill ? catalog.get(msg.skill) ?? mobDef(msg.skill) : undefined
        const cues = mob?.cues ?? def?.hitCues ?? []
        const landed = hit.outcome === 'hit' || hit.outcome === 'crit'
        fx.hit(group, victim, {
          attacker: ctx.view(msg.attacker),
          cue: cues[i] ?? cues[cues.length - 1],
          index: i,
          landed,
          basic: mob ? !!mob.basic : !!def?.basicAttack,
          ...(msg.instance !== undefined ? { instance: msg.instance } : {}),
          outcome: hit.outcome,
          down: !!downWhen.get(msg),
          // Berserk hits (CombatHit.hwan, wave 8 BZ): the HWAN spark.
          hwan: (hit as { hwan?: boolean }).hwan === true,
        })
      }
      const landedHit = hit.outcome === 'hit' || hit.outcome === 'crit'
      const lastKill = i === msg.hits.length - 1 && msg.killed
      if (downWhen.get(msg) && landedHit) {
        if (lastKill) downDie(victim)
        else downDamage(victim)
      }
      if (hit.down && !lastKill) knockdown(victim, DOWN_MS)
    },
    onFrame(_now, dt) {
      const now = cooldownNow()
      player.tick(now)
      fx.update(dt)
      qualityTick -= dt
      if (qualityTick <= 0) {
        qualityTick = 2
        applyQuality()
      }
      if (hotbarDirty) {
        hotbarDirty = false
        hotbar.render()
      }
      uiTick -= dt
      if (buffsDirty) {
        buffsDirty = false
        const self = ctx.selfId()
        buffs.render(self === null ? [] : effects.list(self), now)
        refreshTarget()
      } else if (uiTick <= 0) {
        uiTick = 0.25
        buffs.tick(now)
        refreshTarget()
      }
    },
    onEntityAdded(v) {
      // A late viewer of a berserk player (EntityState.berserkMs) gets the HWAN trail too.
      if ((v.state.berserkMs ?? 0) > 0) fx.setBerserk(v.id, true)
    },
    onEntityRemoved(v) {
      forgetEntity(v.id)
    },
    escape() {
      if (!win.isOpen) return false
      win.close()
      return true
    },
    dispose() {
      for (const off of offs.splice(0)) off()
      player.clear()
      fx.dispose()
      win.dispose()
      hotbar.dispose()
      buffs.dispose()
      tooltip.dispose()
      hud.setTargetEffects?.([])
    },
  }
}
