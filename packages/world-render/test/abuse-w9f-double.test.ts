/**
 * W9F adversarial hunt, lens "double": a term applied twice (two wet terms, two fog terms, two tone maps of the sky,
 * env multipliers on the modern sky, lamp glow twice, cloud dimming twice, emissive exposure twice). Every test here
 * states the single-application rule the code claims in its own comments and shows where it does not hold. NullEngine
 * only; no product code is changed by this file.
 */
import {
  Color3,
  MeshBuilder,
  NullEngine,
  PBRMaterial,
  PointLight,
  Scene,
  Vector2,
} from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { EnvValues } from '../src/environment.ts'
import {
  NIGHT_LIGHT_KINDS,
  NightLights,
  RENDER_PRESETS,
  SharedUniforms,
  loadWorld,
  scatterShaders,
  type NightLightsHost,
  type PlacedModelInfo,
  type RegionListener,
} from '../src/index.ts'
import type { AmbientParticle } from '../src/ambient-fx.ts'
import type { WorldModel, WorldPlacement } from '../../convert/src/world/manifest.ts'
import { NIGHT_EMISSIVE } from '../src/night-lights.ts'
import { LIGHT_CALIBRATIONS, WorldLighting } from '../src/render/lighting.ts'
import { EXPOSURE_TRIM } from '../src/render/post.ts'
import { HeightFog } from '../src/pbr/fog-plugin.ts'
import { GRASS_HDR_DEFINE, RenderGrass, grassHdr, type GrassTarget } from '../src/render/grass-chunks.ts'
import { CLEAR_RENDER_WEATHER, type RenderWeather } from '../src/render/weather.ts'
import { SkySystem } from '../src/sky/sky-system.ts'
import { SKY_PRESETS, type SkyWeather } from '../src/sky/types.ts'
import { ROOT_URL, WORLD_NAME, makeFixture } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function newScene(): Scene {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  cleanups.push(() => {
    scene.dispose()
    engine.dispose()
  })
  return scene
}

/** Jangan profile 0 at t = 0.5 (the calibration test's noon). */
const NOON: EnvValues = {
  sun: [1, 1, 1], skyTop: [0.169, 0.572, 0.943], skyBottom: [0.768, 0.969, 0.993], diffuse: [0.776, 0.772, 0.767],
  objectAmbient: [0.792, 0.791, 0.783], scatter: [1, 1, 1], terrainShadow: [0.07, 0.07, 0.071], fogColor: [0.357, 0.58, 0.677],
  water: [0.36, 0.69, 0.62], g7: -0.76, g8: -1, g10: 0.76, g11: 1,
}

function liveSky(scene: Scene, style: 'classic' | 'modern', weather: SkyWeather, renderMode: 'classic' | 'pbr' = 'pbr'): SkySystem {
  const sky = new SkySystem(scene, NOON, { style, quality: SKY_PRESETS.high })
  cleanups.unshift(() => sky.dispose())
  sky.attach({ renderMode: () => renderMode })
  sky.setWeather(weather)
  sky.setRetail({ env: NOON, t: 0.5, days: 14.77, declination: 12, profile: null })
  for (let i = 0; i < 240; i++) sky.update(0.016, null)
  return sky
}

// KHR PBR Neutral (Babylon's TONEMAPPING_KHR_PBR_NEUTRAL, the PBR presets' default) and the display curve the image
// processing applies after it (Babylon's toGammaSpace: pow 1 / 2.2).
function neutral(c: number[]): number[] {
  const start = 0.8 - 0.04
  const x = Math.min(...c)
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04
  let o = c.map(v => v - offset)
  const peak = Math.max(...o)
  if (peak < start) return o
  const d = 1 - start
  const newPeak = 1 - (d * d) / (peak + d - start)
  o = o.map(v => (v * newPeak) / peak)
  const g = 1 - 1 / (0.15 * (peak - newPeak) + 1)
  return o.map(v => v + (newPeak - v) * g)
}
const toGamma = (v: number) => Math.pow(Math.max(0, v), 1 / 2.2)
/** What the PBR presets' post stack shows for a scene-linear colour at an exposure. */
const pbrDisplay = (c: readonly number[], exposure: number) => neutral(c.map(v => v * exposure)).map(toGamma)

