/**
 * Adversarial hunt, wave 11 (H-11, docs/WAVE_PLAN7.md §6.6 lens 11 "TAA smear and night look"). Each `it` is a failing
 * proof of one finding; F-11 fixes the product code, never this file's expectations.
 *
 * - The TAA answer (G5-11, D4) keys off the town's preset name (`TOWN_PRESETS[...].temporalFix`: High and Ultra), not
 *   off the anti-aliasing the post stack actually runs. The game's Advanced row "Anti-aliasing: TAA"
 *   (apps/game/src/settings.ts `foldAdvanced`: `q.aa = a.aa`) turns TAA on for Medium, and Medium has `hdr: true`, so
 *   planPost builds TAA without reprojection: the walking crowd smears exactly as in TOWN_LIFE F3, and the town never
 *   asks for MSAA ×4.
 * - The carried lanterns (town/props.ts TownLanterns) are an unlit PBR box with a fixed albedo (1, 0.62, 0.28). The
 *   post stack multiplies the whole frame by the sky's exposure (× EXPOSURE_TRIM), which is ≥ 2 and ≈ 24 on a clear
 *   night (measured: the viewer, 21:36, SkyState.exposure 24.29). NightLights divides its lamp emissive by that exposure
 *   (night-lights.ts `setEmissive`, "display-referred"); the lanterns do not, so at night the tone curve drives them to
 *   near white: the "small glowing lantern" of TOWN_LIFE §3.5 / §7.1 reads as a white box, not a warm one.
 * - TOWN_LIFE §7.1 [decision]: the guards' torches and the lantern carriers carry a point light each through
 *   `NightLights.addDynamicLight` (≤ 4, only when it returns true). No town code calls it (props.ts says "No moving light
 *   in v1"), so the carried lanterns light nothing around them, on any preset.
 */
import { ArcRotateCamera, InternalTexture, InternalTextureSource, NullEngine, PBRMaterial, Scene, Vector3 } from '@babylonjs/core'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { World } from '../src/world.ts'
import { stubCrowdAssets, type CrowdAgent, type CrowdPose, type CrowdQuery, type CrowdSchedule } from '../src/town/crowd.ts'
import { DEFAULT_LINES } from '../src/town/bubbles.ts'
import { TownLife, type TownPlan } from '../src/town/index.ts'
import { TownLanterns } from '../src/town/props.ts'
import { installRenderPost } from '../src/render/post.ts'
import { EXPOSURE_TRIM, neutralToneMap } from '../src/render/display.ts'
import { RENDER_PRESETS, WorldRender, type GpuInfo, type RenderQuality } from '../src/index.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

const GPU: GpuInfo = { maxInterStageShaderVariables: 28, maxSampledTexturesPerShaderStage: 16, features: [], vendor: 'amd', architecture: 'rdna-4', isFallbackAdapter: false }

/** A NullEngine scene that can build the post stack (town-seams.test.ts `postScene`). */
function postScene(quality: RenderQuality) {
  const engine = new NullEngine()
  const e = engine as unknown as Record<string, unknown>
  e['createRawTexture3D'] = (_d: unknown, w: number, h: number, d: number, format: number) => {
    const t = new InternalTexture(engine, InternalTextureSource.Raw3D)
    t.baseWidth = t.width = w
    t.baseHeight = t.height = h
    t.baseDepth = t.depth = d
    t.format = format
    t.is3D = true
    t.isReady = true
    return t
  }
  e['updateRawTexture3D'] = () => {}
  engine.getCaps().textureHalfFloatRender = true
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  const camera = new ArcRotateCamera('cam', 0, 1, 14, Vector3.Zero(), scene)
  scene.activeCamera = camera
  const render = new WorldRender(scene, { mode: 'pbr', quality, gpu: GPU })
  cleanups.push(() => {
    render.dispose()
    scene.dispose()
    engine.dispose()
  })
  const post = installRenderPost(render)
  render.attachCamera(camera)
  return { scene, camera, render, post }
}

/** Twenty walkers on a 10 m ring around the origin (the town's area), all of them walking. */
class Walkers implements CrowdSchedule {
  readonly agents: CrowdAgent[] = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, role: 'walker', female: i % 2 === 1, rank: (i + 0.5) / 20 }))
  pose(i: number, q: Readonly<CrowdQuery>, out: CrowdPose): boolean {
    const th = i * 0.31 + q.nowS * 0.14
    out.x = Math.cos(th) * 10
    out.z = Math.sin(th) * 10
    out.y = 0
    out.yaw = th
    out.alpha = 1
    out.rate = 1
    out.clip = 'WALK'
    out.clipT = q.nowS
    out.distM = q.nowS * 1.4 + i
    out.speed = 1.4
    return true
  }
}

