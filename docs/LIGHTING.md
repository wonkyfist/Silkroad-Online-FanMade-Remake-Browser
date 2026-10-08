# World lighting: the AAA pass (2026-10-07)

The user: "We need volumetric lighting, good lighting … make our lighting feel like it came from a AAA game. But make
sure performance is good." Medium, High and Ultra only; **Low (Classic) is untouched** (none of this is built on the
Classic path; test/lighting-aaa.test.ts and the Low guard tests check it).

Most of the modern stack already existed (docs/RENDER.md §4–5): a dynamic, prefiltered sky cube + SH ambient (§4.2),
KHR PBR Neutral / ACES tone mapping with the sky's per-time-of-day exposure and LUT grade (§5.2), shadow-map sun shafts
at dawn and dusk (§5.5, render/volumetrics), height fog with sun scatter, CSM with PCF, SSAO on High/Ultra, bloom
(Options). This pass adds what was missing. Each piece has a switch in `render/look.ts` `LIGHT_LOOK` for the A/B
(`__sroCharBench.look({...})` on a bench page); all are on.

| # | What | Where | Presets |
|---|---|---|---|
| 1 | **Sun-lit ground bounce** in the ambient SH | render/lighting.ts `groundBounceRadiance`, `addGroundSH`, `GROUND_BOUNCE` 0.15 | all PBR |
| 2 | **Eye adaptation** (bounded GPU auto exposure) | render/adaptation.ts `EyeAdaptation`, post stage `'adapt'` | Medium, High, Ultra |
| 3 | **Lantern glow volumes** (night lamps scatter in the air) | volumetrics/shafts.ts `pickGlowLights`, the shafts composite | wherever the shafts run |
| 4 | PCSS soft sun shadows (contact hardening): **wired, shipped off** | render/shadows.ts (`ShadowQuality.soft`, 0 on every preset) | — |
| — | Options label "Light shafts" → **"Volumetric light"** (it carries 3 now) | i18n en-render.ts | — |

## 1. Ambient: the ground bounce