describe('env multipliers on the modern sky: the IBL cube', () => {
  // lighting.ts LIGHT_CALIBRATIONS: "Cube radiance = the sky's radiance × cube, so a mirror shows the dome (cube = dome
  // units per radiance / env)", with `cube` derived from domeScale = 1 / SKY_LDR_PER_LUT. But SkySystem.radiance()
  // returns the LUT × SKY_LDR_PER_LUT × AMBIENT_BOOST (sky-system.ts: `const k = SKY_LDR_PER_LUT * AMBIENT_BOOST`),
  // while the HDR dome (outputMode 1) draws the LUT × hdrScale (1). The diffuse-only AMBIENT_BOOST lands on every
  // mirror, puddle and wet reflection too.
  it('a mirror reflects the modern sky at the dome\'s own brightness (reflection = radiance × cube × environmentIntensity)', () => {
    const scene = newScene()
    const sky = liveSky(scene, 'modern', { cloudCover: 0, cloudDarkness: 0, cirrus: 0, haze: 0, wind: { x: 0, z: 0 }, precipitation: 0, flash: 0 })
    expect(sky.outputMode).toBe(1)
    const cal = LIGHT_CALIBRATIONS.modern
    const rad = sky.radiance()
    // Three directions above the horizon (azimuth, elevation).
    for (const [az, el] of [[0.3, 0.35], [2.0, 0.9], [-1.2, 0.15]] as const) {
      const x = Math.cos(el) * Math.cos(az), y = Math.sin(el), z = Math.cos(el) * Math.sin(az)
      const mirror = rad(x, y, z, [0, 0, 0] as [number, number, number]).map(v => v * cal.cube * cal.env)
      // The dome's colour in that direction, before hdrScale (sky-shaders.ts step 1 = SkySystem.skyAt on the CPU).
      const dome = (sky as unknown as { skyAt(az: number, el: number, out: number[], tmp: number[]): number[] })
        .skyAt(Math.atan2(z, x), el, [0, 0, 0], [0, 0, 0]).map(v => v * sky.hdrScale)
      const ratio = (mirror[0]! + mirror[1]! + mirror[2]!) / (dome[0]! + dome[1]! + dome[2]!)
      // One application: the mirror shows the dome (± 15 %). Measured: 2.5 = AMBIENT_BOOST.
      expect(ratio, `mirror / dome at az ${az} el ${el}`).toBeGreaterThan(0.85)
      expect(ratio, `mirror / dome at az ${az} el ${el}`).toBeLessThan(1.15)
    }
  })
})

describe('double tone mapping of the sky: the classic dome on a PBR preset', () => {
  // Settings allow sky = classic with any PBR preset (settings.ts effectiveGraphics: `sky: s.graphics.sky`). The
  // SkySystem switches outputMode to 1 (linear HDR for the post stack) on the PBR path, and the fog plugin turns the
  // classic fog colour into scene-linear (sRGB → linear ÷ exposure). The classic dome (ClassicSky, a StandardMaterial
  // with display-referred vertex colours) ignores outputMode: the post stack then multiplies it by the exposure trim,
  // tone maps it and gamma-encodes it a second time.
  it('the classic dome keeps its retail display colour on the PBR post stack', () => {
    const weather: SkyWeather = { cloudCover: 0.1, cloudDarkness: 0, cirrus: 0.3, haze: 0, wind: { x: 2, z: 0 }, precipitation: 0, flash: 0 }
    const sky = liveSky(newScene(), 'classic', weather)
    expect(sky.outputMode).toBe(1)
    expect(sky.classic.mesh.isEnabled()).toBe(true)
    // The same dome on the Classic path (outputMode 0): the retail display colours, drawn as they are.
    const ref = liveSky(newScene(), 'classic', weather, 'classic')
    expect(ref.outputMode).toBe(0)
    const retailColors = ref.classic.mesh.getVerticesData('color')!
    const colors = sky.classic.mesh.getVerticesData('color')!
    const pos = sky.classic.mesh.getVerticesData('position')!
    // A vertex just above the horizon, far from the noon sun glow: the retail SkyBottom → SkyTop gradient (display).
    let top = -1
    for (let i = 0; i < pos.length / 3; i++) {
      const y = pos[i * 3 + 1]!
      if (y > 1e-3 && (top < 0 || y < pos[top * 3 + 1]!)) top = i
    }
    const retail = [retailColors[top * 4]!, retailColors[top * 4 + 1]!, retailColors[top * 4 + 2]!]
    expect(retail[2]).toBeGreaterThan(0.9)
    expect(retail[0]).toBeLessThan(0.8)
    // What the PBR dome draws into the HDR target, through the post stack: exposure SkyState.exposure (1) × EXPOSURE_TRIM
    // (no RenderPost in this rig, so the sky takes that default), Neutral, gamma.
    const drawn = [colors[top * 4]!, colors[top * 4 + 1]!, colors[top * 4 + 2]!]
    const shown = pbrDisplay(drawn, sky.state.exposure * EXPOSURE_TRIM)
    for (let c = 0; c < 3; c++) expect(Math.abs(shown[c]! - retail[c]!), `channel ${c}: retail ${retail[c]} shown ${shown[c]!.toFixed(3)}`).toBeLessThan(0.01)
    // Below the horizon the fog colour, likewise.
    let low = -1
    for (let i = 0; i < pos.length / 3; i++) if (pos[i * 3 + 1]! < -1e-3) { low = i; break }
    const shownLow = pbrDisplay([colors[low * 4]!, colors[low * 4 + 1]!, colors[low * 4 + 2]!], sky.state.exposure * EXPOSURE_TRIM)
    for (let c = 0; c < 3; c++) expect(Math.abs(shownLow[c]! - retailColors[low * 4 + c]!)).toBeLessThan(0.01)
  })
})

