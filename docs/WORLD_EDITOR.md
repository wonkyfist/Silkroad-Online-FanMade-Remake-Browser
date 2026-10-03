# The World Editor (wave 12, the editor part)

> **Status (2026-10-02, I-12): built in wave 12** (commits 2b7450b, 3a5fb7c, cf6dc87 and the I-12 commit); the
> user's guide is docs/EDITOR_GUIDE.md. docs/WAVE_PLAN8.md's decisions override this spec where they differ: the five
> step-0 seam agents (W12-P/SA/SB/CV/G, D1-D15), `texpipe hero` as the only hero flip (D7, D19), the species' LOD1 in
> the object-shadow bake (D18), the editor never publishing on the main export during the build (D37), and the
> sound-zones file named `zones.json`. The Water, Lights and Sound tools are dimmed (a later step); the Walkable brush
> (§4.7) is built (2026-10-03).

The user, verbatim:

> I want world editor as wave 12

(after asking to "improve some map stuff my self"). The editor the lead proposed, which the user took:

> a GM-only editor in the browser on this PC: terrain brushes (raise, lower, smooth, flatten; paint grass, sand, dirt,
> rock, road), grass and flower painting, placing/moving/rotating/scaling/deleting trees, rocks, buildings, lanterns
> and stalls from the game's library with ground snap, water levels, lights, sound zones, town walking routes and
> seats; edits layered over the original map (nothing destroyed), full undo, one-click revert per change, walkable
> areas rebuilt automatically, preview on this PC, then publish through Claude's checks and a deploy.

The same wave upscales every terrain texture (docs/TERRAIN_TEX.md) and replaces every tree and plant with new models
(docs/TREES.md, wave-12 update). This spec is the editor; it uses both (the paint palette is the upscaled tile set,
§4.3; the library holds the new trees and plants, §4.5). Fishing, swimming and underwater are wave 13.

**The user is not a programmer.** Everything here is judged by one question: can the user open the editor, change
the map with the mouse, see it in the game's own look, undo anything, and publish without breaking walking or the
60 fps budgets, without reading a file or typing a command?

**The user delegated every decision.** Each choice below is the option this spec would mark "(Recommended)", written
as a decision with a one-line reason (§10). Only what truly needs the user is in §11 and §12, each with the default
used meanwhile.

**Tags** (as in WAVE_PLAN7):

- **[confirmed]**: checked in the code or data of the working tree on 2026-10-01, or measured by this spec's
  prototype (§9). Each says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived), not measured on that setup.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this spec makes. The user may overrule it.

**Repo state when this was written** [confirmed: `git log`, `git status`, 2026-10-01 15:32]: HEAD `19770ea` ("Wave 11
step 0: seams ..."); the wave-11 lanes are building on top of it in the working tree (uncommitted changes in
`apps/game`, `apps/server`, `packages/world-render/src/town`, `packages/convert/src/tools/export-sound.ts`, new
`content/uniques.json`, ...). This spec edits none of it. Its scratch is `work/tmp/world-editor/` (the prototype page
`editor.ts` / `editor.css` / `vite.config.mjs`, the dry run `publish-dryrun.ts`, the census `region_census.py`, the
shots and the saved layer in `out/`).

**Fact-check (2026-10-01, adversarial pass).** Every [confirmed] claim was re-derived from the code, the data or a
re-run (`publish-dryrun.ts` re-run, the census re-run, plus the new scratch `check-rule.ts`, `check-manifest.ts`,
`check-tiles.py` in `work/tmp/world-editor/`). What changed is listed in §F and fixed in place; the rest holds.

### §F What the fact-check corrected

