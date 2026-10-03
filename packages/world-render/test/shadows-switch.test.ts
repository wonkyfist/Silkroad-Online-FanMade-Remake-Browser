/**
 * The receivers' shadow defines across a preset switch (render/shadows.ts; the W9 release verify 2, low-confidence
 * finding): Babylon sets SHADOWn only while the generator's render list is non-empty, decides it only when the
 * material's light defines are dirty, and nothing marks them when the list is replaced. A switch that built a new
 * CascadedShadowGenerator (Medium 1024 × 2 ↔ High 2048 × 3) left it with an empty list until the next refresh, so a
 * receiver checked in between (the warm-up's isReady, a frame while rAF was stalled) lost SHADOW0 for good: Medium
 * showed no shadows on anything until `scene.markAllMaterialsAsDirty`. The NullEngine builds a real
 * CascadedShadowGenerator here (the CSM feature on, a stand-in depth texture), so the defines are Babylon's own.
 */
import { DirectionalLight, InternalTexture, MeshBuilder, NullEngine, PBRMaterial, Scene, Vector3, type AbstractMesh, type Mesh } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { RegionData } from '../src/index.ts'
import { RENDER_PRESETS } from '../src/render/quality.ts'
import { WorldShadows, type ShadowHost } from '../src/render/shadows.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

/** A NullEngine that builds CascadedShadowGenerators (CSM on, a stand-in for the depth texture it cannot make). */
function csmScene(): Scene {
  const engine = new NullEngine()
  const e = engine as unknown as { _features: { supportCSM: boolean }; _createDepthStencilTexture: () => InternalTexture }
  e._features.supportCSM = true
  e._createDepthStencilTexture = () => new InternalTexture(engine, 0)
  const s = new Scene(engine)
  s.useRightHandedSystem = true
  cleanups.push(() => {
    s.dispose()
    engine.dispose()
  })
  return s
}

function world(s: Scene) {
  const terrain = MeshBuilder.CreateGround('terrain', { width: 192, height: 192 }, s)
  terrain.material = new PBRMaterial('terrain', s)
  const host: ShadowHost = {
    objects: { addRegionListener: () => () => {} },
    terrain: { meshes: [terrain] },
    regions: { regions: [] as RegionData[] },
    addCommitStep: () => () => {},
  }
  const hero = MeshBuilder.CreateBox('hero', { size: 1.8 }, s)
  hero.material = new PBRMaterial('hero', s)
  hero.position.y = 1
  hero.computeWorldMatrix(true)
  return { host, terrain, hero }
}

/** The receiver's SHADOW0 as a new frame's material check decides it (a new render id: no same-frame shortcut). */
function shadow0(s: Scene, m: Mesh): boolean {
  s.incrementRenderId()
  m.isReady(true)
  return (m.subMeshes[0]!.materialDefines as unknown as Record<string, unknown>).SHADOW0 === true
}

describe('WorldShadows: the receivers keep SHADOW0 across a generator swap', () => {
  it('a receiver checked between the switch and the next refresh keeps its shadows (Medium → High → Medium)', () => {
    const s = csmScene()
    const { host, terrain, hero } = world(s)
    const light = new DirectionalLight('celestial', new Vector3(-0.3, -1, -0.2), s)
    const sh = new WorldShadows(s, light, host, { quality: RENDER_PRESETS.medium })
    cleanups.push(() => sh.dispose())
    sh.addCharacter(hero)
    const cam = { globalPosition: new Vector3(0, 10, 12) } as never
    sh.update(cam)
    expect(sh.generator?.getClassName()).toBe('CascadedShadowGenerator')
    expect(sh.casters).toContain(hero)
    expect([shadow0(s, terrain), shadow0(s, hero)]).toEqual([true, true])
    for (const next of [RENDER_PRESETS.high, RENDER_PRESETS.medium]) {
      const before = sh.generator
      sh.setQuality(next)
      expect(sh.generator).not.toBe(before) // 1024 × 2 ↔ 2048 × 3: a new generator
      // The receivers are checked before any refresh (the warm-up, or no frame ran), then again after it.
      expect([shadow0(s, terrain), shadow0(s, hero)]).toEqual([true, true])
      sh.update(cam)
      expect(sh.generator!.getShadowMap()!.renderList!.map(m => m.name)).toEqual(sh.casters.map(m => m.name))
      expect([shadow0(s, terrain), shadow0(s, hero)]).toEqual([true, true])
    }
  })

  it('a list that turns non-empty or empty re-decides the receivers (no stale SHADOW0 either way)', () => {
    const s = csmScene()
    const { host, terrain, hero } = world(s)
    const light = new DirectionalLight('celestial', new Vector3(-0.3, -1, -0.2), s)
    const sh = new WorldShadows(s, light, host, { quality: RENDER_PRESETS.medium })
    cleanups.push(() => sh.dispose())
    const cam = { globalPosition: new Vector3(0, 10, 12) } as never
    // Medium casts no terrain: with no character yet the list is empty, and nothing receives a shadow.
    sh.update(cam)
    expect(sh.casters).toEqual([])
    expect(shadow0(s, terrain)).toBe(false)
    // A character comes into range: the list fills at the refresh, and the terrain (checked before) now receives.
    sh.addCharacter(hero)
    sh.update(cam)
    expect(sh.casters).toContain(hero)
    expect(shadow0(s, terrain)).toBe(true)
    // It leaves: the list empties and the receivers stop sampling a shadow map nothing draws into.
    sh.removeCharacter(hero)
    sh.update(cam)
    expect(sh.casters).toEqual([])
    expect(shadow0(s, terrain)).toBe(false)
  })

  it('the first generator (the PBR path entered) also gets its receivers once the casters arrive', () => {
    const s = csmScene()
    const { host, terrain, hero } = world(s)
    const light = new DirectionalLight('celestial', new Vector3(-0.3, -1, -0.2), s)
    const sh = new WorldShadows(s, light, host, { quality: RENDER_PRESETS.high })
    cleanups.push(() => sh.dispose())
    sh.addCharacter(hero)
    terrain.receiveShadows = true
    // Checked before the first update (an empty list): no shadow yet, and the define must not stick.
    expect(shadow0(s, terrain)).toBe(false)
    sh.update({ globalPosition: new Vector3(0, 10, 12) } as never)
    expect(sh.casters.length).toBeGreaterThan(0)
    expect(shadow0(s, terrain)).toBe(true)
    expect((sh.casters as AbstractMesh[]).includes(terrain)).toBe(true) // High: the terrain casts too
  })
})
