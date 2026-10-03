# Sky upgrade (SKY2): volumetric clouds, sky-coloured haze and shafts, GPU IBL, auto exposure, ambient light

This is the **sky half of wave 10**. The user asked for it together with the sea: "Sky and sea, as one wave". Their
reason: "They share the same code (sky, haze, water), so building them together avoids doing it twice." The coast is
docs/COAST.md. New 3D models for trees ("New 3D models for TREE'S only for time being") are docs/TREES.md. This spec
makes no tree geometry; §8.4 lists what the new trees need from the sky and the light. docs/WAVE_PLAN4.md will merge
the three specs.

It upgrades what wave 9 built (docs/SKY.md, docs/RENDER.md, `packages/world-render/src/sky/*`, `render/*`,
`pbr/fog-plugin.ts`) with techniques from **Tidewater** (github.com/dgreenheck/tidewater, MIT). Those techniques are
adapted to Babylon 9.28 and to the limits wave 9 measured. The biggest of those limits: **High is CPU-bound**. On WebGPU
it holds a 17.9–21.5 ms p95 at the plaza and in the crowd, with 2.3–4.3 ms of GPU work (work/tmp/w9-finish/budgets.md).

**Read with:** docs/SKY.md §3–§6 and §9, docs/RENDER.md §4.2, §5 and §11, docs/WAVE_PLAN3.md §4–§5 (its format is used
here), docs/COAST.md §2.3, §8.6, §8.12 and **§8.13 (the shared seams S-HAZE … S-NOTICE)**, `work/tmp/tidewater-notes.md`,
and `work/tmp/w9-user-decisions.md`.

**The prototype:** `work/tmp/sky2/` (index.html, main.ts, shaders.ts, results.json, two images). §11 describes it.

## Status tags

- **[confirmed]**: checked in this repo, in `@babylonjs/core` 9.28.0 (`apps/viewer/node_modules`), or measured by the
  prototype. Each tag says how.
- **[likely]**: strong evidence, not proven. **Every statement about what Tidewater does is at most [likely]**. Its
  files were read at commit `4811ba4` (the commit COAST pinned) through a fetch tool that summarises. The lanes re-read
  each file at `4811ba4` before porting from it.
- **[projected]**: a cost scaled from a measurement, or estimated from tap and step counts. Each one says from what.
- **[unknown]**: open. Each one has a default and says how to settle it.
- **[decision]**: a choice this spec makes. The user or the wave plan may overrule it.

## §F What the fact-check corrected (adversarial fact-check, 2026-09-29)

Every [confirmed] claim was re-derived from the code, Babylon 9.28's source, `work/tmp/sky2/results.json` and the
prototype source. The GPU numbers match `results.json`; no GPU re-run was needed (none was made, so no GPU lock was
taken). Scratch checks: `work/tmp/sky2-fc/` (a WebGL2 texture-unit count per preset, a noise-compression replica).