| # | The draft said | What is true | Fixed in |
|---|---|---|---|
| F1 | LA16 height delta `L = round((dh + 128) / 256 × 65535)` | A zero delta does not decode to zero: `dh = 0` → `L = 32768` → **+1.95 mm** (24 of the prototype's 468 touched vertices sit within 5 mm of 0) [confirmed: `check-rule.ts`]. Now `L = 32768 + round(dh × 256)` (1/256 m = 3.906 mm steps, exact zero, −128 … +127.996 m), and the editor snaps its in-memory deltas to that grid at the end of each stroke, so the preview equals the export bit for bit | §3.1 |
| F2 | The dry run's 122 closed tiles of 527 are the §6.3 rule | The dry run closed any open tile touching a masked vertex with slope > 0.7, without the "moved > 5 cm" and "steeper than before by > 0.05" parts. The rule as written closes **117 of 443** tiles [confirmed: `check-rule.ts`]. The reachability numbers were taken with the 122 (a superset of the closures), so with the real rule they can only be equal or better [likely] | §4.2, §6.3 |
| F3 | Placement edits are "(move, drop, add): the C9 shape the converter already applies" | `PlacementEdits` has **drop, resnap (y only), add**; no move [confirmed: `passes.ts`]. `applyPlacementEdits` frees dropped keys before adds [confirmed: `passes.ts` `taken` after the drops], so the editor lowers a move to a **drop + add of the same `(region, uid)`**: no new apply code. Its warnings ("the converter never aborts") become Publish errors in the editor's validator | §3.2, D10 |
| F4 | The coast and the town dressing get uid ranges in one registry | The wave-11 dressing numbers its props **`TOWN_UID_BASE` = 1,000,000 + row order per region**, and a skipped row consumes nothing [confirmed: `town/dressing.ts` 42, 579]: a dressing uid moves whenever a row before it is added or skipped. The coast adds no placement today. So dressing props are never edited by uid: the editor edits their rows in `content/town/jangan-dressing.json` (by row `id`, which it adds when missing). Editor adds stay in 0xE000–0xEFFF because a nav instance id is `regionId << 16 \| uid` (16-bit uid) [confirmed: `packages/nav/src/data.ts`] | §3.2, D11 |
| F5 | Moving a placement into a neighbour region "changes owner at Publish" | Retail uids repeat across regions, so keeping the uid in the new owner can collide. A move whose origin leaves its owner region takes a **fresh editor uid** in the new owner (a drop + an add under the new key) | §4.6 |
| F6 | `scale` exists for footprint-free models (D12); TREES §W3.9 places species at ±15 % | **No placement carries a scale**: `WorldPlacement` has position, rotation, yaw only, and every compose site uses scale 1 (`objects.ts` 163 / 625, `batch/region-batch.ts` 164, `batch/trees.ts` 281, `ambient-fx.ts`, `life/spawn.ts`, `town/fx.ts`) [confirmed: grep]. The dressing scales by writing a **scaled copy of the model** [confirmed: `dressing.ts` header], but a scaled copy of a retail tree has a new source, escapes the swap (keyed by retail source) and would draw the **retail** tree. New seam **S-SCALE** (an optional uniform `scale` on `WorldPlacement`, honoured at those sites); trees may scale 0.85–1.15 although they carry footprints (the nav keeps the unscaled footprint); no tilt this wave | §3.2, §4.6, D12, lanes |
| F7 | New trees: "the retail model that `swap.json` maps to Maple A" | Many retail sources map to one species. TREES §W3.9 defines the editor's tree library: `content/trees/library.json` (one entry per species with its **carrier** model) and the T12-E API `World.trees.library() / preview() / setHidden()` (band byte 3 hides the merged copy while dragging; re-merge on drop). The editor uses that for trees and S-OBJ for everything else. The band texture holds **8,192** slots (5,586 tree placements today) [confirmed: TREES §W3] | §4.5, §7.2, D25, WE-L |
| F8 | Lightmap / minimap "redrawn inside the change mask" (height changes) | Retail terrain lightmaps hold **baked object shadows** (trees, buildings) [confirmed: `terrain/171_97_lightmap.png`, `168_97_lightmap.png` rendered to `out/lm_*.png`]; on Medium no tree casts a real-time shadow (TREES §1, `foliageM` 0), and beyond the CSM range (60 m on Medium) and on Low the lightmap is the only object shadow [confirmed: `pbr/terrain-plugin.ts` header, RENDER §3.4]. The coast's baker is heightfield-only [confirmed: `coast/lightmap.ts`]. Without a fix, a moved or deleted object leaves a **ghost shadow** and a placed tree has **no ground shadow** on a Mac's Medium. Now WE-D bakes object shadows too (§6.2 step 2). The minimap likewise shows objects: the edit pass reuses the coast's rule for dropped footprints and draws adds as discs [confirmed: `coast/minimap.ts` header] | §6.2, WE-D |
| F9 | Publish "splices `nav.bin`" | The client streams **`nav-objects.bin`** (every instance and link) plus `nav/<x>_<z>.bin` chunks; only the server reads `nav.bin` [confirmed: `world-render/src/nav.ts` `loadNavStreamed`]. A footprint edit rewrites `nav.bin`, `nav-objects.bin`, the touched chunks and the debug `navmesh/` bins. The nav is built **before** the objects and the placement passes (`convert-world.ts` sections 560 → 739 → 828) [confirmed], so footprint edits are applied in the nav step from the same `placements.json` by the same pure function | §6.2, §6.3 |
| F10 | (missing) | The walk preview of a moved footprint needs a nav seam: `NavWorld` has `addRegion / removeRegion` but no instance edit [confirmed: `packages/nav/src/world.ts`]. New seam **S-NAV** | §2.3, WE-S |
| F11 | `pnpm editor` on 127.0.0.1:**5190** | 5190 is texpipe's `DEFAULT_REVIEW_PORT` [confirmed: `packages/texpipe/src/review.ts` 39], used by this wave's review sheets. Now **:5185** with `strictPort`, its own Vite `cacheDir` (two Vites on one root share `node_modules/.vite`; the prototype already used its own [confirmed: `vite.config.mjs`]), and a `Host` header check besides the Origin (DNS rebinding) | §2.2 |
| F12 | `/editmap` prints `…/editor.html?at=x,z` | That link carries no session token, so the API would refuse it. Now a tokenless `?at=` page only asks the open editor tab to fly there (`BroadcastChannel`, same origin) or says how to start the editor; on the live server `/editmap` says the editor runs on the host PC. `apps/server/src/gm.ts` is being edited by wave 11 [confirmed: `git status`], so this lands after it | §2.2 |
| F13 | "Test in game": staging `jangan-fields@edit`, the game opened "logged in as the user's GM character" | `WORLD_EXPORT` must match `WORLD_FOLDER` (a–z, 0–9, `-`) or the server throws [confirmed: `apps/server/src/config.ts` 329]: now **`jangan-fields-edit`**. The client reaches the server through the game Vite's proxy, fixed at start by `SRO_SERVER` (default :7000) [confirmed: `apps/game/vite.config.ts` 10, 167], so a **private game Vite** (own port and cacheDir) starts too. The editor never logs in for the user: the user logs in with their own account; the DB copy grants it GM (as X2 did [confirmed: NIGHT_LOG 00:18]) | §2.4 |
| F14 | Publish swaps the staging export in by a directory rename; staging uses hard links | On Windows a directory rename fails while a dev server holds a file in it [likely]; and writing **in place** into a hard-linked staging file would change the live file too. Now: never write in place (temp + rename per file), the swap replaces only the changed files (manifest last), and the replaced files are kept in `publish-<n>/backup/` | §6.2 |
| F15 | (missing) | The wave builds re-convert `work/out` themselves; Publish now takes a convert lock (`work/out/.convert.lock`, also taken by `convert-region`, seam in WE-CV) and waits while another convert runs | §6.2 |
| F16 | Deploy = "the existing `pnpm run deploy`" | `deploy.sh` ships the **committed code at git HEAD** plus the assets [confirmed: `deploy/deploy.sh` header, 134–145]. Mid-wave, HEAD can be an ungated step commit (today: "Wave 11 step 0: seams"). Now the editor's Deploy runs `pnpm run deploy -- --assets-only` [confirmed flag], and is refused when the converter code (`packages/convert`, `shared`, `nav`, `formats`) has uncommitted changes (the export was made by unfinished code) | §6.1, D36 |
| F17 | The incremental convert runs the passes "on the previous manifest's list" | The manifest's list is **after** the passes; running C9 and the dressing on it again would double-apply (dressing adds collide). The incremental convert caches the objects step's pre-pass list and models from the last full convert | §6.2 |
| F18 | Town routes and seats are edited in `jangan.json` in place | `pnpm sro town-graph` **regenerates** nodes, edges, places and seats from the nav on every run and keeps only the authored parts (hour curve, lines, population, role shares) [confirmed: `town/build-graph.ts` header]: in-place edits would be wiped, and a Publish that changes the town's ground or objects needs a graph rebuild. Now the editor writes an authored overlay that build-graph keeps and applies after regeneration, and Publish re-runs town-graph when the town box is touched | §4.11, D32, WE-T |
| F19 | Palette groups come from `typeName` and the grass weight [confirmed] | `typeName` gives only Dirt 62, Grass 17, Stone 12, Water 6, Mud 6, Sand 5; no tile is named road or paving (the town's paving is `c_marble_jang_*`, roads are `*_dust_*`) [confirmed: `check-tiles.py`]. A curated `palette.json` (108 rows) groups them; `typeName` is the fallback | §4.3 |
| F20 | The draw meter's "Medium line 180 draws" [confirmed: budgets.md] | No such line exists. budgets.md measures 152 (Medium) / 218 (High) engine draws at the plaza on WebGPU; the gate is G4: world draws at the plaza ≤ 70 Medium / ≤ 100 High (main + shadow, post excluded) [confirmed: WAVE_PLAN6 §5.4] | §5, §7.2 |
| F21 | Budgets judged on Medium; "+0.3–0.5 ms GPU" at the 60 k warn line keeps 60 fps | Friends with dedicated GPUs start on **High**, Macs on Medium [confirmed: `w9-user-decisions.md`]. WAVE_PLAN6 projects a base M1's GPU at ≈ 9–11× the dev PC's (1.1 → 9.5–12.6 ms at the plaza) and the M1 Medium beach at 11–15 ms. +0.3–0.5 ms on the dev GPU is ≈ +3–5 ms on an M1 [projected]: a region at the warn line in a beach view could cost Mac friends 60 fps. Now the Publish bench covers Medium **and** High on both backends, with an M1 margin on the GPU delta (§7.2) | §7.2, §8, D43 |
| F22 | Low: "lights: no"; free points only feed the point-light container | The night-light **splat** (terrain and grass glow) is baked on every preset, Low included [confirmed: `night-lights.ts` header], so free points light the ground on Low too (a CPU bake at region commit). The container is 8 / 32 / 64 only where clusters are supported, else 2 plain lights | §4.9, §8 |
| F23 | Grass masks: "+0 download" | The grass bake runs on the client (`grass/bake.ts`), so the masks must ship: a per-region mask file listed in the manifest, ≈ 2–20 KB per painted region [projected] | §8 |
| F24 | Per touched region "≈ 0.3–0.5 MB raw (terrain bin 130–280 KB, lightmap ≈ 26 KB …)" | Raw bins are 131–352 KB; players download `out-opt`: for 171_97, bin.br 63 KB + lightmap WebP 15 KB + minimap WebP 28 KB + nav chunk br 33 KB ≈ **0.14 MB per region**, plus per publish up to `manifest.json.br` 232 KB, `nav-objects.bin.br` 141 KB and `worldmap.webp` 646 KB [confirmed: file sizes]. Unhashed names are served `no-cache` + ETag, so a reload fetches them [confirmed: `apps/server/src/static.ts` 169] | §8 |
| F25 | "700 nests placed and 91 skipped as unreachable" | NIGHT_LOG 13:10: 700 nests (125 skipped), 91 unreachable | §1.3 |
| F26 | The paint palette is "TERRAIN_TEX: every one of the 108 tiles remastered" | `docs/TERRAIN_TEX.md` is not in the tree yet (the sister spec is being written in parallel) [confirmed: `ls docs`]: the upscaled set is [projected] | §4.3 |
| F27 | D47: pause rendering while another owner holds the GPU lock | A long GPU batch (an SDXL run) can hold the lock for hours. Now the editor **renders on demand** (no frames while nothing changes, as editors do) and shows a banner while another owner holds the lock | D47 |
| F28 | Keys: Smooth S, Move W / E / R, and the camera's WASD fly (§12 q4) | They collide. WASD flies only while the right mouse button is held (the usual editor convention); otherwise the keys pick tools | §5, §12 |
| F29 | Risks: only `passes.ts`, `convert-world.ts`, world-render | More shared files: `world.ts` (S-FILTER vs TREES T12-0's `World.trees` slot), `batch/trees.ts` and `batch/region-batch.ts` (S-SCALE vs T12-M), `water.ts` (wave 11 W11-S), `gm.ts`, `town/build-graph.ts` (TL-R), `apps/game/src/audio/town.ts` (zones beside its loops) | §13, §15 |

---

## 0. Summary

1. **Where it runs (§2):** a fourth page of the existing world viewer, **`apps/viewer/editor.html`**, started by
   `pnpm editor` on this PC only (127.0.0.1:5185, a per-session token), with a small local **editor API** (a Vite plugin in
   Node) that reads and writes the edit layers and runs Publish. It draws with the game's own renderer
   (`loadWorld`: PBR, region batching, the new grass and life, the ocean, the town, the sky) at High by default (what a
   dedicated-GPU PC starts on), with Medium and Low toggles to see what Macs and the N100 see. Edits show **live, without a re-convert**: the brush writes the region heights in memory and
   re-uploads that region's mesh in **0.39–0.92 ms** [confirmed: prototype, 280 updates per session, three
   sessions]. The editor is never built or served for players: the mini PC builds only `@sro/game` [confirmed:
   `deploy/remote/install.sh` line 68]. A GM command in the game (`/editmap`) is a convenience link, not the editor.
2. **Data (§3):** every edit is a **layer over the exported map** in `content/world-edits/jangan-fields/`, versioned
   in git: per-region height deltas (16-bit PNG, −128 … +128 m in 1/256 m steps with an exact zero, the coast's LA16
   container), per-region texture paint, grass and flower masks, walkable overrides, one placement-edit list keyed by
   `(region, uid)` (move, drop, add; a move is applied as C9's drop + add of the same key), water, lights and sound
   zones, and authored overlays on TOWN_LIFE's files (routes and seats; the dressing's props by row). The retail client and the export are never modified; the converter applies the layers
   as a new pass after the coast (§3.6). An **edit journal** (every stroke, move and add, with its own difference)
   gives undo / redo, **revert this one change**, revert a region, revert to retail; git holds every published state.
3. **Tools (§4):** Raise, Lower, Smooth, Flatten, Noise; Paint (the upscaled tile set: grass, sand, dirt, rock, road,
   ...); Grass and Flowers; Walkable (open / close ground for walking, rarely needed); Place from a thumbnail library
   (retail props and buildings, and this wave's new trees and plants), Move / Turn / Scale / Delete with a gizmo,
   ground snap, multi-select, copy / paste; Water (ponds); Lights; Sound zones; Town routes and seats; links to the
   existing GM Spawns / NPCs / Quests tabs in the game.
4. **Publish (§6):** **Save** writes the layers (≈ 0.1 s); **Publish** validates them, re-converts **only the touched
   regions** (plus a one-region ring for normals and baked light), **rebuilds walking** for them with the same pure
   function the editor previews, re-optimizes only the changed files (slim.json merged, never rebuilt), runs the
   checks (props buried or floating, cliffs closed, nobody trapped, every nest, NPC, gate, road and teleport place
   still reachable from town, budgets), runs the named tests, shows a before / after, and commits `content/` with a
   plain-English message. **Deploy** to the friends' server is a separate button with its own confirmation (the
   user's OK); it sends the assets only (`pnpm run deploy -- --assets-only`), never the half-built code of a wave in
   progress (§6.1).
5. **Safety and performance (§7, §8):** the editor's own cost never reaches a player. Edits are held to per-region
   guardrails measured on today's export (object triangles: p95 16.1 k, worst region 49.5 k [confirmed: census]): a
   warning at 60 k, a refusal to publish at 90 k; draws, lights, grass and sound zones have their own lines. Brushes
   respect the export's edge, the coast's sea mask and the playable bounds (outside them, look only). Nothing can
   make an existing nest, NPC, gate or road unreachable without the publish stopping and saying so.
6. **The prototype (§9)** on the real `jangan-fields` export, WebGPU, Medium, 1920 × 1080: a working **Raise / Smooth
   brush** (Lower is the same stamp with the sign flipped) with live preview (468 vertices, up to +14.3 m, **undo
   bit-exact**), and **one object moved with a gizmo** (a tree out of its region batch, moved 31.6 m, turned 40°,
   snapped to the raised ground), **saved as a layer** into `work/tmp/world-editor/out/layers/`; a **Publish dry
   run** applied that layer to the terrain and to `nav.bin` in memory: 122 cliff tiles closed by a simplified slope
   rule (117 with the §6.3 rule as written, §F2), 0 open tiles cut off, 0 of 53 nearby nests lost, traps unchanged
   (15 / 726.6 m²), one prop buried 10.7 m found, the moved tree's nav instance moved with it.
7. **The user does nothing to start.** The user checks (§11): a ten-minute session with the editor, then one
   Publish and one Deploy when happy.

### 0.1 Where each part of the request lands

| The request (verbatim fragment) | Where | Lanes |
|---|---|---|
| "improve some map stuff my self" / "world editor" | the editor page, §2, §5 | WE-U, WE-A |
| "terrain brushes (raise, lower, smooth, flatten ...)" | §4.1, §4.2 | WE-U, WE-D |
| "paint grass, sand, dirt, rock, road" | §4.3 (the upscaled set of TERRAIN_TEX) | WE-U, WE-D |
| "grass and flower painting" | §4.4 (GRASS_LIFE / GRASS_FAR masks) | WE-U, WE-D, WE-R |
| "placing/moving/rotating/scaling/deleting trees, rocks, buildings, lanterns and stalls from the game's library with ground snap" | §4.5, §4.6 | WE-U, WE-L, WE-D |
| "water levels" | §4.8 | WE-U, WE-D |
| "lights, sound zones" | §4.9, §4.10 | WE-U, WE-D, WE-R |
| "town walking routes and seats" | §4.11 (TOWN_LIFE's file) | WE-T |
| "edits layered over the original map (nothing destroyed)" | §3 | WE-P, WE-D |
| "full undo, one-click revert per change" | §3.4 | WE-A, WE-U |
| "walkable areas rebuilt automatically" | §6.3 | WE-N |
| "preview on this PC" | §2.2, §6.5 | WE-U, WE-A |
| "publish through Claude's checks and a deploy" | §6 | WE-I, WE-N, WE-A |
| standing goal "at least 60 fps" | §7.2, §8 | WE-N, LAB-WE |

---

## 1. What exists to build on [confirmed: read in the code and data, 2026-10-01]

### 1.1 The map data

- **Regions.** The export `work/out/world/jangan-fields/` has **414 regions** (307 converted + 107 synthetic sea), each
  a 192 m square with a self-contained `terrain/<x>_<z>.bin` (`SROT`: 97 × 97 heights in metres, normals, 97 × 97 raw
  texture words, the native per-cell layering), a lightmap PNG, a minimap tile, a debug navmesh, a nav chunk
  `nav/<x>_<z>.bin`, and its slice of `nav.bin` (307 regions, 23.3 MB) [confirmed: `manifest.json`,
  `packages/convert/src/world/format.ts` header]. The playable rectangle is regions x 156–174 × z 90–102
  (`stream.playable`) [confirmed: manifest].
- **Placements.** `manifest.placements` holds **6,965** placements of **503** models, each with an `objId`, source path,
  glTF position, rotation (yaw only; no placement has pitch or roll) [confirmed: count of non-zero x/z quaternion parts
  = 0], an owner `region` and an owner-unique `uid` [confirmed: manifest]. `(region, uid)` is the stable key the coast
  already edits by (C9, `packages/convert/src/world/coast/placements.ts`).
- **The placement passes** (`packages/convert/src/world/passes.ts`) run in a fixed order: coast C9 (drop, re-snap, add
  by uid) → town dressing (wave 11, TL-B: new props and their appended models, edits by uid) → cloth reclass → static
  variants → grass palettes; invariants live in one place [confirmed: file header].
- **The coast's authored layers** prove the container: `content/coast/height/<x>_<z>.png`, 97 × 97 16-bit grey +
  alpha, merged by weight, read with `sharp(...).toColourspace('grey16').raw({ depth: 'ushort' })`
  (`coast/authored.ts`). They are **refused inside the playable set** (the frozen check) except in the S1 patch
  [confirmed: `mergeAuthoredHeights`]. The editor's layers are a different pass with different rules (§3.6).
- **The full conversion** of `jangan-fields` takes **72.6 s** (terrain 28.0 s, objects 10.5 s, stream 16.2 s,
  textures 2.9 s, nav 0.8 s) [confirmed: `manifest.report.timeMs`]; the full **optimize-out takes 902–998 s**
  [confirmed: NIGHT_LOG, 2026-10-01 13:10 and 05:28]. A per-stroke re-convert is out of the question; a per-publish
  incremental one is the design (§6.2).

### 1.2 The renderer

- `loadWorld(scene, opts)` builds the whole wave-10/11 world (streaming, batching, grass and life, ocean, town, sky);
  every lab and the viewer use it [confirmed: `packages/world-render/src/world.ts`, `apps/viewer/src/world/main.ts`,
  `work/tmp/town-life/lab/town-lab.ts`].
- **Terrain** keeps each region's decoded bin in `world.regions` (`RegionData.terrain.heights` is the live array the
  height queries read) and builds one mesh per region (`TerrainRenderer.buildRegion`; PBR path: positions + normals
  from `terrainNormals`, which recomputes any normal whose baked value is zero) [confirmed: `terrain.ts`].
- **Streaming** has per-region commit steps (`addCommitStep(name, run, 'terrain' | 'objects')`), and a whole
  `rebuild()`; it has **no per-region reload** [confirmed: `stream.ts`].
- **Region batching** claims a region's static placements in `WorldObjects.addStatic` and merges them in a worker
  (≈ 15 ms per region budget) [confirmed: `objects.ts` `claim`, BATCHING §5]. A placement passed with region `-1` is
  never claimed and draws as a thin instance [confirmed: `NO_REGION = -1`].
- **The grass field** keeps references to the regions' height arrays and re-fills its window on demand
  (`GrassField.dirty`); its density comes from the splat and the slope (GRASS_LIFE §3.2) [confirmed: `grass/field.ts`,
  `grass/window.ts`].
- **Night lights** are (placement × ambient particle) pairs from `ambient.json`, picked into a container of
  **8 / 32 / 64** lights (Medium / High / Ultra) [confirmed: `night-lights.ts` header, TOWN_LIFE F4].

### 1.3 Navigation

- Terrain walkability is **per 2 m tile**: open when its cell index is below `openCellCount`; the walker has **no step
  and no slope limit**: walls are edges and closed tiles [confirmed: NAVIGATION §1–2, `coast/navgen.ts` header]. So
  a raised cliff stays walkable unless its tiles are closed; the editor must close them (§6.3).
- **Object footprints** are the collision navmeshes of `.o2` placements; `nav.bin` holds them as instances
  `(regionId << 16 | uid, objId, x, y, z, yaw)` [confirmed: `packages/nav/src/data.ts`]. **Trees have them too**:
  the prototype's moved `tre_tree01` (uid 32770) has a nav instance [confirmed: dry run, `movedHasNavmesh: true`].
  Terrain cells list the objects over them as a broad phase, and a superset is safe [confirmed: NAVIGATION §4.3].
  Links join bridge pieces (6 links in Jangan, all on the palace south bridge) [confirmed: NAVIGATION §4.3].
- **Reachability**: `NavWorld` labels walkable components (directed, Tarjan); the server places players, nests, NPCs
  and warps only in the town spawn's component (`apps/server/src/nav.ts` `setHome`) [confirmed: NAVIGATION §11.4,
  code]. Today 700 nests are placed (125 skipped), 91 of them unreachable on foot [confirmed: NIGHT_LOG 13:10].
- **Where the nav lives** (§F9): the server reads `nav.bin`; the client streams `nav-objects.bin` (every object
  model, instance and link, 394 KB) and the per-region `nav/<x>_<z>.bin` chunks, and its `NavWorld` swaps regions
  with `addRegion / removeRegion` but has no instance edit [confirmed: `world-render/src/nav.ts`,
  `packages/nav/src/world.ts`]. The converter builds the nav **before** the objects and the placement passes
  [confirmed: `convert-world.ts` section order].
- **Baked shadows** (§F8): the terrain lightmaps (512² per region, 0.375 m per texel) hold the retail shadows of the
  objects as well as the mountains [confirmed: rendered 171_97 and 168_97]; on Medium trees cast no real-time shadow
  and beyond the CSM range (60 m on Medium) and on Low the lightmap is the only object shadow [confirmed: TREES §1,
  `pbr/terrain-plugin.ts`].
- **The coast's nav editor** (`coast/navgen.ts` `editRegionNav`) already rewrites a region's `NvmFile`: new heights, a
  slope rule (`NAV_MAX_SLOPE = 0.7`), opened tiles, dropped water planes and dropped object instances, never mutating
  the retail file [confirmed: code]. The editor's nav step extends this (§6.3).

### 1.4 The GM editors that exist

The game has three GM tabs, **Spawns, NPCs and Quests** (`apps/game/src/world/features/editors.ts`, lane ED-C), gated by
the server's role checks and `EDITOR_ROLE`; the server writes override files under `DATA_DIR/content/` atomically
with **100 history copies per file** (`apps/server/src/editors/overrides.ts` `saveVersioned`, `HISTORY_KEEP`)
[confirmed: code]. The repo copies are `content/nests.override.json` and `content/npcs.override.json`. The world
editor links to these tabs; it does not duplicate them (§4.12).

---

## 2. Where it runs (a)

### 2.1 The choice [decision D1]

| | **A. An editor page on apps/viewer (Recommended)** | B. An editor mode inside the game client |
|---|---|---|
| Players download it | never: the mini PC builds `@sro/game` only [confirmed: `install.sh`] | must be split into a GM-only lazy chunk; still in the release |
| Who can use it | only this PC: bound to 127.0.0.1, token in the URL | any GM account on the friends' server, over the network |
| Renderer | the same `loadWorld`, presets selectable (Medium default) | the same |
| Writes files | directly, through the local editor API (Node) | through new authenticated server endpoints on the N100 |
| A mistake affects | this PC's working copy until Publish + Deploy | the live server the friends play on |
| Free camera, panels, big UI | natural (the viewer already has panels, cameras, overlays) | fights the HUD, the click-to-move, the chat |
| Walking test | the viewer's `Player` walks with `@sro/nav` client-side [confirmed: `apps/viewer/src/world/player.ts`]; "Test in game" opens the real game on a private server with the preview export | the real game, but on the live server |
| Nests, NPCs, quests | shown read-only; "Edit in game" opens the existing GM tabs | in place |

Reason: the user asked for "a GM-only editor in the browser on this PC"; A keeps every byte of it off the players'
download and off the live server, reuses the exact renderer, and makes Publish a deliberate step.

### 2.2 How it starts and what the user sees

- `pnpm editor` (a root script) starts Vite for `apps/viewer` on **127.0.0.1:5185** (`strictPort`; 5190 is texpipe's
  review server [confirmed: `packages/texpipe/src/review.ts` 39]) with its own `cacheDir` (so the :5173 viewer's
  dependency cache is never re-optimised under it) and the editor API plugin, and opens
  `http://127.0.0.1:5185/editor.html?world=jangan-fields&k=<token>`. A desktop shortcut (`work/editor/Silkroad World
  Editor.cmd`) does the same for the user [decision D2: one click, no terminal].
- The editor API answers only requests carrying the session token, an `Origin` of 127.0.0.1:5185 and a `Host` of
  127.0.0.1:5185 (no DNS rebinding); it writes only under `content/world-edits/`, `content/town/` (the route and
  dressing overlays), `work/editor/` and `work/out*/` [decision D3].
- One editor at a time: the API holds `work/editor/editor.lock` (pid + time); a second tab opens read-only with a
  plain message [decision D4].
- In the game, a GM types **`/editmap`**: on this PC's dev server the chat prints "Open the World Editor at your
  position: http://127.0.0.1:5185/editor.html?at=<x>,<z>". That page carries no token: it only tells the open editor
  tab to fly there (`BroadcastChannel`, same origin) and closes, or says "Start the World Editor from the desktop
  shortcut" when none is open. On the live server `/editmap` answers "The World Editor runs on the host PC" [decision
  D5: a link, not a mode]. It lands after wave 11, which is editing `apps/server/src/gm.ts` [confirmed: `git status`].

### 2.3 Live preview without a re-convert

What the editor changes in memory, per tool, and what the game would show after Publish are the same function of the
same layers (the converter and the editor import one node-free module, §3.6):

| Edit | Live path in the editor | Cost |
|---|---|---|
| Heights | write `RegionData.terrain.heights` (every region holding a shared seam vertex, so seams stay bit-identical), zero the baked normals in a one-vertex ring, re-upload the region's positions and normals (seam S-TERR) | **0.39–0.92 ms per region update** (97 × 97); stamps 0.07–2.4 ms mean [confirmed: prototype, quiet vs busy machine] |
| Grass on changed ground | mark the grass window dirty (heights by reference); re-bake the touched regions' density after a stroke (seam S-GRASS) | window refill ≤ 0.5 ms [projected: GRASS_LIFE §3.1]; a re-bake 15–25 ms per region, in ≤ 1 ms slices [projected: GRASS_LIFE §3.1] |
| Texture paint | update the region's texture words, rebuild its native layers (the converter's pure `buildLayers` / `blockLayers`, fed the 97 × 97 words as the MAPM's 6 × 6 blocks of 17 × 17 [likely: the function reads only `blocks[].textures`]) and its layer map (seam S-TERR) | ≤ 2 ms per region [projected: a 96 × 96 × L texture] |
| Objects | the edited placements become **editor-owned**: left out of their region batch, drawn as standalone copies of the converted model (the same materials), re-batched when the user stops editing that region (seam S-OBJ). **Swapped trees** use TREES' T12-E instead: `World.trees.setHidden(uid)` (band byte 3) hides the merged copy at once and `preview()` draws one LOD0 overlay instance; the region re-merges on drop (TREES §W3.9) | moving: 0 (a transform); taking a region out of its batch: a region re-batch ≈ 15 ms worker + ≈ 7.5 ms main-thread mesh creation, in jobs [projected: BATCHING §5, TREES §W3.9]; the prototype had only the whole-world `stream.rebuild()`: **2.3–4.6 s** [confirmed] |
| Grass / flower masks | multiply into the region's grass bake; re-bake the region (seam S-GRASS) | as above |
| Water | set the block's water plane (`WaterRenderer` per region) | one region rebuild |
| Lights | add a point to the night-light source list (seam S-NL); re-run the region's `nightSplat` commit step (the ground glow, every preset) | the container re-picks every 250 ms anyway; a splat re-bake per region [unknown: not timed] |
| Baked shadows | after a drop or a stroke, re-bake the region's lightmap inside the change mask with the same node-free baker the converter uses (§6.2 step 2), in a worker, and re-upload the layer | ≤ 0.3 s per region in a worker [projected] |
| Sound zones | an editor-side preview player (the game's zone runtime, §4.10) | none in play |
| Walkable preview | apply the nav rule (§6.3) to the region's `NavRegion` and swap it into the client `NavWorld` (`removeRegion` + `addRegion` [confirmed: exist]); moved or added footprints through seam **S-NAV** (an instance replace, or a rebuild of the objects-only `NavWorld` on drop); the overlay draws closed tiles red | ≈ 1 ms per region [projected]; an objects-only rebuild [unknown: not timed; the whole-world NavWorld + reach graph is 0.6–2.7 s] |

**Streaming keeps edits.** A region that streams out and back in gets its layers re-applied before its mesh is built
(seam S-FILTER: a `World` region filter at decode time). The prototype used a commit step after the terrain build
instead, which works but rebuilds the mesh twice [confirmed: prototype `applyLayerTo`].

**Picking the ground.** The client nav keeps the exported heights until Publish, so the editor ray-marches the edited
height field for the brush cursor and for snapping, not `world.pick` [confirmed: prototype `groundHit`; `world.pick`
uses `pickNav` first].

### 2.4 Testing what was made

- **Walk it in the editor:** "Walk here" drops the viewer's `Player` (the converted adventurer, `NavWalker`) on the
  cursor; clicks walk with the real walker over the *previewed* nav (§2.3 last row). Blocked chords show the red
  marker the viewer already draws [confirmed: `player.ts`].
- **Test in game:** "Test in game" runs Publish's convert into a **staging export** (`work/out/world/jangan-fields-edit/`,
  hard links for unchanged files; the name must match `WORLD_FOLDER`, a–z, 0–9 and `-` [confirmed: `apps/server/src/
  config.ts` 329]), starts a private game server on a free port with a **temporary copy** of `work/server/game.db`
  and `WORLD_EXPORT=jangan-fields-edit`, and a **private game Vite** on another free port (own `cacheDir`) whose
  `SRO_SERVER` points at that server (the client reaches its server only through the Vite proxy [confirmed:
  `apps/game/vite.config.ts`]). It opens the game there at the edit; the user logs in with their own account (the
  editor never types a password), which the DB copy grants GM, as the X2 private-server look did [confirmed:
  NIGHT_LOG 00:18]. It stops both and deletes the copy when the tab closes [decision D6]. The dev servers (:5180,
  :7000, :5173) are never touched.

---

## 3. The data model (b)

### 3.1 Where the layers live [decision D7]

```
content/world-edits/jangan-fields/
  edits.json                  index: format, version, world, the base export id per touched region, counts, notes
  height/<x>_<z>.png          97 x 97 LA16: L = 32768 + round(dh * 256) (1/256 m = 3.906 mm, exact 0, -128 … +127.996 m), A = touched
  paint/<x>_<z>.png           97 x 97 RGBA8: R = tile id & 0xff, G = (tile id >> 8) | tiling code << 2, A = painted
  grass/<x>_<z>.png           192 x 192 RGBA8 at 1 m: R = density x (R / 128), G = flowers 0..1, B = flower kind, A = touched
  walk/<x>_<z>.png            96 x 96 R8: 0 auto, 1 force open, 2 force closed (the Walkable tool, §4.7)
  placements.json             { move: [...], drop: [...], add: [...] } keyed by (region, uid) of retail placements only;
                              adds get ids ed-<n>; each move / drop stores the source and the original position
  water.json                  [{ id, region, blocks: [[bx, bz], ...], heightM }]
  lights.json                 [{ id, x, y, z, kind, colour, intensity, radiusM }]
  sound-zones.json            [{ id, name, shape, sound, gainDb, fadeM, when }]
  probes.json                 named points that must stay reachable from town (defaults: gates, places, spawn)
  palette.json                the paint palette's surface groups (108 tiles, curated; §4.3)
content/town/jangan.json      TOWN_LIFE's file: the editor writes its authored route / seat overlay there (§4.11)
content/town/jangan-dressing.json  the dressing's props are moved / dropped there, by row id (§3.2)
work/editor/jangan-fields/    NOT in git: the journal (§3.4), undo patches, thumbnails, the staging state
```

- **Per-region PNGs**, as the coast does: small diffs, one region at a time in git, and readable by the same `sharp`
  path. The prototype's 171_97 layer (468 changed vertices) is **1,466 bytes** [confirmed]; a fully reshaped region ≤ 40 KB, a 192 × 192 grass mask 5–60 KB [projected].
- **Heights are deltas, not absolute values** [decision D8]: the edit rides on whatever the retail + coast base is, so
  a later coast change does not resurrect stale ground, and "revert this change" is a subtraction. `edits.json` stores
  the base's SHA-256 per touched region (the region's exported heights before the edit pass); when the base changed,
  the editor shows that region as "the ground under your edit changed: check it" and Publish lists it (it never
  silently drops the edit).
