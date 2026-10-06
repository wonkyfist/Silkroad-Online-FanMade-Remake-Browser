/**
 * The winter gameplay layer on the client (docs/WINTER.md §13.7). Takes the server's `winterPlay`, `warmth`, `snowball`,
 * `snowballSplat`, `winterBoard`, `giftOpened`, `yetiSkill` (and the Ice Yeti's `uniqueNotice`) and shows them:
 *
 * - **Warmth** (world/winter/play-hud.ts): the bar under HP/MP while the season is on and it matters, coloured from
 *   amber to ice blue, pulsing when cold; a frost vignette that thickens as you freeze; a chat warning at each level
 *   (what it does, what helps) and a relief line when warm again; a shiver when freezing sets in.
 * - **Snowballs**: B throws one at the target (a player or a monster) or ahead of you; Shift+B opens the scoreboard. The
 *   thrower plays its throw clip (TROW) when the model has one; the arc, the powder trail and the splat are
 *   world/winter/play-fx.ts; a hit shows "Splat!" on the name tag (and a white splash on your own screen), with a whoosh
 *   and a thump. The server decides everything; refusals are toasted by the HUD.
 * - **Winter monsters** (world/winter/ice-look.ts): snow spirits and the Ice Yeti drawn in ice (an icy overlay on
 *   their own meshes), with frost glints around them; the yeti's telegraphs on the ground (slam, breath cone, barrage,
 *   roar), her clips and her synthesized roar, slam and breath.
 * - **Gift boxes**: the opening toast with its box animation, a chime and the rewards; Ginger Tea and the box have
 *   painted icons (content/winter-icons.ts).
 * - **Campfires** from `winterPlay.fires`: drawn by the FX (logs, flames, embers) with a crackle when you are close.
 * - The potion shop's Winter tab follows the layer (the server sells it only then).
 *
 * Nothing is built before the layer is on or a winter message arrives; everything is disposed on dispose (no leak).
 * `window.__sroWinterPlay` shows the state and the FX counts.
 */
import { WINTER_CODES, isWinterMob, setWinterShopTab, type Vec3, type WarmthLevel, type WarmthState, type WinterBoard, type WinterPlayState, type YetiSkill } from '@sro/shared'
import type { GameAudio } from '../../audio/index.ts'
import { FIRE_EVERY_S, FIRE_HEAR_M, WINTER_PLAY_SYNTH } from '../../audio/winter-play.ts'
import { t } from '../../i18n/index.ts'
import type { EntityView } from '../entities.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { iceLook } from '../winter/ice-look.ts'
import { FIRE_VIEW_M, WinterPlayFx, type FrostBody } from '../winter/play-fx.ts'
import { GiftToast, WarmthHud, WinterBoardPanel, warningFor, warmthNow } from '../winter/play-hud.ts'

/** A throw without a target lands this far ahead (m). */
export const THROW_AHEAD_M = 12
/** "Splat!" stays on a name tag this long (ms). */
export const SPLAT_LABEL_MS = 1200
/** Frost glints are drawn on winter monsters within this of the camera (m). */
export const FROST_VIEW_M = 70
/** The yeti's clip per move. */
export const YETI_CLIPS: Readonly<Record<YetiSkill, string>> = { slam: 'ATTACK3', breath: 'ATTACK2', barrage: 'ATTACK1', roar: 'STAND2' }
const YETI_SOUNDS: Readonly<Partial<Record<YetiSkill, string>>> = { slam: 'synth/wp_slam', breath: 'synth/wp_breath', roar: 'synth/wp_roar' }

/** The ground point a targetless throw aims at: THROW_AHEAD_M along the facing (yawTowards convention). */
export function throwPoint(x: number, z: number, yaw: number): { x: number; z: number } {
  return { x: x + Math.sin(yaw) * THROW_AHEAD_M, z: z + Math.cos(yaw) * THROW_AHEAD_M }
}

