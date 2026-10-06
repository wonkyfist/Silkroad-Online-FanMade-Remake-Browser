/**
 * Siege of Jangan, layer 4 on the client (docs/SIEGE.md §9.2, §9.3, §9.5): the siege event.
 *
 * - **The HUD** (hud/siege-hud.ts): while a siege runs (and a minute after it ends) the panel under the minimap shows
 *   the phase, the timer to the next wave (or the end), the Town Bell's HP, the Warlord's HP in the last wave and, while
 *   he is in view, where he is; the 33 wall segments as pips coloured by stage (from `walls` / `wallUpdate`), the
 *   defenders, foes and breaches (`siegeEvent`). It folds to one line and two slim bars; the quest tracker under it
 *   moves down while it is open.
 * - **Banners** (`siegeNotice`) on the one NoticeBanner queue: the warning with the approaches, each wave, a breach, a
 *   keg planted / defused / blown, the end. The warning also rings the temple bell three times and starts the town's
 *   alarm (the town feature's 60 s alarm), the server's `[Siege]` chat lines tell the rest.
 * - **The Town Bell**: the siege's Bell mob (no model of its own) is drawn as a bronze bell in a timber frame on a stone
 *   plinth (world/siege/props.ts); it swings when it is hit; its label says a defender's hit repairs it.
 * - **The army**: sappers carry a keg on their back; every siege monster's label says "Siege army". Rams, raiders and
 *   archers are retail models (the rams Stone Ghost giants).
 * - **The Warlord** (world/siege/warlord.ts): a Bandit at 220 % in blackened, crimson armour with a gold edge (the
 *   ice-look plugin with his own ramp), a war banner on his back, a turning ring at his feet, a red beacon over him from
 *   afar, a boss name plate ("Leader of the siege army", the HP bar always shown) and a gold-ringed red dot on the
 *   minimap. The final assault opens with his war horn (a retail war cry pitched down, twice, and a shout); his roar
 *   sounds where he first comes into view.
 * - **Kegs** (`keg` / `kegEnd`): a keg prop at the foot of the wall with its fuse's sparks; within 3 m a prompt over the
 *   hotbar offers Defuse (`kegDefuse`) and shows the progress; a blast plays the fireball, the smoke, a flash and
 *   `common/explode_bomb1` (or stone_bomb).
 * - **The reward window** (`siegeReward`): won / lost, your points and rank, the gold, Seals and title paid, the top
 *   defenders.
 * - **Minimap**: the Bell (a gold dot) and burning kegs (blinking orange) while the siege runs.
 * - Debug: `window.__sroSiege` (view, kegs, segments, the army in view, a GM command, the camera, open the reward window).
 */
import { Vector3 } from '@babylonjs/core'
import { SIEGE_EVENT_CODES, type ServerMessage, type SiegeRewardView, type SiegeView, type WallStage } from '@sro/shared'
import { gameAudio } from '../../audio/index.ts'
import { KegPrompt, SiegeHud, SiegeRewardWindow } from '../../hud/siege-hud.ts'
import { inWorld } from '../../hud/unique-notice.ts'
import { t, type StringKey } from '../../i18n/index.ts'
import type { EntityAttachment, EntityView } from '../entities.ts'
import type { HudMarker, HudMinimap } from '../jangan/minimap.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { blastFx, buildBell, buildKeg, fuseSparks, type BellProp, type KegProp, type PropPath } from '../siege/props.ts'
import { fmtClock, kegInReach, noticeText, pipLook, pipOrder, rewardLines, siegeClock, siegeLines, siegeMeta, trackerShift, wallText, warlordWhere, type KegState } from '../siege/model.ts'
import { buildWarlordGear, WARLORD_LOOK, type WarlordGear } from '../siege/warlord.ts'
import { lookAttachment } from '../winter/ice-look.ts'

/** The HUD stays this long after the end (ms). */
const AFTER_END_MS = 60_000
/** HUD refresh (s). */
const HUD_EVERY_S = 0.25
/** A keg within this reach offers Defuse (m; the server allows 3). */
const KEG_REACH_M = 2.8
/** Sound files (the sound export's ids). */
const BELL_FILE = 'env/bell towel 3'
const BLAST_FILES = ['common/explode_bomb1', 'common/stone_bomb']
/** The temple bell's three strokes at the warning (s apart). */
const TOLL_S = 2.4
/**
 * The Warlord's war horn at the final assault: a retail war cry pitched down (twice) and a Bandit's shout, [file,
 * rate, gain, delay s]; his roar where he comes into view.
 */
