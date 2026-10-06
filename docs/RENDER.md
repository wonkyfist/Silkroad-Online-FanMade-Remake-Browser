# Modern rendering spec: PBR, lighting, post-processing, quality presets

This spec moves the world from the 2005 fixed-function look (unlit, lightmapped retail materials, linear fog, a
vertex-coloured sky dome) to a physically based HDR renderer in Babylon.js 9.28 on WebGPU, with WebGL2 as the fallback.
It covers:

- the material system: PBR map sets when the texture pipeline provides them, derived defaults when it does not, and
  where the retail lightmaps keep their value (§3);
- lighting: sun and moon, sky ambient and reflections, cascaded shadows, night lights (§4);
- post-processing (§5);
- terrain, water and foliage (§6 to §8);
- the renderer's side of rain and wetness (§9);
- quality presets and measured budgets (§10, §11).

It is a spec, not code. The build plan (§14) splits the work into lanes with owned files.

**Out of scope here**, and owned by sibling specs:

- the texture upscaling and PBR-map production pipeline (the texture lane; §3.2 is only the runtime contract);
- the sky model, clouds, rain particles and the server's time and weather state (the sky/weather lane). This spec
  defines what the renderer consumes from them (§4.1, §9.1), not how they are made.

## Status tags

- **[confirmed]**: checked in this repo, in `node_modules/@babylonjs/core` 9.28.0, or measured by the prototype
  (`work/tmp/render/bench.ts`, §11).
- **[likely]**: the Babylon source or docs say so, but nothing here exercised it.
- **[unknown]**: needs a measurement or a decision.
- **[projected]**: a number scaled from a measurement, not measured on that hardware.

---

## 0. Decisions (TL;DR)

| Topic | Decision | Status |
|---|---|---|
| What "AAA" can mean here | Modern lighting, PBR materials and post-processing on the **original low-poly geometry** give a strong remaster, in the class of a well-lit 2015–2018 MMO. It does not reach 2024 AAA: silhouettes stay as they are. Jangan's 131 building models have a median of 230 triangles (p90 1,238, max 2,680), its 57 nature models a median of 72 [confirmed: sidecar `meshes[].triangles` in `work/out-opt/world/jangan/models`], and characters keep their 43-bone rigs. Reaching true AAA also needs new geometry (§1). | our assessment |
| Shading model | Metallic-roughness PBR through Babylon's **`PBRMaterial`** for everything lit: objects, characters, terrain and water. Custom behaviour goes in **`MaterialPluginBase` plugins** with WGSL and GLSL code, not in new hand-written `ShaderMaterial`s. Plugins get shadows, IBL, clustered lights, fog, the prepass (SSAO/SSR) and image processing for free. | hook points [confirmed] by the prototype on WebGPU (§3.5) |
| Classic look | The retail pipeline stays as the **Low** preset ("Classic"), unchanged: today's `ShaderMaterial` terrain, `StandardMaterial` objects and vertex-colour sky. | [confirmed] as today's code |
| Map sets | The existing `sro-remaster` manifest (`apps/game/src/three/remaster.ts`, characters, in flight) is extended to world objects, terrain tiles and water, with optional `occlusion`, `height`, `class`, `delit`, `sizes` fields (§3.2). | [confirmed] the format exists |
| Colour pipeline | Linear HDR. Albedo is sRGB-decoded (`useSRGBBuffers: true` on the PBR path). The frame goes to a half-float target; tone mapping and grading happen once, in post. | [confirmed] APIs |
| Tone mapping | **KHR PBR Neutral** by default: it keeps the hand-painted retail hues. ACES is an option ("Filmic"). AgX is not in Babylon 9 core; it is a later custom post-process. | [confirmed] `TONEMAPPING_KHR_PBR_NEUTRAL`, `TONEMAPPING_ACES` |
| Grading | One 32³ 3D LUT, blended on the CPU from per-time-of-day and per-weather keys into a `RawTexture3D`, plus white-balance temperature. Exposure follows a deterministic day/weather curve; no auto-exposure. | [confirmed] APIs |
| Retail lightmaps | They become **baked sun visibility**, not a colour multiply. The terrain `.t` lightmap is cast-shadow data (TERRAIN.md §3.1: 1.0 in sun, a floor of about 0.61 in shadow), so `vis = saturate((lm − 0.61) / 0.39)` scales the **sun** term only. Inside the shadow-map range the cascaded shadow map replaces it; beyond that it is the only sun shadow. Object lightmaps do the same, plus a small AO share (§3.4). | terrain mapping [confirmed] in the prototype; the object lightmap meaning [unknown] |
| Sun shadows | `CascadedShadowGenerator` on one celestial `DirectionalLight` driven by `SkyState.keyLight` (sun by day, moon by night). 1024 × 2 cascades to 60 m on Medium, 2048 × 3 to 150 m on High, 2048 × 4 to 250 m on Ultra. PCF. Alpha-tested foliage casts. | [confirmed] API; cost in §11 |
| Ambient | Irradiance as spherical harmonics from the sky lane's `SkyState` (docs/SKY.md §6.1). Specular IBL from a **CPU-built 64² `RawCubeTexture`** updated in place when the sun moves 0.5° or the weather changes — not a `ReflectionProbe`, which measured ~570 ms per refresh with 2,030 PBR materials. | [confirmed] measured |
| Night lights | Babylon 9's **`ClusteredLightContainer`**: up to 32 lantern and fire point lights plus the hit flashes, taking one light slot. | [likely]: the class exists in 9.28; not yet exercised |
| Post stack | `DefaultRenderingPipeline` (HDR, bloom, image processing, FXAA on Medium), `SSAO2RenderingPipeline` (half resolution), `SSRRenderingPipeline` (wet ground only, Ultra and rain on High), `TAARenderingPipeline` (High and Ultra; its defaults switch it off while the camera moves, so reprojection is needed, §5.6), `FSR1RenderingPipeline` for render scales below 1. Depth of field stays off. | [confirmed] all have WGSL shaders |
| Fog | Exponential **height fog** in a global material plugin, replacing linear depth fog on the PBR path. Its colour comes from the sky's horizon. Light shafts: shadow-map shafts (mini-wave w12r GODRAYS, `render/volumetrics/`), Medium low, High and Ultra high. | [confirmed] the hook exists |
| Terrain | `PBRMaterial` + `SroTerrainPlugin`. It keeps the native layer-map splat of TERRAIN.md §2.3 and adds per-layer normal, roughness and height from texture arrays, height-blended transitions, triplanar sampling on steep cells, a near-camera detail layer, puddles and wetness. Parallax only on Ultra. | splat + lightmap + roughness hooks [confirmed] in the prototype |
| Water | `PBRMaterial` (alpha blend) + `SroWaterPlugin`: two scrolling normal maps, Fresnel against the sky cube, a depth-based shore fade and rain ripples. The retail frames stay as a tint layer. No planar reflection below Ultra. | [likely] |
| Foliage | `SroFoliagePlugin` on alpha-tested PBR: wind sway in the vertex stage (also in the shadow pass, via `ShadowDepthWrapper`), and a cheap back-lit translucency term. Grass scatter keeps its `ShaderMaterial` and gains N·L, SH ambient, translucency and wetness. | [likely] |
| Rain response | The renderer takes `wetness`, `puddles` and `rain` (0..1) from the weather state. Every PBR plugin darkens porous albedo, lowers roughness, flattens normals and adds ripples in puddles. A top-down **rain occlusion map** keeps surfaces under roofs dry. | [likely]; §9 |
| Presets | Low (Classic), Medium, High, Ultra. Default: **High** on WebGPU with a discrete GPU, **Medium** on WebGPU with an integrated GPU, **Low** on WebGL2. §10. | our rule |
| Frame budget | Measured on the dev PC (Ryzen 5 9600X, RX 9060 XT) with the real Jangan export at 1080p: Classic 1.4 ms, **Medium 2.7 ms, High 3.5 ms, Ultra 5.1 ms** of renderer frame time, all **CPU-bound**; GPU cost (from 8K runs ÷ 16) 0.7 / 0.9 / 1.3 / 2.8 ms. The CPU, i.e. Babylon draw submission, is the budget to guard: naive cascaded shadows cost +43 ms until casters were merged into per-region shadow proxies (+0.75 ms). | [confirmed] measured §11 |

---

## 1. What reaches "AAA", honestly

| Layer | What this spec delivers | What stays 2005 | What it would take |
|---|---|---|---|
| Lighting | Moving sun and moon, soft cascaded shadows, sky-driven ambient and reflections, AO, bloom, height fog, light shafts, lanterns at night. **The biggest visible jump.** | — | — |
| Materials | PBR response (roughness, normal detail, wetness) on 2–4× textures from the texture pipeline | The painted-in lighting of the retail textures. Upscaling cannot remove the baked highlights and shadows that 2005 artists painted into albedo; the texture pipeline must de-light them, or they fight the new lights. | De-lighting in the texture pipeline (§3.2 `delit` flag) |
| Geometry | Normal maps fake small detail; parallax on Ultra terrain | Silhouettes: 8-sided columns, flat roofs, box-shaped walls, 4–8-card trees, faceted characters | New meshes (Meshy or hand-made) per asset class. Priorities are in §13. |
| Vegetation | Wind, translucency, shadows, denser grass | Card trees with hard alpha edges | New tree models with LODs, or SpeedTree-class assets |
| Animation | unchanged | 2005 mocap and keyframes | out of scope |

Buildings and trees are what the player looks at most. After lighting, **new geometry for about 30 key Jangan assets**
(walls, gates, the 10 most-placed houses, 5 tree species) buys more "AAA" than any further shader work (§13).

---

## 2. Today [confirmed, read in the code]

