# Underwater spec: the world below the waves (wave 13)

The user's words for wave 13, verbatim:

> Fishing off the beaches and the pier with rare catches and cooking for small buffs.

> Swimming in the sea, with a swim animation.

> Under water scenery, life, and events.

> Hot springs: a relaxing spot in the mountains where resting builds bonus EXP for your next session, and a natural
> hangout for chatting.

This spec covers the third line: **what a player sees, hears and finds when they dive.** It covers the sea bed (sand,
rocks, seagrass and kelp, painterly reef plants, wrecks), the light (caustics, god rays, depth fog and colour
falloff), particles (plankton, bubbles), the ocean surface seen from below on both backends, sea life (fish schools
that flee, crabs, turtles, rays, jellyfish), underwater events (a sunken shrine with a small treasure, giant clams
with pearls, rare sightings, the tie-ins to fishing's rare catches), the Low path, and budgets that keep Medium at
60 fps under water. Swimming itself (the swim state, the animation, the camera, where swimming is allowed, how deep a
player can go) is the swimming spec's; fishing and cooking are the fishing spec's; the hot springs have their own.
This spec meets them at named seams (§2) and leaves hooks for wave 14 ("The Climb") without designing it.

**The user delegated every decision.** Wherever there was a choice, this spec takes the option it would mark
"(Recommended)" and writes it as a decision with a one-line reason (§11). Only what truly needs the user is left in
§12 and §13, each with the default used meanwhile.

It is a design only. Nothing under `packages/`, `apps/`, `content/` or `deploy/` was edited (the wave-12 build is
editing them). The scratch prototype, its tools and its shots are in `work/tmp/underwater/`.

**Tags** (as in WAVE_PLAN8):

- **[confirmed]**: checked in the code or data of the working tree on 2026-10-02, or measured by this spec's
  prototype. Each one says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived), not measured on that setup.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this spec makes. The user may overrule it.

**Fact-check (2026-10-02, ≈ 09:00–10:00Z).** Every [confirmed] claim was re-derived from the code, data, client files
and the prototype; the corrections are listed in §F at the end (F1–F16) and marked "fact-check Fn" where they changed
the text. Its scratch is in `work/tmp/underwater/fc_*` (the region census, the field re-sample, the balance read, the
WebGL2 re-bench `fc_bench.js` and its `shots/fc-*.json`).

**Images:** `work/tmp/underwater/shots/uw-sheet.png` (today vs the prototype, the wreck, the creatures), and every
shot named below in the same folder.

**Repo state when this was written [confirmed: `git log`, `git status`, 2026-10-02 ≈ 04:00–06:00 local].** HEAD
`cb65112` (the wave-11 G1 rescue). The wave-12 step-0 seams are being built in the working tree, uncommitted
(`packages/world-render/src/{world, objects, terrain}.ts`, `batch/*`, `grass/*`, the new `terrain-edit.ts`,
`placement-scale.ts`, `trees/`; `packages/convert/src/cli.ts` already has the convert lock and the `world-edit` verb).
The prototype page imports `packages/world-render/src` directly, so it ran on that in-progress tree; nothing it
measures depends on a wave-12 file. The sibling wave-13 specs (`SWIMMING.md`, `FISHING.md`, `HOT_SPRINGS.md`) appeared in `docs/` while this was
written; §2 was re-aligned with SWIMMING's and FISHING's seams before this spec closed [confirmed: read 2026-10-02].

---

## 0. Summary

1. **Today a diving camera sees the wrong world** [confirmed: shots `today-dive.png`, `today-up.png`]. The ocean is
   shaded for a viewer above it (a bright reflective sheet overhead, a near-transparent sky when looking straight up),
   the air's fog and sky dome show through, and the sea bed simply **ends**: the coast pass emits a region only where
   some water is shallower than 8 m (COAST §2.2), so 190 m off S1 the sand stops at a straight edge and the sky dome
   shows below it.
2. **One underwater state, one shader plugin, no new texture** [decision; prototyped]. `World.underwater` follows the
   camera's eye against the local water surface (the ocean's CPU wave query, or the retail water plane). While it is
   on, one global PBR plugin (`SroUnderwaterPlugin`) adds **procedural caustics** (two animated Worley-edge layers,
   shifted by the refracted sun; no texture, no varying) and **per-channel absorption** along the view ray and along
   the light's path down (depth fog and colour falloff: red goes first). The air's height fog is suspended, the sky is
   replaced by a water-coloured backdrop, and the far plane is cut to 90 m. The same functions go into the grass/life
   skeleton chunk, so sea life is lit and fogged the same way. Above water the plugin is a uniform test.
3. **The surface from below is Snell's window** [decision; prototyped]. The ocean plugin (and RND-W's water plugin)
   gain an under branch: refract the view ray through the real wave normal; inside the ≈ 48.6° window show the sky
   cube and a sun spot, outside it total internal reflection in the water colour, then the absorption. It is WGSL and
   GLSL text in existing plugins, so WebGPU (GPU FFT normals on High) and WebGL2 (the worker tile) take the same path
   [confirmed: the prototype rendered on both, 0 validation errors]. Low's Classic ocean gets a flat two-tone version.
4. **The sea bed is real terrain where people can dive** [decision]. The coast pass emits every region that touches a
   dive zone (the swimming spec's swim zones deeper than 2.5 m, dilated by 64 m), whatever its depth: **bed regions**.
   They carry the seabed paint, a lightmap, placements and edits like any region, and are drawn only while the camera
   is under water (from above the sea hides them). The prototype's other route, a "bed skin" built on the client from
   the coast field's depth channel, works (seam to the emitted terrain ≤ 0.10 m, mean 0.03 m [confirmed: 289 edge
   samples]) and stays as the fallback (cut 6).
