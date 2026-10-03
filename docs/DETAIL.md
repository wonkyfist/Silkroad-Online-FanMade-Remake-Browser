# DETAIL: from "crisper 2005" to modern detail, without touching the UVs

The user saw a Real-ESRGAN 4× upscale of `chinaman_adventurer_body` and said: crisper, but *we need more details;
this should look like a modern AAA game, not a 2005 game*. The hard constraint is unchanged: **every texture must still
fit the existing UVs exactly.**

This document merges three research lanes (STACK: generative upscaling on this PC; DETAILMAPS: material masks and
detail maps; MESH: subdivision) with the Meshy retexture results that the remaster lane already produced. It adds
on-mesh renders made for this synthesis. It sits beside:

- `docs/TEXPIPE.md`, the texture upscale and PBR-map pipeline for the whole game (inventory, formats, budgets);
- `docs/RENDER.md`, the PBR renderer (lighting, post, presets). §8 below lists the hooks this plan needs from it;
- `docs/REMASTER.md`, the Meshy Retexture client (cloud, approved for a capped test).

No code under `apps/`, `packages/`, `deploy/` or `content/` was changed. Nothing was downloaded, and no retail asset was
uploaded by this work. Scripts and images are in `work/tmp/detail/<lane>/` and `work/tmp/detail/synthesis/`.

**Status tags:** **[measured]** = run on this PC for this plan; **[likely]** = follows from measurements or the
Babylon source but not run end to end; **[estimate]** = arithmetic from partial measurements; **[not run]** = needs
a download first.

---

## 0. TL;DR

1. **Upscaling alone cannot deliver "more detail".** A GAN (Real-ESRGAN) removes the DXT blocks and sharpens edges,
   but it *removes* texture. The leather goes plastic, the brocade washes out, and skin goes smooth [measured, STACK].
   Detail has to be *added*, in layers.
2. **Five layers each add something different, and none of them moves a UV.** In pipeline order:

   | # | Layer | What it adds | Status |
   |---|---|---|---|
   | L1 | Clean 4× upscale | Crisp edges, no DXT artefacts | done (x4plus); PBRify upscaler [not run] |
   | L2 | **Diffusion detail pass** on the albedo | New design detail that follows the painting (weave, stitching, tooling, wear, engraving) | local SDXL + ControlNet-Tile [not run: needs downloads]; Meshy Retexture [measured on 6 parts] |
   | L3 | Material masks, rich normal/height, ORM | Materials that react to light: grain, rivets, bevels, metal vs cloth, roughness variation | [measured], prototype |
   | L4 | Runtime detail maps | Crisp micro-detail up close (weave, pores, scratches) at almost no download cost | [measured] offline; engine plugin not built |
   | L5 | Subdivision L1 + LOD | Round silhouettes and smooth shading; no new detail | [measured], ready |

   The renderer (RENDER.md: shadows, IBL, SSAO, specular AA, sheen, skin translucency) is what makes L3 and L4 read.
3. **The biggest visible jump measured so far is L3 (maps) on top of L1.** See sheet 1: the leather gets real grain,
   rivets and the iron band catch the light, and roughness varies. L5 is a small, cheap extra.
4. **L2 is the only layer that invents new design detail**, and the starter outfit needs it most (sheet 3). There are
   two routes:
   - **Local:** SDXL + ControlNet-Tile through ComfyUI on the ROCm PyTorch that is **already installed and working on the
     RX 9060 XT** [measured: `torch 2.13.0+rocm10.0.0`, `cuda.is_available()=True`, 15.9 GB]. It needs **about 10.3 GB
     of downloads** (§6), uploads nothing, and can be run as often as needed.
   - **Meshy Retexture:** already approved and run on 6 parts (10 credits each). It stays faithful to the design and adds
     real detail on the sword and the shorts, but little on the leather chest, and its normal maps are nearly flat
     (sheet 5). It uploads retail parts, and the credit budget covers only the starter batch.

   **Recommendation:** approve the local stack, then A/B it against Meshy on the same parts and keep the better one per
   part. Either way, L3–L5 run locally on top.
5. **An honest ceiling.** All five layers plus RENDER.md give characters a well-lit, 2015-era MMO remaster look in
   close-ups. The low-poly silhouettes, the 2005 animation and the painted-in lighting (partly fixed by de-lighting,
   TEXPIPE §3.5) remain. "2024 AAA" needs new geometry (RENDER.md §13). This plan is the best that keeps the retail
   models and UVs.
