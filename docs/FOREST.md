# Forests: dense natural tree cover to the horizon (wave 12F, "Forests")

**Status (2026-10-02):** design and build plan, with a prototype on the dev PC. Nothing in `packages/`, `apps/`,
`content/` or `deploy/` was touched (the wave-12 build is editing them). Wave 12F builds **after wave 12 and before
wave 13**. Scratch, scripts and images: `work/tmp/forest/`.

The user's words, verbatim:

> Just like grass, where i said i wanted grass to fill the terrain and not leave batches of empty ness between them
> (which you figured it out and looks great), i want the same concept for tree's. I want the terrains to feel like a
> real environment, add more tree's, make it more dense than it is. Just make sure its batching the tree's to avoid
> heavy performance loss.

**The user delegated every decision.** Each choice below is the option this spec would mark "(Recommended)", written as
a decision with a one-line reason. Only what truly needs the user is in §10, each with the default used meanwhile.

**Tags.** **[confirmed]**: checked in the code, data, a test, a shot or a measurement of this pass, and the text says
which. **[likely]**: strong evidence, not proven. **[projected]**: computed from a measurement, not measured on that
setup. **[unknown]**: open, with the default. **[decision]**: a choice this spec makes.

**Fact-check (2026-10-02, same day).** This spec was fact-checked adversarially: every [confirmed] claim was
re-derived from the code (working tree of 2026-10-02 13:00–14:30 EDT), the export, the prototype's outputs and fresh
re-runs (`work/tmp/forest/factcheck/`: `place_edit.py` re-ran the pass and gave byte-identical rows; `zones.py`,
`zones2.py`, `nest_share.py`, `edit_locality.py`, `bands_species.py`, `skirt-worst.ts`). No GPU timing was run: the GPU
lock was free at 13:57 EDT but the machine was not quiet (CPU 34–52 % over 30 s), so the lock was not taken. The
corrections are **FF1–FF25 in §0.1**; every changed passage carries a "(fact-check)" note. The largest: the trunk layer
cannot be a trailing section of `nav.bin` (today's decoder rejects trailing bytes) and the client draws every move as one
straight segment, so the skirt is **server-side and its corners ride in an optional `via` list of the move** (FF1,
FF2); the realized forest
cores are **≈ 34 trees/ha, not ≈ 50**, because 88 % of the core lies inside a nest's spawn circle (FF5; the build now
ramps the thinning: ≈ 42/ha, +24 % trees); a view holds **6–11 tree species, not 5–8**, so forest draws are
**≈ 26–38 on Medium and 30–46 on High**, not ≈ 22–27 (FF7); High's range scale is **1.4**, not 1.25 (FF8).

**Sources read.** docs/TREES.md (Part W first: §W0–§W12, §WF), docs/BATCHING.md, docs/GRASS_LIFE.md (§3.2 the splat
rule, §3.3), docs/GRASS_FAR.md (all), docs/WORLD_EDITOR.md (§1, §3.1–§3.6, §4.5–§4.7, §6.2–§6.3, §7.2–§7.3),
docs/NAVIGATION.md (§1, §4, §6, §7, §11), docs/COAST.md (the sea mask, the field), docs/CLIMB.md (§1.1 the areas and
nests, §2.1 the bands), docs/TOWN_LIFE.md (the town box), docs/STORM_QILIN.md (the Thunder Seats), docs/HOT_SPRINGS.md,
docs/FISHING.md, docs/TOMB_DUNGEON.md (the door), docs/WAVE_PLAN8.md (the planning format, §5.5 the gates, §6.7 the
hunt). Code read (working tree, 2026-10-02, HEAD `3a5fb7c` "Wave 12 step 1" plus the wave-12 lanes' uncommitted
edits): `packages/world-render/src/trees/{index,bands,near-field}.ts`, `objects.ts` (`placeStatic`, `loadGlb`,
`placementMatrix`, S-SCALE), `packages/nav/src/{data,world}.ts` (`moveStraight`, `editInstances`, `NAV_MAX_LEGS`),
`apps/server/src/{ai,nav}.ts` (mob wander, `MeshNav`), `packages/convert/src/world/format.ts` (the SROT terrain bin),
`packages/convert/src/world/coast/field.ts` (the coast field channels), `content/trees/{library,swap}.json`.

**What was run** (all in `work/tmp/forest/`; Python 3.12 + numpy + Pillow, `pnpm tsx`, the Browser pane):

| What | Script / output | How |
|---|---|---|
| Survey: coverage by area, the masks | `common.py`, `survey.py` → `survey.json`, `masks.npz`, `survey-map.png` | the export `work/out/world/jangan-fields` (414 regions; terrain bins decoded, the native layers composited per 2 m cell), `nests.json` (825), `npcs.json` (46), `zones.json`, the coast field |
| Terrain tile census | `tiles_census.py` | the dominant tile per vertex over the 247 playable regions |
| Tree footprints in the nav | `nav-trees.ts` → `nav-trees.json` | `decodeNavData(nav.bin)`: every tree model's collision navmesh, its size and edge flags |
| The placement pass (whole map) | `place.py` → `forest.json`, `forest-stats.json`, `fields.npz` | seed `0x5F0E57`, 24 s for the whole 28 × 20-region grid [confirmed: `place.log`] |
| Maps | `maps.py` → `map-before-after.png`, `map-biomes.png` | 4 m per pixel over the playable rectangle |
| Walking checks | `walk_check.py` → `walk-check.json` | straight click chords, monster wander chords, route corridors, trunk gaps |
| In-game prototype | `lab/prep_lab.py`, `lab/vite.config.mjs` (private Vite on :5243), `lab/forest-lab.ts` → `shots/*.png`, `shots/*.json` | the real out-opt export through `loadWorld` (the game's defaults: PBR, batching, grass, life, sky); 6 prototype regions + the plaza; three modes: today, **merged** (the forest rows as carrier placements through the region batch) and **inst** (the forest rows as thin instances per species × tier × material, the design's batching) |
| The preview sheet | `sheet.py` → `forest-preview.png` (also Dropbox `wave12/forest-preview.png`) | before / after, game camera and aerial, plus the coverage maps |

The export was rewritten by the wave-12 build during this pass (its manifest went from 528 models / 24 swaps to 559 /
134 swaps at 14:47 UTC). The lab therefore serves a **frozen copy** of that manifest (`lab/manifest-base.json`) for
"today" and builds "merged" from the same copy, so before and after differ only by the forest. All 35 wave-12 species
are in it, so the stand-in trees are the new species where the swap covers them [confirmed: `lab/manifest-base.json`].

---

## 0. Summary

1. **Today the map is thinly wooded** [confirmed: `survey.py`]. The 247 playable regions hold **1,560 trees** on
   **7.8 km²** of dry land: **2.0 trees per hectare**, a median of 4 trees per 192 m region, **61 regions with none**
   and 127 with fewer than five. Even the named forests are thin: Yeoha's Forest 1.95 trees/ha, Lake Forest 2.0, the
   Tiger Mountains 1.3–1.9. Retail trees are few and huge (30–80 m tall, crowns 15–100 m wide), standing in rows along
   the roads. **43 % of the grassy, walkable, not-too-steep ground lies more than 20 m from any tree crown** (1.66 of
   3.87 km²): the "batches of emptiness" the user saw in the grass, now in the trees (`survey-map.png`).
2. **Placement: one seeded, deterministic pass in the converter** (§3) [decision]. It reads the terrain splat (a forest
   ground weight per tile: grass 1, hill dirt 0.8, swamp mud 0.6, rocky hill 0.35; roads, fields, paving, sand and
   water 0), slope, water, the coast's sea mask, low-frequency noise for a forest/meadow patchwork, the retail trees
   (new cover clusters around them) and the area (Yeoha's Forest and the Tiger Mountains are forests, the Grassland is a
   meadow with groves). It writes **forest cores** (70 trees/ha target), **irregular edges** (a noisy ramp, never a
   line), **groves and lone trees** in the meadows, **riverbank** trees, **mountain-slope conifers** and an
   **understory** of bushes, with min spacing per size class and exclusions for roads, paths, the town and its walls,
   nests, NPCs, places, beaches, cliffs, the Tomb doors, the Qilin's seats, the hot springs, the banks and the walking
   routes.
3. **The prototype pass on the real export** [confirmed: `forest-stats.json`; re-run byte-identical by the fact-check]:
   **+6,806 trees** and **+22,655 bushes** in the playable area (+446 trees in the scenery ring outside it), in 24 s.
   Canopy cover of the dry land **18 % → 35 %**; grassy walkable ground more than 20 m from a crown **43 % → 17 %**.
   *(fact-check, FF5)* Realized densities over the playable forest ground by zone: **cores ≈ 34 trees/ha** (125 ha),
   edges ≈ 22/ha, banks ≈ 22/ha, groves ≈ 29/ha, meadows ≈ 1.2/ha [confirmed: `factcheck/zones-base.json`]; the
   "≈ 50 / 31 / 12" of the first draft were buckets of the final target density (≈ 50/ha only on the 15 ha that keep
   the full target). 88 % of the core lies inside a nest's 40 m spawn circle, where the prototype halved the density
   (× 0.55). **The build ramps that thinning** (× 0.55 within 24 m of the nest centre, 0.7 to 32 m, 0.85 to 40 m):
   **+8,420 trees, +28,781 bushes, cores ≈ 42/ha, edges ≈ 28/ha, canopy 36.9 %, bare 15.9 %**, gaps still ≥ 3.0 m
   [confirmed: `factcheck/stats-ramp.json`, `zones-ramp.json`]. The busiest playable region holds 111 new trees and
   351 bushes with the prototype rule (23965, North-Tiger; 139 + 455 with the ramp, 24482); the 132 + 448 of the first
   draft is region 22942, in the scenery ring (FF12); the median forest region 23 trees (26 with the ramp). The clear
   gap between any two trunks is ≥ 3.0 m (p5 5.1 m).
