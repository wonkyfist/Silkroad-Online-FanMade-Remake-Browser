# Asset download size (work/out → work/out-opt)

The converter output in `work/out` is correct but heavy. A character glb is about 10 MB, because it embeds all of its
~225 animation clips. Jangan is about 73 MB. The optimizer post-processes that tree into `work/out-opt`. The relative
paths stay the same, so the loaders can switch over by changing one base URL and following the rules below.
Nothing in `work/out` or in the existing converter and loaders is modified.

```sh
pnpm tsx packages/convert/src/tools/optimize-out.ts measure [dir]   # size census + clip duplication (default work/out)
pnpm tsx packages/convert/src/tools/optimize-out.ts run --precompress
#   [--in work/out] [--out work/out-opt] [--only char/,world/] [--no-census]
```

- `run` takes about 8 minutes on the full tree.
- It writes `work/out-opt/slim.json` (the loader contract) and `work/out-opt/slim-report.json` (every number quoted below).
- It exits non-zero on any validator error or animation mismatch.
- Re-run it after re-converting anything. `work/out-opt` is a snapshot of `work/out`.
- Code: `packages/convert/src/optimize/*`. Tests:
  - `packages/convert/test/optimize.test.ts` is synthetic and needs no game data.
  - `packages/convert/test/optimize.out.test.ts` checks a finished `work/out-opt` against the targets. It skips when there is no run.

## 1. Where the bytes were (measured on work/out, 2026-09-28)

**Characters.** The 27 player character glbs total 277.9 MB.

| Part | Size |
|---|---|
| Animation key data | 170.3 MB |
| glb JSON chunk (about 19,000 channel, sampler and accessor records per file) | ~100 MB |
| Textures | 4.4 MB |
| Geometry | 1.8 MB |

- Clips: 5,982 in all.
  - 4,279 are unique within their own character; the same BAN is reused across aniGroups.
  - Only **457 are unique overall**.
- All 27 characters use two skeletons:
  - `europeman_skel`: 13 chinaman and 1 europeman, 3,076 clips, 276 unique;
  - `europewoman_skel`: 13 chinawoman, 2,906 clips, 181 unique.
- Unisex BANs (for example `skill_china_gigong_shoot_a`) are *not* byte-identical between the two skeletons. Full clips carry one-key rest channels for the untracked joints, and those differ per skeleton. So packs are per skeleton.

**Jangan world.** 73.4 MB in total.

| Part | Size | Share taken by textures |
|---|---|---|
| Model glbs | 44.8 MB | 37.1 MB embedded PNG |
| Terrain tiles (PNG) | 16.7 MB | |
| Object lightmaps (PNG) | 4.7 MB | |
| Terrain (.bin + lightmap PNG) | 3.1 MB | |
| Everything else | small | |

## 2. What the optimizer does

| Asset | Treatment |
|---|---|
| `char/`, `mob/`, `npc/` glbs that have a skin, clips and a sidecar | Animations removed from the glb. Every distinct clip (by content hash of targets, interpolation and raw key bytes) is written **once per skeleton** into animation-only packs `<root>/_anims/<skeleton>/<aniGroup>.glb`. The mesh glb keeps meshes, skin, materials and textures. |
| All glbs | `dedup` + `prune`. `KHR_mesh_quantization`: normals 10-bit, UVs 14-bit, weights 16-bit, positions see below. `EXT_meshopt_compression` in lossless mode. `EXT_texture_webp`. |
| `world/**.png` (tiles, lightmaps, terrain lightmaps, water, minimap) | Re-encoded to `.webp` at the same path. Every JSON string and glb `extras` string that resolves to a renamed file is rewritten (for example `extras.sroLightmap.uri`). |
| Everything else (ui, icons, fonts, music, data, fx JSON, `sound/`, …) | Copied unchanged. `sound/` (Ogg Opus + `index.json` + `model/*.json`, docs/SOUND.md §4) is also mirrored into out-opt by `export-sound.ts` itself (staged, then swapped in whole), so a sound re-export needs no optimizer run; its `.cache.json` is never copied. |