- **Paint stores tile ids**, not a palette index (the coast's paint uses a 7-entry palette): the editor's palette is the
  whole terrain tile set (108 tiles today [confirmed: manifest `tiles`]), so the id itself is the stable key [decision
  D9]. Painting writes the per-vertex texture word, the native resolution of retail paint (2 m) [confirmed: TERRAIN
  §2.1]; the converter rebuilds the native layering from the words, as it does for retail.
- **The 16-bit PNG round trip is exact** [confirmed: `work/tmp/world-editor/sharp16.mts` wrote a 97 × 97 LA16 with
  `sharp` from a `Uint16Array` and read it back with 0 differing values].
- **The delta code has an exact zero** (§F1): `L = 32768 + round(dh × 256)`, `dh = (L − 32768) / 256`. The
  prototype's `round((dh + 128) / 256 × 65535)` decodes 0 as +1.95 mm [confirmed: `check-rule.ts`]. The editor
  snaps each stroke's deltas to the 1/256 m grid when the stroke ends, so what it shows is what the converter will
  write, bit for bit.

### 3.2 `placements.json` [decision D10]

```jsonc
{
  "format": "sro-world-edits-placements", "version": 1, "world": "jangan-fields",
  "move": [ { "region": 25003, "uid": 32770, "source": "res\\nature\\common\\tree\\tre_tree01.bsr",
              "from": [590.41, 2.08, -150.32],
              "to": { "position": [621.9236, 4.0306, -138.1684], "yaw": 0.698132, "scale": 1 } } ],
  "drop": [ { "region": 25003, "uid": 33794, "source": "res\\nature\\common\\tree\\tre_tree01.bsr", "from": [...] } ],
  "add":  [ { "id": "ed-17", "source": "res\\nature\\common\\stone_field03.bsr",
              "position": [650.2, 6.1, -140.0], "yaw": 1.2, "scale": 1.2 } ]
}
```

- Moves and drops name a **retail** placement by `(region, uid)` (retail uids are stable per export); the source
  path and the original position are stored to detect a mismatch after a re-export (a mismatch is a Publish error,
  "this object changed under your edit", never a silent apply).
- **The converter has no move** (§F3): `PlacementEdits` is drop / resnap / add [confirmed: `passes.ts`]. A move is
  applied as a **drop + an add of the same `(region, uid)`** with the new position, rotation and yaw:
  `applyPlacementEdits` frees dropped keys before it adds [confirmed: `passes.ts`], so the existing function applies
  it; its warnings become validator errors for the editor's layer.
- **The wave-11 dressing's props are not addressed by uid** (§F4): their uids are `1,000,000 + row order` per region
  and shift when a row is added or skipped [confirmed: `town/dressing.ts`]. Moving or deleting one edits its row in
  `content/town/jangan-dressing.json` (by row `id`: all 61 props carry one today [confirmed]; the editor adds an id
  to a banner or lamp row that has none), the dressing's own file, checked by `validateTownFile` (which also
  validates the 'townDressing' kind [confirmed: `packages/shared/src/town.ts`]).
