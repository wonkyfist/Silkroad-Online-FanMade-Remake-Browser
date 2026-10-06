# Winter: the snow season

The snow season is the winter environment of the Jangan world. From December 1 to January 15 (server time zone), rain falls as snow. The snow settles over hours, lies on the ground, the roofs and the trees, and melts slowly on sunny days. The ponds and the fountain freeze. The grass frosts and the flowers close. Storms become blizzards. Walkers leave footprints, people's breath steams in the cold, footsteps crunch, the world goes quiet under snow, and a blizzard howls.

There are **no decorations**: no lanterns, Christmas tree, paper ornaments or ice sculptures. The frozen fountain and ponds are environment. The gameplay layer (cold and body warmth, snowballs, winter monsters, gift boxes) is not built here; §9 lists the hooks it can build on.

This doc continues the approved prototype (`work/tmp/snow-preview/`, the sheet in Dropbox `snow-preview/`) and fixes its known gaps (§10). It is part of the weather series: docs/WEATHER.md owns the weather state and the storms, and this doc owns the season, the snow and the winter look.

---

## 1. Decisions in one screen

| Topic | Decision |
|---|---|
| Season | **Dec 1 – Jan 15**, both days inclusive, in the server's time zone; a start after the end wraps the new year. Dates, on/off, time zone and snow strength are admin settings, applied live. |
| First snow | Nothing turns white at midnight on Dec 1. The cover only grows while snow falls, so the first snowfall eases in over hours (§2.2). |
| Melt | In season the snow melts slowly, by daylight and under a clear sky (a full cover lasts about 20 h of full sun). Rain washes it away. Outside the season it melts within about 3 h. |
| Weather | In season the schedule's **rain falls as snow** and its **storms (and storm events) are blizzards**. Every other state is unchanged. Snow never wets surfaces. |
| GM | `weather snow[:i]` / `weather blizzard` snow at any time of year, and `weather rain` rains in December: a GM hold is taken as typed. `winter preview on` shows the full season look to everyone. `winter cover|frost <0-1>` sets the snow now. **None of these changes the season, its dates or the timeline.** |
| Blizzard gameplay | A blizzard is a storm for every storm effect (§4), with drifts instead of mud and no water spirits under the ice. Thunder-snow is rare (0.25 strikes/min against a storm's 5). **No tornadoes in the season** unless `WINTER_TORNADO` is on. |
| Wire | Additive: `WorldInfo.winter`, the `winter` message, `snow` / `blizzard` weather kinds, `WeatherParams.snow`, `StormStatus.winter`, and the effect ids `snow` and `drifts`. Clients integrate the cover forward like the surface wetness (§5). |
| Look | One snow plugin on the PBR materials (Medium+), one on the Classic StandardMaterials, and a Classic chunk on the terrain splat and every grass shader (**Low gets snow on the ground too**). Ice on the inland water, GPU snowfall, a winter colour grade on PBR and a winter palette on Classic. Nothing compiles or draws without snow or frost (§7). |
| Cost | Measured on this PC (§11): about +0.1–0.45 ms GPU on High, +0.1–0.3 ms on Medium, +0.05–0.3 ms on Low; the snowfall adds nothing measurable. |

---

## 2. The season and the snow (`packages/shared/src/winter.ts`)

### 2.1 Dates

`inSeason(ms, { start, end, timeZone })` reads the calendar day of `ms` in `timeZone` (`Intl.DateTimeFormat`) as month × 100 + day. With start ≤ end the season is `start ≤ day ≤ end`; with start > end it wraps the year (`day ≥ start || day ≤ end`). Bad dates are never in season. An unknown time zone falls back to UTC.

`nextSeasonChange` finds the next start or end to the hour, for the GM line and the admin panel. The server time zone is the process's own (`hostTimeZone()`), unless `WINTER_TZ` names another one.

### 2.2 Cover and frost (`stepWinter`)

The state is `{ cover, frost }`, both 0..1. It is integrated in sub-steps of at most 60 s, and a catch-up is capped at 72 h.

| Term | Rate | So |
|---|---|---|
| Settling | `+snow / coverS` per s (`coverS` = 3 h; × 0.5 outside the season) | A blizzard covers bare ground in 3 h and the `snow` state (0.6) in 5 h; a dusting shows after about 30 min |
| Melt in season | `(1 − snow) × sun × daylight / meltSunS` (`meltSunS` = 20 h) | A clear day melts about 5 % an hour by daylight; overcast about a third of that; nothing at night or while it snows |
| Melt out of season | `(1 − snow) / meltWarmS` (3 h) | After Jan 15 the snow is gone within a few hours; a GM snow in October whitens at half rate and melts after |
| Rain | `rain / meltRainS` (2 h) | A GM rain in December washes it away |
| Frost | `+1/freezeS` in season (4 h), `−1/thawS` outside (6 h) | The ponds freeze about 2 h into the season (`FROST_ICE` = 0.5) and thaw about 3 h after it |

On average across the schedule (rain about 10 % of the time, so snow in season, plus about 3 storm events a day as blizzards), the cover grows by roughly 3 %/h and melts by roughly 1 %/h in the season. A snowy season stays white, and long clear spells thin the snow visibly.

---

## 3. Snow and blizzards in the weather (`packages/shared/src/weather.ts`, `apps/server/src/weather.ts`)

Two weather kinds are new. `snow` and `blizzard` are the winter forms of `rain` and `storm` (`winterKind`). The Markov schedule never leads to them itself (its table and shares are unchanged).

| Param | snow | blizzard |
|---|---|---|
| cloud / cloudDark | 0.92 / 0.30 | 1.00 / 0.55 |
| rain | 0 (never wets) | 0 |
| **snow** (new param, 0 in the other states) | 0.60 | 1.00 |
| windMs / gust | 3 / 0.3 | 14 / 0.9 |
| fog | 0.30 | 0.75 |
| sun / desat | 0.35 / 0.30 | 0.15 / 0.50 |
| lightning (per min) | 0 | 0.25 (thunder-snow) |

- `snow` takes an intensity like rain (`snow:0.4`..`snow:1` scales the snowfall and the dark cloud). The snowfall lags the clouds like rain.
- The fog end shrinks by `× (1 − 0.3 snow)` (`fogScale`; a blizzard is about 0.36 of a clear day's view), and the fog start by `× (1 − 0.4 snow)`.
- **Server.** `WeatherService.winter` (the winter module; `WeatherHost.winter` from the start, so a server started in December joins its snow) maps the schedule: `seasonal(kind)` turns rain into snow and storm into blizzard while the season is on. This covers the start vector of a running transition, the 90-minute wetness warm-up, and the storm events: the forecast keeps the snow falling, then the event is a blizzard. A GM hold is taken as typed.
- **The season starting or ending mid-rain** starts an ordinary transition (rain to snow over 2 min).

---

## 4. Storms in winter (`packages/shared/src/storm.ts`, `apps/server/src/storm/*`)

`StormEnv` gains `snow` (the snowfall rate) and `frozen` (frost ≥ `FROST_ICE`). `stormLevel(p)` is the higher of the lightning share and the blizzard share `(snow − 0.6) / 0.4`, so a blizzard is a full storm and plain snow is none.

| Effect | Rain / storm (unchanged) | Snow / blizzard |
|---|---|---|
| `wet` (lightning hurts more) | rain | **none**: nobody gets wet |
| `sight` | rain | **snow** too (the same curve on the snowfall) |
| `fire` −, `cold` + | rain | **snow** too |
| `lightning` + | rain | none |
| `mud` (run −10 %) | soaked ground | none; **`drifts`** (run −`driftSlowPct` 10 % outside towns) **during a blizzard only**: a season-long slow in town would be a chore |
| storm effects (undead, packs, bandits, panic, charged, night, wind) | storm | **blizzard** |
| `water` (water spirits rise) | storm | **none while the ponds are frozen** |
| `snow` (new, no pct) | — | shown while it snows |

- `stormPhase` is `rain` while it rains or snows. `StormStatus.winter` tells the client that the precipitation is snow, so the icon draws flakes (and wind streaks in a blizzard), and the tooltip and chat say "Snowfall", "Blizzard" and "A blizzard is coming". The server sets `winter` when snow outweighs rain, or, when dry, while the season is on.
- **Tornadoes**: `TornadoService.chance()` is 0 while the season is on, unless `WINTER_TORNADO` is on. GM tornadoes still come.
- Lightning in a blizzard is the ordinary placed strike at the low blizzard rate (thunder-snow), and the rods prepare for it as for any lightning.

---

## 5. The wire (protocol v1, additive; docs/PROTOCOL.md "Winter")

- `WinterSync` = `{ season: boolean, cover: 0..1, frost: 0..1, at, strength: 0..1, start: 'MM-DD', end: 'MM-DD', timeZone, preview?: true }`.
- `worldEnter.world.winter?: WinterSync`. A malformed value drops only that field.
- `{ t: 'winter', winter }` goes to every player in the world when the season begins or ends, a GM changes the snow or the preview, the admin changes a winter setting, and every 10 min as a resync. A malformed frame is rejected.
- The client mirrors it (`apps/game/src/world/winter/client.ts`). It integrates `cover` and `frost` forward from `at` with `stepWinter`, under the weather the player sees and the sky's daylight, and eases the drawn look toward each new message (time constant 2.5 s), so nothing pops. A preview draws cover = strength and frost = 1.
- An older client ignores `winter` (unknown type) and drops `StormStatus.winter`. It rejects the new kinds and effect ids, as for any closed list; server and client deploy together.

---

## 6. Server module, GM and admin

**`apps/server/src/winter.ts` (`WinterService`, GameplayModule `winter`)** runs after the weather in the module order.

- **Ticks once a second.** It integrates the cover and frost from `weather.params(now)` and `Gameplay.daylight(now)` (1 − nightness of the clock's sun). It broadcasts when the season flips and every 10 min.
- **Persists** to `<DATA_DIR>/winter.json` (atomic: tmp + rename) every 2 min while the snow changes, and after a GM change. On start it carries the save forward along the weather schedule. Without a save, or after a gap of more than 72 h, it warms up from bare ground over the last 72 h of the schedule (storm events and GM holds are not replayed). The season is looked up once a minute (`Intl` is not free).

**GM** (also `/winter` in chat):

| Command | Effect |
|---|---|
| `winter` | Status: season on or not, dates, time zone, days to the next change, cover, frost, snowfall, strength, preview, the tornado knob |
| `winter preview [on\|off]` | Everyone sees the full season look; the season, its dates and the integrated snow are unchanged |
| `winter cover <0-1>` / `winter frost <0-1>` | Set the snow now; it goes on building up or melting with the weather |
| `weather snow[:0.4-1]` / `weather blizzard` | Snowfall as a GM weather hold, any time of year (docs/WEATHER.md §3) |

**Admin settings** (group "Winter season", all live; `apps/server/src/admin/settings.ts`). A change calls `winter.refresh()`, which re-evaluates the season and broadcasts.

| Key / env | Default | |
|---|---|---|
| `winterEnabled` / `WINTER` | on | Off: no season (GMs can still snow) |
| `winterStart` / `WINTER_START` | `12-01` | MM-DD, checked as a real day |
| `winterEnd` / `WINTER_END` | `01-15` | inclusive |
| `winterTz` / `WINTER_TZ` | the server's | IANA zone, checked with `Intl` |
| `winterStrength` / `WINTER_STRENGTH` | 1 | 0..1: how white full cover looks (0 = snow falls but never lies) |
| `winterTornado` / `WINTER_TORNADO` | off | tornadoes in blizzards |

The panel gained a generic `text` setting type (`AdminSettingDef.type: 'text'`, with `pattern` and `placeholder`). The panel checks the pattern and the server checks again (`SettingSpec.check`).

---

## 7. Rendering (`packages/world-render/src/winter/`)

`World.winter` (`WorldWinter`) reads the frame's winter fields: `WeatherFrame.snow` (snowfall rate), `cover` (after the admin strength) and `frost`. All are optional and absent means 0. It runs after the weather in `World.update`, and `World.dispose` disposes it.

### 7.1 Snow on materials (`plugin.ts`, `shaders.ts`)

- **`SroSnowPlugin`** (PBR, priority 280, after terrain 200 / water 240 / surface 250 / foliage 260, before the height fog 300).
  - At `CUSTOM_FRAGMENT_UPDATE_ALPHA` it reads the final world normal (the terrain plugin writes its normal there first).
  - Coverage is a field from the up-ness of the normal, two world-space noises and, on terrain, a slope cut-off, compared with a threshold that falls as the cover rises: a thin cover is a dusting on the flattest spots.
  - Branches:

    | Branch | Rule |
    |---|---|
    | Terrain | Slopes of about 50° and up stay bare |
    | Objects | Roofs, wall tops and steps whiten; walls and steep rock faces stay bare (up-ness 0.5–0.74) |
    | Foliage | Patchy snow on top of the crowns |
    | Ice | Cracks and wind drifts (at most about half the surface) |
  - It raises the roughness at `UPDATE_METALLICROUGHNESS`.
  - It never touches skinned meshes, water or the ocean, unlit materials, or the self-lit lanterns and windows.
- **`SroSnowStdPlugin`** (Classic StandardMaterials, `CUSTOM_FRAGMENT_UPDATE_DIFFUSE`) applies the same rules to the world objects (the WetnessPlugin's materials) and treats alpha-tested objects as foliage.
- **Registration.** Both are registered with Babylon's plugin factory on every install. Babylon clears all global plugins when its last engine is disposed (a GPU-loss rebuild), so a once-only registration would silently lose the snow on the next engine. They are also attached to the materials that already exist.
- **No per-frame recompiles.** One define gate (`SnowState.setOn`) opens with the first snow or frost and closes 10 s after both are gone: one recompile per material each way. Cover, frost, the overcast and the night are uniforms (`snwA`, `snwB`). Tested: 120 frames of changing amounts keep the same effect, and the gate swaps it and back again from the effect cache.

### 7.2 Classic terrain and grass (`chunks.ts`, the `WINTER_CHUNKS` lane)

The lane comes last in `WORLD_SHADER_CHUNKS`. Everything sits behind `#ifdef SRO_SNOW`, set on the terrain and the scatter by the gate.

- **Terrain splat (Low).** `preLight` takes a facet normal from the world-position derivatives and decides the cover. `postLight` lays the snow lit by the light the ground got (the lit colour over the unlit albedo), so it darkens at night and in the baked shadows like the ground. The prototype pushed its chunk after the terrain shaders had been assembled at module load, so the Low ground stayed bare.
- **Every grass shader** (the Classic scatter, the field and the meadow ring).
  - `vertexSway`: frost flattens the blades to 45 %, and the cover buries up to 45 % of the clumps.
  - `fragmentColor`: frost pales the colour toward a cold grey. The mix preserves luminance, so it works lit or HDR, and it comes after RND-W's HDR lighting chunk (the only point where render is not last; it fills no `vertexLight`, so the TAA jitter stays the last vertex write).
  - `GrassField.setWinter` closes the flowers and hides the far meadow's flower dots past frost 0.5.

### 7.3 The grass field

Covered by §7.2 (`WorldScatter.setWinter` → `GroundCover.setWinter`).

### 7.4 Snowfall (`snowfall.ts`)

The rain box re-cut for flakes and placed entirely on the GPU: world-anchored, wrapped around the camera, a near layer and a far layer. A blizzard drives the flakes sideways, faster and thicker, stretched along their path.

| Weather level | Near + far flakes |
|---|---|
| Low | 4k + 0 |
| Medium | 8k + 4k |
| High | 16k + 9k |
| Ultra | 20k + 12k |
| Off | none |

The share drawn follows the rate. The flake colour is the scene's precipitation tint (`WorldWeather.precipColor`, already divided by the HDR exposure), so flakes never glow at night. Rebuilt only on a level change.

### 7.5 Ice (`ice.ts`)

Past frost 0.5, every inland water plane (`water_*`, both paths) wears one ice material: PBR or Standard, `metadata.snowIce`, so the snow plugin draws cracks and drifts.

- It sits **2 cm below** the water plane. Object floors can lie only centimetres above a plane they hide (the Jangan plaza paving: 4 cm), and an opaque ice above them showed through; the prototype's 6 cm lift did exactly that.
- The fountain's falling water (`waterfall`) turns to translucent ice.
- Pond plants (`c_pondflower`, the w12 `lily_pads` / `pond_flower` species) are hidden with `layerMask = 0`, which no LOD switch touches. The region batch keeps them in groups of their own (`materials.ts batchClass` → `separate`, a few extra draws in the regions that have them) so they can be found by their material's source model.
- The ocean stays liquid. Everything is restored on thaw, on a render-path change and on dispose.

### 7.6 Light and colour

- **PBR.** `GradeMixer` applies a winter step over the blended LUT by the winter weight (`RenderWeather.winter` = max(0.6 × frost, cover)).
  - By day: a nearly neutral balance, a little less saturation and +6 % contrast (+5 % more under overcast: the shape of the snow).
  - By night: less saturation and a slight warm counter to the night key's blue, instead of piling more blue on white snow.
  - The LUT is re-blended only when a weight moves by more than 0.01.
- **Classic sky.** `applyWinterToEnv`, by day only: the fog and horizon whiten toward a cold grey, the sun cools a little, and the object ambient and terrain shadow lift with the cover (snow throws light back).
- **Every path.** The sky haze and precipitation include the snowfall, and the fog closes in (§3).

---

## 8. Client features (`apps/game`)

- **The frame.** `world/features/weather.ts` mirrors `winter` (WinterClient) and puts `cover`, `frost` and the snowfall in the frame. The snow on the ground is drawn **even without the new weather look** (Low and its classic combination too: the season is content); the flakes follow the weather level like the rain. `?winter=<0..1>` holds a look offline.
- **Footprints** (`world/winter/prints.ts`).
  - Players, monsters and NPCs within 45 m leave a print every 0.72 m, left and right in turn, turned along their path, while the cover is at least 0.2.
  - Teleports and riders leave none.
  - A print fades over 120 s (40 s while it snows hard); at most 900 are kept.
  - One updatable mesh with a procedural boot shape, multiplied into the ground (blend DST_COLOR × SRC), so a print reads the same on Classic and HDR, by day and night.
- **Breath** (`world/winter/breath.ts`). While frost ≥ 0.4, up to 16 people within 25 m (players and NPCs) breathe out a puff every 3.2 s (staggered). Each puff grows, drifts with the wind and fades in 1.5 s, drawn as one billboard mesh tinted like the flakes.
- **Sound** (`audio/winter.ts`, `world/features/winter.ts`).
  - **Footsteps** become the retail snow steps (`mvwalksnow` / `mvrunsnow`) on snowy ground from cover 0.35; wood floors and water keep theirs.
  - **Muffle.** The ambient bus drops by up to 25 % under the cover and 12 % in falling snow, and the birds are silent while it snows.
  - **Blizzard howl.** Two synthesized 7 s segments (`synth/winter_howl_a/b`, seeded, nothing downloaded) overlap every 5 s. The level follows the blizzard and the wind, and halves under a roof. The retail strong-wind bed and gusts play under it as in a storm.
- **Storm HUD.** Flakes in the weather icon (with wind streaks in a blizzard); "Snowfall", "Blizzard" and "A blizzard is coming" lines; and tooltips for `snow` and `drifts`.

---

## 9. Hooks for a later gameplay layer (not built)

- **Server:** `gameplay.winter.state(now)` → `{ season, cover, frost, frozen, snowing }`; `winter.active(now)`; `StormEnv.snow` / `frozen` in every storm hook. A cold or warmth system, snowballs (cover ≥ x), winter monsters (`season`) and gift boxes can read these without touching the weather.
- **Client:** `world.weatherState.cover` / `frost` / `snow`; the `winter` message.

---

## 10. The prototype's known gaps, fixed

| Gap | Fix |
|---|---|
| Classic / Low terrain splat stayed bare | The terrain chunk is a static lane of `WORLD_SHADER_CHUNKS` (the prototype's push came after the shaders were assembled), lit by the ground's own light |
| Overcast too white and flat | Lower snow albedo (0.62); a relief term from the underlying texture (mortar, cracks, bark stay readable under the snow); greyer snow under a flat sky; +5–6 % grade contrast; the threshold coverage makes a thin cover patchy instead of a uniform 20 % white |
| Night strongly blue | Neutral snow albedo; no cold tint at night; the winter grade desaturates the night instead of adding blue |
| Lotus and lily pads on frozen ponds | Pond plants hidden while frozen (batched in groups of their own, hidden by layerMask); the ice no longer lifts above the plaza floor (§7.5) |
| Breath vapour missing | Built (§8) |

---

## 11. Measured cost (this PC: AMD GPU, Chrome headless WebGPU, 1600 × 900, the plaza framing of the prototype)

GPU time is the median of `EngineInstrumentation.gpuFrameTimeCounter.lastSecAverage`. The baselines vary by ±0.3 ms between runs, so the differences are ranges.

| Tier | Baseline GPU | Cover + frost | + snowfall | Blizzard |
|---|---|---|---|---|
| High (PBR) | 3.7–4.6 ms | +0.1–0.45 ms | ±0.1 ms more | no more than snowfall (the whiteout hides geometry: 4.1 ms) |
| Medium (PBR) | 2.5–3.0 ms | +0.1–0.3 ms (one noisy pair +0.6) | ±0.1 ms | — |
| Low (Classic) | 0.56–0.82 ms | +0.05–0.3 ms | ±0 | — |

CPU per frame: the gate, five uniforms, the ice scan once a second, the prints mesh rebuilt at most every 0.25 s, at most 48 breath puffs. Frame times were unchanged within noise. The WebGL2 (GLSL) path was checked in the browser on High: snow, ice and flakes draw with no shader errors.

---

## 12. Files

- **shared:** `winter.ts` (new); `weather.ts` (`snow` / `blizzard`, `WeatherParams.snow`, `winterKind`, `takesIntensity`, `fogScale`); `storm.ts` (winter env, `snow` / `drifts`); `protocol.ts` / `validate.ts` (`WinterSync`, `winter`, `StormStatus.winter`, `fromVec.snow`); `admin.ts` (the `text` setting type).
- **server:** `winter.ts` (new); `weather.ts` (the season mapping); `storm/service.ts`, `storm/tornado.ts`; `gameplay.ts` (`winter`, `daylight`); `gm.ts` (`winter`); `connection.ts` (`worldEnter.world.winter`); `config.ts` (`WINTER_*`); `admin/settings.ts`.
- **world-render:** `winter/{index,plugin,shaders,chunks,snowfall,ice,env}.ts` (new); `world.ts`, `shaders.ts` (the lane), `weather/{frame,adapters,env,index}.ts`, `render/{grade,post,weather}.ts`, `grass/field.ts`, `scatter.ts`, `materials.ts`, `index.ts`.
- **game:** `world/winter/{client,prints,breath}.ts`, `world/features/winter.ts`, `audio/winter.ts` (new); `world/features/{weather,storm}.ts`, `world/features.ts`, `audio/index.ts`, `i18n/en-storm.ts`.
- **admin:** `pages/settings.ts` (text input).
- **Tests:** `packages/shared/test/winter.test.ts`, `apps/server/test/winter.test.ts`, `packages/world-render/test/winter.test.ts`, `apps/game/test/winter.test.ts`, plus updates to the lane, module-order and closed-list tests.
