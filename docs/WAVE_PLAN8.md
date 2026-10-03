# Wave plan 8: wave 12, "a world editor, every tile upscaled, every tree replaced"

This plan merges three fact-checked specs into one build order for wave 12:

- **docs/WORLD_EDITOR.md** (item 1): a GM-only map editor in the browser on this PC. Terrain brushes, texture paint,
  grass and flower painting, placing / moving / turning / scaling / deleting objects from the game's library with ground
  snap, water, lights, sound zones, town routes and seats; edits layered over the exported map, full undo and revert,
  walking rebuilt automatically, a local preview, then Publish through checks and a separate Deploy.
- **docs/TERRAIN_TEX.md** (item 2): the 88 terrain tiles without a remaster go through the existing `@sro/texpipe`
  pipeline (B3a / B3b / B3c), under a "painterly ground rule" with three review gates; Medium gets the detail layer and
  anti-tiling; the set range admits hero tiles only.
- **docs/TREES.md, Part W** (item 3): 4,886 foliage placements of 110 retail models become 35 new species built by our
  own Blender script, drawn inside wave 10's region batch (LOD1 + LOD2 merged, a per-placement band byte, a near LOD0
  overlay); every retail foliage sprite upscaled first (B0).

The user's words, verbatim:

> I want world editor as wave 12

(after asking to "improve some map stuff my self"), and:

> Just make sure also the textures for dirt, grass, sand, etc all terrain textures are upscaled. And i would love if all
> tree's in the game and terrains use the newer tree's instead of the retail low poly and low texture tree's and plants.

> we can use meshy if needed for speed up process

Fishing, swimming and underwater moved to **wave 13** (the user), not this wave (§11).

**The user delegated every decision.** Wherever there is a choice, this plan takes the option it would mark
"(Recommended)" and writes it as a decision with a one-line reason (§2). Only what truly needs the user is left in §8 and
§10, each with the default used meanwhile. **Delegation is not a deploy OK:** wave 12 deploys only after a new OK from
the user (§2.4 D36).

This plan does what WAVE_PLAN7 did for wave 11:

- it settles every place where the three specs (and the wave-11 build still in the tree) would give a file or a piece
  of state two owners (§2);
- it fixes the format additions (manifest, content files, settings; no wire message, no migration) in one list (§3);
- it lands **the seams first** (§4), on disjoint files, before any lane;
- it schedules the GPU batches (terrain textures, tree sprites, SDXL, the in-game review shots, the benches) on **one
  GPU queue** so they never collide (§6.1);
- it holds the sum of the three items against the measured wave-10 polish gate and the wave-11 projections (§5), and
  adds a **Mac margin** gate (G6) taken from the editor spec;
- it orders the lanes, the re-converts, the integration, the bench, a hunt with lenses, the fixers, a final gate and an
  independent verify (§6), and gives one scope-cut order with a never-cut list (§7), what the user approves (§8),
  risks (§9), open questions (§10) and the deferred list (§11).

When this plan and a spec disagree, **this plan wins**. The specs stay the detailed design of each lane; a lane reads its
spec sections and this plan's row for it.

**Tags** (as in WAVE_PLAN7):

- **[confirmed]**: checked in the code or data of the working tree on 2026-10-01, measured by a spec's prototype and
  re-derived by its fact-check, or measured at the wave-10 polish gate. Each one says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived), not measured on that setup.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this plan makes. The user may overrule it.

**Repo state when this was written [confirmed: `git log`, `git status`, file times, 2026-10-01 ≈ 16:10].**

- HEAD `19770ea` ("Wave 11 step 0: seams ..."). **The wave-11 lanes are building in the working tree, uncommitted**:
  `apps/game/src/{hud/unique-notice, ui/notice, world/ride-mob, world/features, world/features/town}.ts`, the new
  `audio/town.ts`, `apps/server/src/{gm, mob-skills, uniques}.ts`, `packages/convert/src/{cli, town/*, world/town/*,
  tools/export-sound}.ts`, `packages/shared/src/town.ts`, `packages/world-render/src/{grass/cull, town/*}.ts`,
  `material-budgets.test.ts`, new `content/town/`, `content/uniques.json`.
- The three specs are in `docs/` (WORLD_EDITOR.md and TERRAIN_TEX.md untracked, TREES.md modified). This plan edits
  none of them.
- **Meshy balance: 1,840 credits** [confirmed: re-read at 20:09 UTC through the repo's `MeshyClient` with
  `work/tmp/trees/w12/meshy/balance.ts`; the key stayed inside the client]. The design spent **40** of its 60 credits
  (TREES' J1 30 + J2 10, both logged in `work/night/NIGHT_LOG.md` 15:05–15:22); this plan spent **0**.
- **The deploy authorised in chat covers waves 10 + polish + 11 only** ("Once everything is done with wave 11, deploy.",
  NIGHT_LOG 13:40, which also notes "Wave 12 still needs a new OK") [confirmed].
- Scratch the lanes port from: `work/tmp/world-editor/` (the prototype page `editor.ts`, `vite.config.mjs`,
  `publish-dryrun.ts`, `check-rule.ts`, `check-manifest.ts`, `region_census.py`, `sharp16.mts`, the shots and the saved
  layer in `out/`), `work/tmp/terrain-tex/` (`coverage.ts`, `windows*.ts`, `grain_check.py`, `spots.ts`, `run.ts`,
  `locked.sh`, `tools/`, ≈ 1.1 GB of prototype sets: kept for TT-B), `work/tmp/trees/w12/` (`make_species.py`,
  `render_sheet.py`, `upscale.py`, `inventory12.py`, `project12.py`, `lab/`, `factcheck/`, `meshy/`). This plan's
  arithmetic is `work/tmp/w12-plan/budget.py`; its preview sheet is `work/tmp/w12-preview.png` (also in Dropbox
  `wave12/w12-preview.png`), made by `work/tmp/w12-plan/make_preview.py`.

---

## 0. Summary

1. **Three items, one seam step.** Five foundation agents run first, in parallel, on disjoint files, from the **wave-11
   final commit** (D1): **W12-P** (`packages/shared/src/world-edits/**` and S-NAV in `packages/nav`), **W12-SA** (the
   world-render object side: `World.trees` and the region filter in `world.ts`, the swap source, S-SCALE at every compose
   site, S-OBJ's per-region re-batch, the foliage define skeletons), **W12-SB** (the world-render ground side: S-TERR,
   S-GRASS, S-NL, the water block update), **W12-CV** (the converter: the "world edits" pass slot and hooks, the convert
   lock, the uid registry, `WorldPlacement.scale`, `WorldModel.treeSwap`, the `world-edit` and `trees` verbs, the root
   scripts `editor` and `trees`), **W12-G** (`graphics.trees`, the sound-zone feature stub, `/editmap`). Data work that
   needs no shared file starts at once: T12-A's Blender tool and the prototype species, TT-B's SDXL check on three
   prototype tiles (GPU queue slot Q0).
2. **One owner per shared module** (§2.1, §2.2). The three items meet in seven places, all settled in step 0 or by a
   decision: `world.ts` (D2), the batch files (D3), `stream.ts` (D4), `terrain.ts` (D5), the manifest types (D6),
   `content/texpipe/overrides.json` and `work/out/pbr/index.json` (D7), and the editor's two libraries (the tile palette
   and the tree library, D16–D19).
3. **Formats (§3):** no wire message, no migration, no server config key. Additive manifest fields
   (`WorldPlacement.scale?`, `WorldModel.treeSwap?`, per-region grass-mask and light-point lists), new content trees
   (`content/world-edits/jangan-fields/`, `content/trees/`), new texpipe override rows, one setting (`graphics.trees`).
4. **GPU queue (§6.1):** one lock, one queue, priorities fixed: bench timings > short upscale batches > in-game review
   shots > SDXL (overnight) > anything else. Terrain TP-U (≈ 10 min), the tree sprites B0 (≈ 3 min), DT-2 SDXL on 10
   tiles (≈ 45 min, ≤ 2.5 h) and the per-batch review shots (≈ 20 min each) never overlap and never overlap a bench.
5. **Budgets (§5), against the measured wave-10 polish gate and WAVE_PLAN7's wave-11 projections:**
   - **G1, Medium < 16.7 ms p95 everywhere, with the new trees and textures**: every plain scene stays far under the
     line (Medium WebGPU plaza 3.9 → ≈ 5.4–6.9 ms with wave 11 and 12; fields at night 6.3 → ≈ 6.6–7.0) [projected].
     The thin scene is wave 11's **plaza with 20 players plus the crowd and the town**: 13.4 (wave 10) → ≈ 13.7–16.2
     (wave 11) → **≈ 14.0–16.6 ms** with wave 12; only the corner that stacks WAVE_PLAN7's undivided upper bound reaches
     17.2 [projected]. LAB-12 decides against G-11's measured number; the crowded-plaza tree rule and cuts 17–18 are
     the fallback.
   - **G2 (High) keeps its lines**: plaza ≤ 12 → ≈ 7.6–8.6 ms, crowd ≤ 14 → ≈ 9.6–10.8 ms, WebGL2 plaza ≤ 8 → ≈ 4.5–5.4
     [projected]. High WebGPU with 20 players already misses 60 fps (17.1–19.3 ms in wave 10; BACKLOG item 9): reported,
     not gated, as in wave 11.
   - **VRAM:** Medium +38–53 MB; **High WebGPU +291–356 MB** (+235 MB of it is the terrain set planes, every High
     WebGPU player); High WebGL2 +105–170 MB [projected]. **Download:** Medium ≈ +3 MB on first entry to town, ≈ +8 MB
     for the whole area; High ≈ +20 MB / +25 MB; Low +0. **Deploy:** ≈ +171 MB on the server [projected].
   - **The editor costs a player nothing** with no edits (G7: an empty edit layer exports byte-identical files);
     with edits, the per-region guardrails and the Publish bench hold G1, G2 and G6.
6. **Order (§6):** step 0 seams → step 1 the lanes of the three items in parallel (the GPU queue runs TP-U, B0 and the
   SDXL night) → checkpoint **X1** (B1 trees, the B3a/B3b sets, an empty edits pass) → step 2 the dependent lanes
   (T12-B batches B2–B4, T12-E, WE-L, WE-T, T12-L, TT-R) → checkpoint **X2** (the full re-convert and optimize) →
   **I-12** integration → **LAB-12** bench → **H-12** hunt with 16 lenses → **F-12** fixers → **G-12** final gate →
   **V-12** independent verify → the user's checks → **deploy only on a new OK**.
7. **Never cut** (§7): **the editor's terrain brush** (Raise / Lower / Smooth / Flatten), **texture paint**, **object
   placement with undo** (place / move / turn / delete with snap; undo / redo / revert one change), **a safe Publish with
   the walking rebuild** (stops on traps or lost reachability) and Deploy only on the user's click; **every terrain tile
   upscaled** (B3a, B3b and B3c); **every tree family replaced** (B0–B4, plants included); plus the Low guard, G1 and
   the look gates.
8. **What the user must do (§8):** nothing blocks the start; no download; Meshy is planned at 0 credits for the build
   (contingencies ≤ 210 of a 600 cap). The user looks at the preview sheet, then after the build spends ten minutes in
   the editor, looks at one terrain sheet and the tree batch pages, and gives the deploy OK.

### 0.1 Where each user request lands

| User request (verbatim fragment) | Where | Lanes |
|---|---|---|
| "I want world editor as wave 12" / "improve some map stuff my self" | WORLD_EDITOR §2, §5: `apps/viewer/editor.html` + the local editor API, `pnpm editor`, a desktop shortcut | WE-A, WE-U |
| editor: "terrain brushes (raise, lower, smooth, flatten; paint grass, sand, dirt, rock, road)" | WORLD_EDITOR §4.1–§4.3; the palette is the 108 remastered tiles (TERRAIN_TEX D12) | WE-U, WE-D, W12-SB, TT-B |
| editor: "placing/moving/rotating/scaling/deleting trees, rocks, buildings, lanterns and stalls ... with ground snap" | WORLD_EDITOR §4.5–§4.6; new trees placed as their carrier (TREES §W3.9) | WE-U, WE-L, W12-SA, T12-E |
| editor: "water levels, lights, sound zones, town walking routes and seats" | WORLD_EDITOR §4.8–§4.11 | WE-D, WE-R, WE-T |
| editor: "full undo, one-click revert per change, walkable areas rebuilt automatically, preview ..., then publish ... and a deploy" | WORLD_EDITOR §3.4, §6 | WE-A, WE-N, WE-I |
| "all terrain textures are upscaled" ("dirt, grass, sand, etc") | TERRAIN_TEX: all 88 remaining tiles (B3a 22, B3b 21, B3c 45) + the retune of 3–4 failing B1 sets | TT-B, TT-R, TT-Q |
| "all tree's in the game ... use the newer tree's instead of the retail low poly and low texture tree's and plants" | TREES Part W: 35 species for 110 retail models (4,886 placements), B0 upscales every foliage sprite (the "low texture" half), plants included | T12-A, T12-B, T12-M, T12-N, T12-W |
| "we can use meshy if needed for speed up process" | §0.3: measured, Meshy does not speed up card foliage; the build plans 0 credits with bounded contingencies | T12-B (contingency only) |
| standing goal "at least 60 fps" | §5: G1 with the trees and textures, G2, the Mac margin G6, the editor's guardrails and Publish bench | LAB-12, G-12, WE-N |

### 0.2 What the specs' fact-checks changed, and this plan takes as given [confirmed: each spec's §F / §15 / §WF]

