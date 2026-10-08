/**
 * World weather (docs/WEATHER.md §5-7, docs/WAVE_PLAN3.md §4.1, §6.8): everything the weather draws in world-render.
 * `World.weather` holds one; `World.setWeather(frame)` feeds it every frame (`setFrame`) and `World.setWeatherLevel`
 * sizes it (`setLevel`, WEATHER_PRESETS). Owned by WX-R.
 *
 * - The shared `wx*` vectors (one object each, bound by reference into the terrain, water and grass materials, the
 *   rain meshes and the WetnessPlugin): the frame's wetness, puddles, rain, wind and flash, and per update the sky
 *   reflection colours, the sun glint, the Classic-sky overcast light, the camera and the shelter map's placement.
 * - The Classic wet look: the chunk defines per level (weather/chunks.ts), the per-region wet map (its own commit job
 *   after the terrain, bound as the region's `wetMap`), the WetnessPlugin on every converted object material (skipping
 *   unlit and alpha-blended ones; `attachWetness` is exported for the actors), the ripple texture (built when the
 *   level is set).
 * - The shelter map (D20, weather/shelter.ts), the rain, curtain, splashes, drips and bolt (weather/rain.ts).
 * - Wind: the grass chunk, static foliage (plugin, High+), skinned trees (`WorldObjects.setAnimationSpeed(0.8 + 1.4 ×
 *   wind)`, never below the retail speed) and the water animation (`1 + 0.8 × wind` above calm).
 *
 * Nothing here runs or exists before `attach` (World's constructor) and nothing is drawn at level Off: no mesh, no
 * texture, no define (the Low guard). A weather change never changes a define; only the level (Options) does.
 */
import { RawTexture, Texture, Vector4, type AbstractMesh, type BaseTexture, type Camera, type Scene } from '@babylonjs/core'
import type { WorldManifest } from '../../../convert/src/world/manifest.ts'
import type { MaterialDecoratorInfo, ObjectMaterials } from '../materials.ts'
import type { WorldObjects } from '../objects.ts'
import type { RegionData } from '../regions.ts'
import type { WorldScatter } from '../scatter.ts'
import type { SkySystem } from '../sky/sky-system.ts'
import type { SkyStyle } from '../sky/types.ts'
import type { CommitStepAfter } from '../stream.ts'
import type { TerrainRenderer } from '../terrain.ts'
import type { WaterRenderer } from '../water.ts'
import type { SharedUniforms } from '../shader-chunks.ts'
import type { WeatherDefine } from './chunks.ts'
import { applyWeatherToEnv, terrainWeatherLight } from './env.ts'
import { CLEAR_FRAME, type WeatherFrame } from './frame.ts'
import { WEATHER_PRESETS, type WeatherLevel, type WeatherPreset } from './presets.ts'
import { WeatherRain } from './rain.ts'
import { createRippleTexture } from './ripples.ts'
import { WeatherShelter } from './shelter.ts'
import { attachWetness, markWetnessDirty, setWetnessSource, wetnessSourceOf, type WetnessSource } from './wet-plugin.ts'
import { WET_MAP_SIZE, buildWetMap, surfaceLookup } from './wetmap.ts'

export type { WeatherFrame } from './frame.ts'
export type { WeatherLevel, WeatherPreset } from './presets.ts'

/**
 * The shared shader vectors (WEATHER §5.2), one object each, bound by reference into every Classic material and the
 * rain meshes (terrain/water/scatter `sharedUniforms`). WGSL `uniforms.wxA`, GLSL `wxA`:
 *   wxA   wetness, puddle, rain, time (s, mod 3600)
 *   wxB   wind dir x, wind dir z, wind strength 0..1 (gustMs / 20), time (s, the sway phase)
 *   wxC   sky reflection zenith rgb, lightning flash 0..3
 *   wxD   sky reflection horizon rgb, ripple strength 0..1 (= rain)
 *   wxE   direction to the sun xyz, sun glint 0..1 (= sun × daylight)
 *   wxF   shelter map centre y, overcast terrain brightness, lightmap contrast (= sun), 1 when the Classic-sky overcast
 *         terms are on (else they are skipped)
 *   wxCam camera xyz, 1 when the shelter map is valid
 *   wxOcc shelter map centre x, centre z, size (m), 1 / size
 *   wxOccM world xz − centre → the shelter map's clip xy (2 × 2, row-major; weather/shelter.ts mappingFrom)
 */
