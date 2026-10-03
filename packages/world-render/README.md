# @sro/world-render

Babylon.js 9 renderer for converted world regions (`pnpm sro convert-region`), shared by the game client
(`apps/game`, Jangan in the world screen) and the world viewer (`apps/viewer/world.html`).

```ts
import { loadWorld, resolveAssetBase } from '@sro/world-render'

const base = await resolveAssetBase(['/out-opt/', '/out/'])        // slimmed tree first (docs/ASSETS.md)
const world = await loadWorld(scene, { baseUrl: base!, world: 'jangan', onProgress: p => bar(p.fraction) })
scene.onBeforeRenderObservable.add(() => world.update(camera, player))  // env, sky, water, draw distance
world.heightAt(x, z, yHint)       // nav surface nearest yHint (plaza over sunken terrain), else terrain
world.pick(ray)                   // first walkable surface under a view ray (plaza, stairs, bridges, terrain)
world.spawn                       // manifest spawn located on the navmesh
world.nav / world.navWorld        // @sro/nav in glTF metres / file space
world.setTimeOfDay(0.5); world.setQuality('low' | 'medium' | 'high'); world.dispose()
```

- Frame: the manifest's glTF metres (right-handed, +Y up, origin = SW corner of the origin region), the frame the
  server uses for positions.
- Both asset layouts load: `/out` (PNG, plain glbs) and `/out-opt` (WebP, quantized + `EXT_meshopt_compression`).
  The meshopt decoder is the local MIT module from `node_modules/meshoptimizer` (`src/meshopt.ts`); Babylon's CDN
  is never contacted. Shaders are WGSL on WebGPU and GLSL on WebGL2.
- `NavTrack` keeps a walker's retained surface and walks moves with `moveStraight` (docs/NAVIGATION.md §5-6).
- Building blocks (`TerrainRenderer`, `WaterRenderer`, `Sky`, `WorldObjects`, `ObjectMaterials`, `Minimap`, nav
  helpers) are exported for the viewer's debug controls.
- `WorldIO` makes fetching and image decoding pluggable; `test/load.test.ts` runs `loadWorld` headless on a
  NullEngine against `work/out` and `work/out-opt`.

## Region streaming (docs/FIELDS.md §3)

An export with a manifest `stream` block (e.g. `jangan-fields`) streams by default (`stream: 'auto'`); `stream: true`
also streams an older export (its `nav.bin` is split in memory), `stream: false` always loads the whole world.

```ts
const world = await loadWorld(scene, { baseUrl, world: 'jangan-fields', focus: { x, z } })  // resolves when the
// regions within 200 m of the focus are in (objects included unless waitForObjects: false)
world.stream                       // RegionStreamer, or null for a whole-world load
world.update(camera, self.pos)     // every frame: drives the streamer (focus = self, view bias = camera forward)
world.setFocus(x, z)               // teleport / respawn / worldEnter: re-centre at once
await world.stream?.whenReady(x, z) // every region within 200 m ready (e.g. behind a loading screen)
world.stream?.navCovers(x0, z0, x1, z1)  // prediction guard: every region under the segment's box is ready
world.stream?.setSettings(STREAM_DEFAULTS[preset])  // live radii, budget, fetches, cache limits (decision 50)
world.stream?.stats                // wanted / ready / resident / jobs / MB / models / tile layers / frame ms
isTerrainMesh(mesh)                // live "is this streamed terrain?" (mesh.metadata.sroWorld === 'terrain')
```

- Files: `stream.ts` (`RegionStreamer`, `STREAM_DEFAULTS`, the fetch limiter and job queue), `region-chunk.ts` (one
  region's fetch, commit jobs and unload), `model-cache.ts` (reference-counted models with a grace time and an LRU),
  `tile-atlas.ts` (terrain tiles in one texture array, reference-counted layers, growth).
- Lights use layer masks: object meshes carry `WORLD_OBJECT_LAYER`, so `isolateLights` covers objects that stream
  in later.
- Tests: `test/stream.test.ts` (synthetic 7 x 7 world, fake clock), `test/stream-jangan.test.ts` (the real 3 x 3
  export streamed and compared with the whole-world load), `packages/nav/test/stream.test.ts` (the client nav).
