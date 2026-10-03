# Backlog

The queue of what comes after the work in progress, in order. Each big item gets its own design doc and wave plan when
it starts. The user's decisions live in `work/tmp/w9-user-decisions.md` and the wave plans.

## Standing goal: at least 60 fps (the user, 2026-09-28)

Every wave keeps to its frame budget (WAVE_PLAN3 §5.2: High under 16.7 ms on the dev PC, the watchdog, the scope-cut
lists). New visual features are measured before they are kept. Item 9 below is the dedicated performance pass once
everything else is done.

## Standing rule: every wave adds its places to the GM teleport list (the user, 2026-10-02)

A wave that adds somewhere worth visiting (a town spot, a beach, a camp, a dungeon door, a new field) adds a row to
`content/places.json` in the same wave: a kebab-case name, its group (town, fields, coast, bosses or other) and the
spot, either hand-picked x/y/z or a `snap` the places tool computes (`pnpm --filter @sro/server places --write`). The
tool and `apps/server/test/places.test.ts` check every row on the real export; the server logs and skips a place that
does not stand on open ground reachable from town. The list is in docs/PLAYTEST.md §7 "Teleport places".

## Wave 10 (redefined), built 2026-09-30/10-01 (docs/WAVE_PLAN6.md)

Built and integrated, waiting for the user's own test and the deploy OK:
- region batching on the PBR presets (BATCHING; the user's item 1), with static tree variants and batched shadows;
- a beach in front of every sea shore, the FFT ocean, the shore foam, the walkable south beach (COAST, beaches
  revision; item 4 above);
- our own grass, flowers and wildlife (GRASS_LIFE);
- the jump on Space (MOVEMENT, jump only; item 5's first half);
- character select and create on the Jangan palace steps (SCREENS §0B; item 8's first part).

**Deferred from wave 10 and back in the queue** (WAVE_PLAN6 §11): the sky upgrade (SKY2, item 3), the new tree models
(TREES), the intro and the login scene (SCREENS SCR-I, SCR-L, stage A, the stage editor), the dodge roll (MOVEMENT's
appendix), pets, friends and mail (PETS_SOCIAL), the remaining 9B texture batches (on hold), the character draw cost
(item 9's follow-up: animation LOD, skinning, character batching), WebGPU snapshot rendering (BATCHING §3.11),
production asset versioning, and the two optional lanes cut this wave: the Classic batch (BT-K) and MV-L.

## Wave 11, built 2026-10-01 (docs/WAVE_PLAN7.md)

Built and integrated, waiting for the user's own test and the deploy OK:
- Tiger Girl as a retail-style world boss on her Blue Tiger (docs/UNIQUES.md): the ridden composite, one alive at a
  time at 11 camps with persisted 3–6 h timers (migration 10, `UNIQUES`), the appear and defeat banners with sound and
  chat lines, her fight (summons, enrage, fury, leash), the unique loot, `/unique`, the rumour lines;
- a living Jangan (docs/TOWN_LIFE.md): the VAT townsfolk and animals on a shared deterministic schedule, cloth in the
  wind, smoke, steam and leaves, the town's sound, the lanterns, the dressing (props, crack grass, decals, the pond);
- the far grass remainder (GRASS_FAR GF-R) and the polish pass's higher jump.

**Deferred from wave 11 and back in the queue** (WAVE_PLAN7 §11): fishing, swimming and underwater (wave 12); the sky
upgrade (SKY2), new tree models, the intro and login scene, the dodge roll, pets / friends / mail, the 9B texture
batches beyond B2, WebGPU snapshot rendering, production asset versioning, the Classic batch (BT-K), MV-L; other
uniques, a world-map boss marker, crowd impostors, townsfolk as server entities, a blade-scale normal for the far grass
carpet; and character batching and animation LOD for 20 players (item 9: the only fix for the 20-player misses).

## Wave 12, built 2026-10-02 (docs/WAVE_PLAN8.md)

Built and integrated, waiting for the user's own test and the deploy OK:
- **the World Editor** (docs/WORLD_EDITOR.md, guide: docs/EDITOR_GUIDE.md): `pnpm editor` / the desktop shortcut on
  this PC only; raise, lower, smooth, flatten and noise brushes, texture paint with the 108 remastered tiles, grass
  painting, place / move / turn / resize / delete from the library with ground snap (the 35 new trees included), the
  town's routes and seats, undo / redo / revert one / revert a region, Save, a Publish that rebuilds the walking map and
  stops on traps or lost reachability, Test in game, and the assets-only Deploy on the user's click;
- **every terrain tile upscaled** (docs/TERRAIN_TEX.md): 108 sets with the painterly ground rule, 63 hero tiles,
  Medium's detail layer and anti-tiling;
- **every tree and plant family replaced** (docs/TREES.md Part W): 35 species for 106 retail tree and plant models
  (4,856 placements; after the hunt the brushwood clumps 05/06, c_swamp_tree03 and the tre_gagi01 log stay retail
  because no species fits their walking footprint), every foliage sprite upscaled, Options → Graphics → Trees: New /
  Retail; Low keeps the retail trees. **Open before the release (G5):** the crowns on the production path are brighter
  than retail (H12-TRL-2, measured in the hunt's in-game lab: pine 1.51×, willow 1.30×, maple 1.20×, shrub 1.92×; the
  gate is ±10 %; the lever is the direct sunlight on the up-facing leaf cards, i.e. the species' card-normal rule /
  back-card dimming, re-tuned on that lab rather than the kit route), and T12-B's six kit-route misses (the dry bush
  near; the far tier of broad01, swamp_b, dh_poplar, dh_brush and the Dunhuang stump). One tuning round for all.
- **Small leftovers from the wave-12 hunt:** Publish's own sea / shore / tomb-keep / corridor backstop after the edits
  pass (H12-PS-4; the editor clamps the brush, the walking checks still stop traps); the editor's Save does not check
  scale classes (NT4; the converter refuses the layers at Publish, which now stops); a process killed between Save's
  renames leaves hidden `.bak` files and relies on the editor's journal-reset prompt (DL-5).

**Deferred from wave 12 and back in the queue** (WAVE_PLAN8 §11): fishing (+ cooking), swimming and underwater (wave
13; the tiles under new water deeper than 1.2 m open when swimming lands); KTX2 terrain arrays (TT-K); a terrain
macro-variation layer and a sub-2 m detail splat; a world-wide object-shadow re-bake with the new trees; retail tiles
outside the 108; editing from a friend's PC; tilt for placements; scaled nav footprints; impostors; a hero remake of
the 5 unique town trees; SDXL variety sprites; the editor's Water, Lights and Sound tools (dimmed: a later step; Walkable
is built). Still queued from waves 10–11:
the sky upgrade (SKY2), the intro and login scene, the dodge roll, pets / friends / mail, the 9B texture batches for
NPCs, mobs, armour and weapons, WebGPU snapshot rendering, production asset versioning, the Classic batch (BT-K),
MV-L, other uniques, and character batching and animation LOD for 20 players (item 9).

## In progress (2026-09-28)

1. **Wave 9A, the engine** (docs/WAVE_PLAN3.md §6): PBR materials, shadows, sky and day/night, night lights, weather
   with wet surfaces, post. Steps 1–2 are building, then:
   - an opt-in preview deploy (Options → Graphics → "Modern graphics (preview)");
   - I9A integration and the 15-lens hunt;
   - the full release (built 2026-09-29, the user's "Default Medium, High optional": `RENDER_ROLLOUT = 'on'`, Medium
     on first run everywhere, High and Ultra in Options).
2. **Wave 9B, textures** (WAVE_PLAN3 §7): B0 is approved as a direction. After that come:
   - the B0 tuning and B1 hero batch;
   - TX-R, the runtime loader;
   - the in-game go/no-go;
   - B2 town, then B3 fields;
   - B4 actors (local vs Meshy per part; Meshy credits wait for the SDXL bake-off, work/tmp/detail/bakeoff/).

## Next (user-confirmed order, 2026-09-29)

- **Wave 10, "sky and sea" + new trees:**
  - the Tidewater-style sky upgrade (item 3);
  - the coast (item 4);
  - NEW 3D MODELS FOR TREES ONLY for now (the user: "New 3D models for TREE'S only for time being"; buildings stay retail).
  - With the sky upgrade's IBL: the world's sky cube is read as sRGB (world-render lighting.ts `WORLD_SKY_CUBE_DECODE`,
    Babylon's default for a raw cube), which darkens its reflections well below "a mirror shows the dome" when the sky
    is dim. Moving it to `'linear'` (as the character screens' studio cube already is) brightens the water's sky
    reflection, metals and the Fresnel sheen: a look pass with before/after shots for the user, not a silent fix.
  - Design: docs/SKY2.md, the refreshed docs/COAST.md, docs/TREES.md, then docs/WAVE_PLAN4.md.
- **Wave 11, "gameplay and screens":**
  - jump and dodge roll (item 5);
  - the intro, login and character screens (item 8);
  - the pickup pet, attack pets, a friends list and mail (new).
  - Design: docs/MOVEMENT.md, docs/SCREENS.md, docs/PETS_SOCIAL.md, then docs/WAVE_PLAN5.md.
- Alongside, as time allows: High to a solid 60 fps (item 9, the CPU draw cost), and the remaining texture batches (B2 town, B3 fields, B4 NPCs/mobs/armour/weapons, Ultra KTX2), run on the GPU when it's free.

## Next

3. **Sky upgrade (after 9A)**, inspired by Tidewater (github.com/dgreenheck/tidewater, MIT; notes in
   `work/tmp/tidewater-notes.md`):
   - volumetric clouds with cloud shadows (High/Ultra);
   - sky-coloured aerial haze with sun shafts;
   - time-sliced GPU IBL prefilter (answers D14);
   - auto exposure;
   - ground bounce light;
   - contact shadows and GTAO.
4. **Wave 10, the coast** (docs/COAST.md): Option A (a land bridge west to Donwhang), sea level +5 m (Jangan Bay), a
   walkable south beach. It starts after 9A is integrated, alongside the 9B batches: east, south and north-east
   first, then the west. It uses the Tidewater-style FFT ocean and shore foam, and the Blender round trip for hand
   sculpts.

## Later

5. **Character jump and dodge roll** (the user's request, 2026-09-28). Characters can jump and roll.
   - **Animations:** retail vSRO most likely has no player jump or roll animation [likely: to verify by listing the
     Chinese character animation sets (.ban) for anything reusable, such as skill leaps, knockdown/get-up or
     emotes]. So new animations must be authored for the retail skeletons (Chinese male and female), in
     Blender. Routes:
     - hand-keyed with bpy scripts;
     - retargeted from a CC0/free mocap library (any download needs the user's approval);
     - AI motion (Meshy/Higgsfield animation tools), retargeted in Blender.
     All three end in our converter's skinned glb clips.
   - **Weapons:** check whether one roll per weapon stance is needed (sword/blade, spear/glaive, bow), or a generic
     roll with an upper-body layer.
   - **Gameplay (to design):**
     - Jump: a cosmetic hop in place or while moving, never crossing a blocked nav edge in v1, since movement is
       server-authoritative.
     - Roll: a short dash (distance, cooldown, maybe brief invulnerability, which affects combat balance and PvP).
       It needs a protocol message, server validation against the navmesh, and animation blending in and out of
       run/idle.
     - Not while mounted, stalling or trading (the lock rules of wave 8).
   - **Blender:** it will be needed here, driven by scripts; a Blender MCP connection is optional, for watching the
     editing live.
6. **Detail extras** (WAVE_PLAN3 §7.3, each needs the user's go):
   - DT-4, the runtime detail-map plugin;
   - DT-5, subdivision L1 + LOD for actor models.
7. **New geometry for about 30 key Jangan assets** (walls, gates, the 10 most-placed houses, 5 tree species) for a
   real step toward the "AAA" look (RENDER.md §13). Only from prompts or the user's own concept art; retail files
   never go to web services.

8. **A proper intro, login, character select and character create** (the user's request, 2026-09-28, after
   everything else).
   - **The problem:** the video behind the login form today is not from this game. Replace it with a proper intro.
     Options:
     - the retail client's own opening movie or login scene, if one exists (find it in the pk2 archives: Media.pk2,
       Map.pk2, the client folder);
     - a real-time 3D login scene built with the modern renderer (camera flythrough of Jangan at golden hour);
     - a newly made intro video.
   - **Character select and character create:** retail has its own small map/scene for these, and the user expects
     it to be in the retail files. Find the scene data (region, objects, camera path, lighting) and rebuild both
     screens on it, with the wave-9 renderer (sky, lighting, PBR) so they look as good as the world.
   - Keep the flow the user asked for at the start: logo/intro → login → server select → character select (3D) →
     character create → enter world. Keep the English UI rules (live text only, docs/UI.md).
   - Check the audio too: the retail login and character-select music.

9. **Performance pass: aim for a solid 60 fps** (the user's request, 2026-09-28, after everything else).
   - **Measure on the real machines:** the dev PC, and the friends' gaming desktops, gaming laptops and Apple
     Silicon Macs (M1+). Use the perf overlay with GPU timestamps and a scripted benchmark route (the plaza at noon,
     the gate in a storm, the fields at night, a crowded spot with many players and mobs).
   - **CPU side:** Babylon is CPU-bound on draw submission (RENDER.md). Options:
     - static-mesh merging and instancing;
     - frozen materials and world matrices;
     - WebGPU render bundles / snapshot rendering for static chunks;
     - shadow-caster culling per cascade;
     - animation LOD and skinning cost for many characters;
     - fewer per-frame allocations;
     - UI/DOM cost of the HUD.
   - **GPU side:**
     - dynamic resolution with temporal upscaling;
     - texture compression (KTX2) and VRAM budgets;
     - post-stack costs per preset;
     - the cost of the volumetric clouds and the ocean.
   - **Hitches:**
     - shader compile and pipeline warm-up (precompile at load, cache);
     - region streaming spikes;
     - texture upload jobs within the frame budget;
     - GC pauses.
   - **Output:** per-preset defaults that hold 60 fps on each machine class, with the first-run detection tuned to
     match.
   - **Wave 11's open G1 misses (G-11, `wave11/budgets.md`), the first targets:** on WebGPU Medium the plaza with 20
     players and 20 monsters reads 16.8–17.7 ms p95 and Tiger Girl with 20 attackers 19.7–20.9 ms (WebGL2 passes both).
     The fight's hit effects are already capped (`otherHits`, G-11: 25–28 → 20–21 ms); with no hit effect at all it
     still needs ≈ 18.5 ms, the 20 characters' ≈ 580 draws (about 14 parts each, main pass plus shadows), skinning and
     their animation. Character part merging (one or two draws per character) and other players' shadow casters are the
     levers; the JS self-profile of the fight is `work/tmp/g11/shots/g11-prof-fight.json`.

10. **Ray tracing** (the user's request, 2026-09-29, after everything else).
    - **Reality check first:** browsers do not give web pages hardware ray tracing (RT cores). WebGPU has no
      ray-tracing API in shipping browsers as far as we know [to verify when this starts]. "Ray tracing" here therefore
      means ray-traced effects done in compute shaders or screen space.
    - **Candidates, most value for the cost first:**
      - screen-space ray-traced reflections (SSR, already on puddles/wet ground in 9A; extend it to water and polished
        floors);
      - ray-marched contact shadows and screen-space GI (SSGI) for bounce light;
      - probe-based ray-traced diffuse GI (DDGI-style): a grid of probes around the player, updated a few rays per
        frame by a compute shader against a simplified scene (the merged per-region proxies from 9A's shadows). This
        gives coloured bounce light and soft sky occlusion, moving with the sun;
      - ray-traced sun shadows for the static world against a compute BVH, as an Ultra-only experiment;
      - if browsers ship a real ray-tracing API later, revisit.
    - **Constraints:** the 60 fps goal (item 9) comes first. Anything ray-traced is High/Ultra-only, is measured before
      it is kept, and needs WebGPU compute (no WebGL2 path). The design study compares each option's look against its
      cost on the friends' machines (gaming desktops and laptops, Apple M1+).

## Open items carried over

- Memory growth when going world → character select (not yet investigated).
- The ui.eqbreak/ui.eqdanger sounds: the user judges them by ear (PLAYTEST.md).
- The pending D-decisions in docs/PLAYTEST.md §10.
