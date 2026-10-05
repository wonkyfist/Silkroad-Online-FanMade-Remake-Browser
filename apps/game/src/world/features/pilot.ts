/**
 * Play the Boss, the client (docs/PLAY_THE_BOSS.md §4; layers 1–3): a player steers Tiger Girl, everyone else hunts her.
 *
 * The pilot (after `pilotStart`): the world screen's focus moves to her (`ctx.setControlled`: camera, streaming,
 * minimap, music; the camera zooms out 1.5×), the KeyMover walks her (WASD) and ground clicks move her (both send the
 * usual `moveTo`, the server steers her), a click on a hunter targets him and starts auto-claw (`pilotAct claw repeat`),
 * keys 1–7 use her kit on the target (Pounce: the target, else the ground under the cursor), hold Q opens the taunt
 * wheel (release over a line sends `pilotTaunt`), Esc menu "Leave the hunt" (confirm) sends `pilotQuit`. The HUD:
 * the boss frame, the SURVIVE / HUNTERS DOWNED / HUNTING YOU strip, the kit bar with cooldown sweeps and charges,
 * the steering line, the minimap showing hunters only inside her sense ring; `pilotEnd` ends it with a result window.
 *
 * Everyone: `huntEvent` drives the hunters' banner (sighted, next sighting, she wins in, hunters) and, when it ends,
 * the result banner on the NoticeBanner queue (kind 'unique') naming the pilot; `huntPing` a "Last sighting" circle
 * on the minimap fading over 60 s; `huntTrail` paw prints fading over 90 s; `huntRoar` her roar from that direction;
 * `huntTaunt` a bubble over her and a chat line. Entities: `trance` (sit, aura, "In a trance"), `piloted` ("steered by
 * a player"), `honor` (the title line). The offer (`pilotOffer`): a dialog with the rules, Accept / Decline.
 *
 * The call (layer 4, §4.5): while `huntEvent` is in phase 'call', the call banner asks "who will become Tiger Girl?"
 * with the draw countdown, the volunteers and the level; **Volunteer** / **Not this time** send `pilotVolunteer {on}`
 * (Not this time withdraws a volunteer, else hides the banner for that call), or it shows why this character cannot
 * volunteer (`you.why`). Chat lines at the open and 5 min and 1 min before the draw; "Drawing a volunteer…" after it.
 */
import { PILOT_DEFAULTS, PILOT_TAUNT_LINES, type HuntEventView, type ServerMessage } from '@sro/shared'
import { actionFailText } from '../../hud/index.ts'
import { registerMenuItem } from '../../hud/menu-items.ts'
import { BossFrame, boldTime, CallBanner, HuntBanner, HuntStrip, KitBar, PilotDialog, SteeringLine, TauntWheel } from '../../hud/pilot-hud.ts'
import { ensurePilotStyles } from '../../hud/pilot-style.ts'
import { inWorld, UNIQUE_ROARS } from '../../hud/unique-notice.ts'
import { t, type StringKey } from '../../i18n/index.ts'
import { MessageBox } from '../../ui/kit/dialog.ts'
import type { EntityView } from '../entities.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { idleOf } from '../idle.ts'
import type { HudMarker, HudMinimap } from '../jangan/minimap.ts'
import { PawPrints, tranceAura } from '../pilot-fx.ts'
import {
  actFor,
  callBanner,
  callChatLines,
  compassOf,
  countdown,
  fadeAt,
  formatClock,
  huntBannerShows,
  huntEndText,
  kitSlots,
  nextPingAt,
  offerLine,
  PING_FADE_S,
  pilotResult,
  roarGain,
  roarPan,
  sensed,
  steeringLine,
  type PilotOfferMessage,
  type PilotStartMessage,
  type PilotStateMessage,
} from '../pilot-model.ts'
import { HELD_STATUSES } from './movement.ts'

/** Her mob code (the hunt is hers in v1; the name comes from the entity or the event). */
const TIGER = 'MOB_CH_TIGERWOMAN'
/** The camera pulls back this much while piloting (she is 3 m tall and 7 m long, §4.2). */
export const PILOT_ZOOM = 1.5
/** A taunt bubble stays this long (ms). */
const BUBBLE_MS = 5000
/** Same-hunter claw clicks closer than this are not re-sent (the server repeats the claw anyway). */
const CLAW_RESEND_MS = 400
/** The HUD's text parts are refreshed this often (s); the HP bar every frame. */
const HUD_EVERY_S = 0.2
/** Refusals of pilot requests that stay silent (the HUD already shows why, or a mashed key). */
const QUIET = new Set(['rate_limited', 'busy', 'cooldown', 'cant_act'])

