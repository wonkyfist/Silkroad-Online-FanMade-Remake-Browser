/**
 * SKY-B's SkyState and the sky's seams (docs/SKY.md §2, §5–6, §8; docs/WAVE_PLAN3.md §6.6, D14, D17, D28): the state
 * stays continuous across midnight, twilight and a `time` jump (no NaN, the key light hands from sun to moon without a
 * step over 5 % of noon); noon fog within ΔE 10 of the retail FogColor; the moon phase and new-moon hiding; the
 * exposure range; the IBL helpers (a constant sky gives a constant cube and SH irradiance π × c); applySkyToLights;
 * the chunk and dome shaders in both languages; the modern style on a World (ground defines, fog, the dome).
 */
import { DirectionalLight, HemisphericLight, NullEngine, Scene, ShaderStore, Vector3, type ShaderMaterial } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { EnvProfile, RGB } from '../src/environment.ts'
import { evaluateProfile } from '../src/environment.ts'
import {
  CLEAR_SKY_WEATHER,
  NOON_AMBIENT_LUMINANCE,
  SKY_CHUNKS,
  SKY_CLOUD_SHADOW_GLSL,
  SKY_CLOUD_SHADOW_WGSL,
  SKY_PRESETS,
  SkySystem,
  applySkyToLights,
  fillSkyCube,
  loadWorld,
  scatterShaders,
  shIrradiance,
  skySH,
  terrainShaders,
  type SkyQuality,
  type SkyState,
  type World,
} from '../src/index.ts'
import { WEATHER_EXPOSURE_GAIN, WEATHER_EXPOSURE_GAIN_NIGHT } from '../src/sky/sky-system.ts'
import { moonFrame, paletteTime } from '../src/sky/celestial.ts'
import { CloudLayer, shellDistance } from '../src/sky/clouds.ts'
import { SKY_DOME_UNIFORMS, skyFragmentGLSL, skyFragmentWGSL, skyVertexGLSL, skyVertexWGSL } from '../src/sky/sky-shaders.ts'
import { ROOT_URL, WORLD_NAME, makeFixture } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

/** Jangan's Env7 keyframes (docs/SKY.md §1 table). */
function janganProfile(): EnvProfile {
  const keys = (rows: Array<[number, number, number, number]>) => rows.map(([time, r, g, b]) => ({ time, r, g, b }))
  const floats = (rows: Array<[number, number]>) => rows.map(([time, value]) => ({ time, value }))
  return {
    id: 15, name: 'Env7',
    sunColor: keys([[0, 1, 1, 1]]),
    skyTopColor: keys([[0, 0.05, 0.07, 0.19], [0.25, 0.31, 0.5, 0.49], [0.5, 0.17, 0.57, 0.95], [0.75, 0.35, 0.47, 0.82], [0.88, 0.36, 0.33, 0.49], [1, 0.05, 0.07, 0.19]]),
    diffuseColor: keys([[0, 0.44, 0.52, 0.57], [0.25, 0.72, 0.7, 0.6], [0.5, 0.73, 0.72, 0.72], [0.75, 0.78, 0.69, 0.54], [0.88, 0.41, 0.42, 0.42], [1, 0.44, 0.52, 0.57]]),
    objectAmbientColor: keys([[0, 0.32, 0.36, 0.39], [0.25, 0.59, 0.62, 0.54], [0.5, 0.68, 0.67, 0.66], [0.75, 0.73, 0.62, 0.46], [0.88, 0.51, 0.49, 0.6], [1, 0.32, 0.36, 0.39]]),
    graph4: keys([[0, 1, 1, 1]]),
    terrainAmbientColor: keys([[0, 1, 1, 1]]),
    terrainShadowColor: keys([[0, 0.02, 0, 0.16], [0.5, 0, 0, 0], [1, 0.02, 0, 0.16]]),
    fogNearPlane: floats([[0, -0.76]]),
    fogFarPlane: floats([[0, -1]]),
    fogColor: keys([[0, 0.15, 0.19, 0.28], [0.25, 0.44, 0.54, 0.42], [0.5, 0.36, 0.58, 0.68], [0.75, 0.31, 0.39, 0.33], [0.88, 0.21, 0.23, 0.34], [1, 0.15, 0.19, 0.28]]),
    graph10: floats([[0, 0.76]]),
    graph11: floats([[0, 1]]),
    graph12: floats([[0, 0.25], [0.25, -0.04], [0.5, 0.52], [0.75, -0.23], [1, 0.25]]),
    skyBottomColor: keys([[0, 0.53, 0.66, 0.75], [0.25, 1, 1, 0.49], [0.5, 0.76, 0.97, 1], [0.75, 1, 0.66, 0.3], [0.88, 0.87, 0.81, 0.89], [1, 0.53, 0.66, 0.75]]),
    waterColor: keys([[0, 0.36, 0.69, 0.62]]),
    graph15: floats([[0, 1], [0.18, -0.71], [0.5, -1], [0.78, -0.82], [0.88, 0.01], [1, 1]]),
  }
}

