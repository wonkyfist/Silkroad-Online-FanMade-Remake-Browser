# Every terrain texture upscaled (TERRAIN_TEX, wave 12)

> **Status (2026-10-02, I-12): built in wave 12.** 108 tiles with a set (88 B3 this wave), 63 hero, the painterly rule,
> Medium's detail layer and anti-tiling, the hero-only set range; `texpipe hero`. docs/WAVE_PLAN8.md overrides this
> spec where they differ: cut 5 ("B3c keeps retail tiles") is removed (D38: every tile upscaled, never cut), TT-B owns
> `overrides.json` and merges the trees' fragment (D7), and LAB-12 measured the Medium shading (Dropbox
> `wave12/budgets.md`).
> **Island (2026-10-10, docs/COAST.md §4.1):** the export paints 65 of the 108 tiles (46 of the 88 B3 sets), 54 hero;
> the other 43 painted only the drowned Western China side. Their sets stay in `work/out/pbr`; the editor's palette
> lists the 65.

The user (2026-10-01): "Just make sure also the textures for dirt, grass, sand, etc all terrain textures are
upscaled." This spec covers every terrain tile of the `jangan-fields` export:

- which tiles are remastered today, which are not, and how often each one is seen (§1);
- the pipeline per tile through `@sro/texpipe` (§2) and the look target (§3);
- repetition seen from the game camera (§4);
- the tiers per preset and the runtime path (§5), and the VRAM and download budgets (§6);
- the WebGL2 far-terrain blotch bug, coordinated with wave 11's GF-R (§7);
- a prototype on 7 tiles with in-game before/after shots and measured deltas (§8).

It ends with the decisions, what the user must provide, the open questions, the lanes and the scope-cut order.

This is a design document. No file under `packages/`, `apps/`, `content/` or `deploy/` was changed. Scratch scripts,
prototype outputs and images are in `work/tmp/terrain-tex/`. Nothing was downloaded. Terrain stays on the local
pipeline: Meshy cannot make seamless tiles (`work/tmp/w9-user-decisions.md`), so this spec spent **0 Meshy credits**.

## Status tags

- **[confirmed]**: checked in code or data, or measured for this spec (the method is given).
- **[likely]**: follows from code, data or measurements, but was not run end to end.
- **[projected]**: an estimate from measured parts.
- **[unknown]**: not established.

---

## 0. Summary

1. **20 of the 108 tiles are remastered today, and they cover 76% of the ground.** That is 75.9% of the field
   vertices, 78.3% of the town's and 75.1% of the ring within 5 regions of town [confirmed:
   `work/tmp/terrain-tex/coverage.ts` over every region's `terrain/*.bin` and `work/out/pbr/index.json`]. The other
   **88 tiles** cover the remaining 24%. Of those, 22 tiles carry 21.7% of the fields, 21 tiles carry 1.9%, and a
   long tail of 45 tiles carries 0.5% together (§1).
2. **All 88 go through the existing pipeline, unchanged in code:** TP-U (Real-ESRGAN x4plus), TP-P (de-light, height,
   normal, AO, roughness), TP-E (WebP tiers). The SDXL detail stage (DT-2) runs only on the 10 paving, rock and moss
   tiles of batch B3a; the 8 gritty dirt and field-soil tiles of B3a take the AI upscale with the painterly rule,
   because B1's SDXL-routed soils kept only 21–54% of their grain (fact-check, §3.1). The prototype ran the real chain
   on 7 tiles in about 1 minute of compute (TP-U 38 s for 6 tiles, TP-P and TP-E 43 s) [confirmed]. The whole B3
   batch is about 20 minutes plus 0.7–2.5 hours of SDXL GPU time [projected, §2.6].
3. **The look target is painterly SRO, not photoreal.** The prototype found that the default GAN route **removes up
   to 71% of the fine painted grain** on gritty soils. At Medium's 512 tier, c_dust_hmfld_01 kept 29% of the retail
   high-frequency energy and c_stone_jinfild_04 kept 42%. The derived AO also **darkened soils in game** by 6–10
   luminance levels [confirmed, §8.4]. A **"painterly ground rule"** brings the result back toward the retail identity:
   - for soil, moss and rock: AI mix 0.5, AO ×0.4 (×0.25 for the build), normal ×0.6, de-light 0.5;
   - for paving: B1's soft maps.

   Three new gates in TP-E's review hold it there: grain retention ≥ 60%, albedo mean within ±3 levels, and in-game
   luminance within −3 levels (§3). Note: at AI mix 0.5 the two grittiest prototype soils still fail the grain gate
   (c_dust_hmfld_01 46%, c_stone_jinfild_04 48%), so they ship at the gate's next step (AI mix 0.3 or the `retail`
   route), not as the "tuned" images in the before/after sheets [confirmed: §8.4 table, re-measured by
   `grain_check.py`].
4. **Medium is where friends play**, because the wave-9 release made Medium the default everywhere. Today Medium shows
   the remaster only as the retail-size albedo plus ORMH for hero tiles. Two cheap changes:
   - mark every visible tile **hero**, so Medium samples its AO and roughness (Medium has no height blend or
     parallax, so the ORMH height channel is unused there [confirmed: `quality.ts` medium `NO_TERRAIN_EXTRAS`]);
   - turn on the existing **detail layer and anti-tiling on Medium**. Measured in game on the dev PC, the cost is
     within noise: GPU p50 1.19 and 1.26 ms without, 1.32 and 1.13 ms with (both arms average 1.225 ms; two runs
     each on a busy machine, WebGPU only) [likely, §4.3; LAB-12 re-measures on both backends].
5. **The 48-layer set range is the runtime limit.** With all 108 tiles as sets, 37 of the 414 Medium windows and 70 of
   the High windows would hold more than 48 set tiles at the load radius. Among them is the town window on High, with
   56 tiles. If the set range only admits **hero** tiles (63 of them), that drops to 2 Medium and 12 High windows,
   with a maximum of 50 [confirmed, `windows.ts`]. Regions stay resident out to the **unload** radius (560 / 660 m),
   and there the hero-only figure is 29 windows over 48, a maximum of 58 and 50 in the town window [confirmed:
   `windows-unload.ts`, fact-check]; the overflow tiles lose their maps and 1024 tier, never their remastered albedo.
   That is a small change in `stream.ts` (lane TT-R).
6. **Budgets.**
   - **Low:** 0.
   - **Medium:** +9.8 MB VRAM and +4.3 MB on first entry to town.
   - **High on WebGPU:** +235 MB VRAM for every High WebGPU player (the set planes are 48 layers deep as soon as
     there are 48 hero sets; the town window alone needs 48), and +20 MB on first entry.
   - **High on WebGL2:** +49 MB VRAM.
   - **Deploy:** about +165 MB.

   Every number is in §6. **KTX2 for the terrain arrays is not justified this wave.** The Medium delta is 10 MB, and
   High's +235 MB fits the friends' 6–8 GB GPUs. KTX2 stays an optional lane (TT-K) and the first scope cut.
7. **The WebGL2 far-terrain blotches were fixed** by P-LOOK in commit 96b1149: map-plane mips were uploaded empty on
   WebGL2 [confirmed: the `textures.ts` diff and wave10/budgets.md]. GF-R (wave 11) verifies the fix. This wave puts
   every tile on that same code path. The regression test already exists (`p-look.test.ts`), so TT-R keeps it green,
   adds a range-depth test and a WebGL2 far-field user check. It does not repeat the diagnosis (§7).

---

## 1. Inventory: what exists, what is seen

All numbers come from `work/tmp/terrain-tex/coverage.ts` and `windows.ts`. These read `work/out/world/jangan-fields`
(the 414 regions, 107 of them synthetic coast filler) and `work/out/pbr/index.json`. The output is `coverage.json`
[confirmed].

### 1.1 Totals

| | Tiles | Fields cover | Town 3×3 cover | Near ring (≤ 5 regions from town) | Coast filler (synthetic regions) |
|---|---:|---:|---:|---:|---:|
| Remastered today (B1 hero 16 + B-coast 4) | 20 | 75.9% | 78.3% | 75.1% | 88.9% |
| **B3a**: not remastered, max cover ≥ 0.5% | 22 | 21.7% | 18.8% | 22.7% | 10.1% |
| **B3b**: not remastered, 0.1–0.5% | 21 | 1.9% | 2.8% | 2.0% | 0.6% |
| **B3c**: the long tail, < 0.1% everywhere | 45 | 0.5% | 0.06% | 0.2% | 0.4% |
| **Total** | **108** | 100% | 100% | 100% | 100% |

