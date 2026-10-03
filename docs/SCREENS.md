# Intro, login and the character screens (SCREENS)

**Status (wave 10r, built 2026-10-01):** stage B is built (SCR-P, SCR-R, SCR-SEL, SCR-CRE): character select and create on the Jangan palace steps through the world renderer at the player's preset, the server's clock and weather, the sunset hold at night, and the fallback to the old screens when the stage cannot load. The intro, login drift and the other stages stay deferred (BACKLOG).

The user's request (2026-09-28, confirmed for wave 11 on 2026-09-29): the moving picture behind the login form *"isnt
part of this game at all"*; the game needs a **proper intro**; retail has **its own login scene and its own little
map for character select and create**, and those screens should be rebuilt on it **with the wave-9 renderer** (sky,
lighting, PBR) so they look as good as the world. The flow stays the one the user asked for at the start:

**logo / intro → login → server select → character select (3D) → character create → world**, with the English UI
rules (live text only, docs/UI.md).

**Status (stage B only 2026-09-29):** the user chose **stage B, the Jangan palace steps**, and **deferred the intro
flight**. The wave now being planned builds **only character select and create on stage B** (§0B, the authoritative
part for this wave); splash, login and server select stay as they are today. The rest of this document is kept for the
deferred intro/login work and is marked where §0B supersedes it.

This spec covers:

- what the retail client has: an opening movie, the login scene, the character select and create scenes, the music
  (§1);
- what our game shows today and where the "video" comes from (§2);
- the new flow and each screen (§3–§6), the stages and how they are loaded and lit (§4), audio (§7), the UI rules (§8),
  the small protocol addition (§9);
- the prototype: the retail character-select and create spots rendered through the wave-9 renderer (§10);
- presets and budgets in the WAVE_PLAN3 §5.2 format (§11);
- the lanes: file ownership, seams, tests, user checks, dependencies (§12), the scope-cut order (§13), risks (§14);
- **needs from the user (§15) and open questions (§16), each with a default.**

This is a design document. No file under `packages/`, `apps/`, `content/` or `deploy/` was changed. Every script,
prototype, conversion and image is under `work/tmp/screens/` (git-ignored). WAVE_PLAN5 (wave 11) merges this spec
with docs/MOVEMENT.md and docs/PETS_SOCIAL.md; where they meet, WAVE_PLAN5 wins.

**Tags.** **[confirmed]**: checked in code, data or a measurement, and the text says how. **[likely]**: strong
evidence, not proven. **[projected]**: scaled from a measurement. **[unknown]**: open; a default is given.
**[decision]**: a choice this spec makes.

**Repo state when this was written [confirmed: `git log`, `git status`].** HEAD `85e2e14` ("Backlog: user-confirmed
order: wave 10 sky + sea + new 3D trees, wave 11 gameplay and screens"). The wave-9 release workflow has
`apps/game/src/rollout.ts` (`RENDER_ROLLOUT = 'on'`), `settings.ts` and `three/remaster.ts` modified in the working
tree. Line numbers drift; hooks are named by their code.

**Fact-check pass (2026-09-29, same HEAD) [confirmed: `git diff --stat`].** The release workflow is *also* editing
`screens/charselect.ts`, `screens/charcreate.ts` and `three/backdrop.ts` (a new `three/studio-env.ts`
`StudioEnvironment`: a world-render `SkyEnvironment` studio cube for PBR metals on the character screens; `Plaza`
gains `hemi`/`key`) and `settings.ts` (95 lines). Every SCR lane that touches those files starts from the released
version (§12.2). Corrections from this pass are marked *(fact-check)*; the re-measured numbers are in §11.

## 0B. This wave: stage B only (stage B only 2026-09-29)

**The user's decision (2026-09-29, `work/tmp/w9-user-decisions.md`):** character select and create move onto
**stage B, the Jangan "palace steps"** (Chinese only, no Constantinople), and the **intro flight is deferred** with the
new 3D trees, the sky upgrade, pets/friends/mail and the dodge roll. This wave is the user's item 4: *"Character
select and create on the Jangan palace steps."* It runs beside item 1 (instancing and merging), item 2 (the coast),
item 3 (jump) and item 5 (grass and life).

**What this wave builds** [decision]:

- character **select** and character **create** on real Jangan scenery through the wave-9 renderer (sky, day/night,
  PBR materials, shadows, night lights, post), on the player's own preset and path (Low stays Classic);
- the stage runtime they share (`stage/`), a face key light, the stage's time policy, a fast stage load;
- the retail screen-space calligraphy panel on create (§6.2 as written).

**What stays exactly as today** [decision]: the splash (`screens/splash.ts`), the login (`screens/login.ts`) and the
server list (`screens/servers.ts`) with their `titleScene()` backdrop (`three/backdrop.ts` `buildPlaza`); the music
calls on those screens. §3's intro, §5.1–§5.3, the `intro` screen, `ui.intro` settings, the stage A export (§4.2,
SCR-X), the login drift (SCR-L) and the intro lane (SCR-I) are **deferred** (BACKLOG). Everything below §0B that
describes them is kept for that later wave and is marked "(deferred, stage B only 2026-09-29)".

Tags as in the header. Numbers in this section come from the stage-B prototype (§0B.8), `work/tmp/stage/`.

**Adversarial fact-check of §0B (2026-09-29 23:10, HEAD `b6fb115`) [confirmed: `git log`].** Every [confirmed] claim
was re-derived from the code at `b6fb115`, the export's manifest, the prototype's JSONs and a few scratch scripts
(`work/tmp/stage/fc/`). Most hold. The corrections, marked *(fc-B)* in place:

1. **The release is committed** (`b6fb115`, 22:57: `charselect.ts`, `charcreate.ts`, `backdrop.ts`, `settings.ts`,
   `studio-env.ts`, `render/lighting.ts`). The "wait for the release" gate in §0B.10 is met.
2. **The load-time table compared cache states, not radii.** The 11.6 s (400 m) and 6.3 s (150 m) runs were the first
   two loads of the session. Later, warm runs resolved in 3.1 s at 400 m (`load_default2.json`), 3.5 s at 150 m and
   4.4 s at 200 m (`hz_150/200.json`). The 150 m radius is still right: it cuts requests and bytes by ~22 % and stops
   16 unseen regions from streaming behind a menu. It is not a 2× faster load. The budgets are re-based (§0B.4, §0B.9).
3. **The arch will not frame the beach or the sea.** COAST's walkable south beach S1 lies at region z 90.0–90.95. That
   is outside the map's south mountain ridge (z ≈ 91.3, 110–160 m high), about 1.1 km south of the town wall (region z
   96.9), and far outside the 150 m stage stream. The town spawn is 81 m north of the spot, not 28 m (§0B.1).
4. **The stage needs WebGPU pipelines for the create heading before the orbit.** With `viewSteps: 0`, the first orbit
   frames on WebGPU would build the plaza's render pipelines, and the "no frame > 33 ms" budget would fail. The
   warm-up uses `viewSteps: 2`: the select heading and the create heading (§0B.4).
5. **`WorldGraphics.apply()` undoes the create draw-range cap.** It runs on every graphics settings change and calls
   `objects.setRangeScale(preset)`. The host re-applies the cap after it. The watchdog stays off on the stage
   (`frame(ms, false)`), so it never drops (and saves) a preset or resets the 150 m stream to `STREAM_DEFAULTS` from a
   menu (§0B.9, §0B.10).
6. **The sunrise blend is dropped.** `World.setTimeOfDay` snaps, and a 2 s blend from 18:33 to 05:27 would sweep the
   sun either through the whole day or through the whole night. The sunset hold now ends at the next `enter()`
   (§0B.3).
7. **The seams, re-read against the other specs.** Item 5's life is a `World.life` part that comes with `loadWorld`
   (GRASS_LIFE §6). Item 3's movement pack is not loaded on the stages (MOVEMENT §6.1). Item 2's ocean is selected by
   frustum, so both stage views may pay for its draws and FFT. After item 1, the draw-range cap stops removing draws
   (region batches). See §0B.10.
8. **The prefetch uses `cache: 'force-cache'`.** Under production's `no-cache`, a plain prefetch revalidates all 1,250
   files while the player types, and `loadWorld` revalidates them again, so returning players pay twice for nothing
   (§0B.4).

### 0B.1 Where "the palace steps" really are (correction)

- The spot the user picked from `work/tmp/screens/overview.png` (`jangan_plaza_yaw180_golden.jpg`) is glTF
  (101.0, −3.26, −56.0) in `jangan-fields`, region (168, 97) local (1010, 560) [confirmed: manifest region origin
  (0, 0, 0), ground from `world.heightAt` = −3.26]. The draft's words "north of the plaza" were **wrong**: north is −Z
  (manifest `space.axes.north = [0, 0, −1]`). The plaza (`cj_jang_gate.bsr` at 28.5 m, the dragon fountain `cj_wf_dr`
  at 24.8 m) is **north** of the spot, and the camera of that shot looked **south** [confirmed: placements,
  `work/tmp/stage/near.py`]. *(fc-B)* The town spawn (96.9, −136.9) is **81 m** north, not 28 m [confirmed: manifest
  `spawn`].
- The building behind the characters is **Jangan's south town wall and gatehouse**, `jangan_enter/cj_s.bsr` (556 m
  wide, 39 m tall). Its placement origin is 73 m from the spot; *(fc-B)* its north face (z ≈ −0.6, origin z 15.6 minus
  a half depth of 16.1 m) is **≈ 55 m** away. It is reached by the terrain steps up from the plaza level (−3.3 m) to the
  wall terrace (0 m), flanked by two stone statues `c_sta_01` at 29 m [confirmed: manifest bounds and placements].
  There is no palace model in the export; "palace steps" is the user's name for this view and this spec keeps it.
- So the stage looks at the town's south gate from inside. Through the arches the sky shows.
  - *(fc-B)* That stays true after item 2. COAST's walkable south beach S1 (x 166–174 × z 90.0–90.95) lies south of the
    map's south mountain ridge (z ≈ 91.3, 110–160 m high). That is about 1.1 km south of this wall (region z 96.9) and
    far outside the 150 m stage stream [confirmed: COAST.md §1.3 "Jangan south wall", §2.1 S1 mask; the manifest's
    `cj_s` placement].
  - Neither beach nor sea shows through the arch. The earlier "may frame beach and sea" was wrong.

### 0B.2 The two stages (data, `stage/stages.ts`)

Both stages use **one spot and one loaded world**; create only turns the camera around. The table replaces §4.1's
stage-B column for this wave [decision; numbers from the prototype, tuned on the renders in §0B.8]:

| | Select | Create |
|---|---|---|
| World | the selected server's `ServerInfo.world` (deploy default `jangan-fields`, `deploy/config.sh` [confirmed]); `jangan` works too (whole load) | same `World`, no reload |
| Spot | (101.0, z −56.0), y snapped to the nav (−3.26) | same spot |
| Camera look heading | **0 (looking +Z, south)**: the steps and the south gatehouse behind the row | **π (looking −Z, north)**: the plaza, the golden dragon fountain 25 m away, the red gate pillars and the town beyond |
| Characters face | the camera (north); each slot turns to the camera position | the camera (south); the turntable turns the character |
| Vertical fov | 50° (the value is retail `cameradata.txt`'s last field [confirmed]; that it is the fov is [likely], §1.4) | 50° |
| Camera height / target height above the spot's ground | 1.35 m / 1.05 m | full body 0.90 m / 0.75 m; face zoom 1.62 m / 1.50 m |
| Distance | the fit rule below: 3.94 m at 16:9, 16:10 and 21:9; 3.86 m at 4:3 [confirmed: prototype `frameInfo`] | full body 3.6 m; face zoom 1.6 m |
| Lateral truck (camera and target move right together) | 0 | full body 0.45 m (the character sits at 43% of the width), zoom 0.20 m |
| Objects' draw-range scale | the preset's | **0.6** while create is up (the plaza is the busiest view; §0B.9), the preset's again on leave |

**Select slots (all counts)** [decision; checked on renders]:

- Slot i of n (n = 1..4) stands at `spot + right × (i − (n−1)/2) × 1.3 m`, pulled toward the camera by
  `0.2 m × (offset / 1.95 m)²` (a shallow arc: the outer two stand 0.2 m closer and turn in), y snapped to the nav.
  Slot 0 is the leftmost on screen. The order is the server's list order (today's `charList`), unchanged.