**Pack membership.**
- A clip that any character on the skeleton uses in its `default` aniGroup lives in `default.glb`.
- Any other clip lives in the pack of each group that uses it. 16 clips are shared by two weapon groups and are stored in both.
- So **default + one weapon pack** always covers a stance.
- Clip names inside a pack are the BAN names (`chinaman_fighter_runforward`). A name collision gets a `~<hash6>` suffix.

**Positions stay float32** in three cases (`geometry.ts` `positionQuantizationSafe`):
1. **The document has a skin.** Quantizing positions would fold a dequantization transform into the inverse bind matrices. It also clones one skin per mesh, which gives nine Babylon skeletons per character. Worse, it breaks the viewer dresser's `shared-skeleton` binding, which assumes equipment inverse binds equal the character's.
2. **A mesh node has children or is animated.** gltf-transform would insert an unnamed child node.
3. **The predicted rounding error exceeds the bound**: 0.5 mm for actors and items, 1 mm for the world. Jangan's walls span about 500 m, where 16 bits would round by 7 mm.

For everything else, quantization changes only the mesh node's matrix (scale + offset). Node names and hierarchy are untouched.

**Meshopt runs in lossless "quantize" mode.** It byte-codes what quantization produced. Animation keys are stored bit-exactly, and no quaternion or exponential filter is applied.

## 3. Before / after

Sizes on disk. "Wire" is gzip level 6 on glb/json/bin/js, with images and audio as-is. That is roughly what an HTTP server with on-the-fly gzip would send. `--precompress` also writes brotli-11 `.br` files, which are smaller still.

| Category | Before | After | Wire before | Wire after |
|---|---:|---:|---:|---:|
| **Jangan world total** | **73.4 MB** | **33.2 MB** | 64.2 MB | 26.0 MB |
| world models (212 glb + sidecars) | 44.8 MB | 20.9 MB | 40.1 MB | 17.8 MB |
| world tiles | 16.7 MB | 5.3 MB | 16.7 MB | 5.3 MB |
| world object lightmaps | 4.7 MB | 1.2 MB | 4.7 MB | 1.2 MB |
| world terrain | 3.1 MB | 2.9 MB | 0.9 MB | 0.6 MB |
| world minimap / water / navmesh / manifest | 4.1 MB | 2.9 MB | 2.0 MB | 1.0 MB |
| **char** (27 characters) | **281.1 MB** | **23.8 MB** | 116.9 MB | 11.3 MB |
| mob (46 animated) | 41.0 MB | 14.2 MB | 22.5 MB | 9.0 MB |
| npc (43 animated) | 16.9 MB | 8.4 MB | 12.2 MB | 5.8 MB |
| equipment | 17.1 MB | 10.8 MB | 14.8 MB | 8.9 MB |
| item | 14.8 MB | 8.7 MB | 14.3 MB | 8.2 MB |

**Characters.**
- The mesh glb (mesh, skeleton, WebP textures) averages **0.10 MB**, with a maximum of **0.15 MB**; the target was under 1.5 MB. The source averaged 10.3 MB.
- Sidecars grow slightly, by the `animationPacks` index; they total 3.8 MB for 27 characters.
- Packs: 17.4 MB in total for both skeletons (char), 8.6 MB for mob and 2.9 MB for npc. For `europeman_skel`:

| Pack | Clips | Size |
|---|---:|---:|
| default | 76 | 2.32 MB |
| spear | 54 | 2.09 MB |
| sword | 41 | 1.83 MB |
| bow | 34 | 1.05 MB |
| dual_axe / twohand_sword / onehand_sword / dagger / twohand_staff / onehand_staff / harf | 4–12 each | 0.12–0.52 MB |
| cart / avatar_* | 1–5 each | 0.03–0.13 MB |

- A player entering the world with a sword therefore downloads 0.1 + 2.3 + 1.8 MB **once**. Every other character of the same gender reuses both packs from the HTTP cache.
- Before, each character cost 10.3 MB, even for characters that share every clip.

Snapshot caveat: other workflows were writing into `work/out` during the run (fx, icons, more mobs and NPCs). The per-category rows above are comparable, but whole-tree totals are not.

## 4. Quality checks (numbers from slim-report.json)

Every written glb is re-read through the meshopt decoder before it is measured.

**Validator.**
- **0 errors** across every optimized glb and every pack.
- There are 18 warnings, all `NODE_SKINNED_MESH_NON_ROOT` in `blender-ref/`. The source files carry the identical 18.