function modernSky(quality: SkyQuality = SKY_PRESETS.high): { sky: SkySystem; profile: EnvProfile; set: (t: number, days?: number) => void } {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const profile = janganProfile()
  const sky = new SkySystem(scene, evaluateProfile(profile, 0.5), { style: 'modern', quality })
  cleanups.push(() => {
    sky.dispose()
    scene.dispose()
    engine.dispose()
  })
  const set = (t: number, days = 14.77 + t) => sky.setRetail({ env: evaluateProfile(profile, t), t, days, declination: 12, profile })
  return { sky, profile, set }
}

const lum = (c: Readonly<RGB>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
const keyLum = (s: Readonly<SkyState>) => lum(s.keyLight.color) * s.keyLight.intensity
const finite = (s: Readonly<SkyState>) => [
  s.keyLight.intensity, ...s.keyLight.color, s.keyLight.dir.x, s.keyLight.dir.y, s.keyLight.dir.z, ...s.ambient.sky, ...s.ambient.ground,
  ...s.ambient.horizon, ...s.fogColor, s.exposure, s.night, ...(s.sh ?? []), ...s.ground.ambient, ...s.ground.sun,
].every(Number.isFinite)

/** CIE76 ΔE between two sRGB colours. */
function deltaE(a: Readonly<RGB>, b: Readonly<RGB>): number {
  const lab = (c: Readonly<RGB>) => {
    const l = c.map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    const x = (0.4124 * l[0]! + 0.3576 * l[1]! + 0.1805 * l[2]!) / 0.95047
    const y = 0.2126 * l[0]! + 0.7152 * l[1]! + 0.0722 * l[2]!
    const z = (0.0193 * l[0]! + 0.1192 * l[1]! + 0.9505 * l[2]!) / 1.08883
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116)
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
  }
  const p = lab(a), q = lab(b)
  return Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!)
}