The sky's ambient below the horizon was only the *sky's* irradiance × 0.25, so everything facing sideways or down
(shaded walls, eaves, gate passages, the undersides of characters) was lit by a dim blue copy of the sky: the cold,
dark-blue shade of the old screenshots. Now the key light's irradiance on level ground comes back up as Lambertian
radiance `E · 0.15 / π` (albedo × the share of the ground in sun), projected exactly onto the lower hemisphere of the
L1 SH. An up-facing surface gets exactly nothing from it (the RENDER §4.1 calibration — direct : ambient 5 : 1, white
2.15 — holds); a wall gets π/2 × the radiance, the ground-facing side π ×. Warm at golden hour, moonlit at night,
gone in a storm (the key dims). CPU only (a few multiplies per frame). The own licensed character's environment cube
(self-env.ts, the character helper's) reads the world SH above the horizon only and keeps its own ground.

## 2. Exposure: eye adaptation

`meter` (the HDR scene → 32 × 18 log₂ luminance, 16 taps per cell, × the designed exposure) → `adapt` (one texel:
centre-weighted mean, target, temporal blend; 1 × 1 half-float ping-pong) → `apply` (scene × 2^ev, full resolution).
In the HDR chain after the shafts and before bloom and the tone map. No readback (`readState()` is for the lab).

The sky's designed exposure (SkyState.exposure × EXPOSURE_TRIM) stays the anchor: the keys are the measured means of
the open calibration views, so those are left as designed (plaza noon −0.03 EV). Only what the sky cannot know is
corrected, partially (strength 0.6): a gate passage or forest roof opens up (≤ +1.1 EV), a bright view closes
(≤ −0.6 EV). Opening is slow (τ 1.6 s), closing fast (0.6 s). Night gets +0.25 EV of lift (readable, not murky); a
storm lowers the key by up to 1.2 EV so the eye does not undo the storm (storm −0.17 EV). Tuning: `ADAPT`.

Measured means (log₂ exposed luminance, WebGPU High): plaza noon −2.71, fields 17:50 −2.33, tree road 07:10 −3.08,
dusk town 18:35 −3.59, plaza 21:30 −4.36, storm 14:00 −3.93, gate passage 10:00 −4.20.

## 3. Volumetric light

The shadow-map sun shafts (RENDER §5.5) were already real volumetric scattering with occlusion (trees, roofs, gates),
moon shafts at night, denser in mist and after rain. Added: **lantern glow** — the shafts' full-resolution composite
also adds the single scattering of the 6 strongest lit night lamps / town lanterns within 80 m, in closed form
(`∫ dt / (h² + (t − t_c)²)` along the view ray up to the depth, windowed by the light's range; σ = the shafts' air
σ × 0.8, so mist and humid air make the halos bigger). Hit flashes and spell lights do not glow (`GLOW_SOURCE`). It
rides on Options → Volumetric light (Off removes it with the shafts).

## 4. Shadows

PCSS is wired (`ShadowQuality.soft` = Babylon's contactHardeningLightSizeUVRatio; 16 blocker + 16 PCF taps on High, 32
on Ultra; it keeps the comparison depth map, so the grass root tap — grass-chunks.ts `csmOf`, now PCF or PCSS — and the
shafts read it as before) but **every preset ships 0 (PCF, unchanged)**: in the look lab (fields, 17:50) the plaza's
shadows got the nice contact-hardening edge, but the shaded terrain slopes came out sunlit and glossy at any light size
(0.004–0.03), and it cost +1.3–2.3 ms GPU on WebGPU High.

Pass 2 found the cause, and it is not the terrain plugin (the terrain effect compiles with SHADOWPCSS0, 17 samplers, no
error): Babylon's CSM turns its depth clamp off under PCSS (`SM_DEPTHCLAMP 0`), so (1) every cascade's near plane must
reach every caster: ours came from the casters' bounding info, which the merged proxies under-report, and distant
terrain casters were clipped; and (2) the blocker search reads the depth metric from the colour shadow map, which Babylon
makes **r16float** (half float) when it can filter it: over the unclamped depth range (hundreds of metres) the blocker
depths quantise and the slopes read unshadowed. (1) is fixed (`pcssBounds`: a fixed box around the eye, the casters'
bounds frozen); (2) needs a float32 colour shadow map (`usefullFloatFirst`, which WebGPU only filters with the
`float32-filterable` feature, not requested by createEngine) or a tighter range. Until then every preset ships PCF.

**SSAO (pass 2):** stronger on High/Ultra (radius 1.5 → 2 m, strength 1 → 1.35). On Medium it was measured and not
shipped: +0.45 ms GPU but +1.5–2 ms CPU (the prepass) on a CPU-bound game (`ssao.optional` exists for a later try: it
drops itself where it would stop FSR).

## 5. Pass 2: daytime atmosphere and the cinematic grade

The user found pass 1 too subtle ("a visible AAA jump"). Every piece has a `LIGHT_LOOK` switch (the A/B "before" is all
of them off, which also restores the pass-1 grade `GRADE_TIME_V1` and shafts `SHAFT_TUNING_V1`).

- **Sun shafts all day** (volumetrics/shafts.ts `SHAFT_TUNING`): the shadow-map-occluded march (half res + temporal
  resolve on High/Ultra, quarter + the screen walk on Medium) now runs at 0.85 of its dawn strength at noon (was 0.35),
  gain 4 → 4.5, the "beams only" baseline 0.9 → 0.8 (some lit air reads as haze around them).
- **Atmosphere** (render/atmosphere.ts, PBR presets): the height fog is denser and nearer than the retail range by time
  of day: day ×1.25 (start × 0.6: aerial haze on the mid-distance hills), morning ×1.5 with a 35 m height falloff (mist
  that pools in hollows and fields), evening ×1.7 (golden haze), night ×1.15. The shafts take part of that density as
  in-scatter, so beams strengthen in the morning mist. Weather fog stacks on top. CPU only.
- **Cinematic grade** (render/grade.ts `GRADE_TIME`, new `GradeParams` fields): a filmic S-curve in display space
  (`curve` 0.25–0.4), warm-sun / cool-shadow split toning by luma (`split`, `shadowTint`, `highlightTint`), the
  **skin line** (`skin`: orange-red mid-saturation colours turn towards 34° hue, after the curve, with half the
  saturation boost) and **de-magenta** (`demagenta`: low-saturation lavender/magenta hues turn blue at dawn, dusk and
  night). Measured on ?newchar=1 (face crop): noon skin G/R 0.67 → 0.83, dusk 0.67 → 0.72, no lavender at night
  (bluish moonlight). The red lacquer (saturation > 0.8) is outside the skin line. Same LUT, no GPU cost.

## 6. WebGL2 High

Profiled with the lab (`__sroCharBench.renderPatch`, GPU timer query per arm, plaza): the shadow pass is the cost on
ANGLE/D3D11 (no shadows −3.3 ms; 2048² → 1024² −1.5…2.3 ms; SSAO −0.1…0.7, shafts ±0.3, TAA ±0.3). WebGL2 now caps
the cascades at 1024² (`WEBGL2_SHADOW_MAP_MAX`, shadows.ts `csmSettings(q, { webgl })`); WebGPU keeps 2048².

## Performance

`pnpm charbench --steps <lab.json>` (6 bots + 20 mobs at the plaza; scenes plaza / fields / storm / plaza 21:30), all new
lighting off vs on in interleaved pairs on one page, 300 frames each, RX 9060 XT, 1080p (medians):

| Config | GPU ms off → on | CPU p50 ms off → on |
|---|---|---|
| WebGPU High (plaza, fields, storm, night) | 2.85→2.88, 3.43→3.48, 3.01→3.07, 2.96→3.06 | 8.0→8.4, 6.7→6.9, 8.7→8.6, 9.1→9.6 |
| WebGPU Medium | 2.54→2.59, 1.94→1.98, 2.81→2.85, 2.57→2.63 | 5.7→6.2, 5.1→5.3, 6.5→6.5, 6.9→6.7 |
| WebGL2 High | 10.89→10.88, 4.34→4.43, 11.14→11.18, 11.12→11.17 | 12.6→12.7, 5.5→5.5, 12.8→12.6, 12.9→12.6 |

Per-feature CPU A/B (WebGPU Medium plaza, 3 interleaved rounds): off 5.87, all 5.97 ms (+0.1, within noise); the
metering is ≤ 0.1 ms every 2nd frame (`AdaptState.tickMs`). A first version with three chained post-processes cost
~0.5 ms of CPU and was replaced by the off-chain metering. PCSS measured +1.3–2.3 ms GPU on WebGPU High (off, §4).
WebGL2 High's ~11 ms GPU is the existing baseline (it was ~11 before this change too) and over the 8 ms target: worth
its own look (the PCF filter on ANGLE is the first suspect). Before/after sheet: Dropbox `lighting/aaa.png`.

## Not done / next

- The world's sky cube is still read as sRGB (`WORLD_SKY_CUBE_DECODE`, the approved wave-9 water look): moving it to
  linear brightens dim-sky reflections and wants its own look pass.
- No AgX in Babylon 9.28; Neutral (default) and ACES ("Filmic") remain.
- Contact shadows (screen-space) were not added (no budget left on CPU, the game's bottleneck).
- PCSS: a float32 shadow map (see §4) is the missing piece.
- The night's teal-green cast comes from the scene (sky/ambient), not the grade; a night-sky look pass would own it.
