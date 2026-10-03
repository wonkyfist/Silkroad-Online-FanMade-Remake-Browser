# Static batching and instancing (the next wave, item 1)

**Status (wave 10r, built 2026-10-01):** built as BT-A, BT-M, BT-P, BT-C, BT-S, BT-T and BT-L (BT-K, the Classic batch, was cut: Low stays as it is). Table-mode region batching is on by default on the PBR presets (Medium and up; Options → Graphics → Advanced → World batching). The measured budgets are in `work/tmp/w10r/budgets.md` (LAB-10R). Where docs/WAVE_PLAN6.md decides differently (D3, D15), the plan wins.

The user's item 1: "Make all tree's, town building's, and grass a single draw call. Lets increase performance."
It was explained to the user as instancing and merging down to a handful of draws per area, with the plaza going
from ~700 draws to well under 100. This spec designs that, and reports a prototype built on the real renderer and
the real jangan-fields export, measured on the dev PC.

- §1: how objects are loaded and drawn today, and where the plaza's draws and CPU time go (measured);
- §2: the targets, and what the prototype reached;
- §3: the design: region batches on an "array material" (a material table, atlas arrays for albedo and
  normal/roughness/AO, a lightmap array), trees made static and merged with shader wind, the grass contract, what stays
  separate, culling, shadows, weather, night lights, WebGPU snapshot rendering, and the Low path;
- §4: the prototype, its numbers, its look, and the bugs it found;
- §5: budgets per preset (WAVE_PLAN3 §5.2 format);
- §6–§10: lanes, scope-cut order, risks, what the user must approve, open questions.

This is design only. Code, content and deploy files are untouched. The prototype, its scripts and all images are in
`work/tmp/batching/` (the lab in `lab/`, raw shots and result JSONs in `shots/`).

**Tags.**

- **[confirmed]**: checked in the code, the data or a measurement, and the section says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement, not measured on that setup.
- **[unknown]**: open; a default is given.
- **[decision]**: a choice this spec makes.

**Sources read.** docs/BACKLOG.md, docs/WAVE_PLAN3.md (§5 presets and budgets, the lane format), docs/RENDER.md,
docs/COAST.md, docs/TREES.md (inventory, tree field), docs/MOVEMENT.md, docs/SCREENS.md, docs/GRASS_LIFE.md (being
written in parallel; read for its draw count), `work/tmp/w9-finish/budgets.md`, `work/tmp/w9a-perf/`,
`work/tmp/w9-user-decisions.md`. Code at the working tree of 2026-09-29: `objects.ts`, `materials.ts`, `stream.ts`,
`region-chunk.ts`, `model-cache.ts`, `scatter.ts`, `textures.ts`, `pbr/surface-plugin.ts`, `pbr/foliage-plugin.ts`,
`pbr/maps.ts` (TX-R `applyMapRecord`), `render/shadows.ts`, `render/active-meshes.ts`, `weather/index.ts`, apps/game
picking (`screens/world.ts`, `world/jangan/ground.ts`), and Babylon 9.28 in `node_modules`
(`materialPluginManager.pure.js`, the PBR WGSL/GLSL includes, `snapshotRenderingHelper.d.ts`). The release workflow is
editing the code; hooks are named by their code, not their line numbers.

**Fact-check (2026-09-29, adversarial pass).** Every [confirmed] claim was re-derived from the result JSONs
(`shots/final_*.json`, `snap_*.json`, `ab_*.json`), the lab code, the repo code, Babylon 9.28 and the export's data.
No new GPU timings were taken: the GPU lock was held by another lane during this pass. The re-derivation scripts and
images are in `work/tmp/batching/factcheck/`. What changed (the text below carries *(fact-check Fn)* marks):

| # | Claim | Finding | Where |
|---|---|---|---|
| F1 | "render-list and prepass setup 4.0 ms"; the saving includes "fewer items to sort and bind (−2.9 ms)" | **This cost does not exist.** The lab installed `prof.js`'s observers twice (`batching-lab.ts`: `P.scene = null; P.install(scene)`, and `install` never removes the first set). The duplicate `rtt1` event shifted the pair counter, so the "prepass/before draw" segment runs from the scene-level RTT end to the draw phase. It therefore spans active-mesh evaluation, the shadow map and before-clear. In every run of every final JSON that segment equals eval + shadow + clear to within 0.01–0.03 ms. With it removed, the segments add up to the CPU mean to within 0.03 ms, and the "camera RTTs" key is missing from every run **[confirmed: `factcheck/` script over `final_*.json`]**. The real split at the plaza (High, WebGPU, mean of 3) is main draw 8.5, active-mesh evaluation 3.1, animations 2.3, shadow map 0.8, the rest 0.7 = 15.3 ms. Batched it is 2.2 / 0.6 / 0.0 / 0.4 / 0.5 = 3.7 ms. The saving is −6.3 / −2.5 / −2.3 / −0.35 / −0.2. | §0, §1.2, §4.5 |
| F2 | "94 main (… 38 batches)" | 28 batches, plus 1 sky: 35 + 11 + 7 + 12 + 28 + 1 = 94 **[confirmed: `mainBy`]** | §0 |
| F3 | Every row is a "median of 3 rounds" | The gate ran 2 rounds per state. The "median" is the higher of the two. | §0, §4.2 |
| F4 | Medium GPU "n/a → 1.1" | Today's Medium produced a counter in one round, 1.6 ms. | §0, §5 |
| F5 | Snapshot rendering was "measured on the batched plaza" | It was measured on the earlier 226-draw state (147 main: per-model trees), not the final 166 **[confirmed: `snap_*.json` draws]** | §3.11 |
| F6 | Atlas VRAM "+10 to +35 %" with square cells (Q5: "a stretched square cell in v1") | Of the 713 unique object textures in jangan-fields, **53 % are not square** (128×512 ×204 uses, 128×256 ×176, 256×512 ×142, …). Square pow2 cells need **2.07× the texels**; rectangular pow2 cells need 1.00×. The 445 glbs embed **1,348 images of which only 713 are unique**. Today's object textures are ≈ 393 MiB if every image were resident (RGBA8 + mips, no dedupe [likely]). A content-deduped atlas with rectangular cells is ≈ **189 MiB for the whole world**. Square cells without dedupe would be ≈ 810 MiB **[confirmed: WebP headers of every embedded image; MiB are arithmetic]**. Rectangular cells and dedupe are now the design (Q5 flipped). | §3.2, §5, §7, §10 |
| F7 | A 128² lightmap array (+ a 256² one) | The prototype's array held **450 layers**, and all of jangan-fields' lightmaps would need 577. WebGPU's default `maxTextureArrayLayers` is 256, and 256 is also GLES 3.0's minimum `MAX_ARRAY_TEXTURE_LAYERS`. It worked only because the engine requests the adapter's maximum limits (`apps/game/src/engine.ts` 'max'); `?gpuLimits=default` would break it. **Fix:** one 256²-layer array, with a 128² or 64² lightmap in a quadrant. That is 52 + ⌈525/4⌉ = **184 layers for all 577** and one sampler instead of two. | §3.2, §3.3, §7 |
| F8 | Samplers "+4 per merged material" | The prototype's group material still bound the representative's `albedoTexture` and a (white) `lightmapTexture` (the ALBEDO/LIGHTMAP defines and the UV varyings hang on them). That is 6 units, against 5 for today's heaviest object material (albedo, bump, ORM, opacity, lightmap), and WebGL2 has 16. Production binds **no per-material 2D map**: `SRO_TABLE` sets UV1/MAINUV1/UV2/MAINUV2 itself, which gives 4 units, one fewer than today's heaviest [projected]. The prototype's WebGL2 run had weather off and noon, so no shelter, wet maps or cluster were bound. | §3.4 |
| F9 | Night lights: "the listener keeps receiving placements, with the batch meshes as `meshes`" | `night-lights.ts` `lampMaterials` **mutates `mesh.material.emissiveColor`** for lamp models and for night-owner models' `/light/` materials, per material and per kind colour. Handed a batch mesh, it would light a whole group. It must write the slot's emissive in the table. NL was not in any lane's files. | §3.7, §3.10, §6 |
| F10 | (implicit) listeners unchanged | `ShadowProxies.placed` merges the `meshes` it is given (`mergeInstances`) into the opaque proxy, and the weather listener marks the shelter dirty from `meshes[0]`'s box. A claimed region needs a defined listener contract, or trees and cut-outs end up in the opaque proxy. | §3.1, §6 |
| F11 | Draw ranges from the preset | `WorldObjects.setRangeScale` changes at run time: SCREENS' create screen sets 0.6, and Options' sight multiplies `drawDistance` (`settings.ts` `SIGHT_MUL`). The prototype read `QUALITY_PRESETS[…].drawDistance` once. The batcher must follow `setRangeScale`. | §3.8, §3.14, §6 |
| F12 | Low unchanged | A live Low ↔ Medium switch runs `World.setRenderMode` → `stream.rebuild()` (`graphics.ts` `apply`). The batcher must release every region on PBR → Classic and claim again on Classic → PBR. Retail textures freed after packing must be decoded again for Classic. | §3.2, §3.12, §6 |
| F13 | BT-C owns `packages/convert/src/world/` | COAST's CST-C edits `convert-world.ts` and `manifest.ts` in this wave too. The manifest field was named `staticOf` in §3.5 and `staticVariant` in §6; it is now `staticVariant`. | §3.5, §3.14, §6 |
| F14 | A/B: "mean abs difference 5.2/255, 5 % of pixels over 16/255", shots "at the same moment" | MAD 5.1/255, **7.5 %** over 16/255 (WebGPU High), 7.6 % on WebGL2 High, 5.2 % on Medium. On the (unbatched) pavement there is also a uniform **+1.7–2.6/255 brightening** at the plaza (the lower half of the image) but not at the gate (MAD 0.33); its cause is [unknown] (IBL probe capture or SSAO). The two shots are sequential in one page, ≥ 4 s apart (`quiet()` + a frame), not simultaneous **[confirmed: `factcheck/` diff]**. | §4.3, §4.4 |
| F15 | The gutter shrinks cells by "1.5–3 %" | It is `max(2, s/64)` per side: 3.1 % for cells ≥ 128, 6.25 % at 64 and 12.5 % at the 32 minimum (`buildings.ts` `put`) | §3.13 |
| F16 | Groups per region "11–13 → 2–6" | Before unify, up to 15 (`ab_webgpu_high_plaza.json`); after unify 2–6 for buildings; with trees merged, **2–9** per region | §3.1 |
| F17 | The lab's "today" equals the game's | On High, yes (15.1 vs 15.2 ms). On Medium the lab took **11.0 ms for 337 draws**, while the final gate took 9.5 ms for 450. The lab ran ≈ 1.5× slower per draw, so subtracting the lab's absolute saving flatters the game. §5 now projects with the lab's **ratio** on the world part, and the numbers still hold. | §1.2, §5 |
| F18 | §5 "CPU p95, game" | The values (17.9, 21.5, 11.4 …) are budgets.md's **frame** p95 | §5 |
| F19 | Budgets | WebGL2, which **every player uses until HTTPS**, had no game projection. Added. | §5 |
| F20 | "A mid desktop CPU puts High at ≈ 11–13 ms" | That holds at the plaza. In the 20-mob crowd, CPU ×1.5–2 (mid desktop, gaming laptop) gives **≈ 15–21 ms: borderline**. Characters stay outside this item. Medium (the default) stays ≤ 14 ms. | §5, §8 |
| F21 | GPU lock "[confirmed: `work/tools/gpu.lock/owner`]" | Cannot be re-checked: the lock was released and is now held by another lane (grass-life, 22:58). Retagged as reported. | §4.1 |
| F22 | "42 lamp meshes / 14 unlit / 8 blended at the plaza" | Those are counts over the **resident set** (29 regions, `skipped`). The plaza's main pass draws 12 such pieces. | §3.7 |
| F23 | NRAO = normal xy, roughness, AO | TX-R's ORM B (metal) becomes a per-slot constant: a look difference on metal-mapped sets | §3.13 |
| F24 | "well under 100" | High with GRASS_LIFE lands at ≈ 95–100 in total (≈ 80–85 world + 13 post) in the lab view, which has no NPCs. The game frame adds characters (≈ 8 draws per mob: 858 − 698 for 20). "Well under 100" holds for **world** draws. | §2, §9 |

