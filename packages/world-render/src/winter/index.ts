/**
 * The winter of a world (docs/WINTER.md §7): everything the snow season draws in world-render. `World.winter` holds one;
 * `World.setWeather(frame)` feeds it the frame's snow fields (`cover`, `frost`, `snow`), `World.update` runs it after the
 * weather. Nothing here draws or compiles while there is no snow and no frost (outside the season the world is as
 * before, the Low guard).
 *
 * - Snow cover: the material plugins (winter/plugin.ts; PBR Medium+ and Classic objects) and the Classic chunks
 *   (winter/chunks.ts; the terrain splat and every grass shader) share one define gate: on with the first snow or
 *   frost, off ten seconds after both are gone (one recompile each way, never per frame); the amounts are uniforms.
 * - The grass field: flowers close and the far flower dots go once it freezes (GrassField.setWinter).
 * - Ice: the inland water freezes past FROST_ICE (winter/ice.ts).
 * - Snowfall: the flake box for the weather level (winter/snowfall.ts), rebuilt only on a level change.
 * - The look: `snwA.z` greys the snow under a flat sky (it keeps its relief), `snwA.w` drops the cold tint at night.
 */
import type { AbstractMesh, Camera, Scene } from '@babylonjs/core'
import type { SharedUniforms } from '../shader-chunks.ts'
import type { WeatherFrame } from '../weather/frame.ts'
import type { WeatherLevel } from '../weather/presets.ts'
import { SNOW_DEFINE } from './chunks.ts'
import { POND_PLANTS, WinterIce } from './ice.ts'
import { installSnow, uninstallSnow, type SnowState } from './plugin.ts'
import { Snowfall } from './snowfall.ts'

export { SNOW_DEFINE, WINTER_CHUNKS } from './chunks.ts'
export { applyWinterToEnv } from './env.ts'
export { ICE_LIFT_M, POND_PLANTS, WinterIce } from './ice.ts'
export { SNOW_PLUGIN, SNOW_STD_PLUGIN, SnowState, SroSnowPlugin, SroSnowStdPlugin, attachSnow, installSnow, snowStateOf, uninstallSnow } from './plugin.ts'
export { SNOW_CHUNK_CODE, SNOW_NOISE, snowPbrCode, snowStdCode } from './shaders.ts'
export { SNOWFALL_COUNTS, SNOWFALL_SHADERS, Snowfall } from './snowfall.ts'

/** The frost from which the ponds read as frozen (shared winter.ts FROST_ICE). */
export const WINTER_ICE_FROST = 0.5
/** The snow code stays compiled this long after the last snow and frost are gone (s): no flip-flop at the edge. */
export const SNOW_OFF_DELAY_S = 10

/** What WorldWinter needs of World (World itself; a structural type so tests can pass a stand-in). */
export interface WinterHost {
  readonly scene: Scene
  readonly terrain: { readonly sharedUniforms: SharedUniforms; setDefine(name: string, on: boolean): void }
  readonly scatter: { readonly sharedUniforms: SharedUniforms; setDefine(name: string, on: boolean): void; setWinter?(k: number): void }
  readonly water: { readonly meshes: readonly AbstractMesh[] }
  readonly objects: { meshes(): Iterable<AbstractMesh> }
  /** The converted materials (the pond plants are known by their source model; optional for stand-ins). */
  readonly materials?: { batchRecord(mat: unknown): { readonly model: { readonly source: string } } | null }
  readonly render: { readonly mode: string }
  readonly sky: { readonly state: { readonly night: number } }
  readonly weather: { readonly level: WeatherLevel; readonly precipColor: readonly [number, number, number] }
}

export interface WinterStats {
  /** The snow code is compiled in. */
  on: boolean
  cover: number
  frost: number
  snow: number
  /** Flakes this level can draw, and whether any draw now. */
  flakes: number
  falling: boolean
  /** Water planes frozen, falls iced and plants hidden. */
  frozen: number
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : Number.isFinite(v) ? v : 0)

export class WorldWinter {
  readonly state: SnowState
  private host: WinterHost | null = null
  private frame: Readonly<WeatherFrame> | null = null
  private ice: WinterIce | null = null
  private fall: Snowfall | null = null
  private zeroFor = 0
  private disposed = false
  private readonly flake: [number, number, number] = [0.8, 0.82, 0.85]