| From | Change | Where it lands here |
|---|---|---|
| WORLD_EDITOR F1 | Height delta `L = 32768 + round(dh × 256)` (exact zero), strokes snapped to 1/256 m | W12-P's codec |
| WORLD_EDITOR F3, F17 | A move is C9's drop + add of the same key; the incremental convert re-runs the passes on the cached **pre-pass** list | W12-CV, WE-I |
| WORLD_EDITOR F4, F5 | Dressing props edited by row id, never by uid; a move out of its region takes a fresh editor uid (0xE000–0xEFFF) | W12-CV's S-UID, WE-T |
| WORLD_EDITOR F6 | No placement carries a scale today: new seam S-SCALE at every compose site | W12-SA, W12-CV |
| WORLD_EDITOR F8 | Retail lightmaps hold **baked object shadows**: object edits re-bake them (no ghost shadows); never cut | WE-D |
| WORLD_EDITOR F9, F10 | The client streams `nav-objects.bin` + chunks; the nav is built before the placement passes; new seam S-NAV | WE-I, W12-P |
| WORLD_EDITOR F11–F16 | Port 5185 strict; tokenless `/editmap`; staging `jangan-fields-edit`; per-file swap with backup; convert lock; assets-only Deploy refused with uncommitted or undeployed converter code | WE-A, W12-CV |
| WORLD_EDITOR F21 | Friends with dedicated GPUs start on **High**, Macs on Medium; a base M1 GPU ≈ 9–11× the dev GPU: the **Mac margin** | §5.5 G6 (wave-wide) |
| WORLD_EDITOR F23, F24 | Grass masks ship (per-region files); ≈ 0.14 MB per published region | §5.2 download |
| TERRAIN_TEX F1, F2 | **No plane growth**: +235 MB is every High WebGPU player's cost; hero-only windows over 48 are 2 / 12 at the load radius but 29 at the unload radius | §5.2, TT-R |
| TERRAIN_TEX F3, F5, F6 | Importance acts only at placement (the last 8 range layers reserved); the paving opt-out is a no-anti-tile bit (64) in the layer-map alpha; anti-tiling's second tap reads `sroTilesHi` on High | TT-R, TT-Q |
| TERRAIN_TEX F4, F7, F8 | 63 hero tiles incl. three B-coast sets; the retune covers c_dust_hmfld_03, oaho_dust_earth06, c_stone_hmfld_01 (and c_dust_fld_01 if the pinned gate fails it); **SDXL only on the 10 paving / rock / moss tiles** | TT-B |
| TERRAIN_TEX F11, F14 | Pin one grain metric in `review.ts`; the Medium detail + anti-tiling cost is [likely] within noise, LAB-12 measures both backends | TT-B, LAB-12 |
| TREES WF1 | The new crowns are **25–48 % darker** than retail in game (maple, willow), more saturated; the cause is lighting; the A/Bs split it before any gain; the ±10 % gate blocks every family | T12-L lab first, T12-B, G5 |
| TREES WF2, WF3 | Sprites follow `graphics.textures`: retail-size in the glb on Medium, the 2× tier on High+; colour match on mean **and** spread | T12-A |
| TREES WF5, WF6 | Merged geometry ≈ +28–40 MB (`sroTreeW` as `unorm8x4`); every merged LOD1 + LOD2 vertex is shaded every frame | §5.2 |
| TREES WF8–WF12 | Five code seams: the cloth counter, the wind-gated pivot, `TEXCOORD_1` read as a lightmap UV, `treeSwap` in the manifest, `treeSwap` = a tree claim | W12-SA, W12-CV, T12-M, T12-W |
| TREES WF13 + WORLD_EDITOR §9.3 note 9 | **TREES' lab CPU numbers (15:24–15:30) may be skewed** by the editor's page in the same pane; draws, triangles, memory stand | LAB-12 re-runs the tree CPU rows; no decision rests on the old ones |
| TREES WF15 | The merge worker emits the cut-out caster's arrays (≈ 3.6 MB main-thread copy otherwise in region 24999) | T12-M |

### 0.3 Meshy: what "if needed for speed" means here [confirmed: TREES §W2.1, NIGHT_LOG 15:05–15:22, balance re-read]

- **The bake-off answered it.** Image-to-3D (30 credits) made an opaque, faceted blob with no cut-out leaves, no wind
  data and a 4.3 MB texture; retexturing our pine (10 credits) merged the leaf material into one **opaque** material and
  dropped the wind channels. The bpy route makes a species in 6–21 s of Blender with LODs, wind data and the retail
  painted sprites; the slow part of a species is art direction, which Meshy does not remove.