- **Where the numbers come from.** The manifest lists 108 tiles, all used by at least one region. The index holds 22
  terrain sets. Two of them, `oaho_dust_earth01` and `alex_dust_05`, are B-coast sets for tiles that the re-converted
  export no longer uses. The texpipe inventory warns about both [confirmed: `pnpm texpipe inventory` warnings]. They are
  harmless and stay in the index.
- **Not every remastered tile is hero today.** Of the 20 used sets, 17 are `hero: true`. The three used B-coast sets
  `oaho_dust_earth06` (8.5% of the field vertices and 69% of the coast filler), `c_stone_hmfld_02` (2.0%) and
  `asiaminor_sand_02` (0.7%) are not [confirmed: `work/out/pbr/index.json` `hero`, `coverage.json`]. The "63 hero
  tiles" of §1.3 and §5.2 count them, so D6 marks them hero too (data only).
- **All 512² and all opaque**, 28.3 Mpx in total [confirmed: inventory]. Classes by RENDER §3.3 `classify`:
  ground_soil 56, stone 32, ground_grass 16, water 4 [confirmed]. By `typeName`: Dirt 62, Grass 17, Stone 12,
  Mud 6, Sand 5, Water 6.
- **Texel density.** A tile repeats every 8 m under codes 0 and 2, which is 64 px/m. Under code 1 it repeats every
  16 m, which is 32 px/m. Code 1 covers 12.6% of the vertices [confirmed: TERRAIN §2.2 census].

### 1.2 How often each tile is seen (the not-yet-remastered tiles, ranked)

"Fields" is the share of field vertices, "town" the share in the 3×3 town, and "near" the share within 5 regions of
town (where levels 1–20 are played). "Regions" is how many regions use the tile.

| Batch | Tile (id) | Type | Fields % | Town % | Near % | Regions |
|---|---|---|---:|---:|---:|---:|
| B3a | c_marble_jang_07_1 (51) | Stone, paved road | 2.50 | 1.59 | **5.90** | 22 |
| B3a | c_grass_hmfld_04 (264) | Grass | **4.12** | 0 | 3.55 | 146 |
| B3a | c_grass_hmfld_02 (8) | Grass | 1.70 | 2.15 | 1.73 | 126 |
| B3a | c_dust_fld_02 (1) | Dirt | 0.59 | 2.53 | 1.49 | 61 |
| B3a | c_dust_hmfld_02 (10) | Dirt (now mostly lake and sea bed) | 0.90 | 1.47 | 1.90 | 98 |
| B3a | wc_stone_don_08 (233) | Dirt-typed sandstone rock | **3.77** | 0 | 0.08 | 67 |
| B3a | c_marble_jang_07 (38) | Stone paving | 0.10 | 3.18 | 0.24 | 9 |
| B3a | c_dust_hmfld_01 (9) | Dirt | 1.54 | 0.20 | 1.75 | 104 |
| B3a | c_marble_jang_01 (13) | Stone paving | 0.08 | 2.61 | 0.19 | 5 |
| B3a | c_stone_jinfild_04 (178) | Dirt, field soil | 0.34 | 1.62 | 0.85 | 35 |
| B3a | c_grass_hmfld_05, c_dust_swmp_07, c_dust_fld_07, c_grass_fld_11, c_marble_jang_03, wc_dust_don_10, wc_dust_don12, wc_stone_don_04, c_dust_swmp_05, c_marble_jang_08, wc_dust_don_06, wc_stone_don_05 | grass, moss, dirt, paving, rock | 0.2–1.2 each | ≤ 1.3 | ≤ 1.2 | 20–68 |
| B3b | 21 tiles (c_grass_fld_05 … wc_dust_don_09) | mixed | < 0.25 each | < 0.5 | < 0.35 | 1–55 |
| B3c | 45 tiles (oaho_grass_05 … oaho_dust_earth07) | mostly far-west Donwhang dirt (wc_*), desert, ruins | < 0.1 | < 0.01 | < 0.06 | 1–48 |

The full list is in `work/tmp/terrain-tex/coverage.json`. The top 40 unremastered tiles are in
`unremastered_top40.png`.

- **Grass tiles are mostly hidden under our own grass** near the player on every PBR preset (GRASS_LIFE and
  GRASS_FAR, rings A–C). The prototype's grass spot showed no visible terrain difference at the game camera
  [confirmed: `ba_tuned_game.jpg` row 1]. Not hidden everywhere: on **Grass: Low**, the Mac and iGPU default, the
  field stops at about 35 m with no far ring, and Grass: Off shows the bare tile [confirmed: GRASS_FAR §1 table row
  "Low"]. There the grass tile is seen from 35 m out, where the 512 tier is already finer than the screen (§4.1).
  Grass tiles therefore get the upscale (for those players, gaps, paint edges and the far carpet's base colour) but
  never SDXL time (§2.5).
- **Several soil tiles are now under water.** The +5 m sea of the coast revision turned c_dust_hmfld_02's best
  patches into lake bed: the prototype's first field-soil spot rendered under water [confirmed: shot, and the
  water-height check in `spots.ts`]. They are seen through shallow water, so they get the cheap route.

### 1.3 Load windows (what a player has resident at once)

These windows are computed around every region centre with the stream's rectangle distance (Medium 400 m, High
480 m) [confirmed: `windows.ts`].

| | Median tiles | p90 | Max | Town window (168, 97) | Windows over 48 set tiles if all 108 are sets |
|---|---:|---:|---:|---:|---:|
| Medium (400 m) | 27 | 48 | 63 | 46 (16 with a set today) | **37 of 414** |
| High (480 m) | 30 | 53 | 71 | 56 (16 with a set today) | **70 of 414** (the town included) |
| Hero only (63 tiles: today's 20 + B3a + B3b), Medium / High | 24 / 26 | 38 / 44 | 50 / 50 | 43 / 48 | **2 / 12** |
| Hero only at the **unload** radius (Medium 560 m, High 660 m: the same result, 192 m regions) | 29 | 47 | 58 | 50 | **29** |
| All 108 at the unload radius | 35 | 61 | 86 | 59 | **110** |

The last two rows are from the fact-check [confirmed: `work/tmp/terrain-tex/windows-unload.ts`, the radii from
`stream.ts` `HIGH_STREAM` and `medium`]. A region keeps its tile references until it passes the unload radius, so a
player walking out of town can hold up to 58 hero tiles at once: the load-radius rows are the floor, the unload rows
the ceiling.

`TILE_TIER_LAYERS = 48` caps the set range. A set tile beyond the cap keeps its remastered base albedo but loses its
maps and its tier layer [confirmed: `tile-atlas.ts` header and `takeLayer`]. Which tiles lose out depends on load
order, not importance. That is why §5.2 admits only hero tiles to the range.

The set range's depth is global, not per window: `tileSetup` sizes the map and tier planes once, at
`min(48, set tiles in the manifest)` [confirmed: `stream.ts` `tileSetup` `depth`]. With 63 hero tiles every player on a
PBR preset gets 48-deep planes from the first frame.

---

## 2. The pipeline per tile

Nothing new is built. Every stage exists in `@sro/texpipe`, and B3 is a configuration plus a reviewed run. The
prototype drove the stages through their exported functions from `work/tmp/terrain-tex/run.ts`, with its own
texpipe and pbr folders and in-memory overrides [confirmed: ran]. The build lane runs the CLI instead
(`pnpm texpipe run --set …`), after its overrides are committed.

### 2.1 Stages (TEXPIPE §2–§3, unchanged)

| Stage | What it does for a tile | Prototype (7 tiles, dev PC under wave-11 load) |
|---|---|---|
| TP-U upscale | x4plus, 32 px wrap padding on both axes, AI/Lanczos mix | 38.3 s for 6 tiles (28.1 s of Real-ESRGAN, 17.9 s per source Mpx; 10.1 s/Mpx on a quiet machine, TEXPIPE §3.4); seams within the source's ratio everywhere [confirmed: `up.log`] |
| DT-2 SDXL detail (§2.5) | ControlNet-Tile on the GAN master, half-offset seam repair, colour lock, the uvsafe-style gate | **not run**: the stage waited for GPU headroom for the whole session (others held 4.4–7.0 GB of VRAM with 0.3–3.2 GB of free RAM while the wave-11 build ran) [confirmed: `detail.log`]; B1's numbers stand in (§2.5) |
| TP-P maps | de-light, multi-scale height, Sobel normal, cavity AO, roughness; worker pool | 15–19 s per tile on 6 workers, 43 s with encoding for 6 [confirmed: `pbr-gan.log`] |
| TP-E encode | WebP tiers 512 / 1024 / 2048; albedo q90; nx/ny planes; ao/rough/height | 4–9 s per tile; normal error 0.41–0.58° mean, p99 1.1–1.6° [confirmed: `pbr-*.log`] |
| Review | `pnpm texpipe review` cards, plus this spec's tile sheets and in-game spots (§2.4) | `tex-sheet.png`, `pbr-sheet-tuned.png`, the `ba_*.jpg` sheets |

**Seamless tiling is preserved.** Wrap padding keeps every result within its source's seam ratio, measured in U and V
at TP-U [confirmed: `up.log`]. Examples: c_grass_hmfld_04 1.06→0.98 and 1.3→1.07; c_dust_swmp_07 1.48→1.07 and
2.05→1.29.

c_marble_jang_07_1 rises from 1.91/3.79 to 2.39/4.83. That is the slab joint sitting exactly on the tile edge, the
same case as B1's `cj_pal_floor`. The 3×3 repeat in `tex-sheet.png` shows a clean joint grid, not a seam [confirmed:
by eye].