4. **Walking: trunks block, but a click never stops at a forest trunk** (§4) [decision]. The walker is a straight chord
   that stops at the first blocking edge, with no slide and no path-finding (NAVIGATION §6). Measured on the prototype:
   **7.5 % of 30 m clicks and 15 % of 60 m clicks** started inside the new forest would hit a trunk, and 4.7 % of
   monster wander moves [confirmed: `walk-check.json`]. So trunks are **circles** in a small new server-side nav file
   (`nav-trunks.bin`; *fact-check, FF1*: not a section of `nav.bin`, whose decoder rejects trailing bytes) and the
   **server's** walker **skirts** them (the chord bends around the circle on the near side; deterministic, sqrt-only
   maths). *(fact-check, FF2)* The protocol's `MoveState` is one straight segment that every client interpolates
   linearly, so a skirted move carries its corners in a new optional **`via`** list that the clients' interpolation
   walks; clients need no trunk data and no skirt code. Retail tree footprints, which are blocked squares
   of 0.6–16 m (a willow's is 15.8 × 13.1 m) [confirmed: `nav-trees.json`], become trunk circles too (a cut item).
   Reachability: trunk gaps ≥ 3 m, no trunk on or within 2 m of a closed nav tile (the prototype left 321 on or within
   1.5 m of one, 4.7 %: a build rule now), every nest, NPC, place and route stays reachable, and (fact-check, FF15) the
   town's component may not **grow** when retail squares become circles (§4.4).
5. **Rendering: instanced per species and tier, never merged per tree** (§5) [decision; measured]. Merging the forest
   into the region batch (wave 12's path for the retail trees) was measured with the prototype's rows: resident tree
   geometry **29–55 MB → 187–348 MB** and tree triangles in view **≈ 30–100 k → 0.38–1.25 M** at the six views
   [confirmed: `shots/look_*.json`]. Instancing keeps one draw per species × tier × material whatever the tree count:
   **near** (< 40 m) joins wave 12's LOD0 overlay, **mid** (< 110 m) LOD1, **far** (< 180 m) LOD2 in one cut-out draw
   per species, and **beyond** a **canopy card ring** (one draw for every species, to the stream edge) over a **canopy
   carpet** tint and a baked canopy shade, with GRASS_FAR's noise on every hand-over so no edge is ever a line (Medium
   distances; High × 1.4). *(fact-check, FF10)* The band refill also culls its 16 m cells against the frustum, since a
   thin-instance set is otherwise drawn all around the camera.
6. **Cost** (§6). Instanced prototype at the Yeoha view (Medium, WebGPU; LOD2 to 400 m, the worst case without cards):
   **draws 41 → 93, forest triangles submitted ≈ 0.30 M (all around the camera: a thin-instance set is culled as a
   whole), CPU p95 1.0 → 1.7 ms** [confirmed: smoke run, busy machine, weather off]. *(fact-check, FF7)* Counted on the
   prototype's rows at the six lab views, a view holds **6–11 tree species** in F0–F2 (not 5–8), so the build draws
   **≈ 26–38 forest draws on Medium, 30–46 on High** (F0 counted as new overlay draws), **≈ 8 at the plaza (High 15)**
   [confirmed: `factcheck/bands_species.py`; the draws projected]; at ≈ 13–18 µs per draw that is ≈ +0.4–0.7 ms CPU.
   The GPU-locked quiet bench could not run in this pass (wave 12's LAB-12 held the lock for 2 h 14 min on a busy
   machine; at the fact-check the lock was free but the machine was not quiet): it is LAB-12F's, with the lab ready
   (§6.2, §6.3).
7. **Per preset** [decision]: **Low: nothing new** (retail placements only; the Low guard unchanged). **Medium and High
   draw every forest tree** (trunks are server-side, so a tree is never thinned on one preset and solid on another);
   they differ in bands (High × 1.4, the preset's `drawDistance`; fact-check, FF8), card reach (380 / 460 m),
   understory share (70 % / 100 %) and shadows (High: LOD1 casters within 60 m). **Download ≈ +1.2 MB** for the whole
   area (rows 0.22 MB, ≈ 0.27 MB with the thinning ramp; canopy shade ≈ 0.5 MB, card sprites ≈ 0.5 MB; the geometry is
   wave 12's 35 species, already downloaded) [projected].
8. **The editor**: the forest is a **layer** (a density brush per region, 0 = clear … 2 = double) plus **per-tree
   drops and moves by `(region, uid)`** in WORLD_EDITOR's `placements.json`, with stable uids per site
   (0xC000–0xCFFF trees, 0xD000–0xDFFF bushes). *(fact-check, FF14)* Forest drops and moves live in the forest layer's
   own `forest/edits.json`, not in `placements.json` (whose moves and drops are retail-only, and whose tree scale range
   0.85–1.15 cannot hold a forest tree). Publish re-runs the pass on the touched regions and rewrites their trunks in
   `nav-trunks.bin`, with the reachability checks (§3.9, §4.4).
9. **Build** (§7): seams first (F12-0), then the placement pass, the nav skirt, the forest renderer, the cards and
   carpet, the editor tools and the lab in parallel; a re-convert checkpoint; integration and the LAB-12F bench; a hunt
   with 14 lenses; fixers; a final gate; an independent verify. ≈ 9–11 agent-days.

![before / after](../work/tmp/forest/forest-preview.png)

### 0.1 What the fact-check corrected (2026-10-02)

| # | Claim as written | What the check found, and how | Fixed in |
|---|---|---|---|
| FF1 | `nav.bin` gains an optional trailing `trunks` section; "a reader that does not know the section ignores it (format version stays 1 with a section table entry)" | **There is no section table, and today's decoder refuses it**: `decodeNavData` throws on `totalBytes != length`, on a version other than 1 and on "N trailing bytes" (`packages/nav/src/serialize.ts`) [confirmed: code]. The client's chunks are `encodeNavData` of one region (`convert/src/world/nav.ts` `splitWorldNav`), the same codec. **Now:** the trunks are a separate **server-only** file `nav-trunks.bin` ('SRNT' v1, per region: count, then `u16 x, u16 z, u8 r` in region dm); `nav.bin`, `nav-objects.bin` and the chunks keep their format (FF2 removes the client's need for trunks) | §0, §3.1, §3.9, §4.1, §4.2, §7 |
| FF2 | "Protocol: none changes … both sides run the same `moveStraight` … other clients get the end point" | `MoveState` is `{from, to, speed, startedAt}`, one segment (`shared/src/protocol.ts`); every client interpolates it **linearly** (`apps/game/src/net/clock.ts`), the own client re-walks it straight (`heights.selfMove`), and the server's `livePoint` maps the straight-distance progress onto the legs (`apps/server/src/world.ts`) [confirmed: code]. A skirted walk sent as one move would draw every character **through the trunk** and put server and client up to ≈ 1 m apart mid-move. **Now [decision, fact-check]:** `MoveState` gains an optional **`via: Vec3[]`** (the skirt's corners, ≤ 16, validated like `to`); `clock.ts` interpolates along `from → via… → to` by path length, the server's `arrivalTime` uses the path length (its `livePoint` already walks the legs), and `heights.selfMove` re-walks each segment. Clients need no trunk data and no skirt code, so the V8 / JavaScriptCore agreement question disappears (the skirt runs on the server only). The fallback without a protocol field, a chain of straight moves (the next `move` at each corner's arrival), snaps a mover forward by ≈ speed × (tick + latency) at every corner [projected], so it is not the default | §0, §4.1, §7.1, §7.2, §7.5, §9 |
| FF3 | The skirt corner `W` | `W` runs away when the walker starts on a trunk's edge (after a click on the trunk) and clicks past its far side: corner 2.4 m from the centre and a 3.7 m detour for a 1.2 m step at a 2 cm gap, and up to ≈ 22 R at the code's 0.999 clamp [confirmed: `factcheck/skirt-worst.json`]. Random clicks: detour p99 0.20 m, max 0.37 m; lateral bend p50 0.38 m, max 1.06 m. **Now:** a corner farther than 2 R from the centre is replaced by two corners on the circumscribed square (constants, no trigonometry); a walker that **starts inside** a circle (a saved position from before the deploy, a knock-back) ignores that circle for the move | §4.1, §4.6 |
| FF4 | Each skirt leg "goes through the normal walker" | The walker caps a move at `NAV_MAX_LEGS` = 6 surface legs (`nav/src/world.ts`) [confirmed]. **Now:** each segment between corners is its own walker call with its own 6-leg budget; ≤ 8 skirts per click | §4.1 |
| FF5 | "Realized: core 49.6 /ha (18 ha), edge 31.4 (179 ha), banks 12.4 (47 ha)" | Those are buckets of the **final target density** (≥ 60: 49.9 /ha on 14.6 ha; 20–40: 31.0 on 166 ha; 5–20: 12.4 on 45 ha) [confirmed: `factcheck/zones-by-target.json`]. By zone on the playable eligible ground: **core 33.5 /ha (125 ha), edge 22.4 (96 ha), bank 21.6, grove 29.3, meadow 1.2** [confirmed: `zones-base.json`]. Cause: **83 % of the forest ground and 88 % of the core lie inside a nest's 40 m spawn circle** (825 nests, ≈ 1 per ha), where the density was × 0.55 [confirmed: `nest-share.json`]. **Now [decision, fact-check]:** the thinning ramps (× 0.55 within 24 m, 0.7 to 32 m, 0.85 to 40 m): +8,420 trees and +28,781 bushes, core 41.6 /ha, edge 27.7, canopy 36.9 %, bare 15.9 %, min gap 3.0 m [confirmed: `stats-ramp.json`, `zones-ramp.json`]. The fights keep their open 10 m core and the halved 24 m ring | §0, §3.4, §3.7 |
| FF6 | Scale byte `(v + 128) / 256`: 0.5..1.5; "scales below 0.5 failed the manifest's S-SCALE range in the stand-in (the forest file has its own range, 0.5–1.5)" | The pass's own scales go **below 0.5**: willow giants 0.30–0.50, swamp giants 0.45–0.75 (`place.py` `SCALE_OVERRIDE`); `codec.ts` clamped them to 0.5 [confirmed]. **Now:** `scale = (v + 64) / 256`, 0.25..1.25 (every class and override fits, 0.4 % steps) | §3.9, §3.10 |
| FF7 | "A view holds ≈ 5–8 tree species"; forest core ≈ 27 draws (F0 ≤ 4 + F1 10 + F2 6 + F3 1 + bushes 6), edge ≈ 22, plaza ≈ 10 | Counted per tier on the prototype's rows at the six lab views: F0 3–6, F1 5–8, F2 5–9 tree species (Medium); 6–13 behind the cards [confirmed: `factcheck/bands_species.py`]. The overlay adds 2 per species with a tree in band 0 (`near-field.ts`), 0 only if a retail tree of that species is already there. **Forest draws ≈ 26–38 on Medium, 30–46 on High; plaza ≈ 8 / 15** [projected from the counts]. The risk row's "≤ 4 tree species per biome" contradicted D-F13 (the broadleaf biome lists 7) | §0, §2, §5.3, §6.1, §7.6, §8, §9 |
| FF8 | High bands × 1.25 (50 / 140 / 230 m) | High's and Ultra's `drawDistance` is **1.4** (`world-render/src/world.ts` `QUALITY_PRESETS`), and wave 12's tree bands scale by it [confirmed]: **High 56 / 154 / 252 m**. Options' sight (× 0.6–1.4) multiplies on top, so the card reach is capped at the stream edge − 20 m | §5.2, §5.7, §6.1 |
| FF9 | High: "≤ 6 shadow draws in a forest" | A caster draws once per cascade it overlaps: High has **3 cascades** (150 m), Ultra 4 (250 m) (`render/quality.ts`) [confirmed], and 6–9 species stand within 60 m: **≈ 12–27 shadow-pass draws** [projected] | §5.6, §6.1 |
| FF10 | "Forest triangles in view" | A thin-instance mesh is culled as a whole (one bounding box over all instances; the overlay refreshes it, `near-field.ts`), so F1/F2 submit every tree all around the camera: the smoke run's 1,935 instances are all-around [confirmed: `smoke_inst_webgpu.json`, code]. **Now [decision, fact-check]:** the refill also culls its 16 m cells against the frustum widened by 20° (re-run on a ≥ 10° turn, ≈ 0.1 ms), the grass ring's own scheme; casters within 60 m stay all-around [projected: F1/F2 vertex work −50–65 %] | §5.2 |
| FF11 | "the 24 m game camera sits inside crowns" | The game camera defaults to **9 m** (2.5–40 m, `screens/world.ts`); 24 m is the lab's camera [confirmed]. The near fade stands: at the default the camera is ≈ 4 m above the player, inside the 4–6 m small pines | §2 D-F18, §5.5 |
| FF12 | "The busiest region holds 132 new trees + 448 bushes (22942)" | 22942 is (158, 89), **outside** the playable rows 90–102: it is in the scenery ring. The busiest playable region is 23965 (111 + 351) [confirmed: `forest-stats.json`, `common.py`] | §0, §3.10 |
| FF13 | Tomb approach "4 in the prototype"; the survey table's 247 regions | The Tomb approach got **2** trees [confirmed: `place.log`]. The table's rows summed to 245: the 2 "Chinese tomb" regions (lower-case, 0 trees) were missing | §1.1, §3.7 |
| FF14 | Forest Delete → `placements.json` `drop`; Move → a drop + an `add` of the species' carrier | `placements.json` moves and drops name **retail placements only**, with the source and original position checked (WORLD_EDITOR §3.2); S-SCALE allows trees 0.85–1.15 only, while forest trees are 0.30–1.15 of their species; a carrier also brings the retail **square** footprint into the nav and takes a band slot [confirmed: WORLD_EDITOR §3.2, TREES §W3.3]. **Now:** `content/world-edits/jangan-fields/forest/edits.json` holds `drop: [{region, uid, species, from}]` and `move: [{region, uid, species, from, to: [x, z], yaw}]`, applied by the forest pass; a moved tree stays a forest row (instanced, a trunk circle, its scale); an edit whose site no longer holds that species within 1.5 m (after a re-tune) is a Publish warning | §0, §2 D-F9, §3.9 |
| FF15 | D-F11: "nothing closes, so no reachability check can fail by it" | Opening 1,177 retail squares can **join** components (a row of trees sealing a gap, CLIMB's closed far bank, the bounds) [likely]. **Now:** check 4b, the town component may not gain a tile outside the playable bounds or past a CLIMB boundary (a component diff before / after) | §4.3, §4.4 |
| FF16 | Check 2 "nor within 1.5 m of a blocked object outline": prototype "321" | `pockets.ts` tested closed **terrain tiles** only; object outlines were not tested [confirmed: script]. That half is [unknown] until X-F | §4.4 |
| FF17 | "a local edit changes only trees within one spacing" | [confirmed for a Clear brush: a 40 m clearing changed 50 rows, 49 inside the disc and one bush 0.2 m outside; `factcheck/edit-locality.json`]. But the prototype's spacing is **order-dependent across regions** (regions in id order against one global accepted list), so a Publish of one region cannot reproduce a full convert near its borders [confirmed: `place.py`]. **Now:** F12-P makes the spacing order-free (a border candidate is decided by the global site priority over both regions' candidates within 18 m, computed from the hash and the density alone), tested by "region A alone = A in a full run" | §3.8, §7.2 |
| FF18 | Ground height "sunk 0.12 m" | On a 44° slope a trunk of radius r floats `r × tan(slope) − 0.12` m on its downhill side: up to ≈ 0.75 m for r = 0.9 m [projected: geometry]. **Now:** y = the lowest of five terrain samples (the centre and four at r) − 0.12 m | §3.8 |
| FF19 | Cards: "no prepass"; sprites rendered "at the game pitch (18°)" | On High / Ultra the prepass (SSAO, SSR) would see **sky** behind a card, TREES §W3.3's own objection to impostors [likely]; cards write the prepass like LOD2, and the billboard plugin adds no varying. A tree 180–460 m away is seen at ≈ 0–10° elevation, so the sprite is rendered at ≈ 8° [likely] | §5.4 |
| FF20 | The canopy carpet reaches the cards' end | The ring window is 832 m, re-centred every 48 m: its reach is ≥ 352 m (GRASS_FAR §3) [confirmed], short of the cards' 380 / 460 m; beyond it only the baked shade darkens the floor | §5.4 |
| FF21 | Memory "≈ +8–10 MB" | Sprites 5 MiB without mips (6.7 with); the instanced LOD1 + LOD2 copies at the 60 B tree vertex ≈ 0.10–0.16 MB per species; up to ≈ 6 forest-only species' LOD0 overlays (≤ 0.45 MB each); shade maps for 22–35 resident regions: **≈ +11–15 MB** [projected] | §5.8, §6.1 |
| FF22 | G6: "the forest core's + 0.3–0.6 ms GPU sits at the line" | G6 counts against G-11, trees and terrain together, and wave 12 projects most of it already (WAVE_PLAN8 §5.2: trees ≤ +0.6, terrain +0.2–0.4 on the M1 column) [confirmed: WAVE_PLAN8]. For 12F the baseline is G-12, the forest core is a new view, and the M1 (≈ 9–11× the dev GPU) turns +0.3–0.6 ms into ≈ +3–6 ms; alpha-tested foliage also defeats Apple GPUs' hidden-surface removal, so overdraw in a core is the M1's real risk [likely] | §6.1, §9 |
| FF23 | Smaller items | The lab ran with `weatherLevel: 'off'`, so the wind vertex path was off in every lab number [confirmed: `forest-lab.ts`]; the Low guard list lacked `abuse-w11-lowguard.test.ts` [confirmed]; "the full convert (≈ 73 s)" has no source [unknown]; the prototype's tree lattice sits 1.5 m off its cell centre in z, so row 63 can fall up to 1.2 m into the next region (the codec clamped it) [confirmed: `place.py`]; forest trees are not in the rain-shelter map [likely] | §3.10, §6.2, §7.1, §7.3, §7.5 |
| FF25 | D-F11 places each circle "at the trunk base" and keeps the walkable root meshes | Wave 12's own hunt (H-12 lens 13, `packages/convert/test/abuse-w12-nav-trees.test.ts`, uncommitted) finds the drawn species trunk up to 1.45 m off the retail footprint (NT1: `tre_pine04` → pine_small) and walkable root surfaces where the species draws nothing, up to 1.97 m high (NT3: swamp roots, the gagi log) [confirmed: the test's findings, not re-run]. **Now:** a D-F11 circle sits at the **drawn** species trunk (the swap's fold, `foldSwap`), and D-F11 takes F-12's fix of NT3 as its input (a walkable surface that F-12 drops becomes a circle too) | §4.3 |
| FF24 | Everything else | **Re-confirmed:** the survey (1,560 trees, 2.0 /ha, 61 / 127 regions, every area row, 18 % → 35.4 % canopy, 42.7 % → 16.7 % bare); the pass's counts, classes, biomes, groves, gaps and exclusion areas (re-run byte-identical); the walk checks (3.4 / 7.5 / 14.7 %, 4.7 % wander, 25 route points); the skirt run (9.7 %, 0 leg violations, 7 µs); the refill (p95 0.10 ms) and codec (264 / 219 KB) runs; the merge rows of §1.4 (`look_*.json`); `nav-trees.json` (1,235 instances of 75 tree models, 58 walkable on 5); the town box; the Tomb door and building positions; mob wander (`ai.ts`); TREES' 40 / 110 m bands, 3 m hysteresis, 4 m refill, 8,192 slots, the tint offset and WF20; the species' triangle counts | — |

---

## 1. Today (the survey)

### 1.1 Tree coverage by area [confirmed: `survey.py` over the export of 2026-10-02 11:45 UTC]

"Trees" = retail placements of the tree families of TREES §W1 (the 5 unique town trees excluded); "dry land" = terrain
cells not under a water plane or the sea; "canopy" = crown discs (0.42 × the model width, 2–30 m); "suitable" = grass
weight ≥ 0.5, slope ≤ 40°, outside the town box + 30 m; "bare" = suitable and more than 20 m beyond any crown.

| Area | Regions | Dry land km² | Trees | Trees/ha | Canopy % | Suitable % | Suitable but bare % |
|---|---:|---:|---:|---:|---:|---:|---:|
| North-Tiger Mt. | 24 | 0.88 | 165 | 1.87 | 27 | 61 | 24 |
| Lake Forest | 21 | 0.74 | 150 | 2.02 | 20 | 62 | 42 |
| South-Tiger Mt. | 21 | 0.77 | 97 | 1.25 | 31 | 63 | 23 |
| Grassland | 19 | 0.66 | 141 | 2.14 | 18 | 73 | 50 |
| Swamp area | 18 | 0.40 | 122 | 3.02 | 37 | 45 | 20 |
| Hill of Ye Mt. | 17 | 0.63 | 101 | 1.61 | 10 | 70 | 61 |
| Yeoha's Forest | 15 | 0.55 | 107 | 1.95 | 35 | 51 | 14 |
| Enterance of Qin-Shi Tomb | 10 | 0.36 | 21 | 0.59 | 4 | 11 | 86 |
| Jangan South Beach | 10 | 0.27 | 0 | 0 | 0 | 44 | 100 |
| Chinese Tomb (+ 2 "Chinese tomb" regions: 0.07 km², 0 trees; fact-check, FF13) | 9 (+2) | 0.33 (+0.07) | 95 | 2.87 | 20 | 83 | 30 |
| Jangan Ferry | 7 | 0.17 | 44 | 2.59 | 21 | 51 | 30 |
| Bandit's Mountain Stronghold | 6 | 0.22 | 18 | 0.81 | 16 | 90 | 52 |
| Jangan (the town regions) | 6 | 0.22 | 257 | 11.87 | 24 | 2 | 100 |
| Western China (Ferry, Main Road, Ruins, Donwhang, Earth Ghost) | 25 | 0.85 | 239 | 2.8 | 5 | 0–2 | — |
| unnamed playable regions | 37 | 0.67 | 3 | 0.04 | 0 | 36 | 99 |
| **Playable total** | **247** | **7.8** | **1,560** | **2.0** | **18** | **50** | **43** |

- Per region: median 4 trees, p90 14, max 55; **61 regions have no tree, 127 fewer than five**.
- The retail trees are **huge**: most placed models are 30–80 m tall with crowns 35–100 m wide (`tre_tree03` 77 m ×
  99 m, `tre_willow03` 81 m × 97 m, `tre_pine07_04` 49 m × 43 m) [confirmed: manifest bounds, `sizes.py`]. The retail
  "forest" is a sparse row of giants along the roads (`survey-map.png`).
- **Western China** is mostly dry dirt (suitable 0–2 %) and outside the town's walkable component (CLIMB §1.1: the far
  bank is closed); it gets only sparse dry trees.

### 1.2 The masks available [confirmed: `common.py`, `tiles_census.py`, the export]

| Mask | Source | Resolution | Notes |
|---|---|---|---|
| Height, slope | `terrain/<x>_<z>.bin` heights (97 × 97 per region) | 2 m | slope from the cell's corner heights; 1.56 km² of the grid is steeper than 44° |
| Splat (the native layers) | the bin's `layers` section (≤ 8 per cell, mask bits) composited like TERRAIN §2.3 | 2 m | 108 tiles typed Grass / Dirt / Stone / Mud / Water / Sand; **there is no "forest floor" or "moss" tile in this export**; the forest ground weight is derived per tile (§3.2) |
| Tile census (playable) | dominant tile per vertex | 2 m | `c_grass_hmfld_01` 18.4 %, `c_grass_fld_03` 9.9 %, `c_dust_swmp_06` (swamp/river bed) 7.4 %, `c_stone_jinfild_01` (stony road) 6.7 %, hill grasses 12 %, `c_stone_hmfld_01/02` (rocky hill) 6 %, hill dirt `c_dust_hmfld_*` 4 %, field dirt `c_dust_fld_*` 4.4 %, paving `c_marble_jang_*` 4 %, sand 2.4 % |
| Grass weight | GRASS_LIFE §3.2 (`tiles[].grass.weight`: 1 grass, 0.45 grassy dirt, 0 else) | 2 m | the grass field already uses it, so forests and grass agree on where the ground is green |
| Water | the MAPM 32 m blocks' planes (`regions[].blocks[].water.heightM`) | 32 m blocks, depth per 2 m cell | 2,267 water blocks |
| Sea | `coast/field.png` R (ocean mask) and G (distance to shore, 0.5 m steps) | 4 m | the beaches are sand tiles within the coast's distance band |
| Roads and paths | road tiles (stony road, field dirt, paving, sand) **plus** the narrow part of the hill dirt (§3.2) | 2 m | the town graph (TOWN_LIFE) lies inside the town box, which is excluded whole |
| Nests | `work/out/data/nests.json`: 825 enabled, centre, `radius` 50, `spawnRadius` 40 | point | ≈ 1 nest per hectare of playable land: a 40 m clearing per nest would delete most forests (§3.7) |
| NPCs, places | `npcs.json` (46, nearly all in town), `manifest.places` (14) | point | |
| Thunder Seats | `work/tmp/qilin/final-sites.json` (STORM_QILIN §3) | point | |
| Walking routes | the Qilin study's nav routes (`work/tmp/qilin/leg-*.json`, `route-*.json`, 4 m polylines, 15,903 points) | 4 m | the main traversals from town to the Tiger Mountains, Yeoha, the Tomb |
| Tomb door, hot springs | TOMB_DUNGEON (`c_jin_ent02` at (864, −1070)), HOT_SPRINGS (≈ (955, 1180)) | point | |

### 1.3 How trees block today [confirmed: `nav-trees.ts`, NAVIGATION §6]

- `nav.bin` holds **1,235 instances of 75 tree models** (`/tree*/` folders; of 2,233 object instances). Their footprints are
  **blocked squares far larger than the trunk**: `tre_tree02_03` 5.3 × 5.1 m, `tre_pine07_03_01` 10.9 × 8.3 m,
  `tre_willow03_will01` 15.8 × 13.1 m, `c_hhm_tree_01` 11.2 × 15.7 m; small ones 0.6–2 m. Outline edges carry flag 3
  (blocked). Five models (58 instances: three swamp trees, `tre_dead_tre01`, `tre_gagi01`) carry walkable root meshes
  (flag 0).
- The walker (players and monsters) is **one straight chord that stops at the first blocking edge, with no slide and no
  path-finding** (NAVIGATION §6.1, §7); the client moves by click and hold only, no WASD (MOVEMENT, UX_GAPS K9). A player clicking past a
  retail willow stops up to 8 m short of its trunk.
- Monsters wander by trying a few points in their roam circle and taking the first with a clear straight walk
  (`apps/server/src/ai.ts`), so a forest of trunks costs them retries, not trapping [confirmed: code].

### 1.4 What merging a forest into the region batch costs [confirmed: the lab, `shots/look_*.json`, WebGL2 Medium, the pre-warp rows]

The prototype's rows (≈ 4,000 trees and 13,000 bushes within 520 m of the views) were appended to the manifest as
placements of each species' carrier, so wave 12's region batch merged them (LOD1 + LOD2 per tree, both plant tiers):

| View | Draws | Tree triangles submitted (active tree group meshes) | Resident merged tree triangles | Resident tree geometry |
|---|---|---|---|---|
| Yeoha's Forest (game camera) | 41 → 53 | 83 k → 1.16 M | 0.21 M → 2.20 M | 29.3 → 255.8 MB |
| North-Tiger slope | 38 → 51 | 64 k → 1.25 M | 0.23 M → 3.07 M | 29.8 → 348.1 MB |
| Lake Forest edge | 35 → 53 | 30 k → 0.38 M | 0.43 M → 1.55 M | 55.1 → 187.4 MB |
| Yeoha riverbank | 36 → 46 | 94 k → 0.90 M | 0.33 M → 2.60 M | 45.2 → 304.1 MB |
| Lake Forest pond | 40 → 49 | 89 k → 0.68 M | 0.39 M → 1.95 M | 50.7 → 235.6 MB |
| Grassland groves | 39 → 51 | 65 k → 0.91 M | 0.37 M → 2.04 M | 50.0 → 248.4 MB |

Draws barely move (the merge works as designed), but **every merged tree carries both LOD tiers in GPU memory and in
the vertex shader every frame** (TREES §WF, WF5/WF6: ≈ 93–116 B per merged triangle), so a forest costs **+130–320 MB**
of geometry and up to **1.25 M submitted tree triangles**: a non-starter on 8 GB Macs and on the M1's vertex budget.
This is why the forest is instanced (§5) [decision].

---

## 2. Decisions (each the recommended option, with its reason)

| # | Decision | Reason |
|---|---|---|
| D-F1 | **A seeded procedural pass in the converter** (`passes.ts` "forest", after the world edits and the wave-12 tree-swap step) writes a **dedicated forest layer** per region, not manifest placements | ≈ 30 k rows would add ≈ 2.6 MB of manifest JSON, overflow the band texture's 8,192 slots (TREES §W3.3) and go through the region merge (§1.4) |
| D-F2 | **Forest ground weight per tile** (grass 1, grassy dirt 0.6, hill dirt 0.8, swamp mud 0.6, rocky hill 0.35, western dry dirt 0.25, roads / fields / paving / sand / water 0), **narrow hill-dirt paths excluded** by a 6 m morphological opening | the export has no forest-floor splat; the grass rule alone left the hill dirt slopes bare, and hill dirt also paints paths (the prototype put a trunk on one until the opening was added) |
| D-F3 | **Biomes from the area name, the slope and water**: mixed (Yeoha, Jangan Ferry), conifer (Tiger Mountains, Stronghold, and any lowland slope ≥ 26°), broadleaf (lowlands), riverbank (4–24 m from inland water), swamp (mud), graveyard (the Tomb approach), dunhuang (the west) | follows the retail look per area; CLIMB's bands keep their character |
| D-F4 | **Forest potential** = area weight × low-frequency noise (260 m) + 0.22 × retail proximity; one 34 m noise moves every threshold together | patchwork forests and meadows, clustered around the retail trees, irregular edges (§3.3, §3.5) |
| D-F5 | **Densities** (target trees/ha): core 70, edge ramp 8 → 70, slope conifers ≥ 40, riverbanks ≥ 24, groves 45 inside 9–19 m discs, lone trees 0.9 (meadows) / 0.35 (elsewhere); bushes 2.6 × the tree density, capped at 160/ha | SRO's trees are giants: 30–50 stems/ha of mixed sizes close the canopy. *(fact-check, FF5)* Realized by zone with the build's thinning ramp: core ≈ 42, edge ≈ 28, banks ≈ 25, groves ≈ 37, meadows ≈ 1.4 (prototype × 0.55 rule: 34 / 22 / 22 / 29 / 1.2), §3.4 |
| D-F6 | **Three size classes** per biome: giants (scale 0.85–1.15, spacing 9 m), mid (0.65–0.95, 5.5 m), small (0.55–0.85, 3.5 m); landmark giants scaled down (willow 0.30–0.50, swamp giant 0.45–0.75, great maple 0.60–0.95) | layered forests (canopy, mid-storey, saplings) and no 90 m willow in a meadow grove |
| D-F7 | **Exclusions as §3.7** (town + walls + 30 m, roads + 4 m, steep > 44°, sea 12 m, banks 4 m, nest cores 10 m with the density ramped × 0.55 → 0.85 across the 40 m spawn circle (fact-check, FF5), NPCs 12 m, places 15 m, Thunder Seats 30 m, Tomb door and building 60 m, hot springs 45 m, Stronghold 40 m, routes 3.5 m + trunk, retail objects 0.35 × width + 2 m) | the fights, quests, chases and views keep their ground; a 40 m clearing per nest would have deleted the forests |
| D-F8 | **Stable site lattice** (3 m, hashed jitter) with **uid = 0xC000 + site** (trees) / **0xD000 + site** (bushes); spacing by hashed priority | an edit or a re-run changes only nearby trees; uids stay valid for the editor's `(region, uid)` edits; 16-bit for nav ids |
| D-F9 | **The editor edits the forest as a layer** (density brush, clear brush) **plus per-tree drop / move** by `(region, uid)`, kept in the forest layer's own `forest/edits.json` (fact-check, FF14) | painting is how a forest is shaped; single trees still need a nudge off a path |
| D-F10 | **Trunks block as circles** in a new server-side file `nav-trunks.bin`, and the server's walker **skirts** them; a skirted move carries its corners in an optional `MoveState.via` (§4.1; fact-check, FF1, FF2) | no walking through trunks, no click stopping at one (7.5 % of 30 m clicks would), no client nav change, one additive protocol field |
| D-F11 | **Retail tree footprints become trunk circles** (except walkable root meshes) | one feel for every tree; a willow no longer stops a player 8 m from its trunk (cut item 1) |
| D-F12 | **Instancing per species × tier**, not the region merge; near tier shared with wave 12's LOD0 overlay | measured +130–320 MB for the merge (§1.4); draws scale with species, not trees |
| D-F13 | **Palette: 16 tree species + 4 bush species** in the playable forests (4 Dunhuang species in the far west only), ≤ 3 species per size class per biome; *(fact-check, FF7)* with the slope, bank and swamp overrides a view holds **6–11 tree species** in F0–F2 (measured) | draws are per species × tier (§5.3); variety is what makes it read as a real forest, so the draw line follows it (§7.6) and cut 8a trades it back |
| D-F14 | **LOD2 band drawn with one cut-out material** (bark through the atlas table, alpha 1) | one draw per species instead of two where the trunk is a few pixels |
| D-F15 | **Far forest = a canopy card ring** (180 m → the stream edge) **+ a canopy carpet** (the grass ring window gains a forest channel) **+ a baked canopy shade** (Medium+) | forests read to the horizon for one draw and no geometry, the GRASS_FAR way |
| D-F16 | **No per-preset tree thinning**; Medium and High draw every forest tree (they differ in bands, card reach, understory, shadows); Low draws none | trunks are server-side: a tree hidden on one preset would be an invisible wall |
| D-F17 | **Low unchanged** (no forest, retail only; the Low guard) | the user's rule and the Low guard; Low's invisible trunks skirt by ≤ 1 m (§4.6, Q-F1) |
| D-F18 | **Camera-near foliage fade**: foliage within 3 m of the camera, or in the capsule from the camera to the player, dithers out | in dense forest the game camera (default 9 m, ≈ 4 m above the player; 2.5–40 m) sits inside the small pines' and mid trees' crowns; the lab's 24 m camera showed it too (fact-check, FF11) |
| D-F19 | **Ground cover by the grass field**: under the forest the grass density × (1 − 0.45 × canopy) and GRASS_LIFE's broadleaf / clover vertex kind gains a fern variant | a forest floor for zero draws and zero rows |
| D-F20 | **One `content/forest/forest.json`** (seed, densities, palette, exclusions, biome table) read by the pass, the editor and the tests | the forest is data; a tuning round never touches code |
| D-F21 | **Option: Graphics → Forest: On (default on Medium+) / Off**; Off draws nothing new (as Low) | a lever for weak machines without touching the preset |

---

## 3. Placement (a)

### 3.1 Where the pass runs [decision]

- `packages/convert/src/world/passes.ts` gains a pass **"forest"** after the World Editor's "world edits" pass and the
  wave-12 tree-swap manifest step, before the writer. It reads the final placements (retail + coast + town dressing +
  editor), the terrain bins after the coast and the editor's heights, the coast field, the nests, NPCs, places and the
  forest content file, and writes `forest/<x>_<z>.bin` per region plus a report.
- **The nav order** (WORLD_EDITOR §3.6, §F9): the converter builds the nav **before** the placement passes. The forest
  pass therefore ends by writing **`nav-trunks.bin`** (§4.2), a server-only file beside `nav.bin` *(fact-check, FF1:
  not a splice into `nav.bin`, whose decoder refuses extra bytes, and nothing in the client's chunks)*. D-F11's removal
  of the retail tree instances is the one change to `nav.bin` and `nav-objects.bin`, through the editor's nav step
  (WE-N, `buildWorldNav` + `splitWorldNav`).
- **Deterministic**: integer hashing (no `Math.random`, no float-order dependence in the sampling), the seed in
  `content/forest/forest.json`; two conversions give byte-identical forest files (the coast's determinism test,
  extended).
- **Time**: the numpy prototype runs the whole 28 × 20-region grid in 24 s [confirmed: `place.log`]; the TypeScript pass
  in the converter is projected at ≤ 10 s for 414 regions (typed arrays, one region at a time) [projected].

### 3.2 The ground [decision; areas confirmed: `place.py`]

| Ground | Forest ground weight | Notes |
|---|---|---|
| Grass tiles (`c_grass_*`, `wc_grass*`, …) | 1.0 | the grass field's own rule |
| Grassy dirt (`grass.weight` 0.45) | 0.6 | |
| Hill dirt `c_dust_hmfld_*` | 0.8 | **only its wide part**: a 6 m opening (erode 3 cells, dilate 3) removes paths painted with it |
| Rocky hill `c_stone_hmfld_*` | 0.35 | sparse conifers on rock |
| Swamp mud `c_dust_swmp_*` (Mud) | 0.6 | swamp species only |
| Western dry dirt (`wc_*` Dirt) | 0.25 | dunhuang species only |
| Stony road `c_stone_jinfild_*`, field dirt `c_dust_fld_*`, paving `c_marble_*`, sand, Water-typed | 0 | **roads and fields: no trunk within 4 m** (2 cells) |

The density at a cell is multiplied by `clamp(weight / 0.8, 0, 1)` and the cell is eligible at weight ≥ 0.3. Slope:
eligible up to 44° (normal.y ≥ 0.72). Water: no trunk within 4 m of a water plane deeper than 0.3 m (banks and fishing
spots); the sea: no tree within 12 m of the coast field's shore. Excluded by these rules in the grid: roads, fields and
paths 2.37 km², steep 1.56 km², the sea margin 0.19 km², banks 0.04 km² [confirmed: `forest-stats.json`; the areas are
cumulative in the order of §3.7, so "steep" counts only what the town box had not taken].

### 3.3 Forest potential and biomes [decision]

`F = AW × (0.75 + 0.75 × (n260 − 0.5)) + 0.22 × P`, `Fe = F + 0.10 × (n34 − 0.5)`, where `AW` is the area weight
(box-blurred 48 m across region borders), `n260` a 3-octave value noise at 260 m (the patchwork), `n34` a 2-octave
noise at 34 m (the edge wobble) and `P` the retail proximity (1 within 25 m of a retail tree, 0.7 within 45 m, 0.35
within 70 m).

| Area | AW | Biome |
|---|---:|---|
| Yeoha's Forest | 1.00 | mixed |
| Lake Forest, North-Tiger Mt. | 0.85 | broadleaf, conifer |
| South-Tiger Mt. | 0.80 | conifer |
| Swamp area | 0.70 | swamp |
| Jangan Ferry | 0.65 | mixed |
| Chinese Tomb | 0.60 | broadleaf |
| unnamed regions (the ring) | 0.55 | broadleaf |
| Hill of Ye Mt. | 0.50 | broadleaf |
| Bandit's Mountain Stronghold | 0.45 | conifer |
| Grassland | 0.38 | broadleaf (meadow with groves) |
| Western China areas | 0.10–0.25 | dunhuang |
| Enterance of Qin-Shi Tomb | 0.15 | graveyard |
| Jangan, the beaches | 0 | — |

Overrides per cell: lowland slopes ≥ 26° → conifer; 4–24 m from inland water → riverbank; mud → swamp.

**Species mix per biome** (class share; species share inside the class) [decision; the palette of D-F13]:

| Biome | Giants | Mid | Small | Bushes |
|---|---|---|---|---|
| broadleaf | 18 %: bigleaf 45, broad02 45, pine07 10 | 42 %: broad01 45, maple03 35, ginkgo 20 | 40 %: pine_small 50, maple03 50 | shrub02 55, weed_mid 30, flower_bush 15 |
| mixed (Yeoha) | 22 %: pine07 40, broad02 30, bamboo04 30 | 40 %: maple03 50, broad01 50 | 38 %: pine_small 70, maple03 30 | shrub02 60, weed_mid 40 |
| conifer | 25 %: pine07 45, pine08 35, pine10 20 | 35 %: pine07 50, pine10 50 | 40 %: pine_small 85, deadwood_a 15 | shrub02 70, weed_mid 30 |
| riverbank | 30 %: willow03 70, broad02 30 | 50 %: broad01 50, maple03 30, swamp_b 20 | 20 %: pine_small 50, broad01 50 | weed_mid 50, shrub02 30, reeds 20 (≤ 8 m from water) |
| swamp | 20 %: swamp_a | 50 %: swamp_b | 30 %: deadwood_a 50, swamp_b 50 | reeds 60, weed_mid 40 |
| graveyard | 40 %: grave_tree | 20 %: grave_tree | 40 %: deadwood_a 70, deadwood_b 30 | weed_mid |
| dunhuang | 40 %: dh_poplar 60, dh_twig 40 | 40 %: dh_tree | 20 %: dh_brush 30, deadwood_a 70 | weed10 |

Maple tints: green by default in the forest (`green2` / `middle`), **red on ≤ 10 % as an accent** [decision: the
prototype's all-red maples read as autumn in a summer forest].

### 3.4 Densities, classes and spacing [decision; realized numbers confirmed: `factcheck/zones-*.json`]

*(fact-check, FF5)* The first draft's realized column was bucketed by the final target density, not by zone. Re-derived
by zone over the playable eligible ground (`factcheck/zones.py`), for the prototype's rule (× 0.55 over the whole spawn
circle) and the build's ramp (× 0.55 within 24 m of a nest centre, 0.7 to 32 m, 0.85 to 40 m):

| Zone | Target trees/ha (before ground weight and nest thinning) | Ground | Realized, prototype rule | **Realized, build rule (ramp)** | Bushes/ha (prototype → ramp) |
|---|---:|---:|---:|---:|---:|
| Core (Fe ≥ 0.62) | 70 | 125 ha | 33.5 | **41.6** | 118 → 150 |
| Edge (0.46 ≤ Fe < 0.62): smoothstep 8 → 70; slope conifers ≥ 40 | 8–70 | 96 ha | 22.4 | **27.7** | 69 → 88 |
| Banks (riverbank ≥ 24) | ≥ 24 | 10 ha | 21.6 | **24.9** | 67 → 79 |
| Groves (45/ha in 9–19 m discs, 0.55 of the 70 m lattice cells) | 45 | 5 ha | 29.3 | **36.6** | 87 → 112 |
| Meadow outside the groves (0.30 ≤ Fe < 0.46): lone trees | 0.9 | 83 ha | 1.2 | **1.4** | 3 → 4 |
| Low potential (Fe < 0.30) | 0.35 | 34 ha | 0.2 | **0.2** | 0.7 → 0.8 |

- Where the full target survives the multipliers (final target ≥ 60/ha: 14.6 ha), the sampler realizes **49.9/ha**;
  at final targets 20–40 it realizes 31.0/ha and at 5–20 12.4/ha [confirmed: `factcheck/zones-by-target.json`]: the
  sampler keeps ≈ 70–100 % of its target, and the gap to 70 is the spacing of SRO's giant crowns.
- **Why the ramp** [decision, fact-check]: 83 % of the eligible forest ground and 88 % of the core lie inside one of the
  825 nests' 40 m spawn circles [confirmed: `factcheck/nest-share.json`], so "× 0.55 inside the spawn circle" halved
  nearly every forest, against the user's "more dense". The ramp keeps the fights' open 10 m core and a halved 24 m
  ring (the roam and chase space of a pack) and gives the whole pass **+24 % trees** (8,420 + 28,781 bushes in the
  playable area), canopy 36.9 %, bare 15.9 %, the busiest playable region 139 trees + 455 bushes (24482), min trunk gap
  3.0 m, p5 4.8 m [confirmed: `factcheck/stats-ramp.json`]. The ramp is three numbers in `content/forest/forest.json`.
  The rest of this spec quotes the prototype run (× 0.55) unless it says "ramp"; draws do not change (they follow
  species), triangles and rows grow ≈ 24 %.

- **Min spacing** between trunks: max(class spacing of the pair): giants 9 m, mid 5.5 m, small 3.5 m; to a retail tree:
  max(4 m, 0.2 × its width, the class spacing). Bushes: 2.5 m apart and ≥ trunk + 1.2 m from a trunk.
- **Trunk radius** for the nav: from each species' LOD0 trunk base (T12-A's `stats.json` gains `trunkRadiusM`) × the
  scale, floor 0.25 m, bamboo clumps 0.9 m. The prototype's stand-in rule (0.012 × height + 0.12) gives a median of
  0.29 m, max 0.9 m [confirmed].
- **Result**: the clear gap between any two trunks is **≥ 3.0 m** (p5 5.1 m, median 9.8 m) [confirmed:
  `walk-check.json`], so every forest is walkable between any two trees.

### 3.5 Edges: soft and irregular [decision; confirmed in the maps]

- The edge band is a smoothstep ramp of density over Fe 0.46 → 0.62, and `n34` moves the whole ramp by ± 0.05, so an
  edge wanders with 30–40 m blobs instead of following a contour; bushes are densest on the edge (2.6 × trees, capped
  at 160/ha) the way real forest margins are scrubby.
- Groves are discs of 9–19 m radius on a jittered 70 m lattice: clumps, not a sprinkle.
- Roads and paths keep a 4 m margin of trunks, but crowns overhang them (`map-before-after.png`, the Yeoha path in
  the preview's first row).

### 3.6 Extending the retail look [decision]

- `P` (the retail proximity) adds up to 0.22 to the potential within 70 m of a retail tree, so new cover grows out from
  the retail rows and groves instead of avoiding them.
- The biome's species list includes the species the retail trees of that area swap to (pine07 / pine08 in the Tiger
  Mountains, the big maples in the Lake Forest, willows on the banks), so the new trees read as the same forest.
- New trees keep the retail tree's own space (spacing above) so no crown passes through a retail trunk.

### 3.7 Exclusion zones [decision; areas confirmed: `forest-stats.json` (cumulative, in order)]

| Zone | Rule | Ground removed |
|---|---|---:|
| The town and its walls | DATA.md's box (centre 82.7, −198.8; half extents 256 × 178.7 m) + 30 m | 0.23 km² |
| Steep cliffs | slope > 44° | 1.56 km² |
| Sea margin | within 12 m of the coast field's shore | 0.19 km² |
| Banks and fishing spots | within 4 m of a water plane deeper than 0.3 m | 0.04 km² |
| Roads, fields, paving, paths | road tiles and narrow hill dirt + 4 m | 2.37 km² |
| Nest cores | 10 m around each of the 825 nest centres; density × 0.55 within 24 m, 0.7 to 32 m, 0.85 to 40 m (the prototype: × 0.55 over the whole 40 m spawn circle, which covers 83 % of the forest ground; fact-check, FF5) | 0.19 km² |
| Places, NPCs | 15 m around the 14 places, 12 m around NPCs outside town | 0.005 km² |
| Thunder Seats (STORM_QILIN) | 30 m around the six seats (and the rejected seventh) | 0.002 km² |
| Tomb door and building | 60 m around `c_jin_ent02` (864, −1070) and `c_jin_ent01` (863, −940) | (inside the Tomb approach's 0.15 weight) |
| Hot springs | 45 m around (955, 1180) | 0.006 km² |
| Bandit's Mountain Stronghold | 40 m around the place | 0.004 km² |
| Walking routes | 3.5 m around every point of the Qilin study's nav routes (the build: 3.5 m + the trunk radius) | 0.09 km² |
| Retail objects | rocks, cliffs, buildings, props: 0.35 × width + 2 m (≤ 40 m) | 0.20 km² |
| Closed nav tiles (build rule) | on a closed tile or within 2 m of one (the pass reads the nav built before it, §3.1) | the prototype left 321 trunks there (§4.4 check 2) |

- **Monster camps**: CLIMB's camps and the Stronghold are nests with `aggressive` packs; the 10 m core keeps their
  centre open and the thinning (× 0.55 within 24 m, ramping to 0.85 at 40 m: fact-check, FF5) keeps sight lines
  where the pack roams and chases. A camp that needs a bigger clearing
  gets it by an exclusion row in `content/forest/forest.json` (a circle with a radius), not by code.
- **Beaches**: sand tiles have weight 0 and the 12 m sea margin keeps the dunes open; S1 (Jangan South Beach) keeps
  2 trees in the prototype (on its grassy back slope).
- **The Tomb approach** (B4): area weight 0.15 and the 60 m door circles leave it a graveyard with a few dead trees
  (2 in the prototype; fact-check, FF13: the first draft said 4).

### 3.8 Sampling [decision; confirmed in the prototype]

1. Each region has a **3 m site lattice** (64 × 64 sites). Site (i, j) sits at its cell centre ± 1.2 m of hashed jitter;
   its uid is `0xC000 + 64 j + i` (trees) or `0xD000 + 64 j + i` on a lattice offset by 1.5 m (bushes).
2. A site is a candidate when `hash(region, i, j, 3) < density × 9 m² / 10⁴ × 1.25` (the × 1.25 pays for spacing
   rejections).
3. Candidates are accepted in **hashed priority order**, rejected when closer than the pair's spacing to an accepted
   tree or a retail tree. *(fact-check, FF17)* The prototype ran the regions in id order against one global list of
   accepted trees, so a region's border trees depend on its lower-id neighbours' results [confirmed: `place.py`], and a
   Publish of one region could not reproduce a full convert near its borders. **The build makes it order-free**: the
   priority is a hash of the **world** site, and a candidate within 18 m (two giant spacings) of a region border is
   decided over both regions' candidates in that strip, recomputed from the hash and the density field alone (no
   dependence on which region ran first). F12-P tests "region A run alone (with its strip) = A's rows in a full run".
4. Class, species, scale and yaw come from further hashes of the same site, so a site keeps its tree when a neighbour
   changes. A local edit changes only trees within one spacing of it [confirmed for a Clear brush: a 40 m clearing in
   23965 changed 50 rows, 49 inside the disc and one bush 0.2 m outside it, `factcheck/edit-locality.json`; Thicken and
   the border strip are F12-P's tests].
5. Ground height is **not stored**: the client computes it from the terrain (no terrain LOD, so the trunk sits exactly
   on the drawn ground). *(fact-check, FF18)* A flat "sunk 0.12 m" leaves the downhill side of a trunk floating by
   `r × tan(slope) − 0.12` m (≈ 0.75 m for r = 0.9 m at 44°), so the trunk's y is the **lowest of five terrain samples**
   (its centre and four points at r) − 0.12 m (bushes: three samples at 0.5 m, − 0.05 m).
6. *(fact-check, FF23)* Sites stay inside their region: site (i, j) is at `3i + 1.5`, `3j + 1.5` ± 1.2 m of jitter, so
   0.3–191.7 m. The prototype offset the tree lattice by 1.5 m in z (`place.py`), which put row 63 up to 1.2 m into the
   next region (the codec then clamped it).

### 3.9 The forest layer and the editor [decision]

**Files** (per region, in the export; Medium+ fetches them with the region):

```
forest/<x>_<z>.bin   'SROF' v1: header (counts, the species table index of content/forest/forest.json)
  trees  [n] 10 B: u16 site (12 bits) | u16 x (dm, region-local 0..1920) | u16 z (dm) | u8 species | u8 yaw (/256 turn)
                   | u8 scale ((v + 64) / 256: 0.25..1.25; fact-check, FF6) | u8 class (2 bits) | tint (3 bits) | flags (3 bits)
  bushes [m]  8 B: u16 site | u16 x | u16 z | u8 species | u8 yaw | (scale in the high bits of species) ...
  canopy shade: terrain/<x>_<z>_forest.webp, 256 × 256 R8 (0.75 m/texel), Medium+ only (§5.4)
nav-trunks.bin (server only; fact-check, FF1): 'SRNT' v1, per region: u32 region id, u32 count, then 5 B per trunk
  (u16 x dm, u16 z dm, u8 radius dm), forest trees and (D-F11) retail trees (§4.2)
content/world-edits/jangan-fields/forest/edits.json (fact-check, FF14): drop / move by (region, uid), see below
```

Size, encoded in this layout (`codec.ts`, 249 regions with forest, the scenery ring included): **264 KB raw, 219 KB
brotli** (positions are noise and compress little; the largest region file 3.8 KB brotli); the playable trunk layer
**33 KB raw, 27 KB brotli** [confirmed: `codec.json`, re-run]. With the thinning ramp (FF5) ≈ +24 %: ≈ 0.27 MB brotli
[projected]. The trunk file is server-only, so it is no download.

**The World Editor** (WORLD_EDITOR's layers and Publish):

- **Forest brush (F)**: paints `content/world-edits/jangan-fields/forest/<x>_<z>.png`, 96 × 96 LA8 at 2 m: L = density
  multiplier × 128 (0 clear … 255 = × 2), A = touched. Modes: Thicken, Thin, Clear, Reset; a soft falloff; Shift
  previews the biome under the brush.
- **Single trees**: forest trees are pickable in the editor only. *(fact-check, FF14)* Delete and Move write the
  forest layer's own `forest/edits.json`: `drop: [{ region, uid, species, from: [x, z] }]` and `move: [{ region, uid,
  species, from, to: [x, z], yaw }]`, applied by the forest pass after sampling (a moved tree keeps its species, scale
  and tint, stays a forest row, is instanced and keeps a trunk circle; the spacing and exclusion checks run on its new
  spot). Not `placements.json`: its moves and drops name retail placements only, S-SCALE's tree range (0.85–1.15) cannot
  hold a forest tree (0.30–1.15 of its species), and a carrier would bring a retail square footprint into the nav and
  take a band slot. An edit whose site no longer holds that species within 1.5 m (after a re-tune of `forest.json`) is
  a Publish **warning** listing it ("this tree changed under your edit"), never a silent apply. Planting a single new
  tree stays WORLD_EDITOR's library add (a carrier placement).
- **Live preview**: the editor runs the same pass (the node-free module in `packages/shared/src/forest/**`) on the
  touched region + its ring in a worker (≈ 50–100 ms per region [projected]) and swaps the region's forest rows.
- **Publish**: re-runs the pass on the touched regions and the 18 m border strips of their neighbours (order-free,
  §3.8 item 3, so the result equals a full convert), rewrites those regions' trunks in `nav-trunks.bin`, and adds
  checks: **the corridor check** (no trunk within 3.5 m + r of a route point), **no pocket**
  (§4.4), and **the forest budget** (§7.2 guard: ≤ 220 trees and ≤ 600 bushes per region warn, 300 / 900 refuse).
- The S-UID registry (WORLD_EDITOR D11) records the two forest ranges beside retail (≤ 0xB41D), editor
  (0xE000–0xEFFF) and dressing (1,000,000+); overlaps are errors.

### 3.10 The prototype pass on the real export [confirmed: `forest-stats.json`, `map-before-after.png`, `map-biomes.png`]

| Area | New trees | New bushes | Retail trees |
|---|---:|---:|---:|
| North-Tiger Mt. | 1,741 | 5,808 | 165 |
| Lake Forest | 1,344 | 4,158 | 150 |
| South-Tiger Mt. | 1,273 | 4,413 | 97 |
| Yeoha's Forest | 935 | 3,137 | 107 |
| Chinese Tomb (+ "Chinese tomb") | 396 | 1,091 | 95 |
| Swamp area | 319 | 1,430 | 122 |
| Hill of Ye Mt. | 214 | 675 | 101 |
| unnamed playable regions | 186 | 587 | 3 |
| Grassland | 150 | 471 | 141 |
| Jangan Ferry | 151 | 527 | 44 |
| Bandit's Mountain Stronghold | 78 | 286 | 18 |
| Western China, beaches, Tomb approach, town | 19 | 72 | — |
| **Playable total** | **6,806** | **22,655** | **1,560** |
| Scenery ring outside the bounds | 446 | 1,518 | — |

- By class: giants 1,413, mid 2,877, small 2,962 (all regions); by biome: conifer 3,771, broadleaf 1,919, mixed 1,021,
  swamp 323, riverbank 215. 624 groves. Biomes are read through a ± 44 m domain warp, so a biome border at a region
  border is a wavy mixing band (`map-biomes.png`; the first run showed a straight species line there).
- Per playable region: median 23 new trees (p90 88), max 111 trees + 351 bushes (23965, North-Tiger). *(fact-check,
  FF12)* The 132 + 448 of the first draft is 22942 (158, 89), a South-Tiger flank region in the scenery ring.
- **Canopy cover of the dry land 18.0 % → 35.4 %; grassy walkable ground more than 20 m from a crown 42.7 % → 16.7 %.**
  What stays open is meadow by design (the Grassland around the town, the Hill of Ye's pastures), the Tomb approach,
  the beaches and the fields.
- In the game camera (the preview sheet, rows 1–6): Yeoha's path gets a forest on both sides with the path clear; the
  North-Tiger slope turns from an open pasture into a pine wood; the Lake Forest edge gets a wooded skyline; the
  Grassland gets groves. The pond's banks stay open (the 4 m bank rule).

**Known prototype faults, each a build rule:** the willow's retail envelope (81 m) needed the landmark scale (D-F6);
the all-red maples (tints, §3.3); 25 of 15,903 route points had a trunk within 3.5 m because the trail rule ignored the
trunk radius (the build adds it); scales below 0.5 failed the manifest's S-SCALE range in the stand-in, and
*(fact-check, FF6)* the codec clamped them to 0.5 too: the forest file's range is 0.25–1.25; the tree lattice sat
1.5 m off its cell centre (§3.8 item 6); the ground height ignored the slope under the trunk (§3.8 item 5).

---

## 4. Walking (b)

### 4.1 Trunks block, and the walker skirts them [decision]

- **Why not "stop at the trunk"**: with the chord walker, 3.4 % of 15 m, **7.5 % of 30 m** and **14.7 % of 60 m**
  clicks started inside the new forest hit a trunk (1.5 % of the 60 m ones hit two); 4.7 % of monster wander moves
  would stop short [confirmed: `walk-check.json`, 4,000 random clicks, 6,600 wander chords, 0.3 m body margin].
- **Why not "trunks don't block"**: players and monsters would stand inside trunks on every preset that draws them.
- **The skirt** (`packages/nav/src/trunks.ts`, one pure function used by the **server** and the tests; *fact-check,
  FF2*: not by the client, see "Protocol" below): before running the chord through the walker, the trunk layer is
  queried along it (8 m buckets). For the first trunk circle of radius `R = r + 0.3 m` that the chord meets, the chord
  becomes two legs through the **corner point** `W` where the tangents from the start and from the destination to the
  circle meet, on the side of the circle the chord passes (ties: left). Each leg then goes through the normal walker
  (walls, closed tiles, objects, the server's solids); the second leg is skirted again. **No trigonometry**: the
  tangent points use square roots only (`T = C + R (R/d) u ± R sqrt(1 − R²/d²) v`); since only the server computes
  skirts, engine agreement is no longer needed for correctness, but the maths stays deterministic for the tests.
- **Prototyped** (`skirt.ts`, geometry only, on the prototype's 6,806 trunks): 10,000 random 15–60 m clicks started in
  the forest: **9.7 % skirt** (at most 2 trunks in one move), **0 legs enter a trunk circle**, the detour adds
  ≈ 2 cm per skirted move, 7 µs per move in Node; 0.57 % stop: 0.53 % because the click was on a trunk (they stop at
  its edge, as intended) and 0.04 % because a corner leg met a second trunk (the build skirts that one too, recursively,
  within the cap) [confirmed: `skirt.json`]. *(fact-check)* Over the arrived skirted moves: detour p50 0.01 m, p99
  0.20 m, max 0.37 m; lateral bend p50 0.38 m, max 1.06 m [confirmed: `factcheck/skirt-worst.json`].
- **The wide turn** *(fact-check, FF3)*: `W` runs away when both ends lie near the circle on opposite sides (a walker
  standing on a trunk's edge after clicking it, then clicking just past its far side): a 2 cm gap gives a corner 2.4 m
  from the centre and a 3.7 m detour for a 1.2 m step, and the prototype's 0.999 clamp allows ≈ 22 R
  [confirmed: `factcheck/skirt-worst.json`]. **Rule:** a corner farther than 2 R from the centre is replaced by two
  corners on the circle's circumscribed square (aligned to the chord; constants only), so the detour stays ≤ ≈ 2 R
  [projected: geometry; F12-N's fixed vectors].
- **Limits**: at most 8 skirts per click (a 9th trunk stops the walk like a wall, never seen in the prototype's gaps);
  a destination inside a trunk circle ends on its edge; a walker that **starts inside** a circle (a position saved
  before the deploy, a knock-back) ignores that circle for this move and walks out (*fact-check, FF3*; the terrain
  walker's own "may always step out" rule); a skirt corner that would land in a closed tile, a blocked object or a
  solid is not taken (the walk stops at the trunk, as a wall). Each segment between corners is its own walker call
  with its own `NAV_MAX_LEGS` (6) budget (*fact-check, FF4*).
- **Protocol** *(fact-check, FF2: the first draft said "none changes; both sides run the same `moveStraight`")*:
  `MoveState` is one straight segment `{from, to, speed, startedAt}` (`shared/src/protocol.ts`); every client
  interpolates it linearly (`apps/game/src/net/clock.ts`) and the own client re-walks it straight
  (`heights.selfMove`), while the server's `livePoint` maps straight-distance progress onto the walk's legs
  (`apps/server/src/world.ts`) [confirmed: code]. One move with bent legs would therefore draw the character through
  the trunk on every screen and put the server up to ≈ 1 m off the drawn position mid-move. **So a skirted move
  carries its corners**: `MoveState` gains an optional `via: Vec3[]` (≤ 16 corners; `validate.ts` checks them like
  `to`); `net/clock.ts` interpolates along `from → via… → to` by path length (its yaw per segment), the server's
  `arrivalTime` uses the path length (its `livePoint` already walks the legs), and `heights.selfMove` re-walks each
  segment straight. A move without `via` is byte-identical to today's. Clients need **no trunk data** (a segment
  between corners never meets a trunk, so the client's trunk-free re-walk ends where the server's does). A new click
  or a chase re-target replaces the move as today. *Fallback* (if the protocol field is refused): the server issues
  the walk as a chain of straight moves, one per corner, at the cost of a forward snap of ≈ speed × (tick + latency) at
  every corner on every screen [projected].

### 4.2 The trunk layer [decision]

- *(fact-check, FF1)* The first draft put the trunks in an optional trailing section of `nav.bin` "that an old reader
  ignores". It cannot: `decodeNavData` throws on a version other than 1, on `totalBytes` mismatch and on "N trailing
  bytes", and the format has no section table (`packages/nav/src/serialize.ts`) [confirmed: code]. **Now:** a separate
  server-only file **`nav-trunks.bin`** beside `nav.bin` ('SRNT' v1; per region: u32 region id, u32 count, then
  `u16 x, u16 z` in region decimetres and `u8 r` in decimetres), read by the server's `MeshNav` when present (absent:
  today's behaviour). `nav.bin`, `nav-objects.bin` and the client's `nav/<x>_<z>.bin` chunks keep their bytes (only
  D-F11 removes retail instances from them).
- The broad phase is an 8 m bucket grid built per region on load (≈ 0.1 ms per region) [projected].
- The reachability graph (`reach.ts`) does not rasterize trunks: a forest circle ≤ 1.2 m (r ≤ 0.9 m + the 0.3 m body)
  with ≥ 3 m clear gaps cannot split a component of 2 m tiles; the retail circles of D-F11 can be larger, so the checks
  of §4.4 prove it per Publish.

### 4.3 Retail tree footprints become circles [decision; cut item 1]

The 1,177 blocking retail tree instances (70 models) lose their object instance in `nav.bin` and `nav-objects.bin` (the
client streams the latter, so its own re-walk agrees with the server) and gain a trunk circle in `nav-trunks.bin` at
their trunk base (T12-A's validator already checks the species' trunk base against the retail trunk within 0.3 m,
TREES WF20; *fact-check, FF25*: the circle sits at the **drawn** species trunk after the swap's fold, since wave 12's
H-12 found trunks up to 1.45 m off their retail footprints). Walkable root meshes (the 5 models of §1.3, flag 0) stay as
objects unless F-12's fix of H-12's NT3 (root surfaces where the species draws nothing) drops them; then they become
circles too. A tree the editor plants through its
carrier (WORLD_EDITOR D25) gets the same circle. Effect: the ground under the 70 tree models' squares (≈ 0.1 km²
[projected]) opens. *(fact-check, FF15)* "Nothing closes, so no check can fail" missed the other direction: opening
can **join** ground that a row of retail squares kept apart (a gap in a tree line, CLIMB's closed far bank, the
playable bounds) [likely]. Check 4b (§4.4) diffs the town component before and after.

### 4.4 Reachability and the checks [decision; prototype numbers confirmed]

| # | Check | Prototype | Gate |
|---|---|---|---|
| 1 | Clear gap between any two trunk circles ≥ 3.0 m | min 3.0, p5 5.1 | stop |
| 2 | No trunk on a closed nav tile or within 2 m of one, nor within 1.5 m of a blocked object outline (no pocket) | **194 trunks on closed tiles and 127 within 1.5 m of one** (4.7 %; the examples lie at z ≈ +1,200–1,340, the south) [confirmed: `pockets.ts` on `nav.bin`]: the build's pass reads the nav's tile map and excludes them (§3.7). *(fact-check, FF16)* `pockets.ts` tested terrain tiles only; the object-outline half is [unknown] until X-F | stop |
| 3 | Route corridors: no trunk within 3.5 m + r of a route point (Qilin routes, town ↔ places, gates) | 25 of 15,903 points (the radius rule fixes them) | stop |
| 4 | Every nest centre, NPC, place, gate and probe that was in the town's component still is (WORLD_EDITOR check 3) | forest trunks cannot split components (§4.2); retail circles are checked | stop |
| 4b | *(fact-check, FF15)* The town's component gains no tile outside the playable bounds and none past a CLIMB boundary when D-F11 opens the retail squares (a component diff, before / after) | not run | stop |
| 5 | Nest spawn points: the spawner's `canWalk` refuses points inside a trunk circle | by construction | test |
| 6 | Skirt walks: 10,000 random clicks in forest regions reach their destination or stop at a wall, never at a trunk; every `via` segment clears every circle (so the client's linear interpolation never enters a trunk); the wide-turn rule bounds the detour | geometry prototype: 0 leg violations, 0.04 % corner re-hits, detour max 0.37 m on random clicks, 3.7 m in the wide-turn case without the rule (§4.1) | stop |
| 7 | Monster wander: no mob stays stuck > 10 s at a trunk (the bot soak) | — | warn |

### 4.5 Monsters [decision]

Monsters use the same skirting walker on the server (their wander and chase are chords, NAVIGATION §7; `ai.ts` re-issues
chase moves, each a new move with its own corners), so a pack chasing through a forest bends around trunks instead
of stopping; leashing is unchanged. The thinning ramp inside spawn circles (FF5) and the 10 m cores keep fights
readable.

### 4.6 Low and "Forest: Off" [decision; Q-F1]

Low draws no forest (the Low guard) but the server's trunks still exist, so a Low player's path bends around an
invisible trunk by ≤ ≈ 1.1 m (*fact-check*: max 1.06 m, p50 0.38 m over 10,000 forest clicks; the first draft said
≤ 1 m). Accepted by default: it reads as path smoothing, never as a wall. The alternative (Low draws the
card ring, 1 draw) is Q-F1.

---

## 5. Rendering with batching (c)

### 5.1 Why instancing and not the region merge [confirmed: §1.4]

Wave 12 merges every swapped retail tree's LOD1 + LOD2 into its region's batch: right for 1,700 trees, wrong for
8,000 more (+130–320 MB, up to 1.25 M submitted triangles). Instanced, a species' geometry exists once per tier and
each tree is one 64 B matrix; the draw count follows the number of species in each band, not the number of trees.

### 5.2 The tiers and bands [decision]

| Tier | Distance (camera, `distance − radius`, × the range scale) | What draws | Draws |
|---|---|---|---|
| **F0 near** | < 40 m (High 56) | wave 12's **LOD0 overlay** (`trees/near-field.ts`): the forest adds its band-0 trees to the species' overlay instance lists through a new external-instances seam; a species whose `near.glb` is still loading keeps its trees in F1 (the overlay's own rule) | 0 new for a species already in the overlay, else 2 (leaf, wood; the willow 3) |
| **F1 mid** | 40–110 m (High 56–154) | LOD1 (`far.glb` node `lod1`), thin instances per species | 2 per species (leaf cut-out, wood opaque) |
| **F2 far** | 110–180 m (High 154–252) | LOD2 (`far.glb` node `lod2`), thin instances per species, **one cut-out material** (D-F14) | 1 per species |
| **F3 cards** | 180 m → the stream edge (Medium 380 m, High 460 m) | the canopy card ring (§5.4) | 1 for every species |
| Bushes P0 | < 25 m (High 35) | the plant's tier 1 (`lod1`) | 1 per species (foliage only) |
| Bushes P1 | 25–70 m (High 35–98) | the plant's tier 2 (`lod2`) | 1 per species |

*(fact-check, FF8)* The first draft scaled High by 1.25 (50 / 140 / 230 m). High's and Ultra's `drawDistance` is **1.4**
(`QUALITY_PRESETS`, `world-render/src/world.ts`) and wave 12's tree bands scale by it [confirmed], so the High column is
× 1.4. Options' sight multiplies on top (× 0.6–1.4); the card reach is capped at the stream edge − 20 m.
| Beyond | — | the grass ring's tufts and the canopy carpet | 0 |

- **Hysteresis 3 m** and a **refill every 4 m** of camera travel, wave 12's rules (`bands.ts`). Bands are decided on the
  CPU per tree, so the instance lists are exact: no band byte, no collapse in the shader, no slot (the 8,192 band slots
  stay for the retail trees).
- **The refill** walks only the 16 m cells within 240 m (High 330 m): ≈ 1,500–2,500 trees and bushes in a forest
  [projected from the prototype's densities], writes each tier's matrices into a preallocated `Float32Array` and
  uploads only the lists that changed. *(fact-check, FF10)* **It also culls the cells against the camera frustum**,
  widened by 20° and by the largest crown radius, and re-runs on a ≥ 10° camera turn as well as on 4 m of travel: a
  thin-instance mesh is culled only as a whole (one bounding box over all its instances, refreshed by
  `thinInstanceRefreshBoundingInfo`, as the overlay does), so without it F1 and F2 submit every tree all around the
  camera (the smoke run's 1,935 instances were all-around) [confirmed: code, `smoke_inst_webgpu.json`]. The grass ring
  culls its cells on the CPU the same way. Effect: F1/F2 vertex work ≈ −50–65 % at a 78° horizontal field of view
  [projected]; the High casters within 60 m stay all-around (a tree behind the camera shades the view). Prototyped in Node (`refill.ts`: 500 refills on a 2 km walk across Yeoha's
  Forest, every tree and bush within 240 m): **p50 0.07 ms, p95 0.10 ms** (one 1.4 ms first call, the JIT), ≤ 590
  instances written [confirmed: `refill.json`]; the browser adds the buffer uploads (≤ 40 KB) [projected ≤ 0.1 ms].
- **The card ring** keeps a per-cell instance list (x, y, z, species, scale) of every resident forest tree beyond F2,
  built when a region commits (≈ 0.2 ms per region) and culled per 16 m cell on the CPU like the grass ring.
- **No double draw**: a forest tree is in exactly one list (F0 / F1 / F2 / F3) after each refill; the overlay seam tags
  external instances so the overlay never draws a forest tree twice; forest uids live in their own key space
  (`placementKey(region, uid)` with uid ≥ 0xC000 never collides with a retail key).

### 5.3 Draws [confirmed: the inst prototype and the species counts; projected for the build]

The lab's **inst** mode drew the prototype's rows as thin instances per species × tier × material, with LOD2 out to
400 m and no cards (the worst case): at the Yeoha view, **draws 41 → 93 (52 forest meshes in view, 54 sets), forest
triangles submitted 0.30 M (LOD2 0.19 M of it; all around the camera, FF10), CPU frame p95 1.0 → 1.7 ms** (WebGPU
Medium, 120 frames, busy machine, no GPU lock, weather off so no wind vertex work: a smoke run) [confirmed:
`smoke_base_webgpu.json`, `smoke_inst_webgpu.json`]. It used 20 species (the stand-ins included every bush and tint
variant) and two materials on every tier. +52 draws for +0.7 ms is ≈ 13 µs per draw (WAVE_PLAN8 uses ≈ 18 µs).

*(fact-check, FF7)* The first draft projected 4 / 5 / 6 species in F0 / F1 / F2 and ≈ 27 / 22 / 10 draws. Counted on
the prototype's rows at the six lab views (`factcheck/bands_species.py`; every tree and bush of the pass within 520 m,
all around the target), the palette with its slope, bank and swamp overrides puts more species in each band:

| View | Medium: tree species F0 / F1 / F2 / F3, bush species P0 / P1 | Medium forest draws | High (× 1.4) forest draws |
|---|---|---|---|
| Yeoha's Forest core | 6 / 6 / 9 / 13, 2 / 2 | **38** | **44** |
| North-Tiger slope | 3 / 5 / 5 / 6, 2 / 2 | **26** | **30** |
| Lake Forest edge | 5 / 7 / 7 / 11, 3 / 3 | **38** | **43** |
| Yeoha riverbank | 3 / 5 / 7 / 12, 2 / 3 | **29** | **38** |
| Lake Forest pond | 3 / 8 / 9 / 11, 2 / 3 | **37** | **46** |
| Grassland groves | 4 / 7 / 7 / 11, 3 / 3 | **36** | **43** |
| The plaza | 0 / 1 / 5 / 9, 0 / 0 | **8** | **15** |

Draws = 2 × F0 species (counted as new; a species with a retail tree already in band 0 adds 0) + 2 × F1 + F2 + 1 (cards)
+ P0 + P1 [the counts confirmed; the draws projected]. **Forest scenes: ≈ 26–38 draws on Medium, 30–46 on High**; at
≈ 13–18 µs each, ≈ +0.4–0.7 ms CPU, which G1 absorbs in a forest (the scene's base p95 is ≈ 1 ms). The plaza: ≈ 8 / 15;
the crowded rule (≥ 15 players: F1 → F2 beyond 60 m, bushes P1 off) takes ≈ 2–4 off. The species variety is what makes
the woods read as a real environment, so the draw line follows it (G4, §7.6) rather than the palette shrinking; the
lever if LAB-12F disagrees is **cut 8a** (§8: one LOD2 per archetype in F2: −3 to −6 draws).

### 5.4 The far forest: canopy cards and the canopy carpet (no visible edge) [decision]

- **Cards** (F3): one camera-facing quad per tree (yaw-free cylindrical billboard), the species' **canopy sprite**
  rendered by T12-A's Blender sheet step from LOD1 at ≈ 8° elevation (*fact-check, FF19*: a tree 180–460 m away is
  seen at ≈ 0–10°, not at the review sheets' 18°): 20 species × 256² RGBA in one texture array layer set (≈ 5 MiB VRAM,
  6.7 MiB with mips; ≈ 0.5 MB WebP download). The material is the PBR foliage path with a billboard vertex plugin (the
  same fog, SH, cloud shadow, night and wet handling as LOD1, so the hand-over does not change the lighting; no new
  varying, the 16-varying rule), alpha-tested, **no shadow casting**, and *(fact-check, FF19)* it **writes the
  prepass** on High / Ultra like LOD2: without it SSAO and SSR would see sky behind every card, TREES §W3.3's own
  objection to impostors [likely].
- **Hand-over F2 → F3**: per tree at its own distance in 180 ± 10 m (a hash), with GRASS_FAR's band noise (0.027 /m,
  10 m) moving every tree's switch inward together, so the switch never lies on a circle; the card is sized to LOD2's
  silhouette (the validator's ± 10 %).
- **The canopy carpet**: the grass ring window (GRASS_FAR §3, 2 m texels, 832 m) gains a **forest channel** (canopy
  density, from the forest rows, boxed per region at commit). Ring C's tint darkens and cools the ground under forest
  density (× 0.80–0.88) from F2 outward, so the gaps between distant cards read as a forest floor in shadow, not as
  meadow. Its edge uses the same noise. *(fact-check, FF20)* The window's reach is ≥ 352 m (832 m, re-centred every
  48 m) [confirmed: GRASS_FAR §3], short of the cards' 380 / 460 m: the channel fades out by 340 m and the baked shade
  alone darkens the floor beyond, inside the haze.
- **The baked canopy shade** (Medium+): the converter bakes a soft dapple under each forest crown (the crown disc,
  feathered, × 0.85 at the trunk) into `terrain/<x>_<z>_forest.webp`; the terrain plugin multiplies it in on Medium+
  only (Low never fetches it, so Low's lightmap and look stay byte-identical). Ambient occlusion, not a sun shadow, so it
  coexists with High's CSM.
- **The horizon**: the stream ends at 400 / 480 m and the fog closes from ≈ 190 m on a clear noon (GRASS_FAR §6); the
  cards end at 380 / 460 m with a 40 m per-tree fade inside the haze.

### 5.5 Wind, tints, the camera-near fade [decision]

- Wind: the forest's thin instances use wave 12's foliage plugin with `SRO_FOL_VDATA` (per-vertex flex, phase,
  flutter); the overlay's instance pivot path is reused for F1 and F2 (the instance translation is the root). Cards sway
  with the gust wave as a whole (the ring's sheen clock).
- Tints: the overlay's per-instance tint offset (`uv2.y` slot, TREES §W3.4) carries the forest's tint byte, so all tints
  of a species stay one draw.
- **Camera-near fade** (D-F18): foliage fragments within 3 m of the camera, and leaf cards inside the camera → player
  capsule (radius 1.5 m), are screen-door dithered out (alpha-test threshold raised by a 4 × 4 Bayer value). The
  prototype's first Yeoha shot (the lab's 24 m camera) put a bamboo spray across the whole game view; the game's
  default camera (9 m, ≈ 4 m above the player; fact-check, FF11) sits at the height of the small pines' and mid trees'
  crowns, so in a dense forest it is often inside one.

### 5.6 Shadows [decision]

- **Medium**: no tree casts a dynamic shadow (as today); the baked canopy shade and the carpet carry the forest's shade.
- **High / Ultra**: F0 and F1 trees within 60 m (`foliageM`) cast through one **cut-out caster per species** (LOD1,
  thin instances, all around the camera); F2, F3 and bushes never cast. *(fact-check, FF9)* The first draft said "≤ 6
  shadow draws": a caster draws once per cascade it overlaps, High has **3 cascades** over 150 m and Ultra 4 over 250 m
  (`render/quality.ts`) [confirmed], and 6–9 species stand within 60 m in a forest [confirmed: the counts of §5.3]:
  **≈ 12–27 shadow-pass draws** [projected].
- **Rain shelter** *(fact-check, FF23)*: the shelter map renders only the region batches (TREES §W3.7), so rain would
  fall under the forest canopy; F12-R adds the F0/F1 casters' meshes to it [likely; hunt lens 11].

### 5.7 Per preset [decision]

| | Low | Medium | High | Ultra |
|---|---|---|---|---|
| Forest trees | **none** (retail only) | **all** | all | all |
| Bands F0 / F1 / F2 | — | 40 / 110 / 180 m | 56 / 154 / 252 m (× 1.4, FF8) | as High |
| Cards | — | 180 → 380 m | 252 → 460 m | as High |
| Bushes | — | 70 % (hash-thinned; they do not block) to 70 m | 100 % to 98 m | as High |
| Ground cover (grass kind) | — | on | on | on |
| Canopy shade, carpet | — | on | on | on |
| Shadows | — | none | LOD1 casters ≤ 60 m, 3 cascades (≈ 12–27 shadow-pass draws) | 4 cascades |
| Options → Forest | — | On / Off | On / Off | On / Off |

Options' sight (rangeScale) scales the bands and the card reach like every other band (wave 12's rule).

### 5.8 Memory and download [projected unless tagged]

- **Geometry**: the forest uses wave 12's 35 species glbs, which Medium+ already downloads for the retail swap
  [confirmed: every forest species is in the swap]; the instanced tiers need one unmerged copy of each forest species'
  `lod1` / `lod2` (*fact-check, FF21*: at the 60 B tree vertex, ≈ 0.10–0.16 MB per species, 20 species ≈ 2–3 MB)
  beside the overlay's LOD0 (wave 12's ≤ 0.45 MB per species; up to ≈ 6 forest-only species near the camera,
  ≤ 2.7 MB).
- **Instance data**: ≤ 2,500 matrices in F0–F2 (≈ 0.16 MB), ≤ 6,000 cards × 16 B (≈ 0.1 MB), CPU rows of the resident
  regions ≈ 0.1 MB.
- **Textures**: canopy sprites ≈ 5 MiB (6.7 MiB with mips); canopy shade maps 64 KiB per resident region on the GPU
  (R8 256²) ≈ 1.4–2.2 MiB for the 22–35 resident regions (Medium / High).
- **Total**: **≈ +11–15 MB** on Medium+ (*fact-check, FF21*: the first draft said ≈ +8–10), against **+130–320 MB** for
  the merge [projected vs confirmed]. Small against an 8 GB Mac's budget either way.
- **Download**: forest rows 0.22 MB brotli for the whole area [confirmed: `codec.json`] (≈ 0.27 MB with the thinning
  ramp [projected]), shade maps ≈ 2–4 KB WebP per forested region (≈ 0.5 MB), sprites ≈ 0.5 MB: **≈ +1.2–1.3 MB** for
  the whole area; **+0 on Low**; the trunk file is server-only (FF1).

---

## 6. Budgets and measurements

### 6.1 Budgets per preset (WAVE_PLAN8 §5 format; 1080p; dev PC = Ryzen 5 9600X + RX 9060 XT) [projected]

Baselines: wave 12's LAB-12 (running at the time of writing) and the wave-10 polish gate (Medium WebGPU plaza 3.9 ms,
crowd + 20 bots 13.7 ms, 13.0–15.1 across wave-10 runs; WAVE_PLAN8 §5.2 projects the 20-player plaza at ≈ 14.0–16.6 ms
with wave 12).

| Preset | Forest core p95 | Forest edge at dusk p95 | Plaza p95 | 20-player plaza p95 | Draws added (forest / plaza) | GPU dev | VRAM | Download |
|---|---|---|---|---|---|---|---|---|
| Low | unchanged | unchanged | unchanged | unchanged | 0 / 0 | 0 | 0 | 0 |
| Medium | + 0.5–1.0 ms | + 0.4–0.8 ms | + 0.1–0.2 ms | + 0.1–0.3 ms (crowded rule) | ≈ 26–38 / ≈ 8 (≈ 5 crowded) | + 0.3–0.6 ms (forest triangles ≈ 0.15–0.20 M submitted all around; ≈ −50–65 % with the frustum cull, FF10) | + 11–15 MB | + ≈ 1.2–1.3 MB |
| High | + 0.8–1.4 ms | + 0.6–1.1 ms | + 0.2–0.4 ms | + 0.2–0.5 ms | ≈ 30–46 + ≈ 12–27 shadow-pass / ≈ 15 | + 0.6–1.2 ms (bands × 1.4: ≈ 1.96 × Medium's band area) | + 11–15 MB | as Medium |

*(fact-check, FF7–FF9, FF21)* The draw, shadow and memory cells were corrected (first draft: ≈ 27 / 10, High ≈ 33 + ≤ 6
shadow / 12, + 8–10 MB); the High GPU cell grew with the × 1.4 bands. The p95 cells were not re-derived (no timing
could be run) and stay [projected]; the extra draws cost ≈ +0.4–0.7 ms CPU (§5.3), inside the Medium forest cells.

- **G1 holds everywhere** [projected]: forest scenes have no crowd and no town (the forest core's base CPU p95 is ≈ 1 ms
  on the dev PC, + 0.7 ms with the worst-case instanced forest: §6.2), and the 20-player plaza gains ≤ 0.3 ms with ≈ 5–8 draws (High ≈ 15; FF7); WAVE_PLAN8's 20-player corner
  (≈ 16.6 ms) is the thin one, and the crowded rule plus cut 4 (no bushes beyond 25 m) are its levers.
- **The M1 margin** (WAVE_PLAN8 G6, ≤ + 0.4 ms GPU p50 on the dev PC away from the sea): the forest core's + 0.3–0.6 ms
  GPU sits at the line [projected]; the levers are the bands (F1 to 90 m), the bushes' share and the card reach.
  *(fact-check, FF22)* G6 counts against G-11 for the whole wave, trees and terrain together, and wave 12 already
  projects most of it (WAVE_PLAN8 §5.2: trees ≤ +0.6 ms and terrain +0.2–0.4 ms on the M1 column) [confirmed]. For 12F
  the baseline is **G-12's** measurement: the existing views keep G6's lines (beach ≤ +0.15, elsewhere ≤ +0.4), and the
  forest core is a **new** view whose M1 cost is projected as the dev delta × 9–11 (+0.3–0.6 ms → ≈ +3–6 ms on an M1).
  The M1's real risk is **overdraw**: alpha-tested leaves (discard) defeat the hidden-surface removal of Apple's tiled
  GPUs, so every leaf layer in a dense core is shaded [likely]. Levers, in order: F1 to 90 m and bushes 50 % on Apple
  GPUs and iGPUs (WAVE_PLAN8's lever 13 pattern), cut 7, cut 8a; the Mac friend's check decides.

### 6.2 What was measured in this pass, and what was not

- **Not run: the GPU-locked, quiet-machine bench** [unknown]. The GPU lock was held by wave 12's integration
  ("I-12 editor-e2e + LAB-12", taken 11:25 EDT) for the whole window this pass could wait (until 13:39 EDT, 2 h 14 min,
  21 LAB-12 result files written meanwhile), and the machine never went quiet (CPU 9–91 %, sampled every 2 s). This pass
  rendered nothing while the lock was held after 11:25 (its lab tab idled at "done"), and never took the lock. The
  fact-check found the lock free at 13:57 EDT but the CPU at 34–52 % over 30 s, so it did not bench either.
- **Measured without the lock** (11:00–11:25, before LAB-12 took it; busy machine; not timing-grade):
  - the merged stand-in at the six views (§1.4): draws, triangles, resident geometry (deterministic, they stand);
  - the instanced prototype at the Yeoha view (§5.3): WebGPU Medium, 120 frames: **draws 41 → 93, CPU frame p95
    1.0 → 1.7 ms, p50 0.7 → 1.1 ms**, forest triangles submitted 0.30 M (all around) [confirmed: `smoke_*_webgpu.json`;
    the lab ran with `weatherLevel: 'off'`, so no wind vertex work in any lab number, FF23]; GPU timestamps
    were wired up afterwards (prof.js's method, `forest-lab.ts`) and read 1.2–1.7 ms GPU for the base scene in a
    4 s probe [confirmed, unlocked]; no GPU number for the forest yet.
  - CPU-only prototypes (no GPU): the skirt (§4.1: 7 µs per move), the band refill (§5.2: p95 0.10 ms), the codec
    (§3.9).
- **What it means**: the forest's CPU cost in the instanced form is ≈ +0.7 ms at the worst case (LOD2 to 400 m, +52
  draws), on a scene whose base p95 is ≈ 1 ms: G1 (16.7 ms) is not near in forest scenes [likely]. The thin cells are
  the 20-player plaza (wave 12's corner) and the M1's GPU (G6, overdraw), both decided at LAB-12F (§7.4) with the
  crowded rule and cuts 4, 7, 8, 8a as levers. LAB-12F runs with weather on (wind) and the thinning ramp's rows.

### 6.3 The bench to run (LAB-12F; the lab is ready)

`work/tmp/forest/lab/` runs as is (`cd apps/viewer && pnpm exec vite --config ../../work/tmp/forest/lab/vite.config.mjs`,
port 5243; `prep_lab.py` first). Under the GPU lock on a quiet machine, 300 frames, 3 runs, median p95, interleaved:

| Scene | URL parameters (`/forest-lab?…&frames=300&settle=90&png=0`) | Modes |
|---|---|---|
| Forest core | `view=yeoha&t=0.42` | `mode=base`, `mode=inst&reach=400` (LAB-12F's upper bound), `mode=inst&reach=180` (the build without cards) |
| Forest edge at dusk | `view=edge&t=0.78` | base, inst (reach 180) |
| Plaza | `view=plaza&t=0.42` | base, inst (reach 180) |
| Backends | `engine=webgpu` (GPU timestamps) and `engine=webgl` | — |

`bench_table.py` turns `shots/bench_<engine>_<view>_<mode>_r<n>.json` into the medians. The 20-player cells need the
game page and the bot harness (wave 12's LAB-12 tool), so they are LAB-12F's (§7.4), not this lab's.

---

## 7. The build plan (d)

Lane ids `F12-*`. Every lane runs `pnpm vitest run <its tests>` and `pnpm typecheck` before hand-off; nobody commits;
the lead integrates. The order is WAVE_PLAN8's: seams, lanes, a re-convert, integration, the bench, a hunt, fixers, a
final gate, an independent verify, then the user's checks and the deploy only on a new OK.

### 7.1 Step 0: seams (F12-0; one agent; effort S, 1 day; every edit additive, the Low guard green)

| Seam | File (owner after step 0) | What |
|---|---|---|
| S-FOR-W | `packages/world-render/src/world.ts` (one slot), `forest/types.ts` (new) | `World.forest: ForestPart \| null`, created on Medium+ when the manifest lists `forest`, disposed with the world; a `StubForest` |
| S-FOR-NEAR | `packages/world-render/src/trees/near-field.ts` (wave 12's T12-N owner signs off) | `NearField.setExternal(owner, species, matrices, tints)`: external band-0 instances joined to the species' overlay lists |
| S-FOR-GRASS | `packages/world-render/src/grass/ring-window.ts` | an optional forest channel in the ring window (absent = today's bytes) |
| S-FOR-NAV | `packages/nav/src/trunks.ts` (new), `apps/server/src/nav.ts` (one optional field) | *(fact-check, FF1, FF2)* the `nav-trunks.bin` codec ('SRNT' v1) and `MeshNav`'s optional trunk set (absent = today); a `skirt()` stub returning the straight chord. `nav.bin`, its decoder and the client's nav are not touched |
| S-FOR-MOVE | `packages/shared/src/{protocol,validate}.ts`, `apps/game/src/net/clock.ts`, `apps/game/src/world/jangan/heights.ts`, `apps/server/src/world.ts` (`arrivalTime`) | *(fact-check, FF2)* the optional `MoveState.via` (≤ 16 corners): validated, interpolated by path length, re-walked per segment, timed by path length; absent = today's bytes and behaviour |
| S-FOR-CV | `packages/convert/src/world/passes.ts`, `convert-world.ts` | the pass slot "forest" (no-op), the writer's `forest/` folder, the manifest field `forest: { file pattern, species }` |
| S-FOR-ED | `packages/shared/src/world-edits/**` | the forest paint layer decode / encode; the forest uid ranges in the S-UID registry |
| S-FOR-OPT | `apps/game/src/settings.ts`, `hud/options.ts` | `graphics.forest: 'on' \| 'off'` (absent on Low) |

Tests: `forest-seams.test.ts` (no forest in the manifest = today's world byte for byte; Classic makes nothing),
`nav-trunks-format.test.ts` (`nav-trunks.bin` round-trips; `nav.bin` and the chunks are byte-identical with and
without the forest; a server without the file walks as today), the existing Low guard (`seams-classic`,
`release-lowguard`, `abuse-w9f-lowguard`, `abuse-w10r-lowguard`, `abuse-w11-lowguard`; the last was missing, FF23).

### 7.2 Step 1 lanes (parallel after F12-0)

| Lane | Owns (files) | Tests | User check | Effort |
|---|---|---|---|---|
| **F12-P** placement pass | `packages/shared/src/forest/**` (node-free: masks, potential, sampling, species, exclusions, rows codec, the forest edits), `packages/convert/src/world/forest/**` (the pass, the shade bake, the trunk file, the report), `content/forest/forest.json` | `forest-pass.test.ts`: deterministic bytes; every exclusion on fixtures (a road, a nest, a seat, the town box, a 45° slope, a bank); spacing ≥ the class rule; trunk gaps ≥ 3 m; uid stability (a local Clear and a Thicken change only trees within one spacing); **order-free borders** (region A run alone with its strip = A in a full run; FF17); sites inside their region; the scale byte's 0.25–1.25 range; the slope sink (five samples); forest drops / moves applied and a stale one warned (FF14); the thinning ramp; counts per area within ± 10 % of `factcheck/stats-ramp.json` on the real export; the corridor check; the shade bake under a crown | the coverage map of the new export | M (2 days) |
| **F12-N** nav skirt | `packages/nav/src/trunks.ts` (the skirt and the trunk set), `reach.ts` (the pocket check), `apps/server/src/nav.ts` (`MeshNav` loads `nav-trunks.bin`; `walk` skirts), `apps/server/src/world.ts` (`walkEntity` sends the corners as `via`; `canWalk` refuses trunk circles) | `nav-skirt.test.ts`: a chord past one trunk bends around it and arrives; two trunks; a destination inside a trunk; a start inside a trunk walks out; the wide-turn rule (corner ≤ 2 R from the centre); the 8-skirt cap; a skirt corner in a closed tile or a solid stops; every `via` segment clears every circle; a move without `via` is byte-identical to today's; the client's interpolation and the server's live point agree along the corners; mob wander and chase never stuck at a trunk (10,000 seeded wanders); the retail tree conversion (D-F11) and check 4b | walk through Yeoha's Forest clicking far: never stops at a trunk, never passes through one on screen, no pause at a corner | M (2 days) |
| **F12-R** forest renderer | `packages/world-render/src/forest/{index,data,bands,tiers,stats}.ts` | `forest-bands.test.ts` (bands × range scale with High's 1.4, hysteresis, refill after 4 m or a ≥ 10° turn, the frustum cull of the cells (FF10), every tree in exactly one tier); `forest-tiers.test.ts` (NullEngine: draws = species × tier × material; no mesh drawn at count 0, hidden with `isVisible`; the overlay seam never doubles a tree; dispose frees everything; Low and Off make nothing); `material-budgets.test.ts` registry lines | walk from the plaza into Yeoha: no pop, no gap, no double | L (3 days) |
| **F12-C** far forest | `forest/cards.ts`, `forest/cards-plugin.ts`, the ring window channel (`grass/ring-window.ts` part via S-FOR-GRASS), `grass/tint.ts` (the carpet term), the terrain plugin's shade multiply (`pbr/terrain-plugin.ts`, one define), `packages/convert/src/trees/blender/render_sheet.py` (the canopy sprite) | `forest-cards.test.ts` (the F2 → F3 hand-over: each tree in one tier at every distance; the band noise moves inward only; the card ring's cull; the card material writes the prepass on High and adds no varying, FF19; the carpet channel fades by 340 m, FF20); `grass-far.test.ts` additions (the forest channel's absent = today's bytes); a pixel test of Low's terrain (unchanged) | look to the horizon from a hill: forest all the way, no edge | M (2 days) |
| **F12-E** editor | `apps/viewer/src/editor/forest-tool.ts` (new), its panel rows, `apps/viewer/editor-api/publish.ts` (the forest steps; WORLD_EDITOR's lane signs off) | `editor-forest.test.ts`: paint → save → the pass gives the expected rows; a dropped or moved forest tree (in `forest/edits.json`, FF14) stays so across a re-run, and a stale one is a warning; `placements.json` untouched by forest edits; Publish refuses a corridor hit, a pocket and a component that grew (check 4b); undo / redo bit-exact | paint a clearing in Yeoha, plant a grove, publish | M (1.5 days) |
| **F12-L** lab + options + bench | `apps/viewer/src/world/forest-panel.ts` (`?forest=on|off`, a tier colouring view, counters), the LAB-12F scenes in the bench tool | `settings.test.ts`: the row on Medium+, absent on Low | Options → Graphics → Forest: On / Off | S (0.5 day) |

**Merge order**: F12-0 → F12-P → F12-N → F12-R → F12-C → F12-E → F12-L.

### 7.3 Checkpoint X-F: the re-convert

After F12-P and F12-N land: the full convert (duration [unknown]: the first draft's "≈ 73 s" has no source, FF23) and
the full optimize-out (≈ 15 min, WAVE_PLAN8 D26) under the convert lock (`work/out/.convert.lock`), then the forest
report: counts per area against `factcheck/stats-ramp.json` (± 10 %), the checks of §4.4 (all green, including the
object-outline half of check 2 and check 4b), the coverage map, and `nav-trunks.bin` against the rows (every playable
tree once, its radius from the species' stats) with `nav.bin` changed only by D-F11's removed instances. The dev server
is restarted by the lead only.

### 7.4 I-12F integration and LAB-12F bench

- **Integration checklist**: the forest on Medium and High, both backends; Low's plaza and a field pixel-identical to
  wave 12 (the Low guard + a pixel diff); the editor round trip; the server on `nav-trunks.bin` and D-F11's `nav.bin` (a bot walks the
  Qilin routes and twenty random forest clicks).
- **LAB-12F scenes** (WAVE_PLAN8 §5.4 method: 400 frames, three runs, median p95, GPU lock, quiet machine, Medium and
  High, WebGPU and WebGL2):
  1. **a forest scene**: Yeoha's Forest core, the game camera, noon;
  2. **a forest edge at dusk**: the Lake Forest edge to the Grassland, the game camera, 18:45;
  3. a wide view from the North-Tiger slope (the card ring to the horizon);
  4. **the plaza** (unchanged within the noise) and **the 20-player cells** (the crowded rule on);
  5. the walking watchdog: plaza → Yeoha at run speed, no frame > 16.7 ms (refills, region commits, card cells).

### 7.5 H-12F: the hunt (read-only; findings become failing tests, then F-12F fixes)

1. **Nav traps**: a pocket between a trunk and a wall or a cliff; a skirt corner in a closed tile; a 9-trunk chord; a
   bot stuck at a trunk; a `via` corner drawn wrong (a cut corner through a trunk, a yaw snap, server and client apart
   mid-move; FF2); the wide turn next to a trunk (FF3); a login inside a trunk circle; D-F11 joining ground that was
   closed (FF15).
2. **Floating and buried trees**: region seams, the coast's re-snapped ground, the editor's height edits after a forest
   run (the pass runs after the edits, so a stale layer is a bug), trunks on 30–44° slopes (FF18).
3. **Trees in the wrong place**: in water, on roads and paths, inside camps' cores, on beaches, in the town, on the
   Tomb's steps, on a Thunder Seat, inside a retail rock.
4. **Double draws with the swap**: a forest tree on top of a retail tree, a tree in two tiers, the overlay drawing a
   forest tree twice, a forest tree and its editor carrier both drawn after a Move.
5. **Far-forest edges**: the F2 → F3 hand-over visible as a ring; the card ring's outer fade; the carpet's edge; cards at
   night, in rain and fog, at dusk (the bench's dusk scene).
6. **Hitches**: a refill in a forest core, a region commit with 132 trees + 448 bushes, the card cells, the first
   forest species in band 0 (shader compile).
7. **Low changed**: any byte of Low's output, the lightmap, the minimap.
8. **Editor round trip**: paint → publish → reload → the same rows; revert; a drop surviving a re-run; a pasted grove.
9. **Camera inside crowns**: the near fade on both backends, with the camera at 4–40 m.
10. **Monsters**: packs chasing through forest, archers' lines of sight (CLIMB's roles), Tiger Girl's camps.
11. **Quests and life**: quest targets, butterflies and birds (GRASS_LIFE) in the forest, fireflies at night; rain
    under the canopy (the shelter map, §5.6).
12. **Memory**: Medium VRAM on an 8 GB Mac budget while walking the Tiger Mountains.
13. **The minimap and world map**: forest shown (the converter draws the canopy at 4 m per pixel) or not (Q-F4).
14. **The Qilin chase** (STORM_QILIN): flight paths over forest, the seats' clearings, the bolt's target.

### 7.6 F-12F fixers, G-12F final gate, V-12F verify

- **Fixers**: one per file set (the owning lane's files), each fix with the hunt's test; a fix that changes a frame
  cost is re-measured on its LAB-12F scene.
- **Final gate (G-12F)**: re-bench every LAB-12F scene on the final tree and export under the GPU lock on a quiet
  machine: G1 (Medium < 16.7 ms p95 everywhere, both backends, the 20-player cells included), G2 unchanged lines, G4
  (draw lines: forest ≤ 40 per scene on Medium and ≤ 48 on High, *fact-check, FF7*: the first draft's ≤ 30 failed at
  four of the six measured views; plaza world draws within wave 12's G4), G6 (the M1 margin against G-12, FF22), the
  Low guard, the suite and typecheck green.
- **Independent verify (V-12F)**: a fresh agent re-reads this spec and the diff; checks each never-cut item; re-derives
  three cells (the forest core Medium WebGPU p95, the 20-player plaza Medium p95, the forest draws); counts trees per
  area in the export against the report; walks 50 random forest clicks on the server's nav (no stop at a trunk); reports
  [confirmed] / [failed] per item.

### 7.7 Step order and effort

```
step 0:  F12-0 (seams)                                                  1 day
step 1:  F12-P | F12-N | F12-R | F12-C | F12-E (after S-FOR-ED) | F12-L     ≤ 3 days in parallel
X-F:     full re-convert + optimize                                     ≈ 0.5 day
step 2:  I-12F + LAB-12F, H-12F, F-12F                                  ≈ 2 days
G-12F, V-12F, the user's checks                                          ≈ 1 day
```

≈ 9–11 agent-days in all; ≈ 6–7 calendar days with the lanes in parallel [projected]. GPU queue (WAVE_PLAN8 §6.1):
the canopy sprites (≈ 2 min of Blender), LAB-12F (≈ 40 min), the final gate (≈ 40 min); nothing overnight.

---

## 8. Scope-cut order (cut from the top) and never-cut

1. **Retail tree footprints → circles** (D-F11): retail trees keep their squares.
2. **The baked canopy shade** (keep the carpet tint).
3. **High's forest casters** (High has no forest shadows, like Medium).
4. **Bushes beyond 25 m** (P1 off; the grass ring carries the ground).
5. **The editor's per-tree Move** (keep paint, clear and Delete).
6. **The scenery ring outside the bounds** (no forest beyond the playable regions; the cards stop at the bounds).
7. **Cards beyond 250 m** (the carpet alone from there).
8. **The F2 LOD2 band** (cards from 110 m).
   - **8a** *(fact-check, FF7; tried before 8)*: F2 draws one LOD2 per **archetype** (conifer, broadleaf, weeping,
     swamp, dead) with the species' tint, instead of one per species: −3 to −6 draws in a forest view; at 110–180 m
     the silhouettes of one archetype differ little.
9. **Ground cover's fern kind** (the grass field unchanged under forests).
10. **Groves and lone trees in meadows** (forests and edges only). **Ask first.**

**Never cut**: dense natural cover with soft, irregular edges in every forest area (cores, edges, slopes, banks);
**batching** (instancing per species × tier, no per-tree draw, no region merge of the forest); **walkable routes** (the
skirt, the gaps, the corridor and reachability checks); **G1**; Low unchanged; the seeded deterministic pass and the
editor's forest erase.

---

## 9. Risks

| Risk | Default handling |
|---|---|
| A skirted move drawn as a straight line through the trunk (one `MoveState` per move, linear interpolation on every client; FF2) | the optional `MoveState.via` corners, interpolated by path length; no client skirt, no client trunk data, so no V8 / JavaScriptCore question; fallback: a chain of straight moves (a small snap per corner) |
| Draws in a dense mixed forest exceed ≈ 40 (measured species counts give 26–38 on Medium, 30–46 on High; FF7) | ≤ 3 species per size class per biome (D-F13), LOD2 in one material, the crowded rule, cut 8a (LOD2 per archetype), cut 8 |
| The M1 margin (GPU) in forest cores: alpha-test overdraw on a tiled GPU (FF22) | F1 band to 90 m on Apple GPUs and iGPUs, bushes 50 %, the frustum cull (FF10), cut 7, cut 8a |
| Cards look flat when the camera orbits | they start at 180 m (≥ 150 px for a 30 m tree only at the very start); per-species sprites from the game pitch; Q-W6's impostor revival only if the lab shows it |
| The camera inside crowns hides the player | the near fade (D-F18); the hunt lens 9 |
| Invisible trunks on Low | ≤ 1 m path bends (§4.6); Q-F1 |
| Monsters' sight lines through forests make fights unfair | the × 0.55 thinning in spawn circles, the 10 m cores, the camps' exclusion rows in `forest.json` |
| The wave-12 build changes the overlay or the swap meanwhile | S-FOR-NEAR is signed off by T12-N's owner; F12-0 rebases first |
| A forest file stale after an editor height edit | the pass runs after the edits pass at every convert and Publish; the hunt lens 2 |
| A Publish of one region differs from a full convert near its borders (FF17) | order-free border strips, tested by "region alone = full run" |
| A forest edit pointing at a site that a re-tune changed (FF14) | `species` + `from` stored with each edit; a mismatch is a Publish warning |

---

## 10. Needs from the user, open questions

### 10.1 Needs from the user (each has a default; nothing blocks the build)

1. **The look of the density** (`forest-preview.png`, `map-before-after.png`). Default: proceed with these densities;
   a tuning round is one number in `content/forest/forest.json`. *(fact-check, FF5)* The preview shows the prototype's
   rule (spawn circles halved); the build's thinning ramp is ≈ 24 % denser (cores ≈ 42 trees/ha instead of ≈ 34).
2. **The deploy OK** for wave 12F (as every wave). Default: no deploy until asked.

### 10.2 Open questions (each with its default)

| # | Question | Default |
|---|---|---|
| Q-F1 | Should Low draw the far card ring (1 draw) so its invisible trunks are not invisible? | no: Low unchanged; trunks bend paths by ≤ ≈ 1.1 m (max 1.06 m measured) |
| Q-F2 | Should the Grassland around the town get more than groves? | no: meadows stay open around the newbie fields (CLIMB B1) |
| Q-F3 | Autumn colours (red maples) anywhere? | ≤ 10 % red accents in mixed forests; a seasonal switch is a later wave |
| Q-F4 | Should the minimap and world map show the new forests? | yes, a darker green canopy at 4 m per pixel, drawn by the converter |
| Q-F5 | Retail tree footprints → circles (D-F11) | yes (cut item 1 if it causes any surprise) |

---

## 11. Images and files

- `work/tmp/forest/forest-preview.png` (also Dropbox `wave12/forest-preview.png`): before / after, game camera and
  aerial, six prototype regions, plus the coverage maps.
- `work/tmp/forest/survey-map.png`: today's coverage (retail crowns, bare suitable ground, nests, NPCs).
- `work/tmp/forest/map-before-after.png`: the playable area before and after the pass.
- `work/tmp/forest/map-biomes.png`: the target density and biome per cell, the prototype regions boxed.
- `work/tmp/forest/shots/look_*.png` (game camera and aerial, today and merged), `shots/*.json` (draws, triangles,
  memory per run), `shots/smoke_*_webgpu.json` (the instanced smoke run). The look shots were taken with the pass
  before the ± 44 m biome warp (§3.10); the warp changes only which species stand near region borders, the rows'
  positions and counts are within 3 trees of the final run.
- Results: `survey.json`, `forest-stats.json`, `walk-check.json`, `pockets.json`, `skirt.json`, `refill.json`,
  `codec.json`, `nav-trees.json`.
- Fact-check (`work/tmp/forest/factcheck/`): `place_edit.py` (the pass with `TAG`, `CLEAR=x,z,r` and `THIN=ramp`;
  `rows-*.json`, `stats-*.json`, `zones-*.npz`), `zones.py` → `zones-base.json`, `zones-ramp.json`; `zones2.py` →
  `zones-by-target.json`; `nest_share.py` → `nest-share.json`; `edit_locality.py` → `edit-locality.json`;
  `bands_species.py` (species and draws per tier at the lab views); `skirt-worst.ts` → `skirt-worst.json`;
  `edit5.py`, `edit6.py`, `edit7.py` (the doc edits).
- Scripts: `common.py`, `survey.py`, `tiles_census.py`, `sizes.py`, `nav-trees.ts`, `place.py`, `maps.py`,
  `walk_check.py`, `pockets.ts`, `skirt.ts`, `refill.ts`, `codec.ts`, `sheet.py`, `bench_table.py`,
  `lab/{prep_lab.py, vite.config.mjs, forest-lab.ts}`.
