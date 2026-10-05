/**
 * Mock Play the Boss (docs/PLAY_THE_BOSS.md §5.2) for ?mock=1&gm=1, so the client HUD runs without the real server. A
 * GM types in chat:
 * - `/unique pilot attach`: the GM's body goes into a trance where it stands, a Tiger Girl appears 10 m away (a mock
 *   entity of this extension only) and the GM steers her (pilotStart, event 0: no timer, no downs target);
 * - `/unique pilot hunt`: the same with event rules (15 min, 15 downs) and `huntEvent` for everyone;
 * - `/unique pilot offer`: a `pilotOffer` (Accept starts a hunt);
 * - `/unique pilot call [seconds]`: a call for volunteers (layer 4; default 60 s) with each connection's own `you`;
 *   `pilotVolunteer` toggles; at its end the first volunteer gets `pilotOffer`, else it ends no_volunteers;
 * - `/unique pilot signs`: the hunters' signs around the GM: a ping, footprints, a roar, a taunt (no pilot needed);
 * - `/unique pilot end [survived|downs|killed|quit|cancelled]`: the turn ends (pilotEnd, huntEvent ended).
 * While piloting: `moveTo` walks her at 9 m/s (3.6 while stalking), `stopAction` halts her, `pilotAct` plays the
 * ability (cast with its clip, cooldowns and charges in `pilotState`), `pilotTaunt` her bubble, `pilotQuit` ends it.
 * 20 s without input her "AI" takes over (steering 'ai'); any input takes her back. Optional, first to cut: the real
 * server is the truth.
 */
import { isStaff, type ClientMessage, type EntityState, type HuntEventView, type MoveState, type PilotEndReason, type PilotKitView, type ServerMessage, type Vec3 } from '@sro/shared'
import type { MockConn, MockContext, MockExtension } from '../mock.ts'
import { sampleMove } from '../clock.ts'

const CODE = 'MOB_CH_TIGERWOMAN'
/** Her entity id in the mock (far above the mock's own ids). */
export const MOCK_TIGER_ID = 990_001
const RUN = 9
const IDLE_MS = 20_000
const HP = 47_898

export const MOCK_KIT: PilotKitView[] = [
  { id: 'claw', slot: 1, clip: '', rangeM: 2.8, cooldownMs: 3000, target: 'entity' },
  { id: 'sweep', slot: 2, clip: '', rangeM: 4, cooldownMs: 4500, target: 'none' },
  { id: 'curse', slot: 3, clip: '', rangeM: 15, cooldownMs: 5500, target: 'entity' },
  { id: 'pounce', slot: 4, clip: 'ATTACK1', rangeM: 12, cooldownMs: 12_000, target: 'point' },
  { id: 'roar', slot: 5, clip: 'FIND', rangeM: 8, cooldownMs: 20_000, target: 'none' },
  { id: 'pack', slot: 6, clip: 'HELP', rangeM: 0, cooldownMs: 30_000, charges: 2, target: 'none' },
  { id: 'stalk', slot: 7, clip: '', rangeM: 0, cooldownMs: 25_000, target: 'none' },
]
/** Her retail rows for the three row abilities (the client resolves their clips from the fx index). */
const ROWS: Record<string, string> = { claw: 'MSKILL_CH_TIGERWOMAN_ATTACK01', sweep: 'MSKILL_CH_TIGERWOMAN_ATTACK02', curse: 'MSKILL_CH_TIGERWOMAN_ATTACK03' }

interface Turn {
  conn: MockConn
  event: number
  state: EntityState
  move: MoveState | null
  ready: Record<string, number>
  charges: Record<string, number>
  steering: 'player' | 'ai'
  lastInput: number
  warned: boolean
  stalkUntil: number
  downs: number
  startedAt: number
  huntEndsAt: number
}

interface State {
  turn: Turn | null
  event: HuntEventView | null
  nextEvent: number
  instance: number
  /** The call (layer 4): the connections that volunteered, and every connection seen (the call is per recipient). */
  volunteers: Set<MockConn>
  conns: Set<MockConn>
}