const HORN: readonly (readonly [string, number, number, number])[] = [
  ['monster/wcm_eking_waveshout_a', 0.5, 1, 0],
  ['monster/wcm_eking_waveshout_a', 0.45, 0.9, 1.25],
  ['monster/cm_bandit_shout_a', 0.62, 1, 2.6],
]
const ROAR: readonly [string, number] = ['monster/cm_bandit_shout_b', 0.58]
/** Sounds wait this long for their buffer (ms; the horn's files are not preloaded). */
const SOUND_WAIT_MS = 2500

interface Keg extends KegState {
  prop: KegProp | null
  sparks: { dispose(): void } | null
}

export function siegeFeature(ctx: WorldFeatureContext): WorldFeature {
  if (!ctx.session) return {}
  const { app } = ctx
  let view: SiegeView | null = null
  let hideAt = 0
  const segs = new Map<string, { stage: WallStage; pct: number }>()
  const kegs = new Map<number, Keg>()
  let hudT = 0
  let minimap: HudMinimap | null = null
  let offMarkers: (() => void) | null = null
  let lastReward: SiegeRewardView | null = null
  /** The Warlord's view while he is in view (the HUD says where he is). */
  let lord: EntityView | null = null
  /** The quest tracker this panel pushed down (its margin is reset when the panel closes). */
  let pushed: HTMLElement | null = null
  const offs: (() => void)[] = []

  const hud = new SiegeHud()
  const prompt = new KegPrompt(app.art, () => {
    const k = nearKeg()
    if (k) ctx.send({ t: 'kegDefuse', id: k.id })
  })
  const reward = new SiegeRewardWindow(app.art)
  ctx.hud.layer.append(hud.root, prompt.root, reward.root)
  ctx.hud.claimRequests(['kegDefuse'])

  const selfView = (): EntityView | undefined => {
    const id = ctx.selfId()
    return id === null ? undefined : ctx.view(id)
  }

  const nearKeg = (): Keg | null => {
    const me = selfView()
    if (!me || me.dead) return null
    return kegInReach(kegs.values(), me.pos.x, me.pos.z, KEG_REACH_M) as Keg | null
  }

  /** The world's material path (PBR or Classic), for the props' materials. */
  const path = (): PropPath => {
    try {
      return ctx.world()?.world.materials.mode === 'pbr' ? 'pbr' : 'classic'
    } catch {
      return 'classic'
    }
  }

  const honorText = (code: string): string => {
    const key = `pilot.honor.${code}` as StringKey
    const s = t(key)
    return s === key ? code : s
  }

  // ---- sounds --------------------------------------------------------------------------------------------------
  const play = (file: string, pos: { x: number; y: number; z: number } | null, gain = 1, rate = 1) => {
    const a = gameAudio()
    if (!a?.index?.files?.[file]) return
    if (pos) a.playFile(file, { pos, gain, rate, bus: 'sfx', kind: 'other', self: true, priority: 1, waitMs: SOUND_WAIT_MS })
    else a.playFile(file, { gain, rate, bus: 'ambient', kind: 'other', self: true, priority: 1, waitMs: SOUND_WAIT_MS })
  }
  const tolls: ReturnType<typeof setTimeout>[] = []
  const alarm = () => {
    for (let i = 0; i < 3; i++) tolls.push(setTimeout(() => play(BELL_FILE, null, 0.9), i * TOLL_S * 1000))
    const g = ctx.world()
    try {
      g?.world.townAlarm?.(ctx.serverNow() / 1000, 60)
    } catch (err) {
      console.warn('[siege] town alarm failed', err)
    }
  }
  const horn = () => {
    for (const [file, rate, gain, at] of HORN) tolls.push(setTimeout(() => play(file, null, gain, rate), at * 1000))
  }
  offs.push(() => tolls.splice(0).forEach(clearTimeout))

  // ---- the HUD ---------------------------------------------------------------------------------------------------
  const refreshHud = (now: number) => {
    const on = view !== null && (view.phase !== 'ended' || now < hideAt)
    if (!on) {
      hud.set(null, { head: '', timer: null, clock: null, meta: '' })
    } else {
      const l = siegeLines(view!, now)
      const me = selfView()
      const where = lord && !lord.dead && me ? warlordWhere(lord.pos.x - me.pos.x, lord.pos.z - me.pos.z) : null
      hud.set(view, { ...l, clock: siegeClock(view!, now), meta: siegeMeta(view!), where })
      hud.setPips(
        pipOrder(segs.keys()).map((id) => {
          const s = segs.get(id)!
          return { id, look: pipLook(s.stage, s.pct), title: `${wallText(id)}: ${t(`wall.stage.${s.stage}` as StringKey)} ${Math.round(s.pct)}%` }
        }),
      )
    }
    placeTracker(on)
    // the keg prompt
    const k = nearKeg()
    if (!k) prompt.set(null, fmtClock)
    else {
      const mine = k.defuse && k.defuse.by === ctx.selfId()
      const frac = mine ? 1 - (k.defuse!.endsAt - now) / 3000 : 0
      prompt.set({ fuseMs: k.fuseEndsAt - now, defuse: mine ? { frac, leftMs: k.defuse!.endsAt - now } : null }, fmtClock)
    }
  }

  /** Moves the quest tracker (same column, top 262) below the open panel; puts it back when the panel closes. */
  const placeTracker = (open: boolean) => {
    const qt = ctx.hud.layer.querySelector<HTMLElement>('.quest-tracker')
    if (pushed && pushed !== qt) {
      pushed.style.marginTop = ''
      pushed = null
    }
    if (!qt) return
    let want = ''
    if (open && !qt.hidden) {
      const px = trackerShift(hud.root.offsetTop + hud.root.offsetHeight, parseFloat(getComputedStyle(qt).top))
      if (px > 0) want = `${px}px`
    }
    if (qt.style.marginTop !== want) qt.style.marginTop = want
    pushed = want ? qt : null
  }
  offs.push(() => {
    if (pushed) pushed.style.marginTop = ''
    pushed = null
  })

  // ---- kegs ------------------------------------------------------------------------------------------------------
  const putKeg = (m: Extract<ServerMessage, { t: 'keg' }>) => {
    let k = kegs.get(m.id)
    if (!k) {
      k = { id: m.id, seg: m.seg, x: m.x, y: m.y, z: m.z, fuseEndsAt: m.fuseEndsAt, defuse: m.defuse ?? null, prop: null, sparks: null }
      kegs.set(m.id, k)
      try {
        const prop = buildKeg(ctx.scene, `siegeKeg${m.id}`, path())
        const g = ctx.world()
        const y = g ? g.heightAt(m.x, m.z) : m.y
        prop.root.position.set(m.x, Number.isFinite(y) ? y : m.y, m.z)
        k.prop = prop
        k.sparks = fuseSparks(ctx.scene, prop.tip)
      } catch (err) {
        console.warn('[siege] keg prop failed', err)
      }
    } else {
      k.fuseEndsAt = m.fuseEndsAt
      k.defuse = m.defuse ?? null
    }
  }
  const dropKeg = (id: number, how: 'blast' | 'defused' | 'cancelled') => {
    const k = kegs.get(id)
    if (!k) return
    kegs.delete(id)
    const at = k.prop ? k.prop.root.position.clone() : new Vector3(k.x, k.y, k.z)
    k.sparks?.dispose()
    k.prop?.dispose()
    if (how === 'blast') {
      try {
        const stop = blastFx(ctx.scene, at.add(new Vector3(0, 0.6, 0)))
        offs.push(stop)
      } catch (err) {
        console.warn('[siege] blast fx failed', err)
      }
      play(BLAST_FILES[Math.random() < 0.5 ? 0 : 1]!, { x: at.x, y: at.y + 1, z: at.z }, 1)
    }
  }
  offs.push(() => {
    for (const id of [...kegs.keys()]) dropKeg(id, 'cancelled')
  })

  // ---- the Bell and the army (per entity view) ---------------------------------------------------------------------
  const bells = new Map<number, { prop: BellProp; hp: number }>()
  offs.push(
    ctx.addAttachment((v) => {
      const role = v.state.siege
      if (v.kind !== 'mob' || !role) return null
      let bell: BellProp | null = null
      let keg: KegProp | null = null
      let ready = false
      let built = false
      // the Warlord: his paint (per mesh), his banner, ring and beacon, his name plate
      const warlord = role === 'warlord'
      const look: EntityAttachment | null = warlord ? lookAttachment(v, WARLORD_LOOK) : null
      let gear: WarlordGear | null = null
      let roared = false
      if (warlord) lord = v
      /** The props wait for the world (its material path: PBR or Classic). */
      const build = () => {
        if (built || !ctx.world()) return
        built = true
        if (role === 'bell') {
          if (v.placeholder) v.placeholder.isVisible = false
          bell = buildBell(ctx.scene, `siegeBell${v.id}`, path())
          bell.root.parent = v.root
          bells.set(v.id, { prop: bell, hp: v.state.hp ?? 0 })
        } else if (role === 'sapper') {
          const body = v.actor?.root
          if (!body) return
          keg = buildKeg(ctx.scene, `siegeBackKeg${v.id}`, path())
          keg.root.parent = body
          keg.root.scaling.setAll(0.75)
          keg.root.position.set(0, 0.95, -0.42)
          keg.root.rotation.x = -0.25
        } else if (warlord) {
          const body = v.actor?.root
          if (!body) return
          gear = buildWarlordGear(ctx.scene, `siegeWarlord${v.id}`, body, v.root, path(), (x, z) => ctx.world()?.heightAt(x, z) ?? NaN)
        }
      }
      return {
        loaded() {
          ready = true
          if (role === 'bell') {
            v.setLabelLine('siege', t('siege.label.bell'))
            if (v.placeholder) v.placeholder.isVisible = false
          } else v.setLabelLine('siege', role === 'sapper' ? t('siege.label.sapper') : warlord ? t('siege.label.warlord') : t('siege.label.army'))
          if (warlord) {
            v.setLabelClass('siege-warlord', true)
            look!.loaded?.()
            if (!roared && !v.dead) {
              roared = true
              play(ROAR[0], { x: v.pos.x, y: v.pos.y + 3, z: v.pos.z }, 1, ROAR[1])
            }
          }
          build()
        },
        update(now, dt) {
          if (ready && !built) build()
          if (look) {
            look.update?.(now, dt)
            const cam = ctx.scene.activeCamera?.globalPosition
            gear?.update(performance.now() / 1000, dt, cam ? Math.hypot(cam.x - v.pos.x, cam.z - v.pos.z) : 0, !v.dead)
          }
          if (!bell) return
          const b = bells.get(v.id)
          const hp = v.state.hp ?? 0
          if (b && hp < b.hp) bell.hit(Math.min(0.12, 0.02 + ((b.hp - hp) / Math.max(1, v.state.maxHp ?? 1)) * 8))
          if (b) b.hp = hp
          bell.update(dt)
        },
        dispose() {
          bell?.dispose()
          keg?.dispose()
          bells.delete(v.id)
          look?.dispose()
          gear?.dispose()
          if (lord === v) lord = null
        },
      }
    }),
  )

  // ---- the minimap ---------------------------------------------------------------------------------------------------
  function* markers(): Iterable<HudMarker> {
    if (!view || view.phase === 'ended') return
    for (const v of ctx.views()) if (v.kind === 'mob' && v.state.model === SIEGE_EVENT_CODES.bell && !v.dead) yield { x: v.pos.x, z: v.pos.z, color: '#ffd953', size: 4 }
    // the Warlord: a red dot in a gold ring
    if (lord && !lord.dead) {
      yield { x: lord.pos.x, z: lord.pos.z, color: '#ffc94a', size: 6 }
      yield { x: lord.pos.x, z: lord.pos.z, color: '#e0201a', size: 4.2 }
    }
    const blink = Math.floor(performance.now() / 350) % 2 === 0
    if (blink) for (const k of kegs.values()) yield { x: k.x, z: k.z, color: '#ff7a2a', size: 3.5 }
  }
  offs.push(() => offMarkers?.())

  // ---- debug ---------------------------------------------------------------------------------------------------------
  const debug = {
    view: () => view,
    kegs: () => [...kegs.values()].map(({ prop: _p, sparks: _s, ...k }) => k),
    segs: () => Object.fromEntries(segs),
    /** A GM command (the server checks the role): `gm('siege', 'start', '1')`. */
    gm: (cmd: string, ...args: string[]) => ctx.send({ t: 'gm', cmd, args }),
    /** The scene and the material path (lighting checks). */
    scene: () => ctx.scene,
    path: () => path(),
    /** The server clock as this client sees it, and the local one. */
    clock: () => ({ server: ctx.serverNow(), local: Date.now() }),
    /** Attack entity `id` (the ordinary attack request). */
    attack: (id: number) => ctx.send({ t: 'attack', target: id }),
    /** Where the own character stands. */
    self: () => {
      const v = selfView()
      return v ? { id: v.id, x: v.pos.x, y: v.pos.y, z: v.pos.z, hp: v.state.hp } : null
    },
    /** The orbit camera around the own character (radians, metres); absent values stay. */
    camera: (alpha?: number, beta?: number, radius?: number) => {
      const c = ctx.camera
      if (alpha !== undefined) c.alpha = alpha
      if (beta !== undefined) c.beta = beta
      if (radius !== undefined) c.radius = radius
      return { alpha: c.alpha, beta: c.beta, radius: c.radius }
    },
    /** Siege monsters in view: role, mode-less (the client has no mode), position. */
    army: () => [...ctx.views()].filter((v) => v.kind === 'mob' && v.state.siege).map((v) => ({ id: v.id, role: v.state.siege, x: Math.round(v.pos.x), z: Math.round(v.pos.z), hp: v.state.hp })),
    /** The Warlord in view: where, how tall, his label's classes. */
    warlord: () => (lord ? { id: lord.id, x: lord.pos.x, y: lord.pos.y, z: lord.pos.z, height: lord.height, scale: lord.scale } : null),
    /** The Warlord's paint (live: the plugin reads it every draw, so a console edit shows at once). */
    look: WARLORD_LOOK,
    /** Fold (true) or open (false) the panel. */
    fold: (on: boolean) => hud.setFolded(on),
    /** The war horn of the final assault. */
    horn: () => horn(),
    reward: (r?: SiegeRewardView) => showReward(r ?? lastReward ?? { event: 0, outcome: 'won', points: 412, rank: 1, of: 9, gold: 20_600, seals: 8, title: 'jangan_defender', top: [{ name: 'Aki', points: 412 }, { name: 'Mei', points: 260 }, { name: 'Ryu', points: 133 }], parts: { damage: 352, defuse: 30, bell: 30 } }),
  }
  if (typeof window !== 'undefined') (window as unknown as { __sroSiege?: unknown }).__sroSiege = debug
  offs.push(() => {
    const w = typeof window !== 'undefined' ? (window as unknown as { __sroSiege?: unknown }) : null
    if (w && w.__sroSiege === debug) delete w.__sroSiege
  })

  const showReward = (r: SiegeRewardView) => {
    lastReward = r
    const l = rewardLines(r, honorText)
    const me = selfView()?.state.name ?? ''
    reward.show({ head: l.head, kind: r.outcome === 'won' ? 'won' : r.outcome === 'lost_bell' || r.outcome === 'lost_time' ? 'lost' : 'over', lines: l.lines, parts: l.parts, top: r.top.map((x) => ({ ...x, me: x.name === me })) })
  }

  return {
    onMessage(msg) {
      switch (msg.t) {
        case 'siegeEvent':
          view = msg.view
          if (view.phase === 'ended' && !hideAt) hideAt = ctx.serverNow() + AFTER_END_MS
          if (view.phase !== 'ended') hideAt = 0
          refreshHud(ctx.serverNow())
          break
        case 'siegeNotice': {
          const text = noticeText(msg)
          if (msg.event === 'phase' && msg.phase === 'warning') alarm()
          if (msg.event === 'phase' && msg.phase === 'wave3') horn()
          if (text) app.notices.show(text, { kind: 'unique', title: t('siege.title'), live: inWorld, ms: msg.event === 'phase' ? 8000 : 6000 })
          break
        }
        case 'siegeReward':
          showReward(msg.reward)
          break
        case 'keg':
          putKeg(msg)
          break
        case 'kegEnd':
          dropKeg(msg.id, msg.how)
          break
        case 'walls':
          for (const s of msg.segs) segs.set(s.id, { stage: s.stage, pct: s.pct })
          break
        case 'wallUpdate':
          segs.set(msg.id, { stage: msg.stage, pct: msg.pct })
          break
        case 'worldLeft':
          view = null
          break
      }
    },

    escape() {
      if (reward.isOpen) {
        reward.close()
        return true
      }
      return false
    },

    onFrame(now, dt) {
      const m = ctx.minimap()
      if (m && m !== minimap) {
        offMarkers?.()
        minimap = m
        offMarkers = m.addMarkerSource(markers)
      }
      hudT -= dt
      if (hudT > 0) return
      hudT = HUD_EVERY_S
      refreshHud(now)
    },

    dispose() {
      for (const off of offs.splice(0)) {
        try {
          off()
        } catch (err) {
          console.warn('[siege] dispose step failed', err)
        }
      }
      hud.root.remove()
      prompt.root.remove()
      reward.root.remove()
    },
  }
}
