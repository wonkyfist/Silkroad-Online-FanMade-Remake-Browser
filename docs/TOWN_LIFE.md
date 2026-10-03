# A living, beautiful Jangan (wave 11, town part)

**Status (2026-10-01, I-11): built and integrated in wave 11** (commits 19770ea, 9b661fb, f156783 and the I-11 commit);
not deployed. WAVE_PLAN7's decisions (§2) override this spec where they differ: the content is split in two files
(`content/town/jangan.json` for TL-R, `jangan-dressing.json` for TL-B, D18), the converter hooks are W11-CV's (D13),
the cloth chunk sits in the foliage plugin's `SRO_CLOTH_WIND` slot (D3), the water and post seams are W11-S's (D4, D5).
I-11 fixed one determinism gap (the schedule's presence cache now follows the world clock, so a GM `/time` or a late
clock reaches every client at once) and measured the town in LAB-11 (Dropbox `wave11/budgets.md`; §7.6's B2 gate is
reported there).

**Status (design, 2026-10-01):** spec and prototype for wave 11's town item. Nothing here is built. The prototype is
scratch (`work/tmp/town-life/`), measured on the real `jangan-fields` export through the live `packages/world-render`
source. The Tiger Girl item of the same wave has its own spec (docs/UNIQUES.md); fishing, swimming and underwater are
wave 12.

**Fact-checked (2026-10-01, adversarial pass):** every [confirmed] claim was re-derived from the code, the export, the
retail client files, Babylon 9.28's source and the lab's raw JSON. Corrections are marked *(fact-check Fn)* in place and
listed in §17. The biggest: the cloth "spare per-vertex slot" does not exist (§5.1, F1); the player-aware cap was too
weak for the undivided lab numbers and is now −3 per player (§8.1, F2); High's TAA smears the walking crowd (F3); the
night-light container is 8 / 32 / 64 lights, not 8 / 16 / 32 (F4); the VAT clock needs a rebased time base (F5); the
retail WAIT01–04 clips are qigong casting holds, not idles (F6).

The user, verbatim:

> Let's also make Jangan town for better, beautiful, and a living town. Lets bring it to life, it looks dead right
> now, static, and empty.

The user is away and delegated every decision: where there is a choice, this spec takes the option it would mark
"(Recommended)" and writes it as a decision with a one-line reason (§14). Only what truly needs the user is left in
§15 and §16, each with the default that is used meanwhile.

**Tags** (as in docs/WAVE_PLAN6.md): **[confirmed]** checked in code, data or a measurement (each says how);
**[likely]** strong evidence, not proven; **[projected]** computed from a measurement; **[unknown]** open, with a
default; **[decision]** a choice this spec makes (the user may overrule it).

**Files of this spec** (all scratch): the lab page `work/tmp/town-life/lab/town-lab.ts` and its server
`lab/vite.config.mjs` (port 5261), the survey and prototype shots `work/tmp/town-life/shots/*.png` and sheets
(`survey-noon.jpg`, `survey-night.jpg`, `survey-2.jpg`, `proto-sheet.jpg`), the census scripts (`census.py`,
`ambient_census.py`, `materials_census.py`, `bsr-anims.ts`, `walklen.ts`) and the scratch conversions of 14 retail
models in `work/tmp/town-life/out/` (`pnpm sro convert … --out work/tmp/town-life/out`, 0 validator errors). The
fact-check added two crops of the prototype's High shot, `work/tmp/town-life/crop_ghost.png` and `crop_ghost2.png`
(the TAA smear, F3).

---

## 0. Summary

1. **What is dead today** (§1, surveyed in one tab at noon and at night): a 120 m paved octagon with a fountain and
   nobody on it; 46 retail NPCs that all stand still on their spot (no retail NPC model in Jangan has a walk clip
   [confirmed]); four tied horses, two chickens and six goldfish are the only animals; nothing hangs or flaps; no cook
   smoke except the smith's; at night the plaza is a flat blue sheet with no pool of warm light; the town sounds like
   the field (wind and birds).
2. **The crowd is client-side, cosmetic and deterministic** [decision]: every townsperson's position and activity is a
   pure function of the server's clock (the world clock every client already extrapolates) and a seed, read from a
   content file of routes, places and schedules. All friends see the same people in the same places (within the
   clock skew, ≤ 0.15 m), the server does nothing, there is no protocol message and no database change.
3. **The crowd is drawn with baked animation textures (VAT) and thin instances** [decision; prototyped]: one mesh per
   outfit variant, one draw each (after the per-variant texture atlas), the skinning read from a small float texture
   per skeleton, the CPU moving only matrices. The lab drew **60 dressed townsfolk + 17 animals** walking, chatting,
   sitting and selling on the real plaza on WebGPU and WebGL2 with no errors, using the retail player bodies, the
   retail garment sets and the retail clips (§11).
4. **People** (§3): walkers, chatting groups, tea-house sitters, vendors calling out (English speech bubbles, no
   voice), guards on patrol (the retail mercenary guard `ch_guard_spear` has WALK), porters leading pack horses
   (`t_horse1`), lantern carriers at dusk, children; fewer people at night, shops close, guards stay. Not attackable,
   not targetable; a click shows a one-line flavour bubble [decision].
