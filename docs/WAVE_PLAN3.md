# Wave plan 3: wave 9, "make the world beautiful" (9A engine, 9B texture pipeline)

This plan merges four verified specs into one build order:

- **docs/RENDER.md**: PBR materials, lighting, shadows, IBL, post-processing, quality presets;
- **docs/SKY.md**: the atmosphere, sun, moon, stars, clouds, the server clock, and night lighting;
- **docs/WEATHER.md**: server weather, rain, wet surfaces and puddles, wind, lightning, weather audio;
- **docs/TEXPIPE.md**: the local texture upscale and PBR-map pipeline, its formats, budgets and tiers.

It also takes in **docs/DETAIL.md** (committed in `92072dc`: layered detail for actors, renderer hooks H1–H10) and
**docs/REMASTER.md** (the Meshy Retexture client, approved for a capped test), where they touch the same files.

It does four things:

- it settles every place where those specs disagree, name the same thing twice, or leave a file with two owners
  (§2);
- it merges their wire additions (time of day and weather) into one collision-free protocol list (§3);
- it builds **seams first** (§4): one foundation step puts every cross-lane hook into the shared files, so the lanes
  own disjoint files;
- it cuts **wave 9A** (the engine: PBR, lighting, shadows, IBL, post, sky and time of day, weather and wetness,
  all working with the **current retail textures**) and **wave 9B** (the texture pipeline: tools, the test set, then
  batches) into steps and lanes (§6, §7).

When this plan and a spec disagree, **this plan wins**. The specs stay the detailed design of each lane; a lane
reads its spec sections and this plan's row for it.

**Tags.**

- **[confirmed]**: checked in the code or data at HEAD `92072dc`, in `node_modules/@babylonjs/core` 9.28.0, or
  measured by a spec's prototype and re-checked by its fact-check.
- **[likely]**: strong evidence, not proven.
- **[projected]**: a cost scaled from a measurement, not measured on that hardware.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this plan makes.

**Repo state when this was written [confirmed].**

- HEAD `92072dc` ("Wave 9 texture test: Meshy retexture client, remastered-textures test switch, detail plan").
  `git status` shows only the four untracked spec docs. `apps/game/src/three/remaster.ts` (the `sro-remaster`
  manifest, `RemasterLighting` with a `ReflectionProbe` re-captured every `PROBE_REFRESH_MS = 30_000`) is
  **committed**, not in flight. Spec line numbers drift: **every hook is found by its quoted code, not its line
  number**.
- `WorldQuality` is `'low' | 'medium' | 'high'` (`world.ts:48`); `settings.ts` `PRESETS = ['low','medium','high']`,
  `RESOLUTIONS = [1, 0.75, 0.5]`; `STREAM_DEFAULTS.high.tileLayers = 96`.
- `apps/game/src/engine.ts` creates `new WebGPUEngine(canvas, { antialias: true, adaptToDeviceRatio: true })`: no
  limits and no optional features are requested.
- Protocol v1: no `worldClock`, `weather` or `lightning` message exists; `WorldInfo` has no `clock` or `weather`
  field; the GM names `time` and `weather` are free (`gm.ts` `COMMANDS`). No database migration is needed by any
  lane of this wave.
- Existing registries this plan reuses: `registerOptionRow(page, row)` (`hud/options.ts:238`), `WORLD_FEATURES`
  (`world/features.ts:103`), `RegionStreamer.schedule` (`stream.ts:407`), `WorldObjects.setAmbient` (the model for a
  generic region listener, `objects.ts:153`).
- Scratch the lanes port from: `work/tmp/render/` (bench, terrain-plugin prototype, shadow proxy `proxy3`),
  `work/tmp/sky/` (atmosphere and cloud-noise prototypes), `work/tmp/weather/` (CPU prototypes, reference rain
  shader), `work/tmp/texpipe/` (~690 MB of prototypes and previews), `work/tmp/texpipe-fc/mipbench.ts`,
  `work/tmp/detail/` (~910 MB, DETAIL.md).

---

## 0. Summary

1. **Two waves, engine first.**
   - **Wave 9A** = RENDER + SKY + WEATHER. It ships the modern look **with the retail textures**: PBR materials with
     derived defaults (class roughness, retail lightmaps as baked sun visibility, no normal maps), a moving sun and
     moon on a server clock, soft cascaded shadows, sky ambient and reflections, HDR with tone mapping, bloom, AO,
     grading, lamps at night, and server weather with rain, wet ground, puddles and wind. Nothing in 9A waits for
     upscaled art.
   - **Wave 9B** = TEXPIPE (+ the optional DETAIL layers). The local pipeline upscales and derives PBR maps, a human
     reviews, and the sets reach the game through the loader 9A already built: first a test set of 14 textures,
     then the hero set, then the town, then the fields, then actors.
2. **Seams first, then lanes** (the WAVE_PLAN/WAVE_PLAN2 method). Two foundation agents run first and in parallel:
   **W9A-P** (protocol, shared maths, server) and **W9A-S** (every client seam). After them, no lane edits
   `world.ts`, `shaders.ts`, `scatter-assets.ts`, `terrain.ts` (outside RND-T), `objects.ts`, `stream.ts`,
   `engine.ts` or `settings.ts`; they fill their own files through the seams (§4).
3. **One owner per state** (§2.2): the server owns the clock and the weather; the sky owns `SkyState`; the weather
   lane owns `WeatherFrame`, the wet/dry rates, the fog *distance*, the shelter map and the ripple texture; the
   render lane owns the light, shadows, IBL upload, the post stack, tone mapping and the material response on the PBR
   path; `render/quality.ts` owns the preset table.
4. **"Classic" is a material path, not a freeze of everything.** Low keeps today's `ShaderMaterial` terrain and
   `StandardMaterial` objects. Sky style (modern/classic) and weather level are separate settings. The regression
   guard is: **Low + sky `classic` + weather `off` + a frozen noon renders exactly as HEAD** (§4.4, D4).
5. **Protocol:** two new pure shared modules (`world-clock.ts`, `weather.ts`), three server messages (`worldClock`,
   `weather`, `lightning`), two `WorldInfo` fields, two GM commands (`time`, `weather`), six config keys. No
   client→server message, no migration (§3).
6. **Honest ceiling.** 9A + 9B give a strong, well-lit 2015–2018-class MMO remaster. The retail geometry stays
   (Jangan buildings: median 230 triangles; nature models: median 72 [confirmed, RENDER §0]) and the textures stay
   low-density (22 px per metre median, ~90 px/m after 4× [confirmed, TEXPIPE §1.4]). True AAA also needs new
   geometry for about 30 key assets (RENDER §13), which only new prompts or concept art can produce (§8).
7. **Never cut:** the WebGPU limits fix, Low unchanged, the clock and weather state and protocol, `SkyState`, PBR
   objects and terrain with derived defaults, CSM with shadow proxies, SH + sky-cube IBL, HDR + tone map + bloom,
   rain + shelter + wet ground on both paths, the texture loader and the test-set batch.

### 0.1 Where each user request lands

| User request | Where | Lanes |
|---|---|---|
| (1) A pipeline to upscale all textures and create PBR textures | Wave 9B | TP-0 (in 9A step 0), TP-U, TP-P, TP-E, TX-R, TP-K (after approval), DT-* (optional) |
| (1) "Start with a few assets for testing, then the rest" | 9B batches B0 (14-texture test set, in-game screenshots) → B1 hero → B2 town → B3 fields → B4 actors | §7.2 |
| (1) "Tell me what you need" (Higgsfield, Meshy, etc.) | §8 | — |
| (1) "Modern AAA vs 2005" | 9A lighting/post does the most; 9B textures; geometry via Meshy is the remaining gap | §0 item 6, §8 |
| (2) Modern sky | 9A SKY-B, SKY-C | §6 |
| (2) Modern lighting | 9A RND-M, RND-T, RND-L, RND-P, NL | §6 |
| (2) Weather | 9A W9A-P (server), WX-R, WX-C, WX-A | §6 |
| (2) Ground, trees, plants show that it rains | 9A WX-R (Classic path), RND-M/RND-T/RND-W (PBR path) | D19–D23 |

---

## 1. Lane ids

| Id | Wave | From spec | What |
|---|---|---|---|
| W9A-P | 9A step 0 | SKY-A + WEATHER WX-0 + WX-S | Shared clock and weather maths, protocol, validators, server clock and weather modules, GM `time`/`weather`, mock |
| W9A-S | 9A step 0 | RENDER RND-0 + the shared-file edits of every other lane | All client seams (§4) |
| SKY-C | 9A step 0 | SKY-C | Sky asset export (moons, flares, cloud noise) |
| WX-A | 9A step 0 | WEATHER WX-A | Weather sound export |
| TP-0 | 9A step 0 | TEXPIPE TP-0 | The texture index format and inventory (early, because RND-M reads the format) |
| SKY-B | 9A step 1 | SKY-B | Atmosphere, dome, clouds, `SkyState` |
| NL | 9A step 1 | SKY-D + RENDER §4.5 | Night lights (one lane; D12) |
| WX-R | 9A step 1 | WEATHER WX-R | Weather in world-render: Classic wet look, rain, shelter, ripples, wet map |
| WX-C | 9A step 1 | WEATHER WX-C | Weather client feature and audio |
| RND-M | 9A step 1 | RENDER RND-M (+ DETAIL H3/H4/H6) | PBR objects and characters, the runtime map loader |
| RND-T | 9A step 1 | RENDER RND-T | PBR terrain |
| RND-L | 9A step 1 | RENDER RND-L (minus night lights) | Celestial light, SH, sky-cube upload, CSM and shadow proxies |
| RND-P | 9A step 1 | RENDER RND-P | Post stack, tone map, grade, height fog |
| RND-W | 9A step 2 | RENDER RND-W (minus rain occlusion) | PBR water, foliage plugin, grass HDR chunk |
| GAME | 9A step 2 | RENDER RND-G + SKY-E | Game integration, options, first-run preset, watchdog |
| LAB | 9A step 2 | RENDER RND-I | Viewer lab, bench, budgets, sign-off |
| I9A, H9A | 9A step 3 | — | Integration, adversarial hunt |
| TP-U, TP-P, TP-E | 9B step 1 | TEXPIPE | Upscale runner, PBR derivation, encode/index/review |
| TX-R | 9B step 1 | TEXPIPE §6.3–6.4 + RENDER §6.1/§12 | Runtime texture tiers (loader tiers, worker decode, precomputed mips, terrain map arrays) |
| TP-K | 9B, gated | TEXPIPE TP-K | KTX2 (after the user approves the encoder and transcoder files) |
| DT-4, DT-5, DT-2 | 9B, optional | DETAIL | Runtime detail plugin, actor subdivision, local diffusion (each gated) |
| B0–B4 | 9B | TEXPIPE §4, §7 | Batch runs (data, not code) |
| I9B, H9B | 9B | — | Integration, adversarial hunt |

Dropped ids: RENDER **RND-0** (becomes W9A-S), **RND-G** and SKY **SKY-E** (merged into GAME), SKY **SKY-D** and
RENDER's night-light part of **RND-L** (merged into NL), SKY **SKY-A** / WEATHER **WX-0**, **WX-S** (merged into
W9A-P), RENDER **RND-I** (renamed LAB).

---

## 2. Conflicts and gaps across the specs, with decisions

### 2.1 Architecture and file ownership

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| D1 | Shared shader files (`shaders.ts` terrain and water, `scatter-assets.ts` grass) | WEATHER WX-R (wet, wind, ripples, `vWorld`), SKY-D (night splat, T1/S1), SKY-B (cloud shadow), RENDER RND-W (grass N·L/SH/CSM tap/`SRO_HDR`/TAA jitter) | Up to four lanes edit one shader string; the RENDER verify flagged `scatter-assets.ts` as "one lane must own it" | **Chunk seams** [decision]. W9A-S rewrites these shaders once so each hook point interpolates a chunk constant imported from a file the lane owns: `weather/chunks.ts` (WX-R), `night-chunks.ts` (NL), `sky/chunks.ts` (SKY-B), `render/grass-chunks.ts` (RND-W). W9A-S creates all four with empty chunks. After that **no lane edits `shaders.ts` or `scatter-assets.ts`**. With every chunk empty the generated WGSL/GLSL strings equal HEAD's (snapshot test). Points and their order: §4.2. |
| D2 | `world.ts` (`World`) | RND-0 (render, ultra, quality), SKY-B (`SkySystem`, `setClock`, `setWeather`, `applyEnv` from `SkyState`), WX-R (`World.weather`, `setWeather`, `setWeatherLevel`, `applyWeatherToEnv`) | Three lanes restructure the same class and the same `applyEnv` | **W9A-S owns every `world.ts` edit** [decision]: the fields, methods and the `update()`/`applyEnv()` pipeline of §4.1, delegating to skeleton classes (`SkySystem`, `WorldWeather`, `WorldRender`) that the lanes then own. Only I9A edits `world.ts` afterwards. |
| D3 | `materials.ts`, `objects.ts`, `terrain.ts`, `stream.ts`, `scatter.ts`, `water.ts`, `ambient-fx.ts` | RND-M (PBR branch), RND-L (caster notifications), RND-T (PBR terrain), WX-R (`attachWetness`, `setWind`, layer-map alpha, wet map job, water rate), SKY-D (second emitter listener, `maxSimultaneousLights`, lamp emissive) | Several lanes per file | W9A-S adds the generic hooks of §4.1 (material decorators, region listeners, commit steps, per-region terrain textures, shared uniforms, `setAnimationSpeed`, `setAnimationRate`, `emitters()`). Then **RND-M owns `materials.ts`**, **RND-T owns `terrain.ts`, `tile-atlas.ts`, `region-chunk.ts`, `textures.ts`**, **RND-W owns `water.ts` and `scatter.ts`**, and `objects.ts`, `stream.ts`, `ambient-fx.ts` have no lane owner (only I9A). WX-R, NL and RND-L use the hooks and edit none of these files. |
| D4 | "Classic (Low) must look exactly as today" (RENDER §14) vs a modern sky and a wet Classic path on Low (SKY §9.1, WEATHER §6.0) | RENDER, SKY, WEATHER | The rule contradicts the other two specs | "Classic" is the **material path** (Low). Sky style (`graphics.sky`) and weather level (`graphics.weather`) are separate settings [decision]. The guard: Low + sky `classic` + weather `off` + frozen noon = HEAD's image and HEAD's shader strings (NullEngine test + a LAB screenshot). Default for a player on Low: sky `modern`, weather `auto` → `low`. |
| D5 | Who owns `'ultra'` | RENDER RND-0, SKY §9.1, WEATHER §10 | Three specs ask for one owner | **W9A-S**: `WorldQuality` += `'ultra'`, `QUALITY_PRESETS.ultra` = `high`'s values, `STREAM_DEFAULTS.ultra` = `high`'s, `settings.ts` `PRESETS` += `'ultra'` [decision]. |
| D6 | `settings.ts` new fields | RND-G (`ultra`, `advanced`, first-run), SKY-E (`graphics.sky`), WX-C (`graphics.weather`, `ui.reduceFlashing`), TEXPIPE (texture tier) | Four lanes edit one normaliser | **W9A-S adds every field and its normalisation** (§4.3). GAME owns `settings.ts` afterwards (first-run detection, `qualityFor`, `applyGraphics` → FSR). TX-R adds `graphics.textures` in 9B (a later wave, sequential ownership). |
| D7 | Options rows | RND-G, SKY-E, WX-C | Three lanes edit `hud/options.ts` | GAME owns `hud/options.ts` (preset row with Ultra, Advanced block, tone map, sky style). WX-C adds its two rows through `registerOptionRow('graphics' / 'interface', …)` from its own feature file [confirmed API]. |
| D8 | `screens/world.ts` | RND-G (disable hemi/sun on PBR, character decorator, `setWeather` feed), SKY-E (`applySkyToLights`), and the committed `RemasterLighting` hook | Two lanes | **GAME owns it.** The weather feed lives in WX-C's feature (it calls `ctx.world.setWeather`), not in `screens/world.ts`. |
| D9 | `apps/game/src/three/models.ts` | SKY-D (`maxSimultaneousLights ≥ 8`), WX-C (`attachWetness` on actors), RND-G (`decorateCharacterMaterials`) | Three lanes | W9A-S adds `ModelLibrary.addMaterialDecorator(fn): () => void`, run on every material of every loaded container (both `LoadAssetContainerAsync` paths). WX-C and GAME register decorators; **nobody else edits `models.ts`** in 9A. The light-count change becomes unnecessary (D12). |
| D10 | `engine.ts` (game and viewer) | RENDER §3.5 (limits, required), TEXPIPE TP-K (`texture-compression-bc`), SKY §9.2 (`timestamp-query`) | Lead-owned file, three asks | **W9A-S** writes both engines once: `setMaximumLimits: true` (copies every adapter limit; `maxInterStageShaderVariables` is the one that matters, 16 → 28 on the dev GPU) and `deviceDescriptor.requiredFeatures` = the adapter's features ∩ `['texture-compression-bc', 'timestamp-query']` (found with one `navigator.gpu.requestAdapter()` before the engine) [confirmed APIs, RENDER §3.5; the pre-query is [likely]]. `EngineResult` gains `gpu: { maxInterStageShaderVariables, maxSampledTexturesPerShaderStage, features, vendor, architecture, isFallbackAdapter }`. Debug `?gpuLimits=default` skips `setMaximumLimits`, so the 16-varying fallback can be tested on the dev PC. |
| D11 | i18n files | RND-G, SKY-E, WX-C | Shared `en.ts` | W9A-S creates empty `i18n/en-render.ts` (GAME), `en-sky.ts` (GAME), `en-weather.ts` (WX-C) and their spread lines in `en.ts`. |

