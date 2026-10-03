# Wave plan 6: wave 10 redefined, "fast, alive, and a coast all round"

This plan merges five fact-checked specs into one build order for the wave the user redefined on 2026-09-29:

- **docs/BATCHING.md** (item 1): region batches on one "array material", static trees with shader wind, the grass
  contract. Target: the plaza from ~700 draws to well under 100 world draws, and High at 60 fps.
- **docs/COAST.md** (item 2, the "beaches everywhere" revision and its fact-check): the ocean with Tidewater-style FFT
  waves and shore foam, the Option A land bridge toward Donwhang, Jangan Bay at +5 m, the walkable south beach, a beach
  in front of every sea shore, the mountains at the edge lowered and hand-sculpted in Blender.
- **docs/MOVEMENT.md** (item 3, jump only): Space = a cosmetic, server-authoritative jump with polished clips keyed in
  Blender. The dodge roll is deferred.
- **docs/SCREENS.md §0B** (item 4, stage B only): character select and create on the Jangan "palace steps".
- **docs/GRASS_LIFE.md** (item 5): our own "lush painterly" grass with no gaps, flowers, butterflies, bird flocks,
  fireflies and dragonflies.

The user's list, verbatim:

> 1: Make all tree's, town building's, and grass a single draw call. Lets increase performance.
> 2: The coast: the ocean around the map with realistic waves and shore foam, the land bridge toward Donwhang, Jangan
> Bay, and the walkable south beach. Blender is available for hand-sculpting the edges. Lets modify the map, i dont
> want no sharp edges, all edges of the map if its near the water it should have a beachy area. So use blender to make
> this happen.
> 3: Jump (Space) only, with polished animations made in Blender.
> 4: Character select and create on the Jangan palace steps.
> 5: I want jangan map to flourish with life, a grassy area should be filled with grass, ( i hate that each grass is
> seperated and you can see empty spaces), lets work on this. Either create your own grass (cuz i hate the retail one)
> make them face you or something (but make sure there is performance based). Add butterfly, and birds etc.

The user's answers (work/tmp/w9-user-decisions.md, "the NEXT WAVE, redefined by the user"): beaches along **all** of
the sea coast and no sea cliffs, inland riverbanks and the lake stay retail; grass "Lush painterly"; life =
butterflies, birds, fireflies and dragonflies, flowers and small plants. Deferred ("None: defer them all"): the new
3D tree models, the sky upgrade, the intro flight, pets/friends/mail, the dodge roll. "Single draw call" was explained
to the user as instancing and merging down to a handful of draws per area.

This plan does what WAVE_PLAN3 did for wave 9:

- it settles every place where the five specs disagree or leave a file or a piece of state with two owners (§2);
- it merges the wire additions into one collision-free protocol list, and confirms there is no migration (§3);
- it lands **the seams first** (§4), with **batching's seams as the very first commit**, because the grass's tagging
  contract, the retail-tuft filter and the coast's moved props all meet in the batcher's region claim;
- it holds the sum of the five budgets against the measured wave-9 numbers (§5);
- it orders the lanes, the integration and one hunt (§6), and gives one scope-cut order (§7), one list of what the
  user provides or approves (§8), risks (§9) and open questions (§10).

When this plan and a spec disagree, **this plan wins**. The specs stay the detailed design of each lane; a lane reads
its spec sections and this plan's row for it. **docs/WAVE_PLAN4.md and docs/WAVE_PLAN5.md are superseded for this
wave** (§11 lists which of their parts are deferred and which carry over).

**Tags.**

- **[confirmed]**: checked in the code or data of the working tree on 2026-09-29, in `@babylonjs/core` 9.28, or
  measured by a spec's prototype and re-derived by its fact-check. Each one says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived), not measured on that setup.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this plan makes. The user may overrule it.

**Repo state when this was written [confirmed: `git log`, `git status`].**

- HEAD `a649715` (23:40, "Release follow-up: bloom off by default + Bloom option; Weather effects row on first open"),
  on top of the wave-9 release `b6fb115`. The working tree is clean outside `docs/` (the three revised specs and the
  two new ones). **The release workflow has committed**, so the gate that SCREENS and MOVEMENT put on `settings.ts`,
  `hud/options.ts`, `charselect.ts`, `charcreate.ts`, `models.ts` and `render/quality.ts` is met; every seam agent
  still re-reads those files, because `a649715` changed `settings.ts`, `hud/options.ts`, `render/post.ts` and
  `render/quality.ts` after the specs were written.
- `a649715` ships **bloom 0 on every preset** [confirmed: its `quality.ts` diff]. The wave-9 budgets and the batching
  lab were measured with bloom on (0.5 Medium, 1 High), so today's post-pass count and GPU are slightly lower than
  the numbers below [likely]; LAB-10R re-measures the baseline (§5.3).
- **HTTPS is done** (tailscale serve, 2026-09-29) [confirmed: w9-user-decisions "wave 10 / 11 design decisions"]. So
  the friends now run **WebGPU**, with WebGL2 as the fallback. Every budget below has a WebGPU and a WebGL2 column,
  and WebGPU is the one the friends see.
