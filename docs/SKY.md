# Sky, time of day and night lighting

This spec covers the modern sky for the browser remake: a physically based atmosphere, the sun and moon, stars, animated clouds, sunrise/sunset/night palettes, a day/night cycle synchronised by the server, what the sky hands to the lighting, and night lighting in Jangan. It is one part of the "make the world beautiful" request. The other parts are the texture/PBR pipeline, lighting/post-processing and weather; each has its own lane, and §8 names the seams between them.

Read with: `docs/TERRAIN.md` §3 and §5 (the retail lighting, environment.ifo and sky), `docs/FIELDS.md` §3 (streaming), `docs/EFFECTS.md` §3.15 and §7 (ambient emitters, performance), `docs/PROTOCOL.md` (wire rules).

## Status tags

- **[confirmed]**: checked in this repo: code, data or an API that exists in `node_modules/@babylonjs/core` 9.28.0, or a measurement from a prototype in `work/tmp/sky/`.
- **[likely]**: follows from confirmed facts, but nobody has run it in the game yet.
- **[projected]**: a cost estimate, not a measurement. Each one says how to measure it.
- **[our rule]**: a design or art choice. Tune it by eye; no source can prove it.
- **[unknown]**: open. Each one says how to settle it.

## 0. Decisions (TL;DR)

1. **Honest target.** The sky is the cheapest large win. With the pieces below it can match a current game in stills: a scattering sky, a sun that colours the world, lit clouds, stars and a moon, and lamps glowing at night. The ground and buildings are still 2005 low-poly geometry, lit by baked shadows. So the result is a strong remaster, not AAA. Real AAA skies also use raymarched volumetric clouds and real-time GI. Those are out of scope for v1; §5.6 lists them as an Ultra experiment.
2. **Our own atmosphere, not Babylon's SkyMaterial.** `SkyMaterial` lives in `@babylonjs/materials`, which is **not installed** [confirmed: only `@babylonjs/core` and `@babylonjs/loaders` 9.28.0 are in `node_modules`]. It is the Preetham model: daytime only, with no night, stars, moon or clouds. Whether it ships WGSL is [unknown]. If it does not, it would trigger Babylon's GLSL→WGSL conversion, which downloads from a CDN, and TERRAIN.md §8 bans that. The `@babylonjs/addons` Atmosphere is also not installed, and its WebGPU status is [unknown]. Instead we port Hillaire 2020 ("A Scalable and Production Ready Sky and Atmosphere") to **CPU look-up tables** plus one hand-written WGSL+GLSL dome shader. The prototype output looks right, and each LUT is cheap enough to rebuild in time slices (§3).
3. **The LUTs are computed on the CPU, in slices.** This gives identical output on WebGPU and WebGL2, lets vitest test the maths, and needs no render targets. Measured on the dev PC: a 96×48 sky-view LUT with 24 steps takes 6.2–6.3 ms whole, or **0.14–0.17 ms per row** (two runs). It is rebuilt every 1–4 s, a few rows per frame [confirmed, §3.5].
4. **One server clock, no per-tick traffic.** The server sends a `WorldClockState` anchor: `anchorMs`, `anchorDays`, `dayMs`, `running`, `nightSpeedup` and `declination`. It goes in `worldEnter.world.clock`, and a new `worldClock` message carries GM changes. Every client computes `days = anchorDays + (serverNow − anchorMs) / dayMs` from the ping/pong clock it already keeps (`apps/game/src/net/clock.ts`) [confirmed that it exists]. The default is **1 game day = 120 real minutes** (config `DAY_LENGTH_MIN`). The night is shortened to about 41 of those minutes (§2.3). GMs control it with `/time`.
5. **A real sun path over Jangan.** Latitude 34.3° N (Xi'an / Chang'an) and declination +12° [our rule] put the noon sun at 67.7°. The sun rises in the east (+X, as in retail) and crosses the southern sky (+Z in glTF). The retail environment.ifo palette stays as the **art grade**: its keyframes are remapped onto our sunrise and sunset (§6.4).
6. **The sky feeds the lighting through one struct.** `SkyState` carries the key-light direction, colour and intensity (sun or moon, dimmed by clouds), sky irradiance for the hemisphere and SH, a fog colour that matches the horizon, exposure, a `night` factor, and cloud-shadow parameters. The lighting and weather lanes consume it; the sky lane owns only its production (§6).
7. **Baked shadows conflict with a moving sun.** This affects the lighting lane, so it is flagged here. The terrain `.t` lightmaps and object lightmaps are baked for one fixed sun (retail light (1, 1, 0), TERRAIN.md §3.2). With a moving sun, those shadows point the wrong way in the afternoon. The `sunPath` knob handles it: `'baked'` keeps the key light at the bake direction (Low, Classic), and `'dynamic'` needs the lighting lane's real-time shadows plus an attenuated lightmap (§6.2).
8. **Night lighting uses the retail emitters.** Jangan town places **109 night-only emitters** (the 3×3 export; 163 across the 307-region fields) [confirmed, from `ambient.json` × placements]. Each becomes a light:
   - baked into a per-region **light-splat texture** that the terrain and grass shaders read with one texture tap;
   - a pooled or clustered `PointLight` for objects and characters (`ClusteredLightContainer` exists in core 9.28 [confirmed]);
   - a night emissive boost on the lamp meshes (§7).

## 1. What exists today [confirmed]

| Piece | Where | What it does |
|---|---|---|
| Sky dome | `packages/world-render/src/sky.ts` `Sky` | A sphere with 24 segments and radius 1400 m, `infiniteDistance`. Per-vertex colours are recomputed on the CPU every 0.25 s from the retail formula (TERRAIN.md §5.3). It has no sun disc, moon, stars or clouds. |
| Environment | `environment.ts` | Samples 16 retail graphs at t (0 = midnight); `approachEnv` smooths profile changes. |
| World | `world.ts` `World` | `timeOfDay` is fixed per load (the game passes 0.5, noon, in `apps/game/src/world/jangan/ground.ts:58`). `applyEnv()` sets the scene fog (linear, 250 m range from G10/G11), `scene.ambientColor` = ObjectAmbient, and a `DirectionalLight 'worldSun'` with a **fixed** direction (−1, −1, 0) and diffuse = Diffuse(t) × 0.6. It pushes fog, shadow colour and lightmap flags to the terrain and scatter shaders and water. |
| Terrain shader | `shaders.ts` (WGSL + GLSL) | Unlit: tile composite × `saturate(lightmap + shadowColor)`, then linear view-depth fog with its own fog colour (`sqrt(FogColor)`). |
| Object materials | `materials.ts` | `StandardMaterial` in fixed-function style (2× modulate), plus object lightmaps. The world sun lights them only through layer masks (`World.isolateLights`). |
| Character lights | `apps/game/src/screens/world.ts:102` | A separate `HemisphericLight` (0.7) and `DirectionalLight` (1.2), fixed. Characters use the glTF loader's PBR materials. `scene.environmentTexture` is not set, so they get no IBL. |
| Night switch | `apps/game/src/world/features/fx-world.ts:35` | Night-only ambient emitters play when `t < 0.25 \|\| t > 0.77`. Since t is always 0.5 today, they never play. |
| Server time | `apps/server/src/connection.ts` | `worldEnter.world.serverTime = Date.now()`. `ping` is answered by `pong {serverTime: Date.now()}`, and the client's `ServerClock` keeps the offset with the lowest RTT. |
| Pipeline | `apps/game/src/engine.ts` | WebGPU (`antialias: true`) with WebGL2 fallback. No HDR target and no post-processing, so everything writes LDR sRGB-ish colour directly. |
| Viewer | `apps/viewer/src/world/main.ts` | Time slider, `?time=`, env profile override and a sky toggle. This is the sky's test bench. |

The retail Jangan profile is Env7 (id 15). Keyframes from `work/out/world/jangan-fields/environment.json`, used below as the starting palette [confirmed]:

| Graph | t = 0 (midnight) | 0.25 (sunrise) | 0.5 (noon) | 0.75 (sunset) | 0.88 (dusk) |
|---|---|---|---|---|---|
| SkyTop | 0.05 0.07 0.19 | 0.31 0.50 0.49 | 0.17 0.57 0.95 | 0.35 0.47 0.82 | 0.36 0.33 0.49 |
| SkyBottom | 0.53 0.66 0.75 | 1.00 1.00 0.49 | 0.76 0.97 1.00 | 1.00 0.66 0.30 | 0.87 0.81 0.89 |
| Diffuse (×0.6 → sun) | 0.44 0.52 0.57 | 0.72 0.70 0.60 | 0.73 0.72 0.72 | 0.78 0.69 0.54 | 0.41 0.42 0.42 |
| ObjectAmbient | 0.32 0.36 0.39 | 0.59 0.62 0.54 | 0.68 0.67 0.66 | 0.73 0.62 0.46 | 0.51 0.49 0.60 |
| FogColor | 0.15 0.19 0.28 | 0.44 0.54 0.42 | 0.36 0.58 0.68 | 0.31 0.39 0.33 | 0.21 0.23 0.34 |
| TerrainShadow (lift) | 0.02 0.00 0.16 | – | 0 0 0 | – | – |
| G15 (star alpha; TERRAIN.md §5.3 uses G15 directly, clamped) | 1 | –0.71 at 0.18 | –1 | –0.82 at 0.78 | 0.01 (1 at 1.0) |
| G12 (cloud alpha) | 0.25 | –0.04 | 0.52 | –0.23 | –0.17 |

## 2. Time of day and the server clock

### 2.1 The model

