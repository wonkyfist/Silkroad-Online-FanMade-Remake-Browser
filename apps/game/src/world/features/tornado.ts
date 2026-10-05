/**
 * The lightning tornado on the client (docs/WEATHER.md §13.7). Takes the server's `tornado`, `tornadoEnd`, `displace`
 * and the tornado's own `strike`s and shows them:
 *
 * - **The funnel** (world/storm/tornado-fx.ts): placed every frame with `tornadoAt` from the state's path and times (no
 *   message per step), lowering during the warning, rising after the lift; the tier from the graphics preset (Low a
 *   simpler funnel, Medium and High the full one). Gameplay, so shown whatever the weather setting, like the telegraph.
 *   One TornadoFx while a tornado is up; disposed when it is gone, on worldEnter and on dispose (no leak).
 * - **The bolts it throws** (`strike.source: 'tornado'`): the lightning feature draws them as any strike; this adds an
 *   arc from the funnel's side to the impact when the bolt lands.
 * - **Thrown bodies** (`displace {kind: 'throw'}`): the server's move carries them along the ground; this lifts them on
 *   the arc (`throwArc`) and spins them (the knockdown clip plays from the status). **Pulled** ones (`displace {kind:
 *   'pull'}`) slide toward the funnel without a walking clip.
 * - **Felt and heard**: the camera shakes inside TORNADO_TABLE.shakeM (Options → Controls → Camera shake), harder while
 *   you are thrown; the synthesized roar (audio/tornado.ts) swells with the distance and pans toward the funnel.
 * - **Told**: a chat line at the warning (where, how far, which way) and at the lift; the weather icon's tooltip shows
 *   it with its distance and direction (world/storm/tornado-status.ts).
 * - Debug: `window.__sroTornado` (state, fx stats, tier).
 */
import { TORNADO_TABLE, throwArc, tornadoAt, tornadoPhase, type DisplaceKind, type TornadoState, type Vec3 } from '@sro/shared'
import type { World } from '@sro/world-render'
import type { GameAudio } from '../../audio/index.ts'
import { ROAR_EVERY_S, TORNADO_SYNTH, roarGain } from '../../audio/tornado.ts'
import { t, type StringKey } from '../../i18n/index.ts'
import { effectiveGraphics, settings, type SettingsStore } from '../../settings.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { TornadoFx, type TornadoTier } from '../storm/tornado-fx.ts'
import { compass, setTornadoSource, type TornadoInfo } from '../storm/tornado-status.ts'
import { panToward } from './weather.ts'

/** Camera shake (screen offset units, like camera-keys.ts SHAKE_AMP) at the funnel, and while thrown. */
export const TORNADO_SHAKE_AMP = 0.07
export const THROWN_SHAKE_AMP = 0.1

interface Shown {
  kind: DisplaceKind
  from: Vec3
  to: Vec3
  at: number
  ms: number
  peakM: number
}

export interface TornadoFeatureOptions {
  store?: SettingsStore
}

/** The funnel's tier for a render preset. */
export function tornadoTierFor(preset: string): TornadoTier {
  return preset === 'low' ? 'low' : preset === 'medium' ? 'medium' : 'high'
}

/** Shake amplitude at `distM` from the funnel (0 beyond shakeM), times its presence. */
export function tornadoShake(distM: number, presence: number): number {
  const k = Math.max(0, 1 - distM / TORNADO_TABLE.shakeM)
  return TORNADO_SHAKE_AMP * k ** 1.5 * Math.max(0, Math.min(1, presence))
}

/** The chat line of a tornado's warning, from where you stand (x, z). */
export function tornadoWarnLine(s: TornadoState, x: number, z: number, now: number): string {
  const p = s.path[0]!
  const dist = Math.round(Math.hypot(p[0] - x, p[2] - z) / 10) * 10
  const dir = t(`tornado.dir.${compass(p[0] - x, p[2] - z)}` as StringKey)
  const where = s.area ? t('tornado.chat.where.area', { area: s.area, dist, dir }) : t('tornado.chat.where.near', { dist, dir })
  return t('tornado.chat.warn', { where, s: Math.max(1, Math.round((s.touchAt - now) / 1000)) })
}

/** The weather icon's tooltip line for a tornado. */
export function tornadoTipLine(info: TornadoInfo): string {
  const dir = t(`tornado.dir.${info.dir}` as StringKey)
  const dist = Math.round(info.distM / 10) * 10
  if (info.phase === 'warning') return t('tornado.tip.warn', { dist, dir, s: Math.max(1, Math.round(info.touchInS)) })
  return t(info.phase === 'lifting' ? 'tornado.tip.lifting' : 'tornado.tip.active', { dist, dir })
}

