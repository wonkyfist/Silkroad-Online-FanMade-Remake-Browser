# @sro/viewer

A Babylon.js 9 viewer for the converter output in `work/out/`. The dev server serves that folder at `/out/` straight from disk, so no game data is ever copied into this app.

## Run

```sh
# optional: synthetic test assets (work/out/test/*) merged into work/out/index.json
pnpm exec tsx packages/convert/src/tools/make-test-glb.ts

pnpm --filter @sro/viewer dev          # http://localhost:5173
pnpm --filter @sro/viewer build        # static bundle in apps/viewer/dist (still needs /out/ served next to it)
pnpm --filter @sro/viewer exec vite preview   # serves dist/ and /out/
```

Vite options go after the script name with no `--`, for example `pnpm --filter @sro/viewer dev --port 5174 --strictPort`. pnpm forwards a literal `--`, and Vite then ignores the options after it.

The output folder is `<workDir>/out`. `workDir` comes from `sro.config.json` and defaults to `work`. Set `SRO_OUT_DIR` to override it.

## Data contract

`/out/index.json` is an array of entries. `glb` and `sidecar` are paths relative to `/out/`.

```json
[{ "id": "test/skinned-test", "name": "Skinned test", "category": "test",
   "glb": "test/skinned-test.glb", "sidecar": "test/skinned-test.json" }]
```

The sidecar is optional. The viewer reads only `animations[]`, with fields `{ name, events: [{ timeMs, type }] }`. Events are matched to a clip by name: first exactly, then case-insensitively, then with the folder and extension stripped. Type 1 is drawn as a red marker (hit), type 2 as a blue marker (footstep), and other types in grey. The raw JSON appears under "Sidecar JSON".

## Features

- WebGPU when `WebGPUEngine.IsSupportedAsync` allows it, otherwise WebGL2. The badge shows which engine is active; hover it for the reason. Add `?engine=webgl` to force WebGL2.
- The scene is right-handed (`scene.useRightHandedSystem = true`), so glTF node transforms are used exactly as stored. The ground grid rescales to the model: see "grid step" in the Info panel. The red line is +X and the blue line is +Z.
- The Info panel shows the bounding-box size and min/max of the current pose (skinning applied on the CPU), plus counts of vertices, triangles, bones, materials and clips.
- Animation panel:
  - clip list, including "(rest pose)"
  - loop toggle and speed (0.1x to 2x)
  - bottom timeline with play/pause and a scrubber showing time and duration
  - event markers, which flash as playback crosses them
  - Space toggles play
- Display toggles: skeleton (`SkeletonViewer`), wireframe, vertex normals, grid.
  - Normals are drawn from the bind-pose vertex data, so they do not follow skinning.
- Attach to bone: loads a second entry and parents it to a joint of the current model. The joint defaults to the first one whose name contains "R Hand". Two modes:
  - `bone-local`: the attachment's origin sits on the joint.
  - `cancel bind pose`: applies the joint's inverse bind matrix, for attachments authored in the character's model space.
- Drag and drop a local `.glb`, optionally with its sidecar `.json`, onto the view.
- The URL records the current state, so any view can be deep-linked: `?model=<id>&anim=<clip>&attach=<id>&bone=<name>&mode=bind`.

## Layout

| File | Role |
|---|---|
| `vite.config.ts` | `/out/` middleware for dev and preview (with MIME types, a path-traversal guard and `Last-Modified`) |
| `src/engine.ts` | WebGPU → WebGL2 engine selection |
| `src/viewer.ts` | Scene, camera, lights, grid, model loading/stats/bounds, display toggles, attachments (no DOM) |
| `src/animation.ts` | `AnimationController` (play/pause/loop/speed/scrub) and sidecar clip matching (no DOM) |
| `src/main.ts` | DOM UI wiring, index/sidecar fetching, URL state |

## World

`world.html?world=jangan` renders a converted region set: the output of `pnpm sro convert-region --preset jangan`, which is `work/out/world/jangan/manifest.json`. The manifest schema is `packages/convert/src/world/manifest.ts`, the rendering rules are `docs/TERRAIN.md`, and the frame is described in `docs/CONVENTIONS.md` under "World space & region output". The viewer imports `manifest.ts` and `format.ts` (decoders, `terrainHeightAt`, `terrainIndices`) by relative path, so it has no second coordinate conversion. The model viewer header links to the page.

