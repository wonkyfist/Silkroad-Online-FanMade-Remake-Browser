/**
 * RND-L's celestial light (docs/RENDER.md §4.1, §4.6, docs/WAVE_PLAN3.md §6.12, H9A lens 6): on the PBR path the
 * celestial DirectionalLight is light 0 of every mesh even when the game made its lights first, it follows
 * SkyState.keyLight, a dark key light stays enabled at intensity 0 so the light count never changes between day and
 * night (no recompile), the retail sun goes off while it runs, the flash adds a fill without a new light, and the
 * Classic path builds none of it. NullEngine, synthetic world.
 */
import { DirectionalLight, HemisphericLight, MeshBuilder, NullEngine, PBRMaterial, PointLight, Scene, Vector3 } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { loadWorld, type RenderWeather, type World } from '../src/index.ts'
import {
  CELESTIAL_LIGHT_NAME,
  LIGHT_CALIBRATIONS,
  WorldLighting,
} from '../src/render/lighting.ts'
import { RenderPost } from '../src/render/post.ts'
import { RENDER_PRESETS } from '../src/render/quality.ts'
import { WorldShadows } from '../src/render/shadows.ts'
import { CLEAR_RENDER_WEATHER } from '../src/render/weather.ts'
import type { SkyState } from '../src/sky/types.ts'
import { ROOT_URL, WORLD_NAME, makeFixture } from './stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

function scene(): Scene {
  const engine = new NullEngine()
  const s = new Scene(engine)
  s.useRightHandedSystem = true
  cleanups.push(() => {
    s.dispose()
    engine.dispose()
  })
  return s
}

async function world(opts: { render?: 'classic' | 'pbr'; before?: (s: Scene) => void } = {}): Promise<{ s: Scene; w: World }> {
  const s = scene()
  opts.before?.(s)
  const w = await loadWorld(s, { baseUrl: ROOT_URL, world: WORLD_NAME, io: makeFixture().io, minimap: false, objects: false, stream: false, quality: 'medium', render: opts.render })
  cleanups.unshift(() => w.dispose())
  return { s, w }
}

/** A PBR mesh (a character or an object on the PBR path). */
function pbrMesh(s: Scene, name = 'pbr') {
  const m = MeshBuilder.CreateBox(name, { size: 1 }, s)
  m.material = new PBRMaterial(`${name}Mat`, s)
  return m
}