export function tornadoFeature(ctx: WorldFeatureContext, opts: TornadoFeatureOptions = {}): WorldFeature {
  if (!ctx.session) return {}
  const store = opts.store ?? settings
  const audio: GameAudio | undefined = ctx.app?.audio
  let state: TornadoState | null = null
  let fx: TornadoFx | null = null
  let tier: TornadoTier | null = null
  let world: World | null = null
  let lifted = false
  let shaking = false
  let roarAt = 0
  let roarB = false
  let prepared = false
  const shown = new Map<number, Shown>()

  const pageS = () => (typeof performance === 'undefined' ? Date.now() : performance.now()) / 1000

  const listener = () => {
    const id = ctx.controlledId?.() ?? ctx.selfId()
    const v = id !== null ? ctx.view(id) : undefined
    return v?.root.position ?? ctx.camera.target
  }

  const wantTier = (): TornadoTier => {
    const s = store.get()
    try {
      return tornadoTierFor(effectiveGraphics(s, { gpu: world?.render.gpu ?? null }).renderPreset)
    } catch {
      return tornadoTierFor(s.graphics.preset)
    }
  }

  const drop = () => {
    fx?.dispose()
    fx = null
    tier = null
  }

  const clear = () => {
    state = null
    lifted = false
    drop()
    shown.clear()
    if (shaking) ctx.camera.targetScreenOffset.set(0, 0)
    shaking = false
  }

  const info = (): TornadoInfo | null => {
    if (!state) return null
    const now = ctx.serverNow()
    const at = tornadoAt(state, now)
    if (at.phase === 'gone') return null
    const me = listener()
    const i: TornadoInfo = { phase: at.phase, distM: Math.hypot(at.pos[0] - me.x, at.pos[2] - me.z), dir: compass(at.pos[0] - me.x, at.pos[2] - me.z), touchInS: (state.touchAt - now) / 1000 }
    if (state.area) i.area = state.area
    return i
  }
  setTornadoSource(info)

  const offs: Array<() => void> = [
    store.onChange(() => {
      if (fx && wantTier() !== tier) drop()
    }),
  ]
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __sroTornado?: unknown }
    w.__sroTornado = {
      get state() {
        return state
      },
      get stats() {
        return fx?.stats() ?? null
      },
      get tier() {
        return tier
      },
    }
    offs.push(() => {
      delete w.__sroTornado
    })
  }

  const roar = (pos: Vec3, presence: number) => {
    if (!audio) return
    if (!prepared) {
      prepared = true
      for (const [id, make] of Object.entries(TORNADO_SYNTH)) audio.prepareSynth(id, make)
    }
    const s = pageS()
    if (s < roarAt) return
    // until the synthesized buffers are decoded, play nothing (a miss would ask the server for the file)
    if (!audio.bank.get('synth/tornado_roar_a') || !audio.bank.get('synth/tornado_roar_b')) return
    roarAt = s + ROAR_EVERY_S
    const me = listener()
    const d = Math.hypot(pos[0] - me.x, pos[2] - me.z)
    const gain = roarGain(d, TORNADO_TABLE.hearM, presence)
    if (gain < 0.01) return
    const cam = ctx.camera
    const bearing = Math.atan2(-(pos[2] - me.z), pos[0] - me.x)
    const pan = d < 15 ? 0 : panToward(bearing, cam.target.x - cam.position.x, cam.target.z - cam.position.z) * Math.min(1, d / 60)
    roarB = !roarB
    audio.playFile(roarB ? 'synth/tornado_roar_b' : 'synth/tornado_roar_a', { bus: 'ambient', kind: 'other', self: true, priority: 1, gain: 0.95 * gain, pan })
  }

  const shake = (amp: number, now: number) => {
    const on = amp > 0.0005 && store.get().controls.cameraShake
    if (on) {
      const s = now / 1000
      ctx.camera.targetScreenOffset.set(Math.sin(s * 37) * amp + Math.sin(s * 61) * amp * 0.4, Math.cos(s * 29) * amp * 0.6)
      shaking = true
    } else if (shaking) {
      ctx.camera.targetScreenOffset.set(0, 0)
      shaking = false
    }
  }

  return {
    onMessage(msg) {
      if (msg.t === 'worldEnter') clear()
      else if (msg.t === 'tornado') {
        const fresh = state?.id !== msg.tornado.id
        if (fresh) {
          drop()
          lifted = false
          const me = listener()
          if (tornadoPhase(msg.tornado, ctx.serverNow()) === 'warning') ctx.chat.add('system', tornadoWarnLine(msg.tornado, me.x, me.z, ctx.serverNow()))
        }
        state = msg.tornado
        if (state.liftAt !== undefined && !lifted) {
          lifted = true
          ctx.chat.add('system', t('tornado.chat.lift'))
        }
      } else if (msg.t === 'tornadoEnd') {
        if (state?.id === msg.id) {
          if (!lifted) ctx.chat.add('system', t('tornado.chat.lift'))
          clear()
        }
      } else if (msg.t === 'displace') {
        shown.set(msg.id, { kind: msg.kind, from: msg.from, to: msg.to, at: msg.at, ms: msg.ms, peakM: msg.peakM ?? 0 })
        const v = ctx.view(msg.id)
        // a pulled body slides on its own (no walking clip): the feature carries it instead of the move
        if (msg.kind === 'pull' && v) v.move = undefined
        if (msg.kind === 'throw' && msg.id === (ctx.controlledId?.() ?? ctx.selfId())) {
          ctx.chat.add('system', t('tornado.chat.thrown'))
          if (audio?.bank.get('synth/tornado_whoosh')) audio.playFile('synth/tornado_whoosh', { bus: 'sfx', kind: 'other', self: true, priority: 3, gain: 0.9 })
        }
      } else if (msg.t === 'strike' && msg.strike.source === 'tornado') {
        fx?.strikeArc([msg.strike.pos[0], msg.strike.groundY ?? msg.strike.pos[1], msg.strike.pos[2]], msg.strike.at)
      } else if (msg.t === 'move') shown.delete(msg.id) // a new move (the next pull or the body's own) ends the last one
    },

    onFrame(now) {
      const w = ctx.world()?.world ?? null
      if (w !== world) {
        world = w
        if (fx && wantTier() !== tier) drop()
      }
      const self = ctx.controlledId?.() ?? ctx.selfId()
      let amp = 0
      // thrown and pulled bodies
      for (const [id, d] of shown) {
        const v = ctx.view(id)
        const f = (now - d.at) / d.ms
        if (!v || v.dead || f > 1.6 || f < -2) {
          shown.delete(id)
          continue
        }
        const k = Math.max(0, Math.min(1, f))
        if (d.kind === 'throw') {
          if (f >= 1) continue
          v.root.position.y += throwArc(k, d.peakM)
          const body = v.ride?.actor ?? v.actor
          body?.setYaw(v.yaw + k * Math.PI * 4)
          if (id === self) amp = Math.max(amp, THROWN_SHAKE_AMP * Math.sin(Math.PI * k))
        } else if (!v.move) {
          const x = d.from[0] + (d.to[0] - d.from[0]) * k
          const z = d.from[2] + (d.to[2] - d.from[2]) * k
          const y = d.from[1] + (d.to[1] - d.from[1]) * k
          v.pos.set(x, y, z)
          v.root.position.set(x, ctx.world()?.heightAt(x, z, y) ?? y, z)
        } else shown.delete(id)
      }
      if (!state) {
        shake(amp, now)
        return
      }
      const at = tornadoAt(state, now)
      if (at.phase === 'gone') {
        clear()
        return
      }
      if (!fx) {
        tier = wantTier()
        fx = new TornadoFx(ctx.scene, state.seed, tier)
      }
      const g = ctx.world()
      const ground = g ? g.heightAt(at.pos[0], at.pos[2], at.pos[1]) : at.pos[1]
      const night = world?.skyState.night ?? 0
      const flash = world?.weather.frame.flash ?? 0
      const pos: Vec3 = [at.pos[0], Number.isFinite(ground) ? ground : at.pos[1], at.pos[2]]
      fx.update(now, { pos, presence: at.presence, heading: at.heading, strength: state.strength, light: 0.4 * (1 - 0.8 * night), flash }, ctx.scene.activeCamera)
      const me = listener()
      amp = Math.max(amp, tornadoShake(Math.hypot(pos[0] - me.x, pos[2] - me.z), at.presence))
      shake(amp, now)
      roar(pos, at.presence)
    },

    dispose() {
      for (const off of offs.splice(0)) off()
      setTornadoSource(null)
      clear()
    },
  }
}