Also re-derived and **confirmed**:
- all draw counts, active meshes, casters and GPU medians;
- the segment means (8.5 / 3.1 / 2.3 → 2.2 / 0.6 / 0.0);
- the lightmap histogram (490 / 51 / 35 / 1);
- lightmap UV2 inside **[0.03, 0.97]** on all 577 lightmapped primitives (`work/out` glbs), so `floor(uv/2)` packing has margin;
- no placement scale (so nothing is mirrored);
- +19.0 % triangles from two-sided duplication (136,185 → 161,990);
- 507 k triangles, and a 218 ms merge for 29 regions;
- the injection-point order (`_codeInjectionPoints` insertion order in `_injectCustomCode`);
- `GROUP_RANGE_M`, `CHUNK_M`, `ANIMATE_RANGE_M`, `drawDistance` 0.6 / 1 / 1.4 / 1.4, `foliageM` 0 / 60 / 60;
- `LAMP_MODEL`, TX-R `directIntensity = 0.8` and the ORM layout;
- `pick` being nav + terrain only;
- the 16-varying budget (`abuse-w9f-blackframe.test.ts`: a lightmapped CSM receiver = 15 + `front_facing`);
- `updateTextureData` with offsets on both engines, and `texSubImage3D` per layer and level already used in `textures.ts`.

---

## 0. Summary

1. **Where the draws come from** [confirmed: lab, §4]. At the plaza on High (WebGPU, 1080p, no characters), today's
   renderer issues **572 draws a frame: 467 in the main pass, 92 in the sun shadow map, 13 post passes**. Of the main
   pass, **244 are building and prop chunks** (one thin-instance mesh per region × model × primitive), **199 are
   skinned tree clones** (one per placement × primitive), 35 are grass scatter chunks, 29 are static trees and plants,
   the rest terrain, water and sky. The CPU frame is **15.1 ms p50 / 17.0 ms p95** (mean 15.3 ms): main-pass
   submission 8.5 ms, active-mesh evaluation 3.1 ms, skinned-clone animation 2.3 ms, the shadow map 0.8 ms, everything
   else 0.7 ms *(fact-check F1: the "render-list and prepass setup 4.0 ms" of the first draft was active-mesh evaluation
   and the shadow map counted twice)*. GPU is 3.3 ms. It is a CPU problem, as wave 9 found.