- Hooks named below are found by their quoted code, not their line numbers (the specs' line numbers drift).
- Scratch the lanes port from: `work/tmp/batching/` (lab, `batch.ts`, `buildings.ts`, `array-plugin.ts`,
  `factcheck/`), `work/tmp/coast-beach/` (`coast_beach.py`, `census.py`, Blender `rt/`), `work/tmp/coast-beach-fc/`,
  `work/tmp/coast/` and `work/tmp/coast-refresh/` (ocean bench, Blender scripts), `work/tmp/grass-life/lab/`,
  `work/tmp/movement/polish/` (`key_moves.py`, `make_pack2.py`, `keys/*.json`), `work/tmp/stage/`. This plan's own
  arithmetic is `work/tmp/w10r-plan/budget.py`; the preview sheet is `work/tmp/w10r-preview.png`.

---

## 0. Summary

1. **Five items, one seam step, batching first.** Four foundation agents run first and in parallel, on disjoint files
   (§4): **W10-S** (every `packages/world-render` seam: batching's claim and listener contract **first**, then the
   grass/life slots, then the coast hooks, then the shared budget guards), **W10-G** (every `apps/game` seam: settings
   and Options rows, the stage host field, the jump hooks), **W10-P** (the shared protocol, validators, constants and
   mock), and **W10-CV** (the converter hooks: CST-C's first commit). After them the part lanes own disjoint files.
2. **One owner per shared module** (§2.1, §2.2):
   - the region claim, `objects.ts`, `materials.ts`' batch record, `region-chunk.ts`, `stream.ts`, the shadow and
     night-light listener contract: **W10-S**, then nobody but the integration;
   - the batch itself (`batch/**`), the atlas and material table, and the texture loader's decode/upload paths
     (`pbr/decode-worker.ts`, `textures.ts`): **BT-A / BT-M**; `pbr/maps.ts` is not edited this wave (the 9B batches
     are on hold);
   - the coast's re-snapped and dropped props: **CST-C, in the converter, by placement uid, before anything else reads
     the placements**; the batcher only ever sees the result;
   - the grass scatter (`scatter.ts`, `grass/**`, `life/**`): **GL-F / GL-L**; the batcher never takes a mesh tagged
     `scatter` or `life`.
3. **Protocol (§3):** one client request and one server event (`jump`), two optional `ServerInfo` fields
   (`clock`, `weather`) for the stage's time. No new fail reason, no GM command, **no database migration**
   [confirmed: no lane adds a table or a column].
4. **Budgets (§5), against the measured wave-9 gate:**
   - **Medium (the default) holds 60 fps everywhere** on both backends, with room: it projects to ≈ 3–8 ms p95 on the
     dev PC (worst: the 20-mob crowd with 20 jumping bots on WebGPU) [projected].
   - **High reaches 60 fps on the dev PC** thanks to batching: plaza 17.9 → ≈ 6–9 ms, crowd 21.5 → ≈ 10–12 ms (≤ 13
     with 20 jumping bots) on WebGPU [projected from the measured lab ratio]. On a mid desktop CPU the High crowd stays
     borderline (≈ 15–18 ms) and on a gaming laptop it misses (≈ 20–24 ms): the remaining cost is characters, which
     no item of this wave batches (§9).
   - "Well under 100" holds for **world** draws: ≈ 80–85 at the plaza on High, ≈ 60–65 on Medium; each character adds
     ≈ 8 draws (BATCHING F24).
5. **Order (§6):** step 0 seams (+ the data lanes that need no code) → step 1 the core lanes of all five items in
   parallel → step 2 the dependent lanes → re-convert checkpoints X1 and X2 → step 3 one integration (I-10R), one
   bench (LAB-10R), one hunt (H-10R). The stage is benched last, after batching, the coast and the life land.
6. **Never cut** (§7): the Low guard; batching's static tree variants, per-region building batches, worker build and
   A/B option; a beach in front of every sea shore with no sea cliff and no crease at the bounds line; the frozen
   playable area and S1's in-bounds link; the grass's no-gap density with ≤ 3 draws; butterflies and flushing
   flocks; the jump's server authority and lock rules; select and create on real Jangan with the fallback; Medium at
   60 fps (gate G1).
7. **What the user must do (§8):** nothing blocks the start. The user approves the look sheets
   (`work/tmp/w10r-preview.png` and each spec's sheet), and a handful of choices each with a default. Nothing is
   downloaded or uploaded, and no new 3D model is made.

### 0.1 Where each user request lands

| User request (verbatim fragment) | Where | Lanes |
|---|---|---|
| "Make all tree's, town building's, and grass a single draw call" | BATCHING §3: region batches (2–6 meshes per region), trees static + merged, the grass as ≤ 3 + ≤ 3 draws | W10-S (BT-0 part), BT-A, BT-M, BT-P, BT-S, BT-T, BT-C, BT-L |
| "Lets increase performance" | §5 gates G1–G4; the lab's 572 → 166 draws, CPU 15.1 → 3.5 ms p50 [confirmed] | LAB-10R, I-10R |
| "the ocean around the map with realistic waves and shore foam" | COAST §8: worker FFT (Medium, WebGL2), GPU FFT (High/Ultra WebGPU), Gerstner (Low); shore v1 (foam band, lace, swash) | CST-O, CST-S |
| "the land bridge toward Donwhang, Jangan Bay, and the walkable south beach" | COAST §0.1, §4, §3.5 (S1), §9.4 with the S1 in-bounds link (G1) | CST-C, CST-M |
| "i dont want no sharp edges ... beachy area ... use blender" | COAST §3B: a beach kind per section, the flank envelope, the tomb crest keep, scripted Blender passes | CST-C, CST-B |
| "Jump (Space) only, with polished animations made in Blender" | MOVEMENT §3.2–§3.3 (hand-keyed bpy, polished), §4–§6 | W10-P, MV-A, MV-P, MV-C |
| "Character select and create on the Jangan palace steps" | SCREENS §0B (the south-gate steps: the image the user chose; no palace model exists) | W10-P (fields), W10-G (stage field), SCR-P, SCR-R, SCR-SEL, SCR-CRE |
| "a grassy area should be filled with grass ... no empty spaces" | GRASS_LIFE §3: 45 / 74 blades per m² on the splat's grass layers, soft road edges | GL-S, GL-F, GL-T, GL-C |
| "make them face you or something (but ... performance based)" | GRASS_LIFE §2.1: each blade turned 55 % toward the camera; GPU-procedural patches, 3 draws | GL-S, GL-F |
| "Add butterfly, and birds etc." (+ fireflies, dragonflies, flowers) | GRASS_LIFE §4–§5; the coast's gulls as a species (COAST S-LIFE) | GL-L, CST-A |
| Standing goal "at least 60 fps", High "should now reach 60 fps thanks to batching" | §5.4 gates | LAB-10R |

---

## 1. Lane ids

| Id | Step | From spec | What |
|---|---|---|---|
| **W10-S** | 0 | BATCHING BT-0 + GRASS_LIFE GL-0 + COAST I-CST hooks (moved forward, as WAVE_PLAN4 D11) + WAVE_PLAN4 D14/D16 | Every `packages/world-render` seam, in the order batching → grass/life → coast → guards (§4.1) |
| **W10-G** | 0 | SCREENS SCR-S + MOVEMENT's client seams + the settings/Options parts of BT-L and GL-O | Every `apps/game` seam (§4.2) |
| **W10-P** | 0 | MOVEMENT's protocol seams + SCREENS SCR-P (shared part) | `protocol.ts`, `validate.ts`, `shared/movement.ts`, the mock, PROTOCOL.md (§3, §4.3) |
| **W10-CV** | 0 | COAST CST-C's hook commit, extended for BT-C and GL-C; WAVE_PLAN4 D13's Blender helper | Converter hooks, manifest types, the `blenderExe` key and helper, the CLI verbs (§4.4) |
| MV-A | 0 → 2 | MOVEMENT MV-A | Blender keying of the clips (data work starts at once; code after W10-CV) |
| CST-C | 0 (port) → 1 (phase 1) → 2 (phase 2) | COAST CST-C (+ §12.13) | The converter coast pass with beaches everywhere; `content/coast/coast.json` |
| BT-C | 1 | BATCHING BT-C | Static variants of the 18 skinned foliage models |
| GL-C | 1 | GRASS_LIFE GL-C | Tile grass weights and palettes (perches only if the run-time rule fails) |
| CST-B | 1 | COAST CST-B (+ §12.13) | The Blender round trip, the scripted passes, the Tiger and tomb sessions |
| CST-M | 1 (converter), 2 (client) | COAST CST-M | Minimap and world map |
| BT-A, BT-M, BT-P | 1 | BATCHING | Atlas + table; merge worker + region batch; the table plugin |
| GL-S → GL-F, GL-L, GL-T | 1 | GRASS_LIFE | Grass shaders, the field, the life, the terrain tint |
| CST-O | 1 (spike first) | COAST CST-O | The ocean surface |
| CST-T | 1 (GPU queue) | COAST CST-T | The B-coast texture batch (data) |
| MV-P, MV-C | 1 | MOVEMENT | Server module; client jump |
| SCR-P, SCR-R | 1 | SCREENS | Server `serverInfo()` fields; the stage runtime |
| BT-S, BT-T, BT-L, BT-K (optional) | 2 | BATCHING | Shadows; trees; lab panel and bench; Classic batch |
| CST-S, CST-A | 2 | COAST | Shore v1; coast sound, ships, the gull registration |
| GL-O, GL-A (optional) | 2 | GRASS_LIFE | Options defaults, viewer panel, flush sound; petal atlas |
| SCR-SEL, SCR-CRE | 2 | SCREENS | Select and create on the stage |
| MV-L (optional) | 2 | MOVEMENT | Viewer lists the movement clips |
| **LAB-10R** | 2–3 | BATCHING BT-L bench + GRASS_LIFE I-GL bench + COAST I-CST step 4 + SCREENS SCR-R bench + MOVEMENT §9.5 | One bench list, one method, one results file (§5.3) |
| **I-10R** | 3 | I-BT + I-CST + I-GL + I-MV + I-SCR | Integration, re-converts, docs, deploy list (§6.4) |
| **H-10R** | 3 | H-BT + H-CST + H-GL + MOVEMENT's lenses + H-SCR | One adversarial hunt (§6.5) |

**Dropped ids:** BT-0 and GL-0 (→ W10-S); SCR-S (→ W10-G); MOVEMENT's "seams first" agent (→ W10-P and W10-G);
SCR-P's shared part (→ W10-P; SCR-P keeps `game.ts`); I-BT, I-CST, I-GL, I-MV, I-SCR (→ I-10R); H-BT, H-CST, H-GL,
H-SCR and MOVEMENT's hunt lenses (→ H-10R). BT-L keeps only its viewer panel and bench (its settings row moves to
W10-G). GL-O keeps its defaults, sound and viewer panel (its settings fields move to W10-G). COAST's later lanes
CST-W, CST-F, CST-K are not in this wave (COAST §12.10).

---

## 2. Conflicts and gaps across the specs, with decisions

### 2.1 Architecture and file ownership

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| D1 | Who lands the shared hooks, and in what order | BATCHING §3.14/§6.1 ("GL-0 edits `world.ts` first, BT-0 rebases"), GRASS_LIFE §8.3, COAST §12.8 (I-CST's hooks last), MOVEMENT §8.1 (its own seams agent), SCREENS §0B.10 (SCR-S) | Five seam lanes on overlapping files (`world.ts`, `objects.ts`, `settings.ts`, `protocol.ts`, `convert-world.ts`); the coast's hooks landing last means its lanes cannot test against them | **Four foundation agents in step 0, on disjoint packages** (§4) [decision]: W10-S (world-render), W10-G (game), W10-P (shared), W10-CV (converter). Inside W10-S **batching's seams are the first commit** (the region claim, the listener contract, the geometry export), then the grass/life slots and the retail-tuft filter, then the coast hooks, then the guards. One agent writes all of them, so nobody rebases on anybody. |
| D2 | `world.ts` | BT-0 (`World.batch`, `LoadWorldOptions.batching`, the render-path release/claim), GL-0 (`World.life`, `grassStyle`, `wildlife`, `hideRetailTufts`), COAST (`World.ocean`, `World.coast.seaAt`), COAST S-MOVE (`World.waterLevelAt`) | Three specs edit one class | **W10-S owns every `world.ts` edit**; afterwards only I-10R. `World.batch: BatchPart \| null` (null on Classic); `World.life: LifePart \| null`, updated after the scatter in `update()`, disposed with the world; `World.ocean` as a generic part (`update(camera, dt)`, `meshes()`, `dispose()`), updated after `objects`; `World.coast: CoastAccess \| null` (`seaAt(x, z)`, null until CST-O); `World.waterLevelAt(x, z)` = the sea level where `coast.seaAt`, else the retail water block's plane, else `null`; `setRenderMode` releases every batch before `stream.rebuild()` and re-claims on PBR (BATCHING F12). |
| D3 | `objects.ts`, `region-chunk.ts`, `stream.ts`, `model-cache.ts` | BT-0 (the claim, `meshes()`, `removeRegion`, `'objects'` waits for the batch, `StreamHooks.batcher`, `CachedModel.geometry` dequantized), GL-0 (the retail-tuft skip "in `objects.ts` before `placeStatic` and in the batcher's claim", GRASS_LIFE §1.3), `setRangeScale` forwarding (F11) | The tuft filter and the claim want the same line | **W10-S writes both in one place**: the region claim first drops the models in GL's `RETAIL_TUFT_MODELS` list when `hideRetailTufts` is on (Medium+ with the new grass; never on Low; the stage passes `false`), then hands the rest to the batcher. After W10-S these four files have **no lane owner** (I-10R only). |
| D4 | `materials.ts` | BT-0 (the per-material batch record and `batchClass`), NL's lamp rule (F9) | `batchClass` must use night-lights' exact lamp rule, or a lamp merges dark | **W10-S** adds the batch record and **one shared function** `lampRule(model, material)` (moved out of `night-lights.ts`, used by both NL and `batchClass`). No lane edits `materials.ts` afterwards. |
| D5 | The texture loader | BT-A (a cell job in `pbr/decode-worker.ts` / `decode-core.ts`, sub-rect uploads in `textures.ts`, TX-R's `onChange` rewrites the slot) | 9B's TX-R owned these files; the remaining 9B batches are **on hold** (the user, "on hold (2026-09-29)") | **BT-A owns `pbr/decode-worker.ts`, `pbr/decode-core.ts` and `textures.ts` for this wave** [decision]. `pbr/maps.ts` is **not edited**: `applyMapRecord` already takes `ApplyOptions.onChange` [confirmed: `maps.ts` `export function applyMapRecord(…, opts?: (() => void) \| ApplyOptions)`]; W10-S adds a `mapsChanged(material)` notification on the converted-material record that BT-A subscribes to. CST-T's B-coast sets are data through the unchanged loader. |
| D6 | The coast's moved props vs the batcher | COAST C9 / S-DRAW / G15, BATCHING §3.14, GRASS_LIFE GL-C perches | Three consumers of `manifest.placements` | **CST-C applies C9 in the converter, by uid, before every other converter step** (static variants, grass palettes, perches); the runtime batcher builds from the live placements, so a dropped uid can never be in a batch and a re-snapped one carries its new y [confirmed: the batcher is runtime, `work/tmp/batching/lab/batch.ts`]. No shared module. Test: S-DRAW (§6.3). |
| D7 | The grass scatter vs the batcher | BATCHING §3.6, GRASS_LIFE §8.1/§8.3 | Who may merge ground cover | **GL-F owns `scatter.ts` after W10-S** (W10-S adds `ScatterStyle`, `GroundCover`, `adopt(material)`); the grass and life meshes carry `metadata.sroWorld = 'scatter' \| 'life'`, and the batcher refuses both (a W10-S test). The ocean is never batched either. |
| D8 | `render/shadows.ts` | BT-0 (`addCasterSource`, proxy input, `placed` with `meshes = []` for merged pieces), BT-S (worker proxies, terrain skin, cut-out caster) | Two lanes | **W10-S** adds the caster source, the proxy input and the listener contract (`placed` + a new `batched(owner, batch)` event, F10); **BT-S owns the file afterwards**. |
| D9 | `night-lights.ts` and `weather/index.ts` | BT-0 (lamp slots via table texel 5, F9; shelter candidates from `World.meshes()`) | Wave-9 files with no lane this wave | **W10-S** makes both edits; no lane edits them afterwards. NL's `setEmissive` writes the table texel through a callback the batch registers. |
| D10 | `pbr/surface-plugin.ts`, `pbr/foliage-plugin.ts` | BT-P (`SRO_TABLE`, `SRO_FOL_PIVOT`, the minimum breeze); WAVE_PLAN4's TR-W and SKY2 edits | Deferred lanes also claimed them | **BT-P owns both** this wave (TREES and SKY2 are deferred). |
| D11 | `shaders.ts` `WORLD_SHADER_CHUNKS` and `pbr/terrain-plugin.ts` | COAST (`COAST_CHUNKS`, the `sroCoastWet` extern), GRASS_LIFE GL-T (`SRO_GRASS_TINT` chunk and one call) | Two lanes add to a "no lane edits this file" list and to RND-T's plugin | **W10-S** adds both entries with empty chunk files, in the order sky → weather → night → coast → grass-tint → render (`[SKY, WEATHER, NIGHT, COAST, GRASS_TINT, RENDER_GRASS]`), and both calls in `terrain-plugin.ts` behind their defines. With every chunk empty the strings equal HEAD's (the existing snapshot test). **CST-S owns `coast/chunks.ts`, GL-T owns `grass/chunks.ts`**; nobody edits `shaders.ts` or `terrain-plugin.ts` afterwards. |
| D12 | `water.ts` | COAST F5 (a public "ensure the PBR water state" call, a Classic frames getter) | — | **W10-S**, as WAVE_PLAN4 D11 had it. |
| D13 | Material budgets | BATCHING F7/F8 (≤ 256 layers, 4 object samplers), GRASS_LIFE X6 (no terrain sampler), COAST F16 (`sroCoastWet` +1 unit), WAVE_PLAN3 D32 (High WebGL2 terrain at 14–15 of 16) | Each spec guards its own materials; nobody counts the sum | **W10-S writes one guard pair** (WAVE_PLAN4 D16, kept): `test/material-budgets.test.ts` (NullEngine, GLSL: texture units ≤ 16 per final define set for the terrain incl. `sroCoastWet` and `SRO_GRASS_TINT`, the batch group material, the ocean, the grass and the life; every texture array ≤ 256 layers) and the varying count (`wgslInterStageCount` ≤ 15 user + `front_facing` on every WGSL variant). Each lane registers its define sets there. |
| D14 | `THIRD_PARTY_NOTICES.md` | COAST S-NOTICE, WAVE_PLAN4 D14 | — | **W10-S creates it** (the Tidewater entry at `4811ba4`, the MIT text and copyright line, an empty file list) with `packages/world-render/test/tidewater-notices.test.ts`; CST-O and CST-S append their files. I-10R adds it to the deploy list. |
| D15 | `settings.ts`, `hud/options.ts`, `graphics.ts`, `i18n/en.ts` | BT-L ("World batching" row; applies through `stream.rebuild()`), GL-O ("Grass" row, "Wildlife" row, Mac and iGPU defaults), MOVEMENT (`en-movement.ts`), the release's `a649715` | Three lanes on one normaliser, plus a file the release just changed | **W10-G adds every field, normalisation, row and string registration** (§4.2); **GL-O owns `settings.ts`, `hud/options.ts` and `i18n/en-render.ts` afterwards** (defaults tuning). `graphics.ts` gets its calls from W10-G only (`world.setBatching(on)` → release + rebuild, `world.life?.setEnabled`); SCREENS keeps its promise of no `graphics.ts` edit. The i18n files register in **`en.ts`**, not `i18n/index.ts` as MOVEMENT's lane row says [confirmed: `en.ts` imports `enRender`, `enWeather`]. |
| D16 | `models.ts`, `entities.ts`, `intents.ts`, `features.ts` | MOVEMENT MV-C; BATCHING (no actor batching, §3.7 [confirmed]); SCREENS (plays clips through the existing `playClip` [confirmed]) | Only one lane edits them | **W10-G** lands MOVEMENT's seams (empty `playMove` / `movementClip`, the `KEEP_CLIPS` entry, an optional resume phase on the base restart, the `jump` branch in `entities.ts` behind `hasMovementClips`); **MV-C owns the four files afterwards**. |
| D17 | `app.ts` and `screens/world.ts` | SCREENS SCR-S (`stage: StageHost`), GRASS_LIFE GL-O (`world.life?.setThreats(...)`) | GRASS_LIFE said `screens/world.ts` is "shared with MOVEMENT's client lane"; MOVEMENT does not edit it [confirmed: its lane table; the world screen's keydown handles Enter and Escape only] | **W10-G** adds the lazy `stage` field (+ `stage/types.ts`, a stub `stage/host.ts`) and the one `setThreats` line; afterwards SCR-R owns `stage/**` and nobody edits `app.ts` or `screens/world.ts`. |
| D18 | `protocol.ts`, `validate.ts` | MOVEMENT (`jump` both ways), SCREENS SCR-P (`ServerInfo.clock?/weather?`) | Two lanes, two files | **W10-P writes both additions completely** (§3). Afterwards MV-P owns `apps/server/src/movement.ts` and its edits to `gameplay.ts`, `mounts.ts`, `alchemy.ts`, `social/trade.ts`; SCR-P owns `apps/server/src/game.ts` `serverInfo()`. Disjoint. |
| D19 | The converter | CST-C (`convert-world.ts`, `manifest.ts`, `world/coast/**`), BT-C (`models[i].staticVariant`, F13), GL-C (`tiles[].grass`, one call), CST-B and MV-A (`blenderExe`, `packages/convert/tools/blender/`, S-BLENDER), `cli.ts` (CST-B's `coast-export`/`coast-import`, MV-A's `moves`) | Three lanes hook the same two files; WAVE_PLAN4 gave the Blender helper to TR-A, which is deferred | **W10-CV = CST-C's first commit, extended** [decision]: the three hook call sites in `convert-world.ts` in the order **coast (C9) → static variants → grass palettes**, the manifest types (`WorldCoast`, `WorldRegion.synthetic`, `models[i].staticVariant`, `tiles[].grass`) with their validators, the **one** `blenderExe` key (`SroConfig` in `node-io.ts`, `sro.config.example.json`) and the helper `packages/convert/src/blender.ts` (`blenderPath`, `runBlender` refusing relative paths, COAST §6.6), and the three CLI verbs pointing at stub modules. Afterwards **CST-C owns `convert-world.ts` and `manifest.ts`**; BT-C owns `world/static-variants.ts`, GL-C owns `world/grass.ts`; CST-B owns `tools/blender/*.py` and `passes/`, MV-A owns `tools/blender/moves/`. |
| D20 | Audio files | GL-O (`audio/ambient.ts`, the flush one-shot), CST-A (`audio/coast.ts`, the `COAST` area), MV-C (`audio/entity.ts` or `audio/cues.ts`), SCR-R (`GameAudio.setArea` only) | — | Disjoint [confirmed by the lane rows]; no seam needed. |

### 2.2 State ownership (one source of truth each)

| State or module | Produced by | Consumed by | Owner lane |
|---|---|---|---|
| Which placements exist, and where | the converter (retail + C9 re-snap/drop/add by uid) | the batcher, the Classic chunks, the tree variants, the grass floor mask (`nav.locate`), perches | **CST-C** (data) |
| Which placements the batcher may take | the region claim (tuft filter, `batchClass`) | BT-M, NL, shadows, weather | **W10-S** writes; frozen afterwards |
| The material table (albedo/NRAO cells, class params, cut-off, direct intensity, SSR, lamp emissive texel 5) | `batch/table.ts`, `batch/atlas.ts`, `batch/lightmaps.ts` | `SRO_TABLE`, NL (writes texel 5 through a callback) | **BT-A** |
| The region batches (meshes, group materials per key, ranges, group-3 collapse) | `batch/region-batch.ts` + worker | `World.meshes()`, shadows, shelter | **BT-M** |
| Tree wind (pivot, minimum breeze) | `SRO_FOL_PIVOT`, `max(wind, 0.15)` | static trees | **BT-P** (shader), **BT-T** (groups) |
| The grass field window (density, flowers, palette, height, baked light) | `grass/field.ts`, `bake.ts`, `window.ts` | the grass, the butterflies' meadow anchors | **GL-F** |
| Wildlife (species, habitats, threats, pools) | `life/**` | the gull species (CST-A registers), the stage (`configure({ groundFlocks: false })`) | **GL-L** |
| The coast field, `manifest.coast`, synthetic regions, `places` | the converter | the ocean, the shore, the minimap, `World.coast.seaAt`, `waterLevelAt`, the server's `tp` | **CST-C** |
| The ocean surface, the CPU wave query | `ocean/**` | CST-S, CST-A (ships), the stage's visibility switch | **CST-O** |
| The jump clips, `movement.json` index (`runJumps`, `enterPhaseS`, `exitPhaseS`, `air`) | `export-moves.ts`, `content/moves/**` | MV-C | **MV-A** |
| The jump's acceptance, cooldown, broadcast | `apps/server/src/movement.ts` | every viewer | **MV-P** |
| Stage definitions, the stage world, the key light, the sunset hold | `stage/**` | `charselect.ts`, `charcreate.ts` | **SCR-R** |
| The world's clock and weather for the lobby | `serverInfo()` | the stage's time | **SCR-P** |
| Wind | `WeatherFrame` (built in wave 9) | grass, static trees, clouds, the sea | **WX-R/WX-C (built, frozen)** |
| Preset rows (`RENDER_PRESETS.ocean`, grass tiers, batching on/off per preset) | `render/quality.ts`, `grass/types.ts` | all lanes | **W10-S** writes; **I-10R** changes |
| Settings fields and Options rows | `settings.ts`, `hud/options.ts` | the game | **W10-G** writes; **GL-O** tunes |

### 2.3 Cross-item conflicts in behaviour

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| D21 | The grass push under a jumping player | MOVEMENT §2.2/§8.1 (`air` curve + `jumpLift(view, now)` "because GRASS_LIFE's push fades above 0.5 m"), GRASS_LIFE X8 ("the push has nothing to fade: the grass stays parted for the 0.43 s in the air") | One spec builds an API the other no longer uses | **No push fade in v1** [decision, following GRASS_LIFE X8]. MV-A keeps the `air` curve in the index (its contact tests use it); MV-C **does not build `jumpLift`** unless GL-F asks for it at integration. |
| D22 | The landing sound in the sea | MOVEMENT §6.4/Q11, COAST S-MOVE | The surface probe reads the sand tile under the shallow sea | `World.waterLevelAt(x, z)` (W10-S, D2); CST-O fills the sea part through `seaAt`. MV-C plays the water step when the landing point is below that level. No splash in v1. |
| D23 | Gulls | COAST B15/G8/S-LIFE, GRASS_LIFE §8.3 | The coast had its own flock and the retail hawk | **A procedural species of GRASS_LIFE's one bird mesh**, registered by CST-A through `life.addSpecies` / `addHabitat` with `World.coast.seaAt` (over water deeper than 8 m, loafing on dry sand). No `apps/game/src/world/fx/birds.ts`; gull calls stay in the `COAST` ambience. |
| D24 | Placed retail tufts in the new carpet | GRASS_LIFE §1.3 / Q12 | 695 low tuft placements would stand in the new grass | Hidden on Medium+ where the new grass draws (the claim filter, D3); tall weeds, reeds, barley, flowers and water plants stay; everything stays on Low and on the stage (SCR-R passes `hideRetailTufts: false`). The user judges it in the viewer A/B (§8 item 6). |
| D25 | Ground flocks on the stage | SCREENS §0B.14 Q6 ("[unknown]: not in GL-0's lane row"), GRASS_LIFE fact-check (`configure({ groundFlocks })` added to GL-0) | — | **Resolved:** W10-S's life slot includes `LifePart.configure({ groundFlocks })`; SCR-R calls it with `false`. The stage gets butterflies (anchored on the placed flower beds, GL-L's second anchor source), perchers and fly-overs. |
| D26 | Create's draw-range cap 0.6 | SCREENS §0B.9/Q9, BATCHING F11 | After batching the cap removes at most one region | The batcher follows `WorldObjects.setRangeScale` live (W10-S); SCR-R keeps the cap and re-applies it after `WorldGraphics.apply()`; **LAB-10R re-benches create after batching** and I-10R drops the cap if High create p95 ≤ 8 ms at the preset's own range (expected). |
| D27 | The ocean behind walls (the stage, the plaza) | SCREENS §0B.9 (the CDLOD selects by frustum; the bay and the south sea are inside the 2,000 m far plane), COAST F2 ("invisible from the plaza"), WAVE_PLAN4 D19 | Draws and FFT ticks for water nobody sees | **The CDLOD selection stops at the full-fog distance** of wave 9's height fog (transmittance < 0.1 %), as WAVE_PLAN4 D19 decided for SKY2's haze [decision; projected ≈ 600 m on a clear day]; the worker FFT idles when no node is selected. SCR-R still hides the ocean on the stage if LAB-10R measures > 0.3 ms there. |
| D28 | Flank paint vs grass slope | COAST G7 (grass tiles to 38°, blend 38–45°, rock above 45°), GRASS_LIFE §3.2 (full grass to 36.9°, none past 45.6°) | — | COAST G7's thresholds stand, so the lowered mountains come down green; the beach tiles carry grass weight 0 [confirmed: no "grass"/"weed" in the sand tile names]. CST-C's paint-share test + GL-F in the viewer. |
| D29 | S1 reachability | COAST G1, §16 Q22 | S1 is not reachable on foot inside the bounds today | The `openTiles` in-bounds link (the cheapest route a nav search finds with the ring closed, about 5 tiles on the east shelf and the NE corner) is part of CST-C phase 1, with the test "S1 reaches the town component with the ring closed" and a no-GM walk in I-10R. |
| D30 | Tree wind vs the retail clips | BATCHING §3.5, Q3 | The retail clip sways in calm air; shader wind may be near zero | Minimum breeze `max(wind, 0.15)`, tuned by BT-T at the grove against the retail clips; Low keeps the retail trees (skinned hidden, as today). |
| D31 | A jump and an alchemy fuse | MOVEMENT §4.3, Q8 ("the wave plan may flip it") | A refused jump would still cancel the fuse (gate order) | **Flipped: `'jump'` is not added to `FUSE_CANCELLERS`** [decision]. The jump is cosmetic, like `emote`, which is not a fuse canceller [confirmed: MOVEMENT Q8]; this removes the "refused jump cancels the fuse" wart. MV-P's fuse tests change accordingly. |
| D32 | The movement pack on the stages | MOVEMENT §6.1, SCREENS §0B.10 | — | Loaded only on the world screen after `worldEnter`, never awaited, never on a stage [confirmed: both specs agree after their fact-checks]. |
| D33 | Low | all five | — | **Low stays exactly as today** in all five items: no batching, retail trees, retail scatter and tufts, the Classic stage path. The coast's terrain and Classic ocean are content a Low player also gets (WAVE_PLAN4 D21's reading of the guard: with empty chunks and no `manifest.coast` in the fixture, strings and defines equal HEAD's). |
| D34 | WebGPU snapshot rendering | BATCHING §3.11 | Measured slower (STANDARD) or invalid (FAST) after batching | Not in this wave; a backlog experiment (BATCHING Q7). |
| D35 | First-run preset | the release ("Medium default, High optional"), the user's earlier "dedicated GPU → High" | High may pass after batching | **Unchanged in this wave** (Medium on every adapter class). If LAB-10R shows G2 passing, §8 item 9 asks the user whether gaming desktops should start on High. |

### 2.4 Data, content, tools and delivery

| # | Topic | Decision |
|---|---|---|
| D36 | Re-converts of `jangan-fields` | Two lead checkpoints, each `convert` + `optimize-out --only world/jangan-fields/` when no other lane writes `work/out/world/`: **X1** after CST-C phase 1, CST-M (converter), CST-B's first sessions, BT-C and GL-C (one run writes the coast, the static tree variants and the grass palettes); **X2** after CST-C phase 2 (W, NW, the corridor). Batching, grass and the stage work on either export. |
| D37 | The GPU queue | Every GPU timing and GPU data job takes `work/tools/gpu.lock` (mkdir; the owner file names the label and time; only the creator removes it). Priority: LAB-10R timings > CST-T (B-coast) > anything else. The 9B batches B2/B3/B4 and Ultra KTX2 stay **on hold** (the user). The SDXL detail step runs only through `work/tools/comfyui/start_comfyui.sh`, never beside another heavy GPU job. Blender (Cycles CPU, headless keying) needs no lock. |
| D38 | Downloads and uploads | **None.** Blender 5.2 is installed; the static tree variants come from our converter; the grass and life are procedural; the ocean ports Tidewater's code (MIT) with no assets; the clips are hand-keyed [confirmed: each spec's needs list]. No Blender MCP add-on (headless scripts; `--watch` is plain Blender). |
| D39 | What players download | the re-converted coast regions (+ ≈ 1.6 MB brotli, COAST §8.11B), the static tree variant glbs (the skinned ones are then not fetched on Medium+ [likely net ≤ 0]), the B-coast sets, the movement packs (≈ 52 KB male + ≈ 38 KB female with brotli [projected / confirmed]). The grass palettes are a few numbers per tile in the manifest. |
| D40 | Stale clients after a re-convert | The deploy restarts the server with a "reload the page" note (COAST Q13); a character saved on the old S1 strip is re-placed by `entryPoint` → `nav.place` (COAST F15). |
| D41 | New 3D models | **None** this wave (the new trees are deferred). The coast adds terrain sculpts, not models; the grass and animals are procedural geometry. |
| D42 | Production asset caching (SCREENS Q5: ~1,250 revalidation round trips per stage entry) | Unchanged this wave; a DEPLOY item (versioned asset URLs) in the backlog. The stage's prefetch uses `cache: 'force-cache'` (SCREENS fc-B). |

### 2.5 Numbers and config (consolidated)

| What | Value | Source |
|---|---|---|
| Region batch keys | (LOD group, opaque \| cut-out, cloth sheen, lamp group, leaf \| wood): 2–6 meshes per region for buildings, 2–9 with trees | BATCHING §3.1, F16 |
| Material table | RGBA16F, 6 texels per slot (texel 5 = NL lamp emissive) | BATCHING §3.2, F9 |
| Atlases | 1024² pages, rectangular pow2 buddy cells, content dedupe, gutter `max(2, s/64)`, textures ≤ 64 texels kept at 2× | BATCHING F6, F15 |
| Lightmaps | one 256²-layer array, 128²/64² in quadrants, 184 layers for all 577; every array ≤ 256 layers | BATCHING F7 |
| Group material | 4 object samplers, no 2D map, no new varying | BATCHING F8 |
| Draw ranges | group 2: 202 m × rangeScale; group 3: 48 m × rangeScale by vertex collapse; rangeScale live (0.6 / 1 / 1.4 / 1.4 × Options sight; create 0.6) | BATCHING §3.8, F11 |
| Grass | Medium 45 blades/m², tiers 14 / 32 / 58 m; High 74/m², 20 / 46 / 82 m; Grass: Low = full density, distances × 0.6; 8 m patches; 256 m window re-centred every 32 m; 55 % camera facing | GRASS_LIFE §3.3, X3 |
| Wildlife | per GRASS_LIFE §5.1's table; flush at 9 m (first bird ≤ 0.25 s, all ≤ 0.6 s); butterflies 2.2× life size | GRASS_LIFE §5, X11 |
| Sea level, seed | +5.0 m; seed 1188 | COAST §0.1 |
| Beaches | kinds wide / bay / mountain / strait / mouth / walk; widths 48–90 m; flank grades 24.2 / 26.6 / 31.0°; ≤ 6 m relief; tomb crest kept to the crest line + 24 m | COAST §3B.2–§3B.4 |
| Flank paint | grass ≤ 38°, blend 38–45°, rock > 45° | COAST G7 |
| `holeBelowM` | −100 m | COAST G5, Q24 |
| Ocean | Low 3 Gerstner; Medium worker FFT 2 × 64² at 20 Hz; High GPU FFT 4 × 128²; Ultra 4 × 256²; CDLOD cut at full fog (D27) | COAST §8.10 |
| Jump | `JUMP_COOLDOWN_MS` 1000, slack 150, late drop 600, echo window 600, seek cap 200; rate limit 2/s burst 3 | MOVEMENT §5 |
| Jump clips | JUMP 1.10 s (433 ms in the air, apex 1.31 m); JUMP_RUN per RUN leg cycle (male weapon, female, male fist) | MOVEMENT §0, §3.3 |
| Stage | spot (101.0, −3.26, −56.0); select fov 50°, fit distance 3.94 m at 16:9; create orbit 180°, 3.6 m, face zoom 1.6 m; stream 150 m (7 regions), 12 fetches; sunset hold t = 0.773 | SCREENS §0B.2–§0B.4 |

---

## 3. Protocol and migration (protocol v1, additive; landed by W10-P)

### 3.1 `packages/shared/src/movement.ts` (new, pure; W10-P writes it complete)

```ts
export const JUMP_COOLDOWN_MS = 1000
export const JUMP_LATE_DROP_MS = 600
export const JUMP_ECHO_WINDOW_MS = 600
export const JUMP_MAX_SEEK_MS = 200
export const JUMP_COOLDOWN_SLACK_MS = 150
```

### 3.2 `protocol.ts` additions

```ts
// ClientMessage (a GameplayRequest: exactly one actionResult)
| { t: 'jump' }
// ServerMessage
| { t: 'jump'; id: number; at: number }          // server ms; viewers (the jumper too) play JUMP / JUMP_RUN
// GameplayRequest / GAMEPLAY_REQUESTS: + 'jump'
// CLIENT_RATE_LIMITS: jump { perSecond: 2, burst: 3 }

export interface ServerInfo {
  // … existing fields (id, name, status, online, capacity, world?)
  clock?: ClockState        // SCREENS §9: the lobby's world clock, for the stage's time
  weather?: WeatherSync     // SCREENS §9: the lobby's weather
}
```

- **Collision check** [confirmed: grep of `packages/shared/src/protocol.ts` at `a649715`]: no `jump` in either union;
  `ServerInfo` has no `clock` or `weather` (its fields are `id`, `name`, `status`, `online`, `capacity`, `world?`).
  The other items add no message: batching, grass, life and the coast are client- or data-only [confirmed: their
  specs].
- **Validators** (`validate.ts`): the client `jump` has no fields; the server `jump` needs an integer `id` and a finite
  `at`; `serverInfo()` parses `clock` and `weather` with `optionalField` + `clockState` / `weatherSync`, so a bad clock
  drops only the clock (SCREENS SCR-P).
- **Fail reasons** reuse existing values (`dead`, `cant_act`, `busy`, `cooldown`, `mounted`, `stalling`); no
  `trading` (the jump is allowed in a trade, `TRADE_ALLOWED` += `'jump'`, MOVEMENT fact-check 2). No new line in the
  fail-string table, so `hud.test.ts`' "a line for every refusal reason" is unaffected [likely].
- **Server gate lists** (MV-P): `MOUNTED_REFUSED` += `'jump'`; `TRADE_ALLOWED` += `'jump'`; **not** in
  `FUSE_CANCELLERS` (D31).
- **Older clients** drop an unknown server `jump` frame with a `console.warn` (`net/wire.ts`) [confirmed: MOVEMENT §5];
  older servers omit `clock`/`weather`, and the stage falls back to its local sunset hold.
- **Mock:** `apps/game/src/net/mock.ts` + `net/mock/*` answer `jump` (W10-P), so MV-C runs before MV-P lands.
- **docs/PROTOCOL.md** gets a "Jump" subsection in §11 and the two `ServerInfo` fields.

### 3.3 GM, config, migration

- **GM:** no new command (`/speed` does not change the jump clip; `tp beach-south` comes from `manifest.places`, not
  a new command) [confirmed: COAST C18, MOVEMENT §4.2].
- **Server config:** none new.
- **Database: no migration** [confirmed: no lane adds a table or a column; the jump cooldown lives in the in-memory
  `p.cooldowns` map under `move.jump`].
- **Deploy order:** server and client together (the client's `jump` would be refused as an unknown request by an
  older server; a new client against an older server simply never sees a jump).

---

## 4. Seams (step 0; four agents; every edit is additive, and the Low guard stays green)

### 4.1 W10-S: `packages/world-render` (one agent; commits in this order)

1. **Batching (BATCHING BT-0, the first commit):** `WorldObjects.setBatcher(b)` (a batcher claims a region's static
   placements before `placeStatic`; `meshes()` includes the batch; `removeRegion` tells it); `region-chunk.ts`
   (`'objects'` waits for the batch's ready); `stream.ts` (`StreamHooks.batcher`, the worker handle); `model-cache.ts`
   (`CachedModel.geometry`: typed arrays per primitive, **dequantized** with the node transform baked in: all 445
   glbs use meshopt + `KHR_mesh_quantization` [confirmed: BATCHING F13]); `materials.ts` (the batch record,
   `batchClass`, the shared `lampRule`, `mapsChanged`); `render/shadows.ts` (`addCasterSource`, the proxy input);
   `night-lights.ts` (lamp rows → table slots through a callback); `weather/index.ts` (shelter candidates from
   `World.meshes()`); the region-listener contract (`placed` with `meshes = []` for merged pieces, the new `batched`
   event); `setRangeScale` forwarded; `World.batch`, `LoadWorldOptions.batching` (default on for PBR), the render-path
   release/claim; `batch/types.ts`. **Off = HEAD** (chunks, clones and draws identical).
2. **Grass and life (GRASS_LIFE GL-0):** `scatter.ts` (`ScatterStyle 'retail' | 'field'`, `GroundCover`,
   `adopt(material)`); `World.life` (`LifePart` with `configure({ groundFlocks })`, `setThreats(fn)`,
   `addSpecies`/`addHabitat` stubs, `setEnabled`); `LoadWorldOptions.grassStyle`, `wildlife`, `hideRetailTufts`;
   `QUALITY_PRESETS.low` keeps `'retail'`; `grass/types.ts` (with `RETAIL_TUFT_MODELS`), `life/types.ts`; the claim's
   tuft filter (D3); the `'scatter'`/`'life'` tags and the batcher's refusal of them.
3. **Coast (COAST I-CST hooks, moved forward):** `COAST_CHUNKS` and `GRASS_TINT` in `WORLD_SHADER_CHUNKS` (D11) with
   empty `coast/chunks.ts` and `grass/chunks.ts`; the `sroCoastWet` extern and the `SRO_GRASS_TINT` call in
   `pbr/terrain-plugin.ts` (off); `World.ocean` part slot, `World.coast`, `World.waterLevelAt` (D2, D22);
   `WaterRenderer.ensurePbrState()` public + a Classic frames getter (D12); `RENDER_PRESETS.ocean` rows (COAST §8.10).
4. **Guards:** `test/material-budgets.test.ts` (D13); `THIRD_PARTY_NOTICES.md` + `tidewater-notices.test.ts` (D14).

**W10-S tests:** `batch-seams.test.ts` (BATCHING's list: off = HEAD; a claimed region places no chunks;
`removeRegion` reaches the batcher; `'objects'` after the batch; Classic never batches; no listener gets a batch mesh
through `placed`; NL's lamp slots get the kind colour at night; `setRangeScale(0.6)` reaches the batch; PBR → Classic →
PBR leaves no batch meshes, slots or cells); `grass-seams.test.ts` (style `'retail'` = HEAD; `adopt` binds shared
uniforms, later sets, defines and depth textures; Low never creates the field; Low and `hideRetailTufts: false` place
every tuft model); a claim test (a `'scatter'` or `'life'` tagged mesh is never claimed; the tuft filter applies before
the batcher sees the region); the chunk snapshot (all chunks empty = HEAD's strings, both languages);
`material-budgets.test.ts`; `tidewater-notices.test.ts`; `seams-classic.test.ts` unchanged (the Low guard), plus the
release's `release-lowguard.test.ts` and `abuse-w9f-lowguard.test.ts` (both committed [confirmed: `ls apps/game/test`]).

### 4.2 W10-G: `apps/game` (one agent)

- `settings.ts` (after re-reading `a649715`): `graphics.advanced.batching: 'on' | 'off'` (default on, ignored and
  not shown on Low); the `graphics.scatter` row relabelled "Grass" (values unchanged; "low" on Medium+ = the new grass
  at full density with distances × 0.6); `graphics.wildlife: 'on' | 'off'`; the Mac default Grass: Low
  (`isAppleGpu`) until the M1 check; normalisation for old saves.
- `hud/options.ts`: the rows (Advanced → "World batching", Graphics → "Grass", "Wildlife"), through
  `registerOptionRow` where it fits; strings in `i18n/en-render.ts`.
- `graphics.ts`: `world.setBatching(on)` (release + `stream.rebuild()`), `world.life?.setEnabled(wildlife)`, the grass
  style from the preset.
- `app.ts`: `stage: StageHost` (lazy), `stage/types.ts` (`StageDef`, `StageHost`, `Stage`; camera kind `'fixed'`), a
  stub `stage/host.ts` that throws "not built" (SCREENS SCR-S).
- Movement seams: empty `playMove` / `movementClip` in `three/models.ts`, the `KEEP_CLIPS` entry, an optional resume
  phase on the base restart; the `jump` branch in `world/entities.ts` behind `hasMovementClips`; the `jump` intent in
  `world/intents.ts`; the feature registered in `world/features.ts`; `i18n/en-movement.ts` (empty) and its line in
  `i18n/en.ts`.
- `screens/world.ts`: one `world.life?.setThreats(() => knownActors)` call.

**W10-G tests:** `seams-stage.test.ts` (SCREENS); `settings.test.ts` additions (defaults per preset and per Mac; old
saves keep their level; Low shows no batching row); a movement seam test (no pack → nothing plays, nothing throws);
the whole `apps/game` suite green.

### 4.3 W10-P: `packages/shared` + mocks (one agent)

§3 in full: `movement.ts`, the `protocol.ts` unions and `ServerInfo` fields, `validate.ts`, `index.ts` exports,
`CLIENT_RATE_LIMITS`, the mock's `jump` answer, PROTOCOL.md. **Tests:** `packages/shared/test/movement.test.ts`
(constants consistent: `JUMP_MAX_SEEK_MS` < `JUMP_LATE_DROP_MS`; validators accept good and reject NaN `at` or a
non-integer `id`); `packages/shared/test/server-info.test.ts` (a bad clock drops only the clock).

### 4.4 W10-CV: the converter (CST-C's first commit)

D19 in full: the hook call sites in `convert-world.ts` in the order coast → static variants → grass palettes; the
manifest types and validators; `blenderExe` + `packages/convert/src/blender.ts`; the CLI verbs `coast-export`,
`coast-import`, `moves` on stub modules. **Tests:** a manifest round trip with every new optional field absent (old
exports still validate); `blender.ts` refuses a relative path; the pipeline order (a fixture where C9 drops a uid: the
static-variant and palette steps never see it).

---

## 5. Presets and budgets

### 5.1 What the wave adds per preset

| Preset | Batching | Grass and life | Coast | Jump | Stage |
|---|---|---|---|---|---|
| Low (Classic) | none (the Low guard) | retail scatter and tufts | Classic ocean (3 Gerstner), the new coast terrain (content) | clips (no LOD) | Classic stage |
| Medium (default) | region batches, static trees, lamp group, 1024² atlases | new grass 45/m², life on | worker FFT 2 × 64², shore v1 | clips | stage at the player's preset, create cap 0.6 until re-benched |
| High | as Medium, cut-out casters per region | new grass 74/m², life on | GPU FFT 4 × 128² (WebGPU; worker FFT on WebGL2) | clips | as Medium |
| Ultra | as High (RGBA8 atlas, Q4) | as High, far tier × 1.1 | GPU FFT 4 × 256² | clips | the player's preset |

### 5.2 Budgets and honest costs (WAVE_PLAN3 §5.2 format; 1080p)

Dev PC = Ryzen 5 9600X + RX 9060 XT, Chrome. "Mid" = RTX 3060 / RX 6600 class and a CPU ≈ 1.5× slower; "laptop /
M1" = a gaming laptop or a base Apple M1 (CPU × 1.4–2; M1 GPU at Retina 0.75). Baselines are the wave-9 final gate's
**frame p95** (`work/tmp/w9-finish/budgets.md`) [confirmed]. Projections use BATCHING §5's ratio method (projected =
X + (today − X) × r, r from the lab's today → batched frame p95, X = 1.5–2.5 ms the batcher does not touch, plus the
mobs' measured cost in the crowd), then add the other items: life ≤ 0.1 ms CPU (GRASS_LIFE §7.2), the coast's
+0.45 / +0.6 ms at a sea view (COAST §8.11B), the jump +0.2 (5 friends) to +0.8 ms (20 bots) in the crowd (MOVEMENT
§7) [projected; `work/tmp/w10r-plan/budget.py`]. The lab ratio for the gate (6.2 / 17.6) is used where the lab has no
scene (fields, beach): it is the least favourable measured ratio.

**Frame p95 on the dev PC, wave 9 (measured) → wave 10 (projected), WebGPU / WebGL2, ms:**

| Preset | Plaza noon | Gate storm | Fields night | Crowd (20 mobs; + 20 jumping bots) | Beach (new; baseline = gate storm + coast) | Pass line |
|---|---|---|---|---|---|---|
| Low | 3.8 / 3.0 → unchanged | 3.7 / 2.4 → unchanged | 2.8 / 2.1 → unchanged | 4.2 / 4.2 → + jump ≤ 0.8 | 3.7 / 2.4 → ≈ 3.9 / 2.6 (COAST §8.11B) | pass |
| **Medium (default)** | 11.4 / 12.0 → **≈ 3–4 / ≈ 3** | 8.1 / 7.2 → ≈ 4–5 / ≈ 4 | 5.9 / 4.0 → ≈ 3–4 / ≈ 3 | 14.4 / 11.3 → **≈ 6–7 / ≈ 4–6**; ≤ 8 / ≤ 6.5 with bots | ≈ 4.5–5 / ≈ 4–5 | **G1 < 16.7: pass with ≥ 8 ms spare** |
| **High** | **17.9 / 16.7 → ≈ 6–9 / ≈ 6** | 15.9 / 14.1 → ≈ 7–8 / ≈ 6–7 | 10.7 / 6.1 → ≈ 5–6 / ≈ 4 (+ grass GPU ≤ 0.7, not the critical path) | **21.5 / 16.0 → ≈ 10–12 / ≈ 6–8**; ≤ 12.8 / ≤ 9 with bots | ≈ 7.5–8 / ≈ 7–7.5 | **G2: ≤ 12 plaza, ≤ 14 crowd** |
| Ultra | 19.8 / – → ≈ 9–11 | 16.0 / – → ≈ 7–9 | 11.0 / – → ≈ 6–7 | 22.9 / – → ≈ 12–14 | ≈ 8–10 | not a default; G3 |

| Preset | World draws at the plaza (main + shadow; post excluded) | GPU dev (plaza) | Mid desktop (CPU ×1.5) | Laptop / M1 | VRAM | Download |
|---|---|---|---|---|---|---|
| Low | 180 (unchanged) | unchanged | unchanged | unchanged | + coast 3.6 MB | coast regions only |
| Medium | 331 → **≈ 60–65** (prototype 81 with the retail grass; − 20 retail grass, + ≤ 6 grass/life) | 1.6 → ≈ 1.1 ms (+ grass ≤ 0.2) | plaza ≈ 5–6, crowd ≈ 9–11: holds 60 fps | CPU plaza ≈ 5–8, crowd ≈ 9–14; M1 GPU ≈ 9.5–12.6 ms + grass (Grass: Low ≈ 0.4–0.6) + the ocean at the beach ≈ 1.0–1.3 → **≈ 11–15 ms at the beach: at the line** [projected, COAST §8.11] | object albedo ≈ −50 % (rectangular cells + dedupe), lightmaps ≤ 60 MiB, coast + 11 MB, grass ≈ 1.5 MB | + coast ≈ 1.6 MB br, packs ≈ 90 KB |
| High | 559 → **≈ 80–85** (prototype 153) | 3.3 → ≈ 2.4 ms (+ grass ≤ 0.7 at ground level in the fields) | plaza ≈ 9–13, **crowd ≈ 15–18: borderline** | **crowd ≈ 20–24: misses** (characters) | as Medium + coast 17 MB, grass ≈ 2.5 MB | as Medium |
| Ultra | ≈ 600 → ≈ 90 | as High + SSR | not offered | not offered | as High | as High |

What the tables mean, honestly:

- **Medium, the default, holds 60 fps everywhere** on the dev PC with more than 8 ms to spare, and on a mid desktop.
  The weakest projected friend machine is a **base M1 at the beach on Medium, ≈ 11–15 ms of GPU**: inside 16.7 ms but
  not by much; the Mac levers are Grass: Low (the Mac default), COAST's cuts 7–8 (lace off, CDLOD G 16 → 8) and the
  render scale [projected].
- **High passes on the dev PC** in every bench scene, which is what the user asked of batching. On a mid desktop the
  High crowd is borderline and on a gaming laptop it misses: the cost left is the characters (≈ 0.18 ms per mob on
  the dev PC, ≈ 8 draws each), which this wave does not batch. That is BACKLOG item 9's follow-up (animation LOD,
  skinning, character batching) (§9).
- **The projections rest on one lab**, which ran ≈ 1.5× slower per draw than the game on Medium (BATCHING F17); that
  is why the ratio method is used and why G2's line is 12 / 14 ms rather than the lab's 5 ms.
- **Bloom is now off by default** (`a649715`), so every baseline above is slightly pessimistic [likely]; LAB-10R
  re-measures the wave-9 baseline at `a649715` before the first merge.
- **The coast costs nothing where there is no sea in view** (the plaza, the town, the fields, the stage: ≤ 0.02 ms,
  D27) [projected].

**The character stage (SCREENS §0B.9, measured on the dev PC, CPU p50 / p95, better of 2 runs) [confirmed]:**

| Preset | Select WebGL2 / WebGPU | Create at range 0.6, WebGPU | Create at the preset's range, WebGPU | After this wave [projected] |
|---|---|---|---|---|
| Low | 1.1 / 1.5 (WebGL2) | – | – | unchanged |
| Medium | 3.1 / 4.0 ; 3.7 / 4.6 | 3.8 / 5.0 (174 draws) | 6.9 / 7.9 (320 draws) | batching lowers both; life + ≤ 0.1 ms; the ocean cut at full fog (D27) |
| High | 4.4 / 5.3 ; 5.6 / 6.7 | 5.1 / 6.5 (286 draws) | 11.0 / 13.7 (521 draws) | uncapped create ≤ 8 ms p95 expected, then the cap goes (D26) |

### 5.3 Per-lane budgets (dev PC, 1080p; the minimum of 5 runs; the GPU lock for every in-browser frame measurement; NullEngine benches need no lock but a quiet machine)

| Lane | Budget |
|---|---|
| BT-M | worker ≤ 15 ms per region; main-thread mesh creation + upload ≤ 2 ms per region in jobs ≤ the stream frame budget (4 ms Medium, 5 ms High); no frame > 16.7 ms while walking between regions |
| BT-A | a cell upload job ≤ 0.5 ms; the table update ≤ 0.05 ms; atlas VRAM ≤ the object textures it replaces (target ≈ −50 %); every array ≤ 256 layers |
| BT-P | ≤ +0.1 ms GPU at the plaza; no new varying; ≤ 4 object samplers per group material, ≤ 16 on WebGL2 with every define on |
| BT-S | shadow draws at the plaza on High ≤ 35; CSM CPU ≤ 0.5 ms |
| BT-T | tree draws ≤ 2 per region in range; wind ≤ +0.05 ms GPU |
| Batch steady state | per-frame CPU ≤ 0.1 ms; `loadWorld` + batches ≤ +0.5 s on the 7-region stage, ≤ +1 s at the plaza (29 regions), warm |
| GL-F | cull + upload ≤ 0.1 ms p95; window re-centre ≤ 0.5 ms; a region bake in ≤ 1 ms slices (≤ 25 ms total), the commit step itself ≤ 0.2 ms; ≤ 3 draws; no `EnabledMeshCandidates` rebuild from the grass while walking |
| GL-S | grass GPU ≤ +0.7 ms vs the retail scatter on High at ground level, ≤ +0.2 ms on Medium; varyings ≤ the retail grass's |
| GL-T | ≤ 0.1 ms GPU; no new terrain sampler (unit count unchanged) |
| GL-L | all wildlife ≤ 0.1 ms CPU p95, ≤ 0.1 ms GPU, ≤ 3 draws |
| Grass + life together | ≤ 0.2 ms CPU per frame (BATCHING §3.6) |
| CST-C terrain | worst case +11 (Medium) / +17 (High) resident regions at (156.0, 90.0): +5 / +7.7 MB VRAM, ≈ +0.23 / +0.31 ms CPU; never above the interior peak |
| CST-O | Medium ≤ 0.2 ms GPU mid, ≤ 1.3 ms on an M1 at Retina 0.75, CPU ≤ 0.1 ms, worker ≤ 1.2 ms median per tick, ≤ 2 draws; High ≤ 0.4 ms GPU mid, CPU ≤ 0.15 ms incl. 2 dispatches; ≤ 0.02 ms CPU with no sea within the fog distance |
| CST-A | ships ≤ 3 draws, ≤ 0.05 ms CPU (gulls are GL-L's budget) |
| Coast total at the beach | Medium ≤ +0.45 ms CPU p95 and ≤ +16 draws; High ≤ +0.6 ms and ≤ +22 draws over the baseline |
| MV-C | 0 ms CPU delta at rest and 0 new draws; ≤ +0.8 ms CPU p95 with 20 bots jumping every 1.3 s (first gate: the NullEngine bench on the real clips on a quiet machine; the arm layer's p95 reached 1.5–1.7 ms under load); clip load ≤ 30 ms once per skeleton |
| MV-P | ≤ 0.05 ms server CPU per jump |
| MV-A | each clip ≤ 60 KB raw; round-trip control ≤ 0.1° / 1e-5 m; planted contacts ≤ 1 mm, slide ≤ 10 mm per frame; each JUMP_RUN within 1 cm of its base RUN at `enterPhaseS` / `exitPhaseS` |
| SCR-R | select (4 dressed characters) and create (1), at 15:00 and at the sunset hold: CPU p95 ≤ 5.5 ms Medium, ≤ 8 ms High; + ≤ 0.5 ms in half rain; `loadWorld` ≤ 4.5 s warm on localhost, the stage visible ≤ 6 s warm; re-based after batching and the life land |
| SCR-SEL / SCR-CRE | swapping a character or outfit ≤ 1 frame > 33 ms; the orbit: no frame > 33 ms, including the first, on both APIs |

**LAB-10R method** (one bench list, one results file `work/tmp/w10-lab/budgets.md`): the wave-9 final gate's method
(production bundle on a private `vite preview`, the GPU lock, 400 uncapped frames after streaming idles, hardware
scaling 1, `prof.js` installed **once** per page with the segments asserted to add up to the CPU mean, BATCHING F1,
and every run logging WebGPU `uncapturederror`). Scenes: plaza noon, gate storm, fields night, crowd (20 mobs, then
+ 20 jumping bots), fields noon at ground level (grass), beach noon and beach storm night (`tp beach-south`), the Tiger
corner (156.0, 90.0), stage select and create at 15:00 and at the sunset hold. Presets: Medium on both backends first,
then High and Ultra on WebGPU and High on WebGL2. `?gpuLimits=default` once per preset (256 layers, 16 varyings).

### 5.4 The gates (the 60 fps rule)

- **G1:** Medium holds p95 < 16.7 ms on both backends at every bench scene with every feature on. (Projected worst:
  ≈ 8 ms, the WebGPU crowd with jumping bots.)
- **G2:** High on WebGPU p95 ≤ 12 ms at the plaza and ≤ 14 ms in the crowd; WebGL2 Medium and High ≤ 8 ms at the
  plaza (BATCHING §5 "Whole"). This is the user's "High should now reach 60 fps".
- **G3:** no scene on any preset is slower than its wave-9 baseline (the user's "keep features if no worse").
- **G4:** component gates: the Low guard; `material-budgets.test.ts` (≤ 16 WebGL2 units, ≤ 15 + `front_facing`
  varyings, ≤ 256 layers); zero WebGPU validation errors; no GLSL on the WebGPU engine; world draws at the plaza
  ≤ 100 on High and ≤ 70 on Medium; grass ≤ 3 + life ≤ 3 draws in any view; the jump adds 0 draws.

A feature that breaks G1 on a preset ships **off** on that preset or is cut (§7). A G2 miss does not block the
release (High stays optional), but it is reported to the user with the numbers.

---

## 6. Steps and lanes

### 6.0 Step order and concurrency

```
step 0 (parallel, disjoint packages):
   W10-S (world-render: batching → grass/life → coast → guards) | W10-G (game) | W10-P (shared) | W10-CV (converter)
   + data work that needs no code: MV-A keying in Blender (headless) | CST-C porting coast_beach.py in its own files
step 1 (after the seam each needs):
   batching: BT-A | BT-M | BT-P | BT-C (after W10-CV)
   coast:    CST-C phase 1 (E, S, NE, S1 + its openTiles link) | CST-B (after CST-C's schema) | CST-M(conv) |
             CST-O (spike first; first commit = the shore seam) | CST-T (GPU queue)
   grass:    GL-S → GL-F | GL-L | GL-T | GL-C (after W10-CV)
   jump:     MV-P | MV-C (on the mock and the polish pack until MV-A lands) | MV-A (code after W10-CV)
   stage:    SCR-P | SCR-R (after W10-G)
   ── checkpoint X1: convert + optimize-out (coast phase 1, static variants, grass palettes) ──
step 2:
   BT-S | BT-T (after BT-C data + BT-M + BT-P) | BT-L | BT-K (optional)
   CST-S (after CST-O's seam) | CST-A | CST-M(client) | CST-C phase 2 → ── checkpoint X2 ──
   GL-O | GL-A (optional)
   SCR-SEL | SCR-CRE (after SCR-R)
   MV-L (optional)
step 3: I-10R (merge in the §6.2 order) → LAB-10R (§5.3) → H-10R (§6.5) → fixes → the user's look check (§8)
```

### 6.1 The lanes

| Lane | Owns (files) | Seams it uses | Tests | User check |
|---|---|---|---|---|
| **BT-C** | `packages/convert/src/world/static-variants.ts` (frame 0 of the default clip, skin removed, `models[i].staticVariant`) | W10-CV's hook | `static-variant.test.ts` (posed positions = skinned at frame 0; no JOINTS/WEIGHTS; bounds inside; one variant per skinned foliage model: 18 trees + flowers) | the grove review sheet |
| **BT-A** | `batch/{atlas, table, lightmaps}.ts`, the cell job in `pbr/decode-worker.ts` / `decode-core.ts`, sub-rect uploads in `textures.ts` | batch records, `mapsChanged` | `batch-atlas.test.ts`, `batch-textures.test.ts` (BATCHING §6.2 list) | — |
| **BT-M** | `batch/{merge-core, merge-worker, region-batch, index}.ts` | the claim, geometry export | `merge-core.test.ts`, `region-batch.test.ts` | the plaza looks the same (A/B) |
| **BT-P** | `pbr/surface-plugin.ts` (`SRO_TABLE`), `pbr/foliage-plugin.ts` (`SRO_FOL_PIVOT`, minimum breeze) | BT-A textures | surface/foliage additions; the budget guard registrations | wet and night looks unchanged |
| **BT-S** | `render/shadows.ts` (worker proxies, the terrain skin, the per-region cut-out caster with a standalone depth `ShaderMaterial`) | caster source | shadow tests; 0 `uncapturederror` in the lab | tree and fence shadows keep their holes |
| **BT-T** | `batch/trees.ts` (tree groups, leaf/wood keys, pivots, the per-model instancing fallback) | BT-C, BT-M, BT-P | `batch-trees.test.ts` | trees sway in wind and gently when calm |
| **BT-L** | `apps/viewer/src/world/batch-panel.ts` (A/B, counters) and the bench scenes | BT-M stats; W10-G's option | a toggle rebuilds without leftovers | Options → Advanced → World batching |
| **BT-K** (optional) | `batch/classic-plugin.ts` | BT-A, BT-M | the Low guard with batching on | Low looks the same |
| **CST-C** | `packages/convert/src/world/coast/**`, `convert-world.ts`, `manifest.ts`, `content/coast/coast.json`, `coast-*.test.ts` | W10-CV (its own first commit) | COAST §12.1 + §12.13 (slope census on the merged result with the hotspot allowance; no crease and no bench along the bounds line and the tomb keep line; sand within 12 m of every sea shore; paint share ≥ 80 % grass below 38°; S1 reaches home with the ring closed; tomb keep bit-identical; river mouths kept; census in `manifest.report.coast`; **S-DRAW: a dropped uid appears in no batch, no static-variant list and no perch**) | fly the coast in the viewer: sand in front of every shore, the Tiger mountains come down green, the tomb crest unchanged from the plaza |
| **CST-B** | `packages/convert/src/tools/coast-blender.ts`, `packages/convert/tools/blender/{*.py, passes/*.py}`, `coast-authored.test.ts` | `blender.ts` | COAST §12.2 + §12.13 (a pass never writes under the mask or within 30 m outside the line, never moves the area border, is deterministic, reads back with 0 errors) | watch one pass (`--watch`) or sculpt a cove |
| **CST-M** | `coast/minimap.ts`, the `worldmap.ts` fill, the two `minimap.ts` fills | `manifest.coast` | COAST §12.3 | press M: sand all round |
| **CST-O** | `packages/world-render/src/ocean/**`, `test/ocean-*.test.ts`, appends to `THIRD_PARTY_NOTICES.md` | `World.ocean`, `coast.seaAt`, `ensurePbrState`, `RENDER_PRESETS.ocean` | COAST §12.4 (+ the D27 far cut: no node beyond the full-fog distance; the worker idles with no node) | Medium first: swell and chop, storm build-up, no horizon line, no bay-mouth seam |
| **CST-S** | `shore/**`, `coast/chunks.ts`, `test/shore-*.test.ts` | the shore seam, `COAST_CHUNKS`, `sroCoastWet` | COAST §12.5 (units ≤ 16, no varying) | S1 and the Tiger beach at noon |
| **CST-A** | `apps/game/src/audio/coast.ts`, the `COAST` area, `apps/game/src/world/fx/{ships, critters}.ts`, the gull registration | CST-O's wave query, `life.addSpecies` | area hysteresis, ≤ 4 emitters, ships over > 8 m water; the gull species over > 8 m water | surf louder near the sea; gulls over the beach; a ship in the haze |
| **CST-T** | the B-coast batch config and review sheet (data) | the tile list | the texpipe's index validation | sand does not tile from the camera |
| **GL-S** | `grass/shaders.ts`, `life/shaders.ts` | the chunk points | GRASS_LIFE GL-S list (key lists equal the retail grass's; varyings; the height twin; `isReady` for every define set; the pixel-width floor) | no glslang fetched; no crawling blades |
| **GL-F** | `grass/{field, window, bake, patch, cull, index}.ts` | `scatter.ts` style, `adopt`; the commit step after `'objects'` (enqueue only) | GRASS_LIFE GL-F list (hidden with `isVisible` at count 0, never `setEnabled`) | Grass Retail / New A/B; no gaps; soft road edges |
| **GL-T** | `grass/chunks.ts` (per-tile uniform table, no sampler) | W10-S's chunk entry and terrain call | define off = today's strings; unit count unchanged | the carpet's far edge hidden |
| **GL-C** | `packages/convert/src/world/grass.ts` (tile weights and palettes); `perches.ts` only if the run-time bounds perches fail | W10-CV's hook | `grass-palette.test.ts` | — |
| **GL-L** | `life/{life, butterflies, flock, birds, fireflies, spawn, index}.ts` | the life slot, `addSpecies`/`addHabitat`, `configure`, `setThreats`, `SkyState.night`, the weather frame | GRASS_LIFE GL-L list (gating with the audio's hysteresis; flush first bird ≤ 0.25 s, all ≤ 0.6 s; butterfly anchors from placed flowers; `groundFlocks: false`; one mesh and one draw per kind) | butterflies over flowers; a flock flushes when walked into; fireflies at night; nothing in rain |
| **GL-O** | `settings.ts`, `hud/options.ts`, `i18n/en-render.ts` (after W10-G: defaults only); `audio/ambient.ts` (the flush one-shot); `apps/viewer/src/world/grass-panel.ts` | W10-G's rows | `settings.test.ts` (defaults, Mac Grass: Low); `audio.test.ts` (one one-shot per flush, muted in rain) | Options → Grass / Wildlife |
| **GL-A** (optional) | `packages/convert/src/grass/make-atlas.py` → `content/grass/petals.png` | — | stable output hash | the petal sheet |
| **MV-A** | `packages/convert/tools/blender/moves/{key_moves, extract_deltas, run_contacts}.py`, `packages/convert/src/tools/export-moves.ts`, `content/moves/europeman_skel/{jump, jump_run, jump_run_fist}.json`, `content/moves/europewoman_skel/{jump, jump_run}.json`, `moves.test.ts`; edits `optimize/run.ts`, docs/ASSETS.md §5.3 | `blender.ts`, the `moves` verb | MOVEMENT §8.2 moves list (control ≤ 0.1°; contacts ≤ 1 mm; every RUN clip maps to a JUMP_RUN; `air` ≥ −0.02 m) | the GIFs: both skeletons, sword and spear, the weapon RUN |
| **MV-P** | `apps/server/src/movement.ts`; edits `gameplay.ts` (register), `mounts.ts`, `social/trade.ts` (not `alchemy.ts`, D31) | W10-P types | `apps/server/test/movement.test.ts` (MOVEMENT §8.2 server list, with the fuse row changed by D31: a jump never cancels a fuse) | a friend sees the jump; the toasts on the horse and at your stall |
| **MV-C** | `world/features/movement.ts`, `i18n/en-movement.ts`; edits `three/models.ts`, `world/entities.ts`, `world/intents.ts`, `hud/keyhelp.ts`, `audio/entity.ts` or `audio/cues.ts` | W10-G hooks; `World.waterLevelAt` | `apps/game/test/movement.test.ts` (MOVEMENT §8.2 client list, without `jumpLift`, D21) | Space standing, running, in combat; no glide; one jump per second when tapping |
| **SCR-P** | `apps/server/src/game.ts` `serverInfo()`; `apps/server/test/servers-clock.test.ts` | W10-P fields | as SCREENS | — |
| **SCR-R** | `apps/game/src/stage/{host, stages, slots, key-light, stage-time, prefetch}.ts` + tests | W10-G's `app.stage`; `life.configure`; `hideRetailTufts: false`; the ocean visibility switch | SCREENS §0B.10 test table | — |
| **SCR-SEL** | `screens/charselect.ts`; one line in `screens/login.ts` | the host | via stage tests | select on the south-gate steps |
| **SCR-CRE** | `screens/charcreate.ts`; `.create-backimage` in `style.css` | the host | via stage tests | create orbits to the dragon plaza |

### 6.2 Merge order and checkpoints (I-10R)

1. Step 0: W10-S (its four commits in order), W10-G, W10-P, W10-CV. Suite + typecheck; record the test count.
2. Batching: BT-A → BT-M → BT-P → BT-C (data) → BT-S → BT-T → BT-L (→ BT-K). After each: the Low guard + typecheck.
3. Grass and life: GL-S → GL-F → GL-T → GL-C (data) → GL-L → GL-O (→ GL-A).
4. Coast: CST-C phase 1 → CST-M(conv) → CST-B → **X1** → CST-O → CST-S → CST-A → CST-M(client) → CST-C phase 2 → **X2**.
5. Jump: MV-P → MV-A → MV-C (→ MV-L).
6. Stage: SCR-P → SCR-R → SCR-SEL → SCR-CRE (benched after 2–4 are in, so its numbers include them).

The five chains touch disjoint files after step 0, so they can merge interleaved; the order inside each chain is
fixed. Batching goes first among them because the grass's and the stage's budgets are re-based on it.

### 6.3 Tests and gates (every lane)

- Every lane: its tests, `pnpm typecheck`, the whole suite at hand-off.
- The Low guard (`seams-classic.test.ts`, `release-lowguard.test.ts`, `abuse-w9f-lowguard.test.ts`) after **every**
  merge.
- `material-budgets.test.ts` after every merge that adds a material, define or array.
- Every plugin ships WGSL and GLSL with the same injection-point keys.
- **Cross-item tests I-10R adds:**
  - S-DRAW: a C9-dropped uid appears in no region batch, no static-variant use and no perch (converter + a NullEngine
    world);
  - the retail-tuft filter runs before the claim, and never on Low or the stage;
  - no `scatter`/`life`/ocean mesh is ever claimed or merged;
  - `World.waterLevelAt`: +5 m over the sea mask, the block plane in the moat, `null` on dry ground (COAST S-MOVE);
  - the stage world with batching, life (`groundFlocks: false`) and the ocean cut: the create cap re-applied after a
    graphics change reaches the batch;
  - a live Low ↔ Medium switch with all five items on leaves no batch, grass field, life pool or ocean leftovers.

### 6.4 I-10R: integration checklist (one agent, the lead)

1. Merge per §6.2; suite, typecheck and the Low guard after each merge.
2. X1 and X2 re-converts when no other lane writes `work/out/world/`; `optimize-out --only world/jangan-fields/`.
3. Server: `WORLD_EXPORT=jangan-fields`: 307 regions in `nav.bin`; the nest counts unchanged (about 700 placed, 91
   unreachable, COAST F8); `tp beach-south`; **walk from town to S1 without GM** through the `openTiles` link; a
   character saved on the old S1 strip logs in on the sand.
4. Two browser clients (WebGPU and `?engine=webgl`): Space on one, the jump on both; a trade stays open through a
   jump; a mounted jump refused with the toast.
5. LAB-10R runs §5.3's bench; any G1 miss goes to §7 before release; the G2 result goes to the user.
6. Screens: select and create at 15:00 and at the sunset hold; the first orbit after a fresh load has no hitch; Low.
7. Before/after shots at the bench spots, day, night and rain, for the user's look check (§8).
8. Docs: PROTOCOL.md §11 (jump, `ServerInfo`), ASSETS.md §5.3 (movement pack; `coast/`), RENDER.md (batching,
   grass), DEPLOY.md (`THIRD_PARTY_NOTICES.md` in the client build; the re-convert note), BACKLOG (items done; the
   deferred list of §11), PLAYTEST.md (the user checks), each spec's statuses.
9. Scratch: delete `work/tmp/batching/lab/` after BT-L ports the bench, `work/tmp/grass-life/lab/` after GL-F/GL-L,
   `work/tmp/coast-beach/rt/` after CST-B; keep the shots the user reviewed.

### 6.5 H-10R: the adversarial hunt (read-only; findings become tests, then I-10R fixes)

The five specs' own lenses stand and are run as written: BATCHING H-BT 1–21, COAST H-CST (§12.9 + §12.13), GRASS_LIFE
H-GL 1–17, MOVEMENT §8.2 hunt lenses, SCREENS H-SCR (§12.7 lenses 1–7 and the leak loop). Deduplicated, they share
these cross-item lenses, which H-10R runs once with all five items on:

1. **Black WebGPU frame** at any preset with a batch, the grass, the life and the sea in one view, also with
   `?gpuLimits=default` (16 varyings, 256 layers) (BT 4/5/19, GL 5, CST frame drops).
2. **WebGL2 texture units** with night + rain + clouds + the coast wet band + the grass tint + a batch group (BT 6,
   GL-T, CST-S).
3. **Low changed** by any of the five (BT 3, GL 6, the stage's Classic path).
4. **Double draw:** a region as chunks and a batch; retail grass under the new; a C9-dropped placement still drawn
   (BT 1, GL 1, CST S-DRAW).
5. **Hitches:** a region commit that lands a batch, a grass bake and a coast region in one frame; the grass window
   re-centre; the first create orbit (BT 13, GL 4/16, SCR).
6. **Leaks** on region unload and on world → select → create → world ×3 (BT 2, SCR leak loop, the ocean and the life
   pools).
7. **The live range scale** (Options sight, the create cap) reaching the batch; `EnabledMeshCandidates` churn from the
   grass, the ocean or the life (BT 18, GL 17, CST F2).
8. **Rain and shelter** through merged roofs; wildlife out in the rain (BT 14, GL 9).
9. **Movement exploits:** jump spam at the rate limit from 5 clients; a jump at a wall, the coast bounds line and the
   gate stairs moves nothing; the cooldown slack under Tailscale jitter.
10. **Placements on moved ground:** floating or buried props on the regraded ring; grass on sand or on paving (CST, GL 2).
11. **The ambient shift** with the batch on (the +2/255 pavement offset, BATCHING F14/Q13).

---

## 7. Scope-cut order (cut from the top; one list for the wave)

Each item names its spec's cut. Items marked **ask first** are the user's own picks and are cut only after telling the
user.

1. BT-K, the Classic batch (Low stays as it is).
2. MOVEMENT cut 1: the mirrored JUMP_RUN_L (not in v1 anyway).
3. COAST beaches cut 1–2: scripted Blender passes beyond the Tiger and tomb hotspots; the boulder scatter.
4. GRASS_LIFE cuts 1–3: fly-overs; roof perchers and perch points; the petal atlas.
5. SCREENS cuts 1–4: the select ↔ create orbit (a dip to black); the stage ambience; the login prefetch; the idle drift.
6. COAST old cuts 2–5: ships and shore critters (the gulls stay, as a GL species); Ultra's ocean extras; spray and
   lingering whitecaps; shadows received on the sea.
7. BATCHING cut 2: the terrain skin in the shadow proxies (+7 shadow draws at the plaza on High).
8. GRASS_LIFE cuts 4–7: reeds, cattails and ferns; other actors pushing the grass; the flush sound; Ultra's longer far
   tier.
9. MOVEMENT cuts 2–4: the masked weapon-arm layer; the male fist JUMP_RUN (then the female's own pass); the take-off
   and landing sounds.
10. COAST old cut 6: the GPU FFT (High and Ultra use the worker tile).
11. BATCHING cuts 3–5: the lightmap quadrant packing; the lamp group; the group-3 vertex collapse.
12. COAST beaches cuts 3–5 and old cuts 7–12: beach kinds collapsed to two; `--watch`; the Mac levers (lace on Medium,
    CDLOD G 8); the animated swash and shore swell; positional surf emitters; the Classic Gerstner waves; paint inside
    the bounds; the row z 86.
13. SCREENS cuts 5–6: the server clock and weather (a fixed sunset); the face key light.
14. BATCHING cuts 6–8: trees merged per region → per-model instancing (+36 draws); the cut-out caster depth shader;
    the NRAO atlas (+10 to +30 draws in town).
15. MOVEMENT cuts 5–6: client prediction; JUMP_RUN as a whole (Space ignored while moving).
16. **Ask first:** GRASS_LIFE cuts 8–10: dragonflies; the terrain tint; fireflies (the user named dragonflies and
    fireflies).
17. COAST old cuts 13–14: the north-east coast; the PBR ocean on Medium → the Classic ocean.
18. **Ask first:** COAST phase 2 (the west, north-west and Option A's corridor); the Blender pass on the Tiger flank
    and the tomb face; any return of a cliff; the walkable beach → look-only (which also drops S1's link).

**Never cut:**

- **Everywhere:** the Low guard; no new varying beyond the rules of D13; ≤ 16 WebGL2 units; ≤ 256 layers; no GLSL on
  the WebGPU engine; G1 (Medium at 60 fps).
- **Batching:** the static tree variants; buildings merged per region on the table material; the worker build; the
  A/B option; rectangular cells with content dedupe; ≤ 4 object samplers; the listener contract with NL's per-slot
  lamp emissive.
- **Coast:** a beach in front of every sea shore; no sea cliff; the flank shoulder with no crease at the bounds line;
  the tomb crest keep; the river-mouth keep; the frozen playable area; determinism and seams; the sea mask; the
  Blender export and readback with validation; S1's in-bounds link while S1 stays walkable; the MIT notice.
- **Grass and life:** the splat coverage with soft road edges; full blade density on every level that draws the new
  grass; ≤ 3 grass draws and no grass casters; the chunk-graph contract; butterflies and flushing ground flocks; the
  Grass and Wildlife rows; the retail-tuft decision.
- **Jump:** server authority (no position or move change); the lock rules; validators and rate limit; the cooldown;
  the re-expression step and its control test; the per-frame contact solve; no per-frame cost and zero new draws.
- **Stage:** select and create on real Jangan through the wave-9 renderer at the player's preset; the fallback to
  today's screens; the retail layouts and live English text; the leak tests; the 150 m stage load.

---

## 8. What the user must provide or approve

**To start: nothing.** Every tool is installed, nothing is downloaded or uploaded, no new 3D model is made, and every
item below has a default so nobody waits.

1. **The preview sheet** `work/tmp/w10r-preview.png` (one image from each part). **Default:** build as shown.
2. **Batching** (BATCHING §9): region batches plus static trees with shader wind (trees sway with the weather wind and
   a gentle minimum breeze instead of the retail loop); small look differences accepted if the lab shows any; an
   Advanced "World batching: on / off" (on for Medium+, not on Low); Low unchanged. **Default: yes to all.** Also: "well
   under 100" means the world's draws; characters (≈ 8 draws each) are not batched this wave.
3. **The coast** (COAST §15): look at `work/tmp/coast-beach/before-after.png` and `preview.png`. **Default:** built as
   shown, shipped on a "looks okay" at the Medium look check (the south beach, the Tiger beach, the tomb, noon, dusk,
   night, storm).
4. **How the Blender work is done:** Claude's scripts with before/after renders (default), watching a pass in a
   Blender window (`--watch`, no download), or sculpting some stretches yourself. **Default:** scripts for all six
   hotspots; the first `--watch` session is offered when the Tiger pass runs.
5. **How players reach the south beach** (COAST Q22): today it is only reachable through ground outside the playable
   area. **Default:** the shortest safe in-bounds path the converter finds (along the east shelf), walked once by you at
   the look check.
6. **The grass look** (`work/tmp/grass-life/overview.png`) and the placed retail tufts: hide the 695 low tufts where
   the new grass draws, keep the tall weeds, reeds, barley, flowers and water plants, keep everything on Low and on
   the character screens. **Default: yes**; judged in the viewer's A/B. Butterflies at 2.2× life size; birds:
   sparrows, magpies/crows, swallows, egrets, and gulls at the coast. **Default: as listed.**
7. **The jump look** (`work/tmp/movement/polish/out/jump.gif`, `jump_run.gif`, `jump_before_after.png`). **Default:
   go**, with a Blender touch-up first: the take-off arms (still straight forward for ~0.1 s), the forearm, the fists,
   the apex gaze, the running jump's arms and split. Note: `jump_run.gif` shows the unarmed run; the armed running
   jump is keyed next. Space = jump everywhere, 1 s cooldown (your choice).
8. **The character screens** (`work/tmp/stage/overview.jpg`): select before the south-gate steps (there is no palace
   model; this is the view you picked), create turned round to the dragon plaza; the server's time held at sunset at
   night; `maintheme_cut` with the town ambience under it. **Default: as shown.** Metals look darker at the sunset
   hold than on today's screens (the sky-cube look pass is deferred with the sky upgrade).
9. **After the bench:** if High passes G2 on WebGPU, should gaming desktops start on High? **Default: no change this
   wave** (Medium everywhere; the release note mentions High).
10. **A jump no longer cancels an alchemy fuse** (D31, like an emote). **Default: yes.**
11. **A friend's Mac** (one run of the fields and the beach bench on Medium with the perf overlay) and a gaming laptop
    (the crowd on High). **Default:** Macs start on Grass: Low; ship on the dev PC's numbers; the Mac levers of §7
    cover a slow Mac.

---

## 9. Risks

| Risk | Default handling |
|---|---|
| The game gains less than the lab (characters dominate the crowd; the lab ran ≈ 1.5× slower per draw) | ratio projections, G2 at 12 / 14 ms; High in a crowd on laptops is reported honestly; characters are BACKLOG item 9's next step |
| A black WebGPU frame from an invalid pipeline while the counters look normal (BATCHING §4.5) | every lab run logs `uncapturederror`; H-10R lens 1 |
| Atlas seams, mip bleed, a late TX-R set in the wrong cell | gutters; per-cell LOD clamp if needed; BT-A tests; H-BT 7–8 |
| Merge risk concentrated in W10-S (one agent rewrites the claim, the scatter facade, `world.ts` and the chunk list) | off = HEAD tests for each part; the chunk snapshot; no other lane in those files |
| Base M1 at the beach on Medium ≈ 11–15 ms GPU (at the line) | Grass: Low default on Macs; COAST Mac levers; a friend's Mac bench |
| S1 unreachable if the `openTiles` search finds no clean route | Q22's alternatives (the S2 channel bed, a cut through the south wall) with the user |
| A crease or bench along the bounds line or the tomb keep line (COAST G11/G12) | the shoulder rule change and a smooth maximum; the crease and bench tests on the final surface; H-CST |
| Thin blades shimmer while walking (FXAA on Medium, TAA off while moving on High, 0.75 scale on Macs) | the pixel-width floor; H-GL 14; the user walks the field |
| A region commit carrying a batch merge, a grass bake and a coast region hitches | the worker merge; grass bake in its own ≤ 1 ms slices; jobs ≤ the stream budget; H-10R lens 5 |
| Ambient shift with the batch on (+1.7–2.6/255 at the plaza, cause unknown) | BT-L's A/B with the IBL refresh frozen and SSAO off; accepted if it is the probe |
| Dark metals at the sunset hold on the stage | the key light's specular; the sky-cube look pass comes with the deferred sky upgrade |
| JUMP_RUN leg swap on armed characters | JUMP_RUN per RUN leg cycle (male weapon first), the `runJumps` test, the user check |
| Production revalidation on stage entry (~1,250 round trips) | `force-cache` prefetch; asset versioning in the backlog |

## 10. Open questions (each has a default, so nobody waits)

| # | Question | Default | Who settles it |
|---|---|---|---|
| Q1 | Culling per region (192 m) or 96 m cells (BATCHING Q1) | region; revisit only if mid-card GPU budgets miss | LAB-10R |
| Q2 | Low shows the baked static trees? (BATCHING Q2) | no: Low unchanged | the user |
| Q3 | Minimum breeze (BATCHING Q3) | `max(wind, 0.15)`, tuned at the grove | BT-T |
| Q4 | Ultra's atlas format (BATCHING Q4) | RGBA8 1024² in v1; KTX2 atlases later | — |
| Q5 | Group materials per region or per key (BATCHING Q12) | per key (≈ 10 in the world) | BT-L measures |
| Q6 | The ocean's far cut at full fog (D27) holds on the horizon strip? | yes; fallback: today's far plane | CST-O spike |
| Q7 | Flank grades and beach widths (COAST Q18) | as COAST §3B.2, tuned in the viewer | CST-C |
| Q8 | Walkable beaches all round (COAST Q15) | no this wave (≈ a week + a server change later) | the user after the playtest |
| Q9 | Grass: Low replaces the old "low" scatter level on Medium+ (GRASS_LIFE Q2) | yes | GL-O |
| Q10 | Object-floor mask at run time or in the converter (GRASS_LIFE Q3) | run time; the converter if a region's slices exceed 25 ms | GL-F |
| Q11 | Other actors push the grass (GRASS_LIFE Q5) | local player only | — |
| Q12 | Camera-facing share (GRASS_LIFE Q6) | 55 %; 35 % if the user sees "turning" grass | the user |
| Q13 | JUMP_RUN entry phase (MOVEMENT Q2) | seek into the first 0.15 s of the right stance of the actor's own cycle within the 200 ms budget | MV-C |
| Q14 | Female spear and bow running jumps (MOVEMENT Q14) | reuse her one JUMP_RUN with the blends | the user check |
| Q15 | Stage stream 150 m or 200 m (SCREENS Q4) | 150 m unless create's horizon shows a hole | SCR-R |
| Q16 | Create heading ±10° (SCREENS Q3) | due north, tuned on renders with the bars | SCR-R |
| Q17 | Ultra on the stage (SCREENS Q11) | the player's preset | SCR-R reports |
| Q18 | Shared seeds so friends see the same birds (GRASS_LIFE Q11) | no (cosmetic) | — |
| Q19 | Snapshot rendering (BATCHING Q7) | backlog experiment | — |

---

## 11. WAVE_PLAN4 and WAVE_PLAN5: what is superseded, deferred or carried over

**docs/WAVE_PLAN4.md** (wave 10 "sky and sea" + trees) is superseded for this wave:

- **Deferred** (the user: sky upgrade and new trees): every SKY2 lane (S2-C, S2-V, S2-H, S2-I, S2-E, S2-A) and every
  TREES lane (TR-A, TR-F, TR-I, TR-W, TR-B); W10-S's sky and tree seams (`sky.dispatchGpu`, `sroHaze`/`bindHaze`, the
  foliage `SRO_FOL_VDATA` skeleton, `setTreeMode`, `TREE_PRESETS`, the post-stage `gtao`/`meter` edits, `cascadeInfo()`);
  D3–D7, D17, D18, D20, D24–D26, D29 and the SKY2/TREES rows of §2.5 and §5; GAME-10's sky and tree rows; LAB-10's
  SKY2 A/Bs and the forest spot; D34's HTTPS item (**done**).
- **Carried over into this plan:** the coast lanes (with COAST's beaches revision), W10-S's coast hooks (WAVE_PLAN4
  D11 → §4.1 step 3), `THIRD_PARTY_NOTICES.md` (D14), the material-budget guard (D16 → D13), the re-convert
  checkpoints (D31 → D36), the GPU queue (D32 → D37), stale clients (D36 → D40), the far sea cut (D19 → D27, against
  wave 9's fog instead of SKY2's haze), the "no GLSL on WebGPU" and one-varying rules. TR-A's `blenderExe` and Blender
  helper move to W10-CV (D19).

**docs/WAVE_PLAN5.md** (wave 11 "gameplay and screens") is superseded for this wave:

- **Deferred:** the dodge roll (`roll`, `MoveState.style`, the `evading()` and `onMoveTo` seams, its clips); the
  intro (SCR-I), the login drift (SCR-L), stage A / Constantinople (SCR-X), the stage editor (SCR-E); pets, friends and
  mail (PS-X, PET-S, PET-C, FR-S, ML-S, CM-C), **migration v10**, `Store.immediate`, the 12 new fail reasons, the four
  GM commands and the two CLI verbs; W11-FS; the release points R1/R2; H11-E.
- **Carried over:** the jump (MV-A, MV-P, MV-C, MV-L) and stage B (SCR-P, SCR-R, SCR-SEL, SCR-CRE) as revised by their
  specs; the three-foundation-agent pattern (W11-P / W11-FC → W10-P / W10-G); the "no new 3D models" rule; the
  i18n-in-`en.ts` correction.

BACKLOG gets the deferred items back in its queue at I-10R: the sky upgrade (SKY2), the new tree models (TREES), the
intro and login, the dodge roll, pets/friends/mail, the remaining 9B texture batches (on hold), character draw cost
(item 9's follow-up), WebGPU snapshot rendering, production asset versioning.

## 12. Housekeeping

- The five specs stay the detailed design; this plan's decisions override them where they differ (D3, D11, D15, D19,
  D21, D27, D31 in particular). I-10R marks the overridden passages in the specs.
- No lane commits; the lead integrates each step.
- Scratch used by this plan: `work/tmp/w10r-plan/budget.py` (the §5.2 projections), `work/tmp/w10r-plan/make_preview.py`
  (the preview sheet), `work/tmp/w10r-preview.png`.