- **`days`**: a float count of game days, never wrapped. Phase `p = frac(days)` and day index `d = floor(days)`.
- **`t`**: solar time in [0, 1), 0 = midnight. It comes from the phase through the night warp (§2.3): `t = p − (k / 2π) · sin(2π(p − 0.5))`, with `k = nightSpeedup ∈ [0, 0.6]`. The warp is monotonic for k < 1, so the clock never runs backwards [confirmed by the maths]. The **displayed game clock is t** ("05:27" at sunrise), so the clock itself runs faster at night.
- **Sun.** Hour angle `H = (t − 0.5) · 2π`, latitude `φ = 34.3°`, declination `δ` (default +12°) [our rule]. In ENU:
  - `E = −cos δ · sin H`
  - `N = cos φ · sin δ − sin φ · cos δ · cos H`
  - `U = sin φ · sin δ + cos φ · cos δ · cos H`
  - In glTF (TERRAIN.md §8: +X east, north = file +Z = glTF −Z): `sunDir = (E, U, −N)`, pointing *to* the sun. Check: at t = 0.25 E = cos δ > 0, so the sun rises in the east as in retail; at noon N = sin(δ − φ) < 0, so it stands in the south.
- **Moon.**
  - Age `a = (days + moonOffset) mod 29.53` (synodic month [our rule]; 29.53 game days = 59 real hours at the default length).
  - Hour angle `H_moon = H_sun − 2π · a / 29.53`, same declination. So the full moon rises at sunset.
  - Illuminated fraction `(1 − cos(2π a / 29.53)) / 2`.
  - Texture: retail `moon01..30.ddj`, index `min(30, floor(a / 29.53 · 30) + 1)`, so the full moon (a = 14.77) shows **moon16**. The moon is hidden within 0.75 day of new moon (a < 0.75 or a > 28.78) [our rule].
  - Checked against the retail images (fact-check: decoded all 30 DXT3 files, alpha-weighted brightness and left/right balance): moon01 is a thin waxing crescent lit on the right; **moon16 is the brightest (mean 81.9 vs 65.0 for moon15)**; moon15 is still a slightly waxing gibbous (60% of its light on the right); moon17–18 are balanced (50/50) but dimmer; moon22 is waning; moon30 is a thin waning crescent [confirmed by inspection]. The earlier "moon15 is full" was wrong.
- **Stars** rotate about the celestial pole (elevation φ toward north) by the sidereal angle `2π · ((d + t) · 1.0027)` [our rule; continuous across midnight, so the field never ticks]: one rotation matrix uniform.

### 2.2 Wire and server [proposal, additive to protocol v1]

```ts
// packages/shared/src/world-clock.ts (new; imported by protocol.ts, validate.ts, server and client)
export interface WorldClockState {
  anchorMs: number      // server epoch ms (Date.now() frame) at which days == anchorDays; int >= 0
  anchorDays: number    // float, 0 .. 1e6
  dayMs: number         // int, 60_000 .. 86_400_000 (1 min .. 24 h per game day)
  running: boolean      // false = frozen at anchorDays
  nightSpeedup: number  // k, 0 .. 0.6
  declination: number   // degrees, -23.44 .. 23.44 (season)
}
export function clockDays(c: WorldClockState, serverNowMs: number): number
export function solarTime(phase: number, k: number): number          // the warp of §2.1
export function sunDirection(t: number, declDeg: number, latDeg = JANGAN_LATITUDE): [number, number, number]
export function moonState(days: number): { age: number; illum: number; texture: number; hourOffset: number }
export function sunriseSunset(declDeg: number, latDeg?: number): { rise: number; set: number } // in t
export function formatClock(t: number, day: number): string            // "Day 12, 05:27"
export const JANGAN_LATITUDE = 34.3
export const DEFAULT_CLOCK: Omit<WorldClockState, 'anchorMs' | 'anchorDays'>
```

- **`WorldInfo.clock?: WorldClockState`** in `worldEnter`. It is absent from an older server; the client then falls back to a local clock anchored at page load, noon.
- **Server → client `{ t: 'worldClock'; clock: WorldClockState }`.** It is sent to every socket in the world whenever a GM or config changes the clock. There are no periodic frames, because clients extrapolate from the anchor. Use the `ctx.sockets` loop [confirmed, `gm.ts:103`], but filter to `conn.player` as `who` does (`gm.ts:168`): the `notice` loop (`gm.ts:289`) sends to every socket, lobby ones included.
- **Validator** (`validate.ts`, server → client parse, `validateServerMessage`): the ranges above. A malformed clock is dropped with a console warning, and the old clock is kept. Note: the house pattern (`worldInfo()`, `validate.ts:1102`) rejects the **whole** message when an optional field is out of range, so "drop only the clock" needs an explicit try/catch around the clock sub-parse inside `worldInfo` [confirmed pattern]; a bad `worldClock` message is simply rejected, which keeps the old clock.
- **Server module `apps/server/src/world-clock.ts`** (new):
  - `WorldClock.load(config)`.
  - Defaults come from `DAY_LENGTH_MIN` (120; 1..1440), `DAY_NIGHT_SPEEDUP` (0.4) and `DAY_SEASON_DEG` (12) in `config.ts`.
  - With no saved state, it is anchored to a fixed epoch: `anchorMs = Date.UTC(2026, 0, 1)`, `anchorDays = 0.3`. The clock is therefore deterministic across restarts and needs no DB.
  - GM state persists to **`<DATA_DIR>/world-clock.json`**, written atomically (tmp + rename), so no migration is needed. This keeps it off the v10 migration number that other lanes may take.
  - `now(): {days, t, day}` is available for future night-only server content.
- **GM `time`** (`gm.ts` registry entry; the name `time` fits `GM_COMMAND /^[a-z]{1,16}$/` [confirmed]):

| Usage | Effect |
|---|---|
| `time` | Shows "Day 12, 14:32, 1 day = 120 min, running, night ×0.4, season +12°". |
| `time <hh:mm>` | Jumps to that solar time today. Solves `solarTime(p, k) = t` for p by bisection; `solarTime` is monotonic. |
| `time day <n>` | Sets the day index, which also sets the moon phase. |
| `time length <minutes>` | Game-day length (1..1440). Re-anchors at now, so the current time does not jump. |
| `time freeze` / `time resume` | `running` false/true, re-anchored. |
| `time night <0..0.6>` / `time season <deg>` | k / declination. |
| `time reset` | Config defaults, epoch anchor, deletes the JSON. |

`gmResult.data = { clock, t, day }`. Auditing uses the existing `gm_audit`.

- **Client.** A new `apps/game/src/world/features/sky-clock.ts` (`WorldFeature`):
  - on `worldEnter`, calls `world.setClock(msg.world.clock ?? null, () => session.clock.serverNow())`;
  - on `worldClock`, calls `world.setClock(...)` again.
  - `World.update` then derives `t` every frame.
  - `World.setTimeOfDay(t)` stays as an override for the viewer, tests and char-select. It freezes the local clock.
  - The offline mock (`apps/game/src/net/mock.ts`) sends a clock with `dayMs = 120 min` so offline play shows day and night.

### 2.3 Night length [confirmed by computation, §10]

The sun is below the horizon for this share of a 120-minute day:

| Declination | k = 0 | k = 0.3 | **k = 0.4 (default)** | k = 0.5 |
|---|---|---|---|---|
| 0° (equinox) | 60.0 min | 49.0 | 45.8 | 42.8 |
| **+12° (default)** | 54.4 | 44.0 | **41.0** | 38.3 |
| +23.4° (midsummer) | 48.6 | 38.8 | 36.2 | 33.8 |

With the defaults, it is "dark" (sun below −6°, lanterns fully on) for about 37 minutes of every 2 hours. Retail's clock was 2000 s per day (TERRAIN.md §5.1, [likely]), which would feel frantic with a moving sun. The user's own example was "2 h real = 1 day".

## 3. The atmosphere (Hillaire 2020, on the CPU)

### 3.1 Constants (Earth, km) [confirmed in the prototype]

- Ground radius 6360 and top 6460.
- Rayleigh scattering (5.802, 13.558, 33.1)·10⁻³ /km, scale height 8 km.
- Mie scattering 3.996·10⁻³ and extinction 4.40·10⁻³ /km, scale height 1.2 km, g = 0.8.
- Ozone absorption (0.650, 1.881, 0.085)·10⁻³ /km, a tent profile at 25 ± 15 km.
- The camera sits at 0.5 km for the LUT (the terrain is under 0.3 km, so a fixed height is fine).
- `mieScale` (1..8) is the weather haze knob: `haze` 0..1 maps to 1 + 7·haze².

### 3.2 LUTs

| LUT | Size | Parameterisation | Rebuilt | Measured on dev PC (Node 24) |
|---|---|---|---|---|
| Transmittance | 64 × 32 (RGB f32) | u = μ, v = sqrt(h / 100 km). **Use Bruneton's horizon mapping instead**: the prototype's linear μ gives a non-monotonic sun colour below 1° elevation (§10). | on haze change (sliced over ~8 frames) | 8.8 ms |
| Multiple scattering (ψ_ms) | 16 × 16 | u = μ_sun, v = h. Uses 32 Fibonacci directions × 16 steps. | on haze change (sliced over ~24 frames) | 26–32 ms (two runs) |
| Sky-view | 96 × 48 (Medium/High) | u = azimuth relative to the sun, 0..π (mirrored, since only the relative azimuth matters); v = elevation with Hillaire's quadratic packing toward the horizon (0.5 = horizon) | every 1–4 s, or when the sun moves more than 0.1°, or the haze or moon changes; sliced | 6.2–6.3 ms whole (24 steps); **0.144–0.173 ms per row**; 4.0 ms at 16 steps; 3.1–3.3 ms at 12 steps |
| Moon sky-view | same | same maths, with the moon as the light source at `moonIntensity` × illuminated fraction | only when the sun is below −4°; it alternates with the sun LUT during twilight | same |