- **The camera never moves with n.** Deleting or creating a character re-centres the row, not the camera.
- **The fit rule** (replaces §6.1's rule for this stage): `dist = max(3.0, E / (2 tan(fov/2) (1 − 2b)), (1.5 × 1.3 +
  0.45) / (tan(fov/2) × aspect))` with `E = 2.5 m` (feet −0.15 m to the name tag 2.35 m) and `b` the bar fraction
  (`min(w × 172/1600, 0.16 h) / h`, the `--bar-h` rule in `style.css` [confirmed]). Measured at 1920×1080: feet at
  79–82% of the height (the bottom bar starts at 84%), name-tag anchors at 14.5–16.6% (the top bar ends at 16%)
  [confirmed: prototype `frameInfo`]. Tags therefore clamp below the top bar, the same rule the info window already
  has (`charselect.ts` `topBar()` [confirmed]).
- **Aspects:** 16:10 (1680×1050) and 21:9 (2560×1080) keep 3.94 m; the row spans 16–84% (16:10) and 27–73% (21:9) of
  the width; 4:3 (1600×1200) moves back to 3.86 m and the outer feet sit at 8% and 92% [confirmed: renders
  `aspect_*.jpg`]. Narrower than 4:3 is out of scope (desktop only).
- **Selection:** the selected character steps **0.3 m** toward the camera (the prototype showed 0.5 m pushes the feet
  into the bottom bar at 16:9: 84.7% [confirmed]; 0.3 m keeps them at 82.4% [confirmed]), plays `POSE` once, then
  `STAND3`; the others `STAND1`. The camera does not move. §6.1's "camera eases 0.3 m" is dropped.
- **Idle life:** the fixed camera drifts ±0.10 m sideways on a 24 s sine (≤ 0.2 ms CPU, no reload) [decision; scope
  cut 4].
- **Picking:** today's invisible pick cylinders per slot, placed at the slot (not at `SLOT_X`).
  - *(fc-B)* The stage scene sets `scene.skipPointerMovePicking = true`, as `screens/world.ts` does [confirmed].
  - Without it, Babylon runs its pointer-move pick over the whole world's mesh list on every mouse move. The per-mesh
    predicate filters most of them cheaply (`pointerMovePredicate` requires `enablePointerMoveEvents`, Babylon 9.28
    `scene.inputManager.js` [confirmed]), but the walk is wasted work.
  - The slot pick keeps its own `metadata.slot` predicate (`charselect.ts` [confirmed]).
- **Camera object** *(fc-B)*: an `ArcRotateCamera` targeted on the spot (the `Stage.camera` type of §4.3).
  - Select sits at `alpha0`. Create is `alpha0 + π` with its own radius, height and lateral target offset.
  - So the orbit is an `alpha` tween, and `GraphicsWarmup`'s `views` step can visit both headings (§0B.4).
  - The prototype's `TargetCamera` gave the same framing.

**Create** [decision; checked on renders]:

- One character on the spot; the retail rotate window turns **the character** (turntable, as today) and the zoom
  button blends the camera between the full-body and face keys in 0.5 s.
- The layout it is framed for: the customize window centred at 20% of the width, the explain window at 80%/62%, the
  rotate window at 50%/80% (`charcreate.ts` `anchor()` calls [confirmed]), and the retail calligraphy panel
  (`outer/back_image`, 408×556 art) at the 1600×1200 rect's left edge (60.6%) and height (72%), aspect kept (§6.2).
  At 1920×1080 the character stands at x ≈ 43% with the feet at 73.6% of the height, above the rotate window
  (its top at ≈ 77%) and clear of the panel [confirmed: `ui_final_create_1500.jpg`; `final_create_1500.json`
  `frameInfo` feet (0.425, 0.736)].
- The dragon's head sits under the top red bar in the full-body key; its body, the waterfall and the pillars show. The
  face key shows the dragon behind the head [confirmed: renders]. SCR-R may tune the heading ±10° (open question 3).

**Select ↔ create:** the camera **orbits 180° around the spot in 1.0 s** (ease in-out) with the select row hidden at
the start and the create character shown when it is dressed; back reverses it. No reload, no loading picture
[decision; scope cut 1 = a 0.3 s dip to black instead]. The row's actors are disposed on create (ModelLibrary keeps
the glbs [confirmed: its per-scene cache]), so back to select rebuilds them from the cache.

### 0B.3 Lighting and time

- **Renderer:** the stage is a `World` loaded like the world screen's, with the same graphics link
  (`world/graphics.ts` `WorldGraphics`: rollout gate, render/sky blocks, tone map, character-material decoration with
  6 lights on PBR, the Classic path's character lights) [confirmed: the prototype runs `WorldGraphics` and the
  game's `ModelLibrary` unchanged]. Night lights (`attachNightLights`) and cast shadows (`render.addCharacter`) as in
  the world.
  - *(fc-B)* `WorldGraphics` takes the characters' `hemi` and `sun` lights, so the host makes them as
    `buildWorldScene` does; on PBR `syncPath` disables them [confirmed: `graphics.ts`].
  - It is called with `frame(ms, false)`: the watchdog never judges on the stage [decision]. A trip there would call
    `store.set({ graphics: { preset } })`, a saved preset change made from a menu. `apply()` would then reset the
    stage's 150 m stream to `STREAM_DEFAULTS` [confirmed: `graphics.ts` `slow()`, `apply()`]. The prototype already
    passed `false`.
- **The release's character-screen environment (`three/studio-env.ts`)** is **not used on the stage**: on PBR the
  world's lighting sets `scene.environmentTexture` to the sky cube (`render/lighting.ts` [confirmed]), so a studio
  cube would fight it. `StudioEnvironment` stays with the **fallback** screens (§0B.4), which are today's release
  screens; nothing deletes it this wave.
- **Time (default kept):** the **server's live clock and weather**, read from `app.session.server.clock/weather`
  (§9, SCR-P). The stage runs the clock like the world (`World.setClock`), so the sky there is the sky the player walks
  into. **At night it holds at sunset**: when the live solar time is outside [sunrise, sunset] for the clock's
  declination (`sunriseSunset`, `shared/world-clock.ts` [confirmed]), the stage shows `t = sunset` (0.773 = 18:33 at
  the default declination +12°) [confirmed: `sunriseSunset(12).set` = 0.7732, `work/tmp/stage/fc/sun.ts`].
  - *(fc-B)* **At sunrise the hold does not blend.** `World.setTimeOfDay` and `setClock` both snap [confirmed:
    `world.ts`]. A 2 s tween of `t` from 0.773 to 0.227 runs the sun either back through the whole day or on through
    the whole night.
  - Instead the hold lasts until the next `enter()` (select ↔ create, or a new visit); from then the live clock runs.
    On a screen already up at sunrise, the sunset frame simply stays.
  - At the defaults the hold is what a player sees **34 %** of the time (41 of every 120 real minutes: the night warp
    k 0.4 shortens the night). At −23.44° it is 47 %, at +23.44° 30 % [confirmed: `fc/night.ts`].
  - Reason to adjust the old "dusk 0.78": a fixed 0.78 is before sunset in summer and deep dusk in winter, and the
    sunset frame is the best look on this stage (warm light on the wall and the row, `final_select_sunset.jpg`), while
    18:55 already reads as night (`sel_med_t0788.jpg`) [confirmed: renders]. *(fc-B)* The season is a server config
    (`DAY_SEASON_DEG`, default +12°, not cycling) [confirmed: `apps/server/src/world-clock.ts`]. At the winter
    extreme (−23.44°) the sunset sun stands 29° south of west, partly in front of the select camera, so the row is side- and backlit
    again. At +12° it is 14° north of west [confirmed: `sunDirection`, `fc/az.ts`]. The renders are at +12° only.
- **What each time looks like on the select stage** [confirmed: `work/tmp/stage/shots/times.jpg`]: 09:00–15:00 bright,
  the row backlit (the midday sun is south, behind the wall, `sunDirection` "at noon the sun stands in the south"
  [confirmed: `world-clock.ts`]); **17:00 the spot is in the shade of the buildings west of it** (the sun is 19° high
  in the west) and the gatehouse face is dark; sunset warm; after sunset blue. Good enough at every time with the key
  light; the clamp removes the night.
- **Face key light** (§4.4, kept): one `DirectionalLight` with `includedOnlyMeshes` = the stage actors, from the
  camera side 30° up and 25° to the right, **intensity 0.5** on PBR, created in `enter()` before the actors compile
  and never removed (0 when unused). Without it the faces go dark from 17:00 on (`sel_med_t0788_nokey.jpg` vs
  `sel_med_t0788.jpg`) [confirmed]. Classic (Low) gets none: its hemi light lights the actors (as in the world).
- **Weather:** the server's weather at half intensity, never lightning (§4.4, kept). Rain wets the paving; the rain
  shelter and ripple costs are the world's (§0B.9 adds them).
- **Life (item 5)** *(fc-B)*: GRASS_LIFE decided that the life is a world-render part, `World.life` (lane GL-0).
  - It is updated inside `World.update` after the scatter and follows the world's focus [confirmed: GRASS_LIFE.md §5.1
    and its "Character screens" seam].
  - So the stage gets it with `loadWorld`, and `world.update(camera, spot)` already sets the focus to the spot
    [confirmed: `world.ts` `update`].
  - GRASS_LIFE wants "no ground flocks" on the stage. No GL-0 API for that is specified yet [unknown]. The default is
    to take `World.life` as it is; SCR-R turns ground flocks off only if GL-0 exposes a switch.
- **Metals** *(fc-B)*: on the stage, weapons and armour reflect the world's sky cube, which is read as **sRGB**
  (`WORLD_SKY_CUBE_DECODE = 'srgb'`, `render/lighting.ts` [confirmed]).
  - That is the same darkening that made the release add a *linear* studio cube to today's screens (`studio-env.ts`:
    the Copper Blade "near black" [confirmed]).
  - So a blade on the stage looks as it does in the world at the same hour. At the sunset hold it is darker than on
    today's release screens.
  - The prototype's sunset renders show grey, not black, blades [likely: judged by eye, not measured].
  - Levers, in order: the key light's specular (0.3 → 0.6); then the wave-10 BACKLOG "move the world cube to linear"
    look pass. Never a second cube on the stage.

### 0B.4 How the stage loads fast (only the regions it needs)

Measured on the dev PC from `/out-opt/` (the slimmed tree the game uses; glb/json/bin served brotli by the game's
Vite config, sizes are `encodedBodySize`, i.e. wire bytes) [confirmed: prototype `load` records; localhost, the HTTP
cache warm after the first run, so times are parse + upload + revalidation, not download]:

| Stream load radius | Regions | Models | World bytes on the wire | `loadWorld` resolved | Looks |
|---|---|---|---|---|---|
| the world's Medium default (400 m, ready 200 m) | 23 wanted (21 ready at resolve) | 219+ | 30.0 MB (1,541 files) and still streaming | 11.6 s (1st run); **3.1 s** warm (`load_default2`) | same; the stage keeps downloading regions nobody sees |
| **150 m (default)** | **7** | 177 | **23.5 MB (1,210 files)** | 6.3 s (2nd run); **3.5 s** warm (`hz_150`) | the select view identical to 400 m after settle |
| 200 m | 9 | 212 | 26.9 MB (1,458 files) | **4.4 s** warm (`hz_200`) | create's horizon as 150 m at Medium |
| 100 m | 3 | 104 | 14.7 MB (687 files) | 1.6 s | select identical [confirmed: `cmp_load.jpg` after settle]; create's north view would lose region (168, 98), 136 m away, beyond the plaza [likely: not rendered] |

*(fc-B)* **The times in this table are not a radius comparison** [confirmed: the JSONs' `tWorldMs` and file times].

- The runs were made in this order: 400 m 11.6 s (21:36:30), 150 m 6.3 s (21:36:47), 100 m 1.6 s (21:36:58), 400 m
  again 3.1 s (21:38:12), 150 m 3.5 s and 200 m 4.4 s (22:47–22:48). The first loads of the session paid the cold
  cache and Vite's module transforms.
- Warm, the 400 m load resolved *faster* than the 150 m one. `loadWorld` waits only for the regions within the ready
  radius, min(200, load), and the ready sets differ by two regions. The 400 m run was select mode and the 150 m run
  create mode [confirmed: `world.ts` `loadWorld`, the JSONs].
- What 150 m does buy [confirmed bytes and counts; likely for the rest]:
  - 21 % fewer requests (1,210 vs 1,541: the revalidations production pays, below) and 22 % fewer bytes;
  - no background streaming of 16 unseen regions behind the menu. Those regions would use the streamer's commit jobs
    (`frameBudgetMs` 4 on Medium, 5 on High [confirmed: `STREAM_DEFAULTS`]) and GPU uploads during select.

- **Default [decision]:** `streamSettings: { loadRadiusM: 150, unloadRadiusM: 230, maxFetches: 12 }`,
  `readyRadiusM: 150`, `waitForObjects: true`, `minimap: false`. Seven regions: (167..169, 96..97) and (168, 98).
  `maxFetches` 12 (the world's Medium is 6 [confirmed: `STREAM_DEFAULTS`]) because nothing else competes on a loading
  screen and production revalidates every file (below). Create's north view at 150 m and at 200 m (9 regions,
  26.9 MB) renders the same at Medium (1.8% of pixels differ, swaying trees and clouds;
  `work/tmp/stage/shots/cmp_horizon.jpg`) [confirmed]; High (draw range 1.4, capped to 0.6 on create, §0B.9) was not
  captured (§0B.9), so SCR-R repeats the check on High and raises the radius to 200 m only if a hole shows (open
  question 4).
- **In parallel, not after:** the `charList` request, the character models (their glbs and packs: 7.5 MB for four
  dressed characters [confirmed: prototype `chars`]) and the world stream start together; the prototype ran them in
  series (world 6.3 s, then characters 1.5 s; warm: 3.5 s, then 0.3 s for one character).
- **Shader warm-up:** `GraphicsWarmup` once the stage is in; the compiled Effects stay in the engine for the world
  screen (the W9F LEAK-2 note in §4.3 applies).
  - *(fc-B)* It runs with **`viewSteps: 2`**, not 0. The `shaders` step compiles every enabled mesh wherever it is.
    But on WebGPU a render pipeline is made at a mesh's **first draw** (`warmup.ts` header, step 3 [confirmed]).
  - With 0 views, the plaza's pipelines would be built during the first select → create orbit: exactly the frames the
    "orbit: no frame > 33 ms" budget covers.
  - With the `ArcRotateCamera` of §0B.2, `viewSteps: 2` turns `alpha` by π: the select heading, then the create
    heading, a few frames each, behind the loading picture [confirmed: `warmup.ts` `camera.alpha = alpha0 + view·2π /
    viewSteps`].
  - The regions it waits for are clamped to the stage's load radius (`RegionStreamer.progress` takes
    `min(radiusM, loadRadiusM)` [confirmed]), so the fixed `NEAR_RADIUS_M` 200 does not hang it at 150 m.
- **Prefetch while the player types the password [decision]:** when the login screen opens, `stage/prefetch.ts`
  fetches the default export's `manifest.json` and then the files of the seven stage regions (terrain, tiles, the
  placed models' glb/sidecars), at most 4 at a time, stopping on logout or when the select screen starts its own load.
  - *(fc-B)* The call is `fetch(url, { priority: 'low', cache: 'force-cache' })`. Production serves these files
    `no-cache` (below), so a plain `fetch` revalidates every file now, and `loadWorld` revalidates it again a minute
    later. A returning player would pay ~1,250 extra round trips for nothing.
  - `force-cache` takes any cached copy without asking the server (the Fetch standard's cache mode), so the prefetch
    touches the network only for files the browser does not have: the first visit, or files evicted since.
    `loadWorld`'s own `no-cache` revalidation then still picks up a changed file.
  - It downloads only what the stage will load anyway. The server's export is known only after the server list, so
    the prefetch uses the list's `world` (unvalidated, used only for fetching, §9) and falls back to `jangan-fields`.
    Scope cut 3.
- **Production caching (finding):** `/out-opt/` files are served `Cache-Control: no-cache` with an ETag
  (`apps/server/src/static.ts` default for unhashed names [confirmed]), so a returning player still pays one
  revalidation round trip per file: ~1,250 requests for the stage (1,210 world + 40 character files [confirmed:
  prototype counts]). At `maxFetches` 12 and a 30–60 ms Tailscale round trip that is ≈ 3–6 s [projected]. The world
  screen pays the same.
  - *(fc-B)* That assumes HTTP/2 from the browser to `tailscale serve`. Behind it, the Node server is plain `node:http`
    (`game.ts` `createServer` [confirmed]), and `tailscale serve` terminates TLS in Go, whose server negotiates h2 by
    default [likely].
  - On HTTP/1.1 the browser allows 6 connections per host, whatever `maxFetches` says, so the figure doubles to
    ≈ 6–12 s. H-SCR reads the protocol column of the network panel on the mini PC once. Changing the cache policy is **not** in this wave (item 1's perf lane or DEPLOY own it; open
  question 5).
- **First visit over the mini PC:** 23.5 + 7.5 ≈ 31 MB for the stage [confirmed bytes, the Vite dev server's brotli;
  production sends the same precompressed `.br` siblings, 1,758 of them in `out-opt/world/jangan-fields`
  (`static.ts` [confirmed])]; the download time is [unknown] until the mini PC's upload rate is measured (WAVE_PLAN3
  §8 item 11).
  - *(fc-B)* A first visit also compiles the world's shaders here now, on select instead of world entry. Up to the
    warm-up's 20 s cap (`WARMUP_DEFAULTS.maxMs` [confirmed]) moves from the world's loading screen to the select
    screen's. The world screen reuses these bytes
  from the HTTP cache when the character stands in town.
- **Loading picture:** the existing `LoadingOverlay` (`LOADING_PICTURES.characters`) covers the stage load, with one
  progress bar over world + characters, as today. **Timeout 30 s** (the world's `READY_TIMEOUT_MS` [confirmed]): after
  it the stage shows with whatever is in.
- **Fallback [decision]:** if the export cannot be found or `loadWorld` throws, select and create run **today's
  release screens** (the `buildPlaza` scene with `StudioEnvironment`), with a console warning. The player can always
  reach the world.
- **Hand-over to the world:** as §4.6, the stage `World` is disposed before the world screen builds its own; the gain
  is the HTTP cache and the compiled shaders. Sharing the `World` stays a later perf item.

### 0B.5 Music and sound

- **Music:** `maintheme_cut` (retail's only title theme, 120.2 s [confirmed §1.5]) keeps playing from the splash
  through login, servers, select and create without a restart: `app.music.play()` of the playing URL is a no-op
  [confirmed: `audio/music.ts`], and select and create already call it [confirmed: `charselect.ts:45`,
  `charcreate.ts:480`]. The world switches to `jangan_town`/`jangan_field` on entry, as today.
- **Ambience [decision]:** `app.audio.setArea('JANGAN_TOWN')` on the stage (town ambience under the theme at the
  player's ambience volume), `setArea(null)` when the stage is released; the world's sound feature sets its own area
  on entry [confirmed: `world/features/sound.ts`]. Scope cut 2.
- UI sounds unchanged.

### 0B.6 Login, server select and the intro

- Unchanged this wave [decision]: splash → login → server list keep `titleScene()`, today's placeholder plaza, and
  their music. The intro flight (§5.1) is deferred with its settings, strings and lane. `three/backdrop.ts`
  `buildPlaza`/`newScene` therefore stay, and so do `selectionRing` and `artPlane` while the fallback (today's
  screens, §0B.4) uses them; I-SCR deletes whatever nothing imports any more.

### 0B.7 UI

- Unchanged retail layouts and live English text (§6, §8). No new strings: the loading text reuses `select.loading`
  [confirmed key].
- Create's calligraphy moves from the 3D `artPlane` to the retail screen rect (§6.2), `.create-backimage` in
  `style.css`.

### 0B.8 Prototype (stage B)

`work/tmp/stage/proto/` (`index.html`, `main.ts`, `vite.config.ts`): a private Vite server on :5188 that reuses the
**game's** Vite config (its `/out/` and `/out-opt/` routes with brotli) and loads the game's own modules:
`loadWorld` streamed from `/out-opt/world/jangan-fields/` around the spot, `WorldGraphics`, `ModelLibrary` with
`starterEquipment` outfits and weapons from `loadCatalog()`, `attachNightLights`, and the face key light. It was
started from `apps/game`, used in one browser tab and stopped; the shared dev servers were not touched.
`work/tmp/stage/overlay.py` composites the retail outer art (bars, windows, calligraphy panel) over the renders as the
screens lay them out (`--bar-h`, `autoScale`, the `anchor()` fractions); live text is drawn as empty boxes.
All images are Medium, WebGPU, 1920×1080; the create images use Medium's own draw range (1.0), before the 0.6 cap
of §0B.9 (its look is `cmp_range.jpg`). The screenshots (not the benches) were rendered between 21:34 and 21:48, while
another agent held the GPU lock for its timings; the benches in §0B.9 ran under this spec's own lock.

Images (`work/tmp/stage/`):

| File | What it shows |
|---|---|
| `overview.jpg` | the chosen framings with the retail UI: select at 15:00 and at sunset, create at 15:00, at sunset and zoomed |
| `shots/ui_final_select_1500.jpg`, `ui_final_select_sunset.jpg` | select, four dressed characters, the second slot (i = 1) selected (stepped 0.3 m, info window above it), 16:9 |
| `shots/ui_final_create_1500.jpg`, `ui_final_create_sunset.jpg`, `ui_final_create_zoom.jpg` | create looking north at the dragon fountain, full body and face |
| `shots/times.jpg` | the select stage at 09:00, 12:00, 15:00, 17:00, 18:55 with and without the key light |
| `shots/create_heads.jpg` | the four create headings tried (south, east, west, north) |
| `shots/ui_aspect_16x10.jpg`, `ui_aspect_21x9.jpg`, `ui_aspect_4x3.jpg` | the select fit rule at other aspects (rendered with the earlier 0.5 m step; the feet of the selected slot touch the bottom bar there, which is why the step became 0.3 m) |
| `shots/cmp_horizon.jpg`, `shots/cmp_range.jpg` | create at a 150 m vs 200 m stream radius; create at draw range 1.0 vs 0.6 |
| `shots/cmp_load2.jpg` | the 400 m load before and after settle vs 150 m (the shade at 17:00 arrives with the western buildings) |

### 0B.9 Presets and budgets (1080p; WAVE_PLAN3 §5.2 format)

**Measured** on the dev PC (Ryzen 5 9600X + RX 9060 XT, Chrome's built-in pane, hidden, the viewport emulated at
1920×1080 and read back), GPU lock held (`work/tools/gpu.lock`, 22:46–22:57), the prototype's game path
(`WorldGraphics`, the default active-mesh filter on), 15:00, weather `off`, the 150 m stage load; select with 4
dressed characters (the second slot, i = 1, selected), create with 1. **CPU** = wall time of `scene.render()` p50 / p95 over 400
frames after an 8 s settle; each cell is the **better of 2 runs** (the spec's lanes use the min of 5). Frame times are
not reported (the hidden pane clamps the pump, §11). JSONs: `work/tmp/stage/shots/b_*.json`, `r_*.json`.

| Preset | Stage | API | CPU p50 / p95 (ms) [confirmed] | Draws [confirmed] | GPU dev [projected] | Mid laptop / Mac CPU ×1.5–2 [projected] |
|---|---|---|---|---|---|---|
| Low (Classic) | select | WebGL2 | 1.1 / 1.5 | 77 | ≈ 0.5 ms (world Low) | 2.3–3 ms |
| Medium | select | WebGL2 | 3.1 / 4.0 | 190 | ≈ 1.5 ms (world Medium) | 6–8 ms |
| Medium | select | WebGPU | 3.7 / 4.6 | 190 | ≈ 1.5 ms | 7–9 ms |
| High | select | WebGL2 | 4.4 / 5.3 | 329 | ≈ 2.3–4.3 ms (world High, SSR off) | 8–11 ms |
| High | select | WebGPU | 5.6 / 6.7 | 329 | ≈ 2.3–4.3 ms | 10–13 ms |
| Medium | create, draw range 1.0 (the preset's) | WebGL2 | 5.9 / 7.2 | 320 | ≈ 1.5 ms | 11–14 ms |
| Medium | create, draw range 1.0 | WebGPU | 6.9 / 7.9 | 320 | ≈ 1.5 ms | 12–16 ms |
| **Medium** | **create, draw range 0.6 (default)** | WebGPU | **3.8 / 5.0** | **174** | ≈ 1.3 ms | 8–10 ms |
| High | create, draw range 1.4 (the preset's) | WebGL2 | 8.3 / 10.0 | 521 | ≈ 2.5–4.5 ms | 15–20 ms: misses 60 fps |
| High | create, draw range 1.4 | WebGPU | 11.0 / 13.7 | 521 | ≈ 2.5–4.5 ms | 20–27 ms: misses 60 fps |
| High | create, draw range 1.0 | WebGPU | 9.4 / 13.3 | 437 | ≈ 2.5–4.5 ms | 18–27 ms |
| **High** | **create, draw range 0.6 (default)** | WebGPU | **5.1 / 6.5** (other run 7.1 / 9.4) | **286** | ≈ 2.3–4 ms | 10–13 ms (19 ms on the bad run) |

Add for the server's rain at half intensity: **+0.5–1.2 ms GPU on a mid GPU at Medium** (WAVE_PLAN3 §5.2 weather
column) [projected]; the sky is already in the numbers.

*(fc-B)* **Re-derived and missing cells** [confirmed: every CPU and draw cell above equals its JSON's `cpuP50`,
`cpuP95` and `draws`; the fit and framing numbers equal the JSONs' `frameInfo`]:

- **Not measured:**
  - create at 0.6 on **WebGL2** (either preset), and on Medium only one run;
  - Low on WebGPU;
  - **Ultra** on any stage (4 cascades, props casting, SSR `always` [confirmed: `render/quality.ts`]).
  - Expected values [projected from the per-draw ratio above]: WebGL2 at 0.6 ≈ 0.8× the WebGPU cell (Medium ≈ 4.0 ms
    p95, High ≈ 5.3 ms). Ultra create at 0.6 is ≥ High's plus SSR's ~2 ms GPU (the wave-9 cut-4 figure).
  - SCR-R measures all of these in its min-of-5 runs. Ultra is opt-in and gets no budget of its own; the stage runs it
    as the player chose.
- **The JSONs do not record the time of day.** "15:00" is the author's statement [unknown: not in the files].
- **The sunset hold** (34 % of the time, §0B.3) was not benched:
  - Night-light ramp there: `smoothstep(+2°, −6°, 0°)` = 0.16.
  - So Medium's 8 and High's 32 clustered lights get a real range, and their tile pass is not empty as it is by day
    [confirmed: `night-lights.ts` header].
  - The light count and defines do not change, so CPU should not move [likely]. GPU grows by about the world's night share:
    wave-9 Medium WebGPU "fields night" measured 1.67 ms GPU against 1.54 ms for "gate storm" [projected from
    `w9-finish/budgets.md`: different scenes, so only an order of magnitude].
  - SCR-R benches select and create at the hold as well as at 15:00.
- **What this wave's other items add to the stage**, re-measured after each lands:
  - item 5's grass and life: ≤ 3 + 3 draws, 0.05–0.1 ms CPU [confirmed as GRASS_LIFE's lab figure];
  - item 2's ocean: its CDLOD selects sea nodes by **frustum**, not occlusion. The south sea beyond the ridge
    (select) and Jangan Bay (create, ≈ 1 km north) are inside the 2,000 m far plane, so the ocean is drawn behind the
    walls and its FFT runs: 1 ms per tick in a worker on Medium, compute on High [projected: COAST.md §8.2, F10];
  - item 1 lowers everything (below).

What the table means, honestly:

- **Select fits 60 fps everywhere** on the dev PC with room (worst p95 6.7 ms, High WebGPU) and on a mid laptop at
  ≤ 13 ms [projected]. It is cheaper than the old stage-B numbers (§11: 8.3–11.8 ms p95 with the filter off, bodies
  only): the filter is on and the camera no longer sees the plaza.
- **Create looks at the plaza, the town's busiest view** (the dragon fountain, the pillars, the shops and trees beyond).
  At the preset's own draw range, High costs 521 draws and 10–14 ms p95 on the dev PC, which misses 60 fps on a laptop
  [projected]. **Decision: create sets the objects' draw-range scale to 0.6** (`world.objects.setRangeScale`, the
  lever `WorldGraphics.apply` already uses [confirmed]) while the create camera is active, and restores the preset's on
  back/leave. It drops to 174 draws (Medium) / 286 (High) and 5.0 / 6.5 ms p95; what goes is the far layer behind the
  plaza (a few trees and roofs past ~100 m; `work/tmp/stage/shots/cmp_range.jpg`) [confirmed: renders]. Item 1's
  merging is expected to lower both further [projected].
  - *(fc-B)* **The cap does not survive `WorldGraphics.apply()`**, which runs on every change to `settings.graphics`
    (its `store.onChange`) and sets `objects.setRangeScale(q.drawDistance)` [confirmed: `graphics.ts`]. So the host
    subscribes to the same store *after* constructing `WorldGraphics` and re-applies `min(preset, 0.6)` while create
    is up. `stage-host.test.ts` changes a graphics setting on create and asserts the cap. No edit to `graphics.ts`.
  - *(fc-B)* **After item 1 the cap stops removing draws.** BATCHING §3.8 shows a *region's* merged mesh while
    `distance − radius < 202 m × rangeScale`. At 0.6 (121 m), from the create camera, all seven stage regions stay in
    range, except perhaps (168, 98) (centre 236 m away, radius up to ~136 m) [projected from the region geometry].
  - After item 1 the cap is therefore either a no-op or drops that whole region at once. Its only other effect is on
    the skinned clones' 80 m × scale animation pause. SCR-R re-benches create after item 1 at the preset's own range
    and drops the cap unless High's p95 is over 8 ms (open question 9).
- **WebGPU costs ≈ 1.2× WebGL2 per draw here** (select High 6.7 vs 5.3 ms p95 at the same 329 draws) [confirmed],
  in line with the wave-9 gate (§11).
- **Load** (§0B.4): 7 regions, 23.5 MB world + 2.6–7.5 MB characters on the wire; `loadWorld` 3.5 s warm on
  localhost (6.3 s on the session's second load) [confirmed, *(fc-B)*: the earlier "1.6–6.3 s" mixed a 100 m run and a
  cold run]; the first visit over the mini PC is [unknown].
- **High's capture is black** in the prototype (the WebGPU `toDataURL` after `scene.render()` in the same task returns
  an empty image at High; Medium captures fine; the pane itself shows the frame [confirmed: pane screenshot]). A
  prototype artefact, not the game; so every image in the overview is Medium.

**Per-lane budgets** (dev PC, 1920×1080 set explicitly, the default filter on, the GPU lock, the min of 5 runs, **both
APIs**):

| Lane | Budget |
|---|---|
| SCR-R | select (4 equipped characters) and create (1), at 15:00 **and at the sunset hold**: CPU p95 **≤ 5.5 ms at Medium** and **≤ 8 ms at High**, weather off; + ≤ 0.5 ms with half rain; the create range cap applied, re-applied after a graphics settings change, and restored (a test); *(fc-B)* `loadWorld` of the stage ≤ 4.5 s warm on localhost (measured 3.5 s), the stage (world + characters + warm-up with 2 views) visible ≤ 6 s warm; re-based after items 1 and 5 land (their region jobs run inside the load) |
| SCR-SEL / SCR-CRE | swapping a slot's character or outfit: ≤ 1 frame > 33 ms; the orbit: no frame > 33 ms, including the first, on both APIs (the warm-up's 2 views built the create heading's pipelines, §0B.4); create turntable at 60 fps |
| Whole | the character screens hold 60 fps p95 at the machine's first-run preset (Medium); world → select → create → world three times: on WebGL2 the JS heap grows ≤ 10 MB and the GPU texture count returns to baseline; on WebGPU one retained stage `World` is allowed (§4.3, LEAK-2) |

### 0B.10 Lanes (this wave)

Lane ids keep the `SCR-` prefix; the wave plan may renumber them. **Dropped from this wave:** SCR-X (stage A
export), SCR-I (intro), SCR-L (login backdrop), SCR-E (the viewer stage editor) (deferred, stage B only 2026-09-29).

| Id | Step | What | Owns (new files unless marked "edit") |
|---|---|---|---|
| SCR-P | 0 | `ServerInfo.clock/weather` (§9 unchanged) | edit `packages/shared/src/protocol.ts` (`ServerInfo` only), edit `packages/shared/src/validate.ts` (its `serverInfo()`: `optionalField` + `clockState`/`weatherSync`), edit `apps/server/src/game.ts` `serverInfo()`; tests `packages/shared/test/server-info.test.ts`, `apps/server/test/servers-clock.test.ts` |
| SCR-S | 0 | client seam | edit `apps/game/src/app.ts` (one field: `stage: StageHost`, built lazily), new `apps/game/src/stage/types.ts` (`StageDef`, `StageHost`, `Stage`: §4.1/§4.3 minus the intro/login members; `camera.kind` is `'fixed'` only), a stub `stage/host.ts`; test `apps/game/test/seams-stage.test.ts` |
| SCR-R | 1 | stage runtime | `apps/game/src/stage/{host.ts, stages.ts, slots.ts, key-light.ts, stage-time.ts, prefetch.ts}`; tests `stage-host.test.ts`, `stages.test.ts`, `stage-time.test.ts`, `stage-prefetch.test.ts` |
| SCR-SEL | 2 | select on the stage | edit `apps/game/src/screens/charselect.ts` (the stage path; the fallback keeps today's `buildPlaza` + `StudioEnvironment` path); edit `screens/login.ts`, **one line** (start `prefetchStage()`; scope cut 3 removes it) |
| SCR-CRE | 2 | create on the stage | edit `apps/game/src/screens/charcreate.ts` (stage, turntable, zoom keys, the orbit from select; the fallback keeps today's scene), `.create-backimage` in `apps/game/src/style.css` |
| I-SCR | 3 | integration | delete `selectionRing`/`artPlane` from `three/backdrop.ts` if nothing imports them any more; `apps/game/README.md` (the backdrop section: select/create are on the stage, login still on the placeholder); docs (PLAYTEST.md user checks, BACKLOG item 8: select/create done, intro/login open; this file's statuses) |
| H-SCR | 3 | adversarial hunt | tests only (§12.7 lenses 1–7, without the intro items) |

**Seams and contracts:**

- Screens never call `loadWorld` or make a `Scene`; only `app.stage.enter(STAGES.select | STAGES.create)`. The host
  alone derives path and preset (`effectiveGraphics`, through `WorldGraphics`), and runs `deviceHintOf` +
  `runFirstRun` before its first `enter` (§4.3 fact-check; select is now the first 3D world a new player sees).
- `enter(STAGES.create)` after select on the same export returns the same `World`; only the camera orbits.
- **Item 1 (instancing and merging)** changes how the world draws; the stage only calls `loadWorld`, so it gets the
  savings with no change here [confirmed: BATCHING.md §3.14 says the same]. The stage budgets are re-measured after
  item 1 lands.
  - *(fc-B)* After item 1 the create cap no longer removes draws (§0B.9), and the region batch's worker merge runs
    inside `loadWorld`'s objects wait. The load budget is re-based then.
- **Item 2 (coast)** re-exports `jangan-fields`. `stages.test.ts` re-checks the spot, the slots and both cameras on
  the new export.
  - *(fc-B)* Nothing at the spot moves. The coast's only in-bounds height edit is S1 (x 166–174 × z 90.0–90.95),
    about 6 regions (≈ 1.2 km) south of the spot, and the ring lies outside the bounds [confirmed: COAST.md §2.1,
    §3.3 S1].
  - The arch does not show the new beach (§0B.1).
  - The ocean is drawn behind the walls in both views (§0B.9). If it costs more than 0.3 ms on the stage, SCR-R hides it
    there. The lever is COAST's own visibility switch, if its lanes expose one; otherwise, on the stage only,
    `world.water.setVisible(false)` for the whole ocean. The dragon fountain's water is a model, so it is not
    affected [likely: `cj_wf_dr.cpd` is a placed object].
- **Item 5 (grass and life)** *(fc-B)*:
  - The new grass draws wherever the world's scatter draws. The beds 16–40 m east and west of the spot are placed
    `group_grs01`/`flw_g01_*` models [confirmed: `near.py`]. Whether the terrain under them is grassy enough for the
    new field is [unknown]; nothing to do either way.
  - The animals are `World.life`, a world-render part that comes with `loadWorld` and follows `world.update(…, spot)`
    [confirmed: GRASS_LIFE.md §5.1 and its "Character screens" seam]. The stage calls nothing.
  - GRASS_LIFE's "no ground flocks on the stage" needs a GL-0 switch that its lane table does not list yet
    [unknown] (open question 6).
- **Item 3 (jump)** *(fc-B)*: no jump on the stages, and **no movement-pack fetch** either. MOVEMENT §6.1 (fact-check
  2) loads the pack only from the world screen after `worldEnter`, not awaited. The earlier "the stage fetches it too"
  is withdrawn [confirmed: MOVEMENT.md §6.1, its correction 36].
- **The wave-9 release is committed** *(fc-B)*: `b6fb115` (22:57) holds `charselect.ts`, `charcreate.ts`,
  `backdrop.ts`, `settings.ts`, `studio-env.ts` and `render/lighting.ts` [confirmed: `git show --stat HEAD`; the
  working tree is clean outside `docs/`].
  - SCR-S, SCR-SEL, SCR-CRE and I-SCR start from `b6fb115` (or whatever the wave plan pins) and re-read those files.
- **`WorldGraphics` is a page-global in one respect** *(fc-B)*. Its constructor calls `setRenderScaleHandler(...)` and
  its `dispose()` calls `setRenderScaleHandler(null)` unconditionally [confirmed: `graphics.ts`].
  - So the stage's `WorldGraphics` must be disposed **before** the world screen constructs its own. Otherwise the
    world's FSR hand-off is nulled and the resolution scale falls back to canvas scaling.
  - Likewise the world's before the stage's (logout to select). `App.useScene` releases the old scene before
    building the new one [confirmed: `app.ts`], so this holds as long as the host builds through `useScene` (§4.5).
    `stage-host.test.ts` checks the order.
- **`GameAudio.setArea`** is also page-global: the stage's `setArea(null)` on release must run before the world's
  sound feature sets its area, the same order as above [confirmed: `audio/index.ts`, `world/features/sound.ts`].

**Order:** step 0: SCR-P and SCR-S in parallel; step 1: SCR-R (after SCR-S); step 2: SCR-SEL and SCR-CRE in parallel
(after SCR-R; disjoint files); step 3: I-SCR, then H-SCR. The stage keys are checked on the post-coast
`jangan-fields` if item 2 lands first, otherwise on today's export and re-checked by the test when it lands.

**Tests:**

| Test | Lane | Checks |
|---|---|---|
| `server-info.test.ts`, `servers-clock.test.ts` | SCR-P | as §12.6 |
| `seams-stage.test.ts` | SCR-S | `app.stage` exists and is lazy; the stub throws "not built"; `STAGES` entries fit `StageDef` |
| `stage-host.test.ts` | SCR-R | headless `WorldIO` fixture: `enter(select)` then `enter(create)` on the same export reuses the `World`; `release()` disposes it (no mesh, texture or observer left); `update` runs before the first render; the active-mesh list is non-empty after `enter` with the default filter on; Low loads Classic; `runFirstRun` ran before the first `enter`; the stream settings are the stage's (150 m, 12 fetches); on PBR `scene.environmentTexture` is the world's cube (no studio cube); a load error resolves to the fallback; *(fc-B)* `WorldGraphics.frame` is called with `watch = false` (a forced slow sample drops no preset); a graphics settings change on create leaves the range scale at `min(preset, 0.6)`; the warm-up runs with 2 views (select and create headings); the stage's `WorldGraphics` is disposed before a following world screen's is constructed (the render-scale handler survives); `scene.skipPointerMovePicking` is true |
| `stages.test.ts` | SCR-R | on the served export: the spot within 0.5 m of the nav; 1–4 slots on walkable nav; both cameras ≥ 0.5 m above terrain and outside every object's nav footprint; at 4:3, 16:10, 16:9 and 21:9 every slot's feet and head project inside the frame minus the bars (the selected one stepped forward), and the create character clears the rotate window and the panel rect |
| `stage-time.test.ts` | SCR-R | the sunset hold: night → `sunset(declination)`; day → the live `t`; *(fc-B)* a hold that began at night stays through sunrise until the next `enter()`, then the live clock runs (no tween); no clock → the fallback; the server-time offset is used (§9) |
| `stage-prefetch.test.ts` | SCR-R | the file list is the stage regions' files only; ≤ 4 in flight, `priority: 'low'`, *(fc-B)* `cache: 'force-cache'`; stops on logout and when select starts |
| the existing leak pattern (`abuse-w9f-leaks.test.ts`) | H-SCR | world → select → create → select → world ×3: scene count, `World.disposed`, engine textures back to baseline |
| `pnpm typecheck` + the whole suite at each hand-off; the Low guard green after every merge | all | |

**User checks (after I-SCR; screenshots from the user's own browser):**

1. Log in and pick the server: the loading picture, then your characters in a row on the steps before Jangan's south
   gate, at the server's time of day (at night: sunset). Click one: it steps forward and poses.
2. Create: the camera swings round to the plaza and the golden dragon; turn and zoom the character; the calligraphy
   panel on the right, the red bars.
3. Back to select, then Start: note the seconds to the world (compare with before).
4. Log out and in again: select opens faster than the first time.
5. Graphics on Low: select and create still work, in the Classic look.
6. A friend on a Mac (Safari) and one on a laptop: steps 1–3 with the fps overlay.
7. *(fc-B)* At the sunset hold, a character holding a metal weapon: the blade reads as metal, not a black cut-out
   (§0B.3, §0B.13 item 5).
8. *(fc-B)* The first orbit to create after a fresh page load has no stutter (WebGPU: the warm-up's second view).

### 0B.11 Scope-cut order (cut from the top)

1. The select ↔ create orbit (a 0.3 s dip to black instead; `reduceFlashing` makes it a cross-fade).
2. The town ambience on the stage.
3. The login-time prefetch.
4. The idle camera drift.
5. The server clock and weather (SCR-P): a fixed sunset (`sunriseSunset(12).set` = 0.773; *(fc-B)* was "0.775") and
   a clear sky.
6. The face key light (the stage then holds 09:00–15:30 instead of the sunset hold).

**Never cut:** select and create on real Jangan through the wave-9 renderer at the player's preset; the fallback to
today's screens on a load failure; the Low path; the retail layouts and live English text; the leak and disposal
tests; the 150 m stage load (no 400 m stream behind a menu).

### 0B.12 Risks

- **The shade and the backlight** (§0B.3): the row faces north, so it is backlit by day and in the western buildings'
  shade in the late afternoon; the key light carries the faces [confirmed: renders]. If a friend's screen reads too
  dark, the key light's intensity is one constant.
- **The plaza view on create is the town's busiest view** (the plaza is where High reaches ~700 draws in play,
  work/tmp/w9-finish/budgets.md). Uncapped, create at High is 521 draws and 10–14 ms p95 on the dev PC; the 0.6 draw
  range brings it to 286 draws and 6.5 ms (§0B.9). If a friend's laptop still dips, the next lever is Medium's
  shadows on the stage; item 1's merging lowers it further.
- **Production revalidation** (§0B.4): ~1,250 conditional requests per stage entry until the asset caching changes
  [confirmed count, projected time].
- **WebGPU Effect retention (W9F LEAK-2, §4.3):** the stage is now the first `World` a session compiles on WebGPU, so
  it may be the one kept for the page's life [likely]; the heap budget allows one retained World (§11 "Whole" row).
- **The coast re-export (item 2)** could move ground near the spot; the stage test catches it. *(fc-B)* [confirmed:
  none. The only in-bounds edit is S1, ≈ 1.2 km south, §0B.10.] Its ocean is frustum-selected, so it can cost draws
  and FFT ticks behind the walls on both views [projected]; re-benched after item 2, hidden on the stage if > 0.3 ms.
- ~~The release in flight owns `charselect.ts`/`charcreate.ts` today.~~ *(fc-B)* Committed in `b6fb115` (§0B.10).
- *(fc-B)* **Dark metals at the sunset hold** (§0B.3): the stage's reflections are the world's sRGB-read sky cube, the
  look the release had to fix on today's screens with a linear studio cube [confirmed: `studio-env.ts` header,
  `lighting.ts` `WORLD_SKY_CUBE_DECODE`]. A user check covers it. The levers are the key light's specular, then the
  wave-10 look pass.
- *(fc-B)* **Load-time expectations**: the warm stage load is ≈ 3.5 s on localhost, not a 2× win over 400 m (§0B.4). The
  first visit adds the world's shader compile, moved from world entry to the select screen (up to the warm-up's 20 s
  cap). The gain for returning players is the HTTP cache and the compiled shaders at world entry.
- *(fc-B)* **Page-global hand-offs** (`setRenderScaleHandler`, `GameAudio.setArea`): wrong disposal order breaks the
  world's FSR or its ambience silently; `stage-host.test.ts` pins the order (§0B.10).

### 0B.13 Needs from the user (each has a default, so nobody waits)

1. **Look at `work/tmp/stage/overview.jpg`:** select before the south-gate steps (the picture you chose), create turned
   round to face the plaza and the golden dragon. **Default: as shown.** Say if you would rather have create on the
   steps too, or select facing the dragon.
2. **Time on the character screens:** the server's live time and weather, **held at sunset at night** (default; the
   warm frames in the overview), or always sunset, or always daytime.
3. **Music:** `maintheme_cut` stays on select and create (default), with the town's ambience quietly under it
   (default on).
4. Nothing to download, buy, upload or sculpt for this item. *(fc-B)* [confirmed: every input is the served export,
   the game's own modules and retail UI art already in `out/`; no Blender work, no new asset]
5. *(fc-B)* **At the user check:** look at a character with a metal weapon (the Copper Blade) at the sunset hold. It
   will look as it does in the world at that hour, darker than on today's release screens (§0B.3). Default: accept;
   the fix belongs to the wave-10 sky-cube look pass.

### 0B.14 Open questions (each has a default)

1. **"Palace steps" are the south-gatehouse steps** (§0B.1). Default: this spot and view, the image the user picked;
   another Jangan spot is a one-line change in `stages.ts`.
2. **The calligraphy panel over the 3D scene on create** (retail's rect covers the right ~40% of the width, part of the
   dragon plaza). Default: retail, as §6.2. Alternative: narrower or fainter.
3. **Create heading ±10°** to bring the dragon's head below the top bar. Default: π (due north), tuned by SCR-R on
   renders with the bars drawn.
4. **Stage load radius 150 m or 200 m** (7 or 9 regions). Default: 150 m unless create's north horizon shows a hole
   (SCR-R's check; §0B.4).
5. **Asset caching in production** (`no-cache` + ETag on `/out-opt/`: one round trip per file). Default: unchanged
   this wave; item 1's perf lane or DEPLOY may version the asset URLs and let them cache.
6. **Animals on the stage** (item 5). *(fc-B)* GRASS_LIFE made the life a `World.life` part, so the stage gets
   butterflies, perchers and fly-overs with `loadWorld`, around the spot [confirmed: GRASS_LIFE.md §5.1]. Default: take
   it as it is. Ground flocks are turned off on the stage only if GL-0 exposes a switch [unknown: not in its lane row
   yet].
7. **Idle clips for the unselected characters** (`STAND1` only, or an occasional `WAIT01..04` [confirmed clips, §6.1]).
   Default: `STAND1` only, as today.
8. **European characters on select.** Default: no (Chinese only).
9. **Create's draw range 0.6** (§0B.9: it trims the far layer behind the plaza to keep High laptops at 60 fps). Default:
   0.6 on every PBR preset; revisit after item 1's merging (if create's High p95 is ≤ 8 ms at the preset's range, the
   cap goes). *(fc-B)* After item 1 the cap removes at most one whole region (§0B.9), so it is expected to go.
10. *(fc-B)* **Sunrise while a stage is up.** Default: the sunset hold stays until the next `enter()` (no tween, §0B.3).
    Alternative: a 0.3 s dip to black and a snap to the live time.
11. *(fc-B)* **Ultra on the stage** (not benched; SSR `always`, 4 cascades). Default: the player's preset as chosen,
    Ultra included; SCR-R reports its numbers. Alternative: the stage caps Ultra to High.
12. *(fc-B)* **The ocean on the stage** (item 2, drawn behind the walls). Default: shown; SCR-R hides it on the stage
    only if it costs > 0.3 ms there.

---

## 0. Summary

1. *(deferred, stage B only 2026-09-29: no intro this wave)* **Retail has no opening movie** [confirmed: no `.bik/.wmv/.avi/.mpg/.mp4/.webm` in any of the five extracted
   archives or the client folder; `Media/launcher/movie.dat` is a 9,080-byte BMP, the launcher's "movie" *button*,
   which opens a web page]. The intro has to be made. **[decision]** It is made **in real time from the game itself**:
   a 25-second scripted camera flight over Jangan at golden hour through the wave-9 renderer, with the retail main
   theme (§3). No video file, nothing downloaded, nothing to keep in sync with the look.
2. **Retail's login "scene" is not usable** [likely]. `Map/camera_path.txt` (3 keys) points into region (78, 70), a
   fortress-war guild field with two headquarters pads; its keys sit 6 m *below* the ground there [confirmed:
   heights from the `.m` file, and a render, §1.3]. The login backdrop becomes a slow drift over Jangan, continuing
   the intro's last shot (§5).
3. **The character select and create "little map" is two street spots in Constantinople** [likely]. `Media/config/
   cameradata.txt` names region (79, 107) and (77, 105) with a point exactly on the ground (80 vs ground 80.2; 79 vs
   79.2) and a 3 m / 1 m / 50° camera [confirmed: heights and object lists]. Rendered through the wave-9 renderer, both
   spots frame a **castle gate arch** behind the characters (§10, `work/tmp/screens/overview.png`). Retail staged
   character select in the world renderer, on real map regions, not on a separate map [likely].
4. *(stage B only 2026-09-29: the user chose **B**; stage A, its export and its download are dropped; §0B.2 has the
   stage-B select and create keys)* **Two stage options, one mechanism** [decision]. A *stage* is data: a world export, a spot, a camera, a time of
   day. **Stage A** = the retail Constantinople spots (faithful; needs a new ~20–30 MB stage export of 9 European
   regions [projected]). **Stage B** = Jangan (the palace steps north of the plaza; free, on-theme, remastered
   textures, and it warms the world's cache). The intro and login always use Jangan. **Default: A for select and
   create** (what the user asked for), B as the built-in fallback and scope cut 6 (§13) *(fact-check: the draft said "the first scope cut"; §13 lists it sixth)*. The user picks
   from the overview image (§15 item 1).
5. *(stage B only 2026-09-29: `titleScene()` stays on login and server select this wave; select and create leave
   it)* **What the user saw as "a video"** is `titleScene()`: a procedural plaza of red cylinders, sphere lanterns and a
   canvas-drawn floor, with a sine-driven camera (`three/backdrop.ts`, `screens/title.ts`) [confirmed]. It is shared
   by login, server select and character select. It is deleted in this wave.
6. *(stage B only 2026-09-29: stage B's measured budgets are in §0B.9)* **Budgets** (§11): the retail select stage with 4 characters, re-measured at 1920×1080 with the sky assets and the
   renderer's default active-mesh filter on: **WebGL2 3.3 / 4.5 ms CPU p50/p95 at High (426 draws); WebGPU 2.7 /
   4.1 ms at Medium (192 draws)** on the dev PC [confirmed: `bench` in the prototype, *(fact-check)*]. Single runs vary
   2–3× in the hidden pane, so every budget is a min of 5 runs. Outer screens are cheaper than the world; the watch
   items are WebGPU's CPU per draw and the intro's flight over the town.
7. **Protocol:** one additive change: `ServerInfo.clock?` and `ServerInfo.weather?` (the same types `WorldInfo`
   already carries), so the character-select sky can match the server's sky (§9). No new message, no migration.

---

## 1. What the retail client has

### 1.1 Method

- The five archives are extracted under `work/extracted/` [confirmed]. The client folder
  (`sro.config.json` `clientDir`) holds `Data/Map/Media/Music/Particles.pk2`, `silkroad.exe` (the 778 KB launcher),
  `SilkroadLauncher.exe`, `replacer.exe` and small config files [confirmed: `ls`]. **The game executable
  (`sro_client.exe`) is not in the folder** [confirmed], so how the client reads the camera files cannot be checked in
  code [unknown]; everything below is read from the data and checked by rendering it.
- Scratch scripts: `work/tmp/screens/explore-scenes.ts` (objects, heights, environment of the three regions),
  `explore-login.ts` (the region block around (78, 70)). Conversions: `pnpm sro convert-region --regions
  77-80,105-108 --out work/tmp/screens/out/world/screens-cs` and `--regions 76-80,68-72 ... screens-login`
  (6.3 s and 2.5 s, 0 warnings / 6 warnings) [confirmed].

### 1.2 Opening movie

| Looked for | Result |
|---|---|
| Extension census of `work/extracted/**` (Data, Map, Media, Music, Particles) | ddj, bms, bsr, nvm, ban, o/m/t/o2, bmt, wav, efp, bsk, txt, dat, cpd, ogg, 2dt, c, dof, psh, ifo, vsh, tga, ttf, mfo. **No movie container** [confirmed] |
| Client folder | no `.bik`, `.wmv`, `.avi`, `.mpg`, `.mp4` [confirmed: `find -maxdepth 3`] |
| `Media/launcher/movie.dat` | `BM` header, 9,080 bytes: a bitmap for the launcher's movie button; `launcher/reflinkurl.txt` line 2 (`//movie`) points it at the publisher's website [confirmed] |
| Launcher strings | `\Launcher\movie.dat`, `division_select.dat`, `config\agreement.txt`: launcher UI only [confirmed: string scan of `silkroad.exe`] |

**Conclusion:** vSRO 1.188 ships no intro video [confirmed for these files]. Whatever intro the user remembers was
either the real-time login scene or a publisher trailer on the web [unknown]; nothing retail can be reused.

### 1.3 The login scene: `Map/camera_path.txt`

```
 78, 70   662.02, 800.0, 415.39   1.570796, 0, 0, 2190.31     (3 rows, same region, same rotation/time)
```

- Region (78, 70) exists (`Map/70/78.{m,o,o2,t}`) [confirmed]. Its terrain spans 735–1323 file units; **the ground
  under the three keys is 859.6, 860.0 and 860.3** (and 850–859 with x and z swapped) [confirmed:
  `explore-login.ts`]. Read as absolute heights like `.o` positions, the keys sit ~6 m underground.
- Its objects: `headquarters_00.bsr` ×2 (one 20 m from key 2), `glory_gate.bsr`, a few graveyard trees and bamboo
  [confirmed]. The block around it (x 69–80, z 66–71) holds the **fortress-war maps**: `jang_guild_buil01`,
  `guil_cj_*`, `big_gate_ja` (x 69–73) and `bj_guild_*`, `big_gate_bj` (x 76–80) [confirmed: object listing].
- Rendered (prototype, §10): open grassland with two round headquarters pads [confirmed:
  `work/tmp/screens/shots/login_r78_70_yaw270.jpg`].
- The field names match the GM camera editor (`resinfo/ifcameradatawnd.txt`: TIME, REGION_X/Z, POSITION_X/Y/Z,
  ROTATION_X/Y/Z/W) [confirmed, apps/game/README.md].
- **Reading [likely]:** a leftover GM/fortress camera path, not the login backdrop. Even if the retail client flew it,
  a fortress-war field is not what the user wants behind the login form. **Not used** [decision]. The README's
  "Login / character-select backdrop (investigation)" section is corrected by the integration lane (§12.9).

### 1.4 The character select and create scenes: `Media/config/cameradata.txt`

```
-1
79  107   1205  80  396   30  10    0  50        row 1
77  105   1466  79  1488  30  10  270  50        row 2
```

| | Row 1 | Row 2 |
|---|---|---|
| Region | (79, 107), `Map/107/79` | (77, 105), `Map/105/77` |
| Point (region-local, dm) | (1205, 80, 396) | (1466, 79, 1488) |
| Ground under it | 80.2 [confirmed] | 79.2 [confirmed] |
| glTF metres (frame of the `screens-cs` export, origin = SW corner of (79, 107)) | (120.5, 8.0, −39.6) | (−237.4, 7.9, 235.2) |
| What is there | Constantinople: `euro_constan_bl_04` 7 m away, `streetlight02` 8 m, `bl_05` 13 m, `tree02` 10 m, `cons_caswall_c2` 27 m [confirmed] | Constantinople: `streetlight01` 8 m, `tree02` 7 m, `bl_03`/`bl_04` 14 m, `cons_caswall_c2` 25 m [confirmed] |
| Environment profile | 33 (`Env8`) on all 36 blocks [confirmed] | 33 [confirmed] |
| Camera fields | 30, 10, 0, 50 | 30, 10, 270, 50 |

- **Reading [likely]:** row = stage; point = where the character(s) stand; then distance 30 dm (3 m), height 10 dm
  (1 m), yaw in degrees, field of view 50°. The heights matching the ground to 0.2 dm and the character-scale camera
  are the evidence [confirmed]; the field names are not in the data [unknown].
- **The yaw [likely]:** with the camera placed `dist` along (sin yaw, 0, cos yaw) in glTF space (the prototype's
  convention), row 1 at yaw 0 and row 2 at **yaw 90** both frame a castle **gate arch** behind the spot, with the
  keep above it; every other heading shows a plain street or a wall 1 m away (§10). So the file's yaw turns the other
  way from ours (270 → 90). *(fact-check)* A z flip alone maps θ → π − θ (0 → 180), not θ → −θ; the observed θ → −θ
  is what you get if the file's yaw is the camera's **look** heading in file space (the camera sits behind the spot)
  *and* z is flipped [confirmed: arithmetic; the wall `cons_caswall_c2` is at +z file (row 1, 27 m) and −x (row 2,
  25 m), i.e. in front of each camera]. The stage table stores glTF headings, converted once and pinned by a test
  (§12.6).
- **Which row is which [likely]:** row 1 = character select (it has room for a row of four), row 2 = character
  create (a single character before a gate). `resinfo/pscharacterselect.txt` has `GDR_TEXT_CHINA` and
  `GDR_TEXT_EUROPE`, `GDR_LOADING_CHINA/EUROPE` [confirmed]: one select stage for both races, which fits a stage in
  the shared world rather than a Chinese-only set [likely].
- **Chinese create is 3D + a 2D panel:** `pscharactercreatechina.txt` `GDR_STA_BACKIMAGE` draws
  `interface/outer/back_image.ddj` at rect (969, 170, 632, 864), with `redbar_up/down` bars [confirmed: resinfo]. The
  layout space is 1600 wide [likely: x + w = 1601, and the outer bars are 1600×172 textures, `ui/chrome.ts`], so the
  panel covers the right ~40% of the screen. `pscharactercreate_europe.txt` has no back image [confirmed].
  Today's client draws the calligraphy as a 3D plane behind a pedestal (`charcreate.ts` `artPlane`) [confirmed]; it
  becomes the retail screen-space panel (§6.2).

### 1.5 Music

- `Music.pk2` holds 37 tracks (plus Korean-named duplicates) [confirmed: listing]. **`maintheme_cut.ogg` (120.2 s,
  794 KiB)** is the only title theme [confirmed: durations read from the Ogg pages]. No track is named for login,
  select or create [confirmed].
- Our client already plays `maintheme_cut` on the splash, login, server list and character screens
  (`app.music.play(app.art.musicUrl('maintheme_cut'))`) [confirmed]. Retail used it the same way [likely].
- Candidates for variety, all retail: `jangan_town.ogg` (64 s), `shiningstar.ogg` (278.5 s, an event song [likely]).
  **Default:** keep `maintheme_cut` everywhere outside the world (§15 item 5).

---

## 2. What our game shows today

| Screen | File | Scene | Notes |
|---|---|---|---|
| Splash | `screens/splash.ts` | none (black) | wordmark fades in/out, 4.4 s, click skips; starts `maintheme_cut` (blocked until a gesture) [confirmed] |
| Login | `screens/login.ts` | `titleScene()` = `buildPlaza()` | retail `pstitle` layout, kit buttons, register mode [confirmed] |
| Server select | `screens/servers.ts` | same `title` scene (kept by `app.useScene('title')`) | informational list [confirmed] |
| Character select | `screens/charselect.ts` | its own `buildPlaza()` | 4 slots at x = ±0.8, ±2.4 on a 14 m platform, STAND1, pick cylinders, name tags, info window; sine camera [confirmed] |
| Character create | `screens/charcreate.ts` | a dark scene with a pedestal, a spotlight and `back_image` as a 3D plane | turntable, Height/Volume, starter outfits [confirmed] |
| Loading | `screens/loading.ts`, `warmup.ts` | overlay | streaming + shader warm-up (PERF2) [confirmed] |

- **"The video"** [likely]: nothing in the client plays a video (`grep` for `video`, `.webm`, `.mp4`, `VideoTexture`
  finds nothing) [confirmed]. Behind the login form runs `buildPlaza()`: a 240 m `CreateGround` with a
  `DynamicTexture` grid, a cylinder platform, nine red `CreateCylinder` columns with sphere "lanterns", a hemi light, a
  "moon" directional light and exp2 fog; `titleScene` swings the camera with `sin(t·0.05)` etc. [confirmed:
  `three/backdrop.ts`, `screens/title.ts`]. It is a placeholder from wave 1 ("Placeholder 3D backdrops … that needs
  the world renderer") [confirmed: file header] and looks like nothing in Silkroad.
- The outer screens' *scenery* uses `StandardMaterial` and no `World`, so wave 9's sky, terrain, shadows and post do
  not reach them [confirmed]. *(fact-check)* The characters on them are not untouched: `three/models.ts` uses
  world-render's `setHighlightOverlay`, `three/actor-textures.ts` its `ActorMaps` (the remastered PBR sets), and the
  release now in the working tree adds `three/studio-env.ts` (`StudioEnvironment`, a world-render `SkyEnvironment`
  cube) to select and create on the PBR path [confirmed: imports]. On a stage the real sky cube replaces it, so SCR-SEL
  and SCR-CRE drop the `StudioEnvironment` calls, and I-SCR deletes `studio-env.ts` (and its test) if nothing else
  uses it.
- Open item carried over (BACKLOG): **memory growth when going world → character select** [unknown cause]. The new
  stage host owns one `World` at a time and must prove it disposes it (§12.6, lens H-SCR 3).

---

## 3. The new flow

*(stage B only 2026-09-29: this wave builds only the CHAR SELECT and CHAR CREATE boxes, both on stage B; boot → splash
→ login → servers stay as today; §0B.)*

```
 boot ─► INTRO ─────────────► LOGIN ─► SERVERS ─► CHAR SELECT ─► (CHAR CREATE ─►) CHAR SELECT ─► LOADING ─► WORLD
         logo beat + 25 s     same Jangan stage,  same stage   stage A or B        create stage A or B
         Jangan flight        slow drift          next shot    (row of 4)          (single character)
         (skippable)
```

**Scenes and reuse** [decision]:

| Screen | Stage | World export loaded | Kept across |
|---|---|---|---|
| Intro | `jangan-intro` (shots over Jangan) | `jangan-fields` (the deployed export, `deploy/config.sh` `DEPLOY_WORLD_EXPORT`) [confirmed]; `jangan` as the fallback (`resolveAssetBase`). *(fact-check: the draft's "known from a previous visit" needed a stored value nobody owned; dropped)* | → login, servers (same `World`, same scene) |
| Login, server select | `jangan-login` (the intro's last shot, drifting) | same | → select when select uses stage B |
| Character select | `select` (A: `stage-cs` region (79, 107); B: `jangan-fields` palace steps) | A: `stage-cs`; B: the server's export | → create when create uses the same export |
| Character create | `create` (A: region (77, 105); B: a second Jangan spot) | as select | → select (back) |
| World | — | the server's export | the stage `World` is disposed before the world screen builds its own (§4.6) |

- **One `World` alive at a time**, owned by the stage host (§4.5). Switching between screens on the same export only
  moves the camera and the time; switching exports (Jangan → stage A) disposes the old `World` first.
- **Loading the stage is hidden behind what the player is already doing** [decision]: the intro's logo beat covers
  the first Jangan load; login and server select give stage A seconds to stream in the background; the existing
  `LoadingOverlay` (`LOADING_PICTURES.characters`) covers any remainder, as today.

---

## 4. Stages: data, loading, lighting

### 4.1 The stage table (`apps/game/src/stage/stages.ts`, data only)

```ts
export interface StageDef {
  id: 'intro' | 'login' | 'select' | 'create'
  /** Export folder under /out(-opt)/world/, or 'server' = the selected server's `ServerInfo.world` (default jangan-fields). */
  world: string
  /** The spot (glTF metres, in that export's frame) where characters stand; y is re-snapped to the nav surface. */
  spot: { x: number; z: number; yHint: number }
  /** Heading of the row / the character (radians, 0 = +Z), facing the camera. */
  facing: number
  /** Static camera (select/create) or a path (intro/login). */
  camera: { kind: 'fixed'; distM: number; heightM: number; yaw: number; fovDeg: number; targetHeightM: number }
        | { kind: 'path'; keys: CameraKey[]; loop: boolean }
  /** 0..1 time of day, or 'server' (the ServerInfo clock, §9) with `fallback`. */
  time: number | { kind: 'server'; fallback: number }
  /** Weather: 'clear' (default) or 'server'. Stages never start rain on their own. */
  weather: 'clear' | 'server'
  /** Streaming focus radius (m) the screen waits for (default 120). */
  readyRadiusM?: number
}
export interface CameraKey { t: number; pos: [number, number, number]; target: [number, number, number]; fovDeg: number }
```

**Proposed entries** [decision; numbers from the prototype, §10]:

| Stage | A (retail) | B (Jangan) |
|---|---|---|
| select | `stage-cs`, spot (120.5, 8.0, −39.6), camera 3.0 m / 1.0 m / heading 0 (file 0) / 50°, row of 4 at 1.3 m across the view | `jangan-fields`, spot (101.0, −3.3, −56.0) = region (168, 97) local (1010, 560), the steps and gate behind. *(stage B only 2026-09-29: superseded by §0B.2: the camera looks **south** at the town's south gatehouse (the draft's "north of the plaza" was wrong, §0B.1), 3.94 m by the fit rule)* |
| create | `stage-cs`, spot (−237.4, 7.9, 235.2), camera 3.0 m / 1.0 m / heading π/2 (file 270) / 50°, one character, turntable | `jangan-fields`, a second spot picked in LAB-S (default: the same steps, camera 2.4 m, a quarter turn). *(stage B only 2026-09-29: superseded by §0B.2: the same spot, the camera turned to look **north** at the plaza and the dragon fountain, 3.6 m / face 1.6 m)* |
| login | `jangan-fields` path over the plaza and the palace steps, 60 s loop *(deferred, stage B only 2026-09-29)* | same |
| intro | `jangan-fields` 5-shot path, 25 s *(deferred, stage B only 2026-09-29)* | same |

The yaws and the 1.3 m slot spacing are pinned by `stages.test.ts` (§12.6). Wave 10 moves terrain around Jangan (the
coast) and brings new tree models: **every Jangan key is authored after wave 10's export lands** and re-checked by the
same test (§12.10).

### 4.2 The stage export (stage A only)

*(stage B only 2026-09-29: dropped. The user chose stage B; no `stage-cs` export, no `--keep-within` flag, no SCR-X.)*

- **Preset** `stage-cs` in `WORLD_PRESETS` (`packages/convert/src/world/convert-world.ts`): regions x 77..79,
  z 105..107 (9 regions), centre (79, 107), no spawn teleport, `displayName: 'Constantinople (stage)'`.
- **New converter flag `--keep-within <x,z,r>...`** (repeatable): drops placements farther than `r` metres from every
  listed point (the two spots, **r = 150 m**, *(fact-check)*: was 250) and terrain/navmesh of regions entirely
  outside. Deterministic (sorted output, as today). Both cameras look at a wall 25–27 m away, so nothing beyond
  ~150 m is visible from either spot [likely: the shots].
- **Size** *(fact-check: the first projection did not add up)*. The 16-region scratch conversion is 93 MB raw
  [confirmed: `du -sb`]; `out-opt` slims Jangan ×0.71 (76 → 54 MB) and jangan-fields ×0.85 (374 → 317 MB)
  [confirmed: `du -sm`]. The two 250 m circles are 451 m apart and together cover almost all of the 9 regions
  (576 m × 576 m), so r = 250 m trims little: the placements inside them use **81 models, 27.6 MB**, versus 16.1 MB
  (49 models) at r = 150 m [confirmed: the scratch manifest's placements and model bytes, `work/tmp/screens` fact-check
  script]. Adding tiles (≤ 17.5 MB, less if trimmed to the kept terrain), terrain (2.8 MB) and navmesh (~1 MB):
  **r = 250 m ≈ 30–40 MB out-opt; r = 150 m ≈ 20–30 MB** [projected], less on the wire with brotli. Deploy ships it
  with the other world folders (`deploy/` include list; DEPLOY.md).
- *(fact-check)* Wave 10's coast lane (CST-C) also edits `convert-world.ts` (`WORLD_PRESETS`, the `RegionSource`
  switch) and `cli.ts`; SCR-X lands after wave 10 and rebases on it (the preset gets no `coast`).
- Textures of European models are **retail only** (no 9B remaster sets exist for them) [confirmed: 9B batches cover
  Jangan]. On High they get the derived PBR defaults like every un-remastered asset.

### 4.3 Loading a stage (`apps/game/src/stage/host.ts`)

*(stage B only 2026-09-29: kept, with §0B.4's stage stream settings (150 m, 7 regions, 12 fetches), parallel character
loads, the login-time prefetch and the fallback to today's screens; `camera.kind` is `'fixed'` only this wave.)*

```ts
export interface StageHost {
  /** Loads (or reuses) the World for `def.world`, places the camera, sets time/weather; resolves when the regions
   *  within readyRadiusM of the spot are in and the stage has rendered once. */
  enter(def: StageDef, opts: { onProgress?: (f: number) => void; signal?: AbortSignal }): Promise<Stage>
  /** Disposes the World and the scene (world screen entry, logout of the whole app). */
  release(): void
}
export interface Stage {
  readonly scene: Scene
  readonly world: World
  readonly camera: ArcRotateCamera
  /** Places the camera path at time t (s) or the fixed camera; login/intro drive it every frame. */
  setCameraTime(t: number): void
  /** The standing points for n characters (nav-snapped), in slot order, and their facing. */
  slots(n: number): { x: number; y: number; z: number; yaw: number }[]
  /** Registers an actor's meshes with the renderer (shadows, PBR characters, remaster lighting). */
  addActor(root: TransformNode): void
  removeActor(root: TransformNode): void
}
```

- It loads through the same path as the world screen: `resolveAssetBase(ASSET_ROOTS, …)` and `loadWorld(scene, {
  baseUrl, world, quality, render, sky, weatherLevel, gpu, stream: 'auto', focus: spot, readyRadiusM, minimap: false
  })` (factor the options out of `world/jangan/ground.ts` `loadJangan`, which is exactly this call, rather than a
  second copy) with the same `effectiveGraphics()` the world screen uses (`settings.ts`), so a player on Low sees the
  Classic path and one on High sees High [decision].
- *(fact-check)* **The first-run device check must run before the first stage.** Today `runFirstRun(settings,
  deviceHintOf(engine, kind))` runs only on world entry (`screens/world.ts`) [confirmed]. The intro is now the first
  3D the page draws, so without this a first visit renders the intro at the stored default (`preset: 'medium'`,
  resolution 1, weather `auto`) even on a machine the check would put on Low or at 0.75 resolution, and without the
  16-varying guard's `gpu` hint. The host calls `deviceHintOf` + `runFirstRun` once before its first `enter()`.
- *(fact-check)* **The world screen's graphics link has more than `effectiveGraphics`:** `world/graphics.ts`
  `WorldGraphics` applies the rollout gate, the render scale, the tone map, the character-material decoration (6
  lights per material on PBR), the Classic path's character lights and the frame watchdog [confirmed: its header]. The
  host reuses `WorldGraphics` (or a function factored out of it by SCR-R) instead of re-deriving these, so the stage
  and the world cannot drift apart.
- **Per frame it must call `world.update(camera, spot)`** before the first render. Without it the PBR post stack never
  attaches and the prototype drew only the sky [confirmed: prototype, first run]. `RenderPath.update` adopts the
  camera it is given when none is attached (`render/index.ts`) [confirmed: code], so `attachCamera(camera)` is only
  needed to switch cameras; the host calls it anyway when it replaces its camera.
- *(fact-check: the earlier finding does not reproduce)* **The default active-mesh filter works on stages.** The
  first pass saw an empty active-mesh list with `enabledCandidates` on; re-run on the same prototype at 1920×1080 with
  `?ec=1` it drew normally: 117 active meshes, 426 draws at High (same as with the filter off), 1,065 candidates =
  1,065 enabled meshes [confirmed: `scene.getActiveMeshes()`, `getActiveMeshCandidates()`], and it was **cheaper**
  (WebGL2 High 3.3 / 4.5 ms vs 4.2 / 6.6 ms off; WebGPU Medium 2.7 / 4.1 vs 6.1–6.8 / 8.7–10.0 off). The first run's
  cause is [unknown] (candidates: the 300×150 hidden canvas, the missing sky assets, §10). **Default: keep the filter
  on**; `stage-host.test.ts` still asserts a non-empty active-mesh list after `enter`.
- `waitForObjects` stays at the default (true): a stage without its buildings is worse than a slightly longer load.
- **Warm-up:** the stage runs `warmup.ts` `GraphicsWarmup` with `viewSteps: 0` (the `shaders` and `settle` steps, no
  `views` turn), so the first shot does not hitch. The compiled effects stay in the engine's cache for the world screen
  [confirmed: `render/babylon-fixes.ts` W9F LEAK-2: "the page engine keeps every compiled Effect"], which is why stage
  B speeds up world entry. *(fact-check)* The same comment says that **on WebGPU a cached Effect keeps the material
  that first compiled it, and through it that scene and its `World`**, for the page's life (the LEAK-2 fix is
  WebGL-only). The intro now compiles most variants first, so on WebGPU the first stage `World` (and stage A's, if it
  compiles new variants) stays reachable after `release()` [likely]. It is one retained graph, not growth per trip
  (later compiles hit the cache) [likely]; H-SCR lens 3 measures it on WebGPU separately (§11 heap budget).
- **Night lights** (`attachNightLights`) on every PBR stage; the lamps near the Constantinople spots light the row at
  dusk [confirmed: night shot in §10]. *(fact-check)* Within 10 m there are **2** street lights at row 1
  (`streetlight02_01` at 7.8 m and 9.8 m) and **1** at row 2 (`streetlight01` at 7.6 m; the next is 16.5 m)
  [confirmed: `explore-scenes.ts` re-run], not 4.

### 4.4 Lighting the characters

*(stage B only 2026-09-29: kept, with two changes in §0B.3: the night hold is **sunset for the clock's season**
(0.773 at +12°), not a fixed 0.78, and the key light's intensity is 0.5 (measured on renders); the release's
`StudioEnvironment` is not used on the stage.)*

- Characters are registered exactly as in the world [decision], so they look the same on the stage as in play:
  `world.render.addCharacter(mesh)` for shadows, the material decoration `world.materials.pbr.decorateCharacterMaterial`
  that `WorldGraphics` applies [confirmed: `world/graphics.ts`], and on the **Classic path only** the remaster
  lighting (`RemasterLighting`; the world makes it only on Classic, `graphics.onPath`) [confirmed: `screens/world.ts`
  comment; *(fact-check)*: the draft applied it on every path].
- **A soft key light for faces** on PBR presets: one directional light, `includedOnlyMeshes` = the stage actors,
  intensity tied to `SkyState` (0.35 × sun at noon, 0.6 at dusk/night), from the camera side 30° up. The select
  stage at 19:12 is readable but dark without it [confirmed: `select_yaw0_high_dusk.jpg`]. Low uses the existing
  hemi colours. *(fact-check)* It is created once in `enter()` before the actors' materials compile and kept for the
  stage's life (intensity 0 when unused): adding or removing a light marks the scene's materials dirty [likely:
  Babylon light defines], and it takes the one free slot of the 6-light character budget (celestial + night pool 2 +
  hit flashes 2) [confirmed: `world/graphics.ts` header].
- **Time:** select/create default to the **server's clock** (§9), so the sky there is the sky the player walks into;
  when it is night on the server, the stage clamps the sun to no lower than dusk (time 0.78) [decision]; intro and
  login use a fixed **17:00 (0.71)** golden hour [decision].
- **Weather:** clear on the intro and login; select/create use the server's weather at **half intensity, never
  lightning** [decision] (rain on the stage is a nice touch; a bolt behind the menu is not).

### 4.5 Ownership of the scene

- `App.useScene(kind, build)` stays the mechanism [confirmed: `app.ts`]; the stage host uses the kind
  `stage:<export>`, so login → servers → select (stage B) reuse one scene, and select → create reuse it whenever both
  are on the same export.
- `three/backdrop.ts` (`buildPlaza`, `artPlane`, `selectionRing`, `newScene`) is **deleted** except `newScene`, which
  the world screen imports [confirmed: `world.ts` imports `newScene`]; `selectionRing` moves into
  `stage/slots.ts`.

### 4.6 Hand-over to the world

- `charselect` → `world`: the select screen releases the stage (`app.releaseScene()`, as today), then the world screen
  builds its own scene and `World`. **No sharing of the `World` object in this wave** [decision]: `world.ts` owns a
  different lifecycle (features, streaming focus on the character, GM, HUD). The gain from stage B is the HTTP cache
  and the engine's compiled effects, not a skipped load. Sharing is a later perf item (BACKLOG item 9).

---

## 5. Screens 1–3: intro, login, server select

*(deferred, stage B only 2026-09-29: the intro flight is deferred by the user; login and server select keep today's
`titleScene()` backdrop. Nothing in §5 is built this wave.)*

### 5.1 The intro (`screens/intro.ts`, replaces `splash.ts`)

1. **Logo beat (0–N s, covers loading):** black screen, the live wordmark (`ui/wordmark.ts`, big) and the live hint
   "Click to begin" (`splash.hint` reworded). The click **unlocks audio** (browsers block autoplay until a gesture
   [confirmed: `audio/music.ts` unlocks on the first `pointerdown`/`keydown`]). Meanwhile the host loads the intro
   stage. *(fact-check)* "Ready" for the intro means **every region along the five shots**, not one focus radius: the
   flight crosses the east fields, the wall, the plaza and the palace (roughly a 1 km path), so the host waits on
   `stream.whenReady` for each shot's focus (or preloads the union) before shot 1; otherwise later shots pop in.
2. **Flight (25 s, five shots, cuts through a 0.4 s black dip):** golden hour, clear sky; the music starts at the
   first shot.
   | Shot | Length | What | Why |
   |---|---|---|---|
   | 1 | 6 s | low over the fields east of Jangan toward the east gate, trees and grass in the wind | the land, wave 10's new trees |
   | 2 | 5 s | rising along the city wall to the gate tower | the walls, cloud shadows (wave 10) |
   | 3 | 5 s | through the gate into the plaza, the dragon fountain | the town |
   | 4 | 5 s | a slow push up the palace steps (stage B's backdrop) | sets up select |
   | 5 | 4 s | crane up over the palace roofs, the bay beyond (wave 10's coast) | the reveal; the wordmark fades in |
   Shots avoid the densest views: each key is checked against a draw budget (§11) in LAB-S.
3. **Hand-off:** shot 5 *is* the start of the login drift; the login window fades in over it without a cut.
4. **Skip:** any key or click after the logo beat skips to the last frame of shot 5 (login appears at once). `?skip=1`
   (today's `skipSplash`) skips the whole intro, as do `?auto=1` mock runs [decision: keep the existing param].
5. **When it plays:** first visit only (default), then straight to the login with the logo beat shortened to the
   load; Options → Interface → "Play the intro: First time / Always / Never" [decision]. Stored in the existing
   settings store (`settings.ts`, the `ui` section: `ui.intro` and `ui.introSeen`), not a new `localStorage` key.
   *(fact-check)* The settings record's section is `ui`, not `interface` [confirmed: `Settings.ui`]; the Options menu
   exists only in the world HUD [confirmed: `hud/options.ts`, the `studio-env.ts` note], so the row is registered with
   `registerOptionRow('interface', …)` from `hud/options.ts` (not `settings.ts`) at module load of `screens/intro.ts`.
6. **Fallbacks:** no WebGL/WebGPU, or the stage not ready 10 s after the click → the logo beat stays up with the
   music and the login appears over a still, dark backdrop; the stage keeps loading behind it. *(fact-check)* The
   intro's "seen" flag is set only when the flight played (to the end or skipped by the player), **never on this
   fallback**. A first visit downloads the town's regions before shot 1: the `jangan` town export is 54 MB in out-opt
   [confirmed: `du`], and the path adds a few field regions, so ≈ 50–80 MB [projected]. At an unknown mini-PC upload
   rate (WAVE_PLAN3 §8 item 11) that can exceed 10 s, and a "first visit only" intro that falls back on the first
   visit would otherwise never be seen.
7. **No captions** by default (§15 item 3). If the user wants lore lines, they are live English text (`i18n`),
   centred low, 2–3 lines, never baked into art.

### 5.2 Login (`screens/login.ts`)

- The form and its retail layout are unchanged (docs/UI.md §4.7) [decision]; only the backdrop changes:
  `titleScene(app)` → `app.stage.enter(STAGES.login)`.
- The camera follows the `login` path (a 60 s loop of three slow moves around the plaza and the palace steps) at
  0.4 m/s at most; no cuts while the player types.
- Readability: the login window already sits on its retail panel; the backdrop gets a 20% darkening vignette as a CSS
  radial gradient on the login screen's root (below the window, above the canvas) [decision]. *(fact-check)* The
  draft's "RND-P grade's vignette parameter" does not exist: `render/post.ts` sets `imageProcessing.vignetteEnabled =
  false` and `GradeInput` has no vignette [confirmed]; turning Babylon's vignette on per stage would change the post
  shader's defines (a compile on every login ↔ world switch) and would not exist on the Classic path. CSS costs nothing
  on either.

### 5.3 Server select (`screens/servers.ts`)

- Same stage, same scene (the `useScene` kind matches) [confirmed mechanism]. The camera moves on to the path's next
  segment; picking a server does not reload anything.
- **Prefetch:** when the list arrives, the host starts fetching the select stage's manifest and nearest regions
  (stage A: `stage-cs`; stage B: the server's `world`), so select opens with little or no loading picture.

---

## 6. Screens 4–5: character select and create

### 6.1 Character select (`screens/charselect.ts`)

*(stage B only 2026-09-29: built this wave on stage B. The slot layout, the fit rule (E = 2.5 m, the bars), the 0.3 m
step forward and the fixed camera are §0B.2; the rest of §6.1 holds.)*

- **Stage:** `STAGES.select`. Up to `MAX_CHARACTER_SLOTS` = 4 [confirmed: `protocol.ts`] characters stand on
  `stage.slots(n)`: a shallow arc across the view at 1.3 m spacing, all facing the camera. Fewer characters close up
  toward the centre. *(fact-check: "fits with margin" does not hold)* The prototype placed a straight row, not an arc.
  At 3 m and a vertical 50° the half-width of the view at the row is 3 × tan 25° × aspect: **2.49 m at 16:9, 2.24 m
  at 16:10** (MacBooks), against a row edge of 1.95 m + ~0.35 m of shoulder. At 16:9 it fits with ~0.2 m to spare;
  at 16:10 the outer characters touch the frame edge [confirmed: `shots/fc_select_yaw0_16x10.jpg`]. The retail top
  and bottom bars (`min(width × 172/1600, 16% height)`, `charselect.ts`) are 173 px at 1080p, and the feet sit at
  ~960 px of 1080 [confirmed: `shots/fc_select_yaw0_high_golden_ec1_sky.jpg`], so the bottom bar covers the feet.
  **Rule [decision]:** `slots()` fits the row to the aspect: the camera distance is `max(3.0, (rowHalf + 0.45) /
  (tan(fov/2) × aspect))` and the target is lowered until head-to-feet fits between the bars; SCR-R tunes it with
  the bars drawn, and `stages.test.ts` checks the four slots project inside the frame minus the bars at 4:3, 16:10,
  16:9 and 21:9.
- **Actors:** `ModelLibrary.character(model, { equip, family, height, volume })` as today [confirmed API], registered
  with `stage.addActor`. Idle: `STAND1`.
- **Selection** (replaces the torus ring): the selected character steps forward 0.5 m (walk blend 0.4 s), plays
  `POSE` once, then `STAND3` loops [confirmed: `POSE`, `STAND3`, `EMOTION01..08`, `WAIT01..04` exist in
  `chinaman_adventurer.json`]; the others play `STAND1`. The camera eases 0.3 m toward it. Retail's exact select
  animation is [unknown]; default `POSE`.
- **UI:** unchanged retail layout (bars, live caption "Select Character", info window following the head, name tags
  on the tooltip frame, Start/Create/Delete/Back, delete dialog) [confirmed: current code]; `toScreen` projection as
  today.
- **Empty account:** the stage with no characters and the existing hint `select.empty` ("No characters yet. Click
  Create to make one.") [confirmed: `i18n/en.ts`]; Create is primary.
- **Animations** *(fact-check)*: `POSE`, `STAND3`, `WALK` pass `KEEP_CLIPS` and play through `CharacterActor.playClip`
  / `play` [confirmed: `three/models.ts`], so **this spec does not edit `models.ts`** (MOVEMENT.md §8.1 guessed it
  would [likely there]; WAVE_PLAN5 can drop that merge-order entry).
- **Keyboard:** Left/Right cycle, Enter starts (as today).

### 6.2 Character create (`screens/charcreate.ts`)

*(stage B only 2026-09-29: built this wave on stage B: the same spot and `World` as select, the camera orbits 180° to
face the plaza; the full-body and face keys and the layout check are §0B.2; the rest of §6.2 holds.)*

- **Stage:** `STAGES.create` (A: the second Constantinople spot before its gate; B: a Jangan spot).
- **Actor:** one character on the spot; the retail rotate window (rotate left, zoom, rotate right) turns the
  character (not the camera) and zooms the camera between 3.0 m and 1.6 m (face) [decision]. Height is blended over
  1 s as today.
- **The calligraphy panel** (`outer/back_image`) moves from a 3D plane to its **retail screen rect** (969, 170, 632,
  864 in the 1600×1200 space, scaled with the other outer windows), with the red bars [confirmed: resinfo].
  Decorative brushwork, not UI text: allowed by UI.md's audit [confirmed: README "English UI"].
- **Everything else** (name check, sex plates, sliders, outfit/weapon rows, explain window, the create dialog) is
  unchanged.
- Back and Create return to select on the same scene when both stages share an export (no reload).

---

## 7. Audio

*(stage B only 2026-09-29: this wave: `maintheme_cut` continues through select and create, with the town ambience under
it on the stage (§0B.5); the intro sync is deferred.)*

- **Music:** `maintheme_cut` from the intro's first shot through create (one continuous play, no restart on screen
  changes: `Music.play` of the playing track is a no-op [confirmed: `audio/music.ts` `apply()` keeps the current
  track when the URL matches]). The world switches to
  `jangan_town`/`jangan_field` as today [confirmed: `world.ts` `updateMusic`].
- **Ambience** on stages: `setArea` with the stage's area (town ambience at low volume under the music) [decision];
  off during the intro's flight.
- **UI sounds:** unchanged (kit buttons).
- **Intro sync:** the five cuts are timed to the theme's opening bars (the lane marks the beat times of the first 25 s
  once, by ear and waveform, and stores them in `intro-path.ts`) [decision].

---

## 8. UI rules (docs/UI.md)

- Every string is live English text through `t()`; new keys: `intro.begin` ("Click to begin"), `intro.skip`
  ("Press any key to skip"), `options.intro` + its three values (`select.empty` already exists and is reused,
  *(fact-check)*). No art with baked text [confirmed rule: `Art.has()` refuses `bakedText` images].
- The outer windows keep their resinfo rects and `--ui` scaling; the stage never draws UI.
- `reduceFlashing` (settings) also removes the intro's black dips (cross-dissolve instead) [decision].

---

## 9. Protocol and server (additive)

*(stage B only 2026-09-29: kept unchanged; it feeds the stage's live time and weather, lane SCR-P.)*

- `packages/shared/src/protocol.ts` `ServerInfo` gains `clock?: WorldClockState` and `weather?: WeatherSync`, the same
  types `WorldInfo` carries (`protocol.ts`, wave 9) [confirmed types exist].
- `apps/server` fills them in `ctx.serverInfo()` (`game.ts`) from the clock and weather modules [confirmed route].
- *(fact-check: three holes in the draft)*
  1. **`ctx.serverInfo()` feeds two paths:** `GET /api/servers` *and* the lobby socket's `welcome` message
     (`connection.ts`: `server: this.game.serverInfo()`) [confirmed]. So the lobby socket *will* receive the clock
     snapshot, once, in `welcome`. It still never receives the `worldClock` message, which is what H9A lens 9 and
     `world-clock.test.ts` assert (`idle.none('worldClock')`) [confirmed], so that test stays green.
  2. **The validator must not be able to break login.** `validate.ts` `serverInfo()` is strict (any bad field fails
     the whole `welcome`) [confirmed]. The new fields are parsed with the existing `optionalField` + `clockState` /
     `weatherSync` helpers, as `worldEnter` does, so a bad clock drops only the clock. Otherwise a malformed clock
     would lock every player out at server select.
  3. **`/api/servers` is not validated on the client at all:** `net/api.ts` `servers()` casts the JSON [confirmed].
     So the stages read the clock from **`app.session.server`** (the validated `welcome` copy), not from the server
     list. The server list's copy is used only to prefetch, and is ignored for the sky.
- **Server time:** the anchor is in server epoch ms. The lobby socket starts ping/pong at `welcome`
  (`session.ts` `startPing`) [confirmed], so the stage computes `clockAt(clock, session.clock.now() +
  session.clock.offset)` (`shared/world-clock.ts`, `net/clock.ts`) instead of the raw `Date.now()`. At the user's 2 h
  day, a 1 min skew would be 12 game minutes [confirmed: decisions, DAY_LENGTH_MIN 120].
- A GM `time` change while a player sits on select is not seen until the next `welcome` (reconnect) or world entry
  [decision: cosmetic, acceptable].
- The mock (`net/mock.ts` `MOCK_SERVER`) sends no clock; stages use the fixed fallback there [confirmed: code].
- No new message, no database migration, no GM command.

---

## 10. Prototype: the retail stages through the wave-9 renderer

*(stage B only 2026-09-29: the stage-B prototype that sets this wave's framings is §0B.8, `work/tmp/stage/`.)*

**What was built** (`work/tmp/screens/proto/`): a scratch page (`index.html`, `main.ts`) that loads a converted
region set through `@sro/world-render`'s `loadWorld` (PBR, modern sky, night lights), stands 1–4 player models from
`work/out/char/china/` on a spot, and places the `cameradata.txt` camera; plus a private Vite server config
(`vite.config.ts`, port 5186, reusing the viewer's config, serving `/sout/` from `work/tmp/screens/out/` and saving
shots through `/__shot`). It was started from `apps/viewer` with `--config`, used, and stopped; the shared dev servers
were not touched. Characters wear no equipment in the prototype (bodies only).

**Results** (`work/tmp/screens/overview.png`, single shots in `work/tmp/screens/shots/`), WebGL2, High, 1280×720:

| Shot | What it shows |
|---|---|
| `select_yaw0_high_golden.jpg` | Row 1 spot, heading 0, 17:00: four characters on cobbles, a castle gate arch with a portcullis and the keep behind them. A composed, symmetric backdrop [confirmed: render] |
| `select_yaw180_high_noon.jpg` | Same spot, opposite heading: an open street of timbered houses: plausible, not staged |
| `create_yaw90_high_noon.jpg` | Row 2 spot, heading 90 (file 270): one character before the same kind of gate arch, a garden rail and flowers to the right [confirmed: render] |
| `create_yaw270_high_noon.jpg` | Row 2 spot, heading 270: a tree-lined square: pleasant, less composed |
| `select_yaw0_high_dusk.jpg` | Row 1 at 19:12: moonlit blue, lamps on; faces too dark without a key light (§4.4) |
| `jangan_plaza_yaw180_golden.jpg` | Stage B: the palace steps and gate north of the plaza at 17:00 with drifting clouds; remastered textures |
| `login_r78_70_yaw270.jpg` | `camera_path.txt`'s region: grassland with headquarters pads (§1.3) |
| `fc_select_yaw0_high_golden_ec1_sky.jpg` | *(fact-check)* Row 1 at 1920×1080, filter on, sky assets present: the same gate framing. Only a strip of sky shows through the gate, so wave 10's clouds will barely show on stage A [confirmed: render] |
| `fc_select_yaw0_16x10.jpg` | *(fact-check)* The same at 1680×1050 (16:10): the outer characters touch the frame edges (§6.1) |

**Findings for the build** [confirmed: prototype]:

1. The renderer needs `world.update(camera, focus)` every frame, or the stage shows only the sky (`update` adopts the
   camera for the post stack; `attachCamera` is for switching cameras).
2. ~~The default active-mesh filter (`enabledCandidates`) left the draw list empty~~ *(fact-check: not reproduced;
   with the filter on the stage draws the same 426 draws and is cheaper, §4.3)*. The first pass's benches ran with it
   off.
2a. *(fact-check)* **The first pass ran without the sky assets.** The prototype serves `/sout/` from
   `work/tmp/screens/out/`, and the sky loads `sky.json`, the cloud noise and the moon from `../../sky` relative to the
   world folder, which was not there: `proto/vite.log` has 6× `[sky] assets: Error: sky.json: HTTP 404` [confirmed].
   So the stage-A shots and benches had no cloud noise (no clouds, no cloud shadows) and no moon. The fact-check pass
   copied `work/out/sky` (0.9 MB) to `work/tmp/screens/out/sky` and re-ran; the production `stage-cs` sits under
   `/out-opt/world/` next to `sky/`, so it is unaffected [confirmed: `sky-system.ts` `skyAssets()`].
2b. *(fact-check)* **Canvas size.** In the hidden pane the canvas is 300×150 unless the viewport is emulated
   [confirmed: the fact-check pass read `canvas.width/height` = 300×150 before `resize_window`]. The first pass's
   bench JSONs do not record a size, so its "1920×1080" is [unknown]; the fact-check runs set 1920×1080 explicitly.
3. A hidden browser pane stops `requestAnimationFrame`; the prototype's timer pump (render on `setTimeout`) and a
   `toDataURL` right after `scene.render()` in the same task are what made shots and benches possible. The game does
   not need this; LAB-S's shot button does.
4. The retail spots load fast: 16 regions, 180 models, 1,810 placements in the scratch export; the page was ready in
   8–12 s from a cold cache on localhost [confirmed: status timestamps].

---

## 11. Presets and budgets (1080p unless noted)

*(stage B only 2026-09-29: stage B re-measured with the default active-mesh filter on, the game's own graphics link
and dressed characters: §0B.9. The stage-A and intro rows below are kept for the deferred work.)*

**Measured** on the dev PC (Ryzen 5 9600X + RX 9060 XT, Chrome's built-in pane, hidden), GPU lock held
(`work/tools/gpu.lock`), 400 frames after an 8 s settle, weather `off`, stage A = `screens-cs` (16 regions, not yet
trimmed), 4 unequipped characters. **CPU** = wall time of `scene.render()` p50 / p95. Frame times are **not**
reported: the hidden pane clamps the timer pump to ~15 ms per frame [confirmed: every run 13.7–15.9 ms p50]. No GPU
timestamps were taken; GPU numbers are projected from `work/tmp/w9-finish/budgets.md` and WAVE_PLAN3 §5.2.

*(fact-check)* Two sets. **Pass 1** (the author): filter off, sky assets missing (§10 2a), canvas size unknown (§10
2b). **Pass 2** (the fact-check, JSONs `work/tmp/screens/shots/fc_*.json`): 1920×1080 emulated and read back, sky
assets present, 17:00. Single runs vary 2–3× (WebGPU High filter off: 9.6 / 16.4 then 3.7 / 4.8 ms on the next run),
so no single number below is a budget pass; lanes use the min of 5.

| Preset | Stage | API | CPU p50 / p95 (ms), pass 2, filter **on** | pass 2, filter off | pass 1, filter off | draws | GPU dev [projected] | mid laptop / Mac, CPU × 1.5–2 [projected] |
|---|---|---|---|---|---|---|---|---|
| Low (Classic) | A select | WebGL2 | — | — | 3.6 / 4.7 | 103 | ≈ 0.5 ms (world Low 0.46) | 7–9 ms p95 |
| Medium | A select | WebGL2 | — | 2.8 / 4.9 | 3.8 / 6.1 | 192 | ≈ 1.5 ms (world Medium 1.5–1.7) | 7–12 ms (filter off) |
| Medium | A select | WebGPU | **2.7 / 4.1** | 6.8 / 10.0; 6.1 / 8.7 | 8.2 / 15.1 | 192 | ≈ 1.5 ms | 6–8 ms (filter on) |
| High | A select | WebGL2 | **3.3 / 4.5** | 4.2 / 6.6 | 5.4 / 8.5 | 426 | ≈ 2.3–4.3 ms (world High, SSR off) | 7–9 ms (filter on) |
| High | A select | WebGPU | — | 9.6 / 16.4; 3.7 / 4.8 | 8.8 / 10.5 | 426 | ≈ 2.3–4.3 ms | [unknown]: re-measure with the filter on |
| Medium | B select (Jangan steps) | WebGL2 | — | — | 6.2 / 8.5 | 193 | ≈ 1.5 ms | 13–17 ms (filter off) |
| High | B select | WebGL2 | — | — | 7.1 / 8.3 | 344 | ≈ 2.3–4.3 ms | 12–17 ms |
| High | B select | WebGPU | — | — | 9.6 / 11.8 | 344 | ≈ 2.3–4.3 ms | 18–24 ms |
| Medium | intro/login shots (not built) | both | ceiling = world plaza Medium 9.5 / 11.2 (WebGPU, 450 draws); world gate 6.3 / 7.6 (295 draws) | | | ≤ 300 (budget) | ≤ 2 ms | see below |

Add to every row for weather on the character screens (server rain at half intensity): **+0.5–1.2 ms GPU on a mid
GPU at Medium** (WAVE_PLAN3 §5.2 weather column) [projected], and wave 10's volumetric clouds, ≈ +0.3 ms GPU at High
(SKY2.md, its per-preset cost table) [projected], of which stage A shows only a strip through the gate.

What it means, honestly:

- **Stage A is inside the 60 fps budget on the dev PC on every preset and API** [confirmed CPU, pass 2 with the
  filter on: worst p95 4.5 ms; projected frame]. Pass 1's worst p95 (15.1 ms, WebGPU Medium) was a filter-off single
  run; pass 2 did not reproduce it (8.7–10.0 off, 4.1 on).
- **Stage B is not yet shown to fit on laptops**: it was only measured with the filter off (8.3–11.8 ms p95), which
  at ×1.5–2 is 12–24 ms. It is re-measured with the filter on in SCR-R before it can be the fallback on WebGPU.
- **WebGPU vs WebGL2 per draw:** the wave-9 gate measured WebGPU ≈ 1.2–1.4× WebGL2's CPU for similar draws (High
  crowd 18.8 vs 13.5 ms; Medium plaza 9.5 ms / 450 draws vs 10.0 ms / 570 draws) [confirmed: budgets.md].
  *(fact-check)* Pass 1's "1.6–2×, the same as the gate" over-stated it; the stage runs are too noisy to add a ratio.
- **WebGPU is the target path** (friends on HTTPS via Tailscale, DEPLOY.md), WebGL2 is today's and the fallback; so
  every budget below holds on both APIs *(fact-check: the draft budgeted WebGPU only at High)*.
- **The intro is the watch item** *(fact-check: the draft's ceiling missed 60 fps on laptops)*. The world's plaza
  view at Medium is 11.2 ms p95 on the dev PC with 450 draws, i.e. 17–22 ms on a mid laptop. The first-run preset is
  Medium for every adapter class, so a flight with that many draws would miss 60 fps for most friends. Shots are held
  to **≤ 300 draws at Medium** (≈ the gate view: 7.6 ms p95, 11–15 ms on a laptop) **and ≤ 450 at High**, else the
  shot is re-framed or its draw distance lowered (the stage passes `quality` overrides for the flight only).
- **Download** [projected]: stage A adds ~20–30 MB once at r = 150 m (§4.2; the draft's 15–25 MB assumed a trim that
  r = 250 m cannot give); stage B and the intro add nothing the world does not download anyway, but the intro needs
  the town's regions (≈ 50–80 MB) **before** shot 1 on a first visit (§5.1 item 6) [unknown upload speed of the mini
  PC, WAVE_PLAN3 §8 item 11].

Per-lane budgets (dev PC, 1920×1080 set explicitly, sky assets present, the default active-mesh filter on; each lane
measures the min of 5 runs with the GPU lock, on **both** APIs unless noted):

| Lane | Budget |
|---|---|
| SCR-R | a stage with 4 equipped characters, weather `off` and at half rain: CPU p95 **≤ 7 ms at Medium** (≈ 14 ms on a mid laptop) and **≤ 9 ms at High** (WebGL2) / **≤ 10 ms** (WebGPU); stage B must meet the same or use Medium's draw distance on the stage; enter() of a cached stage ≤ 1.5 s |
| SCR-I | every intro shot **≤ 300 draws Medium / 450 High** and CPU p95 ≤ 8 ms at Medium; no frame > 50 ms after the logo beat (no compile hitch); total intro GPU ≤ world plaza |
| SCR-L | login drift adds ≤ 0.2 ms CPU over a static camera; server select reuses the scene (0 loads) |
| SCR-SEL / SCR-CRE | swapping a slot's character or outfit ≤ 1 frame > 33 ms; create turntable at 60 fps |
| SCR-X | stage A pack **≤ 30 MB** out-opt (r = 150 m; if over, r = 120 m); convert ≤ 30 s |
| Whole | the outer screens hold 60 fps p95 at the machine's first-run preset; world → select → world three times: on WebGL2 the JS heap grows ≤ 10 MB and the GPU texture count returns to baseline; on WebGPU the heap may keep **one** stage `World` (LEAK-2, §4.3) but grows ≤ 10 MB between the 2nd and 3rd round trip |

---

## 12. Lanes

*(stage B only 2026-09-29: this wave's lanes are §0B.10: SCR-P, SCR-S (reduced), SCR-R, SCR-SEL, SCR-CRE, I-SCR,
H-SCR. SCR-X, SCR-E, SCR-I and SCR-L are deferred.)*

Lane ids use the prefix `SCR-`; WAVE_PLAN5 may renumber them and merges the seams with MOVEMENT's and PETS_SOCIAL's.

### 12.1 Lane table

| Id | Step | What | Owns (new files unless marked "edit") |
|---|---|---|---|
| SCR-P | 0 | `ServerInfo.clock/weather`, validators, server fill | edit `packages/shared/src/protocol.ts` (the `ServerInfo` interface only), edit `packages/shared/src/validate.ts` (its `ServerInfo` check), edit `apps/server/src/game.ts` `serverInfo()` (which also feeds `welcome`); the validator parses the two fields through `optionalField` *(fact-check)*; tests `packages/shared/test/server-info.test.ts`, `apps/server/test/servers-clock.test.ts` |
| SCR-S | 0 | client seams | edit `apps/game/src/app.ts` (`ScreenParams.intro`, `App.stage: StageHost` field), edit `main.ts` (register `intro`, drop `splash`), edit `params.ts` (`skipIntro` = today's `skipSplash`), edit `i18n/en.ts` (the §8 keys), edit `settings.ts` (`ui.intro` + `ui.introSeen`, sanitised like `ui.reduceFlashing`; *(fact-check)*: the section is `ui`, and `registerOptionRow` lives in `hud/options.ts`, called by SCR-I), new `stage/types.ts` (`StageDef`, `StageHost`, `Stage` interfaces, §4), a stub `stage/host.ts` that throws "not built"; test `seams-screens.test.ts` |
| SCR-X | 0 | stage A export | edit `packages/convert/src/world/convert-world.ts` (`WORLD_PRESETS['stage-cs']`), edit `packages/convert/src/cli.ts` (`--keep-within`), new `packages/convert/src/world/keep-within.ts`; edit `deploy/` world include list; test `packages/convert/test/keep-within.test.ts`; the data run `pnpm sro convert-region --preset stage-cs --keep-within ...` + `optimize-out` |
| SCR-R | 1 | stage runtime | `apps/game/src/stage/{host.ts, stages.ts, camera-path.ts, slots.ts, key-light.ts}`; tests `stage-host.test.ts`, `stages.test.ts`, `camera-path.test.ts` |
| SCR-E | 1 | LAB-S (the stage editor; "LAB-S" elsewhere in this spec means this lane) | `apps/viewer/src/world/stage-editor.ts` (new), edit `apps/viewer/src/world/main.ts` (one `?stage=` hook), `apps/viewer/world.html` (one panel slot) |
| SCR-I | 2 | intro | `apps/game/src/screens/intro.ts` (replaces `splash.ts`, which is deleted), `apps/game/src/stage/intro-path.ts`; test `intro.test.ts` |
| SCR-L | 2 | login + server select backdrop | edit `screens/login.ts`, `screens/servers.ts` (backdrop calls only); delete `screens/title.ts` |
| SCR-SEL | 2 | character select on the stage | edit `screens/charselect.ts` (drops the release's `StudioEnvironment` call on the stage path) |
| SCR-CRE | 2 | character create on the stage | edit `screens/charcreate.ts` (stage, turntable, the 2D back-image panel; drops `StudioEnvironment`), CSS in `style.css` for `.create-backimage` only |
| I-SCR | 3 | integration | `three/backdrop.ts` (delete all but `newScene`), `three/studio-env.ts` + `studio-env.test.ts` (delete if unused after SCR-SEL/CRE), `apps/game/README.md` (correct the backdrop investigation), docs (ASSETS.md `stage-cs`, DEPLOY.md, PLAYTEST.md checks, BACKLOG item 8 → done) |
| H-SCR | 3 | adversarial hunt | tests only (§12.7) |

### 12.2 Seams (SCR-S builds them first; after it, no lane edits `app.ts`, `main.ts`, `params.ts`, `en.ts`, `settings.ts`)

- `app.stage: StageHost` (a stub until SCR-R lands; screens call only the interface in `stage/types.ts`).
- `ScreenParams.intro: { replay?: boolean } | undefined`; `main.ts` goes to `intro` unless `params.skipIntro`.
- The `ui.intro` setting (`'first' | 'always' | 'never'`, default `'first'`) and its `ui.introSeen` flag inside the
  same settings record *(fact-check: was `interface.intro`)*.
- All new i18n keys, so SCR-I/SCR-SEL/SCR-CRE only read them.
- WAVE_PLAN5 note: MOVEMENT and PETS_SOCIAL also add to `app.ts`, `en.ts`, `settings.ts` and `protocol.ts`; one wave-11
  seams agent should do all three specs' seams in one pass. This spec does **not** edit `three/models.ts` (§6.1).
- *(fact-check)* **Collision with the wave-9 release in flight:** it is editing `settings.ts`, `screens/charselect.ts`,
  `screens/charcreate.ts`, `three/backdrop.ts` and adding `three/studio-env.ts` right now [confirmed: `git status`].
  SCR-S, SCR-SEL, SCR-CRE and I-SCR start only after the release is committed, and re-read those files then; the
  line references in this spec are to HEAD `85e2e14`.
- *(fact-check)* **Collision with wave 10:** the coast's CST-C edits `packages/convert/src/world/convert-world.ts`
  (`WORLD_PRESETS`) and `cli.ts`, the same files as SCR-X [confirmed: COAST.md §5.4, lane table]. Waves run in
  order, so SCR-X rebases on wave 10's converter.

### 12.3 Step order and concurrency

- **Step 0** (parallel): SCR-P, SCR-S, SCR-X. SCR-X is data plus one converter flag; it can run any time before SCR-SEL's
  in-game check.
- **Step 1** (parallel, after SCR-S): SCR-R, SCR-E. SCR-E authors the Jangan keys **after wave 10's `jangan-fields`
  re-export** (coast, trees) is in `out-opt` (§12.10).
- **Step 2** (parallel, after SCR-R): SCR-I, SCR-L, SCR-SEL, SCR-CRE (disjoint files).
- **Step 3:** I-SCR, H-SCR.

### 12.4 Dependencies

| Needs | From | If missing |
|---|---|---|
| wave-9 renderer (`loadWorld` render/sky/weather options, `attachNightLights`, `render.addCharacter`, `warmup.ts`) | shipped [confirmed] | — |
| wave 10 `jangan-fields` re-export (coast, sea level +5 m, new tree models) | docs/COAST.md, docs/TREES.md (*(fact-check)* not written yet at this check [confirmed: `ls docs`]; BACKLOG lists it for wave 10) | author intro/login/B keys on today's export; re-author after wave 10 (the test flags keys under ground) |
| wave 10 sky upgrade (volumetric clouds, cloud shadows, auto exposure, haze) | docs/SKY2.md | the intro uses today's sky; auto exposure makes the golden-hour shots easier to balance |
| `ServerInfo.clock/weather` | SCR-P | stages use their fixed fallback time and clear weather |
| stage A pack | SCR-X | select/create use stage B (scope cut 6) |
| MOVEMENT (jump/roll) | docs/MOVEMENT.md | none; later the select POSE could use a new Blender-made animation |
| PETS_SOCIAL | docs/PETS_SOCIAL.md | none; later a character's pickup pet could stand beside it on select (not in this wave) |

### 12.5 Contracts between lanes

- Screens never call `loadWorld` or create a `Scene`; only `app.stage.enter()`.
- The host is the only place that decides render path/preset (from `effectiveGraphics()`), so the Low guard covers all
  outer screens at once.
- `stages.ts` is data; changing a camera needs no code change. SCR-E's editor exports exactly `StageDef` JSON.

### 12.6 Tests

| Test | Lane | Checks |
|---|---|---|
| `server-info.test.ts` | SCR-P | `ServerInfo` with/without `clock`/`weather` round-trips; out-of-range values rejected; older payloads accepted |
| `servers-clock.test.ts` | SCR-P | `/api/servers` and `welcome.server` carry the running clock anchor and weather; lobby sockets still get no `worldClock` message; a malformed `clock` in `welcome` drops only the clock and the login still succeeds |
| `seams-screens.test.ts` | SCR-S | `intro` registered, `skip=1`/`auto=1` go to login, the setting's three values, the seen flag |
| `keep-within.test.ts` | SCR-X | deterministic output; placements beyond r dropped; neighbour-owned overhangs kept when inside r; nav instances follow |
| `stage-host.test.ts` | SCR-R | headless `WorldIO` fixture: `enter` twice with the same export reuses the `World`; a different export disposes the old one (no mesh, texture or observer left); `update` called before the first render; the active-mesh list is non-empty after `enter` with the default filter on; Low loads the Classic path; `runFirstRun` ran before the first `enter` |
| `stages.test.ts` | SCR-R | every `StageDef` resolves: export listed, spot on the nav within 0.5 m of `yHint`, 4 slots on walkable nav, the camera 0.5 m+ above terrain and not inside an object's navmesh, heading/fov in range, the stage A headings equal the file yaws converted (0 → 0, 270 → π/2) |
| `camera-path.test.ts` | SCR-R | Catmull-Rom through keys, monotone time, loop continuity, no NaN, the path stays ≥ 2 m above terrain sampled every 0.1 s |
| `intro.test.ts` | SCR-I | fake timers: the logo beat waits for the click and the stage; skip jumps to login; `first` plays once; the fallback after 10 s; music starts once and is not restarted by login |
| existing `abuse-w9f-leaks.test.ts` pattern | H-SCR | world → select → world ×3: scene count, `World.disposed`, engine textures back to baseline |
| existing i18n/`bakedText` tests | all | no new baked-text art; every new key in `en.ts` |
| `pnpm typecheck` + the whole suite green at each hand-off; the Low guard (`seams-classic.test.ts`) green after every merge | all | |

### 12.7 H-SCR lenses

1. **Black or sky-only stage** on any preset × API (the §10 finding), including `?gpuLimits=default`.
2. **Hitches:** shader compiles after the logo beat; a new define when the clock moves; a stage switch that compiles
   the world's materials twice.
3. **Leaks:** world → select → create → select → world ×3 (the carried-over memory-growth item); the stage `World`,
   night lights, key light, post pipelines, actors, observers.
4. **Flow edge cases:** intro skipped mid-load; logout from select; session expiry on create; a server without
   `clock`; mock mode; the browser tab hidden during the intro (resume, no double music).
5. **Readability:** names, info window and buttons over the brightest and darkest stage times; `reduceFlashing`.
6. **Low / WebGL2 / Safari:** Low shows the Classic path; WebGL2 sampler counts on stages; Safari WebGPU and WebGL2 on
   an Apple Silicon Mac (a friend).
7. **Downloads:** stage A fetched only once; stage B fetches nothing the world does not fetch later.

### 12.8 User checks (after I-SCR; screenshots and a short screen recording from the user's own browser)

1. Clear the site data, open the game: black with the wordmark and "Click to begin"; click: the flight over Jangan at
   golden hour with the main theme; no stutter.
2. Reload: the intro does not play again (first-time rule); Options → Interface → "Play the intro: Always" brings it
   back; any key skips it.
3. Login and server select: the city drifts slowly behind the form; the form reads well.
4. Character select: your characters in their gear before the castle gate (A) or the palace steps (B); click one: it
   steps forward and poses; the sky matches the time and weather in the game.
5. Create: the turntable, the zoom to the face, the calligraphy panel on the right, the red bars.
6. Start: the world loads (note the seconds; compare with before).
7. Graphics on Low: every outer screen still works, in the Classic look.
8. A friend on a Mac (Safari) and one on a laptop run through 1–6 with the fps overlay.

### 12.9 I-SCR checklist

1. Merge step 0; suite; record the test count. 2. Merge SCR-R, SCR-E; suite; Low guard. 3. Merge step 2 in the order
SCR-L, SCR-SEL, SCR-CRE, SCR-I. 4. Data: `stage-cs` export + `optimize-out`; check its size against §11.
5. Two clients (WebGPU, `?engine=webgl`) through the whole flow with the dev server; `/time 18:30` then select: the
stage sky follows. 6. Budgets (§11) with the GPU lock; any miss goes to §13. 7. Docs: README backdrop section,
ASSETS.md, DEPLOY.md, PLAYTEST.md user checks, BACKLOG item 8 done. 8. Delete `work/tmp/screens/out/` (132 MB [confirmed: `du`, fact-check; the draft said 178] of
scratch conversions) after SCR-X ships the real export.

### 12.10 Wave-10 hand-offs

- SCR-E re-checks every Jangan key after wave 10's re-export: the coast raises the south strip into a beach and
  changes the sea level; the intro's shot 5 is framed to show the bay.
- The intro's shot 1 frames the new tree models (TREES.md); if the trees slip, the shot uses today's trees.

---

## 13. Scope-cut order (cut from the top)

*(stage B only 2026-09-29: this wave's order is §0B.11.)*

1. Server clock and weather on the character stages (fixed 17:00, clear) and SCR-P.
2. The selected character's step-forward and `POSE` (the ring from today stays).
3. Intro shots 1 and 2 (the flight starts at the gate: 14 s).
4. LAB-S editor (keys typed by hand from the viewer's camera readout).
5. The face key light (stage times clamped to 08:00–17:30 instead).
6. **Stage A (the retail Constantinople spots) → stage B for select and create** (no new export, no download).
7. The intro flight → the logo beat plus the login drift only (still the real Jangan through the wave-9 renderer).
8. The create stage → create on the select stage's spot.

**Never cut:** the placeholder plaza is gone from every outer screen (the user's actual complaint); real game scenery
through the wave-9 renderer on the preset the player chose; the Low path; the English live-text UI and the retail
layouts; skip for the intro; the leak and disposal tests.

---

## 14. Risks

- **The retail reading is inferred** [likely, not confirmed]: without `sro_client.exe` the meaning of
  `cameradata.txt` (and that retail select was in Constantinople) rests on the data and the renders. The user's
  memory settles it (§15 item 1).
- **A European city behind Chinese characters** in a Jangan-only game may feel off; stage B is always there.
- **WebGPU CPU per draw** makes High stages ~9–12 ms CPU on the dev PC; laptops on High may dip on the intro. The
  intro's per-shot draw budget and Medium's first-run default contain it.
- **First-visit download:** the intro needs Jangan's nearest regions before it can play; on a slow link the logo beat
  lasts longer (its fallback keeps the music and goes to login).
- **Wave-10 churn:** camera keys authored too early end up under the new beach or inside new trees; the tests catch it,
  the re-authoring costs an SCR-E session.
- **Audio autoplay:** the click-to-begin gate is required; a browser that already allows autoplay still shows it (one
  click), by design.
- **The active-mesh filter finding** (§10) did not reproduce in the fact-check pass; SCR-R's test and H-SCR lens 1
  still check for an empty draw list after a scene swap, and report to the perf lane if it ever reproduces in the world.
- *(fact-check)* **WebGPU Effect retention (W9F LEAK-2):** on WebGPU the engine's cached Effects keep the scene and
  `World` that first compiled them (`render/babylon-fixes.ts`), so the first stage `World` may live for the page's
  life [likely]. The heap budget (§11) allows one retained World on WebGPU; lens 3 measures it. If it is large, the
  fix belongs to the perf lane (BACKLOG item 9), not to this spec.
- *(fact-check)* **Framing:** the retail camera (3 m, 50°) is tight for four characters; at 16:10 the row touches the
  edges and the retail bars cover the feet (§6.1). The slot rule fits the row to the aspect.
- *(fact-check)* **The first-run check runs too late** today (on world entry). Without the §4.3 change the intro
  would render the first visit at the stored default before the device check.

---

## 15. Needs from the user (each has a default, so nobody waits)

*(stage B only 2026-09-29: item 1 is answered (B); items 2 and 3 are deferred with the intro; items 4 and 5 keep their
defaults and are restated for this wave in §0B.13.)*

1. **Stage for character select and create** (look at `work/tmp/screens/overview.png`): **A** = the retail spots in
   Constantinople (the castle gate; ~20–30 MB more on first visit [projected], *(fact-check: was 15–25)*) or **B** = Jangan (the palace steps; no download,
   remastered textures). And: **do you remember retail character select showing a stone castle gate behind the
   characters?** A yes confirms the reading. **Default: A**, as asked; B if you prefer Jangan or the download.
2. **The intro:** a 25-second real-time flight over Jangan at golden hour with the main theme, skippable, **first visit
   only** (default), or longer / always / never. A pre-made video is possible but not recommended (a big file, and it
   would not show the live sky or the new trees). The first visit downloads ≈ 50–80 MB of the town before the flight
   can start (§5.1 item 6) [projected]; until then the logo and the music stay up.
3. **Intro captions:** **none** (default), or 2–3 short English lore lines you write or approve.
4. **Time on the character screens:** **the server's live time and weather, clamped to dusk at night** (default), or
   always golden hour.
5. **Music:** **`maintheme_cut` on every outer screen** (default, as retail), or `jangan_town` on character select.
6. **Nothing to download, buy or upload.** No Meshy, Higgsfield or Blender work is needed for this spec.

## 16. Open questions (each has a default)

*(stage B only 2026-09-29: this wave's open questions are §0B.14; 1, 2 and 4 below concern the dropped stage A.)*

1. **What the `cameradata.txt` yaw measures** [unknown]. Default: the frames that show the gate arch (file 0 → heading
   0, file 270 → heading π/2; consistent with the file yaw being the camera's look heading plus the z flip, §1.4),
   pinned by `stages.test.ts`.
2. **What `camera_path.txt` was for** [unknown]. Default: ignored.
3. **Retail's slot layout and select animation** [unknown]. Default: a 1.3 m arc of four at 3 m and 50°; the selected
   one steps forward and plays `POSE`; the camera distance and target fit the row to the window's aspect and the
   retail bars (§6.1).
4. **The first header line `-1` of `cameradata.txt`** [unknown]. Default: ignored.
5. **Hand the stage `World` to the world screen** to skip a load? Default: no in this wave (§4.6); a BACKLOG item 9
   candidate.
6. **Active-mesh filter on stages** *(fact-check: the empty list did not reproduce, §4.3)*. Default: keep the
   renderer's default filter on (it measured cheaper); `enabledCandidates: false` only if SCR-R's test ever sees an
   empty list.
7. **European characters on select** (retail showed both races) — Default: no; the game is Chinese only
   (docs/BACKLOG, the user's scope).
8. **Replay the intro from the login screen** (a small link in the bottom bar)? Default: no; Options only.
9. **The user's "New 3D models for TREE'S only for time being"** belongs to wave 10 (BACKLOG "Next"; docs/TREES.md is
   not written yet at this check). This spec only depends on it: intro shot 1 and stage B should frame the new trees.
   Default: author those camera keys after wave 10's `jangan-fields` re-export, using today's trees if it slips
   (§12.10).
