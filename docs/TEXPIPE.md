# Texture upscale and PBR pipeline (TEXPIPE)

This spec covers how the retail textures of Jangan and its 307-region fields become higher-resolution PBR material
sets: the inventory, an offline pipeline that runs on the dev PC (AMD RX 9060 XT), the output format, the size
budgets, how the game picks retail or remastered per quality preset, a measured prototype on a test set, what must be
downloaded, and a build plan.

It sits next to two other specs:

- `docs/RENDER.md` owns the renderer: PBR materials, lighting, post, presets and the material classes (§3.3). §3.2
  there defines the **runtime contract**. Fact-check: that contract is the **`sro-remaster` manifest** of
  `apps/game/src/three/remaster.ts`, extended with optional fields (`occlusion`, `height`, `class`, `delit`,
  `uvScale`, `sizes` with `<map>@<size>.<ext>` files). Its keys are `<glb path>#<image>` and, for terrain,
  `world/<world>/tile2d/<tile file stem>`. RENDER.md does **not** define `pbr/index.json`, and it does not say the
  texture lane's layout wins. It names `PbrSet.class` once, in §3.3, without defining it. This spec's
  `pbr/index.json` (§6.2) is therefore a **build-side proposal that conflicts with RENDER.md §3.2** [confirmed by
  reading]. The lead has to pick one: either TP-E writes RENDER's manifest format as the runtime file, or RENDER.md
  adopts this index.
- `docs/SKY.md` and the weather lane own the sky, time of day and rain state. This spec only supplies the per-texture
  data that rain needs: height for puddles, porosity by class, and a roughness base.

This is a design document. No code under `apps/`, `packages/`, `deploy/`, `content/` or any config file was changed.
The prototype scripts and their outputs are in `work/tmp/texpipe/`. Nothing was downloaded, and no retail asset left
this PC.

## Status tags

- **[confirmed]**: measured for this spec (the method is given), or read in the code or `node_modules`.
- **[likely]**: follows from the measurements, the code or the sources, but was not run end to end.
- **[unknown]**: not established. A build lane or the user has to answer it.

**Adversarial fact-check (2026-09-28).** Every Babylon API was checked in
`node_modules/.pnpm/@babylonjs+core@9.28.0`, every hook point in the current code, and the inventory, seam, codec
and download numbers against the scratch data (several were re-measured). Corrections are marked "Fact-check" in
place. The main ones:

- RENDER.md's runtime contract is the `sro-remaster` manifest, not `pbr/index.json`;
- the Meshy upload was approved by the user for named test parts;
- `remaster.ts` reaches actors only;
- WebGPU BC7 needs a device feature request that `engine.ts` does not make;
- `static.ts` already serves `.ktx2`;
- the specmask rule missed the Copper Sword;
- Medium is extra download, not "the same".

---

## 0. Decisions (TL;DR)

1. **How far this gets you.** AI upscaling, de-lighting and PBR maps on the original low-poly meshes give a strong
   remaster: crisp surfaces, real lighting response, and wet streets. The prototype shows this (§7.3). It is not "AAA"
   on its own:
   - the silhouettes stay 2005 (RENDER.md §13);
   - the retail textures are very low resolution for their size in the world, at a median of **22 px per metre of
     surface** [confirmed, §1.4]. A 4× upscale reaches about 90 px/m, while modern games use 256–1024 px/m close up.
   The rest has to come from the renderer's per-class **detail layer** (RENDER.md §3/§6, the detail lane), which adds
   high-frequency normal and roughness detail at a 1–2 m period.
2. **This pipeline runs locally and uploads nothing.** The user's recorded decisions are in
   `work/tmp/w9-user-decisions.md`, read as data. Fact-check: the first draft quoted only that note's first section
   ("Nothing retail is uploaded anywhere"). The same file also has a later section, **"Update: Meshy approved
   (2026-09-28)"**, which says:
   - Meshy Retexture (with `enable_original_uv`) is approved for UV-mapped assets: characters, armour and weapons,
     later NPCs and mobs;
   - uploads are limited to the parts the user approved: the male adventurer body and hair, the male starter heavy
     BA/LA/FA and the starter sword, with a 150-credit test cap;
   - the **local pipeline is for terrain and buildings**.

   So actors are shared with the Meshy lane (`docs/REMASTER.md`). This pipeline's actor outputs are the local
   baseline for an A/B against Meshy. They do not replace it.
   - UV-mapped textures are upscaled from the retail file, so the UV layout stays pixel-exact. A uniform scale never
     moves a UV.
   - Prompt-generated original materials are an option for **tileable terrain only**, and only later (§5).
3. **The upscaler is Real-ESRGAN ncnn-vulkan**, already installed at `work/tools/realesrgan/` (Vulkan, and it works on
   the RX 9060 XT) [confirmed, measured §7.2]. The model is chosen per material class:
   - `realesrgan-x4plus` for natural and photographic surfaces: terrain, stone, walls, roofs, bark, cloth, metal. It
     takes 10.1 s per source megapixel [confirmed]. The whole inventory (91 Mpx) takes about 15–20 min [likely].
   - `realesrgan-x4plus-anime` for flat, painted textures (hair, some cloth). It takes 3.4 s/Mpx [confirmed]. It
     **destroys grass and invents panels on walls** [confirmed by eye, §7.3], so it is never used on natural surfaces.
   - Seamless tiling uses **per-axis wrap padding**: wrap only along the axes the mesh UVs actually repeat (§3.4).
     Measured: wrapping a non-repeating axis raises that edge's seam ratio 1.1–3.5× over the source (wall 5.1 → 11,
     roof 2.2 → 7.8, trunk 2.3 → 2.5) [confirmed, re-measured]. The per-axis variant itself was not run: `ai.ts` pads
     every side with `repeat` [likely].
4. **The PBR maps are derived offline by our own code** (sharp plus TypeScript), and a human reviews them:
   - de-lighting by dividing out low-frequency luminance;
   - a multi-scale height map;
   - Sobel normals from the height, at two scales;
   - AO from height cavities;
   - roughness from the class plus luminance and cavity;
   - metallic from the retail **specular/env-mask alpha** where the converter flagged one (104 material uses).
   The prototype takes 3.5 s per 2K master single-threaded [confirmed]. DeepBump or PBRify models are optional
   upgrades to evaluate after download approval (§3.6, §9).
5. **Shipping format v1 is WebP, with no new runtime dependency:**
   - `albedo` in RGB(A), lossy q90;
   - `normal` as **two greyscale planes (X, Y)**, lossy q90. The mean error is 0.3–1.7° against the master, versus
     0.6–5.2° for lossy RGB WebP, whose 4:2:0 chroma smears X into Z. The 64-px roof is the exception, at 7.8° versus
     13.8°. The planes cost 1.3–1.6× the bytes of RGB [confirmed §7.4, `normcodec.json`];
   - `ao` and `rough` as greyscale planes at half size, and `height` as a greyscale plane at full size.
   The loader packs the planes into the textures that `PbrSet` names (§6.3).
   **KTX2 is the v2 format**: UASTC, transcoded to BC7 by Babylon's wasm transcoder in a worker, then uploaded as
   BC7. It is required for Ultra and for 4× everywhere: without GPU
   compression, the town's 4× object set alone costs about 1.4 GB of VRAM [confirmed arithmetic §6.5]. It needs one
   encoder install plus vendored transcoder files, which the user must approve (§9).
6. **Per preset** (§6.4): Low uses retail textures. Medium uses retail-size remastered albedo (de-lit, cleaned), which is the
   same VRAM as today. It is extra download, though, because the retail albedo embedded in the glbs is still fetched.
   Medium also gets PBR sets for the hero set. High uses 2× sets (1K). Ultra uses 4× sets (2K)
   and **requires KTX2**. Texture tiers change after a reload. The first entry into town costs about +15–25 MB
   (Medium), +60–90 MB (High) and +150–250 MB (Ultra, KTX2) on the wire [likely, §6.6], all HTTP-cached afterwards.
   The remastered sets stream in **after** the retail ones, so a slow link never blocks play.
   **Conflict:** RENDER.md §10's Materials row and its §3.2 caps (Medium ≤ 1024, High ≤ 2048, Ultra full) differ
   from this table. The lead must reconcile them (§6.4).
7. **One index, keyed by the retail texture path.** `SidecarMaterial.texture` writes that path with backslashes
   (`prim\mtrl\item\china\weapon\sword1_2_3.ddj`, confirmed in `work/out/equipment/china/weapon/sword_01.json`), so
   `keyOf` lower-cases it and turns `\` into `/`. Terrain uses `tile2d:<id>`, which conflicts with RENDER.md §3.2's
   `world/<world>/tile2d/<stem>`. The retail path is unique, whereas glTF image names are not. The in-progress `apps/game/src/three/remaster.ts` test switch keys by
   `<glb>#<image name>` because image names collide. It should read this index instead, or map the keys through the
   sidecar (§6.2).
8. **The test set** (§7.1) has 13 textures picked for visible impact (drop one if exactly 12 are wanted):
   - the plaza paving;
   - the two most-seen grass tiles, a dirt tile and a rock tile;
   - the city wall, the palace roof, a town tree trunk and a leaf card;
   - the starter chest armour, the male body/face atlas and hair, and the Copper Sword.
   A second paving tile was also processed. All 14 went through the whole non-AI chain and through the local AI
   upscaler; before/after sheets are in `work/tmp/texpipe/compare_world.png` and `compare_actor.png`.

---

## 1. Inventory: what the player sees

All numbers come from `work/tmp/texpipe/inventory.py` and `density.py` over `work/out`: sidecars, the
`jangan-fields` manifest (307 regions, 6,744 placements, 445 models), the terrain `.bin` texture words and the glb
geometry. Output: `work/tmp/texpipe/inventory.json` and `density.json`. **[confirmed]** unless tagged.

### 1.1 Totals

| Set | Unique textures | Retail texels | Formats (source DDJ) | Alpha use | Sizes |
|---|---:|---:|---|---|---|
| Terrain tiles (`tile2d`) | 104 | 27.3 Mpx | DDJ, decoded to RGBA | opaque | all 512² |
| World models (buildings, nature, props) | 788 (786 with geometry) | 41.4 Mpx | DXT1 550, DXT3 228, A8R8G8B8 6, DXT2 2 | OPAQUE 475, MASK 309, BLEND 4 | mostly 64–256 px per side: 256² ×188, 128² ×130, 128×512 ×107, 128×256 ×99, 256×512 ×65; only 10 at 512², 2 at 1024×256 |
| Characters (`char/`) | 56 | 4.6 Mpx | DXT1 / DXT3 | body and hair MASK | 512×256 bodies, 256×128 hair |
| NPCs | 88 | 7.1 Mpx | | | |
| Mobs | 49 | 6.0 Mpx | | | |
| Equipment (armour, weapons, shields) | 114 | 4.8 Mpx | | | 256², 512² weapons |
| Items (drops) | 14 | 0.2 Mpx | | | |
| **Total in scope** | **1,213** | **91.4 Mpx** | | | |

- **World model classes by path:** bldg 558, nature 161, artifact 63, npc 6. By name: tree 132, wall 96, roof 42,
  stone/rock 33, light/fx 24, grass/plant 21, paving 19, misc 417. RENDER.md §3.3's classifier does the real split.
- **Wrapping:** **520 of the 786** world textures are sampled outside [0, 1] on at least one axis. They repeat, and
  need wrap-aware processing (§3.4).
- **Alpha that is not coverage.** Fact-check, re-counted over the world and actor sidecars: 152 OPAQUE material uses
  have an alpha-capable format (DXT3, DXT2 or A8R8G8B8): 15 in world models and 137 in actors. Their `alphaReason`
  falls into two groups:
  - 104 uses (2 world, 102 actor) carry the generic reason from `gltf/convert.ts` `decideAlpha`: "texture alpha, if
    any, is a specular/env mask". The converter writes this for **every** OPAQUE material without the BMT alpha flag,
    so it is a default label, not a detection. Whether that alpha really varies is [unknown] per texture.
  - 34 uses (28 textures, including the Copper Sword `sword1_2_3`) carry `equipment/materials.ts`'s reason
    "equipment: BMT alpha flag but N% … the alpha is a mask".

  Both groups are the one retail metallic hint the pipeline has (§3.7). The Copper Sword's alpha marks the blade.
- **Town share:** the 3×3 town (regions 167–169 × 96–98) uses **339 world textures, 16.6 Mpx**. That is the resident
  set on login.

### 1.2 Excluded, and why

| Excluded | Why |
|---|---|
| UI, icons, fonts, minimap and world map | Must stay pixel-exact (ASSETS.md §6, UI.md) |
| Terrain lightmaps (307 × 512² DXT1) and object lightmaps (577, 128–256 px) | Baked, low-frequency shadow. AI would only invent edges. RENDER.md §3.4 remaps them as they are. Bilinear is enough. |
| Water frames (30 × 64²) | Replaced by RENDER.md's water plugin; the retail frames are only a tint |
| Sky (`Map/sun`, `skybox`) | SKY.md owns them. Fact-check: SKY.md (its cirrus paragraph and its retail-asset table) asks the texture lane's **local** upscaler for a ×2 of the 30 `sun/moon01..30.ddj` (128², DXT3) and of `cloud1.ddj` (512²). That is a small optional batch (x4plus, then downsample to 2×, no PBR maps) that TP-U can run for SKY. |
| Particle and FX textures | EFFECTS.md; additive sprites gain little from PBR |

