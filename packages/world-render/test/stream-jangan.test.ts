/**
 * Region streaming on the real 3 x 3 Jangan export treated as streamable (loadWorld stream: true; the export has no
 * `stream` block, so nav.bin is split in memory), NullEngine, images stubbed. Skips without work/out(-opt). Checks
 * that the streamed world matches the whole-world load (models, instances, clones, heights, picks) and that regions
 * unload cleanly (terrain, nav, objects, model references).
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ArcRotateCamera, NullEngine, Scene, Vector3 } from '@babylonjs/core'
import { NavGltf, NavWorld, decodeNavData } from '@sro/nav'
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

async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 5))
  }
}

for (const layout of ['out', 'out-opt']) {
  const dir = join(REPO, 'work', layout)
  const has = existsSync(join(dir, 'world', 'jangan', 'manifest.json'))
  describe.skipIf(!has)(`loadWorld stream: true (NullEngine, work/${layout}/world/jangan)`, () => {
    const engines: NullEngine[] = []
    let whole: World
    let streamed: World

    afterAll(() => {
      whole?.dispose()
      streamed?.dispose()
      for (const e of engines) e.dispose()
    })

    const scene = (): Scene => {
      const engine = new NullEngine()
      engines.push(engine)
      const s = new Scene(engine)
      s.useRightHandedSystem = true
      const cam = new ArcRotateCamera('cam', Math.PI / 2, 1.1, 9, new Vector3(96.9, -1.5, -136.9), s)
      cam.maxZ = 3000
      s.activeCamera = cam
      return s
    }

    it('streams every region around the spawn and matches the whole-world load', async () => {
      const base = pathToFileURL(dir + '/').href
      whole = await loadWorld(scene(), { baseUrl: base, world: 'jangan', io, minimap: false, stream: false })
      const t0 = performance.now()
      streamed = await loadWorld(scene(), { baseUrl: base, world: 'jangan', io, minimap: false, stream: true })
      const ms = performance.now() - t0
      const s = streamed.stream!
      expect(s).not.toBeNull()
      expect(streamed.navSource).toBe('stream')
      expect(whole.stream).toBeNull()
      // All 9 regions lie within 200 m of the plaza spawn: everything is in once the load resolves.
      expect(s.stats.wanted).toBe(9)
      await until(() => s.stats.objectsReady === 9 && s.stats.jobs === 0)
      console.log(`[world-render] ${layout} streamed: ${(ms / 1000).toFixed(1)} s, ${JSON.stringify(s.stats)}`)
      expect(streamed.terrain.meshes).toHaveLength(9)
      expect(streamed.objects.errors).toEqual([])
      expect(streamed.objects.stats.models).toBe(whole.objects.stats.models)
      expect(streamed.objects.stats.thinInstances).toBe(whole.objects.stats.thinInstances)
      expect(streamed.objects.stats.clones).toBe(whole.objects.stats.clones)
      expect(streamed.water.meshes.length).toBe(whole.water.meshes.length)
      // Nav: same instances, terrain of all 9 regions, same heights and spawn.
      expect(streamed.nav.world.instanceCount).toBe(whole.nav.world.instanceCount)
      expect(streamed.spawn.surface.kind).toBe('object')
      expect(streamed.spawn.y).toBeCloseTo(whole.spawn.y, 6)
      expect(streamed.heightAt(100.84, -71.5)).toBeCloseTo(-3.261, 2)
      expect(streamed.heightAt(100.84, -71.5, -4.8)).toBeCloseTo(-4.791, 2)
      for (let i = 0; i < 200; i++) {
        const x = -190 + ((i * 97) % 570)
        const z = -380 + ((i * 131) % 570)
        expect(streamed.heightAt(x, z, 0)).toBe(whole.heightAt(x, z, 0))
      }
      const sp = streamed.spawn
      const origin = new Vector3(sp.x + 6, sp.y + 8, sp.z + 6)
      const hit = streamed.pick({ origin, direction: new Vector3(sp.x, sp.y, sp.z).subtract(origin).normalize() })
      expect(hit?.surface.kind).toBe('object')
      // Frame loop: update() drives the streamer and the environment without errors.
      streamed.update(streamed.scene.activeCamera)
      streamed.scene.render()
    })

    it('unloads regions past the unload radius and brings them back', async () => {
      const s = streamed.stream!
      const models = streamed.objects.stats.models
      s.setSettings({ loadRadiusM: 20, unloadRadiusM: 40 })
      // The centre of region 167,96 (south-west corner of the export): its neighbours are 96 m away.
      streamed.setFocus(-96, 96)
      await until(() => s.stats.resident === 1 && s.stats.objectsReady === 1 && s.stats.jobs === 0)
      expect(s.state(167, 96)).toBe('ready')
      expect(s.state(169, 98)).toBe('absent')
      expect(streamed.terrain.meshes).toHaveLength(1)
      expect(streamed.regions.regions).toHaveLength(1)
      expect(Number.isNaN(streamed.nav.world.terrainHeight(169 * 1920 + 960, 98 * 1920 + 960))).toBe(true)
      expect(streamed.objects.stats.thinInstances).toBeLessThan(whole.objects.stats.thinInstances)
      expect(s.stats.modelsCached).toBeGreaterThan(0) // released, waiting out their grace time
      expect(s.navCovers(-96, 96, 100, -100)).toBe(false)
      expect(s.navCovers(-150, 150, -50, 50)).toBe(true)
      // Back to the full set: nothing is left over, nothing double.
      s.setSettings({ loadRadiusM: 400, unloadRadiusM: 560 })
      streamed.setFocus(streamed.spawn.x, streamed.spawn.z)
      await until(() => s.stats.objectsReady === 9 && s.stats.jobs === 0)
      expect(streamed.terrain.meshes).toHaveLength(9)
      expect(streamed.objects.stats.thinInstances).toBe(whole.objects.stats.thinInstances)
      expect(streamed.objects.stats.clones).toBe(whole.objects.stats.clones)
      expect(streamed.objects.stats.models).toBe(models)
      expect(streamed.heightAt(100.84, -71.5)).toBeCloseTo(-3.261, 2)
    })
  })
}

for (const layout of ['out-opt', 'out']) {
  const dir = join(REPO, 'work', layout)
  const has = existsSync(join(dir, 'world', 'jangan-fields', 'manifest.json')) && existsSync(join(dir, 'world', 'jangan-fields', 'nav-objects.bin'))
  describe.skipIf(!has)(`streaming work/${layout}/world/jangan-fields (NullEngine)`, () => {
    let engine: NullEngine
    let world: World

    afterAll(() => {
      world?.dispose()
      engine?.dispose()
    })

    it('loads the town by streaming (auto) and walks 2 km west with bounded residency', async () => {
      engine = new NullEngine()
      const scene = new Scene(engine)
      scene.useRightHandedSystem = true
      const t0 = performance.now()
      world = await loadWorld(scene, { baseUrl: pathToFileURL(dir + '/').href, world: 'jangan-fields', io, minimap: false })
      const loadMs = performance.now() - t0
      const s = world.stream!
      expect(s).not.toBeNull()
      expect(world.navSource).toBe('stream')
      console.log(`[world-render] ${layout} jangan-fields: town in ${(loadMs / 1000).toFixed(1)} s, ${JSON.stringify(s.stats)}`)
      expect(s.stats.wanted).toBeGreaterThanOrEqual(20)
      expect(s.stats.wanted).toBeLessThanOrEqual(26)
      expect(world.objects.errors).toEqual([])
      // The GATE_CH plaza (docs/NAVIGATION.md §8), as in the 3 x 3 export.
      expect(world.spawn.surface.kind).toBe('object')
      expect(world.heightAt(100.84, -71.5)).toBeCloseTo(-3.261, 2)
      // Walk the focus west along the town's row, 40 m per step, letting the streamer work between steps.
      let maxResident = 0
      for (let x = world.spawn.x; x > world.spawn.x - 2000; x -= 40) {
        s.update({ x, z: world.spawn.z }, { x: -1, z: 0 })
        maxResident = Math.max(maxResident, s.stats.resident)
        await new Promise(r => setTimeout(r, 2))
      }
      const end = { x: world.spawn.x - 2000, z: world.spawn.z }
      await until(() => {
        s.update(end, { x: -1, z: 0 })
        return s.stats.ready + s.stats.failed === s.stats.resident && s.stats.jobs === 0 && s.stats.objectsReady === s.stats.ready
      }, 240_000)
      console.log(`[world-render] ${layout} jangan-fields after the walk: max resident ${maxResident}, ${JSON.stringify(s.stats)}`)
      expect(s.stats.failed).toBe(0)
      expect(s.stats.unloads).toBeGreaterThan(20)
      expect(maxResident).toBeLessThanOrEqual(60)
      expect(s.state(168, 97)).toBe('absent') // the town is far behind
      expect(world.terrain.meshes).toHaveLength(s.stats.ready)
      expect(world.objects.errors).toEqual([])
      // Heights out west agree with the full nav.bin.
      const full = new NavGltf(new NavWorld(decodeNavData(new Uint8Array(await readFile(join(dir, 'world', 'jangan-fields', 'nav.bin'))))), world.manifest.space.originRegion)
      let compared = 0
      for (let i = 0; i < 300; i++) {
        const x = end.x - 300 + ((i * 97) % 600)
        const z = end.z - 300 + ((i * 131) % 600)
        if (!s.navCovers(x, z, x, z)) continue
        expect(world.nav.locate(x, z, 0)).toEqual(full.locate(x, z, 0))
        compared++
      }
      expect(compared).toBeGreaterThan(200)
    })
  })
}