describe('SkyState (modern sky)', () => {
  it('stays continuous over a whole day and across midnight: no NaN, the key light never steps over 5 % of noon', () => {
    const { sky, set } = modernSky()
    set(0.4)
    sky.update(0.016, null)
    let prev = keyLum(sky.state)
    let maxStep = 0
    let sawMoon = false
    // One game day in 1/2400 steps (36 s of game time each), wrapping through midnight.
    for (let i = 1; i <= 2400; i++) {
      const t = (0.4 + i / 2400) % 1
      set(t, 14.77 + 0.4 + i / 2400)
      sky.update(0.05, null)
      const s = sky.state
      expect(finite(s), `t ${t}`).toBe(true)
      const k = keyLum(s)
      maxStep = Math.max(maxStep, Math.abs(k - prev))
      prev = k
      if (s.sunElevationDeg < -6 && s.keyLight.color[2] >= s.keyLight.color[0]) sawMoon = true
    }
    expect(maxStep).toBeLessThan(0.43 * 0.05)
    expect(sawMoon).toBe(true)
  })

  it('a time jump builds the LUTs at once and snaps: noon → 04:00 → noon', () => {
    const { sky, set } = modernSky()
    set(0.5)
    sky.update(0.016, null)
    const noonKey = keyLum(sky.state)
    expect(noonKey).toBeCloseTo(0.43, 1)
    const version = sky.lutVersion
    set(4 / 24)
    sky.update(0.016, null)
    const s = sky.state
    expect(finite(s)).toBe(true)
    expect(s.night).toBe(1)
    expect(sky.lutVersion).toBeGreaterThan(version)
    // Full moon: the moon is the key light, bluish, 0.43 × 0.12.
    expect(keyLum(s)).toBeCloseTo(0.43 * 0.12, 2)
    expect(s.keyLight.color[2]).toBe(1)
    expect(s.exposure).toBeGreaterThan(8)
    expect(s.exposure).toBeLessThanOrEqual(160)
    set(0.5)
    sky.update(0.016, null)
    expect(keyLum(sky.state)).toBeCloseTo(noonKey, 3)
    expect(sky.state.exposure).toBeGreaterThan(6)
    expect(sky.state.exposure).toBeLessThan(10)
  })

  it('noon fog is within ΔE 10 of the retail FogColor after grading; the palette follows our sunrise and sunset', () => {
    const { sky, set, profile } = modernSky()
    set(0.5)
    sky.update(0.016, null)
    const retail = evaluateProfile(profile, 0.5).fogColor
    expect(deltaE(sky.state.fogColor, retail)).toBeLessThan(10)
    // SKY §6.4: sunrise 0.227 / sunset 0.773 at +12° map onto the retail 0.25 / 0.75.
    expect(paletteTime(0.5, 12)).toBeCloseTo(0.5, 9)
    expect(paletteTime(0.227, 12)).toBeCloseTo(0.25, 2)
    expect(paletteTime(0.773, 12)).toBeCloseTo(0.75, 2)
    expect(sky.envFor().fogColor).toEqual(sky.state.fogColor)
  })

  it('moon: full = texture 16 and the key light; hidden near new moon (starlight only)', () => {
    const { sky, set } = modernSky()
    set(0, 14.77)
    sky.update(0.016, null)
    expect(sky.state.moon.texture).toBe(16)
    set(0, 29.53 + 0.3)
    sky.update(0.016, null)
    expect(sky.state.moon.texture).toBe(1)
    expect(keyLum(sky.state)).toBeCloseTo(0.43 * 0.03, 3)
    expect(finite(sky.state)).toBe(true)
  })

  it('weather: a cloud over the sun and rain dim the key light; cloud shadows only with the preset', () => {
    const { sky, set } = modernSky()
    set(0.5)
    sky.update(0.016, null)
    const clear = keyLum(sky.state)
    sky.setWeather({ ...CLEAR_SKY_WEATHER, cloudCover: 1, cloudDarkness: 0.85, precipitation: 1, haze: 0.6, flash: 0.5 })
    sky.update(0.016, null)
    expect(keyLum(sky.state)).toBeLessThan(clear * 0.25)
    expect(finite(sky.state)).toBe(true)
    // Overcast: no cloud shadow on the ground (the sky is uniformly grey).
    expect(sky.state.cloudShadow!.w).toBe(0)
    // Haze rebuilds the atmosphere in 40 sliced steps.
    for (let i = 0; i < 45; i++) sky.update(0.016, null)
    expect(finite(sky.state)).toBe(true)
    const med = modernSky(SKY_PRESETS.medium)
    med.set(0.5)
    med.sky.update(0.016, null)
    expect(med.sky.state.cloudShadow).toBeNull()
  })

  // W9 LOOK: the day cap went 1.4 → 1.1 (a day storm read washed out), the night one 1.4 → 1.2 (NIGHT_AMBIENT and
  // STORM_GLOW keep characters readable instead).
  it(`a storm raises the exposure at most ${WEATHER_EXPOSURE_GAIN}× the clear sky's by day, ${WEATHER_EXPOSURE_GAIN_NIGHT}× at night (gate 2)`, () => {
    for (const [t, gain] of [[0.5, WEATHER_EXPOSURE_GAIN], [22 / 24, WEATHER_EXPOSURE_GAIN_NIGHT]] as const) {
      const { sky, set } = modernSky()
      set(t)
      for (let i = 0; i < 400; i++) sky.update(0.05, null)
      const clear = sky.state.exposure
      sky.setWeather({ ...CLEAR_SKY_WEATHER, cloudCover: 1, cloudDarkness: 0.85, precipitation: 1, flash: 0 })
      for (let i = 0; i < 400; i++) sky.update(0.05, null)
      expect(sky.state.exposure, `t ${t}`).toBeGreaterThan(clear)
      // The cap is on the clear sky of the same atmosphere (the storm itself thickens it a little): within 5 %.
      expect(sky.state.exposure, `t ${t}`).toBeLessThanOrEqual(clear * gain * 1.05)
    }
  })
})