- The fast path is allocation-free and matches the reference loop exactly (max relative difference 0) [confirmed].
- **Upload.** `RawTexture` RGBA16F (`Constants.TEXTURETYPE_HALF_FLOAT`), with values packed by `ToHalfFloat` (`@babylonjs/core/Misc/halfFloat` [confirmed]) and linear filtering (RGBA16F is filterable in WebGL2 core and in WebGPU (`rgba16float` is a filterable float format) [confirmed by the specs]).
- **Pack as you go.** Converting a whole 96×48 RGBA LUT with `ToHalfFloat` costs 0.24–0.6 ms warm and 1.3 ms cold on the dev PC [confirmed, fact-check measurement]. Pack each row into the staging `Uint16Array` when the row finishes (~0.01 ms per row), not all at once on the last frame.
- Double-buffered: slices go into a staging `Uint16Array`. One `RawTexture.update()` [confirmed signature `update(data: ArrayBufferView)`] runs when the last row is done, so a half-updated LUT is never visible.
- **Worker option (Ultra).** The same module runs in a module Worker (`new Worker(new URL('./sky-worker.ts', import.meta.url), {type: 'module'})`) and transfers the buffer. v1 does not need it: at 4 rows per frame (24 steps) the main-thread cost is 0.58–0.69 ms on the dev PC for 12 frames every 2 s [confirmed], and about 1.4–1.7 ms on the N100 [projected, ×2.5 as EFFECTS.md §7 (line 970)].

### 3.3 What the prototype shows [confirmed; `work/tmp/sky/sky-preview.png`]

Colours are exposed and ACES-fitted. Rows show the sun 2°, 15°, 66°, 1° and −4° above the horizon.

| Sun elevation | Horizon toward the sun | Horizon opposite | Zenith |
|---|---|---|---|
| 66° (noon) | 0.41 0.55 0.66 | 0.39 0.53 0.66 | 0.05 0.09 0.21 (deep blue) |
| 15° | 1.73 1.26 0.78 (bright warm) | 0.53 0.57 0.52 | 0.02 0.04 0.11 |
| 2° (sunrise) | 4.49 1.24 0.21 (orange) | 0.42 0.21 0.13 (pink belt) | 0.02 0.03 0.06 |
| −4° (civil dusk) | 0.55 0.48 0.52 | 0.28 0.44 0.52 (blue hour) | 0.02 0.04 0.09 |

Sun colour at the ground (transmittance, chroma normalised to the max channel):

| Elevation | 66° | 45° | 30° | 20° | 10° | 5° | 2° |
|---|---|---|---|---|---|---|---|
| Chroma | 1 .92 .81 | 1 .90 .76 | 1 .86 .68 | 1 .80 .57 | 1 .66 .34 | 1 .48 .14 | 1 .29 .03 |
| Luminance vs noon | 1.00 | 0.96 | 0.90 | 0.81 | 0.60 | 0.37 | 0.17 |

**White balance** [our rule]: the key-light colour is `transmittance / transmittance(noon)`. Noon light is then white, which is what the retail albedos were painted for, and only sunrise and sunset turn warm.

### 3.4 Irradiance for the ambient [confirmed cost]

A cosine-weighted integral over the upper half of the sky-view LUT takes 0.29–0.44 ms (re-measured by the fact-check). It gives, in units of sun illuminance:

- noon: sky onto an up-facing surface (0.021, 0.044, 0.104);
- sun at 2°: (0.012, 0.015, 0.024);
- sun at −4°: (0.002, 0.004, 0.008).

The physical sky/sun ratio (about 6% in green) is lower than real skies (10–20%): there is no ground bounce and the model is single-altitude. `ambientBoost` (default ×2.5) [our rule] brings it to about 15%.

The same pass writes the SH L1 coefficients (4 × RGB) for the IBL path (§6.3).

### 3.5 Refresh policy

| Trigger | Action |
|---|---|
| Sun elevation moved > 0.1°, or 2 s passed (Medium) | Sky-view LUT, sliced (rows per frame: Low 2, Medium 4, High 6, Ultra 12 or a worker) |
| Weather `haze` changed by > 0.05 | Transmittance → MS → sky-view, sliced. The old LUTs stay live until done. |
| Sun below −4° | The moon LUT replaces the sun LUT. Between −4° and +2° both are refreshed alternately, and the shader blends them by `twilight`. |
| LUT finished | Recompute irradiance, SH, horizon ring (§6.3) and exposure target. Move `SkyState` toward the new values over 1.5 s, so there is no step. |

At the default day length the sun moves 0.05° per real second (360° / 7200 s), so one refresh every 2 s is plenty. With a GM `time` jump, the first refresh runs whole (6–7 ms plus packing, one frame) instead of sliced, so the sky never shows the old time.

## 4. The sky dome renderer

### 4.1 Mesh and draw order [APIs confirmed in core 9.28]

- One sphere (`CreateSphere`, 32 segments, radius 1400) with `infiniteDistance = true`, `isPickable = false` and `applyFog = false`, as today.
- **Material**: a `ShaderMaterial` with hand-written WGSL and GLSL (the TERRAIN.md §8 rule), `shaderLanguage` set per engine, and **`needAlphaTesting: true`** (an `IShaderMaterialOptions` field [confirmed]). The sky is then drawn *after* all opaque meshes and *before* transparent ones (water, particles). Early-Z rejects every pixel already covered by terrain or buildings. The camera mostly looks down, so this saves most of the sky's fill cost.
- The vertex shader outputs `position.z = position.w` (depth 1). The material uses `depthFunction = Constants.LEQUAL` and `disableDepthWrite = true`.
- There is no `discard`, so early-Z stays enabled.
- Fact-check notes [confirmed in `Rendering/renderingGroup.js`]: `RenderingGroup.render` draws opaque (l.103), then alpha-test (l.107), then sprites, then transparent; `dispatch` puts a material in the alpha-test queue when `needAlphaTestingForMesh` is true (l.340). Inside the alpha-test queue the default order is `PainterSortCompare`, i.e. by **material uniqueId**, so the sky may draw before alpha-tested foliage or lamp materials. The output is still correct (the sky writes no depth, so later alpha-tested meshes overdraw it); only those pixels are shaded twice. `needAlphaTesting` also makes `ShaderMaterial` add `#define ALPHATEST` (harmless if the shader ignores it).
- **WGSL uniformity** [confirmed by the WGSL spec; precedent in `shaders.ts:69/90`]: `textureSample`, `dpdx` and `fwidth` must be in uniform control flow, or the WebGPU compile fails. Branches such as "above the horizon → clouds" or "night → stars" depend on per-pixel values, so inside them use `textureSampleLevel` (the LUTs have no mips anyway) or `textureSampleGrad` with derivatives computed before the branch, as the terrain shader already does (`dpdx(lp)` then `textureSampleGrad`). Compute the star footprint `fwidth` before any branch.
- Below the horizon, the dome returns the current fog colour, as retail does. The terrain's far fog fades into it.

### 4.2 Fragment steps (per sky pixel)

`dir` is the normalised world direction. Uniforms go in one UBO; the names are listed in §4.3.

1. **Atmosphere.** `L = skyview(dir)`:
   - u = acos(dot(horizontal dir, horizontal sun dir)) / π;
   - v = 0.5 + 0.5 · sign(el) · sqrt(|el| / (π/2));
   - blended with `moonview(dir)` by `twilight`.
2. **Sun disc.** Angular radius 0.27° (real) × `sunSize` (default 1.6) [our rule], limb darkening `1 − 0.6·(1 − μ²)`, radiance `sunRadiance × transmittance(sunEl)`. The halo comes from the Mie term already in the LUT.
3. **Moon.**
   - The retail phase texture sits on a disc of 2.2° angular radius [our rule].
   - UV comes from projecting `dir` onto the moon's tangent frame (right = normalize(cross(moonDir, up)), up = cross(right, moonDir)), rotated by the parallactic tilt, which is cheap to compute on the CPU.
   - `rgb × moonTint (0.9, 0.95, 1.05) × moonRadiance`. The texture alpha masks the disc.
   - Earthshine adds 0.02 in the unlit part [our rule].
4. **Stars.**
   - Procedural. `sdir = starRotation · dir`, cube-face cell grid (256 per face; 128 on Low).
   - `h = hash(cell)`; a star exists where `h > 1 − density` (density 0.004).
   - Brightness `pow(hash2, 12)`; colour from a hashed temperature ramp.
   - Disc = `smoothstep(r_px, 0, d)`, with the pixel footprint from `fwidth`, so stars stay 1–2 px at any resolution.
   - Twinkle `0.8 + 0.2·sin(time·(3 + 5·hash3))` (High+).
   - Visibility = `starAlpha × (1 − cloudOpacity) × saturate(1 − 40·luminance(L·exposure))`. `starAlpha = saturate(G15(t))`, the retail "NightIntensity" graph used directly as star alpha, as TERRAIN.md §5.1/§5.3 state ("Stars: 3000 points, alpha = G15") [likely; the role "star alpha" is agreed by both sources, the exact mapping is not runtime-confirmed]. The earlier `(G15 + 1) / 2` was not from any source: with it stars would still be at 50% at t = 0.88 (G15 = 0.01) and 11% at sunrise; with `saturate(G15)` they are ~0 until the evening keyframe. Either way the sky-luminance term hides them in daylight.
   - Ultra adds a Milky Way band: one extra fbm tap along a great circle.