const states = new WeakMap<MockContext, State>()
function stateOf(ctx: MockContext): State {
  let s = states.get(ctx)
  if (!s) states.set(ctx, (s = { turn: null, event: null, nextEvent: 1, instance: 1, volunteers: new Set(), conns: new Set() }))
  return s
}

const nameOf = (ctx: MockContext) => ctx.content.mobs.get(CODE)?.name ?? 'Tiger Girl'

function herPos(turn: Turn, now: number): Vec3 {
  return turn.move ? sampleMove(turn.move, now).pos : [...turn.state.pos]
}

function sendState(ctx: MockContext, turn: Turn): void {
  const now = ctx.now()
  const hunting = [...ctx.entities()].filter(e => e.state.kind === 'player' && e.state.id !== turn.conn.entityId).length
  const m: Extract<ServerMessage, { t: 'pilotState' }> = { t: 'pilotState', steering: turn.steering, hunting, downs: turn.downs, charges: { ...turn.charges }, ready: { ...turn.ready } }
  if (turn.warned && turn.steering === 'player') m.idleWarnAt = turn.lastInput + IDLE_MS
  if (turn.stalkUntil > now) m.stalkUntil = turn.stalkUntil
  if (turn.state.hp! < turn.state.maxHp! * 0.2) m.enraged = true
  ctx.send(turn.conn, m)
}

function broadcastEvent(ctx: MockContext, s: State): void {
  if (!s.event) return
  if (s.event.phase !== 'call') return ctx.broadcast({ t: 'huntEvent', event: { ...s.event } })
  // The call: each connection gets its own `you` (everyone is eligible in the mock).
  for (const c of s.conns) ctx.send(c, { t: 'huntEvent', event: { ...s.event, volunteers: s.volunteers.size, you: { volunteered: s.volunteers.has(c), eligible: true } } })
}

/** `/unique pilot call [seconds]`: a call for volunteers (default 60 s); at its end the first volunteer is offered the turn. */
function openCall(ctx: MockContext, sec: number): string {
  const s = stateOf(ctx)
  if (s.turn || (s.event && s.event.phase !== 'ended')) return 'An event runs already (mock).'
  s.volunteers.clear()
  s.event = { id: s.nextEvent++, mob: CODE, name: nameOf(ctx), phase: 'call', callEndsAt: ctx.now() + sec * 1000, volunteers: 0, minLevel: 20 }
  broadcastEvent(ctx, s)
  return `Call open (mock): the draw in ${sec} s.`
}

/** The call's end: the first volunteer is offered the turn, else nobody (no_volunteers). */
function drawCall(ctx: MockContext, s: State): void {
  const ev = s.event!
  const pick = [...s.volunteers][0]
  s.volunteers.clear()
  if (!pick) {
    s.event = { ...ev, phase: 'ended', outcome: 'no_volunteers' }
    broadcastEvent(ctx, s)
    s.event = null
    return
  }
  s.event = { id: ev.id, mob: ev.mob, name: ev.name, phase: 'offer', callEndsAt: ev.callEndsAt, volunteers: ev.volunteers }
  broadcastEvent(ctx, s)
  ctx.send(pick, { t: 'pilotOffer', event: ev.id, expiresAt: ctx.now() + 30_000, surviveMin: 15, downsTarget: 15, idleSec: 20 })
}

function start(ctx: MockContext, conn: MockConn, hunt: boolean): string {
  const s = stateOf(ctx)
  if (s.turn) return 'Already piloting (mock).'
  const self = ctx.selfOf(conn)
  if (!self) return 'Not in the world.'
  const now = ctx.now()
  const p = self.state.pos
  const state: EntityState = { id: MOCK_TIGER_ID, kind: 'mob', name: nameOf(ctx), model: CODE, level: 20, pos: [p[0] + 7, p[1], p[2] + 7], yaw: 0, hp: HP, maxHp: HP, piloted: true }
  const event = hunt ? s.nextEvent++ : 0
  const huntEndsAt = hunt ? now + 15 * 60_000 : 0
  const turn: Turn = { conn, event, state, move: null, ready: {}, charges: { pack: 2 }, steering: 'player', lastInput: now, warned: false, stalkUntil: 0, downs: 0, startedAt: now, huntEndsAt }
  s.turn = turn
  if (hunt) {
    s.event = { id: event, mob: CODE, name: nameOf(ctx), phase: 'hunt', huntEndsAt, downs: 0, downsTarget: 15, hunters: 3, area: 'North-Tiger Mt.', steering: 'player' }
    broadcastEvent(ctx, s)
  }
  ctx.broadcast({ t: 'entityUpdate', id: self.state.id, trance: true })
  ctx.broadcast({ t: 'spawn', entity: { ...state, pos: [...state.pos] } })
  ctx.send(conn, { t: 'pilotStart', event, mob: MOCK_TIGER_ID, kit: MOCK_KIT, huntEndsAt, downsTarget: hunt ? 15 : 0, area: { x: state.pos[0], z: state.pos[2], r: 350 }, taunts: 8, senseM: 60, place: 'palace-steps' })
  sendState(ctx, turn)
  return hunt ? 'Hunt started (mock): you steer Tiger Girl.' : 'Attached (mock): you steer Tiger Girl.'
}