describe('IBL data (D14)', () => {
  it('a constant sky fills a constant cube and its SH gives irradiance π × c within 1 %', () => {
    const c: RGB = [0.2, 0.5, 1.5]
    const radiance = (_x: number, _y: number, _z: number, out: [number, number, number]) => {
      out[0] = c[0]; out[1] = c[1]; out[2] = c[2]
      return out
    }
    const faces = fillSkyCube(radiance, 8)
    expect(faces.length).toBe(6)
    for (const f of faces) for (let i = 0; i < f.length; i += 4) expect([f[i], f[i + 1], f[i + 2], f[i + 3]]).toEqual([Math.fround(0.2), 0.5, 1.5, 1])
    const sh = skySH(radiance, 12)
    for (const n of [[0, 1, 0], [1, 0, 0], [0, 0, -1], [0.6, -0.8, 0]] as const) {
      const e = shIrradiance(sh, n[0], n[1], n[2])
      for (let k = 0; k < 3; k++) expect(Math.abs(e[k] - Math.PI * c[k]!) / (Math.PI * c[k]!)).toBeLessThan(0.01)
    }
  })

  it('the modern state carries an SH whose up irradiance is the ambient: a blue sky over a dimmer ground', () => {
    const { sky, set } = modernSky()
    set(0.5)
    sky.update(0.016, null)
    const sh = sky.state.sh!
    expect(sh.length).toBe(12)
    const up = shIrradiance(sh, 0, 1, 0), down = shIrradiance(sh, 0, -1, 0)
    expect(lum(up)).toBeGreaterThan(lum(down))
    // L1 SH smooths the sky: luminance within 15 %, each channel within 25 %.
    expect(Math.abs(lum(up) - lum(sky.state.ambient.sky)) / lum(sky.state.ambient.sky)).toBeLessThan(0.15)
    for (let c = 0; c < 3; c++) expect(Math.abs(up[c] - sky.state.ambient.sky[c]) / sky.state.ambient.sky[c]).toBeLessThan(0.25)
    expect(up[2]).toBeGreaterThan(up[0]) // a blue sky
    const faces = sky.fillSkyCube(4)
    expect(faces.every(f => f.every(Number.isFinite))).toBe(true)
  })
})

describe('applySkyToLights (L2)', () => {
  function lights() {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    return { hemi: new HemisphericLight('hemi', new Vector3(0, 1, 0), scene), sun: new DirectionalLight('sun', new Vector3(-0.4, -1, -0.5), scene) }
  }

  it('gives the game lights their values back at a clear noon and keeps the readability floor at midnight', () => {
    const { sky, set } = modernSky(SKY_PRESETS.low)
    const l = lights()
    set(0.5)
    sky.update(0.016, null)
    expect(lum(sky.state.ambient.sky) / NOON_AMBIENT_LUMINANCE).toBeCloseTo(1, 1)
    const share = applySkyToLights(sky.state, l)
    expect(share).toBeGreaterThan(0.9)
    expect(share).toBeLessThan(1.1)
    expect(l.sun.intensity).toBeCloseTo(1.2, 1)
    expect(l.hemi.intensity).toBeGreaterThan(0.6)
    expect(l.hemi.intensity).toBeLessThan(0.8)
    // Low: the baked direction (light from +X and up).
    expect(l.sun.direction.x).toBeLessThan(0)
    expect(l.sun.direction.y).toBeLessThan(0)
    set(0, 29.9)
    sky.update(0.016, null)
    expect(applySkyToLights(sky.state, l)).toBeGreaterThanOrEqual(0.14 - 1e-9)
    expect(l.sun.intensity).toBeLessThan(0.2)
  })

  it('on the classic sky the retail palette maps to the same noon values', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const profile = janganProfile()
    const sky = new SkySystem(scene, evaluateProfile(profile, 0.5), { style: 'classic', quality: SKY_PRESETS.low })
    cleanups.push(() => {
      sky.dispose()
      scene.dispose()
      engine.dispose()
    })
    sky.setRetail({ env: evaluateProfile(profile, 0.5), t: 0.5, days: null, declination: 12, profile })
    sky.update(0.016, null)
    const l = lights()
    expect(applySkyToLights(sky.state, l)).toBeCloseTo(1, 1)
  })
})