| # | What the draft said | What is true, and how it was checked | Where fixed |
|---|---|---|---|
| F1 | The GPU IBL moves each refresh into the stable cube with `_swapAndDie`, "so there is no dirty flag and no recompile" | On WebGPU that is the trap, not the fix. `_swapAndDie` gives the target a new `uniqueId`, but `WebGPUMaterialContext.setTexture` compares the cached texture's **live** `uniqueId` with the same object's, so nothing is marked dirty, and `WebGPUCacheBindGroups.getBindGroups` returns the draw's old bind groups, which still hold views of the released texture [confirmed: `webgpuMaterialContext.js` 47–84, `webgpuCacheBindGroups.js` 63–70, `internalTexture.js` 429–439]. The outcome ("Destroyed texture used in a submit", a dropped frame) is [likely], not run. `HDRFiltering` presumably gets away with it because it runs before any material has bound the texture [likely]. **Now:** two persistent cubes (a source cube and the live cube); nothing is ever swapped into a live texture. | §0, §3.8, §6.2, §6.3, §15, §17 |
| F2 | The cloud-shadow lookup is "one bilinear tap at the ground point projected up the key light", with `skyCloudProj.z` the layer base | The prototype's two kernels disagree: `SHADOW` indexes the map by the **ground** point (y = 0), and the froxels' `cloudShadow(p)` looks it up with the point projected **up to the cloud base** (5.9 km off at the prototype's 15° sun, beyond the 1,024 m half-size, so it read the clamped edge) [confirmed: `work/tmp/sky2/shaders.ts` `SHADOW` vs `CLOUD_SHADOW`]. The measured cost stands (one tap either way); the look of the prototype's cloud shafts was not validated. **Now:** the map is indexed on a reference plane at the camera's height, and the uniform packing says so. | §4.8, §9, §11 |
| F3 | The haze colour is `skyView(dirH)` + sun glow, mixed with the retail fog at `gradeW` "0.3 by day" | `GRADE_FOG` is **0.65 by day** (keeps the noon fog within ΔE 10 of retail) and 0.3 near sunset [confirmed: `sky-system.ts` 133, 150, 945]. Today's fog colour also mixes toward the **cloud** colour by 0.6 × cover and desaturates by 0.3 × precipitation [confirmed: `sky-system.ts` 940–953]. The sky-view LUT is a clear sky, so without that term an overcast horizon would be blue under grey clouds: a seam. **Now:** the formula keeps both weather terms. | §5.1 |
| F4 | Past 320 m the froxel path "uses the last slice, which is ≥ 97 % fogged" | COAST S-HORIZON needs ≥ 99.9 % at the sea's 2,000 m clip line [confirmed: COAST §8.13]. 97 % leaves the sea's own colour showing at the horizon. **Now:** past the last slice the transmittance continues analytically. | §5.3 |
| F5 | Samplers per material [unknown]; the risk is WebGPU's default 16 | The binding limit is **WebGL2's 16 texture units** (D32), where every player is today. Counted (NullEngine, GLSL, `work/tmp/sky2-fc/d32-count.test.ts`, terrain PBR, every weather level): **Medium 13 of 16** incl. the cluster's 2, so `skyView` fits (14); **High 16 of 16** without the tier plane (the ring counted), so High must stay net 0 [confirmed]. | §3.5, §15 |
| F6 | `graphics.advanced` gains `ao: 'auto' \| 'off' \| 'ssao' \| 'gtao'` | `ao` already exists with `'auto' \| 'off' \| 'half' \| 'full'` [confirmed: `settings.ts` 166–172]; redefining it would reset saved values. **Now:** a new `aoMethod` row. `lightShafts` also exists already and is reused. | §9, §13 |
| F7 | High CPU ≈ +0.06–0.1 ms; S2-V CPU budget ≤ 0.03 ms | The measured mean for the 5 dispatches + UBO is **0.09 ms** (the parts sum to 0.06; 0.03 ms is unexplained), so High is **≈ +0.1 ms**, and a 0.03 ms S2-V budget is below the UBO update alone (0.044 ms) [confirmed: `results.json`]. | §0, §4.12, §10 |
| F8 | Parallax 10 m/s ÷ 2,000 m, "1,440 px over a 0.9 rad field of view, about 1,600 px/rad" → 0.13 px | Babylon's `fov` is vertical; the game's is 0.85 [confirmed: `screens/world.ts` 123]. The focal length at 0.75× 1080p is 405 / tan 0.425 ≈ 894 px/rad; clouds are ≥ 1.5 km up; a horse runs 9 m/s [confirmed: `content.ts` 670]. → 0.12 mrad and **0.11 px per frame**: the conclusion stands, the arithmetic is fixed. | §4.5 |
| F9 | Noise download "up to about 8 MB"; compressed size [unknown] | A numpy replica of the prototype's shape recipe compresses to **7.35 MiB (gzip 6) / 7.18 MiB (xz)**; the R8 variant to 1.36 MiB [projected: `work/tmp/sky2-fc/noise_size.py`]. The optimizer precompresses only `.bin`/`.json`/… (`measure.ts` `COMPRESSIBLE`), so the files are named `.bin`. | §4.2, §16 |
| F10 | IBL: "about 30 small draws" per refresh; SH9 = one pixel per coefficient summing 1,536 taps; the SH comes "from the CPU skySH per LUT" | The draft's own schedule was 6 + 36 + 1 = **43 draws**; with the live-cube level-0 pass it is **49**. One thread doing 1,536 serial taps is a latency chain (≈ 0.1 ms on the dev PC, more on Apple) [projected]; now 9 × 6 pixels, one per coefficient and face. `SkyState.sh` is L1, refreshed ≥ once a second by the sky system, and read by `grass-chunks.ts` too [confirmed: `sky-system.ts` 866–870, `grass-chunks.ts` 455]; it stays. | §6 |
| F11 | Smaller items | `postExposure(scene)` is `sceneExposure(scene)`; WebGPU `readPixels` reads the canvas (a render target's readback is `_readTexturePixels`); `gpuTimeInFrame` exists only for compute shaders built while timing was on; the prototype did not use `fastMode`; the "16-varying → at most Medium" cap lives in `settings.ts`, not WAVE_PLAN3 §5.1; the foliage plugin does not call `sroCloudShadow` today; GTAO's "no clear hack" is wrong (grass and Classic water never write the prepass); the Medium default now applies to every adapter; the COAST notices test is `tidewater-notices.test.ts`; `POST_STAGE_ORDER` still lists `'vls'`; VRAM missed the 1 MiB weather map; the resolve's 0.027 ms ran from the GPU's cache. | throughout |
| F12 | (missing) | With the release default at Medium and every player on WebGL2 until HTTPS, **nobody sees the volumetric clouds, cloud shadows or shafts** until HTTPS is set up and a friend picks High. This is now a "needs from the user" item. | §16, §17 |

---

## 0. Decisions (TL;DR)

1. **Where each piece runs.**

   | Piece | Low | Medium | High | Ultra |
   |---|---|---|---|---|
   | Clouds | retail `cloud1` plane (unchanged) | wave 9's 2.5D cumulus (unchanged) | **volumetric**, WebGPU compute; the WebGL2 fragment fallback only if LAB's CPU check passes (§4.10) | volumetric, finer (both backends) |
   | Haze | retail linear fog (unchanged) | **sky-coloured haze**: the extinction of the wave-9 height fog, coloured per pixel from the sky-view LUT, with a sun glow | + **sun shafts** from a froxel volume (WebGPU) | + shaft temporal filter, finer volume |
   | IBL | — | **GPU time-sliced prefilter** (32² cube, SH9) | GPU, 64², clouds from the volumetric panorama | GPU, 64², faster refresh |
   | Exposure | — | SkyState × trim × **auto exposure** (±0.5 EV) | ± 1 EV | ± 1 EV |
   | Ambient | — | **ground bounce** (sun lobe in the SH) | + **GTAO** replaces SSAO2 (after an A/B) | + contact shadows |

   Low is untouched, and the Low guard (`seams-classic.test.ts`) holds.
2. **Volumetric clouds** ([decision]; §4):
   - **Density:** Nubis-style: a weather map, a 128³ shape noise and a 32³ detail noise.
   - **The march:** each frame, one pixel in each 4 × 4 block is marched, at 0.6–0.75 × screen resolution. The rest
     come from the clouds' own reprojected history, not from TAA.
   - **Empty space:** coarse steps on the weather map, switching to fine steps inside clouds.
   - **Two by-products:** a 256² cloud-shadow map around the camera, refreshed a quarter at a time, and a low-res
     panorama for the IBL.
   - **Measured on the dev PC** ([confirmed], §11): **0.32 ms of GPU** for the march at Ultra-like settings (128
     steps, 6 light taps), about 0.17–0.19 ms projected for High's settings. Resolve 0.03 ms (warm cache; up to
     ≈ 0.06 ms in a full frame [projected], §4.12), shadow map 0.003 ms, panorama 0.04 ms.
   - **CPU:** **3 µs per dispatch** (Babylon ComputeShader, no timestamps, without `fastMode`). All five per-frame
     dispatches plus the uniform update measured **0.09 ms** together.
3. **Haze: merge, don't replace** ([decision]; §5):
   - **Extinction:** the wave-9 `SroFogPlugin` keeps its model (95 % at the retail fog end, which bounds the 250 m
     draw distance, and the height falloff).
   - **Colour:** it becomes the **sky-view LUT in each pixel's own view direction**, plus a Henyey–Greenstein sun
     glow, in scene-linear HDR, keeping today's cloud-cover and rain terms (the LUT is a clear sky, §5.1). The fog
     below the dome's horizon uses the same function, so the horizon has no seam.
   - **Shafts (High/Ultra, WebGPU):** a **160 × 90 × 64 froxel volume**, computed with the CSM and the cloud-shadow
     map, sampled with one texture tap in the same plugin. Measured: **0.05 ms GPU** [confirmed].
   - **Rejected:** Tidewater's screen-space half-res march, measured at 0.084 ms. It needs a depth buffer that
     Medium does not have, an extra upsample pass and its own temporal pass, and it misses transparent water (§5.4).
4. **GPU IBL** ([decision]; §6; answers WAVE_PLAN3 D14):
   - It uses fragment passes (Babylon's `EffectRenderer` into a render-target cube), not compute, so one path serves
     WebGPU and WebGL2 Medium.
   - **The schedule:** one sky face per frame into a **source cube**, then its mips, then one GGX roughness level per
     frame written straight into the **live cube** (the one `scene.environmentTexture` holds), then SH9 on the GPU with
     an async readback. About 16 frames per refresh. **No `_swapAndDie`**: on WebGPU it leaves every material with a
     stale bind group (§F F1).
   - **What it replaces:** the CPU cube's slices of about 1 ms each. The CPU `skySH` stays for `SkyState.sh` (the
     grass reads it).
5. **Auto exposure** ([decision]; §7):
   - It is a **bounded correction on top of `SkyState.exposure`**, not a replacement. The sky keeps the day, night and
     weather calibration, and the eye adaptation only corrects local brightness.
   - **Metering:** centre-weighted, on the GPU, read back asynchronously.
   - **Limits:** a dead band against pumping, and a ceiling that shrinks in storms.
6. **Ambient** (§8):
   - **Ground bounce v1** adds the sun's bounce off the ground to the SH as a lobe from below. It costs no shader
     work.
   - **GTAO:** our own pass on the existing prepass. It replaces SSAO2 on High and Ultra only if LAB's A/B shows it
     looks better at no more cost [decision: build it, keep SSAO2 as the fallback for one wave].
   - **Contact shadows:** Ultra only, first to cut.
7. **CPU first** ([projected] from the prototype's CPU numbers; §10):
   - **Draws:** SKY2 adds none. The clouds composite inside the existing dome draw, the haze inside the existing fog
     plugin, and the cloud shadows inside the existing `sroCloudShadow` extern.
   - **High on WebGPU:** net ≈ +0.1 ms of CPU on average (the measured 0.09 ms of dispatches and uniforms, + AE and
     the IBL draws, − the CPU cube), with smaller peaks than today, because the CPU cube slices are gone.
   - **Defines:** nothing changes a define per frame (H9A lens 7). Only Options do.
8. **Licence** (§12): ported Tidewater code carries its MIT notice through the root `THIRD_PARTY_NOTICES.md` that
   COAST §8.12 introduces. Anything Tidewater itself took from three.js (its GTAO) also carries three.js's MIT notice.
9. **Who sees it** (§16 item 8): the release default is Medium on every adapter and every player is on WebGL2 until
   HTTPS [confirmed: `w9-user-decisions.md`, DEPLOY.md]. The volumetric clouds, their shadows and the shafts are
   WebGPU High+ features, so **no friend sees them until HTTPS is set up and they pick High**. What everyone gets on
   Medium: the sky-coloured haze, the GPU IBL, auto exposure and the ground bounce.
10. **Never cut** (§14): the sky-coloured haze on PBR presets, the GPU IBL, "no new draws", the Low guard, and the
   2.5D clouds as the fallback for any preset or device that loses the volumetric ones.

---

## 1. What wave 9 built, and what SKY2 does to each piece [confirmed: read in the code]

| Piece today | Where | What it is | SKY2 |
|---|---|---|---|
| Atmosphere LUTs | `sky/atmosphere.ts`, `sky/sky-luts.ts` | Hillaire 2020 on the CPU. The sky-view LUT (96 × 48 / 128 × 64 RGBA16F `RawTexture`) is sliced over frames and kept on the CPU (`rgb`). | Unchanged. The haze and the IBL sample the **same GPU texture**. |
| Dome | `sky/dome.ts`, `sky/sky-shaders.ts` | One ShaderMaterial draw (WGSL/GLSL). Tiers by define: `SKY_CLOUDS_RETAIL`, `SKY_LIGHT_TAPS`, `SKY_CIRRUS`, `SKY_DETAIL`. It shows the fog colour below the horizon. | New tier `SKY_CLOUDS_VOLUMETRIC`, which samples the resolved cloud texture. Below the horizon: the haze function. |
| 2.5D clouds | `sky/clouds.ts` + the dome | Noise on a curved shell 1.8 km up, 9 km per tile. The CPU samples it for the sun occlusion (`CloudLayer.occlusion`). | Kept for Medium (and Low's retail plane). On High+ the CPU reads the occlusion back from the cloud-shadow map instead (§4.8). |
| Cloud shadows | `sky/chunks.ts` `sroCloudShadow(p)` | One noise tap along the key light. Used by the terrain (Classic chunk and PBR plugin) and the grass (per plant, in the vertex stage, `vSkyCloud`) on High (`cloudShadows: 'ground'`), plus the objects' surface plugin on Ultra (`'all'`) (D28). Medium has none. Uniforms `skyCloudShadow`, `skyCloudProj`, sampler `cloudNoise`. The key light is also dimmed by `CloudLayer.occlusion` × 0.75 / 0.45 / 0 (off / ground / all), so a surface is never shadowed twice. | **Same function name, same uniforms, same sampler slot.** A define swaps the body to a shadow-map tap (§4.8). |
| `SkyState` | `sky/types.ts` | Key light, ambient, L1 SH, fog colour, `horizonRing`, exposure, cloud shadow. | New fields (§9). `horizonRing` retires on the PBR presets. |
| Exposure | `sky-system.ts` | `8 × (ref / lum)^0.5`, eased over 1.5 s, the weather gains capped at ×1.1 by day and ×1.2 at night, the twilight boost. `EXPOSURE_TRIM` 1.4 in `render/display.ts`. | Kept. Auto exposure multiplies it within bounds (§7). |
| Height fog | `pbr/fog-plugin.ts` `SroFogPlugin` | `1 − exp(−density · d · F(h))`. Colour = `SkyState.fogColor` or the 64 × 1 ring by azimuth (High+), an LDR colour inverse-tone-mapped. It binds 4 vec4 + the ring on every draw. | Colour and shafts replaced. Extinction kept (§5). |
| IBL | `render/lighting.ts` `SkyEnvironment` | A CPU-filled RGBA16F `RawCubeTexture` (32² Medium, 64² High+). 12 slices of ≤ ~1 ms, then one upload. Refreshed every 10 / 5 / 2 s (Medium / High / Ultra). The diffuse SH is `SkyState.sh` (L1), which the sky system rebuilds with `skySH` when a LUT finishes, after a jump and at least once a second; `lighting.ts` and `grass-chunks.ts` both read it. | The cube is replaced by the GPU version (§6). `SkyState.sh` stays (the grass reads it). The CPU cube code stays as the headless/test reference. |
| SSAO | `render/post.ts` | SSAO2 on the prepass, High (half res, 8 samples) and Ultra. It needs `clearPrepassForSsao` (without it: black pixels on WebGPU), and the geometry-buffer mode fails on WebGPU. Its GPU cost was never measured. The sky dome, the grass and the Classic water are ShaderMaterials that never write the prepass, so their pixels keep the clear values. Options row `ao`: auto / off / half / full. | GTAO A/B (§8.2). |
| Light shafts | `render/post.ts` | `VolumetricLightScatteringPostProcess`, Ultra. **Off since gate 2**: it throws in `createBindGroup` on WebGPU every frame. `POST_STAGE_ORDER` still lists `'vls'`; the Options row `lightShafts` (auto / off / on) exists. | Replaced by the froxel shafts (§5.3). The VLS code and its `'vls'` stage are deleted; the `lightShafts` row switches the froxel shafts. |
| TAA | `render/post.ts` | Jitter only. Reprojection is off: it made a black frame on WebGPU with thin instances. `disableOnCameraMove = true`, so there is **no AA while the camera moves**. | Unchanged. **Nothing in SKY2 relies on TAA**: each effect that accumulates over frames keeps its own history (§3). |

---

## 2. What Tidewater does, and what we take [likely: read at `4811ba4`]

| Technique (Tidewater file) | Their numbers | What we take | What we change, and why |
|---|---|---|---|
| Volumetric clouds (`src/sky/Clouds.js`, all compute) | Layer 750–2400 m. Weather map 512² RGBA8. Shape 128³ perlin-worley, 2,048 m tile. Detail 64³, 3 octaves, 1,000 m. View march ≤ 200 steps, 24–120 m steps, ≤ 50 km. Light march 6 bands (12, 50, 140, 350, 900, 1,800 m). 1 pixel of each 4 × 4 per frame (Bayer order 0, 10, 2, 8, …) at 0.75× history. 3×3 neighbourhood clamp. SDF 256 × 256 × 16 for skipping. Panorama 1,024 × 320, 1/32 per frame. Shadow map 256², 8 km, 1/4 per frame, 8 steps. | The density structure, the checkerboard and its order, the light bands, the dual-lobe phase and 3-octave multiple scattering, the powder term, the shadow map and panorama layout. | Our layer sits higher (1.5–3.2 km, temperate cumulus over a 250 m world). A 2,048 m shadow map (8 m texels) is enough for our view. **Rotation-only reprojection** (§4.5). A coarse/fine skip first, the SDF only if needed. Weather drives the coverage (Tidewater has no weather). |
| GPU IBL (`src/sky/Environment.js`) | 128² cube RGBA16F. One face per frame. Mips in compute. GGX 6 levels × 96 samples with filtered importance sampling. SH9 from a 32² mip. Two targets, swapped when done. About 15 frames per refresh, every 3 s or on a 0.004 rad sun move. | The schedule, filtered importance sampling, SH9, and a second cube. | 64² / 32² (our cube today). **Fragment passes, not compute**, so WebGL2 Medium gets it too. SH read back for Babylon's `SphericalPolynomial`. No swap of targets: our live cube is written in place (§3.8). |
| Air haze (`src/post/AirHaze.js`) | Two exponential layers (marine 1.5e-4 /m, 110 m; aerosol 3.2e-5 /m, 1,400 m). The colour is the sky-view LUT in the view direction with elevation ≥ 0.02. Phase CS(g 0.62) × 0.7 + 0.3 isotropic. Shafts at half res, 16 quadratic steps to ≤ 2,500 m, 1 CSM tap + the cloud shadow per step, depth-aware upsample, its own temporal blend (0.12 new). | The colour source, the phase mix, the quadratic spacing, "carry the lit ratio, not the raw in-scatter", and the own temporal history. | Our fog is **much denser** (the world ends at 250 m), so the extinction stays wave 9's. **Froxels instead of a screen pass** (§5.3–5.4). |
| Auto exposure (`src/post/PostFX.js`) | Log-average luminance, centre-weighted (an ellipse, floor 0.15), from a 1/16 bloom level. Reference 0.25. Adapts +1.6 / −1.1 EV/s. Clamp 0.6–6 EV. Partial at night. GPU storage buffer, applied next frame. | Centre weighting, asymmetric speeds, the night damping. | **A correction on top of the sky's exposure**, ±0.5 to ±1 EV (§7). |
| GTAO (`src/post/GTAO.js`) | A port of three.js's GTAO. Full-screen fragment, normals rebuilt from depth, 16 samples, 3 slices, quadratic spacing, rotations over 6 frames, then a 5+5 depth-aware blur. AO multiplies ambient only. | The integral, the spacing, the rotation cycle. | Normals from our prepass (we have them). AO applied as SSAO2 is today, unless ambient-only turns out feasible (§8.2). |
| Ground bounce (`src/materials/GroundBounce.js`) | Biome albedo × sun irradiance × a lower-hemisphere weight `(1 − N.y)/2`, a height fade (full within 4 m, 0.4 at 30 m), 0.6 surround occlusion, minus 0.08 already in the environment. | The idea and the weights. | v1 puts it in the SH (no shader work) (§8.1). |
| Atmosphere (`src/sky/Atmosphere.js`) | Compute LUTs: transmittance 256 × 64, multiple scattering 32², sky-view 192 × 108, ground albedo (0.06, 0.08, 0.1), sky-view rebuilt on change. Irradiance read back at 4 Hz. | A cross-check only. | Ours stays on the CPU (SKY §3; it is cheap and already sliced). |

Tidewater targets 60 fps at 2560 × 1267 on an Apple M5 Pro with dynamic resolution [likely: README]. We cannot assume
that class of GPU. The friends have gaming desktops, gaming laptops and M1+ Macs.

---

## 3. The Babylon 9.28 facts that shape this design

1. **CPU draw cost is the budget** [confirmed: budgets.md, RENDER §11.5]:
   - a main draw costs about 20 µs;
   - a PBR draw costs about twice a Classic one;
   - High on WebGPU misses 16.7 ms on CPU.

   So no SKY2 feature may add a draw per object, a scene pass or a depth pass. Compute dispatches and a handful of
   full-screen passes are the only new submissions.
2. **Compute in Babylon** [confirmed: `Compute/computeShader.pure.d.ts`,
   `Engines/WebGPU/Extensions/engine.computeShader.pure.js`, and the prototype]:
   - `ComputeShader` takes a `bindingsMapping`. A sampled texture's sampler sits at **binding − 1**.
   - Storage textures are write-only.
   - `RawTexture3D(..., creationFlags = TEXTURE_CREATIONFLAG_STORAGE)` gives 3D storage (the prototype wrote 128³
     RGBA8 and 160 × 90 × 64 RGBA16F), and `RawTexture.CreateRGBAStorageTexture` gives 2D storage.
   - `fastMode` skips the readiness checks (`_checkContext`). The prototype did **not** set it, so its 3 µs includes
     them.
   - `gpuTimeInFrame` is created **in the constructor, only if** `engine.enableGPUTimingMeasurements` is already on
     [confirmed: `computeShader.pure.js` 75–77]. With it on, each dispatch cost about 0.05 ms more GPU wall time and
     ~10 µs more CPU, and the values came back quantised to powers of two in ns [confirmed: prototype]. **The perf
     overlay turns timing on only while it is open** [decision; the game does not toggle it today, only the viewer's
     `lab-bench.ts`], and then assigns a `WebGPUPerfCounter` to each existing sky compute shader itself.
   - One dispatch costs **3 µs of CPU** without timestamps [confirmed: prototype, 60–300 dispatches per frame].
3. **The CSM shadow map is readable in compute** [confirmed: prototype]. With PCF, `CascadedShadowGenerator`'s map is a
   **RED half-float 2D array** (format 6, type 2, 2048² × 3 layers), not a depth texture. It binds as
   `texture_2d_array<f32>` with `textureLoad`. The cascade matrices come from `getCascadeTransformMatrix(i)`. The
   split depths come from the private `_viewSpaceFrustumsZ` (read once per frame, guarded).
4. **16 inter-stage variables** [confirmed: `post.ts` `MIN_PREPASS_VARYINGS`]. A lit PBR CSM receiver is already at 16
   at Medium. Every SKY2 shader addition reads existing inputs: `fragmentInputs.position` (the builtin frag coord),
   `vPositionW`, and `scene.vEyePosition`. No new varyings [likely: the prototype's haze plugin added none; the
   `gpu-guards.ts` dev check confirms it per preset in LAB].
5. **Samplers per material.** The fog plugin binds `sroFogRing` today (High+). SKY2 swaps it for:
   - `sroHazeVolume` on High+ WebGPU, so there is no net change;
   - `skyView` on WebGL2 High (replaces the ring: no net change) and on Medium, which is **+1 sampler on Medium PBR
     materials**.

   The binding limit is **WebGL2's 16 texture units per stage** (D32), which is where every player is today. WebGPU
   lifts its own limit with `setMaximumLimits` (D10). Counted on the heaviest material, the PBR terrain, in every
   weather level, with the map arrays and the night splat, compiled on a NullEngine and read from the GLSL
   [confirmed: `work/tmp/sky2-fc/d32-count.test.ts`, a copy of the D32 test that prints the counts]:
   - **Medium: 13 of 16** (11 terrain samplers + the cluster's 2). `skyView` makes 14: it fits.
   - **High: 16 of 16** without the tier plane (+ the ring), 17 with it on a device with more than 16 units (the
     existing D32 rule). High may not add a sampler to the terrain: the haze must stay net 0 there.
   - Not counted: the objects' surface plugin and the foliage plugin. S2-S adds a sampler count to `gpu-guards.ts`
     and extends the D32 test to them. Any cloud shadow on High objects or trees (+1 `cloudNoise`) goes through that
     test first (§4.8, §8.4).
6. **The prepass is fragile** [confirmed: `post.ts` comments]:
   - SSAO2 needs `clearPrepassForSsao`;
   - the geometry-buffer SSAO fails on WebGPU;
   - TAA reprojection makes a black frame with thin instances;
   - VLS throws.

   SKY2 reads the prepass depth only where it already exists (High/Ultra, for GTAO and contact shadows), and never
   needs it for the clouds, the haze or the IBL.
7. **No TAA while moving** [confirmed: `post.ts`, `disableOnCameraMove = true`]. Tidewater's shafts settle over ~10
   frames through their own blend and its TAA [likely]. Ours cannot lean on TAA. So the clouds, the froxels and GTAO
   each keep their own history.
8. **Offline-style prefiltering exists, and its in-place swap is unsafe on a live texture** [confirmed:
   `Materials/Textures/Filtering/hdrFiltering.js`, `internalTexture.js`, `Engines/WebGPU/webgpuMaterialContext.js`,
   `webgpuCacheBindGroups.js`]:
   - `HDRFiltering` renders every face × mip with `EffectRenderer` into `createRenderTargetCubeTexture`, all in one
     call (6 × 7 = 42 draws in one frame, a hitch);
   - it then releases the target's GPU texture and moves the result into the **same** `InternalTexture` with
     `_swapAndDie`, which also gives it a new `uniqueId`;
   - but a material that already drew with the texture keeps its bind group: `WebGPUMaterialContext.setTexture`
     compares the cached object's live `uniqueId` with itself, so it never marks the context dirty, and the bind-group
     cache returns the old group, which references the released texture (§F F1).

   We use the pattern (EffectRenderer passes into render-target cubes) but **render into persistent cubes and never
   swap** (§6.2).
9. **Async readback on both backends** [confirmed]:
   - WebGPU: a render target is read with `engine._readTexturePixels(...)` (or `BaseTexture.readPixels()`), which
     returns a Promise (`engine.readTexture.pure.js`); `engine.readPixels` reads the canvas;
   - WebGL2 has `Engine._readPixelsAsync` (a PBO + `fenceSync`, `engine.pure.js` ~line 634). It reads the bound
     framebuffer, so the target is bound first; read RGBA16F targets as FLOAT (HALF_FLOAT reads are
     implementation-dependent in WebGL2) [likely].
10. **GLSL never reaches WebGPU** (the CDN converter download, H9A lens 2). Every shader here is WGSL (WebGPU: compute
    and fragment) plus GLSL ES 3.0 (the WebGL2 fragment fallbacks). Compute exists only in WGSL.

---

## 4. Volumetric clouds

### 4.1 Where they run [decision]

| | Low | Medium | High | Ultra |
|---|---|---|---|---|
| WebGPU | retail plane | 2.5D cumulus (wave 9) | volumetric, compute: 0.6× res, 96 steps, 4 light taps, detail ≤ 2 km, shadow map, panorama | volumetric, compute: 0.75×, 128 steps, 6 light taps, detail ≤ 3 km, shadow map, panorama, skip SDF (if built) |
| WebGL2 | retail plane | 2.5D | **2.5D by default**. The fragment fallback turns on only if LAB measures ≤ +0.25 ms CPU at the plaza. | volumetric, fragment fallback, High's settings |
| Apple M1 / M2 (base) | — | 2.5D (Medium is the first-run default on every adapter since the release decision) | allowed. LAB measures it on a friend's Mac if one can run the bench [unknown]. | same |
| 16-varying adapter | — | 2.5D | (never High: `apps/game/src/settings.ts` caps a 16-varying adapter at Medium [confirmed]) | — |

The 2.5D path stays as it is and becomes the fallback everywhere: an Options row "Clouds: Auto / 2D / Volumetric"
(Advanced), a compile failure, or a watchdog step-down.

### 4.2 The layer and the density [decision; numbers tuned in LAB]

- **Layers:**
  - cumulus from **1,500 m to 3,200 m** above the world's sea level (the 2.5D shell was 1.8 km);
  - in rain, a lower stratus deck from 900 to 2,400 m that closes the sky;
  - cirrus stays the 2D layer at 8 km. The dome's `SKY_CIRRUS` code is kept and drawn behind the volumetric clouds.
- **Weather map, 512² RGBA8, 24 km per tile, scrolled by the wind** [decision]:
  - R: the coverage field;
  - G: the top height;
  - B: the cell (worley) field;
  - A: the rain/stratus mask.

  Coverage = `saturate(R × SkyWeather.cloudCover × 2.2 − 0.25)`. The prototype's form uses 0.45 fair and 0.9 overcast;
  the constants are re-fitted in LAB so the covered fractions match wave 9's (0.21 / 0.50 / 0.79 at 0.2 / 0.5 / 0.8,
  SKY §5).
- **Noise volumes:**
  - shape 128³ RGBA8 (perlin-worley, then three worley fbm octaves), 2,400 m per tile;
  - detail 32³ RGBA8 (three worley octaves), 420 m per tile;
  - both periodic.
- **Density:**
  - the height gradient is `smoothstep(0, 0.07, h) × (1 − smoothstep(0.55·top, top, h))`;
  - it is remapped by the coverage, then eroded by the detail noise within the detail distance (upper cloud parts
    billow, lower parts wisp);
  - the peak extinction is **0.035 /m** (the prototype's).
- **Where the noise comes from** [decision]: S2-C's addition to the sky exporter (`packages/convert/src/tools/
  export-sky.ts`) writes it to `out/sky/cloud-shape.bin` (8 MiB raw) and `cloud-detail.bin` (128 KiB), listed in
  `sky.json`. The extension is `.bin` on purpose: the optimizer copies unknown files unchanged and precompresses
  (`--precompress`, brotli) only the `COMPRESSIBLE` extensions, which include `.bin` [confirmed:
  `optimize/run.ts` header, `optimize/measure.ts` 94], and the game server then serves the `.br` sibling
  (`apps/server/src/static.ts`). The noise barely compresses: a numpy replica of the prototype's shape recipe gives
  **7.35 MiB with gzip and 7.18 MiB with xz** [projected: `work/tmp/sky2-fc/noise_size.py`; brotli was not
  installed, expect about the same]:
  - it is loaded **only when a volumetric preset is first used**; the 2.5D clouds show until it arrives;
  - WebGPU and WebGL2 then get the same clouds;
  - the prototype built it on the GPU instead in **2.2 s on the first load and 0.44–0.63 s later** [confirmed:
    results.json]. That is a loading-screen hitch on WebGPU, and WebGL2 would need the file anyway.

  A smaller single-channel variant (128³ R8, 2 MiB raw, **1.36 MiB gzip** [projected: same script]) is the first
  thing to try if the download matters (§17 Q3).

### 4.3 The trace (one pixel of each 4 × 4 block per frame) [confirmed: prototype `TRACE`]

- **Input:** the camera's inverse view-projection. Each thread takes pixel `block × 4 + ORDER[frame % 16]` of the
  cloud-res target, with Tidewater's order 0, 10, 2, 8, 5, 15, 7, 13, 1, 11, 3, 9, 4, 14, 6, 12.
- **Ray:** the ray enters the layer slab (flat; the Earth curvature is added as the 2.5D shell does, `h − d²/2R`) and
  marches at most 40 km. Rays below +0.9° go to the fog, not the clouds.
- **Steps:** 24 m, growing 6 m per km, up to 160 m, with a per-pixel interleaved-gradient jitter.
- **Empty-space skipping:**
  - where `coarse(p)` (weather × height gradient only: 1 texture tap) is 0, the step is ×4;
  - after 3 empty fine steps it is ×2.

  The SDF (256 × 256 × 16, rebuilt when the weather map changes) is an Ultra option only if LAB shows the horizon rows
  over budget [decision: not built first].
- **Light:** 4 or 6 taps along the key light at the band lengths 12, 50, 140, 350, 900 and 1,800 m, using shape noise
  only.
  - The in-scatter is `sun × (P1·e^−τ + 0.6·P2·e^−0.3τ + 0.3·P3·e^−0.09τ) × powder + ambient(h)`. The Pi are
    two-lobe HG pairs (0.8 / −0.2, 0.4 / −0.1, 0.2 / −0.05, mixed 80 / 20).
  - The step integration is energy-conserving: `L += T·S·(1 − e^−σds)/σ`.
  - The march stops at T < 0.02.
- **Output:** premultiplied in-scatter RGB and the transmittance, RGBA16F, at a quarter of the cloud-res in each axis.
- **Aerial perspective of the clouds:** `mix(L, skyView(dir) × (1 − T), 1 − e^(−t₀/30 km))`, as Tidewater's
  `AP_DIST` does.

**The cost is set by the horizon rows, not by the pixel count** [confirmed: prototype]:

| Case | Trace GPU (ms) |
|---|---|
| resolution 0.75× → 0.5× | 0.32 → 0.27 |
| camera pitched 45° up (no horizon in view) | 0.11 |
| 128 → 64 steps | 0.32 → 0.17 |
| 6 → 3 light taps | 0.32 → 0.22 |
| the detail erosion | within the noise |
| coverage 0.15 | 0.04 |
| overcast 0.9 | 0.32 |

So the knobs that matter are the **step count** and the **light taps**, and the resolution matters little.

### 4.4 The resolve [confirmed: prototype `RESOLVE`, 0.027 ms at 1440 × 810]

For each cloud-res pixel:

- **Its own traced pixel this frame:** `mix(clampedHistory, fresh, 0.5)`. With no valid history it takes the fresh
  value.
- **Any other pixel:** the reprojected history, clamped to the 3 × 3 neighbourhood of this frame's trace texels
  (± 25 % of the range + 0.02). Off-screen history falls back to a bilinear upsample of the trace texture.
- Ping-pong: two RGBA16F targets, two `ComputeShader` instances with fixed bindings (`fastMode` on).

### 4.5 Reprojection without TAA [decision; the error is confirmed by arithmetic]

- **Rotation only:** the previous view-projection is applied to `camPos + dir × 50 km`. The clouds are at ≥ 1.5 km and
  the player moves at most ~10 m/s (running 5 m/s, the Red Horse 9 m/s [confirmed: `packages/shared/src/content.ts`
  133, 670]).
  - Parallax is then at most 10 / 1,400 rad per second (the base 1,500 m minus a camera up to ~100 m): **0.12 mrad
    per frame at 60 fps**.
  - Babylon's `fov` is vertical, 0.85 rad in the world [confirmed: `apps/game/src/screens/world.ts` 123]. A 0.75×
    target is 810 px high, so the focal length is 405 / tan(0.425) ≈ **894 px/rad**, and the parallax is **0.11 px
    per frame** (0.21 px at 30 fps) [confirmed by arithmetic]. That is far below the 3×3 clamp's tolerance, so no
    depth is needed.
  - The orbit camera also translates while it turns (12 m from the player at the plaza view × 3 rad/s ≈ 36 m/s):
    0.38 px per frame, still inside the clamp [projected].
- **Camera cut:** a teleport, character-select → world, a GM `/tp`, or a time jump that re-lights the clouds.
  - It traces **4 slots per frame for 4 frames** (a full image in 4 frames; Tidewater's `REBUILD_SLOTS` 4) [likely].
  - The trigger is the same "jump" test `SkySystem` already uses (the time step, `jump`) plus a camera move of
    more than 50 m in one frame.
- **Fast orbit:** a turn of more than 0.003 rad per frame traces **2 slots per frame** [likely: Tidewater's rule].
  The orbit camera turns fast when the player drags it, so LAB checks for smearing at 3 rad/s.

### 4.6 Composite in the dome [decision]

- The define `SKY_CLOUDS_VOLUMETRIC` replaces `SKY_CLOUDS_CUMULUS` in `sky-shaders.ts` and adds one sampler,
  `cloudVolume`. It samples at `fragCoord / screenSize` (bilinear, the 0.6–0.75× target) and composites
  `sky × T + L`. The sun disc and the moon are multiplied by T, the stars by T.
- The dome stays **one draw**. No depth is needed: the dome is behind everything.
- The lightning flash adds `flash × stormAmbient × (1 − T)`, lighting the cloud bodies.
- Below +0.9° elevation the dome shows the haze function (§5.1), as the fog does.
- Output mode 1 (PBR presets): linear × `hdrScale`, as today.
- **GPU:** +1 bilinear tap per sky pixel, which replaces the 2.5D cumulus's 3 + 2 noise taps (0.12 ms on a mid GPU,
  SKY §9.2 [projected]). So the dome gets cheaper [projected].

### 4.7 Light: sun, moon, twilight, storm [decision]

- **The key light:** the clouds are lit by `SkyState.keyLight` (the sun, or the moon at night) at `skyCloudDir`, and
  its colour is the transmittance at cloud height (the dome's `skyCloudLight`).
- **Ambient:** `SkyState.ambient.sky × mix(0.35, 1, h)`, with the two upward occlusion probes from Tidewater as an
  Ultra option.
- **Twilight:** the Earth's shadow, `smoothstep(−0.006, 0.006, μ + sqrt(2·alt/R))` [likely: Tidewater], lets the cloud
  tops stay lit after the ground's sunset. This is the sunset look the retail sky never had.
- **Storm:** `cloudDarkness` raises the extinction ×1.5 and lowers the multiple-scattering gain (grey, thick bases).
  Precipitation closes the stratus deck, and the rain particles (WX-R) are unchanged.
- **Night:** the moon key at `MOON_KEY × illum` and the airglow floor as today, with no star occlusion change (the
  stars are × T).

### 4.8 The cloud-shadow map [confirmed cost: prototype `SHADOW`, 0.003 ms per quarter]

- **The map:**
  - 256² RGBA8 (R = transmittance to the key light);
  - **2,048 m square around the camera** (8 m texels), re-centred in 256 m steps, so the texel grid never swims;
  - **indexed on a reference plane at `yRef`** (the camera's height, snapped to 32 m and moved only with a re-centre):
    texel g holds the transmittance along the key light from the point (g.x, yRef, g.z) up through the layer
    [decision; §F F2]. A point p reads it at `g = p.xz − L.xz × (p.y − yRef) / L.y`. Points within the 320 m haze
    range mostly sit within tens of metres of `yRef`: at the lowest dynamic sun (6°, L.y ≈ 0.105) a 50 m height
    difference moves the lookup ≈ 475 m, inside the 1,024 m half-size (a lookup that leaves the map reads "no cloud")
    [projected]. A plane at y = 0, as the prototype's `SHADOW` kernel used, pushes hilltops and high cameras off the
    map at a low sun.
  - **a quarter of the rows per frame**, 8 steps through the layer along the key light, shape only.
  - A re-centre re-traces all rows in that frame (0.012 ms).
- **Consumers, through the existing seam:**
  - `sroCloudShadow(p)` keeps its name, arguments and uniforms, with new meanings under the define
    (`skyCloudShadow`: xy = map origin, z = 1 / size, w = strength; `skyCloudProj`: xy = key light xz / y,
    z = `yRef`, w unused). Today w is the cover and z the 2.5D shell height [confirmed: `sky/chunks.ts`];
  - it keeps its sampler slot `cloudNoise`, which now binds the shadow map (declared `texture_2d<f32>` today, the same
    type; the map's own sampler is clamp, the noise's is wrap, and Babylon takes the sampler from the bound texture);
  - a define `SRO_CLOUDMAP` swaps the body for one bilinear tap at the lookup above.
  - So the terrain (Classic chunks and the PBR plugin), the grass `vertexLight` (in the vertex stage), the surface
    plugin (Ultra) and COAST's ocean glint get volumetric cloud shadows with **no new uniform, sampler or varying**
    [confirmed: the seam in `sky/chunks.ts`, `terrain-plugin.ts`, `surface-plugin.ts`, `grass-chunks.ts`].
  - **Which surfaces:** today's split stays: High = terrain, grass and water (`cloudShadows: 'ground'`), Ultra = +
    objects (`'all'`). Objects on High would add the `cloudNoise` sampler to every High object material, which the
    sampler count (§3.5) must clear first [decision: an option for LAB, not the default].
  - **Recommended** [decision]: on WebGPU High+ the 2.5D clouds also write this map (one compute pass evaluating
    today's noise function, 256 × 64 texels per frame, ≈ 0.003 ms). Then `SRO_CLOUDMAP` depends only on the preset,
    and the watchdog's "clouds → 2D" step (S2-G) changes the dome's define alone, not ~2,000 materials' (a recompile
    hitch on WebGPU).
- **The key-light dimming (CPU):**
  - an async readback of the texel under the camera, every 250 ms (≤ 4 bytes, 1–3 frames late), replaces
    `CloudLayer.occlusion` on volumetric presets;
  - `SkySystem` eases it as today, and keeps today's strengths per surface set (× 0.45 on `'ground'`, × 0 on
    `'all'` [confirmed: `sky-system.ts` 748]), so no surface is shadowed twice (hunt lens 7);
  - the IBL and the fog then agree with the shadow the player sees.

### 4.9 The panorama for the IBL [confirmed cost: prototype `PANO`, 0.044 ms per 1/32]

- **The panorama:** 512 × 128 RGBA16F of the upper hemisphere (azimuth × elevation², so the horizon gets more rows).
  It has 48 steps and 2 light taps, no detail, and **1/32 of its texels per frame** (a full refresh every 0.53 s at
  60 fps). It stores `sky × T + L`.
- **Users:**
  - the GPU IBL's face pass samples it, so reflections and the ambient SH carry the real clouds (§6);
  - COAST's ocean can sample it straight for a sharp horizon reflection (§9, seam C1).
- **Medium:** it has no panorama. Its IBL face pass evaluates the 2.5D cloud function, as the CPU `radiance()` does
  today.

### 4.10 The WebGL2 fragment fallback [projected]

It is the same algorithm as passes through `EffectRenderer` into render targets:

- the trace pass draws the quarter-res target: each texel is its block's traced pixel, exactly as the compute
  threads;
- the resolve pass draws the cloud-res target (ping-pong RTTs);
- the shadow map draws a 64-row **band** per frame (scissored: contiguous bands, not every 4th row);
- the panorama draws one 64 × 32 tile per frame.

It uses the same noise files and GLSL ES 3.0 shaders with `texture(sampler3D)`.

**Its CPU cost is the risk:** about 4 full-screen-type passes. RND-P measured +0.34 ms of CPU for Medium's post stack
(RENDER §11), about 0.05–0.07 ms per pass, so about **+0.2–0.3 ms** here [projected]. WebGL2 High sits at 16.0–16.7 ms
p95 on the dev PC (budgets.md), so the fallback is **Ultra-only by default**. High gets it only if LAB measures
≤ +0.25 ms.

### 4.11 Weather coupling (`toSkyWeather`, unchanged input) [decision]

| `SkyWeather` | Volumetric response |
|---|---|
| `cloudCover` 0.1 → 0.95 | the coverage scale; above 0.8 the stratus deck blends in (weather map A) |
| `cloudDarkness` | extinction ×1 → ×1.5, the multiple-scattering gain ×1 → ×0.6, ambient ×1 → ×0.7 |
| `cirrus` | the 2D cirrus layer (unchanged) |
| `wind` | the weather-map scroll (`CLOUD_DRIFT` 1.5 as today) + the shape-noise scroll at 0.3× |
| `precipitation` | the stratus mask, a lower base, the sun/moon/stars hidden (as today) |
| `flash` | the cloud-body flash (§4.6) |
| `haze` | the Mie scale (unchanged) → the sky-view LUT → the haze colour |

### 4.12 Measured, and what it means [confirmed: prototype, §11]

| Kernel (dev PC, 1080p screen) | GPU per frame |
|---|---|
| Trace, 0.75×, 128 steps, 6 light taps, detail ≤ 3 km, fair (0.45) | 0.32 ms |
| Trace, 64 steps, 6 taps | 0.17 ms |
| Trace, 128 steps, 3 taps | 0.22 ms |
| Resolve 1440 × 810 / 960 × 540 | 0.027 / 0.022 ms |
| Cloud-shadow quarter (256 × 64 texels, 8 steps) | 0.003 ms |
| Panorama 1/32 of 512 × 128 | 0.044 ms |
| **Ultra-like total** | **≈ 0.40 ms** |
| **High (96 steps, 4 taps, 0.6×): 0.17–0.19 + 0.022 + 0.003 + 0.044** | **≈ 0.24–0.26 ms** [projected: 0.17 multiplying the measured step, tap and resolution ratios, 0.19 adding them] |
| CPU: 4 cloud dispatches + the froxel dispatch + the shared UBO update | **0.09 ms measured** (mean; the parts add to 4–5 × 3 µs + the UBO's 0.044 ms ≈ 0.06 ms, so ≈ 0.03 ms is unexplained per-frame overhead) [confirmed: results.json]. S2-V trims the UBO by splitting the per-frame and per-preset blocks and sets `fastMode` on the fixed-binding shaders. |

**Caveat on the resolve** [projected]: 0.027 ms is below what DRAM allows for its traffic (≈ 9.3 MB of history read
and 9.3 MB written at the 0.75× target; at the RX 9060 XT's ≈ 320 GB/s that is ≈ 0.06 ms [likely: 128-bit GDDR6
at 20 Gbps]). Repeated dispatches ran from the 32 MB on-die cache. In a full frame, with the shadow maps and render
targets competing for it, expect up to ≈ 0.06 ms. The other kernels are latency- or ALU-bound and move less.

---

## 5. Sky-coloured haze and sun shafts

### 5.1 The model: keep wave 9's extinction, replace its colour [decision]

- **Extinction:** exactly `SroFogPlugin`'s:
  - `density = −ln 0.05 / (end − start)` from the retail G10/G11 × the weather's fog scale;
  - `F(h)` grows with depth below the eye (`DEFAULT_HEIGHT_FALLOFF_M` 80);
  - the fog start is kept.

  This is what bounds the 250 m draw distance and the streaming radii (FIELDS §3.2), and rain halving the visibility
  keeps working. Tidewater's marine and aerosol layers (e-folding at 6.7 km and 31 km) cannot hide a 250 m world edge,
  so they are not used.
- **In-scattered colour** (scene-linear HDR, the same units as the dome in output mode 1):

  ```
  dirH   = normalize(dir.x, max(dir.y, sin 0.9°), dir.z)        // never below the horizon
  sky    = skyView(dirH) × kLUT                                 // the same LUT and mapping as the dome (skyLutUV)
  sky    = mix(sky, cloudAmb + 0.25 · cloudLight, 0.6 · cover)  // today's cloud term: overcast fog is cloud-grey
  sun    = keyColor × transmittance × (0.7 · CS(cosθ, 0.62) + 0.3 / 4π) × kSun
  haze   = sky + sun (+ moon sky-view × MOON_SKY at night)
  haze   = mix(haze, luminance(haze), 0.3 · precipitation)      // today's rain desaturation
  colour = mix(haze, retailFogLinear × retailK, gradeW)         // the retail palette as the art grade (SKY §6.4)
  out    = lit × (1 − amount) + colour × amount
  ```

  - `gradeW` is today's: `GRADE_FOG` **0.65 by day** (it keeps the noon fog within ΔE 10 of the retail FogColor, the
    SKY §6.6 test), easing to `GRADE_FOG_TWILIGHT` 0.3 while the sun is low; `retailK` is the storm rule
    (`STORM_FOG_DIM` 0.5 × precipitation) [confirmed: `sky-system.ts` 133–150, 940–953]. Today the mix is done in LDR
    display space; here it is done in scene-linear, so the §6.6 ΔE test is re-run and `gradeW` re-fitted in LAB
    [decision].
  - **The cloud and rain terms are required** [confirmed by reading today's `fogColor`]: the sky-view LUT is a clear
    sky, so without them an overcast or rainy horizon would be sky-blue below grey clouds, a seam at the dome's
    horizon. On volumetric presets `cloudAmb`/`cloudLight` come from the panorama's lowest row (the clouds the dome
    actually draws there) instead of the 2.5D layer's averages.
  - `kLUT` and `kSun` are the dome's own scales (`SKY_LDR_PER_LUT`, the exposure reference). No LDR inverse tone map
    is needed any more: the colour is physical, the exposure applies once in post, and the sky and the fog use the
    same numbers.
- **What the player sees:**
  - far hills fade into the sky colour of their own direction: bluer overhead, warm toward a low sun, the golden
    glow around the sun at dusk;
  - there is no longer one forward-azimuth colour for the whole screen (Medium). Against High's ring the change is
    smaller than it sounds: below the horizon `dirH` is clamped to 0.9°, so there the colour also depends on azimuth
    only; what changes is the physical (not LDR-inverted) colour, the weather terms computed per pixel, and objects
    seen above the horizon [confirmed by the formula].
- **The horizon seam:** the dome evaluates the same function below +0.9°. The test checks the horizon strip
  |ΔRGB| ≤ 2/255 at noon, dusk and in a storm (COAST §8.6 checks the same thing for the sea).

### 5.2 Medium (both backends) and WebGL2 High: analytic [decision]

- **Shader cost:** one LUT tap (`skyView`, RGBA16F 96 × 48, already on the GPU) plus about 30 ALU in the fog plugin.
  It **replaces the ring tap on High and the constant colour on Medium**.
- **Grass and Classic water:** they get the same function through their chunk points, with the `skyView` sampler added
  to the grass chunk and the water chunk (Medium+ only: the Low guard stays exact).
- **Cost:** ≈ 0.01–0.02 ms GPU on the dev PC at 1080p [projected: one tap + ALU on ~60 % of the pixels]. CPU: +0 (the
  plugin already binds per draw; one texture replaces another).

### 5.3 High and Ultra on WebGPU: the froxel volume with shafts [confirmed cost: prototype `froxelShader`]

- **The volume:** 160 × 90 × 64 RGBA16F (7.0 MiB), camera-aligned, to **320 m** (the fog end 250 m + margin), with
  quadratic slice spacing (`t = (z/64)² × 320`: dense near the camera, where shafts between houses read).
- **One compute dispatch:** one thread per column integrates front to back and stores `(in-scatter RGB,
  transmittance)` per slice. For each slice:
  - σ(y) from the height fog;
  - **CSM visibility** (the cascade chosen by view depth; beyond the shadow distance, 150 m on High and 250 m on
    Ultra, only the cloud shadow applies);
  - **the cloud-shadow map tap**;
  - `S = σ × (sun × phase × vis + sky(dir))`;
  - energy-conserving accumulation.
- **The material side:** `SroFogPlugin` under `SRO_HAZE_FROXEL` samples the volume at `(fragCoord / screen,
  sqrt(dist / 320))`, one trilinear tap, and composites `lit × T + L`.
  - Past 320 m it continues from the last slice analytically: `T = T₃₂₀ × exp(−σ(far) × (d − 320) × F)` and
    `L = L₃₂₀ + T₃₂₀ × (1 − exp(…)) × L₃₂₀ / max(1 − T₃₂₀, 1e-3)` (the column's own mean in-scatter colour, so no
    `skyView` sampler is added on High, §3.5). The last slice alone is only ≥ 97 % fogged,
    and COAST's S-HORIZON needs ≥ 99.9 % at the sea's 2,000 m clip line, or the sea's own colour shows at the
    horizon (§F F4) [decision].
  - The fog amount and the colour both come from the volume, so the analytic path's fog terms are compiled out under
    this define.
  - The grass and the water chunks do the same.
  - The prototype's plugin rendered it on WebGPU with no new varying [confirmed: `work/tmp/sky2/main.ts`
    `Haze2Plugin`, image `proto-haze-on-off.jpg`].
- **Shafts in the sky:** the dome samples the volume's last slice along its view direction, so shadowed columns from
  houses and hills darken the sky glow near the sun (crepuscular rays against the sky), at no cost beyond that tap.
- **Temporal:**
  - the sample position inside each slice is jittered per frame (the golden-ratio sequence), which the prototype did;
  - a second volume keeps the history, reprojected per froxel with the previous view-projection and blended 0.1 new
    / 0.9 old, with a rejection when the reprojected froxel falls outside the old frustum.

  This is not prototyped: **+0.02 ms, +7 MiB** [projected]. Without it (scope cut 3) the jitter is off and the slices
  are fixed. Shafts are then slightly banded but stable.
- **Strength:** our fog is dense, so the in-scatter is strong. `kShaft` (default 0.6) and a cap keep a shadowed alley
  from reading as a black wall and a sunlit one from blooming. LAB tunes both at 07:00, noon, 18:30, and in rain,
  where the shafts go to 0 as the key light dims.

### 5.4 Why not Tidewater's screen-space shafts [confirmed cost; decision]

The prototype ran Tidewater's layout too: half res, 16 quadratic steps to the depth, a CSM + cloud tap per step. It
measured **0.084 ms** against the froxels' 0.051 ms. The cost of the kernel is not the reason. The rest is:

- It needs **scene depth**. High has it only through the prepass, which exists because SSAO is on, and Medium has none.
  The prototype needed Babylon's `DepthRenderer`: **a second pass over every mesh**, which is the CPU cost High cannot
  pay.
- It needs a depth-aware full-res upsample and its own temporal pass, so 2–3 more post passes (CPU).
- It runs after the opaque pass, so **transparent water** (the whole new sea, COAST) would get no shafts and no
  sky-coloured fog unless a second copy of the math ran in the ocean plugin. The froxels are sampled by any material,
  transparent ones included.
- This answers COAST's open S-HAZE question ("reads depth, or asks for a prepass-depth write") [decision]: SKY2 reads
  **no** depth. The sea gets the haze and the shafts in its own material at its own distance, so S-SHAFTS ("stop at
  the sea surface") holds by construction.

The screen-space variant stays documented as the fallback if per-material sampling of the volume breaks something (a
sampler limit on some adapter, §3.5).

### 5.5 What retires [decision]

| Retires | Why |
|---|---|
| `SkyState.horizonRing` and `RenderQuality.horizonRingFog` on the PBR presets | The LUT or the volume replaces the ring. The ring code and `fogColor` stay for the Classic path and the CPU consumers (the minimap tint, the retail dome). |
| The Ultra VLS row (`lightShafts`) | It never ran on WebGPU. The Options row "Light shafts" now switches the froxel shafts. |
| WAVE_PLAN3 cut #8 (the horizon ring) | Superseded. |

### 5.6 Measured and projected

| Item | GPU dev PC | CPU |
|---|---|---|
| Froxel build 160 × 90 × 64 with CSM + cloud shadow | **0.051 ms** [confirmed] | 3 µs dispatch [confirmed] |
| Froxel temporal (history volume) | +0.02 ms [projected] | +3 µs |
| Material tap (replaces the ring tap) | ≈ +0.01 ms [projected] | 0 |
| Screen-space alternative (not chosen) | 0.084 ms + upsample + the depth pass [confirmed kernel] | a whole depth pass (draws) |
| Medium analytic haze | ≈ 0.01–0.02 ms [projected] | 0 |

---

## 6. GPU time-sliced IBL (answers D14)

### 6.1 Today [confirmed: `render/lighting.ts`]

- A 64² (High+) or 32² (Medium) RGBA16F `RawCubeTexture`, filled on the CPU: 6 face slices + 6 mip slices, each
  ≤ ~1 ms at 64² on the dev PC, then one upload of every face and level.
- Refreshed when the sun moves 0.5° or the weather moves 0.05, at most every 10 / 5 / 2 s (Medium / High / Ultra).
- The SH is `SkyState.sh` (L1), from the CPU `skySH` (0.3–0.45 ms), rebuilt by the sky system when a LUT finishes,
  after a jump and at least once a second [confirmed: `sky-system.ts` 866–870]. `lighting.ts` and `grass-chunks.ts`
  read it.
- The first refresh after a quality change runs whole in one frame; a jump restarts the refresh but stays sliced
  [confirmed: `lighting.ts` 747–749].
- The cube's clouds are the 2.5D layer's coverage-weighted colour, which does not match volumetric clouds.

### 6.2 The GPU version: `GpuSkyEnvironment` (`render/ibl-gpu.ts`) [decision]

- **The textures** [decision; §F F1]: two persistent RGBA16F render-target cubes with full mips
  (`createRenderTargetCubeTexture`), created once per preset, never swapped or reallocated:
  - the **source cube**: the sky radiance (level 0 + a box mip chain). Materials never see it;
  - the **live cube**: a `BaseTexture` wrapping the second cube's `InternalTexture`, assigned to
    `scene.environmentTexture` once per preset, as today, with the `lodGenerationScale`/offset the materials use
    today and `sphericalPolynomial` = WorldLighting's polynomial. Its level 0 and its GGX levels are rendered into
    in place, so the texture object and its `uniqueId` never change and no bind group goes stale.
  - **Not** `_swapAndDie` (§3.8): on WebGPU the materials would keep bind groups that reference the released texture.
    Also not a reassignment of `scene.environmentTexture` per refresh: that marks every material's textures dirty
    (~2,000 PBR materials), which is why today's code assigns once (`lighting.ts` 671).
  - A refresh therefore updates the live cube over 7 frames (level 0, then one GGX level per frame). The change per
    refresh is small (a 0.5° sun move or 0.05 of weather), so the mix of new and old levels is not visible; the
    source cube's box mips never reach a material. A time jump runs every slice in one frame, so a cut is never
    half-lit. (Today's CPU cube uploads all levels in one frame instead; the difference is what LAB's "no reflection
    pop" check, COAST S-IBL, looks at.)
- **The schedule** (one slice per frame, skipped while a hitch-sensitive job runs, WAVE_PLAN3 §4.1 commit steps):

| Frame | Pass | Draws |
|---|---|---|
| 1–6 | Sky face f → the **source** cube's level 0. The shader is the dome's radiance function without the sun disc: the sky-view LUT, the moon sky, and the clouds (the panorama on High+, the 2.5D function on Medium). A bright analytic lobe at the key-light direction stands in for the sun, as today's `radiance()` does. | 1 |
| 7 | `generateMipmaps` on the source cube (a box chain) | 0 (engine call) |
| 8 | The live cube's level 0 (a copy pass from the source, α = 0), all 6 faces | 6 |
| 9–14 | GGX prefilter from the source into the live cube's level l = 1..6 (64²: 32² → 1²), all 6 faces. Filtered importance sampling: 32 samples at 64², 64 at the small levels, the source mip from the sample's solid angle (`0.5·log2(Ωs/Ωp) + 1`). Babylon's `lodGenerationScale` and offset stay the ones the materials use today. | 6 |
| 15 | SH9 into a **9 × 6** RGBA16F target: one pixel per coefficient and face, each summing that face's 16² source mip (256 taps). One pixel summing all 1,536 taps would be a serial latency chain of ≈ 0.1 ms on the dev PC and more on Apple [projected]. | 1 |
| 16 | Async readback of the 54 texels (§3.9) → the CPU sums the 6 faces → the L2 set goes into WorldLighting's `SphericalPolynomial` on arrival, 1–3 frames later (a readback that arrives after a newer refresh began is dropped: hunt lens 4) | 0 |

- **`SkyState.sh` stays** [decision]: it is L1 (12 floats), the grass reads it (`grass-chunks.ts`), and it updates at
  least once a second, faster than a cube refresh. So the PBR polynomial has one writer per band: WorldLighting keeps
  writing L0/L1 every frame from `SkyState.sh` (with the flash, D25, and the ground-bounce lobe, §8.1), as today, and
  adds the GPU readback's **L2 band** scaled by the ratio of the current L0 to the L0 at the refresh [decision]. The
  GPU L0/L1 serve only the 2 % test against `skySH`.

- **Refresh policy:** today's key (a 0.5° sun move, a 0.05 weather move), with the minimum interval lowered to
  **3 s on High** (was 5 s), 2 s on Ultra and 5 s on Medium (was 10 s), because a refresh no longer costs the main
  thread 12 ms in slices [decision].
- **Time jumps:** a jump runs every slice in one frame (49 draws: 6 + 6 + 36 + 1, ≈ 1–2 ms of CPU at 20–40 µs a
  draw [projected], one hitch the player expects). The first refresh after a preset change does the same, as today.
- **Both backends:** WGSL and GLSL fragment shaders, so WebGL2 Medium (every player until HTTPS) gets it too. No
  compute, so there is no second path.
- **What stays:**
  - the lightning's cool SH term (D25, added on the CPU after the readback);
  - the `LIGHT_CALIBRATIONS` ratios, re-checked;
  - the CPU `SkyEnvironment` as the headless (NullEngine) and test reference;
  - `SkyState.sh` and its CPU `skySH` (see above).

  The test compares the GPU SH with `skySH` within 2 % on three skies, and the cube's mean with the CPU cube's
  within 3 %.

### 6.3 Costs

| | Today (CPU cube) | GPU version |
|---|---|---|
| Main-thread CPU per refresh | 12 slices × ≤ ~1 ms at 64² [confirmed: RENDER §11.2] (the SH is the sky system's, unchanged) | 49 small draws over 16 frames: **≈ 0.1–0.25 ms on each of those frames** [projected: `EffectRenderer` draws at ~20–40 µs, from the main-draw measurement in RENDER §11.5; on WebGPU each face/level is its own render pass] |
| CPU averaged over time, High | ≈ 0.04 ms (12 ms per ≥ 5 s) | ≈ 0.01 ms [projected] |
| Worst single frame | ~1 ms (a face or mip slice) | ≈ 0.25 ms (a GGX level: 6 draws) |
| GPU per refresh | an upload | < 0.05 ms in total [projected: 6 faces × 1,365 texels of levels 1–6 × 32–64 samples ≈ 0.3–0.5 M taps, + level 0 + the SH's 54 × 256 taps] |
| VRAM | 1 cube | 2 cubes (source + live) + 9 × 6: ≈ +0.1 MiB |

---

## 7. Auto exposure with `SkyState`

### 7.1 What stays [confirmed: `sky-system.ts`, `render/display.ts`, RENDER §5.2]

`SkyState.exposure` is the designed exposure for the time of day:

- the partial adaptation `EXPOSURE_ADAPT` 0.5;
- the weather gains capped at ×1.1 by day and ×1.2 at night;
- the twilight boost;
- `EXPOSURE_TRIM` 1.4 on the PBR presets.

It is what makes a storm look like a storm and a night look like a night. Auto exposure must not undo that.

### 7.2 The correction [decision]

```
exposure = SkyState.exposure × EXPOSURE_TRIM × ae
ae       = ease( clamp( (KEY / meteredLum)^0.6 , 2^lo , 2^hi ) )
```

- **Metering** (RND-P's stack, `render/auto-exposure.ts`):
  - a **64 × 32** pass reads the HDR scene colour (the first post-process's input), 4 bilinear taps per texel with a
    per-frame jitter. Power-of-two on purpose: a 64 × 36 chain (… 16 × 9 → 8 × 4 …) drops the odd row at each halving,
    so the 1 × 1 average would be biased;
  - each tap's luminance is **clamped at 16 × KEY before the log**, so a sun glint (COAST's ocean clamps its glint
    lobe at 400) or the sun disc cannot drag the meter: COAST S-EXPO asks for < 0.5 EV of change when panning from
    the beach to the glint [decision];
  - it writes log2 luminance × a centre weight (Tidewater's ellipse, floor 0.15) and the weight;
  - `generateMipmaps` reduces it to 1 × 1;
  - an **async readback every 4th frame** delivers it.
  - The measured luminance is the **exposed** one (× the current exposure), so KEY is a display target (0.18,
    tuned in LAB so a clear noon gives `ae ≈ 1`: the W9 LOOK calibration of 0.515–0.523 sRGB at the plaza stays true).
- **Range:**
  - Medium: lo −0.5 EV, hi +0.5 EV;
  - High and Ultra: −1 / +1 EV;
  - Low: off;
  - the Options row "Auto exposure" (Advanced) turns it off.
- **No pumping:**
  - a **dead band of ±0.2 EV** (no change inside it);
  - speeds of **+0.8 EV/s brightening and −1.2 EV/s darkening** (faster down, so a flash or sunlit sand never burns);
  - centre weighting, so the character in the middle counts, but walking into a house's shade moves the meter less
    than 0.2 EV [projected: the shade covers 10–20 % of the weight] and does nothing.
- **Weather and night:**
  - `hi` shrinks with precipitation: `hi × (1 − 0.8·precip)`, so a storm cannot be adapted back to a bright day;
  - at night `hi` is halved (Tidewater's partial night);
  - the gains `WEATHER_EXPOSURE_GAIN` and `_NIGHT` keep capping the sky's own part.
- **Flash:** while `RenderWeather.flash > 0` the meter freezes (no dark pump after lightning; `reduceFlashing` is
  unaffected).
- **Consumers of the exposure:**
  - the bloom threshold divides by it (as today);
  - `highlightOverlayColor` and `sceneExposure(scene)` [confirmed: `render/post.ts` 254, index.ts 320] read the final
    value, so the hover highlight stays right;
  - the night lights' exposure-aware emissive (`night-lights.ts` computes `sceneDisplay(scene, SkyState.exposure)`)
    must take the final value too, or lamps drift by up to ±1 EV against the scene [confirmed: `night-lights.ts`
    821–828]. It re-sets every lamp's emissive whenever the exposure moves > 2 %; an AE ramp at 1.2 EV/s crosses 2 %
    about 40 times a second, so at night AE could re-set every lamp almost every frame. S2-E feeds it the eased value
    in ≥ 0.1 EV steps (or the lamps compensate in the shader) and LAB measures the CPU during a night ramp [projected];
  - the fog shader needs no `1/exposure` any more (§5.1).

### 7.3 Costs [projected]

GPU: a 64 × 32 pass + a mip chain ≈ 0.01–0.02 ms. CPU: 1 draw + a mip call ≈ 0.03–0.05 ms per frame, and a 4-byte
readback per 4 frames (the promise resolves off the frame). No define ever changes (an exposure is a uniform on the
post stack's own `ImageProcessingConfiguration`, D18).

---

## 8. Ambient light

### 8.1 Ground bounce [decision]

- **Today:** `SkyState.ambient.ground` is the sky's irradiance × albedo 0.25. That is the sky's bounce. The **sun's**
  bounce, several times larger at noon [projected: ambient : key ≈ 13 % at a clear noon, SKY §6.1], is missing, so
  undersides (eaves, chins, the underside of a raised arm, the tree canopies) go flat grey-blue.
- **v1, zero shader cost:** each time `SkyState` updates, the sky system adds to the L1/L2 SH a **clamped-cosine lobe
  from −Y** of radiance

  ```
  E_bounce = keyIrradiance × sin(elevation) × groundAlbedo × sunVis × 0.6 / π
  ```

  - `groundAlbedo` is the mean albedo of the terrain tiles within 60 m of the camera. It is computed per region at
    commit from the tile ids (the retail tile colours; the 9B texture sets' mean when present) and blended by
    distance. It is warm on the loess, greener in the fields and sandy on COAST's beach. Over open sea it is the
    sea's (≈ 0.06), read through COAST's `World.coast?.seaAt(x, z)` accessor (COAST S-BOUNCE), so a character on a
    pier gets no sand-coloured underlight.
  - `sunVis` is the cloud-shadow readback (§4.8) × the fraction of the ground in sunlight around the camera, which is
    the retail lightmap's baked sun term at the camera's tile.
  - The 0.6 is Tidewater's surround occlusion [likely].

  Every PBR material gets it through the SH that WorldLighting already uploads. Cost: a few µs on the CPU.
- **v2, Ultra, optional:** a per-pixel term in the surface plugin with Tidewater's height fade (full within 4 m of the
  ground, 0.4 at 30 m) and the lower-hemisphere weight. It needs the terrain height at the fragment (a height-texture
  tap), so it waits for a need LAB sees.

### 8.2 GTAO vs SSAO2 [decision: build GTAO, keep it only if the A/B wins]

- **Today's SSAO2 works** since W9 LOOK, but on a workaround (`clearPrepassForSsao`). Its geometry-buffer mode is
  broken on WebGPU, and its GPU cost was never measured.
- **GTAO** (`render/gtao.ts`):
  - **input:** our own pass on **the same prepass** (depth + normal);
  - **size:** half res;
  - **samples:** 2 slices × 6 steps on High, 3 × 8 on Ultra, with quadratic spacing, 1.5 m radius and a thickness
    heuristic;
  - **denoise:** the slice rotation cycles over 6 frames with its own history, reprojected with the prepass depth and
    rejected on a depth mismatch of more than 5 %. It never uses TAA's history. A 5+5 depth-aware blur and a
    depth-aware upsample follow.
  - **the sky:** a pixel at the prepass clear value is treated as sky (AO 1). That value is the far depth only
    because `clearPrepassForSsao` sets it (Babylon clears the prepass depth to 0 and the normal to 0), so the clear
    **stays** under GTAO. The dome, the grass and the Classic water never write the prepass [confirmed: `post.ts`
    323–330], so they count as sky and get no AO, as under SSAO2 today.
- **Applying it:**
  - like SSAO2 today, a multiply of the lit colour, strength 0.8;
  - **ambient-only** would be more correct: sample last frame's AO in the PBR plugins' ambient term at the screen
    position [unknown: a 1-frame lag halos moving edges; LAB tries it on Ultra].
- **Cost:** ≈ 0.3–0.5 ms GPU at half res on the dev PC [projected: 12 depth taps × 2 slices over 0.5 M pixels + the
  blur]. CPU: 3 passes (AO, blur, composite), about the same as SSAO2's.
- **The A/B:** LAB renders SSAO2 and GTAO at the plaza, the gate, a tree cluster and the crowd. It compares look (the
  user picks from screenshots) and GPU/CPU with the GPU lock held. Default: GTAO if it is no slower. SSAO2 stays
  selectable for one wave, then is deleted.

### 8.3 Contact shadows (Ultra) [decision; first to cut]

- **What:** a screen-space march toward the key light: 12 steps over 0.4 m on the prepass depth, half res, applied
  only to the key light's visibility inside the surface plugin (last frame's result by screen position).
- **Why:** the feet and small props that the 2048² CSM misses.
- **Cost:** ≈ 0.1 ms [projected].

### 8.4 What the new trees (TREES.md) need from SKY2

- **Cloud shadows** on the canopies: the foliage plugin's key light calls `sroCloudShadow`, the same extern the
  grass uses. The foliage plugin does **not** call it today [confirmed: no `sroCloudShadow` in `pbr/foliage-plugin.ts`],
  so this adds the `cloudNoise` sampler to the tree materials; it goes through the sampler count of §3.5 (on High
  only if trees join the `'ground'` set, a TREES/LAB call).
- **The ground bounce** lights the canopy undersides (v1 through the SH, free).
- **Translucency** uses `keyLight` × the cloud shadow, so a canopy under a cloud stops glowing.
- **GTAO** under canopies (alpha-tested PBR writes the prepass depth).
- **The shafts** through the canopies come free from the CSM in the froxels, as long as the new trees cast into the
  CSM (High: foliage ≤ 60 m).
- **Budgets:** the new tree models must stay within the 16-varying limit and cast within the High foliage range. Their
  CSM draws count against the CPU budget, which is TREES.md's to hold.

---

## 9. Seams: API and shaders (S2-S writes all of them first)

| Where | Addition |
|---|---|
| `sky/types.ts` | `SkyQuality.clouds.kind` += `'volumetric'`; `SkyQuality.volumetric: { res; steps; lightTaps; detailM; shadowMap; panorama; sdf } \| null`. `SkyState` += `cloudVolume: BaseTexture \| null` (the resolved clouds: this frame's ping-pong target, so it alternates each frame; the dome keeps two cached bind groups), `cloudPanorama: BaseTexture \| null`, `skyView: BaseTexture \| null` (the sky-view LUT the dome samples), `hazeVolume: BaseTexture \| null`, `groundBounce: RGB` (what v1 added to the SH, for the perf overlay). `cloudShadow` / `cloudShadowProj` / `cloudNoise` keep their names; under `SRO_CLOUDMAP` their fields mean map origin / 1 ÷ size / strength and light xz ÷ y / `yRef` (§4.8). `SkyState.sh` stays L1. |
| `sky/sky-system.ts` | `dispatchGpu(camera)`, called by `World.update` right after `sky.update` (it uses this frame's camera matrices, computed with `getViewMatrix(true)`, and last frame's CSM matrices: a one-frame lag of the shadow, not visible). |
| `sky/volumetric/` (new) | S2-V's files: `clouds-gpu.ts` (WebGPU compute), `clouds-gl.ts` (WebGL2 fragment), `clouds-wgsl.ts`, `clouds-glsl.ts`, `weather-map.ts`, `noise.ts`. |
| `sky/haze-volume.ts` (new) | S2-H's froxel build. |
| `sky/sky-shaders.ts` | The dome tier `SKY_CLOUDS_VOLUMETRIC` (sampler `cloudVolume`), the haze function below the horizon, and the last-slice shaft tap (S2-S writes an empty tier; S2-V and S2-H fill their functions through exported string constants). |
| `sky/chunks.ts` | The `SRO_CLOUDMAP` body of `sroCloudShadow` (same name, same uniforms, same sampler slot). |
| `pbr/fog-plugin.ts` | Defines `SRO_HAZE_SKY` (Medium+, the LUT colour) and `SRO_HAZE_FROXEL` (High+ WebGPU). Sampler `sroFogRing` → `sroHazeTex` (the LUT or the volume: one sampler slot, a define picks the type). Set by `HeightFog.setActive(on, mode)` from the preset only (today `setActive(on, ring = false)`). The haze colour's weather terms (§5.1: cloud colour × cover, precipitation, the retail grade) are computed on the CPU into +2 vec4 uniforms next to today's four, never a sampler. |
| `render/quality.ts` | `RenderQuality.haze: 'height' \| 'sky' \| 'froxel'`, `ibl.gpu: boolean`, `autoExposure: { ev: number } \| null`, `ao: 'ssao2' \| 'gtao' \| null` (replaces `ssao`'s role; `ssao` kept as the SSAO2 parameters), `contactShadows: boolean`, `groundBounce: 'sh' \| 'pixel' \| null`. `lightShafts` now means the froxel shafts; `horizonRingFog` retires on the PBR presets. |
| `render/post.ts` | `POST_STAGE_ORDER` gains `'gtao'` (at `ssao`'s place, before `ssr`) and `'meter'` (after `default`'s input is known, not a camera stage), and **loses `'vls'`** with the VLS code (§5.5). Each stage's code lives in its own file (`gtao.ts`, `auto-exposure.ts`), and post.ts only calls them (seam). `clearPrepassForSsao` stays for GTAO (§8.2). |
| `render/lighting.ts` | `WorldLighting` takes an `IblSource` interface (`begin`, `step`, `texture`, `polynomial`) and picks `SkyEnvironment` (CPU) or `GpuSkyEnvironment` from `quality.ibl.gpu`. The texture an `IblSource` returns never changes during its life (§6.2). |
| `render/gpu-guards.ts` | Counts samplers per stage, not only varyings (§3.5). |
| `apps/game/src/settings.ts` | `graphics.advanced` += `clouds: 'auto' \| '2d' \| 'volumetric'`, `autoExposure: 'auto' \| 'off'`, and **`aoMethod: 'auto' \| 'ssao' \| 'gtao'`**. The existing `ao` row (`'auto' \| 'off' \| 'half' \| 'full'`) keeps its values, so saved settings survive; the existing `lightShafts` row (`'auto' \| 'off' \| 'on'`) now drives the froxel shafts [confirmed: `settings.ts` 166–172]. Normalisation tests for old saves. |
| `apps/game/src/i18n/en-render.ts` | The row labels (live text, docs/UI.md). |
| COAST seam C1 | The ocean plugin (`ocean/ocean-plugin.ts`, CST-O) runs **before** `SroFogPlugin`, as today. It gets the sky-coloured haze and the shafts for free. It may sample `SkyState.cloudPanorama` for its horizon reflection (an optional define in its own file). |
| COAST seam C2 | `THIRD_PARTY_NOTICES.md` and its test are shared (§12). |

**Shader rules** (WAVE_PLAN3 §4.2 still applies):

- `textureSampleLevel` everywhere in the chunks;
- no swizzle assignment of more than one component;
- no new varying;
- every define set from Options only;
- WGSL and GLSL return the same injection-point keys (a test).

---

## 10. Presets and budgets (the WAVE_PLAN3 §5.2 format)

### 10.1 Preset rows (additions to WAVE_PLAN3 §5.1)

| Feature | Low | Medium | High | Ultra |
|---|---|---|---|---|
| Clouds | retail plane | 2.5D cumulus | volumetric: 0.6×, 96 steps, 4 light taps, detail ≤ 2 km (WebGPU); 2.5D on WebGL2 unless LAB passes §4.10 | volumetric: 0.75×, 128 steps, 6 taps, detail ≤ 3 km (both backends) |
| Cloud shadows | — | — (2.5D clouds cast none on Medium, as today) | the map (WebGPU; the noise on WebGL2): terrain, grass, water, as today's `'ground'` (objects only if the sampler count clears it, §4.8) | the map: + objects (`'all'`, as today) |
| Haze | linear retail | sky-coloured (LUT) | froxels 160 × 90 × 64 with shafts (WebGPU), LUT (WebGL2) | froxels + temporal history |
| IBL | — | GPU, 32², ≥ 5 s | GPU, 64², ≥ 3 s, the panorama's clouds | GPU, 64², ≥ 2 s |
| Auto exposure | — | ± 0.5 EV | ± 1 EV | ± 1 EV |
| Ground bounce | — | SH lobe | SH lobe | SH lobe (+ per pixel if built) |
| AO | — | — | GTAO or SSAO2 (A/B), half res | GTAO full effort |
| Contact shadows | — | — | — | yes |

### 10.2 Costs per preset (1080p, the plaza view; dev PC = Ryzen 5 9600X + RX 9060 XT)

The other columns are scaled as COAST §8.11 does:

- mid desktop (RTX 3060 / RX 6600) ≈ 1.5 × the dev PC;
- gaming laptop ≈ 1.2 × a mid desktop;
- Apple M1 (8-core GPU) ≈ 4.5 × a mid desktop;
- M1 Pro and up ≈ 2 × a mid desktop.

Only the dev-PC kernel times are measured. Everything else is **[projected]**. The cloud march is latency-bound
(§4.3), so its scaling to Apple's tile GPUs is [unknown]. The Apple columns are at 1080p; a Retina Mac at render scale
0.75 draws ≈ 1.4 × those pixels (COAST §F F11), so multiply the per-pixel parts (the trace, the resolve, the haze taps,
AE) by ≈ 1.4 there.

| Preset | CPU, main thread (dev) | GPU dev PC | GPU mid desktop | GPU gaming laptop | GPU Apple M1 | GPU M1 Pro+ | VRAM |
|---|---|---|---|---|---|---|---|
| Low | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Medium | +0.03–0.05 ms (AE) − the CPU cube's ≈ 0.02 average → **≈ +0.03 ms**; worst frame ≈ 0.25 ms instead of ~1 ms | haze 0.01–0.02 + AE 0.02 + IBL < 0.01 ≈ **0.04 ms** | 0.06 | 0.07 | 0.27 | 0.12 | + 0.1 MiB |
| High (WebGPU) | the 5 dispatches + UBO **0.09 (measured)** + AE 0.04 + IBL ≈ 0.01 average − CPU cube ≈ 0.04 → **≈ +0.1 ms** | clouds 0.25–0.28 (the resolve up to 0.06 in a full frame) + dome −0.05 (cheaper than 2.5D) + froxels 0.05 + tap 0.01 + AE 0.02 + IBL < 0.01 ≈ **0.3 ms**, plus GTAO's delta against SSAO2 [unknown] | 0.45 | 0.55 | 2.0 | 0.9 | noise 8.1 MiB + weather map 1 + clouds 2 × 5.7 MiB (0.6×, RGBA16F) + trace 0.4 + shadow 0.25 + panorama 0.5 + froxels 7.0 ≈ **29 MiB** |
| High (WebGL2, fallback off) | ≈ +0.05 ms | ≈ 0.04 ms (Medium's) | — | — | — | — | + 0.1 MiB |
| Ultra (WebGPU) | ≈ +0.1 ms | clouds 0.40 + froxels with temporal 0.07 + tap 0.01 + AE 0.02 + contact 0.1 ≈ **0.6 ms** + GTAO | 0.9 | 1.1 | 4.0 | 1.8 | noise 8.1 + weather map 1 + clouds 2 × 8.9 MiB (0.75×) + trace 0.6 + shadow 0.25 + panorama 0.5 + froxels 2 × 7.0 ≈ **42 MiB** |
| Ultra (WebGL2 fragment) | + 0.2–0.3 ms (4 passes) | ≈ 0.55 ms (no froxels) | 0.8 | 1.0 | — | — | ≈ 28 MiB (no froxels) |

What the table means:

- **High's problem is CPU, and SKY2 keeps it that way.** The measured CPU cost of all cloud and haze dispatches plus
  the uniform update is 0.09 ms in total (0.044 ms of it the UBO update) [confirmed: prototype]. With AE and the IBL
  draws added and the CPU cube removed, **High's CPU moves by ≈ +0.1 ms** on average, with lower peaks.
- **High's GPU work, about 0.3 ms**, sits inside a frame whose GPU part is 2.3–4.3 ms against 15–19 ms of CPU. It is
  invisible on the dev PC and on gaming desktops and laptops.
- **Apple M1:** High's 2 ms (≈ 2.8 ms at Retina 0.75) is real, but every adapter now defaults to Medium (the release
  decision, WAVE_PLAN3 §5.1 first-run default). There, SKY2 costs about 0.3 ms (≈ 0.4 ms at Retina 0.75): the haze,
  the AE and the GPU IBL. COAST projects a base M1 at 11–15 ms of GPU at the beach on Medium, so this is small but
  not free.
- **The whole-frame CPU A/B could not be measured** at a 34 % machine load: the same configuration swung between 5.6
  and 9.6 ms p50 [confirmed: `results.json`]. LAB repeats it on a quiet machine with the real game (§11.4).

### 10.3 Per-lane budgets (dev PC, 1080p, the town view; minimum of 5 runs, GPU lock held, RENDER §16 hygiene)

| Lane | Budget |
|---|---|
| S2-V clouds | High ≤ 0.3 ms GPU, Ultra ≤ 0.5 ms (the plaza at dusk with the horizon in view, overcast and fair). CPU, S2-V and S2-H together: ≤ 0.09 ms per frame for the dispatches and uniforms (the prototype's measured mean), target ≤ 0.06 ms after the UBO split and `fastMode`. Noise load ≤ 150 ms of main-thread time (fetch + one 3D upload; the files need no decode). A camera cut must be sharp in ≤ 4 frames. |
| S2-H haze | Medium ≤ 0.03 ms GPU. High ≤ 0.1 ms (the build + the taps). CPU: its dispatch inside the shared budget above; +0 per draw. Horizon seam ≤ 2/255, including the overcast and rain cases (§5.1) and the sea at 2,000 m (§5.3). Zero new varyings; zero new samplers on High. |
| S2-I IBL | ≤ 0.25 ms CPU on any refresh frame. ≤ 0.05 ms GPU per refresh. The GPU SH is within 2 % of the CPU SH. No `environmentTexture` reassignment and no change of the live texture's `uniqueId` during a session (a test). |
| S2-E exposure | ≤ 0.05 ms CPU, ≤ 0.03 ms GPU. No visible pump walking from the plaza into the gate tunnel and back (user check). |
| S2-A ambient | GTAO ≤ SSAO2's measured GPU cost + 0.1 ms. Ground bounce ≤ 0.02 ms CPU. Contact shadows ≤ 0.15 ms GPU (Ultra). |
| Whole wave | The WAVE_PLAN3 gate still holds: Medium on WebGL2 ≥ 60 fps everywhere, High on WebGPU no worse than wave 9's 17.9 / 21.5 ms p95 (plaza / crowd) + 0.1 ms. A single p95 cannot resolve 0.1 ms (budgets.md's same-config runs moved by more), so the gate is judged on the median of 5 runs' CPU p50, SKY2 on vs off, same build and machine load. The CPU fix for High is item 9 of the backlog, not this wave. |

---

## 11. The prototype and the measurements

### 11.1 What it is [confirmed]

`work/tmp/sky2/index.html`, `main.ts`, `shaders.ts`. It is served by the viewer's running Vite at
`http://localhost:5173/@fs/C:/dev/silkroad/work/tmp/sky2/index.html?timing=0`. It imports only `@babylonjs/core`
9.28 (no repo package, because a release workflow was editing them).

**The scene:**

- 1,600 m of rough ground and **500 separate PBR boxes**;
- High's CSM: 3 × 2048, 150 m, PCF, λ 0.8, stabilised;
- a FreeCamera 22 m up, looking toward a sun 14° high, so the horizon is in view and the sky is about 40 % of the
  frame [likely]. The camera looks **about 6° up**, not 15°: it sits at (0, 22, −180) aiming at (0, 70, 300)
  [confirmed: `main.ts` 48–49; `results.json`'s "15 deg" describes the sun]. Babylon's `fov` 0.9 is vertical.

**The kernels,** all WGSL compute through `ComputeShader`:

- noise generation (shape 128³, detail 32³, weather 512²);
- the trace, the ping-pong resolve, the cloud-shadow map and the panorama;
- the froxel haze with CSM + cloud-shadow taps, and the screen-space haze for comparison.

**The composite:**

- a WGSL `ShaderMaterial` dome samples the resolved clouds;
- a WGSL `MaterialPluginBase` on both PBR materials samples the froxel volume at `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR`.

**The look is not tuned.** The clouds are blotchy and the sun is oversized. The prototype exists for cost and
feasibility, not for the look.

**What the fact-check found in the prototype** [confirmed: read `main.ts`, `shaders.ts`]:

- The froxels' `cloudShadow(p)` looks the map up at the point projected **to the cloud base**, while `SHADOW` writes
  it indexed by the **ground** point. At the prototype's sun that lookup lands ≈ 5.9 km away, off the 2,048 m map, so
  the froxels read the clamped edge. The cost is right (one tap either way); the cloud part of the shafts in
  `proto-haze-on-off.jpg` is not evidence of the look. §4.8 fixes the convention.
- No `ComputeShader` sets `fastMode`, so the 3 µs per dispatch includes the readiness checks.
- The haze plugin's depth coordinate `sqrt(d / 320)` samples slice centres half a slice early (slice z stores the
  value at `((z + 1) / 64)² × 320`); S2-H offsets it by half a texel.
- The aerial perspective of the clouds uses `exp(−t₀ / 120 km)`, not the `30 km` of §4.3; §4.3 is the design value.

### 11.2 Method [confirmed]

- **GPU lock:** `work/tools/gpu.lock` was created at 18:58 and removed at 19:04 (2026-09-29).
- **Frames:** Babylon's `enableGPUTimingMeasurements` was **off**. With it on, the counters were quantised to powers
  of two in ns and each dispatch paid about 0.05 ms more GPU wall time. The browser pane was hidden, so rAF never
  fired. A `MessageChannel` pump drove the frames with one frame in flight, like the wave-9 perf pass's timer pump.
- **Per kernel:** 40–60 frames of K back-to-back dispatches of one kernel (K = 60–300, no scene render) against frames
  of 1. GPU time per dispatch = the difference of the median frame wall time / (K − 1). The CPU time is the mean JS
  time per dispatch.
- **Caveats:**
  - repeated dispatches run with warm caches, so they read slightly optimistic (the resolve most: §4.12);
  - `performance.now()` is 0.1 ms-coarse, which K large enough makes negligible;
  - the machine CPU load was 34 %, from other agents, which makes the whole-frame CPU numbers unusable.

### 11.3 Results [confirmed: `work/tmp/sky2/results.json`]

| Kernel | GPU ms per dispatch |
|---|---|
| Cloud trace, 0.75× (1440 × 810 → 360 × 203 threads), 128 steps, 6 light taps, detail 3 km, coverage 0.45 | 0.322 |
| … coverage 0.90 / 0.15 | 0.317 / 0.037 |
| … 3 light taps | 0.215 |
| … 64 steps | 0.167 |
| … no detail erosion | 0.317 |
| … resolution 0.6× / 0.5× | 0.291 / 0.273 |
| … camera 45° up (no horizon) / same, overcast | 0.114 / 0.151 |
| Resolve 1440 × 810 / 960 × 540 | 0.027 / 0.022 |
| Cloud-shadow quarter (256 × 64 texels, 8 steps) | 0.003 |
| Panorama 1/32 of 512 × 128 (48 steps, 2 light taps) | 0.044 |
| **Froxel haze 160 × 90 × 64 (CSM + cloud shadow per froxel)** | **0.051** |
| Screen-space haze, half res, 16 steps (Tidewater's layout; not chosen) | 0.084 |
| One dispatch, CPU (no timestamps / with timestamps) | 0.003 / 0.012–0.015 ms |
| All 5 per-frame dispatches + the 17-field UBO update, CPU mean | 0.09 ms (UBO alone 0.044) |
| Noise generation on the GPU, incl. pipeline creation | 2,181 ms first load; 439–626 ms later |

**Feasibility findings** [confirmed]:

- the CSM's shadow map binds into compute (R16F 2D array);
- 3D storage textures work through `RawTexture3D` + `TEXTURE_CREATIONFLAG_STORAGE`;
- a PBR material plugin can sample a 3D texture with no new varying;
- compute dispatched before `scene.render()` is visible to the same frame's dome and materials.

Images: `work/tmp/sky2/proto-first-frame.jpg` (the first composite), `proto-haze-on-off.jpg` (froxel haze and shafts
on, then off).

### 11.4 Not measured, for LAB [unknown]

- The WebGL2 fragment fallback (its CPU per pass is the question).
- The froxel temporal history.
- The GPU IBL passes.
- GTAO against SSAO2.
- Auto exposure.
- The whole-frame CPU A/B in the real game at the plaza and in the crowd.
- Anything on Apple or on a gaming laptop.

---

## 12. Licence: Tidewater's MIT notice, and three.js's

- **What the licence is** [likely: `LICENSE` at `4811ba4`, read through the fetch tool; COAST §8.12 confirmed the same
  line]: MIT, *Copyright (c) 2026 DRG Software Solutions LLC*. Porting is allowed with the notice kept. **No Tidewater
  asset is used**: our noise volumes are generated by our own code, and our LUTs are ours.
- **One file for the project:** `THIRD_PARTY_NOTICES.md` at the repo root (none exists today, COAST §8.12 [confirmed
  there by `git ls-files`]). Whichever lane lands first creates it: CST-O (COAST) or S2-V (SKY2). Each later lane
  appends its files. The entry holds:
  - the project, its URL and the pinned commit `4811ba4`;
  - the full MIT text with the copyright line;
  - the list of our files with ported code.
- **The header** on every file with ported code: *Portions ported from Tidewater (github.com/dgreenheck/tidewater,
  `<file>` at `4811ba4`), MIT licence, Copyright (c) 2026 DRG Software Solutions LLC. See THIRD_PARTY_NOTICES.md.*
- **SKY2's expected entries:**

  | Our file | Ported from |
  |---|---|
  | `sky/volumetric/clouds-wgsl.ts`, `clouds-glsl.ts` | `Clouds.js`: the checkerboard order, the light bands, the multiple-scattering and powder formulas, the Earth-shadow term |
  | `sky/haze-volume.ts` | `AirHaze.js`: the phase mix, the quadratic spacing |
  | `render/ibl-gpu.ts` | `Environment.js`: the schedule, the filtered importance-sampling LOD rule |
  | `render/auto-exposure.ts` | `PostFX.js`: the centre-weight ellipse, the speeds |
  | `render/gtao.ts` | `GTAO.js` |
  | `sky/sky-system.ts` (ground bounce) | `GroundBounce.js`: only if code, not just the idea, is taken |

- **three.js too:** Tidewater's `GTAO.js` is itself a port of three.js's GTAO (three.js r186 parity is named in it)
  [likely]. If `render/gtao.ts` ports from it, the entry also carries **three.js's MIT notice** (*Copyright © 2010–2026
  three.js authors*). S2-A checks the exact line in three.js's `LICENSE` when porting.
- **The papers** (Hillaire 2016/2020, Schneider/Nubis, Jimenez 2016 GTAO) are techniques, not code, so they carry no
  notice. They are cited in the file comments.
- **Shipping:** the notice ships next to the game files (COAST §8.12 rule 3). The test is COAST's S-NOTICE test,
  one for both specs: `packages/world-render/test/tidewater-notices.test.ts` (COAST's `ocean-notices.test.ts`,
  renamed, per COAST §8.13; WAVE_PLAN4 may pick another name, but there is one file). It also covers the three.js
  entry. It checks:
  - every file with the header is listed;
  - every listed file exists;
  - `THIRD_PARTY_NOTICES.md` is in the deploy file list.

---

## 13. Lanes

**Entry criteria:**

- the wave-9 release workflow has finished and merged (it edits `packages/` and `apps/` now);
- WAVE_PLAN4 has merged this with COAST and TREES.

Lane ids are prefixed `S2-`.

### 13.1 Step order

```
step 0 (one agent):          S2-S seams (+ THIRD_PARTY_NOTICES.md if CST-O has not created it)
step 1 (parallel):           S2-V clouds | S2-H haze | S2-I IBL | S2-E exposure | S2-A ambient | S2-C noise export
step 2 (after step 1):       S2-G game/options | S2-L lab, bench, A/Bs, sign-off
step 3:                      I-S2 integration → H-S2 hunt → fixes
```

Soft data dependencies inside step 1:

- S2-H and S2-I use the cloud-shadow map and the panorama from S2-V. Until it lands they bind the 1 × 1 fallbacks
  S2-S provides: no shadow, and the 2.5D radiance.
- S2-V needs S2-C's noise files. It runs on GPU-generated noise (the prototype's kernels) until they land.

### 13.2 File ownership, seams, tests, user checks

| Lane | Owns (creates or edits) | Uses (seams only) | Tests | User checks |
|---|---|---|---|---|
| **S2-S** | Everything in §9 as skeletons: `sky/types.ts` fields, the `SKY_PRESETS` and `RENDER_PRESETS` rows (§10.1) as data, the empty dome tier, the `SRO_CLOUDMAP` body stub, the fog plugin define skeleton, `IblSource`, `POST_STAGE_ORDER` (+ `gtao`, `meter`; − `vls` and the VLS code), the settings rows (`clouds`, `autoExposure`, `aoMethod`; `ao` and `lightShafts` unchanged), i18n keys, `gpu-guards.ts` sampler count, 1 × 1 fallback textures, `THIRD_PARTY_NOTICES.md` + its test (if CST-O has not created them) | — | Low guard unchanged; presets complete; settings normalise (old `ao` values survive); WGSL/GLSL key parity; the D32 texture-unit count extended to the surface, foliage and fog plugins: the heaviest Medium and High materials ≤ 16 on WebGL2 (today terrain Medium 13, High 16, §3.5) | — |
| **S2-C** | `packages/convert` sky noise export (`export-sky.ts` gains `cloud-shape.bin` and `cloud-detail.bin`; deterministic seeds; `sky.json` lists them; `NOISE_VERSION`-style hash pin) | — | Periodicity (the edges match); the checksum stable across runs; coverage fractions; the files survive `optimize/run.ts` (copied, `.br` written) | — |
| **S2-V** | `sky/volumetric/*`, the dome tier's cloud code (as exported constants), the `sroCloudShadow` map body, the key-light readback in `sky-system.ts` (one method) | `SkySystem.dispatchGpu`, `SkyState` fields | Reprojection maths (pure); the Bayer order covers 16/16; the weather → coverage map; a NullEngine build falls back to 2.5D; the WGSL compiles (a WGSL parser test, no GPU) | Clouds at 07:00, noon, 18:30, midnight, in rain; fast orbit smear; a teleport rebuild |
| **S2-H** | `pbr/fog-plugin.ts` (taken over from RND-P for this wave), `sky/haze-volume.ts`, the haze function (a string constant) used by the dome and the grass/water chunks | chunk points (grass, water) | `hazeColor` in TS matches the shader maths (the CPU copy) within 1/255; horizon seam ≤ 2/255 (headless LUT); no varying added (`gpu-guards`) | Far hills at noon and dusk; shafts in the plaza at 07:00; a storm (no shafts, grey); the new sea's horizon (with COAST) |
| **S2-I** | `render/ibl-gpu.ts`, the `IblSource` switch in `render/lighting.ts` | the panorama / 2.5D radiance | GPU SH vs CPU SH ≤ 2 % (WebGPU and WebGL2 in LAB; a pure-maths test for the LOD rule); the texture object never reassigned and its `uniqueId` unchanged across refreshes (no `_swapAndDie`); a jump finishes in one frame; a late SH readback is dropped | Reflections on armour and wet ground under clouds; no pop at a refresh (COAST S-IBL) |
| **S2-E** | `render/auto-exposure.ts` + its stage call in `post.ts` | `SkyState.exposure`, `RenderWeather` | The ease, dead band and clamps (pure); a storm cap; the meter frozen during a flash | Walk from the plaza into the gate tunnel and back; lamps at night; sunlit sand (COAST) |
| **S2-A** | `render/gtao.ts`, the ground-bounce lobe (a pure function called by `sky-system.ts`), `render/contact-shadows.ts` | the prepass, `SkyState` | SH lobe maths; GTAO sky-depth handling (a pure function); SSAO2 fallback selection | SSAO2 vs GTAO screenshots (the user picks); undersides of eaves and faces at noon |
| **S2-G** | `apps/game` options rows, the preset rule (clouds `auto` = 2D on WebGL2 High unless LAB says otherwise; the first-run default is Medium for everyone, so this only applies when a player picks High), perf overlay rows (clouds, froxels, IBL slice, AE; the overlay turns GPU timing on and gives the sky compute shaders their counters, §3.2) | settings seams | Settings round trip; the watchdog steps clouds → 2D before High → Medium, and that step changes no material define (§4.8) | The Options rows read clearly in English |
| **S2-L** | `apps/viewer` lab page additions (sky2 panel), `work/tmp/s2-lab/` bench scripts | everything | — | The screenshot sheets for the user (§16) |
| **I-S2** | Merges, docs updates (SKY.md "superseded by SKY2" notes, RENDER.md §4.2/§5.3/§5.5, WAVE_PLAN3 cut list), deletion of `work/tmp/sky2/` after LAB | — | Whole suite, typecheck, Low guard after each merge | Final screenshot sheet |

### 13.3 H-S2 hunt lenses

1. **Black frame on WebGPU:** a new sampler or varying over the limit on a 16-varying adapter (`?gpuLimits=default`);
   a compute binding with a mismatched view dimension.
2. **GLSL reaching WebGPU** in any new pass.
3. **Stale history:**
   - a cloud smear after a teleport, a GM `time` jump or a char-select round trip;
   - a froxel ghost at a camera cut;
   - GTAO trails.
4. **Readback hazards:**
   - a readback promise resolving after dispose (world change);
   - an `ae` NaN from a zero luminance (a black loading frame);
   - a SH readback arriving after a newer refresh started;
   - a stale bind group after any in-place texture swap (WebGPU "Destroyed texture used in a submit", §3.8).
5. **Hitches:** the noise load on the main thread; a refresh slice overlapping a region commit; a define change on
   weather or time (never allowed).
6. **Leaks:** storage textures, RT cubes and compute shaders over world → char-select → world (the open "memory growth"
   item in BACKLOG).
7. **Double application:** fog twice on water (the ocean plugin + `SroFogPlugin`); exposure applied twice (the dome in
   output mode 0 + post); the cloud shadow twice (map + noise).
8. **Seams:**
   - the horizon line (dome vs fog vs sea);
   - the cloud-shadow map re-centre pop;
   - the froxel far slice against the dome.
9. **Weather extremes:** full overcast at night, a storm flash, cover 0 (no dispatch waste: the trace exits, measured
   0.037 ms at 0.15).
10. **Readability:** a mob at 30 m in shafts at dusk; UI unaffected by AE; `reduceFlashing`.
11. **Licence:** a ported file without its header or missing from `THIRD_PARTY_NOTICES.md`.

### 13.4 Tests and gates

- Every lane: its tests, `pnpm typecheck`, and the whole suite green at hand-off.
- The Low guard after every merge.
- LAB's budget table (§10.3) with the GPU lock held.
- The user's picks (§16) before I-S2 sets the defaults.

---

## 14. Scope-cut order (cut from the top)

1. Contact shadows (Ultra).
2. Ground bounce v2 (per pixel). v1 in the SH stays.
3. The froxel temporal history (the jitter goes off; the slices are fixed).
4. Ultra cloud extras: the SDF skip, 6 → 4 light taps, detail ≤ 2 km.
5. GTAO → keep SSAO2.
6. The WebGL2 volumetric fallback → WebGL2 keeps 2.5D on every preset.
7. The froxel shafts → High and Ultra use the analytic sky-coloured haze (Medium's).
8. The cloud panorama → the IBL uses the 2.5D cloud function on every preset.
9. Auto exposure on Medium (High keeps it).
10. Volumetric clouds on High → Ultra only (High keeps 2.5D + the cloud-shadow noise).
11. Auto exposure entirely.

**Never cut:**

- the sky-coloured haze (LUT) on every PBR preset, with the horizon seam test;
- the GPU IBL (it removes CPU spikes);
- "no new draws";
- the Low guard;
- the 2.5D clouds as the fallback everywhere;
- `THIRD_PARTY_NOTICES.md`.

---

## 15. Risks

| Risk | Tag | Mitigation |
|---|---|---|
| Sampler limit on Medium materials (+1 `skyView`) | [confirmed for the terrain: 13 → 14 of 16; the objects, foliage and water materials are not counted yet] | The S2-S guard test. Fallback: the haze colour as CPU-computed uniforms (an azimuthal series at two elevations: below the horizon `dirH` is clamped to 0.9°, so there the colour depends on azimuth only), no sampler. |
| An in-place texture swap (`_swapAndDie`) on the live IBL cube leaves stale WebGPU bind groups | [confirmed in the source; the black frame is likely] | Designed out: persistent source + live cubes, the live one rendered in place (§6.2). A test pins the `uniqueId`. |
| Writing the live cube one level per frame shows a mix of old and new levels for 7 frames | [projected: invisible at a 0.5° sun move] | LAB's "no pop" check (COAST S-IBL). Fallback: render the whole refresh into a third cube and copy it into the live one in one frame (WebGPU `copyTextureToTexture` per level, WebGL2 a blit per face and level; no `uniqueId` change). |
| The night lights re-set every lamp's emissive on each > 2 % exposure move | [projected, §7.2] | Quantised AE steps for the lamps; LAB measures the CPU during a night ramp. |
| Babylon compute + prepass + MSAA interplay on some adapter | [unknown] | The prototype had no prepass. LAB runs High with SSAO or GTAO on. |
| Cloud march cost on Apple tile GPUs | [unknown] | Every adapter defaults to Medium (2.5D). High on Mac is measured before it is recommended. |
| The kernels were timed with warm caches | [projected: the resolve's traffic exceeds what DRAM allows in 0.027 ms] | LAB times the real frame with SKY2 on vs off (§10.3), not the kernels alone. |
| Horizon rays dominate the march | [confirmed: §4.3] | Step caps, the 40 km cap, the SDF as the Ultra option. |
| The dense haze makes the shafts too strong | [likely] | `kShaft` + a cap, tuned by the user's screenshot pick. |
| AE fights the W9 LOOK calibration | [projected] | KEY is set so `ae = 1` at the calibrated plaza noon. The test pins it. |
| Tidewater's numbers were read through a summarising fetch | [likely] | Each lane re-reads the file at `4811ba4` before porting (§12). |

---

## 16. Needs from the user (each has a default, so nobody waits)

1. **Volumetric clouds on High (WebGPU) and Ultra only;** Medium and every WebGL2 High keep today's 2.5D clouds.
   Default: **yes**.
2. **An extra download of about 7.5 MB** (the cloud noise volumes: 8.1 MiB raw, which barely compresses: ≈ 7.2–7.4
   MiB on the wire [projected, §4.2]), served by our own game server and loaded only when a friend first picks High
   or Ultra. Default: **yes**. The alternative is a single-channel variant (≈ 1.4 MB on the wire) with slightly
   softer clouds.
3. **The cloud look** from a LAB sheet (noon, 18:30, storm): temperate fair-weather cumulus (default) or taller
   Tidewater-style towers. Default: **temperate cumulus + a stratus deck in rain**.
4. **The haze strength** from a sheet: keep today's visibility (default), or thinner. Thinner shows more of the world
   edge at 250 m, which COAST's sea partly hides.
5. **AO:** SSAO2 or GTAO, from side-by-side screenshots. Default: **GTAO if it is no slower**.
6. **Auto exposure** on or off by default, after walking the gate tunnel in the lab. Default: **on, ±1 EV High, ±0.5
   EV Medium**.
7. **Trees:** this spec lights them (§8.4); the models are TREES.md's. Nothing needed here.
8. **Who gets to see the 3D clouds.** You asked for "3D volumetric clouds and cloud shadows". As designed, they run
   only on WebGPU at High or Ultra. With the release default at Medium and everyone on plain http (so WebGL2) until
   the Tailscale HTTPS step in DEPLOY.md is done, **no friend sees them until (a) HTTPS is set up and (b) they pick
   High**. Medium players get the sky-coloured haze, better reflections, auto exposure and the bounce light.
   Default: **keep it so, and do the HTTPS step during wave 10** so the High option is real. The alternative is a
   lighter volumetric setting on Medium with WebGPU (64 steps, 3 light taps: ≈ 0.2 ms on the dev PC with the resolve
   and the panorama, ≈ 1.3 ms on a base M1 at 1080p [projected from §4.12]) as an opt-in row, off by default; it
   still needs HTTPS.

## 17. Open questions (each has a default)

1. **Should High get volumetric clouds while High still misses 60 fps on CPU?** Default: **yes**. The cost is mostly
   GPU (≈ 0.3 ms on the dev PC) plus ≈ +0.1 ms of CPU (measured 0.09 ms of dispatches and uniforms). The CPU fix is
   backlog item 9.
2. **The WebGL2 volumetric fallback on High.** Default: **off**; LAB turns it on only if it costs ≤ +0.25 ms CPU at
   the plaza.
3. **Noise delivery:** converter files (default) or GPU generation at load on WebGPU (0.4–2.2 s, measured) with files
   only for WebGL2. Default: **files for both** (the same clouds everywhere, no load hitch).
4. **The froxel far distance:** 320 m (default), or tied to `FOG_RANGE_M` × the weather's fog scale. Default: **320 m
   fixed**. A longer clear-day view later changes it.
5. **The ground albedo source for the bounce:** the retail tile colours, or the 9B sets' mean when present. Default:
   **the 9B mean when present, else retail; the sea's 0.06 over open water** (COAST S-BOUNCE).
6. **GTAO ambient-only** (a 1-frame-late AO in the materials) vs a colour multiply. Default: **multiply** (as SSAO2);
   LAB tries ambient-only on Ultra.
7. **The IBL refresh interval on High:** 3 s (default) or the sun-move key alone. Default: **3 s minimum with the
   0.5° key**.
8. **Keeping the CPU cube code after the switch.** Default: **keep** it as the NullEngine and test reference.
9. **Contact shadows at all.** Default: **Ultra only, first cut**.
10. **How the live IBL cube is updated.** In place, one level per frame over 7 frames (default), or rendered whole into
    a third cube and copied in one frame (atomic, but it needs engine-internal copy calls on both backends). Never
    `_swapAndDie` (§3.8). Default: **in place**; LAB's "no reflection pop" check decides.
11. **Cloud shadows on High objects and trees** (today High shadows only the terrain, grass and water). Default:
    **no** until the extended D32 count (S2-S) shows a free texture unit on those materials on WebGL2; then LAB
    judges the look.
12. **Should the 2.5D clouds also write the cloud-shadow map on WebGPU High+** (§4.8), so the watchdog's clouds → 2D
    step recompiles only the dome? Default: **yes** (≈ 0.003 ms per frame).
13. **The notices test's name.** COAST says `tidewater-notices.test.ts`; it also carries three.js's entry. Default:
    **COAST's name**; WAVE_PLAN4 may rename it once.
