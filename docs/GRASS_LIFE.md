# A living Jangan: our own grass, flowers and wildlife (the user's item 5)

**Status (wave 10r, built 2026-10-01):** built as GL-S, GL-F, GL-T, GL-C, GL-L, GL-O and GL-A (the petal atlas): the new grass on Medium and up (Low keeps the retail scatter and tufts), butterflies, birds, dragonflies and fireflies, and the Grass and Wildlife rows in Options. Where docs/WAVE_PLAN6.md decides differently (D21, D24, D25, D33), the plan wins.

The user asked (2026-09-29, item 5 of the new list): "I want jangan map to flourish with life, a grassy area should be
filled with grass, (i hate that each grass is seperated and you can see empty spaces), lets work on this. Either create
your own grass (cuz i hate the retail one) make them face you or something (but make sure there is performance based).
Add butterfly, and birds etc." The user's answers: the grass look is **"Lush painterly"** (dense soft blades, colour
variation matching SRO's hand-painted style, no gaps, wind), and life means **butterflies, birds, fireflies and
dragonflies, flowers and small plants**.

This spec:

- measures why the retail grass shows gaps today (§1);
- chooses the grass technique against the alternatives the task named: cards vs camera-facing vs 3D blade clumps, CPU vs
  WebGPU-compute culling, one draw per chunk vs fewer, the WebGL2 path (§2);
- designs the grass field, its look, its weather response and its data (§3), the flowers and small plants (§4) and the
  wildlife (§5);
- reports a prototype built in the real renderer on a Jangan field, beside the retail grass, with butterflies and one
  bird flock, measured at Medium and High on WebGPU and WebGL2 (§6);
- gives budgets per preset (§7), lanes (§8), a scope-cut order (§9), risks (§10), what the user must provide (§11) and
  open questions (§12).

This is design only. Code, content and deploy files are untouched. Prototypes, scripts and images are in
`work/tmp/grass-life/`.

**Tags.** **[confirmed]**: checked in the code, the data or a measurement, and the text says how. **[likely]**: strong
evidence, not proven. **[projected]**: computed from a measurement or the data, not measured on that setup.
**[unknown]**: open; a default is given. **[decision]**: a choice this spec makes.

**Sources read.** docs/BACKLOG.md, docs/WAVE_PLAN3.md (§4.2 chunk points, §5.2 budget format, D23 grass shader, D29 night
splat, D30 TAA), docs/RENDER.md (§8.2, §11.5), docs/COAST.md, docs/TREES.md, docs/MOVEMENT.md, docs/SCREENS.md,
docs/SOUND.md (§5.10), docs/WEATHER.md (§6.5, §6.7), `work/tmp/w9-user-decisions.md`, `work/tmp/w9-finish/budgets.md`,
`work/tmp/tidewater-notes.md`; the code at the working tree of 2026-09-29: `scatter.ts`, `scatter-assets.ts`,
`shader-chunks.ts`, `shaders.ts`, `render/grass-chunks.ts`, `weather/chunks.ts`, `night-chunks.ts`, `night-lights.ts`,
`sky/chunks.ts`, `world.ts`, `regions.ts`, convert `world/format.ts`, `apps/game/src/audio/weather.ts`,
`apps/game/src/settings.ts`; Babylon 9.28 `webgpuDrawContext.js` and `webgpuEngine.pure.js`; and Tidewater
(github.com/dgreenheck/tidewater, MIT) `src/world/vegetation/{GrassField,Scatter,InstanceLOD,VegMaterials}.js` and
`src/world/wildlife/{Birds,BirdBatch,Flight}.js`, read as public pages (no download, nothing copied into the repo).

---

## 0. Summary

1. **Why there are gaps today** [confirmed: `work/tmp/grass-life/coverage.py`]. The retail scatter puts **0.49 plants
   per m² at Medium** (0.82 at High) on the ground it allows: one alpha-tested retail tuft per 2 m². It also leaves 6 %
   of the real grass bare (any bare corner bares a 2 m cell). Grass covers **4.4 km² of Jangan's 7.8 km²** of dry land.
2. **Our own grass: 3D blade clumps, turned toward the camera** [decision]. Opaque tapered blades (no alpha test),
   45 blades/m² at Medium and 74 at High, each blade's facing biased 55 % toward the camera (the user's "make them face
   you"), a dark base and a light tip, colours taken from the terrain tile under them with painted hue patches, 1.5 %
   dry blades. Wind, rain bowing, wet darkening, night light, cloud shadow and the CSM tap come from the existing chunk
   graph unchanged.
3. **Performance-first: GPU-procedural patches, CPU cell culling, 3 draws in total** [decision; confirmed in the lab].
   One shared mesh holds every blade of an 8 m cell; the instance is only the cell corner; the vertex shader reads a
   camera-centred 256 m field window (density, flower mask, palette, exact terrain height). Three LOD tiers (near / mid /
   far) with Tidewater-style fades and width compensation. **One draw per tier for all visible grass and flowers**, not
   one per chunk; no shadow casters. WebGPU compute culling was weighed and not taken (it needs Babylon private API, the
   bottleneck is draw count, not vertices). WebGL2 runs the same design.
4. **Coverage from the splat's grass layers**, composited through the terrain's native layer order, with soft,
   shortening edges at roads and paving instead of a hard margin.
5. **Flowers and small plants ride in the grass mesh** (0 extra draws), in drifts from a meadow mask; clover, ferns and
   reeds are later kinds.
6. **Wildlife** (client-only, instanced, one draw per kind): GPU-procedural **butterflies** by day, **bird flocks** that
   land, peck and **flush when anyone walks within 9 m**, roof perchers and fly-overs, **fireflies** at night,
   **dragonflies** near water; all gated by the time of day and the weather with the bird-song thresholds (nothing in
   rain but perchers under shelter). The coast's gulls join the same bird system (COAST B15).