describe('lamp glow twice: Medium PBR terrain (D29)', () => {
  // WAVE_PLAN3 D29 "Night splat on PBR terrain … Double lighting on High+ → splat on terrain: Low and Medium only; on
  // High+ the cluster lights PBR terrain". Since then Medium became a PBR preset with a cluster of 8 (pool 2
  // fallback): RENDER_PRESETS.medium has path 'pbr', nightLights.cluster 8 and terrainSplat true. The PBR terrain
  // compiles SRO_NIGHT_SPLAT (sroEmit = albedo × splat) and its PBRMaterial also takes the night point lights.
  it('the PBR terrain on Medium is lit by the lamps once (splat or point lights, not both)', async () => {
    const scene = newScene()
    const fx = makeFixture()
    const world = await loadWorld(scene, { baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false, stream: false, quality: 'medium', render: 'pbr' })
    cleanups.unshift(() => world.dispose())
    expect(world.render.mode).toBe('pbr')
    const nl = new NightLights(world, { index: new Map(), autoUpdate: false, focus: () => null })
    cleanups.unshift(() => nl.dispose())
    await world.objectsReady
    await nl.ready
    await new Promise(r => setTimeout(r, 0))
    const data = world.regions.regions[0]!
    const [ox, oy, oz] = data.region.origin
    nl.lights.push({ x: ox + 50, y: oy + (data.terrain.heights[0] ?? 0) + 3, z: oz - 50, kind: NIGHT_LIGHT_KINDS[0]!, owner: -1, seed: 0, fromNight: true })
    nl.bakeRegion(data)
    world.update(null)
    const gpu = world.terrain.region(data.region.id)!
    expect(gpu.path).toBe('pbr')
    const splatOn = !!gpu.textures.nightSplat && !!(world.terrain as unknown as { pbrState: { features: { nightSplat: boolean } } }).pbrState?.features.nightSplat
    const pointLights = nl.points?.lights ?? []
    gpu.mesh.computeWorldMatrix(true)
    gpu.mesh._resyncLightSources()
    const lampsOnTerrain = gpu.mesh.lightSources.filter(l => l instanceof PointLight && pointLights.includes(l as PointLight))
    // One lamp-light path on the PBR terrain.
    expect(splatOn && lampsOnTerrain.length > 0, `splat on: ${splatOn}, lamp point lights on the terrain: ${lampsOnTerrain.map(l => l.name).join(', ')}`).toBe(false)
  })
})