export interface WeatherUniforms {
  wxA: Vector4
  wxB: Vector4
  wxC: Vector4
  wxD: Vector4
  wxE: Vector4
  wxF: Vector4
  wxCam: Vector4
  wxOcc: Vector4
  wxOccM: Vector4
}

/** The one shelter (rain occlusion) map, D20: weather/shelter.ts implements it. */
export interface ShelterMap {
  /** R16F height relative to the map centre (RGBA8 R+G packed without half-float render support). */
  readonly texture: BaseTexture
  readonly centerX: number
  readonly centerZ: number
  readonly centerY: number
  readonly sizeM: number
  /** False until the first render (and while dry, when it is not rendered at all). */
  readonly valid: boolean
  /** The top of the cover above (x, z) in world metres from the last CPU copy, or null (none / not read yet). */
  topAt(x: number, z: number): number | null
}

export interface WeatherStats {
  level: WeatherLevel
  rain: number
  wet: number
  puddle: number
  /** Rain streaks drawn now. */
  streaks: number
  /** The shelter map is valid. */
  shelter: boolean
  /** Shelter renders so far (none while dry). */
  shelterRenders: number
  /** Regions with a wet map; the last one's build time (ms). */
  wetMaps: number
  wetMapMs: number
}

/** What WorldWeather needs from World (World itself; a structural type so tests can pass a stand-in). */
export interface WeatherHost {
  readonly scene: Scene
  readonly terrain: TerrainRenderer
  readonly water: WaterRenderer
  readonly scatter: WorldScatter
  readonly materials: ObjectMaterials
  readonly objects: WorldObjects
  readonly manifest: WorldManifest
  readonly sky: SkySystem
  readonly skyStyle: SkyStyle
  readonly fogRange: { start: number; end: number }
  /** The render module (World.render): on the HDR path the display-referred rain colour is divided by its exposure. */
  readonly render?: { readonly post: object | null }
  /** W10-S: the coast's ocean (World.ocean; null or absent: none), a shelter candidate like the water. */
  readonly ocean?: { meshes(): readonly AbstractMesh[] } | null
  /**
   * PLAZA-RAIN: the foliage (World.foliage): its band texture (T12-W) lets the shelter map collapse the tree tiers the
   * world does not show, as the tree groups' own vertex stage does (absent or no band: every tier is drawn).
   */
  readonly foliage?: { readonly shared?: { readonly band: BaseTexture | null } | null } | null
  addCommitStep(name: string, run: (region: RegionData) => void, after: CommitStepAfter, debounceMs?: number): () => void
}

/** W9 LOOK: the modern sky's streak colour from the fog colour: greyed by RAIN_GREY, × RAIN_LIFT + RAIN_FLOOR. */
export const RAIN_GREY = 0.35
export const RAIN_LIFT = 1.4
export const RAIN_FLOOR = 0.12

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const sat = (v: number) => clamp01(Number.isFinite(v) ? v : 0)

export class WorldWeather implements WetnessSource {
  /** The shared `wx*` vectors (never replaced: materials hold these objects). */
  readonly u: WeatherUniforms = {
    wxA: new Vector4(0, 0, 0, 0),
    wxB: new Vector4(1, 0, 0, 0),
    wxC: new Vector4(0, 0, 0, 0),
    wxD: new Vector4(0, 0, 0, 0),
    wxE: new Vector4(0, 1, 0, 0),
    wxF: new Vector4(0, 1, 1, 0),
    wxCam: new Vector4(0, 0, 0, 0),
    wxOcc: new Vector4(0, 0, 128, 1 / 128),
    wxOccM: new Vector4(2 / 128, 0, 0, 2 / 128),
  }
  /** The shelter map (null: none at this level). `world.render.rainOcclusion` aliases it. */
  shelter: ShelterMap | null = null
  /** The ripple texture (D21: built when the level is set, never lazily on the first rain). */
  rippleTexture: BaseTexture | null = null
  /** Rain, curtain, splashes, drips, bolt (null at level Off). */
  rain: WeatherRain | null = null
  private shelterMap: WeatherShelter | null = null
  private levelValue: WeatherLevel = 'off'
  private frameValue: Readonly<WeatherFrame> = CLEAR_FRAME
  private host: WeatherHost | null = null
  private readonly offs: Array<() => void> = []
  private wetStepOff: (() => void) | null = null
  private readonly wetMaps = new Map<number, RawTexture>()
  private wetMapMs = 0
  private surfaceOf: ((tileId: number) => number) | null = null
  private clock = 0
  private animSpeed = 1
  private waterRate = 1
  private disposed = false
  private readonly rainColor: [number, number, number] = [0.7, 0.72, 0.75]
  private readonly rainEnv = { color: this.rainColor, boltMaxM: 200 }
  private readonly light = { brightness: 1, contrast: 1 }

