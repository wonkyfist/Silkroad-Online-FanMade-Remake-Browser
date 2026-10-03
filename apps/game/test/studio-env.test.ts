/**
 * The character screens' studio environment (three/studio-env.ts): the radiance follows the screen's lights (the fill's
 * sky colour on top, a neutral horizon, its ground colour below, a soft box towards the key), the gate follows the
 * effective render path (PBR presets only; the Classic path keeps no environment), the cube goes with the scene, and
 * the PBR shader reads it linear (the W9 release verify: read as sRGB, the dusk plaza's studio left the Copper Blade
 * near black at character select).
 */
import { Color3, DirectionalLight, HemisphericLight, InternalTexture, InternalTextureSource, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { effectiveGraphics, normalizeSettings } from '../src/settings.ts'
import { STUDIO_BACK, STUDIO_DECODE, STUDIO_FLOOR, STUDIO_HORIZON, STUDIO_KEY_SHARE, StudioEnvironment, studioOf, studioRadiance } from '../src/three/studio-env.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function scene(): Scene {
  const engine = new NullEngine()
  const s = new Scene(engine)
  s.useRightHandedSystem = true
  cleanups.push(() => {
    if (!s.isDisposed) s.dispose()
    engine.dispose()
  })
  return s
}

/**
 * A scene whose engine makes the raw cube (the NullEngine says it is WebGPU and hands out a bare InternalTexture), so
 * the studio's RawCubeTexture exists and its flags can be read; the uploads are the NullEngine's no-ops.
 */
function uploadingScene(): Scene {
  const s = scene()
  const engine = s.getEngine() as NullEngine
  Object.defineProperty(engine, 'isWebGPU', { value: true, configurable: true })
  engine.createRawCubeTexture = (_data, size, format, type, generateMipMaps) => {
    const t = new InternalTexture(engine, InternalTextureSource.CubeRaw)
    t.isCube = true
    t.width = t.height = t.baseWidth = t.baseHeight = size
    t.format = format
    t.type = type
    t.generateMipMaps = generateMipMaps
    t.isReady = true
    return t
  }
  cleanups.unshift(() => {
    delete (engine as { isWebGPU?: boolean }).isWebGPU
  })
  return s
}

const at = (r: ReturnType<typeof studioRadiance>, x: number, y: number, z: number) => {
  const l = Math.hypot(x, y, z)
  return r(x / l, y / l, z / l, [0, 0, 0]).map(v => +v.toFixed(6))
}