describe('the celestial light (PBR path)', () => {
  it('is light 0 of every mesh even when other lights were created first, and the retail sun is off', async () => {
    // The game's character lights exist before the world (screens/world.ts buildWorldScene).
    const { s, w } = await world({
      render: 'pbr',
      before: sc => {
        new HemisphericLight('hemi', new Vector3(0, 1, 0), sc)
        new DirectionalLight('sun', new Vector3(-0.4, -1, -0.5), sc)
      },
    })
    const early = pbrMesh(s, 'early')
    expect(w.render.lighting).toBeInstanceOf(WorldLighting)
    const celestial = s.getLightByName(CELESTIAL_LIGHT_NAME)!
    expect(celestial).toBeInstanceOf(DirectionalLight)
    expect(s.lights[0]).toBe(celestial)
    expect(early.lightSources[0]).toBe(celestial)
    // The world's retail sun (Classic only) is switched off; the terrain meshes list the celestial first too.
    expect(w.sun.isEnabled()).toBe(false)
    for (const m of w.terrain.meshes) expect(m.lightSources[0]).toBe(celestial)
    // Lights and meshes made later keep the order (a hit light, a character).
    new PointLight('hit', new Vector3(0, 1, 0), s)
    const late = pbrMesh(s, 'late')
    expect(late.lightSources[0]).toBe(celestial)
    expect(early.lightSources[0]).toBe(celestial)
  })

  it('follows SkyState.keyLight: direction = −dir, colour, intensity × the calibration', async () => {
    const { s, w } = await world({ render: 'pbr' })
    w.update(null, { x: 96, z: -96 })
    const l = w.render.lighting as WorldLighting
    const k = w.skyState.keyLight
    const d = k.dir.clone().normalize()
    expect(l.celestial.direction.x).toBeCloseTo(-d.x, 6)
    expect(l.celestial.direction.y).toBeCloseTo(-d.y, 6)
    expect(l.celestial.direction.z).toBeCloseTo(-d.z, 6)
    const cal = l.calibration
    const peak = Math.max(...k.color) * k.intensity * cal.sun
    expect(l.celestial.intensity).toBeCloseTo(peak, 5)
    expect(l.celestial.diffuse.r * l.celestial.intensity).toBeCloseTo(k.color[0] * k.intensity * cal.sun, 5)
    expect(s.environmentIntensity).toBeCloseTo(cal.env, 6)
    // The skeleton / classic sky states the retail palette: the classic calibration.
    expect(l.regime).toBe('classic')
    expect(cal).toBe(LIGHT_CALIBRATIONS.classic)
  })

  it('keeps the light count constant across day, night, a dark key light and a flash (no recompile)', async () => {
    const { s, w } = await world({ render: 'pbr' })
    const m = pbrMesh(s)
    const l = w.render.lighting as WorldLighting
    const count = () => m.lightSources.length
    w.setTimeOfDay(0.5)
    w.update(null, { x: 96, z: -96 })
    const day = count()
    expect(m.lightSources[0]).toBe(l.celestial)
    w.setTimeOfDay(0.02)
    w.update(null, { x: 96, z: -96 })
    expect(count()).toBe(day)
    // A key light at zero stays enabled at intensity 0.
    const dark = { ...w.skyState, keyLight: { ...w.skyState.keyLight, intensity: 0 } } as SkyState
    l.update(null, dark)
    expect(l.celestial.intensity).toBe(0)
    expect(l.celestial.isEnabled()).toBe(true)
    expect(count()).toBe(day)
    expect(m.lightSources[0]).toBe(l.celestial)
    // A lightning flash: a brighter, cooler key and more ambient, but no new light.
    const before = l.celestial.intensity
    const flash: RenderWeather = { ...CLEAR_RENDER_WEATHER, flash: 1 }
    w.render.setWeather(flash)
    l.update(null, dark)
    expect(l.celestial.intensity).toBeGreaterThan(before)
    expect(l.celestial.diffuse.b).toBeGreaterThanOrEqual(l.celestial.diffuse.r)
    expect(count()).toBe(day)
    expect(s.lights.length).toBe(new Set(s.lights).size)
  })

  it('builds shadows at the first update, and switching to Classic removes both parts and restores the retail sun', async () => {
    const { s, w } = await world({ render: 'pbr' })
    expect(w.render.shadows).toBeNull()
    w.update(null, { x: 96, z: -96 })
    expect(w.render.shadows).toBeInstanceOf(WorldShadows)
    // Gate 1: the PBR path owns its post part too (D17/D18 need it), built at bind.
    expect(w.render.post).toBeInstanceOf(RenderPost)
    expect(w.render.parts().length).toBe(3 + (w.render.materials ? 1 : 0))
    w.render.setMode('classic')
    expect(w.render.lighting).toBeNull()
    expect(w.render.shadows).toBeNull()
    expect(w.render.post).toBeNull()
    expect(s.getLightByName(CELESTIAL_LIGHT_NAME)).toBeNull()
    expect(w.sun.isEnabled()).toBe(true)
    // And back: a fresh light, first again.
    w.render.setMode('pbr')
    const m = pbrMesh(s)
    expect(m.lightSources[0]).toBe(s.getLightByName(CELESTIAL_LIGHT_NAME))
  })

  it('builds nothing on the Classic path (Low): no celestial light, no environment texture, the retail sun on', async () => {
    const { s, w } = await world()
    w.update(null, { x: 96, z: -96 })
    expect(w.render.lighting).toBeNull()
    expect(w.render.shadows).toBeNull()
    expect(w.render.post).toBeNull()
    expect(s.getLightByName(CELESTIAL_LIGHT_NAME)).toBeNull()
    expect(s.environmentTexture).toBeNull()
    expect(w.sun.isEnabled()).toBe(true)
  })

  it('a stand-alone part: the cube size follows the preset, and dispose leaves the scene clean', () => {
    const s = scene()
    const l = new WorldLighting(s, { quality: RENDER_PRESETS.medium })
    expect(l.env?.size).toBe(32)
    l.setQuality(RENDER_PRESETS.high)
    expect(l.env?.size).toBe(64)
    const env = l.env
    l.setQuality(RENDER_PRESETS.ultra) // same size: the same cube
    expect(l.env).toBe(env)
    l.dispose()
    expect(s.lights.length).toBe(0)
    expect(s.environmentTexture).toBeNull()
  })
})