### 2.2 Route per tile (decision)

| Route | Which tiles | Why |
|---|---|---|
| **SDXL** (DT-2, terrain profile) | the 10 B3a paving, rock and moss tiles: c_marble_jang_07_1, _07, _01, _03, _08; wc_stone_don_08, _04, _05; c_dust_swmp_07, _05 | the most-seen structured ground. DT-2's sub-texel crispness shows at High's 1024 tier and Ultra's 2048, near the camera. B1's SDXL paving kept 67–73% of its grain and its SDXL moss 78% [confirmed: `grain_b1.py`] |
| **GAN** (x4plus + the painterly rule) | the 4 B3a grass tiles; the 8 gritty B3a soils (c_dust_fld_02, _07, c_dust_hmfld_01, _02, c_stone_jinfild_04, wc_dust_don_06, _10, wc_dust_don12); all 21 B3b; all 45 B3c | grass is under the grass field; DT-2 works on the GAN master and kept only 21–54% of the grain on B1's gritty soils (c_dust_hmfld_03 21%, c_stone_hmfld_01 41%, c_dust_fld_01 54%) [confirmed: `grain_b1.py`]; B3b and B3c are ≤ 0.5% each, and at the 512 tier SDXL's detail is below a texel |
| **retail** (Lanczos ×4, no AI) | any tile the grain gate (§3.2) still fails after aiMix 0.5 → 0.3 | keeps most of the painted grain at the 512 tier (B1's retail-route c_dust_fld_06 keeps 76% after de-light and WebP q90, not 100%) [confirmed: `grain_b1.py`]; High's near-camera crispness then comes from the detail layer |

An SDXL tile is also held to the grain gate; one that fails falls back to the GAN route with the painterly rule.

B1's twenty sets keep their routes. The existing sets that fail the new grain gate get a **retune pass** (the GAN
route with aiMix 0.5 and the painterly maps, stepped by the gate): c_dust_hmfld_03 (22%; SDXL today),
oaho_dust_earth06 (27%; B-coast) and **c_stone_hmfld_01 (45%; SDXL today; 3.5% of the fields and 3.0% of the near
ring)**, which the first draft listed in §8.4 but left out of the retune [confirmed: §8.4 table]. c_dust_fld_01 is
borderline (54% in the fact-check's re-measure) and is retuned only if TT-B's pinned gate (§3.2) fails it.

### 2.3 Prompts per family (DT-2)

DT-2 builds its prompt from the class (`detail/profiles.ts` `promptFor`). That gives every ground_soil tile "packed
earth dirt road" and every Water-typed tile "wet muddy ground". B3 sets per-family prompts through
`overrides.json` `sdxl.prompt`, and the profile appends its style words. No code change:

| Family (tiles) | Prompt |
|---|---|
| field soil (c_stone_jinfild_*, c_dust_hmfld_*) | tilled brown field soil, small clods and furrow crumbs, fine dry earth |
| moss / forest floor (c_dust_swmp_05/07) | damp forest floor, soft moss and short mossy grass over dark earth, tiny leaves |
| rock (wc_stone_don_*) | weathered sandstone rock ground, wind-worn ridges, fine mineral grain, grit in the hollows |
| paving (c_marble_jang_*) | the existing paving prompt (`/marble/`) |
| dirt (c_dust_fld_*, wc_dust_don_*) | the existing ground_soil prompt |

The prototype's in-memory overrides carry the first three [confirmed: `run.ts` `PROMPTS`]. Their SDXL output is not
measured yet, because the stage did not run (§2.1). With the fact-check's route change (§2.2) only the moss, rock
and paving prompts are used in B3; the field-soil and dirt prompts stay in `overrides.json` for a tile the user
later moves to SDXL. Note that c_stone_jinfild_* and wc_stone_don_* classify as `stone` (name rule), not
`ground_soil`, so without an override they would get the "weathered grey stone" prompt [confirmed: `classes.ts`
`classify` stone regex, `profiles.ts` `promptFor`].

### 2.4 Review sheets (what TP-E's review shows for a terrain tile)

TP-E's review card already shows retail, AI, albedo, maps, lit and wet [confirmed: TEXPIPE §3.8]. For terrain, TT-B
adds two images per tile, written by the run into `work/texpipe/review/terrain/`:

1. **The tile sheet** (`tex-sheet.png` in the prototype). The columns are:
   - retail;
   - the GAN, tuned and SDXL masters at the same corner;
   - the tier the player sees at Medium (512) and High (1024);
   - a **3×3 repeat** (24 m), which exposes motifs that repeat every 8 m.
2. **The game-camera pair** at the tile's spot. This is the in-game before/after from the private preview, at Medium
   1920×1080 with the game camera (`alpha −π/2, beta 1.1, radius 9`, the defaults in `screens/world.ts`) and a wide
   framing (`beta 0.95, radius 22`). The spot finder (`work/tmp/terrain-tex/spots.ts`) picks a 40 m patch where the
   tile covers ≥ 50% of the vertices, the ground is dry (above the block's water height + 0.7 m) and the relief is
   under 12 m, nearest town. TT-B ports it into `@sro/texpipe` as `terrain-spots.ts`.

The three §3.2 gates print on each card. The `ok` status in `overrides.json` stays the user's or Claude's call per
tile.

### 2.5 SDXL: only where it helps (decision and evidence)

- **B1's measurement:** at the terrain profile, SDXL adds sub-texel detail ("crisper, more even grass and soil, not
  new structure") [confirmed: TEXPIPE §3.4a first runs]. At the 512 tier that Medium samples, sub-texel detail at 2K
  falls below one texel.
- **Grass is hidden** (§1.2), so no SDXL on grass. That avoids the 7 grass-tile SDXL runs B1 made.
- **Gritty soils lose grain under SDXL.** DT-2 refines the GAN master, so it starts from the grain the GAN already
  removed: B1's SDXL soils keep 21% (c_dust_hmfld_03), 41% (c_stone_hmfld_01) and 54% (c_dust_fld_01), against 67–78%
  for its SDXL paving, grass and moss [confirmed: `work/tmp/terrain-tex/grain_b1.py`, fact-check]. So SDXL goes to
  the 10 paving, rock and moss tiles only (§2.2).
- **Cost:** 3.5–5 min per 2K tile, up to 3 generations [confirmed: TEXPIPE §3.4a]. That is 10 × 4.25 min ≈ 45 min
  typical and ≤ 2.5 h worst case [projected].
- **The prototype's SDXL run did not get the GPU** (§2.1). The SDXL column of `tex-sheet.png` is empty. TT-B's first
  step is to run DT-2 on the prototype's road, rock and moss tiles and add the column before the batch (open
  question Q1).

### 2.6 B3 batch cost (projected from the prototype)

| Stage | Tiles | Time |
|---|---:|---|
| TP-U | 88 (+3 retunes) | 91 × 6.4 s (38.3 s for 6 tiles, of which 4.7 s per tile is Real-ESRGAN) ≈ 10 min (≈ 6 min on a quiet machine) |
| TP-P + TP-E | 88 (+3 retunes) | 91 × ≈ 7 s ≈ 11 min on 6 workers |
| DT-2 | 10 | ≈ 45 min typical, ≤ 2.5 h worst |
| Review | 91 cards + 30 in-game pairs | one sitting for Claude's pre-review; the user sees one overview sheet |

---

## 3. The look target: painterly SRO, not photoreal mush

### 3.1 What the prototype found (§8)

- **The x4plus model denoises the painted grain.** Retail SRO soils are gritty, high-frequency paint. x4plus reads
  part of that grain as DXT noise and smooths it. At the 512 tier, the share of the retail fine-detail energy left is
  [confirmed: `|L − blur(L, 1.5)|` ratio, §8.4]:

  | Tile | GAN route | Tuned |
  |---|---:|---:|
  | c_dust_hmfld_01 | 29% | 46% |
  | c_stone_jinfild_04 | 42% | 48% |
  | c_dust_hmfld_02 | 53% | 61% |
  | the paving | 66% | 66% |
  | the rock | 87% | 86% |
  | the moss | 97% | 93% |
  | the grass | 115% | 115% |

  B1's twenty sets keep 70% at the median, with c_dust_hmfld_03 at 22% [confirmed]. That is the "smooth mush" the user
  must not get. The tuned column still fails the 60% gate for c_dust_hmfld_01 and c_stone_jinfild_04, so the gate's
  fallback steps are the expected path for gritty soils, not an exception.

  **Fact-check re-measure** (`work/tmp/terrain-tex/grain_check.py` and `grain_b1.py`, PIL Gaussian blur radius 1.5
  instead of the prototype's blur, which is not in the scratch folder): c_dust_hmfld_01 27% / 43%,
  c_stone_jinfild_04 40% / 46%, c_dust_swmp_07 88% / 85% (GAN / tuned); B1 median 67%; c_dust_hmfld_03 21%,
  oaho_dust_earth06 17%, c_stone_hmfld_01 41%, c_dust_fld_01 54% [confirmed]. Same verdicts, but the numbers move by
  up to 10 points with the blur implementation. TT-B therefore pins one implementation (sharp `blur(1.5)` on the
  512-tier luminance against the retail PNG resized to 512) in `review.ts` and its unit test.
- **Derived AO darkens soils in game.** Albedo means stay within +1.5 levels of retail. In game at Medium, though,
  luminance fell [confirmed: shot crops, §8.4]:

  | Spot | Today | GAN route | Tuned |
  |---|---:|---:|---:|
  | dirt | 70 | 63 | 64 |
  | moss | 77 | 67 | 69 |

  That is the ORMH AO and the roughness response, which is the "dark blotches on soil" B1 also saw.
- **Relief on steep rock** gave harsh dark streaks on Medium. Medium has no triplanar, so the rock texture stretches on
  the slope. The tuned maps soften them [confirmed: `crops_before_gan_tuned.jpg`, rock row].

### 3.2 The rule and its gates (decision)

**The painterly ground rule** goes into `overrides.json`, per set, for every ground_soil and stone tile that is not
paving:

- `upscale.aiMix 0.5`;
- `pbr.aoScale 0.25`, a step past the prototype's 0.4, because 0.4 still left −6 levels;
- `pbr.normalScale 0.6`;
- `pbr.delight 0.5`.

Paving keeps B1's `normalScale 0.35, aoScale 0.4`. Grass stays at the defaults.

**Gates** (TT-B adds them to the review card; a tile that fails stays `auto` and keeps a note):

1. **Grain retention** ≥ 60% at the 512 tier (fine-detail energy against retail). On a fail, aiMix steps 0.5 → 0.3,
   then the `retail` route.
2. **Colour lock:** albedo mean luminance within ±3 levels of retail, and each channel within ±4. All 7 prototype
   tiles pass at +0.1 to +1.5, except the grass at −2.8, which also passes [confirmed]. B-coast's sand (−17) is
   exempt: it is P-LOOK's intended golden tint.
3. **In-game luminance** at the tile's spot, Medium, noon: within −3 levels of today's shot (the AO check). On a fail,
   aoScale steps down by 0.1. The spot list includes a **coast-filler spot** for oaho_dust_earth06: making it hero
   (D6) gives it Medium ORMH for the first time on 69% of the coast filler, the same AO darkening risk.

Plus the SDXL gate that already exists for SDXL-routed tiles: PSNR, block shift, mean colour within 3 levels, and the
seam ratio [confirmed: TEXPIPE §3.4a].

What "painterly" means is set by retail, and every gate compares against retail. Nothing here pushes toward
photographic textures, and there are no prompt-generated replacements this wave (TEXPIPE §5 keeps them for later).

---

## 4. Repetition from the game camera

### 4.1 What the camera sees [confirmed arithmetic]

The game camera is an ArcRotate with `fov 0.85`, `beta 1.1` and `radius 9` (`apps/game/src/screens/world.ts`
121–128). At the player's feet the screen holds about **132 px per metre across** and 60 px/m in depth. A tile at
Medium's 512 (64 px/m) is therefore magnified about 2× across the near ground. At High's 1024 tier (128 px/m) it
is close to 1:1.

Beyond about 18 m from the camera, 512 is enough. So the remaster's sharpness matters **within about 10 m of the
player**, and repetition matters **from about 15 m out**.

The 8 m period shows: the paving medallion repeats every 8 m in the wide road shot (`ba_tuned_wide.jpg`, road row)
[confirmed: by eye].

### 4.2 What RENDER already has

- **The detail layer** (RENDER §6.2 item 5): a procedural 3-layer array, 1.5 m period, 170 px/m, fading in from
  25 m to 5 m. It is on High and Ultra.
- **Anti-tiling** (item 6): a second albedo tap at a rotated 0.73× period on the first layer, blended by noise. It
  is on Ultra only [confirmed: `render/quality.ts` presets, `terrain-plugin.ts` `SRO_T_DETAIL` and `SRO_T_ANTITILE`].

### 4.3 Decision: both on Medium and High

Measured in game (dirt spot, wide camera, WebGPU Medium, 300 frames each, A/B/A/B with the GPU lock):

| Run | GPU p50 (ms) | Frame p95 (ms) |
|---|---:|---:|
| Medium today | 1.19 | 6.3 |
| Medium + detail + anti-tiling | 1.32 | 5.6 |
| Medium today | 1.26 | 7.9 |
| Medium + detail + anti-tiling | 1.13 | 5.9 |

**The difference is within noise** [confirmed: the in-page A/B, `antitile_ab.jpg`]. The machine was busy with the
wave-11 build, so LAB-12 re-measures it on a quiet machine. The look: the wide shot's dirt pattern repeats less
regularly with anti-tiling on [likely: by eye].

- **Units:** the detail layer takes one texture unit and anti-tiling none (it reuses the tile array). Medium's
  terrain set stays under WebGL2's 16 units: `terrainUnits` is 8 + ORMH + detail + wet + ripples + shelter + coast
  field = **14 at most** on Medium (no fog ring, no layer normals, no tier, no cloud shadows on Medium) [confirmed:
  `terrain-plugin.ts` `terrainUnits` against the medium preset; `material-budgets.test.ts` checks it]. That test file
  is being edited by the wave-11 build (uncommitted in the working tree), so TT-Q adds its rows after wave 11 commits.
- **Paving opts out of anti-tiling.** A rotated blend smears a regular joint grid. The class table cannot carry this:
  the layer map holds one of six surface classes per layer, and paving (`c_marble_jang_*`) shares `stone` with the
  rock (wc_stone_don_*) and the stone-named field soils (c_stone_jinfild_*, c_stone_hmfld_*) [confirmed: `classes.ts`
  `terrainSurfaceClass`, `TERRAIN_SURFACE`]. A stone-wide opt-out would take anti-tiling off 3.8% of the fields of
  rock. So TT-Q adds a **no-anti-tile bit** (64) to the layer-map alpha byte (`128 + class + 64`, still ≤ 255 and
  still ≥ 128 for the "no layer" test), set in `terrain.ts` from the tile name (`/marble|pave|brick/`), and masks it
  (`& 63`) in every reader of that byte: `terrain-plugin.ts` (both languages), `shaders.ts` (the Classic layer chunk's
  `sroClass`) and `classes.ts` `surfaceFromAlpha` [likely; lane TT-Q]. Tiles painted with the world editor carry the
  bit automatically (it follows the tile).
- **Anti-tiling on High reads the 512 base array.** The second tap samples `sroTiles` even when the layer's first tap
  came from the 1024 tier plane (`sroTilesHi`), so in the noise blobs (up to 60% weight) High's near ground would mix
  in the 512 texels [confirmed: `terrain-plugin.ts` `SRO_T_ANTITILE` block]. Ultra has the same mix today. TT-Q makes
  the second tap read `sroTilesHi` for layers below the tier range under `SRO_T_TIER` (same unit, no new texture).
- **Mac projection:** two extra samples per terrain pixel come to +0.2–0.4 ms on an M1 at Retina 0.75 [projected].
  Inside the 8+ ms Medium has spare (wave10/budgets.md).

### 4.4 Not this wave

A macro-variation map (a low-frequency, world-space colour and roughness variation layer) would need a new texture
and a new seam in the terrain plugin. Anti-tiling plus the lightmap's large-scale variation are judged enough
[decision]. It is deferred.

---

## 5. Tiers per preset and the runtime path (TX-R, existing)

### 5.1 What each preset samples [confirmed: `pbr/maps.ts` `tileMaps`, `stream.ts` `tileSetup`, measured planes]

| Preset | Base albedo array (80/96 layers) | Set planes (depth = min(48, set tiles)) | Files per set tile |
|---|---|---|---|
| Low (Classic) | retail 256/512 | none | none (the Low guard) |
| **Medium** | the set's 512 tier (de-lit, remastered) | ORMH 256² (hero sets) | albedo@512 + ao/rough/height@512 ≈ 146 KB |
| High, WebGPU (> 16 units) | the 512 tier | normal 512², ORMH 512², **tier albedo 1024²** | + albedo@1024, nx/ny@512, ao/rough/height@1024 ≈ 504 KB |
| High, WebGL2 (16 units) | the 512 tier | normal 512², ORMH 256² | ≈ 206 KB |
| Ultra | as High (TIER_SIZE is 1024) | as High | as High |

These were measured in the preview [confirmed: `atlas.planes`]:

- Medium: albedo 512² × 96, ORMH 256² × 27;
- High WebGPU: albedo 512² × 96, normal 512² × 27, ORMH 512² × 27, tier 1024² × 27.

The set count of 27 is today's 20 plus the 7 prototype tiles. The per-preset byte figures are the mean of the 7 tuned
sets [confirmed: `bytes-tuned.json` and the files].

### 5.2 Changes (lanes in §12)

1. **Every B3a and B3b tile is `hero: true`** in `overrides.json` (data), and so are the three used B-coast sets that
   are not hero today (oaho_dust_earth06, c_stone_hmfld_02, asiaminor_sand_02; §1.1). Hero sets get their maps on
   Medium and High (`wantsMaps`). B3c stays non-hero: base albedo only, in every preset. Every B3 set is encoded with
   all its maps, so flipping `hero` later is an index-only change.
2. **The set range admits hero tiles only.** In `stream.ts` `tileSetup`, `sets.has(id)` becomes "has a set with maps
   under the policy" (`set.ormh || set.normal`, which under Medium's and High's `maps: 'hero'` policy is exactly the
   hero sets, so no new field is needed) for `sets`, `tier.has` and the plane depth. That depth becomes min(48,
   such sets) [confirmed: `maps.ts` `tileMaps` returns null maps for a non-hero set under `maps: 'hero'`].

   B3c tiles still swap in their remastered base albedo: the upgrade path's `has` stays "any set". The windows over
   48 then drop from 37 to 2 on Medium and from 70 to 12 on High at the load radius, and from 110 to 29 at the
   unload radius (§1.3) [confirmed: `windows.ts`, `windows-unload.ts`].
3. **No plane growth (fact-check: the first draft's growth item is dropped).** The draft grew the set planes from 32
   to 48 layers to save about 134 MB on High WebGPU in "median windows". That saving does not exist for real players:
   the planes never shrink, everyone starts in town, and the town window alone holds 43 (Medium) and 48 (High) hero
   tiles at the load radius and 50 at the unload radius [confirmed: §1.3]. Growth would only add code (re-filling
   layers 32–47, which non-set tiles may already hold, with neutral maps and resized retail tiles) and a hitch on the
   first walk through town. The planes are allocated at min(48, hero sets) once, as `tileSetup` does today.
4. **Importance order inside the range (placement time only).** A tile's layer can never move while a region
   references it (the region's layer map is written at commit) [confirmed: `tile-atlas.ts` header], so "a better tile
   takes the next freed layer" is not possible once a lesser tile holds it. TT-R instead **reserves the last 8 range
   layers** for hero tiles at or above the median cover: a lower-cover hero tile that finds only reserved layers free
   takes the overflow (512 base, neutral maps). The cover comes from a `cover` number that TT-B writes into the set:
   an additive, optional `PbrSet` field [confirmed: `format.ts` `validateSet` checks known fields only and rejects
   unknown keys only inside `params`]. Cut-able (§13).
5. **No tier change on Medium.** Medium keeps the 512 base. A 1024 tier on Medium would cost +268 MB RGBA8 for 48
   layers, or +67 MB as BC7. Medium's near-ground gap is closed by the detail layer instead (§4.3).

### 5.3 The editor seam (WORLD_EDITOR §4.3)

- The editor's paint palette is the 108 export tiles, shown with their remastered 512 albedo.
- Painting can bring a tile into a window where it was not before, which moves the §1.3 numbers. TT-R's range rule
  (hero only, importance order) handles that without new code.
- Painting a B3c (non-hero) tile over a large area would show it with albedo only. WORLD_EDITOR's Publish checks
  therefore flip `hero: true` for any tile whose cover reaches 0.1% after the edit: an index-only change, since every
  B3 set carries all its maps (§5.2 item 1) [decision].
- A retail tile that is not among the 108 is out of scope this wave [decision]. Adding one later means a local texpipe
  run for that tile before Publish (WORLD_EDITOR's checks).

---

## 6. Presets and budgets (WAVE_PLAN6 §5 format)

### 6.1 What the wave adds per preset

| Preset | Terrain textures | Terrain shading |
|---|---|---|
| Low (Classic) | unchanged (retail; the Low guard) | unchanged |
| Medium (default) | every tile's remastered 512 albedo; ORMH for the 63 hero tiles | + detail layer, + anti-tiling (paving excluded) |
| High | + normal and the 1024 tier for hero tiles | + anti-tiling |
| Ultra | as High | unchanged (it already has both) |

### 6.2 Budgets and honest costs (dev PC = Ryzen 5 9600X + RX 9060 XT; 1080p)

Baseline: wave10/budgets.md (the polish re-bench, Medium WebGPU worst p95 6.3 ms without bots) [confirmed]. Texture
VRAM figures are RGBA8 with mips (5.33 bytes per texel) from the measured plane sizes.

| Preset | Frame p95 delta (dev) | GPU delta | Mid desktop | Laptop / M1 (Medium) | VRAM added | First entry to town (download) | Whole area, one walk |
|---|---|---|---|---|---|---|---|
| Low | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Medium** | ≈ 0 (texture swaps are upload jobs inside the stream budget, §6.3) | detail + anti-tiling ≈ 0 (arm means equal, 1.225 ms; noise ±0.07 ms; WebGPU only) [likely] | ≈ +0.1 ms [projected] | +0.2–0.4 ms GPU at Retina 0.75 [projected] | **+9.8 MB** (ORMH plane 20 → 48 layers × 0.35 MB) [confirmed arithmetic] | **+4.3 MB** (≤ 30 new set tiles × 146 KB) | +9.7 MB (43 new hero tiles × 146 KB + 45 B3c × ≈ 75 KB) |
| High, WebGPU | ≈ 0 | anti-tiling ≈ +0.05 ms [projected from §4.3] | ≈ +0.1 ms | not the target | **+235 MB** at 48 layers (8.39 MB/layer: tier 5.59 + normal 1.40 + ORMH 1.40); every High WebGPU player pays it (the town window needs 48; no growth, §5.2) | **+20 MB** (≤ 40 × 504 KB) | +25 MB (43 × 504 KB + 45 × 75 KB) |
| High, WebGL2 | ≈ 0 | as above | — | — | **+49 MB** (1.75 MB/layer) | +8.2 MB (≤ 40 × 206 KB) | +12 MB |
| Ultra | as High | — | not offered | not offered | as High | as High | as High |
| Deploy (server disk and the first push) | | | | | | | **≈ +165 MB** (88 × 1.85 MB, all tiers) [projected from the 7 tuned sets] |

What the table means:

- **Medium, the default, gets every tile remastered for ≈ 10 MB of VRAM and ≈ 4 MB on first entry.** Its G1 headroom
  (8+ ms without bots; 3.0 ms in the worst scene, WebGPU crowd + 20 jumping bots at 13.7 ms p95) is untouched: the
  wave adds texture data and two GPU samples per terrain pixel, no CPU work per frame [confirmed baseline:
  wave10/budgets.md polish re-bench; projected delta].
- **High is already over 16.7 ms in one bench scene** (WebGPU crowd + 20 bots: 18.8 ms p95 at the wave-10r gate, a
  CPU-bound scene) [confirmed: wave10/budgets.md bench table]. Nothing here adds CPU time per frame, so this wave
  neither causes nor fixes it; G-TT holds High to "no worse".
- **High on WebGPU carries the real cost: +235 MB** for every player, because the set planes are allocated 48 deep
  once there are 48 hero sets (§5.2). Today's High texture VRAM is about 1,017 MiB at the plaza; this takes it to about
  1,240 MiB. That fits the friends' gaming GPUs (6–8 GB) [likely]. On an Apple Silicon Mac, High on WebGPU takes the
  tier plane only when the adapter reports more than 16 texture units [confirmed: `stream.ts` `tileSetup` `units > 16`];
  Macs default to Medium.
- **KTX2 would cut the High set planes to about a quarter.** BC7 at 1 byte per texel puts 48 layers at about 100 MB
  instead of 403 MB [projected]. It needs TP-K's compressed array upload wired into `tile-atlas.ts` (it exists in
  `texture-compressed.ts` but is unwired) and a KTX2 encode of 63 × 3 planes (albedo tier, normal, ORMH). That is not justified while High fits, so
  it is TT-K, optional and cut first.
- **First-visit wait:** +20 MB on High at the host's upload is about 8 s at 20 Mbit/s [projected], hidden by the
  progressive swap: retail tiles commit first and the sets swap in at the lowest priority (TEXPIPE §6.4).

### 6.3 Per-lane budgets (dev PC, 1080p, the GPU lock for every in-browser timing)

| Lane | Budget |
|---|---|
| TT-B | the batch ≤ 30 min CPU+GPU without SDXL; DT-2 ≤ 2.5 h; every set passes or is noted against §3.2's gates |
| TT-R | a set-tile upgrade job ≤ the stream frame budget (4 ms Medium, 5 ms High; 1024² tier layer = 1 job with worker mips, TEXPIPE §6.3); no frame > 16.7 ms walking town → fields on Medium |
| TT-Q | Medium detail + anti-tiling ≤ +0.15 ms GPU at the dirt and plaza spots (quiet machine); 0 new draws; WebGL2 units ≤ 16 |
| Terrain total (G-TT) | Medium p95 at plaza, fields and meadow within +0.3 ms of the wave-11 gate; High WebGPU texture VRAM at the plaza ≤ the wave-11 gate's figure + 250 MiB on the same method (the `bench.js` estimate moves ±100 MiB with what was streamed, §8.4, so the plane arithmetic is the primary check) |

---

## 7. The WebGL2 far-terrain blotches (GF-R's, coordinated)

- **Cause and fix: done.** P-LOOK, in the wave-10 polish commit 96b1149, found that on WebGL2 the terrain arrays'
  given mip levels were skipped. The map planes then sampled black past level 0: AO 0 and roughness 0, which made
  black hills and black far fields. The fix uploads the full chain (`textures.ts` `uploadTextureLayer`) [confirmed: the
  commit's diff and comment, and wave10/budgets.md "the WebGL2 texture-array mip upload fix"]. The polish gate's
  WebGL2 shots show no blotches [confirmed: NIGHT_LOG, the polish-gate decision line after the 13:10 row].
- **GF-R (wave 11) verifies it** with a WebGL2 shot of the user's spot, and owns any remaining cause
  (WAVE_PLAN7 §6.1). This spec does not repeat the diagnosis.
- **Why this wave must care.** B3 puts all 63 hero tiles on the given-levels path (the ORMH plane on every PBR preset,
  the normal plane on High and Ultra), where today only 20 are. TT-R therefore:
  1. keeps the existing WebGL2 regression test green: `packages/world-render/test/p-look.test.ts` already drives
     `uploadTextureLayer` with a WebGL2-like fake engine (`mipLevelCount: 1`, `generateMipMaps`) and checks that given
     levels are uploaded [confirmed: the test's "WebGL2: a texture-array layer's given levels are uploaded" block].
     TT-R adds only a `tile-atlas` test that the hero-only range's map and tier planes are created with mips, so
     every hero layer goes down that path;
  2. starts only after GF-R's verdict;
  3. adds a user check: the far fields on `?engine=webgl` at Medium after B3 (§11).

---

## 8. Prototype (run 2026-10-01)

### 8.1 The tiles

- grass: c_grass_hmfld_04;
- dirt: c_dust_hmfld_01;
- road: c_marble_jang_07_1, the paved road east of the walls, 5.9% of the near ring;
- rock: wc_stone_don_08;
- field soil: c_stone_jinfild_04 in game. c_dust_hmfld_02 was processed first, but its patches are now lake bed, so
  it appears in the texture sheets only;
- moss / forest floor: c_dust_swmp_07.

All seven are B3a tiles.

### 8.2 Method

- **Pipeline.** The real `@sro/texpipe` functions were called from `run.ts`, with outputs in
  `work/tmp/terrain-tex/{texpipe, texpipe-tuned, pbr-gan, pbr-tuned}`. TP-U ran under `work/tools/gpu.lock` through
  `locked.sh`. DT-2 was started with its own lock handling and `start_comfyui.sh`. It waited for headroom for about 45 min (§2.1). Headroom appeared just as the session
  ended: the stage took the lock and was stopped before ComfyUI started, and its lock was removed.
- **Variants:**
  - `gan`: defaults plus B1's paving maps;
  - `tuned`: the §3.2 painterly rule with aoScale 0.4.
- **In game.** The polish production bundle (96b1149, copied to `tools/dist`) ran on a private `vite preview`
  (:5631). An overlay middleware served the 7 sets and a merged index (`tools/tt.vite.config.ts`), so `work/out` was
  never touched. It ran against a private game server (:7631) on a **fresh temporary data folder** with a throwaway
  GM test account (`tools/harness.ts`), never `work/server/game.db`. Both were stopped afterwards.
- **Shots.** One browser tab, 1920×1080 viewport emulation, a timer pump, WebGPU, Medium, noon pinned on the client.
  Each of the 6 spots was shot with the game camera and a wide framing, in the order before → gan → tuned. High was
  shot before → tuned.

### 8.3 Images

| File | What |
|---|---|
| `work/tmp/terrain-tex/ba_tuned_game.jpg` | **the before/after sheet**: Medium, game camera, 6 spots, full frames and 1:1 crops (today vs the tuned remaster) |
| `work/tmp/terrain-tex/crops_before_gan_tuned.jpg` | 1:1 ground crops: today, the GAN route, tuned |
| `work/tmp/terrain-tex/ba_tuned_wide.jpg` | the same at the wide framing (repetition) |
| `work/tmp/terrain-tex/ba_tunedhigh_game.jpg` | High (1024 tier, normals, triplanar): today vs tuned |
| `work/tmp/terrain-tex/antitile_ab.jpg` | Medium with and without detail + anti-tiling |
| `work/tmp/terrain-tex/tex-sheet.png` | texture sheet: retail, GAN, tuned, SDXL (empty: not run), 512 and 1024 tiers, 3×3 repeat |
| `work/tmp/terrain-tex/pbr-sheet-tuned.png` | TP-P's contact sheet: retail, upscaled, albedo, normal, ORMH, height, lit, wet |
| `work/tmp/terrain-tex/unremastered_top40.png` | the 40 most-seen tiles without a set |

### 8.4 Results [confirmed unless tagged]

- **Visible change at Medium.**
  - Dirt, rock and moss change clearly.
  - Paving changes little, because the spot is mostly in a wall's shadow.
  - Grass is invisible under the grass field.
  - The field-soil spot's crop is dominated by an already-remastered neighbour tile. Its jinfild_04 band is the grey
    bank, and the crop numbers are identical across variants.
- **At High** the 1024 tier and the normals make rock and moss read crisp and 3D (`ba_tunedhigh_game.jpg`). High's
  tree shadows cover the dirt and field-soil spots at noon.
- **Grain retention and colour at the 512 tier** (fine-detail energy against retail; albedo luminance delta):

| Tile | GAN: grain, Δlum | Tuned: grain, Δlum |
|---|---|---|
| c_grass_hmfld_04 | 115%, −2.8 | 115%, −2.8 |
| c_dust_hmfld_01 | **29%**, +1.4 | 46%, +1.3 |
| c_marble_jang_07_1 | 66%, +1.2 | 66%, +1.2 |
| wc_stone_don_08 | 87%, +1.3 | 86%, +1.5 |
| c_dust_hmfld_02 | 53%, +0.9 | 61%, +1.0 |
| c_dust_swmp_07 | 97%, −0.6 | 93%, +0.1 |
| c_stone_jinfild_04 | **42%**, +1.4 | 48%, +1.5 |

  B1/B-coast sets for reference: median 70%; c_dust_hmfld_03 22%, oaho_dust_earth06 27%, c_stone_hmfld_01 45%.
- **In-game luminance at the dirt / moss crops:** today 70 / 77, GAN 63 / 67, tuned 64 / 69. Hence aoScale 0.25 for
  the build (§3.2).
- **VRAM.**
  - The Medium ORMH plane grew from 20 to 27 layers with the 7 sets: +2.4 MB.
  - High WebGPU planes: 27 layers × 8.39 MB.
  - The texture-cache estimates (`bench.js` `vram`) varied by ±100 MiB with what the session had streamed, so the
    plane arithmetic is the number used [confirmed].
- **Download per set tile:** Medium 146 KB, High WebGPU 504 KB, High WebGL2 206 KB. All tiers come to 1.85 MB per tile
  (tuned) and 1.97 MB (GAN) [confirmed: files].
- **Medium detail + anti-tiling:** within noise (§4.3).

---

## 9. Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | All 88 unremastered tiles go through the existing pipeline this wave (B3a, then B3b, then B3c) | the user's "all terrain textures"; no new code; ≈ 20 min plus SDXL |
| D2 | SDXL (DT-2) only on the 10 B3a paving, rock and moss tiles; the 8 gritty B3a soils go GAN + the painterly rule (fact-check) | its detail is sub-texel at Medium's 512; grass is hidden under the grass field; B1's SDXL soils kept only 21–54% of their grain |
| D3 | The painterly ground rule for soil and rock (aiMix 0.5, aoScale 0.25, normalScale 0.6, delight 0.5); paving keeps B1's soft maps | the prototype measured lost grain (29–42%) and AO darkening (−6 to −10 levels) with the defaults |
| D4 | Three review gates: grain ≥ 60%, albedo ±3 levels, in-game −3 levels; stepped fallbacks down to the `retail` route | they keep the SRO identity measurable instead of by taste |
| D5 | Retune of the existing sets that fail D4's grain gate: c_dust_hmfld_03, oaho_dust_earth06, c_stone_hmfld_01 (and c_dust_fld_01 if the pinned gate fails it) | 22%, 27%, 45% today (fact-check re-measure 21%, 17%, 41%; c_dust_fld_01 54%); c_stone_hmfld_01 is 3.5% of the fields |
| D6 | B3a + B3b and the three used non-hero B-coast sets are hero (63 hero tiles); B3c is albedo-only; the editor's Publish flips a tile hero once it is painted past 0.1% | maps where tiles are seen; the long tail costs no set-range layers; oaho_dust_earth06 alone is 8.5% of the fields |
| D7 | The set range admits hero tiles only ("has maps under the policy"), with the last 8 range layers reserved for above-median-cover tiles | windows over 48 drop from 37/70 to 2/12 (Medium/High) at the load radius and from 110 to 29 at the unload radius; layers never move, so importance can only act at placement |
| D8 | (fact-check, reversed) No plane growth: the set planes are allocated at min(48, hero sets) once, as today | the town window, where everyone starts, already needs 43–50 hero layers, and planes never shrink, so growth saves nothing and adds code and a hitch |
| D9 | The detail layer and anti-tiling on Medium; anti-tiling on High with its second tap on the tier plane; paving opts out through a no-anti-tile bit in the layer-map alpha | the near-ground blur and the 8 m repeat, measured within noise; the class table cannot tell paving from rock |
| D10 | No 1024 tier on Medium; no KTX2 for terrain this wave (TT-K optional, cut first) | Medium +10 MB, High +235 MB both fit; KTX2's 4× saving is not needed yet |
| D11 | Per-family SDXL prompts in `overrides.json` (moss, rock; field soil kept for later) | the class prompt calls every soil a "dirt road" and the stone-named soils "grey stone" |
| D12 | The editor palette = the 108 export tiles, remastered; no new retail tiles this wave | keeps the B3 inventory closed; a tile import needs its own run |
| D13 | TT-R starts after GF-R's WebGL2 verdict, keeps `p-look.test.ts`'s given-levels test green and adds a range-depth test | B3 puts every hero tile on the path that blacked out far terrain; the upload test already exists |
| D14 | No macro-variation layer this wave | it needs a new plugin seam; anti-tiling plus the lightmap are enough for now |
| D15 | 0 Meshy credits for terrain | Meshy cannot make seamless tiles; the user's terrain-goes-local rule |

## 10. What the user must provide or approve

- **Nothing to download.** Real-ESRGAN, ComfyUI with SDXL and ControlNet-Tile, basisu and the KTX2 decoders are all
  installed [confirmed: TEXPIPE §9 and §12].
- **GPU time:** about 0.75–2.5 h of SDXL for the 10 B3a paving, rock and moss tiles, run on the dev PC when no other
  heavy GPU work runs. The default is overnight, holding the GPU lock (the `mkdir` must succeed before anything else
  runs; `locked.sh` is the pattern).
- **No upload outside the user's own machines.** The ≈ 165 MB of new sets go to the mini PC with the normal deploy
  (over Tailscale); nothing is sent to Meshy or any other service.
- **A look at one overview sheet** before B3 ships: today versus the remaster at 6 spots, Medium. The default is that
  the plan's gates decide and the user sees the sheet with the wave's release shots.

## 11. Open questions (each with the default that will be used)

| # | Question | Default |
|---|---|---|
| Q1 | SDXL for B3a: is it worth 0.75–2.5 h for a gain seen only at High and Ultra near the camera? | run it on the prototype's road, rock and moss tiles first; keep it per tile only where the High crop is visibly crisper and the gates (grain included) pass, else GAN |
| Q2 | Painterly rule strength (aiMix 0.5 vs 0.3) | 0.5, stepped per tile by the grain gate |
| Q3 | Anti-tiling on paving | off (the no-anti-tile layer-map bit) |
| Q4 | Grow the set planes, or allocate 48 at once? | allocate at once (D8, reversed by the fact-check) |
| Q5 | Re-run all of B1 under the painterly rule, not only the failing sets? | only the failing ones (D5: three, maybe four); the rest pass the gates |

## 12. Lanes

Effort: S ≈ ½ day, M ≈ 1–2 sessions, L ≈ 3+.

| Lane | Owns (files) | Seams it uses | Tests | User check | Effort |
|---|---|---|---|---|---|
| **TT-B** the batch | `content/texpipe/overrides.json` (B3 entries: hero, routes, prompts, the painterly rule, notes); `packages/texpipe/src/terrain-spots.ts` (new, from `spots.ts`); the three gates in `review.ts`; the review's terrain sheet and repeat; outputs in `work/out/pbr/tile2d/**` + index | the texpipe CLI; DT-2 with the GPU lock and `start_comfyui.sh`; the preview overlay method of §8.2 for the in-game pairs | `terrain-gates.test.ts` (grain ratio on a synthetic noise tile, colour lock, the fallback steps); the inventory test counts 108 tiles and 88 B3 sets after the run; `validatePbrIndex`; every file exists | the 6-spot overview sheet at Medium | M (+ GPU hours) |
| **TT-R** runtime range | `packages/world-render/src/stream.ts` (`tileSetup`: the "has maps" range rule and depth), `tile-atlas.ts` (the reserved last 8 range layers for above-median cover); optional `cover` in `packages/texpipe/src/format.ts` and the runtime `PbrSet` reader (additive) | TX-R planes; GF-R's verdict first | `tile-atlas.test.ts`: hero-only range, a non-hero set takes a layer above the range but still gets its set albedo, a below-median tile never takes a reserved layer, the planes are created mipped at min(48, hero); `p-look.test.ts` stays green; the Low guard | walk town → fields on Medium and High; the far fields on `?engine=webgl` | S–M |
| **TT-Q** Medium shading | `packages/world-render/src/render/quality.ts` (medium: detailLayer, antiTiling; high: antiTiling); the no-anti-tile bit: `pbr/classes.ts` (`surfaceAlpha` / `surfaceFromAlpha` with the bit and its mask), the one `layerData` line in `terrain.ts`, the `& 63` mask in `shaders.ts`' layer chunk and in `terrain-plugin.ts`; the anti-tiling second tap on `sroTilesHi` under `SRO_T_TIER` | RENDER §6.2 items 5–6 | `material-budgets.test.ts` (≤ 16 WebGL2 units on Medium: 14 expected), after wave 11 commits its edits to that file; the plugin define tests; `pbr-classes.test.ts` (bit round trip, class unchanged for every tile); the paving opt-out; the Classic `seams-classic` test | the plaza paving and a dirt field, wide camera | S–M |
| **TT-K** (optional) KTX2 terrain | `packages/texpipe/src/ktx2.ts` terrain run; the wiring of `texture-compressed.ts` into `tile-atlas.ts` | TP-K, `engine.ts` GPU features (lead) | BC7/ASTC layer upload round trip; VRAM ≤ ¼ | High VRAM in the perf overlay | M–L |
| **LAB-12 (terrain rows)** | the bench scenes: dirt spot wide, road wide, plaza | — | G-TT (§6.3) on a quiet machine, both backends | — | S |

**Order:** TT-B (overrides and run) → TT-Q → (GF-R verdict) → TT-R → LAB-12 → (TT-K if kept).

**Seams no lane crosses:** TT-B writes no code outside `packages/texpipe`; TT-R does not touch `grass/**` or
`textures.ts`; TT-Q edits only the quality rows, the anti-tiling block and the layer-map bit (its lines in
`classes.ts`, `terrain.ts`, `shaders.ts` and `terrain-plugin.ts`). Wave 11 has uncommitted edits in
`world-render/src/grass/cull.ts`, `town/**` and `material-budgets.test.ts` [confirmed: `git status`]; no TT lane
starts before the wave-11 commit.

## 13. Scope-cut order (cut from the top)

1. TT-K (KTX2 terrain arrays).
2. DT-2 on B3a: the 10 paving, rock and moss tiles go GAN with the painterly rule.
3. The reserved range layers (importance order): hero-only stays.
4. Anti-tiling on High (with it goes the `sroTilesHi` second tap).
5. B3c: the long tail keeps its retail tiles. That leaves 0.5% of the fields retail.
6. The paving bit: anti-tiling then stays Ultra-only, as today, and Medium gets only the detail layer.
7. The detail layer on Medium.

Plane growth is no longer in the list: the fact-check dropped it (D8).

The hero-only range (D7), the painterly rule (D3) and the B3a+B3b run are never cut: they are the user's request.

## 14. Files (scratch, `work/tmp/terrain-tex/`)

| File | What |
|---|---|
| `coverage.ts`, `coverage.json` | per-tile cover, regions, remaster state, window statistics |
| `windows.ts` | load windows: all tiles, set tiles, hero-only |
| `windows-unload.ts` | fact-check: the same at the unload radius |
| `grain_check.py`, `grain_b1.py` | fact-check: the grain and colour re-measure of the prototype tiles and every existing set |
| `spots.ts`, `spots.json` | the game-camera spot finder (dry, flat, nearest town) |
| `run.ts` | the prototype driver (TP-U, DT-2, TP-P, TP-E, overlay index; variants gan and tuned) |
| `locked.sh` | waits for and holds `work/tools/gpu.lock`, and releases only its own lock |
| `tools/tt.vite.config.ts`, `tools/harness.ts`, `tools/dist/tt.js` | the private preview with the overlay, the private server, the page helpers |
| `sheet.py`, `ba.py` | the texture sheet and the before/after sheets |
| `shots/` | every in-game shot and the per-spot stats |
| `texpipe*/`, `pbr-*/` | the prototype's masters, caches and encoded sets (≈ 1 GB with the shots; delete after TT-B) |

## 15. Fact-check log (2026-10-01, adversarial review of this spec)

Every [confirmed] claim was re-derived from the code, the data or a re-run; the doc above is corrected in place.
What changed, and why:

| # | Claim in the first draft | Finding | Fix |
|---|---|---|---|
| F1 | Set planes grow 32 → 48 and save ≈ 134 MB on High WebGPU (D8) | The town window needs 43 (Medium) / 48 (High) hero layers at the load radius and 50 at the unload radius; everyone starts in town and planes never shrink [confirmed: `windows-unload.ts`] | D8 reversed; +235 MB is every High WebGPU player's cost; growth budget line and cut item removed |
| F2 | Hero-only range: 2 / 12 windows over 48 | True at the load radius only; regions stay to the unload radius (560 / 660 m): 29 windows, max 58 [confirmed: `windows-unload.ts`, `stream.ts`] | §1.3 rows added; overflow stated as a graceful loss of maps |
| F3 | "Importance order: a higher-cover tile takes the next freed layer" | A referenced tile's layer never moves (layer maps are fixed at commit) [confirmed: `tile-atlas.ts`] | Placement-time reserve of the last 8 range layers |
| F4 | 63 hero tiles = today's 20 + B3a + B3b | Only 17 of today's 20 are hero; oaho_dust_earth06 (8.5% of the fields, 69% of the coast filler), c_stone_hmfld_02, asiaminor_sand_02 are not [confirmed: `index.json`] | D6 marks them hero; a coast-filler spot joins the luminance gate |
| F5 | Paving opts out of anti-tiling through the class table | Paving shares the `stone` class with rock and the stone-named soils [confirmed: `classes.ts`] | A no-anti-tile bit in the layer-map alpha; TT-Q owns its four touch points |
| F6 | (not in the draft) | Anti-tiling's second tap reads the 512 base array even for tier-plane layers, diluting High's 1024 near ground [confirmed: `terrain-plugin.ts`] | TT-Q samples `sroTilesHi` there |
| F7 | Only c_dust_hmfld_03 and oaho_dust_earth06 fail the grain gate | c_stone_hmfld_01 (45% in the draft's own table; 3.5% of the fields) also fails; c_dust_fld_01 is borderline [confirmed: `grain_b1.py`] | D5 lists three (maybe four) |
| F8 | SDXL on the 18 non-grass B3a tiles | B1's SDXL soils kept 21–54% of their grain; SDXL refines the GAN master [confirmed: `grain_b1.py`] | SDXL on 10 paving / rock / moss tiles; ≈ 45 min, ≤ 2.5 h |
| F9 | The `retail` route keeps 100% of the grain | c_dust_fld_06 (retail route) keeps 76% after de-light and WebP [confirmed: `grain_b1.py`] | Wording |
| F10 | The tuned rule fixes the gritty soils | c_dust_hmfld_01 46% and c_stone_jinfild_04 48% still fail at aiMix 0.5 [confirmed: §8.4] | Stated in §0 and §3.1: the gate's fallback is the normal path for them |
| F11 | Grain numbers | The prototype's metric script is not in the scratch folder; a PIL re-measure moves them by up to 10 points, same verdicts [confirmed] | TT-B pins one implementation in `review.ts` and its test |
| F12 | Medium samples "roughness, AO and height" | Medium has no height blend or parallax [confirmed: `quality.ts`] | AO and roughness |
| F13 | Medium WebGL2 units "≤ 12" | 14 with detail and shelter [confirmed: `terrainUnits`] | Still ≤ 16 |
| F14 | Medium GPU delta "≤ 0.1 ms [confirmed]" | Two runs per arm on a busy machine, WebGPU only | [likely]; LAB-12 measures both backends |
| F15 | TT-R adds the WebGL2 given-levels test | It exists: `p-look.test.ts` [confirmed] | Keep green; add a range-depth test |
| F16 | Grass tiles hidden "on every modern preset" | Not on Grass: Low (the Mac / iGPU default: field to 35 m) or Grass: Off [confirmed: GRASS_FAR §1] | Wording; the no-SDXL-on-grass decision stands |
| F17 | TP-U 4.7 s per tile | That is Real-ESRGAN alone; the stage is 6.4 s per tile [confirmed: §2.1 numbers] | ≈ 10 min |
| F18 | (not in the draft) | High WebGPU crowd + 20 bots is already 18.8 ms p95 at the wave-10r gate [confirmed: wave10/budgets.md] | Stated; this wave adds no per-frame CPU |

Re-checked and correct as written: the coverage split (75.9 / 21.7 / 1.9 / 0.5% and the 20 / 22 / 21 / 45 counts),
the 108 tiles and their types, 414 regions with 107 synthetic, the load-radius windows (37 / 70, 2 / 12, town 46 /
56 / 43 / 48), the camera arithmetic (132 px/m across, 60 px/m in depth, 512 is enough beyond ≈ 18.6 m), the plane
sizes and VRAM arithmetic (0.35 / 1.40 / 5.59 MB per layer; +9.8, +235, +49 MB), the 1.85 MB per set and +165 MB
deploy, the WebGL2 mip fix in 96b1149, the override fields (`aiMix`, `aoScale`, `normalScale`, `delight`, `hero`,
`sdxl.prompt`), the unwired `texture-compressed.ts`, the installed SDXL and ControlNet-Tile checkpoints, and the clean
state after the prototype (no gpu.lock, nothing listening on :5631, :7631 or :8188).