describe('studio radiance', () => {
  it('top, horizon and floor, with the soft box towards the key', () => {
    const r = studioRadiance({ top: [1, 0.8, 0.6], horizon: [0.4, 0.4, 0.4], floor: [0.1, 0.05, 0], toKey: [0, 0, 1], box: [2, 2, 2] })
    // Across the key's side (x): half way between the lit front and the backdrop.
    const side = STUDIO_BACK + (1 - STUDIO_BACK) * 0.5
    expect(at(r, 0, 1, 0)).toEqual([1 * side, 0.8 * side, 0.6 * side].map(v => +v.toFixed(6)))
    expect(at(r, 1, 0, 0)).toEqual([0.4 * side, 0.4 * side, 0.4 * side].map(v => +v.toFixed(6)))
    expect(at(r, 0, -1, 0)).toEqual([0.1 * side, 0.05 * side, 0].map(v => +v.toFixed(6)))
    // Straight at the key: the lit horizon plus the whole box; behind the character, the dark backdrop.
    expect(at(r, 0, 0, 1)).toEqual([2.4, 2.4, 2.4])
    expect(at(r, 0, 0, -1)).toEqual([0.4 * STUDIO_BACK, 0.4 * STUDIO_BACK, 0.4 * STUDIO_BACK].map(v => +v.toFixed(6)))
    // Without a key: an even studio.
    const even = studioRadiance({ top: [1, 0.8, 0.6], horizon: [0.4, 0.4, 0.4], floor: [0.1, 0.05, 0] })
    expect(at(even, 0, 1, 0)).toEqual([1, 0.8, 0.6])
    expect(at(even, 0, 0, -1)).toEqual([0.4, 0.4, 0.4])
    // Monotonic from the floor up.
    const lum = (c: number[]) => c[0]! + c[1]! + c[2]!
    expect(lum(at(r, 1, -0.5, 0))).toBeLessThan(lum(at(r, 1, 0, 0)))
    expect(lum(at(r, 1, 0.5, 0))).toBeGreaterThan(lum(at(r, 1, 0, 0)))
  })

  it("follows a screen's lights: the fill's colours at fill + half the key, neutral walls, a lit floor, the box where the key comes from", () => {
    const s = scene()
    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), s)
    hemi.intensity = 0.5
    hemi.diffuse = new Color3(1, 1, 1)
    hemi.groundColor = new Color3(0.2, 0.1, 0)
    const key = new DirectionalLight('key', new Vector3(0, -1, -1).normalize(), s)
    key.intensity = 1
    const r = studioOf({ hemi, key })
    const level = 0.5 + STUDIO_KEY_SHARE * 1 // the top: white at fill + half the key
    const walls = level * STUDIO_HORIZON
    const bounce = walls * STUDIO_FLOOR
    const round = (v: number[]) => v.map(x => +x.toFixed(6))
    // Straight down, across the key's side: the floor (the fill's ground colour + the bounce) half way to the backdrop.
    const across = STUDIO_BACK + (1 - STUDIO_BACK) * 0.5
    expect(at(r, 0, -1, 0)).toEqual(round([(0.2 * level + bounce) * across, (0.1 * level + bounce) * across, bounce * across]))
    // Behind the character (away from the key): the walls at the backdrop's share.
    expect(at(r, 0, 0, -1)).toEqual(round([walls * STUDIO_BACK, walls * STUDIO_BACK, walls * STUDIO_BACK]))
    // Up towards the key: the top plus the soft box.
    expect(at(r, 0, 0.9, 0.44)[0]).toBeGreaterThan(level * 1.5)
    // Without a key: the fill alone, even all round.
    expect(at(studioOf({ hemi }), 0, 1, 0)).toEqual([0.5, 0.5, 0.5])
    expect(at(studioOf({ hemi }), 1, 0, 0)).toEqual(round([0.5 * STUDIO_HORIZON, 0.5 * STUDIO_HORIZON, 0.5 * STUDIO_HORIZON]))
    expect(at(studioOf({ hemi }), 0, 0, -1)).toEqual(round([0.5 * STUDIO_HORIZON, 0.5 * STUDIO_HORIZON, 0.5 * STUDIO_HORIZON]))
    // The key shines from (0, 1, 1): brighter there than the plain gradient at the same height.
    expect(at(r, 0, 1, 1)[0]).toBeGreaterThan(at(r, 0, 1, -1)[0])
    // Nothing is negative anywhere (the half-float cube clamps it to 0).
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2
      for (const y of [-1, -0.3, 0, 0.3, 1]) for (const v of at(r, Math.cos(a), y, Math.sin(a))) expect(v).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('StudioEnvironment', () => {
  it('the gate: the PBR presets want it, the Classic path (Low, or the preview off) does not', () => {
    const pbr = (preset: 'low' | 'medium' | 'high' | 'ultra', rollout: 'on' | 'preview' = 'on') => effectiveGraphics(normalizeSettings({ graphics: { preset } }), { rollout }).render === 'pbr'
    expect([pbr('low'), pbr('medium'), pbr('high'), pbr('ultra')]).toEqual([false, true, true, true])
    expect(pbr('medium', 'preview')).toBe(false)
  })

  it('binds nothing on the Classic path, follows the gate, and goes with the scene', () => {
    const s = scene()
    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), s)
    let want = false
    const studio = new StudioEnvironment(s, { hemi }, () => want)
    expect(s.environmentTexture).toBeNull()
    expect(studio.texture).toBeNull()
    // Headless: the cube stays on the CPU (no upload, no scene.environmentTexture), but the switch runs.
    want = true
    studio.sync()
    const env = (studio as unknown as { env: { refreshes: number } | null }).env
    expect(env?.refreshes).toBe(1)
    want = false
    studio.sync()
    expect((studio as unknown as { env: unknown }).env).toBeNull()
    expect(s.environmentTexture).toBeNull()
    want = true
    studio.sync()
    s.dispose()
    expect((studio as unknown as { env: unknown }).env).toBeNull()
  })

  it('binds a linear-read cube on a real engine (an sRGB read left the blade near black at character select)', () => {
    expect(STUDIO_DECODE).toBe('linear')
    const s = uploadingScene()
    // Character select's plaza lights (three/backdrop.ts buildPlaza): the dim dusk fill and the moon.
    const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), s)
    hemi.intensity = 0.55
    hemi.diffuse = new Color3(0.75, 0.78, 0.95)
    hemi.groundColor = new Color3(0.2, 0.16, 0.12)
    const moon = new DirectionalLight('moon', new Vector3(0.4, -1, -0.6).normalize(), s)
    moon.intensity = 0.7
    const studio = new StudioEnvironment(s, { hemi, key: moon }, () => true)
    const tex = studio.texture
    expect(tex).not.toBeNull()
    expect(s.environmentTexture).toBe(tex)
    expect(tex!.name).toBe('studioEnvironment')
    // No GAMMAREFLECTION: the PBR shader takes the half-float radiance as it is.
    expect(tex!.gammaSpace).toBe(false)
    // Specular only: the empty polynomial adds no diffuse light.
    const poly = tex!.sphericalPolynomial!
    for (const k of ['x', 'y', 'z', 'xx', 'yy', 'zz', 'yz', 'zx', 'xy'] as const) expect(poly[k].length()).toBe(0)
    // The edge-on blade in the idle pose mirrors the backdrop behind the character (world −z, the camera's far side).
    // Read linear it shows ≈ 0.3; read as sRGB it came back below 0.1, near black on a metal.
    const back = at(studioOf({ hemi, key: moon }), 0, 0, -1)
    const lum = 0.2126 * back[0]! + 0.7152 * back[1]! + 0.0722 * back[2]!
    expect(lum).toBeGreaterThan(0.25)
    expect(Math.pow(lum, 2.2)).toBeLessThan(0.1)
    studio.dispose()
    expect(s.environmentTexture).toBeNull()
  })
})
