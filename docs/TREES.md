# New trees and plants everywhere (wave 12; first written as the wave-10 trees part)

> **Status (2026-10-02, I-12): Part W built in wave 12.** 35 species replace the 110 retail tree and plant models
> (4,886 placements); Options → Graphics → Trees: New / Retail; Low keeps retail. docs/WAVE_PLAN8.md overrides this
> spec where they differ: TREES cuts 3, 4 and 8 are removed (D38: every family is replaced, never cut), the crowded-plaza
> rule (D24), the species' LOD1 in the editor's shadow bake (D18), T12-B's texpipe rows as a fragment (D7).
> **TREE-TUNE (2026-10-03, §WT):** the crown gate (G5) was re-tuned at the root (card normals per the retail cards,
> the retail texture sets themselves, no compensating grades) and measured for all 35 species in game; the result
> and the species still outside ±10 % are in §WT.

**Wave 12 (2026-10-01).** The user: "i would love if all tree's in the game and terrains use the newer tree's instead
of the retail low poly and low texture tree's and plants." The scope grew from "trees only" (wave 10) to **every tree
family and every plant placed as an object, across the whole map and the town**. The wave-12 design is **Part W**
below (§W0–§W12). It was written on top of wave 10 as built: BT-T's region tree groups, the static variants of the 18
skinned foliage models, the shader wind with a minimum breeze (docs/BATCHING.md), and the grass and far-grass systems
(docs/GRASS_LIFE.md, docs/GRASS_FAR.md). Where Part W and the wave-10 sections (§0–§9) disagree, **Part W wins**; the
places it replaces carry a "(wave 12, 2026-10-01)" note. The wave-10 text is kept as the record of the maple prototype,
the fact-check and the reasoning that still holds.

The wave-10 spec did five things:

- it lists every tree the jangan-fields export places, and how those trees are drawn, lit and streamed today (§1);
- it compares four ways to make new trees and recommends one (§2);
- it designs the runtime: a swap keyed by the retail model, LODs and impostors, wind data and budgets (§3);
- it reports a prototype of one species (the plaza maple), built end to end and measured in the real renderer (§4);
- it cuts the work into lanes with seams, tests, user checks and a scope-cut order (§5, §6).

This is design only. Code, content and deploy files are untouched. Prototypes, scripts and images are in
`work/tmp/trees/` (wave 10) and `work/tmp/trees/w12/` (wave 12).

**Tags.**

- **[confirmed]**: checked in the code, the data or a measurement, and the section says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement or from the manifest, not measured on that setup.
- **[unknown]**: open; a default is given.
- **[decision]**: a choice this spec makes.

**Sources read.** docs/BACKLOG.md (items 7 and 9), docs/WAVE_PLAN3.md (§5.2 budget format, §6.14 RND-W, §7 9B),
docs/RENDER.md (§1, §8.1, §11.6, §13), docs/TEXPIPE.md (§1.3 hero set), docs/TERRAIN.md §6.5, docs/WEATHER.md §6.7,
docs/NAVIGATION.md, `work/tmp/w9-finish/budgets.md`, `work/tmp/w9-user-decisions.md`, `work/tmp/tidewater-notes.md`,
and the code at the working tree of 2026-09-29: `objects.ts`, `region-chunk.ts`, `stream.ts`, `materials.ts`,
`pbr/foliage-plugin.ts`, `pbr/classes.ts`, `render/shadows.ts`, `render/quality.ts`, `render/active-meshes.ts`,
`world.ts`. The code is being edited by the release workflow; hooks are named by their code, not their line numbers.

**Fact-check 2026-09-29.** After it was written, this spec was fact-checked adversarially. Every [confirmed] claim was
re-derived from the code, the manifest, the Babylon 9.28 sources in `node_modules`, the retail glbs and the lab JSONs.
The prototype was re-built and re-baked in Blender, the out-opt geometry pass was run on the prototype glbs, and the
draw projection was swept over the whole map. The corrections are F1–F20 in §F below, and every changed passage carries
a "(fact-check)" note. The scripts are `work/tmp/trees/factcheck.py` (output in `factcheck.txt`),
`factcheck_fam.py` and `optsize.ts`. Blender's re-run output is in `work/tmp/trees/factcheck_out/`. No GPU timing was
run, so the GPU lock was not needed. The largest corrections:

- the crown AO in `COLOR_0` adds a varying, which makes the pipeline invalid on 16-varying WebGPU adapters at Medium (F1);
- the "≤ 12 caster draws" holds only at the plaza, and can reach 60 on High (F4);
- the download is a net increase, not a saving (F6);
- the prototype's CPU A/B shows no saving, and its first batch leaned worse (F7);
- the High dither cross-fade has no working TAA to resolve it (F9);
- six integration seams were missing (F13).

---

## Part W. Wave 12: new trees and plants everywhere (wave 12, 2026-10-01)

