/**
 * Tiger Girl's moves, presented (world/tiger-moves.ts has the maths; docs/PLAY_THE_BOSS.md §3.5). Everything here is
 * the client's picture of what the server already decided; positions, hits and statuses stay the server's.
 *
 * - Pounce (`cast PILOT_*_POUNCE` right after the server's `move` at the leap speed): the body crouches, leaves the
 *   ground on a parabola over the server's own path and touches down when that walk ends (the hit), with dust, a ring,
 *   a thud and a small camera shake nearby. Her clip's rate is set in skills-view.ts shapePilotPlans.
 * - Roar (`cast PILOT_*_ROAR`): the FIND clip whole (shapePilotPlans), and at its peak the retail roar
 *   (cm_bluetiger_find, pitched down) over a synthesized throat-and-growl layer, a shockwave ring with dust at her feet
 *   and a camera shake within ROAR_SHAKE_M (Options → Controls → Camera shake).
 * - Stalk / any slow walk: `EntityView.gait` picks WALK at the rate matching her speed (no skating); a walk faster than
 *   her retail walk is a prowl: the tiger sinks, she leans forward over its neck.
 * Works the same for the pilot (her own view) and for everyone watching.
 */
import { Quaternion, Vector3 } from '@babylonjs/core'
import type { ServerMessage } from '@sro/shared'
import { TIGER_SYNTH } from '../../audio/synth.ts'
import { settings } from '../../settings.ts'
import type { EntityView } from '../entities.ts'
import type { WorldFeatureContext, WorldFeatureFactory } from '../features.ts'
import { TigerFx } from '../tiger-fx.ts'
import {
  approach,
  gaitFor,
  LAND_SHAKE_AMP,
  LAND_SHAKE_M,
  LAND_SHAKE_S,
  leapApex,
  leapAt,
  pilotMoveOf,
  PROWL_LEAN,
  PROWL_SQUASH,
  ROAR_PEAK_S,
  ROAR_SHAKE_AMP,
  ROAR_SHAKE_M,
  ROAR_SHAKE_S,
  shakeAmp,
} from '../tiger-moves.ts'

/** The mobs drawn with these moves (ridden uniques with the Play the Boss kit). */
export const TIGER_MOBS: ReadonlySet<string> = new Set(['MOB_CH_TIGERWOMAN'])
/** The retail roar and landing sounds (converted sound index ids). */
const ROAR_FILE = 'monster/cm_bluetiger_find'
const THUD_FILE = 'monster/cm_bluetiger_thud'
/** The roar's ring reaches the kit's 8 m fear radius plus her body. */
const ROAR_RING_M = 11

interface Leap {
  from: [number, number]
  to: [number, number]
  /** Server ms the walk started, and its length (s). */
  startedAt: number
  durS: number
  apex: number
  landed: boolean
}

interface Track {
  v: EntityView
  leap: Leap | null
  roarAt: number | null
  prowl: number
  /** The body's vertical factor written last frame (1 = untouched). */
  squash: number
}

interface Shake {
  x: number
  z: number
  rangeM: number
  amp: number
  totalS: number
  left: number
}

const LEAN_AXIS = new Vector3(1, 0, 0)
/** The rider root's X rotation that tips her head toward the tiger's head. */
const LEAN_SIGN = -1
/** The bodies' vertical scale at rest (see pose()). */
const REST_BIAS = 0.995
const leanQ = new Quaternion()