5. **Animals** (§4): pigeons on the plaza that flush (a species of wave 10's bird flock, no new draw), chickens, a cat,
   dogs (the retail `p_raccoondog` pet reads as a small dog), the retail goldfish made visible, ducks on the pond (a
   new species of the same bird code, floating), birds on the roofs (wave 10's perchers already land in town).
6. **Motion** (§5): banners, flags, awnings and hanging signs sway in the wave-9/10 wind inside the region batch (the
   existing per-region cloth `+sheen` group gets a per-piece pivot and a vertex chunk: no extra draw where the group
   exists, ≤ +2 in view at the plaza; F1); new banners and lantern
   strings; cook smoke and food-stall steam; the fountain's spray; sparks at the smith; falling leaves and petals;
   ripples and fish in the pond.
7. **Sound** (§6), inside docs/SOUND.md's system: a town bed whose gain follows how many townsfolk are near, vendor
   murmur, the smith's hammer, the retail bell (`bell towel 3.wav`) on every game hour, horses and cats from the retail
   `cos` set, chickens and dogs synthesized, night insects (already retail).
8. **Beauty** (§7): warm night lighting (more lamp emitters and lantern strings on the plaza, so the night-light
   container, 8 / 32 / 64 lights on Medium / High / Ultra, has something to pick), planters and flower pots, grass in cracks and planters with the new grass, decals (dirt,
   moss, puddles), goods on the stalls, the pond made to read as water, and **a scoped B2 town texture batch: included
   if the bench passes** (§7.6) [decision].
9. **Performance** (§8, §9, §11): Medium must hold 60 fps in the plaza with 20 players plus the crowd. Measured in
   the lab with an in-page A/B (§11.3): **all of town life (60 townsfolk, 17 animals, 12 banners, smoke) adds
   +1.1 to +2.5 ms CPU p50 and +2.0 to +3.4 ms p95, +0.1 to +0.4 ms GPU and +16 draws on Medium WebGPU** with one draw
   per variant (four runs; *fact-check F2: the first draft left out the +2.5 / +3.4 run*); +0.7 / +1.2 ms on WebGL2.
   Projected into the game with the lab's ≈ 1.5× per-draw slowness (BATCHING F17): ≈ +0.7–1.7 ms p50, +1.3–2.3 ms p95;
   **undivided** (the town's cost is mostly script and buffer work, which F17 did not calibrate) +2.0–3.4 ms p95. Wave
   10's worst Medium scene (the plaza crowd with 20 jumping players, p95 13.0–15.1 ms) would sit at 14.3–17.4 ms (÷ 1.5)
   or 15.0–18.5 ms (undivided): over the line. So the crowd **gives way to players**: the drawn count falls by **three**
   for every player in range beyond five, never below 15 (60 → 15 with 20 players), and the VAT animals halve beyond
   ten players [decision, F2], which keeps the worst case at ≈ 13.7–16.2 ms (÷ 1.5); undivided 14.0–16.8 ms, where
   only the corner that adds the upper bound to wave 10's pre-fix 15.1 ms repeat touches the line (14.4–15.1 ms against
   the final re-bench's 13.4) [projected]. LAB-11's G1-11 decides; cut item 11 is the fallback.
   Low draws none (the Low guard). Counts: Low 0, Medium 60, High 100, Ultra 140.
10. **Lanes** (§12): one seam agent (TL-0), then six parallel lanes (crowd runtime, crowd assets in the converter,
    content and routes, motion, sound, beauty) and one bench. **Nothing blocks on the user** (§15).

### 0.1 Where each user request lands

| User request (fragment) | Where | Lanes |
|---|---|---|
| "it looks dead right now" | §1 survey: the concrete list of what is dead | — |
| "static" | §5 motion: cloth sway, smoke, steam, fountain, sparks, leaves, ripples | TL-M |
| "and empty" | §3 people, §4 animals | TL-C, TL-V, TL-A2, TL-R |
| "a living town" | §3.5 day/night schedules, §6 sound | TL-R, TL-S |
| "better, beautiful" | §7 beauty pass, B2 decision | TL-B |
| the standing 60 fps goal | §8 budgets, §11 measurements, §10 cut list | TL-L |

---

## 1. Survey: what is dead and static today

**Method** [confirmed]: one browser tab on a private lab page (`work/tmp/town-life/lab/`, port 5261) that runs the real
world renderer (`loadWorld`, PBR, batching, the new grass and life, streaming) on `work/out/world/jangan-fields`, plus
the retail NPCs of `npcs.json` with their STAND1 clip, at 1920 × 1080 on WebGPU Medium, at noon (t 0.5) and at night
(t 0.92). Ten spots: the plaza both ways, the east market street, the west tea-house street, the blacksmith, inside the
south gate, the palace avenue, the east pond, the stable, the military camp; and a high view of the plaza. Sheets:
`work/tmp/town-life/survey-noon.jpg`, `survey-night.jpg`, `survey-2.jpg`. Census scripts read the manifest, the
ambient index and the model sidecars (counts below are inside the Jangan safe area + 40 m).

What the survey shows:

1. **The plaza is empty** [confirmed: `survey_plaza_noon`, `survey_plazaWide_noon`]. A paved octagon about 120 m
   across around the dragon fountain (`cj_wf_dr` at (97, −80)) and the red gate (`cj_jang_gate`), with **no bench, no
   stall, no planter, no banner** on it. The only figures are the gacha machine, its operator and one event NPC. The
   town spawn (96.9, −136.9) drops every player on its south edge, so this emptiness is the first thing everyone sees.
2. **Every person stands still** [confirmed: `npcs.json` + `bsr-anims.ts` over the retail BSRs]. 46 NPCs, about 38 in
   town; each loops STAND1/STAND2 on its spot. **No retail Chinese town NPC model has a walk clip**: the soldiers have
   STAND1/STAND2/TURN_L/TURN_R, the shop and system NPCs STAND1/STAND2, the event villagers
   (`npc_ch_event_ child/grandfather/grandmother`) STAND1 only. The one exception is `chinaetc_qinshiquest` (WALK, RUN,
   ATTACK1, STAND1–4). *(Fact-check: re-derived from every `work/out/npc/npc/*.json` sidecar: `chinaetc_qinshiquest` is
   the only NPC model with a WALK clip; `npcs.json` has 46 entries.)*
3. **Almost no animals** [confirmed: census]: 4 tied horses at the stable (`chinaetc_horse4` ×3, `chinaetc_horse2`,
   STAND1/2, at ≈ (25, −45)), 2 chickens (`cj_chicken`, at (165, −155)), 6 goldfish (`cj_goldfish01/03/04`: 3 in the
   east pond at ≈ (230, −230), 2 in a pool at ≈ (17, −220), 1 at (−52, −69); fact-check: the manifest). Wave 10's
   birds perch on roofs and land in grass, never on paving [confirmed: GRASS_LIFE §5.3; `life/birds.ts` ground flocks
   use `findLanding` with "no object floor, no water"; built-in habitats `meadow`/`roof`/`fields`/`water`].
4. **Market streets with nothing to sell** [confirmed: census, `survey_east_noon`, `survey_west_noon`]: 3 street stalls
   (`cj_streetstall`) in the whole town, 11 tea-table sets (`cj_table_chair`) on the west street, 11 army tents in the
   camp. Shops are buildings with their NPC in front; nothing is displayed outside.
5. **Gates and palace** [confirmed: `survey_gate_*`, `survey_palace_*`]: two soldiers per gate, standing; the south
   gate's inside is an empty dirt square; the palace avenue has two guards and no traffic.
6. **The east pond reads as dry ground** [confirmed in the lab: `survey_pond_noon` shows lilies (`c_pondflower`) lying on
   a green bed; the region has a water plane at −3.0 m (`world.waterLevelAt(228, −222)` = −3) and the water meshes are
   enabled; why it does not read as water is [unknown]: too clear and too shallow at noon, or a coast-field repack
   side effect (wave 10 changed how retail town water is read). The game must be checked before TL-B touches it].
   *(Fact-check: the water level itself is right: the pond's 9 lily placements sit at −2.96 to −3.13 m and its 3
   goldfish at −3.09 to −3.26 m in the manifest, i.e. on and just under the −3.0 m plane. So it is the water's look
   (clarity, no reflection or sheen in the shot) or the water mesh not drawing, not a misplaced plane. Wave 10's
   repack fix reads town water texels as "far inland" for the ocean only (`wave10/budgets.md`), which should not hide
   the retail plane [likely].)*
7. **Nothing hangs or flaps** [confirmed: `materials_census.py`]. The town has cloth: the restaurant's flag
   (`cj_resta01_flag`), its awning (`cj_resta01_tent`), the 11 camp tents' flags (`w_cd_mc_flag`), the stall awnings
   (`cj_streetstall_02`, alpha-tested), three hanging signs (`cj_luxu_door_sign`, `cj_stab_sign`, `cj_resta03_sign`).
   All are static meshes, now merged into the region batches. What moves today is only what retail animated: the
   skinned trees and flowers, and six hanging lamps (`cj_pub03_light`, `cj_pub01_light01–03`, `cj_luxu_light`,
   `cj_adult04_light01`: STAND1 clips).
8. **Little smoke and fire** [confirmed: `ambient_census.py`, docs/EFFECTS.md §3.15 table]: the smith's chimney smoke
   (`map/oas_hot_etc_b.efp` on `cj_weapon`/`cj_weap_chimn`) and lamp glows play through the app's ambient-fx; no cook
   fire, no steam, no chimney anywhere else.
9. **Night is flat** [confirmed: `survey-night.jpg`]: the plaza is uniformly blue-grey; the lamps glow (emissive) but
   throw no pool of light on the paving near the spawn, because the night-light container takes the nearest
   lamp emitters and the plaza has none (EFFECTS §3.15: ~26 lamp glows over the whole town, at shop fronts);
   windows glow dimly; nobody is about. *(Fact-check F4: the container holds **8 lights on Medium, 32 on High, 64 on
   Ultra** [confirmed: `render/quality.ts` `nightLights.cluster`], not "32". And [confirmed: manifest × `ambient.json`]
   **0 ambient emitters lie within 60 m of the plaza centre (97, −110)**; the plaza's four retail lamp posts
   (`cj_field_lamp` ×4) carry no emitter row, so they glow nowhere and light nothing.)*
10. **The town sounds like the field** [confirmed: SOUND §2.5]: `JANGAN_TOWN` and `JANGAN_FIELD` have the same retail
    layers (day wind + 5 birds; night wind, birds, insects). No crowd, no work, no bell.

What is **not** dead: the fountain's dragon spout runs (`survey_plazaN_noon`), the trees sway, roofs have birds, and
the new grass fills the lawns. The town's bones are good; it lacks people, animals, things that move, and light.

---

## 2. Architecture

### 2.1 Client-side and deterministic, not server NPCs [decision]

| Option | Server cost | Friends see the same | Bandwidth | Verdict |
|---|---|---|---|---|
| A. Server entities (like NPCs, moved by the simulation) | an AI tick per townsperson, entity sync to every client in range | yes, exactly | ~60–140 entities in view: position updates for each, every client | no: it costs the N100 server and the network for decoration |
| B. Client-only random (like the wildlife) | none | no: each client its own crowd | none | no: "look at that man" means nothing to a friend |
| **C. Client-only, a pure function of the shared clock and a seed** | **none** | **yes, within the clock skew** | **none** | **yes** |

Why C works [confirmed: code]: every client already holds the server's world clock (`worldEnter.world.clock` and the
`worldClock` message, `world.setClock(clock, serverNow)`, `apps/game/src/world/features/sky-clock.ts`) and a
server-time estimate (`ctx.serverNow`, `net/clock.ts` `ServerClock`: the minimum-RTT ping sample, so two clients
differ by their RTT asymmetry, typically well under 100 ms on a LAN or Tailscale [likely]). A townsperson's state is `f(serverNowS, id)`: two clients that agree on the server time to
100 ms see the same person within 0.15 m (walking 1.45 m/s) [projected]. No state is kept, so a client that joins
late, reloads or teleports in computes the same scene at once.

What C gives up: townsfolk cannot react to players in a shared way. The only reaction is a **local, stateless
sidestep** (§3.6): a cosmetic lateral offset ≤ 0.6 m when a player stands on the path, computed from the positions
this client sees, never fed back into the schedule [decision: so the shared schedule never drifts].

### 2.2 The time base

- **Positions and clips** use **server real time** in seconds (`serverNow() / 1000`), not game time: the world clock
  runs a 120-minute day with a 0.4 night speed-up [confirmed: apps/server `config.ts` W9_DEFAULTS `dayLengthMin: 120`,
  `dayNightSpeedup: 0.4`], so a game hour is about 5 real minutes; walking on game time would be 12× too fast.
- **Who is out** (the schedule, §3.5) uses the **solar time** `t` (0 = midnight) from `clockAt` (`SkyState`), so the
  town fills at dawn and empties at night in step with the sky everyone sees.
- **The stage and the viewer** (no server): the stage passes its own clock (SCREENS §0B uses the server's
  `ServerInfo.clock`); the viewer uses page time.
- **The GPU never sees epoch seconds** *(fact-check F5)*. Babylon 9.28's VAT shader reads one float uniform,
  `bakedVertexAnimationTime` (`bakedVertexAnimationManager.js` `setFloat`), and computes
  `fract(time × speed / frames)` [confirmed: `ShadersInclude/bakedVertexAnimation.js`]. `serverNow() / 1000` is
  ≈ 1.8 × 10⁹ s, where a float32 step is 128 s: every townsperson would freeze or jump. So `town/crowd.ts` keeps a
  **time base** `t0` (the server second at world load, re-based every hour; every instance's offset is rewritten in
  that frame, so nothing visibly jumps), sets `manager.time = nowS − t0` (< 3,600 s, float32 step
  ≤ 0.25 ms), and writes each instance's `offsetFrame` as `(clipPhase(nowS) × fps − (nowS − t0) × fps) mod frames` on
  a clip change. The lab used page time (`simT`), so it never hit this.

### 2.3 One world-render part: `World.town` [decision]

Like `World.life` (GRASS_LIFE §8): a part of `packages/world-render` (so the character-select stage on the palace
steps gets townsfolk too, and the viewer can show it), made only on the PBR path (**null on Low/Classic: the Low
guard**), updated once per frame after the life part, disposed with the world. Its meshes carry
`metadata.sroWorld = 'town'`, a new tag the batcher refuses exactly as it refuses `'scatter'`, `'life'` and `'ocean'`
(`batch/types.ts` `UNBATCHED_TAGS` [confirmed]; TL-0 appends `'town'`, a TL-0 test). Every town mesh is also
`isPickable = false`, so click-to-move rays pass through it (§3.6). It owns:

- `town/schedule.ts` (pure): the content file → agents, itineraries and the pure `stateAt(agent, nowS, solarT)`;
- `town/crowd.ts`: the VAT variants, the thin-instance buffers, the per-frame write of the agents in range;
- `town/animals.ts`: the animal agents (same VAT path) and the life-part species it registers (pigeons, ducks);
- `town/bubbles.ts`: which agent "says" what and when (pure); the DOM bubbles are the app's (§3.7);
- `town/props.ts`: the dynamic dressing that is not batched (lantern strings, smoke/steam emitter registration).

The app (`apps/game`) wires three things: `world.town?.setClock(serverNowFn)`, `world.town?.setThreats(...)` (the same
feed as `world.life`: players and mobs, used for the sidestep and the pigeons), and the bubble/click/sound hooks.

### 2.4 Content: `content/town/jangan.json` [decision]

One reviewable JSON file in the repo (like `content/quests/jangan.json`), checked by a validator in
`packages/shared` (`validateTownFile`). *(Fact-check: `/out/` serves `work/out` only [confirmed:
`apps/game/vite.config.ts` `serveWorkOut`], and there is no `work/out/content`.)* So the converter validates and copies
it into the export as `work/out/world/<world>/town.json` (as the coast's config reaches `world/<world>/coast/`), and the
client loads `/out/world/jangan-fields/town.json` at world load:

- **graph**: nodes `{id, x, z}` and edges between them, every edge a straight segment that lies on the town navmesh
  (the build script checks each segment with `@sro/nav` `locate` every 0.5 m and refuses one that leaves the walkable
  surface or passes within 0.4 m of an object's nav edge);
- **places** (POIs): `{id, kind, x, z, yaw, seats?}`, kinds `stall`, `teaTable`, `bench`, `fountainRim`, `chatSpot`,
  `guardPost`, `door` (where people appear and leave), `well`, `smithAnvil`, `stable`, `templeSteps`, `pondEdge`;
- **folk**: the population per district and hour band (§3.5), the outfit mix, the roles;
- **lines**: the English vendor calls and flavour lines (§3.7) by role and by questline act;
- **dressing**: new static props (banners, planters, stall goods, lantern posts) as placements of retail or new models
  (§7.2), applied by the converter like the coast's placement edits (§12, TL-K).

The graph and places are made by a script, not by hand: `packages/convert/src/town/build-graph.ts` samples the town
navmesh (the nav regions of x 166–169 × z 96–99), skeletonises the walkable area of the streets and the plaza into a
graph with nodes every 6–12 m, snaps the retail POIs it can find in the manifest (`cj_table_chair` → teaTable seats,
`cj_streetstall` → stall, doors from the building models' nav door cells, `c_sta_01` / fountain rim → sit spots), and
writes the file; a human pass (or a GM editor tab later) adjusts it [decision: script first, so it is reproducible].

---

## 3. People

### 3.1 Which retail models can be used [confirmed: `bsr-anims.ts`, the equipment manifest, the lab]

| Use | Model | Clips that exist (retail) | Verdict |
|---|---|---|---|
| **Townsfolk (all walking roles)** | the **13** male and **13** female Chinese player bodies `chinaman_*` / `chinawoman_*` (`work/out/char/china`; the 14th glb of each, `*_hwan_hair`, is a hair piece with no skeleton; every body uses `europeman_skel` (43 joints) / `europewoman_skel` (45) in one joint order [confirmed: all 26 sidecars]) | STAND1, STAND3, WALK (1.17 s, 1.7 m per loop: 1.46 m/s), RUN, SIT_DOWN, SIT (floor sit, 2.67 s), STAND_UP, EMOTION01–08 (greeting, pokun salute, rush, joy, no, yes, laugh, bow), VENDOR01 (the player-stall loop, 10–13 s), PICK, HAMMER (group `sword`: `skill_ch_fortresshammer`, a hit event at 522 ms), cart group WALK / STAND1 (`cart_walk`, `cart_stand01`; **walkLength 0**, so a porter's speed is set by hand), TURN_L/R. **Not for townsfolk: WAIT01–04**, which are `skill_china_gigong_wait_a–d`, the force-skill casting holds *(fact-check F6)*. Five gait styles exist per gender (`bogy`, `fighter`, `merchant`, `monkey`, `tattoo` STAND1/WALK) | **yes**: dressed with the retail garment sets, baked to VAT |
| Outfits | `ITEM_CH_{M,W}_CLOTHES_0{1,2,3}_{BA,LA,FA,HA}` (3 garment sets per gender, A/B/C share one glb each) and the LIGHT protector sets | — | yes: 3 sets × hat or no hat × 14 faces per gender; per-instance tint for variety (§3.2) |
| Bodies alone | the same glbs undressed | — | **never**: they render in underwear (the lab's first shot, `shots/proto_test.png`, before dressing) |
| Guards on patrol | `cos/ch_guard_spear`, `ch_guard_bow` (the hireable mercenaries) | STAND1, STAND2, WALK, RUN, ATTACK1–3, DAMAGE, DOWN… | **yes**: the only retail soldier with a walk; 926 / 1,072 triangles |
| Guards on post | the 8 `chinaetc_soldier*` NPC models | STAND1/2, TURN_L/R | they are already the gate NPCs; extra posts reuse them (STAND only) |
| Stationary vendors, elders, children | `npc_ch_event_ grandfather / grandmother / child`, `chinaetc_kisaeng1–6`, `chinaetc_slumboy` | STAND1 (+STAND2) | yes, for people who never walk (a grandfather on a bench, a child at the fountain); VAT, one clip |
| Pack and ridden horses | `cos/t_horse1–3` (trade horses with packs), `t_donkey`, `t_cow1`, `c_horse1` | STAND1, WALK, RUN, DAMAGE, DIE | yes: porters lead `t_horse1`/`t_donkey`; `c_horse1` for a rider (§3.4) |
| Tied horses | `chinaetc_horse1–4` | STAND1/2 | already placed (4) at the stable; add 2–4 at the inn |
| Animals | `npc/animal/cj_chicken` (one 9.8 s pecking walk), `cj_goldfish01–04` (swim), `cos/p_cat`, `p_raccoondog`, `p_rabbit`, `p_raven01/02` | cat: STAND1, WALK, RUN, PICK, EMOTION01; raccoon dog: + RUN | §4 |

What **does not exist** and must be made (Blender, hand-keyed by bpy scripts like the jump, MOVEMENT §3.2):

| Clip | Why | Made how | Size |
|---|---|---|---|
| `SIT_CHAIR` (sit on a stool or bench, hands on knees; a variant with a cup) | the retail SIT is cross-legged on the floor: right for the fountain rim and steps, wrong at tea tables | keyed on `europeman_skel` / `europewoman_skel` (the Chinese bodies use them [confirmed: equipment manifest `skeleton: prim/skel/char/europe/europeman_skel.bsk`]) | ≤ 3 s loop |
| `CARRY` (a box or sack on the shoulder, walking) | porters | an upper-body pose layered on WALK, baked as one VAT clip; the load is a socket prop (a retail item box or a new 40-triangle crate) on the right hand bone | 1.17 s loop |
| `TALK` (gesturing while standing) | groups that chat | first try: EMOTION01 (greeting), EMOTION02 (pokun), EMOTION04 (joy), EMOTION07 (laugh) and STAND3 in turns; keyed only if they read as fighting or dancing. *(Fact-check F6: the lab's WAIT01–04 are qigong casting holds [confirmed: the sidecar's BAN names] and EMOTION03 is "rush"; both are out of the chat set)* | 3 s loop |
| `SWEEP` (optional) | dawn sweepers | keyed | 2 s loop |

[decision: the cast starts with retail clips only (the lab's set), and the four new clips are a lane of their own
(TL-A2) that can land later; a missing clip falls back to STAND1 / SIT.]

### 3.2 Variety without draws

- **A variant = one dressed body**: body + garment set (+ hat) merged into one mesh, its textures packed into one
  atlas (≤ 1024 × 1024 per variant), so **one variant is one draw** for every instance of it [decision; the lab drew
  5–8 draws per variant because it kept the retail materials per sub-mesh, §11.2].
- **Per-instance tint**: a per-instance vec4 (instanced buffer) that recolours the garment's dominant hue (a hue shift
  masked by the atlas's saturation), so 10 variants × 4 tints read as 40 outfits [decision; not in the prototype].
- **One VAT per skeleton**, shared by all variants of that gender (the joints are the same and in the same order for
  every Chinese body [confirmed: the dresser's `shared-skeleton` path and the equipment manifest's joint lists]; the
  lab baked one per variant, which is 10× the memory). Two VATs: man and woman, half-float [confirmed: Babylon 9.28
  `VertexAnimationBaker.bakeVertexDataSync(ranges, halfFloat)` and `textureFromBakedVertexData` take a `Uint16Array`],
  **≈ 2.0–2.2 MB each** [projected, *fact-check*: (43+1) × 16 halves = 1,408 B per frame (1,472 for the woman); the
  clip set of §3.1 + the four new clips + two extra gait styles is ≈ 50 s, ≈ 1,500 frames at 30 fps, of which
  VENDOR01 alone is 400; the first draft's "1.6 MB for 1,100 frames" left clips out]. VENDOR01 is baked at 15 fps
  (−200 frames, it is a slow loop).
- **Gait variety**: the shared VAT carries 3 of the 5 retail gait styles (merchant, fighter, tattoo STAND1 + WALK,
  ≈ 105 frames each), picked per agent by seed, so the crowd does not walk in lockstep style [decision].
- Variants per preset: Medium 10 (5 + 5), High 14, Ultra 18 [decision], plus guards (2), elders/child (3), animals.

### 3.3 Roles

| Role | What they do | Clips | Day share |
|---|---|---|---|
| Walker | walks between places along the graph, dwells 2–10 s (STAND1 / STAND3) at some nodes | WALK, STAND1, STAND3 | 40 % |
| Chatter | groups of 3–4 in a ring facing the centre, taking turns (one talks, others listen) for 1–4 minutes, then the group breaks up and walks off | STAND1, STAND3, EMOTION01/02/04/07, (TALK) | 20 % |
| Sitter | tea-house seats, benches, the fountain rim, temple steps | SIT (rim, steps), SIT_CHAIR (tables) | 15 % |
| Vendor | stands at a stall, VENDOR01 / STAND1, calls out (§3.7); packs up at closing | VENDOR01, STAND1, WALK | 8 % |
| Porter | carries a load, or leads a pack horse from the south gate to the market and back | WALK / CARRY; horse WALK | 5 % |
| Guard | pairs patrol the avenue, the walls' inner road and the market; stop at posts; keep going at night | guard WALK, STAND1/2 | fixed: 4–8 |
| Child | runs around the fountain, stops, runs. The retail child (`npc_ch_event_ child`) has STAND1 only, so a running child is the smallest female body at 0.82 scale with RUN; the retail child model stands at the fountain | RUN, STAND1 | 4 % |
| Rider | a horseman rides through the main avenue every few minutes | `c_horse1` WALK + a rider on SIT-mount pose (the game's mounted pose) | 1 at a time |
| Lantern carrier | at dusk walks the avenue lighting the lantern posts (§3.5) | WALK + a lantern socket prop with a point light | 2 at dusk |
| Worker | the smith's apprentice (HAMMER at the anvil), a sweeper at dawn | HAMMER, (SWEEP) | 2 |

### 3.4 Itineraries (the pure function)

- Each agent has a **cyclic itinerary**: a list of legs, each `walk(path, speed)` or `dwell(place, clip, seconds)`,
  generated once from the content file and the agent's seed (`hash(townSeed, agentId)`); its period `P` is the sum of
  the legs (60–600 s).
- `stateAt(nowS)`: `u = (nowS + phase) mod P`, a binary search in the cumulative leg times, then the position along
  the leg's polyline, the heading (smoothed over the last 0.4 s of the path, so turns are not snaps), the clip and the
  clip's phase. O(log legs), no allocation, the same on every client.
- **Groups** share one itinerary with per-member offsets (a chat ring, a family walking together, a porter and his
  horse 2.4 m behind on the same path).
- **Walk speed** = the clip's loop length ÷ its duration (1.46 m/s for WALK [confirmed: sidecar `walkLength` 17 dm,
  `durationMs` 1,166]), so feet do not slide; the cart-group clips have no walkLength, so a porter's pace is a content
  number checked by eye in the lab; a walker's speed varies ±10 % with the VAT clip speed scaled to match.
- **Appear and leave** only at `door` places (building doors, the gates, alley mouths), with a 0.6 s dither fade, so
  nobody pops into the middle of the plaza (§3.5).

### 3.5 Day and night

Population by solar hour (all of the town; the plaza holds about a third) [decision; numbers tuned in the lab]:

| Hours (game time) | Folk out | What changes |
|---|---|---|
| 05–07 dawn | 25 % | sweepers, the smith's apprentice opens, vendors arrive and set up (walk in with CARRY) |
| 07–18 day | 100 % | everything; a midday peak at the market |
| 18–20 dusk | 60 % | **lantern carriers** walk the avenue; vendors pack up and leave (VENDOR01 → WALK to a door); the tea house fills |
| 20–23 evening | 25 % | tea-house sitters, couples walking, guards with torches (a socket prop with a warm point light, counted in the night-light budget) |
| 23–05 night | 8 % | guards only, a drunk leaving the pub, a cat; windows lit |

Guards keep their posts and patrols at every hour. Weather: in rain > 0.25 (the life part's threshold) walkers speed
up (WALK clip 1.15×), sitters outside leave, chatters move under eaves (places flagged `sheltered`), vendors stay
under awnings [decision].

### 3.6 Players and townsfolk

- **Not attackable, not targetable** [decision]: they are not entities; Tab/Z, auto-attack, skills and AoE never see
  them. They never block movement (no collision) [decision: the server's movement does not know them].
- **The sidestep**: when a player or mob (the threat feed) is within 0.9 m of a walker's next 2 m of path, the walker's
  drawn position takes a lateral offset of up to 0.6 m, eased over 0.4 s, and its heading follows the offset; a
  dwelling agent turns its head toward a player standing within 2 m (one neck-bone override is not possible with VAT;
  the whole body yaw turns up to 30° instead) [decision].
- **Clicking one** [decision: a flavour line, not nothing]: the cursor shows the speech cursor (`ux-world`'s NPC
  cursor) over a townsperson within 25 m; a click shows a one-line bubble over them for 4 s, picked from their role's
  lines (§3.7) by `hash(agentId, minute)`, local to the clicker, no server message. A cheap CPU pick against the agents'
  capsules only on click (≤ 140 capsules). *(Fact-check: the game is click-to-move [confirmed: `screens/world.ts`
  "input: click to move / attack / pick up"]; with 60 walkers on the plaza a pick that swallowed the click would eat
  movement.)* So [decision]: the townsperson pick runs **after** the entity and item picks and **never consumes the
  click**: the player still moves to the clicked ground point, and the bubble is a bonus; the town meshes are
  `isPickable = false`, so the ground ray is unaffected.
- **Name tags**: none (they are not characters); they do not appear on the minimap or the world map [decision: they
  would drown the NPC dots].
- **Stalls**: the player stall rule "3 m from any NPC" (PLAYTEST §9) ignores townsfolk; a townsperson's itinerary never
  crosses a player stall? It cannot know (stalls are server state the schedule does not read) [decision: walkers pass
  through player stalls with the sidestep; vendors' places are kept 6 m away from the usual player-stall spots near the
  spawn].

### 3.7 Vendor calls and speech bubbles

- **Calls** [decision: text bubbles, no voice]: a vendor in view and within 20 m calls every 12–25 s (deterministic by
  time and id, so friends see the same call), a short English line: "Fresh peaches! Sweet as honey!", "Silk from
  Dunhuang, finest weave!", "Hot buns, still steaming!", "Tea! Rest your feet, traveller.", "Good iron, fair price!",
  "Herbs for every ailment!" (the lab's set; the content file holds 8–12 per stall kind). At most 3 bubbles on screen,
  nearest first.
- **Rumours that follow the story** [decision]: chatters and clicked folk sometimes say a line tied to the local
  player's act of "The Tiger's Shadow" (QUESTS §3.1: "They say the Seal is gone from the temple…", "Tigers on the
  south slopes again…"); act read from the client's quest log, never sent anywhere.
- **The bubble** reuses the chat-bubble look (`ux-world` C8, `chat-bubble` class) as a small pool of DOM elements
  positioned by the nameplate layout code (`NameplateLayout`), so bubbles never overlap name tags [confirmed:
  `apps/game/src/world/nameplates.ts` exports `layoutPlates`]. English live text only (docs/UI.md).
- **Sound with a call**: a soft generic murmur one-shot (synthesized, §6), never words.

---

## 4. Animals

| Animal | Model | How | Count (Medium / High) | Where |
|---|---|---|---|---|
| **Pigeons** | wave 10's procedural bird (17 triangles) as a new species `pigeon` (grey, 1.5×) | `world.life.addSpecies` + `addHabitat('plaza')` (weight 1 on paving inside the plaza, landing = the ground height): the flock circles, lands on the paving, pecks and **flushes when a player or mob comes within 9 m** (GRASS_LIFE §5.3's code, no change [confirmed: `life/types.ts` `addSpecies`/`addHabitat`; a non-built-in habitat makes a "habitat flock", `life/birds.ts` `directHabitats`]). *Fact-check:* townsfolk are **not** in the threat feed (`LifeThreats` = the app's actors), so walkers would stroll through landed pigeons; the habitat's `landing` therefore refuses spots within 6 m of a route-graph edge or a dwell place [decision] | **1 flock of 10** (a habitat flock is `min(species.max, 10)` birds [confirmed: `birds.ts`]; more needs a second species id) | the plaza, the market square |
| Chickens | `cj_chicken` (204 triangles, one 9.8 s pecking clip) | VAT; a wander (turn, step 0.25 m/s, peck) inside a pen polygon | 6 / 8 | the two existing chickens' yard (165, −155), the inn's back yard |
| Cat | `p_cat` (1,170 triangles; STAND1, WALK, RUN, EMOTION01) | VAT; sits on a wall or steps (place), walks to another, runs from a player within 3 m | 1 / 2 | the west street, the tea house |
| Dogs | `p_raccoondog` (1,232 triangles; STAND1, WALK, RUN, EMOTION01) [likely: it reads as a small dog at game distance, the lab shot `proto_*`; a real dog model does not exist in the client] | VAT; follows a walker (a dog with its owner) or lies at a door | 2 / 3 | the plaza, the gate |
| Goldfish | the 6 placed `cj_goldfish` (already animated) + 6 more placements | retail, as placed; made visible by the pond fix (§7.5) | +6 | the east pond, the west pool |
| Ducks | the bird code's species `duck` (white or brown, 1.8×) with a new habitat `pondSurface` (landing = the water level; a `float` flag that keeps the folded-wing pose and bobs) | GL-L's flock code, one flag added (*fact-check:* habitat landings already hold the habitat's exact height, `fl.land(…, null, true)` [confirmed: `birds.ts`], so the flag only adds the bob and stops the peck-hops) | 1 flock of 4–6 | the east pond |
| Roof birds | wave 10's perchers (magpies, crows) | already working on town roofs [confirmed: life `perch` role from the manifest bounds] | as wave 10 | — |
| Horses | §3.1 | tied at the stable and the inn (retail placements), led by porters, ridden | — | — |

**Fish in the pond** (beyond the goldfish) and anything underwater are wave 12 [the user]. The Low guard: no animal is
added on Low; the retail chickens, goldfish and tied horses stay as placed on every preset.

---

## 5. Motion

### 5.1 Cloth in the wind, inside the batch [decision]

*(Fact-check F1: the first draft's seam does not exist. The batch merge has **no spare per-vertex channel**: a merged
group carries positions, normals, uv, uv2 (the table slot and layer packed into its integer part) and an optional
**per-instance** pivot (`pivotSize` 0, 3 for the trees' origin, 4 for "a prop's centre and radius"; one value per
instance copied to its vertices) [confirmed: `batch/merge-core.ts` `MergeGroupJob`, `MergedGroup`]. And the table is
read in the **fragment** stage only (`SroSurfacePlugin.getCustomCode` returns null for the vertex shader) [confirmed:
`pbr/surface-plugin.ts`]. What does exist and makes this cheap: cloth-class materials already get **their own group**
per region, the `+sheen` group (`tableKey`: `sheen: record.cls === 'cloth'`) [confirmed: `batch/region-batch.ts`], and
`classes.ts` puts every texture named `cloth|flag|banner|tent|curtain|sign` in the cloth class [confirmed]: of the
census, `cj_resta01_flag`, `cj_resta01_tent`, `w_cd_mc_flag` and `cj_resta03_sign` already are; `cj_streetstall_02`
is not.)* The corrected design:

- **Which materials**: everything the cloth class already holds, plus a converter list `CLOTH_MATERIALS` that reclasses
  the rest (`cj_streetstall_02`, `cj_luxu_door_sign`, `cj_stab_sign`, the new banners of §7.2) to `cloth`, each with a
  kind: `hanging` (pinned along its top edge: flags, banners, signs), `awning` (pinned along its high edge),
  `tent` (pinned at the base, the wall panels breathe).
- **The weight, from a per-piece pivot**: the `+sheen` groups get `pivotSize 4` (the merge already supports it; the
  pivot is per *piece*, i.e. per primitive and instance, so a flag on a restaurant gets the flag's own numbers, not the
  building's): `(pinY, height, kind, phase)` in world space, written by the converter-side batch record. The vertex
  stage derives `w = clamp((pinY − y) / height, 0, 1)` (hanging, awning: pinY is the top) or
  `w = sin(π · clamp((y − pinY) / height, 0, 1))` (tent: pinY is the base). +16 B per cloth vertex, a few thousand vertices in town [projected].
- **The shader**: a vertex chunk on the `+sheen` group material only (the foliage plugin's `CUSTOM_VERTEX_UPDATE_WORLDPOS`
  hook and its `sroWind` UBO, a new define `SRO_CLOTH_WIND` in that family), adding `wind × w² × (gust + flap)` along the
  weather's wind vector with the pivot's phase. It is the prototype's `TownSway` math (§11.1, GLSL and WGSL). **No new
  varying, no table read in the vertex stage, no extra draw where the region already has a `+sheen` group**; a region
  whose only cloth is a reclassed stall awning gains one group (+1 draw, + its shadow caster) [projected: ≤ +2 draws in
  view at the plaza]. Calm weather: a minimum breeze (the trees' `FOLIAGE_MIN_BREEZE` = 0.15 [confirmed]) so a banner
  never hangs dead.
- **The shadow pass** draws the cloth without the sway (the proxy casters are static) [decision: the error is a few
  centimetres of shadow].
- **Retail skinned lamps** keep their STAND1 sway; their speed already follows the wind (WX-R) [confirmed: foliage
  plugin comments].

### 5.2 Smoke, steam, fire, sparks [decision]

- **Reuse the retail effects first**: the app's ambient-fx already plays placed emitters (EFFECTS §3.15, the N100
  budget of 40 within 60 m [confirmed: `ambient-fx.ts`]). New emitters are **dressing placements** of the retail
  effect objects: `map/oas_hot_etc_b.efp` (the smith's smoke) on 6–10 chimneys and cook stoves (`cj_etc_stoveroof` is
  a stove roof that has no smoke today), `map/frame.efp` / `frame2.efp` (fire) in braziers at the gates and the
  plaza's lantern posts, `map/cj_pal_lamp_*` glows on the new lanterns. *(Fact-check: an effect plays only as an
  `ambient.json` row of a placed model, so "placing an efp" means placing a model that carries it or writing a row for
  the model, as in §7.1. The budget has room: 0 emitters within 60 m of the plaza today [confirmed], and the plan adds
  ≈ 16 glows + 4 braziers + ≈ 4 smokes there, ≈ 24 of 40.)*
- **Steam over food stalls** has no retail effect [likely: none in the census]: a small instanced-puff layer in the
  town part (the lab's smoke: camera-facing quads, thin instances, one draw for all, CPU-moved puffs, ≤ 120 puffs)
  [prototyped, §11.1].
- **Sparks at the smith**: the apprentice's HAMMER clip carries a hit event [confirmed, *fact-check*: the sidecar's
  HAMMER (`skill_ch_fortresshammer`, group `sword`) has one type-1 event at 522 ms, man and woman]; each hit spawns the retail hit-spark effect at the anvil and the hammer sound.

### 5.3 The fountain, the pond, leaves and petals

- **Fountain**: the dragon's spout runs today (retail `cj_wf_dr` waterfall effect); add a ring of ripples where it
  falls (the water material's existing rain-ripple chunk, driven by a fixed "local rain" at the basin) and a fine spray
  of the steam layer, white and short-lived [decision].
- **The pond**: fixed to read as water first (§7.5); ripples from the fish (a few expanding rings on the water surface
  through the same ripple chunk) and from the ducks.
- **Falling leaves and petals**: a new small instanced layer of 2-triangle flutters (the petal atlas of GL-A,
  `content/grass/petals.png` [confirmed: exists]) shed from trees within 40 m of the focus whose model is a maple or a
  cherry (`tre_maple*`, `tre_frie01`, the pink blossom trees): falling with the wind, settling, fading; ≤ 150 on
  Medium, one draw [decision].

---

## 6. Sound (inside docs/SOUND.md's system)

All of it runs on the existing graph (SOUND §5.2: buses `ambient` and `sfx`, the voice limits of §5.5, the spatial
rules of §5.6). New files are encoded with SOUND §3's command into `work/out/sound/town/`.

| Sound | Source | How it plays |
|---|---|---|
| **Town bed** (crowd murmur, distant footsteps, cart wheels) | **no retail file** [confirmed: no crowd/market file in `prim/snd`, 2,159 files listed]; synthesized offline (a script mixing filtered noise, pitched babble from the retail emote voices `vcm_*_emo_*`, reversed and granulated so no word survives) into 3 loops of 20 s | its own loop voice beside the area loop, as the coast's surf runs beside it (`audio/coast.ts`), not the area's one loop slot (SOUND §5.5: ambient = 1 loop + 5 one-shots) *(fact-check)*; gain = `smoothstep(0, 25, folk within 30 m)` × the ambient slider; cross-faded 1.5 s; muted at night below 5 folk. **On Low** (no `World.town`, *fact-check: the first draft's "the bed plays on Low" had no count to follow*) the count comes from the pure schedule's `populationNear(x, z, r, nowS, solarT)` (`town/schedule.ts` is importable without the town part; the app loads the content file on every preset) [decision] |
| Vendor murmur | the same synthesis, short (0.6–1.2 s) | a spatial `sfx` one-shot with each vendor call (§3.7), cull 20 m |
| Smith's hammer | **no retail anvil** [confirmed: search of `prim/snd`]; the retail weapon hits `bat*hit*` pitched down and filtered read as metal on metal [likely; by ear] | spatial, on each HAMMER hit event, cull 30 m |
| **Temple bell on the hour** | retail `env/bell towel 3.wav` [confirmed: exists, not yet exported] | at each game hour (solar time crossing h/24), positioned at the temple (259, −351), non-culled up to 300 m with a long rolloff; at 06:00 and 18:00 three strokes |
| Horses | retail `cos/cos_horse_stand/moan1/2`, `cos_horse_walk?` (stand, moan, run, thud exist) [confirmed: file list] | tied horses: a snort every 20–60 s (spatial); led horses: hoof steps from the clip's footstep events |
| Cat | retail `cos/cos_cat_stand1.wav` [confirmed] | on the cat's EMOTION01 |
| Chickens | no retail file [confirmed: no chicken/hen/cluck in `prim/snd`]; synthesized clucks | spatial one-shots, every 8–30 s, cull 20 m |
| Dogs | *fact-check:* no dog file, but the pet wolf's `cos/cos_wolf_01_stand1/moan1/2/shout.wav` exist [confirmed: the extracted client]: a canine, pitched up ≈ 1.3× it should read as a dog [likely]; synthesized bark only if the user's ear rejects it | spatial one-shots, every 15–40 s, cull 20 m |
| Donkeys, cows (porters' animals) | retail `cos/cos_donkey_stand/moan1/2`, `cos_cow_stand/moan1/2/walk` [confirmed] | as the horses |
| Pigeons | the life part's flush one-shot (GL-O, retail `day_bird*`) + a wing-clap synth | as wave 10 |
| Water | the fountain: a loop from the retail `pajang`/`pokpo*` effects' sounds if they carry one [unknown], else a synthesized splash loop | spatial loop, 25 m |
| Night insects, night birds | retail (already in `JANGAN_TOWN` night) | unchanged |
| Footsteps of townsfolk | the retail stone/dirt walk files (SOUND §2.4) | **no** [decision: 60 walkers' steps are mush; the bed covers it] |

**Synthesis instead of downloads** [decision]: nothing is downloaded (the rule of this project); the synthesized
files are made by a deterministic local script (`packages/convert/src/sound/town-synth.ts`, offline, seeded) and
judged by ear by the user (§15). A better recorded pack (CC0) is an open question with a default (§16).

---

## 7. Beauty

### 7.1 Night lighting

- **Warm pools on the plaza**: 16 lantern posts around the plaza and along the avenue (new dressing, §7.2), each with a
  retail lamp glow (`cj_pal_lamp_light.efp`) and an entry in the night-light emitters, so the light container picks
  plaza lamps when the player stands there [decision]. *(Fact-check F4: the container is **8 lights on Medium, 32 on
  High, 64 on Ultra** [confirmed: `render/quality.ts`; RENDER §4.5's "8 / 16 / 32" is stale], re-picked every 250 ms
  or 2 m (`night-lights.ts`). On Medium only the 8 nearest burn, so the pool follows the player, which is enough for the
  spawn edge but not for a lit plaza seen from across it; that is what the emissive lanterns and bloom are for.)*
- **How a lamp becomes a light** *(fact-check)*: night lights are (placement × ambient particle) pairs: a model's
  `ambient.json` row whose efp is in `NIGHT_LIGHT_KINDS` [confirmed: `night-lights.ts` header]. A placement alone gives
  no light. So TL-B either places retail models that already carry a lamp emitter (`cj_resta01_light_n`:
  `cj_pal_lamp_red` ×2; `cj3_lion_dan`: `cj_pal_lamp_light` [confirmed: `ambient.json`]) or has the converter write
  ambient rows for the new post model. First, cheapest step: the plaza's **four retail `cj_field_lamp` posts get a
  `cj_pal_lamp_light.efp` row** (they have none today) [decision].
- **Lantern strings** across the market streets (a catenary of 8–12 paper lanterns, instanced, emissive at night,
  swaying with the cloth rule), no point light each (only the emissive and bloom where on) [decision].
- **Windows**: the `*_winlight` textures (11 materials in town [confirmed: census]) get a warmer, stronger night
  emissive (the material class rule, RENDER §3.3) so streets read lived-in.
- **Guards' torches and the lantern carriers** carry a point light each through `NightLights.addDynamicLight`
  [confirmed: the hit flashes' API]. *Fact-check:* without a cluster (WebGL2 without float blending) that call returns
  false and the light would stay a scene light, changing the material light count (a recompile, RENDER §4.6). So
  [decision]: a moving light is created only when `addDynamicLight` returns true, at most 4 (the nearest), else the
  torch is emissive only.

### 7.2 Dressing (new static props)

All of it is **placements**, applied by the converter into the export (like the coast's placement edits), so the
batcher merges them with the town at no extra draw [decision]:

- **Market stalls** along the east side of the plaza and the west street: the retail `cj_streetstall` (3 today) + 8–12
  more, each with **goods**: crates, baskets, jars and cloth rolls from retail props found in the client
  (`res/bldg` and `res/etc` [unknown which; TL-K's census lists them]) or new low-poly props (≤ 300 triangles) made in
  Blender with retail-style textures;
- **Banners** on poles along the avenue (prototyped: red, gold border, 長安 painted; a cloth material);
- **Planters and flower pots** at doors and around the fountain (retail `flw_*` and pot models, or new);
- **Benches** around the fountain and under the plaza trees (retail tea-table chairs, or new);
- **Lantern posts** (§7.1), a **well** in the west street, **carts** (a retail trade cart if one exists in the client
  [unknown], else new) parked at the stable.

### 7.3 Grass in cracks and planters

The new grass (GRASS_LIFE) already grows on the terrain's grass layers. Add: a `crack` habitat for a sparse, short
variant along the paving's edges and the walls' feet (density 3–6 / m² in a 0.5 m band, from a mask the converter
draws along the nav edges of the plaza and the streets), and the planters as small grass patches with flowers
[decision; GL-F's patch path, no new draw].

### 7.4 Decals

Dirt at the gates and stall fronts, moss on the north faces of walls and steps, wet puddles after rain (the wave-9
puddle chunk already does terrain; decals add them on paving objects): one decal atlas, projected decals as an
instanced box mesh per region (one draw), Medium and up [decision; ≤ 40 per region].

### 7.5 The pond

First find out why the east pond reads dry (§1.6) in the game, not the lab; then: a turbid green-brown water colour
for town ponds (the water material's town profile), reflection kept, the ripple chunk for the fish and ducks, and the
lilies' shadow on the water [decision: town water is a profile, not a new material].

### 7.6 B2: the town texture batch [decision: include a scoped batch if the bench passes]

The user put the 9B texture batches on hold (2026-09-29), then asked for a beautiful town. The decision:

- **Scope**: only the materials a player sees at the plaza and the market from the ground: the plaza paving, the
  street paving, the town walls (inner faces), the stall and shop fronts, roofs within 60 m of the plaza: about 40
  textures [projected from `materials_census.py`: 304 distinct textures in town], through the existing B0/B1 pipeline
  (TEXPIPE: the PBR map sets, the remaster switch) — not new geometry.
- **Gate**: the LAB-11 bench at the plaza with the crowd shows texture VRAM within +60 MiB of wave 10's 807 MiB
  (Medium, WebGPU) and frame p95 not worse by more than 0.3 ms [decision]; if it does not pass, the batch ships on High
  only, and if that fails too, it is cut (§10).
- **The user sees before/after shots** of the plaza before it ships (§15).

---

## 8. Performance

### 8.1 The hard case

The town is where everyone gathers. Wave 10's final gate measured, at the plaza on **Medium WebGPU**, frame p95
**3.6 ms** with nobody around and **13.4 ms with 20 jumping bot players** (the 20-mob crowd + 20 bots, 749 draws;
4 runs 13.0–15.1 ms) [confirmed: `wave10/budgets.md`]. The 20 player characters cost ≈ 8 ms on their own (crowd 5.2 →
crowd + bots 13.4; budgets.md: +160 draws, +1.9 ms mesh evaluation, +1.7 ms shadows, +1.9 ms main draw). So **the
crowd must fit in the 1.6–3.7 ms that remains under 16.7 ms**, with margin: **budget ≤ 1.5 ms CPU p95 and ≤ 0.5 ms
GPU for all of town life on Medium at the plaza** [decision], and less than that when players crowd in (the cap below).

That rules out skinned townsfolk (60 of them would cost what 120 players cost). The tools:

- **VAT + thin instances** (prototyped): a townsperson costs a matrix write on the CPU (the lab's whole agent update,
  heights included, is 0.2–0.3 ms p50 for 77–117 agents: ≈ 0.003 ms each [confirmed: §11.3]) and a skinned vertex
  shader on the GPU (4 texture fetches per bone influence per vertex); draws are per variant, not per person.
- **The crowd gives way to players** [decision; §11.3, *fact-check F2*]: the drawn cap is `max(15, cap − 3 ×
  max(0, players in range − 5))` (Medium: 60 with ≤ 5 players, 30 with 15, **15 with 20**; High 100 → 55), and the
  VAT animals' cap halves beyond 10 players (the pigeons stay: they are the life part's). The first draft's −2 per
  player (30 folk at 20 players) projected to 14.0–16.6 ms ÷ 1.5 and **up to 17.4 ms undivided**: over the line in
  the worst repeat (§9.1). Which agents stay is decided by a fixed per-agent rank (a hash of the id), so friends
  standing together still see the same people. "Players in range" = player entities within the crowd range, the count
  the nameplates already have.
- **What the lab says to optimise** [confirmed: §11.3 split]: rendering 60 frozen VAT townsfolk costs only +0.4 ms;
  the rest is per-frame work around them. So: write only the agents in range; one `Float32Array` per variant and one
  `thinInstanceBufferUpdated` per frame; the clip buffer only when a clip changes; **no live skeleton** (bones unlinked
  from their nodes after the bake: −0.3 to −0.7 ms in the lab, inside its run-to-run noise [likely, *fact-check*]);
  heights baked into the route graph (no `heightAt` per agent per frame); frozen materials. *Fact-check:* "a VAT
  plugin with no `Skeleton` at all" is not free: Babylon only sets `NUM_BONE_INFLUENCERS` (which the VAT include
  needs for `matricesIndices`/`matricesWeights`) for a mesh with a skeleton [confirmed: 9.28
  `materialHelper.functions.js` `PrepareDefinesForBones`: `mesh.useBones && mesh.computeBonesUsingShaders &&
  mesh.skeleton`], so the
  mesh keeps an unlinked skeleton; dropping it means a custom plugin, not worth it for v1 [decision].
- **Shader warm-up**: the crowd's PBR + VAT + thin-instance effects (and their shadow-depth effects on High) compile at
  world load through the warm-up hooks (`warmup-hooks.ts`), so the first townsperson entering range never costs a
  compile hitch (the stage's orbit already misses its 33 ms budget on pipeline builds, `wave10/budgets.md`) [decision].
  H11-HI-1 / G-11: while the plan or the drawables are still loading, the hook answers `'loading'` and the entry
  warm-up (`apps/game/src/screens/warmup.ts`) holds its shader stage for it (up to its 20 s cap) instead of giving up
  after the 4 s stall, so a slow link does not move the compile into play.
- **Range and cap per preset** (below), with a 0.6 s dither fade at the range edge.
- **Mesh LOD**: beyond 30 m a variant draws a meshoptimizer-simplified mesh (50 % triangles) as a second thin-instance
  set (one more draw per variant in view) [decision: only on High+; Medium's 60 m range keeps one LOD].
- **Animation rate LOD**: free with VAT (the GPU reads a frame; no CPU animation). Clip changes cost one 16-byte write.
- **No impostors** in v1 [decision: at 60–100 m the crowd is small on screen; impostor sheets for 10 variants × 8
  angles × several clips cost more VRAM and work than they save; revisit for Ultra's 140].
- **Shadows**: High and Ultra: the crowd casts into the first cascade only (one shadow draw per variant); Medium: a
  soft blob under each townsperson (one instanced quad draw), no cast shadow [decision: §11 measures the cascade cost].
  *Fact-check:* no VAT-aware depth path has to be written: Babylon 9.28's `shadowMap.vertex` and `depth.vertex`
  include `bakedVertexAnimation`, and `ShadowGenerator` reads the mesh's `bakedVertexAnimationManager` [confirmed:
  the 9.28 source]. The lab's casters were dropped by **our** caster list: `WorldShadows` takes a character only if its
  *root's* position is within `CHARACTER_CASTER_M` (50 m) [confirmed: `render/shadows.ts`], and a thin-instance variant's
  root sits at the world origin, ≈ 150 m from the plaza. TL-C registers the crowd through `addCasterSource` (range from
  the agents, not the root) and limits it to cascade 0 itself.
- **TAA on High and Ultra smears the walking crowd** *(fact-check F3)*. High and Ultra use TAA without reprojection
  (D30: `taaReprojection` is off because the velocity pass broke thin instances on WebGPU) [confirmed:
  `render/post.ts`], so anything moving while the camera stands still blends into its history. The prototype's own
  High shot shows it: walkers drawn semi-transparent with trails (`proto_close_noon.png`; crops
  `work/tmp/town-life/crop_ghost.png`, `crop_ghost2.png`) [confirmed]. Players and mobs smear the same way today
  [likely], but 60 walkers make it constant. [decision]: LAB-11 adds gate **G5-11** (no visible trail on a walking
  townsperson on High with the camera still); TL-C first tries D30's reprojection with the crowd's previous matrices
  (`thinInstance` previous-matrix buffer); if that is not fixed in wave 11, High and Ultra fall back to D30's documented
  MSAA ×4 while town life is drawn (LAB-11 measures its cost).
- **Bubbles**: ≤ 3 DOM elements, positioned with the nameplate layout pass already running.

### 8.2 Counts per preset [decision]

| Preset | Townsfolk drawn (in range; minus 3 per player beyond 5, ≥ 15) | Range | Animals | Variants (draws) | Crowd shadows | Motion | Sound |
|---|---|---|---|---|---|---|---|
| Low (Classic) | **0** (the Low guard) | — | retail placements only | — | — | retail only | the bed (its count from the pure schedule, §6) and the bell (sound costs no GPU) [decision] |
| **Medium** | **60** | 60 m | 12 + 1 pigeon flock | 10 + 2 guards + 3 animals ≈ **15** | blobs (1 draw) | cloth sway (batched), smoke/steam, leaves ≤ 150 | all |
| High | 100 | 90 m | 16 + pigeons + ducks | 14 + 2 + 4 ≈ 20 (+ far LOD ≤ 20) | cascade 0 | as Medium, leaves ≤ 250 | all |
| Ultra | 140 | 120 m | 20 | 18 + 2 + 4 ≈ 24 (+ LOD) | cascade 0–1 | as High | all |

An Options row "Town life: Off / Low / Full" (Graphics), default Full on Medium+, Off on Low; "Low" halves the counts
(the Mac and iGPU default, like Grass: Low) [decision].

**Applied after LAB-11 (I-11, WAVE_PLAN7 §7 cut 20, second step):** on Medium no townsfolk are drawn while 15 or more
players are in range (`TOWN_PRESETS.medium.noFolkFrom`); the animals, the pigeons, the motion layers and the sound stay,
and the bed counts the schedule's people instead of the drawn ones. The first step (60 → 40 folk, 60 → 45 m) was not
applied: at 20 players the floor of 15 already holds, so it would have cost the usual few-player plaza and saved nothing
in the scene that missed. Numbers: Dropbox `wave11/budgets.md`.

### 8.3 The batching contract

- The crowd, animals, puffs, leaves and lantern strings are **never** batched: `metadata.sroWorld = 'town'`, refused
  by the region claim (a TL-0 test, beside `'scatter'` and `'life'`).
- The dressing props are **always** batched: they enter the export as placements before the batcher sees the region,
  so they cost no draw beyond the region's groups [confirmed: the batcher builds from the live placements, WAVE_PLAN6
  D6]. New materials enter the atlas and the table like any other (BT-A); cloth materials join the region's `+sheen`
  group (§5.1, F1).
- No new texture unit on any world material (cloth uses the `+sheen` group's per-piece pivot, no table read in the
  vertex stage); the crowd material adds one sampler (the VAT) to a character-like PBR set; the town materials
  register their define sets in `material-budgets.test.ts` (≤ 16 WebGL2 units, ≤ 15 varyings + `front_facing`).

---

## 9. Budgets (WAVE_PLAN6 §5 format; 1080p; the dev PC = Ryzen 5 9600X + RX 9060 XT, Chrome)

"Today" is wave 10's final gate re-bench [confirmed: `wave10/budgets.md`, frame p95, the production bundle]. "With town
life" = today + the lab's measured A/B delta (§11.3) ÷ 1.5, the lab's per-operation slowness against the game
(BATCHING F17; WAVE_PLAN6 §5.2 uses the same correction) [projected]. *(Fact-check F2: F17 calibrated the lab's
slowness **per draw**; town life's cost is mostly script and buffer work, so the ÷ 1.5 is not proven for it. Each cell
now gives the ÷ 1.5 value and, where it matters, the undivided one. The lab deltas come from all four Medium WebGPU
one-draw runs, +2.0 to +3.4 ms p95.)* Medium uses the player-aware cap of §8.1 (−3 per player beyond 5, ≥ 15).

### 9.1 Per preset

**Frame p95 on the dev PC, WebGPU / WebGL2, ms:**

| Preset | Plaza noon, nobody else (today → with town life) | Plaza crowd + 20 jumping players (today → with town life) | Market street, dusk | Pass line |
|---|---|---|---|---|
| Low | 2.5 / – → **unchanged** (no town life on Low) | 9.4 / – → unchanged | unchanged | pass (the Low guard) |
| **Medium** | 3.6 / 2.8 → **≈ 4.9–5.9 / ≈ 3.6–4.0** (60 folk + 12 animals; undivided 5.6–7.0 / 4.0) | 13.4 / 8.5 (repeats 13.0–15.1) → **≈ 13.7–16.2 / ≈ 9.0–9.3** with the cap (15 folk, animals halved); undivided 14.0–16.8; with the first draft's −2 cap (30 folk) 14.0–16.6, undivided up to 17.4; uncapped 14.3–17.4, undivided 15.0–18.5 | ≈ the plaza (fewer folk in range, more dressing) | **G1-11 < 16.7: pass with the cap, ≈ 0.5–3.0 ms spare (÷ 1.5)**; the one undivided corner over the line (16.8) adds the upper bound to wave 10's pre-fix 15.1 ms repeat; against the final re-bench's 13.4 ms it is 14.4–15.1. LAB-11 decides; cut item 11 is the fallback |
| High | 5.2 / 3.3 → ≈ 6.4–7.0 / ≈ 4.0–4.5 (100 folk; one WebGL2 block read +5.3 ms p95, noise) | 17.1–19.3 / – → already misses (the characters, wave 10) → + ≈ 0.6–1.2 with the cap (55 folk) | as the plaza | **G2-11** (WAVE_PLAN6 G2's lines with town life on): plaza ≤ 12 → ≈ 6.4–7.0, 20-mob crowd ≤ 14 → ≈ 8.7–9.5: pass |
| Ultra | not re-run in wave 10 → ≈ + 1.5–2 (140 folk) | not a target | — | G3 only |

| Preset | Town draws at the plaza | Town GPU (dev) | Mid desktop (CPU × 1.5) | Laptop / M1 (CPU × 1.4–2) | VRAM | Download |
|---|---|---|---|---|---|---|
| Low | 0 | 0 | unchanged | unchanged | 0 | the bell and the bed, ≈ 0.4 MB (sound plays on Low) |
| Medium | **≈ 16** (10 people variants + 2 guard + 3 animal kinds + the blob layer; the lab: +16) + ≤ 2 cloth groups (§5.1) | **+0.1–0.4 ms** (lab done-probe) | plaza ≈ +2.0–5.1 ms CPU p95 (the ÷ 1.5 delta × 1.5 at the low end, the undivided × 1.5 at the high end) | plaza ≈ +1.9–6.8 ms (× 1.4–2, same two ends); **the Mac / iGPU default "Town life: Low" halves it** | ≈ 19 MB *(fact-check: 2 VATs ≈ 4 MB half float; 10 atlases 1024² at 1 B/texel (BC7/ASTC, the arrays' formats) + mips ≈ 13 MB; animals ≈ 2 MB; the first draft's 12 MB assumed 0.7 MB atlases)* | ≈ 10–15 MB *(fact-check: the first draft's 3.5 MB left the atlases out: 10 × KTX2 ≈ 6–11 MB, VATs ≈ 3, geometry ≈ 1, sounds ≈ 0.5)*; TL-V tries 1024 × 512 atlases first (the retail body texture is 512 × 256 [confirmed: sidecar]), which halves the atlas share |
| High | ≈ 20 (+ far LOD ≤ 20) + cascade-0 casters ≤ 14 | +0.3–0.5 ms | ≈ +1.8–2.7 ms | not the target | ≈ 25 MB | + 4 variants (≈ + 3–5 MB) |
| Ultra | ≈ 24 (+ LOD) | ≈ +0.6 ms | not offered | not offered | ≈ 30 MB | as High |

What the tables mean, honestly:

- **Medium holds 60 fps in town with town life on**, but the 20-player plaza is the tightest scene in the game: wave
  10 left ≈ 1.6–3.7 ms of room there and town life takes most of it. The player-aware cap is what keeps it under
  16.7 ms; without it the worst repeat goes over, and with the first draft's gentler cap the undivided projection
  did too [projected, F2].
- **The cost is CPU, not GPU**: the GPU barely notices 60 VAT townsfolk (+0.1–0.4 ms). Most of the CPU cost is the
  per-frame work around them, which §8.1's optimisations remove; the frozen-crowd split puts the floor at ≈ 0.3 ms in
  the game [projected from the lab's +0.4]. The script and buffer share of that CPU cost is exactly what F17's ÷ 1.5
  does not cover, so the mid-desktop and laptop columns above span the ÷ 1.5 delta (low end) to the undivided one
  (high end), times their CPU factor.
- **The friends' laptops and M1s**: in a 20-player plaza they are already bound by the player characters (wave 10:
  the High crowd misses there); town life adds ≈ 1.9–6.8 ms at full counts, about half on their default "Town life:
  Low", and the −3-per-player cap cuts it further in exactly that scene [decision].
- **The numbers rest on one lab on a shared machine**: repeats of the same A/B differ by up to 0.8 ms; LAB-11 (§12.3)
  re-measures in the production bundle before anything ships.

### 9.2 Per-lane budgets (dev PC, 1080p, the plaza; the GPU lock for every in-browser measurement)

| Lane | Budget |
|---|---|
| TL-C | town CPU ≤ 1.0 ms p95 at the plaza on Medium (60 folk + 12 animals) in the production bundle; GPU ≤ 0.3 ms; draws ≤ variants in range + 3; zero allocations per frame after warm-up; agents out of range ≤ 0.02 ms per 100 |
| TL-R | `stateAt` for 300 agents ≤ 0.05 ms per frame; the content file ≤ 200 KB |
| TL-V | per variant ≤ 3,000 triangles and one atlas ≤ 1024²; each VAT ≤ 2.5 MB half float; a VAT frame within 1 mm of the skinned pose at float32 and within 3 mm after the half-float quantisation *(fact-check: a half float steps 0.98 mm between 1 and 2 m, where the bone translations live, so 1 mm at half float would fail on rounding alone)* |
| TL-M | cloth sway ≤ +0.05 ms GPU at the plaza; 0 draws where the region already has a `+sheen` group, ≤ +2 draws in view at the plaza (§5.1, F1); puffs + leaves ≤ 0.1 ms CPU and ≤ 2 draws |
| TL-S | ≤ 0.05 ms main thread per frame; the bed as its own loop voice beside the area loop (like the coast's surf); the bell and the animal one-shots inside the ambient bus's 5 one-shots (SOUND §5.5: 6 = 1 loop + 5) |
| TL-B | dressing ≤ +4 draws per region (atlas cells) and ≤ +0.2 ms CPU at the plaza; new lamps through ambient rows, served by the preset's container (8 / 32 / 64, F4); ≤ 30 of the ambient-fx budget's 40 within 60 m of the plaza; B2 within §7.6's gate |
| Town life together | ≤ 1.5 ms CPU p95 and ≤ 0.5 ms GPU on Medium at the plaza (G3-11) |

---

## 10. Scope-cut order (cut from the top)

1. Ultra's 140 and High's far LOD (keep the counts of Medium on High).
2. Falling leaves and petals.
3. Decals.
4. Ducks; the rider; children running.
5. The four new clips (SIT_CHAIR, CARRY, TALK, SWEEP): fall back to retail clips (sitters on the rim and steps only,
   porters lead horses only).
6. Synthesized chicken/dog/hammer sounds (keep the bed, the bell and the retail cos sounds).
7. Lantern strings (keep the lantern posts).
8. Steam layer (keep the retail smoke effects on chimneys).
9. Crowd shadows on High (blobs as on Medium).
10. The B2 town batch (§7.6 gate; ships on High only before it is cut).
11. Medium's crowd 60 → 40, range 60 → 45 m; and if G1-11 still misses: **no townsfolk drawn on Medium with ≥ 15
    players in range** (the pigeons, the motion and the sound stay) *(fact-check F2)*.
12. **Ask first:** clicking for flavour lines; rumours; vendor bubbles.

**Never cut:** the Low guard (Low identical); the determinism (same crowd for every friend, no server state); no
collision and no targeting of townsfolk, and no click ever swallowed by one; Medium at 60 fps at the plaza with 20
players (G1); the cloth sway inside the batch's `+sheen` groups (≤ +2 draws in view); the batcher's refusal of the
`'town'` tag; the pigeons; the night lighting pools; the town bed and the bell; no smeared walkers on High (G5-11).

---

## 11. The prototype

### 11.1 What was built [confirmed: `work/tmp/town-life/lab/town-lab.ts`]

A scratch page on the viewer root, served by a private Vite on :5261 with `work/out` at `/out/` and the scratch
conversions at `/tl/`. It loads the real `jangan-fields` world through `loadWorld` (PBR, batching, grass, life,
streaming, at the chosen preset and engine), then adds:

- **The retail NPCs** of `npcs.json` within 170 m (25 at the plaza), skinned, STAND1 looping (as the game shows them,
  without the game's animation LOD);
- **`players` skinned player characters** (undressed bodies, 9 meshes each; the stand-in for the "20 players": the
  game's players are dressed and shadowed, ≈ 8 draws each), two thirds of them running loops;
- **The crowd**: 8 dressed variants (four men, four women; retail bodies + the retail garment sets
  `ITEM_CH_{M,W}_CLOTHES_0{1,2,3}_{BA,LA,FA}[,HA]_A`, merged into one mesh per variant with their bone indices remapped
  by joint name), each with its own VAT baked in the page from 8 retail clips (STAND1, WALK, EMOTION01, EMOTION03,
  WAIT01, SIT, VENDOR01, WALK_cart_walk) at 30 fps (WAIT01 and EMOTION03 are out of the production set, F6); Babylon's `BakedVertexAnimationManager` with thin instances and the
  `bakedVertexAnimationSettingsInstanced` buffer (per-instance clip start/end/offset/speed). Roles: chatting groups
  (rings of 3–4 taking turns), 4 vendors with VENDOR01, 5 sitters on the fountain rim, 2 porters leading `t_horse1`,
  4 guards (`ch_guard_spear`, WALK) patrolling the avenue, the rest walkers on random routes over the plaza paving
  (sampled where the ground height is the paving level; the real build uses the route graph);
- **Animals**: 7 chickens, 2 dogs (`p_raccoondog`), a cat, a standing horse, all VAT; **pigeons** as a `pigeon`
  species on a `plaza` habitat of `world.life` (no new mesh);
- **Banners**: 12 banners on poles along the avenue, thin instances (3 draws: poles, arms, banners), a PBR material
  with the `TownSway` plugin (a `CUSTOM_VERTEX_UPDATE_WORLDPOS` chunk in GLSL and WGSL: weight² × wind × gust × flap,
  per-instance phase from the world position);
- **Smoke**: 4 emitters × 18 camera-facing puffs, one thin-instanced quad, CPU-moved, one draw;
- **Speech bubbles**: DOM, projected each frame (composited into the shots).

Bench method: the lab's own (the production bundle was not built: the polish workflow is editing the tree): 400
frames after streaming idled and 90 settle frames, driven by a MessageChannel pump at ≥ 15 ms per frame (the pane is
hidden), CPU = the frame's agent update + `world.update` + `scene.render` (+ submit), GPU = `EngineInstrumentation`
GPU frame time, draws = the engine's draw counter; GPU lock held; WebGPU and WebGL2 on the same build. The lab has no
animation LOD and no pooled interpolation (RENDER §11.6), so its absolute numbers are higher than the game's; the
**deltas** are what carry over.

### 11.2 What the prototype showed [confirmed: the shots]

The sheet `work/tmp/town-life/proto-sheet.jpg` puts today next to the prototype (High, WebGPU; shots in
`work/tmp/town-life/shots/`: `survey_*` today, `proto_*` with town life):

- **It works on both backends**: VAT + thin instances with Babylon 9.28's `BakedVertexAnimationManager` draws the
  dressed retail bodies walking, standing, chatting, sitting and selling on WebGPU and WebGL2, with **0 WebGPU
  validation errors** in every run [confirmed: the page's `uncapturederror` hook].
- **The retail player bodies need dressing**: undressed they render in underwear (`proto_test.png`). Dressed with the
  retail garment sets they read as Jangan townsfolk at game distance (`proto_close_noon.png`), hats on some. The
  garment glbs' bone indices had to be remapped by joint name: the legs pieces list their joints in another order
  than the body [confirmed: the equipment manifest's `clothes_03_la` joint list].
- **The plaza stops being empty** (`proto_plazaN_noon` against `survey_plazaN_noon`): people crossing, groups, vendors
  with their bubbles, a porter leading a pack horse, a dog, banners lining the avenue.
- **Retail cos/npc materials carry the BMT emissive** (0.59 grey): the pack horse rendered pure white until the lab
  zeroed it [confirmed]; TL-V converts the actor materials as the game's actor path does.
- **Smoke at night glows** (`proto_close_night`): the puffs' emissive term blows out under the night exposure; puffs
  must be lit, or scaled by 1/exposure like the fireflies (GRASS_LIFE §5.4) [confirmed: the shot].
- **Night is still dark and flat** (`proto_plazaN_night`): the prototype added no light; §7.1's lantern posts and their
  emitters are what the night needs [confirmed: the shot].
- **Banners** sway well in motion; a one-sided painted texture shows the glyphs mirrored from behind: the real banners
  need a two-sided texture or a back face with its own UVs [confirmed: the shot].
- **Scale**: 60–70 townsfolk fill the 120 m octagon without crowding it; High's 100 starts to feel like a market day
  [likely: by eye].
- **Not in the prototype**: the route graph (walkers took random points on the paving, so some cut through the
  fountain's rail), the schedule, sound, the pigeons' landing (registered, not seen in a shot), cloth in the batch,
  night lights, dressing and decals.

### 11.3 Measurements [confirmed: measured, GPU lock held 09:12–09:27]

The plaza (100, −112) looking south, 1920 × 1080, hardware scaling 1, 20 skinned stand-in players (two thirds running)
and 25 retail NPCs in view. **In-page A/B**: after streaming idled and 200 settle frames, 12 alternating blocks of 70
frames (the first 10 of each dropped) with every town mesh drawn and updated ("on") or hidden and skipped ("off");
CPU = agent update + `world.update` + `scene.render` + submit; GPU = submit → `queue.onSubmittedWorkDone` (WebGPU only:
WebGL2's `finish()` does not block in Chrome, and Babylon's WebGPU timestamp counter read 0 here, as in wave 10's
bench). "One draw per variant" = each variant's sub-meshes collapsed onto one material (the stand-in for TL-V's atlas:
the same cost, wrong textures). Raw JSON: `work/tmp/town-life/shots/ab_*.json`, `bench_*.json`.

| Backend | Preset | What is A/B'd | CPU p50 on / off | CPU p95 on / off | GPU p50 on / off | Draws on / off |
|---|---|---|---|---|---|---|
| WebGPU | Medium | all (60 folk, 17 animals, 12 banners, 72 puffs), retail sub-materials (5–8 draws per variant), before the buffer fixes | 12.6 / 9.8 (**+2.8**) | 15.0 / 12.5 (+2.5) | 4.2 / 4.0 | 412 / 355 (+57) |
| WebGPU | Medium | all, one draw per variant, first run (09:17, `ab_gpu_med_60_onemat.json`; *fact-check F2: left out of the first draft's table and ranges*) | 10.7 / 8.2 (**+2.5**) | 15.8 / 12.4 (+3.4) | 4.0 / 3.8 (+0.2) | 372 / 355 (+17) |
| WebGPU | Medium | all, one draw per variant | 9.6 / 7.8 (**+1.8**) | 12.6 / 10.6 (+2.0) | 3.9 / 3.8 (+0.1) | 372 / 356 (+16) |
| WebGPU | Medium | all, one draw per variant, skeletons unlinked (run 1) | 8.8 / 7.7 (**+1.1**) | 12.8 / 10.7 (+2.1) | 4.0 / 3.8 (+0.2) | 372 / 355 (+17) |
| WebGPU | Medium | the same (run 2) | 10.2 / 8.3 (**+1.9**) | 16.3 / 13.5 (+2.8) | 4.3 / 3.9 (+0.4) | 372 / 355 (+17) |
| WebGPU | Medium | the 60 folk only, frozen (no update: the render cost alone) | 8.2 / 7.8 (**+0.4**) | 10.7 / 10.0 (+0.7) | 3.8 / 3.7 (+0.1) | 356 / 346 (+10) |
| WebGPU | Medium | the 60 folk only, moving | 9.4 / 8.0 (+1.4) | 11.7 / 11.7 (0) | 3.8 / 3.8 | 365 / 355 (+10) |
| WebGPU | Medium | animals, banners and smoke only | 8.6 / 7.9 (+0.7) | 11.0 / 9.9 (+1.1) | 4.0 / 3.9 (+0.1) | 364 / 359 (+5) |
| WebGPU | High | all, 100 folk + 17 animals, one draw per variant | 14.1 / 12.6 (**+1.5**) | 19.5 / 17.7 (+1.8) | 7.1 / 6.8 (+0.3) | 510 / 493 (+17) |
| WebGL2 | Medium | all, 60 folk, one draw per variant | 6.9 / 6.2 (**+0.7**) | 11.1 / 9.9 (+1.2) | – | 371 / 355 (+16) |
| WebGL2 | High | all, 100 folk | 6.9 / 5.8 (**+1.1**) | 13.4 / 8.1 (+5.3, one noisy block) | – | 510 / 493 (+17) |

Other measurements:

- **Agent update** (positions, headings, clip switches, `heightAt` per agent): 0.2–0.4 ms p50, 0.4–0.7 ms p95 for
  77–117 agents [confirmed: `crowdUpdateMs` in the `ab_*.json` files]. The unlink A/B: runs without unlinking read
  +1.8 / +2.5 ms p50, runs with it +1.1 / +1.9: ≈ −0.3 to −0.7 ms, inside the 0.8 ms run-to-run spread [likely, F2]. The
  lab file was edited after the runs (09:27), so which run had which flag rests on the file names.
- **Bake in the page**: ≈ 5 s for 13 variants (loading the 10 MB character glbs and sampling 8 clips); production bakes
  offline (TL-V), so the client only fetches the VATs.
- **VAT memory in the lab**: 20.5 MB of float32 for 13 per-variant VATs [confirmed: `vatBytes`]; per skeleton at half
  float it is ≈ 1.6 MB each [projected, §3.2].
- **Variant size** [confirmed: the merged meshes]: 1,547–1,988 vertices, 2,050–2,646 triangles, 43 / 45 bones per
  dressed person; the guard 926 triangles, the horse 1,032, the chicken 204. Clip lengths: WALK 1.17 s, STAND1
  2.33 / 2.67 s, SIT 2.67 s, VENDOR01 13.3 / 10.3 s (man / woman).
- **Crowd shadows**: not measured. Handing the thin-instanced VAT meshes to the renderer's character caster list left
  the draw count unchanged (the caster path did not take them) [confirmed: `ab_gpu_high_100_shadows` draws 505 against
  510]. *Fact-check:* the reason is our caster list, not Babylon: `WorldShadows` keeps a character only when its
  root is within 50 m of the camera, and the variant roots sit at the origin (§8.1); Babylon 9.28's shadow-map shader
  already supports VAT and thin instances [confirmed]. TL-C registers the crowd through `addCasterSource`; LAB-11
  measures the cascade-0 cost [unknown].
- **TAA smear** (High): `proto_close_noon.png` shows walkers semi-transparent with trails, the TAA history blend
  without reprojection (§8.1, F3) [confirmed: crops `crop_ghost.png`, `crop_ghost2.png`].
- **The lab's absolute numbers are higher than the game's** (no animation LOD for the 45 skinned actors, no pooled
  interpolation, a pumped page on a machine shared with the polish workflow's previews); only the deltas carry over.

### 11.4 Projection to the game and the friends' machines [projected]

- Game delta = lab delta ÷ 1.5: Medium WebGPU ≈ +0.7–1.7 ms p50 and +1.3–2.3 ms p95 with 60 folk; undivided
  +2.0–3.4 ms p95 (F2: the ÷ 1.5 was calibrated per draw, and this cost is script and buffers). §8.1's optimisations
  should bring it toward the frozen floor (≈ +0.3 ms) plus the agents in range (≈ 0.15 ms); TL-C's budget is 1.0 ms p95.
  **G3-11 (≤ 1.5 ms) is at risk** until those optimisations land: the first draft's own numbers already exceeded it.
- With 20 players in the plaza the cap leaves 15 folk and half the animals. Splitting the lab's p95 delta into the
  extras (animals, banners, smoke: +1.1 ms) and the crowd (+0.9 to +2.3 ms), the town's share there is ≈ +0.7–1.1 ms
  ÷ 1.5 (+1.0–1.7 undivided): the scene lands at ≈ 13.7–16.2 ms on Medium WebGPU (13.0–15.1 today), 14.0–16.8
  undivided (§9.1). p95 deltas do not add exactly; LAB-11 measures the real scene.
- Mid desktop: × 1.5 → ≈ +2.0–5.1 ms; laptop / M1: × 1.4–2 → ≈ +1.9–6.8 ms, halved by "Town life: Low" (their
  default) and cut further by the player cap.
- GPU: ≤ 0.5 ms on every preset at the dev PC; an M1 at Retina 0.75, ≈ 3× → ≤ 1.5 ms (the WAVE_PLAN6 M1 factor).

---

## 12. Lanes

### 12.1 Step order

```
step 0:  TL-0 (world-render + game seams, one agent)  |  TL-K (converter census of usable props, data only)  |  TL-A2 (Blender clips: data work starts at once)
step 1:  TL-C (crowd runtime)  |  TL-V (crowd assets in the converter)  |  TL-R (routes + content)  |  TL-M (motion)  |  TL-S (sound)  |  TL-B (beauty, dressing)
step 2:  TL-L (lab panel + bench: LAB-11)  ->  TL-B's B2 batch (only if the §7.6 gate passes)  ->  I-11 integration and the hunt
```

**Seams with the polish workflow** *(fact-check: `git status` on 2026-10-01)*: it is editing
`packages/world-render/src/grass/*`, `ocean/*`, `shore/*`, `coast/chunks.ts`, `textures.ts`, `packages/texpipe/*`,
`packages/convert/src/world/convert-world.ts` and `world/coast/{hook, placements, …}.ts`. So TL-B's crack grass
(`grass/*`), its dressing hook (`convert-world.ts`, beside the coast's placement hook) and the B2 batch (`texpipe`)
start only after the polish workflow has merged, rebased on its result; TL-0 touches none of those files [decision].
TL-0's files (`world.ts`, `batch/types.ts`, `batch/region-batch.ts`, `life/*`, `screens/world.ts`, `ux-world.ts`,
`settings.ts`, `hud/options.ts`) are not in the polish set today [confirmed: git status].

### 12.2 The lanes

| Lane | Owns (files) | Seams it uses | Tests | User check |
|---|---|---|---|---|
| **TL-0** (seams, first) | `packages/world-render`: `World.town: TownPart \| null` in `world.ts` (made on PBR only, updated after `life`, disposed with the world), `town/types.ts`, `'town'` appended to `batch/types.ts` `UNBATCHED_TAGS`, **`pivotSize 4` on the `+sheen` groups and the per-piece cloth pivot in the batch record** (`batch/region-batch.ts` jobs, the record's `cloth` kind; *F1: replaces the first draft's "cloth bit and per-vertex slot", which do not exist*), the `SRO_CLOTH_WIND` define slot in the foliage plugin's vertex hook, the life part's `float` landing flag (bob only); the shadow seam `addCasterSource` is already public (no change); `apps/game`: the `townLife` setting + Options row (`settings.ts`, `hud/options.ts`, `i18n/en-render.ts`), `world.town?.setClock(ctx.serverNow)` and `setThreats` in `screens/world.ts`, the bubble/click hooks in `ux-world.ts` | — | the claim refuses `'town'`; `World.town` is null on Classic (**the Low guard**); `setRenderMode` disposes and re-makes it; with no cloth-kind record the `+sheen` groups merge byte-for-byte as today (pivotSize 0); the setting normalises | — |
| **TL-V** | `packages/convert/src/town/{variants, vat, atlas}.ts` + the `town` CLI verb: dress each variant (body + garment glbs, bone indices remapped by joint name, the lab's `remapBones`), pack its textures into one atlas, write `town/variants/<id>.glb` (one mesh, one material) and `town/vat/<skeleton>.bin` + `.json` (clip table: start, end, fps, loop length) at half float | the equipment manifest, `@sro/appearance` | `town-vat.test.ts` (a VAT frame = the skinned pose of the source clip at that time within 1 mm at every vertex at float32, within 3 mm after half-float quantisation, NullEngine); one draw per variant; joints remapped by name | the variants sheet (all outfits, three angles) |
| **TL-A2** | `packages/convert/tools/blender/town/key_town.py`, `content/moves/<skel>/{sit_chair, carry, talk, sweep}.json` (the jump's MV-A pipeline, MOVEMENT §3.2) | `blender.ts`, the `moves` verb | the MV-A checks (control ≤ 0.1°, contacts ≤ 1 mm, loops close) | the clip GIFs |
| **TL-R** | `packages/convert/src/town/build-graph.ts` (the navmesh skeleton, POI snapping), `content/town/jangan.json`, `packages/shared/src/town.ts` (`validateTownFile`, the types) and `town/schedule.ts` in world-render (pure) | `@sro/nav` | every edge on the navmesh (0.5 m steps) and ≥ 0.4 m from nav edges; `stateAt` is deterministic (two "clients" with clocks 80 ms apart agree within 0.15 m); appear/leave only at doors; no agent inside a building; the population curve per hour; places' seats never double-booked | walk the plaza at noon and at night: people where they should be |
| **TL-C** | `packages/world-render/src/town/{crowd, animals, bubbles, props, index}.ts` (VAT managers with the rebased time base (F5), thin-instance buffers, range and the −3-per-player cap with the dither fade, blob shadows, the cascade-0 casters on High through `addCasterSource` (F3 note: Babylon's shadow shader already does VAT), the TAA answer (reprojection or the MSAA fallback, G5-11), the warm-up compile, the sidestep, the non-consuming click pick, the pigeon and duck species registration with the route-aware landing) | TL-0's part; TL-V's assets; TL-R's schedule | `town-crowd.test.ts` (NullEngine: draws = variants in range; no allocation per frame after warm-up; hidden with `isVisible` at count 0; caps per preset and per player count; nothing on Classic; `manager.time` stays < 3,600 s with a 2026 epoch clock and the frame a client draws equals the schedule's clip phase; a click on a townsperson still yields the move intent); 0 WebGPU validation errors in the lab | the plaza at noon: busy, nobody pops in, nobody slides |
| **TL-M** | the cloth vertex chunk under `SRO_CLOTH_WIND` in `pbr/foliage-plugin.ts`'s vertex hook on the `+sheen` group material (the `TownSway` math; F1: not in `surface-plugin.ts`, which has fragment code only), the cloth reclass list and per-piece pivots in the converter (`town/cloth.ts`), the steam/puff and leaf layers (`town/fx.ts`), the ripple hooks in `water.ts` (a "local rain" point list) | TL-0's `+sheen` pivot; the weather's `sroWind` | define off = today's shader strings; `material-budgets.test.ts` registrations; no new varying | banners and awnings sway with the wind; calm still breathes; smoke leans downwind |
| **TL-S** | `apps/game/src/audio/town.ts` (the bed with the folk-count gain, the bell on the hour, vendor murmurs, animal one-shots), `packages/convert/src/sound/town-synth.ts` (seeded synthesis), the export of `bell towel 3.wav` and the `cos` files used (`export-sound.ts` list) | SOUND §5 graph, the town part's "folk near" count (on Low, the pure schedule's `populationNear`) | `audio-town.test.ts` (bell once per game hour; bed gain monotone in the count; the bed on Low follows the schedule; voice limits respected) | listen at the plaza, the smith, the stable, at night |
| **TL-B** | dressing placements (`content/town/jangan.json` `dressing`, applied by the converter's `town/dressing.ts` before the batcher's inputs, like CST-C's C9), the new props (Blender, ≤ 300 triangles each, retail-style textures), the night-light emitters for the new lamps, the crack-grass mask, the decal layer (`town/decals.ts`), the pond profile; later the scoped B2 batch config (TEXPIPE) | TL-K's census; the batcher (no change); NL's emitter list (lamps need `ambient.json` rows, §7.1; the four `cj_field_lamp` rows first); after the polish merge (§12.1) | every new placement on the navmesh's ground and not blocking a nav edge (the server's collision is unchanged: props are decoration only, or the nav is re-baked [decision: decoration only, placed off the walkable paths]) | before/after sheet of the plaza, the market, night |
| **TL-K** | `work/tmp/town-life/props-census.*` (data: which retail props in `res/bldg`, `res/etc`, `res/nature` can serve as goods, pots, benches, carts) | — | — | — |
| **TL-L** | `apps/viewer/src/world/town-panel.ts` (counts, roles, clock scrub, A/B), the LAB-11 bench scenes | all | — | — |

### 12.3 LAB-11 (the gate)

The wave-10 method (production bundle on a private preview, a private server on a temp copy of `game.db`, the GPU lock,
400 frames, 1920 × 1080), scenes: **plaza noon with 20 bot players + the crowd** (the gate scene), plaza noon crowd
only, plaza night, the market street, the gate at dusk (lantern carriers), the stage select and create; Medium on both
backends first, then High and Ultra on WebGPU. **G1-11**: Medium p95 < 16.7 ms in every scene on both backends (the
20-player plaza included); **G2-11**: High WebGPU ≤ 12 ms at the plaza and ≤ 14 ms in the 20-mob crowd, town life on
(WAVE_PLAN6 G2's own lines; *fact-check: the first draft's "≤ 14 at the plaza" loosened G2*); **G3-11**: town life
adds ≤ 1.5 ms CPU p95 and ≤ 0.5 ms GPU on Medium at the plaza (at risk until §8.1's optimisations land, §11.4); G4: the
Low guard, the material budgets, 0 WebGPU validation errors, the crowd's draws ≤ the variants in range + 2;
**G5-11** *(F3)*: on High, a still camera at the plaza shows no trail or transparency on a walking townsperson (a shot
pair 0.5 s apart, judged at 200 % zoom), and no shader compiles when the first townsperson comes into range.

### 12.4 Cross-lane tests (I-11)

- A live Low ↔ Medium switch leaves no town mesh, VAT texture, bubble or sound loop behind.
- Two NullEngine worlds with clocks 80 ms apart draw every agent within 0.15 m of each other.
- The stage (palace steps) shows townsfolk walking in the plaza behind the create screen, never on the steps where the
  characters stand (a `noFolk` circle the stage passes) [decision].
- The batcher never claims a `'town'` mesh; the dressing placements are in the region batches; a flag in a `+sheen`
  group sways and its region's draw count is unchanged.
- The pigeons never land within 6 m of a route edge; a click on a walking townsperson moves the player.

---

## 13. Risks

| Risk | Likelihood | Effect | Mitigation |
|---|---|---|---|
| TAA smears the walking crowd on High / Ultra (F3) | **certain** (seen in the prototype's High shot) | a ghostly town on the friends' default desktop preset | G5-11; reprojection for the crowd, else D30's MSAA ×4 fallback while town life is drawn |
| The VAT clock fed epoch seconds (F5) | certain if not designed in | every townsperson frozen or jumping (float32 step 128 s) | the rebased time base (§2.2) and its unit test |
| The ÷ 1.5 projection is optimistic for script work (F2) | medium | G1-11 missed in the 20-player plaza | the −3-per-player cap, cut item 11's "no folk with ≥ 15 players", LAB-11 on the production bundle |
| Clicks on the crowd eat click-to-move | high without the rule | players stuck clicking townsfolk in a busy plaza | the pick never consumes the click; town meshes not pickable (§3.6) |
| Collisions with the polish workflow's files | high | merge conflicts in grass, texpipe, convert-world | §12.1: TL-B's grass, dressing hook and B2 wait for the polish merge |
| VAT on WebGL2 Mac Safari / M1: float textures and the vertex-fetch cost | medium | the crowd slow or wrong on a friend's Mac | half-float VAT (needs `textureHalfFloat`; WebGL2 has it); the "Town life: Low" Mac default; the cap |
| Townsfolk mistaken for players (they wear player garments) | medium | confusion ("who is that?") | no name tags, muted per-instance tints, NPC-style idle behaviour; the user judges on the sheet |
| Walking through players and stalls looks cheap | medium | immersion | the sidestep; vendor places away from player-stall spots; dwell spots off the main lines |
| The route graph puts people inside walls or on roofs | low with the nav checks | glaring | the build script's nav checks and the "inside a building" test |
| The polish workflow changes `world-render` meanwhile (the lab ran on a moving tree) | certain | numbers drift | LAB-11 re-measures on the final tree |
| The pond's missing water is a wave-10 regression, not a look issue | medium | a bug ships | TL-B checks in the game first (§7.5) |
| Synthesized sounds sound cheap | medium | the town sounds fake | the user's ear decides; the bed is quiet; the CC0 option (§16) |
| Too many people on Medium in a 20-player crowd | low | G1 miss | the measured budget (§11), the cut list (§10 items 1, 11) |

---

## 14. Decisions (each with a one-line reason)

1. **Client-side, deterministic from the server clock and seeds** (§2.1): every friend sees the same crowd and the
   server pays nothing.
2. **A world-render part `World.town`, null on Low** (§2.3): the stage and the viewer get it for free; the Low guard
   stays green.
3. **VAT + thin instances, one VAT per skeleton, one draw per dressed variant** (§3.2, §8.1): skinned townsfolk would
   cost as much as players, which the plaza cannot afford.
4. **The retail player bodies dressed in the retail garment sets** for everyone who walks (§3.1): the only retail
   Chinese models with walk clips; no new character model is made.
5. **The mercenary guard `ch_guard_spear`/`bow` for patrols** (§3.1): the only retail soldier with WALK.
6. **Retail clips first; SIT_CHAIR, CARRY, TALK, SWEEP keyed in Blender as a separate lane** (§3.1): the town comes alive
   without waiting for new animation.
7. **Content in `content/town/jangan.json`, generated by a nav-checked script, then tuned** (§2.4): reproducible and
   reviewable.
8. **Not attackable, not targetable, no collision, no name tags, not on the maps** (§3.6): decoration must not get in
   the way of play.
9. **A click shows a one-line flavour bubble** (§3.6): cheap, local, and it makes people feel real.
10. **Vendor calls as English text bubbles, no voice** (§3.7): no voice files exist and recorded voices are out of
    scope.
11. **Rumour lines follow the local player's questline act** (§3.7): the town talks about the player's story.
12. **Pigeons and ducks as species of wave 10's bird code** (§4): no new mesh, the flush already works; one flock of
    10 pigeons (the habitat-flock size), landing only ≥ 6 m from the townsfolk's routes, since walkers are not threats.
13. **The raccoon-dog pet stands in for dogs** (§4): no dog model exists; at game distance it reads as a small dog.
14. **Cloth sway inside the region batch's existing `+sheen` (cloth-class) groups via a per-piece pivot and a vertex
    chunk** (§5.1, F1): motion with no extra draw where the group exists (≤ +2 in view); the first draft's table bit and
    per-vertex slot do not exist.
15. **Smoke and fire from the retail effects as new placements; a small puff layer only for steam** (§5.2): reuse the
    effect engine and its budget.
16. **Sounds: retail first (bell, horses, donkeys, cows, cat, the pet wolf for dogs), the rest synthesized offline by a
    seeded script; no downloads** (§6): the project's no-download rule. The bed plays on Low too, its count from the
    pure schedule.
17. **Night: the plaza's four retail `cj_field_lamp` posts get lamp emitter rows, plus 16 lantern posts with lamp
    emitters around the plaza and the avenue, lantern strings emissive only** (§7.1): the light container (8 / 32 / 64)
    needs emitters where the players stand, and an emitter is an `ambient.json` row, not a placement.
18. **Dressing as converter placements, batched** (§7.2): new props cost no draw.
19. **Include a scoped B2 town texture batch if the LAB-11 gate passes; else High only; else cut** (§7.6): the user
    now asked for a beautiful town, and the gate protects the 60 fps rule.
20. **Counts: Low 0, Medium 60, High 100, Ultra 140; an Options row Off/Low/Full; Macs and iGPUs default to Low**
    (§8.2): Medium must hold 60 fps with 20 players.
21. **Medium: blob shadows; High+: cascade-0 casters through `addCasterSource`** (§8.1): cast shadows for 60 people
    cost a cascade's draws; Babylon's shadow shader already handles VAT, our root-distance caster filter was the gap.
22. **No impostors in v1** (§8.1): small gain at our ranges, high cost.
23. **The stage keeps folk off its steps** (§12.4): the select/create shot stays clean.
24. **The new props are decoration only, placed off the walkable paths; the navmesh is not re-baked** (§12.2 TL-B): the
    server's movement stays untouched.
25. **The crowd gives way to players: −3 drawn townsfolk per player in range beyond 5, never below 15, the VAT
    animals halved beyond 10 players, by a fixed per-agent rank** (§8.1, F2): with every lab run counted and without
    the unproven ÷ 1.5, the first draft's −2 / ≥ 20 rule projected over 16.7 ms.
26. **The VAT meshes keep an unlinked skeleton** (bones unlinked after the bake) (§8.1): the lab's ≈ −0.3 to −0.7 ms
    (within noise); a skeleton-free mesh would turn Babylon's VAT define off, so no custom plugin in v1.
27. **Actor materials converted as the game's actor path does (the retail emissive zeroed); smoke and steam lit, not
    emissive** (§11.2): the lab showed a white horse and glowing smoke at night.
28. **The VAT clock runs on a rebased time base** (`manager.time = nowS − t0`, re-based hourly) (§2.2, F5): float32
    cannot hold epoch seconds.
29. **Townsfolk never consume a click; town meshes are not pickable** (§3.6): click-to-move must work in a busy plaza.
30. **No WAIT01–04 on townsfolk; chats use EMOTION01/02/04/07 and STAND3; three retail gait styles in the shared VAT**
    (§3.1, F6): the WAIT clips are qigong casting holds, and one gait for 60 people reads as a parade.
31. **High / Ultra must not smear the crowd: TAA reprojection for the crowd, else MSAA ×4 while town life draws**
    (§8.1, F3, G5-11): the prototype's High shot shows the trails.
32. **The town file ships inside the export (`world/<world>/town.json`)** (§2.4): `/out/` serves `work/out` only.
33. **TL-B's grass, dressing hook and B2 work start after the polish workflow merges** (§12.1): they share its files.

---

## 15. Needs from the user

**To start: nothing.** Every tool is installed, nothing is downloaded or uploaded, and every item has a default.

1. **The prototype sheet** `work/tmp/town-life/proto-sheet.jpg` (the plaza before/after at noon, at night, the close-up
   of the dressed townsfolk). **Default:** build as shown.
2. **Townsfolk wear player garments.** Is that fine, or must townsfolk look clearly unlike players? **Default:** player
   garments with muted tints and no name tags.
3. **The synthesized sounds** (the bed, chickens, dogs, the hammer) by ear when TL-S lands. **Default:** ship them
   quiet; the user can turn the ambient slider down.
4. **The B2 town batch before/after shots** (§7.6). **Default:** ships if the gate passes.
5. **The jump** (the user's latest message, "also jumping needs to be a bit higher"): this is MOVEMENT's, not this
   spec's. The polish workflow is editing the jump clips right now [confirmed: `git status` shows
   `content/moves/*/jump*.json` and `docs/MOVEMENT.md` modified; MOVEMENT.md's status says P-JUMP raised the lift from
   0.2–0.3 m to about 0.6 m on 2026-10-01]. Nothing in TOWN_LIFE changes it. **Default:** the polish workflow's P-JUMP
   value; if the user still wants it higher after trying it, that is a one-number change in MOVEMENT's keying.

## 16. Open questions (each with its default)

1. **How busy?** Medium 60 in range is the measured-safe number; the user may want a quieter or busier town.
   **Default:** 60 / 100 / 140.
2. **A recorded crowd/market/animal pack** (CC0, needs a download approval). **Default:** no; synthesized.
3. **Children** (a small female body at 0.82 scale running) may look odd. **Default:** in, cut item 4.
4. **Rumour lines tied to the questline** reveal plot to a player who has not read it? They only follow the act the
   player is in. **Default:** in.
5. **Should townsfolk react to the Tiger Girl's world-boss announcement** (the wave's other item: people hurry indoors
   for a minute, guards run to the gate)? **Default:** yes, as a 60 s schedule override the town part starts on the
   `uniqueNotice` "appear" message (docs/UNIQUES.md §3.3; no new server field, no server cost). *Fact-check:* UNIQUES
   §3.3 has **no late replay on login**, so a friend who logs in during that minute sees the normal schedule, and the
   start differs between clients by their message latency (≈ 0.1 m of drift for a minute): accepted, it is cosmetic.
   Nothing about loot or the boss is exposed (the town reads only the notice every player already gets). Designed with
   the Tiger Girl spec's lanes (U-P's message type is the seam).
6. **The pond** (§1.6, §7.5): a bug or a look? **Default:** TL-B checks in the game first; a bug goes to the next
   integration, a look goes into the pond profile. (The plane's height is right, §1.6.)
7. **Crowd shadows on High** are not measured. **Default:** blob shadows on every preset until LAB-11 measures the
   cascade-0 caster source (§8.1); High gets cast shadows only if G2-11 still passes with them.
8. **If TAA reprojection cannot be fixed for the crowd in wave 11**, High and Ultra switch to MSAA ×4 while town life
   is drawn (G5-11). **Default:** that fallback; the user sees the before/after on the LAB-11 sheet.

---

## 17. Fact-check log (2026-10-01, adversarial pass)

Each first-draft claim marked [confirmed] was re-derived. What changed (F-numbers are cited in place):

| # | First draft | Found | How checked | Fixed in |
|---|---|---|---|---|
| F1 | Cloth uses "a spare per-vertex channel" (the foliage pivot) and "one bit in the table texel" read by the batch vertex code | No such channel: the merge carries an optional **per-instance** pivot (`pivotSize` 0 / 3 / 4) only; the table is read in the fragment stage only. But cloth-class materials already have their own `+sheen` group per region, and most census cloth is already in the class | `batch/merge-core.ts`, `batch/region-batch.ts` `tableKey`, `pbr/surface-plugin.ts` `getCustomCode`, `pbr/classes.ts` RULES, the model sidecars' texture names | §5.1, §8.3, TL-0, TL-M, D14 |
| F2 | Lab delta "+1.1 to +1.9 p50, +2.0 to +2.8 p95"; ÷ 1.5 → the capped 20-player plaza at 14.2–16.0 ms with 0.7–2.5 ms spare | The first one-draw run (`ab_gpu_med_60_onemat.json`, +2.5 / +3.4) was left out; the ÷ 1.5 is BATCHING F17's **per-draw** factor, not proven for script work; undivided, the −2 cap reaches 17.4 ms | the 12 `ab_*.json` files; BATCHING F17's text; arithmetic in §11.4 | §0, §8.1, §9.1, §11.3–11.4, cut item 11, D25 |
| F3 | (not in the draft) | High's TAA runs without reprojection, so walkers smear: visible in the prototype's own High shot | `render/post.ts` D30 notes; `shots/proto_close_noon.png` crops | §8.1, G5-11, risks, D31, Q8 |
| F4 | "the 32-light container (RENDER §4.5: Medium 8, High 16, Ultra 32)" | 8 / 32 / 64 in code; 0 emitters within 60 m of the plaza; a light needs an `ambient.json` row; the 4 plaza lamp posts have none | `render/quality.ts`; manifest × `ambient.json` scan; `night-lights.ts` | §1.9, §7.1, §5.2, D17 |
| F5 | (not in the draft) | Babylon's VAT time is one float32 uniform; epoch seconds would freeze the crowd | 9.28 `bakedVertexAnimation.js`, `bakedVertexAnimationManager.js`; the lab used page time | §2.2, TL-C test, D28 |
| F6 | Chatters and dwellers use "WAIT01–04" (the lab did) | They are `skill_china_gigong_wait_a–d`, qigong casting holds | the body sidecars' BAN names | §3.1, §3.3, D30 |
| F7 | Crowd shadows need "a VAT-aware depth path" | Babylon's shadow-map and depth shaders already do VAT; our caster filter tests the root's distance (origin, ≈ 150 m away) | 9.28 `shadowMap.vertex.js`, `shadowGenerator.js`; `render/shadows.ts` | §8.1, §11.3, TL-C, D21 |
| F8 | "1 flock of 10–14" pigeons that flush "when anyone walks within 9 m" | A habitat flock is `min(max, 10)`; the threat feed has no townsfolk, so walkers stroll through landed pigeons | `life/birds.ts` `directHabitats`, `life/types.ts` | §4, D12 |
| F9 | A click shows a bubble | The game is click-to-move; a consuming pick would eat movement in a crowd | `screens/world.ts` input section | §3.6, D29 |
| F10 | The bed plays on Low with gain from "folk within 30 m" | On Low there is no town part to count | §2.3's own Low guard | §6, TL-S |
| F11 | VAT ≈ 1.6 MB for 1,100 frames; a 1 mm VAT test at half float; download ≈ 3.5 MB, VRAM ≈ 12 MB | ≈ 1,500 frames (≈ 2 MB); half floats step ≈ 1 mm at 1–2 m; the atlases were not in the download and were under-counted in VRAM | Babylon's baker layout ((bones + 1) × 16 floats per frame); clip durations from the sidecars; `texture-compressed.ts` formats | §3.2, §9.1, §9.2, TL-V |
| F12 | Content at `/out/content/town/jangan.json`; the bodies "14 + 14"; smaller facts | `/out/` serves `work/out` only; 13 + 13 bodies (+ a hair glb each); `sky-clock.ts` is under `world/features/`; `UNBATCHED_TAGS` also holds `'ocean'`; goldfish 3 in the east pond, not 6 | `vite.config.ts`, the char folder, the manifest | §1.3, §2.1, §2.3, §2.4, §3.1 |
| F13 | G2-11 "High ≤ 14 at the plaza" | WAVE_PLAN6's G2 is ≤ 12 at the plaza, ≤ 14 in the crowd | `wave10/budgets.md` gate table | §9.1, §12.3 |
| F14 | (not in the draft) | The polish workflow is editing grass, texpipe, ocean, shore and the converter's world/coast files | `git status` | §12.1, D33, risks |

**Re-derived and confirmed as written:** the world clock and `ServerClock` (`net/clock.ts`); `dayLengthMin 120` and
`dayNightSpeedup 0.4` (`apps/server/src/config.ts` W9_DEFAULTS); the life part's `addSpecies` / `addHabitat` /
`setThreats` and `LIFE_WEATHER.rainOn 0.25`; `FOLIAGE_MIN_BREEZE` 0.15; the ambient-fx budget 40 within 60 m;
`layoutPlates` in `world/nameplates.ts`; the chat-bubble class in `ux-world`; `content/grass/petals.png`; the
material-budget limits (16 units, 15 varyings + `front_facing`); `grassQualityFor`'s Apple / iGPU default;
`europeman_skel` / `europewoman_skel` for every Chinese body; only `chinaetc_qinshiquest` walks among the NPC models;
`ch_guard_spear` / `bow` WALK (926 / 1,072 triangles), `t_horse1` 1,032, `p_cat` 1,170, `p_raccoondog` 1,232,
`cj_chicken` 204; WALK 1,166 ms with walkLength 17 dm; VENDOR01 13.3 / 10.3 s; `bell towel 3.wav`,
`cos_cat_stand1.wav`, the `cos_horse_*` set and 2,159 retail wavs; no chicken, dog, crowd or anvil sound; the temple
at (259, −351); the fountain at (97, −80); half-float VATs in Babylon 9.28; 0 WebGPU validation errors in all 18 lab
JSONs; `vatBytes` 20.5 MB; wave 10's 3.6 / 13.4 ms, 807 MiB and 13.0–15.1 ms repeats; the stall rule (3 m from NPCs,
`social/stall.ts`); the jump status in MOVEMENT.md (P-JUMP, ≈ 0.6 m). Nothing in this design needs a download or an
upload; the CC0 sound pack stays an open question defaulting to no (§16.2).
