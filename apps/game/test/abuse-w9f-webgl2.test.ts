/**
 * W9F adversarial hunt, lens "webgl2" (what the players get over plain http today). Tests that FAIL here are the
 * findings; the browser evidence (a private production preview on :5181 with a WebGL2 probe, a private server on
 * :7391 with the real jangan-fields export) is in the hunt's report.
 *
 * X1 (render): a WebGL2 context loss (a driver reset, a dual-GPU laptop switching GPUs, sleep/resume, Chrome's GPU
 * process restart) blacks out the modern path for good. Babylon restores a lost context by re-creating each texture
 * from what it kept: a URL, or the CPU copy (`_bufferView`) of a raw texture. The wave-9 streams keep neither: the
 * PBR map sets are `createMippedTexture` (RawTexture(null)) filled level by level with texSubImage2D, and the
 * terrain tile and map arrays are filled layer by layer after creation. In the browser, after
 * `WEBGL_lose_context.loseContext()` + `restoreContext()` on High (WebGL2, streamed world), the terrain, the sky and
 * every hero-textured character stay black until a reload (183 of 684 raw textures without restorable data); Low
 * recovers in a second. Nothing in world-render or the game listens to `onContextRestoredObservable`.
 */
import { NullEngine, Scene } from '@babylonjs/core'
import { loadWorld, type World } from '@sro/world-render'
import { afterEach, describe, expect, it } from 'vitest'
import { ROOT_URL, WORLD_NAME, makeFixture } from '../../../packages/world-render/test/stream-fixture.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c()
    } catch {
      // best effort
    }
  }
})

async function world(render: 'pbr' | 'classic'): Promise<{ engine: NullEngine; world: World; before: number }> {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  scene.createDefaultCamera()
  const before = engine.onContextRestoredObservable.observers.length
  const w = await loadWorld(scene, { baseUrl: ROOT_URL, world: WORLD_NAME, io: makeFixture().io, minimap: false, objects: false, quality: 'high', render })
  cleanups.unshift(() => {
    w.dispose()
    scene.dispose()
    engine.dispose()
  })
  return { engine, world: w, before }
}

describe('X1: a WebGL2 context restore on the modern path', () => {
  it('the streamed PBR world registers something that re-uploads (or reloads) what it streamed without a CPU copy', async () => {
    const { engine, world: w, before } = await world('pbr')
    expect(w.render.mode).toBe('pbr')
    expect(w.stream).not.toBeNull()
    // Babylon re-creates URL textures and raw textures that kept their data by itself; the map sets and the tile /
    // map arrays kept neither, so the world has to put them back when the context comes back. The one observer a
    // loaded scene gets anyway is Babylon's own (the environment BRDF texture's RGBD reset); it is not counted.
    const added = engine.onContextRestoredObservable.observers.slice(before)
    const ours = added.filter(o => !/isRGBD/.test(String(o.callback)))
    expect(added.length - ours.length, 'Babylon\'s BRDF observer (sanity)').toBe(1)
    expect(ours.length, 'observers on engine.onContextRestoredObservable added by the PBR world').toBeGreaterThan(0)
  })
})
