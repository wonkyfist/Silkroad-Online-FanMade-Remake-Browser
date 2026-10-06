/**
 * Winter on the client (docs/WINTER.md §8): what the snow season adds around the characters and in the speakers. The
 * snow itself (cover, frost, ice, flakes, the grade) is world-render's, fed through the weather frame by the weather
 * feature (world/features/weather.ts + world/winter/client.ts); this feature reads that frame and adds:
 *
 * - **Footprints** (world/winter/prints.ts): every walker near the camera leaves prints in snow deep enough.
 * - **Breath** (world/winter/breath.ts): people near the camera breathe out small puffs while it is cold.
 * - **Sound** (audio/winter.ts): crunchy footsteps on snow (the retail snow steps), a muffled ambience under snow with
 *   the birds silent while it snows, and the synthesized blizzard howl that swells with the blizzard.
 *
 * Nothing is made before the first snow or frost; everything is disposed with the world visit (no leak).
 * `window.__sroWinter` shows the counts.
 */
import type { GameAudio } from '../../audio/index.ts'
import { HOWL_EVERY_S, WINTER_SYNTH, howlGain, muffleGain } from '../../audio/winter.ts'
import type { WorldFeature, WorldFeatureContext } from '../features.ts'
import { BREATH_EMITTERS, BREATH_RANGE_M, BreathPuffs, type Breather } from '../winter/breath.ts'
import { PRINT_RANGE_M, SnowPrints } from '../winter/prints.ts'
import { shelteredAt } from './weather.ts'

/** A walker counts as on the ground within this of the ground height (m): a jump or a rider leaves no print. */
const ON_GROUND_M = 0.35

export function winterFeature(ctx: WorldFeatureContext): WorldFeature {
  const audio: GameAudio | undefined = ctx.app?.audio
  let prints: SnowPrints | null = null
  let breath: BreathPuffs | null = null
  let prepared = false
  let howlAt = 0
  let howlB = false
  let birdsMuted = false
  let clock = 0
  const walkers: { id: number; x: number; y: number; z: number }[] = []
  const people: Breather[] = []

  const debug = typeof window !== 'undefined' ? (window as unknown as { __sroWinter?: unknown }) : null
  if (debug) {
    debug.__sroWinter = {
      get prints() {
        return prints?.stats() ?? null
      },
      get breath() {
        return breath?.count ?? 0
      },
    }
  }

  /** The walkers and the breathers near the camera this frame (reused arrays). */
  const gather = (groundY: (x: number, z: number, y: number) => number) => {
    walkers.length = 0
    people.length = 0
    const cam = ctx.camera.position
    for (const v of ctx.views()) {
      const kind = v.state.kind
      if (kind !== 'player' && kind !== 'mob' && kind !== 'npc') continue
      const p = v.root.position
      const d = Math.hypot(p.x - cam.x, p.z - cam.z)
      if (d > PRINT_RANGE_M) continue
      const g = groundY(p.x, p.z, p.y)
      if (Math.abs(p.y - g) > ON_GROUND_M || v.ride) continue
      walkers.push({ id: v.state.id, x: p.x, y: g, z: p.z })
      if (kind !== 'mob' && d <= BREATH_RANGE_M && people.length < BREATH_EMITTERS) people.push({ id: v.state.id, x: p.x, y: p.y, z: p.z, yaw: v.yaw })
    }
  }

  const sound = (cover: number, snow: number, gustMs: number, sheltered: boolean) => {
    if (!audio) return
    audio.setSnowCover(cover)
    audio.setAmbientMuffle(muffleGain(cover, snow))
    const mute = birdsMuted ? snow > 0.1 : snow > 0.15
    if (mute !== birdsMuted) {
      birdsMuted = mute
      audio.ambient.mute('winter', mute)
    }
    const gain = howlGain(snow, gustMs, sheltered)
    if (gain < 0.02) return
    if (!prepared) {
      prepared = true
      for (const [id, make] of Object.entries(WINTER_SYNTH)) audio.prepareSynth(id, make)
    }
    if (clock < howlAt) return
    // until the synthesized buffers are decoded, play nothing (a miss would ask the server for the file)
    if (!audio.bank.get('synth/winter_howl_a') || !audio.bank.get('synth/winter_howl_b')) return
    howlAt = clock + HOWL_EVERY_S
    howlB = !howlB
    audio.playFile(howlB ? 'synth/winter_howl_b' : 'synth/winter_howl_a', { bus: 'ambient', kind: 'other', self: true, priority: 1, gain: 0.85 * gain })
  }

  return {
    onFrame(_now, dt) {
      clock += Math.max(0, dt)
      const ground = ctx.world()
      const world = ground?.world ?? null
      const f = world?.weatherState
      const cover = f?.cover ?? 0
      const frost = f?.frost ?? 0
      const snow = f?.snow ?? 0
      if (!world || (cover <= 0 && frost <= 0 && snow <= 0 && !prints && !breath)) {
        if (audio && (cover > 0 || birdsMuted)) sound(0, 0, 0, false)
        return
      }
      gather((x, z, y) => ground!.heightAt(x, z, y))
      prints ??= new SnowPrints(ctx.scene)
      prints.update(dt, walkers, cover, snow)
      breath ??= new BreathPuffs(ctx.scene)
      breath.update(dt, ctx.scene.activeCamera, people, frost, { x: f?.windX ?? 0, z: f?.windZ ?? 0, ms: f?.windMs ?? 0 }, world.weather.precipColor)
      const self = ctx.controlledId?.() ?? ctx.selfId()
      const at = self !== null ? ctx.view(self)?.root.position : undefined
      sound(cover, snow, f?.gustMs ?? 0, at ? shelteredAt(world, at.x, at.y, at.z) : false)
    },

    onMessage(msg) {
      // a new world visit: no trail across the warp
      if (msg.t === 'worldEnter') prints?.trail.clear()
    },

    dispose() {
      prints?.dispose()
      breath?.dispose()
      prints = null
      breath = null
      if (audio) {
        audio.setSnowCover(0)
        audio.setAmbientMuffle(1)
        if (birdsMuted) audio.ambient.mute('winter', false)
      }
      if (debug) delete debug.__sroWinter
    },
  }
}