6. **Cost summary:**
   - **One-time download:** ≈ 10.3 GB (local L2); everything else is already installed.
   - **Test batch:** about one working day, mostly human review.
   - **Whole game:** about 2 nights of GPU plus about 3 h of CPU.
   - **Runtime:** under 0.3 ms GPU on the dev PC [likely]. VRAM needs KTX2/BC7 for High (§5.3).
   - **First visit to town:** about +45–50 MB per session for character sets on the runtime-detail route (§5.4). That is
     on top of TEXPIPE's world/terrain figure (+60–90 MB at High, §6.6), and is cached afterwards.

---

## 1. Evidence: the sheets

Every on-mesh column is the real glb, rendered in Blender 5.2 EEVEE with the same camera and lights as its neighbours
(`work/tmp/detail/synthesis/render_stack.py`, a copy of the mesh lane's `render.py` plus a map-swap hook). These are
not flat-plane mock-ups.

| Sheet (`work/tmp/detail/synthesis/`) | What it shows | Honest read |
|---|---|---|
| `sheet_1_heavy_chest_layers.png` | heavy_01_ba chest on the body: retail → +GAN x4 → +maps → +subdivision, with 1.9× zooms | GAN: sharper, no new detail, leather looks like smooth plastic. **Maps: the real jump.** Leather grain, rivets and the iron band pick up light. Subdivision: rounder, subtle. Problems: the leather grain is too uniform (it reads as pebbled leather everywhere); a small painted red mark became a dark hole; the painted light is still there. |
| `sheet_2_sword.png` | sword_01: retail → GAN → maps + L1, plus flat-plane close-ups of its shared atlas | Brushed steel and hammered brass replace painted grey; the retail spec alpha drives metallic for free. **Problems:** the scratches and hammering are too loud (cut about 50%), and the grip was auto-classed as leather, so painted wood became reptile skin. The class mask needs a per-texture fix. |
| `sheet_3_starter_outfit.png` | clothes_01_ba, the white starter shirt | **Weakest case.** The weave shows up close but reads as faint canvas at game distance, and it slightly drowns the painted scale brocade. A 256-px source carries almost nothing: this is where L2 (diffusion) is needed. |
| `sheet_4_subdivision.png` | the full heavy_01 set and the base body at L0 / L1 / L2 (mesh lane) | Smoother silhouettes (shoulder pads, elbows, helmet); L1 ≈ L2. No new detail. |
| `sheet_5_meshy_vs_local.png` | retail vs Meshy multiview vs the local stack, on the chest and the sword | Meshy is faithful to the design, cleaner, and invents good detail on the sword (engraved guard, correct wood grain) and on the shorts; on the leather plates it adds little. Its normal map is nearly flat. The local stack has stronger material relief. **They complement each other** (§3). |

Lane images worth opening for detail:

- `work/tmp/detail/detailmaps/out/heavy_01_ba_05_closeup.png`: retail | ESRGAN | baked maps | runtime detail map, 2× closer.
- `work/tmp/detail/detailmaps/out/*_07_light_sweep.gif`: moving light; normal detail reads best in motion.
- `work/tmp/detail/stack/compare/*.png`: nearest | Lanczos | x4plus | x4plus-anime | animevideov3 on all 7 test
  textures.
- `work/tmp/detail/stack/uvsafe/*_overlay_small.png` and `detailmaps/out/*_06_uvfit.png`: the glb's own UV wireframe
  drawn over the new textures. The islands sit exactly on the art.
- `work/remaster/meshy/armor_compare.png`: Meshy multiview vs prompt, in texture space. The prompt variant
  redesigns the armour; reject it.

---

## 2. The layers in detail

### L1 — Clean 4× upscale (done)

- **Tool:** Real-ESRGAN `realesrgan-x4plus` (installed). The whole 7-texture test set took 11 s [measured]. The anime
  model flattens to cel shading, and animevideov3 is soft [measured]: reject both for actors except hair.
- **Better candidate:** `4x-PBRify_UpscalerV4` from PBRify_Remix (CC0, trained on CC0 material data, and made to remove
  DXT1 blocking, dithering and halos). It runs through `spandrel` on the installed ROCm torch [not run].
- **UV safety:** a uniform ×4 scale never moves a UV.
- **Alpha:** the alpha is split off first and restored afterwards (`uvsafe.py`). On armour and weapons the alpha is a
  specular/metal mask, not a cut-out (heavy_01_ba is 53% alpha 0) [measured]. PIL's RGBA resize blackens RGB under
  alpha 0; `uvsafe.py` avoids it. Blender's default "Straight" alpha mode does the same on load, which bit these renders
  until it was set to Channel Packed.

### L2 — Diffusion detail pass (the only layer that invents design detail)

**Local route (recommended; needs §6 downloads).** The pipeline is SDXL base 1.0 + xinsir ControlNet-Tile-SDXL +
fp16-fix VAE, run in ComfyUI with the Ultimate SD Upscale node:

- **Input:** the L1 output.
- **Tiles:** 1024 px, 96 px padding, seam fix "Half Tile + Intersections".
- **Denoise:** 0.25–0.35; 0.15–0.2 on the face region.
- **ControlNet:** strength 0.8, end 0.85.
- **Sampling:** 24 steps, CFG 5, DPM++ 2M Karras.
- **Prompts:** per material, e.g. "hand-painted fantasy game texture, worn tooled leather with stitching, fine fabric
  weave, subtle scratches, flat lighting, no shadows"; negative "blurry, text, photo background, harsh shadows,
  specular highlights".
- **Launch:** `--use-split-cross-attention`, because the default SDPA falls back to a slow math path on gfx1200 and the
  experimental AOTriton flag crashes [measured].

**How it keeps the UVs:** the output is an exact 4× of the same UV space, and ControlNet-Tile keeps the structure.
Every result then passes the **UV-fit gate** (`work/tmp/detail/stack/uvsafe.py`):

- **Colour fix:** low frequencies from a Lanczos upscale of the source, high frequencies from the diffusion output.
- **Alpha:** restored from the source.
- **Gutter:** push-pull fill.
- **Fidelity:** PSNR inside the UV islands of the result downsampled to source size. Accept at ≥ 28 dB and well above
  the "shifted by 1 texel" reference.

With x4plus output the gate reads 29.9–36.3 dB after the colour fix, against 19.3–28.1 dB for a 1-texel shift
[measured on body, clothes_01_ba, heavy_01_ba, sword and blade atlases]. The gate cleanly separates "still fits" from
"moved by one texel", so a diffusion tile that drifts is rejected automatically.

**Meshy route (approved, capped).**

- **Status:** Meshy Retexture with `enable_original_uv` has run on the body, hair, heavy BA/LA and the sword (10 credits
  each, `work/remaster/meshy/ledger.json`). Its UV check says "matched" on all of them [measured by the remaster lane].
- **Render comparison:** sheet 5 [measured].
- **Output format:** 4096² PNGs, square even for the 2:1 body atlas. They must be downscaled and re-encoded before
  shipping.
- **Cost:** about 10 credits per part. The starter batch is 43 parts ≈ 430 credits for one variant, so the ~1,000
  credits cover the starter batch but not the ~300 actor parts of the game.
- **Uploads:** it uploads retail parts, and the user approved that only for listed parts.

**What neither route fixes:** a character's face identity can drift (keep the face at low denoise and check it by
eye); sets can come out inconsistent (use the same prompts and seeds per set); and the style can drift towards
photoreal detail.