| Part | File / function | What it does |
|---|---|---|
| Engine | `apps/game/src/engine.ts` `createEngine` | WebGPU (`antialias: true`) or a WebGL2 fallback, `adaptToDeviceRatio`; which one: `gpu-loss.ts` `engineChoice` (Options → Graphics mode, the tab fallback after a lost device or black output: apps/game/README.md "Graphics problems") |
| Scene and lights | `apps/game/src/screens/world.ts` `buildWorldScene` | `HemisphericLight` 0.7 plus `DirectionalLight` 1.2 for characters; `World.isolateLights` keeps them off world objects |
| World sun | `packages/world-render/src/world.ts` `World` constructor, `applyEnv` | `DirectionalLight` fixed at (−1, −1, 0), diffuse = Diffuse(t) × 0.6; `scene.ambientColor` = ObjectAmbient(t); linear scene fog |
| Environment | `packages/world-render/src/environment.ts` `evaluateProfile`, `approachEnv` | the 16 environment.ifo tracks per profile, sampled at t |
| Terrain | `terrain.ts` `TerrainRenderer.buildRegion`; `shaders.ts` `terrainFragmentWGSL/GLSL` | `ShaderMaterial`, unlit: layer-map splat (8 layers), × saturate(lightmap + shadowColor), linear fog. **No normals** in the vertex data. |
| Objects | `materials.ts` `ObjectMaterials.fromPbr` | Replaces the glTF loader's `PBRMaterial` with `StandardMaterial`: MODULATE2X, object lightmap as a shadow map (`useLightmapAsShadowmap`), specular off |
| glTF load | `objects.ts` `loadGlb` | `useSRGBBuffers: false` (raw texture values for the gamma-space fixed-function look) |
| Characters | `apps/game/src/three/models.ts` `ModelLibrary.loadFrom` | glTF `PBRMaterial` as loaded (sRGB, metallic/roughness from the converter's defaults), lit by the hemisphere light and the character sun |
| Water | `water.ts` `WaterRenderer`; `shaders.ts` `water*` | `ShaderMaterial`: 30 animated 64² frames × WaterColor, depth alpha, alpha blend, fog |
| Sky | `sky.ts` `Sky.update` | CPU vertex colours on a 24-segment sphere, every 0.25 s; no sun disc, clouds or stars |
| Grass | `scatter.ts` `WorldScatter`, `scatter-assets.ts` `scatter*WGSL/GLSL` | `ShaderMaterial` thin instances: wind sway, distance shrink, root lightmap, alpha test, fog |
| Hit lights | `apps/game/src/world/fx/hit-light.ts` `HitLights` | 2 pooled `PointLight`s, characters only |
| Presets | `world.ts` `QUALITY_PRESETS` (low, medium, high); `apps/game/src/settings.ts` (preset, resolution, sight, scatter); `apps/game/src/hud/options.ts` rows `graphics.*` | Draw distance, animated objects, water, grass. Resolution uses hardware scaling (bilinear upscale). |
| Post-processing | none | — |

Everything custom is hand-written WGSL plus GLSL (TERRAIN.md §8: no GLSL may reach the WebGPU engine, or Babylon
downloads glslang/twgsl from its CDN). The prototype confirmed that **every Babylon feature used in this spec ships
WGSL** in 9.28 [confirmed: the `ShadersWGSL/` files exist for ssao2, screenSpaceReflection2, taa,
volumetricLightScattering, fsr1Upscale/fsr1Sharpen, the bloom and FXAA passes, shadowMap, geometry, hdrFiltering,
gpuUpdateParticles; and the bench's GLSL guard logged no GLSL reaching the WebGPU engine, §11].

---

## 3. Materials

### 3.1 One material path per preset

| Preset | Objects | Terrain | Water | Characters |
|---|---|---|---|---|
| Low (Classic) | today's `StandardMaterial` (`ObjectMaterials.fromPbr`) | today's `ShaderMaterial` | today's `ShaderMaterial` | glTF `PBRMaterial`, today's lights |
| Medium, High, Ultra | `PBRMaterial` + `SroSurfacePlugin` (wetness, baked visibility, height fog) | `PBRMaterial` + `SroTerrainPlugin` | `PBRMaterial` + `SroWaterPlugin` | glTF `PBRMaterial` + `SroSurfacePlugin` |

Switching between Low and the others rebuilds materials (a scene-wide recompile, about 1–3 s [unknown: not
measured]). The Options window applies it after a confirm, like a resolution change. Medium ↔ High ↔ Ultra only
toggle defines and post passes, so they apply without a reload; but every define change (the prepass for SSAO/SSR,
CSM on/off, the plugin feature defines) recompiles the shared PBR effects, so expect a one-time hitch per switch
[likely; not measured].

### 3.2 PBR map sets: the runtime contract with the texture pipeline

**A format already exists and this spec extends it rather than inventing a second one.** While this spec was being
written, another lane added a test switch for remastered character textures: `apps/game/src/three/remaster.ts`
(Options → Graphics → "Remastered textures (test)", `settings.ts` `graphics.remaster`, `?remaster=1`), created
2026-09-28 and still in flight [confirmed: the file exists; its behaviour is not reviewed here]. Its manifest is
`/out/remaster/manifest.json` (then `/out-opt/…`):

```jsonc
{ "format": "sro-remaster", "version": 1,
  "textures": {
    "<glb path without .glb>#<glTF image name = retail texture stem>": {
      "albedo": "…",              // sRGB, required
      "normal": "…",              // tangent space, linear; "normalGreen": "gl" (default) | "dx"
      "metallicRoughness": "…",   // glTF packing: G roughness, B metallic (linear)
      "metallic": "…", "roughness": "…",   // or separate greyscale maps
      "emissive": "…",            // sRGB
      "alpha": "original"         // cutout from the retail texture (default) | "albedo"
    } } }
```

RND-M generalises that module into `@sro/world-render` (`pbr/maps.ts`), so world objects, terrain, water and
characters share one loader, and adds these **optional** fields (version stays 1: old readers ignore them):

| Field | Meaning | Default |
|---|---|---|
| key form `world/<world>/tile2d/<tile file stem>` | a terrain tile (tiles are not in glbs) | — |
| key form `<glb path>#<image>` for `world/**` glbs | world objects, exactly as for characters | — |
| `occlusion` | AO map (linear, R). May be the same file as `metallicRoughness` (R channel, glTF ORM packing). | none: 1, or the lightmap's AO share (§3.4) |
| `height` | height (linear, R) for terrain height blending and Ultra parallax | none: flat |
| `class` | one of the §3.3 classes | `classify(key)` |
| `delit` | the albedo had its painted lighting removed | `false` (the renderer lowers direct light to 0.8 for non-delit sets) |
| `uvScale` | tiles only: the new texture covers this many retail periods | 1 |
| `sizes` | the mip-level files written, e.g. `[512, 1024, 2048]`, as `<map>@1024.<ext>` beside the full file | only the full file |

Rules:

- The key joins the map set to the retail material. Characters already key on the glTF image name; world objects
  can use the same, because the converter names glTF images after the retail texture stem. The sidecar's
  `SidecarMaterial.texture` (`convert.ts`) is the fallback key when an image name is not unique inside a glb
  [confirmed field].
- **Resolution caps per preset:** Medium 1024, High 2048, Ultra full. The loader requests `<map>@<cap>.<ext>` when
  `sizes` lists it, else the full file.
- The albedo **replaces** the embedded glb texture by URL. The retail glb is not re-exported.
- **Open for the lead:** docs/TEXPIPE.md §6.2 proposes its own build index, `pbr/index.json` (`sro-pbr`, keys
  `tile2d:<id>`, per-tier files `<map>@<tier>.webp` with split planes in v1). `pbr/maps.ts` can read both; the
  proposal is that TEXPIPE's index is the build output for world objects and tiles, `sro-remaster` stays for
  hand-made or Meshy sets, and both parse into one runtime record (albedo, normal, orm, height, emissive, class,
  tiers). The lead picks one key form for tiles.
- `RemasterLighting` in `remaster.ts` (a sky probe re-captured every 30 s and a key-light boost) is superseded by §4.
  Its switch becomes the "Remastered textures" row of the PBR presets: on Low it stays off.

### 3.3 Material classes and derived defaults

When a set is missing, or lacks a map, the class supplies the value. The class comes from the manifest entry's `class` (§3.2), otherwise
from the first rule that matches the retail texture path, BMT name or tile2d type:

| Class | Match (case-insensitive, first wins) | Roughness | Metallic | Normal strength | Porosity (wet darkening) | Wet roughness | Translucency |
|---|---|---:|---:|---:|---:|---:|---:|
| water | tile type Water/DeepWater, `water` | 0.05 | 0 | — | 0 | 0.05 | 0 |
| metal | `metal`, `iron`, `bronze`, `gold`, `bell`, `sword`, `armor`, BMT flag env-map | 0.35 | 0.9 | 1 | 0 | 0.2 | 0 |
| roof_tile | `roof`, `giwa`, `tile_` (object textures) | 0.55 | 0 | 1 | 0.25 | 0.15 | 0 |
| stone | `stone`, `rock`, `marble`, `brick`, `wall`, `stair`, `pave`, `statue`, tile types Stone/Ashfield | 0.8 | 0 | 1 | 0.35 | 0.25 | 0 |
| wood | `wood`, `board`, `pillar`, `door`, `fence`, `bridge`, `boat`, tile type Wood | 0.7 | 0 | 0.8 | 0.5 | 0.3 | 0 |
| cloth | `cloth`, `flag`, `banner`, `tent`, `curtain`, `sign`, BSR with dyVertex | 0.85 | 0 | 0.6 | 0.6 | 0.5 | 0.25 |
| foliage | `tre_`, `leaf`, `bush`, `grass`, `flower`, `plant`, alpha-tested (`MASK`) in `nature/` | 0.6 | 0 | 0.6 | 0.3 | 0.25 | 0.6 |
| ground_soil | tile types Dirt/Mud/Sand, `dust`, `soil`, `road` | 0.9 | 0 | 1 | 0.6 | 0.2 | 0 |
| ground_grass | tile types Grass/LongGrass/Forest | 0.85 | 0 | 0.8 | 0.45 | 0.3 | 0 |
| skin | character body/face textures (`char/**` material names `*_face*`, `*_body*`, `*_hand*`) | 0.55 | 0 | 0.5 | 0.1 | 0.35 | 0.3 (Ultra: `subSurface.isTranslucencyEnabled`) |
| default | everything else | 0.75 | 0 | 1 | 0.4 | 0.3 | 0 |

Derived defaults when a map is missing [our rule]:

- **Roughness without an ORM map:** `class.roughness ± 0.1 × (0.5 − luma(albedo))`. Darker texels read slightly
  rougher, which breaks up flat specular on painted textures at no texture cost. This happens in `SroSurfacePlugin`
  (`CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS`).
- **AO without an ORM map:** 1, or the object lightmap's AO share (§3.4).
- **Normal without a normal map:** none. A runtime Sobel-from-albedo normal was considered and rejected: it turns
  painted shadows into fake bumps. That belongs in the texture pipeline, where a human can reject bad ones.
- **Metallic:** 0 unless the class says otherwise. The retail BMT `specular`/`power` fields
  (`SidecarMaterial.specular`, `.power`) are not used as a metallic hint: they are near-constant across Jangan
  [likely, by the TERRAIN.md §3.2 statistics of diffuse/ambient].
- **Emissive:** the glb emissive factor (`convert.ts` writes it) stays. At night (§4.5) materials of the class
  `cloth` whose name matches `lantern|lamp|light` get `emissiveIntensity` 0 → 1.5 through the plugin's night factor.

The class table lives in `packages/world-render/src/pbr/classes.ts`, a pure module with unit tests. An override file,
`content/render/material-overrides.json` (keyed by retail texture path), lets the user fix a misclassified texture
without code. It is optional and absent at first.

### 3.4 What the retail lightmaps become

| Lightmap | Content (TERRAIN.md) | Classic (Low) | PBR presets |
|---|---|---|---|
| Terrain `.t` (512², 3.75 units/texel) | Cast sun shadow: 1.0 lit, a floor of about 0.61 | × saturate(lm + shadowColor) (today) | `bakedVis = saturate((lm − 0.61) / 0.39)` scales the **sun's diffuse and specular only** (`CUSTOM_LIGHT0_COLOR`). Ambient and IBL are untouched, so baked shadows keep sky light and stop being flat grey. Inside the CSM range, `sunVis = mix(bakedVis, 1, csmFade(viewDepth))`: the real-time shadow takes over, and the two never double-darken. |
| Object lightmaps (TEXCOORD_1, 128–256 px, texel medians about 0.65–0.85, p95 0.9–1.0; TERRAIN.md §3.3) | Unknown combine (TERRAIN.md §3.3) | × lightmap (today, mode 1) | Split with the same remap: `bakedVis = saturate((lm − 0.55) / 0.4)` on the sun term beyond the CSM range, and `ao = mix(1, lm / p95, 0.5)` into the ambient occlusion (interiors and eaves keep a soft darkening). The 0.55 floor is [unknown]: calibrate it on the Jangan gate against a Classic screenshot. |
| `shadowGrid` 96×96 | Gates dynamic shadows | not drawn | Not drawn. It could gate character blob shadows on Low; not needed. |

Why keep them at all on High and Ultra, where the CSM exists: beyond 150–250 m the CSM ends, and from the default
orbit camera (up to 40 m out, fog end 250 m) most visible terrain is beyond cascade 2. The baked shadows are
correct for the retail sun direction (1, 1, 0) only (TERRAIN.md §3.2): 45° up, on the +X (east) side. That is
**not noon**. On today's `sky.ts` path (sun at (cos a, sin a, 0), a = (t − 0.25) × 2π) it is the sun at t = 0.375
(mid-morning). SKY.md's `sunDirection` adds declination and latitude, so it may never match exactly. With a moving sun,
`bakedVis` is faded out as the sun leaves the retail direction:

`bakedWeight = saturate(dot(sunDir, normalize(1, 1, 0)_gltf) × 2 − 0.6)`, and `bakedVis' = mix(1, bakedVis, bakedWeight)`.

On the `sky.ts` path this gives weight 1 around t = 0.375, 0.81 at noon, and **0 from t ≈ 0.625**. So every afternoon
and dusk, distant terrain (beyond the CSM range) has no sun shadow at all, not only at dawn and dusk. The rule is
asymmetric. It needs a review in the lab at t = 0.3, 0.5, 0.6 and 0.7 [our rule; the numbers are computed from the
formula, not viewed].

### 3.5 Plugin hook points

`MaterialPluginBase.getCustomCode(shaderType, shaderLanguage)` returns WGSL or GLSL per language. Babylon injects the
code after the includes are expanded (`MaterialPluginManager._injectCustomCode`, `materialPluginManager.pure.js`
lines 270–365), so the injection points inside `pbrBlock*` includes and the per-light `CUSTOM_LIGHT{X}_COLOR`
(expanded to `CUSTOM_LIGHT0_COLOR` and so on) are reachable. The prototype's terrain plugin used
`CUSTOM_FRAGMENT_DEFINITIONS`, `CUSTOM_FRAGMENT_MAIN_BEGIN`, `CUSTOM_FRAGMENT_UPDATE_ALBEDO`,
`CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS` and `CUSTOM_LIGHT0_COLOR`, and rendered the Jangan plaza correctly on
**WebGPU (WGSL) and WebGL2 (GLSL)** [confirmed: screenshots in the bench]. The other rows are [likely] (read in the
shader sources, not exercised). Names that start with `!` are regular-expression injection points.

| Point (fragment) | Where | Used for |
|---|---|---|
| `CUSTOM_FRAGMENT_DEFINITIONS` | module scope | textures, `var<private>` scratch values (WGSL), helper functions |
| `CUSTOM_FRAGMENT_MAIN_BEGIN` | first thing in `main`, uniform control flow | the terrain splat and every `dpdx`/`textureSampleGrad`; the results go to private vars |
| `CUSTOM_FRAGMENT_UPDATE_ALBEDO` | inside `albedoOpacityBlock`, after the albedo texture | `surfaceAlbedo = sroAlbedo` (terrain); wet darkening (all) |
| `CUSTOM_FRAGMENT_UPDATE_ALPHA` | in `main` after albedo, before the lights and geometry info | overriding `normalW` (terrain per-layer normals, puddle flattening, ripples) |
| `CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS` | inside `reflectivityBlock` | `metallicRoughness = vec2(m, r)` (class defaults, wetness) |
| `CUSTOM_LIGHT0_COLOR` | per-light loop, light 0 (the celestial light), before the light's shadow is computed | `diffuse0 = vec4f(diffuse0.rgb * sunVis, diffuse0.a);` (baked visibility). WGSL cannot assign to a swizzle, so `diffuse0.rgb *= …` does not compile; the bench uses the form shown. `diffuse0` feeds both the diffuse and the specular term [confirmed: `lightFragment.js`]. Light 0 is the first light in the material's list (`scene.lights` order), so the celestial light must be created before any other light. |
| regex on the AO call | in `main` | object lightmap AO share [likely]. A `!`-regex point **replaces** the matched text (with `$n` substitution, `materialPluginManager.pure.js` lines 336–351). It does not append. Includes are expanded but `#ifdef`s are not yet evaluated at injection time. The pattern must therefore match the whole call, e.g. `!(aoOut=ambientOcclusionBlock\([^;]*\);)`, and re-emit it: `$1 aoOut.ambientOcclusionColor *= sroAO;`. The call has the same form in WGSL and GLSL. The simpler alternative is to multiply `finalIrradiance` at `CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION`. |
| `CUSTOM_FRAGMENT_BEFORE_FOG` | `pbrBlockFinalColorComposition` | height fog (§5.5) |
| `CUSTOM_VERTEX_UPDATE_POSITION` / `CUSTOM_VERTEX_UPDATE_WORLDPOS` (vertex) | vertex stage | foliage wind (§8) |

Rules the prototype taught:

- **Request the adapter's inter-stage variable limit.** WebGPU's default `maxInterStageShaderVariables` is 16. A
  `PBRMaterial` with CSM receiving + the prepass (SSAO) + a lightmap UV + two-sided lighting needs 17, and the
  pipeline is rejected: *"Total fragment input variables count (17 = 16 (user-defined) + 1 (front_facing) exceeds
  the maximum (16)"* — the frame went black [confirmed in the bench]. The dev adapter offers 28. `createEngine`
  (`apps/game/src/engine.ts`) must pass `deviceDescriptor.requiredLimits.maxInterStageShaderVariables =
  adapter.limits.maxInterStageShaderVariables`, which fixed it [confirmed]. On an adapter that only offers 16, the
  preset logic must drop the prepass (SSAO via `forceGeometryBuffer = true`, or SSAO off) [our rule]. Every plugin
  that adds a varying must count it against this limit. Simplest route: `new WebGPUEngine(canvas, { setMaximumLimits:
  true, deviceDescriptor: { requiredFeatures: [...] } })`. `setMaximumLimits` exists in 9.28 and copies every
  `adapter.limits` value, but it is ignored when `deviceDescriptor.requiredLimits` is set explicitly [confirmed:
  `webgpuEngine.pure.js` lines 431–450]. Babylon requests **no optional features** unless `enableAllFeatures` or an
  explicit `requiredFeatures` list is given. So `texture-compression-bc` (§12) and `float32-filterable` (§4.2) must be
  listed [confirmed, same lines].
- **Share samplers in WGSL.** `maxSamplersPerShaderStage` is 16 on the dev adapter; PBR, CSM and IBL already use
  several. WebGPU's default `maxSampledTexturesPerShaderStage` is also 16, so the texture count below matters on WebGPU
  as well, unless the adapter's higher limit is requested (`setMaximumLimits`). Plugin textures that are sampled with the same filtering declare no sampler of their own and reuse one
  (`textureSampleGrad(sroNormals, sroTilesSampler, …)`), as the layer map already does with `textureLoad`. WebGL2 has a
  hard 16 texture units per stage (combined samplers): the High terrain budget is PBR (environment, BRDF LUT) + CSM
  + tiles + normals + rmh + layer map + lightmap + detail + ripples ≈ 11–12. The `ClusteredLightContainer` adds 2
  (its light data and tile mask textures) and the rain occlusion map (§9.4) adds 1, so the total is **≈ 14–15 of 16**
  [likely: count per final define set].

- Terrain meshes need **normals** for PBR. `TerrainRenderer.buildRegion` writes no normal buffer today. Add a
  `normals` array from central differences of `terrain.heights`, using the neighbour region's edge row when it is
  loaded (heights are bit-identical at seams, TERRAIN.md §1.2, so the gradients match). Recompute a region's edge
  normals when a neighbour commits: 97 × 4 vertices, about 0.05 ms. Without neighbours, one-sided differences leave a
  faint seam [likely].
- The plugin reads region-local file units from `vPositionW` (`(x − originX, originZ − z) × 10`), so terrain needs no
  `uv` attribute on the PBR path.
- Plugin UBO uniforms are declared through `getUniforms().ubo`. WGSL reads them as `uniforms.x`; GLSL needs the
  `fragment` declaration string. Textures are bound with `uniformBuffer.setTexture` in `bindForSubMesh`.
- One plugin instance per material. Terrain has one `PBRMaterial` per region (like today's `ShaderMaterial` per
  region), so 21–45 terrain materials share one effect when their defines match [likely].

---

## 4. Lighting

### 4.1 The celestial light, from the time of day

One `DirectionalLight` named `celestial` replaces both the world sun and the game's character sun. **Its direction,
colour and intensity come from the sky lane's `SkyState.keyLight`** (docs/SKY.md §6.1: the sun, or the moon below
−4° with a crossfade, dimmed by clouds; `sunDirection(t, declDeg, latDeg)` is SKY.md §2's). This spec does not
define a second sun model; `render/lighting.ts` copies `SkyState` into the light, the SH and the sky cube every frame.

- The crossfade at the horizon (SKY.md) means the light never jumps, so the CSM never jumps either.
- **Intensity:** `SkyState.keyLight.intensity × k_render`, where `k_render` is this spec's calibration constant
  [unknown until RND-L tunes it]. Weather dimming arrives through `SkyState` (cloud cover) and `RenderWeather`.
- **The sun-to-sky ratio decides whether the image reads as sunlit.** The bench's first try (effective sun 1.3 =
  3 × the retail Diffuse(t) × 0.6, sky probe at `environmentIntensity` 1) gave a flat image with **invisible
  shadows**: the sky ambient was as strong as the sun. Effective sun 6.5 with `environmentIntensity` 0.2 gave crisp
  shadows of the statue and trees on the plaza [confirmed visually in the bench]. Target a clear-noon ratio of
  direct : ambient ≈ 5 : 1 on a horizontal surface, 1.5 : 1 overcast, 1 : 1 in rain; then set exposure so the plaza
  albedo lands near its Classic brightness.
- The retail fixed light (1, 1, 0) and its ×0.6 are Classic-only.
- The game's `HemisphericLight` and character `DirectionalLight` (`screens/world.ts` `buildWorldScene`) are **disabled
  on the PBR presets**. Characters get the same celestial light, IBL and shadows as the world, so they finally look
  like they stand in it. `World.isolateLights` becomes a no-op on PBR presets.

### 4.2 Sky ambient and reflections (IBL)

**Diffuse (irradiance):** `scene.environmentTexture.sphericalPolynomial = SphericalPolynomial.FromHarmonics(sh)`.
`FromHarmonics` takes an L2 `SphericalHarmonics` (9 coefficients) [confirmed signature]. `SkyState.sh` is L1
(4 × RGB, SKY.md §6.1), so the L2 terms are zero-padded. The SH is built from `SkyState.sh` (High+) or, when it is null, from `SkyState.ambient` (sky / horizon / ground, where the
ground bounce is already sky irradiance × albedo 0.25, SKY.md §6.1) projected to SH on the CPU. Ambient from below
is then warm, not sky-blue. Updated when `SkyState` moves (it eases over 1.5 s), a few µs per update [likely].

**Specular (radiance): a CPU-built cube, not a probe.** `SkyEnvironment` (`render/lighting.ts`) owns one
`RawCubeTexture(scene, faces, 64, TEXTUREFORMAT_RGBA, TEXTURETYPE_HALF_FLOAT, true /*mips*/)` that is
assigned to `scene.environmentTexture` **once**; later refreshes call `raw.update(...)` on the same object, so no
material sees a new environment texture. Use **half float**, not float. RGBA32F is not filterable on WebGPU
without the optional `float32-filterable` feature, which today's `createEngine` does not request. Babylon's caps then
report `textureFloatLinearFiltering = false` [confirmed: `webgpuEngine.pure.js` line 605], and the roughness mips
would be sampled without linear filtering. The bench's cube was RGBA32F with synthetic gradient faces, so its timing
holds but its image was not checked. The faces are converted with `ToHalfFloat` on the CPU.

- Faces are evaluated in a Worker, 64² × 6 texels, from the sky lane's CPU atmosphere (SKY.md §3) when it exports a
  radiance function, else from `SkyState.ambient` + `horizonRing` + a bright lobe at `keyLight.dir`; the cloud layer
  enters as its coverage-weighted colour. Roughness mips come
  from Babylon's mip generation plus `lodGenerationScale` tuning; if glossy reflections look too sharp, prefilter
  the 5 lower mips on the CPU with a cosine-power blur (they are 32² and smaller, so this is cheap) [our rule].
- Refresh when the sun moved by more than 0.5° (about every 2.8 s of the retail 2000-s day) or the weather changed by
  more than 0.05; upload one face per frame to spread the cost.
- **Measured:** re-uploading a 64² RGBA32F cube every 30 frames (faces built on the main thread) averaged
  **+0.42 ms per frame**, about 12 ms per refresh (§11.2) — against **~570 ms per refresh** for the
  `ReflectionProbe` route below.

**Why not a `ReflectionProbe`** (the obvious Babylon route, and what the in-flight `remaster.ts` test switch uses,
every 30 s): with 2,030 PBR materials sampling it and **only the sky dome in its render list**, the bench measured `refreshRate = 1` at **about 510 ms per
frame** and a refresh every 30 frames at +19 ms per frame, i.e. **~570 ms per refresh** (§11.2). The cause is
[unknown] (a likely suspect is Babylon re-deriving the environment's spherical polynomial and re-evaluating every
material whose environment texture changed). A probe stays an option only for rare, static captures (a box probe of
the plaza captured once at load), and RND-L must measure any such use.

**Local reflections:** the sky cube reflects sky everywhere, including under roofs. Specular occlusion keeps that
honest: `useRadianceOcclusion` and `useHorizonOcclusion` on, AO from ORM × SSAO. On High and Ultra, SSR (§5.4)
replaces the sky where the screen has the reflected surface. A per-area box probe for the Jangan plaza (a static
cube captured once at load, `probe.cubeTexture` with `boundingBoxSize`) is a later option [unknown value].

### 4.3 Cascaded shadow maps

`new CascadedShadowGenerator(size, celestial)`, settings per preset:

| | Medium | High | Ultra |
|---|---|---|---|
| Map size | 1024 | 2048 | 2048 |
| Cascades | 2 | 3 | 4 |
| `shadowMaxZ` | 60 m | 150 m | 250 m |
| `lambda` | 0.7 | 0.8 | 0.85 |
| Filter | PCF, `filteringQuality = ShadowGenerator.QUALITY_LOW` | PCF, `QUALITY_MEDIUM` | PCF, `QUALITY_HIGH` |
| `cascadeBlendPercentage` | 0.1 | 0.08 | 0.05 |
| Casters | per-region shadow proxies (opaque g2 statics), characters | + alpha-tested foliage chunks ≤ 60 m, + terrain | + g3 props in the proxies |
| Receivers | every PBR mesh | same | same |
| Refresh | every frame | every frame | every frame |

(`Constants.TEXTURE_FILTERING_QUALITY_*` are texture-sampling constants with different values, 8/16/…, and are not
the shadow generator's `filteringQuality` [confirmed: `shadowGenerator.d.ts`, `constants.d.ts`].)

Common settings: `stabilizeCascades = true` (no shimmer when the camera turns), `depthClamp = true` (the default,
emulated in the shader, so no WebGPU feature is needed [confirmed: `SM_DEPTHCLAMP` define]), `bias = 0.002`,
`normalBias = 0.02` (tune in the lab), and `autoCalcDepthBounds = false` (it needs a depth pre-pass).

**Casters are the whole cost, and it is CPU.** Babylon's render-target object renderer dispatches **every** enabled,
visible mesh of a shadow map's render list into **every** cascade, with no per-cascade frustum test
(`Rendering/objectRenderer.js`, the dispatch loop around line 750) [confirmed by reading]. The bench measured the
consequence (§11.2): with the object chunks as casters, 2048 × 3 cascades cost **+6.9 ms CPU per frame** for the 356
chunks within 150 m, 2048 × 4 cost +11.7 ms for 549 chunks within 250 m, and 1024 × 2 cost +0.9 ms for the 86
chunks within 60 m (every enabled mesh as a caster: +43 ms). The GPU side is small (the main pass grows from 0.46 to
0.64 ms).

The fix, also measured, is **shadow proxies**: bake every *opaque* static g2 instance of a region into **one
position-only mesh** and give only that mesh to the shadow generator. The bench's version (all opaque chunks within
60 m → 1 mesh of 14,246 triangles, built in 9 ms) brought 1024 × 2 down to **+0.35 ms CPU** with the 37 alpha-tested
tree chunks still as individual casters. With the spec's full rule (below) High's 2048 × 3 × 150 m costs
**+0.75 ms CPU** [confirmed], and the proxy casts the same statue and tree shadows on the plaza as the individual
chunks [confirmed visually]. Note what was measured. The bench built **one camera-centred proxy** from the chunks
within `shadowMaxZ` of the spawn (`bench.ts` `csm(…, 'proxy3')`: 198 chunks → 43 k triangles). It did not build the
per-region proxies specified below. Per-region proxies draw whole regions, so they carry more triangles into each
cascade, but they add the same few draw calls, so the CPU figure should hold [likely].

A second, complementary lever exists: `RenderTargetTexture.getCustomRenderList(passIndex, list, count)` is consulted
by the object renderer for every pass [confirmed: `objectRenderer.js` line 659]. A per-cascade filter there (test each
caster's bounding sphere against that cascade's `getCascadeMinExtents/MaxExtents`) would cut the foliage casters that
Babylon now draws into every cascade. **On by default since the W9A perf pass** (`WorldShadows.cascadeCulling`,
`setCascadeCulling(false)` is the LAB A/B): the pass index is the cascade [confirmed: `RenderTargetTexture`
`_renderToTarget` renders layer k as pass `faceIndex + layer`]. On the plaza at High every cascade drew all 159
casters; with the filter 43 / 70 / 89 (§11.5).

- New `packages/world-render/src/render/shadows.ts`:
  - `ShadowProxies.build(region, chunks)` runs once a region's static objects stopped changing for 0.5 s (a
    debounce on `WorldObjects.addStatic` notifications, so `region-chunk.ts` needs no change), as one job through
    `RegionStreamer.schedule` so it counts against the streaming frame budget (about 5–20 ms per region: split it per
    block if it hitches). It emits one `Mesh` per region
    with positions and indices only, one shared opaque material assigned (the shadow generator skips a sub-mesh
    whose `getMaterial()` is null unless the scene has a default material [confirmed: `shadowGenerator.js` line 911,
    `subMesh.pure.js` line 242]; the bench assigned a `StandardMaterial`), `layerMask = SHADOW_PROXY_LAYER` (0x20000000, outside the camera mask, so the
    main pass skips it; the shadow render list ignores layer masks unless `forceLayerMaskCheck`) [confirmed by
    reading `objectRenderer.js`], and `isPickable = false`.
  - `ShadowCasters.update(cameraPos)` (every 8 m of camera movement) sets the render list to the proxies of regions
    within `shadowMaxZ`, the alpha-tested foliage chunks within **60 m** (High and Ultra), the skinned clones within
    40 m that are larger than 1 m (trees, horses; not fish, chickens or flowers), and the characters (since the W9A
    perf pass: their shown parts within 50 m of the camera, `CHARACTER_CASTER_M`, re-selected every 500 ms while any
    are registered).
  - **Alpha-tested foliage cannot be merged cheaply.** Merging the 158 tree/bush chunks within 150 m per material
    still left 138 meshes (almost every Jangan plant model has its own material) [confirmed by the bench]. Beyond
    60 m, tree shadows on the ground come from the baked terrain lightmap, which already contains them (TERRAIN.md
    §3.1: it is cast-shadow data from the objects). A later option is a foliage texture array built by the texture
    lane (all leaf textures in one `RawTexture2DArray`, a layer index per vertex), which would make one foliage proxy
    per region possible.