export function winterPlayFeature(ctx: WorldFeatureContext): WorldFeature {
  if (!ctx.session) return {}
  const audio: GameAudio | undefined = ctx.app?.audio
  const layer: HTMLElement | null = ctx.hud?.layer ?? null
  let play: WinterPlayState | null = null
  let warmth: WarmthState | null = null
  let level: WarmthLevel | null = null
  let fx: WinterPlayFx | null = null
  let hud: WarmthHud | null = null
  let board: WinterBoard | null = null
  const panel = new WinterBoardPanel(layer)
  const gift = new GiftToast(layer, { name: (c) => ctx.hud?.items?.name(c) ?? c, icon: (c) => ctx.hud?.items?.icon(c) ?? null })
  let prepared = false
  let fireAt = 0
  let clock = 0
  /** Name-tag "Splat!" lines to clear: view id -> server ms. */
  const splatLabels = new Map<number, number>()
  /** Yeti sounds due at a server ms. */
  const due: { at: number; file: string; pos: Vec3 }[] = []
  const offs: (() => void)[] = []
  const fires: Vec3[] = []
  const nearFires: Vec3[] = []
  const bodies: FrostBody[] = []

  const debug = typeof window !== 'undefined' ? (window as unknown as { __sroWinterPlay?: unknown }) : null
  if (debug) {
    debug.__sroWinterPlay = {
      get play() {
        return play
      },
      get warmth() {
        return warmth
      },
      get fx() {
        return fx?.stats() ?? null
      },
    }
  }

  const prepare = () => {
    if (prepared || !audio) return
    prepared = true
    for (const [id, make] of Object.entries(WINTER_PLAY_SYNTH)) audio.prepareSynth(id, make)
  }
  const sound = (file: string, pos: Vec3 | null, gain = 1, self = false) => {
    if (!audio) return
    prepare()
    if (!audio.bank.get(file)) return
    audio.playFile(file, pos && !self ? { bus: 'sfx', kind: 'other', pos: { x: pos[0], y: pos[1], z: pos[2] }, gain, priority: 2 } : { bus: 'sfx', kind: 'other', self: true, gain, priority: 3 })
  }
  const ensureFx = () => (fx ??= new WinterPlayFx(ctx.scene))
  const selfView = () => {
    const id = ctx.selfId()
    return id === null ? undefined : ctx.view(id)
  }

  // the winter monsters in ice (views made from now on; the feature starts before the world fills)
  offs.push(ctx.addAttachment((v: EntityView) => iceLook(v)))
  ctx.hud?.claimRequests?.(['snowball', 'winterBoard'])

  const throwBall = (ev?: KeyboardEvent) => {
    if (ev?.shiftKey) {
      if (panel.isOpen) panel.close()
      else {
        panel.open(board, selfView()?.state.name ?? null)
        ctx.send({ t: 'winterBoard' })
      }
      return
    }
    if (!play?.snowballs) {
      ctx.hud?.toast?.(t(play?.on ? 'winterPlay.snowball.noSnow' : 'winterPlay.snowball.off'), 'error')
      return
    }
    const me = selfView()
    if (!me || me.dead) return
    const tv = ctx.target()
    if (tv && tv.id !== me.id && (tv.state.kind === 'player' || tv.state.kind === 'mob') && !tv.dead) {
      ctx.send({ t: 'snowball', target: tv.id })
      return
    }
    const p = me.root.position
    const at = throwPoint(p.x, p.z, me.yaw)
    ctx.send({ t: 'snowball', x: Math.round(at.x * 100) / 100, z: Math.round(at.z * 100) / 100 })
  }
  if (ctx.keys) offs.push(ctx.keys.register({ id: 'winter.snowball', keys: ['b'], label: 'winterPlay.snowball.key', group: 'combat', run: (ev) => throwBall(ev) }))

  const setPlay = (p: WinterPlayState) => {
    const was = play?.on ?? false
    play = p
    fires.length = 0
    if (p.on && p.fires) fires.push(...p.fires)
    const shops = ctx.app?.catalog?.content?.shops
    if (shops) setWinterShopTab(shops, p.on)
    if (p.on !== was) ctx.chat?.add('system', t(p.on ? 'winterPlay.on' : 'winterPlay.off'))
    if (p.on) {
      prepare()
      hud ??= new WarmthHud(layer)
    } else {
      warmth = null
      level = null
      hud?.update(false, null, ctx.serverNow())
    }
  }

  const onWarmth = (w: WarmthState) => {
    warmth = w
    hud ??= new WarmthHud(layer)
    const next = w.safe ? 'warm' : w.level
    const key = warningFor(level, next)
    if (key) ctx.chat?.add('system', t(key))
    if (next === 'freezing' && level !== 'freezing' && level !== null) sound('synth/wp_shiver', null, 0.8, true)
    level = next
    if (w.drained) ctx.chat?.add('system', t('winterPlay.drained', { hp: w.drained }))
  }

  const splatOn = (id: number, now: number) => {
    const v = ctx.view(id)
    if (!v) return
    v.setLabelLine('winter-splat', t('winterPlay.splat'))
    splatLabels.set(id, now + SPLAT_LABEL_MS)
    if (id === ctx.selfId()) hud?.splashed()
  }

  return {
    onMessage(msg) {
      const now = ctx.serverNow()
      switch (msg.t) {
        case 'worldEnter':
          play = null
          warmth = null
          level = null
          fires.length = 0
          fx?.clear()
          splatLabels.clear()
          due.length = 0
          panel.close()
          hud?.update(false, null, now)
          return
        case 'winterPlay':
          return setPlay(msg.play)
        case 'warmth':
          return onWarmth(msg.warmth)
        case 'snowball': {
          ensureFx().addFlight({ id: msg.id, from: msg.fromPos, to: msg.to, at: msg.at, ms: msg.ms, peakM: msg.peakM, big: !!msg.big })
          const v = ctx.view(msg.from)
          if (v && v.state.kind === 'player') {
            v.face(msg.to[0], msg.to[2])
            if (v.actor?.group('TROW')) v.attack(msg.target !== undefined ? ctx.view(msg.target) : undefined, 1, now, { clip: 'TROW' })
          }
          sound('synth/wp_throw', msg.fromPos, msg.big ? 1 : 0.7, msg.from === ctx.selfId())
          return
        }
        case 'snowballSplat': {
          ensureFx().addSplat(msg.id, msg.pos, now)
          sound('synth/wp_splat', msg.pos, 0.9)
          if (msg.hit !== undefined) {
            const v = ctx.view(msg.hit)
            if (v?.state.kind === 'player') splatOn(msg.hit, now)
            else v?.hurt()
          }
          if (msg.score !== undefined) ctx.hud?.toast?.(t('winterPlay.score', { n: msg.score }), 'info')
          return
        }
        case 'winterBoard':
          board = msg.board
          if (panel.isOpen) panel.open(board, selfView()?.state.name ?? null)
          return
        case 'giftOpened':
          gift.show(msg.rewards, msg.gold, !!msg.rare)
          sound('synth/wp_gift', null, 0.9, true)
          return
        case 'yetiSkill': {
          ensureFx().addTelegraph({ id: msg.id, skill: msg.skill, pos: msg.pos, yaw: msg.yaw, radiusM: msg.radiusM, angleDeg: msg.angleDeg ?? 360, start: msg.at - msg.castMs, at: msg.at })
          const v = ctx.view(msg.id)
          v?.attack(undefined, 1, now, { clip: YETI_CLIPS[msg.skill] })
          const file = YETI_SOUNDS[msg.skill]
          if (file) due.push({ at: msg.skill === 'roar' ? msg.at - msg.castMs : msg.at, file, pos: msg.pos })
          return
        }
        case 'uniqueNotice':
          if (msg.mob === WINTER_CODES.yeti && msg.event === 'appeared' && msg.roar) sound('synth/wp_roar', null, 1, true)
          return
      }
    },

    onFrame(now, dt) {
      clock += Math.max(0, dt)
      const me = selfView()
      hud?.update(!!play?.on, warmth, now, me?.dead ?? false)
      for (const [id, until] of splatLabels) {
        if (now < until) continue
        splatLabels.delete(id)
        ctx.view(id)?.setLabelLine('winter-splat', null)
      }
      for (let i = due.length - 1; i >= 0; i--) {
        if (now < due[i]!.at) continue
        const d = due.splice(i, 1)[0]!
        sound(d.file, d.pos, 1)
      }
      const cam = ctx.camera.position
      // the winter monsters near the camera, and the campfires in view
      bodies.length = 0
      for (const v of ctx.views()) {
        if (v.state.kind !== 'mob' || v.dead || !isWinterMob(v.state.model)) continue
        const p = v.root.position
        if (Math.hypot(p.x - cam.x, p.z - cam.z) > FROST_VIEW_M) continue
        const h = v.height
        bodies.push({ id: v.id, x: p.x, y: p.y, z: p.z, r: Math.max(0.5, h * 0.3), h, big: v.state.model === WINTER_CODES.yeti })
      }
      nearFires.length = 0
      for (const f of fires) if (Math.hypot(f[0] - cam.x, f[2] - cam.z) <= FIRE_VIEW_M) nearFires.push(f)
      nearFires.sort((a, b) => Math.hypot(a[0] - cam.x, a[2] - cam.z) - Math.hypot(b[0] - cam.x, b[2] - cam.z))
      if (!fx && bodies.length === 0 && nearFires.length === 0) return
      const ground = ctx.world()
      ensureFx().update(now, ctx.scene.activeCamera, bodies, nearFires, (x, z, y) => ground?.heightAt(x, z, y) ?? y)
      // a crackle now and then by the nearest fire
      const at = me?.root.position
      const near = at ? nearFires.find((f) => Math.hypot(f[0] - at.x, f[2] - at.z) <= FIRE_HEAR_M) : undefined
      if (near && clock >= fireAt) {
        fireAt = clock + FIRE_EVERY_S
        sound('synth/wp_fire', near, 0.7)
      }
    },

    escape() {
      if (!panel.isOpen) return false
      panel.close()
      return true
    },

    dispose() {
      for (const off of offs.splice(0)) off()
      fx?.dispose()
      fx = null
      hud?.dispose()
      hud = null
      gift.dispose()
      panel.dispose()
      for (const id of splatLabels.keys()) ctx.view(id)?.setLabelLine('winter-splat', null)
      splatLabels.clear()
      due.length = 0
      const shops = ctx.app?.catalog?.content?.shops
      if (shops) setWinterShopTab(shops, false)
      if (debug) delete debug.__sroWinterPlay
    },
  }
}
