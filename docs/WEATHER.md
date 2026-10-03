# Weather: server-authoritative weather, rain, wet surfaces, wind, lightning

This spec covers a weather system for the Jangan world: the server decides the weather (a seeded schedule, GM
overrides, one broadcast message, late-joiner sync), and the client presents it: rain near the camera that stops
under roofs, splashes and ripples, puddles that form over time and dry afterwards, wet terrain, stone, roofs, trees,
grass and characters, wind that drives the grass, trees and rain angle, lightning with delayed thunder, rain, wind and
thunder audio, and the effect of weather on fog, sky, clouds, light and colour grading. It ends with presets, a cost
table and a build plan.

It is one part of the "make the world beautiful" request. Two sibling specs were written in parallel and this one is
aligned with them:

- **`docs/SKY.md`** owns the sky, clouds, haze, sun occlusion, the day/night clock (`worldClock`) and the flash *in
  the sky*. It takes weather through `SkyWeather` (SKY.md §5.5, seam W1).
- **`docs/RENDER.md`** owns the PBR path (Medium/High/Ultra graphics: `PBRMaterial` + `SroTerrainPlugin` /
  `SroSurfacePlugin` / `SroWaterPlugin` / `SroFoliagePlugin`), the post stack and grading, and the wet material
  response on that path (RENDER.md §9), including the rain occlusion map (§9.4). It takes weather through
  `RenderWeather` (RENDER.md §9.1). Its Low preset is "Classic": today's shaders, unchanged.

This spec owns the weather **state** (server, protocol, schedule, GM), the per-frame `WeatherFrame` and the two
adapters that feed SKY and RENDER (§5.3), everything that is weather-only on every path (rain, curtain, splashes,
drips, lightning bolt, wind, audio), and the wet look on the **Classic path** (today's `ShaderMaterial` terrain,
water and grass, `StandardMaterial` objects), which is also what players see before the PBR lane lands (§6.0).

Tags: **[confirmed]** checked in the code, in `node_modules/@babylonjs/core` 9.28.0 or in the vSRO 1.188 data, or
measured; **[likely]** strong evidence, not proven; **[unknown]** open; **[our rule]** a design choice;
**[projected]** a number scaled from a measurement, not measured on that hardware.

> **What this reaches, honestly.** Weather is where a 2005 world gains the most for the least: wet ground that
> reflects the sky, puddles with rain rings, rain that stops under a roof, fog that closes in, lightning. Those are
> things players read as "modern". But the geometry stays the retail low-poly geometry, the terrain is a 2 m height
> grid, the trees are the retail cards and skinned meshes, and puddle reflections are sky-only below Ultra. With this
> spec and the sibling lighting/PBR specs, the result is a strong remaster. It is not AAA: that would also need new
> geometry (modelled rooftops with gutters, dense foliage, displaced ground), screen-space or ray-traced reflections
> of the whole scene, and volumetric clouds and fog. §9.3 lists what a later art pass would add.

---

## 0. Decisions in one screen