function end(ctx: MockContext, reason: PilotEndReason): string {
  const s = stateOf(ctx)
  const turn = s.turn
  if (!turn) return 'Nobody pilots (mock).'
  s.turn = null
  const now = ctx.now()
  const won = reason === 'survived' || reason === 'downs'
  const msg: Extract<ServerMessage, { t: 'pilotEnd' }> = { t: 'pilotEnd', event: turn.event, reason, downs: turn.downs, steeredMs: now - turn.startedAt }
  if (turn.event && reason !== 'quit' && reason !== 'cancelled') msg.gold = 5000 + 500 * turn.downs + (won ? 10_000 : 0)
  if (turn.event && won) msg.honor = 'tiger_spirit'
  ctx.send(turn.conn, msg)
  const self = ctx.selfOf(turn.conn)
  if (self) ctx.broadcast({ t: 'entityUpdate', id: self.state.id, trance: false })
  ctx.broadcast({ t: 'despawn', id: MOCK_TIGER_ID })
  if (s.event && turn.event) {
    s.event = { ...s.event, phase: 'ended', outcome: reason === 'quit' ? 'survived' : reason, pilot: self?.state.name ?? 'GM' }
    broadcastEvent(ctx, s)
    s.event = null
  }
  return `Turn ended (mock): ${reason}.`
}

/** Any input: her AI lets go. */
function input(ctx: MockContext, turn: Turn): void {
  turn.lastInput = ctx.now()
  const changed = turn.steering !== 'player' || turn.warned
  turn.steering = 'player'
  turn.warned = false
  if (changed) {
    ctx.broadcast({ t: 'entityUpdate', id: MOCK_TIGER_ID, piloted: true })
    sendState(ctx, turn)
  }
}

function walk(ctx: MockContext, turn: Turn, x: number, z: number, speed: number): void {
  const now = ctx.now()
  const from = herPos(turn, now)
  turn.state.pos = from
  turn.move = { from, to: [x, from[1], z], speed, startedAt: now }
  turn.state.yaw = Math.atan2(x - from[0], z - from[2])
  ctx.broadcast({ t: 'move', id: MOCK_TIGER_ID, move: turn.move })
}