### 1.3 Visual importance: what the player sees most

The score is a surface proxy × (placements + 4 × town placements). The proxy is the model's bounding-box half-surface
`xy + yz + xz` from the manifest bounds (`inventory.py`), not the triangle area. For terrain it is vertex coverage. The
tables list the top entries; full lists are in `inventory.json`.

**Terrain tiles by coverage** (share of vertices):

| Tile | Type | Fields | Town 3×3 | Note |
|---|---|---:|---:|---|
| c_grass_hmfld_01 | Grass | **18.3%** | 4.1% | the fields' ground |
| c_grass_fld_03 | Grass | 11.1% | **9.6%** | |
| c_grass_hmfld_03 | Grass | 5.0% | **14.1%** | |
| c_marble_jang_09 | Stone | 0.3% | **8.0%** | Jangan plaza paving |
| c_marble_jang_04 | Stone | 0.3% | **7.4%** | plaza paving |
| c_dust_swmp_06 | Water type | 7.2% | 0 | swamp ground |
| c_dust_fld_08 / c_dust_fld_01 | Dirt | 0.3% / 2.8% | 6.5% / 6.4% | town roads |
| c_stone_jinfild_01 | Dirt | 6.1% | 0.2% | |
| c_dust_fld_06 | Dirt | 5.7% | 2.6% | |
| c_marble_jang_02 | Stone | 0.2% | 5.5% | plaza |
| c_grass_fld_08 / fld_04 | Grass | 3.2% / 2.0% | 5.4% / 3.7% | |
| c_stone_hmfld_01, wc_dust_don_07 | Stone, Dirt | 4.4%, 4.3% | 0 | field rock and dirt |
| c_dust_hmfld_03 | Dirt | 0.8% | 4.7% | the 16th hero tile. The first draft's table listed only 15 (fact-check, from `inventory.json`) |

**These 16 tiles cover 78% of the town's terrain vertices and 72% of the fields'** [confirmed]. They are the terrain
hero set.

**World models.** The largest town structures are the three city walls: `cj_s` (556 m), `cj_e` and `cj_w` (440 m
each). All three use one 9-texture set (`jangan_enter/cj_wall01..05`, `cj_roof`, `cj_door`, `cj_stair`, `cj_alpha`).
Next come the palace walls `cj_pal_dam_*` (4 × 193 m, with `cj_pal_dam`, `cj_pal_roof`), the monster stadium, the
gate and the temple. By placements × area, the trees dominate the fields:

- `tre_pine08_02/03` (131 placements);
- `tre_pine07_01/02` (136);
- `tre_bam04_01` (91);
- `tre_tree02_01..03` (84);
- `stone_clif01` (90);
- `tre_bank_pilla` (62, 32 of them in town);
- `tre_willow03_*` (52);
- `tre_tree09_01` (53).

**Actors.** These are always on screen and seen close up:

- the 27 player character body and hair atlases (`char/`);
- the starter outfits (`clothes_01_*`, male and female);
- the starter weapons (`sword_01`, `blade_01`, `spear_01`, `bow_01`, `tblade_01`, degree 1);
- then the mobs of levels 1–20 and the town NPCs.

**Hero set v1 (about 120 textures).** It is the union of:

- the 16 terrain tiles above;
- the city-wall, palace and gate sets (about 30 textures);
- the 8 tree species (about 20);
- `stone_clif01`;
- the 27 character atlases;
- the starter outfits and weapons (about 20).

It is about 12% of the textures and, by the numbers above, well over half of what is on screen. The hero set gets full
PBR sets on High. The rest gets albedo plus class defaults (§6.4).

### 1.4 Texel density: why upscaling alone does not reach "modern"

`density.py` sums the triangle world area and the UV area in texels per texture, over every world model. Node
transforms are ignored; world models are authored at scale 1 [likely].

| | px per metre |
|---|---:|
| World textures, per texture: p10 / p50 / p90 | 20 / 42 / 129 |
| **World textures, by covered surface: p10 / p50 / p90** | **8 / 22 / 42** |
| City wall `cj_wall01` (256×512) | 21.8 |
| Palace roof `cj_pal_roof` (64×256) | 35.2 |
| Tree trunk `tre_bank_pilla` | 31.5 |
| Cliff `stone_clif01` (256×512) | 8.1 |
| Terrain tiles, code 0/2 (512 px per 80 units = 8 m) | 64 |
| Terrain tiles, code 1 (160 units) | 32 |

- A 4× upscale brings the median surface to about 90 px/m and terrain to 256 px/m.
- Modern games target about 512 px/m on hero surfaces near the camera.
- **The gap is closed by detail maps, not by more upscaling.** Detail maps are per-class tileable normal and roughness
  (and optionally albedo modulation) at a 1–2 m period, blended in near the camera. They belong to RENDER.md §3
  (terrain "detail") and the detail lane. This spec only tags every set with its class, which is what selects the
  detail map.

---

## 2. Pipeline overview

```
work/out (lossless PNG decoded from the DDJ)
  │ 1 extract    one source per unique retail texture path, content hash; tiles from world/*/tiles
  │ 2 classify   RENDER.md §3.3 class, tileable axes (from UVs), alpha kind (cutout/blend/specmask/none), importance
  │ 3 clean      (optional) 1x DXT de-blocking model; only where it measurably helps (§3.3)
  │ 4 upscale    Real-ESRGAN ncnn-vulkan, model per class, per-axis wrap padding, alpha separately, AI/Lanczos mix
  │ 5 de-light   remove painted low-frequency light; atlases per UV island
  │ 6 height     multi-scale band sum of de-lit luminance
  │ 7 normal     two-scale Sobel of height, class strength
  │ 8 AO/R/M     cavity AO; roughness = class + luminance + cavity; metallic = specmask alpha or class
  │ 9 review     local HTML contact sheet; per-texture status + parameter overrides (committed JSON)
  │10 encode     tiers (retail size, 1K, 2K), WebP planes (v1) or KTX2 (v2); pbr/index.json
  ▼
work/out/pbr/**  (copied unchanged to work/out-opt by optimize-out; served under /out-opt/pbr/)
```

- Masters (16-bit PNG albedo, height, normal, ORMH at the 4× size, capped at 2048) live in `work/texpipe/master/`.
  They are never shipped and never committed; `work/` is git-ignored.
- **Cache.** Every stage is keyed by the SHA-1 of its inputs and parameters, so a parameter change for one texture
  re-runs only that texture.

---

## 3. Stages

### 3.1 Extract [confirmed method]

- **Model textures:** the glb images in `work/out/**.glb`. The PNG there is the lossless DXT decode; the glTF image
  `name` is the DDJ file stem. The sidecar `materials[].texture` gives the full retail path, which is the key.
  - The same DDJ used by several glbs is extracted **once**. `clothes_01_aa` exists as both `man_item/…` and
    `woman_item/…`. Those are different paths and different sets.
- **Terrain tiles:** `work/out/world/jangan-fields/tiles/<stem>.png`. The key is `tile2d:<id>` (manifest
  `tiles[].id`).
- Never read from `work/out-opt`. Its WebP is lossy and would compound artifacts.

### 3.2 Classify

- **Class:** use RENDER.md §3.3 `classify(key)` (`packages/world-render/src/pbr/classes.ts`, owned by the RND lanes)
  plus `content/render/material-overrides.json`. TEXPIPE writes the resulting `class` into every set.
- **Tileable axes:** for each texture, take the TEXCOORD_0 range over every primitive that uses it (the method of
  `density.py`).
  - `wrapU = min < −0.01 || max > 1.01` on u, and likewise for `wrapV`. Terrain tiles are `wrapU = wrapV = true`.
  - Measured: the wall, roof and trunk textures repeat in U only. Their sources have a V seam ratio of 2.2–5.1 against
    0.8–1.3 in U [confirmed]. Wrapping them in V as well raised the V edge ratio to 2.5–11: trunk 2.5, roof 7.8 and
    wall 11 [confirmed, re-measured from `ai/out/*.png`]. The seam ratio is only a quality measure on axes that wrap.
    On a clamped axis it only shows that the edges were altered.
- **Alpha kind:** from the sidecar.
  - `alphaMode` MASK → `cutout`; BLEND → `blend`.
  - OPAQUE with a DXT2/3/5 or ARGB `textureFormat`, whose alpha actually varies (source alpha min < 250), and whose
    `alphaReason` contains "specular/env mask" **or** "the alpha is a mask" → `specmask`. Fact-check: the first
    draft's rule, `alphaReason` containing "spec", misses the Copper Sword. Its reason comes from
    `equipment/materials.ts` and has no "spec" in it (§1.1).
  - Otherwise `none`.
- **UV islands** (atlases, meaning neither axis wraps): rasterise the TEXCOORD_0 triangles into an island-id mask at the
  output size. De-lighting, height normalisation and normals are computed per island, and colours are dilated into
  the gutters after every stage (8 px at 2K). Otherwise mips bleed island borders into each other. This is the part
  that makes character and armour textures "fit the UVs" at every mip.

### 3.3 Clean (optional)

The retail textures are DXT1/DXT3: 4×4 blocks with 2-colour endpoints. The AI model reads block edges as detail and
sharpens them. The plaza marble came out "embossed" (`compare_world.png`, row 1) [confirmed by eye].

- Candidate: a 1× de-blocking ESRGAN model (the OpenModelDB "BC1/DXT smoothing" family) [unknown: exact model, licence
  and quality; §9 item 4].
- Cheaper fallback, always available: blend the AI result with the Lanczos result, `mix = 0.7` for natural classes. It
  is tunable per texture in the review.

### 3.4 Upscale

**Tools evaluated:**

| Tool | Status here | Runtime needed | Licence | Speed on RX 9060 XT | Game-texture quality | Tileable seams | Alpha |
|---|---|---|---|---|---|---|---|
| **Real-ESRGAN ncnn-vulkan** 20220424 (`realesrgan-x4plus`, `x4plus-anime`, `animevideov3`) | **installed** at `work/tools/realesrgan/`, runs on Vulkan [confirmed] | none (portable exe) | exe MIT (ncnn port); Real-ESRGAN models BSD-3-Clause [likely] | x4plus **10.1 s/Mpx**, anime 3.4 s/Mpx; about 2 s start-up per call; use directory batch mode [confirmed] | x4plus: good on grass, dirt, brick, roof tiles, bark; over-sharpens DXT noise on dark marble. Anime: good on hair; bad on grass and walls [confirmed by eye] | handled by our wrap padding (below) | model on RGB only; alpha upscaled separately (below) |
| Upscayl (GUI + `upscayl-bin`, a Real-ESRGAN ncnn fork) | not installed | Electron app | AGPL-3.0 app; models carry their own licences | same engine as above | Its value is the **ncnn model zoo** (4x-UltraSharp, Remacri, Ultramix), whose files load in the exe we already have (`-m <dir> -n <name>`) [likely] | ours | ours |
| chaiNNer (node-graph GUI) | not installed | Python backends (ncnn / ONNX / PyTorch) that it installs itself, 1 GB+ with PyTorch | GPL-3.0 | ncnn and ONNX backends are about as fast as above. PyTorch on an AMD GPU under Windows needs torch-directml or AMD's ROCm-for-Windows builds; whether chaiNNer can use either is [unknown] | any OpenModelDB model; good for the **user** to try models by hand. Not needed for batch runs | manual | manual |
| onnxruntime-directml + ESRGAN-family ONNX (4x-UltraSharp, 4x-Nomos8kSC, SPAN) | Python 3.12 present, package absent [confirmed] | `pip install onnxruntime-directml` | MIT (runtime); models: UltraSharp CC BY-NC-SA 4.0, Nomos8kSC CC BY 4.0 [likely] | RRDB models about 1–2× the ncnn time; SPAN about 5× faster; DAT/HAT transformer models 10–50× slower [likely] | the widest model choice; also runs DeepBump (§3.6) and PBRify models | ours | ours |

**Model per class** [our rule, from the prototype]:

| Class | Model | AI/Lanczos mix |
|---|---|---:|
| ground_grass, ground_soil, stone, roof_tile, wood, foliage (bark), cloth | x4plus | 0.8 (stone and marble 0.6 until §3.3 exists) |
| hair, skin (faces are painted) | x4plus-anime for hair; x4plus for skin at mix 0.5 | |
| metal | x4plus | 0.7 |
| Anything the review rejects | Lanczos 4× | 0 |

UltraSharp and Nomos are candidates to A/B against x4plus on the test set after download approval (§9).

**Rules:**

1. **Scale.** Always ×4 from the retail size, capped at 2048 on the long side. Lower tiers are downsampled from this
   master (Lanczos3), never upscaled separately.
2. **Per-axis wrap padding.** Pad P = min(32, w/4, h/4) px:
   - `repeat` on the wrapping axes;
   - `copy` (edge clamp) on the others;
   - upscale, then crop 4P.
   Measured with Lanczos on the 9 tileable test textures, across the U seam only: the seam ratio at the image edge
   versus an interior column is **0.85–1.52 padded against 2.75–5.17 unpadded** [confirmed, §7.2]. The prototype
   padded every side (8 px `repeat` in `proto.ts`, P px `repeat` in `ai.ts`), so the per-axis `copy` rule is
   [likely], not measured. With the AI model and wrap padding, the terrain tiles come out at 1.0–1.6 in U and V, and
   T6 at 2.4 in U [confirmed, re-measured].
   - The retail tiles are themselves only 0.88–1.51 on their wrap axes (re-measured). So on real data a test must
     compare against the source ratio (for example ≤ 1.2 × the source), not against an absolute 1.2.