/** "palace-steps" -> "palace steps" (the place's name as the trance line shows it). */
export function placeName(place: string): string {
  return place.replace(/[-_]+/g, ' ').trim() || place
}

export function pilotFeature(ctx: WorldFeatureContext): WorldFeature {
  const { hud, chat, app } = ctx
  const art = app.art
  ensurePilotStyles()
  const offs: (() => void)[] = []

  // ---- state ---------------------------------------------------------------------------------------------------
  let pilot: (PilotStartMessage & { startedAt: number }) | null = null
  let state: PilotStateMessage | null = null
  /** Server ms her current action ends (her `cast`); her held statuses by instance. */
  let busyUntil = 0
  const held = new Set<number>()
  let saved: { radius: number; upper: number } | null = null
  let lastClaw = { id: -1, at: -Infinity }
  let huntEv: HuntEventView | null = null
  /** Server ms the current event entered 'hunt' on this client (the first sighting's clock). */
  let huntSeenAt: number | null = null
  /** Phases seen per event id (a result banner only for an event seen running in this visit). */
  const phases = new Map<number, string>()
  let lastPing: { x: number; z: number; r: number; at: number } | null = null
  let pingSec = PILOT_DEFAULTS.hunt.pingSec
  let offer: PilotOfferMessage | null = null
  let pointer = { x: typeof window !== 'undefined' ? window.innerWidth / 2 : 512, y: typeof window !== 'undefined' ? window.innerHeight / 2 : 384 }
  let hudT = 0
  const bubbles = new Map<number, ReturnType<typeof setTimeout>>()
  /** The call (layer 4): calls hidden with Not this time, the chat lines said per call, the last toggle sent. */
  const callHidden = new Set<number>()
  const callChat = new Map<number, Set<string>>()
  let volunteerSent: boolean | null = null

  const selfView = (): EntityView | undefined => {
    const id = ctx.selfId()
    return id === null ? undefined : ctx.view(id)
  }
  const her = (): EntityView | undefined => (pilot ? ctx.view(pilot.mob) : undefined)
  const bossName = (): string => her()?.state.name || huntEv?.name || app.catalog.content.mobs.get(TIGER)?.name || 'Tiger Girl'
  const busy = (now: number): boolean => now < busyUntil || held.size > 0

  // ---- HUD ----------------------------------------------------------------------------------------------------
  const boss = new BossFrame(art)
  const strip = new HuntStrip()
  const kitBar = new KitBar(id => use(id, 'click'))
  const steer = new SteeringLine()
  const wheel = new TauntWheel(PILOT_TAUNT_LINES, line => {
    if (pilot) ctx.send({ t: 'pilotTaunt', line })
  })
  const result = new PilotDialog(art, 'pl-result')
  const offerDlg = new PilotDialog(art, 'pl-offer')
  const banner = new HuntBanner()
  const volunteer = (on: boolean) => {
    if (ctx.send({ t: 'pilotVolunteer', on })) volunteerSent = on
  }
  const callBar = new CallBanner(
    art,
    () => volunteer(true),
    () => {
      // Not this time: a volunteer withdraws; anyone else just hides this call's banner.
      if (huntEv?.you?.volunteered) volunteer(false)
      else if (huntEv) callHidden.add(huntEv.id)
      hudT = 0
    },
  )
  const pieces = [boss.root, strip.root, steer.stalk, steer.root, kitBar.root, banner.root, callBar.root, wheel.root, result.root, offerDlg.root]
  hud.layer.append(...pieces)
  offs.push(() => {
    for (const p of pieces) p.remove()
  })
  const showPilotHud = (on: boolean) => {
    boss.root.hidden = !on
    strip.root.hidden = !on
    kitBar.root.hidden = !on
    if (!on) {
      steer.set(null, false)
      steer.stalk.hidden = true
      wheel.cancel()
    }
    if (typeof document !== 'undefined') document.body.classList.toggle('pilot-on', on)
  }

  // ---- the world: paw prints, the trance aura -------------------------------------------------------------------
  const groundY = (x: number, z: number): number => {
    const g = ctx.world()
    const y = (her() ?? selfView())?.pos.y
    return g ? g.heightAt(x, z, y) : (y ?? 0)
  }
  const paws = new PawPrints(ctx.scene, groundY)
  offs.push(() => paws.dispose())
  offs.push(ctx.addAttachment(v => tranceAura(ctx.scene, v)))

  // ---- the pilot's turn ---------------------------------------------------------------------------------------
  const start = (msg: PilotStartMessage) => {
    if (pilot) stop(false)
    pilot = { ...msg, startedAt: ctx.serverNow() }
    state = null
    busyUntil = 0
    held.clear()
    lastClaw = { id: -1, at: -Infinity }
    ctx.setControlled?.({
      id: msg.mob,
      // Her composite focus (the rider sits ~3 m up on the tiger), not a player's chest height.
      focusHeight: v => Math.max(v.focusHeight, v.height * 0.6),
      // The pilot sees hunters only inside her sense ring (the feature's own red dots).
      onMinimap: v => v.kind !== 'player',
    })
    ctx.setTarget(null)
    const cam = ctx.camera
    if (cam && !saved) {
      saved = { radius: cam.radius, upper: cam.upperRadiusLimit ?? 40 }
      cam.upperRadiusLimit = saved.upper * PILOT_ZOOM
      cam.radius = Math.min(cam.upperRadiusLimit, cam.radius * PILOT_ZOOM)
    }
    kitBar.build(msg.kit)
    boss.setNames(bossName(), selfView()?.state.name ?? '')
    boss.setEnraged(false)
    result.hide()
    hideOffer()
    banner.set(null)
    showPilotHud(true)
    hudT = 0
    chat.add('system', t('pilot.hud.trance', { place: placeName(msg.place) }))
    chat.add('system', t('pilot.hud.start', { name: bossName() }))
  }

  /** The turn ends (`pilotEnd`, a new world, the screen): the focus, the camera and the HUD go back. */
  const stop = (restoreTarget = true) => {
    if (!pilot) return
    pilot = null
    state = null
    held.clear()
    busyUntil = 0
    ctx.setControlled?.(null)
    const cam = ctx.camera
    if (cam && saved) {
      cam.upperRadiusLimit = saved.upper
      cam.radius = Math.min(saved.upper, saved.radius)
    }
    saved = null
    showPilotHud(false)
    if (restoreTarget) ctx.setTarget(null)
  }

  const showResult = (msg: Extract<ServerMessage, { t: 'pilotEnd' }>) => {
    const r = pilotResult(msg)
    const name = bossName()
    const head = r.forfeit
      ? t('pilot.result.forfeit')
      : r.reason === 'cancelled'
        ? t('pilot.result.cancelled')
        : r.won
          ? r.reason === 'downs'
            ? t('pilot.result.wonDowns', { downs: r.downs ?? 0, name })
            : t('pilot.result.won', { name })
          : t('pilot.result.lost', { name })
    const lines: string[] = []
    if (r.downs !== null) lines.push(t('pilot.result.downs', { downs: r.downs }))
    if (r.steeredMs !== null) lines.push(t('pilot.result.time', { time: formatClock(r.steeredMs) }))
    if (r.gold > 0) lines.push(t('pilot.result.gold', { gold: r.gold.toLocaleString('en-US') }))
    if (r.honor) lines.push(t('pilot.result.honor', { title: honorText(r.honor) }))
    result.show({ cap: t('pilot.result.title'), head, name, lines, plain: true, buttons: [{ label: t('pilot.result.ok'), primary: true, run: () => result.hide() }] })
  }

  // ---- input --------------------------------------------------------------------------------------------------
  /** The selected hunter (a living player other than the own body), or null. */
  const huntTarget = (): EntityView | null => {
    const v = ctx.target()
    return v && v.kind === 'player' && !v.dead && v.id !== ctx.selfId() ? v : null
  }
  const cursorGround = (): { x: number; z: number } | null => {
    const g = ctx.world()
    const scene = ctx.scene
    if (!g || !scene || !ctx.camera) return null
    const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, null, ctx.camera)
    const nav = g.pick?.(ray)
    if (nav) return { x: nav.x, z: nav.z }
    const hit = scene.pick(scene.pointerX, scene.pointerY, m => g.isGround(m))
    return hit?.hit && hit.pickedPoint ? { x: hit.pickedPoint.x, z: hit.pickedPoint.z } : null
  }
  /** A point `m` metres ahead of her (a Pounce from the kit bar without a target: the cursor is on the bar). */
  const ahead = (m: number): { x: number; z: number } | null => {
    const v = her()
    return v ? { x: v.pos.x + Math.sin(v.yaw) * m, z: v.pos.z + Math.cos(v.yaw) * m } : null
  }
  const use = (id: string, via: 'key' | 'click') => {
    if (!pilot) return
    const k = pilot.kit.find(x => x.id === id)
    if (!k) return
    const now = ctx.serverNow()
    const s = kitSlots([k], state, now, busy(now))[0]!
    // Cooldowns and charges are known here; the AI, busy and held states are the server's to answer (an act also
    // takes her back from her AI).
    if (s.why === 'cooldown') return
    if (s.why === 'charges') return hud.toast(actionFailText('no_charges'), 'error')
    const target = huntTarget()
    const ground = k.target === 'point' && !target ? (via === 'key' ? cursorGround() : ahead(Math.min(10, k.rangeM || 10))) : null
    const msg = actFor(k, target?.id ?? null, ground)
    if (!msg) return hud.toast(t('pilot.hud.noTarget'), 'error')
    ctx.send(msg)
  }
  for (let n = 1; n <= 9; n++) {
    offs.push(
      ctx.keys.register({
        id: `pilot.slot${n}`,
        keys: [String(n)],
        label: 'pilot.keys.slot',
        group: 'combat',
        when: () => !!pilot?.kit.some(k => k.slot === n),
        run: () => {
          const k = pilot?.kit.find(x => x.slot === n)
          if (k) use(k.id, 'key')
        },
      }),
    )
  }
  offs.push(
    ctx.keys.register({
      id: 'pilot.taunt',
      keys: ['q'],
      label: 'pilot.keys.taunt',
      group: 'combat',
      when: () => !!pilot,
      run: () => wheel.open(pointer.x, pointer.y),
      up: () => wheel.close(),
    }),
  )
  if (typeof window !== 'undefined') {
    const onMove = (ev: PointerEvent) => {
      pointer = { x: ev.clientX, y: ev.clientY }
      if (wheel.isOpen) wheel.move(ev.clientX, ev.clientY)
    }
    window.addEventListener('pointermove', onMove)
    offs.push(() => window.removeEventListener('pointermove', onMove))
  }
  offs.push(
    registerMenuItem({
      id: 'pilot.quit',
      label: 'pilot.hud.quit',
      order: 75,
      when: () => !!pilot,
      run: menu => {
        menu.close()
        void MessageBox.confirm({ title: t('pilot.hud.quit'), text: t('pilot.hud.quitConfirm'), ok: t('pilot.hud.quitOk'), cancel: t('hud.dialog.cancel'), art }).then(yes => {
          if (yes && pilot) ctx.send({ t: 'pilotQuit' })
        })
      },
    }),
  )

  // ---- the offer ----------------------------------------------------------------------------------------------
  const hideOffer = () => {
    offer = null
    offerDlg.hide()
  }
  const answer = (accept: boolean) => {
    if (offer) ctx.send({ t: 'pilotAnswer', event: offer.event, accept })
    hideOffer()
  }
  const showOffer = (m: PilotOfferMessage) => {
    offer = m
    const name = bossName()
    offerDlg.show({
      cap: t('pilot.offer.title'),
      head: t('pilot.offer.question', { name }),
      name,
      lines: [
        t('pilot.offer.ruleTrance'),
        t('pilot.offer.ruleStats'),
        t('pilot.offer.ruleWin', { time: formatClock(m.surviveMin * 60_000), downs: m.downsTarget }),
        t('pilot.offer.ruleIdle', { idle: m.idleSec }),
      ],
      buttons: [
        { label: t('pilot.offer.accept'), primary: true, run: () => answer(true) },
        { label: t('pilot.offer.decline'), run: () => answer(false) },
      ],
      foot: boldTime(t('pilot.offer.timer'), formatClock(m.expiresAt - ctx.serverNow())),
    })
  }

  // ---- hunters ------------------------------------------------------------------------------------------------
  const onHuntEvent = (ev: HuntEventView) => {
    const before = phases.get(ev.id)
    phases.set(ev.id, ev.phase)
    if (ev.phase === 'hunt' && (huntEv?.id !== ev.id || huntEv.phase !== 'hunt')) {
      huntSeenAt = ctx.serverNow()
      lastPing = null
    }
    huntEv = ev
    if (offer && ev.id === offer.event && ev.phase !== 'offer') hideOffer()
    if (ev.phase !== 'ended') return
    lastPing = null
    paws.clear()
    // The result for everyone, only for an event seen running here (not a stale one on entering the world).
    if (!before || before === 'ended') return
    const text = huntEndText(ev, ev.name || bossName())
    if (!text) return
    chat.add('notice', t('hunt.end.chat', { text }))
    app.notices.show(text, { kind: 'unique', title: t('hunt.end.title'), name: ev.name || bossName(), live: inWorld, onShow: () => app.audio?.ui('ui.uniqueDown') })
  }

  const onRoar = (m: Extract<ServerMessage, { t: 'huntRoar' }>) => {
    if (pilot) return
    const cam = ctx.camera
    const pan = cam ? roarPan(m.bearing, cam.target.x - cam.position.x, cam.target.z - cam.position.z) : 0
    const file = UNIQUE_ROARS[huntEv?.mob ?? TIGER] ?? UNIQUE_ROARS[TIGER]
    if (file) app.audio?.playFile(file, { self: true, bus: 'sfx', gain: roarGain(m.distM), pan, waitMs: 1500 })
    hud.toast(t('hunt.roar', { dir: t(`hunt.dir.${compassOf(m.bearing)}` as StringKey) }))
  }

  const onTaunt = (m: Extract<ServerMessage, { t: 'huntTaunt' }>) => {
    const key = `pilot.taunt.${m.line}` as StringKey
    const line = t(key)
    if (line === key) return
    const v = ctx.view(m.id)
    if (v) {
      v.setBadge('bubble', line, 'chat-bubble')
      clearTimeout(bubbles.get(m.id))
      bubbles.set(
        m.id,
        setTimeout(() => {
          bubbles.delete(m.id)
          ctx.view(m.id)?.setBadge('bubble', null)
        }, BUBBLE_MS),
      )
    }
    chat.add('local', t('pilot.taunt.chat', { name: v?.state.name || bossName(), line }))
  }
  offs.push(() => {
    for (const tm of bubbles.values()) clearTimeout(tm)
    bubbles.clear()
  })

  // ---- entity flags -------------------------------------------------------------------------------------------
  const honorText = (code: string): string => {
    const key = `pilot.honor.${code}` as StringKey
    const s = t(key)
    return s === key ? code : s
  }
  const applyFlags = (v: EntityView, transition: boolean) => {
    const s = v.state
    if (v.kind === 'player') {
      v.setLabelLine('trance', s.trance ? t('hunt.trance') : null)
      idleOf(v)?.setReason('sit', !!s.trance || s.posture === 'sit', transition ? 'play' : undefined)
      v.setLabelLine('honor', s.honor ? honorText(s.honor) : null)
    }
    if (v.kind === 'mob') v.setLabelLine('piloted', s.piloted ? t('hunt.steered') : null)
  }

  // ---- minimap ------------------------------------------------------------------------------------------------
  let minimap: HudMinimap | null = null
  let offMarkers: (() => void) | null = null
  function* markers(): Iterable<HudMarker> {
    const now = ctx.serverNow()
    if (pilot) {
      const v = her()
      if (!v) return
      yield { x: v.pos.x, z: v.pos.z, radius: pilot.senseM, color: 'rgba(255,140,90,0.6)' }
      const self = ctx.selfId()
      for (const h of sensed(ctx.views(), v.pos.x, v.pos.z, pilot.senseM, x => x.id === self)) yield { x: h.pos.x, z: h.pos.z, color: '#ff3b2f', size: 3 }
      return
    }
    if (lastPing) {
      const a = fadeAt(lastPing.at, now, PING_FADE_S * 1000)
      if (a > 0) {
        yield { x: lastPing.x, z: lastPing.z, radius: lastPing.r, color: `rgba(255,96,64,${a.toFixed(2)})` }
        yield { x: lastPing.x, z: lastPing.z, color: `rgba(255,156,240,${a.toFixed(2)})`, size: 3 }
      }
    }
  }
  offs.push(() => offMarkers?.())

  // Debug handle (like window.__sroKeyMove): the pilot and hunt state for browser checks.
  const debug = { pilot: () => pilot, state: () => state, event: () => huntEv, ping: () => lastPing, paws, offer: () => offer, focus: () => ctx.controlledId?.() ?? null }
  if (typeof window !== 'undefined') (window as unknown as { __sroPilot?: unknown }).__sroPilot = debug
  offs.push(() => {
    const w = typeof window !== 'undefined' ? (window as unknown as { __sroPilot?: unknown }) : null
    if (w && w.__sroPilot === debug) delete w.__sroPilot
  })

  // ---- per frame ----------------------------------------------------------------------------------------------
  const refreshHud = (now: number) => {
    if (pilot) {
      const v = her()
      boss.setNames(bossName(), selfView()?.state.name ?? '')
      boss.setEnraged(!!state?.enraged)
      const left = pilot.huntEndsAt > 0 ? pilot.huntEndsAt - now : null
      strip.set(countdown(pilot.huntEndsAt, now), left !== null && left < 60_000, state?.downs ?? 0, pilot.downsTarget, state?.hunting ?? 0)
      kitBar.update(kitSlots(pilot.kit, state, now, busy(now) || !!v?.dead), now)
      const line = state ? steeringLine(state.steering, state.idleWarnAt, now) : null
      steer.set(line ? (line.kind === 'ai' ? t('pilot.hud.aiTook') : t('pilot.hud.idleWarn', { seconds: line.seconds })) : null, line?.kind === 'ai')
      steer.stalk.hidden = !(state?.stalkUntil && state.stalkUntil > now)
    }
    if (offer) {
      if (now >= offer.expiresAt) hideOffer()
      else offerDlg.setFoot(boldTime(t('pilot.offer.timer'), formatClock(offer.expiresAt - now)))
    }
    // The hunters' banner.
    const ev = huntEv
    // The call for volunteers (layer 4): its banner and its chat lines.
    const call = !pilot && ev && !callHidden.has(ev.id) ? callBanner(ev, now) : null
    const evName = ev?.name || bossName()
    callBar.set(call ? { ...call, question: t('pilot.call.question', { name: evName }), name: evName } : null)
    callBar.setBelow(app.notices.showing !== null)
    if (ev?.phase === 'call' && ev.callEndsAt) {
      let done = callChat.get(ev.id)
      if (!done) callChat.set(ev.id, (done = new Set()))
      const time = formatClock(ev.callEndsAt - now)
      for (const l of callChatLines(ev.callEndsAt, now, done)) chat.add('notice', l === 'open' ? t('pilot.call.chat', { time }) : t('pilot.call.soon', { name: evName, time }))
    }
    if (!huntBannerShows(ev, !!pilot)) banner.set(null)
    else if (ev!.phase === 'offer') banner.set(offerLine(ev!))
    else {
      const name = ev!.name || bossName()
      const text = ev!.area ? t('hunt.sighted', { name, area: ev!.area }) : t('hunt.sightedNoArea', { name })
      const parts: string[] = []
      // The server's own schedule when it sends one (HuntEventView.nextPingAt), else counted from the pings seen here.
      const next = ev!.nextPingAt && ev!.nextPingAt > 0 ? ev!.nextPingAt : nextPingAt(lastPing?.at ?? null, huntSeenAt, pingSec, now)
      if (next !== null) parts.push(t('hunt.meta.next', { time: formatClock(next - now) }))
      const leftText = countdown(ev!.huntEndsAt, now)
      if (leftText) parts.push(t('hunt.meta.left', { time: leftText }))
      if (ev!.downsTarget) parts.push(t('hunt.meta.downs', { downs: ev!.downs ?? 0, target: ev!.downsTarget }))
      parts.push(t('hunt.meta.hunters', { count: ev!.hunters ?? 0 }))
      banner.set(text, name, parts.join(' · '))
    }
    banner.setBelow(app.notices.showing !== null)
  }

  return {
    onMessage(msg: ServerMessage) {
      switch (msg.t) {
        case 'worldEnter':
          stop(false)
          hideOffer()
          result.hide()
          paws.clear()
          lastPing = null
          huntEv = null
          huntSeenAt = null
          phases.clear()
          callHidden.clear()
          callChat.clear()
          volunteerSent = null
          break
        case 'pilotStart':
          start(msg)
          break
        case 'pilotState':
          if (!pilot) break
          state = msg
          hudT = 0
          break
        case 'pilotEnd':
          stop()
          showResult(msg)
          break
        case 'pilotOffer':
          showOffer(msg)
          break
        case 'huntEvent':
          onHuntEvent(msg.event)
          hudT = 0
          break
        case 'huntPing':
          if (lastPing && msg.at > lastPing.at) {
            const gap = (msg.at - lastPing.at) / 1000
            if (gap >= 10 && gap <= 600) pingSec = Math.round(gap)
          }
          lastPing = { x: msg.x, z: msg.z, r: msg.r, at: msg.at }
          break
        case 'huntTrail':
          if (!pilot) paws.add(msg.points)
          break
        case 'huntRoar':
          onRoar(msg)
          break
        case 'huntTaunt':
          onTaunt(msg)
          break
        case 'entityUpdate': {
          if (msg.trance === undefined && msg.piloted === undefined && msg.honor === undefined) break
          const v = ctx.view(msg.id)
          if (!v) break
          if (msg.trance === true) v.state.trance = true
          else if (msg.trance === false) delete v.state.trance
          if (msg.piloted === true) v.state.piloted = true
          else if (msg.piloted === false) delete v.state.piloted
          if (msg.honor) v.state.honor = msg.honor
          else if (msg.honor === '') delete v.state.honor
          applyFlags(v, true)
          break
        }
        case 'cast':
          if (pilot && msg.id === pilot.mob) busyUntil = ctx.serverNow() + msg.prepareMs + Math.max(0, msg.castMs) + msg.actionMs
          break
        case 'castEnd':
          if (pilot && msg.id === pilot.mob) busyUntil = 0
          break
        case 'effectAdd':
          if (pilot && msg.id === pilot.mob && msg.effect.status && HELD_STATUSES.has(msg.effect.status)) held.add(msg.effect.instance)
          break
        case 'effectRemove':
          if (pilot && msg.id === pilot.mob) held.delete(msg.instance)
          break
        case 'despawn':
          if (bubbles.has(msg.id)) {
            clearTimeout(bubbles.get(msg.id))
            bubbles.delete(msg.id)
          }
          break
        case 'actionResult':
          if (msg.re === 'pilotVolunteer') {
            const on = volunteerSent
            volunteerSent = null
            if (msg.ok) {
              if (on !== null) hud.toast(on ? t('pilot.call.joined', { name: huntEv?.name || bossName() }) : t('pilot.call.left'))
            } else if (!QUIET.has(msg.reason ?? '')) hud.toast(actionFailText(msg.reason, msg.message), 'error')
            hudT = 0
            break
          }
          if (msg.ok || !(msg.re === 'pilotAct' || msg.re === 'pilotTaunt' || msg.re === 'pilotQuit' || msg.re === 'pilotAnswer')) break
          if (!QUIET.has(msg.reason ?? '')) hud.toast(actionFailText(msg.reason, msg.message), 'error')
          break
      }
    },

    clickEntity(v) {
      if (!pilot) return false
      if (v.kind === 'player' && !v.dead && v.id !== ctx.selfId()) {
        ctx.setTarget(v)
        const now = performance.now()
        if (lastClaw.id === v.id && now - lastClaw.at < CLAW_RESEND_MS) return true
        const claw = pilot.kit.find(k => k.id === 'claw') ?? pilot.kit.find(k => k.slot === 1)
        if (claw && ctx.send({ t: 'pilotAct', ability: claw.id, target: v.id, repeat: true })) lastClaw = { id: v.id, at: now }
        return true
      }
      // Monsters (her pack, others) and NPCs can be looked at, not attacked; ground items are not hers to take.
      if (v.kind === 'mob' || v.kind === 'npc') ctx.setTarget(v)
      return true
    },

    escape() {
      if (wheel.isOpen) {
        wheel.cancel()
        return true
      }
      if (result.isOpen) {
        result.hide()
        return true
      }
      return false
    },

    onEntityAdded(v) {
      if (v.state.trance || v.state.piloted || v.state.honor) applyFlags(v, false)
    },

    onFrame(now, dt) {
      const m = ctx.minimap()
      if (m && m !== minimap) {
        offMarkers?.()
        minimap = m
        offMarkers = m.addMarkerSource(markers)
      }
      paws.update(now, dt)
      const v = her()
      if (v) boss.setHp(v.hp, v.maxHp)
      hudT -= dt
      if (hudT > 0) return
      hudT = HUD_EVERY_S
      refreshHud(now)
    },

    dispose() {
      stop(false)
      if (typeof document !== 'undefined') document.body.classList.remove('pilot-on')
      for (const off of offs.splice(0)) off()
    },
  }
}