### L3 — Material masks, rich normal/height, ORM (prototype works)

`work/tmp/detail/detailmaps/scripts/build.py` uses numpy and PIL only and takes about 35 s per texture on the CPU
[measured]. It builds:

1. **Material masks.** K-means on Lab colour, local contrast and the retail alpha gives six classes: cloth, leather,
   metal, gold, skin and hair. They are about 85–90% right automatically [measured by eye]. Known errors: the talisman
   is marked gold, the jade blade metal, the lacquer leather, and the sword grip leather (sheet 2). **Every texture
   needs a short human check** (cluster relabels in the cfg, or a paint pass).
2. **Height:** multi-scale difference of Gaussians plus gradient edges, with per-class relief and raised bevels at mask
   borders.
3. **Normal:** macro normal from the height, UDN-blended with the class detail normal. OpenGL/glTF convention (+Y).
4. **ORM:** R = cavity AO, G = roughness (class base + detail + cavity + spec alpha), B = metallic (metal/gold masks
   gated by the retail spec alpha).

An ML alternative for normal, roughness and height is the PBRify 1× NormalV3 / RoughnessV2 / Height models (CC0,
same download). A/B them against the heuristic on the test batch [not run].

**UV safety:** every map is pixel-registered to the albedo; the `*_06_uvfit.png` overlays confirm it.

### L4 — Runtime detail maps (offline proof done; engine plugin not built)

- **Tile library:** six tileable 512² detail tiles, one per class (`work/tmp/detail/detailmaps/detail/*_babylon_detail.png`).
  They use Babylon's detail-map packing (R albedo, G/A normal, B roughness; 0.5 = neutral), checked against the 9.28
  shader source.
- **Sampling:** they are sampled with **the same UV0 × a tiling factor** (cloth 8, leather 6, metal 5), so no UV is
  added or changed.
- **Why runtime, not baked:** baked into 2048 maps, the fine detail makes the normal map almost incompressible. It costs
  4.3 MB per 2048² normal as two WebP planes, against about 1 MB at 1024 [measured, §5.4]. At runtime the six tiles
  cost **1.7 MB once** [measured, WebP q90], and they look crisper up close (the "2× closer" panels).