describe('the lightning flash twice on the PBR grass', () => {
  // grass-chunks.ts: the HDR grass carries whatever brightened HEAD's colour "(the night-light splat, the wet sheen, the
  // lightning flash)" as display light added back at 1 / exposure, AND RenderGrass.update adds the flash to its SH
  // ambient ("the lighting's SH (+ the flash)"), exactly as WorldLighting does for the PBR terrain and objects. The
  // weather chunk's `rgb *= 1 + wxC.w × 0.25` is not behind a define (WorldWeather.setFrame writes wxC.w = frame.flash
  // on every path), so on the PBR path the grass takes the flash twice while the terrain around it takes it once.
  it('adds the flash to the grass once (the SH flash, not the Classic multiply as well)', () => {
    const scene = newScene()
    const sky = liveSky(scene, 'classic', { cloudCover: 0.1, cloudDarkness: 0, cirrus: 0.3, haze: 0, wind: { x: 2, z: 0 }, precipitation: 0, flash: 0 })
    const lighting = new WorldLighting(scene, { quality: RENDER_PRESETS.medium })
    cleanups.unshift(() => lighting.dispose())
    const weather: RenderWeather = { ...CLEAR_RENDER_WEATHER }
    const defines = new Set<string>()
    const target: GrassTarget = {
      sharedUniforms: new SharedUniforms(),
      setDefine: (n, on) => void (on ? defines.add(n) : defines.delete(n)),
      setDepthTexture: () => {},
      setOwnFog: () => {},
    }
    const grass = new RenderGrass(target, {
      render: { mode: 'pbr', quality: RENDER_PRESETS.medium, weather, taaJitter: new Vector2(), lighting, shadows: null, post: null, scene },
      sky: { state: sky.state },
    })
    cleanups.unshift(() => grass.dispose())
    grass.update()
    expect(defines.has(GRASS_HDR_DEFINE)).toBe(true)
    const dark = grass.shA.x
    // A flash at its peak: WeatherFrame.flash 3 → RenderWeather.flash 1, wxC.w 3.
    weather.flash = 1
    grass.update()
    const shFlash = grass.shA.x - dark
    expect(shFlash, 'the SH carries the flash (like the PBR terrain)').toBeGreaterThan(0)
    // The Classic flash multiply sits in the grass fragment ahead of the SRO_HDR colour chunk; it may only reach the
    // HDR grass if it is not compiled out there (inside `#ifndef SRO_HDR … #endif`).
    const s = scatterShaders()
    const outsideHdr = (src: string, line: string) => {
      const at = src.indexOf(line)
      expect(at, line).toBeGreaterThan(0)
      const open = src.lastIndexOf('#ifndef SRO_HDR', at)
      return !(open >= 0 && !src.slice(open, at).includes('#endif'))
    }
    const wgslAt = s.fragmentWGSL.indexOf('rgb = rgb * (1.0 + uniforms.wxC.w * 0.25);')
    expect(s.fragmentWGSL.indexOf('#ifdef SRO_HDR', wgslAt)).toBeGreaterThan(wgslAt)
    const reachesHdr = outsideHdr(s.fragmentWGSL, 'rgb = rgb * (1.0 + uniforms.wxC.w * 0.25);') || outsideHdr(s.fragmentGLSL, 'rgb *= 1.0 + wxC.w * 0.25;')
    // What that multiply adds to the HDR output (grassHdr is the fragment's TS twin): a mid-grey grass texel.
    const ref = 0.35, base = 0.35, light = 1, inv = 1 / 8
    const extra = grassHdr(reachesHdr ? ref * (1 + 3 * 0.25) : ref, ref, base, light, inv) - grassHdr(ref, ref, base, light, inv)
    // The proper flash on that texel: its linear albedo × the SH flash. One application: the Classic multiply adds < 5 %.
    const proper = Math.pow(base, 2.2) * shFlash
    expect(extra / proper, `second flash term on the HDR grass: +${extra.toFixed(4)} against the SH flash's ${proper.toFixed(4)}`).toBeLessThan(0.05)
  })
})

