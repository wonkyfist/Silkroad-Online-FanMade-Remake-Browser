# Outdoor world rendering spec (vSRO 1.188)

This is how the original client draws the outdoor world: terrain, terrain texturing, lightmaps, water, sky, fog and placed objects. It also gives the recommended Babylon.js 9 implementation of each part. It is a spec, not code. The parsers in `packages/formats` return raw file-space values, and every conversion to the viewer goes through `packages/convert/src/gltf/space.ts` (see `CONVENTIONS.md`).

## Status tags

Every claim carries one of three tags:

- **[confirmed]**: at least one source agrees, and a check against the real 1.188 bytes under `work/extracted` agrees too. Where possible the check used independent ground truth: the client's own minimap images, the navmesh, cross-file references, or object heights against terrain heights.
- **[likely]**: one or more sources say so, but we have no independent data check (typically OpenSRO's reverse-engineering notes).
- **[unknown]**: the sources disagree or say nothing, and the data does not decide it.

## Sources

| Tag | Source | Licence and use |
|---|---|---|
| OR-doc | openroad `docs/formats/*.md` (mapm, mapt, mapo, 2dti, envi, mfo, obji, cpd, nvm, minimap) | GPL, read only |
| OR-src | openroad `assets/shaders/terrain_splat.wgsl`, `client/src/plugins/map/{objects.rs,terrain/mod.rs}` | GPL, read only |
| OS | OpenSRO `apps/client-next/src/engine/**` (`runtime/assets/worker/world/world.ts`, `runtime/renderer/device/pipelines.ts`, `foundation/rendering/{world-environment,world-math,world-material,sky-geometry,object-visibility}.ts`, `video-options.ts`) and `scripts/build/world/**` (JMXV parsers, `environmentTracks.mjs`, `copyWaterImages.mjs`, `buildWorldAnimatedObjects.mjs`). It cites native function addresses (sub_8b3aa0, sub_8a7d10, 8a4d40, and others). | AGPL, read only, nothing copied |
| SD | SilkroadDoc wiki: JMXVMAPM, JMXVMAPT, JMXVMAPO | reference |
| LF | Lafa2K `silkroad_direct_importer_1_4.py` (Blender) | MIT |
| WS | websro `docs/TERRAIN*.md`, `tools/convert/*.py` (built against a different client, iSRO) | read only |
| DATA | Our measurements on vSRO 1.188 (method in §10) | — |

Where sources disagree, **DATA decides**. Section 11 lists every conflict.

---

## 0. Key decisions (TL;DR)

| Topic | Decision | Status |
|---|---|---|
| Region | 1920 × 1920 units; 6×6 blocks of 320; 96×96 cells of 20; 97×97 unique vertices | confirmed |
| Region ↔ world | Region id = `(z << 8) \| x`, stored as `Map/<z>/<x>.m`. World X = 1920·x + localX and world Z = 1920·z + localZ. X increases with region x and Z with region z. | confirmed |
| Vertex order | Blocks are stored z-outer then x-inner, and so are the vertices inside a block. Vertex (vx, vz) of block (bx, bz) is grid point i = 16·bx + vx, j = 16·bz + vz, at local (20i, h, 20j). | confirmed |
| Edges | Block and region edges are **duplicated with bit-identical heights**. Region (x+1) column 0 equals region x column 96, and likewise for z. | confirmed |
| Cell split | Height queries use the diagonal (i, j)–(i+1, j+1) in every cell. | confirmed (object heights) |
| Texture word | Bits 0–9 are the tile2d.ifo id. Bits 10–12 are always 0. Bits 13–15 are a **tiling code**. | confirmed |
| Tiling period | code 0 → 80 units, code 1 → 160, code 2 → **80**, code 3 → 40, code 4 → 20 | 0/1/2 confirmed, 3/4 likely |
| Texture UV | u = worldX / period and v = worldZ / period. Texel row 0 is at v = 0. The texture is not flipped. | confirmed |
| Blending | Draw layers per cell, sorted by (tileId, code). The first layer is opaque; the later ones are alpha-blended with a mask built from the four corners. | likely (OS) |
| Brightness byte | **Not used for lighting.** It is 0 on most vertices. | confirmed not a multiplier; meaning unknown |
| Terrain light | Output = composited tiles × saturate(lightmap + TerrainShadowColor), a 1× multiply. The terrain is otherwise unlit. | lightmap confirmed; combine likely (OS) |
| Lightmap UV | u = localX / 1920 and v = localZ / 1920. DDS row 0 is z = 0. | confirmed |
| 96×96 `.t` grid | Row-major (row = z cell, column = x cell), roughly the lightmap downsampled. Used only to gate dynamic shadows. | confirmed |
| Objects | Only `.o2` is used. Positions are local to the record's RegionID and use the same frame as the terrain. | confirmed |
| Object yaw | Radians. In file space, local +X maps to (cos yaw, 0, sin yaw) and local +Z to (−sin yaw, 0, cos yaw). In glTF/Babylon space this is a right-handed rotation of **+yaw about +Y**. | confirmed |
| Dedupe | A record repeats in every block it overlaps and in neighbouring regions' files. Key on (RegionID, UID, ObjID); position can be added to the key. | confirmed |
| Fog | Linear on view depth. Start = G10 × R, end = G11 × R, with R = min(2500, 0.8 × scenery range) = 2500 units by default. | likely (OS), track order confirmed |
| Minimap tile | `Media/minimap/<x>x<z>.ddj` is one region, 256 px at 7.5 units/px. Image top = +Z (z = 1920, north); left = x = 0 (west). | confirmed |

---

## 1. Terrain geometry

### 1.1 File layout (`Map/<z>/<x>.m`, JMXVMAPM1000, 92,712 B)

Sources: OR-doc, SD, OS `JMXVMAPM1000.mjs`, LF `read_terrain`. **[confirmed]**; the layout parses EOF-exact on all 9 Jangan regions.

```
char[12] "JMXVMAPM1000"
36 blocks, bz 0..5 outer, bx 0..5 inner, 2575 B each:
  u32 flag            0 none, 1 culled (168x97 has one culled block)
  u16 environmentId   profile id in environment.ifo (Jangan: 15; row z=96: 0)
  17x17 vertices, vz outer, vx inner, 7 B each:
     f32 height
     u16 texture      bits 0-9 tile id | bits 10-12 zero | bits 13-15 tiling code
     u8  brightness   (see 2.5)
  i8  waterType       -1 none, 0 water, 1 ice
  u8  waterWaveType   0..3
  f32 waterHeight
  u16 tileFlag[16][16]  1 = manually blocked (navigation only)
  f32 heightMax, heightMin   includes objects
  u8  reserved[20]
```

### 1.2 Grid and world frame

- Region-local vertex (i, j), with i, j in 0..96, is at `(20·i, height, 20·j)`, where i = 16·bx + vx and j = 16·bz + vz. **[confirmed]**
  - Inside a region, every shared block edge has bit-identical heights: 0 mismatches over 9 regions.
  - The navmesh `Data/navmesh/nv_<id hex>.nvm` ends with a 97×97 f32 height map (the last 97·97·4 + 36 + 144 bytes). It equals the `.m` grid exactly, in the same order (max |d| = 0.0 on 9/9 regions). Transposed or flipped alternatives differ by 33–180 units.
- Region seams:
  - The x-seam is `H[x+1][:, 0] == H[x][:, 96]` and the z-seam is `H[z+1][0, :] == H[z][96, :]`. Both hold with max |d| = 0.0 on all 12 Jangan seams, and the reversed pairings differ by 5–92 units.
  - So **world X grows with region x and world Z grows with region z**. **[confirmed]**
- File-space world position: `(1920·rx + 20·i, h, 1920·rz + 20·j)`. The region id is `(rz << 8) | rx`, and bit 15 is the dungeon flag. Jangan's centre is 168×97 = 0x61A8. **[confirmed]**
- Compass: +X is east and +Z is north. The minimap (§7) shows +Z at the top. The sun rises on +X (§5.3). The client is left-handed and Y-up, like the models.
- `Map/mapinfo.mfo` is a 65,536-bit mask of active regions: bit = region id, MSB-first within each byte (OR-doc). All 9 Jangan regions are set, and 3,300 regions are active in total. **[confirmed]**

### 1.3 Triangulation, heights and LOD

- Height between vertices: split every cell along **(i, j)–(i+1, j+1)**, the same diagonal in every cell.
  - **[confirmed]** by object heights. Objects' stored y matches the terrain exactly (|Δ| < 0.01 for 55% of 2,875 own-region Jangan placements, median 0.000) with this split.
  - Bilinear interpolation gives 44% (median 0.027). The opposite diagonal gives 41%. OS's parity-alternating split gives 48%.
  - Use this diagonal for render triangles and for ground queries, so that objects sit on the rendered surface.
- OS renders with a diagonal that alternates by (x + z) parity. That is **[unknown]** for the native renderer. Prefer the uniform diagonal, because it matches the data.
- LOD (OS, **[likely]**):
  - The step is `1 << lod`, giving 17, 9, 5 or 3 vertices per block edge.
  - The LOD is chosen from the squared distance in blocks between the block and the camera's block: ≤ 16 → 0, ≤ 39 → 1, ≤ 81 → 2, else 3.
  - Seams are stitched to the neighbour's LOD.

---

## 2. Terrain texturing

### 2.1 Tile catalogue

- `Map/tile2d.ifo` (JMXV2DTI1001) is text: a header line, then a count (603), then lines of the form `<id 5 digits> <type 0x%08X> "<category>" "<file.ddj>" [{obj,count}...]`.
- Textures are `Map/tile2d/<file>`. They are 512×512, with a few at 256×256. **[confirmed]**
- Tile ids used in the `.m` files are ≤ 602. Jangan uses ids up to 279, including ids 256–279, so **10 bits are needed**. WS's `& 0xFF` plus a "rotation" in bits 8–9 is wrong for this client. **[confirmed]**
- The trailing `{obj,count}` 3D-grass pairs are **not rendered** by vanilla (OR-doc RE). **[likely]** There are no detail textures. **[likely]**

### 2.2 Tiling code (bits 13–15) and texture scale

The world-space repeat period in units depends on the code:

| code (bits 13–15) | value of bits 10–15 (openroad's "Scale") | period (units) | UV per vertex step | evidence |
|---|---|---|---|---|
| 0 | 0 | **80** | 0.25 | **[confirmed]** minimap autocorrelation peaks at 10.7 px = 80 u (regions 190×99, 186×99, 152×86); render-vs-minimap correlation is best at 80 over all of Jangan |
| 1 | 8 | **160** | 0.125 | **[confirmed]** in regions 99×94 and 100×94 (100% code 1) the minimap autocorrelation is 0.76 at 21 px (160 u) and 0.28 at 11 px; the render correlation is 0.742 at 160 vs ≤ 0.49 otherwise. OS agrees; OR-doc's constant 80 is refuted. |
| 2 | 16 | **80** | 0.25 | **[confirmed]** in regions 232×107 and 224×108 (100% code 2) the peak is at 11 px (80 u) and low at 16 px; a visual comparison agrees; the OR-doc playtest agrees. **OS's 320 (0.0625) is refuted.** |
| 3 | 24 | 40 | 0.5 | **[likely]** (OS). Code-3 patches in the minimap favour periods ≤ 40 over 80 (for example 72×109: 0.16 at 40, 0.08 at 80), but the patches are small. |
| 4 | 32 | 20 | 1.0 | **[likely]** (OS). Only 764 vertices exist in the whole world, and the minimap is inconclusive. |

- Census of all 3,437 parseable regions: code 0: 16.6 M vertices, 1: 4.5 M, 2: 14.6 M, 3: 77 k, 4: 764. Codes 5–7 never occur. **[confirmed]**
- The code is **per vertex**. One tile id can appear with several codes. OS treats (tileId, code) as the unit of blending, and so should we.
- UV origin:
  - u = worldX / period and v = worldZ / period, with worldX = 1920·rx + localX.
  - Every confirmed period divides 320, so a region-local, block-local or world origin all give the same pixels. Use the world (or region-local) origin; OS uses the region-local vertex index × UV-per-step.
- Orientation: u runs along +X, v along +Z, and texel row 0 is at v = 0. **[confirmed]** The unflipped mapping wins the minimap correlation (0.742 vs 0.486 in 99×94; 0.311 vs 0.288 over Jangan).
- Filtering: MIN, MAG and MIP are all linear, with no anisotropy (OS: "87cbc0 sets MIN/MAG/MIP LINEAR, no anisotropic"). **[likely]**

### 2.3 Blending: the native per-cell layering

Source: OS `passes()` (their notes cite native sub_8b3aa0). **[likely]**; not independently checked. Described here in our own words, for the 17×17 vertex grid of one block, or the grid sampled every `step` vertices for LOD:

1. Give every vertex a key `K = (tileId << 3) | code`. Process the distinct keys in **ascending K order**. Native caps this at 49 keys per block.
2. Keep one `claimed[16][16]` flag per cell, shared by all keys.
3. For each key K:
   1. Set the vertex mask m(v) = 1 where the vertex key == K.
   2. A cell is *touched* if any of its four corners has key K.
   3. Scan the cells z-outer, x-inner. For each touched cell that is not yet claimed:
      - claim it;
      - set **all four** of its corners to m = 1. Later cells in the same scan see these corners.
      - mark its 8 neighbours as *near*.
   4. Every touched or near cell with a non-zero corner mask emits a layer (K, mask4). mask4 has bit 0 = (x, z), bit 1 = (x+1, z), bit 2 = (x, z+1), bit 3 = (x+1, z+1).
4. For each cell, drop every layer before its last `mask4 == 15` layer. In practice, the one opaque layer is the lowest key among the cell's corners.
5. Draw each cell's layers in order:
   - the first layer is opaque (mask 15);
   - each later layer uses `alpha = interpolate(mask4 corner bits)` and blends with `SRCALPHA / INVSRCALPHA`.
   - OS evaluates the alpha as an exact bilinear inside the cell. Native D3D9 would interpolate it per triangle (Gouraud). That detail is **[unknown]**; bilinear is visually safe.

Statistics, computed with our own re-statement of this algorithm over 64,512 cells in 7 regions:

- layers per cell: 1 × 40,167; 2 × 17,418; 3 × 5,748; 4 × 1,041; 5 × 130; 6 × 7; 7 × 1. **Budget 8 layers per cell.**
- 3,052 cells (4.7%) draw a key that is at none of their own corners. That is bleed from the claim step, so a plain per-vertex bilinear weight blend (openroad, LF) differs from native in about 5% of cells, and also in the order of overlapping layers.
- The simple alternative, used by openroad and LF: each fragment takes the 4 corner textures weighted bilinearly (weights sum to 1). It matches native closely in two-texture cells. Treat it as the v1 fallback.

### 2.4 Tile material types

`TileType` (Dirt, Sand, Grass, Water, Snow and so on) is used for footstep sounds and similar gameplay effects, not for rendering (OR-doc, OS `terrain-sounds`). **[likely]**

### 2.5 The brightness byte

- It is not lighting. **[confirmed negative]**
  - It is 0 on most vertices: 3,841 to 9,340 of the 9,409 vertices per region in Jangan and elsewhere.
  - Its correlation with the lightmap is −0.09 to 0.28. With the minimap it is −0.32 to 0.00.
  - It correlates with slope in some regions (up to 0.95).
- Multiplying by it, as WS and LF do (LF only as an optional tweak), would turn most terrain black.
- OS does not use it. Its meaning is **[unknown]** (the SilkroadDoc wiki guesses "lighting direction indicator?"). **Do not render it.**

---

## 3. Lighting

### 3.1 The terrain lightmap (`Map/<z>/<x>.t`, JMXVMAPT1001, 140,436 B)

```
char[12] "JMXVMAPT1001"
u8  shadowGrid[96*96]   row-major: index = zCell*96 + xCell   (see below)
i32 textureLength       includes these 8 header bytes (OR-doc correction)
i32 textureType         3 = D3DRTYPE_TEXTURE
u8  dds[textureLength-8] DXT1 512x512 with mips, 3.75 units/texel
```

- **UV [confirmed]:** `u = localX/1920` and `v = localZ/1920`. DDS row 0 is the z = 0 edge, and it is not flipped.
  - Measured over 46 regions around Jangan by correlating lightmap darkness with the blurred density of object positions. The identity orientation scored a mean of 0.125 and won 25/46 regions; the next best orientation scored 0.022.
  - OS uses the same UV, `(blockX·16 + x)/96`.
  - openroad left this open as a "V-flip calibration pending".
- **Content:** the lightmap is greyscale (R = B, G within the 565 rounding).
  - Values are 1.0 in the sun, with a floor of about 0.61 in shadow.
  - It is cast-shadow data, not N·L shading: the correlation with an N·L hillshade is ≤ 0.27.
  - The minimap does not include these shadows (correlation ≈ 0).
- **Combining [lightmap confirmed as a multiply target; exact state likely]:** OS runtime-confirmed the native pass `SRCBLEND = ZERO, DESTBLEND = SRCCOLOR` (framebuffer × src), where src = `saturate(lightmapTexel + TerrainShadowColor)` (texture-stage ADD with TFACTOR). So:

  `terrain = composite(tiles) × saturate(lightmap.rgb + TerrainShadowColor(t))`

  - This is a **1× modulate, not 2×**.
  - TerrainShadowColor is environment track 6 (0x1c0). It is 0 at noon and about (0.02, 0, 0.16) at night in Jangan's profile. It lifts the shadow floor.
  - OS samples the lightmap with a LOD bias of −0.5.
  - Regions without a `.t` use white.
- **Is the terrain otherwise unlit? [likely]** In OS, the terrain passes are fixed-function unlit (colour = texture, with the layer mask as alpha) and there is no N·L. openroad's "mode 2 (fully baked albedo × lightmap)" also describes the original. Whether some global night tint reaches the terrain is **[unknown]**; OS says TerrainAmbient (track 5) is overwritten and inert. At night, therefore, only fog and the shadow-floor term change the terrain.
- **The 96×96 `shadowGrid` [confirmed]:**
  - It is row-major 96×96, one byte per 20-unit cell.
  - It correlates with the downsampled lightmap at 0.90–0.97 in identity orientation, but only 0.10–0.65 read block-major. So OS's block-major reading (36 blocks × 16×16) is refuted.
  - The values are quantised (255, 229, 204, 178, 153, 0).
  - SilkroadDoc and OR-doc say it only gates whether dynamic objects receive shadow tone. **Not drawn.**

### 3.2 Environment lights for objects

Source: OS `pipelines.ts`, `world-environment.ts` (native sub_8a7d10). **[likely]**

- Directional light: diffuse = `Diffuse(t) × 0.6`, where Diffuse is track 2.
- Ambient = `ObjectAmbient(t)`, track 3, unscaled.
- Light direction: fixed. `dot(N, normalize(1, 1, 0))` in world space, so the light comes from +X and up, independent of the time of day. **[likely]**
- Object vertex lighting follows D3D fixed function:

  `L = saturate(matDiffuse · lightDiffuse · max(0, N·l) + matAmbient · lightAmbient)`

  `out = saturate(tex · vertexColor · L · 2)`

  - The `· 2` is `MODULATE2X`, applied unless BMT flag 0x8 is set. BMT 0x8 means unlit: `out = tex`.
  - Supporting data: Jangan object BMTs have diffuse ≈ ambient ≈ 0.588 (150/255; p5–p50 of 917 materials). At noon L ≈ 0.4–0.66, so 2× lands near 1. That is consistent with authoring for a 2× modulate.
- Alpha: materials with BMT 0x200 use an alpha test with `ALPHAREF = 128` (OS; `CONVENTIONS.md` records our own MASK/BLEND decision). Opacity fades use blending.

### 3.3 Object lightmaps (BMS vertex flag 0x400)

- BMS flag 0x400 adds `uv1` (f32×2 per vertex, in [0, 1]) and a lightmap path. **[confirmed]**
  - In Jangan, 464 of 685 object meshes have one, and all 464 files exist.
  - Paths are relative to Data.pk2, for example `prim\lightmap\bldg\china\jangan01\cj_luxu_floorlightingmap.ddj`.
  - The textures are 128–256 px RGB, alpha 1, with texel medians of about 0.65–0.85 and p95 of about 0.9–1.0.
- **How the native client combines them is [unknown]**: OS and openroad do not use object lightmaps, and nobody has RE'd it.
  - The value range (≤ 1, median around 0.7) fits a **1× multiply after the lit colour**: `out = saturate(2 · tex · L) · lightmap`. A 2× multiply would over-brighten.
  - Implement it with a toggle (off, 1×, 2×) and calibrate against an in-game screenshot.

---

## 4. Water

Source: OS `world.ts` (terrain decode) and `copyWaterImages.mjs`; OR-doc; our data. The per-block fields are **[confirmed]**; the rendering is **[likely]** (OS).

- Per block: `waterType` (−1 none, 0 water, 1 ice), `waterWaveType` (0–3; Jangan uses 2 and 3) and `waterHeight`.
  - A block's water plane is flat at waterHeight over the whole 320 × 320 block.
  - It is visible only where the terrain is below it. Many blocks carry water at −20 while the terrain is 90% above it.
  - Jangan's central pond is 168×97 blocks (2,2) and (3,2), at h = −33, with 90% of vertices below.
- **Water (type 0):**
  - Geometry: a 17×17 grid at waterHeight.
  - Per-vertex alpha = `clamp(trunc((waterHeight − terrainHeight) · 0.5), 0, 15) / 15`. Full opacity is reached at 30 units (3 m) of depth. Skip the block if every alpha is 0.
  - UV = 4 repeats per block (period 80 units).
  - Texture: 30 animation frames `Map/water/water101..water130.ddj` (64×64, opaque RGB ≈ (0.35, 0.51, 0.51)), advancing every 100 ms.
  - Colour = `texture × saturate(WaterColor(t))`, where WaterColor is track 14 (0x228). Alpha = vertex alpha. Blend SRCALPHA / INVSRCALPHA, no depth write, drawn after the terrain.
- **Ice (type 1):** when `waveType ≠ 0`, draw one opaque quad per block with `Map/water/water201.ddj` (512²).
- `wave1..3.ddj` (128², dark) are shore or wave textures whose use is **[unknown]**.
- The Water Reflection video option builds a DuDv plus 512² reflection target. It is off by default (OS), so skip it.

---

## 5. Sky, fog and environment

### 5.1 environment.ifo (JMXVENVI1003)

Layout: OR-doc, OS; parses EOF-exact, with the region tree starting at 64,384 of 66,472 bytes. **[confirmed]**

```
char[12] sig; u16 profileCount (60); lpString setName("")
profile: u16 id; lpString name, dayBGM, nightBGM;
         16 graphs in this order; Color graph = i32 n + n x (r,g,b,t) f32;
                                  Float graph = i32 n + n x (value,t) f32
then an editor-only name tree (ignore)
```

- Time t is in [0, 1). 0 is midnight and 0.5 is noon: SkyTop is brightest at 0.5 in Jangan's profile. **[confirmed]**
- Sampling: find the bracketing keys and interpolate linearly. Clamp at the endpoints. If a key span is < 1e-4, take the lower key (OS). Colours are in [0, 1] and floats in [−1, 1] (OR-doc census).
- **Profile selection:** use the `.m` block's `environmentId` under the camera, which is the profile id (OR-doc, OS). **[likely]** Jangan is profile 15, "Env7".
- **Transitions:** each frame, move every value `min(1, dt · 0.5)` of the way toward the target (OS 8A8436). **[likely]**
- **Clock:** starts at 0.5 and advances 0.0005 per second, so a full day is 2000 s (OS `ENV_TIME_CYCLE`). **[likely]** The server may override it **[unknown]**.

| # | openroad name | OS role (native) | Used for | Status |
|---|---|---|---|---|
| 0 | SunColor | sun disc TFACTOR tint | sun billboard | agree |
| 1 | SkyTopColor | sky dome zenith | sky | agree |
| 2 | DiffuseColor | object light diffuse (×0.6) | objects | agree |
| 3 | ObjectAmbientColor | object light ambient | objects | agree |
| 4 | Graph4 ("cloud colour?") | sky scatter/horizon glow colour | sky glow, cloud tint | OS likely |
| 5 | TerrainAmbientColor | **inert** (material overwritten, runtime-confirmed by OS) | nothing | OS likely |
| 6 | TerrainShadowColor | lightmap shadow-floor ADD | terrain | agree |
| 7 | FogNear (OR) | sky glow radius: `max(1, (G7+1)/2 · 80000)` | sky | **OS**, see below |
| 8 | FogFar (OR) | sky gradient falloff: `k = 1 − clamp(G8, −1, 1)` | sky | **OS** |
| 9 | FogColor | D3D fog colour | fog | agree |
| 10 | Graph10 (OR "cloud alpha") | **fog start fraction** | fog | **OS, data-backed** |
| 11 | Graph11 (OR "cloud alpha") | **fog end fraction** | fog | **OS, data-backed** |
| 12 | Graph12 (unknown) | cloud alpha, `(G12+1)/2` | clouds | OS likely |
| 13 | SkyBottomColor | horizon | sky | agree |
| 14 | WaterColor | water tint | water | agree |
| 15 | Graph15 / NightIntensity | star alpha | stars | agree |

- Fog track evidence: across all 60 profiles sampled at 49 times, G10 < G11 in **100%** of samples, while G7 < G8 holds in only 67%. A fog start must be below the fog end, so OS's assignment is backed by data and OR-doc's is refuted. In Jangan, G10 = 0.49 to 0.76 and G11 = 1.0.

### 5.2 Fog

Source: OS. **[likely]**

- Linear fog on **view-space depth** (D3D table fog), not radial distance.
- `R = min(2500, 0.8 · sceneryRange)`. The Scenery Sight Range option is one of {1500, 2500, 3500, 4500, 5500}; the default is 3500, which gives R = 2500 units (250 m).
- `fogStart = G10(t) · R` and `fogEnd = G11(t) · R`. Jangan at noon is about 1900 → 2500.
- Fog colour:
  - objects: `saturate(FogColor)`;
  - **terrain:** `sqrt(saturate(FogColor))`, a "gamma fog tint" per OS.
- Terrain band: a block is drawn untextured, in the terrain fog colour, when its Euclidean distance in blocks from the camera's block exceeds `trunc((fogEnd + 1280) / 320)`. The test compares the squared block delta against that radius squared.
- Draw distance (culling far plane) = the scenery range.

### 5.3 Sky

Source: OS `sky-geometry.ts` and `pipelines.ts`. **[likely]**

- **Dome:** an octahedron subdivided 4 times, radius 20,000, camera-centred. The per-vertex colour is:

  `base = lerp(SkyBottom, SkyTop, clamp(y/5000 · 0.5 · k, 0, 1))`, with `k = 1 − clamp(G8, −1, 1)`

  then `lerp(scatter = G4, base, min(1, dist(vertex, sunPos) / glowR))`, with `glowR = max(1, (G7+1)/2 · 80000)`.
- A lower ring down to y·20000 ≤ 2207 is filled with the fog colour, with alpha 0 above the horizon.
- **Sun:**
  - angle `a = (t − 0.25) · 2π` and position `(cos a, sin a, 0) · 20000`, so it rises at +X (east) at t = 0.25 and sets at −X at t = 0.75;
  - billboard `Map/sun/lens2.ddj`, RGB = SunColor (track 0), alpha from the texture;
  - visible for t in [0.25, 0.875];
  - lens flares `lens1..8.ddj`.
- **Moon:** 30 phases, `Map/sun/moon01..30.ddj`; `moon16` is the full moon (verified on the files in wave 9, SKY §2.1;
  `MOON_TEXTURES` in `packages/shared/src/world-clock.ts`).
- **Stars:** 3000 points, alpha = G15.
- **Clouds:**
  - a plane at y = 20000, 8,000,000 units wide, with UV repeating 16 times per 2,000,000 units;
  - the UV scrolls by `(seconds mod 500)/500` per axis;
  - texture `Map/skybox/cloud1.ddj`, colour = `saturate(G4) · tex`, alpha = cloudAlpha (G12);
  - it fades to the fog colour between view depths 90,000 and 200,000.
- The `skybox/cloud99.ddj`, `glow.ddj` and `shadowsphere.ddj` files also exist; their use is **[unknown]**.

---

## 6. Objects

### 6.1 Files

- **`.o2` only.** The 1.188 client never opens `.o` (OR-doc string-table RE). **[likely]** `.o` is legacy and lacks RegionID.
- Layout (OR-doc, SD, OS, LF; parses EOF-exact on Jangan): **[confirmed]**

```
char[12] "JMXVMAPO1001"
36 blocks (bz outer, bx inner), each 4 LOD groups: u16 count, count x 30 B:
  u32 objId       -> Map/object.ifo line "<id> <flag 0x%08X> \"<path .bsr|.cpd>\""
  f32 x, y, z     local to the region in `regionId` (NOT necessarily this file's region)
  i16 isStatic    -1 (0xFFFF) or 0
  f32 yaw         radians
  i16 uid         object id, unique per region (with regionId)
  i16 short0      unknown (mostly 0, some 0xCCCC)
  u8  isBig       object extends beyond its region
  u8  isStruct    has an objectstring.ifo entry
  u16 regionId    (z<<8)|x, bit 15 dungeon
```

### 6.2 Placement

- **Frame [confirmed]:** file-space world = `(1920·RX + x, y, 1920·RZ + z)`, where (RX, RZ) come from the record's regionId.
  - Objects sit on the terrain under the same frame: median |y − terrain| = 0.000 with the cell diagonal of §1.3.
  - Flipping z instead gives a median of 14.6.
- **Yaw [confirmed]:** radians. The file-space rotation takes local +X to `(cos yaw, 0, sin yaw)` and local +Z to `(−sin yaw, 0, cos yaw)`:

  `world = p + (x·c − z·s, y, x·s + z·c)`, where c = cos(yaw) and s = sin(yaw).

  - Evidence: we overlaid the top-down BMS footprints of Jangan buildings on the minimap. With this rule, roofs, yards and towers line up. The opposite sign produces mirrored layouts.
  - Per object, over the 100 Jangan buildings with non-axis-aligned yaw, this rule wins 43, the opposite sign wins 16, and the mirrored-mesh variants win 32 and 9. Mean edge correlations are 0.060 vs −0.026.
  - OS (`mapPlacement`, native 0x441484) and openroad `objects.rs` (after its X mirror) say the same.
  - A first region-wide *visual* impression suggested the opposite sign and was wrong. **Trust the overlays and statistics, not impressions.**
- **In glTF/Babylon space** (space.ts: p → 0.1·(x, y, −z)):
  - the placement becomes `translation = 0.1·(X, y, −Z)` and `rotation = +yaw about +Y` (right-handed; it takes +X to (cos yaw, 0, −sin yaw));
  - equivalently, `Quaternion.RotationAxis(Vector3.Up(), yaw)` in the viewer's right-handed scene;
  - meshes are the space.ts-converted BMS (Z mirror, flipped winding).
- **Duplicates [confirmed]:**
  - A record is repeated in every block it overlaps. Across the 5×5 regions around Jangan, 1,711 non-big records are listed in a block other than the one containing their position; 2,655 are listed in their own block.
  - A record is also repeated in neighbouring regions' `.o2` files. All 190 foreign-regionId records in Jangan's 9 files are byte-identical copies of a record in the owner region's file.
  - Deduplicate on `(regionId, uid, objId)`, adding x, y, z to be safe: openroad keys on (regionId, uid) and OS on all of them. Jangan's 3,065 records collapse to 1,862 unique placements.
- `isBig` marks objects that spill outside their region, 21,872 of them worldwide (OR-doc). Use it as a hint that the object must be cross-region culled. `isStruct` points to objectstring.ifo (named gates and so on).
- **isStatic [likely]:** 0 means animated. In Jangan, 763 of 767 placements whose BSR has a skeleton and clips have isStatic = 0; 64 placements have 0 without clips, and 2,234 have −1 without clips.

### 6.3 LOD groups and draw distance

- Only groups 2 and 3 contain objects; groups 0 and 1 are empty everywhere (OR-doc). **[confirmed]** Jangan has 1,806 records in g2 and 1,259 in g3.
- g2 holds buildings and trees; g3 holds small props, grass and flowers.
- Visibility (OS, native 0x8c4c60): **[likely]**
  - g2 draws while `distance − radius < 2020` units (cell radius 15 blocks); g3 while it is `< 480` (cell radius 7).
  - Fade-in and fade-out change alpha by 512 units per second on a 0–255 scale, which is about 0.5 s.
  - An object first seen at `(distance − radius) · 1.5 ≤ range` pops in at full alpha.

### 6.4 Compounds (`.cpd`)

- object.ifo may point to `compound\...\*.cpd` (JMXVCPD 0101, OR-doc). It lists 2–9 `.bsr` resources, all drawn with the placement's transform, plus an optional collision `.bsr`.
- In Jangan these are waterfall particle compounds. **[confirmed]** (layout per OR-doc; our BSR parser rejects `.cpd`, as expected).

### 6.5 Animated objects and modifiers

- **Skeletal:** a BSR with a skeleton and `.ban` clips animates by looping its "default" animation set, state 0 clip (OS `buildWorldAnimatedObjects.mjs`, native CRTBranch_FindAnimationSetEntry "default" fallback). **[likely]**
  - Jangan has 34 of these among 199 BSRs: trees such as `tre_maple01`, `tre_willow01` and `tre_bank01`, animated flowers and pond weeds, lanterns (`cj_*_light*`), `cj_portal_stone`, goldfish, chickens and horses.
  - Only the skinned meshes of such BSRs move.
- **BSR mod data** (our `bsr.ts` parses it):
  - `dyVertex`: cloth, for signs, banners and flags. It is enabled by the Dynamic Animation video option, which is on by default.
  - `particle`: smoke and fire emitters.
  - `texAni`: UV scroll, updated as position += rate · dt.
  - `mtrl`: material animation, on trees.
  - `bumpEnv`: the lion statues.
  - Jangan counts: dyVertex 18 BSRs, particle 22, mtrl 31, bumpEnv 4.
  - Exact semantics are future work. **[unknown]**

---

## 7. Minimap tiles (ground truth for verification)

- File: `Media/minimap/<x>x<z>.ddj`. There are 4,482 files, 256×256. Most are DXT1; 54 are A8R8G8B8 (OR-doc).
- One file covers **exactly one region** (x, z) = 1920 × 1920 units, at 7.5 units per pixel. **[confirmed]**
- **Orientation [confirmed]:**
  - Image column = +X, left edge x = 0.
  - Image **top row = the z = 1920 edge** (north), with +Z up.
  - Pixel (col, row) covers local `x = (col + 0.5) · 7.5`, `z = 1920 − (row + 0.5) · 7.5`.
  - Evidence: correlating per-cell mean tile colour against the 8 dihedral orientations picks the vertical flip in 8 of 9 Jangan regions (0.38–0.69, next best ≤ 0.41; the city centre 168×97 is covered by buildings). The building footprint overlays of §6.2 fit exactly.
- **Content:** the textured terrain at the in-game tiling periods (which is why §2.2 could be measured from it) plus objects drawn from above. It does **not** show the `.t` shadows, and water is not visibly blue.
- It is a good regression oracle. Render a region top-down at 256 px with the spec above, flip it vertically, and compare against the tile: high-pass correlation and footprint overlay.

---

## 8. Recommended Babylon.js 9 implementation

General rules:

- The viewer's scene is right-handed (`scene.useRightHandedSystem = true`), in glTF metres.
- Convert every map position with space.ts: `p_gltf = 0.1 · (X, Y, −Z)`, and flip index winding. Do not invent a second conversion.
- Use a floating origin: subtract the centre region's `1920·(rx, rz)` before the ×0.1 step. Otherwise X reaches about 32 km.
- **Shaders:**
  - Write every custom material as `ShaderMaterial` with **two hand-written sources**:
    - WGSL, `shaderLanguage: ShaderLanguage.WGSL`, for `engine.isWebGPU`;
    - GLSL ES 3.0 for WebGL2.
  - Never hand GLSL to the WebGPU engine: that triggers the glslang/twgsl runtime conversion, which downloads from a CDN.
  - Babylon ≥ 8 core materials (StandardMaterial, PBR) ship native WGSL, so they are allowed too. A `MaterialPlugin` must supply code for both languages in `getCustomCode(shaderType, shaderLanguage)`.

### 8.1 Terrain mesh

- **Mesh:** one per region, or per block for culling and LOD.
  - Use the 97×97 shared vertices with positions only. Pass the local XZ (file space, in units) as a `vec2` attribute, or reconstruct it from the position.
  - Split every cell along file-space (i, j)–(i+1, j+1) and flip the winding after the mirror.
  - Normals are not needed; the terrain is unlit.
  - Heights for picking and character placement use the same split (§1.3).
- **Tile textures:**
  - Load them into a `RawTexture2DArray` per streaming window: the layers are the distinct tile ids used by the resident regions. There are 43 in the 3×3 Jangan window and a median of 8 per region.
  - Remap tile id → layer on the CPU.
  - Make every layer 512×512; upscale the 256² tiles.
  - Generate mipmaps. Use linear/linear/linear sampling with wrap and no anisotropy.
  - Upload rows in DDS order (`invertY = false`), so that v = 0 samples row 0.
  - A texture array of all 603 tiles would cost about 840 MB in RGBA8; do not build it. A BC1 array is possible if `texture-compression-bc` or `WEBGL_compressed_texture_s3tc` is available.
- **Cell layer map (native-exact blending):**
  - Run the §2.3 layering on the CPU per block.
  - Write a per-region `RawTexture` of RGBA8 texels, 96 × (96 · 8): texel `(xCell, zCell + 96·k)` holds layer k as R = array layer, G = tiling code, B = mask4, and A = 255 when the layer exists, else 0.
  - Use nearest sampling and read it with `textureLoad` (WGSL) or `texelFetch` (GLSL). Avoid integer formats, for portability.
- **Fragment:**
  - `cell = floor(local / 20)`, `f = fract(local / 20)`.
  - Compute the derivatives of `worldXZ / period` once, in uniform control flow, from the continuous world position (as openroad learned, wrapped coordinates break mips at cell and region borders).
  - Loop k = 0..7:
    - read the layer; stop when A = 0;
    - `a = bilinear(mask bits, f)`;
    - `c = textureSampleGrad(tiles, s, worldXZ / period(code), layer, ddx, ddy)` (GLSL: `textureGrad`);
    - `color = k == 0 ? c : mix(color, c, a)`.
  - Periods by code: 80, 160, 80, 40, 20.
- **Lightmap:** a per-region 2D texture (DXT1 → RGBA8, or BC1), clamp-to-edge, linear with mips, sampled with LOD bias −0.5 at `local / 1920`. Then `color *= saturate(lm + terrainShadowColor)`.
- **Fog:** compute it in the shader from view-space depth: `mix(color, sqrt(fogColor), saturate((viewZ − fogStart) / (fogEnd − fogStart)))`. Distances are in scene units, i.e. 0.1 × SRO units.
- **v1 fallback:** per-vertex bilinear weights (4 corner layers per cell, weights sum to 1). It fits the same shader skeleton.

### 8.2 Water

- One grid mesh per wet block, with a vertex colour carrying the alpha from §4.
- A `ShaderMaterial` with alpha blending, no depth write, drawn after the terrain.
- The 30 frames go into a `RawTexture2DArray` (64², 30 layers). Pick the layer `floor(time_ms / 100) mod 30`.
- `rgb = tex · waterColor`, plus the fog.

### 8.3 Sky and fog

- **Sky:**
  - an inverted sphere with `infiniteDistance = true`, rendered first with no depth write;
  - vertex colours from §5.3 computed on the CPU each frame, or in a small shader;
  - a sun billboard, a cloud plane and a star point cloud as separate meshes.
- **Environment sampler:** one CPU module evaluates all 16 tracks at t, applies the smoothing, and feeds uniforms: fog, lights, water colour and shadow colour.
- **Fog on built-in materials:** Babylon's scene fog (`FOGMODE_LINEAR`, `fogStart`/`fogEnd` = 0.1 × units) is acceptable, but check whether it measures depth or radial distance. For custom shaders, compute view-depth fog as the original does.

### 8.4 Objects

- **Instancing:** convert each BSR once (the existing converter pipeline), then place it with thin instances, one matrix per deduplicated placement:
  - `T(0.1·(X, y, −Z)) · R_Y(+yaw)` in glTF space;
  - the region offset uses the record's regionId (§6.2).
- **Material:**
  - For parity, use a shared fixed-function `ShaderMaterial` (WGSL + GLSL) implementing §3.2: `saturate(2·tex·saturate(matD·envD·0.6·max(N·l, 0) + matA·envA))`, the alpha test at 128, and fog.
  - `StandardMaterial` is acceptable for v1. Set `diffuseColor = 2 × BMT diffuse` and `ambientColor = 2 × BMT ambient`, use `scene.ambientColor` = env ambient and a `DirectionalLight` from (1, 1, 0) (convert the direction with space.ts), and set `specular = 0`.
- **Object lightmaps:**
  - Emit `uv1` as glTF `TEXCOORD_1` and record the lightmap path in the sidecar.
  - After loading, set `material.lightmapTexture` with `coordinatesIndex = 1`. On StandardMaterial set `useLightmapAsShadowmap = true`, which multiplies.
  - Or sample it in the custom shader.
  - Keep a runtime toggle (off, 1×, 2×) until §3.3 is calibrated.
- **Distance fade:** use per-instance alpha (§6.3). Animated objects use the skinned glTF with the "default" clip looping (§6.5).

### 8.5 Verification harness (for the implementing agents)

Build these checks into tests, following `CONVENTIONS.md`: they skip without `sro.config.json` and never commit images.

1. Heights at block and region seams are bit-equal, and the `.m` grid equals the `.nvm` tail height map.
2. `|placement.y − terrainHeight(x, z)| < 0.01` for at least 50% of Jangan placements, using the (i, j)–(i+1, j+1) split.
3. Render 168×97 and its neighbours top-down at 256² with §2 (no lightmap). Flip vertically and compare against the minimap, using the high-pass correlation with the texture periods. Code-1 region 99×94 must prefer 160 over 80.
4. Rasterise building footprints with the §6.2 yaw and check the edge correlation against the minimap. The rule must beat the opposite sign.

---

## 9. What the Jangan regions contain (our parse)

- **Regions** X 167–169 × Z 96–98, all active in mapinfo.mfo.
  - Heights range from −80 to +115 units. 168×97 (city centre) spans −61 to +4.
  - Each region uses 18–28 distinct tile ids; the 3×3 window uses 43. Examples: `c_dust_fld_01`, `c_grass_fld_03`, `c_grass_hmfld_01`.
  - Tiling codes over the window: 83,866 at code 0, 575 at code 1, 2 at code 2, 238 at code 3.
  - 168×97 has one culled block.
- **Environment:** row z = 96 uses profile 0; rows 97–98 use profile 15 ("Env7").
- **Water:**
  - bands at −20 along the block rows at z-block 4 of 167/168/169×96;
  - the central pond in 168×97 blocks (2,2) and (3,2) at −33;
  - lakes at −30 in 169×98 and −50 in 169×96;
  - wave types 2 and 3.
- **Lightmaps:** DXT1 512² in every region. The mean brightness is 0.75–0.92 (the city is darker because buildings cast shadow).
- **Objects:** 3,065 `.o2` records, which is 1,862 unique placements; g2 has 1,806 records and g3 1,259.
  - 202 object ids: 199 BSRs and 3 particle `.cpd` compounds.
  - 34 BSRs are skeletally animated (trees, flowers, lanterns, fish, chickens, horses).
  - 464 of 685 object meshes carry lightmaps.

---

## 10. How the DATA checks were done (reproducible)

The checks used scratch Python and numpy scripts plus the repo's TS BSR and BMS parsers, run on `work/extracted`. The scripts were deleted after use, per the task rules. Methods:

- **Grid, seams, navmesh:** parse `.m` as in §1.1. Compare shared block and region edges, and the `.nvm` tail (97·97 f32 before the last 180 bytes).
- **Minimap orientation:** build a 96×96 image of the mean tile-texture colour at each cell's corners. Correlate its luminance against the minimap resized to 96² in all 8 dihedral orientations.
- **Tiling periods:**
  - (a) the 2D autocorrelation of the high-passed minimap (Gaussian σ = 4 px), read at lags 3–85 px;
  - (b) render the region at 256² with bilinear corner blending and box-filtered textures, for candidate periods, and correlate the high-pass against the minimap;
  - (c) for codes 3 and 4, the same correlation restricted to pixels whose nearest vertex has that code.
- **Lightmap orientation:** correlate `1 − lightmap` against the Gaussian-blurred density of object positions for 8 orientations, over 46 regions around Jangan.
- **The 96×96 grid:** correlate it against the lightmap downsampled to 96², reading the grid row-major and block-major.
- **Object frame and cell split:** compare the stored y against the terrain interpolated five ways.
- **Yaw:** rasterise BMS triangles (x, z) under 4 rotation and mirror variants.
  - Region overlays: footprint edges drawn in red on the upscaled minimap.
  - Per-object statistic: Sobel-like gradient magnitude of the footprint against the minimap crop.
- **Environment tracks:** sample every profile at 49 times and test near < far for the pairs (G7, G8) and (G10, G11).
- **Brightness:** correlate it against the lightmap, slope, height and the minimap.

---

## 11. Conflicts and open questions

| Question | openroad | OpenSRO | Other | Verdict |
|---|---|---|---|---|
| Tiling code meaning | constant 80 for all codes (playtest) | table 0.25 × [1, .5, .25, 2, 4] (80/160/320/40/20) | — | **80/160/80/40?/20?**: OS right for 0/1, openroad right for 2, codes 3/4 likely OS |
| Blend algorithm | bilinear corner weights | ordered layers with claim/bleed and corner masks | LF: per-vertex weights | OS likely (RE), unverified |
| `.t` 96×96 grid order | row-major 96×96 (implicit) | 36 blocks × 16×16 | SD: 96×96 | **row-major** (data) |
| Lightmap V orientation | "calibration pending" | v = z/1920 | — | **v = z/1920, row 0 = z 0** (data) |
| Lightmap combine | albedo × lightmap (then PBR) | framebuffer × saturate(lm + shadowColor) | LF: lerp multiply | 1× multiply plus the shadow term (OS; data consistent) |
| Brightness byte | unused | unused | WS/LF: vertex light | **not lighting**; meaning unknown |
| Fog tracks | G7/G8 = near/far | G10/G11 = near/far | — | **G10/G11** (data: 100% vs 67%) |
| Graph4 / Graph12 | cloud colour / unknown | scatter colour / cloud alpha | — | OS likely |
| Object yaw sign | +X → (c, s) in file space (after its X-mirror) | +X → (c, s) | LF: sign option | **+X → (cos, sin)** (data) |
| Cell diagonal | — | alternating by parity | — | **uniform (i,j)–(i+1,j+1)** for heights (data); render split unverified |
| Object lightmap combine | not implemented | not implemented | WS: bakes into glTF | **unknown**; texel stats favour 1× |
| Terrain night tint | ambient-ratio hack | none (terrain unlit) | — | unknown, likely none |
| Light direction | from environment/time | fixed (1, 1, 0) | — | OS likely, unverified |

## 12. Wave 12: remastered tiles, Medium shading, edited ground (docs/TERRAIN_TEX.md, docs/WORLD_EDITOR.md)

- **Every one of the 108 terrain tiles is remastered** (TERRAIN_TEX, TEXPIPE §13): Medium draws each tile's 512²
  remaster and the ORMH maps of the 63 hero tiles; High adds normals and the 1024² tier for heroes. Low (Classic) keeps
  the retail tiles (the Low guard). Medium also gains the detail layer and anti-tiling; paving opts out of anti-tiling
  through bit 64 of the layer map's alpha (RENDER §18).
- **The terrain data is unchanged** unless the user edits the map: the World Editor's layers
  (`content/world-edits/<world>/`: height deltas `L = 32768 + round(dh × 256)` per vertex, paint words, grass masks,
  water, placements) are applied by the converter's edits pass after the coast (COAST §6.7), in file units (heights
  × 10), and the lightmap of an edited region is re-baked with object shadows (D18: a swapped tree casts its species'
  LOD1). An empty layer exports byte-identical files.
- **In the editor** the terrain updates in place (`TerrainRenderer.updateRegion`, S-TERR): heights, normals of the
  one-vertex ring, the layer words re-layered exactly as the converter's `blockLayers`, through the same `layerData`
  as a region build (so the paving bit and the surface classes can never disagree), ≤ 1 ms per region.