3. **Alpha.**
   - The model gets RGB only, after an **alpha bleed**: transparent texels take the colour of the nearest opaque ones
     (blurred, premultiplied, at 3 scales). Otherwise the model sharpens the matte colour into the edges; the leaf
     preview in `compare_actor.png` shows the red fringe that remains without it.
   - Alpha itself is upscaled with Lanczos3.
   - For `cutout`, re-threshold with a 2 px ramp around 0.5 and compute **coverage-preserving mips** (scale alpha per
     mip so that the fraction above the cutoff stays constant). KTX2 (v2) ships those mips. On WebP (v1), the runtime
     generates plain mips and foliage thins at distance. A mitigation is `engine.setAlphaToCoverage(true)`
     [confirmed: `Engines/Extensions/engine.alphaToCoverage` for WebGL and `Engines/WebGPU/Extensions/…` for WebGPU,
     both registered by the root `@babylonjs/core` import]. Limits of that route:
     - It is **engine-global state**, not a material property. The renderer must switch it on and off around the
       foliage and hair draws, for example from `material.onBindObservable` or in a dedicated rendering group.
     - It does nothing without MSAA. WebGPU sets `alphaToCoverageEnabled` only when `sampleCount > 1`
       (`webgpuCacheRenderPipeline.js` 612). Under RENDER.md §10 that leaves only Low (canvas MSAA) and High (MSAA ×4
       on the HDR target); Medium (FXAA) and Ultra (TAA) get no benefit.

     The visual effect is [likely].
   - For `specmask`, alpha stays a mask (Lanczos3). It feeds metallic (§3.7) and is not shipped as alpha.
4. **Atlases** (no wrap). No padding; `copy` edges; islands dilated after upscaling (§3.2).
5. **Throughput** [confirmed on 14 textures, 2.34 source Mpx]:
   - x4plus: 23.6 s in one directory run, 2.3–5.0 s per single-file call;
   - the whole inventory, 91 Mpx plus about 25% padding: **about 20 min** [likely] (91.4 × 10.1 s = 15.4 min before
     padding);
   - the GPU is otherwise idle, so it can run while the CPU stages run in parallel.

### 3.4a Detail (DT-2, local SDXL; 2026-09-29)

The user approved local SDXL as the pipeline's detail step (`work/tmp/w9-user-decisions.md`, bake-off decisions):
terrain tiles first, then bodies, armour and weapons. The method is the bake-off's (`work/tmp/detail/bakeoff/REPORT.md`),
ported into `packages/texpipe/src/detail/` (`pnpm texpipe detail`, or `pnpm texpipe run --detail`).

- **Route per texture** (`content/texpipe/overrides.json`): `"detail": "sdxl" | "gan" | "retail"` on a set, or
  `"classes": { "<material class>": { "detail": … } }` for a whole class; the set wins, the default is `gan`.
  - `gan`: TP-U's Real-ESRGAN master, as before;
  - `sdxl`: the detail stage's result on top of the GAN master;
  - `retail`: no AI at all, a Lanczos3 ×4 of the retail pixels, for art the models misread.
  TP-P reads the chosen albedo exactly like the GAN master (same size, same alpha, same cache rule). An `sdxl` route
  without a passing, current result falls back to the GAN master and says so. The set's `detail` field in
  `pbr/index.json` records the route that was used.
- **The job** (`detail/sdxl_job.py`, a subprocess per attempt; the stage, its cache and its index are in texpipe):
  SDXL base + xinsir ControlNet-Tile through UltimateSDUpscale on the **GAN master** (1024 px tiles, 64 px padding,
  tiled VAE decode), with the short edge raised to ≥ 1024 px while sampling (SDXL at 256–512 px invents mush), then
  back to the master size.
  - **Wrap axes** (terrain, and walls or roofs that repeat along one axis): the half-offset seam repair of
    `sdxl_terrain.py` on each wrap axis (roll by half a period, pre-fill a band around the old edges from the seamless
    GAN master, regenerate detail inside the band only), then a **colour lock**: everything coarser than the profile's
    radius comes from a wrap-aware Lanczos3 ×4 of the source, so the splat blend and the source colours survive.
  - **Atlases** (no wrap axis): the **UV-safe composite**: SDXL only inside the UV islands of every glb that uses the
    texture (dilated by ~1 source texel), the gutter is the GAN master bit for bit, and a colour fix at the profile's
    radius. Bodies get a second pass over the face islands at a low denoise.
- **Profiles** (`detail/profiles.ts`, the bake-off's calibration):

  | Profile | Textures | Denoise | ControlNet | Sampler | Colour fix | Notes |
  |---|---|---:|---:|---|---:|---|
  | terrain | tiles | 0.5 (seam 0.55) | 0.8 | dpmpp_2m, cfg 6, 16 steps | 2 texels | ~4 min per 2K tile |
  | world | walls, roofs, gates, paving, bark | 0.4 (seam 0.45) | 0.8 | dpmpp_2m | 1 texel | not in the bake-off |
  | body | `*_body` | 0.45, face 0.18 | 0.7 | dpmpp_2m_sde, cfg 6, 20 steps | 1 texel | face = the `*_face` mesh's islands in u ≥ 0.45 (the bake-off rule; the body meshes also have islands there) |
  | hair | `*_hair` | 0.5 | 0.7 | dpmpp_2m_sde | 1 texel | |
  | equipment | armour, leather, cloth, weapons | 0.6 | 0.6 | dpmpp_2m_sde, cfg 7 | 0.5 texel | |

  `overrides.json` `sdxl: { profile, prompt, denoise, seamDenoise, cn, cfg, steps, sampler, cfix, seed, face }`
  changes one texture.
- **The gate** (uvsafe-style; `detail/profiles.ts` `judge`): the result downsampled to the source size vs the source,
  inside the islands (cut-out texels excluded):
  - atlases: PSNR ≥ 28 dB **and** ≥ 3 dB above the same result shifted by one source texel; median block shift ≤ 0.1
    texel (p95 ≤ 0.25, no mean drift); zero gutter texels changed; the face islands ≥ 30 dB;
  - tiles have no islands to misalign, and the GAN master itself scores 24.8–27.3 dB on the grass tiles, so their
    floor is min(28, the GAN master's PSNR − 2), and they only have to beat their 1-texel-shifted copy (a smooth soil
    tile scores nearly the same shifted: c_dust_fld_01 35.5 vs 34.7 dB); plus the block shift test, the mean colour
    within 3 levels, and every wrap axis' seam ratio ≤ max(1.5, 1.35 × the source's).
  - **Re-roll**, as the report prescribes: an aligned result that fails only on fidelity is first re-composited with a
    0.5-texel colour fix (no GPU); then up to two new generations (seed + 1, denoise − 0.1 each). After three
    generations the texture keeps its GAN master (`pass: false` in `work/texpipe/detail/index.json`).
- **Cache:** `work/texpipe/cache/detail/<sha1>/`, keyed by the source pixels, the GAN master's hash, the mode, the wrap
  axes, the UV triangles, the parameters, the job script and `DETAIL_VERSION`; one folder per attempt. A new GAN
  master makes the result stale (TP-P then uses the GAN master until the stage runs again).
- **First runs (2026-09-29, B1 hero set):** 15 of the 16 hero tiles pass (14 use SDXL; `c_dust_fld_06` passed but
  looks closest to retail on the `retail` route; `wc_dust_don_07` keeps its GAN master: its mean colour moved 3.0–3.3
  levels), and 22 of the 24 world textures that finished (walls, roofs, gates, paving, bark, the cliff; `cj_pal_floor` and
  `cj_wall05` fail on the joint their art has on the tile edge, which the seam repair redraws; `cj_stair` was
  interrupted by the watchdog three times and is left for the next batch). At the terrain profile's 2-texel colour lock most tiles miss the fidelity floor, and the
  prescribed 0.5-texel re-composite passes; the detail SDXL then adds is sub-texel, which reads as crisper, more even
  grass and soil, not new structure. A 2K tile takes 3.5–5 min on this PC, 6–12 min when the watchdog interrupts.
  The look problems B1 found (paving turned to rocks, dark blotches on soil) came mostly from the derived relief, not
  from the albedo: their picks use `pbr.normalScale 0.35, aoScale 0.4` (overrides.json).
- **GPU safety:** the stage takes `work/tools/gpu.lock` for the batch (polling every 2 minutes while another workflow
  holds it), starts ComfyUI **only** with `work/tools/comfyui/start_comfyui.sh` (127.0.0.1:8188, VRAM cap, no mmap,
  fp8, tiled decode, watchdog), waits for ≥ 1.5 GB of available RAM before a job, restarts the server clean after a
  watchdog interrupt or an out-of-memory (a `--gpu-only` server that unloaded its models OOMs on every later tile),
  and stops it with `stop_comfyui.sh` at the end. Before the batch (and again after taking the lock) it waits until
  the other processes hold ≤ 5 GB of VRAM and ≥ 3 GB of RAM is available (`SRO_DETAIL_MAX_OTHER_VRAM_GB`,
  `SRO_DETAIL_MIN_START_RAM_GB`): on 2026-09-29 a game preview held 7–9 GB and ComfyUI spilled 1.6 GB into shared
  memory within seconds (the watchdog interrupted it). The environment knobs of `SETUP.md`
  (`SRO_VRAM_FRACTION` etc.) pass through.

### 3.5 De-light

Retail textures have painted light: highlights on roof-tile tops, dark grout, shaded folds. Under PBR lighting that
double-shades (RENDER.md §16).

- **Algorithm** [prototype, confirmed runs]:
  - `L` = linear luminance; `low = blur(L, σ = w/16)`, wrap-aware on the wrapping axes, per island on atlases;
  - `albedo_lin *= (mean(L) / low)^k`, with k per class: ground 0.8, stone and wall 0.6–0.7, roof and bark 0.5,
    cloth, skin, hair and metal 0.2–0.3.
  - This flattens large painted gradients and keeps the detail. It does **not** remove small painted shadows. Those
    become height (§3.6) and the lighting re-creates them. They stay in the albedo too, so there is a residual double
    AO.
- **Set flag:** `delit: true` when k ≥ 0.5. RENDER.md uses it (its §3.2 field table: direct light 0.8 on non-delit
  sets) to lower the direct light on sets that were not de-lit.
- **Risk:** strong de-lighting on painted atlases washes them out. The starter chest was already near white
  (`compare_actor.png`, row 4). So k is low on actors, and the review can set k = 0.
- **AI de-lighting** (for example material-capture research models) was not evaluated [unknown]. Not in v1.

### 3.6 Height

- `Ld = sqrt(luminance(de-lit))`, perceptual.
- With `s = w/512`: `H = 0.25(b1 − b4) + 0.35(b2 − b4) + 0.4(b3 − b4)`, where `bk = blur(Ld, {1, 4, 12, 48}·s)`,
  normalised by the 2nd and 98th percentiles.
- Removing the lowest band (`b4`) keeps leftover lighting gradients out of the height.
- `cutout` textures get height 0 where alpha < 0.5.
- **Quality:** good on grout, brick courses, cobbles, roof tiles and bark. It inverts where a light-coloured feature is
  recessed (white mortar, pale cracks). The review has an `invertHeight` override.
- **Alternative after approval:** DeepBump (colour → normals, then normals → height; GPL-3.0; ONNX) [likely better
  on photographic sources, unknown on painted ones]. Run it via onnxruntime-directml, A/B it in the review, and keep
  the better map per texture.

### 3.7 Normal, AO, roughness, metallic

- **Normal:**
  - two Sobel scales, `n = normalize(−(0.5·∇H + 1.5·∇blur(H, 2s))·k, 1)`, with `k = strength_class · 4 · 512/w`, so the
    slope per texture-space unit does not depend on resolution;
  - tangent space, **glTF/OpenGL convention (+Y up)**, which RENDER.md §3.2 and `remaster.ts` also use;
  - class strengths: stone and paving 3, wall 3.5, rock and bark 4, ground 2, cloth 1.5, skin 1, hair 2, foliage 1.5.
    These are our numbers, tuned by eye; RENDER.md's class `normalStrength` scales them again at runtime.
- **AO:** `cav = max(0, blur(H, 6s) − H) + 0.5·max(0, blur(H, 24s) − H)`, and `ao = 1 − 2.2·aoStrength·cav`.
- **Roughness:** `class.rough + class.var·(6·cav − (luma − 0.5))`, clamped to [0.05, 1]. Cavities read rougher and
  bright flat texels slightly smoother. The base values should equal RENDER.md §3.3's class roughness; the prototype
  used near values.
- **Metallic:**
  - `specmask` textures (up to 138 material uses, 104 generic plus 34 equipment, §1.1; the Copper Sword blade, for
    example) get `metallic = alpha` and
    `roughness −= 0.3·alpha`;
  - the `metal` class with no mask gets 0.9 (RENDER.md);
  - everything else gets 0.