describe('emissive exposure: the night lamps on the PBR path', () => {
  // night-lights.ts: "On a PBR material the add is display-referred like Classic's: divided by SkyState.exposure (the
  // post stack multiplies it back)". The post stack multiplies by SkyState.exposure × exposureTrim (EXPOSURE_TRIM
  // 1.4, post.ts), and the other display-referred adds (the rain colour: post.appliedExposure; the grass: exposure ×
  // trim; the highlight overlay: sceneExposure) divide by that product. The lamp glow keeps the trim: 1.4 × Classic.
  it('a PBR lamp glows at the Classic level after the post exposure', () => {
    const scene = newScene()
    const listeners: RegionListener[] = []
    const skyState = { night: 0, exposure: 10 }
    const host: NightLightsHost = {
      scene,
      assets: { json: async <T>() => ({ models: {} }) as T },
      objects: { addRegionListener: l => (listeners.push(l), () => listeners.splice(listeners.indexOf(l), 1)) },
      terrain: {
        sharedUniforms: new SharedUniforms(),
        setRegionTexture: () => true,
        setDefine: () => {},
        onRegionDisposed: { add: () => null, remove: () => true },
      },
      scatter: { sharedUniforms: new SharedUniforms(), setDefine: () => {} },
      render: { quality: { nightLights: RENDER_PRESETS.high.nightLights }, weather: { rain: 0 } },
      skyState,
      addCommitStep: () => () => {},
    }
    const row: AmbientParticle = { kind: 'ambient', efp: 'map/cj_pal_lamp_orange.efp', bone: null, position: [0, 4, 0], night: true }
    const nl = new NightLights(host, { index: new Map([[3, [row]]]), autoUpdate: false, now: () => 0, focus: () => ({ x: 0, y: 0, z: 0 }) })
    cleanups.unshift(() => nl.dispose())
    const lamp = { index: 3, source: 'res\artifact\china\jangan\cj_pal_lamp.bsr', glb: 'm3.glb', sidecar: null, kind: 'static', animations: [], defaultClip: null, lightmappedMeshes: 0, boundsMin: [0, 0, 0], boundsMax: [1, 4, 1] } as unknown as WorldModel
    const info: PlacedModelInfo = { index: 3, source: lamp.source, heightM: 4, isFoliage: false, kind: 'static' }
    const mat = new PBRMaterial('CJ_pal_lamp', scene)
    mat.emissiveColor = new Color3(0, 0, 0)
    const mesh = MeshBuilder.CreateBox('lamp', { size: 1 }, scene)
    mesh.material = mat
    listeners[0]!.placed(-1, lamp, info, [mesh], [{ position: [0, 0, 0], rotation: [0, 0, 0, 1], models: [3] } as unknown as WorldPlacement])
    skyState.night = 1
    nl.update()
    const kind = NIGHT_LIGHT_KINDS.find(k => k.id === 'lampOrange')!
    const classic = kind.color[0] * NIGHT_EMISSIVE
    const shown = mat.emissiveColor.r * skyState.exposure * EXPOSURE_TRIM
    expect(shown / classic, `PBR lamp glow after the post exposure / Classic glow`).toBeCloseTo(1, 1)
  })
})

describe('double tone mapping of the sky: the modern fog colour on the PBR stack', () => {
  // SkySystem.fogAt: the fog colour is the horizon "exposed and tone mapped like the dome" (pow(ACES(lin × exposure),
  // 1 / 2.2)) mixed with the retail FogColor, a display colour. fog-plugin.ts turns it back into scene-linear (sRGB →
  // linear, ÷ exposure), and the post stack exposes, tone maps (KHR Neutral) and gamma-encodes it again. The far
  // terrain, water, grass and the dome below the horizon (fogH) show that second curve; the Classic path shows the
  // colour as designed.
  it('the PBR stack shows SkyState.fogColor as the sky designed it (one tone curve)', () => {
    const scene = newScene()
    for (const t of [0.5, 0]) {
      const sky = new SkySystem(scene, NOON, { style: 'modern', quality: SKY_PRESETS.high })
      cleanups.unshift(() => sky.dispose())
      sky.attach({ renderMode: () => 'pbr' })
      sky.setWeather({ cloudCover: 0.1, cloudDarkness: 0, cirrus: 0.3, haze: 0, wind: { x: 2, z: 0 }, precipitation: 0, flash: 0 })
      sky.setRetail({ env: NOON, t, days: 14.77, declination: 12, profile: null })
      for (let i = 0; i < 240; i++) sky.update(0.016, null)
      const f = sky.state.fogColor
      const exposure = sky.state.exposure * EXPOSURE_TRIM
      // HeightFog.update (what RenderPost calls with its applied exposure and tone map); the post: × exposure, Neutral,
      // gamma.
      const fog = new HeightFog(scene)
      fog.update(sky.state, exposure, 'neutral')
      const shown = pbrDisplay([fog.color.x, fog.color.y, fog.color.z], exposure)
      for (let c = 0; c < 3; c++) expect(Math.abs(shown[c]! - f[c]!), `t ${t} channel ${c}: designed ${f[c]!.toFixed(3)} shown ${shown[c]!.toFixed(3)}`).toBeLessThan(0.03)
    }
  })
})