### 2.2 State ownership (one source of truth each)

| State | Produced by | Carried by | Consumed by | Owner lane |
|---|---|---|---|---|
| Time of day (days, t, season, night speed-up) | server `apps/server/src/world-clock.ts` | `WorldInfo.clock`, `worldClock` | `features/sky-clock.ts` → `World.setClock` → `SkySystem` | W9A-P (server, maths), GAME (feature), SKY-B (derivation) |
| Sun/moon direction | `packages/shared/src/world-clock.ts` `sunDirection`, `moonState` | `SkyState.sunDir/moonDir/keyLight` | everything that lights | W9A-P (maths), SKY-B (state). **No second sun model** (RENDER §4.1). |
| `SkyState` (key light, ambient, SH, fog colour, horizon ring, exposure, night, cloud shadow, env palette) | `sky/sky-system.ts` | `World.skyState`, `World.onSky` | RND-L, RND-P, RND-T, RND-M, NL, WX-R (sky reflection colours), GAME (character lights on Low) | SKY-B |
| Weather state (kind, transition, wind, wet, puddle, seed) | server `apps/server/src/weather.ts` | `WorldInfo.weather`, `weather`, `lightning` | `features/weather.ts` | W9A-P (server, maths), WX-C (feature) |
| `WeatherFrame` (blended, zone-modulated, gusts, flash) | `features/weather.ts` | `World.setWeather(frame)` (the **one** public entry, D13) | `SkySystem.setWeather(toSkyWeather(f))`, `WorldRender.setWeather(toRenderWeather(f))`, `WorldWeather` (Classic `wx*`) | WX-C (producer), W9A-S (adapters, pure) |
| Wet/dry and puddle rates | `stepSurface` in `packages/shared/src/weather.ts` | `WeatherSync.wet/puddle/at` | both paths | W9A-P. RENDER §9.1's "~60 s / ~300 s / ~180 s" comments are void; WEATHER §6.1's corrected numbers hold (soak 0.9 in ~92 s at storm; dry in ~9–13.5 min; puddles 4–11 min). |
| Fog **colour** | `SkyState.fogColor` / `horizonRing` (modern sky) or the retail FogColor (classic sky) | `World.applyEnv` | all fog | SKY-B |
| Fog **distance** (visibility) | `fogScale(f) = mix(1, 0.35, fog) × mix(1, 0.75, rain)` | `RenderWeather.fogMul = 1 / fogScale`, Classic fog end/start | all fog | WX-R (`weather/env.ts`) |
| Fog **model** | linear on the Classic path; exponential height fog (`SroFogPlugin`) on PBR | — | — | RND-P |
| Exposure | `SkyState.exposure` (target and easing) | `WorldRender` | post (PBR presets); the sky shader itself on Low (sky `outputMode` 0) | SKY-B produces, RND-P applies with a per-preset trim |
| Tone mapping, LUT grade, bloom, AA, SSAO, SSR | `render/post.ts`, `render/grade.ts` | — | — | RND-P |
| Wetness **uniforms** | `WorldWeather.u` (`wxA..wxE`, `wxCam`, `wxOcc`, Classic path and rain meshes) and the PBR plugins' `sroWeather` UBO vec4 (rain, wet, puddle, wind), both written from the same frame each frame | — | Classic shaders, `WetnessPlugin`; PBR plugins | WX-R (`wx*`), RND-M/RND-T (plugin UBO) |
| Shelter (rain occlusion) map, ripple texture | `weather/shelter.ts`, `weather/ripples.ts` | `world.weather.shelter`, `world.weather.rippleTexture` | rain, splashes, both wet paths, PBR water | WX-R (D20, D21) |
| Quality presets | `render/quality.ts` `RENDER_PRESETS` (the §5.1 table as data), `sky/types.ts` `SKY_PRESETS`, `weather/presets.ts` `WEATHER_PRESETS` | `QualitySettings.render` / `.sky`, `World.setWeatherLevel` | all | W9A-S writes the three tables from §5.1; later changes only via I9A |
| Texture tier | `QualitySettings.render.textures` | — | `pbr/maps.ts`, `tile-atlas.ts` | TX-R (9B) |