export const tigerMovesFeature: WorldFeatureFactory = (ctx: WorldFeatureContext) => {
  const tracks = new Map<number, Track>()
  const fx = new TigerFx(ctx.scene)
  const shakes: Shake[] = []
  /** Debug (window.__sroTiger): the last frame's server time. */
  const dbg = { tracks, shakes, now: 0 }
  let shaking = false
  const audio = ctx.app.audio
  if (audio) for (const [id, make] of Object.entries(TIGER_SYNTH)) audio.prepareSynth(id, make)

  const speeds = (code: string) => {
    const d = ctx.app.catalog.content.mobs.get(code)
    return { walk: d?.walkSpeed ?? 2, run: d?.runSpeed ?? 9 }
  }

  const add = (v: EntityView) => {
    if (v.kind !== 'mob' || !TIGER_MOBS.has(v.state.model)) return
    const sp = speeds(v.state.model)
    v.gait = speed => gaitFor(speed, sp.walk, sp.run)
    tracks.set(v.state.id, { v, leap: null, roarAt: null, prowl: 0, squash: 1 })
  }

  const play = (file: string, pos: Vector3, gain: number, rate = 1) =>
    audio?.playFile(file, { pos: { x: pos.x, y: pos.y + 1.5, z: pos.z }, kind: 'other', priority: 2, gain, rate, waitMs: 800 })

  const listener = () => ctx.camera.target

  const onCast = (msg: Extract<ServerMessage, { t: 'cast' }>) => {
    const tr = tracks.get(msg.id)
    const move = pilotMoveOf(msg.skill)
    if (!tr || !move) return
    const now = ctx.serverNow()
    if (move === 'roar') {
      tr.leap = null
      tr.roarAt = now + ROAR_PEAK_S * 1000
      return
    }
    const m = tr.v.move
    if (!m || !(m.speed > 0)) return
    const dist = Math.hypot(m.to[0] - m.from[0], m.to[2] - m.from[2])
    if (dist < 0.5) return
    tr.leap = { from: [m.from[0], m.from[2]], to: [m.to[0], m.to[2]], startedAt: m.startedAt, durS: dist / m.speed, apex: leapApex(dist), landed: false }
  }

  const roar = (tr: Track) => {
    const p = tr.v.root.position
    fx.roar(p.x, p.y, p.z, ROAR_RING_M)
    play(ROAR_FILE, p, 1, 0.82)
    play('synth/tg_roar', p, 0.85)
    shakes.push({ x: p.x, z: p.z, rangeM: ROAR_SHAKE_M, amp: ROAR_SHAKE_AMP, totalS: ROAR_SHAKE_S, left: ROAR_SHAKE_S })
  }

  const land = (tr: Track, x: number, y: number, z: number) => {
    fx.land(x, y, z)
    const at = new Vector3(x, y, z)
    play(THUD_FILE, at, 0.9)
    play('synth/tg_thud', at, 0.8)
    shakes.push({ x, z, rangeM: LAND_SHAKE_M, amp: LAND_SHAKE_AMP, totalS: LAND_SHAKE_S, left: LAND_SHAKE_S })
  }

  /**
   * Writes the body's vertical factor and the rider's lean, every frame. The bodies are never scaled uniformly (REST_BIAS
   * off 1 at rest): a squash that switched the meshes to non-uniform scaling would switch their shaders' variant too, and
   * with parallel compilation they would vanish for the first squash's few frames.
   */
  const pose = (tr: Track, squash: number, lean: number) => {
    const v = tr.v
    const body = (v.ride?.actor ?? v.actor)?.root
    if (!body) return
    const k = squash * REST_BIAS
    body.scaling.y = body.scaling.x * k
    const rider = v.ride ? v.actor?.root : null
    if (rider) {
      // The seat inherits the squash; the rider keeps her own height and leans over the tiger's neck.
      rider.scaling.y = 1 / k
      rider.rotationQuaternion = Quaternion.RotationAxisToRef(LEAN_AXIS, lean * LEAN_SIGN, rider.rotationQuaternion ?? leanQ.clone())
    }
    tr.squash = squash
  }

  const frame = (now: number, dt: number) => {
    dbg.now = now
    for (const tr of tracks.values()) {
      const v = tr.v
      if (v.dead || !v.actor) {
        tr.leap = null
        tr.roarAt = null
        pose(tr, 1, 0)
        continue
      }
      const root = v.root.position
      if (tr.roarAt !== null && now >= tr.roarAt) {
        tr.roarAt = null
        roar(tr)
      }
      let squash = 1
      let lean = 0
      const l = tr.leap
      if (l) {
        const s = leapAt((now - l.startedAt) / 1000, l.durS, l.apex)
        if (s.phase === 'done') tr.leap = null
        else {
          if (s.phase === 'windup' || s.phase === 'air') {
            root.x = l.from[0] + (l.to[0] - l.from[0]) * s.progress
            root.z = l.from[1] + (l.to[1] - l.from[1]) * s.progress
          }
          if (!l.landed && s.phase === 'land') {
            l.landed = true
            land(tr, root.x, root.y, root.z)
          }
          root.y += s.lift
          squash = s.squash
          lean = s.phase === 'windup' ? PROWL_LEAN * 0.8 : s.phase === 'air' ? PROWL_LEAN * 0.5 : 0
        }
      }
      const speed = v.moving && !l ? (v.move?.speed ?? 0) : 0
      const sp = speeds(v.state.model)
      tr.prowl = approach(tr.prowl, speed > 0 ? gaitFor(speed, sp.walk, sp.run).prowl : 0, 6, dt)
      if (!l) {
        squash = 1 - PROWL_SQUASH * tr.prowl
        lean = PROWL_LEAN * tr.prowl
      }
      pose(tr, squash, lean)
    }
    fx.update(dt)
    // Camera shake: the strongest of the live shakes at the camera's focus.
    const at = listener()
    let amp = 0
    for (let i = shakes.length - 1; i >= 0; i--) {
      const s = shakes[i]!
      s.left -= dt
      if (s.left <= 0) {
        shakes.splice(i, 1)
        continue
      }
      amp = Math.max(amp, shakeAmp(Math.hypot(at.x - s.x, at.z - s.z), s.rangeM, s.amp, s.left, s.totalS))
    }
    const on = amp > 0.0005 && settings.get().controls.cameraShake
    if (on) {
      const t = now / 1000
      ctx.camera.targetScreenOffset.set(Math.sin(t * 47) * amp + Math.sin(t * 73) * amp * 0.4, Math.cos(t * 39) * amp * 0.7)
      shaking = true
    } else if (shaking) {
      ctx.camera.targetScreenOffset.set(0, 0)
      shaking = false
    }
  }

  for (const v of ctx.views()) add(v)
  // Debug: `window.__sroTiger` (the tracked views: leap, prowl, squash).
  const w = typeof window !== 'undefined' ? (window as unknown as { __sroTiger?: unknown }) : null
  if (w) w.__sroTiger = dbg

  return {
    onEntityAdded: add,
    onEntityRemoved(v) {
      tracks.delete(v.state.id)
    },
    onMessage(msg) {
      if (msg.t === 'cast') onCast(msg)
      else if (msg.t === 'worldEnter') shakes.length = 0
    },
    onFrame: frame,
    dispose() {
      fx.dispose()
      if (shaking) ctx.camera.targetScreenOffset.set(0, 0)
      tracks.clear()
      if (w?.__sroTiger) delete w.__sroTiger
    },
  }
}
