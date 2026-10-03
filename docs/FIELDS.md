# Fields around Jangan and region streaming

The world today is Jangan town: 9 regions (167–169 × 96–98), 8 nests centred inside it (120 mobs, `inConvertedRegion`) and about 160 monsters (the server's `inWorld` check, `nav.place` within `min(20, max(radius, spawnRadius))` m, also admits 3 border nests: 11 nests / 160 mobs **[likely, arithmetic over `nests.json`]**). This spec grows it to the level 1–20 hunting grounds around Jangan and makes the client stream regions instead of loading the whole world at once. It covers:

- the playable area, from the nest data;
- the budgets, measured by converting the whole area;
- region streaming in `@sro/world-render`, together with the client navmesh;
- the server side: the area's navmesh, every nest, interest management, the safe zone and return points;
- the minimap and a world map on **M**;
- a build plan in parallel lanes.

This is a design document; no code was changed. The reachability work in `packages/nav` (component labelling) is happening in parallel, and this spec does not design over it. It only relies on the rule that lane is adding: **placements must lie in the town spawn's component.**

## Status tags

- **[confirmed]**: checked in the data or code in this repo, or measured for this spec (method given).
- **[likely]**: follows from the code, the data or the sources, but was not run end to end.
- **[unknown]**: not established; the build lane has to check it.

Measurements were taken on the dev PC (AMD Ryzen 5 9600X). The target host is an Intel N100, which has roughly 2–2.5× less single-thread performance **[likely]**, so server timings are projected with ×2.5.

---

## 0. Decisions (TL;DR)

1. **Export set: regions X 155–175 × Z 89–103.** This is 315 regions; 8 are inactive in `mapinfo.mfo` (163–169 and 175 at z 103), which leaves **307** (fact-check: re-converted, the converter reports 307). It is written as a **new export folder `work/out/world/jangan-fields`**, in the same frame as today: origin at the south-west corner of region 168,97. Saved positions therefore stay valid. `work/out/world/jangan` (3×3) stays as it is, for tests and the fast viewer.
2. **Playable set: X 156–174 × Z 90–102** (247 regions). It is written as `manifest.bounds`, which the server already reads and clamps moves to. The outer ring is terrain to look at, not to walk on, so nobody walks into an invisible wall at the edge of the loaded data.
3. **The world id stays `jangan`.**
   - That id covers the nests, towns, NPCs, saved characters and GM `tp jangan`.
   - A new server setting, `WORLD_EXPORT` (default `WORLD`), picks the export folder. The client learns the folder from `ServerInfo.world` and from `WorldInfo.name`.
4. **Server: the whole area at once.**
   - It loads the full `nav.bin` of the area: 22 MB, about 40 ms, about 120 MB more RSS.
   - It spawns every nest with mob level ≤ `MOB_LEVEL_MAX`: 791 nests and 6,944 mobs, measured.
   - Interest management already exists (`VIEW_RANGE` 120 m, a grid, 10 m hysteresis) and stays.
5. **Client: streams regions.**
   - A region is loaded when the distance from the focus point to the region's rectangle is ≤ 400 m, and unloaded when it is > 560 m (defaults for medium quality).
   - Priority is that distance, shortened for regions in the camera's view direction.
   - Main-thread work is limited to 4 ms per frame.
   - Models and terrain tiles are shared and reference-counted.
   - The client navmesh is streamed per region as well: all object navmeshes are loaded once (398 KB, 142 KB brotli), and terrain comes per region (74,716 B each, about 31 KB brotli median). Prediction is skipped whenever a move crosses a region that is not loaded.
6. **Minimap and world map.**
   - The minimap draws per-region tiles, loaded with the streamed regions, instead of one atlas image.
   - **M** opens a world map built from a stitched overview image (`worldmap.webp`, 64 px per region). It shows the zone names from the client's `textzonename.txt`, the town, the player and hunting-ground labels.
7. **Protocol: one additive field** (`ServerInfo.world`). Everything else is file formats (a manifest `stream` block, per-region nav chunks, `nav-objects.bin`, `worldmap.png`, `data/zones.json`), server config and client code.

---

## 1. The playable area (levels 1–20)

### 1.1 Which nest file

| File | Content | Used by the server |
|---|---|---|
| `work/out/data/nests.json` | The 825 nests of the port's `jangan_province`, all `enabled: true`. Region span 155–174 × 90–102, levels 1–30. 7,156 mobs at full counts. 8 nests (120 mobs) lie in today's 9 regions (`inConvertedRegion`). **[confirmed]** | Yes. `GameData` loads `nests` (`gamedata.ts` `LOADED_KINDS`), and `Spawner` keeps nests whose `world === config.world` **[confirmed]** |
| `work/out/data/all-nests.json` | All 7,350 nests of every province: jangan 825 (enabled), donwhang 772, hotan 1,491, europe 1,318 and samarkand 2,944, all `enabled: false`. Same frame and origin. **[confirmed]** | No |

The other provinces do not matter for levels 1–20 of the Chinese race:

- Donwhang is levels 21–43 (regions rx 143–161).
- Hotan is 39–80 and Samarkand 21–40.
- Europe (levels 1–24) is the European starting area, rx 68–81, about 17–19 km west, and is out of scope.

**[confirmed]** So the area is exactly the Jangan province of `nests.json`.

`mobs.json` has the 32 Jangan-province mobs, levels 1–30, including the `_CLON` variants and Tiger Girl **[confirmed]**. Levels:

- 1–10: Mangyang 1 … Decayed Yeoha / Yeoha 10.
- 11–20: bandits, tigers, White Tiger 18, Chakji 20, Tiger Girl 20 (unique).
- 21–24: Western China mobs (Ghost Bug 21, Devil Bug 22, Hyungno Ghost Soldier 23, Hyungno Ghost 24).
- Above 24: Earth Ghost and Meek Gun Powder 27; Earth Taoist and Hyeongcheon 30.

**Nests with mob level ≤ 24:** 791 nests, 6,954 mobs, in **169 regions**, spanning rx 156–174 and rz 90–102. **[confirmed]** (Scratch script over `nests.json` + `mobs.json`. The `region` field agrees with `168 + floor(x/192)`, `97 + floor(−z/192)` for all 825 nests.)

The server's default filter `MOB_LEVEL_MAX = LEVEL_CAP + 5 = 25` gives the same set. In the measured run it spawned 791 nests (34 skipped: 20 Earth Ghost, 6 Meek Gun Powder, 7 Earth Taoist and 1 Hyeongcheon nest), for **6,944 mobs**. **[confirmed]** (6,954 − 6,944 = 10: the 11 Tiger Girl camps share one `uniqueGroup`, so only one of their 11 mobs is alive.)

**Tiger Girl** (`MOB_CH_TIGERWOMAN`, level 20, unique):

- 11 camps sharing `uniqueGroup`, with respawn 10,800–21,600 s.
- The camps are at regions (160,92), (159,91), (160,91), (161,91), (157,93), (158,95), (159,94), (162,93), (162,90), (158,90) and (157,91). All lie in South/North-Tiger Mt. and the Bandit stronghold. **[confirmed]**
- `Spawner` already keeps one alive per group.

### 1.2 Map

Region grid, north up. Each cell is a level band plus density: roughly monsters/10 in the region, capped at 9. Tiger Girl camps are marked `*`.

- Bands: a = 1–5, b = 6–9, c = 10–14, d = 15–20, e = 21–24, x = above the cap only.
- `TT` is Jangan town, `##` is inactive in `mapinfo.mfo` (175,103 is inactive too; column 175 is not drawn), and `..` has no nests.

**[confirmed]** (scratch script; the band is the **count-weighted** mean level of the region's nests with level ≤ 24, the digit is `min(9, round(mobs/10))`). Fact-check: the first draft's map differed in 4 borderline cells (159,100; 160,91; 163,91; 158,90), whose mean sits on a band edge; this version is recomputed with the stated rule. Treat the bands as approximate; the per-nest `level` field is the truth.

```
  z/x 55 56 57 58 59 60 61 62 63 64 65 66 67 68 69 70 71 72 73 74
  103  .. .. .. .. .. .. .. .. ## ## ## ## ## ## ## .. .. .. .. ..
  102  x- e1 e5 e5 e6 e4 e3 .. .. .. .. .. .. .. .. .. .. b1 .. ..
  101  x- x- e5 e4 e6 e1 e4 .. .. .. .. .. .. .. .. .. b5 b4 b4 ..
  100  x- x- e9 e6 e5 d3 d1 .. .. .. b2 b7 b4 b8 b7 b2 b8 b7 b7 b1
   99  x- .. d4 d4 d4 .. .. .. .. c3 b2 b7 b5 b3 b5 b4 b1 b4 b4 ..
   98  .. d5 d3 .. .. .. .. .. c5 c2 c2 a6 TT TT TT a6 .. a5 a6 ..
   97  x- .. .. .. .. d6 d1 c1 c6 c5 c3 a6 TT TT TT a5 a5 a5 a4 ..
   96  .. .. d1 d4 c1 d3 c2 c4 c5 c3 a3 a9 a3 a6 a3 a9 a6 a6 a6 ..
   95  .. .. d2 d* d2 d1 c3 c4 c5 c5 a6 a8 a9 a6 a7 a9 a4 a4 a4 ..
   94  .. c2 d7 d4 c* d4 d4 c6 c4 c2 c2 a5 a8 a8 a2 a2 b2 b4 b4 ..
   93  .. d4 d* d5 d3 d2 c4 c* c4 c4 b3 a6 a4 a5 a6 b2 b4 b5 b3 ..
   92  .. d4 d4 d3 c3 d* d4 c4 c2 c3 a4 a5 a6 a5 a3 b3 b3 b6 b2 ..
   91  .. d3 d* d4 d* d* d* c4 d2 c2 .. .. .. .. .. .. .. .. .. ..
   90  .. d3 d5 d* d3 d2 c3 c* c4 c2 .. .. .. .. .. .. .. .. .. ..
   89  .. .. .. .. .. .. .. .. .. .. .. .. .. .. .. .. .. .. .. ..
```

Read it as: levels 1–5 wrap the town to the south and east; 6–9 lie in the swamp to the north and the tombs to the east; 10–14 in Yeoha's Forest to the west; 15–20 on the Tiger Mountains in the far west and south-west; and 21–24 on the Western China road in the north-west.

Town to Tiger Mountain (about region 160,93) is about 1.7 km. At 5.5 m/s that is about 5 minutes. **[confirmed arithmetic]**

### 1.3 Named areas

The names come from the client's `Media/server_dep/silkroad/textdata/textzonename.txt` (UTF-16LE). Its rows are `1 <regionId> <Korean> … <English>`, keyed by region id; English is tab field **index 8 (0-based)**, i.e. the 9th column, under the header `English` (header row `//Service CodeName128 Korean …`). The area codes come from `refregion.txt` (UTF-16LE): `<regionId> <rx> <rz> <ContinentName> <AreaName> …` (0-based fields 0–4). **[confirmed]**

Fact-check: `AreaName` is useless in this client. In the area's 213 `refregion` rows it is literal `?` characters (lost Korean, e.g. `??? ??`) everywhere except the 6 `Town_Jangan` rows **[confirmed]**. Only `ContinentName` (`CHINA` / `West_China`) carries information.

Of the 293 active regions of 155–174 × 89–103, 80 have no `refregion` row and 78 have no zone name (77 lack both). The 78 unnamed regions are 28–100 % open navmesh (median 85 %; valleys and plains between the named areas), and 47 of them lie in the playable set, so they are walkable **[confirmed, scratch script over the re-converted `nav.bin`]**.

The client's own spellings matter for labels and `tp` names: it writes **"Enterance of Qin-Shi Tomb"**, and it has both "Chinese Tomb" (9 regions) and "Chinese tomb" (171–172 × 91, 2 regions, no nests); group names case-insensitively **[confirmed]**.

| Area (English, textzonename) | refregion | Regions | Levels (spawned) | Mobs | Monsters |
|---|---|---|---|---:|---|
| Jangan | CHINA / Town_Jangan | 167–169 × 97–98 | town | 0 | 46 NPCs (42 in town) |
| Grassland | CHINA | 165–170 × 94–98 (19) | 1–10 | 1,057 | Mangyang, Small/Big-Eyed Ghost, Old Weasel, Yeoha |
| Hill of Ye Mt. | CHINA | 170–173 × 95–99 (17) | 1–9 | 728 | Mangyang … Weasel, Tomb Stone Ghost, Stone Ghosts |
| Lake Forest | CHINA | 165–170 × 91–95 (21) | 1–10 | 647 | ghosts, Old Weasel, Water Ghost, tombstones, Yeoha |
| Swamp area | CHINA | 165–170 × 99–101 (18) | 5–10 | 555 | Weasel, Water Ghost (Slave), Stone Ghost |
| Chinese Tomb (+ "Chinese tomb", 171–172 × 91, 2 regions, no nests) | CHINA | 171–173 × 92–94 (9) | 8–9 | 312 | Tomb Stone (Ghost), Stone Ghost |
| Enterance of Qin-Shi Tomb (client spelling) | CHINA | 171–174 × 99–102 (10) | 8–9 (+30, skipped) | 365 | Stone Ghosts; Hyeongcheon 30 (2 mobs) |
| Yeoha's Forest | CHINA | 162–164 × 93–99 (15) | 10–16 | 515 | Yeoha, bandits, Young Tiger, Tiger |
| North-Tiger Mt. | CHINA | 156–162 × 93–97 (24) | 10–20 | 823 | bandits, tigers, White/Black Tiger, Chakji Worker, **Tiger Girl** |
| South-Tiger Mt. | CHINA | 156–164 × 89–92 (23) | 10–20 | 687 | bandits, tigers, **Tiger Girl** |
| Bandit's Mountain Stronghold | CHINA | 159–161 × 91–92 (6) | 12–20 | 284 | Bandit Archer, Bandit, White Tiger, **Tiger Girl** |
| Jangan Ferry | CHINA | 157–161 × 96–97 (7) | 14–19 | 122 | Chakji Worker (70), Tiger, Bandit, White Tiger; ferry NPCs Doji (161,97) and Chau (158,96) |
| Western China Ferry | West_China | 156–161 × 98–100 (10) | 19–22 | 347 | Chakji, Ghost/Devil Bug |
| Western China Main Road | West_China | 157–161 × 100–103 (10) | 19–24 | 343 | Chakji, bugs, Hyungno |
| Western China Ruins | West_China | 157–159 × 102–103 (6) | 21–24 | 162 | Ghost Bug, Hyungno |
| Earth Ghost Canyon | West_China | 155–156 × 97–100 (6) | 27–30 (skipped) | 96 | Earth Ghost, Meek Gun Powder, Earth Taoist; rx 155 is outside the playable set, rx 156 is inside but has no spawnable nest |
| Entrance-Western China Donwhang | West_China | 155–156 × 101–103 (5) | 24 (27–30 skipped) | 113 | rx 155 and z 103 outside the playable set; the only spawned nest is one Hyungno Ghost (Lv 24, 9 mobs) at 156,102 |
| Western China Northern Road | West_China | 156 × 103 (1) | – | 0 | outside the playable set (missing from the first draft) |

**[confirmed]** Scratch script joining `textzonename`, `refregion` and `nests.json`. "Mobs" counts every nest in the area's regions, including levels above the cap.

NPCs outside the town regions are all inside the playable set **[confirmed]** (`npcs.json`):

- NPC_CH_FERRY at (161,97) and NPC_CH_FERRY2 at (158,96), the teleporters;
- NPC_CH_SHAMAN at (165,98);
- NPC_CH_SPECIAL2 at (160,92).

### 1.4 The two region sets

**Playable (server) set: X 156–174 × Z 90–102.** That is 19 × 13 = 247 regions, all active.

- It contains every nest with mob level ≤ 24 (their span is rx 156–174, rz 90–102) **[confirmed]**. Only level 27–30 nests fall outside (at rx 155), and the server skips those anyway; rx 156 also holds skipped 27–30 nests inside the set.
- In glTF metres it spans x ∈ [−2304, 1344] and z ∈ [−1152, 1344]: 3.6 × 2.5 km.
- `manifest.bounds = {minX: -2304, maxX: 1344, minZ: -1152, maxZ: 1344}`. The server's `resolveWorld` already prefers `manifest.bounds` over the union of the regions (`content.ts`: `bounds(manifest.bounds) ?? union(...)`), and `World.clamp` keeps every move target inside it **[confirmed]**. No server code change is needed for the clamp.

**Render/export set: X 155–175 × Z 89–103.** This is the playable set plus a one-region ring.

- 315 regions, minus the 8 inactive in `mapinfo.mfo` (163–169 and 175 at z 103), leaves **307**. The converter skips inactive regions on its own and reports them **[confirmed: fact-check re-ran `convert-region --regions 155-175,89-103`; the first draft said 7 / 308, missing 175,103]**.
- The ring is exported with terrain, objects and navmesh. Heights at the playable border stay exact, and the view does not end at a cliff of nothing.

Measurements in §2 were taken on **155–174 × 89–103 (293 active regions)**. Column 175 adds 14 active regions. Fact-check measurement of the full 307-region set **[confirmed]**: 18.9 s (19.7 s wall), still 6,744 placements, 445 models, 104 tiles, 321 nav models and 2,281 nav instances (column 175 adds terrain only); 342.1 MiB total (models 117.3 + sidecars 2.5, terrain 76.8, terrain lightmaps 13.7, tiles 40.1, navmesh 31.8, minimap 25.7, nav.bin 22.25 MiB = 23,328,260 B, object lightmaps 5.8, manifest 5.4 = 5,698,513 B), about +2 % over the 293-region run.

---

## 2. Budgets

### 2.1 One more region, with the existing CLI [confirmed]

```sh
pnpm sro convert-region --regions 166,96 --centre 168,97 --name f166_96 --out work/tmp/fields/w166_96
```

- 1.0 s: 42 ms of terrain, the rest for textures and objects.
- 9.00 MiB in total. Most of it is shared data that one region pulls in:
  - tiles 5.07 MiB (13 tile textures);
  - models 2.47 MiB (16 models);
  - water frames 0.60 MiB.
- The region itself is small:

| File | Size |
|---|---:|
| `terrain/166_96.bin` | 272 KiB |
| terrain lightmap PNG | 31 KiB |
| minimap PNG | 103 KiB |
| `navmesh/166_96.bin` | 92 KiB |
| nav.bin share | 85 KiB |
| object lightmaps | 103 KiB |

- 272 `.o2` records became 194 placements.

A 3×3 block (159–161 × 91–93, Tiger Mountain) took 2.1 s and 28.2 MiB. It holds 278 placements and 31 models.

### 2.2 The whole area, measured [confirmed]

**Conversion.**

```sh
pnpm sro convert-region --regions 155-174,89-103 --centre 168,97 --spawn GATE_CH --name fields --out <tmp>
```

- 293 regions (7 skipped as inactive) in **19.8 s**: terrain 5.7, objects 9.8, textures 3.5.
- Objects: 19,662 `.o2` records became **6,744 placements**, with 427 object ids and **445 unique models**. 40 models are skinned and 107 lightmapped (577 object lightmaps). 25 placements are compounds.
- 1,101 skinned placements (animated trees, flowers, lanterns).
- LOD groups: g2 has 4,291 placements, g3 has 2,453.
- 104 terrain tiles.
- Water: 2,383 of 10,548 blocks.
- Spawn: GATE_CH at (96.9, −3.2609, −136.9), the same as today.

**Slimming.**

```sh
pnpm tsx packages/convert/src/tools/optimize-out.ts run --in <tmp> --out <tmp-opt> --only world/ --precompress --no-census
```

- It took 394 s, with 0 validator errors.
- Worst deviations: 0.95 mm in position, 0.09° in normals, PSNR ≥ 35 in textures.

| Category | work/out | out-opt (disk) | Wire (out-opt; `.br` where written) |
|---|---:|---:|---:|
| models (glb + sidecars) | 119.9 MB | 47.9 MB | 40.3 MB |
| terrain (`.bin` + lightmaps) | 87.8 MB | 80.7 MB | 20.9 MB |
| tiles | 40.1 MB | 12.0 MB | 12.0 MB |
| navmesh (per-region NavmeshBin) | 30.5 MB | 30.5 MB | 8.6 MB |
| minimap | 24.8 MB | 7.8 MB | 7.8 MB |
| nav.bin | 21.3 MB | 21.3 MB | 7.6 MB |
| object lightmaps | 5.8 MB | 1.6 MB | 1.6 MB |
| manifest.json | 5.4 MB | 3.5 MB | 0.2 MB |
| water, environment | 0.7 MB | 0.3 MB | 0.2 MB |
| **Total** | **336.1 MB** | **205.6 MB** | **99.3 MB** |

Fact-check note: the `work/out` column matches the converter's report in **MiB** (e.g. models 117.34 + sidecars 2.54 = 119.9 MiB, re-measured), so read "MB" in this table as MiB. The out-opt and wire columns were not re-measured (the slimming pass takes about 400 s) and keep the author's figures **[likely]**.

For comparison, today's Jangan is 73.4 MB on disk, 33.2 MB after slimming and 26.0 MB on the wire (ASSETS.md).

**Per region (median, wire):** 136 KB for terrain `.bin` (brotli) + lightmap + minimap + navmesh. Without the NavmeshBin, which the streaming client does not need, it is 102 KB.

**Per streaming window (wire, including the tiles and models the window uses; object lightmaps excluded)** [confirmed, scratch script over out-opt]:

| Window | Median | Max | Centred on Jangan (168,97) |
|---|---:|---:|---:|
| 3 × 3 | 5.5 MB | 23.9 MB | 23.9 MB |
| 5 × 5 | 10.1 MB | 31.0 MB | 28.1 MB |
| 7 × 7 | 16.2 MB | 36.7 MB | 36.7 MB |
| whole area | – | – | 89.7 MB |

- Unique tiles: 22 median / 51 max per 3×3 window, and 30 median / 67 max per 5×5 window.
- Unique models per 5×5 window: 42 median / 258 max. The maximum is around the town.

### 2.3 Projections

**Disk and the first deploy.**

- For the 307-region export: `work/out` grows by 342.1 MiB (about 359 MB) **[confirmed, re-converted]**, and `work/out-opt` by about 215 MB plus `.br` siblings of about 75 MB **[likely]**.
- The first deploy ships about 650 MB over the tailnet **once**. Later deploys ship only changed files (DEPLOY.md: SHA-256 per file) **[confirmed mechanism]**.

**Download per session (wire, streaming).**

- Entering in town costs about 28 MB. That is about today's 26 MB, and the HTTP cache makes it about 0 on a revisit.
- Walking to Tiger Mountain adds about 10–20 MB of new regions and models.
- A player who crosses the whole area once downloads at most about 90 MB, all cached afterwards.
- Without streaming (load everything), it would be about 99 MB up front plus about 340 MB of decoded textures. Not acceptable.

**nav.bin** [confirmed]:

| | Jangan (today) | Area (293 regions) |
|---|---:|---:|
| Size | 820,720 B | 22,282,572 B |
| gzip / brotli | 250 KB / 218 KB | 9.0 MB / 7.9 MB |
| Regions / models / instances | 9 / 134 / 547 | 293 / 321 / 2,281 (6 links) |
| `decodeNavData` | 3 ms | 20 ms (fact-check, 307 regions: 17.5 ms) |
| `new NavWorld` | 11 ms | 16 ms (fact-check: 16.9 ms) |
| Reachability build (`reachStats`, the parallel lane) | first draft: 329 ms, 3.7 MB. Fact-check with the current uncommitted `reach.ts`: **139 ms, 3.8 MB**, 1,569 components | first draft: 1.82 s, 50.6 MB, 10,358 components. Fact-check, 307 regions: **0.62 s, 53.3 MB, 10,323 components** |

`reach.ts` is still being edited by the reachability lane, so these reach numbers move; re-measure with `NavWorld.reachStats()` before relying on them **[confirmed at fact-check time]**.

- The terrain part is 97²·4 + 96²·4 = 74,500 B of arrays per region (74,716 B per encoded region with its id, counts and 6×6 planes): **21.8 MB of the 22.3 MB**.
- Object models, instances and links, encoded alone as `nav-objects.bin` (`regions: []`), are **397,816 B** (141,994 B brotli) **[confirmed, encoded in the fact-check]**; the first draft's 0.45 MB was the subtraction 22.28 MB − 293 × 74,500 B, which still counted per-region headers and planes.

**Client memory for a 5 × 5 window** [likely; estimates from the formats]:

| Item | Estimate |
|---|---|
| Terrain, per region | ~1.9 MB of GPU memory: 97² vertices × (pos + uv) 188 KB, an index buffer of 221 KB, the lightmap 512² RGBA with mips 1.4 MB, the layer map about 74 KB. **About 45 MB for 25 regions**; up to about 85 MB while 45 regions are resident between the load and unload radii (§3.2). |
| Tile texture array | 1.4 MB per 512² layer with mips: 30–67 layers is **42–94 MB**. At 256² ("low") it is a quarter of that. |
| Objects | Town-centred, the same as today's Jangan load (212 models). In the fields, fewer (42 models median). |
| Nav | Objects 0.4 MB plus 74.7 KB per loaded region: **under 4 MB** even with 45 resident regions. |
| Minimap tiles | 256² ImageBitmaps, 256 KB each: under 13 MB for 7×7. |

Today's single-atlas minimap would be 5120 × 3840 × 4 B = **79 MB** of canvas for the full area. That is one reason §5 replaces it.

**Server** [confirmed, measured]:

- Setup: the real server (`startTestServer`) with the area's `manifest.json` + `nav.bin` as world `jangan`, the real `data/`, 10 Hz, and `VIEW_RANGE` 120.

| Measure | Value |
|---|---|
| Startup (nav load, NPCs, `Spawner.fill` of 6,944 mobs) | 111–233 ms |
| RSS | 149 → 266 MB (+117 MB) |
| Idle tick (0 players, mobs dormant) | mean 0.60–0.71 ms, max 1.6–2.8 ms |
| Tick with 10 players fighting (GM-teleported to 10 nests, attack every 2 s) | **mean 1.7–1.9 ms, p99 7.9–8.4 ms, max 10.8–11.5 ms** |
| … of which `updateInterest` (every 200 ms) | mean 0.95 ms, p99 2.1 ms |
| … of which `Gameplay.tick` | mean 0.98 ms, p99 5.1 ms, max 8.7 ms |
| Entities a player knows (`known`) | 18–76 |

- For comparison, the previous figure for today's world was 0.06 ms mean and about 1 ms worst, with 160 mobs and 10 players.
- On the N100 (×2.5) this becomes a mean of about 5 ms and a worst case of about 30 ms against the 100 ms tick budget **[likely]**. That is acceptable without changes. §4.4 lists cheap optimizations to make only if the performance log shows `worstTickMs` above 50 ms.
- Reachability (the parallel lane) adds about 0.6 s of startup (about 1.6 s on the N100 at ×2.5) and about 53 MB when built over the whole area, with the `reach.ts` of fact-check time (the first draft measured 1.8 s / 50 MB with an earlier version) **[confirmed on the dev PC, projected for the N100]**.

---

## 3. Region streaming in `@sro/world-render`

### 3.1 What exists today [confirmed]

- **`loadWorld()`** (`world.ts`) loads, in order: the manifest; the environment; every region's terrain and navmesh bins (`WorldRegions.load`); `nav.bin` (`loadNav`); all tiles into one `RawTexture2DArray` (`TerrainRenderer.loadTiles`, 512² per layer); one terrain mesh per region (`TerrainRenderer.build`); water, with one mesh per region; the minimap atlas (`Minimap.load`); and every model (`WorldObjects.load`).
- **Static placements** become thin instances, batched per model × LOD group × 192 m (g2) or 96 m (g3) chunk. Skinned placements become one clone each (`instantiateModelsToScene`).
- **Draw distance** is `GROUP_RANGE_M` = {2: 202, 3: 48} × the quality scale, with animation stopping beyond `ANIMATE_RANGE_M` 80 m.
- **Fog** is linear: `FOG_RANGE_M = 250`, end = G11 × 250 m.
- **Lookups.** `WorldRegions.locate` is a linear scan over all regions.
- **Lights.** `World.isolateLights` pins the sun to a fixed mesh list.
- **Game camera.** `maxZ` 2000, orbit radius ≤ 40 m (`screens/world.ts`).

### 3.2 Sets, radii and hysteresis

`d(region)` is the 2D distance from the **focus** to the region's rectangle, 0 inside it. The focus is the local player, or the camera target in the viewer.

| | low | medium (default) | high |
|---|---:|---:|---:|
| `loadRadiusM`: wanted while d ≤ | 320 | 400 | 480 |
| `unloadRadiusM`: released once d > | 460 | 560 | 660 |

**Why these numbers** [likely]:

- Nothing is visible beyond the fog end: 250 m on the view axis, with the clear colour equal to the fog colour.
- The native terrain band (TERRAIN.md 5.2) draws untextured beyond `trunc((fogEnd + 1280)/320)` blocks, which is about 352 m.
- g2 objects draw to 202 m (283 m at high).
- Adding the camera offset (≤ 40 m) and a region of margin gives 400 m.

**Resulting windows.**

- From a region's centre, d ≤ 400 m selects the 5×5 block minus its 4 corners: **21 regions** (a corner is 407 m away).
- Over every focus position in a region the wanted set is **20–26 regions** at medium (15–21 at low, 27–34 at high) **[confirmed, brute-force over a 4 m grid of focus positions in the fact-check; the first draft said "at most about 30"]**.
- Resident regions (wanted plus those not yet past the unload radius) can reach **35–45** at medium (d ≤ 560 m; 25–32 at low, 45–55 at high) right after a long walk. Memory budgets must use the resident count, not the wanted count.
- The 160 m hysteresis is less than one region, so walking back and forth across a border never reloads anything.
- Everything within the load radius of the focus (≥ 320 m) is in memory once ready, and `whenReady` waits for 200 m, well beyond the server's 120 m interest radius (+10 m hysteresis). Every entity the client knows therefore stands on loaded terrain **[confirmed arithmetic]**.

### 3.3 Priority

The key is `d × (1 − viewBias · max(0, cos θ))`, where:

- θ is the angle between the camera's forward direction (xz) and the direction from the focus to the region's centre;
- `viewBias` is 0.35.

Lowest first, so the region under the focus (d = 0) is always first. Among equals, regions in view come before regions behind the camera.

The wanted set and the queue are recomputed only when the focus moved more than 8 m or the camera turned more than 15° since the last recompute. It is a cheap loop over at most 307 regions.

### 3.4 What a region chunk holds, and its lifecycle

New file `packages/world-render/src/region-chunk.ts`, class `RegionChunk`, one per region.

**States:** `absent → queued → fetching → decoded → committing → ready`, or `failed`.

1. **fetch/decode** (async, off the frame budget):
   - `terrain/<x>_<z>.bin` → `decodeTerrainBin`;
   - `nav/<x>_<z>.bin` → `decodeNavData`, one `NavRegion` (§3.8);
   - the terrain lightmap and minimap bytes, and `createImageBitmap(minimap)`;
   - the list of placements for the region (§3.8) and the models it needs, whose containers are requested from the `ModelCache`;
   - the tile ids it needs, requested from the `TileAtlas`.
2. **commit** (main thread, budgeted jobs, §3.6), in this order:
   1. `navWorld.addRegion(region)` (microseconds);
   2. the terrain mesh + material + layer map + lightmap texture;
   3. the water mesh;
   4. per model, as its container becomes available: that region's thin-instance meshes (g2 as one chunk per region, g3 as 2×2 sub-chunks of 96 m, the same batching as today but region-owned);
   5. skinned clones, one job each;
   6. the minimap bitmap into the minimap tile cache.

   The chunk is `ready` after steps 1–3 and `objectsReady` after step 5.
3. **unload** (d > `unloadRadiusM`):
   - dispose the terrain mesh, material, layer map and lightmap texture, the water mesh, the region's instance meshes and clones;
   - `release()` every model and tile it held;
   - `navWorld.removeRegion(id)`;
   - drop the minimap bitmap.

   A fetch still in flight for a region that is no longer wanted completes and is discarded. `WorldIO.bytes(url, signal?)` gains an optional `AbortSignal`, so it can also be aborted.

**Placement bucketing.** Placements belong to the region that contains their **position**:

- `rx = ox + floor(x / 192)` and `rz = oz + floor(−z / 192)`;
- this is the same rule the nest `region` field follows (825 of 825 agree) **[confirmed]**;
- every `WorldPlacement` already carries a `region` field (its `.o2` file's region), and it equals this position rule for all 6,744 placements of the area **[confirmed in the fact-check]**, so the loader can simply group by `placement.region`.

A big object that overhangs into a neighbour region is drawn only while its own region is loaded. Its radius is far smaller than the load radius, so any pop-in happens beyond the fog **[likely]**.

### 3.5 Shared caches with reference counts

**`ModelCache`** (new, `model-cache.ts`):

- one `AssetContainer` per model glb, plus its sidecar and its converted materials (`ObjectMaterials.convert`);
- `acquire(modelIndex, chunk)` / `release(modelIndex, chunk)`;
- at 0 references a container goes into an LRU and is disposed after `modelGraceS` (30 s) or when the LRU exceeds `modelCacheMax` (80). This avoids thrashing at area borders;
- `ObjectMaterials` shares lightmap textures by path today. They get a reference count too (dispose on the last release). Sharing is confirmed: `materials.ts` keeps `private readonly lightmaps = new Map<string, Texture>()` keyed by URI and a `lightmapped` list, with no release path today **[confirmed]**.

**`TileAtlas`** (new, `tile-atlas.ts`) replaces the global tile array:

- a fixed-capacity `RawTexture2DArray` of `tileLayers` layers (64/80/96 by quality) at `tileSize` (256 at low, 512 otherwise), with a map from tile id to layer and a reference count per tile;
- a region's layer map is written with the layers valid at commit time;
- a layer is reused only when its tile's reference count is 0, so live layer maps never change meaning;
- when every layer is taken, the atlas is rebuilt with 16 more layers (a new array, then all loaded regions' layer maps are re-encoded, which is cheap: 96 × 96 × L bytes each) and the rebuild is logged. A 5×5 window needs at most 67 layers. Fact-check: the first draft gave `low` 64 layers, below that 67; `low` is raised to 72 here (at 256² a layer is about 0.35 MB with mips, so +3 MB). Resident regions past the load radius (§3.2) also hold layers, so growth can still happen after long walks.

  **[unknown]:** whether Babylon 9 can upload **one layer** of an existing `RawTexture2DArray`. `updateMipLevel` exists, and WebGL2 `texSubImage3D` could do it. If not, adding a tile rebuilds the array from cached RGBA, which costs about 1 MB per layer to upload. The lane must measure this, keep decoded tile RGBA in an LRU (at most 96 MB) and batch tile additions per frame. WebGPU mip generation stays on the CPU (`textures.ts` comment) **[confirmed]**.

**Lights.** Streaming adds and removes object meshes, so `isolateLights`'s mesh lists go stale. Switch to layer masks:

- world object meshes get `layerMask |= WORLD_OBJECT_LAYER`;
- `sun.includeOnlyWithLayerMask = WORLD_OBJECT_LAYER`;
- the character lights get `excludeWithLayerMask = WORLD_OBJECT_LAYER`.

`WORLD_OBJECT_LAYER` must be a bit **outside** Babylon's default mesh/camera mask `0x0FFFFFFF` (use `0x10000000`). Every other mesh (characters, terrain, UI) keeps the default mask and so never carries the bit; a bit inside `0x0FFFFFFF` would be set on every mesh by default and the sun would light the characters again. The object meshes keep their default low bits, so the camera still draws them. `includeOnlyWithLayerMask` and `excludeWithLayerMask` exist on Babylon's `Light` **[likely: the Babylon Light API; no `layerMask` use exists in the repo today, confirmed by grep]**. The effect is the same as today's lists, with nothing to maintain. The public `World.isolateLights(lights)` signature can stay, so `screens/world.ts` needs no change for this.

### 3.6 Frame budget

`RegionStreamer.update()` is called from `World.update()` every frame.

- It runs commit jobs from a priority queue until `performance.now() − start ≥ frameBudgetMs`: 3, 4 or 5 ms for low, medium and high.
- At least one job runs per frame. A single job is never split: one region's terrain, one model × region, or one skinned clone.
- Fetches run with at most `maxFetches` in flight: 4, 6 or 8.
- Image decode goes through `createImageBitmap` (browser, off-thread).

Tile RGBA decoding (`Assets.image`, an `OffscreenCanvas` read-back) stays on the main thread in v1. Each 512² tile is estimated at about 2 ms **[unknown: measure]**. If that hitches, move it to a Worker (open question §8).

`StreamStats` records `lastFrameMs` and `worstFrameMs` of the streaming work, so the stats overlay can show hitches.

### 3.7 Fog, far distance and LOD

- **No far-terrain LOD in v1.** Beyond the fog end everything is fog colour against a clear colour that is also fog colour, so a coarse horizon mesh would be invisible **[likely, TERRAIN.md 5.2 and 5.3]**.
- The native per-block terrain LOD (TERRAIN.md 1.3, steps 1/2/4/8 by squared block distance) is optional. 20–26 wanted regions (up to 45 resident, but only those inside the fog draw) × 18,432 triangles is about 0.4–0.5 M drawn triangles, which is fine.
- **Fog stays as it is** (`applyEnv`). The environment profile comes from the block under the focus. The focus region always loads first, so `profileAt` has its block before anything else draws.

### 3.8 Client navmesh across streamed regions

**Today [confirmed]:**

- `NavWorld` (`packages/nav/src/world.ts`) is built once from a whole `NavData`.
- Its terrain regions sit in a private `Map<id, NavRegion>`.
- Object instances are an array whose **index is the surface id** (`NavSurface.instance`), bucketed by position when the `NavWorld` is built.
- A point in a region that is not loaded behaves as closed terrain: `regionAt` → `undefined`, `terrainOpen` false, `terrainHeight` NaN.
- The game predicts its own moves with `NavTrack` (`heights.ts selfMove`: it walks the server's move and clips it where the local walker is blocked).

**Design:**

- **Objects once, terrain per region.** Models, instances and links are 397,816 B (142 KB brotli) for the 307-region area **[confirmed, encoded in the fact-check]**. The client loads them all at start from **`nav-objects.bin`**: SRNV with `regions: []` and exactly `nav.bin`'s models and instances in `nav.bin`'s order. Instance indices, and so `NavSurface`s, are identical to the server's. Instance positions in SRNV are absolute world file units (e.g. x ≈ 302,074), so the chunks do not depend on the export's origin **[confirmed]**. Caveat: object surfaces (bridges, plazas) of unloaded regions stay walkable in the client `NavWorld`; the `navCovers` guard below is what keeps prediction off them.
- **`NavWorld.addRegion(r: NavRegion)` / `removeRegion(id: number)`.** Two small public methods on `NavWorld`. Both set the region map entry (`private readonly regions = new Map<number, NavRegion>()`, mutable despite `readonly`) and clear `reachCache` (`private reachCache: NavReach | null`, which `NavReach` builds from that same map) **[confirmed in the current uncommitted `world.ts`]**. The instance buckets do not depend on regions, so nothing else changes. `NavWorld.data.regions` then goes stale; nothing in `packages/nav` or `world-render` reads it (`apps/server/src/nav.ts` reads only `data.instances`) **[confirmed by grep]**.

  This is a hook in a file the reachability lane is editing (`packages/nav/src/world.ts`). **Coordinate with it:** those two methods and nothing else.
- **Terrain chunks: `nav/<x>_<z>.bin`.** SRNV with one region and no models or instances: exactly 74,716 B each (every region of the area has planes), 75 B–36 KB brotli, about 31 KB median **[confirmed, encoded in the fact-check]**. It is bit-identical to that region in `nav.bin`, in file units, so client and server heights agree exactly.

  The existing `navmesh/<x>_<z>.bin` (NavmeshBin, heights in **metres**) stays for the viewer's debug overlays. Rebuilding NavRegions from it would round-trip through float32 metres, so it is not used for nav.
- **Prediction guard.** `RegionStreamer.navCovers(x0, z0, x1, z1)` is true when every region the segment's bounding box touches is `ready`.

  In `EntityHeights.selfMove` (game, `apps/game/src/world/jangan/heights.ts`; today it calls `track.begin(...)` and clips when `r.blocked`) **[confirmed]**:
  - if the move is not covered, return the server's move **unchanged**;
  - mark the track as unsettled (a new flag; `heightOf` today always uses the track for self), so its heights come from `ground.heightAt(x, z, serverY)`;
  - on the next `stop` or `warp`, call `placeSelf(pos)`.

  `EntityHeights` receives the `World` in its constructor, so it can reach `world.stream?.navCovers` without a new parameter.

  A click can only land on loaded surfaces (`pickNav` over loaded nav, with the terrain meshes as fallback), and the load radius is at least 2.6× the interest radius (320 m at low, 400 m at medium, against 120 m + 10 m hysteresis), so this is rare **[likely]**.
- **Reachability on the client** is not needed. The server applies the component rule; the client only predicts. If a client feature later needs components, it must use the full `nav.bin`.

### 3.9 Export format changes (additive, compatible)

`manifest.json` keeps every version-1 field. `regions`, `tiles`, `models` and `placements` are complete for the whole export, so:

- **the viewer and every non-streaming `loadWorld` call keep working** unchanged (slowly, for 307 regions);
- a streaming loader derives per-region placement lists in one pass over `placements`. That is 6,744 records, and a 3.5 MB manifest is 0.2 MB brotli.

A separate world index file is **not** needed at this size. Revisit it past about 1,000 regions.

New in `packages/convert/src/world/manifest.ts`:

```ts
export interface WorldManifest {
  // ... all existing fields ...
  /** Playable rectangle (glTF metres): the server clamps every move to it (apps/server content.ts reads `bounds`). */
  bounds?: { minX: number; minZ: number; maxX: number; maxZ: number }
  /** Region streaming data (absent: load the whole world as before). */
  stream?: WorldStream
  /** Named points for GM `tp <name>` (apps/server content.ts manifestPlaces reads `places`). glTF metres. */
  places?: Array<{ name: string; x: number; y: number; z: number; source: string }>
}

export interface WorldStream {
  /** Region rectangle the server simulates (manifest `bounds` in region units). */
  playable: { x0: number; x1: number; z0: number; z1: number }
  /** Per-region SRNV chunks: `${dir}/${x}_${z}.bin`, each exactly one NavRegion of nav.bin (no models/instances). */
  navRegions: { dir: string; bytes: number }
  /** SRNV with regions: [] and every model/instance/link of nav.bin, in nav.bin's instance order. */
  navObjects: { file: string; bytes: number }
  /**
   * Overview image for the world map: the client minimap tiles stitched north-up at `pxPerRegion` px per region.
   * Pixel (0, 0) is the north-west corner of region (x0, z1); inactive regions are filled with #202225.
   */
  worldMap: { file: string; pxPerRegion: number; x0: number; x1: number; z0: number; z1: number; width: number; height: number } | null
  /** Suggested streaming radii (metres, distance from the focus to a region rectangle) for the medium preset. */
  loadRadiusM: number
  unloadRadiusM: number
}
```

`validateWorldManifest` checks the new fields when they are present:

- `bounds` lies inside the union of the regions;
- `stream.playable` lies inside the region set;
- `navRegions.dir` and `navObjects.file` are relative, without `..`.

### 3.10 API (`@sro/world-render`)

```ts
// world.ts: LoadWorldOptions additions
export interface LoadWorldOptions {
  // ... existing ...
  /** 'auto' (default): stream when manifest.stream exists; true: require it; false: load everything (old path). */
  stream?: boolean | 'auto'
  /** Initial focus (glTF metres) for streaming; default manifest.spawn. The game passes the character's saved pos. */
  focus?: { x: number; z: number }
  streamSettings?: Partial<StreamSettings>
}

// stream.ts (new)
export interface StreamSettings {
  loadRadiusM: number
  unloadRadiusM: number
  frameBudgetMs: number
  maxFetches: number
  viewBias: number
  tileLayers: number
  tileSize: 256 | 512
  modelGraceS: number
  modelCacheMax: number
}

export const STREAM_DEFAULTS: Record<WorldQuality, StreamSettings> = {
  low: { loadRadiusM: 320, unloadRadiusM: 460, frameBudgetMs: 3, maxFetches: 4, viewBias: 0.35, tileLayers: 72, tileSize: 256, modelGraceS: 20, modelCacheMax: 40 },
  medium: { loadRadiusM: 400, unloadRadiusM: 560, frameBudgetMs: 4, maxFetches: 6, viewBias: 0.35, tileLayers: 80, tileSize: 512, modelGraceS: 30, modelCacheMax: 80 },
  high: { loadRadiusM: 480, unloadRadiusM: 660, frameBudgetMs: 5, maxFetches: 8, viewBias: 0.35, tileLayers: 96, tileSize: 512, modelGraceS: 60, modelCacheMax: 160 },
}

export type RegionState = 'absent' | 'queued' | 'fetching' | 'decoded' | 'committing' | 'ready' | 'failed'

export interface StreamStats {
  wanted: number
  ready: number
  fetching: number
  committing: number
  /** Bytes downloaded by the streamer so far. */
  bytes: number
  modelsLoaded: number
  modelsCached: number
  tileLayersUsed: number
  lastFrameMs: number
  worstFrameMs: number
}

export class RegionStreamer {
  readonly stats: StreamStats
  onRegion: ((rx: number, rz: number, event: 'ready' | 'objects' | 'unloaded' | 'failed') => void) | null
  constructor(world: World, settings: StreamSettings)
  /** Per frame (World.update): refresh the wanted set if the focus/camera moved enough, fetch, commit within budget. */
  update(focus: { x: number; z: number }, forward: { x: number; z: number } | null): void
  /** Re-centre at once (teleport, respawn, worldEnter) and drop the queue order. */
  setFocus(x: number, z: number): void
  /** Resolves when every region within radiusM (default 200) of (x, z) is ready (objects included). */
  whenReady(x: number, z: number, radiusM?: number): Promise<void>
  state(rx: number, rz: number): RegionState
  /** True when every region under the segment's bounding box is ready (nav prediction guard). */
  navCovers(x0: number, z0: number, x1: number, z1: number): boolean
  dispose(): void
}
// World gains: readonly stream: RegionStreamer | null
```

**Streaming `loadWorld` sequence.**

1. Load the manifest, `environment.json` and `nav-objects.bin`, which gives a `NavWorld` with no regions.
2. Create the `TileAtlas` and the `ModelCache`.
3. `stream.setFocus(focus)`.
4. Report progress as ready/wanted over the stages `regions` → `objects`.
5. Resolve after `whenReady(focus, 200)`, or earlier when `waitForObjects` is false.

`World.spawn` is located as soon as the spawn's region is ready. Today it is a `readonly` field computed in the `World` constructor with `spawnAt(nav, …)`, and `profileAt` is also taken there **[confirmed]**; in the streaming path both must be (re)computed after the focus region commits, because the constructor only has `nav-objects.bin`. The game's `ground.ts` also builds `isGround` from a one-time `new Set(world.terrain.meshes)` **[confirmed]**, which goes stale when terrain streams (see lane 4). `World.pick` builds its fallback set per call, so it stays correct.

**Other changes in the same package:**

| File | Change |
|---|---|
| `terrain.ts` | Split `build()` into `buildRegion(data, atlas): TerrainRegionGpu` and `disposeRegion`. `build()` stays a loop over the regions (old path). |
| `objects.ts` | `addRegion(regionId, placements, cache)` and `removeRegion(regionId)`. The chunk keys become `region\|group\|sub`. |
| `water.ts` | `addRegion` / `removeRegion`. There is already one mesh per region. |
| `regions.ts` | `add` / `remove`, plus an O(1) `locate` (index by `rx, rz` computed from x/z and the origin) instead of the linear scan. |
| `minimap.ts` | Tile mode (§5). |
| `nav.ts` | `loadNavStreamed(manifest, assets)`. |
| `index.ts` | Exports the new types. |

---

## 4. Server side

### 4.1 Choosing the export [proposal]

- **`ServerConfig.worldExport: string`**: env `WORLD_EXPORT`, same name rule as `WORLD`, default `config.world`.
- **Loading:**
  - `MeshNav.load(dirs, worldExport)` and `resolveWorld(outDir, worldExport, …)` read the export folder;
  - the display name still comes from `config.world` (`Jangan`), not the folder name;
  - **fact-check:** `resolveWorld(outDir, world, override)` uses its `world` argument for three things, not one: the manifest folder, the default display name (`'Jangan-fields'` if passed the folder) and the **`world.toLowerCase()` GM place** it puts first in `places` (`content.ts` `setup()`, lines 212–214) **[confirmed]**. Because the export has a manifest `spawn`, `withTownSpawn` returns early and does not rename that place, so passing only the folder would turn `tp jangan` into `tp jangan-fields`. The hook is therefore `resolveWorld(outDir, folder, override, id = folder)`, with `id` used for the display name and the first place name. (`resolveWorld` already honours a manifest `displayName` string, so lane 1 may also write `displayName: 'Jangan'`.)
- **Telling the client:**
  - `ctx.serverInfo()` adds `world: worldExport`;
  - `worldEnter.world.name` (`connection.ts:406`) becomes `worldExport`. The shape is unchanged: `WorldInfo.name` is already documented as the manifest folder.
  - `welcome.server` carries `serverInfo()` too, so `packages/shared/src/validate.ts` `serverInfo()` must pass `world` through (§6.1).
  - Everything keyed by the world **id** keeps `config.world`: `Spawner` world filter, `data.town(config.world)`, `inSafeArea(config.world, …)`, `row.world === config.world` in `entryPoint`, `serverInfo().id` **[confirmed]**.
- **Where it is set:** in `silkroad.local.env` on the mini PC (`WORLD_EXPORT=jangan-fields`), and in `pnpm dev`'s environment.

  Tests keep the default and so keep today's 3×3 export. `nav-real.test.ts` still expects "9 regions, 547 objects" **[confirmed]**.
- **Saved characters** keep `world = 'jangan'`. On enter, a saved position that the navmesh cannot restore falls back to `nav.place(x, z, y, 10)` and then to the town (`connection.ts:370–372`) **[confirmed]**. Switching `WORLD_EXPORT` back is therefore safe.

### 4.2 Navmesh and nests at startup [confirmed, measured §2.3]

- **Navmesh.** Load the whole area's `nav.bin` once: 22 MB, 20 ms to decode, 16 ms to build `NavWorld`, about +117 MB of RSS together with the spawned mobs. The server never streams.
- **NPCs.** All 46 NPCs spawn, including the two ferry sellers, the shaman and the specialty trader outside town.
- **Nests.**
  - Unchanged code: `Spawner` over `nests.json`, filtered by world, mob level and `inWorld` (`nav.place` within `NEST_SEARCH_M`).
  - All 791 nests up to level 25 passed the current `inWorld` check. With the parallel reachability rule (placements in the town spawn's component), some nests on terrain the town cannot reach may drop out. That count is **[unknown]** until the reach lane lands, and the startup log line `N nests (M skipped)` shows it.
- **Density [proposal, optional]:** `NEST_COUNT_SCALE` (0.1–1, default 1), applied as `count = max(1, round(count × scale))` in `Spawner`. It is not needed for performance. It exists in case 6,944 monsters feel too crowded for a handful of friends (DATA.md already suggests it).

### 4.3 Interest management: it exists [confirmed]

`apps/server/src/world.ts`:

- A player receives an entity while it is within `viewRange` (config `VIEW_RANGE`, default **120 m**), and a `despawn` beyond viewRange + `VIEW_HYSTERESIS_M` (**10 m**).
- `updateInterest` runs at most every `INTEREST_MS` (**200 ms**). It uses a uniform grid with cells of `max(16, viewRange)` = 120 m and scans the 3 × 3 neighbouring cells. Teleports, spawns and removals refresh at once (`refreshAround`).
- Mob AI is dormant for idle mobs with no living player within viewRange + `DORMANT_MARGIN_M` (**30 m**); they only regenerate (`gameplay.ts` tick).

Keep 120 m. It stays inside the client's 400 m load radius, and a player saw 18–76 entities in the test.

### 4.4 Performance headroom (only if needed)

Each item below is independent and small. Do it only when `worstTickMs` goes above 50 ms on the N100.

1. **`updateInterest`:** use numeric grid keys (`cx * 65536 + cz`) instead of template strings, and reuse the grid arrays between runs.
2. **`Gameplay.tick`:** today every idle mob tests the distance to every living player (6,944 × players) and copies `[...mobs.values()]`. Instead, iterate only mobs in grid cells within viewRange + 30 m of a living player; dormant cells only need a slower regeneration sweep (1 Hz).
3. **`Spawner.tick`:** keep one heap of due times instead of filtering every nest's `pending` every tick (791 nests).

### 4.5 Safe zone, respawn and return points [confirmed]

- **Safe zone.** `towns.json` Jangan `safeArea`: centre (82.727, −198.833), half extents 256.007 × 178.653 m, which is x −173.3…338.7 and z −377.5…−20.2 (regions 167.1–169.8 × 97.1–99.0). Inside it, attacks are refused (`safe_zone`) and mobs ignore players (`gameplay.ts attackable`). The town spawn (96.9, −136.9) lies inside. Unchanged.
- **Respawn and return scrolls** warp to the town spawn (GATE_CH). In `teleportdata.txt`, GATE_CH is the **only** row inside the area with `CanBeResurrectPos = 1`. The other rows are:
  - the ferries GATE_NPC_CH_FERRY (region 24993 = 161,97), _FERRY2 (24734 = 158,96), GATE_NPC_WC_FERRY (25761 = 161,100) and _WC_FERRY2 (25244 = 156,98);
  - the town gate soldiers;
  - fortress gates GATE_CH_FORT_GATE1–3 (23719–23721 = 167–169,92) and bandit-fort gates GATE_BD_FORT_GATE1/2 (23714 = 162,92; 23459 = 163,91);
  - GATE_JINSI_OUT (26284 = 172,102, the Qin-Shi tomb exit).
- **Walk back.** Death on Tiger Mountain means about 1.7 km back, about 5 minutes. For v1 that is accepted, in keeping with the original game.
- **[proposal for the GM editors lane]:** authored "field camps", `content/returns.json` with `{code, name, x, z}`. The respawn rule would become "nearest camp in the same nav component as the corpse, else the town". The protocol is unchanged: it is still `warp`.

### 4.6 GM helpers

- **Places for `tp`.** The converter writes `manifest.places`: one point per named zone, `grassland`, `north-tiger-mt`, `bandits-mountain-stronghold`, … Rule: lower case, delete `'` and `.`, then every run of other non-`[a-z0-9]` characters becomes `-`, trimmed (the first draft's "punctuation as `-`" would give `bandit-s-…`). Names must pass the server's `placeName` (`/^[a-z0-9_-]{1,32}$/`, else the place is silently dropped) **[confirmed, `content.ts`]**; the longest here is `entrance-western-china-donwhang` (31). Client spellings stay: `enterance-of-qin-shi-tomb`; "Chinese Tomb" and "Chinese tomb" merge into `chinese-tomb`. The zone `jangan` collides with the world place `jangan`, which is kept (first wins).
  - The point is the mean centre of the zone's regions, snapped with `place` to open ground in the town spawn's component, within 60 m.
  - The server's `manifestPlaces` already reads `places`, so `tp north-tiger-mt` works with no server change **[confirmed: content.ts reads `places` / `teleports` / `landmarks` / `locations`]**.
- **Location names.** `CharacterSummary.location` (today `this.game.setup.displayName`, `connection.ts:335`) and GM `where` (exists: `where [player]` in `gm.ts`) could show the zone name from `data/zones.json` (§6.2). Small hook in `gamedata.ts` (load it leniently like `towns.json`) **[confirmed hook points]**.

---

## 5. Minimap and world map (M)

### 5.1 Today [confirmed]

- **Tiles.** `convert-region` writes the client minimap tile of each region to `minimap/<x>x<z>.png` (256², north-up, from `Media/minimap/<x>x<z>.ddj`; 4,482 in the client). `manifest.regions[].minimap` names it; out-opt makes it `.webp`.
- **Drawing.** `Minimap` (`packages/world-render/src/minimap.ts`) draws every region's tile into **one `OffscreenCanvas` atlas** at load, at 0.75 m per pixel. `render()` then crops around the player and draws markers and the view line.
- **HUD.** `HudMinimap` (`apps/game/src/world/jangan/minimap.ts`) is 168 px round, zoom levels 0.6–2.4, redraws at 15 Hz.

### 5.2 Minimap in tile mode

When the world streams:

- `Minimap` keeps a `Map<regionId, ImageBitmap>`, filled and emptied by `RegionChunk` commit and unload.
- `render()` draws the up-to-3×3 tiles that intersect the view rectangle, each with `drawImage(bitmap, …)` at its region position, instead of one atlas crop. `toPx` stays.
- Missing tiles draw as `#202225`.
- The widest view is 168 / 0.6 × 0.75 m = **210 m** across. `HudMinimap` passes `scale = ZOOMS[zoom] × dpr` on a `168 × dpr` canvas, so dpr cancels **[confirmed, `apps/game/src/world/jangan/minimap.ts`]**; the first draft multiplied by dpr and got 420 m and "4×4 tiles". It stays well inside the loaded set.
- The viewer (non-streamed) keeps the atlas mode. `Minimap.load()` is unchanged. `Minimap.attach(canvas)` must keep working in tile mode, because docs/UX_GAPS.md M3 plans to drive the world map through it.

### 5.3 World map window (M)

**Image.** `convert-region` writes `worldmap.png` (out-opt: `.webp`):

- the export's minimap tiles, each down-sampled with a 4×4 box filter to **64 px per region**, north-up;
- 21 × 15 regions gives 1344 × 960 px, about 300 KB as WebP **[likely]**;
- the geometry is described in `manifest.stream.worldMap`.

The client also ships a painted world map: `Media/interface/worldmap/map/map_world_<x>x<z>.ddj`, 128² DXT1, and `city_jangan.ddj`, 64² A8R8G8B8 **[confirmed]**. Its tiling rule is **[unknown]**:

- the x names step alternately by 1 and 3 (…153, 154, 157, 158, 161, 162, 165, 166…) and the z names by 4;
- a naive montage did not line up.

v1 uses the minimap stitch. The painted map can come later with the art pass. `city_jangan.ddj` is exported as the town icon (HUD art selection in `export-icons.ts`).

**Content.**

- The image, panned and zoomed. The mouse wheel zooms 0.5× to 4× of 64 px per region; left-drag pans.
- **Zone labels:** `data/zones.json` grouped by `name`, each label at the mean centre of its regions.
- The town icon at Jangan.
- The player arrow (updated at 10 Hz while open).
- Markers for NPCs with roles, from `npcs.json` (shop, teleport, storage).
- **Hunting labels.**
  - Built client-side from `nests.json` + `mobs.json` the first time the map opens.
  - Nests of the same mob within 200 m are clustered, giving one label "Tiger Lv 14" per cluster.
  - The label colour compares the mob's level with the player's: grey ≤ −5, green −4…−1, yellow 0…+2, red ≥ +3. docs/UX_GAPS.md F2 plans five level-difference bands for mob name colours (UX-B lane); use the same band function for both so the map and the nameplates agree.
  - Tiger Girl gets one label at the mean of her 11 camps, "Tiger Girl (unique)".
- Hover shows the zone name and the region coordinates. Right-click centres on the player.

**No click-to-travel.** Moves are straight chords with no pathfinder, so the map does not auto-walk. A later version may place a client-only waypoint that the minimap shows as an arrow on its rim.

**Keys and text.**

- **M** toggles the window; **Esc** closes it (the HUD window stack; `hud/index.ts` closes the top window on Escape) **[confirmed]**.
- **Overlap with docs/UX_GAPS.md:** its lane UX-B already plans the same M window (M3, owned file `apps/game/src/hud/worldmap.ts`) and an area name on the minimap (M1, `world/jangan/minimap.ts`). Only one lane may own the M window and the `k === 'm'` branch; see the lane 4 note in §7.
- All labels are i18n keys in `apps/game/src/i18n/en.ts`: `map.title`, `map.you`, `map.town`, `map.unique`, `map.levelShort`, `map.zoneUnknown`.
- `world.help` gains "M: map".

---

## 6. Protocol and content additions

### 6.1 Protocol (v1, additive)

```ts
// packages/shared/src/protocol.ts
export interface ServerInfo {
  id: string
  name: string
  status: 'online' | 'maintenance' | 'offline'
  online: number
  capacity: number
  /**
   * FIELDS.md (additive): the world export folder under /out(-opt)/world/ this server simulates, e.g. 'jangan-fields'.
   * Absent (older servers): 'jangan'. The client starts streaming it before worldEnter arrives.
   */
  world?: string
}

// WorldInfo (worldEnter.world): shape unchanged; `name` is now always the export folder (ServerConfig.worldExport).
```

- `ServerInfo` travels over HTTP (`GET /api/servers`, cast without a validator in `apps/game/src/net/api.ts`) **and over the WebSocket** in `welcome.server` (`connection.ts:279`: `server: this.game.serverInfo()`) **[confirmed]**. The client parses every server message with `parseServerMessage` (`net/wire.ts`), and `packages/shared/src/validate.ts` `serverInfo()` rebuilds the object from known fields only, so it would **drop `world`** (PROTOCOL.md: "drops unknown keys") **[confirmed]**. The first draft missed this. Required hook: in `serverInfo()` add `...(o.world !== undefined ? { world: str(o, 'world', 64, 1) } : {})` plus the `/^[a-z0-9_-]{1,64}$/i` check (the same rule as the server's `WORLD`), and a one-line note in docs/PROTOCOL.md.
- With that, the game reads the folder from `app.session.server?.world` (`Session.server` is set from `welcome`, `net/session.ts`) **[confirmed]**; it does not need the server-select screen to pass anything. `net/mock.ts` `MOCK_SERVER` may omit `world` (fallback `'jangan'`).
- No new WebSocket messages; `welcome` gains the optional field through `ServerInfo`.
- No collision with SKILLS.md §10.2 names.
- Rate limits unchanged.

### 6.2 Content (additive): `data/zones.json`

```ts
// packages/shared/src/content.ts
// Fact-check: follow the towns.json precedent (TOWNS_FILE: "a ContentFile-shaped wrapper with kind 'towns', not part
// of CONTENT_FILES", loaded leniently by apps/server/src/gamedata.ts) instead of widening CONTENT_FILES/ContentKind,
// which every content lane (skills, shops, quests) also touches. Adding `zones` to CONTENT_FILES also works
// (content-check.ts CHECKS is a Partial record), but then the rule lives in content-check.ts, not content.ts.
export const ZONES_FILE = 'zones.json'

/** One region of the world export with its client names (textzonename.txt, refregion.txt). */
export interface ZoneDef {
  /** Region id z << 8 | x. */
  region: number
  rx: number
  rz: number
  /** English area name: textzonename.txt tab field 8 (0-based; header 'English') for this region id; '' when the client has none. */
  name: string
  /**
   * refregion.txt field 4 (0-based, AreaName) only when it is a readable code (/^[A-Za-z0-9_]+$/, e.g. 'Town_Jangan');
   * null otherwise. In this client the other AreaName values are literal '?' runs (lost Korean), so only the 6 Jangan
   * town regions have one.
   */
  area: string | null
  /** refregion.txt field 3 (0-based, ContinentName: 'CHINA' | 'West_China' ...); null when the region has no refregion row. */
  continent: string | null
  /** towns.json code when the region belongs to a town (TownDef.regions). */
  town?: string
}
```

- Written by `export-data.ts` for every region of a world manifest. **Fact-check:** it must **not** be run with `--world jangan-fields`: `export-data` stamps the manifest's `name` into every content record (`nests.world`, `npcs.world`, `towns.world`; `packages/convert/src/data/nests.ts`, `npcs.ts`, `content.ts` use `world.name` from `worldFrameFromManifest`) **[confirmed]**, and the server keeps only records whose `world === config.world` (`'jangan'`). Keep `--world jangan` (the frame is identical) and add a separate `--zones-world <folder>` (default: `--world`) that only supplies the region list for `zones.json`.
- Check rules (in `content.ts` next to the reader, or `content-check.ts` if it joins CONTENT_FILES): `region === (rz << 8 | rx)`, `name` a string of at most 64 characters, `area` null or `/^[A-Za-z0-9_]{1,64}$/`.
- Provenance: client.

---

## 7. Build plan

There are four lanes. Lanes 2, 3 and 4 can start at once: lane 2 develops against the existing 3×3 export (with a synthetic `stream` block) until lane 1 delivers. Lane 4's world map needs lane 1's `worldmap.png` and `zones.json`, but can use a stub image until then.

### Lane 1: convert and export of the area

**Owned files:**

- `packages/convert/src/world/convert-world.ts`, `manifest.ts`, `nav.ts` (this lane is their only editor tonight);
- new `packages/convert/src/world/worldmap.ts`;
- new `packages/convert/src/world/places.ts`;
- new `packages/convert/src/data/zones.ts`;
- `packages/convert/src/tools/export-data.ts` (a hook: call `buildZones`, plus a new `--zones-world <folder>` flag; see §6.2: `--world` must stay `jangan`, or every nest/NPC/town record is stamped `world: 'jangan-fields'` and the server spawns nothing);
- `packages/convert/src/cli.ts` (the usage line only).

**Work:**

1. **Preset.** `WORLD_PRESETS['jangan-fields'] = { x0: 155, x1: 175, z0: 89, z1: 103, centre: { x: 168, z: 97 }, spawnTeleport: 'GATE_CH', playable: { x0: 156, x1: 174, z0: 90, z1: 102 } }`. `WorldPreset` gains `playable?`. The CLI name is the preset key, so the output goes to `work/out/world/jangan-fields/`.
2. **Nav files.** After `buildWorldNav`, write:
   - `nav/<x>_<z>.bin` = `encodeNavData({version, regions: [r], models: [], instances: []})`;
   - `nav-objects.bin` = `encodeNavData({version, regions: [], models, instances})`.

   Keep `nav.bin` and `navmesh/*.bin`.
3. **World map.** `worldmap.png`, the 64 px per region stitch of the region minimap tiles. Fact-check: `ddjToPng` (`world/objects.ts`) decodes the DDJ but returns only `{width, height, bytes}`, not the RGBA **[confirmed]**, so `worldmap.ts` re-decodes `Media minimap/<x>x<z>.ddj` with `decodeDds(parseDdj(...))` (about 1 ms each) rather than editing `objects.ts`, which this lane does not own.
4. **Manifest.** `manifest.bounds` (glTF metres of `playable`), `manifest.stream` (§3.9), optionally `displayName: 'Jangan'` (already read by the server's `resolveWorld`), and `manifest.places` (§4.6, snapped with `NavGltf` + the reach component of the spawn once that API lands; until then `locate` on open terrain).
5. **Zones.** `data/zones.json` (§6.2) from `textzonename.txt` + `refregion.txt` (both UTF-16LE with BOM; `loadTextdataTable` in `@sro/formats`, already used by `data/client-source.ts`) **[confirmed]**. Run as `export-data --world jangan --zones-world jangan-fields`.
6. **Run** `optimize-out run --only world/jangan-fields/ --precompress`.

   **[confirmed]** out-opt already turns `world/**.png` into WebP and brotlis `.bin` and `.json`. Nothing new is needed.

**Tests:**

- `packages/convert/test/world-stream.test.ts` (corpus; skips without `sro.config.json`). It converts 2×2 regions (167–168 × 96–97) into a temp dir and checks:
  - every `nav/<x>_<z>.bin` decodes to a region bit-equal to `nav.bin`'s;
  - `nav-objects.bin` models and instances deep-equal `nav.bin`'s, in order;
  - `bounds` ⊂ regions;
  - `worldMap` is 128 × 128 px;
  - `validateWorldManifest` gives 0 problems;
  - every `places` point satisfies `locate` ≠ null.
- `packages/convert/test/data-builders.test.ts`: `buildZones` on synthetic rows.
- `data.corpus.test.ts`: `zones.json` names 25000 → "Jangan" and 24478 (0x5F9E = 158,95) → "North-Tiger Mt." **[confirmed values]**.

**How to check:**

- `pnpm sro convert-region --preset jangan-fields` prints 307 regions (8 skipped as inactive), 6,744 placements, 445 models and `nav.bin 22.25 MiB, 307 region(s), 2281 object navmesh instances` in about 20 s (fact-check run: 18.9 s; the first draft said 308 / 6.9k / 460 / 25 s).
- Open `/out/world/jangan-fields/worldmap.png` in the browser: you see the region mosaic with the Jangan walls in the middle-right.

### Lane 2: `@sro/world-render` streaming (plus the nav hook)

**Owned files (new):**

- `packages/world-render/src/stream.ts` (`RegionStreamer`, `STREAM_DEFAULTS`);
- `region-chunk.ts`;
- `model-cache.ts`;
- `tile-atlas.ts`.

**Edits** (this lane is their only editor):

- `packages/world-render/src/world.ts`: the streaming path in `loadWorld`, `World.stream`, `update()` calling `stream.update(focus, forward)`, layer-mask lights (§3.5);
- `terrain.ts` (`buildRegion` / `disposeRegion`);
- `objects.ts` (`addRegion` / `removeRegion`, region-owned chunks);
- `water.ts`;
- `regions.ts` (O(1) `locate`, `add` / `remove`);
- `minimap.ts` (tile mode);
- `nav.ts` (`loadNavStreamed`);
- `assets.ts` (optional `AbortSignal` in `WorldIO.bytes`);
- `materials.ts` (reference-counted object lightmaps, §3.5; `ObjectMaterials` keeps them in a `Map<string, Texture>` today) and `textures.ts` (`createTextureArray`, per-layer upload for the `TileAtlas`): both were missing from the first draft's list although §3.5 changes them;
- `index.ts`.

**Hooks in other lanes' files:**

- `packages/nav/src/world.ts`: add only `addRegion(r: NavRegion): void` and `removeRegion(id: number): boolean`. Each updates `this.regions` and sets `this.reachCache = null`. Coordinate with the reachability lane, which owns the file.
- `apps/viewer/src/world/main.ts`: a `?stream=0|1` param, and stream stats in the overlay.

**Tests** (`packages/world-render/test/stream.test.ts`, NullEngine plus a synthetic manifest of 7 × 7 flat regions with fake assets):

- the wanted set from a region centre is 21 regions;
- oscillating the focus ±100 m across a border causes 0 unloads;
- a view-biased order;
- a model container is disposed only after its last region unloads **and** the grace time has passed (fake clock);
- `TileAtlas` layers are reused only at reference count 0, and the growth path works;
- a fake `performance.now` shows that commits stop at the budget, with at least one job per frame;
- `navCovers` is false across an absent region;
- `jangan-nav.test.ts`, `load.test.ts` and `pick.test.ts` still pass (non-streamed path).

`packages/nav/test/stream.test.ts` (real 3×3 export; it encodes the chunks itself from `work/out/world/jangan/nav.bin` with `encodeNavData`, because that export has no `nav/` folder) builds `NavWorld` from the objects-only data plus each one-region chunk added one by one. Inside loaded regions, `locate` and `moveStraight` agree with the full `nav.bin` on 1,000 random chords. A chord into a removed region is blocked at its border.

**How to check:**

- `apps/viewer`: open `?world=jangan-fields`. The stats show 20–26 regions wanted and ready (medium); after flying around, up to about 45 resident until they pass the 560 m unload radius.
- Fly the camera west: new regions pop in beyond the fog, never in front of you, and the frame-time graph shows no spikes above about 8 ms.
- Fly back: nothing reloads, and the model count settles.

### Lane 3: the server area

**Owned files:**

- `apps/server/src/config.ts` (`worldExport`, `WORLD_EXPORT`; optional `NEST_COUNT_SCALE`);
- new `apps/server/test/fields.test.ts`.

**Hooks:**

- `apps/server/src/game.ts`: line 144 `resolveWorld(config.outDir, config.worldExport, config.spawn, config.world)` (keep `withTownSpawn(…, config.world, data.town(config.world))`); line 133 in `loadNav`: `MeshNav.load(dirs, config.worldExport)`; `serverInfo()` (line 169) adds `world: config.worldExport` **[confirmed line numbers at fact-check time]**.
- `apps/server/src/content.ts`: `resolveWorld(outDir, folder, override, id = folder)`; `id` replaces `world` for the default display name **and** the first GM place name (`setup()`), so `tp jangan` keeps working (§4.1).
- `apps/server/src/connection.ts:406`: `name: this.game.config.worldExport`.
- `apps/server/src/gamedata.ts`: an optional `zones.json` load plus `zoneAt(x, z)`, used for `CharacterSummary.location` and GM `where`.
- `apps/server/src/spawner.ts`: `NEST_COUNT_SCALE` (1 line in `want`). Optional.
- `apps/server/README.md` and `docs/DEPLOY.md`: document `WORLD_EXPORT`.
- `packages/shared/src/protocol.ts`: `ServerInfo.world?`.
- `packages/shared/src/validate.ts`: `serverInfo()` passes the optional `world` through (required: `welcome.server` is strictly parsed and would drop it, §6.1), with a case in `packages/shared/test/validate.test.ts` (next to the existing `welcome` cases) for present, absent and malformed `world`; `docs/PROTOCOL.md`: one line.
- `packages/shared/src/content.ts`: `ZoneDef`, `ZONES_FILE` (§6.2). Shared with lane 1: one of the two adds both.

Optional (§4.4, only if the N100's performance log asks for it): numeric grid keys in `world.ts` `updateInterest`, and awake-cell iteration in `gameplay.ts` `tick`.

**Tests** (`fields.test.ts`, skipped without `work/out/world/jangan-fields`):

- with `WORLD_EXPORT=jangan-fields`, the log says `nav.bin (307 regions, 2281 objects` (the format `nav-real.test.ts` already matches for 9 / 547) and `world content: 46 NPCs, 791 nests (34 skipped)` today; the reachability rule may lower 791, so assert ≥ 700;
- more than 6,500 monsters spawned;
- `GET /api/servers` and `welcome.server` (after `parseServerMessage`) have `world: 'jangan-fields'`, and `worldEnter.world.name` is the same; GM `tp jangan` still lands at the town spawn;
- a GM `tp` to (−3000, 0) is clamped to x ≥ −2304;
- `tp north-tiger-mt` works;
- the town respawn after death is still the GATE_CH point;
- a performance smoke test with 10 clients for 5 s logs the mean and max tick. It asserts mean < 10 ms (generous, to avoid flakiness).

`role-policy.test.ts` keeps passing. No role logic is touched.

**How to check:**

- `WORLD_EXPORT=jangan-fields pnpm dev`. The server log shows 307 regions and about 6,900 monsters (6,944 before the reachability rule).
- In game, as GM, `tp grassland` puts you among Mangyangs, and `/who` still works.

### Lane 4: game integration and the world map

**Owned files (new):**

- `apps/game/src/world/map/worldmap.ts` (the window: canvas, pan/zoom, labels);
- `apps/game/src/world/map/hunting.ts` (the nest clustering, pure);
- `apps/game/src/world/map/zones.ts` (loading `zones.json`, `zoneAt`);
- `apps/game/test/worldmap.test.ts`.

**Hooks:**

- `apps/game/src/world/jangan/ground.ts`: `JanganOptions` already has `world`; it gains `focus`. `loadJangan(scene, {world, focus})` passes both to `loadWorld` with `stream: 'auto'`. Also replace the one-time `const terrain = new Set(world.terrain.meshes)` behind `isGround` with a live check (e.g. a mesh metadata tag set by `buildRegion`), or clicks on streamed-in terrain stop working (`screens/world.ts` picks with `ground.isGround`) **[confirmed; missing from the first draft]**.
- `apps/game/src/screens/world.ts`:
  - pass `params.character.pos` (`CharacterSummary.pos`; the town spawn for a new character) and `app.session.server?.world ?? 'jangan'` to `loadJangan` (the call at about line 319 passes only `onProgress` today). `Session.server` is the `welcome` ServerInfo, so no server-select change is needed once `validate.ts` keeps `world` (lane 3);
  - in `onWorldEnter` and on `warp` of self, call `g.world.stream?.setFocus(x, z)`;
  - the loading screen waits for `stream.whenReady(x, z)`;
  - the stats line gains `stream.stats.ready/wanted` and MB.
- `apps/game/src/world/jangan/heights.ts`: the `selfMove` guard with `navCovers` (§3.8).
- `apps/game/src/world/jangan/minimap.ts`: none, since the `Minimap` API is unchanged.
- `apps/game/src/hud/index.ts`: add `else if (k === 'm') { ev.preventDefault(); mapWin.toggle() }` to the existing keydown handler. The skills lane may add keys there too, so keep the edit to that one branch.
- `apps/game/src/i18n/en.ts`: the `map.*` keys and `world.help`.
- `apps/game/src/world/jangan/zones.ts`: music stays town/field by `safeArea` (`townAt`). Fact-check: the HUD has **no** location text today; `world.town` is only the fallback in the chat welcome line (`screens/world.ts` about line 584) and on character select **[confirmed]**. A zone label is therefore a new element (under the minimap, which is also where docs/UX_GAPS.md M1 puts an "area name"), fed by `map/zones.ts` `zoneAt`; agree with UX-B who owns it.
- **Coordination with docs/UX_GAPS.md (lane UX-B):** it plans the same M window (M3, new `apps/game/src/hud/worldmap.ts`), the minimap area name (M1) and level-band colours (F2). Pick one owner before starting: recommended, UX-B owns the window file and the `k === 'm'` branch, and this lane owns the data modules (`world/map/zones.ts`, `hunting.ts`, the `stream.worldMap` pixel↔world transform) that the window renders. UX_GAPS M3 draws "the whole minimap atlas", which does not exist in streaming mode; it must use `worldmap.png` from `manifest.stream.worldMap` instead.

**Tests** (`worldmap.test.ts`):

- map pixel ↔ world metre round trip for the four corners of `stream.worldMap`;
- label placement per zone (mean of region centres);
- the hunting clusters from a synthetic `nests.json` (200 m linkage, one label per cluster, Tiger Girl merged);
- level colours at player levels 1, 10 and 20.

**How to check:**

- Log in with the server on `jangan-fields`. The loading bar ends as fast as today (about 28 MB).
- Walk out of the west gate. The land, trees and monsters keep coming, with no loading screen and no hitch you can feel.
- Keep walking to Tiger Mountain (about 5 minutes) and find tigers, bandits and possibly Tiger Girl.
- Press **M**: the map shows Jangan, the area names in English, you, and "Tiger Lv 14" / "Bandit Lv 16" labels coloured by your level.
- Die out there: you respawn in Jangan.

---

## 8. Open questions and risks

- **Partial texture-array uploads** in Babylon 9 (one layer of a `RawTexture2DArray`) **[unknown]**. The fallback rebuilds the array, which can hitch for about 50–150 ms when the tile set grows **[likely]**.
- **Tile decode on the main thread:** about 2 ms per 512² tile **[unknown]**. Moving `decodeImage` into a Worker is the fix if it hitches.
- **Skinned clone cost** (`instantiateModelsToScene` per placement, 1,101 in the area) **[unknown]**. One clone per job keeps it inside the budget, but a region with about 100 animated flowers takes about 100 frames to fill in.
- **Reachability at area scale:** 0.62 s and 53 MB on the dev PC with the `reach.ts` of fact-check time (first draft: 1.8 s with an earlier version); about 1.6 s on the N100 **[likely, ×2.5]**. The reach lane decides whether to precompute or cache it.
- **Nests lost to the component rule:** the count is **[unknown]** until that lane lands. Watch the startup log.
- **Painted world-map tiles:** the tiling rule of `map_world_<x>x<z>.ddj` is **[unknown]**. v1 uses the minimap stitch.
- **Unnamed regions:** 78 active regions have no `textzonename` name (80 have no `refregion` row; 77 lack both) but are 28–100 % open, 47 of them in the playable set. The HUD shows `map.zoneUnknown` for them, or the nearest named zone within 1 region **[proposal]**.
- **Density:** 6,944 retail-count monsters for a handful of players. `NEST_COUNT_SCALE` is the knob, and it is not a performance need (§2.3).
- **N100 tick numbers are projected** (×2.5), not measured. The first deploy should read `worstTickMs` from the server's performance log.