describe('shaders (both languages, no GLSL on WebGPU)', () => {
  it('every sky chunk has the same points in WGSL and GLSL', () => {
    for (const shader of ['terrain', 'water', 'grass'] as const) {
      const c = SKY_CHUNKS[shader]
      if (!c) continue
      expect(Object.keys(c.wgsl ?? {}).sort(), shader).toEqual(Object.keys(c.glsl ?? {}).sort())
    }
  })

  it('the chunks land behind their defines; WGSL carries no GLSL and the reverse', () => {
    const t = terrainShaders([SKY_CHUNKS])
    const g = scatterShaders([SKY_CHUNKS])
    for (const src of [t.fragmentWGSL, g.vertexWGSL, g.fragmentWGSL, SKY_CLOUD_SHADOW_WGSL, skyVertexWGSL, skyFragmentWGSL]) {
      expect(src).not.toMatch(/\btextureLod\b|\bvec[234]\(|\bfloat\b|gl_FragColor|void main/)
    }
    for (const src of [t.fragmentGLSL, g.vertexGLSL, g.fragmentGLSL, SKY_CLOUD_SHADOW_GLSL, skyVertexGLSL, skyFragmentGLSL]) {
      expect(src).not.toMatch(/vec[234]f|@fragment|@vertex|textureSampleLevel|\blet\b|fn /)
    }
    expect(t.fragmentWGSL).toContain('#ifdef SRO_CLOUDSHADOW\nvar cloudNoise: texture_2d<f32>;')
    expect(t.fragmentWGSL).toContain('fn sroCloudShadow(p: vec3f) -> f32')
    expect(t.fragmentGLSL).toContain('float sroCloudShadow(vec3 p)')
    expect(t.uniforms).toEqual(expect.arrayContaining(['skyGround', 'skyGroundSun', 'skyCloudShadow', 'skyCloudProj']))
    expect(t.chunkSamplers).toContain('cloudNoise')
    expect(g.vertexWGSL).toContain('vertexOutputs.vSkyCloud = sroCloudShadow(root')
    // Every dome uniform is declared in both languages.
    for (const n of SKY_DOME_UNIFORMS) {
      expect(skyVertexWGSL + skyFragmentWGSL, n).toContain(`uniform ${n}:`)
      expect(skyVertexGLSL + skyFragmentGLSL, n).toMatch(new RegExp(`uniform (vec4|mat4) ${n};`))
    }
  })

  it('the dome registers its WGSL and GLSL pair and builds its tiers as defines', () => {
    const { sky, set } = modernSky(SKY_PRESETS.ultra)
    set(0.5)
    sky.update(0.016, null)
    expect(ShaderStore.ShadersStoreWGSL['sroSkyFragmentShader']).toBe(skyFragmentWGSL)
    expect(ShaderStore.ShadersStore['sroSkyFragmentShader']).toBe(skyFragmentGLSL)
    const mat = sky.mesh.material as ShaderMaterial
    expect(sky.mesh.name).toBe('skyModern')
    expect(mat.options.defines).toEqual(expect.arrayContaining(['#define SKY_CLOUDS_CUMULUS', '#define SKY_LIGHT_TAPS 3', '#define SKY_CIRRUS', '#define SKY_DETAIL', '#define SKY_MILKYWAY']))
    expect(mat.needAlphaTesting()).toBe(true)
    sky.setQuality(SKY_PRESETS.low)
    expect((sky.mesh.material as ShaderMaterial).options.defines).toEqual(['#define SKY_CLOUDS_RETAIL', '#define SKY_LIGHT_TAPS 1'])
  })
})

describe('celestial and clouds', () => {
  it('the moon frame points its lit limb at the sun, waxing and waning', () => {
    const moon: [number, number, number] = [0, 0.6, -0.8]
    const sun: [number, number, number] = [0.8, 0.6, 0]
    const wax = moonFrame(moon, sun, 5)
    const wane = moonFrame(moon, sun, 25)
    const toward = (u: number[]) => u[0]! * sun[0] + u[1]! * sun[1] + u[2]! * sun[2]
    expect(toward(wax.u)).toBeGreaterThan(0.5)
    expect(toward(wane.u)).toBeLessThan(-0.5)
    for (const f of [wax, wane]) {
      expect(Math.hypot(...f.u)).toBeCloseTo(1, 9)
      expect(f.u[0] * moon[0] + f.u[1] * moon[1] + f.u[2] * moon[2]).toBeCloseTo(0, 9)
    }
  })

  it('the shell sinks toward the horizon; a cloud over the sun occludes it; the drift wraps', () => {
    expect(shellDistance(1)).toBeCloseTo(0, 3)
    expect(shellDistance(0.5)).toBeCloseTo(1.8 / Math.tan(Math.PI / 6), 1)
    expect(shellDistance(0)).toBeCloseTo(Math.sqrt(2 * 1.8 * 6360), 0)
    const layer = new CloudLayer()
    expect(layer.occlusion(0, 0, 0, 0, 1, 0, 0.5, 0)).toBe(0) // no noise yet
    const full = new Uint8Array(4 * 4 * 4).fill(255)
    layer.noise = { width: 4, height: 4, data: full }
    expect(layer.occlusion(0, 0, 0, 0.3, 0.9, 0.1, 0.5, 0)).toBeGreaterThan(0.99)
    layer.noise = { width: 4, height: 4, data: new Uint8Array(64) }
    expect(layer.occlusion(0, 0, 0, 0.3, 0.9, 0.1, 0.5, 0)).toBe(0)
    for (let i = 0; i < 1000; i++) layer.drift(30, -30, 10)
    expect(layer.offsetU).toBeGreaterThanOrEqual(0)
    expect(layer.offsetU).toBeLessThan(1)
    expect(layer.offsetV).toBeGreaterThanOrEqual(0)
    expect(layer.offsetV).toBeLessThan(1)
  })
})

describe('the modern sky on a World', () => {
  async function world(quality: 'low' | 'high' = 'low'): Promise<World> {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    scene.useRightHandedSystem = true
    const fx = makeFixture()
    const w = await loadWorld(scene, { baseUrl: ROOT_URL, world: WORLD_NAME, io: fx.io, minimap: false, objects: false, stream: false, quality })
    cleanups.push(() => {
      w.dispose()
      scene.dispose()
      engine.dispose()
    })
    return w
  }
  const defines = (w: World) => (w.terrain.materials[0]! as ShaderMaterial).options.defines ?? []

  it('switches the dome, the ground defines and the fog; classic again restores HEAD', async () => {
    const w = await world('low')
    expect(defines(w)).toEqual([])
    expect(w.sky.mesh.name).toBe('sky')
    w.setSkyStyle('modern')
    w.setTimeOfDay(0.5)
    w.update(null, { x: 96, z: -96 })
    expect(w.sky.mesh.name).toBe('skyModern')
    expect(w.sky.mesh.isEnabled()).toBe(true)
    expect(w.sky.classic.mesh.isEnabled()).toBe(false)
    expect(defines(w).join(' ')).toContain('SRO_SKY_LIGHT')
    expect(defines(w).join(' ')).not.toContain('SRO_CLOUDSHADOW')
    const fog = w.skyState.fogColor
    expect(w.scene.fogColor.asArray().map(v => +v.toFixed(6))).toEqual(fog.map(v => +v.toFixed(6)))
    // The terrain's fog is the sky's (no retail sqrt tint on the modern sky).
    const fp = (w.terrain.materials[0]! as unknown as { _vectors4: Record<string, { x: number }> })._vectors4.fogColor!
    expect(fp.x).toBeCloseTo(fog[0], 6)
    // Night darkens the Classic ground through its uniforms, not its defines.
    const before = defines(w).slice()
    w.setTimeOfDay(0)
    w.update(null, { x: 96, z: -96 })
    expect(defines(w)).toEqual(before)
    expect(w.skyState.ground.sun[1]).toBeLessThan(0.2)
    w.setSkyStyle('classic')
    w.update(null, { x: 96, z: -96 })
    expect(defines(w).filter(d => /SRO_SKY_LIGHT true|SRO_CLOUDSHADOW true/.test(d))).toEqual([])
    expect(w.sky.mesh.name).toBe('sky')
    expect(w.sky.envFor()).toBe(w.skyState.env)
  })

  it('High: cloud shadows on the ground; the PBR path turns the dome to linear output and the ground light off', async () => {
    const w = await world('high')
    w.setSkyStyle('modern')
    w.update(null, { x: 96, z: -96 })
    expect(defines(w).join(' ')).toContain('SRO_CLOUDSHADOW true')
    expect(w.skyState.cloudShadow).not.toBeNull()
    w.render.mode = 'pbr'
    w.update(null, { x: 96, z: -96 })
    expect(w.sky.outputMode).toBe(1)
    expect(defines(w).join(' ')).not.toContain('SRO_SKY_LIGHT true')
    w.render.mode = 'classic'
    w.update(null, { x: 96, z: -96 })
    expect(w.sky.outputMode).toBe(0)
  })
})