function act(ctx: MockContext, conn: MockConn, turn: Turn, msg: Extract<ClientMessage, { t: 'pilotAct' }>): void {
  const now = ctx.now()
  const k = MOCK_KIT.find(x => x.id === msg.ability)
  if (!k) return ctx.result(conn, 'pilotAct', false, 'not_found')
  if ((turn.ready[k.id] ?? 0) > now) return ctx.result(conn, 'pilotAct', false, 'cooldown')
  if (turn.charges[k.id] !== undefined && turn.charges[k.id]! <= 0) return ctx.result(conn, 'pilotAct', false, 'no_charges')
  if (k.target === 'entity' && msg.target === undefined) return ctx.result(conn, 'pilotAct', false, 'invalid_target')
  ctx.result(conn, 'pilotAct', true)
  turn.ready[k.id] = now + k.cooldownMs
  if (turn.charges[k.id] !== undefined) turn.charges[k.id]! -= 1
  if (turn.stalkUntil > now && k.id !== 'stalk') turn.stalkUntil = 0
  const cast: Extract<ServerMessage, { t: 'cast' }> = { t: 'cast', id: MOCK_TIGER_ID, skill: ROWS[k.id] ?? `PILOT_TIGERWOMAN_${k.id.toUpperCase()}`, instance: stateOf(ctx).instance++, prepareMs: 0, castMs: 0, actionMs: 1400 }
  if (k.clip) cast.clip = k.clip
  if (msg.target !== undefined) cast.target = msg.target
  const pos = herPos(turn, now)
  turn.state.pos = pos
  turn.move = null
  if (k.id === 'pounce') {
    const t = msg.target !== undefined ? ctx.entity(msg.target) : undefined
    const x = t ? t.state.pos[0] : (msg.x ?? pos[0])
    const z = t ? t.state.pos[2] : (msg.z ?? pos[2])
    walk(ctx, turn, x, z, 24)
  } else ctx.broadcast({ t: 'stop', id: MOCK_TIGER_ID, pos, yaw: turn.state.yaw })
  if (k.id === 'stalk') {
    turn.stalkUntil = now + 20_000
    turn.ready[k.id] = turn.stalkUntil + k.cooldownMs
  } else ctx.broadcast(cast)
  sendState(ctx, turn)
}

function command(ctx: MockContext, conn: MockConn, text: string): void {
  const [, , sub = '', arg = ''] = text.trim().split(/\s+/)
  const reply = (ok: boolean, message: string) => ctx.send(conn, { t: 'gmResult', ok, cmd: 'unique', message })
  if (!isStaff(conn.role)) return ctx.send(conn, { t: 'error', code: 'forbidden', message: 'GM commands need a GM account.', re: 'chat' })
  const s = stateOf(ctx)
  switch (sub.toLowerCase()) {
    case 'attach':
      return reply(true, start(ctx, conn, false))
    case 'hunt':
      return reply(true, start(ctx, conn, true))
    case 'offer': {
      const event = s.nextEvent
      s.event = { id: event, mob: CODE, name: nameOf(ctx), phase: 'offer' }
      broadcastEvent(ctx, s)
      ctx.send(conn, { t: 'pilotOffer', event, expiresAt: ctx.now() + 30_000, surviveMin: 15, downsTarget: 15, idleSec: 20 })
      return reply(true, 'Offer sent (mock).')
    }
    case 'signs': {
      const self = ctx.selfOf(conn)
      if (!self) return reply(false, 'Not in the world.')
      const [x, , z] = self.state.pos
      const now = ctx.now()
      if (!s.event) {
        s.event = { id: s.nextEvent++, mob: CODE, name: nameOf(ctx), phase: 'hunt', huntEndsAt: now + 11 * 60_000 + 42_000, downs: 6, downsTarget: 15, hunters: 63, area: 'North-Tiger Mt.' }
        broadcastEvent(ctx, s)
      }
      ctx.send(conn, { t: 'huntPing', event: s.event.id, x: x + 30, z: z - 20, r: 60, at: now })
      const points: [number, number, number][] = []
      for (let i = 0; i < 12; i++) points.push([Math.round((x + 3 + i * 1.6) * 100) / 100, Math.round((z + 4 + Math.sin(i / 2) * 1.5) * 100) / 100, now - (12 - i) * 3000])
      ctx.send(conn, { t: 'huntTrail', points })
      ctx.send(conn, { t: 'huntRoar', bearing: Math.PI / 4, distM: 220, at: now })
      return reply(true, 'Hunt signs sent (mock).')
    }
    case 'end': {
      const r = (['survived', 'downs', 'killed', 'quit', 'cancelled'] as const).find(x => x === arg) ?? 'survived'
      return reply(true, end(ctx, r))
    }
    case 'call': {
      const sec = Number(arg) > 0 ? Math.min(3600, Number(arg)) : 60
      return reply(true, openCall(ctx, sec))
    }
    default:
      return reply(false, 'usage: unique pilot attach | hunt | offer | call [seconds] | signs | end [reason] (mock)')
  }
}

/** A pilot request from someone who is not piloting: `no_event` (claimed). */
function refuse(ctx: MockContext, conn: MockConn, re: 'pilotAct' | 'pilotTaunt' | 'pilotQuit'): true {
  ctx.result(conn, re, false, 'no_event')
  return true
}