| Topic | Decision | Status |
|---|---|---|
| Authority | The server owns the weather: one world-wide state with timed transitions, from a seeded schedule or a GM hold. Clients never decide the weather, only how it looks. | our rule |
| States | `clear`, `cloudy`, `overcast`, `rain`, `storm`, `fog`. Each is a parameter vector (§2.1); transitions blend the vectors over 30-180 s. | our rule |
| Zones | One world state. Zones only **modulate** it on the client (`ZONE_CLIMATE`, §2.5: the swamp is foggier and stays damp, the mountains are windier). | our rule |
| Schedule | Markov chain over dwell segments, seeded by `WEATHER_SEED` and the segment index, so it is deterministic and survives restarts. Measured shares over 60 simulated days: clear 33 %, cloudy 31 %, overcast 22 %, rain 10 %, storm 1 %, fog 3 %. | measured (§2.3) |
| Wire | One new server message `weather` (the full `WeatherSync`, only on changes) plus `lightning` strikes. `WorldInfo.weather` carries the current state in `worldEnter` for late joiners. GM `/weather`. | our rule |
| Wetness | Surface wetness and puddle level are integrated from the rain rate by one shared pure function (`packages/shared/src/weather.ts`). The server integrates them and sends them with each change; clients integrate at frame rate from there. Everyone sees the same puddles. | our rule |
| Renderer contract | The client feature turns the sync into a `WeatherFrame` each frame. `World.setWeather(frame)` (owned here) feeds `toSkyWeather(frame)` to the sky (SKY.md §5.5) and `toRenderWeather(frame)` to the PBR path (RENDER.md §9.1), and on the Classic path pushes one shared set of `wx*` uniform vectors into the custom shaders and a `WetnessPlugin` (`MaterialPluginBase`). | our rule |
| Rain | A procedural camera-centred rain box (thin streak quads positioned in the vertex shader, world-anchored, wrapping), a distant rain curtain, and procedural splashes. No CPU particles, no compute. Measured cost on the dev GPU: 4k-65k streaks not resolvable above the measurement noise (about ±0.06 ms, §8). | measured (§8) |
| Shelter | One top-down map around the camera (RENDER.md §9.4's rain occlusion map, `world.render.rainOcclusion`; this spec builds it when the PBR lane has not). Rain, splashes, wetness and drips read it: nothing falls or gets wet under a roof or a tree. | measured (§8) |
| Puddles | Per-region wet map (97² texels: basin depth × flatness × surface class) built on the CPU when a region commits: 0.66-1.1 ms mean per region on the dev PC (varies with machine load), measured on all 307 regions. Puddles grow from the deepest basins up as the puddle level rises. | measured (§6.2) |
| Wet look | Darker albedo (by surface porosity), lower roughness, sky reflection with Fresnel, sun glint, animated ripple normals in puddles. PBR path: RENDER.md §9. Classic path: this spec (terrain splat shader, `WetnessPlugin` on StandardMaterial objects and on actors, grass and water shaders). Never both on one material. | our rule |
| Retail assets | `Map/weather/rain1..3.ddj` (32²/64² DXT3 sprites), `snow1..2`, `smog.ddj` (128²), `Data/prim/snd/etc/rain1.wav` (2.3 s stereo) and `lightning1..3.wav` (6.2 / 8.2 / 11.8 s), wind loops in `snd/env`. The sounds are used; the sprites are not needed (the streaks are procedural). | confirmed |
| Presets | A `graphics.weather` setting: `auto` (follows the graphics preset) / `off` / `low` / `medium` / `high` / `ultra`. `off` keeps only the cheap sky, fog and light changes, so players on weak laptops still see that it is raining. | our rule |

---

## 1. What exists today, and what retail had

### 1.1 Our renderer [confirmed, read in the code]

- **Environment.** `packages/world-render/src/environment.ts` samples the retail `environment.ifo` profile of the
  block under the focus (16 tracks, TERRAIN.md §5.1) into `EnvValues` (sun, sky top/bottom, diffuse, object ambient,
  scatter, terrain shadow, fog colour, water colour, g7/g8 sky shape, g10/g11 fog start/end). `World.applyEnv()`
  (`world.ts` line 590) pushes them to the scene fog, clear colour, `scene.ambientColor`, the world sun
  (`DirectionalLight`, diffuse = `Diffuse × 0.6`), `TerrainRenderer.setParams` and `WaterRenderer.update`.
  `World.update()` moves every value `min(1, dt × 0.5)` toward the target and refreshes the sky every 0.25 s.
- **Time of day** is fixed at noon in the game (`apps/game/src/world/jangan/ground.ts` line 58: `timeOfDay: 0.5`).
  A day/night clock belongs to the sibling sky/lighting spec; weather does not depend on it (§2.6).
- **Terrain** (`shaders.ts` `terrainFragmentWGSL` / `terrainFragmentGLSL`): unlit. Colour = layer composite
  × `saturate(lightmap + shadowColor)`, then linear fog on view depth. No normals, no view vector, no specular.
- **Water** (`shaders.ts` `waterFragment*`): 30-frame animated texture × `WaterColor`, vertex alpha, fog. No normals.
- **Objects** (`materials.ts` `ObjectMaterials.fromPbr`): the glTF loader's PBR materials are replaced by
  StandardMaterial with `specularColor = black`, a 2× diffuse texture level, object lightmaps as shadow maps, lit by the
  world sun only (`World.isolateLights`). Static models are thin instances; skinned ones (34 in Jangan, 40 in the
  fields: trees, animated flowers, pond weeds, lanterns) are clones with their default clip looping (`objects.ts`
  line 386).
- **Grass and plants** (`scatter.ts`, `scatter-assets.ts`): thin instances with a `ShaderMaterial` that sways them with
  a fixed wind (`scFade.z = WIND = 0.12`, the constant at `scatter.ts` line 364; direction `vec3(0.8, 0, 0.6)` in the
  shader, `scatter-assets.ts` lines 310-313 WGSL / 391-394 GLSL).
- **Characters** (`apps/game/src/three/models.ts`): glTF PBR materials as loaded, lit by the screen's hemispheric
  light `hemi` (0.7) and directional `sun` (1.2) (`screens/world.ts` lines 103-108).
- **Sky** (`sky.ts`): a vertex-coloured dome from the profile colours. No clouds, no sun disc, no stars.
- **Audio** (`apps/game/src/audio/**`): WebAudio buses master → sfx / ui / ambient; `AmbientPlayer` plays a looped bed
  and timed one-shots per area (`env/day_wind` plus birds in Jangan). `VoiceHandle` has `stop(fadeS)` and
  `setPosition`, no gain change.

### 1.2 Retail vSRO weather [data confirmed, behaviour likely]

- `Map.pk2` `Map/weather/`: `rain1.ddj` 32² DXT3, `rain2.ddj` 64² DXT3, `rain3.ddj` 32², `snow1/2.ddj` 32²,
  `smog.ddj` 128² DXT3, `attrib01..03.ddj`, `white.ddj` 4² **[confirmed, header read]**. The retail client drew rain as
  sprite particles with these, with no wet surfaces **[likely: nothing in the terrain or object data varies with
  weather]**.
- `Data.pk2` `prim/snd/etc/`: `rain1.wav` (22.05 kHz stereo, 2.32 s), `lightning1.wav` (6.19 s), `lightning2.wav`
  (8.16 s), `lightning3.wav` (11.80 s), all mono except the rain **[confirmed, ffprobe]**. `prim/snd/env/` has wind
  loops: `day_wind` (6.0 s), `day_wind02` (9.2 s), `night_wind` (9.2 s), `dd_mainwind` (2.0 s), `dd_wind_01/02`
  (3.6 / 3.4 s), `donhwang_wind01..05` (6.7 / 11.7 / 15.8 / 20.7 / 2.3 s; `donhwang_wind03` is 44.1 kHz, the others
  22.05 kHz) **[confirmed, ffprobe on `work/extracted/Data/prim/snd`]**. Only part of `env/*` is exported today
  (`work/out/sound/env/`: `day_bird*`, `day_wind*`, `night_*`; no `dd_*` or `donhwang_*`); `etc/` is not exported.
- The server-driven weather packet of the retail protocol (community packet notes: a weather type clear / rain / snow
  and an intensity byte) is **[unknown]** for 1.188: it is not in our data, and we do not need its format.
- `Particles/meshes/rain.bms` is used by the return-scroll and appear effects, not by weather **[confirmed, grep]**.

---

## 2. Server: the weather state

### 2.1 States and their parameter vectors [our rule]

Every state is a vector of the same parameters. The client blends vectors; the server only names states.

| Param | Meaning | clear | cloudy | overcast | rain | storm | fog |
|---|---|---|---|---|---|---|---|
| `cloud` | cloud cover 0..1 | 0.10 | 0.45 | 0.90 | 0.95 | 1.00 | 0.60 |
| `cloudDark` | how dark the clouds are 0..1 | 0.00 | 0.10 | 0.35 | 0.55 | 0.85 | 0.20 |
| `rain` | rain rate 0..1 (1 = heavy downpour) | 0 | 0 | 0 | 0.55 | 1.00 | 0 |
| `windMs` | mean wind (m/s) | 2 | 4 | 5 | 6 | 13 | 1 |
| `gust` | gust amplitude 0..1 | 0.2 | 0.3 | 0.3 | 0.4 | 0.9 | 0.1 |
| `fog` | extra fog 0..1 (§7.2) | 0 | 0.05 | 0.20 | 0.35 | 0.45 | 0.85 |
| `sun` | direct light scale 0..1 | 1.00 | 0.85 | 0.35 | 0.25 | 0.15 | 0.40 |
| `desat` | colour grading desaturation 0..1 | 0 | 0.05 | 0.25 | 0.35 | 0.45 | 0.30 |
| `lightning` | strikes per minute (server, §2.4) | 0 | 0 | 0 | 0.3 | 5 | 0 |
| `cirrus` | high thin cloud 0..1 (sky only, SKY.md §5.5) | 0.30 | 0.50 | 0.20 | 0 | 0 | 0 |

`rain` also has a light variant: the server may send `rain` with `intensity` 0.4..1 (§4.1), which scales `rain`,
`cloudDark` and `lightning` of the rain vector. `storm` has intensity 1.

### 2.2 Transitions [our rule]

- A change is `{from, to, start, dur}`. The blend factor is `k = smoothstep(0, 1, (now - start) / dur)`, and every
  parameter is `lerp(P[from], P[to], k)`, except:
  - **rain lags the clouds**: `rain(k) = P[to].rain × smoothstep(0.55, 1, k)` when rain starts, and
    `P[from].rain × (1 - smoothstep(0, 0.45, k))` when it stops. Clouds gather first, then it rains; rain stops
    before the sky clears;
  - **fog** uses its own `smoothstep(0.2, 1, k)` so it creeps in.
- Durations: 120 s by default, 60 s into `storm`, 180 s into or out of `fog`. GM holds can pass 0..600 s.
- A change that arrives mid-transition starts from the **current blended vector**: the server sends `from` as the
  state whose vector is nearest (it is only a name), and the client keeps its own current vector as the start point
  (§5.4). Both sides converge on `to` by `start + dur`.

### 2.3 Seeded schedule [our rule, measured]

Pure function in `packages/shared/src/weather.ts`: `scheduleAt(seed, t)` returns the segment that holds at server
time `t` (ms). Segments are generated from an anchor (`WEATHER_EPOCH`, default 2026-01-01T00:00Z) forward, each with a
state, a dwell and a per-segment seed (`mulberry32(seed ^ index)`); the server caches the current and next segment,
so there is no per-tick cost. Because the chain is Markov (each state depends on the previous one), `scheduleAt`
walks forward from the epoch on start: about 21,000 segments per year since `WEATHER_EPOCH`, a few ms once
**[likely, not measured]**. It is deterministic, so a restart lands on the same segment. (The prototype
`proto-cpu.ts` measured the shares with one sequential `mulberry32` stream, not the per-segment seeding; the shares
are a property of the transition table, so they carry over **[likely]**; the WX-0 test re-checks them on the real
`scheduleAt`.)

Transition table (percent, next state after a dwell) and dwell ranges (minutes), as prototyped in
`work/tmp/weather/proto-cpu.ts`:

| from \ to | clear | cloudy | overcast | rain | storm | fog | dwell (min) |
|---|---|---|---|---|---|---|---|
| clear | 45 | 45 | | | | 10 | 20-45 |
| cloudy | 40 | 20 | 40 | | | | 15-35 |
| overcast | | 35 | 15 | 42 | | 8 | 12-30 |
| rain | | | 55 | 25 | 20 | | 8-20 |
| storm | | | 30 | 70 | | | 5-12 |
| fog | 50 | 50 | | | | | 10-25 |

Measured over 60 simulated days (seed 20260928): clear 33.1 %, cloudy 30.5 %, overcast 22.4 %, rain 9.9 %, storm
0.9 %, fog 3.1 %, about 6 rain spells a day **[measured]**. That is "it rains now and then", not "it always rains".
Server config (`apps/server/src/config.ts`, all optional):

| Key | Default | Meaning |
|---|---|---|
| `WEATHER` | `auto` | `auto` (schedule), `off` (always `clear`, no messages beyond the enter sync), or a fixed state name |
| `WEATHER_SEED` | `1` | schedule seed (u32) |
| `WEATHER_RAIN_SCALE` | `1` | 0..3: multiplies the `→ rain` and `→ storm` weights (the owner's taste; 2 ≈ 20 % rain) |

A day/night clock (sibling spec) could bias fog toward dawn: `scheduleAt(seed, t, dayFraction?)` takes it as an
optional input when that clock exists **[our rule]**.

### 2.4 Lightning [our rule]

The server rolls strikes while the blended `lightning` rate is above 0 (storms, and `rain` whose intensity is ≥ 0.8:
the rain vector's 0.3/min is scaled by intensity and set to 0 below 0.8 **[our rule]**): a Poisson
process with that rate per minute, minimum 4 s apart, from the segment seed. Each strike is broadcast as
`lightning {at, distM, bearing}` with `distM` 300..3000 m and `bearing` 0..2π, so every client sees the same flash at
the same time and hears the thunder `distM / 343` s later (0.9-8.7 s). A GM can force one (`/weather strike [distM]`).
Strikes are cosmetic: no damage, no gameplay.

### 2.5 Zones [our rule]

The weather is world-wide (307 regions in a 21 × 15 grid of 192 m regions ≈ 4.0 × 2.9 km; the playable set is
3.6 × 2.5 km, FIELDS.md §1.4; 20 players). Zones (`work/out/data/zones.json`, 307 entries,
names from `textzonename.txt`) only modulate it on the client, by the zone under the camera, blended over 10 s when
crossing a border. `ZONE_CLIMATE` in `packages/shared/src/weather.ts`:

| Zone (zones.json `name`) | Regions | `rainMul` | `fogAdd` | `windMul` | `wetFloor` | Why |
|---|---|---|---|---|---|---|
| `Swamp area` | 18 | 1.2 | +0.25 | 0.8 | 0.35 | always damp, misty |
| `Lake Forest` | 21 | 1.1 | +0.15 | 0.9 | 0.15 | lake mist |
| `North-Tiger Mt.`, `South-Tiger Mt.`, `Hill of Ye Mt.` | 24 / 23 / 17 | 1.0 | +0.10 | 1.4 | 0 | exposed ridges |
| `Western China Ruins`, `Earth Ghost Canyon`, `Entrance-Western China Donwhang`, `Western China Northern Road` | 6 / 6 / 5 / 1 | 0.5 | 0 | 1.3 | 0 | toward the Donwhang desert: drier, dusty wind |
| everything else (incl. `''`, 92 unnamed) | | 1 | 0 | 1 | 0 | |

`wetFloor` is a minimum surface wetness in that zone (the swamp never looks bone-dry). The client uses the existing
`apps/game/src/world/map/zones.ts` module function `zoneAt(x, z)` (it returns `null` while the table loads, so the
climate falls back to the neutral row; `ZoneIndex` itself has `nameAt`, not `zoneAt`) **[confirmed]**. Zone counts
above are from `work/out/data/zones.json` **[confirmed]**.

### 2.6 Relation to time of day

Weather state and time of day are independent. The weather does not store a time; it multiplies whatever the
environment (retail profile today, the sibling sky model later) produces (§7). If the sibling spec adds a server clock
message, the two may share one `env` message; this spec keeps `weather` separate so either can land first.

---

## 3. GM commands [our rule]

Added to `apps/server/src/gm.ts` `COMMANDS` as `weather: { usage: WEATHER_USAGE, about, run: runWeatherCommand }`
(one line; the logic lives in `apps/server/src/weather.ts`). Role `gm`. Audited like every command.

| Command | Effect |
|---|---|
| `weather` | Status: state, blend progress, next scheduled change, wetness, puddle level, wind. `data: WeatherSync` |
| `weather <state> [minutes] [transitionS]` | Holds `state` (clear/cloudy/overcast/rain/storm/fog) for `minutes` (1..1440, default 30; the schedule resumes after), reaching it in `transitionS` (0..600, default 60). `rain` accepts `rain:0.4`..`rain:1` for intensity. |
| `weather auto` | Ends a hold now; blends to the schedule's current state over 60 s. |
| `weather wind <m/s> [degrees]` | Overrides wind speed (0..30) and the direction it blows toward (0..359, 0 = east, 90 = north) until the next state change. |
| `weather wet <0..1> [puddle 0..1]` | Sets the surface wetness and puddle level now (tests drying). |
| `weather strike [distM]` | One lightning strike now (distM 100..3000, default 600). |

Every command that changes something broadcasts `weather` (or `lightning`) and answers `gmResult`.

---

## 4. Protocol (protocol v1, additive)

### 4.1 Types (`packages/shared/src/protocol.ts`)

```ts
export const WEATHER_KINDS = ['clear', 'cloudy', 'overcast', 'rain', 'storm', 'fog'] as const
export type WeatherKind = (typeof WEATHER_KINDS)[number]

export interface WeatherSync {
  /** Server ms when the current transition began (may be in the past). */
  start: number
  /** Transition length, ms (0..600000). */
  dur: number
  from: WeatherKind
  to: WeatherKind
  /** Rain intensity of `to` (0.4..1; only for 'rain'; 1 otherwise). */
  intensity: number
  /** Server ms until which `to` is expected to hold (a hint for the HUD / GM; the next `weather` message decides). */
  until: number
  /** Wind: direction the wind blows toward (radians in the glTF XZ plane: 0 = +X east, π/2 = -Z north) and mean speed (m/s, 0..30). */
  windDir: number
  windMs: number
  /** Surface wetness and puddle level (0..1) at server ms `at` (§6.1 integrator). */
  wet: number
  puddle: number
  at: number
  /** u32 seed of this segment (client gust noise; the server rolls lightning from it). */
  seed: number
  /** Present when a GM holds the weather. */
  gm?: true
}
```

Server → client:

| t | fields | when |
|---|---|---|
| `weather` | `weather: WeatherSync` | every state change (schedule or GM), a GM `wind`/`wet` override, and once every 10 min as a resync (cheap: ~200 bytes) |
| `lightning` | `at: number` (server ms), `distM: 100..3000`, `bearing: 0..2π` | each strike (§2.4) |

`WorldInfo` (in `worldEnter`) gains `weather?: WeatherSync`: the late-joiner sync. An older server omits it (client:
clear). Validators (`packages/shared/src/validate.ts`): `from`/`to` in `WEATHER_KINDS`; numbers finite and in range;
`seed` integer 0..2³²-1; unknown keys dropped as usual. The server and client deploy together (PROTOCOL.md wave 8
note), so the new message type is safe.

### 4.2 Server module (`apps/server/src/weather.ts`, new)

A `GameplayModule` (`apps/server/src/modules.ts`) named `weather`, registered in `gameplay.ts` next to the others:

- `tick(now)`: at most once a second: advance the schedule (or the hold), integrate `wet`/`puddle` with
  `stepSurface` (§6.1), roll lightning; on a state change `world.broadcast({t: 'weather', weather: sync})`
  (`world.ts` line 584 sends to every player in the world).
- `sync(now)`: the current `WeatherSync`, read by `connection.ts` when it builds `worldEnter.world` (one added field,
  next to `social`).
- GM entry points for §3. No database: holds live in memory and end on restart (the schedule is deterministic anyway).
- Cost on the N100: one `scheduleAt` lookup and a few multiplications per second; nothing per player **[our rule]**.

---

## 5. Client architecture

```
server ──weather/lightning/worldEnter──▶ apps/game/src/world/features/weather.ts (WeatherFeature)
                                             │  keeps WeatherSync, integrates wet/puddle (shared stepSurface),
                                             │  blends params, zone climate (map/zones.ts), gusts, lightning pulses
                                             ▼  every frame
                                        WeatherFrame ──▶ World.setWeather(frame)   (packages/world-render)
                                             │              ├─ toSkyWeather(frame) ──▶ sky (SKY.md §5.5)
                                             │              ├─ toRenderWeather(frame) ──▶ PBR path (RENDER.md §9.1)
                                             │              ├─ Classic path: env multipliers in applyEnv §7.1,
                                             │              │   wx* uniforms §5.2, WetnessPlugin §6.4
                                             │              └─ WeatherRenderer (every path): rain box, curtain,
                                             │                  splashes, drips, bolt, ripple texture §6.6-6.8
                                             └─▶ WeatherAudio (apps/game/src/audio/weather.ts) §7.5
```

### 5.1 `WeatherFrame` (`packages/world-render/src/weather/frame.ts`, exported from `index.ts`)

```ts
export interface WeatherFrame {
  /** Blended parameters (§2.1) after the zone climate. */
  cloud: number; cloudDark: number; cirrus: number; rain: number; fog: number; sun: number; desat: number
  /** Unit wind direction in the glTF XZ plane, speed (m/s) and the gusting speed right now (m/s). */
  windX: number; windZ: number; windMs: number; gustMs: number
  /** Surface wetness and puddle level 0..1 (after the zone wetFloor). */
  wet: number; puddle: number
  /** Lightning flash brightness now (0 = none, ~3 at the peak) and the flash direction (unit, toward the bolt). */
  flash: number; flashX: number; flashZ: number
  /** Seconds, wrapping at 3600 (shader time). */
  time: number
}
```

The frame is plain data: the renderer never sees `WeatherSync`, the protocol or zones, and the viewer app can drive it
from a debug panel.

### 5.2 Shared shader uniforms (`wx*`, Classic path and the rain meshes) [our rule]

One set of `Vector4` objects owned by `World` (`world.weather.u`), passed by reference to every material like
`WorldScatter` already shares `uCamera`/`uFade` (`scatter.ts` lines 408-412): one write per frame reaches every
material. Names and packing are the contract for all shaders (WGSL `uniforms.wxA`, GLSL `wxA`):

| Uniform | x | y | z | w |
|---|---|---|---|---|
| `wxA` | wetness 0..1 | puddle level 0..1 | rain rate 0..1 | time (s, mod 3600) |
| `wxB` | wind dir x | wind dir z | wind strength 0..1 (gustMs / 20) | sway phase (s) |
| `wxC` | sky reflection zenith r | g | b | lightning flash 0..3 |
| `wxD` | sky reflection horizon r | g | b | ripple strength 0..1 (= rain, 0 under shelter handled per pixel) |
| `wxE` | direction **to** the sun x | y | z | sun glint strength 0..1 (= `sun` × daylight) |
| `wxCam` | camera x | y | z | 1 when the shelter map is valid |
| `wxOcc` | shelter map centre x | centre z | size (m) | 1 / size |

Samplers: `wxRipple` (ripple texture, §6.6), `wxOccMap` (shelter height map, §6.5). The terrain also gets a per-region
`wetMap` (§6.2).

The sky reflection colours come from the sky: today `mix(skyBottom, skyTop, 0.6)` and `skyBottom` after the weather
multipliers (§7.1); with the modern sky, `SkyState` zenith and horizon colours. The PBR path does not use `wx*` for
materials (its plugins have RENDER.md's own uniforms and get reflections from the sky probe); the rain meshes use
`wxA`, `wxB`, `wxC.w` and the shelter pair on every path.

### 5.3 Adapters to the sibling seams (`packages/world-render/src/weather/adapters.ts`, new, pure)

SKY.md and RENDER.md each wrote a `World.setWeather(w)` with their own struct. There must be one entry point, so
[our rule, for the lead to confirm]: `World.setWeather(frame: WeatherFrame)` is the public method (this spec), and it
calls the sky's and the renderer's own setters with these conversions:

```ts
export function toSkyWeather(f: WeatherFrame): SkyWeather {          // SKY.md §5.5
  return {
    cloudCover: f.cloud, cloudDarkness: f.cloudDark,
    cirrus: f.cirrus,                                                // §2.1 row
    haze: Math.min(1, f.fog + 0.3 * f.rain),
    wind: { x: f.windX * f.windMs, z: f.windZ * f.windMs },
    precipitation: f.rain,
    flash: Math.min(1, f.flash / 3),
  }
}
export function toRenderWeather(f: WeatherFrame): RenderWeather {    // RENDER.md §9.1
  return {
    rain: f.rain, wetness: f.wet, puddles: f.puddle, cloud: f.cloud,
    fogMul: 1 / fogScale(f),                                         // §7.1 fog-end factor, so both paths agree
    wind: Math.min(2, f.gustMs / 8),                                 // 0.2 calm .. 1.6 storm, RENDER.md §8.1 scale
  }
}
```

SKY.md smooths its inputs again (1/20 per second); the frame is already blended, so the sky may skip that smoothing
for weather fields [our rule]. RENDER.md gives example wet/dry rates and fog divisors; the rates in §6.1 and the fog
factors in §7.1 are the ones used (RENDER.md §9.1 says the weather lane owns them). RENDER.md's grade keys `clear`,
`overcast`, `rain` are weighted by `1 - cloud`, `cloud × (1 - rain)`, `rain` (§7.4).

### 5.4 The client feature (`apps/game/src/world/features/weather.ts`, new)

A `WorldFeature` (`apps/game/src/world/features.ts` interface, one line added to `WORLD_FEATURES`):

- `onMessage`: `worldEnter` → take `msg.world.weather`; `weather` → start a transition from the **current blended
  vector** (not from `P[from]`), reset `wet`/`puddle` to the message values integrated forward from `at` to now;
  `lightning` → schedule a flash at `at` and thunder at `at + distM / 343 × 1000`.
- `onFrame(now, dt)`: blend the parameter vectors (§2.2) with `ctx.serverNow()`, apply the zone climate under the
  own character, integrate `wet`/`puddle` (`stepSurface`, the same function as the server), compute gusts
  (`gustMs = windMs × (1 + gust × n(t))`, `n` = two-octave value noise seeded by `seed`), the flash curve (§7.3),
  and call `world.setWeather(frame)`, `weatherAudio.update(frame, sheltered)`.
- Settings: reads `settings.get().graphics.weather` (§9.1) and calls `world.setWeatherLevel(level)` on change.
- Debug: `window.__sroWeather = { frame, sync, level }` and a `?weather=storm` URL override for offline checks
  (client-side only, ignored once a `weather` message arrives) **[our rule]**.

---

## 6. Rendering

### 6.0 Which path does what

| | Classic path (graphics Low, and everything before the PBR lane lands) | PBR path (graphics Medium+, RENDER.md) |
|---|---|---|
| Terrain wet, puddles | this spec §6.2-6.3 (splat `ShaderMaterial`) | RENDER.md §9.2-9.3 (`SroTerrainPlugin`) |
| Objects wet | this spec §6.4 `WetnessPlugin` on `StandardMaterial` | RENDER.md `SroSurfacePlugin` |
| Characters wet | this spec §6.4 `WetnessPlugin` on their glTF `PBRMaterial` | RENDER.md `SroSurfacePlugin` |
| Grass wet + wind | this spec §6.7 (scatter shader) | RENDER.md §8.2 (same shader, `SRO_HDR` define), wind from `RenderWeather.wind` |
| Tree wind | this spec §6.7 (skinned `speedRatio`; `WetnessPlugin` sway on static foliage) | RENDER.md §8.1 `SroFoliagePlugin`; skinned `speedRatio` stays here |
| Water ripples | this spec §6.9 | RENDER.md §7 `SroWaterPlugin` with the ripple texture of §6.6 |
| Shelter map | shared: RENDER.md §9.4 (§6.5 here) | same |
| Rain, curtain, splashes, drips, bolt, audio | this spec | this spec |
| Sky, fog colour, sun, grading | §7.1 multipliers on the retail profile | SKY.md (via `toSkyWeather`), RENDER.md §5.2 grading |

`attachWetness` checks the material: it never attaches to a material that carries a RENDER.md plugin, so no surface
is darkened twice.

### 6.1 Wetness and puddles over time (`packages/shared/src/weather.ts` `stepSurface`) [our rule]

```ts
/** One integration step (dtS ≤ 1 on the server, any on the client: it sub-steps at 1 s). */
export function stepSurface(s: { wet: number; puddle: number }, rain: number, sun: number, windMs: number, dtS: number): void
```

- Wetting: `wet += (1 - wet) × rain × dt / 40`: full rain (storm, 1.0) soaks surfaces to 0.9 in about 90 s
  (40 × ln 10 = 92 s), the `rain` state (0.55) in about 2.8 min, light rain (0.3) in about 5 min.
- Drying (no rain): `wet -= dt × (0.15 + 0.35 × sun + 0.02 × windMs) / 300`: from 1 to 0 in about 9 min under `clear`
  (sun 1, 2 m/s) or `cloudy` (0.85, 4 m/s) and about 13.5 min under `overcast` (0.35, 5 m/s) **[computed from the
  formula; an earlier draft said 5-6 min in sun, which this formula does not give]**. If faster drying is wanted,
  lower the divisor (180 gives ≈ 5.5 / 8 min).
- Puddles grow above rain 0.15 (`PUDDLE_RAIN_MIN`; wave 12 RAIN-P, was 0.3): `puddle += (rain - 0.15) / 0.85 × dt /
  150` (`PUDDLE_FILL_S`, was 240): a storm shows its first puddles (level 0.17, the deepest basins) in about 25 s and
  fills them in 2.5 min; the `rain` state at 0.55 shows the first ones in about 54 s, is half full at 3 min and full in
  about 5.3 min; a light rain (0.22) stays below the first basins for about 5 min. (Before wave 12 the `rain` state
  needed 11 min and a player watching for 3 min saw none.) Capped at `wet + 0.1` **on every step, growing or
  draining**; they drain at
  `dt × (0.1 + 0.25 × sun) / 600`. That rate alone would take 29 min (sun 1) to 53 min (sun 0.35) from full, so in
  practice the cap drives it: puddles shrink with the drying surface and the last 0.1 drains in about 3 min (sun 1),
  i.e. gone about 12 min after the rain in sun and about 19 min under overcast **[computed]**.
- The shelter map (§6.5) makes sheltered pixels dry at once; it is a per-pixel mask, not a separate state.

### 6.2 Terrain (`packages/world-render/src/shaders.ts`, `terrain.ts`)

**Per-region wet map** (`packages/world-render/src/weather/wetmap.ts`, new, pure): RGBA8 97 × 97, texel (gx, gz):

- R: puddle potential = `flat × eligible(class) × max(basin × edge, 0.3)`, where `basin = smoothstep(0, 0.2, mean(h in
  the 5 × 5 vertex window) - h)` (metres below the 8 m neighbourhood), `flat = smoothstep(0.965, 0.995, normal.y)` and
  `edge = min(1, d / 3)` with `d` the vertex distance to the region's nearest edge. A region only has its own heights,
  so the window is clamped at its edges and two neighbours would disagree on their shared vertices (a puddle line along
  the 192 m grid, W9F S3); the basin term fades out toward the edge instead, so both sides agree exactly. This is a
  stopgap: a neighbour-aware window (re-queued when a neighbour commits) would keep basins that straddle a border;
- G: surface class × 40 (for debugging; the shader takes the class from the layer map);
- B: flatness × 255; A: 255.

Built in the region's terrain commit job, from `TerrainBin` heights, normals and texture words the region already has.
**Measured** over the 307 `jangan-fields` regions: 0.66 ms mean per region (4.0 ms worst, the first call with JIT);
re-measured by the fact-check at 0.79 / 0.81 / 1.11 ms mean and 3.9-7.6 ms worst in three runs while other agents
loaded the PC, so read it as **0.7-1.1 ms on the dev PC**. That fits the 3-5 ms streaming budget (FIELDS.md §3.6) on
the dev PC, but a weak laptop (3-5× slower CPU) would spend 2-5 ms: make it its **own commit job** after the
terrain job (FIELDS.md: "a single job is never split"), not part of the terrain job **[our rule]**; 2.5 % of vertices have potential ≥ 0.5 and 25.7 % ≥ 0.2, so
puddles start small and spread **[measured, `work/tmp/weather/proto-cpu.ts`]**. Memory: 37 KB per region.

**Surface classes** (from the tile, like `tileScatterDensity` in `scatter.ts`): measured shares over all field
vertices: grass 46.8 %, dirt/mud 23.4 %, stone/marble/road 21.4 %, water 7.5 %, sand 0.9 % **[measured]**.

| Class | Tiles | porosity (darkening) | gloss when wet | puddles |
|---|---|---|---|---|
| 0 generic | untyped | 0.6 | 0.5 | 0.5 |
| 1 grass | Grass, LongGrass, Forest | 0.55 | 0.35 | 0.35 |
| 2 dirt | Dirt, Mud (roads, farm plots) | 0.8 | 0.6 | 1.0 |
| 3 sand | Sand, Ashfield | 0.9 | 0.3 | 0.15 |
| 4 stone | names matching `marble|stone|rock|road|brick|pave`, type Stone | 0.3 | 1.0 | 0.9 |
| 5 water | Water, DeepWater, names with `water` | 0 | 0 | 0 |

The class goes into the **layer map's alpha** so the shader blends it per layer like the colour: `terrain.ts`
`buildRegion` line 222 writes `layerData[o + 3] = 128 + class` instead of `255` **[our rule]**. The shader's existing
test `t.a < 0.5` still means "no layer" (128/255 ≥ 0.5), and `i32(t.a × 255 + 0.5) - 128` is the class. The class
table (porosity, gloss, puddles) is a uniform array of 6 `vec4` (`wxSurf[6]`) set once.

**Terrain shader hook points** (both `terrainFragmentWGSL` and `terrainFragmentGLSL`, behind `#ifdef WX`):

1. `TERRAIN_UNIFORMS` (line 20) += `wxA, wxB, wxC, wxD, wxE, wxCam, wxOcc, wxSurf`; `TERRAIN_SAMPLERS` += `wetMap,
   wxRipple, wxOccMap`. The vertex shader adds `varying vWorld: vec3f` (world position; today only `vLocal` and
   `vDepth` are passed, line 37).
2. **Inside the layer loop** (after line 102 `drawn = k + 1`): accumulate the surface parameters with the same blend
   weight as the colour: `surf = (k == 0) ? wxSurf[cls] : mix(surf, wxSurf[cls], a)` (GLSL; WGSL has no `?:`, so
   put it in the existing `if (k == 0) {…} else {…}` branch). `wxSurf` is a `uniform wxSurf: array<vec4f, 6>`, set with
   `ShaderMaterial.setArray4`; Babylon's WGSL processor packs uniform arrays into the UBO
   (`webgpuShaderProcessorsWGSL.pure.js` builds `array<…, N>` members) **[likely; compile it in the first test]**.
3. **After the loop, before the lightmap** (before line 112): the albedo change (§6.3 formula `wetAlbedo`), the puddle
   mask and its dark bottom, both scaled by `shelter` (§6.5).
4. **After the lightmap multiply** (between line 114 and the fog at line 115): the reflection and glint:
   `color = mix(color, skyRefl × lmFloor, F × gloss) + glint`, where `lmFloor = mix(0.55, 1, lightmapLuma)` so
   reflections in baked shadow are dimmer, and the flash term `color += albedo × wxC.w × 0.25`.
5. The dry path stays byte-identical when `WX` is not defined, and a uniform branch `if (wxA.x + wxA.y > 0.001)`
   skips the wet block in dry weather (uniform control flow, so the derivatives before it stay valid).

**Normals.** The terrain has none. Puddles use `(0, 1, 0)` plus ripple normals; wet non-puddle ground uses the facet
normal `normalize(cross(dpdx(vWorld), dpdy(vWorld)))` (flat per 2 m triangle: fine for a sheen, which is the point).
Babylon's WGSL processor rewrites `dpdy` as `(-internals.yFactor_)*dpdy` (`webgpuShaderProcessorsWGSL.pure.js`), and
the GLSL path does not, so the cross product's sign can differ between WebGPU and WebGL2: force it up with
`n = n * sign(n.y)` (the terrain is a height field) **[confirmed in source; our fix]**.

### 6.3 The wet shading model (shared by every hook) [our rule]

With `w = wet × shelter × exposure`, `p = puddle mask`, porosity `k`, gloss `g`:

```
albedo'   = albedo × mix(1, 1 - 0.45 k, w)                   // soaked: darker, stronger colour
albedo'   = mix(luma(albedo'), albedo', 1 + 0.15 w)            // slight saturation boost
albedo'   = mix(albedo', albedo' × 0.35, p)                    // puddle: you see the dark bottom through water
gloss     = mix(g × w × 0.6, 1, p)
N         = normalize(mix(Nsurface, (0,1,0), p) + ripple(p) × wxD.w)   // §6.6
F         = 0.02 + 0.98 (1 - N·V)^5                            // water F0 = 0.02
skyRefl   = mix(horizon wxD.rgb, zenith wxC.rgb, saturate(reflect(-V, N).y))
glint     = wxE.w × gloss × pow(max(dot(reflect(-V, N), wxE.xyz), 0), mix(40, 600, p)) × 0.6
colour    = mix(colour, skyRefl, F × gloss) + glint
```

`exposure = smoothstep(-0.2, 0.6, N.y)` for objects: tops soak first; walls get `0.6 w` with vertical streaks
(`fract(worldX × 1.3 + worldZ × 0.7)` noise stretched along y). PBR materials (characters; objects once the sibling
PBR lane converts them) do the same through their own inputs instead: `surfaceAlbedo ×= darkening`,
`roughness = mix(roughness, 0.08, gloss)`, metallic unchanged, and Babylon's own lighting provides the reflection and
glint.

### 6.4 Objects, trees and characters: `WetnessPlugin` (`packages/world-render/src/weather/wet-plugin.ts`, new)

A `MaterialPluginBase` subclass **[confirmed API: `Materials/materialPluginBase.pure.d.ts` — constructor(material,
name, priority, defines), `isCompatible(shaderLanguage)`, `getUniforms(shaderLanguage)`, `getSamplers`,
`bindForSubMesh`, `prepareDefines`, `getCustomCode(shaderType, shaderLanguage)`]**. The base `isCompatible` returns
true for GLSL only, and `MaterialPluginManager` **throws** when a plugin is added to a WGSL material it is not
compatible with (`materialPluginManager.pure.js` line 38; on WebGPU every Standard/PBR material is WGSL,
`material.pure.js` `_createUniformBuffer`) **[confirmed]**, so the override is mandatory. It returns WGSL for
`ShaderLanguage.WGSL` and GLSL otherwise (TERRAIN.md §8 rule: never GLSL on WebGPU). Plugin code is injected after
includes are processed (`materialPluginManager.pure.js` `_injectCustomCode`) and WGSL `fragmentInputs` is a module
`var<private>` (`webgpuShaderProcessorsWGSL.pure.js` line 347), so code inside the PBR block functions can read
varyings **[confirmed in source]**.

Injection points **[confirmed: grep of `Shaders/` and `ShadersWGSL/` 9.28.0]**:

| Material | Point | What |
|---|---|---|
| StandardMaterial (world objects today) | `CUSTOM_FRAGMENT_UPDATE_DIFFUSE` (after `baseColor` is sampled) | `baseColor.rgb` darkening, puddle bottom (`wetAlbedo`) |
| StandardMaterial | `CUSTOM_FRAGMENT_BEFORE_FOG` | `color.rgb` += sky reflection × F × gloss and the glint (the objects have `specularColor = black`, `materials.ts` line 174, so the plugin adds its own specular, like the terrain) |
| StandardMaterial | `CUSTOM_VERTEX_UPDATE_WORLDPOS` (`worldPos` is a `var`) | foliage sway for static trees and bushes (§6.7), under a `WX_FOLIAGE` define |
| PBRMaterial (characters and equipment, Classic path only) | `CUSTOM_FRAGMENT_UPDATE_ALBEDO` (in `pbrBlockAlbedoOpacity`) | `surfaceAlbedo` darkening |
| PBRMaterial | `CUSTOM_FRAGMENT_UPDATE_MICROSURFACE` (in `pbrBlockReflectivity`) | `microSurface = mix(microSurface, 0.92, gloss)` (roughness down) |
| PBRMaterial | `CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION` | the lightning flash as an ambient boost |

Rules:

- **Which materials:** every material `ObjectMaterials.convert` creates (hook: after `fromPbr` in the loop at
  `materials.ts` `convert()`, `attachWetness(std, kind)`), except BMT 0x8 unlit ones (`unlit` in `fromPbr`: glowing
  lanterns do not get wet) and alpha-blended ones; actor materials after `LoadAssetContainerAsync` in
  `apps/game/src/three/models.ts` (the two `LoadAssetContainerAsync` calls, lines 235 and 270 today):
  `attachWetness(m, 'actor')`.
- **Foliage flag:** a model is foliage when its manifest `source` matches
  `/\\nature\\(common|china\\[^\\]+)\\(tree\d*|grass|flower|reed)\\/i` **[our rule]**. Measured on the manifests: 42
  of the 57 `res\nature\` models in Jangan and 113 of the 165 in the fields match (the rest are `particle`, `cliff`,
  `rock`, `stone` and loose `common` models). The `\d*` matters: without it the regex misses the 10 Dunhuang
  `tree2`/`tree3` models (103 instead of 113) **[confirmed, fact-check count]**. Foliage gets `k = 0.4`, `g = 0.5` (leaves glisten, bark darkens), the sway define and drips.
- **Characters** get `k = 0.35`, `g = 0.6` for skin/cloth (hair and cloth look soaked, not mirror-like), exposure 1
  (heads and shoulders do not matter at this scale), and the shelter test at the fragment's position.
- **Cost control:** the plugin is always attached (so no recompiles when it starts raining) but its code sits under
  `#ifdef WX`, driven by `prepareDefines` from the weather level; within it a uniform branch skips the work when
  `wxA.x + wxA.y < 0.001`. Changing the weather level recompiles each object material once (a hitch of a few frames,
  acceptable in the Options window) **[our rule]**.
- The plugin's uniforms go through Babylon's UBO (`getUniforms` returns `ubo: [{name: 'wxA', size: 4, type:
  'vec4'}, ...]`), bound in `bindForSubMesh` from the shared `Vector4`s.

### 6.5 Shelter map (RENDER.md §9.4; `packages/world-render/src/weather/shelter.ts` if built here)

There is **one** shelter map. RENDER.md §9.4 specifies it as a 512² top-down depth map over 128 m, exposed as
`world.render.rainOcclusion` with its matrix. Whichever lane lands first builds it under that name, and the other
reads it; the rain needs only `top(x, z)` in metres. Two differences to settle when the first lane builds it:
RENDER.md describes a *depth* map (decode `top = camY − depth × range` with its matrix) whose render list is object
chunks and trees only, re-rendered after 16 m of camera movement; this spec writes world height, includes terrain
(so splashes can sit on the ground) and re-renders after 8 m. Either works for the rain; one helper `topAt()` in
`weather/shelter.ts` hides the encoding. What the weather side needs from it, as prototyped:

- `RenderTargetTexture` 512² over RENDER.md §9.4's 128 m span (25 cm texels) on every preset that has the map. (An
  earlier draft had 256² on Medium and ±32 m / ±24 m bounds; 256² over 128 m would be 50 cm texels, too coarse for
  eaves, and a second span would mean a second map. The prototype measured 512² over 64 m.) Type
  `TEXTURETYPE_HALF_FLOAT`, format `TEXTUREFORMAT_R`, nearest sampling, cleared to -10000. Store the height
  **relative to the map centre's y** (`y - centreY`), not world y: world heights in the fields reach 354 m
  (fact-check scan of all 307 regions), where half-float steps are 0.25 m, as coarse as the 0.25 m shelter threshold;
  within ±64 m of the centre the step is ≤ 3 cm. Fallback when `engine.getCaps().textureHalfFloatRender` is false:
  RGBA8 with `(y - centreY + 64) / 128` packed into **R and G** (16 bits, 2 mm steps); a single 8-bit channel would
  give 0.5 m steps, too coarse.
- Camera: a `FreeCamera` with `mode = Camera.ORTHOGRAPHIC_CAMERA`, ortho bounds ±64 m, 300 m above the focus,
  looking down (the prototype's setup, at ±32 m) **[confirmed: the prototype renders with this setup]**.
- Render list: every object mesh (layer `WORLD_OBJECT_LAYER`) and terrain mesh within the square, via
  `rtt.renderList` refreshed on each re-render; all drawn with one height `ShaderMaterial` through
  `rtt.setMaterialForRendering(meshes, heightMat)` (writes world y; `#ifdef INSTANCES` handles the thin instances like
  the scatter shader). Characters and scatter are not in it.
- Refresh: `rtt.refreshRate = 0` (render once) and `rtt.resetRefreshCounter()` when the focus moved more than 8 m
  from the map centre, when a region or its objects commit inside the square, or every 2 s while it rains. The centre
  snaps to a 0.5 m grid to avoid shimmer. It is not rendered at all while `rain = 0` and `wet = 0`.
- Readers: rain streaks and splashes (vertex stage: `textureSampleLevel` / `textureLod`), drips, the terrain and the
  plugin (fragment): `shelter = 1 - smoothstep(0.25, 1.0, top - y)` inside the map, 1 outside (fading over the last
  4 m of the map).
- **Measured**: the pass every frame costs +0.074 ms GPU and +0.04 ms CPU on the dev GPU with 400 thin-instanced roofs
  and a 192²-cell ground over 64 m (§8). The 128 m span covers 4× the area, so the real pass draws up to about 4×
  the objects: ≈ 0.1-0.3 ms per re-render on the dev GPU **[projected]**. At the refresh policy above it runs every
  few seconds, so the average is ~0.

### 6.6 Ripples and puddle normals (`packages/world-render/src/weather/ripples.ts`, new)

One ripple texture serves both paths (RENDER.md §9.3 plans a 16-frame ripple atlas; this single-frame, time-offset
texture does the same job in one tap per layer and is measured; the PBR plugins sample it through
`world.weather.rippleTexture`). A tiling ripple texture generated on the CPU once (Lagarde's rain-ripple technique: R = ring profile, GB = radial
direction, A = time offset per drop), 128² with 60 drops (2.7-3.9 ms on the dev PC, measured in four runs) on
Low/Medium, 256² with 200 drops (11-22 ms) on High/Ultra, never shipped as a file **[measured]**. Do **not** create
it lazily on the first rain: 256² would be a 35-100 ms main-thread hitch on a weak laptop **[projected, 3-5×]** right
as the weather turns. Build it when the weather level is set (Options or world load), where a hitch is expected, or
bake it across several frames **[our rule]**. Shaders sample it
twice at world XZ × 0.5 m⁻¹ (second layer scaled 1.37 and offset, half a period later), turn each sample into an
expanding ring `sin(clamp((R×2-1 + phase-1) × 20, 0, 3π)) × (1 - phase)`, and add the two GB directions weighted by
the rings as the normal perturbation (× 0.35 × rain). Used in puddles (terrain, plugin) and on water (§6.9).

### 6.7 Wind: grass, trees, rain angle

- **Grass/plants** (`scatter-assets.ts`): `SCATTER_UNIFORMS` (line 272) += `wxA, wxB`. Replace the fixed sway (lines
  310-313 WGSL, 391-394 GLSL): direction `vec3(wxB.x, 0, wxB.y)` instead of `vec3(0.8, 0, 0.6)`, strength
  `scFade.z × (0.4 + 2.2 × wxB.z)` (calm 0.4×, storm ~2.6× today's bend), a gust wave travelling downwind
  (`sin(dot(root.xz, windDir) × 0.35 - t × 2.1)`) added to the two existing sines, and in rain a static droop
  (`-0.08 × h × wxA.z`, grass heads bow). The scatter fragment (line 347 WGSL, 424 GLSL) gets the §6.3 albedo
  darkening with `k = 0.5` and a cheap sheen (`+ skyRefl × 0.08 × wet × fresnel`), no puddles.
- **Skinned trees** (the retail animated trees and flowers): `WorldObjects.setWind(strength01)` sets
  `anim.speedRatio = 0.8 + 1.4 × strength01` on every clone's `AnimationGroup` (`objects.ts` line 386 starts them;
  `speedRatio` exists on `AnimationGroup` **[confirmed]**), ramped over 2 s so the loops do not jump. The authored
  clips only sway in place, so a faster loop reads as "windier" **[likely; check in the viewer]**.
- **Static trees and bushes** (thin instances, e.g. `tre_pine*`, `tre_dry*`): the plugin's `WX_FOLIAGE` vertex hook
  bends `worldPos.xz += windDir × strength × h² × 0.015 × sway(t, root)` with `h` = height above the instance origin
  (from `finalWorld[3]`) **[our rule]**.
- **Rain angle:** streak velocity `(windX × gustMs × 0.6, -fall, windZ × gustMs × 0.6)`, fall 9 m/s (rain) or 11
  m/s (storm): a storm slants the rain about 35°.
- **Clouds** (when the sibling sky has them): scroll speed = `windMs × 1.5` along the wind.
- **Water:** the frame rate of the 30-frame water animation scales `1 + 0.8 × wxB.z` (`WaterRenderer.update`).

### 6.8 Rain, splashes, curtain, drips (`packages/world-render/src/weather/rain.ts`, new)

**Rain box** (prototyped and measured: `work/tmp/weather/gpu/main.ts` `rainVS`/`rainFS`):

- One static `Mesh` of N quads; vertex = `(cornerU -0.5..0.5, cornerV 0..1, dropId)`; `alwaysSelectAsActiveMesh =
  true`; one `ShaderMaterial` (WGSL + GLSL), `ALPHA_PREMULTIPLIED`, no depth write, depth test on, drawn after the
  water with `alphaIndex` in rendering group 0. Do **not** move it to rendering group 1 without
  `scene.setRenderingAutoClearDepthStencil(1, false)`: Babylon clears depth before each rendering group by default
  (`renderingManager.js`: `autoClear: true, depth: true`), so the rain would draw over the buildings
  **[confirmed in source]**. The project uses no rendering groups today.
- Vertex shader: `seed = hash3(id)`; `lo = cam - size/2`;
  `p = lo + mod(seed × size + vel × t - lo, size)`, so drops are anchored in the world and wrap around the camera
  without "swimming" when it moves. Streak = `p - dir × len × v + side × width × u`, `side = normalize(cross(dir, cam -
  p))`. Shelter: `if (p.y < top(p.xz)) collapse` (the quad degenerates; nothing under a roof). Alpha fades within
  0.5-2 m of the camera and in the last 30 % of the box; count scales with `rain`: drops with `hash(id) > rain`
  collapse, so a light rain is sparse with the same mesh.
- Look: width 1.2 cm, length 0.55 m (storm 0.8 m), colour `mix(horizon, sunColour × 0.5, 0.3) × (1 + flash)`, alpha
  0.28 peak with a soft edge. At the fog end streaks vanish, which is correct. At 1080p with a ~45° vertical field of
  view a pixel is about 7 mm wide at 10 m, so a 1.2 cm streak is under one pixel beyond ~16 m and will shimmer:
  widen it to at least one pixel in the vertex shader (`width = max(0.012, 1.2 × dist × pixelAngle)`) and scale
  alpha down by the same factor, so far rain reads as a soft haze **[our rule]**.
- **Measured** (§8): 4k to 65k streaks at 1080p could not be separated from the measurement noise (about ±0.06 ms;
  the rain runs read 0.257-0.275 ms against 0.283 ms for the wet scene without rain) on the RX 9060 XT. So the rain is
  cheap on this GPU, but "< 0.02 ms" is more than the data shows. The vertex work scales with N on weak GPUs, hence
  the preset counts.

**Curtain (distant rain)**: a camera-centred open cylinder, radius 45 m, 40 m high, two layers of a procedural
streak pattern scrolling down at the fall speed (plus wind shear), alpha `0.10 × rain`, depth-tested so buildings
cover it. It gives density beyond the box for one draw call.

**Splashes**: a second mesh of M quads, each slot re-seeded every 0.35 s (`id + floor(t / 0.35 + phase)`), placed
uniformly in an 18 m disc around the camera, y = `top(p.xz)` from the shelter map (roofs and ground alike), drawn as a
procedural crown-and-ring sprite in the fragment shader (no texture), 12-30 cm, only when `rain > 0.1` and the point
is not under a higher surface. On water the water shader's ripples replace them (§6.9).

**Drips** (after and during rain): M_d short streaks (8 cm), spawned in the 20 m square where the shelter map's `top`
is at least 2.5 m above the character (canopies and eaves), falling 8 m from `top - 0.2` (the depth test hides the
part below the ground). Rate `max(rain, wet × 0.5)`, so trees and roofs keep dripping for a few minutes after the rain
stops. Same shader family as the rain, no CPU.

**Lens effect** (Ultra, optional): a few drops on the "camera" when it looks up in rain: a post-process of 16
refraction blobs. Only if the sibling post pipeline exists; skipped otherwise.

### 6.9 Water (`shaders.ts` `waterFragment*`, `water.ts`)

- `WATER_UNIFORMS` (line 228) += `wxA, wxC, wxD, wxCam`; `WATER_SAMPLERS` += `wxRipple`; vertex adds `vWorld`.
- After the frame sample (line 266 WGSL / 309 GLSL): ripple rings where `rain > 0` (strength `wxA.z`): the ring value
  brightens `rgb += skyRefl × ring × 0.35`, and a Fresnel sky reflection `mix(rgb, skyRefl, F × 0.6)` using
  `N = normalize((0,1,0) + ripple)` (today's water has no reflection at all; this is also a plain-weather upgrade the
  PBR path replaces with `SroWaterPlugin`, RENDER.md §7).
- Colour: `waterColor × mix(1, 0.72, cloudDark)` and 20 % toward grey under overcast (in `World.applyEnv`, §7.1).

### 6.10 Rain on the ground (wave 12 RAIN-P) [our rule, seen in game]

The user's report: "you say that, but in game I don't see it happening in the floor." Reproduced on a private server
with `/weather rain:1`, `/time 12:00`, no forced wetness: after 3 min of rain the plaza, the dirt road, the grass field,
the town pond and the sea at S1 showed wet darkening only. The causes: the rings (`wxRipple`) lived only inside puddle
basins, the `rain` state needed 11 min to reach a puddle level where any basin showed (§6.1), the rings' normal tilt on
a 0.25-roughness surface (or on the shallow, nearly transparent water) changed nothing visible, the ripple texture's
mips erased them a few metres out, the plaza's paving is an object (`cj_jang_gate07`, class `default`, batched) that no
rain code reached, and the W9 LOOK splashes (4–10 cm flat rings at 0.15 opacity) could not be seen from the game
camera. What wave 12 does (reference: a photo of rain on water, dense overlapping rings and small crowns):

- **One ring function** (`weather/ripples.ts` `rainRingCode`, a TS mirror `rainRing`): each tap of the ripple texture
  is a drop whose ring expands and fades in 1 / `RAIN_RING_RATE` s; the share of live drops (`RAIN_RING_DENSITY`: a
  drizzle a quarter, the `rain` state two thirds, a downpour all) and the ring's reach (`RAIN_RING_SIZE`) grow with the
  rain rate, a third, coarser layer joins above 0.6 (`ringTaps`), and every consumer declares its own copy under its own
  name. It returns the normal tilt, the impact crown (a bright dot in a drop's first instant) and the signed ring
  height (light crests, dark troughs). Texture-free twin for materials without a spare sampler: `rainCellCode`.
- **The rain film** (PBR terrain, `pbr/terrain-plugin.ts` `FILM_*`): on every wet, flat-enough surface while it rains,
  independent of the basins: `smoothstep(rain) × smoothstep(wetness) × smoothstep(0.86, 0.96, N.y) × the class's puddle
  weight × 1.15` (soil and stone full, generic 0.58, grass 0.4, sand 0.17, water 0; none on slopes, none under
  shelter). It glosses the ground (roughness toward 0.08), flattens the normal maps and carries the rings: normal tilt
  × `TERRAIN_RING_GAIN`, albedo × (1 ± `RING_CONTRAST` × the ring height) so the lines read on light paving and dark soil
  in any light, and the crowns lift the albedo toward a light grey. Gradient taps at a sharper mip (`RING_LOD_GRAD`),
  faded out by the pixel footprint (`RING_FADE_M`). Puddles carry the same rings at full strength. The puddle threshold
  is now `0.94 − 0.52 × puddle` (`PUDDLE_THRESHOLD`), so the deepest basins show at the first minute's level.
- **World objects** (`pbr/surface-plugin.ts`, define `SRO_RAIN`, Medium+ weather): the same film on every flat, open,
  wet floor of a batched slot or a baked material of `RAIN_FILM_CLASSES` (the plaza's paving included; characters
  never), with the texture-free ring field (`RAIN_CELLS_M`, two layers) so no object material takes a sampler.
- **Water** (`pbr/water-plugin.ts`, the town pond through it; `ocean/ocean-plugin.ts`): the same rings, 26 cm at most
  (`WATER_RING_SCALE`, `OCEAN_RING_SCALE`), implicit taps biased two mips sharper (`RAIN_RING_LOD_BIAS`) and faded by
  distance, the water's roughness in rain 0.15 → 0.07. On the PBR water the ring crests and crowns lift the albedo and
  the alpha after the town plugin's profile (the pond is shallow and nearly transparent) and add a glint of the sky the
  surface mirrors; on the sea the crests and crowns become foam flecks and glint with the sea's sky colour.
- **Splash crowns** (`weather/rain.ts`): camera-facing sprites on the shelter map's top (ground, roofs and water alike;
  never under cover), 0.6 m square, moved 0.3 m toward the camera: a crown of six jittered droplets on a rim that
  rises and sinks, seen at the camera's elevation, and three droplets flung out along parabolas (at least ~0.7 px each,
  fainter when widened). Sizes grow with the rain rate (`SPLASH_CROWN_M`, `SPLASH_HEIGHT_M`).
- **Classic** (graphics Low with weather Medium+): the Classic terrain and water chunks use the same ring function and
  the film (flatness from the wet map). Weather Low (the Low preset's own level) is unchanged: no ripple texture, no
  rings, no splashes, the iGPU budget of §9.2; weather Off is unchanged byte for byte (the Low guard).
- **Seen in game** (private server on a copy of the DB, plain `/weather rain:1` and `/time 12:00` from dry, WebGPU
  Medium, 1920 × 1080; `work/tmp/w12r/sheet_*.jpg`, `side_by_side_reference.jpg`): 30 s after the rain reaches the
  ground (wet 0.25) the plaza, the road and the pond carry rings and crowns; at 3 min (wet 0.9, puddle 0.53) the road's
  basins hold puddles with rings. After that check the ground's ring contrast went 0.6 → 0.85 (`RING_CONTRAST`,
  `RAIN_OBJECT_CONTRAST`): at 0.6 the rings read only at 1 : 1. Known limits: the grass field's blades (scatter) hide
  most of its rings (the film is soft there by design); on the sea the rings 15 m and more out read as a rain-pocked
  speckle rather than rings (0.25 m⁻¹, 36 cm rings, was tried: a little more legible, visibly sparser, not kept); water
  rings ignore the shelter map (under the pond's bridge), as before wave 12.
- **Cost** (measured, RX 9060 XT, Medium, 1920 × 1080, rain pinned at 0.55 / wet 0.9 / puddle 0.5, HEAD vs HEAD + RAIN-P
  in a clean worktree, 2 × 3 runs of 400 frames each): WebGPU plaza frame p95 median 6.25 → 6.55 ms (spread 5.9–6.7
  both), p50 4.4 → 4.5 ms; the beach (S1) p95 1.8 → 2.0 ms; WebGL2 plaza 4.8 → 4.9 ms and beach 1.2 → 1.2 ms (CPU-bound,
  within the noise); dry plaza (WebGPU) 6.7 → 6.4 ms, i.e. no cost without rain (the terrain's taps now sit behind
  the rain branch). The procedural ring field on the object floors is the largest new term; it runs only on wet, flat,
  open object pixels while it rains (and fades out by 45 m).

---

## 7. Sky, fog, light, grading and sound under weather

### 7.1 Environment multipliers (`world.ts` `applyEnv`, line 590) [our rule]

On the Classic path (the retail profile; also SKY.md's "Classic" sky option), weather modifies the retail `EnvValues` just before they are pushed. With `c =
cloud`, `d = cloudDark`, `f = fog`, `r = rain`, `grey(x) = luma(x)`:

| Value | Under weather |
|---|---|
| fog end | `fogEnd × mix(1, 0.35, f) × mix(1, 0.75, r)` (at noon in Jangan: clear 250 m, storm ≈ 130 m, fog ≈ 110 m, fog in the swamp ≈ 85 m) |
| fog start | `fogStart × mix(1, 0.05, f) × mix(1, 0.5, r)` |
| fog colour (and clear colour) | `mix(fogColor, grey(fogColor) × 0.85, 0.8 d)` then `× mix(1, 0.7, d)` |
| sky top / bottom | `mix(sky, grey(skyBottom) × 0.9, 0.9 c)` then `× mix(1, 0.55, d)`; lightning adds `flash × (0.55, 0.6, 0.8)` |
| sun diffuse (objects) | `Diffuse × 0.6 × sun` |
| object ambient | `mix(ObjectAmbient, grey(ObjectAmbient), 0.5 c) × mix(1, 0.8, d) + flash × 0.35` |
| terrain light | a new `viewParams.y` = overall terrain brightness `mix(1, 0.72, d)`, and the lightmap contrast `lm' = mix(vec3(0.85), lm, sun)` (shadows fade under overcast, as a real overcast sky does) |
| water colour | `× mix(1, 0.72, d)`, 20 % toward grey |
| character lights (`screens/world.ts` hemi/sun) | `sun.intensity = 1.2 × sun`, `hemi.intensity = 0.7 × mix(1, 0.8, d)` (from the base values, never compounding). The feature does this; `WorldFeatureContext` has no light handles, so it looks them up once with `ctx.scene.getLightByName('sun')` / `('hemi')` (the world's own light is `worldSun`, a different name) **[confirmed names]** |

These are multiplicative, so they compose with any time of day. On the modern path the sky takes `toSkyWeather`
(clouds dim the key light through its own sun occlusion, SKY.md §5.5) and the renderer takes `toRenderWeather`; only
the **fog distances** stay with this spec there too (SKY.md: "the weather lane sets visibility"):
`fogScale(f) = mix(1, 0.35, fog) × mix(1, 0.75, rain)` is the one formula both paths use. SKY.md also lets weather
dim fire lights: the feature scales night point-light intensity by `1 - 0.3 × rain` [SKY.md's suggestion].

### 7.2 Fog

Fog stays linear on view depth in every custom shader (terrain, water, scatter, rain curtain) and Babylon's linear
scene fog for Standard/PBR materials; only start/end/colour change (§7.1). Heavier "fog" states rely on the fog colour
matching the sky bottom so the far terrain melts into it. A height-fog term (denser in valleys: `exp(-(y - y0) /
12 m)`) is a High/Ultra extra for the swamp and lake zones, added in the same fog functions **[our rule]**.

### 7.3 Lightning flash

`flash(t)` for a strike at `t0`: three pulses `3.0 × e^{-(t-t0)/0.05}` at 0, `1.8 ×` at +0.12 s, `1.0 ×` at +0.31 s
(the pattern varies by the strike seed), clamped to 3. It feeds `wxC.w` (terrain/water brighten `albedo × flash ×
0.25`, rain streaks `× (1 + flash)`), the sky colours and ambient (§7.1). The flash inside the clouds and sky is SKY.md's (`SkyWeather.flash`); the terrain/object brightening on the
Classic path and the bolt are this spec's. High/Ultra draw a bolt: a jagged
procedural ribbon (8-12 segments, one fork) at `bearing`, from the cloud base (250 m up) to the ground at `distM`
(clamped to the fog end so it is visible), additive, 180 ms, fading with the flash. The feature clamps flashes to one
per 2 s and has a **reduce flashing** accessibility toggle (`ui.reduceFlashing`, default off): flash × 0.25, no bolt.

### 7.4 Colour grading (RENDER.md §5.2 owns it)

RENDER.md's `GradeMixer` blends LUT keys `clear` / `overcast` / `rain` and applies `weatherExposure` (1.25 overcast,
1.35 rain). Weather supplies the weights (`1 - cloud`, `cloud × (1 - rain)`, `rain`) and `desat`; the notes below
are the Classic-path fallback. Babylon's `ImageProcessingConfiguration` (`exposure`, `contrast`, `colorCurves.globalSaturation` **[confirmed API]**)
only affects Standard/PBR materials unless a post-process applies it to the whole frame; the terrain, water and
scatter are `ShaderMaterial`s. So grading needs the post pipeline (`DefaultRenderingPipeline` with
`imageProcessingEnabled`, or the sibling's own), which the sibling lighting spec owns. Weather supplies:
`exposure × mix(1, 0.88, d)`, `contrast × mix(1, 0.92, c)`, `globalSaturation = -40 × desat` (ColorCurves range
-100..100), and a cool tint `(0.96, 0.99, 1.04)` at full `desat`. Without that pipeline the §7.1 multipliers alone
carry the mood.

### 7.5 Audio (`apps/game/src/audio/weather.ts`, new; export in `export-sound.ts`)

- **Export:** `packages/convert/src/tools/export-sound.ts` adds `etc/rain1`, `etc/lightning1..3`, `env/dd_mainwind`,
  `env/dd_wind_01/02`, `env/donhwang_wind01..05` to the plan (all ambient class: 64 kbps Opus, like `env/*`), and
  `packages/shared/src/sound.ts` gains cues `weather.rain`, `weather.thunder.near/mid/far`, `weather.wind.strong`
  **[our rule]**. Total ≈ 95 s of audio (12 files, durations from ffprobe), ~0.75 MB at 64 kbps.
- **Rain bed:** `rain1` looped (2.3 s is short: two voices at a 1.1 s offset with ±3 % playback-rate difference hide
  the seam; `StartOptions` has no playback rate today, so the backend edit adds `rate?`), gain `0.8 × rain`, on the
  ambient bus. **Wind bed:** `day_wind` below 8 m/s gust speed, cross-faded to `donhwang_wind04` (20.7 s, the
  longest; `donhwang_wind03` is 15.8 s) above, gain `clamp(gustMs / 15)`; which file sounds right is a listening call. **Thunder:** `lightning1` for `distM <
  800` (sharp), `lightning2` below 2000, `lightning3` beyond (long rumble) **[our rule: which file sounds like what is
  unverified; listen and reassign]**, gain `clamp(1.4 - distM / 2500, 0.25, 1)`, played at `at + distM / 343`.
- **Shelter** (weather levels Medium and up only: Low and Off have no shelter map, so no muffling there; W9F A2,
  SOUND.md §8.1): under a roof (shelter map at the listener: the feature asks `world.weather.shelteredAt(x, z, y)`,
  answered from a CPU copy of the last shelter render, read back with the async `RenderTargetTexture.readPixels()`
  once per re-render, 512² × 2 B = 0.5 MB, every few seconds at most) the rain bed goes through a low-pass at 900 Hz and -6 dB.
- **Birds:** `AmbientPlayer` one-shots are suppressed while `rain > 0.25` or `windMs > 10` (a `mute(kind)` flag on the
  player), and resume after.
- **Backend:** `VoiceHandle` gains optional `setGain?(gain, rampS)` and `setLowpass?(hz, rampS)`
  (`audio/backend.ts`); `StartOptions` gains `rate?` (`AudioBufferSourceNode.playbackRate`) and `filter?`;
  `WebAudioBackend.start` inserts a `BiquadFilterNode` for voices started with `filter: true`. Optional members keep the test fakes valid.
- **Better recordings** (optional, the user's call): the retail rain loop is thin. A CC0 rain/thunder/wind set would
  lift it a lot; it must be supplied by the user (nothing is downloaded by the build) and goes into `content/sound/`
  with the same cue names.

---

## 8. Measurements (prototypes in `work/tmp/weather/`)

**CPU** (`proto-cpu.ts`, `pnpm tsx work/tmp/weather/proto-cpu.ts`, dev PC):

| What | Result |
|---|---|
| Wet map, 307 field regions | author: 0.656 ms mean per region, 4.0 ms worst (first call, JIT); fact-check re-runs under load: 0.79-1.11 ms mean, 3.9-7.6 ms worst |
| Puddle potential | ≥ 0.5 on 2.5 % of vertices, ≥ 0.2 on 25.7 % (reproduced exactly) |
| Ripple texture | 128² / 60 drops 2.7-3.9 ms; 256² / 200 drops 11-22 ms (once, at level set, §6.6) |
| Schedule, 60 days | clear 33.1 %, cloudy 30.5 %, overcast 22.4 %, rain 9.9 %, storm 0.9 %, fog 3.1 %; 6.2 rain spells/day |

**GPU** (`gpu/main.ts` + `index.html`, Babylon 9.28 WebGPU, RX 9060 XT, 1920 × 1080, MSAA on). Each frame renders the
scene 100 times and waits for `queue.onSubmittedWorkDone`; per-render cost = (median frame - empty frame) / 100. The
Browser pane was hidden (so frames were driven by a `MessageChannel`, not rAF), and another agent's page shared the
GPU. The noise is larger than first stated: the same wet scene read 0.396 and 0.283 ms in the two runs, and the
rain rows read *below* the wet scene, so treat differences under about ±0.06 ms as noise; two runs are given. The
GPU numbers were not re-measured by the fact-check (it would need a dev server and the browser pane). The terrain stand-in is a 400 × 400 m ground
with 3 texture-array layers, noise blends, a lightmap and fog (close to the real splat's cost with 3 layers).

| Scene | Run 1 (ms / render) | Run 2 (ms / render) |
|---|---|---|
| Dry terrain + 400 roofs | 0.222 | 0.217 |
| Wet terrain (puddles, 2 ripple samples, Fresnel, sky reflection, glint) | 0.396 | 0.283 |
| **Wet minus dry** | **+0.17** | **+0.07** |
| + rain 4k / 8k / 16k / 32k / 65k streaks | — | 0.258 / 0.257 / 0.259 / 0.267 / 0.275 (not separable from noise; all N streaks drawn, 0.55 m × 1.2 cm, no rate culling in the prototype) |
| + shelter map re-rendered every frame (400 thin-instanced roofs + ground, 512² R16F) | — | +0.074 GPU, +0.04 CPU |

CPU per frame for the weather feature itself (blend, integrate, 7 `Vector4` writes) is a few microseconds **[our
rule, trivially small]**; the plugin adds one UBO update per object material per frame (Babylon binds UBOs anyway).

**Projection to other GPUs [projected]:** by peak FP32 throughput relative to the RX 9060 XT (25.6 TFLOPS as AMD
rates it, counting RDNA dual-issue): a mid GPU (GTX 1660 5.0 TF / RX 6600 8.9 TF) about 3-5× slower, Iris Xe (96 EU,
~2.1 TF) about 12×, Radeon 680M (~3.4 TF) about 7-8×, an N100-class UHD (24 EU at 750 MHz, ~0.29 TF) about **90×**
(an earlier draft said 50-60×, which does not follow from the same basis). Integrated GPUs are also limited by
shared memory bandwidth, so these ratios are optimistic for them. Pixel costs scale with the rendered pixel count
(resolution setting 0.75 = 56 %, 0.5 = 25 %). The N100 is the server host; the N100 column below stands in for the
weakest laptop class a friend might use.

---

## 9. Presets and cost

### 9.1 The setting

`apps/game/src/settings.ts`: `graphics.weather: 'auto' | 'off' | 'low' | 'medium' | 'high' | 'ultra'` (default
`auto`), normalised like `scatter`; `auto` maps the graphics preset (low → low, medium → medium, high → high, and
ultra → ultra once the sibling specs add that preset). A row in `hud/options.ts` graphics section (`graphics.weather`,
like `graphics.scatter` at lines 130-135), i18n keys `options.weather`, `options.weather.<level>`, `options.reduceFlashing` in a new `apps/game/src/i18n/en-weather.ts` (imported by `en.ts` like `en-scatter.ts`). The world side:
`WEATHER_PRESETS` in `packages/world-render/src/weather/presets.ts` and `World.setWeatherLevel(level)`.

| Feature | off | low | medium | high | ultra |
|---|---|---|---|---|---|
| Sky/fog/light/water colour multipliers (§7.1), flash in the sky | yes | yes | yes | yes | yes |
| Rain audio, wind, thunder | yes | yes | yes | yes | yes |
| Wet darkening + sheen (terrain, objects, characters, grass) | — | yes (no reflection, glint only) | yes | yes | yes |
| Puddles (wet map, dark bottom, sky reflection) | — | — | yes | yes | yes |
| Ripple normals in puddles and water | — | — | 128², 1 sample | 256², 2 samples | 256², 2 samples |
| Rain streaks (box size m) | — | 3k (30 × 20 × 30) | 10k (36 × 22 × 36) | 20k (40 × 24 × 40) | 40k (44 × 26 × 44) |
| Rain curtain | — | 1 layer | 2 layers | 2 layers | 2 layers |
| Splashes | — | — | 256 | 512 | 1024 |
| Drips | — | — | 64 | 128 | 256 |
| Shelter map | — | — (rain passes roofs, as in retail) | 512², 128 m (RENDER.md §9.4) | 512², 128 m | 512², 128 m |
| Wind on grass / skinned trees | yes / yes | yes / yes | yes / yes | yes / yes | yes / yes |
| Wind sway on static trees (vertex plugin) | — | — | — | yes | yes |
| Lightning bolt mesh | — | — | — | yes | yes |
| Height fog in swamp/lake | — | — | — | yes | yes |
| Sky-probe reflections on objects (PBR path, RENDER.md §4.2) | — | — | yes | yes | yes |
| Lens drops (needs RENDER.md's post stack) | — | — | — | — | yes |

The wet/puddle/ripple/static-sway rows are the **Classic-path** implementation (§6.0). When the graphics preset puts
a surface on the PBR path, RENDER.md's plugins draw those effects and the weather level only feeds `RenderWeather`;
RENDER.md §10 also turns height fog on from Medium, so the swamp/lake height-fog row must not add a second fog
term there.

### 9.2 Frame-time budget and cost table (1080p unless noted)

Budgets **[our rule]**: the weather layer may add at most **1.5 ms** on a mid GPU at High and **1.0 ms** on an
integrated GPU at Low with resolution 0.75. Costs below: dev GPU measured where marked, others **[projected]**.

| Item | Dev GPU (RX 9060 XT) | Mid GPU (GTX 1660 / RX 6600) | Integrated (Iris Xe / 680M), res 0.75 | N100 UHD, res 0.5 | Preset |
|---|---|---|---|---|---|
| Wet terrain, full screen (Low: darkening only) | +0.07-0.17 measured | 0.3-0.8 | 0.5-1.2 (Low ≈ 0.15-0.4) | 1.6-3.8 → Low ≈ 0.6 | low (darkening) / medium+ (full) |
| Wet objects + characters (plugin; ~35 % of pixels) | ~0.03-0.06 | 0.1-0.3 | 0.2-0.4 | 0.75 (darkening only) | low+ |
| Rain streaks (preset N) | ≤ ~0.06 (noise floor) at 65k | 0.05-0.15 | 0.1-0.3 (3k-10k) | 0.3-0.6 (3k) | low+ |
| Curtain | ~0.02 | 0.05-0.1 | 0.1-0.2 | 0.3 | low+ |
| Splashes + drips | ~0.01 | 0.05 | 0.1 | — | medium+ |
| Shelter map (every 2-8 s; per render) | 0.074 measured at 64 m; ≈ 0.1-0.3 at 128 m | 0.3-1.5 per render, ~0.05-0.1 average | 1-3.5 per render, ~0.1-0.3 average | — | medium+ |
| Water ripples + reflection | ~0.02 | 0.05-0.1 | 0.1-0.2 | — | medium+ |
| Scatter wind/wet | ~0.01 | 0.03 | 0.05 | 0.15 | low+ |
| **Total at the preset** (sum of the rows) | **≈ 0.2-0.35** (ultra) | **0.7-1.6** (high) | **1.3-2.8** (medium) / **0.6-1.4** (low) | **2.1-2.4** (low) | |

The totals were re-added by the fact-check: an earlier draft gave 0.8-1.5 (integrated medium), 0.5-0.9 (integrated
low) and 0.8-1.2 (N100), less than its own rows add up to. So on an integrated GPU **Medium is over the 1.0 ms
budget** (use Low), Low is at or over it, and an N100-class iGPU needs weather `low` at render scale 0.5 and may need `off`; the playtest in §11 decides
**[projected]**.

The shelter re-render is the one spike (one extra pass of the nearby objects); it is spread by the refresh policy and
skipped entirely in dry weather. Weather adds **no** CPU-side particles and no per-frame allocations.

### 9.3 What would take it further (not in this spec)

Screen-space reflections of the whole scene in puddles (needs a depth/normal prepass that our `ShaderMaterial`s write
into), volumetric clouds and god rays, new rooftop geometry with gutters that pour water, displaced ground with real
puddle hollows, snow (the retail `snow1/2.ddj` exist; Jangan never snows), and hand-authored wet texture variants
from the PBR pipeline (the sibling spec could emit a per-tile "wet roughness" map; the class table here is the
fallback).

---

## 10. Build plan

Five lanes. WX-0 lands first (small); WX-S, WX-R, WX-A can then run in parallel; WX-C last. Every lane runs `pnpm
vitest run <its tests>` and `pnpm typecheck` before hand-off. Nobody commits; the lead
integrates.

**Cross-spec coordination (read first).** RENDER.md's lanes add the PBR path next to the Classic one (new plugins,
`materials.ts` branching per preset, the rain occlusion map, the post stack); SKY.md's lanes edit `sky.ts`,
`environment.ts` and `world.ts` `applyEnv`, and also add `WorldInfo`/server-message fields. Rules that keep the three
mergeable:

- **One `World.setWeather`**: this spec's (`WeatherFrame`); SKY and RENDER expose `sky.setWeather(SkyWeather)` and
  `render.setWeather(RenderWeather)` on their own subsystems, called from it through §5.3's adapters. The lead should
  confirm this before any of the three lanes starts (SKY.md seam W1 and RENDER.md §9.1 both name `World.setWeather`).
- **One shelter map** (`world.render.rainOcclusion`, RENDER.md §9.4): if WX-R lands first it creates it in
  `weather/shelter.ts` with that name and RENDER's parameters; the render lane then moves or keeps the file.
- **One ripple texture** (`world.weather.rippleTexture`, §6.6), one `fogScale` (§7.1), one wet/dry integrator (§6.1).
- **Classic-path shader edits are markers only:** WX-R puts every snippet in `weather/chunks.ts` (exported WGSL/GLSL
  strings), and its edits in `shaders.ts` / `scatter-assets.ts` are `${...}` interpolations at the hook points of
  §6.2/§6.7/§6.9 marked `// @weather:<name>`. RENDER.md keeps the Classic shaders "unchanged", so it will not touch
  those lines.
- **`applyEnv`** gets one call `applyWeatherToEnv(env, frame)` (pure, `weather/env.ts`), Classic path only; SKY's
  modern path bypasses it.
- **Shared protocol files** (`protocol.ts`, `validate.ts`, `WorldInfo`): WX-0 and SKY-A both add fields; they are
  additive and independent (`weather` / `clock`), but one agent at a time edits those files.
- **`'ultra'`** as a `WorldQuality` value is owned by one of the sibling lanes (SKY.md §9.1 / RENDER.md §10);
  `graphics.weather` maps to it when it exists.

### WX-0: shared types and protocol (one agent, first)

- OWNED: `packages/shared/src/weather.ts` (new: `WEATHER_KINDS` re-export, `WEATHER_PARAMS` table §2.1,
  `blendWeather(sync, now, current?)`, `scheduleAt(seed, t, opts)`, `ZONE_CLIMATE`, `stepSurface`, `flashAt`,
  `mulberry32`); `packages/shared/src/protocol.ts` (`WeatherKind`, `WeatherSync`, `weather` and `lightning` in
  `ServerMessage`, `WorldInfo.weather?`); `packages/shared/src/validate.ts` (parsers); `packages/shared/src/index.ts`
  export; `docs/PROTOCOL.md` (a "Weather" subsection of §11).
- Tests (`packages/shared/test/weather.test.ts`): schedule determinism (same seed → same segments; restart at any t
  → same answer), 60-day shares within ±3 % of §2.3, blend endpoints and the rain lag, `stepSurface` times (soak to
  0.9 in 80-100 s at rain 1; dry from 1 to 0 in 8.5-10 min at sun 1, wind 2 m/s; puddles never exceed `wet + 0.1`), validator round trips and rejections.

### WX-S: server (after WX-0)

- OWNED: `apps/server/src/weather.ts` (new: module, GM runner, `WEATHER_USAGE`); `apps/server/src/config.ts` (three
  keys, §2.3); edits: `gameplay.ts` (construct and register the module), `connection.ts` (`world.weather` in
  `worldEnter`, one line), `gm.ts` (one `COMMANDS` entry).
- Tests (`apps/server/test/weather.test.ts`): `worldEnter` carries `weather`; a schedule change broadcasts once to
  all players; GM `weather storm 5 0` → immediate `weather` with `to: 'storm'`, `gm: true`; `weather auto` clears
  it; `weather strike` → one `lightning`; strikes ≥ 4 s apart; `WEATHER=off` → never a `weather` after enter.
- User-visible check: `/weather rain` in chat as a GM gives a "Weather: rain in 60 s" system line.

### WX-R: world-render (after WX-0; the big lane)

- OWNED new files: `packages/world-render/src/weather/{frame.ts, adapters.ts, presets.ts, chunks.ts, env.ts, wetmap.ts,
  shelter.ts, ripples.ts, rain.ts, wet-plugin.ts, index.ts}`.
- Hook edits (only at the `// @weather:` markers): `shaders.ts` (terrain uniforms/samplers, `vWorld`, layer-loop
  accumulation, pre-lightmap albedo, post-lightmap reflection; water ripples/reflection), `terrain.ts` (layer map
  alpha = 128 + class; `wetMap` per region built as its own streaming commit job after `buildRegion` (§6.2) and disposed in `disposeRegion`; `WX` define and the
  shared uniforms on each material), `water.ts` (uniforms, animation rate), `scatter-assets.ts` (wind/wet uniforms and
  the sway/droop/darkening), `scatter.ts` (share the `wx*` objects in `material()`), `objects.ts` (`setWind`,
  foliage flag per model), `materials.ts` (`attachWetness` in `convert`), `world.ts` (`World.weather`,
  `setWeather(frame)`, `setWeatherLevel(level)`, `applyWeatherToEnv` call in `applyEnv`, `weather.update()` in
  `update()`), `index.ts` exports.
- Tests (`packages/world-render/test/weather-*.test.ts`, NullEngine like the existing tests): `wetmap` on synthetic
  heights (a bowl → high R at the centre, a slope → 0, a water tile → 0) and on one real region when
  `sro.config.json` exists (coverage 1-5 % at ≥ 0.5); the rain wrap function (a pure TS mirror of the vertex math:
  every drop stays inside the box as the camera moves 1000 m); layer-map alpha encoding round trip; every shader
  string pair declares the same `wx*` uniforms (WGSL vs GLSL parity check by regex); the plugin returns WGSL for
  `ShaderLanguage.WGSL` and GLSL otherwise, and `isCompatible` is true for both; `setWeatherLevel('off')` disposes
  the rain meshes and the shelter RTT; `applyWeatherToEnv` table values of §7.1 at storm and fog; `toSkyWeather` / `toRenderWeather` ranges (every field 0..1 or within the sibling ranges for all six states).
- Viewer hook: `apps/viewer` gets a weather panel (state buttons, wet/puddle sliders, wind) only if the viewer lane
  wants it; otherwise the game's `?weather=` override is enough.
- User-visible checks: in the viewer or game with `?weather=storm`: rain slants with the wind, stops under the
  Jangan gate roofs and pavilions, splashes on the plaza, the plaza and roads darken and shine, puddles appear in
  the low spots of the dirt roads after a few minutes, grass bows and whips, trees sway faster; switch to `clear` and
  watch it dry over ~9 min (puddles gone after ~12 min).

### WX-A: sound export (small, parallel)

- OWNED: `packages/convert/src/tools/export-sound.ts` (the §7.5 files in the plan), `packages/shared/src/sound.ts`
  (weather cues), `docs/SOUND.md` (a short weather section).
- Tests: the export plan contains the 12 files; the index has the cues; `pnpm sro export-sound` writes
  `work/out/sound/etc/rain1.ogg` etc. (skips without `sro.config.json`).

### WX-C: game client (after WX-0, WX-R, WX-A)

- OWNED: `apps/game/src/world/features/weather.ts` (new), `apps/game/src/audio/weather.ts` (new), edits:
  `world/features.ts` (one line), `settings.ts` (`graphics.weather`, `ui.reduceFlashing`), `hud/options.ts` (two rows),
  `audio/backend.ts` (`setGain?`, `setLowpass?`, `rate?` and `filter?` start options), `audio/ambient.ts` (mute one-shots),
  `audio/index.ts` (own a `WeatherAudio`), `three/models.ts` (`attachWetness` on actor materials),
  `i18n/en-weather.ts` (new, keys) plus its import in `i18n/en.ts` (like `en-scatter.ts`), `hud/perf-overlay.ts` (a weather line: state, rain, wet, streaks).
- Tests (`apps/game/test/weather-feature.test.ts`): a fake world receives frames; `worldEnter` with a mid-transition
  sync gives the right blended `rain`; a `weather` message mid-transition blends from the current vector (no jump);
  thunder is scheduled `distM / 343` s after the flash; `reduceFlashing` scales the flash; the settings normaliser
  maps `auto` per preset; `WeatherAudio` with a fake backend: rain gain follows `rain`, low-pass engages when
  sheltered, birds muted in rain.
- User-visible checks (the user, in the browser, as a GM):
  1. `/weather rain` — clouds gather for about a minute, then rain starts; rain sound fades in; birds stop.
  2. Stand under a roof or a big tree — no streaks there, the rain sound is muffled, your character stays dry.
  3. Walk the plaza and a dirt road — the stone darkens and reflects the sky; after 3-5 min puddles with rain rings
     form in the low spots.
  4. `/weather storm` — heavier slanted rain, strong gusts in the grass and trees, lightning flashes, thunder a few
     seconds later.
  5. `/weather clear` — rain stops first, the sky clears, trees drip for a while, puddles shrink and the ground dries
     over ~9-13 min (puddles last ~12-19 min, §6.1).
  6. `/weather fog` — the view closes in to about 110 m (85 m in the swamp) and the far hills melt into the fog colour.
  7. Options → Graphics → Weather: `off` keeps grey sky, fog and sound but no rain; `low` on a laptop keeps 60 fps.
  8. A second player logging in mid-storm sees the same weather and the same puddles at once.

---

## 11. Open questions and risks

- **Shelter map and streaming commits.** A region's objects appear a few frames after its terrain; the map must
  re-render on the objects' commit (§6.5 policy), or rain falls through a freshly streamed roof for up to 2 s.
- **Half-float render targets on WebGL2** are an extension (`EXT_color_buffer_half_float` / `_float`); the RGBA8
  fallback is specified but untested on a real old GPU **[unknown]**.
- **Plugin code in PBR block functions** reads `fragmentInputs` and `uniforms` from inside `pbrBlockReflectivity`;
  this is correct for WGSL (module-private) and for GLSL (globals) by the processed source. RENDER.md §3.5's
  prototype compiled plugin code at `CUSTOM_FRAGMENT_UPDATE_ALBEDO` and `CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS`
  on WebGPU **[confirmed there]**; `CUSTOM_FRAGMENT_UPDATE_MICROSURFACE` (used here) sits later in the same
  `reflectivityBlock` function, after the metallic-roughness path sets `microSurface`, but has not been compiled yet
  **[likely]**. Using RENDER's `UPDATE_METALLICROUGHNESS` point instead (`metallicRoughness.g = mix(r, 0.08, gloss)`)
  would share one proven hook. If a Babylon update moves those defines, fall back to
  `CUSTOM_FRAGMENT_BEFORE_LIGHTS` with `surfaceAlbedo`/`microSurface` (they are `var`s in `pbr.fragment` main).
- **Skinned tree speedRatio** may look like "fast-forward" rather than wind on some clips; if so, cap at 1.5 and rely
  on the vertex sway (which would then need the plugin on skinned foliage too: `CUSTOM_VERTEX_UPDATE_WORLDPOS` runs
  after skinning, so it composes) **[unknown until seen]**.
- **Thunder file mapping** (§7.5) is a guess; listen and reassign.
- **The retail rain loop** (2.3 s) is short; the two-voice trick hides most seams, but a longer CC0 loop from the user
  would be better.
- **Integrated GPU numbers are projections**; the first playtest on the user's weakest laptop should record the
  perf overlay at `low` in a storm, and the preset table should be tuned from it.
- **Three specs, one `World.setWeather`.** SKY.md (W1) and RENDER.md (§9.1) each name `World.setWeather` with their
  own struct; §5.3 and §10 propose that this spec's `WeatherFrame` version is the public one and the other two become
  subsystem setters fed by adapters. Needs the lead's decision before the lanes start.
- **Shelter map resolution.** RENDER.md §9.4 uses 128 m at 512² (25 cm texels); the rain prototype used 64 m (12.5 cm).
  25 cm is fine for roofs and eaves; drips from thin branches may leak. Keep 128 m unless the check at the Jangan gate
  shows streaks through eaves.
- **Double darkening.** A surface must get wetness from either the Classic `WetnessPlugin` or a RENDER.md plugin,
  never both; `attachWetness` checks for the RENDER plugins by name (`SroSurfacePlugin`, `SroTerrainPlugin`).
- **Gameplay:** weather is cosmetic by design (no movement or combat modifiers); fog hides monsters only beyond about 85-110 m, well
  past the range where players target and fight, so gameplay is unaffected **[our rule]**.