**Geometry.** Positions are compared after skinning at the bind pose and at 9 sampled animation poses (3 clips × 3 times), so weight quantization is measured too.

| Set | Max position error | Max normal error | Max UV error |
|---|---:|---:|---:|
| char (positions float, weights 16-bit) | 0.001 mm | 0.094° | 4.2e-5 |
| mob / npc | 0.005 / 0.009 mm | 0.096° | 4.2e-5 |
| item (131 of 133 quantized) / equipment (24 of 126) | 0.125 mm | 0.091° | 4.2e-5 |
| world models (162 of 212 quantized) | **0.89 mm** | 0.093° | 4.2e-5 |

- Normals are compared by angle; UVs are compared absolutely.
- A UV error of 4.2e-5 is 1/47 of a texel on a 512² texture.

**Textures.** 1,600 images were re-encoded.
- Each one climbs a ladder until it passes the gate:
  1. lossy q90;
  2. lossy q95;
  3. near-lossless 40;
  4. near-lossless 60;
  5. lossless.
- **Gate: RGB PSNR ≥ 35 dB and luma SSIM (8×8 blocks) ≥ 0.98 over every texel, alpha PSNR ≥ 60 dB.**
- Alpha is always coded losslessly (alphaQuality 100). The colour under transparent texels is preserved (`exact`), so alpha-tested edges filter as before.
- Lossy WebP is always 4:2:0. Small saturated mob and equipment textures cannot pass 35 dB lossy; they cap near 32–34 dB even at q99. Those go to near-lossless instead, which keeps full chroma.

| Set | Images | PNG → WebP | Min PSNR | Min SSIM | Rungs used |
|---|---:|---|---:|---:|---|
| char | 54 | 4.41 → 1.00 MB | 35.7 dB | 0.981 | q90 43, q95 7, nl40 3, nl60 1 |
| mob | 58 | 9.24 → 3.37 MB | 35.0 dB | 0.984 | q90 40, q95 7, nl40 11 |
| world models | 574 | 37.05 → 15.17 MB | 35.0 dB | 0.981 | q90 328, q95 99, nl40 143, nl60 2, lossless 2 |
| world tiles | 43 | 16.66 → 5.34 MB | 35.4 dB | 0.982 | q90 30, q95 4, nl40 9 |
| object lightmaps | 464 | 4.65 → 1.23 MB | 35.7 dB | 0.981 | q90 460, q95 1, nl40 3 |
| terrain lightmaps | 9 | 0.47 → 0.23 MB | 44.7 dB | 0.998 | q90 9 |

No image is below the gate. `texturesForReview` (PSNR < 35 dB) is empty.

**Animation.**
- Every one of the 6,792 original clips (char + mob + npc) was compared with its pack clip: 579,580 channels, 30.35 M samples.
- The samples are taken at every key time and every key midpoint, with glTF LINEAR/slerp/STEP semantics.
- Result: **max difference 0 (bit-identical), no missing or extra channels.**
- Partial (overlay) clips keep only their tracked joints.

**Runtime.** Checked in a browser with Babylon.js 9.28 (viewer dev server, WebGL2):
- `chinaman_adventurer.glb` from out-opt loads with 10 meshes, **1 skeleton** of 43 bones and both WebP textures ready.
- The meshopt decoder is fetched from `/…/out-opt/_decoders/meshopt_decoder.js`. There are **no requests to babylonjs.com**.
- `default.glb` loads 76 AnimationGroups, and `RUN` retargets onto the character with 0 missing targets across 86 channels. The character runs.
- The Jangan gate (quantized positions, WebP lightmaps) has the same world bounding box as the original to 0.1 mm. Its `extras.sroLightmap.uri` now ends in `.webp`.

## 5. Loader requirements (for the next wave)

### 5.1 Babylon setup, once, before the first glb load

```ts
import { MeshoptCompression } from '@babylonjs/core/Meshes/Compression/meshoptCompression.js'
import '@babylonjs/loaders/glTF/2.0/index.js'   // registers KHR_mesh_quantization, EXT_meshopt_compression, EXT_texture_webp

// Local decoder, no CDN. The optimizer copies node_modules/meshoptimizer/meshopt_decoder.cjs (MIT) to
// out-opt/_decoders/meshopt_decoder.js. It is a UMD file: loaded as a classic <script> (which is what
// Babylon does), it defines window.MeshoptDecoder, and Babylon then awaits MeshoptDecoder.ready.
MeshoptCompression.Configuration = { decoder: { url: `${OUT_BASE}_decoders/meshopt_decoder.js` } }
```