  constructor(readonly scene: Scene) {
    setWetnessSource(scene, this)
  }

  get level(): WeatherLevel {
    return this.levelValue
  }

  get preset(): Readonly<WeatherPreset> {
    return WEATHER_PRESETS[this.levelValue]
  }

  get frame(): Readonly<WeatherFrame> {
    return this.frameValue
  }

  /** The precipitation tint of this frame (the rain streaks' colour; docs/WINTER.md §7.4: the flakes start from it). */
  get precipColor(): readonly [number, number, number] {
    return this.rainColor
  }

  /** The shelter texture for the WetnessPlugin (null: none at this level). */
  shelterTexture(): { texture: BaseTexture; packed: boolean } | null {
    return this.shelterMap?.shelterTexture ?? null
  }

  /**
   * Connects the weather to the world (World's constructor, once): the shared vectors on the terrain, water and grass,
   * the object-material decorator, the commit and region listeners the shelter map and the wet maps need. Then applies
   * the level.
   */
  attach(host: WeatherHost): void {
    if (this.host || this.disposed) return
    this.host = host
    const u = this.u
    const bindAll = (shared: SharedUniforms, names: readonly (keyof WeatherUniforms)[]) => {
      for (const n of names) shared.set(n, u[n])
    }
    bindAll(host.terrain.sharedUniforms, ['wxA', 'wxB', 'wxC', 'wxD', 'wxE', 'wxF', 'wxCam', 'wxOcc', 'wxOccM'])
    bindAll(host.water.sharedUniforms, ['wxA', 'wxB', 'wxC', 'wxD', 'wxCam'])
    bindAll(host.scatter.sharedUniforms, ['wxA', 'wxB', 'wxC', 'wxD', 'wxF', 'wxCam', 'wxOcc', 'wxOccM'])
    this.offs.push(host.materials.addDecorator((mat, info) => this.decorate(mat, info)))
    const built = host.terrain.onRegionBuilt.add(g => {
      const c = g.mesh.getBoundingInfo().boundingBox.centerWorld
      this.shelterMap?.markDirty(c.x, c.z, 140)
    })
    const disposed = host.terrain.onRegionDisposed.add(id => this.dropWetMap(id, false))
    this.offs.push(() => {
      host.terrain.onRegionBuilt.remove(built)
      host.terrain.onRegionDisposed.remove(disposed)
    })
    this.offs.push(host.objects.addRegionListener({
      placed: (_region, _model, _info, meshes) => {
        const m = meshes[0]
        if (!m || !this.shelterMap) return
        const bb = m.getBoundingInfo().boundingBox
        this.shelterMap.markDirty(bb.centerWorld.x, bb.centerWorld.z, bb.extendSizeWorld.length())
      },
      removed: () => this.shelterMap?.markDirty(),
      // W10-S (BATCHING §3.1, §3.10): a region batch marks its whole box (its meshes are shelter candidates through
      // World.meshes() / WorldObjects.meshes()).
      batched: (_region, batch) => {
        if (!this.shelterMap) return
        const cx = (batch.min.x + batch.max.x) / 2
        const cz = (batch.min.z + batch.max.z) / 2
        this.shelterMap.markDirty(cx, cz, Math.hypot(batch.max.x - batch.min.x, batch.max.y - batch.min.y, batch.max.z - batch.min.z) / 2)
      },
    }))
    this.surfaceOf = surfaceLookup(host.manifest.tiles as { id: number; typeName?: string | null; file?: string; source?: string }[])
    this.applyLevel()
  }

  /** Objects (ObjectMaterials decorator): every converted material but the unlit and the alpha-blended ones. */
  private decorate(mat: Parameters<typeof attachWetness>[0], info: MaterialDecoratorInfo): void {
    if (info.unlit || info.alpha === 'blend') return
    attachWetness(mat, info.kind, { texture: info.texture, source: info.source, alpha: info.alpha })
  }