- An **add** names a model by its source path (stable across exports; the manifest index is not [confirmed: TREES §3.1
  uses source paths for the same reason]). The converter assigns its owner region from the position and a **uid in the
  editor's range 0xE000–0xEFFF** of that region [decision D11; the largest uid in the export is 46,109 = 0xB41D and none
  is ≥ 0xE000 [confirmed: `check-manifest.ts`]; the range must stay 16-bit because a nav instance id is
  `regionId << 16 | uid` [confirmed: `packages/nav/src/data.ts`]; the dressing uses 1,000,000+ and the coast adds
  nothing today [confirmed], and the S-UID registry records the three ranges and errors on any overlap].
- **Scale** (§F6): placements carry no scale today [confirmed: `WorldPlacement`; every compose site uses scale 1].
  Seam **S-SCALE** adds an optional uniform `scale` (absent = 1). Allowed for models **without** a collision navmesh
  (0.5–2) and for trees (0.85–1.15, TREES Q-W7), whose small trunk footprints keep their unscaled size in the nav (the
  nav and the server know position and yaw only [confirmed: `NavInstance`]); never for buildings and other models
  with footprints [decision D12]. **No tilt** this wave: the user asked for rotating, and the nav, the server and the
  perches are yaw-only.

### 3.3 The other layer files

- `water.json`: a water plane per 32 m block (the MAPM's 6 × 6 blocks per region) at `heightM`, kind `water`, the same
  shape as a retail block's water [confirmed: manifest `blocks[].water` = `{kind, type, wave, heightM}`; 2,267 water
  blocks today]. The Water tool also carves the basin with the height layer (§4.8).
- `lights.json`: free light points (not tied to a model). The converter writes them as a new `points` list in
  `ambient.json` (today `{format, version, source, models}` [confirmed]: a version bump) that the night lights read
  beside the (placement × particle) pairs (seam S-NL): they join both the point-light pick and the per-region ground
  splat, which every preset bakes, Low included [confirmed: `night-lights.ts` header] [decision D13].
- `sound-zones.json`: `shape` is `{ circle: { x, z, r } }` or `{ poly: [[x, z], ...] }` in glTF metres; `sound` is a key
  of the exported sound index (SOUND §4.3); `when` is `day | night | always`; played by a small zone runtime beside the
  area loop, like the coast's surf (`apps/game/src/audio/coast.ts`) and wave 11's town bed (`audio/town.ts`, up to 3
  loops of its own [confirmed: its header]) [decision D14].
- `probes.json`: named points that must stay reachable from the town spawn, both ways. Default content: the spawn, the
  four gates, every `manifest.places` entry (14 teleport places [confirmed: manifest]) and the S1 beach; the user adds
  more by right-click "Keep this reachable" [decision D15].

### 3.4 History: undo, redo, revert one change, revert a region [decision D16]

- **Every user action is one change**: a brush stroke (pointer down to up), one move / turn / scale / snap, one paste
  of N objects, one delete, one water / light / zone / route edit. Each change records its own difference: for
  heights the touched vertices' before and after values; for objects the before and after transform (or the add /
  drop); for masks the touched texels.
- **Undo / redo** (Ctrl+Z / Ctrl+Y) walk the journal. In the prototype both are **bit-exact**: after four strokes
  (468 vertices, up to +14.3 m) and four undos the heights equal the exported bin with **max |Δ| = 0**, and four redos
  give back the edited heights with max |Δ| = 0 [confirmed: prototype, compared with a fresh decode of
  `terrain/171_97.bin`].
- **Revert this change** (a "revert" link on every row of the Changes panel): subtracts that change's own difference
  from the current state, so later changes on top stay [confirmed: prototype `revertById` for heights and moves].
  Reverting a change that a later change depends on (e.g. a move of a pasted object) asks first and lists the
  dependants.
- **Revert this region** (right-click on the minimap or the region label): removes the region's layers and its
  placement edits (one journal entry, itself undoable). **Revert everything to the last publish** and **to retail**
  exist in the File menu with a confirmation.
- **The journal** is `work/editor/<world>/journal.ndjson` plus binary patches (`patches/<id>.bin`), written
  atomically, kept across restarts; capped at 2,000 changes or 200 MB, the oldest folding into "saved state" (still
  revertable per region and through git) [decision D17].
- **Git** holds the published states: Publish commits `content/world-edits/` (and the two town files when touched)
  with a message listing the changes in plain English (§6.4), by pathspec only (`git commit -- <those paths>`), so
  nothing another lane has staged is swept in; when one of those paths also holds changes the editor did not write
  (a lane editing `content/town/`), Publish stops and says so. The user never runs git.

### 3.5 Save [decision D18]

- **Save** (Ctrl+S, and an autosave every 2 minutes while there are unsaved changes) writes every touched layer file
  atomically (temp + fsync + rename, like `writeJsonAtomic`) and the journal. In the prototype one height layer, the
  placement list, the index and the journal saved in **88–127 ms** [confirmed].
- Save never converts, never touches `work/out`, never commits. The editor shows "Saved. Not published yet."

### 3.6 How the converter applies the layers [decision D19]

- A new pass **"world edits"** in `passes.ts`, after the town dressing and before the cloth reclass: the user's hand
  wins over the procedural and scripted content, and every later pass (cloth, static variants, grass palettes, the
  batcher) sees the edited placements only (the S-DRAW rule the coast established).
- A new region source overlay **`editsSource(coastSource(retailSource(...)))`** in `convert-world.ts` (the coast's
  `RegionSource` shape, COAST §5.4) applies heights, paint and water per region, then the frozen checks that still
  hold (the tomb keep, §7.3). It shares one node-free module with the editor: `packages/shared/src/world-edits/**`
  (decode, apply, the nav rule, the validators), so the preview and the export cannot disagree.
- **The nav step comes first** (§F9): `convert-world.ts` builds the nav before the objects and the placement passes
  [confirmed: section order], so the footprint part of the placement edits (move, drop, add of models with a
  collision navmesh) is applied in the navmesh step from the same `placements.json` by the same pure function that
  the "world edits" pass uses for the placements; a test checks the two agree (every edited placement with a
  footprint has exactly one nav instance at its new transform). The wave-11 dressing reads that nav for its props'
  ground [confirmed: `dressing.ts`], so it already sees the edited ground and the editor's footprints.
- **Inside the playable bounds the editor may change heights** (that is its point), unlike the coast's authored
  layers. The coast's frozen check keeps guarding the coast's own layers; the edits pass has its own rules (§7.3).
