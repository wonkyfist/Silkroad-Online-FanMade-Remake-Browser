# Wave plan 4: wave 10, "sky and sea" + new trees

This plan merges three fact-checked specs into one build order:

- **docs/SKY2.md**: volumetric clouds and cloud shadows, sky-coloured haze with sun shafts, a GPU time-sliced IBL,
  auto exposure, ground bounce, GTAO and contact shadows (Tidewater-style, adapted to Babylon 9.28);
- **docs/COAST.md** (refreshed 2026-09-29): the coast (Option A land bridge to Donwhang, Jangan Bay at +5 m, the
  walkable south beach), the FFT ocean with shore foam, and the Blender round trip for hand sculpts;
- **docs/TREES.md**: new 3D tree models (the only new models this wave), their LODs, impostors, wind data and the
  global tree field.

The user's order, pasted: *"Sky and sea, as one wave. Sky: the Tidewater-style upgrade with 3D volumetric clouds and
cloud shadows, sky-coloured distance haze with sun rays, auto exposure, and better ambient light. Coast: your design is
ready (land bridge to Donwhang, Jangan Bay, walkable south beach). It includes the realistic wave simulation, shore
foam, and the Blender round trip for hand-sculpting. They share the same code (sky, haze, water), so building them
together avoids doing it twice."* And: *"as well as New 3D models for TREE'S only for time being."* The second half of
the order ("Gameplay and screens": jump and dodge roll, the intro, login and character scenes, pets, friends and mail)
is wave 11 and gets its own plan (docs/WAVE_PLAN5.md, from MOVEMENT.md, SCREENS.md and PETS_SOCIAL.md). Nothing here
waits for it.

It does what WAVE_PLAN3 did for wave 9:

- it settles every place where the three specs disagree, name one thing twice, or leave a file or a piece of state
  with two owners (§2);
- it confirms there is no protocol change (§3);
- it lands **every cross-lane hook first** in one seam step (§4), so the lanes own disjoint files;
- it merges the preset rows and holds the sum of the three budgets against the measured wave-9 numbers, with the
  60 fps rule as hard gates (§5);
- it orders the lanes, the integration and one hunt (§6), and gives one scope-cut order (§7) and one list of what
  the user provides or approves (§8).

When this plan and a spec disagree, **this plan wins**. The specs stay the detailed design of each lane; a lane reads
its spec sections and this plan's row for it.

**Tags.**

- **[confirmed]**: checked in the code or the data of the working tree on 2026-09-29, in `@babylonjs/core` 9.28, or
  measured by a spec's prototype and re-checked by its fact-check. Each one says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived), not measured on that setup.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this plan makes. The user may overrule it.

**Repo state when this was written [confirmed: `git status`, `git log`].**

- HEAD `85e2e14` ("Backlog: user-confirmed order: wave 10 sky + sea + new 3D trees, wave 11 gameplay and screens").
  The wave-9 **release workflow is editing the tree right now** (`apps/game/src/settings.ts`, `rollout.ts`,
  `three/*`, `packages/world-render/src/pbr/maps.ts`, `deploy/config.sh` and their tests are modified). Line numbers
  drift: **every hook below is found by its quoted code, not its line number**.
- The released state: `RENDER_ROLLOUT = 'on'`, first run **Medium on every adapter class** (render scale 0.75 on an
  integrated GPU and on a Retina Mac), WebGL1 → Low, a 16-varying adapter capped at Medium (`hasFewVaryings`), High
  and Ultra optional [confirmed: `settings.ts` `recommendGraphics`, `w9-user-decisions.md` "wave-9 release
  decisions"]. **Every friend is on WebGL2** until the Tailscale HTTPS step in DEPLOY.md is done [confirmed:
  DEPLOY.md "HTTPS via Tailscale"].