- `OUT_BASE` is wherever out-opt is served, for example `/out/`.
- The alternative is to bundle the decoder with the app. That needs `meshoptimizer` as a dependency of the app: `import { MeshoptDecoder } from 'meshoptimizer/decoder'`, then set `globalThis.MeshoptDecoder = MeshoptDecoder` and point `url` at an empty same-origin script. The shipped file avoids that dependency.
- If the app ever imports the tree-shaken `*.pure.js` loader entry points, it must also import `@babylonjs/loaders/glTF/2.0/Extensions/dynamic.js` (or the three extension modules) so the extensions register.
- A CSP must allow `script-src 'self'` (the decoder), `worker-src blob:` (the decoder spins a worker) and `'wasm-unsafe-eval'`.

### 5.2 Paths

`slim.json` lists everything:
- `renamed`: old path → new path. Every `world/**.png` became `.webp`.
- `animationPacks`: every pack.
- `extensionsRequired` and `meshoptDecoder`.

The world `manifest.json` and model extras in out-opt already name the `.webp` files. A loader reading out-opt needs no extension mapping. It needs to know the rule only if it hard-codes `.png` paths.

**Wave 10 additions** (docs/COAST.md §8.1, docs/BATCHING.md §3.5, docs/GRASS_LIFE.md §3.6):
- `world/<name>/coast/field.png`: the coast field, a data image (elevation and the sea mask), read by the ocean, the shore
  and the terrain's wet band. optimize-out copies it **unchanged as PNG** (`KEEP_PNG` in packages/convert/src/optimize/run.ts):
  a WebP round trip would zero the colour channels where alpha is 0. It is the one `world/**.png` that is not renamed.