### 2.3 Rendering conflicts

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| D12 | Night lights | SKY-D (`night-lights.ts`: table, splat, pool of 4 on Medium, cluster ≤ 64/128; `maxSimultaneousLights` 6 objects / ≥ 8 characters) vs RENDER §4.5 (`render/night-lights.ts`: cluster 8/16/32, pool of 4 fallback) | Two modules, different counts; SKY's own iGPU budget is broken by the pool of 4 (0.6–1.1 ms vs 0.5 ms), and the pool is paid by day | **One lane NL, one module** `packages/world-render/src/night-lights.ts` [decision]. Per preset: **Low** = terrain + grass light splat + lamp emissive, **no point lights** (so Classic object and character light counts stay as today). **Medium** = splat on terrain and grass + `ClusteredLightContainer` of the 8 nearest when `isSupported`, else a pool of **2** `PointLight`s. **High** = cluster 32 (splat on grass only). **Ultra** = cluster 64 (the WebGPU batch is 32, so 2 batches) [decision; cut to 16/32 if LAB measures the tile-mask pass over budget]. On PBR presets materials carry celestial + cluster = **2 lights**, fixed for the session (RENDER §4.6); with the pool fallback 3. Characters on PBR presets lose the game hemi + sun (RENDER §4.1) and the `HitLights` join the cluster, so no `maxSimultaneousLights` change is needed except `6` on character materials when the pool fallback runs (celestial + 2 pool + 2 hit lights), set by GAME's decorator. The light table is SKY §7.2; `night = smoothstep(+2°, −6°, sunEl)` (SKY) replaces RENDER's `smoothstep(0.30, 0.22, …)`. |
| D13 | `World.setWeather` | SKY W1 (`SkyWeather`), RENDER §9.1 (`RenderWeather`), WEATHER §5.3 (`WeatherFrame`) | Three signatures for one name | **`World.setWeather(frame: WeatherFrame)`** is public [decision]; `SkySystem.setWeather(SkyWeather)` and `WorldRender.setWeather(RenderWeather)` are subsystem setters called through `toSkyWeather` / `toRenderWeather` (WEATHER §5.3, in `weather/adapters.ts`, written by W9A-S). `RenderWeather` gains `flash: number` (0..1, D25). The sky skips its own 1/20-per-second smoothing for weather fields (the frame is already blended). |
| D14 | Sky reflection cube | RENDER §4.2 (`SkyEnvironment` in `render/lighting.ts`: one 64² half-float `RawCubeTexture` updated in place, one face per frame, CPU mips/blur, refresh on 0.5° sun move) vs SKY §6.3 (`sky/ibl.ts`: 32²/64² cube + `HDRFiltering.prefilter`, which allocates a new RT cube per call and swaps it in) | Two owners, two filters | **SKY-B produces the data, RND-L owns the texture** [decision]. `sky/ibl.ts` exports pure `fillSkyCube(state, size): Float32Array[]` (6 faces, linear HDR, clouds as coverage-weighted colour) and `skySH(state)` (L1, 4 × RGB). RND-L's `SkyEnvironment` owns one `RawCubeTexture(…, TEXTUREFORMAT_RGBA, TEXTURETYPE_HALF_FLOAT, mips)` assigned to `scene.environmentTexture` **once**, `ToHalfFloat` packing per face, one face per frame, lower mips blurred on the CPU (RENDER). Size: 32² on Medium, 64² on High/Ultra. Refresh: sun moved > 0.5° or weather changed > 0.05, rate-limited to one refresh per 5 s (High) / 2 s (Ultra) / 10 s (Medium), plus after a `time` jump. `HDRFiltering.prefilter` is LAB's A/B alternative only if the CPU-blurred roughness mips look wrong. The diffuse part is `sphericalPolynomial = SphericalPolynomial.FromHarmonics(sh)` with the L1 SH zero-padded to L2 (RENDER verify). **No `ReflectionProbe`** anywhere on PBR presets (~570 ms per refresh with 2,030 PBR materials [confirmed, RENDER §11.2]). |
| D15 | `RemasterLighting` (committed, `remaster.ts`, probe every 30 s) | RENDER §3.2/§16 | Once world materials are PBR each capture costs ~0.5 s | GAME does not construct `RemasterLighting` when `world.render.mode === 'pbr'`; the environment and key light come from `WorldRender`. On Low the committed test switch keeps today's behaviour until 9B replaces it with the texture tier (TX-R). |
| D16 | Baked shadows vs a moving sun | RENDER §3.4 (`bakedWeight = saturate(dot(sunDir, n(1,1,0)) × 2 − 0.6)`, 0 from t ≈ 0.625: every afternoon loses distant baked shadows) vs SKY §6.2 (`lm' = mix(1, lm, 0.35)` always) | Two rules; RENDER's is asymmetric | **One rule** [decision]: beyond the CSM range `bakedVis' = mix(1, bakedVis, max(0.35, bakedWeight))`. Distant terrain always keeps a soft 35% contact darkening under buildings and trees, and full-strength baked shadows only when the sun is near the bake direction; inside the CSM range `sunVis = mix(bakedVis', 1, csmFade)` (RENDER). `sunPath`: Low `'baked'` (key light fixed at the bake direction, colour and intensity follow the time), Medium+ `'dynamic'` (elevation clamped ≥ 6°). RND-L first **measures the real bake direction** (SKY open question: footprint-vs-darkness offset, TERRAIN.md §3.1 method) and replaces `(1, 1, 0)` in `BAKED_LIGHT_DIR` if it differs. LAB reviews t = 0.3, 0.5, 0.6, 0.7. |
| D17 | Sky shader output and double tone mapping | SKY §3 (`outputMode` 0 applies ACES in the sky shader), RENDER §5.2 | On PBR presets the sky would be tone-mapped twice | Sky `outputMode` = 1 (linear HDR, no tone map) whenever `world.render.mode === 'pbr'`, 0 on Low. SKY-B implements both; `WorldRender` sets it. |
| D18 | Directional fog on PBR | SKY §6.3 (no `CUSTOM_FRAGMENT_BEFORE_FOG` in `pbr.fragment`), RENDER §5.5 (height fog "at `CUSTOM_FRAGMENT_BEFORE_FOG`") | RENDER's hook does not exist in the PBR fragment | `SroFogPlugin` computes the height fog at `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR` on `finalColor` and the scene fog is disabled for PBR materials (`fogEnabled = false`), so there is one fog term [decision; [likely], RND-P verifies in the first compile]. That point comes **after** `#include<pbrBlockImageProcessing>` in `pbr.fragment` [confirmed, WGSL l.624–626], so it is only correct because every PBR preset applies image processing in post (`imageProcessingConfiguration.applyByPostProcess = true`, set by RND-P); a test asserts that flag on every PBR preset. The alternative point is `CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION` on `finalDiffuse`/`finalSpecular` terms. Its colour takes `horizonRing` on High+, `fogColor` otherwise. WEATHER's extra swamp/lake height-fog term on the Classic path is **not built** (Classic fog stays linear; the zone `fogAdd` still enters `fogScale`). |
| D19 | Wet response, per path | WEATHER §6.0 (Classic), RENDER §9.2 (PBR) | Risk of double darkening | WEATHER's table §6.0 holds. `attachWetness` (WX-R) is registered as a material decorator that **skips** any material carrying `SroSurfacePlugin`/`SroTerrainPlugin` (checked by plugin name). One wet parameter table (porosity, wet roughness, puddle eligibility) per class lives in `pbr/classes.ts` (W9A-S creates it from RENDER §3.3 + WEATHER §6.2, D27). |
| D20 | Shelter / rain occlusion map | RENDER §9.4 (depth map, objects and trees, 16 m refresh, `exposure = saturate((sceneY − occY + 0.3)/0.3)`, `render/rain-occlusion.ts`, RND-W) vs WEATHER §6.5 (relative height incl. terrain, 8 m refresh, `shelter = 1 − smoothstep(0.25, 1, top − y)`, `weather/shelter.ts`) | Two encodings, two owners | **One map, WX-R owns `weather/shelter.ts`** [decision]: 512² over 128 m (25 cm texels), `R16F` height **relative to the map centre**, terrain included (splashes land on the ground), refresh after 8 m, on a region/objects commit inside the square, and every 2 s while it rains; not rendered at all when `rain = 0` and `wet = 0`. RGBA8 fallback packs 16 bits in R+G. Exposed as `world.weather.shelter` with a WGSL/GLSL `sroShelter(worldPos)` function in `weather/chunks.ts` that every consumer (rain, Classic wet, PBR plugins) calls. RENDER's `exposure` formula and `render/rain-occlusion.ts` are dropped; `world.render.rainOcclusion` is an alias getter. The render list is pre-filtered to the 128 m square (the object renderer does no frustum test on an explicit list [confirmed, RENDER §4.3]). |
| D21 | Ripples | RENDER §9.3 (256² 16-frame atlas from `make-render-textures.ts`) vs WEATHER §6.6 (one CPU-generated time-offset texture, measured) | Two textures | **WEATHER's texture** (`weather/ripples.ts`, 128²/256², built when the weather level is set, never lazily on first rain) [decision]. `world.weather.rippleTexture` feeds the Classic terrain, the PBR terrain/surface plugins and both waters. RND-P's generator does not make ripples. |
| D22 | Puddle mask | RENDER §9.3 (texture height + noise, `N.y > 0.95`) vs WEATHER §6.2 (per-region 97² wet map: basin × flatness × class) | Two masks | **The wet map is the base on both paths** (measured: 2.5% of vertices ≥ 0.5, 25.7% ≥ 0.2) [decision]; on the PBR path it is modulated by the ORMH height (`A`) when a texture set has one (9B), else by RENDER's noise. The wet map is built by WX-R as **its own commit step** after the terrain step and bound per region through `TerrainRenderer.setRegionTexture(region, 'wetMap', tex)` (§4.1). The surface class sits in the layer map's alpha (`128 + class`, WEATHER §6.2), written by W9A-S's `terrain.ts` edit so both terrain paths read it. Puddles on `ground_grass` keep WEATHER's weight 0.35 (TEXPIPE's open question). |
| D23 | Grass shader | RND-W (N·L, L1 SH as 4 vec3, one CSM tap per plant, translucency, `SRO_HDR`, TAA jitter), WX-R (wind direction/strength, gust wave, droop, wet darkening + sheen), NL (splat), SKY-B (cloud shadow) | Four editors | D1 chunk points in `scatter-assets.ts` (§4.2). Wind maths: WX-R's `weather/chunks.ts` exports the sway function; RND-W's `SroFoliagePlugin` imports the **same** function so grass, Classic trees and PBR trees sway alike (WEATHER verify conflict). Wind strength on PBR = `RenderWeather.wind = min(2, gustMs / 8)`. |
| D24 | Water | WX-R (Classic ripples, sky reflection, animation rate), RND-W (PBR water, `SroWaterPlugin`, depth shore) | Two lanes on `water.ts` | W9A-S adds `WaterRenderer.setAnimationRate(r)` and a chunk point in the Classic water fragment; **RND-W owns `water.ts`** (the PBR branch); WX-R edits only its chunk and calls `setAnimationRate`. |
| D25 | Lightning flash | SKY (flash in the sky), WEATHER (Classic env boost, a PBR-plugin ambient boost on Classic characters), RENDER (nothing) | No PBR owner | `RenderWeather.flash` (0..1) [decision]: RND-L adds `flash × 2` to `scene.environmentIntensity` and a short fill on the celestial light for the flash curve; the sky draws its own flash; the Classic path keeps WEATHER §7.1. `ui.reduceFlashing` scales `flash` in WX-C before it reaches any subsystem. |
| D26 | Grading under weather | RENDER §5.2 (12 LUT keys: dawn/day/dusk/night × clear/overcast/rain), WEATHER §7.4 (desaturation) | — | RND-P's `GradeMixer` takes the weather weights `clear = 1 − cloud`, `overcast = cloud × (1 − rain)`, `rain = rain` (WEATHER §5.3). White balance stays 6,500 K or off (RENDER verify: `temperature` is the illuminant to neutralise). The Classic path uses WEATHER's env multipliers only. |
| D27 | Class tables | RENDER §3.3 (11 material classes: porosity, wet roughness, translucency), WEATHER §6.2 (6 terrain surface classes), WEATHER §6.4 (foliage model regex `tree\d*`) | Three tables | W9A-S creates `packages/world-render/src/pbr/classes.ts` with RENDER's table, the terrain class mapping (grass → `ground_grass`, dirt/mud → `ground_soil`, sand → `ground_soil` with porosity 0.9 override, stone → `stone`, water → `water`, generic → `default`), WEATHER's porosity/gloss/puddle numbers for the Classic terrain, and `isFoliageModel(source)` with the corrected regex. RND-M owns the file afterwards (classification rules, overrides file `content/render/material-overrides.json`). TP-0 imports `classify` from it. |
| D28 | Cloud shadows on PBR surfaces | SKY §5.5 (terrain, grass, objects on Ultra) | SKY only spells the Classic terrain hook | `sky/chunks.ts` exports `sroCloudShadow(worldXZ)` (WGSL + GLSL). RND-T and RND-M call it inside their `CUSTOM_LIGHT0_COLOR` code under a define (`SRO_CLOUDSHADOW`) on High (terrain) and Ultra (objects). |
| D29 | Night splat on PBR terrain | SKY §7.3 (splat for custom shaders), RENDER (cluster lights everything PBR) | Double lighting on High+ | Splat on terrain: Low and Medium only; on High+ the cluster lights PBR terrain. Grass always uses the splat (it is a `ShaderMaterial`). `night-chunks.ts` exports the terrain and grass chunks and a plugin-side function RND-T calls under `SRO_NIGHT_SPLAT`. |
| D30 | TAA and the grass | RENDER §5.6 (TAA default `disableOnCameraMove = true`; `ShaderMaterial`s are not jittered) | — | RND-P: `disableOnCameraMove = false`, `reprojectHistory = true`, `clampHistory = true` on High/Ultra, cost measured by LAB; if over budget, High falls back to MSAA ×4 on the HDR target (+0.23 ms measured). RND-P exposes the jitter as `world.render.taaJitter` (Vector2); RND-W's grass chunk applies `position.xy += taaJitter × position.w`. |
| D31 | SSR mask | RENDER §5.4 (verify: dry dielectrics are skipped by default; the mask must *include* wet surfaces by raising `specularEnvironmentR0`/`microSurface` at `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR`) | Marching cost [unknown] | RND-M/RND-T raise reflectivity on puddles, wet flat ground, polished marble and metal only; RND-P owns the pipeline; SSR is on for Ultra and for High while `puddles > 0.1`. Budget ≤ 1.5 ms GPU on the dev GPU in rain [unknown until measured]; first in the scope-cut list for High. |
| D32 | WebGL2 sampler budget | RENDER §3.5 (High terrain ≈ 14–15 of 16 with cluster + occlusion) + wet map + ripples | Could reach 16+ | RND-T asserts ≤ 16 samplers per final define set on WebGL2 in a NullEngine test. If over: the wet map's R channel moves into the terrain lightmap texture's A channel (both per region) [our rule], and the night splat is off on High (D29 already). On WebGPU `setMaximumLimits` lifts `maxSampledTexturesPerShaderStage`. |
| D33 | Moon texture | SKY verify: moon16 is full, not moon15 | — | `moonState` uses `min(30, floor(a / 29.53 × 30) + 1)`; W9A-P's test says full moon = 16. |
| D34 | Star alpha | SKY verify: `saturate(G15)` (TERRAIN.md §5.3), not `(G15+1)/2` | — | SKY-B follows TERRAIN.md. |

### 2.4 Texture, manifest and preset conflicts

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| D35 | Runtime manifest | RENDER §3.2 (extended `sro-remaster`, keys `<glb>#<image>` and `world/<w>/tile2d/<stem>`, `<map>@<size>.<ext>` files) vs TEXPIPE §6.2 (`pbr/index.json`, `sro-pbr`, keys = normalised retail path and `tile2d:<id>`, per-tier files and v1 planes) | Two formats, two key schemes | **`pbr/index.json` (`sro-pbr` v1) is the build output and the main runtime index** [decision]: glTF image names collide inside glbs, the retail path is unique and shared across glbs [confirmed, TEXPIPE §0.7], and the tiers/planes are needed by the v1 WebP format. **`sro-remaster` stays** for hand-made and Meshy sets (the committed REMASTER lane writes it). `pbr/maps.ts` (RND-M) reads both into one runtime record; precedence: an `sro-remaster` entry for that glb image > a `sro-pbr` set for its retail path > class defaults. The glb-image → retail-path join goes through `SidecarMaterialLite.texture` (W9A-S adds the field; `keyOf` lower-cases and turns `\` into `/`). TEXPIPE's option (b) (`remaster/manifest.json` view) is **not built**. |
| D36 | Terrain tile key | RENDER `world/<w>/tile2d/<stem>`, TEXPIPE `tile2d:<id>` | Tile ids may differ between exports (`jangan` vs `jangan-fields`) | **`tile2d:<stem>`** with `stem` = the lower-case retail tile file stem [decision]. TP-0's test asserts the 104 stems are unique; if not, the key falls back to the full normalised retail tile path. |
| D37 | Map packing | RENDER §6.1 terrain `rmh` (R rough, G AO, B height) and glTF ORM for objects vs TEXPIPE ORMH (R AO, G rough, B metal, A height) | Two packings | **ORMH everywhere** [decision]: objects and actors bind it as Babylon's metallic texture (AO from R, roughness from G, metal from B: `useAmbientOcclusionFromMetallicTextureRed`, `useRoughnessFromMetallicTextureGreen`, `useMetallnessFromMetallicTextureBlue`) and read height from A in the plugin; the terrain arrays are `albedo`, `normal` (RGBA8, RG used; BC7 with KTX2) and `ormh`. |
| D38 | Normal maps with KTX2 | RENDER §12 (BC5/BC1), TEXPIPE verify (no RGTC/BC5 route in 9.28; the KTX2 decoder has no BC5 target) | RENDER's compressed numbers are optimistic | Normals ship UASTC → **BC7** (same 1 B/texel as BC5); ORMH BC7. RENDER §12's table is read with BC7 for every map. |
| D39 | Presets and texture caps | RENDER §10/§3.2 (Medium maps ≤ 1024, High ≤ 2048, Ultra full; §12: without KTX2 High ≈ 250 MB with ~60 heroes, **wrong** per its verify) vs TEXPIPE §6.4 (Medium retail-size remaster + hero maps; High 2×/1024 + hero maps + terrain maps; Ultra 4×/2048 KTX2 only) | Two tables | **TEXPIPE §6.4's table** [decision] with these caps: High on WebP v1: world albedo ≤ 1024, maps at half size for the hero set only, terrain albedo 1024 in an array capped at **48 layers** with a 512 overflow array (TEXPIPE §6.5), terrain normal/ORMH at 512. Ultra only with KTX2 (else Ultra uses High's textures). Map arrays are **allocated only when a set provides that map**, so 9A (no sets) allocates no normal/ORMH arrays and costs no extra VRAM. |
| D40 | When 9A has no texture sets | RENDER §3.3 derived defaults | — | 9A ships with an **absent** `pbr/index.json`: every material takes class defaults (luminance-modulated roughness, AO from the object lightmap share, no normal map, metallic 0 except `metal`). The loader treats a missing index as "no sets" without a console error. |
| D41 | Medium download | TEXPIPE verify: the remastered albedo is **extra** wire (retail albedo stays embedded in the glbs) | — | 9B's first batches target High only; whether Medium ships the retail-size remaster (+15–25 MB on first entry) is a user call (§8). The loader disposes the embedded retail texture after a swap (+88 MB VRAM in town otherwise). |
| D42 | Mip generation for big terrain layers | TEXPIPE verify (WebGPU arrays build mips on the main thread: 0.6/2.4/9.2 ms at 512/1024/2048 per layer per map [confirmed]) | A 2048 layer is a hitch on its own | TX-R (9B): mips come precomputed from the decode worker; `uploadTextureLayer` (`textures.ts`) gains a `levels?: Uint8Array[]` parameter. Not needed in 9A (512 retail layers, today's path). |
| D43 | Meshy and Higgsfield | TEXPIPE first draft vs the decision note's "Update: Meshy approved" | Settled by the verify | Meshy Retexture: **only** the approved test parts, 150-credit cap (REMASTER.md). Terrain and buildings: local only. Higgsfield: prompts only, never a retail file (the connector's `upscale_image` must never get a retail texture). New Meshy geometry: prompts or the user's own concept art only (§8). |
| D44 | Sky textures in the texture pipeline | SKY asks TEXPIPE to upscale moons and `cloud1` ×2; TEXPIPE excluded sky | Unassigned | Optional batch **B-sky** in 9B (TP-U runs it on `work/out/sky/moon/*.png`, lens and `cloud1`); `cloud-noise.png` is data and is **never** upscaled or lossy-encoded (SKY §5.2). |

### 2.5 Numbers and config (consolidated)

| What | Value | Where it lives | Source |
|---|---|---|---|
| Game day length | 120 real min (`DAY_LENGTH_MIN`, 1..1440) | server config | SKY §2 |
| Night speed-up k | 0.4 (`DAY_NIGHT_SPEEDUP`, 0..0.6): sun below the horizon 41 of 120 min, ~37 min fully dark | server config | SKY §2.3 [confirmed by computation] |
| Season (declination) | +12° (`DAY_SEASON_DEG`, −23.44..23.44); latitude 34.3° N | server config, `JANGAN_LATITUDE` | SKY §2.1 |
| Clock epoch | `Date.UTC(2026, 0, 1)`, `anchorDays = 0.3`; GM state in `<DATA_DIR>/world-clock.json` (atomic write) | server | SKY §2.2 |
| Moon | synodic 29.53 game days; moon16 = full; hidden within 0.75 day of new | shared | SKY §2.1 (verified) |
| Weather schedule | Markov table WEATHER §2.3; measured shares clear 33 %, cloudy 31 %, overcast 22 %, rain 10 %, storm 1 %, fog 3 %; `WEATHER` = `auto`, `WEATHER_SEED` = 1, `WEATHER_RAIN_SCALE` = 1 (0..3); epoch 2026-01-01T00:00Z | server config | WEATHER §2.3 |
| Transitions | 120 s default, 60 s into storm, 180 s into/out of fog; rain lags clouds (`smoothstep(0.55, 1, k)`) | shared | WEATHER §2.2 |
| Lightning | Poisson at the blended rate, ≥ 4 s apart, `distM` 300..3000 (GM 100..3000), thunder `distM / 343` s later; rain rate × intensity, 0 below 0.8 | server | WEATHER §2.4 |
| Wet/dry | `stepSurface` (WEATHER §6.1, corrected): soak to 0.9 in ~92 s at storm; dry ~9 min (clear, cloudy), ~13.5 min (overcast); puddles gone ~12–19 min after rain; puddle ≤ wet + 0.1 | shared | WEATHER §6.1 (verified) |
| Fog distance | `fogScale = mix(1, 0.35, fog) × mix(1, 0.75, rain)`; Jangan noon: clear 250 m, storm ≈ 130 m, fog ≈ 110 m, swamp fog ≈ 85 m | `weather/env.ts` | WEATHER §7.1 |
| Shelter map | 512², 128 m, R16F relative height, refresh 8 m / commit / 2 s in rain | `weather/shelter.ts` | D20 |
| Ripple texture | 128² 60 drops (Low/Medium), 256² 200 drops (High/Ultra); built on level change | `weather/ripples.ts` | WEATHER §6.6 |
| Retail bake direction | light from (1, 1, 0) until RND-L measures it | `sky/types.ts` `BAKED_LIGHT_DIR` | D16 |
| Lightmap floors | terrain `(lm − 0.61)/0.39`; objects `(lm − 0.55)/0.4` [unknown, calibrate on the gate] | `SroTerrainPlugin`, `SroSurfacePlugin` | RENDER §3.4 |
| Sun : ambient ratio | clear noon ≈ 5 : 1 on a horizontal surface, overcast 1.5 : 1, rain 1 : 1 | RND-L calibration | RENDER §4.1 |
| Exposure | `key / luminance(sky irradiance + keyLight × 0.3)`, clamped [2, 160], noon → 8, eased 1/1.5 s | SKY-B | SKY §6.5 |
| Night readability | ≥ 12 % of noon luminance on characters; a mob visible at 30 m at midnight | SKY-B, NL | SKY §7.3 |
| Light budget per material (PBR) | celestial + cluster = 2 (3 with the pool fallback), fixed per session | RND-L, NL | RENDER §4.6, D12 |
| Frame-time watchdog | drop one preset when p95 > 33 ms over 10 s, and say so in chat | GAME | RENDER §10 |

---

## 3. Unified protocol additions (protocol v1, additive; landed by W9A-P)

### 3.1 New shared modules (pure, environment-neutral, unit-tested)

`packages/shared/src/world-clock.ts` (SKY §2.2):

```ts
export interface WorldClockState {
  anchorMs: number      // int >= 0, server epoch ms at which days == anchorDays
  anchorDays: number    // 0 .. 1e6
  dayMs: number         // int, 60_000 .. 86_400_000
  running: boolean
  nightSpeedup: number  // k, 0 .. 0.6
  declination: number   // degrees, -23.44 .. 23.44
}
export const JANGAN_LATITUDE = 34.3
export const DEFAULT_CLOCK: Omit<WorldClockState, 'anchorMs' | 'anchorDays'>   // 120 min, running, 0.4, 12
export function clockDays(c: WorldClockState, serverNowMs: number): number
export function solarTime(phase: number, k: number): number   // t = p − k/2π · sin(2π(p − 0.5)); monotonic for k < 1
export function phaseForSolarTime(t: number, k: number): number // bisection (GM `time hh:mm`)
export function sunDirection(t: number, declDeg: number, latDeg?: number): [number, number, number] // glTF, to the sun
export function moonState(days: number): { age: number; illum: number; texture: number; hourOffset: number } // full = 16
export function sunriseSunset(declDeg: number, latDeg?: number): { rise: number; set: number }
export function formatClock(t: number, day: number): string   // "Day 12, 05:27"
```

`packages/shared/src/weather.ts` (WEATHER §2, §6.1):

```ts
export const WEATHER_KINDS = ['clear', 'cloudy', 'overcast', 'rain', 'storm', 'fog'] as const
export type WeatherKind = (typeof WEATHER_KINDS)[number]
export interface WeatherParams { cloud; cloudDark; cirrus; rain; windMs; gust; fog; sun; desat; lightning }  // numbers
export const WEATHER_PARAMS: Readonly<Record<WeatherKind, WeatherParams>>      // WEATHER §2.1 table
export function blendWeather(sync: WeatherSync, nowMs: number, current?: WeatherParams): WeatherParams
export function scheduleAt(seed: number, tMs: number, opts?: { rainScale?: number; dayFraction?: number }): WeatherSegment
export const ZONE_CLIMATE: Readonly<Record<string, { rainMul; fogAdd; windMul; wetFloor }>>
export function stepSurface(s: { wet: number; puddle: number }, p: WeatherParams, dtS: number): { wet: number; puddle: number }
export function flashAt(strike: { at: number }, nowMs: number): number
export function fogScale(p: Pick<WeatherParams, 'fog' | 'rain'>): number
export function mulberry32(seed: number): () => number
```

### 3.2 `protocol.ts` additions

```ts
// re-exported types
export type { WorldClockState } from './world-clock.ts'
export type { WeatherKind } from './weather.ts'

export interface WeatherSync {
  start: number; dur: number                 // server ms; dur 0..600_000
  from: WeatherKind; to: WeatherKind
  intensity: number                          // 0.4..1 (rain only; 1 otherwise)
  until: number                              // hint
  windDir: number; windMs: number            // radians toward (glTF XZ, 0 = +X east); 0..30 m/s
  wet: number; puddle: number; at: number    // 0..1 at server ms `at`
  seed: number                               // u32
  gm?: true
}

export interface WorldInfo {
  // … existing fields …
  /** Wave 9: the world clock anchor (docs/SKY.md §2.2); absent = the client runs a local clock from noon. */
  clock?: WorldClockState
  /** Wave 9: the current weather for late joiners (docs/WEATHER.md §4.1); absent = clear. */
  weather?: WeatherSync
}

// ServerMessage additions
| { t: 'worldClock'; clock: WorldClockState }
| { t: 'weather'; weather: WeatherSync }
| { t: 'lightning'; at: number; distM: number; bearing: number }   // distM 100..3000, bearing 0..2π
```

### 3.3 When each message is sent

| Message | Sent to | When |
|---|---|---|
| `worldEnter.world.clock` | the entering player | every enter |
| `worldClock` | sockets **with `conn.player`** (not lobby sockets: the `notice` loop at `gm.ts` sends to every socket, SKY verify) | a GM `time` change or a config reload; never periodically (clients extrapolate from the anchor with the existing `ServerClock`) |
| `worldEnter.world.weather` | the entering player | every enter |
| `weather` | every player in the world (`world.broadcast`) | each state change (schedule or GM), a GM `wind`/`wet` override, and a resync every 10 min (~200 bytes) |
| `lightning` | every player in the world | each strike |

Client → server: **nothing new**. GM commands use the existing GM path; no rate-limit change.

### 3.4 Validators (`validate.ts`)

- `worldClock` and `WorldInfo.clock`: the ranges of §3.1. **A bad `clock` inside `worldInfo` must not reject the
  whole `worldEnter`**: the house pattern (`worldInfo()`) rejects the whole message on a bad optional field, so the
  clock (and the weather) sub-parse is wrapped in a try/catch that drops only that field with a console warning
  [decision, SKY verify]. A malformed `worldClock` or `weather` message is rejected and the old state is kept.
- `weather` / `WorldInfo.weather`: `from`/`to` in `WEATHER_KINDS`; finite numbers in range; `seed` integer
  0..2³²−1.
- `lightning`: `distM` 100..3000, `bearing` 0..2π, `at` finite.

### 3.5 GM commands (`gm.ts` `COMMANDS` entries, role `gm`, audited)

| Command | Effect | `gmResult.data` |
|---|---|---|
| `time` | "Day 12, 14:32, 1 day = 120 min, running, night ×0.4, season +12°" | `{ clock, t, day }` |
| `time <hh:mm>` / `time day <n>` / `time length <min>` / `time freeze` / `time resume` / `time night <0..0.6>` / `time season <deg>` / `time reset` | SKY §2.2 (length and freeze re-anchor at now, so t never jumps; reset deletes the JSON) | same |
| `weather` | status: state, blend, next change, wet, puddle, wind | `WeatherSync` |
| `weather <state[:intensity]> [minutes] [transitionS]` / `weather auto` / `weather wind <m/s> [deg]` / `weather wet <0..1> [puddle]` / `weather strike [distM]` | WEATHER §3 | `WeatherSync` |

Both names match `GM_COMMAND /^[a-z]{1,16}$/`; neither collides with a chat prefix (`ChatBox.registerPrefix` users:
`/sitdown`, emotes, `/dismount`, `/trade`, `/stall`, `/guild`, …) [confirmed names free].

### 3.6 Server config (`apps/server/src/config.ts`, all optional)

`DAY_LENGTH_MIN` (120), `DAY_NIGHT_SPEEDUP` (0.4), `DAY_SEASON_DEG` (12), `WEATHER` (`auto`), `WEATHER_SEED` (1),
`WEATHER_RAIN_SCALE` (1). No database migration: clock holds persist to `<DATA_DIR>/world-clock.json`; weather holds
are in memory (the schedule is deterministic).

### 3.7 Collision check [confirmed against `protocol.ts` and `gm.ts` at `92072dc`]

No existing `ServerMessage` `t` equals `worldClock`, `weather` or `lightning`; `WorldInfo` has no `clock` or
`weather`; no GM command is named `time` or `weather`. The server and client deploy together (PROTOCOL.md), so the new
message types are safe; the client still tolerates their absence (an older server sends neither field).

---

## 4. Seams (W9A-S; one agent; every edit is additive and keeps Low + classic sky + weather off identical)

### 4.1 `packages/world-render`

| File | Edit |
|---|---|
| `world.ts` | `WorldQuality` += `'ultra'`; `QUALITY_PRESETS.ultra` = `high`'s; `QualitySettings.render?: RenderQuality`, `.sky?: SkyQuality`; `LoadWorldOptions.render?: 'classic' \| 'pbr'` (default `'classic'`), `.sky?: 'modern' \| 'classic'` (default `'classic'`), `.weatherLevel?`. Fields: `render: WorldRender`, `sky: SkySystem` (keeps a **`mesh` getter**: `apps/viewer/src/world/main.ts` and `apps/game/test/worldmap.test.ts` use `world.sky.mesh`, and `World.meshes()` lists it [confirmed, SKY verify]), `weather: WorldWeather`. Methods: `setClock(clock \| null, serverNow: () => number)`, `setTimeOfDay(t)` (kept; freezes the local clock), `setWeather(frame: WeatherFrame)` (calls the two adapters), `setWeatherLevel(level)`, `setSkyStyle(style)`, `setRenderMode(mode)` (rebuild; §3.1 of RENDER), `get skyState()`, `onSky: Observable<SkyState>`. **`update()` order:** clock → `sky.update(dt, camera)` → `applyEnv()` → `weather.update(dt, camera)` → `render.update(camera, skyState)`. **`applyEnv()`** becomes: `env = sky.envFor()` (retail palette at the remapped t, or SkyState-derived on the modern sky) → if sky style is `classic`: `applyWeatherToEnv(env, frame)` (WX-R's `weather/env.ts`, identity stub now) → fog distances × `fogScale` on every path → push to terrain/scatter/water/scene. `isolateLights` becomes a no-op on the PBR mode. |
| `render/quality.ts` (new; owned later by I9A) | `RenderQuality`, `RENDER_PRESETS` low/medium/high/ultra = the §5.1 render rows as data. |
| `render/weather.ts` (new) | `RenderWeather { rain; wetness; puddles; cloud; fogMul; wind; flash }`, `CLEAR_RENDER_WEATHER`. |
| `render/index.ts` (new skeleton; RND-L owns afterwards, RND-M/RND-P/RND-W add their parts through its sub-objects) | `WorldRender { mode; setQuality(q); setWeather(w); update(camera, sky); attachCamera(camera); decorateCharacterMaterials(container); addCharacter(mesh); removeCharacter(mesh); readonly taaJitter: Vector2; readonly gpu: GpuInfo; dispose() }`, holding `lighting`, `shadows`, `post`, `materials` slots that are `null` until each lane fills them. |
| `sky/types.ts`, `sky/sky-system.ts`, `sky/chunks.ts` (new; SKY-B owns afterwards) | `SkyState` (SKY §6.1), `SkyWeather`, `SkyQuality`, `SKY_PRESETS` (§5.1 sky rows), `BAKED_LIGHT_DIR`; a `SkySystem` skeleton that wraps today's `Sky` and fills a `SkyState` from the retail env (key light = retail direction and `Diffuse × 0.6`, ambient = ObjectAmbient, fog = FogColor), so every consumer has a valid state before SKY-B lands; empty chunks. `sky.ts` unchanged until SKY-B. |
| `weather/frame.ts`, `weather/adapters.ts` (new; complete) | `WeatherFrame`, `CLEAR_FRAME`; `toSkyWeather`, `toRenderWeather` exactly as WEATHER §5.3 plus `flash: min(1, f.flash / 3)` in `RenderWeather`. Tested now (ranges for all six states). |
| `weather/index.ts`, `weather/presets.ts`, `weather/env.ts`, `weather/chunks.ts` (new skeletons; WX-R owns afterwards) | `WorldWeather { u: {wxA..wxE, wxCam, wxOcc}: Vector4 shared objects; shelter: ShelterMap \| null; rippleTexture: BaseTexture \| null; setFrame(f); setLevel(l); update(dt, camera); stats(); dispose() }`; `WEATHER_PRESETS` (§5.1 weather rows); identity `applyWeatherToEnv`; empty chunks. |
| `night-chunks.ts` (new, empty; NL owns), `render/grass-chunks.ts` (new, empty; RND-W owns) | chunk constants for §4.2. |
| `pbr/classes.ts` (new; RND-M owns afterwards) | D27. |
| `shaders.ts` | Terrain and water fragments rebuilt around the chunk points of §4.2; `vWorld` varying behind `SRO_VWORLD` (defined only when a chunk needs it); uniform and sampler name lists extended from the chunk files. Snapshot test: with empty chunks the WGSL and GLSL strings equal HEAD's. |
| `scatter-assets.ts`, `scatter.ts` | Grass chunk points (§4.2); `WorldScatter.sharedUniforms: Map<string, Vector4 \| Vector2 \| Matrix>` bound by reference in `material()` (the `uCamera`/`uFade` pattern). |
| `terrain.ts` | Layer-map alpha = `128 + surfaceClass(tile)` instead of 255 (the shader's `t.a < 0.5` test is unchanged, so the Classic image is identical; WEATHER §6.2); `setRegionTexture(region, slot: 'wetMap' \| 'nightSplat' \| 'lightmapExtra', tex \| null)` binding onto both paths' per-region material; `sharedUniforms` bound on every region material; `onRegionBuilt` / `onRegionDisposed` observables. |
| `water.ts` | `setAnimationRate(r)`; shared uniforms; the chunk point. |
| `materials.ts` | `SidecarMaterialLite.texture?: string`; `ObjectMaterials.addDecorator(fn: (mat: Material, info: { model: string; source: string; kind: 'static' \| 'clone'; unlit: boolean; alpha: 'opaque' \| 'mask' \| 'blend'; texture?: string }) => void): () => void`, run in `convert()` after each material is created (both call sites: `objects.ts` `load`, `stream.ts`); `ObjectMaterials.mode: 'classic' \| 'pbr'` read by the (future) PBR branch. |
| `objects.ts` | `loadGlb(scene, assets, rel, opts?: { srgb?: boolean })`; `WorldObjects.addRegionListener({ placed(region, model, info, meshes), removed(region) }): () => void` (generalises `setAmbient`; `info` has `source`, the sidecar bounding-box height and `isFoliage`); `setAnimationSpeed(ratio)` on every clone's `AnimationGroup`, ramped over 2 s. |
| `stream.ts` | `STREAM_DEFAULTS.ultra` = `high`'s; `RegionStreamer.addCommitStep(name, run: (region) => void, after: 'terrain' \| 'objects', debounceMs?)` — each step is its own job in the per-frame budget (FIELDS.md §3.6: a job is never split). |
| `ambient-fx.ts` | `emitters(region?)`: read-only list of placed emitters (efp, position, owner model, night flag). |
| `index.ts` | exports of every new type and module. |

### 4.2 Shader chunk points (both languages; order within a point is fixed: sky → weather → night → render)

| Shader | Point | Contributors |
|---|---|---|
| Terrain (Classic) | `uniforms`, `samplers`, `vertexOut` (sets `vWorld`) | all |
| | `layer` (inside the layer loop, after `drawn = k + 1`, with the layer's class `i32(t.a × 255 + 0.5) − 128` and blend weight `a`) | weather (surface parameters) |
| | `preLight` (after the loop, before the lightmap line; `albedo` copy available) | weather (wet albedo, puddle bottom) |
| | `lightTerm` (inside the lightmap clamp: modifies `lm`) | sky (cloud shadow on the baked sun term) |
| | `postLight` (after the lightmap multiply, before fog) | weather (sky reflection, glint, flash), night (splat, Low/Medium) |
| Water (Classic) | `uniforms`, `samplers`, `normal`, `postColor` | weather (ripples, reflection) |
| Grass (`scatter-assets.ts`) | `uniforms`, `vertexSway` (replaces the fixed `vec3(0.8, 0, 0.6)` sway) | weather (wind, gust wave, droop) |
| | `vertexLight` | render (N·L, SH, CSM tap, translucency, TAA jitter), sky (cloud shadow) |
| | `fragmentColor` (before fog) | weather (wet darkening, sheen), night (splat), render (`SRO_HDR` linear output) |

WGSL rules every chunk follows [confirmed, SKY/RENDER verify]: no `textureSample`/`dpdx`/`fwidth` inside a
non-uniform branch (use `textureSampleLevel`/`textureSampleGrad`); no swizzle assignment; no `?:`; force the facet
normal up (`n × sign(n.y)`: Babylon rewrites `dpdy` on WebGPU only).

### 4.3 `apps/game` and `apps/viewer`

| File | Edit |
|---|---|
| `apps/game/src/engine.ts`, `apps/viewer/src/engine.ts` | D10. |
| `apps/game/src/settings.ts` | `PRESETS` += `'ultra'`; `graphics.sky: 'modern' \| 'classic'` (default `'modern'`); `graphics.weather: 'auto' \| 'off' \| 'low' \| 'medium' \| 'high' \| 'ultra'` (default `'auto'`); `graphics.advanced: { shadows, ao, reflections, aa, toneMap: 'neutral' \| 'filmic', lightShafts }` (each `'auto'` or a value; default all `'auto'`, `toneMap` `'neutral'`); `graphics.firstRun: boolean` (true until the first-run detection ran); `ui.reduceFlashing: boolean` (false); `ui.clock: boolean` (true). Old saved settings normalise (tests). `qualityFor` passes `render`/`sky` blocks through (GAME fills the logic). |
| `apps/game/src/three/models.ts` | `ModelLibrary.addMaterialDecorator(fn): () => void` (D9). |
| `apps/game/src/world/features.ts` | `WORLD_FEATURES` += `skyClockFeature` (from new `features/sky-clock.ts`, GAME owns) and `weatherFeature` (from new `features/weather.ts`, WX-C owns), both no-op stubs now. |
| `apps/game/src/i18n/en.ts` | spread lines for `en-render.ts`, `en-sky.ts`, `en-weather.ts` (new, empty). |
| `apps/game/src/net/mock.ts` | (W9A-P, not W9A-S) the mock clock (`dayMs` 120 min) and a clear `WorldInfo.weather`. |

### 4.4 W9A-S tests

- `packages/world-render/test/seams-classic.test.ts` (NullEngine): with empty chunks, the terrain/water/grass shader
  strings equal golden copies taken from HEAD; Low + classic sky + weather off builds the same material classes and
  defines as HEAD; the layer-map alpha round trip (`128 + class` → class; `t.a ≥ 0.5`).
- `render-quality.test.ts`: every preset has every key; Low has every render feature off.
- `weather-adapters.test.ts`: every field in range for the six states and for blends.
- `objects-listeners.test.ts`, `stream-commit-steps.test.ts`: listener placed/removed per region; commit steps run
  as separate jobs after their dependency.
- `apps/game/test/settings.test.ts` extended; `engine.test.ts`: `requiredFeatures` ⊆ adapter features (fake
  adapter); `?gpuLimits=default` omits `setMaximumLimits`.
- `pnpm typecheck` clean; the whole suite green.

---

## 5. Presets and budgets

### 5.1 The merged preset table (the data W9A-S writes into the three preset tables)

| Feature | Low (Classic) | Medium | High | Ultra |
|---|---|---|---|---|
| Material path | retail fixed-function (today) | PBR, class defaults (+ maps when 9B sets exist) | PBR | PBR |
| Terrain | retail splat | PBR splat, vertex normals | + layer normals (when sets exist), height blend, triplanar on steep cells, detail layer | + anti-tiling, parallax |
| Textures (9B, D39) | retail | retail-size remaster + hero maps (user call) | 2× (≤ 1024) + hero maps; terrain 1024 (48-layer cap) + 512 maps | 4× (≤ 2048), KTX2 only |
| Sky style (default) | modern (classic in Options) | modern | modern | modern |
| Sky-view LUT | 48×24, 12 steps, 4 s | 96×48, 16 steps, 2 s | 96×48, 24 steps, 1 s | 128×64, 32 steps, 0.5 s (worker) |
| Clouds | retail `cloud1` plane | cumulus 3 + 1 light tap | cumulus 3 + 2, cirrus | 4 + 3, cirrus, detail octave |
| Cloud shadows | — | — | terrain, grass | + objects |
| Stars / flares | 128/face / — | 256/face / — | + twinkle / 4 sprites | + Milky Way / 8 |
| `sunPath` | baked | dynamic | dynamic | dynamic |
| HDR, tone map (Neutral), LUT grade, bloom | — | yes (bloom 0.5) | yes | yes |
| Exposure | sky shader only | `SkyState.exposure` × trim | same | same |
| Sun shadows (CSM, proxies) | — (lightmaps) | 1024 × 2, 60 m | 2048 × 3, 150 m, + foliage ≤ 60 m, + terrain | 2048 × 4, 250 m, + g3 props |
| IBL | — (hemi colours from `SkyState` on characters) | SH + 32² sky cube / 10 s | SH + 64² cube / 5 s | SH + 64² cube / 2 s |
| Night lights | splat + emissive | splat + cluster 8 (pool 2 fallback) | cluster 32 (grass splat) | cluster 64 |
| SSAO | — | — | half res, 8 samples | full res, 16 samples |
| SSR | — | — | — (§6.20 cut 4, wave-9 final gate; Options → Advanced → Reflections) | always |
| AA | MSAA ×4 (canvas) | FXAA | TAA + reprojection + sharpen (MSAA ×4 option) | same |
| Light shafts | — | — | — | yes |
| Fog | linear, weather distance | height fog | + horizon ring colour | same |
| Water | retail (+ Classic ripples) | PBR, vertex alpha | + depth shore | + mirror (optional, cut first) |
| Foliage | retail (+ Classic sway at weather high+) | wind + translucency | + CSM caster, grass root CSM tap | same |
| Weather `auto` → | low | medium (**low on an integrated GPU**, first-run) | high | ultra |
| Weather: wet darkening / puddles / ripples / streaks / splashes / shelter / static sway / bolt | per `WEATHER_PRESETS` (WEATHER §9.1 table, unchanged) | | | |
| Render scale default | 1.0 | 1.0 (0.75 + FSR1 on an iGPU) | 1.0 | 1.0 |

**First-run default** (GAME; RENDER §10; the release decision of 2026-09-29, "Default Medium, High optional"):
Medium on every adapter class, WebGPU and WebGL2 alike (discrete desktop and laptop GPUs, Apple GPUs, unnamed
adapters); an integrated adapter (`intel` without "arc", `gen-12lp`/`xe-lpg`, an AMD APU the strings name, a software
renderer or `isFallbackAdapter`) → Medium at render scale 0.75 with FSR1 and weather `low`; an Apple GPU on a Retina
screen → render scale 0.75; WebGL1 → Low. High and Ultra are the player's choice (the final gate: WebGPU High misses
60 fps in the plaza and the crowd). Existing saved settings keep their preset, so **a player saved on Medium moves from
the Classic look to PBR** on update (user decision, §8). A blob saved before the release on Low with the preview off
keeps the look it had: the release writes sky `classic` and weather `off` into it once (`settings.ts`
`runReleaseMigration`; the Low column's modern-sky default applies to new Low choices). Low + classic sky + weather off
is the Low guard's combination (`settings.ts` `classicLook`): the whole pre-wave look, a frozen noon, a clear weather
frame and no night splats included (the W9 release verify 2); the Low column's clock, weather and splats apply as soon
as the sky or the weather row leaves it.

### 5.2 Budgets and honest costs (1080p unless noted)

Dev PC = Ryzen 5 9600X + RX 9060 XT, Chrome 152, WebGPU. "Mid" = RTX 3060 / RX 6600 class; "iGPU" = Iris Xe / 680M
at render scale 0.75 + FSR1. Renderer rows are RENDER §11 (measured on the dev PC, projected elsewhere); sky rows
SKY §9.2 (CPU measured, GPU projected); weather rows WEATHER §9.2 (dev measured with ±0.06 ms noise, others
projected).

| Preset | Renderer CPU (dev, measured) | Renderer GPU (dev, 8K ÷ 16) | + sky GPU (mid) | + weather GPU in rain (mid) | Total GPU, mid [projected] | iGPU total GPU [projected] |
|---|---|---|---|---|---|---|
| Low | 1.3–1.5 ms | 0.67 ms | 0.1 | 0.3–0.7 (weather low) | ≈ 1.5–2 ms | 5.4 × 0.56 + 0.35 + 0.6–1.4 ≈ 4–5 ms |
| Medium | 2.7 ms | 0.87 ms | 0.2 | 0.5–1.2 | ≈ 2.1–2.8 ms | 3.9 + 0.8 + 0.6–1.4 (weather low) ≈ 5.3–6.1 ms |
| High | 3.5 ms | 1.32 ms | 0.3 | 0.7–1.6 | ≈ 3.1–4.0 ms | not a default (≈ 6 + 1.5 + 1.3–2.8) |
| Ultra | 5.1 ms | 2.76 ms | 0.4 | 0.9–1.8 | ≈ 5.7–6.6 ms | not offered by default |

What the table means, honestly:

- **The game is CPU-bound.** Babylon draw submission dominates; the whole game frame is ~6.7 ms of JS on the dev PC
  (EFFECTS.md §7), and High adds ~2.2 ms. On a mid desktop CPU (×1.5) High is ≈ 13 ms of JS: inside 16.7 ms, but
  not by much. Every lane guards its **CPU** budget first; the naive shadow setup cost +43 ms before proxies.
- **SSR, TAA reprojection, the cluster tile mask and Ultra's full stack are not measured yet** [unknown]; the Ultra
  and rain rows understate SSR (RENDER verify).
- **iGPU: Medium with weather `low` at 0.75 scale** fits a 16.7 ms frame only if the game JS (×2 CPU) stays near
  13 ms; the first playtest on a friend's weakest laptop decides (§8).
- **N100-class** clients stay on Low (Classic) with weather `low` at render scale 0.5, or `off`.
- **VRAM:** 9A adds only small textures (sky LUTs < 0.3 MiB, cube 128 KiB, splats ~1.3 MiB in town, shelter 0.5 MiB,
  ripples ≤ 256 KiB, CSM 2048² × 3 depth ≈ 50 MB on High). 9B's texture sets are the big item (TEXPIPE §6.5): High on
  WebP ≈ 0.7–1.0 GB, Ultra needs BC7 (≈ 0.8–1.1 GB).

Per-lane budgets on the dev PC (1080p, the town view; each lane measures with the minimum of 5 runs and no other GPU
page open, RENDER §16 hygiene):

| Lane | Budget |
|---|---|
| SKY-B | whole sky ≤ 0.3 ms GPU mid (High), ≤ 1.0 ms iGPU (Medium), ≤ 0.2 ms average CPU; a haze rebuild ≤ 1.4 ms/frame for ≤ 30 frames |
| NL | Medium night ≤ 0.5 ms iGPU (pool 2 or cluster 8), High cluster ≤ 0.6 ms mid; tile-mask pass measured and reported |
| WX-R | weather ≤ 1.5 ms mid at High, ≤ 1.0 ms iGPU at Low; shelter re-render ≤ 0.3 ms per render on the dev GPU; wet map 0.7–1.1 ms per region as its own commit job |
| RND-M | object PBR ≤ +0.3 ms GPU and +0 ms CPU over Classic on Medium |
| RND-T | terrain PBR ≤ +0.5 ms GPU on High; Ultra parallax ≤ +0.5 ms more |
| RND-L | CSM at High ≤ 1.0 ms CPU (proxy rule measured +0.75 ms); a sky-cube refresh ≤ 2 ms main thread (one face per frame) |
| RND-P | Medium post ≤ 0.7 ms GPU, ≤ 0.5 ms CPU (measured +0.34 ms CPU); High ≤ 2 ms GPU, ≤ 1 ms CPU; SSR ≤ 1.5 ms GPU in rain |
| RND-W | water ≤ 0.3 ms GPU; grass upgrade ≤ +0.3 ms at medium density |
| Whole game | High on the dev PC: p95 frame < 16.7 ms in town in a storm at night, and the watchdog never trips |

---

## 6. Wave 9A: the engine (works with the retail textures)

### 6.0 Step order and concurrency

```
step 0 (parallel):  W9A-P  |  W9A-S  |  SKY-C  |  WX-A  |  TP-0
                        \      |
step 1 (parallel, after W9A-P and W9A-S merge):
                    SKY-B | NL | WX-R | WX-C | RND-M | RND-T | RND-L | RND-P
step 2 (after step 1 merges):   RND-W | GAME | LAB
step 3:                         I9A (integration), then H9A (hunt), then I9A fixes
```

- W9A-P and W9A-S touch disjoint files (shared/server/mock vs world-render/game/viewer). Step 1 lanes use only the
  seams; each lane's tests run against the skeletons, so no step-1 lane waits for another.
- Inside step 1 the soft dependencies are data, not files: RND-L calibrates against the skeleton `SkyState` first and
  re-checks after SKY-B (in LAB); NL's splat uses the skeleton night factor until SKY-B.
- Merge order at the end of step 1: SKY-B → WX-R → NL → RND-M → RND-T → RND-L → RND-P → WX-C (chunk files and plugin
  files are disjoint, so the order only matters for the re-run of the calibration).
- Every lane runs `pnpm vitest run <its tests>` and `pnpm typecheck` before hand-off; nobody commits; the lead
  integrates.

### 6.1 W9A-P: protocol, shared maths, server (one agent, first)

- **Owns:** `packages/shared/src/world-clock.ts`, `packages/shared/src/weather.ts` (new); `protocol.ts`,
  `validate.ts`, `index.ts` (additive); `apps/server/src/world-clock.ts` (new: `WorldClock.load(config)`, JSON
  persistence, GM runner), `apps/server/src/weather.ts` (new `GameplayModule`: tick ≤ 1 Hz, sync, lightning, GM
  runner); edits in `apps/server/src/config.ts` (6 keys), `connection.ts` (`world.clock`, `world.weather` in
  `worldEnter`), `gm.ts` (two `COMMANDS` entries; `worldClock` to `conn.player` sockets only), `gameplay.ts`
  (register the weather module); `apps/game/src/net/mock.ts`; `docs/PROTOCOL.md` (a wave-9 subsection: messages,
  GM rows).
- **Tests:** `packages/shared/test/world-clock.test.ts` (`solarTime` monotonic and fixes 0/0.5/1; the §2.3 night
  table ±0.3 min; `sunDirection(0.25)` points +X, noon has z > 0; moon full = texture 16 at age 14.77, age 0.9 → 1,
  29.4 → 30; `phaseForSolarTime` round trip); `packages/shared/test/weather.test.ts` (schedule determinism and
  restart; 60-day shares ±3 %; blend endpoints and the rain lag; `stepSurface`: soak to 0.9 in 80–100 s at rain 1,
  dry in 8.5–10 min at sun 1 and wind 2 m/s, puddle ≤ wet + 0.1; `fogScale` table; validator round trips and
  rejections, including a bad `clock` inside `worldInfo` keeping the rest of `worldEnter`);
  `apps/server/test/world-clock.test.ts` (`time 06:00` within 1 s; `time length` keeps t; JSON survives a restart in
  a tmp dir; lobby sockets get no `worldClock`); `apps/server/test/weather.test.ts` (enter carries `weather`; a
  schedule change broadcasts once; `weather storm 5 0` → `to: 'storm'`, `gm: true`; `weather auto` clears it;
  `weather strike` → one `lightning`; strikes ≥ 4 s apart; `WEATHER=off` → no `weather` after enter).
- **User check:** as a GM, `/time 18:30` and `/weather rain` answer in chat; `/time` prints the same clock on two
  clients.

### 6.2 W9A-S: client seams (one agent, first)

§4 in full. **User check:** nothing changes on screen; the perf overlay and every existing test are unchanged.

### 6.3 SKY-C: sky assets (step 0)

- **Owns:** `packages/convert/src/tools/export-sky.ts` (new; run as `pnpm tsx packages/convert/src/tools/export-sky.ts`;
  `cli.ts` has no `export-*` commands, so no `cli.ts` edit). Writes `work/out/sky/`: `moon/moon01..30.png`,
  `lens/lens1..8.png`, `cloud1.png`, the seeded `cloud-noise.png`, `sky.json`.
- **Edits:** `packages/convert/src/optimize/run.ts` (`WORLD_PNG` rule and its rewrite: `sky/**.png` → WebP, **except
  `cloud-noise.png`, forced lossless or kept as PNG**: lossy q90 gives up to 23/255 channel error [confirmed, SKY
  verify]). This is the only lane that edits `run.ts` in 9A.
- **Tests:** noise deterministic (byte hash); coverage 0.2/0.5/0.8 ± 0.02 also after the out-opt round trip; 30 moons
  at 128².
- **User check:** `work/out/sky/moon/` shows the phases in order, moon16 full.

### 6.4 WX-A: weather sound export (step 0)

WEATHER WX-A unchanged: `packages/convert/src/tools/export-sound.ts` (12 files: `etc/rain1.wav`,
`lightning1..3.wav`, `dd_*`, `donhwang_wind*`; the wind bed uses `donhwang_wind04`, 20.7 s), weather cues in
`packages/shared/src/sound.ts`, a weather section in `docs/SOUND.md`. Tests: the plan lists the 12 files; the index
has the cues; the export writes `work/out/sound/etc/rain1.ogg` (skips without `sro.config.json`).

### 6.5 TP-0: texture index format and inventory (step 0; 9B's first lane, early on purpose)

TEXPIPE TP-0 with this plan's key and packing decisions (D35–D37): `packages/texpipe/` (new workspace package
`@sro/texpipe`: `sharp`, `@gltf-transform/core`, both already used by `@sro/convert` [likely: no new download]),
`src/format.ts` (`PbrIndex`, `PbrSet`, `PbrTier`, `keyOf`, `keyPath`, `validatePbrIndex`; environment-neutral,
imported by RND-M by relative path, like `convert/src/world/format.ts`), `src/inventory.ts`, `src/cli.ts`,
`content/texpipe/overrides.json` (skeleton). The lead adds the root script `"texpipe": "tsx packages/texpipe/src/cli.ts"`.
`classify` comes from `pbr/classes.ts` (W9A-S). Tests: TEXPIPE TP-0 list, plus the 104 tile stems are unique (D36)
and the ORMH packing constants. **User check:** `pnpm texpipe inventory` prints 1,213 textures / 91.4 Mpx.

### 6.6 SKY-B: atmosphere, dome, clouds, `SkyState` (step 1)

- **Owns:** `packages/world-render/src/sky/*` (`atmosphere.ts` with Bruneton's horizon mapping for transmittance,
  `sky-luts.ts` with per-row half-float packing, `celestial.ts`, `clouds.ts`, `sky-shaders.ts` WGSL + GLSL,
  `sky-system.ts`, `ibl.ts` (pure face fill + SH, D14), `flares.ts`, `classic-sky.ts`, `types.ts`, `chunks.ts`),
  `sky.ts` (becomes `export { ClassicSky as Sky }`), `packages/world-render/test/sky-*.test.ts`.
- **Hook points:** `World.sky` (`SkySystem`, with `mesh` getter), `sky.envFor()`, `sky.setWeather(SkyWeather)`,
  `sky.setQuality(SkyQuality)`, `sky.setOutputMode(0 | 1)` (D17), the terrain `lightTerm` chunk and the grass
  `vertexLight` cloud-shadow chunk, `sroCloudShadow()` for the PBR plugins (D28).
- **Tests:** SKY-B list (LUT reference points within 2%; sliced = whole; half-float round trip; `SkyState`
  continuous across midnight and a `time` jump, no NaN, key light sun → moon without a step > 5%; noon fog ΔE < 10
  of the retail FogColor after grading), plus `fillSkyCube` of a constant sky is constant and `skySH` of a constant
  sky integrates to that constant × π within 1%.
- **User checks** (viewer, WebGPU and `?engine=webgl`): the time slider sweeps blue noon → orange sunset with a pink
  anti-sun belt → blue hour → stars and the moon; `?clock=fast` shows clouds turning orange while the ground dims; no
  LUT popping; GPU time within budget.

### 6.7 NL: night lights (step 1; D12, D29)

- **Owns:** `packages/world-render/src/night-lights.ts` (`NIGHT_LIGHT_KINDS` = SKY §7.2; the light list from
  `ambient-fx.ts` `emitters()` × placements through `WorldObjects.addRegionListener`; merge within 0.5 m; the
  per-region splat bake as a commit step (`addCommitStep('nightSplat', …, 'objects')`) bound with
  `setRegionTexture(region, 'nightSplat', tex)`; the cluster/pool driver per preset; the lamp emissive rule as an
  `ObjectMaterials` decorator; `addDynamicLight(light)` for the hit lights), `night-chunks.ts`,
  `packages/world-render/test/night-lights.test.ts`, and the night switch in
  `apps/game/src/world/features/fx-world.ts` (ambient night from `SkyState.night` with hysteresis 0.6/0.4, replacing
  `NIGHT_UNTIL`/`NIGHT_FROM`).
- **Tests:** 109 lights in Jangan (± merged duplicates); the splat is black at `night = 0` and at radius r; the light
  count never changes during reassignment (no recompile); the cluster fallback when `isSupported` is false; a
  NullEngine character material's `lightSources` includes the cluster.
- **User check:** `/time 22:00` in Jangan: lanterns glow and pool warm light on the ground; characters under a lamp
  are lit; a mob is visible at 30 m; FPS drop within budget.

### 6.8 WX-R: weather in world-render (step 1)

- **Owns:** `packages/world-render/src/weather/{index, presets, env, chunks, wetmap, shelter, ripples, rain,
  wet-plugin}.ts` (`frame.ts` and `adapters.ts` stay as W9A-S wrote them; changes only via I9A) and
  `packages/world-render/test/weather-*.test.ts`.
- **Hook points:** the terrain `uniforms/samplers/vertexOut/layer/preLight/postLight` chunks; the water chunks and
  `WaterRenderer.setAnimationRate(1 + 0.8 × wxB.z)`; the grass `vertexSway`/`fragmentColor` chunks;
  `addCommitStep('wetMap', …, 'terrain')` + `setRegionTexture(region, 'wetMap', …)`; `ObjectMaterials.addDecorator`
  for `attachWetness` (skips unlit, alpha-blended and RENDER-plugin materials, D19); exports `attachWetness` for WX-C's
  actor decorator; `WorldObjects.setAnimationSpeed(0.8 + 1.4 × strength)` for skinned trees; `applyWeatherToEnv`;
  `world.weather.shelter` (D20) and `rippleTexture` (D21); the rain box, curtain, splashes, drips and bolt
  (`weather/rain.ts`, from `work/tmp/weather/gpu/main.ts`; group 0 with `alphaIndex`, **not** rendering group 1,
  which clears depth).
- **Tests:** WEATHER WX-R list (wet map on synthetic and one real region; rain wrap; layer-map class round trip;
  WGSL/GLSL `wx*` parity; `isCompatible` true for both languages — the base returns GLSL only and the manager throws
  on WGSL [confirmed]; `setWeatherLevel('off')` disposes rain meshes and the shelter RTT; `applyWeatherToEnv` at
  storm and fog), plus: `attachWetness` refuses a material with `SroSurfacePlugin`; the shelter map is not rendered
  while dry.
- **User checks** (viewer or game, `?weather=storm`, graphics Low): rain slants with the wind and stops under the
  gate roofs; the plaza and roads darken and shine; puddles form in low spots of the dirt roads within minutes; grass
  bows; `clear` dries in ~9 min.

### 6.9 WX-C: weather client feature and audio (step 1)

- **Owns:** `apps/game/src/world/features/weather.ts` (the `WorldFeature`: messages, blending from the current vector,
  zone climate via `zoneAt`, gusts, flash, `ctx.world.setWeather(frame)`, `setWeatherLevel`, the Classic character
  light multipliers by `scene.getLightByName('sun'/'hemi')` from base values 1.2/0.7 (Low only; on PBR presets GAME
  disables those lights), night-light scale `1 − 0.3 × rain`, the actor wetness decorator via
  `ModelLibrary.addMaterialDecorator(attachWetness)`, its two option rows via `registerOptionRow`, `?weather=` override,
  `window.__sroWeather`), `apps/game/src/audio/weather.ts`, `apps/game/src/i18n/en-weather.ts`; edits in
  `audio/backend.ts` (`setGain?`, `setLowpass?`, `rate?`, `filter?`), `audio/ambient.ts` (mute bird one-shots in
  rain), `audio/index.ts` (own a `WeatherAudio`).
- **Tests:** WEATHER WX-C list (mid-transition enter; no jump on a mid-transition message; thunder at `distM / 343`
  s; `reduceFlashing`; `auto` mapping including iGPU → low; `WeatherAudio` with a fake backend).
- **User checks:** WEATHER WX-C checks 1–8 (GM `/weather rain`, shelter, puddles, storm, clear, fog, Options, a late
  joiner sees the same weather and puddles).

### 6.10 RND-M: PBR objects and characters; the runtime map loader (step 1)

- **Owns:** `pbr/classes.ts` (from W9A-S, D27), `pbr/maps.ts` (`sro-pbr` index **and** `sro-remaster` parser into one
  runtime record, D35; ref-counted texture cache; a missing index = no sets, D40; the preset cap; `remaster.ts`
  `parseRemasterManifest` moves here and `apps/game/src/three/remaster.ts` re-imports it — RND-M makes that one-line
  edit), `pbr/surface-plugin.ts` (`SroSurfacePlugin`: class defaults, luminance roughness, baked visibility and the
  lightmap AO share (§2.5 floors), wetness per D19 with the shared shelter/ripple functions, SSR reflectivity mask
  (D31), cloud shadow (D28), emissive night factor), `materials.ts` (`ObjectMaterials.convert` PBR branch `toPbr`
  beside `fromPbr`, chosen by `ObjectMaterials.mode`), `packages/world-render/test/pbr-*.test.ts`.
- **Also (DETAIL H3/H4/H6, cheap):** `enableSpecularAntiAliasing` on every material with a normal map; `sheen` on the
  `cloth` class (High+); skin F0 ≈ 0.028 and `subSurface.isTranslucencyEnabled` on Ultra.
- **Hook points:** `ObjectMaterials.convert` (both callers); `WorldRender.decorateCharacterMaterials(container)`
  (GAME registers it through `ModelLibrary.addMaterialDecorator`); plugin hook points RENDER §3.5 (with the verify
  fixes: `diffuse0 = vec4f(diffuse0.rgb * x, diffuse0.a)`; the AO regex re-emits `$1`; translucency is not here).
- **Tests:** RENDER RND-M list (40 most-used Jangan textures → classes; both languages same injection keys;
  NullEngine `isReady`; index parsing, missing maps fall back, the cap picks `@1024`), plus: an `sro-remaster` entry
  wins over an `sro-pbr` set; `keyOf` normalises backslash paths.
- **User check** (viewer `?render=pbr`): buildings shade with the sun and sky, roofs catch highlights, eave shadows
  from the object lightmaps still read.

### 6.11 RND-T: PBR terrain (step 1)

- **Owns:** `pbr/terrain-plugin.ts` (`SroTerrainPlugin`, from `work/tmp/render/bench.ts`: splat, baked visibility,
  roughness; height blend, triplanar, detail layer, anti-tiling, parallax per define; per-layer normals and ORMH only
  when arrays exist; wetness from the wet map + shelter + ripples; night splat on Low/Medium only (D29); cloud
  shadow (D28)), `terrain.ts` (the PBR branch of `buildRegion`, normals; the Classic branch untouched),
  `tile-atlas.ts` (parallel `normal` and `ormh` arrays with the same layer index, allocated only when a set provides
  them, D39), `region-chunk.ts` (`commitTerrain`: neighbour-aware normals; re-normal loaded neighbours' edges),
  `textures.ts` (only what the arrays need in 9A), `packages/world-render/test/terrain-*.test.ts`.
- **Tests:** RENDER RND-T list (flat → (0,1,0); 45° ramp; neighbour edge normals equal; arrays share a layer and
  release together; headless `buildRegion` on both paths), plus the WebGL2 sampler count ≤ 16 for every final define
  set (D32).
- **User check:** hills catch the sun and fall into shade as the time changes; baked building shadows on the ground
  stay; grass and dirt no longer look like a flat decal.

### 6.12 RND-L: light, IBL upload, shadows (step 1)

- **Owns:** `render/index.ts` (from W9A-S), `render/lighting.ts` (the celestial `DirectionalLight` created **first**
  so it is light 0 [RENDER verify]; `SkyState.keyLight` → the light; SH → `sphericalPolynomial`; `SkyEnvironment`
  per D14; the flash (D25); `k_render` calibration with RND-P), `render/shadows.ts` (`ShadowProxies` per region via
  `addCommitStep('shadowProxy', …, 'objects', 500)`, `layerMask = 0x20000000`, one shared opaque material;
  `ShadowCasters.update` every 8 m; the per-cascade `getCustomRenderList` filter as an experiment [likely]),
  `packages/world-render/test/{lighting,shadows}-*.test.ts`.
- **First task:** measure the retail bake direction (D16) and report it; then the calibration (sun : ambient 5 : 1
  clear noon, exposure so the plaza albedo lands near its Classic brightness).
- **Tests:** RENDER RND-L list (constant sky SH within 1%; black-below-horizon; proxy triangle count and positions;
  distance filter; foliage only ≤ 60 m; removal on unload; no caster beyond `shadowMaxZ + radius`), plus
  `mesh.lightSources[0] === celestial` on a PBR mesh, and the light count constant across day/night.
- **User check:** buildings, trees and characters cast soft shadows that move with the sun; no shimmering while the
  camera turns; characters look lit like the world around them.

### 6.13 RND-P: post, grade, height fog (step 1)

- **Owns:** `render/post.ts` (the RENDER §5.1 stack per preset, created and torn down on `setQuality` and
  `attachCamera`; drops the prepass when `gpu.maxInterStageShaderVariables < 17`; TAA per D30; SSR per D31; FSR1 for
  render scale < 1), `render/grade.ts` (`GradeMixer`, D26), `pbr/fog-plugin.ts` (`SroFogPlugin`, D18),
  `packages/world-render/tools/make-render-textures.ts` (LUT strips and water normals only; our own art, written to
  `apps/game/public/render/`), `packages/world-render/test/{post,grade,fog}.test.ts`.
- **Tests:** RENDER RND-P list (identity LUTs blend to identity; weights sum to 1; no re-upload below 0.01; preset →
  pipeline list and order; Low builds nothing; height fog at h → 0 equals uniform exponential fog; 95% at the retail
  fogEnd × `fogMul`).
- **User check:** a warmer, deeper image; soft contact shadows; bloom on lanterns and the sun; golden evening, blue
  night; Options → Tone mapping switches Neutral/Filmic live.

### 6.14 RND-W: PBR water, foliage, grass HDR (step 2)

- **Owns:** `pbr/water-plugin.ts`, `water.ts` (PBR branch; Classic untouched; ripples from `world.weather`),
  `pbr/foliage-plugin.ts` (translucency at `CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION` on `finalDiffuse`, not
  `CUSTOM_LIGHT0_COLOR` [RENDER verify]; wind at `CUSTOM_VERTEX_UPDATE_POSITION` with WX-R's sway function (D23);
  `ShadowDepthWrapper`), `render/grass-chunks.ts` (N·L, L1 SH, one CSM tap per plant on High+, translucency, TAA
  jitter, `SRO_HDR`), `scatter.ts` (uniform plumbing), tests `water-pbr.test.ts`, `foliage.test.ts`.
- **User check:** the pond reflects the sky and shimmers; back-lit trees glow; grass in a building's shadow goes dark;
  trees and grass sway together in a storm.

### 6.15 GAME: game integration and options (step 2)

- **Owns:** `apps/game/src/screens/world.ts` (disable the hemi and character sun on PBR presets; do not build
  `RemasterLighting` on PBR (D15); `world.render.attachCamera`; register `world.render.decorateCharacterMaterials` via
  `ModelLibrary.addMaterialDecorator`, with `maxSimultaneousLights = 6` on characters only when NL runs the pool
  fallback; on Low apply `SkyState` to the hemi/sun each frame — SKY's `applySkyToLights` adapter, exported by
  SKY-B), `apps/game/src/settings.ts` (first-run detection §5.1, `qualityFor` with render/sky blocks, `applyGraphics`
  hands render scale to FSR1, the watchdog), `apps/game/src/hud/options.ts` (preset with Ultra, Advanced sub-rows,
  tone map, sky style; switching to/from Low asks to confirm), `apps/game/src/world/features/sky-clock.ts` (the clock
  from `worldEnter`/`worldClock`, HUD clock next to the minimap when `ui.clock`), `apps/game/src/world/jangan/ground.ts`
  (drop `timeOfDay: 0.5`), `apps/game/src/world/fx/hit-light.ts` (join the cluster on PBR presets via
  `addDynamicLight`), `apps/game/src/hud/perf-overlay.ts` (render mode, preset, GPU ms when `timestamp-query` exists,
  weather line from `world.weather.stats()`), `i18n/en-render.ts`, `i18n/en-sky.ts`.
- **Tests:** settings (old saves normalise; `ultra` accepted; first-run per adapter fixture: WebGL2 → low, 16
  varyings → ≤ medium, Intel iGPU → medium + 0.75 + weather low, discrete → high); options rows; the sky-clock
  feature applies `worldEnter`/`worldClock` (mock session).
- **User checks:** Options → Graphics shows Low (Classic) / Medium / High / Ultra and Advanced; switching from Low
  confirms and rebuilds in about 2 s; over 10 minutes of play the light visibly moves; sky style Classic returns the
  2005 sky without a reload.

### 6.16 LAB: viewer lab, bench and sign-off (step 2)

- **Owns:** `apps/viewer/src/world/main.ts` (`?render=classic|pbr`, `?preset=`, `?weather=`, `?clock=fast`, time
  scrub), `apps/viewer/src/world/render-panel.ts` (new: live toggles for every §5.1 row, exposure, tone map, LUT key,
  wetness, a "bench" button running the `work/tmp/render/bench.ts` method), `apps/viewer/world.html` (panel mount);
  the normal-convention check (DETAIL H8) on a lit test mesh.
- **Delivers:** the §5.2 table re-measured on the final build (dev PC; one integrated laptop if a friend can run it),
  the SSR, TAA-reprojection and cluster tile-mask numbers, and the answers to D14 (CPU blur vs `HDRFiltering`), D16
  (bake direction review), D30 (TAA ghosting).
- **User checklist** (RENDER §14 RND-I, extended): (1) Low + classic sky + weather off looks exactly as before at the
  gate, t = 0.5; (2) High at noon: shadows under the gate and trees, AO in corners, no shimmer; (3) scrub t 0.2 →
  0.8: sunrise in the east, shadows sweep, golden evening, blue night with lanterns blooming; (4) rain: the ground
  darkens within a minute, puddles in hollows with ripples, reflections, dry under the gate roof, fog closes in; (5)
  Ultra: light shafts at sunrise, parallax on paths; (6) the perf overlay stays under 16.7 ms on High on the dev PC,
  the watchdog never trips; (7) `?engine=webgl`: Low renders, Medium renders without errors; (8) `?gpuLimits=default`:
  High is refused and Medium renders (no black frame).

### 6.17 Tests and gates (wave 9A)

- Every lane: its tests, `pnpm typecheck`, and the whole suite green at hand-off.
- The Low guard (`seams-classic.test.ts`) must stay green after **every** merge.
- Every plugin ships WGSL and GLSL; a unit test asserts both languages return the same set of injection-point keys.
- A GLSL-on-WebGPU guard (the bench's) runs in LAB: no GLSL reaches the WebGPU engine, no request to
  `babylonjs.com` in the network panel.

### 6.18 I9A: integration checklist (one agent)

1. Merge step 0 (W9A-P, W9A-S, SKY-C, WX-A, TP-0); run the suite; record the test count.
2. Merge step 1 in the §6.0 order; after each merge run the Low guard and typecheck.
3. Merge step 2 (RND-W, GAME, LAB).
4. `pnpm sro export`-side: run `export-sky.ts` and `export-sound.ts`, then `optimize-out`; check `out-opt/sky/`
   (cloud noise lossless) and the sound files.
5. Server + two browser clients (WebGPU and `?engine=webgl`): `/time 18:30` changes both skies within a frame;
   `/weather storm` reaches both; a third client entering mid-storm sees the same puddles; the lobby receives no
   `worldClock`.
6. An older-server check: a client against a server without the clock/weather fields runs a local noon clock and
   clear weather.
7. Presets: each of Low/Medium/High/Ultra at noon, dusk, night, and in rain at the gate, the plaza, a tree cluster;
   screenshots for the user.
8. Budgets: LAB's table within §5.2; any miss goes to the scope-cut list (§6.20) before release.
9. Docs: PROTOCOL.md (wave-9 subsection), SOUND.md (weather), ASSETS.md (`out/sky/`, `public/render/`), TERRAIN.md
   §5.3 "29 phases" → 30 and moon16 = full (SKY verify), DEPLOY.md (the six config keys).
10. Delete scratch the lanes no longer need: `work/tmp/render/` (after LAB), `work/tmp/sky/`, `work/tmp/weather/`
    (after WX-R ports the rain shader).

### 6.19 H9A: adversarial-hunt lenses

1. **Black frame on WebGPU:** any preset × plugin combination that exceeds 16 inter-stage variables on an adapter that
   grants 16 (`?gpuLimits=default`); each plugin's added varyings counted.
2. **GLSL reaching WebGPU** (Babylon then downloads glslang/twgsl from its CDN): every new material and plugin.
3. **WGSL uniformity:** `textureSample`, `dpdx`, `fwidth` inside per-pixel branches in every chunk and plugin.
4. **Low regression:** Low + classic sky + weather off differs from HEAD in any pixel or define.
5. **Double application:** two wet terms on one surface, two fog terms on PBR, double tone mapping of the sky, weather
   env multipliers applied on the modern sky.
6. **Light index 0:** a mesh whose first light is not the celestial light (baked visibility then scales the wrong
   light); a light count change at dusk (a scene-wide recompile hitch).
7. **Recompile hitches:** weather changes, day/night, rain start — none may change a define; only Options may.
8. **Clock edge cases:** midnight wrap, `time freeze`/`resume`/`length` jumps, a clock anchor far in the past, NaN in
   `SkyState`, moon hidden near new moon, `DAY_LENGTH_MIN` extremes (1 and 1440).
9. **Protocol:** malformed `worldClock`/`weather`/`lightning` rejected without dropping `worldEnter`; lobby sockets
   never get `worldClock`; a non-GM cannot run `time`/`weather`; `WEATHER=off` sends nothing after enter.
10. **CPU regressions:** shadow casters beyond range, per-frame allocations in `update()` paths, the cluster re-pick,
    `WorldObjects` listeners on every placement, commit steps longer than the frame budget.
11. **Leaks on region unload and world change** (char-select → world → char-select): shadow proxies, wet maps, splats,
    the shelter RTT, the rain meshes, post pipelines on camera change, sky LUT textures, the cube.
12. **Streaming seams:** terrain normals before/after a neighbour commits; the shelter map when objects commit after
    terrain (rain through a fresh roof).
13. **WebGL2:** sampler count ≤ 16 per terrain define set; half-float render target missing (shelter RGBA8
    fallback); cluster `isSupported` false → pool.
14. **Readability:** a mob at 30 m at midnight in a storm with fog; UI legibility unchanged; `reduceFlashing` covers
    sky, env and PBR flash.
15. **Audio:** rain loop seams, thunder delay, muffling under shelter, birds muted.

### 6.20 Scope-cut order (wave 9A; cut from the top)

1. Ultra water mirror; light shafts (VLS).
2. Ultra anti-tiling and parallax.
3. Lens flares; Milky Way; star twinkle.
4. SSR on High (Ultra keeps it; puddles still reflect the sky cube).
5. Lightning bolt mesh, drips, splashes (the flash, thunder and rain stay).
6. TAA reprojection → High uses MSAA ×4 on the HDR target.
7. Cloud shadows on objects, then on terrain.
8. Horizon-ring directional fog (the forward-azimuth fog colour stays).
9. Grass CSM tap; foliage `ShadowDepthWrapper` (static shadow of swaying trees).
10. Terrain detail layer, triplanar.
11. Clustered lights → pool of 2 on every PBR preset.
12. PBR water → retail water on every preset (with Classic ripples).
13. Static-tree vertex sway on the Classic path.

**Applied at the wave-9 final gate (2026-09-29, work/tmp/w9-finish/budgets.md):** cut 4 (no SSR on High). WebGPU High
still misses its 16.7 ms p95 at the plaza (17.9 ms) and in the 20-mob crowd (21.5 ms) on the dev PC. The miss is CPU
draw submission: a PBR draw costs about twice a Classic one, and the High crowd has about 300 more CSM draws. The GPU
cuts further down this list cannot fix that, so they were not applied. What does fix it (High at Medium's draw
distance and scatter: 14.6 ms) is outside this list and waits for the user's call or a perf lane. The rollout stays
`'preview'`. WebGL2 Medium holds 85 fps or more everywhere.

**Never cut:** the engine limits fix; the Low guard; W9A-P (clock, weather, protocol, GM); `SkyState` and the modern
sky dome with clouds; PBR objects and terrain with derived defaults; CSM with proxies; SH + cube IBL; HDR + Neutral
tone map + bloom + grade; the rain box, shelter map and wet ground on both paths; the night splat and lamp emissive;
settings, first-run and the watchdog.

---

## 7. Wave 9B: the texture pipeline

### 7.0 Entry criteria and step order

- **Entry:** 9A integrated (the loader `pbr/maps.ts` and the terrain arrays exist) — so every batch can be judged **in
  the game**, dry and in rain, not only on review sheets. TP-0 already ran in 9A step 0.
- **Steps:** step 1 = TP-U, TP-P, TX-R in parallel (disjoint files) → TP-E → batch **B0** (test set) → user go/no-go →
  **B1** hero → **B2** town → **B3** fields → **B4** actors. TP-K and the DT lanes start only on the user's approval
  (§8).
- All processing is local on the dev PC (Real-ESRGAN ncnn-vulkan is already installed and approved). **No retail file
  is sent to any external service** (D43). Nothing under `work/out/pbr/` is committed; only code, tests and
  `content/texpipe/*.json` are.

### 7.1 Lanes

| Lane | Owns | Hook points | Tests | User-visible check |
|---|---|---|---|---|
| **TP-U** upscale runner | `packages/texpipe/src/upscale/{runner, pad, alpha, mix, cache}.ts` | `work/tools/realesrgan/realesrgan-ncnn-vulkan.exe` (config key `texpipe.realesrgan` in the `sro.config` example: the lead edits it); x4plus for natural surfaces (10.1 s/Mpx), x4plus-anime only for hair and flat paint (3.4 s/Mpx); **per-axis** wrap padding (never run in the prototype); alpha bleed + Lanczos alpha + coverage-preserving mips; the AI/Lanczos mix; SHA-1 cache in `work/texpipe/cache/up/` | TEXPIPE TP-U list (pad/crop round trip with a stub upscaler, seam ratio ≤ 1.2 on wrap axes; per-axis rule; alpha bleed; coverage ±2% per mip; a real 2-texture run skips without the exe) | `pnpm texpipe run --set test` rebuilds the comparison sheets in ~2 min |
| **TP-P** PBR derivation | `packages/texpipe/src/pbr/{image, delight, height, normal, ormh, islands, preview, params}.ts`, a `worker_threads` pool | TEXPIPE §3.5–3.7 formulas; class parameters from `pbr/classes.ts` + `params.ts`; overrides from `content/texpipe/overrides.json`; output ORMH (D37) | TEXPIPE TP-P list (paraboloid normals within 1°; tileable in → tileable out; specmask → metallic, with the corrected specmask rule (the Copper Sword's equipment reason); cutout height 0 outside; island dilation; de-light k = 0 is the identity) | the review page's lit and wet previews |
| **TP-E** encode, index, review | `packages/texpipe/src/{encode, index-writer, review}.ts` (no `remaster-view.ts`, D35) | v1 WebP: albedo q90, normal as two grey planes, AO/rough/metal at half size, height full; tiers retail/1024/2048 ≤ master; `status`, `hero`, `bytes`; writes `work/out/pbr/**` and `index.json` | index validation; every file exists; tier sizes; planes rebuild unit normals within 0.02; q90 < 2° mean error excluding sources ≤ 64 px | `work/texpipe/review/index.html`; mark statuses |
| **TX-R** runtime tiers | `pbr/maps.ts` tier/plane additions (sequential ownership after RND-M), a decode worker (`packages/world-render/src/pbr/decode-worker.ts`: `createImageBitmap` with `premultiplyAlpha: 'none'`, `colorSpaceConversion: 'none'`; plane packing to normal RGBA8 and ORMH; mip levels precomputed, D42), `textures.ts` (`uploadTextureLayer(…, levels?)`), `tile-atlas.ts` (tier arrays, 48-layer cap + 512 overflow array flagged in the layer map), `apps/game/src/settings.ts` + `hud/options.ts` (`graphics.textures: 'auto' \| 'retail' \| 'remaster' \| 1024 \| 2048`, "applies after reload"); retires the `graphics.remaster` test switch (kept as an alias for one wave) | `QualitySettings.render.textures`; the progressive swap at the lowest streaming priority; dispose the embedded retail texture after a swap; one upload job per map inside the per-frame budget | tier choice per preset; a missing set keeps retail; the swap disposes the retail texture; worker mips equal the CPU `downsample` output; no job over 5 ms at 1024 on the dev PC | the plaza, the wall, trees and the character screen swap to the remastered look a moment after load, never blocking play |
| **TP-K** KTX2 (gated) | `packages/texpipe/src/ktx2.ts`, `packages/world-render/src/ktx2.ts` (`KhronosTextureContainer2.URLConfig` → vendored `out-opt/_decoders/ktx2/*`, **every** entry set), `packages/world-render/src/texture-compressed.ts` (BC7 array layers per level: WebGL2 `compressedTexSubImage3D`, WebGPU per-level upload; Babylon's `updateRawTexture2DArray` cannot name BPTC on WebGL2), `packages/convert/src/tools/vendor-ktx2.ts` | `tile-atlas.ts` `format` option (TX-R wires it); `engine.ts` already requests `texture-compression-bc` (D10) | encoder round trip (skips without the encoder); no `babylonjs.com` URL in `URLConfig`; NullEngine loader path; BC7 used only when `caps.bptc` | Ultra becomes selectable; no request to `babylonjs.com`; VRAM ~4× lower at the same tier |

### 7.2 Batches (data runs; each ends with a review and in-game screenshots)

| Batch | Content | Size | Time on the dev PC | Gate |
|---|---|---|---|---|
| **B0** test set | TEXPIPE §7.1: plaza paving (+ the second paving tile), two grass tiles, a dirt and a rock tile, the city wall, the palace roof, a trunk, a leaf card, the starter chest, the male body/face atlas and hair, the Copper Sword (14) | a few Mpx | minutes | Screenshots at the four spots (plaza, south gate and wall, a tree cluster, character creation), **dry and in rain**, before/after. **User go/no-go** on the look and on the hero-set approach. |
| **B1** hero | the 16 hero terrain tiles (78% of town terrain, 72% of the fields) + ~120 hero textures (walls, roofs, paving, the 5 tree species, plaza) with full maps | ~20 Mpx source | < 30 min GPU + review ~6 h | review sheets; in-game spots; VRAM on High within §5.2 |
| **B2** town | the 339 town textures (16.6 Mpx) + the 46 tiles of the town window | 16.6 Mpx | ~5 min upscale + PBR | spot-check; first-entry download +60–90 MB on High (measure) |
| **B3** fields | the rest of the 788 world textures and 104 tiles | 91.4 Mpx total with actors | full run under an hour (AI ~20 min + PBR 4–5 min on 6 workers; encoding [unknown]) | spot-check; per-zone screenshots |
| **B4** actors | the 321 actor textures as the local baseline, A/B against the approved Meshy parts (REMASTER.md); DETAIL L3 masks + L5 subdivision if approved | 22.7 Mpx | ~1 working day for the starter batch (DETAIL §5.2) | the user picks per part: local, Meshy, or retail |
| **B-sky** (optional) | moons ×2, lens sprites, `cloud1` (D44) | tiny | minutes | viewer at night |

### 7.3 Optional DETAIL lanes (each needs the user's go)

- **DT-4 `SroDetailPlugin`** (DETAIL H1/H2): a per-texture class mask and a shared 2D array of six 512² detail tiles
  (1.7 MB once) sampled at UV0 × tiling with a distance fade; `PbrSet` gains `classMask` and `detail` (optional
  fields, version stays 1). Runtime lane in world-render; ≈ 0.05–0.15 ms GPU on the dev GPU [likely]. No download.
- **DT-5 subdivision L1 + LOD** for actor glbs (Blender headless, already installed per DETAIL; UV-safe gates
  measured). Geometry, not texture: its own go/no-go.
- **DT-2 local diffusion detail** (SDXL + ControlNet-Tile via ComfyUI on the installed ROCm torch): **needs ≈ 10.3 GB
  of downloads** (DETAIL §6). Only after the user approves; the alternative is Meshy Retexture within the credit cap.

### 7.4 I9B: integration checklist

1. Merge TP-U, TP-P, TX-R, then TP-E; suite + typecheck.
2. Run B0; the user reviews; record the decision in `work/tmp/w9-user-decisions.md` (the user's file: read, append
   only what the user says).
3. Per batch: `optimize-out` copies `pbr/` unchanged (no optimizer change: `.webp`/`.ktx2` are outside its
   allow-lists [confirmed]); `static.ts` already serves `.ktx2` and `.webp` [confirmed]; measure the first-entry
   download on High and the VRAM in the perf overlay.
4. DEPLOY.md: the size of the `pbr/` tree on the mini PC (≈ 0.2–0.3 GB for actors per DETAIL, plus world sets), and the
   host's upload bandwidth once the user gives it.
5. Delete `work/tmp/texpipe/` (~690 MB) and `work/tmp/texpipe-fc/` once TP-P has ported the prototype.

### 7.5 H9B: adversarial-hunt lenses

1. **UV integrity:** any texture whose layout moved (size check, island borders, the uvsafe gate for L2 results).
2. **Seams:** wrap axes wrong (a seam ratio above the source's own), neighbouring tiles that hallucinate differently.
3. **Alpha:** cutout foliage and hair thinning at distance (coverage-preserving mips on WebP need alpha-to-coverage,
   which is engine-global and MSAA-only [TEXPIPE verify]).
4. **Key collisions and drift:** two textures mapping to one key; an `sro-remaster` entry silently shadowing a newer
   `sro-pbr` set; a stale cache after an override edit.
5. **Retail leaving the PC:** any code path that could send a retail file to a web service (the Higgsfield
   `upscale_image` connector, Meshy beyond the approved list); licences of optional models never vendored.
6. **CDN requests:** KTX2 `URLConfig` defaults (the wasm entries default to Babylon's CDN when null).
7. **Budgets:** VRAM on High past 1 GB, a 2048 upload job > 5 ms, first-entry download past the estimate, embedded
   retail textures left resident after a swap.
8. **Painted light:** de-lighting artefacts doubling with SSAO and the derived AO.

### 7.6 Scope-cut order (wave 9B)

1. DT-2 local diffusion; generative replacements (Higgsfield prompts).
2. DeepBump / PBRify A/B.
3. Ultra (TP-K) — only when the encoder is approved.
4. B4 actors beyond the starter batch (Meshy covers the approved parts).
5. B3 fields beyond the town window.
6. Medium remaster (Medium stays on retail textures with class defaults).

**Never cut:** TP-0/TP-U/TP-P/TP-E, TX-R, and B0 → B1 → B2 (the user's "test first, then the rest" path).

---

## 8. What the user must provide or approve

**To start wave 9A: nothing.** Everything in 9A uses `@babylonjs/core` 9.28.0 and tools already installed; no
package, no download.

**Decisions with defaults** (answer any time; the lab shows the choices side by side):

1. **Default look:** Classic stays as Low (proposed); tone mapping **PBR Neutral** (faithful hand-painted colours,
   default) or **ACES "Filmic"** (punchier). And: players saved on Medium move to the PBR look on update — OK?
2. **Time of day:** day length 120 real minutes; about 37 dark minutes per game day; fixed season (+12°) or slowly
   changing; moon size (2.2°, ~4× real); moon cycle 29.53 game days (~2.5 real days) or shorter; HUD clock on.
3. **Weather:** how often it rains (`WEATHER_RAIN_SCALE` 1 ≈ 10% rain + 1% storm); storms and fog on; weather stays
   purely cosmetic (proposed).
4. **Which GPUs/PCs the friends play on** (integrated laptop, gaming laptop, desktop, a mini PC). The first-run
   defaults and the laptop numbers are projections until one weak machine runs the lab's bench button and a storm
   with the perf overlay on.
5. **Optional:** reference screenshots (a golden-hour town, a rainy street) for the grade; retail screenshots of
   Jangan at dusk and night; CC0 rain/thunder/wind recordings to replace the 2.3 s retail rain loop (put in
   `content/sound/` under the same cue names).

**Approvals for wave 9B** (nothing is downloaded until the user says yes; sizes and licences are rechecked at download
time):

6. **KTX2 tooling** (needed for Ultra, for full PBR sets on High on low-VRAM GPUs, and for full character sets):
   `basisu` (github.com/BinomialLLC/basis_universal, Apache-2.0, ~5–10 MB) **or** `toktx` (KTX-Software, Apache-2.0,
   ~15–25 MB), plus a one-time fetch of Babylon's KTX2 transcoder files (`babylonjs-ktx2decoder` and its wasm,
   Apache-2.0 + zstddec MIT, ~1–3 MB) vendored under `out-opt/_decoders/ktx2/`. Without it: High caps textures at
   1024 with maps on the hero set only, and Ultra uses High's textures.
7. **Optional upscaler models** (A/B against x4plus, run in the installed exe): 4x-UltraSharp and 4x-Remacri ncnn
   (~33 MB each, CC BY-NC-SA 4.0: fine for a private project, never vendored).
8. **Optional ML map models:** `pip install onnxruntime-directml` (MIT, ~20–25 MB) for DeepBump (GPL-3.0, offline tool
   only) and **PBRify_Remix v1.7.2** (CC0-1.0 per DETAIL §6, 111 MB; DETAIL recommends it for 2000s game textures).
9. **Optional local diffusion detail** (DETAIL §6 items 1–7, ≈ 10.3 GB: ComfyUI, SDXL base, ControlNet-Tile, the
   fp16 VAE, PBRify) — or Meshy Retexture only for the starter batch (~430 credits), or skip L2.
10. **Hero-set go/no-go** after B0, and whether **Medium** ships the retail-size remaster (+15–25 MB on first entry)
    or stays on retail textures.
11. **The mini PC's upload speed** (Mbit/s): it decides how heavy High's first visit (+60–90 MB) may be for friends.

**What Higgsfield and Meshy can do here (the user asked "just tell me")**:

- **Meshy, new geometry — the biggest remaining step toward "AAA".** About 30 key Jangan assets (RENDER §13): the
  city walls, gates and towers (5–8 models), the 10 most-placed houses and roofs, 5 tree species with 2–3 LODs, then
  characters last. **Input must be new text prompts or the user's own concept images**, never a retail model or
  texture. The renderer takes new glbs with PBR materials without changes. Per asset we would need: the prompt or
  concept image, the target triangle budget (2–10 k for houses), and the plan the output was made on (for its
  licence).
- **Meshy Retexture:** already approved for the named test parts within the 150-credit cap (REMASTER.md). Any further
  retail part needs a new, explicit approval.
- **Higgsfield (images):** prompt-generated **original seamless materials** for tileable surfaces only (proposed
  first: the city-wall brick and the plaza marble at 2K), colour-matched to retail by our pipeline. Only prompts go
  out. Never use its `upscale_image` on a retail texture: that would upload it.
- **Heightfield/terrain:** the terrain height grid stays retail (2 m cells) in this wave; new terrain geometry would
  be a separate spec.

---

## 9. Risks

- **CPU is the bottleneck.** Babylon draw submission dominates; High adds ~2.2 ms of JS on the dev PC and ~3.3 ms on a
  mid desktop CPU. Mitigation: shadow proxies, fixed light counts, no per-frame allocation, LAB's CPU column, the
  watchdog. WebGPU snapshot rendering (render bundles) is an [unknown] later lever.
- **Players' adapters granting only 16 inter-stage variables** get at most Medium (§5.1); the lens in H9A proves no
  black frame.
- **Calibration decides the look** more than any single feature (sun : ambient, exposure, lightmap floors, grade);
  the first bench try washed shadows out. Owned by RND-L + RND-P, reviewed in LAB, taste calls by the user.
- **Baked shadows vs a moving sun** (D16): the floor-0.35 rule is our rule; the real bake direction is [unknown]
  until RND-L measures it.
- **Painted-in lighting** in retail albedo fights PBR lighting until 9B de-lights it (`delit` false → direct light ×
  0.8 as a stopgap).
- **Unmeasured:** SSR marching, TAA reprojection, the cluster tile mask, `ShadowDepthWrapper`, `ClusteredLightContainer`
  on WebGL2, the regex AO injection, `CUSTOM_FRAGMENT_UPDATE_ALPHA` for normals, the SSR mask hook, the PBR fog hook
  (D18). Each is on a lane's first-compile list; every GPU number off the dev PC is projected.
- **Merge risk** is concentrated in W9A-S (one agent rewrites the shared shader strings and `World`). Mitigation: the
  HEAD-golden snapshot test, and no other lane touching those files.
- **Weather on integrated GPUs** is over its 1.0 ms budget at Medium (1.3–2.8 ms projected): `auto` maps iGPU to
  `low`; the playtest decides.
- **VRAM in 9B** without KTX2 (High 0.7–1.0 GB) and **download** for friends (unknown upload bandwidth).
- **AI hallucination and de-lighting artefacts** in 9B: human review per batch, the `retail` status, the AI/Lanczos
  mix.
- **Legal:** retail art stays on the user's PCs; only prompts go to external services; optional models with
  non-commercial or GPL licences are offline tools and never enter the repo.

## 10. Open questions (each has a default, so nobody waits)

| # | Question | Default |
|---|---|---|
| Q1 | Neutral or ACES tone mapping | Neutral (user decides after the lab) |
| Q2 | CPU-blurred cube mips or `HDRFiltering.prefilter` | CPU blur; LAB A/B |
| Q3 | The real retail bake direction | (1, 1, 0) until RND-L measures |
| Q4 | Night cluster sizes on High/Ultra | 32 / 64; cut to 16 / 32 if the tile mask is over budget |
| Q5 | TAA reprojection cost and ghosting | on; MSAA ×4 fallback on High |
| Q6 | Does `!regex` directional fog reach PBR characters | scalar `scene.fogColor` fallback (only matters on the Classic path now, D18) |
| Q7 | Skinned trees look windy or fast-forwarded at `speedRatio` 2.2 | cap at 1.5 if it looks fast-forwarded |
| Q8 | Thunder file mapping (near/mid/far) | lightning1/2/3, reassign by ear |
| Q9 | Moon cycle length | 29.53 game days |
| Q10 | Tile stems unique across the 104 tiles | TP-0 test; fallback to the full path |
| Q11 | The 48-layer cap at 1024 on High | 48, with a 512 overflow array |
| Q12 | Medium texture tier | retail (with class defaults) until the user says otherwise |
| Q13 | Whether snapshot rendering (render bundles) is worth a lane | not in 9A; LAB reports whether it would help |
| Q14 | A foliage texture array for one foliage shadow proxy per region | not in 9A/9B; revisit if foliage casters exceed the CSM budget |

## 11. Housekeeping

- Scratch the lanes port from stays until the port lands (§6.18 item 10, §7.4 item 5): `work/tmp/render/` (bench,
  terrain plugin, `proxy3`), `work/tmp/sky/`, `work/tmp/weather/`, `work/tmp/texpipe/` (~690 MB),
  `work/tmp/texpipe-fc/`, `work/tmp/detail/` (~910 MB, until DT lanes are decided).
  **Done in I9A (2026-09-29):** `work/tmp/render/`, `work/tmp/sky/` and `work/tmp/weather/` are deleted (nothing imported
  them; the ports name them in comments only). The texpipe and detail scratch stays with the 9B lanes.
- DETAIL.md mentions a stray `C:\renders\test_L0_full_clay.png` from another lane; the lead checks and deletes it.
- No lane commits; the lead integrates each step as in waves 7B and 8.
