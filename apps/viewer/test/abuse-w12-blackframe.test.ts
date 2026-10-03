/**
 * H-12 lens 11 (docs/WAVE_PLAN8.md §6.7): a black WebGPU frame / validation with the trees, the terrain, the town and
 * the editor's gizmo in one view. The project rule is "no GLSL reaches WebGPU" (every material has WGSL; the editor
 * even installs `guardGlsl`, which blocks a GLSL pipeline on WebGPU with a never-settling promise and logs
 * "GLSL on WebGPU: …" into `ed.stats().errors`).
 *
 * The editor's Turn tool (E, objects-view.ts `gizmos()`: `rotationGizmoEnabled = true`, the Y ring kept) is Babylon's
 * PlaneRotationGizmo, which draws its swept-angle disc with a `ShaderMaterial('shader', …, { vertex: 'rotationGizmo',
 * fragment: 'rotationGizmo' })` whose sources exist in GLSL only (`Effect.ShadersStore`; no WGSL store entry, no
 * `shaderLanguage` option). The editor runs on WebGPU by default (`createEngine(canvas, q.get('engine') !== 'webgl')`),
 * so the first drag of the turn ring sends a GLSL pipeline to the WebGPU engine: the guard blocks it (the disc never
 * draws, an error is logged on every editor session that turns an object); without the guard Babylon would fetch
 * glslang + twgsl from its CDN at runtime (a download) and compile through them.
 */
import { ShaderLanguage, ShaderMaterial, ShaderStore, type GizmoManager } from '@babylonjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorldPlacement } from '../../../packages/convert/src/world/manifest.ts'
import { CX, CZ, objectWorld, pumpUntil, type ObjectWorld } from '../../../packages/world-render/test/w12-fixture.ts'
import { retailRef } from '../src/editor/object-edits.ts'
import { EditSession } from '../src/editor/session.ts'
import { WorldLink } from '../src/editor/world-link.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

const CENTRE = (CZ << 8) | CX

describe('H-12 blackframe: the editor gizmo on WebGPU (no GLSL reaches WebGPU)', () => {
  it('the Turn tool\'s gizmo materials all have WGSL sources', async () => {
    const w: ObjectWorld = await objectWorld()
    cleanups.push(() => w.dispose())
    await w.run()
    const world = w.world
    const m = world.manifest
    const session = new EditSession({
      world: 'w', originRegion: m.space.originRegion, regions: m.regions.map(r => r.id), placements: m.placements,
      host: { heights: id => world.regions.get(id)?.terrain.heights ?? null, words: id => world.regions.get(id)?.terrain.textures ?? null },
    })
    const link = new WorldLink(world, session, () => {})
    link.install()
    const { ObjectsView } = await import('../src/editor/objects-view.ts')
    const objects = new ObjectsView({
      scene: w.scene, world, session, link,
      ground: (x, z) => world.regions.heightAt(x, z),
      baseGround: (x, z) => session.heights.baseGround(x, z),
      holdHeight: () => false, canEdit: () => true, invalidate: () => {}, say: () => {}, changed: () => {},
    })
    const p = m.placements.filter((x: WorldPlacement) => x.region === CENTRE).at(-1)!
    await pumpUntil(w, objects.select([retailRef(p.region, p.uid)]))
    // E: the turn ring (the editor keeps the Y ring only)
    objects.setMode('turn')
    const gm = (objects as unknown as { gm: GizmoManager | null }).gm
    expect(gm, 'the gizmo manager exists once an object is selected').not.toBeNull()
    const rg = gm!.gizmos.rotationGizmo
    expect(rg?.yGizmo.isEnabled, 'the Y ring is on').toBe(true)
    const glslOnly: string[] = []
    for (const mat of gm!.utilityLayer.utilityLayerScene.materials) {
      if (!(mat instanceof ShaderMaterial)) continue
      const opts = mat.options as { shaderLanguage?: ShaderLanguage }
      const shader = mat.shaderPath as { vertex?: string; fragment?: string } | string
      const name = typeof shader === 'string' ? shader : shader.vertex ?? '?'
      const hasWgsl = !!ShaderStore.ShadersStoreWGSL[`${name}VertexShader`]
      if (opts.shaderLanguage !== ShaderLanguage.WGSL || !hasWgsl) glslOnly.push(`${mat.name}: ${name} (language ${opts.shaderLanguage ?? 'GLSL default'}, WGSL source ${hasWgsl})`)
    }
    expect(glslOnly, 'GLSL-only materials the editor puts on screen while turning an object (WebGPU by default)').toEqual([])
  }, 120_000)
})