  /** The frame of this tick (World.setWeather): the frame-driven parts of the `wx*` vectors. */
  setFrame(f: Readonly<WeatherFrame>): void {
    this.frameValue = f
    const u = this.u
    u.wxA.set(sat(f.wet), sat(f.puddle), sat(f.rain), u.wxA.w)
    u.wxB.set(f.windX, f.windZ, clamp01(f.gustMs / 20), u.wxB.w)
    u.wxC.w = Math.max(0, f.flash || 0)
    u.wxD.w = sat(f.rain)
  }

  /** The weather level (`auto` already resolved by the caller). Builds or drops what the level draws. */
  setLevel(level: WeatherLevel): void {
    if (!(level in WEATHER_PRESETS) || this.disposed) return
    if (level === this.levelValue) return
    this.levelValue = level
    this.applyLevel()
  }

  private applyLevel(): void {
    const host = this.host
    if (!host) return
    const p = this.preset
    const scene = this.scene
    // Shelter first: the defines and the rain depend on it.
    if (p.shelter && !this.shelterMap) {
      const sh = new WeatherShelter(scene, () => this.shelterCandidates(), { treeBand: () => host.foliage?.shared?.band ?? null })
      sh.onRendered = () => this.placeShelter()
      this.shelterMap = sh
      this.shelter = sh
      host.terrain.sharedUniforms.set('wxOccMap', sh.texture)
      host.scatter.sharedUniforms.set('wxOccMap', sh.texture)
    } else if (!p.shelter && this.shelterMap) {
      host.terrain.sharedUniforms.delete('wxOccMap')
      host.scatter.sharedUniforms.delete('wxOccMap')
      this.shelterMap.dispose()
      this.shelterMap = null
      this.shelter = null
      this.u.wxCam.w = 0
    }
    const packed = !!this.shelterMap?.packed
    const defs: Record<'terrain' | 'water' | 'scatter', Partial<Record<WeatherDefine, boolean>>> = {
      terrain: {
        WX: p.wet, WX_REFL: p.wet && p.reflection, WX_PUDDLE: p.wet && p.puddles,
        WX_RIPPLE: p.wet && p.puddles && p.rippleSamples >= 1, WX_RIPPLE2: p.wet && p.puddles && p.rippleSamples >= 2,
        WX_SHELTER: p.wet && p.shelter, WX_OCC8: p.wet && p.shelter && packed,
      },
      water: { WX_WATER: p.rippleSize > 0, WX_RIPPLE2: p.rippleSize > 0 && p.rippleSamples >= 2 },
      scatter: {
        WX: p.wet, WX_WIND: this.levelValue !== 'off' && p.windGrass,
        WX_SHELTER: p.wet && p.shelter, WX_OCC8: p.wet && p.shelter && packed,
      },
    }
    for (const [name, on] of Object.entries(defs.terrain)) host.terrain.setDefine(name, on)
    for (const [name, on] of Object.entries(defs.water)) host.water.setDefine(name, on)
    for (const [name, on] of Object.entries(defs.scatter)) host.scatter.setDefine(name, on)
    // Ripples (built now, never on the first rain).
    const size = p.rippleSize
    const have = this.rippleTexture?.getSize().width ?? 0
    if (size !== have) {
      this.rippleTexture?.dispose()
      this.rippleTexture = size ? createRippleTexture(scene, size) : null
      if (this.rippleTexture) {
        host.terrain.sharedUniforms.set('wxRipple', this.rippleTexture)
        host.water.sharedUniforms.set('wxRipple', this.rippleTexture)
      } else {
        host.terrain.sharedUniforms.delete('wxRipple')
        host.water.sharedUniforms.delete('wxRipple')
      }
    }
    // Rain and friends: rebuilt for the level's counts.
    this.rain?.dispose()
    this.rain = null
    if (p.streaks > 0 || p.curtainLayers > 0) this.rain = new WeatherRain(scene, p, this.u, this.shelterTexture())
    // Wet maps: registered at the next update (the streamer exists by then), dropped now.
    if (!p.puddles) this.dropWetMaps()
    markWetnessDirty(scene)
  }