export const pilotMock: MockExtension = {
  handle(ctx, conn, msg): boolean {
    stateOf(ctx).conns.add(conn)
    if (msg.t === 'chat') {
      if (msg.to !== undefined || !/^\/unique\s+pilot(\s|$)/i.test(msg.text.trim())) return false
      command(ctx, conn, msg.text)
      return true
    }
    const s = stateOf(ctx)
    const turn = s.turn && s.turn.conn === conn ? s.turn : null
    switch (msg.t) {
      case 'moveTo':
        if (!turn) return false
        input(ctx, turn)
        walk(ctx, turn, msg.x, msg.z, turn.stalkUntil > ctx.now() ? RUN * 0.4 : RUN)
        return true
      case 'stopAction':
        if (!turn) return false
        input(ctx, turn)
        turn.state.pos = herPos(turn, ctx.now())
        turn.move = null
        ctx.broadcast({ t: 'stop', id: MOCK_TIGER_ID, pos: turn.state.pos, yaw: turn.state.yaw })
        ctx.result(conn, 'stopAction', true)
        return true
      case 'pilotAct':
        if (!turn) return refuse(ctx, conn, 'pilotAct')
        input(ctx, turn)
        act(ctx, conn, turn, msg)
        return true
      case 'pilotTaunt':
        if (!turn) return refuse(ctx, conn, 'pilotTaunt')
        ctx.result(conn, 'pilotTaunt', true)
        ctx.broadcast({ t: 'huntTaunt', id: MOCK_TIGER_ID, line: msg.line })
        return true
      case 'pilotQuit':
        if (!turn) return refuse(ctx, conn, 'pilotQuit')
        ctx.result(conn, 'pilotQuit', true)
        end(ctx, 'quit')
        return true
      case 'pilotAnswer':
        ctx.result(conn, 'pilotAnswer', true)
        if (msg.accept) start(ctx, conn, true)
        else if (s.event?.phase === 'offer') {
          s.event = { ...s.event, phase: 'ended', outcome: 'no_volunteers' }
          broadcastEvent(ctx, s)
          s.event = null
        }
        return true
      case 'pilotVolunteer':
        if (s.event?.phase !== 'call') {
          ctx.result(conn, 'pilotVolunteer', false, 'no_event')
          return true
        }
        if (msg.on) s.volunteers.add(conn)
        else s.volunteers.delete(conn)
        ctx.result(conn, 'pilotVolunteer', true)
        broadcastEvent(ctx, s)
        return true
      case 'attack':
      case 'useSkill':
      case 'pickup':
        // The body rests in a trance.
        if (!turn) return false
        ctx.result(conn, msg.t, false, 'piloting')
        return true
      default:
        return false
    }
  },
  tick(ctx, now): void {
    const s = states.get(ctx)
    if (s?.event?.phase === 'call' && now >= (s.event.callEndsAt ?? 0)) drawCall(ctx, s)
    const turn = s?.turn
    if (!s || !turn) return
    if (turn.move && sampleMove(turn.move, now).arrived) {
      turn.state.pos = [...turn.move.to]
      turn.move = null
    }
    if (turn.huntEndsAt && now >= turn.huntEndsAt) {
      end(ctx, 'survived')
      return
    }
    const idle = now - turn.lastInput
    if (turn.steering === 'player' && !turn.warned && idle >= IDLE_MS - 5000) {
      turn.warned = true
      sendState(ctx, turn)
    } else if (turn.steering === 'player' && idle >= IDLE_MS) {
      turn.steering = 'ai'
      turn.warned = false
      ctx.broadcast({ t: 'entityUpdate', id: MOCK_TIGER_ID, piloted: false })
      sendState(ctx, turn)
    }
  },
  enter(ctx, conn): void {
    const s = stateOf(ctx)
    s.conns.add(conn)
    if (s.event?.phase === 'call') broadcastEvent(ctx, s)
    else if (s.event) ctx.send(conn, { t: 'huntEvent', event: { ...s.event } })
    const turn = s?.turn
    if (turn && turn.conn !== conn) ctx.send(conn, { t: 'spawn', entity: { ...turn.state, pos: herPos(turn, ctx.now()) } })
  },
}