- Existing seams this plan reuses [confirmed: grep of the working tree]: `sroCloudShadow` in `sky/chunks.ts` (called
  by the terrain and surface plugins and the grass, **not** by `pbr/foliage-plugin.ts` or `pbr/water-plugin.ts`);
  `SroFogPlugin` registered globally (`pbr/fog-plugin.ts`, exports `HEIGHT_FOG_WGSL/GLSL`, `attachFogPlugin`,
  `heightFogOf`); `POST_STAGE_ORDER = ['fsr', 'ssao', 'ssr', 'taa', 'default', 'vls']` (`render/post.ts`);
  `WORLD_SHADER_CHUNKS = [SKY_CHUNKS, WEATHER_CHUNKS, NIGHT_CHUNKS, RENDER_GRASS_CHUNKS]` (`shaders.ts`, "no lane edits
  this file"); `WaterRenderer.pbrState` public with a private `ensurePbr()` (`water.ts`); `shelterCandidates()`
  (`weather/index.ts`); `RegionChunk.pendingObjects` and `host.acquireModel` (`region-chunk.ts`);
  `wgslInterStageCount` and `installVaryingBudgetCheck` (`render/gpu-guards.ts`); the D32 texture-unit tests
  (`test/terrain-plugin.test.ts`, `test/txr-terrain-d32.test.ts`); the Low guard (`test/seams-classic.test.ts`);
  `graphics.advanced.ao` (`auto | off | half | full`) and `lightShafts` (`auto | off | on`) in `settings.ts`.
- `THIRD_PARTY_NOTICES.md` does not exist [confirmed: `ls`, `git ls-files`].
- Scratch the lanes port from: `work/tmp/sky2/` (the cloud, froxel and haze-plugin prototype), `work/tmp/sky2-fc/`
  (the texture-unit count, the noise-size replica), `work/tmp/coast/` (`coast.py`, `proto_coast.py`, the Blender
  scripts, the previews), `work/tmp/coast-refresh/` (`fft-bench.ts`, the 5.2.2 round trip), `work/tmp/trees/` (the
  inventory, `make_tree.py`, `bake.py`, the lab, the A/B shots). This plan's own arithmetic is
  `work/tmp/plan4/budget.py`.

---

## 0. Summary

1. **One wave, three parts, one seam step.** Sky (SKY2), sea (COAST) and trees (TREES) share the haze, the IBL, the
   cloud shadows, the horizon, the wind, the key light and the budgets. So one foundation agent, **W10-S**, lands every
   shared hook of all three specs first (§4). After it, the part lanes own disjoint files. The data lanes (the
   cloud-noise export, the converter coast pass, the tree tool) start at once beside W10-S.
2. **One owner per shared thing** (§2.2):
   - **haze and fog, and the horizon**: S2-H (it takes `pbr/fog-plugin.ts` for this wave);
   - **IBL**: S2-I;
   - **cloud shadows on land, sea and trees**: S2-V (the body of `sroCloudShadow`, the map, the key-light dimming);
   - **wind**: nobody new. `WeatherFrame` stays the one source, and vegetation keeps the one sway function;
   - **the preset table**: W10-S writes every wave-10 row; afterwards only the integration edits it.
3. **The haze lives in the material, never in a depth-reading post pass** (D17). So the transparent sea and the tree
   impostors get the sky-coloured haze and the sun shafts at their own depth, and no depth pass is added. This answers
   COAST's open S-HAZE question.
4. **No protocol change** (§3). No message, validator, GM command, server config key or database migration. The coast
   changes the exported world (data) and needs a server restart with a "reload the page" note; the trees and the sky
   are client-only.
5. **The 60 fps rule is four gates** (§5.4, D37):
   - **G1:** Medium, the default, holds p95 < 16.7 ms on both backends at all seven bench scenes with everything on.
     It projects to ≤ 14.5 ms at its worst (the WebGPU crowd) [projected].
   - **G2:** every High/Ultra scene that passes today still passes. The beach inherits the gate-storm scene's pass.
   - **G3:** the scenes where WebGPU High already fails (plaza 17.9, crowd 21.5 ms p95) get no worse beyond the
     method's resolution (+0.1 ms on the median of 5 CPU p50 runs). The trees' projected saving should pay for the sky
     and the sea there.
   - **G4:** the component gates of each spec (tree draws and casters ≤ retail, no new varying, ≤ 16 WebGL2 texture
     units, no GLSL on WebGPU, the Low guard, the horizon seam).
   A feature that breaks a gate on a preset ships **off** on that preset, or is cut.
6. **Who sees what.** Medium players (everyone by default) get: the sky-coloured haze, the GPU IBL, auto exposure,
   the ground bounce, the Medium ocean (worker FFT, shore foam, swash), the new trees. The volumetric clouds, their
   shadows, the froxel shafts and the GPU FFT ocean are **WebGPU High+**, so no friend sees them until HTTPS is set
   up and they pick High (§8 item 1).
7. **Honest risks.** High on WebGPU is CPU-bound and still misses 60 fps in busy spots; this wave does not fix that
   (BACKLOG item 9). The trees' CPU saving is projected, not shown (TREES F7). A base M1 on Medium at the beach
   projects to 12–17 ms of GPU, at the line (§5.2).
8. **Never cut** (§7): the Low guard, no protocol change, the sky-coloured haze with the horizon seam test, the GPU IBL,
   "no new scene draws" for the sky, the 2.5D clouds as the fallback, the sea mask and the frozen playable area, the
   Blender round trip with validation, the one-varying rule, the tree swap keyed by the retail model with the "draws ≤
   retail" gate, `THIRD_PARTY_NOTICES.md`, and G1.

### 0.1 Where each user request lands

| User request (verbatim fragment) | Where | Lanes |
|---|---|---|
| "3D volumetric clouds" | SKY2 §4, High (WebGPU) and Ultra; 2.5D stays on Medium | S2-C, S2-V |
| "and cloud shadows" | SKY2 §4.8, one map behind `sroCloudShadow` for terrain, grass, sea (High) and objects, trees (Ultra) | S2-V (D20) |
| "sky-coloured distance haze with sun rays" | SKY2 §5: haze on every PBR preset; shafts from froxels on High+ WebGPU | S2-H (D17, D18) |
| "auto exposure" | SKY2 §7, ±0.5 EV Medium, ±1 EV High/Ultra | S2-E |
| "better ambient light" | SKY2 §6 (GPU IBL), §8 (ground bounce, GTAO, contact shadows) | S2-I, S2-A |
| "land bridge to Donwhang, Jangan Bay, walkable south beach" | COAST §3–§5, §9: Option A, +5 m, S1 | CST-C, CST-M |
| "the realistic wave simulation" | COAST §8.2–§8.7: worker FFT (Medium, WebGL2), GPU FFT (High/Ultra WebGPU), Gerstner (Low) | CST-O |
| "shore foam" | COAST §8.8, shore v1 (foam band, lace, swash, wet sand) | CST-S |
| "the Blender round trip for hand-sculpting" | COAST §6 | CST-B |
| "They share the same code (sky, haze, water)" | §2.2 of this plan: one owner each, one seam step | W10-S |
| "New 3D models for TREE'S only for time being" | TREES: route (d), 5 family batches; **no other new models** (D30) | TR-A, TR-F, TR-I, TR-W, TR-B |
| Standing goal "at least 60 fps" (BACKLOG) | §5.4 gates G1–G4 | LAB-10, I-10 |

---

## 1. Lane ids

| Id | Step | From spec | What |
|---|---|---|---|
| **W10-S** | 0 | SKY2 S2-S + TREES TR-0 + COAST I-CST's hooks (moved forward) | Every client seam of the wave (§4), the preset rows, the settings fields, the two material-budget guards, `THIRD_PARTY_NOTICES.md` |
| S2-C | 0 | SKY2 | Cloud-noise volumes from the sky exporter |
| CST-C | 0 (phase 1), 1 (phase 2) | COAST | The converter coast pass, `content/coast/coast.json` |
| CST-B | 0, after CST-C's schema and TR-A's Blender helper | COAST | The Blender round trip (`coast-export`, `coast-import`) |
| CST-M | 0 (converter), 1 (client) | COAST | Minimap and world map |
| TR-A | 0 | TREES | The tree tool (Blender make + bake), the maple, the `blenderExe` key and the Blender helper |
| S2-V | 1 | SKY2 | Volumetric clouds, the cloud-shadow map, the key-light dimming |
| S2-H | 1 | SKY2 | Haze and shafts; owns `pbr/fog-plugin.ts` and the horizon |
| S2-I | 1 | SKY2 | The GPU IBL |
| S2-E | 1 | SKY2 | Auto exposure |
| S2-A | 1 | SKY2 | Ground bounce, GTAO, contact shadows |
| CST-O | 1 (spike first) | COAST | The ocean surface |
| CST-S | 1, after CST-O's shore-seam commit | COAST | Shore v1 and the terrain wet band |
| CST-A | 1 | COAST | Coast sound, birds, ships, critters |
| CST-T | 1 (GPU queue) | COAST | The B-coast texture batch (data) |
| TR-F | 1 | TREES | The tree field (swap, buckets, instances) |
| TR-I | 1 | TREES | The impostor material |
| TR-W | 1 | TREES | The wind vertex data branch; owns `pbr/foliage-plugin.ts` |
| TR-B | 1 (B-T1), 2 (the rest) | TREES | The family batches (data) |
| **GAME-10** | 2 | SKY2 S2-G + TREES TR-L (game part) | Options rows, the watchdog step, the perf overlay, the tree mode wiring |
| **LAB-10** | 2 | SKY2 S2-L + TREES TR-L (viewer part) + COAST I-CST's LAB | One lab page, one bench list, the A/Bs, the sheets, the §5 table |
| **I-10** | 3 | I-S2 + I-CST + I10T | Integration, the re-converts, docs, deploy list |
| **H-10** | 3 | H-S2 + H-CST + H10T | One adversarial hunt (§6.5) |

Dropped ids: **S2-S** and **TR-0** (→ W10-S), **S2-G** (→ GAME-10), **S2-L** (→ LAB-10), **TR-L** (split into GAME-10
and LAB-10), **I-S2**, **I-CST**, **I10T** (→ I-10), **H-S2**, **H-CST**, **H10T** (→ H-10). COAST's later lanes
**CST-W, CST-F, CST-K** are not in wave 10 (they wait for the beach playtest, COAST §12.10).

---

## 2. Conflicts and gaps across the specs, with decisions

### 2.1 Architecture and file ownership

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| D1 | Who lands the shared hooks | SKY2 S2-S, TREES TR-0, COAST I-CST (at the end) | Three seam lanes on overlapping files (`world.ts`, `settings.ts`, `foliage-plugin.ts`, `quality.ts`); COAST put its hooks last, so its lanes could not test against them | **One seam agent, W10-S**, first (§4) [decision]. It writes every hook of the three specs, empty or off. After W10-S **no lane edits** `world.ts`, `shaders.ts`, `region-chunk.ts`, `stream.ts`, `objects.ts`, `render/post.ts`, `render/shadows.ts`, `render/quality.ts`, `render/gpu-guards.ts`, `sky/types.ts`, `sky/sky-shaders.ts` (S2-V and S2-H fill the dome through exported string constants in their own files), `pbr/terrain-plugin.ts`, `water.ts`, `weather/index.ts` or `index.ts` (W10-S exports every new module's entry file up front); only I-10 does. `apps/game/src/settings.ts` and `hud/options.ts` pass to GAME-10; `apps/viewer/src/world/main.ts` passes to LAB-10. |
| D2 | `world.ts` | SKY2 (`sky.dispatchGpu` after `sky.update`), TREES (`World.trees`, `setTreeMode`, `meshes()`), COAST (`World.ocean`, `World.coast.seaAt`) | Three specs edit one class | **W10-S owns every `world.ts` edit** [decision]: `this.sky.dispatchGpu(camera)` right after `this.sky.update(dt, camera)`; one generic **part slot** (`WorldPart { update(camera, dt); meshes(); dispose() }`) used by `trees` and `ocean`, updated after `objects.update`, listed by `World.meshes()` and disposed with the world; `World.coast: CoastAccess \| null` with `seaAt(x, z)` (null until CST-O); `LoadWorldOptions.trees?: 'new' \| 'retail'`; `setTreeMode(mode)` → `stream.rebuild()`. The Low guard stays green with every slot empty. |
| D3 | `pbr/fog-plugin.ts` | SKY2 (haze, froxels), COAST (the ocean only receives it), TREES (the impostor includes its function) | RND-P's file; three consumers | **S2-H owns it for wave 10** [decision]. It exports the haze as one WGSL/GLSL function, **`sroHaze(lit, worldPos)`**, plus `bindHaze(effect, scene)` for ShaderMaterials (the dome, the grass and Classic water chunks on Medium+, the impostor). W10-S creates both names now as a wrapper around today's `HEIGHT_FOG_WGSL/GLSL`, so TR-I and CST-O compile against the final name from day one. TREES' `sroAtmosphere` is dropped (TREES F14). |
| D4 | `pbr/foliage-plugin.ts` | SKY2 §8.4 (key light × `sroCloudShadow`, +1 sampler), TREES TR-0/TR-W (`SRO_FOL_VDATA`) | Two specs edit one plugin; TREES F14 asks for a merge order | **W10-S writes both skeletons** (the `SRO_FOL_VDATA` define, off, switched by the material flag `metadata.sroTreeVdata`; the key-light × `sroCloudShadow` call under `SRO_CLOUDSHADOW`, off). **TR-W owns the file afterwards.** S2-V never edits it: the cloud-shadow body lives in `sky/chunks.ts` [decision]. |
| D5 | `sky/sky-system.ts` | SKY2 S2-V (the key-light readback), S2-A (the bounce lobe), W10-S (`dispatchGpu`) | Three lanes, one file | **S2-V owns it this wave.** W10-S adds `dispatchGpu(camera)` (empty), a call to `groundBounceLobe(state, input)` (from a new `sky/ground-bounce.ts`, S2-A's pure function, returning zero until S2-A lands) and an occlusion-source switch (the 2.5D `CloudLayer.occlusion` until S2-V). |
| D6 | `render/post.ts` | SKY2 (+ `gtao`, + `meter`, − `vls`), S2-A, S2-E | Stage bodies from two lanes | **W10-S** edits `POST_STAGE_ORDER` (+ `'gtao'` at `ssao`'s place, + `'meter'`; − `'vls'` and the VLS code, SKY2 §5.5) and the stage calls; the bodies live in `render/gtao.ts` (S2-A) and `render/auto-exposure.ts` (S2-E). `clearPrepassForSsao` stays (GTAO needs it). Afterwards `post.ts` is I-10's only. |
| D7 | `render/lighting.ts` | SKY2 S2-I (IBL), S2-A (bounce into the SH) | Two writers of the SH | **S2-I owns it.** One writer per SH band: L0/L1 each frame from `SkyState.sh` (+ the flash, D25 of WAVE_PLAN3, + the bounce lobe), L2 from the GPU readback scaled by the current L0 (SKY2 §6.2). The bounce lobe arrives through `SkyState` (D5), not through a second `lighting.ts` edit. |
| D8 | Preset tables | SKY2 (`SKY_PRESETS`, `RENDER_PRESETS` rows), COAST (ocean rows per preset), TREES (bands, frame sizes) | Three places could grow preset tables | **One table, written once by W10-S** (the §5.1 rows as data) [decision]: `render/quality.ts` `RENDER_PRESETS` gains `haze`, `ibl.gpu`, `autoExposure`, `ao`, `contactShadows`, `groundBounce` and **`ocean`** (waves, FFT size, CDLOD G and levels, foam extras, receives CSM); `sky/types.ts` `SKY_PRESETS` gains `volumetric`; `trees/types.ts` `TREE_PRESETS` holds the bands, frame sizes and caster rule. CST-O and TR-F **read** them. Later changes only through I-10. |
| D9 | Settings and Options | SKY2 (`clouds`, `autoExposure`, `aoMethod`), TREES (`graphics.trees`) | Two specs edit one normaliser; SKY2 F6 found `ao` already taken | **W10-S adds every field and its normalisation**: `graphics.advanced.clouds: 'auto' \| '2d' \| 'volumetric'`, `autoExposure: 'auto' \| 'off'`, `aoMethod: 'auto' \| 'ssao' \| 'gtao'`; `graphics.trees: 'new' \| 'retail'` (default `'new'`, ignored on Low). `ao` and `lightShafts` keep their values (`lightShafts` now drives the froxel shafts). **GAME-10 owns `settings.ts`, `hud/options.ts`, `i18n/en-render.ts` afterwards.** |
| D10 | `render/shadows.ts` | TREES (`addCasterSource`), SKY2 (compute reads the CSM) | SKY2 reads a private field | **W10-S** adds `WorldShadows.addCasterSource(fn)` (the tree LOD0 casters) and a read-only `cascadeInfo()` (the map, `getCascadeTransformMatrix(i)`, the split depths from the private `_viewSpaceFrustumsZ`, guarded, null when absent) for S2-V and S2-H. Nothing else in `shadows.ts` changes. |
| D11 | The coast's hooks | COAST §12.8 (I-CST applies them after the lanes) | The lanes could not test against hooks that land last | **Moved forward into W10-S** [decision]: `COAST_CHUNKS` in `WORLD_SHADER_CHUNKS` (order sky → weather → night → coast → render, at `preLight`) with an empty `coast/chunks.ts` (CST-S owns it afterwards); the `sroCoastWet` extern in `pbr/terrain-plugin.ts` (empty = off); `WaterRenderer.ensurePbrState()` public plus a Classic frames getter (COAST F5); the `ocean` part slot and `World.coast` (D2). |
| D12 | The tree field's streaming seams | TREES TR-0 + F13 a–f | Six were missing from the first draft | **W10-S** (TREES §5.2 TR-0 row in full): the claim before `host.acquireModel` (a claimed model is never acquired or downloaded), counted in `pendingObjects` until the field reports ready; `StreamHooks.claim`; `WorldObjects.setClaimer` (whole-world path) and `removeRegion` → claimer; the claim keyed on the render path (PBR claims, Classic never); `World.meshes()` and `shelterCandidates()` add the part meshes (rain stops under new canopies); the field sets `receiveShadows`, `isPickable = false`, `WORLD_OBJECT_LAYER` itself. |
| D13 | Converter files and Blender | COAST CST-C/CST-B, SKY2 S2-C, TREES TR-A; both CST-B and TR-A add a `blenderExe` key | Two lanes, one config key; one optimizer | **CST-C** owns `convert-world.ts`, `manifest.ts`, `world/coast/**`, `WORLD_PRESETS['jangan-fields'].coast`, `content/coast/`. **S2-C** owns `tools/export-sky.ts` (the `.bin` files need no optimizer edit [confirmed per SKY2 §4.2]). **TR-A** owns `packages/convert/src/trees/**`, `content/trees/**`, the **one** `blenderExe` key (`SroConfig` in `node-io.ts`, `sro.config.example.json`) and a new helper `packages/convert/src/blender.ts` (`blenderPath(config)`, `runBlender(script, args)` that refuses relative paths, COAST §6.6 finding 1). **CST-B uses that helper** and starts after TR-A merges it. `optimize/run.ts`: only TR-A may edit it, and only if `optimize-out` does not already process `out/trees/**` like world glbs [unknown; TR-A checks first]. Wave 11's Blender animation work reuses the same key and helper. |
| D14 | `THIRD_PARTY_NOTICES.md` | COAST S-NOTICE (CST-O first), SKY2 §12 (whichever lands first), TREES F14 | Three specs, one file, one test name | **W10-S creates** the root `THIRD_PARTY_NOTICES.md` (the Tidewater entry: URL, pinned commit `4811ba4`, the full MIT text with *Copyright (c) 2026 DRG Software Solutions LLC*, an empty file list) and `packages/world-render/test/tidewater-notices.test.ts` (every file with the Tidewater header is listed; every listed file exists). Each porting lane appends its own rows (S2-V/H/I/E/A, CST-O, CST-S, TR-F/TR-I only if code, not just the idea, is ported). S2-A adds three.js's MIT entry only if it ports `GTAO.js`. I-10 puts the file in the deploy list. Answers COAST Q2 and SKY2 Q13. |
| D15 | Lab, bench, budgets | SKY2 S2-L, TREES TR-L, COAST I-CST step 4 | Three lab lanes, three bench lists | **One LAB-10** with one viewer panel set, **one bench list** (§5.2: plaza noon, gate storm, fields night, crowd, beach noon, beach storm night, the forest spot (20, −220) of TREES §3.6) and **one** results file, `work/tmp/w10-lab/budgets.md`. The wave-9 final gate's method (production bundle, private `vite preview`, 400 uncapped frames after streaming idles, hardware scaling 1). |
| D16 | Texture units and varyings | SKY2 F5 (terrain only counted), COAST (ocean one varying; `sroCoastWet` +1 unit), TREES F1 (no `COLOR_0`) | Each spec guards its own materials; nobody counts the sum | **W10-S writes one guard pair** [decision]: `test/material-budgets.test.ts` (NullEngine, GLSL: texture units per final define set ≤ 16, the D32 rule, extended from `work/tmp/sky2-fc/d32-count.test.ts` to every family: terrain incl. `sroCoastWet`, surface, foliage incl. VDATA and the cloud map, ocean, impostor, grass, Classic water, the fog plugin's haze sampler) and the varying count (`wgslInterStageCount` ≤ 15 user + `front_facing` on every WGSL variant). Each lane registers its define sets in the test's registry; the test runs after every merge. |

### 2.2 State ownership (one source of truth each)

| State or module | Produced by | Consumed by | Owner lane (wave 10) |
|---|---|---|---|
| **Haze and fog: colour and amount per pixel** | `sroHaze` in `pbr/fog-plugin.ts` (LUT colour on Medium and WebGL2, froxel volume on High+ WebGPU), `sky/haze-volume.ts` | every PBR material (terrain, objects, trees, **the ocean** through the global registration), the grass and Classic water chunks (Medium+), the dome below +0.9°, the impostor | **S2-H** |
| Fog **distance** (visibility) | `fogScale` (`packages/shared/src/weather.ts`) × `FOG_RANGE_M` | the extinction in `sroHaze` | WX-R (built; unchanged) |
| **The horizon** (dome below the horizon, fog at the sea's clip line, the far sea) | `sroHaze` (≥ 99.9 % at 2,000 m, SKY2 §5.3) and the dome's below-horizon branch | the sea only reads it; the sea's below-horizon **reflection** fade is the IBL cube at the ray clamped to +0.9° × 0.35, inside CST-O's custom reflection (D18) | **S2-H** |
| **IBL** (`scene.environmentTexture`, its mips, the SH L2 band) | `render/ibl-gpu.ts` (two persistent RT cubes; the live one written in place) | every PBR material, the ocean's reflection | **S2-I** |
| `SkyState.sh` (L1), key light, exposure target | `sky/sky-system.ts` | grass, lighting, AE | S2-V holds the file (D5); the values are SKY-B's wave-9 maths |
| **Cloud shadows on land, sea and trees** | `sroCloudShadow` body (`SRO_CLOUDMAP`: the 256² map, 2,048 m, `yRef` plane) in `sky/chunks.ts`, the map kernel, the key-light occlusion readback | terrain, grass, the ocean (High `'ground'`); objects, trees LOD0/LOD1, impostors (Ultra `'all'`) (D20) | **S2-V** |
| **Wind** | `WeatherFrame` (`windX/Z`, `windMs`, `gustMs`, `time`) from `features/weather.ts`; the vegetation sway function in `weather/chunks.ts` | clouds (unfiltered × `CLOUD_DRIFT`), the weather-map scroll (S2-V), the sea (its own low-pass τ ≈ 30 s wind sea, τ ≈ 120 s swell, CST-O `ocean/weather.ts`), grass, trees (TR-W reuses the sway function) | **WX-C / WX-R (built, frozen)**. No new wind state; one test that every consumer reads the same frame fields (COAST S-CLOCK) |
| Exposure (final) | `SkyState.exposure` × `EXPOSURE_TRIM` × `ae` | post, bloom threshold, highlight overlay, **night lamps** (quantised ≥ 0.1 EV steps) | **S2-E** (`ae`); SKY-B maths for the target |
| Ground bounce | `sky/ground-bounce.ts` lobe into the SH; albedo from the tiles, the 9B sets, and `World.coast.seaAt` over open sea (≈ 0.06) | every PBR material through the SH | **S2-A** (function), **CST-O** (`seaAt`) |
| Depth | nobody adds a depth pass. The ocean's transparent depth pre-pass (or its depth-only twin) writes the hardware depth only; the prepass MRT holds opaque PBR only | GTAO reads the prepass; the sea and the impostors read as sky there (accepted, D17) | — |
| Coast data (field, `manifest.coast`, synthetic regions, `places`) | the converter | the ocean, the shore, the minimap, the server's `tp` | **CST-C** |
| Tree placements | the manifest (re-exported by CST-C; moved-ground rule C9 by uid) | the tree field | **CST-C** (data), **TR-F** (field) |
| Tree swap table | `content/trees/swap.json`, keyed by the retail `models[i].source` | TR-F | **TR-A / TR-B** |
| Preset rows | `RENDER_PRESETS`, `SKY_PRESETS`, `TREE_PRESETS` | all lanes | **W10-S** writes; **I-10** changes |
| Texture-unit and varying budgets | `test/material-budgets.test.ts` | every material family | **W10-S** writes; each lane registers |
| `THIRD_PARTY_NOTICES.md` | root file | the deploy | **W10-S** creates; porting lanes append |

### 2.3 Rendering conflicts

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| D17 | Haze and shafts: material or depth post pass (COAST S-HAZE, Q1) | COAST §8.13, SKY2 §5.4 | The sea is transparent and the impostors write no prepass: a depth-reading post pass would treat both as sky | **In the material** (SKY2 §5.3–5.4) [decision, confirmed feasible: the prototype's plugin sampled the froxel volume with no new varying]. SKY2 reads **no** depth. S-SHAFTS "stop at the sea surface" holds by construction. The ocean's depth pre-pass stays only to order folds. GTAO treats the sea and the impostors as sky (no AO there), accepted. |
| D18 | `horizonColor(dir)` for the sea | COAST §8.6 (`horizonColor × 0.35` for below-horizon reflections), SKY2 §5.5 (`horizonRing` retires on PBR presets) | COAST calls a function SKY2 retires | The sea's below-horizon reflection = **the IBL cube sampled at the reflected ray clamped to +0.9°, × 0.35**, inside CST-O's `USE_CUSTOM_REFLECTION` [decision]. No new function, uniform or sampler (the cube is already bound). The dome and the fog use `sroHaze`; S2-H owns the horizon seam test (\|ΔRGB\| ≤ 2/255 at noon, dusk, storm and fog weather, sea vs dome vs far land). COAST §8.10's "+ horizon ring" rows are superseded. |
| D19 | The far sea under full haze | COAST §8.2 (CDLOD to the 2,000 m far plane), SKY2 §5.3 (≥ 99.9 % haze at 2,000 m) | The ocean draws nodes that are fully hazed, and would add +2 draws from inland views such as the plaza | **The CDLOD selection stops at the full-haze distance** (the distance where the haze transmittance falls below 0.1 %, from the current fog density and the sea's height below the eye) [decision; projected ≈ 600 m on a clear day at the retail fog end]. By D18 the dome shows the same colour there, so it is invisible. CST-O's spike checks it on the horizon strip; the fallback is today's far plane. Target: the ocean's CPU is ≤ 0.02 ms wherever no sea is within the full-haze distance. |
| D20 | Cloud-shadow sets | SKY2 §4.8, §8.4, Q11; COAST F6; TREES §3.5 | Who gets the map on which preset; the retail water has none | High (`'ground'`): terrain, grass, the ocean. Ultra (`'all'`): + objects, trees (LOD0, LOD1) and impostors. **Objects and trees on High only if the D16 guard shows a free texture unit** (SKY2 Q11), then LAB judges the look. The ocean fades its factor to 1 in the join zone with the retail water (COAST F6). On WebGPU High+ the 2.5D clouds also write the map (SKY2 Q12: yes), so the watchdog's clouds step recompiles only the dome. The key-light occlusion keeps today's strengths (× 0.45 on `'ground'`, × 0 on `'all'`), so nothing is shadowed twice. |
| D21 | The Low guard with a coast | WAVE_PLAN3 D4, COAST §8.6 (`COAST_CHUNKS` in the Classic terrain), COAST §8.10 (Low gets a Classic ocean) | A new chunk and a new mesh on Low | The guard's meaning stays: **shader strings with empty chunks equal HEAD's, and Low + classic sky + weather off builds the same classes and defines**. `COAST_CHUNKS` code sits behind `SRO_COAST`, set only on region materials inside the coast field; the guard's fixture world has no `manifest.coast`, so it stays exact. On the real world Low players get the Classic ocean and the new coast terrain: that is **content**, the sea the user asked for, not a renderer change. Low gets no SKY2 feature and keeps the retail trees. |
| D22 | WebGL2 texture units | SKY2 F5 (terrain Medium 13/16, High 16/16), COAST F16 (`sroCoastWet` +1; the worst set is already ≥ 15), TREES (+1 cloud map on foliage) | The sum was never counted | Medium terrain: 13 + `skyView` = 14, + `sroCoastWet` on coast regions = 15 [projected]. High terrain: the haze stays **net 0** (the volume or the LUT replaces the ring); `sroCoastWet` on High must share a unit. Fallback order for CST-S: (1) a spare channel of a per-region texture the terrain already binds [unknown which has one], (2) the shelter map's unit, (3) read the field only when `SRO_SHELTER` is off. Trees: + `cloudNoise` only where D20 allows. The D16 guard decides every case. |
| D23 | Varyings | COAST R6 (one packed vec4), TREES F1 (no `COLOR_0`), SKY2 §3.4 (none) | One more varying black-frames a 16-limit adapter at Medium | **No wave-10 material adds a varying**, except the ocean's single packed vec4 on a mesh that has no uv, no vertex colour and no tangent. No `COLOR_0` and no instance colour on any tree mesh. The impostor and every new ShaderMaterial stay at ≤ 15 user varyings. The D16 guard counts it; H-10 runs with the limit forced to 16. |
| D24 | TAA | SKY2 §3.7, COAST S-TAA, TREES F9 | Reprojection is off (thin instances break WebGPU velocity) and TAA is off while the camera moves | **Nothing in wave 10 relies on TAA** (WAVE_PLAN3 D30 stays open). The clouds, the froxels and GTAO keep their own histories. Tree LODs switch hard with 3 m hysteresis on every preset. The sea writes no motion vectors unless LAB sees crest ghosting in a storm on High. |
| D25 | Exposure against the glint and the lamps | SKY2 §7.2, COAST S-EXPO | A sunlit sea could drag the meter; an AE ramp re-sets every lamp ~40 times a second | The meter clamps each tap at 16 × KEY before the log; the ocean clamps its glint lobe at 400; panning beach → glint moves the exposure < 0.5 EV (LAB check). The night lamps take the final exposure in ≥ 0.1 EV steps. The meter freezes during a flash. |
| D26 | Trees in the sky's light | SKY2 §8.4, TREES §3.5, F14 | The impostor is a ShaderMaterial outside the plugins | LOD0 and LOD1 get haze, IBL, bounce and (per D20) cloud shadows through the plugins. **The impostor includes `sroHaze` and `sroCloudShadow` by name and binds them with `bindHaze` and the cloud-map sampler**, plus the `SkyState` SH (as the grass chunk) and the key light. Shafts through canopies come from the LOD0 casters in the CSM. |
| D27 | The live IBL cube | SKY2 F1, Q10; COAST S-IBL | `_swapAndDie` leaves stale WebGPU bind groups; the sea asks for no reflection pop | Two persistent cubes, the live one rendered **in place one level per frame**, never swapped, `environmentTexture` never reassigned (a test pins the `uniqueId`). LAB's "no pop" check on a calm sea decides; the fallback is a third cube copied in one frame. |
| D28 | Refresh and jump rules | SKY2 §6.2 (IBL 5 / 3 / 2 s), §4.5 (clouds rebuild on a cut), COAST (the sea spectrum at most once a second), TREES (refill every 4 m) | Several per-frame jobs could land on one frame | Every time-sliced job (IBL slices, cloud-shadow quarters, panorama slices, the tree refill, the sea's 128 KiB upload) skips a frame in which a region commit job runs (WAVE_PLAN3 §4.1 commit steps); a time jump or a teleport runs the IBL and the cloud rebuild at once, the one hitch the player expects. |
| D29 | The frame-time watchdog | SKY2 S2-G | Which step first | On High and Ultra the first step is **clouds → 2D** (the dome's define only, D20), then the existing preset step. No ocean or tree step. |

### 2.4 Data, content, tools and delivery

| # | Topic | Decision |
|---|---|---|
| D30 | New 3D models | **Trees only** (the relayed request) [decision]. Buildings, rocks, props, ships and birds stay retail. The coast's islets and sea stacks are terrain sculpts (later, COAST §14 item 7). A coastal tree species (wind-bent pines on the Tiger cliffs) is **not** made by default; if the user asks, it is a TR-B row, never a coast model (COAST S-TREE). |
| D31 | The re-convert of `jangan-fields` | Two lead checkpoints: **X1** after CST-C phase 1, CST-M (converter) and CST-B merge; **X2** after CST-C phase 2. Each is `convert` + `optimize-out --only world/jangan-fields/`, run when no other lane writes `work/out/world/`. The trees need no order: the swap is keyed by the retail source path and C9 moves or drops placements by uid, so the tree field works on either export. Only B-T5 (Dunhuang, mostly western regions) waits for X2. |
| D32 | The GPU queue | Every GPU job takes `work/tools/gpu.lock` (mkdir; the owner file names the label and the time; only the creator removes it): LAB-10 timing runs, the texpipe upscale and derivation for B-coast and the tree sprites, B2/B3, and the SDXL step (only through `work/tools/comfyui/start_comfyui.sh`, never beside another heavy GPU job, per the user's rule). Priority: LAB-10 timings > B-coast > tree sprites > B2/B3. Blender bakes run on the CPU (Cycles CPU, Workbench) and need no lock. |
| D33 | What players download | High/Ultra: the cloud noise `.bin` files (≈ 7.2–7.4 MiB on the wire [projected, SKY2 F9]) on the first volumetric use. Medium+: the trees, net ≈ +3.2 MB (TREES F6). Everyone: the re-converted coast regions (≈ 0.2–1.3 MB, COAST C17), the B-coast sets, ≤ 0.3 MB of coast audio. The build itself downloads nothing (every tool is installed). |
| D34 | HTTPS | Without it no friend runs WebGPU, so the High+ sky and sea never reach anyone. **Wave 10 includes DEPLOY.md's "HTTPS via Tailscale" step** as a deploy item: the user flips MagicDNS and HTTPS certificates in the Tailscale admin console; with the user's go, `tailscale serve --bg http://<SERVER_TAILNET_IP>:7000` on the mini PC (§8 item 1). |
| D35 | First-run preset | Unchanged: Medium on every adapter class. No High recommendation until BACKLOG item 9 makes High pass. |
| D36 | Stale clients after a re-convert | The deploy restarts the server and the release note asks players to reload (COAST Q13 default). No `WorldInfo.exportId` this wave. A character saved on the old S1 strip is re-placed by `entryPoint` → `nav.place` [confirmed per COAST F15]; CST-C adds that row to a server test. |
| D37 | The 60 fps rule | Read as the gates G1–G4 of §5.4 [decision; the strict alternative, "no wave-10 feature on a preset that fails anywhere", is §8 item 2]. |

### 2.5 Numbers and config (consolidated)

| What | Value | Where it lives | Source |
|---|---|---|---|
| Cloud layer | cumulus 1,500–3,200 m; stratus deck 900–2,400 m in rain; cirrus 2D at 8 km | `sky/volumetric/` | SKY2 §4.2 |
| Weather map, noise | 512² RGBA8, 24 km per tile; shape 128³ RGBA8 (2,400 m), detail 32³ (420 m); `out/sky/cloud-shape.bin`, `cloud-detail.bin` | `export-sky.ts` | SKY2 §4.2 |
| Trace | High 0.6×, 96 steps, 4 light taps, detail ≤ 2 km; Ultra 0.75×, 128 steps, 6 taps, ≤ 3 km; 1 of 16 pixels per frame | `SKY_PRESETS.volumetric` | SKY2 §4.1 |
| Cloud-shadow map | 256² RGBA8, 2,048 m around the camera, re-centred in 256 m steps, indexed on `yRef` (the camera height, snapped to 32 m) | `sky/chunks.ts` | SKY2 §4.8 (F2) |
| Haze | wave 9's extinction (95 % at the retail fog end × `fogScale`, falloff 80 m); colour = sky-view LUT + HG sun glow + cloud and rain terms, `gradeW` 0.65 day / 0.3 low sun; froxels 160 × 90 × 64 to 320 m, analytic beyond | `pbr/fog-plugin.ts`, `sky/haze-volume.ts` | SKY2 §5 (F3, F4) |
| IBL | GPU, 32² ≥ 5 s (Medium), 64² ≥ 3 s (High), 64² ≥ 2 s (Ultra); a 0.5° sun or 0.05 weather move triggers | `render/ibl-gpu.ts` | SKY2 §6.2 |
| Auto exposure | ±0.5 EV Medium, ±1 EV High/Ultra; dead band ±0.2 EV; +0.8 / −1.2 EV/s; `hi × (1 − 0.8·precip)`, halved at night; KEY 0.18 | `render/auto-exposure.ts` | SKY2 §7.2 |
| Sea level, field | +5.0 m; coast field 4 m per texel (A foam/mask, B depth and land height ≤ 128 m from the shore); seed 1188 | `content/coast/coast.json`, `coast/field.png` | COAST §0.1, §8.1 |
| Ocean | Low 3 Gerstner; Medium worker FFT 2 × 64² at 20 Hz; High GPU FFT 4 × 128²; Ultra 4 × 256²; CDLOD G 16/16/32/64; Hs ≤ 2.5 m; the far cut at full haze (D19) | `RENDER_PRESETS.ocean` | COAST §8.10 |
| Shore v1 | swash run-up `0.15 + 0.25·Hs` m, ≤ 0.8 m; foam band + lace; analytic bead | `shore/*` | COAST §8.8 |
| Teleport | `beach-south` at (170.5, 90.6), GM only, through `manifest.places` | `coast.json` `places` | COAST C18 |
| Tree bands | LOD0 < 45 m, LOD1 < 110 m (per-model impostor edge `max(110 m × s, width × 1190 / (1.25 × framePx))`), impostor to `GROUP_RANGE_M[group] × s` (+10); `s` 1.0 Medium, 1.4 High/Ultra; on `distance − radius`; refill every 4 m; 3 m hysteresis; Ultra: impostor from 250 m | `trees/types.ts` `TREE_PRESETS` | TREES §3.2 (F11, F12, F19) |
| Tree geometry | LOD0 ≤ 3,500 triangles (small species ≤ 1,500), LOD1 ≤ 900; bounds ±10 % of the retail envelope, LOD1 ±4 % of LOD0; glb ≤ 150 KB in `out-opt` | TR-A validator | TREES §3.3 |
| Impostor frames | 6 × 6 hemi-oct views; 96 px Medium; 128 px High/Ultra once KTX2 covers them, 96 px until then (§5.2 VRAM) | `TREE_PRESETS` | TREES §3.5, Q2 |
| Tree wind data | `TEXCOORD_1` = flex, phase (→ `uv2`); `TEXCOORD_2` = flutter, crown AO (→ `uv3`); no `COLOR_0`; the shader reads `1 − v` | TR-A, TR-W | TREES §3.4 (F1–F3) |

---

## 3. Protocol: none

No lane of wave 10 changes the wire [confirmed per spec, each re-checked by its fact-check]:

- **SKY2:** the server clock and weather already drive the sky (`worldClock`, `weather`, `lightning`, wave 9). All
  additions are client state (`SkyState`, `SkyQuality`, `RenderQuality`, settings).
- **COAST:** the coast is exported data. `WorldInfo` gains nothing (no `exportId`, D36). `tp beach-south` is a
  manifest place read by the existing `manifestPlaces`, GM-only [confirmed per COAST F15: `content.ts`, `gm.ts`]. The
  bounds do not move at +5 m, so `World.clamp` and the nest spawner need no code change; S1's changed nav is in the
  regenerated `nav.bin` and `nav/` chunks. No server config key.
- **TREES:** client rendering only. `world.pick` uses the navmesh and the terrain; tree meshes are not pickable; the
  server's `nav.bin` never reads a glb [confirmed per TREES F20].
- **No database migration, no GM command, no validator, no client → server message.**
- **Server-side data changes** (I-10's deploy): the re-exported `jangan-fields` (X1, X2) and a restart; the server
  test row for a character saved on the old S1 strip (CST-C); the check that the nest spawner places the same set and
  skips the same 91 as before the coast (COAST F8).

---

## 4. Seams (W10-S; one agent; every edit is additive, and Low + classic sky + weather off stays identical)

### 4.1 `packages/world-render`

| File | Edit |
|---|---|
| `world.ts` | D2: `sky.dispatchGpu(camera)` after `sky.update`; `WorldPart` slots `trees` and `ocean` (update after `objects.update`, in `meshes()`, disposed); `World.coast: CoastAccess \| null` (`seaAt(x, z): number \| null`); `LoadWorldOptions.trees`; `setTreeMode(mode)` → `stream.rebuild()`. |
| `region-chunk.ts`, `stream.ts`, `objects.ts` | D12: `host.claim?(model, placements, owner)` before `host.acquireModel`, the claimed model counted in `pendingObjects` until its claimer reports ready; `StreamHooks.claim`; `WorldObjects.setClaimer`; `removeRegion` → claimer; the claim keyed on the render path. |
| `weather/index.ts` | `shelterCandidates()` also yields `World`'s part meshes (the field's LOD0/LOD1; not the impostors, not the sea). |
| `render/shadows.ts` | D10: `addCasterSource(fn)`, `cascadeInfo()`. |
| `render/post.ts` | D6: stage order, stage calls, VLS deleted. |
| `render/gtao.ts`, `render/auto-exposure.ts`, `render/contact-shadows.ts`, `render/ibl-gpu.ts` (new, stubs) | Empty stage bodies (S2-A, S2-E, S2-A, S2-I own them). |
| `render/lighting.ts` | The `IblSource` interface (`begin`, `step`, `texture`, `polynomial`); `SkyEnvironment` implements it; the switch reads `quality.ibl.gpu` (false until S2-I). |
| `render/quality.ts` | D8: the §5.1 render rows as data, including `ocean`. `horizonRingFog` stays false on every PBR preset from now (SKY2 §5.5). |
| `render/gpu-guards.ts` | A texture-unit count per stage next to the varying count (SKY2 §9). |
| `sky/types.ts` | `SkyQuality.clouds.kind += 'volumetric'`, `SkyQuality.volumetric \| null`; `SkyState += cloudVolume, cloudPanorama, skyView, hazeVolume, groundBounce` (null or zero); the `SKY_PRESETS` rows. |
| `sky/sky-system.ts` | D5: `dispatchGpu` (empty), the `groundBounceLobe` call, the occlusion-source switch. |
| `sky/sky-shaders.ts` | The empty `SKY_CLOUDS_VOLUMETRIC` tier (sampler `cloudVolume`), the below-horizon branch calling `sroHaze` (a wrapper equal to today's fog colour until S2-H). |
| `sky/chunks.ts` | The `SRO_CLOUDMAP` body of `sroCloudShadow`: same name, uniforms and sampler slot, returning today's value until S2-V. |
| `sky/ground-bounce.ts`, `sky/haze-volume.ts`, `sky/volumetric/index.ts` (new, stubs) | Owned by S2-A, S2-H, S2-V. |
| `pbr/fog-plugin.ts` | D3: the `SRO_HAZE_SKY` / `SRO_HAZE_FROXEL` define skeleton; the sampler slot `sroFogRing` renamed `sroHazeTex`; `sroHaze` and `bindHaze` exported as wrappers of today's height fog; +2 vec4 uniforms reserved for the weather terms. |
| `pbr/foliage-plugin.ts` | D4: `SRO_FOL_VDATA` (off, material flag) and the key-light × `sroCloudShadow` call (off). |
| `pbr/terrain-plugin.ts` | D11: the `sroCoastWet` extern (empty = off), next to `sroShelter`, `sroCloudShadow`, `sroNightSplat`. |
| `shaders.ts`, `coast/chunks.ts` (new, empty) | D11, D21: `COAST_CHUNKS` in `WORLD_SHADER_CHUNKS`, behind `SRO_COAST`. |
| `water.ts` | D11: `ensurePbrState()` public, a Classic frames getter. |
| `trees/types.ts` (new) | `TreeSwap`, `TreeModel`, `TreeFieldPart`, `TREE_PRESETS`. |
| `ocean/types.ts` (new) | `OceanPart`, `CoastAccess`, the shore seam names `SHORE_VERTEX` / `SHORE_FRAGMENT` (the composer that interpolates them is CST-O's). |
| `index.ts` | Exports of every new type and module. |
| root `THIRD_PARTY_NOTICES.md`, `test/tidewater-notices.test.ts` | D14. |

### 4.2 Shader and plugin points

| Material | Point | Contributors (wave 10) |
|---|---|---|
| Every PBR material | `SroFogPlugin` at `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR` (image processing in post, WAVE_PLAN3 D18) | S2-H (`sroHaze`: LUT or froxel tap) |
| PBR terrain | externs `sroCloudShadow` (S2-V body), `sroCoastWet` (CST-S) | S2-V, CST-S |
| Surface plugin (objects) | `sroCloudShadow` on Ultra | S2-V |
| Foliage plugin | `SRO_FOL_VDATA` at `CUSTOM_VERTEX_UPDATE_WORLDPOS`; key light × `sroCloudShadow` | TR-W; S2-V (body only) |
| Ocean plugin | its own file; receives the fog plugin after it; calls `sroCloudShadow`; custom reflection (D18); shore chunks `SHORE_VERTEX/FRAGMENT` | CST-O, CST-S |
| Dome | `SKY_CLOUDS_VOLUMETRIC` tier; below-horizon `sroHaze`; the last-slice shaft tap | S2-V, S2-H |
| Classic terrain | `COAST_CHUNKS` at `preLight` under `SRO_COAST` | CST-S |
| Grass, Classic water | `sroHaze` through their existing chunk points (Medium+ only; Low exact) | S2-H |
| Impostor (ShaderMaterial) | includes `sroHaze`, `sroCloudShadow`; binds SH, key light | TR-I |

WGSL rules every chunk and plugin follows (WAVE_PLAN3 §4.2, COAST F14): `textureSampleLevel` in the vertex stage and
in non-uniform control flow; fragment taps that sit in branches are taken once at `CUSTOM_FRAGMENT_MAIN_BEGIN`; no
swizzle assignment of more than one component; no `?:`; no new varying (D23); every define is set from Options or the
preset only, never by weather or time; WGSL and GLSL return the same injection-point keys (a test per plugin).

### 4.3 `apps/game`, `apps/viewer`, `packages/convert`

| File | Edit |
|---|---|
| `apps/game/src/settings.ts` | D9: the four new fields and their normalisation (old saves keep `ao` and `lightShafts`). |
| `apps/game/src/i18n/en-render.ts` | Keys for the new rows (live text, docs/UI.md). |
| `apps/viewer/src/world/main.ts` | Pass-through of `?trees=`, `?clouds=`, `?haze=`, `?ocean=` into `LoadWorldOptions` / quality (LAB-10 adds the panels). |
| `packages/convert` | Nothing: CST-C, S2-C and TR-A own their files from step 0 (D13). |

### 4.4 W10-S tests

- `seams-classic.test.ts` (the Low guard) unchanged and green.
- `render-quality.test.ts` extended: every preset has every new key; Low has every wave-10 feature off; the `ocean`
  and `TREE_PRESETS` rows match §5.1.
- `material-budgets.test.ts` (D16): the registry, today's families registered, ≤ 16 texture units and ≤ 15 user
  varyings on every set (today terrain Medium 13, High 16 [confirmed per SKY2 F5]).
- `trees-seams.test.ts` (TREES TR-0 list): no claimer = HEAD behaviour; a claimed model is not acquired and its
  placements reach the claimer; `removeRegion` reaches it; `'objects'` fires only after the claimer's ready; a Classic
  rebuild claims nothing; the shelter candidates include the part meshes.
- `world-parts.test.ts`: an empty `trees`/`ocean` slot and `coast = null` change nothing; a stub part is updated,
  listed and disposed.
- `tidewater-notices.test.ts` green with an empty list.
- `apps/game/test/settings.test.ts` extended: old saves normalise; the four fields round-trip.
- WGSL/GLSL key parity on every touched plugin; `pnpm typecheck` clean; the whole suite green.
- **User check:** nothing changes on screen.

---

## 5. Presets and budgets

### 5.1 The merged preset table (the data W10-S writes; additions to WAVE_PLAN3 §5.1)

| Feature | Low (Classic) | **Medium (default)** | High | Ultra |
|---|---|---|---|---|
| Clouds | retail `cloud1` plane | 2.5D cumulus (wave 9) | **volumetric** 0.6×, 96 steps, 4 taps (WebGPU); 2.5D on WebGL2 unless LAB measures the fragment fallback ≤ +0.25 ms CPU | volumetric 0.75×, 128 steps, 6 taps (WebGPU compute; WebGL2 fragment fallback) |
| Cloud shadows | — | — | the map (2.5D clouds also write it on WebGPU; the noise on WebGL2): terrain, grass, sea | + objects, trees, impostors |
| Haze | linear retail fog | **sky-coloured** (LUT, analytic) | froxels 160 × 90 × 64 + shafts (WebGPU); LUT (WebGL2) | + froxel history |
| IBL | — | **GPU**, 32², ≥ 5 s | GPU 64², ≥ 3 s, panorama clouds (WebGPU) | GPU 64², ≥ 2 s |
| Auto exposure | — | ±0.5 EV | ±1 EV | ±1 EV |
| Ground bounce | — | SH lobe | SH lobe | SH lobe |
| AO | — | — | GTAO or SSAO2 (LAB A/B), half res | GTAO, full effort |
| Contact shadows | — | — | — | yes |
| Ocean material | Classic (retail frames) | PBR + `SroOceanPlugin` | same | same |
| Waves | 3 Gerstner | worker FFT 2 × 64², 20 Hz | GPU FFT 4 × 128² (worker tile on WebGL2) | 4 × 256² + near-field (worker on WebGL2) |
| CDLOD | G 16, 6 levels | G 16, 8 levels | G 32 | G 64 |
| Far sea | cut at full haze (D19) on every preset | | | |
| Foam and shore v1 | scrolling band, vertex swash | band, breaking line, tile Jacobian, lace, analytic bead, swash, wet sand | + lingering whitecaps, spray | same |
| Sea receives CSM | — | — | yes (never on a 16-varying adapter) | yes |
| Coast terrain | synthetic regions, S1 beach (data) | + `sroCoastWet` wet band | same | same |
| Coast life | audio only | audio, ships, flocks, critters | same | same |
| Trees | **retail** (skinned hidden, as today) | **new**: LOD0 / LOD1 / impostor (96 px), hard switch | new, bands × 1.4, impostor 96 px until KTX2, then 128 px | + LOD1 to 250 m, 3-frame impostor blend |
| Tree casters | — | none (as today) | LOD0 ≤ 63 m, static | + swaying when Babylon's `ShadowDepthWrapper` works on WebGPU |
| Tree wind | retail clips / Classic sway | vertex wind (height bend) + VDATA branches and flutter | same | same |
| Watchdog first step | — | the preset step | clouds → 2D, then the preset step | same |

Unchanged from WAVE_PLAN3 §5.1: the material path, CSM, night lights, SSR (Ultra only), AA, weather levels, the
render scales and the **first-run default: Medium everywhere** (D35).

### 5.2 Budgets and honest costs

Dev PC = Ryzen 5 9600X + RX 9060 XT, 1920 × 1080 at hardware scaling 1, the wave-9 final gate's method. "Mid" = RTX
3060 / RX 6600 (≈ 1.5 × the dev GPU time), "laptop" = RTX 3060–4060 Laptop (≈ 1.2 × mid), Apple M1 8-core GPU (≈ 4.5 ×
mid, ×1.4 more for the per-pixel parts at Retina 0.75), M1 Pro and up (≈ 2 × mid): the scale factors COAST §8.11 and
SKY2 §10.2 share. There is **no iGPU column**: no friend has an integrated-GPU PC (the user's decision); the Medium
0.75-scale rule stays as a guard. **Only the wave-9 rows and the named kernels are measured; every wave-10 total is
[projected]** (`work/tmp/plan4/budget.py`).

**Table 1: whole frame, p95 ms on the dev PC** (wave-9 measured → wave 10 projected; the trees counted at their gate,
+0, with their projected saving in brackets; "beach" = the gate-storm baseline + COAST's coast total + the sky, an
upper bound because half the beach view is sea [likely, COAST §8.11]; the forest spot (20, −220) has no wave-9
baseline [unknown], LAB-10 measures it first):

| Backend, preset | Plaza noon | Gate storm | Fields night | Crowd (20) | Beach (noon / storm night) | Pass line |
|---|---|---|---|---|---|---|
| WebGPU Low | 3.8 → 3.9 | 3.7 → 3.7 | 2.8 → 2.8 | 4.2 → 4.3 | ≈ 3.9 | pass |
| **WebGPU Medium** | 11.4 → ≤ 11.5 (10.8–11.2) | 8.1 → 8.2 | 5.9 → 6.0 | 14.4 → ≤ 14.5 (13.8–14.2) | ≈ 8.5 | **G1: pass**, ≥ 2.2 ms spare |
| WebGPU High (cut 4) | **17.9 → ≤ 18.2 (16.7–17.6)** | 15.9 → 16.0 | 10.7 → 10.8 | **21.5 → ≤ 21.8 (20.3–21.2)** | ≈ 16.5 | plaza, crowd: fail today → **G3**; gate, fields, beach: **G2**, beach margin ≈ 0.2 ms |
| WebGPU Ultra | 19.8 → ≤ 20.2 | 16.0 → 16.1 | 11.0 → 11.1 | 22.9 → ≤ 23.3 | ≈ 16.7 | G3 at plaza and crowd; G2 at gate and fields; **the beach is at the line** |
| WebGL2 Low | 3.0 → 3.1 | 2.4 → 2.4 | 2.1 → 2.1 | 4.2 → 4.3 | ≈ 2.6 | pass |
| **WebGL2 Medium** | 12.0 → ≤ 12.1 (11.4–11.8) | 7.2 → 7.3 | 4.0 → 4.1 | 11.3 → ≤ 11.4 (40 mobs: 13.4 → 13.5) | ≈ 7.6 | **G1: pass** |
| WebGL2 High | 16.7* → ≤ 17.0 (15.4–16.3) | 14.1* → 14.2 | 6.1 → 6.2 | 16.0 → ≤ 16.3 (14.8–15.7) | ≈ 14.7 | plaza at the line (*measured before cut 4, an upper bound) → G3; the rest G2 |

The adds in table 1 (CPU, main thread, dev PC):

| Part | Low | Medium | High (WebGPU) | High (WebGL2) | Ultra | Source |
|---|---|---|---|---|---|---|
| Sky | 0 | +0.03 (AE, IBL draws − the CPU cube) | **+0.1** (5 dispatches + UBO measured 0.09, + AE, − CPU cube) | +0.05 | +0.1 (WebGL2 fragment fallback: +0.2–0.3) | SKY2 §10.2 |
| Sea at the beach | +0.1–0.15 | **+0.4** (ocean ≈ 0.1 incl. the depth pre-pass, terrain ≈ 0.2, life ≤ 0.1) | +0.45–0.5 | ≈ +0.5 | +0.5–0.55 | COAST §8.11 table 1 |
| Sea elsewhere | ≤ 0.02 (the walk) with D19; ≤ +0.05 / 0.1 / 0.2 / 0.25 if the far sea is drawn | | | | | COAST §8.11 table 2 |
| Trees | 0 | **gate ≤ +0**; projected −0.3 to −0.7 | **gate ≤ +0**; projected −0.6 to −1.5 | same as WebGPU | as High | TREES §3.9 (F8) |

**Table 2: GPU adds by machine class** (the whole wave with the sea and trees in view, ms; the specs' own rows
summed [projected]):

| Preset | Dev PC | Mid desktop | Gaming laptop | Apple M1 (1080p) | M1 Pro+ | Parts |
|---|---|---|---|---|---|---|
| Medium | ≈ 0.35 | ≈ 0.5–0.55 | ≈ 0.65 | ≈ 2.3–2.5 (≈ 3.3 at Retina 0.75) | ≈ 1.0 | sky 0.04 / 0.06 / 0.07 / 0.27 / 0.12; ocean 0.1 / 0.15–0.2 / 0.2–0.25 / 0.7–0.9 / 0.3–0.4; shore ≤ 0.1 mid; trees ≤ 0.2 mid |
| High | ≈ 0.8 (+ GTAO's delta [unknown]) | ≈ 1.2 | ≈ 1.45 | ≈ 5.1–5.6 | ≈ 2.4 | sky 0.3 / 0.45 / 0.55 / 2.0 / 0.9; ocean 0.2–0.25 / 0.3–0.4 / 0.35–0.5 / 1.3–1.8 / 0.6–0.8; trees ≤ 0.3 mid |
| Ultra | ≈ 1.45 | ≈ 2.2 | ≈ 2.7 | ≈ 9.4–10.3 | ≈ 4.4 | sky 0.6; ocean 0.4–0.5 dev; trees ≤ 0.5 mid |

What the tables mean, honestly:

- **Medium, the default, has room on the dev PC** (≤ 14.5 ms at its worst, the WebGPU crowd). Its GPU adds are ≈ 0.35
  ms on a 1.5–1.7 ms GPU frame.
- **High stays CPU-bound, and this wave does not fix that.** The dev GPU does ≈ 3.1–5.1 ms of a 16–22 ms frame after
  wave 10. The sky adds ≈ +0.1 ms of CPU, the sea +0.5 ms only at the beach, and the trees are projected to remove
  0.6–1.5 ms where they stand. If the trees deliver, the plaza may approach the line (16.7–17.6 ms); the crowd will
  not (20.3–21.2 ms). High's pass is BACKLOG item 9.
- **The beach on High and Ultra is tight** (≈ 16.5 / 16.7 ms). G2 holds it: if LAB-10 measures a miss, the CPU-tagged
  cuts of §7 apply on that preset first (ships and flocks, positional surf emitters, the north-east coast's synthetic
  regions).
- **A base M1 on Medium at the beach projects to ≈ 12–17 ms of GPU** (COAST's 9.7–13.7 ms base at Retina 0.75 + ≈
  2.3–3.3 ms of wave 10), and its CPU is ≈ 1.3–1.5 × the dev PC's, which puts Medium's crowd (14.1 ms CPU p95 on the
  dev PC) near or over the line **already in wave 9** [projected]. The Mac levers (§7 cuts 20–21), the watchdog and a
  friend's Mac bench (§8 item 9) are the answer. The volumetric clouds are High-only, so a Mac on Medium never pays
  their 2 ms.
- **Draws.** The sky adds none to the scene (a few full-screen passes: AE 1, IBL ≤ 6 on a refresh frame, GTAO in
  SSAO2's place). The coast adds ≤ 17 (Medium) / 19 (High) at the beach and 0 elsewhere (D19). The trees remove most of
  theirs: all around the plaza 245 → ≈ 23 on Medium and 351 → ≈ 39 on High [projected, TREES F18], and must never
  exceed retail (G4).

**Table 3: VRAM and download** (texture VRAM measured in wave 9 at the plaza: Medium 851 MiB, High 985 MiB, Ultra
1,165 MiB on WebGPU [confirmed: budgets.md]):

| Preset | Sky | Sea | Trees | Wave-10 total | Download (first visit) |
|---|---|---|---|---|---|
| Low | 0 | ≈ 5 MB (field, Classic ocean) | 0 | ≈ +5 MB | the coast regions |
| Medium | + 0.1 MiB | ≈ +11 MB | ≈ +85–90 MB (96 px RGBA8; ≈ +25 MB with KTX2) | **≈ +100 MB (+12 %)** | ≈ +4–5 MB + the B-coast sets |
| High | ≈ +29 MiB | ≈ +17 MB | ≈ +85 MB at 96 px until KTX2 (150 MB at 128 px RGBA8, ≈ 40 MB at 128 px KTX2) | **≈ +131 MB (+13 %)** | + the cloud noise ≈ 7.3 MiB on first use |
| Ultra | ≈ +42 MiB | ≈ +33 MB (FFT 22 MB) | as High | ≈ +160 MB (+14 %) | as High |

[projected: SKY2 §10.2, COAST §8.11, TREES §3.7; plus at most one 16-layer growth of the 512 tile array for the coast
tiles, ≈ 22 MB per plane, COAST §8.11.] On an 8 GB Apple Silicon Mac the memory is shared with the system, so High
keeps 96 px impostor frames until TP-K's KTX2 covers them [decision].

### 5.3 Per-lane budgets (dev PC, 1080p; minimum of 5 runs; the GPU lock held; no other GPU page)

| Lane | Budget |
|---|---|
| S2-V clouds | High ≤ 0.3 ms GPU, Ultra ≤ 0.5 ms (the plaza at dusk, horizon in view, fair and overcast). CPU with S2-H: ≤ 0.09 ms per frame for dispatches and uniforms, target ≤ 0.06 ms after the UBO split and `fastMode`. Noise load ≤ 150 ms of main thread. A camera cut is sharp within 4 frames. |
| S2-H haze | Medium ≤ 0.03 ms GPU; High ≤ 0.1 ms (build + taps). +0 CPU per draw. Horizon seam ≤ 2/255 incl. overcast, rain and the sea at 2,000 m. Zero new varyings; zero new samplers on High. |
| S2-I IBL | ≤ 0.25 ms CPU on any refresh frame; ≤ 0.05 ms GPU per refresh; GPU SH within 2 % of the CPU SH; the live texture's `uniqueId` never changes. |
| S2-E exposure | ≤ 0.05 ms CPU, ≤ 0.03 ms GPU; no visible pump plaza → gate tunnel; < 0.5 EV beach → glint. |
| S2-A ambient | GTAO ≤ SSAO2's measured GPU + 0.1 ms; bounce ≤ 0.02 ms CPU; contact shadows ≤ 0.15 ms GPU (Ultra). |
| CST-O ocean | Low ≤ 0.1 ms GPU mid, ≤ 0.05 ms CPU, ≤ 2 draws. **Medium ≤ 0.2 ms GPU mid, ≤ 1.3 ms on an M1 at Retina 0.75, ≤ 0.1 ms CPU incl. the depth pre-pass; worker median ≤ 1.2 ms, p95 ≤ 1.6 ms per tick; upload ≤ 0.05 ms.** High ≤ 0.4 ms GPU mid, ≤ 0.15 ms CPU incl. 2 dispatches. Ultra ≤ 0.8 ms GPU mid, ≤ 0.25 ms CPU. No sea within the full-haze distance: no dispatch, no draw, ≤ 0.02 ms CPU, no active-mesh rebuild. |
| CST-S shore | ≤ +0.05 ms GPU mid inside the ocean draw; terrain wet band ≤ +0.05 ms; 0 draws; 0 varyings; lace ≤ 300 ms in the worker at load. |
| CST-C terrain | worst case +9 resident regions (Medium) / +11 (High) at the south-east corner: ≈ +0.2–0.25 ms CPU, +4–5 MB VRAM; never above the interior peak. |
| CST-A life | ≤ 6 voices; ≤ 0.3 MB download; ships and flocks ≤ 6 draws, ≤ 0.1 ms CPU. |
| **Coast total at the beach** | Medium ≤ +0.4 ms CPU p95, ≤ +17 draws; High ≤ +0.5 ms, ≤ +19 draws. |
| TR-F field | tree draws in view ≤ Σ bands (models + (model, tint) leaf sets) + 1; refill ≤ 0.1 ms at 1,600 instances, timed inside the frame; **total draws and tree caster draws ≤ retail's** at every bench scene; CPU per family ≤ +0 (`prof.js`). |
| TR-I impostor | ≤ 0.15 ms GPU on High (mid), 1 draw; the atlas array ≤ 40 MB with KTX2. |
| TR-W wind | ≤ +0.05 ms GPU; ≤ 15 user varyings on the Medium leaf material; no `COLOR_0`. |
| TR-A models | LOD0 ≤ 3,500 triangles, LOD1 ≤ 900; bounds ±10 %; glb ≤ 150 KB in `out-opt`. |
| **Whole wave** | §5.4. |

### 5.4 The gates (the 60 fps rule, D37)

Method: the wave-9 final gate's (production bundle, private `vite preview`, the GPU lock, 400 uncapped frames after
streaming idles, hardware scaling 1, time and weather pinned on the client). CPU comparisons use the **median of 5
runs' CPU p50**, wave 10 against the wave-9 release build (or the wave-10 features toggled off), same machine load:
one p95 cannot resolve 0.1 ms (budgets.md's same-config runs moved by more).

- **G1, Medium (hard).** Medium on WebGPU and WebGL2, at all seven bench scenes (the beach clear at noon and in a
  storm at night), with every Medium wave-10 feature on: p95 < 16.7 ms. **Nothing ships on Medium unless G1 holds.**
- **G2, passing stays passing.** Every High and Ultra scene, on either backend, that passed in wave 9 (p95 < 16.7 ms)
  still passes. The beach inherits the gate-storm scene's status (pass on WebGPU High and Ultra and on WebGL2 High). A
  feature that breaks it ships **off by default on that preset** (Options can turn it on), or is cut.
- **G3, failing not worse.** Where wave 9 already fails (WebGPU High and Ultra at the plaza and in the crowd; WebGL2
  High at the plaza, measured before cut 4): the wave-10 CPU is ≤ +0.1 ms over wave 9 (the method's resolution). The
  trees should make it negative. If it is above, the CPU-tagged cuts of §7 apply on High/Ultra only, in order.
- **G4, component gates.** The Low guard after every merge; the D16 guard (≤ 16 units, ≤ 15 user varyings) after
  every merge; no GLSL reaching WebGPU (network log: no request to `babylonjs.com`, no glslang); the horizon seam ≤
  2/255; tree draws and caster draws ≤ retail at every bench scene and tree CPU ≤ +0 per family; the coast total and
  the sky's CPU within §5.3.
- **Friends' machines.** Nothing is gated on a projection. If a friend's Mac bench on Medium misses 16.7 ms at the
  beach, the Mac levers (§7 cuts 20–21) apply before anything else, then a Retina render-scale step.

---

## 6. Lanes

### 6.0 Step order and concurrency

```
entry: the wave-9 release workflow has merged; this plan is approved
step 0 (parallel):   W10-S seams | S2-C noise export | CST-C phase 1 | TR-A tree tool + maple (+ Blender helper)
                     CST-M(conv) after CST-C's field; CST-B after CST-C's config schema and TR-A's helper
checkpoint X1 (lead): merge step 0; re-convert jangan-fields + optimize-out; run the sky export; `pnpm trees build maple`
step 1 (after W10-S merges; parallel, disjoint files):
   sky:   S2-V | S2-H | S2-I | S2-E | S2-A
   sea:   CST-O (spike, then the shore-seam commit) → CST-S | CST-A | CST-M(client) | CST-C phase 2
   trees: TR-F | TR-I | TR-W
   GPU queue (data, lock): CST-T B-coast | TR-B B-T1 sprites | B2/B3 as time allows
checkpoint X2 (lead): merge CST-C phase 2; re-convert
step 2 (after step 1 merges):  GAME-10 | LAB-10 | TR-B: B-T3 → prof.js check → B-T2 → B-T4 → B-T5 (after X2)
step 3:  I-10 (integration) → H-10 (hunt) → fixes → the §5.4 gates → the user's sheets
```

- W10-S and the step-0 data lanes touch disjoint files (world-render/game/viewer vs `packages/convert` and `content/`).
- **Soft data dependencies inside step 1** (no file overlap):
  - S2-H and S2-I bind W10-S's 1 × 1 fallbacks (no shadow, the 2.5D radiance) until S2-V lands; S2-V runs on
    GPU-generated noise until S2-C's files exist;
  - CST-O works on a synthetic field from its own test helper until X1; CST-S starts after CST-O's first commit
    (the composer that interpolates `SHORE_VERTEX/FRAGMENT`, empty); CST-A reads CST-O's CPU wave query (a stub until
    then);
  - TR-I codes against `sroHaze` (the wrapper), so S2-H's order does not matter; TR-F uses TR-A's maple from X1.
- **Capacity.** Step 1 has up to 13 agents. If fewer can run at once, run sky first, then sea, then trees (the merge
  order below), so the sea and the trees are judged under the final haze and IBL.
- Every lane runs `pnpm vitest run <its tests>` and `pnpm typecheck` before hand-off; nobody commits; the lead
  integrates. At most one browser tab per agent, closed when done.

### 6.1 The lanes

| Lane | Owns (creates or edits) | Uses (seams only) | Tests | User check | Depends |
|---|---|---|---|---|---|
| **W10-S** | §4 in full | — | §4.4 | nothing changes on screen | release merged |
| **S2-C** | `packages/convert/src/tools/export-sky.ts` (+ `cloud-shape.bin`, `cloud-detail.bin`, `sky.json` entries, a version hash) | — | periodicity; checksum stable across runs; coverage fractions; the files survive `optimize-out` (copied, `.br` written) | — | nothing |
| **CST-C** | `packages/convert/src/world/coast/**`, `content/coast/coast.json`, hooks in `convert-world.ts` (3 call sites) and `manifest.ts` (`WorldCoast`, `WorldRegion.synthetic`, `stream.playable` decoupled), `WORLD_PRESETS['jangan-fields'].coast`, `packages/convert/test/coast-*.test.ts`, one server test row (a character saved on the old S1 strip re-placed; the nest placed/skipped set unchanged) | — | COAST §12.1 list incl. the refresh rows (baked shadow along `BAKED_LIGHT_DIR`; palette tiles present with retail stems; C9 by uid); +5 m / Option A only (COAST Q10) | viewer: beaches and cliffs at the SE corner; compare `preview-A.png` | nothing unbuilt |
| **CST-B** | `packages/convert/src/tools/coast-blender.ts`, `packages/convert/tools/blender/*.py`, `packages/convert/test/coast-authored.test.ts` | TR-A's `runBlender`, CST-C's reader and validator | COAST §12.2 + every path absolute + the golden bundle hash | export an area, sculpt a cove, import, see it; brush once across the playable edge (§8 item 7) | CST-C schema; TR-A helper |
| **CST-M** | `coast/minimap.ts`, the `worldmap.ts` fill parameter (converter); the two `minimap.ts` fill sites (client) | `manifest.coast.mapColor` | change mask kept; sea tile colour; map size | press M: coast and sea on the map | CST-C |
| **TR-A** | `packages/convert/src/trees/**` (`blender/make_tree.py`, `blender/bake_impostor.py`, `build.ts`, `validate.ts`, `cli.ts`), `packages/convert/src/blender.ts`, `blenderExe` in `node-io.ts` and `sro.config.example.json`, `content/trees/species/*.json`, `content/trees/swap.json`, `optimize/run.ts` only if needed (D13); the root script `"trees"` is the lead's | the retail sprites and bark in the export | `trees-validate.test.ts` (TREES §5.2: caps, bounds, channels after the V decode, exactly `TEXCOORD_0..2`, no `COLOR_0`, LOD1 ±4 % of LOD0, leaves MASK + double-sided, every swap source in the manifest); `blender.test.ts` (relative paths refused) | `pnpm trees build maple`; the review sheet (retail \| LOD0 \| LOD1 \| impostor, 4 angles) | nothing |
| **S2-V** | `sky/volumetric/*`, the dome tier's cloud code (exported constants), the `SRO_CLOUDMAP` body in `sky/chunks.ts`, the map kernel (incl. the 2.5D writer on WebGPU High+), `sky/sky-system.ts` (D5: the occlusion readback) | `dispatchGpu`, `SkyState`, `cascadeInfo()` | SKY2 §13.2 (reprojection maths; Bayer 16/16; weather → coverage; NullEngine falls back to 2.5D; WGSL parses); the `yRef` lookup | clouds at 07:00, noon, 18:30, midnight, in rain; a fast orbit; a teleport | W10-S; S2-C (soft) |
| **S2-H** | `pbr/fog-plugin.ts` (this wave), `sky/haze-volume.ts`, `sroHaze` / `bindHaze` bodies, the dome's below-horizon and shaft code | chunk points (grass, water), `cascadeInfo()` | TS/shader parity within 1/255; horizon seam ≤ 2/255 (headless LUT) incl. overcast, rain and 2,000 m; no varying; High net 0 samplers | far hills at noon and dusk; shafts at 07:00; a storm; **the sea's horizon** (after CST-O merges) | W10-S |
| **S2-I** | `render/ibl-gpu.ts`, the `IblSource` switch in `render/lighting.ts` | the panorama or the 2.5D radiance | GPU SH ≤ 2 % of CPU SH; `uniqueId` pinned; a jump finishes in one frame; a late readback dropped | reflections on armour and wet ground under clouds; **no pop on a calm sea at a refresh** | W10-S |
| **S2-E** | `render/auto-exposure.ts` | `SkyState.exposure`, `RenderWeather` | ease, dead band, clamps, storm cap, flash freeze; the tap clamp (D25); the lamps' quantised steps | plaza → gate tunnel and back; lamps at night; beach → glint | W10-S |
| **S2-A** | `render/gtao.ts`, `sky/ground-bounce.ts`, `render/contact-shadows.ts`; three.js's notice if `GTAO.js` is ported | the prepass, `SkyState`, `World.coast.seaAt` | SH lobe maths; the sky-depth rule; SSAO2 fallback selection; `seaAt` → 0.06 over open sea | SSAO2 vs GTAO sheet; eaves and faces at noon; no sand-coloured underlight on a pier | W10-S |
| **CST-O** | `packages/world-render/src/ocean/*.ts`, `test/ocean-*.test.ts`, its `THIRD_PARTY_NOTICES.md` rows, the `World.coast` implementation (`seaAt`) | `sroHaze` (fog plugin), IBL, `sroCloudShadow`, `WeatherFrame`, `ensurePbrState()`, `RENDER_PRESETS.ocean` | COAST §12.4 incl. the fact-check rows (a `"matrix"` buffer and `cdlodNode` at a fixed node cap; `isVisible`, never `setEnabled`; never drawn at count 0; WGSL sampling scan; one varying; fog attached); **D19's far cut**; D18's reflection clamp | **Medium first**: swell and chop, storm build-up, moon glint, no horizon line, no bay-mouth seam; then High | W10-S; CST-C field (synthetic stand-in) |
| **CST-S** | `packages/world-render/src/shore/*.ts`, `coast/chunks.ts` (filled), `test/shore-*.test.ts` | CST-O's shore seam; `sroCoastWet`; field B | COAST §12.5 + the D16 guard with `sroCoastWet` (D22 fallback order) + no varying + the analytic bead | S1 at noon: waves, foam lace, swash, wet sand; storm run-up | CST-O's first commit |
| **CST-A** | `apps/game/src/audio/coast.ts`, the `COAST` area, the sound export entry, `apps/game/src/world/fx/{birds,ships,critters}.ts` | CST-O's wave query, the field | area switch with hysteresis; ≤ 4 emitters; paths over > 8 m water | surf and gulls grow louder; a ship in the haze | W10-S |
| **CST-T** | the B-coast batch config and review sheet (data): `tile2d:asiaminor_sand_01/02`, `oaho_dust_earth01` (wet sand), `alex_dust_05`, `rok_stone_01`, `c_stone_hmfld_02`, `oaho_dust_earth06` | texpipe runner; TX-R loads by `tile2d:<stem>` | the texpipe's index validation | review sheet; the sand does not tile from the camera | CST-C tile list; the GPU queue (D32) |
| **TR-F** | `packages/world-render/src/trees/{swap, tree-field, buckets, index}.ts`, its tests | the claim, the part slot, `addCasterSource`, `TREE_PRESETS`, `ObjectMaterials.convert` | TREES §5.2 TR-F row (bands, hysteresis, refill after 4 m, count-0 hidden with `isVisible`, group-3 at 48 m, `distance − radius`, `receiveShadows`, the draw formula with tints) | the plaza maples are new; walking away, LODs change without popping twice at one spot | W10-S; TR-A's maple |
| **TR-I** | `packages/world-render/src/trees/impostor.ts` (WGSL + GLSL) | `sroHaze`/`bindHaze`, `sroCloudShadow`, SH, key light | same keys and uniforms in both languages; hemi-oct round trip against the bake; NullEngine `isReady`; ≤ 15 user varyings | distant crowns within 10 % of LOD1 at the switch; no glslang request on WebGPU | W10-S; TR-A's bake |
| **TR-W** | `pbr/foliage-plugin.ts` (this wave: the VDATA branch; fills the cloud-shadow call per D20) | `sroWind` (weather chunks) | TS equals shader maths; `1 − v` decode; off without the material flag even with `uv2`; ≤ 15 user varyings on the Medium leaf material | in a storm branches sway with a lag and leaves flutter | W10-S |
| **TR-B** | `content/trees/species/*.json`, `swap.json` entries, `out/trees/*`, texpipe overrides for the leaf sprites | TR-A's tool; TP-U/TP-P; SDXL only on the user's go | the validator; LAB-10's bench after each batch | a review sheet per batch; in-game shots dry and wet, day and night | TR-A; B-T5 after X2 |
| **GAME-10** | `apps/game/src/settings.ts` (logic after W10-S's fields), `hud/options.ts` (Clouds, Auto exposure, AO method, Trees rows), `hud/perf-overlay.ts` (clouds, froxels, IBL slice, AE, ocean tick, tree field counters; GPU timing only while the overlay is open, SKY2 §3.2), the watchdog step (D29), `screens/world.ts` (tree mode, clouds option), `i18n/en-render.ts` | settings seams, world options | settings round trip; the watchdog steps clouds → 2D before High → Medium and changes no material define; the Trees row absent on Low | the Options rows read clearly in English | step 1 merged |
| **LAB-10** | `apps/viewer/src/world/{sky2-panel, trees-panel}.ts`, `apps/viewer/src/world/main.ts` (after W10-S), `apps/viewer/world.html` mounts, the beach and forest bench scenes, bench scripts in `work/tmp/w10-lab/`, `work/tmp/w10-lab/budgets.md` | everything | — | the screenshot sheets (§8) | step 1 merged |
| **I-10**, **H-10** | §6.4, §6.5 | | | | |

**LAB-10 delivers** (each with the GPU lock held and one browser tab): table 1 re-measured on the seven scenes, both
backends, every preset; the forest-spot baseline; the WebGL2 volumetric fallback's CPU (SKY2 §4.10); the froxel
history; the IBL passes and the no-pop check; SSAO2 vs GTAO; the AE tunnel walk and the glint pan; the ocean spike
results (mip route, depth pre-pass vs twin, D19); **`prof.js` after B-T1 and B-T3** (the tree CPU gate, TREES Q13);
a friend's Mac run if one is offered; the sheets for §8.

### 6.2 Merge order and checkpoints

1. Step 0: W10-S → S2-C → TR-A → CST-C phase 1 → CST-M (converter) → CST-B. Then **X1**.
2. Step 1: S2-V → S2-H → S2-I → S2-E → S2-A → CST-O → CST-S → CST-A → CST-M (client) → TR-F → TR-I → TR-W.
   - Sky first, so the sea and the trees are calibrated under the final haze and IBL.
   - After **every** merge: the Low guard, the D16 guard, `tidewater-notices.test.ts`, typecheck.
   - Then CST-C phase 2 and **X2**.
3. Step 2: GAME-10, LAB-10, the TR-B data.

### 6.3 Tests and gates (every lane)

- Its own tests, `pnpm typecheck` and the whole suite green at hand-off.
- The Low guard, the D16 guard and the notices test after every merge.
- Every plugin and ShaderMaterial ships WGSL and GLSL with the same injection keys.
- The GLSL-on-WebGPU guard in LAB-10 (no request to `babylonjs.com`, no glslang/twgsl).
- The §5.4 gates before the user's sign-off.

### 6.4 I-10: integration checklist (one agent, the lead)

1. Merge step 0; run the suite; record the test count. **X1**: re-convert `jangan-fields`, `optimize-out --only
   world/jangan-fields/`, the sky export (noise), `pnpm trees build maple`; add the root `"trees"` script.
2. Merge step 1 in the §6.2 order; guards after each merge. **X2**: CST-C phase 2, re-convert.
3. Merge step 2.
4. Server + two clients (WebGPU on localhost and `?engine=webgl`): `tp beach-south` (GM) lands on sand; walk into the
   water and stop at the bounds; a character saved on the old S1 strip logs in on the new sand; the nest log shows the
   same placed set and 91 skipped; `/time 18:30` and `/weather storm` reach both (clouds, haze, sea state and tree
   sway respond); world → char-select → world three times with no growth in storage textures, RT cubes, compute
   shaders, the ocean worker, the tree field's instances or the impostor array.
5. LAB-10's table against §5.4. Any miss goes to §7, applying only cuts whose tag matches the miss (WAVE_PLAN3's
   lesson: GPU cuts do not fix a CPU miss).
6. The screenshot sheets to the user (§8); record the answers in `work/tmp/w9-user-decisions.md` only as the user
   words them.
7. Deploy list (`deploy/config.sh`, lead-owned): `out-opt/trees/`, the sky `.bin` files, the re-converted world, and
   `THIRD_PARTY_NOTICES.md` next to the game files. The release note: "reload the page" (D36).
8. Docs: SKY.md and RENDER.md ("superseded by SKY2" notes, §4.2/§5.3/§5.5), WAVE_PLAN3 §6.20 (cut 1's VLS and cut 8's
   ring superseded), SKY2.md / COAST.md / TREES.md status lines, ASSETS.md (`out/sky/*.bin`, `out/trees/`, the coast
   field), DEPLOY.md (the notices file, the trees tree, the re-convert note, the HTTPS step), PROTOCOL.md (a one-line
   "wave 10: no change"), BACKLOG.md.
9. Delete the scratch the lanes have ported (§11).

### 6.5 H-10: adversarial-hunt lenses (merged and deduplicated from the three specs)

1. **Black frame on a 16-varying adapter** (`?gpuLimits=default` or the limit forced to 16): the ocean, the leaves (no
   `COLOR_0`, no instance colour), the impostor, the haze plugin, every define set.
2. **Texture units over 16 on WebGL2:** terrain with `sroCoastWet` and `skyView`, trees with the cloud map, the ocean.
3. **GLSL reaching WebGPU** (glslang/twgsl fetched): the impostor, the ocean, the IBL passes, the WebGL2 fallbacks.
4. **WGSL uniformity:** implicit-derivative taps in the ocean's vertex stage or in branches; every chunk.
5. **Low regression:** the guard; a Low world without a coast equals HEAD; with the coast only the data differs.
6. **Stale history and readbacks:** clouds after a teleport, a GM `time` jump or char-select; a froxel ghost at a cut;
   GTAO trails; a readback resolving after dispose; an `ae` NaN on a black frame; a late SH; a stale bind group after
   any in-place texture change.
7. **Hitches:** the noise load; an IBL slice, a cloud-shadow quarter, a tree refill or the sea upload on the same
   frame as a region commit (D28); a define changing with weather or time; the ocean's compute pipelines compiling
   after load.
8. **Leaks** over world → char-select → world (the open BACKLOG memory item).
9. **Double application:** fog twice on the ocean; exposure twice (the dome in output mode 0 + post); cloud shadow
   twice (map + noise, or map + key-light dimming); a retail tree drawn behind a new tree; two wet terms.
10. **Thin-instance traps:** a band or ocean mesh drawn once at the world origin (count 0 while visible);
    `setEnabled` churn rebuilding `EnabledMeshCandidates`.
11. **Seams:** the horizon strip (dome, fog, sea) at noon, dusk, fog weather and storm; a cloud shadow stopping at the
    waterline or stepping at the bay mouth; the froxel far slice against the dome; the cloud-map re-centre; region
    seams, the land/sea split, CDLOD cracks; tree LOD thrash at a band edge; an impostor seen from above.
12. **Surfaces outside the prepass read as sky:** the sea and the impostors under GTAO and contact shadows.
13. **Budgets:** tree draws or caster draws above retail at any bench spot; VRAM above §5.2 without KTX2; an IBL
    refresh frame above 0.25 ms; the coast total above §5.3.
14. **Flooding:** the sea over dry ground below the sea level (the town, the moat, the tomb foot, the east bound at z
    99–101).
15. **Converter and Blender:** determinism (re-convert twice, and after an import); edits inside the bounds; a moved
    border; stale bundles; 8-bit decoding; trees floating or buried on moved ground (C9) or on slopes.
16. **Reachability:** new walkable ground outside the home component; a route to the Western China component.
17. **Weather extremes:** full overcast at night; a flash; cover 0 (the trace exits); a storm swell under TAA; a wind
    shift (the cloud shadows turn first, the sea follows within about a minute: accepted).
18. **Readability:** a mob at 30 m in shafts at dusk and in a storm with fog; AE never touches the UI;
    `reduceFlashing`.
19. **Rain through canopies:** the shelter map misses the field's meshes.
20. **Licence:** a ported file without its header or missing from `THIRD_PARTY_NOTICES.md`; three.js's entry.
21. **Mac and Retina:** FSR1 and the post after it at the native 2,880 × 1,800 on WebGPU; Medium at Retina 0.75.

---

## 7. Scope-cut order (cut from the top)

The three specs' lists merged, **each spec's own order kept**, interleaved so the cuts that only touch Ultra or
optional extras go first, High's next, Medium's look last. Tags say what a cut saves: **[CPU]**, **[GPU]**,
**[VRAM]**, **[dl]** (download), **[time]** (build or art time). Apply only cuts whose tag matches the measured miss.

1. Contact shadows (Ultra). [GPU]
2. Caustics and opaque refraction (Ultra), if they were pulled in. [GPU]
3. Ultra's swaying tree shadows (blocked by the Babylon WebGPU bug anyway). [GPU, CPU]
4. Ground bounce v2 (per pixel); v1 in the SH stays. [GPU]
5. The 3-frame impostor blend (keep the nearest frame). [GPU]
6. The froxel temporal history (jitter off, fixed slices). [GPU, VRAM]
7. Ships, bird flocks and shore critters. [CPU]
8. Ultra cloud extras: the SDF skip, 6 → 4 light taps, detail ≤ 2 km. [GPU]
9. Ultra's ocean extras: the near-field detail and G 64. [GPU, VRAM]
10. SDXL-painted tree sprites (keep the upscaled retail sprites). [time]
11. Spray sprites and lingering whitecaps. [GPU]
12. GTAO → keep SSAO2. [GPU, time]
13. Shadows received on the sea (High+). [GPU]
14. The WebGL2 volumetric fallback (WebGL2 keeps 2.5D on every preset). [CPU]
15. The second model per tree family (one model, scale and rotation variety). [dl, VRAM, CPU]
16. The GPU FFT (High and Ultra use the worker tile). [GPU, time]
17. The froxel shafts → High and Ultra use Medium's analytic haze. [GPU, VRAM]
18. Impostor normal atlases on Medium, then 96 px frames everywhere. [VRAM]
19. The cloud panorama (the IBL uses the 2.5D cloud function). [GPU]
20. **Mac lever 1:** the lace texture on Medium (the foam band and the bead stay). [GPU]
21. **Mac lever 2:** Medium's CDLOD G 16 → 8 with 6 levels. [GPU]
22. `SRO_FOL_VDATA` (keep the height bend and the world-position flutter). [GPU]
23. Auto exposure on Medium (High keeps it). [CPU]
24. The animated swash and the shore swell (keep the static wet band and the foam band). [GPU]
25. Positional surf emitters (keep the area ambience). [CPU]
26. The B-T5 and B-T4 families stay retail. [time]
27. Volumetric clouds on High → Ultra only (High keeps 2.5D + the cloud-shadow map). [GPU, CPU]
28. Low's Gerstner waves (Low keeps the retail water animation on the ocean mesh). [GPU]
29. Paint inside the bounds (the sand starts at the bounds line). [time]
30. The impostor band (LOD1 to the range). [VRAM]
31. Auto exposure entirely. [CPU]
32. The north-east coast (keep east and south). [CPU, time]
33. The PBR ocean on Medium → the Classic ocean with field depth. [CPU, GPU]
34. *Ask the user first:* phase 2 (the west, north-west and Option A's corridor).
35. *Ask the user first:* the walkable beach → look-only.

Dropped from TREES' list: its cut 3, the dithered LOD cross-fade, which is not in v1 (D24).

**Never cut:**

- the Low guard, and "no protocol change";
- the sky-coloured haze on every PBR preset with the horizon seam test; the GPU IBL; "no new scene draws" for the sky;
  the 2.5D clouds as the fallback everywhere;
- the frozen playable area, determinism, region seams, the sea mask (no inland flooding), the Blender export and
  readback with validation, the fog-matched horizon, the one-varying rule;
- the tree swap keyed by the retail source (placements, nav and ranges unchanged), the per-model instancing, LOD0 and
  LOD1, the maple, "draws ≤ retail", "casters ≤ retail", the tree CPU gate, and no varying on any tree material;
- no GLSL on WebGPU; `THIRD_PARTY_NOTICES.md` with every ported file;
- G1 (Medium at 60 fps everywhere).

---

## 8. What the user must provide or approve

**To start wave 10: nothing.** Every tool is installed (Blender 5.2.2, the upscaler, ComfyUI + SDXL, basisu and the
KTX2 transcoder); nothing is downloaded and nothing is uploaded; no Meshy credits are spent. Each item below has a
default, so nobody waits.

1. **HTTPS, so anyone can see the High sky and sea** (D34). The volumetric clouds, their shadows, the sun shafts and the
   GPU-FFT sea run only on WebGPU at High or Ultra, and every friend is on WebGL2 until HTTPS. Needed from you: in the
   Tailscale admin console, turn on MagicDNS and **HTTPS Certificates** (a one-time switch), and say yes to Claude
   running `tailscale serve --bg http://<SERVER_TAILNET_IP>:7000` on the mini PC (DEPLOY.md). *Default: do it during wave
   10.* Without it, Medium players still get the haze, better reflections, auto exposure, bounce light, the Medium sea
   and the new trees.
2. **How to read "at least 60 fps" for High.** High on WebGPU already misses 60 fps at the plaza and in crowds (wave 9,
   CPU). *Default (G3): High keeps its new features if those busy scenes get no worse (the new trees are expected to
   pay for the sky and the sea there).* The strict alternative: High gets no wave-10 feature until the performance
   pass makes it pass. Medium must hold 60 fps everywhere either way.
3. **Volumetric clouds on High (WebGPU) and Ultra only**; Medium and WebGL2 High keep today's clouds. *Default: yes.*
4. **Downloads for players:** the cloud noise ≈ 7.3 MB for a friend who picks High or Ultra (a 1.4 MB softer variant
   exists), and ≈ +3.2 MB net for the new trees on Medium+. *Default: accepted.*
5. **Look picks from screenshot sheets** (LAB-10 sends them; each has a default):
   - the clouds: temperate cumulus with a stratus deck in rain (default), or taller Tidewater-style towers;
   - the haze strength: keep today's visibility (default), or thinner;
   - AO: GTAO if it is no slower (default), or SSAO2;
   - auto exposure: on, ±1 EV High and ±0.5 EV Medium (default), judged walking into the gate tunnel;
   - **the coast on Medium** (the south beach and the Tiger cliffs at noon, dusk, night and in a storm, High beside
     it): ships on a "looks okay" (default);
   - **the maple** (`work/tmp/trees/overview.png`): go ahead with a slightly warmer crown (default), plus one sheet per
     tree batch; crowns without the inner-leaf darkening the prototype had (it breaks some GPUs); if they look flat,
     a darker sprite row is added.
6. **Trees:** route (d), our Blender script with the retail leaf sprites (default: yes); upscaled retail sprites, SDXL
   only for a family you flag; no Meshy credits; Low keeps the retail trees; same sizes and places as retail; the
   family order maple → broadleaf/bamboo/willow/ginkgo → pines → the rest, Dunhuang after the west coast. (This moves
   TREES' third batch up: it holds the skinned trees where the CPU saving should be largest, so it is measured before
   more art is made, as TREES' own fact-check asks.) *Defaults as listed.*
7. **One interactive Blender check** (about five minutes, at the first hand sculpt): brush across the edge of the
   playable area and see that the masked side does not move. Headless sculpting crashes Blender 5.2.2. *Default: until
   then Claude edits by script and the validator rejects any in-bounds change.*
8. **GPU time** for the local B-coast textures and the tree leaf sprites (upscaler, maps, the SDXL step through
   `start_comfyui.sh`), one reviewed batch at a time, never beside other heavy GPU work. *Default: it runs when the GPU
   is free.*
9. **Optional: a friend's Mac** for one bench run on Medium at the beach. *Default: ship on the dev PC's numbers; the
   watchdog and the Mac levers cover a slow Mac.*
10. **A coastal tree species** (wind-bent pines on the cliffs)? *Default: no; retail trees on the coast are re-snapped
    or dropped, and the new models follow automatically.*
11. **Blender MCP:** not needed. *Default: not installed.*

---

## 9. Risks

| Risk | Tag | Mitigation |
|---|---|---|
| High stays CPU-bound; the wave cannot make it pass | [confirmed: budgets.md] | G3; BACKLOG item 9; the trees are the one CPU win in this wave |
| The trees' CPU saving does not appear (the prototype's first A/B leaned worse) | [confirmed: TREES F7] | `prof.js` after B-T1 and B-T3 before more art; ship only families that measure ≤ +0 (TREES Q13) |
| The beach on High/Ultra lands just over 16.7 ms | [projected: 16.5 / 16.7] | G2; CPU-tagged cuts 7, 25, 32 on that preset |
| A base M1 on Medium at the beach reaches 12–17 ms of GPU; Medium's crowd is near the line on its CPU already | [projected] | Mac levers (cuts 20–21), the watchdog, a friend's bench |
| One more varying black-frames 16-limit adapters at Medium | [confirmed: gpu-guards.ts, TREES F1, COAST R6] | D23; the D16 guard after every merge; H-10 lens 1 |
| WebGL2 texture units: terrain High is 16/16 and `sroCoastWet` wants one more | [confirmed: SKY2 F5, COAST F16] | D22 fallback order; the D16 guard decides |
| The live IBL cube shows a mix of levels for 7 frames | [projected] | LAB-10's no-pop check on a calm sea; a third cube + copy as the fallback |
| Babylon plumbing traps (thin instances at count 0, `setEnabled` churn, the transparent depth pre-pass re-running the material) | [confirmed: 9.28 source; cost projected] | tests in CST-O and TR-F; the ocean spike picks the pre-pass or the twin |
| W10-S is a large single agent (merge risk concentrated) | [likely] | the Low guard, the D16 guard and `world-parts.test.ts`; every hook empty or off; no other lane touches those files |
| The D19 far cut shows a line where the sea stops | [projected: invisible by the S-HORIZON contract] | the horizon strip test; fallback the far plane |
| Impostor VRAM on 8 GB Macs | [projected: +85–150 MB] | 96 px frames until KTX2 covers them (§5.2) |
| Tidewater was read through a summarising fetch for parts of SKY2 | [likely] | each lane re-reads its file at `4811ba4` before porting (SKY2 §12) |
| A re-convert while another lane writes `work/out/world/` | [likely] | X1/X2 are lead checkpoints with nothing else writing there |
| Nobody sees the High features without HTTPS | [confirmed: DEPLOY.md] | §8 item 1 |

## 10. Open questions (each has a default, so nobody waits)

| # | Question | Default | Who settles it |
|---|---|---|---|
| Q1 | Does the WebGL2 volumetric fallback run on High? | Off; on only if LAB-10 measures ≤ +0.25 ms CPU at the plaza | LAB-10 |
| Q2 | Noise delivery: files, or GPU generation on WebGPU | Files for both backends | S2-C |
| Q3 | The froxel far distance | 320 m fixed | S2-H |
| Q4 | GTAO ambient-only vs a colour multiply | Multiply (as SSAO2); LAB tries ambient-only on Ultra | LAB-10 |
| Q5 | The IBL refresh on High | ≥ 3 s with the 0.5° key | S2-I |
| Q6 | Keep the CPU cube code | Yes, as the NullEngine and test reference | S2-I |
| Q7 | Cloud shadows on High objects and trees | No until the D16 guard shows a free unit; then LAB judges | LAB-10, D16 |
| Q8 | Which spare channel carries `sroCoastWet` on High terrain | D22's order; CST-S's test decides | CST-S |
| Q9 | The FFT mip route | CST-O's spike; per-layer `generateMipmaps` ruled out; no mips if the raw helper fails | CST-O |
| Q10 | `needDepthPrePass` or a depth-only twin for the sea | The cheaper on the main thread; the twin above 0.05 ms | CST-O |
| Q11 | Triplanar on cliff cells on Medium | No; retail cliff rocks and a Blender pass; revisit only if the sheet shows stretching | LAB-10, the user |
| Q12 | Swash run-up height | Ours (`0.15 + 0.25·Hs`, ≤ 0.8 m), tuned on S1 | LAB-10 |
| Q13 | Swell direction | From the open sea to the south-east | CST-C, LAB-10 |
| Q14 | Motion vectors for the sea under TAA | None unless LAB sees crest ghosting | LAB-10 |
| Q15 | Ships, flocks and critters in wave 10 | In; cut 7 | — |
| Q16 | Later shore upgrades (breakers, surf simulation, caustics) | After the beach playtest | the user |
| Q17 | Tree LOD distances and the per-model impostor edge | TREES Q1 defaults, tuned in LAB | LAB-10 |
| Q18 | Tree tints | One leaf mesh per (model, tint) and band; no instance colour | TR-F |
| Q19 | Per-instance frustum culling for trees | Off unless it saves vertices for < 0.05 ms | LAB-10 |
| Q20 | Does `optimize-out` already handle `out/trees/**` | Unknown; TR-A checks first and edits `optimize/run.ts` only if needed | TR-A |
| Q21 | A lighter volumetric option on Medium WebGPU (64 steps, 3 taps) | Not built; revisit after HTTPS if friends ask | the user |
| Q22 | `WorldInfo.exportId` for stale pages | No; restart + reload note | I-10 |
| Q23 | The black terrain patches TREES' headless lab saw (fields, grassland) | Not a wave-10 issue; LAB-10 re-checks them on the released build at X1 | LAB-10 |

## 11. Housekeeping

- Scratch stays until its port lands, then I-10 deletes it: `work/tmp/sky2/` and `work/tmp/sky2-fc/` (after S2-V,
  S2-H and LAB-10), `work/tmp/coast/` and `work/tmp/coast-refresh/` (after CST-C, CST-B and CST-O; keep the approval
  images until the user's coast sheet), `work/tmp/trees/` (after TR-A and TR-F; keep `overview.png` until the maple
  go/no-go), `work/tmp/plan4/`.
- `work/tools/gpu.lock`: only its creator removes it; LAB-10 timings, the texture batches and SDXL all take it (D32).
- No lane commits; the lead integrates each step, as in waves 7B, 8 and 9.