- **Engine limit:** Babylon's built-in `detailMap` takes **one** texture per material, and SRO atlases mix materials.
  Characters therefore need a small `MaterialPluginBase` that reads a per-texture class mask and a shared detail array
  (§8, H2).

### L5 — Subdivision L1 + LOD (ready)

- **Tooling:** `work/tmp/detail/mesh/` (Blender headless).
- **Splice pipeline:** Blender exports geometry only, and `splice.py` writes it into the original glb. The skeleton,
  inverse binds, 225 animations and attach dummies stay byte-identical [measured, `verify.py`].
- **UV safety:** UV island borders are exact (0.0 texels). Interior UVs move by a median of 0.3–2 texels on a 512×256
  atlas, because the surface itself moves; nothing leaves the retail layout [measured, `uvcheck.py`]. Slot seams show
  0 mm gaps at rest and posed [measured, `seamcheck.py`].
- **Recipes per class:**
  - body: weld, linear UVs, welded normals, no fit;
  - armour: locked borders plus the anti-shrink fit, so the millimetre layering survives;
  - weapons: 60° creases, locked borders and the fit;
  - hair cards: skipped.
- **Triangle counts:** dressed heavy character 1.85k → 7.8k (L1); weapons about 100 → 450. L2 (×16) looks the same as
  L1: do not ship it.
- **LOD:** L1 within about 12–15 m (or above about 15% of screen height), the retail L0 beyond it, on the shared
  skeleton.

---

## 3. How the layers combine

```
retail DDJ ─► L1 clean 4x ─► L2 diffusion (local SDXL or Meshy) ─► uvsafe gate ─► de-light (TEXPIPE §3.5, k 0.2–0.3)
                                                                                         │
             L5 subdivision (glb) ◄───────── independent ─────────┐                      ▼
                                                                   │      L3 masks (+human fix) ─► normal / ORM / height
                                                                   │                              + class mask for L4
                                                                   ▼                                      │
                                                        RENDER.md PBR + SroDetailPlugin (L4) ◄────────────┘
```

- **L2 before L3.** The maps must be derived from the final albedo, or new diffusion detail will not have matching
  relief. Diffusion does not produce consistent PBR maps: Meshy's normals come back nearly flat [measured].
- **Meshy output is treated as an L2 result.** It enters at the uvsafe gate (colour fix and fidelity check against the
  source), then goes through the same L3.
- **L5 is independent.** It can ship first, because it changes no texture.

---

## 4. The UV rule, per layer

| Layer | Why the UVs still fit | Automatic gate |
|---|---|---|
| L1 | uniform ×4 of the same UV space | size check |
| L2 | same UV space; ControlNet-Tile keeps structure; colour fix | `uvsafe.py` fidelity ≥ 28 dB inside islands and well above the 1-texel-shift reference, plus the overlay |
| L3 | maps are pixel-registered to the albedo | overlay (`*_06_uvfit.png`) |
| L4 | UV0 × tiling factor; no new UV set | none needed |
| L5 | borders pinned, interior at most about 2 texels median drift | `uvcheck.py`, `seamcheck.py`, `verify.py` |
| Meshy | Meshy returns the uploaded UVs | the remaster lane's UV check (`maxDelta 0`), then `uvsafe.py` on the texture |

**Shared atlases** (`sword1_2_3`, `blade1_5`, probably `spear_1_5`) hold islands of items that are not converted: the
three `sword_0x` models cover only 23% of their atlas [measured]. The gutter fill and masks must use the **union of
every model that references the texture**, or run without a gutter fill. Otherwise other items' art gets wiped.

---

## 5. Costs

### 5.1 One-time downloads and disk (dev PC only)

- **Local L2 stack:** ≈ **10.3 GB** (weights 9.9 GB + pip wheels 0.3–0.5 GB + a small git clone), about 11 GB on disk.
  Itemised in §6.
- **L3, L4, L5 and the gate:** nothing; they run on what is installed.
- **Meshy:** no download; it costs credits.

### 5.2 Processing time