```sh
pnpm sro convert-region --preset jangan
pnpm --filter @sro/viewer dev          # http://localhost:5173/world.html?world=jangan
```

### What it draws

- **Terrain.** There is one mesh per region: 97 × 97 vertices with the triangles from `terrainIndices()`, using a `ShaderMaterial` with hand-written WGSL for WebGPU and GLSL ES 3.0 for WebGL2 (`src/world/shaders.ts`). Babylon never converts GLSL to WGSL at runtime. The shader does the following:
  - reads the native per-cell layer planes (TERRAIN.md 2.3), with each tile id remapped on the CPU to its layer of one `RawTexture2DArray` holding the 43 tiles;
  - applies the tiling periods 80/160/80/40/20;
  - takes gradients from the continuous coordinate;
  - multiplies by the region lightmap × saturate(lightmap + TerrainShadowColor);
  - applies linear fog on view depth in `sqrt(FogColor)`.
- **Objects.** Every model glb is loaded once.
  - Static models become thin instances (placement matrix × the mesh's matrix inside the model), batched per LOD group into 192 m (group 2) or 96 m (group 3) chunks. The TERRAIN.md 6.3 draw distance culls whole chunks: 202 m for group 2 and 48 m for group 3, as distance − radius.
  - Skinned models get one `instantiateModelsToScene` clone per placement, which loops the default clip from a random phase.
  - Materials are converted to the fixed-function lighting of TERRAIN.md 3.2 (`src/world/materials.ts`): a `StandardMaterial` with a 2× texture, BMT diffuse and ambient, a fixed sun from (1, 1, 0), and scene ambient = ObjectAmbient.
  - Object lightmaps come from the material extras `sroLightmap` (TEXCOORD_1) and are applied as `lightmapTexture` in shadow-map (multiply) mode, off/1×/2×.
- **Environment.** The `environment.json` profile of the block under the player is sampled at `time`. It sets the fog (G10/G11 × 250 m), the clear colour, a vertex-coloured sky dome, the sun diffuse × 0.6, ambient, water colour and the terrain shadow colour. Profile changes blend at `dt × 0.5`.
- **Water.** One mesh per region covers the wet blocks: a 17 × 17 grid at the block's water height, per-vertex depth alpha, 30 animated frames and WaterColor. It has its own WGSL/GLSL shader.
- **Navigation.** The player walks with `@sro/nav` (`docs/NAVIGATION.md`), through `src/world/nav.ts`.
  - **Data.** The file named by `manifest.nav.file` (a bare string, or `navData`, is accepted too) is decoded with `decodeNavData` (SRNV). It holds the terrain navmeshes and the object navmeshes (plazas, stairs, bridges, building floors) with their placements and links. The data is used as `new NavGltf(new NavWorld(data), manifest.space.originRegion)`, so all positions are glTF metres of the manifest frame.
  - **Fallback.** A manifest without a nav entry gets a terrain-only NavWorld built from the per-region navmesh bins. That fallback has no object navmeshes, so the player stands on the terrain under the Jangan plaza again. The HUD says `terrain only (fallback)` and the status line warns.
  - **Surface.** The player's position is a `NavPosition` that carries its surface: the terrain, or one object instance and triangle cell. The height always comes from that surface, never from re-guessing by y.
  - **Click to move.** A click is one `moveStraight` chord from the live position toward the clicked point, as in the original client (NAVIGATION.md §6.1):
    - the walk stops at the first blocking edge (walls, railings, the fountain terrace rim, closed terrain tiles);
    - nothing slides and nothing path-finds;
    - the character follows the returned legs at 5 m/s, taking the height of each leg's own surface (`heightOn`), and stands at `result.end`;
    - a click while running starts from the live point, settled on its current cell.
  - **Blocked feedback.** The ring marker at the clicked point is yellow for a full move and red when the move stops early. A red ring stays up 1.5 s after the stop.
  - **Picking.** The click marches the view ray against the nav surfaces, so a click on the plaza lands where the plaza is drawn, not on the hidden terrain below it. The terrain meshes are the fallback.
  - **Spawn.** The order is `?spawn=x,z[,y]`, then `manifest.spawn` (`[x, y, z]`, `{x, y?, z}` or `{position}`), then the centre of the origin region. The point is snapped with `locate()` to the surface nearest y; without a y it takes the highest surface.
- **Player.** The page loads `char/china/chinaman_adventurer` through `/out/index.json`. STAND1 and RUN are blended by speed.
  - **Height.** `?playerScale=` and the Player → Height slider (0.8–1.3) set a uniform scale of the character. The camera's follow height scales with it.
  - The default is **1.06**, the largest native Height choice (0.94 + 0.03·h, h = 4; `docs/CHARACTER_SCALE.md`). Use `?playerScale=1` for the default character (h = 2).
- **Cameras.** The orbit camera follows the player: drag to orbit, wheel to zoom, and it stays above the ground. **F** toggles free-fly (WASD, Q/E, Shift), and **H** hides the panels.
- **HUD.** The HUD shows:
  - stats: engine, FPS, draw calls, active meshes, thin instances, clones, triangles, JS heap, load time, and download MB and files;
  - the player's region and block;
  - a minimap drawn from the client's own minimap tiles, north up, with the player arrow and the camera direction;
  - the nav source, the surface under the player, and the last move (distance, legs, and the edge and model that blocked it);
  - toggles: wireframe, navmesh, region borders, terrain lightmap, static and animated objects, water, fog, sky and draw distance; the object lightmap mode; and a terrain debug view (layer count, lightmap only, first layer only, tile ids).
  - The navmesh toggle draws two layers:
    - terrain: blocked tiles in red, cell edges red/cyan/green;
    - object navmeshes: walkable triangles in translucent green. Outline and inline edges are coloured by what they do to a walker: red blocks, orange is flag 16 (pass under from below, railing on top), yellow is a link to another object, and pale green is an open edge onto the terrain.
- **GLSL guard.** On WebGPU, any GLSL pipeline is blocked instead of downloading glslang/twgsl from Babylon's CDN, and it is reported in the HUD in orange.

### URL parameters

| Parameter | Effect |
|---|---|
| `world=<name>` | folder under `/out/world/` (default `jangan`) |
| `engine=webgl` | force WebGL2 |
| `time=0..1` | time of day: 0 is midnight, 0.5 is noon (the default) |
| `env=<id>` | force an environment profile |
| `objects=0`, `animated=0` | skip all objects, or only the skinned ones |
| `lod=0` | no draw-distance culling |
| `lm=0\|1\|2` | object lightmap off / 1× / 2× (default 1) |
| `terrain=0..4` | terrain view: textured, layer count, lightmap only, first layer only, tile ids |
| `spawn=<x>,<z>[,<y>]` | player spawn in glTF metres, snapped to the nav surface nearest y (default: the highest) |
| `playerScale=0.8..1.3` | character Height factor (default 1.06) |
| `fly=1`, `nav=1`, `borders=1`, `wire=1`, `fog=0`, `lightmap=0` | initial toggles |

`window.sroWorld` exposes `scene`, `world`, `objects`, `player`, `rig` and the other modules in the console.

| File | Role |
|---|---|
| `world.html`, `src/world/world.css` | page and HUD layout |
| `src/world/main.ts` | wiring, environment application, render loop, stats, URL parameters, GLSL guard |
| `src/world/assets.ts` | `/out/world/<name>/` fetches (byte counting), image decode, concurrency limit |
| `src/world/terrain.ts` | `World` (region binaries, `heightAt`, `blockAt`) and `TerrainRenderer` (tile array, layer maps, lightmaps, meshes) |
| `src/world/shaders.ts` | terrain and water shaders, WGSL + GLSL |
| `src/world/textures.ts` | 2D texture arrays with full mip chains (CPU mips on WebGPU, where Babylon only mips layer 0) |
| `src/world/objects.ts` | glb loading, thin-instance chunks, skinned clones, draw distance |
| `src/world/materials.ts` | PBR → fixed-function `StandardMaterial`, object lightmaps |
| `src/world/environment.ts`, `src/world/sky.ts` | environment graph sampling, sky dome |
| `src/world/water.ts`, `src/world/overlays.ts`, `src/world/minimap.ts` | water, navmesh/border overlays, minimap |
| `src/world/nav.ts` | nav loading (manifest file or terrain-only fallback), spawn, ray picking on nav surfaces, `NavWalker` (click-to-move along `moveStraight` legs; no Babylon) |
| `src/world/player.ts`, `src/world/cameras.ts` | player (NavWalker, marker, scale, animation blend), orbit and free-fly cameras |