- **Height** ships as its own plane: puddles (RENDER.md §9.3), terrain height-blend and Ultra parallax.
- **Porosity** for rain is not a texture. It is a class value (RENDER.md §3.3), and the set can override it (§6.2).

### 3.8 Review (local, human)

`pnpm texpipe review` (lane TP-E) writes `work/texpipe/review/index.html`, a local file that is never published:

- one card per texture: retail | AI | albedo | normal | ORM | height | lit | wet previews, plus a lit sphere/plane;
- buttons that write `content/texpipe/overrides.json`. That file is committed and holds only paths and numbers, no
  art:

```jsonc
{ "format": "sro-texpipe-overrides", "version": 1,
  "textures": {
    "prim/mtrl/bldg/china/jangan_enter/cj_wall01.ddj": { "status": "ok", "normalStrength": 2.5, "aiMix": 0.7 },
    "tile2d:39": { "status": "ok", "invertHeight": false, "delight": 0.6 },
    "prim/mtrl/char/china/man/chinaman_adventurer_hair.ddj": { "status": "ok", "model": "realesrgan-x4plus-anime" },
    "prim/mtrl/nature/common/tree/tre_tree02_01.ddj": { "status": "albedo-only" }
  } }
```

- **Status values:**
  - `auto` (not reviewed yet; shipped on High and Ultra only for the hero set);
  - `ok`;
  - `albedo-only` (drop the derived normal and ORM);
  - `retail` (reject the remaster);
  - `replaced` (a generated replacement, §5).

---

## 4. Test set and the review loop

The test set is §7.1. The loop: run the pipeline on the set, review the sheets, then show it **in game**.

Fact-check on the in-game side: the existing `remaster.ts` test switch only reaches **actor** glbs.
`apps/game/src/three/models.ts` `ModelLibrary` calls `remasterFor(scene).track(container, glb)`, and nothing in
`packages/world-render` calls it [confirmed by grep]. So:

- spot 4 (the character screen) works with `?remaster=1` as soon as TP-E writes the view (§6.2 b);
- spots 1–3 (plaza terrain, the wall, trees) need RND-M's object loader and RND-T's terrain arrays. Until those
  land, spots 1–3 can only be shown in the review sheets.

Take before/after screenshots at fixed spots:

1. the plaza paving from the default orbit camera;
2. the south gate and city wall;
3. a tree cluster outside the gate;
4. the character-creation screen (starter outfit, body, hair, sword);
5. the same four spots in rain (wetness 1, puddles 1).

Only then does the whole inventory run.

---

## 5. External generative services (Higgsfield, Meshy): what they could do, and the legal/privacy question

**What they could add:**

- **Higgsfield (images).** Prompt-generated **original** tileable materials, for example "Tang-dynasty grey fired
  brick, weathered, seamless, orthographic, even lighting", or "loess dirt road with cart ruts". These could replace
  terrain tiles and wall textures at 2K, then go through §3.5–3.7 for the PBR maps.
  - They must be made seamless: our per-axis wrap blend (offset by half, feather the cross seam) or the generator's
    own tiling option.
  - They must be **colour-matched to the retail tile**: a histogram match of the albedo, so the world and minimap
    palette stays SRO.
  - **Retail textures and UV-mapped textures cannot be replaced this way.** Their layout must match the UVs, which
    generated art will not.
- **Meshy AI (3D):**
  - Text-to-3D and image-to-3D create **new geometry** from a prompt or a concept image: trees, bushes, lanterns,
    carts, crates, later hero buildings. That is the real route to "AAA" silhouettes (RENDER.md §13). Meshy returns
    PBR maps with the mesh, and the output would enter the pipeline at §3.10 (encode) as a replacement asset.
  - Meshy's texture generation *on an existing mesh* needs the retail mesh uploaded. The user approved that only for
    the named test parts (next item).
- **Meshy Retexture on the original UVs is built by another lane** (`docs/REMASTER.md`,
  `packages/convert/src/remaster/meshy.ts`, with `enable_original_uv: true` and a UV check). It uploads the part's glb
  (geometry and UV0, as a base64 data URI) and, for the multiview variant, renders of the textured part. **That is an
  upload of retail meshes and textures.**
  - Fact-check: the first draft called this a conflict with the decision note. It is not. The note's own section
    "Update: Meshy approved (2026-09-28)" approves exactly this for named parts: the male adventurer body and hair,
    the male starter heavy BA/LA/FA and the starter sword, within a 150-credit test cap. It also says "Uploads: only
    the models the user approved … Nothing else", and assigns terrain and buildings to the local pipeline
    [confirmed by reading the note].
  - What stays open is only the scope beyond those test parts, and that is the user's call.
  - Meshy outputs enter this pipeline at the encode stage as sets with `status: "replaced"` and `source: "meshy"` for
    the same retail key, so a local and a Meshy remaster of one texture can be A/B'd in the review.
- **The Higgsfield connector in this environment** also offers `upscale_image`. Using it on retail textures would
  upload them. **Do not.** It is listed here only so nobody does it by accident.

**Legal and privacy** (the user decides; this is not legal advice):

- The retail art is Joymax's copyright. The project is a private, non-commercial fan remake for about 20 friends.
  Local processing keeps the art on the user's PCs.
- Uploading retail textures or meshes to a third-party service copies them to that company. Terms of service commonly
  grant the service a licence over uploaded inputs, possibly including model training [likely; check each service's
  current terms]. It would also make the project's use of retail art visible outside the friend group.
- Prompt-only generation uploads nothing retail. The **output licence** depends on the plan:
  - Meshy's paid plans grant the user the outputs, and free-tier outputs are CC BY 4.0 [likely; verify];
  - Higgsfield's output rights [unknown; verify].
  - Keep the prompts, seeds and plan details with each generated asset: `content/texpipe/generated.json` holds
    prompt, service, date and plan. That is our record.
- **Recommendation:**
  - v1 is retail-derived and local only, for terrain and buildings as recorded. Actors are local too, as the A/B
    baseline next to the approved Meshy test parts;
  - prompt-generated replacements only for tileable terrain and wall materials, after the local remaster is judged;
  - Meshy for new props and trees, from prompts or the user's own concept images. Meshy Retexture of retail parts
    only within the user's approved list (REMASTER.md).
  - Every generated asset is a **new asset with its own key** (`gen:<name>`), mapped to the retail key it replaces in
    `overrides.json` (`status: "replaced", "replacement": "gen:brick_tang_01"`). This makes it removable in one edit.

---

## 6. Output format, manifest, budgets

### 6.1 File layout

```
work/out/pbr/index.json                                   the index (§6.2), also index.json.br via optimize-out
work/out/pbr/<keypath>/<map>@<tier>.webp                  v1
work/out/pbr/<keypath>/<map>@<tier>.ktx2                  v2 (KTX2; .ktx2 is git-ignored already)
   <keypath>  = the key with ':' → '/', lower case, '.ddj' removed:
                prim/mtrl/bldg/china/jangan_enter/cj_wall01, tile2d/39
   <map>      = albedo | nx | ny | ao | rough | metal | height          (v1 planes)
                albedo | normal | orm | height                          (v2 KTX2; orm = R AO, G rough, B metal)
   <tier>     = the long edge in pixels: the retail size, the '2x' tier min(2 × retail, 1024), 1024, 2048
                (only those ≤ the 4× master; the master's own size when it is under 2048)
```

- `optimize-out` copies `pbr/` unchanged. Its rule "everything else copied unchanged" already covers it; it only
  re-encodes `world/**.png` [confirmed, ASSETS.md §2, `optimize/run.ts` header]. **No optimizer change is needed.**
  Its compression set is an allow-list (`optimize/measure.ts` 94: `.glb .json .bin .js .gltf .txt .ttf`), so `.ktx2`
  and `.webp` are never precompressed already [confirmed].
- **Serving: no server change is needed.** `apps/server/src/static.ts` already maps `.ktx2 → image/ktx2` (line 24)
  and `.webp`. Its `COMPRESSIBLE` (line 41) is also an allow-list without `.ktx2` [confirmed; the first draft said
  the MIME type was missing].

### 6.2 `pbr/index.json`: this lane's build index (proposal; RENDER.md §3.2 names a different runtime file)

Fact-check: RENDER.md §3.2 does not define `PbrSet` or `pbr/index.json`. Its runtime contract is the extended
`sro-remaster` manifest (see the header of this doc). Read "RENDER.md §3.2, unchanged fields" below as "fields
equivalent to RENDER's optional manifest fields". Two items are open for the lead:

- RENDER names the per-tier files `<map>@<size>.<ext>` beside a full file, and lists them in `sizes`;
- RENDER keys tiles `world/<world>/tile2d/<stem>`, not `tile2d:<id>`.

```ts
interface PbrIndex {
  format: 'sro-pbr'; version: 1
  pipeline: { rev: string; upscaler: string; createdAt: string }  // provenance
  sets: Record<string, PbrSet>                                      // key -> set
}
interface PbrSet {                          // RENDER.md §3.2, unchanged fields first
  key: string                               // 'prim/mtrl/.../x.ddj' | 'tile2d:<id>' | 'gen:<name>'
  size: [number, number]                    // albedo size of the largest tier
  class: MaterialClass                      // RENDER.md §3.3, resolved (with overrides)
  albedo?: string; normal?: string; orm?: string; height?: string; emissive?: string   // v2 (KTX2) single files
  delit?: boolean
  uvScale?: number                          // tiles: retail periods covered by one texture (1; replacements may be 2)
  // --- TEXPIPE additions (additive; RENDER.md's reader ignores what it does not know) ---
  tiers: Record<string, PbrTier>           // '<long edge>' -> files of that tier ('256', '1024', '2048')
  alpha: 'none' | 'cutout' | 'blend' | 'specmask'
  wrap: [boolean, boolean]                  // U, V
  status: 'auto' | 'ok' | 'albedo-only' | 'retail' | 'replaced'
  hero: boolean                             // hero set (§1.3): gets full maps on High
  params?: { normalStrength?: number; roughness?: number; porosity?: number; metallic?: number }  // review overrides
  replaces?: string                         // gen: sets only
  source?: 'local' | 'meshy' | 'generated'  // provenance of the maps (local = this pipeline)
  detail?: 'sdxl' | 'gan' | 'retail'        // DT-2: the albedo route the maps came from (§3.4a; absent = gan)
  tier2x?: string                           // the key in `tiers` of the '2x' tier (§6.4); optional, version stays 1
}
interface PbrTier {
  size: [number, number]
  albedo: string                            // RGB(A) sRGB, lossy q90, alpha lossless (cutout/blend), else no alpha
  nx?: string; ny?: string                  // v1 normal planes, linear, 128 = 0; z = sqrt(1 - x² - y²)
  ao?: string; rough?: string; metal?: string   // v1 planes, linear; half the tier size
  height?: string                           // v1 plane, linear, full tier size
  bytes: number                             // sum of the tier's files, for the budget HUD
}
```

- **Keys** are unique per content. The same retail path is used by every glb that shares it.
- **Joining:** `SidecarMaterialLite` (`packages/world-render/src/materials.ts`, today `name`, `flags`, `diffuse`,
  `ambient` only) gains `texture` (RENDER.md RND-M), which is already in the sidecars as `SidecarMaterial.texture`
  (`packages/convert/src/gltf/convert.ts`). It holds a backslash path, which `keyOf` normalises (§0 item 7). For
  terrain, the key is `tile2d:${manifest.tiles[i].id}`.
- **The `remaster.ts` coordination point.** Its `sro-remaster` manifest keys by `<glb>#<image>`, maps full files
  (`albedo`, `normal`, `metallicRoughness` or separate `metallic`/`roughness`) and lives under `/out/remaster/`. It
  has no AO field. Two indices would drift, so the lead picks one:
  - (a) `remaster.ts` reads `pbr/index.json` and joins through the sidecar's `texture`; or
  - (b) TP-E also writes a `remaster/manifest.json` view generated from the index.
  - Option (b) is **not "a few lines"**. `remaster.ts` takes one RGB(A) `normal` file, so the view writer must also
    write packed normal PNGs from the nx/ny planes, and separate `metallic`/`roughness` files. AO is dropped.
  - Option (b) also covers **actors only**: `remaster.ts` is hooked only into `apps/game/src/three/models.ts` (§4).

  Proposed: (b) for the actor test phase, because it needs no game-code change. Then RENDER's RND-M loader for world
  objects and terrain, in whichever key format the lead picks.

### 6.3 How the v1 planes become textures (loader, RND-M's `pbr/maps.ts`)

- Decode each plane with `createImageBitmap` in a worker, with `premultiplyAlpha: 'none'` and
  `colorSpaceConversion: 'none'` so the linear planes are not altered. `Assets.image` today decodes on the main thread
  through an OffscreenCanvas read-back (`assets.ts` 97–109). FIELDS.md §3.6 notes that it may have to move to a
  worker.
- Pack into:
  - **normal** RGBA8: x, y, and z reconstructed, alpha 255;
  - **orm** RGBA8: R = ao, G = rough, B = metal (0 or the plane), A = height. The ORM texture then carries height for
    puddles, so no extra texture is needed.
  - **Conflict:** RENDER.md §6.1 packs the terrain array as `rmh` (R roughness, G AO, B height), and its §3.2 uses
    glTF ORM for objects. One packing must be chosen with RND-T and RND-M.