- `WorldObjects.placeStatic` / `placeClone` / `removeRegion` (`objects.ts`) notify `ShadowCasters`; a region's proxy is
  disposed in its unload job.
- Proxy memory: positions only, 12 bytes per vertex; about 25 k vertices per 60 m of town, so a few MB for the whole
  resident window [confirmed order of magnitude by the bench].

**Alpha-tested shadows:** `PBRMaterial` with `transparencyMode = ALPHATEST` and an albedo alpha casts cut-out shadows
through the shadow generator's own alpha-test path [likely]. Trees whose leaves are alpha-*blended* (BMT
without 0x200, `alphaMode: 'BLEND'`) cast no shadow. The texture lane or the override file must mark them MASK.

**Terrain as caster:** only from High, where it matters for hills at a low sun. Casters render through the
shadow generator's own depth shader, so the splat plugin never runs in the shadow pass; only materials that move
vertices (foliage wind, §8.1) need a `ShadowDepthWrapper`.

### 4.4 Characters and moving things

Characters (`CharacterActor` meshes, mobs, NPCs, mounts, drops) are casters and receivers from Medium. Their glTF
`PBRMaterial`s receive by `mesh.receiveShadows = true`. Skinned casters re-render per cascade; 20 characters × 2–4
cascades is the main CPU cost of shadows in town [confirmed by the W9A profile: 141 of 210 casters in a crowd were
character parts]. Since the W9A perf pass they cast within 50 m only, into the cascades whose extents they touch
(§4.3).

**Actor culling (W9A perf pass, every path).** Actor meshes are `alwaysSelectAsActiveMesh` because their skinned
bounds do not follow the clips, so every actor was drawn in the main pass even behind the camera (73 of 320 active
meshes in the plaza crowd). `ModelLibrary` now tests each actor's generous bind-pose sphere (×1.5 + 1.5 m around the
root axis, `cullSphereOf`) against the frame's frustum just before Babylon's active-mesh evaluation; an actor wholly
outside is handed back to Babylon's own test, one inside stays always selected. Shadows are unaffected (the shadow
map draws its render list whether the casters are active or not).

### 4.5 Night lights

- **Sources:** the world's `ambient.json` emitters (EFFECTS.md §3.15: torch and brazier fires `map/frame.efp`, shop
  lamps) and placements of lantern models (`cj_*_light*`, TERRAIN.md §6.5). An emitter whose efp is a fire or lamp
  gets a warm point light: colour (1.0, 0.62, 0.3), range 8 m, intensity 3 × `night`. `night =
  smoothstep(0.30, 0.22, sunElevation01)`, so lights come on at dusk.