**Sources read for Part W.** docs/BACKLOG.md, docs/WAVE_PLAN7.md (the planning format), docs/RENDER.md,
docs/BATCHING.md (§3.1–§3.9, the status line: built as BT-A/M/P/C/S/T/L), docs/GRASS_LIFE.md (§1.3 the placed retail
grass, Q12), docs/GRASS_FAR.md, docs/COAST.md (§3B, §6, S-TREE, S-DRAW), docs/TERRAIN.md, docs/TEXPIPE.md (TP-U, the
Real-ESRGAN tool), docs/NAVIGATION.md, `work/tmp/w9-user-decisions.md` (read only), the wave-10 polish budgets
(`Dropbox/.../wave10/budgets.md`), and the code at the working tree of 2026-10-01: `batch/trees.ts`,
`batch/merge-core.ts`, `batch/region-batch.ts` (mesh metadata `sroTree`), `batch/atlas.ts` (cell jobs decode the glb's
embedded image), `materials.ts` (`SidecarMaterialLite`, `MaterialBatchRecord`), `pbr/classes.ts` (the wood/foliage
rules), `pbr/foliage-plugin.ts` (`SRO_FOL_PIVOT`, `SRO_FOL_BREEZE`, `FOLIAGE_MIN_BREEZE = 0.15`, the W11-S cloth
`sroPivot` vec4), `render/shadows.ts` (BT-S's cut-out caster per region, `sroCull`), `grass/types.ts`
(`RETAIL_TUFT_MODELS`), `region-chunk.ts` (W10-S hidden models), `world.ts` (`batching` on by default on the PBR path),
`packages/convert/src/remaster/meshy.ts` (the Meshy client). The wave-11 build is editing `apps/` and
`packages/world-render` at the same time; hooks are named by their code, not by line numbers.

**What was run for Part W** (all scripts in `work/tmp/trees/w12/`):

| What | Script / output | How |
|---|---|---|
| Inventory of every tree and plant | `inventory12.py` → `inventory12.json` | the out-opt manifest (`work/out-opt/world/jangan-fields`, 414 regions, 503 models, 6,965 placements) and every foliage glb |
| Draw / triangle / memory projection | `project12.py` → `project12.json` | the wave-10 BT-T keys and the §W3 bands, all around the camera, Medium (×1.0) and High (×1.4) |
| Three new species + the maple, three tiers each | `make_species.py` → `out/{pine07,willow03,shrub02,maple03}_lod{0,1,2}.glb`, `.blend`, `.stats.json` | Blender 5.2.2 headless (`-b --factory-startup`), bmesh-free `from_pydata`, no sculpt operators |
| Sprite upscale | `upscale.py` → `up/` (2×, the game tier), `up4/` (4×) | Real-ESRGAN ncnn-vulkan x4plus (TEXPIPE TP-U's tool), GPU lock held 15:15 |
| Review sheets | `render_sheet.py` → `sheets/*.png`, `review_sheets.jpg` | Cycles CPU, the game pitch (18°), no tree shadows (Medium has none), 128 transparent bounces |
| Meshy bake-off | `meshy/bakeoff.ts` → `meshy/J1.glb`, `J2.glb`, `ledger.json`; `bakeoff_meshy.jpg` | the repo's `MeshyClient` (key read by the client, never printed); 40 credits, logged in `work/night/NIGHT_LOG.md` |
| In-game measurement and before/after | `lab/` (`prep.ts`, `vite.config.mjs` on :5238, `trees12-lab.ts`) → `shots/*.json`, `before_after_ingame.jpg` | the real out-opt export through `loadWorld` (the game's defaults: PBR, batching, grass, life, sky); the new trees swapped in through the manifest so **BT-T's real region batch merged them**; the Browser pane (one tab, 1920×1080 emulation, a timer pump), GPU lock held 15:24–15:32; server, tab and lock removed afterwards |

**Fact-check of Part W (2026-10-01).** Part W was fact-checked adversarially the same day. Every [confirmed] claim was
re-derived from the code, the out-opt manifest and files, the Babylon 9.28 sources, the prototype glbs, the lab JSONs and
shots, `wave10/budgets.md` and the Meshy ledger (the balance was re-read: 1,840; the fact-check spent 0 credits). The
corrections are WF1–WF22 in §WF (after §W0), and every changed passage carries a "(fact-check W)" note. Scripts:
`work/tmp/trees/w12/factcheck/` (`crown_luma.py`, `colour_transfer.py`) plus re-runs of `inventory12.py` and
`project12.py` with extra outputs. No GPU timing was run, so the GPU lock was not taken. The largest corrections: the
in-game crowns are **25–48% darker** than retail, not "a little" (WF1); Medium's sprites must follow the existing
`graphics.textures` tiers, where Medium is retail-size (WF2); merged tree memory is ≈ +28–40 MB, not +23–28 (WF5); five
code seams were missing (WF8–WF12); and High already misses 60 fps in the crowd + 20 bots scene before any tree (WF4).

---

### §W0. Summary (wave 12)

1. **Scope** [confirmed: `inventory12.py`]. The export places **5,586 foliage objects of 119 models**: 1,695 trees
   (89 models), 3,196 plants (24 models: tall weeds, reeds, barley, flowers, water plants), and the 695 low retail tufts
   (6 models) that the new grass already hides (they stay hidden). 1,030 of them stand in the Jangan town box. Wave 12
   replaces **all of them except the 5 unique town trees and the hidden tufts: 4,886 placements, 110 retail models, by
   35 new species** (§W1).
2. **Route per family: bpy for all 35** [decision]. The Meshy bake-off (§W2: 40 of the 60 design credits) lost on every
   axis that matters for instanced foliage: image-to-3D made an opaque faceted blob (no cut-out leaves, no wind data,
   a 4.3 MB texture), and retexturing our own pine merged its leaf material into one **opaque** material and dropped
   the wind channels. The bpy route made three new species (a Chinese pine, a willow, a shrub) plus the maple in about
   70 minutes of authoring, 6–21 s of Blender each, with LODs, wind data and the retail painted sprites. **The build
   plans 0 Meshy credits for trees**, with a 90-credit contingency for bare dead trunks only (§W2.4).
3. **Runtime: inside BT-T, not beside it** [decision]. Wave 10 already draws every region's foliage as 2 merged
   draws (leaf cut-out, wood opaque). Wave 12 keeps exactly that: the swap (keyed by the retail source, as before)
   makes the region batch merge the **new LOD1 and LOD2** instead of the retail mesh, and a per-tree **band byte**
   decides in the vertex shader which tier shows (no new varying). Near the camera a small **LOD0 overlay** (one
   thin-instance set per species and material, the only new draws) shows the full model. **The impostor array of
   wave 10's design is dropped**: with region merging, far trees already cost no extra draws, and the impostors would
   have cost 85–150 MB of VRAM and a second lighting path (§W3).
4. **Measured in the real renderer** [confirmed: lab, §W5]. With 4 families (376 placements) swapped into the merged
   batch, the frame's draws did not change (plaza Medium 87 → 87, High 125 → 126; pine forest 27 → 27) and the CPU
   p95 stayed within the noise (Medium WebGPU plaza 5.7 → 5.0 ms with LOD1, 4.0 with LOD0). The cost moved to triangles
   and memory: tree triangles in view 33 k → 47 k (LOD1) / 117 k (LOD0, the worst case), the merged tree geometry
   19.4 → 22.4 / 33.8 MB at the plaza. *(fact-check W, WF13)* The lab's CPU columns may also be disturbed: the World
   Editor's prototype page rendered in the same hidden pane during 15:24–15:30 (WORLD_EDITOR §9 note 9). Draws,
   triangles and memory are deterministic and stand; the CPU figures are not evidence either way.
5. **Budgets** (§W6) [projected]: Medium plaza frame p95 3.9 → ≈ 4.1–4.4 ms, High 6.1 → ≈ 6.4–6.8 ms (WebGPU, the
   polish bench); + 4–6 draws at the plaza, ≤ +12 at the busiest spot. *(fact-check W, WF5, WF2)* Merged geometry
   grows by ≈ +28–40 MB (the new vertex layout is 56–72 B per vertex, not wave 10's 52). Texture VRAM grows by ≈ +0
   on Medium (retail-size sprites, the `graphics.textures` rule) and by ≈ +26–73 MiB on High+ (2×). The download goes
   **down** ≈ 1.3 MB (the retail foliage glbs embed their textures). *(fact-check W, WF4)* Medium's tightest scene is the
   crowd + 20 bots (13.7 ms, 15.1 in one wave-10 run), so the margin there is ≈ 1.5–3 ms, not "> 10 ms". High already
   misses 60 fps in that scene before any tree (17.1–19.3 ms, wave 10's final gate; BACKLOG item 9).
6. **Look** (§W4): every species keeps the retail painted sprites (upscaled, colour-matched to retail), the retail
   envelopes ±10% and SRO's olive / sage / rust / gold palette. The in-game before/after (`before_after_ingame.jpg`)
   shows real 3D crowns, layered pine pads and a willow dome of hanging strands; it also shows the one look fault left:
   **the new crowns read darker and more saturated than wave 10's retail crowns** (the retail willow in particular is
   brighter lime). *(fact-check W, WF1)* This is not a small fault: measured over the same frames, the crown pixels are
   **25% (pine) to 48% (maple, willow) darker** and much more saturated (mean saturation 0.47 → 0.68 on the maple).
   The sprites are not the cause (their luminance matches retail within 1%), so it is lighting. A +15% leaf gain cannot
   close it. The build first finds the cause in the lab (§W4.1 rule 3), and the crown-luminance gate (±10% of retail)
   blocks every family until it passes.
7. **Editor** (§W3.9): every species is placeable in the World Editor's library, as its retail carrier model (so nav
   footprints, Low and the swap stay consistent), with live preview through the band byte and a region re-merge.
8. **Build** (§W7): one command builds every family in one batch: sprite extraction, one GPU-locked upscale batch
   (≈ 3 min for ≈ 45 sprites), Blender headless per species (≈ 6–21 s each), validation, the out-opt pass, and a
   review sheet per family (Blender) plus an in-game before/after per family (the lab page).

---

### §WF. What the fact-check of Part W corrected (fact-check W, 2026-10-01)

| # | Claim as written | What the check found, and how | Fixed in |
|---|---|---|---|
| WF1 | The new crowns are "a little darker"; leaf gain +15% fixes it | **The gap is large.** Over the pixels that differ between the retail and new lab frames (same camera; `factcheck/crown_luma.py` over `shots/look_*.png`), the green crown pixels' mean luminance is: maple 0.414 → 0.205 (−50%), willow 0.454 → 0.236 (−48%), pine 0.309 → 0.231 (−25%), shrub 0.259 → 0.265 (level). Saturation goes 0.47 → 0.68 (maple), 0.63 → 0.72 (willow), 0.35 → 0.61 (pine) [confirmed]. The sprites match retail within 1% luminance (WF3), so the cause is the lighting of the new cards: the outward-bent single-sided normals, deeper crowns and self-shadowing, the translucency term, and TX-R map sets that the retail willow and pine07 keys carry and the new `tre_w12_*` keys did not (both exist in `work/out/pbr/index.json`) [likely]. | §W0, §W4.1, §W4.2, §W9, §W11 |
| WF2 | Sprites at 2× "on Medium+"; "Options' texture quality Low keeps 1×" | There is no texture-quality-Low option. The real Option is `graphics.textures` (`pbr/maps.ts` `textureTierFor`): **Medium 'auto' = 'remaster', the retail size**; High = '2x'; Ultra ≤ 2048; Low = retail; 'retail' / 'remaster' / 1024 / 2048 pin a tier [confirmed: code and `txr-textures.test.ts`]. Making only the foliage 2× on Medium would break the wave-9 tier rule. **Now:** the species glbs embed the retail-size sprite (made from the 4× ESRGAN, colour-matched), and the 2× sprite ships as a TX-R tier of the new key, loaded on High+ or when 1024 / 2048 is pinned. VRAM: Medium ≈ +0; High+ ≈ +26–73 MiB (the lab's +13 MiB for 8 sprites is one atlas-layer step: 1.6 MiB per sprite against 0.6 in theory). | §W3.8, §W4.1, §W6, §W9 |
| WF3 | The per-channel mean match restores the sprites | Luminance: within 1% for all 8 sprites [confirmed: re-measured]. The **spread** is not restored: blue p5/p50/p95 goes 2/13/24 → 0/7/42 on `tre_dry02` and 16/28/41 → 0/20/80 on `tre_willow03_leaf01`, and saturation rises 0–8% [confirmed: `factcheck/colour_transfer.py`]. A local colour transfer (ESRGAN detail × blurred retail colour) did not do better (`factcheck/ct_*.png`). **Now:** the match step matches each channel's mean and standard deviation, and the validator gates each sprite at mean luminance ±2% and mean saturation ±5% of retail. | §W4.1, §W7.1 |
| WF4 | "Medium holds 60 fps everywhere with > 10 ms to spare"; G2 pass, High fine | Medium's crowd + 20 jumping bots is 13.7 ms (polish) and 13.0–15.1 ms across wave 10's final-gate runs, so the margin there is ≈ 1.5–3 ms. **High misses 60 fps in that scene already** (17.1–19.3 ms, `wave10/budgets.md`, "BACKLOG item 9's follow-up") [confirmed]. Trees add ≤ ≈ +0.4–0.7 ms there; they do not cause the miss and cannot fix it. Reported to the user (§W9.2). | §W0, §W6, §W9.2 |
| WF5 | Merged geometry ≈ +23–28 MB at ≈ 80 B per triangle | 80 B/tri is wave 10's layout (52 B per vertex). The wave-12 tree vertex is position 12 + normal 12 + uv 8 + uv2 8 + `sroPivot` vec4 16 + `sroTreeW` vec4 16 = **72 B**; the prototypes have 1.14–1.68 vertices per triangle, so ≈ 116 B/tri [confirmed: `stats.json`, `merge-core.ts`]. The plaza's 400 m resident set merges ≈ 508 k new triangles (LOD1 + LOD2, plants both tiers) [projected: `project12.py` re-run] → ≈ 59 MB, against 19.4 MB measured for retail. **Now:** `sroTreeW` is packed as `unorm8x4` (4 B; the crown AO is data only, F1), giving 60 B per vertex, ≈ 47 MB → **+28–40 MB**. | §W3.4, §W3.8, §W6 |
| WF6 | "Tree triangles in range 35 k → 61 k" stands for the GPU cost | That counts only the **shown** tier. Every merged vertex of LOD1 **and** LOD2 (and both plant tiers) runs the vertex shader every frame; the collapsed ones only skip rasterisation. Submitted triangles all around: plaza 34.5 k (retail) → 183 k (Medium) / 256 k (High), busiest 244 k / 313 k [projected: `project12.py` re-run]. Small on the dev GPU; the M1 row now uses it. | §W6 |
| WF7 | Ultra: "LOD1 casts to the 250 m shadow distance" | `foliageM` is 60 m on High **and** Ultra (`render/quality.ts`); trees cast within 60 m only [confirmed]. | §W6 |
| WF8 | The vec4 tree pivot "matches W11-S's cloth pivot" with no other effect | `RegionBatcher.disposeGroupMesh` counts **any** table mesh with a 4-float `sroPivot` as a cloth group (`clothGroups--`), and `hasClothPivot` is true for it [confirmed: `region-batch.ts`, `foliage-plugin.ts`]. Tree groups would drive the cloth counter negative. T12-M tests `!sroTree` there (cloth plugins only run `clothOn`, so the shader side is safe). | §W3.3, §W8.2 |
| WF9 | `SRO_FOL_BAND` "reads the slot from the pivot" | `SRO_FOL_PIVOT` (and the pivot attribute) is declared only while the plugin **moves** (wind or flutter on, and the weather uniforms present) [confirmed: `pivotOn`]. With no weather part or wind off, the band code would have no pivot, and LOD1 + LOD2 would draw on top of each other. **Now:** `SRO_FOL_BAND` declares the pivot itself (one `vec4` declaration whenever BAND or PIVOT is on) and never depends on the wind. | §W3.3, T12-W |
| WF10 | The merge reads `TEXCOORD_1/2` into `sroTreeW` | `model-cache.ts` extracts only `uv` and `uv2` (no `uvs3`), and the merge remaps `TEXCOORD_1` as a **lightmap UV** into `uv2` [confirmed]. In the lab the wind data went through as a lightmap UV (harmless only because no nature model has a lightmap: 198 nature models, 0 `lightmappedMeshes`), and the VDATA wind was never exercised. **Now:** T12-M also owns `model-cache.ts` (`uvs3`) and `merge-worker.ts` (the transfer list), packs `sroTreeW` from sets 1 and 2, and writes the white lightmap quadrant's centre into `uv2` for swapped species. | §W3.4, §W8.2 |
| WF11 | The swap source returns "the species glb" to `modelFor` | `modelFor` returns a `WorldModel` (index, glb, sidecar, bounds) that the model cache, the material conversion and the atlas key on [confirmed: `trees.ts`]. The only path the lab proved was a manifest whose entries point at the new glbs. **Now [decision]:** the converter's world export appends each species as a manifest model and writes `treeSwap: { model, fit, tint }` on every retail model in `content/trees/swap.json` (like `staticVariant`). The swap stays keyed by the retail source; `modelFor` stays a manifest lookup. | §W3.2, §W8.2 |
| WF12 | Every swapped model is already foliage | `cj_ricestraw` (59 placements, `res\nature\common\cj_ricestraw.bsr`) and the Tarim weed (7, `res\nature\oasis\...`) fail `isFoliageModel` [confirmed: the game's regex over `inventory12.json`], so today they merge as plain objects (no pivot, no band). **Now:** a model with `treeSwap` is a tree claim. | §W3.2 |
| WF13 | Lab CPU numbers "within the noise" | They may also be disturbed (WORLD_EDITOR §9 note 9: its page rendered in the pane during 15:24–15:30, inside this lab's lock). Draws, triangles, memory: unaffected. Not re-run: no decision rests on these CPU figures (`prof.js` at integration decides). Also, draws can **drop**: the maple view went 88 → 73 (retail tint materials outside the table) [confirmed: `look_maple_*.json`]. | §W0, §W5.2 |
| WF14 | The editor re-merge is "≈ 7.5 ms of main-thread mesh creation" | 7.5 ms per region was the pre-worker main-thread **merge** (BATCHING §3.1). With the worker: ≈ 15 ms worker + ≤ 2 ms main-thread jobs (BT-M budget). And WORLD_EDITOR's S-OBJ already owns taking a placement out of its batch (editor-owned standalone copies, a re-batch when editing stops). **Now:** for a swapped tree, S-OBJ's standalone copy is `World.trees.preview` (the species' LOD0), band 3 hides the merged copy instantly, and S-OBJ's re-batch removes it; until then the region caster and the shelter map still hold the old tree. | §W3.9 |
| WF15 | The caster "copies the tier-1 range" at no extra cost | The caster is built on the **main thread** (`mergeCutoutCasters`). Wood groups are casters too (`treeMeta` caster: true), and plants cast their P-LOD0 (tier 1). The heaviest region (24999) holds ≈ 57 k tier-1 triangles ≈ 3.6 MB to copy, and ≈ 76 k merged tree triangles (≈ 8.8 MB at 116 B/tri) against 18 k retail [projected]. **Now:** the merge worker emits the caster's arrays (tier-1 ranges + `sroCull`) with the proxy; the main thread only uploads. The "worker time ≤ +30%" lane budget was unreachable (trees are up to 4× the retail triangles per region); T12-M now keeps BT-M's absolute budgets. | §W3.6, §W6, §W8.2 |
| WF16 | Overlay ≤ 0.3 MB per species | The pine's LOD0 is 6,927 vertices × 44–56 B + indices ≈ 0.36–0.45 MB [confirmed: `stats.json`]. Only the species in use load (2–6 near the camera). | §W3.8 |
| WF17 | "Nine archetypes" | §W7.2 lists ten (broadleaf, conifer_layered, conifer_cone, weeping, bamboo, shrub_dome, deadwood, clump, flower_bed, water_plant). | §W2.2, §W7.2 |
| WF18 | "≈ 15 min of Blender, upscale and sheets (§W7.3)" | §W7.1's steps: ≈ 15 min without the in-game shots, ≈ 35 min with them. | §W2.2 |
| WF19 | Retail foliage glbs not fetched: 6.17 − 0.48 MB | Re-derived: on Medium+ the swapped models fetch 6.33 MB (static variants for the skinned trees and flowers), of which 0.49 MB are the unique trees and tufts → **5.8 MB saved**, net ≈ −1.3 MB [confirmed: file sizes]. The sprites must be embedded **once** per species (in `far.glb`; `near.glb` carries the keys only), or the download doubles them. | §W6 |
| WF20 | The editor's scale range ±15% keeps nav consistent | Nav object instances carry `(id, objId, x, y, z, yaw)`, no scale [WORLD_EDITOR §3, `nav/src/data.ts`]: a scaled tree keeps the retail footprint size (≈ ±7 cm on a 0.5 m trunk). Accepted; said in §W3.9. Also new: the validator checks that each species' trunk base stays inside the retail model's trunk footprint, so players are never blocked by an invisible trunk. | §W3.7, §W3.9, §W7.1 |
| WF21 | "Town" = the Jangan box "256 × 178.7 m" | Those are **half** extents (DATA.md); with them the count is 1,030 [confirmed: re-counted]. | §W1 |
| WF22 | Everything else | **Re-confirmed:** the inventory (5,586 / 119 models; trees 1,695 / 89; plants 3,196 / 24; tufts 695 / 6; swapped 4,886 / 110; 513 skinned plants; batches 376 / 712 / 3,474 / 324 with pine07 136 and dry02 85); the 35 species; the Meshy ledger (J1 30, J2 10 credits; both glbs OPAQUE, `NORMAL/POSITION/TEXCOORD_0` only, 4.3 / 5.3 MB JPEG) and the balance (1,840, re-read); the prototype stats and the tier drifts (pine LOD2 +9% / −14%, willow +11%, maple +17% / +28%, shrub +22%); the ESRGAN gains (1.05–1.32 RGB, 7.02 on dry02's blue); 249 KiB of WebP; every lab draw/triangle/MB/VRAM cell; the wave-10 baselines; `STATIC_VARIANT_KINDS`, `FOLIAGE_MIN_BREEZE` 0.15, `TREE_PIVOT_SIZE` 3, `GROUP_RANGE_M` 202 / 48, `foliageM` 0 / 60 / 60, Medium wind on; Babylon 9.28 merges `world0..3` into one vertex buffer (7 on the overlay holds), binds textures per stage (the vertex sampler does not count against the fragment's 16), has `uv2Updated` before `vMainUV2` (the tint offset needs no varying), and fixes thin-instance normals per axis (the non-uniform fit is lit right); the character screens load through `loadWorld` (`stage/host.ts`), so they show the new trees too [likely]. | — |

---

### §W1. Inventory: every tree and plant (wave 12) [confirmed: `work/tmp/trees/w12/inventory12.py` over the out-opt manifest]

The export has grown since §1 (414 regions, 6,965 placements; the coast's re-snaps and drops, C9). Families are this
spec's grouping, by name and texture. "Town" = inside DATA.md's Jangan safe box (centre 82.7, −198.8; **half** extents 256 × 178.7 m; fact-check W, WF21).

**Trees (1,695 placements, 89 models)**

| Family | Retail models | Placed (town) | Skinned (static variant on Medium+) | Retail triangles | Height m |
|---|---|---:|---:|---|---|
| Dunhuang (`w_cd_gra_*`, `twig0x_tree01`, `tree01..05`, `hotree*`, `brhwood*`, `stumpp*`, `deadtree*` partly) | 22 | 317 (0) | 0 | 96–542 | 3.5–40.7 |
| pine_tall (`tre_pine05..10`, `pine07_01..04`) | 9 | 295 (0) | 0 | 178–976 | 30–58 |
| broadleaf (`tre_tree01/02`, `_big`, `smalltree01`, `leaf01/02`, `gagi01`) | 7 | 212 (54) | 201 | 120–685 | 1.3–48 |
| dry / dead (`tre_dry01..04`, `dry02_small`, `dry02_1`, `dead_tre01`, `w_cd_deadtree01/02`) | 9 | 168 (61) | 0 | 117–270 | 3.1–18 |
| bigmaple (`new-maple/tre_tree03..09`) | 7 | 146 (0) | 0 | 272–441 | 33–77 |
| swamp (`c_swamp_tree02..08`, `swamp_tree01`, `c_hhm_tree_01`) | 9 | 137 (0) | 0 | 72–439 | 3.6–82 |
| bamboo (`tre_bamboo04`) | 1 | 91 (0) | 91 | 382 | 49 |
| maple (`tre_maple01..04*`) | 6 | 91 (58) | 90 | 139 | 17–32 |
| graveyard (`cj_graveyard_tree01..05`) | 5 | 65 (0) | 0 | 122–176 | 35–63 |
| willow (`tre_willow01..03`) | 3 | 64 (10) | 64 | 247–282 | 22–81 |
| ginkgo (`tre_bank01/02/01_big`, `tre_frie01`) | 4 | 62 (30) | 62 | 101–215 | 16–64 |
| pine_small (`tre_pine01..04`) | 4 | 42 (39) | 0 | 131–202 | 7–15 |
| unique town (`cj_bridgetree`, `cj_inn_oldtree`, `cj_oldtree02`) | 3 | 5 (0) | 0 | 636–1,026 | 22–39 |

**Plants (3,196 placements, 24 models) and the hidden tufts**

| Family | Retail models | Placed (town) | Skinned (today: animated clones) | Retail triangles | Size |
|---|---|---:|---:|---|---|
| tall weeds (`grs_weed09_1` 725, `grs_weed06` 429, `grs_weed09_2` 348, `grs_weed06_1` 217, `grs_weed04` 149, `grs_weed09` 68, `grs_weed10` 19) | 7 | 1,955 (46) | 149 | 24–126 | 1.8–8 m tall, up to 15 m wide |
| flowers (`grs_flower_01/02/03/03_1/05`, `flw_g01_yall/wha`, `flw_s01_y/w_ani`) | 9 | 481 (205) | 28 | 10–180 | 0.3–1.3 m |
| barley / rice straw (`cj_barley_02`, `cj_ricestraw`) | 2 | 286 (4) | 0 | 30–68 | 1.5–1.9 m |
| reeds (`fw_cd_reeds_l`) | 1 | 255 (0) | 255 | 86 | 2.2 m, 15 m wide |
| water plants (`grs_water_big`, `c_pondflower`) | 2 | 109 (90) | 109 | 4–32 | 0.3–0.5 m |
| graveyard grass (`cj_graveyard_grass01/03`) | 2 | 103 (0) | 0 | 96–126 | 4.3–5 m |
| Tarim weed (`oas_tarim_dvweed_02`) | 1 | 7 (0) | 0 | 18 | 4.8 m |
| **hidden tufts** (`group_grs01/03_1`, `grass_single03`, `grs_weed01/02/07`; `RETAIL_TUFT_MODELS`) | 6 | 695 (433) | 37 | 6–48 | not drawn on Medium+ (GRASS_LIFE Q12) |

- **The skinned plants keep animated clones today** [confirmed: `batch/trees.ts` `STATIC_VARIANT_KINDS = ['tree',
  'flower']`]: the tall grass, reeds and water plants (`grs_weed04`, `fw_cd_reeds_l`, `grs_water_big`, `c_pondflower`:
  513 placements) keep their retail clip because the h² bend cannot sway a 2 m plant. The new plants carry per-vertex
  flex (§W3.5), so they become static and merged too [decision], which removes those clones.
- **Nothing outside `res\nature` is a plant** except the unique town trees [confirmed: a name search over the other
  folders found only `cj_bridgetree`, `cj_inn_oldtree`, a potato basket and a street stall].
- Per-model rows (placements, kind, bounds, triangles, materials, regions) are in `inventory12.json`.

---

### §W2. How to make them: the bpy route against Meshy, per family (wave 12)

#### §W2.1 The bake-off [confirmed: `work/tmp/trees/w12/meshy/ledger.json`, `bakeoff_meshy.jpg`, NIGHT_LOG 15:05–15:22]

Balance before: **1,880 credits** (more than the ~820 that §2.2 assumed). Two jobs, 40 credits of the 60-credit
design cap, through the repo's `MeshyClient` (`packages/convert/src/remaster/meshy.ts`; the key is read from
`work/secrets/meshy.env` inside the client, never printed). Balance after: 1,840.

| | **Meshy J1: image-to-3D** (the shrub) | **Meshy J2: retexture** (our pine LOD1) | **bpy route** (`make_species.py`) |
|---|---|---|---|
| Input | the upscaled retail sprite `tre_dry02` (1024²), meshy-6, textured 2K, remesh to 1,500 triangles | our pine LOD1 glb (cards + bark), the upscaled retail pine sprite as the style image, original UVs | a species function + the retail sprite and bark (upscaled) |
| Credits / time | 30 / 4 min 19 s | 10 / 1 min 23 s | 0 / 6–21 s per species in Blender (≈ 20–60 min of authoring for a new archetype, 5–10 min for a species on an existing one) |
| Look | a faceted, bright-green "crystal" blob; no leaf silhouette; not SRO's painted style | the cards turned into **solid opaque green slabs**, the trunk green | the retail painted sprites on real branches; reads as the same species, fuller (`review_sheets.jpg`, `before_after_ingame.jpg`) |
| Triangles | 1,312 (one LOD) | 1,212 (kept) | shrub 304 / 40; pine 4,844 / 1,212 / 516; willow 1,858 / 520 / 244; maple 1,928 / 604 / 214 |
| Alpha cut-out | none (`OPAQUE`) | **lost**: the two materials (bark, MASK leaves) merged into one `OPAQUE` material | `MASK` leaves, opaque bark |
| UV / atlas fit | one 2K JPEG (4.3 MB) per model: a whole 1024² atlas page each after downsampling | one 2K JPEG (5.3 MB); UVs kept but the overlapping card UVs share one painted texel area | the retail sprite keys: 512² cells deduped across species (BT-A) |
| LODs | one; each extra LOD = a remesh (5 credits) or our decimation, no shared skeleton | as input | LOD0/1/2 from one skeleton, the same silhouette (§W3.3) |
| Wind data | none (it could be computed from height afterwards) | **dropped**: `TEXCOORD_1/2` removed | flex, phase, flutter, AO per vertex (§3.4 contract) |
| Scale | normalised to ~1.6 m | normalised to ~1 m | fitted to the retail envelope |
| Verdict | **loses** | **loses**: unusable for card foliage | **wins** for every family |

Why Meshy loses here [likely, consistent with both results]: its generators produce a single closed, opaque, textured
surface; foliage that reads well in a game is many alpha-tested cards with per-vertex motion data. Retexture keeps
geometry but not material structure. Both are fixable only by rebuilding what the bpy route already makes.

#### §W2.2 What "speed" means here, honestly

- The slow part of a species is **art direction**, not modelling: choosing the crown structure, card sizes and leaf
  gain so it reads as the retail tree. Meshy does not remove that step; it adds a fix-up step (cut-outs, wind, LODs,
  atlas) that bpy never needs.
- The bpy route's cost per species falls once its archetype exists (§W7.2: 10 archetypes cover the 35 species;
  fact-check W, WF17). The three prototypes cost about 70 minutes of authoring including two tuning rounds [confirmed:
  this session].
- Machine time is small either way: the whole 35-species batch is ≈ 15 min of Blender, upscale and Blender sheets,
  ≈ 35 min with the in-game shots (§W7.1; fact-check W, WF18).

#### §W2.3 Route per family [decision]

| Family | Species (new models) | Archetype (§W7.2) | Route | Why |
|---|---|---|---|---|
| maple | `maple03` (tints green / green2 / middle / red / brown by swap entry) | broadleaf | bpy (prototype) | done; cards carry the retail tints |
| pine_tall: `tre_pine07_01..04` | `pine07` | conifer_layered | bpy (prototype) | done |
| pine_tall: `pine05/06/08/09` / `pine10` | `pine08`, `pine10` | conifer_layered / broadleaf (pine10's sprite is a leafy branch) | bpy | same archetype as the prototype |
| pine_small | `pine_small` | conifer_cone | bpy | 39 of 42 in town: hero visibility |
| bigmaple | `bigleaf` | broadleaf (tall) | bpy | shares pine08's bark, as retail |
| broadleaf | `broad02`, `broad01` | broadleaf | bpy | 201 skinned today |
| ginkgo | `ginkgo` | broadleaf (columnar) | bpy | 30 in town |
| willow | `willow03` | weeping | bpy (prototype) | done |
| bamboo | `bamboo04` | bamboo (culm clump + leaf sprays) | bpy | culms are tubes, sprays are cards |
| dry02 green bushes | `shrub02` | shrub_dome | bpy (prototype) | done |
| dry / dead (bare) | `deadwood_a`, `deadwood_b` | deadwood (bark + twig cards) | bpy; **Meshy contingency** (§W2.4) | solid wood is the one place Meshy's output type fits |
| graveyard | `grave_tree` | conifer_layered | bpy | |
| swamp | `swamp_a`, `swamp_b` | broadleaf (gnarled, leaning) | bpy | |
| Dunhuang | `dh_poplar` (`w_cd_gra_*`), `dh_twig`, `dh_tree`, `dh_hotree`, `dh_brush` (brushwood and the 4 stumps, bark only) | broadleaf / deadwood | bpy | western regions; last batch |
| tall weeds | `weed_tall` (09 family), `weed_mid` (06 family), `weed04`, `weed10` (+ the Tarim weed) | clump | bpy | 1,955 placements: the biggest family |
| barley / rice straw | `barley`, `ricestraw` | clump | bpy | |
| reeds | `reeds` | clump (tall blades) | bpy | 255 skinned clones today |
| flowers | `flower_y`, `flower_w`, `flower_bush` | flower_bed | bpy | butterflies anchor on these placements (GRASS_LIFE) |
| water plants | `lily_pads`, `pond_flower` | water_plant | bpy | 90 in town |
| graveyard grass | `grave_grass` | clump | bpy | |
| unique town trees | — | — | **stay retail** (batched as buildings) | partly buildings |
| hidden tufts | — | — | **stay hidden** | GRASS_LIFE Q12 |

**35 species, 110 retail models, 4,886 placements.** SDXL (local, ComfyUI through `start_comfyui.sh` /
`stop_comfyui.sh`, GPU lock) only where a family needs variety its sprite lacks; the default list is empty (§W9 Q-W3).

#### §W2.4 Meshy budget for the build [decision]

- **Trees and plants: 0 credits planned.** No family uses Meshy.
- **Contingency: ≤ 90 credits** (3 image-to-3D jobs at 30) for the bare dead trunks (`deadwood_*`, `dh_brush`) **only
  if** the user rejects the bpy dead trees on their review sheet. Bare wood has no cut-out leaves, so Meshy's output
  type fits; the wind data is then computed from height and distance to the trunk axis, and the LODs by our decimation.
- That is ≤ 90 of WAVE_PLAN8's default 600-credit build cap (keeping ≥ 200 in reserve); every job is logged in
  `work/night/NIGHT_LOG.md`.

---

### §W3. Runtime design (wave 12): the swap inside the region batch

#### §W3.1 Who owns what (one owner per module; no double draws) [decision]

| Module | Owner lane | Draws what | Never draws |
|---|---|---|---|
| `content/trees/swap.json` + `trees/swap.ts` (new) | T12-A (data), T12-N (code) | nothing: maps a retail source → species, fit scale, tint slot | — |
| **The region batch** (`batch/trees.ts`, `merge-core.ts`; BT-T) | T12-M | **every foliage placement's LOD1 and LOD2** (and the plants' two tiers), merged per region as today: (region, LOD group, leaf \| wood, cut-out \| opaque) | LOD0 |
| **The near field** (`trees/near-field.ts`, new) | T12-N | the **LOD0 overlay**: one thin-instance mesh per (species, leaf \| wood), holding the band-0 trees | anything beyond band 0; plants |
| **The band texture** (`trees/bands.ts`, new) | T12-N | nothing: one byte per foliage placement (0 near, 1 mid, 2 far, 3 hidden) | — |
| BT-S cut-out caster (`render/shadows.ts`) | T12-M (one rule) | the LOD1 tier only (§W3.6) | LOD0, LOD2 |
| `region-chunk.ts` / objects (Low, the batch-off fallback) | unchanged | the retail trees exactly (the Low guard) | new trees |

**No double draw by construction**: a tree's LOD0 (overlay) shows only while its band byte is 0, and the merged
LOD1/LOD2 vertices of that tree collapse to its root whenever the byte differs from their own tier. One byte, read by
both, decides.

#### §W3.2 The swap, keyed by the retail model (unchanged principle, new hook) [decision]

- `content/trees/swap.json` (format of §3.1, extended): `"<retail source>": { "species": "pine07", "fit": [sxz, sy],
  "tint": "<texture key>" }`. The fit is the retail envelope over the species' envelope (the lab used exactly this:
  `lab/prep.ts`, e.g. `tre_pine07_03` → `pine07` × 1.075 / 0.667).
- **Hook:** `RegionBatcher.modelFor` already redirects a skinned foliage model to its static variant (BT-T). It gains
  one more redirect: a swapped model loads `trees/<species>/far.glb` (LOD1 + LOD2, see §W3.3) with the fit folded into
  the placement matrix. The retail glb of a swapped model is **never fetched** on Medium+.
- *(fact-check W, WF11, WF12)* **How the redirect finds a model [decision]:** `modelFor` returns a `WorldModel`, which
  the model cache, the material conversion and the atlas key on. So the converter's world export appends each species
  as a manifest model (its `far.glb`, sidecar and bounds) and writes `treeSwap: { model, fit, tint }` on every retail
  model listed in `content/trees/swap.json`, the same way `staticVariant` works. The swap stays keyed by the retail
  source; `graphics.trees: 'retail'` ignores `treeSwap`. This is the path the lab proved (a manifest pointing retail
  entries at the new glbs). A model with `treeSwap` is always a **tree claim**: `cj_ricestraw` (59 placements, outside
  a `tree|grass|flower|reed` folder) and the Tarim weed (7, under `nature\oasis`) fail `isFoliageModel` today and would
  otherwise merge as plain objects without pivot or band.
- **Kept from §3.1:** placements, rotation, nav footprints, `GROUP_RANGE_M` ranges, baked terrain shadows; Low draws
  retail; an unmapped or failed model draws retail with a warning; `graphics.trees: 'new' | 'retail'` (Options) with a
  `stream.rebuild()` on change; the claim keys on the render path, not on `animated`.
- **The hidden tufts stay hidden**: `RETAIL_TUFT_MODELS` is applied in `region-chunk.ts` before anything else, so the
  swap never sees them. The 5 unique town trees are not in the swap table.

#### §W3.3 Tiers, bands and the band byte [decision]

| Tier | Where it lives | Band (distance − radius, × rangeScale) | Trees: triangles cap | Plants |
|---|---|---|---|---|
| **LOD0** | the near field (thin instances, one mesh per species × leaf/wood) | 0: < 40 m | ≤ 3,500 (≥ 30 m tall: ≤ 4,500) | — (plants have no overlay) |
| **LOD1** | the region batch (merged) | 1: 40–110 m | ≤ 1,200 | P-LOD0: < 25 m, ≤ 320 |
| **LOD2** | the region batch (merged) | 2: 110 m – the group range (+10) | ≤ 520 (retail-like big cards) | P-LOD1: 25 m – range, ≤ 90 |

- **Hysteresis 3 m**, refill when the camera moved ≥ 4 m or the range scale changed (Options' sight, SCREENS' 0.6):
  the near field writes the band byte of every resident foliage placement and rebuilds its overlay instance lists
  (≤ 0.1 ms for ≈ 1,500 resident placements [projected: 16 floats + 1 byte each]).
- **The band texture**: R8, 128 × 64 = 8,192 slots (5,586 placements today + editor headroom), uploaded whole on a
  refill (8 KB). A slot is handed out by the near field when a region places a foliage placement (a free list keyed by
  the placement uid), before the region's merge job is built, so the worker can write it.
- **The merged vertex** carries the slot and its tier in the pivot: `sroPivot` becomes **vec4** for trees (xyz = the
  root, as BT-T today; w = slot × 4 + tier), the same 4-float layout W11-S already uses for cloth. The foliage plugin's
  new `SRO_FOL_BAND`: `band = texelFetch(sroTreeBand, slot)`; if `band != tier` the vertex moves to the root (zero
  area, as BATCHING §3.8's group-3 collapse). One vertex-stage sampler; **no varying** [likely; T12-W proves it with
  `wgslInterStageCount`]. Babylon 9.28 binds each texture with the visibility of the stages that use it
  (`webgpuShaderProcessor.js`), so the vertex sampler does not count against the fragment's 16 [confirmed].
- *(fact-check W, WF9)* **The band never depends on the wind.** Today `SRO_FOL_PIVOT` and the `sroPivot` declaration
  exist only while the plugin moves (wind or flutter on and the weather uniforms present: `pivotOn`). `SRO_FOL_BAND`
  is switched on by the mesh carrying the 4-float tree pivot, whatever the wind, and the plugin declares the attribute
  once, as `vec4`, whenever BAND or PIVOT is on. Otherwise a world without weather (or wind off) would draw LOD1 and
  LOD2 on top of each other.
- *(fact-check W, WF8)* **The cloth counter.** `RegionBatcher.disposeGroupMesh` counts any table mesh with a 4-float
  `sroPivot` as a cloth group, and `hasClothPivot` is true for it [confirmed]. T12-M adds `!sroTree` to that test; the
  shader side is safe (only a cloth plugin runs `clothOn`).
- **Why a byte and not a distance test in the shader:** the shader alone cannot do hysteresis, and the CPU's choice of
  overlay instances must match the shader's choice exactly. The byte also gives the World Editor its live hide (band 3,
  §W3.9).
- **Pops:** a hard switch with hysteresis on every preset (wave 10's F9 rule stands: no working TAA reprojection). The
  three tiers come from one skeleton, so silhouettes match. The prototype is not there yet (LOD1 2–22% and LOD2 up to
  28% off LOD0's height or width, §W5.1); the validator caps every tier at ±10% of LOD0 and the generator clips the
  far cards to LOD0's box.
- **Draws:** the merged groups are the wave-10 draws, unchanged (one per region key). The overlay adds **2 per species
  with a tree in band 0** (leaf, wood). Projected all around the camera [`project12.py`]: plaza +4 (Medium) / +6
  (High), the busiest spot (20, −220) +10 / +12.
- **Why the impostors are dropped** [decision]: wave 10's impostor array was there to make far trees one draw; BT-T's
  region merge already does that. Impostors would add 85–150 MB of RGBA8 VRAM (§3.7), a ShaderMaterial with its own
  fog / SH / cloud-shadow / wet path in WGSL and GLSL, no prepass (SKY2's depth effects see sky), and a lighting seam
  at the switch. LOD2 (retail-like big cards, ≤ 520 triangles) reuses the PBR path. Impostors come back only if the
  lab shows LOD2 shimmering at 150–280 m (scope item, §W10).

#### §W3.4 What the merged vertex carries, and the 16-varying rule [decision]

| Stream | Content | Note |
|---|---|---|
| position, normal | world space (BT-T) | |
| uv | the sprite / bark UV | |
| uv2 | the table's (slot, lightmap layer) in its integer part (BATCHING §3.3) | taken: so the wind data cannot stay in `uv2` |
| `sroPivot` vec4 | root xyz, w = band slot × 4 + tier | attribute |
| `sroTreeW` vec4 (new) | flex, phase, flutter, crown AO (from the glb's `TEXCOORD_1/2`, the §3.4 contract, V-decoded by the merge worker) | attribute; *(fact-check W, WF5)* packed as `unorm8x4` (4 B, both backends), since the AO is data only (F1) and 8 bits hold every channel |

- 6 vertex buffers on a merged tree group, 7 on the overlay (+ the instance matrix), under WebGPU's default 8
  `maxVertexBuffers` [projected; T12-M/T12-N assert it]. Babylon 9.28 merges `world0..3` of the thin-instance matrix
  into one vertex buffer (`webgpuCacheRenderPipeline.js`), so the overlay's 7 holds [confirmed].
- *(fact-check W, WF5)* **Bytes per merged vertex:** wave 10's trees carry 52 B (position, normal, uv, uv2, vec3
  pivot); wave 12's carry 60 B with `sroTreeW` as `unorm8x4` (72 B as float32). The prototypes have 1.14–1.68 vertices
  per triangle, so ≈ 93 B per merged triangle (§W3.8).
- *(fact-check W, WF10)* **Where the data comes from:** `model-cache.ts` extracts only `uv` and `uv2` today, and the
  merge treats `TEXCOORD_1` as a **lightmap UV** (it remaps it into the lightmap quadrant) [confirmed]. T12-M therefore
  owns `model-cache.ts` (`uvs3`) and `merge-worker.ts` (the transfer list), builds `sroTreeW` from sets 1 and 2, and
  writes the white lightmap quadrant's centre into `uv2` for swapped species (no nature model has a lightmap: 198
  models, 0 `lightmappedMeshes`). In the lab the wind data went through as a lightmap UV, which was harmless only
  because it sampled white, and the VDATA wind was never exercised.
- **No `COLOR_0`, no instance colour, no new varying** (F1, F18 stand). The tint of an overlay instance is a
  per-instance **slot offset added to `uv2.y`** in the vertex stage, which the table decode already reads (`floor(uv2/2)`):
  one overlay draw per species for all its tints, no new varying [likely; T12-N's test].
- The glb format stays the §3.4 contract (`TEXCOORD_0..2`, no `COLOR_0`); only the merge repacks it.

#### §W3.5 The wind contract (wave 12) [decision]

- Trees and plants: `SRO_FOL_VDATA` (T12-W) bends each vertex by its own flex around its tree's root:
  `offset = windDir × max(wind, TREE_BREEZE) × (flex² × A × sin(t × 1.1 + phase × 6.28) + 0.3 × flex × gust)` and
  flutters cards by `flutter × (0.012 + 0.05 × strength)` along the card normal. `TREE_BREEZE` = BT-T's tuned
  `FOLIAGE_MIN_BREEZE` (0.15), so calm air still sways.
- **A** is per material in the table (one float): trees 1.2 m, plants 0.25 m. That is what lets a 2 m reed sway 0.3–1 m
  (the retail clips measured by BT-T: 0.3–1 m at 2–4 m), which the h² bend could not do. So the 513 skinned plant
  clones become static and merged [decision; the T12-W lab compares the sway with the retail clips].
- Without the define (Low has no batch; `graphics.trees: 'retail'`), nothing changes.

#### §W3.6 Shadows [decision]

- **Medium:** no tree casts a dynamic shadow (as today); the baked terrain shadow stays under the retail envelope.
- **High / Ultra:** BT-S's one cut-out caster per region casts **the LOD1 tier only**: the merge emits each group's
  tier-1 triangles as one contiguous index range, and the caster copies that range (no collapse code in the caster
  shader). LOD0 (overlay) and LOD2 never cast. Caster draws stay one per region: **unchanged from wave 10**. The shadow
  is LOD1's silhouette, which matches LOD0 within the validator's ±10%.
- *(fact-check W, WF15)* **Who builds the caster.** Today the caster's vertex data is copied on the **main thread**
  (`mergeCutoutCasters`, one region per refresh), and every tree group, wood included, is a caster (`treeMeta`). The
  plants cast their tier 1 (P-LOD0, ≤ 320 triangles each). The heaviest region (24999) would copy ≈ 57 k tier-1
  triangles ≈ 3.6 MB per build [projected]. So the merge worker emits the caster's arrays (the tier-1 ranges of the
  tree groups plus the other cut-out groups, with `sroCull`) next to the proxy, and the main thread only uploads them.
- *(fact-check W, WF14)* A tree hidden by band 3 (the editor) still casts and still shelters the rain until its region
  is re-batched; the caster and the shelter map do not read the band.

#### §W3.7 Collision, nav, picking, weather, life [confirmed by construction; [likely] where tagged]

- Nav and collision: unchanged. Trees block through the retail navmesh footprints (`nav.bin`, `nav-objects.bin`);
  the new crowns stay inside the retail envelope. *(fact-check W, WF20)* The envelope rule alone does not place the
  trunk: the validator also checks that each species' LOD0 trunk base, after the swap's fit, lies inside the retail
  model's trunk base (its lowest bark ring) within 0.3 m, so nobody is stopped by an invisible trunk or walks through
  a visible one.
- Picking: none (tree meshes are not pickable).
- Rain shelter: the shelter map renders the region batch meshes with its own depth material, so both LOD1 and LOD2 of
  a canopy shelter [likely]; LOD2 sits inside LOD1's volume, so the map is right.
- Butterflies (GRASS_LIFE) anchor on flower placements, which stay where they are.
- Town life (wave 11) places no new trees [likely: TOWN_LIFE's census lists stalls, tables, lamps, signs]; any future
  dressing that uses a retail foliage source is swapped automatically.

#### §W3.8 Streaming and memory [projected unless tagged]

- Species glbs load once per world (ref-counted by the regions that use them): `far.glb` for the merge, `near.glb` for
  the overlay.
- **Merged geometry** grows: measured with 4 families swapped, the plaza's resident tree groups went 19.4 → 22.4 MB
  (LOD1) [confirmed: lab]. *(fact-check W, WF5)* With all 35 species (LOD1 + LOD2 merged, plants both tiers) the
  plaza's 400 m resident set merges ≈ 508 k triangles; at the wave-12 layout's ≈ 93 B per triangle (`sroTreeW` as
  `unorm8x4`; ≈ 116 B as float32) that is ≈ 47 MB (≈ 59 MB), from 19.4 MB today: **≈ +28–40 MB** [projected:
  `project12.py` re-run]. The first draft's ≈ 80 B per triangle was wave 10's layout.
- **Overlay:** ≤ 0.36–0.45 MB of GPU geometry per species (the pine's LOD0 is 6,927 vertices; fact-check W, WF16), only
  the species in use (2–6 near the camera at the bench spots).
- **Textures** *(fact-check W, WF2: this replaces "2× on Medium+, texture quality Low keeps 1×", an Option that does
  not exist)*: the sprites follow `graphics.textures` like every TX-R texture (`pbr/maps.ts` `textureTierFor`).
  Medium 'auto' is the retail-size remaster tier, so the species glbs embed the **retail-size** sprite (made from the
  4× ESRGAN pass and colour-matched: sharper, same texels): ≈ +0 VRAM. High and Ultra ('2x' / 2048), or a pinned 1024 /
  2048, load the 2× sprite as a TX-R tier of the new key: measured +13 MiB at the plaza for 8 sprites (572 → 585 MiB,
  WebGPU Medium) [confirmed: lab], which is about one atlas-layer step (1.6 MiB per sprite measured, 0.6 MiB in
  theory), so ≈ +26–73 MiB for the ≈ 45 sprites [projected].

#### §W3.9 The World Editor's library [decision]

- **What the library lists:** one entry per species (`content/trees/library.json`, written by the T12-A build): id,
  display name ("Chinese pine", "Willow"...), the review-sheet thumbnail, the size range, the default tint and the
  **retail carrier model** (the swap source with the closest envelope).
- **Placing** a species = adding a placement of its carrier model (WORLD_EDITOR's layered placement edits by uid), with
  the chosen yaw, scale (the retail sizes ±15%) and ground snap. So: Low shows the retail tree, the swap shows the new
  one, and the carrier's retail nav footprint goes into the editor's automatic walkable-area rebuild.
- **Live preview:** while dragging, the editor shows a one-instance overlay of the species' LOD0 and sets the edited
  placement's band byte to 3 (hidden), so its merged copy disappears at once; on drop, the region re-merges in the
  batch worker and the byte returns to its band. *(fact-check W, WF14)* The re-merge costs ≈ 15 ms in the worker plus
  main-thread jobs within BT-M's ≤ 2 ms budget; the "7.5 ms" of the first draft was the pre-worker main-thread merge
  (BATCHING §3.1). **Seam with WORLD_EDITOR's S-OBJ:** S-OBJ owns taking an edited placement out of its region batch
  (editor-owned standalone copies, a re-batch when the user stops editing the region). For a swapped tree, S-OBJ's
  standalone copy **is** `World.trees.preview` (the species' LOD0, not the retail converted model), band 3 hides the
  merged copy until S-OBJ's re-batch lands, and the old tree's shadow and rain shelter stay until then.
- *(fact-check W, WF20)* **Scale and nav:** nav object instances carry no scale (`(id, objId, x, y, z, yaw)`), so a
  tree scaled ±15% keeps its retail footprint size (≈ ±7 cm on a 0.5 m trunk) [accepted].
- **Delete / revert:** delete hides by band 3 then re-merges without it; one-click revert restores the uid's original.
- The API the editor calls: `World.trees.library()`, `World.trees.preview(uid | null, species, matrix)`,
  `World.trees.setHidden(uid, on)` (T12-E, §W8).

---

### §W4. Look targets per family (keep SRO's painterly identity) (wave 12)

#### §W4.1 Rules for every species [decision]

1. **The leaves are the retail paintings**, upscaled 2× with Real-ESRGAN x4plus and **colour-matched per channel to
   the retail sprite's mean** (opaque pixels). The prototype measured why this step is needed: x4plus darkened the
   sprites by 5–25% and crushed blue (gains 1.05–1.32 on RGB, up to 7× on the blue of `tre_dry02`) [confirmed:
   `upscale.py` + the match]. Alpha is upscaled separately and re-thresholded at 0.5 (coverage kept within 1%).
   *(fact-check W, WF3)* The mean match gets luminance within 1% but not the spread: blue p5/p50/p95 goes 2/13/24 →
   0/7/42 on `tre_dry02` and 16/28/41 → 0/20/80 on the willow leaf, and saturation rises 0–8% [confirmed:
   `factcheck/colour_transfer.py`]. So the match is per channel on **mean and standard deviation**, and the validator
   gates each sprite at mean luminance ±2% and mean saturation ±5% of retail. Medium embeds the retail-size result; the
   2× result is the High+ tier (WF2).
2. **The envelope** stays the retail model's (±10% height and width, per retail model by the swap's fit).
3. **Crown luminance in game within ±10% of the wave-10 retail crown** at the family's bench spot (the §4.3 method:
   pixel means over the crowns, same camera, same time). The prototype misses this today (§W5.2): the new crowns are
   darker and more saturated. *(fact-check W, WF1)* Measured on the lab frames (`factcheck/crown_luma.py`): maple
   0.414 → 0.205, willow 0.454 → 0.236, pine 0.309 → 0.231, shrub level; saturation up by 0.09–0.26 [confirmed].
   Because the sprites match retail (rule 1), the cause is lighting, so the build **first splits the cause** in the
   T12-L lab with three A/Bs on the maple and the willow: (a) the new geometry with the retail sprite keys (their TX-R
   map sets on); (b) card normals pointing to the camera-facing side, as retail's doubled cards do (merge-core emits
   retail two-sided leaves twice with negated normals); (c) translucency on / off. Only then the levers, in order:
   the card-normal rule that (b) picks, the TX-R map set (rule 3's last sentence), fewer back-row cards, and the
   species' leaf gain (a table value, at most ×1.3, so the painted texture never burns). Where the retail texture has a TX-R map set (B1: `tre_willow03_leaf01/02`,
   `tre_pine07_01/02`, ...), the new sprite key gets the same map set or the same albedo, since the retail look in game
   includes it [likely: the retail willow's bright lime].
4. **No photo textures, no new palette**: olive, sage, rust, gold, the retail bark colours. Bark is the retail bark
   upscaled (texpipe PBR maps optional, §W10).
5. **Cards are authored front + back**, both normals bent towards the crown's outside, and the leaf material is
   single-sided, so the region merge does not double them again and a back face is never lit as "inside"
   [confirmed: the first prototype round's dark crowns came from two-sided lighting flipping the bent normals].
   *(TREE-TUNE, §WT)* The bend is now 0 under `mirror` and `dim` (the face the camera sees is lit from its own side,
   as a retail two-sided card is), and each species takes its retail cards' normal rule; `same` is refused.

#### §W4.2 Per family

| Family | Target look | Prototype status / notes |
|---|---|---|
| maple | round, decurrent crown on 4–5 spreading limbs; the retail tints and the red autumn highlights; light through the leaves | built; in game **half** the retail crown luminance (fact-check W, WF1) → the §W4.1 rule-3 A/Bs first, keep the red |
| pine07 (Chinese pine) | a straight red-brown trunk, horizontal **layered pads** like an ink-painting pine, a flat top | built; reads right; bark too purple and banded in game → −20% saturation, warmer; pads +15% |
| pine08 / pine10 / pine_small / grave_tree | the same layered language, conical for the small town pines | archetype ready |
| bigleaf, broad01/02, ginkgo, swamp | full rounded crowns on visible limbs; ginkgo columnar; swamp leaning and gnarled | archetype ready (maple's) |
| willow | a dome of hanging strands down to about a third of the height, the trunk visible inside | built; the best shape of the four, but its crown is 48% darker than the retail lime (fact-check W, WF1) → match its map set, then the rule-3 A/Bs |
| bamboo | 12–20 culms in a clump, leaf sprays at the nodes, slight lean outwards | new archetype |
| shrub02 | a dense dome sitting on the ground | built; LOD1 floats ~0.3 m → anchor its cards at ground level |
| deadwood | bare, twisted limbs with a few twig cards; no green | new archetype (or the Meshy contingency) |
| Dunhuang | dry-country poplars and twiggy desert trees in the retail ochre and dusty green | archetypes ready |
| tall weeds, reeds, barley, graveyard grass | clumps of 8–24 crossed and fanned blade cards from the retail sprites, wider at the top, swaying from the base | new archetype (clump) |
| flowers | low beds of the retail flower sprites, upright heads | new archetype |
| water plants | flat pads on the water plane plus a few upright flowers | new archetype |

---

### §W5. The prototypes (wave 12): three more families end to end, plus the maple

#### §W5.1 What was built [confirmed: `out/*.stats.json`, `optsize12.ts`]

| Species (retail) | LOD0 / LOD1 / LOD2 triangles | Cards (front + back) LOD0 | Envelope h × w (retail) | out-opt geometry, no textures | Blender time |
|---|---|---|---|---|---|
| `pine07` (`tre_pine07_04`, 48.6 × 42.7 m) | 4,844 / 1,212 / 516 | 1,264 | 48.6 × 42.8 / 49.6 × 40.7 / 52.9 × 36.7 | 133 / 38 / 17 KB | 21 s [confirmed; 2× textures embedded] |
| `willow03` (`tre_willow03`, 81.0 × 97.3 m) | 1,858 / 520 / 244 | 480 | 78.7 × 97.3 / 78.6 × 97.4 / 87.5 × 97.1 | 65 / 25 / 15 KB | under 21 s [likely ≈ 8 s] |
| `shrub02` (`tre_dry02_small`, 4.2 × 6.2 m) | 304 / 40 | 68 | 4.0 × 7.0 / 4.9 × 7.5 | 13 / 4 KB | under 21 s [likely ≈ 6 s] |
| `maple03` (`tre_maple03`, 16.7 × 17.5 m) | 1,928 / 604 / 214 | 500 | 16.7 × 17.6 / 18.5 × 20.6 / 17.2 × 22.5 | 56 / 24 / 11 KB | under 21 s [likely ≈ 7 s] |

- The pine's LOD0 is over the 3,500 cap (§3.3); its bark is 2,316 triangles. The ≥ 30 m class gets a 4,500 cap and
  the generator trims level-2 bark sides (3 → 2) [decision]. The far tiers drift from LOD0: pine LOD2 +9% height and
  −14% width, willow LOD2 +11% height, maple LOD1 +17% and LOD2 +28% width, shrub LOD1 +22% height. The validator's
  ±10% bound catches all of them; the generator clips the far cards to LOD0's box [decision].
- Sprites: 8 retail sprites upscaled in **31.5 s** of GPU time (16 images incl. alpha; Real-ESRGAN start-up included)
  [confirmed], 249 KB as WebP q85 at 2× [confirmed: PIL].
- The scripts are a generalised `make_tree.py` (species functions, three tiers, no `COLOR_0`, cards front + back).

#### §W5.2 In the real renderer [confirmed: `shots/*.json`, GPU lock 15:24–15:32]

The lab page loads the real out-opt export through `loadWorld` with the game's defaults. Its server rewrites the
manifest so the 16 swapped retail models (maple, pine07, willow, dry02) point at the new tiers (`/outs0/` = LOD0,
`/outs1/` = LOD1), scaled to each retail envelope: **BT-T's real region batch merged the new geometry**, through the
real material table and atlas, with the foliage plugin's wind and translucency. 300 frames per run after streaming
went idle; the CPU column is `scene.render` time (the lab's timer pump; the in-game `prof.js` gate stays the judge).

| Scene (1080p) | Variant | Draws / frame | CPU p50 / p95 ms | Tree triangles in view | Resident tree groups: triangles / MB | Texture VRAM MiB |
|---|---|---|---|---|---|---|
| Plaza wide, WebGPU Medium | retail (wave 10) | 87 | 3.2 / 5.7 | 33 k | 248 k / 19.4 | 572 |
| | new LOD1 merged | 87 | 2.8 / 5.0 | 47 k | 270 k / 22.4 | 585 |
| | new LOD0 merged (worst case) | 87 | 2.1 / 4.0 | 117 k | 419 k / 33.8 | 586 |
| Plaza wide, WebGPU High | retail | 125 | 3.4 / 5.7 | 46 k | 315 k / 24.2 | 1,191 |
| | LOD1 | 126 | 3.0 / 5.0 | 65 k | 337 k / 27.4 | 1,158 |
| | LOD0 | 126 | 3.4 / 5.6 | 155 k | 506 k / 40.4 | 1,159 |
| Plaza wide, WebGL2 Medium | retail / LOD1 | 88 / 88 | 1.7 / 3.0 → 1.3 / 2.5 | 33 k → 47 k | 248 k → 270 k | 564 → 578 |
| Pine forest (north), WebGPU Medium | retail / LOD1 / LOD0 | 27 / 27 / 28 | 1.5 / 3.0, 0.9 / 1.9, 1.5 / 3.5 | 10 k / 21 k / 68 k | 102 k / 141 k / 324 k; 7.5 / 11.0 / 25.9 MB | 302–314 |
| Pine forest, WebGPU High | retail / LOD0 | 64 / 64 | 1.6 / 3.0 → 1.5 / 2.6 | 10 k → 68 k | 124 k → 431 k; 8.8 → 34.3 MB | 698 → 708 |

What it shows:

- **Draws do not move**: the merge absorbs the new geometry. The only new draws in production are the overlay's
  (§W3.3), which the lab did not need to build to show this. *(fact-check W, WF13)* They can even drop: the maple look
  view went 88 → 73 draws (retail tint materials outside the table) [confirmed: `look_maple_*.json`].
- **CPU: no cost shown**; the differences are inside the run-to-run noise (± 1 ms on this page) [confirmed]. Wave 10's
  F7 lesson stands: `prof.js` in the game decides. *(fact-check W, WF13)* The CPU runs may also have been disturbed by
  the World Editor's page rendering in the same pane at 15:24–15:30 (WORLD_EDITOR §9 note 9); not re-run, because no
  decision rests on them.
- *(fact-check W, WF10)* The lab merged the new glbs with `TEXCOORD_1` read as a lightmap UV and `TEXCOORD_2` dropped,
  so it showed the h² wind, not the §W3.5 VDATA wind; T12-W's storm check is the first real test of it.
- **Triangles in view ×1.4 (LOD1) to ×3.5 (LOD0, every tree at full detail)** for only 376 of 4,886 placements; the
  real mix (LOD0 only within 40 m) is near the LOD1 row plus a few LOD0 trees.
- **GPU time was not captured**: the WebGPU timestamp counter stayed empty under the manual frame pump [unknown]; the
  GPU budget is [projected] from triangles and overdraw (§W6).
- **Look** (`before_after_ingame.jpg`, WebGL2 Medium, the game camera: fov 0.85, beta 1.2–1.36): the maples gain
  real round crowns; the willow becomes a full weeping dome; the pines read as layered Chinese pines; the shrub change
  is small at this range. The faults: darker and more saturated crowns than retail, the pine bark too purple (§W4.2).

#### §W5.3 What the wave-12 prototypes taught [confirmed]

1. **The swap works through BT-T unchanged**: a manifest pointing a retail model at a new glb + a sidecar with new
   texture keys is enough for the batcher, the table, the atlas (it decodes the glb's embedded image) and the class
   rules (`tre_*` + OPAQUE = wood; MASK under `nature/` = foliage).
2. **Cycles needs 128 transparent bounces** for card crowns, or deep crowns turn black on the review sheets (the
   default stops at 8 layers). Review sheets also turn tree shadows off, matching Medium.
3. **ESRGAN darkens painted sprites**: the colour match is a required pipeline step.
4. **Meshy's output types do not fit card foliage** (§W2.1).
5. **The retail look in game includes TX-R map sets**: the new keys must inherit them or match their albedo.

---

### §W6. Budgets per preset (wave 12; WAVE_PLAN6 §5 format; 1080p) [projected unless tagged]

Dev PC = Ryzen 5 9600X + RX 9060 XT, Chrome. Baselines = the **wave-10 polish re-bench** (frame p95, WebGPU / WebGL2;
`wave10/budgets.md`) [confirmed]. The trees add: the overlay's draws (≤ 12 at the busiest spot × ≈ 18 µs), the
refill (≤ 0.1 ms per 4 m), and GPU triangles / alpha-tested overdraw (≈ 2–4× the tree triangles in view); the merged
LOD1/LOD2 add no draws (§W5.2). *(fact-check W, WF6)* The vertex work is larger than the shown triangles: every merged
LOD1 **and** LOD2 vertex (and both plant tiers) is shaded every frame, collapsed or not. Submitted triangles all around
the camera: plaza 34.5 k (retail) → ≈ 183 k (Medium) / 256 k (High); busiest ≈ 244 k / 313 k [projected:
`project12.py` re-run]; in view roughly a third to a half of that. The GPU column below includes it.

**Frame p95 on the dev PC, wave 10 polish (measured) → wave 12 trees (projected), ms:**

| Preset | Plaza noon | Fields night | Meadow noon | Crowd | Beach noon | Pass line |
|---|---|---|---|---|---|---|
| Low | unchanged (retail trees) | unchanged | unchanged | unchanged | unchanged | pass |
| **Medium** | 3.9 / 3.1 → **≈ 4.1–4.4 / ≈ 3.3–3.5** | 6.3 / 4.8 → ≈ 6.5–6.8 / ≈ 5.0–5.2 | 4.7 / 3.3 → ≈ 5.0–5.3 / ≈ 3.5–3.8 (the weeds family) | 5.7 / 3.8 → ≈ 5.9–6.2 / ≈ 4.0–4.2 | 1.5 / 1.0 → ≈ 1.5–1.6 | **G1 < 16.7 everywhere: pass** (worst: crowd + 20 bots 13.7 → ≈ 14.0; *fact-check W, WF4:* wave 10's runs of that scene spread 13.0–15.1, so ≈ 13.3–15.4, a margin of ≈ 1.3–3 ms) |
| **High** | 6.1 / 3.5 → **≈ 6.4–6.8 / ≈ 3.8–4.1** | – | 5.9 → ≈ 6.3–6.7 | 8.1 → ≈ 8.4–8.8 | – | **G2 ≤ 12 plaza, ≤ 14 crowd: pass.** *(fact-check W, WF4)* Crowd + 20 bots: 17.1–19.3 ms **before** the trees (wave 10's final gate; BACKLOG item 9: animation LOD, character batching), ≈ +0.4–0.7 with them: High misses 60 fps there, and the trees can neither cause nor fix it |
| Ultra | as High; *(fact-check W, WF7)* `foliageM` is 60 m on Ultra too, so LOD1 casts within 60 m (not to the 250 m shadow distance) | | | | | not a default |

| Preset | Tree draws: wave 10 (BT-T groups, all around) → wave 12 | Tree triangles in range, plaza (all around) | GPU dev | Laptop / M1 | Texture VRAM | Geometry memory | Download |
|---|---|---|---|---|---|---|---|
| Low | unchanged | unchanged | +0 | +0 | +0 | +0 | +0 (still the retail glbs) |
| Medium | plaza 22 → **26**, busiest 16 → 26 (in view at the plaza: wave 10 measured 6 tree group meshes) | shown 35 k → ≈ 61 k; submitted (vertex work) ≈ 183 k | ≤ +0.2 ms | ≤ +0.6 ms (M1, 0.75 scale; the submitted vertices included) | ≈ +0 (retail-size sprites, `graphics.textures` 'remaster'; fact-check W, WF2) | ≈ +28–40 MB merged + ≤ 3 MB overlay (fact-check W, WF5, WF16) | ≈ +4.5 MB new, −5.8 MB retail foliage not fetched: **net ≈ −1.3 MB** (fact-check W, WF19) |
| High | plaza 30 → **36**, busiest 26 → 38; caster draws unchanged (one per region) | shown 54 k → ≈ 102 k; submitted ≈ 256 k | ≤ +0.4 ms | not a default | ≈ +26–73 MiB (the 2× tier) | ≈ +30–45 MB + overlay | as Medium, + ≈ 1–2 MB of 2× sprites |
| Ultra | as High | as High (LOD1 casters within 60 m) | ≤ +0.5 ms | not offered | as High | as High | as High |

- The download: new geometry ≈ 0.1–0.19 MB per species (measured 4 species: 401 KB) + sprites ≈ 30–60 KB each
  (measured 8: 249 KB) → ≈ 4.5 MB for 35 species; the retail foliage glbs the swap stops fetching are 6.17 MB in
  out-opt, less the unique town trees and hidden tufts (0.48 MB) [confirmed: file sizes]. *(fact-check W, WF19)*
  Re-derived with the static variants that Medium+ really fetches: 6.33 − 0.49 = **5.8 MB**. The sprites must be
  embedded **once** per species (in `far.glb`; `near.glb` carries the texture keys only, and the atlas dedupes by key),
  or the 4.5 MB doubles its sprite part.
- What it means: **Medium holds 60 fps in every bench scene**, with > 10 ms to spare everywhere except the crowd + 20
  bots (≈ 1.3–3 ms; fact-check W, WF4); the trees cost about a quarter of a millisecond of CPU and less than half a
  millisecond of GPU. The Mac's lever is Options' sight (rangeScale), which shortens every band; on Medium its sprites
  are already retail-size. **High** meets G2, but the crowd + 20 bots scene misses 60 fps on High before and after the
  trees (WF4): a BACKLOG item 9 matter, reported to the user (§W9.2).

**Per-lane budgets** (dev PC, 1080p; minimum of 5 runs; GPU lock for in-browser frame measurements):

| Lane | Budget |
|---|---|
| T12-M | merged tree draws = wave 10's at the bench spots (± 0); caster draws unchanged; *(fact-check W, WF15: "worker time ≤ +30%" was unreachable, trees are up to 4× the retail triangles per region)* BT-M's absolute budgets at the heaviest region (24999): worker ≤ 15 ms, every main-thread job (mesh creation, upload, the caster) ≤ 2 ms, no frame > 16.7 ms while walking; the caster arrays come from the worker |
| T12-N | overlay draws ≤ 2 × species in band 0; refill ≤ 0.1 ms at 1,600 resident placements (timed inside the frame); never a thin-instance mesh visible at count 0 (F13f) |
| T12-W | `SRO_FOL_VDATA` + `SRO_FOL_BAND` ≤ +0.05 ms GPU; `wgslInterStageCount` of the Medium leaf material unchanged (user varyings ≤ 15) |
| T12-A / T12-B | per species: the §W3.3 caps; bounds ±10% of the retail envelope per tier; the trunk base within 0.3 m of the retail trunk base (WF20); `far.glb` ≤ 60 KB geometry + its sprites once, `near.glb` ≤ 150 KB with no images, in out-opt; sprites ≤ 512² (the 2× tier) and retail size in the glb; per sprite mean luminance ±2% and saturation ±5% of retail (WF3); per family crown luminance ±10% of retail in game (WF1) |
| Whole wave | G1 and G2 as WAVE_PLAN6 §5.4; the plaza and crowd p95 not worse than the wave-10 polish + 0.5 ms (Medium) / + 0.8 ms (High) |

---

### §W7. The build pipeline: every family in one batch (wave 12) [decision]

#### §W7.1 One command

`pnpm trees build --all` (T12-A; `--family <id>` for one) runs, from `C:\dev\silkroad`:

| Step | What | Where it runs | Time (35 species) |
|---|---|---|---|
| 1 extract | every swapped model's retail sprites and bark (DDJ → PNG through the converter's texture reader) | CPU | < 1 min |
| 2 upscale | Real-ESRGAN x4plus, colour bleed, alpha separately, 4× → the 2× tier **and** the retail-size tier (fact-check W, WF2), per-channel mean **and standard-deviation** match to retail (WF3; `upscale.py` made production) | **GPU lock** (`mkdir work/tools/gpu.lock`, owner line, `rm -r` only our own), one lock take for the whole batch | ≈ 3 min for ≈ 45 sprites [projected from 31.5 s for 8] |
| 3 SDXL (optional) | variety sprites for flagged species only (default none) | GPU lock; ComfyUI only through `start_comfyui.sh` / `stop_comfyui.sh` | 0 by default |
| 4 bark maps (optional) | texpipe PBR (normal + ORM) for the bark textures | GPU lock (same take as step 2) | ≈ 1 min |
| 5 generate | Blender 5.2 headless per species (`blenderExe` in `sro.config.json`, F17), 4 processes in parallel; writes `near.glb` (LOD0), `far.glb` (LOD1 + LOD2, tier per node), `.blend` (the hand-edit round trip, as COAST §6), `stats.json` | CPU | ≈ 3–4 min |
| 6 validate | caps, envelopes per tier, attributes (`TEXCOORD_0..2`, no `COLOR_0`), V-decode ranges, MASK + single-sided cards, every swap source in the manifest, every library entry's carrier in the swap; *(fact-check W)* the trunk base within 0.3 m of the retail trunk base (WF20), each sprite's luminance ±2% and saturation ±5% of retail (WF3), images only in `far.glb` (WF19) | CPU | seconds |
| 7 optimise | the out-opt geometry pass (meshopt + quantisation), sprites as WebP tiers | CPU | ≈ 1 min |
| 8 review sheets | **one per family**: the Blender row (retail \| LOD0 \| LOD1 \| LOD2, the game pitch, no tree shadows, 128 transparent bounces) + the in-game before/after at the family's bench spot (the lab page, WebGL2 Medium, game camera) | CPU (Blender, ≈ 12 s each); GPU lock for the in-game shots | ≈ 7 min + ≈ 20 min |
| 9 write | `content/trees/species/<id>.json` (params + seed), `content/trees/swap.json`, `content/trees/library.json`, `out/trees/<id>/*` | CPU | seconds |

Headless sculpt operators are never used (they crash in 5.2); the generator builds meshes with `from_pydata` (the
COAST round-trip rule).

#### §W7.2 Archetypes (one generator, ten archetypes; fact-check W, WF17: the first draft said nine)

`broadleaf` (maple, bigleaf, broad01/02, ginkgo, swamp, dh_poplar, dh_tree, dh_hotree, pine10), `conifer_layered`
(pine07, pine08, grave_tree), `conifer_cone` (pine_small), `weeping` (willow03), `bamboo` (bamboo04), `shrub_dome`
(shrub02), `deadwood` (deadwood_a/b, dh_twig, dh_brush), `clump` (weed_tall, weed_mid, weed04, weed10, barley,
ricestraw, reeds, grave_grass), `flower_bed` and `water_plant`. A species file holds only its archetype, its sprite and
bark keys, the target retail model, a seed and a handful of numbers (whorls, limb tilt, card sizes, leaf gain).

#### §W7.3 Review and approval

- A batch is a set of families (§W8.3). After a batch the user gets one page: every family's Blender row and in-game
  before/after, with the crown-luminance numbers against retail (§W4.1 rule 3).
- A family the user rejects stays retail (its sprites still upscaled through B0) until its next round.

---

### §W8. Lanes (wave 12)

Lane ids `T12-*`. Every lane runs `pnpm vitest run <its tests>` and `pnpm typecheck` before hand-off; nobody commits;
the lead integrates.

#### §W8.1 Step order

```
step 0 (parallel):  T12-A (tool + data, the 4 prototype species)  |  T12-0 (seams)
step 1 (after T12-0):  T12-M (merge) | T12-N (near field + bands) | T12-W (wind + band shader)
step 2:  T12-B batches B1..B4 (data) | T12-E (editor seam, with WORLD_EDITOR's lanes) | T12-L (lab bench, options)
step 3:  integration, hunt, fixes
```

#### §W8.2 Lane table

| Lane | Owns (files) | Seams | Tests | User check | Effort |
|---|---|---|---|---|---|
| **T12-0** seams | `batch/types.ts` (a `TreeSwapSource` on `BatchHost`: species glb for a retail model, fit, tint), `world.ts` (`World.trees` slot, disposed with the world), `pbr/foliage-plugin.ts` (the `SRO_FOL_VDATA` / `SRO_FOL_BAND` define skeletons, off), `trees/types.ts`, `index.ts` exports | adds the swap source, the trees slot, the defines | `trees12-seams.test.ts`: no swap source = wave-10 behaviour byte for byte (the BT-T fixtures); Classic claims nothing; `seams-classic.test.ts` (the Low guard) unchanged | nothing visible | S |
| **T12-A** tool + prototype data | `packages/convert/src/trees/**` (`blender/make_species.py`, `blender/render_sheet.py`, `upscale.ts` (wraps TP-U's exe), `build.ts`, `validate.ts`, `cli.ts`), `node-io.ts` + `sro.config.example.json` (`blenderExe`), root script `"trees"` (lead), `content/trees/{species/*.json, swap.json, library.json}` for the 4 prototype species; *(fact-check W, WF11)* the world export's manifest step (`packages/convert/src/world/manifest.ts` + its writer: the species appended as models, `treeSwap` on the retail models) | reads the converter's texture reader and the manifest | `trees-validate.test.ts` (§W7.1 step 6 rules on fixtures), `trees-swap-data.test.ts` (every source in the manifest, case- and slash-insensitive; the tufts and unique trees absent; every `treeSwap` points at a species model), `trees-upscale.test.ts` (the colour match on a fixture: mean within 2%, standard deviation within 5%) | `pnpm trees build --family maple` makes the maple and its sheet | M |
| **T12-M** merge | `batch/trees.ts` (the swap redirect in `modelFor` through the manifest's `treeSwap`; a `treeSwap` model is always a tree claim; slots and tiers into `sroPivot` vec4), `batch/merge-core.ts` (`pivotSize` 4 for trees; `sroTreeW` as `unorm8x4` with the V decode; `uv2` = the white lightmap quadrant for swapped species; tier-1 triangles first as a contiguous range; the caster arrays emitted by the worker), *(fact-check W, WF8, WF10, WF15)* `model-cache.ts` (`uvs3`), `batch/merge-worker.ts` (transfer list), `batch/region-batch.ts` (`disposeGroupMesh`'s cloth test gains `!sroTree`; the worker's caster arrays handed to BT-S), `render/shadows.ts` (the cut-out caster takes the worker's tier-1 arrays instead of copying on the main thread) | T12-0's swap source; T12-N's slot allocator | `batch-trees.test.ts` additions: a swapped model merges the species' tiers, not the retail mesh, and never fetches the retail glb; `sroPivot.w` = slot × 4 + tier; `sroTreeW` equals the glb's decoded channels (within 1/255); `uv2`'s fraction is the white quadrant; the caster takes only tier 1; draws per region unchanged; `cj_ricestraw` with `treeSwap` is a tree claim; disposing a tree group leaves `clothGroups` unchanged | the plaza's maples and the pines are new at every distance | M |
| **T12-N** near field + bands | `trees/{swap.ts, bands.ts, near-field.ts, index.ts}` (slot free list by uid, the band byte texture, the 4 m refill with 3 m hysteresis on `distance − radius`, the overlay meshes per species × leaf/wood, per-instance tint offset) | T12-0's slot; `ObjectMaterials` / `TreeMaterials` (the overlay uses the group materials) | `tree-bands.test.ts` (bands × rangeScale, hysteresis, refill only after 4 m, band 3 for hidden, group-3 cap at 48 m × s); `near-field.test.ts` (NullEngine: overlay instances = band-0 slots; a region removal frees slots; an empty set hidden with `isVisible = false`; tints in one draw) | walking from 200 m to the plaza, trees change tier without a double or a gap | M |
| **T12-W** wind + band shader | `pbr/foliage-plugin.ts` (`SRO_FOL_VDATA` reading `sroTreeW`, `SRO_FOL_BAND` collapse; WGSL + GLSL; rebased on the wave-11 cloth edits to the same file; *(fact-check W, WF9)* BAND independent of the wind, one `vec4` pivot declaration) | T12-0 defines | `foliage.test.ts` additions: both languages same keys; TS mirror of the bend equals the shader maths; the collapse leaves zero-area triangles; BAND on with the weather absent and with wind off; `wgslInterStageCount` of the Medium leaf material unchanged | in a storm the branches lag and the reeds sway like the retail clips; calm air still moves | S |
| **T12-B** batches (data) | `content/trees/species/*.json`, `swap.json` and `library.json` entries, `out/trees/*`, the TX-R map-set entries of the new sprite keys | T12-A tool | the validator; the lab bench per batch (draws, triangles, luminance) | the batch review page (§W7.3) | L (≈ 0.5 day per batch + review) |
| **T12-E** editor seam | `trees/editor.ts` (`library()`, `preview()`, `setHidden()`), its part of WORLD_EDITOR's library panel (shared file owned by WORLD_EDITOR's lane, T12-E supplies the data and API) | T12-N bands; WORLD_EDITOR's placement edits by uid; *(fact-check W, WF14)* WORLD_EDITOR's S-OBJ owns the re-batch, and `preview()` is S-OBJ's standalone copy for a swapped tree | `trees-editor.test.ts`: preview hides the merged copy (band 3) and shows one overlay instance; drop re-merges; revert restores | place a pine by the plaza, move it, delete it, revert it | S |
| **T12-L** lab + options | `apps/viewer/src/world/trees-panel.ts` (`?trees=new|retail`, the band colouring debug view, counters), `apps/game/src/settings.ts` + `hud/options.ts` (`graphics.trees`) | T12-N stats | `settings.test.ts`: the row defaults `'new'` on Medium+, absent on Low | Options → Graphics → Trees: New / Retail | S |
| integration / hunt | merge order T12-0 → T12-M → T12-N → T12-W → data → T12-E → T12-L | — | full suite + typecheck; §W6 bench with `prof.js` (plaza, fields night, meadow, crowd; WebGPU High and WebGL2 Medium) | before/after at the bench spots, day, night, rain | — |

**Hunt lenses (added to wave 10's H10T list):** a retail tree drawn behind a new one (a missed swap), a merged tree and
its overlay both visible or both missing at a band edge, a band byte left at 3 after an editor cancel, a swapped
skinned model still animating, a plant swaying from the wrong root, LOD2 sticking out of LOD1's silhouette, crowns
under ±10% luminance, the tint offset showing the wrong tint, a 16-varying adapter (forced limit) black-framing.
*(fact-check W)* Also: a region landing with a hitch > 16.7 ms (the heaviest region 24999, High, the caster build); a
world without weather (or wind off) drawing LOD1 and LOD2 together; WebGL2 sampler units with the vertex band sampler
plus night + rain + clouds; `clothGroups` drifting while regions stream; a trunk standing off its nav footprint.

#### §W8.3 Family batches [decision]

| Batch | Families | Placements | Why this order |
|---|---|---:|---|
| **B0** | every retail foliage sprite upscaled (TX-R albedo tier): the "low texture" half of the request, even for a family whose geometry is still retail, *(fact-check W)* including the leaf sprites of the 5 unique town trees, which keep retail geometry | all | cheap; one GPU take |
| **B1** | maple, pine07, willow, shrub02 (the prototypes) | 376 | the plaza and town; already built |
| **B2** | pine08 / pine10 / pine_small, bigleaf, broad01/02, ginkgo, bamboo | 712 | the fields' mass and the skinned trees |
| **B3** | deadwood, grave_tree, swamp + every plant family | 3,474 | the weeds are the biggest family; the reeds and water plants drop their clones |
| **B4** | Dunhuang + the Tarim weed | 324 | mostly the western regions |

---

### §W9. Decisions, needs from the user, open questions (wave 12)

#### §W9.1 Decisions (each with its reason)

1. **Scope = all 110 swappable retail foliage models (4,886 placements); the 5 unique town trees stay retail; the 695
   tufts stay hidden.** Reason: the user asked for all trees and plants; the unique trees are partly buildings and the
   tufts are already replaced by the grass.
2. **bpy for all 35 species; 0 Meshy credits planned; ≤ 90 credits of contingency for bare dead trunks only.** Reason:
   the bake-off (§W2.1).
3. **The new trees live inside BT-T's region groups (LOD1, LOD2) plus a near LOD0 overlay; no separate tree field for
   far trees.** Reason: the merge already makes far foliage cost no draws; measured: draws unchanged.
4. **Impostors dropped; LOD2 big-card crowns instead.** Reason: 85–150 MB VRAM and a second lighting path for no draw
   saving under region batching.
5. **A per-placement band byte (R8 texture) chooses the tier; the shader collapses the other tiers.** Reason: exact
   CPU/GPU agreement with hysteresis, no varying, and the editor's live hide for free.
6. **`sroPivot` vec4 for trees (root + slot/tier) and a new `sroTreeW` vec4 attribute for the wind data.** Reason:
   `uv2` is the table's slot carrier in merged meshes; vec4 matches W11-S's cloth pivot.
7. **Plants become static and merged with per-vertex flex; the 513 skinned plant clones go.** Reason: per-vertex flex
   sways a short plant, which the h² bend could not; it also removes their CPU clone cost.
8. **Shadows from LOD1 only, through BT-S's existing per-region caster.** Reason: caster draws unchanged; LOD1's
   silhouette is within ±10% of LOD0.
9. **Cards authored front + back with outward normals; leaf materials single-sided.** Reason: measured dark crowns
   with two-sided lighting; the merge would otherwise double the cards again.
10. *(fact-check W, WF2, WF3)* **Sprites follow `graphics.textures` like every TX-R texture: retail-size in the glb
    (Medium 'auto'), the 2× tier on High+ or when 1024 / 2048 is pinned; colour-matched per channel on mean and
    spread.** Reason: Medium is the retail-size tier everywhere else (`textureTierFor`), the Option the first draft named
    does not exist, and ESRGAN darkens and shifts the painted sprites; Medium costs ≈ +0 MiB, High+ ≈ +26–73 MiB.
11. **The look gate: crown luminance within ±10% of retail in game, per family; the cause of the measured 25–48% gap is
    split in the lab before any gain is tuned.** Reason: the prototype's main fault, and a gain alone cannot close it
    (fact-check W, WF1).
12. **The editor places species as their retail carrier models.** Reason: one placement format, Low and nav stay
    consistent, and the swap applies everywhere.
13. **Batches B0 → B4 as §W8.3.** Reason: textures for all first, then visibility and CPU win order.
14. **Tree LOD0 caps: 3,500 (4,500 for ≥ 30 m trees); LOD1 1,200; LOD2 520; plants 320 / 90.** Reason: the measured
    prototypes and the §W6 triangle budget.
15. *(fact-check W, WF11)* **The converter writes the species into the manifest and `treeSwap` on each retail model.**
    Reason: `modelFor` returns a manifest model, and that is the path the lab proved.
16. *(fact-check W, WF15)* **The merge worker builds the cut-out caster's arrays.** Reason: the main-thread copy grows
    to ≈ 3.6 MB in the heaviest region.
17. *(fact-check W, WF5)* **`sroTreeW` is `unorm8x4`.** Reason: it saves ≈ 12 MB of merged geometry at the plaza, and
    8 bits hold flex, phase, flutter and AO.

#### §W9.2 Needs from the user (each has a no-download default)

1. **The look direction** (`before_after_ingame.jpg`, `review_sheets.jpg`). Default: proceed, with the §W4.2 fixes
   (lighter crowns, warmer pine bark).
2. **Meshy for trees.** Default: none; the 90-credit dead-trunk contingency is used only if you reject the bpy dead
   trees.
3. **Downloads.** Default: none needed (Blender 5.2, Real-ESRGAN and Python are installed).
4. **Low keeps the retail trees.** Default: yes.
5. *(fact-check W, WF2)* **Texture memory for 2× leaves: ≈ +26–73 MiB on High and Ultra only.** Medium keeps the
   retail size (sharper, from the upscaler), as every other Medium texture does. Default: accepted. If you want 2×
   leaves on Medium too, Options → Textures → 1024 does it.
6. **The batch reviews** (one page per batch). Default: a family you do not answer on ships after the luminance gate
   passes.
7. *(fact-check W, WF1)* **The darker crowns.** The prototype crowns are 25–48% darker than retail in game, so B1's
   review page comes only after the lab finds the cause. Default: no family ships until it is within ±10% of the
   retail brightness.
8. *(fact-check W, WF4)* **High misses 60 fps in the crowd + 20 players scene** (17.1–19.3 ms in wave 10, before any
   tree; the trees add ≈ 0.5 ms). The cause is the 20 extra characters (BACKLOG item 9), not the trees. Default:
   report it in WAVE_PLAN8 as a separate item; the trees' gates stay as listed.

#### §W9.3 Open questions (each with its default)

| # | Question | Default |
|---|---|---|
| Q-W1 | Band distances | trees 40 / 110 m × rangeScale (`distance − radius`), plants 25 m; 3 m hysteresis; tuned in T12-L's band view |
| Q-W2 | Sprite resolution | *(fact-check W, WF2)* follows `graphics.textures`: retail size on Medium 'auto' (and so on the Mac's default Medium), 2× (≤ 512²) on High+ or when 1024 / 2048 is pinned |
| Q-W3 | SDXL variety sprites | none; only for a family the user flags |
| Q-W4 | Do the reeds and water plants keep their clips? | no: static, merged, per-vertex flex; T12-W compares against the retail clips and keeps a clip only for a plant that cannot match |
| Q-W5 | A second model per species | no: one model, the retail yaw per placement and the swap's fit give variety |
| Q-W6 | Impostors | dropped; revived only if LOD2 shimmers at 150–280 m in the lab |
| Q-W7 | The editor's scale range | the retail sizes of the species ±15% |
| Q-W8 | Does LOD0 cast on Ultra? | no; LOD1 casts |
| Q-W9 | The TX-R map sets of the new sprite keys | inherit the retail key's map set where one exists (B1 list) |
| Q-W10 | The unique town trees | stay retail; a later "hero tree" can be a Meshy or hand job if the user asks |

### §W10. Scope-cut order (wave 12; cut from the top)

1. SDXL variety sprites.
2. Bark PBR maps (keep the upscaled albedo).
3. B4 (Dunhuang, Tarim): stays retail geometry with B0's upscaled sprites.
4. Flowers and water plants: stay retail geometry with B0 sprites (the grass already carries flowers).
5. The editor's live drag preview (keep place / move / delete with a re-merge on drop).
6. The LOD0 overlay (merged LOD1 everywhere near: zero extra draws, less detail within 40 m).
7. Per-vertex flex for plants (the skinned plants keep their clips; the static ones keep the h² bend).
8. B3's plants (stay retail geometry with B0 sprites).

**Never cut:** B0 (every foliage sprite upscaled); B1 (the four prototype families); the swap keyed by the retail
source with placements, nav and ranges unchanged; Low unchanged; no new varying; the draw and CPU gates (`prof.js`);
the luminance gate.

### §W11. Risks (wave 12)

| Risk | Default handling |
|---|---|
| Crowns darker than retail (seen; *fact-check W, WF1:* measured 25–48% darker) | the lab A/Bs of §W4.1 rule 3 find the cause first; then the normals rule, the map set, fewer back cards, the leaf gain (≤ ×1.3); the luminance gate per family |
| Merged geometry memory on 8 GB Macs (*fact-check W, WF5:* ≈ +28–40 MB) | `sroTreeW` as `unorm8x4`; Options' sight shrinks the resident set; LOD2 caps; the weeds clump caps |
| *(fact-check W, WF15)* A hitch when a heavy region lands (≈ 76 k merged tree triangles, ≈ 7–9 MB in region 24999) | the caster arrays from the worker; group meshes uploaded as separate stream jobs; the walking watchdog at integration |
| *(fact-check W, WF8–WF10)* Seams with wave 10/11 code (the cloth counter, the wind-gated pivot, `TEXCOORD_1` as a lightmap UV) | T12-M and T12-W own the fixes and the tests listed in §W8.2 |
| GPU overdraw from dense LOD0 cards near the camera | the ≤ +0.4 ms High budget; fewer, larger cards per species |
| The band byte and the overlay disagree for a frame | both update in the same refill before the frame renders; a hunt lens |
| BT-T or the wave-11 build changes `batch/trees.ts` / the foliage plugin meanwhile | T12-0 rebases first; the BT-T fixtures guard wave-10 behaviour |
| Meshy contingency not enough for dead trunks | bpy deadwood stays; the retail dead trees keep B0 sprites |

### §W12. Images (wave 12)

- `work/tmp/trees/w12/before_after_ingame.jpg`: the four families in the game, retail | new.
- `work/tmp/trees/w12/review_sheets.jpg`: the Blender rows, retail | LOD0 | LOD1 | LOD2.
- `work/tmp/trees/w12/bakeoff_meshy.jpg`: the shrub and pine bake-off rows with the Meshy results.
- `work/tmp/trees/w12/upscale_crop.png`: retail vs Real-ESRGAN sprite crops; `retail_sprites.png`: the sprites used.

### §WT. TREE-TUNE: the crown gate (G5) fixed at the root (2026-10-03)

V-12 failed G5 on the production build: crowns 1.12–1.75× retail (pine 1.62, willow 1.12, maple 1.32, shrub 1.75;
pine 1.67 on WebGL2), and the pines showed pale frosted cards, pink branch cards and near-black trunks at noon. The
causes, and what each species now does (the lab and in-game numbers are in `work/tmp/tree-tune/`, see the end):

1. **Up-lit cards** [confirmed]. Twelve species used the card-normal rule `same` with `normalUp` 1: both faces of
   every card lit as a sunlit top, so a pad seen from below read as sky-lit and frosted (1.5–1.9× at noon, level at
   dusk). `same` is gone (the validator refuses it). Each species takes the rule of the retail cards it replaces,
   measured from the retail glbs (`work/tmp/tree-tune/rtypes.ts`): where the retail normal is the card's own facing
   (pines, the broadleaf crowns, deadwood) `mirror` with `normalBend` 0, the face the camera sees lit from its own side;
   where the retail normal is a fixed +Y on both faces (weeds, willow, Dunhuang trees, flowers) the new `retail` rule, a
   seeded random front per card (`frontShare` outward) with +Y on it and −Y on the back; lying pads and flower heads
   `up`; and `dim` (back faces half-lit) where a crown is mostly seen from below (pine10, reeds). `normalUp` then sets
   the noon-to-dusk balance per species (it brightens a high sun far more than a low one).
2. **The retail texture's own material** [confirmed]. A role that draws the retail image unchanged now draws the
   retail key itself (`build.ts roleTextureKey`), so it reads that key's TX-R set: the hero leaf sets' normal, AO and
   roughness maps and their 0.8 direct-light stopgap (`delit` false), and the retail bark maps. The species-key copies
   were albedo-only at full direct light: up to 25 % brighter crowns and flat trunks. A role with its own key (a crop,
   a tint, a grade) records its retail source in `far.json` `trees.sources`, and B0 gives its set the source set's
   `delit` (`b0.ts speciesLight`). The 17 species keys no role draws any more left the index, the rows and the files.
3. **Grades** [confirmed]. The old leaf gains (×1.05–1.3, ×0.5–0.83) compensated the wrong lighting; all were removed
   and set again only where the in-game measurement asks (leaf: bamboo04 1.08, barley 0.8, broad01 0.7, dh_hotree 0.85,
   dh_poplar 0.85, dh_tree 1.1, dh_twig 0.8, grave_tree 1.3, pine08 0.92, pine10 1.15, reeds 1.1, swamp_b 1.22,
   weed_mid 0.8; willow03 leaf and strand 1.12). A gain scales sRGB and the tone map compresses it: 1.12 moves a crown
   by about 3–5 %, so the normals are the main lever. The pine07 bark grade went too: its trunks are the retail
   red-brown set (the "near-black" trunks were the up-lit species copy at full light).
4. **Trunk shape** (dh_tree 0.022 → 0.05, dh_twig 0.03 → 0.06 trunk radius): the retail Dunhuang trunks are thick and
   pale; the thin new ones left sand where retail had bark, which V-12's mask counts as crown (1.35 / 1.48 → 1.08 / 1.07).

**Method.** V-12's mask (`crownLuma`: changed and green pixels, the same camera and time, retail against new), on one
species at a time (the manifest's other `treeSwap` rows set aside for the frame), at a bench spot per species picked by
the lab (the view of its cluster with the most changed crown pixels that the terrain and the placed objects do not
hide; willow03 keeps V-12's spot under the crown). Noon (12:00) and dusk (18:30), clear weather, Medium, 1920×1080.
A second mask diagnoses V-12's: each frame's own crown against a third frame with the species gone (`own`), which keeps
background revealed by a different crown shape out of the means. The foliage plugin is unchanged: retail and new
crowns go through the same tree shading, and no shared term was the cause.

**Measured in game** [confirmed: `work/tmp/tree-tune/results.json`, `results.md`, shots in `work/tmp/tree-tune/shots/`]:
the production bundle (`vite build` of the working tree) on a private preview, a private server on a temp copy of
`game.db`, the export in `work/out-opt` after `pnpm trees build --all`, B0 and `optimize-out run --files`; Medium,
1920×1080 at DPR 1; noon and dusk pinned on the client with **no clouds** (the cloud shadows drift across the ground
between the retail and the new frame and moved a ratio by up to 15 %; at cloud 0 two runs agreed within 1 %). Where the
green mask holds fewer than 0.5 % of the frame in either frame (a dry or Dunhuang crown in the orange dusk light; the
mask then measures a few hundred stray pixels), the ratio is each frame's own trees against the frame without the
species (marked *). Frames where the character had died or stood under the ground after a first teleport into an
unloaded region were re-shot (`deadcheck.py`).

| Species | Family | WebGPU noon / dusk | WebGL2 noon / dusk | own crowns (WebGPU) | trunk luma (noon) | Gate |
|---|---|---|---|---|---|---|
| bamboo04 | bamboo | 0.93 / 1.09 | 0.93 / 1.09 | 0.89 / 1.04 | 0.47 → 0.49 | pass |
| barley | barley_rice | 0.98 / 0.99 | 0.98 / 0.98 | 0.95 / 1.01 | 0.41 → 0.44 | pass |
| bigleaf | bigmaple | 1.00 / 1.00 | 1.00 / 0.98 | 0.92 / 1.06 | 0.36 → 0.51 | pass |
| broad01 | broadleaf | 0.97 / 1.04 | 0.97 / 1.05 | 0.92 / 1.03 | 0.38 → 0.37 | pass |
| broad02 | broadleaf | 0.92 / 1.06 | 0.92 / 1.07 | 0.92 / 1.14 | 0.51 → 0.52 | pass |
| deadwood_a | dry_dead | 1.00 / 0.99 | 1.00 / 0.99 | 0.76 / 1.06 | 0.44 → 0.37 | pass |
| deadwood_b | dry_dead | 0.99 / 0.97 | 0.99 / 0.98* | 0.84 / 0.93 | 0.47 → 0.34 | pass |
| dh_brush | dunhuang_tree | 0.99 / 1.01 | 0.98 / 1.01 | 0.99 / 0.99 | 0.50 → 0.49 | pass |
| dh_hotree | dunhuang_tree | 1.08 / 0.91* | **1.11** / 0.91* | 0.83 / 0.84 | 0.55 → 0.42 | miss (1 %) |
| dh_poplar | dunhuang_tree | 1.00 / 0.96 | 0.99 / 0.96 | 0.91 / 0.96 | 0.65 → 0.70 | pass |
| dh_tree | dunhuang_tree | 0.98 / 0.90* | 0.98 / **0.898*** | 1.34 / 0.98 | 0.45 → 0.46 | miss (0.2 %) |
| dh_twig | dunhuang_tree | **1.101** / 0.94 | 1.09 / 0.94* | 0.91 / 0.93 | 0.47 → 0.37 | miss (0.1 %) |
| flower_bush | flower | 0.98 / 0.98 | 0.98 / 0.98 | 1.06 / 0.94 | 0.40 → 0.40 | pass |
| flower_w | flower | 1.00 / 0.96 | 0.99 / 0.95 | 1.00 / 0.98 | 0.45 → 0.46 | pass |
| flower_y | flower | 0.99 / 0.98 | 1.01 / 1.01 | 1.02 / 1.03 | 0.52 → 0.53 | pass |
| ginkgo | ginkgo | 0.98 / 0.94 | 0.98 / 0.94 | 0.96 / 1.07 | 0.44 → 0.47 | pass |
| grave_grass | graveyard_grass | 0.96 / 0.97 | 0.96 / 0.97 | 0.98 / 0.96 | 0.34 → 0.34 | pass |
| grave_tree | graveyard | 1.05 / **0.85** | 1.05 / **0.85** | 1.05 / 0.87 | 0.43 → 0.48 | **miss** |
| lily_pads | water_plant | 0.99 / 1.00 | 1.01 / 1.00 | 0.97 / 0.98 | 0.37 → 0.36 | pass |
| maple03 | maple | 1.05 / 0.99 | 1.06 / 0.99 | 1.04 / 0.99 | 0.38 → 0.40 | pass |
| pine07 | pine_tall | 0.96 / 0.97 | 0.96 / 0.97 | 0.95 / 0.98 | 0.24 → 0.23 | pass |
| pine08 | pine_tall | 0.91 / 1.04 | 0.94 / 1.03 | 0.94 / 1.04 | 0.33 → 0.31 | pass |
| pine10 | pine_tall | 0.96 / 0.98 | 0.96 / 0.98 | 0.95 / 0.99 | 0.36 → 0.33 | pass |
| pine_small | pine_small | 1.03 / 0.98 | 1.03 / 0.98 | 1.02 / 0.96 | 0.47 → 0.48 | pass |
| pond_flower | water_plant | 1.00 / 1.04 | 1.01 / 0.99 | 0.87 / 1.06 | 0.39 → 0.39 | pass |
| reeds | other_reed | 1.03 / 1.04* | 1.04 / 1.04* | 1.02 / 1.61 | 0.83 → 0.79 | pass |
| ricestraw | barley_rice | 0.97 / 1.01 | 0.93 / 1.01 | 0.98 / 1.01 | 0.55 → 0.45 | pass |
| shrub02 | dry_dead | 1.08 / 0.98 | 1.08 / 0.99 | 1.16 / 1.04 | 0.56 → 0.52 | pass |
| swamp_a | swamp | 1.03 / 1.03 | 1.03 / 1.04 | 1.01 / 1.04 | 0.32 → 0.29 | pass |
| swamp_b | swamp | 0.94 / 1.07 | 0.94 / 1.06 | 0.94 / 1.14 | 0.44 → 0.43 | pass |
| weed04 | weed_tall | 0.98 / 1.00 | 0.98 / 1.00 | 1.05 / 1.15 | 0.47 → 0.48 | pass |
| weed10 | weed_tall | 1.00 / 1.00 | 1.00 / 1.00 | 0.98 / 1.00 | 0.54 → 0.55 | pass |
| weed_mid | weed_tall | 1.06 / 0.93 | 1.06 / 0.94 | 1.06 / 0.92 | 0.55 → 0.57 | pass |
| weed_tall | weed_tall | 0.92 / 0.98 | 0.93 / 0.98 | 0.94 / 1.00 | 0.52 → 0.49 | pass |
| willow03 | willow | 0.92 / 1.08 | 1.09 / 1.08 | 0.83 / 1.09 | 0.35 → 0.37 | pass |

**31 of 35 species pass all four cells**, the four families V-12 measured among them (WebGPU noon: pine 1.62 →
0.96, willow 1.12 → 0.92, maple 1.32 → 1.05, shrub 1.75 → 1.08; pine on WebGL2 1.67 → 0.96). Three misses sit on the
gate line (dh_hotree 1.11 on WebGL2 at noon, dh_tree 0.898 at dusk by the own-tree fallback where V-12's mask reads
0.95, dh_twig 1.101 where V-12's mask counts sand left by the thicker retail trunks and the own-crown mask reads 0.91).
**grave_tree at dusk is the real miss (0.85)**: its bench spot looks into the sunset through heavy haze, the new tree
stands nearer the camera than the retail ones there, and no material lever moved it (five normal rules and the
maximum gain all read 0.84–0.88, noon stays 1.03–1.09). Its next round is a different bench spot or a crown that sits
where the retail crown sits. The pale-card share is at or below retail for every pine (V-12's frosted pines are gone),
the pink share is retail's (pine07 0.124 → 0.105), and the pine trunks are the retail red-brown (0.24 → 0.23).
Review sheets per family: `work/tmp/tree-tune/review/review_<family>.jpg`; the summary:
`Dropbox/.../wave12/trees-tuned.jpg`. The lab (`work/tmp/tree-tune/lab/`, the bench-spot picker, the staged variants)
and the in-game page helpers (`work/tmp/tree-tune/game/`) are scratch.

**Gate re-measure (w12r gate, 2026-10-03).** The same method (TREE-TUNE's `crown2.js` spots and `crown.py`, cloud 0,
one species swapped at a time) on the gate's production bundle (every mini-wave lane merged, the re-converted and fully
optimized export, Medium, 1920×1080 at DPR 1, both backends): **33 of 35 species pass all four cells**, every family
but two. dh_hotree, dh_tree and dh_twig now pass (they sat on the line). **grave_tree at dusk is the one real miss:
0.85 on both backends, and 0.88 / 0.88 with the camera turned 180° (the sun behind it), so it is the tree, not the
backlit spot**; noon reads 1.04–1.12. **willow03 is bench noise:** its noon cell read 1.11, 1.11 and 0.89 on WebGPU and
0.90, 0.91 and 0.89 on WebGL2 in back-to-back runs at V-12's spot (the LOD0 strand cards swinging in front of the
camera), dusk 1.05–1.08 every time. Shots and `g5-results.json`: `work/tmp/rain-gate/`.

---

## 0. Summary (wave 10)

*(wave 12, 2026-10-01)* Items 3, 4 and 6 are superseded: the route is re-decided against Meshy in §W2 (bpy wins, measured), the runtime is §W3 (inside BT-T's region groups, no global tree field for far trees, no impostors), and the prototype now covers four families (§W5).

1. **What is there.** The export places **1,599 trees** from **87 tree models** [confirmed: `work/tmp/trees/inventory.py`
   over `manifest.placements`]. Every model is bark (opaque) plus two-sided leaf cards with cut-out alpha. The median
   model has 220 triangles (286 weighted by placements). **18 models, 487 placements, are skinned** (bamboo, the
   maples, the willows, the ginkgos `tre_bank*`, `tre_tree01/02`): each of those is its own animated clone.
2. **What they cost.** A static tree model is one thin-instance mesh per region, per model and per material. A skinned
   tree is one clone per placement, with one draw per material. Around the plaza on High, the manifest puts **351 tree
   draws** in range, **320 of them from skinned clones** [projected: `work/tmp/trees/drawcount.py`, all around the
   camera, before frustum culling]. In view, the lab counted 38 to 70 tree meshes out of 379 to 544 active meshes on
   High [confirmed: lab, §4.4]. The CPU cost of draw submission is exactly wave 9's bottleneck
   (`work/tmp/w9-finish/budgets.md`).
3. **Recommendation: route (d), the hybrid** [decision]:
   - trunks and branches generated by our own Blender (bpy) script;
   - leaf cards that carry the **retail leaf sprites**, upscaled locally, so the painterly SRO look stays;
   - SDXL-painted sprites only where a family needs more variety;
   - no Meshy credits and no downloads.
   Meshy makes solid foliage blobs at about 30 credits a try. CC0 packs need a download and do not match the style.
   The Sapling add-on is **not** shipped with Blender 5.2 [confirmed], and it is not needed.
4. **Runtime: cheaper, not dearer.** Each new model is drawn by a few **global thin-instance meshes**, one set per LOD
   band (LOD0 near, LOD1 middle, an impostor far). The CPU re-buckets the instances when the camera moves 4 m (the
   Tidewater `InstanceLOD` idea, MIT). The draws therefore scale with the number of *models in view*, not with the
   number of regions or placements.
   - With every family swapped, the plaza's 245 tree draws (Medium) and 351 (High) become about **22 and 33**
     [projected]; *(fact-check, F18)* 23 and 39 with one leaf mesh per tint.
   - The skinned tree clones and their bone animation go away too: the new trees sway in the vertex shader.
5. **The swap is keyed by the retail model source** (`res\nature\common\tree\tre_maple03.bsr`), in a small table.
   The placements, the nav footprints (server-side), the draw ranges and the region streaming stay as they are.
   **Low keeps the retail trees exactly** (the Low guard).
6. **Prototype** (§4) [confirmed]: a procedural maple for `tre_maple03`, built by `make_tree.py` in Blender 5.2 with
   the retail maple sprite and bark:
   - LOD0 has 3,078 triangles and LOD1 832, against 139 for retail. The impostor is 6 × 6 views baked by Cycles on the
     CPU in about 10 s.
   - The wind data is in the glb.
   - It loads through the real `ObjectMaterials.convert`: `SroSurfacePlugin`, `SroFoliagePlugin` and the fog are all
     attached.
   - It was shown next to the retail maple at the maple group west of the plaza, and swapped for all 91 maple
     placements.
   - Draws went down in every one of the 8 A/B scenes (WebGL2 and WebGPU, Medium and High): 125 → 114, 226 → 215,
     277 → 249 and 475 → 466 (only 91 of the 1,599 trees swapped).
   - Screenshots are in `work/tmp/trees/overview.png`.
   - *(fact-check)* The draws fell, but the CPU A/B showed **no** saving. The first batch had the swap at or above
     retail in 6 of the 8 p50s, by up to +3.9 ms, and the repeats flipped the sign (§4.4, F7). The CPU win is still
     only [projected], and the in-game `prof.js` gate decides it.

---

## §F What the fact-check corrected (fact-check 2026-09-29)

| # | Claim as written | What the check found, and how | Fixed in |
|---|---|---|---|
| F1 | `COLOR_0` crown AO costs "no plugin code and no new varying" [confirmed] | **Wrong.** Babylon 9.28 `ShadersWGSL/pbr.vertex.js` declares `varying vColor: vec4f` under `VERTEXCOLOR`, and `render/gpu-guards.ts` records that a lit PBR CSM receiver on a 16-varying adapter already uses 15 + `front_facing` = 16 and names "a vertex colour" as the one that makes the pipeline invalid, which **drops the whole frame** [confirmed: both sources]. Those adapters are capped at Medium (`settings.ts`, SKY2 F11), and Medium has CSM, so the leaves would black-frame exactly where most friends play. The lab ran on the dev adapter (28 inter-stage variables), so it could not see this. Also, a `VEC4` `COLOR_0` (what Blender writes; the prototype has VEC4 normalised ushort) sets `hasVertexAlpha` in the glTF loader [confirmed: `glTFLoader.pure.js`, `loadAttribute("COLOR_0")`]. | §3.4, §4.2, §5.2 TR-A/TR-W, Q9, Q12 |
| F2 | Production layout moves the data to `TEXCOORD_2/3` with `TEXCOORD_1` "reserved" | glTF requires consecutive `TEXCOORD_n`, so a reserved `TEXCOORD_1` would be an extra unused attribute stream on every tree vertex. The retail trees have **no** object lightmaps (F5), so nothing needs set 1. **Now:** keep the prototype layout (`TEXCOORD_1` = flex, phase → `uv2`; `TEXCOORD_2` = flutter, AO → `uv3`), with no `COLOR_0`. `SRO_FOL_VDATA` is switched on by a material flag that the tree field sets, not by the presence of an attribute (other foliage may carry `uv2`). | §3.4, TR-W |
| F3 | "AO written as 0.45–1 in Blender reads 0–0.50 in `TEXCOORD_2.y`" | The AO is written as 0.50–1: `COLOR_0` decodes to 0.503–1.0, and `TEXCOORD_2.y` to 0–0.498 = 1 − (0.502…1) [confirmed: accessors decoded from `tre_maple03_lod0.glb`]. The V-flip conclusion stands. | §3.4 |
| F4 | "At most 4 meshes × 3 cascades = ≤ 12 caster draws for all trees" | That holds only where 2 models are in LOD0 (the plaza). Swept over the map, up to **10 new models** stand within High's LOD0 band (63 m) at (20, −220): 2 × 10 × 3 = **60** caster draws on High, and **80** on Ultra, which has **4** cascades (`quality.ts`) [projected: `factcheck.py`]. On High, LOD1 starts at 45 × 1.4 = 63 m, beyond `foliageM` 60, so "LOD1 within 60 m" is empty, and LOD0 casts out to 63 m (the whole band mesh casts). **Gate now:** tree caster draws ≤ retail's at the same bench spots. | §3.6, §3.9, H10T lens 9 |
| F5 | "The retail tree lightmap was on the tree, not the ground" | None of the 87 tree models has an object lightmap (`lightmappedMeshes` = 0 for every one) [confirmed: manifest]. Nothing is lost. | §3.6 |
| F6 | Download ≈ +10 MB, "−13.7 MB of retail trees not fetched" | 13.7 MB is `work/out`. The game loads `out-opt`, where the 87 tree glbs are **5.76 MB** (5.38 MB swappable) [confirmed: file sizes]. New per model: the out-opt geometry pass gives LOD0 **81 KB** + LOD1 **27 KB** (textures stripped) [confirmed: `optsize.ts` with `optimizeGeometry(WORLD_GEOMETRY)`], and the impostor atlases as WebP q80 are **118 + 134 KB** [confirmed: PIL]. So ≈ 0.36 MB × 24 models ≈ **8.6 MB**: a **net +3.2 MB** for Medium+ players, and Low still fetches retail. | §3.7, §3.9 |
| F7 | "CPU differences inside the noise… two repeats differed by up to 2.4 ms (7.2 vs 8.8, 9.7 vs 9.8)" | Those pairs are off vs swap inside rep1, not repeats. The same scene (High v2, off) ran at a p50 of 4.1 / 7.2 / 7.0 ms on WebGL2 and 5.1 / 9.7 / 9.4 ms on WebGPU across the 3 runs, so the noise is 3–4.6 ms. In the first batch the swap was ≥ retail in **6 of 8** p50s (WebGPU High v2: 5.1 → 9.0). Rep1 and rep2 gave +1.6 / −0.6 (WebGL2) and +0.1 / −0.6 (WebGPU) [confirmed: `shots/ab_*`, `rep1_*`, `rep2_*`]. Two more limits: the lab timed only `scene.render` (the refill ran outside the timer), and it hid the retail maples with `setEnabled(false)` on their meshes, which does not pause their `AnimationGroup`s (`applyClone` pauses by range only), so the animation saving could not show [likely]. **No CPU saving has been shown.** | §0, §4.4 |
| F8 | CPU projection −1 to −2 ms (High), "plus the prepass (SSAO)" draws | The prepass is MRT inside the main pass, not extra draws (budgets.md: "drawn through the prepass MRT") [confirmed]. Re-derived: 25–55 fewer main-pass meshes × 17.8 µs (9.9 ms ÷ 555) = 0.45–0.98 ms, plus active-mesh evaluation (3.8 ms ÷ 858 ≈ 4.4 µs each → 0.1–0.24 ms), plus the animated clones and caster draws. **Now: −0.6 to −1.5 ms on High, −0.3 to −0.7 ms on Medium** [projected]. | §1.7, §3.9 |
| F9 | The dithered cross-fade on High+ is "resolved by TAA" | TAA reprojection is off by default: on WebGPU, thin-instanced objects break the velocity pass ("Vertex attribute slot 11 … not present", `post.ts`). TAA also keeps `disableOnCameraMove = true`, so there is no TAA while the camera moves [confirmed: `post.ts` header]. LODs change only while the camera moves, so the bayer dither would show raw. **Now:** a hard switch with hysteresis on every preset until D30 reprojection renders. | §3.2, §3.9, §6, Q3 |
| F10 | "PERF2 measured about 6,200 animatables a frame" | RENDER §11.6 says ~6,200 **allocated interpolation objects** a frame (Quaternion/Vector3 garbage, now pooled), "most of them the world's animated objects" [confirmed: RENDER.md 1036–1038]. | §1.7 |
| F11 | The field's bands run to 202 m (+10) for every tree | 14 placements are in LOD group 3 (48 m): `c_swamp_tree04` 7, `tre_gagi01` 5, `w_cd_tree01` 2 [confirmed: manifest]. The field must cap each instance at `GROUP_RANGE_M[group] × s`, or "the draw ranges stay" is false. | §3.2 |
| F12 | Bands by the centre distance `d`; 96–128 px impostor frames | `objects.ts` tests `distance − radius`; the field should too, because a 99 m-wide `new-maple/tre_tree03` would turn into an impostor while its crown edge is 60 m away. Frame magnification at 1080p with the game's 0.85 rad vertical fov (≈ 1,190 px/rad): the maple (17.5 m) is 189 px wide at 110 m, so a 128 px frame is enlarged 1.5× (2× at Medium's 96 px), and a 50–99 m tree 4–6× [projected]. **Now:** a per-model impostor start `max(110 m × s, width × 1190 / (1.25 × framePx))`, tuned in the lab (Q1, Q2). | §3.2, §3.5, Q1, Q2 |
| F13 | TR-0's seams cover the integration | Six were missing [confirmed: code]. (a) The weather **shelter map** renders `objects.meshes()` (`weather/index.ts` `shelterCandidates`), so rain would fall through claimed canopies. (b) `receiveShadows = true` is set by WorldShadows' **region listener** on placed meshes, which claimed trees never reach. (c) `World.meshes()` lists objects only. (d) The **objects-ready** event: a claimed model skips `pendingObjects`, so the region reports ready before its new trees are loaded. (e) A **path switch**: `setRenderMode` → `stream.rebuild()` re-requests every region, so the claim must key on the render path (not `animated`: the streamer keeps the `animated` it was loaded with, and a live switch to Low only hides the clones); the `graphics.trees` toggle needs the same rebuild. (f) A thin-instance mesh with `thinInstanceCount` 0 has `hasThinInstances === false` and renders **once, as a plain mesh at its own origin**, and the INSTANCES define flips (`mesh.pure.js`). So an empty band is hidden with `isVisible = false`, never left visible at count 0; `setEnabled` would also rebuild `EnabledMeshCandidates` (`render/active-meshes.ts`). | §3.2, §5.2 TR-0/TR-F |
| F14 | Wave-10 dependencies: only the fog/haze call | SKY2 §8.4 also edits `pbr/foliage-plugin.ts` (the key light × `sroCloudShadow`, +1 sampler) and `settings.ts` rows, so TR-0 and TR-W share files with SKY2 and need a merge order. The impostor must apply the cloud shadow too. `sroAtmosphere` is **not** a SKY2 name: SKY2 puts the haze inside `SroFogPlugin` (COAST S-HAZE), so the impostor includes the fog plugin's own WGSL/GLSL function. ShaderMaterials never write the prepass (SKY2 §2), so to SSAO/GTAO and SKY2's depth-reading effects the impostor pixels are sky [confirmed: SKY2.md]. The licence line goes into `THIRD_PARTY_NOTICES.md` through COAST's S-NOTICE (`tidewater-notices.test.ts`), not "THIRD_PARTY". | §3.5, §5.1, §5.2, §3.2 |
| F15 | Tidewater details [likely] | Now [confirmed: read on github.com 2026-09-29]: the repo states MIT. `InstanceLOD.js` has `refreshDistance = 6`, `frustumCulled = false` and a counting sort (`_sortFar`). The bayer4 dither, `VEG_LOD_BAND`, `OCT_N = 6`, `FRAME_PX = 128` and the 3-frame blend within `BLEND_DIST = 100` are in `Impostors.js`, not in `InstanceLOD.js`. Tidewater's first atlas holds leaf brightness, a leaf/bark flag, colour random and coverage, not albedo. | §3.2, §3.5 |
| F16 | `datafiles/assets` holds "only brushes and the essentials/hair node groups" | `nodes/` holds 6 files: compositing, geometry-node essentials, dynamics, principal components, procedural hair, shading essentials. None is a tree [confirmed: listing]. The conclusion stands. | §2.2 |
| F17 | Blender's path "from `sro.config.json` `blenderExe`" | There is no such key. `SroConfig` has `clientDir`, `pk2Key`, `workDir` and `texpipe` (`packages/convert/src/node-io.ts`, `sro.config.example.json`). TR-A adds an optional `blenderExe` (default: the standard 5.2 install path) and owns `node-io.ts`'s interface line and the example. | §5.2 TR-A |
| F18 | Q11: one model, tint per swap entry by texture key | A tint is a different leaf material, so it needs its own leaf mesh per band: one leaf mesh per (model, tint). Re-projected: plaza 22 → 23 draws on Medium and 33 → 39 on High; worst spot 45 → 51 [projected: `factcheck.py`]. Per-instance colour would add a varying (`INSTANCESCOLOR` → `vColor`), so it is ruled out. | §3.2, Q11 |
| F19 | Ultra "as High" | Ultra has 4 cascades and a 250 m shadow distance, which covers the impostor band (154–293 m). LOD1 receives the CSM there and the impostor does not, so there will be a shading step at the switch on Ultra [projected]. **Default:** on Ultra the impostor starts at 250 m (LOD1 to 250 m). | §3.5, §3.9 |
| F20 | Everything else | **Re-confirmed:** the inventory (87 models, 1,599 placements, 18 skinned / 487, 234 primitives / 119 MASK, the median 220 / weighted 286, 13.66 MB in `work/out`, the §1.2 family table, 91 maples, 6 models, 90 skinned); the §1.7 draw projection (re-run); `GROUP_RANGE_M`, `ANIMATE_RANGE_M = 80`, `CHUNK_M`, `placeStatic`/`placeClone`, the Low skip in `requestModels`, `QUALITY_PRESETS` (`world.ts`, draw distance 0.6 / 1 / 1.4 / 1.4), `foliageM` 0 / 60 / 60, `CLONE_CASTER_M = 40`; `FOLIAGE_BEND = 0.012`, `FOLIAGE_MAX_H = 12`, `finalWorld[3]`, the `ShadowDepthWrapper` note; Babylon 9.28 `thinInstanceCount`, `thinInstanceBufferUpdated`, `thinInstanceRefreshBoundingInfo`, `instantiateModelsToScene`, and `TEXCOORD_2/3` → `uv3/uv4` in the glTF loader; the prototype (re-built: identical `stats.json`; generator 2.8 s wall including Blender start; bake 10.35 s, 72 frames; Cycles CPU); Meshy text-to-3D 20 + 10 credits (meshy-6 / 7.1; image-to-3D 30 with 2K/4K textures; remesh 5) [docs.meshy.ai]; Sapling absent from `addons_core`; the TEXPIPE §1.3 ranking; the B1 tree textures; `tre_maple03.glb` 128 KB / 90 KB out-opt; the §4.4 draw counts. **Protocol:** none [confirmed: `world.pick` is nav + terrain only, and tree meshes are not pickable]. | — |

**Abuse and protocol (fact-check).** Trees are client-only; nothing is sent to or trusted from the server. The one
visibility asymmetry already exists today: Low hides the 487 skinned trees, so a Low player sees through them. The new
path does not add one (`graphics.trees: 'retail'` hides nothing), so for a private server of friends it is accepted
[decision].

---

## 1. Inventory (jangan-fields)

### 1.1 How the counts were made [confirmed]

- **Script:** `work/tmp/trees/inventory.py`. It reads `work/out/world/jangan-fields/manifest.json` (307 regions, 445
  models, 6,744 placements) and every tree glb, and writes `work/tmp/trees/inventory.json`.
- **What counts as a tree:** a placement whose source is under `res\nature\...\tree`, `tree2` or `tree3` (the
  `isFoliageModel` folders, less grass, flower and reed), plus two town pieces (`cj_bridgetree`, `cj_inn_oldtree`)
  that are trees in `res\bldg`. `cj_oldtree02` is under `nature\common\tree`.
- **What each glb gives:** its triangles (index count ÷ 3), its primitives (one per material), its materials (alpha
  mode, double-sidedness, texture), and whether it has a skin. Heights and widths come from the manifest's
  `boundsMin`/`boundsMax`, in metres.
- **Skinned bounds:** for the skinned models the bounds are those of the bind pose and may include the bones
  [likely overstated for `tre_willow03`: 81 × 97 m].

**Totals:**

- 87 tree models, 1,599 placements; 1,585 are in LOD group 2 (the 202 m range) and 14 in group 3 (48 m).
- 18 skinned models with 487 placements; 69 static models with 1,112 placements.
- 234 primitives, of which 119 are MASK leaf cards.
- The retail tree glbs total 13.7 MB (`work/out`). `tre_maple03.glb` is 128 KB in `out` and 90 KB in `out-opt`.

### 1.2 By family

The families are this spec's grouping, by name and by texture family (§3.2 maps each retail model to one family's new
model).

| Family | Retail models | Placements | Skinned placements | Triangles (min–max) | Height m (bounds) | Notes |
|---|---:|---:|---:|---|---|---|
| pine_tall (`tre_pine05..10`) | 9 | 293 | 0 | 178–976 | 30–58 | The biggest group in the fields. `tre_pine10` has 71, `tre_pine07_04` 64 |
| dunhuang (`w_cd_*` tree, tree2, tree3) | 20 | 244 | 0 | 163–542 | 4–41 | Mostly in the western regions (the Donwhang side) |
| broadleaf (`tre_tree01/02`, `smalltree01`, `tre_leaf01/02`, `tre_gagi01`) | 7 | 191 | 180 | 120–685 | 1–48 | `tre_tree02` has 84, skinned |
| dry (`tre_dry*`, `tre_dead*`, `w_cd_deadtree*`) | 9 | 166 | 0 | 117–270 | 3–14 | Bare bushes and dead trees; `tre_dry02_small` has 46 in town |
| bigmaple (`new-maple/tre_tree03..09`) | 7 | 148 | 0 | 272–441 | 33–77 | Share the pine08 bark; `tre_tree09` has 53 |
| swamp (`c_swamp_*`, `swamp_tree01`, `c_hhm_tree_01`) | 9 | 137 | 0 | 72–439 | 4–82 | |
| bamboo (`tre_bamboo04`) | 1 | 91 | 91 | 382 | 49 | Skinned |
| **maple (`tre_maple01..04*`)** | 6 | 91 | 90 | 139 | 17–32 | **The plaza tree (§4)**; one mesh, 3 leaf tints, 2 sizes |
| graveyard (`cj_graveyard_tree01..05`) | 5 | 65 | 0 | 122–176 | 35–63 | |
| willow (`tre_willow01..03`) | 3 | 64 | 64 | 247–282 | 22–81 | Skinned |
| ginkgo (`tre_bank01/02`, `bank01_big`, `tre_frie01`) | 4 | 62 | 62 | 101–215 | 16–64 | Skinned; the `tre_bank_pilla` trunk |
| pine_small (`tre_pine01..04`) | 4 | 42 | 0 | 131–202 | 7–15 | |
| unique town pieces (`cj_bridgetree`, `cj_inn_oldtree`, `cj_oldtree02`) | 3 | 5 | 0 | 636–1026 | 22–39 | **Stay retail** (they are partly buildings) |

The whole per-model list (placements, kind, bounds, triangles, materials) is in `work/tmp/trees/inventory.json`.

### 1.3 The hero species (TP-0 / B1)

- **TEXPIPE §1.3** ranks the fields' trees by placements × area [confirmed, TEXPIPE.md]:
  - `tre_pine08_02/03`: 131 placements, which includes the new-maple family that shares that bark;
  - `tre_pine07_01/02`: 136;
  - `tre_bam04_01`: 91;
  - `tre_tree02_*`: 84;
  - `tre_bank_pilla`: 62, 32 of them in town;
  - `tre_willow03_*`: 52;
  - `tre_tree09_01`: 53.
- **B1's tree textures** [confirmed: `work/tmp/w9b-b1/data/`]: `tre_pine07_01/02`, `tre_pine08_01..04` (+ the
  new-maple copies), `tre_bam04_01..03`, `tre_bank_leaf`, `tre_bank_leaf02`, `tre_bank_pilla`, `tre_tree02_01..03`,
  `tre_tree09_01`, `tre_willow03_leaf01/02`, `tre_willow03_will01`.
- **RENDER §13** names `tre_maple01`, `tre_willow01`, `tre_bank01` and the pines.
- **What this spec takes:**
  - the 5 hero species: pine (pine_tall), the big broadleaf `tre_tree02`, ginkgo (`tre_bank`), the new-maple / pine08
    group, and bamboo;
  - plus willow and maple, as the task names them.
- **The maple is not in B1**: it has no remastered set in `work/out/pbr` [confirmed]. It is the plaza's tree, so the
  prototype uses it.

### 1.4 Materials [confirmed: sidecars and glbs]

- **Bark:**
  - one opaque material, single-sided;
  - a small tiling texture: `tre_maple_pin` is 128², `tre_bank_pilla` 256² DXT1;
  - class `wood` in `pbr/classes.ts` (the bark is not `foliage`, so it does not glow when back-lit).
- **Leaf cards:**
  - MASK, cut-off 0.5, double-sided (BMT flags `twoSided`, `alpha`);
  - 256² DXT3;
  - "texture alpha mostly binary". The `tre_pine10_01` sidecar: 69.5% zero, 0.0% partial.
- **Sprites are whole branches:** each leaf texture is a painted *branch sprite* (twig plus a clump of leaves, stem
  at the lower-left corner; see `work/tmp/trees/retail/`). The retail maple draws 139 triangles: 4–8 big cards,
  each showing the whole sprite. That is why the silhouettes read as flat fans (RENDER §1: "4–8-card trees").
- **Maple tints:** the maples share one mesh, with three leaf tints (`green`, `green2`, `middle`) and a red autumn
  variant (`tre_maple_leaf_red`).

### 1.5 How trees render and stream today [confirmed: code]

- **Static models** (`objects.ts` `placeStatic`, called by `region-chunk.ts` `placeModel` through
  `WorldObjects.addStatic`):
  - one clone of each geometry mesh per (region, LOD group, sub-chunk), with a thin-instance matrix buffer;
  - so **draws = regions in range × models × primitives**;
  - the draw range is `distance − radius < 202 m × rangeScale` (1.0 on Medium, 1.4 on High/Ultra), tested per chunk.
- **Skinned models** (`placeClone`):
  - one `instantiateModelsToScene` clone per placement, with its `AnimationGroup` looping from a random phase;
  - so **draws = placements × primitives**;
  - the clip pauses beyond `ANIMATE_RANGE_M = 80` m × rangeScale;
  - `WorldObjects.setAnimationSpeed` (WX-R) speeds the loops up in wind.
- **Low** (`QUALITY_PRESETS.low.animated = false`):
  - `region-chunk.ts` skips skinned models (`if (model.kind === 'skinned' && !host.animated) continue`);
  - so **on Low the 487 skinned trees are not drawn at all**.
- **Streaming:**
  - `RegionStreamer` loads each model once through `ModelCache` (ref-counted, LRU with a grace time);
  - `loadModel` calls `loadGlb` + `world.materials.convert` + `prepareStatic`;
  - `StreamHooks.loadModel` is already an injectable seam.
- **Shadows** (`render/shadows.ts` `selectCasters`):
  - alpha-tested statics cast within `foliageM`: 0 on Medium, 60 m on High/Ultra;
  - foliage clones cast within `min(40, foliageM)`;
  - so on **Medium no tree casts a dynamic shadow**; only the retail terrain lightmap shows tree shadows.
- **Nav:**
  - trees block through their retail navmesh footprints: NAVIGATION.md counts "terrain under footprints: houses,
    props, trees" among the walk-out-only components;
  - the nav data is its own file (`manifest.nav`: 321 models, 2,281 instances, `nav.bin`) and does not read the
    glbs.

### 1.6 The wave-9 foliage plugin [confirmed: `pbr/foliage-plugin.ts`]

`PbrFoliage` decorates every PBR material of a foliage model (`isFoliageModel(source)`) as `ObjectMaterials.convert`
builds it. `SroFoliagePlugin` has these defines:

- **`SRO_FOL_WIND`** (static trees only):
  - the crown bends downwind by `wind × strength × h² × 0.012 × sroWind(root).x`;
  - `h` is the height above the **instance origin** (`finalWorld[3]`), clamped at 12 m;
  - it needs no vertex data, so any new static tree gets it for free.
- **`SRO_FOL_FLUTTER`** (leaves): a small per-vertex wobble from the world position.
- **`SRO_FOL_TRANSL`** (leaves): back-lit glow on `finalDiffuse`, shadowed by light 0.
- **Shadow pass:** `ShadowDepthWrapper` is **off by default**. On Babylon 9.28 WebGPU with the prepass it builds
  invalid shaders, so tree shadows are static. A crown sways by at most about 1 m.
- **Wetness:** wet foliage comes from `SroSurfacePlugin` (class `foliage`).
- **Uniforms:** `wxA`/`wxB` from the weather. The wind maths (`sroWind`) is WX-R's shared function, so grass and trees
  sway together (D23).

### 1.7 What trees cost today

| View (all around, no frustum) | Medium: tree draws / triangles | High: tree draws / triangles | Of which skinned-clone draws (High) |
|---|---|---|---|
| Plaza (101, −70) | 245 / 29 k | 351 / 39 k | 320 |
| South gate (101, 55) | 86 / 14 k | 263 / 32 k | 227 |
| Fields (109, 132) | 47 / 7 k | 150 / 21 k | 112 |
| Grassland (−147, 167) | 48 / 5 k | 138 / 14 k | 111 |
| Lake forest (59, 800) | 62 / 10 k | 103 / 21 k | 69 |

[projected: `work/tmp/trees/drawcount.py` → `drawcount.txt`]. It follows the `objects.ts` rules (chunk per region ×
model, clones per placement, the 202 m × scale range test), without frustum culling and without shadow or prepass
passes.

- **In view:**
  - the lab counted 31–46 active tree meshes on Medium and 38–70 on High, out of 316–544 active meshes;
  - one active mesh is one main-pass draw, plus caster draws on High. *(fact-check, F8)* The SSAO prepass is MRT
    inside the main pass, not a separate draw (budgets.md) [confirmed].
- **Animation:** *(fact-check, F10)* PERF2 counted ~6,200 allocated interpolation objects a frame at the plaza (now
  pooled), "most of them the world's animated objects" [confirmed, RENDER §11.6]. The skinned trees' clips are part of
  that. The drawcount run has 8 animating tree clones on Medium and 15 on High at the plaza (within 80 m × scale).

---

## 2. How to make the new trees

### 2.1 What a good tree must have (the bar)

- **Look:**
  - a round, full crown with a readable silhouette at 20–200 m;
  - light through the leaves;
  - it sways in the wind;
  - SRO's painterly Chinese look: the retail sprites' palette of olive, rust and gold, the stylised leaf clumps, no
    photoreal bark.
- **Fidelity:** the same species, the same size envelope (placements, nav and the baked terrain shadow stay right)
  and the same tint variants.
- **Runtime:** leaf *cards* (alpha-tested, two-sided), so translucency, flutter and a light silhouette work. Plus
  LOD0, LOD1 and an impostor, and the wind data (§3.4).
- **Cost:** within the user's rules: nothing retail uploaded, downloads only with approval, Meshy credits (about 820
  left, held mostly for new geometry) spent only where they win.

### 2.2 The four routes

| | (a) Meshy text/image-to-3D | (b) Procedural in Blender (bpy / geometry nodes) | (c) CC0 packs (Poly Haven, Quaternius) | **(d) Hybrid: procedural wood + retail/SDXL leaf cards** |
|---|---|---|---|---|
| **Input** | Prompts, or the user's own concept images (never retail files) | Parameters + a seed, in our own script | A downloaded pack | Our script + the retail sprites (local) + optional SDXL sprites (local, approved stack) |
| **Look** | Solid, fused crowns ("foliage blobs") with the leaves baked into one texture [likely: known behaviour of AI 3D generators; Meshy's outputs are a single textured mesh]. No cards: no light through the crown, no flutter, no cut-out silhouette. | Real branch structure. The leaves are whatever cards we give it. | Poly Haven: photo-scanned (a realistic style, heavy meshes). Quaternius: low-poly and flat-shaded [likely]. | Real branches + cards that carry the retail painted sprites: the SRO look with a real 3D crown (§4.3 screenshots) |
| **SRO fidelity** | The palette and species can be prompted, but the style drifts from retail; each tree is a one-off | Shape yes; the leaf style depends on the sprites | Low: another game's style | **High**: the same sprites, colours and size envelope as retail |
| **LODs / impostor / wind** | Must be made after: remesh (5 credits), a separate LOD pass, the wind painted by hand | Built in: the same script writes LOD0 and LOD1, the wind channels and the impostor bake | Some packs have LODs; no wind data in our format; needs a bake | Built in (the prototype does all of it) |
| **Triangles** | Typically 10 k–100 k+ before remesh [likely] | Chosen: the prototype has 3.1 k / 0.8 k | Varies: Poly Haven trees are large, Quaternius are small | Chosen |
| **Cost** | **30 credits per try** (text-to-3D: 20 preview + 10 refine on meshy-6 / meshy-7.1; 5 + 10 on the lite/t2 models [confirmed: docs.meshy.ai/en/api/pricing, read 2026-09-29, re-read by the fact-check]); image-to-3D with a 4K texture also 30. 820 credits ≈ 27 tries for 12 families, with no second chances | Free. Claude's time plus user review | Free, but **needs the user's download approval** (licence clean: CC0) | Free. The upscaling of the retail sprites and the SDXL sprites run on the approved local stack |
| **Tools** | The approved Meshy API client (`packages/convert/src/remaster/meshy.ts` pattern) | **Sapling Tree Gen is NOT in Blender 5.2** [confirmed: `5.2/scripts/addons_core` lists no sapling; it is an extension on extensions.blender.org, so a download]. **No tree node assets are bundled** [confirmed: `datafiles/assets` holds brushes and 6 node files (compositing, geometry-node essentials, dynamics, principal components, hair, shading), none of them a tree; fact-check F16]. Our own bpy script needs neither [confirmed: §4] | Download + import | As (b) |
| **Round trip** | Import only | The script writes a `.blend`, and hand edits are re-exported and re-baked from it [confirmed: `bake.py` runs on the saved `.blend`] | Import, then edit | As (b) |
| **Verdict** | Good for one-off hero pieces later (e.g. an old sacred tree), not for 12 families of instanced trees | The base of (d) | Only if the user wants a different style | **Recommended** |

### 2.3 Recommendation [decision]

*(wave 12, 2026-10-01)* Route (d) stands and now covers every family. Meshy was re-tested on the user's go (2026-10-01) and lost (§W2.1); its credits balance is 1,880, not ~820.

**Route (d).** Procedural trunks and branches from our bpy script; leaf cards from the retail sprites of the same
family.

- **Leaf and bark textures:** the retail sprites and bark are **upscaled locally** with the approved Real-ESRGAN,
  then get PBR maps through `@sro/texpipe` (TP-U, TP-P), as B1 already does for 7 of these families.
- **SDXL:** SDXL-painted sprites (DT-2, through `work/tools/comfyui/start_comfyui.sh` only, never alongside other GPU
  work) are used only where a family needs more variety than its retail sprite. Examples: a second maple tint, or a
  denser pine needle clump.
- **Why:**
  - It keeps SRO's painterly identity, because the leaves *are* the retail paintings.
  - It gives real 3D crowns.
  - It costs no credits and no downloads.
  - It produces LODs, wind data and impostors from one source.
  - It keeps Meshy's ~820 credits for the pieces where Meshy wins (unique hero trees, characters).

---

## 3. Runtime design

*(wave 12, 2026-10-01)* §3.1's principles (keyed by the retail source, placements/nav/ranges unchanged, Low retail, `graphics.trees`) and §3.4's glb contract stand. §3.2 (the global tree field for every band), §3.3 (the band table), §3.5 (impostors), §3.6 (shadows), §3.7 (memory) and §3.9 (budgets) are **replaced by §W3 and §W6**: wave 10 built BT-T's region tree groups, so the new tiers merge into them, a band byte picks the tier, and only LOD0 is a separate instanced overlay.

### 3.1 The swap, keyed by the retail model [decision]

- **Where:** a new content file `content/trees/swap.json`, keyed by the retail model **source path** exactly as the
  manifest stores it (`models[i].source`, compared case-insensitively with either slash). The manifest's model index
  can change between exports; the source path cannot.

```json
{
  "format": "sro-tree-swap", "version": 1,
  "models": {
    "res\\nature\\common\\tree\\tre_maple03.bsr":     { "tree": "maple_a", "scale": 1.0, "tint": "green" },
    "res\\nature\\common\\tree\\tre_maple03_big.bsr": { "tree": "maple_a", "scale": 1.89, "tint": "green2" },
    "res\\nature\\common\\tree\\tre_maple02.bsr":     { "tree": "maple_b", "scale": 1.0, "tint": "middle" }
  }
}
```

- **The placements stay.** Each manifest placement keeps its position and rotation. The new model is authored to the
  retail **size envelope** (±10% height and width), with a per-entry `scale` for the retail size variants.
- **What stays unchanged, and why:**
  - The draw ranges (`GROUP_RANGE_M`) stay.
  - The **nav footprints** stay: the server's navmesh and `nav.bin` never read the glb [confirmed §1.5].
  - The **baked terrain lightmap** stays: its tree shadows still fall where the trees are, because the envelope is the
    same.
- **An unmapped model draws retail.** A missing new model (a load failure) draws retail too, with a warning.
- **Low keeps retail**, exactly as HEAD [decision]. The Low guard (`seams-classic.test.ts`) must stay green; the swap
  is PBR-path only.
- **An option** `graphics.trees: 'new' | 'retail'` (default `'new'` on Medium+) gives the A/B and a fallback.
- **Where the swap happens:** at the model level, before any retail glb is fetched.
  - `RegionChunk` asks the tree field whether it claims a model.
  - If it does, the placements go to the field, and the retail model is **never acquired or downloaded**.
  - The whole-world (non-streaming) path does the same in `WorldObjects.load`.
- *(fact-check, F13)* **When the claim is decided, and what it must keep:**
  - It keys on the **render path** at request time (PBR claims; Classic never does), not on `animated`. A live
    switch to Low goes through `setRenderMode` → `stream.rebuild()`, which re-requests every region, so the retail
    trees come back. The streamer keeps the `animated` it was loaded with, and `setQuality` only hides the clones.
  - A change of `graphics.trees` also calls `stream.rebuild()`. A whole-world load applies it at the next load.
  - A claimed model counts as a pending object of its region until the field reports that model ready, so the
    region's `'objects'` event (and `waitForObjects`) still means "trees drawn".

### 3.2 The tree field: global instances per model and LOD band

`packages/world-render/src/trees/tree-field.ts` (new, lane TR-F). One `TreeField` per world.

- **Per new model** (`maple_a`, ...), it holds:
  - the LOD0 and LOD1 containers (loaded once, converted by `ObjectMaterials.convert` with the retail texture keys,
    so `SroSurfacePlugin`, `SroFoliagePlugin`, the fog and the TX-R map sets all apply [confirmed in the prototype,
    §4.4]);
  - its impostor atlas layer;
  - **one thin-instance mesh per LOD0 primitive, per LOD1 primitive, and one impostor mesh**, each with a dynamic
    matrix buffer sized to the model's placements.
- **Instances:**
  - the claimed placements, by owner region (added on `placed`, dropped on `removed`, like `RegionListener`);
  - the matrix is `local × T(position) R(rotation) S(scale)`, as `placeStatic` builds it.
- **Re-bucketing:**
  - when the camera has moved ≥ 4 m, or the preset changed, every instance is put into LOD0 (d < 45 m × s), LOD1
    (< 110 m × s), the impostor (< 202 m × s + 10) or none;
  - `s` is `rangeScale` (1.0 Medium, 1.4 High);
  - each band keeps 3 m of hysteresis;
  - the buffers are filled in place (created once with `staticBuffer = false` at the model's capacity);
    `thinInstanceCount`, `thinInstanceBufferUpdated('matrix')` and `thinInstanceRefreshBoundingInfo` are called.
  - *(fact-check, F13f)* An empty band's mesh is hidden with `isVisible = false`. It is never left visible at count
    0: with `thinInstanceCount === 0`, `hasThinInstances` is false and Babylon draws the mesh **once, as a plain
    mesh at its own origin**, and the INSTANCES define flips [confirmed: `mesh.pure.js`]. `setEnabled` is avoided
    because every enabled-state change rebuilds `EnabledMeshCandidates`.
  - *(fact-check, F11, F12)* `d` is `distance − radius` of the instance (as `objects.ts` `inRange`), and the last
    band ends at `GROUP_RANGE_M[group] × s` (+10). The 14 group-3 trees stop at 48 m × s, as today. The LOD1 → impostor
    edge is per model: `max(110 m × s, width × 1190 / (1.25 × framePx))` at 1080p, so a big tree keeps LOD1 until its
    frame is not enlarged by more than 1.25× [projected; tuned in the lab, Q1/Q2].
- **Cost:** at most 1,599 instances. A refill is a distance test and a 16-float copy per instance, well under 0.1 ms
  [projected], every 4 m of camera travel. The prototype does exactly this for 91 maples [confirmed §4].
- **Transitions:**
  - v1 is a hard switch with hysteresis, **on every preset** *(fact-check, F9)*;
  - the dithered cross-fade over a 6 m band (Tidewater `Impostors.js`: `bayer4` in `VEG_LOD_BAND`) waits for D30.
    Today's TAA has reprojection off (thin-instance velocity breaks WebGPU) and `disableOnCameraMove = true`, so it
    does not resolve anything while the camera moves, which is exactly when LODs change [confirmed: `post.ts`];
  - Medium has no TAA (FXAA), so it keeps the hard switch in any case.
- **Other meshes' bookkeeping** *(fact-check, F13a–c)*: the field's meshes set `receiveShadows = true`,
  `isPickable = false`, `metadata.sroWorld = 'object'` and `WORLD_OBJECT_LAYER` themselves (today the WorldShadows
  region listener and `placeStatic` do that). Their LOD0 and LOD1 meshes join the weather's shelter candidates and
  `World.meshes()` through `World.trees.meshes()`, or rain falls through the canopies (the impostors do not join: a
  camera-facing quad is wrong seen from above).
- **Per-instance frustum culling:** off in v1. Tidewater draws its instance sets with `frustumCulled = false`, and a
  thin-instance mesh's bounds cover its band [likely fine]. Measure it in the lab (open question Q4).
- **Draws:**
  - `2 × (models with an instance in LOD0) + 2 × (in LOD1) + impostor draws`;
  - with all impostors in **one 2D texture array** (one layer per model; the model index is a per-instance
    attribute), the impostor band is **one draw for all trees**;
  - with every family swapped and 2 models per family, the plaza needs 22 draws on Medium and 33 on High, against
    245 and 351 (§1.7) [projected: `drawcount.py` `run_new`, with a per-model impostor draw].
  - *(fact-check, F18)* A leaf tint is its own material, so leaves are one mesh per (model, tint) and band: the
    plaza becomes 23 and 39. The busiest spot on the map, (20, −220), becomes 43–46 on Medium and 45–51 on High,
    against 272 and 354 retail [projected: `factcheck.py`]. The draw formula is
    `Σ bands (models + (model, tint) leaf sets) + impostor draws`.

*Source.* Tidewater (github.com/dgreenheck/tidewater, MIT) `src/world/vegetation/InstanceLOD.js`: a CPU refill of a
dynamic near buffer when the camera moved 6 m, a static far buffer, the exact per-instance split in the vertex shader
(`uLodRange`), and a counting-sort option for front-to-back impostors (`_sortFar`) [confirmed by the fact-check: read on
github.com 2026-09-29; `refreshDistance = 6`, `frustumCulled = false`; the repo states MIT]. We port the idea, not the
code. If code is ported, its line goes into `THIRD_PARTY_NOTICES.md` through COAST's S-NOTICE seam
(`tidewater-notices.test.ts`) *(fact-check, F14)*.

### 3.3 LODs and triangle budgets [decision]

| Level | Range (× rangeScale) | Triangles | Cards | Draws | Casts (High+) |
|---|---|---|---|---|---|
| LOD0 | 0–45 m | ≤ 3,500 (small species ≤ 1,500) | 250–400 | 2 (bark, leaves; + 1 per extra tint) | yes: the whole band mesh (to 63 m on High) |
| LOD1 | 45–110 m (per model, F12) | ≤ 900 | 60–120, larger | 2 (+ tints) | no on High/Ultra: LOD1 starts at 63 m > `foliageM` 60 *(fact-check, F4)* |
| Impostor | 110–202 m (+10), capped by the group range | 2 | — | 1 for all models (texture array) | no (as today: no tree casts beyond 60 m) |

*(fact-check)* The prototype's LOD1 is 17.8 × 18.7 m against LOD0's 16.6 × 17.1 m: both are inside ±10% of retail,
but the crown grows 7% at the switch. TR-A's validator also bounds LOD1 against LOD0 (±4%).

- **Prototype:** LOD0 has 3,078 triangles and 384 cards; LOD1 832 and 98 [confirmed: `stats.json`].
- **Cost of the extra triangles:**
  - at the plaza, the tree triangles go from 29 k to about 26 k on Medium and from 39 k to about 76 k on High
    [projected, `drawcount.txt`];
  - that is well inside the GPU headroom (GPU is 2–4.6 ms of an 18 ms frame, budgets.md);
  - the real GPU cost is the **alpha-tested overdraw** of LOD0 cards near the camera, budgeted at ≤ +0.3 ms on
    High (§3.9).

### 3.4 Wind vertex data (the contract)

Today's plugin bends a static tree by its height above the instance origin, so the new trees sway **with no plugin
change** [confirmed: the prototype's meshes carry `SroFoliagePlugin` with `kind: 'static'`, §4.4]. For branch-level
motion the new glbs also carry per-vertex data:

| glTF attribute | Babylon kind | x | y |
|---|---|---|---|
*(fact-check, F1, F2: the layout below replaces the first draft, which moved the data to `TEXCOORD_2/3` and put the
crown AO in `COLOR_0`.)*

| glTF attribute | Babylon kind | x | y |
|---|---|---|---|
| `TEXCOORD_0` | `uv` | bark (tiled) / leaf-sprite UV | |
| `TEXCOORD_1` | `uv2` | **flex** 0 (trunk base) … 1 (twig tip / card) | **phase** 0…1, one per main limb, shared by its children |
| `TEXCOORD_2` | `uv3` | **flutter** 0 at a card's stem corner … 1 at its far corner (0 on bark) | **crown AO** 0.5 deep inside … 1 outside (data only in v1: the impostor bake and a later use) |
| no `COLOR_0` | — | — | — |

- **Why no `COLOR_0`** *(fact-check, F1)*: a vertex colour **is** a varying (`varying vColor: vec4f` under
  `VERTEXCOLOR` in Babylon 9.28's `pbr.vertex.js`). A lit PBR CSM receiver on a 16-varying WebGPU adapter is already
  at 16 (`gpu-guards.ts`), so the leaves would make the pipeline invalid and WebGPU would drop the frame, at Medium,
  the preset those adapters are capped at [confirmed: both sources]. The lab's "renders darker inside" was true on the
  dev adapter (28 inter-stage variables), which cannot show this. A VEC4 `COLOR_0` would also set `hasVertexAlpha`.
  The crown depth then comes from the card normals bent towards the crown sphere (already 70%), the SH ambient, SSAO on
  High, and the AO baked into the impostor. If the lab shows the crowns too flat, the fallback is a darker second
  sprite row picked by UV (texture side, no varying): open question Q12.
- **No reserved set** *(fact-check, F2)*: glTF requires consecutive `TEXCOORD_n`, so a reserved set 1 would be an
  unused attribute stream on every vertex. No retail tree has an object lightmap (F5), so set 1 is free.
- **Blender's glTF exporter flips V on every UV set (v → 1 − v)** [confirmed: the crown AO, written as 0.50–1 in
  Blender, reads 0–0.498 in the prototype glb's `TEXCOORD_2.y`, and the trunk's phase 0 reads 1.0 in
  `TEXCOORD_1.y`; re-derived by decoding the accessors, F3]. So:
  - either the tool writes `1 − value` into V;
  - or the shader decodes `1 − uv.y`.
  The contract: **the glb holds the glTF value; the plugin reads `1.0 − uv2.y` (phase)**. The validator checks the
  ranges.
- **The prototype's layout** is already this one (flex/phase in `TEXCOORD_1`, flutter/AO in `TEXCOORD_2`); the
  production tool only drops `COLOR_0` [decision, fact-check].
- **Plugin extension** (lane TR-W, `pbr/foliage-plugin.ts`): `SRO_FOL_VDATA`. *(fact-check, F2)* It is switched on by
  a material flag the tree field sets (`metadata.sroTreeVdata`), not by the presence of `uv2`, which other foliage may
  carry.
  - Bend: `offset = windDir × strength × (flex² × 1.2 × sin(t × 1.1 + phase × 6.28) + 0.3 × flex × gust)`, instead of
    the h² rule.
  - Flutter: `uv3.x × (0.012 + 0.05 × strength)` along the card normal.
  - Both are in `CUSTOM_VERTEX_UPDATE_WORLDPOS`, WGSL and GLSL, reusing `sroWind`.
  - `uv2`/`uv3` are **attributes**, not varyings. The 16-inter-stage cap is untouched [likely: Babylon declares
    `vMainUVn` varyings only for the sets a texture uses (`MAINUVn`), and no tree material has a lightmap]. TR-W proves
    it with `wgslInterStageCount` on the leaf material at Medium (CSM receiver, two-sided, fog, translucency, wet):
    user varyings ≤ 15.
  - Vertex streams per tree mesh: position, normal, uv, uv2, uv3 and the instance matrix = 6, under WebGPU's default
    `maxVertexBuffers` of 8. The prototype drew with 7 (it also had `COLOR_0`) on WebGPU High [confirmed: lab]
    *(fact-check)*.
- **Retail skinned trees** keep their clip on Low only. The new trees are static on every PBR preset, so the 487 clones
  and their animatables disappear [decision].

### 3.5 Impostors

- **Bake:**
  - offline, in Blender, from the LOD0 `.blend`;
  - **hemi-octahedral 6 × 6 views** of the upper hemisphere (Tidewater `Impostors.js`: `OCT_N = 6`, `FRAME_PX = 128`,
    two atlases [confirmed by the fact-check on github.com; Tidewater's first atlas holds leaf brightness, a flag,
    colour random and coverage rather than albedo]);
  - orthographic, covering the bounding sphere;
  - Cycles on the CPU (no GPU lock needed);
  - two atlases:
    - **albedo** (RGB × crown AO, A = coverage, colours dilated 8 px so the mips do not bleed black);
    - **normal** (model-space normal × 0.5 + 0.5, back faces flipped towards the view).
  - The prototype baked 72 frames of 128 px plus a 1600 × 700 preview in 10.8 s of wall time [confirmed].
- **Atlas:** 6 × 128 = 768² per map on High/Ultra, and 6 × 96 = 576² on Medium. It is encoded like the other world
  textures (WebP tiers, KTX2 when TP-K ships). All models go into one 2D texture array.
  - *(fact-check)* WebP layers are decoded and uploaded into a `RawTexture2DArray` [likely]. Whether Babylon 9.28's
    KTX2 path fills a 2D **array** is [unknown]. If it cannot, the fallback is per-model atlases (one impostor draw
    per model, as `drawcount.py` already counts), and the KTX2 VRAM figures in §3.7 still hold.
  - *(fact-check, F12)* At the LOD1 → impostor edge the maple (17.5 m) is about 189 px wide at 1080p, so a 128 px
    frame is enlarged 1.5× and a 96 px frame 2× [projected]. That is why the impostor edge is per model (§3.2).
  - *(fact-check, F19)* On Ultra the impostor starts at 250 m (the shadow distance), because the impostor does not
    receive the CSM.
- **Shader** (`trees/impostor.ts`, WGSL and GLSL, lane TR-I):
  - a `ShaderMaterial` on a thin-instanced quad;
  - the vertex stage encodes the view direction in model space into the hemi-oct grid, picks the frame, orients the
    quad to **that frame's** camera basis (so the frame is shown undistorted) and places it at the crown centre;
  - v1 uses the nearest frame; the 3-frame barycentric blend (Tidewater within 100 m) comes on High+ only;
  - the fragment stage alpha-tests, decodes the normal to world space, and lights with the **same terms as the PBR
    trees**: the celestial light and colour, the `SkyState` SH ambient (4 × vec3, as the grass chunk already binds),
    the back-light translucency, the shared **height fog / sky haze** function (`HeightFog` today; the sky wave's
    haze chunk when it lands), and the weather's wet darkening;
  - *(fact-check, F14)* the fog and haze come from `SroFogPlugin`'s own WGSL/GLSL function, included by name. SKY2
    extends that plugin (COAST S-HAZE); `sroAtmosphere` was this spec's invented name and SKY2 does not define it. The
    key light is multiplied by `sroCloudShadow(worldPos)` (SKY2 §8.4), so distant crowns darken under a cloud like
    the near ones;
  - *(fact-check, F14)* a ShaderMaterial writes no prepass (SKY2 §2), so to SSAO/GTAO and to SKY2's depth-reading
    effects an impostor pixel is sky [confirmed: SKY2.md]. At 110–202 m that costs no visible AO; SKY2's shafts and
    haze must not rely on the prepass depth there (H10T lens 12);
  - its own varyings are counted with `wgslInterStageCount` (≤ 15 user varyings);
  - it outputs linear HDR (the post tone-maps).
- **Prototype:**
  - it used the GLSL half only, on WebGL2;
  - it used a hand-calibrated sun and ambient: impostor crowns average (98, 91, 54) against LOD1's (85, 83, 56) and
    retail's (103, 85, 52) in the same shot [confirmed: pixel means over the crowns in `lineup_medium_v3.png`];
  - **on WebGPU a GLSL `ShaderMaterial` would make Babylon download glslang/twgsl from its CDN** (RENDER §2), so
    the WebGPU lab runs drew LOD1 in the impostor band. The production shader must ship WGSL.

### 3.6 Shadows

- **Medium:** no tree casts a dynamic shadow, as today (`foliageM` 0).
  - *(fact-check, F5)* Neither the retail trees nor the new ones have an object lightmap: `lightmappedMeshes` is 0
    for all 87 tree models [confirmed: manifest]. Nothing is lost.
  - The **ground** keeps its baked terrain shadow from the retail envelope [likely close enough].
  - The self-shadowing comes from the bent card normals and the SH ambient (no `COLOR_0`, F1).
- **High/Ultra:**
  - the LOD0 meshes register as cut-out casters through a new `WorldShadows` caster-source seam. LOD1 starts
    beyond `foliageM` on High and Ultra (63 m > 60 m), so it never casts *(fact-check, F4)*;
  - caster draws = 2 × (models in LOD0, + tints) × cascades: **12 at the plaza on High**, but up to **60 on High and
    80 on Ultra** (4 cascades) at the busiest spot, (20, −220), where 10 models are in LOD0 [projected:
    `factcheck.py`]. The `cascadeCulling` filter keeps most of them, because a band mesh's sphere covers 63 m.
    Today's count there is per region chunk and per clone. **Gate:** tree caster draws ≤ retail's at the same bench
    spots (H10T lens 9); if it fails, the leaves cast and the bark does not (it halves the count).
  - The shadows stay static (no `ShadowDepthWrapper`, §1.6) until the WebGPU bug is fixed. Ultra turns them on
    when fixed.
- **Impostors never cast.**

### 3.7 Streaming, memory, download

- **Loading:**
  - the new models load on first claim (ref-counted by claiming regions, disposed after the model cache's grace
    time);
  - the retail glb of a claimed model is never fetched;
  - the impostor array is loaded once per world (all models), at the map-set priority (TX-R's lowest), and a
    placeholder band draws LOD1 until it is in.
- **Download (per model)** *(fact-check, F6: measured)*:
  - the LOD0 + LOD1 geometry without textures is 216 + 61 KB in the prototype glbs; the `out-opt` geometry pass
    (`optimizeGeometry(WORLD_GEOMETRY)`) makes it **81 + 27 KB** [confirmed: `work/tmp/trees/optsize.ts`];
  - the impostor is 1.2 MB as PNG and **118 + 134 KB** as WebP q80 (albedo + normal) [confirmed: PIL];
  - so ≈ 0.36 MB per model, and for 12 families × 2 models **≈ 8.6 MB** [projected from the maple].
  - The retail tree glbs that Medium+ no longer fetch are **5.38 MB** in `out-opt` (5.76 MB with the 3 town pieces),
    not 13.7 MB (that is `work/out`) [confirmed: file sizes]. **Net: ≈ +3.2 MB** per Medium+ player. Low still
    fetches retail, and the deploy ships both.
- **VRAM (projected):**
  - leaf and bark textures are shared with the retail sprite sets (the same keys);
  - impostors are 768² × 2 maps × 4 B × 1.33 = 6.3 MB per model in RGBA8, so the 24 models take **≈ 150 MB on High
    without KTX2** (≈ 38 MB with BC7/ASTC), and ≈ 85 MB at 576² on Medium;
  - this is the big memory item. KTX2 (approved, TP-K) or a 96 px frame on High halves it (scope cut 6).
  - *(fact-check)* For scale: the wave-9 bench measured 985 MiB of texture VRAM on WebGPU High (cut 4) and 851 MiB
    on WebGPU Medium at the plaza (budgets.md), so the RGBA8 atlases add ≈ 15% and ≈ 10%. On an 8 GB Apple Silicon Mac
    that memory is shared with the system, so KTX2 comes before the High atlases ship (TP-K), or High uses 576².

### 3.8 Collision and nav

Unchanged by construction.

- Trees block only through their retail navmesh footprints, which the server and `@sro/nav` read from `nav.bin`.
- The client's `world.pick` uses the navmesh, not the object glbs, for the ground.
- The new crown is drawn **inside the retail envelope**, so nothing new appears to block or float.
- Picking: `isPickable = false` on all tree meshes, as today.

### 3.9 Budgets per preset (WAVE_PLAN3 §5.2 format; 1080p; dev PC = Ryzen 5 9600X + RX 9060 XT)

*(fact-check: the rows below were corrected by F4, F6, F8, F9, F18 and F19, and the iGPU column of the WAVE_PLAN3
§5.2 format was added.)*

| Preset | Tree path | Tree draws, plaza all around (retail → new) | Tree meshes in view (retail, measured) | Tree caster draws | CPU (dev) | GPU (mid) | GPU (iGPU, 0.75 scale) | Texture VRAM | Download |
|---|---|---|---|---|---|---|---|---|---|
| Low | retail, unchanged (skinned trees hidden) | unchanged | — | 0 | +0 | +0 | +0 | +0 | +0 |
| Medium | new (LOD0/LOD1/impostor 576², hard switch) | 245 → ≈ 23 (busiest spot 272 → ≈ 46) | 31–46 | 0 | **≤ +0** (gate); projected −0.3 to −0.7 ms on WebGPU | ≤ +0.2 ms | ≤ +0.5 ms [projected: ~2.5× mid] | ≤ +90 MB RGBA8 (≈ +25 MB KTX2) | ≈ +8.6 MB, −5.4 MB of retail trees not fetched (net ≈ +3.2 MB) |
| High | new (768² impostors, hard switch until D30) | 351 → ≈ 39 (busiest spot 354 → ≈ 51) | 38–70 | 12 at the plaza, ≤ 60 at the busiest spot; ≤ retail's (gate) | **≤ +0** (gate); projected −0.6 to −1.5 ms on WebGPU | ≤ +0.3 ms | not a default | ≤ +150 MB RGBA8 (≈ +40 MB KTX2) | same |
| Ultra | as High + LOD1 to 250 m + swaying shadows (when the wrapper works) + 3-frame impostor blend | as High | as High | 16 at the plaza, ≤ 80; ≤ retail's (gate) | ≤ +0.2 ms | ≤ +0.5 ms | not offered | as High | same |

How the CPU projection is made [projected; re-derived by the fact-check, F8]:

- budgets.md measured the main pass at 9.9 ms for 555 PBR draws in the WebGPU High crowd (about 17.8 µs per draw).
  The SSAO prepass is MRT inside that pass, not extra draws;
- 25–55 fewer main-pass tree meshes on High = 0.45–0.98 ms; their active-mesh evaluation (3.8 ms ÷ 858 meshes ≈
  4.4 µs each) = 0.1–0.24 ms; plus the 15 animating tree clones at the plaza and their caster draws;
- on Medium, 15–30 fewer meshes at a cheaper per-draw cost (no MRT) give −0.3 to −0.7 ms;
- the refill is ≤ 0.1 ms per 4 m of travel [projected, not timed: the lab's refill ran outside its timer].
The lab's CPU timings could not show it: the same scene varied by 3–4.6 ms between runs, and the first batch leaned
the wrong way (§4.4, F7). Until `prof.js` shows the saving, the CPU column is a gate (≤ +0), not a promise.

Per-lane budgets (dev PC, 1080p; minimum of 5 runs; the GPU lock held; no other GPU page):

| Lane | Budget |
|---|---|
| TR-F | tree draws in view ≤ Σ bands (models + (model, tint) leaf sets) + 1 (F18); a refill ≤ 0.1 ms at 1,600 instances, timed inside the frame; tree caster draws ≤ retail's at the bench spots (F4); **total draws at the §4.4 bench scenes ≤ the retail run** (the gate) |
| TR-I | impostor band ≤ 0.15 ms GPU on High (mid), 1 draw; the atlas array ≤ 40 MB with KTX2 |
| TR-W | `SRO_FOL_VDATA` ≤ +0.05 ms GPU; no new varyings (`wgslInterStageCount` on the Medium leaf material: user varyings ≤ 15, i.e. total with `front_facing` ≤ 16); no `COLOR_0` on any tree mesh *(fact-check, F1)* |
| TR-A | per model: LOD0 ≤ 3,500 triangles, LOD1 ≤ 900; bounds within ±10% of the retail envelope; glb ≤ 150 KB in `out-opt` |
| Whole wave | the WAVE_PLAN3 §5.2 lines hold: Medium WebGL2 ≥ 60 fps everywhere; High WebGPU p95 at the plaza and in the crowd **not worse** than the wave-9 release (the trees must help close its CPU gap, not widen it) |

---

## 4. The prototype: the plaza maple

### 4.1 What was built [confirmed]

| Step | File | What it does |
|---|---|---|
| Model | `work/tmp/trees/proto/make_tree.py` | A bpy script (Blender 5.2.2 LTS, `-b --factory-startup`). It makes a trunk, splits it into 4–5 limbs, adds 6–8 side branches per limb and 2–3 twigs each (tapered tubes, bark UV tiled every 1.6 m). Leaf cards carry the retail sprite, with the stem corner on the branch, the diagonal along the branch and outward, and a random roll. Card normals are bent 70% towards the crown sphere. The script fits the skeleton to the retail envelope (16.7 m × 17.5 m), then exports LOD0 and LOD1 glbs with the wind channels and COLOR_0 AO, the `.blend`, and `stats.json`. Seeded (seed 7) and repeatable. |
| Impostor | `work/tmp/trees/proto/bake.py` | From the `.blend`: 6 × 6 hemi-oct frames (128 px, Cycles CPU, emission-only materials for albedo × AO and for the flipped model normal), `impostor.json`, and a Blender preview (retail \| LOD0 \| LOD1). |
| Atlas | `work/tmp/trees/proto/atlas.py` | Composes the 768² albedo and normal atlases, dilates the colours, and writes a review sheet. |
| Lab | `work/tmp/trees/lab/` (`vite.config.mjs`, `trees-lab.ts`, `cdp-run.ts`, `cdp-eval.ts`) | A private Vite server on :5237 (the viewer app's root) and a lab page that loads `jangan-fields` through `loadWorld` (PBR, modern sky, weather off, t = 0.42). It loads the prototype through `loadGlb` + `world.materials.convert`, with a sidecar giving the retail texture keys and the retail maple source, then `prepareStatic`. It draws the tree set of §3.2 (global LOD meshes, 4 m re-bucketing, the impostor). Modes: `off`, `side`, `lineup` and `swap` (every `tre_maple01..04` placement, retail maples hidden through a region listener). It counts draws per frame (`engine._drawCalls` delta around `scene.render`), active meshes, and tree meshes, instances and triangles. The page ran in the lab's **own headless Chrome 154** (its own profile, one tab), driven over CDP. The server, the Chrome instance and the profile were removed afterwards. |

Commands (run from `C:\dev\silkroad`):

```
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --factory-startup --python work/tmp/trees/proto/make_tree.py -- --seed 7 --out work/tmp/trees/proto/out
"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b work/tmp/trees/proto/out/tre_maple03.blend --python work/tmp/trees/proto/bake.py -- --out work/tmp/trees/proto/out
python work/tmp/trees/proto/atlas.py
cd apps/viewer && pnpm exec vite --config ../../work/tmp/trees/lab/vite.config.mjs      # scratch server :5237
pnpm tsx work/tmp/trees/lab/cdp-run.ts "http://localhost:5237/trees-lab?mode=swap&preset=high&view=2&engine=webgl&shot=name"
```

### 4.2 The model [confirmed: `stats.json`, the glb accessors]

| | Retail `tre_maple03` | New LOD0 | New LOD1 | Impostor |
|---|---|---|---|---|
| Triangles | 139 | 3,078 (bark 2,310, 384 cards) | 832 (bark 636, 98 cards) | 2 |
| Height × width | 16.7 × 17.5 m | 16.6 × 17.1 m | 17.8 × 18.7 m | sphere r 10.35 m |
| Primitives / draws | 2 (skinned clone per placement) | 2 | 2 | 1 |
| Attributes | POSITION, NORMAL, TEXCOORD_0, skin | + TEXCOORD_1 (flex, phase), TEXCOORD_2 (flutter, AO), COLOR_0 (VEC4 ushort; dropped in production, F1) | same | quad |
| glb in `out-opt`, no textures *(fact-check)* | 90 KB | 81 KB | 27 KB | 118 + 134 KB WebP q80 |
| glb | 128 KB (90 KB `out-opt`) | 325 KB (textures 108 KB inside) | 170 KB | 615 + 632 KB PNG |
| Material path in game | PBR `wood` + `foliage` | same, via `convert`: `SroSurfacePlugin`, `SroFoliagePlugin`, `SroFog`; leaves alpha-test | same | ShaderMaterial (GLSL, lab only) |

### 4.3 The look (`work/tmp/trees/overview.png`)

- **Top:** the maple group west of the plaza on Medium, retail (left) and swapped (right).
  - The new maples read as full, round 3D crowns in the retail palette, at the same size.
  - The baked ground shadow still sits under them.
- **Bottom left:** an open field, retail | LOD0 | LOD1 | impostor.
  - LOD1 keeps the silhouette.
  - The impostor holds at its range.
  - The impostor's frame pick is right from the side [confirmed visually].
- **Bottom right:** Blender's same-light comparison.
- **What still needs art direction** (for TR-A, per family, with the user):
  - the crown is a little darker and more olive than retail, because the retail sprite is used at smaller cards with
    more overlap;
  - the trunk could lean more, as retail does;
  - the red autumn highlights are fewer.
- **The black terrain patches** in the field shots are **not from the trees**. The lab adds only tree meshes and
  never touches the terrain, and the patches also lie far from any new tree (`lineup_fields*.png`, at t 0.42 and
  0.55, Medium and High) [likely independent; no retail-only run was made at that spot; cause unknown]. It may be a
  terrain-layer state of the working tree the release workflow is editing. It is passed on to the lead (open question
  Q6).

### 4.4 Draws, triangles and CPU [confirmed: `work/tmp/trees/shots/ab_*.json`, GPU lock held]

| Engine / preset / view | Draws per frame, retail → swap | Tree meshes in view | Tree triangles in view | Maple instances by band (LOD0 / LOD1 / impostor / beyond range) |
|---|---|---|---|---|
| WebGL2 Medium, maple group (v0) | 125 → **114** | 31 → 15 | 4.6 k → 17.0 k | 3 / 5 / 35 / 48 |
| WebGL2 Medium, wide plaza (v2) | 226 → **215** | 46 → 30 | 7.3 k → 19.8 k | 2 / 16 / 29 / 44 |
| WebGL2 High, v0 | 277 → **249** | 38 → 22 | 5.1 k → 32.2 k | 4 / 19 / 37 / 31 |
| WebGL2 High, v2 | 475 → **466** | 70 → 56 | 12.2 k → 49.4 k | 4 / 31 / 13 / 43 |
| WebGPU Medium, v0 | 125 → **113** | 31 → 14 | 4.6 k → 46.0 k (LOD1 in the impostor band) | 3 / 40 / — / 48 |
| WebGPU Medium, v2 | 226 → **214** | 46 → 29 | 7.3 k → 43.8 k | 2 / 45 / — / 44 |
| WebGPU High, v0 | 277 → **248** | 38 → 21 | 5.1 k → 63.0 k | 4 / 56 / — / 31 |
| WebGPU High, v2 | 475 → **465** | 70 → 55 | 12.2 k → 60.1 k | 4 / 44 / — / 43 |

- **What swapped:** only the 91 maple placements (6% of the trees), and the draws went down in every scene: by 9 to
  29.
  - All the drawn new maples together cost at most 5 draws (2 + 2 + 1, one set per band), while each retail maple
    clone costs 2 plus its casters.
  - The High reductions include the retail maples' caster draws. The lab did not register the new LOD0 as a caster,
    and §3.6 would add 2 meshes × 3 cascades = 6 for the maple alone *(fact-check, F4: not "≤ 12" in general)*.
    So the High draw reductions (−28 and −9) are 6 draws smaller once LOD0 casts.
- **CPU** *(fact-check, F7: this paragraph replaces the first draft's)*: `scene.render` time (p50) was 1.5–9.8 ms
  depending on the run.
  - The same scene (High v2, retail) ran at 4.1 / 7.2 / 7.0 ms on WebGL2 and 5.1 / 9.7 / 9.4 ms on WebGPU across the
    three runs (`ab_*`, `rep1_*`, `rep2_*`) [confirmed], so the run-to-run noise is 3–4.6 ms.
  - In the first batch the swap's p50 was at or above retail's in **6 of 8** scenes: WebGL2 2.7→2.8, 4.1→5.6,
    2.6→2.7, 1.9→2.1; WebGPU 3.0→4.2, 5.1→9.0, 1.6→1.5, 3.1→3.1. The repeats of High v2 gave swap − retail of +1.6 and
    −0.6 ms on WebGL2 and +0.1 and −0.6 ms on WebGPU [confirmed].
  - So no CPU saving was shown, and the first batch leaned worse. Two limits of the lab: the per-frame refill
    (`lods.update`) ran outside the timer, and the hidden retail maples kept their `AnimationGroup`s running
    (`setEnabled(false)` on the meshes does not pause them), so the animation saving could not appear [likely].
  - LAB must measure it in the game with `prof.js` (budgets.md method): the plaza and crowd scenes with every family
    swapped, WebGPU High, p95.
- **Triangles in view grew**, by +12 to +50 k. That is the intended trade: GPU triangles for CPU draws.

### 4.5 What the prototype taught [confirmed]

1. **The swap works through the existing seams.** `ObjectMaterials.convert` + `prepareStatic` + the region listener
   is enough for a lab. Production needs a real claim seam, so the retail glb is not fetched (§5 TR-0).
2. **The current foliage plugin handles new static trees unchanged.** The wind channels are extra quality, not a
   blocker.
3. **Blender flips V on every UV set**, so data channels need a decode rule (§3.4).
4. **The Blender glTF exporter writes MASK with cut-off 0.5** when a Math "Round" node sits between the texture alpha
   and the BSDF alpha.
5. **The retail branch sprites work as leaf cards** at 2–3.4 m, and give the SRO look at once.
6. **Impostors bake in about 10 s on the CPU** with no GPU lock, and the hemi-oct frame pick works.
7. **WebGPU needs the WGSL impostor.** A GLSL `ShaderMaterial` is not allowed there (the CDN rule).
8. *(fact-check)* **The dev adapter hides varying-budget failures.** It offers 28 inter-stage variables, so the
   prototype's `COLOR_0` (a varying) rendered fine there but would black-frame a 16-varying adapter (F1). Every tree
   lab run on WebGPU also runs once with `maxInterStageShaderVariables` forced to 16.
9. *(fact-check)* **A headless A/B cannot settle a 1 ms CPU question.** The same scene varied by 3–4.6 ms between
   runs (F7).

---

## 5. Lanes

*(wave 12, 2026-10-01)* The wave-12 lanes are §W8 (T12-*); the TR-* lanes below are the wave-10 plan, kept for the record (TR-I, the impostor lane, is dropped).

Wave 10 has three parts: sky and sea, gameplay and screens, and trees. This is the trees part. Lane ids are `TR-*`.
Every lane runs `pnpm vitest run <its tests>` and `pnpm typecheck` before hand-off; nobody commits; the lead
integrates.

### 5.1 Step order

```
step 0 (parallel):  TR-0 (seams)  |  TR-A (tree tool + the maple, data only)
step 1 (after TR-0 merges):  TR-F (tree field) | TR-I (impostor runtime) | TR-W (wind VDATA)
step 2:  TR-B batches (families, data) | TR-L (lab bench, options) ; GAME row
step 3:  I10T (integration), H10T (hunt), fixes
```

- TR-A has no code overlap with TR-0. It writes the tool and the data only.
- **Dependencies on the rest of wave 10:**
  - TR-I's fog/haze call uses `HeightFog` today and switches to the sky part's haze chunk when that merges. It reads
    it through the fog plugin's own function (*fact-check, F14*: not a new `sroAtmosphere`; SKY2 extends
    `SroFogPlugin`), so the order does not matter.
  - *(fact-check, F14)* **Shared files with SKY2:** SKY2 §8.4 adds `sroCloudShadow` (and one sampler) to
    `pbr/foliage-plugin.ts`, and adds rows to `apps/game/src/settings.ts` and `hud/options.ts`. TR-0 (the VDATA
    skeleton), TR-W (the VDATA branch) and TR-L (the `graphics.trees` row) touch the same files. WAVE_PLAN4 orders
    them: SKY2's skeleton lane (S2-S) first, then TR-0, and each later lane rebases on it. The sampler count of the
    tree leaf material (S2-S's guard test) includes the cloud map.
  - *(fact-check, F14)* The Tidewater licence line goes into COAST's `THIRD_PARTY_NOTICES.md` (S-NOTICE).
  - The coast part re-snaps or drops props on moved ground. The field reads the placements from the re-exported
    manifest, so there is no file overlap.
  - The coast's beach needs no trees in v1.

### 5.2 Lane table

| Lane | Owns (files) | Seams it uses or adds | Tests | User check |
|---|---|---|---|---|
| **TR-0** seams (one agent, first) | `packages/world-render/src/region-chunk.ts` (before `host.acquireModel`, a `host.claim?(model, placements, owner)` hook: a claimed model is never acquired); `stream.ts` (`StreamHooks.claim`, passes through); `objects.ts` (`WorldObjects.setClaimer` for the whole-world `load`, and `removeRegion` tells the claimer); `world.ts` (`World.trees: TreeFieldPart \| null`, updated after `objects.update`, disposed; `LoadWorldOptions.trees?: 'new' \| 'retail'`); `render/shadows.ts` (`WorldShadows.addCasterSource(fn)`, a generic cut-out caster list); `pbr/foliage-plugin.ts` (`SRO_FOL_VDATA` define skeleton, off, switched by a material flag); `trees/types.ts` (the `TreeSwap`, `TreeModel` and `TreeFieldPart` interfaces); `index.ts` exports. *(fact-check, F13)* Also: the claim counts in the region's `pendingObjects` until the field reports the model ready; the claim keys on the render path, and `World.setTreeMode` calls `stream.rebuild()`; `World.meshes()` and the weather's `shelterCandidates` (`weather/index.ts`) add `World.trees?.meshes()` | Adds the claim, the trees part slot, the caster source, the VDATA define and the mesh-list hooks | `trees-seams.test.ts`: no claimer = HEAD behaviour; a claimed model is not acquired and its placements reach the claimer; `removeRegion` reaches it; `'objects'` fires only after the claimer's ready; a Classic-path rebuild claims nothing; the shelter candidates include the field's LOD meshes. `seams-classic.test.ts` unchanged (the Low guard) | nothing visible |
| **TR-A** tree tool + maple | `packages/convert/src/trees/` (new): `blender/make_tree.py` (the prototype, generalised: species params, the §3.4 channel layout, the V-flip rule), `blender/bake_impostor.py`, `build.ts` (runs Blender through `child_process` with the path from a **new** optional `sro.config.json` key `blenderExe`, default the standard 5.2 install path; TR-A adds it to `SroConfig` in `node-io.ts` and to `sro.config.example.json` *(fact-check, F17)*; composes atlases with `sharp`, writes `out/trees/<id>/{lod0,lod1}.glb`, `impostor.{albedo,normal}.png`, `tree.json`), `validate.ts`, `cli.ts`; `content/trees/species/*.json` (params + seed); `content/trees/swap.json`; the root script `"trees": "tsx packages/convert/src/trees/cli.ts"` (lead) | Reads the retail sprites and bark from the converter output; writes the swap table | `trees-validate.test.ts`: the triangle caps; the bounds within ±10% of the retail envelope from the manifest; attributes present with the ranges (flex, phase, flutter in 0..1 after the V decode); exactly `TEXCOORD_0..2` and **no `COLOR_0`** (F1, F2); LOD1 bounds within ±4% of LOD0; leaves MASK and double-sided; every swap source exists in the manifest; the impostor json matches the atlas size | `pnpm trees build maple` makes the maple; the review sheet (retail \| LOD0 \| LOD1 \| impostor, 4 angles) |
| **TR-F** tree field | `packages/world-render/src/trees/{swap.ts, tree-field.ts, buckets.ts, index.ts}` | TR-0's claim and caster source; `ObjectMaterials.convert` (retail texture keys, so the map sets and plugins apply); `WorldObjects.rangeScale` | `tree-swap.test.ts` (parse; keys case- and slash-insensitive; unmapped = retail; `trees: 'retail'` claims nothing; Low claims nothing); `tree-buckets.test.ts` (bands × rangeScale, 3 m hysteresis, refill only after 4 m, counts); `tree-field.test.ts` (NullEngine: `thinInstanceCount` per band, a region removal drops its instances, an empty band is hidden with `isVisible = false` and never visible at count 0 (F13f), group-3 instances stop at 48 m × s (F11), the band test uses `distance − radius` (F12), the meshes set `receiveShadows` and are not pickable, draws = the formula with tints (F18)) | the maples at the plaza are new; walking away, trees change LOD without popping at the same spot twice |
| **TR-I** impostor | `packages/world-render/src/trees/impostor.ts` (`ShaderMaterial` WGSL + GLSL, the texture array, SH + celestial light × `sroCloudShadow` + translucency + the fog plugin's fog/haze function + wet darkening; `HEMI_OCT` encode/decode shared with the bake; the bake's normals are Blender z-up and are swizzled to the scene frame) | TR-0 slot; `SkyState` SH (as the grass chunk); `SroFogPlugin`'s function / SKY2's haze (F14) | `impostor.test.ts`: both languages have the same injection keys and uniforms; the hemi-oct encode/decode round trip equals `bake_impostor.py`'s frame directions (fixture); NullEngine `isReady`; `wgslInterStageCount` ≤ 15 user varyings | distant trees keep their colour against LOD1 at the switch (§4.3 method: crown means within 10%); no glslang request on WebGPU (network log) |
| **TR-W** wind VDATA | `pbr/foliage-plugin.ts` (the `SRO_FOL_VDATA` branch, reading `uv2` = flex/phase and `uv3.x` = flutter; rebased on SKY2's `sroCloudShadow` edit, F14) | TR-0 define | `foliage.test.ts` additions: both languages, same keys; `foliageVdataBend(flex, phase, t)` in TS equals the shader maths; `1 − v` decode; the define stays off without the material flag even when `uv2` exists; `wgslInterStageCount` of the Medium leaf material ≤ 15 user varyings (F1) | in a storm, branches sway with a lag and leaves flutter; calm is nearly still |
| **TR-B** batches (data) | `content/trees/species/*.json`, `content/trees/swap.json` entries, `out/trees/*`, texpipe overrides for the leaf sprites (B-T sets) | TR-A tool; TP-U/TP-P for the sprites; DT-2 (SDXL) only on the user's go | the validator; the lab bench after each batch | a review sheet per batch; in-game shots at the bench spots, dry and in rain, day and night |
| **TR-L** lab + options | `apps/viewer/src/world/trees-panel.ts` (a `?trees=new\|retail` A/B, the band colouring debug view, the counters); `apps/game/src/settings.ts` + `hud/options.ts` row `graphics.trees` (GAME) | TR-F stats | `settings.test.ts`: the row defaults `'new'` on Medium+ and is absent on Low | Options → Graphics → Trees: New / Retail |
| **I10T** integration | the merge order: TR-0 → TR-F → TR-I → TR-W → TR-B data → TR-L | — | full `pnpm vitest run` and `pnpm typecheck`; the §3.9 bench with `prof.js` on WebGPU High and WebGL2 Medium (the plaza, the gate in a storm, the fields at night, the crowd) | before/after shots at the bench spots |
| **H10T** hunt lenses | — | — | (1) retail still drawn behind a new tree (a double draw); (2) a region unload leaves instances behind; (3) Low changed; (4) glslang fetched on WebGPU; (5) a tree floats or sinks on slopes (origin vs terrain); (6) LOD thrash at a band edge; (7) the impostor looks wrong from above (the camera at 60°+); (8) wet or night look mismatch between LOD1 and the impostor; (9) tree caster draws above retail's at the same spot (fact-check, F4: not "above 12"); (10) VRAM over budget without KTX2; (11) the 16-varying adapters (a `COLOR_0` or instance colour on a tree mesh; run with `requiredLimits.maxInterStageShaderVariables = 16`); (12) *(fact-check)* SKY2's depth-reading effects (shafts, GTAO) treating impostor pixels as sky; (13) *(fact-check)* rain falling through canopies (the shelter map misses the field); (14) *(fact-check)* a thin-instance mesh drawn at the world origin (count 0 while visible) | — |

### 5.3 Family batches (TR-B), in order [decision]

1. **B-T1 maple** (91 placements, 90 skinned): the plaza's tree, from the prototype.
2. **B-T2 pine_tall + bigmaple** (441; the fields' mass).
3. **B-T3 broadleaf, bamboo, willow, ginkgo** (408; 397 skinned): the biggest CPU win after the maple.
4. **B-T4 dry, swamp, graveyard, pine_small** (410).
5. **B-T5 dunhuang** (244; mostly the western regions, which the coast part reshapes: after the coast).

The 3 unique town pieces stay retail.

---

## 6. Scope-cut order (cut from the top)

*(wave 12, 2026-10-01)* Superseded by §W10.

1. Ultra's swaying tree shadows (`ShadowDepthWrapper`; blocked by the Babylon WebGPU bug anyway).
2. The 3-frame impostor blend (keep the nearest frame).
3. The dithered LOD cross-fade on High (keep the hard switch with hysteresis). *(fact-check, F9: it is not in v1
   anyway; it waits for D30's TAA reprojection.)*
4. SDXL-painted new sprites (keep the upscaled retail sprites).
5. The second model per family (one model per family, with scale and rotation variety).
6. Impostor normal atlases on Medium (a bent-normal hemisphere instead), then 96 px frames on High.
7. `SRO_FOL_VDATA` (keep the height-based bend and the world-position flutter, which work today).
8. B-T5 and B-T4 families (they stay retail; the field and the swap table take them later).
9. The impostor band (draw LOD1 to the range: on WebGPU the lab showed this still makes **fewer draws** than retail,
   §4.4; *fact-check, F7:* its CPU time was not shown to be lower).

**Never cut:**

- the swap keyed by the retail source, with the placements, nav and ranges unchanged;
- Low unchanged;
- the tree field's global per-model instancing (it is what makes new trees cheaper);
- LOD0 and LOD1;
- the maple batch;
- the "draws ≤ retail" gate, and *(fact-check)* its caster twin (tree caster draws ≤ retail's) and the CPU gate
  (`prof.js` p95 at the plaza and the crowd not worse than retail);
- *(fact-check)* no varying added to any tree material (no `COLOR_0`, no instance colour).

---

## 7. Risks

| Risk | Default handling |
|---|---|
| New crowns look darker or busier than the retail fans | Per family: card size, the count and the AO floor are parameters; the user reviews each batch sheet |
| Alpha-tested overdraw at LOD0 near the camera (many cards) | The ≤ +0.3 ms GPU budget; fewer, larger cards; alpha-to-coverage with MSAA on the Low/MSAA option only |
| A hard LOD switch pops on Medium | 3 m hysteresis; LOD1 is authored from the same skeleton, so the silhouettes match |
| The impostor lighting drifts from the PBR trees at dusk, at night or when wet | TR-I uses the same SH, light, fog and wet terms; H10T lens 8 checks it |
| VRAM of the impostor atlases without KTX2 | 576² on Medium; KTX2 (approved) for High; scope cut 6 |
| Skinned bind-pose bounds overstate some envelopes (`tre_willow03` 81 m) | TR-A measures the retail envelope from the skinned mesh at frame 0 of its clip in Blender, not from the manifest bounds |
| Headless CPU timing noise hides small wins | LAB measures in the game with `prof.js`, the GPU lock held, and the minimum of 5 runs |
| *(fact-check)* The CPU saving does not appear (the prototype's first A/B leaned worse, F7) | The gate decides: if `prof.js` shows no gain at the plaza and the crowd with every family swapped, the tree field ships only for the families whose swap measures ≤ +0, and the rest stay retail. The skinned families (B-T1, B-T3) carry the projected saving, so they are measured first |
| *(fact-check)* A varying on 16-varying adapters black-frames Medium (F1) | No `COLOR_0` or instance colour; TR-W and TR-I count with `wgslInterStageCount`; H10T lens 11 runs with the limit forced to 16 |
| *(fact-check)* Caster draws at forest spots (up to 60 on High, F4) | The caster gate against retail; the leaves cast and the bark does not, if needed |
| *(fact-check)* Big trees turn into blurry impostors near the camera (F12) | The band test on `distance − radius`, and a per-model impostor edge from the frame size |

---

## 8. What the user must provide or approve (each has a default)

*(wave 12, 2026-10-01)* Superseded by §W9.2 (item 4, "no Meshy credits for trees", is now measured: §W2.1; item 9's download is now a net saving, §W6).

1. **The route.** (d) hybrid: procedural wood + retail sprites. **Default: yes.**
2. **The look of the prototype maple** (`work/tmp/trees/overview.png`). A go/no-go on the direction, plus notes (e.g.
   "more red", "thicker trunk"). **Default:** proceed, with the maple as the reference and a slightly warmer crown.
3. **Retail sprites or new sprites.** **Default:** upscaled retail sprites. SDXL-painted sprites only for a family
   the user flags.
4. **Meshy.** **Default: no credits for trees.** The ~820 stay in reserve (a few unique hero trees later, if the user
   wants).
5. **Downloads.** **Default: none.** Sapling and the CC0 packs are not needed.
6. **Low players keep the retail trees** (N100-class). **Default: yes.**
7. **Same size and same places as retail** (nav, baked shadows). **Default: yes.** More trees, or new placements, are
   a later, separate choice.
8. **The family order** (§5.3). **Default:** maple → pines → broadleaf/bamboo/willow/ginkgo → the rest; Dunhuang
   after the coast. *(fact-check)* Because the CPU saving is still only projected (F7), B-T3 (the skinned families,
   where the saving should be largest) is measured with `prof.js` right after B-T1, before B-T2's art goes on.
9. *(fact-check, F6)* **A slightly larger download.** The new trees add ≈ 8.6 MB and drop ≈ 5.4 MB of retail trees,
   so there is ≈ +3.2 MB more for Medium+ players (the first load only, then cached). **Default: accepted.**
10. *(fact-check, F1, Q12)* **Crowns without the inner-leaf darkening** that the prototype's vertex colour gave. It
    would break 16-varying adapters, so it is dropped. **Default:** judge it on the B-T1 review sheet; if it looks
    flat, TR-A adds a darker sprite row for the inner cards.

## 9. Open questions (each has a default, so nobody waits)

*(wave 12, 2026-10-01)* Q1–Q4, Q10 and Q11 are answered by §W3 (bands, no impostors, the per-instance tint offset); the rest stand. New questions are §W9.3.

| # | Question | Default |
|---|---|---|
| Q1 | LOD distances | 45 m / 110 m × rangeScale, on `distance − radius`, capped by the group range; the impostor edge per model from the frame size (F11, F12); tuned in the lab |
| Q2 | Impostor frame size | 6 × 6 × 128 px on High/Ultra, 96 px on Medium; the families wider than ~30 m use 128 px on Medium too if the lab shows them blurry (F12) |
| Q3 | LOD transition | *(fact-check, F9)* a hard switch + 3 m hysteresis on every preset; the bayer dither over 6 m on High+ only once D30's TAA reprojection renders |
| Q4 | Per-instance CPU frustum culling | off; turn it on only if the lab shows fewer vertices for less than 0.05 ms |
| Q5 | Should the new trees keep a slow skeletal sway? | No: vertex-shader wind only (the skinned clones' CPU cost is what we remove) |
| Q6 | The black terrain patches seen in the lab (fields, grassland; Medium and High; WebGL2, headless) | not a tree issue; reported to the release lead to check against the working tree's terrain layers |
| Q7 | The skinned retail envelope sizes | measure in Blender from the posed mesh; the manifest bounds are an upper limit |
| Q8 | Swaying tree shadows on WebGPU | static tree shadows until the `ShadowDepthWrapper` bug is fixed (§1.6) |
| Q9 | Do `uv2`/`uv3` need varyings on the 16-varying adapters? | No (attributes only) [likely]; TR-W checks it with `wgslInterStageCount`. *(fact-check, F1)* `COLOR_0` **does** add one (`vColor`) [confirmed], so it is dropped |
| Q10 | One impostor draw for all models (texture array) vs one per model | the texture array; per-model atlases as the fallback (also if Babylon's KTX2 path cannot fill an array [unknown]) |
| Q11 | Tree tints (the maple's green, green2, middle, red) | one model with a per-entry tint: the sprite's texture key per swap entry, so TX-R's map sets still apply. *(fact-check, F18)* Each tint is its own leaf mesh per band (+1 to +6 draws at the bench spots); per-instance colour is ruled out (a varying) |
| Q12 | *(fact-check)* Crown depth without the `COLOR_0` AO | bent card normals + SH + SSAO on High + the AO in the impostor bake; if the user finds the crowns flat, a darker sprite row for the inner cards, chosen by UV (no varying) |
| Q13 | *(fact-check)* What if `prof.js` shows no CPU gain | ship only the families whose swap measures ≤ +0 (skinned families first), the rest stay retail; the look can still be offered on High as an option |