7. **Measured** (§6, WebGPU and WebGL2, GPU lock held): in the fields, draws per frame (all passes) **93 → 78 at Medium
   and 193 → 168 at High** (the retail scatter's 20–30 draws become 3 + 2 for the life); CPU no slower than retail within
   the noise (cull + birds < 0.1 ms; the fact-check re-ran WebGL2 High, §6.3); GPU +0.05 to +0.36 ms (medians) on the
   dev GPU, **+0.63 ms min-vs-min at High ground level**, with ±0.15 ms of GPU-clock noise between runs; the varying
   count equals the retail grass's.
8. **Scope:** Medium, High and Ultra get the new grass; **Low keeps the retail scatter** (the Low guard). Macs and
   integrated GPUs start at "Grass: Low" (the full Medium density over a shorter reach, *fact-check*: not a thinner
   field, which would bring the gaps back) until one friend's M1 is measured.
9. *(fact-check)* **The retail grass the user dislikes is also placed as objects**: 3,531 placements of 27 grass, weed
   and flower models in the playable area [confirmed: manifest count, §1.3]. The spec now decides what happens to them
   (§1.3, Q12).

| What | Where |
|---|---|
| The sheet for the user | `work/tmp/grass-life/overview.png` |
| Coverage map (today vs proposed) | `work/tmp/grass-life/coverage-map-legend.png` |
| Measurements | `work/tmp/grass-life/bench-summary.md`, `shots/bench_*.json` |
| Lab code | `work/tmp/grass-life/lab/` |

---

## 1. Today [confirmed]

### 1.1 How the retail grass is drawn

`scatter.ts` `WorldScatter` (wave 5, W5-G; lit by RND-W's chunks in wave 9):

- **Placement:** each region is split into 3 × 3 chunks of 64 m. Candidates sit on a jittered 1 m grid; one survives
  with probability `density(cell) × fraction(level)`. `density` comes from the tile type of the terrain's per-vertex
  texture word (`TILE_TYPE_DENSITY`: Grass 0.85, LongGrass 1, Forest 0.95, Dirt 0.07, …), pavement/rock/water names
  forced to 0. A 2 m cell with **any** bare corner is bare. Steep cells (normal y < 0.72), points under water and
  points on an object floor (`nav.locate` finds an object surface) get nothing. `fraction` is 0.35 / 0.6 / 1 for
  low / medium / high.
- **Art:** five kinds (grass, weed, bush, two flowers), each the retail `.bsr` plant (`grass_single03`, `grs_weed07`,
  `grs_weed01`, `flw_g01_*`) or procedural crossed cards, alpha-tested at 0.5.
- **Drawing:** one thin-instance mesh per (64 m chunk, kind), so a view has "15–25 draw calls" at medium by the file's
  own count; a `ShaderMaterial` per (region, kind); no shadow casting; the chunk graph (sky cloud shadow, weather wind
  and wet, night splat, RND-W HDR light + CSM tap + fog + TAA jitter) lights it.

### 1.2 Why the user sees separated tufts and gaps

`work/tmp/grass-life/coverage.py` runs today's rule and a splat-weight rule over the 247 playable regions of
`jangan-fields` (x 156..174, z 90..102) [confirmed: the script's output, `coverage.txt`]:

| Measure | Value |
|---|---|
| Dry land | 7.84 km² |
| Cells with grass in the splat (proposed rule, §3.3) | 4.39 km², 56 % of the land (weighted 4.01 km²) |
| Of those, blended edge cells (0 < weight < 1: road and paving borders) | 16.7 % |
| Cells today's rule allows | 3.96 km², 50.5 % of the land |
| Plants per m² on allowed ground | **0.49 at medium, 0.82 at high** |
| Grass cells (weight ≥ 0.5) that today's rule leaves bare | 0.28 km², 6.3 % of the grass cells |

- **The gaps are density, not coverage.** At medium there is one retail tuft per 2 m² (0.49 plants/m²), each a 0.45–0.8 m
  alpha-tested model. The ground shows between every tuft. At high it is still less than one plant per m².
- **The any-bare-corner rule** cuts a hard 2 m margin at every road and blend, and leaves 6 % of the real grass empty.
- The map `work/tmp/grass-life/coverage-map-legend.png` shows both (magenta = grass the rule leaves bare).

Raising the retail density would not fix it: each tuft is a retail model with its own alpha-tested pixels, so a lush
field of them costs overdraw and never looks painterly (the user dislikes the retail model itself).

### 1.3 Placed retail grass objects *(fact-check)*

The scatter is not the only retail grass. The map also places grass, weed and flower **models** as ordinary objects:
**3,531 placements of 27 models inside the playable regions** [confirmed: `manifest.placements` of `jangan-fields`,
sources matching `grs|flw|grass|flower|barley`, scratch count in the fact-check]. The largest groups:

| Model (height from the manifest bounds) | Placements |
|---|---|
| `grs_weed09_1` / `_09_2` / `_09` (7–8 m wide reed/weed clumps) | 725 / 330 / 64 |
| `grs_weed06` / `_06_1` (3.6 m) | 429 / 217 |
| `group_grs01` / `group_grs03_1` (1.3 m grass groups) | 299 / 34 |
| `cj_barley_02` (1.8 m) | 227 |
| `grs_weed07` (2.6 m) / `grs_weed01` (1.9 m) / `grs_weed02` (1.9 m, skinned) / `grs_weed04` (3.7 m, skinned) | 226 / 98 / 37 / 149 |
| Flowers (`grs_flower_01/03/03_1/05`, `flw_g01_yall/wha`, `flw_s01_*` skinned) | 126 + 45 + 44 + 60 + 114 + 63 + 28 |
| Water plants (`grs_water_big`, `c_pondflower`, skinned) | 65 + 44 |
| `cj_graveyard_grass01/03`, `grass_single03`, `grs_weed10`, `grs_flower_02` | 97 + 6 + 1 + 2 + 1 |

The earlier draft only said "the retail bush objects stay". Without a decision, the low retail tufts
(`group_grs*`, `grass_single03`, `grs_weed01/02/07`: 695 placements) stand in the new carpet, which is exactly the
retail look the user asked to replace. **Default [decision, the user checks it, Q12]:** on Medium+ with the new grass,
those 695 low tuft placements are not placed (a model-name list in GL-0, applied before `placeStatic` so item 1's
batcher never sees them); the tall weeds, reeds, barley, flowers and water plants stay as set dressing (they read as
plants, not as ground cover), and the user judges them in the A/B. Low keeps everything.

---

## 2. The technique: choices and alternatives

### 2.1 Blades: cards, camera-facing cards or 3D blade clumps

| Option | Look | GPU | CPU | Decision |
|---|---|---|---|---|
| Crossed alpha cards (today's procedural fallback) | tufty; hard alpha edges; X-shapes visible from above | alpha test (`discard`) turns off early-Z; heavy overdraw when dense | same as any instancing | no |
| Camera-facing billboards ("make them face you") | fills the screen with few quads; flat and swimming when the camera turns; the painted texture repeats | cheapest per m² covered, but alpha-tested | same | far tier only if the lab had needed it (it did not) |
| **3D blade clumps, turned toward the camera** | real blades with a gradient from a dark base to a light tip; clumps give the tufty painterly rhythm; parallax is right | opaque triangles: no `discard`, early-Z works, no texture fetch per pixel | same | **yes** [decision] |

The user's "make them face you" is kept as a **blade yaw bias**: each blade's facing is mixed 55 % toward the camera
(`grStyle.y`), so thin blades never go edge-on and vanish, which is the reason cards exist in the first place (the
Ghost of Tsushima trick). The blades stay 3D, lit per vertex and bent by the wind.

### 2.2 Instances: per-plant buffers vs GPU-procedural patches

| Option | CPU per frame | CPU when the camera moves | Memory | Decision |
|---|---|---|---|---|
| Today's: CPU-built per-plant thin-instance matrices per 64 m chunk (1 m grid, `occupied` test per plant) | tiny | a chunk build 0.3–0.5 ms (per the file) at 1 plant/m²; ~40× that at the new density | 64 B per plant | no: at 40 blades/m² this is ~2.6 k blades per 64 m² cell, millions per view |
| **GPU-procedural patches (Tidewater `GrassField`)**: one shared mesh holds every blade of one 8 m cell; the instance is only the cell's corner; each blade reads its root, height, density, colour from small textures in the vertex shader | cell culling only: ≈ 1,024 cells, **under 0.1 ms p50** measured with the wildlife included (Chrome's timer resolution, §6) | none (no rebuild); a window re-centre every 32 m copies texture rows | 16 B per visible cell as the target (*fact-check*: the lab used Babylon's 16-float `matrix` buffer, 64 B per cell; either is ≤ 64 KB per tier); one 256 m field window (≈ 330 KB) | **yes** [decision] |

Each cell picks one of 8 variants of the patch (4 rotations × mirror, from a hash of the cell corner), so the 8 m
repetition does not show [confirmed: not visible in the lab's top view, `look_high_top.png`].

### 2.3 Culling: WebGPU compute vs CPU per cell

- **What the frame needs:** wave 9's bottleneck is **CPU draw submission** (plaza High ≈ 700 draws, p95 17.9 ms), not
  vertex work (GPU 2.3–4.6 ms on High, `w9-finish/budgets.md`). The grass therefore needs few draws; GPU culling saves GPU
  vertex work that is already cheap here (§6).
- **Compute culling in Babylon 9.28 [confirmed: read in `webgpuDrawContext.js` / `webgpuEngine.pure.js`]:** a
  `WebGPUDrawContext` owns an `indirectDrawBuffer` (created with Storage usage), but the engine rewrites its instance
  count from the CPU whenever the count it is given changes (`setIndirectData`). A compute pass writing the count would
  have to keep Babylon's count constant and write the real one behind its back, a private-API hack of the kind that
  caused the wave-9 "vanish" bug (RENDER §11.5), with no WebGL2 twin.
- **Decision:** CPU culling per 8 m cell (distance + frustum AABB with the cell's height range, cells with no grass
  skipped from a per-cell max), the vertex shader collapses blades outside the density [decision]. Compute culling
  per blade stays an Ultra experiment for later (§12 Q7).

### 2.4 Draws: one per chunk, or fewer

The task asked for one draw per chunk. The GPU-procedural patches do better: **one draw per LOD tier for every visible
cell**, whatever the chunk: 3 draws for all the grass and flowers in view [confirmed: 3 grass meshes in every lab run].
The wildlife adds 1 draw per kind (butterflies and dragonflies share one, birds one, fireflies one at night). No grass
mesh casts a shadow and none writes the prepass (as today, RENDER §5.3). The draw-call spec (item 1,
`work/tmp/batching/`) can count the whole ground cover as **≤ 3 main draws + ≤ 3 life draws**, down from the retail scatter's
20 (Medium) and 30 (High) draws in the lab's fields view [confirmed: §6.3].

### 2.5 WebGL2

The same design on both APIs [decision]: the shader is written in WGSL and GLSL ES 3.0 like every grass shader
(`scatterShaders`); the vertex stage reads RGBA8 textures with `texelFetch`/`textureLoad` (no float textures, no
filtering, so no `float32-filterable` or WebGL2 float-texture question); thin instances as today. The lab ran both
[confirmed: §6].

### 2.6 What Tidewater does, and what we take

`GrassField.js` (MIT) [confirmed: read]: 8 m cells, 384 clump slots per cell × 7 blades (≈ 42 blades/m²), blue-noise
placement, a density mask texture, three LOD meshes (4 / 3 / 2 rows; near 18 m, mid 46 m, far 88 m), tier fades with a
per-blade cut-off and a width compensation so coverage stays constant, CPU frustum culling per cell, no compute,
**three draws**. Travelling gusts, per-blade flutter, dry blades, a translucency lobe, bent normals.
`InstanceLOD.js`: CPU grid queries and LOD windows in the vertex shader (collapse outside the window).
`Birds.js`/`BirdBatch.js`/`Flight.js`: scripted paths and per-bird state machines (perched, fly, circle, takeoff,
landing), flush distances per species (7–9 m), one instanced draw per species with a 16-vec4 pose record, wings as
three bone rotations in the vertex shader, flap/glide duty cycles.

We take the structure (cells, tiers, collapse-by-window, compensation, per-species instanced birds with flush) and
write our own code on our chunk graph. **No code is copied** [decision]; if a lane ports a function literally, it adds
the MIT notice to COAST's `THIRD_PARTY_NOTICES.md` (S-NOTICE), as the coast does.

---

## 3. The grass field

### 3.1 Data: the field window

The grass reads four things per blade: is there grass here, how lush, what colour, and the ground height. They live in
one **camera-centred window**, like the night-light grass window (`night-lights.ts` `NIGHT_GRASS_WINDOW = 256`,
re-centred when the focus leaves the inner `NIGHT_GRASS_RECENTER_M = 32`) [decision]:

- `grField`, RGBA8, 256 × 256 at 1 m per texel (256 KiB): R = density 0..1 (§3.2), G = meadow mask (flowers, §4),
  B = palette index (§3.5), A = baked light (the terrain lightmap's visibility, for the baked shadow beyond the CSM tap;
  255 until GL-F copies it).
- `grHeight`, RGBA8, 129 × 129 (the 2 m terrain vertices of the window, 65 KiB): a 16-bit height in R and G over the
  window's `[hMin, hMin + range]` (3 mm steps for a 200 m range). The shader rebuilds the terrain's own triangulation
  (the split along `(gx, gz)–(gx+1, gz+1)`, `format.ts` `terrainHeightAt`) from four `texelFetch`es, so blades sit
  exactly on the rendered ground [confirmed: no floating or sunken blades on the lab's slopes].
- A per-cell table (32 × 32 cells of 8 m): the maximum density and the height range, for the CPU cull.
- **Production data flow** [decision]: at region commit, a `GrassRegion` bake produces the region's 192 × 192 density
  and meadow bytes and its palette ids; the window copies rows from the resident regions when it re-centres (≈ 0.3 MB
  of row copies, ≤ 0.5 ms [projected]). The lab baked the whole 256 m window in one go in 23–62 ms (median ≈ 35 ms,
  51 runs; the figure also includes building the patch meshes and the material) and 28 ms vs 33 ms without / with the
  object-floor test (`nav.locate` per grassy texel) [confirmed: `bakeMs` in the lab JSONs, `bake_occ0/1.json`]; per
  region that is ≈ 15–25 ms in the lab's unoptimised code [projected].
- *(fact-check)* **Two corrections to the seam.** (1) The commit step runs **after `'objects'`**, like NL's
  `nightSplat` (`night-lights.ts` line 581), not after `'terrain'`: the object-floor mask needs the region's object
  floors in the nav [likely: the retail scatter only tests floors lazily, at chunk generation]. (2) The streamer
  **never splits a job** (`stream.ts` addCommitStep doc: "each step of each region is its own job … a job is never
  split"; `frameBudgetMs` 4 ms on Medium, 5 on High, and "at least one job always runs") [confirmed: `stream.ts`], so a
  15–25 ms bake inside the step would be a 15–25 ms hitch whenever a region commits. The step therefore only
  **enqueues** the region; GL-F drains its own queue in `GrassField.update` in row slices of ≤ 1 ms per frame (or the
  converter pre-bakes the floor mask, §12 Q3). The window shows the region's grass once its slices are done (a region
  commits ≥ 200 m ahead of the player on Medium, so the fill-in is never seen) [projected].

### 3.2 Where grass grows: the splat, not the vertex word

- **Grass weight per splat layer** [decision]: 1 for tiles typed Grass, LongGrass or Forest; 0.45 for grassy-dirt tiles
  (`grass`/`weed` in a Dirt tile's name, e.g. `wc_grass02_01`; today's scatter uses `GRASSY_DIRT = 0.35` [confirmed:
  `scatter.ts`], so these tiles get a little more); 0 for everything else and for any pavement, rock or water name
  (today's `BARE_NAME`).
- **Composite through the native layers** (TERRAIN §2.3): layer 0 is opaque, each later layer replaces the corners its
  mask covers, in draw order. So the grass follows the painted edge of the terrain texture instead of the per-vertex
  word, and road edges become a bilinear ramp across one 2 m cell (16.7 % of the grass cells are such edge cells).
- Then × `smoothstep(0.70, 0.80, normal.y)` (slope), 0 under water (+ 0.1 m), 0 on object floors (today's rule: a nav
  object surface at or above the ground − 0.3 m).
- **In the shader:** a clump exists when `density > clumpRand`; its blades are scaled by
  `smoothstep(0, 0.3, density − clumpRand)`, so the grass thins **and shortens** toward a road: a soft painted edge, not
  today's hard 2 m margin [confirmed: lab, `look_high_v0.png`].
- The **beaches** of the coast part are sand tiles, so they get no grass automatically; the coast's re-export changes
  the terrain and the field follows with no extra work (§8.3).

### 3.3 Geometry and LOD

One shared patch mesh per LOD tier holds every blade of one 8 m cell; clumps sit on a jittered grid, blades within
16 cm of their clump centre; blade 0 of each clump is tier 0, blades 1–2 tier 1, the rest tier 2 [confirmed: lab].

| Per preset | Low | Medium | High | Ultra |
|---|---|---|---|---|
| Grass | retail scatter (the Low guard) | new | new | new (High's numbers, far × 1.1) |
| Clumps per 8 m cell | — | 22 × 22 (7.6 /m²) | 26 × 26 (10.6 /m²) | as High |
| Blades per clump (tier 0 / 1 / 2) | — | 6 (1 / 2 / 3): **45 blades/m²** | 7 (1 / 2 / 4): **74 blades/m²** | as High |
| Near tier: all blades, 4 rows (7 vertices, 5 triangles) | — | cells < 14 m; tier-2 fade 9–13 m | < 20 m; 13–19 m | as High |
| Mid tier: tiers 0–1, 3 rows (5 vertices) | — | cells < 32 m; tier-1 fade 24–31 m | < 46 m; 36–45 m | as High |
| Far tier: tier 0, one triangle, widened | — | cells < 58 m; per-blade cut-off 40–57 m | < 82 m; 56–81 m | < 90 m (the window's 96 m reach) |
| Blade width (near) | — | 3.2 cm | 2.8 cm | 2.8 cm |
| Patch vertices near / mid / far [confirmed: lab] | — | 21,252 / 8,184 / 1,452 | 34,272 / 11,288 / 2,028 | as High |
| Patch triangles near / mid / far [confirmed: lab] | — | 15,246 / 5,082 / 484 | 24,562 / 6,986 / 676 | as High |

- **Fades** (Tidewater's scheme): tier-2 blades shrink away before the near edge, tier-1 before the mid edge, and tier-0
  blades thin out one by one past a random cut-off; the blades that remain widen by `total / (1 + 2 f1 + rest × f2)` so
  the coverage stays constant [confirmed: no visible ring at the tier edges in the lab's ground-level shots].
- **Beyond the far tier** the terrain carries the colour: **GL-T** adds a terrain chunk that pulls the grass-weighted
  ground toward the palette's mid colour by density, so the carpet and the ground beyond it match (the lab's top view
  shows the edge without it, `look_high_top.png`) [projected].

### 3.4 Shape and motion

- **Blades:** height 0.30–0.72 m × (0.55 + 0.45 × density), so lush fields are knee-high and thin grass is short; a
  taper `(1 − t)^0.7`; a quadratic lean of 12–50 % of the height in a random direction; the facing mixed 55 % toward the
  camera (§2.1).
- **Wind:** the chunk graph's `sroWind(root)` (D23, `weather/chunks.ts`) at the shared sway point: the weather's wind
  direction, a travelling gust, storm strength, the rain droop. Grass, trees and the retail foliage sway alike.
- **The player pushes the grass aside** within 0.9 m (a uniform with the local player's position; blades bend away and
  down) [confirmed: lab]. Other players and mobs: up to 8 positions later (cut 5).
- *(fact-check)* **Thin blades and anti-aliasing.** With the game camera's vertical FOV of 0.85 rad
  (`screens/world.ts`) a 1080p pixel is ≈ 0.78 mm per metre of distance, so a 3.2 cm blade is ≈ 3 px wide at its base
  at 14 m, and the tapered tips are always sub-pixel [projected arithmetic]. Medium has **FXAA only**, High's TAA is
  **off while the camera moves** unless reprojection is on (`post.ts`: `disableOnCameraMove = !p.taaReprojection`)
  [confirmed], and Macs render at scale 0.75 (`settings.ts`). Walking through the field can therefore shimmer
  [likely]; the lab judged stills only. GL-S adds a **pixel-width floor** (each blade at least ≈ 1 px wide at its
  mid-height, from the projection, the way the far tier already widens) and H-GL lens 14 checks the field in motion on
  Medium and on a 0.75 render scale.

### 3.5 The look: "lush painterly"

- **Palette per terrain tile:** a base and a tip colour per grass tile, from the tile image's dark and light deciles
  (e.g. `c_grass_hmfld_01`: dark 10 % ≈ (20, 36, 7), light 10 % ≈ (88, 110, 40) in sRGB [confirmed: the palette run
  over `tiles/c_grass*.png`; *fact-check*: that script was not kept in the folder, and a re-run of the luma deciles on
  `work/out/world/jangan-fields/tiles/c_grass_hmfld_01.png` gives (20, 35, 8) / (87, 111, 39)]. The lab itself uses a
  hand-tuned 6-entry table (`grass-lab.ts` `PALETTES`), not the converter's per-tile values). The converter computes them from the tile the client
  actually loads (GL-C), so 9B's remastered tiles re-derive their palettes. The blade's base is darker than the tip (a
  built-in ambient occlusion: `vShade` 0.5 → 1).
- **Painted patches:** two octaves of value noise (13 m and 48 m) push each blade's tip between a cool blue-green and a
  warm yellow-green, like the brush patches of SRO's field textures; ±8 % brightness per blade; 1.5 % dry straw blades
  [confirmed: lab]. No texture is sampled per pixel.
- **Light:** the RND-W chunk unchanged (bent normal, wrapped N·L 0.4, the SH sky, the back-lit translucency, the CSM tap
  at the root on High+, the cloud shadow, the height fog, the TAA jitter).
- **Weather:** the WX chunks unchanged: rain bows the heads downwind and droops them, wet darkens the albedo (× 0.775)
  and adds a sheen, and sheltered grass (under eaves and trees) stays dry (`sroShelter`) [confirmed: lab, rain shot].
- **Night:** the night-light splat chunk (SRO_NIGHT_GRASS) rebuilds the root position from `vLm` and `scRegion`, which
  the new shader keeps (`scRegion` = the window's origin) [confirmed: compiles; night shot].

### 3.6 Weather and time in one line each

| Condition | Grass | Flowers |
|---|---|---|
| Calm | slow sway | same |
| Wind (8–16 m/s) | stronger bend downwind, gust waves | same |
| Rain | heads bow and droop, darker, wet sheen; dry under shelter | same |
| Night | the sky light and the night-light splat; fireflies (§5.4) | petals darker (no emission) |

### 3.7 The seam contract: the retail grass's chunk points

The new shaders keep `scatterShaders`' skeleton and names (`finalWorld`, `root`, `wp`, `h`, `s`, `ph`, `t`, `sway`,
`bend`, `p` in the vertex main; `c`, `lm`, `rgb` in the fragment; the `scCamera`/`scFade`/`scRegion`/`scTint`/`scShadow`
uniforms; the `vLm`/`vShade`/`vDepth` varyings) and insert the same `GrassPoint` chunks (shader-chunks.ts). So the sky,
weather, night-light and RND-W chunks light the new grass **with no edit to any of them** [confirmed: the lab builds
its shaders from `WORLD_SHADER_CHUNKS` unchanged, on WebGPU and WebGL2]. It adds `vCol` (vec3) where the retail shader
has `vUV` (vec2), so the varying count is the retail grass's (§6.3).

---

## 4. Flowers and small plants

### 4.1 In the grass mesh (no extra draw)

- **Flowers ride in the grass patch** [decision; confirmed in the lab]: ≈ 12 % of the clumps also carry a flower (66 of
  484 per Medium patch, 82 of 676 per High patch), a stem (1 triangle) and a 10-point star head (10 triangles; 11 with
  the stem, 14 vertices) [confirmed: the §3.3 vertex counts minus the blades] that tilts toward the camera. They exist in the near and mid tiers
  and fade out by the flower range (26 m Medium, 36 m High). They cost vertices only; the draw count stays 3.
- **Where:** a clump shows its flower when the **meadow mask** (field G, §3.1) is above the clump's random value. The mask
  is two octaves of value noise (22 m and 6 m) through a smoothstep, times the grass density, so flowers come in drifts
  and meadows, never as an even sprinkle, and never on roads, paving or thin grass [decision].
- **Colours:** white, buttercup yellow, violet, pink and poppy red, with a yellow centre (the lab's set, close to the
  retail `flw_g01_*` hues). The palette is data (§3.5), so the user can pick it.

### 4.2 Small plants

| Kind | Where | Draw | Status |
|---|---|---|---|
| Wildflowers (4.1) | meadow mask × density ≥ 0.6 | in the grass mesh | prototype [confirmed] |
| Clover and broadleaf tufts (flat, round leaves close to the ground) | 3 % of lush clumps, more under trees (the baked-light channel A < 0.7; *fact-check*: A stays 255 wherever Q4's lightmap copy is skipped, e.g. Medium, so "under trees" then falls back to a tree-placement mask baked with the field) | in the grass mesh (a 4th vertex kind) | GL-S [projected] |
| Fern-like weeds (taller, arched fronds) | edges of forest tiles (`Forest` type, or density falling off beside rock) | in the grass mesh | GL-S [projected] |
| Reeds and cattails | the grass within 3 m of inland water (retail water planes: lake, rivers, swamp) | in the grass mesh | cut 4 (§9) |
| Bushes | the retail bush **objects** (placed models) stay; the retail scatter's "bush" kind (`grs_weed01`) goes with the retail grass | — | [decision] |

- **Art:** geometry with vertex colours first (no texture, like the blades). A painted petal/leaf atlas (a 512² RGBA,
  4 flower shapes and 2 leaf shapes, made by a local Python/Pillow script in GL-A; the SDXL pipeline only if the user
  asks, §11) is an option for the flower heads: an alpha-cut fetch on well under 1 % of the grass pixels.
- **Density rule** [decision]: kind k grows on a clump when `density ≥ minDensity_k`, `meadow` (flowers) or its own
  mask (clover: shade; ferns: forest edge; reeds: water distance) is above the clump's random value, and the slope is
  under 25°. All masks live in the field window, so the rule costs nothing on the CPU per frame.

---

## 5. Wildlife

### 5.1 Common rules

- **Client-only and cosmetic** [decision]: no protocol message, no server state, not pickable, no collision, no nav.
  Each client spawns its own animals around its own player; two friends standing together see similar, not identical,
  animals (seeded by region and game hour, so a spot keeps "its" butterflies while the player stays).
- **One `World.life` part** updates once per frame after the grass; it spawns and retires animals around the focus
  within fixed pools (no allocation per frame), and draws each kind as **one instanced mesh** (thin instances, a data
  record per animal), `alwaysSelectAsActiveMesh` with its own culling.
- **Lighting:** every animal shader is built on the same grass skeleton (§3.7), so the sky, weather, night-splat and
  RND-W chunks light it (HDR, SH, CSM tap, fog, TAA jitter) with no new plumbing [confirmed: the lab's butterflies and
  birds]. No animal casts a shadow (the birds may get a blob later, cut list).
- **Time of day and weather** [decision]. The thresholds are the bird-song ones of the weather audio
  (`apps/game/src/audio/weather.ts`: birds mute at rain > 0.25 or wind > 10 m/s and come back below 0.2 / 9 m/s
  [confirmed]), so what the player hears and sees agree. `night` is `SkyState.night` (0 day .. 1 night).

| Kind | Clear or cloudy day | Rain > 0.25 or wind > 10 m/s | Dawn and dusk (night 0.2–0.6) | Night (> 0.6) |
|---|---|---|---|---|
| Butterflies | 20–40 within 30 m on meadow (Medium 20, High 40) | none; they fade out over 5 s | a few, slower | none |
| Ground flocks (sparrows) | 1–2 flocks of 8–16 | none (they "go under cover": fly off and do not come back until it clears) | yes | roost: none |
| Roof perchers (magpies, crows) | 4–10 on nearby ridges | **only perches under shelter** (`sroShelter` < 0.5 at the perch, WEATHER §6.5) | yes | none |
| Fly-overs (swallows low over fields; egrets over water) | one group every 30–90 s | none | swallows at dusk | none |
| Dragonflies | 6–12 within 25 m of inland water | none | a few | none |
| Fireflies | none | none (drizzle below 0.1 keeps them) | from night 0.3, fading in | 60–120 within 40 m on grass near trees and water |

### 5.2 Butterflies (GPU-procedural)

- **Instance:** an anchor (a meadow spot), a seed, a species and a wander radius (2–6 m). The CPU only places anchors
  when the player moves; the vertex shader computes the flight [confirmed: prototype]:
  - two incommensurate loops around the anchor, a bob, and the analytic velocity for the heading;
  - a sit cycle: every ~14 s the butterfly settles on a flower for 2–3 s with slow wing beats (the "landing on flowers");
  - wings: two quads hinged at the body, flap 15 Hz in flight, 2 Hz sitting; a procedural wing pattern in the fragment
    (fore and hind wing ellipses, dark border, spots) for 4 species: orange (monarch-like), white (cabbage white),
    brimstone yellow, blue. No texture [decision].
- **Cost:** 6 triangles per butterfly (two wing quads and a body quad, 12 vertices; *fact-check*: "12 triangles" was
  the vertex count) [confirmed: `grass-lab.ts` `Life.create`], one draw for all. 28 butterflies in the lab.
- *(fact-check)* **Anchors also come from placed flowers.** The lab places anchors only where the field's meadow mask
  and density allow, so butterflies never appear over paving. The palace-steps stage's flower beds (SCREENS §0B.10:
  placed `group_grs01` / `flw_g01_*` models) and town gardens stand on paved or bare ground [likely], so GL-L adds a
  second anchor source: the placements of flower models (`flw_*`, `grs_flower*`) within range.
- **Scale:** real butterflies (5–6 cm wings) vanish at game camera distances. The lab drew them at 2.2× (≈ 12 cm), which
  reads at 5–10 m and still looks like a butterfly [decision, the user checks it].

### 5.3 Birds (CPU flocks, instanced)

- **Simulation** (CPU, tiny: 14 birds plus the grass cull stay under Chrome's 0.1 ms timer resolution in the lab
  [confirmed]):
  - flock states: **circle** (a slowly drifting centre, each bird on a ring slot with separation), **land** (each bird
    glides to its own slot around a landing spot, braking with flaps), **ground** (wings folded, pecking, 8 cm hops),
    **flush** (a threat within 9 m: each bird takes off after its own delay of 0–0.35 s plus 20 ms per metre from the
    threat, up and away at 9 m/s with fast flaps; *fact-check*: for a threat at 9 m that is 0.18–0.53 s, so the whole
    flock is up within ≈ 0.55 s, not 0.4 s), then circle again and land somewhere else after 20–40 s;
  - individual steering with a max acceleration (14 m/s²), a floor at the terrain height, flap vs glide by climb and
    speed (glide bursts in cruise, fast flaps when climbing or slow).
- **Threats:** the local player and any actor the client knows within range (players, mobs, NPCs walking by), read from
  the entity positions, not the camera [decision]. A jump (MOVEMENT) counts like walking. *(fact-check)* The entity
  list lives in the app, so one call in `apps/game/src/screens/world.ts` (`world.life?.setThreats(fn)`) wires it; that
  file is shared with MOVEMENT's client lane (the Space key handler, MOVEMENT §6) [likely] (§8.3 shared files).
- **Landing spots:** open grass with density ≥ 0.5, 14–24 m from the player and away from actors; **roofs** from a
  perch-point list (the ridge of each building model, transformed by its placement) [projected]; tree crowns are not
  perches in v1. *(fact-check)* Default source: **at run time from the manifest**, the top face of each building
  model's `boundsMin/boundsMax` along its long axis, transformed by the placement (every model entry carries its
  bounds [confirmed: `manifest.models[]`]), which needs no converter change, no new file and nothing new to deploy;
  GL-C's `perches.json` from the real ridge vertices is the fallback if the bounds put birds in the air [likely:
  hipped Chinese roofs peak at the bounds' top].
- **Species (procedural low-poly, 17 triangles, per-species colour and scale):** sparrows (ground flocks), magpies/crows
  (perchers, pairs), swallows (fly-overs at dusk), egrets (white, standing in shallow water, slow flight); the coast
  part registers **gulls** through `life.addSpecies` / `addHabitat` (COAST B15, §8.3). The lab has one sparrow-like
  flock.
- **Rendering:** one instanced mesh for all birds; per bird a 2-vec4 record (forward + flap phase; bank, fold, scale,
  flap amplitude) plus the position; the vertex shader bends a two-segment wing (shoulder and wrist; the outer segment
  lags ×1.5) and tucks it along the body when folded. Tidewater uses three bones and a 16-vec4 record; two segments are
  enough at our camera distance [decision].
- **Sound:** a flush plays one of the retail bird one-shots (`env/day_bird01..05`, SOUND §5.10) at the flock's
  position, at most once per flush [decision]; a wing-flutter sound does not exist in the retail set [unknown], and is
  not made in v1.

### 5.4 Fireflies

- Additive glow billboards (a core plus a halo, `exp` falloff), drifting on slow loops 0.5–1.4 m above the grass,
  blinking (`pow(sin, 5)` per seed); one draw [confirmed: prototype].
- Emission in scene-linear HDR scaled by `1 / exposure` (`rgMisc.z`, the night-light rule), so at night exposure (≈ 24)
  they bloom a little and never blow out [projected; the lab tuned the gain by eye].
- Spawned on grass near trees and water (the baked-light channel < 0.8, or water within 30 m).

### 5.5 Dragonflies

- The butterflies' mesh and shader with two more species ids (a long body and 4 narrow wings): dart-and-hover flight
  (straight darts of 1–3 m, 1–2 s hovers) over inland water, 0.3–1.2 m above it [decision; not in the prototype].
  0 extra draws.
- Only near the retail inland water planes (lake, rivers, swamp), not the sea (the coast part's ocean) [decision].

---

## 6. The prototype

### 6.1 What was built

| Part | Where |
|---|---|
| Lab server | `work/tmp/grass-life/lab/vite.config.mjs`: a private Vite on :5243 (the viewer app's root, `work/out` at `/out/`), stopped afterwards |
| Lab page | `lab/grass-lab.ts` at `/grass-lab`: loads `jangan-fields` through `loadWorld` (PBR path, modern sky, the real streaming), bakes a 256 m field window from the resident regions' terrain bins (native layers, slope, water, `nav.locate` object floors), draws the new grass as 3 thin-instance meshes (one per tier) with CPU cell culling, the butterflies (one mesh, GPU-procedural), one 14-bird flock (CPU state machine, one mesh) and fireflies at night (one mesh) |
| Shaders | `lab/grass-shaders.ts`: the skeleton of §3.7 built from `WORLD_SHADER_CHUNKS` unchanged, the blade/flower, butterfly, bird and firefly bodies, WGSL and GLSL. The materials borrow the retail scatter's shared uniforms, defines and CSM depth texture (what `WorldScatter.adopt` will do, §8.1) |
| Driver | `lab/cdp-run.ts`, `lab/bench.sh`: the lab's own headless Chrome 154 (one tab, its own profile, port 9353), 1920 × 1080; screenshots through CDP; the Chrome instance and profile removed afterwards. The launch flags were not recorded; the fact-check's re-run used `--headless=new --enable-unsafe-webgpu --ignore-gpu-blocklist --window-size=1920,1080` |
| Analysis | `coverage.py` (§1.2), `coverage_map.py` (the map), `overview.py` (the sheet) |

Modes: `retail` (the world as it is), `none` (the retail scatter hidden, no new grass: the baseline), `patch` (the new
grass east of a 64 m scatter-chunk line, retail west of it: the side-by-side), `full` (the new grass everywhere in the
window, the retail scatter hidden), `full&life=0` (the grass alone). Views: the fields east of Jangan's east wall
(x 448, z 10; the split line is x = 448) at 11 m (v0), 26 m (v1), 4 m (v4, ground level) and 60 m (v5, from above);
the western fields (x −256, z 110; v3).

### 6.2 Method

- The dev PC (Ryzen 5 9600X, RX 9060 XT), Chrome 154 headless, WebGPU and WebGL2, 1920 × 1080, clear noon (t 0.42),
  weather off for the timings.
- **GPU lock** held for every timing run (`work/tools/gpu.lock`, owner `grass-life`, 22:58–23:15 on 2026-09-29);
  no other GPU job ran.
- Per run: 300 frames after the streamer went idle and 60 settle frames. CPU = `scene.render` wall time (the grass
  cull and the flock update are timed separately, "update"). GPU = the sum of Babylon's WebGPU timestamp counters
  (the main pass plus every render target; with no per-target counters the main-pass counter carries the whole frame:
  2.85 ms both ways at High [confirmed]). WebGL2 has no timer query in Chrome: no GPU number there.
- Three runs per configuration; the table gives the median of the per-run p50 (and the minimum). Chrome's timer has a
  0.1 ms resolution here, and the run-to-run noise of a headless page is about ±0.5 ms (TREES §4.4 found 3–4.6 ms on a
  busier scene), so CPU differences under 0.5 ms are not significant.
- Raw JSONs: `work/tmp/grass-life/shots/bench_*.json`; the table: `work/tmp/grass-life/bench-summary.md`
  (`lab/aggregate.py`).

### 6.3 Results [confirmed: measured]

The fields east of Jangan, 26 m camera (v1), and at ground level (v4). "retail" = the world today; "none" = no grass
at all; "new" = the new grass everywhere in view with the butterflies and the flock; "new, no life" = the grass alone.

| Engine | Preset | View | Mode | Draws per frame (all passes) | CPU render p50 median (min) | CPU p95 median | GPU frame p50 median (min) | New grass cells near / mid / far | Grass vertices / triangles submitted |
|---|---|---|---|---|---|---|---|---|---|
| WebGPU | Medium | v1 | retail | 93 | 1.6 (1.5) | 2.3 | 1.17 (1.01) | — | — |
| WebGPU | Medium | v1 | none | 73 | 1.4 (1.3) | 2.1 | 1.07 (0.91) | — | — |
| WebGPU | Medium | v1 | **new** | **78** | 1.5 (1.3) | 2.4 | 1.22 (1.06) | 8 / 16 / 30 | 345 k / 218 k |
| WebGPU | Medium | v1 | new, no life | 76 | 1.4 (1.4) | 3.3 | 1.22 (1.06) | 8 / 16 / 30 | 345 k / 218 k |
| WebGPU | High | v1 | retail | 193 | 3.0 (2.8) | 4.0 | 2.78 (2.77) | — | — |
| WebGPU | High | v1 | none | 163 | 2.5 (2.5) | 3.6 | 2.80 (2.51) | — | — |
| WebGPU | High | v1 | **new** | **168** | 2.8 (2.6) | 4.1 | 2.85 (2.72) | 14 / 26 / 62 | 899 k / 567 k |
| WebGPU | High | v1 | new, no life | 166 | 2.7 (2.6) | 4.3 | 2.86 (2.82) | 14 / 26 / 62 | 899 k / 567 k |
| WebGPU | Medium | v4 | retail | 144 | 2.3 (2.1) | 4.0 | 1.05 (0.89) | — | — |
| WebGPU | Medium | v4 | **new** | **125** | 2.2 (2.0) | 3.4 | 0.93 (0.93) | 7 / 15 / 34 | 321 k / 199 k |
| WebGPU | High | v4 | retail | 285 | 4.4 (4.3) | 7.5 | 2.24 (1.96) | — | — |
| WebGPU | High | v4 | **new** | **255** | 4.0 (3.8) | 6.0 | 2.60 (2.59) | 10 / 27 / 63 | 775 k / 477 k |
| WebGL2 | Medium | v1 | retail | 93 | 1.0 (0.9) | 1.6 | — | — | — |
| WebGL2 | Medium | v1 | none | 73 | 0.9 (0.8) | 1.8 | — | — | — |
| WebGL2 | Medium | v1 | **new** | **78** | 1.4 (0.9) | 1.8 | — | 8 / 16 / 30 | 345 k / 218 k |
| WebGL2 | Medium | v1 | new, no life | 76 | 1.3 (0.9) | 2.1 | — | 8 / 16 / 30 | 345 k / 218 k |
| WebGL2 | High | v1 | retail | 193 | 2.2 (2.0) | 2.6 | — | — | — |
| WebGL2 | High | v1 | none | 163 | 1.5 (1.5) | 2.3 | — | — | — |
| WebGL2 | High | v1 | **new** | **168** | 2.3 (1.9) | 3.3 | — | 14 / 26 / 62 | 899 k / 567 k |
| WebGL2 | High | v1 | new, no life | 166 | 1.5 (1.5) | 2.0 | — | 14 / 26 / 62 | 899 k / 567 k |

What it shows:

- **Draws:** the retail scatter costs **20 draws at Medium and 30 at High** in this view (retail − none); the new grass
  costs **3**, the butterflies and the flock **2** more. So the fields view goes 93 → 78 (Medium) and 193 → 168 (High),
  and at ground level 144 → 125 and 285 → 255 [confirmed]. The count no longer grows with the number of 64 m chunks or
  plant kinds in view. *(fact-check)* The lab counts `engine._drawCalls` around the whole `scene.render`, so these are
  **all passes** (CSM, shelter and post included), not the main pass alone; and one run in three draws 4 fewer
  (streaming state: 189 vs 193, 164 vs 168) [confirmed: the per-run JSONs].
- **CPU:** the new grass with its life is **no slower than the retail scatter** within the noise: WebGPU −0.1 ms
  (Medium), −0.2 ms (High), −0.4 ms at ground level on High; WebGL2 +0.4 ms (Medium) and +0.1 ms (High), where the
  minima are equal (0.9 vs 0.9, 1.9 vs 2.0). The grass cull and the bird flock together take **under 0.1 ms p50 and at
  most 0.1 ms p95** (the timer's resolution) [confirmed]. The retail scatter's chunk builds (0.3–0.5 ms each, one per
  frame while walking) disappear [likely: the lab times `scene.render` only].
  *(fact-check)* The table's WebGL2 High medians hide one odd pair: "new" 2.3 ms against "new, no life" 1.5 ms in all
  three original runs (2.3 / 2.3 / 1.9 vs 1.5 / 1.5 / 1.5), i.e. +0.4 to +0.8 ms for two life draws. The fact-check
  re-ran it (GPU lock held 23:25–23:31, 3 interleaved runs each, `shots/fcheck_webgl_high_v1_*.json`): new 3.3 / 1.6 /
  1.5, no life 2.4 / 1.6 / 1.5, birds only 1.7 / 1.6 / 1.6 ms p50. The life costs **≈ 0 to 0.1 ms** on WebGL2 High;
  the original gap was run-to-run noise (in the re-run the first repetition of every configuration was the slow one)
  [confirmed: re-run].
- **GPU:** the new grass is nearly free on the dev GPU at this density: +0.05 to +0.15 ms against no grass in the
  fields view, and against retail −0.12 ms (Medium, ground level) to +0.36 ms (High, ground level, 775 k vertices)
  [confirmed]. Opaque blades need no alpha test, so there is no overdraw penalty where the retail cards had one.
  *(fact-check)* These GPU deltas sit at the noise floor: in every mode the third run reads ≈ 0.15 ms lower than the
  first two (e.g. Medium "none" 1.07 / 1.07 / 0.91), and per-run p50 = p95 suggests the counter updates rarely [likely]. Taken
  min-vs-min, High at ground level is **+0.63 ms** against retail (2.59 vs 1.96), not +0.36 [confirmed: per-run JSONs].
  §7.2's GL-S budget is set against that.
- **Inter-stage variables** (`wgslInterStageCount` of the compiled WGSL): the new grass **7 at Medium, 8 at High, 9 in
  rain**, exactly the retail grass's (7 / 8 / 9); the butterflies one more (8 / 9 / 10, their wing UV); the birds as
  the grass [confirmed]. All ≤ 15 user varyings, so the 16-varying adapters are safe.
- **Bake:** the lab's whole-window bake (65,536 texels, the unoptimised lab code, patch meshes included) took 23–62 ms
  over 51 runs (median ≈ 35 ms), and 27.8 ms without vs 33.1 ms with the object-floor test in the A/B pair (the test
  ≈ 5 ms) [confirmed: `bake_occ*.json`, all `bakeMs`]. Production bakes per region after `'objects'`, in GL-F's own
  ≤ 1 ms slices, never inside one streamer job (§3.1).

### 6.4 What the prototype showed about the look [confirmed: the shots]

- `ov_side_high.png` / `ov_side_med.png`: retail left of the chunk line, new right, same light. The retail field is a
  sprinkle of orange tufts over the ground; the new field is a continuous carpet with painted patches.
- `ov_close_high.png` / `look_high_close.png`: at ground level the blades read as lush and soft, the flowers as small
  stars, a butterfly passes. The blade-level quality holds up close.
- `ov_rain_high.png`: the WX chunks darken, wet and bow the new grass with no code of their own.
- `ov_night_high.png`: fireflies blink over the grass (a few lit at a time: the blink is a sharp pulse); the night splat
  and the SH sky light the blades.
- `ov_birds.png`: the flock lands in the grass (the sparrows are hidden in grass that is taller than they are, which is
  natural), and bursts up when the player walks within 9 m.
- `ov_top_high.png` / `look_high_top.png`: from 60 m, no 8 m tiling is visible; the far edge of the carpet shows against
  the terrain beyond (GL-T's job).
- `ov_webgl_med.png`: WebGL2 draws the same grass. The black terrain band in that shot is TREES Q6's WebGL2 headless
  terrain issue (it is the terrain, not the grass; seen in the TREES lab before this work).
- Tuning that mattered: blades 2.8–3.2 cm wide (5 cm read as coarse "spikes"), 45–74 blades/m² (25/m² still showed
  ground), palette brightness 0.76 of the tile's light decile (brighter read as lime), dry blades 1.5 % (5 % read as
  dead grass).
- Sheet for the user: `work/tmp/grass-life/overview.png`.

### 6.5 Limits of the prototype

- One 256 m window baked once (production re-centres it); the baked-light channel was left at 1 (no lightmap copy);
  wildlife anchors were placed once around the start; no dragonflies, perchers or fly-overs; flowers are star
  polygons; no terrain tint. Each is a lane item in §8.
- Headless Chrome on one PC; Apple Silicon and mid GPUs are projected (§7).
- *(fact-check)* The look was judged on stills; nobody walked through the field (shimmer, §3.4). The lab hides an
  empty tier with `setEnabled(false)`, which marks wave 9's `EnabledMeshCandidates` list dirty on every flip (a rebuild
  over ≈ 3,700 scene meshes, `render/active-meshes.ts`) [confirmed: code read]; production uses `isVisible` instead
  (§8.4 GL-F). The lab meshes are tagged `sroWorld: 'grass2'`; BATCHING §3.6 fixes the tags as `'scatter'` / `'life'`.

---

## 7. Budgets

### 7.1 Per preset (WAVE_PLAN3 §5.2 format; 1080p)

Dev PC = Ryzen 5 9600X + RX 9060 XT, Chrome, WebGPU. "Mid" = RTX 3060 / RX 6600 class (≈ 2× the dev GPU's time for
this vertex-bound work) [projected]. "M1" = a base Apple M1 GPU (≈ 6× the dev GPU's time) [projected]. *(fact-check)*
"iGPU" = Iris Xe / 680M at render scale 0.75 + FSR1, the column WAVE_PLAN3 §5.2 carries and a class `settings.ts`
recommends Medium for (`'integrated'`) [confirmed: code read]; ≈ 6–8× the dev GPU for vertex work [projected]. The dev
rows are §6.3 (the fields at 26 m and at ground level, grass + butterflies + one flock, against the retail scatter).

| Preset | Ground cover draws (main) | Casters | CPU, dev (measured) | Grass + life GPU, dev (measured) | GPU, mid [projected] | GPU, M1 [projected] | GPU, iGPU [projected] |
|---|---|---|---|---|---|---|---|
| Low (Classic) | retail scatter, unchanged (its 'low' level draws 2 kinds per chunk) | 0 | unchanged | unchanged | unchanged | unchanged | unchanged |
| Medium | **3 grass + ≤ 3 life** (retail: 20 in the fields, 20 at the plaza) | 0 | ≤ retail (−0.1 ms WebGPU; +0.4 ms WebGL2 median, equal minima); cull + life < 0.1 ms | +0.15 ms vs none; −0.12 to +0.05 ms vs retail (medians; ±0.15 ms GPU-clock noise) | ≤ 0.4 ms | ≈ 1.0–1.5 ms; Grass: Low (Mac default until checked) ≈ 0.4–0.6 ms | ≈ 1.0–1.8 ms; Grass: Low (iGPU default) ≈ 0.4–0.7 ms |
| High | **3 + ≤ 3** (retail: 30 in the fields, 35 at the plaza) | 0 | ≤ retail (−0.2 to −0.4 ms WebGPU; +0.1 ms WebGL2) | +0.05 to +0.2 ms vs none; +0.36 ms (median) / +0.63 ms (min-vs-min) vs retail at ground level | ≤ 1.3 ms | ≈ 2–4 ms (not a Mac default) | not a default |
| Ultra | 3 + ≤ 3 | 0 | as High | as High + the longer far tier (≈ +10 %) | ≤ 1.4 ms | not offered | not offered |

What it means:

- **The draw-count win is real and fixed:** the ground cover drops from 20–30 draws to 3–6, whatever the view, which is
  exactly the CPU cost wave 9 is short of.
- **The GPU cost moves to vertices.** It is small on the friends' desktops and gaming laptops. On a base M1 at Medium
  the grass is the most expensive new item of this spec (≈ 1–1.5 ms) [projected], which is why Macs start at Grass: Low
  until one friend's Mac is measured (§11 item 6).
- *(fact-check)* **The plaza gains too.** The earlier "no grass there" was wrong: the plaza view draws **35 retail
  scatter chunks on High and 20 on Medium** (BATCHING.md §3.6 and its draw table) [confirmed: BATCHING's measured
  counts], which become ≤ 3 + ≤ 3. That is part of item 1's "well under 100" (BATCHING F24).
- **Memory:** the field window 256 KiB + 65 KiB; the patch meshes ≈ 1.5 MB at Medium and ≈ 2.3–2.5 MB at High (3 tiers;
  position vec3 + two vec4 attributes = 44 B per vertex, 30,888 / 47,588 vertices, plus indices) [projected arithmetic;
  *fact-check*: was "1.3 MB (High)"]; the wildlife < 50 KB. The retail plant glbs and textures are no longer loaded on
  Medium+ for the scatter [likely]; the placed retail plants of §1.3 that stay still load theirs.
- *(fact-check)* **Grass: Low keeps the density.** The lab found that 25 blades/m² "still showed ground" (§6.4). The
  first draft's Grass: Low (0.6 density = 27 blades/m²) would have given every Mac the gaps the user asked to remove.
  Grass: Low is now Medium's 45 blades/m² with the tier distances × 0.6 (near 8 m, mid 19 m, far 35 m): ≈ 0.36–0.45 of
  Medium's vertices, the same saving [projected arithmetic], with GL-T's terrain tint hiding the nearer edge (which is
  why GL-T moved down the cut list, §9).
- **Download:** nothing new (procedural geometry, the palettes are a few numbers per tile in the manifest).

### 7.2 Per-lane budgets (dev PC, 1080p, the fields spots of §6; minimum of 5 runs, GPU lock held)

| Lane | Budget |
|---|---|
| GL-F | cull + buffer upload ≤ 0.1 ms p95; window re-centre ≤ 0.5 ms; a region bake ≤ 1 ms per frame slice (≤ 25 ms in total per region), never one streamer job; ≤ 3 draws; no `EnabledMeshCandidates` rebuild from the grass while walking |
| GL-S | grass GPU ≤ +0.7 ms against the retail scatter on High at ground level (*fact-check*: the prototype measured +0.63 min-vs-min, so the earlier ≤ +0.3 ms was already failed), ≤ +0.2 ms on Medium; varyings ≤ the retail grass's |
| GL-T | ≤ 0.1 ms GPU; **no new terrain sampler** (*fact-check*: D32 puts High's WebGL2 terrain at ≈ 14–15 of 16 units before the wet map and ripples [confirmed: WAVE_PLAN3 D32], so GL-T reads the tint from the layer tile ids the terrain already fetches, through a per-tile uniform table, not from the field window) |
| GL-L | all wildlife ≤ 0.1 ms CPU p95, ≤ 0.1 ms GPU, ≤ 3 draws (butterflies + dragonflies, birds, fireflies) |
| Whole game | `prof.js` p95 at the plaza and the crowd not worse than before (*fact-check*: the plaza has 20–35 retail grass draws today, so it should improve); the fields view has fewer draws than retail on every preset; BATCHING §3.6's "≤ 0.2 ms CPU per frame for grass and life together" |

---

## 8. Lanes

Lane ids are `GL-*`. Every lane runs `pnpm vitest run <its tests>` and `pnpm typecheck` before hand-off; nobody commits;
the lead integrates.

### 8.1 The key seam: `WorldScatter` stays the facade [decision]

Every chunk lane binds its uniforms, defines and depth textures to `world.scatter` today (`sharedUniforms`,
`setDefine`, `setDepthTexture`; e.g. `night-lights.ts` sets `nlGrass` on `host.scatter.sharedUniforms`, the sky
attaches `ground: [terrain, scatter]`, `RenderGrass` follows it) [confirmed: read]. So the new grass is **a second style
inside `WorldScatter`**, not a new world part: `WorldScatter` keeps its plumbing and hands `addRegion`, `removeRegion`,
`update`, `setLevel` and `dispose` to either the retail chunks (Low, and "Retail" for an A/B) or the new `GrassField`.
A new `WorldScatter.adopt(material)` gives any foreign `ShaderMaterial` (the field's, the wildlife's) the same shared
uniforms, defines and depth textures, now and on every later change. No chunk lane edits a line.
[confirmed, fact-check: `night-lights.ts` sets `nlNight`/`nlGrass`/`nlGrassSplat` on `host.scatter.sharedUniforms`
(lines 565–774), `weather/index.ts` binds `wxA…wxOccM` and `wxOccMap` there (lines 197, 257), and the sky attaches
`ground: [terrain, scatter]` (`world.ts` line 462). The night chunk rebuilds the root from `vLm` × 1920/511 and
`scRegion`, which stays exact over the 256 m window because the lab sets `scRegion` to the window corner that plays
the region origin's role (x min, glTF z max: `(x0, 0, z0 + 256)`) and the decode is linear past 192 m.]

### 8.2 Step order

```
step 0 (parallel):  GL-0 (seams)  |  GL-C (converter: palettes, perch points)  |  GL-A (art script, optional)
step 1 (after GL-0):  GL-S (shaders) → GL-F (field)  |  GL-L (life)  |  GL-T (terrain tint)
step 2:  GL-O (options, lab, sound hook)
step 3:  I-GL (integration), H-GL (hunt), fixes
```

### 8.3 Dependencies on the rest of the wave

- **Coast (item 2), gulls:** COAST B15 / §12.6 already defers to this spec: "Birds belong to docs/GRASS_LIFE.md's
  instanced bird system; the coast adds a gull species and its sea-side rules" [confirmed: COAST.md]. So GL-L exposes
  `life.addSpecies(def)` and `life.addHabitat(rule)` (a species' mesh colours and scale, flap numbers, and where it
  spawns and lands: for gulls, over water deeper than 8 m and loafing on the beach), and CST-A registers the gull
  through them (no second flock system). *(fact-check)* There is no `apps/game/src/world/fx/birds.ts` to adapt [confirmed:
  `ls apps/game/src/world/fx/`], and COAST's S-LIFE row now says "no coast flock code": CST-A only calls
  `addSpecies`/`addHabitat`, with its habitat reading `World.coast?.seaAt(x, z)` (CST-O) and the sea level for the 8 m
  depth [confirmed: COAST.md §8.13 S-LIFE, G8]. The gull shares the bird mesh and its one draw.
- **Coast (item 2), terrain:** the beaches are sand tiles (`asiaminor_sand_01/02`, Dirt-typed; `oaho_dust_earth01` as
  wet sand, Sand-typed [*fact-check*: COAST §7.1's tile table]; no grass or weed in any name), so they get grass weight 0
  [confirmed by the §3.2 rule against COAST §7.1's tile list]. COAST G7 now paints grass tiles on the lowered flanks up
  to 38°, and this spec's slope fade (`smoothstep(0.70, 0.80, normal.y)`, full grass to 36.9°, none past 45.6°) grows
  it there [confirmed: COAST G7]; the re-exported terrain (Blender sculpts, sea
  level +5 m) reaches the field through the normal region data, with no file overlap. Dragonflies use only the retail
  inland water planes, never the coast's ocean. The field bake reads water from the region blocks as today.
- **Draw calls (item 1, docs/BATCHING.md §3.6):** the ground cover is ≤ 3 main draws + ≤ 3 life draws, with no casters;
  it is not merged or batched by that part. *(fact-check)* BATCHING §3.6 fixes the contract: meshes tagged
  `metadata.sroWorld = 'scatter'` (grass) and `'life'` (animals), frozen world matrices, no per-frame allocation, grass
  and life ≤ 0.2 ms CPU together, a count-0 mesh hidden and never drawn at the origin. How to hide it: at
  `thinInstanceCount` 0 Babylon's `hasThinInstances` turns false and the mesh would draw once, un-instanced, with a
  different define set [confirmed: `mesh.pure.js` line 226]; the lab avoids that with `setEnabled(false)`, but every
  enabled flip dirties wave 9's `EnabledMeshCandidates` (a rebuild over ≈ 3,700 meshes, `render/active-meshes.ts`)
  [confirmed: code read]. So GL-F keeps the meshes enabled, sets `isVisible = false` at count 0 and never lets the
  buffer's count reach 0 while visible [likely: `isVisible` does not fire the enabled-state observable].
  Item 1's batcher places static objects from `manifest.placements`, so §1.3's hidden tuft models must be filtered
  **before** the batcher claims a region: GL-0 exports the model-name list and the option, BT-0 (owner of `objects.ts`
  and the claim) applies it [decision; needs BATCHING's agreement at integration].
- **Jump (item 3, MOVEMENT):** the player push reads the local player's position. *(fact-check)* The jump is cosmetic:
  "the entity root stays on the ground" and only the clip's Bip01 rises (MOVEMENT §4.2 table) [confirmed], so the push
  has nothing to fade: the grass simply stays parted under a jumping player for the 0.43 s in the air. No special case
  [decision].
- **Character screens (item 4, SCREENS §0B.3, §0B.10, open question 6):** the stage asks for a function it can call with
  a `World` and a focus. It gets one: the life is a **world-render part** (`World.life`, GL-0), not a world-screen
  feature, and follows `World.setFocus` or an explicit `life.setFocus(x, z)` [decision]. On the stage: butterflies over
  the flower beds 16–40 m east and west of the spot, no ground flocks (nothing walks into them), perchers allowed; the
  grass draws wherever the scatter draws, so the beds get it with no change (as SCREENS already expects).
  *(fact-check)* SCREENS §0B.3, §0B.10 and its open question 6 flag two gaps [confirmed: SCREENS.md]: (1) no GL-0 API
  turns ground flocks off: GL-0 now adds `World.life.configure({ groundFlocks: boolean })` (default true; SCR-R calls it
  with false), so SCREENS' `[unknown]` resolves; (2) the beds are **placed** `group_grs01`/`flw_g01_*` models, and the
  terrain under them may be paving, so the field may grow nothing and the meadow mask give no butterfly anchors there
  [likely]: GL-L's second anchor source (placed flower models, §5.2) covers it. §1.3's hiding of the low tuft models
  must not empty the stage's beds: the stage keeps `group_grs01` (SCR-R passes `hideRetailTufts: false`) unless the
  user prefers the new grass there.
- **Trees (deferred):** grass under tree crowns uses the CSM tap (High) and the baked-light channel; nothing depends on
  the new tree models.
- **Shared files:** `scatter.ts` (GL-0 then GL-F), `world.ts` (GL-0 first, then BATCHING's BT-0 rebases [confirmed:
  BATCHING §3.14]), `index.ts` (GL-0), `shaders.ts` (GL-T adds one entry to `WORLD_SHADER_CHUNKS`),
  `pbr/terrain-plugin.ts` (RND-T's file: GL-T adds one call under a define), `apps/game/src/settings.ts` +
  `hud/options.ts` (GL-O; the other wave parts add rows too, so GL-O rebases last; both files are being edited by the
  release right now [confirmed: `git status`]). *(fact-check)* Also: `packages/convert/src/world/manifest.ts` (the
  optional `tiles[].grass` type) and `convert-world.ts` (one call), shared with COAST's CST-C and BATCHING's BT-C
  (BATCHING F13), so GL-C rebases after both; and `apps/game/src/screens/world.ts` (one `setThreats` call, GL-O),
  shared with MOVEMENT's client lane.

### 8.4 Lane table

| Lane | Owns (files) | Seams it uses or adds | Tests | User check |
|---|---|---|---|---|
| **GL-0** seams (one agent, first) | `scatter.ts` (`ScatterStyle = 'retail' \| 'field'`, a `GroundCover` interface the retail chunks and the field implement, `adopt(material)`, `ScatterOptions.style`); `world.ts` (`World.life: LifePart \| null` updated after the scatter, disposed; `LoadWorldOptions.grassStyle`, `QualitySettings.wildlife`; `QUALITY_PRESETS` low keeps `'retail'`); `grass/types.ts`, `life/types.ts` (interfaces, incl. *fact-check* `LifePart.configure({ groundFlocks })` for SCREENS and `setThreats(fn)`); *(fact-check)* the retail-tuft model list of §1.3 (`RETAIL_TUFT_MODELS`) and the `LoadWorldOptions.hideRetailTufts` option (the skip itself goes into `objects.ts` before `placeStatic` and into the batcher's claim, both BATCHING BT-0's files: BT-0 applies it, GL-0 does not edit `objects.ts`); the mesh tags `'scatter'` / `'life'` (BATCHING §3.6); `index.ts` exports | adds the style switch, `adopt`, the life slot, the tuft filter | `grass-seams.test.ts`: style `'retail'` = HEAD behaviour (chunk meshes, materials, draws); `adopt` binds existing shared uniforms and later `set`s, defines and depth textures; Low never creates the field; *(fact-check)* Low and `hideRetailTufts: false` place every §1.3 model as today; `seams-classic.test.ts` unchanged (the Low guard) | nothing visible |
| **GL-S** shaders | `grass/shaders.ts` (the skeleton of §3.7, WGSL + GLSL, from `ChunkSet.of(WORLD_SHADER_CHUNKS, 'grass')`; the blade/flower body; the height and field fetches); `life/shaders.ts` (butterfly/dragonfly, bird, firefly bodies on the same skeleton) | the chunk points only | `grass-shaders.test.ts`: both languages have the same uniforms, samplers and chunk insertions as `scatterShaders()` (a diff of the key lists); `wgslInterStageCount` of the grass material ≤ the retail grass's and of each life material ≤ the retail grass's + 1 (measured 7 / 8 / 9 and 8 / 9 / 10 for Medium / High / rain), all ≤ 15 user varyings; the triangulation height in TS (`grassHeightAt`) equals `format.ts terrainHeightAt` on fixtures; NullEngine `isReady` for every define combination (SRO_HDR, SRO_GRASS_CSM, WX_*, SRO_NIGHT_GRASS, SRO_CLOUDSHADOW); *(fact-check)* the pixel-width floor of §3.4 (a TS twin: no blade narrower than ≈ 1 px at its mid-height at any tier distance, 1080p and scale 0.75) | no glslang fetched on WebGPU (network log); *(fact-check)* walk through the fields on Medium: no crawling blades |
| **GL-F** field | `grass/{field.ts, window.ts, bake.ts, patch.ts, cull.ts, index.ts}` | GL-0 style + `adopt`; `stream.addCommitStep('grass', …, 'objects')` (*fact-check*: was `'terrain'`; the step only enqueues, GL-F bakes in its own ≤ 1 ms slices, §3.1); `nav.locate` for object floors | `grass-bake.test.ts` (layer composite = TERRAIN §2.3 order on fixtures; slope, water and object-floor zeros; the grassy-dirt 0.45; deterministic; *fact-check*: no slice over its time budget, the commit step itself ≤ 0.2 ms); `grass-window.test.ts` (re-centre at 32 m; row copies equal a full bake; regions arriving late fill in); `grass-cull.test.ts` (tiers by cell distance per preset; frustum AABB; empty cells skipped; ≤ 3 meshes, each **hidden with `isVisible`** at count 0 (never `setEnabled`, so `EnabledMeshCandidates.rebuilds` stays unchanged while walking) and never drawn at count 0); `grass-patch.test.ts` (vertex and triangle counts per tier = §3.3; tier membership; the 8 variants are a permutation) | Options → Grass → Retail / New A/B at the lab spots; no gaps; soft road edges |
| **GL-T** terrain tint | `grass/chunks.ts` (a terrain chunk at `postLight`, define `SRO_GRASS_TINT`; *fact-check*: it reads a per-tile uniform table (grass weight, palette mid colour) indexed by the layer tile ids the terrain already fetches, **not** the field window, so it adds no sampler); one entry in `shaders.ts` `WORLD_SHADER_CHUNKS`; one call in `pbr/terrain-plugin.ts` under the define (RND-T's file) | the terrain chunk point; the PBR terrain plugin | `grass-chunks.test.ts`: the define off = today's terrain strings (Low guard); on: both languages; the PBR texture-unit count **unchanged** by the define on WebGL2 (D32, extending `terrain-plugin.test.ts`'s ≤ 16 check) | the top view: the carpet's far edge no longer shows |
| **GL-C** converter | `packages/convert/src/world/grass.ts` (per tile: grass weight and the base/tip palette from the tile image's deciles → an optional `tiles[].grass` in the manifest); `packages/convert/src/world/perches.ts` (roof ridge points per region from building models → `perches.json`; *fact-check*: only if the run-time bounds perches of §5.3 fail, and then `perches.json` must be added to the deploy asset list); one call in `convert-world.ts` and the `tiles[].grass` type in `manifest.ts` (shared with CST-C and BT-C, GL-C rebases after both) | additive manifest fields (old exports: the runtime falls back to built-in palettes) | `grass-palette.test.ts` (deciles on fixture tiles; bare names = weight 0); `perches.test.ts` (points lie on the roof within 0.2 m on fixtures; none on walls or trees) | — |
| **GL-L** life | `life/{life.ts, butterflies.ts, flock.ts, birds.ts, fireflies.ts, spawn.ts, index.ts}` | GL-0 life slot + `adopt`; adds `addSpecies`/`addHabitat` (the coast's gull, §8.3); `SkyState.night`; the weather frame; entity positions from the app (a `LifeHost.threats()` callback); the field's density/meadow/height queries | `life-gate.test.ts` (§5.1's table: counts by night, rain, wind with the audio's hysteresis); `flock.test.ts` (circle → land → ground → flush → circle; a threat at 9 m starts the first bird within 0.25 s and has every bird airborne within 0.6 s (*fact-check*: the delays of §5.3 give 0.18–0.53 s, so "within 0.4 s" would fail); birds never below the ground; no allocation per update); `butterfly.test.ts` (the TS twin of the flight path stays within the wander radius, above ground; anchors from placed flower models as well as the meadow mask); `configure({ groundFlocks: false })` spawns no ground flock; perches from manifest bounds lie within 0.5 m of the model's top; a NullEngine test that each kind is one mesh and one draw | butterflies over flowers (and over the stage's beds); a flock lands, flushes when walked into; fireflies at night; nothing in rain |
| **GL-A** art (optional) | `packages/convert/src/grass/make-atlas.py` (Pillow, deterministic) → `content/grass/petals.png` (512²) | — | the script's output hash is stable | the petal sheet |
| **GL-O** options, lab, sound | `apps/game/src/settings.ts` (the `graphics.scatter` row keeps its values and becomes "Grass"; a new `graphics.wildlife` On/Off; defaults per preset; Macs *and integrated GPUs* (`isAppleGpu`, the `'integrated'` recommendation) start at Grass: Low until the M1 check, where Grass: Low = full density, distances × 0.6 (§7.1)); `hud/options.ts`; the English strings; `apps/game/src/audio/ambient.ts` (a flush plays a bird one-shot at the flock); *(fact-check)* `apps/game/src/screens/world.ts` (one `world.life?.setThreats(…)` call with the known actors; shared with MOVEMENT's client lane); `apps/viewer/src/world/grass-panel.ts` (style A/B, retail tufts on/off, tier colouring, counters) | GL-F stats; `life.onFlush` | `settings.test.ts` (defaults; Low stays retail; old saves keep their level; Mac and integrated defaults); `audio.test.ts` (one one-shot per flush, muted in rain as today) | Options → Grass / Wildlife |
| **I-GL** integration | merge order GL-0 → GL-S → GL-F → GL-T → GL-C data → GL-L → GL-O | — | full `pnpm vitest run` and `pnpm typecheck`; the §7 bench with `prof.js` (the fields at noon, the fields in a storm, the fields at night, the plaza) on WebGPU High and Medium and WebGL2 Medium, GPU lock held, minimum of 5 runs | before/after shots at the lab spots, dry and in rain, day and night |
| **H-GL** hunt lenses | — | — | (1) retail grass still drawn under the new (a double draw); (2) grass on paving, roads, object floors or under water; (3) grass through house floors and the plaza; (4) the window re-centre hitch (> 2 ms); (5) 16-varying adapters (force `maxInterStageShaderVariables = 16`); (6) Low changed; (7) glslang fetched on WebGPU; (8) floating or sunken blades at region seams and cliffs; (9) wildlife in rain or at night (butterflies), fireflies by day; (10) birds inside walls or flushing with no threat; (11) the draw count above 3 + 3; (12) a mesh drawn at the origin at count 0; (13) GC: allocation per frame in the cull or the flock; *(fact-check)* (14) shimmer: walk the fields on Medium (FXAA) and on High with the camera moving, at scale 1 and 0.75; (15) placed retail tufts standing in the new carpet (§1.3) or the stage's beds emptied; (16) a region-commit hitch: no frame over the streamer's budget + 1 ms when a grassy region commits; (17) `EnabledMeshCandidates.rebuilds` climbing while walking the grass edge | — |

---

## 9. Scope-cut order (cut from the top)

*(fact-check: re-ordered. The user named "fireflies & dragonflies" and "flowers & small plants" in their answers, so
dragonflies no longer go first and one small plant (clover) survives; the terrain tint moved down because Grass: Low,
the Mac and iGPU default, ends its carpet at 35 m and needs it.)*

1. Fly-overs (swallows, egrets); keep the ground flocks and perchers.
2. Roof perchers and the perch points (GL-C part 2); keep the ground flocks.
3. The petal/leaf atlas (keep the vertex-colour star heads).
4. Reeds, cattails and ferns (keep grass, wildflowers and clover).
5. Other actors pushing the grass (keep the local player).
6. The flush sound.
7. Ultra's longer far tier.
8. Dragonflies (§5.5): a kind the user named, so cut only after telling the user.
9. The terrain tint (GL-T): keep the far-tier distances, raise High's far tier to 90 m, and accept a visible edge on
   Grass: Low (tell the user).
10. Fireflies (a kind the user named, and the night's only life).

**Never cut:**

- the splat-weight coverage with soft road edges (the user's "no gaps");
- the GPU-procedural patches with **≤ 3 grass draws** in any view, and no grass shadow casters;
- the chunk-graph contract (weather, night, sky and RND-W chunks unchanged);
- Low unchanged (the Low guard);
- the varying count of the retail grass (the grass material), + 1 at most for the wildlife;
- butterflies and one bird behaviour (ground flocks that flush);
- the Options rows (Grass level, Wildlife on/off);
- *(fact-check)* full blade density on every level that draws the new grass (distance is what Grass: Low cuts);
- *(fact-check)* the §1.3 decision on the placed retail tufts (whatever the user picks in Q12).

---

## 10. Risks

| Risk | Default handling |
|---|---|
| Vertex cost on Apple Silicon (M1 at Medium), integrated GPUs and older mid GPUs | Medium's numbers are the budget (§7); the Options "Grass: Low" level (*fact-check*: full density, distances × 0.6, the Mac and iGPU default); GL-O measures on a friend's M1 before release (§11) |
| *(fact-check)* Thin blades shimmer while walking (FXAA on Medium, TAA off during camera moves on High, scale 0.75 on Macs) | the pixel-width floor (§3.4); H-GL lens 14; the user walks the field in the A/B |
| *(fact-check)* A region bake inside one streamer job hitches for 15–25 ms | the commit step only enqueues; GL-F's ≤ 1 ms slices (§3.1); H-GL lens 16 |
| *(fact-check)* Placed retail tufts (§1.3) keep the look the user dislikes | the tuft filter on Medium+ (Q12), applied by BT-0 before batching; the stage keeps its beds |
| *(fact-check)* GL-T overflows WebGL2 High's 16 texture units (D32) | the tint reads a per-tile uniform table, no new sampler; the D32 test extended |
| The far edge of the carpet shows from high cameras (`look_high_top.png`) | the terrain tint (GL-T); far tier to 82 m on High; the far colour pulled to the terrain palette |
| Grass pokes through object floors or grows into walls | the object-floor rule of today (`nav.locate`), baked per texel; H-GL lens 3 |
| The field window re-centre causes a hitch | rows copied from per-region bakes (≤ 0.5 ms); per-region bakes time-sliced (≤ 1 ms per frame) |
| A 16-varying adapter black-frames the grass | the new grass keeps the retail grass's varying count (vCol replaces vUV), the butterflies add one (≤ 10 in rain on High); tests with `wgslInterStageCount`; H-GL lens 5 runs with the limit forced to 16 |
| Butterflies too small or too big | a scale factor in content (default 2.2×); the user checks it |
| Birds flush when nobody is near, or never | threats from entity positions; the lab's flush sequence as a unit test of the state machine |
| Birds fly through walls and trees | fly-overs at 12–25 m above ground; landing spots only on open grass or perch points; the flush climbs first |
| The painterly palette drifts from the remastered terrain (9B) | the palette is derived from the tile image the client actually uses, at build time (GL-C) |
| Headless CPU noise hides small costs | minimum of 3 runs; the in-game `prof.js` bench at integration |
| Life looks busy or gamey | modest counts; everything off in rain; one Options row to turn wildlife off |

---

## 11. What the user must provide or approve (each has a default)

1. **The look.** Judge `work/tmp/grass-life/overview.png` (retail vs new, side by side; close-up; rain; night). Notes such
   as "greener", "taller", "fewer flowers" are palette and parameter changes. **Default:** proceed with the prototype's
   look.
2. **Low keeps the retail grass** (the N100-class Low preset and the Low guard). **Default: yes.** Nobody among the friends
   is on Low today.
3. **Butterfly size** (drawn at 2.2× life size so they read at game distance). **Default: 2.2×.**
4. **Wildlife counts** (§5.1). **Default:** the table's numbers; one Options row "Wildlife: On / Off".
5. **Art source:** geometry and vertex colours, plus an optional petal atlas painted by a local script. **Default:** no
   SDXL run, no downloads, no Meshy. If the user wants hand-painted petals, the SDXL pipeline runs under the GPU lock
   through `work/tools/comfyui/start_comfyui.sh` in a reviewed batch.
6. **A friend's Apple Silicon Mac for one check** (Medium, the fields at noon, the perf overlay). **Default:** GL-O asks
   before release; without it, Macs (and integrated GPUs) start with Grass: Low, which is the full density over a
   shorter reach, so no gaps near the player.
7. **Bird species** (sparrows, magpies/crows, swallows, egrets). **Default:** those four; the user can ask for others
   (cranes, pheasants).
8. *(fact-check)* **The placed retail grass models** (§1.3: 3,531 placements; 695 of them low tufts). **Default:** hide
   the 695 low tufts on Medium+ where the new grass draws, keep the tall weeds, reeds, barley, flowers and water plants,
   keep everything on Low and on the character stage; the user judges it in the viewer's A/B (Q12).

## 12. Open questions (each has a default, so nobody waits)

| # | Question | Default |
|---|---|---|
| Q1 | Blade density and distances per preset | §3.3's table; GL-O tunes them in the lab against §7's budgets |
| Q2 | Does "Grass: Low" (*fact-check*: new grass at full density, distances × 0.6; was "0.6 density, 0.75 distance", which reopened the gaps) replace today's "low" scatter level on Medium+? | yes; the level names stay Off / Low / Medium / High, "auto" follows the preset (and the Mac / iGPU default); on the Low preset "low" still means the retail scatter's low level |
| Q3 | Object-floor mask at runtime (`nav.locate` per texel, in GL-F's own time slices after the `'objects'` commit) or pre-baked by the converter | runtime first (no new files, the coast re-export needs nothing); the converter bake if GL-F measures a region's slices above 25 ms in total |
| Q4 | The baked-light channel (A): copy the region lightmaps into the window on the GPU, or skip | copy (one render pass per re-centre, ≤ 9 quads); skip on Medium if the pass costs > 0.3 ms |
| Q5 | Do other players' and mobs' positions push the grass? | local player only in v1 (cut 5) |
| Q6 | Does the camera-facing share (55 %) look odd when the camera orbits fast? | keep; lower to 35 % if the user sees "turning" grass |
| Q7 | WebGPU compute culling per blade | not in this wave; an Ultra experiment once render bundles or indirect draws are supported without private API |
| Q8 | Dune grass on the beaches' landward edge | not in v1; a palette entry for the coast's sand-to-grass blend if the user asks |
| Q9 | Should birds perch in trees? | not in v1 (tree crowns change with the deferred new tree models) |
| Q10 | Should wildlife spawn inside Jangan's walls? | butterflies on garden grass yes; birds: perchers on roofs yes, ground flocks outside the walls only |
| Q11 | Seeds shared between clients so friends see the same birds | no (cosmetic, no server state); seeded by region and game hour so a spot is stable for one client |
| Q12 | *(fact-check)* Which placed retail grass models (§1.3) stay on Medium+? | hide the low tufts (`group_grs*`, `grass_single03`, `grs_weed01/02/07`: 695 placements) where the new grass draws; keep the rest; keep all on Low and on the character stage; the user decides after the A/B |
| Q13 | *(fact-check)* Should iGPUs share the Macs' Grass: Low default? | yes (§7.1's iGPU column projects ≈ 1.0–1.8 ms at Medium) [projected]; lifted per device once measured |

---

## Appendix: fact-check (2026-09-29)

An adversarial pass re-derived every [confirmed] claim from the code, the data, Babylon 9.28 and the lab's JSONs, and
re-ran one measurement (WebGL2 High, with and without the life: GPU lock `grass-life-factcheck` held 23:25–23:31, the
lab's private Vite on :5243 and one headless Chrome on :9353 with a scratch profile, all stopped and deleted
afterwards; `shots/fcheck_webgl_high_v1_*.json`). Corrections are made in place and marked *(fact-check)*.

**Corrected**

| # | Was | Now |
|---|---|---|
| X1 | The bake runs as a `'terrain'` commit step "in row slices of ≤ 1 ms" | The streamer never splits a job (`stream.ts`) and the floor mask needs objects: an `'objects'` step that only enqueues, GL-F slices its own queue (§3.1, GL-F, lens 16) |
| X2 | "No grass at the plaza" (§7.2) | The plaza draws 35 (High) / 20 (Medium) retail scatter chunks (BATCHING §3.6): the new grass lowers the plaza's count |
| X3 | Grass: Low = 0.6 density | 27 blades/m² is at the lab's own "25/m² still showed ground": Grass: Low keeps full density and cuts distance × 0.6 (§7.1, Q2) |
| X4 | Only "the retail bush objects stay" | 3,531 placed retail grass/weed/flower objects (27 models) in the playable area; default hides the 695 low tufts on Medium+ (§1.3, Q12) |
| X5 | GL-S budget ≤ +0.3 ms vs retail at High ground level | The prototype is at +0.36 (median) / +0.63 ms (min-vs-min); the budget is ≤ +0.7 ms and the GPU noise floor (±0.15 ms) is stated (§6.3, §7.2) |
| X6 | GL-T reads the field window in the terrain shader | D32 leaves no WebGL2 unit to spare on High: the tint uses a per-tile uniform table (GL-T, risks) |
| X7 | Count-0 meshes "disabled" | `setEnabled` flips rebuild `EnabledMeshCandidates`; use `isVisible` (§8.3, GL-F, lens 17) |
| X8 | Jump: "above 0.5 m the push fades out" | The jump is cosmetic, the entity root stays on the ground (MOVEMENT §4.2): nothing to fade (§8.3) |
| X9 | CST-A's `apps/game/src/world/fx/birds.ts` becomes an adapter | The file does not exist and COAST now has no flock code; CST-A calls `addSpecies`/`addHabitat` with `World.coast?.seaAt` (§8.3) |
| X10 | `oaho_dust_earth01` Dirt-typed | Sand-typed (COAST §7.1); weight 0 either way |
| X11 | Butterfly 12 triangles; flower head 11 triangles | 6 triangles (12 vertices); head 10 + stem 1 (§4.1, §5.2) |
| X12 | Flock "flushes within 0.4 s" at 9 m | The §5.3 delays give 0.18–0.53 s; the test asks first bird ≤ 0.25 s, all ≤ 0.6 s (GL-L) |
| X13 | Patch meshes 1.3 MB at High | ≈ 1.5 MB Medium, ≈ 2.3–2.5 MB High (44 B per vertex) |
| X14 | Instance record 16 B per cell | The lab used a 64 B matrix per cell; 16 B stays the target |
| X15 | "Draws (main)" | The lab counts all passes of `scene.render` |
| X16 | Bake 26–62 ms; floor test 5–7 ms | 23–62 ms over 51 runs (median ≈ 35, includes the patch meshes); the A/B pair gives ≈ 5 ms for the test |
| X17 | The stage needs nothing (§8.3) | SCREENS asks for a ground-flock switch (`life.configure`), and its beds are placed models on likely paving: butterfly anchors from placed flowers; the stage keeps its `group_grs01` |
| X18 | Budgets had no iGPU column | Added in the WAVE_PLAN3 §5.2 format; iGPUs share the Grass: Low default (Q13) |
| X19 | Scope cut: dragonflies first | Dragonflies and fireflies are user-named: cut late and only after telling the user; clover survives cut 4; GL-T moved below Ultra's far tier |
| X20 | Missing seams | `manifest.ts`/`convert-world.ts` (with CST-C, BT-C), `screens/world.ts` (`setThreats`, with MOVEMENT), BATCHING's mesh tags and its `objects.ts` for the tuft filter; perches from manifest bounds by default (no new deployed file) |
| X21 | Look judged on stills | Shimmer risk on FXAA / moving-camera TAA / scale 0.75: a pixel-width floor, lens 14, a user walk-through (§3.4) |
| X22 | WebGL2 High: life +0.4–0.8 ms CPU hidden in the medians | Re-run: ≈ 0–0.1 ms; the original gap was run-to-run noise (§6.3) |

**Re-confirmed** (by the check named): the coverage numbers (`coverage.py` logic against `scatter.ts`: 1 m grid,
any-bare-corner rule, `FRINGE_MIN` 0.2, slope 0.72, fractions 0.35 / 0.6 / 1, the `TILE_TYPE_DENSITY` table,
`BARE_NAME`, the layer byte layout of `format.ts`); `terrainHeightAt`'s split and the lab shader's twin of it (row
order and the 16-bit RG decode checked); `NIGHT_GRASS_WINDOW` 256 / `NIGHT_GRASS_RECENTER_M` 32; the night chunk's
`vLm`/`scRegion` decode over a 256 m window; the audio's bird thresholds (0.25 / 10 m/s on, 0.2 / 9 off,
`audio/weather.ts`); Babylon 9.28 `WebGPUDrawContext.setIndirectData` rewriting the instance count from the CPU;
`addCommitStep`, `nav.locate`, `wgslInterStageCount`, `ChunkSet.of`, `GrassPoint`, `WORLD_SHADER_CHUNKS`,
`SkyState.night`, `sroWind`, `sroShelter`; the §3.3 vertex and triangle counts (arithmetic from clumps × blades ×
rows plus flowers) and the submitted totals of §6.3 (8 × 21,252 + 16 × 8,184 + 30 × 1,452 = 344,520); the draws,
CPU and GPU medians of §6.3 against the 60 per-run JSONs; the inter-stage counts 7 / 8 (grass), 8 / 9 (butterflies),
7 / 8 (birds); the lab's tier distances and widths; Tidewater's 42 blades/m² arithmetic; the palette deciles (re-run);
Medium = FXAA, High = TAA (`render/quality.ts`); COAST B15 / G7 / G8 / S-LIFE; SCREENS §0B.3 / §0B.10 / Q6; nothing in
the design needs a download or an upload (procedural geometry; the optional atlas is a local Pillow script; Tidewater
was read as public pages).