- **Container:** one `ClusteredLightContainer` holds up to 32 point lights, the 32 nearest to the camera, re-picked
  every 2 m of camera movement. Adding or removing a light inside the container does not change the material defines,
  so there are no recompiles [likely: the container is one `Light` in the material's light list]. The two
  `HitLights` (`fx/hit-light.ts`) move into the same container and drop their `excludeWithLayerMask`: hit flashes then
  light the ground too.
- **Budget:** Medium 8 lights, High 16, Ultra 32. No shadows from point lights.
- **Emissive:** lantern paper and windows glow through the emissive night factor (§3.3), and bloom picks them up.
- **Fallback:** if `ClusteredLightContainer.isSupported` is false, use 4 plain `PointLight`s (the nearest) with
  `maxSimultaneousLights = 6` on world materials. `isSupported` is false when `caps.texelFetch` is missing, on WebGL1,
  and on WebGL2 without float colour buffers plus float blending (`EXT_color_buffer_float` + `EXT_float_blend`). On
  WebGPU a batch holds 32 lights; on WebGL2 it holds `caps.shaderFloatPrecision` lights (fewer on mobile) [confirmed:
  `clusteredLightContainer.pure.js` `_GetEngineBatchSize`]. Lights with shadows or a non-default falloff are rejected
  (`IsLightSupported`).
- **Cost not yet measured:** the container renders a tile-mask render target every frame for the active camera
  (`clusteredLightingSceneComponent` → `_updateBatches`), which is extra CPU and GPU work [unknown: RND-L measures it].

### 4.6 Light budget per material

`PBRMaterial.maxSimultaneousLights` defaults to 4 [confirmed field]. World and character materials use the celestial
light plus the cluster: **2 lights**. Keep that number fixed for the session: a light count change recompiles every
material.

---

## 5. Post-processing

### 5.1 Order

```
scene (HDR half-float target, MSAA only when TAA is off)
 → [SSAO2 (half res), applied to ambient/IBL via the prepass]   High, Ultra
 → [SSR (half res)]                                             Ultra; High while puddles > 0.1
 → [TAA]                                                        High, Ultra
 → [light shafts: shadow-map march + resolve + composite]        Medium (quarter res), High, Ultra (half res)
 → DefaultRenderingPipeline: bloom → image processing (exposure, tone map, LUT, white balance, dither) → FXAA (Medium) → sharpen (with TAA)
 → [FSR1 upscale + sharpen]                                     when render scale < 1
```

The pipelines are created in that order; Babylon applies attached pipelines in creation order [likely: in the
bench, PBR + CSM + SSAO + HDR/bloom, PBR + TAA + HDR and PBR + MSAA + HDR rendered correctly once the varying limit
was raised (§3.5); the full Ultra stack was only timed, not inspected].

### 5.2 Tone mapping, exposure, grading

- `imageProcessing.toneMappingType = TONEMAPPING_KHR_PBR_NEUTRAL` (default) or `TONEMAPPING_ACES` (option).
  Babylon 9 applies exposure → tone map → gamma → contrast → 3D LUT → curves
  (`ShadersWGSL/ShadersInclude/imageProcessingFunctions.js` `applyImageProcessing`) [confirmed].
- **Exposure** is `SkyState.exposure` (the sky lane's target, eased) × a render-side trim per preset, not a
  histogram, so it never pumps when a character walks into shade. The values are the sky lane's and are tuned in the
  lab with §4.1's sun : ambient ratio.
- **LUT:** 32³ RGBA8 `RawTexture3D` assigned to `imageProcessing.colorGradingTexture` (3D path, `COLORGRADING3D`).
  - Keys: `dawn`, `day`, `dusk`, `night` × `clear`, `overcast`, `rain`: 12 LUTs of 32 × 1024 PNG strips in
    `apps/game/public/render/luts/` (our own art, not retail; generated at first from colour-balance parameters by
    `packages/world-render/tools/make-render-textures.ts`, lane RND-P). The LUT is sampled **after** tone mapping,
  gamma and contrast (display space), so the strips are authored in display-referred sRGB. White balance comes first,
  before exposure [confirmed: `imageProcessingFunctions.js`].
  - `GradeMixer` blends the 4 nearest keys on the CPU (32,768 texels × 4, about 0.3 ms) and re-uploads only when a
    weight moved by more than 0.01 (every few seconds).
  - `colorGradingTexture.level` is 1.
- **White balance:** `imageProcessing.whiteBalanceEnabled` and `temperature` exist [confirmed]. But `temperature` is
  the colour temperature of the illuminant to **neutralise** (default 6,500 K), not a creative warm/cool knob
  [confirmed: the 9.28 `imageProcessingConfiguration.pure.d.ts` doc comment]. The earlier curve (3,800 K at golden
  hour, 8,000 K at night) would therefore remove the golden-hour warmth and warm the night: the opposite of the
  intent. Rule: keep 6,500 K (or leave white balance off), and let the SkyState light colour and the LUT keys carry
  the warm evening and blue night. For a creative push, move the other way: above 6,500 K warms, below cools [our
  rule].
- Contrast 1.05, vignette off, dithering on (banding in fog gradients).
- **W9 LOOK calibration** [confirmed: measured, `work/tmp/w9-finish/look/`, `test/look-calibration.test.ts`]:
  - the render-side trim is `EXPOSURE_TRIM` 1.4 (render/post.ts): the dragon-gate plaza at a clear noon measured 0.427
    sRGB against Classic's 0.544 at trim 1 (the derived terrain relief and AO darkened it since the RND-L
    calibration), 0.515–0.523 at 1.4 (−4 to −5 %);
  - dusk: the key light never goes redder than `GOLDEN_KEY` (1, 0.7, 0.4) (it was (1, 0.18, 0.005) at 18:30), a
    twilight afterglow key (`TWILIGHT_KEY`), a golden ambient bounce (`TWILIGHT_BOUNCE`) and a twilight exposure boost
    (`twilightExposure`, sky/sky-system.ts); the dusk LUT lost its blue shadow lift;
  - night: `NIGHT_AMBIENT` (keyLight units) lights shadowed sides (the physical night ambient was 1/26 of the moon
    key), `STORM_GLOW` returns part of the hidden moon's light as ambient in a storm; the night LUT is bluer and deeper;
  - storms: the weather may raise the exposure 1.1× by day and 1.2× at night (was 1.4×), the retail part of the fog
    darkens with the rain, the rain and overcast LUTs keep their contrast; a full cover closes the sky
    (`cloudSkyWeight`, the dome's overcast deck).

### 5.3 SSAO

**W9 LOOK: back on for High and Ultra** (`RenderPostOptions.ssao`, default true). It was off from gate 1 because the
sky dome, the grass and the Classic water are ShaderMaterials that do not write the prepass: their pixels kept the
prepass clear values, depth 0 and normal (0, 0, 0), which SSAO2 read as geometry at the eye with a NaN normal and drew
black (WebGPU; SSR reads a depth of 0 as 1e8 and was unaffected). `clearPrepassForSsao` clears the depth target to 1e8
(past `maxZ`: SSAO2 fades its occlusion out there) and the other targets to (0, 0, 1e-4, 0) (a valid normal; 0 in the
RGBA8 reflectivity, under SSR's threshold). Checked on WebGPU and WebGL2 at High (the sky and the grass render as
without SSAO; the fountain water was only seen at the edge of a frame). Its GPU cost was not measured (the GPU lock was
held by the 9B SDXL job): measure it before the release. The CPU cost was within the noise of a shared machine (CPU
p50/p95 per frame, WebGPU High, the plaza, three alternating pairs of 240 frames: off 20.0/25.2, 19.6/23.4, 19.0/25.2;
on 23.5/32.8, 19.5/23.3, 19.7/25.8). If the GPU cost is too high on the friends' laptops, `ssao: false` or the
Options AO row turns it off without other changes.


`new SSAO2RenderingPipeline('ssao', scene, { ssaoRatio, blurRatio }, [camera], forceGeometryBuffer)`:

- High: ratio 0.5, 8 samples, `radius` 1.5 m, `totalStrength` 1.0, `expensiveBlur` true.
- Ultra: ratio 1.0, 16 samples.
- **`forceGeometryBuffer = false` on the PBR path**: every lit material is a `PBRMaterial` with prepass support, so
  SSAO reads the prepass MRT and needs no second geometry pass. The grass `ShaderMaterial` does not write the
  prepass, and grass getting no SSAO is fine. The sky dome is a `StandardMaterial` with vertex colours (`sky.ts`), not
  a `ShaderMaterial`. It supports the prepass and writes the dome's depth at its radius [likely], which SSAO treats as
  far background. The bench's preset stacks used the prepass with
  the grass, sky and water still `ShaderMaterial`s and rendered correctly [confirmed, once the varying limit was
  raised, §3.5]. Its single-feature SSAO rows used `true` (terrain was still a `ShaderMaterial` there), so they include
  a geometry pass: an upper bound.

### 5.4 SSR

`new SSRRenderingPipeline('ssr', scene, [camera], false, TEXTURETYPE_HALF_FLOAT)`:

- Measured (§11.2): with Babylon's defaults plus `ssrDownsample = 1`, `maxSteps = 120`, `step = 1`, SSR on "wet"
  PBR terrain cost **+1.1 ms** per frame on the dev PC (an earlier +15 ms reading was contaminated by another lane's
  GPU probe). **That figure is very likely only SSR's fixed overhead, with few or no pixels marched.** The SSR shader
  skips a pixel when `max(reflectivity.rgb) <= reflectivityThreshold` (default 0.04) [confirmed:
  `screenSpaceReflection2.fragment.js` line 45]. The reflectivity target is RGBA8 (prepass purpose 3 is
  `UNSIGNED_BYTE` [confirmed: `prePassRenderer.pure.js`]), so a dielectric F0 of 0.04 is stored as 10/255 = 0.039.
  The geometry-buffer path also writes `mix(0.04, albedo, metal)` and cannot see plugin changes. The bench's `wet`
  step lowered only roughness, not F0. Plain dielectrics are therefore **skipped by default**, and the marching cost
  of real wet surfaces is [unknown] until RND-P measures the masked version below.
- The spec's setup: `ssrDownsample = 1` (half res), `blurDownsample = 1`, `maxSteps = 48`, `step = 2`,
  `maxDistance = 60`, `thickness = 0.3`, `reflectivityThreshold = 0.05`, `environmentTexture` = the sky cube (the
  fallback when a ray misses), `attenuateScreenBorders` and `attenuateFacingCamera` on.
- **Mask SSR to where it matters:** the surface and terrain plugins raise the reflectivity that the prepass records
  to `F0 × step(roughness, 0.3) × 2` (≥ 0.08) only on puddles, wet flat ground, polished marble and metal, and set it
  to 0 elsewhere. Writing `fragData[PREPASS_REFLECTIVITY_INDEX]` at `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR` does **not**
  work: `pbrBlockPrePass` runs after that hook and writes `vec4(specularEnvironmentR0, microSurface)`, which would
  overwrite it [confirmed: `pbr.fragment.js` lines 626–628, `pbrBlockPrePass.js` line 92]. Instead, at that hook
  (after all lighting), assign the mutable locals `specularEnvironmentR0` and `microSurface`, which the prepass block
  then writes [likely; RND-P verifies]. This needs the **prepass** path (`forceGeometryBuffer = false`), because the
  geometry buffer renderer uses its own shader and ignores plugins. Dry dielectrics are already skipped by default
  (above), so the mask's job is to *include* wet surfaces. The SSR combiner weights by this reflectivity, so tune
  `strength` after the ×2.
- On High SSR was enabled while `puddles > 0.1` (cut at the wave-9 final gate, WAVE_PLAN3 §6.20 cut 4: High is off unless Advanced → Reflections asks for it); on Ultra always. Budget: ≤ 1.5 ms GPU on the dev GPU in rain at
  1080p [unknown until the masked version is measured].
- **Water is transparent and is not in the prepass, so SSR does not reach water** [likely: Babylon's SSR reads the
  opaque geometry buffer]. Water uses the sky cube plus Fresnel (§7). Ultra may add a `MirrorTexture` at quarter
  resolution with a reduced render list (terrain + g2 objects) [unknown cost: it re-renders the scene, CPU heavy].

### 5.5 Fog and light shafts

- **Height fog** replaces linear depth fog on PBR materials: a global plugin registered with
  `RegisterMaterialPlugin('SroFog', m => m instanceof PBRMaterial ? new SroFogPlugin(m) : null)`, injecting at
  `CUSTOM_FRAGMENT_BEFORE_FOG`:

  `fog = 1 − exp(−density × dist × (1 − exp(−k × h)) / (k × h))`, with `h = max(cameraY − worldY, eps)`,
  `k = 1 / heightFalloffM`, `density` from the retail G10/G11 fog range (fog reaches 95% at the retail fogEnd
  × weatherFogMul), and `colour = mix(horizon(viewDir), sunScatterColour, pow(max(0, dot(viewDir, sunDir)), 8))`, where `horizon` is
  `SkyState.horizonRing` (by azimuth, High+) or `SkyState.fogColor` (SKY.md §6.1).
  It works in scene metres, so the existing `FOG_RANGE_M` 250 m end still bounds the draw distance and streaming
  radii (FIELDS.md §3.2). Rain halves the visibility (§9).
- Water and grass (still `ShaderMaterial`) evaluate the same function from a shared uniform block (`fogParams` gains
  `density`, `heightFalloff`, `cameraY`).
- **Light shafts** (mini-wave w12r, GODRAYS; replaces the wave-9 Ultra VLS pass, which threw on WebGPU every frame and is
  removed): a ray march through the sun's shadow map at quarter (Medium) or half (High, Ultra) resolution, a resolve
  (blur and frame history) and a full-resolution composite between TAA and bloom, in WGSL and GLSL
  (`render/volumetrics/shafts.ts`, `shaft-shaders.ts`). Medium adds a screen-space walk for the trees (its shadow map
  has no tree casters). Strongest at dawn and dusk, dimmer at noon, half strength from the moon, denser in mist,
  weaker under overcast and rain. Options → Graphics → Light shafts: Auto (the preset's) / Off / Low / High
  (`graphics.advanced.lightShafts`, `withLightShafts`); Low has no post stack and never draws them. Cost at 1080p on
  the dev GPU: about +0.1–0.35 ms of GPU on Medium, +0.3 ms on High.

### 5.6 Anti-aliasing and render scale

- Medium: FXAA. High and Ultra: TAA (`TAARenderingPipeline`, 8 samples) plus `sharpenEnabled` (0.3). TAA smooths
  alpha-tested foliage and grass, which FXAA and MSAA do not, and those are most of Jangan's aliasing. Babylon
  implements its jitter as a material plugin on every material (`TAAMaterialManager`,
  `taaMaterialManager.pure.d.ts`); the bench measured **+0.23 ms CPU** for it in the town view (an earlier +4.4 ms
  reading was taken while another lane's GPU probe ran and is discarded). Two gaps in that picture:
  - `TAARenderingPipeline.disableOnCameraMove` defaults to **true**: TAA switches itself off while the camera moves
    [confirmed: `taaRenderingPipeline.pure.d.ts`]. In this game the follow camera moves whenever the player walks, so
    the defaults give no anti-aliasing during movement, and the +0.23 ms was measured with a static camera. To keep
    AA while moving, set `disableOnCameraMove = false`, `reprojectHistory = true` and `clampHistory = true`.
    Reprojection needs a velocity target (prepass velocity: more MRT bandwidth and more varyings against the §3.5
    limit), and its cost is [unknown].
  - The jitter plugin attaches only to materials with a `pluginManager` (PBR, Standard). **`ShaderMaterial`s are not
    jittered** [confirmed: `taaMaterialManager.pure.js` `_getPlugin`]. The grass scatter shader must add
    `position.xy += taaJitter × position.w` itself (a uniform fed from the TAA manager's `jitter`), or grass gets no
    TAA anti-aliasing (lane RND-W).

  MSAA ×4 on the HDR target
  (`DefaultRenderingPipeline.samples = 4`, +0.23 ms) is the Advanced alternative for players who dislike TAA's
  softness or ghosting. Ghosting with the orbit camera is [unknown]; check it in the lab.
- `resolution` < 1 (settings `graphics.resolution` 0.75 or 0.5) now uses **`FSR1RenderingPipeline`**
  (`scaleFactor` = 1/resolution) instead of hardware scaling. `settings.ts` `applyGraphics` keeps
  `setHardwareScalingLevel(1/dpr)` and hands the fraction to the renderer. `isSupported` requires WebGPU or WebGL2
  [confirmed in `fsr1RenderingPipeline.js`].
- Depth of field: off, not offered.

---

## 6. Terrain

### 6.1 Textures on the GPU

`TileAtlas` (`tile-atlas.ts`) grows from one array to up to four parallel `RawTexture2DArray`s with the same layer index
per tile:

| Array | Format | Medium | High | Ultra |
|---|---|---|---|---|
| albedo | RGBA8, decoded to linear in the shader as the prototype does (BC7 when KTX2 exists) | 512² (today) | 1024² | 2048² |
| normal | RGBA8 (RG used) | 512² | 1024² | 1024² |
| rmh: R roughness, G AO, B height | RGBA8 | 256² | 512² | 1024² |

- Classes and defaults come from §3.3 by tile type (`manifest.tiles[].typeName`) when a tile has no set.
- `uploadTextureLayer` (`textures.ts`) already does one layer at a time on both engines [confirmed code], so each
  array follows the atlas's layer allocation with no new mechanism.
- **VRAM.** The arrays are allocated at full capacity: `STREAM_DEFAULTS.tileLayers` is 80 on Medium and **96 on
  High** today [confirmed: `stream.ts`], and the whole field has only 104 tiles. Uncompressed RGBA8 with mips
  (5.33 B/texel), per array: 512² × 96 = 134 MB, 1024² × 96 = 537 MB, 2048² × 96 = 2.1 GB. The High column above is
  therefore about **1.2 GB uncompressed** (537 + 537 + 134 MB), and Ultra does not fit. The High and Ultra columns
  assume BC-compressed arrays (KTX2, §12). Without KTX2, High keeps 512² albedo, normal and rmh (about 0.4 GB) or
  lowers `tileLayers`.
- **Compressed arrays need new upload code.** `uploadTextureLayer` handles RGBA8 only and builds the mips on the CPU
  per layer [confirmed: `textures.ts`]. BC layers need a compressed per-layer write (WebGPU `writeTexture` with the BC
  format; WebGL2 `compressedTexSubImage3D`), fed with the KTX2 decoder's transcoded mips [likely feasible; not
  exercised]. Without compression, the CPU mip build of a 2048² layer is a main-thread cost [unknown; measure it].

### 6.2 Shading (`SroTerrainPlugin`)

Per fragment, in `CUSTOM_FRAGMENT_MAIN_BEGIN`, the existing loop over up to 8 layers stays (TERRAIN.md §2.3; code
moved from `shaders.ts` into `pbr/terrain-plugin.ts`). Per layer it now fetches albedo, and on High and above also
normal and rmh. It then:

1. **Height blend** (High+): the mask alpha `a` from the corner bits becomes
   `a' = saturate((a × (1 + contrast) + (h_k − h_prev) × 0.5 − 0.5 × contrast) / blendWidth)`: pebbles and grass
   poke through each other instead of a soft cross-fade. `contrast` 0.6, `blendWidth` 0.25 [our rule].
2. **Normals** (High+): each layer's tangent-space normal (world-aligned: T = +X, B = −Z, since UV = world XZ /
   period) is blended with the same weights, then transformed by the vertex normal's TBN. The result is written to
   `normalW` at `CUSTOM_FRAGMENT_UPDATE_ALPHA`. Medium keeps the vertex normal.
3. **Roughness/AO** from rmh, or the class defaults.
4. **Triplanar on steep cells** (High+): where `N.y < 0.65`, the **first (opaque) layer only** is also sampled on the
   XY and ZY planes and blended by `|N|^4` weights. That fixes the stretched cliffs of Jangan's gorges for 2 extra
   taps, instead of 16 for all layers.
5. **Detail layer** (High+): a shared 1024² detail normal + luminance texture per class group (soil, grass, rock), at
   a 1.5 m period. It fades in from 25 m to 5 m from the camera. The retail 80-unit period (8 m) looks blurry at a 10 m
   camera distance; this fixes that for 1 extra tap.
6. **Anti-tiling** (Ultra): a second albedo tap at a rotated, 0.37× period on the first layer, blended by
   low-frequency noise. It breaks the 8 m repeat visible from high cameras.
7. **Parallax occlusion** (Ultra only): 8–16 steps on the height channel of the first layer, within 20 m of the
   camera, with `textureSampleGrad` gradients from step 0. Cost: §11 extrapolation, [unknown] until the lane measures it.
8. **Wetness and puddles** (§9).

The splat loop's `textureSampleGrad` must stay in uniform control flow (TERRAIN.md §8.1), and so must the new
taps. The loop bound is the per-region layer count, which is uniform [confirmed: the current shaders do this].

### 6.3 Terrain LOD and draw distance

Unchanged: no far LOD (FIELDS.md §3.7). Height fog replaces the linear fog, but its 95% distance equals the old
fogEnd, so the load radii stay valid.

---

## 7. Water

`WaterRenderer` gets a PBR path: one `PBRMaterial` with `transparencyMode = ALPHABLEND`, `disableDepthWrite`, metallic
0, roughness 0.04 (0.15 in rain), and `SroWaterPlugin`:

- **Normal:** two tiling normal maps (our own 512² textures, `apps/game/public/render/water_n0.webp` and
  `water_n1.webp`, generated by a script from noise, not retail), scrolling at (0.03, 0.01) and (−0.02, 0.025) m/s at
  periods 6 m and 17 m. The wave type (`waterWaveType` 0–3) scales the amplitude by 0.5 / 0.8 / 1.0 / 1.3.
- **Colour:** retail frame × WaterColor(t) stays as the **albedo** (scattering colour), at 60% weight, so the water
  keeps its Jangan green. Deep-water tint: `mix(albedo, deepColour, depthFactor)`.
- **Depth:** from `scene.enableDepthRenderer(camera, false)` (a linear depth texture; the prepass depth when SSAO
  already runs). Shore alpha = `saturate(waterDepthM / 1.5)`, and a foam band where the depth is under 0.3 m. This
  replaces the per-vertex alpha of TERRAIN.md §4, which stays as the Classic path.
- **Reflection:** the sky cube via the PBR environment (Fresnel from the material), + SSR does not apply (§5.4).
- **Rain:** ripple normals (§9.3) added to the normal.
- **Ice:** `StandardMaterial` today → `PBRMaterial` with roughness 0.2, class `stone`-like, no plugin.

Cost: one extra full-screen depth pass when SSAO is off (Medium) [unknown: measure; the depth renderer draws every
opaque mesh again, which costs CPU]. On Medium, the fallback is to keep the per-vertex depth alpha and skip the depth
renderer.

---

## 8. Foliage and grass

### 8.1 Trees and bushes (objects)

`SroFoliagePlugin` for materials of class `foliage`:

- **Two-sided lighting:** `twoSidedLighting = true` (the retail trees are two-sided cards).
- **Translucency:** an extra diffuse term,
  `sunColor × albedo × translucency × pow(saturate(dot(V, −L)), 4) × thickness`, `thickness = 0.6 × albedo.g`.
  It **cannot** go into `CUSTOM_LIGHT0_COLOR`. That hook scales the light colour, which `computeDiffuseLighting` then
  multiplies by the clamped N·L [confirmed: `pbrDirectLightingFunctions.js`]. A back-lit leaf (V towards the sun, the
  two-sided normal facing the viewer) has N·L ≤ 0, so the term would vanish exactly where it should show. Add it
  instead to `finalDiffuse` at `CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION` (declared by
  `pbrBlockFinalUnlitComponents`, before that hook). Take the sun's shadow from a private variable that a regex point
  sets after light 0's shadow lookup, or accept unshadowed translucency [likely; RND-W verifies].
  That is 1 dot and 1 pow, instead of the PBR subsurface path (`subSurface.isTranslucencyEnabled`), which costs a
  thickness texture and a second diffuse evaluation [confirmed: that option exists; our rule not to use it for trees].
- **Wind:** in `CUSTOM_VERTEX_UPDATE_POSITION`, `offset = windDir × strength × h² × (sin(t × 1.3 + phase) × 0.7 +
  sin(t × 2.9 + phase × 1.7) × 0.3)`. `h` = model-space height / model height (from the sidecar bounding box, a
  uniform per model), `phase = dot(instanceRoot.xz, (0.21, 0.17))`. Wind strength comes from the weather (0.2 calm,
  1.0 rain, 1.6 storm) and matches the grass (`scFade.z`). The skeletal trees (`tre_maple01` etc., TERRAIN.md §6.5)
  keep their retail clip and get only the leaf flutter term.
- **Shadow pass:** `material.shadowDepthWrapper = new ShadowDepthWrapper(material, scene, { standalone: false })`, so
  the shadow map sees the same swaying leaves [likely: the class exists in 9.28].

### 8.2 Grass scatter (`scatter-assets.ts` shaders)

The grass stays a `ShaderMaterial` (thousands of alpha-tested cards; PBR would triple its cost) and gains:

- **N·L with a bent normal:** `n = normalize(mix(up, cardNormal, 0.3))`, `diffuse = albedo × (sunColour × sunVis ×
  wrap(N·L, 0.4) + SH(n))`. The SH coefficients are 4 vec3 uniforms: L1, as `SkyState.sh` provides them (SKY.md
  §6.1). The celestial light is a direction + colour uniform.
- **Shadow:** today's root lightmap, remapped to `bakedVis` (§3.4). On High and Ultra, **one CSM tap per plant in
  the vertex shader** at the plant's root: `textureSampleCompareLevel` on cascade 0, whose matrix is
  `csm.getCascadeTransformMatrix(0)` [confirmed getter] (WGSL allows it in the vertex stage [likely]). That costs one
  tap per vertex, not per pixel, and plants in a building's shadow go dark with it.
- **Translucency:** as for trees, per vertex.
- **Wetness:** albedo × (1 − 0.3 × wetness), plus a Blinn specular lobe of strength 0.3 × wetness.
- **Fog:** the shared height-fog function.
- **Output:** linear HDR, so the shader must stop writing display-space colour on PBR presets (a define `SRO_HDR`).

### 8.3 Wave 10: the grass field and the wildlife (docs/GRASS_LIFE.md)

- **The grass field** (`packages/world-render/src/grass/`, GL-S/GL-F/GL-T): on the PBR presets (`QUALITY_PRESETS`
  `grassStyle: 'field'`, Medium and up) `WorldScatter` hands its regions to GRASS_LIFE's own grass: blade clumps baked
  per region from the splat coverage and the converter's tile grass palettes, drawn from a camera-centred window in
  ≤ 3 draws, no casters, the terrain's grass tint under it. The shared scatter uniforms, defines and depth textures
  stay on `WorldScatter`, so the field follows the sky, the weather and the shadows like the retail grass did. The placed
  retail tufts are hidden on that path **before the batcher sees a region** (D3, D24); the stage keeps them. Low (the
  Classic path) keeps the retail scatter and tufts exactly as before.
- **The wildlife** (`packages/world-render/src/life/`, GL-L): butterflies, ground flocks that flush, perchers, dragonflies,
  fireflies and gulls from seeded per-cell candidates near flowers, trees, roofs and water, gated by the time of day
  and the weather (`lifeTargets`); ≤ 3 draws, PBR path only, Options → Wildlife. The stage turns the ground flocks off.
- Neither is ever claimed by the batcher: their meshes carry `sroWorld: 'scatter'` / `'life'` (`isBatchableMesh`).

---

## 8B. Wave 10: region batching (docs/BATCHING.md)

- **What it does** (`packages/world-render/src/batch/`): on the PBR path of a streamed world, every region's static
  objects are merged in a worker into a few group meshes on group materials of their own (BT-M), whose texture lookups
  go through a material table and atlas arrays (BT-A, BT-P: ≤ 4 object samplers per group material). Skinned foliage
  loads its static variant (`models[i].staticVariant`, BT-T) and merges with shader wind on the pivot attribute
  `sroPivot`; the region brings its own shadow proxy and cut-out casters (BT-S; tree groups always cast). Lamps keep
  NL's night colour through the table's emissive texel (F9).
- **What stays separate:** skinned clones, blended and unlit materials (material groups), the grass, the wildlife and
  the ocean (never claimed), and everything on Low.
- **Switching:** `World.setBatching` (Options → Graphics → Advanced → World batching) and every path switch release
  every batch (meshes, slots, cells) before the rebuild and claim again on PBR (F12); the live range scale (Options
  sight, the create screen's cap 0.6) reaches the batch (F11).
- **Default:** on (`DEFAULT_BATCH_TABLES` = `createMaterialTable` in `batch/index.ts`).
- **Measured** (LAB-10R, 1080p, dev PC): `work/tmp/w10r/budgets.md`. The tests that hold it: `region-batch.test.ts`,
  `batch-seams.test.ts`, `batch-trees.test.ts`, `shadows-batch.test.ts`, and I-10R's `cross-w10r.test.ts` (S-DRAW,
  the tuft filter, no scatter/life/ocean claimed, a live Low ↔ Medium switch with no leftovers).

---

## 9. Rain and wetness (renderer side)

The weather/sky lane is specifying rain in parallel (its GPU probe measured wet terrain with puddles, ripples and an
occlusion pass). This section fixes where the wet response plugs into the materials and what it costs here; where
the weather spec defines the same functions (puddle mask, ripple atlas, occlusion map), its definitions win and
lane RND-W adopts them.

### 9.1 Inputs

The weather lane owns the state machine and the protocol. The renderer takes one struct per frame:

```ts
export interface RenderWeather {   // docs/WEATHER.md produces it (toRenderWeather), this spec consumes it
  rain: number        // 0..1 current rain intensity (drops, ripples, SSR on High)
  wetness: number     // 0..1 surface wetness; rises to 1 in ~60 s of rain, dries over ~300 s (weather lane owns the rates)
  puddles: number     // 0..1 puddle fill; lags wetness (~180 s to fill)
  cloud: number       // 0..1 overcast (dims the sun, flattens the sky, IBL)
  fogMul: number      // ≥ 1: visibility divisor (rain 2, storm 3)
  wind: number        // 0..2 foliage/grass wind strength
}
WorldRender.setWeather(w: RenderWeather): void   // render/index.ts; `World.setWeather(frame)` is the weather lane's
                                                 // (WEATHER.md §0) and calls this on the PBR path
```

### 9.2 Material response, per class (§3.3 porosity)

In `SroSurfacePlugin`, `SroTerrainPlugin` and the grass shader, with `w = wetness × exposure`, where `exposure`
comes from the rain occlusion map (§9.4):

- `albedo *= mix(1, 1 − 0.5 × porosity, w)`: porous stone and soil darken and saturate;
- `roughness = mix(roughness, wetRoughness, w)`;
- `normal = normalize(mix(normal, geomNormal, 0.5 × w))`: water fills the micro-detail;
- **vertical surfaces** (`|N.y| < 0.3`, Ultra): streaks, a vertical noise × w lowers roughness in runs.

### 9.3 Puddles and ripples (terrain, and flat object floors on High+)

- `puddleMask = smoothstep(p − 0.05, p + 0.05, (1 − height) × 0.7 + noise(worldXZ × 0.15) × 0.3)`, with
  `p = 1 − puddles × 0.6` and `height` from the rmh map, or 0.5 without one. The mask is limited to flat ground
  (`N.y > 0.95`) and to the classes `ground_soil`, `ground_grass` and `stone` (plaza flagstones).
- In a puddle: albedo × 0.6, roughness 0.03, normal = geometry normal + ripples.
- **Ripples:** a 256² 16-frame ripple normal atlas (our own, generated), sampled at a 1.2 m period and advanced at
  24 fps by the rain intensity. Two taps with offset phase. Outside puddles, on wet ground, a weaker ripple
  (× 0.2) appears only while `rain > 0.3`.

### 9.4 Rain occlusion (sheltered = dry)

A top-down orthographic depth map (`RenderTargetTexture` 512², 128 m × 128 m around the camera, render list: g2
object chunks and trees), re-rendered when the camera moved 16 m or a region committed. Every wetness term uses
`exposure = saturate((sceneY − occluderY + 0.3) / 0.3)`: under a roof or a dense tree `exposure` → 0 and the ground
stays dry. The weather lane's rain particles read the same map, so drops stop at roofs (the texture is exposed as
`world.render.rainOcclusion`, with its matrix). The object renderer does no frustum test on an explicit render list
(§4.3), so the list must be pre-filtered to the chunks inside the 128 m box. Cost: one small depth pass every few
seconds [likely < 0.1 ms amortised].

---

## 10. Quality presets

`WorldQuality` becomes `'low' | 'medium' | 'high' | 'ultra'` (`world.ts`; `settings.ts` `PRESETS`, `STREAM_DEFAULTS`
gets `ultra` = `high`'s streaming). `QualitySettings` gains a `render: RenderQuality` block. Every row is also a
separate Options setting under "Advanced" (§14, lane RND-G).

| Feature | Low (Classic) | Medium | High | Ultra |
|---|---|---|---|---|
| Materials | retail fixed-function | PBR, class defaults + PBR maps ≤ 1024 | PBR maps ≤ 2048 | full-resolution maps |
| Terrain | retail splat | PBR splat, vertex normals | + layer normals, height blend, triplanar, detail | + anti-tiling, parallax |
| HDR / tone map / LUT | — | yes | yes | yes |
| Sun shadows (CSM) | — (lightmaps) | 1024 × 2, 60 m | 2048 × 3, 150 m, foliage + terrain cast | 2048 × 4, 250 m, + props |
| IBL | — | SH + CPU sky cube | same | same |
| Night point lights | — | 8 | 16 | 32 |
| SSAO | — | — | half res, 8 samples | full res, 16 samples |
| SSR | — | — | — (WAVE_PLAN3 §6.20 cut 4 at the wave-9 final gate; Advanced → Reflections brings it back) | always |
| Bloom | — | yes (scale 0.5) | yes | yes |
| AA | MSAA ×4 (canvas) | FXAA | TAA + sharpen (option: MSAA ×4) | TAA + sharpen |
| Light shafts | — | low (quarter res + tree walk) | high (half res) | high (half res) |
| Height fog | linear (retail) | yes | yes | yes |
| Water | retail | PBR, vertex alpha | PBR + depth shore | + mirror (optional) |
| Foliage | retail | wind + translucency | + CSM caster, grass root shadow | same |
| Rain surface response | — | wetness only | + puddles, ripples, occlusion map | + streaks |
| Grass (scatter) | low | medium | high | high |
| Default render scale | 1.0 | 1.0 (0.75 + FSR on iGPU) | 1.0 | 1.0 |

**First-run default** (`settings.ts` `recommendGraphics` / `runFirstRun`, only when no saved settings exist; the
user's release decision of 2026-09-29, "Default Medium, High optional"; rollout.ts `RENDER_ROLLOUT = 'on'`):

- **Medium on every adapter class**, WebGPU and WebGL2 alike: a discrete desktop or laptop GPU, an Apple GPU (an M
  Pro/Max/Ultra too), an adapter that names nothing, a WebGPU adapter with only 16 inter-stage variables. High and
  Ultra are the player's own choice in Options. Measured at the wave-9 final gate (work/tmp/w9-finish/budgets.md):
  Medium holds 60 fps everywhere (WebGL2 Medium worst p95 13.4 ms); WebGPU High misses (plaza p95 17.9 ms, crowd
  21.5 ms; CPU draw cost).
- An integrated GPU (`isIntegratedGpu`: `intel` without "arc", `architecture` `gen-12lp` / `xe-lpg`, an AMD APU the
  strings name ("Radeon(TM) Graphics", "Radeon 780M", "Radeon Vega 8 Graphics"), a software renderer (SwiftShader,
  llvmpipe) or `isFallbackAdapter`) → Medium at render scale 0.75 (FSR1 on WebGPU) with weather `low` (§11.4: about
  5.4 ms CPU and 4 ms GPU on an Iris Xe / 680M class laptop [projected]). **Gap:** an AMD APU behind a bare WebGPU
  adapter (vendor `amd`, architecture `rdna-3`, no description) is not caught; WebGL2's ANGLE renderer string names it.
- An Apple GPU on a Retina screen (devicePixelRatio ≥ 2) starts at render scale 0.75.
- WebGL1 → Low (the Classic path).
- Saved settings keep their preset: a player saved on Medium (the old default) moves from the Classic look to Medium
  PBR; Low stays the Classic path; High and Ultra stay.
- **The Low guard's combination** (`settings.ts` `classicLook` / `newLook`; the W9 release verify 2, check b): Low
  (Classic) with sky `classic` and weather `off` is the look from before wave 9, all of it, in every rollout:
  `effectiveGraphics` returns the preview-off state (the Classic path, the classic sky at a **frozen noon**, a **clear
  weather frame** and no weather sound, `PREVIEW_OFF_RENDER` = Low's block **without the night splats**, retail
  textures), the characters' own lights are HEAD's (sun 1.2 and its fixed direction, hemi 0.7), every pose updates every
  frame (no animation LOD) and the remaster test switch is off. Options keeps the Sky and Weather rows (either one
  leaves the combination, live, on the same Classic path: no rebuild), hides the Textures row and the HUD clock row,
  and shows a note under the Sky row. The verify had measured the gap on the production bundle at a GM-frozen 12:00:
  the characters' sun 1.20 → 1.03 and turned, the world sun 0.435 → 0.37, a greyer clear colour and fog, 17.5 % of
  pixels off by more than 8 levels, and at night the light splats the pre-release Low never had.
- The release's one-time move (`settings.ts` `runReleaseMigration`, at world entry, once per blob: `releaseMigrated`;
  the W9 release verify, check b): a blob saved before the release on **Low with the preview off** had the Low guard
  look, so it keeps it: sky `classic` and weather `off` are written into the blob, which is the combination above (the
  player can change them back in Options). A Low player who had the preview on already saw §5.1's Low (modern sky,
  weather low, the clock) and keeps it; a fresh profile has nothing to keep (a WebGL1 first run lands on §5.1's Low).

**Character screens** (`apps/game/src/three/studio-env.ts`): on the PBR presets character select and creation bind a
32² studio cube (`SkyEnvironment`, radiance from the screen's own fill and key, an empty spherical polynomial so it adds
only specular) as `scene.environmentTexture`; the Classic path binds nothing. The cube is read **linear**
(`SkyEnvironment` `decode: 'linear'`, the default): Babylon reads a RawCubeTexture as sRGB unless told (GAMMAREFLECTION,
pow 2.2 on the radiance), which left the dusk plaza's studio (walls ≈ 0.3–0.5) at 0.07–0.2 and the Copper Blade near
black at character select. The world's sky cube is still read as sRGB (`WORLD_SKY_CUBE_DECODE`), the shipped wave-9
look: moving it to linear brightens the water's sky reflection, metals and the Fresnel sheen when the sky is dim, and
waits for a look pass (docs/BACKLOG.md).

A 10-second in-game frame-time watchdog drops one preset (and says so in chat) when the p95 frame time exceeds 33 ms
[our rule]. W9A perf pass: it never drops to Low on its own (Low is the Classic path, and a drop to it is a live path
switch; `WATCHDOG_FLOOR` = Medium), and it does not judge while the region streamer is busy or a shader compiled,
nor for 3 s after (`WATCHDOG.settleMs`). A preset or path switch streams and compiles for 5–26 s on the dev PC, longer
than the 15 s grace, so before this one slow switch tripped the next drop (High → Medium → Low in one session).

---

## 11. Measured budgets

### 11.1 The prototype

`work/tmp/render/bench.ts` loads the real Jangan export (`work/out-opt/world/jangan`, 9 regions, 2,618 meshes, 696
materials, whole-world load) through `@sro/world-render` exactly as the game does, puts the orbit camera at the spawn
(14 m, β = 1.2), aims the sun at 40° elevation, and measures each feature on its own, then the preset stacks. The PBR
section swaps every object `StandardMaterial` for a `PBRMaterial` and every terrain `ShaderMaterial` for
`PBRMaterial + SroTerrainPlugin` (the real splat with the retail lightmap as baked visibility).

Method: N frames rendered back to back in one task (`engine.beginFrame(); scene.render(); engine.endFrame()`), then a
GPU wait (`device.queue.onSubmittedWorkDone()`). Wall time / N = the pipelined frame cost, the larger of the CPU
submit time and the GPU time. The JS time of the calls is reported separately as "cpu". The first series took the
median of 3 runs of 60 frames; the later series the minimum of 5 (3 at 8K), which is robust against other processes
(they only ever add time). A screenshot mode (`?shot=1`) renders a config for visual checks.

To re-run: `cd apps/viewer && pnpm exec vite --config ../../work/tmp/render/vite.config.mjs` (serves `work/out-opt`
at `/out-opt/`, port 5213), then open e.g. `http://localhost:5213/?runs=5&queue=csm:2048:3:150:proxy3|pbr taa`
(steps: `pbr`, `hdr[:bloom][:msaa4][:nofxaa]`, `csm:size:cascades:maxZ:all|static|near|proxy|proxy2|proxy3`,
`ssao:ratio:samples[:prepass]`, `ssr[:prepass]`, `taa`, `fsr:scale`, `vls`, `rain:n`, `wet`, `probe1`, `probe30`,
`rawenv`; `?w=&h=` for the canvas size, `?engine=webgl`, `?sun=x,y,z`). Results accumulate in `sessionStorage`.

**Hardware and noise.** Dev PC: AMD Ryzen 5 9600X, Radeon RX 9060 XT, Chrome 152, WebGPU, 1920 × 1080 canvas.
Other agents kept the CPU 45–80% busy during the runs, so the **CPU columns carry ±3 ms noise on the base**
(1.3–8.7 ms observed for the same base scene). Each run measures its own base in the same page just before the
feature. First-series deltas under ~1 ms are within noise; minimum-of-5 deltas reproduce to about ±0.2 ms (TAA
measured +0.20 and +0.23 ms in two series). Raw logs:
`work/tmp/render/results-*.txt`. No GLSL shader reached the WebGPU engine in any run [confirmed by the bench's guard].

**The main finding: the game is CPU-bound, and the GPU work of the whole modern look is small on this GPU.**
Today's frame costs about 1.5–2 ms of JS (Babylon draw submission for 289 active meshes in the town view), while
the GPU's main pass takes 0.46 ms. Every feature's cost below is in CPU unless the wall time exceeds the CPU time.

### 11.2 Single features, 1080p [confirmed: measured]

Minimum of 5 runs unless marked "(1st)" (median of 3, first series). "Δ" is the frame time over the base measured in
the same page.

| Feature | Setup | Δ frame | Where the cost is |
|---|---|---:|---|
| PBR swap | 2,030 object meshes → `PBRMaterial`; 9 terrain regions → `PBRMaterial` + `SroTerrainPlugin` (real splat, lightmap as sun visibility, roughness) | **+0.03 ms** (1st) | nothing: same draws; main-pass GPU 0.41 vs 0.47 ms |
| HDR + ACES + bloom + FXAA | `DefaultRenderingPipeline(hdr)`, bloom scale 0.5, kernel 64 | +0.34 ms | CPU |
| HDR + MSAA ×4 | `samples = 4`, FXAA off | +0.23 ms | CPU |
| TAA, 8 samples | `TAARenderingPipeline` | +0.23 ms | CPU (jitter plugin per material) |
| FSR1 1.5× (render 0.67) | `FSR1RenderingPipeline` | +0.03 ms (1st) | — |
| SSAO2, ratio 0.5, 8 samples | geometry buffer (`forceGeometryBuffer`) | +0.60 ms | CPU (extra geometry pass) |
| SSR on "wet" PBR terrain, half res, 120 steps | geometry buffer; wet lowered only roughness, F0 stayed 0.04 | +1.1 ms | CPU + GPU. Probably fixed overhead with almost no pixels marched (§5.4); the marching cost is [unknown] |
| Volumetric light scattering, 0.5, 64 samples | | +0.57 ms | CPU (re-renders every mesh black) |
| GPU rain particles, 20 k stretched billboards | `GPUParticleSystem` | within noise (1st: the base read 5.27 ms, the config 4.50 ms) | — |
| CSM 2048 × 3, 150 m, **naive** (912 casters: every enabled mesh) | | **+43 ms** (1st) | CPU: casters × cascades draws |
| CSM 2048 × 3, 150 m, static chunks within range (356) | | +6.9 ms (1st) | CPU |
| CSM 1024 × 2, 60 m, static chunks within range (86) | | +0.88 ms | CPU |
| CSM 2048 × 4, 250 m, static chunks within range (549) | | +11.7 ms (1st) | CPU |
| CSM 1024 × 2, 60 m, **shadow proxy** | 49 opaque chunks → 1 mesh (14 k tris); 37 foliage chunks | **+0.35 ms** | CPU |
| CSM 2048 × 3, 150 m, proxy, all foliage in range | 198 → 1 mesh (43 k tris); 158 foliage | +5.3 ms | CPU: the foliage casters |
| CSM 2048 × 3, 150 m, proxy, foliage merged per material | 158 → 138 meshes | +2.4 ms | CPU |
| CSM 2048 × 3, 150 m, **spec rule**: proxy + foliage ≤ 60 m | 1 proxy + 37 foliage | **+0.75 ms** | CPU |
| Sky `ReflectionProbe`, 128² float, re-rendered every frame | 2,030 PBR materials use it | **+508 ms** (1st) | CPU; cause unknown (§4.2) |
| Same probe, re-rendered every 30 frames | | +19 ms (≈ 570 ms per refresh) | CPU |
| CPU-built `RawCubeTexture` 64² RGBA32F, re-uploaded every 30 frames | faces built on the main thread | +0.42 ms (≈ 12 ms per refresh) | CPU |

### 11.3 Preset stacks [confirmed: measured]

All with the PBR swap and the spec's shadow-caster rule (proxy + foliage ≤ 60 m). High, Ultra and High + rain ran
with `maxInterStageShaderVariables` = 28 (§3.5). Medium's 1080p row comes from the second series, which ran at the
default limit of 16. That run was valid, because Medium has no prepass (`results-q2-1080p.txt`). Base = today's
Classic renderer in the same page. The SSR in Ultra and High + rain marched few pixels (§5.4), so those rows
understate SSR's cost in real rain.

| Stack | Contents | 1080p frame (Δ), CPU-bound | 8K frame, GPU-bound | GPU per 1080p (8K ÷ 16) |
|---|---|---:|---:|---:|
| Classic (base) | today | 1.3–1.5 ms | 10.7 ms | 0.67 ms |
| PBR swap only | no post, no shadows | +0.03 | 8.6 ms | 0.54 ms |
| **Medium** | CSM 1024 × 2 60 m, HDR, ACES, bloom, FXAA | 2.69 ms (+1.30) | 13.9 ms | 0.87 ms |
| **High** | CSM 2048 × 3 150 m, TAA, SSAO 0.5 × 8 (prepass), HDR, bloom | 3.53 ms (+2.16) | 21.2 ms | 1.32 ms |
| **Ultra** | CSM 2048 × 4 250 m, TAA, SSAO 1.0 × 16, SSR, light shafts, HDR, bloom | 5.06 ms (+3.68) | 44.2 ms | 2.76 ms |
| **High + rain** | High + wet terrain + SSR + 20 k rain particles | 4.18 ms (+2.78) | 22.9 ms | 1.43 ms |

Reading:

- At 1080p the whole modern stack is **CPU-bound** on the dev PC: in the series that logged both numbers, the frame
  time is within 0.2 ms of the JS time. At 4K it is not: 4K Medium measured a 3.95 ms wall time against 3.08 ms of
  CPU, so it is already GPU-bound (as is the 4K base, 3.0 ms against 1.5 ms). High costs about **+2 ms of CPU per frame**, Ultra +3.7 ms.
- The 8K column (16× the pixels of 1080p, so the GPU is the bottleneck) gives the GPU cost. Dividing by 16 slightly
  flatters the resolution-independent parts (shadow-map passes), so treat the last column as a lower bound.
- The first High/Ultra/rain readings were taken with the 16-varying limit (§3.5) and a black frame; they are
  discarded (`work/tmp/render/results-q2-1080p.txt` keeps the history).

### 11.4 Projections to other hardware [projected]

Scale factors: CPU from single-thread performance relative to the dev PC's Ryzen 5 9600X; GPU from FP32 throughput
and memory bandwidth relative to the RX 9060 XT (post-processing is bandwidth-bound). Both are rough.

| Machine class | CPU factor | GPU factor | Classic | Medium | High | Ultra |
|---|---:|---:|---|---|---|---|
| Dev PC (9600X + RX 9060 XT), 1080p | 1 | 1 | 1.4 ms CPU / 0.7 GPU | 2.7 / 0.9 | 3.5 / 1.3 | 5.1 / 2.8 |
| Mid desktop (6-core 2020 CPU + RTX 3060 / RX 6600), 1080p | ×1.5 | ×1.6 | 2 / 1.1 | 4 / 1.4 | 5.3 / 2.1 | 7.6 / 4.4 |
| Gaming laptop (8-core mobile + RTX 3050 / 4050 mobile), 1080p | ×1.7 | ×2.5 | 2.4 / 1.7 | 4.6 / 2.2 | 6 / 3.3 | 8.7 / 6.9 |
| Thin laptop iGPU (Iris Xe 96 EU / Radeon 680M), 1080p | ×2 | ×8 | 2.8 / 5.4 | 5.4 / 7 | 7 / 10.6 | 10 / 22 |
| Same, render scale 0.75 + FSR1 (1440 × 810 internal, 0.56× pixels; the settings offer 1 / 0.75 / 0.5) | ×2 | ×8 × 0.56 | — | 5.4 / 3.9 | 7 / 6 | — |
| Intel N100-class mini PC (UHD 24 EU), 1080p | ×3 | ×25 | 4.2 / 17 | 8.1 / 22 | 10.6 / 33 | — |
| Same, FSR1 2× (0.25× pixels) | ×3 | ×25 × 0.25 | 4.2 / 4.2 | 8.1 / 5.4 | — | — |

These are **renderer-only** costs. The whole game frame on the dev PC is about 6.7 ms of JS with 5 players and 20
mobs in view (EFFECTS.md §7), so on an N100 Classic already sits near 17 ms. Conclusions [projected]:

- **High at 60 fps** is realistic on any discrete GPU from the last ~6 years.
- **Integrated laptops** should default to **Medium at render scale 0.75 with FSR1**: about 5.4 ms of renderer CPU
  and 4 ms of GPU, inside a 16.7 ms frame with the game's own JS. (An earlier draft said "900p via FSR1 1.5×". A 1.5×
  scale factor is 720p internal, and 0.67 is not one of `settings.ts` `RESOLUTIONS` [confirmed: `[1, 0.75, 0.5]`].)
- **N100-class** machines stay on **Classic (Low)**, or Medium with FSR1 2× at 30 fps. The server's N100 is not a
  client, so this matters only for a friend with a mini PC.
- Frame budgets per lane (§14) are set on the dev PC so they stay meaningful when scaled by these factors.

### 11.5 W9A perf pass: the whole game frame [confirmed: measured]

The W9A profile (the user's "modern graphics felt slow") found the game CPU-bound: High cost 7.6–9.6 ms more CPU than
Classic (the budget is +2.2 ms), and 40–50 % of High frames in town went over 16.7 ms. The GPU (≤ 4.6 ms on Ultra) was
never the limit. The pass changed four things, each switchable at run time for the A/B:

- per-cascade caster culling on by default (§4.3; `WorldShadows.setCascadeCulling`);
- characters cast within 50 m, their shown parts only (§4.3, §4.4; `setCharacterRange`);
- enabled-only active-mesh candidates (`render/active-meshes.ts` `EnabledMeshCandidates`; `World.setActiveMeshFilter`):
  Babylon walks every scene mesh twice a frame, and 1,800 of the 3,500 were disabled templates, pooled meshes and
  out-of-range clones;
- actor culling (§4.4; `ModelLibrary.actorCulling`).

Production bundle (`vite preview`), WebGPU, 1920 × 1080 canvas, RX 9060 XT + Ryzen 5 9600X; the game's own loop
uncapped; CPU = the whole render-loop callback (scene.render + game logic); medians of 3 alternating off/on pairs of
300 frames. Taken without the GPU lock (the 9B texture jobs held it) and with the SDXL job running on the GPU, so no
GPU timestamps; machine load 19–30 %. The raw rows are in `work/tmp/w9a-perf/perf-pass/ab-results.json`.

| Scene (clear noon unless noted) | Preset | CPU p50 / p95 ms, before → after | Uncapped fps | Draws (main + shadow) | Mesh eval | Shadows (CSM) | Main draw |
|---|---|---|---|---|---|---|---|
| Plaza | Low (Classic) | 4.0 / 5.7 → 2.4 / 3.2 | 231 → 389 | 161 → 102 | 1.45 → 0.67 | – | 1.90 → 1.04 |
| Plaza | Medium | 8.9 / 14.1 → 5.8 / 8.5 | 94 → 165 | 298 → 226 | 3.11 → 1.67 | 0.71 → 0.63 | 4.11 → 2.40 |
| Plaza | High | 13.1 / 21.8 → 7.6 / 10.8 | 66 → 125 | 669 → 355 | 3.96 → 1.91 | 3.00 → 1.30 | 4.61 → 2.83 |
| Plaza, storm at 22:00 | High | 12.9 / 18.0 → 8.2 / 11.6 | 74 → 116 | 680 → 369 | 3.48 → 2.10 | 2.91 → 1.37 | 4.54 → 3.14 |
| Crowd (20 mobs + NPCs), run 1 | High | 18.6 / 26.3 → 10.7 / 15.9 | 51 → 84 | 821 → 503 | 5.41 → 2.82 | 3.79 → 1.99 | 5.68 → 3.63 |
| Crowd, run 2 | High | 18.0 / 24.9 → 12.7 / 18.4 | 51 → 74 | 829 → 513 | 5.31 → 3.49 | 3.90 → 2.31 | 5.85 → 4.23 |
| Crowd | Ultra | 18.1 / 24.7 → 11.7 / 17.6 | 53 → 81 | 1,037 → 624 | 4.72 → 2.95 | 4.87 → 2.67 | 5.55 → 3.86 |

Each change alone (crowd, High, 2 pairs; the rest of the frame is noisy at this load, so read the segments): cascade
culling cut the CSM step 3.97 → 2.82 ms (shadow draws 555 → 356), the character range 3.78 → 2.44 ms (555 → 357),
the candidate list the mesh evaluation 5.04 → 4.57 ms, actor culling the main draws 266 → 207. Not adopted:
Babylon's WebGPU non-compatibility mode (`engine.compatibilityMode = false`), measured on top of the four as 10.5 /
15.3 → 10.0 / 14.2 ms: half a millisecond, against render bundles that keep pipeline state across frames, which is
the kind of stale state the vanish bug came from.

What is left, largest first: the main draw (about 20 µs a draw, ~150 of the ~200 main draws in a crowd are character
parts), animation (1.6–2.0 ms in a crowd; pausing off-screen actors' clips would also silence their clip-synced
sounds), and garbage (about 0.5 MB a frame, 2–3 collections a second; Babylon's per-track animation interpolation is a
likely source).

### 11.6 PERF2: animation cost, garbage, the warm-up overlay [confirmed: measured]

Three changes, each switchable at run time for the A/B (`window.__sroModels`, `window.__sroWarmup`):

- **Pooled key interpolation** (`three/models.ts installPooledInterpolation`, `interpolationPool.enabled`): Babylon's
  `quaternionInterpolateFunction` / `vector3InterpolateFunction` return a new Quaternion or Vector3 per track per
  frame; at the plaza that is ~6,200 objects a frame, most of them the world's animated objects, not the actors.
  RuntimeAnimation copies the value before the next track is evaluated, so one scratch value per Animation is enough
  (CYCLE loop mode only: the relative and constant modes keep values in their caches).
- **Animation LOD** (`ANIM_LOD`, `CharacterActor.lodTick`, `animLod`): an actor's pose updates every frame at a screen
  size (height × scale ÷ distance) of 0.12 or more, else at 30 / 20 / 10 Hz; off screen at 20 Hz within 50 m (it still
  casts a shadow into view), else 10 Hz. A skipped frame skips the actor's animatables and its skin matrices
  (Skeleton.prepare). The clips keep their clock, so every update lands on the pose an every-frame actor has; an actor
  that comes into view on a skipped frame is stepped to this frame's pose before the draw; a clip that starts is
  evaluated on the next frame; the player's own character and the horse it rides always update every frame. Hit and
  cast timing come from the sidecar clip facts, not from the animatables, so they do not move; a one-shot clip's end
  (the base clip resumes) comes at most one interval late on a small or off-screen actor. W9F: a clip change that
  blends (Babylon steps a blend once per evaluation, blendingSpeed 0.08) updates the actor every frame until the blend
  is done (13 frames), so a far actor blends as fast as a near one (CPU-2); and the LOD runs only with the new look on
  (`animLod` follows `modernGraphics` unless pinned): with the preview off every pose updates every frame, as before
  wave 9 (the Low guard, LG-5; the user may choose to let N100 Low players keep it).
- **Graphics warm-up** (`screens/warmup.ts`, screens/world.ts): on world entry (before the loading picture goes) and
  after a switch that changes the material path or the render and sky blocks (a short loading picture of its own), the
  regions within 200 m of the player stream with the boot budget, every enabled mesh is asked `isReady(true)` (WebGL2
  compiles the programs in parallel, WebGPU makes its shader modules, in view or not), the camera turns once round
  (WebGPU makes its render pipelines at the first draw), then a few quiet frames; at most 20 s. The watchdog does not
  judge meanwhile and its grace starts again after. Hiding the world while the regions stream was tried and dropped:
  the rebuild is bound by the region fetches and decodes on the main thread, not by the draw.

Measured on the production bundle (`vite preview`), 1920 × 1080, RX 9060 XT + Ryzen 5 9600X. The machine was shared
with other lanes' browsers and, for most of the session, the 9B SDXL job on the GPU, so whole-frame A/B pairs moved
by ±30 % between pairs; the animation numbers below are a synchronous microbenchmark (the LOD tick, `scene.animate()`
and the actors' `Skeleton.prepare`, simulated 16.7 ms frames, medians of 3 rounds) and the frame's own animation
segment, which do not depend on the rest of the machine. Raw rows: `work/tmp/w9a-perf3/`.

| Scene (WebGPU, High) | Animation step, ms | Skin matrices, ms | Frame animation segment, ms (A/B medians) |
|---|---|---|---|
| Plaza (23 actors, 6,178 animatables) | 2.47 → 0.80 | 1.01 → 0.27 | 2.57 → 1.52 |
| Crowd (45 actors: 20 Mangnyang + NPCs) | 1.46 → 0.76 | 0.92 → 0.40 | 2.97 → 1.72 (4 pairs) |

- Garbage (allocation sampling, CDP, plaza, High): the interpolation's ~145 KB a frame (about 15 % of ~1 MB) is gone.
  The rest is not animation: ShadowGenerator.isReady rebuilds and joins its define list per caster submesh per cascade
  (~150 KB a frame), a few fx StandardMaterials whose defines go dirty every frame (map portal and smoke effects,
  ~50 KB), the fx renderer's geometry rebuild (~110 KB), WebGPU pipeline-cache lookups (~50 KB) and iterator objects.
- Whole frame, crowd, High, CPU p50 / p95 ms (medians of 3–4 alternating pairs, all three off → on): WebGPU 15.6 / 21.1
  → 15.0 / 19.5; WebGL2 9.9 / 12.5 → 8.4 / 10.7 (about 100 → 112 fps). WebGL2 Medium, crowd: 100–147 fps before and
  ~117 after in the undisturbed pairs, well above 60. GPU (timestamp queries, lock held): 3.6 ms at the plaza and the
  crowd at High. The High crowd's p95 did not reach 16.7 ms on WebGPU in this session; the frame outside animation
  (mesh evaluation ~4.3 ms, main draw ~4.9 ms, shadows ~2.5 ms) is where the rest is.
- Switches, WebGPU High, frames per second after the Options change: Modern on without the warm-up played 23 s at 0–21
  fps (still 31 fps at 23 s); with it, 18.7 s of loading picture, then about 5 s at 20–30 fps while the farther regions
  stream in, then 50–60. Modern off: 12 s at ~20 fps before, 12.5 s of loading picture then 60 fps after. A preset
  switch (Medium → High) took 4.8 s of loading picture. World entry: the warm-up adds 8–11 s to the loading picture on
  WebGPU (most of it the camera turn: every pipeline in range is made then instead of during play); on WebGL2 it ends
  at the 20 s cap (the programs compile slowly there).

Seen while measuring, not in this lane: on WebGL2 at High some terrain tiles' fragment shader failed with "texture
image units count exceeds MAX_TEXTURE_IMAGE_UNITS(16)" (the working tree carried the TX-R terrain changes at the
time), and a path switch re-fetches and re-decodes every region (the rebuild's 8–11 s is that, not the budget).

---

## 12. Memory and download budgets

Bytes per texel with a full mip chain (× 1.33): RGBA8 5.3, BC7 or BC5 1.33, BC1 or BC4 0.67.

The texture lane's inventory (`work/tmp/texpipe/inventory.json`, the 307-region field area) counts **788 world
model textures totalling 41.4 Mpx** at retail size (average 229², mostly 128–256), **104 terrain tiles** of 512²
(27 Mpx) and **321 actor textures** (22.7 Mpx) [confirmed: read from that file].

| Set (whole field area) | Retail today (RGBA8) | 2× upscale, RGBA8 | 2× upscale, BC | 4× upscale, BC |
|---|---:|---:|---:|---:|
| World model albedo | 220 MB | 880 MB | 220 MB | 880 MB |
| + normal + ORM | — | + 1.76 GB | + 330 MB (BC5 + BC1) | + 1.3 GB |
| Terrain tiles (albedo + normal + rmh) | 145 MB (albedo) | 580 MB + 1.16 GB | 145 MB + 220 MB | 580 MB + 870 MB |
| Actors (albedo + normal + ORM) | 120 MB | 480 MB + 960 MB | 120 MB + 180 MB | 480 MB + 720 MB |

Streaming holds only the resident regions' models and tiles (FIELDS.md §3.5: a 5×5 window, at most 80 tile layers
at medium), roughly a third to a half of the world rows. Characters on screen are a handful of the 321.

Conclusions:

1. **GPU texture compression is a prerequisite for PBR map sets.** Without it, a 2× upscaled set with normal and ORM
   maps costs about 1.3 GB resident for the world alone, beyond what a browser tab on an 8 GB laptop with shared
   graphics memory can hold. WebGPU exposes `texture-compression-bc` on desktop GPUs [likely: D3D12/Vulkan desktop
   adapters in Chrome list it; the bench did not log adapter features]. The engine must request it explicitly,
   because Babylon requests no optional features by default (§3.5). The route is **KTX2**, transcoded at load time
   by Babylon's KTX2 decoder. Its transcoders are UASTC → ASTC or **BC7** (else RGBA8/R8/RG8), and ETC1S (the MSC
   transcoder) → BC1/BC3 or ETC. There is **no BC5 target** [confirmed: the transcoder list in
   `khronosTextureContainer2.js`]. So normals ship as UASTC → BC7, which costs the same 1 B/texel as BC5, and the
   table's numbers hold. Albedo ships as UASTC → BC7, or ETC1S → BC1 (0.5 B/texel, lower quality). This needs an
   encoder (`basisu` or KTX-Software `toktx`, native installs, §15). It also needs the decoder module and the wasm
   transcoders vendored under `out-opt/_decoders/`: Babylon loads them from its CDN by default
   (`KhronosTextureContainer2.URLConfig` via `Tools.GetBabylonScriptURL`), which the project avoids (ASSETS.md §6,
   TERRAIN.md §8).
2. **Until KTX2 exists:** Medium uses retail-size (or 2× upscaled) **albedo only**, with class defaults for roughness
   and no normal maps. High may add normal and ORM maps at 2× for the ~60 hero textures (town walls, roofs, paving,
   the 5 tree species, the plaza tiles): about 250 MB (60 × 512² × 3 maps × 5.33 B). The terrain arrays come **on top
   of that**, allocated at the full `tileLayers` capacity (96 on High, §6.1). At 1024² albedo + 512² normal + 512² rmh
   they take about 0.8 GB (537 + 134 + 134 MB), which is too much for an iGPU. So without KTX2, High keeps 512²
   terrain arrays (about 0.4 GB for all three) or lowers `tileLayers`. The earlier figure of "about 250 MB resident"
   for heroes plus 1024² terrain was wrong.
3. **With KTX2:** High uses 2× sets everywhere (about 400–450 MB resident), Ultra 4× for the terrain tiles and the hero
   textures.
4. The renderer fetches only the current preset's resolution; the texture lane budgets download size.

---

## 13. Geometry: what a "real AAA" pass would need (for the user)

This spec cannot fix low-poly silhouettes. When the user wants to go further, in order of visible payoff per asset:

1. **Jangan city walls, gates and towers** (5–8 models, seen from everywhere in town).
2. **The 10 most-placed houses and roofs** (placement counts from `manifest.placements`; Meshy or hand modelling,
   2–10 k triangles each, reusing the upscaled textures as a base).
3. **5 tree species** as real 3D trees with 2–3 LODs (`tre_maple01`, `tre_willow01`, `tre_bank01`, pines), with wind
   vertex colours.
4. **Characters**: the biggest effort (skinning to the 43-bone retail skeletons, all equipment variants); last.

The renderer supports all of this without change: new glbs with PBR materials go through the same path, and a
`lodDistances` field in the sidecar would drive Babylon `addLODLevel` (a later spec).

---

## 14. Build plan

Order: **RND-0 first** (seams, small). Then **RND-M, RND-T, RND-L and RND-P in parallel**. Then **RND-W**. **RND-G**
and **RND-I** close. Classic (Low) must look exactly as today after every lane: a headless (NullEngine) test asserts
that Low builds today's material classes, shaders and defines, and the viewer's `?render=classic` is the visual
reference.

New code goes into two folders of `@sro/world-render`: `src/render/` (lighting, shadows, post, weather,
quality) and `src/pbr/` (material plugins, classes, map sets). Every plugin ships WGSL **and** GLSL, and a unit test
asserts that both languages return the same set of injection-point keys.

### RND-0: seams (one agent, first)

- **Owned:** `packages/world-render/src/render/quality.ts` (new: `RenderQuality`, `RENDER_PRESETS` low/medium/high/ultra,
  the §10 table as data), `render/weather.ts` (new: `RenderWeather`, `CLEAR_WEATHER`; agree the type with the
  weather lane, which produces it), `render/index.ts` (new: `WorldRender` class
  skeleton with `setQuality`, `setWeather`, `update(camera)`, `dispose`; no features yet), `world.ts` (`WorldQuality`
  adds `'ultra'`; `QUALITY_PRESETS.ultra`; `QualitySettings.render?`; `LoadWorldOptions.render?: 'classic' | 'pbr'`;
  `World.render: WorldRender`; `update()` calls `render.update`; `World.setWeather` itself is the weather lane's), `stream.ts` (`STREAM_DEFAULTS.ultra`
  = high), `objects.ts` (`loadGlb(scene, assets, rel, opts?: { srgb?: boolean })`, the only change there),
  `index.ts` exports.
- **Hook points:** `World.update` (after `applyEnv`), `World.setQuality`, `World.dispose`.
- **Tests:** `packages/world-render/test/render-quality.test.ts` (every preset has every key; Low has every feature
  off; `SkyState` → light mapping: direction = −keyLight.dir, intensity 0 keeps the light enabled at 0 so the light
  count never changes).
- **User-visible:** nothing changes (Classic is the default until RND-G).

### RND-M: PBR materials for objects and characters

- **Owned:** `pbr/classes.ts` (the §3.3 table + `classify(key, hints)`), `pbr/maps.ts` (the `sro-remaster`
  manifest parser generalised from `apps/game/src/three/remaster.ts` `parseRemasterManifest`, plus the §3.2 optional
  fields, a ref-counted texture cache like `ObjectMaterials.lightmaps`, and the per-preset resolution cap;
  `remaster.ts` then imports it — agree the move with the lane that owns `remaster.ts`), `pbr/surface-plugin.ts`
  (`SroSurfacePlugin`: class defaults, luminance roughness, baked visibility and the AO share from the object lightmap
  §3.4, wetness §9.2, the emissive night factor), `materials.ts` (`ObjectMaterials.convert` gains the PBR branch
  `toPbr` beside `fromPbr`, chosen by `World.render.mode`; `SidecarMaterialLite.texture`).
- **Hook points:** `ObjectMaterials.convert` (called from `objects.ts` `load`, line 215, and the region streamer in
  `stream.ts`, line 368; `model-cache.ts` only holds the converted entries); `SroSurfacePlugin`
  is attached by `WorldRender.decorateCharacterMaterials(container)`, which RND-G calls from `ModelLibrary.loadFrom`.
- **Tests:** `pbr-classes.test.ts` (Jangan texture paths → expected classes, for the 40 most-used textures as fixtures);
  `pbr-plugins.test.ts` (both languages, same keys; the defines toggle; NullEngine: a `PBRMaterial` with the plugin
  reports `isReady`); `pbr-maps.test.ts` (index parsing, missing maps fall back, the resolution cap picks `@1024`).
- **Budget:** object materials on Medium at ≤ +0.3 ms GPU (1080p, dev GPU) over Classic, and +0 ms CPU (the same
  meshes and draw calls).
- **User-visible:** in the viewer (`?render=pbr`), Jangan buildings shade with the sun and sky; roofs have highlights;
  object lightmap shadows still read under the eaves.

### RND-T: PBR terrain

- **Owned:** `pbr/terrain-plugin.ts` (`SroTerrainPlugin`, with the prototype in `work/tmp/render/bench.ts` as the
  starting point: splat, baked visibility, roughness; then per-layer normals and rmh, height blend, triplanar, detail,
  anti-tiling, parallax, puddles and ripples per preset defines), `terrain.ts` (`buildRegion` PBR branch: normals,
  one `PBRMaterial` + plugin per region; `setParams` forwards to the plugin; the Classic branch unchanged),
  `tile-atlas.ts` (parallel normal and rmh arrays with the same layer index), `region-chunk.ts` (`commitTerrain`:
  neighbour-aware normals; recompute the edge normals of loaded neighbours).
- **Hook points:** `TerrainRenderer.buildRegion`, `TileAtlas.acquire`, `RegionChunk.commitTerrain`.
- **Tests:** `terrain-normals.test.ts` (a flat region → (0, 1, 0); a 45° ramp; the edge normals of two neighbours are
  equal); `tile-atlas.test.ts` extended (all arrays share a layer; release frees all three); a headless
  `buildRegion` test for both paths.
- **Budget:** terrain PBR splat at ≤ +0.5 ms GPU at 1080p on the dev GPU for High versus Classic; Ultra parallax
  ≤ +0.5 ms more.
- **User-visible:** hills catch the sun and fall into shade as the time changes; baked shadows of buildings on the
  ground stay; grass and dirt no longer look like a flat decal from low angles.

### RND-L: lighting and shadows

- **Owned:** `render/lighting.ts` (the celestial light and the SH from `SkyState`, `SkyEnvironment`: the CPU-built
  `RawCubeTexture` with its Worker and per-face uploads), `render/shadows.ts` (`ShadowProxies` — the per-region
  merged caster mesh, with `work/tmp/render/bench.ts` `csm(..., 'proxy3')` as the working prototype — and
  `ShadowCasters`: the CSM per preset, the render list by distance, characters via `WorldRender.addCharacter(mesh)`), `render/night-lights.ts` (the `ClusteredLightContainer`; emitters from
  `AmbientFx`'s emitter list and lantern placements; nearest N), `objects.ts` (`placeStatic`, `placeClone`,
  `removeRegion` call `shadows.add` / `remove`), `ambient-fx.ts` (expose `emitters()` read-only). `sky.ts` and
  `SkyState` are the sky lane's (docs/SKY.md); this lane only reads them.
- **Hook points:** `WorldRender.update` (light and SH from `SkyState` every frame; sky cube on change; casters every 8 m).
- **Tests:** `lighting-sh.test.ts` (a constant sky projects to an SH whose irradiance is that constant × π, within 1%;
  a sky black below the horizon gives zero irradiance for a down-facing normal); `shadows.test.ts` (the proxy of two
  thin-instance chunks has the summed triangle count and the instances' world positions; the distance filter; foliage
  only within 60 m; remove on region unload; no caster beyond `shadowMaxZ + radius`); `night-lights.test.ts` (nearest N, re-pick
  after 2 m, `night` 0 at noon).
- **Budget:** CSM at High ≤ 1.0 ms CPU on the dev PC in the town view (the bench's proxy rule measured +0.75 ms; the
  naive caster list +43 ms, §11.2). One sky-cube refresh ≤ 2 ms on the main thread. The calibration of §4.1 (sun :
  ambient ratio, exposure) is this lane's, with RND-P.
- **User-visible:** buildings, trees and characters cast soft shadows that move with the sun; at night lanterns light
  the plaza; characters are lit like the world around them.

### RND-P: post-processing

- **Owned:** `render/post.ts` (builds and tears down the §5.1 stack per preset: TAA, SSAO2, SSR, VLS, Default, FSR1;
  exposure curve; tone map choice), `render/grade.ts` (`GradeMixer`: LUT strips → blended `RawTexture3D`),
  `pbr/fog-plugin.ts` (`SroFogPlugin`, registered globally for `PBRMaterial`; the shared height-fog uniform block),
  `packages/world-render/tools/make-render-textures.ts` (new: generates the LUT strips, water normals and the ripple
  atlas from parameters; writes `apps/game/public/render/`).
- **Hook points:** `WorldRender.setQuality` (rebuild the stack), `WorldRender.update` (exposure, LUT weights, white
  balance), `World.applyEnv` (the fog uniforms).
- **Tests:** `grade.test.ts` (identity LUTs blend to identity; weights sum to 1; no re-upload below 0.01 change);
  `post.test.ts` (the preset → pipeline list; the order; Low builds nothing); `fog.test.ts` (the height-fog integral
  at h → 0 equals the uniform exponential fog; 95% at the retail fogEnd).
- **Budget:** Medium post ≤ 0.7 ms GPU and ≤ 0.5 ms CPU at 1080p on the dev PC (measured +0.34 ms CPU for HDR +
  bloom + FXAA); High (TAA + SSAO half + bloom) ≤ 2 ms GPU and ≤ 1 ms CPU.
- **User-visible:** a warmer, deeper image; soft contact shadows in corners (SSAO); lanterns and the sun bloom; the
  evening turns golden and the night blue; Options → Graphics → Tone mapping switches Neutral/Filmic live.

### RND-W: water, foliage, grass, rain response

- **Owned:** `pbr/water-plugin.ts`, `water.ts` (PBR branch), `pbr/foliage-plugin.ts` (translucency, wind, and its
  `ShadowDepthWrapper`), `scatter-assets.ts` (the grass shader pair: N·L, SH, translucency, per-vertex CSM tap, height
  fog, wetness, the `SRO_HDR` define), `scatter.ts` (uniform plumbing only), `render/rain-occlusion.ts` (§9.4).
- **Coordinates with:** the weather lane (rain particles read `rainOcclusion`; wetness rates are theirs). If the
  weather spec already defines the puddle mask, ripple atlas or occlusion map, adopt its numbers and keep only the
  hook positions of this spec.
- **Tests:** `water-pbr.test.ts` (wave type → amplitude; shore alpha from depth); `foliage.test.ts` (both languages;
  the wind phase is deterministic per root); `rain-occlusion.test.ts` (a point under a roof box → exposure 0; open
  ground → 1).
- **Budget:** water ≤ 0.3 ms GPU; grass upgrade ≤ +0.3 ms GPU at medium density; rain response ≤ +0.5 ms GPU on
  terrain (the weather lane measured about +6.6 ms for its wet-terrain probe at 100× overdraw, i.e. ~0.07 ms per
  full-screen pass: comfortable).
- **User-visible:** the pond reflects the sky and shimmers; trees glow green when the sun is behind them; in rain the
  plaza darkens and gleams, puddles form in hollows with ripples, and the ground under roofs stays dry.

### RND-G: game integration and options

- **Owned:** `apps/game/src/screens/world.ts` (disable the hemi/character sun on PBR presets; `ModelLibrary`
  hook for character materials; feed `World.setWeather` from the weather lane's client state; pass the time of
  day from the server clock when that lane provides it), `apps/game/src/settings.ts` (`PRESETS` adds `'ultra'`;
  `graphics.advanced` block: shadows, ao, reflections, aa, toneMap, lightShafts, each `'auto'` or a value; the
  first-run detection of §10; `applyGraphics` hands the resolution to FSR), `apps/game/src/hud/options.ts` (rows:
  preset with Ultra, Advanced sub-rows, tone map), `apps/game/src/engine.ts` (request the adapter's `maxInterStageShaderVariables` — **required**, §3.5 —
  and `texture-compression-bc` when the adapter has them. `setMaximumLimits: true` plus an explicit `requiredFeatures`
  list filtered to the adapter's features is the simplest form, §3.5. Also expose the granted limit so presets can
  drop the prepass at 16. `antialias` is fixed when the engine is created; it cannot be switched per preset without
  recreating the engine. Keep it on for Classic; on the PBR presets the scene renders into the pipeline's target, so
  canvas MSAA only costs memory there), `apps/game/src/world/fx/hit-light.ts` (join the cluster),
  `apps/game/src/hud/perf-overlay.ts` (show render mode and preset), i18n strings for the new rows.
- **Tests:** `settings.test.ts` extended (old saved settings without `advanced` normalise; `ultra` accepted; first-run
  detection per adapter fixture); `options.test.ts` rows.
- **User-visible:** Options → Graphics shows Low (Classic) / Medium / High / Ultra and an Advanced section; switching
  from Low asks to confirm and reloads materials in about 2 s.

### RND-I: lab, bench and sign-off

- **Owned:** `apps/viewer/src/world/main.ts` (query `render=classic|pbr`, `preset=`, `weather=`, and a time scrub
  that already exists), `apps/viewer/src/engine.ts` (the same `maxInterStageShaderVariables` request as the game), `apps/viewer/src/world/render-panel.ts` (new: live toggles for each §10 row, exposure, tone
  map, LUT key, wetness; a "bench" button that runs the `work/tmp/render/bench.ts` method and prints the table),
  `apps/viewer/world.html` (panel mount).
- **Tests:** none beyond the lanes'; this lane produces the §11 table for the final build on the dev PC and, if the
  user can, one integrated-GPU laptop.
- **User checklist** (in the browser, viewer and game):
  1. Low looks exactly like before (compare screenshots at the gate, t = 0.5).
  2. High at noon: shadows under the gate and the trees, soft AO in corners, no shimmering shadow edges while turning.
  3. Scrub the time from 0.2 to 0.8: the sun rises in the east, shadows sweep, the evening goes golden, night is blue
     with lanterns lit and blooming.
  4. Set weather to rain: the ground darkens within a minute, puddles in hollows with ripples, the plaza reflects,
     nothing under the gate roof gets wet, fog thickens.
  5. Ultra: light shafts through the trees at sunrise; parallax on paths up close.
  6. The frame time in the perf overlay stays under 16.7 ms on High on the dev PC, and the preset watchdog never
     triggers there.
  7. WebGL2 (`?engine=webgl`): Low renders; Medium renders without errors.

---

## 15. What we need from the user

Nothing has to be downloaded or installed for the renderer itself: everything in this spec is in
`@babylonjs/core` 9.28.0, which the repo already has [confirmed]. The asks are:

1. **A decision on the default look.** Is Classic (today's look) kept as the Low preset, as proposed, and is PBR
   Neutral tone mapping (faithful colours) the right default over ACES (punchier, more "filmic")? The lab (RND-I)
   shows both side by side.
2. **For High and Ultra textures: approve one tool install** (a question for the texture lane too): the Basis
   Universal encoder (`basisu`) or KTX-Software (`toktx`), native binaries. Plus fetching Babylon's KTX2 transcoder
   files once to vendor them under `out-opt/_decoders/`, as was done for the meshopt decoder. Without GPU texture
   compression, upscaled PBR sets cost 4–8× more VRAM (§12), and High must cap textures at 1024².
3. **Which GPUs the friends have** (a list, or "laptop / desktop" per person). The first-run default (§10) and the
   integrated-GPU numbers in §11 are projections until one weak machine runs the lab's bench button.
4. **Optional, later: new geometry** (§13). Meshy output for the ~30 key Jangan assets would do more for the "AAA"
   impression than further shader work. Retail assets must never be uploaded to Meshy or Higgsfield; only new
   concept images or text prompts go out.
5. **Optional art direction:** reference screenshots of games whose look the user wants (e.g. a golden-hour town, a
   rainy street). They set the LUT keys (§5.2) and the exposure curve.

## 16. Open questions and risks

- **CPU is the bottleneck, not the GPU.** The renderer already spends 1.3–2 ms of JS per frame on the dev PC, mostly
  Babylon draw submission (289 active meshes in the town view), and the whole game about 6.7 ms (EFFECTS.md §7).
  Anything that multiplies draws (shadow cascades, the geometry buffer, light shafts, planar reflections) costs CPU
  first. Shadow proxies fixed the cascades (+43 ms → +0.75 ms, §4.3). RND-L should also evaluate Babylon's WebGPU
  **snapshot rendering** (render bundles, `engine.snapshotRendering`) for the static chunks [unknown: its interaction
  with thin-instance buffers, streaming and cascades].
- **The inter-stage variable limit on players' GPUs** (§3.5) is [unknown] per machine. D3D12 and Vulkan desktop
  adapters usually expose more than 16 (the dev GPU: 28); an adapter capped at 16 gets Medium at most.
- **Retail textures have painted light.** PBR lighting over painted shadows and highlights looks muddy (double
  shading). The texture lane's de-lighting quality decides how far the remaster gets; the `delit` flag lets the
  renderer lower the direct light on non-delit sets (`directIntensity` 0.8) as a stopgap [our rule].
- **Calibration** (§4.1): the sun-to-sky ratio, exposure and the lightmap floors (0.61 terrain, 0.55 objects) are
  [unknown] until RND-L and RND-P tune them against Classic screenshots at noon. The bench's untuned first try washed
  shadows out completely; the look depends more on this than on any single feature.
- **Baked shadows vs a moving sun** (§3.4): the fade-out away from the retail direction is our rule and needs a
  visual review; alternatively bake new lightmaps later (out of scope).
- **Terrain seam normals** (§3.5) until neighbours are loaded. Heights are bit-identical at seams, so only normals
  matter.
- **Babylon details still [likely]:** the regex injection for AO (it replaces the match, §3.5),
  `CUSTOM_FRAGMENT_UPDATE_ALPHA` for normals, the SSR mask through `specularEnvironmentR0`/`microSurface` at
  `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR` (§5.4), foliage translucency at `CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION`
  (§8.1), TAA with `reprojectHistory` and the grass jitter (§5.6), alpha-tested shadow casting on `PBRMaterial` (the bench's tree
  shadows looked cut-out, not measured), `ShadowDepthWrapper` for wind, `ClusteredLightContainer` on both engines,
  the sky cube's roughness mips, TAA ghosting with the orbit camera, and the pipeline order of the full Ultra stack.
- **The in-flight `remaster.ts` test switch** re-captures a sky `ReflectionProbe` every 30 s. With characters only
  that is cheap, but once world materials are PBR each capture would cost about 0.5 s (§4.2). The lead should tell
  that lane before both land.
- **Measurement hygiene.** Another lane's GPU probe and a game tab ran in the same browser during the first series and
  inflated four readings (SSAO 42 ms, TAA 30 ms and 4.4 ms, SSR 15 ms); all were re-measured with the minimum of 5
  runs (§11.2). Future benches must check that no other GPU page is running, and take the minimum.
- **Overlap with the weather spec** on puddles, ripples and the rain occlusion map: this spec fixes only the hook
  positions and the material response; where the weather spec defines the same function, its numbers win, and the
  lead should give one lane the shared WGSL/GLSL functions (proposed: RND-W).
- **WebGL2:** the terrain plugin's GLSL compiled and rendered with CSM and HDR in the bench [confirmed], but no
  WebGL2 timings were taken. WebGL2 players default to Low.
- **Legal:** all new textures in this spec (LUTs, water normals, ripples, detail textures) are generated by our own
  scripts, not taken from retail files or third-party packs.

## 17. Wave 11: the town part, cloth in the wind, the temporal override (docs/TOWN_LIFE.md, docs/WAVE_PLAN7.md §4.3)

- **`World.town`** (`packages/world-render/src/town/`, TL-C; W11-S's seam in `world.ts`): made on the PBR path only,
  after the wildlife, updated after `life` every frame, disposed with the world and made again by `setRenderMode`;
  `null` on Classic (Low), the Low guard. Its meshes carry the `'town'` tag, which the batcher refuses
  (`UNBATCHED_TAGS`). It draws the townsfolk as **baked vertex animation + thin instances**: one draw per dressed
  variant with someone in range (Medium 10 variants, ≤ 60 folk within 60 m; High 14 / 100 / 90 m; Ultra 18 / 140 /
  120 m), minus 3 folk per player in range beyond 5 (never below 15), and `Town life: Low` halves the counts. On
  Medium no townsfolk are drawn with 15 or more players in range (WAVE_PLAN7 cut 20, applied after LAB-11's G1 run; the
  animals, pigeons, motion and sound stay, and the town's bed keeps the schedule's count). VAT
  animals (chickens, cats, dogs) on the same path; pigeons and ducks are wildlife species. One instanced blob draw
  for the shadows on every preset (crowd casting through the CSM is built but off, G2). No live skeleton, no per-frame
  allocation after the warm-up; the crowd's effects compile at world load through `warmup-hooks.ts`.
- **Who is where** is a pure function of the server clock (`town/schedule.ts`, TL-R, on `town.json`): every client
  draws the same person at the same spot (two clients 80 ms apart within 0.15 m; WebGPU and WebGL2 measured within
  0.02 m by I-11). The schedule caches who is out per trip; since I-11 the cache follows the world clock (a clock that
  arrives after the first frame, or a GM `/time`, takes effect at once on every client). The unique's appear notice
  plays a cosmetic 60 s alarm (walkers hurry to the nearest door, guards to the south gate); a client that enters
  during it sees the normal schedule (no replay, D19) and the two views meet again once the walkers are back (≈ 1–2
  minutes).
- **Clicks**: the crowd meshes are not pickable; the town pick runs after the world screen's move intent and never
  consumes the click (a click on a walker moves the player and the walker answers with a bubble).
- **Cloth** (TL-M, W11-S's `+sheen` pivot): banners, flags and awnings named by the converter's cloth reclass
  (`models[].cloth = [{material, kind, pinY?, height?}]`) get a 4-float per-piece pivot in their region's `+sheen`
  batch group (pin line, hanging height, kind, phase), and the foliage plugin's `SRO_CLOTH_WIND` slot sways them in the
  vertex shader (`town/cloth-chunk.ts`). Same geometry and draws as without; no new uniform, sampler or varying.
- **Motion layers** (`town/fx.ts`): chimney smoke, kitchen steam and fountain spray as lit puffs, falling leaves (≤ 150
  Medium, 250 High), and the ripple points (fish, the fountain) fed to `WaterRenderer.setRipplePoints`; ≤ 2 draws.
  **Dressing** (`town/decals.ts`, TL-B): the decal layer and the pond profile (`WaterRenderer.setProfile('town', …)`).
- **The temporal override** (`RenderPost.setTemporalOverride(owner, 'none' | 'msaa4')`, D4): on High and Ultra the
  town part asks for MSAA ×4 in place of TAA while the player is near the town (with a hysteresis), so walking
  townsfolk never smear (G5); the last owner's `'none'` brings TAA back. Medium has no TAA and is unchanged.
- **Budgets and the LAB-11 measurements**: `Dropbox wave11/budgets.md`.

## 18. Wave 12: the new trees, the terrain remaster, the editor's seams (docs/TREES.md Part W, docs/TERRAIN_TEX.md, docs/WORLD_EDITOR.md, docs/WAVE_PLAN8.md)

- **The tree swap** (`batch/trees.ts`, T12-M; the source on `BatchHost.treeSwap`, W12-SA): on the PBR path with
  batching and `graphics.trees: 'new'` (Medium and up), every placement of a retail tree or plant model that carries
  `WorldModel.treeSwap` (110 models, 4,886 placements) merges the species' LOD1 and LOD2 into its region batch instead
  of the retail mesh, with the swap's fit and offset folded into the matrix and the placement's uniform `scale`
  (S-SCALE) on top; the retail glb is never fetched. Draws per region stay what wave 10 batched (the merge absorbs the
  geometry); the vertex is 60 B (`sroPivot` vec4: slot × 4 + tier in `.w`; `sroTreeW` unorm8x4 wind data). The caster
  takes tier 1 only. Classic (Low) and `'retail'` never swap: the Low guard. `World.setTreeMode` rebuilds the regions.
- **The band byte** (`trees/bands.ts`, T12-N): each swapped placement gets a slot (≤ 8,192) in an R8 texture: 0 near
  (the LOD0 overlay draws it), 1 mid (merged LOD1), 2 far (merged LOD2), 3 hidden (the editor's drag and delete).
  Trees: near < 40 m, mid < 110 m; plants: near < 25 m; × the range scale (Options' sight, 0.6 on the character
  screens), 3 m hysteresis, refilled when the camera moved 4 m. The merged vertex shader (`SRO_FOL_BAND`, T12-W)
  collapses a vertex whose tier is not its band's to a zero-area triangle; `SRO_FOL_VDATA` reads the wind data (the
  branches lag, reeds sway). No new varying, no new sampler beyond the band texture; WGSL and GLSL alike.
- **The LOD0 overlay** (`trees/near-field.ts`): band-0 trees of each species as thin instances of its `near.glb`, per
  species × leaf / wood, with the per-instance tint; drawn only once the region's batch has landed. ≤ 2 draws per
  species in band 0. **The crowded-plaza rule** (D24): on Medium with ≥ 15 players in range (the town part's count),
  the overlay draws within 20 m only. The species' effects compile at world load (`warmup-hooks.ts`).
- **The terrain remaster** (TT-B, TT-R, TT-Q): all 108 tiles have a texture set (88 new this wave, the painterly
  ground rule). Medium samples every tile's remastered 512 albedo and the ORMH maps of the 63 **hero** tiles; High
  adds normals and the 1024² tier for heroes. The set range (`stream.ts` `tileSetup`, `tile-atlas.ts`
  `planSetRange`) admits only hero sets, `min(48, hero)` layers deep, its last 8 layers reserved for tiles at or above
  the median cover; a non-hero set keeps its remastered albedo in a layer above the range. **Medium shading** gains
  the detail layer (1.5 m period, one texture unit) and anti-tiling (a rotated 0.73× second tap; on High it reads
  `sroTilesHi` under `SRO_T_TIER`); paving opts out through the no-anti-tile bit (64) of the layer map's alpha
  (`pbr/classes.ts` `NO_ANTI_TILE`, set by `terrain.ts` `layerData`, masked `& 63` in the shaders). Medium's terrain
  stays at ≤ 14 of WebGL2's 16 units. `texpipe hero <tile> on|off` flips a tile's hero bit (index only, no re-encode);
  the editor's Publish calls it for a tile painted past 0.1 % cover.
- **The editor's seams**: `LoadWorldOptions.regionFilter` (decode-time), `WorldObjects.setEditorOwned` (placements the
  editor draws itself), `RegionStreamer.reloadObjects(rx, rz, { placements })` (one region re-batched and swapped in,
  ≤ 50 ms), `TerrainRenderer.updateRegion(id, { heights, words, lightmap })` (S-TERR, ≤ 1 ms per region, the same
  `layerData` as the build), grass masks (`GrassField.setMask`), light points in the night-light splat, and
  `World.trees.preview / setHidden` (T12-E). With no edits the game draws nothing new (G7).
- **Budgets and the LAB-12 measurements**: `Dropbox wave12/budgets.md`.

## 19. Wave 12: retail UV scroll (the waterfalls flow)

- **What retail does** [confirmed: `packages/formats/src/bsr.ts`, the census `work/tmp/uvscroll/census.md`]: a BSR's
  always-on (AMBIENT set) `texAni` ModData is a per-second D3D texture transform; its translation (`matrix[8]`,
  `matrix[9]`) is the U / V scroll in texture repeats per second. In jangan-fields 23 materials in 23 models carry one,
  all V-only: the dragon fountain (`cj_wf_dr.cpd`, parts 01..05: `pokpo2` MASK at −2.78 V/s, `pokpo1test` BLEND at
  −2.0 to −2.3), the palace waterfalls (`oa_ho_waterfall01`, ×4), `cj_waterfall02` (×16) and the turtle falls (×2).
  Two (`waterfall-turtle0x-3`) drive the second (multi-texture) stage, which the renderer does not draw: reported, not
  exported (their own texture stays still, as before).
- **The converter** (`gltf/convert.ts` `textureScrolls` / `materialScroll`): the sidecar material gets
  `uvScroll: [u, v]` (additive; absent = still). Non-finite or |rate| > 16 is dropped with a warning; a zero rate is no
  scroll; a scroll on the multi-texture stage is a warning. glTF UV space keeps D3D's V direction (V down), so the
  negative retail V rate flows the sheet down from the dragon's mouth.
- **The renderer** (`uv-scroll.ts`, `SroUvScrollPlugin`): ObjectMaterials puts the plugin on every converted material
  whose sidecar carries a valid scroll, on both paths (Classic `StandardMaterial` on Low, PBR on Medium and up). It adds
  one vec4 uniform (`sroUvScroll`, the phase) to `uvUpdated` in the vertex shader under `SRO_UVSCROLL`, so every UV1
  texture of the material moves together; WGSL and GLSL alike; no varying, no sampler, no fragment code (not Babylon's
  `uOffset` / `vOffset`: a texture matrix gives the texture its own varying, and the lightmapped CSM receivers sit at
  the 16 inter-stage limit). The phase is `fract(seconds × rate)` in doubles on the CPU from the world clock
  (`World.serverNow`, the synced server time), so every client shows the same phase and the GPU never sees a large time.
- **Batching** (docs/BATCHING.md §3.7): a scrolling material is `separate` (`MaterialBatchRecord.uvScroll`): never a
  table slot (an atlas cell cannot move); it keeps its converted material in a region-batch material group, so the
  plugin runs. At the plaza only `cj_wf_dr_01` (the MASK sheet) leaves the table (+1 draw); the BLEND parts were
  separate already. A scrolling cut-out casts no shadow (the shadow pass would alpha-test a mask that stands still).
- **Cost** [confirmed: measured 2026-10-03, plaza noon, Medium, 1920 × 1080, DPR 1, 400 frames per run; raw JSON in
  `work/tmp/uvscroll/shots/timing_*.json`]: interleaved on one page (11 plugins at the plaza, scroll on / off), frame
  p95 WebGPU 7.0 (6.9–7.3) vs 6.9 (6.8–6.9), WebGL2 4.9 (4.5–4.9) vs 5.1 (4.9–5.4): within the noise. Draws 180–186
  either way. Separate pages (export without / with the scroll) read 7.2 / 7.2 before and 8.4 / 9.7 after, but every
  CPU segment moved together (another lane's process kept the CPU at ~18 %), so the in-page A/B is the number.
- **The Low guard**: Low draws the waterfalls flowing too (the task: both paths; the retail client scrolls on every
  setting); everything else on Low is unchanged (no new define elsewhere, the same effects for still materials).
