# Coast and ocean (COAST)

**Status (wave 10r, built 2026-10-01):** built with the beaches revision: a beach in front of every sea shore (phase 1 east, south, north-east and S1; phase 2 west, north-west and Option A's corridor), no sea cliff, S1 walkable from town through its in-bounds `openTiles` link, the worker-FFT ocean on Medium and the GPU FFT on High and Ultra, shore v1, the coast's sound, ships and gulls. Where docs/WAVE_PLAN6.md decides differently (D11, D19, D27), the plan wins; the X2 look fixes (the sea only in front of S1's waterline, the wandering sand edge, wet sand on tile 154) are in content/coast/coast.json's notes. I-10R: the client reads the
field's G = 0 texels off the sea (retail water that keeps its own plane) as far inland, so the swash rule never draws the
sea over the town's fountain and ponds (it hung over the plaza on the create screen).

The user's request: *"I want to eventually surround the map with an ocean. So the map should have beaches etc at each
end where it doesnt continue to next town."* They added: *"we can use blender mcp to alter the edges of the map etc to
be able to make this happen if needed, later"*.

This spec turns that into a design. Wherever the `jangan-fields` map does not lead on to another town, the land slopes
down to beaches, or falls as sea cliffs where the edge is mountainous, and an ocean runs out to the horizon. A land
connection west toward Donwhang stays possible. On top of the procedural coast, the user (or Claude, through Blender
or a Blender MCP connection later) can sculpt and paint the edges by hand. The converter reads those edits back and
stays deterministic.

It covers:

- what is at the edges of the export today (§1);
- sea level, extent and horizon (§2);
- the coastline, section by section (§3);
- the land corridor to Donwhang (Option A) or an all-round coast (Option B) (§4);
- the converter step (§5) and the Blender round trip (§6);
- materials (§7), ocean rendering on top of wave 9A (§8: Tidewater's FFT ocean and shore, adapted to Babylon),
  navigation and the server (§9), life and sound (§10), and the minimap and world map (§11);
- the build plan after waves 9A/9B (§12), then risks (§13) and **what the user decides (§14)**;
- *(refresh 2026-09-29)* what the refresh changed (§R), what the coast shares with SKY2 and TREES (§8.13), the lanes
  at a glance (§12.12), needs from the user (§15) and open questions with defaults (§16);
- *(fact-check 2026-09-29)* what the adversarial fact-check corrected (§F).
- *(beaches 2026-09-29)* what the "beaches everywhere" revision changed (§B), and the new geometry: beach profiles all
  round, the mountains at the edge lowered, the tomb backdrop rule, retail props on lowered ground, the nav and bounds
  impact, and the Blender workflow (§3B).
- *(beaches fact-check 2026-09-29)* what the adversarial fact-check of the beaches revision corrected (§G).

This is a design document. No file under `packages/`, `apps/` or `content/` was changed. Every prototype, script and
image is under `work/tmp/coast/` (git-ignored). The spec merges two fact-checked study parts: the geography
(`work/tmp/coast/GEO.md`) and the technical design (`work/tmp/coast/TECH.md`). Where they disagreed, §0.2 records the
decision (C1–C20).

**Refresh 2026-09-29.** This spec was written before wave 9 was built. It has now been re-checked against the code
wave 9 actually shipped (the release is "Default Medium, High optional"): the PBR water (`pbr/water-plugin.ts`,
`water.ts`), the weather (`weather/frame.ts`, `WeatherFrame`), the height fog (`pbr/fog-plugin.ts`), the sky cube and
IBL (`render/lighting.ts`, `sky/ibl.ts`), the cloud shadows (`sky/chunks.ts`), the runtime texture loader (TX-R,
`pbr/maps.ts`, `tile-atlas.ts`), streaming (`stream.ts`), the nav and the converter. It also records the user's
decisions (Option A, sea level +5 m, a walkable south beach, Tidewater's ocean), the user's order that the coast is
built **together with the sky upgrade (docs/SKY2.md) as one wave, "sky and sea"**, and the rule that for now new 3D
models are made **for trees only** (docs/TREES.md). Every changed passage carries a "(refresh 2026-09-29)" note; the
summary is §R below. Refresh prototypes, measurements and images are under `work/tmp/coast-refresh/`. No file under
`packages/`, `apps/`, `content/` or `deploy/` was changed.

**Fact-check 2026-09-29.** The refresh was then fact-checked adversarially: every [confirmed] claim was re-derived in
the code, the data, Babylon 9.28's sources and the measurements (the worker-FFT bench was re-run). The corrections are
listed as F1–F16 in §F below, and each changed passage carries a "(fact-check 2026-09-29)" note. The largest are in the
ocean's Babylon plumbing (§8.2: thin instances need a matrix buffer, the depth pre-pass re-runs the material, and
visibility beats enable/disable), the budget arithmetic (§8.11) and two stale numbers (the first-run preset on WebGL2
and the nest count).

**Beaches 2026-09-29.** The user then redefined the next wave (item 2 of their list) and asked for **no sharp edges**:
*"all edges of the map if its near the water it should have a beachy area. So use blender to make this happen."* Their
answers: beaches along **all** of the sea coast and **no sea cliffs** (mountains at the edge are sculpted down in
Blender); inland riverbanks and the lake stay retail **[confirmed: `work/tmp/w9-user-decisions.md`, "the NEXT WAVE,
redefined by the user"]**. Option A, +5 m (Jangan Bay), the walkable south beach and Tidewater's ocean and shore v1
stay as decided. In the same list the user **deferred the sky upgrade and the new tree models**, so the coast no
longer ships with SKY2 or TREES: it ships on wave 9's fog, sky cube and IBL, which §8.13 already made its default.
This revision changes the geometry (§3B, which supersedes the cliff parts of §3), the section table, the placements
rule, the nav and bounds numbers, the Blender part and the lanes, and re-runs the geography prototype with beaches
everywhere. Every changed passage carries a "(beaches 2026-09-29)" note; the summary is §B. Its prototype, scripts and
images are under `work/tmp/coast-beach/`. No file under `packages/`, `apps/`, `content/` or `deploy/` was changed.

**Beaches fact-check 2026-09-29.** The beaches revision was then fact-checked adversarially: its [confirmed] numbers
were re-derived from the prototype's arrays, the export's `nav.bin` and the other specs of the same wave, and the
Blender gully pass and readback were re-run. The corrections are G1–G16 in §G; each changed passage carries a
"(beaches fact-check 2026-09-29)" note. The largest: **the walkable south beach (S1) is not reachable on foot inside
the bounds** (its only nav link to town runs through ring tiles outside them, where the clamp stops players), and the flank
paint rule would have turned most of the lowered mountains to rock instead of grass. Scripts and outputs are under
`work/tmp/coast-beach-fc/`. No file under `packages/`, `apps/`, `content/` or `deploy/` was changed.

## Status tags

- **[confirmed]**: checked in the code or the data for this study, or measured on a prototype; the method is given.
- **[likely]**: follows from the code, the data or the docs, but was not run end to end.
- **[projected]**: a design value, or a cost or count derived from a measurement or arithmetic but not measured on
  the target.
- **[unknown]**: not established; a default is given.

## §R What the refresh changed (refresh 2026-09-29)

| # | Topic | Before (2026-09-28) | Now, and how it was checked | Where |
|---|---|---|---|---|
| R1 | User decisions | Open (§14) | Taken: **Option A**, **+5 m (Jangan Bay)**, **walkable south beach**, the other §14 items as recommended, Tidewater's ocean **[confirmed: `work/tmp/w9-user-decisions.md`, "coast decisions"]**. −2 m and Option B stay only as documented alternatives. | §0.1, §14 |
| R2 | Which wave | Wave 10 "coast", after 9A, beside 9B | **Wave 10 "sky and sea" + new trees**: the coast is built with SKY2 in one wave because they share the haze, cloud shadows, the IBL and the horizon **[confirmed: `docs/BACKLOG.md`, commit `85e2e14`]**. WAVE_PLAN4 merges the lanes. | §12.0, §8.13 |
| R3 | Default preset | High on gaming PCs, Medium on Macs; the ocean's typical view was High | **Medium for every adapter class** (iGPU and Retina Macs at render scale 0.75), High optional **[confirmed: `apps/game/src/settings.ts` `recommendGraphics`, `apps/game/src/rollout.ts` `'on'` in the release working tree]**. So **Medium's worker-FFT ocean is what most friends see**; it gets the look budget first. | §8.4, §8.10 |
| R4 | Depth for the ocean | "the depth renderer on High+ (the one RND-W and SSAO use)" | **There is none.** RND-W shipped without a depth renderer (per-vertex depth in the vertex colour, `water-plugin.ts` header) and SSAO/TAA use the prepass MRT, which holds opaque depth only **[confirmed: code]**. The ocean takes its depth from the coast field on every preset; the depth-buffer swash bead is dropped from v1. | §8.5, §8.6, §8.8 |
| R5 | Join with retail water | "RND-W's shared colour chunk and world-space normal maps" | RND-W has no shared chunk. It has `WaterPbrState` (hue `b`, deep multiplier `c`), a generated normal map (`waterNormalPixels`, 128², layers of 6 m and 17 m in world XZ) and `WATER_SHORE_M` 1.5 / `WATER_FOAM_M` 0.3 **[confirmed: code]**. The ocean binds the same state object and texture at the join. | §8.1, §8.5 |
| R6 | Inter-stage variables | Not considered | A lit PBR CSM receiver already uses 16 of 16 inter-stage variables on a default WebGPU adapter; one more varying drops the whole frame **[confirmed: `render/gpu-guards.ts`]**. The ocean packs everything into **one** vec4 varying, and receives no CSM on adapters with 16. | §8.6 |
| R7 | The game is CPU-bound | Known, High ≈ 13 ms JS projected | **Measured:** WebGPU High fails its p95 in the plaza (17.9 ms) and the crowd (21.5 ms) on CPU draw submission; Medium passes (11.4 / 14.4 ms p95) **[confirmed: `work/tmp/w9-finish/budgets.md`]**. The coast's budget is therefore written in **main-thread CPU ms and draws** first. | §8.11 |
| R8 | Worker FFT cost | 0.5–1 ms per tick [projected] | **0.98 ms median per tick for 2 × 64²**, 2.0 ms for 4 × 64², 4.6 ms for 2 × 128² **[confirmed: `work/tmp/coast-refresh/fft-bench.ts`, Node 24 on the dev PC]**. CDLOD selection 0.022 ms **[confirmed: same bench]**. | §8.4, §8.11 |
| R9 | Weather input | "weather state, blended (clear … storm)" | `WeatherFrame` carries **no state name**, only blended values; `windMs` runs 1 (fog) … 13 (storm) **[confirmed: `weather/frame.ts`, `shared/src/weather.ts` `WEATHER_PARAMS`]**. The swell is driven from `windMs` and `cloudDark`. | §8.7 |
| R10 | Cloud shadows on the sea | "`sroCloudShadow` dims the glint on High" | The extern exists (`SKY_CLOUD_SHADOW_WGSL/GLSL`, sky presets: Medium off, High `ground`, Ultra `all`) **[confirmed]**. The ocean counts as ground. SKY2's volumetric cloud-shadow map replaces the function body behind the same name. | §8.6, §8.13 |
| R11 | Sky cube | RND-L's cube, 32²/64² | Confirmed as built: one CPU-filled `RawCubeTexture` RGBA16F with CPU-prefiltered mips, one face per frame, 32² / 10 s on Medium, 64² / 5 s High, 64² / 2 s Ultra **[confirmed: `render/lighting.ts`, `render/quality.ts`]**. SKY2's GPU IBL replaces it; the ocean only reads `scene.environmentTexture`, so it needs no change. | §8.6, §8.13 |
| R12 | Fog on the ocean | The ocean joins the fog | `SroFogPlugin` is registered globally and attaches to **every** PBR material of a scene whose HeightFog is active **[confirmed: `pbr/fog-plugin.ts`]**: the ocean gets the fog without code. | §8.6 |
| R13 | Coast textures | B-coast batch | TX-R keys terrain sets as `tile2d:<stem>`; `tile()` does not follow `gen:` replacements **[confirmed: `pbr/maps.ts`]**. 16 terrain sets exist today, of the coast palette only `c_stone_hmfld_01` (177); 226 and 154 are already exported tiles, 407, 412, 70, 534 and 278 are not **[confirmed: `work/out/pbr/index.json`, `manifest.tiles`, 104 tiles]**. | §7 |
| R14 | Baked shadows on new cliffs | Waited for D16 | D16 is measured: `BAKED_LIGHT_DIR` azimuth −14°, elevation 38° **[confirmed: `sky/types.ts`]**. The converter bakes a heightfield shadow for changed and synthetic regions along it (the RND-L method, `work/tmp/w9a-rnd-l/bake-terrain.ts`). | §5.4, §13 |
| R15 | Engine items handed to GAME | powerPreference, Apple first-run | **Done:** `GPU_POWER_PREFERENCE = 'high-performance'` on both engines, Retina Macs at 0.75 **[confirmed: `apps/game/src/engine.ts`, `settings.ts`]**. | §13 |
| R16 | Blender round trip | Prototype run on Blender 5.2 | **Re-run on 5.2.2 LTS**: the bundle is byte-identical to the original, the readback is deterministic (identical SHA-256), the validator gives the same 12,471 weighted vertices, 15.26 mm and 44 errors. Two new findings: relative render paths land at the drive root, and sculpt operators crash in background mode **[confirmed: `work/tmp/coast-refresh/rt/`]**. | §6.6 |
| R17 | New 3D models | Retail props only | Unchanged, now a rule: **no new 3D models in the coast wave** (the user: new models for trees only). Islets and sea stacks are terrain sculpts, not models. Coastal tree species, if any, come from TREES. | §10.3, §8.13 |
| R18 | Tidewater | Read at `4811ba4` | The upstream head is still `4811ba4` (2026-09-25) **[confirmed: GitHub commit list, 2026-09-29]**. Nothing to re-read. | §8.12 |
| R19 | Converter files | No 9A/9B lane owns them | Still true: `convert-world.ts` and `manifest.ts` were last changed in wave 3 **[confirmed: `git log`]**. The three call sites (`loadRegion` 243, `buildNormals` 291) and `stitchWorldMap` are where §5.4 says. | §5.4 |
| R20 | Budgets | Projected GPU per preset | Rewritten against the measured wave-9 numbers, with the joint "sky and sea" envelope. | §8.11 |

## §F What the fact-check corrected (fact-check 2026-09-29)

Re-derived and still true (not repeated below): the release settings (`recommendGraphics`, `RENDER_ROLLOUT = 'on'`,
`hasFewVaryings`), BF-2's 15 + `front_facing` = 16, every `water-plugin.ts` constant, `WeatherFrame`'s fields and
`WEATHER_PARAMS`' winds, `SKY_PRESETS`' cloud shadows and horizon ring, `BAKED_LIGHT_DIR` (asin 0.6157 = 38.0°, 14°
north of east) and RND-L's r 0.6903, the sky cube's sizes and rates, the fog plugin's global registration, TX-R's
`tile2d:` key, the 16 terrain sets of 145, the manifest's bounds, `stream.playable`, 104 tiles and 307 regions, the
stream radii, the converter's untouched history and line anchors, `World.clamp` at 719, `minimap.ts` 107/137,
`shaders.ts` line 31, the PBR hook names in 9.28's shaders, the storage-view and `generateMipmaps` code, Blender 5.2.2
(`d13f752e3b9c`), the byte-identical bundle, the validator's 44 errors, no stray `C:\work`, and Tidewater's head
`4811ba4` (GitHub commit list, re-read 2026-09-29).

| # | Claim | Finding, and how it was checked | Fixed in |
|---|---|---|---|
| F1 | "`thinInstanceSetBuffer('cdlodNode', data, 4)` … the per-node data" draws the CDLOD nodes | The signature is right, but only a `"matrix"` buffer sets the instance count: a custom kind alone leaves `instancesCount` at 0, and a mesh with 0 thin instances renders as a **plain mesh** (`hasThinInstances` is false), which also flips the INSTANCES define **[confirmed: `Meshes/thinInstanceMesh.pure.js` 235–257, `mesh.pure.js` 225]**. The ocean sets a `"matrix"` buffer too (the node transform), pre-allocates both at the node cap and sets `thinInstanceCount`. | §8.2, §12.4 |
| F2 | The ocean is switched with enable/disable plus 5 s hysteresis so the active-mesh list does not churn | `isVisible` is tested in `_evaluateActiveMeshes` and does not fire `onEffectiveEnabledStateChangedObservable`, so toggling it never rebuilds `EnabledMeshCandidates` **[confirmed: `scene.pure.js` ≈ 3915, `render/active-meshes.ts`]**. The ocean stays enabled and toggles `isVisible` per frame; with no sea node it is invisible, never drawn with 0 instances (F1). | §8.2, §12.4, §8.11 |
| F3 | The depth pre-pass is "+1 draw, ≈ 0.02 ms" | Babylon's transparent `needDepthPrePass` renders the same submesh again with colour writes off (`renderingGroup.js` 206–212). The material's DEPTHPREPASS define follows the colour-write state (`materialHelper.functions.js` 941), and the setter forces `checkReadyOnEveryCall = true` (`material.pure.js` 361–368) **[confirmed]**. So there are two effect variants per preset, readiness is re-evaluated on every call, and the vertex stage (the FFT taps) runs twice. The prepass variant skips lighting (`#ifndef DEPTHPREPASS` in `pbr.fragment`). CPU is **[projected 0.03–0.08 ms]** instead of 0.02. Fallback: a depth-only twin mesh that shares the node buffers, with `disableColorWrite`. | §8.2, §8.11, §12.4 |
| F4 | Whether the sea reaches the prepass MRT depth is [unknown] | Decided by one flag. The PrePassRenderer binds the MRT only for materials that are `isPrePassCapable`, which for PBR is `!disableDepthWrite` **[confirmed: `prePassRenderer.pure.js` 228–248, `pbrBaseMaterial.pure.js` 708]**. The depth pre-pass writes only the hardware depth buffer. Default: the colour pass keeps `disableDepthWrite` (as RND-W), so SSAO/TAA's prepass depth never sees the sea, while anything that reads the hardware depth does. | §8.2, §8.13 S-HAZE |
| F5 | "`water.ts` gains one getter for the frame array" | `WaterRenderer.pbrState` is already public (`readonly pbrState`), and holds `frames` and `normal`. They are filled lazily by the private `ensurePbr()` on the first PBR water region, though **[confirmed: `water.ts` 92, 341–348]**. So I-CST's hook is a public "ensure the PBR water state" call (plus the Classic frames for Low), not a getter. | §8.1, §12.4, §12.12 |
| F6 | Cloud shadows cross "the sea without a step" | RND-W's water plugin has **no** `SRO_CLOUDSHADOW` (only the terrain and surface plugins call `sroCloudShadow`) **[confirmed: grep]**. So in the join zone the ocean's cloud-shadow factor fades to 1 with the waves, or the bay mouth shows a step on High. | §8.1, §8.5, §8.13 |
| F7 | "First-run WebGL2 lands on Low" | Stale. `recommendGraphics` gives Medium to WebGL2 as well; only WebGL1 gets Low **[confirmed: `settings.ts` 500–509]**. | §8.10 |
| F8 | "The spawner still places all 791 nests" | Production places **about 700** and logs "nests not spawned: 91 unreachable on foot from town"; 791 is the pre-reachability count **[confirmed: DEPLOY.md, FIELDS.md]**. The check becomes: the same placed set and skip list as before the coast. | §6.4, §9.3, §12.8 |
| F9 | "Coast total ≤ +15 draws (Medium) / +17 (High)" | Does not add up: 9 terrain + 2 ocean + CST-A's ≤ 6 = 17 on Medium, 11 + 2 + 6 = 19 on High. Table 1 also left CST-A out. Fixed to +17 / +19 and ≈ 8.5 / 16.4 ms. The "0.021 ms per draw" is an average (total CPU ÷ draws), not a marginal cost, so it is [projected from measured averages]. The +9 / +11 is the south-east-corner worst case: at the beach bench the nearest synthetic row (z 88) is ≥ 307 m away, so none is inside High's 150 m CSM range **[projected arithmetic]**. The WebGL2 High baseline (14.1 ms) was measured before cut 4 (`budgets.md`), so it is an upper bound. | §8.11 |
| F10 | Worker tick "0.98 ms median / 1.01 ms p95"; budget "≤ 1.2 ms" | Re-run: 0.999 ms median, **1.42 ms p95** (2 × 64²); 2.06 ms (4 × 64²); 4.72 ms (2 × 128²); CDLOD 0.0226 ms **[confirmed: `pnpm tsx work/tmp/coast-refresh/fft-bench.ts`, 2026-09-29]**. The median reproduces; the p95 is noisy. The budget is now median ≤ 1.2 ms, p95 ≤ 1.6 ms. | §8.4, §8.11 |
| F11 | "≈ 11–15 ms of GPU on a base M1 at the beach" | The derivation scaled only the ocean to the Retina size, not the base. Redone from the measured dev GPU (Medium 1.54–1.67 ms) × mid 1.0–1.3 × M1 4.5 × Retina-0.75 1.4 ≈ 9.7–13.7 ms, + ocean 1.0–1.3 ≈ **11–15 ms [projected]**: the result stands, the path is fixed. Two new items: FSR1 (and the post after it) runs at the native 2880 × 1800 on WebGPU, because the canvas stays full size when FSR takes the scale **[confirmed: `settings.ts` `applyGraphics`; cost unknown]**; and a base M1's CPU is ≈ 1.3–1.5 × the dev PC's **[projected]**. | §8.11 |
| F12 | S-CLOCK: "the sea's wind sea follows the same low-passed wind" as the clouds | The clouds drift with the **unfiltered** frame wind × 1.5 (`CloudLayer.drift`); the sea low-passes its own copy (τ 30 s) **[confirmed: `sky/clouds.ts` 84–88]**. They share the direction, not the same filtered value. | §8.13 |
| F13 | Lace "0.35 MB as BC7" | The lace is generated at load, and there is no runtime BC7 encoder, so it stays RGBA8 (1.4 MB with mips) unless it is baked offline. | §8.11 |
| F14 | (missing) WGSL sampling rules | Vertex-stage taps must use `textureSampleLevel`, and fragment taps inside non-uniform control flow break WGSL's uniformity rule. RND-W computes all of its taps at `CUSTOM_FRAGMENT_MAIN_BEGIN` for this reason **[confirmed: `water-plugin.ts` header]**. The ocean follows the same rule, and the spike checks it. | §8.6, §12.4 |
| F15 | (missing) protocol and abuse | `WorldInfo` carries no export version **[confirmed: `shared/src/protocol.ts` 209]**, so after the S1 re-convert, a page that survives the server restart keeps the old heights (up to 10 m off on S1). Saved characters on the old strip are re-placed by `entryPoint` (a height change of 2 m or more goes to `nav.place`) **[confirmed: `connection.ts` 394–411]**. `tp beach-south` is GM-only **[confirmed: `content.ts` 40–44, `gm.ts`]**. | §9.3, §16 Q13 |
| F16 | Terrain texture units for `sroCoastWet` | The D32 test asserts that the worst final set is **≥ 15** units **[confirmed: `test/terrain-plugin.test.ts` 342–366; the exact worst was not re-run]**, so one more sampler may not fit on Ultra with full weather. The [projected] shelter-sharing fallback stays, and CST-S's extended test decides. | §8.6 |

## §B What the beaches revision changed (beaches 2026-09-29)

Every number below comes from `work/tmp/coast-beach/` (`coast_beach.py`, `census.py`, `coast_beach.json`,
`census.json`), run on the same retail heights (`work/tmp/coast/H_dom.npy`, bit-identical to the export's bins, §1.1)
and compared with the old Option A run (`work/tmp/coast/coast_A.npz`) by the same code.

| # | Topic | Before (Option A, 2026-09-28) | Now, and how it was checked | Where |
|---|---|---|---|---|
| B1 | Shore types | Beach, rocky shore and **sea cliff** by section, forced to cliff on high ground (`T` field) | **Beach everywhere.** No cliff or rocky type is left; each section picks a beach kind (wide, bay, mountain, strait, mouth) with its own widths and slopes **[confirmed: `coast_beach.py` `KIND`]** | §3B.1, §3B.2 |
| B2 | Mountains at the edge | The ring kept its retail relief; the coast only lowered it near the waterline, and high shore became a 64–73° face | The ring outside the bounds is **re-shaped to a flank envelope**: it starts at the frozen bounds-line height, continues the retail slope over a rounded shoulder, and falls at 31° (mountain kind) or 24–27° (others) to the back of the beach. It is lowered where retail is above it and filled where a retail face drops below it **[confirmed: prototype]** | §3B.3 |
| B3 | "The coast only lowers" (C3, §3.1 p4) | Lower-only, except berms and synthetic land | **Replaced.** Outside the bounds on sea sides the ring may be raised to the envelope (fill) and a river bed in the beach band may be filled. Inside the bounds nothing changes except S1 (frozen check unchanged): 0 changed playable vertices outside the S1 patch **[confirmed: `playChangedOutsidePatch` 0]** *(beaches fact-check, G2: that counts outside the blurred patch; 8,618 in-bounds vertices outside the mask change by up to 15.7 m in the prototype, which the converter's inward-only feather must remove)* | §3B.3, §3.1 |
| B4 | Qin-Shi tomb backdrop (C11) | The whole ring 170–174 × 103 bit-identical (`blendStartM` 192) | **Crest kept, seaward face regraded:** retail kept up to the crest line + 24 m (6,328 vertices, bit-identical **[confirmed]**), then the envelope from the retail height on that line. The two tomb cliff meshes stand on unmoved ground **[confirmed: footprint sampling, `census.py`]** | §3B.4 |
| B5 | Domain | X 150–177 × Z 87–105 | **+ one row south (z 86)**, so the lowered Tiger flank and its beach (waterline up to 464 m past the bounds) keep a shelf that deepens before the field's clamp. Row 86 emits no region (all deeper than 8 m) **[confirmed: census]** | §2.2, §3B.6 |
| B6 | Emitted synthetic regions | 73 (40 land + 33 shallow) in the band | **107 (60 land + 47 shallow)**; 86 deep-only (row 86 included) **[confirmed: census, same land/8 m rule]** | §2.2 |
| B7 | Worst-case resident band regions | +9 / +11 (TECH's estimate); +10 / +12 by the census method | **+11 (Medium, 400 m) / +17 (High, 480 m)**, at the south-west corner (156.0, 90.0) **[confirmed arithmetic on the emitted set, `stream.ts` radii]** *(beaches fact-check, G3: the old Option A's worst by the same count was +11 / +16 at the NW corner (156.0, 103.0), not +10 / +12; Low is +7 / +8; with the unload hysteresis up to +19 / +22 stay resident)* | §8.11B |
| B8 | Changed export regions (terrain, nav, lightmap, minimap rewritten) | 69 of 307 | **74 of 307 [confirmed: census]** | §9.4 |
| B9 | Retail placements on moved ground (> 0.5 m) | 83 (8 vegetation re-snapped, 65 under the sea, 10 other listed) | **97: 19 vegetation re-snapped, 50 dropped (ground below SL + 0.5 m), 28 other dropped and listed** (gorge pieces, rocks, a Buddha wall, small cliffs) **[confirmed count; vegetation/other split by model path, likely]** | §3B.5 |
| B10 | Sand | 75,366 samples (≈ 0.30 km²) | ~~227,714 samples (≈ 0.91 km²)~~ **231,896 samples (≈ 0.93 km²)** *(beaches fact-check, G4: the earlier figure was run 1 of 6)* [confirmed: `coast_beach.json`] | §3B.6 |
| B11 | Steepness outside the bounds | Sea cliffs by design | Past 100 m from the bounds, 0.73 % of land cells are steeper than 45° (p99 44.4°); the remaining spots are listed as Blender hotspots **[confirmed: slope census]** *(beaches fact-check, G6: on the procedural base; after the gully pass 1.19 %, p99 45.4°)* | §3B.6, §3B.7 |
| B12 | Blender | Round trip proven on a demo dune (§6) | **A scripted sculpt pass on the procedural beach base** (gullies on the Tiger flank) went through build → pass → readback → validation with 0 errors, deterministic **[confirmed: `work/tmp/coast-beach/rt/`]**; a watch/hand workflow for the user | §3B.7 |
| B13 | Texture stretch on cliffs (§13, Q4) | ≈ 100 m faces at 64°+, triplanar only on High | Gone: flanks are ≤ 31–40°, a stretch of ≤ 1.3 × without triplanar **[projected]** *(beaches fact-check, G6: ≤ 1.4 × at the p99 of 45° after the gully pass)*. Q4 is closed | §7, §13 |
| B14 | Sky and trees | Built together with SKY2 and TREES ("sky and sea") | **SKY2 and the new tree models are deferred** by the user; the coast ships on wave 9's fog, IBL and cloud-shadow functions (the §8.13 defaults) and on retail trees (C9 by uid) | §12.0, §8.13 |
| B15 | Gulls and critters (CST-A) | A coast flock system of its own | **Birds belong to docs/GRASS_LIFE.md's instanced bird system** (the user's item 5); the coast adds a gull species and its sea-side rules, not a system **[decision, default]** | §12.6 |
| B16 | A retail hole | Not noted | 76 retail vertices at (162.8, 104.4), outside the export, fall to −2,159 m **[confirmed: `H_dom.npy`]**. The converter treats heights below −200 m as a hole *(beaches fact-check: 58 vertices lie below −200 m; 76 is the count below −100 m, G5)* | §5.3 |

## §G What the beaches fact-check corrected (beaches fact-check 2026-09-29)

Scripts and outputs: `work/tmp/coast-beach-fc/` (`fc1.py` slope/sand census, `fc2.py`/`fc2b.py` resident regions,
`inbounds-reach.ts` and `nests-ring.ts` on the export's `nav.bin`, `fc3*.py`/`fc4b.py` tile-level link search, `fc5.py`
bench check, and an independent re-run of the Blender gully pass and readback in `rt/`).

**Re-derived and still true** (not repeated below): 107 emitted band regions (60 land + 47 shallow, 86 deep-only, row
86 all deep), 74 of 307 changed export regions, the 97 / 19 / 50 / 28 placements and the empty tomb-area footprint
list (`census.json`, re-read against `census.py`); the tomb keep's 6,328 bit-identical vertices; every §3B.1 waterline
percentile and the §3B.2 `KIND` table (grades 24.2° / 26.6° / 31.0°); the beach-band slope (p99 24.5°, 4.0 % over 15°);
past 100 m of the bounds 0.73 % over 45° and p99 44.35° on the procedural base; the ring changes (84,673 / 150.5 m,
129,716 / 134.9 m, 13.3 million m³, 4,313 cells); heights −75.5 … 257.0 m; 34.7 s; the +11 / +17 worst case at
(156.0, 90.0); the §8.11B baselines (`work/tmp/w9-finish/budgets.md` rows gate storm: Low 3.7 / 2.4, Medium 8.1 / 7.2,
High cut 4 15.9 / 14.1, Ultra 16.0 ms); the field, world-map and disk arithmetic; the round-trip bundle (577 × 385,
−14.8 … 257.0 m); the gully pass (**re-run: 80,350 vertices > 2 cm, max 8.42 m**) and its readback (**re-run: all 14
layers byte-identical to `rt/content/coast`**); the validator (**re-run: 14 layers, OK**). No nest depends on the ring:
682 of the 805 enabled in-bounds nests reach town with or without the ring (`nests-ring.ts`).

| # | Claim | Finding, and how it was checked | Fixed in |
|---|---|---|---|
| G1 | S1 is "a real walkable beach", reachable "most likely along the x ≈ 165 channel bed" (§1.5); the coast "changes no playable cell", so reachability inside does not change (§9.4) | **Wrong.** With every region outside the bounds closed (the clamp's view), the S1 strip, the south end of the east shelf and the NE corner are **not** reachable from town; with the ring open they are **[confirmed: `inbounds-reach.ts` on `nav.bin`; in-game untested]**. The S1 pocket (x 165.0–175.0 × z 90.0–93.0, ≈ 116k tiles) is closed off inside the bounds by the S3 ridge (56–136 m) on the west, the south wall on the north and the closed east shelf; its only link runs through row 89 and column 175. So today no player can walk to S1 (the server clamps every move to the bounds and walks straight lines only). After the coast, row 89 in front of S1 is sea deeper than 0.4 m and the strip of east flank above SL + 12 m next to the line closes (§9.1); whether a nav route outside the bounds survives along the new east beaches is **[unknown]**. If none does, §9.3's "the converter closes islands" would **close the walkable beach itself**; if one does, S1 stays in the nav's home component but is still unreachable for players. Fix: an in-bounds link is part of S1 (G1 rows in §3.5, §9.4, §12.1, §16 Q22) | §1.5, §3.5, §9.4, §12.1, §12.8, §16 |
| G2 | "0 changed playable vertices outside the S1 patch (61,344 inside its mask and inward feather, as before)" | The prototype still feathers **outward**: 52,726 changed vertices in the mask and **8,618 outside it, by up to 15.7 m** (p99 4.5 m). The "0" counts vertices outside the *blurred* mask **[confirmed: `h` vs `H_dom.npy`]**. The converter rule (feather inward only, §3.5) stands; the prototype does not implement it | §B B3, §3B.6 |
| G3 | Resident worst case "+11 / +17, against +10 / +12 for the old geometry"; Low "+11"; bench "near the old one [likely]" | +11 / +17 at (156.0, 90.0) **confirmed**. The old Option A's worst by the same count was **+11 / +16, at the NW corner (156.0, 103.0)**, so beaches everywhere raise the worst case by 0 / +1 and move it to the SW; §8.11's +9 / +11 already understated Option A. **Low (320 m): +7 at the SW corner, +8 worst** (174.7, 103.0), not +11. With the unload hysteresis (560 / 660 m) a player walking to the SW corner can hold **up to +19 / +22** resident (VRAM), of which only those in the frustum draw. At the beach bench **0** synthetic regions are within 660 m **[confirmed: `fc2.py`, `fc2b.py`, `stream.ts` d(region)]** | §B B7, §2.2, §8.11B |
| G4 | Sand 227,714 samples ≈ 0.91 km²; land 55.5 % | Stale (run 1 of 6). The final run gives **231,896 samples ≈ 0.93 km²** and **land 55.9 %** **[confirmed: `coast_beach.json`, `run6.txt`]** | §B B10, §3B.6 |
| G5 | "76 retail vertices … fall to −2,159 m" | **58** vertices lie below −200 m (min −2,158.9 m); 76 is the count below −100 m, so the −200 m rule leaves an 18-vertex pit rim at −100 … −208 m **[confirmed: `H_dom.npy`]**. Region 162 × 104 is beyond the export, which §5.3 step 4 replaces by the extended edge, so the converter never reads it **[likely]**; the prototype's N2 "max raised 171.8 m" is that pit, not the design | §B B16, §3B.6, §9.4 |
| G6 | "Past 100 m, 0.73 % steeper than 45° (p99 44.4°)" as the flank's end state; B13 stretch ≤ 1.3 × | True for the **procedural base**. After the gully pass (`coast_beach_sculpted.npz`) it is **1.19 % (p99 45.4°)**, and 17.8 % of flank cells exceed 37° **[confirmed: `fc1.py`]**. So CST-C's slope-census test must run on the merged result with the hotspot allowance, and the stretch is ≤ 1.4 × at the p99 | §B B11, B13, §3B.3, §12.13 |
| G7 | Flank paint: "grass on slopes under 30° … rock (226) above 35°" so "GRASS_LIFE's grass grows there by itself" | Most of the flank is **rock-blend** under that rule: past 100 m, **77 % of flank land is steeper than 30° and 56 % lies in 30–35°** (median 31.9°, the mountain grade) **[confirmed: `fc1.py`]**. GRASS_LIFE grows full grass up to 36.9° (`smoothstep(0.70, 0.80, normal.y)`) **[confirmed: GRASS_LIFE.md §3.2]**. New default: grass tiles up to 38°, blend to rock 38–45°, rock above 45°; then 13 % (base) / 18 % (after gullies) of the flank is above 37° | §7.1, §3B.5, §8.13 S-LIFE |
| G8 | S-LIFE: the gull is "the retail hawk model (§10.2)", staying "over water deeper than 2 m" | GRASS_LIFE's birds are **procedural 17-triangle species on one instanced mesh**; there is no model slot for a retail `.bsr`, and its §8.3 says gulls fly "over water deeper than 8 m and loafing on the beach" **[confirmed: GRASS_LIFE.md §5.3, §8.3]**. The gull is a colour/scale/flap species of that mesh; the habitat numbers follow GRASS_LIFE (8 m, as CST-A's old flock test) | §8.13, §10.2, §10.3 |
| G9 | "Jump (item 3) and the character stage (item 4) share no file with the coast" | Jump does: MOVEMENT's MV-A puts its Blender scripts in `packages/convert/tools/blender/moves/` next to CST-B's and adds the same `blenderExe` key (`node-io.ts`, `sro.config.example.json`), and MV-C asks the coast for an optional `waterLevelAt(x, z)` for the landing sound **[confirmed: MOVEMENT.md §2.2, §6.4, lane table]**. GRASS_LIFE's GL-C hooks the same converter files (`manifest.tiles[].grass`, `perches.json` from building placements) **[confirmed: GRASS_LIFE.md lane table]**. New seams S-MOVE and S-BLENDER; S-DRAW extended to perches | §8.13, §12.12 |
| G10 | "A jump validates against the same navmesh and the same clamp" | A jump makes **no nav call**; it never starts, changes or ends a move **[confirmed: MOVEMENT.md "Crossing terrain: Never"]** | §9.4 |
| G11 | The shoulder "continues `s_in`" so there is no crease; CST-C test: "the envelope equals the retail height on the bounds line" | `s_in` is clipped at 0: where the retail slope falls toward the line from inside, the envelope starts **flat** and the fill raises the outer ground to it, leaving a **bench** 10–60 m out on about 3 % of the south line, 10 % of the west and east lines and 16 % of the north lines (a heuristic) **[confirmed: `fc5.py`]**. The envelope itself starts at the 40 m-blurred `Hb`, not the retail height; only the final surface equals retail on the line (the 40 m blend). The test is re-worded to the final surface plus a bench check | §3B.3, §12.13 |
| G12 | Tomb: beyond the keep line the face "falls at the wide kind's grade (24°)" | At x 172.75 the kept retail face is 47–58° over its last 30 m, then the regrade starts at **11–15° for about 30 m** before 23–33°: a concave kink at the keep line, visible from N5's beach **[confirmed: profile of `coast_beach.npz`]**. CST-C joins them with a smooth maximum (as the toe), and hotspot 2 names it | §3B.4, §3B.7 |
| G13 | The strait kind's shelf is 8 m deep at 120 m | At z 92.5 the W2 shore is **12.2 m deep 30 m out** (the retail river bed beyond the export blended in), a steep shoreface **[confirmed: `census.json` profile W1/W2]**. Look-only; CST-C tunes it, LAB checks the swash there | §3B.2 |
| G14 | Tomb crest "83–128 m, 14–88 m past the line"; west line "67–183 m" | Per-column crest **80–138 m, 0–88 m** past the line; the west line at z 90–95 is **41–183 m** **[confirmed: column scan of `H_dom.npy`]**. Wording only | §3B.3, §3B.4 |
| G15 | S-DRAW: "before any instancing or merge step builds its batches from `manifest.placements`" | Consistent with item 1's prototype, which batches **at runtime** from the live World's placements (`work/tmp/batching/lab/batch.ts`, "BATCHING.md prototype": trees as one thin-instance mesh per model, buildings merged per region) and does not merge terrain **[confirmed: code read]**. GRASS_LIFE's ground cover must not be batched (its §8.3), nor the ocean | §8.13 |
| G16 | "50 dropped (in the sea)" and "28 other models dropped and listed" | The 50 include non-vegetation below SL + 0.5 m (the census tests the sea first); C9 drops and lists every non-vegetation model on moved ground, so the listed set is 28 plus the non-vegetation among the 50 **[confirmed: `census.py`]** | §3B.5 |

Line anchors in `apps/game/src/settings.ts` move while the release workflow edits it (`recommendGraphics` is now at
508–518); the function names and behaviour the doc cites are unchanged **[confirmed: read 2026-09-29]**.

## Images for approval

*(beaches 2026-09-29)* The current set, in `work/tmp/coast-beach/`:

| File | What it shows |
|---|---|
| **`before-after.png`** | One sheet for the user: the old Option A map against the new map, then the Tiger coast and the south coast from the sea, before and after (same data, same cameras). |
| **`preview.png`** | Top-down shaded relief of X 150–177 × Z 86–105 with beaches everywhere: land, sand, sea depth, the lowered ring (hatched), the kept tomb crest (green), the bounds, the export ring, roads, ferries and section codes. Seed 1188, sea level +5 m. |
| **`render-tiger.png`** | Oblique Blender 5.2.2 (Cycles) render of the former Tiger cliffs (S4), now the Tiger beach: the procedural flank plus the scripted Blender gully pass, read back through the round trip. |
| **`render-south.png`** | The south coast from the sea: S1 (Jangan South Beach) in front, the S2 river mouth, the lowered S3 headland. |
| `render-tiger-before.png`, `render-south-before.png` | The same cameras on the old Option A heights. |
| `render-tiger-base.png` | The Tiger beach from the procedural base alone, before the Blender pass. |
| `diag_slope.png` | Diagnostic: land steeper than 35° (orange) and 45° (magenta) outside the bounds; the kept tomb crest in green. The magenta inside the corridor rectangle is retail land (Option A keeps it). |
| `rt/base_oblique.png`, `rt/base_topdown.png` | The Blender scene of the round-trip area (156–161 × 87–90) as built from the bundle. |
| *(beaches fact-check 2026-09-29)* `work/tmp/coast-beach-fc/s1-pocket.png` | G1: the S1 pocket (orange) against the ground reachable from town inside the bounds (green) and the town component outside the bounds (blue, where the clamp stops players). A terrain-tile proxy; the nav result is `inbounds-reach.ts`. |

The images below are the 2026-09-28 set, kept as the record (their cliffs are superseded):

| File (all in `work/tmp/coast/`) | What it shows |
|---|---|
| **`overview.png`** | One sheet for the user: the Option A and Option B maps side by side, then the beach and cliff renders. |
| `preview-A.png`, `preview-B.png` | Top-down shaded relief of regions X 150–177 × Z 87–105: land, sand, cliffs, sea depth, the playable bounds, the export ring, Jangan, roads, ferries and section codes. Both are made from the working prototype `coast.py` (seed 1188) run on the real retail heights, at sea level +5 m. Retail ponds at other levels inside the playable set (Jangan's −2 m moat, the −3.3 m pond, −8 m at 169,94, 0 m at 171–172 × 101–102) are drawn in the same blue as the sea. They are not sea, and they keep their own levels. |
| `preview-beach.png`, `preview-cliff.png` | Oblique Blender 5.2 (Cycles) renders of Jangan South Beach (S1) and the Tiger cliffs (S4). They are bit-identical in A and B **[confirmed: crops matched against `coast_A.npz` and `coast_B.npz`]**. They are rendered without fog, so they show a horizon the game never shows. |
| `profiles.png` | Six cross-sections (S1, S4, E2, N1, N5, W3) against the +5 m sea, with the retail heights dashed. |
| `blender-edge-oblique.png`, `blender-edge-topdown.png`, `blender-edge-vs-minimap.png`, `blender-proc-oblique.png` | Proof that the Blender scene lines up with the game (§6.1). |
| *(refresh 2026-09-29)* `work/tmp/coast-refresh/rt/oblique.png`, `topdown.png` | The same edge area rebuilt from the current export on Blender 5.2.2 (§6.6); pixel-identical to `blender-edge-oblique.png` and `blender-edge-topdown.png` **[confirmed: PIL image difference, empty bounding box]**. |
| `coast-preview.png`, `coast-profile-*.png`, `export-sea-minus2.png` | The second prototype (`proto_coast.py`, sea level −2 m, one synthetic ring). It still shows three artefacts: the fade lowering 162 × 103, the void south-west corner, and the carved tomb backdrop. §5 fixes them. |

## Fact-check summary

Both parts were fact-checked adversarially against the retail `.m` files, `mapinfo.mfo`, `refregion.txt`,
`teleportdata.txt`, the export (`terrain/*.bin` through the converter's own `decodeTerrainBin`, `manifest.json`,
`environment.json`, `nav.bin`, `all-nests.json`, `npcs.json`), both prototypes and the code. The corrections are
folded in below. The ones that shaped decisions:

- Retail filler does **not** break the seam rule. All 929 seams in X 148–178 × Z 86–106 are bit-identical, because
  filler keeps a thin real rim (§1.3).
- A per-block (32 m) water plane cannot carry this coast. The sea needs a finer mask (§2.1, C5).
- The +5 m in-bounds beach edit (S1) reaches 30 m past its mask and cuts a groove on the bounds line in the
  prototype. The converter must feather it inward only (§3.5).
- The second prototype's north fade lowers a land-side region (162 × 103) by up to 86.9 m. It also leaves a void
  south-west corner and carves the mountain behind the Qin-Shi tomb (§5.3).
- The difference between A and B **is** visible from one reachable spot, the river-mouth bed at the west bound (§4).
- The converter's inputs are a whole `MapMFile` and a whole `NvmFile`, not just grids (§5.4).
- EXR cannot be read by the converter's `sharp`, and `sharp` silently reads 16-bit PNGs as 8-bit unless the image
  is converted with `toColourspace('grey16')` (§6.3).

---

## §0 Decisions

### 0.1 TL;DR

1. **Sea level +5.0 m**, the surface every retail river and the Jangan lake already use **[confirmed: 2,280 water
   blocks in X 148–178 × Z 86–106 sit at exactly 5.0 m]**. The lake north of Jangan opens into **Jangan Bay** and the
   rivers meet the sea with no step. Jangan town (0 m) and the grassland (−8 … 0 m) lie below that level, so the
   ocean is drawn only where a **sea mask** says so, never as one plane under the map. The alternative, −2.0 m,
   changes no playable height but needs sand bars at the river mouths. It stays a single config value (C1, §2.1).
   *(refresh 2026-09-29: the user chose +5 m, "Jangan Bay".)*
2. **The coast goes where the map does not lead to a town:** east, south and north-east (x ≥ 163) in phase 1, where
   both study parts agree. In phase 2 it goes west and north-west, following the user's choice of Option A or B (C2).
3. **Option A** *(refresh 2026-09-29: chosen by the user)*: a land bridge of real retail terrain west to Donwhang,
   blocked for now by the bounds and a scenery gate. Option B makes Jangan an island. Switching is one data table plus
   a converter re-run (§4). *(2026-10-06: the user asked for Jangan alone in the open sea, on the maps and in the
   world: the Western China side and the land bridge are drowned, §4.1.)*
4. **The playable area does not move** (`manifest.bounds` stays X 156–174 × Z 90–102). Every playable height stays
   retail except, at +5 m, one strip: the flat 0 m ground outside Jangan's south wall becomes **Jangan South Beach**
   (S1), the one walkable beach. No nest, NPC, road or placement lies in or near it **[confirmed: `all-nests.json`
   with radii, `npcs.json`, the minimap, the placements]**. *(refresh 2026-09-29: the user chose the walkable beach;
   the exported `bounds` {−2304 … 1344} × {−1152 … 1344} and `stream.playable` 156–174 × 90–102 are unchanged
   [confirmed: `work/out/world/jangan-fields/manifest.json`].)* *(beaches fact-check 2026-09-29, G1: S1 is not
   reachable on foot inside the bounds today; it needs an in-bounds link, §3.5, §16 Q22.)*
5. **Geometry:** a section table (15 sections plus 2 corridor faces) gives each stretch a type (beach, cliff, rocky
   shore), a waterline offset and a noise amplitude. High ground at the shore turns into cliff automatically. The
   pass runs on one global 2 m lattice, so seams match by construction. It is deterministic (seed 1188) (C3, §3).
   *(beaches 2026-09-29: **every section is now a beach**, with a dune, dry sand, wet sand and a shallow shelf whose
   widths and slopes depend on the section's beach kind. Where the playable edge is mountainous, the ring outside the
   bounds is re-shaped to a flank envelope that falls from the frozen bounds-line height at ≤ 31° to the back of the
   beach; the tomb keeps its crest. The procedural pass gives the base and a Blender sculpt pass adds the hand work,
   through the same round trip. §3B.)*
6. **Hand edits:** per-region 16-bit height and 8-bit paint override layers plus `props.json`, all in
   `content/coast/`. They come from a Blender round trip (`coast-export` → sculpt and paint → `coast-import`) that is
   validated and deterministic. **Order:** procedural base → Blender layer where it is painted → frozen check. A
   Blender MCP connection is optional: it only adds live, watched editing on top of the same scripts (C8, C15, §6).
7. **Ocean: Tidewater's design, adapted to Babylon** (MIT, ported with its notice, no assets; §8, §8.12):
   - a multi-cascade **FFT ocean** (JONSWAP, 2 compute dispatches per frame, Jacobian foam) as Babylon
     `ComputeShader`s on WebGPU: 4 × 128² on High and 4 × 256² on Ultra;
   - a **worker-computed FFT tile** on Medium and on any PBR preset without compute (WebGL2), and Gerstner waves on
     Low (Classic);
   - a **CDLOD** water mesh, **per-cascade attenuation** in shallow water, and a `SroOceanPlugin` on `PBRMaterial`
     (sky-cube reflection, glint with Cox–Munk roughness, scatter colour by depth, foam);
   - the sea state follows `WeatherFrame`'s wind (Tidewater has no weather);
   - **shore v1** is a foam band from the sea depth plus swash run-up. Breaking waves, a surf simulation and caustics
     are optional later lanes;
   - a world-aligned **coast field** texture (sea mask, distance to shore, bed depth) keeps the sea out of the town
     and the river beds.
   - *(refresh 2026-09-29)* **Medium is now every player's default**, so Medium's worker-FFT ocean (2 × 64², measured
     at 0.98 ms per tick off the main thread) is the ocean most friends see and is tuned first. The ocean's depth comes
     from the coast field on every preset (wave 9 built no depth renderer), all its per-vertex data travels in one
     varying, and it takes the fog, the sky cube and the cloud shadows through the seams wave 9 already has.
8. **Build:** *(refresh 2026-09-29)* wave 10 **"sky and sea"** (with SKY2 and TREES, merged by WAVE_PLAN4), in lanes
   CST-C, CST-B, CST-M, CST-O, CST-S, CST-A and CST-T, plus optional later lanes CST-W, CST-F and CST-K. 9A is
   integrated and released, so the data lanes can start at once; the renderer lanes start after SKY2's seam commit
   (§12.0). The coast adds **no new 3D models** (new models are for trees only, for now).
   *(beaches 2026-09-29: the wave is now the user's list of five items; SKY2 and the new trees are deferred, so the
   coast ships on its own gate with wave 9's sky functions. Birds move to GRASS_LIFE. §12.0, §12.13.)*

### 0.2 Conflicts between the two study parts, and the decisions

| # | Topic | GEO said | TECH said | **Decision** |
|---|---|---|---|---|
| **C1** | Sea level | +5.0 m. It is the river and lake level, so there are no steps at the mouths. It needs the S1 in-bounds beach edit. | −2.0 m. No in-bounds height changes, but the lake and the south river need berms (sand bars). | **+5.0 m as the design default** (§2.1), because it gives one water level everywhere, the bay and the strait need no dams, phase 2 needs no berm across the wide western river, and the approval previews are drawn at it. **−2.0 m stays a supported config** (`seaLevelM`, with berms and `allowHeightPatches: []`). The user picks the look (§14). |
| **C2** | Which edges are coast | Coast everywhere except Option A's corridor (x < 156, z 96.55–103.85). N1, N2, W1 and W2 are coast. | Only east, south and north-east. The whole west and north x 155–162 are land edges that are never touched. | **Phased.** Phase 1 = the sides both parts agree on (E, S, N for x ≥ 163). Phase 2 = W and NW by the user's A/B choice, using GEO's sections. TECH's "all west is land" is simply the state after phase 1, and it is also scope-cut item 10 (§12.11). |
| **C3** | Coast geometry | Section model: a noisy offset curve with waterline offsets `c0` of −300 … +290 m per section, a type field forced to cliff on high ground, the retail ring relief kept, and berms behind beaches. | A fixed beach with its waterline at 8 + 36 ± 22 m and a cliff edge at 14 ± 10 m past the bounds, then a 63° face. The coast only lowers. | **GEO's section model**, since TECH's fixed 14 m cliff edge slices the Tiger south-wall crest right behind the bounds. **Plus TECH's structural rules:** the global lattice, a frozen in-bounds area, a blend start of ≥ 8 m, lower-only apart from berms and synthetic land, the land/sea fade entirely on the sea side, the corner rule, the tomb rule, land-side regions bit-identical, and integer-hash noise (§3, §5.3). *(beaches 2026-09-29: the type field and the cliff profile are removed, every section is a beach kind, and "lower-only" is replaced by the flank envelope, which lowers or fills the ring outside the bounds on sea sides (§3B.3). The other structural rules stand.)* |
| **C4** | Extent and region emission | The ring plus 2 synthetic regions (576 m, 168 new regions), then a flat ocean skirt of about 2 km. | 1 synthetic ring, emitting a region only where the seabed is shallower than 8 m (`emitDepthM`), then the ocean clipmap. | **Compute on GEO's band** (X 153–177 × Z 87–105, plus the corridor in A). **Emit** a synthetic region only if it holds land or water shallower than 8 m (TECH's rule). The deeper ones are drawn by the ocean alone. **TECH's camera-centred ocean mesh (now a CDLOD grid, §8.2) replaces GEO's skirt** (§2.2). |
| **C5** | Sea mask | Per-vertex. It selects water at exactly +5.0 m, never the lower ponds, because 32 m blocks mix sea with low land in 30–34 blocks. | The coast field: 4 m per texel, a flood fill from the sea sides that never enters the bounds or seeds on land sides. | **TECH's field, with GEO's selection rule.** 4 m texels are fine enough, because terrain above the sea level separates the sea from low land and the depth test hides the sea there. Retail +5 m water inside the bounds keeps its own planes. Where it meets the ocean (N3, S2, and W2 in phase 2), the two join flat (§8.1). |
| **C6** | Walkable beach | S1 inside the bounds (heights raised); bounds unchanged. | Extend `manifest.bounds` by the ring on the east and south, and open knee-deep beach tiles. | **At +5 m: S1 inside the bounds, bounds unchanged.** At −2 m, the 0 m strip is already a natural beach above the sea, and TECH's bounds extension is the way to walk onto the new sand. The user decides walkability (§14). |
| **C7** | Deep water in the nav | Retail walks on beds. Blocking water deeper than about 1.5 m would be a new rule. | Regenerated coast tiles open only down to 0.4 m below the sea level (knee-deep). | **Inside the bounds, keep the retail rule** (walk on beds). **Regenerated coast tiles** outside the bounds use the knee-deep rule. A new deep-water block is a user decision (§14). |
| **C8** | Override layer format | `coast_*_h16.png`: the whole domain, grey16, `h = v/100 − 100` (prototype output). The brief mentioned PNG or EXR. | Per region: 97 × 97 LA16 heights `(h + 100)/500 · 65535` plus a weight channel, RGBA8 paint, and `props.json`. EXR is not readable. | **TECH's per-region layers** (§6.3). GEO's h16 files are prototype test inputs only. The override is **absolute with a weight**, not a delta. A delta mode is deferred, and the report warns when a profile retune moves the procedural base under an authored area by more than 0.5 m (§13). |
| **C9** | Placements on moved ground | 74 (A) / 88 (B) ring placements stand on ground moved > 1 m, 17 of them in the sea (mostly phase-2 areas). Re-snap vegetation, drop what is under the sea, flag structures. | Drop a placement whose origin ground moved > 0.5 m, and list footprint overlaps. At most 4 origins fall in TECH's changed regions. | **Merged rule:** vegetation is re-snapped to the new ground if that ground is ≥ SL + 0.5 m, and dropped otherwise. Rocks, cliffs and structures whose ground moved > 0.5 m are dropped and listed for hand placement (`props.json`). The footprint test lists in-bounds models that overhang moved ground (§5.4 step 4). *(beaches 2026-09-29: the rule stands; with the lowered and filled ring it now touches 97 placements, §3B.5.)* |
| **C10** | Retail water at the sea edges | At +5 m the lake and rivers simply continue into the sea. | At −2 m, copy the +5 m water blocks one block (32 m) across the bounds so the plane ends buried in the berm. | **At +5 m:** retail water blocks outside the bounds that fall in the sea are removed, and the ocean takes over. **At −2 m:** TECH's copy-into-berm rule. |
| **C11** | Qin-Shi tomb backdrop (x 170–174, north) | N4 rocky shore (`c0` 130) and N5 beach (`c0` 245). The tomb hill is kept in the ring. | `blendStartM: 192` for x 170–174: the ring keeps its retail heights, and the coast starts at z 104. | **Hard rule: `blendStartM` 192** (the ring regions 170–174 × 103 are bit-identical). N4's `c0` is raised to ≥ 200 m to match **[projected]**. *(beaches 2026-09-29: replaced by the **crest-keep rule** of §3B.4: the retail ring is kept bit-identical up to the crest line + 24 m for x 171.25–173.75, and only the seaward face beyond it is regraded, so the tomb's steep north face no longer drops to the sea.)* |
| **C12** | Land/sea split fade | Blends between sections with a 110 m Gaussian. | The fade must lie entirely on the sea side (x 163.0–163.8 at the north split), and no region west of the split is synthesised. | **TECH's rule, applied to every land edge**, including the corridor faces A-S and A-N in Option A. Test: land-side regions are bit-identical to retail. |
| **C13** | South-west corner | W1 and S4 join (fine in GEO's prototype). | The second prototype leaves a void at 154–155 × 88. | **Corner rule: below z 89 the south side wins**, so the sea wraps under 155 × 89. Test on the domain corners. |
| **C14** | Seed | 1188 | 7 | **1188.** |
| **C15** | Blender MCP | The user offered it. | Not needed. The headless scripts do the round trip, and MCP adds a live, watched window. | **Round trip = CLI scripts** (`pnpm sro coast-export` / `coast-import`). An MCP connection is an optional front end that calls the same functions. Installing one needs the user's approval (a download and a config change). |
| **C16** | What lies beyond the field on land sides | The skirt leaves out the corridor land west of x 153. | Outside the field the sampler returns open, deep sea. | **Clamp-to-edge.** The field's outermost texels are written as open sea on sea sides and as the land/sea mask on land sides, so the ocean never floods the corridor or the phase-1 west beyond the field. |
| **C17** | Region counts and cost | 168 band regions, 28–43 MB raw. | 8–58 regions, ≈ 0.2–1.3 MB. | Recomputed for C3 + C4: **about 60 (B) to 73 (A) emitted regions** out of 168, and about 95–108 deep-only regions not emitted **[projected from GEO's band census]**. Phase 1 alone emits fewer **[unknown until CST-C runs]** (§2.2). |
| **C18** | Teleport places | — | `beach-south` (170.5, 89.9) and `beach-east` (175.1, 95.5), for the −2 m variant with extended bounds. | **At +5 m:** `beach-south` at about (170.5, 90.6) on the S1 plateau **[projected; a test checks it lands on an open tile above SL]**. No `beach-east`, because there is no walkable east beach. TECH's two places apply to the −2 m variant. |
| **C19** | Frozen rectangle for validation | — | Use `stream.playable`, not `manifest.bounds`, which the −2 m variant widens. | **Adopted** in both variants. At +5 m the two are equal, but the decoupling keeps the −2 m and walkable-east options open. |
| **C20** | Ocean far geometry | A skirt of about 2.5 km past the band. | A clipmap of 96 × 96 cells: a 1 m core plus 5 rings, radius about 1,536 m, 44.4k vertices. | **A CDLOD grid** (Tidewater `src/core/CDLOD.js`, §8.2), which replaced the clipmap after the Tidewater review (2026-09-28): it morphs between levels instead of stitching rings, and culls nodes against the frustum and the sea mask. The far plane (`camera.maxZ` 2000 **[confirmed]**) bounds it. |

---

## §1 What is at the edges today

### 1.1 Method [confirmed]

- **Heights:** retail `.m` files under `work/extracted/Map/<z>/<x>.m`, read by `work/tmp/coast/sromap.py`. It
  matches the export's `terrain/*.bin` exactly: 0.0 m difference on five regions, checked through the converter's own
  `decodeTerrainBin`. Heights are file units / 10. The grid is 2 m.
- **Activity:** `Map/mapinfo.mfo` (a 24-byte header, then MSB-first bits; `packages/formats/src/mfo.ts`). This
  reproduces FIELDS.md's inactive list: 163–169 and 175 at z 103.
- **Water:** the per-block `waterType` / `waterHeight`. A cell is wet where the terrain lies below its block's plane.
- **Reachability:** `reach.ts` / `probe-reach.ts` load the export's `nav.bin` with `NavWorld` read-only (0.8–1.0 s,
  53.3 MB, 10,387 components) and label every 2 m tile.
- **Names and places:** `textzonename.txt`, `refregion.txt`, `teleportdata.txt`. Roads were traced from the client
  minimap tiles.

### 1.2 Where the retail world stops [confirmed]

```
active mask around the export (north up; P playable, E export ring, # active outside, . inactive)
 106 ..################.......................      x 147-162 continue north to z 106/107
 104 ..################.........###...........      x 172-174 at z 104 are active (Qin-Shi tomb exit)
 103 ..########EEEEEEEE.......EEEEE...........      x 163-169 and 175 at z 103: inactive (no .m file)
 102 ..########EPPPPPPPPPPPPPPPPPPPE..........
  ⋮  ##########EP  …  playable  …  PE.....###..    x 181-183: detached blocks (Thief Town)
  90 ##########EPPPPPPPPPPPPPPPPPPPE..........
  89 ##########EEEEEEEEEEEEEEEEEEEEE......#...
  88 ......###..####################..........      row 88: filler east of 162, hills 60-140 m at x 156-161
  87 ......###............................#...
     x=145                  x=175       x=185
```

| Side | Beyond the export | What it means |
|---|---|---|
| **East** (x ≥ 176) | Nothing at x 176–180. There are 68 detached regions at x 181–196 × z 87–114 (Thief Town at 181–183 × 91–97, `Town_Thief` at 182,96), and none touches the export. | The eastern end of the world. |
| **South** (z ≤ 88) | One more row, z 88 for x 156–175: filler at 0 m east of x 162, hills of 60–140 m at x 156–161. Then nothing, apart from fragments at x 151–153 × 85–88 and x 128–144 down to z 81. | The southern end of the world. |
| **West** (x ≤ 154) | Continuous land and river. The +5 m river continues at x 153–154 × 90–95. "Earth Ghost Canyon" is at 151–156 × 95–100, "Entrance-Western China Donwhang" at 152–156 × 101–103, and **Donwhang town** (`Town_Dunhwang`) at **152–153 × 102–103**. Its walled compound sits at about x 153.0–154.0 × z 102.05–103.55, inside the synthetic band. | **The way to the next town.** Two roads cross x 155: one at z ≈ 101.9 (from the WC ferry, past Donwhang's south wall) and one at z ≈ 103.0 (from Donwhang's east gate at about 154.0, 103.0). A third loops north through z 104–105. Donwhang's east wall is about 190 m west of the export edge **[confirmed on the client minimap, ±0.1 region]**. |
| **North** (z ≥ 104) | x 147–162 continue to z 106–107 (Western China Northern Road, Okmungwan Field). x 172–174 continue to z 104. Nothing exists north of z 103 for x 163–171. | Land only on the Western China side, which also leads to Donwhang. North of the lake the world just ends. |

So the export sits in the **south-east corner of the retail world**. East and south there is no town to connect to.
The only connection is **west and north-west to Donwhang**, through the Western China side, where the 91 nests that
cannot be reached on foot are (DEPLOY.md) **[confirmed in the docs]**.

### 1.3 How retail builds its edge [confirmed]

Retail does not end the land naturally. **High walls** enclose the fields, and outside them lie **flat filler
regions at exactly 0.0 m**:

- **41 filler regions** in X 150–177 × Z 88–104 are at least 97 % exactly 0.0 m: x 175 at z 89–100 and 102; z 89 at
  x 166–175; z 88 at x 156, 159 and 161–175; and 167–168 × 102 (the lake floor). The regions 157,88, 158,88, 160,88,
  165,89, 174,103 and 175,101 are 91–96 % zero.
- **The seams stay bit-identical, filler included.** All 929 seams match. A filler region keeps a thin rim of real
  heights and drops to 0 m within a few vertices (158,88: its north row is 100–113 m, matching 158,89, but it is
  already 0 m 12 m inside).
- 0.0 m also occurs **inside** real content (Jangan town's floor at 167–169 × 97–98 is 6–44 % zero). A filler
  detector must therefore work per region or by connectivity, not per pixel.
- Filler texture: tiles 2 (`c_grass_fld_03`), 4 (`c_dust_fld_06`, 65 % of row 89) and 7 (`c_grass_hmfld_01`, 37 % of
  column 175).

The walls:

- **East wall:** a knife-edge ridge at x ≈ 174.1–174.25, 100–135 m high, inside the playable column 174. East of it
  a **flat shelf at 25.0 m** runs to the bounds (x 175.0). Then the 0 m filler of column 175 begins, and the ground
  falls 25 → 0 m within the first 8 vertices (16 m). Profile at z 95.5: 35 → 124 → 25 → 0 m.
- **Jangan south wall:** a ridge at z ≈ 91.3, 110–160 m high. South of it the playable row z 90 is **flat 0 m** from
  z 90.8 to the bounds at z 90.0, and the ring row z 89 is filler. Profile at x 168.5: 0 m to z 90.8, 120 m at
  z 91.4, 25 m at z 92.
- **Tiger Mountains south wall:** crests of 244–354 m in the ring row z 89 at x 156–162 (200 m at 163, 147 m at 164).
  The export edge (z 89.0) cuts its outer slope at 44–125 m.
- **Tiger Mountains west wall:** ridges of 187–225 m at x ≈ 155.5, with the river at its foot (x 154.3–155.5).
- **Qin-Shi tomb backdrop:** the ring regions 171–173 × 103 are a retail mountain of 112–138 m that frames the tomb
  entrance plaza (170–174 × 101–102; `enterance-of-qin-shi-tomb` at 173,101). Its paving reaches within 12 m of the
  north bounds at x 172. Its outer (z 104) edge is back down at −5 … +19 m.
- **No road leaves the playable area on a sea side.** Jangan's paving (`c_marble_jang_*`) never occurs in row 89 or
  column 175 **[confirmed: texture-word census]**. Dirt tracks cannot be told apart by tile id, so a visual check in
  the viewer is still due **[unknown]**.

### 1.4 Edge survey by side [confirmed; full table: `work/tmp/coast/survey.md`, 74 region sides]

| Side, regions | Edge heights (m) | What is there | Beyond (retail) |
|---|---|---|---|
| N, 155–156 × 103 | −6.7 … 15.7 | Low sand ground; ridges of 52–90 m 90–110 m inside | Northern Road lowland |
| N, 157–161 × 103 | −12.9 … 3.1 | **Western China ruins basin, −5 … −19 m**: dry land below +5 m | Ruins, Northern Road |
| N, 162 × 103 | 0 … 97.6 | Mountain spur, 104 m crest | Unnamed mountain, mean 67 m |
| N, 163–169 × 102 (playable; 103 inactive) | **0.0**, 100 % under water | **The lake at +5 m** runs straight into the edge; bed −11 … −32 m | Nothing |
| N, 170–174 × 103 | −5 … 19 | Qin-Shi tomb hill, 112–138 m | Low ground at z 104 |
| E, 175 × 89–102 | **0.0** | Filler; the wall and the 25 m shelf are in column 174 | Nothing |
| S, 155–159 × 89 | 55 … 169 | Outer slope of the Tiger south wall | Row 88 |
| S, 160–162 × 89 | 0 … 68 | Wall foot; crests 271–354 m inside | Row 88 filler |
| S, 163–175 × 89 | 0.0 | Filler (163–164 hold the foot of a 147–200 m ridge) | Row 88 filler |
| W, 155 × 89–90 | −2 … 75 | Outer slope of the Tiger west wall | River bank |
| W, 155 × 91–95 | −25 … 6, 55–100 % under water | **The western river (+5 m)** | The river continues |
| W, 155 × 96–100 | −3 … 141 | Earth Ghost Canyon ridges up to 163 m | The same canyon |
| W, 155 × 101–103 | −13 … 67 | Entrance lowland; **both Donwhang roads cross here** | Donwhang at 152–153 |

Heights along the playable bounds line (vertices; share below −2 / 0 / +5 m) **[confirmed: `heightmap.py`]**: east
0 % / 1.3 % / 31 %; south 0 % / 0 % / 53 %; north 26 % / 30 % / 76 %; west 17 % / 19 % / 25 %. For the whole playable
area it is 10.6 % / 14.2 % / 32.0 %.

**Water surfaces** in X 148–178 × Z 86–106 **[confirmed: per-block census]**:

- **+5.0 m, 2,280 blocks** (2,006 inside the export). 1,829 of them are visible by the classic alpha rule. They form
  the whole river system: the western river, the Western China ferry basin, the channel between the Tiger and Jangan
  blocks (x ≈ 165, down to 165,90), the lake and swamp north of Jangan, and small pieces at 170 × 95–96, 172,99 and
  174 × 99–100.
- **Other levels, several inside the playable set:**
  - −2.0 m, Jangan's moat and canals (73 visible blocks);
  - −3 m (147 blocks in the export), −3.3 m (the pond at 168,97), −1 m and −0.3 m;
  - 0.0 m (33 blocks at 171–172 × 101–102, next to N5);
  - −5 m, −8 m, −4.5 m (Highland Oasis), +11 m and +31 m (171–172 × 92–93) and +99 m (162,96);
  - −12 … −19.8 m and +2.8 m in the ruins and on the Northern Road.
- **Consequence:** a sea mask that tests "water level ≤ sea level" would take in the moat and the ponds. The mask is
  a flood fill from the sea sides instead (C5).
- **Neither sea-edge water is held by a lip.** The +5 m lake and the x ≈ 165 channel stop exactly on the bounds line,
  over ground at 0 m (lake) and 0–1.7 m (channel mouth). All 36 blocks of 163–169 × 102 and 165 × 90 carry water;
  none in row 89 or in the 103 holes does **[confirmed: manifest blocks]**. Today those planes end in mid-air.
- **Dry land below +5 m:** Jangan town's floor is 0 m (the spawn is at y −3.26 m), the grassland south of town
  (166–170 × 92–99) has dry 5th percentiles of −8 … 0 m, and the ruins basin is −9 … −19 m. The retail datum is
  local: water planes are per block, and basins sit below neighbouring rivers.

### 1.5 Reachability at the edges [confirmed in `nav.bin` components; in-game untested]

- 1,910,810 terrain tiles are mutually reachable with the town's component (of 2,829,312 tiles in the 307 regions).
- **The Western China side** (most of 155–162 × 100–103 and 155–157 × 98–99) is a separate component: the known
  "unreachable on foot" area. 158–162 × 98–99 and the ferry basin's bed are mostly in the town's component.
- **River and lake beds are open terrain in the town's component.** The lake floor is mostly 88–100 % reachable
  (163,102 is 41 %). It runs to the north bounds under 16–37 m of water, and under only 5 m at the bounds line, where
  the floor is flat 0 m.
- **The west bound is reachable at x 156.0, z 96.1–97.8**: the river-mouth bed (−13 … −1 m) and the bank above it.
  This is the closest a player gets to the A/B difference (§4).
- **The flat strip outside Jangan's south wall** (z 90.0–90.8, x 166–174) is 86–100 % reachable, most likely along the
  x ≈ 165 channel bed **[likely]**. That makes S1 a real walkable beach.
  *(beaches fact-check 2026-09-29, G1: **wrong.** It is in the town's component only through ring tiles outside the
  bounds (row 89 and column 175). With every region outside the bounds closed, the S1 strip, the south end of the east
  shelf (174.8, 91.0) and the NE corner (174.5, 102.5) do not reach town; the x ≈ 165 channel mouth is part of the
  same pocket, walled off by the S3 ridge (56–136 m) and closed water at z ≈ 91.3 **[confirmed:
  `work/tmp/coast-beach-fc/inbounds-reach.ts` on `nav.bin`, outside regions closed and their object instances
  dropped; in-game untested]**. Since the server clamps every move to the bounds and has no path-finder (straight
  walks only), no player can walk to S1 today. The fix is part of S1, §3.5.)*
- **The 25 m east shelf** is closed at z 93–98. It is open at z 90–92 (73–93 %), 99 and 102, and 24–25 % at z 100–101.
- **Row 89 and column 175** are 96–100 % open and in the town's component. So is the Tiger flank in row 89 (17–68 %).
  Only the server's clamp to `manifest.bounds` keeps players out **[confirmed: `content.ts` reads `manifest.bounds`;
  `World.clamp` in `apps/server/src/world.ts` 719–724 is used by `connection.ts`, `gameplay.ts` and `gm.ts`]**.
- **Walking on beds is the retail rule, not a bug.** NAVIGATION.md §2: water is neither a walking surface nor a
  blocker, and the nav has no slope or step limit **[confirmed]**. How it looks in our client is untested
  **[unknown]**.

---

## §2 Sea level, extent and horizon

### 2.1 Sea level: +5.0 m (default), −2.0 m (alternative) (C1)

| | **+5.0 m (default)** | **−2.0 m (alternative)** |
|---|---|---|
| Why | It is the level of every connected water body at the edges: the lake (N3), the western river (W2) and the channel mouth (S2). **The lake becomes Jangan Bay**, the western river a strait, and every mouth meets the sea level with no step. | The 0 m flats on the east and south stay 2 m above the sea, so **no playable height changes** (0 % of the east and south bounds lie below −2 m). |
| Cost inside the bounds | **S1**: the flat 0 m strip outside the south wall (x > 165.35, z < 90.95, h < 6 m) becomes a beach plateau of +5.6 … +10 m. That is 52,705 samples in the mask (≈ 2.3 % of the playable lattice), with heights rewritten in 4 files (§3.5). Optional: blend the lake floor at the bay mouth (§14). | None. |
| Cost at the edges | Where low land inside the bounds meets the sea (the east bound at z 99–101, the tomb's north foot at 170,102, the ruins basin in phase 2), the pass builds a dune or berm crest outside the bounds. | Berms (sand bars) across the lake mouth and the S2 channel: 25,829 vertices in the second prototype **[confirmed]**. The +5 m water is copied one block across the bounds into the berm (C10). In phase 2 the western river needs a berm across the strait too. |
| Look | A single water level. Rivers flow into the sea, and the lake opens north into a bay (`preview-A.png`, `preview-B.png`). | The lake becomes a lagoon 7 m above the sea behind a sand bar 24–64 m wide, and the south channel ends at a bar. Beaches start right at the bounds line. |
| Masking | The town (0 m, spawn −3.26 m) is 8 m below the sea, and the ruins basin 14–24 m. The coast field masks them (§8.1). | The town is 1.3 m below the sea; the same mask applies. |
| Where the ocean meets retail water | At N3, S2 (and W2 in phase 2), retail +5 m water inside the bounds meets the ocean at the same level. The two must join flat (§8.1). | No join; the berms separate them. |

**Rules that hold for either value** (the rules for the other parts):

1. **The sea is never one plane under the map.** It is drawn only where the coast field's mask is set (§8.1): a
   flood fill from the sea-side border over `h < SL` that never enters dry playable ground and is never seeded on a
   land side. Ponds and moats keep their own planes.
2. **The retail per-block format cannot carry this coast** **[confirmed on the prototype]**. In 30 (A) or 34 (B)
   blocks, new sea shares a 32 m block with land-side ground at least 0.5 m below +5 m and at least 10 m inland. In 11
   of those blocks that low ground is inside the playable set (near 157,102, at 170,102, at the east bound z 99–101,
   and at the S2 mouth). A +5 m block plane there would show water over dry ground. The ocean therefore uses its own
   mesh with the field mask, and the retail water blocks that fall in the sea are removed.
3. **Dry land behind a beach can be lower than the sea** (the ruins behind N1, the tomb's north foot behind N5). The
   profile builds a **dune or berm crest** between them, with a target of SL + 3 … +5 m. Close to the bounds the blend
   eats part of it: at N1 (x 158.5) the prototype's crest is only SL + 1.7 m, 88 m past the bounds **[confirmed:
   measured]**. It is still closed: outside the playable set the sea touches dry ground below +5 m only in about 230
   scattered swash-line cells.
4. `seaLevelM` is one number in `content/coast/coast.json`. Every tool below takes it as input. Switching to −2 m is
   a config change, plus removing S1 from `allowHeightPatches`, plus a re-conversion.

### 2.2 Extent and cost (C4, C17)

| Constraint | Value | Source |
|---|---|---|
| Fog end | ≤ 250 m. The end is G11 × 250 m with G11 ≤ 1 in all 8 profiles of `environment.json`. Weather only shortens it (`weatherFogScale`). Classic fog is linear, 100 % at the end. PBR fog is exponential: 95 % at the end, about 99 % at 1.5 × and 99.9 % at 2.3 ×. Both use radial distance. Height fog only thickens downward. | **[confirmed]** `environment.ts` `FOG_RANGE_M = 250`, `world.ts` `envOut()`, `weather/env.ts`, `pbr/fog-plugin.ts` |
| Camera | ≤ 40 m orbit, far plane 2,000 m | **[confirmed]** `apps/game/src/screens/world.ts`: `upperRadiusLimit = 40`, `maxZ = 2000` |
| Streaming | Load radii 320 / 400 / 480 m, unload 460 / 560 / 660 m (Low / Medium / High; Ultra = High) | FIELDS.md §3.2; *(refresh 2026-09-29)* **[confirmed: `stream.ts` `STREAM_DEFAULTS`]** |
| Visible past the bounds | ≤ 290 m to the fog end. On PBR a residual contrast of 5 % → 0.1 % lasts to about 610 m. | arithmetic |

*(refresh 2026-09-29)* The fog numbers above are re-confirmed in the shipped `pbr/fog-plugin.ts`: 95 % at the fog end
(`FOG_95 = −ln 0.05`), the retail start kept, a height falloff of 80 m that only thickens downward, colour from
`SkyState.fogColor` or the 64-texel horizon ring (High+ only; Medium has no ring). SKY2 will replace the colour with
the sky-coloured haze (§8.13); the distances stay the retail ones, so this section's extent does not change.

**Computation domain:** the ring (192 m) plus 2 synthetic regions (384 m), so **576 m past the bounds on every side**:
X 153–177 × Z 87–105, which is **168 non-exported regions** (8 of them today's inactive holes). Option A adds the
corridor's retail regions x 150–152 × 96–104 (27 more). It covers the visible zone and the High load radius, so
streaming never shows a hole **[confirmed arithmetic against FIELDS.md §3.2's `d(region)` rule]**.

**Emission (TECH's rule):** a synthetic region is written only if some vertex is land, or water shallower than
`emitDepthM` = 8 m. Deeper regions are drawn by the ocean alone: at 8 m both water paths are opaque (Classic alpha =
depth / 3 m, TERRAIN.md §4; PBR Beer–Lambert is opaque past about 6 m on top of a shore alpha of `saturate(depth /
1.5 m)`, RENDER.md §7). The pass drops the 1.2 m seabed noise wherever the water is deeper than 8 m.

| Option (the band's 168 regions) | Land | Shallower than 8 m | Deep only (not emitted) |
|---|---:|---:|---:|
| B | 22–23 | 37–38 | 108 |
| A | 38–40 | 33–35 | 95 |

The counts come from GEO's prototype census **[confirmed]**. The ranges depend on the land test (fact-check recount).
Deep-only regions are 8–36 m at their shallowest and at most 41 m deep.

*(beaches 2026-09-29)* **With beaches everywhere** the domain gains the row z 86 (X 150–177 × Z 86–105; the band is
X 153–177 × Z 86–105, 193 regions). By the same land / 8 m rule, **107 band regions are emitted (60 land + 47
shallow) and 86 are deep-only** (the 25 of row 86 among them), against 73 (40 + 33) for the old Option A
**[confirmed: `work/tmp/coast-beach/census.py`]**. The lowered mountains move land outward (the Tiger beach's waterline
lies 331–464 m past the bounds), so more of ring 2 carries land. Cost **[projected from the per-region averages
below]**: +34 regions ≈ +8.7 MB raw and +1.6 MB brotli on disk; the coast field grows to 1,200 × 960 texels (4.6 MB;
5.2 MB with A's corridor columns). The resident worst case rises to **+11 regions on Medium and +17 on High**, at the
south-west corner of the bounds (156.0, 90.0), against +10 / +12 for the old geometry by the same count **[confirmed
arithmetic on the emitted set and `stream.ts`'s 400 / 480 m radii]**; §8.11B budgets it. It still never exceeds an
interior player's full disk **[likely]**. *(beaches fact-check 2026-09-29, G3: by the same count the old Option A's
worst was **+11 / +16 at the NW corner (156.0, 103.0)**, not +10 / +12, so the rise is 0 / +1 and the worst corner
moves from NW to SW; Low (320 m) is +7 at the SW corner and +8 at worst; the unload hysteresis (560 / 660 m) can hold
**up to +19 / +22** synthetic regions resident at the SW corner, of which only those in the frustum draw; at the beach
bench none is within 660 m **[confirmed: `work/tmp/coast-beach-fc/fc2.py`, `fc2b.py`]**.)*

Cost **[projected]**:

- **Disk:** about 60 (B) to 73 (A) emitted regions, plus A's 27 corridor regions. An exported region's terrain
  averages 256 KB raw and 48 KB brotli, and a land region's lightmap about 22 KB WebP. That comes to roughly 15–25 MB
  raw in `work/out` and 3–5 MB brotli in `work/out-opt`. Phase 1 alone emits fewer regions **[unknown until CST-C
  runs]**.
- **Client:** per synthetic region about 0.45 MB of GPU memory, 1 draw and 18,432 triangles (the index buffer is
  shareable) **[projected from FIELDS.md §2.3]**. A player at the coast now loads synthetic regions where today there
  is void. The peak never rises above what a player in the interior already loads, because an edge player's disk is
  at most as full as an interior one **[likely]**. TECH's worst case, with ring 1 fully emitted at the south-east
  corner, is +9 resident regions on Medium and +11 on High: +4–5 MB of VRAM and +9–11 draws **[confirmed arithmetic,
  `stream.ts` radii]**. *(beaches fact-check 2026-09-29, G3: GEO's Option A band, which the user chose, already gave
  +11 / +16 at the NW corner; the beaches numbers of §8.11B replace both.)*
- **Navigation:** none for synthetic regions. An absent region is closed terrain for `NavWorld`, and the clamp keeps
  moves out **[confirmed: FIELDS.md §3.8]**.

### 2.3 Horizon and fog [projected]

- Within 576 m every loaded region holds real sea or land, and the fog reaches 95 % at 250 m. SKY.md §4.1 has the sky
  dome **return the current fog colour below the horizon**. In modern mode that fog colour is the LUT horizon colour at
  1° elevation, mixed 30 % toward the retail fog (SKY.md §6.3) **[confirmed in the docs]**. The ocean uses the same
  fog (§8.6), so the sea meets the sky with no line.
- The **ocean mesh** (a CDLOD grid, C20, §8.2) replaces a static skirt. It matters when the fog is off (the viewer's
  `flags.fog`), for a future "clear day" setting past about 530 m, and for high views over the band's outer edge.
- On land sides (the corridor in A, the west in phase 1) the field's border is land, so the ocean does not draw past
  them (C16). Beyond the loaded land, the dome's fog colour closes the view, as it does today.
- The world map and the minimap need sea tiles for the new regions (§11).
- *(refresh 2026-09-29)* The dome still shows the fog colour below the horizon (`sky/sky-shaders.ts` header)
  **[confirmed]**. With SKY2 the fog becomes aerial haze coloured from the sky-view LUT just above the horizon in each
  view direction (Tidewater's `AirHaze.js`, `work/tmp/tidewater-notes.md`). The sea, the dome below the horizon and the
  far land must then all take **the same haze function**, or a line appears where the CDLOD sea meets the dome. That
  is the shared "horizon" seam of §8.13 (S-HAZE), jointly tested by I-CST and SKY2's lab.

---

## §3 The coastline

### 3.1 Principles

1. **The playable set keeps its retail heights, bit for bit**, except inside the `allowHeightPatches` rectangles of
   `coast.json`. At +5 m that is S1 only. At −2 m there are none. A frozen check enforces it (§6.4).
2. **The coast is a noisy offset curve**, not a square. The waterline sits at a signed distance `c` beyond the
   playable rectangle (in Option A, beyond the rectangle joined with the corridor):
   - `c = c0(section) + amp(section) · 0.8 · n1 + (4 + 6·T) · n2`;
   - n1 is value-noise fBm at 1,100 m, 5 octaves, normalised to unit σ; n2 is 90 m, 2 octaves;
   - `c ≥ 18 m` wherever the blended `c0` is at least 25 m. There is no clamp in the blend zones next to N3, S1 and
     S2, where `c0` passes through 0;
   - `c0` and `T` blend between sections with a 110 m Gaussian along the boundary, but never across a land edge
     (C12).
3. **Type field `T`** (0 = beach, 1 = cliff) is the section's value plus noise (260 m). It is **forced toward cliff
   where the shore is high**: `T = max(T, ((R̄ − 25)/45)^1.5)`, where R̄ is the height blurred over about 40 m.
   Headlands become cliffs and low gaps become coves. *(beaches 2026-09-29: **removed.** There is no type field;
   high ground at the shore is handled by the flank envelope, which lowers it to a beach slope, §3B.3.)*
4. **The ring keeps its retail relief away from the coast.** The field takes over within a 90 m smoothstep of the
   waterline, never nearer than 8 m past the bounds (TECH's `d0`, C3). The coast only **lowers** retail ground, with
   two exceptions: berms, and synthetic land beyond the export. Filler (0 m) is always replaced. In practice the ring
   still changes a lot near the coast **[confirmed: measured on the Option B prototype]**:
   - retail ground is lowered by more than 2 m in 16,913 cells, by up to 168 m and up to 80 m inland of the
     waterline;
   - it is raised by more than 2 m in 54,093 cells, by up to 27 m (the N1 berm over the ruins basin);
   - 21,106 dry ring cells become sea.

   Most of this is on the west and north-west (phase 2).

   *(beaches 2026-09-29: **"only lowers" is replaced.** On sea sides the ring outside the bounds follows the flank
   envelope of §3B.3: lowered where retail stands above it, filled where a retail outer face drops below it (relief
   under the envelope survives only as gullies of ≤ 6 m). Measured on the beaches prototype: > 2 m lower in 84,673
   ring cells (up to 150 m, 13.3 million m³ removed), > 2 m higher in 129,716 ring cells (up to 135 m, the old Tiger
   outer face and the filled river bed in column 155), and 4,313 dry ring cells become sea **[confirmed:
   `coast_beach.json`]**. The frozen-playable rule, the land edges and the retail inland water are unchanged.)*
5. **Beyond the export**, the land is the export edge continued outward (the nearest edge value minus 0.55 m per
   metre, smoothed). The beach or cliff profile then shapes it.
6. **Land edges are never modified** (C12). The land/sea fade lies wholly on the sea side, and no region is
   synthesised west of a split.
7. **Deterministic:** seed 1188, integer-hash value noise, no clock or random input. Re-running `coast.py` gave
   identical arrays **[confirmed]**. The Blender layer then wins where it is painted (§6).

### 3.2 Profiles (metres; SL = sea level; `v` = metres inland of the waterline, `w` = metres seaward) [projected, as coded in `coast.py`]

*(beaches 2026-09-29: the sea-cliff column and the rocky shore below are **superseded** by the beach kinds of §3B.2.
The beach column survives as the "wide" kind.)*

| Band | Beach (T = 0) | Sea cliff (T = 1) |
|---|---|---|
| Crest / cap | Dunes and backshore, 45–90 m inland: SL + 2.4 → + 5.0. Beyond 90 m the land may rise at ≤ 0.36 m/m (≈ 20°), and freely beyond 220 m. | The retail or extended ground, cut by the face |
| Upper beach / face | **Dry sand** 8–45 m: SL + 0.6 → + 2.4 (1:20) | **Face** `SL + 0.8 + 3.2·v` (≈ 73°), with ±2–3 m roughness at a 24 m wavelength |
| Swash / toe | **Wet sand** 0–8 m: SL → + 0.6 (1:13) | Boulders and a platform at SL + 0.8, with a floor of SL + 1 … + 4 m over the first 30 m |
| Near shore | Shallow shelf 0–120 m: 0 → 4 m deep (1:30) | Apron 0–25 m: 0 → 9 m (1:3) |
| Off shore | 120–300 m: 4 → 18 m; 300–700 m: → 35 m | 25–160 m: 9 → 25 m; 160–500 m: → 40 m |

- **Rocky shore** is the mix at T ≈ 0.5: short, steep grey shingle with no sand band. It covers the east wall and the
  strait.
- **Behind a beach**, where retail ground lies below the berm, the berm floor holds for 110 m and then relaxes to the
  retail ground over 170 m. The basin stays dry behind a dune ridge.
- The constants are a first guess. CST-C tunes them in `coast.json` against the viewer.

Measured sections of the prototype, Option B (`profiles.png`) **[confirmed: re-measured with `fc/prof.py`]**:

| Section | Profile |
|---|---|
| **S1** Jangan South Beach (x 170.5) | Wall crest 113 m at z 91.4. Foot 8–9 m at z 90.8. Backshore 8.0 → 5.6 m over about 58 m. **Waterline at z 90.30, 58 m inside the bounds.** Depth 1.8 m 10 m inside the bounds, 2.1–2.4 m just outside, and 13.7 m at the export edge. |
| **S4** Tiger cliffs (x 158.5) | Crest 214 m at z 89.45, 107 m at the export edge. **Face from about 103 m to 6 m over about 48 m (≈ 64°).** Waterline at z 88.70, 250 m past the bounds. Depth 10 / 17 / 26 m at 30 / 100 / 190 m out. |
| **E2** East wall (z 95.5) | Retail wall 124 m and shelf 25 m to the bounds. A synthetic scarp falls 25 → 5 m within about 20 m. **Waterline 22 m past the bounds.** Depth 9 m 30 m out. |
| **N1** Western China north (x 158.5; phase 2) | Retail basin at −19 m on the bounds line. Dune crest 6.7 m (SL + 1.7) 88 m out. Waterline about 138 m out. Tidal flats under 5 m deep to about 355 m. |
| **N5** Qin-Shi tomb (x 172.5) | Retail tomb hill (up to 124 m at z 103.4) kept in the ring. Beach at its foot. Waterline about 190 m past the bounds. |
| **W3** Earth Ghost cliffs (B only) | Retail ridges 80–92 m, about 75 m at the export edge, then a steep rocky slope to the waterline 112 m past it. |

### 3.3 Section table [projected] (`content/coast/coast.json` `sections`)

*(beaches 2026-09-29: **superseded by §3B.1**, where every row is a beach. The table below is the 2026-09-28 record.)*

`c0` is the waterline offset beyond the bounds in metres; negative means inside the bounds. The values are for
SL = +5 m. At −2 m, CST-C re-derives the S1, S2 and N3 rows (the S1 waterline then lies outside the bounds, about
40 m out, and N3 and S2 become berms).

| Code | Phase | Where | What is there (§1) | Type | c0 / amp | Notes |
|---|---|---|---|---|---|---|
| **N3** | 1 | North, x 163–169 | The +5 m lake runs into the edge; 103 inactive | **Jangan Bay** | −300 / 0 | No shore. The synthetic floor starts at the retail lake floor and deepens over 300 m, which leaves a shallow sill (about 5 m) outside the bounds. |
| **N4** | 1 | North, x 170 | Tomb hill's west shoulder | Rocky | ≥ 200 / 50 | C11: the ring is kept (`blendStartM` 192). |
| **N5** | 1 | North, x 171–175 | Tomb hill, low ground north | Beach below a hill | 245 / 60 | The tomb-exit road (`GATE_JINSI_OUT` 172.5, 102.87) ends above a beach. C11 applies. |
| **E1** | 1 | East, z 99–102 | Tomb hill's east face | Rocky / cliff | 120 / 90 | |
| **E2** | 1 | East, z 91–98 | Knife-edge wall, 25 m shelf | **Rocky shore** under a scarp | 105 / 95 | The shelf stays retail. The coast lies 20–120 m past the bounds (median 24 m). |
| **E3** | 1 | East z 90, SE corner | Wall corner | Rocky, then a sand spit | 170 / 90 | |
| **S1** | 1 | South, x 166–174 | Flat 0 m playable strip | **Beach, walkable** | −62 / 22 (clamped −105 … −12) | **The one in-bounds edit** (+5 m only). A plateau of +5.6 … +10 m. |
| **S2** | 1 | South, x 165 | Mouth of the x ≈ 165 channel | River mouth | −20 / 10 | The retail water continues into the sea. |
| **S3** | 1 | South, x 162–164 | Foot of a 147–271 m ridge | Cliff | 160 / 70 | |
| **S4** | 1 | South, x 156–161 | Tiger south wall | **Sea cliffs** ("Tiger cliffs") | 285 / 110 | The highest coast. The crest stays retail, and the face starts past the export edge. |
| **W1** | 2 | SW corner, z 90 | Tiger west wall | Cliff | 280 / 90 | In phase 1 the corner rule (C13) wraps the south sea under 155 × 89 instead. |
| **N1** | 2 | North, x 156–161 | Ruins basin, −5 … −19 m | Beach (dune berm) | 175 / 80 | The berm shields the dry basin. |
| **N2** | 2 | North, x 162 | Mountain spur | Headland cliff | 290 / 70 | West arm of the bay. |
| **W2** | 2 | West, z 91–96 | The western river | **Strait**, rocky | 120 / 60 | The waterline at x ≈ 155.4 lies inside the ring and cuts the Tiger west wall's outer slope into a cliff. |
| **W3** | 2 (B) | West, z 97–100 | Earth Ghost Canyon | Cliff | 265 / 100 | |
| **W4** | 2 (B) | West, z 101–103 | Entrance lowland | Beach (berm) | 195 / 80 | Both Donwhang roads run into the sea at x ≈ 155.0. |
| **A-S** | 2 (A) | Corridor south face, z ≈ 96.5, x < 156 | Earth Ghost Canyon flank | Cliff | 90 / 70 | |
| **A-N** | 2 (A) | Corridor north face, z ≈ 103.9 | Northern Road lowland | Beach | 95 / 70 | |

In phase 1 the whole west side is a land edge. The south coast ends at the south-west corner, where the corner rule
(C13) lets the sea wrap under 155 × 89 and the fade toward the untouched west lies on the sea side (C12)
**[projected]**.

### 3.4 What the prototype produces [confirmed: `coast_A.json`, `coast_B.json`]

*(beaches 2026-09-29: the beaches prototype's numbers are in §3B.6.)*

- The domain is X 150–177 × Z 87–105: 2,689 × 1,825 samples at 2 m on the retail vertex grid, with shared seams.
- It runs in 25–36 s per option in numpy. A TypeScript port in the converter would take a similar time
  **[projected]**.
- Land covers 47 % (B) and 54 % (A) of the domain. B has 76,624 cliff-face samples and 61,087 sand samples.
- 58,488 playable samples change: 52,705 inside the S1 mask and 5,783 in its blurred feather (§3.5).
- Heights range from −76 m (a retail pit at the tomb in B; the corridor in A) to 354 m. The sea floor is at most
  41 m deep.
- `coast_A_h16.png` and `coast_B_h16.png` are 16-bit test inputs for the round trip, not the final base.

### 3.5 Special places

- **Jangan South Beach (S1, +5 m).** From the wall foot (8–9 m), a backshore plateau falls to dry sand, wet sand and
  the waterline at about z 90.3. The bounds line lies in about 2 m of water, a natural place to stop wading; `c0` −45
  would make it 1.5 m **[projected]**. Converter rules, from the fact-check:
  - **Feather inward only.** The prototype's blur changes 5,783 samples outside the mask, by up to 11.8 m on the wall
    foot and at the strip's ends. It also cuts a **groove along the bounds line z = 90.0** (mean −0.9 m, down to
    −3.0 m), because the mask is cut off at the playable edge. The patch is limited to its `allowHeightPatches`
    rectangle, and the frozen check reports every changed vertex.
  - **Rewrite all four copies of the heights:** `terrain/<x>_<z>.bin`, the debug `navmesh/<x>_<z>.bin` (SRON), the
    client nav chunks `nav/<x>_<z>.bin` and `nav.bin` (`f32[97 × 97]` heights per region) **[confirmed: `packages/nav/
    src/serialize.ts`, `packages/convert/src/world/format.ts`]**. Open and closed cells stay as retail (the nav has no
    slope limit). If only the terrain changed, players would walk up to 10 m below the new sand.
  - The minimap tiles of the 9 regions 166–174 × 90 are redrawn inside a change mask (§11).
  - *(beaches fact-check 2026-09-29, G1)* **An in-bounds link to town.** S1 is a pocket that reaches the town's
    component only through ring tiles outside the bounds (§1.5), which the clamp forbids, and the coast closes part of
    that route (row 89 becomes sea deeper than 0.4 m, the east flank next to the line rises above SL + 12 m, §9.1).
    So S1 needs a walkable link **inside** the bounds, or it is a GM-only beach, and the converter's island rule
    (§9.3) may close it if no outside route survives **[unknown]**. Default: CST-C opens a
    short list of retail-closed tiles on gentle ground inside the bounds (`coast.json` `openTiles`, rectangles, each
    listed in the report and limited like `allowHeightPatches`), chosen by a nav search with every region outside the
    bounds closed. A tile-level search finds the cheapest link at about **5 closed tiles** along the east shelf's edge
    column and at the NE corner (x 172.0–175.0 × z 93.0–102.2), which makes the walk from town to S1 a long one down
    the east shelf **[confirmed: `fc4b.py`, 4-connected tiles; the exact nav set is CST-C's]**. A shorter route
    (opening the S2 channel bed north of z 91.3, or a graded cut through the south wall) needs in-bounds height or
    openness edits in town-side regions and is a user choice (§16 Q22) **[projected]**. The test is the same either way: S1 reaches the town's component with the ring closed.
  - **Without S1 at +5 m:** leaving the 0 m strip as it is under an adjacent +5 m sea would flood walkable dry ground,
    which breaks the mask rule. The look-only alternative is a **dune ridge just outside the bounds**: the strip stays
    retail and dry behind a berm, and the beach lies beyond it. It changes no playable height (§14).
- **Jangan Bay (N3).** The prototype starts the synthetic floor at the retail lake floor (flat 0 m along the bounds)
  and deepens it over 300 m. That leaves a sill about 5 m deep outside the bounds. Blending the playable lake floor
  deeper in its northern 40–60 m would change nav heights under water; it is left as a user option (§14).
- **River mouths (S2, W2).** The retail +5 m water continues seamlessly. Near retail water, the synthetic floor is
  blended from the retail bed.
- **East shelf (E2).** It stays retail. The bounds-line vertices are frozen and the blend starts at 8 m, so the top of
  the retail 25 → 0 m drop in column 175 stays. Rocks at its toe or a Blender touch-up of vertices 1–8 of column 175
  hide it.
- **Tiger cliffs (S4).** A face of up to about 100 m at ≈ 64°. Texture stretch needs triplanar rock, which RND-T does
  on High+ only and only on a cell's first layer, so the paint rules make rock the base layer of cliff cells
  **[confirmed: RENDER §6.2 step 4]**. Retail cliff rocks cover the toe on Low and Medium. This is the first place to
  hand-sculpt. *(beaches 2026-09-29: **superseded.** S4 is now the Tiger beach: the south wall's ring is lowered from
  up to 354 m to a 31° flank that reaches a 48 m mountain beach 331–464 m past the bounds, §3B.1 and
  `render-tiger.png`. No face, no triplanar need, no toe rocks.)*
- **Qin-Shi tomb (N4/N5).** Without C11 the "only lower" rule carves the 112–138 m retail mountain behind the plaza.
  The tomb's cliff meshes `c_jin_cliff_l` / `_r` (each about 116 × 96 × 242 m, placed in 172 × 102) would then overhang
  ground lowered by 76 m and 47 m, and two `stone_cliff01_02` rocks would sit over drops of 105–111 m **[confirmed:
  footprints sampled against the second prototype]**. With `blendStartM` 192 the ring there is bit-identical, and the
  coast starts at z 104, where retail already comes down to −5 … +19 m. This is the second hand-sculpt hotspot.
  *(beaches 2026-09-29: the rule is now the crest-keep rule of §3B.4: the crest stays, the 49° north face beyond it is
  regraded, and N5's beach sits at its foot.)*
- **Islets and sea stacks** off S4 and the E3 cape are not in the prototype. They would be cheap as noise-driven land
  blobs, or as Blender sculpts **[projected]**. *(beaches 2026-09-29: a sea stack is a small cliff by nature. With "no
  sea cliffs" the default becomes **low sandy islets with a beach all round** (sand bars off the Tiger beach and the E3
  spit), still later and still Blender sculpts; §16 Q17.)*
- *(beaches 2026-09-29)* **East shelf (E2).** The 25 m retail shelf at the bounds now falls at 27° to a 60 m bay beach
  whose waterline lies 107–144 m past the bounds; the retail knife-edge wall inside column 174 is untouched.

---

## §3B Beaches everywhere (beaches 2026-09-29)

The user: *"i dont want no sharp edges, all edges of the map if its near the water it should have a beachy area."*
Their answers: beaches along all of the sea coast, no sea cliffs, mountains at the edge sculpted down in Blender,
inland riverbanks and the lake retail. This section is the geometry for that. It replaces the cliff and rocky-shore
parts of §3 (the type field, the cliff profile, the old section table) and keeps everything else: the frozen playable
set (S1 excepted), one global 2 m lattice, the land edges, the corner rule, the fade on the sea side, integer-hash noise
and seed 1188.

**What counts as sea coast.** A shore is sea coast when the water in front of it is in the sea mask (the flood fill of
§5.3 step 7) and the shore lies outside the playable bounds. That covers every edge of the map that meets the sea,
the corridor faces, the arms of Jangan Bay and the W2 strait. It does not cover the lake and rivers inside the bounds,
the moat, the ponds, or any water that the fill does not reach: their banks stay retail **[decision, the user's
answer]**. Where a river meets the sea at the bounds (S2, the western river's mouth at x 156, z 96.1–97.8), the
retail bed stays open for about 120 m around the join, so the river keeps its mouth and the beach forms spits on both
sides **[confirmed: prototype, `near_join`]**.

### 3B.1 Section table: beaches all round [projected design values; measured columns confirmed on the prototype]

Every row is a beach. `c0` is the minimum waterline offset past the bounds (m); the real waterline lies further out
wherever the lowered mountain needs the room (the flank's toe + the beach width). The measured columns are the
prototype's 10th / 50th / 90th percentile of the waterline offset and the median land slope of its cross-section
**[confirmed: `coast_beach.json` `sections`, `census.json` `profiles`]**.

| Code | Where | Retail edge (bounds-line height) | Beach kind (§3B.2) | c0 / amp | Waterline past the bounds, measured p10 / p50 / p90 | Notes |
|---|---|---|---|---|---|---|
| **N1** | North, x 156–161 (phase 2) | Ruins basin, −19 … +18 m | wide, dune berm | 150 / 60 | 91 / 136 / 229 m | The berm shields the dry basin (as before) |
| **N2** | North, x 162: the bay's west arm | Spur, up to 97 m on the line (mean 61 m) | mountain | 120 / 40 | 59 / 169 / 180 m | Was a headland cliff; a spur cove beach now. Blender hotspot (§3B.7) |
| **N3** | North, x 163–169 | The lake at +5 m | bay mouth (no shore) | −300 / 0 | – | Unchanged: Jangan Bay |
| **N4** | North, x 170: the bay's east arm | 0–14 m | bay | 90 / 40 | – | Was rocky |
| **N5** | North, x 171–175 | Tomb hill, up to 120 m on the line, crest to 138 m | wide, under the kept crest | 245 / 50 | 174 / 229 / 364 m | Crest-keep rule (§3B.4) |
| **E1** | East, z 99–102 | 0–25 m | wide | 110 / 60 | 97 / 102 / 128 m | Was rocky / cliff |
| **E2** | East, z 91–98 | The 25 m shelf | bay | 95 / 60 | 107 / 113 / 144 m | Was a rocky shore under a scarp |
| **E3** | South-east corner (the east cape) | Up to 35 m | wide, a sand spit | 150 / 70 | – | Was rocky then a spit |
| **S1** | South, x 166–174 | Flat 0 m strip | walkable (wide) | −62 / 22 (clamp −105 … −12) | 43 / 105 / 123 m (the strip itself is inside) | Unchanged: the one in-bounds edit |
| **S2** | South, x 165 | River mouth | mouth, sand spits | −20 / 10 | – | Retail bed kept open around the join |
| **S3** | South, x 162–164 | Tomb-ridge foot, 111–210 m | mountain | 120 / 50 | 222 / 374 / 436 m | Was a cliff |
| **S4** | South, x 156–161 | Tiger south wall, 119–248 m | mountain | 150 / 60 | 331 / 379 / 464 m | **The Tiger beach** (was the Tiger cliffs) |
| **W1** | South-west corner | Tiger west wall, 183 m | mountain | 150 / 60 | (with W2) | Was a cliff |
| **W2** | West, z 91–96 | Tiger west wall, 67–150 m | strait | 90 / 40 | 93 / 249 / 433 m (W1 + W2) | The river bed in column 155 south of z 95.5 is filled by the beach (§3B.3) |
| **A-S** | Corridor south face | Earth Ghost flank, 4–157 m | mountain | 70 / 40 | 72 / 201 / 255 m | Was a cliff |
| **A-N** | Corridor north face | Northern Road lowland, −4 … 124 m | wide | 95 / 60 | 113 / 176 / 294 m | |

Section codes and positions are unchanged, so `coast.json`'s `sections` keep their `code`, `side`, `from` and `to`;
`type` is replaced by `kind` (§5.2).

### 3B.2 Beach profiles by kind [projected design values, as coded in `coast_beach.py` `KIND`]

From the sea to the land: shallow shelf, wet sand, dry sand, dune (or backshore), then the lowered flank where there
is a mountain. SL = +5 m. Depth is below SL; heights above it.

| Kind | Shelf: depth at 120 / 300 / 700 m offshore | Wet sand (swash) | Dry sand | Dune or backshore crest | Beach width (waterline → crest) | Flank grade behind it | Used by |
|---|---|---|---|---|---|---|---|
| **wide** | 4 / 18 / 35 m (1:30 near shore) | 0–8 m, to SL + 0.6 (1:13) | 8–45 m, to SL + 2.4 (1:20) | SL + 5.0 at 90 m | 90 m | 0.45 (24°) | N1, N5, E1, E3, A-N |
| **bay** | 5 / 16 / 30 m (1:24) | 0–8 m, to SL + 0.6 | 8–30 m, to SL + 2.2 | SL + 4.0 at 60 m | 60 m | 0.50 (27°) | N4, E2 |
| **mountain** (pocket beach under a lowered mountain) | 9 / 24 / 40 m (1:13) | 0–8 m, to SL + 0.6 | 8–24 m, to SL + 2.0 | SL + 4.0 at 48 m | 48 m | **0.60 (31°)** | N2, S3, S4, W1, A-S |
| **strait** | 8 / 20 / 34 m | 0–8 m, to SL + 0.6 | 8–20 m, to SL + 1.8 | SL + 3.5 at 40 m | 40 m | 0.60 (31°) | W2 |
| **mouth** (river mouth, sand spits) | 4 / 14 / 30 m | 0–8 m | 8–20 m, to SL + 1.6 | SL + 3.0 at 40 m | 40 m | 0.45 | S2 |
| **walk** (S1) | 4 / 18 / 35 m | as wide | as wide | SL + 5.0 | 60 m | 0.45 | S1 |

- The beach width varies ± 15 % along the shore with the 1,100 m coastline noise, and the waterline wobbles by ± 3 m at
  90 m, so no stretch is a ruled line **[confirmed: prototype]**.
- Behind a low beach (no mountain), the hinterland may rise gently (≤ 0.36 m/m) from 40 m behind the crest, and a
  basin below the crest stays dry behind the berm (held 110 m, relaxed over 170 m), as before.
- Measured on the prototype's cross-sections **[confirmed: `census.json` `profiles`]**: the Tiger beach at x 160 has
  56 m of sand, 2.6 m of water 30 m out, 9.9 m at 120 m and 21.9 m at 300 m; S3 at x 163.5 52 m of sand and
  9.5 m at 120 m; E2 at z 95.5 56 m of sand and 4.6 m at 120 m; the corridor south face (x 153) 78 m of sand.
  *(beaches fact-check 2026-09-29, G13: the W2 strait at z 92.5 has 38 m of sand but is **12.2 m deep 30 m out**,
  where the retail river bed beyond the export is blended in: a steep shoreface, not the strait kind's 8 m at 120 m
  **[confirmed: `census.json` profile W1/W2]**. Look-only; CST-C tunes it and LAB checks the swash there.)*
- Across all beach bands the land slope is ≤ 24.5° at the 99th percentile; 4 % of beach-band cells are steeper than
  15°, where a flank toe or a retail bank reaches into the band **[confirmed]**. CST-C tunes the numbers in
  `coast.json` against the viewer.

### 3B.3 How the mountains at the edge are lowered

The playable set is frozen, so a mountain cut by the bounds keeps its retail height **on** the bounds line: 110–248 m
on the south line at x 156–164, 67–183 m on the west line at z 90–95, up to 120 m under the tomb **[confirmed:
`H_dom.npy`, sampled on the lines]** *(beaches fact-check 2026-09-29, G14: the west line at z 90–95 is 41–183 m; the
low end is the river bank near z 95)*. Outside the line, in the export ring and beyond, the retail crests rise further
(Tiger: 244–354 m, 60–126 m past the line) and then fall as the old outer faces. The coast replaces that ring with a
**flank envelope** and then lets a person (or Claude) sculpt the character back in. Two layers, as the user asked:

**1. The procedural base (converter, CST-C).** Per lattice vertex p outside the bounds on a sea side, with q the nearest
point on the bounds line (or the corridor line) and d = |p − q|:

- `Hb` = the retail height at q, blurred along the line over 40 m at the line and 150 m by 200 m out, so a lateral
  change (a mountain beside a river mouth) decays outward instead of running to the sea as a side face;
- `s_in` = the retail slope arriving at q from 20 m inside, clamped to 0 … 0.9, blurred 40 m;
- the **envelope** E(d): a rounded shoulder over the first 80 m that continues `s_in` and turns to −g, then a
  straight fall at the kind's grade g (0.45–0.60), plus ± 8 m of ridge noise (170 m) in the middle of the flank. The
  shoulder is what stops a crease along the bounds line: from inside the playable area the retail slope carries on and
  rounds over a crest 30–50 m outside the line; *(beaches fact-check 2026-09-29, G11: only where the retail rises
  toward the line. `s_in` is clipped at 0, so where the retail **falls** toward the line from inside, the envelope
  starts flat at the 40 m-blurred `Hb` and the fill raises the falling outer ground to it: a **bench** 10–60 m out on
  about 3 % of the south line, 10 % of the west and east lines and 16 % of the north lines **[confirmed:
  `work/tmp/coast-beach-fc/fc5.py`, heuristic: inner slope steeper than 0.3 falling to the line, outer slope flatter
  than 0.1 within 10–60 m]**. CST-C lets `s_in` go negative down to −0.9 so the shoulder continues a falling slope
  too, or blends the fill in over the shoulder; the benches left are Blender hotspots.)*
- the **toe**: E meets the beach profile through a smooth maximum (10 m), so the foot is concave, never a kink. The
  waterline is placed at `max(c0 + noise, toe + beach width)`, so a tall mountain pushes its own beach outward;
- the **surface**: `min(retail, E)` where retail is higher (lowering), and where a retail face falls below E the
  surface follows E, keeping retail relief only as gullies of ≤ 6 m (`RELIEF`, from the 32 m-blurred retail). This is
  what turns the old outer faces into flank instead of leaving them as cliffs under the cap;
- a **blend** from the retail height over the first 40 m past the line (exact on the line; C3's "blend start ≥ 8 m"
  becomes "exact at 0, ramp 0–40 m"), and the synthetic smoothing (6 m) over the reshaped flank;
- river mouths within about 120 m of in-bounds sea-level water keep their retail bed and banks (`join_soft`); the
  rest of the retail water outside the bounds on the land side of a sea-side waterline is filled by the flank and the
  beach (the W2 river bed south of z 95.5).

  The prototype produces this in 31–35 s for the whole domain (numpy) **[confirmed]**; a TypeScript port in
  `coast/profile.ts` would be similar **[projected]**.

**2. The Blender sculpt pass (the hand layer, CST-B).** The procedural flank is honest but even (compare
`render-tiger-base.png` with `render-tiger.png`). The character (ridges and gullies, a spur here, a cove there, the
dune line) is added in Blender on top of the base, through the existing round trip (§6): `coast-export --from
procedural` → sculpt → `coast-import`, with the playable bounds masked and the validator as the safety net. The
prototype did one such pass by script on the Tiger flank (§3B.7). The authored layer wins where it is weighted and
the procedural base fills the rest (§6.3's merge rule, unchanged).

**Where the flank ends up** [confirmed: prototype]: past 100 m from the bounds, 0.73 % of land cells outside the bounds
are steeper than 45° and the 99th percentile is 44.4° *(beaches fact-check 2026-09-29, G6: on the procedural base;
after the scripted gully pass it is 1.19 % and p99 45.4°, and 17.8 % of flank cells exceed 37° [confirmed: `fc1.py`])*; past 40 m it is 1.6 % (p99 46.6°); the steeper cells within
40 m of the line are the retail slope carried over the shoulder. The flank's own median is its grade (24–31°); the
Tiger cross-sections show a 90th percentile of 36–40° with the gullies. The residual steep spots are the Blender
hotspot list of §3B.7.

**What a player sees from inside.** The Tiger south wall's outer crest (up to 354 m) is gone; from the Tiger heights
the view now runs over a rounded shoulder and down a green flank to a beach and the sea. The retail peaks **inside**
the bounds keep their shape, so from the sea they still stand steep behind the beach (`render-south.png`: the S3 ridge
behind the lowered headland). That is the frozen-playable rule, not a sea cliff: every edge that meets the water has a
beach in front of it.

### 3B.4 The Qin-Shi tomb backdrop rule

The retail mountain in the ring north of the tomb plaza (x 171.75–173.25) frames the plaza: crest 83–128 m, 14–88 m
past the bounds line, then a 49° north face down to −5 … +19 m at z 104 **[confirmed: column scan of `H_dom.npy`]**
*(beaches fact-check 2026-09-29, G14: re-scanned, the per-column crest is 80–138 m at 0–88 m past the line)*.
C11 kept all of it; with no sea cliffs, the north face is the problem. The rule now:

1. **Keep the crest.** For x 171.25–173.75, every ring vertex up to the crest line + 24 m (the crest distance per
   column, smoothed along x over 50 m) keeps its retail height bit for bit. That is 6,328 vertices **[confirmed:
   `tombKeepBitIdentical` true]**. The view from the plaza, whose paving reaches within 12 m of the bounds, is
   unchanged.
2. **Regrade beyond it.** From the keep line the envelope starts at the retail height on that line (smoothed along x
   over 120 m so there are no streaks), with no shoulder, and falls at the wide kind's grade (24°) to N5's beach. The
   waterline lies 174–364 m past the bounds. *(beaches fact-check 2026-09-29, G12: the keep line runs 24 m down the
   retail north face, so at x 172.75 the last 30 m kept are 47–58° and the regrade then starts at 11–15° for about
   30 m before 23–33°: a concave kink along the keep line, seen from N5's beach **[confirmed: profile of
   `coast_beach.npz`]**. CST-C joins the kept face and the regrade with a smooth maximum over about 20 m (as the toe),
   outside the keep so the plaza view is untouched, and the crease test of §12.13 runs along the keep line too.)*
3. **Models.** The plaza's two cliff meshes `c_jin_cliff_l` / `_r` (at 172.20 and 172.82 × 102.5, ± 121 m deep along
   z, so they reach z 103.13) stand on unmoved ground: a 9 × 9 footprint sample of every placement in 169.5–175 ×
   101.5–104 finds none over ground moved by more than 0.5 m **[confirmed: `census.py`]**. The converter's footprint
   test (C9) keeps checking this; if a retune moves the keep line inward, the test fails first.
4. **Hand work.** The regraded face is the second Blender hotspot: a person should shape it so it reads as the back of
   the same mountain (a spur or two toward the beach), not as a smooth ramp.

### 3B.5 Retail objects and props on the lowered ground

The C9 rule stands and runs by placement uid (S-TREE): vegetation whose origin ground moved by more than 0.5 m is
re-snapped if the new ground is at least SL + 0.5 m and dropped otherwise; every other model whose origin ground moved
by more than 0.5 m is dropped and listed; the footprint test lists big models that overhang moved ground. Counted on
the prototype for every placement outside the playable set in the domain **[confirmed count; the vegetation / other
split is by model path, likely]**:

| | Old Option A | Beaches everywhere |
|---|---:|---:|
| Placements on ground moved by > 0.5 m | 83 | **97** |
| Vegetation re-snapped | 8 | **19** |
| Dropped: new ground below SL + 0.5 m (in the sea) | 65 | **50** |
| Other models dropped and listed | 10 | **28** |

*(beaches fact-check 2026-09-29, G16: the census tests "below SL + 0.5 m" first, so the 50 include non-vegetation
models in the sea; C9 drops **and lists** every non-vegetation model on moved ground, so the list is the 28 plus those
[confirmed: `census.py`].)*

- The listed kinds are mostly the Western China gorge pieces (`w_cd_ravi_gorge02..04_01`, `w_cd_ravi_b_gorge01_01`),
  small cliffs (`cj_cd_cliff_s_04`, `_06`), rocks, a Buddha wall and statue (`w_cd_budawal`, `w_cd_budaa01`) and
  castle-wall pieces. They sit in the corridor-adjacent ring and the tomb's west side **[confirmed: census list]**.
  They are look-only (outside the bounds). Default: drop them; the Blender pass re-places the few that matter as
  `props.json` entries on the new ground (§6.2's props workflow).
- Nothing inside the playable set moves, so no nest, NPC, gate, portal or quest target is affected **[confirmed:
  frozen check]**.
- New props: none needed for cliffs any more (the old "cliff rocks at the toe" scatter, §10.3, is replaced by a sparse
  boulder scatter on the flanks and at the ends of the beaches, retail `stone_field01..05`, every 60–120 m, slope
  25–40°) **[projected]**. Driftwood or seaweed would be new models, which this wave does not add.
- Coast vegetation: GRASS_LIFE's own grass grows wherever the splat says grass, so the flank's grass paint (§7)
  gets its grass without coast work; the dune gets that spec's small plants or nothing **[likely; seam S-LIFE,
  §8.13]**. *(beaches fact-check 2026-09-29, G7: only if the paint keeps grass tiles on the flank's own slopes: the
  flank median is 31.9° and 77 % of it is steeper than 30°, so §7's paint thresholds move to 38° / 45°.)*

### 3B.6 What the prototype produces [confirmed: `coast_beach.json`, `census.json`]

- Domain X 150–177 × Z 86–105: 2,689 × 1,921 samples at 2 m; 31–35 s in numpy; deterministic (seed 1188).
- 0 changed playable vertices outside the S1 patch (61,344 inside its mask and inward feather, as before).
  *(beaches fact-check 2026-09-29, G2: 52,726 are inside the mask and **8,618 outside it, changed by up to 15.7 m**:
  the prototype still blurs the mask outward, and the "0" is measured outside the blurred mask. The converter's
  inward-only feather (§3.5) and the frozen check remove them.)*
- Land ~~55.5 %~~ **55.9 %** of the domain (Option A was 54.4 %); sand ~~227,714 samples ≈ 0.91 km²~~ **231,896
  samples ≈ 0.93 km²** (was 75,366 ≈ 0.30 km²). *(beaches fact-check 2026-09-29, G4: the struck values were run 1 of
  6; the rest of this list is the final run.)*
- Ring changes: 84,673 cells lowered > 2 m (max 150.5 m), 129,716 raised > 2 m (max 134.9 m), 13.3 million m³
  removed, 4,313 dry ring cells now sea.
- The tomb keep: 6,328 vertices, bit-identical.
- Heights −75 … 257 m (the old maximum 354 m was the Tiger crest in the ring).
- Emitted band regions 107 of 193 (§2.2); changed export regions 74 of 307 (§9.4); placements 97 (§3B.5).
- A retail hole: 76 vertices at (162.8, 104.4), outside the export, read −2,159 m; the prototype and the converter
  treat heights below −200 m as missing **[confirmed]**. *(beaches fact-check 2026-09-29, G5: 58 vertices are below
  −200 m (min −2,158.9 m); 76 is the count below −100 m, so an 18-vertex rim at −100 … −208 m is not a hole by the
  rule. Region 162 × 104 is beyond the export, which §5.3 step 4 replaces by the extended edge, so the converter does
  not read it **[likely]**; `holeBelowM` then only guards a future export widening, where it should be −100 m. The
  prototype's N2 "max raised 171.8 m" is this pit.)*

### 3B.7 The Blender workflow (the user can watch it or do it by hand)

The round trip of §6 is unchanged; what is new is that the start point is the beach base and the work is the
mountains. It was exercised end to end on the Tiger flank **[confirmed: `work/tmp/coast-beach/rt/`, Blender 5.2.2]**:

| Step | Command (prototype; production verbs in brackets) | Result |
|---|---|---|
| Bundle | `python make_bundle.py` (`pnpm sro coast-export --area 156-161,87-90 --from procedural`) | 577 × 385 lattice, −14.8 … 257.0 m |
| Build `.blend` | `blender -b --factory-startup -P …/coast/blender/build_edge.py -- <bundle> <tiger_base.blend> <oblique> <topdown>` | 6.5 s; 222,145 vertices, 442,368 triangles, `.sculpt_mask` on the playable part |
| Sculpt pass | `blender -b <tiger_base.blend> -P sculpt_pass_gullies.py -- <bundle> <tiger_sculpted.blend>` | 4.5 s; 80,350 vertices moved by > 2 cm, ≤ 8.42 m |
| Readback | `blender -b <tiger_sculpted.blend> -P …/coast/blender/readback_edge.py -- <bundle> <out>/content/coast` (`pnpm sro coast-import`) | 3.6 s; 14 region layers (LA16) |
| Determinism | the readback twice | identical SHA-256 for every layer |
| Validate | `pnpm tsx work/tmp/coast/validate-edits.ts <out>/content/coast` | **0 errors**: no weighted vertex inside the bounds, all seams equal, no weighted edge vertex without its neighbour file. (Its "quantisation" figure compares with the retail bins and is meaningless on a procedural base; against the bundle base the unweighted vertices are within 23.3 mm, the prototype's 2 cm weight threshold plus half a step. Production uses 1 mm and a smooth weight, §6.4.) |
| Merge | `python apply_layers.py` (the converter's `h = lerp(h, override, weight)`) | `render-tiger.png` |

**The gully pass** (`sculpt_pass_gullies.py`) does what a person does with the Draw Sharp and Crease brushes on a
flank: V-shaped gullies about 55 m apart across the slope, stretched about 220 m down the fall line, softened by a
brush-like falloff, on slopes of 12–55° above SL + 8 m only. It honours the same protections as a brush: the
`.sculpt_mask`, a 30–90 m fade outside the bounds line, and a locked area border. It writes vertex positions,
because sculpt operators crash Blender in background mode (§6.6).

**Three ways to run a sculpt session** (default: the first two):

1. **Claude by script, headless** (as above). The user sees the before/after renders and the viewer. Scripted passes
   for this wave: `gullies` (flanks), `spurs` (break a long flank into two or three spurs toward the beach), `dunes`
   (hummocks and blow-outs on the dune line), `cove` (pull a stretch of shore in by 20–60 m). Each is a small script
   with a seed, a mask and a fade, so it is repeatable and reviewable **[projected]**.
2. **The user watches.** The same verb opens Blender with its window (`--watch`: Blender without `-b`, running the pass
   through `bpy.app.timers` a few strips per step with viewport redraws), so the user sees the flank change and can
   stop it, undo, or pick up a brush in the same session. Nothing is downloaded: this is plain Blender with a script,
   not a Blender MCP add-on **[projected: not run in this study, because it opens a window on the user's desktop;
   sculpt operators may work in the GUI where they crash headless, unknown]**.
3. **The user sculpts by hand.** `pnpm sro coast-export --area <x0-x1,z0-z1> --from procedural` opens a `.blend` with
   the terrain, the sea-level plane, the playable bounds drawn on the ground (masked, so brushes cannot move it) and
   region labels. Useful brushes: Grab (move a headland), Smooth, Draw Sharp / Crease (gullies), Flatten (a beach),
   Layer (a dune). Save, then `pnpm sro coast-import --blend <file>` validates and re-converts; the viewer shows the
   result. A five-minute first session doubles as the §15 mask check.

A Blender MCP connection stays optional and needs the user's go-ahead (a download and a config change); it would add
the same live window driven turn by turn from chat (C15).

**Hotspots for the hand pass** (the residual steep or plain spots of the base, in order) **[confirmed: slope census,
`diag_slope.png`]**:

1. The S2 river-mouth bank (164 × 89): the retail bank of the channel carried outward (kept by the river-mouth rule);
   soften it into a spit.
2. The tomb's regraded north face (172–173 × 103–104) (§3B.4). *(beaches fact-check 2026-09-29, G12: first the
   kink along the keep line, where the kept 47–58° face meets an 11–15° start of the regrade.)*
3. The corridor's south face zone (151–154 × 95–96) and north side (151–152 × 104): retail canyon relief next to the
   look-only corridor.
4. The N2 spur cove (162 × 103–105).
5. The Tiger flank (156–163 × 87–89): the gully pass as prototyped, then spurs.
6. The Tiger west flank and the W2 strait (153–155 × 88–96).
7. *(beaches fact-check 2026-09-29, G11)* Any bench left after CST-C's shoulder rule, mostly on the north (N1, N2,
   N4, N5) and the west and east lines, where the retail falls toward the bounds line from inside.

Each is one or two export areas of 3 × 3 to 6 × 4 regions; the areas must not overlap in one import (the validator's
seam rule), and each is its own reviewed commit of `content/coast/height/` **[projected]**.

## §4 The land corridor: Option A or Option B

| | **Option A: land bridge to Donwhang** (recommended) | **Option B: all coast (Jangan island)** |
|---|---|---|
| Shape | Land continues west from the Western China side at z 96.55–103.85 through Earth Ghost Canyon and the Entrance area, using the **real retail regions** x 150–154 as look-only land (Donwhang town at 152–153 × 102–103 is inside it). Cliffs (A-S) run along its south flank, above the strait, and a beach (A-N) along its north. | The Western China side ends in cliffs (W3) and a beach (W4) at x ≈ 154.6–155.0, and the western river opens into the sea. |
| Blocked by | The bounds (x ≥ 156, unchanged) plus a scenery gate or landslide at x ≈ 155.5, spanning **both** roads: z ≈ 101.7–103.2. | Nothing needed. |
| Future Donwhang | Widen the export and the bounds west. The road, terrain and walls are retail, so the join is seamless **[likely]**. | Needs un-coasting W3/W4 (re-run with A's table). That looks like a retcon to anyone who saw the sea there. Until then, B also puts Donwhang's walled compound (x 153–154) under the sea. |
| Seen today | **From one reachable spot only** **[confirmed: A-minus-B difference of the heightfields, against `reach.bin`]**: the river-mouth bed and bank at the west bound (x 156.0, z 96.1–97.8). From there the nearest height difference is 109–158 m away, and the nearest sea-against-land difference is 192–272 m away. The fog starts at G10 × 250 m, which is 50–190 m depending on the profile and the hour, so the view there ranges from clear to about half fogged. The Jangan Ferry (158.3, 96.7) is about 630 m from x 155. The Western China side is otherwise not reachable on foot. | The same spot, mirrored: the W2/W3 west end instead of A's corridor cliff. |
| Cost | 45 look-only retail regions at x 150–154 × 96–104 (all exist and are active); 27 of them are outside the band. About 40 of the band's regions carry land. Terrain only; Donwhang's objects can wait **[projected]**. The field marks the corridor as land (C16). | About 23 synthetic regions with land. |
| Matches the request | "beaches … where it doesn't continue to next town": **yes**, because it continues to Donwhang. | Makes Jangan an island, also a valid reading. |

**Recommendation: Option A** **[projected]**. It follows the user's wording, keeps Donwhang open without undoing any
coast, costs almost nothing visible today, and remains one data table: switching later is a converter re-run.

### 4.1 Jangan island: the drowned area (2026-10-06)

The user: "delete the Donwhang map from the Map, including the map player sees … only the Jangan region … pure
surrounded by water, the ocean". The world map showed the Western China desert across the strait (x 150–163,
z 96–105: Western China Ferry, Main Road, Ruins, Entrance-Western China Donwhang, Earth Ghost Canyon, Okmungwan Field,
and Donwhang town's regions 153 × 102–103) and Option A's land bridge running off the map's west edge, all of it retail
terrain in the export (x 155–162 inside the play bounds, unreachable on foot) or the corridor's look-only land.

**What changed.** `content/coast/coast.json` `drown` (`packages/convert/src/world/coast/drown.ts`, after the pass and
the authored layers, before the banks, the paint and the sea masks):

- `regions`: whole regions under the sea (a vertex drowns when every domain region sharing it does, so a kept
  neighbour stays bit for bit): X ≤ 162 × Z 100–105, X ≤ 161 × Z 99, X ≤ 158 × Z 98, X ≤ 155 × Z 97, X ≤ 154 × Z 96;
- `soft`: the strait's nameless border regions (159–161 × 98, 156–157 × 97, 162 × 99), where Jangan's own shore runs:
  their water, their ground below the sea level and the cut-off desert bits and the islet drown, Jangan's land stays;
- `areas`: the corridor's south flank (X 145–154.8 × Z 95–96) and the west of 155 × 96 (to X 155.68);
- a dry island the cut leaves (under `islandMaxKm2` 0.5) drowns with it (7 slivers);
- the ground: from Jangan's shore down at `rampDeg` 24° to the sea level, a strip of beach, then at 6° to a floor
  2 m deep at the shore and 45 m (`depthM`) from 450 m out (`shelfM`), smoothed; next to kept water its bed carries
  on over 60 m. Classes from the new height; out of play, no retail water, no land fade.

Downstream it is open sea like the rest of the ring: the coast field's ocean, C9 drops every placement standing in it
(853 in all with the coast's own, the desert's buildings, ruins and trees; the World Editor's two dunhuang rocks on the
S1 beach still find their template among the converted placements, `WorldPassContext.retail`), the source treats a
drowned region as ring (its retail water blocks go, the knee-deep nav rule closes the deep sea), the minimap tiles are
our render (the sea's teal runs on from the kept strait water, `LINE_STRETCH`), drowned sea is emitted as synthetic
regions down to 40 m so the tiles reach the open-sea tone before the tile-less sea, `zones.json` gives drowned regions
no name, area, continent or town (and the coast sections whose line lies there, N1, N2, A-S and A-N, name nothing), no
manifest place is made there, and `content/places.json` drops `western-china-ferry`. The corridor and its sections stay
in the file; everything they shape is drowned. Option A's §4 notes and §5.5's "link to Donwhang later" now need a re-run
with `drown` trimmed.

**Numbers** (convert-region, 2026-10-10, with the open water): 122 drowned regions, 81 synthetic regions (was 107), 388
regions in all, 6,148 placements (was 7,171), the world map X 152–176 × Z 86–105 (1,600 × 1,280), 65 terrain tiles (was
108), 29 tree species (was 35: reeds and the five Dunhuang families stood only on the drowned side; the tree swap
appends a species only for placed models), `work/out/world/jangan-fields` 390 MB (was 451), out-opt 335 MB (was 373).

**The Climb (decided 2026-10-10: keep Jangan alone).** The Climb's top bands sat on the drowned side. They moved onto
the island's own heights (docs/CLIMB.md D52): B7 the Ferry Heights, B8 the Sea Cliffs, by region places inside the Tiger
Mountains' zones; the far bank's 124 nests are in `content/nests.override.json`'s `remove` list.

**The old strait and the bay (2026-10-10).** The in-bounds retail water at the sea level north-west of the island (the
strait's kept part along the ferry landing, and Jangan Bay) kept its retail plane at first: on the maps it showed as
flat teal region squares next to the deep sea, in 3D as river water meeting the ocean at block lines. `drown.openWater`
(continuous rectangles) makes it open sea in whole 32 m blocks (`masks.opened`): out of play, its blocks removed
(the ocean draws it), C9 drops only the plants whose ground is below the sea level there (the piers and the rocks in
the water stay). The bed of the open water and
of the drowned sea inside those rectangles is smoothed (90 m) away from the shore (80 m), so the lake bed's holes and the
pass's shelf meet in one basin; the bay mouth's sand bar and the hooked tip of the Western Strait beach are drowned
(two `areas`). The minimap's teal now falls off from the **real shore** everywhere: every sea vertex out of play
takes its distance to the nearest dry ground as `s`, never the distance to the bounds line. The checks exempt the open
water's shore from the beach rule and its bed from the river-mouth keep (`masks.openBed`).

**Regenerate** (after a change to `drown` or the coast):

```sh
pnpm sro convert-region --preset jangan-fields
pnpm sro siege-walls nav --world jangan-fields --no-opt   # the export's siege/ files (keep siege/models)
pnpm tsx packages/convert/src/tools/export-data.ts --zones-only
pnpm tsx packages/convert/src/tools/optimize-out.ts run --files @<changed-files.txt> --precompress
```

`convert-region` writes over the export folder and leaves files of regions it no longer emits: move the old folder
aside first (keep its `siege/models` for the next step), and convert **in place**, never with `--out` into another
folder: the tree swap reads the built species from `<out>/../../trees` (`work/out/trees`), so an export written elsewhere
silently stays retail (no `#species` models). The `--files` list is every file
of `world/jangan-fields/` that changed or went (a removed one is removed from out-opt too) plus `data/zones.json`;
`run --only world/jangan-fields/` would rebuild `slim.json` without the actors' animation packs.

---

## §5 The converter step

### 5.1 Where it lives

- A new module folder `packages/convert/src/world/coast/` runs inside `convert-region` when the preset names a coast
  config: `WORLD_PRESETS['jangan-fields'].coast = 'content/coast/coast.json'`.
- Retail archives are only read, as today (`openArchive` → `Pk2Archive.read`).
- `pnpm sro convert-region --preset jangan-fields` always rebuilds the coast from retail plus `content/coast/`.
- No 9A or 9B lane owns or edits `convert-world.ts`, `manifest.ts` or `worldmap.ts` **[confirmed: grep of WAVE_PLAN3
  and TEXPIPE]**. *(refresh 2026-09-29: still true after wave 9; both files were last changed in wave 3, commit
  `ae538d2` [confirmed: `git log`]. SKY2 and TREES do not plan converter edits as far as the backlog says [likely];
  WAVE_PLAN4 checks the three specs' file lists against each other.)*

### 5.2 `content/coast/coast.json` (authored, small, reviewed like other content)

```jsonc
{
  "format": "sro-coast", "version": 1,
  "seed": 1188,                                   // C14
  "seaLevelM": 5.0,                               // C1; -2.0 is the supported alternative
  "option": "A",                                  // A | B: which phase-2 sections apply (§4)
  "domain": { "x": [153, 177], "z": [87, 105] },  // region units; A adds the corridor regions below
  "emitDepthM": 8,                                // emit a synthetic region only with land or water shallower than this
  "landEdges": [                                  // never modified, never seeded by the sea mask (C12)
    { "side": "north", "from": 155, "to": 162, "phase": 1 },   // land in phase 1; sea (N1, N2) in phase 2
    { "side": "west", "phase": 1 },
    { "corridor": { "x": [150, 155.99], "z": [96.55, 103.85] }, "option": "A" }
  ],
  "sections": [                                   // §3.3, one row each; phase 2 rows carry "phase": 2
    { "code": "S1", "side": "south", "from": 166, "to": 174, "type": 0.0, "c0": -62, "amp": 22, "clamp": [-105, -12] },
    { "code": "N4", "side": "north", "from": 170, "to": 170, "type": 0.5, "c0": 200, "amp": 50, "blendStartM": 192 },
    { "code": "N5", "side": "north", "from": 171, "to": 175, "type": 0.0, "c0": 245, "amp": 60, "blendStartM": 192 }
    /* … N3, E1–E3, S2–S4, W1, and phase 2: N1, N2, W2–W4, A-S, A-N … */
  ],
  "profile": { "blendStartM": 8, "blendM": 90, "cliffRiseM": [25, 45], "noise": { "n1M": 1100, "n2M": 90, "typeM": 260 },
               "beach": { /* §3.2 */ }, "cliff": { /* §3.2 */ }, "dropNoiseBelowM": 8 },
  "berms": { "auto": true, "crestAboveSeaM": [3, 5], "holdM": 110, "relaxM": 170 },
  "allowHeightPatches": [                         // in-bounds edits; empty at -2 m
    { "name": "S1", "x": [165.35, 175.0], "z": [90.0, 90.95], "maxHeightM": 6.0, "feather": "inward" }
  ],
  "placements": { "resnapVegetation": true, "dropBelowSeaM": 0.5, "dropMovedM": 0.5 },   // C9
  "paint": { "palette": [ /* index → tile2d id, tiling code, name, Blender swatch colour (§7.1) */
      { "i": 1, "tile": 407, "code": 0, "name": "sand",        "rgb": "#d6c9a0", "typeName": "Sand" },
      { "i": 2, "tile": 412, "code": 0, "name": "sand-pebble", "rgb": "#c9bb92", "typeName": "Sand" },
      { "i": 3, "tile": 70,  "code": 0, "name": "wet-sand",    "rgb": "#9c8c6a" },
      { "i": 4, "tile": 534, "code": 0, "name": "shingle",     "rgb": "#8f8570" },
      { "i": 5, "tile": 226, "code": 0, "name": "rock",        "rgb": "#6d6a64" },
      { "i": 6, "tile": 278, "code": 1, "name": "cliff",       "rgb": "#76736c" },
      { "i": 7, "tile": 154, "code": 0, "name": "seabed",      "rgb": "#7c705a" } ],
    "rules": [ "cliff as base layer if slope > 0.9", "wet-sand if h < SL + 0.6", "sand if h < SL + 3.5 on sea sides",
               "seabed if h < SL - 0.5" ],
    "allowInsideBoundsM": 48 },                   // paint only (never heights) may reach this far inside the bounds
  "places": [ { "name": "beach-south", "x": 170.5, "z": 90.6 } ],  // C18; region units
  "ocean": { "mapColor": "#2a5d7c", "fieldMetresPerTexel": 4 }
}
```

The field names are the design **[projected]**. CST-C fixes the schema in `coast/config.ts` with
`validateCoastConfig`.

*(beaches 2026-09-29)* What changes in `coast.json` for beaches everywhere **[projected field names; values from
`coast_beach.py`]**:

```jsonc
{
  "domain": { "x": [153, 177], "z": [86, 105] },                 // one more row south (B5)
  "sections": [                                                   // "type" is gone; every row names a beach kind
    { "code": "S4", "side": "south", "from": 156, "to": 161, "kind": "mountain", "c0": 150, "amp": 60 },
    { "code": "N5", "side": "north", "from": 171, "to": 175, "kind": "wide", "c0": 245, "amp": 50 }
    /* … the §3B.1 table … */
  ],
  "beachKinds": {                                                 // §3B.2; widths m, heights m above SL, depths m
    "wide":     { "width": 90, "wet": [8, 0.6], "dry": 2.4, "dune": 5.0, "grade": 0.45, "depth": [4, 18, 35] },
    "bay":      { "width": 60, "wet": [8, 0.6], "dry": 2.2, "dune": 4.0, "grade": 0.50, "depth": [5, 16, 30] },
    "mountain": { "width": 48, "wet": [8, 0.6], "dry": 2.0, "dune": 4.0, "grade": 0.60, "depth": [9, 24, 40] },
    "strait":   { "width": 40, "wet": [8, 0.6], "dry": 1.8, "dune": 3.5, "grade": 0.60, "depth": [8, 20, 34] },
    "mouth":    { "width": 40, "wet": [8, 0.6], "dry": 1.6, "dune": 3.0, "grade": 0.45, "depth": [4, 14, 30] }
  },
  "flank": { "shoulderM": 80, "maxInSlope": 0.9, "lineBlurM": [40, 150, 200], "reliefM": 6, "reliefBlurM": 32,
             "ridgeNoise": { "ampM": 8, "wavelengthM": 170 }, "toeSmoothM": 10, "blendM": 40 },
  "riverMouthKeepM": 120,                                         // retail bed kept around in-bounds sea-level water
  "tombKeep": { "x": [171.25, 173.75], "beyondCrestM": 24, "crestSmoothM": 50, "lineSmoothM": 120 },  // §3B.4, replaces blendStartM 192
  "holeBelowM": -200,                                             // B16; beaches fact-check G5: -100 (58 vertices < -200, 76 < -100)
  "openTiles": [ /* beaches fact-check G1: in-bounds rectangles where retail-closed tiles on gentle ground may open,
                  so S1 reaches town inside the bounds; chosen by a nav search with the ring closed (§3.5, Q22) */ ],
  "paint": { "grassMaxDeg": 38, "rockFromDeg": 45 },               // beaches fact-check G7 (was 30 / 35)
  "placements": { "resnapVegetation": true, "dropBelowSeaM": 0.5, "dropMovedM": 0.5 }   // C9, unchanged
}
```

`profile.cliff`, `cliffRiseM`, the type noise and `blendStartM` on N4/N5 are removed; `berms` stays.

### 5.3 The procedural pass (per vertex, one global lattice)

Everything is computed on **one global 2 m lattice** (`gx = 96·rx + i`, `gz = 96·rz + j`). A vertex on a region edge
is computed once and shared, so seams are bit-identical by construction, as in retail (TERRAIN.md §1.2).

1. **d**: the distance past the playable rectangle (or the rectangle joined with the corridor in A), and the nearest
   side.
2. **Frozen:** where `d = 0`, the height is the retail height, bit for bit, unless the vertex lies in an
   `allowHeightPatches` rectangle.
3. **Side and section:** the edge kind comes from `landEdges` and `sections`.
   - The land/sea fade lies **wholly on the sea side** (at the north split, x 163.0 → 163.8), and no region west of
     a split is synthesised. The second prototype centred the fade on x 162.5, which lowered 7,661 vertices of the
     land region 162 × 103 by up to 86.9 m and synthesised 162 × 104–105 **[confirmed: diff against `hm.npy`]**.
   - **Corner rule** (C13): below z 89 the south side wins over the west.
4. **Base:** the retail height. Beyond the export or in an inactive hole, the extended edge (§3.1 point 5), with the
   holes filled from their neighbours.
5. **Profile:** the waterline curve `c`, the type `T` and the §3.2 profiles give `P`. Then `h = base + (min(base, P) −
   base) · w`, where `w` ramps in from `max(d0, blendStartM)`. The only exceptions are berms (auto, where retail
   ground or water behind the shore lies below the berm target) and synthetic land beyond the export.
6. **Seabed noise** is dropped below `dropNoiseBelowM`, so deep regions compress like flat ones.
7. **Sea mask:** a flood fill from the sea-side border over `h < SL`. It never enters dry playable ground and is never
   seeded on a land side. At +5 m it continues into retail water at exactly +5.0 m that is connected to the sea (for
   the render join, §8.1). Inland ground below the sea level (the town, river beds, the swamp, the ruins) is therefore
   never sea.
8. **Authored layers** (§6.3): `h = lerp(h, override, weight)`, then the frozen check again.

*(beaches 2026-09-29)* Step 4 treats retail heights below `holeBelowM` (−200 m) as holes. Step 5 becomes: the beach
profile of the section's kind on the land side and its shelf on the sea side; on sea sides outside the bounds, the
flank envelope of §3B.3 (lower or fill, relief ≤ 6 m, shoulder, smooth toe), the waterline at `max(c0 + noise, toe +
width)`, the tomb keep mask (§3B.4) and the river-mouth keep (`riverMouthKeepM`). Step 6 adds the 6 m smoothing of the
reshaped flank. Steps 1–3, 7 and 8 are unchanged, and the frozen check still runs last.

The second prototype's run with TECH's geometry changed 0 in-bounds vertices (asserted), reshaped 40 export regions,
synthesised the 8 holes and gave 3.09 km² of sea **[confirmed: re-run]**. These numbers change with C3's geometry.

### 5.4 How it plugs into `convert-world.ts`

`convert-world.ts` reads a region through `loadRegion(x, z)` (a `MapMFile` plus a `RegionGrid`). It then reads the
`.t` lightmap, the minimap `.ddj`, the `.nvm` and the `.o2` object lists **[confirmed]**. The coast becomes a **region
source overlay** of the same shape:

```ts
// packages/convert/src/world/coast/source.ts
export interface RegionSource {
  /** Retail or synthetic terrain for (x, z), as convert-world's loadRegion returns it (buildLayers takes the whole
   *  MapMFile: 36 blocks of 17×17 heights/texture words, environment ids, water), or null (no region). */
  terrain(x: number, z: number): { mapm: MapMFile; grid: RegionGrid; synthetic: boolean } | null
  /** Global lattice height (file units) for buildNormals' GlobalHeight callback: must read the overlay, not retail. */
  height(ggx: number, ggz: number): number | undefined
  /** Lightmap RGBA 512² (row 0 = south) or null (white). */
  lightmap(x: number, z: number): { width: number; height: number; rgba: Uint8Array } | null
  /** Minimap RGBA 256² (row 0 = north) or null. */
  minimap(x: number, z: number): { width: number; height: number; rgba: Uint8Array } | null
  /** The region's navmesh as a full NvmFile (buildWorldNav and the debug NavmeshBin read cells, globalEdges,
   *  internalEdges and tileFlags), or null. */
  nvm(id: number): NvmFile | null
  /** Placements to add, re-snap or drop for the region (C9). */
  placementEdits(x: number, z: number): { add: CoastPlacement[]; resnap: Array<{ uid: number; y: number }>;
                                           drop: Array<{ regionId: number; uid: number }> }
}
export function retailSource(map: Pk2Archive, data: Pk2Archive, media: Pk2Archive, mfo: MfoFile): RegionSource
export function coastSource(retail: RegionSource, cfg: CoastConfig, authored: AuthoredLayers): RegionSource
```

`convert-world.ts` gains a switch (`preset.coast ? coastSource(retailSource(…), …) : retailSource(…)`) and appends the
emitted synthetic regions to its region list. Today the terrain loop skips every region `loadRegion` returns null
for. Three call sites are routed through `src`:

- `loadRegion`;
- the `globalHeight` callback of `buildNormals` (without this, normals on a changed/unchanged seam come from retail
  neighbours and the lighting shows a seam);
- the `.nvm` read.

The downstream functions are then unchanged: `buildLayers(mapm)`, `buildNormals`, `encodeTerrainBin`,
`encodeNavmeshBin`, `buildWorldNav(regions: {id, nvm}[])`, `splitWorldNav` and the placements **[confirmed:
signatures in `terrain.ts` and `nav.ts`, call sites at `convert-world.ts` 243–300 and 355–420]**.

**Files:**

| File | Content |
|---|---|
| `coast/config.ts` | `CoastConfig` and `validateCoastConfig` |
| `coast/lattice.ts` | The global lattice: base heights, frozen mask, distance, sides and sections |
| `coast/profile.ts` | The pure functions of §3.1–3.2 and §5.3 (hash noise, the offset curve, `T`, profiles, berms) |
| `coast/authored.ts` | Reads and validates `content/coast/height/*.png`, `paint/*.png` and `props.json` (§6.4) |
| `coast/paint.ts` | Texture words: the procedural rules plus authored paint |
| `coast/field.ts` | Sea mask, distance to shore and bed depth → `coast/field.png` (§8.1) |
| `coast/navgen.ts` | A whole `NvmFile` for changed regions (§9.1) |
| `coast/lightmap.ts`, `coast/minimap.ts` | Lightmaps and minimap tiles for changed and synthetic regions (§11) |
| `coast/source.ts` | The overlay above |
| `coast/report.ts` | `manifest.report.coast`: counts, hotspots, every in-bounds change, every dropped or re-snapped placement |

**Order of operations per region** (deterministic):

1. Lattice heights: retail or edge extension → procedural → **authored height** → frozen check (§6.4).
2. Texture words: retail → procedural paint rules (outside the bounds, and paint only up to `allowInsideBoundsM`
   inside) → **authored paint**.
3. Per-block data:
   - `environmentId` of a synthetic block = that of the nearest export block, so the sky profile does not jump.
   - Retail water blocks outside the bounds that fall in the sea mask are removed (`waterType −1`); the ocean replaces
     them.
   - At −2 m only: inland water above the sea level that reaches a sea edge is copied one block across the bounds
     into the berm (C10).
4. Objects (C9):
   - Vegetation in changed regions is re-snapped to the new ground if that ground is ≥ SL + 0.5 m, and dropped
     otherwise.
   - Other retail placements whose ground moved by more than 0.5 m under their origin are dropped.
   - The report also lists every placement whose **footprint** (model bounds × transform) covers ground that moved by
     more than 0.5 m. That catches in-bounds models such as the tomb cliffs.
   - Coast props are added (§10.3).
   - Counts: 74 (A) / 88 (B) ring placements stand on ground moved by more than 1 m in GEO's geometry, including one
     guard tower (`w_cd_gtower00`). Most are in phase-2 areas (155–161 × 103, 155 × 99–102) **[confirmed on the
     prototype]**. The phase-1 count is **[unknown until CST-C runs]**.
     *(beaches 2026-09-29: 97 placements with the lowered and filled ring, §3B.5.)*
5. Navigation (§9.1), lightmap and minimap (§11).
   - *(refresh 2026-09-29)* **Lightmap = baked sun visibility on the PBR path.** RND-T reads the lightmap as
     `bakedVis = saturate((lm − 0.61) / 0.39)` on light 0, and beyond the CSM range keeps
     `mix(1, bakedVis, max(0.35, bakedWeight))` (D16) **[confirmed: `pbr/terrain-plugin.ts` header]**. On Medium, the
     default, the CSM reaches only 60 m and the terrain does not cast, so a new cliff without a baked shadow would look
     flat. The converter therefore bakes changed and synthetic regions: a heightfield ray-march toward
     `BAKED_LIGHT_DIR` (azimuth −14°, elevation 38°, measured by RND-L **[confirmed: `sky/types.ts`]**), mapped to the
     retail lightmap's value range and blended into the retail lightmap inside the change mask. The method is RND-L's
     `work/tmp/w9a-rnd-l/bake-terrain.ts` (r 0.690 against retail darkness) **[likely to port unchanged]**.
6. `manifest`:
   - new regions carry `synthetic: true`;
   - `manifest.coast` (§8.1);
   - `bounds` stay at +5 m, but `stream.playable` is decoupled from `bounds`, because both come from one
     `WorldPreset.playable` today (C19);
   - `places` from `coast.json`, converted to glTF metres;
   - `tiles[].typeName` is overridden by the palette, so `asiaminor_sand_01` (typed `Dirt` in tile2d) sounds and wets
     like sand. Footsteps read `manifest.tiles[].typeName` (`apps/game/src/audio/surface.ts`), and
     `terrainSurfaceClass` maps `Sand` to the sand class **[confirmed]**.

**Determinism.** No `Math.random` and no clock: the noise is an integer hash of the lattice coordinates and the seed.
PNG decoding is exact (§6.3). Test: two conversions give identical SHA-256 for every file except
`manifest.createdAt`.

### 5.5 Land edges and the link to Donwhang

- Land edges are never modified and never seeded by the mask. Test: land-side regions are bit-identical to retail.
- The retail regions beyond them (x 145–154, north to z 106) exist **[confirmed]**, so linking to Donwhang later is an
  export change (widen the preset and the playable area), not a coast change.
- Today a player at the west bounds sees the 192 m ring and then nothing, inside the fog. Option A's corridor adds
  retail land there. In phase 1, TECH's optional extra retail ring on the land sides (x 154 × z 89–104 and
  z 104 × x 155–162: **24** active regions, look-only) closes the gap cheaply **[confirmed: active mask]**.

---

## §6 The Blender round trip (the user's hand-edit layer)

### 6.1 Export: an edge area → a `.blend` [confirmed: prototype run]

```sh
pnpm tsx work/tmp/coast/export-edge.ts 173-175,89-91           # bundle: meta JSON + f32 heights + u16 texture words
blender -b --factory-startup -P work/tmp/coast/blender/build_edge.py -- \
  work/tmp/coast/blender/173-175,89-91.json  <out.blend>  <oblique.png>  <topdown.png>
```

Production form: `pnpm sro coast-export --world jangan-fields --area 173-175,89-91 [--from procedural|export]`. It
writes the bundle and runs Blender headless, using the path in the `sro.config.json` key `blenderExe` (default: the
5.2 install). `--from procedural` starts from the coast pass's result (`blender/make_proc_bundle.py` in the
prototype); that is the normal starting point for sculpting (`blender-proc-oblique.png`).

**What the `.blend` holds:**

- **One mesh for the area**, `Terrain_<area>`, on the global lattice: (96·n + 1)² vertices, each shared region edge
  once, so a stroke across a seam cannot open a crack. Triangles are split along (i, j)–(i+1, j+1), as the game renders
  and queries heights (TERRAIN.md §1.3).
- **Frame:** Blender Z-up metres, with **X = east = glTF x, Y = north = −glTF z, Z = up = glTF y**. The origin is the
  south-west corner of the export's origin region (168, 97), the same floating origin as the manifest. The scene
  property `sro_coast` records the frame, the area, the playable bounds, the sea level and the source hash.
- **Attributes:** `splat` (per-vertex colour), `tile_word` (the raw texture word), `.sculpt_mask` = 1 on the frozen
  playable area, and a vertex group `frozen_playable` **[confirmed: the saved `.blend` reopened headless; 37,249 =
  193² masked vertices in 173–175 × 89–91]**. That brushes respect the mask in 5.2 is **[likely]** (§13).
- **Helpers:** a `SeaLevel` plane named by value (for example `SeaLevel_+5.0m`), 400 m wider than the area;
  `PlayableBounds` and `RegionEdge*` lines draped on the terrain; and a `Label_x_z` per region.

**Proof that it lines up [confirmed]:**

- Build time is 7.0 s for 3×3 regions (83,521 vertices, 165,888 triangles).
- Heights at probe vertices equal the source bins exactly, and the 12 internal seams match. The exporter throws on
  any mismatch.
- A top-down orthographic render at **0.75 m per pixel** (the client minimap's scale) correlates best with the
  stitched minimap tiles at shift (0, 0) (`blender-edge-vs-minimap.png`).

### 6.2 What the user (or Claude) does in Blender

- **Sculpt** the terrain object. Sculpt mode respects `.sculpt_mask`. Dyntopo and remesh do no harm, because the
  import re-samples, but they slow the scene down.
- **Paint** materials: vertex-paint the `paint` colour attribute with the swatches of the `Coast palette` collection
  (made from `coast.json` `paint.palette`). Unpainted vertices keep their procedural tile.
- **Props:** add linked instances from a `Coast props` collection. Each is an empty whose `sro_model` property holds
  the retail `.bsr` path, with a low-poly proxy. Moving, rotating (Z only) and duplicating them is the whole workflow.
- **The area border is locked:** the import re-reads only this area, so its outer ring of vertices must not move. v1
  adds the border to `.sculpt_mask`. The prototype's validator caught 43 moved border vertices when this was missing.

### 6.3 Import: the sculpted result → `content/coast/`

```sh
blender -b <edge.blend> -P work/tmp/coast/blender/readback_edge.py -- <bundle.json> <content/coast> [--demo-sculpt]
pnpm tsx work/tmp/coast/validate-edits.ts <content/coast>
```

Production form: `pnpm sro coast-import --blend <file>` runs the readback, validates it, then re-runs the conversion
(or prints the command).

**Readback [confirmed: prototype]:** heights are **re-sampled with rays cast straight down** at every lattice point
onto the evaluated mesh (`BVHTree.FromObject` + `ray_cast`), not read by vertex index. Brushes that move vertices
sideways therefore do not matter. The 83,521 rays took well under the 6.7 s of the Blender run.

**Formats (the converter's input; C8):**

| File | Format | Meaning |
|---|---|---|
| `content/coast/height/<x>_<z>.png` | 97 × 97 **16-bit grey + alpha (LA16)**; PNG row 0 = north, column 0 = west | `L = round((h + 100) / 500 · 65535)`: −100 … +400 m in 7.6 mm steps (the domain spans −76 … +354 m). `A` = override weight (65535: the authored height wins; 0: procedural). |
| `content/coast/paint/<x>_<z>.png` | 97 × 97 RGBA8, same orientation | `R` = palette index (0 = none), `G` = tiling code (0–4), `A` = weight. One value per vertex, the native resolution of texture words (TERRAIN.md §2.1). |
| `content/coast/props.json` | `[{ id, model, x, y?, z, yaw, region }]` in glTF metres | Authored placements. `id` is stable (from the Blender object name), so re-imports update in place. If `y` is absent, the prop sits on the ground. |
| `content/coast/coast.json` | §5.2 | Configuration |

- Per-region PNGs rather than one big image: small diffs, and one region at a time in git.
- **EXR is not readable** by the converter's `sharp` 0.35.5 (no `exr` in `sharp.format`) **[confirmed]**. 16-bit PNG
  is.
- **Pitfall [confirmed]:** `sharp(file).raw({ depth: 'ushort' })` silently turns an LA16 PNG into 8-bit RGBA.
  `sharp(file).toColourspace('grey16').raw({ depth: 'ushort' })` returns the exact 16-bit values.
- The converter's `packages/convert/src/png.ts` writes 8-bit RGBA only. That suits the field and the paint layers. The
  16-bit height layers are written by the Blender readback and only read by the converter.

**Merge rule:** procedural base → authored height by weight → authored paint by weight → frozen check. The Blender
layer wins where it is painted, the procedural pass fills everything else, and re-running the converter gives the same
bytes.

### 6.4 Validation (converter errors; prototype `validate-edits.ts`) [confirmed on the demo sculpt]

The demo sculpt put a 6 m dune ridge 60 m south of the bounds and one illegal +3 m edit inside them. Result: 12,471
weighted vertices, a maximum quantisation error of 15.26 mm on unweighted vertices, and 44 errors (the in-bounds
vertex plus 43 moved border vertices). A re-run gave identical output.

The checks, as they will run in `coast/authored.ts` and in a `coast-import` dry run:

1. **Format:** 97 × 97, LA16 or RGBA8; file names inside the domain.
2. **Frozen area:** no weighted height or nav change on a vertex inside the frozen rectangle, unless it lies in an
   `allowHeightPatches` rectangle. Paint may reach `allowInsideBoundsM`. The frozen rectangle is `stream.playable`,
   not `manifest.bounds` (C19); the prototype validator reads `man.bounds` and must change.
3. **Seams:** a vertex on a shared edge has the same weight and value in both files. A weighted edge vertex whose
   neighbour file is missing is an error.
4. **Quantisation:** unweighted vertices decode to the source within half a step. Production uses a 1 mm threshold
   and a smooth weight `saturate(|Δh| / 0.05 m)`.
5. **Staleness:** the bundle's source hash must match the current export, or the import refuses.
6. **After conversion:** the nav is regenerated (§9.1), `nav/<x>_<z>.bin` equals its slice of `nav.bin`, the spawner
   still places all 791 nests, and no walkable island is cut off (§9.3). *(fact-check 2026-09-29, F8: production
   places about 700 and skips 91 as unreachable on foot [confirmed: DEPLOY.md]; the check is the same placed set and
   skip list as before the coast, not 791.)*

### 6.5 What a Blender MCP connection adds (C15)

- **It is not needed for the round trip.** Export, readback and validation are headless Python scripts started from
  `pnpm`, and they are deterministic. No Blender MCP tool was connected during this study **[confirmed]**.
- **What it adds:** a live Blender window the user watches while Claude drives it. Claude can load an edge area and
  apply scripted edits the user describes ("pull this headland out 40 m", "cut a cove here", "put three rocks at the
  cliff toe"). It can frame the camera and take viewport screenshots, and the user can pick up the brush in the same
  session. The MCP calls the functions of `build_edge.py` and `readback_edge.py`, so the files and checks stay the
  same.
- Installing a Blender MCP add-on means a download and a configuration change, so it needs the user's approval. Edits
  made through it still pass §6.4.

### 6.6 Re-verification on the shipped export and Blender 5.2.2 (refresh 2026-09-29)

The whole prototype round trip was re-run on the current `work/out/world/jangan-fields` export and Blender 5.2.2 LTS
(hash `d13f752e3b9c`), into `work/tmp/coast-refresh/rt/`:

| Step | Command (from the repo root) | Result |
|---|---|---|
| Export bundle | `pnpm tsx work/tmp/coast/export-edge.ts 173-175,89-91 work/tmp/coast-refresh/rt` | 289 × 289 lattice, heights 0.00 … 163.67 m, 7 tiles. **The heights, texture words and meta JSON are byte-identical to the 2026-09-28 bundle** (`cmp`, `diff`) **[confirmed]**: wave 9 did not change the terrain export. |
| Build `.blend` | `blender -b --factory-startup -P work/tmp/coast/blender/build_edge.py -- <bundle> <blend> <oblique> <topdown>` | 5.8 s; 83,521 vertices, 165,888 triangles; the probes match the source heights; the saved file carries `splat`, `tile_word`, `.sculpt_mask` and the vertex group `frozen_playable` **[confirmed: reopened headless]**. |
| Readback (demo sculpt) | `blender -b <blend> -P work/tmp/coast/blender/readback_edge.py -- <bundle> <out>/content/coast --demo-sculpt` | 2.6 s; 4 region layers, 12,385 changed lattice vertices, max \|Δh\| 6.000 m. |
| Determinism | the readback run twice | Identical SHA-256 for every PNG **[confirmed]**. |
| Validate | `pnpm tsx work/tmp/coast/validate-edits.ts <out>/content/coast` | 12,471 weighted vertices (edge vertices counted in both files), max quantisation error 15.26 mm, **44 errors: the illegal in-bounds vertex plus 43 weighted edge vertices without a neighbour file**, exactly as on 2026-09-28 **[confirmed: `rt/validate.txt`]**. |

Two new findings for CST-B:

1. **Relative render paths land at the drive root.** Given `work/tmp/...` as the render output, Blender 5.2.2 wrote
   `C:\work\tmp\coast-refresh\rt\oblique.png` (the `.blend` itself landed correctly) **[confirmed; the stray files
   were moved into the refresh folder]**. The production verbs (`coast-export`, `coast-import`) pass **absolute**
   paths to Blender, and CST-B's test asserts that no argument is relative.
2. **Sculpt operators cannot run headless.** `bpy.ops.sculpt.mesh_filter` in background mode crashed Blender
   (`EXCEPTION_ACCESS_VIOLATION`, `rt/mask_test.py`) **[confirmed]**. So "brushes respect `.sculpt_mask` in 5.2"
   stays **[likely]** and becomes a **user check** in an interactive session (or through a Blender MCP window later).
   Scripted edits (Claude's "pull this headland out 40 m") keep writing vertex positions directly, as the demo sculpt
   does, and apply the mask themselves; the validator catches any leak either way.

The prototype validator still reads `man.bounds` for the frozen rectangle; production reads `stream.playable` (C19).
At +5 m the two agree (156–174 × 90–102) **[confirmed: manifest]**.

*(beaches 2026-09-29)* The round trip was run once more, on the **beach base** and with a real terrain edit instead of
the demo dune: the Tiger flank area 156–161 × 87–90, a scripted gully pass, readback, validation (0 errors) and merge.
The steps, the numbers and the user's three ways to run a session (by script, watched, by hand) are in §3B.7.

---

### 6.7 Wave 12: the World Editor's edits pass runs after the coast (docs/WAVE_PLAN8.md D6, docs/WORLD_EDITOR.md §3.6)

The converter's placement passes run in a fixed order: **coast (C9) → town dressing → cloth → static variants → grass
palettes → world edits → tree swap**. The World Editor's layers (`content/world-edits/<world>/`) therefore apply on top
of the coast's result: its height deltas add to the coast-edited (or retail) heights a region ends up with, its paint
to the coast's words, and its placement edits see C9's set (a uid C9 dropped can never be moved or re-added; an add takes
a fresh editor uid, 0xE000–0xEFFF per region, from the shared registry). The editor's base hash per region is taken on
those post-coast heights, so a later coast refresh that changes the ground under an edit is named at the next convert
("the ground under the edit changed since it was made"). Blender sculpts (this section) stay the tool for the coast's
own sculpted edge areas; the editor is the tool for everything a player can walk to. An empty edit layer (what ships,
D37) leaves every coast file byte-identical.

## §7 Materials

### 7.1 Retail tiles that fit [confirmed: decoded from `Map/tile2d/`, `tiles-sheet.png`; ids re-read from `tile2d.ifo`, 603 entries]

| Role | Tile id: file (tile2d type) | Look |
|---|---|---|
| **Beach sand, dry** | **407 `asiaminor_sand_01`** (Dirt) | Pale, fine and even: the best beach sand in the client |
| Sand with pebbles | 412 `asiaminor_sand_02` (Dirt) | |
| Dune / back-beach | 132, 134, 150, 151 `ruin_takl_dest_*` (Sand); the export already uses 140/141 `ruin_takl_dest_05*` (Sand) | Wind-rippled desert sand |
| Wet sand (stand-in) | 70 `oaho_dust_earth01` (Sand) | No retail tile is "wet sand" |
| Shingle | 534 `alex_dust_05`, 269 `alex_dust_01` (Dirt) | Pebbles on sand (Alexandria) |
| Rock, local style | 177, 226 `c_stone_hmfld_01/02` (Stone) | Jangan's own rock |
| Sea cliff | 278–280 `rok_stone_01..03` (Dirt); 495–497 `pha_rock_*` (Stone) for dark wet rock | |
| Sea bed | 154 `oaho_dust_earth06` (Sand); 181/182 `c_dust_swmp_*` (Mud) | Seen only in the shallows |

- **`Map/water/wave1..3.ddj`** are 128² DXT3 white spray sprites on black, with **no usable alpha** (every alpha
  nibble is 15). They must be drawn additively **[confirmed]**. The export already carries them as
  `water/wave1..3.png`. They serve as spray billboards (§8.9), not as tiling foam.
- Tile ids above 255 need no change, because the 10-bit id is already handled (TERRAIN.md §2.1). The coast adds about
  7 layers to a window, well inside the 72/80/96-layer atlas, and fits D39's 48-layer cap plus the overflow array on
  High **[likely]**.
- Footsteps: `SOUND_SURFACES` already has `Sand`, `Water` and `DeepWater`. The palette's `typeName` override makes
  407/412 sound and wet like sand (class `sand`, porosity 0.9, `pbr/classes.ts`) **[confirmed]**.

*(beaches 2026-09-29)* **Paint for beaches everywhere.** There is no sea-cliff paint any more. The rules become: seabed
(154) below SL − 0.5 m; wet sand (70) below SL + 0.6 m; dry sand (407, 412 toward the dune) in the beach band; the
dune crest in the retail desert sand already exported (140/141 `ruin_takl_dest_05*`); the lowered flank in the
neighbouring retail field tiles (grass on slopes under 30°, so GRASS_LIFE's grass grows there by itself) blending to
Jangan's rock (226) above 35°. *(beaches fact-check 2026-09-29, G7: those thresholds sit on the flank's own grade.
Past 100 m, 77 % of the flank land is steeper than 30° and 56 % lies in 30–35° (median 31.9°), so most of the lowered
mountains would be painted rock-blend and get little grass; GRASS_LIFE grows full grass up to 36.9°
(`smoothstep(0.70, 0.80, normal.y)`) and none past 45.6° **[confirmed: `work/tmp/coast-beach-fc/fc1.py`; GRASS_LIFE.md
§3.2]**. New default: grass tiles up to 38°, a blend to rock over 38–45°, rock above 45°; then 13 % of the flank (18 %
after the gully pass) is above 37°, mostly gully walls, and the Tiger mountains come down green as the user check
asks **[projected]**. CST-C's paint test checks the share of grass paint on the flank.)* Shingle (534) is kept for the mouth spits and the strait. `rok_stone_01` (278) is no
longer needed and leaves the palette and B-coast (one texture set less) **[projected]**. On slopes of at most about
40° a tile stretches by at most 1 / cos 40° ≈ 1.3 ×, which reads fine without triplanar on Medium **[projected]**.

### 7.2 What wave 9B adds (batch **B-coast**, made locally, nothing downloaded)

| Asset | Size, maps | Notes |
|---|---|---|
| Beach sand, dry (from 407) | 1024²: albedo + normal + ORMH | Seamless (per-axis wrap, TEXPIPE §3.4) |
| **Wet sand** (new) | 1024² | Albedo × 0.55–0.65, roughness 0.25–0.35, ripple marks in the height; also the Classic stand-in for tile 70 |
| Pebble / shingle (from 534) | 1024² | Height-blend against sand (RND-T §6.2 step 1) |
| Cliff rock (from 278/226) | 1024² + normal/ORMH | Triplanar on steep cells |
| Shoreline foam | None in B-coast | The lace texture is generated at load by our port of Tidewater's generator (§8.8) |
| Ocean normals | Reuse RND-W's generated normal map on Medium and Low *(refresh 2026-09-29: it is `waterNormalPixels` / `createWaterNormalTexture` in `pbr/water-plugin.ts`, built in memory, 128², layers of 6 m and 17 m; there is no `water_n0/n1` asset [confirmed: code])*; no storm "chop" layer | High and Ultra take their normals from the FFT's derivatives, and the spectrum carries storm chop on every PBR preset (§8.3, §8.4) |
| Caustics | None in B-coast | Computed at runtime on Ultra, if the later lane CST-K is built (§8.8) |

On the PBR path the wet look comes first from the **coast wet band** (§8.8) on the dry sand. A separate wet tile is
needed only on Classic, and as a nicer look on High.

### 7.3 How the coast textures reach the game after TX-R (refresh 2026-09-29)

- **Key.** TX-R finds a terrain tile's set by `tile2d:<stem>` (`TextureMaps.tile`), and unlike object textures it
  does **not** follow a `gen:` replacement **[confirmed: `pbr/maps.ts`]**. So every coast tile must be a real
  `manifest.tiles` entry with a retail stem, and B-coast writes `tile2d:asiaminor_sand_01`, `tile2d:asiaminor_sand_02`,
  `tile2d:oaho_dust_earth01` (remastered **as wet sand**: tile 70 is not used anywhere in the export today, so its set
  is ours to shape **[confirmed: not in `manifest.tiles`]**), `tile2d:alex_dust_05` and `tile2d:rok_stone_01`. No new
  tile id is invented (the 10-bit id space would allow it, but the loader would need a `gen:` path for tiles).
- **What exists.** The index holds 16 terrain sets; of the palette only `c_stone_hmfld_01` (177) has one. 226
  (`c_stone_hmfld_02`) and 154 (`oaho_dust_earth06`) are already exported tiles without sets; 407, 412, 70, 534 and
  278 are not exported yet and arrive with CST-C's paint (`manifest.tiles` grows from 104 to about 109)
  **[confirmed: `work/out/pbr/index.json`, `manifest.json`]**.
- **Tiers.** Medium (the default) loads the retail-size remaster plus maps for hero sets; High the '2x' tier
  (≤ 1024) into the 48-layer tier plane; Ultra ≤ 2048 or KTX2 **[confirmed: `pbr/maps.ts` header, `tile-atlas.ts`
  `TILE_TIER_LAYERS = 48`]**. Coast tiles are few (≤ 7 in any window) and only near the coast, so they compete with
  field tiles for the 48 tier layers only in the south-east windows; a set tile past the cap drops to the 512 base
  array, which is a look loss, not a failure **[likely]**. B-coast marks sand and wet sand as hero sets so Medium gets
  their maps.
- **Pipeline.** B-coast runs in `@sro/texpipe` like B2/B3: the local upscaler, PBR derivation and the approved SDXL
  detail step (DT-2, terrain tiles first; only through `work/tools/comfyui/start_comfyui.sh`, never beside other heavy
  GPU work) **[confirmed: the user's decisions]**. Terrain stays local; nothing goes to Meshy or any web service.
- **Classic (Low).** Low shows retail tiles only (`tier: 'retail'`), so its wet sand is retail tile 70's own image.

---

## §8 Ocean rendering on top of wave 9A

The ocean follows **Tidewater** (github.com/dgreenheck/tidewater), an MIT-licensed browser game on raw WebGPU with its
own engine, which the user pointed us at. Its ocean files were read at commit `4811ba4` (2026-09-25) for this revision,
and the lead's notes are in `work/tmp/tidewater-notes.md`. Every statement below about what Tidewater does comes from
that reading **[confirmed: read]** unless it is tagged otherwise. Its code is **ported** into our Babylon 9.28 shaders,
never imported, and the MIT notice travels with every ported file (§8.12). No Tidewater asset is used. Tidewater has
no weather; ours drives the sea (§8.7).

| Technique | Tidewater source | Our adaptation | Presets |
|---|---|---|---|
| Multi-cascade FFT ocean: JONSWAP/TMA spectrum, 2 compute dispatches per frame, IFFT in workgroup memory, Jacobian foam, non-integer cascade ratios | `src/ocean/OceanFFT.js` | Babylon `ComputeShader`s writing `RawTexture2DArray` storage textures (§8.3) | High, Ultra |
| The same spectrum and IFFT, off the GPU | `OceanFFT.js` (the maths) | A worker FFT tile, uploaded 20 times a second (§8.4) | Medium; every PBR preset without compute |
| Per-cascade attenuation in shallow water, band-limiting by mesh spacing, normals from derivatives, near-field detail | `src/ocean/WaterSurface.js` | Inside `SroOceanPlugin`, with depth from the coast field (§8.5, §8.6) | Medium+ (near-field: Ultra) |
| Shading: Fresnel, GGX glint with roughness from unresolved slopes (Cox–Munk), scattering by path length, crest translucency, foam light | `src/ocean/WaterMaterial.js` | A `MaterialPluginBase` on `PBRMaterial` that reflects RND-L's sky cube (D14) (§8.6) | Medium+ |
| Water mesh: one instanced grid, geomorphing, quadtree selection | `src/core/CDLOD.js` | One Babylon grid mesh drawn as thin instances (§8.2) | all |
| Swash cycle: uprush, backwash, lobed front, minimum film | `src/ocean/ShoreWaves.js` (`shoreSwashRunup`) | Shore v1, driven by the coast field (§8.8) | all |
| Foam lace texture | `src/ocean/SurfFoam.js` (`makeLaceTexture`) | Generated once at load in the ocean worker (§8.8) | Medium+ |
| Depth-aware breaking waves | `src/ocean/ShoreWaves.js` | Shore v2: later, optional (§8.8) | High, Ultra |
| Surf simulation: foam carried by the flow, sand wetness | `src/ocean/ShoreSim.js` | Shore v2: later, optional (§8.8) | High, Ultra |
| Caustics after Evan Wallace's WebGL water | Named in the lead's notes; the file was not read | Later, optional (§8.8) | Ultra |

"Shore v1" and "shore v2" are the user's first and later steps for the shore. They are unrelated to the coast
geography's phases 1 and 2 (C2).

### 8.1 Data: the coast field and `manifest.coast`

The converter writes one world-aligned texture over the computation domain: **`coast/field.png`, RGBA8, 4 m per
texel.** For X 153–177 × Z 87–105 that is 1,200 × 912 texels, 4.4 MB on the GPU (4.9 MB with A's corridor) and about
0.1–0.3 MB as WebP **[projected arithmetic]**.

- **R:** sea mask (0 = land or inland water, 255 = sea), feathered by 1 texel.
- **G:** distance to the shoreline, 0 … 127.5 m in 0.5 m steps, signed by R. Consumers stay within that range, which
  is why the area ambience switches at 120 m (§10.1).
- **B:** on sea texels, the bed depth below the sea level, 0 … 51 m in 0.2 m steps: the depth for the per-cascade
  attenuation (§8.5), the path length on Medium (§8.6) and the Classic alpha. **New:** on land texels within 128 m of
  the shore, the height above the sea level in the same steps, for the swash front (§8.8).
- **A:** breaker and foam authoring (from Blender paint; default 0).

Rules:

- **Border (C16):** the sampler clamps to the edge. The outermost texels are open deep sea on sea sides and the
  land/sea mask on land sides, so the ocean never floods beyond a land edge.
- **Mask:** a flood fill from the sea sides (§5.3 step 7). The depth test hides the sea under land above the sea
  level, and the mask hides it where land lies lower (the town at −3.26 m, beds, the swamp, the ruins).
- **CPU copy:** the client keeps a coarse quadtree of "sea or swash band" bits built from R and G, for the CDLOD
  selection (§8.2).
- **Join with retail water (+5 m only):** at N3, S2 and W2 the ocean meets RND-W / retail +5 m water at the same
  level. The field marks connected +5 m water within 64 m of the join. There the ocean fades its waves and swash to 0
  (§8.5), and both materials use the shared RND-W colour chunk and world-space normal maps. The join is therefore flat
  and matched **[projected; LAB checks it at the bay mouth]**.
  - *(refresh 2026-09-29)* What RND-W actually built **[confirmed: `pbr/water-plugin.ts`, `water.ts`]**: one
    `PBRMaterial` + `SroWaterPlugin` per world, alpha-blended, no depth write, roughness 0.04 (0.15 in rain); albedo =
    the retail 30-frame animation × the block colour at 60 %, darkened toward `WATER_DEEP` by depth; normals from one
    generated 128² map sampled twice in **world XZ** (6 m at (0.03, 0.01) m/s, 17 m at (−0.02, 0.025) m/s) × the
    block's wave amplitude; the High+ shore alpha `saturate(depth / 1.5 m)` with a foam band under 0.3 m; depth per
    vertex in the vertex colour (r = (depth + 1) / 9). There is **no shared chunk**. The join therefore works by
    sharing **state, not code**: in the join zone the ocean plugin binds the same `WaterPbrState` (`b` = hue and
    roughness, `c` = deep multiplier), the same normal texture with the same two world-space layers, and the same
    retail frame array, and reproduces RND-W's albedo formula (a copied constant set with a test that it equals
    `water-plugin.ts`'s). Outside the zone it blends to its own scattering colour over 64 m. ~~`water.ts` gains one
    getter for the frame array~~ *(fact-check 2026-09-29, F5: `WaterRenderer.pbrState` is already public and holds
    `frames` and `normal`, but the private `ensurePbr()` fills them only when the first PBR water region is built
    [confirmed: `water.ts` 92, 341–348]. The hook is therefore a public "ensure the PBR water state" call, plus the
    Classic frames for Low's ocean: RND-W owned, a few lines, done by I-CST.)* In the join zone the ocean also fades
    its cloud-shadow factor to 1, because RND-W's water takes no cloud shadow *(fact-check 2026-09-29, F6
    [confirmed: no `SRO_CLOUDSHADOW` in `water-plugin.ts`])*. The retail +5 m blocks keep their own
    per-block meshes; the ocean is not drawn over them (field R = 0 there), so there is never a double water layer.

```ts
// manifest.ts (additive)
export interface WorldCoast {
  seaLevelM: number
  field: { file: string; x0: number; z0: number; metresPerTexel: number; width: number; height: number }
  mapColor: string          // minimap / world-map fill for open sea
  sourceHash: string        // coast.json + content/coast/** hash, for staleness checks
}
// WorldManifest.coast?: WorldCoast;  WorldRegion.synthetic?: true
```

### 8.2 Geometry: a CDLOD grid (C20)

`CDLOD.js` implements Strugar's continuous distance-dependent LOD (2010). One G × G grid is drawn once per selected
quadtree node, as instances. Vertices in the outer part of each LOD range morph toward the next coarser lattice, so
levels never crack or pop. Its defaults are G = 64 quads, an 8 m leaf, 12 levels, a range of `leaf · 2^lod · 2.5`,
morphing over the last 34 % of each range, and at most 1,500 instances. **It replaces the clipmap** of the first
design:

- **Why:** morphing removes the clipmap's stitching skirts and its pops at ring borders, which large FFT
  displacements would expose. Nodes are culled against the frustum and the sea mask, so in the interior, where most
  play happens, the ocean selects nothing and costs almost nothing (§8.11).
- **Babylon form:** one `Mesh` holding a (G + 1)² grid, drawn as thin instances. Each frame the per-node data (origin
  x and z, size, LOD) goes into `mesh.thinInstanceSetBuffer('cdlodNode', data, 4, false)` **[confirmed: the signature
  in 9.28]**, and `SroOceanPlugin.getAttributes` declares the attribute **[confirmed: `MaterialPluginBase.getAttributes`
  exists]**. The morph (`cdlodSnapped` and `cdlodMorph` in `CDLOD.js`) runs in the vertex stage, in WGSL and in GLSL.
  The mesh keeps the identity transform, with `alwaysSelectAsActiveMesh = true` and `doNotSyncBoundingInfo = true`;
  Babylon's own culling is bypassed **[likely]**.
  - *(fact-check 2026-09-29, F1)* **A custom buffer alone draws nothing instanced.** In 9.28 only the `"matrix"` kind
    sets the instance count; a custom kind leaves it at 0, and a mesh with 0 thin instances is rendered as a **plain,
    non-instanced mesh** (`hasThinInstances` false, the INSTANCES define off) **[confirmed:
    `Meshes/thinInstanceMesh.pure.js` 235–257, `mesh.pure.js` 225]**. So the ocean also sets a `"matrix"` buffer: each
    node's scale-and-translate matrix, which Babylon's own instanced `finalWorld` applies; `cdlodNode` keeps the LOD
    and morph data. Both buffers are allocated once at the node cap (256) and updated with
    `thinInstanceBufferUpdated` / `thinInstancePartialBufferUpdate`, and the count is set with `thinInstanceCount`
    **[confirmed: the API in 9.28]**, so there is no GPU buffer reallocation per frame.
- **Our parameters [projected]:** an 8 m leaf, range factor 2.5, morph start 0.66 and 8 levels. The coarsest range,
  2,560 m, lies beyond the far plane (`camera.maxZ` 2,000 m **[confirmed]**), which clips it. G = 16 on Low and
  Medium, 32 on High and 64 on Ultra (Tidewater's value). Low stops at 6 levels (640 m). From the ≤ 40 m orbit camera
  at the south-east corner about 80 nodes are selected: ≈ 25k vertices at G 16, 90k at G 32 and 340k at G 64.
- **Selection** runs on the CPU, as in `CDLOD.js`. A quadtree walk tests about 200 nodes against the frustum and the
  field's CPU copy (§8.1), in ≤ 0.05 ms **[projected]**. With no sea node selected, the ocean is not drawn and the FFT
  is not dispatched.
- **Band-limiting** (`WaterSurface.js`): each cascade is sampled at mip `max(log2(spacing / texel) + 0.7, 0)`, where
  `spacing` is the morphed grid spacing, so coarse far vertices neither alias nor swim.
- **Draw order:** after the terrain and the retail water, alpha-blended, like RND-W's water (RENDER §7). `alphaIndex`
  sets the order, because Babylon's distance sort would always put a camera-centred mesh nearest **[likely]**. The sky
  dome draws before transparent meshes (SKY §4.1).
- **New: `needDepthPrePass = true`.** A choppy surface folds over itself, and under alpha blending far crests could
  otherwise draw over near troughs **[likely; LAB checks a storm swell from a low camera]**. Tidewater avoids the
  problem by drawing its water opaque (`WaterMaterial.js`); §8.6 keeps that as an Ultra option.
- *(refresh 2026-09-29)* **The depth pre-pass also writes the sea surface into the depth buffer.** That matters twice:
  beyond the emitted band there is **no terrain under the ocean at all** (deep regions are not emitted, §2.2), so
  without it the depth buffer holds the cleared far plane under the sea, and anything that reads depth after the
  opaque pass (SKY2's haze or sun shafts if they run in post, TAA reprojection, the volumetric clouds' depth test)
  would treat the sea as sky. It costs one extra draw (the pre-pass) of the thin-instanced grid **[projected: +1 draw,
  ≈ 0.02 ms CPU at the measured ≈ 0.021 ms per PBR draw]**. Whether the pre-pass depth also reaches the **prepass MRT
  depth** that SSAO/TAA read on High is **[unknown]**: Babylon renders transparent meshes after the prepass. S-HAZE
  (§8.13) settles which depth SKY2 reads.
  - *(fact-check 2026-09-29, F3)* **What Babylon's pre-pass really does.** For a transparent submesh,
    `needDepthPrePass` renders **the same submesh with the same material** a second time, with colour writes off
    (`Rendering/renderingGroup.js` 206–212). The material's `DEPTHPREPASS` define follows the colour-write state
    (`materialHelper.functions.js` 941), and setting `needDepthPrePass` forces `checkReadyOnEveryCall = true`
    (`material.pure.js` 361–368) **[confirmed: 9.28 source]**. Consequences:
    - two effect variants per preset, both to warm up;
    - readiness (every plugin's `prepareDefines`) is re-evaluated on both calls every frame;
    - the vertex stage with its FFT taps runs twice (the prepass variant skips only the lighting, `#ifndef
      DEPTHPREPASS` in `pbr.fragment`).

    So the pre-pass costs **[projected] 0.03–0.08 ms of CPU**, not 0.02. CST-O's spike measures it. If it is over,
    the fallback is a **depth-only twin**: a second mesh that shares the grid and the two node buffers, with a
    one-define depth material (`disableColorWrite`, no lighting), drawn just before the ocean by `alphaIndex`. The
    draw count is the same, and there is no per-call readiness check.
  - *(fact-check 2026-09-29, F4)* **Which depth holds the sea (was [unknown]).** The PrePassRenderer binds its MRT only
    for materials that are `isPrePassCapable`, and for PBR that is `!disableDepthWrite` **[confirmed:
    `prePassRenderer.pure.js` 228–248, `pbrBaseMaterial.pure.js` 708]**. The pre-pass writes only the hardware depth
    buffer, because its colour writes are off. **Default:** the colour pass keeps `disableDepthWrite = true`, like
    RND-W's water. The sea is then in the hardware depth buffer (anything drawn or read after it sees it) but not in
    the prepass depth texture that SSAO and TAA read, so neither gets AO or reprojection from the sea surface. A
    depth-reading SKY2 pass must read the hardware depth, or ask CST-O for depth writes on the colour pass (S-HAZE).
- *(refresh 2026-09-29)* **Enabled only when a sea node is selected.** The W9A perf pass hands Babylon only the enabled
  meshes and rebuilds that list whenever a mesh's enabled state changes (`render/active-meshes.ts`, −1.2 ms CPU at
  High) **[confirmed]**. The ocean mesh is therefore switched with hysteresis (on when a sea node is selected, off
  after 5 s with none), never per frame, so the list does not churn at the edge of the swash band.
  - *(fact-check 2026-09-29, F2: replaces the hysteresis.)* **Visible, not enabled.** `_evaluateActiveMeshes` tests
    `mesh.isVisible` on each candidate, and toggling it does not fire `onEffectiveEnabledStateChangedObservable`, so
    the candidate list is never rebuilt **[confirmed: `scene.pure.js` ≈ 3915, `render/active-meshes.ts`]**. The
    ocean mesh stays enabled for its whole life and sets `isVisible = selectedNodes > 0` every frame. That also
    guarantees it is never drawn with 0 instances (F1). The FFT dispatch and the worker upload are skipped on the
    same condition. The cost of an invisible candidate is one test per frame.

### 8.3 Waves on High and Ultra: the GPU FFT

**What `OceanFFT.js` does:**

- A Tessendorf FFT ocean with 4 cascades of 256² and tiles of 733, 157, 33.3 and 7.1 m. The ratios are not integers,
  so the tiles never line up and the sea shows no repetition. Cascade c keeps only the wavelengths between
  `L_c / 6` and `L_(c+1) / 6`, so the bands do not overlap.
- **The spectrum:** JONSWAP (peak enhancement 3.3) with the TMA finite-depth correction, a directional spread (a
  cosine lobe blended with a swell-dependent cos-2s spread) and a short-wave fade. Two wave systems add up: a local
  wind sea (7 m/s over a 120 km fetch) and a swell (6 m/s over 1,200 km, scale 0.48). The initial amplitudes come from
  a PCG hash of the texel and a seed, so they are deterministic.
- **Two compute dispatches per frame, for all cascades together.** A row pass evolves h0 into h(k, t) from the time,
  packs eight real fields into four complex ones (two real fields per complex IFFT: the horizontal displacement, the
  height and its slopes, the horizontal derivatives), and runs a 256-point radix-2 IFFT per row in workgroup memory. A
  column pass runs the columns, fixes the signs, computes the Jacobian and writes two `rgba16float` 2D-array textures
  with one layer per cascade: displacement (Dx, Dy, Dz, foam) and derivatives (∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z). Four
  small dispatches then fill the mip chains, and three more rebuild h0 when the spectrum's parameters change.
- **Jacobian foam:** `J = (1 + λ·∂Dx/∂x)(1 + λ·∂Dz/∂z) − (λ·∂Dx/∂z)²`, with choppiness λ 0.9. Foam is made where
  J < 0.58 and decays at 0.35/s (about 3 s), so whitecaps leave trailing patches.

**Our form in Babylon** (`ocean/fft-gpu.ts`, with the WGSL in `ocean/fft-wgsl.ts`):

- It is created only when `engine.getCaps().supportComputeShaders` is true **[confirmed: `EngineCapabilities` in
  9.28]**. Otherwise High and Ultra use Medium's tile (§8.4).
- **Five `ComputeShader`s** (init, conjugate and copy for the spectrum; row and column every frame), each with WGSL
  source and a `bindingsMapping`. `StorageBuffer`s hold h0, the per-k wave data, the IFFT scratch and the persistent
  foam, and one `UniformBuffer` holds the parameters.
- **Outputs:** two `RawTexture2DArray`s (N × N × C, `TEXTUREFORMAT_RGBA`, `TEXTURETYPE_HALF_FLOAT`, mipmapped,
  `TEXTURE_CREATIONFLAG_STORAGE` **[confirmed: the 9.28 constructor takes creation flags for storage textures]**),
  with repeat wrapping and 4× anisotropy (Tidewater's setting). The column pass binds them with `setStorageTexture`;
  the plugin samples them as ordinary textures.
- The two dispatches run in `scene.onBeforeRenderObservable`, and only when the CDLOD has selected a sea node. Skipped
  frames cost nothing, because h(k, t) is computed from h0 and t every frame; only the persistent foam restarts,
  fading back in within about 3 s **[likely]**.
- **Mip chains.** Babylon writes a storage texture through a view of **mip level 0 only**: `viewForWriting` is made
  with `mipLevelCount: 1` **[confirmed: `webgpuHardwareTexture.js`]**. The ported mip kernels therefore cannot write
  levels 1–8 through `setStorageTexture`. In order of preference:
  1. a small raw-WebGPU helper that makes per-level views of the same `GPUTexture` and runs the ported mip kernels on
     Babylon's device and command encoder **[likely; it uses Babylon internals, so it is pinned to 9.28 and has a
     test]**;
  2. Babylon's per-layer mip generation (`generateMipmaps(texture, levels, layer)` in `WebGPUTextureManager`
     **[confirmed]**): 2 × C × 8 render passes per frame, cheap on the GPU but an estimated 0.3–1 ms of CPU to encode
     **[projected]**;
  3. no mips: the cascades fade out by pixel footprint, 4× anisotropic taps of level 0 do the rest, and the fog hides
     the far sea.

  CST-O's opening spike decides (§12.4).
- **Sizes [projected]:** **Ultra 4 × 256²**, Tidewater's configuration. **High 4 × 128²**: a cascade's band needs
  about 28 cycles per tile (6 × the size ratio of about 4.7), within the 64 cycles a 128² grid holds. Only the last
  cascade loses its shortest waves, and RND-P's normal maps restore that detail. 128² moves a quarter of the memory,
  which matters on an Apple M1 (§8.11).
- **WGSL only.** WebGL2 has no compute, so the kernels have no GLSL twin. The plugin keeps WGSL/GLSL parity of its
  injection points, and its GLSL path samples Medium's tile. No GLSL reaches the WebGPU engine: the plugin returns
  WGSL there, the compute sources are WGSL, and LAB's guard checks it (WAVE_PLAN3 §6.17). Write-only `rgba16float`
  storage textures are core WebGPU **[likely]**; `shader-f16` for the scratch buffers is used only where the adapter
  offers it.
- **Time:** the shader clock is `WeatherFrame.time`, which wraps at 3,600 s **[confirmed: `weather/frame.ts`]**. The
  angular frequencies are rounded to multiples of 2π / 3,600 s, so the wrap is seamless and the phases stay small in
  32-bit floats **[projected]**.

### 8.4 Waves on Medium and Low: the worker tile and Gerstner

- **The worker FFT tile** serves Medium, High and Ultra without compute, and every PBR preset on WebGL2. A Web Worker
  runs the same spectrum and packed IFFT in TypeScript (`ocean/spectrum.ts`, `ocean/fft-worker.ts`): 2 cascades of
  64² with a non-integer size ratio of about 5.7, including the Jacobian foam, 20 times a second. The main thread
  uploads half floats into the same `RawTexture2DArray` layout as the GPU path and keeps the previous tick's layers;
  the shader interpolates between the two ticks. This is the earlier design's "FFT-lite", moved from Ultra to Medium.
  It needs no compute and runs on WebGL2 (a `sampler2DArray` read in the vertex stage). Worker time is about
  0.5–1 ms per tick, and each upload about 130 KB **[projected]**.
  - *(wave 10r polish, P-LOOK)* **Changed:** the second cascade is now **110 m** (was 400 / 5.7 ≈ 70 m), and the split
    between the cascades hands a wave to the finer tile while it still has at least 4 texels per wavelength
    (`MIN_TEXELS_PER_WAVE` in `ocean/spectrum.ts`), so the calm sea's ≈ 16 m waves keep their slope. The clear-day
    minimum wind is 5 m/s (was 4; about 0.9 m wave height) and the detail ripples 0.7 (was 0.5). High's four GPU tiles
    are unchanged **[confirmed: `ocean-spectrum.test.ts`, `p-look.test.ts`]**.
  - *(refresh 2026-09-29)* **Measured:** a shape-equivalent tick (h0 evolution, 4 packed complex 2D IFFTs per
    cascade, Jacobian, half-float packing of two RGBA layers) takes **0.98 ms median / 1.01 ms p95 for 2 × 64²**,
    2.03 ms for 4 × 64² and 4.57 ms for 2 × 128²; the upload is 128 KiB per tick for 2 × 64² **[confirmed:
    `work/tmp/coast-refresh/fft-bench.ts`, Node 24 on the Ryzen 5 9600X, 200 ticks]**. *(fact-check 2026-09-29, F10:
    re-run 0.999 ms median, 1.42 ms p95; 2.06 ms for 4 × 64², 4.72 ms for 2 × 128². The median reproduces and the
    p95 is noisy.)* At 20 Hz that is 2 % of one
    worker core. On a base M1 performance core expect ×1.2–1.5 **[projected]**. The main-thread upload
    (`texSubImage3D` / `writeTexture` of 128 KiB every third frame) is **[projected]** at ≤ 0.05 ms per upload.
  - *(refresh 2026-09-29)* **Medium is now the default for everyone**, so this tile is the reference look: LAB tunes
    the spectrum, foam and scattering on Medium first and checks that High only adds detail. A player whose worker
    cannot keep 20 Hz (a stalled tab) keeps the last two ticks and the shader holds the last one; nothing blocks the
    main thread.
- Medium's fine detail comes from RND-P's two scrolling normal maps (6 m and 17 m) **[confirmed in RENDER.md]**.
  *(refresh 2026-09-29: they are RND-W's, one generated 128² map sampled twice, `WATER_NORMAL_LAYERS` [confirmed:
  code]; the ocean imports the constants and the texture instead of making its own.)*
- **CPU queries** (ship sway, spray placement, surf emitter gain, whether the camera is under water) read the
  worker's arrays on every preset. On High and Ultra they are close to, but not identical with, the GPU surface. The
  ships sail 250–400 m out in the fog, so that is acceptable **[projected]**. There is no GPU read-back.
- **Low (Classic):** the retail `ShaderMaterial` (WGSL on WebGPU, GLSL on WebGL2), now displaced by 3 Gerstner waves
  whose wavelengths, directions and heights are drawn from the same spectrum, so Low shows the same sea state.
  Steepness Q ≤ 0.6 / N.
- Shore v1's Gerstner shore swell (§8.8) runs on every preset.

### 8.5 Shallow water: per-cascade attenuation and the join with retail water

- **Long waves feel the bottom first.** `WaterSurface.js` scales cascade c by
  `mix(floor_c · smoothstep(0, 0.6, d), 1, smoothstep(0, d0_c, d))`, with `d0_c = min(40 m, 0.08 · L_c)` and floors of
  0, 0.05, 0.25 and 0.5 from the longest cascade to the shortest. For our tiles d0 is 40, 12.6, 2.7 and 0.6 m. On the
  1:30 shelf off S1, 4 m deep at 120 m out, the 733 m swell keeps 3 % of its height, the 157 m cascade 28 %, and the
  chop all of it **[projected arithmetic]**.
- The same rule applies per cascade to the worker tile and per wave (by wavelength) to Low's Gerstner set. It also
  applies to the derivatives, so the normals calm down with the displacement. Waves never lift the sea over a berm.
- **Depth:** from field B in the vertex stage on every preset (4 m texels, bilinear). In the fragment stage it comes
  from the depth renderer on High+. *(refresh 2026-09-29: there is no depth renderer, R4. The fragment stage samples
  field B too, on every preset: one extra bilinear tap, no pass. Near the swash line, where 4 m texels are too
  coarse, the per-pixel depth is `SL + R(t) − h_sand` with `h_sand` from field B's land heights (§8.1), which is what
  the swash front needs anyway.)*
- **Join with retail water (+5 m only):** within 64 m of connected retail water (§8.1), every cascade, the tile, the
  Gerstner waves, the shore swell and the swash fade to 0 *(fact-check 2026-09-29, F6: and the cloud-shadow factor fades to 1, since RND-W's water takes none)*, and the colour fades to RND-W's shared water chunk. The bay
  mouth therefore joins flat **[projected; LAB checks it]**. *(refresh 2026-09-29: "RND-W's shared water chunk" is
  RND-W's `WaterPbrState` and albedo formula, shared as state; see §8.1.)*

### 8.6 Shading: `SroOceanPlugin` on a `PBRMaterial`

One `MaterialPluginBase` on a `PBRMaterial` (`ocean/ocean-plugin.ts`), in WGSL and GLSL. Babylon's PBR already does
what Tidewater writes by hand: the environment reflection with Fresnel, and the key light's GGX specular with its
shadows. The plugin supplies the inputs that `WaterMaterial.js` computes, plus the light from inside the water. The
hook order below is the one in 9.28's WGSL `pbr.fragment`: the bump include, then albedo and alpha, then
`CUSTOM_FRAGMENT_BEFORE_LIGHTS`, then roughness, the reflection block and the lights **[confirmed: shader source in
`@babylonjs/core` 9.28]**.

- **Base:** `metallic` 0, `indexOfRefraction` 1.333 (F0 ≈ 0.02) **[likely]**. Tidewater evaluates the exact
  dielectric Fresnel; Babylon's Schlick form differs only at grazing angles. The albedo is dark, and
  `useRadianceOverAlpha` and `useSpecularOverAlpha` keep the reflection and the glint visible where the water is clear
  **[likely]**. `receiveShadows` is on for High+, so cliffs and ships shade the sea (Tidewater multiplies its sun by
  its shadow map). *(refresh 2026-09-29: and off on any adapter with 16 inter-stage variables; see the varying rule
  below. Medium's CSM reaches 60 m and the terrain does not cast there, so Medium's sea receives no CSM either.)*
- **Vertex** (`CUSTOM_VERTEX_UPDATE_POSITION` **[confirmed: in 9.28's WGSL `pbr.vertex`]**): the CDLOD morph, the
  summed cascade displacement with the §8.5 weights, the shore v1 terms, and varyings for the rest position (Tidewater
  calls it the "lag" XZ), the depth, the vertex foam and the swash.
- *(refresh 2026-09-29)* **Varying rule: one vec4.** Chrome counts `front_facing` against
  `maxInterStageShaderVariables`, and a lit PBR CSM receiver already sits at 16 of 16 on a default WebGPU adapter;
  one more varying invalidates the pipeline and **WebGPU drops the whole frame** (a frozen or black frame, not a
  missing mesh) **[confirmed: `render/gpu-guards.ts`, W9F BF-2]**. The ocean mesh has no uv, no vertex colour and no
  tangent, so it frees slots the RND-W water uses, but it still packs its own data into **one** `vec4` varying: rest
  XZ (2), vertex foam (1) and swash height (1). The depth is re-read in the fragment stage from field B (§8.5), not
  passed. The game already caps 16-varying adapters at Medium (`settings.ts` `hasFewVaryings`) **[confirmed]**, and
  on those the ocean never receives CSM. The dev-only `installVaryingBudgetCheck` must stay silent for every ocean
  variant (a CST-O test counts the declared varyings per define set).
- *(fact-check 2026-09-29, F14)* **WGSL sampling rules.** Every vertex-stage tap (the field, the displacement arrays)
  uses `textureSampleLevel` with an explicit mip (the band-limiting of §8.2 needs that anyway). Fragment taps that
  would sit in non-uniform control flow (the join zone, the swash front, foam thresholds) are taken once at
  `CUSTOM_FRAGMENT_MAIN_BEGIN`, as RND-W's water does for the same reason **[confirmed: `water-plugin.ts` header]**;
  WGSL rejects an implicit-derivative `textureSample` outside uniform control flow. The GLSL twin mirrors the same
  structure so both languages keep the same injection points.
- **Normal** (assigned to `normalW` at `CUSTOM_FRAGMENT_BEFORE_LIGHTS`, after the bump include and before any
  lighting): from the derivative arrays at the rest position. The slopes `(∂Dy/∂x / (1 + ∂Dx/∂x), ∂Dy/∂z /
  (1 + ∂Dz/∂z))` are summed over the weighted cascades (`WaterSurface.js`). Ultra adds Tidewater's near-field detail:
  within a few metres of the camera the finest cascade is re-sampled at tiles of about 1 m and 2.3 m, rotated, so the
  water is not glassy close up. Facets turned away from the camera are bent to grazing, not flipped
  (`WaterMaterial.js`). While it rains, WX-R's ripples (`sroRipple`) are added **[confirmed: `weather/ripples.ts`,
  `pbr/terrain-plugin.ts` `RIPPLE_SHARED_NAME`]**.
- **Roughness** (`CUSTOM_FRAGMENT_UPDATE_MICROSURFACE`): the Cox–Munk mean square slope `mss = 0.003 + 0.00512 · U`
  is weighted by the share of the slope spectrum that the pixel footprint cannot resolve, then
  `α² = α0² + 2 · mss · unresolved + 0.2 · foam`, with α0 = 0.035 (`WaterMaterial.js`). U is `WeatherFrame.gustMs`.
  This replaces the fixed 0.04 / 0.15 / 0.25 steps: rough, gusty patches blur the glint and calm water mirrors.
- **Reflection:** RND-L's sky cube (`SkyEnvironment`: 32² on Medium, 64² on High+; D14), sampled by the PBR at the
  roughness mip. Two corrections come from `WaterMaterial.js`: the reflected ray is tilted up by the unresolved slope
  spread (rough water reflects higher, darker sky), and rays below the horizon fade to `horizonColor × 0.35`, because
  they would hit other waves. The plugin applies them by defining `USE_CUSTOM_REFLECTION` and calling Babylon's own
  `reflectionBlock` at `CUSTOM_REFLECTION` with a tilted normal **[confirmed: the hook replaces the reflection block;
  that the call works unchanged is likely]**. SSR does not apply to water. A 64² cube softens a mirror-calm sea at the
  horizon **[likely]**; LAB judges it.
  - *(refresh 2026-09-29)* As built, the cube is one CPU-filled `RawCubeTexture` (RGBA16F, CPU-prefiltered mips, one
    face per frame, then one upload) assigned to `scene.environmentTexture`: 32² refreshed every 10 s on Medium, 64²
    every 5 s on High and 2 s on Ultra **[confirmed: `render/lighting.ts`, `render/quality.ts`]**. It holds the sky
    only (clouds, sun glow, no terrain), so a cliff is not mirrored in the sea on any preset; that is accepted (SSR is
    off on High since the wave-9 cut 4, and does not apply to alpha-blended water anyway). The ocean reads nothing but
    `scene.environmentTexture`, so SKY2's GPU IBL (time-sliced prefilter, larger cube, clouds in the panorama) reaches
    the sea without an ocean change (§8.13, S-IBL). On Medium's 32² cube a calm sea at noon is a soft mirror; the
    reflection's sharpness is SKY2's cube size, not the ocean's.
- **Glint:** the key light's GGX lobe with the roughness above, clamped to stay inside the half-float HDR target
  (Tidewater clamps the lobe at 400). The moon takes over at night (SKY). Cloud shadows (`sroCloudShadow`, D28) dim it
  on High. *(refresh 2026-09-29: the extern is `SKY_CLOUD_SHADOW_WGSL/GLSL` from `sky/chunks.ts`, on when the sky
  preset's `cloudShadows` is `ground` (High) or `all` (Ultra), off on Medium [confirmed: `sky/types.ts`
  `SKY_PRESETS`, `pbr/terrain-plugin.ts`]. The ocean counts as ground. It multiplies the glint and the in-water sun.
  The glint clamp also keeps a sunlit sea from dragging SKY2's auto exposure down: the metering must clip at the same
  cap, S-EXPO in §8.13.)*
- **Scatter colour by depth** (`CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION`): Tidewater's analytic single
  scattering (`WaterMaterial.js`):
  - per-channel absorption σa and scattering σs (`coast.json` `ocean.medium`), starting from pure-water absorption
    (red ≫ green > blue) and tuned in LAB so the sea sits well next to RND-W's river water;
  - a Henyey–Greenstein phase (g 0.86) mixed 70/30 with an isotropic one, and multiple-scattering backscatter after
    Gordon's `R = 0.33 · bb / (a + bb)`;
  - sun and sky light integrated in closed form along the refracted view ray, over the path length to the bed: the
    depth renderer on High+ (the one RND-W and SSAO use), field B on Medium, and the field wherever the depth buffer
    is at the far plane; *(refresh 2026-09-29: field B on every preset, R4; the path length is depth / cos θ of the
    refracted ray, clamped at 60 m)*
  - crest translucency: crests lit from behind glow green-blue in proportion to their height (colour
    (0.12, 0.55, 0.45) × 0.06).
- **Transparency** (`CUSTOM_FRAGMENT_UPDATE_ALPHA`): alpha = 1 − the mean view transmittance `exp(−σt · path)`. The
  per-channel tint rides on the in-scattered colour, which keeps RND-W's alpha-blended policy. **Ultra option (first
  in the cut list):** Tidewater's own model, opaque water that refracts a copy of the opaque scene with exact
  per-channel absorption. It needs an opaque-scene colour copy from RND-P's chain **[unknown cost]**.
- **Foam** (`CUSTOM_FRAGMENT_UPDATE_ALBEDO` and the composition point): the Jacobian foam from the displacement alpha,
  weighted per cascade (0.35, 0.45, 0.5 and 0.25 in `WaterSurface.js`), the shore foam of §8.8, and field A. Foam is
  lit as a diffuse scatterer with albedo 0.85, by wrapped sun plus sky irradiance (`WaterMaterial.js`), with our
  night floor `max(0.25, sunLight)`.
- **Fog:** the D18 height fog (`SroFogPlugin`, `HEIGHT_FOG_WGSL` / `HEIGHT_FOG_GLSL` **[confirmed exports]**) runs
  after this plugin. It is coloured from `SkyState.fogColor`, or from `horizonRing` by azimuth on High+. The sea fades
  into the colour the dome shows below the horizon, so there is no seam **[likely; LAB: horizon strip
  |ΔRGB| ≤ 2/255]**. *(refresh 2026-09-29: the plugin is registered globally and attaches itself to every PBR material
  of a scene with an active HeightFog, so the ocean material gets it with no code [confirmed: `pbr/fog-plugin.ts`
  `attachFogPlugin`, `heightFogOf`]. It runs at `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR`, after image processing, which is
  correct only because every PBR preset applies image processing in post [confirmed: same header]. Medium has no
  horizon ring. When SKY2 replaces the colour with haze, the ocean inherits it the same way: S-HAZE, §8.13.)*
- **Terrain wet band:** it keeps its two seams, both in files owned by other lanes **[confirmed: code]**, and is now
  driven by the shore v1 swash (§8.8). Its shader text lives in `packages/world-render/src/coast/chunks.ts` (CST-S):
  - **Classic** (`shaders.ts` line 31, `WORLD_SHADER_CHUNKS = [SKY_CHUNKS, WEATHER_CHUNKS, NIGHT_CHUNKS,
    RENDER_GRASS_CHUNKS]`): add `COAST_CHUNKS` before render, at the existing `preLight` point. That is an import plus
    an array entry, done by I9A, because no lane may edit `shaders.ts` after W9A-S.
  - **PBR terrain** (`pbr/terrain-plugin.ts`, owned by RND-T): one more extern, `sroCoastWet`, next to
    `sroCloudShadow`, `sroNightSplat` and `sroShelter`, added by RND-T or I9A after 9A merges.
  - *(refresh 2026-09-29)* Re-checked: `WORLD_SHADER_CHUNKS` is still line 31 and "No lane edits this file" still
    heads `shaders.ts`; the terrain plugin's externs are still exactly `sroShelter`, `sroCloudShadow` and
    `sroNightSplat`, each behind its own define, "a function whose source is still empty is simply off"
    **[confirmed: code]**. RND-T and I9A are finished, so **I-CST** makes both one-line hooks. Two constraints from
    the shipped plugin: `sroCoastWet(worldPos)` adds **no varying** (it takes `vPositionW`, as the splat does), and the
    one texture it samples (the coast field) must keep **every final define set at ≤ 16 WebGL2 texture units** (D32,
    `test/terrain-plugin.test.ts`); where a set is full, the extern reads the field only when `SRO_SHELTER` is off, or
    shares the shelter's unit **[projected; CST-S's test decides]** *(fact-check 2026-09-29, F16: the D32 test asserts
    that today's worst set already uses ≥ 15 units [confirmed: `test/terrain-plugin.test.ts` 342–366], so the fallback
    is likely needed on Ultra with full weather)*. The result feeds the plugin's existing wetness as
    `wet = max(weatherWet, coastWet)`, so porosity, wet roughness and the SSR mask (D31) apply unchanged.

### 8.7 Weather coupling

Tidewater sets its sea state by hand and has no weather (the lead's notes; no weather input appears in the files
read). Ours follows `WeatherFrame`: `windX`, `windZ`, `windMs`, `gustMs`, `rain`, `flash` and `time`
**[confirmed: `weather/frame.ts`]**.

| Input | Drives | How |
|---|---|---|
| `windMs`, `windX`/`windZ`, low-passed (τ ≈ 30 s) | The local wind sea: the speed and direction of `OceanFFT.js`'s first `WaveSystem` | The spectrum is rebuilt when the speed moves by more than 0.25 m/s or the direction by more than 3°, at most once a second. The hashed Gaussians stay fixed, so the sea grows or calms smoothly instead of re-rolling **[likely]**. The fetch comes from `coast.json` (default 60 km **[projected]**). |
| Weather state, blended (clear … storm) *(refresh 2026-09-29: `WeatherFrame` has no state, R9; the storminess is `s = saturate((windMs − 2) / 11)` from the blended `windMs` (clear 2, rain 6, storm 13 m/s), raised by `cloudDark` (0 … 0.85) as `max(s, 0.8 · cloudDark)`, low-passed over τ ≈ 120 s [confirmed inputs: `shared/src/weather.ts`; the mapping is projected])* | The swell: scale 0.2 → 0.9 and wind 6 → 14 m/s, over minutes | Its direction is fixed per map, from the open sea (`coast.json` `ocean.swellFromDeg`). |
| `gustMs` | Short-wave roughness (Cox–Munk), the whitecap threshold (Jacobian bias 0.58 → 0.7 in gusts), choppiness λ 0.9 → 1.1 in storms | Uniforms only, every frame |
| Height clamp | Hs ≤ 2.5 m for gameplay, as before | The CPU integrates the spectrum (Hs = 4 √variance) and scales the amplitudes down to the clamp |
| `rain` | WX-R ripples, a roughness term, the finest cascade × 0.7 (rain damps short waves) | |
| `flash` | Nothing extra: lightning reaches the sea through the key light and the sky (D25) | |
| Fog weather | Nothing extra: the height fog brings the horizon closer | |

Low's Gerstner set and Medium's tile read the same parameters, so every preset shows the same sea state.

### 8.8 The shore

**Shore v1** (wave 10, lane CST-S):

*(beaches 2026-09-29: with beaches all round, the swash and the foam band now run along every sea shore (about 11–12 km of
beach in the domain instead of a few stretches) **[projected from the preview]**. The cost is per pixel on screen, not
per metre of shore, so the budget does not change; the "no sheet on steep rock" rule now applies only to the river-mouth
banks. The mountain kind's steeper foreshore (1:13 shelf) gives a shorter, steeper run-up than S1's, which LAB checks.)*

- **A foam band from the sea depth:** foam where the water is shallower than 0.3 m (RENDER §7), plus the breaking
  line of the shore swell below, fading over 30 m behind it. On High+ a thin bead is added where the depth-buffer water
  thickness is under about 3 cm, like Tidewater's swash-front bead (`WaterMaterial.js`). *(refresh 2026-09-29: no depth
  buffer is available to the ocean, R4; the bead is drawn from the analytic swash film thickness `SL + R(t) − h_sand`
  instead, on Medium and up. The depth-buffer bead moves to the later lanes.)*
- **A Gerstner shore swell:** one wave train per shore point, travelling along −∇G (the field's shore normal). Its
  period comes from the swell system (Tidewater's `ShoreWaves.js` uses 9 s) and its phase is
  `t / T − G / (c(d) · T)` with `c = √(g · d)`, so crests bunch up in shallow water. Its height grows by Green's law
  (H ∝ d^−¼) until H > 0.78 · d (Tidewater's γ), where it turns into the foam line. It is the cheap stand-in for shore
  v2's breakers, and it gives the swash visible waves behind it.
- **Swash run-up: a time-varying waterline against the sand height.** Each wave's run-up follows `shoreSwashRunup` in
  `ShoreWaves.js`: an uprush over 40 % of the period that decelerates (`1 − (1 − s)^1.5`), then a backwash over 55 %
  that starts slowly and speeds up (`1 − s^1.6`), a lobed front that differs from wave to wave along the shore, and a
  thin film that never uncovers the waterline. The vertical run-up stays `R = 0.15 + 0.25 · Hs` m (≤ 0.8 m). Tidewater
  uses 2.1 × the wave amplitude, roughly the wave height, which is 2–3 times more for waves about a metre high; LAB
  tunes between the two on S1.
  - In the vertex stage the sheet is `y = smoothmax(y_wave, SL + R(t))` on gentle slopes, with no sheet on steep rock
    (`WaterSurface.js` does the same), and the depth test against the sand shows the water climbing and sliding back.
  - The front per pixel: Tidewater converts the run-up into a distance up the beach with a nominal slope and compares
    it with the sand height. We do the same with field B's land heights (§8.1) and our wet-sand slope of 1:13 (§3.2).
    The along-shore coordinate for the lobes is the position projected on the shore tangent.
- **The foam look:** the lace texture of `SurfFoam.js` (`makeLaceTexture`): tileable, 512², 3.5 m per tile. R is the
  distance to the nearest bubble strand, G small bubbles along the strands, B a mottling, and A a random value per
  cell. Thresholding R by the foam amount turns a dense mat into foam with holes, then lace, then single strands as the
  foam decays. Our port of the generator runs once at load in the ocean worker (deterministic, ≤ 300 ms off the main
  thread **[projected]**), 1.4 MB on the GPU with mips. It replaces B-coast's hand-made foam (§7.2).
- **Wet sand:** the terrain wet band darkens and smooths the sand below SL + R_max, and shows a receding sheen where
  the sand was covered in the last seconds (an analytic "time since covered" from the same swash function).
- Low: the vertex swash and the scrolling foam band, without lace.

**Shore v2** (later and optional; each lane waits for the beach playtest after I-CST; costs in §8.11):

- **Breaking waves** (CST-W; High and Ultra on WebGPU). `ShoreWaves.js` **[confirmed: header and swash code read]**:
  - the phase comes from a precomputed travel-time field, so fronts refract around headlands and align with the depth
    contours;
  - each wave has its own height (sets, and variation along the shore); it grows by Green's law until H > γ·d (γ 0.78),
    then its front face turns into a concave plunging wall, the tube collapses into a turbulent bore, and the bore runs
    up the beach as the swash sheet;
  - a sand bar with rip channels; a separate sheet for the thrown lip (Tidewater's `Breakers`, named in that header,
    not read);
  - the evaluation is skipped where the water is deeper than 26 m (`WATER_SHORE_DEEP` in `WaterSurface.js`), and the
    per-cascade attenuation of §8.5 hands the near shore over to it.

  It needs **CST-C to write `coast/shore.png`**: the travel time, the wave direction and the exposure (shelter behind
  headlands), for example from a fast-marching eikonal solve over `c = √(g · min(d, 25 m))` seeded on the swell side
  **[projected; how Tidewater builds its field was not read]**. The source file alone is 35 KB **[confirmed]**, so
  shader compile time matters. It is about 1–2 weeks of one lane **[projected]**.
- **Surf simulation** (CST-F; High and Ultra; needs CST-W). `ShoreSim.js` **[confirmed: header read]** updates a state
  over the beach on the GPU every frame: the foam carried by the water (advected by bores, uprush and backwash, and
  thinned where the flow spreads), the sand wetness (it dries over about 28 s), the foam stranded on the sand (it pops
  within seconds) and the flow speed. Tidewater runs 768² over a fixed 380 m square in `rgba16float` ping-pong
  textures. Ours would be a camera-centred window of 512² over 256 m (0.5 m texels) that re-centres in steps, with two
  `ComputeShader`s. Where active, it replaces shore v1's analytic wet band and foam.
- **Caustics** (CST-K; Ultra), in the style of Evan Wallace's WebGL water (named in the lead's notes). A 128² grid
  refracts the sun through the two finest cascades onto a plane at the local depth; the brightness is the ratio of a
  grid cell's area before and after. The result goes into a 256² texture around the camera (about 64 m), which the
  terrain plugin reads under water shallower than 4 m through one more extern (`sroCaustics`, added by RND-T or
  I-CST). B-coast's 16-frame caustic set is dropped.

### 8.9 Night, rain and storms

| State | What changes | Source |
|---|---|---|
| Night | Dark-cube reflections, a moon glint, in-water light from the moon and sky irradiance only; foam dims but stays readable (`max(0.25, sunLight)`) | `SkyState`, RND-L |
| Rain | Ripple normals, the rain roughness term, the finest cascade × 0.7, a darker sea (`desat`), visibility halved by the weather fog | `WeatherFrame.rain`, WX-R |
| Storm | Hs up to 2.5 m (the spectrum clamp), choppiness 1.1, lingering whitecaps, additive spray sprites (`wave1..3`, ≤ 32 billboards around the camera) where the shore swell breaks on rocks or cliffs *(beaches 2026-09-29: there are no cliffs now; spray goes where the storm swell breaks on the shelf edge and at the ends of the beaches, and is cut first if it looks thin)*, louder surf, lightning | `windMs`, `gustMs`, `flash` |
| Fog weather | Nothing extra: the height fog brings the horizon closer | WX |

### 8.10 Presets, including the Classic fallback

*(refresh 2026-09-29: the table is re-derived from the shipped presets, `render/quality.ts` `RENDER_PRESETS` and
`sky/types.ts` `SKY_PRESETS` [confirmed]. Changed rows: depth, reflection, cloud shadows, fog, AA and the bead.)*

| | Low (Classic) | **Medium (the default)** | High | Ultra |
|---|---|---|---|---|
| Material | `ShaderMaterial`, retail frames `water101..130` × `WaterColor(t)` (TERRAIN.md §4) | PBR + `SroOceanPlugin` | same | same |
| Waves | 3 Gerstner waves drawn from the spectrum | Worker FFT tile, 2 × 64², 20 Hz (0.98 ms per tick, measured) | GPU FFT, 4 × 128² (the tile without compute) | GPU FFT, 4 × 256², near-field detail (the tile without compute) |
| Shallow water | Per wave | Per cascade | Per cascade | Per cascade |
| Mesh (CDLOD) | G 16, 6 levels (≈ 640 m) | G 16, 8 levels | G 32 | G 64 |
| Depth, path length | Field B; the retail alpha rule (full at 3 m) | Field B | **Field B** (no depth renderer exists, R4) | Field B |
| Colour | Retail | Analytic scattering; RND-W's state in the join zone | Same | Same; opaque refraction as an option |
| Foam | Scrolling band from G | Band, breaking line, tile Jacobian, lace, analytic bead | + lingering whitecaps, spray | Same |
| Reflection | None | Sky cube 32², every 10 s | Sky cube 64², every 5 s; receives CSM (never on a 16-varying adapter) | 64², every 2 s |
| Cloud shadows (`sroCloudShadow`) | — | — | `ground`: the sea counts as ground | `all` |
| Fog / haze | Classic linear | Height fog, `SkyState.fogColor` (SKY2's haze when it lands) | + horizon ring | Same |
| AA the sea is drawn under | MSAA ×4 | FXAA | TAA (LAB checks ghosting on displaced waves) | TAA |
| Shore v1 | Vertex swash | Swash; per-pixel front from field B; analytic bead | Same | Same |
| Shore v2 (later) | — | — | Breakers, surf simulation | + caustics |

~~First-run WebGL2 lands on Low (WAVE_PLAN3 §5.1).~~ *(fact-check 2026-09-29, F7: stale; since the release, WebGL2 also starts on Medium and only WebGL1 gets Low [confirmed: `settings.ts` `recommendGraphics` 500–509].)* A player who picks High or Ultra on WebGL2 gets the worker tile (no compute) with that preset's mesh and shading.
*(refresh 2026-09-29: since the release, the first run gives **Medium on every adapter class**, at render scale 0.75
on an integrated GPU (weather low) and on a Retina Mac; WebGL1 gets Low; a 16-varying WebGPU adapter is capped at
Medium [confirmed: `settings.ts` `recommendGraphics`, `hasFewVaryings`]. So nearly every friend sees Medium's ocean.)*

### 8.11 Budgets (the WAVE_PLAN3 §5.2 format) (refresh 2026-09-29)

*(refresh 2026-09-29: rewritten against the measured wave-9 numbers, `work/tmp/w9-finish/budgets.md`. The earlier
all-projected GPU table is kept below as table 2, because its GPU arithmetic still holds.)*

**Setup.** Dev PC = Ryzen 5 9600X + RX 9060 XT, Chrome's pane, 1920 × 1080 at hardware scaling 1, the production
bundle, frames on prof.js's uncapped pump, 400 frames after streaming went idle (the wave-9 final gate's method).
"Mid" = RTX 3060 / RX 6600; "gaming laptop" = RTX 3060–4060 Laptop; Apple columns at a 1080p-equivalent size.
**The coast view** is the S1 beach at `tp beach-south` (170.5, 90.6), looking south-east over the sea (about half the
screen), clear noon, and the same spot in a storm at night. It cannot be measured before the coast exists, so its
**baseline is the closest measured scene**, the wave-9 "gate storm" (the south gate and wall, 295 draws on Medium
WebGPU). That is an **upper bound** for the beach: half of the beach view is sea, which has no props **[likely]**.

**What the coast adds, per draw.** Wave 9 measured that the game is **CPU-bound in draw submission**: a PBR draw costs
about 0.021 ms of main-thread CPU on WebGPU (Medium crowd 11.8 ms CPU for 574 draws; High crowd 18.8 ms for 858)
**[confirmed arithmetic on measured rows]** *(fact-check 2026-09-29, F9: that is an average, total CPU ÷ draws, which
includes the active-mesh walk; `budgets.md` splits High's crowd into ≈ 0.018 ms per main PBR draw and ≈ 0.006 ms per
CSM caster draw, so per-draw adds below are [projected from measured averages])*, and GPU time is 1.5–4.6 ms of a 6–21 ms frame on the dev PC
**[confirmed]**. So the coast's budget is written in **main-thread ms and draws first**. The ocean is 1 thin-instanced
draw plus its depth pre-pass (+2 draws), the CDLOD walk (0.022 ms, **[confirmed: `fft-bench.ts`]**), the node buffer
and uniforms, a 128 KiB upload every third frame on Medium, 2 compute dispatches on High/Ultra; the synthetic regions
are +9 (Medium) / +11 (High) draws at worst at the south-east corner (§2.2).

Table 1: the coast view on the dev PC **[baseline confirmed (measured scene); adds and totals projected]**

| Preset | Baseline "gate storm": frame p95 WebGPU / WebGL2 (CPU p50 WebGPU) | + coast CPU, main thread | + coast draws | + coast GPU (dev) | Coast view p95, WebGPU / WebGL2 | Pass line |
|---|---|---|---|---|---|---|
| Low (Classic) | 3.7 / 2.4 ms (2.6) | ≈ 0.1–0.15 ms | +7 terrain, +1–2 ocean | ≈ 0.05 ms | ≈ 3.9 / 2.6 ms | < 16.7 ms: **pass** |
| **Medium (default)** | 8.1 / 7.2 ms (6.3) | ≈ 0.4 ms (ocean ≈ 0.1, terrain ≈ 0.2, life ≤ 0.1) *(fact-check: life added, F9)* | +9, +2, +6 life | ≈ 0.15 ms | ≈ 8.5 / 7.6 ms | < 16.7 ms on both backends: **pass, ~8 ms spare** |
| High (cut 4) | 15.9 / 14.1 ms (13.2) *(the WebGL2 14.1 was measured before cut 4: an upper bound, F9)* | ≈ 0.45–0.5 ms (incl. life ≤ 0.1) | +11, +2, +6 life | ≈ 0.25–0.3 ms | ≈ 16.4 / 14.6 ms | not the default; must not add more than its budget (below). High's own 16.7 ms pass waits for the perf item (BACKLOG 9) |
| Ultra | 16.0 / – ms (13.1) | ≈ 0.5–0.55 ms (incl. life) | +11, +2, +6 life | ≈ 0.5–0.55 ms | ≈ 16.5 / – ms | not offered by default; measured and reported |
| Any, no sea in view | – | ≤ 0.02 ms (the walk; the mesh is invisible, F2) | 0 | 0 | unchanged | – |

*(fact-check 2026-09-29, F9)* The +9 / +11 terrain draws are the **south-east-corner worst case** (§2.2). At the beach
bench (170.5, 90.6) the nearest synthetic row (z 88) starts ≥ 307 m away, so only 3–4 synthetic regions fall inside
Medium's 400 m load radius, and they may not be emitted at all (13.7 m deep at the export edge, §3.2). None is
inside High's 150 m CSM range, so they add no caster draws **[projected arithmetic]**. Table 1 is therefore an
upper bound at the bench. The ocean's CPU includes the depth pre-pass's per-call readiness check (F3); if the
spike measures more than 0.1 ms for the ocean on Medium, the depth-only twin replaces it.

Table 2: the ocean's own GPU cost by machine class *(kept from 2026-09-28; still [projected]: memory traffic and
vertex/tap counts scaled by bandwidth, an M1 (8-core GPU) at about 4.5 × a mid desktop, an M1 Pro at about 2 ×, a
gaming laptop at about 1.2 ×)*

| Preset | Ocean CPU (dev, main thread) | GPU dev PC | GPU mid desktop | GPU gaming laptop | GPU Apple M1 | GPU M1 Pro / M2 Pro and up | VRAM |
|---|---|---|---|---|---|---|---|
| Low | 0.03–0.05 ms | 0.04 ms | 0.05–0.07 ms | 0.06–0.08 ms | 0.25–0.3 ms | 0.1–0.15 ms | field 4.4–4.9 MB |
| Medium | 0.06–0.1 ms (+ worker 0.98 ms per tick measured, off the main thread) | 0.1 | 0.15–0.2 | 0.2–0.25 | 0.7–0.9 | 0.3–0.4 | + tile 0.3 MB, lace 1.4 MB |
| High | 0.12–0.2 ms | 0.2–0.25 | 0.3–0.4 | 0.35–0.5 | 1.3–1.8 | 0.6–0.8 | + FFT ≈ 6 MB |
| Ultra | 0.15–0.25 ms | 0.4–0.5 | 0.6–0.8 | 0.75–0.95 | 2.7–3.6 | 1.2–1.6 | + FFT ≈ 22 MB |
| Any, no sea in view | ≤ 0.02 ms | 0 | 0 | 0 | 0 | 0 | same |

What the tables mean, honestly:

- **Medium, the default, has room.** The coast view projects to about 8.5 ms p95 on the dev PC on either backend (8.4 before CST-A's life was counted, F9),
  about half the 16.7 ms line. The ocean's GPU cost is small next to that; its CPU cost is mostly the extra terrain
  draws, which a player already pays in the interior (an edge player's region disk is never fuller than an interior
  one, §2.2) **[likely]**.
- **High is already at its line before the coast.** The gate storm is 15.9 ms p95 on WebGPU after cut 4, so the
  coast's +0.45–0.5 ms (with life, F9) leaves about 0.3 ms of margin, and a stormy night at the beach may cross 16.7 ms **[projected]**.
  That is High's known CPU problem (per-draw PBR cost, BACKLOG 9), not the coast's; the coast does not claim a High
  pass, only that it stays inside its own budget. If the perf item lands first, High gets the full margin back.
- **The FFT is bandwidth-bound** (table 2's reasoning): Ultra moves about 45–55 MB per frame, High about 12 MB. The
  vertex stage (≈ 25k / 90k / 340k vertices, twice because of the depth pre-pass) and about a million shaded pixels
  with 15–20 taps dominate every preset below Ultra.
- **CPU:** mip route 2 (§8.3, per-layer `generateMipmaps`) would add 0.3–1 ms of CPU; on a CPU-bound High that is
  not acceptable in any form, so if route 1 fails, route 3 (no mips) ships.
- **Apple Silicon** *(refresh 2026-09-29)*: the first-run rule is settled: Medium on every Mac, render scale 0.75 on
  a Retina display (`recommendGraphics`) **[confirmed]**. At 0.75 of a 2× Retina MacBook (2160 × 1350 for a
  1440 × 900-point screen) the fragment work is about 1.4 × 1080p. WAVE_PLAN3's Medium total of 2.1–2.8 ms GPU on a mid
  desktop becomes ≈ 9.5–12.6 ms on a base M1 at 1080p-equivalent, and the ocean adds ≈ 1.0–1.3 ms at the Retina
  size: **≈ 11–15 ms of GPU on a base M1 at the beach [projected]**, inside 16.7 ms but not by much.
  *(fact-check 2026-09-29, F11: that path scaled the ocean to the Retina size but not the base. Redone from the
  measured Medium GPU on the dev PC (1.54–1.67 ms, gate storm and fields night, `budgets.md`) × a mid desktop at
  1.0–1.3 × dev × an M1 at 4.5 × mid × 1.4 for Retina 0.75 ≈ 9.7–13.7 ms, + the ocean 1.0–1.3 ms ≈ **11–15 ms
  [projected]**: the result stands. Not in it: on WebGPU, FSR1 takes the render scale and the canvas stays at full
  size [confirmed: `settings.ts` `applyGraphics`], so FSR1 and any post after it run at the native 2880 × 1800
  [unknown cost]. The CPU matters as much: a base M1's single core is about 1.3–1.5 × slower than the 9600X
  [projected], which puts the beach at ≈ 11–13 ms CPU p95 on Medium, inside the line, and Medium's crowd (14.1 ms CPU
  p95 on the dev PC) near or over it. The Mac bench (§15 item 4) measures both.)* The first
  friend's Mac bench decides; the Mac levers are in the scope-cut list (lace off, G 16 → 8 on Medium, 6 levels).
- **The iGPU class does not exist among the friends** (the user's decision); the Medium ≤ 0.9 ms iGPU target stays
  only as a guard for the 0.75-scale rule.
- **Sky and sea share one envelope.** SKY2 adds its own cost on top (volumetric clouds on High+, haze, shafts, GPU IBL,
  auto exposure). WAVE_PLAN4 adds the two specs' budgets for the beach view and holds the sum to the whole-game lines
  below; this spec's numbers are the coast's share only.

Per-lane budgets (each lane measures with RENDER §16's hygiene; CPU = main thread on the dev PC):

| Lane | Budget |
|---|---|
| CST-O ocean, Low | ≤ 0.1 ms GPU mid; CPU ≤ 0.05 ms; ≤ 2 draws |
| CST-O ocean, **Medium** | ≤ 0.2 ms GPU mid, ≤ 1.3 ms on an M1 at Retina 0.75; CPU ≤ 0.1 ms including the depth pre-pass's readiness check (F3); worker median ≤ 1.2 ms, p95 ≤ 1.6 ms per tick (measured 0.98–1.00 / 1.01–1.42, F10); upload ≤ 0.05 ms per tick; ≤ 2 draws |
| CST-O ocean, High | ≤ 0.4 ms GPU mid, ≤ 1.8 ms on an M1; CPU ≤ 0.15 ms including the 2 dispatches; ≤ 2 draws + 2 dispatches |
| CST-O ocean, Ultra | ≤ 0.8 ms GPU mid; CPU ≤ 0.25 ms |
| CST-O, no sea in view | No dispatch and no draw; CPU ≤ 0.02 ms; **no** active-mesh list rebuild from the ocean at all (it toggles `isVisible`, F2) |
| CST-S shore v1 | ≤ +0.05 ms GPU mid inside the ocean draw; terrain wet band ≤ +0.05 ms; 0 extra draws; no new varying; lace generation ≤ 300 ms in the worker at load |
| CST-W breakers (later) | ≤ +0.25 ms GPU mid at the beach; ≤ +2 s of shader compilation at first load |
| CST-F surf simulation (later) | ≤ +0.1 ms GPU mid; 4 MB VRAM |
| CST-K caustics (later, Ultra) | ≤ +0.15 ms GPU mid; 0.25 MB VRAM |
| CST-C synthetic terrain | Worst case +9 resident regions on Medium / +11 on High at the SE corner: +4–5 MB VRAM, +9–11 draws (≈ +0.2–0.25 ms CPU), +0.17–0.2 M triangles. Never above the interior peak. |
| CST-A audio and life | ≤ 6 extra voices; ≤ 0.3 MB extra download; ships and flocks ≤ 6 draws, ≤ 0.1 ms CPU (cut early if over) |
| **Coast total at the beach** | **Medium: ≤ +0.4 ms CPU p95 and ≤ +17 draws over the baseline; High: ≤ +0.5 ms CPU and ≤ +19 draws** *(fact-check 2026-09-29, F9: was +15 / +17, which left out CST-A's ≤ 6 draws: 9 + 2 + 6 = 17, 11 + 2 + 6 = 19)* |
| Whole game | **Medium holds 60 fps (p95 < 16.7 ms) at the beach on both backends, clear noon and stormy night, with SKY2 on**: the release's pass line. High: no worse than its wave-9 baseline plus the coast's total above. If friends can run the bench: Medium on a base M1 at Retina 0.75 and on a gaming laptop, p95 < 16.7 ms on the beach by day. |

VRAM: the coast field 4.4–4.9 MB; the lace 1.4 MB (RGBA8 with mips; *fact-check F13: it is generated at load and there is no runtime BC7 encoder, so the earlier "0.35 MB as BC7" needs an offline bake*); Medium's tile 0.3 MB; the FFT's buffers and
arrays ≈ 6 MB on High and ≈ 22 MB on Ultra; later the surf simulation 4 MB and caustics 0.25 MB; B-coast terrain sets
per TEXPIPE §6.5 **[projected arithmetic]**. The storm chop normal map is gone, because the spectrum carries the chop.
*(refresh 2026-09-29: against the measured texture VRAM of 848–1,028 MiB on Medium and 985 MiB on High (WebGPU), the
coast adds about 11 MB on Medium and 17 MB on High, plus at most one 16-layer growth step of the 512 base tile array
if the coast tiles do not fit its free layers (≈ 22 MB per plane) **[projected]**: under +6 % in the worst case.)*

### 8.11B Budgets for beaches everywhere (beaches 2026-09-29)

What changes against §8.11 is the terrain: more band regions carry land (B6), so the resident worst case rises
(B7), and the coast's birds move to GRASS_LIFE (B15). The ocean, the shore and the field are per-pixel or per-node
costs and do not change. Dev PC and machine classes as in §8.11; CPU = main thread on the dev PC.

| Preset | Coast view baseline p95, WebGPU / WebGL2 (gate storm, measured) | + terrain draws, worst case (SW corner) | + ocean draws | + ships | + coast CPU, main thread | + coast GPU, mid | + VRAM | Coast view p95, WebGPU / WebGL2 | Pass line |
|---|---|---|---|---|---|---|---|---|---|
| Low (Classic) | 3.7 / 2.4 ms | ~~+11~~ **+8** (320 m; G3) | +1–2 | 0 (off on Low) | ≈ 0.1–0.15 ms | ≈ 0.05–0.1 ms | +3.6 MB | ≈ 3.9 / 2.6 ms | pass |
| **Medium (default)** | 8.1 / 7.2 ms | **+11** (was +9) | +2 | ≤ +3 | **≈ 0.4–0.45 ms** (terrain ≈ 0.23, ocean ≈ 0.1, ships ≤ 0.05) | ≈ 0.2 ms | +5 MB terrain, + field 4.6–5.2 MB | **≈ 8.6 / 7.7 ms** | < 16.7 ms: **pass, ~8 ms spare** |
| High | 15.9 / 14.1 ms | **+17** (was +11) | +2 | ≤ +3 | ≈ 0.5–0.6 ms (terrain ≈ 0.31 at 0.018 ms per main PBR draw; no new CSM casters, the nearest new row is ≥ 192 m away) | ≈ 0.3–0.35 ms | +7.7 MB terrain | ≈ 16.5 / 14.7 ms | at its line, as before; see below |
| Ultra | 16.0 / – ms | +17 | +2 | ≤ +3 | ≈ 0.55–0.65 ms | ≈ 0.55–0.6 ms | +7.7 MB | ≈ 16.6 / – ms | not a default |
| Any, no sea in view (the plaza, the town, the fields) | – | 0 | 0 | 0 | ≤ 0.02 ms | 0 | same | unchanged | – |

All values **[baseline confirmed, adds projected]**: draws from the census (B7), ≈ 0.021 ms per PBR draw (a measured
average, F9), ≈ 0.45 MB of GPU memory and 18,432 triangles per region (§2.2), GPU by the §8.11 table 2 method.
*(beaches fact-check 2026-09-29, G3: the draw columns are resident regions within the load radius; a player walking
along the south bound to the corner can keep **up to +19 (Medium) / +22 (High)** resident through the unload
hysteresis (560 / 660 m), ≈ +8.6 / +9.9 MB of VRAM, while the draws stay bounded by what the frustum holds, about
half of them from a 40 m orbit camera [likely]. On WebGL2 the measured average is lower, ≈ 0.016 ms per draw (Medium
crowd 9.1 ms CPU for 574 draws), so the WebGPU adds are the upper bound for both backends [confirmed: `budgets.md`].)*

- **The worst case is a corner, not a busy scene.** It is the south-west corner of the bounds (156.0, 90.0), the top of
  the Tiger mountains. At the beach bench (170.5, 90.6) the Tiger rows are out of range, so the count stays near the
  old one **[likely]**. *(beaches fact-check 2026-09-29, G3: **0** emitted synthetic regions lie within 660 m of the
  bench [confirmed: `fc2.py`], and the old geometry's worst corner was already +11 / +16 (NW), so the beach view's
  terrain add is ~0 and the corner is the only new worst case.)* An edge player's resident disk is still never fuller than an interior player's **[likely]**, so the frame
  budget of the fields interior bounds it.
- **The user's item 1 (draws down to a handful per area).** The coast adds nothing to the plaza or the town (no sea in
  view, the ocean invisible, F2). Its own draws are one per terrain region, one or two for the ocean and one per ship
  model; if item 1's lane merges terrain regions into fewer draws, synthetic regions join that path with no coast code
  (they are ordinary `terrain/*.bin` regions) **[likely]**. Seam S-DRAW (§8.13).
- **High's rule** ("keep features if busy scenes are no slower than today"): the coast view is not one of the busy
  scenes the rule measures; the coast still stays inside its own budget: **Medium ≤ +0.45 ms CPU p95 and ≤ +16 draws;
  High ≤ +0.6 ms and ≤ +22 draws** over the baseline at the worst corner (was +0.4 / +17 and +0.5 / +19 with life
  included).
- **Apple Silicon:** the extra terrain is vertex work of ≈ 0.2 M triangles on Medium; on a base M1 at Retina 0.75 that
  is ≈ +0.1–0.2 ms of GPU on top of §8.11's 11–15 ms **[projected]**.
- **Disk and load:** +34 emitted regions ≈ +1.6 MB brotli in `work/out-opt`, streamed only near the coast.

Per-lane budget changes: **CST-C synthetic terrain** "worst case +11 resident regions on Medium / +17 on High at the
south-west corner: +5 / +7.7 MB VRAM, +11 / +17 draws (≈ +0.23 / +0.31 ms CPU), +0.2 / +0.31 M triangles; never above
the interior peak". **CST-A** "ships ≤ 3 draws, ≤ 0.05 ms CPU; birds are GRASS_LIFE's budget". The rest of §8.11's
per-lane table stands.

### 8.12 Licence and provenance

- Tidewater's code is under the MIT licence, *Copyright (c) 2026 DRG Software Solutions LLC* **[confirmed: `LICENSE`
  at `4811ba4`]**. MIT allows porting as long as the notice is kept. Per the lead's notes its assets are CC0 or MIT
  third-party works; **we use none of them**: no textures, models, sounds or sky data.
- **What gets ported (code):** the spectrum, FFT, Jacobian foam and mip kernels (`OceanFFT.js`); the attenuation,
  band-limiting and normal code (`WaterSurface.js`); the roughness, reflection corrections, scattering and foam light
  (`WaterMaterial.js`); the CDLOD morph and selection (`CDLOD.js`); the swash cycle (`ShoreWaves.js`); and the lace
  generator (`SurfFoam.js`). The later lanes add more of `ShoreWaves.js` and `ShoreSim.js`.
- **Rules:**
  1. A new root file, **`THIRD_PARTY_NOTICES.md`** (none exists today **[confirmed: `git ls-files`]**), gets a
     Tidewater entry: the project, its URL, the commit, the full MIT text with its copyright line, and the list of our
     files that contain ported code. CST-O creates it, and each later lane appends its files.
  2. Every file with ported code starts with a comment: *Portions ported from Tidewater
     (github.com/dgreenheck/tidewater, `<file>` at `4811ba4`), MIT licence, Copyright (c) 2026 DRG Software Solutions
     LLC. See THIRD_PARTY_NOTICES.md.*
  3. The notice ships with the game. Minification strips comments and the ported WGSL sits in the shipped bundle, so
     the client build copies `THIRD_PARTY_NOTICES.md` next to the game files **[projected: the build owner picks the
     place]**. The game being private to friends does not change this.
  4. The lace texture is the output of our port of the generator (code covered by rule 1), not a Tidewater asset.
  5. A test (`packages/world-render/test/ocean-notices.test.ts`) checks that every file with the header is listed in
     `THIRD_PARTY_NOTICES.md`, and that every listed file exists.
- Porting instead of importing means upstream fixes do not flow in. The commit is pinned, and a later re-read is a
  deliberate task.
- *(refresh 2026-09-29)* Upstream's head is still `4811ba4` (2026-09-25) **[confirmed: GitHub commit list read on
  2026-09-29]**, so no re-read is due. `THIRD_PARTY_NOTICES.md` still does not exist **[confirmed: `git ls-files`]**.
  SKY2 ports Tidewater too (clouds, environment, haze), so there is **one** notices file with one Tidewater entry and
  one list of ported files: see S-NOTICE in §8.13.

### 8.13 What the coast shares with the sky upgrade, and with the trees (refresh 2026-09-29)

The user ordered sky and sea as one wave because "they share the same code (sky, haze, water)". Wave 9 already built
the shared plumbing: the ocean is a `PBRMaterial`, so it gets the fog plugin, the IBL and the key light by being a PBR
material, and it calls the sky's cloud-shadow function by name. The seams below keep it that way: **SKY2 changes what
those functions return; the ocean does not change when SKY2 lands**, and the coast can ship before, with or after
SKY2. docs/SKY2.md is being written in parallel; where it decides differently, WAVE_PLAN4 settles it and the default
below holds until then.

| Seam | What is shared | Owner, and the contract | Default until SKY2 lands | Test |
|---|---|---|---|---|
| **S-HAZE** (haze over the sea) | The aerial haze colour and amount per pixel: sky-view LUT colour just above the horizon in the view direction, two exponential height layers, sun glow (Tidewater `AirHaze.js`) | **SKY2.** It must reach **alpha-blended** surfaces: the sea is transparent, and past the emitted band there is no terrain under it (§2.2). So the haze is applied **in the material**, by extending `SroFogPlugin` (every PBR material gets it, the ocean included) or by an equivalent function the fog plugin calls. If SKY2 applies haze or sun shafts as a **post pass reading depth**, the sea surface must be in the depth it reads: the ocean's depth pre-pass (§8.2) writes the main depth buffer, and SKY2 either reads that buffer or asks CST-O for a prepass-depth write **[unknown which; decided at SKY2's seam commit]**. *(fact-check 2026-09-29, F4: by default the sea is in the hardware depth buffer only, not in the prepass depth texture, because the colour pass keeps `disableDepthWrite` and the MRT binds only `isPrePassCapable` materials [confirmed: 9.28 source].)* | Today's height fog, `SkyState.fogColor` or the ring | LAB: a horizon strip at 1°, 3° and 10° below and above the horizon, sea vs dome vs far land, \|ΔRGB\| ≤ 2/255 at noon, dusk and in fog weather |
| **S-HORIZON** (where sea meets sky) | The dome's below-horizon colour, the sea's far colour, and the reflected-ray fade `horizonColor × 0.35` | SKY2 owns the dome and supplies `horizonColor(dir)` (today `SkyState.fogColor` / `horizonRing`); CST-O uses only that function. The ocean mesh ends at the far plane (2,000 m); the haze must be ≥ 99.9 % there, or SKY2's dome must match the sea's hazed colour at the clip line. | Fog colour | Same strip test; a screenshot at `flags.fog` off in the viewer shows the CDLOD edge against the dome |
| **S-CLOUDSHADOW** (cloud shadows on the water) | `sroCloudShadow(worldPos) → 0..1` (SKY-B's extern, D28) | SKY2 replaces the **body** (the volumetric clouds' shadow map around the camera, Tidewater's `Clouds.js`) behind the **same name and signature**, in both languages. The ocean multiplies its glint and in-water sun by it on High (`ground`) and Ultra (`all`). | Today's projected cloud noise | CST-O: the ocean compiles with the extern empty and full; LAB: a cloud shadow crosses the beach and the sea without a step at the waterline |
| **S-IBL** (reflections) | `scene.environmentTexture` (the sky cube, its mips and its SH) | SKY2 (GPU time-sliced IBL, answers D14) owns it; the ocean reads it only through the PBR reflection block and its tilted-normal correction. Requirement for SKY2: keep a full mip chain whose roughness mapping matches Babylon's `lodGenerationScale` (the ocean samples it at Cox–Munk roughness), and include the clouds (Tidewater's panorama), so storms darken the sea's reflection. | RND-L's CPU cube, 32² / 64² | LAB: calm sea at noon mirrors the sky colour within the cube's blur; storm sea reflects grey; no reflection pop at a cube refresh |
| **S-EXPO** (auto exposure) | Metering of the frame | SKY2 owns eye adaptation. The sea's glint is clamped (Tidewater clamps at 400) and SKY2's metering clips highlights at the same cap, so looking at a sunlit sea does not darken the beach. | Per-`SkyState` exposure | LAB: pan from the beach to the sun glint and back; the exposure moves by less than 0.5 EV |
| **S-BOUNCE** (ground bounce light) | The ground albedo under the camera | SKY2 owns bounce light. Over the sea the ground albedo is the sea's (≈ 0.06), not sand's: SKY2 reads the coast field's sea mask (R) through a small accessor `World.coast?.seaAt(x, z)` that CST-O exposes **[projected]**. | No bounce | A character on the beach vs on a boat-height pier shows no sand-coloured underlight over open sea |
| **S-SHAFTS** (sun rays through haze) | CSM + cloud shadow, marched through the haze | SKY2. Over open sea the march ends at the sea surface (S-HAZE's depth), not at the far plane. | None | LAB: shafts at dusk over the bay stop at the water |
| **S-CLOCK** (time and wind) | `WeatherFrame.time` (wraps at 3,600 s), `windX/Z`, `windMs`, `gustMs` | WX-R (built). The clouds drift at the wind × 1.5 (`CLOUD_DRIFT`), the sea's wind sea follows the same low-passed wind, so cloud shadows and whitecaps move together **[confirmed: `sky/clouds.ts`, `weather/frame.ts`]**. *(fact-check 2026-09-29, F12: the clouds use the **unfiltered** frame wind (`CloudLayer.drift`, `sky/clouds.ts` 84–88) and the sea low-passes its own copy over τ ≈ 30 s. They share the direction and the frame, not the same filtered value, so after a wind shift the cloud shadows turn first and the sea follows within about a minute. That is accepted.)* | Built | A unit test that both read the same frame fields (`windX/Z`), and that the sea's filtered direction converges to the clouds' within 3 τ |
| **S-TAA** (temporal AA and reprojection) | TAA on High+; SKY2's volumetric clouds need reprojection | SKY2 / RND-P. The displaced sea has no motion vectors; Babylon's TAA reprojects it as if static. Both the retail water (already) and the ocean accept that, and LAB checks crest ghosting in a storm; if it smears, the ocean writes velocity from the previous tick's displacement **[unknown need]**. | Wave-9 TAA | LAB: storm swell from a low camera, TAA on, no trails longer than one crest |
| **S-NOTICE** (licence) | `THIRD_PARTY_NOTICES.md` | One file, one Tidewater entry, one list of ported files for both specs. **Default owner: CST-O** (it was first in this plan); SKY2's lanes append their files; the notices test scans every file with the Tidewater header in `world-render/src`. WAVE_PLAN4 may move the owner to SKY2's first lane. | – | `ocean-notices.test.ts`, renamed `tidewater-notices.test.ts` |
| **S-TREE** (with docs/TREES.md) | Vegetation placements on moved coast ground; tree wind | TREES owns the tree models and which placements use them; CST-C's C9 rule (re-snap vegetation to the new ground if ≥ SL + 0.5 m, else drop) runs on placements **by uid, whatever model they carry**, so a species swap needs no coast change. Coastal species (for example wind-bent pines on the Tiger cliffs), if the user wants them, are a TREES row, not a coast model. The coast adds **no new 3D models**. | Retail trees | CST-C test: a vegetation placement in a changed region is re-snapped or dropped by uid with a stub model |

*(beaches 2026-09-29)* **SKY2 and the new tree models are deferred** (the user's list). Every seam above keeps its
"default until SKY2 lands" column as the shipped behaviour, the joint "sky and sea" gate becomes the coast's own gate
(§12.8), and S-TREE runs on retail trees. Two seams are new, with this wave's other specs *(beaches fact-check
2026-09-29, G9: four; S-MOVE and S-BLENDER with MOVEMENT were missing)*:

| Seam | What is shared | Owner, and the contract | Default | Test |
|---|---|---|---|---|
| **S-DRAW** (with the user's item 1, draws to a handful per area) | Placements and terrain regions | The coast's C9 edits (re-snap, drop, add by uid) are applied **in the converter**, before any instancing or merge step builds its batches from `manifest.placements`, so a merged batch never holds a dropped placement and a re-snapped one carries its new y. Synthetic regions are ordinary regions for any terrain merging. The ocean stays its own thin-instanced draw. | Coast first in the converter pipeline; item 1's batching reads the result *(beaches fact-check 2026-09-29, G15/G9: item 1's prototype batches **at runtime** from the live World's placements (`work/tmp/batching/lab/batch.ts`, "BATCHING.md prototype"), so the converter-side C9 edits reach it with no hand-off; terrain is not merged there. GRASS_LIFE's GL-C derives roof perches from building placements, so it too runs after C9 (a dropped building leaves no perch); neither the ocean nor GRASS_LIFE's ground cover is batched)* | A converter test: a dropped uid appears in no batch and in no `perches.json`; the plaza draw count is unchanged by the coast |
| **S-LIFE** (with docs/GRASS_LIFE.md, the user's item 5) | Birds, grass and small plants near the sea | GRASS_LIFE owns the bird system (instanced, one draw per kind) and the grass field; the coast supplies a **gull** species ~~(the retail hawk model, §10.2)~~ with sea-side rules ~~(circle over the swash band, stay over water deeper than 2 m, `seabird*.wav`)~~ and the coast field accessor `World.coast?.seaAt(x, z)` for them. Grass follows the splat, so the flank's grass paint grows grass and the sand grows none. *(beaches fact-check 2026-09-29, G8: GRASS_LIFE's birds are procedural 17-triangle species on one instanced mesh, so the gull is a species of that mesh (white and grey, a gull's scale and a slow flap), not the retail hawk; its habitat follows GRASS_LIFE §8.3 and CST-A's old flock rule: flight over the sea mask where the water is deeper than 8 m, passes along the shore within 30 m of the waterline, loafing on dry sand. Gull calls stay in the `COAST` ambience (`seabird*.wav`), since GRASS_LIFE plays one retail bird one-shot per flush. G7: the grass needs the flank paint of §7 at ≤ 38°.)* | Gulls in GRASS_LIFE's bird system; no coast flock code | GRASS_LIFE's bird tests with a gull species; the coast test: no grass instance on a sand-painted vertex; the share of grass paint on the flank (G7) |
| **S-MOVE** *(beaches fact-check 2026-09-29, G9)* (with docs/MOVEMENT.md, the user's item 3) | The water level at a landing point | MOVEMENT's MV-C plays a water landing only if the coast exports `waterLevelAt(x, z)` (its §6.4); the surface probe reads only the tile type, and the sea lies over sand. I-CST adds `World.waterLevelAt(x, z)`: `manifest.coast.seaLevelM` where `seaAt(x, z)`, else the retail water plane of the block, else none. A jump makes no nav call, so nothing else is shared | Sand step until the accessor lands | A unit test: +5 m over the sea mask, the block plane in the moat, none on dry ground |
| **S-BLENDER** *(beaches fact-check 2026-09-29, G9)* (with MOVEMENT's MV-A) | `SroConfig.blenderExe` (`packages/convert/src/node-io.ts`, `sro.config.example.json`) and the `packages/convert/tools/blender/` folder | One key, one default (the Blender 5.2 install path), added by whichever lane lands first; CST-B owns `tools/blender/*.py` and `passes/`, MV-A owns `tools/blender/moves/` (MOVEMENT D16). Every path handed to Blender is absolute (§6.6) | – | Both lanes' tests read the same key; no two lanes add it |

**Where each piece lives.** The haze, clouds, IBL, exposure, bounce and shafts are SKY2's files. The ocean, shore,
field and coast data are this spec's. The only files both touch are `pbr/fog-plugin.ts` (SKY2 edits; the ocean only
receives it), `THIRD_PARTY_NOTICES.md` (S-NOTICE) and the lab's bench scenes (WAVE_PLAN4 gives LAB one list).

---

## §9 Navigation and the server

### 9.1 Navigation for changed and synthetic regions

`@sro/nav`'s `NavRegion` is only heights, a 96 × 96 tile → cell map and `openCellCount`. A tile is walkable when
`cell < openCellCount`, and the walker has no step or slope limit **[confirmed: `data.ts`, `world.ts:512`,
`reach.ts:417`]**. So the converter can build the terrain nav of any changed region itself, though it still writes a
whole `NvmFile` (§5.4).

- **In-bounds regions with a height patch (S1):** replace the heights; keep the retail cells, openness, planes and
  objects (§3.5).
- **Changed ring regions outside the bounds:**
  - `heights` = the new lattice;
  - a tile is **open** if all four corners are at most 0.4 m under the sea level (knee-deep, C7), its slope is at most
    0.7 (35°), and it lies in the beach band (`h ≤ SL + 12 m`);
  - where the height did not change, a tile is open only if it was open in retail, so the rule never opens a
    retail-closed tile;
  - `tileCells` = 0 for open tiles and 1 for closed ones, with `openCellCount = 1`;
  - retail `planes` are dropped (the ocean is not a nav plane);
  - `objects` = the retail list minus dropped placements **[likely]**;
  - the debug `navmesh/<x>_<z>.bin` gets one rectangle cell per run of tiles.

  With unchanged bounds these tiles are never walked (the clamp), but `nav.bin` stays consistent with the terrain.
- **Untouched regions:** bit-identical (tested).
- **Synthetic regions:** no nav at all **[confirmed: FIELDS.md §3.8, `World.clamp`]**.
- **Swimming is out of scope.**
- *(refresh 2026-09-29)* Re-checked after wave 9: `NavRegion` still has `openCellCount` and the tile → cell map
  (`packages/nav/src/data.ts`), `World.clamp` is still at `apps/server/src/world.ts` 719, the home component is still
  `componentOf` / `locateIn` in `apps/server/src/nav.ts`, and a region's `navmesh` is nullable in the manifest (so a
  synthetic region without nav is legal) **[confirmed: code]**. The exported `stream.navRegions` (the `nav/` chunks,
  22.9 MB) and `nav-objects.bin` are what CST-C rewrites for the S1 regions **[confirmed: manifest]**. Wave 11's jump
  and dodge roll (docs/MOVEMENT.md) will validate moves against the same navmesh; the S1 patch changes only heights,
  so a roll on the beach needs nothing from the coast.

### 9.2 `manifest.bounds` and walkable beaches

- **+5 m (default): the bounds do not change.** S1 lies inside them. No server code changes, and no new nest wakes
  up.
- **−2 m variant, walkable:** extend the bounds by the ring on the east and south only: `{ minX: −2304, maxX: 1536,
  minZ: −1152, maxZ: 1536 }` (column 175 and row 89; −2304 = 192 × (156 − 168), 1536 = 192 × (176 − 168) = 192 ×
  (97 − 89)) **[confirmed: manifest `space` and `bounds`]**. The §9.1 rule closes everything in the new strip that is
  not beach, including the Tiger flank in row 89 (tested: no tile above SL + 12 m becomes reachable). None of the
  825 nests lies in row 89 or column 175 **[confirmed: `nests.json`]**. `stream.playable` stays the frozen rectangle
  (C19).
- **Look-only fallback:** the bounds stay (+5 m without S1: a dune ridge outside the bounds; −2 m: the beach starts at
  the bounds line).
- **Later, for non-rectangular walkable shapes** (a north-east beach, the E3 spit): a `manifest.walkRegions` mask and
  a small `World.clamp` change. Not in v1.

### 9.3 Reachability and the rest of the server

- The server keeps a **home component** (the town spawn's) and places nests, NPCs and warps only in it
  (`apps/server/src/nav.ts` `componentOf`, `locateIn`) **[confirmed]**. S1 stays in that component, because its cells
  do not change.
- **Checks** (the converter report and a server test):
  - every open tile of a changed region is in the home component or is reported as an island (the converter closes
    islands); *(beaches fact-check 2026-09-29, G1: the home component must be computed with every region outside the
    bounds closed, the clamp's view, and S1 is exempt from closing: it must reach home through its in-bounds link
    (§3.5), or the conversion fails. Without the link, and if no route outside the bounds survives, this rule would close
    the walkable beach.)*
  - the spawner still places 791 nests; *(fact-check 2026-09-29, F8: read "the same nests as before the coast": about
    700 placed and 91 skipped as unreachable on foot [confirmed: DEPLOY.md]; a changed count fails the test)*
  - `tp beach-south` lands on sand above the sea level (`coast.json` `places` → `manifest.places`, which
    `manifestPlaces` already reads).
- `nav.bin` keeps its 307 regions, so memory and load time do not change **[likely]**. The client streams the
  regenerated `nav/<x>_<z>.bin` chunks. `navCovers` (the prediction guard) is unchanged.
- *(fact-check 2026-09-29, F15)* **Protocol and abuse.**
  - **Saved positions on S1:** a character logged out on the old 0 m strip has a saved y about 5.6–10 m under the new
    sand. `entryPoint` restores the saved surface only when it is within 2 m of the saved height, and otherwise
    calls `nav.place(x, z, y, WARP_SEARCH_M)`, which finds the new ground **[confirmed: `apps/server/src/connection.ts`
    394–411]**. No code change. CST-C's server test adds one such row.
  - **Stale clients:** `WorldInfo` carries no export version **[confirmed: `packages/shared/src/protocol.ts` 209]**,
    and the asset files are not content-hashed (served `no-cache` with an ETag, `apps/server/src/static.ts`). A page
    that stays open across the re-convert and restart still holds the old S1 terrain and nav chunks in memory, so it
    predicts heights up to 10 m off until the player reloads **[likely]**. Default: the re-convert ships as a deploy
    that restarts the server, and the deploy note asks players to reload (DEPLOY.md already does this for world
    changes). Optional: one additive `WorldInfo.exportId` (the manifest's `createdAt`); on a mismatch the client
    offers a reload (§16 Q13).
  - **Abuse:** `tp beach-south` is a GM command (`places` are GM teleport targets only) **[confirmed:
    `apps/server/src/content.ts` 40–44, `gm.ts`]**. The beach adds no nest, NPC or shop. Bed-walking in the S1 water
    is the retail rule (§1.5), and the server's clamp stops it at the bounds. The coast adds no message, so there is
    no new client input to validate.

### 9.4 Nav and bounds with beaches everywhere (beaches 2026-09-29)

- **The bounds do not move.** `manifest.bounds` and `stream.playable` stay X 156–174 × Z 90–102; S1 stays the one
  walkable beach and the one in-bounds height patch. Every other beach is **look-only**, like the rest of the ring
  **[decision, default; §16 Q15]**. No server code changes, no nest wakes up.
- **More regions are rewritten.** 74 of the 307 export regions change height (69 in the old Option A) **[confirmed:
  census]**: their `terrain/*.bin`, the client nav chunk `nav/<x>_<z>.bin`, their slice of `nav.bin`, the debug
  `navmesh/*.bin`, the baked lightmap (§5.4 step 5) and the minimap tile inside the change mask (§11). S1's four
  height copies are rewritten as before. `nav.bin` keeps its 307 regions.
- **Openness of changed ring tiles** (the §9.1 rule, unchanged): open only if knee-deep or above water, slope ≤ 0.7
  and at most SL + 12 m, and never opening a retail-closed tile. So the new beach bands are open and the lowered flanks
  above SL + 12 m close. Today row 89 and column 175 are 96–100 % open and in the town's component, and only the clamp
  keeps players out (§1.5); after the coast most of that ring is closed flank, which removes rather than adds
  reachable ground outside the bounds **[likely]**. The converter's island check (§9.3) reports every open beach tile
  outside the home component; they are expected (look-only) and listed, not errors, because the clamp stops the
  player at the bounds.
- **Reachability inside does not change.** *(beaches fact-check 2026-09-29, G1: it does, for S1. The S1 pocket, the
  south end of the east shelf and the NE corner reach town today only through ring tiles outside the bounds, which
  the clamp forbids; S1 gets an in-bounds link (§3.5, Q22). No nest is affected: 682 of the 805 enabled
  in-bounds nests reach town with and without the ring [confirmed: `work/tmp/coast-beach-fc/nests-ring.ts`].)* No
  playable cell changes openness; the river-mouth bed at the west bound
  (x 156.0, z 96.1–97.8), the one reachable spot next to the Option A corridor, keeps its retail bed (the river-mouth
  keep, §3B), so bed-walking there is as today. The placed nests stay about 700 with 91 unreachable (F8); the server
  test compares the placed set and the skip list with the pre-coast run.
- **Jump (the user's item 3, docs/MOVEMENT.md).** A jump validates against the same navmesh and the same clamp; the
  coast changes no playable cell, so nothing on S1 or at the bounds needs a coast rule **[likely]**. *(beaches
  fact-check 2026-09-29, G10: a jump makes no nav call at all; it plays over the current move and never starts,
  changes or ends one [confirmed: MOVEMENT.md]. What it wants from the coast is the landing sound's
  `waterLevelAt(x, z)`, seam S-MOVE.)*
- **Walkable beaches all round later** would need: `manifest.walkRegions` (a mask instead of a rectangle) and a small
  `World.clamp` change (§9.2); an open, gentle path from the playable set down to each beach (the flanks are closed
  above SL + 12 m, so the Tiger and tomb beaches would need a graded path cut in Blender, while the east beaches connect
  over the 25 m shelf); the island check turned into an error; and a look at nests near the new ground (none are
  within the ring today, §9.2). About a week of CST-C plus a server change **[projected]**; §16 Q15.
- **The retail hole** at (162.8, 104.4) is outside the export and has no nav; the converter's hole rule keeps it out of
  every height copy **[confirmed: it is not in the export's regions]**. *(beaches fact-check 2026-09-29, G5: 58
  vertices below −200 m plus an 18-vertex rim to −100 m.)*

---

## §10 Life and sound

### 10.1 Sound [confirmed: `Data.pk2 prim/snd/env/`, headers read in place]

| File | Length | Retail use (`effectenvsnd.txt`) |
|---|---|---|
| `env/sea_wave1.wav` | 7.35 s, mono 22.05 kHz | Asia Minor beach: continuous loop; the shipwreck: every 15–25 s |
| `env/seabird.wav` | 11.38 s | Asia Minor beach: every 35–40 s (15–30 s in the second set) |
| `env/seabird2.wav` | 6.78 s | Asia Minor beach: every 20–35 s (10–25 s) |
| `env/oceana.wav` | 10.22 s, 44.1 kHz, loud | Shipwreck: continuous loop |
| `player/mvwalkwater.wav`, `mvrunwater.wav` | 0.39 s | Footsteps in water |

- **Area ambience:** a new area `COAST` in `SoundIndex.areas`, built from the Asia Minor beach layers. `AreaSound`
  already has `day` and `night` lists **[confirmed: `packages/shared/src/sound.ts`, `apps/game/src/audio/
  ambient.ts`]**; that the file's two layer sets are day and night is **[likely]**. The game calls
  `GameAudio.setArea('COAST')` within **120 m** of the shore (inside G's 127.5 m range), cross-faded with the field
  ambience. `ambient.ts` itself is not edited, because WX-A (9A) edits it.
- **Positional surf:** up to 4 `PannerNode` emitters on the nearest shore points (re-sampled from the field every
  second), looping `sea_wave1`, with `oceana` added in storms (gain from `Hs`).
- **Export:** add the four `env/*` files to the sound export scope: 35.7 s in all, ≈ 0.29 MB as Opus at 64 kbps
  **[projected]**.

### 10.2 Birds and animals [confirmed: model search]

- There is no gull model. `res/nature/china/hawk.bsr` (1.4 × 3.0 m, skeletal, 1 clip, not placed in the export)
  stands in: flocks of 3–6 circle the shore (a client-side flock system), with `seabird*.wav` at the flock.
- `res/mob/sd/heron.bsr` and `res/mob/asiam/crab.bsr` can serve as client-only shore critters **[likely]**.
- *(beaches 2026-09-29)* The flock system is **GRASS_LIFE's** (the user's item 5 asks for birds everywhere): the gull
  is one more species in its instanced bird batch, with the sea-side rules of S-LIFE (§8.13). *(beaches fact-check
  2026-09-29, G8: GRASS_LIFE's species are procedural meshes, so the hawk above is not used; the gull is a white and
  grey species of that mesh.)* Herons and crabs are
  GRASS_LIFE critter candidates too; the coast lists them and does not build them.

### 10.3 Props and ships [confirmed: `probe-models.ts`, `probe-ships.ts`; placement counts from the export]

| Use | Retail model | Notes |
|---|---|---|
| Cliff rocks at the toe | `nature/common/cliff/stone_cliff01_01..08` (up to 165 × 84 × 42 m) | Already placed 90× in the export; retail's own way to hide stretched terrain. *(beaches 2026-09-29: no cliff toes any more; replaced by a sparse boulder scatter (`stone_field01..05`) on the flanks and at the beach ends, §3B.5)* |
| Beach rocks | `stone_field01..05`, `w_cd_rock_*` | Already in the export |
| Reeds at the river mouths | `fw_cd_reeds_l` | 255 placed already |
| Boats pulled up on the beach | `cj_ferry_boat_old`, `_new` | The Jangan ferry boats |
| Distant ships | `w_cd_ani_boat` (Chinese, animated), `rock_mt_ship`, `alex_ship_s`, `euro_constan_ship01` | 1–3 ships on slow loops 250–400 m offshore, as silhouettes in the fog |
| Wreck | `wreck_float01..07` | One on the south beach |
| Beach ruins | `asia minor_beach_ruin*` | Greek style; skip |

- Placement: authored in `props.json` (Blender), plus a hash-seeded scatter in the converter (rocks along the cliff toe
  every 40–80 m, with slope and depth filters). Both become ordinary `WorldPlacement`s.
- Ships move, so they are not placements. A client feature (`world/fx/ships.ts`) animates them over water deeper than
  8 m (field B), with a sway from the CPU wave query (§8.4).
- *(refresh 2026-09-29)* **No new 3D models in this wave.** The user's rule for now is "new 3D models for trees
  only", so every coast prop above is a retail model, islets and sea stacks are terrain sculpts (§3.5, §6), and a
  jetty, pier or lighthouse would wait for a later go. Trees on the coast come from TREES (S-TREE, §8.13). Retail
  models of this table reach the PBR path through TX-R like any object (their sets, if any, from the texture batches);
  a gull stays the retail hawk. *(beaches fact-check 2026-09-29, G8: no longer; the gull is GRASS_LIFE's procedural species.)*

---

## §11 Minimap and world map

- **Minimap tiles** (`minimap/<x>x<z>.png`, 256², north-up, 0.75 m per pixel **[confirmed: TERRAIN.md §7]**):
  - untouched regions keep the retail tile;
  - **changed regions** (ring regions and the S1 regions) keep the retail tile outside a change mask (dilated by
    4 px) and get our own top-down render inside it: the tile composite at the native periods (TERRAIN.md §2.2–2.3),
    plus the sea in `mapColor` shaded by B, a white foam line and the footprints of added props;
  - **synthetic regions** get our render only (mostly sea, 1–3 KB).

  The Blender top-down render matches the minimap frame pixel for pixel (§6.1), so it serves as the reference.
- **World map** (`worldmap.png`, 64 px per region **[confirmed: `worldmap.ts`]**): the stitch rectangle grows to the
  domain, and regions without a tile are filled with `manifest.coast.mapColor` instead of `#202225` (one optional
  parameter of `stitchWorldMap`). `stream.worldMap` grows with it.
- **Client:** `Minimap` draws a missing tile as `#202225`. Reading the fill from `manifest.coast?.mapColor` means
  **two** fill sites in `packages/world-render/src/minimap.ts` (line 107, the atlas background; line 137, the tile-mode
  fallback) **[confirmed]**.
- **Zone names:** coast regions without a retail name get a `zones.json` entry "Coast" (i18n `map.zoneCoast`).
- *(beaches 2026-09-29)* 74 changed export regions (was 69) get a composited minimap tile, and the 107 emitted
  synthetic regions (was 73) a rendered one; the world map covers X 150–177 × Z 86–105 (1,792 × 1,280 px at 64 px per
  region) **[projected arithmetic]**. The sand band is now the most visible thing on the map's edge, so the composite
  draws dry and wet sand in the palette's swatch colours, as `preview.png` does.
- *(refresh 2026-09-29)* Re-checked: the two `#202225` fills are still `minimap.ts` lines 107 and 137, and
  `stitchWorldMap(rect, tile, px)` is unchanged; today's `stream.worldMap` covers x 155–175 × z 89–103 at 64 px per
  region (1,344 × 960) **[confirmed: code, manifest]**. With the domain and A's corridor it grows to x 150–177 ×
  z 87–105 (1,792 × 1,216 px) **[projected arithmetic]**.
- *(2026-10-06, §4.1)* The world map covers the island, not the domain: every region with dry ground grown by one
  region of sea, inside the domain (`coast/drown.ts` `islandRect`): X 152–176 × Z 86–105, 1,600 × 1,280 px. The
  drowned area is open sea on it like the rest; the client's window zooms out to the whole image and never pans past it.

---

## §12 Build plan: wave 10 "sky and sea" (the coast's part)

### 12.0 Where it slots in

*(refresh 2026-09-29: rewritten. 9A is integrated and released as the default; the coast is built in one wave with
SKY2 and TREES, merged by docs/WAVE_PLAN4.md. The 2026-09-28 plan waited for I9A and ran beside 9B; both conditions
are now met or moot.)*

*(beaches 2026-09-29: **the wave is now the user's list** (1 draws, 2 the coast, 3 jump, 4 character select on the
palace steps, 5 grass and life), planned by the next wave plan in the WAVE_PLAN3 format; SKY2 and the new trees are
deferred. The coast's steps C0 → C1 → C2 below stand, without SKY2's seam commit and joint gate; the lane changes for
beaches everywhere are in §12.13. Phase 1 (E, S, NE) now includes the Tiger beach (S4) and S3, the biggest reshaping;
phase 2 (W1, W2, N1, N2, A-S, A-N) follows.)*

```
wave 9 (released: Medium default) ──► wave 10 "sky and sea" + trees (WAVE_PLAN4)
  step C0 (data, starts at once; no file overlap with SKY2, TREES or the 9B batches):
        CST-C (phase 1: E, S, NE)  |  CST-B (after CST-C's config schema)  |  CST-M(conv)
  step C1 (render/audio):
        CST-O (opens with its spike and the shore seam; S-HAZE/S-IBL/S-CLOUDSHADOW read wave-9 functions, so it does
               not wait for SKY2)  |  CST-S (after CST-O's seam commit)  |  CST-A  |  CST-M(client)
        CST-T (B-coast texture batch, on the texpipe runner when the GPU is free; never beside ComfyUI or a timing run)
        CST-C phase 2 (W, NW, Option A corridor)
  step C2: I-CST (hooks, re-convert, LAB with SKY2 on and off), then H-CST; WAVE_PLAN4's joint gate "sky and sea"
  later, optional, after the beach playtest: CST-W (+ CST-C's shore field) → CST-F; CST-K
```

- The data lanes touch only `packages/convert/src/world/coast/**`, `convert-world.ts`, `manifest.ts`, `worldmap.ts`
  and `content/coast/`. No 9A or 9B lane owns these **[confirmed: grep of WAVE_PLAN3 and TEXPIPE]**. So C0 could start
  earlier, beside 9A, if the user wants the coast sooner. The default waits for I9A, so the coast is judged with the
  new sky, fog and water. *(refresh 2026-09-29: I9A is done; C0 starts with the wave.)*
- The renderer lanes need 9A's runtime: RND-W's shared water chunk and depth-renderer policy, SKY-B's `SkyState`, the
  height fog, RND-L's sky cube, key light and CSM, and WX-R's `WeatherFrame` and ripples. *(refresh 2026-09-29: all
  merged; the "shared chunk" is `WaterPbrState` and there is no depth renderer, §8.1, §8.5.)*
- CST-O and CST-S work in parallel through a chunk seam, the pattern of WAVE_PLAN3 D1: CST-O's composer
  (`ocean/surface.ts`) interpolates `SHORE_VERTEX` and `SHORE_FRAGMENT` constants (WGSL and GLSL) from
  `shore/chunks.ts`, which CST-S owns. CST-O's first commit lands the seam with empty chunks.
- I-CST runs after 9B's B3, so the coast is signed off with the final terrain textures. CST-O and CST-S use retail
  textures until B-coast lands. *(refresh 2026-09-29: B2/B3 now run "as time allows" beside wave 10; I-CST no longer
  waits for B3. It signs off with whatever sets exist and B-coast, and the look is re-checked when B3 lands.)*
- **Phasing inside CST-C:** phase 1 (E, S, NE; C2) lands first and is checked in the viewer. Phase 2 (W and NW, by the
  §14 A/B choice) is a second commit that only adds `coast.json` rows plus the corridor emit. *(refresh 2026-09-29:
  the user chose A, so phase 2 is A's rows and the corridor.)*
- *(refresh 2026-09-29)* **With SKY2.** The coast does not depend on SKY2's code (§8.13): every shared thing is a
  function or texture that wave 9 already provides and SKY2 re-implements behind the same name. What the two share is
  the **gate**: WAVE_PLAN4's LAB measures the beach with SKY2 on, and the S-HAZE / S-HORIZON strip tests need both.
  If SKY2 slips, the coast ships on wave-9 fog and IBL; if the coast slips, SKY2 loses nothing.

### 12.1 CST-C: the converter coast pass (step C0)

- **Owns:** `packages/convert/src/world/coast/**` (§5.4), `content/coast/coast.json` (initial, phase 1, then phase 2)
  and tests `packages/convert/test/coast-*.test.ts`.
- **Hooks:** `convert-world.ts` (the `RegionSource` switch, synthetic regions, `manifest.coast`, `stream.playable`
  decoupled from `bounds`), `manifest.ts` (`WorldCoast`, `WorldRegion.synthetic`, `validateWorldManifest` rules) and
  `WORLD_PRESETS['jangan-fields'].coast`.
- **Port:** `work/tmp/coast/coast.py`'s section model into `profile.ts`, with the structure of `proto_coast.py` (the
  lattice, frozen check, berms, flood fill) and the fixes of §5.3 (fade side, corner rule, tomb rule, S1 inward
  feather).
- **Field for shore v1:** B also holds the height above SL on land texels within 128 m of the shore (§8.1).
- **Tests:**
  - in-bounds vertices bit-identical outside `allowHeightPatches`;
  - field B: bed depth on sea texels, land height within 128 m of the shore, and 0 elsewhere on land;
  - **land-side regions bit-identical**;
  - every region seam bit-equal;
  - normals on changed/unchanged seams computed from the overlay;
  - determinism (two runs, identical SHA-256 except `createdAt`);
  - the sea mask never on dry playable ground or on land edges;
  - berms closed (no sea cell next to dry ground below SL outside the swash band);
  - the S1 patch changes the four height copies consistently and no cell openness; *(beaches fact-check 2026-09-29,
    G1: none outside the `openTiles` rectangles, whose opened tiles are listed in the report)*
  - `nav/<x>_<z>.bin` equals its slice of `nav.bin`;
  - no walkable island outside the home component; *(beaches fact-check 2026-09-29, G1: computed with every region
    outside the bounds closed; and **S1 reaches the town spawn's component inside the bounds** through its `openTiles`
    link, with the S1 regions' open tiles never closed as an island)*
  - every `places` entry lands on an open tile above SL;
  - `validateWorldManifest` clean;
  - synthetic regions decode with `decodeTerrainBin`;
  - retail archives opened read-only;
  - at −2 m: every copied water block ends inside a berm crest. *(refresh 2026-09-29: only if Q10 keeps the −2 m
    path tested; the default builds +5 m / A only.)*
  - *(refresh 2026-09-29)* the baked shadow of a changed or synthetic region comes from `BAKED_LIGHT_DIR`, and a
    retail region's lightmap is unchanged outside the change mask;
  - *(refresh 2026-09-29)* every palette tile used by the paint is in `manifest.tiles` with its retail stem (so TX-R
    finds `tile2d:<stem>`), and `typeName` is overridden for 407/412;
  - *(refresh 2026-09-29)* C9 runs by placement uid with a stub model (S-TREE: a TREES species swap needs no coast
    change).
- **User check:** in the viewer (`?world=jangan-fields`), fly around the south-east corner and see beaches and sea
  cliffs where the map used to stop at a flat plain. Then compare with `preview-A.png`.
- *(refresh 2026-09-29)* **Depends on:** nothing unbuilt (the converter is untouched since wave 3). Re-converting
  `jangan-fields` must happen when no other lane is writing `work/out/world/` (the release and 9B batches write other
  trees; I-CST schedules the run).

### 12.2 CST-B: the Blender round trip (step C0, after CST-C's config schema)

- **Owns:** `packages/convert/src/tools/coast-blender.ts` (the `coast-export` and `coast-import` verbs),
  `packages/convert/tools/blender/{build_edge,readback_edge,make_proc_bundle}.py` (from the prototypes), the
  `blenderExe` example key in `sro.config.json`, and `packages/convert/test/coast-authored.test.ts` (validator rules on
  synthetic PNGs; it skips Blender when Blender is absent).
- **Tests:**
  - an unsculpted area round-trips with no files written;
  - a scripted sculpt outside the bounds round-trips within 1 mm;
  - an in-bounds edit and a moved area border are rejected, naming the region and the vertex;
  - LA16 decodes exactly (`toColourspace('grey16')`);
  - the frozen rectangle is read from `stream.playable`.
  - *(refresh 2026-09-29)* every path handed to Blender is absolute (§6.6 finding 1), and the bundle of the
    prototype area equals the one checked on 2026-09-29 byte for byte (a golden hash) until the terrain export changes.
- **User check:** `pnpm sro coast-export --area 173-175,89-91 --from procedural` opens a `.blend` in which the coast
  lines up with the labels and the sea plane. Sculpt a cove, run `pnpm sro coast-import`, re-convert, and see the cove
  in the viewer. *(refresh 2026-09-29: also brush once across the playable edge: the masked side must not move. This
  is the only way to confirm the 5.2 sculpt mask, §6.6 finding 2.)*

### 12.3 CST-M: minimap and world map (converter part in C0, client part in C1)

- **Owns:** `coast/minimap.ts`, the `stitchWorldMap` fill parameter (`worldmap.ts`), and the two `minimap.ts` fill
  sites (client; a hook, since no 9A lane owns `minimap.ts` **[confirmed: D3]**).
- **Tests:** a changed tile keeps its retail pixels outside the change mask; a synthetic tile is sea-coloured; the
  world map is the new rectangle × 64 px.
- **User check:** press **M**: the coast and the sea are on the map.

### 12.4 CST-O: the ocean surface (step C1)

- **Owns:** `packages/world-render/src/ocean/{ocean, cdlod, spectrum, fft-gpu, fft-wgsl, fft-worker, mips, gerstner,
  surface, ocean-plugin, ocean-classic, queries, weather}.ts`, `packages/world-render/test/ocean-*.test.ts`, and the
  new root `THIRD_PARTY_NOTICES.md` with its Tidewater entry (§8.12).
- **Ports** from Tidewater at `4811ba4`, each file with the MIT header: `OceanFFT.js` (spectrum, kernels, Jacobian
  foam, mip kernels), `WaterSurface.js` (attenuation, band-limiting, normals, near-field detail), `WaterMaterial.js`
  (roughness, reflection corrections, scattering, foam light) and `CDLOD.js` (morph, selection).
- **Depends on:** RND-W, SKY-B, RND-P, RND-L and WX-R; I9A (`World.ocean` created in `world.ts` from
  `manifest.coast`); CST-C's field (§8.1). *(refresh 2026-09-29: the 9A lanes are merged; `World.ocean`, the
  frame-array getter on `WaterRenderer` *(fact-check F5: a public "ensure the PBR water state" call instead; the state
  object is already public)* and the `World.coast?.seaAt` accessor (S-BOUNCE) are I-CST's hooks. Until
  CST-C's first export lands, CST-O works on a synthetic field written by its own test helper. It does not wait for
  SKY2: S-HAZE, S-IBL and S-CLOUDSHADOW read wave-9 functions.)*
- *(refresh 2026-09-29)* **Also owns:** the node-buffer upload and the enable/disable hysteresis (§8.2), the single
  packed varying (§8.6), and the join-zone binding of RND-W's `WaterPbrState`, normal texture and frame array (§8.1).
- **Opens with a spike (1–2 days), whose findings go to §13:**
  1. a Babylon `ComputeShader` writing a `RawTexture2DArray` storage texture through a 2D-array view, and a PBR plugin
     sampling it in the vertex stage on WebGPU;
  2. the mip route of §8.3 (per-level views, per-layer `generateMipmaps`, or none), with its CPU and GPU cost;
  3. `thinInstanceSetBuffer('cdlodNode', …, 4)` read through `getAttributes`, in WGSL and GLSL;
  4. `USE_CUSTOM_REFLECTION` with Babylon's `reflectionBlock` and a tilted normal.
  5. *(fact-check 2026-09-29, F1–F3)* thin instances with a `"matrix"` buffer plus `cdlodNode` at a fixed node
     cap, and the CPU cost of `needDepthPrePass` on the transparent ocean (two variants, a readiness check per call)
     against the depth-only twin. The cheaper route goes in.
- **First commit:** the shore seam (`SHORE_VERTEX`, `SHORE_FRAGMENT`, empty) so CST-S can start.
- **Tests:**
  - CDLOD: the selection covers the view with no holes; vertices at a LOD border coincide with the coarser lattice
    after the morph; nodes wholly over land are culled;
  - spectrum (TypeScript): JONSWAP, TMA and spread values against reference numbers; the `Hs` clamp; a wind change
    moves amplitudes smoothly (fixed seeds); with the rounded frequencies, t = 0 and t = 3,600 s give the same surface;
  - worker tile: the IFFT of a single spectral line is the analytic cosine; the two-real-fields-per-complex packing;
    Jacobian foam within [0, 1.5];
  - per-cascade attenuation is 0 for the longest cascade at depth 0 and 1 beyond its d0; the join fade gives zero
    amplitude at the retail-water join;
  - the mask hides the sea over the town (a render test at −3.26 m);
  - both shader languages compile (NullEngine) and return the same injection-point keys; the compute path is built
    only when `getCaps().supportComputeShaders`; Low builds no depth renderer and no compute;
  - every file with a Tidewater header is listed in `THIRD_PARTY_NOTICES.md` (§8.12);
  - in the browser bench, not vitest: the WGSL FFT matches the TypeScript reference within 1 mm at 16 probe texels
    (one read-back), and no GLSL string reaches the WebGPU engine.
  - *(refresh 2026-09-29)* every ocean define set declares at most one user varying beyond Babylon's own for an
    uv-less, colour-less mesh, and no CSM receiver define on a 16-varying limit (a NullEngine count, like the terrain
    plugin's texture-unit test);
  - *(refresh 2026-09-29)* the join-zone albedo equals `water-plugin.ts`'s formula for the same `WaterPbrState`
    (constants imported, not copied, where the plugin exports them: `WATER_NORMAL_LAYERS`, `WATER_ALBEDO_WEIGHT`,
    `WATER_DEEP`, `WATER_FRAME_REPEAT_M`);
  - *(refresh 2026-09-29)* the ocean mesh toggles its enabled state at most once per 5 s while the camera walks along
    the swash band (a scripted path), so `EnabledMeshCandidates` does not rebuild every frame; *(fact-check
    2026-09-29, F2: replaced by "the ocean never changes its enabled state after creation, only `isVisible`, and
    `EnabledMeshCandidates.rebuilds` does not grow along the scripted path")*
  - *(fact-check 2026-09-29, F1)* the ocean never renders with `thinInstanceCount` 0 (it is invisible then), both the
    `"matrix"` and `cdlodNode` buffers are allocated once at the node cap, and the INSTANCES define is set in every
    ocean variant (a NullEngine check of the defines);
  - *(fact-check 2026-09-29, F14)* no implicit-derivative `textureSample` in the ocean's vertex WGSL, and none outside
    `CUSTOM_FRAGMENT_MAIN_BEGIN` in its fragment WGSL (a source scan of every define set);
  - *(refresh 2026-09-29)* the ocean material has the fog plugin attached (by the global registration) on every PBR
    preset, and none on Low.
- **User check:** stand on the south beach at noon. The open sea shows long swell under short chop with no visible
  repetition, and it calms toward the beach. `/weather storm`: over a minute the sea builds, whitecaps appear and
  linger, and the glint breaks up. At night there is a moon glint. The sea fades into the sky with no line, and the bay
  mouth shows no seam. On Medium the sea looks the same, only softer. *(refresh 2026-09-29: do this check on
  **Medium first**, the preset the friends play on; then High for the extra detail.)*

### 12.5 CST-S: shore v1 (step C1, after CST-O's seam commit)

- **Owns:** `packages/world-render/src/shore/{chunks, swell, swash, lace, spray}.ts`,
  `packages/world-render/src/coast/chunks.ts` (the terrain wet band) and `packages/world-render/test/shore-*.test.ts`.
- **Ports**, with the MIT header: the swash cycle of `ShoreWaves.js` (`shoreSwashRunup`), the lace generator of
  `SurfFoam.js` (`makeLaceTexture`), and the swash-front bead of `WaterMaterial.js`.
- **Depends on:** CST-O's seam; CST-C's field B land heights (§8.1); I9A (`COAST_CHUNKS` in `WORLD_SHADER_CHUNKS`);
  RND-T or I9A (the `sroCoastWet` extern).
- **Tests:**
  - the run-up rises over 40 % of the period and falls over 55 %, and never uncovers the minimum film;
  - the front lies where the sand height equals the run-up, on a synthetic 1:13 beach;
  - the shore swell's height follows Green's law and turns to foam at H = 0.78 d;
  - the lace texture is deterministic, tileable, and the same in the worker and in a reference run;
  - the wet band is 0 above SL + R_max;
  - no swash sheet on slopes steeper than the rock threshold.
  - *(refresh 2026-09-29)* with `sroCoastWet` on, every final terrain define set stays at ≤ 16 WebGL2 texture units
    (the existing D32 test extended) and the terrain plugin still adds no varying;
  - *(refresh 2026-09-29)* the analytic bead (film thickness `SL + R(t) − h_sand` < 3 cm) replaces the depth-buffer
    bead, and is 0 wherever the film is thicker.
- *(refresh 2026-09-29)* **Depends on** I-CST instead of I9A/RND-T for the two one-line hooks (`COAST_CHUNKS` in
  `WORLD_SHADER_CHUNKS`, the `sroCoastWet` extern), since those lanes are closed.
- **User check:** on S1 at noon, waves roll in parallel to the shore, break into a foam line, run up the sand and
  slide back. The foam thins from a mat into lace and strands, and the sand stays dark for a moment behind the
  retreating water. `/weather storm` brings bigger run-up and spray on the cliffs. *(beaches 2026-09-29: "on the
  cliffs" reads "at the beach ends"; and the swash runs on every beach, so check it on the Tiger beach too, where
  the mountain kind's steeper foreshore gives a shorter run-up.)*

### 12.6 CST-A: life and sound (step C1)

- **Owns:** `apps/game/src/audio/coast.ts`, the `COAST` area (data and hook), the sound export scope entry,
  `apps/game/src/world/fx/{birds,ships,critters}.ts`, and the prop-scatter rules inside `coast/` (coordinated with
  CST-C).
- Ships and surf emitters read CST-O's CPU wave query (§8.4).
- **Tests:** the area switches at 120 m with hysteresis; at most 4 emitters; flock and ship paths stay over water
  deeper than 8 m.
- **User check:** walking down to the beach, the surf gets louder and gulls call. A ship crosses the haze.

### 12.7 CST-T: textures (9B batch B-coast)

- **Owns:** the B-coast batch in TEXPIPE's runner: sand, wet sand, shingle and cliff rock from retail ids 407, 412,
  70, 534, 278 and 226. Nothing is downloaded. The foam is CST-S's generated lace, and there is no chop normal or
  caustic set any more (§7.2).
- **User check:** the review sheet, and in game the sand does not tile visibly from the camera height.
- *(refresh 2026-09-29)* **Keys and order** per §7.3: sets `tile2d:asiaminor_sand_01`, `asiaminor_sand_02`,
  `oaho_dust_earth01` (as wet sand), `alex_dust_05`, `rok_stone_01`, `c_stone_hmfld_02`, `oaho_dust_earth06`
  (`c_stone_hmfld_01` exists already); sand and wet sand as hero sets for Medium. Local only (upscaler, derivation,
  the SDXL detail step through `start_comfyui.sh`), in a reviewed batch, and only while the GPU lock is free and no
  other heavy GPU job runs. It waits for nothing but CST-C's tile list; B2/B3 can run before or after it.

### 12.8 I-CST: integration (step C2)

1. Merge CST-C (phase 1) → CST-M(conv) → CST-B. Re-convert `jangan-fields`, then run `optimize-out --only
   world/jangan-fields/`.
2. Apply `COAST_CHUNKS`, the `sroCoastWet` extern and `World.ocean`, then merge CST-O, CST-S, CST-A and CST-M(client).
3. Merge CST-C phase 2 (W/NW per A or B) and re-convert.
4. LAB:
   - the §8.11 budgets at the south-east corner on the dev PC and on an iGPU; if friends can run the bench, on a
     gaming laptop and an Apple M1 (Chrome and Safari);
   - the chosen mip route's CPU cost, and the first-load compile time of the compute pipelines and ocean variants;
   - the horizon strip, the bay-mouth join, fold artefacts in a storm swell from a low camera;
   - the GLSL-on-WebGPU guard; Low and Medium screenshots, and High on WebGL2 (Medium's ocean).
   - *(refresh 2026-09-29)* the wave-9 final gate's method (production bundle, private `vite preview`, the GPU lock,
     400 uncapped frames after streaming idles) on a new bench scene **"beach"** (`tp beach-south`, looking south-east,
     noon clear and night storm), on **Medium on both backends first**, then High and Ultra on WebGPU; each against
     §8.11 table 1 and the coast total; with SKY2 off and on (WAVE_PLAN4's joint gate);
   - *(refresh 2026-09-29)* the S-HAZE / S-HORIZON strip, S-EXPO pan, S-CLOUDSHADOW waterline and S-TAA storm checks
     of §8.13; `installVaryingBudgetCheck` silent on a 16-varying adapter (or the dev flag that forces the limit).
5. Server: `WORLD_EXPORT=jangan-fields`: 307 regions in `nav.bin`, 791 nests *(fact-check F8: the log's placed and
   unreachable counts, about 700 and 91, unchanged from before the coast)*, `tp beach-south` (GM), then walk off the
   beach into the water and stop at the bounds. *(beaches fact-check 2026-09-29, G1: and, as a player without GM,
   **walk from town to S1** by the in-bounds link.)* A character saved on the old 0 m strip logs in on the new sand
   (`entryPoint` → `nav.place`, F15).
6. `THIRD_PARTY_NOTICES.md` is present, lists every ported file, and ships with the client build (§8.12).

### 12.9 H-CST: hunt lenses

- Flooding: the ocean over any dry ground below SL (town, moat, ruins, the tomb foot, the east bound at z 99–101).
- Seams: region seams, normals, the land/sea split, the bay-mouth water join, the horizon, and cracks or swimming
  vertices at CDLOD level borders.
- GPU paths: an adapter without `shader-f16`; a lost device or a background tab (the compute textures are rebuilt);
  every preset on WebGL2; tiling seen from high above; folds under alpha blending.
- Determinism: re-convert twice, and after a Blender import.
- Blender validation bypasses: edits inside the bounds, a moved border, stale bundles, or 8-bit decoding.
- Placements: floating or buried props on moved ground; big in-bounds models overhanging the coast.
- Reachability: new walkable ground outside the home component, or new routes to the Western China component.
- Licence: a file with ported code but no header, or missing from `THIRD_PARTY_NOTICES.md`.
- *(refresh 2026-09-29)* Frame drops: a black or frozen frame on a 16-varying WebGPU adapter with the sea in view
  (BF-2); a transparent sea over the cleared far plane read as sky by haze, shafts or TAA (§8.2); active-mesh list
  churn at the swash band; the worker stalled in a background tab and the sea frozen after return. *(fact-check
  2026-09-29: also a plain ocean grid flashing at the origin on a frame with 0 selected nodes (F1), and a bay-mouth
  step under a cloud shadow on High (F6).)*
- *(refresh 2026-09-29)* Sky-and-sea seams: a colour step where the sea meets the dome, in fog weather and at dusk; a
  cloud shadow that stops at the waterline; the exposure dropping when the glint fills the screen.

### 12.10 Later lanes (optional, after the beach playtest)

These are not part of wave 10. Each waits until the user has played on the beach after I-CST and wants more. Costs
are in §8.11, designs in §8.8.

| Lane | What | Needs | Owns | User check |
|---|---|---|---|---|
| **CST-W** | Breaking waves (port of `ShoreWaves.js`, plus the lip sheet), High and Ultra | CST-C writes `coast/shore.png` (travel time, direction, exposure) in `coast/field.ts` | `packages/world-render/src/shore/{breakers, shore-field}.ts` | Waves steepen over the sand bar, plunge and run up as a bore |
| **CST-F** | Surf simulation (port of `ShoreSim.js`), High and Ultra | CST-W | `packages/world-render/src/shore/surf-sim.ts` | Foam drifts with the backwash and is left stranded on the sand |
| **CST-K** | Caustics, Ultra | RND-T or I-CST adds the `sroCaustics` extern | `packages/world-render/src/shore/caustics.ts` | Light patterns ripple on the sand under shallow water |

### 12.11 Scope-cut order (cut from the top)

*(beaches 2026-09-29: re-ordered below the original list as "Beaches cut order"; the old items 1–16 keep their order,
and the beach items slot in as marked.)*

*(refresh 2026-09-29: re-ordered for a release whose default is Medium: the cuts that only touch High/Ultra go first,
Medium's look is cut last, and two Mac levers are added. The user's decisions (Option A, +5 m, the walkable beach)
are no longer cut candidates without asking the user; they move to the bottom as "ask first".)*

1. Caustics and the opaque-refraction option (Ultra), if they were pulled in.
2. Ships, bird flocks and shore critters.
3. Ultra's extras: the near-field detail and G 64 (Ultra then runs High's mesh and shading with the 256² FFT).
4. Spray sprites and lingering whitecaps (the Jacobian foam stays, without memory).
5. Shadows received on the sea (High+).
6. The GPU FFT (High and Ultra use the worker tile: no compute, storage textures or mip route).
7. **Mac lever 1:** the lace texture on Medium (the foam band stays, with the analytic bead).
8. **Mac lever 2:** Medium's CDLOD G 16 → 8 and 6 levels (the far sea gets coarser; the fog hides it).
9. The animated swash and the shore swell (keep the static wet band and the foam band).
10. Positional surf emitters (keep the area ambience).
11. The Classic (Low) Gerstner waves (Low keeps the retail water animation on the ocean mesh).
12. Paint inside the bounds (the sand then starts exactly at the bounds line).
13. The north-east coast (keep east and south; the lake keeps its retail edge).
14. The PBR ocean on Medium → the Classic ocean with field depth.
15. *Ask the user first:* phase 2 (the west and north-west coast and Option A's corridor; the west stays retail land
    toward Donwhang, as in TECH's design).
16. *Ask the user first:* the walkable beach → look-only (a dune ridge outside the bounds at +5 m; no
    `allowHeightPatches`).

The later lanes (§12.10) are not in wave 10, so they are not on this list. SKY2's cuts are its own; a SKY2 cut never
forces a coast cut, because every shared seam has a wave-9 default (§8.13).

**Never cut:** the frozen-playable check, determinism, seams, the sea mask (no inland flooding), the Blender export and
readback with validation (the user's request), the fog-matched horizon, no GLSL on the WebGPU engine, the one-varying
rule, and the MIT notice for ported code.

*(beaches 2026-09-29)* **Beaches cut order.** Cut from the top; the numbers in brackets place each item among the old
list above.

1. *(before old 1)* Scripted Blender passes beyond the first two hotspots (the corridor faces, N2, the strait): they
   keep the procedural base, which is already beach everywhere.
2. *(before old 1)* The boulder scatter on the flanks and beach ends (§3B.5).
3. *(after old 4)* Per-section beach kinds: collapse to two (wide, mountain).
4. *(after old 9)* The `--watch` mode of the Blender verbs (the headless scripts and hand sculpting stay).
5. *(after old 12)* The row z 86 (the field's south margin): the Tiger shelf then meets the clamp at about 10–12 m
   deep **[projected]**, a colour step the fog mostly hides.
6. *Ask the user first:* the Blender pass on the Tiger flank and the tomb face (the user asked for Blender; without it
   the flanks are the even procedural ramps of `render-tiger-base.png`).
7. *Ask the user first:* any return of a cliff (for example a lower flank grade that cannot fit a beach in the domain).

**Never cut (beaches):** a beach in front of every sea shore, no sea cliff, the flank envelope's shoulder at the bounds
line (no crease), the tomb crest keep, the river-mouth keep, and the frozen check. *(beaches fact-check 2026-09-29:
and, while S1 stays walkable, its in-bounds link to town (G1); dropping the link means old cut 16, ask first.)*

### 12.12 The lanes at a glance (refresh 2026-09-29)

| Lane | Step | Owns (files) | Seams it provides or uses | Tests (vitest unless noted) | User check | Depends on |
|---|---|---|---|---|---|---|
| **CST-C** converter coast pass | C0, phase 1 then phase 2 | `packages/convert/src/world/coast/**`, `content/coast/coast.json`, `packages/convert/test/coast-*.test.ts`; hooks in `convert-world.ts` (3 call sites), `manifest.ts` (`WorldCoast`, `synthetic`), `WORLD_PRESETS` | Provides `coast/field.png` + `manifest.coast` (for CST-O/S/A/M), the tile list (CST-T), placement edits by uid (S-TREE) | §12.1 list: frozen area, land sides bit-identical, seams, determinism, mask, berms, S1's four height copies, nav slices, islands, places, lightmap bake, tiles, C9 by uid | Viewer: beaches and cliffs at the SE corner; compare `preview-A.png` | Nothing unbuilt |
| **CST-B** Blender round trip | C0, after CST-C's schema | `packages/convert/src/tools/coast-blender.ts`, `packages/convert/tools/blender/*.py`, `blenderExe` key, `coast-authored.test.ts` | Uses CST-C's `authored.ts` reader and validator | §12.2 list + absolute paths + golden bundle hash | Export an area, sculpt a cove (and brush across the mask), import, see it in the viewer | CST-C schema |
| **CST-M** minimap and world map | C0 (conv), C1 (client) | `coast/minimap.ts`, `worldmap.ts` fill parameter, the two `minimap.ts` fills | Reads `manifest.coast.mapColor` | Change mask kept, sea tile colour, map size | Press M: coast and sea on the map | CST-C |
| **CST-O** ocean surface | C1 (spike first) | `packages/world-render/src/ocean/*.ts`, `test/ocean-*.test.ts`, `THIRD_PARTY_NOTICES.md` (S-NOTICE default owner) | Provides the shore seam (`SHORE_VERTEX/FRAGMENT`), the CPU wave query, `seaAt` (S-BOUNCE); uses S-HAZE (fog plugin), S-IBL, S-CLOUDSHADOW, S-CLOCK, RND-W state (join) | §12.4 list + varying count, join formula, enable hysteresis, fog attached; browser bench FFT parity | Medium first: swell and chop, storm build-up, moon glint, no horizon line, no bay-mouth seam | CST-C field (or its synthetic stand-in); I-CST hooks |
| **CST-S** shore v1 | C1, after CST-O's seam commit | `packages/world-render/src/shore/*.ts`, `src/coast/chunks.ts`, `test/shore-*.test.ts` | Fills the shore seam; provides `COAST_CHUNKS` and `sroCoastWet` | §12.5 list + texture units ≤ 16, no varying, analytic bead | S1 at noon: waves, foam lace, swash, wet sand | CST-O seam; CST-C field B; I-CST hooks |
| **CST-A** life and sound | C1 | `apps/game/src/audio/coast.ts`, the `COAST` area, the sound export entry, `apps/game/src/world/fx/{birds,ships,critters}.ts` | Uses CST-O's wave query and CST-C's field | Area switch with hysteresis, ≤ 4 emitters, paths over > 8 m water | Surf and gulls grow louder; a ship in the haze | CST-O query; WX-A's ambience untouched |
| **CST-T** textures (B-coast) | C1, on the texpipe runner | The B-coast batch config and its review sheet (data, not code) | Uses CST-C's tile list; TX-R loads by `tile2d:<stem>` | The texpipe's own index validation | Review sheet; sand does not tile from the camera | CST-C tile list; a free GPU |
| **I-CST** integration | C2 | Hooks only: `WORLD_SHADER_CHUNKS` entry, terrain extern, `World.ocean`, `WaterRenderer`'s public PBR-state ensure call (F5), `World.coast.seaAt`; re-convert and `optimize-out` | Applies every seam; runs LAB with SKY2 on/off | Full suite, the beach bench (§12.8), §8.13 checks | The beach at noon, dusk and in a storm, on Medium | All C0/C1 lanes; SKY2's seam commit for the joint gate |
| **H-CST** hunt | C2 | Fixes only | – | §12.9 lenses | – | I-CST |

**Dependencies between specs** (for WAVE_PLAN4): the coast needs from **SKY2** only that S-HAZE, S-HORIZON,
S-CLOUDSHADOW, S-IBL and S-EXPO keep the contracts of §8.13; SKY2 needs from the coast the sea surface in the depth it
reads (S-HAZE) and `seaAt` (S-BOUNCE). The coast needs from **TREES** nothing, and TREES needs from the coast only the
C9 uid rule (S-TREE). Nothing in this spec waits for wave 11 (movement, screens, pets and social).

*(beaches 2026-09-29: SKY2 and TREES are deferred, so those dependencies are dormant. The live cross-spec seams are
S-DRAW with the user's item 1 and S-LIFE with docs/GRASS_LIFE.md (§8.13). Jump (item 3) and the character stage
(item 4) share no file with the coast.)* *(beaches fact-check 2026-09-29, G9: jump does: `blenderExe` and
`packages/convert/tools/blender/` (S-BLENDER) and the landing sound's `waterLevelAt` (S-MOVE); GRASS_LIFE's GL-C also
hooks `convert-world.ts` and `manifest.ts` beside CST-C, so the wave plan orders the two hook commits. The character
stage (inside the town wall) shares nothing.)*

### 12.13 What beaches everywhere changes in the lanes (beaches 2026-09-29)

| Lane | Change | New tests | New user check |
|---|---|---|---|
| **CST-C** | Ports `work/tmp/coast-beach/coast_beach.py` instead of the cliff model: beach kinds, the flank envelope (shoulder, grade, lower-or-fill, ≤ 6 m relief, smooth toe, line blur widening outward), the waterline from the toe, the tomb crest keep, the river-mouth keep, the hole rule, the z 86 row. `coast.json` per §5.2's beaches block. *(beaches fact-check 2026-09-29: plus the S1 `openTiles` link (G1), the flank paint at 38° / 45° (G7), `s_in` down to −0.9 or a blended shoulder (G11), a smooth join at the tomb keep line (G12) and the inward-only S1 feather the prototype lacks (G2).)* Owns the same files as before (§12.1). | (1) no vertex outside the bounds on a sea side, beyond 100 m of the line, is steeper than 50° except the listed hotspots (a slope census like `census.py`, with the hotspot list as a checked-in allowance) *(beaches fact-check, G6: run on the merged result, base plus authored layers; the gully pass raises the share over 45° from 0.73 % to 1.19 %)*; (2) the envelope equals the retail height on the bounds line and its slope across the line is continuous within 0.15 (no crease) *(beaches fact-check 2026-09-29, G11: tested on the **final surface**, since the envelope starts at the blurred `Hb`; plus a bench check: no run of more than 20 m flatter than 0.1 m/m within 10–60 m of the line where the inner slope is steeper than 0.3, and the same crease check along the tomb keep line, G12)*; (3) every sea-mask shore segment outside the bounds has sand (paint 407/412/70) within 12 m of it, except within `riverMouthKeepM` of in-bounds sea-level water and at the N3 bay mouth, which keep retail banks *(beaches fact-check)*; (3b) *(beaches fact-check, G7)* at least 80 % of the lowered flank below 38° is painted with grass tiles; (3c) *(beaches fact-check, G1)* S1 reaches the town's component with every region outside the bounds closed; (4) the tomb keep is bit-identical and the tomb cliff meshes' footprints lie on unmoved ground; (5) retail water within `riverMouthKeepM` of in-bounds sea-level water keeps its bed; (6) the census numbers (emitted regions, changed regions, placements) are written to `manifest.report.coast` and match the prototype within 10 % for the same config. The old tests stand (frozen area, seams, determinism, land edges bit-identical, mask, S1's four copies, nav slices, islands, places). | Viewer: fly the whole coast; there is sand in front of every shore, the Tiger mountains come down green to a beach, and the tomb crest looks as before from the plaza. Compare with `preview.png`. |
| **CST-B** | Adds the scripted passes (`gullies`, `spurs`, `dunes`, `cove`) as `packages/convert/tools/blender/passes/*.py`, a `--pass <name> --seed <n>` option and `--watch` on `coast-export`, and runs the first two hotspot sessions (the Tiger flank, the tomb face) as reviewed `content/coast/height/` commits. | A pass never writes a vertex under `.sculpt_mask` or within 30 m outside the line, never moves the area border, and is deterministic (two runs, identical layers); the readback of a pass validates with 0 errors (as in §3B.7). | Watch one pass run in the Blender window (`--watch`), or sculpt a cove by hand; import; see it in the viewer. |
| **CST-M** | Sand swatches in the composite; the larger world map (§11). | A changed tile draws sand where the paint is sand. | Press M: sand all round the map. |
| **CST-O / CST-S** | Nothing structural. Swash on every beach; spray at the beach ends instead of cliffs. | – | The swash on the Tiger beach (steeper foreshore) as well as S1. |
| **CST-A** | Loses the bird flock to GRASS_LIFE (S-LIFE); keeps the surf audio, the `COAST` ambience and the ships. | – | Gulls (GRASS_LIFE) over the beach; surf louder near the sea. |
| **CST-T** | B-coast drops `rok_stone_01` (§7); sand, wet sand, shingle and rock remain. | – | – |
| **I-CST** | The gate is the coast's own (no SKY2); the "beach" bench plus a new bench at the Tiger corner (156.0, 90.0) for the terrain worst case (§8.11B). | – | The look check (§15) includes the Tiger beach and the tomb. |
| **H-CST** | New lenses: a crease or step along the bounds line *(beaches fact-check: and benches 10–60 m out, G11; the tomb keep line, G12)*; S1 walked to from town without GM (G1); a river mouth closed by sand; a lateral face beside a river mouth; the tomb view from the plaza; a dropped placement still drawn by an instanced batch (S-DRAW); grass on sand (S-LIFE). | – | – |

---

## §13 Risks and open technical points

- **Sea level** is the one number that shapes the section table's S1, S2 and N3 rows, the berms and the in-bounds
  patch list. It must be fixed before CST-C writes `coast.json` (§14). *(refresh 2026-09-29: fixed at +5 m by the
  user; no longer a risk.)*
- **The bay-mouth join at +5 m** (retail water against the ocean at the same level) is projected to be invisible with
  the amplitude fade and shared chunk **[projected]**. LAB checks it. The fallback is a narrow sand bar or reed bed at
  the bounds line, outside the playable set. *(refresh 2026-09-29: "shared chunk" = RND-W's `WaterPbrState` and
  normal texture, bound by the ocean in the join zone, §8.1; the retail water keeps its roughness 0.04 while the ocean
  uses Cox–Munk, so the zone also blends the roughness to 0.04.)*
- **The 4 m field against low land next to the sea:** the mask relies on terrain above SL between the sea and low land.
  If LAB sees sea over dry ground at the east bound (z 99–101) or at 170,102, the berm there is widened, or the field
  goes to 2 m locally **[projected]**.
- **Stretched cliff faces** (S4 up to about 100 m at ≈ 64°): triplanar is High+ only, so on Low and Medium retail cliff
  rocks must cover them **[likely enough; LAB screenshot]**. *(beaches 2026-09-29: **resolved** by beaches everywhere; flanks are ≤ 31–40°, B13.)* *(refresh 2026-09-29: Medium is now the default, so this
  is what most friends see. Triplanar stays High-only [confirmed: `quality.ts` `NO_TERRAIN_EXTRAS` on Medium]; the
  retail cliff-rock scatter at the S4 toe and a Blender pass on the worst face are the Medium answer. If LAB still sees
  stretching, a Medium-only "triplanar on cliff cells" define is a question for WAVE_PLAN4, since it costs GPU on the
  default preset.)*
- **The retail drop at the east bounds** (25 → 0 m within 16 m of column 175): rocks or a Blender touch-up hide it.
- **Ring placements:** 74–88 stand on moved ground in GEO's geometry (one guard tower), mostly in phase 2. The C9 rule
  handles vegetation automatically. Rocks and structures go to the report for hand placement.
- **Lightmaps of changed regions:** v1 blends the retail lightmap toward white where the ground moved. Proper shadows
  on new cliffs wait for RND-L's measured bake direction (D16) **[unknown quality]**. *(refresh 2026-09-29: D16 is
  measured (azimuth −14°, elevation 38°), so v1 bakes new cliffs with a heightfield ray-march, §5.4 step 5; quality
  against the retail bakes is [likely] close (RND-L's r 0.690 on the same method).)*
- **Absolute overrides against profile retunes (C8):** an authored area keeps its sculpted heights if the procedural
  base changes under it. The report warns when the base under a weighted vertex moves by more than 0.5 m. A delta mode
  can come later if this bites.
- **Blender sculpt mask:** `.sculpt_mask` was written and saved, but brushes were not exercised interactively in 5.2
  **[likely: the Blender 4.1+ convention]**. *(refresh 2026-09-29: re-confirmed saved on 5.2.2; a headless sculpt
  operator crashes Blender, so the check is a user check in CST-B, §6.6. The validator is the safety net either
  way.)*
- **Walking under water in our client** (retail bed-walking) has not been play-tested **[unknown]**.
- **Performance numbers** for the ocean are projected (§8.11). LAB measures them on the dev PC and one integrated GPU,
  and on a gaming laptop and an Apple M1 if friends can run the bench. *(refresh 2026-09-29: the worker tile and the
  CDLOD walk are now measured on the CPU; the rest stays projected. There is no integrated-GPU friend; the Mac is the
  class to watch. The real risk is **High's CPU**: the coast view sits about 0.4 ms under 16.7 ms at High on WebGPU
  before SKY2 adds anything [projected from the measured gate-storm row], so a High pass at the beach depends on the
  perf item, not on this spec.)*
- **Babylon's compute path (CST-O's spike, §12.4):**
  - storage textures are written at mip level 0 only **[confirmed: `webgpuHardwareTexture.js`]**, so the FFT's mip
    chains need a raw-WebGPU helper **[likely]**, per-layer `generateMipmaps` (CPU cost) or no mips (aliasing in the
    far sea, mostly hidden by fog);
  - writing a 2D-array storage texture from a `ComputeShader`, and sampling it in the PBR vertex stage, are **[likely]**
    but not yet run;
  - whether the reflection correction works through `USE_CUSTOM_REFLECTION` is **[unknown]**; without it the sea keeps
    Babylon's plain reflection, which is only slightly too bright on rough water.
  If the thin-instance route for the CDLOD fails, the fallback is the first design's clipmap (one mesh, one draw).
- **Folds under alpha blending:** a choppy FFT surface overlaps itself. The depth pre-pass should order it
  **[likely]**; otherwise Ultra's opaque-water option (§8.6) or a lower choppiness on High.
- **Apple Silicon and laptops:** High is the first-run default on a Mac, and a base M1 projects to about 15–20 ms of
  GPU for the WAVE_PLAN3 High stack alone at 1080p-equivalent, more at the Retina resolution the game renders by
  default (§8.11) **[projected]**. The first-run rule should send base M1/M2 GPUs to Medium, or to High at resolution
  ≈ 0.6. Separately, `apps/game/src/engine.ts` requests no `powerPreference` **[confirmed: grep]**, so a dual-GPU
  gaming laptop may be handed its integrated GPU **[unknown per browser and OS]**. Both are GAME's first-run and engine
  items (WAVE_PLAN3 §5.1), flagged here and not changed by this spec. *(refresh 2026-09-29: **both resolved.** Every
  Mac now starts on Medium at render scale 0.75 on Retina, and both engines request `'high-performance'`
  [confirmed: `settings.ts` `recommendGraphics`, `engine.ts` `GPU_POWER_PREFERENCE`]. What remains is the projected
  11–15 ms of GPU on a base M1 at the beach on Medium (§8.11); the Mac levers are cuts 7–8.)*
- **Shader compile time:** Tidewater compiles hundreds of shaders on its first load (the lead's notes). Our ocean adds
  five compute pipelines and one PBR variant per preset; they are compiled during loading (`ComputeShader.isReady`,
  the plugin's warm-up) **[projected]**. The later breaking waves (a 35 KB source) are the big risk here.
- **Ported code:** Tidewater is young (the commit read is from 2026-09-25) and runs on its own engine. We port, so
  upstream fixes do not arrive by themselves; the commit is pinned and the MIT notice is kept (§8.12).
- **Road check:** dirt tracks leaving the playable area on a sea side cannot be ruled out by tile id. A viewer check
  is due **[unknown]**.
- *(refresh 2026-09-29)* **The inter-stage limit (new).** One varying too many drops whole frames on a default
  WebGPU adapter (BF-2); the ocean is designed to one packed varying and no CSM on such adapters (§8.6), and a test
  counts it. Some Apple adapters report 16 **[confirmed: the user's hardware notes in `w9-user-decisions.md`, and the
  game's `hasFewVaryings` cap]**.
- *(refresh 2026-09-29)* **Haze and shafts vs a transparent sea (new).** If SKY2 builds its haze or shafts as a
  depth-reading post pass, the sea beyond the emitted band has no depth under it and would read as sky (§8.2, S-HAZE).
  Default: haze in the material; the depth pre-pass writes the sea surface. Decided at SKY2's seam commit
  **[unknown until then]**.
- *(refresh 2026-09-29)* **TAA on displaced waves (new).** No motion vectors for the sea; storm crests may ghost on
  High **[unknown]**. LAB checks; the fix is velocity from the previous tick (S-TAA).
- *(refresh 2026-09-29)* **Blender paths (new, minor).** Relative render paths land at the drive root in 5.2.2
  **[confirmed]**; the verbs pass absolute paths (§6.6).
- *(fact-check 2026-09-29)* **Babylon plumbing for the sea (new).** A thin-instanced mesh without a `"matrix"` buffer, or
  with 0 instances, is drawn as one plain grid at the origin (F1). The transparent depth pre-pass re-runs the material
  with a per-call readiness check (F3). Toggling `setEnabled` rebuilds the active-mesh list (F2). Each has a test
  and a spike item in §12.4 **[confirmed: 9.28 source; cost projected]**.
- *(refresh 2026-09-29)* **A shared licence file (new, minor).** Two specs port Tidewater; one owner for
  `THIRD_PARTY_NOTICES.md` avoids a merge fight (S-NOTICE).

- *(beaches 2026-09-29)* **Even ramps (new).** A procedural flank at one grade looks like a ramp from the sea
  (`render-tiger-base.png`). The Blender passes are the answer; without them the look is plain but has no edge. The
  gully pass shows the gain **[confirmed: renders]**; how many sessions the whole coast needs is **[projected: six
  hotspot areas, §3B.7]**.
- *(beaches 2026-09-29)* **Fill changes more ring ground (new).** The envelope raises ring ground by up to 135 m where
  the old outer faces fell away. Anything that assumed "the coast only lowers" (the berm logic, the footprint test, the
  nav openness rule "never open a retail-closed tile") was re-read: the footprint test and the openness rule still hold
  because they compare moved ground either way; the report now lists raised as well as lowered placements **[likely]**.
- *(beaches 2026-09-29)* **Lateral faces beside river mouths (new).** Where a mountain on the bounds line stands next
  to a river mouth (S3 beside S2), the kept retail bank carries a 45–60° side face outward for about 100 m. It faces
  the river mouth, not the open sea, and it is hotspot 1 of §3B.7 **[confirmed: prototype]**.
- *(beaches 2026-09-29)* **Retail peaks inside the bounds stay steep (new).** From the sea, the S3 ridge and the
  Jangan south wall still rise steeply behind their beaches (`render-south.png`). Lowering them would change playable
  ground; that is a user decision, not this spec's default (§16 Q16).
- *(beaches 2026-09-29)* **Placements.** 28 look-only models are dropped and listed; the count and the split depend on
  the tuning **[confirmed for the prototype; likely within ± 30 % after tuning]**.
- *(beaches 2026-09-29)* **Terrain worst case.** +17 resident regions on High at the Tiger corner, on a preset already
  at its line (§8.11B). If the user's item 1 lands first and frees CPU, the margin returns; if not, the corner's extra
  terrain is the first thing LAB measures there.
  *(beaches fact-check 2026-09-29, G3: the old Option A was already +11 / +16 at its NW corner, so the real rise is
  0 / +1; with the unload hysteresis up to +19 / +22 stay resident. The Tiger corner's own baseline (mountains, trees,
  no town) is not measured **[unknown]**; I-CST measures it without the coast first.)*
- *(beaches fact-check 2026-09-29)* **S1 cannot be walked to (new, G1).** The walkable beach the user chose is a
  pocket whose only nav link to town runs outside the bounds, where the clamp stops players; the coast closes part of
  that route, and if none survives the island rule would close the beach **[unknown which]**. The `openTiles` link (§3.5) is required, not optional; its route is §16 Q22. Until it exists S1 is
  a GM-teleport beach **[confirmed: `inbounds-reach.ts`; in-game untested]**.
- *(beaches fact-check 2026-09-29)* **Rock-painted flanks (new, G7).** With §7's first thresholds (grass under 30°)
  most of the 31° flank would be rock-blend and grassless, the opposite of "come down green"; the thresholds move to
  38° / 45° and a paint test guards them **[confirmed census; look projected]**.
- *(beaches fact-check 2026-09-29)* **Benches and the tomb kink (new, G11, G12).** A flat shoulder where the retail falls
  toward the line (3–16 % of the sea-side lines) and a 58° → 12° kink along the tomb keep line are the "sharp edges"
  the user does not want; CST-C's shoulder and join rules and the crease test cover them, and the rest are Blender
  hotspots **[confirmed: prototype profiles]**.

---

## §14 What the user decides

*(refresh 2026-09-29: **decided.** On 2026-09-28 the user chose items 1 (Option A), 2 (+5 m) and 3 (the walkable
beach), and took the recommendation on items 4–11 [confirmed: `work/tmp/w9-user-decisions.md`, "coast decisions"].
Item 12 stays open until the beach playtest. The questions are kept below as the record; the answers are in bold at
the end of each. What is still needed is in §15, and the open questions with defaults in §16.)*

Look at `work/tmp/coast/overview.png` (the maps A and B side by side, then the beach and the cliffs). The larger maps
are `preview-A.png` and `preview-B.png`. The recommended answer comes first each time.

1. **Option A (land bridge west to Donwhang) or Option B (all coast, Jangan is an island)?**
   *Recommended: A.* It matches "where it doesn't continue to next town", keeps Donwhang possible without undoing the
   coast, and differs from B only as seen from one submerged river mouth at the west edge. Switching later is a data
   change and a re-conversion (§4). **Answer: A.**
2. **Sea level look:**
   - *Recommended: +5 m.* The sea sits at the level of the rivers and the lake. The lake north of Jangan opens into
     **Jangan Bay**, and rivers run straight into the sea (as in the previews). It needs one change to playable
     ground: the beach below Jangan's south wall (question 3).
   - *Alternative: −2 m.* No playable ground changes at all. The lake becomes a lagoon held 7 m above the sea by a sand
     bar, and the south river ends at a bar. The beaches then start exactly at the edge of the playable area.
   - **Answer: +5 m, "Jangan Bay".**
3. **Beach walkability:**
   - *Recommended: a walkable beach below the south wall* (Jangan South Beach). The flat strip outside the wall is
     raised into sand and slopes into the water, and the edge of the playable area lies in about 2 m of water. It
     changes playable heights there (about 2.3 % of the playable ground, no monsters or NPCs), and the navigation data
     for those 9 regions is rewritten.
   - *Alternative: look-only beaches.* The strip stays as it is, and a dune ridge just outside the edge hides the sea
     until you look over it.
   - Where the edge of the playable area should sit in the water: about 2 m deep (recommended) or about 1.5 m.
   - **Answer: walkable; the bounds line in about 2 m of water.**
4. **Deep water:** keep the retail rule, where you can walk along river and lake beds under water (*recommended*), or
   add a new rule that stops players at water deeper than about 1.5 m? The new rule would also close parts of today's
   lake and river beds. **Answer: keep the retail rule.**
5. **The mouth of Jangan Bay:** leave the shallow sill (about 5 m deep) just outside the edge (*recommended*: it is
   under nearly opaque water), or deepen the northern 40–60 m of the lake floor inside the playable area, which changes
   underwater navigation heights? **Answer: leave the sill.**
6. **Option A only: the land bridge's content.** Terrain only for now (*recommended*), or Donwhang's walls and gate as
   look-only scenery as well? **Answer: terrain only.**
7. **Extras:** a few islets and sea stacks off the Tiger cliffs and the south-east cape? *Recommended: yes, later, as
   hand sculpts in Blender.* **Answer: later, as Blender sculpts.**
8. **Order:** build the east, south and north-east coast first, then the west (*recommended*). Alternatively, stop
   after the first phase and keep the west as retail land toward Donwhang. **Answer: east, south and north-east
   first, then the west.**
9. **When to build:** after wave 9A is integrated, alongside 9B's texture batches (*recommended*, so the coast is
   judged with the new sky, fog and water), or earlier, beside 9A (the converter files do not overlap)? **Answer:
   after 9A, beside 9B; since 2026-09-29 superseded by the order "sky and sea" as wave 10 (§12.0).**
10. **Blender MCP:** the round trip works with plain scripts. Installing a Blender MCP add-on (a download and a
    configuration change, only with your go-ahead) adds a live Blender window in which Claude sculpts while you watch.
    *Recommended: decide when the first hand edits start.* **Answer: only when live editing is wanted.**
11. **Retail props on moved ground** at the edges: re-snap or drop them automatically, and list rocks and buildings for
    hand placement (*recommended*), or leave everything for the Blender pass? **Answer: automatic, with the list.**
12. **Later shore upgrades** (the ocean follows Tidewater, the game you pointed us at; §8): breaking waves that curl
    and plunge, foam that drifts with the water, and light patterns on the sand under shallow water. Each is a later,
    optional lane on High and Ultra. *Recommended: decide after the first playtest on the beach with the foam band and
    swash run-up.* **Open: after the beach playtest (§16).**
13. *(beaches 2026-09-29)* **Edges near the water:** "i dont want no sharp edges, all edges of the map if its near the
    water it should have a beachy area. So use blender to make this happen." **Answer (2026-09-29): beaches along all
    of the sea coast, no sea cliffs; mountains at the edge sculpted down in Blender; inland riverbanks and the lake
    stay retail.** Design: §3B. The previews for it: `work/tmp/coast-beach/before-after.png`.

---

## §15 Needs from the user (refresh 2026-09-29)

Nothing blocks the start: the decisions of §14 are made, the tools are installed, and nothing is downloaded or
uploaded. Each item has a default, so nobody waits.

1. **The look check on Medium.** At I-CST, a sheet of the south beach and the Tiger cliffs at noon, dusk, night and in
   a storm, on Medium (the preset the friends play on), with High beside it. *Default: Claude sends the sheet; the coast
   ships on a "looks okay", like B0.*
2. **One interactive Blender check** (about five minutes, whenever the first hand sculpt happens): brush across the
   edge of the playable area and see that the masked side does not move (§6.6). *Default: until then Claude edits by
   script, and the validator rejects any in-bounds change either way.*
3. **GPU time for the B-coast texture batch** (local upscaler, derivation and the SDXL detail step, one reviewed
   batch). *Default: it runs when the GPU lock is free and nothing else heavy runs, like B2/B3, and the review sheet
   comes to you.*
4. **A friend's Mac, if possible:** one run of the beach bench on a base M1/M2 at Medium. *Default: ship on the dev
   PC's numbers; the frame watchdog and the Mac levers (cuts 7–8) cover a slow Mac.*
5. **Trees on the coast** (a TREES question, noted here): should the new tree models include a coastal species, such
   as wind-bent pines on the cliffs? *Default: no new species for the coast; retail trees are re-snapped or dropped by
   the C9 rule, and whatever TREES replaces them with follows automatically.*
6. **Blender MCP:** not needed for this wave. *Default: not installed (your earlier answer: only when live editing is
   wanted).*

*(beaches 2026-09-29)* For beaches everywhere:

7. **A look at `work/tmp/coast-beach/before-after.png`** (the old cliffs against the new beaches, same cameras) and
   `preview.png` (the whole map). *Default: the coast is built as shown and ships on a "looks okay" at the Medium look
   check (item 1).*
8. **How you want the Blender work done:** by Claude's scripts with before/after renders (the default), watching them
   run in a Blender window on your screen (`--watch`, no download), or sculpting some stretches yourself (a short
   how-to comes with `coast-export`). *Default: scripts for all six hotspots, and the first `--watch` session is
   offered when the Tiger pass runs; any hand edit you make goes through the same import and checks.*
9. **The coastal-tree question (item 5 above) is moot for now:** the new tree models are deferred, so coastal trees are
   retail, re-snapped or dropped by C9. *Default: no action.*
10. *(beaches fact-check 2026-09-29)* **How players get to the south beach** (G1, §16 Q22): today it can only be
    reached through ground outside the playable area, which the coast turns into sea and mountain flank. *Default:
    Claude opens the shortest safe path inside the playable area that the converter finds (currently along the east
    shelf from the tomb side), and you walk it once at the look check; the alternatives are a path through the river
    channel south of town or a cut through the south wall, both with more terrain edits.*

## §16 Open questions, each with a default (refresh 2026-09-29)

| # | Question | Default | Who settles it |
|---|---|---|---|
| Q1 | Does SKY2 apply its haze and sun shafts in the material or as a depth-reading post pass (S-HAZE)? | In the material (the `SroFogPlugin` path), so the transparent sea is hazed at its surface; the ocean's depth pre-pass writes the sea surface for anything that reads depth. | SKY2's seam commit; WAVE_PLAN4 |
| Q2 | Who owns `THIRD_PARTY_NOTICES.md` (S-NOTICE)? | CST-O creates it; SKY2's lanes append; one test scans every Tidewater header. | WAVE_PLAN4 |
| Q3 | The FFT's mip route (§8.3)? | CST-O's spike decides; per-layer `generateMipmaps` is ruled out on CPU grounds; if the raw-WebGPU helper fails, no mips. | CST-O spike |
| Q4 | Triplanar on cliff cells on Medium, for the S4 faces? | No. Retail cliff rocks and a Blender pass; revisit only if the look check shows stretching, and measure it first. | LAB, then the user |
| Q5 | The swash run-up height: ours (`0.15 + 0.25 · Hs`, ≤ 0.8 m) or Tidewater's (≈ the wave height)? | Ours, tuned in LAB on S1 between the two. | LAB |
| Q6 | The swell's direction (`coast.json` `ocean.swellFromDeg`)? | From the open sea to the south-east of the map, the direction the most coast faces (S and E). | CST-C, LAB |
| Q7 | Does the coast have to pass 16.7 ms at High? | No. It must stay inside its own budget (§8.11); High's pass belongs to the performance item. The beach becomes one of that item's bench scenes. | WAVE_PLAN4 |
| Q8 | Motion vectors for the sea under TAA (S-TAA)? | None, unless LAB sees crest ghosting in a storm on High. | LAB |
| Q9 | Ultra's opaque, refracting water? | Not built in wave 10 (first on the cut list). | – |
| Q10 | Keep the −2 m and Option B paths working in code? | Build and test +5 m / Option A only; keep the `seaLevelM` and `option` fields so the others stay a later converter change, without tests now. | CST-C |
| Q11 | Ships, bird flocks and critters in wave 10? | In, and second on the cut list. | – |
| Q12 | Later shore upgrades (breakers, surf simulation, caustics; §14 item 12)? | Decide after the beach playtest. | The user |
| Q13 | *(fact-check 2026-09-29, F15)* Add an export version (`WorldInfo.exportId`, the manifest's `createdAt`) so a page left open across a re-convert offers a reload? | No for wave 10: the re-convert ships as a deploy with a server restart and a "reload the page" note, as world changes already do. Revisit if a friend reports sinking into the S1 sand. | I-CST; WAVE_PLAN4 |
| Q14 | *(fact-check 2026-09-29, F3)* Babylon's `needDepthPrePass`, or a depth-only twin mesh, for the sea's depth? | Whichever CST-O's spike measures cheaper on the main thread; the twin if `needDepthPrePass` costs more than 0.05 ms. | CST-O spike |
| Q15 | *(beaches 2026-09-29)* Walkable beaches all round (not only S1)? | No for this wave: every other beach is look-only behind the unchanged bounds. Later it needs `manifest.walkRegions`, graded paths down the flanks and a clamp change (§9.4, about a week plus a server change). | The user, after the playtest |
| Q16 | *(beaches 2026-09-29)* Lower the steep retail peaks **inside** the bounds too (the S3 ridge, the Tiger inner crest), so no steep mountain is seen from the sea? | No: playable ground stays retail (only S1 changes). From inside the bounds the view now opens over a shoulder to the sea; from the sea the inner peaks stand behind beaches. | The user |
| Q17 | *(beaches 2026-09-29)* Islets and sea stacks (§14 item 7), now that there are no cliffs? | Low sandy islets and sand bars with a beach all round, later, as Blender sculpts; no stacks. | The user, later |
| Q18 | *(beaches 2026-09-29)* The flank grades (mountain 31°, wide 24°) and beach widths (48–90 m)? | As in §3B.2; CST-C tunes them in the viewer, steeper grades only where a beach would not otherwise fit the domain. | CST-C, LAB |
| Q19 | *(beaches 2026-09-29)* The 28 dropped look-only models (gorge pieces, a Buddha wall, rocks) on the regraded ring? | Dropped and listed; the Blender pass re-places the few that read well as `props.json` entries. | CST-B |
| Q20 | *(beaches 2026-09-29)* Keep the row z 86 in the field domain? | Yes: it costs 0.2 MB of field and no emitted region, and lets the Tiger shelf deepen before the clamp. | CST-C |
| Q21 | *(beaches 2026-09-29)* Where do gulls live, the coast or GRASS_LIFE? | GRASS_LIFE's bird system, with a gull species and sea-side rules from the coast (S-LIFE). *(beaches fact-check, G8: a procedural species of GRASS_LIFE's one bird mesh, not the retail hawk; over water deeper than 8 m, loafing on dry sand.)* | The next wave plan |
| Q22 | *(beaches fact-check 2026-09-29, G1)* Which in-bounds route links S1 to town? | The cheapest `openTiles` set a nav search finds with the ring closed (a tile-level search: about 5 retail-closed tiles on the east shelf's edge column and at the NE corner, x 172–175 × z 93–102); a GM `beach-south` place stays. Alternatives: open the S2 channel bed north of z 91.3, or grade a cut through the south wall (both need town-side height or openness edits). | CST-C proposes; the user walks it at the look check |
| Q23 | *(beaches fact-check 2026-09-29, G7)* Flank paint thresholds? | Grass tiles up to 38°, blend to Jangan rock over 38–45°, rock above 45°, so GRASS_LIFE's grass (full to 36.9°) covers the lowered mountains. | CST-C, with GRASS_LIFE's GL-F in the viewer |
| Q24 | *(beaches fact-check 2026-09-29, G5)* `holeBelowM`? | −100 m (58 retail vertices are below −200 m and 76 below −100 m, all in the pit at 162.8 × 104.4; the deepest retail outside it is −93.2 m at the corridor's west edge, 150.0 × 97.6). | CST-C |
