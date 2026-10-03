/**
 * Headless smoke test of loadWorld (Babylon NullEngine) against the real world export: work/out and, when present,
 * the slimmed work/out-opt (WebP images, meshopt/quantized glbs through the local decoder). Skips without them.
 * Images are not decoded (a grey stub): this checks fetching, parsing, glb loading, placement, nav and the API.
 * Also estimates draw calls (active meshes) at two camera spots, since a headless engine cannot time frames.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ArcRotateCamera, NullEngine, Scene, Vector3, type AbstractMesh, type Mesh } from '@babylonjs/core'
import { afterAll, describe, expect, it } from 'vitest'
import { loadWorld, type World, type WorldIO } from '../src/index.ts'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

const io: WorldIO = {
  async bytes(url) {
    const buf = await readFile(fileURLToPath(url))
    return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
  },
  async decodeImage(_bytes, _mime, size) {
    const s = size ?? 4
    return { width: s, height: s, data: new Uint8Array(s * s * 4).fill(128) }
  },
}

/** Active meshes x their sub-meshes: what one frame would draw (thin instances count once per mesh). */
function drawEstimate(scene: Scene): Record<string, number | undefined> {
  scene.render()
  const active = scene.getActiveMeshes()
  let draws = 0
  let thin = 0
  for (let i = 0; i < active.length; i++) {
    const m = active.data[i] as AbstractMesh
    draws += m.subMeshes?.length ?? 1
    if ((m as Mesh).hasThinInstances) thin += (m as Mesh).thinInstanceCount
  }
  return { meshes: active.length, draws, thin, ...(scene.metadata?.world as World | undefined)?.objects.visibleCounts, animating: (scene.metadata?.world as World | undefined)?.objects.animatingCount }
}

for (const layout of ['out', 'out-opt']) {
  const dir = join(REPO, 'work', layout)
  const has = existsSync(join(dir, 'world', 'jangan', 'manifest.json'))
  describe.skipIf(!has)(`loadWorld (NullEngine, work/${layout})`, () => {
    let engine: NullEngine
    let scene: Scene
    let world: World
    const stages = new Set<string>()
    let last = 0
    let monotonic = true

    afterAll(() => {
      world?.dispose()
      scene?.dispose()
      engine?.dispose()
    })

    it('loads terrain, water, objects and nav', async () => {
      engine = new NullEngine()
      scene = new Scene(engine)
      scene.useRightHandedSystem = true
      const cam = new ArcRotateCamera('cam', Math.PI / 2, 1.1, 9, new Vector3(96.9, -1.5, -136.9), scene)
      cam.maxZ = 3000
      scene.activeCamera = cam
      const t0 = performance.now()
      world = await loadWorld(scene, {
        baseUrl: pathToFileURL(dir + '/').href,
        world: 'jangan',
        io,
        minimap: false,
        onProgress: p => {
          stages.add(p.stage)
          if (p.fraction + 1e-9 < last) monotonic = false
          last = p.fraction
        },
      })
      scene.metadata = { world }
      const ms = performance.now() - t0
      console.log(`[world-render] ${layout}: loaded in ${(ms / 1000).toFixed(1)} s, ${world.objects.stats.models} models ` +
        `(${world.objects.stats.failed} failed), ${world.objects.stats.thinInstances} thin instances, ${world.objects.stats.clones} animated, ` +
        `${(world.assets.bytes / 1048576).toFixed(1)} MB in ${world.assets.files} files`)
      expect(world.objects.errors).toEqual([])
      expect(world.objects.stats.failed).toBe(0)
      expect(world.objects.stats.models).toBeGreaterThan(150)
      expect(world.terrain.meshes).toHaveLength(world.manifest.regions.length)
      expect(world.water.meshes.length).toBeGreaterThan(0)
      expect(world.navSource).toBe('manifest')
      expect(world.nav.world.instanceCount).toBeGreaterThan(500)
      expect([...stages]).toEqual(['manifest', 'regions', 'navigation', 'tiles', 'terrain', 'water', 'objects', 'done'])
      expect(monotonic).toBe(true)
      expect(last).toBe(1)
    })

    it('stands the spawn on the plaza, not on the sunken terrain below it', () => {
      // manifest.spawn: the Jangan gate plaza (cj_jang_gate06.bms), y -3.26; the terrain below is ~-4.8.
      expect(world.spawn.surface.kind).toBe('object')
      expect(world.spawn.y).toBeCloseTo(-3.26, 1)
      expect(world.heightAt(world.spawn.x, world.spawn.z)).toBeCloseTo(-3.26, 1)
      // NAVIGATION.md §8: at region-local (1008.4, 715) of 168x97 = glTF (100.84, -71.5) the plaza is -3.261 m and
      // the hidden terrain depression under it -4.791 m; the highest surface (default hint) is the plaza.
      expect(world.heightAt(100.84, -71.5)).toBeCloseTo(-3.261, 2)
      expect(world.heightAt(100.84, -71.5, -4.8)).toBeCloseTo(-4.791, 2)
      expect(world.heightAt(100.84, -71.5, -3)).toBeCloseTo(-3.261, 2)
    })

    it('picks the plaza with a camera ray from above', () => {
      const s = world.spawn
      const origin = new Vector3(s.x + 6, s.y + 8, s.z + 6)
      const dir = new Vector3(s.x, s.y, s.z).subtract(origin).normalize()
      const hit = world.pick({ origin, direction: dir })
      expect(hit).not.toBeNull()
      expect(hit!.surface.kind).toBe('object')
      expect(hit!.walkable).toBe(true)
      expect(Math.hypot(hit!.x - s.x, hit!.z - s.z)).toBeLessThan(0.05)
      expect(hit!.y).toBeCloseTo(s.y, 1)
    })

    it('updates, changes time of day and quality, and reports draw estimates', () => {
      const cam = scene.activeCamera as ArcRotateCamera
      world.setTimeOfDay(0.5)
      scene.render()
      world.update(cam)
      const plaza = drawEstimate(scene)
      // Mangnyang field south of the town (the 8 Mangnyang nests of the converted regions, glTF z ~ +120..+190).
      cam.target.set(110, world.heightAt(110, 140) ?? 0, 140)
      scene.render()
      world.update(cam)
      const field = drawEstimate(scene)
      console.log(`[world-render] ${layout}: draw estimate plaza ${JSON.stringify(plaza)}, field ${JSON.stringify(field)}`)
      expect(plaza.draws).toBeGreaterThan(10)
      expect(field.draws).toBeGreaterThan(10)
      world.setQuality('low')
      world.update(cam)
      world.setQuality('medium')
      expect(scene.fogMode).toBe(Scene.FOGMODE_LINEAR)
    })
  })
}