5. **Scenery is retail first, painterly always** [decision]. Rocks are the retail `stone_field*` / `cj_graveyard_rock*`
   set; the shipwreck is the retail ruined ship `ruin_takla_ship_01` (3,983 triangles, torn sails) at 0.13 scale
   (≈ 8.7 × 12 × 19 m); the shrine's centrepiece is the retail stone tortoise `w_cd_bigtortoise01` (3,442 triangles,
   already in the Jangan export as model 343) at 0.13 [confirmed: all converted into scratch in 0.4 s, 0 validator
   errors, placed and shot under water; sizes from the sidecars' bounds]. Both retail models name a collision mesh in
   their `.bsr`, so they are **not** scaled through S-SCALE (0.5–2, footprint-free models only, the nav keeps the
   unscaled footprint): the sea pass writes **scaled copies without collision**, the town dressing's method (§3.4,
   fact-check F5). New: seagrass, kelp and painterly reef plants (bpy, one draw per kind, sway in the vertex shader),
   and the shrine's small parts. Everything is authored as a dressing file (`content/sea/jangan-sea.json`) applied by
   a converter pass, so the World Editor can move it afterwards (by row id, as the town's dressing).
6. **Sea life is one more world-render part, built like wave 10's** [decision]. `World.sea`: client-only, cosmetic,
   pooled, seeded by cell and game hour, fleeing actors, **≤ 5 draws**: fish (all species in one procedural mesh,
   CPU boids schools plus reef dwellers), crabs (the retail crab baked to VAT at 0.12 scale), gliders (a turtle and a
   ray, bpy meshes with a flap weight in the vertex colour), jellies (pulse, glow at night). Low draws none (the Low
   guard). The species ids are shared with the fishing spec's catch table: the fish you catch are the fish you see.
7. **Meshy: 0 credits spent in this design; a 40-credit bake-off is specified for the build** [decision]. The bpy side
   was built and measured here (turtle 308, ray 433, jelly 184 triangles, 3 s of Blender in all [confirmed]). Close
   up, the bpy turtle reads as "programmer art" (shot `dev-turtle.png`); the jelly and the ray read fine at their
   distances. The one hero creature (the Jade Tortoise, §6.3) is where Meshy can help: an opaque creature, which is
   what Meshy does well (wave 12's failure was cut-out foliage). This agent does not spend credits or download the
   generated files on a relayed permission, so the bake-off (≤ 40 credits) runs in the build under WAVE_PLAN9's cap
   (§5.6, §12).
8. **Events are deterministic and server-checked** [decision]. A pure function of the world clock
   (`packages/shared/src/sea.ts` `seaEventsAt(clock)`) gives every sighting window and every clam's open/closed state,
   so all clients agree with no broadcast (the town schedule's pattern). The server module `apps/server/src/sea.ts`
   owns the rewards: the **Dragon King's sunken shrine** (a daily offering coffer, and a sealed coffer opened by the
   fishing spec's rare catch, the Rusty Bronze Key), **giant clams** (pearls while open, once per clam per day),
   **gatherables** (kelp and sea urchins for cooking), and **sightings** (the Jade Tortoise doubles rare catches near
   its path and gives a short blessing; a manta at dusk; the Sea Dragon's shadow in storms, a wave-14 hook). One new
   request (`seaUse`), one new table (daily claims; the wave's third migration, 13 by default), one GM-only message
   (`seaHold`). Daily claims need level 10; gathered items sell for 2 gold with a 30-pick daily cap (fact-check F9,
   F10).
9. **Budgets** (§9). Measured on the prototype [confirmed: §8.3]: the S1 reef with every feature on reads
   **1.4–1.6 ms p95 on Medium WebGPU** (main-pass GPU 0.59 ms), 2.6–2.8 on WebGL2, 3.3 on High; all the features
   together cost ≈ +0.07 ms of GPU over today's (wrong) underwater view, the caustics alone +0.13; above water the
   plugin costs nothing measurable, on WebGL2 too [confirmed: the fact-check's no-plugin baseline]. **WebGL2's extra
   ≈ 2 ms is not the shading** (fact-check F8, re-measured): ≈ 1.8 ms of it is the prototype re-uploading the
   plankton's unchanged thin-instance buffer every frame (a stall that grows with the GPU's frame: 0.7 ms p95 with the
   upload skipped), ≈ 0.4 ms the per-material uniform uploads (73 plugin instances); absorption plus caustics alone
   read 0.45 ms against today's 0.4. Production uploads instance buffers only when they change and binds the state
   once per frame: the WebGL2 reef is ≈ 0.6–1.0 ms [projected from the split runs]. The new G1 scene, **20 divers at
   the shrine during a sighting**, projects to ≈ 6.5–10 ms p95 on WebGPU and ≈ 5–8.5 on WebGL2 (Medium)
   [projected, §9.2]; the far plane (90 m) and the 45 m actor cull bound the frustum when divers spread over the zone,
   but do not shrink a crowd standing at the shrine, so the per-player cost dominates. Low keeps its retail look with a fog swap and the two-tone surface.
10. **Never cut** (§15): the underwater state with absorption, the surface from below on every preset, bed regions
    (or the skin fallback) under every dive zone, caustics on Medium+, one fish school, the shrine with its coffer, the
    clams, the Low path, and G1.

### 0.1 Where each request lands

| User request (fragment) | Where | Lanes |
|---|---|---|
| "Under water scenery" | §3 the bed: bed regions, sand, rocks, seagrass, kelp, reef plants, the wreck, the shrine; §4 the light and the sound | UW-C, UW-D, UW-R, UW-A |
| "Under water ... life" | §5 `World.sea`: fish schools that flee, reef fish, crabs, a turtle, a ray, jellies | UW-L, UW-D |
| "Under water ... events" | §6 the Dragon King's shrine, giant clams, gatherables, sightings | UW-S, UW-E |
| "Fishing ... with rare catches" (tie-in) | §6.4 shared species, the Rusty Bronze Key, the tortoise's rare-catch window | UW-S + the fishing spec |
| "Swimming in the sea" (seam) | §2.1 the camera and depth rule, `World.underwater`, the swim zones → bed regions | the swimming spec + UW-R |
| standing goal "at least 60 fps" | §9 the G1 underwater scene, the far-plane cut, the actor cull, per-preset counts | UW-R, LAB-13 |

---

## 1. Today [confirmed unless tagged]

### 1.1 What a diving camera sees now

The prototype page loads the real export (`work/out/world/jangan-fields`, Medium, PBR, WebGPU) and puts the camera
7 m under the sea off S1. With every underwater feature off (`today-*.png`; the four rocks are the prototype's reef
props, not in the export):

- **Looking ahead** (`today-dive.png`): a bright blue reflective sheet fills the top third (the ocean's PBR shading,
  made for a viewer above: Fresnel, sky reflection, glint), the sand and rocks are lit and coloured as on land, and
  behind them a **straight horizon line** where the emitted terrain stops; past it the sky dome and the air fog.
- **Looking up** (`today-up.png`): the ocean is almost transparent from below, so the sky, the sun disc and the clouds
  show as if there were no water, with a few light foam blobs.

Why [confirmed: code]:

- `ocean-plugin.ts` sets `backFaceCulling = false`, so the back of the sheet is drawn, but every term (reflection,
  scattering by path length to the bed, alpha = 1 − transmittance) assumes the eye is above.
- The air's height fog (`pbr/fog-plugin.ts`, `HeightFog.update`) and the sky dome are the only atmosphere; nothing
  knows the eye is in water.
- `CameraGround` (`apps/game/src/world/jangan/camera.ts`) keeps the eye 0.6 m above the ground only; there is no
  water rule, so a low camera over a player wading at the bounds line (1.6 m of water) can already dip under the sea
  today [likely; not reproduced in the game].

### 1.2 The sea bed off S1

Sampled from the coast field (`work/out/world/jangan-fields/coast/field.png`, B = depth in 0.2 m steps on sea texels,
`CoastField` constructor [confirmed: `ocean/field.ts`]) along x = 480 (S1's middle):

| glTF z | Where | Bed depth below the sea level (+5 m) |
|---:|---|---:|
| 1290 | the waterline | 0 |
| 1344 | the bounds line (region row 90 / 89) | 1.6–1.8 m |
| 1400 | 56 m past the bounds | 3.6 m |
| 1464 | 120 m past | 7.4–8.6 m |
| 1528 | 184 m past | 12.2–14.0 m |
| 1536 | **row 89 / 88: the emitted terrain stops here at x 166–173** | ≈ 13 m |
| 1624 | 280 m past | 20 m |
| 1976 | 632 m past | 35 m (the deepest, flat beyond) |

- Emitted regions south of S1 [confirmed: `manifest.regions`]: row 89 (z 1344–1536) for x 160–176; row 88
  (z 1536–1728) only for x 160–165 and 174–176; row 87 for x 160–164; row 86 none. So at S1 the terrain ends 190 m
  past the bounds, 12–14 m deep.
- The shelf is gentle (≈ 1:15 to 1:25), smooth below 8 m (the coast pass drops its 1.2 m bed noise there, COAST
  §2.2), and painted with the "seabed" tile (`oaho_dust_earth06`, `content/coast/coast.json` `paint`).
- The bed slope gives good dive geography with no edits: wade and snorkel at 2–4 m by the bounds, a reef zone at
  8–14 m, open water beyond.

### 1.3 Retail assets that fit the sea [confirmed: file search in `work/extracted`, conversion into scratch]

`pnpm sro convert --out work/tmp/underwater/conv ...` converted six candidates in 0.4 s with 0 validator errors:

| Asset | Triangles | Size as authored | Use here |
|---|---:|---|---|
| `res/artifact/ruins/ship/ruin_takla_ship_01` (the Taklamakan ruined ship) | 3,983 | 67 × 92 × 147 m (x × y × z; the mast is the height) [fact-check F4: was "144 × 92 × 140"] | **The shipwreck** at 0.13 scale (≈ 8.7 m beam × 12 m to the masthead × 19 m long): hull, broken mast, torn sails (`dev-wreck-1.png`). Its 48 sibling pieces (`ruin_takl_ship_b01_*`, `_n01_*`, `_s_*`, 471–1,983 triangles) are debris. On the 12–14 m bed with a 1.2 m sink its masthead is ≈ 2–3.5 m under the still surface |
| `res/artifact/china/dunhuang/turtle/w_cd_bigtortoise01` (stone tortoise) | 3,442 | 67 × 35 × 59 m | **The shrine's centrepiece** at 0.13 (≈ 8.7 × 4.5 × 7.7 m): a stone tortoise is the classic stele base (bixi). Already in the Jangan export (`manifest.models` 343) [confirmed], so its textures cost no new download. Alternative: Jangan's own temple turtles `bldg/china/jangan05/cj5_tem_turtle01–03` [confirmed: file search; not converted] |
| `res/mob/asiam/crab` (Asia Minor crab, a monster) | 998, 60 joints, 14 clips (STAND1, WALK, RUN, ...) | 2.8 m | **Crabs** at 0.12 (≈ 34 cm), STAND1 + WALK baked to VAT |
| `res/npc/animal/cj_goldfish01` | 56, 23 joints, 1 clip | 0.18 m | Not used under the sea (a pond fish); the town keeps it |
| `nature/common/stone_field01..05`, `cliff/cj_graveyard_rock01/02` | 119–235 per rock | 5–54 m | **Reef rocks** (already in the export) |
| `wreck_float01..07` (COAST §10.3), `dun/property/wreck/*` (the Ghost Wreck dungeon's parts, `wreck_bship_*`, `wreck_sship_*`) | – | – | Extra debris if the takla ship needs company [likely; not converted] |

- Retail has **no** fish school, ray, turtle, jellyfish, kelp, coral or bubble assets, and **no underwater or bubble
  sound** (the only water sounds are `env/sea_wave1`, `player/mvwalkwater`, `mvrunwater`, and the sea horse pet)
  [confirmed: search of `Data/prim/mesh`, `prim/snd`].
- Retail sea-adjacent sounds the swimming spec may want: `mvwalkwater` / `mvrunwater` (wading).

### 1.4 What the engine already gives [confirmed: code]

- `World.waterLevelAt(x, z)`: the sea level where the coast field says sea, else the retail block's water plane.
- `CoastAccess.seaAt` and the CPU wave query (COAST §8.4: "whether the camera is under water" was planned on the
  worker's arrays).
- The life part (`life/*.ts`): pooled instanced animals, `setThreats`, `addSpecies`/`addHabitat`, gating by period and
  weather, `metadata.sroWorld = 'life'`, `isVisible` toggling (never `setEnabled`), its materials on the grass skeleton
  (`life/shaders.ts`) adopted by the scatter, so the sky, fog and night chunks light them.
- The world clock (`apps/server/src/world-clock.ts`): deterministic from a fixed epoch, extrapolated by every client;
  the town schedule (`packages/shared/src/town.ts` + `world-render/src/town/schedule.ts`) is the precedent for "a pure
  function of the clock that every client evaluates the same way".
- The town's VAT pipeline (`packages/convert/src/town/vat.ts`) for baked animation on thin instances.
- Sound: `audio/backend.ts` has per-voice low-pass filters, buses `sfx | ui | ambient`, and a master gain; music is an
  `HTMLAudioElement` with its own volume (SOUND §5.2).

---

## 2. Seams with the rest of wave 13 and the world

### 2.1 The swimming spec: camera and depth

The swimming spec owns the swim state, the swim and dive animations, where swimming is allowed (its swim zones), how
deep a player may go, breath (if any), the server's swim movement, and the camera while swimming. The table below
is aligned with SWIMMING.md §9.4 (its hand-off to this spec).

| Seam | Owner | Contract (default) |
|---|---|---|
| **S-UNDER: the eye rule** | swimming (camera), UW-R (state) | `World.underwater` is true when the camera's eye is below the local water surface: `waterLevelAt(x, z)` plus the CPU wave height at the eye (COAST §8.4's query; Low: the Gerstner set) [decision]. The swimming camera keeps the eye **at least 0.35 m from the moving surface** (pushed down while the swimmer's head is under, up while it is above), so the near plane never straddles the waterline and no frame is split [decision: a half-in, half-out split view is not built]. A 0.25 s blend of the underwater uniforms hides the switch. |
| **S-ZONES: where people dive** | UW-D (content), swimming (domain) | Dive-zone polygons live in this spec's dressing file (`zones`, §3.4); SWIMMING joins them to its swim domain and its `swim.bin` dive class (SWIMMING §3.1, §9.4), and the bed-region rule reads that domain (§3.1) [confirmed: SWIMMING.md]. This wave: **one zone at S1**, x 400–960, z 1290–1560 glTF (the bounds line out to 216 m past it, 1.6–15 m deep). |
| **S-DEPTH: the diver's depth on the server** | swimming | SWIMMING keeps `p.swim = { mode: 'surface' \| 'dive', diveAt, breathUntil }` and exposes `swimDepthM(p, now)` and "is down" (no protocol field); §6.5's checks call it [confirmed: SWIMMING §6]. Dives reach `max(bed + 0.9 m, surface − 15 m)`, so the reef (8–14 m) and the shrine (≈ 12–13 m) are in reach; breath is 30 s, ≈ 17.5 s at the deepest line, over this spec's 15 s rule (S-BREATH). |
| **S-BREATH (optional)** | swimming | If there is a breath meter, events never trap a player (no reward needs more than 15 s at depth). |
| **S-FLOOR: divers over solid sea props** (new, fact-check F6) | UW-C (data), swimming (`swim.bin`) | SWIMMING's diver is a 2D point whose depth line is `max(bed + 0.9 m, surface − 15 m)` from the terrain bed, and its only solids are tested at the surface (`insideSolid(x, z, surface − 0.5)`) [confirmed: SWIMMING §5.2, §6]. Without a seam a diver over the wreck (≈ 10 m above the bed) or the tortoise (4.5 m) sinks through the hull. Default [decision]: each solid sea prop row carries a footprint box and a top height (`solid: { w, d, topM }`), and SWIMMING's `swim.bin` bake raises its bed to `topM` inside that box, so the dive line glides over the wreck and the shrine; the wreck's interior is not enterable this wave. The client camera's ground rule under water reads the same raised bed. |
| **S-BUBBLES** (given) | UW-L | `world.sea.bubbles(x, y, z, n)` emits a burst; the swimming spec calls it on dive-in, every 3–5 s exhale, and on a gasp. |
| **S-SURFACE-Y** (taken) | swimming | SWIMMING's swim layer gives `waterSurfaceAt`, `bedAt` and `swimClassAt`, and `world.setSwimmer({ diving, headDepthM })` each frame; `World.underwater` and the sea life read them, and the band is one constant (`SWIM_EYE_BAND_M` = 0.35 in `packages/shared/src/swim.ts`) [confirmed: SWIMMING §9.4]. |

Also for the swimming spec [decision]: under water, actors beyond 45 m are not drawn (the absorption makes them
invisible at 40 m, §4.2), and the swimmer's own shadow is not drawn under water (the CSM still lights the bed).

### 2.2 The fishing spec

| Seam | Contract |
|---|---|
| **Species** | **One id list, two files** (fact-check F2: FISHING's current text puts it this way, and this spec follows it): the sea species' ids, shape and palette rows live in **`content/sea/species.json`** (this spec, lane UW-D), and FISHING's catch rows (weights, classes, prices, XP) in `content/fishing/species.json` are keyed by those ids; freshwater species are fishing-only rows [confirmed: FISHING §5.2 "One species list with UNDERWATER", D11: 19 species, its sea rows use this spec's ids: silver sardine, golden-line bream ("Sea Bream"), coral snapper, sea bass]. `World.sea` draws the sea rows, so a caught fish is a fish players saw; the meshes come from **one generator for both specs** (S-FISHMESH, owned by this spec's UW-D, as FISHING D26 asks: 19 species + 5 extras, ≤ 400 triangles each) [decision]. WAVE_PLAN9 settles the shared display names. |
| **The Rusty Bronze Key** | **Settled by FISHING** (fact-check F3): the key is its own outcome group, **1 in 200 catches at sea, in the bay and the ferry basin, 1 in 400 on the river, none after FISHING's daily soft cap** [confirmed: FISHING §5.1 step 1, §3.5 item list]. Item code `ITEM_ETC_SEA_BRONZE_KEY`, defined with the other `ITEM_ETC_SEA_*` rows in `content/items/sea.json` (FISHING's item merge); it opens the shrine's sealed coffer (§6.1). |
| **The tortoise window** | `seaEventsAt(clock)` returns the Jade Tortoise's path and window; fishing within 80 m of the path during the window doubles the rare-fish weight [confirmed: FISHING §5.1 step 2 already reads it]. The fishing spec reads the shared function; no message. |
| **Cooking ingredients** | Kelp counts as Waterweed and Sea Urchin as Mud Crab in every recipe (one alternative-ingredient rule in FISHING's `recipes.json`) [confirmed: FISHING §7.2]. Their codes are reserved here (`ITEM_ETC_SEA_KELP`, `ITEM_ETC_SEA_URCHIN`). **They sell for 2 gold**, as FISHING's caught ingredients do [decision, fact-check F9: the first draft's 30–60 gold made a risk-free gathering farm and an arbitrage against Waterweed and Mud Crab at 2]. |
| **The pier** | FISHING's new S1 pier is **≈ 62 × 4 m from the dry sand at z ≈ 1274 to z ≈ 1336, x ≈ 470, ≈ 1.6 m of water at its end**, its piles listed as solids for swimmers [confirmed: FISHING §2.2, fact-checked there; the first draft quoted its old 36 m]. The piles are dressed (mussels, a little kelp, a pair of dwellers) through the same dressing file (§3.4) [decision]. At ≤ 1.6 m nobody dives there (SWIMMING dives need ≥ 2.5 m), so this dressing is seen **from above, through shallow translucent water**, and is drawn above water as well (§3.3). |

### 2.3 The hot springs

No shared state. The hot springs' water is a small retail-style pool, not a dive zone; `World.underwater` would only
trigger if a camera dipped into it, and the swimming camera rule (S-UNDER) keeps the eye out of water shallower than
the eye height. The underwater audio low-pass (§4.8) is a backend call the hot springs could reuse for a "head under
the water" moment [likely; not designed here].

### 2.4 COAST, the World Editor, the life system, sound

- **COAST.** The bed is part of the coast field and the coast pass (§3.1 adds the "dive zone" emission rule to it).
  The ocean plugin and `ocean-classic.ts` gain the under branch (§4.5). COAST's CST-K (Ultra caustics with a 256²
  texture and an extra terrain extern) is **superseded** by §4.3's procedural caustics: no texture, no extern, every
  PBR preset [decision].
- **The World Editor (WORLD_EDITOR §4.8, D30).** Today tiles under new water deeper than 1.2 m **close** "until
  swimming exists". This spec does not change the nav; the swimming spec decides whether swim zones reopen those tiles
  for swimming. The editor gains, through the dressing rows (§3.4), the ability to move, turn and delete sea props
  like the town's dressing (by row id, WORLD_EDITOR F4/F5), and its "Test in game" shows the underwater look for free
  (it is the game's renderer). New bed regions are ordinary regions to the editor's height and paint brushes.
- **GRASS_LIFE.** `World.sea` is a sibling of `World.life`, not more species in it: the life part's three meshes are
  air animals with the bird and butterfly shaders, and its gating (rain sends everything under cover) is wrong under
  the sea. The sea part reuses `life/spawn.ts`'s cell seeding and the threat feed (`setThreats`) and the grass
  skeleton materials [decision].
- **SOUND.** A new `audio/underwater.ts` (§4.8); the backend gains a world filter on the sfx and ambient buses.

---

## 3. The sea bed and its scenery

### 3.1 Bed regions (the coast pass) [decision]

- **Rule:** the coast pass's emission rule ("a synthetic region is written if some vertex is land or water shallower
  than 8 m", COAST §2.2) gains: **or the region touches a dive zone dilated by 64 m.** 64 m is the underwater
  visibility (≈ 40 m to 95 % for green, §4.2) plus margin, so no diver ever sees the bed end. At S1 with the default
  zone (dilated: x 336–1024, z 1226–1624) that is **5 more regions** (row 88, x 169–173) [confirmed arithmetic on
  `manifest.regions` and the default zone]; the whole S1 frontage (x 166–173) would be 8.
- **What a bed region carries:** terrain heights from the coast pass (they exist already: the pass computes the whole
  domain and only skips writing them), the seabed paint, a lightmap (the retail bake of a flat bed is uniform; the
  converter writes a flat one if none), no navmesh (swimming owns any swim nav), `bedOnly: true` in the manifest
  region entry.
- **Drawn only under water** [decision]: from above, the sea at 13–24 m is opaque (COAST §2.2: opaque past ≈ 6 m on
  every path), so bed-only regions set `isVisible = false` while `World.underwater` is false (never `setEnabled`: no
  active-mesh list rebuild, `render/active-meshes.ts`). Above water they cost one visibility test each.
- **Cost** [projected from COAST §2.2's per-region averages]: +5 regions ≈ +0.25 MB brotli download, ≈ +2.3 MB GPU
  memory while resident, ≤ +5 draws and ≈ +92 k triangles only while under water near S1.
- **The skin fallback** (cut 6): the prototype's `bedSkin()` builds a 129 × 129 grid (4 m) from field B around the
  camera; it matched the emitted terrain at the region edge within 0.10 m (mean 0.03 m over 289 samples)
  [confirmed: `uwInfo.skin`]. It costs one draw and no download, but carries no paint, no placements and no edits, and
  a grazing view shows the material change at the seam (`dev-wreck-1.png`, the straight line in the distance).

### 3.2 The ground: sand, ripples, patches

- **Paint:** the coast pass already paints the bed with `oaho_dust_earth06` (the "seabed" row). Under water the
  absorption turns it into the right blue-green at 6–15 m [confirmed: prototype shots]. Two additions [decision]: a
  **sand-ripple detail** (a 1.5 m-period ripple normal folded into TERRAIN_TEX's Medium detail layer where the paint is
  sand and the depth is over 1 m; no new texture unit: it is procedural, like the caustics), and **darker patches**
  (seagrass meadows' ground, rock rubble) painted by the dressing pass with existing tiles (`c_stone_hmfld_01`,
  `ruin_takl_dest_05`).
- **Shallow wading band (0–2.5 m):** unchanged sand; the caustics are strongest there (§4.3).

### 3.3 Plants and rocks

| Kind | Source | Count at the S1 reef | Draws | Motion |
|---|---|---|---|---|
| Rocks | retail `stone_field02–05`, `cj_graveyard_rock01/02`, 0.4–0.9 scale, sunk 0.6 m | 12–20 | in the region batch (static) | – |
| Seagrass | new, procedural blade clumps (5 blades × 4 segments, 40 triangles), thin instances | 260 clumps over a 30 m patch (prototype) → 600 at the reef | 1 per kind | sway ∝ height², phase by position (prototyped: `uwWeed`) |
| Kelp | new, bpy: long ribbons (2–5 m, 8 segments, 2 sides), thin instances | 40–60 along the wreck and rocks | 1 | slow sway + a travelling wave up the stalk |
| Reef plants ("coral-like", painterly) | new, bpy: fan corals, tube sponges, soft corals as low card clusters with retail-style hand-painted vertex colour (ochre, rust red, violet, cream) | 80–120 | 1 (one mesh, species by instance colour) | none or slow |
| Shells, starfish, urchins | new, bpy, tiny (20–40 triangles) | 60–100 | 1 | none |
| The wreck | retail `ruin_takla_ship_01` + 2–4 debris pieces | 1 | in the region batch | – |
| The shrine | retail stone tortoise + Jangan temple pieces (lanterns, a stele) + new parts (offering coffer, two bronze lanterns) | 1 | batch + 2 interactables | lantern glow at night |

- All plants are **client-drawn from placements** (one placement per patch with a seed, expanded at load like the
  town's crack-grass bands) so the World Editor moves a whole patch [decision].
- Plants never cast shadows; rocks, wreck and shrine do (they are batched placements).
- **Visibility from above** [decision, fact-check F7]: a patch whose bed is deeper than 6 m (the sea is opaque past
  ≈ 6 m on every path, COAST §2.2) is hidden while `World.underwater` is off, like the bed regions; a patch in
  shallower water (the pier's piles, the wading band) stays drawn, because the sea is translucent there and a plant
  popping in at the surface would show. The S1 reef patches (10–14 m) are all of the first kind.
- "Painterly" is enforced the way TREES enforces its look: the plant palette is sampled from retail sprites
  (`tre_*`, `grs_*`) and reviewed on one sheet before the batch ships (G5-like look gate, §9.4).

### 3.4 The dressing file

`content/sea/jangan-sea.json` (kind `seaDressing`, validated by `validateSeaFile` in `packages/shared/src/sea.ts`):

```jsonc
{
  "kind": "seaDressing", "schema": 1, "world": "jangan-fields",
  "props":   [{ "id": "s1-wreck", "model": "res/artifact/ruins/ship/ruin_takla_ship_01.bsr", "x": 462, "z": 1528, "yaw": 0.7, "scale": 0.13, "sink": 1.2, "solid": { "w": 9, "d": 19, "topM": 10.4 } }],
  "patches": [{ "id": "s1-grass-a", "kind": "seagrass", "x": 486, "z": 1506, "r": 16, "density": 1.0, "seed": 11 }],
  "paint":   [{ "tile": "c_stone_hmfld_01", "x": 470, "z": 1520, "r": 6 }],
  "points":  [{ "id": "s1-shrine-lamp-1", "kind": "light", "x": 494, "z": 1520, "y": 1.2, "preset": "lanternWarm" }],
  "interact":[{ "id": "s1-coffer", "kind": "coffer", "x": 496, "z": 1519 }, { "id": "s1-clam-1", "kind": "clam", "x": 480, "z": 1512 }],
  "zones":   [{ "id": "s1-dive", "polygon": [[400, 1290], [960, 1290], [960, 1560], [400, 1560]] }]
}
```

- The converter pass `world/sea.ts` runs **after the town dressing and before the static variants and the world
  edits** (WAVE_PLAN8 D6's order: coast → town dressing → **sea dressing** → cloth → static variants → grass palettes →
  world edits) [decision: so the editor's edits apply on top].
- Props become ordinary `WorldPlacement`s with uids from the S-UID registry's new **sea range (3,000,000–3,999,999,
  by row)** [decision; W12-CV's `packages/convert/src/world/uids.ts` gets a fifth `UidSource`, `'sea'`, next to
  retail / editor / coast / dressing, whose ranges are disjoint and tested; confirmed: the file in the wave-12 tree];
  patches and points ride in the region's ambient file like the town's bands and the editor's light points.
- **Scale** [decision, fact-check F5]: a prop at a scale outside S-SCALE's range (0.5–2, footprint-free models only;
  "the nav keeps the unscaled footprint" [confirmed: `world-render/src/placement-scale.ts` header, WORLD_EDITOR D12])
  is written as a **scaled copy of the model without its collision mesh**, the wave-11 town dressing's method
  [confirmed: `world/town/dressing.ts` header]. Both retail heroes need it: their `.bsr` files name a collision mesh
  (`ruin_takla_ship_01.bms`, `w_cd_bigtortoise01.bms`) [confirmed: the `.bsr` strings], so at `scale: 0.13` through
  S-SCALE the walk nav and SWIMMING's surface solids would keep a 147 × 67 m ship and a 67 × 59 m tortoise at full
  size, and the World Editor's validator refuses such a scale. Sea props add nothing to the walk nav; their solidity
  for divers is the row's `solid` box (S-FLOOR, §2.1).
- **Ground** [decision]: the sea pass stands props on the **terrain heightfield** (the bed region's or the emitted
  region's heights), not on the town dressing's "main nav component" rule, which finds no walkable ground on the bed
  and would skip every row.
- `interact` rows go to the **server** (`apps/server/src/sea.ts` loads the same file) and to the client (the models).

---

## 4. Light, atmosphere and the surface

### 4.1 The underwater state [decision; prototyped]

`World.underwater: Readonly<UnderwaterState> | null` (null on a world without water), updated each frame after the
ocean, before the materials bind:

```ts
interface UnderwaterState {
  on: boolean            // the eye is below the surface (S-UNDER), blended over 0.25 s (blend 0..1)
  blend: number
  depthM: number         // the eye's depth below the surface
  surfaceY: number       // the still surface the shader's downwelling term uses: the sea level (+5 m) or the retail
                         // water block's own plane (fact-check F12: the prototype hard-codes SL; lakes and rivers differ)
  medium: 'sea' | 'fresh' // the coast field says sea, else retail water (rivers, the lake, ponds)
  sigma: Vector3         // absorption per channel (1/m), × turbidity (weather)
  inscatter: Color3      // the water's own colour at the eye, from the sky's key light and ambient, × exp(−σ · depth)
  sunRefracted: Vector3  // the sun direction after Snell (towards the sun)
  caustics: number       // 0..1: sun up, not overcast, not night
}
```

- While `on`: the height fog is suspended (`HeightFog.suspended`, one new flag: `update` writes `a.w = 0`), the sky
  dome is replaced by a water-coloured backdrop (the dome's own shader returns the inscatter colour when told; the
  prototype used an unlit sphere), `scene.clearColor` follows the inscatter, the camera's `maxZ` drops to **90 m**,
  and the shadow distance to **40 m** [decision: everything past 60 m is fully absorbed]. The game sets
  `camera.maxZ = 2000` in `apps/game/src/screens/world.ts` [confirmed], so the cut is applied by `World.update` from
  the state and restored on surfacing (UW-R), and the 45 m actor cull (D-U12) by the game's crowd budget (UW-E).
- **Fresh water too** [fact-check F12]: SWIMMING lets players dive in any swim water ≥ 2.5 m deep, the lake and the
  big rivers included (retail beds up to 58 m), so `medium: 'fresh'` is a shipped path, not a corner case: the same
  state, plugin and Snell's window (in `SroWaterPlugin`), its own murkier medium (§4.1 media), no sea life; rays and plankton as in the sea.
- **Media** (`content/sea/underwater.json`): sea σ = (0.24, 0.07, 0.06) /m, base colour (0.004, 0.042, 0.066)
  [confirmed: tuned in the prototype]; fresh water σ = (0.30, 0.13, 0.16), base (0.010, 0.050, 0.040), greener and
  murkier [projected].
- **Weather:** rain × 1.2 turbidity, storm × 1.6 and the inscatter × 0.6 (grey-green); **night:** the inscatter from
  the moon and sky ambient (≈ 4 % of noon), caustics off, the jellies glow (§5.4) [decision].

### 4.2 Absorption: depth fog and colour falloff [prototyped]

Per fragment of every PBR material (`CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR`), in scene-linear HDR before the post:

```
down = exp(−σ · max(SL − y, 0) · k_down)          // the light that reached the point (deeper = bluer, darker)
T    = exp(−σ · |p − eye|)                       // the view ray through water
lift = 1 + 0.6 · dir.y + 0.35 · pow(max(dot(dir, sunRefracted), 0), 6)   // brighter looking up and toward the sun
colour = colour · down · T + inscatter · lift · (1 − T)
```

- Red is gone by ≈ 12 m of path, green and blue carry to ≈ 40–50 m: near sand keeps a warm tint, far things turn
  teal, the deep turns blue-black [confirmed: shots].
- **Visibility:** 95 % absorption of green at ln 20 / 0.07 ≈ 43 m; the prototype's views read "clear but deep"
  (`dev-dive-6.png`, `dev-school-1.png`).
- **The sky through the surface** is handled by §4.5; looking down past the bed's edge (in a fallback zone) shows the
  backdrop, the same colour as the far water: no seam [confirmed: `dev-deep-4.png` with the skin].

### 4.3 Caustics [prototyped]

- **Procedural, no texture** [decision]: two animated Worley cell-edge layers (scales 0.9 and 1.45 per metre, the
  feature points drifting on `sin(t + 2π·hash)`, 3 × 3 cells each), combined as `a² · 0.55 + b² · 0.35 + a·b · 1.3`;
  sampled at the world xz **shifted by the refracted sun × depth**, so the pattern slides with the sun's angle.
- Applied at `CUSTOM_FRAGMENT_BEFORE_LIGHTS` as `albedo × (1 + 1.1 · c · fade)`, with `fade = smoothstep(0, 0.8,
  depth) · exp(−0.07 · depth) · sunUp · clamp(1.3 · normal.y, 0, 1)`: up-facing surfaces under water get them, fading
  with depth (strong at 2–6 m, faint at 20 m).
- **Every PBR surface** gets them: terrain, rocks, the wreck, characters, fish [confirmed: shots]. **No varying, no
  texture unit** [confirmed by construction: the snippet reads `vPositionW` and `normalW`, which the PBR shader
  already has; WebGPU and WebGL2 compiled it with 0 validation errors]. That matters on WebGL2, where the terrain
  material is already at 15 of 16 units (COAST F16).
- **From above water** (looking into the shallows from the beach): High and Ultra only, within 4 m depth [decision:
  Medium keeps the uniform test only; it is the cheapest way to hold the M1 beach margin, WAVE_PLAN8 G6].
- Cost on the underwater scene: +0.13 ms GPU p50 (0.46 → 0.59 ms main pass) on Medium WebGPU and on High WebGPU (1.18 → 1.31); on WebGL2 ≈ +0.5–0.7 ms of frame time (no GPU timer there) [confirmed: §8.3 A/B].

### 4.4 God rays [prototyped]

- **10 shafts on Medium, 16 on High+, 0 on Low**: one thin-instanced quad mesh, additive, unlit PBR with a soft
  gradient texture (64 × 128, generated at load), each shaft hung from the surface along the refracted sun, turned
  about its axis to face the camera, on a 7 m world lattice around the eye (shafts do not slide with the camera), with
  a slow flicker, a distance fade (2–5 m in, out by 30 m) and a depth fade [confirmed: `uwRays`].
- Only by day (sun elevation > 15°, cloud cover < 0.7) and only under water.
- **Length ≤ the local depth − 0.5 m** [decision: the prototype's 10–22 m shafts end with a hard cut where they
  enter the sand, `dev-dive-6.png`]. Strength 1.4× the inscatter (prototype `uwB.w`; 2.2 was too strong).
- Cost: below the timer's resolution (≈ 0.065 ms) [confirmed: §8.3, rays off = the same GPU p50], 1 draw.

### 4.5 The surface from below: Snell's window [prototyped]

- In `SroOceanPlugin` (and `SroWaterPlugin` for rivers and the lake) a branch on a uniform (`sroOcUnder`): when the
  eye is under water, the fragment colour becomes:
  - the view ray refracted from water to air through the **real wave normal** (High WebGPU: the GPU FFT's derivative
    arrays; Medium and every WebGL2 preset: the worker tile; plus RND-W's two detail normal layers);
  - **inside the window** (≈ 48.6° half-angle): the sky (the plugin samples `scene.environmentTexture` along the
    refracted ray, as its reflection already does) × (1 − Fresnel) plus a sun spot (`pow(dot, 900) × 30 × keyLight`
    and a soft halo);
  - **outside** (total internal reflection): the inscatter × 0.55, i.e. the water below reflected;
  - then the absorption of §4.2 with the eye-to-surface distance, so the far surface fades into the water colour;
  - alpha 1 (opaque from below), foam as a light patch (its albedo × 0.6).
- The prototype drew a separate disc with procedural ripples (`uwSurface`); production uses the ocean mesh itself
  (its CDLOD selection works from below unchanged: it culls by frustum and sea mask) [decision].
- **Why not a refraction of the real sky scene:** the opaque scene above the water is the sky only (no screen-space
  copy exists on Medium); Snell's window of the sky cube is what the eye sees from 2–15 m down anyway [decision].
- **WebGPU vs WebGL2:** the same text in WGSL and GLSL inside existing plugins; no compute, no depth texture, no new
  sampler [confirmed: both rendered the prototype's window, `dev-up-5.png` (WebGPU), `dev-gl-up.png` (WebGL2)]. The
  ocean's existing WGSL rule (vertex taps by `textureSampleLevel`, fragment taps at `CUSTOM_FRAGMENT_MAIN_BEGIN`,
  COAST F14) already covers the extra environment tap.
- **Low (Classic):** `ocean-classic.ts` and the Classic water get a uniform-gated two-tone: a lighter disc around the
  zenith of the eye (the window, with the Gerstner normal's wobble) and the inscatter outside. No Snell refraction of
  a cube (Classic has no cube) [decision].

### 4.6 Particles

| Kind | How | Medium | High/Ultra | Low |
|---|---|---|---|---|
| **Plankton / marine snow** | one cell of 90 specks (3 cm triangles) in a 10 m cube, 27 thin instances snapped around the eye (the 3 × 3 × 3 cells), additive, emissive [confirmed: `uwPlankton`] | 27 × 90 | 27 × 140 | – |
| **Bubbles** | a pooled emitter: thin-instanced billboards rising at 0.4–0.9 m/s with a wobble, growing as they rise, popping at the surface; bursts on dive-in, exhale every 3–5 s per swimmer (S-BUBBLES), the clam opening, the shrine's vent | ≤ 64 live | ≤ 128 | – |
| **Sand puffs** | the same pool, brown, on a crab's dash and a turtle's take-off | in the 64 | in the 128 | – |
| **Light motes in the shafts** | none [decision: the plankton already sparkles in them] | – | – | – |

### 4.7 Post

Nothing new [decision]. The underwater look comes from the materials; no screen-space distortion pass (a wobble
would cost a full-screen pass on Medium and is the most likely cause of motion sickness). The bloom of the sun spot
and the shafts is the existing post's.

### 4.8 Sound [decision]

`apps/game/src/audio/underwater.ts` (new), driven by `World.underwater.blend`:

- the backend gains `setWorldFilter(hz, rampS)`: one `BiquadFilterNode` that the **sfx and ambient buses** pass
  through before the master gain (the `ui` bus bypasses it, so clicks and toasts stay crisp) [decision, fact-check F13:
  the first draft filtered the master, UI included; the backend's chain is source → gain → panner → bus → master
  [confirmed: `audio/backend.ts` header]], open at 20 kHz (transparent) and closed to **800 Hz** under water over
  0.15 s; the music element's volume × 0.5;
- an underwater bed: brown noise through a 300 Hz low-pass with a slow 0.1 Hz swell, synthesized in WebAudio (no
  asset, no download), gain 0.35 on the ambient bus;
- bubble blips: a 40 ms sine sweep 400 → 1,200 Hz with a short noise click, on each exhale near the listener;
- the clam's open and close: a low wooden "tok" (synthesized), the coffer: the retail chest/item sounds already
  exported (SOUND's loot cues);
- the sighting: a long low call (two detuned sines with a slow glide), once, when the creature passes within 30 m.

---

## 5. Sea life (`World.sea`)

### 5.1 Common rules [decision]

- **Client-only and cosmetic:** no protocol, no server state, not pickable, no collision, no nav (GRASS_LIFE §5.1's
  rules). Each client spawns its own animals around its own eye, seeded by 32 m cell and game hour, in fixed pools with
  no allocation per frame. The event creatures (§6.3) are the exception: their paths come from the shared clock.
- **Only near water and only drawn under water.** The part updates when the eye is within 60 m of a dive zone; its
  meshes are visible only while `World.underwater.on` (fish are invisible from above through the sea) [decision].
- **Threats:** the same feed as the life part (`setThreats`: every actor the client knows; a diver is an actor).
- **Lighting:** the materials are built on the grass skeleton like the life part's, plus the underwater chunk
  (§4.2–4.3 as shared WGSL/GLSL functions), so caustics and absorption match the PBR world [decision].
- **Options → Wildlife** (W10-G) switches the sea life too.
- **Low draws none** (the Low guard: the life part is null on Classic). The event creatures are not life (§6.3).

### 5.2 Fish [prototyped]

- **One procedural mesh for every fish** (a spindle 8 around × 6 along with a forked tail and a dorsal fin: 66
  triangles in the prototype) with per-species proportions, scale and a **three-band painterly palette** (back,
  stripe, belly) carried in the instance record; the tail wag in the vertex shader (weight from the body position,
  phase from the instance's position) [confirmed: `uwFish`, 36 fish, 1 draw].
- **Schools** (CPU boids, the prototype's `updateSchool`): cohesion to a centre that wanders a slow loop around an
  anchor, a tangential swirl so the school mills, separation within 0.6 m, alignment within 1.5 m, a floor 0.8 m over
  the bed and a ceiling 1 m under the surface; speeds 0.5–1.4 m/s.
- **Flee** [confirmed: prototype]: within **6 m** of a threat every fish darts away at up to 4.5 m/s, then the school
  reforms around its centre over 3–6 s. GRASS_LIFE's flock-flush numbers for birds were 9 m; fish are bolder.
- **Reef dwellers:** 1–3 fish hovering near a rock or the wreck (a "dwell" spot from the dressing's rocks), turning to
  face the current, hiding behind the rock when a threat comes within 4 m.
- **Species** (the sea rows of `content/sea/species.json`, the ids FISHING's catch table uses, §2.2), for example: silver sardine (schools of 24–40), golden-line bream
  (schools of 8–16), coral snapper (dwellers, red-orange), blue-tang-like reef fish (dwellers), sea bass (lone, 0.6 m),
  and the rare catches the fishing spec names (§6.4).
- **CPU:** the prototype's 36-fish update (an O(n²) neighbour loop) is below Chrome's 0.1 ms timer resolution (the
  CPU p50 is 0.7 ms with and without the school) [confirmed: §8.3]; production uses a 1.5 m grid for the neighbours,
  so 120 fish stay ≤ 0.15 ms [projected].

### 5.3 Crabs

- The retail crab (`res/mob/asiam/crab`, 998 triangles, 60 joints) at 0.12 scale, **STAND1 + WALK baked to one VAT**
  with the town's pipeline (`town/vat.ts`), thin instances, 1 draw [decision; the model and clips confirmed by the
  scratch conversion].
- Behaviour: idle on sand within 20 m of rocks, a sideways scuttle of 1–3 m every 4–10 s, a dash to the nearest rock
  when a threat is within 3 m (with a sand puff).
- 6 on Medium, 10 on High+.

### 5.4 Gliders and jellies [prototyped: `turtle.glb`, `ray.glb`, `jelly.glb`]

| Creature | Mesh | Motion | Count (Medium / High) | Draws |
|---|---|---|---|---|
| Sea turtle (common, 0.9 m) | bpy, 308 triangles; flap weight in the vertex colour's alpha | slow loops 2–4 m over the bed, a flipper stroke every 2–3 s; ignores divers beyond 2 m | 1 / 2 | 1 |
| Ray (1.6 m span) | bpy, 433 triangles; wing weight by span | glides 1–2 m over the sand; lifts off with a sand puff when a threat is within 4 m | 1 / 2 | 1 |
| Jellyfish | bpy, 184 triangles; the bell rim and the tentacles pulse | drift in the upper 5 m, mostly at dusk and night, **glowing at night** (emissive × night) | 6 / 12 | 1 |

- The flap is one vertex-shader line per kind (`CUSTOM_VERTEX_UPDATE_POSITION`, weight = vertex alpha) [confirmed:
  roles `flap`, `pulse` in the prototype].
- **Look verdict of the bpy side** [confirmed: shots]: the jelly reads as a jellyfish (`dev-jelly.png`); the ray reads
  as a ray at 3–10 m (`dev-ray.png`; its back colour washes out to pale blue under the absorption, so the palette needs
  a darker back); the turtle reads as a turtle at 10 m and as programmer art at 2.6 m (`dev-turtle.png`: faceted
  shell, flippers like wings, the painted scutes lost). Good enough for the common turtle that keeps its distance, not
  for the hero (§5.6).

### 5.5 Gating and counts

| | Day | Dusk / dawn | Night | Storm |
|---|---|---|---|---|
| Fish schools | 2 (Medium), 3 (High) | 2 | 1, slower, darker palette | 1, near the bed |
| Reef dwellers | 8 / 16 | 8 / 16 | 4 / 8 (hiding by rocks) | 4 / 8 |
| Crabs | 6 / 10 | 6 / 10 | 6 / 10 (more active) | 3 / 5 |
| Turtle, ray | 1 + 1 / 2 + 2 | 1 + 1 (+ the dusk manta, §6.3) | 0 | 0 |
| Jellies | 2 / 4 | 6 / 12 | 6 / 12, glowing | 0 |

Totals: Medium ≤ 70 fish + 6 crabs + 2 gliders + 6 jellies; **≤ 5 draws** (fish, crabs, turtle, ray, jellies).

### 5.6 The Meshy bake-off (for the build; ≤ 40 credits) [decision]

- **What the design did:** the bpy route for all three creature kinds (3.1 s of Blender in all, [confirmed:
  `creatures/report.txt`]) and its look in game (§5.4). **0 credits were spent**: spending the user's credits and
  downloading the generated files are actions this agent takes only on the user's own word in chat, and the Meshy
  permission reached it relayed through the workflow. **Balance: 1,840 credits** [confirmed: re-read by the
  fact-check at 2026-10-02 09:07Z through the repo's `MeshyClient` (`GET /openapi/v1/balance`, the key never printed,
  no job), equal to WAVE_PLAN8 §0.3's figure].
- **What the build runs** (lane UW-D, ≤ 40 credits, counted in WAVE_PLAN9's build cap, each job a NIGHT_LOG row,
  through `MeshyClient` only):
  - **J1 image-to-3D, the Jade Tortoise** (30 credits by wave 12's price [confirmed: NIGHT_LOG 15:18]): from a concept
    image painted locally (the bpy turtle rendered in Blender, painted over with the local SDXL on the GPU queue, no
    download) with the prompt "stylized hand-painted giant sea turtle, jade-green shell with gold rim, game asset",
    remeshed to ≤ 3,000 triangles, textured 1K.
  - **J2 retexture of the bpy turtle** (10 credits [confirmed: NIGHT_LOG 15:22]) with the same concept as the style
    image, original UVs kept (an opaque creature keeps its material; wave 12's failure was the cut-out leaf cards).
    Wave 12's retexture also **dropped the extra vertex attributes and normalised the scale to ≈ 1 m** [confirmed:
    NIGHT_LOG 15:22], so the flap weights (vertex alpha) and the scale are re-applied in bpy after either job, and
    J1's 2K texture (wave 12's came back as a 4.3 MB JPEG) is resized locally to 1K before the size check.
- **The gate:** the three candidates (bpy, J1, J2) side by side in the prototype at 2.5 m and 10 m, under the same
  water; the user picks on one sheet (§12); the default is J1 if its silhouette and palette pass the painterly rule
  (no photoreal skin, ≤ 3k triangles, ≤ 1.5 MB with its texture), else the bpy turtle with a hand-tuned palette.
- The flipper animation is ours either way: the build weights the flippers in bpy by distance from the shell's
  outline into the vertex alpha (the `flap` role) [decision: no Meshy rig].

---

## 6. Underwater events

### 6.1 The Dragon King's sunken shrine (S1 reef, ≈ 12 m) [decision]

The sea is the Dragon King's (龙王) in Chinese folk belief; a small sunken shrine is the most Silkroad-flavoured thing
to find on the bed.

- **Look:** the retail stone tortoise at 0.13 (≈ 4.5 m) bearing a stele, a ring of retail rocks, seagrass, two bronze
  lanterns that glow at night (light points: the night lights work under water; their splat on the bed is the
  existing per-region one), the wreck 35 m north-west as a landmark.
- **The offering coffer** (an interactable, §6.5): once per player per day (the quests' 04:00 reset), a dive-down
  "Search the coffer" gives a small treasure: 300–800 gold × the gold rate, 25 % one Sea Pearl, 5 % a
  degree-appropriate ring from the existing drop tables [decision: about 10–15 minutes of frugal hunting at levels
  10–20, BALANCE §5.1–5.2; a reason to dive daily, not a farm]. **Level 10 or higher** for the coffer and the clams'
  pearls (fail reason `level`) [decision, fact-check F10: claims are per character, so without a gate a fresh level-1
  alt could collect ≈ 3,000 gold a day (coffer + three clams) and trade it to a main; at level 1 that is three times
  BALANCE's whole degree-1 shop row].
- **The sealed coffer** next to it opens only with the **Rusty Bronze Key** (a rare fishing catch, §2.2), consuming
  it: 1,500–3,000 gold, one Black Pearl, and 10 % the **Dragon King's Pearl Necklace** (a level-15 necklace a little
  above the shop's degree-2 necklace; BALANCE owns the stats) [decision].
- **Wave-14 hook:** the shrine's stele carries an inscription line (a rumour) that wave 14 can point at the Qin-Shi
  Tomb; this spec writes no tomb content.

### 6.2 Giant clams and gatherables [decision]

- **Three giant clams** (new bpy model, two shell halves, ≈ 300 triangles, painterly blue-violet mantle) at the reef
  and by the wreck. Each opens for **40 s every 4 min**, offset per clam, **from the world clock** (`seaEventsAt`), so
  everyone sees the same clam open; the client animates the halves from the clock (no message).
- **Take the pearl** while it is open (§6.5): once per clam per player per day: Sea Pearl 90 % (sells for ≈ 600),
  Black Pearl 9 % (≈ 2,500), **Dragon Pearl** 1 % (a quest and crafting item, a wave-14 hook). A closed clam says
  "The clam is shut tight. Wait for it to open."
- **Gatherables:** 6 kelp clumps and 6 sea-urchin spots at the reef, each a node that respawns 5 minutes after a pick
  (per node, shared, like a ground item); a pick gives 1–2 Kelp or 1 Sea Urchin (cooking ingredients: Kelp counts as
  Waterweed, Sea Urchin as Mud Crab, FISHING §7.2); **2 gold each to a shop**, and **30 picks per character per real
  day** (then "You have gathered enough for today.", fail reason `claimed`) [decision, fact-check F9]. Why: the first
  draft's 30–60 gold per item made the 12 nodes worth ≈ 8,000 gold an hour to one camper (12 nodes × 12 respawns × ≈
  1.25 items × 45 gold), as much as frugal hunting (BALANCE §5.1: 6,000–12,000) with no monster and no potion, i.e.
  the ideal bot farm; at 2 gold and 30 picks it is ≈ 90 gold a day, and the value is the cooking.

### 6.3 Sightings [decision]

All three are paths and windows computed by `seaEventsAt(serverMs, clock, weather)` (shared, pure in those inputs,
seeded by the real day index, §6.5), so every
client draws them in the same place at the same time and the server knows them without a message.

| Sighting | When | What | Reward / tie-in | Presets |
|---|---|---|---|---|
| **The Jade Tortoise** | 2–3 windows per real day, 4 min each, at varied hours (≈ 1 in 8 one-hour sessions catches one at S1) | the hero turtle (2.5 m, §5.6) glides a 300 m loop past the shrine, the clams and the wreck | a system chat line to players within 400 m of S1 when it starts ("A Jade Tortoise has been seen off South Beach!"); **fishing within 80 m of its path: rare catches ×2** (§2.2); swimming within 4 m of it gives **"Tortoise's Calm"**: +10 % EXP for 15 min, once per window [decision; BALANCE checks the size]; it adds to kill EXP in S-REWARD's one order, `exp = e × (1 + meal + calm) + rest(e)`, never to Rested or quest EXP [confirmed: FISHING §7.3 already writes it so, with HOT_SPRINGS' `killBonus`] | every preset (Low draws it with the Classic material) |
| **The dusk manta** | every dusk (sun −2°…+6°), 3 min | a 4 m manta (the ray mesh scaled, darker palette) passes over the reef | none (a sight) | Medium+ |
| **The Sea Dragon's shadow** | only in a storm, ≤ once per real day | a long sinuous silhouette (a 60 m ribbon mesh, black, no detail) crosses at the edge of visibility (40–45 m), with the low call (§4.8) | a chat line; nothing else. **The wave-14 hook:** the storm event slot that the storm Qilin can share (`seaEventsAt` reads the weather state the server already broadcasts) | Medium+ |

### 6.4 Fishing tie-ins (summary)

1. Shared species ids (§2.2): the schools you swim through are the catch table's fish.
2. The **Rusty Bronze Key** (rare catch) opens the sealed coffer (§6.1).
3. The **Jade Tortoise** window doubles rare catches near its path (§6.3).
4. **Kelp** and **Sea Urchin** (gathered) feed cooking (§6.2).
5. Pearls are not food; they sell, and the Dragon Pearl is a wave-14 crafting hook.

### 6.5 Server: `apps/server/src/sea.ts` and the protocol [decision]

- **Module** (a `GameplayModule` like `uniques.ts`): loads `content/sea/jangan-sea.json` (`interact` rows, the
  gatherables) and `content/sea/events.json` (loot tables, windows, the blessing), registers the interactables as
  **NPC-kind entities** with codes `NPC_SEA_COFFER`, `NPC_SEA_SEALED`, `NPC_SEA_CLAM`, `NPC_SEA_KELP`,
  `NPC_SEA_URCHIN` (no new entity kind: an NPC already has a model, a position, a name and a click) at their bed
  height (`EntityState.pos.y` = the bed + 0.3 m). Each code needs an **`NpcDef` row** (`packages/shared/src/content.ts`
  `NpcDef`; the client resolves an NPC's model from its `NPC_*` code [confirmed: `EntityState.model` doc comment]) in
  the sea content, mapped to the scratch-built models, and **the client places them by the bed, not by
  `WorldGround.heightAt`**: that query returns the walkable surface nearest a hint (the plaza, a bridge, a nav plane)
  [confirmed: `world/ground.ts`], and the coast regions at S1 carry nav planes [confirmed: region 170_89's navmesh
  `planes`], so a snapped coffer could float at a plane instead of resting on the sand [likely] (fact-check F11).
- **One request:** `{ t: 'seaUse'; id: number }` (rate-limited like `pickup`). Checks in order: `dead`; the entity is
  a sea interactable; **within 3.0 m horizontally**; **diving** and, if S-DEPTH gives depth, within 3 m of the object's
  depth; per kind: the clam open (`seaEventsAt`), the coffer not claimed today, the key in the bag, the node not on
  cooldown, the character's level ≥ 10 for the coffers and the clams, the 30-pick daily cap for the nodes; inventory
  space. Fail reasons: `not_diving`, `too_far`, `closed`, `claimed`, `need_key`, `cooldown`, `level`,
  `inventory_full`. Success: the normal inventory and gold messages plus a system line ("You found a Sea Pearl.").
- **One table:** `sea_claims(char_id, key, day)` for the daily coffer and clam claims and the daily pick count; node
  cooldowns are in memory (a restart refills nodes, which is harmless). **Its migration number is the next free one
  after the wave's other two: 13 by default** (fact-check F1: the first draft took 11, but HOT_SPRINGS §6.2 also takes
  11 and FISHING §8.6 takes "the next after HOT_SPRINGS'"; `db.ts` holds 10 today, `SCHEMA_VERSION =
  MIGRATIONS.length`, and WAVE_PLAN8 adds none [confirmed]); WAVE_PLAN9 numbers the three. The day key is the
  quests' reset day (`QUEST_DAILY_RESET_HOUR` = 4, server local time [confirmed: QUESTS.md, `config.ts`]).
- **Gates** (the wave-8 locks): `seaUse` is refused while mounted (a horse cannot dive) and in a trade or stall like
  `pickup` [decision].
- **No hostile mobs under water this wave** [decision: combat while swimming needs rules the swimming spec does not
  have]; `content/sea/events.json` reserves `mobs: []` for wave 14.
- **Clock** [decision, fact-check F14]: `seaEventsAt(serverMs, clock, weather)`. The clam cycle and the sighting
  windows run on the **server's real time** (every client already estimates it: `net/clock.ts` `ServerClock`
  [confirmed]), so a GM `time freeze` or `time hh:mm` does not stop the clams; the dusk manta reads the world clock's
  solar time; the Sea Dragon's storm slot reads the broadcast weather (its seeded schedule or a GM hold
  [confirmed: `weather.ts`]). "Pure" means pure in those three inputs.
- **GM:** `/sea events` (lists today's windows), `/sea spawn tortoise` (starts a window now, for testing), `/sea reset`
  (clears the GM's own claims). A GM window is not in the schedule, so it is told to clients by **one additive
  server → client message** `seaHold { kind, startAt }` (sent only on that command and to late joiners while it runs;
  absent = the schedule) [decision, fact-check F14: without it the server would double rare catches around a tortoise
  that no client draws].
- **Quests hook:** QUESTS' `reach` objective can target the shrine (`LOC_SEA_SHRINE`, added to the locations list),
  and `deliver` can take a Sea Pearl; the custom quest itself (e.g. an old fisherman on S1 asking for a pearl) is the
  quests content lane's, not designed here.

---

## 7. Presets and the Low path

| | Low (Classic) | **Medium (default)** | High | Ultra |
|---|---|---|---|---|
| Underwater state | yes | yes | yes | yes |
| Absorption | Classic linear fog swapped to the water colour, 30 m end; the Classic sky dome hidden (clear colour) | per-channel, PBR plugin | same | same |
| Caustics | none | under water | + from above in the shallows (≤ 4 m) | same as High |
| Surface from below | two-tone window (Classic ocean and water shaders) | Snell's window, worker-tile normals | GPU-FFT normals (WebGPU) | + the near-field detail |
| God rays | none | 10 | 16 | 16 |
| Plankton | none | 27 × 90 | 27 × 140 | 27 × 140 |
| Bubbles | none | ≤ 64 | ≤ 128 | ≤ 128 |
| Sea life | none (the Low guard) | ≤ 5 draws, §5.5 Medium | §5.5 High | High |
| Event creatures, interactables | yes (Classic materials) | yes | yes | yes |
| Plants (seagrass, kelp, reef) | none | yes | yes | yes |
| Rocks, wreck, shrine (placements) | yes | yes | yes | yes |
| Bed regions | drawn under water | same | same | same |
| Far plane / shadows under water | 90 m / – | 90 m / 40 m | 90 m / 40 m | 90 m / 60 m |
| Sound | low-pass, bed, blips | same | same | same |

- **The Low guard:** with the camera above water nothing on Low changes [decision]; under water Low changes only its
  fog colour and range, the dome's visibility and the Classic ocean's uniform branch. The Low guard tests run with the
  camera above water and stay green; a new Low test checks the under branch compiles and that above-water output is
  byte-identical (§14).
- **WebGL2** takes the Medium and High paths unchanged (§4.5) [confirmed: the prototype on WebGL2 rendered every
  feature, `dev-gl-dive.png`].

---

## 8. The prototype

### 8.1 What was built [confirmed]

`work/tmp/underwater/` (scratch; run `cd apps/viewer && pnpm exec vite --config ../../work/tmp/underwater/vite.config.mjs`,
then `http://127.0.0.1:5297/underwater?view=dive|up|deep|school|beach&engine=webgpu|webgl&uw=0|1`):

- `uw.ts`: the real `loadWorld` (Medium, PBR, streaming, region batching, the ocean, the sky at noon) on
  jangan-fields, the camera 7 m under the sea off S1, and:
  - `UwPlugin`, registered for every PBR material before the world loads (`?uw=0` registers nothing): caustics at
    `CUSTOM_FRAGMENT_BEFORE_LIGHTS`, absorption at `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR`, both behind uniforms; roles
    for the surface (Snell's window), the fish (tail wag), the seagrass (sway), the rays (additive shafts), the
    creatures (flap, pulse); WGSL and GLSL;
  - the bed skin from field B (§3.1's fallback), the surface disc, a water-coloured backdrop, 14 god-ray shafts,
    plankton (27 × 90), one school of 36 fish (CPU boids, flee within 6 m of the diver), a reef (5 retail rocks, 260
    seagrass clumps);
  - `uw.place()` for scratch props (the wreck, the tortoise, the crab from `conv/`), `uw.creature()` for the bpy
    creatures, `uw.bench()`, `uw.shot()`, `uw.set()` toggles.
- `creatures.py`: the bpy turtle, ray and jellyfish (§5.4), exported to `creatures/*.glb` with `report.txt`.
- `conv/`: the scratch conversion of the six retail candidates (§1.3).
- `shots/`: every image and the bench JSON.

### 8.2 Method

- Dev PC (Ryzen 5 9600X, RX 9060 XT), Chrome's pane, **1920 × 1080 at device pixel ratio 1** (viewport emulation),
  WebGPU unless noted, Medium, noon (t 0.5), weather off.
- A private Vite on :5297 serving `work/out` (the dev servers :5180, :7000, :5173 untouched; no game server needed:
  the page is the renderer alone, like the World Editor prototype).
- Frames driven by a MessageChannel pump (the pane is hidden), **400 uncapped frames per run after streaming went
  idle, 3 runs per scene, the median of the runs' p95**; the frame interval, the CPU time of `world.update` + render
  submit, the draw count, and on WebGPU the main pass's GPU time (`enableGPUTimingMeasurements`).
- **The GPU lock** `work/tools/gpu.lock`, taken by this spec (owner "underwater-bench") once the wave-12 and
  hot-springs runs had released it, at 08:50:15Z, and removed at ≈ 08:57Z; the four pages (WebGPU Medium, WebGPU
  Medium without the plugin, WebGL2 Medium, WebGPU High) and the Low shot ran back to back inside it.
- **A quiet machine:** the 30 s window before the first page read 10.4 % mean CPU, 24.6 % max
  (`w11-rescue-gate/tools/quiet.ps1`); during the runs the whole machine, the page itself included, read 30.6 % mean,
  37.3 % max.

### 8.3 Results

All runs: 400 uncapped frames × 3 per scene; "frame p95" is the median of the three runs' p95 (the three in
brackets); GPU is the WebGPU main pass (`gpuTimeInFrameForMainPass`), whose timestamps here come in ≈ 0.065 ms steps.
Raw data: `work/tmp/underwater/shots/bench-*.json`, summary `bench-table.md` (`table.py`) [confirmed].

**WebGPU Medium** (the default), the S1 reef 7 m down unless noted:

| Scene | Frame p95 (runs) | CPU p50 / p95 | GPU main p50 / p95 | Draws |
|---|---|---|---|---|
| Beach above water, plugin attached (off) | 1.4 (2.1, 1.4, 1.1) | 0.7 / 1.0 | 0.52 / 0.52 | 24 |
| Beach above water, **no plugin** (`?uw=0`) | 1.3 (2.0, 1.3, 1.3); again 1.3 | 0.6–0.9 / 1.0–1.2 | 0.52 / 0.52–0.59 | 21 |
| **Dive, every feature on** | **1.4** (1.4, 1.4, 1.4); again 1.6 | 0.7 / 1.0–1.2 | **0.59 / 0.66** | 19 |
| Dive, today's look (all off, the ocean drawn) | 1.4 (1.1, 1.4, 1.5) | 0.6 / 1.0 | 0.52 / 0.59 | 13 |
| Dive, today's look, no plugin | 1.7 (1.5, 1.7, 1.8) | 0.6 / 1.4 | 0.52 / 0.59 | 13 |
| Dive, caustics off | 1.3 | 0.8 / 1.0 | **0.46 / 0.46** | 19 |
| Dive, rays / plankton / fish / seagrass / surface / skin off (one at a time) | 1.4 / 1.6 / 2.0 / 1.4 / 1.5 / 1.4 | 0.7–0.8 / 0.9–1.5 | 0.59–0.72 / 0.59–0.79 | 18 |
| Dive, far plane 90 m | 1.3 | 0.7 / 1.0 | 0.52 / 0.59 | 19 |
| Looking up, every feature on | 1.1 | 0.6 / 0.9 | **0.20 / 0.26** | 12 |
| Looking up, today (the ocean from below) | 1.8 | 0.6 / 1.4 | 0.59 / 0.66 | 6 |
| Deep (the bed skin, 19 m) | 1.3 | 0.7 / 0.9 | 0.39 / 0.46 | 11 |
| At the school | 1.4 | 0.8 / 1.1 | 0.66 / 0.66 | 20 |

**WebGL2 Medium:** beach (plugin off) 0.8; dive, every feature on **2.6–2.8** (CPU p50 1.2, p95 2.7); caustics off
2.1; today's look 0.6; looking up 1.2; deep 2.0; 19 / 13 / 12 / 11 draws.

**WebGL2 Medium, fact-check re-run** (F8; 2026-10-02 09:24–09:28Z, the GPU lock held as "underwater-factcheck", the
30 s before at 8.7 % mean / 12.5 % max CPU, the same page and method, 1920 × 1080 at DPR 1, 3 × 400 frames per row;
raw `shots/fc-webgl2-*.json`) [confirmed]:

| Scene (dive view unless noted) | Frame p95 (runs) | CPU p50 / p95 |
|---|---|---|
| Every feature on | **2.6** (2.7, 2.6, 2.6); again 2.5 (2.4, 2.6, 2.5) and 2.5 (2.2, 2.5, 2.6) | 1.1 / 2.6 |
| Every feature, **render scale ½** (960 × 540) | 1.0 (0.6, 1.0, 1.3) | 0.4 / 1.0 |
| Every feature, the uw uniforms **frozen** (no per-material upload) | 2.2 (2.2, 2.3, 2.0) | 1.1 / 2.2 |
| Every feature, **plankton off** | 0.6 (1.3, 0.6, 0.6) | 0.3 / 0.5 |
| Every feature, **the plankton's buffer upload skipped** (the same specks drawn) | **0.8** (1.2, 0.8, 0.7) | 0.5 / 0.7 |
| Every feature, rays off | 2.2 (2.4, 2.2, 2.1) | 1.1 / 2.1 |
| Every feature, rays and plankton off | 0.6 | 0.3 / 0.5 |
| Absorption only / absorption + caustics (no props, the ocean hidden) | 0.4 / 0.5 | 0.2 / 0.4 |
| Today's look | 0.4 (1.1, 0.4, 0.4); at ½ scale 0.4 | 0.2 / 0.4 |
| Deep (the skin) | 1.8 (0.5, 2.1, 1.8); at ½ scale 0.5 | 0.6 / 1.8 |
| Beach above water, plugin attached / **no plugin** (`?uw=0`) | 0.6 (0.6, 0.6, 0.7) / 0.6 (0.8, 0.6, 0.6) and 0.8 (0.7, 0.9, 0.8) | 0.4 / 0.6–0.8 | **WebGPU High:** beach 3.1 (GPU 1.51);
dive every feature on 3.3 (GPU **1.31 / 1.44**, 31 draws); caustics off 3.3 (GPU 1.18 / 1.31); today 3.4 (GPU 1.31);
looking up 4.1 (GPU 0.85); far plane 90 m 3.1 (GPU 1.31, 29 draws). **Low** (Classic, today's look only, no GPU
timer): 0.5, 10 draws.

What the numbers say:

- **The underwater scene is cheap** [confirmed]: 1.4–1.6 ms p95 on Medium WebGPU, 2.6–2.8 on WebGL2, 3.3 on High,
  against the 16.7 ms line. It is a sparse scene (the reef, the skin, the backdrop): the bed region rows hold no
  buildings, and the absorption hides everything past ≈ 45 m.
- **Every feature together** costs ≈ +0.07 ms of GPU on Medium WebGPU over today's (wrong) underwater view: the
  caustics add 0.13 ms, and hiding the ocean's FFT-shaded sheet gives some back. Looking up, the window costs 0.20 ms
  against the ocean's 0.59.
- **Above water the plugin costs nothing measurable** (the beach: 1.3–1.4 ms p95, 0.52 ms GPU either way).
- **The rays, plankton, school, seagrass, surface and skin** are each below the timer's step; their draws are the
  cost (+6 under water).
- **WebGL2's extra ≈ 2 ms is a buffer stall, not the shading** [confirmed: the fact-check re-run above; F8 corrects
  the first draft, which blamed the per-material uniforms and called the fog's state "scene-level"]. Absorption and
  caustics cost ≈ +0.1 ms of frame on WebGL2. The prototype re-uploads the plankton's 27-matrix thin-instance buffer
  every frame although it only changes when the eye crosses a 10 m cell; skipping that upload takes the scene from
  2.6 to 0.8 ms, and the cost halves at half resolution, the signature of the CPU waiting on the GPU (ANGLE) rather
  than of JavaScript work. The uniforms are the smaller part: freezing them saves ≈ 0.4 ms. Note that the height fog
  plugin uses the same per-material `ubo.updateFloat4` path [confirmed: `pbr/fog-plugin.ts` `bindForSubMesh`];
  Babylon only re-uploads a material's block when a value changed [confirmed: `uniformBuffer.js` `updateUniform`],
  and the prototype's animated time changed it every frame. **Production rules** [decision]: (1) an instance buffer is
  uploaded only on the frames it changes (plankton: on a cell change; rays: the lattice only when the eye crosses
  7 m, the flicker in the shader); (2) the time and eye-dependent values come from the scene block (`vEyePosition`)
  or one shared uniform buffer bound by name (`MaterialPluginBase.getUniformBuffersNames` [confirmed: Babylon 9.28 `materialPluginBase.pure.d.ts`]), so a material's own block
  changes only on the 0.25 s blend; (3) the boids' per-frame buffers (fish, jellies) are the exception and LAB-13
  times them on WebGL2 (the prototype's school showed no stall: fish off = all on).
- **WebGL2 laptops:** the stall grows with the GPU's frame, so on a slower GPU it would have been worse than 2 ms;
  with rule (1) the remaining WebGL2 delta is the shading, which WebGPU puts at ≈ +0.07–0.13 ms on the dev GPU.
- **The far-plane cut** saves 2 draws here (the scene is sparse); its value is in the 20-diver scene, where it bounds
  what the frustum keeps.
- **Not measured** (§8.5): characters, the real ocean's under branch, bed regions, the full dressing.

### 8.4 What the prototype showed about the look [confirmed: the shots]

- `dev-dive-6.png`: the reef at 10–13 m: sand with caustics, rocks, seagrass, a shaft, the school, plankton. The
  scene reads as under water at a glance; the far field is blue-green, the near sand warm.
- `dev-up-5.png` (WebGPU) and `dev-gl-up.png` (WebGL2): Snell's window with a sun spot, the dark total-reflection
  ring outside it. The sky inside is a little pale and flat; production samples the real sky cube (§4.5) instead of
  the prototype's two-colour gradient.
- `dev-wreck-1.png`: the retail takla ship reads as a wreck (torn sails, broken mast); the straight line across the
  middle distance is the skin/terrain seam at a grazing angle (§3.1's reason for bed regions).
- `dev-school-1.png`, `dev-hero-1.png`: the school is too ball-shaped; production adds a stretched mill (an ellipse
  centre path) and per-fish speed noise.
- `dev-turtle.png`, `dev-ray.png`, `dev-jelly.png`: §5.4's verdict.
- `today-dive.png`, `today-up.png`: §1.1.
- Colours were tuned twice: the first pass (`dev-dive-2.png`, `dev-up-3.png`) was far too bright and cyan (the
  inscatter in keyLight units × the noon exposure ≈ 7.8); the tuned base is (0.004, 0.042, 0.066) and σ (0.24, 0.07,
  0.06).

### 8.5 Limits of the prototype

- One reef, one school, no players, no ocean under-branch (a stand-in disc), no bed regions (the skin), no sound, no
  server; Low only as today's look (`today-low-dive.png`: the Classic ocean as a ceiling, the bed's edge, the sky
  below it, 0.5 ms); the Classic under path is a design (§4.5, §7).
- Single-run outliers (one 9.2 ms run with plankton off, 2.0 ms with the school off) are noise of a 1.4 ms scene;
  the medians are what the tables use.
- The seagrass and the fish are the prototype's quick meshes; the reef plants, kelp and clams were not built.
- The CPU numbers include the prototype's O(n²) school, per-frame `thinInstanceRefreshBoundingInfo` calls on three
  meshes and per-frame instance uploads (the WebGL2 stall of §8.3); production sets fixed bounding boxes and uploads
  only on change.
- The wave-12 working tree was mid-build (§0 header); world-render files it touches were not used by the prototype's
  own code, but the page ran on them.

---

## 9. Budgets

### 9.1 Per preset (WAVE_PLAN8 §5 format; 1080p, dev PC)

**What the item adds per preset** (WAVE_PLAN8 §5.1 shape):

| Preset | Above water | Under water |
|---|---|---|
| Low (Classic) | nothing | the fog colour and range, the dome hidden, the two-tone surface; bed regions; the interactables and event creatures; no life, no plants, no particles |
| **Medium (default)** | the plugin's uniform test; the bed regions invisible | absorption, caustics, Snell's window, 10 rays, plankton, ≤ 64 bubbles, plants (≤ 4 draws), sea life (≤ 5 draws), far plane 90 m, shadows 40 m, actors to 45 m |
| High | + caustics in the shallows (≤ 4 m) | as Medium + 16 rays, more life (§5.5), GPU-FFT normals in the window |
| Ultra | as High | as High, shadows 60 m |

**Frame p95 on the dev PC, ms (WebGPU / WebGL2):** measured where the prototype could (§8.3), projected where it
could not.

| Preset | Beach noon, above water | The S1 reef, nobody (the prototype scene) | **The reef with the full dressing and sea life** | **G1-UW: 20 divers at the shrine during a sighting** | Pass line |
|---|---|---|---|---|---|
| Low | unchanged (1.7 / 1.1 at the G-11 rescue gate) | 0.5 (today's Classic look) [confirmed] → ≈ 0.6 with the fog swap [projected] | ≈ 0.8–1.2 [projected: + the wreck, rocks, shrine in the batch] | below Medium | pass |
| **Medium** | within noise of today [confirmed: plugin on/off 1.4 / 1.3 WebGPU, 0.6 / 0.6–0.8 WebGL2 (fact-check)] | **1.4–1.6 / 2.6–2.8** as prototyped [confirmed]; WebGL2 **0.8** with the plankton upload skipped [confirmed: F8] → ≈ 0.6–1.0 with production's upload rules [projected] | ≈ 2.0–2.6 / ≈ 1.2–2.0 [projected: + 4 plant draws, + 4 life draws, + 5 bed regions, + ≈ 0.3 ms GPU; WebGL2 + ≈ 16 draws of CPU] | **≈ 6.5–10 / ≈ 5–8.5** [projected, §9.2] | **G1-UW < 16.7: pass with ≈ 6.5–10 ms spare** (≈ 3.5–8 after wave 11's later-page penalty) |
| High | 3.1 (WebGPU, plugin attached) [confirmed] | 3.3 (GPU 1.31) [confirmed] | ≈ 3.8–4.5 [projected] | ≈ 9.5–13 (WebGPU) [projected] | reported (G2 scenes are town scenes) |
| Ultra | as High | as High | as High | not a target | G3 only |

| Preset | Draws added under water (reef view) | GPU added (dev) | Mid desktop (CPU × 1.5) | Laptop / M1 | VRAM added | Download added |
|---|---|---|---|---|---|---|
| Low | ≈ +4 (bed regions in view, the event creature) | ≈ 0 | unchanged | N100 class: ≈ +0.2 ms [projected] | ≈ +1.5 MB (bed regions resident) | ≈ +0.25 MB (5 bed regions) + ≈ 0.3 MB of sea models |
| **Medium** | **+6 measured** (prototype) → ≈ +16 with the full dressing and life (4 plants, 5 life, 3 effects, ≤ 5 bed regions in view, the backdrop; the ocean −1, the far plane −2) | **+0.07 measured** → ≈ +0.3–0.5 ms with the full scene [projected] | ≈ +0.5–0.8 ms CPU (≈ 16 draws × 18 µs, the boids ≤ 0.15, the state ≤ 0.05) | **M1 GPU ≈ +2.7–5.5 ms** under water (× 9–11 of the projected +0.3–0.5 dev delta; fact-check F16: the first draft's +1–3.5 did not follow from its own numbers), on top of the reef's own ≈ 5–6.5 ms (× 9–11 of 0.59): an M1 holds 60 fps diving alone or with a few friends, not in G1-UW's crowd (the wave-11 plaza is already past it there); **0 above water** (the plugin is a uniform test; the beach margin G6 holds) | ≈ +5–7 MB (bed regions 2.3, the crab VAT ≈ 0.5, plants and creatures ≈ 1, the clam, the hero's texture ≤ 1.5) | ≈ +1.0 MB first dive at S1 (bed regions 0.25, models 0.5, the hero ≤ 0.3 compressed, VAT 0.1) |
| High | as Medium + 6 rays in one draw | ≈ +0.4–0.6 ms [projected] | as Medium | gaming laptop: comfortable | as Medium | as Medium |
| Server disk | | | | | | ≈ +2 MB (bed regions, models, the dressing) |

### 9.2 The G1 underwater scene

**The scene:** 20 divers (bots) swimming around the Dragon King's shrine at the S1 reef, 9–12 m down, at noon,
during a Jade Tortoise window; the full dressing (wreck, rocks, shrine, plants), the full sea life, everyone's bubbles,
Medium, both backends. It replaces nothing: it is a new LAB scene next to the plaza and the boss fight.

**Projection** [projected]:

- The reef itself: ≈ 2.0–2.6 ms WebGPU, ≈ 1.2–2.0 WebGL2 (the table above, with §8.3's upload rules).
- 20 player characters, from two wave-11 measurements [confirmed: `wave11/budgets.md`, the rescue re-bench, Medium]:
  Tiger Girl with 4 players 9.0 ms and with 20 players 15.0 on WebGPU (5.6 → 10.9 on WebGL2), i.e. ≈ 0.375 (0.33)
  ms per *fighting* player with hit effects; and the plaza with 20 monsters + 20 jumping players + the town at 14.9
  (10.3) against the empty plaza's 5.6–6.3 (3.4), i.e. ≈ 0.22 (0.17) ms per character, with the profile putting the
  20 attackers' entity loop at 4.6 ms against ≈ 1 ms for 20 jumping players. Divers are jumping players, not fighters
  (no effects; the swim clip): **≈ +4.5–7.5 ms WebGPU, ≈ +3.5–6.5 WebGL2** for 20 [fact-check F16: the first draft's
  +4–6 relied on the far plane and the 45 m cull, which do not shrink a crowd standing at the shrine].
- Bubbles for 20 divers: one pooled draw, ≤ 64 live (Medium).
- Total: **≈ 6.5–10 ms WebGPU, ≈ 5–8.5 ms WebGL2**. With wave 11's "later on the page" penalty (+1.5–3 ms) it stays
  ≤ 13 / ≤ 11.5.
- **Why it is lighter than the plaza:** no town crowd, no buildings, no monsters. The far plane and the 45 m cull help
  only when the 20 are spread over the zone.

**LAB-13 measures it** (the wave-11 harness with bots that dive, a temp DB copy, the GPU lock, a quiet machine), on
Medium WebGPU and WebGL2 first, then High. A miss turns on cuts 14–16 first, then halves the sea life on Medium.

### 9.3 Per-lane budgets (dev PC, 1080p, the GPU lock for every in-browser timing)

| Lane | Budget |
|---|---|
| UW-R plugin | above water: within noise of no plugin (both backends); under water: caustics ≤ 0.25 ms GPU, absorption ≤ 0.1 ms GPU at the S1 reef view; 0 new varyings (`installVaryingBudgetCheck` silent), 0 new texture units (`material-budgets.test.ts`) |
| UW-R surface | the ocean's under branch ≤ the ocean's above-water cost + 0.1 ms GPU |
| UW-R rays + plankton + bubbles | ≤ 3 draws, ≤ 0.2 ms GPU together; the update ≤ 0.05 ms CPU; **an instance buffer is uploaded only on frames it changes** (plankton on a 10 m cell change, the ray lattice on a 7 m change) and WebGL2 frame p95 with them on stays within + 0.2 ms of them off (the fact-check measured + 1.8 ms for the prototype's every-frame plankton upload, F8) |
| UW-C bed regions | 0 draws above water (`isVisible` false); under water ≤ +5 draws at S1; the convert ≤ +10 s |
| UW-L sea life | ≤ 5 draws; update ≤ 0.2 ms CPU (Medium), ≤ 0.35 ms (High); no allocation per frame; the per-frame boid buffers timed on WebGL2 (life on vs off within + 0.3 ms p95, F8's stall check) |
| UW-D plants | ≤ 4 draws (seagrass, kelp, reef, shells); ≤ 60 k triangles in view at the reef |
| UW-S server | `seaUse` ≤ 0.1 ms; `seaEventsAt` ≤ 0.01 ms (it runs every client frame for the clams) |
| UW-A audio | ≤ 0.05 ms main thread; ≤ 2 extra voices (the bed, the blips) |
| Together | the underwater G1 scene < 16.7 ms p95 on Medium, both backends; the beach above water within + 0.1 ms of G-11/G-12 (the M1 margin, WAVE_PLAN8 G6) |

### 9.4 Gates for this item

- **G1-UW:** Medium p95 < 16.7 ms in §9.2's scene on both backends; and every other LAB scene unchanged within noise
  (the plugin above water).
- **G4-UW:** 0 WebGPU validation errors; no new varying; ≤ 16 WebGL2 units; the Low guard green; the Classic above-water
  output byte-identical.
- **G5-UW (look):** one review sheet (the reef at noon, dusk and night; looking up; the wreck; the shrine; the school;
  the tortoise) approved by the user, like TREES' sheets; colours within the tuned medium unless the user asks.

---

## 10. Risks

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | The swimming spec chooses surface swimming only (no diving): nobody sees the bed | low (the user asked for "under water scenery") | S-ZONES and S-DEPTH defaults (§2.1); the WAVE_PLAN9 merge settles it first |
| R2 | 20 divers at the shrine miss G1 on WebGPU, as the 20-player plaza did in wave 11 | medium | the 45 m actor cull and the 90 m far plane under water (§9.2); the event creatures are single draws; cuts 9–16 |
| R3 | Every PBR shader grows by the caustics and absorption text (~70 lines): longer compiles at world load | medium | LAB-13 measures the warm-up time; the code is shared functions, one variant per material (no define flips at the surface) |
| R4 | (fact-check F15: the first draft's "the depth pre-pass renders the under branch twice" is stale: the ocean has no pre-pass since the CST-O spike, it writes depth in its colour pass, `needDepthPrePass = false` [confirmed: `ocean-plugin.ts`]) The under branch must bypass the P-LOOK alpha blend (`blendCode`: alpha = α + F(1 − α)) and write alpha 1, or the sheet from below stays partly see-through | medium | a test renders the branch and reads alpha 1 from below; the above-water output stays byte-identical |
| R5 | Motion sickness | low | no screen wobble, no lens distortion (§4.7); the camera rule keeps the waterline out of the frame |
| R6 | Clam and sighting timing drifts after a GM `/time` | low | `seaEventsAt` is pure in the clock; clients re-evaluate on every clock message (the town's H11-DET-1 fix is the precedent) |
| R7 | The retail ruined ship is a desert ship (sun-bleached planks) | low | the absorption tints it; the review sheet decides; other retail wreck pieces exist (§1.3) |
| R8 | Meshy's tortoise is off-style (photoreal skin, too many triangles) | medium | the gate in §5.6, the bpy fallback, cut 11 |
| R9 | The sealed coffer's necklace unbalances levels 15–20 | low | BALANCE owns the stats; 10 % on a key that drops 1 in 200 sea catches, none after FISHING's daily cap [confirmed: FISHING §5.1] |
| R10 | Wave 14 re-tunes levels 1–20 and moves gold values | certain | §6's rewards are table lookups (a degree-appropriate ring, the gold rate), not constants |
| R11 | Retail heroes scaled through S-SCALE keep full-size footprints (a 147 m ship in the nav and in SWIMMING's solids) | was certain; fixed | scaled copies without collision (§3.4), S-FLOOR for divers (§2.1) |
| R12 | Bots and alts farm the reef (no monsters under water) | medium | level 10 for daily claims, gathered items at 2 gold with a 30-pick cap, `seaUse` rate-limited, the daily claims per character in the DB (§6.2, §6.5) |
| R13 | WebGL2 stalls on per-frame instance-buffer uploads (the prototype's plankton: + 1.8 ms on the dev PC, more on a slower GPU, F8), and the sea life's boid buffers must upload every frame | medium | upload only on change (§8.3 rule 1, §9.3); LAB-13 times life on / off on WebGL2; if the boids stall, double-buffer them (two instance buffers alternated per frame) |

---

## 11. Decisions

Each one is the option this spec would mark "(Recommended)", with the reason in one line.

| # | Decision | Reason |
|---|---|---|
| D-U1 | `World.underwater` from the eye against the water surface plus the CPU wave height; a 0.25 s blend | one number for the look, the sound and the life; no pop when crossing |
| D-U2 | The swimming camera keeps the eye ≥ 0.35 m from the moving surface | no split frame to render; the near plane never straddles the waterline |
| D-U3 | One global PBR plugin (`SroUnderwaterPlugin`) for caustics and absorption, behind uniforms, attached to every PBR material of a world with water | no define flip (no recompile hitch) at the surface; measured in both languages in the prototype |
| D-U4 | Procedural caustics (Worley edges), no texture | 0 WebGL2 units (the terrain sits at 15 of 16), every PBR surface gets them, nothing to download; supersedes COAST's CST-K |
| D-U5 | Per-channel absorption with a downwelling term; the height fog suspended under water | red fades first, the deep turns blue; one fog term at a time |
| D-U6 | Caustics from above only on High+, within 4 m | holds the M1 beach margin (WAVE_PLAN8 G6) on Medium |
| D-U7 | Snell's window in the ocean and water plugins' under branch, with the real wave normals and the sky cube | the real surface from below on both backends, no new pass, no copy of the scene |
| D-U8 | Low: the Classic fog swapped to the water colour and a two-tone surface; no life, no caustics | the Low guard: nothing changes above water, and it still reads as under water |
| D-U9 | Bed regions: the coast pass emits every region within 64 m of a dive zone, drawn only under water | paint, lightmap, placements and editor edits on the bed; no cost above water |
| D-U10 | The field skin is the fallback (cut 6), not the plan | it works but carries nothing and shows its seam at grazing angles |
| D-U11 | The far plane 90 m and the shadow distance 40 m under water | everything past 60 m is fully absorbed; fewer draws and casters |
| D-U12 | Actors beyond 45 m are not drawn under water | invisible in the water anyway; the 20-diver scene's biggest lever |
| D-U13 | Scenery is retail first (rocks, the takla ship, the stone tortoise), plants new (bpy), painterly palettes from retail sprites | the retail look, nothing downloaded, the plants the retail set lacks |
| D-U14 | The sea dressing is a content file applied by a converter pass after the town dressing, before the world edits; props get the S-UID sea range | the World Editor can move them; the town's pattern |
| D-U15 | Plants are placements of patches expanded at load (one draw per kind) | the editor moves a patch; thin instances keep the draws flat |
| D-U16 | `World.sea` is a sibling part of `World.life`, reusing its spawn seeding, threats and skeleton materials | the air animals' shaders and rain gating do not fit the sea |
| D-U17 | One procedural fish mesh for all species, CPU boids, flee within 6 m | one draw for every fish; the prototype's behaviour reads well |
| D-U18 | The retail crab baked to VAT at 0.12 | a painterly retail model with real walk clips, through the town's pipeline |
| D-U19 | Turtle, ray and jelly from bpy with the flap weight in the vertex alpha | built in 3 s, one vertex line each; fine at their distances |
| D-U20 | Meshy: 0 credits in this design; a ≤ 40-credit bake-off (J1 image-to-3D, J2 retexture) for the Jade Tortoise in the build | the hero is the one creature where bpy falls short; credits and downloads wait for the build's permission |
| D-U21 | One species id list: the sea rows in `content/sea/species.json` (this spec), FISHING's catch rows keyed by them in `content/fishing/species.json`; one mesh generator for both (S-FISHMESH) | the fish you catch are the fish you see; one look, one tool |
| D-U22 | Events are a pure function of the world clock (`seaEventsAt`), no broadcast | everyone sees the same clam and tortoise; the town schedule's pattern |
| D-U23 | Interactables are NPC-kind entities with one new request (`seaUse`) | no new entity kind; the click, name and model already exist |
| D-U24 | The Dragon King's shrine with a daily coffer and a sealed coffer opened by the fishing key | the most Chinese thing to find on a sea bed; a daily reason to dive; a fishing tie-in |
| D-U25 | Giant clams on a 4 min / 40 s cycle, pearls once per clam per day | a small shared timing game; pocket money, not a farm |
| D-U26 | Kelp and urchin nodes for cooking | an underwater gathering loop that feeds the fishing spec's buffs |
| D-U27 | The Jade Tortoise: 2–3 windows a day, rare catches ×2 near it, a +10 % EXP blessing for 15 min | a rare sight worth a chat line, with a fishing tie-in |
| D-U28 | No hostile mobs under water this wave | swimming combat has no rules yet; `mobs: []` is reserved for wave 14 |
| D-U29 | No post-process wobble or lens effect | motion sickness, and a full-screen pass on Medium |
| D-U30 | Sound synthesized in WebAudio (bed, blips, calls), an 800 Hz low-pass on the sfx and ambient buses (UI clear) | retail has no underwater sound; nothing to download |
| D-U31 | Daily claims persist in a new table (the wave's third migration: 13 by default, WAVE_PLAN9 numbers it) | a relog must not reset the coffer and the clams; HOT_SPRINGS takes 11 and FISHING the next |
| D-U32 | Dive site this wave: S1 (and the pier's piles wherever the pier lands); Jangan Bay later | one site done well; the bay's retail lake floor needs its own survey |
| D-U33 | Props outside S-SCALE's range are scaled copies without collision; divers' solidity comes from a `solid` box raising `swim.bin`'s bed (S-FLOOR) | S-SCALE keeps full-size footprints; divers must not sink through the wreck |
| D-U34 | Daily claims need level 10; Kelp and Sea Urchin sell for 2 gold, 30 picks a day | no alt or bot farm under a sea with no monsters; the value is cooking |
| D-U35 | `seaEventsAt(serverMs, clock, weather)`: clams and windows on the server's real time; a GM window via one GM-only `seaHold` message | a frozen world clock must not stop the clams; a GM test must be seen by every client |
| D-U36 | The world filter is on the sfx and ambient buses, the UI bus bypasses it | toasts and clicks stay readable under water |

---

## 12. What the user must provide or approve (each has a default)

1. **Nothing blocks the start.** No download; every asset is retail, bpy or synthesized.
2. **Meshy for the Jade Tortoise** (≤ 40 credits in the build, within WAVE_PLAN9's cap, one NIGHT_LOG row per job).
   Default: the build runs J1 and J2 under the standing permission ("we can use meshy if needed", NIGHT_LOG 13:56)
   and the user picks on one sheet; with no pick, J1 if it passes the painterly rule (§5.6), else the bpy turtle.
3. **The look sheet** (G5-UW, §9.4): the reef at noon, dusk and night, looking up, the wreck, the shrine, the school,
   the tortoise. Default: ship the tuned colours of §4.1.
4. **The deploy OK** for wave 13, as for every wave.

---

## 13. Open questions (each has a default, so nobody waits)

| # | Question | Default |
|---|---|---|
| Q1 | Can players dive to the bed, or only swim at the surface? (the swimming spec) | Dive to the bed; this spec's content sits at 8–14 m |
| Q2 | Where are the dive zones? (the swimming spec) | S1, x 400–960, z 1290–1560 glTF; the pier's piles |
| Q3 | Does the server know the diver's depth (S-DEPTH)? | Yes; else "diving and within 3 m horizontally" |
| Q4 | The Tortoise's Calm (+10 % EXP for 15 min) and the necklace's stats | BALANCE checks them; these defaults ship otherwise |
| Q5 | Should Low get any sea life? | No (the Low guard); the event creatures and interactables yes |
| Q6 | Is night diving too dark (4 % of noon, glowing jellies, two lanterns)? | Ship it; the user's night check decides a lift |
| Q7 | Is the synthesized underwater sound good enough? | Yes; the user judges by ear, as with the other synthesized cues |
| Q8 | A second dive site at the Jangan Bay mouth? | Deferred to a later wave |
| Q9 | Should rain and storms make the sea murkier (turbidity × 1.2 / × 1.6)? | Yes |
| Q10 | ~~Will FISHING put the Rusty Bronze Key in its treasure boxes?~~ **Closed** (fact-check F3): FISHING rolls it as its own outcome, 1 in 200 sea / bay / ferry catches, 1 in 400 on the river | – |
| Q11 | Level 10 for the daily coffer and the clams (fact-check F10) | Yes; BALANCE may move it with wave 14's re-tune |

---

## 14. Lanes

Every lane re-reads its files at the wave-12 final commit (the WAVE_PLAN7/8 rule); WAVE_PLAN9 settles any file a
sibling wave-13 spec also touches. "Seams" are what the lane may not cross.

| Lane | Owns (files) | Seams it may not cross | Tests | Effort (days) |
|---|---|---|---|---|
| **UW-0** (seams, step 0) | the `World.underwater` and `World.sea` slots in `world.ts` (`waterSurfaceAt` is SWIMMING's); `HeightFog.suspended` in `pbr/fog-plugin.ts`; the `bedOnly` region flag in `manifest.ts` and its `isVisible` rule in the region set; the S-UID sea range row; `seaUse` and its fail reasons in `protocol.ts` (types only); the `packages/shared/src/sea.ts` skeleton (types, `validateSeaFile`, a `seaEventsAt` stub) | – | off = HEAD on every existing path; the Low guard; `bedOnly` absent = byte-identical manifests | 1 |
| **UW-R** (render) | `packages/world-render/src/underwater/{state, plugin, chunks, backdrop, rays, particles}.ts`; the under branch in `ocean/ocean-plugin.ts`, `ocean/ocean-classic.ts`, `pbr/water-plugin.ts`; the sky dome's under colour (one uniform in `sky/*`); the 90 m far plane and 40 m shadow distance applied in `World.update` and restored on surfacing | the ocean's above-water output (a test renders both); the fog plugin beyond `suspended` | plugin parity (the same injection keys in WGSL and GLSL); `installVaryingBudgetCheck` silent for every PBR variant; `material-budgets.test.ts` (≤ 16 units, the count unchanged); the Classic above-water output byte-identical (the Low guard); a WebGPU render of the under branch with 0 validation errors | 3 |
| **UW-C** (converter) | `packages/convert/src/world/sea.ts` (the dressing pass: scaled copies without collision, props on the terrain heightfield, the `solid` boxes handed to SWIMMING's `swim.bin` bake), the dive-zone rule in the coast pass (`world/coast/*`), the flat bed lightmap; the `'sea'` row in `world/uids.ts` (with W12-CV's owner) | `convert-world.ts` (I-13 only), the town dressing; `swim.bin`'s format (SWIMMING's) | an empty `content/sea/` = a byte-identical export; a deep region inside a dive zone is emitted with `bedOnly`, one outside is not; uids in the sea range (the registry's disjointness test); a 0.13-scale prop adds no nav object; the validator rejects a prop outside the export | 2 |
| **UW-D** (art and data) | bpy scripts `packages/convert/src/sea/*.py` (seagrass, kelp, reef plants, shells, the clam, the shrine's parts, the turtle, ray, jelly, the Jade Tortoise's flap weights); `content/sea/{jangan-sea, underwater, events, species}.json` (`species.json`: the sea species' ids, shapes and palettes, FISHING keys its catch rows by them); the S-FISHMESH generator for FISHING's 19 species + 5 extras; the crab VAT bake; the Meshy bake-off (the SDXL concept on the GPU queue) | the converter's spine; the GPU queue (WAVE_PLAN8 D27) | `validateSeaFile`; each model within its triangle cap (plants ≤ 120, creatures ≤ 500, fish ≤ 400, the hero ≤ 3,000); the palette within the painterly rule; the review sheet | 3 |
| **UW-L** (sea life) | `packages/world-render/src/sea/{sea, fish, crabs, gliders, jellies, shaders, spawn}.ts` | the life part's files (reuse by import only) | no allocation per frame (a heap check over 600 frames); flee within 6 m; counts per preset and period; Low → `World.sea` null; ≤ 5 draws | 3 |
| **UW-S** (server and shared) | `packages/shared/src/sea.ts` (full), `apps/server/src/sea.ts`, the sea migration in `db.ts` (number from WAVE_PLAN9; 13 by default), `/sea` in `gm.ts`, `seaHold` in `protocol.ts`, the new item rows in `content/items/sea.json` (`ITEM_ETC_SEA_*`, the necklace; FISHING's merge), the `NpcDef` rows of the five `NPC_SEA_*` codes, `content/sea/species.json` ids (with UW-D) | `quests/*` (hooks only); the swimming module (reads `p.swim` only); S-REWARD's order (FISHING's FS-K writes it; this lane adds `calm` to it) | `seaEventsAt` determinism (the same inputs give the same windows on server and client fixtures; a frozen world clock does not stop the clams); every `seaUse` fail reason incl. `level` and the pick cap; once per day per clam; the key consumed; the migration on a temp DB after HOT_SPRINGS' and FISHING's | 2 |
| **UW-E** (game client) | `apps/game/src/world/features/sea.ts` (the interactables' models and clicks, placed on the bed rather than `WorldGround.heightAt`, the clam halves from `seaEventsAt` with the `ServerClock`, `seaHold`, the sighting creatures on every preset, the chat lines), the 45 m actor cull under water in the crowd budget (`world/crowd-budget.ts`, one rule), i18n strings | the swimming camera (S-UNDER is a call); `screens/world.ts`'s camera (the far plane is `World.update`'s, UW-R) | a click sends `seaUse` only when diving and in range; Low draws the tortoise; a coffer rests on the sand at S1 | 1.5 |
| **UW-A** (audio) | `apps/game/src/audio/underwater.ts`, `setWorldFilter` in `audio/backend.ts` | the town and weather audio | the filter is transparent at 20 kHz above water; the `ui` bus bypasses it; ≤ 2 extra voices | 0.5 |

**User checks** (after the build, ≈ 15 minutes): dive at S1 at noon, dusk and night; look up at the surface; swim
through a school and watch it scatter; open the coffer, take a pearl from an open clam, try a shut one; wait for the
Jade Tortoise (or `/sea spawn tortoise`); switch to Low and dive once; pick the tortoise on the bake-off sheet.

---

## 15. Scope-cut order (cut from the top) and the never-cut list

1. The Sea Dragon's shadow (the storm sighting).
2. The dusk manta.
3. Caustics from above water on High.
4. Other players' bubbles (keep the own diver's).
5. The jellies' night glow (jellies by day only).
6. Bed regions → the field skin (§3.1).
7. Reef plants (keep seagrass and kelp).
8. Kelp (keep seagrass).
9. Crabs.
10. The common turtle and ray (keep the Jade Tortoise).
11. The Meshy hero → the bpy tortoise with a tuned palette.
12. The gatherables (kelp and urchin nodes).
13. The sealed coffer and the key tie-in (keep the daily coffer). FISHING already rolls the key (fact-check F3), so
    this cut is a scope choice now, not a dependency.
14. God rays on Medium (keep High).
15. Plankton on Medium.
16. The synthesized underwater bed sound (keep the low-pass and the blips).

**Never cut:** the underwater state with absorption on every preset; the surface from below (Snell's window on
Medium+, the two-tone on Low); a bed under every dive zone (bed regions or the skin); caustics under water on Medium+;
one fish school that flees; the Dragon King's shrine with its daily coffer; the giant clams; the Jade Tortoise
sighting with its fishing tie-in; the Low path; G1-UW and G4-UW.


---

## F. Fact-check (2026-10-02, ≈ 09:00–10:00Z)

Every [confirmed] claim was re-derived; what held is not listed (among them: the region census, row 88 x 169–173
and the 5 bed regions [re-run: `work/tmp/underwater/fc_regions.ts`]; the bed depths along x = 480 [re-sampled:
`fc_field.py`, within 0.4 m of §1.2]; `backFaceCulling = false` on the PBR ocean; the life part's API and its
`isVisible` rule; `waterLevelAt`; `CameraGround`'s 0.6 m; the audio chain; the WebGPU bench table against
`bench-*.json`; the creature report; NIGHT_LOG's Meshy prices; Snell's 48.6° and the 43 m visibility; SWIMMING's
seams S-UNDER, S-DEPTH, S-ZONES, S-BUBBLES and its 15 m / 30 s dive). Changed:

| # | Claim in the first draft | Finding | Where fixed |
|---|---|---|---|
| F1 | Migration 11 for `sea_claims` | HOT_SPRINGS §6.2 takes 11 and FISHING §8.6 the next one; `db.ts` has 10 [confirmed]. The sea table is the wave's third: 13 by default, WAVE_PLAN9 numbers them | §6.5, D-U31, UW-S |
| F2 | FISHING owns the one species list in `content/fishing/species.json` (17 species) | FISHING's current text: the sea ids, shapes and palettes are this spec's `content/sea/species.json`, its catch rows are keyed by them; 19 species + 5 extras [confirmed: FISHING §5.2, D11, FS-M] | §2.2, §5.2, D-U21, UW-D |
| F3 | The Rusty Bronze Key "≈ 1 box in 10" (Q10 open; R9 "1 in 150 casts") | FISHING already rolls it as its own outcome: 1 in 200 sea / bay / ferry catches, 1 in 400 river, none after the daily cap [confirmed: FISHING §5.1]; Q10 closed; cut 13 no longer a dependency | §2.2, R9, Q10, cut 13 |
| F4 | The takla ship "144 × 92 × 140 m" → "≈ 19 × 12 × 18 m" at 0.13 | Sidecar bounds: 67 × 92 × 147 m → ≈ 8.7 × 12 × 19 m; the masthead 2–3.5 m under the surface [confirmed: `conv/…/ruin_takla_ship_01.json`]. The tortoise is 67 × 35 × 59 m and already in the export (model 343) | §0, §1.3 |
| F5 | Props at `scale: 0.13` as ordinary placements | S-SCALE is 0.5–2 for footprint-free models and the nav keeps unscaled footprints [confirmed: `placement-scale.ts`, WORLD_EDITOR D12]; both heroes name a collision mesh in their `.bsr` [confirmed]. Now scaled copies without collision (the town dressing's method), on the terrain heightfield | §3.4, D-U33, UW-C, R11 |
| F6 | (missing) divers vs the wreck | SWIMMING's dive line follows the terrain bed and its solids are tested at the surface only [confirmed: SWIMMING §5.2, §6], so divers would sink through the hull; new seam S-FLOOR | §2.1, §3.4 |
| F7 | Plants: unstated above water | The pier's piles stand in ≤ 1.6 m of translucent water where nobody can dive (≥ 2.5 m to dive); shallow patches stay drawn above water | §2.2, §3.3 |
| F8 | "WebGL2 pays ≈ 2 ms of CPU for per-material uniform updates; production binds once per frame (like the fog's scene-level state)" | Re-measured (GPU lock, quiet CPU, `shots/fc-webgl2-*.json`): ≈ 1.8 ms is the plankton's every-frame instance-buffer upload (2.6 → 0.8 ms when skipped; halves at half resolution: a stall), ≈ 0.4 ms the uniforms; absorption + caustics ≈ +0.1 ms. The fog plugin is per-material too [confirmed: `fog-plugin.ts`]. Upload-on-change rules, budgets and projections corrected; WebGL2 above water within noise with and without the plugin [confirmed] | §0, §8.3, §8.5, §9, R13 |
| F9 | Kelp and Sea Urchin "≈ 30–60 gold"; no gathering cap | ≈ 8,000 gold/h for one camper on 12 nodes, frugal-hunting income with no risk (BALANCE §5.1), and 15–30× the 2-gold Waterweed / Mud Crab they replace in recipes [confirmed: FISHING §3.5, §7.2]. Now 2 gold, 30 picks a day | §2.2, §6.2, D-U34 |
| F10 | Daily claims open to any character | Per-character claims let level-1 alts collect ≈ 3,000 gold a day each; now level 10 (fail reason `level`) | §6.1, §6.5, Q11 |
| F11 | Interactables "at the bed height" via `EntityState.pos.y` | NPC codes need `NpcDef` rows; the client's `heightAt` snaps to the walkable surface nearest a hint and S1's coast regions carry nav planes [confirmed]; UW-E places them on the bed | §6.5, UW-E, UW-S |
| F12 | The state assumes the sea level; fresh water [projected] only | SWIMMING allows dives in the lake and rivers, so fresh water is a shipped path; the state gains `surfaceY` | §4.1 |
| F13 | A master low-pass | It would muffle the UI bus; now a world filter on the sfx and ambient buses | §4.8, D-U30, D-U36, UW-A |
| F14 | `seaEventsAt(clock)`, "no broadcast", `/sea spawn tortoise` | The world clock can be frozen or set by a GM [confirmed: `world-clock.ts`], which would stop the clams; the storm slot reads the weather schedule or a GM hold; a GM window outside the schedule reaches no client. Now `seaEventsAt(serverMs, clock, weather)` and one GM-only `seaHold` message | §0, §6.3, §6.5, D-U35 |
| F15 | R4: the ocean's depth pre-pass renders the branch twice | No pre-pass since CST-O (`needDepthPrePass = false`, depth written in the colour pass) [confirmed]; the real risk is the P-LOOK alpha blend from below | R4 |
| F16 | M1 "+1–3.5 ms"; G1-UW "6.5–8.5 / 8.5–11" | × 9–11 of the projected +0.3–0.5 ms is +2.7–5.5; the far plane and 45 m cull do not shrink a crowd at the shrine: 20 divers ≈ +4.5–7.5 ms WebGPU from wave 11's per-character costs → G1-UW ≈ 6.5–10 / 5–8.5, still a pass | §9.1, §9.2 |

Also re-checked: the Meshy balance, **1,840 credits** at 09:07Z (read only, no job: 0 credits spent by the
fact-check, so no NIGHT_LOG row); the local SDXL checkpoint the bake-off's concept needs exists
(`work/tools/comfyui/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors`), so nothing is downloaded; Jangan's own
temple turtles (`cj5_tem_turtle01–03`) exist as an alternative centrepiece. Housekeeping: the private Vite on :5297
was started for the re-run and stopped; one browser tab, closed, viewport reset; the GPU lock was taken at 09:24:04Z
(owner "underwater-factcheck", after T12-A released it) and removed at 09:28:10Z; nothing under `packages/`, `apps/`,
`content/` or `deploy/` was edited; no commit.