- `manifest.coast` (sea level, the field's placement, the map colour) and the coast's emitted regions are ordinary
  manifest entries; the synthetic regions carry no nav.
- The static tree variants (`models[i].staticVariant`) are ordinary static models under `models/`; the tile grass
  palettes are in the manifest's `tiles`.
- The movement packs (§5.3) are listed in `animationPacks` like every other pack.

### 5.3 Actors: glbs with `animationPacks` in their sidecar

The sidecar (`<name>.json`) gains:

```jsonc
"animationPacks": {
  "format": "sro-anim-packs", "version": 1,
  "skeleton": "europeman_skel",
  "packs": { "default": "char/_anims/europeman_skel/default.glb", "sword": "char/_anims/europeman_skel/sword.glb", … },
  "clips": { "STAND1": ["default", "chinaman_fighter_standcity"], "RUN_sword_run": ["sword", "…"], … }
}
```

- `clips` is keyed by the **same clip names** as the original glb and `sidecar.animations[]`. Events, durations and `partial` stay in `sidecar.animations`.
- `packs` names only the groups this character uses. A clip's pack is `packs[clips[name][0]]`.
- A glb without `animationPacks` (items, equipment, world objects, static mobs) still embeds its clips as before.

```ts
// One cached container per pack URL, shared by every actor on that skeleton (like ModelLibrary's cache).
const pack = await LoadAssetContainerAsync(packUrl, scene, {
  pluginOptions: { gltf: { animationStartMode: GLTFLoaderAnimationStartMode.NONE } },
})
// Per actor: retarget by joint (TransformNode) name. The pack's nodes are the skeleton joints with the same
// names and rest TRS, so the local-space keys apply unchanged; the glTF __root__ handedness node is irrelevant.
const byName = new Map(actorTransformNodes.map(n => [n.name, n]))
const [group, animName] = sidecar.animationPacks.clips[clipName]
const src = pack.animationGroups.find(g => g.name === animName)!
const clip = src.clone(`${actorId}:${clipName}`, t => byName.get(t.name) ?? t)
```

- **Loading order.** Load `default` together with the mesh; it holds STAND/WALK/RUN/DAMAGE/DIE. Load a weapon group's pack when that weapon is equipped.
- **Sharing.** Clones share the pack's `Animation` objects (`cloneAnimations` false), so do not dispose a pack container while any actor still plays a clone.
- **Cleanup.** The pack's own TransformNodes are never added to the scene; keep the container out of the scene (`addAllToScene` is not needed).
- **Retarget check.** The optimizer verified that every pack joint exists on every character using it, so `byName.get` never misses. The `?? t` only guards against future re-conversions.

**The movement pack (wave 10, docs/MOVEMENT.md §2.2).** The jump clips are our own, keyed in Blender, so no sidecar names them. Each Chinese skeleton gets one extra pack and a small index next to its other packs:

```
char/_anims/europeman_skel/movement.glb     clips chinaman_jump, chinaman_jump_run, chinaman_jump_run_fist
char/_anims/europeman_skel/movement.json
char/_anims/europewoman_skel/movement.glb   clips chinawoman_jump, chinawoman_jump_run
char/_anims/europewoman_skel/movement.json
```

- **Where they come from.** `pnpm sro moves` (packages/convert/src/tools/export-moves.ts) keys `content/moves/<skel>/*.json` in Blender headless (`tools/blender/moves/key_moves.py`, `sro.config.json` `blenderExe`). It then re-expresses Blender's export on the retail skeleton, because Blender re-orients every joint's rest frame (C = inv(G_orig_rest) · G_exp_rest per joint). It writes the pack into `work/out/char/_anims/<skel>/`, where the unslimmed `/out/` tree has no other packs. The optimizer finishes it like every pack (lossless meshopt, sampled equality check) and copies the index unchanged. The keyer's working files in `work/out/moves/` hold the retail mesh and are never copied to out-opt.
- **The pack.** Same format as every other pack: the skeleton's joints with the same names and rest TRS, and LINEAR clips at 30 fps. Every joint has a rotation channel, and a joint that leaves its rest translation also has a translation channel. The root keeps no net XZ travel, because the server move carries the body. Retarget it by joint name exactly as above.
- **Finding it.** Use the actor's `animationPacks.skeleton` (out-opt), or the basename of `skeleton.bsk` in the sidecar (unslimmed `/out/`). A missing pack means no jump clips. Nothing else changes.
- **The index** (`MovementIndex` in export-moves.ts):

```jsonc
{
  "format": "sro-movement", "version": 1, "skeleton": "europeman_skel",
  "pack": "char/_anims/europeman_skel/movement.glb",
  "clips": {
    "JUMP": { "anim": "chinaman_jump", "durationMs": 1100, "fps": 30, "frames": 34, "takeoffMs": 200, "touchMs": 633,
              "events": [{ "timeMs": 200, "type": 2, "p1": "takeoff", "p2": 0 }, { "timeMs": 633, "type": 2, "p1": "land", "p2": 0 }],
              "air": [0, 0, …] },
    "JUMP_RUN": { "anim": "chinaman_jump_run", …, "run": "RUN_chinaman_fighter_runforward_sword", "runCycleS": 0.6667,
                  "enterPhaseS": 0.3, "exitPhaseS": 0.3, "for": ["RUN_chinaman_fighter_runforward_sword", …], "blendFor": [] },
    "JUMP_RUN_FIST": { …, "run": "RUN", "enterPhaseS": 0, "exitPhaseS": 0 }
  },
  "runJumps": { "RUN": "JUMP_RUN_FIST", "RUN_chinaman_fighter_runforward_sword": "JUMP_RUN", "RUN_spear_run_fighter": "JUMP_RUN", "RUN_bow_run_fighter": "JUMP_RUN" }
}
```

- The `clips` keys are the clip names the game plays (`JUMP`, `JUMP_RUN`, `JUMP_RUN_FIST`); `anim` is the animation's name in the pack.
- `runJumps` maps every RUN a player runs (the `default`, `sword`, `spear` and `bow` groups) to its JUMP_RUN. The cart RUN is left out because a mounted jump is refused, and the avatar RUNs because their packs are never loaded. Pick the clip by `runJumps[clipFor('RUN')]`.
- A JUMP_RUN starts on its RUN at `enterPhaseS`, seconds into the RUN cycle, and hands the RUN back at `exitPhaseS`, where the base RUN must resume.
- `for` lists the RUNs it meets within 1 cm at the feet at both ends. `blendFor` lists the RUNs it serves through the client's entry and exit blends: the female sword, spear and bow RUNs, 2–16 cm apart.
- `events` use the sidecar event shape, with `p1` naming the take-off and the landing.
- `air` gives, for each 1/30 s, the lowest foot contact above the ground in metres: 0 on planted frames, never below −0.02. The entity root never rises during a jump, so this is the only height data another system can read.
- **Checked on every run** (numbers in `work/out/moves/<skel>/roundtrip.json`, repeated by packages/convert/test/moves.test.ts):
  - the retail STAND1 through Blender and back is within 0.1° and 1e-5 m (measured 0.002°, 8e-7 m);
  - the pack is within 0.1 mm of Blender's own result;
  - planted contacts are within 1 mm, planted slide is ≤ 10 mm per frame, and `air` ≥ −0.02 m;
  - root XZ excursion is ≤ 0.15 m, with ≤ 1 cm between the ends;
  - each clip is ≤ 60 KB raw (measured 21–27 KB; the packs are 106 KB and 78 KB before meshopt and brotli);
  - every player RUN maps to a JUMP_RUN.

### 5.4 Serving (apps/server `static.ts`, and the Vite `serveWorkOut` plugins)

- **Brotli.** Serve the precompressed siblings. For a GET of `x.glb`, `.json`, `.bin` or `.js` whose request has `Accept-Encoding: br` and where `x.<ext>.br` exists, send the `.br` bytes with:
  - `Content-Encoding: br`;
  - `Vary: Accept-Encoding`;
  - the **original** `Content-Type`;
  - `Content-Length` of the `.br` file;
  - a separate ETag (for example suffix `-br`).
- `--precompress` writes `.br` only when it saves at least 5%.
- **Otherwise gzip on the fly** (`zlib.createGzip({ level: 6 })`) for those same types. The "wire" column above assumes exactly that.
- **Never compress `.webp`, `.png`, `.ogg`.** They are already entropy-coded.
- **Caching.**
  - Paths are not content-hashed, so keep `no-cache` + ETag, which static.ts already does; revalidation is a cheap 304.
  - Or use `max-age=3600` for `/out/`.
  - Packs are shared across characters, so the browser cache does most of the work.
- **MIME types.** `static.ts` already maps `.webp`, `.glb`, `.js` and `.json`. `resolveSafe` rejects only dot-prefixed segments, so `_anims/` and `_decoders/` are served.

## 6. Not done, and why

- **KTX2 / Basis.** There is no local encoder (`toktx`/`basisu` are absent and no npm encoder is installed). Babylon's KTX2 decoder also defaults to the CDN.
  - WebP cuts the download but not VRAM, because textures decode to RGBA8.
  - Revisit if GPU memory becomes the limit, with a vendored transcoder under `_decoders/`.
- **Lossy animation compression.** This would use meshopt's 16-bit quaternion and 12-bit exponential filters on the packs. It would shrink packs further, but the sampled transforms would no longer be identical.
  - Packs are lossless today by design, so the equality check is exact. Size and error were not measured.
- **UI, icons, fonts, music, fx JSON** are copied unchanged. UI art must stay pixel-exact, and the rest is out of scope.
- **Loaders.** Neither the viewer nor the game reads out-opt yet (next wave).

## 7. Wave 9 additions: the sky, the renderer's own textures and the texture sets

Three new trees. The note on KTX2 in §6 is out of date: wave 9B vendored the transcoder (below).

| Where | What | Made by | Shipped |
|---|---|---|---|
| `work/out/sky/` (856 KB) → `work/out-opt/sky/` (402 KB) | `sky.json` (the index: `moonCount` 30, `fullMoon` 16, the moons, the lens flares, the retail cloud layer, the cloud noise and any export `failures`); `moon/moon01..30`, `lens/lens1..8`, `cloud1` from Map.pk2; `cloud-noise` (256², our own, seeded: R shape, G detail, B cirrus, A coverage variation, with its `sha256` and measured coverage in `sky.json`) | `packages/convert/src/tools/export-sky.ts` (docs/SKY.md §5) | yes, both trees |
| `apps/game/public/render/` (304 KB, in git) | `luts/<time>_<weather>.png`: the twelve grade keys as 32 × 1024 strips; `water-normal.png`: a 256² tileable normal map for the PBR water. Our art, nothing retail | `pnpm tsx packages/world-render/tools/make-render-textures.ts` (it rewrites both; the runtime builds the same LUT keys in memory, so an edited strip replaces its key) | with the game bundle |
| `work/out/pbr/` → `work/out-opt/pbr/` | the texture pipeline's map sets (`index.json` in the `sro-pbr` format of `packages/texpipe/src/format.ts`; `<key>/<map>@<tier>.webp`, plus `.ktx2` masters) and `work/out-opt/_decoders/ktx2/` (the vendored Babylon KTX2 transcoder, every URL local) | `pnpm texpipe` (docs/TEXPIPE.md), copied by `optimize-out` | out-opt's WebP tiers and index only; see docs/DEPLOY.md "Remastered textures" |
| `work/out/remaster/` (`manifest.json` + `sets/<part>/`, 31 MB; `staging.json` + `staging/` the review record) | the Meshy sets (`sro-remaster` manifest): the 12 the user approved on 2026-09-29 (6 clothing pieces, 6 bodies with the local face), D35: they win over the `sro-pbr` set of the same image | Meshy retexture + local maps (9B staging, then promoted to `sets/`) | `manifest.json` + `sets/` (docs/DEPLOY.md); every page loads the manifest (`?remaster=0` leaves it out), silently when it is missing. `work/out-opt/remaster/` (optimize-out's copy) is never read or shipped |

- **Optimizer rules.** `sky/**.png` goes to `.webp` like the world textures, except `cloud-noise.png`, which is data: its
  channels drive a coverage remap (SKY §5.2), so it skips the quality ladder and is lossless WebP. `sky.json` gets a
  `.br` sibling. The `pbr/` tree is copied as the pipeline wrote it (already WebP/KTX2).
- **Loaders.** The sky (`packages/world-render/src/sky/sky-system.ts`) reads `<root>sky/sky.json` (the asset root above the
  world folder: `/out-opt/sky/` or `/out/sky/`) and loads the moon of the current phase on demand. The texture sets are read by `pbr/maps.ts`
  (`loadPbrMapIndex`) for the world and by `apps/game/src/three/actor-textures.ts` for characters; a missing index is
  "no sets", never an error.

## 8. Wave 11 additions: the ridden tiger and the town's crowd

- **The ride** (`mob/china/bluetiger.glb` + `.json`, 86 KB brotli): the Blue Tiger Tiger Girl rides. `mobs.json` names it
  in `MobDef.ride {model, joint: 'saddle'}` (characterInfo's `ride` column; only `MOB_CH_TIGERWOMAN` has one). The
  client loads it in the same `EntityView.load` as the rider (`world/ride-mob.ts`) and seats her on the `saddle` joint
  with its full transform every frame; one shader hitch at first sight, not two. Low draws the same three meshes.
- **The crowd** (`out/town/`, made by `pnpm sro town`, TL-V): 29 dressed variants (retail bodies and garments with the
  retail emissive zeroed, one mesh and one material each, ≤ 3,000 triangles and one ≤ 1024² atlas), 12 baked vertex
  animation textures (half float, one per skeleton and clip set, ≈ 2 MB each; a VAT frame is the skinned pose within
  1 mm at float32 and 3 mm after quantising), and `town/index.json` (variants, clips, seats and sockets). About 15 MB in
  `out`, loaded on Medium and up only; Low never fetches it.
- **The town files** beside the world (`world/jangan-fields/`): `town.json` (TL-R's route graph, places, folk, hour
  bands and English lines; ≤ 200 KB), `town-dressing.json` (TL-B's props, banners, lamps, decals, pond profile,
  crack-grass bands) and `town-decals.json` (the resolved decals). The dressing's own props are low-poly models
  (`town/props/<name>`, ≤ 300 triangles, retail-style textures) placed through the export's placements (uid ≥ 1,000,000)
  so the batcher merges them like retail statics; the cloth reclass (`models[].cloth`) gives banners and awnings their
  per-piece sway pivots.
- **Sounds**: the two unique cues and the town's 20 synthesized files (docs/SOUND.md §9).