function plan(): TownPlan {
  return {
    folk: new Walkers(), routes: { segments: new Float32Array(0), spots: new Float32Array(0) }, plaza: null, animals: null, pond: null,
    lines: DEFAULT_LINES as TownPlan['lines'], area: { x: 0, z: 0, r: 50 },
  }
}

/** The town part on a world whose preset is `preset` and whose post stack runs `quality` (what the game's settings fold). */
function townOn(preset: 'medium' | 'high', quality: RenderQuality) {
  const { scene, camera, render, post } = postScene(quality)
  const world = {
    scene, quality: preset, manifest: { name: 'test' }, heightAt: () => 0, waterLevelAt: () => null, skyState: { t: 0.5 },
    weatherState: { rain: 0 }, life: null, render, materials: null, worldClock: null, assets: null,
  } as unknown as World
  const life = new TownLife({ scene, world }, { plan: () => plan(), assets: (s, d) => stubCrowdAssets(s, d) })
  cleanups.push(() => life.dispose())
  let now = 1_790_000_000
  life.setClock(() => now)
  for (let k = 0; k < 5; k++) {
    now += 0.1
    life.update(camera, 0.1)
  }
  return { life, post }
}

describe('H-11 lens 11: the TAA answer follows the preset name, not the TAA the post runs', () => {
  it('control: High (TAA) with walkers in range swaps TAA for MSAA ×4', () => {
    const { life, post } = townOn('high', RENDER_PRESETS.high)
    expect(life.stats().folk).toBeGreaterThan(0)
    expect(post.plan.aa).toBe('msaa')
    expect(post.plan.stages).not.toContain('taa')
  })

  it('Medium with the Advanced row "Anti-aliasing: TAA" (settings.ts foldAdvanced) draws walkers under TAA without reprojection', () => {
    // What effectiveGraphics hands the renderer for preset Medium + advanced.aa 'taa'.
    const quality: RenderQuality = { ...RENDER_PRESETS.medium, aa: 'taa' }
    const { life, post } = townOn('medium', quality)
    expect(life.stats().folk).toBeGreaterThan(0)
    // The walkers are drawn; the stack still runs TAA (no reprojection: the smear of TOWN_LIFE F3).
    expect({ aa: post.plan.aa, reprojection: post.plan.taaReprojection, override: post.temporalOverride }).toEqual({ aa: 'msaa', reprojection: false, override: 'msaa4' })
  })
})

describe('H-11 lens 11: the carried lanterns at night', () => {
  it('the lantern keeps a warm hue on screen at a clear night\'s exposure (not tone-mapped to white)', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    cleanups.push(() => {
      scene.dispose()
      engine.dispose()
    })
    const lanterns = new TownLanterns(scene, [{ id: 1, role: 'guard', female: false, rank: 0.5 }])
    cleanups.push(() => lanterns.dispose())
    const mat = lanterns.mesh.material as PBRMaterial
    expect(mat.unlit).toBe(true)
    // The frame the post shows: tone(c × exposure × trim), gamma 1/2.2 (render/display.ts). 24.29: the clear night.
    const shown = (exposure: number) => {
      const c = mat.albedoColor
      const k = exposure * EXPOSURE_TRIM
      const t = neutralToneMap([c.r * k, c.g * k, c.b * k])
      return [t[0], t[1], t[2]].map(v => Math.pow(Math.max(0, v), 1 / 2.2))
    }
    const night = shown(24.29)
    // Warm: blue well under red (the lamp kinds' own colour has b / r = 0.28; NightLights keeps it on screen).
    expect(night[2]! / night[0]!).toBeLessThan(0.75)
  })

  it('TOWN_LIFE §7.1: the carriers\' and guards\' lanterns ask the night cluster for a moving light (≤ 4, only when it agrees)', () => {
    const { life } = townOn('high', RENDER_PRESETS.high)
    expect(life.lanterns?.holders ?? 0).toBeGreaterThanOrEqual(0)
    // Neither the lanterns nor the town part has any call that could ask for one (props.ts: "No moving light in v1"),
    // so at night a guard's or carrier's lantern lights nothing around it, on every preset.
    const src = ['props.ts', 'index.ts'].map(f => readFileSync(fileURLToPath(new URL(`../src/town/${f}`, import.meta.url)), 'utf8'))
    expect(src.some(s => /\.addDynamicLight\(/.test(s)), 'a call to NightLights.addDynamicLight in town/props.ts or town/index.ts').toBe(true)
  })
})