5. **Clouds** (§5), composited over 1–4: `rgb = mix(rgb, cloudColor, cloudAlpha)`.
6. **Lightning flash.** `+ flash × (0.8, 0.85, 1.0) × cloudAlpha`, with `flash` set by the weather lane.
7. **Output.**
   - `outputMode 0` (today's LDR pipeline): `srgb(acesFitted(rgb × exposure))`.
   - `outputMode 1` (once the lighting lane adds an HDR pipeline with its own tone mapping): linear `rgb × exposure`.
   - Classic mode (§4.4) uses the retail gradient instead of step 1.

### 4.3 Uniforms and samplers

```
SKY_UNIFORMS = ['world', 'viewProjection', 'skySun' (xyz dir, w radiance), 'skyMoon' (xyz dir, w radiance),
  'skySunColor' (rgb transmittance, a size), 'skyParams' (x exposure, y twilight, z starAlpha, w outputMode),
  'skyStars' (mat3 rotation, packed in 3 vec4), 'skyCloud0' / 'skyCloud1' (layer params, §5.3), 'skyCloudLight' (rgb sun-on-cloud,
  a ambient scale), 'skyCloudAmb' (rgb cloud ambient, a flash), 'skyFog' (rgb below-horizon colour, a unused),
  'skyTime' (x seconds, y quality flags bitfield, zw unused)]
SKY_SAMPLERS = ['skyView', 'moonView', 'transmittance', 'cloudNoise', 'moonTex']
```

These go in `packages/world-render/src/sky/sky-shaders.ts`, next to `shaders.ts`, with a WGSL and GLSL pair per stage.

### 4.4 Classic mode

The current `Sky` class stays, renamed `ClassicSky` and moved to `sky/classic-sky.ts`. It keeps the retail per-vertex gradient, and its missing TERRAIN.md §5.3 pieces are added:

- a sun billboard (`lens2`, tinted SunColor);
- the moon phase billboard;
- a cloud plane (`cloud1.ddj`, colour = saturate(G4) × tex, alpha = (G12+1)/2, UV scroll `(s mod 500)/500`);
- about 3000 star points with alpha from G15.

It is the Options → Graphics → Sky style "Classic" choice (nostalgia), and the fallback if the sky shader fails to compile.

## 5. Clouds

### 5.1 Approach: 2.5D, lit, weather-driven [our rule]

- Two layers, intersected analytically along the view ray:
  - **cumulus** on a curved shell at 1.8 km;
  - **cirrus** at 8 km.
- The curved shell follows the Earth: `h(d) = H − d²/(2·R)`, so clouds sink toward the horizon like a real cloud deck.
- Density comes from one 256² RGBA8 **cloud-noise texture** (§5.2) with wrap sampling and mips. The layer UV is `hitPoint.xz / scale + windOffset`.
- Lighting approximates a volume by sampling density again toward the sun ("2.5D").
- True raymarched volumetric clouds are an Ultra experiment only (§5.6).

### 5.2 The noise texture [confirmed: `work/tmp/sky/cloud-noise-proto.ts`, `cloud-preview.png`]

| Channel | Content |
|---|---|
| R | Shape: tileable Perlin (value-fbm, 5 octaves) × Worley (3 octaves), **histogram-equalised**. A coverage remap `d = saturate((R − (1 − c)) / c)` then covers exactly a fraction c of the sky. Measured 0.21 / 0.50 / 0.79 at c = 0.2 / 0.5 / 0.8. |
| G | Detail: Worley at 16/32/64 cells, for edge erosion. |
| B | Cirrus streaks: fbm stretched 4:1. The shader also shears it along the wind. |
| A | Low-frequency coverage variation (±0.15), so cloud cover is patchy, not uniform. |

Generating it takes **210–320 ms** on the dev PC (three runs), which is too slow for the main thread at load. So it is **baked offline** by the sky export tool (§11, lane SKY-C) into `work/out/sky/cloud-noise.png`: our own procedural data, not a retail asset. Measured by the fact-check: 256 KiB raw, **140 KiB PNG, 86 KiB lossless WebP** [confirmed]. It **must stay lossless**: lossy WebP q90 (the first rung of the optimizer's ladder, `optimize/texture.ts`) gave a max per-channel error of 23/255, and its 4:2:0 YUV coding mixes the four independent data channels, which breaks the coverage remap and the CPU sun-occlusion sample [confirmed]. The generator is seeded and deterministic, so vitest can check the coverage fractions.

### 5.3 Cumulus shading (per sky pixel above the horizon)

```
hit    = intersect(camera ray, shell at H0 = 1.8 km)            // distance d, point P
uv     = P.xz / 9 km + wind * time                               // skyCloud0.xy offset, .z scale
cov    = saturate(cover + (tex(uv * 0.25).a - 0.5) * 0.3)
shape  = remap(tex(uv).r, 1 - cov, 1)                            // density 0..1
dens   = saturate(shape - (1 - tex(uv * 6.3).g) * 0.35 * (1 - shape))   // erosion
toward = tex(uv + sunDir.xz * 0.012).r  (+ a second tap at 0.03 on High+)   // light march, 1–3 taps
lightT = exp(-remap(toward...) * 4 * thickness)                  // Beer
powder = 1 - exp(-dens * 8)
silver = HG(dot(view, sun), 0.6) * 0.4 + HG(.., -0.2) * 0.6      // two-lobe phase, forward "silver lining"
color  = sunOnCloud * lightT * powder * silver * 4π + cloudAmbient * mix(0.6, 1.0, heightGrad)
alpha  = (1 - exp(-dens * 6 * thickness)) * horizonFade(d)       // fade out past ~60 km, into the LUT horizon
```

- `sunOnCloud` = sun radiance × transmittance at the cloud's altitude. The CPU samples the transmittance LUT at 1.8 km, so clouds turn orange at sunset while the ground is already in shadow, as in reality.
- `cloudAmbient` = the zenith and horizon irradiance from §3.4, × (1 − 0.7 · `cloudDarkness`) for rain clouds.
- At night the moon takes the sun's slot at moon radiance.

### 5.4 Cirrus and the retail cloud layer

- **Cirrus**: 1 tap of B at 8 km, alpha `cirrus × B²`, lit by `sunOnCloud` with a forward phase only. Low preset: the retail `cloud1.ddj` (512² DXT3, a greyscale tileable cloud photo [confirmed by inspection]) is the single cloud layer, unlit, tinted by retail G4 as in §4.4. The texture lane may upscale it ×2.

### 5.5 Weather inputs, cloud shadows and sun occlusion

```ts
// packages/world-render/src/sky/types.ts (the seam with the weather lane)
export interface SkyWeather {
  cloudCover: number      // 0..1 cumulus coverage (clear ~0.15, fair 0.35, overcast 0.95)
  cloudDarkness: number   // 0..1 rain-cloud grey bases, thicker layer
  cirrus: number          // 0..1
  haze: number            // 0..1 -> mieScale 1..8 (LUT rebuild)
  wind: { x: number; z: number }   // m/s at cloud height (drift = wind * 1.5) [our rule]
  precipitation: number   // 0..1 hides sun/moon/stars progressively, desaturates the sky 30%
  flash: number           // 0..1 lightning this frame
}
```

- **Transitions.** The sky moves every weather field toward its target at 1/20 per second, with haze slower at 1/60 per second (it rebuilds LUTs) [our rule]. The weather lane owns the targets.
- **Cloud shadows on the ground (High+).**
  - Any ground shader can add a single tap: project the world position along the sun ray to the cloud shell, `uv = (P.xz + sunDir.xz / sunDir.y · (H0 − P.y)) / scale + windOffset`, then `shadow = 1 − strength · alpha(uv)`.
  - The sky publishes `skyCloudShadow` (vec4: offset.xy, 1/scale, strength) and the `cloudNoise` texture through `SkyState.cloudShadow`.
  - The terrain and scatter shaders multiply their direct-light term by it. This is a hook point for the terrain/lighting lane (§8).
  - It is **off at night** and when `cloudCover > 0.9` (the sky is uniformly overcast).
- **Sun occlusion for the key light** (all presets).
  - The noise texture is generated deterministically, so the CPU can decode the same PNG into memory and evaluate `alpha` along the sun ray from the camera focus. That costs 1–3 bilinear samples per frame, well under 0.01 ms.
  - Then `SkyState.keyLight.intensity *= 1 − 0.75 · alpha`. Watching a cloud pass over the sun dims the whole scene, which is cheap and very noticeable.
  - Lens flares (High+, §9.1) and god rays use the same value.
  - Terrain occlusion for flares is a `pickNav` ray from the camera toward the sun every 150 ms. `pickNav` exists [confirmed, `nav.ts:199`]; it marches the ray against the **nav surfaces** (object floors where the ray passes them, else the terrain height), a few hundred surface queries per pick. So it hides the sun behind hills and walkable roofs/floors, but **not** behind walls, eaves or tree canopies that are not in the navmesh [confirmed by reading the code]. Acceptable for flares [our rule]; a building-accurate test would need a ray against object bounds. We do not use Babylon's `LensFlareSystem`, because its occlusion calls `scene.pickWithRay` every frame on `isBlocker` meshes [confirmed in `lensFlareSystem.js:192`]. The retail `lens1..8.ddj` sprites are drawn as screen-space quads by our own small pass (High: 4 sprites, Ultra: 8).

### 5.6 Not in v1 (Ultra experiment)

Raymarched volumetric clouds: a 3D Perlin-Worley 128³ texture, quarter-resolution march of 32–64 steps with temporal reprojection. Typical cost is 1.5–3 ms on a mid GPU and far too much for an iGPU [projected, from published implementations]. It would need a render target and depth-aware upsampling. Revisit after v1 ships.

## 6. How the sky feeds the lighting

### 6.1 `SkyState` (produced every frame by the sky system)

```ts
export interface SkyState {
  t: number; day: number; phase: number          // solar time, day index, raw phase
  sunDir: Vector3; moonDir: Vector3                // glTF, pointing TO the body
  sunElevationDeg: number
  moon: { age: number; illum: number; texture: number }
  /** The one shadow-casting light: sun, or moon when the sun is below -4 deg (crossfade -4..-1 deg). */
  keyLight: { dir: Vector3 /* light travels along -dir */; color: RGB; intensity: number }
  /** Hemisphere ambient: sky (up), horizon (average ring), ground bounce (= sky irradiance x albedo 0.25). */
  ambient: { sky: RGB; horizon: RGB; ground: RGB }
  sh: Float32Array | null                          // L1 SH, 4 x RGB (High+)
  fogColor: RGB                                    // LDR, horizon colour at the camera's forward azimuth
  horizonRing: BaseTexture | null                  // 64 x 1 RGBA16F, fog colour by azimuth (High+)
  exposure: number
  night: number                                    // 0 day .. 1 night: smoothstep(+2, -6, sunElevationDeg)
  twilight: number                                 // 1 when the sun is within -6..+6 deg
  cloudCover: number; cloudShadow: Vector4 | null; cloudNoise: BaseTexture | null
  env: EnvValues                                   // the retail palette at the remapped t (§6.4)
}
```

`World.skyState` exposes it read-only. `World.onSky` is an `Observable<SkyState>` fired after every change larger than a threshold, for consumers that are not per-frame.

### 6.2 Key light: `sunPath` and the baked shadows

- **`sunPath: 'dynamic'`** (Medium+): `keyLight.dir` = the sun direction, with elevation clamped to at least 6° [our rule], so shadows never stretch to infinity. At night it is the moon.
- **`sunPath: 'baked'`** (Low, Classic): `keyLight.dir` stays at the retail bake direction (light from (1, 1, 0) normalised, TERRAIN.md §3.2 [likely]). Colour and intensity still follow the time of day. The baked lightmaps and N·L then agree.
- **The conflict.** The terrain `.t` lightmap is cast-shadow data from one fixed sun [confirmed, TERRAIN.md §3.1], and so are the object lightmaps [likely]. In 'dynamic', the lighting lane must:
  - draw real-time shadows (CSM) near the camera;
  - attenuate the baked shadow term, for example `lm' = mix(1, lm, 0.35)` as a soft AO-like darkening [our rule];
  - keep it at full strength beyond the shadow distance.
- That is the lighting lane's call. The sky only supplies both directions: `SkyState.keyLight.dir` and the constant `BAKED_LIGHT_DIR`.
- The **real bake direction** is [unknown]. The retail code uses (1, 1, 0) for N·L. The lightmap's shadow direction could be measured by offsetting object footprints against lightmap darkness, as TERRAIN.md §3.1's orientation test did. Add it to the lighting lane's tasks.
- **Intensity (LDR today):** `keyLight.color × intensity` replaces `Diffuse(t) × 0.6`. It is calibrated so that at noon, luminance(color × intensity) = luminance(retail Diffuse(0.5) × 0.6) = 0.43 [confirmed retail value]. Then:
  - `intensity(el) = 0.43 × lum(T(el)) / lum(T(noon)) × cloudOcclusion × (1 − 0.8·precipitation)`;
  - at night, the moon gives `0.43 × 0.12 × illum` [our rule], coloured by the retail night Diffuse (0.44, 0.52, 0.57) normalised to (0.77, 0.91, 1.0).

### 6.3 Ambient, IBL and fog

| Consumer | From SkyState | Cadence | Preset |
|---|---|---|---|
| `scene.ambientColor` (objects' StandardMaterial ambient) | `ambient.sky × ambientBoost`, floored at the retail night ObjectAmbient × 0.6 for readability [our rule] | per frame (smoothed) | all |
| Character `HemisphericLight` (`screens/world.ts`) | `diffuse = ambient.sky`, `groundColor = ambient.ground`, intensity = keyLight-relative | per frame | all |
| Character key `DirectionalLight` | `keyLight` | per frame | all |
| PBR `scene.environmentTexture` | `RawCubeTexture` 32² (High) or 64² (Ultra), RGBA16F. Faces are filled on the CPU from the sky-view LUT plus the average cloud colour × cover (**0.34 ms** lookup for 6×32², plus 0.3–0.7 ms half-float packing [confirmed, re-measured; the earlier 0.18 ms was too low]), then `HDRFiltering.prefilter(cube)` [confirmed API: `prefilter(texture): Promise<void>`, WGSL shader present]. Caveat [confirmed in `hdrFiltering.js`]: `prefilter` allocates a new half-float render-target cube on every call and **swaps it into the given texture in place** (`_swapAndDie`), so "double-buffered" means two `RawCubeTexture` objects used alternately, each re-uploaded and re-filtered; whether `RawCubeTexture.update()` works on the swapped-in internal texture is [likely], to test in the viewer. Set `cube.sphericalPolynomial = SphericalPolynomial.FromHarmonics(...)` from the CPU SH (§3.4) instead of letting Babylon read the cube back [likely; the setter exists via `baseTexture.polynomial`]. `scene.environmentIntensity` follows the exposure. | 10 s (High), 5 s (Ultra), plus after a `time` jump | High+ |
| Irradiance without a cube (Medium) | `ambient.*` into the hemisphere lights, plus `sh` for any PBR material via a `SphericalPolynomial` on a 1×1 dummy cube. The simplest way is to set `cube.sphericalPolynomial` directly [likely]; `RawCubeTexture.updateRGBDAsync(data, sphericalPolynomial)` [confirmed signature] also works but expects RGBD-encoded `ArrayBufferView[][]` data and runs a decode pass. Setting `environmentTexture` recompiles every PBR material once, and the 1×1 cube also becomes the (flat) specular reflection. Cheaper than prefiltering. | after each LUT | Medium |
| Scene fog colour (Babylon materials) | `fogColor`: the LUT horizon colour at el = 1°, averaged over the camera's forward azimuth ±60° (16 samples, CPU), tone mapped with the same exposure, then `mix(…, retailFog, gradeFog = 0.3)` | per frame | all |
| Terrain, scatter and water fog | the same `fogColor`, **without** the retail `sqrt()` terrain tint in modern mode, so the far terrain meets the sky horizon exactly | per frame | all |
| Directional fog (High+) | `horizonRing` 64×1 texture, sampled at the fragment's view azimuth. Custom shaders add 1 tap; StandardMaterial (world objects) uses a `MaterialPlugin` (`MaterialPluginBase.getCustomCode(shaderType, shaderLanguage)` [confirmed]) injecting at `CUSTOM_FRAGMENT_BEFORE_FOG` [confirmed in the WGSL and GLSL **default** fragment only]. **PBR (characters) has no `CUSTOM_FRAGMENT_BEFORE_FOG`** [confirmed: `pbr.fragment` has `…BEFORE_FINALCOLORCOMPOSITION` (l.621), then `#include<fogFragment>` (l.624), then `…BEFORE_FRAGCOLOR`]. For PBR use a `"!regex"` replacement key in `getCustomCode` (supported, `materialPluginManager.pure.js:322`) on the fog colour [unknown whether the regex sees the expanded include; test in the viewer], or leave characters on the scalar `scene.fogColor` [our rule fallback]. | after each LUT | High+ |

The **fog distance** (visibility) is not the sky's job. The weather lane sets visibility, and the lighting lane chooses linear or exponential height fog. The sky supplies colours only.

### 6.4 The retail palette as the art grade

- The retail keyframes assume sunrise at t = 0.25 and sunset at 0.75. Ours move with the declination (0.227 and 0.773 at +12°).
- `tPalette` is a piecewise-linear remap: [0, rise] → [0, 0.25], [rise, set] → [0.25, 0.75], [set, 1] → [0.75, 1]. `SkyState.env = evaluateProfile(profile, tPalette)`, with the existing per-block profile selection and `approachEnv` smoothing.
- **Uses, modern mode:**
  - fog tint, `gradeFog` 0.3;
  - sky hue grade: `rgb *= mix(1, chroma(retail SkyTop) / chroma(LUT zenith), gradeSky = 0.2)` above the horizon (keeps SRO's saturated noon blue) [our rule];
  - water colour (unchanged);
  - `TerrainShadowColor` lift (unchanged, until the lighting lane replaces it);
  - `G15` star alpha, `G12` as a floor on cirrus, and `G4` as a cloud tint at `gradeCloud` 0.2.
- **Classic mode** uses the palette exactly as today.
- **Other zones** (8 profiles in the fields [confirmed]: ids 0, 1, 5, 15, 18, 20, 23, 24) keep their own grade automatically, through the block's profile.

### 6.5 Exposure

- `exposureTarget = key / luminance(average sky irradiance + keyLight × 0.3)`, clamped to [2, 160] in the LUT's units. `key` is calibrated so that noon gives 8, the value the prototype preview used.
- It moves toward the target at 1/1.5 per second.
- The night cap of 160 plus the moonlight rule in §6.2 keep nights dark blue but readable. They do not become grey days.
- In LDR mode, the exposure applies only inside the sky and cloud shaders, and the world uses the calibrated LDR light values of §6.2. Once the lighting lane adds HDR plus post tone mapping, one exposure drives everything, so the ownership moves to that lane.

## 7. Night lighting in Jangan

### 7.1 Sources [confirmed counts]

Night-only emitters, placed:

| Export | Night emitters | By effect |
|---|---|---|
| `jangan` (3×3) | 109 | `cj_pal_lamp_orange` 36, `cj_pal_lamp_orange_s` 27, `cj_pal_lamp_red` 21, `light` 10, `cj_pal_lamp_red_b` 6, `cj_pal_lamp_light` 5, `frame` 4 |
| `jangan-fields` (307) | 163 | the same, plus 54 `frame` (fire) at the thief village (`cj_thiefvill_front_01` ×32, `_right_01` ×22) |

- Emitter owners in Jangan: `cj_pal_lamp` ×36, `cj_lamp01` ×20, the pub and shop `*_light*` models, `cj_streetstall` ×6.
- **Day emitters** (27 in town, re-counted) include the town-gate braziers (`frame2.efp` ×6 on `cj_enter_fire`; plain `frame.efp` in town is night-only), the blacksmith chimney and water effects. Fires among them should also cast light at night.
- Lamp meshes: `cj_pal_lamp` (×36), `cj_lamp01` (×20), `cj_field_lamp` (×10) and the pub/shop `*_light*` models. Their materials are BMT flags 0x340/0x341 (832/833: colorTint, diffuseMap, alpha, ±twoSided; not 0x8 self-illuminated) [confirmed in the sidecars]. `cj_field_lamp` owns **no** emitter, so it gets the emissive glow but casts no light unless the light table adds it by model name [confirmed, fact-check count].

### 7.2 Light table [our rule]

A light is a (placement × particle) pair. Emitters within 0.5 m are merged.

| Effect (efp) | Colour (linear) | Radius | Intensity | Flicker |
|---|---|---|---|---|
| `cj_pal_lamp_orange*` | 1.00 0.62 0.28 | 7 m | 1.0 | 3% slow |
| `cj_pal_lamp_red*` | 1.00 0.36 0.20 | 6 m | 0.9 | 3% slow |
| `cj_pal_lamp_light`, `light` | 1.00 0.78 0.50 | 6 m | 1.0 | none |
| `frame*`, `red_orange_flame*` (fire) | 1.00 0.55 0.22 | 8 m | 1.2 | 12% at 6–10 Hz (hash-seeded noise) |

The table lives in `packages/world-render/src/night-lights.ts` as `NIGHT_LIGHT_KINDS`. Unknown efps get no light.

- **Switching.** Lights ramp with `SkyState.night` from `smoothstep(+2°, −6°, sunEl)`, so lamps light up at civil dusk. The effect particles use hysteresis: on at `night > 0.6`, off at `night < 0.4`. This replaces `NIGHT_UNTIL` and `NIGHT_FROM` in `fx-world.ts`.
- **Rain.** Fires keep burning. The weather lane may scale fire lights down by `precipitation` × 0.3.

### 7.3 Rendering by material type

1. **Terrain and grass (custom shaders).** Per region, the sky/night lane bakes a **light-splat texture** at region load:
   - 192×192 texels = 1 m/texel (384² on Ultra), RGBA8, `rgb = Σ colour · I · N·L · window(d/r)`;
   - `window = (1 − (d/r)⁴)² / (1 + d²)`, the windowed inverse square [our rule];
   - N comes from the region heights; there is no occlusion (light may bleed under walls [our rule, accepted]);
   - regions without lights share one 1×1 black texture.
   - Cost: the 9 town regions have 109 lights × about 250 texels, well under 1 ms of CPU in total [projected]; 9 × 144 KiB = 1.3 MiB of GPU memory.
   - The terrain fragment adds `albedo × splat.rgb × nightScale` after the lightmap multiply and before fog (§8 hook T1). The scatter shader does the same.
   - This is one texture tap and is the only night-light cost on Low.
2. **Objects and characters (StandardMaterial and PBR).**
   - *Medium:* a pool of **4 `PointLight`s**, made once and kept at intensity 0 by day (the `HitLights` pattern, so no shader recompiles [confirmed pattern in `apps/game/src/world/fx/hit-light.ts`]). Every 250 ms they are reassigned to the 4 lights nearest the camera target, fading over 0.3 s. A light at intensity 0 is still evaluated per fragment, so the pool costs GPU time **by day too** [likely]; the §9.2 figure applies all day.
     - World object materials need `maxSimultaneousLights ≥ 6`: the world sun, 4 pool lights and 1 spare. Babylon's default is 4 for both StandardMaterial and PBRMaterial [confirmed]. The layer masks must let the pool reach both `WORLD_OBJECT_LAYER` meshes and characters.
     - **Characters are already full** [confirmed]: their glTF PBR materials (loaded in `apps/game/src/three/models.ts`) default to 4 lights, and the character hemi + sun (`screens/world.ts:102–106`) plus the 2 always-enabled `HitLights` (`HIT_LIGHTS = 2`) use all 4. Babylon ignores lights beyond `maxSimultaneousLights`, so without an edit the night pool (and a clustered container) would silently **not light characters**. SKY-D must raise `maxSimultaneousLights` on character materials to ≥ 8 (pool) or ≥ 5 (cluster), which recompiles them once (warm it at load).
     - **Object lightmaps darken lamp light** [likely]: world objects use `useLightmapAsShadowmap` (`materials.ts:205`), and Babylon's default fragment multiplies the whole lit colour by the lightmap (`color.rgb *= lightmapColor.rgb`, `default.fragment` l.287), point lights included. A lamp next to a wall that is in baked sun shadow is dimmed by that shadow. Judge it in the viewer; a fix needs a MaterialPlugin that adds the pool term after the lightmap multiply.
   - *High/Ultra:* a **`ClusteredLightContainer`** holding every resident night light, capped at 64 (High) or 128 (Ultra) nearest [API confirmed; clusters use WebGPU atomics on storage buffers, or on WebGL2 additive float blending when `texelFetch && colorBufferFloat && blendFloat`, otherwise `isSupported` is false and we fall back to the pool; `_GetEngineBatchSize`]. It extends `Light`, so it counts as one light slot, and both the StandardMaterial and PBR shaders support it (`lightFragment` `CLUSTLIGHT{X}` paths) [confirmed]. Only point and spot lights, only the default falloff, and no shadows [confirmed in `IsLightSupported`].
3. **Emissive glow.**
   - At night, lamp materials get `emissiveColor = kindColour × 0.8 × night`. That covers models named `/lamp|_light/`, plus the owner of any night emitter whose material name contains `light`.
   - This is not applied to whole buildings such as `cj_streetstall` or `cj_armo`, which also own night emitters. Painting a whole building emissive looks wrong [our rule].
   - The post lane's bloom makes them glow.
   - **Windows.** Retail buildings have no separate window meshes. When the texture/PBR lane authors emissive masks (paper windows, lantern paper), the same `× night` factor drives `emissiveTexture.level`. This is the §8 hook E1.
4. **Night palette.** It starts from retail Env7 at t = 0: sky zenith (0.05, 0.07, 0.19), fog (0.15, 0.19, 0.28), moonlight colour (0.77, 0.91, 1.0), ambient floor 0.6 × (0.32, 0.36, 0.39).
   - The retail night is bright. Ours is darker, but keeps **at least 12% of noon luminance** on characters and mobs for gameplay readability [our rule].
   - Players must still spot a mob at 30 m at midnight: this is the acceptance check in §9.

## 8. Seams with the other lanes

| Hook | File (owner) | What the sky lane needs |
|---|---|---|
| T1: terrain night light and cloud shadow | `shaders.ts` terrain fragment (terrain/lighting lane) | The lit line is `color = color * clamp(lm + uniforms.shadowColor.rgb, …)` (WGSL `shaders.ts:113`, GLSL `:214`), then fog (`:115`/`:216`). The fragment has **no `albedo` or `direct` variable** [confirmed]: keep `let albedo = color;` before that line, apply the cloud shadow to the baked sun term (`lm * cloudShadow(worldPos)` inside the clamp), and after it add `color += albedo * textureSampleLevel(nightSplat, …, 0.0).rgb * skyNight.x;`. The terrain passes only `vLocal` and `vDepth` today [confirmed], so the cloud-shadow tap also needs a new world-position varying (`vWorld: vec3f`). New uniforms `skyNight` (vec4: x scale) and `skyCloudShadow` (vec4); samplers `nightSplat`, `cloudNoise`. |
| T2: fog colour | `World.applyEnv` (sky lane) | `fogColor` from `SkyState.fogColor` in modern mode, with the terrain `sqrt()` dropped. Fog distances stay with the weather and lighting lanes. |
| S1: grass | `scatter-assets.ts` shader (scatter owner) | Same as T1 (splat plus cloud shadow). |
| L1: key light | `World.sun` (lighting lane owns the light model) | Reads `skyState.keyLight`. On a switch from `'baked'` to `'dynamic'`, the lighting lane fades the baked shadows (§6.2). |
| L2: characters | `screens/world.ts` hemi/sun | A per-frame adapter `applySkyToLights(state, {hemi, sun})` exported by world-render. |
| L3: HDR | the post pipeline (lighting lane) | Switch `skyParams.w` (outputMode) to 1 and hand exposure over (§6.5). |
| W1: weather | `World.setWeather(w: SkyWeather)` | The weather lane owns the targets. The sky owns the clouds, haze, sun occlusion and flash rendering. |
| E1: emissive | `materials.ts` / the PBR loader (texture lane) | Emissive level × `SkyState.night`. |
| A1: ambient FX | `fx-world.ts` | `ambient.setNight()` from `SkyState.night`, with hysteresis. |

## 9. Graphics presets and costs

### 9.1 Knobs

| Knob | Low | Medium | High | Ultra |
|---|---|---|---|---|
| Sky style | modern (Classic in Options) | modern | modern | modern |
| Sky-view LUT | 48×24, 12 steps | 96×48, 16 steps | 96×48, 24 steps | 128×64, 32 steps (worker) |
| LUT refresh / rows per frame | 4 s / 2 | 2 s / 4 | 1 s / 6 | 0.5 s / worker |
| Clouds | retail `cloud1` plane, unlit, 1 tap | cumulus: 3 taps + 1 light tap | cumulus: 3 + 2 light taps; cirrus 1 tap | cumulus: 4 + 3 light taps; cirrus; 2nd detail octave |
| Cloud shadows on the ground | off | off | terrain and grass | terrain, grass and objects |
| Stars | 128/face grid, no twinkle | 256/face | 256/face + twinkle | + Milky Way |
| Moon | retail phase | retail phase | same + moonlight | same |
| Lens flares | off | off | 4 retail sprites | 8 |
| `sunPath` | baked | dynamic | dynamic | dynamic |
| Ambient | hemi colours | hemi + SH | + 32² prefiltered cube / 10 s | + 64² cube / 5 s |
| Fog colour | forward-azimuth average | same | + horizon ring | same |
| Night lights | terrain splat + emissive | + pool of 4 point lights | + clustered ≤ 64 | + clustered ≤ 128; 0.5 m splat |

Ultra needs a new `WorldQuality` value. Today it is `'low' | 'medium' | 'high'` (`world.ts`, `settings.ts PRESETS`) [confirmed]. Adding `'ultra'` is shared with the lighting and texture lanes; one lane should own it (§11).

### 9.2 Cost table

"Mid GPU" means an RX 6600 / RTX 3060-class card at 1080p. "iGPU" means an Intel UHD 620 / Iris Xe / N100-class GPU at 1080p × 0.75 resolution. Sky fill is estimated at 35% of pixels when looking at the horizon; with the usual downward MMO camera it is about 10%. GPU numbers are [projected] from the tap and ALU counts above. Measure them with `EngineInstrumentation.gpuFrameTimeCounter` [confirmed API; on WebGPU it needs the adapter's `timestamp-query` feature, which Babylon enables when present] on WebGPU, with the sky on and off, in the world viewer at `?time=0.3`. Chrome quantises WebGPU timestamps (to 100 µs) unless its WebGPU developer features are enabled [likely], so average the difference over hundreds of frames instead of reading single frames.

| Item | CPU per frame (dev PC → N100 ×2.5) | GPU mid | GPU iGPU | Memory |
|---|---|---|---|---|
| Sky-view LUT slices (Medium, 16 steps) | 0.33 ms for 12 of every 120 frames = 0.03 ms average → 0.08 ms [measured × rule]; doubles in twilight while the moon LUT alternates | – | – | 96×48×8 B ×2 = 72 KiB (+72 KiB moon LUT) |
| Transmittance + MS rebuild (haze change) | 35–41 ms total (two runs), sliced over ~30 frames → 1.2–1.4 → 3–3.5 ms per frame while it runs [measured] | – | – | < 50 KiB |
| Dome: LUT + sun + moon + stars | – | 0.05 ms | 0.25 ms | moon 128² ×1 |
| Clouds, Medium (4 taps) | – | 0.08 ms | 0.45 ms | noise 256² + mips = 341 KiB |
| Clouds, High (3 + 2 light taps, + 1 cirrus tap, per §9.1) | – | 0.12 ms | 0.8 ms (not advised on iGPU) | – |
| Cloud shadows (1 tap per ground pixel) | – | 0.04 ms | 0.25 ms | – |
| SH / hemi colours | 0.3–0.45 ms per LUT (every 2 s) → ~0 average [measured] | – | – | – |
| IBL cube fill + `HDRFiltering` (High) | 0.34 ms fill + 0.3–0.7 ms half-float packing every 10 s [measured] | ~0.2 ms spike every 10 s | ~1.5 ms spike (High is not an iGPU preset) | 2 × 32² RGBA16F cube with mips ≈ 2 × 64 KiB = 128 KiB |
| Night splat textures | < 1 ms per region load [projected] | 1 tap: 0.02 ms | 0.1 ms | 144 KiB per lit region |
| Night point-light pool (4) | 0.02 ms | 0.1–0.2 ms (forward, lit objects only; paid by day too, the lights stay enabled at intensity 0) | 0.5–1 ms | – |
| Clustered lights (64) | 0.1 ms | 0.3–0.6 ms | not offered | light data texture |
| Sun occlusion + flare pick | < 0.02 ms (pick every 150 ms) | flares 0.02 ms | – | lens sprites ≈ 0.5 MiB as RGBA8 on the GPU (lens3 is 256², lens1/2/4 128², lens5–8 64²; the download is smaller) [confirmed sizes] |
| **Total, Medium (day, fair weather)** | **≈ 0.1 ms** | **≈ 0.2 ms** | **≈ 0.8 ms** | ≈ 0.6 MiB |
| **Total, Low** | ≈ 0.05 ms | 0.1 ms | **≈ 0.35 ms** | ≈ 0.4 MiB |

**Budgets for the build lane to hold**: the whole sky system at ≤ 0.3 ms GPU on a mid GPU (High), ≤ 1.0 ms on an iGPU (Medium) and ≤ 0.2 ms average CPU on the dev PC. Night adds ≤ 0.5 ms (Medium, iGPU). **Conflict found by the fact-check:** the table's own projection for Medium night on an iGPU is 0.6–1.1 ms (pool 0.5–1 ms + splat 0.1 ms), over that 0.5 ms budget, and the pool is paid by day too. Either use a pool of 2 on Medium, or keep 4 only if the measured cost fits [unknown until measured]. The memory totals exclude the night splats, about 1.3 MiB in lit Jangan town.

## 10. Measurements and prototypes

Scratch prototypes the build lanes should port. Run them with `pnpm tsx <file>`.

- **`work/tmp/sky/atmosphere-proto.ts`** runs the transmittance, multiple-scattering and sky-view LUTs (reference and allocation-free versions), the irradiance integral and the sun transmittance table, and writes `sky-preview.png` (5 times of day, sun at the centre column). Output, dev PC (RX 9060 XT host CPU, Node 24):

  ```
  transmittance 64x32: 8.8 ms; multi-scatter 16x16 (32 dirs x 16 steps): 26.0 ms
  fast skyview 96x48 steps 12: 3.14 ms | 16: 4.02 ms | 24: 6.21 ms; one row: 0.144 ms; max rel diff vs reference 0
  sun 66 deg: sky irradiance up (0.021, 0.044, 0.104) x sun illuminance, 0.29 ms
  sun colour (chroma) 66: 1 .92 .81 | 10: 1 .66 .34 | 2: 1 .29 .03 | 0.5: 1 .43 .18  <- non-monotonic: fix the LUT mapping
  ```

  The 0.5° row is non-monotonic: the linear-μ transmittance LUT under-resolves the horizon. Use Bruneton's `(ρ, x_μ)` mapping [confirmed defect, known fix].
  Fact-check re-run (same machine, later): transmittance 9.1 ms, multi-scatter 31.7 ms, one row 0.173 ms, fast sky-view 3.27 / 4.02 / 6.30 ms, irradiance 0.29–0.44 ms, 6×32² cube fill 0.34 ms; all colour values identical. Timings vary ±20% between runs.
- **`work/tmp/sky/cloud-noise-proto.ts`** generates the 256² noise in 210–320 ms, checks the coverage fractions (0.21 / 0.50 / 0.79 at 0.2 / 0.5 / 0.8, reproduced), and writes `cloud-preview.png`.
- **Night length** (§2.3) comes from a Python sweep of the warp and the solar formula (numbers in the table).
- **Retail sky files** [confirmed from `work/extracted/Map/`]:

| File | Size | Format | Content | Reuse |
|---|---|---|---|---|
| `sun/moon01..30.ddj` | 128² | DXT3 | photo moon phases (01 thin waxing crescent … 16 full (brightest) … 30 thin waning crescent); TERRAIN.md §5.3's "29 phases" is wrong, there are 30 files | **yes**, all presets; upscale ×2 with the texture lane |
| `sun/lens1..8.ddj` | 64–256² | BGRA8 / DXT3 | flare sprites: glow, rings, polygon | yes, flares (High+) |
| `sun/lens2.ddj` | 128² | BGRA8 | soft white disc (the retail sun billboard) | Classic sun |
| `skybox/cloud1.ddj` | 512² | DXT3 | greyscale tileable clouds | Low / Classic cloud layer |
| `skybox/cloud99.ddj` | 512² | BGRA8 | blue sky with clouds | not used (its role is [unknown]) |
| `skybox/glow.ddj` | 128² | BGRA8 | orange radial glow | Classic sunset glow (optional) |
| `skybox/shadowsphere.ddj` | 64² | DXT3 | black radial blob | not sky (likely a blob shadow) |
| `skybox/waterbump3.ddj` | 512² | BGRA8 | water normal/bump noise | for the water/weather lane (ripples), not sky |

Retail files stay local and are converted by our own tools (§11 lane SKY-C). **None are sent to any external service.** If the user wants AI-upscaled moons, run the texture lane's local upscaler on them, not a web service.

## 11. Build plan

Each lane lists its owned files, hook points, tests and the user-visible checks. Shared files (`protocol.ts`, `validate.ts`, `world.ts`, `shaders.ts`, `settings.ts`) take only the small edits named here. The integrator merges them in the order SKY-A → SKY-C → SKY-B → SKY-D → SKY-E.

### Lane SKY-A: clock, protocol and server

- **Owns:**
  - `packages/shared/src/world-clock.ts` (new; §2.2 API);
  - `packages/shared/test/world-clock.test.ts`;
  - `apps/server/src/world-clock.ts` (new);
  - `apps/server/test/world-clock.test.ts`.
- **Edits:**
  - `packages/shared/src/protocol.ts`: `WorldInfo.clock?` and the `worldClock` server message;
  - `packages/shared/src/validate.ts`: parse the clock, with ranges;
  - `apps/server/src/config.ts`: `DAY_LENGTH_MIN`, `DAY_NIGHT_SPEEDUP`, `DAY_SEASON_DEG`;
  - `apps/server/src/connection.ts`: `worldEnter.world.clock`;
  - `apps/server/src/gm.ts`: the `time` entry;
  - `apps/game/src/net/mock.ts`: the mock clock;
  - `docs/PROTOCOL.md`: an §11 row and a GM table row.
- **Tests:**
  - `solarTime` is monotonic and fixes 0, 0.5 and 1;
  - the sunrise table of §2.3 within ±0.3 min;
  - `sunDirection(0.25)` points +X and `sunDirection(0.5)` has z > 0 (south, glTF);
  - the moon age/texture mapping (full moon = texture 16 at age 14.77; age 0.9 → 1; age 29.4 → 30);
  - `time 06:00` round-trips to within 1 s;
  - `time length` does not jump the current t;
  - JSON persistence survives a restart (tmp dir);
  - the validator rejects out-of-range values;
  - an older server (no clock) makes the client fall back.
- **User check:** in game, `/time 18:30`. Every connected client's sky changes within one frame of the message, and `/time` prints the same clock on two clients.

### Lane SKY-C: sky assets (convert)

- **Owns:** `packages/convert/src/tools/export-sky.ts` (new). It writes `work/out/sky/` with:
  - `moon/moon01..30.png` from Map.pk2 `sun/`, via `ddjToPng` [confirmed helper, `world/objects.ts:255`];
  - `lens/lens1..8.png`;
  - `cloud1.png`;
  - `cloud-noise.png` (the generator of §5.2, seeded);
  - `sky.json` (the file list, moon count, and the noise seed and version).
- **Run:** `pnpm tsx packages/convert/src/tools/export-sky.ts`, like the other exporters (`export-icons.ts`, `export-fx.ts`, …). `cli.ts` has no `export-*` commands [confirmed], so no `cli.ts` edit is needed.
- **Edits:** the optimizer rule in `packages/convert/src/optimize/run.ts` (the `WORLD_PNG = /^world\/.+\.png$/i` regex, l.87, and the matching path rewrite) so `sky/**.png` becomes WebP in out-opt, **except `cloud-noise.png`, which must be forced lossless** (or kept as PNG): the optimizer's quality ladder tries lossy q90 first (`optimize/texture.ts`), which corrupts the data channels (§5.2).
- **Tests:** the noise is deterministic (hash of the bytes); coverage fractions are 0.2/0.5/0.8 ± 0.02, also after the out-opt round trip; all 30 moons exist and are 128².
- **User check:** `work/out/sky/` opens in an image viewer. The moon phases are in order.

### Lane SKY-B: atmosphere and sky renderer (world-render)

- **Owns** `packages/world-render/src/sky/` (new folder):
  - `atmosphere.ts`: the LUT maths (port of the prototype, with the Bruneton transmittance mapping);
  - `sky-luts.ts`: slicing, double buffering, half-float upload;
  - `celestial.ts`: uses the shared `world-clock.ts`, plus the star rotation and moon frame;
  - `clouds.ts`: noise decode, the CPU sun-occlusion sample, weather smoothing;
  - `sky-shaders.ts`: WGSL + GLSL dome and cloud shaders;
  - `sky-system.ts`: the `SkySystem` class, `SkyState`, presets;
  - `ibl.ts`: SH, cube fill, `HDRFiltering`, horizon ring;
  - `flares.ts`;
  - `classic-sky.ts`: the moved `Sky`, plus billboards and stars;
  - `types.ts`.
- **Tests:** `packages/world-render/test/sky-*.test.ts`.
- **Edits:**
  - `sky.ts` becomes a re-export (`export { ClassicSky as Sky }`) so the package export `Sky` (`index.ts:19`) keeps working. That alone does **not** keep the viewer and tests working: `apps/viewer/src/world/main.ts:243` and `apps/game/test/worldmap.test.ts:310` use the `World` property `world.sky.mesh` [confirmed], and `World.meshes()` (`world.ts:467`) lists `this.sky.mesh`. Whatever type `World.sky` becomes (the `SkySystem`) must keep a `mesh` getter returning the active dome (modern or classic), or both call sites change in this lane;
  - `index.ts` exports;
  - `world.ts`:
    - the constructor creates the `SkySystem`;
    - `update()` calls `sky.update(dt, camera)` before `applyEnv`;
    - `applyEnv()` takes the fog colour and `scene.ambientColor` from `SkyState` in modern mode;
    - new `setClock`, `setWeather`, `setSkyQuality`, `skyState`;
  - `QUALITY_PRESETS` gets a `sky` field;
  - `apps/viewer/src/world/main.ts`: `?clock=fast` (1 day per 2 min), a sky-style toggle and weather sliders for testing.
- **Hook points:** §8 T2, L2 (`applySkyToLights`), W1.
- **Tests:**
  - LUT values at the §3.3 reference points within 2%;
  - a sliced LUT equals the whole one;
  - the half-float round-trip;
  - `SkyState` is continuous across midnight and across a `time` jump (no NaN, and the key light crosses from sun to moon without a step greater than 5%);
  - fog colour at noon is within ΔE < 10 of the retail FogColor after grading;
  - both shader sources compile: a WGSL parse via `ShaderMaterial` on `NullEngine` is not possible, so string-level checks cover uniform names; the real compile is a browser check below.
- **User checks** (world viewer, `pnpm viewer`, WebGPU and `?engine=webgl`):
  - sweep the time slider: blue noon, orange sunset with a pink anti-sun belt, blue hour, stars and moon at night;
  - `?clock=fast` (1 day per 2 min) shows clouds turning orange while the ground is already dim;
  - no sky pixels "boil" (no LUT popping);
  - the perf overlay shows the sky's GPU time within §9.2.

### Lane SKY-D: night lighting

- **Owns:**
  - `packages/world-render/src/night-lights.ts` (new): `NIGHT_LIGHT_KINDS`, the light list from the ambient index (`readAmbientIndex`, `placeEmitter`) × placements per streamed region. It uses the same per-region add/remove calls that `AmbientFx.add(region, model, placements)` / `removeRegion` receive from `WorldObjects` [confirmed seam in `ambient-fx.ts:148/161`, `objects.ts:153`]; splat baking, and the pool/cluster driver;
  - `packages/world-render/test/night-lights.test.ts`;
  - `apps/game/src/world/features/night-lights.ts` (optional app glue).
- **Edits:**
  - `objects.ts`: a second listener next to `setAmbient` (shared file, not owned);
  - `shaders.ts` terrain fragment: hook T1, the night-splat part only;
  - the `scatter-assets.ts` shader: S1;
  - `materials.ts`: `maxSimultaneousLights = 6` and the lamp emissive rule (E1);
  - `apps/game/src/three/models.ts` (character glTF materials): `maxSimultaneousLights ≥ 8` (pool) / ≥ 5 (cluster), because hemi + sun + 2 `HitLights` already fill the PBR default of 4 (§7.3) [confirmed];
  - `fx-world.ts`: A1.
- **Tests:**
  - Jangan light count 109 ± merged duplicates;
  - the splat is black by day (`night = 0`) and at radius r;
  - pool reassignment keeps the light count constant (no recompile);
  - a character mesh's `lightSources` includes the pool lights (NullEngine; guards the 4-light PBR cap);
  - the cluster fallback when `isSupported` is false.
- **User check:** at `/time 22:00` in Jangan:
  - lanterns glow and light the ground in warm pools;
  - characters walking under a lamp get lit;
  - FPS on Medium drops by no more than the §9.2 night budget;
  - a mob is visible at 30 m (readability).

### Lane SKY-E: game integration and settings

- **Owns:** `apps/game/src/world/features/sky-clock.ts` (new).
- **Edits:**
  - `apps/game/src/settings.ts`: `graphics.sky: 'modern' | 'classic'` (default 'modern') and the Ultra preset if the lead assigns it here (§9.1);
  - `apps/game/src/hud/options.ts`: a "Sky style" row;
  - `apps/game/src/world/jangan/ground.ts`: drop the hard-coded `timeOfDay: 0.5`;
  - `apps/game/src/screens/world.ts`: the per-frame `applySkyToLights`;
  - the HUD clock (optional: a "05:27" next to the minimap, and `/time` output in chat).
- **Tests:** settings normalisation of the new field; the feature applies the clock from `worldEnter` and `worldClock` (mock session).
- **User check:** playing for 10 minutes, the light visibly moves. Switching Options → Sky style → Classic brings back the 2005 sky without a reload.

### Things to ask the user (via the lead)

- Nothing to download for v1: `@babylonjs/materials` and `@babylonjs/addons` are **not** needed.
- If the user wants to compare against Babylon's own `SkyMaterial` or Atmosphere add-on, that needs `pnpm add @babylonjs/materials@9.28.0` or `@babylonjs/addons@9.28.0`, with approval.
- **Taste calls:**
  - the day length (120 min?);
  - night share (about 37 min dark?);
  - fixed season or a slowly changing one;
  - moon size (2.2°, about 4× real, the game-y look);
  - whether a HUD clock should show.
- **Reference captures:** a few retail screenshots of Jangan at night and dusk, for the grade (optional).

## 12. Open questions and risks

- **The baked-shadow direction** is [unknown] (§6.2). If it is not the (1, 1, 0) light, `'baked'` mode's N·L will disagree with the lightmap shadows. Measure it before calibrating the Low preset.
- **Exposure in the LDR pipeline.** Balancing a physical sky against retail-lit LDR objects takes tuning. The worst case is a sky that looks "brighter" than the ground at dawn. The mitigation is the grade knobs (`gradeSky`, `gradeFog`) and, later, the HDR pipeline (L3).
- **Clustered lights on WebGL2** need `colorBufferFloat` and `blendFloat` [confirmed requirement]. Some laptops lack them; the pool fallback covers that.
- **`maxSimultaneousLights` 6 on object materials** adds one shader variant per material. Watch for a first-night hitch; mitigate by warming the variant at load. The same applies to the character PBR materials, which must go to ≥ 8 or they never see the night lights (§7.3).
- **Moon texture index.** moon16 is the brightest retail image, not moon15 (§2.1); if the art reads better with 17 (the most balanced), shift the mapping by one [our rule].
- **Ultra** needs one owner for the new `WorldQuality` value across the sky, lighting and texture lanes.
- **Weather lane names** (`SkyWeather`, `World.setWeather`) are proposed here. If the weather spec names them differently, the integrator keeps one and aliases the other.
- **Players on a frozen clock.** A GM `time freeze` persists across restarts by design. `time reset` clears it.