- Determinism: two conversions with the same layers give identical bytes (the coast's test, extended).

---

## 4. The tools (c)

The palette (left) has one button per tool with its key; the brush panel (right) has Size, Strength and Softness
sliders; the bottom bar shows the keys of the active tool and the status line; the Changes panel lists every change
with its revert link (§5, `work/tmp/world-editor/out/shots/UI-brush.png`, `UI-move.png`).

### 4.1 Terrain: Raise, Lower, Smooth, Flatten, Noise

| Tool (key) | What it does | Notes |
|---|---|---|
| Raise (B), Lower (N; Shift+Raise) | adds / removes height under the brush, `0.12 m × strength × falloff` per stamp at ≈ 30 stamps / s | prototype [confirmed] |
| Smooth (S) | moves each vertex toward its 4-neighbour mean by `0.6 × strength × falloff` | prototype [confirmed] |
| Flatten (F) | moves toward the height sampled where the stroke started (Alt+click picks a height; a number box sets it) | the "make a terrace / a path / a building pad" tool |
| Noise (J) | adds seeded value noise (wavelength = size / 3, amplitude = strength × 1 m) | deterministic: the seed is the change id |

- **Brush math** (all tools): the brush works on the **global 2 m lattice** (`GX = 96 · rx + gx`), so a stroke across a
  region seam writes each shared vertex once into every region holding it and seams stay bit-identical [confirmed:
  prototype `holders()`]. Falloff `smoothstep` over the outer `softness × radius`; size 2–60 m, strength 1–100 %.
- **Guards while painting** (§7.3): the coast's sea mask and shore band, the export's edge, the tomb keep. A clamped
  stroke says so in the status line ("Stopped at the shore: the sea floor can't rise above the water here").
- **The cursor** is a ring draped on the ground, the inner ring showing the hard core [confirmed: prototype].
- **Objects on brushed ground** (option "Keep objects on the ground", default **on** for vegetation and small props):
  their y follows the ground under their origin, keeping their exported clearance (retail trunks often sit 1–2 m
  below the ground: the prototype's tree 32770 sits 1.4 m deep [confirmed: dry run]). Buildings and anything with a
  collision navmesh never move by themselves; they are listed (§6.3 check 6).

### 4.2 What a cliff does to walking

A raised mound is still walkable everywhere unless tiles close (§1.3). The editor shows the walking overlay (red =
closed) live and applies the rule of §6.3: a tile the edit made steeper than 35° closes. In the prototype a 14 m mound
with 34 m brushes closed 122 tiles of 527 touched under the dry run's simplified rule (117 of 443 under the rule as
written [confirmed: `check-rule.ts`, §F2]), and kept its top reachable from the meadow (405 open edited tiles still
in the town's component, 0 cut off) [confirmed: dry run, re-run 2026-10-01].

### 4.3 Texture paint (P)

- **The palette** is the terrain tile set as the game draws it after this wave's upscale (TERRAIN_TEX: every one of the
  108 tiles remastered [projected: the sister spec is not in the tree yet, §F26]), shown as swatches grouped by
  surface: Grass, Long grass, Dirt, Sand, Rock / stone, Road / paving, Mud, Other [decision D20]. The tiles'
  `typeName` alone gives Dirt 62, Grass 17, Stone 12, Water 6, Mud 6, Sand 5, and no tile is named road or paving
  (the town's paving is `c_marble_jang_*`, the roads are `*_dust_*`) [confirmed: `check-tiles.py`], so the groups
  come from a curated `palette.json` (108 rows, one per tile, written once by WE-U and reviewed on a swatch sheet),
  with `typeName` and the grass weight as the fallback for a tile it does not list. A search box finds a tile by name.
  The "Water" tiles paint the look of a river bed only; water itself is the Water tool (§4.8).
- **Paint** writes texture words per vertex (2 m; bits 0–9 tile id, 10–12 zero, 13–15 tiling code [confirmed:
  TERRAIN.md's `.m` layout, `format.ts`]); the native layering blends them (TERRAIN §2.3), so edges look like retail edges. A cell has 4
  corners, so it can never pass `MAX_TERRAIN_LAYERS` = 8 [confirmed: `format.ts`], but a region's layer count can
  grow (S-TERR re-creates its 96 × 96L layer texture when it does). The tiling code (texture scale) defaults to the
  tile's most common code in the export.
- **Effects that follow automatically:** grass grows where the paint says grass (GRASS_LIFE §3.2), footsteps and
  wetness follow the tile's surface class [confirmed: `terrainSurfaceClass`, `audio/surface.ts`], the minimap and the
  baked lightmap are redrawn at Publish (§6.2).
- **Not this wave:** a finer-than-2 m detail splat (would need a new terrain plugin seam) [decision D21].

### 4.4 Grass and Flowers (H)

- **Grass density** paints a 1 m mask (`grass/<x>_<z>.png` R) that multiplies GRASS_LIFE's density (×0 … ×2): "less
  grass on this path", "lusher here". **Flowers** paints G (amount) and B (kind: the GRASS_LIFE flower set) [decision
  D22].
- Applied in the grass bake (`grass/bake.ts`, seam S-GRASS) on every preset that draws the new grass; Low (retail
  scatter) ignores it, as Low ignores the new grass [decision D23: the Low guard stays exact].
- The far rings (GRASS_FAR's B and C) read the same bake boxed down, so painted meadows reach the horizon with no
  extra work [confirmed: `grass/field.ts` makes `coarseGrass` (`ring-window.ts`) from the bake when it lands].
- The bake runs **on the client** (`grass/bake.ts`), so the masks ship with the export: the converter writes
  `grass/<x>_<z>.png` only for painted regions and lists it in the region's manifest entry; the streamer fetches it
  with the region (seam S-GRASS) (§F23).

### 4.5 The library (O to place)

- **Tabs:** Trees (the new families of TREES.md, by family: maple, broadleaf, pine, willow, bamboo, ginkgo, ...),
  Plants (bushes, shrubs, reeds, flowers as objects), Rocks, Props (stalls, carts, barrels, crates, benches), Lanterns
  and lamps (models that carry a night emitter, §4.9), Buildings, Walls and gates. A search box, and "Recently used".
- **Contents** [decision D24]: every converted model of the export (503 today [confirmed]) classified by source path,
  plus the retail models the census found usable (TOWN_LIFE TL-K, `work/tmp/town-life/props-census.json` [confirmed:
  exists]), plus the new trees and plants. A model not yet converted is converted on first use (the converter's model
  path, ≈ 0.1–0.5 s each [projected]).
- **New trees and plants** are placed **as their carrier model** (TREES §W3.9, §F7): the Trees tab lists
  `content/trees/library.json` (one entry per species: name, review-sheet thumbnail, size range, default tint and the
  **carrier**, the retail swap source with the closest envelope), read through T12-E's `World.trees.library()`.
  Placing "Chinese pine" adds a placement of its carrier, so the swap draws the new tree on Medium and up, Low draws
  the retail tree, and the carrier's footprint goes into the walking rebuild [decision D25]. Many retail sources map to
  one species, so the editor never inverts `swap.json`. Dragging uses T12-E's `preview()` / `setHidden()` (band
  byte 3), dropping re-merges the region. A placement count guard keeps the swapped trees within the band texture's
  **8,192** slots (5,586 today [confirmed: TREES §W3]). A species with no retail carrier is not placeable this wave
  (TREES places every species through a carrier).
- **Thumbnails**: rendered by the editor itself on first run (an off-screen 128² render of each model with the game's
  materials, cached in `work/editor/thumbs/`), so the new trees look new in the library. The prototype showed the
  existing Blender workbench thumbnails of the TL-K census (148 files [confirmed]) [decision D26].
- **Placing:** drag a thumbnail into the world, or select it and click; the object follows the cursor on the ground,
  turns with the wheel, and lands snapped. Shift keeps placing copies; vegetation gets a random yaw and ±10 % scale by
  default ("scatter mode", a checkbox; scale needs S-SCALE, §3.2).

### 4.6 Move, Turn, Scale, Delete, Snap, Select, Copy, Paste (V)

- **Pick** by clicking: a ray against every nearby placement's model bounds, nearest hit wins [confirmed: prototype
  `pickPlacement`]; Shift / Ctrl add / remove from the selection; drag a rectangle to select many.
- **The gizmo** (Babylon's `GizmoManager`, in `@babylonjs/core`, nothing to download [confirmed: `Gizmos/`]): arrows
  to move (W), a ring to turn about the vertical (E), a box to scale (R; uniform; footprint-free models 0.5–2, trees
  0.85–1.15, never buildings, §3.2), all in world axes. The selection shows a gold box and a panel with its name, region, position, facing, "on the ground / floating
  / sunk", and whether it blocks walking [confirmed: prototype panel].
- **Snap to ground** (G) and an always-on "land on the ground" when a drag ends (Ctrl holds the height) [decision
  D27]: the object keeps its exported clearance (§4.1).
- **Delete** (Del) drops a placement (retail ones go to `drop`, adds are removed); "Show deleted" draws them as ghosts
  so they can be restored.
- **Copy / Paste** (Ctrl+C / Ctrl+V): pasted objects follow the cursor and land on the ground, relative positions kept.
- **Rules:** objects with nav **links** (the palace south bridge pieces) cannot be moved ("This bridge piece is joined
  to its neighbours; it can't be moved on its own") [decision D28]; a building whose footprint would cross the
  playable bounds is refused; a placement whose origin is moved out of its owner region changes owner at Publish
  and takes a **fresh editor uid** there (a drop + an add), because retail uids repeat from region to region and the
  old uid could already exist in the new owner (§F5); the journal keeps the link so "revert" still finds it.
- **Baked shadows follow** (§F8): a move, delete or add re-bakes the lightmap of the regions its old and new shadows
  touch (the editor in a worker, the converter at Publish), so no ghost shadow stays behind and a planted tree
  shades the grass on a Mac's Medium as a retail tree does.

### 4.7 Walkable (Y)

The Walkable brush (Y) paints the `walk/` override: **force open** (a closed retail tile the user flattened into a
path) or **force closed** (keep players off a decorative slope). It is rarely needed: the automatic rule (§6.3) covers
cliffs. Force-open is checked like any edit (no new traps) [decision D29].

As built (2026-10-03; `apps/viewer/src/editor/walk-edits.ts`, `packages/shared/src/world-edits/walk.ts`):
- Modes **Open / Close / Auto** in the brush panel (Auto takes the override away); Shift + drag does the other of Open
  and Close for one stroke. Only the size applies (`[` `]`, 2-60 m): every 2 m tile whose centre is inside the ring
  (always the tile under the cursor). One stroke is one change (undo / redo / revert one / revert region, the journal,
  Save as `walk/<x>_<z>.png`).
- The walking overlay follows the stroke live: green = forced open, bright red = closed by the brush or the slope
  rule, faint red = retail closed. With the tool on it shows every region within 300 m of the camera, not only the
  edited ones. "Walk here" walks the previewed nav (a forced-open tile takes an open neighbour's cell, as Publish does).
- **Hard limits** (`walkRefusals`, one rule for the editor and the converter): a tile is never forced open outside
  `stream.playable`, with its centre in the coast's sea mask (coast/field.png R ≥ 128, `World.coast.seaAt`), or under
  a collision footprint's XZ box (after the object edits). The editor refuses those tiles and says why in the status
  line; the converter's nav step turns such a force-open back to auto with a `world edits: walk <x>_<z>: ...` warning
  (Publish's row 9 shows it as a warning, never a stop). Force closed is never refused: rows 2-4 catch a cut road.

### 4.8 Water (U)

- Click a block to set its water level (a number box and ±0.1 m keys); the plane covers 32 m blocks, like retail.
  "Make a pond" combines a Lower stroke (the basin) and the water plane at the rim height.
- Guards: a block touching the coast's sea keeps the sea level; a water plane above the ground everywhere in its block
  is refused ("This water would float above dry ground").
- Walking: retail walks river beds under water [confirmed: NAVIGATION §2]; so does a new pond, **except** that tiles
  under new water deeper than 1.2 m close until swimming exists (wave 13) [decision D30].

### 4.9 Lights (L)

- Place a light point (lamp, lantern, fire; warm presets) or place a **lantern model from the library** that carries a
  retail night emitter (`cj_resta01_light_n`, `cj3_lion_dan`, ... [confirmed: TOWN_LIFE §7.1]); both feed the night
  lights (seam S-NL). A "night preview" toggle sets the time to 22:00.
- The container picks the nearest 8 / 32 / 64 lights (Medium / High / Ultra) where the engine supports clusters, else
  2 plain point lights [confirmed: `night-lights.ts`], so more lights never cost more draws; the warning is about
  density (§7.2). Every light also warms the ground through the per-region night splat on every preset, Low included
  [confirmed], so a lantern placed in the editor lights the street on the N100 too (§F22).

### 4.10 Sound zones (Z)

- Draw a circle or a polygon, pick a sound from a list (the exported ambience and the town loops: birds, water,
  crowd, wind, insects at night), set loudness and edge fade; "Listen here" plays it from the cursor.
- Runtime: a zone voice beside the area loop (SOUND §5.10's `setArea` keeps the area loop; zones add at most 2 loops
  at a time, nearest first, and at most 1 inside the town box, where wave 11's town sound already runs up to 3 loops
  [confirmed: `apps/game/src/audio/town.ts` header]) [decision D31].

### 4.11 Town routes and seats (T)

- Edits TOWN_LIFE's route graph and places (`content/town/jangan.json`, wave 11, TL-R): nodes, edges, seats, stalls,
  chat spots, doors. Drag nodes, click to add an edge, right-click to delete; every edge is checked on the navmesh with
  the build script's rule (`checkTownSegment`: home component, no solid footprint, steps ≤ 0.6 m, ≥ 0.4 m from nav
  edges [confirmed: `town/build-graph.ts`]) and drawn red when it fails; `validateTownFile` runs on Save [decision D32].
- **The edits are an authored overlay, not in-place changes** (§F18): `pnpm sro town-graph` regenerates nodes, edges,
  places and seats from the nav on every run and keeps only the authored parts (hour curve, lines, population, role
  shares) [confirmed: `build-graph.ts` header]. The editor writes a `manual` section in the same file (pinned, added
  and removed nodes, edges and seats, by position), which build-graph keeps like the other authored parts and applies
  after regeneration (a TL-R change owned by WE-T, after wave 11 lands). When a Publish changes the ground or the
  objects inside the town box, Publish re-runs town-graph, so routes never cross a moved stall.
- Live preview: the town part re-reads the graph (the crowd re-plans in the next schedule tick).
- Available once wave 11's TL-R has landed the file and its validator (lane WE-T is step 2).

### 4.12 Nests, NPCs and quests (links)

- The editor draws nest rings and NPC markers read-only from `work/out/data/nests.json` / `npcs.json` plus the
  override files, so edits don't bury them by accident.
- "Edit spawns / NPCs / quests in game" opens the local game at the cursor (`?tp=x,z`), where the existing GM tabs do
  the work [decision D33: one editor per kind of content].
- Publish checks that every nest and NPC still stands in the town's component (§6.3).

---

## 5. The UI: friendly and safe

Layout (`work/tmp/world-editor/out/shots/UI-brush.png`, `UI-move.png`, 1920 × 1080):

- **Top bar:** "World Editor · jangan-fields", Undo, Redo, **Save**, **Publish…**, **Deploy…** (greyed until a publish
  is done), the preset (High by default; Medium and Low to see what Macs and the N100 see), the time of day, Help.
- **Tool palette (left):** big icons with names and the key in the corner; tools not available for what is selected
  are dimmed with a tooltip saying why.
- **Right panels:** Brush (Size, Strength, Softness sliders with values), Selected (name, region, position, facing,
  "on the ground", "blocks walking"; buttons Snap, Put back, Delete), Library (tabs, search, thumbnails), Changes
  (numbered, plain-English rows, each with "revert").
- **Bottom:** the keys of the active tool (always on screen), the status line in plain English, and the budget line
  ("Region 171,97: 3,207 / 60,000 object triangles · view 30 draws (the plaza measures 152 on Medium) · within
  budget"). The "Medium line 180" of the prototype's shot is not a real line (§F20).
- **Minimap (toggle M):** the regions, the playable bounds, the coast line, regions with edits outlined in gold.
- **Words, not codes:** every error is a sentence with a way out. Examples [decision D34]:
  - "You can't raise the sea floor here: it would make an island the ocean can't draw. Paint on the shore instead."
  - "This tree is 10.7 m under the new ground. Snap it up, move it, or delete it."
  - "This hill's sides are too steep to walk (over 35°). Players will walk around it. Smooth the sides if they
    should climb it."
  - "Publish stopped: the Bandit camp nests would be cut off from town. Undo the last change on region 160,95, or open
    a path."
- **Never lose work:** autosave, the journal, "Save before closing?" on tab close.
- **Keys** [decision D48]: tools Move V, Place O, Raise B, Lower N, Smooth S, Flatten F, Noise J, Paint P, Grass H,
  Walkable Y, Water U, Lights L, Sound Z, Routes T; in Move: W move, E turn, R scale, G snap, Del delete, Esc
  deselect; everywhere: [ ] size, - = strength, Ctrl+Z / Ctrl+Y, Ctrl+S, Ctrl+C / Ctrl+V, M minimap, F1 help. The
  bottom bar always shows the active tool's keys (the prototype does [confirmed]). **Camera:** WASD (and Q / E down /
  up) fly only while the right mouse button is held, as in common 3D editors; otherwise the letters pick tools, so S
  (Smooth) and W / E / R (gizmo modes) never fight the camera (§F28).

---

## 6. Save, Publish, Deploy (d)

### 6.1 The three buttons [decision D35]

| Button | What it does | Time | Touches |
|---|---|---|---|
| **Save** | writes the layers and the journal | ≈ 0.1 s [confirmed: 88–127 ms] | `content/world-edits/`, `work/editor/` |
| **Publish…** | checks, incremental re-convert + nav rebuild + optimize of the touched regions, the report, the tests, the before / after, a git commit of `content/` | ≈ 1–2 min for a few regions [projected, §6.2] | `work/out`, `work/out-opt`, git |
| **Deploy…** | the existing deploy in its assets-only mode, `pnpm run deploy -- --assets-only` (asset sync + restart when something changed), after a confirmation listing what changes for the friends | as today | the mini PC |

Publish never deploys. Deploy asks: "Send these map changes to the friends' server now? The server restarts (about a
minute) and players must reload the page. [Deploy] [Not now]". Clicking Deploy is the user's OK [decision D36].

**Why assets only, and when Deploy says no** (§F16): `deploy.sh` ships the **committed code at git HEAD** with the
assets [confirmed: `deploy/deploy.sh` header], and in the middle of a wave HEAD can be an ungated step commit (today
"Wave 11 step 0: seams"). A map edit is assets only, so the editor never ships code. Deploy is refused, with a plain
sentence, when the converter's code (`packages/convert`, `packages/shared`, `packages/nav`, `packages/formats`) has
uncommitted changes, because then the export was written by unfinished code ("A build is in progress; the map goes
out with the next release, or ask Claude"), and when a commit newer than the deployed release changed that code
(the export may hold data the friends' client can't read yet; `deploy.sh` already knows the deployed release's
commit [confirmed: line 141]). Code and map ship together at the release gate as today.
Claude can run the same steps from a session (`pnpm sro world-edit publish`, then the deploy with the user's OK in
chat); the editor is not required.

### 6.2 Publish, step by step

1. **Validate the layers** (`pnpm sro world-edit validate`): formats, names inside the export, the base hashes (§3.1),
   the uid range, the sea mask and shore rules, the bounds, links, scale only on footprint-free models. Errors stop.
2. **Re-convert the touched regions** into a staging export, under the convert lock (`work/out/.convert.lock`, also
   taken by `convert-region`; Publish waits while a lane's full convert runs, §F15): `convert-region --preset
   jangan-fields --only <touched + 1-ring>` (new mode, lane WE-I): terrain bins (heights, words, layers, normals across
   the ring); the **baked lightmap** inside the change mask, which now covers both the moved ground and the old and
   new shadow areas of every moved, deleted or added object: a heightfield ray-march toward `BAKED_LIGHT_DIR` (the
   coast's `coast/lightmap.ts` method) **plus the objects' shadows** (each placement's LOD0 triangles, leaf cards
   alpha-tested at 0.5, projected along the same direction, at the lightmap's 0.375 m texel, written at the retail
   levels 255 / 156 with the coast's feather), because the retail lightmaps carry the objects' shadows and the coast's
   baker does not (§F8); the minimap tile inside the change mask (the coast's rule for dropped footprints, adds drawn
   as discs [confirmed: `coast/minimap.ts`]) and the world map stitch; the debug navmesh, the nav chunks,
   `nav-objects.bin`, and the manifest. Placements are global but cheap: the passes run again on the **pre-pass**
   list and models the last full convert cached (running them on the manifest's post-pass list would apply the
   coast's and the dressing's edits twice, §F17). Unchanged files are hard links of the live export, and nothing is
   ever written in place (temp + rename), so a hard-linked live file can't change (§F14). Target **≤ 15 s** for ≤ 9
   touched regions [projected: the full convert is 72.6 s for 414 regions, mostly terrain 28 s + stream 16 s +
   objects 10.5 s, and objects are not re-converted; the object-shadow bake is [unknown], target ≤ 1 s per region].
3. **Rebuild walking** for the touched regions (§6.3), and splice them into `nav.bin` (the server's) and
   `nav-objects.bin` (the client's instances and links) (decode, replace, encode: the whole `nav.bin` decodes in
   37–149 ms [confirmed: dry run and its re-run]).
4. **Optimize only the changed files**: `optimize-out run --files <list>` (new mode): each changed file through the
   same per-file step as today, `slim.json` **merged** (entries for untouched files kept byte-identical, renamed
   entries updated) [decision D37]. Target ≤ 30 s [projected: the full run is 902–998 s for every file].
5. **Run the checks** (§6.3) and produce the **report page** (§6.4).
6. **Run the tests** that cover the edit: `vitest run` on the world-edits suite (format, determinism, the nav rule, the
   checks), the nav reachability tests, the coast checks when a coast region is touched, the town file and graph
   tests when the town box is touched (Publish re-runs `pnpm sro town-graph` first, §4.11), and the Low guard when a
   pass changed (never the full suite) [decision D38].
7. **Before / after**: each bookmarked view (the editor records the camera of every change; the user can star views)
   is rendered from the live export (before) and the staging export (after) at High and Medium, WebGPU, 1920 × 1080
   (one view at 400 m to show the baked shadows), into a sheet in `work/editor/<world>/publish-<n>/` shown in the
   report.
8. **Swap and commit**: the changed files of the staging export replace the live ones one by one (temp + rename per
   file, the manifest last; no directory rename, which Windows refuses while a dev server holds a file in the folder
   [likely]), `work/out-opt` likewise; the replaced files are kept in `work/editor/<world>/publish-<n>/backup/` so
   "undo this publish" is a copy back. `content/` is committed by pathspec ("World edits: raised a hill at Hill of
   Ye Mt. (171,97), moved 1 tree, ...") [decision D39]. The dev server is not restarted by the editor; the report
   says "Restart the local server to play it here" (until then the :7000 server keeps the old nav in memory while
   :5180 serves the new files, as after any re-convert [confirmed: NIGHT_LOG 21:31]).

If any step fails, nothing is swapped: the live export stays as it was, and the report says what failed.

### 6.3 Walking rebuilt (navgen) and the checks

**The nav rule** (one pure, node-free function, `packages/shared/src/world-edits/nav-rule.ts`, used by the editor's
preview, the converter and the tests; it extends the coast's `editRegionNav`) [decision D40]:

1. Heights: the edited lattice (file units = metres × 10) for the touched regions' `NvmFile`.
2. Tiles touching a vertex that moved by more than 5 cm:
   - an open tile whose slope after the edit is over **0.7 (35°)** and steeper than before by more than 0.05 closes
     (retail's own steep open tiles stay as they are);
   - a closed tile never opens by itself;
   - under **new** water deeper than 1.2 m, a tile closes (§4.8);
   - the Walkable overrides apply last (force open / force closed).
3. Objects with a collision navmesh: a **move** rewrites the instance's position and yaw in its owner region and in
   every region its footprint reaches (the `.nvm` spill copies); a **drop** removes it; an **add** inserts it (owner
   region from the position, uid from the editor range, `objId` from the model's `object.ifo` entry); the terrain
   cells' object lists get the cells under the footprint's box (a superset is safe [confirmed: NAVIGATION §4.3]);
   links are never edited (§4.6). This runs in the converter's navmesh step, which precedes the placement passes
   (§3.6). A closed tile gets the region's closed cell and the blocked tile flag, as `editRegionNav` does [confirmed:
   `coast/navgen.ts` `close`] (the dry run only wrote the cell index).
4. `buildWorldNav` builds as today; untouched regions are bit-identical (tested); `nav-objects.bin` and the touched
   `nav/<x>_<z>.bin` chunks are re-split from it (`splitWorldNav`), so the client and the server agree.

**The checks** (the report lists each with pass / warn / stop) [decision D41]:

| # | Check | How | Stops the publish? |
|---|---|---|---|
| 1 | Layers valid | §6.2 step 1 | yes |
| 2 | Nobody trapped | `NavWorld` before / after: components the town reaches but can't leave; their count and area must not grow | yes |
| 3 | Everything that was reachable still is | every nest centre, NPC, `manifest.places` entry, gate and `probes.json` point that was in the town's component before is in it after, both ways (`componentReaches`) | yes |
| 4 | Gates and roads connected | the probe pairs (spawn ↔ each gate ↔ each place) reach each other; a road painted over or cut by a new cliff shows here | yes |
| 5 | Ground cut off | open tiles of the edit that reached town before and don't now (an island nobody can enter): listed with their area; "close it" is one click | warn |
| 6 | Props on moved ground | for each placement over a moved vertex: the change of its clearance at the origin and over its footprint (trunk 1.5 m for vegetation, model bounds otherwise): **buried** (ground rose > 0.5 m, or the footprint by > 1 m) or **floating** (ground fell > 0.3 m); vegetation is auto-snapped if "keep on ground" was on | warn (stop for a building with a nav footprint) |
| 7 | Overlaps | a moved / added nav footprint overlapping another's | warn |
| 8 | Budgets | §7.2 per region; the bench of starred views (Medium and High, both backends) when triangles or draws grew > 10 % or by > 5 k triangles | warn; stop past the hard line, G1, G2 or the M1 margin |
| 9 | Coast and bounds | §7.3 | yes |
| 10 | Tests | §6.2 step 6 | yes |

**Measured on the prototype's edit** (`publish-dryrun.ts`, the saved layer applied to `terrain/171_97.bin` and to
`nav.bin` in memory) [confirmed: re-run by the fact-check, same numbers]. The dry run used a **simplified** slope rule:
every open tile touching a masked vertex, slope > 0.7, no comparison with the slope before. The rule above (moved
> 5 cm, steeper than before by > 0.05) touches 443 tiles and closes 117 [confirmed: `check-rule.ts`]; the other rows
were taken with the 122 closures, a superset (§F2):

| | Result |
|---|---|
| Layer | 468 vertices, max \|Δh\| 14.295 m, 3.91 mm steps |
| Nav tiles touched / closed by the slope rule | dry run 527 / **122** (max slope after 1.21 = 50°), 0 were already closed; the rule as written 443 / 117 (14 of the 527 touched tiles were already steeper than 0.7 in retail) |
| Edited open tiles still reachable from town / cut off | **405 / 0** |
| Town component area | 6,617,077 → 6,616,589 m² (−488 m² = the 122 closed tiles × 4 m²) |
| Nests within 400 m that left the town's component | **0 of 53** |
| Traps (town reaches, can't leave) | 15 / 726.6 m² before and after |
| Props | tree 33794 **buried 10.7 m** (flagged); the moved tree 32770: clearance change −0.01 m (ok); tree 34818: ok |
| The moved tree's nav instance | moved with it (trees carry footprints) |
| A straight walk from the meadow to the hilltop | stops at the closed flank (blocked = true, as intended); the top is reached from its gentler side |
| Cost | `nav.bin` decode 37–149 ms (two copies); `NavWorld` + reach graph 0.63–2.7 s per build (re-run: 0.77 / 0.86 s); trap census 0.08–0.3 s |

### 6.4 The report page

One page in the editor (and a copy in `work/editor/<world>/publish-<n>/report.html`): the list of changes in words,
the checks with green / amber / red, the before / after sheet, the budgets per touched region, the tests, and the
buttons **Keep** (swap and commit) or **Go back** (discard the staging export). Claude reads the same report when the
user asks in chat ("is my map edit OK?").

### 6.5 Preview on this PC

"Test in game" (§2.4) is the full preview: the real game, the real server rules, the staging export. Publish's swap
makes it the local export; Deploy sends it.

---

## 7. Performance and safety (e)

### 7.1 The editor never costs a player anything

- It is a page of `apps/viewer`, which the deploy never builds or serves [confirmed: `install.sh` builds
  `@sro/game` only]. The game gains only: the `/editmap` chat line (a GM command), the night-light `points` reader,
  the grass mask fetch and multiply in the bake, the optional placement `scale` (S-SCALE: one more multiply in the
  compose sites, 1 when absent), and the sound-zone runtime (§8).
- **Rendering on demand** [decision D47]: the editor draws a frame only when the camera, an edit, the time of day or
  an animation preview changes something, so an idle editor costs the GPU nothing; while another owner holds
  `work/tools/gpu.lock` a banner says so and the editor also stops its continuous previews (water, wind), so it
  neither skews a lane's bench nor freezes for the hours an SDXL batch may hold the lock (§F27).
- The editor's own frame: on the dev PC at Medium the brush must add ≤ 2 ms per frame at 30 stamps / s and ≤ 4 region
  uploads per frame (≤ 4 ms) [projected from the prototype's 0.07–2.4 ms stamps and 0.39–0.92 ms uploads]. The worst
  editor work in one frame in the prototype was 5.8–40 ms (first-use JIT and garbage collection on a busy machine)
  [confirmed]: the prototype allocates small arrays per vertex (`holders()`); production works on typed arrays and
  keeps the stamp under 1 ms.

### 7.2 Guardrails per region (warn early, refuse late) [decision D42]

From the census of today's export (`work/tmp/world-editor/region_census.py`, the playable regions with placements,
triangles of each placement's LOD 0 glb) [confirmed]:

| Measure | Today: p50 / p95 / worst | Warn at | Refuse to publish at |
|---|---|---|---|
| Object triangles per region (before the tree swap) | 4,238 / 16,144 / 49,451 (168_97, the town centre) | 60,000 | 90,000 |
| Placements per region | 15 / 118 / 331 (167_97) | 400 | 600 |
| Distinct models per region | 5 / 18 / 51 | 60 | 90 |
| Separate draws per region (lamps, alpha-blended, skinned, editor-owned) | — | 12 | 20 |
| Night light points within 60 m | — | 24 | 48 |
| Sound zones overlapping one point | — | 3 | 4 |
| Grass density multiplier | ×1 | ×1.5 over > 1 ha | ×2 (the slider's top) |
| Swapped tree placements, whole world | 5,586 [confirmed: TREES §W3] | 7,500 | 8,192 (the band texture's slots) |
| Atlas pages per texture array (a never-used model brings its textures) | ≈ 36 albedo pages for the world [projected: BATCHING §3] | 200 | 256 (G4; a spill costs a draw) |

- **The triangle lines are counted before the tree swap.** TREES' swap raises tree triangles in view (33 k → 47 k at
  the plaza with LOD1 [confirmed: TREES §W5]) under its own budgets (TREES §W6); the editor's lines count the
  carriers' retail LOD0, so a planted tree counts as its carrier, and the Publish bench (below) measures the swapped
  result.
- **The view meter** (bottom bar) shows the engine's draws and the visible triangles at the editor's preset, beside
  the nearest measured bench scene (plaza: 152 draws on Medium, 218 on High, WebGPU [confirmed: budgets.md polish
  re-bench]); the gate G4 (world draws at the plaza ≤ 70 Medium / ≤ 100 High, main + shadow, post excluded
  [confirmed: WAVE_PLAN6 §5.4]) is checked by the Publish bench, not guessed by the meter (§F20).
- **The bench at Publish** [decision D43]: when a touched region's triangles or draws grew by more than 10 % or by
  more than 5 k triangles, Publish benches the starred views (400 frames, GPU lock, waiting if it is held) on the live
  and the staging export at **Medium and High, WebGPU and WebGL2**, and stops past any of:
  - G1: Medium p95 < 16.7 ms on both backends;
  - G2: High WebGPU ≤ 12 ms at the plaza and ≤ 14 ms in the crowd, WebGL2 High ≤ 8 ms at the plaza (WAVE_PLAN6
    §5.4) [confirmed: the gate lines]; a G2 miss stops the publish only when the live export passed it;
  - **the Mac margin** (§F21): the dev GPU p50 (WebGPU timestamps, as budgets.md measures it) may grow by at most
    **0.15 ms** in a view that shows the sea and **0.4 ms** elsewhere. A base M1 runs ≈ 9–11× the dev GPU time
    (WAVE_PLAN6 §5.2: 1.1 → 9.5–12.6 ms at the plaza, 11–15 ms at the beach on Medium), so these are ≈ +1.5 ms and
    ≈ +4 ms on an M1, which keeps the projected M1 beach and plaza under 16.7 ms [projected]. The CPU-bound p95 on
    the dev PC would not show a GPU-heavy edit; this line does.

### 7.3 Map bounds, the coast, protected ground [decision D44]

- **The export's edge:** brushes fade to zero over the last 8 m inside the outermost exported regions; no layer exists
  outside exported regions.
- **The playable bounds** (`stream.playable`, x 156–174 × z 90–102): outside them edits change the scenery only
  (allowed, but nobody walks there: the server's clamp keeps players in, so the walking checks skip them); the editor
  draws the line on the ground and greys walking overlays outside.
- **The coast:** a vertex in the coast's sea mask stays at least 0.5 m below the sea level; a dry vertex within 200 m of
  the sea mask stays at least 0.3 m above it; so the sea mask, the ocean field and the shore never need recomputing,
  and no dry pit opens below the sea next to the water. Strokes clamp live with a message.
- **The tomb keep** (COAST §3B.4) and the corridor's retail land stay as the coast keeps them (the frozen masks win
  after the edits pass).
- **Safety of data:** atomic writes, the journal, git per publish, the staging export, nothing deployed without the
  Deploy confirmation; the editor API writes only its folders (§2.2).

---

## 8. Budgets per preset (WAVE_PLAN3 §5.2 / WAVE_PLAN6 §5 format; 1080p)

Dev PC = Ryzen 5 9600X + RX 9060 XT, Chrome. Baselines: the polish re-bench (`wave10/budgets.md`, 2026-10-01 12:47)
[confirmed]. The editor itself is not in any player's frame; what reaches play is the **content** the user makes and
four small runtime additions.

**What the editor adds to play, per preset:**

| Preset | Runtime additions | Frame p95 effect at the gate scenes | Draws | VRAM | Download |
|---|---|---|---|---|---|
| Low | light points: no point light (Low makes none [confirmed]) but the ground splat glows (a CPU bake at region commit, all presets [confirmed: `night-lights.ts`]); grass masks: no (retail scatter); sound zones: yes (CPU ≤ 0.05 ms) | 0 [projected] | +0 | +0 | the re-converted regions' files (below) |
| **Medium** | light points in the existing 8-light container and the splat; grass masks fetched and multiplied in the bake; sound zones; placement `scale` | **0** with no edits; with edits, bounded by §7.2 | +0 for batched objects; a pond in a region without water +1 (one water mesh per region [confirmed: `water.ts`]) | +0 (masks multiply into the existing bake) | per touched region ≈ **0.14 MB** (171_97 in `out-opt`: terrain bin.br 63 KB, lightmap WebP 15 KB, minimap WebP 28 KB, nav chunk br 33 KB [confirmed: file sizes]) + a grass mask 2–20 KB where painted [projected]; per publish up to `manifest.json.br` 232 KB (placements), `nav-objects.bin.br` 141 KB (footprints), `worldmap.webp` 646 KB (minimap) [confirmed: sizes]; served `no-cache` + ETag, so a reload fetches them [confirmed: `static.ts` 169] |
| High | as Medium, 32 lights; edited objects also cast real-time shadows (statics within 150 m, foliage within 60 m [confirmed: RENDER's sun-shadow row (2048 × 3 to 150 m), TREES §1]) | 0 / bounded (G2) | +0 batched (the shadow proxies re-merge with the region) | +0 | as Medium |
| Ultra | as Medium, 64 lights | 0 / bounded | +0 | +0 | as Medium |

**WAVE_PLAN6 §5.2 columns for the content the editor allows** (a region at the warn line, 60 k object triangles, in
view) [projected]:

| Preset | World draws at the plaza | GPU dev | Mid desktop (CPU × 1.5) | Laptop / M1 | VRAM | Download |
|---|---|---|---|---|---|---|
| Low | unchanged | unchanged | unchanged | unchanged (N100 class) | +0 | as above |
| Medium | +0 (batched; G4 checked by the bench) | ≈ +0.3–0.5 ms | CPU unchanged (+0 draws) | M1 GPU ≈ +3–5 ms on 9.5–12.6 (plaza) / 11–15 (beach): **over the line at the beach**, hence the Mac margin of §7.2 (≤ +0.15 ms dev near the sea ≈ +1.5 ms M1) | + the new models' atlas cells, ≤ 1 MB per new model [projected] | as above |
| High | +0 (shadow proxies merged) | ≈ +0.5–0.8 ms (main + shadow) | CPU unchanged | gaming laptop: the High crowd already misses (WAVE_PLAN6), edits must not add to it: G2's bench line | as Medium | as Medium |

**What edits may cost, and the lines that keep G1 and G2:** G1's tightest Medium scene is the crowd with 20 jumping
bots, **13.7 ms WebGPU / 8.9 ms WebGL2** [confirmed: polish re-bench]; plain scenes sit at 1.5–6.3 ms; High sits at
6.1 (plaza) / 8.1 ms (crowd) on WebGPU and 3.5 ms (plaza) on WebGL2 [confirmed]. A region at the warn line adds at
most ≈ +0.3–0.5 ms GPU on Medium when in view [projected: the plaza's 49 k-triangle centre region renders in the
1.39 ms GPU of the plaza scene], so on the dev PC a fully edited field region stays under 7 ms and the town centre
under 16.7 ms with ≥ 2.5 ms to spare [projected]. The dev PC is not the weak machine: friends with dedicated GPUs
start on **High** and Macs on **Medium** [confirmed: `w9-user-decisions.md`], and a base M1's GPU is ≈ 9–11× the dev
PC's [projected: WAVE_PLAN6 §5.2], so the Publish bench (§7.2) measures Medium and High on both backends and holds
the dev-GPU delta to the Mac margin instead of trusting this paragraph.

| Lane budget (dev PC) | Line |
|---|---|
| Brush stamp | ≤ 1 ms mean, ≤ 8 ms worst (prototype 0.07–2.4 ms mean, 3.5–34 ms worst across three sessions [confirmed]) |
| Region upload (heights + normals) | ≤ 1 ms (prototype 0.39–0.92 ms [confirmed]) |
| Take a region out of its batch (S-OBJ) | ≤ 50 ms total, no frame over 16.7 ms (the prototype's whole `rebuild()`: 2.3–4.6 s [confirmed], the reason for the seam) |
| Lightmap re-bake with object shadows (one region, worker) | ≤ 0.3 s in the editor, ≤ 1 s in the converter [projected; not prototyped] |
| Walk preview after a footprint move (S-NAV) | ≤ 50 ms on drop [unknown: the objects-only `NavWorld` rebuild is not timed] |
| Save | ≤ 0.5 s (prototype 0.09–0.13 s) |
| Publish, ≤ 9 regions | ≤ 2 min end to end, of which convert ≤ 15 s, optimize ≤ 30 s, nav checks ≤ 10 s [projected] |
| Play | §7.2 per region; G1 / G2 unchanged with no edits (the Low guard and the material budgets stay green) |

---

## 9. The prototype

### 9.1 What was built [confirmed]

`work/tmp/world-editor/` (scratch; nothing in `apps/`, `packages/`, `content/`):

- **`vite.config.mjs`**: a private Vite on **127.0.0.1:5293** rooted at `apps/viewer` (its engine and node_modules),
  serving `work/out` at `/out/`, the TL-K thumbnails at `/thumbs/`, the page at `/world-editor`, and a tiny editor API:
  `POST /__height?x&z` (a Float32 delta + mask → an LA16 PNG through `sharp`), `/__save`, `/__shot`. It wrote only
  under `work/tmp/world-editor/out/`. Stopped afterwards.
- **`editor.ts` / `editor.css`**: the editor page on the real renderer (`loadWorld`: WebGPU, Medium, PBR, modern sky,
  streaming, region batching, the new grass and life): the tool palette, Size / Strength / Softness sliders, the
  draped brush ring, **Raise / Lower / Smooth** (Raise and Smooth exercised; Lower = Raise reversed) on the global
  lattice with live mesh + normal + grass updates, a commit step that re-applies the layer to regions that stream in again, **Move** with Babylon's position and
  rotation gizmos (yaw only), pick by ray against model bounds, the selected-object panel, ground snap, put back,
  the Changes panel with revert per change, undo / redo, Save, the budget line, on-screen keys.
- **`publish-dryrun.ts`**: Publish's checks on the saved layer (§6.3 table).
- **`region_census.py`**: the per-region guardrail numbers (§7.2). **`sharp16.mts`**: the 16-bit PNG round trip.
- **`ui-shot.js`**: a full-UI screenshot from inside the hidden pane (the canvas plus the panels rasterised through
  an SVG foreignObject).

### 9.2 Results [confirmed: measured in the page, 1920 × 1080, WebGPU, Medium]

| | Result |
|---|---|
| Brush strokes | 4 strokes, 280 stamps (Raise 26 m, Raise 18 m, Smooth 30 m, Raise 34 m) at Hill of Ye Mt., region 171_97 |
| Stamp time | mean 0.07–0.30 ms per stroke on a quiet run, 0.48–2.39 ms on a busy one; worst 3.5–34 ms (three sessions) |
| Live region update (positions + normals of 97 × 97) | 0.39–0.92 ms (109–257 ms / 280 updates) |
| Worst editor work in one frame | 5.8–40 ms (first use, garbage collection) |
| The edit | 468 lattice vertices, +14.29 m / −0.34 m |
| Undo × 4 / redo × 4 | max \|h − exported\| = 0 / max \|h − edited\| = 0 (bit-exact) |
| Object pick (the real click path, a ray at the tree's projected pixel) | tree `tre_tree01` uid 32770 (region 171_97) |
| Out of its batch | `stream.rebuild()` 2.3–4.6 s (whole world): the batch then held 7 of the region's 8 `tre_tree01` [confirmed: the filter's log `8 -> 7`] |
| Move | 31.6 m, +40°, snapped 1.95 m up onto the raised ground; panel "on the ground", "walk blocker: yes" (its nav instance, one of the client nav's 2,233 [confirmed]) |
| Save | 1 LA16 height layer (`out/layers/height/171_97.png`) + `placements.json` + `edits.json` + `journal.json` in 88–127 ms; the height layer is 1,466 bytes |
| Dry run | §6.3 table |

Images (`work/tmp/world-editor/out/shots/`): `UI-brush.png` (the editor with the Raise brush, the Changes list, the
library, the keys bar), `UI-move.png` (the tree selected with the gizmo and its panel), `S1-before.png` →
`S2-after-brush.png` → `S3-picked.png` → `S4-moved-gizmo.png` → `S5-after-all.png` (the same camera: before, the hill
raised, the tree picked up, moved onto the hill, the final state), and **`sheet.png`** (the four plus the two UI shots in
one labelled sheet, 1920 × 1792).

### 9.3 What the prototype found (each is a rule or a seam above)

1. **A region must leave its batch cheaply.** The only public way was `stream.rebuild()`, which reloads every region
   (2.3–4.6 s). Seam S-OBJ: `WorldObjects.setEditorOwned(pred)` plus a per-region re-batch (`RegionStreamer
   .reloadObjects(rx, rz)`).
2. **A thin instance of the converted model is not enough for the proxy.** Re-adding the placement through
   `addStatic(-1, ...)` gave a mesh that was active and ready but not visible [confirmed: debug in the page]; a clone
   of the cached container (`instantiateModelsToScene`, as `placeClone` does for animated props) drew correctly. The
   production proxy is an editor-owned batch (S-OBJ); the clone is the fallback.
3. **Edits must be re-applied before the mesh is built**, not after: the commit-step route builds the mesh twice
   (S-FILTER).
4. **The client nav keeps the old heights**: `world.pick` can't be used for the brush (S-NAV preview).
5. **Retail trunks sit below the ground** (tree 32770: 1.4 m): "buried / floating" must compare clearances, not
   absolute heights (§6.3 check 6); the first dry run flagged the moved tree wrongly until it did.
6. **Trees carry nav footprints**: moving a tree moves an obstacle (§6.3 step 3).
7. **The slope rule is needed and works**: without it the 14 m mound would be walkable up a 50° face.
8. **The first "walk blocker" guess was wrong.** The prototype's panel first guessed from the model name; the nav
   instance list is the truth (trees block), and the panel now reads it (`blocksWalking`).
9. **Measuring note:** every number here is CPU-side (stamps, uploads, decode, reach); none is a GPU timing. The first
   two sessions ran between 15:10 and 15:30 while TREES-w12 held `work/tools/gpu.lock` for its own bench (taken at
   15:24:19); the editor page was rendering in the hidden pane during part of that window. **TREES-w12's lab bench
   numbers from 15:24 to 15:30 may be disturbed and deserve a re-run** [likely disturbance, not measured]. The final
   session (the images and the busy-machine numbers) ran 15:37–15:40 under this spec's own lock. Hence rule D47.

---

## 10. Decisions (each the recommended option; the user delegated)

- **D1** The editor is a page of `apps/viewer` with a local editor API, not a mode of the game: never shipped, never
  on the live server, same renderer.
- **D2** `pnpm editor` and a desktop shortcut start it: one click, no terminal.
- **D3** The API listens on 127.0.0.1:5185 (strict) with a session token, Origin and Host checks, and writes only its
  folders: GM-only by construction, and no clash with texpipe's review port 5190.
- **D4** One editor at a time (a lock file): no two writers.
- **D5** `/editmap` in the game prints a local link that only asks the open editor to fly there (no token in chat):
  convenience without an in-game editor.
- **D6** "Test in game" uses a staging export (`jangan-fields-edit`), a private server on a DB copy and a private game
  Vite; the user logs in themselves: the dev servers are never touched and no password is ever typed for them.
- **D7** Layers live in `content/world-edits/<world>/`, per region: small diffs, git history, the coast's container.
- **D8** Heights are deltas with a base hash per region: edits ride on the base; reverting is a subtraction.
- **D9** Paint stores tile ids: the palette is the whole tile set.
- **D10** Placement edits of retail placements are one list keyed by `(region, uid)`; a move is applied as C9's drop +
  add of the same key: the converter's existing `applyPlacementEdits` applies it.
- **D11** Editor adds get uids 0xE000–0xEFFF of their owner region (16-bit, as nav ids need), recorded in one registry
  with the dressing's 1,000,000+: no collisions. A move out of the owner region takes a fresh editor uid.
- **D12** Uniform scale through a new optional placement `scale` (S-SCALE): 0.5–2 for footprint-free models, 0.85–1.15
  for trees (their small footprints keep the unscaled nav), never buildings; no tilt this wave.
- **D13** Free light points go to `ambient.json` `points`: the night lights read one list.
- **D14** Sound zones are a content file played beside the area loop: no change to SOUND's area system.
- **D15** `probes.json` with gates, places and the spawn by default: "roads still connected" is checkable.
- **D16** One change per user action, each with its own difference: undo, redo and revert-one are exact.
- **D17** The journal lives in `work/editor/`, capped; git holds publishes: unlimited history without bloating git.
- **D18** Save writes layers only, atomically, with a 2-minute autosave: never loses work, never converts.
- **D19** The converter applies edits as a pass after the coast and the town dressing (footprints already in its
  earlier nav step), sharing one node-free module with the editor: the user's hand wins and the preview equals the
  export.
- **D20** The paint palette groups the upscaled tiles by surface (grass, sand, dirt, rock, road, as the user said) from
  a curated `palette.json`: the retail type names have no road group.
- **D21** No sub-2 m detail splat this wave: it needs a new terrain plugin seam.
- **D22** Grass and flower painting are 1 m masks that multiply GRASS_LIFE's bake: the far rings follow.
- **D23** Low ignores grass masks: the Low guard stays exact.
- **D24** The library is every converted model + the TL-K census + the new trees and plants.
- **D25** New trees are placed as their carrier model from TREES' `library.json` through T12-E's API: one placement
  format, Low and the nav stay consistent, and the swap draws the new tree.
- **D26** Thumbnails are rendered by the editor with the game's materials, cached outside git.
- **D27** A drag ends on the ground, keeping the exported clearance; Ctrl holds the height.
- **D28** Linked objects (the palace bridge chain) can't be moved alone.
- **D29** A Walkable brush exists for the rare manual case; force-open is checked like any edit.
- **D30** Tiles under new water deeper than 1.2 m close until swimming (wave 13).
- **D31** At most 2 zone loops play at once, nearest first: the ambient voice budget holds.
- **D32** Town routes and seats are an authored overlay in TOWN_LIFE's file that `town-graph` keeps and applies, checked
  by its validator; the dressing's props are edited by row: nothing is lost when the graph is rebuilt.
- **D33** Nests, NPCs and quests stay in the game's GM tabs; the editor links to them.
- **D34** Every message is a sentence with a way out.
- **D35** Save, Publish and Deploy are three buttons with three different reaches.
- **D36** Deploy is the existing deploy in its assets-only mode behind a confirmation the user clicks (that click is
  the user's OK), refused while the converter's code is mid-change: map edits never ship half-built code.
- **D37** Optimize processes only changed files and merges `slim.json`: 15-minute runs are gone for map edits.
- **D38** Publish runs the named tests that cover map content, never the full suite.
- **D39** Publish commits its own `content/` paths by pathspec with a plain-English message: the user never runs git and
  no other lane's work is swept in.
- **D40** One pure nav rule (slope > 35° closes, never auto-opens, deep new water closes, overrides last, footprints
  moved with their objects), shared by preview, converter and tests.
- **D41** Publish stops on traps, lost reachability, broken probes, invalid layers, coast or bounds violations, failed
  tests; it warns on cut-off ground, props, overlaps and soft budgets.
- **D42** Per-region guardrails from today's census (60 k / 90 k object triangles, ...).
- **D43** Publish benches the starred views when a region grows > 10 % or > 5 k triangles, at Medium and High on both
  backends, against G1, G2 and the Mac margin (dev GPU +0.15 ms near the sea, +0.4 ms elsewhere).
- **D44** Brushes respect the export edge, the bounds (scenery only outside), the sea mask and shore band, the tomb keep.
- **D45** No Meshy credits for the editor: it makes no assets (TREES owns the wave's Meshy work; a Meshy-made prop would
  enter the library through TOWN_LIFE's dressing models).
- **D46** No downloads: Babylon's gizmos ship in `@babylonjs/core` [confirmed]; no Blender MCP.
- **D47** The editor renders on demand (an idle editor draws nothing) and stops its continuous previews while another
  owner holds `work/tools/gpu.lock` (a banner says why): it never skews a lane's GPU bench and never freezes for hours.
- **D48** One key per tool, shown on the palette and in the bottom bar; WASD fly only while the right mouse button is
  held: the user never has to remember them, and keys never fight the camera.
- **D49** The editor previews at High by default (what this PC's game starts on) with Medium and Low toggles: the
  user sees the game's look and can check what Macs and the N100 see.
- **D50** Height deltas use `L = 32768 + round(dh × 256)` and the editor snaps strokes to that grid: zero is exact and
  the preview equals the export bit for bit.
- **D51** Object edits re-bake the lightmap with object shadows (heightfield + LOD0 triangles, leaf cards cut at 0.5):
  no ghost shadows, and planted trees shade the ground on Medium and Low as retail ones do.
- **D52** Publish replaces changed files one by one (temp + rename, manifest last, a backup kept) under a convert lock:
  safe on Windows, safe with hard links, never racing a lane's convert.
- **D53** The incremental convert re-runs the placement passes on the cached pre-pass list: no double-applied coast or
  dressing edits.
- **D54** A new seam S-NAV (instance replace in `NavWorld`) lets the walk preview follow moved footprints: what the user
  walks in the editor is what the server will allow.
- **D55** Grass masks ship as per-region files listed in the manifest, fetched only where painted: the client bake can
  apply them, and unpainted regions download nothing new.

## 11. Needs from the user

- **Nothing blocks the start.** No downloads, no uploads, no credits.
- **User checks** (after the build):
  1. Open the editor from the desktop shortcut; raise a hill, paint a path, plant three trees, move a lantern, undo,
     revert one change (≈ 10 minutes). Say what feels clumsy.
  2. Press Publish on that edit; read the report; press "Test in game" and walk it.
  3. When happy, press Deploy (the friends' server restarts; players reload). Mid-wave, Deploy may answer that the map
     goes out with the next release (§6.1); that is expected, not an error.
  4. Look at one planted tree and one moved building from far away on Medium (the Publish sheet's 400 m view): no
     shadow left behind at the old spot, a shadow under the new one.

## 12. Open questions (each with the default used meanwhile)

1. **Should a GM friend be able to edit from their own PC?** Default: **no**, this PC only (D3). Opening it to friends
   means the in-game route (option B) and authenticated server writes, a later wave.
2. **May the editor change ground inside the town walls?** Default: **yes**, with the same checks; the town's
   buildings' footprints and the plaza floors are objects and do not move with the ground.
3. **Should Publish also commit to git automatically?** Default: **yes** (D39); the user can say "ask me first".
4. **Camera controls:** default right-drag orbit, middle-drag pan, wheel zoom, WASD fly while the right button is held
   (§5); the user may prefer the game's camera.
5. **Deploy while a wave is being built?** Default: **no** (D36): the editor deploys map edits only when the converter's
   code is committed and already deployed; otherwise the map ships with the next release. The user can ask Claude to
   ship sooner.

## 13. Lanes

Lane ids `WE-*`. Every lane runs its tests and `pnpm typecheck` before hand-off; nobody commits; the lead integrates.
Effort is agent-days.

### 13.1 Step order

1. **Step 0, the seams** (disjoint packages, in parallel): WE-P (`packages/shared`), WE-S (`packages/world-render`
   and S-NAV in `packages/nav`; its `world.ts` and `batch/trees.ts` lines after TREES T12-0 / T12-M, §15),
   WE-CV (`packages/convert` pass slot, source overlay hook, navmesh-step hook, `--only` and `--files` skeletons, the
   uid registry, the convert lock).
2. **Step 1** (parallel): WE-D (convert: apply layers), WE-N (nav rule + checks), WE-A (editor API), WE-U (editor UI),
   WE-L (library + thumbnails), WE-R (runtime: light points, grass masks, sound zones), WE-I (incremental convert +
   optimize).
3. **Step 2:** WE-T (town routes and seats, after wave 11's TL-R file and validator are in), the Publish report and
   before / after (WE-A + WE-U), "Test in game" (WE-A).
4. **I-WE** integration, **LAB-WE** (the editor's own budgets and one Publish bench), the user checks.

### 13.2 Lane table

| Lane | Files (owner) | Seams it uses | Tests | User check | Effort |
|---|---|---|---|---|---|
| **WE-P** | `packages/shared/src/world-edits/**` (types, decode / encode of every layer, the apply functions, the nav rule, validators), `packages/shared/test/world-edits*.test.ts` | — | layer round trips (LA16 exact), apply determinism, the nav rule on fixtures (cliff closes, never opens, water > 1.2 m closes, overrides), validators | — | 1.5 |
| **WE-S** | seams in `packages/world-render`: **S-TERR** `TerrainRenderer.updateRegion(id, { heights?, words? }, rect?)` (incl. the layer texture when L grows, the lightmap layer re-upload); **S-OBJ** `WorldObjects.setEditorOwned(pred)` + `RegionStreamer.reloadObjects(rx, rz)` (one region re-batch); **S-GRASS** `GrassField.invalidate(rect)` + the mask fetch (manifest-listed) and multiply in `grass/bake.ts`; **S-FILTER** a `World` region filter at decode (`world.ts`: after TREES T12-0's `World.trees` slot lands, one owner per step); **S-NL** `ambient.points` in `night-lights.ts` (pick + splat); **S-SCALE** the optional `WorldPlacement.scale` at every compose site (`objects.ts`, `batch/region-batch.ts`, `batch/trees.ts` with T12-M, `ambient-fx.ts`, `life/spawn.ts`, `town/fx.ts`) and the manifest type; water block update (`water.ts`, after wave 11's W11-S); **S-NAV** in `packages/nav`: an instance replace on `NavWorld` (or an objects-only rebuild) | — | each seam unit-tested on NullEngine; absent `scale` = byte-identical batches (the BT fixtures); the Low guard, material budgets, live-switch green | — | 3.5 |
| **WE-CV** | `packages/convert/src/world/passes.ts` (the "world edits" slot), `convert-world.ts` (the `editsSource` hook, the navmesh-step hook for footprint edits, the pre-pass placement cache, the convert lock), `cli.ts` (`world-edit` verbs), **S-UID** the authored-uid registry (retail, dressing 1,000,000+, editor 0xE000–0xEFFF) | WE-P | the pass order, untouched regions bit-identical, the nav step and the pass agree on every edited footprint | — | 1.5 |
| **WE-D** | `packages/convert/src/world/edits/**` (read layers, `editsSource`, placement edits as drop + add, water, light points, sound zones export, grass mask files, the minimap redraw inside the change mask reusing the coast's rules, and the **lightmap bake with object shadows**: heightfield + LOD0 triangles, leaf cards cut at 0.5, node-free so the editor's worker runs it too) | WE-P, WE-CV | determinism (two converts, same bytes), the coast checks unchanged, props snapped / listed; a moved fixture tree leaves no shadow texel at its old spot and casts one at the new spot | — | 4.5 |
| **WE-N** | `packages/convert/src/world/edits/nav-edit.ts`, `checks.ts` (traps, reachability, probes, cut-off, props, overlaps, budgets), the report JSON | WE-P | the dry run's numbers as a fixture test (with the rule as written: 117 of 443 closed); closed tiles carry the closed cell and the blocked flag; nests / NPC / probe reachability; no new traps | — | 2 |
| **WE-I** | `convert-region --only <regions>` (with the 1-ring), `optimize-out run --files` + the `slim.json` merge, the `nav.bin` / `nav-objects.bin` / chunk splice, the pre-pass placement cache | WE-CV | incremental output = full output for the touched files (byte compare, including `nav-objects.bin`); `slim.json` untouched entries identical | — | 2.5 |
| **WE-A** | `apps/viewer/editor-api/**` (Vite plugin on :5185 with its own cacheDir: token, Origin and Host checks, lock, atomic layer I/O, journal, publish orchestration, staging export `jangan-fields-edit`, per-file swap with backup, "Test in game" server on a DB copy + a private game Vite, pathspec git commit, the assets-only deploy hand-off and its refusals), root `package.json` script `editor`, `work/editor/` shortcut | WE-P, WE-I, WE-N | API rejects bad origin / host / token; atomic writes; journal replay; Deploy refused with dirty converter code | — | 3 |
| **WE-U** | `apps/viewer/editor.html`, `apps/viewer/src/editor/**` (palette, brushes, gizmo, selection, library panel, Changes, status, budget meter, minimap, walking overlay, Walk here, render-on-demand, `content/world-edits/<world>/palette.json`) | WE-S, WE-P, WE-A | brush math on the lattice (seams bit-identical), deltas snapped to 1/256 m, undo / redo exact, revert-one | the ten-minute session | 4.2 |
| **WE-L** | `apps/viewer/src/editor/library/**` (classification, thumbnails bake, the Trees tab from `content/trees/library.json` through TREES T12-E's `World.trees.library() / preview() / setHidden()`) | WE-U, T12-E | every model classified; every library species has a carrier; thumbnails cached | the library looks right | 1 |
| **WE-R** | `apps/game/src/audio/zones.ts` + its world feature (sound zones), the light points and grass masks through WE-S | WE-S, WE-D | zones voice cap (≤ 2, ≤ 1 beside wave 11's town loops); Low ignores masks | listen to one zone | 1.5 |
| **WE-T** | `apps/viewer/src/editor/town/**` (route and seat tool), the `manual` overlay in `content/town/jangan.json` and its application in `packages/convert/src/town/build-graph.ts` (TL-R's file, after wave 11), dressing-row moves in `jangan-dressing.json` | wave 11 TL-R's file and `validateTownFile` | edges checked on the navmesh; a `town-graph` rebuild keeps every manual edit | move a bench, watch a townsperson sit | 2 |
| **I-WE** | integration, docs (this spec's "as built"), DEPLOY.md's editor note | all | the named gates | — | 1.5 |
| **LAB-WE** | the editor budgets (§8 lane table) and one Publish bench, GPU lock | all | — | — | 0.5 |

Total ≈ 29 agent-days [projected] (the fact-check added S-SCALE, S-NAV, the object-shadow bake, the town overlay and
the deploy guards: WE-S +1.5, WE-D +1.5, WE-CV +0.5, WE-A +0.5, WE-T +0.5, WE-U +0.2 = +4.7). The `/editmap` GM command is a one-file change in `apps/server/src/gm.ts` folded
into WE-A (0.2 day).

## 14. Scope-cut order (cut from the top) and never-cut

1. Sound zones (WE-R's zones; the content file stays defined).
2. "Test in game" (Publish + restart the local server instead).
3. The lights tool's free points (lanterns from the library still light).
4. Town routes and seats (WE-T; edit with TOWN_LIFE's script).
5. The Noise brush.
6. The Publish bench of starred views (keep the guardrail counts).
7. The thumbnail bake (names and the TL-K Blender thumbnails).
8. The editor's live lightmap preview (the converter still bakes at Publish; the editor shows the old shadows until
   then).
9. Scale for non-tree models (S-SCALE then serves trees only).
10. Incremental optimize (fall back to the full 15-minute optimize at Publish).
11. Water.
12. Grass and flower painting.
13. Multi-select and copy / paste.

**Never cut:** Raise / Lower / Smooth / Flatten; texture paint; place, move, turn, delete from the library with ground
snap; undo / redo / revert one change / revert a region; Save; a Publish that rebuilds walking and stops on traps or
lost reachability; the object-shadow bake at Publish (no ghost shadows); assets-only Deploy only on the user's click;
the editor never shipped to players.

## 15. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Wave 11 is editing `passes.ts`, `convert-world.ts`, `world-render`, `gm.ts`, `water.ts`, `town/build-graph.ts`, `audio/town.ts`; TREES wave 12 edits `world.ts`, `batch/trees.ts`, `batch/merge-core.ts` | seam collisions | step 0 starts from wave 11's final commit (WAVE_PLAN8 decides); one owner per shared file per step: T12-0 takes `world.ts` first and WE-S adds S-FILTER after it; S-SCALE's `batch/trees.ts` line goes through T12-M |
| A dressing row is added or skipped | dressing uids shift | dressing props are edited by row id, never by uid (§3.2) |
| A map Deploy in the middle of a wave | half-built code or data reaches the friends | assets-only, refused with dirty or undeployed converter code (§6.1) |
| A moved object's baked shadow stays | a ghost shadow at distance on Medium and everywhere on Low | the object-shadow bake (§6.2 step 2); the Publish sheet's 400 m view |
| A GPU-heavy edit passes on the dev PC and fails on Macs | Mac friends drop below 60 fps | the Mac margin on the dev GPU delta (§7.2) |
| The incremental convert drifts from the full convert | the published map differs from a later full re-export | the byte-compare test (WE-I); a full convert at every release gate |
| A region's re-batch hitches | a stall while editing | S-OBJ's ≤ 50 ms budget, worker merge; the clone fallback |
| The base changes under an edit (a coast re-run) | a delta lands on different ground | base hashes, "check this region" list (§3.1) |
| Uid collisions between authored sources | a wrong object moves | the S-UID registry and a converter error on overlap |
| The user edits something big and breaks walking | friends stuck | the Publish stops (§6.3), Deploy is separate, revert per region |
| A heavy edit costs frames | G1 at risk | guardrails (§7.2), the bench at Publish |
| The editor's GPU use during another lane's bench | skewed numbers | the editor pauses rendering while another owner holds `work/tools/gpu.lock` (a banner says why) [decision D47] |