  constructor(readonly scene: Scene) {
    this.state = installSnow(scene)
  }

  /** Connects the renderers (World's constructor, once): the Classic chunks' shared values. */
  attach(host: WinterHost): void {
    if (this.host || this.disposed) return
    this.host = host
    const s = this.state
    for (const r of [host.terrain, host.scatter]) {
      r.sharedUniforms.set('snwA', s.a)
      r.sharedUniforms.set('snwB', s.bClassic)
    }
    this.ice = new WinterIce({
      scene: host.scene,
      waterMeshes: () => host.water.meshes,
      objectMeshes: () => host.objects.meshes(),
      pbr: () => host.render.mode === 'pbr',
      pondPlant: m => POND_PLANTS.test(host.materials?.batchRecord(m.material)?.model.source ?? ''),
    })
  }

  /** This frame's weather (World.setWeather): the snow fields are read at the next update. */
  setFrame(f: Readonly<WeatherFrame>): void {
    this.frame = f
  }

  get on(): boolean {
    return this.state.on
  }

  /** Per frame, after the weather (World.update). */
  update(dt: number, camera: Camera | null): void {
    const host = this.host
    if (!host || this.disposed) return
    const f = this.frame
    const cover = clamp01(f?.cover ?? 0)
    const frost = clamp01(f?.frost ?? 0)
    const snow = clamp01(f?.snow ?? 0)
    // the gate: on with the first snow or frost, off SNOW_OFF_DELAY_S after both are gone
    const any = cover > 0.001 || frost > 0.001
    this.zeroFor = any ? 0 : this.zeroFor + Math.max(0, dt)
    const on = any || (this.state.on && this.zeroFor < SNOW_OFF_DELAY_S)
    if (on !== this.state.on) {
      host.terrain.setDefine(SNOW_DEFINE, on)
      host.scatter.setDefine(SNOW_DEFINE, on)
      this.state.setOn(on)
    }
    const cloud = clamp01(f?.cloud ?? 0)
    const sun = clamp01(f?.sun ?? 1)
    const overcast = clamp01((cloud - 0.5) / 0.4) * clamp01(1 - sun)
    this.state.a.set(cover, frost, overcast, clamp01(host.sky.state.night))
    host.scatter.setWinter?.(frost)
    this.ice?.update(frost >= WINTER_ICE_FROST, dt)
    this.updateFall(dt, camera, f, snow)
  }

  private updateFall(dt: number, camera: Camera | null, f: Readonly<WeatherFrame> | null, snow: number): void {
    const host = this.host!
    const level = host.weather.level
    if (this.fall && this.fall.level !== level) {
      this.fall.dispose()
      this.fall = null
    }
    if (!this.fall && level !== 'off' && snow > 0.01) this.fall = new Snowfall(this.scene, level)
    if (!this.fall) return
    // the flakes: the precipitation tint lifted (lit at noon, grey in a storm, dim at night, never glowing)
    const c = host.weather.precipColor
    for (let i = 0; i < 3; i++) this.flake[i] = Math.min(1.2, c[i]! * 1.3 + 0.02)
    this.fall.update(dt, camera, { snow, windX: f?.windX ?? 1, windZ: f?.windZ ?? 0, gustMs: f?.gustMs ?? 0, color: this.flake })
  }

  stats(): WinterStats {
    const f = this.frame
    return {
      on: this.state.on,
      cover: clamp01(f?.cover ?? 0),
      frost: clamp01(f?.frost ?? 0),
      snow: clamp01(f?.snow ?? 0),
      flakes: this.fall?.capacity ?? 0,
      falling: !!this.fall?.drawing,
      frozen: this.ice?.count ?? 0,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ice?.dispose()
    this.ice = null
    this.fall?.dispose()
    this.fall = null
    const host = this.host
    if (host) {
      host.terrain.setDefine(SNOW_DEFINE, false)
      host.scatter.setDefine(SNOW_DEFINE, false)
      for (const r of [host.terrain, host.scatter]) {
        r.sharedUniforms.delete('snwA')
        r.sharedUniforms.delete('snwB')
      }
    }
    uninstallSnow(this.scene)
    this.host = null
    this.frame = null
  }
}