| Scope | Step | Time | Tag |
|---|---|---|---|
| **Test batch** (§7: 36 outfit pieces + 2 body + 2 hair atlases + 3 weapon atlases ≈ 43 textures, 41 glbs) | L1 GAN x4 | < 1 min | [measured rate] |
| | L2 SDXL tiles: ≈ 70 tile passes × 15–25 s, 2 seeds | ≈ 1 h | [estimate: STACK micro-benchmarks, not a real SDXL run] |
| | uvsafe gate | seconds each | [measured] |
| | L3 maps: 43 × 35 s | ≈ 25 min | [measured rate] |
| | **Human mask fixes and review** (2–5 min each) | **1.5–3.5 h** | [estimate] |
| | L5 subdivision + gates, 41 glbs | ≈ 10–15 min | [likely] |
| | **Total** | **about one working day, mostly review** | |
| **Whole game** (1,213 textures, 91.4 Mpx; TEXPIPE §1.1) | L1 GAN x4 | ≈ 20 min | [measured rate] |
| | L2 SDXL, 1 seed: actors 22.7 Mpx ≈ 570 tile passes, world ≈ 870, terrain ≈ 540 | **≈ 8–14 h GPU (2 nights)** | [estimate] |
| | L3 actors: 321 × 35 s | 3.1 h on 1 core, ≈ 35 min on 6 processes | [likely] |
| | World/terrain PBR (TEXPIPE's TypeScript derivation) | ≈ 15 min | [measured rate] |
| | L5 on ≈ 155 actor glbs | ≈ 30 min | [likely] |
| | **Human review** of the hero set (≈ 120 textures × 3 min); the rest spot-checked | **≈ 6 h** | [estimate] |

The SDXL rate (0.5–0.8 s per step at 1024 with CFG) is extrapolated from a matmul/conv benchmark and a 9070 XT report.
**The first real run must measure it** (§7, step 3).

### 5.3 Runtime GPU

| Item | Cost | Tag |
|---|---|---|
| Normal + ORM sampling (L3), per character pixel | +2 samples; characters cover about 10% of a 1080p frame | [likely] |
| `SroDetailPlugin` (L4): class mask + 2–4 detail-array samples, fades out by distance | ≈ 0.05–0.15 ms on the RX 9060 XT; ×5–10 on an iGPU | [likely] |
| Subdivision L1: 20 dressed characters ≈ 160k skinned triangles (×2 with the shadow pass) | < 0.2 ms GPU; same draw calls, so no CPU cost | [likely] |
| Specular anti-aliasing, sheen (cloth) | negligible to small | [likely] |
| **VRAM per 1024² armour piece** (albedo + normal + half-size ORM + half-size class mask, with mips) | **≈ 14 MB RGBA8, ≈ 3.5 MB BC7** | [arithmetic: 5.3 / 1.33 B per texel] |
| VRAM, body atlas 2048×1024 (same map set) | ≈ 28 MB RGBA8, ≈ 7 MB BC7 | [arithmetic] |
| **VRAM per dressed character** (6 pieces + body) | **≈ 110 MB RGBA8, ≈ 28 MB BC7** | [arithmetic] |
| 10 different outfits on screen | ≈ 1.1 GB RGBA8 vs ≈ 280 MB BC7 | [arithmetic] |
| Shared detail array (6 × 512²) | ≈ 8 MB once | [arithmetic] |

**Consequences:**

- Armour pieces ship at **1024** (4× of 256), with L4 providing the close-up detail. 2048 buys little over 1024 +
  runtime detail and quadruples memory.
- **KTX2/BC7 (TEXPIPE §6.7, RENDER.md §15 item 2) is a prerequisite for full character sets on High.** Without it,
  Medium uses albedo plus class defaults only.

### 5.4 Download per session (the friends' side)

Measured on the prototype outputs: WebP q90, normal as two grey planes, ORM at half size (TEXPIPE's v1 format).

| Set | 1024 | 2048 |
|---|---:|---:|
| heavy_01_ba, **baked** fine detail (normal planes are most of it) | 1.5 MB (normal 1.1) | 5.2 MB (normal 4.3) |
| clothes_01_ba, baked | 1.3 MB | 5.2 MB |
| chinaman body 1024×512 / 2048×1024 | 0.26 MB | 0.97 MB |
| sword atlas | 1.8 MB | 5.1 MB |
| 6 shared detail tiles (runtime L4) | 1.7 MB once | |
| Subdivided glbs | +55 KB per item (heavy_01_ba 147 → 202 KB), +0.15 MB per body glb | |

- **Runtime-detail route** (bake only the macro normal, L4 adds the fine grain): ≈ 0.5 MB per 1024 piece [likely],
  ≈ 3.5 MB per dressed character.
- **Town with about 20 friends** (≈ 10 distinct outfits + 5 weapon atlases): ≈ **45–50 MB** on the first visit, cached
  afterwards [estimate]. The same scene with baked 2048 sets is ≈ 350 MB. **Choose the runtime route.**
- World and terrain textures add TEXPIPE §6.6's figure (+60–90 MB at High).
- **Host disk:** actor sets add ≈ 0.2–0.3 GB to the deploy.

---

## 6. Downloads the user must approve

Nothing below has been downloaded. Sizes and licences come from the pages as fetched in Sept 2026; recheck them at
download time. Only items 1–7 are needed for the recommended plan.

| # | What | URL | Size | Licence |
|---|---|---|---:|---|
| 1 | ComfyUI source, tag **v0.37.0** (reuses the installed torch 2.13.0+rocm10.0.0; no torch download) | https://github.com/comfyanonymous/ComfyUI | tens of MB | GPL-3.0 (tool only, not redistributed) |
| 2 | ComfyUI's pip requirements (torchsde, einops, transformers, safetensors, aiohttp, kornia, spandrel, comfyui-frontend-package, …), installed with a **constraints file pinning the ROCm torch** and a `--dry-run` first | PyPI | ≈ 0.3–0.5 GB | mostly MIT/BSD/Apache; comfy packages GPL-3.0 |
| 3 | ComfyUI_UltimateSDUpscale custom node | https://github.com/ssitu/ComfyUI_UltimateSDUpscale | ≈ 2.7 MB | GPL-3.0 |
| 4 | SDXL base 1.0 checkpoint | https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors | 6,938 MB | CreativeML Open RAIL++-M |
| 5 | ControlNet Tile SDXL (xinsir) | https://huggingface.co/xinsir/controlnet-tile-sdxl-1.0/resolve/main/diffusion_pytorch_model.safetensors | 2,502 MB | Apache-2.0 |
| 6 | SDXL VAE fp16-fix | https://huggingface.co/madebyollin/sdxl-vae-fp16-fix/resolve/main/sdxl_vae.safetensors | 335 MB | MIT |
| 7 | PBRify_Remix v1.7.2 (4× DXT-cleaning upscaler; 1× normal, roughness and height models) | https://github.com/Kim2091/PBRify_Remix/releases/download/v1.7.2/PBRify_Remix-1.7.2.zip | 111 MB | CC0-1.0 |
| | **Total for the recommended plan** | | **≈ 10.3 GB** | |
| opt | 4x-UltraSharpV2 (best general GAN pre-upscaler) | https://huggingface.co/Kim2091/UltraSharpV2/resolve/main/4x-UltraSharpV2.safetensors | 140 MB | CC-BY-NC-SA-4.0 (non-commercial; fine for a private project) |
| opt | scipy / opencv-python / scikit-image (faster L3 filters, better mask edges, superpixels) | PyPI | ≈ 40 / 40 / 13 MB | BSD-3 / Apache-2.0 / BSD-3 |
| fallback | ComfyUI Windows portable for AMD (bundles its own ROCm 7.1.1 torch), only if the shared-torch venv misbehaves | https://github.com/comfyanonymous/ComfyUI/releases/download/v0.37.0/ComfyUI_windows_portable_amd.7z | 1.49 GB | GPL-3.0 |
| fallback | GAN-only models for the installed ncnn binary (no diffusion): 4x-UltraSharp fp16 (.bin 33.4 MB + .param), 4x_NMKD-Siax_200k (66.8 MB), 4xNomos8kSC (33.4 MB) | huggingface.co/Kim2091/UltraSharp (NCNN/); github.com/upscayl/custom-models (models/) | 33–67 MB each | CC-BY-NC-SA-4.0 / WTFPL / CC-BY-4.0 |
| later | basisu or KTX-Software, plus the vendored Babylon KTX2 transcoder files (needed for §5.3 BC7) | see TEXPIPE §9 items 5–6 | 5–25 MB + 1–3 MB | Apache-2.0 |

**Rejected:**

- SUPIR and HYPIR (non-commercial, tuned for photo restoration);
- SeedVR2 (≈ 18 GB at fp16, fp8 unverified on ROCm/Windows);
- FLUX.1-dev and the Jasper upscaler (non-commercial, 12B);
- FLUX.2 klein 4B (no tile ControlNet yet; revisit);
- torch-directml (stuck at torch 2.3), ZLUDA (superseded), Amuse (final version).

**Install notes:**

- Create a venv with `--system-site-packages` inside `work/tools/comfyui`.
- Bind to `127.0.0.1` only, and install no API or cloud nodes.
- Never set `TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1`.
- The full step list is in the STACK lane's recommendation and is repeated in §7, step 2.

---

## 7. Pipeline order for the test batch

**Test batch:**

- the starter outfits: `clothes_01`, `light_01`, `heavy_01` × {aa, ba, fa, ha, la, sa} × man/woman = 36 textures;
- the bodies: `chinaman_adventurer` and `chinawoman_adventurer` (body and hair atlases);
- the starter weapons: `sword1_2_3`, `blade1_5` and `spear_1_5` (shared atlases);
- terrain afterwards.

Every step writes under `work/`, keeps retail art local, and ends in a gate.

**0. Now, with no downloads.**

- Ship **L5** (subdivision L1) for the batch's glbs through the splice pipeline, with `verify.py`, `uvcheck.py` and
  `seamcheck.py` as automatic gates. Review by eye per item: creases on the pads and helmet, armour layering in 3 poses.
- Run **L1 + L3** (x4plus + masks/maps) on all 43 textures. Fix the class masks by hand; the known errors are listed in
  §2 L3.
- Result: the sheet-1 look across the whole batch.

**1. The user approves §6 items 1–7.** The install takes about 30 minutes plus the download time.

**2. Install.**

1. `git clone --branch v0.37.0 --depth 1 https://github.com/comfyanonymous/ComfyUI work\tools\comfyui`
2. `py -3.12 -m venv --system-site-packages work\tools\comfyui\.venv`
3. Write a constraints file pinning `torch==2.13.0+rocm10.0.0` and the matching torchvision/torchaudio.
4. Run `pip install --dry-run -r requirements.txt -c constraints.txt`, and confirm no torch* package would be replaced.
   Then install for real.
5. Clone the custom node into `custom_nodes\`. Put the models into `checkpoints\`, `controlnet\`, `vae\` and
   `upscale_models\`.
6. Launch with `--listen 127.0.0.1 --use-split-cross-attention --disable-pinned-memory`.
7. Check that the log names the RX 9060 XT with about 16 GB.

**3. Calibration run** (3 textures: heavy_01_ba, clothes_01_ba, the body atlas).

- Measure seconds per tile.
- Sweep denoise over 0.2 / 0.3 / 0.4 × 2 seeds.
- Pass each result through `uvsafe.py`.
- Render with `render_stack.py` next to the Meshy result for the same part.
- **Go/no-go with the user**, per material class: local SDXL, Meshy, or neither.

**4. L2 on the whole batch.** Order: outfits, then bodies (face masked to ≤ 0.2 denoise), then weapons (union-of-models
masks, §4). Use one prompt set per outfit set and fixed seeds, so the six pieces of a set match.

**5. Gate.** `uvsafe.py` rejects any result under 28 dB or too close to the 1-texel-shift reference; re-roll it at
lower denoise.

**6. De-light** (TEXPIPE §3.5, k 0.2–0.3 on actors).

**7. L3** on the final albedo:

- masks: reuse the step-0 fixes; the class layout does not change with L2;
- normal/ORM/height: A/B the heuristic against the PBRify NormalV3/RoughnessV2 models;
- export: the macro normal at 1024, and the class mask for L4.

**8. Review on the mesh.**

- `render_stack.py`: turntable views, each outfit at L0 retail vs final.
- Then in-engine once RND-M and the L4 plugin exist (§8). The user signs off from screenshots in the game, as the
  wave-9 decisions ask.

**9. Encode and index** per TEXPIPE §6: 1024 tier, WebP v1 now, KTX2 later. Add the `class`, `classMask` and
`detail` fields (§8, H1).

**10. Terrain, last.**

- Terrain tiles are **tileable**, not UV atlases, so the constraint is different: seamless wrap.
- L2 needs wrap padding (tile across the wrapped edge, crop the centre) and a seam check (TEXPIPE §7.2's edge/interior
  ratio of about 1.0–1.5).
- L3 uses TEXPIPE's terrain classes; L4 is RENDER.md §6's terrain detail layer.
- **Nothing in this plan was tested on terrain yet.** Run it on the 16 hero tiles (TEXPIPE §1.3) first.
- The user's recorded option of prompt-generated original terrain materials (TEXPIPE §5) competes here, and needs a
  separate decision.

---

## 8. Hooks needed from the renderer (proposals for RENDER.md; that file was not edited)

These are what make L3 and L4 actually read in the game. Babylon names are **[confirmed]** in
`@babylonjs/core` 9.28.0 unless tagged.

| # | Hook | Why | Where |
|---|---|---|---|
| H1 | `PbrSet` fields: `classMask` (half-res RGBA: cloth, leather, metal, skin; gold = metal + tint; hair by material) and `detail` (`{ set: "actor", tiling: {cloth: 8, leather: 6, metal: 5, skin: 6} }`) | selects and scales the per-class detail | RENDER.md §3.2, TEXPIPE §6.2 (optional fields; version stays 1) |
| H2 | **`SroDetailPlugin`** (`MaterialPluginBase`). Samples the class mask and a shared 2D-array of the six packed tiles at UV0 × tiling, with a distance fade. Hooks: albedo modulation in `CUSTOM_FRAGMENT_UPDATE_ALBEDO`; UDN normal blend where RENDER §3.5 overrides `normalW`; roughness modulation in `CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS` | L4; the built-in `detailMap` (`DetailMapConfiguration`, one texture per material) cannot mix classes on one atlas | new, beside RENDER.md's `SroSurfacePlugin`. The tangent frame from UV derivatives [likely] |
| H3 | `PBRMaterial.enableSpecularAntiAliasing = true` on every material with a normal map | stops high-frequency normals from sparkling and aliasing as the camera moves | RND-M |
| H4 | `sheen` (`PBRSheenConfiguration`) on the cloth class | the soft rim of silk and cotton; a cheap, big "modern" cue on the starter shirts | RND-M, class table |
| H5 | `anisotropy` (`PBRAnisotropicConfiguration`, `direction`, `texture`) on brushed blades | brushed-steel highlight streaks; only where the brushing direction follows UV-U [likely for blades] | RND-M, weapons only |
| H6 | Skin: `subSurface.isTranslucencyEnabled` on Ultra (already in RENDER §3.3), plus a skin specular F0 of about 0.028 | skin still looks dry without it; the textures cannot fix that | RND-M |
| H7 | Character LOD: `addLODLevel` with L1 near and retail L0 beyond about 12–15 m, on the shared skeleton | keeps crowds cheap | RND-G / models loader |
| H8 | Normal convention test: `normal_gl` (+Y) through the loader, checked on a lit test mesh with the converter's Z mirroring; `invertNormalMapX/Y` if it is wrong | mirrored UV halves (torso) and the converter's handedness | RND-I lab |
| H9 | Tangents: the retail glbs have none. Babylon then derives a per-pixel frame from UV derivatives, which handles the mirrored halves [likely]. If MikkTSpace tangents are ever written, write them **after** subdivision | correct normal maps on mirrored atlases | converter, later |
| H10 | KTX2/BC7 for character sets on High | §5.3 memory | TEXPIPE §6.7 |

The lighting in RENDER.md matters as much as any texture: cascaded shadows on characters, sky IBL, SSAO and a moving
light. The detail in sheets 1–2 is only visible because the light grazes it.

---

## 9. Risks and open questions

**Diffusion (L2)**

- **Unmeasured.** No SDXL run has happened here. Speed and quality are projections until step 3 of §7.
- **Content drift:** identity drift on faces, invented content across island borders or tile seams, inconsistent sets,
  and a photoreal style push. Mitigations: denoise ≤ 0.35, ControlNet-Tile ≥ 0.8, colour fix, the PSNR gate, fixed
  prompts and seeds per set, and review by eye on the mesh.
- **Install risk:** ROCm on Windows is new. pip may try to swap the ROCm torch for a CPU wheel (use the constraints file
  and `--dry-run`); the VAE decode may run out of memory (use tiled VAE); the ComfyUI blog recommends AMD's preview
  driver.

**Detail maps and masks (L3/L4)**

- **Mask errors** (85–90% right automatically) cost human time on every texture. The sword grip and the chest
  decal show the failure modes.
- **Amplitudes** were tuned on a flat plane. On the mesh the sword's scratches and hammering and the chest's leather
  grain are too strong or too uniform. Tune them on the mesh.
- **Detail direction** follows the UV islands, not the cloth or blade direction. Weave or brushing can turn at seams.
- **Painted-in lighting** stays in the albedo unless it is de-lit.

**Subdivision (L5)**

- It adds no detail. Do not sell it as the "more detail" fix.
- Each vertex has up to 4 bone weights (retail has 2).
- Only heavy_01 layering was checked, in 2 poses.
- Hard-surface chamfers need a per-item crease review.
- The `out-opt` slim step and the sidecar counts have not been re-run on subdivided glbs.

**Meshy**

- It uploads retail parts; the user approved that only for the listed parts.
- The 4K square outputs must be downscaled.
- Its normals are flat.
- The credits run out after the starter batch.
- TEXPIPE §5 recorded the "nothing uploaded" vs Meshy conflict. The 18:28 update in `work/tmp/w9-user-decisions.md`
  resolves it for the capped test only.

**Housekeeping for the lead**

- This synthesis briefly wrote renders to `C:\synthesis\` (Blender resolved a relative output path against `C:\`).
  They were moved into `work/tmp/detail/synthesis/renders/` and the folder was removed.
- A `C:\renders\test_L0_full_clay.png` from another lane (18:23, not this one) is still there. It is a clay render
  with no texture; delete it after checking.

**Questions for the user**

1. Approve the §6 downloads (≈ 10.3 GB) for the local diffusion pass? Or use Meshy only for L2 on the starter batch
   (≈ 430 credits), or skip L2 for now and ship L1 + L3 + L5 (the sheet-1 look)?
2. Is it OK that L2 changes the painting slightly (new stitching, weave, wear) while keeping the design and the UVs?
3. Ship 1024 armour sets with runtime detail (≈ 50 MB per first session) rather than 2048 baked (≈ 350 MB)?
4. Approve KTX2 tooling (TEXPIPE §9 items 5–6), needed for full character sets on High.