- Upload through `RawTexture` with mips (albedo `gammaSpace` true; the others linear).
- Terrain tiers use the tile atlas (`tile-atlas.ts`): one RGBA8 array per map at the tier size. Normal and ORMH arrays
  are half the albedo tier (RENDER.md §12). RENDER.md §6.1's table instead lists normal at 1024 on High.
- Cost:
  - about 10–25 ms of worker time per 1K set [likely];
  - one upload job per map on the main thread: about 1–2 ms at 1K and 4–8 ms at 2K [likely; RND-M measures].
  - Fact-check: FIELDS.md §3.6's budget is **per frame**: 3, 4 or 5 ms for low, medium and high, and a single job is
    never split. So a 2K map is a hitch-sized job on its own.
  - **WebGPU terrain arrays build their mips on the CPU, on the main thread** (`textures.ts` `uploadTextureLayer` →
    `downsample`, because Babylon's WebGPU mip generation only covers layer 0). Measured on the dev CPU, a full RGBA8
    mip chain takes **0.6 ms at 512², 2.4 ms at 1024² and 9.2 ms at 2048²** per layer and per map [confirmed,
    `work/tmp/texpipe-fc/mipbench.ts`, `pnpm tsx`, best of 5]; expect 2–4× that on a laptop CPU [likely].
  - So 1K/2K layers should come with their mips precomputed in the decode worker, with `uploadTextureLayer` taking
    the levels. This is an RND-T change.
- v2 (KTX2) loads each map through Babylon's `Texture` (`.ktx2` → `KhronosTextureContainer2`), transcoded to BC7 on
  desktop, with local transcoder URLs (§6.7).

### 6.4 Tiers per preset: how the game picks retail or remastered

`QualitySettings.render` (RENDER.md §10) gains `textures: { tier: 'retail' | 'remaster1x' | 1024 | 2048,
maps: 'none' | 'hero' | 'all' }`. Fact-check: RENDER.md does **not** delegate this. Its §10 Materials row
(Medium maps ≤ 1024, High ≤ 2048, Ultra full) and its §3.2 resolution caps differ from the table below. Its §12
("until KTX2 exists: … High … about 250 MB resident", ~60 hero textures) is also more conservative than this High
row, which is 0.7–1.0 GB with ~120 hero textures. The table below is this lane's **proposal**, and the lead
reconciles it with RENDER.md §10 and §12:

| Preset | Terrain tiles | World model textures | Actors | PBR maps (normal, ORM, height) | Needs KTX2 |
|---|---|---|---|---|---|
| **Low (Classic)** | retail 512 (256 at low stream settings, as today) | retail | retail | none (today's shaders) | no |
| **Medium** | remastered albedo at **retail size** (de-lit, AI-cleaned, downsampled from the master) | same | same | **hero only**, at retail size | no |
| **High** | **1024** albedo (the tiles' '2x' tier); maps at 512 | the **'2x' tier**: min(2 × retail, 1024); maps at half size for the **hero set**; others albedo + class defaults | '2x' tier + maps | hero set + all terrain | no (v1 WebP); better with |
| **Ultra** | **2048** albedo; maps at 1024 | **4×** (capped at 2048) + maps for all `ok` sets | 4× + maps | all | **yes**; without KTX2 Ultra uses High's textures |

- A set whose `status` is `retail`, or a texture with no set, keeps the retail texture on every preset.
- **The '2x' tier (lead decision, 2026-09-29, asked by the B1 check).** B1 showed that High's "2×" had no tier to point
  at: the fixed tiers are the retail size, 1024 and 2048, so a 256-px wall got either its retail size or 1024 (4×),
  and a 64×256 roof had nothing between 256 and 1024. Decision:
  - TP-E writes one more tier, **'2x' = min(2 × the retail long edge, 1024)**, capped at the master (`encode.ts`
    `tier2xEdge`). For a 512 tile it is the 1024 tier (no extra files); for a 256 source it is 512; for 64×256 it is
    128×512. Its files are named by the long edge like every tier (`albedo@512.webp`), so the file layout and the
    tier-name rule do not change.
  - The set records it as the optional **`tier2x`** (the key of that tier in `tiers`). Format version stays 1: a reader
    that does not know the field takes the largest tier ≤ 1024.
  - **High's albedo tier is `tier2x`** for world models, actors and tiles; High's maps come from the same tier's
    planes (normal full size, ORM at half). Ultra keeps the largest tier (≤ 2048, KTX2). Medium keeps the retail-size
    tier.
  - **The runtime side (TX-R) comes later in the engine lane:** `pbr/maps.ts` picks `set.tiers[set.tier2x]` on High
    (falling back to the largest tier ≤ 1024), and `QualitySettings.render.textures.tier` gains `'2x'` as High's
    default. Nothing in the engine changed with this decision.
  - Cost: town world albedo on High is now about 2× the retail texels instead of up to 4× (the §6.5 "×2, capped 1024"
    row, 354 MB RGBA8 / 89 MB BC7), which is what §6.5 already budgeted. On disk the tier is new for 79 of the 145 hero
    sets (the others' '2x' is their 1024 or master tier) and adds 8.3 MB, +5.4% of the hero set's WebP bytes
    [confirmed, B1 hero encode 2026-09-29].
- **When a tier applies:** at the next load (the Options row notes "applies after reload"). The terrain atlas could
  rebuild live (`TileAtlas` grows and rebuilds already), but object materials are shared per model container, and a
  live swap of 300+ textures hitches. Low ↔ PBR already needs a rebuild (RENDER.md §3.1).
- **Progressive swap.** On a first visit, regions commit with the retail textures (already cached, small) and then
  swap in the preset's sets as they arrive, at the lowest streaming priority. A slow link shows the classic look first
  and never delays play [our rule]. The cost is downloading both on the first visit.
  - Retail is about 15–20% of the High bytes, so that is fine.
  - On Medium it roughly **doubles** the texture bytes. World albedo is embedded in the glbs, which are always
    fetched (RENDER.md §3.2: the albedo replaces the embedded texture by URL; the glb is not re-exported), so a
    remastered albedo is always extra wire, never a replacement.
  - The embedded retail textures also stay resident unless the loader disposes them after the swap (+88 MB for the
    town, §6.5).

### 6.5 VRAM (resident), from the inventory [confirmed arithmetic; bytes per texel with mips: RGBA8 5.3, BC7 1.33]

| Resident set | Texels | RGBA8 | BC7 (KTX2) |
|---|---:|---:|---:|
| Town world textures, retail (339 textures) | 16.6 M | 88 MB | — |
| Town world textures ×2, capped 1024, albedo | 66 M | 354 MB | 89 MB |
| Town world textures ×4, capped 2048, albedo | 266 M | **1.4 GB** | 354 MB |
| + maps at half size (normal RGBA8 + ORMH RGBA8), per albedo byte | | +50% | +50% |
| Terrain, 5×5 window, median 30 / max 67 layers: 512 albedo (today) | | 42 / 94 MB | |
| Terrain 1024 albedo + 512 normal + 512 ORMH | 8.4 MB/layer | 252 / 563 MB | 2.1 MB/layer: 63 / 141 MB |
| Terrain 2048 albedo + 1024 maps | 33.6 MB/layer | 1.0 / 2.25 GB | 8.4 MB/layer: 252 / 563 MB |

Consequences:

- **High on v1 WebP** is town ×2 albedo (354 MB), plus maps for the hero set (about 60 MB), plus 1K terrain (252 MB
  median, 563 MB worst). That is about 0.7–1.0 GB, which is fine on 6–8 GB desktop GPUs.
  - **The worst case needs a cap:** `TileAtlas` should hold at most 48 layers at 1024 and fall back to 512 for layers
    beyond that (a second array, chosen in the layer map by a flag bit) [likely; RND-T].
- **Ultra is only possible with BC7.** With KTX2 it is about 0.8–1.1 GB: 354 MB albedo, plus 177 MB of maps, plus
  252–563 MB of terrain.
- Medium adds ~0 over today (same sizes), plus hero maps (about 30 MB). That assumes the embedded retail textures are
  disposed after the swap; otherwise add the retail set again (+88 MB in town).

### 6.6 Download (wire), extrapolated from the test set [likely]

Measured ratios on the 14-texture test set (`out-ai/report.json`, `normcodec.json`), bytes relative to the retail
WebP in out-opt:

| | Ratio |
|---|---:|
| 2× albedo (q90) | 3.1× |
| 2× full v1 set (albedo + nx, ny + half-size ao, rough + height) | 6.6× |
| 4× albedo (q90) | 8.6× |
| 4× full v1 set | about 18× |

Terrain tiles average 103 KB retail, 277 KB at 1K albedo, 660 KB for the 1K full set and 876 KB at 2K albedo
[confirmed on 6 tiles].

| First entry into town. Fact-check, re-counted: today's ~28 MB is FIELDS.md's **5×5** window. The 21-region load window around 168,97 uses 46 tiles and 362 world textures (17.8 Mpx); the 3×3 alone uses 43 tiles and 339 textures. The 21-region window's retail world textures weigh **≈ 8.8 MB** as WebP in the out-opt glbs (345 image names; the first draft assumed 14 MB) | Extra wire over today's ~28 MB |
|---|---:|
| Medium: retail-size remaster albedo. It is **added** to the retail bytes, not a replacement: glb-embedded retail albedo is always fetched, and the progressive swap loads retail tiles first. So ≈ 8.8 MB world + 46 × 0.1 MB tiles ≈ 14 MB, plus hero maps at retail size | **+15–25 MB** |
| High (v1 WebP): 1K terrain full sets (46 × 0.66 ≈ 30 MB) + ×2 albedo for world (≈ 8.8 MB × 3.1 ≈ 27 MB) + hero maps (≈ 10 MB) + actors (≈ 5 MB) ≈ 72 MB | **+60–90 MB** |
| Ultra (KTX2 UASTC+zstd, about 3–5 bits per texel [likely]) | **+150–250 MB** |
| Whole 307-region area at High, all cached after one walk | ≈ 200–250 MB |

- **Lower WebP quality is an easy lever:** q80 saves about 25–30% [likely].
- **The host's upload speed decides the first-visit wait** (the N100 on the user's home line). At 20 Mbit/s up, +80 MB
  is about 35 s per friend on the first visit, spread over play by the progressive swap. **Ask the user** (§9).
- Deploy: the first deploy grows by the `pbr/` tree, about 0.3–0.6 GB for the v1 WebP tiers (retail size and 1024;
  2048 ships only as KTX2). DEPLOY.md hashes each file with SHA-256, so this is only once [likely].

### 6.7 KTX2 (v2)

- **Encoder:** `basisu` (Basis Universal, Apache-2.0) or `toktx` (KTX-Software, Apache-2.0).
  - albedo: UASTC + RDO + zstd, sRGB;
  - normal: UASTC, linear, `--normal_map` mode;
  - orm: UASTC, linear;
  - mips generated by the encoder; for `cutout`, our coverage-preserving mips are passed in as explicit levels.
- **Runtime:**
  - Babylon's `KhronosTextureContainer2` transcodes in workers.
    - Its `URLConfig.jsDecoderModule` defaults to `https://cdn.babylonjs.com/babylon.ktx2Decoder.js` [confirmed:
      `Misc/khronosTextureContainer2.js` 413], which the project forbids.
    - The nine wasm and transcoder entries default to `null` (414–422) [confirmed]. The decoder module then falls back
      to its own built-in URLs, which are also on the Babylon CDN [likely]. So **every** entry must be set, not only
      `jsDecoderModule`.
    - Files to vendor into `out-opt/_decoders/ktx2/` [likely names, verify at fetch time]: `babylon.ktx2Decoder.js`,
      `uastc_astc.wasm`, `uastc_bc7.wasm`, `uastc_rgba8_unorm_v2.wasm`, `uastc_rgba8_srgb_v2.wasm`,
      `uastc_r8_unorm.wasm`, `uastc_rg8_unorm.wasm`, `msc_basis_transcoder.{js,wasm}` and `zstddec.wasm`.
    - Set `KhronosTextureContainer2.URLConfig` once at start-up, the way `meshopt.ts` installs its decoder.
    - Alternatively, pass modules through the constructor's `binariesAndModulesContainer` option (in the `.d.ts`)
      [confirmed option exists].
  - **WebGPU:** the engine maps the device feature `texture-compression-bc` to `caps.bptc` and `caps.s3tc`
    [confirmed: `webgpuEngine.pure.js` 591–595]. Fact-check: the device only has that feature if it was
    **requested**. `WebGPUEngine` requests adapter features only with `enableAllFeatures: true` (default false,
    `.d.ts` "Default: false") or with `deviceDescriptor.requiredFeatures` (`webgpuEngine.pure.js` 430–440).
    `apps/game/src/engine.ts` line 25 passes neither (`{ antialias: true, adaptToDeviceRatio: true }`), so today
    `caps.bptc` is **undefined on WebGPU** even though the adapter lists the feature [confirmed by reading].
    TP-K needs the lead to add `deviceDescriptor: { requiredFeatures: ['texture-compression-bc'] }`, filtered to the
    adapter's features, in `engine.ts`.
  - **WebGL2** needs `EXT_texture_compression_bptc`. Otherwise the transcoder falls back to RGBA8, and then Ultra must
    not be offered.
- **Terrain arrays** need compressed **2D-array** uploads with mips:
  - WebGL2: Babylon's `updateRawTexture2DArray` (`MakeUpdateRawTextureFunction` in `engine.rawTexture.pure.js`) cannot
    be used [confirmed]:
    - line 127 calls `compressedTexImage3D` for level 0 only, with the format looked up in `getCaps().s3tc[…]`, so a
      BPTC format cannot even be named there;
    - line 133 then calls `generateMipmap`, which is invalid on a compressed format.
  - WebGPU's `updateRawTexture2DArray` takes a `mipLevel` [confirmed: 296–320], but it writes **all layers** of that
    level from one buffer, not one layer.
  - So a small helper uploads each layer's transcoded BC7 levels itself: raw `gl.compressedTexSubImage3D` on WebGL2,
    and the internal `_textureHelper.updateTexture(…, layer, level, …)` on WebGPU. That is the same internal API
    `textures.ts` `uploadTextureLayer` already uses for RGBA8. Whether it computes block-compressed row pitches for
    BC7 is [likely].
  - Transcoding a KTX2 into raw BC7 levels without creating a Babylon texture needs the decoder's worker API
    [unknown: `babylonjs-ktx2decoder` exposes a `KTX2Decoder.decode` returning mip data; verify after vendoring].
- **No BC5:** `constants.d.ts` has ASTC, ETC1/ETC2, BPTC and S3TC constants but **no RGTC** [confirmed]. The WebGPU
  texture helper knows `bc5-rg-unorm` internally (`webgpuTextureHelper.js`), but no public format constant or KTX2
  transcode target reaches it [likely]. So normals go to BC7 (UASTC → BC7) at the same 1 byte per texel. The same
  applies to RENDER.md §12's BC5 and BC1 assumptions for normal and ORM, which need revising.

---

## 7. Test set and the measured prototype

### 7.1 The test set (13, plus 1 extra)

| # | Key (short) | What | Source | Class | Wrap | Why |
|---|---|---|---|---|---|---|
| T1 | tile2d `c_marble_jang_09` | plaza paving | 512² | stone | U V | 8.0% of the town ground |
| T3 | tile2d `c_grass_fld_03` | grass | 512² | ground_grass | U V | 11.1% fields, 9.6% town |
| T4 | tile2d `c_grass_hmfld_01` | grass | 512² | ground_grass | U V | the most-used tile (18.3%) |
| T5 | tile2d `c_dust_fld_01` | dirt road | 512² | ground_soil | U V | 6.4% town |
| T6 | tile2d `c_stone_hmfld_01` | rock ground | 512² | stone | U V | 4.4% fields |
| O1 | `jangan_enter/cj_wall01` | city wall | 256×512 DXT1 | stone | U | 3 walls, 1.4 km |
| O2 | `jangan03/cj_pal_roof` | palace roof tiles | **64×256** DXT1 | roof_tile | U | 34 town placements; tiny source |
| O3 | `tree/tre_bank_pilla` | tree trunk | 256² DXT1 | wood (bark) | U | 62 placements, 32 in town |
| O4 | `tree/tre_tree02_01` | leaf card | 256² DXT3 cutout | foliage | — | 84 placements; tests alpha |
| O5 | `man_item/clothes_01_ba` | starter chest armour | 256² DXT1 | cloth | atlas | every new male character |
| C1 | `char/.../chinaman_adventurer_body` | body/face atlas | 512×256 DXT3 cutout | skin | atlas | always on screen |
| C2 | `char/.../chinaman_adventurer_hair` | hair | 256×128 DXT3 cutout | hair | atlas | always on screen |
| C3 | `weapon/sword1_2_3` | Copper Sword | 512² DXT3 specmask | metal | atlas | starter weapon; alpha marks metal |
| (T2, extra) | tile2d `c_marble_jang_04` | plaza paving 2 | 512² | stone | U V | 7.4% town |

If exactly 12 are wanted, drop T6 (rock) or O4 (leaves). All of them were cheap to run.

### 7.2 What was run [confirmed]

Scripts in `work/tmp/texpipe/`:

- `inventory.py`, `density.py`: §1.
- `proto.ts`, run with `pnpm tsx`. It extracts, upscales (Lanczos3 ×4, or the AI output with `UPSCALER=ai`), then
  runs de-light → height → normal → AO/rough/metal → previews → encodes. Kept output:
  - `out-ai/<key>/` holds `0_source`, `2_albedo_delit`, `3_normal`, `4_ormh` (A = height), `5_preview_lit` and
    `6_preview_wet` from the AI run;
  - `out/<key>/` holds the source and the previews of the Lanczos run;
  - the AI upscales themselves are `ai/out/<key>.png` (x4plus) and `ai/out-realesrgan-x4plus-anime/`.
  The intermediate PNGs and encodes were deleted.
- `ai.ts`: pads the RGB with `repeat` on **all four sides** for T1–T6 and O1–O3. That is not per axis: the regex
  `TILEABLE` covers the key and `extend` pads every side. It then runs `realesrgan-ncnn-vulkan.exe` (per file and as
  a directory batch), crops, and re-attaches alpha.
- `compare.ts`: builds `compare_world.png` and `compare_actor.png` at 1:1 crops. The columns are nearest ×4 | Lanczos
  ×4 | x4plus | x4plus-anime | x4plus + PBR lit | wet.
- `normcodec.ts`: the WebP shipping options (§7.4).

**Timings** (dev PC; single-threaded JS for the PBR steps; per texture at the 2K master or 4× size):

| Step | 2048² tile | 1024×2048 wall | 1024² trunk / cloth | 256×1024 roof |
|---|---:|---:|---:|---:|
| Lanczos ×4 (sharp) | 30–60 ms | 18–25 ms | 7–15 ms | 5–7 ms |
| AI x4plus (single call, including about 2 s start-up) | 4.4–5.0 s | 3.5 s | 2.8–3.2 s | 2.3 s |
| De-light | 0.7–1.1 s | 0.4 s | 0.2 s | 0.04 s |
| Height | 1.7–2.4 s | 0.9 s | 0.4 s | 0.1 s |
| Normal | 0.6–1.1 s | 0.4 s | 0.2 s | 0.05 s |
| AO, roughness, metallic | 0.4–0.6 s | 0.2–0.3 s | 0.1 s | 0.03 s |
| **PBR total** | **≈ 3.5–5 s** | 2 s | 0.9 s | 0.2 s |

- AI directory batch: 14 files in **23.6 s**, which is 10.1 s per source Mpx (x4plus) and 3.4 s/Mpx (anime).
- **The whole inventory** is about 20 min of AI on the GPU, plus PBR. Fact-check, re-computed: the 4× masters capped
  at 2048 total about **1,456 output Mpx**, and the PBR steps run at about 0.95 s per output Mpx (T1: 3.98 s for
  4.2 Mpx). That is **≈ 23 min single-threaded, ≈ 4–5 min on 6 workers** [likely].
  - Encoding was not timed on its own [unknown]. The prototype's per-texture `total` (15–17 s for a 2K tile) also
    includes previews and near-lossless test encodes.
  - That is **under an hour for a full run** [likely], and incremental after that.

**Seams** (edge column difference / interior column difference; 1 = seamless):

| | Lanczos unpadded | Lanczos wrap-padded | AI (x4plus) wrap-padded, U / V |
|---|---:|---:|---:|
| Terrain tiles T1–T6 | 2.9–5.2 | 0.87–1.52 | 1.0–2.4 / 1.0–1.6 |
| O1 wall / O2 roof / O3 trunk | 3.3 / 2.8 / 4.3 | 1.0 / 0.85 / 1.3 | 1.3 / 0.7 / 1.5 (U); V 11 / 7.8 / 2.5 (wrong-axis wrap; source V 5.1 / 2.2 / 2.3) |
| Retail source itself (re-measured) | tiles U 0.88–1.51, V 0.90–1.23 | | |

The Lanczos columns measure the U seam only (`proto.ts` `seam()` compares columns). The AI U/V split and the source
row were re-measured for this fact-check from `ai/out/*.png` and `out-ai/*/0_source.png`; they match the first draft.

### 7.3 What the pictures show (`work/tmp/texpipe/compare_world.png`, `compare_actor.png`, `out/sheet_*.png`)

- **Real-ESRGAN x4plus is a clear win on natural surfaces:**
  - the grass turns into crisp blades instead of soft noise;
  - the wall bricks get sharp courses and mortar;
  - the tiny 64-px roof becomes readable tiles;
  - the tree trunk shows bark and moss detail.
  Lanczos is only a softer version of the original.
- **Marble paving (T1)** comes out over-sharpened and "embossed", because the DXT noise is amplified. It needs §3.3
  (a 1× clean pass) or `aiMix` 0.6.
- **x4plus-anime flattens grass to a single green and invents panel lines on the wall.** Reject it for natural
  surfaces. On hair it is as good as or better than x4plus.
- **The lit previews** (a simple directional light with the derived normal and AO) are where the "modern" look
  appears. Wall courses, cobbles, roof tiles and bark read in 3D.
  - Normal strength is too high on the wall and bark (lumpy); the review lowers it.
  - The roof's normals from a 64-px source are blobby. **Tiny sources (≤ 64 px) need `albedo-only`**, or a
    generated/hand replacement.
- **The wet previews** show porous dirt darkening, the glossy wet paving and puddles in low areas. Puddles must be
  **limited by class** (not on grass) and by slope. RENDER.md §9.3 already restricts them to soil, grass-ground and
  stone classes with N.y > 0.95; grass should be excluded [our rule].
- **Characters:**
  - the body/skin upscale is clean;
  - the hair gains strand definition (anime model better);
  - the Copper Sword's specmask alpha correctly becomes metallic (blade);
  - de-lighting over-brightens the white starter chest. Use low k (0.2–0.3) on actors; the review can set 0.
- **Leaves:** the prototype's alpha bleed runs before processing, but the retail DXT3 matte colour still fringes in the
  lit preview. The build lane must bleed before the **AI** pass as well (§3.4 rule 3).

### 7.4 Shipping codecs, measured on the 1K tier (`normcodec.json`)

| Texture | Normal as RGB WebP q90: bytes, mean° / p99° | Normal as 2 grey planes q90: bytes, mean° / p99° | ao / rough (half) + height (full), bytes |
|---|---|---|---|
| T1 marble 1024² | 128 KB, 1.28 / 3.9 | 184 KB, **0.75 / 2.1** | 44 + 36 + 64 KB |
| T3 grass 1024² | 196 KB, 1.97 / 5.8 | 316 KB, **0.88 / 2.3** | 88 + 54 + 133 KB |
| T5 dirt 1024² | 112 KB, 1.09 / 3.1 | 156 KB, **0.70 / 1.9** | 46 + 24 + 69 KB |
| O1 wall 512×1024 | 180 KB, 4.67 / 18.7 | 270 KB, **1.57 / 7.3** | 39 + 24 + 56 KB |
| O3 trunk 512² | 107 KB, 5.22 / 18.6 | 163 KB, **1.71 / 7.3** | 24 + 12 + 35 KB |
| C1 body 1024×512 | 13 KB, 0.56 / 1.7 | 17 KB, **0.33 / 1.3** | 8 + 7 + 14 KB |
| O2 roof 128×512 | 42 KB, 13.8 / 56 | 64 KB, 7.8 / 41 | (tiny source: use near-lossless or `albedo-only`) |

- Near-lossless WebP for normals (nl60) costs 3–10× the q90 planes: 0.6–0.8 MB at 1K for tiles. Rejected except for
  tiny textures.
- **Decision:** two planes at q90.

---

## 8. Cost table (texture-related only; shading, shadows and post are RENDER.md §11)

| Item | Mid GPU (RTX 3060 / RX 6600 class, 1080p) | Integrated (Iris Xe / Radeon 680M, 1080p at 0.75 scale) | Status |
|---|---|---|---|
| Bigger textures (same shader): more cache misses near the camera | +0.1–0.3 ms at High | +0.5–1.5 ms at High (so iGPU defaults to Medium, RENDER.md §10) | [likely] |
| Terrain PBR samples: 1.5 layers per pixel on average (layer-count statistics in TERRAIN.md §2.3: 97,110 layer draws / 64,512 cells) × 3 maps + lightmap + detail ≈ 7–8 samples per pixel | ≈ 0.3–0.6 ms | ≈ 1.5–3 ms | [likely]; RND-T measures |
| Worker decode and pack of a 1K v1 set | 10–25 ms, off-thread | 30–60 ms, off-thread | [likely] |
| Main-thread upload per map (with mips) | 1–2 ms at 1K, 4–8 ms at 2K | ×2 | [likely]; each is one unsplittable streaming job, and FIELDS.md §3.6's per-frame budget is 3/4/5 ms |
| WebGPU terrain layer: CPU mip chain on the main thread (`textures.ts` `downsample`), per layer per map | 2.4 ms at 1024², 9.2 ms at 2048² (dev CPU) | 2–4× on a laptop CPU [likely] | [confirmed on the dev CPU, `work/tmp/texpipe-fc/mipbench.ts`]; move to the decode worker |
| KTX2 transcode UASTC → BC7 (worker) | about 5–15 ms per 1K map | ×2–3 | [likely] |
| VRAM | §6.5 | shared memory: stay at Medium | [confirmed arithmetic] |
| Download | §6.6 | same | [likely] |

The remaster does not change the CPU draw cost: same meshes, same materials count. RENDER.md §16 notes that the CPU is
the real bottleneck.

---

## 9. What must be downloaded or installed (for the user to approve)

Nothing is needed to **start**. The v1 pipeline (Real-ESRGAN x4plus/anime plus our sharp/TypeScript PBR steps plus
WebP) runs with what is installed. Everything below is optional or for later. Sizes and licences marked [likely] must
be checked on the page at download time.

| # | What | URL | Licence | Size | Why / when |
|---|---|---|---|---|---|
| 0 | Real-ESRGAN ncnn-vulkan 20220424 (x4plus, x4plus-anime, animevideov3) | github.com/xinntao/Real-ESRGAN/releases (v0.2.5.0) | exe: MIT (ncnn-vulkan port); models: BSD-3-Clause [likely] | 45.5 MB zip [confirmed, already in `work/tools/`] | **Done.** The v1 upscaler |
| 1 | Extra ncnn upscaling models: **4x-UltraSharp**, 4x-Remacri (ncnn `.param/.bin`) | github.com/upscayl/custom-models (`models/`) | UltraSharp: CC BY-NC-SA 4.0; Remacri: CC BY-NC-SA 4.0 [likely]. Non-commercial fits a private fan project | about 33 MB per model: RRDB fp16, the same architecture as x4plus, whose ncnn `.bin` is 33.4 MB [confirmed for x4plus in `work/tools/realesrgan/models`; the first draft said 64 MB] [likely] | A/B against x4plus on the test set. Runs in the installed exe, no new runtime |
| 2 | **onnxruntime-directml** (Python wheel) | `pip install onnxruntime-directml` (pypi.org/project/onnxruntime-directml) | MIT | about 20–25 MB [likely] | Runs any ONNX model on the AMD GPU: DeepBump, PBRify, Nomos/SPAN |
| 3 | **DeepBump** ONNX models (colour → normals, normals → height) | github.com/HugoTini/DeepBump | GPL-3.0 (code and models). Use only as an offline tool; never vendor it into the repo | about 25–50 MB [unknown] | A/B its normals against our Sobel normals (§3.6) |
| 4 | A 1× DXT/BC1 de-blocking model and **PBRify_Remix** (upscaler plus normal/roughness/height models made for old game textures) | openmodeldb.info (search "BC1", "DDS"); github.com/Kim2091/PBRify_Remix | per model [unknown]; PBRify models [unknown] | 5–70 MB each [unknown] | §3.3 clean pass; PBRify is the strongest ML candidate for the PBR maps of 2000s game textures |
| 5 | **basisu** (Basis Universal encoder) *or* **toktx** (KTX-Software) | github.com/BinomialLLC/basis_universal/releases; github.com/KhronosGroup/KTX-Software/releases | Apache-2.0 (both) | basisu about 5–10 MB exe; KTX-Software about 15–25 MB installer [likely] | **Needed for Ultra and for low-VRAM High** (§6.5). The same ask as RENDER.md §15 item 2 |
| 6 | Babylon KTX2 transcoder files, vendored into `out-opt/_decoders/ktx2/` | npm `babylonjs-ktx2decoder` (9.x) for `babylon.ktx2Decoder.js`. Whether that npm package also ships the `.wasm` transcoders is [unknown]; otherwise they come from the Babylon.js GitHub repository's `ktx2Transcoders/1/` folder. The files are listed in §6.7 | Apache-2.0 (Babylon, Basis transcoder); zstddec MIT [likely] | about 1–3 MB total [likely] | With item 5; replaces every CDN default (§6.7) |
| 7 | chaiNNer (optional, for the user) | github.com/chaiNNer-org/chaiNNer/releases | GPL-3.0 | about 150 MB plus backends it downloads itself (ncnn/ONNX small; PyTorch GBs) [likely] | Only if the user wants to try models by hand. Not needed by the pipeline |

**Other questions for the user:**

- **The host's upload bandwidth** (Mbit/s up on the mini PC's line). It sets how heavy High can be for friends on the
  first visit (§6.6).
- Go/no-go on the **hero set** idea (§1.3), and whether Medium should ship the retail-size remaster or stay retail.
  The remaster is cleaner, but it is about +15–25 MB of extra wire on first entry, not the same size (§6.6).
- The Meshy question is **already answered** in `work/tmp/w9-user-decisions.md` ("Update: Meshy approved"): approved
  test parts only. It needs no new question unless the scope grows.
- **Generative replacements** (§5): only when the user wants them. Which plan they are on (for the output licence),
  and which surfaces to try first. Proposed: the city-wall brick and the plaza marble as prompt-generated seamless 2K
  materials, colour-matched to retail.

---

## 10. Build plan

Every lane is Node through pnpm (`pnpm tsx`, `pnpm vitest`), keeps retail art local, and commits no image. Tests that
need `work/out` or the Real-ESRGAN exe skip without them (CONVENTIONS.md).

### TP-0: format and inventory (one agent, first, small)

- **Owns:**
  - `packages/texpipe/package.json` (new workspace package `@sro/texpipe`; deps `sharp`, `@gltf-transform/core`, like
    `@sro/convert`);
  - `packages/texpipe/src/format.ts`: environment-neutral `PbrIndex`/`PbrSet`/`PbrTier` types, `keyOf`, `keyPath`,
    `validatePbrIndex`. World-render imports it by relative path, as it does `convert/src/world/format.ts`;
  - `src/inventory.ts` (a port of `inventory.py` + `density.py`: classes via RENDER's `classes.ts`, wrap axes, alpha
    kind, importance, hero flag, texel density);
  - `src/cli.ts` (`inventory | extract | upscale | pbr | review | encode | run --set test|hero|all`);
  - `content/texpipe/overrides.json` (empty skeleton).
- **Lead:** the root `package.json` script `"texpipe": "tsx packages/texpipe/src/cli.ts"`.
- **Hook points:** reads sidecars (`materials[].texture`, `alphaMode`, `alphaReason`, `textureFormat`) and the world
  manifest `tiles`, `models` and `placements`; imports `classify` from `packages/world-render/src/pbr/classes.ts`
  (RND-M's). Until that exists, a stub with RENDER.md §3.3's table.
- **Tests:**
  - `packages/texpipe/test/format.test.ts`: keys, key paths, and validation of a synthetic index.
  - `inventory.test.ts` (skips without `work/out`):
    - 104 tiles and ≥ 780 world textures;
    - `cj_wall01` wraps U and not V;
    - `sword1_2_3` is `specmask`. This needs the corrected §3.2 rule, because its `alphaReason` is the equipment
      "the alpha is a mask" string;
    - `keyOf('prim\\mtrl\\item\\china\\weapon\\sword1_2_3.ddj')` → `prim/mtrl/item/china/weapon/sword1_2_3.ddj`;
    - `tre_tree02_01` is `cutout`;
    - the hero set contains the 16 terrain tiles of §1.3.
- **User-visible check:** `pnpm texpipe inventory` prints the §1.1 totals.

### TP-U: the upscale runner

- **Owns:** `packages/texpipe/src/upscale/{runner.ts, pad.ts, alpha.ts, mix.ts, cache.ts}`.
- **Hook points:**
  - `work/tools/realesrgan/realesrgan-ncnn-vulkan.exe`, configurable in `sro.config.json` as
    `texpipe.realesrgan` (the lead edits the config example);
  - directory batch per model;
  - the per-axis pad and crop;
  - alpha bleed before the AI pass;
  - alpha Lanczos plus re-threshold and coverage-preserving mips for `cutout`;
  - the AI/Lanczos mix;
  - a SHA-1 cache in `work/texpipe/cache/up/`.
- **Tests:**
  - pad/crop round trip on synthetic images (a stub "upscaler" that does nearest ×4): the seam ratio is ≤ 1.2 on
    wrapping axes and the crop is exact. On real textures, compare against the source's own ratio (§3.4 rule 2);
  - per-axis rule: a U-only texture gets `repeat` on the left and right and `copy` on the top and bottom (the
    prototype never ran this);
  - alpha bleed leaves opaque texels unchanged;
  - coverage preservation: the fraction of texels above the cutoff is within 2% at every mip;
  - a real run on 2 textures (skipped without the exe) reports ms/Mpx.
- **User-visible check:** `pnpm texpipe run --set test` rebuilds `compare_*.png`-style sheets in about 2 min.

### TP-P: PBR derivation

- **Owns:** `packages/texpipe/src/pbr/{image.ts (Float32 image, wrap-aware box blur), delight.ts, height.ts, normal.ts,
  ormh.ts, islands.ts (UV-island raster + dilation from the glb), preview.ts}`, and a `worker_threads` pool over
  textures.
- **Hook points:** the §3.5–3.7 formulas; class parameters from `classes.ts` plus the TEXPIPE factors
  (`delight`, `normalScale`, `aoStrength`) in `src/pbr/params.ts`; overrides from `content/texpipe/overrides.json`.
- **Tests** (synthetic, no game data):
  - a paraboloid height field gives normals within 1° of analytic;
  - a tileable input gives a tileable output on wrap axes (seam ratio ≤ 1.2);
  - `specmask` alpha → metallic;
  - a `cutout` gives height 0 outside the mask;
  - island dilation: no texel of island A within 8 px of island B after processing;
  - `delight` with k = 0 is the identity.
- **User-visible check:** the review page's lit and wet previews.

### TP-E: encode, index and review

- **Owns:** `packages/texpipe/src/encode.ts`, `src/index-writer.ts`, `src/review.ts` (local HTML), and
  `src/remaster-view.ts` (writes the `remaster/manifest.json` view for `apps/game/src/three/remaster.ts`, §6.2 option
  b).
- **Output:** `work/out/pbr/**` and `work/out/pbr/index.json`.
- **Hook points:** tiers (the retail size, the '2x' tier, 1024, 2048 ≤ master; `tier2x`, §6.4); v1 planes at the §7.4
  settings; `bytes` per tier;
  `status` and `hero` from the overrides and the inventory.
- **Tests:**
  - index validation;
  - every file in the index exists;
  - the tier sizes are right;
  - plane decode gives |normal| within 0.02 of 1 after z reconstruction;
  - q90 planes stay under 2° mean error on the test set, excluding sources ≤ 64 px (skips without data). The 64-px
    roof measured 7.8°, so an unfiltered test would fail;
  - the remaster view writes one packed RGB normal per set, which `remaster.ts` `parseRemasterManifest` accepts.
- **User-visible check:** open `work/texpipe/review/index.html` and mark statuses. Then:
  - `?remaster=1` in game shows the **actor** sets only (character screen, spot 4), because `remaster.ts` is hooked
    into `ModelLibrary` only;
  - terrain, walls and trees (spots 1–3) need RND-M's and RND-T's loaders.

  Take the §4 screenshots.

### TP-K: KTX2 (after the user approves §9 items 5–6)

- **Owns:**
  - `packages/texpipe/src/ktx2.ts` (the basisu/toktx runner; explicit mips for `cutout`);
  - `packages/world-render/src/ktx2.ts` (sets `KhronosTextureContainer2.URLConfig` to the vendored
    `out-opt/_decoders/ktx2/*`, like `meshopt.ts`);
  - `packages/world-render/src/texture-compressed.ts` (BC7 2D-array layer upload with mips for the tile atlas:
    `compressedTexSubImage3D` / WebGPU `updateTexture` per level);
  - `packages/convert/src/tools/vendor-ktx2.ts` (copies the decoder files next to the meshopt decoder).
- **Hook points:**
  - `tile-atlas.ts` accepts a `format` option. RND-T wires it; TP-K provides the upload function.
  - `apps/game/src/engine.ts` (lead-owned) must request `texture-compression-bc` in `deviceDescriptor.requiredFeatures`
    when the adapter has it. Without that, `caps.bptc` is undefined on WebGPU (§6.7).
  - WebGL2 cannot use Babylon's `updateRawTexture2DArray` for BC7 (§6.7).
- **Tests:**
  - encoder round trip on 2 synthetic images (skips without the encoder);
  - `URLConfig` has no `babylonjs.com` URL after install;
  - a NullEngine smoke test that the loader path is taken;
  - an `engine.ts` unit check that the device descriptor lists `texture-compression-bc` only when the adapter offers
    it.
- **User-visible check:** Ultra becomes selectable; the network panel shows no request to `babylonjs.com`; VRAM (the
  perf overlay, if it shows it) drops by about 4× at the same tier.

### Integration (lead)

- Wire `QualitySettings.render.textures` (§6.4) with RND-G.
- Pick the §6.2 key option with the `remaster.ts` owner.
- No server change: `static.ts` already maps `.ktx2 → image/ktx2`, and both the server's and the optimizer's
  compression sets are allow-lists that exclude `.ktx2` (§6.1) [confirmed].
- For TP-K: the `requiredFeatures: ['texture-compression-bc']` device request in `apps/game/src/engine.ts` (§6.7).
- Reconcile with RENDER.md: the runtime manifest format and key forms (§6.2), the preset table (§6.4 vs RENDER.md §10
  and §12), and the terrain `rmh` versus ORMH packing (§6.3).
- Deploy notes: the `pbr/` tree size.

---

## 11. Open questions and risks

- **Painted light that de-lighting cannot remove** (small painted shadows and highlights) stays in the albedo and
  doubles with SSAO and the derived AO. Mitigations: low AO strength on painted classes, RENDER.md's `delit` flag, and
  human review. This is the main quality risk.
- **AI hallucination:** marble embossing, and patterns that differ between identical neighbouring tiles. Mitigations:
  the `aiMix` blend, the §3.3 clean pass, the `retail` status. Terrain tiles must stay seamless, and are verified by
  the seam test in TP-P and TP-U.
- **Mip coverage of cutout foliage** on WebP (v1) without coverage-preserving mips: trees thin at distance. Options:
  alpha-to-coverage [likely] or KTX2 v2 (explicit mips).
- **VRAM on 4 GB GPUs at High** (0.7–1.0 GB of textures, §6.5): the RENDER.md watchdog drops a preset. The terrain
  layer cap is needed.
- **Download for friends** depends on the host's upstream bandwidth [unknown]. The progressive swap hides it but does
  not remove it.
- **Two manifests** (`remaster.ts` vs `pbr/index.json`) until the lead picks §6.2 (a) or (b).
- **Meshy scope** (§5). Fact-check: this is not a conflict. The decision note's "Update: Meshy approved" section allows
  uploads of the named test parts only. The risk is scope creep beyond that list, and every extension needs the
  user's explicit approval.
- **Spec conflicts with RENDER.md** (runtime manifest, key forms, preset caps, terrain map packing, BC5): until the
  lead reconciles them, two lanes may build incompatible loaders.
- **WebGPU BC7 is off today:** `engine.ts` does not request `texture-compression-bc` (§6.7). If this is missed, Ultra
  silently falls back to RGBA8 on WebGPU.
- **Model licences:** UltraSharp and Remacri are non-commercial. Fine for a private fan project; revisit if the
  project ever changes nature.
- **[unknown]:**
  - the exact per-map transcode path for terrain arrays (`babylonjs-ktx2decoder` API);
  - DeepBump and PBRify quality on painted textures;
  - the de-blocking model's availability and licence;
  - the sizes in §9 marked [likely].
- **Scratch kept for the build lanes** (`work/tmp/texpipe/`): `proto.ts`, `ai.ts`, `compare.ts`, `normcodec.ts`,
  `zoom.ts`, `inventory.py`, `density.py`, `inventory.json`, `density.json`, the reports and sheets, `out/` and
  `out-ai/` (the per-texture previews for the review), and `ai/out*` (the AI upscales). Together that is about 690 MB
  [confirmed, `du`]. Delete them once TP-P has ported the prototype. The fact-check added
  `work/tmp/texpipe-fc/mipbench.ts` (the §6.3 mip timing), a few lines that can go at the same time.

---

## 12. KTX2 tooling as installed (TP-K, 2026-09-28)

The user approved the §9 items 5 and 6 downloads on 2026-09-28. Nothing retail was uploaded anywhere; the encoder runs
locally, and the transcoder files come from the npm registry (never a CDN).

### 12.1 Sources, versions, licences, hashes

| What | Source | Version | Licence | sha256 |
|---|---|---|---|---|
| `basisu_v1_16_4.7z` | github.com/BinomialLLC/basis_universal/releases/download/1.16.4/ | 1.16.4 | Apache-2.0 | `c5680d596fbc728ed1eeeec9780f39f554b9a0f088c89cf1d0c7d1df204e9100` |
| `work/tools/basisu/basisu.exe` (from the archive) | same | 1.16.4 (SSE 4.1, Zstandard) | Apache-2.0 | `292acfa83436b3335bf4f5e74e764101f270b1ce2a63196bdb41ebdf7fa38d61` |
| `babylonjs-ktx2decoder-9.28.0.tgz` | registry.npmjs.org | 9.28.0 | Apache-2.0 | `f878d0d9ad4a31549dbb2d67cdee67e3eeb78f665bf21514fc93564492f087a6` (npm sha512 `7DQ+j/Wc…B3N0Qw==`) |
| `@babylonjs/ktx2decoder-9.28.0.tgz` | registry.npmjs.org | 9.28.0 | Apache-2.0 (Khronos transcoders Apache-2.0, zstd BSD-3, per its NOTICE.md) | `681e95d56206cf7ad222baefcb6a78bcc594bae729dc8aecc225f52b00a59954` (npm sha512 `tZ9Unf+P…EheiFw==`) |

- **Why basisu 1.16.4:** the newer GitHub releases (v1.50 … v2.50, 2024–2026) attach no binaries; 1.16.4 is the last
  release with a Windows `basisu.exe`. It writes KTX2 UASTC (+ Zstandard) and ETC1S, which is exactly what Babylon
  9.28's transcoders read. The newer 2.x formats (XUASTC etc.) are not readable by Babylon's transcoder anyway.
- **Why two npm packages:** `babylonjs-ktx2decoder` (UMD) ships `babylon.ktx2Decoder.js` but **no wasm**; the
  official ES6 package `@babylonjs/ktx2decoder` of the same release ships every transcoder under `wasm/`.
- **Vendored files** (`pnpm tsx packages/convert/src/tools/vendor-ktx2.ts`; the tarballs are cached in
  `work/tools/ktx2decoder/`, so `--offline` works; written to `work/out/_decoders/ktx2/` and
  `work/out-opt/_decoders/ktx2/`, with `ktx2-decoders.json`, the licences and NOTICE.md). The script checks the npm
  integrity and these pins, and refuses to run if `@babylonjs/core` is not 9.28.0:

| File | Bytes | sha256 |
|---|---|---|
| `babylon.ktx2Decoder.js` | 24,450 | `3907b73546b65c08a46773a8b130fe2acde9cd1effa89f87d095d8b6f92cfb1d` |
| `uastc_astc.wasm` | 12,212 | `6846c972b4a52d938866f43896fd2b2450052da807cdd1285e898be80614d612` |
| `uastc_bc7.wasm` | 14,650 | `be442ab8c0cbf734ded98e6ad38112aaba23c83bfeecac4213ded54631fc4eef` |
| `uastc_rgba8_unorm_v2.wasm` | 30,121 | `b7470b26a847994cdeb9226eeba1e3711688e378ee438b7dd941e83cb598b694` |
| `uastc_rgba8_srgb_v2.wasm` | 24,158 | `1f4d2e8bfef4e31679b23d473e1c410c29f7e485a739e76c5b357628f4190874` |
| `uastc_r8_unorm.wasm` | 14,139 | `0467c98b150a630e5a51f7810843e8b7fd9aad22e3888baf70aad255c55d02bc` |
| `uastc_rg8_unorm.wasm` | 17,611 | `fb45a2c103c59cec21c3708a6534d43cd4381669f66d3292dd8a6e4e1956d773` |
| `msc_basis_transcoder.js` | 63,318 | `b8906bae7e55606aba070642eb3bce790a2b5aea774874e120e9fd41f7c7d60b` |
| `msc_basis_transcoder.wasm` | 455,582 | `29becbf0eef2ce9f6d72109ad217704ec3799c432da0c26e3893b793ecab6bdc` |
| `zstddec.wasm` | 29,232 | `67d12d34f82ef700ec3a3795a77590252858c70330908a87ed1e73efc268cb4b` |

  About 0.7 MB in total; the server already maps `.wasm` (compressible) and `.ktx2`.

### 12.2 What the code does

- `packages/texpipe/src/ktx2.ts`: the basisu runner with a profile per map (albedo UASTC + RDO λ 1 + zstd 18 sRGB;
  normal UASTC `-normal_map` + renormalised mips; ORMH UASTC λ 0.5 linear; emissive ETC1S), a KTX2 reader, explicit
  mip chains for `cutout` (each level encoded alone, then assembled into one UASTC KTX2, Zstandard via Node 24's
  zlib), and `checkKtx2` (basisu's UASTC → BC7 transcode vs the source, PSNR). CLI: `pnpm texpipe ktx2 <png> --role
  <map> [--levels …] [--check]`, `pnpm texpipe ktx2 --version`.
- `packages/world-render/src/ktx2.ts`: `installKtx2Decoder(baseUrl)` sets **all ten** `URLConfig` entries to
  `<baseUrl>_decoders/ktx2/*` and registers Babylon's `.ktx2` loader; `decodeKtx2(engine, bytes)` returns the
  transcoded levels without a texture (Babylon 9.28's `KhronosTextureContainer2._decodeAsync`, which answers the
  §6.7 [unknown]: the decoder returns `mipmaps[]` with `layerIndex`); `ktx2TranscodeFormat(caps, …)` mirrors the
  decoder's decision tree.
- `packages/world-render/src/texture-compressed.ts`: BC7 / ASTC 4×4 / RGBA8 2D arrays with per-layer, per-level
  uploads (WebGL2 `texStorage3D` + `compressedTexSubImage3D`; WebGPU the texture manager's `updateTexture` with the
  layer as the z origin). BC7 only with `caps.bptc`, ASTC only with `caps.astc`. TX-R wires it into `tile-atlas.ts`.

### 12.3 Transcode targets per GPU (Babylon 9.28's decision tree)

| GPU | UASTC (albedo, normal, ORMH) → | ETC1S (emissive) → |
|---|---|---|
| Apple Silicon (Safari/Chrome, WebGL2 or WebGPU with `texture-compression-astc`) | ASTC 4×4 (lossless from UASTC) | ETC2 |
| Desktop GPU (WebGL2 BPTC, or WebGPU with `texture-compression-bc`) | BC7 | BC7 |
| Neither | RGBA8 (4× the VRAM; Ultra must not be offered) | RGBA8 |

- **WebGPU on Apple Silicon:** `apps/game/src/engine.ts` `WANTED_GPU_FEATURES` requests `texture-compression-bc`
  only. Apple Silicon adapters also offer `texture-compression-astc` (and `-etc2`); without requesting them, a WebGPU
  Mac gets BC7 when BC is offered, and RGBA8 otherwise. Adding both to `WANTED_GPU_FEATURES` is a one-line 9A change
  (engine.ts is the lead's / W9A-S's file).
- **Babylon quirk:** when the transcode falls back to RGBA8 (no compressed caps), Babylon's KTX2 loader leaves the
  texture's `width`/`height` at the **last** mip's size (it overwrites them per level). The data is right; code that
  reads `getSize()` on such a texture must not trust it.

### 12.4 Measured

- The 2048×1024 upscaled male adventurer body albedo (`work/tmp/texpipe/ai/out/C1_man_adv_body.png`): 1.51 MB KTX2
  (12 levels, UASTC + RDO + zstd; about 5.8 bits per level-0 texel, 4.3 counting the mips), BC7 level 0 at 44.6 dB PSNR RGB
  against the source; 6.7 s to encode on the dev PC (CPU, while the SDXL job used the GPU).

## 13. Wave 12: the B3 terrain batch, the gates, `texpipe hero`, the tree rows (docs/TERRAIN_TEX.md, docs/WAVE_PLAN8.md D7)

- **Every terrain tile has a set** (TT-B): the 88 remaining tiles in three batches (B3a 22 paving / rock / moss tiles,
  B3b 21, B3c 45), plus the retune of the failing B1 sets, all through the **painterly ground rule** (`aiMix 0.5`,
  `aoScale 0.25`, `normalScale 0.6`, `delight 0.5`) as rows in `content/texpipe/overrides.json`; SDXL (DT-2) only on
  the B3a tiles that kept it. 108 tiles, 63 of them **hero** (the sets whose ORMH / normal maps Medium and High sample;
  the rest ship the remastered albedo only). Every B3 set is encoded with all its maps, so the hero bit is an index
  flag, never a re-encode.
- **The three terrain gates** (`review.ts` `TERRAIN_GATES`, `pnpm texpipe gates`): grain (the remaster keeps ≥ 60 % of
  the retail tile's band-pass detail at 512²), the colour lock (mean luma within ±3 levels, each channel within ±4;
  three tiles exempt by design, `COLOUR_EXEMPT`), and in game (the spot crop at Medium noon at most 3 levels darker
  than today). A failing tile stays `auto` with a note and takes the next fallback step (`aiMix` 0.5 → 0.3 → the retail
  route; `aoScale` − 0.1); a tile at a fallback step is a pass. `pnpm texpipe spots` (`terrain-spots.ts`) finds the 40 m
  patches where the game camera sees mostly one tile; the review sheet shows retail, GAN, tuned and SDXL masters with a
  3 × 3 repeat.
- **`pnpm texpipe hero <tile…> on|off`** (`hero.ts`): one validated write of `overrides.json` and of
  `work/out/pbr/index.json`, no re-encode; the World Editor's Publish calls it (at Keep, under the GPU lock) for every
  tile painted past 0.1 % of the export's terrain (`heroCandidates`). The optimized export takes the flip with the
  next `optimize-out` (Publish passes the files to its `--files` run).
- **The tree rows** (T12-B): the species' sprite and bark sets are rows of a fragment, `content/trees/texpipe-rows.json`,
  which `pnpm texpipe merge-rows [--replace]` merges into `overrides.json` key-disjoint (D7: one writer of the file);
  the index is written only by texpipe's own merge. The sprites follow `graphics.textures`: retail size in the species
  glb on Medium, the 2× tier on High and up.
- **Inventory**: `inventory.test.ts` bounds the export's textures at < 105 Mpx (the 35 species add ≈ 2.4 Mpx; I-12 /
  X2 raised it from 100).