  /**
   * Terrain, object and water meshes (the shelter map keeps those inside its square at render time). W10-S: the
   * objects include the region batches' meshes (WorldObjects.meshes), and the coast's ocean joins the water (World
   * .ocean); the sky dome of World.meshes() never does (it would shelter everything).
   */
  private *shelterCandidates(): Iterable<AbstractMesh> {
    const host = this.host
    if (!host) return
    yield* host.terrain.meshes
    yield* host.objects.meshes()
    yield* host.water.meshes
    if (host.ocean) yield* host.ocean.meshes()
  }

  /** After a shelter render: the uniforms follow the map now in the texture. */
  private placeShelter(): void {
    const sh = this.shelterMap
    if (!sh) return
    const u = this.u
    u.wxOcc.set(sh.centerX, sh.centerZ, sh.sizeM, 1 / sh.sizeM)
    u.wxOccM.copyFrom(sh.mapping)
    u.wxF.x = sh.centerY
    u.wxCam.w = 1
  }

  /** Per frame, after the environment (World.update order: clock → sky → env → weather → render). */
  update(dt: number, camera: Camera | null): void {
    if (this.disposed) return
    const u = this.u
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0
    this.clock = (this.clock + step) % 3600
    u.wxA.w = this.clock
    u.wxB.w = this.clock
    const cam = camera?.globalPosition ?? null
    if (cam) u.wxCam.set(cam.x, cam.y, cam.z, u.wxCam.w)
    const host = this.host
    if (!host) {
      u.wxCam.w = 0
      return
    }
    const f = this.frameValue
    if (this.preset.puddles && !this.wetStepOff) this.wetStepOff = host.addCommitStep('wetMap', r => this.buildRegionWetMap(r), 'terrain')
    this.updateEnv(f)
    const sh = this.shelterMap
    if (sh) {
      if (cam) sh.update(cam, f.rain, f.wet, performance.now())
      u.wxCam.w = sh.valid ? 1 : 0
    } else u.wxCam.w = 0
    if (this.rain) {
      if (this.rain.bolt) this.rainEnv.boltMaxM = Math.max(60, host.fogRange.end * 0.9)
      this.rain.update(step, camera, f, this.rainEnv)
    }
    // Wind on the water animation and the skinned trees (quantised: the ramps restart only on a real change).
    const calm = clamp01((u.wxB.z - 0.1) / 0.9)
    const rate = Math.round((1 + 0.8 * calm) * 50) / 50
    if (rate !== this.waterRate) {
      this.waterRate = rate
      host.water.setAnimationRate(rate)
    }
    // Skinned trees: 0.8 + 1.4 × wind (WEATHER §6.7) from the mean wind (13 m/s storm = 1), never slower than retail.
    const speed = this.preset.windSkinned ? Math.round(Math.min(2.2, Math.max(1, 0.8 + 1.4 * clamp01(f.windMs / 13))) * 20) / 20 : 1
    if (speed !== this.animSpeed) {
      this.animSpeed = speed
      host.objects.setAnimationSpeed(speed)
    }
  }