2. **The design** [decision]:
   - **Region batches.** At region commit, every static object of a region is merged into world-space meshes, one per
     (LOD group, opaque | cut-out, cloth sheen): about **2–6 meshes per region** for buildings and props, and 2–3 for
     trees. Built in a worker, off the main thread.
   - **The array material.** All retail materials become **slots in one global material table**. The albedo (with its
     cut-out mask) and, when TX-R has a map set, the normal + roughness + AO are packed into **atlas arrays** (1024²
     pages on every PBR preset, **rectangular** pow2 cells deduped by content, wrapped with `fract()` and a gutter,
     sampled with explicit gradients). The per-object lightmaps go into **one 256²-layer lightmap array** (128² and
     64² lightmaps in quadrants; ≤ 256 layers) *(fact-check F6/F7)*. A vertex carries only (slot, lightmap layer). The
     class parameters (roughness, metallic, porosity, puddles, direct intensity, cut-off) and NL's lamp emissive come
     from the table, so one material draws every class. The group material binds 4 object samplers and no 2D map
     (F8).
   - **Trees.** The 18 skinned tree models are **baked static in the converter** and get the foliage plugin's shader
     wind, like the static trees; all trees then merge per region like buildings, with a **per-vertex pivot** (the
     instance origin) for the wind. Per-model instancing is the measured fallback.
   - **Grass** (GRASS_LIFE's lanes): ≤ 3 ground-cover draws + ≤ 3 wildlife draws in any view, no casters.
   - **Separate on purpose:** water, lamps (night emissive), unlit glows, alpha-blended pieces, animated flags and
     other skinned props, characters, effects.
3. **The prototype** [confirmed: `work/tmp/batching/lab/`, §4]. It merged the resident regions' buildings, props and
   trees on the live World (the real export, the real PBR renderer with sky, CSM, SSAO, TAA, bloom), with the same
   look (same-page A/B screenshots, §4.4). Medians of 3 in-page A/B rounds (2 at the gate, F3), 300 uncapped frames
   each, GPU lock held:

   | Scene, preset, backend | Draws (today → batched) | CPU p50 / p95 ms (today → batched) | GPU ms (today → batched) |
   |---|---|---|---|
   | Plaza, High, WebGPU | **572 → 166** (main 467 → 94, shadow 92 → 59) | **15.1 / 17.0 → 3.5 / 5.0** | 3.3 → 2.4 |
   | Plaza, Medium, WebGPU | **337 → 87** | 11.0 / 13.0 → 1.3 / 2.4 | 1.6 (1 of 3 rounds) → 1.1 |
   | Plaza, High, WebGL2 | 572 → 166 | 14.3 / 17.7 → 1.4 / 4.8 (GPU-bound at ~390 fps [likely]) | — |
   | Plaza, Medium, WebGL2 | 337 → 87 | 9.7 / 11.1 → 0.9 / 1.2 | — |
   | South gate, High, WebGPU (2 rounds) | 431 → 150 | 15.1 / 17.6 → 4.2 / 6.2 | 3.1 → 2.3 |

   Medium is under 100 draws already. High's remaining 166 are 94 main, 59 shadow and 13 post. The 94 main are 35
   retail grass chunks, 11 terrain, 7 water, 12 lamps/unlit/blended pieces, **28** batches and 1 sky *(fact-check F2)*.
   With GRASS_LIFE's 3 + 3 draws, lamps merged per region and the terrain folded into the shadow proxies, the plaza on
   High projects to **≈ 95–100 draws in total, ≈ 80–85 of them world geometry** [projected, §5]. That is before
   characters, which this item does not touch (F24).
4. **The CPU saving is larger than the draw ratio** (draws ÷ 3.4, CPU ÷ 4.3) [confirmed: segment timings, corrected
   in F1]:
   - fewer draws: main submission −6.3 ms;
   - 5.7× fewer active meshes to evaluate: −2.5 ms;
   - no skinned animation: −2.3 ms;
   - fewer shadow draws: −0.35 ms;
   - the rest: −0.2 ms.

   Projected into the game with the lab's *ratio* on the world part (F17), High goes from **17.9 ms frame p95 at the
   plaza and 21.5 ms in the crowd** to **≈ 6–9 ms and ≈ 10–12 ms** [projected, §5]. So High holds 60 fps on the dev
   PC with room for wave 10's sky and sea. On a mid desktop or gaming-laptop CPU the crowd stays borderline (F20).
5. **Not recommended now: WebGPU snapshot rendering** [confirmed: measured, §3.11, on the earlier 226-draw batch state
   (F5)]. After batching, its STANDARD mode is slower (3.7 → 4.6 ms). FAST mode (1.8 ms) freezes material uniforms and
   the draw list, and raised WebGPU validation errors while recording. Batching gets most of the win without those
   constraints.

---

## 1. Today [confirmed: read in the code, measured in the lab]

### 1.1 How objects are loaded and drawn

- **Static models** (`objects.ts` `placeStatic`, via `region-chunk.ts` `placeModel` → `WorldObjects.addStatic`): per
  region, LOD group and (group 3) 96 m sub-chunk, one clone of each geometry mesh with a thin-instance matrix buffer.
  **Draws = regions in range × models × primitives.** Chunks are shown when `distance − radius < range × rangeScale`
  (202 m for group 2, 48 m for group 3; rangeScale 1.0 Medium, 1.4 High/Ultra).
- **Skinned models** (`placeClone`): one `instantiateModelsToScene` clone per placement, its clip looping from a random
  phase, paused beyond 80 m × rangeScale. **Draws = placements × primitives.** 18 tree models (487 placements) plus
  flowers and some animated props (35 non-foliage clones at the plaza) are skinned (TREES.md §1.1).
- **Materials** (`materials.ts`): each retail material of each model becomes one `PBRMaterial` (Medium+) or
  `StandardMaterial` (Low). The per-object **lightmap** belongs to the material (`extras.sroLightmap`, TEXCOORD_1, one
  file per model part: **577 lightmaps in jangan-fields; 490 are 128², 51 are 256², 35 are 64², 1 is 512²**
  [confirmed: histogram of `work/out-opt/world/jangan-fields/lightmaps`]). Placements of the same model share it, so
  thin instancing per model works; merging *different* models needs the lightmap array.
- **TX-R** (`pbr/maps.ts` `applyMapRecord`): a map set swaps in after the region commits: a remastered albedo
  (the retail texture then becomes the **cut-out mask** as `opacityTexture` when the set's albedo carries no alpha),
  a normal map (`bumpTexture`), an ORM map (`metallicTexture`: R = AO, G = roughness, B = metal), and
  `directIntensity = 0.8` for sets that are not de-lit. At the plaza, 51 of 712 resident materials have a set
  [confirmed: lab].
- **Plugins on every object material** (PBR path): `SroSurfacePlugin` (class roughness, lightmap as baked sun
  visibility + AO, wetness, puddles, lamps, self-lit), `SroFoliagePlugin` (wind, flutter, translucency; foliage
  models), `SroFog`, Babylon's own sub-plugins. Class parameters are per-material uniforms (`sroSurf`, `sroMisc`).
- **Shadows** (`render/shadows.ts`): per-region **shadow proxies** already merge every opaque group-2 static into one
  position-only mesh (a commit step, 500 ms debounce, built on the main thread); cut-out statics cast within
  `foliageM` (60 m on High), skinned clones within 40 m; cascade culling per caster sphere.
- **Active meshes** (`render/active-meshes.ts`): Babylon only sees the enabled meshes. The lab scene still holds
  **~3,900 meshes**, 532 active at the plaza on High.
- **Picking** does not touch world objects: `screens/world.ts` picks entity proxies and `isTerrainMesh` ground;
  objects are `isPickable = false`. The weather's shelter map and `World.meshes()` read `WorldObjects.meshes()`.

### 1.2 Where the plaza's frame goes (High, WebGPU, lab)

[confirmed: `shots/final_webgpu_high_plaza.json`, `prof.js` segments, mean of 3 runs; re-derived in the fact-check,
F1]

| Part | Today | Batched prototype |
|---|---|---|
| Main-pass draws | 467 (buildings/props 244, skinned trees 199, grass 35, static trees/plants 29, terrain 11, water 7, sky 1) | 94 (batches 28, grass 35, lamps/unlit/blend 12, terrain 11, water 7, sky 1) |
| Shadow-map draws (3 cascades) | 92 | 59 |
| Post passes | 13 | 13 |
| Main-pass submission | 8.5 ms | 2.2 ms |
| Active-mesh evaluation | 3.1 ms | 0.6 ms |
| Skinned animation | 2.3 ms | 0.0 ms |
| Shadow map (CPU) | 0.8 ms | 0.4 ms |
| Everything else (world.update, post, clear, submit) | 0.7 ms | 0.5 ms |
| **CPU mean (p50 / p95)** | **15.3 (15.1 / 17.0) ms** | **3.7 (3.5 / 5.0) ms** |
| GPU (sum of WebGPU timestamps) | 3.3 ms | 2.4 ms |

*(fact-check F1)* The first draft had a row "Render list + prepass setup ('prepass/before draw') 4.0 → 1.1 ms". That
lab segment is an artefact: `prof.js` was installed twice, so the segment spans active-mesh evaluation, the shadow map
and before-clear. It equals their sum to within 0.03 ms in every run, and the real residual is 0.02 ms. The rows above
now add up to the CPU mean (`factcheck/segments.py`). Rule for BT-L and I-BT: install `prof.js` once per page, and
check that the segments add up to the CPU mean.

The lab has no characters, HUD or network, and a narrower view than the final gate's plaza (572 vs ~700 draws). Its
High "today" (15.1 ms CPU p50) happens to equal the game's plaza (15.2 ms) [confirmed: `w9-finish/budgets.md`]. On
Medium it does not: the lab took 11.0 ms for 337 draws, where the final gate took 9.5 ms for 450. So the lab ran
≈ 1.5× slower per draw (machine load, §4.2). §5 projects with ratios, not absolute savings *(fact-check F17)*.

---

## 2. Targets [decision]

- **World draws at the plaza on High** (main + shadow, everything but the fixed post chain): **≤ 100**, and ≤ 70 on
  Medium. The prototype reached 153 (High) and 81 (Medium) with the retail grass still in. With §3's full design it
  projects to ≈ 80–85 and ≈ 60–65.
- **Total draws at the plaza** (post included, characters excluded): ≤ 100 on Medium [confirmed: 87], ≈ 95–100 on High
  [projected].
- *(fact-check F24)* What the user was told ("~700 → well under 100") holds for the **world's** draws. The game frame
  also draws the player, NPCs and mobs, about 8 draws each with shadows (crowd 858 vs plaza 698 for 20 mobs,
  budgets.md), and item 1 does not batch characters. §9 says so plainly.
- **CPU**: High on WebGPU p95 ≤ 12 ms at the plaza and ≤ 14 ms in the crowd in the game (`prof.js`, the final-gate
  method), leaving wave 10's sky and sea their budget; Medium WebGL2 unchanged or better everywhere.
- **Look**: the same image as today, within the noise of animation phase and TAA jitter (same-page A/B, §4.4); every
  deliberate difference is listed (§3.13).

---

## 3. Design

### 3.1 The region batch [decision]

At region commit (after its models are loaded; the streamer's existing `'objects'` stage), the region's static
placements are grouped and merged into world-space meshes. The group key is only what the shader or the pass state
cannot take from the table:

| Key part | Why it stays in the key |
|---|---|
| region (owner) | streaming unit; unload drops the region's meshes |
| LOD group 2 / 3 | different draw ranges (§3.8) |
| opaque / cut-out | alpha test changes the pipeline and early-Z |
| cloth sheen (class `cloth`) | Babylon's sheen is a material define (`applyClassExtras`) |
| lamp / self-lit | emissive night factor driven by NL per material (kept as its own per-region group, §3.7) |
| trees: leaf / wood | the foliage plugin's translucency and flutter defines |

What left the key (measured: groups per region at the plaza went from up to 15 → 2–6 for buildings, and 2–9 with the
trees merged too [confirmed: `ab_webgpu_high_plaza*.json`, `final_*.json` `groupsPerRegion`; fact-check F16]):

- **sidedness**: two-sided pieces are emitted twice (the back copy with reversed winding and negated normals), and the
  group draws single-sided. +19% triangles at the plaza (136 k → 162 k for buildings) [confirmed];
- **lightmap presence**: unlit-by-bake pieces sample a white layer 0 of the lightmap array (sun visibility 1, AO 1);
- **class, roughness, metallic, porosity, puddles, luma roughness, direct intensity, cut-off, SSR mask**: table values;
- **texture size and TX-R maps**: atlas cells;
- **winding**: normalised at merge (a mirrored instance, determinant < 0, flips its triangles; none in jangan-fields
  [confirmed], handled anyway).

A group's **representative material** carries the defines. Production builds **one new material per group key**
(never a converted retail material: see the shared-material bug, §4.5). It has the union of the defines its members
need: `SRO_PUDDLES` on if any member puddles, `SRO_LUMA_ROUGH` on (the table's k = 0 turns it off per slot), and so on.
Nothing in a group material is per region: the table carries every per-slot value. So the key for the *material* can
leave out the region, which gives ≈ 10 materials in the whole world, each shared by every region's mesh of that key.
Consecutive draws then skip the material rebind [likely; a small CPU win, measured in BT-L] (Q12).

**The region-listener contract** *(fact-check F10)*. Today three wave-9 listeners receive each model's per-model chunk
meshes in `placed(owner, model, info, meshes, placements)`, and each uses `meshes`:
- `ShadowProxies.placed` merges them into the region's opaque proxy (`mergeInstances`) and sets `receiveShadows`;
- NL's `lampMaterials` changes `mesh.material.emissiveColor`;
- the weather marks the shelter dirty from `meshes[0]`'s box.

For a claimed region the batcher still calls `placed` with the placements, but with **`meshes = []`** for everything
it merged. The separate pieces (lamps, glows, blends, clones) keep their real meshes. It then fires one new
`batched(owner, batch)` event that carries the batch meshes, the worker's shadow proxy and the slots. Shadows take the
proxy from it, and the weather marks the region's box. NL maps its lamp rows to slots (§3.10). This is BT-0's seam, and
`batch-seams.test.ts` checks that no listener ever sees a batch mesh through `placed`.

**Build off the main thread.** The worker (`batch/merge-worker.ts`) keeps a per-model geometry cache (positions,
normals, UV, UV2, indices per primitive, extracted once from the model cache and transferred), receives the region's
placement matrices, primitive → slot and lightmap-layer maps, and returns one set of typed arrays per group plus its
bounds. The main thread only creates the `Mesh` and uploads (a job in the stream budget). The prototype merged
on the main thread: **218 ms for 118 groups in 29 regions, ≈ 7.5 ms per region** [confirmed: lab], far over the 5 ms
frame budget; hence the worker.

**The shadow proxy comes out of the same worker run** (the opaque group-2 positions of the region, §3.9), so
`ShadowProxies.build`'s main-thread `mergeInstances` goes away.

**While a region's batch is building**, its objects are not drawn yet (the region's `'objects'` event fires when the
batch is ready, as today it fires when the chunks are placed) [decision]. No double path at run time: the per-model
thin instances stay only for Low, for a model the batcher rejects, and as the fallback when batching is off.

### 3.2 The material table and the atlas arrays [decision]

- **Slots.** Every converted material gets a slot in one global table (an RGBA16F texture, 5 texels per slot):

  | Texel | Content |
  |---|---|
  | 0 | albedo cell: page layer, u offset, v offset, u scale |
  | 1 | NRAO cell (layer < 0 = none; the cell holds normal xy, roughness, AO): page layer, u offset, v offset, u scale (its v scale follows the albedo's aspect: the map set's planes share it) |
  | 2 | the surface plugin's `sroSurf`: luma-roughness k, porosity, wet roughness, puddle weight |
  | 3 | metallic, roughness, normal strength, has-normal-map |
  | 4 | direct intensity (0.8 for sets that are not de-lit), SSR mask, alpha cut-off, the albedo cell's **v scale** (rectangular cells, F6) |
  | 5 | emissive: NL's night lamp colour × level (written by NL per slot, §3.10), and a self-lit flag *(fact-check F9: without this texel the per-kind lamp colours could not live in a shared material)* |

  So a slot is **6 texels** (F6, F9). Offsets are k/1024 and scales 2⁻ⁿ, which RGBA16F holds exactly [confirmed:
  half-float arithmetic].

  Slots are reference-counted with their model in the model cache and freed with it. A TX-R map set that arrives
  after the region's batch **rewrites the slot's cells and texels only**: no geometry rebuild [decision].
- **Atlas arrays.** Two arrays of square pages: albedo (+ cut-out alpha: from the albedo, or from the retail texture
  when TX-R made it the `opacityTexture`) and NRAO (normal from the bump map with the material's X/Y inversion baked,
  roughness from ORM.G, AO from ORM.R). Page size per tier: **1024² on every preset** [decision: the prototype used
  512² on Medium, which took 269 layers, over WebGPU's default `maxTextureArrayLayers` of 256].
  - A texture gets a **rectangular pow2 cell** (w and h each rounded up to a power of two, min 32; buddy allocation
    that splits a square block into 2:1 or 4:1 strips and keeps the rest on per-shape free lists).
  - The cell is shrunk inside by a wrap gutter of `max(2, side/64)` texels per axis. The gutter holds the texture's
    own wrapped continuation, so REPEAT UVs work through `fract()` and bilinear taps near the edge see the right
    neighbours.
  - The shader samples with `textureSampleGrad`, using the gradient of the unwrapped UV × the cell scale, so the wrap
    seam keeps its mip level.
  - *(fact-check F6: the first draft used square cells and deferred rectangles to "if BT-A has time" (Q5). But 53 % of
    the 713 unique object textures are not square (128×512, 128×256, 256×512, 64×256 …), and square cells need 2.07×
    their texels. Rectangles are required for the VRAM line below.)*
  - **Dedupe.** A cell is keyed by the texture's content, not by the Babylon texture, which is one object per glb. The
    TX-R key `keyOf(SidecarMaterial.texture)` for retail textures, and the set key for map sets. The 445 glbs embed
    1,348 images, and only 713 are unique [confirmed: `factcheck/textures.py`].
- **Lightmaps** *(fact-check F7)*. The prototype used one 128² array with a layer per lightmap file (450 layers).
  - **Why it changes.** That is over 256, and 256 is both WebGPU's default `maxTextureArrayLayers` and GLES 3.0's
    minimum `MAX_ARRAY_TEXTURE_LAYERS`. It ran only because the game and viewer request the adapter's maximum limits.
    All 577 lightmaps of jangan-fields (490 at 128², 35 at 64², 51 at 256², 1 at 512²) would need 577 layers.
  - **Production: one array of 256² layers.**
    - A 256² lightmap takes a whole layer.
    - A 128² or 64² lightmap takes a 128² quadrant (the 64² ones upsampled). Its UV2 is remapped into the quadrant at
      merge.
    - The 512² dragon-fountain lightmap is box-reduced to 256², a little softer (§3.13). *(Wave 10r: the export now
      holds 558 × 128², 61 × 256², 52 × 64² and 9 × 512² (the dragon and eight Dunhuang temple maps, all reduced),
      which is 70 + ⌈611 / 4⌉ ≈ 223 layers if everything were resident.)*
    - That is 52 + ⌈525 / 4⌉ = **184 layers for the whole world**, ≤ 256 on every adapter. At RGBA8 with 2 mip
      levels it is ≈ 60 MiB if every lightmap of the world were resident; the resident set is a fraction of that.
    - Layer 0 quadrant 0 is white.
    - It is **one sampler**, where the first draft's 128² + 256² pair needed two (F8).
  - **Why the quadrants do not bleed.** Lightmap UVs lie in [0.03, 0.97] on every lightmapped primitive [confirmed:
    all 577 `TEXCOORD_1` accessors in `work/out`], so a quadrant keeps ≥ 3.8 texels of margin at 128². Bilinear
    taps never cross it. The shader clamps the lightmap LOD to ≤ 1 (lightmaps are low-frequency) [projected: checked
    in BT-A's test and H-BT lens 8].
- **Where the pixels come from.** In production, from the decode that happens anyway: TX-R's decode worker
  (`pbr/decode-core.ts`, already computing mip chains) and the glb image decode get a "cell" job that adds the gutter
  and the mips; the main thread writes the cell with sub-rectangle uploads per mip (WebGPU `writeTexture` with an
  origin; WebGL2 `texSubImage3D`), each a stream job. The prototype read the textures back from the GPU
  (`readPixels`) and resampled in JS, which took **11–17 s** for 712 materials [confirmed]; that is prototype-only.
- **VRAM.** The prototype held the atlases *and* the originals: **+640 MiB on High** (albedo 469, NRAO 133, lightmaps
  38) for the 29 resident regions [confirmed]. Its atlas used square cells and one cell per Babylon texture, so every
  glb's copy got its own cell.
  - **Production.** The atlases replace the per-material textures: the retail texture is freed once its cell is
    written, like TX-R's retail release (D41). Two things decide the size *(fact-check F6, replacing the first draft's
    "+10 to +35 %")*:
    - today's object textures, if every embedded image were resident, are ≈ **393 MiB** (1,348 images, RGBA8 +
      mips; Babylon keeps one texture per glb [likely]);
    - a content-deduped atlas with rectangular cells holds the same pixels in ≈ **189 MiB** for the whole world
      (713 unique images).
  - **Albedo** is therefore ≈ **−50 %** of today's object textures [projected from `factcheck/textures.py`; the
    resident share depends on the view]. With square cells and no dedupe it would be ≈ +105 %.
  - **NRAO** adds the map sets' planes as today, minus the separate opacity masks, which move into the albedo alpha.
  - **Ultra.** Ultra's KTX2-only rule cannot pack at run time, so Ultra uses the High atlas (RGBA8) for batched
    objects in v1 (Q4).
  - **Freeing and rebuilds** *(F12)*. A live path switch (`World.setRenderMode` → `stream.rebuild()`, e.g. Medium →
    Low) or the Advanced toggle re-places regions without the batch. The model cache must then decode the freed
    retail textures again, from its cached glb bytes or by a refetch [unknown: BT-0 checks what `model-cache.ts`
    keeps]. Default: keep the glb bytes (the out-opt glbs are small) and re-decode on demand.
- **Limits.**
  - WebGPU: the engine requests the adapter's maximum limits (`setMaximumLimits`, `apps/game/src/engine.ts` default
    'max') [confirmed]. The dev PC took 269 layers [confirmed]. An Apple adapter's limit is [unknown], most likely
    2048.
  - **Rule** *(F7)*: every array stays **≤ 256 layers**, so `?gpuLimits=default`, GLES 3.0-minimum drivers and any
    Apple adapter are safe. With 1024² pages the High prototype used 88 + 25 layers with square, per-glb cells
    [confirmed]. With rectangles and dedupe the whole world's albedo is ≈ 36 pages [projected].
  - An array that would pass 256 layers spills into a second array, bound as another group (one more draw).

### 3.3 Geometry: what the merged vertex carries [decision]

- World-space position, normal (instance matrix inverse-transpose, renormalised), UV, UV2.
- **(slot, lightmap layer)** packed into the integer part of UV2 (UV2 lightmap coordinates live in [0, 1]:
  `uv2.x += 2 × layer`, `uv2.y += 2 × slot`; decoded with `floor(uv/2)`), so **no extra varying** [projected: the
  prototype used one extra vec2 varying, `vSroLayer`; W9F BF-2's 16-varying adapters make "no new varying" a hard
  rule]. Groups without any lightmap still get UV2 (pointing at the white quadrant), so the varying exists.
  *(fact-check)*:
  - The margin: the retail lightmap UVs lie in [0.03, 0.97] [confirmed: all 577 lightmapped primitives]. After the
    quadrant remap (§3.2) they lie in [0.015, 0.985], so interpolation error cannot cross an integer.
  - Precision: float32 keeps ≈ 2⁻¹⁰ of lightmap-UV precision while 2 × id < 8192, i.e. up to 4,096 slots or layers:
    0.25 texel on a 256² layer [confirmed arithmetic]. BT-M asserts the bound.
  - Defines: the group material binds no 2D lightmap, so `SRO_TABLE` sets the UV2/MAINUV2 defines itself (F8).
- **Trees only:** the pivot (the placement's origin) as a vertex attribute; it is read in the vertex shader in place
  of `finalWorld[3]` by the foliage plugin (§3.5). An attribute, not a varying.
- Memory: the High resident set merged to **507 k triangles** (29 regions, buildings + trees) [confirmed], about
  **50 MB** of vertex and index data [projected from the vertex/triangle ratio 1.57 measured on the buildings].
  Instancing kept the same geometry in a few MB; the GPUs we target have the room.

### 3.4 The array material (the plugin) [decision]

The prototype did it as a separate `SroArrayPlugin` (priority 100, so it runs before the surface plugin), with
standard injection points plus four regex points [confirmed: `lab/array-plugin.ts`, WGSL and GLSL]:

| Point | What it does |
|---|---|
| `CUSTOM_FRAGMENT_MAIN_BEGIN` | reads the table texels (`textureLoad`), computes UV gradients and a cotangent frame from `vPositionW` and the UV, samples the albedo cell and the NRAO cell with `textureSampleGrad` |
| `CUSTOM_FRAGMENT_UPDATE_ALBEDO` (inside `albedoOpacityBlock`) | `surfaceAlbedo = albedoColor × toLinear(atlas)`, `alpha = atlas.a` rescaled so the representative's `ALPHATESTVALUE` tests the slot's own cut-off |
| `CUSTOM_FRAGMENT_UPDATE_ALPHA` | the normal map through the cotangent frame |
| `CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS` | metallic from the table, roughness from NRAO or the table (the surface plugin's luma/wet roughness applies after) |
| regex on the lightmap init | `lightmapColor` from the lightmap array layer |
| regex on the AO call | × the NRAO AO |
| regex on `uniforms.sroSurf` | the slot's `sroSurf` (so wetness, porosity and puddles are per slot) |
| regex on `finalDiffuse *= vLightingIntensity.x` | × the slot's direct intensity |
| (vertex) regex on `finalWorld[3].xyz` | the tree pivot |

In production the **surface plugin reads the table itself** (a `SRO_TABLE` define: the same code without regexes),
and the foliage plugin gets `SRO_FOL_PIVOT`. Both languages, the same keys. Babylon applies the injection points in
the order their names were first registered, so a regex point of a plugin added later runs on the code the earlier
plugins already injected [confirmed: `materialPluginManager.pure.js` `_injectCustomCode`, and the prototype depends on
it]; a regex on another plugin's text is still brittle, so the table belongs in the owning plugin.

Samplers *(fact-check F8)*: the group material binds exactly **4 object units**: albedo atlas, NRAO atlas, one
lightmap array and the table.
- It binds **no** per-material 2D map: no albedo, bump, metallic, opacity or lightmap texture.
- `SRO_TABLE` sets the defines those textures would have set: UV1/MAINUV1, UV2/MAINUV2, the lightmap path and the
  alpha test. It does this in `prepareDefinesBeforeAttributes`, so the attributes and varyings exist without a
  texture.
- Today's heaviest object material binds 5 object units (albedo, bump, ORM, opacity, lightmap), so the table material
  is one unit **under** it [projected].
- The prototype did not do this. It kept the representative's `albedoTexture` and a (white) `lightmapTexture` bound,
  6 units, and its WebGL2 High run had weather off at noon (no shelter, wet map, ripples or cluster). "WebGL2 High
  compiled and drew" is [confirmed] only for that state.
- WebGL2 has 16 units, and the terrain already uses all 16 on High (`stream.ts` D32), so object materials share the
  same pressure. A guard test counts the object material's units with every define on: night cluster, shelter, cloud
  noise, wet map, ripples and the fog ring.

### 3.5 Trees [decision]

- **Skinned → static, offline.** The converter exports a static variant of each skinned foliage model (the posed mesh
  at frame 0 of its default clip; skin and joints removed). The manifest marks it on the skinned model:
  `models[i].staticVariant = <static model index>` *(fact-check F13: one name; the draft also said `staticOf`)*. The
  variant is written through the same out-opt pass (meshopt + quantization) as every model; all 445 glbs carry
  `EXT_meshopt_compression` and `KHR_mesh_quantization` [confirmed]. So BT-0's geometry export must dequantize, with
  the node's dequantization transform baked into the float copy.
  Medium+ load the static variant; the skinned model is not fetched. The prototype baked the current pose at run time
  with `Mesh.applySkeleton` and it matched the retail silhouettes [confirmed: grove A/B, §4.4].
- **Wind.** Static trees get the foliage plugin's `SRO_FOL_WIND` bend (h² × 0.012 × wind above the instance origin)
  and the leaf flutter. The retail clip sways even in calm weather; the weather wind may be near zero then. A
  **minimum breeze** for foliage (e.g. `max(wind, 0.15)`) keeps a gentle sway [decision; tuned in the lab, Q3].
- **Merged per region** like buildings, keys (region, leaf | wood, cut-out | opaque): **11 tree draws at the plaza
  on High instead of 234 (trees and plants)** [confirmed]. The pivot attribute replaces `finalWorld[3]`, so the wind bends each tree
  around its own root.
- **Fallback: per-model instancing** (one global thin-instance mesh per model primitive, CPU range test per instance
  every 8 m): 47 tree draws at the plaza, correct look, and it already removes the skinned clones' CPU cost
  [confirmed: first prototype round, 226 draws / 3.7 ms]. It is the scope-cut fallback, and the path for a model the
  batcher rejects.
- **TREES.md** (new tree models, deferred) stays compatible: its LOD bands become per-region merged groups with the
  same pivot attribute, and its impostor array draws as it specified.
- **Low** keeps the retail trees exactly (skinned trees hidden, as today), the Low guard [decision; Q2 asks whether Low
  should now show the baked trees].

### 3.6 Grass and life: the batching contract (item c) [decision]

GRASS_LIFE owns the grass and wildlife. Its design already meets the contract; this spec only fixes it:

- **≤ 3 main-pass draws for all ground cover** (one per LOD tier, all kinds and flowers inside) and **≤ 3 wildlife
  draws** (butterflies + dragonflies, birds, fireflies), in any view, on every preset but Low;
- **no shadow casters**, no depth-prepass draw of their own;
- meshes tagged `metadata.sroWorld = 'scatter'` / `'life'`, never taken by the region batcher, frozen world matrices,
  no per-frame allocation, per-frame CPU ≤ 0.2 ms together;
- a mesh at count 0 is hidden, never drawn at the origin (the TREES F13f rule);
- counted in the plaza's total: the prototype still drew the retail scatter (35 chunks on High, 20 on Medium).

### 3.7 What stays separate, and how it is flagged [decision]

| Object | Why | Flag / rule |
|---|---|---|
| Water planes (`water.ts`) and the coast's ocean | their own shader and passes | not objects |
| Lamp models (`LAMP_MODEL`: `lamp`, `_light` in the name), NL's night-owner models' `/light/` materials, and self-lit materials (`SroSurfacePlugin.selfLit`/`lamp`) | NL's night emissive per material and per kind colour, tied to the ambient (`night-lights.ts` `lampMaterials` / `setEmissive`) | **one "lamp" group per region** with its own material (`SRO_LAMP`/`SRO_SELFLIT` on). The emissive colour × level comes from the table's texel 5, which NL writes per slot, instead of one draw per lamp model. 42 lamp-model meshes in the resident set [confirmed; F22]. `batchClass` must use NL's exact rule (LAMP_MODEL, or a night-owner model and `/light/i` in the material name), from one shared function, or a lamp is merged dark (F9) |
| BMT 0x8 unlit materials (glows) | `unlit` PBR | stay per model (14 meshes in the resident set) |
| Alpha-blended pieces (`ALPHABLEND`, `alpha < 1`) | sorting | stay per model (8 in the resident set; the plaza's main pass draws 12 lamp/unlit/blend pieces in all) |
| Retail emissive (the luxury-house tiger, `emissiveColor > 0`) | `addEmissive` level per material | a slot flag + the lamp group's emissive path; 1 at the plaza |
| Skinned props that are not foliage (flags, banners, the waterfall) | real animation | stay clones (35 at the plaza) |
| Retail UV-scroll materials (waterfalls; wave 12, docs/RENDER.md §19) | the texture flows (`SroUvScrollPlugin` on the converted material) | `batchClass` says `separate` (`MaterialBatchRecord.uvScroll`): a material group on the converted material, never a table slot (an atlas cell cannot move); no cut-out caster. 21 materials in jangan-fields; at the plaza only `cj_wf_dr_01` moves out of the table (+1 draw) |
| Characters, NPCs, mobs, drops, effects, the player | move | untouched (MOVEMENT's note that item 1 might edit `apps/game` `models.ts` for actor batching: it does not; no actor batching this wave) |
| COAST's ships and gulls, GRASS_LIFE's birds and butterflies | move | their own instanced draws in their own budgets; never placements the batcher sees (ships are not `manifest.placements` [likely: COAST §8.11 counts them as CST-A draws]) |
| Anything picked or interactive | none among world objects today [confirmed] | a manifest flag `interactive` keeps a model out of the batch if one ever is |
| The three unique town trees (`cj_bridgetree`, `cj_inn_oldtree`, `cj_oldtree02`) | partly buildings | batched as buildings |

The batcher decides per material with one function (`batchClass(material, model) → 'merge' | 'lamp' | 'separate'`),
tested on fixtures of each row.

### 3.8 Frustum culling and draw ranges [decision]

- **Granularity = the region** (192 m). Babylon culls each merged mesh by its box. At the plaza on High about 12–15
  regions are in range and roughly half in the frustum; finer cells (96 m) would cut vertex work but multiply draws by
  up to 4. The GPU went **down** with region granularity (3.3 → 2.4 ms) [confirmed].
- **Group 2 (202 m × rangeScale)**: the region mesh is shown while `distance − radius < range` (as the chunks today).
- **Group 3 (48 m × rangeScale, small props)**: merging them per region extended their range (a stone lion at the
  plaza stairs appeared that today's 96 m sub-chunk test hides) [confirmed: `trees_zoom_high_webgpu.png`]. Production
  keeps one group-3 mesh per region but **collapses each prop in the vertex shader beyond its range** (the prop's
  centre as the pivot attribute, `distance(eye, pivot) − radius > range` → the vertex goes to the pivot, zero area),
  as the scatter shader fades plants. One draw, today's range.
- **As built (wave 10r fix, RP-1/RP-2):** the vertex collapse was cut (scope cut 5). Each group mesh (group 2 per
  region, group 3 per 96 m sub-chunk) keeps the bounding spheres of the thin-instance chunks it replaces, one per
  (model, cell), and is shown while **one of them** passes `distance − radius < range`. A group therefore appears
  exactly when its first chunk would; its other models then draw with it (up to the group's extent early, never
  beyond the sub-chunk for group 3). The merged group's own sphere is never the test (it let a region draw from
  ~130 m beyond its range and ignored the create screen's 0.6). `WorldObjects.setLod(false)` turns the ranges off.
- **Instances** of today's per-model trees and props are gone, so there is no per-instance CPU culling to maintain.
- **The range scale is live** *(fact-check F11)*. `rangeScale` is not fixed per preset:
  - `WorldObjects.setRangeScale` is called on every settings apply (`graphics.ts`: `drawDistance` × Options' sight
    multiplier `SIGHT_MUL`);
  - SCREENS' create screen sets 0.6 while it is up.

  The batcher reads the scale from `WorldObjects` on every range test: the group-2 mesh test on the CPU, and the
  group-3 collapse as a uniform. It never reads it from `QUALITY_PRESETS`, which is what the prototype did.

### 3.9 Shadows [decision]

- **Opaque casters**: the region's shadow proxy (positions only) now comes from the merge worker. **The terrain's
  caster draws (7 at the plaza on High) fold into the same proxy** as a coarse terrain skin (every 4th vertex), so a
  region casts in one draw per cascade [projected].
- **Cut-out casters** (trees, fences, lattices) within `foliageM`: one merged **cut-out caster mesh per region**,
  shadow-only (the proxy layer), whose depth shader samples the albedo atlas for its alpha test. Babylon's
  `ShadowDepthWrapper` on the PBR material is broken on WebGPU with the prepass (RENDER, foliage-plugin notes); the
  caster uses a **small standalone `ShaderMaterial` with a wrapper** (it never draws in the main pass, so MRT does not
  apply) [likely; verified first in lane BT-S]. The prototype did two things instead: per-model tree caster sets
  (correct) and the merged cut-out building meshes as casters with the representative's own alpha (wrong holes for
  the other slots; a known prototype defect, not visible at the plaza) [confirmed by construction].
- Projected shadow draws at the plaza on High: proxies 6 + cut-out casters ~3 regions, over 3 cascades with culling ≈
  25–30 (today 92, prototype 59) [projected].

### 3.10 Wetness, night lights, weather, fog, SSR [decision]

- **Wetness and puddles**: the surface plugin's wet code runs unchanged with the slot's `sroSurf` (porosity, wet
  roughness, puddle weight) [confirmed: compiled with the table regex; not rendered wet in the lab, weather off]
  [likely correct in rain].
- **Night lights**: the cluster and pool lights light any PBR material. The merged meshes are object meshes like the
  chunks (`WORLD_OBJECT_LAYER`, `receiveShadows`). NL's *light list* comes from placements, not meshes [confirmed:
  `placeLights(rows, placements, …)`]. But NL's *lamp glow* does not: `lampMaterials(info, rows, meshes)` sets
  `mesh.material.emissiveColor` on each mesh it is handed [confirmed: `night-lights.ts`]. *(fact-check F9/F10)* Under
  §3.1's contract NL gets `meshes = []` for merged pieces. In the `batched` event it gets each lamp slot, with its
  kind colour, and `setEmissive` writes table texel 5 instead of a material. `night-lights.ts` is therefore in BT-0's
  files (§6).
- **Lamps**: the per-region lamp group (§3.7).
- **Weather shelter** (`weather/index.ts shelterCandidates`) and `World.meshes()`: they read
  `WorldObjects.meshes()`, which returns the batch meshes (and the lamp and separate ones).
- **Fog and haze**: `SroFog` on the group material, unchanged.
- **SSR mask** (Ultra; polished marble `ssr = 1`): per slot (table texel 4). The prototype left `sroMisc.y` per
  material (lost for merged marble) [confirmed: not wired].

### 3.11 WebGPU snapshot rendering (render bundles) [confirmed: measured]

Babylon 9.28 offers snapshot rendering (`engine.snapshotRendering`, `SnapshotRenderingHelper`), recording the frame's
draws into render bundles. Measured on the plaza, High, WebGPU, same page (`shots/snap_webgpu_high_batched.json`). The
state measured is the **earlier 226-draw batch** (147 main: per-model tree instancing and per-class building groups),
not the final 166 *(fact-check F5)*. The conclusion does not depend on it:

| Mode | CPU p50 / p95 | Notes |
|---|---|---|
| off | 3.7 / 5.6 ms | |
| STANDARD | 4.6 / 6.8 ms | slower: still binds every mesh, plus the bundle bookkeeping |
| FAST | 1.8 / 5.0 ms | replays a frozen bundle: material uniforms (sky, weather, night, wetness) are not updated, any visibility change (streaming, ranges, LOD, grass cells, frustum) needs a re-record; WebGPU validation errors ("usage includes writable usage and another usage in the same synchronization scope" on a 1920×1080 RGBA16F target) invalidated command buffers while recording |

**Decision: not in this wave.** After batching the whole frame is ~3.5 ms; FAST would save ~2 ms only if every
per-frame material uniform moved to shared scene-level buffers and the static world were split from everything that
changes. It goes to the backlog as an experiment for after wave 10 (Q7).

### 3.12 The Low (Classic) path [decision]

Low is already fast (180 draws at the plaza, 2.7 ms CPU on WebGPU, 2.3 ms on WebGL2; skinned trees not drawn;
budgets.md) and is the Low guard's reference image. **v1 leaves Low exactly as it is.** The batcher is PBR-path only,
like the TREES swap.

*(fact-check F12)* "Low unchanged" must also hold across a **live** switch:
- `graphics.ts` `apply` calls `World.setRenderMode('classic' | 'pbr')`, which runs `stream.rebuild()`.
- On PBR → Classic the batcher releases every claimed region: meshes, slots and cells, with the listeners told. The
  rebuild then places today's Classic chunks, and the retail textures that were freed are decoded again (§3.2).
- On Classic → PBR it claims again.
- A whole-world load (no streamer) keeps its materials until reloaded, as today, and batching runs only with the
  streamer.

A Classic variant (a `StandardMaterial` plugin with the same table and atlases: the BMT diffuse and
ambient colours per slot, the MODULATE2X and lightmap multiply of `fromPbr`) would help N100-class clients most; it is
an optional lane (BT-K), first in the scope-cut order.

### 3.13 Deliberate look differences [confirmed unless tagged]

- Trees: the retail skinned clip's sway becomes shader wind (and a minimum breeze); the baked pose is one frame of the
  clip.
- Lightmaps above 128² softened (the dragon fountain) in the prototype. Production keeps 256² lightmaps at full size;
  the 512² ones are reduced to 256² (§3.2). *(Wave 10r, RA-2: after the coast's west-coast pass the export holds
  nine: the dragon fountain and eight of the Dunhuang temple, `w_cd_tem_*`. Their baked shadows draw at 256² when
  batched and at 512² unbatched, an accepted A/B difference.)*
- Atlas filtering: textures are resampled into cells shrunk by the gutter. That is 3.1 % smaller for cells ≥ 128,
  6.25 % at 64 and 12.5 % at the 32 minimum *(fact-check F15; the draft said 1.5–3 %)*. BT-A therefore keeps a
  texture of ≤ 64 texels per side at 2× in its cell, so that no small texture loses more than 3.1 %. *(Wave 10r,
  RA-1: unclamped, the gutter fell under half a texel from mip 3 for 128² cells (≈ 60 m for a 1 m tile), and a tap at
  the inner edge read up to 44 % of the neighbouring cell. The table shader now scales its albedo and NRAO gradients
  so the level stays ≤ `atlasMaxLod`: log2(2 × gutter), i.e. 2 below 128² and log2(side) − 5 from there. Beyond it a
  tiling texture keeps that mip, a little sharper than the hardware would pick.)*
- Map sets with a metal plane: ORM.B (metal) is not in the NRAO cell, so metal becomes the slot's constant (texel 3)
  *(fact-check F23)*. How many sets have a non-uniform metal plane is [unknown]. Default: accept a per-slot metal and
  list the affected sets in BT-L's A/B. If a hero material needs it, that slot keeps a separate per-material group
  (one more draw).
- Group-3 props: today's range, through the vertex collapse (§3.8) [projected].
- Two-sided pieces lit from the back use the negated normal, as Babylon's two-sided lighting does.

### 3.14 Seams with the rest of the wave

- **COAST**: re-exported manifest and moved props are just new placements; the batch rebuilds per region. The ocean is
  separate. *(fact-check F13)* COAST's CST-C and this spec's BT-C both edit `packages/convert/src/world/`
  (`convert-world.ts`, `manifest.ts`). COAST's C9 edits run first in the converter (its S-DRAW seam). BT-C rebases on
  CST-C, adds `staticVariant` as a separate manifest field and pass, and the coast re-export then writes the static
  variants too. COAST's synthetic sea regions add terrain draws, which COAST §8.11 budgets; any objects they carry are ordinary
  placements for the batcher [likely].
- **The live render-path switch and the range scale** (wave-9 code): `World.setRenderMode` → `stream.rebuild()`
  (§3.12), and `WorldObjects.setRangeScale` from `graphics.ts` and SCREENS (§3.8). Both are BT-0 seams *(F11, F12)*.
- **Wave-9 region listeners**: shadows, NL and weather (§3.1's contract, F9/F10).
- **GRASS_LIFE**: owns scatter and life; the contract in §3.6; both touch `world.ts` (GL-0 adds `World.life`, BT-0 adds
  `World.batch`): GL-0 first, BT-0 rebases [decision].
- **SCREENS** (character select on the palace steps): the stage loads through `loadWorld` with the streamer
  (`readyRadiusM: 150`, `waitForObjects: true`), so it gets the batches for free and its draw count drops with the
  rest. Its own props and characters are separate. Two checks:
  - its create-screen range cap of 0.6 must reach the batch (§3.8);
  - `waitForObjects` now also waits for the worker merge and the cell uploads. Budget: ≤ +0.5 s on SCREENS' 7-region
    stage and its ≤ 7 s warm load [projected: 7 × ≤ 15 ms merge plus the cell jobs; measured in I-BT].
- **MOVEMENT** (jump): no overlap.
- **TREES** (deferred): §3.5.

---

## 4. The prototype

### 4.1 What was built [confirmed]

- `work/tmp/batching/lab/`: a private Vite server (`vite.config.mjs`, :5241, the viewer's root, `/out-opt/` served as
  the game does), the lab page (`batching-lab.ts`), the batcher (`batch.ts`), the region merge and atlases
  (`buildings.ts`) and the array plugin (`array-plugin.ts`), `prof.js` from the final gate for the frame segments and
  WebGPU timestamps.
- The page loads `jangan-fields` with `loadWorld` (PBR path, modern sky, noon, weather off, the preset's quality), at
  the plaza (glTF (101, −70), looking north, beta 1.42, 14 m; also the south gate and a maple grove), waits for the
  streamer, then builds the batch on the live World: the region listener replays every placement; trees are regrouped
  (skinned ones baked with `applySkeleton`), buildings and trees merged per region, the originals disabled.
- **Same-page A/B**: `setActive(false/true)` restores today's meshes (and every material property the batch changed)
  or shows the batch. 3 rounds of 300 uncapped frames each (2 at the gate), medians reported. The screenshots of both
  states are taken in the same page, one after the other, at least 4 s apart (`quiet()` then one frame) *(fact-check
  F14: not "at the same moment")*. WebGPU `uncapturederror` is counted in every run (0 in all final runs [confirmed:
  `gpuErrors` in `final_*.json`]).
- The GPU lock was held from 21:35 to the end of the timing runs and released [reported by the author; *fact-check F21:
  not re-checkable, since the lock now belongs to another lane*]. One Browser-pane tab; the private server stopped
  afterwards.
- `prof.js` was installed twice on the page (before and after the build), which double-counts one segment (F1).
  Frame, CPU, draw and GPU numbers are unaffected.

### 4.2 Results [confirmed: `shots/final_*.json`]

| Run | Draws | Main / shadow | CPU p50 / p95 (ms) | Active meshes | GPU (ms) |
|---|---|---|---|---|---|
| Plaza High WebGPU, today | 572 | 467 / 92 | 15.1 / 17.0 | 532 | 3.3 |
| Plaza High WebGPU, batched | **166** | 94 / 59 | **3.5 / 5.0** | 94 | 2.4 |
| Plaza Medium WebGPU, today | 337 | 323 / 8 | 11.0 / 13.0 | 372 | n/a |
| Plaza Medium WebGPU, batched | **87** | 73 / 8 | **1.3 / 2.4** | 73 | 1.1 |
| Plaza High WebGL2, today | 572 | 467 / 92 | 14.3 / 17.7 | 532 | — |
| Plaza High WebGL2, batched | **166** | 94 / 59 | **1.4 / 4.8** | 94 | — |
| Plaza Medium WebGL2, today | 337 | 323 / 8 | 9.7 / 11.1 | 372 | — |
| Plaza Medium WebGL2, batched | **87** | 73 / 8 | **0.9 / 1.2** | 73 | — |
| Gate High WebGPU, today | 431 | 387 / 31 | 15.1 / 17.6 | 431 | 3.1 |
| Gate High WebGPU, batched | **150** | 104 / 33 | **4.2 / 6.2** | 104 | 2.3 |

- WebGL2 batched runs are GPU-bound (390–1,100 fps uncapped) [likely]: their p95 includes the driver waiting on the GPU.
  WebGL2 High was noisy: one "today" round had a 39 ms p95 and one batched round 11.4 ms. The medians (17.7 and 4.8)
  are robust to that; the means are not.
- *(fact-check F3/F4)* The gate row is the higher of **2** rounds. Medium "today" GPU produced a value in one round
  only (1.6 ms); the table's "n/a" is the median of that and two empty rounds.
- Build statistics, High:
  - 118 groups (2–9 per region), 712 materials, 51 map sets;
  - 88 albedo + 25 NRAO pages of 1024² (square cells, one per glb texture: F6);
  - 450 lightmap layers (over 256: F7);
  - 507 k triangles;
  - 2,904 foliage instances (trees, flowers, plants) from 62 models, with 43 baked skinned meshes;
  - 552 skinned clones stopped.
- Earlier rounds, kept for the record (`shots/ab_*.json`): per-model tree instancing + per-class building groups: 226
  draws, 3.7 ms (High); unified sidedness/lightmap keys: 202 draws; per-region trees: 166 draws.
- Run-to-run noise between page loads was large (the same "today" plaza measured 15.1–18.7 ms CPU p50 across sessions:
  a second lab tab rendering in the background at first, and the Claude app's own load, ~30 % CPU). Only same-page
  A/B numbers are compared.

### 4.3 Images

- `work/tmp/batching/plaza_high_webgpu.png`, `plaza_medium_webgpu.png`, `plaza_high_webgl2.png`,
  `gate_high_webgpu.png`: today | batched, with the ×4 difference image. The difference is the trees' sway phase
  (clip vs shader wind), cloud drift and TAA jitter.
- `trees_zoom_high_webgpu.png`: canopies behind the plaza, today (its own page load) vs trees merged per region.
- `grove_high_webgpu_v1.png`: the maple grove with per-model tree instancing (the fallback).

### 4.4 The look [confirmed: same-page screenshots]

The plaza, the fountain railings, the palace gate's remastered walls (normal + ORM maps), the pavement and the trees
match.
- The mean absolute difference at the plaza is 5.1/255, with **7.5 %** of pixels over 16/255 on WebGPU High (7.6 % on
  WebGL2 High, 5.2 % on Medium), mostly in the trees, the sky and TAA edges.
- The (unbatched) pavement is also **+1.7–2.6/255 brighter** in every plaza pair, uniformly. The gate pair shows
  nothing (MAD 0.33) *(fact-check F14, `factcheck/abdiff.py`, `factcheck/plaza_high_signed_diff_x4.png`)*.
  - The cause is [unknown]: likely the IBL probe capturing the batched world differently, or SSAO. It is under 1 %,
    but it means the batch changes the ambient.
  - BT-L's A/B must separate it: freeze the IBL refresh and compare again.
- The stone lion by the stairs (group 3) is the one visible object difference (§3.8).

### 4.5 What the prototype found (each is a test or a rule in §6)

1. **An in-place transpose corrupts normals.** Babylon's `m.transposeToRef(m)` aliases; rotated instances got wrong
   normals (brighter railing panels) until a separate matrix was used.
2. **A broken shader blacks the whole WebGPU frame while the counters look normal.** A regex replacement that left a
   statement without its `;` made the pipeline invalid; the draw counts and CPU times were plausible, the image black.
   Rule: every lab run records `uncapturederror` and the image's brightness.
3. **Mutating a shared material leaks.** Choosing a converted material as a group's representative and switching its
   culling changed every other mesh using it (the per-model trees, the "today" state). Rule: batch groups get their own
   materials; converted materials are never modified.
4. **TX-R's cut-out mask may be the `opacityTexture`.** A remastered albedo without alpha made leaf cards solid until
   the retail mask was packed into the cell's alpha.
5. **`directIntensity` 0.8** on map sets that are not de-lit is per material: a table value.
6. **Lightmaps > 128²** need their own array; the SSR mask needs its table texel.
7. **Two-sided pieces** must be decided from the *converted* state, before any representative is changed.
8. **WebGPU layer limits**: 512² pages on Medium took 269 layers.
9. **Snapshot FAST** raised validation errors while recording (§3.11).
10. *(fact-check F1)* **A profiler installed twice lies quietly.** A second `prof.js` install shifted its RTT event
    pairs, and a 4 ms "prepass setup" cost appeared that was really active-mesh evaluation and the shadow map counted
    twice. Rule: install once, and assert in every bench that the segments add up to the CPU mean (±0.1 ms).
11. *(fact-check F7/F8)* **Limits that pass on the dev PC.** The lightmap array's 450 layers and the group material's 6
    units ran because the dev PC's adapter is generous. The rule is ≤ 256 layers per array, and ≤ 4 object units per
    group material, tested with `?gpuLimits=default` and every define on.

### 4.6 What the prototype did not do

- The worker merge, the runtime cell uploads, slot reference counting and streaming unload (it built once, after the
  load).
- The table inside the surface plugin (it used regexes), the packed UV2 ids (it used a varying), the lamp group, the
  group-3 vertex collapse, the terrain in the proxies, the cut-out caster depth shader.
- Rain, night, Ultra, the crowd scene (no characters in the viewer), streaming while moving.

---

## 5. Budgets per preset (WAVE_PLAN3 §5.2 format)

Dev PC = Ryzen 5 9600X + RX 9060 XT, Chrome, 1080p. "Mid" = RTX 3060 / RX 6600 class; "M1" = Apple M1 at render scale
0.75 (first run Medium). Lab = measured in the prototype (§4.2); game = projected from the final gate's game numbers
(budgets.md) minus the lab's saving for the world part.

*(fact-check F17–F20: the game columns are budgets.md's **frame** p95; the projection is now ratio-based; WebGL2 and
slower CPUs added.)*

| Preset | World draws, plaza (today → design) | CPU, lab (today → batched) [confirmed] | Frame p95, game, **WebGPU**: plaza / crowd (today → projected) | Frame p95, game, **WebGL2**: plaza / crowd (today → projected) | GPU dev (today → batched) | Mid desktop CPU (×1.5) / gaming laptop or M1 (×1.4–2) [projected] | VRAM | Geometry |
|---|---|---|---|---|---|---|---|---|
| Low | 180 → 180 (unchanged; game total) | unchanged | 3.8 / 4.2 → unchanged | 3.0 / 4.2 → unchanged | unchanged | unchanged | +0 | +0 |
| Medium (the default) | 331 → **≈ 60–65** (prototype 81) | WebGPU 11.0/13.0 → 1.3/2.4; WebGL2 9.7/11.1 → 0.9/1.2 | 11.4 / 14.4 → **≈ 3–4 / ≈ 6–7** | 12.0 / 11.3 → **≈ 3 / ≈ 4–6** | 1.6 (1 round) → 1.1 ms | plaza ≈ 5–8, crowd ≈ 9–14: holds 60 fps | object albedo ≈ −50 % with rectangular cells and dedupe (F6); lightmaps ≤ 60 MiB for the whole world | ≈ 40 MB resident [projected] |
| High | 559 → **≈ 80–85** (prototype 153) | WebGPU 15.1/17.0 → 3.5/5.0; WebGL2 14.3/17.7 → 1.4/4.8 | 17.9 / 21.5 → **≈ 6–9 / ≈ 10–12** | 16.7 (before cut 4) / 16.0 → **≈ 6 / ≈ 6–8** (GPU floor) | 3.3 → 2.4 ms | plaza ≈ 9–13; **crowd ≈ 15–18 (mid desktop) and ≈ 20–24 (laptop): borderline or missed** | as Medium, 1024² pages | ≈ 50 MB [projected] |
| Ultra | ≈ 600 → ≈ 90 [projected] (+ props in the proxies, SSR) | as High + ≈ 0.3 ms | 19.8 / 22.9 → ≈ 9–11 / ≈ 12–14 | — | ≈ −0.9 ms | not offered | RGBA8 atlas instead of KTX2 for batched objects in v1 (Q4) | as High |

How the game projection is made [projected]:
- **The formula.** The lab's today → batched **ratio** r (frame p95) applies to the world part of the game frame:
  projected = X + (today − X) × r. X is what batching does not touch: characters, HUD, network, game logic.
- **The ratios.** r = 5.0/17.0 = 0.29 for WebGPU High, 2.4/13.0 = 0.18 for WebGPU Medium, 1.2/11.1 = 0.11 for
  WebGL2 Medium, and 4.8/17.7 = 0.27 for WebGL2 High (GPU-bound, so a floor rather than a ratio).
- **X.** At the plaza X is [unknown]; 1.5–2.5 ms is assumed (the player, the NPCs in view, the HUD). In the crowd, X
  is that plus the 20 mobs' measured cost: +3.6 ms p95 on WebGPU High and +3.0 on WebGPU Medium (budgets.md crowd
  minus plaza).
- **Why a ratio.** The lab's absolute saving would flatter the game, because on Medium the lab ran ≈ 1.5× slower per
  draw than the final gate (F17). The first draft's absolute method gave 5.9 / 9.5 ms on High; the ratio gives
  6.3–7.0 / 9.9–10.6. The table keeps the rounded ranges.
- **Slower CPUs** scale the whole frame by 1.5 (a mid desktop) or 1.4–2 (a gaming laptop, an M1 on Medium; SCREENS
  uses the same factors).
- **What that means.**
  - Medium, the default, holds 60 fps everywhere.
  - High holds it at the plaza everywhere.
  - High in a 20-mob crowd is borderline on a mid desktop and misses on a gaming laptop. That remaining cost is the
    characters (≈ 0.18 ms per mob on the dev PC), item 9's follow-up, and not this item.
  - The user's rule for High ("keep features if no worse", w9-user-decisions) is still met: every scene is much
    faster than today.

Per-lane budgets (dev PC; minimum of 5 runs with the GPU lock; the §4.1 method):

| Lane | Budget |
|---|---|
| BT-M (merge) | worker time ≤ 15 ms per region; main-thread mesh creation + upload ≤ 2 ms per region, split into jobs ≤ the stream frame budget; no frame > 16.7 ms while walking between regions (the watchdog) |
| BT-A (atlas) | a cell upload job ≤ 0.5 ms; the table update ≤ 0.05 ms; atlas VRAM ≤ the object textures it replaces (target ≈ −50 %: rectangular cells + content dedupe, F6); every array ≤ 256 layers (F7) |
| BT-P (plugin) | ≤ +0.1 ms GPU at the plaza (the table fetch and the cotangent frame); no new varying (`wgslInterStageCount`); **≤ 4 object sampler units** per group material and the whole material ≤ 16 on WebGL2 with every define on (F8) |
| Load | `loadWorld` with `waitForObjects` ≤ +0.5 s on SCREENS' 7-region stage and ≤ +1 s at the plaza (29 regions), warm, on the dev PC [projected] |
| BT-S (shadows) | shadow draws at the plaza on High ≤ 35; CSM CPU ≤ 0.5 ms |
| BT-T (trees) | tree draws at the plaza ≤ 2 per region in range; the wind ≤ +0.05 ms GPU |
| Steady state | the batch's per-frame CPU (range tests, visibility) ≤ 0.1 ms |
| Whole | High WebGPU p95 at the plaza ≤ 12 ms and in the crowd ≤ 14 ms in the game (`prof.js` installed once, the final-gate spots); WebGL2 Medium and High p95 ≤ 8 ms at the plaza; Medium WebGL2 not worse anywhere; Low identical (the Low guard) |

---

## 6. Lanes

Lane ids `BT-*`. Every lane runs its tests and `pnpm typecheck` before hand-off; nobody commits; the lead integrates.

### 6.1 Step order

```
step 0 (parallel):  BT-0 (seams) | BT-C (converter: static tree variants, data)
step 1 (after BT-0):  BT-A (atlas + table) | BT-M (merge worker + region batch) | BT-P (plugin table mode)
step 2:  BT-S (shadows) | BT-T (trees) | BT-L (lab bench, option) ; BT-K (Classic, optional)
step 3:  I-BT (integration), H-BT (hunt), fixes
```

Dependencies: GRASS_LIFE's GL-0 edits `world.ts` first (§3.14). COAST's re-export only changes data, but COAST's CST-C
and BT-C both edit the converter's world export: CST-C first, and BT-C rebases (F13).

### 6.2 Lane table

| Lane | Owns (files) | Seams it uses or adds | Tests | User check |
|---|---|---|---|---|
| **BT-0** seams (one agent, first) | `objects.ts` (`WorldObjects.setBatcher(b)`: a batcher claims a region's static placements before `placeStatic`; `meshes()` includes the batcher's; `removeRegion` tells it); `region-chunk.ts` (the region's `'objects'` waits for the batcher's ready); `stream.ts` (`StreamHooks.batcher`, the worker handle); `model-cache.ts` / `CachedModel` (`geometry`: typed arrays per primitive, extracted once); `materials.ts` (`ConvertedMaterials` exposes each material's batch record: textures, class params, flags, `batchClass`); `world.ts` (`World.batch: BatchPart \| null`, `LoadWorldOptions.batching?: boolean`, default on for the PBR path); `render/shadows.ts` (`addCasterSource`, proxy input from the batcher); `weather/index.ts` (shelter candidates from `World.meshes()`); **`night-lights.ts`** (lamp rows → table slots, `setEmissive` writes texel 5: F9); the **region-listener contract** (`placed` with `meshes = []` for merged pieces, plus a new `batched` event: §3.1, F10); `WorldObjects.setRangeScale` forwarded to the batcher (F11); `World.setRenderMode` / `stream.rebuild()` releases and re-claims (F12); the geometry export dequantizes meshopt/quantized glbs; `batch/types.ts`; `index.ts` | adds the claim, the part slot, the geometry export, the caster source, the `batched` event | `batch-seams.test.ts`: batching off = HEAD (chunks, clones, draws); a claimed region places no chunks; `removeRegion` reaches the batcher; `'objects'` fires after the batch is ready; Classic never batches; **no listener receives a batch mesh through `placed`; NL's lamp slots get the kind colour at night; `setRangeScale(0.6)` reaches the batch; a PBR → Classic → PBR `setRenderMode` leaves no batch meshes, slots or cells and restores today's chunks**; `seams-classic.test.ts` unchanged (the Low guard) | nothing visible |
| **BT-C** static trees | `packages/convert/src/world/` (the export writes a static glb for each skinned foliage model: frame 0 of the default clip, skin removed; `models[i].staticVariant`), `manifest.ts` + `validate`, rebased on COAST's CST-C edits to the same files (F13) | reads the retail skinned glbs | `static-variant.test.ts`: the posed positions equal the skinned mesh at frame 0 (fixture); no JOINTS/WEIGHTS; bounds within the skinned bounds; one variant per skinned foliage model (18 trees + flowers) | the baked trees look like the retail ones at the grove (review sheet) |
| **BT-A** atlas + table | `batch/atlas.ts` (buddy allocator per page with **rectangular** pow2 cells, gutters per axis, **content-keyed dedupe**, reference counts, spill to a second array at 256 layers), `batch/table.ts` (RGBA16F slots of 6 texels, free list, texel layout §3.2), `batch/lightmaps.ts` (**one 256²-layer array**, 128²/64² lightmaps in quadrants, UV2 remap, white quadrant, ≤ 256 layers: F7), the cell job in `pbr/decode-worker.ts` / `decode-core.ts` (gutter + mips), sub-rect uploads in `textures.ts` | BT-0's batch records; TX-R's map-set `onChange` (rewrite the slot) | `batch-atlas.test.ts` (allocation and free; no overlap; rectangles 1:2 and 1:4 pack without waste; one cell for two glbs' identical texture; gutter pixels equal the wrapped source; table encodes/decodes; half-float precision of 1/1024 offsets; no array above 256 layers; a lightmap quadrant's bilinear taps at UV 0.03/0.97 stay inside it); `batch-textures.test.ts` (NullEngine) | none (the look is checked in BT-L) |
| **BT-M** merge | `batch/merge-core.ts` (pure: transform, inverse-transpose normals, determinant flip, two-sided duplication, UV2 packing, pivots, group keys, bounds), `batch/merge-worker.ts`, `batch/region-batch.ts` (groups per region, the group materials, visibility by range, the group-3 collapse, dispose), `batch/index.ts` | BT-0 claim and geometry; BT-A slots | `merge-core.test.ts` (a rotated instance's normals = Babylon's; a mirrored instance keeps front faces; two-sided emits both faces; UV2 ids round-trip; keys as §3.1; the table-driven classes merge); `region-batch.test.ts` (NullEngine: one mesh per key, meshes hidden beyond range, never drawn at count 0, unload frees slots and cells) | the plaza looks the same (A/B) |
| **BT-P** plugin | `pbr/surface-plugin.ts` (`SRO_TABLE`: reads §3.2's table, samples the atlases and the lightmap array, the cotangent normal, per-slot cut-off and direct intensity; WGSL + GLSL), `pbr/foliage-plugin.ts` (`SRO_FOL_PIVOT`, the minimum breeze) | BT-A textures | `surface.test.ts` additions (both languages, the same keys; `SRO_TABLE` off = HEAD code; the cut-off rescale in TS equals the shader); `foliage.test.ts` (pivot); `wgslInterStageCount` of the table material ≤ 15 user varyings; the group material binds exactly 4 object samplers and no 2D map (F8); a WebGL2 sampler-count guard with every define on (≤ 16) | wet and night looks unchanged on the batched town (lab shots) |
| **BT-S** shadows | `render/shadows.ts` (proxies from the merge worker, the terrain skin in the proxy, the cut-out caster per region with its standalone depth `ShaderMaterial` + wrapper) | BT-0 caster source | `shadows.test.ts` additions: a region casts one proxy + at most one cut-out caster; the cut-out caster never draws in the main pass; `selectCasters` with batches; on WebGPU High the caster pipeline is valid (lab, 0 `uncapturederror`) | tree and fence shadows keep their holes |
| **BT-T** trees | `batch/trees.ts` (tree groups per region, leaf/wood keys, pivots, the per-model instancing fallback set) | BT-C variants, BT-M, BT-P pivot | `batch-trees.test.ts`: skinned trees load their static variant on Medium+; Low loads nothing new; tree draws ≤ 2 per region; the fallback set's instance buffer never drawn at count 0 | trees sway in wind and gently when calm |
| **BT-L** lab + option | `apps/viewer/src/world/batch-panel.ts` (A/B toggle, counters: draws, groups, slots, pages, VRAM), the bench spots; `apps/game/src/settings.ts` + `hud/options.ts` (Advanced → "World batching: on / off", default on for Medium+, absent on Low; **applies through `stream.rebuild()`, like a render-path switch**, F12) (GAME); the bench installs `prof.js` once and asserts that the segments add up (F1) | BT-M stats | `settings.test.ts`: the row and its default; a toggle rebuilds without leftovers | Options → Advanced → World batching |
| **BT-K** Classic (optional) | `batch/classic-plugin.ts` (StandardMaterial table: BMT colours, MODULATE2X, the lightmap multiply) | BT-A, BT-M | the Low guard with batching on: the image within tolerance of HEAD | Low looks the same |
| **I-BT** integration | merge order BT-0 → BT-A → BT-M → BT-P → BT-S → BT-T → BT-L (→ BT-K) | — | full `pnpm vitest run`, `pnpm typecheck`; the §5 bench with `prof.js` in the game on WebGPU High and WebGL2 Medium (plaza, gate in a storm, fields at night, crowd) | before/after shots at the bench spots, day, night, rain |
| **H-BT** hunt lenses | — | — | (1) a region drawn twice (chunks and batch); (2) a region unload leaves meshes, slots or cells behind; (3) Low changed; (4) a black WebGPU frame (invalid pipeline) at any preset; (5) 16-varying adapters (force `maxInterStageShaderVariables = 16`); (6) WebGL2 sampler units with night + rain + clouds; (7) a TX-R map set arriving late shows the wrong cell; (8) atlas seams or mip bleeding on tiling walls at distance; (9) a mirrored or two-sided piece inside out; (10) group-3 props visible beyond 48 m × scale; (11) lamps not glowing at night; (12) cut-out shadows without holes; (13) a hitch > 16.7 ms when a region's batch lands; (14) rain falling through merged roofs (shelter); (15) VRAM over budget on an 8 GB card; (16) a material property changed on a converted material (the leak, §4.5); *(fact-check additions)* (17) a live Low ↔ Medium switch with batching (lost textures, leftover batches); (18) SCREENS' create range 0.6 and Options' sight not applied to the batch; (19) `?gpuLimits=default` on WebGPU (256 layers, 16 varyings) renders correctly; (20) a bench whose segments do not add up to its CPU mean (profiler installed twice, F1); (21) the ambient shifting with the batch on (the +2/255 pavement offset, F14) | — |

---

## 7. Scope-cut order (cut from the top)

1. BT-K, the Classic path (Low stays as it is).
2. The terrain skin in the shadow proxies (keep the terrain's own caster draws, +7 at the plaza on High).
3. The lightmap quadrant packing (fall back to one lightmap per layer at 128², with the 256² ones reduced and the
   dragon's bake softer, split into arrays of ≤ 256 layers each: one more sampler and one more group per extra array,
   F7).
4. The lamp group (lamp models stay per-model draws, +5 to +10 at the plaza [projected]).
5. The group-3 vertex collapse (group-3 props keep their own per-sub-chunk meshes: +2–4 draws per nearby region).
6. Trees merged per region (fall back to per-model instancing: +36 draws at the plaza, still no skinned clones).
7. The cut-out caster depth shader (cut-outs cast from the per-model tree sets; fences cast solid).
8. The NRAO atlas (map-set materials keep their own group per material: +10 to +30 draws in the town [projected]).

**Never cut:** the static tree variants (the skinned clones' CPU cost), buildings merged per region on the table
material, the worker build, Low unchanged, no new varying, the A/B option, *(fact-check)* rectangular cells with
content dedupe (without them the albedo atlas is ≈ 2× today's object textures, F6), ≤ 256 layers per array (F7), ≤ 4
object samplers per group material (F8), and the listener contract with NL's per-slot lamp emissive (F9/F10).

---

## 8. Risks

| Risk | Default handling |
|---|---|
| Atlas mip bleeding or seams on tiling textures at distance | gutter `size/64` (≥ 2 texels); if H-BT lens 8 finds it, clamp the LOD per cell (`textureSampleLevel`) at `log2(cell) − 3` |
| VRAM growth (pow2 rounding, gutters; square cells would double it, F6) | rectangular cells + content dedupe (target ≈ −50 % of today's object albedo); spill arrays; KTX2 atlases in a later wave |
| A region's batch landing causes a hitch | the worker; main-thread jobs ≤ the stream budget; the watchdog run in I-BT |
| Merged geometry memory | ≈ 50 MB at High [projected]; region unload frees it |
| Babylon internals (regex points, plugin order, snapshot) change in an update | the table lives in our own plugins (`SRO_TABLE`), not in regexes on Babylon's text; the WebGPU black-frame check in every lab run |
| Wind looks different from the retail clips | the minimum breeze, tuned against the retail sway in the lab; Q3 |
| Shadow depth wrapper also fails for the standalone caster material | cut 7 (per-model tree casters) |
| Apple GPUs and default-limit devices: layer limits, sampler limits, the 16-varying cap | every array ≤ 256 layers, including the lightmaps (F7); 4 object samplers (F8); UV2-packed ids; H-BT lens 19 (`?gpuLimits=default`); the first M1 playtest checks it (§9) |
| The lab's segment timings mislead a lane (F1) | `prof.js` installed once; every bench asserts that the segments add up to the CPU mean |
| The batch shifts the ambient (+2/255 on the pavement, F14) | BT-L freezes the IBL refresh in the A/B and finds the cause before I-BT |
| The game gains less than the lab (characters dominate the crowd) | the crowd budget is ≤ 14 ms, not 5; projections use the lab's ratio, not its absolute saving (F17); High in a 20-mob crowd stays borderline on mid desktops and misses on gaming laptops (F20); characters' own cost is item 9's follow-up (animation LOD, skinning) |

---

## 9. What the user must provide or approve (each has a default)

1. **The plan: region batches + static trees with shader wind.** Trees sway with the weather wind (and a gentle
   minimum breeze) instead of the retail animation loop. **Default: yes.**
2. **A slightly different small-prop range and softer big lightmaps are acceptable if the lab shows them** (§3.13).
   **Default: accepted; each is fixed in the design anyway.**
3. **An Advanced option "World batching: on / off"** for A/B and as a safety fallback. **Default: on for Medium and
   up; not shown on Low.**
4. **Low stays exactly as today** (no baked trees, no batching). **Default: yes.**
5. **Downloads**: none (no new tools; the static tree variants are made by our converter). **Default: none.**
6. **A friend with an Apple Silicon Mac to try the lab build once** (layer and sampler limits are [unknown] there).
   **Default: the first wave-11 playtest covers it.**
7. *(fact-check F24)* **What "well under 100" means.** The world (buildings, trees, grass, life, terrain, water,
   shadows) drops to ≈ 80–85 draws at the plaza on High and ≈ 60–65 on Medium. Characters (the player, NPCs, mobs;
   ≈ 8 draws each) are not batched this wave, so the frame's total is higher in a crowd, and in a 20-mob crowd High
   stays borderline on gaming laptops (Medium is fine). **Default: accepted; character cost is the next perf item.**

## 10. Open questions (each has a default, so nobody waits)

| # | Question | Default |
|---|---|---|
| Q1 | Region granularity vs 96 m cells | region; revisit only if the GPU budget on mid cards is missed |
| Q2 | Should Low show the baked static trees (today it hides the skinned ones)? | no: Low unchanged (the Low guard) |
| Q3 | The minimum breeze | `max(wind, 0.15)` for foliage; tuned in BT-T against the retail clips at the grove |
| Q4 | Ultra's atlas format | RGBA8 at 1024² (the High atlas) for batched objects in v1; offline-packed KTX2 atlases later |
| Q5 | Non-square textures (53 % of the unique object textures; the gate's 1024 × 2048) | *(fact-check F6: flipped)* rectangular pow2 buddy cells in v1; a texture larger than the page is halved to fit (1024 × 2048 → 512 × 1024 on High) |
| Q6 | Where the cell pixels come from | the existing decode paths (TX-R decode worker, glb images) + a cell job; never GPU readback |
| Q7 | WebGPU snapshot rendering | backlog experiment after wave 10 (needs shared per-frame UBOs) |
| Q8 | Per-model instancing or per-region merge for trees | per-region merge; per-model is the fallback (cut 6) |
| Q9 | Does the lab's saving hold in the game with characters? | measured in I-BT with `prof.js` at the final-gate spots; the gate is §5's "Whole" row |
| Q10 | The prototype's per-class look (wet, night) | not rendered wet or at night in the lab; I-BT's shots at night and in rain are the check |
| Q11 | *(fact-check F6/F12)* Free the retail textures once their cells are written? | yes (the VRAM line needs it); keep the glb bytes in the model cache and decode again on a rebuild (render-path switch, the Advanced toggle) |
| Q12 | *(fact-check)* Group materials per region, or one per key for the whole world? | one per key (≈ 10 in the world): nothing in them is per region; measure the rebind saving in BT-L |
| Q13 | *(fact-check F14)* The +1.7–2.6/255 pavement brightening with the batch on | [unknown]; BT-L repeats the A/B with the IBL refresh frozen, and SSAO off, to find it; accepted if it is the probe |

## 11. Wave 12: the tree swap in the region batch, S-SCALE and S-OBJ (docs/TREES.md Part W §W3, docs/WORLD_EDITOR.md §2.3, docs/WAVE_PLAN8.md D3)

- **The swap in BT-T** (`batch/trees.ts`, T12-M; the source `BatchHost.treeSwap`, W12-SA): a retail tree or plant
  model with `WorldModel.treeSwap` is a tree claim like BT-T's own trees (`cj_ricestraw` included), but the region batch
  merges the species' LOD1 and LOD2 (`models/trees/<id>/far.glb`) with the swap's fit and offset in place of the retail
  mesh; the retail glb is never fetched. **Draws per region are unchanged** (I-12's cross test compares every region
  of BT-T's fixture with the swap on and off); the tree groups carry `sroTree` and stay out of the cloth counter
  (`clothGroups` is unchanged after a tree group's dispose, WF8). The worker emits the cut-out caster's arrays (tier 1
  only), so the heaviest region (24999) costs the main thread no copy. Without a source (Classic, `'retail'`, or a
  manifest without `treeSwap`) the batch is wave 10's byte for byte.
- **S-SCALE** (W12-SA, kept by T12-M): the placement's optional uniform `scale` multiplies at every compose site
  (`objects.ts`, the region batch, `ambient-fx.ts`, `life/spawn.ts`, `town/fx.ts`); absent = 1, byte-identical batches.
  The nav footprint stays unscaled (D17: trees 0.85–1.15).
- **S-OBJ** (W12-SA): `RegionStreamer.reloadObjects(rx, rz, { placements? })` re-places one resident region through
  the worker (the new set staged hidden until it swaps in, so no frame shows both or neither; ≤ 50 ms) and
  `WorldObjects.setEditorOwned(pred)` leaves the placements the World Editor draws itself out of their region's
  chunks, clones and batch. The editor drops, moves and plants through these; the game never calls them.