- **Terrain stays local** (Meshy cannot make seamless tiles; the user's rule). **The editor makes no assets.**
- **Build budget [decision, D30]: cap 600 credits, planned 0**, keeping ≥ 1,240 of today's 1,840 (the ≥ 200 reserve
  rule holds with room). Two bounded contingencies, each only on a stated trigger: (a) ≤ 90 credits for the bare dead
  trunks (`deadwood_a/b`, `dh_brush`) **only if the user rejects** the bpy dead trees on their review page (TREES
  §W2.4); (b) ≤ 120 credits (4 image-to-3D jobs) for the B4 Dunhuang stumps and brushwood **only if** T12-B's B4 is
  the last open item at the I-12 freeze (a time trigger, the user's "speed" case). Worst case 210. Every job is a row in
  `work/night/NIGHT_LOG.md` (what, credits, result), through the repo's `MeshyClient` only; the key is never printed.

---

## 1. Lane ids

| Id | Step | From spec | What |
|---|---|---|---|
| **W12-P** | 0 | WORLD_EDITOR WE-P + S-NAV | `packages/shared/src/world-edits/**` (types, layer codecs, apply functions, the nav rule, validators); S-NAV in `packages/nav` |
| **W12-SA** | 0 | TREES T12-0 + WORLD_EDITOR S-FILTER, S-SCALE, S-OBJ | The world-render object side: `world.ts`, `batch/types.ts`, the S-SCALE compose sites, `objects.ts`, `stream.ts`'s `reloadObjects`, the foliage define skeletons, `trees/types.ts` |
| **W12-SB** | 0 | WORLD_EDITOR S-TERR, S-GRASS, S-NL, water | The world-render ground side: the terrain renderer's `updateRegion`, `grass/bake.ts` masks + `GrassField.invalidate`, `night-lights.ts` points, `water.ts` block update |
| **W12-CV** | 0 | WORLD_EDITOR WE-CV + TREES T12-A's manifest step (WF11) | `passes.ts` slot, `convert-world.ts` hooks, `manifest.ts` (`scale`, `treeSwap`), `cli.ts` verbs, S-UID, the convert lock, root scripts |
| **W12-G** | 0 | TREES T12-L's setting + WORLD_EDITOR WE-R's stub and `/editmap` | `apps/game` settings/Options/i18n, the sound-zone feature stub, `apps/server/src/gm.ts` `/editmap` |
| T12-A | 0 (data, at once) → 1 | TREES T12-A | The tree tool (`packages/convert/src/trees/**`, new files only), the 4 prototype species |
| WE-D | 1 | WORLD_EDITOR WE-D | Apply the layers in the converter, incl. the object-shadow lightmap bake |
| WE-N | 1 | WORLD_EDITOR WE-N | The nav edit and the Publish checks |
| WE-I | 1 | WORLD_EDITOR WE-I | Incremental convert and optimize, the nav splice |
| WE-A | 1 → 2 | WORLD_EDITOR WE-A | The editor API, Publish orchestration, Test in game, Deploy hand-off |
| WE-U | 1 → 2 | WORLD_EDITOR WE-U | The editor page and tools |
| WE-R | 1 | WORLD_EDITOR WE-R | Sound zones runtime; light points and grass masks through W12-SB |
| TT-B | 1 (+ GPU) | TERRAIN_TEX TT-B | The B3 batch, the gates, the retunes, `texpipe hero` |
| TT-Q | 1 | TERRAIN_TEX TT-Q | Medium detail + anti-tiling, the no-anti-tile bit, the tier second tap |
| T12-M | 1 | TREES T12-M | The merge: swap redirect, vec4 pivot, `sroTreeW`, worker casters |
| T12-N | 1 | TREES T12-N | Bands, slots, the near-field overlay, the crowded-plaza rule |
| T12-W | 1 | TREES T12-W | `SRO_FOL_VDATA` + `SRO_FOL_BAND` chunks |
| TT-R | 2 | TERRAIN_TEX TT-R | The hero-only set range and the reserved layers |
| T12-B | 1 (B0, B1) → 2 (B2–B4) | TREES T12-B | Family batches and review pages |
| T12-E | 2 | TREES T12-E | `trees/editor.ts`: `library()`, `preview()`, `setHidden()` |
| T12-L | 1 (look A/Bs) → 2 | TREES T12-L | The viewer trees panel, the crown A/Bs, the band view |
| WE-L | 2 | WORLD_EDITOR WE-L | The library and thumbnails (incl. the Trees tab via T12-E) |
| WE-T | 2 | WORLD_EDITOR WE-T | Town routes and seats as a manual overlay, dressing rows |
| TT-K (optional) | 2 | TERRAIN_TEX TT-K | KTX2 terrain arrays: **not scheduled** (cut 1) |
| **I-12** | 3 | I-WE + the trees integration + LAB-12 prep | Integration, re-converts, docs, deploy list |
| **LAB-12** | 3 | LAB-WE + LAB-12 terrain rows + the §W6 tree bench | One bench list, one method, one results file |
| **H-12** | 3 | the three specs' hunts | One adversarial hunt with 16 lenses (§6.7) |
| **F-12** | 3 | — | Fixers, one per file set (§6.8) |
| **G-12** | 3 | — | The final gate re-bench (§6.9) |
| **V-12** | 3 | — | An independent verify by an agent that built nothing (§6.10) |

**Dropped ids:** WE-P, WE-S, WE-CV (→ W12-P, W12-SA, W12-SB, W12-CV); T12-0 (→ W12-SA; its settings half → W12-G);
I-WE and LAB-WE (→ I-12, LAB-12); LAB-12's terrain rows and TREES' integration row (→ LAB-12, I-12).

---

## 2. Conflicts and gaps across the specs, with decisions

### 2.1 Architecture and file ownership

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| D1 | When wave 12 starts building | all three (wave 11 edits `world-render`, `convert`, `gm.ts`, `water.ts`, `build-graph.ts`, `overrides.json`, `material-budgets.test.ts`) | The wave-11 lanes are uncommitted in the tree [confirmed: `git status`] | **Step 0 starts from the wave-11 final commit** (after G-11 and V-11) [decision]; every seam agent re-reads its files at that commit. At once, before it: T12-A (new files under `packages/convert/src/trees/**` and Blender scripts, no shared file), TT-B's SDXL check on three prototype tiles in scratch (GPU slot Q0, only while wave 11 holds no lock). Reason: no rebase of seams onto an uncommitted tree (WAVE_PLAN7 D1's rule). |
| D2 | `packages/world-render/src/world.ts` | TREES T12-0 (`World.trees` slot), WORLD_EDITOR S-FILTER (a region filter at decode) | Two seams, one file | **W12-SA writes both in one commit**; afterwards only I-12. `World.trees: TreesPart \| null` (PBR only; null on Classic; disposed with the world; re-made by `setRenderMode`), and `LoadWorldOptions.regionFilter?(rx, rz, decoded)` called before the mesh is built (WORLD_EDITOR §9.3 item 3). Reason: one agent on the world object. |
| D3 | `batch/types.ts`, `batch/trees.ts`, `batch/region-batch.ts`, `batch/merge-core.ts`, `model-cache.ts`, `batch/merge-worker.ts`, `render/shadows.ts`, `objects.ts`, `ambient-fx.ts`, `life/spawn.ts`, `town/fx.ts` | TREES T12-0 / T12-M, WORLD_EDITOR S-SCALE and S-OBJ | The swap redirect, the vec4 pivot and the uniform scale meet in the same compose sites | **W12-SA lands, in step 0:** the `TreeSwapSource` on `BatchHost` (off = wave-10 bytes), S-SCALE (the optional uniform `scale` multiplied at every compose site, 1 when absent: byte-identical batches), S-OBJ (`WorldObjects.setEditorOwned(pred)`). **T12-M owns** `batch/trees.ts`, `merge-core.ts`, `region-batch.ts`, `model-cache.ts`, `merge-worker.ts`, `render/shadows.ts` from step 1 and keeps S-SCALE's multiply. Nobody else edits them after step 0. Reason: one owner per step; the scale must exist before the tree merge reads it. |
| D4 | `packages/world-render/src/stream.ts` | WORLD_EDITOR S-OBJ (`RegionStreamer.reloadObjects(rx, rz)`), TERRAIN_TEX TT-R (`tileSetup`: hero-only range) | Two lanes, one file | **W12-SA adds `reloadObjects`** in step 0 (≤ 50 ms, one region re-batched through the worker); **TT-R owns `stream.ts` from step 2** for `tileSetup` only. Reason: disjoint functions, but one owner per step. |
| D5 | `packages/world-render/src/terrain.ts` (the terrain renderer and `layerData`), `shaders.ts`, `pbr/terrain-plugin.ts`, `pbr/classes.ts`, `render/quality.ts` | WORLD_EDITOR S-TERR (`updateRegion(id, {heights?, words?}, rect?)`), TERRAIN_TEX TT-Q (the no-anti-tile bit in `layerData`, `& 63` masks, the `sroTilesHi` second tap, the Medium rows) | Two lanes in `terrain.ts` | **W12-SB lands S-TERR** in step 0, and `updateRegion` recomputes the layer words through the same `layerData` the region build uses; **TT-Q owns** the five files from step 1 (its `layerData` line then reaches painted regions for free). Reason: the editor's paint and the anti-tiling bit can never disagree. |
| D6 | `packages/convert/src/world/manifest.ts`, `convert-world.ts`, `passes.ts`, `cli.ts`, root `package.json`, `node-io.ts`, `sro.config.example.json` | WORLD_EDITOR WE-CV (pass slot, `editsSource`, the nav-step hook, the pre-pass cache, the convert lock, `world-edit` verbs, S-UID), S-SCALE's type, TREES WF11 (`WorldModel.treeSwap`, the species appended as models), T12-A (`trees` verb, `blenderExe`) | Four users of the converter's spine | **W12-CV writes every hook and type** in step 0, in the pass order **coast (C9) → town dressing → cloth → static variants → grass palettes → world edits**, with the tree-swap manifest step calling a stub `world/trees-manifest.ts` and the edits pass calling a stub `world/edits/index.ts`; afterwards **T12-A owns `world/trees-manifest.ts`** and `trees/**`, **WE-D owns `world/edits/**`**, **WE-N owns `world/edits/{nav-edit, checks}.ts`**, **WE-I owns `tools/convert-region.ts` and the `--files` path of `optimize-out.ts`**, and nobody edits `convert-world.ts` (I-12 only). Root scripts `editor` and `trees` land with W12-CV (the lead's file). Reason: WAVE_PLAN7 D13's pattern. |
| D7 | `content/texpipe/overrides.json`, `work/out/pbr/index.json`, `packages/texpipe/**` | TERRAIN_TEX TT-B (B3 rows, hero flags, routes, prompts, gates; `terrain-spots.ts`, `review.ts`), TT-R (`cover` in `format.ts`), TREES T12-B (the TX-R map-set rows of the new sprite keys, B0's sprite tiers), WORLD_EDITOR (Publish flips `hero` past 0.1 % cover), wave 11 TL-B phase 2 (the B2 town batch config) | Five writers of one data file and one index | **TT-B owns `overrides.json` and `packages/texpipe/**`** (incl. the optional `cover` field in `format.ts`; TT-R only reads it). **T12-B writes its rows into a fragment** `content/trees/texpipe-rows.json` that TT-B merges (key-disjoint, `validateOverrides`) at X1 and X2. **The index is written only by texpipe's merge** (`work/out/pbr/index.json` "merged with earlier runs" [confirmed: `cli.ts`]), and every texpipe encode runs as a GPU-queue item, so two merges never race. TT-B adds a CLI verb `texpipe hero <tile> on\|off` (overrides + index, no re-encode: every B3 set carries all maps); **WE-A's Publish calls it** and never edits the files itself. Reason: one writer per file; the editor's flip stays a validated, index-only change. |
| D8 | `pbr/foliage-plugin.ts` | TREES T12-0 (define skeletons), T12-W (the VDATA and BAND chunks), wave 11 (cloth define slot, landed) | One plugin, three hands | **W12-SA adds `SRO_FOL_VDATA` and `SRO_FOL_BAND` skeletons** (off = HEAD strings in both languages), with **one `vec4` pivot declaration whenever BAND or PIVOT is on** (WF9: BAND never depends on the wind); **T12-W owns the chunks** from step 1. Reason: one owner per step; the WF9 trap is closed in the seam. |
| D9 | `apps/game/src/settings.ts`, `hud/options.ts`, `i18n/en-render.ts`, `world/graphics.ts`, `world/features.ts` | TREES T12-L (`graphics.trees: 'new' \| 'retail'`), WORLD_EDITOR WE-R (a `soundZones` world feature) | Shared normaliser and registry | **W12-G adds** the field (`'new'` on Medium+, absent on Low; old saves → `'new'`), the Graphics row and strings, the `loadWorld` option pass-through, and a stub `world/features/sound-zones.ts` registered in `features.ts`; afterwards **WE-R owns `audio/zones.ts` and the feature file**, **T12-L tunes the default** in `settings.ts` only. Reason: WAVE_PLAN7 D10's rule. |
| D10 | `apps/server/src/gm.ts` | WORLD_EDITOR F12 (`/editmap`), wave 11 U-S (`/unique`) | Wave 11 edits it | **W12-G adds `/editmap`** after the wave-11 commit (one row: a tokenless link on this PC, "the editor runs on the host PC" on the live server). Reason: one line, no protocol change. |
| D11 | `apps/viewer` | WORLD_EDITOR WE-A (editor API plugin, `editor.html` entry, its cacheDir), WE-U (`src/editor/**`), WE-L (`src/editor/library/**`), WE-T (`src/editor/town/**`), TREES T12-L (`src/world/trees-panel.ts`) | One app, five lanes | **WE-A owns** `apps/viewer/vite.config.ts` changes, `editor-api/**` and the viewer `package.json`; the others own their folders only. Reason: one owner of the app's build. |
| D12 | `content/town/jangan.json`, `jangan-dressing.json`, `packages/convert/src/town/build-graph.ts` | WORLD_EDITOR WE-T (a `manual` overlay that `town-graph` keeps; dressing rows by id) | Wave 11's TL-R / TL-B files | **WE-T edits them in step 2, after the wave-11 commit**, through `validateTownFile`; the overlay is a new authored block that build-graph applies after regeneration. Reason: wave 11 owns them until it commits; one owner afterwards. |
| D13 | `apps/game/src/audio/town.ts` | WORLD_EDITOR WE-R (zones beside the town loops) | Wave 11's TL-S file | **Not edited.** Zones play beside it in `audio/zones.ts` (≤ 2 zone loops, ≤ 1 inside the town box). |
| D14 | `material-budgets.test.ts`, the Low guard tests | TT-Q (≤ 16 WebGL2 units on Medium, 14 expected), T12-W (no new varying), W12-SA (define registration) | Shared tests; wave 11 has uncommitted edits in the budgets test | **W12-SA registers the new define sets** in step 0 (after the wave-11 commit); TT-Q and T12-W add their assertions in their own `describe` blocks. |
| D15 | `packages/nav` | WORLD_EDITOR S-NAV (`NavWorld` instance replace) | No other user | **W12-P** (a small, disjoint package; keeps the editor's foundation in one agent). |

### 2.2 State ownership (one source of truth each)

| State or module | Produced by | Consumed by | Owner lane |
|---|---|---|---|
| Edit layers (height deltas, paint, grass/flower masks, walkable, `placements.json`, water, lights, zones, probes) | the editor, `content/world-edits/jangan-fields/` | the converter's edits pass, the editor | **W12-P** (format), **WE-A** (I/O), **WE-D** (apply) |
| The edit journal (undo, redo, revert one, revert a region) | the editor API, `work/editor/` (outside git) | the editor | **WE-A** |
| Authored uid ranges (retail, dressing 1,000,000+ by row, editor 0xE000–0xEFFF per region) | the S-UID registry | the converter, the nav ids (`regionId << 16 \| uid`) | **W12-CV** |
| The nav rule (slope > 35° closes, never auto-opens, new water > 1.2 m closes, overrides last, footprints move with objects) | `packages/shared/src/world-edits/nav-rule.ts` (pure) | the editor preview, the converter, WE-N's checks, tests | **W12-P** |
| Which retail model maps to which species (fit, tint) | `content/trees/swap.json` → `WorldModel.treeSwap` in the manifest | `batch/trees.ts` `modelFor` | **T12-A** (data), **T12-M** (read) |
| The band byte per foliage placement (0 near, 1 mid, 2 far, 3 hidden; 8,192 slots) | `trees/bands.ts` | the merged vertex shader, the overlay, the editor's hide | **T12-N** |
| The tree library (species, carrier, size range, thumbnail) | `content/trees/library.json` | WE-L's Trees tab through T12-E | **T12-A / T12-B** (data), **T12-E** (API) |
| Per-tile terrain sets, hero flags, `cover` | `overrides.json` + texpipe → `work/out/pbr/index.json` | `stream.ts` `tileSetup`, `tile-atlas.ts`, the editor palette | **TT-B** |
| The paint palette (108 rows by surface: grass, sand, dirt, rock, road...) | `content/world-edits/jangan-fields/palette.json` | the editor's Paint panel | **WE-U** |
| The set range rule (hero only, last 8 layers reserved) | `stream.ts`, `tile-atlas.ts` | the terrain material | **TT-R** |
| Medium/High terrain shading rows (detail, anti-tiling, tier second tap) | `render/quality.ts`, the plugin | — | **TT-Q** |
| `graphics.trees` | `settings.ts` | `world/graphics.ts`, `loadWorld` | **W12-G** writes, **T12-L** tunes |
| Baked object shadows in the lightmap | the converter (retail bake; edited regions: WE-D's baker) | the terrain material | **WE-D** |

### 2.3 Cross-item behaviour

| # | Topic | Problem | Decision |
|---|---|---|---|
| D16 | Placing a new tree in the editor | The editor places placements; the swap draws species | **A species is placed as its retail carrier model** from `library.json` (TREES §W3.9, WORLD_EDITOR D25): Low shows the retail tree, Medium+ the species, the carrier's nav footprint goes into the walking rebuild. While dragging, `World.trees.preview` shows the species' LOD0 and band 3 hides the merged copy; on drop S-OBJ re-batches the region. Reason: one placement format; nav and Low stay consistent. |
| D17 | Tree scale | WORLD_EDITOR D12 (trees 0.85–1.15), TREES Q-W7 (±15 %) | **Agree: trees 0.85–1.15** through S-SCALE, the nav footprint stays unscaled (≈ ±7 cm on a 0.5 m trunk, accepted); 0.5–2 for footprint-free props; never buildings; no tilt. |
| D18 | Which shape bakes the editor's object shadows for a swapped tree | WORLD_EDITOR D51 bakes LOD0 triangles of the placed model; the retail carrier is not what players see | **The baker uses the species' LOD1** (what casts the real-time shadow, TREES §W3.6) when the model has `treeSwap`, leaf cards cut at 0.5; the carrier's LOD0 otherwise. Unedited regions keep their retail baked shadows (the species stay within ±10 % of the retail envelope) [decision; a world-wide re-bake is deferred, §11]. Reason: a planted tree's ground shadow matches the tree players see. |
| D19 | The paint palette and the remaster | WORLD_EDITOR palette.json (108 rows); TERRAIN_TEX D12 (108 tiles, remastered); B3c tiles are albedo-only | **The palette shows the remastered 512 albedo of all 108 tiles**; Publish calls `texpipe hero <tile> on` for any tile painted past 0.1 % cover (D7). A tile outside the 108 is out of scope this wave. |
| D20 | The editor's look while the wave builds | The editor previews with whatever sets and species exist | The editor runs on `work/out` like the game; it shows B3 tiles and species as their batches land. No editor Publish runs on the main export during the build (D37). |
| D21 | Terrain heights edited under trees | A raised hill under a merged tree | The tree snaps through the placement pass (WORLD_EDITOR §4.6: clearance kept; buried / floating judged on the **change** in clearance, since retail trunks sit up to 1.4 m below ground). The band byte and the merged geometry follow the re-batch. |
| D22 | Grass masks and new plants | Both change the ground cover | Independent: masks multiply GRASS_LIFE's bake; plants are placements. A painted-out area keeps its placed weeds unless the user deletes them. |
| D23 | Low (Classic) | All three items | **Low stays retail**: retail trees (the swap never applies), retail tiles (the Low guard), grass masks ignored; the night-light splat with editor points is baked on every preset (WORLD_EDITOR F22) and is the only Low change, and only when the user adds points. The Low guard tests stay green (no edits ⇒ no change). |
| D24 | The crowded plaza (G1's thin scene) | Trees add ≈ +0.3 ms there (mostly the overlay's draws and refill) | **The crowded-plaza tree rule** (T12-N): on Medium, with ≥ 15 players in range, the LOD0 overlay draws only within 20 m (merged LOD1 beyond) [decision]. Reason: it mirrors wave 11's crowd giving way to players; worth ≈ 0.2 ms [projected]. Cut item 17 makes it 0 m. |
| D25 | Shader warm-up | The species' overlay materials, the VDATA/BAND variants, TT-Q's Medium defines | Every new effect compiles at world load through `warmup-hooks.ts` (T12-N and TT-Q register); no compile when the first new tree enters band 0 or the first painted region streams in (H-12 lens 10). |

### 2.4 Data, content, tools and delivery

| # | Topic | Decision |
|---|---|---|
| D26 | Re-converts | Two lead checkpoints when no lane writes `work/out/` (the convert lock, WORLD_EDITOR F15, guards them): **X1** after W12-CV, T12-A's B1 species, WE-D's empty pass and TT-B's B3a/B3b encode: `pnpm sro convert` (world) + `optimize-out run --only world/,trees/,pbr/` [flag confirmed: `optimize-out.ts`]; checks: untouched regions byte-identical with the edits pass empty (G7), only the B1 models carry `treeSwap`, 63 hero sets in the index. **X2** after T12-B's B2–B4, TT-B's B3c and retunes, WE-D/WE-N/WE-I complete: full re-convert + full optimize (a fresh baseline, ≈ 15 min); WE-I's incremental output byte-compared against it. No re-convert between X2 and G-12 except F-12 fixes (then a third run, X3). |
| D27 | The GPU queue | One `work/tools/gpu.lock` (mkdir must succeed **before** anything else runs; owner file "label time"; only the creator removes it; `work/tmp/terrain-tex/locked.sh` is the pattern; never a chained `mkdir ...; ...; rm -r`, the TERRAIN_TEX author's mistake). Priority: bench timings (LAB-12, G-12, V-12) > short upscale batches (TP-U, B0) > the in-game review shots (T12-B per batch, TT-B's spots) > DT-2 SDXL (overnight, ComfyUI only through `start_comfyui.sh` / `stop_comfyui.sh`) > anything else. Blender headless and CPU texpipe stages (TP-P, TP-E) need no lock but run as queue items when they write `work/out/pbr` (D7). §6.1 is the schedule. |
| D28 | The editor and the lock | The editor renders on demand and stops continuous previews while another owner holds the lock (WORLD_EDITOR D47); during the build nobody runs the editor in the pane except WE-U's tests, under the lock. |
| D29 | Downloads and uploads | **None.** Real-ESRGAN, ComfyUI with SDXL and ControlNet-Tile, basisu, Blender 5.2, Python and Babylon's gizmos (`@babylonjs/core`) are installed [confirmed: the three specs' needs lists]. Uploads: retail sprites to Meshy only under the D30 contingencies; the ≈ 171 MB of new assets go to the mini PC with the normal deploy over Tailscale. |
| D30 | Meshy | §0.3: cap 600, planned 0, contingencies ≤ 90 (dead trunks, on rejection) + ≤ 120 (B4 stumps, time trigger), logged per job. |
| D31 | Low retail assets on the server | The retail foliage glbs stay deployed (Low and the `graphics.trees: 'retail'` switch use them); the Medium+ client stops fetching 5.8 MB of them (TREES WF19). |
| D32 | Editor uploads and the deploy path | The editor is never built for players: the mini PC builds only `@sro/game` [confirmed: `deploy/remote/install.sh`]. The game gains only the `/editmap` line, the light-points reader, the grass-mask fetch, the optional placement `scale` and the sound-zone runtime. |
| D33 | Stale clients after the deploy | No wire change; an old client on a new export ignores `treeSwap`, `scale`, masks and points (additive manifest fields) and draws retail trees, unscaled; "reload the page" note as every wave. |
| D34 | New 3D models | The 35 species (bpy) and nothing else; the editor makes no assets (WORLD_EDITOR D45). |
| D35 | Process note carried from the design | The TERRAIN_TEX author's first lock attempt deleted another workflow's `gpu.lock` (restored within seconds); the lead logs it in NIGHT_LOG at the start of the build, and D27's rule is in every GPU lane's prompt. |
| D36 | The deploy of wave 12 | **A new OK from the user is required** [decision]: the chat OK of 13:40 covers waves 10 + polish + 11 only, and "make all decisions" is not read as a deploy OK (NIGHT_LOG). After the OK: one `pnpm run deploy` (code + assets), server and client together, DB backup first (no migration this wave). Reason: the standing rule. |
| D37 | The editor during the build | **No lane runs a Publish or a Deploy on the main export** (`work/out/world/jangan-fields`): WE-A/WE-U/I-12 test Publish on the staging export `jangan-fields-edit` and on fixtures only; `content/world-edits/jangan-fields/` ships empty (the folder and `palette.json` only). Reason: the first real map edit is the user's, after the release. |
| D38 | The specs' "stays retail" cuts | TERRAIN_TEX cut 5 (B3c retail) and TREES cuts 3, 4, 8 (B4, flowers and water plants, B3's plants as retail geometry) contradict the user's "all"; they leave the cut list and become never-cut; cheaper cuts inside them replace them (fewer species per family, no per-vertex flex) (§7). Reason: the user's words. |

### 2.5 Numbers and config (consolidated)

| What | Value | Source |
|---|---|---|
| Editor | `pnpm editor` on 127.0.0.1:5185 strict, session token, Origin + Host checks, its own Vite cacheDir; one editor at a time; journal ≤ 2,000 changes / 200 MB in `work/editor/` | WORLD_EDITOR D3, D4, D17 |
| Height delta | LA16 PNG per region, `L = 32768 + round(dh × 256)`, −128 … +127.996 m, 1/256 m steps, base hash per region | WORLD_EDITOR D8, D50 |
| Editor uids | 0xE000–0xEFFF per owner region (largest export uid 0xB41D); dressing by row id | WORLD_EDITOR D11, F4 |
| Nav rule | slope > 0.7 rise/run (35°) closes; nothing opens by itself; new water > 1.2 m closes; overrides last | WORLD_EDITOR D40 |
| Guardrails per region | object triangles warn 60 k / refuse 90 k (p95 16.1 k, worst 49.5 k); placements 400 / 600; models 60 / 90; separate draws 12 / 20; light points within 60 m 24 / 48; zones per point 3 / 4; tree slots 7,500 / 8,192 (5,586 used) | WORLD_EDITOR §7.2 |
| Publish bench trigger | a touched region grows > 10 % or > 5 k triangles: Medium + High on both backends vs G1, G2, G6 | WORLD_EDITOR D43 |
| Terrain sets | B3a 22 / B3b 21 / B3c 45; 63 hero; SDXL on 10; painterly rule aiMix 0.5, aoScale 0.25, normalScale 0.6, delight 0.5; gates grain ≥ 60 %, colour ±3, in-game −3 | TERRAIN_TEX D1–D6 |
| Set range | min(48, hero sets), allocated once; the last 8 layers for above-median-cover tiles | TERRAIN_TEX D7, D8 |
| Medium terrain shading | detail layer (1.5 m period) + anti-tiling; paving opts out through the alpha bit 64; ≤ 16 WebGL2 units (14) | TERRAIN_TEX D9, F13 |
| Tree tiers | LOD0 3,500 (4,500 for ≥ 30 m) / LOD1 1,200 / LOD2 520; plants 320 / 90; bands 40 / 110 m × rangeScale (plants 25 m), 3 m hysteresis, refill every 4 m | TREES §W9.1 14, Q-W1 |
| Tree vertex | 60 B (`sroPivot` vec4, `sroTreeW` unorm8x4) | TREES WF5 |
| Tree look gates | per sprite luminance ±2 %, saturation ±5 %; per family crown luminance ±10 % in game | TREES WF1, WF3 |
| Crowded-plaza tree rule | Medium, ≥ 15 players in range: overlay within 20 m only | D24 |
| Meshy | cap 600, planned 0, contingencies 90 + 120, reserve ≥ 200 (balance 1,840) | D30, §0.3 |

---

## 3. Formats and content (additive; no protocol change, no migration)

### 3.1 Wire and server

- **No new message, no new request, no fail reason, no migration, no server config key** [confirmed: none of the three
  specs adds one; the editor talks to its own local API, `/editmap` replies through the existing GM chat path].
- `apps/server/src/gm.ts` gains `/editmap` (W12-G, D10). The server reads `nav.bin` exactly as today; Publish rewrites
  it (and `nav-objects.bin`, the chunks) for the touched regions.
- `WORLD_EXPORT=jangan-fields-edit` is accepted by the existing `WORLD_FOLDER` rule (a–z, 0–9, `-`) [confirmed:
  WORLD_EDITOR F13]; used only by "Test in game" on a private server with a temporary DB copy.

### 3.2 Manifest (`packages/convert/src/world/manifest.ts`; W12-CV)

```ts
interface WorldPlacement { /* ...today's fields... */ scale?: number }   // S-SCALE: uniform, absent = 1
interface WorldModel {      /* ...today's fields... */
  treeSwap?: { model: number; fit: [number, number, number]; tint: number } }  // TREES WF11: index of the species model
// per region (existing region entry): optional files
grassMask?: string        // WORLD_EDITOR D55: 1 m grass/flower mask, only where painted
lightPoints?: number      // count; the points ride in ambient.json `points` (D13 of WORLD_EDITOR)
```

- Old exports validate (every field optional); the manifest test asserts a round trip without them.
- The species are **appended as manifest models** by `world/trees-manifest.ts` (T12-A), so `modelFor` stays a manifest
  lookup [confirmed: TREES WF11].

### 3.3 Content

| Path | Owner | Validator |
|---|---|---|
| `content/world-edits/jangan-fields/{height,paint,grass,walkable}/<x>_<z>.png`, `placements.json`, `water.json`, `lights.json`, `zones.json`, `probes.json`, `edits.json`, `palette.json` | WE-A writes (the editor), WE-U (`palette.json`) | W12-P's validators; Publish refuses an invalid layer |
| `content/trees/species/<id>.json`, `swap.json`, `library.json`, `texpipe-rows.json` (D7 fragment) | T12-A, T12-B | T12-A's `validate.ts` |
| `content/texpipe/overrides.json` (B3 rows, retunes, hero flags, prompts; the tree fragment merged) | TT-B | `validateOverrides` |
| `content/town/jangan.json` `manual` block; `jangan-dressing.json` row ids | WE-T (after wave 11) | `validateTownFile` |

### 3.4 Settings, scripts, deploy

- `graphics.trees: 'new' | 'retail'` (Options → Graphics → Trees), `'new'` on Medium+, absent on Low (W12-G).
- Root scripts: `"editor"` (WE-A's plugin entry), `"trees"` (`tsx packages/convert/src/trees/cli.ts`) (W12-CV).
- **Deploy:** the wave goes out once, with the user's new OK (D36), through `pnpm run deploy` (code + assets). The
  editor's own Deploy button (`pnpm run deploy -- --assets-only` [confirmed flag: `deploy/deploy.sh`]) is for map
  edits **after** the wave-12 release, refused while converter, shared, nav or formats code is uncommitted or newer than
  the deployed release (WORLD_EDITOR D36).

---

## 4. Seams (step 0; five agents; every edit additive; the Low guard stays green)

All five start from the wave-11 final commit (D1) and re-read every file they touch.

### 4.1 W12-P: `packages/shared/src/world-edits/**` + S-NAV (one agent; effort M, 2 days)

WORLD_EDITOR WE-P in full: the layer types and codecs (LA16 heights with the exact zero, paint words, 1 m masks,
walkable, the placement-edit list as drop + add, water, lights, zones, probes), the pure apply functions (shared by the
editor and the converter, node-free), the nav rule, the validators. S-NAV in `packages/nav`: an instance replace on
`NavWorld` (or an objects-only rebuild) for the walk preview.
**Tests:** `world-edits*.test.ts` (LA16 round trip exact incl. 0; apply determinism; the nav rule on fixtures: a cliff
closes, nothing opens, water > 1.2 m closes, overrides apply last; validators reject a delta outside the export edge, a
uid outside 0xE000–0xEFFF, a placement edit on an unknown key); `nav-instance.test.ts` (replace = remove + add; ids
`regionId << 16 | uid` unchanged).

### 4.2 W12-SA: world-render, the object side (one agent; effort M–L, 2.5 days; commits in this order)

1. **The trees slot and the region filter** (`world.ts`, D2): `World.trees: TreesPart | null`, `trees/types.ts`
   (`TreesPart` with `library()`, `preview()`, `setHidden()`, `stats()` stubs), `LoadWorldOptions.regionFilter`,
   `LoadWorldOptions.trees` (`'new' | 'retail'`).
2. **The swap source** (`batch/types.ts`): `TreeSwapSource` on `BatchHost` (null = wave-10 behaviour byte for byte).
3. **S-SCALE** at every compose site (`objects.ts`, `batch/region-batch.ts`, `batch/trees.ts`, `ambient-fx.ts`,
   `life/spawn.ts`, `town/fx.ts`), reading `placement.scale ?? 1`.
4. **S-OBJ**: `WorldObjects.setEditorOwned(pred)`; `RegionStreamer.reloadObjects(rx, rz)` (one region through the
   merge worker, ≤ 50 ms total, no frame over 16.7 ms).
5. **The foliage define skeletons** (D8): `SRO_FOL_VDATA`, `SRO_FOL_BAND` off; one `vec4` pivot declaration whenever
   BAND or PIVOT is on; `material-budgets.test.ts` registration (D14).
**Tests:** `trees12-seams.test.ts` (no swap source = BT-T fixtures byte for byte; Classic: `World.trees` null; PBR →
Classic → PBR leaves nothing); `scale-seam.test.ts` (absent `scale` = byte-identical batches; `scale` 1.15 scales the
merged vertices and the clone); `reload-objects.test.ts` (one region re-batched, the others untouched, an editor-owned
uid absent from the batch); the define-off strings equal HEAD in WGSL and GLSL; the Low guard (`seams-classic`,
`release-lowguard`, `abuse-w9f-lowguard`, `abuse-w10r-lowguard`).

### 4.3 W12-SB: world-render, the ground side (one agent; effort M, 1.5 days)

S-TERR `TerrainRenderer.updateRegion(id, { heights?, words? }, rect?)` (positions, normals, the layer words through the
region build's own `layerData`, the lightmap layer re-upload; D5); S-GRASS `GrassField.invalidate(rect)` and the mask
multiply in `grass/bake.ts` (manifest-listed masks; Low ignores them); S-NL `ambient.points` in `night-lights.ts` (pick
+ splat); the water block update in `water.ts` (one water mesh per region).
**Tests:** a region updated with its own heights is bit-identical; an update's seam vertices equal the neighbour's;
a mask of all-ones = today's bake byte for byte; `points` empty = today's lights and splat; the water strings unchanged
with no update; the Low guard.

### 4.4 W12-CV: the converter spine (one agent; effort M, 2 days)

`passes.ts` (the "world edits" slot last), `convert-world.ts` (`editsSource` hook; the navmesh-step hook for footprint
edits; the cached **pre-pass** placement list; the convert lock `work/out/.convert.lock`, also taken by
`convert-region`), `manifest.ts` (§3.2), the stub `world/trees-manifest.ts` and `world/edits/index.ts`, `cli.ts`
(`world-edit` verbs, `trees` verb on a stub), S-UID (the authored-uid registry and its overlap error), `node-io.ts` +
`sro.config.example.json` (`blenderExe`), root `package.json` scripts.
**Tests:** the pass order (a fixture where C9 drops a uid, the dressing adds one and the edits move one: static
variants and grass masks see the right set, never a dropped uid); an empty edits layer = byte-identical region files;
the nav step and the edits pass agree on every edited footprint; a uid collision is an error; old manifests validate.

### 4.5 W12-G: game and server (one agent; effort S, 0.5 day)

`graphics.trees` in `settings.ts` (normalisation, defaults per preset), the Graphics row in `hud/options.ts`, strings
in `i18n/en-render.ts`, the pass-through in `world/graphics.ts`; the stub `world/features/sound-zones.ts` registered in
`world/features.ts`; `/editmap` in `apps/server/src/gm.ts`.
**Tests:** `settings.test.ts` additions (defaults, absent on Low, old saves); the feature registry lists the stub; a
GM `/editmap` on a non-local server answers the host-PC sentence; the whole `apps/game` and server suites.

---

## 5. Presets and budgets

### 5.1 What the wave adds per preset

| Preset | Editor content (with edits) | Terrain textures | Terrain shading | Trees and plants |
|---|---|---|---|---|
| Low (Classic) | edited heights, paint, placements (retail models), the night-light splat of new points; no grass masks; sound zones | unchanged (retail; the Low guard) | unchanged | **retail** (the swap never applies) |
| **Medium (default)** | as Low + grass masks, 8 lights, placement scale | every tile's remastered 512 albedo; ORMH (AO + roughness) for the 63 hero tiles | **+ detail layer, + anti-tiling** (paving out) | the 35 species: LOD1/LOD2 merged, LOD0 overlay within 40 m × rangeScale; retail-size sprites; plants static with per-vertex flex |
| High | as Medium, 32 lights, edited objects cast real-time shadows | + normals and the 1024 tier for hero tiles | + anti-tiling with the tier second tap | as Medium + the 2× sprite tier |
| Ultra | as High, 64 lights | as High | unchanged (it already has both) | as High (LOD1 casts within 60 m) |

### 5.2 Budgets and honest costs (WAVE_PLAN6 §5.2 format; 1080p)

Dev PC = Ryzen 5 9600X + RX 9060 XT, Chrome. "Mid" = a CPU ≈ 1.5× slower; "laptop / M1" = CPU × 1.4–2, a base M1 GPU
≈ 9–11× the dev GPU time at Retina 0.75 (WAVE_PLAN6 §5.2). Baselines are the **measured wave-10 polish re-bench**
(`wave10/budgets.md`, frame p95, 12:47–12:57) [confirmed]. Wave 11's deltas are WAVE_PLAN7 §5.2's projections, re-based
on the polish numbers [projected]; **G-11's measured numbers replace them** before LAB-12 judges anything. Wave 12's
deltas: trees from TREES §W6 [projected; the merged LOD1 + LOD2 vertex work included, WF6], terrain from TERRAIN_TEX
§6.2–§6.3 (the Medium detail + anti-tiling lane budget ≤ +0.15 ms GPU; texture swaps are stream jobs; no per-frame CPU),
the editor 0 with no edits [confirmed by construction: G7]. Arithmetic: `work/tmp/w12-plan/budget.py`.

**Frame p95 on the dev PC, wave-10 polish (measured) → wave 11 (projected) → wave 12 (projected), WebGPU / WebGL2, ms:**

| Preset | Plaza noon | **Plaza: 20-mob crowd + 20 jumping players + the town (G1's thin scene)** | Fields night (+ ring) | Meadow noon | Beach noon | Tiger fight: party of 4 / 20 players | Pass line |
|---|---|---|---|---|---|---|---|
| Low | 2.5 / 2.1 → unchanged | 9.4 / 8.5 → unchanged | 2.8 / 2.1 → unchanged | unchanged | unchanged | below Medium | pass |
| **Medium (default)** | 3.9 / 3.1 → 5.2–6.2 / 3.9–4.3 → **≈ 5.4–6.9 / ≈ 4.1–4.9** | 13.7 / 8.9 (repeats 13.0–15.1) → 13.7–16.2 / 9.0–9.3 → **≈ 14.0–16.6 / ≈ 9.2–9.8**; with the crowded-plaza tree rule ≈ 13.8–16.4; undivided upper corner 17.1–17.2 | 6.3 / 4.8 → 6.4 / 4.9 → **≈ 6.6–7.0 / ≈ 5.1–5.5** | 4.7 / 3.3 → **≈ 5.0–5.5 / ≈ 3.5–4.0** | 1.5 / 1.0 → **≈ 1.5–1.8 / ≈ 1.0–1.2** | 7.2 → ≈ 7.4–7.9; 13.8 → ≈ 14.0–14.5 | **G1 < 16.7: pass everywhere but thin at the 20-player plaza** (≈ 0.1–2.7 ms spare); LAB-12 decides against G-11's measurement; cuts 17–18 |
| High | 6.1 / 3.5 → 7.3–7.9 / 4.2–4.7 → **≈ 7.6–8.6 / ≈ 4.5–5.4** | 17.1–19.3 / 12.0 → + ≈ 0.6–1.2 (wave 11) → + ≈ 0.4–0.7 (trees): **misses on WebGPU** (as in wave 10: 20 player characters) | – | 5.9 → ≈ 6.3–6.8 | – | ≈ 10.4 → ≈ 10.8–11.2; 20 players ≈ 19.5 → ≈ 20: misses | **G2: plaza ≤ 12 → pass; 20-mob crowd ≤ 14 → ≈ 9.6–10.8 pass; WebGL2 plaza ≤ 8 → pass**; the 20-player scenes are reported, not gated |
| Ultra | 5.7 → + ≈ 2–2.5 | not a target | 7.3 → + ≤ 0.6 | – | – | not a default | G3 only |

| Preset | Draws added (plaza, main + shadow) | GPU added (dev) | Mid desktop (CPU × 1.5) | Laptop / M1 | VRAM added | Download added |
|---|---|---|---|---|---|---|
| Low | 0 | 0 | unchanged | unchanged (N100 class) | 0 | 0 (retail stays; edited regions ≈ 0.14 MB each after a Publish) |
| **Medium** | trees: tree groups 22 → **26** at the plaza (≤ +4 overlay; busiest 16 → 26); terrain 0; editor 0 (batched) | trees ≤ +0.2 ms; terrain ≤ +0.15 ms [likely within noise, both backends to measure] | ≈ +0.3–0.5 ms CPU (overlay draws ≈ 12 × 18 µs, the 4 m refill ≤ 0.1 ms) | **M1 GPU ≈ +0.2–1.0 ms** (trees ≤ +0.6 incl. the submitted vertices; terrain +0.2–0.4); the M1 beach (11–15 ms) is the tight spot: **G6** holds the dev GPU delta there to ≤ 0.15 ms | **+38–53 MB**: terrain ORMH +9.8; trees merged geometry +28–40 + overlay ≤ 3; tree textures ≈ +0 (retail-size sprites) | **≈ +3.0 MB on first entry to town** (terrain +4.3, trees −1.3 net); ≈ +8.4 MB for the whole area |
| High | trees 30 → **36** at the plaza (busiest 26 → 38); caster draws unchanged (one per region) | trees ≤ +0.4 ms; terrain anti-tiling ≈ +0.05 | ≈ +0.4–0.6 ms CPU | gaming laptop: the High crowd + 20 players already misses; no new CPU per frame from terrain | **+291–356 MB** on WebGPU (terrain set planes **+235 MB** for every High WebGPU player: tier 5.59 + normal 1.40 + ORMH 1.40 MB × 48 layers; tree sprites 2× +26–73 MiB; geometry +30–45 MB); plaza texture VRAM ≈ 1,017 → ≈ 1,280–1,330 MiB; **+105–170 MB on WebGL2** | **≈ +20 MB first entry** (terrain +20, trees −1.3 + 1–2 of 2× sprites); ≈ +25 MB for the whole area; WebGL2 ≈ +8–9 MB |
| Ultra | as High | ≤ +0.5 ms (trees) | not offered | not offered | as High | as High |
| Server disk (deploy) | | | | | | **≈ +171 MB** (terrain sets 88 × 1.85 MB ≈ 165; species ≈ 4.5 + the 2× tier ≈ 1–2; retail foliage glbs kept for Low) |

What the tables mean, honestly:

- **Medium, the default, holds 60 fps everywhere on the dev PC** with the three items on [projected]. Every plain
  scene stays at ≤ 7 ms. The only thin scene is wave 11's **plaza with 20 players plus the crowd and the town**: wave 10
  left 1.6–3.7 ms there, wave 11's town takes most of it, and wave 12's trees add ≈ 0.3 ms, mostly the LOD0 overlay's
  draws and refill (the merged tiers add no draw). Against WAVE_PLAN7's capped projection the scene stays under the line
  (≈ 14.0–16.6); only WAVE_PLAN7's undivided worst corner (16.8) plus the trees crosses it (17.1–17.2) [projected]. Hence
  the crowded-plaza tree rule (D24), LAB-12's first job, and cuts 17–18.
- **The terrain's cost is memory, not time.** Medium pays ≈ 10 MB of VRAM and two texture samples per terrain pixel
  (measured within noise on WebGPU, [likely]); **High WebGPU pays +235 MB** for every player because the set planes are
  48 layers deep once there are 48 hero sets (the town window alone needs 43–50) [confirmed arithmetic: TERRAIN_TEX
  F1]. That fits the friends' 6–8 GB gaming GPUs [likely]; KTX2 (TT-K) would cut it to about a quarter and is the first
  cut, not scheduled.
- **The trees' cost moves from draws to vertices and memory.** Draws stay where wave 10 put them (+4–6 overlay draws at
  the plaza); every merged LOD1 and LOD2 vertex is shaded every frame (submitted triangles 34.5 k → ≈ 183 k on Medium at
  the plaza, WF6), which is small on the dev GPU and is what the M1 column and G6 watch. Merged geometry grows by
  ≈ 28–40 MB; the 8 GB Macs carry it on Medium [projected].
- **The editor never reaches a player's frame by itself.** With no edits, the export is byte-identical (G7); with
  edits, the per-region guardrails (§2.5) and the Publish bench (Medium + High, both backends, G1, G2, G6) hold the line
  region by region. The night-light splat of new points is the only Low change.
- **High misses 60 fps with 20 players**, before and after this wave (17.1–19.3 ms in wave 10; the trees add ≈ 0.4–0.7):
  BACKLOG item 9 (character LOD, skinning, batching), reported, not hidden; this wave cannot lower it.
- **Projections rest on three labs and two busy machines** (TREES' CPU columns may be skewed, WF13). LAB-12 measures
  the production bundle on a quiet machine before anything ships, and every G1 miss goes to §7.

### 5.3 Per-lane budgets (dev PC, 1080p; the GPU lock for every in-browser timing)

| Lane | Budget |
|---|---|
| W12-SA S-OBJ | one region out of its batch and back ≤ 50 ms total, no frame > 16.7 ms (the prototype's whole `rebuild()` was 2.3–4.6 s) |
| W12-SB S-TERR | region upload (heights + normals + words) ≤ 1 ms (prototype 0.39–0.92 ms) |
| WE-U | brush stamp ≤ 1 ms mean, ≤ 8 ms worst; ≤ 4 region uploads per frame; an idle editor draws no frame |
| WE-D | lightmap re-bake with object shadows ≤ 0.3 s per region in the editor's worker, ≤ 1 s in the converter |
| WE-N + WE-I + WE-A | Publish of ≤ 9 regions ≤ 2 min end to end (convert ≤ 15 s, optimize ≤ 30 s, nav checks ≤ 10 s); Save ≤ 0.5 s |
| WE-R | sound zones ≤ 0.05 ms main thread; ≤ 2 zone loops, ≤ 1 inside the town box |
| TT-B | the batch ≤ 30 min CPU+GPU without SDXL; DT-2 ≤ 2.5 h; every set passes or is noted against the three gates |
| TT-R | a set-tile upgrade job ≤ the stream frame budget (4 ms Medium, 5 ms High); no frame > 16.7 ms walking town → fields on Medium |
| TT-Q | Medium detail + anti-tiling ≤ +0.15 ms GPU at the dirt and plaza spots; 0 new draws; WebGL2 units ≤ 16 (14) |
| T12-M | merged tree draws = wave 10's at the bench spots (± 0); caster draws unchanged; at the heaviest region (24999) worker ≤ 15 ms, every main-thread job ≤ 2 ms, no frame > 16.7 ms walking; the caster arrays from the worker |
| T12-N | overlay draws ≤ 2 × species in band 0; refill ≤ 0.1 ms at 1,600 resident placements; never a thin-instance mesh visible at count 0 |
| T12-W | VDATA + BAND ≤ +0.05 ms GPU; `wgslInterStageCount` of the Medium leaf material unchanged (user varyings ≤ 15) |
| T12-A / T12-B | per species the tier caps, bounds ±10 % of the retail envelope per tier, the trunk base within 0.3 m of the retail trunk base, `far.glb` ≤ 60 KB geometry + its sprites once, `near.glb` ≤ 150 KB without images; per sprite luminance ±2 % / saturation ±5 %; per family crown luminance ±10 % of retail in game |
| Trees together | Medium plaza and crowd p95 ≤ the wave-11 gate + 0.5 ms; High + 0.8 ms |
| Terrain together (G-TT) | Medium p95 at the plaza, fields and meadow within + 0.3 ms of the wave-11 gate; High WebGPU texture VRAM at the plaza ≤ the wave-11 gate + 250 MiB (plane arithmetic primary; `bench.js` moves ± 100 MiB) |

### 5.4 LAB-12 method

The wave-10 / wave-11 gate method: the production bundle on a private `vite preview` (a free port, stopped after), a
private server on a **temporary data folder** with throwaway GM accounts (or a temp copy of `work/server/game.db`),
1920 × 1080, hardware scaling 1, a 60 Hz timer pump (the pane is hidden), 400 uncapped frames after streaming idles and
no shader compiled for 3 s, `prof.js` once per page, WebGPU `uncapturederror` hooked, the GPU lock held, **a quiet
machine** (no other agent's build, test or GPU batch: the editor's page never open in the pane meanwhile, WF13).
Scenes:

1. **plaza noon, 20-mob crowd + 20 jumping bots + the town** (G1's thin scene; 4 repeats; trees new / retail A/B through
   `graphics.trees`; the crowded-plaza rule on / off);
2. plaza noon nobody; the crowd; fields night; the user's meadow (`/tp 114 93`); the south beach at noon (the G6 view);
3. the pine forest (north) and the willow corner in town (the tree rows of TREES §W5.2, re-run: the old CPU rows are
   not evidence, WF13);
4. TERRAIN_TEX's dirt spot (wide) and road (wide), Medium detail + anti-tiling on / off (the [likely] made [confirmed]);
5. the Tiger fight at a camp with 20 bots (the trees in its view);
6. walking town → fields on Medium and High (hitch watchdog: no frame > 16.7 ms; the heaviest region 24999 landing);
7. presets: Medium on both backends first, then High (WebGPU, WebGL2) and Ultra (WebGPU); `?gpuLimits=default` once;
8. the editor: one scripted Publish on a fixture edit (staging export only), its bench, the brush and upload timings.

One results file: `work/tmp/w12-lab/budgets.md`, copied to Dropbox `wave12/budgets.md`.

### 5.5 The gates (the 60 fps rule)

- **G1:** Medium p95 < 16.7 ms on both backends in every LAB-12 scene **including the plaza with 20 players plus the
  crowd and the town** and the 20-bot fight, with the new trees and textures and every feature on.
- **G2:** High WebGPU ≤ 12 ms at the plaza and ≤ 14 ms in the 20-mob crowd; WebGL2 Medium and High ≤ 8 ms at the plaza.
- **G3:** no scene slower than its G-11 number by more than this plan projects: trees ≤ + 0.5 ms Medium / + 0.8 ms
  High, terrain ≤ + 0.3 ms (G-TT); High WebGPU texture VRAM ≤ G-11 + 250 MiB (terrain) + 75 MiB (2× sprites).
- **G4:** component gates: the Low guard; `material-budgets.test.ts` (≤ 16 WebGL2 units on Medium, ≤ 15 varyings +
  `front_facing`, ≤ 256 layers); 0 WebGPU validation errors; no GLSL on WebGPU; no new varying (trees); merged tree
  draws per region = wave 10's; overlay draws ≤ 2 × species in band 0.
- **G5 (look):** every terrain set passes the three gates (grain ≥ 60 % at 512, colour ±3, in-game −3) or ships at a
  documented fallback step; every tree family's crown luminance in game is within ±10 % of retail; every sprite within
  ±2 % luminance / ±5 % saturation.
- **G6 (Mac margin, new for the whole wave; from WORLD_EDITOR F21):** the dev GPU p50 (WebGPU timestamps) at Medium may
  grow over G-11 by at most **0.15 ms in the beach view** and **0.4 ms elsewhere**, trees and terrain together (≈ +1.5 /
  +4 ms on a base M1). A miss turns on cut 13 (Medium detail + anti-tiling off on Apple GPUs and iGPUs) before anything
  else.
- **G7 (editor):** an empty edit layer exports byte-identical files; the incremental convert's output equals the full
  convert's for the touched files (byte compare, `nav-objects.bin` included); undo / redo bit-exact; a scripted Publish
  stops on a trap fixture and on a lost-reachability fixture; Deploy refused with dirty converter code.

A feature that breaks G1 on a preset ships **off** on that preset or is cut (§7). A G2 miss blocks the feature on High
(it falls back to Medium's setting) but not the release; G5 blocks the family or tile until it passes (a tile at its gate's
fallback route is a pass; a tree family goes another tuning round, and the release waits for every family, §7); G6 and G7 block
the release until fixed or cut; the numbers go to the user.

---

## 6. Steps and lanes

### 6.0 Step order and concurrency

```
(now)    wave 11 builds, gates, verifies, deploys (its own workflow)   | T12-A tool + 4 prototype species (new files, Blender): start at once
                                                                       | GPU Q0: TT-B's SDXL check on 3 prototype tiles (scratch), only when wave 11 holds no lock
step 0:  W12-P (shared + nav) | W12-SA (world-render objects) | W12-SB (world-render ground) | W12-CV (converter) | W12-G (game + server)
         -- all from the wave-11 final commit
step 1:  editor:  WE-D (after W12-P, W12-CV) | WE-N (after W12-P) | WE-I (after W12-CV) | WE-A (after W12-P) | WE-U (after W12-SA, W12-SB, W12-P)
                  | WE-R (after W12-SB, W12-G)
         terrain: TT-B (overrides, gates, the B3 runs on the GPU queue: Q1, Q2) | TT-Q (after W12-SB)
         trees:   T12-M (after W12-SA, W12-CV) | T12-N (after W12-SA) | T12-W (after W12-SA) | T12-A (B1 data, manifest step)
                  | T12-B B0 (GPU Q1) | T12-L look A/Bs (the crown cause, before B1's review page)
         ── checkpoint X1: B1 species + the B3a/B3b sets + an empty edits pass; convert + optimize; byte checks ──
step 2:  T12-B B2, B3, B4 (+ review shots, GPU Q3) | T12-E | WE-L (after T12-E) | WE-T (wave-11 files, committed) | T12-L panel
         TT-R (stream.ts, tile-atlas.ts; GF-R's verdict is in) | TT-B B3c + retunes | WE-A/WE-U: Publish report, Test in game
         ── checkpoint X2: full re-convert + full optimize; WE-I byte compare; 88 sets, 35 species, 0 retail trees left on Medium+ ──
step 3:  I-12 (merge, §6.4) → LAB-12 (§5.4, GPU Q4) → H-12 (§6.7) → F-12 (§6.8) → G-12 (§6.9, GPU Q5) → V-12 (§6.10)
         → the user's checks (§8) → deploy only on the user's new OK
```

### 6.1 The GPU queue (one lock, never two GPU jobs at once)

| Slot | When | Job (owner, label) | Length | Needs |
|---|---|---|---|---|
| Q0 | now, only between wave-11 GPU jobs | DT-2 SDXL on the prototype's road, rock, moss tiles (TT-B, `TT-B sdxl-check`), scratch outputs only | ≈ 15–30 min | ComfyUI start/stop scripts; answers TERRAIN_TEX Q1 before the real run |
| Q1 | step 1, day 1 | TP-U Real-ESRGAN on all 88 tiles + the retunes (TT-B, `TT-B tpu`), then B0: every retail foliage sprite at 4× → retail-size + 2× tiers, colour-matched (T12-B, `T12-B b0`); two takes back to back | ≈ 10 + ≈ 3 min | nothing else on the GPU |
| Q1b | step 1 | TP-P / TP-E encodes (CPU, but they write `work/out/pbr/index.json`): B3a, B3b, then B0's tiers; as queue items so index merges never race (D7) | ≈ 1 min per tile batch | — |
| Q2 | step 1, overnight | DT-2 SDXL on the 10 B3a paving / rock / moss tiles kept by Q0 (TT-B, `TT-B dt2`), then their TP-P / TP-E | ≈ 45 min typical, ≤ 2.5 h | the machine otherwise idle; the editor not rendering |
| Q2b | step 1, after Q2 | the in-game luminance gate shots for B3 (TT-B, the preview overlay method of TERRAIN_TEX §8.2, 6 spots + a coast-filler spot) | ≈ 20 min | a private preview + server |
| Q3 | step 1 (B1) and step 2 (B2, B3, B4) | the per-batch in-game before/after + crown luminance (T12-B, `T12-B review Bn`), and T12-L's crown A/Bs before B1's page | ≈ 20 min each | the lab page, one tab |
| Q4 | step 3 | LAB-12 (§5.4) | ≈ 2–3 h | a quiet machine |
| Q5 | step 3 | G-12, then V-12's three cells | ≈ 1.5 h + 20 min | a quiet machine |

Rules: bench slots (Q4, Q5) pre-empt everything not yet started; a running SDXL batch is never killed for a bench (a
bench waits; SDXL runs overnight so it rarely has to); no slot runs while wave 11 holds the lock; Blender (T12-A,
T12-B's generate step and sheets) and Cycles CPU need no lock.

### 6.2 The lanes

Effort: agent-days (≈ ½ day per agent session).

| Lane | Owns (files) | Seams it uses | Tests | User check | Effort |
|---|---|---|---|---|---|
| **WE-D** edits pass | `packages/convert/src/world/edits/**` except `nav-edit.ts` and `checks.ts`: read layers, `editsSource`, placement edits as drop + add, water, light points, zones export, grass mask files, the minimap redraw (the coast's dropped-footprint rule), the **lightmap bake with object shadows** (heightfield + LOD0 triangles, the species' LOD1 for swapped models, D18; leaves cut at 0.5; node-free so the editor's worker runs it too) | W12-P, W12-CV | determinism (two converts, same bytes); the coast checks unchanged; props snapped / listed; a moved fixture tree leaves no shadow texel at its old spot and casts one at the new spot | the 400 m view: no ghost shadow, a shadow under a planted tree | 4.5 |
| **WE-N** nav + checks | `world/edits/nav-edit.ts`, `world/edits/checks.ts`, the report JSON | W12-P | the dry run's numbers as a fixture (the rule as written: 117 of 443 closed); closed tiles carry the blocked flag; nests / NPC / probe reachability; no new traps; budgets per region | — | 2 |
| **WE-I** incremental | `tools/convert-region.ts` (`--only <regions>` + the 1-ring), `optimize-out.ts` `--files` + the `slim.json` merge, the `nav.bin` / `nav-objects.bin` / chunk splice, the pre-pass placement cache reader | W12-CV | incremental = full for the touched files (byte compare at X2); `slim.json` untouched entries identical | — | 2.5 |
| **WE-A** API + Publish | `apps/viewer/editor-api/**`, `apps/viewer/vite.config.ts` (the `editor.html` entry, :5185 strict, own cacheDir), viewer `package.json`, `work/editor/` shortcut; token / Origin / Host checks, the lock, atomic I/O, the journal, Publish orchestration (calls `texpipe hero`, D7), staging `jangan-fields-edit`, per-file swap with backup, Test in game (private server on a DB copy + a private game Vite), the pathspec commit, the assets-only Deploy hand-off and its refusals | W12-P, WE-I, WE-N, TT-B's `texpipe hero` | API rejects bad origin / host / token; atomic writes; journal replay; Deploy refused with dirty or undeployed converter code; Publish never touches `work/out` while the convert lock is held | Publish + Test in game | 3 |
| **WE-U** editor page | `apps/viewer/editor.html`, `apps/viewer/src/editor/**` (except `library/` and `town/`), `content/world-edits/jangan-fields/palette.json` (108 rows by surface) | W12-SA, W12-SB, W12-P, WE-A | brush maths on the lattice (seams bit-identical), deltas snapped to 1/256 m, undo / redo exact, revert-one, render on demand | the ten-minute session | 4.2 |
| **WE-R** runtime | `apps/game/src/audio/zones.ts`, `world/features/sound-zones.ts` | W12-SB (points, masks), W12-G (stub) | zone voice cap (≤ 2; ≤ 1 beside wave 11's town loops); Low ignores masks | listen to one zone | 1.5 |
| **WE-L** library | `apps/viewer/src/editor/library/**` (classification, thumbnails bake, the Trees tab from `library.json` through T12-E) | WE-U, T12-E | every model classified; every species has a carrier; thumbnails cached outside git | the library looks right | 1 |
| **WE-T** town | `apps/viewer/src/editor/town/**`, the `manual` overlay in `content/town/jangan.json` and its application in `packages/convert/src/town/build-graph.ts`, dressing rows by id in `jangan-dressing.json` | wave 11's TL-R file and `validateTownFile` (committed) | edges on the navmesh; a `town-graph` rebuild keeps every manual edit | move a bench, watch a townsperson sit | 2 |
| **TT-B** terrain batch | `content/texpipe/overrides.json` (B3 rows: hero, routes, per-family prompts, the painterly rule, the retunes; the merged tree fragment), `packages/texpipe/**` (`terrain-spots.ts` new, the three gates and the terrain sheet / 3×3 repeat in `review.ts`, `cover` in `format.ts`, the `hero` verb in `cli.ts`), its outputs in `work/out/pbr/tile2d/**` + the index | the texpipe CLI, the GPU queue Q0–Q2b | `terrain-gates.test.ts` (one pinned grain metric on a synthetic tile, the colour lock, the fallback steps); the inventory counts 108 tiles and 88 B3 sets; `validatePbrIndex`; every file exists; `texpipe hero` flips the index without a re-encode | the 6-spot Medium before/after sheet | 1.5 (+ GPU hours) |
| **TT-Q** Medium shading | `render/quality.ts` (Medium: detail + anti-tiling; High: anti-tiling), the no-anti-tile bit in `pbr/classes.ts`, the one `layerData` line in `terrain.ts`, the `& 63` masks in `shaders.ts` and `pbr/terrain-plugin.ts`, the `sroTilesHi` second tap under `SRO_T_TIER` | W12-SB (D5), RENDER §6.2 | `material-budgets.test.ts` (≤ 16 WebGL2 units on Medium: 14); the plugin define tests; `pbr-classes.test.ts` (bit round trip, class unchanged for every tile); the paving opt-out; `seams-classic` | the plaza paving and a dirt field from the wide camera | 1 |
| **TT-R** set range | `packages/world-render/src/stream.ts` (`tileSetup`: "has maps under the policy", the depth), `tile-atlas.ts` (the last 8 range layers reserved for above-median cover), the runtime `PbrSet` reader of `cover` | W12-SA's `stream.ts` edit landed (D4); TT-B's `cover` | `tile-atlas.test.ts` (hero-only range; a non-hero set keeps its set albedo above the range; a below-median tile never takes a reserved layer; planes mipped at min(48, hero)); `p-look.test.ts` green; the Low guard | walk town → fields on Medium and High; the far fields on `?engine=webgl` | 1 |
| **T12-A** tree tool | `packages/convert/src/trees/**` (`blender/make_species.py`, `blender/render_sheet.py`, `upscale.ts`, `build.ts`, `validate.ts`, `cli.ts`), `world/trees-manifest.ts` (the species as models, `treeSwap`), `content/trees/{species, swap.json, library.json}` for the 4 prototype species | W12-CV's stubs and verb | `trees-validate.test.ts`, `trees-swap-data.test.ts` (every source in the manifest; tufts and unique trees absent; every `treeSwap` points at a species), `trees-upscale.test.ts` (mean within 2 %, spread within 5 %) | `pnpm trees build --family maple` | 1.5 |
| **T12-M** merge | `batch/trees.ts`, `batch/merge-core.ts`, `model-cache.ts` (`uvs3`), `batch/merge-worker.ts`, `batch/region-batch.ts` (`!sroTree` in the cloth count), `render/shadows.ts` (the worker's tier-1 caster arrays) | W12-SA's swap source and S-SCALE; T12-N's slots | `batch-trees.test.ts` additions (a swapped model merges the species tiers and never fetches the retail glb; `sroPivot.w` = slot × 4 + tier; `sroTreeW` within 1/255; `uv2` = the white quadrant; the caster takes tier 1 only; draws per region unchanged; `cj_ricestraw` with `treeSwap` is a tree claim; `clothGroups` unchanged on dispose) | the plaza's maples and the pines new at every distance | 2 |
| **T12-N** bands + overlay | `packages/world-render/src/trees/{swap, bands, near-field, index}.ts` (slot free list by uid, the band texture, the 4 m refill with 3 m hysteresis, the overlay per species × leaf/wood, the per-instance tint, **the crowded-plaza rule**, D24) | W12-SA's slot | `tree-bands.test.ts` (bands × rangeScale, hysteresis, band 3, the crowded rule at 14 / 15 players); `near-field.test.ts` (overlay = band-0 slots; a region removal frees slots; empty set hidden) | walk 200 m → the plaza: no double, no gap | 1.5 |
| **T12-W** shader | the `SRO_FOL_VDATA` and `SRO_FOL_BAND` chunks in `pbr/foliage-plugin.ts` (WGSL + GLSL) | W12-SA's skeletons (D8) | both languages same keys; the TS mirror of the bend = the shader; the collapse leaves zero-area triangles; BAND with weather absent and wind off; `wgslInterStageCount` unchanged | a storm: branches lag, reeds sway like the retail clips | 0.5 |
| **T12-B** batches | `content/trees/species/*.json`, `swap.json` and `library.json` rows, `out/trees/*`, `content/trees/texpipe-rows.json` (D7) | T12-A; the GPU queue Q1, Q3 | the validator; per batch the lab rows (draws, triangles, luminance) | one review page per batch (B1 after T12-L's A/Bs) | 2.5 |
| **T12-E** editor seam | `packages/world-render/src/trees/editor.ts` (`library()`, `preview()`, `setHidden()`) | T12-N; W12-SA's S-OBJ | `trees-editor.test.ts` (preview hides the merged copy and shows one overlay instance; drop re-merges; revert restores) | place, move, delete, revert a pine | 0.5 |
| **T12-L** lab + options | `apps/viewer/src/world/trees-panel.ts` (`?trees=new\|retail`, the band view, counters), the crown A/B harness (`work/tmp/trees/w12/lab/` ported), the `graphics.trees` default tuning in `settings.ts` | T12-N stats; W12-G | a toggle rebuilds without leftovers | Options → Graphics → Trees: New / Retail | 0.5 |

Totals [projected: `budget.py`]: editor ≈ 29 agent-days (WE-P/S/CV folded into W12-P/SA/SB/CV), terrain ≈ 4 + GPU
hours, trees ≈ 9.5, integration to verify ≈ 8: **≈ 50 agent-days**, most of them in parallel lanes.

### 6.3 Seams each lane may not cross

- After step 0 no lane edits `world.ts`, `batch/types.ts`, `objects.ts`, `ambient-fx.ts`, `life/spawn.ts`,
  `town/fx.ts`, `night-lights.ts`, `water.ts`, `grass/bake.ts`, `packages/nav/**`, `manifest.ts`, `convert-world.ts`,
  `passes.ts`, `cli.ts`, root `package.json`, `settings.ts` (beyond T12-L's default), `hud/options.ts`, `gm.ts`: a
  lane that needs more asks I-12, which adds the seam in its own commit.
- `stream.ts` is W12-SA's in step 0 and TT-R's in step 2 only; `terrain.ts` W12-SB's in step 0 and TT-Q's after; the
  batch files T12-M's after step 0; `foliage-plugin.ts` T12-W's after step 0; `overrides.json` and `packages/texpipe`
  TT-B's only.
- No lane edits wave 11's files except WE-T's three (D12), after the wave-11 commit.
- No lane writes `work/out/` outside the convert lock and the GPU queue; no lane runs the editor's Publish on the main
  export (D37); no lane starts or stops the user's dev servers (:5180, :7000, :5173).

### 6.4 Merge order and checkpoints (I-12)

1. Step 0: W12-P → W12-CV → W12-SA → W12-SB → W12-G. Suite + typecheck; record the test count.
2. Trees: T12-A → T12-M → T12-N → T12-W → (X1: B1) → T12-B B2–B4 → T12-E → T12-L.
3. Terrain: TT-B (overrides, the B3a/B3b sets) → TT-Q → (X1) → TT-B B3c + retunes → TT-R.
4. Editor: WE-D → WE-N → WE-I → WE-A → WE-U → WE-R → (after T12-E) WE-L → WE-T.

The chains touch disjoint files after step 0 and may interleave; the order inside each chain is fixed. After every
merge: the Low guard, typecheck, `material-budgets.test.ts` if a material or define changed.

### 6.5 Cross-item tests I-12 adds

- A planted tree (an editor add of a species carrier) is drawn as the species on Medium, the retail carrier on Low and
  with `graphics.trees: 'retail'`, keeps its footprint in `nav-objects.bin`, and casts a baked ground shadow from the
  species' LOD1 (D18).
- A painted B3c tile past 0.1 % cover becomes hero through `texpipe hero` and gets its maps on Medium after a reload;
  the paving bit survives a paint stroke (D5).
- An editor height edit under a merged tree: the tree re-snaps, the band byte is not left at 3 after an undo or cancel.
- A live Low ↔ Medium switch with all three items leaves no overlay mesh, band texture, editor-owned clone or mask.
- The batcher's draws per region are unchanged with the swap on (BT-T fixtures + the swap); the cloth counter is
  unchanged after a tree group's dispose (WF8).
- An empty edits layer: X2's export equals X1's for every region the trees and tiles did not change (G7).
- The 20-player plaza fixture: with 15 players in range the overlay draws only within 20 m (D24).

### 6.6 I-12: integration checklist (the lead)

1. Merge per §6.4; suite, typecheck and the Low guard after each merge.
2. X1 and X2 (D26) under the convert lock; check: 35 species in the manifest, every swapped retail model carries
   `treeSwap`, none of the 5 unique trees or the 695 tufts does; 88 new sets, 63 hero; the merged texpipe fragment
   validates.
3. The editor on a staging export: a scripted session (raise, paint, place a pine, move a lantern, undo, revert one),
   Save, Publish (the report, the bench trigger), Test in game on a private server with a temp DB copy; the trap and
   lost-reachability fixtures stop Publish; Deploy refuses (the code is uncommitted).
4. Two browser clients (WebGPU and `?engine=webgl`): the same trees at the same tiers at the same spot; the far fields
   without blotches on WebGL2.
5. LAB-12 (§5.4); a G1 miss goes to §7 before release; G2 / G6 to the user.
6. Before / after shots at the bench spots (noon, dusk, night, rain), one per tree family and one per terrain spot, for
   the user (Dropbox `wave12/`).
7. Docs: RENDER.md (the band byte, the overlay, the hero range, Medium shading), BATCHING.md (the swap in BT-T,
   S-OBJ), TERRAIN.md / TEXPIPE.md (B3, the gates, `texpipe hero`), COAST.md §6 (the edits pass after the coast),
   NAVIGATION.md (the nav rule, S-NAV), DEPLOY.md (the editor's assets-only deploy, the +171 MB), BACKLOG (wave 12 done,
   §11's deferred list), PLAYTEST.md (§8's checks), each spec's status, a short editor user guide (`docs/EDITOR_GUIDE.md`,
   plain English: start, tools, undo, Publish, Deploy).
8. Scratch: delete `work/tmp/terrain-tex/{texpipe*, pbr-*}` (≈ 1 GB) after TT-B ports the method, `work/tmp/world-editor/`
   prototype page after WE-U; keep every shot the user reviewed.

### 6.7 H-12: the hunt (read-only; findings become tests, then F-12 fixes)

The specs' own risks and fact-check lists stand. H-12 runs these lenses with all three items on, each by a separate
agent or pass, and files each finding with a failing test or a reproduction:

1. **Editor data loss:** a crash mid-Save, two tabs, the lock left behind, a journal at its cap, revert of a change
   whose base hash moved (a coast re-run), undo after a Publish.
2. **Publish safety:** traps, lost reachability, a probe cut off, a stroke past the sea mask or the bounds, the tomb
   keep, a uid collision, a dressing row moved by uid; Publish racing a convert; a partial swap on Windows (EBUSY).
3. **The editor's reach:** the API from another origin or host header, without a token, writing outside its folders;
   `/editmap` on the live server; the editor reachable from the LAN.
4. **Ghost shadows and minimap:** a moved building, a deleted tree, a planted tree on Low and on Medium beyond 60 m.
5. **Incremental drift:** incremental vs full outputs; `slim.json`; the nav chunks; a second Publish on the first's
   output; the pre-pass cache stale after a full convert.
6. **Trees: double or missing:** a retail tree behind a new one (a missed swap), merged + overlay both visible or both
   missing at a band edge, band 3 left after an editor cancel, a skinned model still animating, LOD2 outside LOD1's
   silhouette, a world without weather or with wind off drawing LOD1 and LOD2 together (WF9).
7. **Trees: look:** crowns outside ±10 %, the tint offset wrong, sprites on Medium at 2×, the willow's map set missing.
8. **Terrain: look:** a tile darker than −3 levels in game, grain lost on gritty soils, paving with anti-tiling smear,
   a B3c tile painted large without maps, the High tier diluted by the 512 second tap.
9. **Set range overflow:** walking out of town at the unload radius (58 hero tiles), which tiles lose maps, no black
   layer, no hitch when a reserved layer fills.
10. **Hitches:** the heaviest region (24999) landing on High (the caster build), the first new tree in band 0 (no
    compile), a region re-batch from the editor, a 1024 tier upload; leaks on world → select → world ×3.
11. **Black WebGPU frame / validation:** trees + terrain + town + the editor's gizmo in one view; `?gpuLimits=default`;
    a 16-varying adapter; WebGL2 sampler units with the vertex band sampler plus night + rain + clouds.
12. **Low changed** by any item (the Low guard plus a pixel diff of the plaza and a field on Low).
13. **Nav and trees:** a trunk off its nav footprint (trunk base > 0.3 m from retail), a scaled tree blocking more than
    it shows, a moved tree whose footprint stayed.
14. **Memory on 8 GB Macs:** Medium VRAM at the plaza and walking (merged geometry + the ORMH plane), Ultra on WebGPU.
15. **The crowded plaza:** 20 players + crowd + town + trees on Medium, both backends; the crowded rule's switch at
    15 players flickering.
16. **Deploy path:** the editor's Deploy mid-wave (must refuse), the wave deploy list (+171 MB, new folders,
    `content/world-edits` empty but present, the retail foliage glbs kept).

### 6.8 F-12: fixers

One fixer per file set (the owning lane's files, or I-12 for seam files), each fix with the test H-12 wrote; no fixer
edits another's files. Fixes that change a frame cost are re-measured on the affected LAB-12 scene before G-12; a fix
that changes the export runs X3.

### 6.9 G-12: the final gate

A re-bench of every §5.4 scene on the final tree and the final export (X2 or X3), on a quiet machine, under the GPU
lock; `work/tmp/w12-lab/budgets.md` updated with "final gate" numbers; G1–G7 judged (§5.5). The suite, typecheck and
the Low guard green. Any G1 miss → §7 cuts, then G-12 again.

### 6.10 V-12: the independent verify

A fresh agent that built nothing in this wave:

- re-reads this plan, the three specs and the diff, and checks each never-cut item (§7) is present and each decision of
  §2 is implemented as written (file owners respected: `git log --stat` per lane);
- re-runs the suite and typecheck, re-derives three G-12 cells under the GPU lock (the 20-player plaza Medium WebGPU, the
  beach GPU p50 for G6, High WebGPU texture VRAM at the plaza);
- counts in the export: 0 retail foliage models drawn on Medium+ except the 5 unique trees and the hidden tufts; 108 of
  108 tiles with a set; the Meshy ledger against NIGHT_LOG;
- checks the deploy list (the new sets, `out/trees`, the manifest fields, `content/world-edits`) against `deploy/`;
- reports [confirmed] / [failed] per item to the lead; nothing ships on a [failed] never-cut item.

---

## 7. Scope-cut order (cut from the top; one list for the wave)

Each item names its spec's cut. Items marked **ask first** are cut only after telling the user. The specs' own cuts
that would break the user's "all" (TERRAIN_TEX cut 5 "B3c keeps retail tiles"; TREES cuts 3, 4 and 8 "B4, flowers and
water plants, B3's plants stay retail geometry") are **removed** [decision, D38]: they move to the never-cut list, and
cheaper cuts inside them replace them (items 9 and 12).

1. TT-K, KTX2 terrain arrays (TERRAIN_TEX cut 1; not scheduled).
2. SDXL variety sprites for trees (TREES cut 1; default none anyway).
3. Sound zones (WORLD_EDITOR cut 1; the content file stays defined).
4. "Test in game" (WORLD_EDITOR cut 2; Publish + restart a local server instead).
5. Bark PBR maps (TREES cut 2; the upscaled bark albedo stays).
6. The editor's free light points (WORLD_EDITOR cut 3; lanterns from the library still light).
7. DT-2 SDXL on B3a (TERRAIN_TEX cut 2; the 10 tiles go GAN + the painterly rule).
8. Town routes and seats in the editor (WORLD_EDITOR cut 4; edit with TOWN_LIFE's script).
9. **Species count inside a family:** B4 Dunhuang's 5 species collapse to 2 (`dh_poplar`, `dh_brush`), the weeds' 4 to
   2 (`weed_tall`, `weed_mid`): every family is still replaced, with less variety [replaces TREES cut 3].
10. The Noise brush; the reserved range layers (hero-only stays) (WORLD_EDITOR cut 5, TERRAIN_TEX cut 3).
11. The Publish bench of starred views (keep the guardrail counts) (WORLD_EDITOR cut 6).
12. **Per-vertex flex for plants** (TREES cut 7): the plants' new geometry keeps a skinned clip only where a retail clip
    exists, the rest the h² bend [replaces TREES cuts 4 and 8].
13. Medium detail layer + anti-tiling **on Apple GPUs and iGPUs only** (the G6 lever; Medium desktops keep them).
14. The thumbnail bake and the editor's live lightmap preview (names + the TL-K thumbnails; the converter still bakes at
    Publish) (WORLD_EDITOR cuts 7, 8).
15. The editor's live drag preview for trees (place / move / delete with a re-merge on drop) (TREES cut 5).
16. Scale for non-tree models (S-SCALE serves trees only) (WORLD_EDITOR cut 9).
17. The crowded-plaza rule at 0 m: no LOD0 overlay on Medium with ≥ 15 players in range.
18. The LOD0 overlay on Medium entirely (merged LOD1 near: 0 extra draws) (TREES cut 6); if G1 still misses, wave 11's
    cut 20 (no townsfolk drawn on Medium with ≥ 15 players).
19. Anti-tiling on High; the paving bit (anti-tiling then Ultra-only, Medium keeps the detail layer) (TERRAIN_TEX cuts 4, 6).
20. Incremental optimize (fall back to the full 15-minute optimize at Publish) (WORLD_EDITOR cut 10).
21. Water; grass and flower painting; multi-select and copy / paste (WORLD_EDITOR cuts 11–13).
22. **Ask first:** the Medium detail layer everywhere (TERRAIN_TEX cut 7).

**Never cut:**

- **The editor:** the Raise / Lower / Smooth / Flatten brushes; texture paint; place, move, turn, delete from the
  library with ground snap; undo / redo / revert one change / revert a region; Save; **a Publish that rebuilds walking
  and stops on traps or lost reachability**; the object-shadow bake at Publish (no ghost shadows); assets-only Deploy
  only on the user's click; the editor never shipped to players.
- **Every terrain tile upscaled:** B3a, B3b **and B3c** (all 88), the painterly rule and its gates (a tile may ship at
  its gate's fallback step, never retail), the hero-only set range.
- **Every tree family replaced:** B0 (every foliage sprite upscaled, incl. the 5 unique trees' sprites), B1–B4 with
  plants (weeds, reeds, barley, flowers, water plants, graveyard grass); the swap keyed by the retail source with
  placements, nav and ranges unchanged; the crown luminance gate.
- **Everywhere:** the Low guard; ≤ 16 WebGL2 units; ≤ 15 varyings + `front_facing`; no new varying; ≤ 256 layers; no
  GLSL on WebGPU; 0 WebGPU validation errors; **G1 (Medium at 60 fps, the 20-player plaza included)**; G6.

---

## 8. What the user must provide or approve

**To start: nothing.** Every tool is installed, nothing is downloaded, Meshy is planned at 0 credits, and every item
has a default.

1. **The preview sheet** `work/tmp/w12-preview.png` (Dropbox `wave12/w12-preview.png`): the editor prototype, the
   terrain before / after, the new trees before / after, the budgets. **Default:** build as shown.
2. **The tree look direction** (`work/tmp/trees/w12/before_after_ingame.jpg`, `review_sheets.jpg`): the crowns are
   25–48 % darker than retail today; no family ships until it is within ±10 %. **Default:** proceed with the fixes.
3. **After the build, about ten minutes in the editor** (desktop shortcut): raise a hill, paint a path, plant three
   trees, move a lantern, undo, revert one change; then Publish, read the report, "Test in game". Say what feels
   clumsy. **Default:** the build's defaults.
4. **One terrain sheet** (6 spots, Medium, today vs remaster) and **one page per tree batch** (B1–B4). **Default:** the
   gates decide; a family or sheet you do not answer on ships once its gates pass.
5. **GPU time:** ≈ 45 min (≤ 2.5 h) of SDXL overnight for 10 terrain tiles. **Default:** overnight, under the lock.
6. **Meshy:** **Default:** 0 credits; ≤ 90 only if you reject the Blender-built dead trees, ≤ 120 only if the last
   Dunhuang stumps hold up the release; never more than 600; every job logged.
7. **The deploy OK for wave 12** (a new one; the wave-11 OK does not cover it). **Default:** nothing deploys until you
   say so; the wave adds ≈ +171 MB on the server and High WebGPU players use ≈ +0.3 GB more video memory.
8. **A friend's Mac and a gaming laptop:** one plaza run and one field run. **Default:** ship on the dev PC's numbers
   with the G6 Mac margin; cut 13 is ready.

---

## 9. Risks

| Risk | Default handling |
|---|---|
| The 20-player plaza crosses 16.7 ms on Medium (wave 11's town took most of the margin; trees + ≈ 0.3) | LAB-12 against G-11's measured number; the crowded-plaza rule (D24); cuts 17–18 |
| The crowns stay darker than retail (25–48 % today) | T12-L's A/Bs split the cause before B1's page; the levers in order (normals rule, map set, back cards, gain ≤ ×1.3); the gate blocks the family (it ships at B0 sprites on retail geometry meanwhile, then its next round) |
| +235 MB on High WebGPU on a 6 GB card | fits the friends' 6–8 GB GPUs [likely]; TT-K is ready as a later lane; the overflow degrades gracefully (maps and tier lost, never the albedo) |
| The wave-11 build slips | step 0 waits; T12-A and the Q0 SDXL check run meanwhile; the design is not lost |
| Two GPU jobs collide (the design phase deleted a lock once) | one queue, `locked.sh`'s pattern, bench pre-emption rules (§6.1, D27) |
| A map Deploy mid-wave ships half-built converter code | assets-only, refused with uncommitted or undeployed converter code (WORLD_EDITOR D36) |
| Incremental convert drifts from the full convert | the byte compare at X2 (G7); a full convert at every release gate |
| Ghost shadows from moved objects | WE-D's object-shadow bake (never cut); H-12 lens 4 |
| The swap misses a model or doubles a tree | `trees-swap-data.test.ts`; V-12's count of retail foliage drawn on Medium+ |
| Seams with wave 10/11 code (cloth counter, wind-gated pivot, `TEXCOORD_1`) | W12-SA, T12-M and T12-W own the fixes and tests (WF8–WF10) |
| A heavy edit costs Mac friends 60 fps | the guardrails, the Publish bench with G6's margin |
| Gritty soils fail the grain gate even at the fallback | the `retail` route is the last step: still an upscaled, de-lit set (76 % grain kept), never the raw retail tile |
| Merged geometry on 8 GB Macs (+28–40 MB) | `unorm8x4`, the sight option, the caps; H-12 lens 14 |
| TREES' CPU rows were measured under a disturbed pane | LAB-12 re-runs them; nothing was decided on them |

## 10. Open questions (each has a default, so nobody waits)

| # | Question | Default | Who settles it |
|---|---|---|---|
| Q1 | May a GM friend edit from their own PC? | no, this PC only (a later wave) | the user |
| Q2 | May the editor change ground inside the town walls? | yes, with the same Publish checks | the user |
| Q3 | Should Publish commit `content/` to git automatically? | yes, by pathspec with a plain-English message | the user |
| Q4 | Editor camera | right-drag orbit, middle-drag pan, wheel zoom, WASD while the right button is held | the user's session |
| Q5 | Deploy map edits while a wave is being built? | no: map edits go out with the next release | the user |
| Q6 | SDXL on B3a worth 45 min–2.5 h? | Q0 decides per tile on the prototype's road, rock, moss: keep only where the High crop is crisper and the gates pass | TT-B |
| Q7 | Painterly rule strength | aiMix 0.5, stepped per tile by the grain gate | TT-B |
| Q8 | Re-run all of B1 under the rule? | only the 3–4 that fail the gate | TT-B |
| Q9 | Tree band distances | 40 / 110 m × rangeScale, plants 25 m, 3 m hysteresis; tuned in the band view | T12-L |
| Q10 | The 5 unique town trees (the "all trees" request) | retail geometry with B0's upscaled sprites (they are partly buildings); a hero-tree remake later on request | the user |
| Q11 | Reeds and water plants keep their clips? | no: static, per-vertex flex; a clip only where the sway cannot match | T12-W |
| Q12 | Impostors for far trees | dropped; only if LOD2 shimmers at 150–280 m in the lab | LAB-12 |
| Q13 | Re-bake every region's lightmap with the new trees' shadows? | no this wave (only edited regions; the species stay within ±10 % of retail envelopes) | the user after the look check |
| Q14 | Medium detail + anti-tiling on Macs | on, unless G6 misses (cut 13) | LAB-12 |

## 11. Deferred

- **Wave 13 (the user):** fishing (+ cooking), swimming, underwater (and the tiles under new water deeper than 1.2 m
  opening when swimming lands, WORLD_EDITOR D30).
- **Not this wave:** KTX2 terrain arrays (TT-K); a macro-variation layer and a sub-2 m detail splat (both need a new
  terrain-plugin seam); a world-wide object-shadow re-bake with the new trees (Q13); retail tiles outside the 108;
  editing from a friend's PC (the in-game route and authenticated writes); tilt for placements; scaled nav footprints;
  impostors; a hero remake of the 5 unique town trees; SDXL variety sprites; bark PBR maps if cut.
- **Still in the queue from waves 10–11** (WAVE_PLAN7 §11): the sky upgrade (SKY2), the intro and login scene, the
  dodge roll, pets / friends / mail, the remaining texture batches for NPCs, mobs, armour and weapons, WebGPU snapshot
  rendering, production asset versioning, the Classic batch (BT-K), MV-L, other uniques, character batching and
  animation LOD for 20 players (BACKLOG item 9, the only fix for the 20-player High misses).

## 12. Housekeeping

- The three specs stay the detailed design; this plan's decisions override them where they differ (D1–D15 in
  particular: the five step-0 agents, the overrides fragment, `texpipe hero`, the species LOD1 in the shadow bake, the
  crowded-plaza rule, the removed "retail stays" cuts). I-12 marks the overridden passages in the specs.
- No lane commits; the lead integrates each step. No lane starts or stops the user's dev servers (:5180, :7000,
  :5173); private servers on free ports with temp data folders or temp DB copies only; at most one browser tab per
  lane, closed when done.
- Every Meshy job (if any) is a NIGHT_LOG row: what, credits, result. The build's Meshy cap is 600 (D30).
- Scratch used by this plan: `work/tmp/w12-plan/budget.py` (the §5.2 arithmetic), `work/tmp/w12-plan/make_preview.py`
  (the preview sheet), `work/tmp/w12-preview.png`.