  /** Sky reflection colours, the sun glint and the Classic-sky overcast terms from this frame's environment. */
  private updateEnv(f: Readonly<WeatherFrame>): void {
    const host = this.host!
    const u = this.u
    const classic = host.skyStyle === 'classic'
    const base = host.sky.envFor()
    const env = classic ? applyWeatherToEnv(base, f) : base
    const top = env.skyTop, bottom = env.skyBottom
    u.wxC.set(sat(bottom[0] + (top[0] - bottom[0]) * 0.6), sat(bottom[1] + (top[1] - bottom[1]) * 0.6), sat(bottom[2] + (top[2] - bottom[2]) * 0.6), u.wxC.w)
    u.wxD.set(sat(bottom[0]), sat(bottom[1]), sat(bottom[2]), u.wxD.w)
    const sky = host.sky.state
    const d = sky.keyLight.dir
    u.wxE.set(d.x, d.y, d.z, sat(f.sun) * (1 - sat(sky.night)))
    const light = terrainWeatherLight(f, this.light)
    const on = classic && (light.brightness !== 1 || light.contrast !== 1)
    u.wxF.y = light.brightness
    u.wxF.z = light.contrast
    u.wxF.w = on ? 1 : 0
    const k = sky.keyLight.color
    const c = this.rainColor
    if (classic) {
      // Streaks: mix(horizon, sun × 0.5, 0.3), a touch lighter so they read against a dark storm.
      c[0] = sat(u.wxD.x * 0.7 + sat(k[0] * 0.5) * 0.3 + 0.08)
      c[1] = sat(u.wxD.y * 0.7 + sat(k[1] * 0.5) * 0.3 + 0.08)
      c[2] = sat(u.wxD.z * 0.7 + sat(k[2] * 0.5) * 0.3 + 0.08)
    } else {
      // W9 LOOK (modern sky): the streaks take the scene's own horizon brightness (the fog colour, already exposed and
      // weather-darkened), a little lighter and greyer. The retail skyBottom made night-storm rain 5× brighter than the
      // ground around it: white blocks instead of rain.
      const f = sky.fogColor
      const g = 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2]
      for (let i = 0; i < 3; i++) c[i] = sat((f[i]! + (g - f[i]!) * RAIN_GREY) * RAIN_LIFT + RAIN_FLOOR)
    }
    // HDR path: the streaks, curtain, splashes and drips are display colours drawn into the scene-linear target, which
    // the post stack then multiplies by the exposure (8 by day, ~24 at night): without this they draw as white blocks.
    const ex = (host.render?.post as { appliedExposure?: number } | null | undefined)?.appliedExposure ?? 1
    if (ex > 0 && ex !== 1 && Number.isFinite(ex)) for (let i = 0; i < 3; i++) c[i] /= ex
  }

  /** One region's wet map (the 'wetMap' commit job). */
  private buildRegionWetMap(data: RegionData): void {
    const host = this.host
    if (!host || !this.preset.puddles || !this.surfaceOf) return
    const id = data.region.id
    const t0 = performance.now()
    const pixels = buildWetMap(data.terrain, this.surfaceOf)
    const tex = RawTexture.CreateRGBATexture(pixels as Uint8Array<ArrayBuffer>, WET_MAP_SIZE, WET_MAP_SIZE, this.scene, false, false, Texture.BILINEAR_SAMPLINGMODE)
    tex.name = `wetMap_${data.region.x}_${data.region.z}`
    tex.wrapU = Texture.CLAMP_ADDRESSMODE
    tex.wrapV = Texture.CLAMP_ADDRESSMODE
    this.dropWetMap(id, true)
    if (!host.terrain.setRegionTexture(id, 'wetMap', tex)) {
      tex.dispose()
      return
    }
    this.wetMaps.set(id, tex)
    this.wetMapMs = performance.now() - t0
  }

  private dropWetMap(id: number, unbind: boolean): void {
    const tex = this.wetMaps.get(id)
    if (!tex) return
    this.wetMaps.delete(id)
    if (unbind) this.host?.terrain.setRegionTexture(id, 'wetMap', null)
    tex.dispose()
  }

  private dropWetMaps(): void {
    this.wetStepOff?.()
    this.wetStepOff = null
    for (const id of [...this.wetMaps.keys()]) this.dropWetMap(id, true)
  }

  stats(): WeatherStats {
    const f = this.frameValue
    return {
      level: this.levelValue,
      rain: f.rain,
      wet: f.wet,
      puddle: f.puddle,
      streaks: this.rain?.streaks ?? 0,
      shelter: !!this.shelterMap?.valid,
      shelterRenders: this.shelterMap?.renders ?? 0,
      wetMaps: this.wetMaps.size,
      wetMapMs: this.wetMapMs,
    }
  }

  dispose(): void {
    if (this.disposed) return
    for (const off of this.offs.splice(0)) off()
    this.dropWetMaps()
    this.rain?.dispose()
    this.rain = null
    this.shelterMap?.dispose()
    this.shelterMap = null
    this.shelter = null
    this.rippleTexture?.dispose()
    this.rippleTexture = null
    this.disposed = true
    if (wetnessSourceOf(this.scene) === this) setWetnessSource(this.scene, null)
    this.host = null
  }
}

export { attachWetness } from './wet-plugin.ts'
export type { WetSurfaceKind } from './wet-plugin.ts'

/** A mesh the weather made (rain, curtain, splashes, drips, bolt): `metadata.sroWorld === 'weather'`. */
export function isWeatherMesh(mesh: { metadata?: unknown } | null | undefined): boolean {
  return (mesh?.metadata as { sroWorld?: unknown } | null | undefined)?.sroWorld === 'weather'
}
