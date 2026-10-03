# Wave plan 9: wave 13, "fishing and cooking, swimming, the world under the sea, and the hot springs"

This plan merges four fact-checked specs into one build order for wave 13:

- **docs/FISHING.md** (item 1): eight fishing waters found on the server's own nav, the retail Jangan Ferry pier and a
  new S1 pier (S-DECK), three Blender rods, a skill-based catch mini-game replayed by the server, 19 species, junk,
  three treasures, the Rusty Bronze Key, 24 bottle letters and one legendary (the Dragon Gate Carp), a fishing level
  1–10, nine clips on both skeletons, and cooking: 12 dishes in one refreshment slot shared with the springs' teas.
- **docs/SWIMMING.md** (item 2): one depth rule (`SWIM_DEPTH_M` 1.2), a `swim.bin` layer built by one pure function,
  authoritative swimming with chained legs, diving with breath (no drowning), five swim clips per skeleton, monsters
  kept out of the water, the camera allowed under the surface, and the World Editor's D30 turned into "swimmable, not
  walkable".
- **docs/UNDERWATER.md** (item 3): `World.underwater` with procedural caustics, per-channel absorption and Snell's
  window, bed regions under the S1 dive zone, retail-first scenery (the takla wreck, the stone tortoise as the Dragon
  King's shrine), `World.sea` life in ≤ 5 draws, and server-checked events (the shrine's coffers, giant clams,
  gathering, the Jade Tortoise sighting).
- **docs/HOT_SPRINGS.md** (item 4): Jade Mist Springs on the south-east ridge shelf, three pools, unlit steam, soaking
  through the existing `sit`, a persisted Rested pool (+50 % kill EXP up to 20 % of a level, one fill per 20 h), the
  hangout (bubbles, ambience, the attendant and her teas).

The user's words, verbatim:

> Fishing off the beaches and the pier with rare catches and cooking for small buffs.

> Swimming in the sea, with a swim animation.

> Under water scenery, life, and events.

> Hot springs: a relaxing spot in the mountains where resting builds bonus EXP for your next session, and a natural
> hangout for chatting.

> we can use meshy if needed for speed up process

Wave 14, *The Climb* (re-tune levels 1–20, the Qin-Shi Tomb dungeon, nemesis monsters, a storm Qilin, and the
death penalty from level 15 the user asked for, NIGHT_LOG 22:51), comes next: this plan leaves hooks for it (§11) and
designs none of it.

**The user delegated every decision.** Wherever there is a choice, this plan takes the option it would mark
"(Recommended)" and writes it as a decision with a one-line reason (§2). Only what truly needs the user is left in §8
and §10, each with the default used meanwhile. **Delegation is not a deploy OK:** wave 13 deploys only after a new OK
from the user (D44). The user's 22:54 rule ("if it misses 60 fps, just deploy") was given for waves 10 + 11 and is not
read as covering wave 13.

This plan does what WAVE_PLAN8 did for wave 12:

- it settles every place where the four specs (and the wave-12 build still in the tree) would give a file or a piece
  of state two owners (§2), with **one owner per shared module**: the ocean and coast files, the server movement and
  nav, the moves pipeline, the World Editor's water rule, items and skills (§2.1, §2.2);
- it fixes the format additions (three migrations, the wire, the manifest, content files, one setting) in one list
  (§3);
- it lands **the seams first** (§4), on disjoint files, before any lane;
- it schedules **Blender keying and the Meshy jobs early** (pre-start and step 1), and every GPU item on one queue
  (§6.1);
- it holds the sum of the four items against the measured wave-11 rescue bench and WAVE_PLAN8's wave-12 projections
  (§5), with four new G1 scenes (a busy S1 beach with anglers and swimmers, 20 swimmers, 20 divers at the shrine, 20
  soakers at the springs);
- it orders the lanes, the re-converts, the integration and bench, a hunt with lenses, the fixers, a final gate and an
  independent verify (§6), and gives one scope-cut order with a never-cut list (§7), what the user approves (§8),
  risks (§9), open questions (§10), the wave-14 hooks (§11) and the deferred list (§12).

When this plan and a spec disagree, **this plan wins**. The specs stay the detailed design of each lane; a lane reads
its spec sections and this plan's row for it.

**Tags** (as in WAVE_PLAN8):

- **[confirmed]**: checked in the code or data of the working tree on 2026-10-02, measured by a spec's prototype and
  re-derived by its fact-check, or measured at the wave-11 rescue gate. Each one says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived), not measured on that setup.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this plan makes. The user may overrule it.

**Repo state when this was written [confirmed: `git log`, `git status`, 2026-10-02 ≈ 09:30 UTC].**

- HEAD `cb65112` (the wave-11 G1 rescue; waves 10 + 11 live as release 20261002-075151-cb65112). **Wave 12 is building
  in the working tree, uncommitted** (73 changed paths: `apps/game` settings and Options, `apps/server/src/gm.ts`,
  `packages/convert/src/{cli, world/convert-world, world/manifest, world/passes}.ts`, `packages/nav/src/{index,
  world}.ts`, `packages/world-render/src/{world, objects, terrain, batch/*, grass/*, night-lights, life/spawn}.ts`, the
  new `world/uids.ts`, `terrain-edit.ts`, `placement-scale.ts`, `trees/`, ...). Its step 0 and T12-A are done
  (NIGHT_LOG 04:41, 09:30); its later steps are running.
- The four specs are in `docs/` (untracked) and fact-checked. This plan edits none of them.
- **Meshy balance: 1,840 credits** [confirmed: read at 09:32:04Z through the repo's `MeshyClient` with
  `work/tmp/trees/w12/meshy/balance.ts`, a GET with no job; the key stayed inside the client]. The four designs and this
  plan spent **0** credits (no job, so no NIGHT_LOG row).
- **The database is at schema 10** (`apps/server/src/db.ts`: 10 migrations, `SCHEMA_VERSION = MIGRATIONS.length`)
  [confirmed: read]; wave 12 adds none (WAVE_PLAN8 §3.1).
- Scratch the lanes port from: `work/tmp/fishing/` (`minigame/sim.js`, `tune.mjs`, `bench.mjs`, `blender/key_fish.py`,
  `spots/survey.mts`, `factcheck/*`), `work/tmp/swimming/` (`key_swim.py`, `keys/`, `pack.ts`, `census.ts`,
  `domain.ts`, `factcheck/*`), `work/tmp/underwater/` (`uw.ts`, `creatures.py`, `conv/`, `bench.js`, `fc_*`),
  `work/tmp/hot-springs/` (`site.ts`, `route.ts`, `restsim2.py`, `nestshift.ts`, `lab/`). This plan's arithmetic is
  `work/tmp/w13-plan/budget.py`; its preview sheet is `work/tmp/w13-preview.png` (also in Dropbox
  `wave13/w13-preview.png`), made by `work/tmp/w13-plan/make_preview.py`.

---

## 0. Summary

1. **Four items, one seam step.** Seven foundation agents run first, in parallel, on disjoint files, from the
   **wave-12 final commit** (after G-12 and V-12; D1): **W13-PR** (the wire and shared content types, incl. the
   per-key bound table that today's `HWAN_MAX` loop lacks), **SW-P** (`swim.ts` shared + `packages/nav`'s swim walker
   and tile-mask hook), **HS-P** (`springs.ts`, the pure rest maths), **W13-SV** (the server spine: kill-modifier list,
   regen factors, the per-hit guard, module stubs, all three migrations, the GM rows), **W13-WR** (the world-render
   spine: four `World` slots, `HeightFog.suspended`, S-WATER, S-PUFF, `bedOnly`), **W13-CV** (the converter spine: the
   pass slots and order, manifest fields, two uid ranges, the moves kinds and flags, the authored-data merge hook, the
   sound cue rows) and **W13-G** (settings, features, i18n, the extra-pack loader, the mock server). Work that needs no
   shared file starts **at once, while wave 12 builds**: the three Blender keyers (fishing, swim, SOAK), the bpy art
   (rods, pier, pavilion, sea plants and creatures, the fish generator), and the Meshy bake-off for the Jade Tortoise
   (§6.0).
2. **One owner per shared module** (§2.1): the ocean and sky render files → **UW-R**; the coast converter files →
   **SW-C**; `packages/nav` → **SW-P**; the server's walker, AI and mounts → **SW-S**; `export-moves.ts` and the moves
   CLI → **W13-CV** (then frozen); the World Editor's water rule → **SW-E**; authored items, shops and NPC defs →
   **FS-I**; the refreshment slot → **FS-K**; `protocol.ts` → **W13-PR**; `gameplay.ts`, `db.ts`,
   `connection.ts`, `gm.ts` → **W13-SV**; `world-render/world.ts`, `water.ts`, `town/fx.ts` → **W13-WR**.
3. **Formats (§3):** three migrations (**11** the `characters` columns: `rest_*` + `refresh_*`; **12** `fishing` +
   `fishing_records`; **13** `sea_claims`), all landed by W13-SV in step 0 (D5); additive wire (11 requests and events,
   `MoveState.mode/next`, `EntityState.swim/diveAt`, a new entity kind `fire`, six optional `PlayerStats` keys); new
   world files (`swim.bin`, `fishing/water.bin`, `springs.json`) and manifest fields; content under
   `content/{fishing, swim, sea, springs, items, shops, npcs}/`; one setting ("Easy fishing timing").
4. **Meshy (§0.3):** build cap **400**, planned **40** (the Jade Tortoise: J1 image-to-3D 30 + J2 retexture 10, early,
   in the pre-start), contingencies ≤ 90 (the pavilion 60 only after two failed looks; one J1 retry 30); worst case
   130, leaving ≥ 1,710 of 1,840 (the ≥ 200 reserve holds). Every job a NIGHT_LOG row.
5. **Budgets (§5), against the wave-11 rescue bench (measured) + WAVE_PLAN8's wave-12 deltas (projected):**
   - **G1, Medium < 16.7 ms p95 everywhere**, with four new scenes: **the S1 beach at dusk with 12 anglers on the pier
     and the sand, 8 swimmers and a campfire** ≈ 8.0–10.5 ms WebGPU (≤ 13.5 late in a session) / ≈ 5.6–7.4 WebGL2;
     **20 swimmers off S1** ≈ 8–10 (≤ 12.5) / ≈ 6.5–7.5; **20 divers at the shrine during a sighting** ≈ 6.5–10
     (≤ 13) / ≈ 5–8.5; **20 soakers at the springs** ≈ 9–12 / ≈ 6.5–8.5 [projected]. **Every existing scene
     unchanged** (no fishing, swimming or springs in view; the underwater plugin measured within noise above water on
     both backends [confirmed: UNDERWATER §8.3]). The old red line (Tiger Girl with 20 players, 16.3–17.3 ms as a later
     fight) is not changed by this wave; the performance pass after wave 13 owns it.
   - **G2 (High)** keeps its lines (the plaza and the crowd: no wave-13 cost there); the 20-character water scenes on
     High are ≈ 12–17 ms, reported, not gated.
   - **VRAM** Medium +7–14 MB at most at once (S1 + the springs); **download** ≈ +2.7–3.2 MB for a Medium player who
     does everything, almost all lazily (the swim pack and `swim.bin` ≈ 0.1–0.2 MB eagerly); **deploy** ≈ +4–5 MB.
   - **Not on a base M1:** the S1 beach alone is 11–15 ms there, so a crowd of friends at S1 or the springs runs under
     60 fps on a base M1 until the performance pass; each feature's own share is ≤ 0.3–0.7 ms on an M1 (§5.2).
6. **Order (§6):** pre-start (new files only) → step 0 seams → step 1 the lanes of the four items in parallel →
   checkpoint **X1** (`swim.bin`, the 1.2 m wade line, bed regions, decks, the sea dressing, the springs layers and
   `springs.json`, the fishing grid, the three packs, the items merge) → step 2 the dependent lanes (FS-S, FS-K, FS-R,
   FS-G, HS-G, HS-Q, UW-E) → checkpoint **X2** → **I-13** integration → **LAB-13** bench → **H-13** hunt with 20 lenses →
   **F-13** fixers → **G-13** final gate → **V-13** independent verify → the user's checks → **deploy only on a new OK**.
7. **Never cut** (§7): **fishing with rare catches** (the mini-game with the server's replay, the legendary, treasure,
   the bottle letters), **cooking with small buffs** in the shared slot, **swimming with its animations and server
   rules** (SWIM and SWIM_IDLE on both skeletons, the swim layer, the locks, monsters out of the water, the exit and
   evade rules), **the underwater scenery with sea life** (the state with absorption, the surface from below, a bed
   under the dive zone, the shrine and its coffer, the clams, one fleeing school, the Jade Tortoise), **the hot springs
   with the rest bonus** (three pools and steam, soaking, the persisted Rested pool with its cap, daily budget and
   anti-AFK rule, the HUD segment, the trail fix), plus the Low guard and G1.
8. **What the user must do (§8):** nothing blocks the start; no download. The user looks at the preview sheet, then
   after the build spends ≈ 35 minutes on four play checks and two look sheets, picks the tortoise on one sheet, and
   gives the deploy OK (a DB backup comes first: three migrations).

### 0.1 Where each user request lands

| User request (verbatim fragment) | Where | Lanes |
|---|---|---|
| "Fishing off the beaches" | FISHING §2.1: S1 South Beach, Jangan Bay, the sea, plus the moat, river, swamp, ponds, tomb moat, ferry basin | FS-W, FS-C, FS-S |
| "and the pier" | FISHING §2.2: the retail Jangan Ferry pier (as is) and the new 62 m S1 pier (S-DECK) | FS-D |
| "with rare catches" | FISHING §5.4–§5.7: the legendary, treasure, the Rusty Bronze Key, 24 letters, trophies, records; UNDERWATER §6.3: the Jade Tortoise's ×2 window | FS-C, FS-S, UW-S |
| "cooking for small buffs" | FISHING §7: 12 dishes, stations, the refreshment slot (S-BUFF) shared with the teas | FS-K, FS-C, HS-E |
| "Swimming in the sea" | SWIMMING §2–§3, §5–§8: the depth rule, `swim.bin`, the 150 m band and the dive zone, the server's legs, diving | SW-P, SW-C, SW-S |
| "with a swim animation" | SWIMMING §4: SWIM_IDLE, SWIM, SWIM_FAST, SWIM_ENTER, SWIM_EXIT on both skeletons | SW-A, SW-G |
| "Under water scenery" | UNDERWATER §3–§4: bed regions, the wreck, the shrine, plants, caustics, absorption, Snell's window | UW-C, UW-D, UW-R |
| "Under water ... life" | UNDERWATER §5: `World.sea` (schools that flee, crabs, a turtle, a ray, jellies) | UW-L, UW-D |
| "Under water ... events" | UNDERWATER §6: the shrine's coffers, giant clams, gathering, sightings | UW-S, UW-E |
| "Hot springs: a relaxing spot in the mountains" | HOT_SPRINGS §2–§3: Jade Mist Springs, three pools, steam, lamps, the pavilion | HS-E, HS-W, HS-B |
| "resting builds bonus EXP for your next session" | HOT_SPRINGS §5: the Rested pool, the overnight soak, the cap and day budget | HS-P, HS-S, HS-G |
| "a natural hangout for chatting" | HOT_SPRINGS §4: soaking, bubbles, ambience, the attendant and teas; FISHING §2.3 the piers | HS-G, HS-SND, HS-E |
| "we can use meshy if needed for speed up process" | §0.3: the Jade Tortoise bake-off (40 credits, early); everything else bpy | UW-D |
| standing goal "at least 60 fps" | §5: G1 with four new scenes, G2, G6 (the Mac margin), zero-allocation rules | LAB-13, G-13 |

### 0.2 What the specs' fact-checks changed, and this plan takes as given [confirmed: each spec's fact-check section]

| From | Change | Where it lands here |
|---|---|---|
| FISHING (fact-check) | One 0.80 s strike window for every fish (1.2 s Easy), the class revealed only at the hook; a stopped cast holds the line until its bite step | FS-P, FS-S; H-13 lens 1 |
| FISHING | Easy timing re-tuned (warnings +0.15 s, snap ×2, +6 m line, +30 s); Golden Grain is a groundbait; the pity re-derived (≈ 3 h of eligible fishing per bite) | FS-P, FS-C |
| FISHING | Daily soft cap counts **400 accepted casts**; spot fatigue is **personal** | FS-S |
| FISHING | The S1 pier runs **62 × 4 m from the dry sand (z ≈ 1274) to z ≈ 1336**, ≈ 1.6 m deep at its end; S-DECK uses a **new `content` uid source 0xF000–0xF0FF**; piles are solids, ladders are exits | W13-CV, FS-D |
| FISHING | Water grid 4-bit body + 4-bit depth, the playable area + a 16 m ring, 38.6 KB brotli measured; closure by body, not by the town box | FS-W |
| FISHING | Rods cast no shadows; zero per-frame allocation; the clip pack ≈ 200–230 KB per skeleton | FS-R, FS-A |
| SWIMMING F8 | **A swimmer climbs out only onto components the town reaches today** (else 1.22 km² with 121 nests of level 19–30 would open); `openShore` is the wave-14 hook | SW-P, SW-C, SW-S |
| SWIMMING F1, F2, F5 | The camera's pitch opens to 1.95 rad in water; the ±0.35 m band clamps the pitch with a one-frame snap; **no split pass, no fog swap** (UNDERWATER's state draws the water) | SW-G, UW-R |
| SWIMMING F9, F10, F12 | Exits only over wade or a bank ≤ 0.6 m; a mob kept from its attacker by water evades; only a plain `moveTo` swims | SW-S, W13-SV (the hit guard) |
| SWIMMING F13 | The walker's tile-mask hook sits in `packages/nav/src/world.ts`, which wave 12 edits: landed after the wave-12 commit | SW-P (D1, D14) |
| SWIMMING F16 | `swimMul`, `breathMul` are optional `PlayerStats` keys (no effect-stat channel exists) | W13-PR (S-STATS) |
| UNDERWATER F1 | Three migrations collide on 11 | D5: 11 / 12 / 13 |
| UNDERWATER F5, F6 | The heroes are scaled copies **without collision** (S-SCALE cannot take 0.13); divers ride over solid props by a `solid` box that raises `swim.bin`'s bed (S-FLOOR) | UW-C, UW-D, SW-C |
| UNDERWATER F8 | WebGL2's extra ≈ 2 ms was an every-frame instance-buffer upload, not the shading: **upload only on change**, bind shared state by name | UW-R, UW-L; G4 |
| UNDERWATER F9, F10 | Kelp and urchin sell for 2 gold, 30 picks a day; daily claims need level 10 | UW-S |
| UNDERWATER F14 | `seaEventsAt(serverMs, clock, weather)`; one GM-only `seaHold` message | W13-PR, UW-S, UW-E |
| HOT_SPRINGS F1 | `validate.ts` bounds every optional stat key by `HWAN_MAX` 5 [confirmed: `validate.ts` 979]: a per-key bound table first | W13-PR |
| HOT_SPRINGS F2 | SIT_CHAIR's seat is 0.537 m: soakers drawn with the seat at surface − 0.45 m; soak needs ≥ 0.3 m of water | HS-G, HS-P |
| HOT_SPRINGS F3 | The nests move **40 m**, not 25 m (the 80 m leash gate); the route test is "no route point within 85 m of an aggressive home" | HS-E (D20 overrides FISHING §2.3's 25 m) |
| HOT_SPRINGS F4, F5 | Cap **20 %** of a level (10 % did not pay for the walk); one fill per 20 h (1.2 a day sustained) | HS-P, HS-S |
| HOT_SPRINGS F6, F15 | S-REWARD is one modifier list; S-REGEN factors multiply; S-WATER uses per-source ripple lists and profiles, never null, both defines warmed | W13-SV, W13-WR |

### 0.3 Meshy: what "if needed for speed" means here [confirmed: the specs' ledgers, NIGHT_LOG 13:56 and 15:05–15:22, the balance read]

- **Wave 12's bake-off already answered the general case**: for stylised props and card foliage the bpy route wins
  (NIGHT_LOG 15:18, 15:22). Every wave-13 model is a small stylised prop, a keyed clip or a procedural creature, which
  bpy makes in seconds (UNDERWATER: turtle, ray, jelly in 3.1 s; FISHING: rods ≤ 200 triangles; HOT_SPRINGS: a
  ≤ 2,500-triangle pavilion).
- **The one place Meshy can help is an opaque hero creature**: the Jade Tortoise reads as "programmer art" close up
  from bpy (`dev-turtle.png`). UNDERWATER §5.6's bake-off (J1 image-to-3D 30 credits from a locally painted SDXL
  concept, J2 retexture of the bpy turtle 10 credits) runs **early** (pre-start, §6.0) so its pick never blocks the
  build.
- **Build budget [decision, D31]: cap 400, planned 40**, contingencies: ≤ 60 for the pavilion **only if** the bpy
  pavilion fails the look check twice (HOT_SPRINGS HS11), ≤ 30 for **one** J1 retry if the first result fails the
  size rule (≤ 3k triangles, ≤ 1.5 MB with its texture). Worst case 130; ≥ 1,710 of today's 1,840 stay (the ≥ 200
  reserve rule holds). Through the repo's `MeshyClient` only, the key never printed, one NIGHT_LOG row per job (what,
  credits, result). The generated files come back through that client (the user's standing permission, NIGHT_LOG
  13:56); nothing else is downloaded.
- Retexture and image-to-3D both drop the extra vertex attributes and normalise the scale [confirmed: NIGHT_LOG 15:22]:
  the flap weights and the scale are re-applied in bpy after either job; J1's 2K texture is resized to 1K locally.

---

## 1. Lane ids

| Id | Step | From spec | What |
|---|---|---|---|
| **W13-PR** | 0 | all four (FISHING §8.2, SWIMMING §11, UNDERWATER §6.5, HOT_SPRINGS §7.1) | `packages/shared/src/{protocol, validate, content, quests, index}.ts`: every wave-13 wire addition, the S-STATS bound table, `ItemDef`/`EffectState`/`EntityKind 'fire'`, `requires.fishing`, `reach.swim`, type skeletons for `sea.ts` and `fishing/types.ts` |
| **SW-P** | 0 | SWIMMING SW-P | `packages/shared/src/swim.ts`, `packages/nav/src/swim.ts`, the tile-mask hook in `packages/nav/src/{world, reach}.ts`, `waterAt()` (S-WATERQ) |
| **HS-P** | 0 | HOT_SPRINGS HS-P | `packages/shared/src/springs.ts` (types, `validateSprings`, `soakPoolAt`, the pure rest maths) |
| **W13-SV** | 0 | FISHING §8.1, SWIMMING §8.1, HOT_SPRINGS §6.1, UNDERWATER §6.5 | the server spine: `gameplay.ts` (kill-modifier list S-REWARD, regen factors S-REGEN, the per-hit guard, module registrations), `connection.ts` (S-INPUT `lastInputAt`, the entry-point hook), `db.ts` (migrations 11–13, row fields, `saveProgress` extras), `gm.ts` (`/fish`, `/rest`, `/sea` dispatch rows), module stubs |
| **W13-WR** | 0 | UNDERWATER UW-0, HOT_SPRINGS S-WATER/S-PUFF, FISHING `World.fishing` | `world-render`'s `world.ts` slots, `pbr/fog-plugin.ts` `suspended`, `water.ts` + `pbr/water-town-plugin.ts` (S-WATER), `town/fx.ts` (S-PUFF, the town's ripples as one source), the `bedOnly` visibility rule, define and warm-up registrations |
| **W13-CV** | 0 | all four's converter rows | `convert-world.ts` slots, `passes.ts` order, `manifest.ts` fields, `uids.ts` (`content`, `sea`), `cli.ts` (`moves --swim/--fishing`), `export-moves.ts` (the SOAK kind), `data/{items, shops, npcs}.ts` hook lines + stub `data/authored.ts`, the sound cue rows and export scope |
| **W13-G** | 0 | FISHING §9.2, HOT_SPRINGS §8, SWIMMING §10.3 | `apps/game` settings + Options row, `world/features.ts` registrations, i18n file registration, `three/models.ts` extra-pack loader, `ux-world.ts` bubble hook, the mock server's new fields |
| FS-P, FS-I, FS-C, FS-A, FS-D, FS-W, FS-SND | 1 (FS-A, FS-D's model: pre-start) | FISHING §15.2 | shared fishing, items/shops/NPC-def merge, content, clips, decks + the S1 pier, the water grid, sounds |
| FS-S, FS-K, FS-R, FS-G | 2 | FISHING §15.2 | server, cooking + S-BUFF, render part, client |
| SW-C, SW-E, SW-A, SW-S, SW-G | 1 (SW-A: pre-start) | SWIMMING §14 (SW-E split from SW-C) | swim build + the coast files, the editor's water rule, clips, server, client + camera |
| UW-R, UW-C, UW-D, UW-L, UW-S, UW-A | 1 (UW-D: pre-start) | UNDERWATER §14 | render, the sea dressing pass, art + data + Meshy, sea life, server + shared, audio |
| UW-E | 2 | UNDERWATER UW-E | game client: interactables, sightings, the 45 m cull |
| HS-S, HS-W, HS-A, HS-B, HS-SND, HS-E | 1 (HS-A, HS-B: pre-start) | HOT_SPRINGS §14.2 | server, world-render part, SOAK, pavilion, sound, site authoring |
| HS-G, HS-Q | 2 | HOT_SPRINGS §14.2 | game feature + HUD, the optional quest |
| **I-13** | 3 | the four specs' integration rows | integration, re-converts, docs, the deploy list |
| **LAB-13** | 3 | FISHING §11.4, SWIMMING §13.4, UNDERWATER §9.2, HOT_SPRINGS §10.5 | one bench list, one method, one results file |
| **H-13** | 3 | the four specs' hunt lenses | one adversarial hunt with 20 lenses (§6.7) |
| **F-13** | 3 | — | fixers, one per file set |
| **G-13** | 3 | — | the final gate re-bench |
| **V-13** | 3 | — | the independent verify |

**Dropped or folded ids:** UW-0 (→ W13-WR, W13-PR, W13-CV); FS-M (→ UW-D builds every fish mesh, FS-C writes the
freshwater shape rows); the "LAB-HS" and "LAB-13 rows" of the specs (→ LAB-13); SW-C's editor half (→ SW-E); the
dive-zone bed rule of UW-C (→ SW-C, D11).

---

## 2. Conflicts and gaps across the specs, with decisions

### 2.1 Architecture and file ownership

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| D1 | When wave 13 starts building | all four (wave 12 edits `world-render`, `convert`, `nav`, `gm.ts`, `apps/game` settings) | Wave 12 is uncommitted in the tree [confirmed: `git status`, 73 paths] | **Step 0 starts from the wave-12 final commit (after G-12 and V-12)**, not from its deploy (which waits for the user's OK) [decision]; every seam agent re-reads its files there. **At once, before it, new files only** (the T12-A precedent): `packages/convert/tools/blender/{fishing, swim, springs, sea}/**` keyers and bpy scripts with their key files under `work/` until step 0 lands the content folders, the Meshy bake-off, the SDXL concept on the GPU queue (only while wave 12 holds no lock). Reason: no rebase of seams onto an uncommitted tree (WAVE_PLAN7 D1, WAVE_PLAN8 D1); the long Blender and Meshy items leave the critical path. |
| D2 | `packages/shared/src/{protocol, validate, content, quests, index}.ts` | FISHING §8.2, SWIMMING §11, UNDERWATER §6.5, HOT_SPRINGS §7.1 (S-STATS) | Four specs add requests, events, fail reasons, stats keys, fields, an entity kind and a quest field to the same files; HOT_SPRINGS F1: the optional-key parser bounds every key by `HWAN_MAX` 5 [confirmed: `validate.ts` 979, `PLAYER_STAT_OPTIONAL_KEYS = ['hwan']` at `protocol.ts` 1071] | **W13-PR lands every addition in one commit (§3.1)**, first the bound table `PLAYER_STAT_OPTIONAL_BOUNDS` with a test that sends `rest: 900`; afterwards only I-13 edits these files. SW-P, HS-P, FS-P and UW-S own their **own** shared files (`swim.ts`, `springs.ts`, `fishing/**`, `sea.ts`) and hand their wire rows to W13-PR. Reason: one agent for the wire; the bound table must exist before any key above 5 is sent. |
| D3 | Fail reasons | FISHING (`rod_level`, `bait_level`, ...), UNDERWATER (`level`, `cooldown`, `too_far`, `inventory_full`), SWIMMING (`swimming`, `too_shallow`) | Several names exist already [confirmed: `ACTION_FAIL_REASONS` holds `too_far`, `inventory_full`, `cooldown`, `requirements`, `mounted`, `trading`, `stalling`, `busy`] | **Reuse the existing names**: level gates (rod, bait, the sea claims' level 10) answer `requirements` with the specific `message` text; `cooldown`, `too_far`, `inventory_full`, `mounted`, `trading`, `stalling` as they are. **New**: `swimming`, `too_shallow`, `not_water`, `no_rod`, `fished_out` (a soft warning), `wrong_cast`, `not_cook_spot`, `missing_ingredient`, `recipe_unknown`, `not_diving`, `closed`, `claimed`, `need_key` (13). Reason: fewer wire names, the same meaning; `actionResult.message` already carries the text. |
| D4 | `apps/server/src/{gameplay, connection, db, gm}.ts` | FISHING (module, `/fish`, migration), SWIMMING (the evade rule in the hit path, the entry point in water, module registration after `movement`), UNDERWATER (`seaUse`, `/sea`, migration), HOT_SPRINGS (S-REWARD, S-REGEN, S-INPUT, `/rest`, migration) | Four lanes want the same four server files | **W13-SV lands every hook in step 0**: (1) `gameplay.ts`: one **kill-modifier list** (S-REWARD, D6), one **regen-factor list** (S-REGEN, D7), one **per-hit guard list** (SWIMMING SW-D23's evade check plugs in; default none = byte-identical), module registrations for `swim` (after `movement`), `fishing`, `cooking`, `springs` (after `posture`), `sea` as inert stubs; (2) `connection.ts`: `Player.lastInputAt` (S-INPUT: every client request except fishing's) and an `entryPoint` hook list (SWIMMING's water restore); (3) `db.ts`: all three migrations (D5) and the `CharacterRow` fields, a `saveProgress` extras hook; (4) `gm.ts`: `/fish`, `/rest`, `/sea` rows dispatching to the modules. Afterwards only I-13 edits them. Reason: one owner per spine file, WAVE_PLAN8 D6's pattern. |
| D5 | Migration numbers | HOT_SPRINGS (11), FISHING ("the next"), UNDERWATER (11 → 13 by fact-check) | Three claims; `db.ts` holds 10 [confirmed] | **11 = the `characters` columns** (`rest_exp`, `rest_day_start`, `rest_day_used`, `rest_soak_at` from HOT_SPRINGS §6.2 **and** `refresh_item`, `refresh_left_ms` from FISHING §8.6, since the refreshment slot is shared by the teas); **12 = `fishing` + `fishing_records`** (FISHING §8.6, `day_casts`); **13 = `sea_claims`** (UNDERWATER §6.5). All three verbatim from the specs, landed by W13-SV in step 0 [decision]. Tests step from 10 to `SCHEMA_VERSION`, no hard-coded number. Reason: the shared slot's columns go with the first table that needs them; one writer of `db.ts`. |
| D6 | The kill EXP order (S-REWARD) | FISHING D20, HOT_SPRINGS F6, UNDERWATER §6.3 (Tortoise's Calm) | Three bonuses on one kill | **`exp = e + round((meal + calm) × e) + rest(e)`**, `e` = the rated base (after `EXP_RATE`); `rest(e) = min(pool, bonusMul × e)` drains the pool on `e` only; SP-EXP: `sp = s + rest_sp(s)` (meal and calm are EXP only); quest EXP is never touched; `restEligible(mob)`, `mealEligible(p, mob)` predicates (default true). Written **once** in W13-SV's list; FS-K, HS-S, UW-S register their modifiers. The share pays `StatGain.rest` inside `exp`. Reason: one formula; dishes and blessings never drain the springs' pool faster. |
| D7 | Regeneration factors (S-REGEN) | HOT_SPRINGS (soak ×3), FISHING (dishes +20/+35 % out of combat) | Two multipliers | **Factors multiply** in the player regen pulse in `gameplay.ts` (≈ 1252–1255 [confirmed there by HOT_SPRINGS F6]): 3 × 1.35 = 4.05 at most; `REGEN` in `formulas.ts` stays a constant table. Reason: independent sources, no hidden priority. |
| D8 | `packages/world-render/src/world.ts` and the render spine | UNDERWATER UW-0 (`World.underwater`, `World.sea`, `bedOnly`), FISHING (`World.fishing`), HOT_SPRINGS (`World.springs`), SWIMMING (`setSwimmer`, read `waterSurfaceAt`) | Four slots and two calls in one file | **W13-WR writes all of them in one commit**: `World.underwater: Readonly<UnderwaterState> \| null` (with `surfaceY`, UNDERWATER F12), `World.sea`, `World.fishing`, `World.springs` (each `null` on Classic where its spec says so, disposed with the world, re-made by `setRenderMode`), `World.setSwimmer(state \| null)`, the `bedOnly` rule (`isVisible` follows `underwater`, never `setEnabled`); `HeightFog.suspended`; the new define sets registered in `material-budgets.test.ts` and the warm-up hooks. Afterwards only I-13. Reason: D2 of WAVE_PLAN8 again: one agent on the world object. |
| D9 | **The ocean and sky render files**: `ocean/ocean-plugin.ts`, `ocean/ocean-classic.ts`, `ocean/ocean.ts`, `pbr/water-plugin.ts`, `sky/{dome, classic-sky}.ts`, the far plane and shadow distance under water | UNDERWATER UW-R (the under branch, Snell's window, the dome's under colour), SWIMMING (the swimmer floats on `waveHeightAt`; no fog code since F4), FISHING (floats on `waveHeightAt`) | Three specs read the ocean; one writes it | **UW-R is the one owner from step 1**; SWIMMING and FISHING only **call** `waveHeightAt` / `waterLevelAt` (unchanged APIs). The under branch keeps the above-water output byte-identical (a test renders both) and writes alpha 1 from below (UNDERWATER R4). COAST's CST-K is superseded (UNDERWATER D-U4). Reason: one owner per shared module (the task's rule); swimming draws nothing under water (SWIMMING §9.3). |
| D10 | `water.ts`, `pbr/water-town-plugin.ts`, `town/fx.ts` | HOT_SPRINGS S-WATER (springs surfaces, the `springs` profile) and S-PUFF (`springSteam`), wave 11's town FX (`setRipplePoints` every frame at any distance [confirmed there: HOT_SPRINGS F15]), wave 12's water block update (W12-SB) | A second ripple writer is overwritten; a null profile or a 0 ↔ some count flips a define and recompiles | **W13-WR lands S-WATER and S-PUFF in step 0** on top of wave 12's `updateRegion`: `addSurface/removeSurface`, `WATER_PROFILES += 'springs'`, **per-source** ripple lists and profiles merged by the renderer (the town's FX becomes source `town`), never null, both defines on and warmed at load; `puffAt` with an extensible kind table and the unlit `springSteam` material skeleton. HS-W then owns `packages/world-render/src/springs/**` only. Reason: the F15 trap is closed in the seam, by one agent. |
| D11 | **The coast converter files**: `packages/convert/src/world/coast/**` (`navgen.ts`, `source.ts`, the emission rule) | SWIMMING SW-C (`NAV_KNEE_DEEP_M` 0.4 → `SWIM_DEPTH_M` 1.2 [confirmed there: `navgen.ts` 24, `source.ts` 143]), UNDERWATER UW-C (emit every region within 64 m of a dive zone as `bedOnly`) | Two lanes in one pass | **SW-C owns `world/coast/**`** in step 1 and writes both changes; the bed-region rule is UNDERWATER §3.1's, reading SW-C's swim **domain** function (which exists before terrain emission, SWIMMING §2.2). UW-C owns `world/sea.ts` only. Reason: one owner of the coast pass; the domain and the bed rule live together. |
| D12 | The converter spine | FISHING (S-DECK nav append, the fishing grid after the edits pass, the authored-data merge), SWIMMING (the swim build after the nav step and the coast), UNDERWATER (the sea dressing after the town dressing), HOT_SPRINGS (`springs.json` copy, `manifest.springs`, the pavilion as a model, `places`) | Four users of `convert-world.ts`, `passes.ts`, `manifest.ts`, `cli.ts` | **W13-CV writes every hook and type in step 0**, each calling a stub, in this order [decision]: nav step (+ the **S-DECK append hook**: decks and the jetty edge patch into `nav.bin`, `nav-objects.bin`, the chunks) → coast pass (C9) → **swim build** (`swim.bin`, `manifest.swim`) → town dressing → **sea dressing** → cloth → static variants → grass palettes → world edits (6) → tree swap (7) → **springs copy + validate** (8) → **fishing water grid** (9, needs the editor's water and the springs' surfaces). The swim build reads the editor's water layer, the decks' piles and the sea rows' `solid` boxes **from content** (no cycle); W13-CV confirms the step against WORLD_EDITOR §6.3 at the wave-12 commit [likely]. Afterwards **FS-D owns `world/decks.ts`**, **SW-C `world/swim/**`**, **UW-C `world/sea.ts`**, **HS-E's script writes `content/springs/*.json`** (the copy pass is W13-CV's stub, finished by I-13), **FS-W `world/fishing-water.ts`**; nobody edits `convert-world.ts` after step 0 (I-13 only). Reason: WAVE_PLAN8 D6. |
| D13 | Authored uid ranges (`world/uids.ts`, wave 12's S-UID) | FISHING (decks: 16-bit, not the editor's 0xE000–0xEFFF, which throws), UNDERWATER (sea props by row) | Two new sources | **`content` = 0xF000–0xF0FF** (carved from the coast's reserved, unused 0xF000–0xFFFF [confirmed: `uids.ts` header]) for authored nav decks; **`sea` = 3,000,000–3,999,999** by row (no nav instance, so no 16-bit need) [decision]; W13-CV adds both with the disjointness test. Reason: a nav instance id is `regionId << 16 \| uid`; the editor's range must stay the user's. |
| D14 | **The server movement and nav** | SWIMMING (the walker's tile mask in `packages/nav/src/{world, reach}.ts`, the swim walker, the leg chain in `apps/server/src/world.ts`, `nav.ts` water surface, `ai.ts` acquisition, `mounts.ts` edge stop, the clamp), FISHING (S-DECK nav append, the `jump` request ends fishing), the jump module | The nav package is wave 12's (S-NAV `editInstances`) until its commit | **SW-P owns `packages/nav/**` in step 0** (the mask hook lands after wave 12's final commit, D1); **SW-S owns `apps/server/src/{world.ts (walkEntity, arrive, clamp), nav.ts, ai.ts, mounts.ts}` from step 1**; the jump module `movement.ts` is **not touched** (Space sends `dive` or the line on the client; the server's `jump` gate refuses while swimming through the swim module's gate, and ends fishing through the fishing module's). The nav **converter** side of S-DECK is FS-D's via W13-CV's hook. Reason: one owner for walking, one for the nav file format. |
| D15 | **The moves pipeline** (`export-moves.ts`, the `sro moves` CLI, the keyers) | FISHING (`fishing` pack, `key_fish.py`, `fish-clips.ts`), SWIMMING (separate `swim.glb`, `key_swim.py`, `swim-clips.ts`; it only **calls** `export-moves.ts`), HOT_SPRINGS (the SOAK kind **in** the player movement pack) | HOT_SPRINGS expected `SWIM_*` kinds in `export-moves.ts`; SWIMMING adds none (SWIMMING §12.3) | **W13-CV adds in step 0** the SOAK (and optional SOAK_LEAN) kind to `export-moves.ts` and the `--swim` / `--fishing` flags to `cli.ts` on stub tools; afterwards `export-moves.ts` is frozen (I-13 only). **Three packs**: `movement.glb` gains SOAK only (MV-A's checks); `swim.glb` (SW-A's `swim-clips.ts`); `fishing.glb` (FS-A's `fish-clips.ts`). The keyers `tools/blender/town/key_town.py` and `moves/key_moves.py` are read-only; each lane subclasses them in its own folder. W13-G adds one client loader for extra packs (`loadMovesPack(skel, kind)`). Reason: one owner of the pack format; three lanes key in parallel without touching it. |
| D16 | **The World Editor's water rule** | SWIMMING §2.5 (D30 → "swimmable, not walkable"; the incremental convert calls the same builder; three Publish rows; the Water panel's live tint and "No swimming here" toggle), WORLD_EDITOR D30/D40 (wave 12's files: `packages/shared/src/world-edits/nav-rule.ts` W12-P, `world/edits/{nav-edit, checks}.ts` WE-N, `tools/convert-region.ts` WE-I, `apps/viewer/src/editor/**` WE-U) | Wave 12's lanes own those files until its commit | **One lane, SW-E, owns the editor's water rule in wave 13**: the D30 branch in `nav-rule.ts` (unchanged closing for walking), the three Publish rows in `checks.ts` (a way out, swim reachability, nests > 25 % swim water), `convert-region.ts` calling SW-C's builder for touched regions + neighbours, the Water panel's tint and toggle (writing `noSwim` rows through the editor API). Lands after the wave-12 commit. Reason: one owner of the rule the user's editor and the converter must agree on. |
| D17 | **Items, shops, NPC defs, buffs and skills** | FISHING (S-ITEMS, S-SHOP, S-BUFF; Ahn, Mei; `ItemDef` additions), HOT_SPRINGS (teas, scrolls, Yunhua; agrees FS-I owns S-ITEMS/S-SHOP and FS-K S-BUFF), UNDERWATER (`ITEM_ETC_SEA_*`, the necklace, five `NPC_SEA_*` `NpcDef` rows) | Three content files, one merge, three NPC writers | **FS-I owns the merge**: `packages/convert/src/data/authored.ts` merges `content/items/*.json`, `content/shops/*.json` **and `content/npcs/*.json` (authored `NpcDef` rows, the same rule)** into `work/out/data/{items, shops, npcs}.json`; a retail-code collision, a missing icon, a sell above buy are errors. Each feature file has one writer: `items/fishing.json` + `shops/fishing.json` FS-I, `items/springs.json` + `shops/springs.json` HS-E, `items/sea.json` + `npcs/sea.json` UW-S. **NPC placements** (`content/npcs.override.json`): **FS-C is the single writer** for Ahn, Mei and Yunhua (HS-E hands its row). **S-BUFF**: FS-K owns `apps/server/src/refreshment.ts` (the slot, the mod provider through the existing `SkillEngine.addModProvider`); the teas call it. **No skill file is edited**: `swimMul`, `breathMul` are player fields (S-STATS), the rest are existing mods [confirmed there: FISHING §1]. Reason: one owner per file and per merge. |
| D18 | Water queries (S-WATERQ) and the two water files | SWIMMING (`waterAt()` in `packages/nav/src/swim.ts` from `swim.bin`), FISHING (`fishing/water.bin`, 4-bit body + 4-bit depth), HOT_SPRINGS (the springs answer `springs` first, never swim or fish) | FISHING allowed WAVE_PLAN9 to merge the files | **Two files** [decision]: `swim.bin` (2-bit classes, per-block surfaces, `noExit`, eager at world load, ≈ 15 KB) and `fishing/water.bin` (body + depth, lazy at the first rod, ≈ 40 KB); one query order everywhere: **springs → swim layer → fishing body**. Reason: different consumers and load times; merging saves nothing (FISHING §8.5: "the bytes are the same either way"). |
| D19 | The species list and the fish meshes | FISHING D35 (sea ids from UNDERWATER), UNDERWATER D-U21 (S-FISHMESH), FISHING's FS-M | One id list, two files, one generator | **`content/sea/species.json`** (UW-D: ids, shapes, palettes of the sea fish) and **`content/fishing/species.json`** (FS-C: catch rows keyed by those ids; the freshwater rows with their shape rows); **UW-D owns the one generator** and builds all 19 species + 5 extras (≤ 400 triangles, the catch-display glbs and the school mesh); FS-M is folded. **Display names are FISHING's** (e.g. "Sea Bream" for the golden-line bream). Reason: "the fish you catch are the fish you see"; one look, one tool. |
| D20 | The S1 trail nests | HOT_SPRINGS F3 (40 m), FISHING §2.3 (25 m) | 25 m leaves the trail inside the 80 m leash gate [confirmed there: `ai.ts` 154–160] | **40 m north**, two `patch` rows in the repo's `content/nests.override.json`, owned by **HS-E**; FISHING depends on it. The route test (no route point within 85 m of an aggressive home) runs at every checkpoint. Reason: the measured gate. |
| D21 | The pier's piles and ladders | FISHING D38 (FS-D writes them), SWIMMING §5.5 (`exits` in `content/swim/swim.json`, cut 1) | Two files could hold the ladders | **The ladders live in `content/fishing/piers.json`** (FS-D) and the piles in the deck model's solids; **SW-C's builder reads them**; `content/swim/swim.json` keeps `noSwim`, `forceSwim`, `openShore`, `waterborne` (SW-C, and SW-E's toggle through the editor) [decision]. Reason: one writer per file; the pier owns its own ladders. |
| D22 | Divers over solid sea props (S-FLOOR) | UNDERWATER F6, SWIMMING §5.2 | The dive line follows the terrain bed only | **UW-D writes `solid: {w, d, topM}` on the wreck and shrine rows; SW-C's builder raises `swim.bin`'s bed to `topM` inside the box**; the client camera's ground rule under water reads the same raised bed (SW-G). |
| D23 | Space and keys | FISHING D29 (Space is the line in stance), SWIMMING (Space dives while swimming), MOVEMENT (Space jumps) | Three meanings | **Three `when` bindings on Space, registered after `movement.jump`** (the KeyMap takes the latest matching binding [confirmed: `hud/keys.ts` 146–159]): `inStance` → the line, `swimming` → dive/surface, else the jump. Fishing is refused while swimming, so the two never overlap. The journal is **J** [confirmed free there: FISHING §9.2]. Reason: no file of the jump changes. |
| D24 | The camera and the actors under water | SWIMMING SW-G (`world/jangan/camera.ts`, the beta limit and water picking in `screens/world.ts`), UNDERWATER (the 90 m far plane and 40 m shadows in `World.update`; the 45 m actor cull in `world/crowd-budget.ts`) | `screens/world.ts` sets `maxZ = 2000` [confirmed there: UNDERWATER lanes note] | **SW-G owns `camera.ts` and the camera/picking code of `screens/world.ts`**; **UW-R applies the far plane and shadow distance in `World.update`** (restored on surfacing, never through `screens/world.ts`); **UW-E owns the one 45 m rule in `crowd-budget.ts`**. Swimmers below the surface cast no shadow (SW-G). |
| D25 | Audio | UNDERWATER UW-A (`setWorldFilter` on the sfx and ambient buses), FISHING FS-SND (cue rows, `fishing-synth.ts`, the export scope: `firework/campfire.wav`, `env/dd_bobble_01/02`), HOT_SPRINGS HS-SND (`springs/bubble`, the area row), SWIMMING (strokes on the retail water steps) | One cue table, one backend | **W13-CV adds every cue row and the scope additions in step 0**; **UW-A owns `audio/backend.ts`** (the world filter; the `ui` bus bypasses it); each lane owns its synth file and its `audio/<feature>.ts`. |
| D26 | `apps/game` shared files | FISHING ("Easy fishing timing" in Options → Interface, `features/fishing.ts`, `en-fishing.ts`), HOT_SPRINGS (`features/springs.ts`, the bubble hook in `ux-world.ts`, the mock server), UNDERWATER (`features/sea.ts`), SWIMMING (strings, the pack loader in `three/models.ts`) | Shared normaliser, registry, loader | **W13-G adds in step 0**: the setting (normalised, default off), its Options row and strings, the four feature stubs registered in `world/features.ts`, the four i18n files (`en-fishing`, `en-springs`, `en-swim`, `en-sea`) registered, `loadMovesPack`, the bubble-rule hook, the mock server's wave-13 fields. Afterwards each lane owns its own files only (WAVE_PLAN8 D9's rule). |
| D27 | The springs on the map and WAVE_PLAN8 D37 ("the first real map edit is the user's") | HOT_SPRINGS HS5, HS30 (after wave 12's release and the user's first edits) | Waiting for the user's own first edit could block the wave indefinitely | **HS-E authors the two regions (172,90 and 173,90) on the staging export `jangan-fields-edit` and Publishes only there; I-13 merges those two regions' layer files into `content/world-edits/jangan-fields/` at X1** [decision]. If the user has edited either region by then, HS-E rebases onto the user's layers (per-region layers merge; the user's edits win where they overlap) and the lead tells the user. Nothing outside those two regions is touched. Reason: the user's map stays theirs; the springs need real basins, nav and shadows (HS5). |
| D28 | Clips on both skeletons | FISHING (9 clips × 2), SWIMMING (5 × 2, + DIVE optional), HOT_SPRINGS (SOAK × 2) | 30 clips of art direction | All keyed **headless in Blender 5.2** (bmesh only, no sculpt operators) by the three lanes' keyers in **pre-start and step 1**, each clip with its numeric checks (FISHING §11.3, SWIMMING §4.4, HOT_SPRINGS HS-A) and one GIF page per skeleton for the user. The female skeleton is keyed and checked, not assumed (SWIMMING §4.3, FISHING R4). |
| D29 | Swimming on Low and underwater on Low | SWIMMING §13.1 (the Classic path on either backend), UNDERWATER D-U8 (fog swap, two-tone surface, no life) | — | As the specs: Low swims, floats on the Gerstner query, keeps the band rule; under water Low swaps the Classic fog and hides the dome; no sea life, plants or particles; above water Low is byte-identical (the Low guard). |
| D30 | The new frame-time rules | FISHING (no per-frame allocation, rods without shadows), UNDERWATER F8 (upload on change), HOT_SPRINGS (unlit steam) | The wave-11 G1 remainder is GC spikes [confirmed: `wave11/budgets.md` rescue section] | **Every new per-frame path allocates nothing** (a 600-frame heap check in FS-R, UW-L, SW-G, HS-W tests), **every instance buffer uploads only when it changes** (the boids are the measured exception, double-buffered if they stall), **no new shadow caster** except batched placements (the wreck, rocks, the shrine, the pier, the pavilion). |

### 2.2 State ownership (one source of truth each)

| State or module | Produced by | Consumed by | Owner lane |
|---|---|---|---|
| `SWIM_DEPTH_M` 1.2, `DIVE_MIN_DEPTH_M` 2.5, `DIVE_MAX_M` 15, `SWIM_STEP_M` 0.6, `SWIM_EYE_BAND_M` 0.35, `SWIM_OUT_M` 150, `SWIM_MIN_BODY_M2` 300 | `packages/shared/src/swim.ts` | the converter, the coast navgen, the editor's nav rule, the server, the client, UNDERWATER | **SW-P** |
| The swim layer (`swim.bin`: classes, surfaces, `noExit`) | SW-C's builder (full convert, coast pass, the editor's incremental convert) | the server walker, the client prediction, FISHING's cast check, UNDERWATER | **SW-C** (data), **SW-P** (format, decode) |
| The swim domain (rectangle + 150 m of connected sea ∪ the dive zones) | SW-C's domain function | the swim build, UNDERWATER's bed-region rule | **SW-C** |
| A swimmer's state `p.swim = {mode, diveAt, breathUntil}`, `swimDepthM(p, now)` | `apps/server/src/swim.ts` | fishing's gate, `seaUse`, the client (`EntityState.swim`, `diveAt`) | **SW-S** |
| Dive zones (S-ZONES), sea dressing rows, `solid` boxes, interactables | `content/sea/jangan-sea.json` | SW-C's builder, UW-C's pass, the server, the client | **UW-D** (data), **UW-S** (`validateSeaFile`) |
| Sea events (clams, sightings, the tortoise's path and window) | `seaEventsAt(serverMs, clock, weather)` in `packages/shared/src/sea.ts`; `seaHold` for GM windows | the server (`seaUse`, fishing's ×2), every client | **UW-S** |
| `World.underwater` (eye vs surface + wave, `surfaceY`, the 0.25 s blend) | `world-render/src/underwater/state.ts` | the plugin, the sea life, the audio filter, SWIMMING's band check | **UW-R** |
| The species ids | `content/sea/species.json` | `content/fishing/species.json`, `World.sea`, the catch display | **UW-D**; catch rows **FS-C** |
| The fishing water grid (body + depth) | `world/fishing-water.ts` → `fishing/water.bin` | the server's cast check, the client's cursor | **FS-W** |
| The catch roll, the bite schedule, the fight seed, the replay | `packages/shared/src/fishing/{roll, sim}.ts` | the server (authoritative), the client (plays) | **FS-P** |
| Fishing XP, level, records, letters, day casts, pity | migration 12 tables | the journal, the roll | **FS-S** |
| The refreshment slot (one dish or tea, online time, kept through death) | `apps/server/src/refreshment.ts`, migration 11 `refresh_*` | cooking, the teas, the buff bar | **FS-K** |
| The Rested pool, the day budget, the overnight credit | `apps/server/src/springs.ts` + `packages/shared/src/springs.ts`, migration 11 `rest_*` | S-REWARD, the HUD segment | **HS-S** (server), **HS-P** (rules) |
| The springs site (zone, pools, profile, steam, knobs) | `content/springs/jade-mist.json` → `springs.json` in the export | the server, the client, the converter | **HS-E** |
| The kill-modifier list, the regen-factor list, the per-hit guard list | `gameplay.ts` | FS-K (meal), UW-S (calm), HS-S (rest, soak), SW-S (evade) | **W13-SV** |
| Authored items, shops, NPC defs | `content/{items, shops, npcs}/*.json` → `work/out/data/*.json` | the server, the client | **FS-I** (merge), each feature's lane (rows) |
| NPC placements (Ahn, Mei, Yunhua) | `content/npcs.override.json` | the server | **FS-C** |
| The S1 trail nests patch | `content/nests.override.json` | the server | **HS-E** |
| Authored decks, the jetty edge patch, the pier's ladders | `content/fishing/piers.json` + the pier model | the nav append, SW-C's builder | **FS-D** |
| `lastInputAt` (S-INPUT) | `connection.ts` | the springs' idle rule, fishing's idle rule | **W13-SV** |

### 2.3 Cross-item behaviour

| # | Topic | Problem | Decision |
|---|---|---|---|
| D31 | Meshy | §0.3 | **Cap 400, planned 40 (J1 + J2 for the Jade Tortoise, pre-start), contingencies 60 (pavilion) + 30 (one J1 retry), logged per job**; the pick is the user's on one sheet, default J1 if it passes the painterly rule (≤ 3k triangles, ≤ 1.5 MB, no photoreal skin), else the bpy turtle with a tuned palette. |
| D32 | Fishing near swimmers and divers | A line in swim water | Allowed: lines are client visuals; the cast's target is water of a fishing body; a swimmer is not a target and is not hooked. The Jade Tortoise doubles rare fish within 80 m of its path (FISHING D36). |
| D33 | Swimming in the springs | Pools ≤ 1.0 m are wade water | **No swimming, no fishing, no diving in the springs** (HS8); the springs' surfaces are not in `swim.bin`; S-WATERQ answers `springs` first. The camera never dips (the band rule needs swim or wade deeper than 0.6 m; soakers sit in ≤ 1.0 m). |
| D34 | Fresh-water diving | SWIMMING allows dives wherever ≥ 2.5 m (the lake, the rivers); UNDERWATER's content is at S1 | Allowed; `World.underwater` uses `surfaceY` (F12) and draws absorption, the surface from below and caustics in fresh water; no bed regions or life outside the S1 zone this wave (UNDERWATER D-U32). |
| D35 | Town ponds | SWIMMING Q4 (the palace pond 608 m² swimmable), FISHING D1/D34 (closed to fishing by body) | **Swimmable, not fishable** (both specs' defaults); the editor's "No swimming here" toggle can turn it off. |
| D36 | The meal, the teas and death | FISHING Q3, HOT_SPRINGS | The refreshment is **kept through death and logout, its timer paused offline**; the Rested pool is never lost on death (wave 14's death penalty takes EXP from the bar, not from the pool, §11). |
| D37 | The pier at S1 and the dive zone | The pier (x ≈ 470, z 1274–1336, 1.6 m at its end) lies inside the zone's rectangle | Nobody dives at the pier (< 2.5 m); its pile dressing (UNDERWATER §3.3) is drawn above water as well; the pier's ladders let swimmers out (SWIMMING §5.5). |
| D38 | The campfire entity | FISHING Q10: a new `EntityState.kind` | **Yes: `EntityKind` gains `'fire'`** (W13-PR) [confirmed: `ENTITY_KINDS` holds player, mob, npc, item, cos today]; cut 1 if costly. |
| D39 | The tomb moat before wave 14 | FISHING Q8 | **Open** (the eel, the offering box and its shard are content; wave 14 builds on them). |
| D40 | Shader warm-up | The underwater plugin on every PBR material, the ocean's under branch, the springs' steam and water profile, the fishing materials, the sea life | Every new effect compiles at world load through `warmup-hooks.ts`: no compile on the first cast, the first surface crossing, the first view of the pools, a login at the springs or under water (H-13 lens 13). UNDERWATER R3 (longer compiles) is measured by LAB-13's warm-up row. |

### 2.4 Data, content, tools and delivery

| # | Topic | Decision |
|---|---|---|
| D41 | Re-converts | Two lead checkpoints, under the convert lock, when no lane writes `work/out/`: **X1** after step 1 (SW-C's swim build + the coast at 1.2 m + the bed regions, FS-D's decks, UW-C's sea dressing, HS-E's springs layers merged by I-13 + `springs.json`, FS-W's grid, the three packs, FS-I's merge, the sound build): `pnpm sro convert` (world) + `sro moves --swim`, `--fishing` + the movement pack + `optimize-out run --only world/,char/_anims/,data/,sound/` [flag confirmed: WAVE_PLAN8 D26]. **X2** after step 2: a full re-convert and full optimize (a fresh baseline). Checks at each: with the four content folders empty, the export equals wave 12's for every untouched file (a G7-style byte compare); S1's nav chunks open every sea tile ≤ 1.2 m; the closed-shore report lists SWIMMING §3.3's components 1, 2, 5, 6; 5 `bedOnly` regions at S1; uids inside their ranges; the springs route test; `swim.bin` incremental = full for a touched region. A third run, X3, only for F-13 fixes that change the export. |
| D42 | The GPU queue | WAVE_PLAN8 D27's lock and rule (mkdir must succeed before anything runs; owner "label time"; only the creator removes it; never a chained `mkdir ...; ...; rm -r`). Priority: bench timings (LAB-13, G-13, V-13) > the SDXL concept and short renders (EEVEE GIF frames, icon renders) > in-game review shots > anything else. Blender keying, bmesh and Cycles CPU need no lock. §6.1 is the schedule. While wave 12 still builds, a wave-13 item waits behind any wave-12 holder. |
| D43 | Downloads and uploads | **None**, except the Meshy results through `MeshyClient` (D31). Blender 5.2, the local SDXL checkpoint (`work/tools/comfyui/.../sd_xl_base_1.0.safetensors` [confirmed there: UNDERWATER F]), Python and the retail sounds are on the machine. Uploads: the SDXL concept and the bpy turtle to Meshy (J1, J2 only). |
| D44 | **The deploy of wave 13** | **A new OK from the user is required** [decision]: the 22:54 rule covered waves 10 + 11; "make all decisions" is not a deploy OK; wave 12's own OK is separate. After the OK: a **named DB backup first** (three migrations, schema 10 → 13), then one `pnpm run deploy` (code + assets, server and client together), a health check (schema 13, `swim.bin` and `springs.json` loaded, nav regions, nests), the "reload the page" note. Wave 13 deploys after wave 12 (its base) or together with it, never before. |
| D45 | Stale clients after the deploy | Additive wire and manifest: an old client ignores `MoveState.mode/next` (draws a walker on the bed for one move), the stats keys (once the bound table is on the client) and the new files; the deploy restarts the server and forces a reconnect (SWIMMING §2.6). |
| D46 | Scratch and docs | I-13 updates docs (§6.6) and deletes the specs' large scratch only after the owning lane ports its method (the shots the user reviewed are kept). |

### 2.5 Numbers and config (consolidated)

| What | Value | Source |
|---|---|---|
| Wade / swim / dive | wade ≤ 1.2 m; swim > 1.2 m in a body ≥ 300 m² with a way out, the sea, editor water; dive ≥ 2.5 m to `max(bed + 0.9, surface − 15)` | SWIMMING SW-D1, D2, D17 |
| Swim domain | the rectangle + 150 m of connected sea (0.51 km²) ∪ the S1 dive zone x 400–960, z 1290–1560 | SWIMMING SW-D8, UNDERWATER S-ZONES |
| Speeds, breath | swim 0.6 × run (3.3 m/s), dive 0.8 × swim, crawl when the swim bonus ≥ 1.1; breath 30 s (×`breathMul`), refill ×3, 4 s cooldown; no drowning | SWIMMING §5.4, §6 |
| Exits | wade or a bank ≤ 0.6 m, onto a component the town reaches today; `openShore` rows open one | SWIMMING SW-D24, D25 |
| Fishing | cast 4–16 m to water ≥ 1.0 m; strike window 0.80 s (1.2 s Easy); daily soft cap 400 casts; personal fatigue 60 catches / 60 min; idle 40 min; fishing level 1–10; no character EXP | FISHING §2.1, §4, §8.4 |
| Legendary | Golden Grain groundbait, fishing 7, river or ferry; 1/240,000 a cast, ×2 after 200, ×9 at twilight in rain | FISHING D12 |
| Rusty Bronze Key | sea, bay, ferry 1 in 200 catches; river 1 in 400; none after the daily cap | FISHING D36 |
| Cooking | 12 dishes + Golden Grain; 2.5 s per dish, batches of 10; one slot; buffs: out-of-combat regen +20/+35 %, move +5 %, kill EXP +5/+10 %, resist +10/+20 %, max HP/MP +2–3 %, defence +3 %, swim +10 %, breath +30 % | FISHING §7 |
| Rested | cap 20 % of the level's EXP-to-next; +50 % kill EXP and SP-EXP; 15 min soak (+25 %/friend, max +50 %); overnight 8 h; idle 10 min → overnight rate; one fill per 20 h | HOT_SPRINGS HS16–HS18 |
| Teas | three, 300 gold, small 30-min buffs, doubled while soaking, no EXP effect, sell-back ≤ 30 % | HOT_SPRINGS §4.5 |
| Sea claims | coffer once a day (300–800 × `GOLD_RATE`), clams once per clam per day (40 s open every 4 min), level 10; kelp/urchin 2 gold, 30 picks a day | UNDERWATER §6 |
| Tortoise | 2–3 windows a real day, 4 min; rare fish ×2 within 80 m; Calm +10 % EXP for 15 min | UNDERWATER §6.3 |
| Kill EXP | `e + round((meal + calm) × e) + rest(e)` | D6 |
| Migrations | 11 `characters` columns, 12 fishing tables, 13 `sea_claims` | D5 |
| uids | `content` 0xF000–0xF0FF (decks), `sea` 3,000,000–3,999,999 | D13 |
| Meshy | cap 400, planned 40, contingencies 60 + 30, reserve ≥ 200 (balance 1,840) | D31 |

---

## 3. Formats and content (additive)

### 3.1 Wire (`packages/shared/src/protocol.ts`, `validate.ts`; W13-PR; protocol v1, additive)

```ts
// Requests (each answers one actionResult; CLIENT_RATE_LIMITS rows from the specs)
{ t: 'fishCast'; x: number; z: number; bait?: string }        // 1/s burst 2
{ t: 'fishStrike'; castId: number; step: number }              // 2/s
{ t: 'fishReport'; castId: number; steps: number; toggles: number[] }   // <= 512 sorted; 1 per cast
{ t: 'fishStop' }  { t: 'cookCancel' }                          // 4/s
{ t: 'cook'; recipe: string; count: number; spot?: string }    // 2/s, count 1..10
{ t: 'fishJournal' }                                           // 1 per 2 s
{ t: 'dive' }                                                  // toggle; 2/s burst 3
{ t: 'seaUse'; id: number }                                    // like pickup
// Server -> client
fishCast {castId, at, bite, nibbles}   fishHook {castId, fight}   fishDone {...}   fishing {id, s, at, fish?, kg?}
fishJournal {...}   cookDone {recipe, made}   seaHold {kind, startAt}   (GM windows only)
// Fields
MoveState.mode?: 'swim' | 'dive'; MoveState.next?: MoveState (<= 2 levels, startedAt chained)
EntityState.swim?: 'surface' | 'dive'; EntityState.diveAt?: number; entityUpdate swim?, diveAt?
EntityKind += 'fire'                                          // the Campfire Kit (3-minute life)
EffectState.item?: string                                     // the refreshment's item for the buff bar
PlayerStats: rest?, restToday?, swimMul?, breathMul?, fishingLevel?, fishingXp?
PLAYER_STAT_OPTIONAL_BOUNDS = { hwan: [0, HWAN_MAX], rest: [0, 2**31-1], restToday: [0, 10000],
                                swimMul: [0, 4] (x1000 int), breathMul: [0, 4] (x1000 int), fishingLevel: [1, 10],
                                fishingXp: [0, 2**31-1] }
StatGain.rest?: number (<= exp)
ActionFailReason += swimming, too_shallow, not_water, no_rod, fished_out, wrong_cast, not_cook_spot,
                    missing_ingredient, recipe_unknown, not_diving, closed, claimed, need_key        // D3
```

- **The bound table lands first** with a test that parses `rest: 900` and rejects `fishingLevel: 11`; the loop at
  `validate.ts` 979 reads it. `swimMul` and `breathMul` travel as integer thousandths [decision: the optional-key
  parser is integer-only today].
- `packages/shared/src/content.ts`: `ItemDef.category += 'fish' | 'food' | 'ingredient' | 'tool'`, `use.meal?`,
  `use.campfire?`, `tool?`, `bait?`, `fish?` (FISHING §3.1); authored `NpcDef` rows accepted with `provenance:
  'authored'`. `packages/shared/src/quests.ts`: `requires.fishing?: number`, `reach.swim?: true`, the location
  `LOC_SEA_SHRINE`.
- **Name check** [confirmed: grep of `protocol.ts` at HEAD]: no `dive`, `swim`, `mode`, `fish*`, `cook*`, `sea*`,
  `rest` name exists; W13-PR re-greps at the wave-12 commit.
- docs/PROTOCOL.md gains "Fishing and cooking", "Swimming", "The sea", "Rested" subsections (W13-PR).

### 3.2 Migrations (`apps/server/src/db.ts`; W13-SV; D5)

```sql
-- 11: wave 13 character columns (docs/HOT_SPRINGS.md §6.2, docs/FISHING.md §8.6)
ALTER TABLE characters ADD COLUMN rest_exp INTEGER NOT NULL DEFAULT 0 CHECK (rest_exp >= 0);
ALTER TABLE characters ADD COLUMN rest_day_start INTEGER NOT NULL DEFAULT 0;
ALTER TABLE characters ADD COLUMN rest_day_used INTEGER NOT NULL DEFAULT 0 CHECK (rest_day_used BETWEEN 0 AND 10000);
ALTER TABLE characters ADD COLUMN rest_soak_at INTEGER;
ALTER TABLE characters ADD COLUMN refresh_item TEXT;
ALTER TABLE characters ADD COLUMN refresh_left_ms INTEGER;
-- 12: fishing (docs/FISHING.md §8.6, verbatim): fishing, fishing_records, fishing_records_top
-- 13: sea claims (docs/UNDERWATER.md §6.5): sea_claims(char_id, key, day)
```

Old rows read as an empty pool, a fresh day, no refreshment, no fishing row. The migration test steps a schema-10 DB
(a temp copy of `work/server/game.db`) to 13. **Back up the DB before the deploy** (D44).

### 3.3 World export and manifest (`packages/convert/src/world/manifest.ts`; W13-CV)

```ts
manifest.swim?:    { file: 'swim.bin'; version: 1; swimDepthM: 1.2; outM: 150; sourceHash: string }   // SWIMMING §2.3
manifest.springs?: string                        // 'springs.json' (HOT_SPRINGS §7.4)
manifest.fishing?: { water: 'fishing/water.bin'; version: 1 }                                         // FISHING §8.5
region entry:      bedOnly?: true                 // UNDERWATER §3.1: drawn only under water, no navmesh
manifest.places:   += 'jade-mist-springs'
// new models appended to manifest.models: the S1 pier deck, the pavilion, the sea props' scaled copies (no collision)
```

Files: `swim.bin` (≈ 15 KB brotli), `fishing/water.bin` (≈ 40 KB), `springs.json` (5 KB), five `bedOnly` regions
(≈ 0.25 MB), `char/_anims/<skel>/{swim, fishing}.glb` + their indexes, the SOAK clip inside `movement.glb`, the sea
and fishing models, sounds. Old exports validate (every field optional).

### 3.4 Content

| Path | Owner | Validator |
|---|---|---|
| `content/fishing/{species, bodies, rules, recipes, letters, cook-spots}.json`, `content/quests/fishing.json` | FS-C | FS-P's validators, the QUESTS checker |
| `content/fishing/piers.json` (decks, the jetty edge patch, ladders) | FS-D | `decks.ts` |
| `content/items/fishing.json`, `content/shops/fishing.json`, `content/items/icons/**` | FS-I | `data/authored.ts` |
| `content/items/springs.json`, `content/shops/springs.json`, `content/springs/jade-mist.json`, `content/nests.override.json` (two patch rows) | HS-E | `validateSprings`, `data/authored.ts`, the nests override loader |
| `content/items/sea.json`, `content/npcs/sea.json` | UW-S | `data/authored.ts` |
| `content/sea/{jangan-sea, underwater, events, species}.json` | UW-D (UW-S validates) | `validateSeaFile` |
| `content/swim/swim.json` (`noSwim`, `forceSwim`, `openShore`, `waterborne`) | SW-C (SW-E's toggle writes `noSwim` through the editor API) | SW-P's validator |
| `content/moves/<skel>/{fishing/*, swim/*, soak}.json` | FS-A, SW-A, HS-A | the pack checks |
| `content/npcs.override.json` (Ahn, Mei, Yunhua) | FS-C | the NPC override loader |
| `content/world-edits/jangan-fields/` regions 172,90 and 173,90 | HS-E (staging), I-13 (merge, D27) | W12-P's validators, Publish checks |
| `content/quests/jangan.json` JG_S01 (optional) | HS-Q | the QUESTS checker |

### 3.5 Settings, scripts, deploy

- `ui.fishingEasyTiming: boolean` (Options → Interface → "Easy fishing timing", default off, FISHING Q13) (W13-G).
- No new root script: the moves flags go through `pnpm sro moves --swim | --fishing`.
- Server config: no new key; every knob is content (FISHING §10.4, HOT_SPRINGS §7.2).
- Deploy: D44.

---

## 4. Seams (step 0; seven agents; every edit additive; the Low guard stays green)

All seven start from the wave-12 final commit (D1) and re-read every file they touch.

### 4.1 W13-PR: the wire and shared content (one agent; effort M, 1.5 days)

§3.1 in one commit, the bound table first; `content.ts`, `quests.ts` additions; type-only skeletons
`packages/shared/src/sea.ts` (types, a `seaEventsAt` stub returning nothing, `validateSeaFile` stub) and
`packages/shared/src/fishing/types.ts`; `index.ts` exports for `swim`, `springs`, `sea`, `fishing`; PROTOCOL.md.
**Tests:** every new request and event round-trips through the validators; unknown fields of known frames are dropped;
`rest: 900` parses and `fishingLevel: 11` does not; `next` at most two levels deep with `startedAt` ≥ the parent's;
the fail-reason list has no duplicate; an old frame without the new fields parses unchanged.

### 4.2 SW-P: swim shared + `packages/nav` (one agent; effort M, 2.5 days)

SWIMMING SW-P in full (its §14 row): `packages/shared/src/swim.ts` (constants, `classifyRegion`, `pruneBodies`, the
exit test, types), `packages/nav/src/swim.ts` (`swim.bin` decode, `SwimLayer`, the swim walker, `waterAt()` for
S-WATERQ with the springs-first order of D18), the **tile-mask hook** in `packages/nav/src/world.ts` (`tileState` /
`terrainLeg`, a per-call ignore flag) and `reach.ts` (the monsters' components with swim closed).
**Tests:** SWIMMING §14's SW-P list (classes on fixtures; the walker stops at land, `noExit`, the domain edge, solids;
passes under decks; the masked land walker stops at swim tiles; `swim.bin` round trip) + wave 12's `nav-instance`
tests unchanged.

### 4.3 HS-P: springs shared (one agent; effort S, 1 day)

HOT_SPRINGS HS-P minus the wire lines (handed to W13-PR): `springs.ts` types, `validateSprings`, `soakPoolAt`, the
pure rest maths (fill, cap per level band, bonus, day budget, overnight split at the window's end, clamp).
**Tests:** `springs-rest.test.ts`, `springs-geometry.test.ts` (HOT_SPRINGS §6.5's pure rows).

### 4.4 W13-SV: the server spine (one agent; effort M, 1.5 days)

D4 and D5: the kill-modifier list (D6; with no module registered, every reward is byte-identical), the regen-factor
list (D7), the per-hit guard list, the five module stubs registered in the right order (`swim` after `movement`,
`springs` after `posture`), `lastInputAt`, the entry-point hook list, the three migrations and row fields, the
`saveProgress` extras hook, the `/fish`, `/rest`, `/sea` GM rows (a stub answers "not built yet").
**Tests:** a kill with no modifier = today's `StatGain` exactly; two dummy modifiers apply in D6's order; the regen
factors multiply; the migration 10 → 13 on a temp DB copy (the three accounts' rows intact); the GM rows audit; the
whole server suite.

### 4.5 W13-WR: the world-render spine (one agent; effort M, 2 days)

D8 and D10: the four `World` slots and `setSwimmer`, `HeightFog.suspended`, the `bedOnly` visibility rule,
S-WATER (per-source ripples and profiles merged, never null, both defines warmed; the town's FX as source `town`),
S-PUFF (the kind table, the unlit `springSteam` skeleton), the define sets in `material-budgets.test.ts` and the
warm-up hooks.
**Tests:** every slot `null` on Classic; PBR → Classic → PBR leaves nothing; the water strings and the town's ripples
unchanged with no springs source (byte-identical uniforms); no recompile when a source is added or removed;
`bedOnly` regions invisible above water and never `setEnabled`; the Low guard (`seams-classic`, `release-lowguard`,
`abuse-w9f/w10r/w11-lowguard`).

### 4.6 W13-CV: the converter spine (one agent; effort M, 2 days)

D12, D13, D15, D25 and the authored-data hook of D17: the pass slots and order with stubs (`world/decks.ts`,
`world/swim/index.ts`, `world/sea.ts`, the springs copy, `world/fishing-water.ts`), the manifest fields (§3.3), the
two uid ranges, `cli.ts` (`moves --swim`, `--fishing` on stub tools), the SOAK kind in `export-moves.ts`, one line
each in `data/{items, shops, npcs}.ts` calling a stub `data/authored.ts`, the cue rows and the export scope additions.
**Tests:** with every stub empty the export is byte-identical to wave 12's (G7-style); the pass order on a fixture
(a deck appended before the swim build; the sea pass sees the town dressing's uids; the grid sees an edits-pass pond);
a uid outside `content` or `sea` from those sources throws; old manifests validate; the movement pack unchanged
except for the SOAK kind's slot.

### 4.7 W13-G: the game spine (one agent; effort S, 1 day)

D26: the setting and its Options row and strings, the four feature stubs, the four i18n files registered, the
extra-pack loader `loadMovesPack(skel, kind)` (fetched after `worldEnter`, never awaited, MOVEMENT §6.1's rule), the
bubble-rule hook in `ux-world.ts`, the mock server's wave-13 fields (rest, fishing stats, swim state).
**Tests:** `settings.test.ts` additions (default off, old saves); the feature registry lists the four stubs; a
missing pack falls back silently; the whole `apps/game` suite.

---

## 5. Presets and budgets

### 5.1 What the wave adds per preset

| Preset | Fishing | Swimming | Under water | Hot springs |
|---|---|---|---|---|
| Low (Classic) | rods, lines, floats, rings (unlit); the clips; cooking props; **nothing while nobody fishes** | the clips on the Gerstner query; the band rule; ≤ 2 effect draws | the Classic fog swapped to the water colour, the dome hidden, the two-tone surface; bed regions; interactables and event creatures; no life, plants or particles; above water byte-identical | dry basins, rocks, lamps, awning, pavilion; no water or steam; the rules and HUD in full |
| **Medium (default)** | as Low with the lit prop path; floats on the worker-FFT query | as Low on the worker-FFT query; no pass of its own | absorption, caustics, Snell's window, 10 rays, plankton, ≤ 64 bubbles, plants ≤ 4 draws, life ≤ 5 draws, far plane 90 m, shadows 40 m, actors to 45 m | the springs surfaces + profile, unlit steam ≤ 120, life ≤ 2 draws, lamps in the 8-light pick |
| High | as Medium (no rod shadows) | as Medium (GPU-FFT query) | + 16 rays, more life, GPU-FFT normals in the window, caustics from above in the shallows (≤ 4 m) | steam ≤ 160, 32 lights, SSR in rain |
| Ultra | as High | as High | as High, shadows 60 m | as High, SSR always, 64 lights |

### 5.2 Budgets and honest costs (WAVE_PLAN8 §5.2 format; 1080p)

Dev PC = Ryzen 5 9600X + RX 9060 XT, Chrome. "Mid" = a CPU ≈ 1.5× slower; "laptop / M1" = CPU × 1.4–2, a base M1 GPU
≈ 9–11× the dev GPU time (WAVE_PLAN8 §5.2). Baselines are the **measured wave-11 rescue re-bench** (`wave11/budgets.md`,
commit cb65112, 2026-10-02 01:45–03:05, quiet machine, p95, median of 3) [confirmed]. Wave 12's deltas are WAVE_PLAN8
§5.2's projections (trees ≈ +0.3 ms at the 20-player plaza, ≤ +0.3 elsewhere; terrain ≤ +0.15 GPU) [projected];
**G-12's measured numbers replace them** before LAB-13 judges anything. Wave 13's rows come from the four specs'
prototypes and fact-checks [projected unless tagged]. Arithmetic: `work/tmp/w13-plan/budget.py`.

**Frame p95 on the dev PC, Medium, WebGPU / WebGL2, ms: existing scenes** (wave-11 rescue measured → wave 12
projected → wave 13 projected):

| Scene | Rescue (measured) | + wave 12 | + wave 13 | Why |
|---|---|---|---|---|
| **Plaza: 20 monsters + 20 jumping players + town (G1's thin scene)** | 14.9 / 10.3 | ≈ 15.2 / ≈ 10.6 | **unchanged** | no fishing water, swimmer or springs in view; the underwater plugin is a uniform test above water (within noise on both backends [confirmed: UNDERWATER §8.3, fact-check re-run]) |
| Tiger Girl, 20 players (the red line) | 15.0 first fight / 16.3–17.3 later on a page; 10.9 | ≈ +0.2–0.7 (trees in view) | **unchanged**; still red at the line | the 20 characters' CPU and GC; the performance pass after wave 13 (BACKLOG 9) |
| Plaza noon, crowd, meadow, fields night | 7.2, 8.3, 7.7, 5.6 / 5.0, 6.1, 3.7, 3.5 | + ≤ 0.3 | unchanged | — |
| **Beach (beach-south), the G6 view** | 1.7 / 1.1 | ≈ 1.7–2.0 / 1.1–1.3 | **+ ≤ 0.05** (one angler; the S1 pier batched, +0 draws; caustics from above only on High) | G6: ≤ +0.15 ms dev GPU p50 |

**New wave-13 scenes (LAB-13, §5.4):**

| Scene | Medium WebGPU | Medium WebGL2 | High WebGPU | Pass line | Source |
|---|---|---|---|---|---|
| **S1 at dusk: 12 anglers on the pier and the sand, 8 swimmers, a campfire cooking (the "busy beach")** | **≈ 8.0–10.5**; ≤ 13.5 late in a session | ≈ 5.6–7.4 | ≈ 12–17 (reported) | **G1 < 16.7: pass, ≥ 3 ms spare** | beach 1.7–2.0 + 20 characters +6.0–7.7 (+4.2–5.3 WebGL2), from the rescue bench + dusk lights, fishing parts, ripples, fire ≈ 0.3–0.8; the rescue's later-page penalty +1.5–3 [projected: `budget.py`] |
| 20 swimmers + 10 waders off S1, camera in the band | ≈ 8–10; ≤ 12.5 late | ≈ 6.5–7.5 | ≈ 12–14 | pass | SWIMMING §13.2 |
| **G1-UW: 20 divers at the shrine during a Jade Tortoise window** | **≈ 6.5–10**; ≤ 13 late | ≈ 5–8.5; ≤ 11.5 late | ≈ 9.5–13 | pass | UNDERWATER §9.2 (the reef measured 1.4–1.6 / 2.6–2.8 → 0.6–1.0 with upload-on-change [confirmed / projected]) |
| The reef, nobody, full dressing and life | ≈ 2.0–2.6 | ≈ 1.2–2.0 | ≈ 3.8–4.5 | pass | UNDERWATER §9.1 |
| **The springs, 20 friends soaking** | **≈ 9–12** (9.7–11.2 on G-11's slower day) | ≈ 6.5–8.5 | ≈ 12–15 | pass, ≈ 5 ms spare | HOT_SPRINGS §10.2 |
| The springs arrival, nobody (noon, golden hour, night) | ≈ 1.8–2.6 | ≈ 1.3–1.9 | ≈ 3–4 | pass | HOT_SPRINGS §10.2 (bench 1.35–1.7 ms) |
| The moat at the south gate, 5 anglers, the town in view | ≈ plaza noon + ≤ 1.5 | — | — | pass | FISHING §11.4 |

| Preset | Draws added | GPU added (dev) | CPU added (dev) | Laptop / M1 | VRAM added | Download added |
|---|---|---|---|---|---|---|
| Low | fishing +4 while anyone fishes (+1 per species held up 1.5 s); swim ≤ 2; under water ≈ +4; springs props in the batch + the attendant | ≈ 0 | fishing ≤ 0.1 ms with 20 lines; swimmers as runners (20 ≈ +0.2 ms mean) | N100 class: under water ≈ +0.2 ms | ≈ +1.5–4 MB (bed regions, pavilion) | swim ≈ 0.1–0.2 MB eager; fishing 0.6–1.0, under water ≈ 0.55, springs ≈ 0.6, all lazily |
| **Medium** | fishing +4; swim ≤ 2; **under water ≈ +16** (+6 measured in the prototype, full dressing and life projected); springs +6–10 in the zone; **0 at the plaza** | fishing ≤ 0.05; swim 0; under water +0.07 measured → ≈ +0.3–0.5 full scene; springs steam +0.07 at the worst close-up [confirmed: HOT_SPRINGS §9.3, WebGPU only] | ≈ +0.5–0.8 ms under water (≈ 16 draws × 18 µs, boids ≤ 0.15); fishing ≤ 0.1; springs ≤ 0.03 | **M1: fishing ≤ 0.3 ms; swim 0; under water ≈ +2.7–5.5 ms GPU on top of the reef's ≈ 5–6.5; springs ≈ +0.7 at the close-up.** The beach alone is 11–15 ms there, so **crowds at S1 or the springs (13–17 ms) run under 60 fps on a base M1**; a few friends are fine | **+7–14 MB** at most at once (fishing ≤ 3, under water near S1 +5–7, springs +2–4) | **≈ +2.7–3.2 MB** for a player who does everything; ≈ 0.1–0.2 MB on first world entry |
| High | as Medium (+ rays in one draw) | under water ≈ +0.4–0.6 | as Medium | gaming laptop: comfortable alone; 20-character water scenes ≈ 12–17 ms on the dev PC | as Medium | as Medium |
| Server | — | — | fishing replay ≤ 0.1 ms [confirmed: `bench.mjs` 17–20 ns/step], module ≤ 0.02 ms/angler/tick; swim walker µs; springs µs/player/s; `seaUse` ≤ 0.1 ms | — | memory: water grid ≈ 2.3 MB, `swim.bin` ≈ 0.4 MB | **deploy ≈ +4–5 MB** (fishing ≈ 1, swim ≈ 0.2, under water ≈ 2, springs ≈ 1); 3 migrations |

What the tables mean, honestly:

- **Medium, the default, holds 60 fps in every new scene on the dev PC** [projected], and **wave 13 adds nothing to
  G1's existing thin scenes**: the plaza and the 20-player fight have no water feature in view, the underwater plugin
  costs nothing measurable above water, and fishing creates nothing while nobody fishes.
- **The new scenes are expensive only because 20 characters are**: each feature's own share is ≤ 0.3–0.8 ms on the dev
  PC; the rest is the wave-11 per-character CPU cost (G-11: CPU p95 15.8–16.6 against GPU 2.2 ms at the plaza). The
  later-on-a-page GC penalty (+1.5–3 ms) still leaves every new scene under the line, thinly for the busy beach and the
  soak.
- **The old red line stays red**: Tiger Girl with 20 players at 16.3–17.3 ms as a later fight. Wave 13 cannot lower
  it; it must not add to it (G3, and the zero-allocation rule of D30). The performance pass after wave 13 owns it.
- **High misses 60 fps in 20-character scenes as in every wave** (reported, not gated); the water scenes on High are
  ≈ 12–17 ms.
- **Base M1 Macs**: diving alone or with a few friends holds 60 fps; a crowd of friends at S1, the shrine or the
  springs does not, whatever these features do. The user hears this plainly (§8).
- **Projections rest on four prototypes, two of them measured without a quiet machine or on one backend** (the springs'
  steam bench ran at 18–30 % CPU, WebGPU only, HOT_SPRINGS F7). LAB-13 measures the production bundle on a quiet
  machine before anything ships.

### 5.3 Per-lane budgets (dev PC, 1080p; the GPU lock for every in-browser timing)

| Lane | Budget |
|---|---|
| FS-R | ≤ 4 draws for any number of anglers (+1 per species held up), no shadow casters; ≤ 0.1 ms CPU with 20 lines; 0 allocations per frame (600-frame heap check); 0 compiles after warm-up; nothing created while nobody fishes |
| FS-G / FS-S | the gauge ≤ 0.05 ms; the sim ≤ 0.02 ms/frame; a replay ≤ 0.2 ms; `tickPlayer` ≤ 0.02 ms per angler; the grid loads ≤ 50 ms |
| FS-A / SW-A / HS-A | FISHING §11.3 (feet ≤ 1 mm, hands on the rod ≤ 3 cm, pack ≤ 240 KB brotli per skeleton); SWIMMING §4.4 (STAND1 ≤ 0.1°, loops ≤ 0.1 mm, ≤ 25°/frame, neck 0–0.2 m over the waterline, pack ≤ 100 KB brotli); HOT_SPRINGS HS-A (the seat within 2 cm of SIT_CHAIR's, ≤ 60 KB) |
| FS-D / FS-W | the deck ≤ 1,600 triangles, +0 draws; the deck nav round trip bit-exact; `water.bin` ≤ 80 KB brotli |
| SW-C / SW-S / SW-G | `swim.bin` build ≤ 2 s; an editor publish of one region ≤ 50 ms; `walkEntity` with three legs ≤ 50 µs; the evade check ≤ 2 µs; ≤ 20 µs per swimmer per frame; the band rule ≤ 10 µs |
| UW-R | above water within noise of no plugin (both backends); caustics ≤ 0.25 ms GPU, absorption ≤ 0.1 ms; the under branch ≤ the ocean's above-water cost + 0.1 ms; rays + plankton + bubbles ≤ 3 draws, ≤ 0.2 ms GPU, **instance buffers uploaded only on change**, WebGL2 p95 with them within + 0.2 ms of without; 0 new varyings, 0 new texture units |
| UW-C / UW-D / UW-L | bed regions 0 draws above water, ≤ +5 under water at S1, the convert ≤ +10 s; plants ≤ 4 draws, ≤ 60 k triangles in view; life ≤ 5 draws, ≤ 0.2 ms CPU (High 0.35), 0 allocations, life on vs off on WebGL2 within + 0.3 ms |
| UW-S / UW-E / UW-A | `seaUse` ≤ 0.1 ms; `seaEventsAt` ≤ 0.01 ms; audio ≤ 0.05 ms, ≤ 2 extra voices |
| HS-W / HS-S / HS-G / HS-B | 1 water draw for all pools, no new water variant, the profile swap ≤ 0.05 ms on a zone change only; steam ≤ +0.15 ms GPU at the close-up, ≤ 0.02 ms CPU; the springs tick ≤ 20 µs for 20 players, ≤ 1 DB write / 30 s / soaker; the HUD redraws only on a stats change; the pavilion ≤ 2,500 triangles, ≤ 0.6 MB |
| Together | every existing LAB scene within + 0.2 ms (Medium) / + 0.3 ms (High) of G-12; the beach within + 0.15 ms dev GPU p50 of G-12 (G6) |

### 5.4 LAB-13 method

The wave-11 / wave-12 gate method: the production bundle on a private `vite preview` (a free port, stopped after), a
private server on a **temporary copy of `work/server/game.db`** with throwaway GM accounts and the bots of the LAB-11
harness (extended: bots that fish through `/fish`, swim, dive and sit in pools), 1920 × 1080, device pixel ratio 1,
a 60 Hz timer pump (the pane is hidden), 400 uncapped frames after streaming idles and no shader compiled for 3 s,
**3 runs, median**, `prof.js` once per page, WebGPU `uncapturederror` hooked, **the GPU lock held**, **a quiet machine
(CPU under ≈ 15 % for 30 s before each page)**, at most one browser tab, closed after. Scenes, Medium on both backends
first, then High (WebGPU, WebGL2):

1. **The S1 busy beach at dusk** (12 anglers casting, fighting and landing on a loop, 8 swimmers, a campfire with 2
   cooks) — the new G1 scene; also 20 anglers only (FISHING §11.4 scene 1).
2. 20 swimmers + 10 waders off S1 at noon, the camera at the waterline band.
3. **G1-UW: 20 divers at the shrine at noon during a Jade Tortoise window** (`/sea spawn tortoise`); the reef with
   nobody at noon, dusk and night; looking up.
4. **The springs with 20 bots soaking** (noon and night); the arrival view (noon, golden hour, night); the Jade Pool
   close-up with steam on / off (the G6 view).
5. The moat at the south gate with 5 anglers and the town in view; the restaurant stove with 6 cooks.
6. **The existing LAB-12 list re-run** (the 20-player plaza with crowd and town, Tiger Girl at both camps in
   LAB-11's order, plaza noon, crowd, meadow, fields night, the beach): G3.
7. Walks with the hitch watchdog (no frame > 16.7 ms): town → S1 → the springs; diving through the surface 10 times;
   the first cast on a fresh page; a login at the springs and a login under water.
8. Warm-up time at world load against G-12 (UNDERWATER R3), and the WebGL2 life on / off stall row (UNDERWATER R13).

One results file: `work/tmp/w13-lab/budgets.md`, copied to Dropbox `wave13/budgets.md`.

### 5.5 The gates (the 60 fps rule)

- **G1:** Medium p95 < 16.7 ms on both backends in every LAB-13 scene, the four new ones included, with every feature
  on; the existing scenes as G-12 measured them (the Tiger Girl later-fight line is reported against G-12, not
  re-judged as a wave-13 regression unless G3 says so).
- **G2:** High WebGPU ≤ 12 ms at the plaza and ≤ 14 ms in the 20-monster crowd; WebGL2 Medium and High ≤ 8 ms at the
  plaza (the rescue measured WebGL2 High at 8.2, at the line: reported). The 20-character water scenes on High are
  reported, not gated.
- **G3:** no existing scene slower than G-12 by more than + 0.2 ms (Medium) / + 0.3 ms (High).
- **G4:** the Low guard (the plaza and a field pixel-identical on Low with nobody fishing, nobody in water, the camera
  above water); `material-budgets.test.ts` (≤ 16 WebGL2 units, ≤ 15 varyings + `front_facing`, no new varying, the
  terrain still at its count); 0 WebGPU validation errors; no GLSL on WebGPU; **no shader compile** on the first cast,
  a surface crossing, the first view of the pools or a login at the springs or under water; **0 allocations per frame**
  in the fishing, sea, swim and springs parts; instance buffers uploaded only on change.
- **G5 (look):** the user-reviewed sheets: the clip GIF pages (fishing, swim, SOAK, both skeletons) with their numeric
  checks green; the underwater sheet (the reef at noon, dusk, night, looking up, the wreck, the shrine, the school, the
  tortoise); the springs (milky jade, not pool cyan; night steam at the terrain's night brightness); the S1 pier.
- **G6 (Mac margin):** the dev GPU p50 at Medium may grow over G-12 by at most **0.15 ms in the beach view** and at the
  springs' Jade Pool close-up, **0.4 ms elsewhere**. A miss at the springs halves the Medium puffs (cut 7); at the
  beach it turns caustics-from-above off on High as well and re-measures.
- **G7 (data and rules):** with the wave-13 content empty, the export equals wave 12's; `swim.bin` incremental = full;
  the closed-shore report holds SWIMMING §3.3's components; no route point to the springs or S1 within 85 m of an
  aggressive home; every fishing replay in the suite matches; the migration 10 → 13 on a temp copy of the live-schema
  DB keeps every row.
- **G8 (authority and economy):** every abuse test of FISHING §8.4, HOT_SPRINGS §5.4, UNDERWATER F9/F10 and SWIMMING
  SW-D23/D25 green; one Rested fill per 20 h whatever the order of soak, idle, logout, relog and restart.

A feature that breaks G1 on a preset ships **off** on that preset or is cut (§7). A G2 miss blocks the feature on High
but not the release; G4, G6, G7 and G8 block the release until fixed or cut; G5 blocks the item until the user's sheet
passes (the default ships if the user does not answer); the numbers go to the user.

---

## 6. Steps and lanes

### 6.0 Step order and concurrency

```
(now)      wave 12 builds, gates, verifies (its own workflow)
pre-start  NEW FILES ONLY, no shared file, no work/out writes:
           FS-A key_fish.py + 9 clip key files (male, then female) | SW-A key_swim.py + 5 clips x 2 | HS-A SOAK key re-pack prep
           FS-D pier.py (the 62 m deck model) | HS-B pavilion.py | UW-D bpy plants, clam, shrine parts, turtle/ray/jelly,
           the S-FISHMESH generator + 19 species + 5 extras
           GPU Q0: UW-D's SDXL concept (only while wave 12 holds no lock) -> Meshy J1 + J2 (network; NIGHT_LOG rows)
step 0:    W13-PR | SW-P | HS-P | W13-SV | W13-WR | W13-CV | W13-G      -- all from the wave-12 final commit
step 1:    fishing:    FS-P | FS-I | FS-C | FS-A (packs) | FS-D (S-DECK) | FS-W | FS-SND
           swimming:   SW-C (swim build + coast files) | SW-E (editor water rule) | SW-A (packs) | SW-S | SW-G
           underwater: UW-R | UW-C | UW-D (data, review sheet, tortoise pick) | UW-L | UW-S | UW-A
           springs:    HS-S | HS-W | HS-A | HS-B | HS-SND | HS-E (staging export)
           -- checkpoint X1: merge, I-13 merges the springs regions (D27), convert + packs + optimize; byte and route checks --
step 2:    FS-S | FS-K | FS-R | FS-G | HS-G | HS-Q | UW-E ; review shots on the GPU queue (Q2)
           -- checkpoint X2: full re-convert + full optimize --
step 3:    I-13 (§6.6) -> LAB-13 (§5.4, GPU Q3) -> H-13 (§6.7) -> F-13 (§6.8) -> G-13 (§6.9, GPU Q4) -> V-13 (§6.10)
           -> the user's checks (§8) -> deploy only on the user's new OK (D44)
```

Critical path [projected]: step 0 (≈ 2.5 agent-days, parallel) → SW-S (4) and FS-S after FS-P (1.5 + 3) → I-13 →
LAB-13 → H-13 → F-13 → G-13 → V-13. The Blender keying (≈ 7.5 agent-days of clips) and the Meshy bake-off are off it
because they start in the pre-start.

### 6.1 The GPU queue and the early art (one lock, never two GPU jobs at once)

| Slot | When | Job (owner, label) | Length | Needs |
|---|---|---|---|---|
| Q0 | pre-start, between wave-12 GPU jobs | the tortoise concept: the bpy turtle rendered, painted over with the local SDXL (UW-D, `UW-D sdxl-tortoise`), scratch only | ≈ 10–20 min | ComfyUI start/stop scripts; then Meshy J1 + J2 run on the network, no lock |
| Q0b | pre-start | EEVEE frames for the first clip GIFs (FS-A cast/reel both skeletons, SW-A SWIM + SWIM_IDLE female) | ≈ 5 min each | short items; Cycles CPU needs no lock |
| Q1 | step 1 | the clip GIF pages (FS-A 9 × 2, SW-A 5 × 2, HS-A SOAK × 2), the icon renders (FS-I), the creature and plant sheets (UW-D), the pavilion turntable (HS-B), the tortoise bake-off sheet (bpy / J1 / J2 at 2.5 m and 10 m under water) | ≈ 5–20 min each | the lab page or Blender |
| Q2 | step 2 | the in-game review shots: the underwater sheet (G5-UW), the springs noon/golden/night, the S1 pier at dusk, before/after at the beach | ≈ 20 min each | a private preview + server on a temp DB copy |
| Q3 | step 3 | LAB-13 (§5.4) | ≈ 3 h | a quiet machine |
| Q4 | step 3 | G-13, then V-13's three cells | ≈ 1.5 h + 20 min | a quiet machine |

Rules: bench slots (Q3, Q4) pre-empt everything not yet started; no wave-13 slot runs while wave 12 holds the lock;
Blender keying, bmesh and Cycles CPU need no lock; a Meshy job is network-only and logs its row when it returns.

### 6.2 The lanes

Effort: agent-days (≈ ½ day per agent session). Every lane re-reads its files at the wave-12 final commit.

| Lane | Owns (files) | Seams it uses | Tests | User check | Effort |
|---|---|---|---|---|---|
| **FS-P** shared fishing | `packages/shared/src/fishing/**` (`sim.ts` from the prototype, `roll.ts`, `types.ts`, `validate.ts`, `recipes.ts`) | W13-PR | `fishing-sim.test.ts` (recorded toggles → the same outcome; no transcendental `Math.` call, a lint test; the player-model bands of FISHING §4.5 ±5 points); `fishing-roll.test.ts` (100 k rolls per body ±2 %; eligibility; pity; caps; no class-dependent field before the hook) | — | 1.5 |
| **FS-I** items, shops, NPC defs (S-ITEMS, S-SHOP, S-NPCDEF) | `packages/convert/src/data/authored.ts`, `content/items/fishing.json`, `content/shops/fishing.json`, `content/items/icons/**`, `tools/blender/fishing/icons.py` | W13-CV's hook lines | a retail collision, a missing icon, a sell above buy are errors; the springs' and sea files merge; `items.json` round trip; authored NPC defs resolve a model | open the tackle shop | 1.5 |
| **FS-C** fishing content | `content/fishing/{species, bodies, rules, recipes, letters, cook-spots}.json` (incl. the freshwater shape rows, the springs and S1 cook spots), `content/quests/fishing.json`, `content/npcs.override.json` (Ahn, Mei, Yunhua), the ingredient drop group | FS-P validators; the QUESTS checker; UW-D's sea ids | `quests-content-check` green; every species reachable in some water; every recipe's ingredients obtainable; the 24 letters present | read three letters | 1.5 |
| **FS-A** fishing clips + rods | `packages/convert/tools/blender/fishing/{key_fish.py, props.py}`, `packages/convert/src/tools/fish-clips.ts`, `content/moves/<skel>/fishing/*.json` (9 × 2), the rods (≤ 200 triangles) | W13-CV's `--fishing` flag; the keyers read-only | FISHING §11.3 per clip from `fish_keys.json`; the pack index; 0 unmapped joints on all 26 bodies | the GIF page per skeleton | 3 |
| **FS-D** decks (S-DECK) + the S1 pier | `packages/convert/src/world/decks.ts`, `tools/blender/fishing/pier.py`, `content/fishing/piers.json` (decks, the jetty edge patch, the ladders) | W13-CV's nav-step hook; the `content` uid range; WORLD_EDITOR's Publish checks | walk on/off; reached from town; no trap; deck height ±2 cm; the landward edge on the sand ±5 cm; piles solid to a swimmer; ladders reach the deck; byte-identical without `piers.json`; a uid outside `content` throws | walk to the end of the S1 pier | 2.5 |
| **FS-W** water bodies | `packages/convert/src/world/fishing-water.ts`, `content/fishing/bodies.json` rules | W13-CV's step 9; SW-P's `waterAt`; the springs' surfaces | survey counts ±5 % per body; palace ponds `town`, springs `springs`; the moat in the safe-area box fishable; an editor pond is body 11; a cast from the pier's end over the bounds line is water | — | 0.5 |
| **FS-SND** sound | `packages/convert/src/sound/fishing-synth.ts` | W13-CV's cue rows | same seed → same bytes; the cue table resolves | listen at the pier | 0.5 |
| **FS-S** fishing server | `apps/server/src/fishing/**` (module, roll, replay, journal, limits, store) | W13-SV (registration, the `/fish` row, migration 12, S-INPUT), FS-P, SW-S's `p.swim` | real-server integration (cast → strike → report → item); every refusal; bag full → owner-protected drop; gates (swimming, mounted, trading, stalling, `jump` ends it); caps, fatigue, idle; records; one abuse test per FISHING §8.4 row | `/fish odds` at the moat | 3 |
| **FS-K** cooking + S-BUFF | `apps/server/src/{cooking, refreshment}.ts`, the campfire entity | W13-SV's S-REWARD and S-REGEN lists; `addModProvider`; the teas | recipes, spots, cancel on move, batches; the slot (replace, persist, death, login, offline pause); D6's order with Rested and Calm; the Feast's party share; `swimMul`/`breathMul` sent | cook at the stove | 2 |
| **FS-R** fishing render | `packages/world-render/src/fishing/**` | W13-WR's `World.fishing`; warm-up hooks; `waveHeightAt` | the Low guard; nothing at count 0; 4 draws with 20 anglers; no caster; 0 allocations; material budgets | watch a friend fish | 1.5 |
| **FS-G** fishing client | `apps/game/src/fishing/**`, `apps/game/src/hud/fishing/**`, `i18n/en-fishing.ts`, `world/features/fishing.ts`, `audio/fishing.ts` | W13-G; FS-P; FS-R; D23's Space binding | the input map (stance, cast, strike, hold, Space vs jump); a played fight replays in a test page; the gauge at UI scales 1–3; Easy timing | the ten-minute moat session | 3 |
| **SW-C** swim build + **the coast files** | `packages/convert/src/world/swim/**`, `packages/convert/src/world/coast/**` (the 1.2 m wade line; UNDERWATER §3.1's bed-region rule with `bedOnly`), `content/swim/swim.json` | SW-P; W13-CV's slot; FS-D's piers (read); UW-D's zones and `solid` boxes (read) | SWIMMING §14's SW-C list (determinism; S1 with no gap band; the component join; quay-bound bodies stay wade; the dive-zone union to z 1560); 5 `bedOnly` regions at S1, none outside; the coast checks unchanged otherwise | the swim map in the viewer | 2.5 |
| **SW-E** the editor's water rule | the D30 branch in `packages/shared/src/world-edits/nav-rule.ts`, the three rows in `packages/convert/src/world/edits/checks.ts`, the builder call in `packages/convert/src/tools/convert-region.ts`, the Water panel's tint and "No swimming here" toggle in `apps/viewer/src/editor/**` (its water tool file only) | SW-C's builder; wave 12's editor API | a 2 m test pond makes swim tiles in both the incremental and the full build; a pond with no shore stops Publish; the nest warning at 25 %; walking stays closed on > 1.2 m | add a pond, swim in it on "Test in game" | 1.5 |
| **SW-A** swim clips | `packages/convert/tools/blender/swim/key_swim.py`, `packages/convert/src/tools/swim-clips.ts`, `content/moves/<skel>/swim/*.json` (5–6 × 2) | W13-CV's `--swim` flag | SWIMMING §4.4's checks on both skeletons, incl. the two touch-ups (the palm's 30.5° whip, the tread's wide arms) | the GIF page | 3.5 |
| **SW-S** swim server | `apps/server/src/swim.ts` (gate, `dive`, breath, `swimDepthM`, entry, trade cancel, the evade guard), `apps/server/src/{world.ts (walkEntity, arrive, clamp), nav.ts, ai.ts, mounts.ts}` | W13-SV (registration, guard and entry hooks), SW-P | SWIMMING §14's SW-S list (legs, approaches never swim, exits, clamp, the lock table, mounts, dive, monsters, evade vs cliff, Water Ghosts, login on an old bed) | — | 4 |
| **SW-G** swim client + camera | `apps/game/src/world/swim/**`, `world/jangan/camera.ts`, the camera/picking code of `screens/world.ts`, the breath bar, `i18n/en-swim.ts`, stroke and splash cues | W13-G (`loadMovesPack`, the feature stub); UW-R's `World.underwater` (read); `setSwimmer`, `sea.bubbles` | SWIMMING §14's SW-G list (float, clip choice, the pitch opening only in water, band hysteresis over 600 frames, no post-process and no compile on a crossing, clicks on the surface) | swim S1, dip the camera | 3.5 |
| **UW-R** underwater render + **the ocean and sky files** | `packages/world-render/src/underwater/**`; the under branch in `ocean/{ocean-plugin, ocean-classic}.ts`, `pbr/water-plugin.ts`; the dome's under colour in `sky/*`; the far plane and shadow cut in `World.update` | W13-WR's slots and `HeightFog.suspended` | plugin parity WGSL/GLSL; varying budget silent; ≤ 16 units; the Classic above-water output byte-identical; alpha 1 from below; 0 validation errors; upload-on-change | dive at noon, look up | 3 |
| **UW-C** sea dressing pass | `packages/convert/src/world/sea.ts` (scaled copies without collision, props on the terrain heightfield, patches and points into the ambient file) | W13-CV's slot and the `sea` uid range; UW-D's file | empty `content/sea/` = byte-identical; uids in range; a 0.13 prop adds no nav object; a prop outside the export rejected | — | 1.5 |
| **UW-D** sea art + data + Meshy | `packages/convert/tools/blender/sea/*.py` (plants, clam, shrine parts, turtle, ray, jelly, the tortoise's flap weights, **the S-FISHMESH generator**), `content/sea/{jangan-sea, underwater, events, species}.json`, the crab VAT bake, the Meshy bake-off | the GPU queue; `MeshyClient`; FS-C's freshwater shape rows | `validateSeaFile`; triangle caps (plants ≤ 120, creatures ≤ 500, fish ≤ 400, the hero ≤ 3,000); the painterly palette; every Meshy job in NIGHT_LOG | the creature sheet; **the tortoise pick** | 3.5 |
| **UW-L** sea life | `packages/world-render/src/sea/**` | the life part's files by import only; W13-WR's `World.sea` | 0 allocations; flee within 6 m; counts per preset and period; Low → null; ≤ 5 draws | swim through a school | 3 |
| **UW-S** sea server + shared | `packages/shared/src/sea.ts` (full), `apps/server/src/sea.ts`, `content/items/sea.json`, `content/npcs/sea.json` | W13-SV (migration 13, `/sea`, the calm modifier slot); SW-S's `swimDepthM` | `seaEventsAt` determinism (server and client fixtures; a frozen world clock does not stop the clams); every `seaUse` refusal incl. the level gate and the pick cap; once per day per clam; the key consumed | open the coffer | 2 |
| **UW-E** sea client | `apps/game/src/world/features/sea.ts` (interactables on the bed, the clams from `seaEventsAt` with the `ServerClock`, `seaHold`, sightings on every preset, chat lines), the 45 m rule in `world/crowd-budget.ts`, `i18n/en-sea.ts` | W13-G; UW-S | a click sends `seaUse` only when diving and in range; Low draws the tortoise; a coffer rests on the sand | wait for the tortoise | 1.5 |
| **UW-A** underwater audio | `apps/game/src/audio/underwater.ts`, `setWorldFilter` in `audio/backend.ts` | — | transparent at 20 kHz above water; the `ui` bus bypasses it; ≤ 2 voices | listen under water | 0.5 |
| **HS-S** springs server | `apps/server/src/springs.ts`, the mock fields' server side, `/rest` behaviour | W13-SV (migration 11, S-REWARD, S-REGEN, S-INPUT, the `/rest` row), HS-P | HOT_SPRINGS §6.5 in full (rules, geometry, real-server integration, migration, one abuse test per §5.4 row) | `/rest info` | 2.5 |
| **HS-W** springs render | `packages/world-render/src/springs/**` | W13-WR's S-WATER, S-PUFF, `World.springs`; `World.life.addHabitat` | no surface without `springs.json`; the profile only in the zone; puffs ≤ cap; Classic null; no compile on arrival | the pools by day and night | 2 |
| **HS-A** SOAK clip | `content/moves/<skel>/soak.json` (+ `soak_lean.json` optional) | W13-CV's SOAK kind | MV-A checks; the seat within 2 cm of SIT_CHAIR's | the GIFs, man and woman | 1 |
| **HS-B** pavilion | `packages/convert/tools/blender/springs/pavilion.py`, the model's content entry | Blender 5.2 headless (bmesh) | ≤ 2,500 triangles, retail-size textures, posts-only footprint | the turntable sheet | 1 |
| **HS-SND** springs sound | the `springs/bubble` synth row, the `springs` area row | W13-CV's cue rows | the cue exists; ≤ 2 zone loops | listen at the Eye at night | 0.5 |
| **HS-E** the site | the World Editor layers of regions 172,90 and 173,90 (on the staging export), `content/springs/jade-mist.json` (polygons generated from the carve), `content/nests.override.json` (the 40 m patch), `content/items/springs.json`, `content/shops/springs.json`, Yunhua's row handed to FS-C | the editor (wave 12), FS-I's merge, D27 | Publish passes on staging; `validateSprings`; the route test (≤ 2.4 km; no point within 85 m of an aggressive home) | walk from town to the springs | 2 |
| **HS-G** springs client | `apps/game/src/world/features/springs.ts` (the soak line: seat at surface − 0.45 m), the EXP-bar rested segment, toasts, `i18n/en-springs.ts`, the music gain | W13-G's bubble hook; `soakPoolAt` | HOT_SPRINGS §8.4 | the 10-minute soak | 1.5 |
| **HS-Q** intro quest (optional) | JG_S01 in `content/quests/jangan.json` | QUESTS `deliver` | the quest validator; reachability | — | 0.25 |

Totals [projected: `budget.py`]: step 0 ≈ 11.5, fishing ≈ 20.5, swimming ≈ 15, underwater ≈ 15, springs ≈ 10.75,
integration to verify ≈ 9: **≈ 82 agent-days**, most of them in parallel lanes.

### 6.3 Seams each lane may not cross

- After step 0 no lane edits `packages/shared/src/{protocol, validate, content, quests, index}.ts`,
  `apps/server/src/{gameplay, connection, db, gm}.ts`, `packages/world-render/src/{world, water, town/fx}.ts`,
  `pbr/{fog-plugin, water-town-plugin}.ts`, `packages/convert/src/world/{manifest, passes, convert-world, uids}.ts`,
  `cli.ts`, `tools/export-moves.ts`, `data/{items, shops, npcs}.ts`, `apps/game/src/{settings, world/features}.ts`,
  `hud/options.ts`, `three/models.ts`, `ux-world.ts`: a lane that needs more asks I-13, which adds the seam in its own
  commit.
- One owner per shared module after step 0: the ocean and sky files **UW-R**; `world/coast/**` **SW-C**;
  `packages/nav/**` **SW-P** (step 0 only, then I-13); the server walker, AI and mounts **SW-S**; the editor's water
  rule **SW-E**; the authored-data merge **FS-I**; `refreshment.ts` **FS-K**; `audio/backend.ts` **UW-A**;
  `crowd-budget.ts` **UW-E**; `camera.ts` and the camera code of `screens/world.ts` **SW-G**.
- No lane edits wave 12's files except SW-E's four (D16) and W13-* seams, after the wave-12 commit. The jump module
  `apps/server/src/movement.ts` and the keyer bases are read-only.
- No lane writes `work/out/` outside the convert lock and the GPU queue; no lane runs the editor's Publish on the main
  export (HS-E uses staging, D27); no lane starts or stops the user's dev servers (:5180, :7000, :5173); private servers
  on free ports with temp DB copies only; at most one browser tab per lane, closed when done.

### 6.4 Merge order and checkpoints (I-13)

1. Step 0: W13-PR → SW-P → HS-P → W13-CV → W13-SV → W13-WR → W13-G. Suite + typecheck; record the test count.
2. Swimming: SW-C → SW-S → SW-A → SW-G → SW-E.
3. Underwater: UW-S → UW-C → UW-D → UW-R → UW-L → UW-A → (X1) → UW-E.
4. Fishing: FS-P → FS-I → FS-C → FS-W → FS-D → FS-A → FS-SND → (X1) → FS-S → FS-K → FS-R → FS-G.
5. Springs: HS-S → HS-W → HS-A → HS-B → HS-SND → HS-E (the D27 merge) → (X1) → HS-G → HS-Q.

The chains touch disjoint files after step 0 and may interleave; the order inside each chain is fixed (SW-C before
FS-W: the grid reads `waterAt`). After every merge: the Low guard, typecheck, `material-budgets.test.ts` if a material
or define changed.

### 6.5 Cross-item tests I-13 adds

- **Fish → cook → eat → swim:** a caught Hairtail cooked at the S1 campfire gives `swimMul` 1.1; the swimmer plays
  SWIM_FAST and moves at 3.63 m/s; the Croaker dish gives a 39 s dive.
- **The kill order (D6):** a kill with a meal (+10 %), Calm (+10 %) and a Rested pool pays `e + round(0.2 e) +
  min(pool, 0.5 e)`; the pool drains by the rest part only; quest EXP untouched.
- **Regen (D7):** soaking with the +35 % dish regenerates at ×4.05.
- **Fishing gates:** `fishCast` while swimming → `swimming`; jumping in stance is the line, out of stance the jump;
  entering water ends fishing.
- **The key loop:** `/fish give` the Rusty Bronze Key → dive to the sealed coffer → opened, key consumed; the
  tortoise's window doubles rare fish within 80 m (the server roll and `seaEventsAt` agree on a fixture clock).
- **The pier:** walk out on the S1 pier, drop into the sea (1.6 m, swim), climb a ladder back; no dive there
  (`too_shallow`).
- **The springs:** no swim, fish or dive there; `waterAt` answers `springs`; the town's water never takes the
  `springs` profile.
- **Divers and solids:** a diver over the wreck rides at `topM`; the camera does not enter the hull.
- **Low:** a live Low ↔ Medium switch under water, at the springs and with 20 anglers leaves no mesh, buffer or
  profile behind.
- **Empty content:** with `content/{fishing, swim, sea, springs}` empty, X2's export equals wave 12's for every
  untouched file (G7).

### 6.6 I-13: integration checklist (the lead)

1. Merge per §6.4; suite, typecheck and the Low guard after each merge.
2. X1 and X2 (D41) under the convert lock with their checks.
3. A scripted play-through on a private server (temp DB copy): walk town → S1, fish, cook, eat, swim out, dive to the
   shrine, open the coffer, take a pearl, swim back, walk to the springs, soak 15 min (clock injected), hunt, see the
   rested EXP; log out in the pool, log in 8 h later.
4. Two browser clients (WebGPU and `?engine=webgl`) at S1: the same lines, swimmers, divers and clams at the same
   time.
5. LAB-13 (§5.4); a G1 miss goes to §7 before release; G2 / G6 to the user.
6. Shots for the user (Dropbox `wave13/`): the S1 pier at dusk with anglers, the swimmer at the waterline, the reef at
   noon / dusk / night, the springs at noon and night, the clip GIF pages.
7. Docs: COAST.md (the 1.2 m wade line, bed regions, CST-K superseded), NAVIGATION.md (the swim layer, the mask, S-DECK),
   MOVEMENT.md (legs, dive), WORLD_EDITOR.md (D30 changed), RENDER.md (the underwater state, the plugin, `World.sea`,
   the springs), SOUND.md, QUESTS.md (`requires.fishing`, `reach.swim`), BALANCE.md (fishing gold, dishes, Rested,
   sea claims), PROTOCOL.md (§3.1), DEPLOY.md (three migrations, the backup), BACKLOG (wave 13 done, §12), PLAYTEST.md
   (§8's checks), each spec's status; mark the passages this plan overrides (FISHING §2.3's 25 m, FS-M, the ladders
   in `swim.json`, UW-C's coast rule, HOT_SPRINGS HS30, the migration numbers).
8. Scratch: keep every shot the user reviewed; delete the prototypes' large frame folders after the owning lane ports
   the method.

### 6.7 H-13: the hunt (read-only; findings become tests, then F-13 fixes)

The specs' own risks and fact-check lists stand. H-13 runs these lenses with all four items on, each by a separate
agent or pass, and files each finding with a failing test or a reproduction:

1. **Replay forgery** (FISHING lens 1): impossible sequences, early or late strikes, a re-roll oracle in any
   `fishCast` field, `fishStop` + re-cast before the bite step, cutting every hooked common line to dodge the cap.
2. **Desync:** a fight at 30 and 144 fps, in a background tab, across a GC pause, on Safari (the user's check).
3. **Economy:** buy-cook-sell loops; teas' sell-back; treasure at rates 1 and 5; a bot at the daily cap; kelp and
   urchin farming; level-1 alts at the coffer; Rested from quests, GM kills or a share.
4. **One Rested fill per 20 h** by any order of soak, idle, logout, relog or restart (HOT_SPRINGS lens 1).
5. **State machines:** fishing then mounting, trading, swimming, warping, dying, logging out mid-fight; a full bag at
   the catch; a trade open when either side enters water; dying while swimming; logging out while diving.
6. **Land swimming must not open** (SWIMMING SW-D25): reach every closed component by swimming, by a pier drop, by a
   ladder, by an editor pond.
7. **Kills across water:** bows and 15 m skills across rivers, lakes and the S1 strip (SW-D23); mobs stuck at shores.
8. **Leg chains:** a dropped `next`; three legs across a river with lag; an approach move ending in water.
9. **The camera:** flicker at the band on a storm swell; the camera in the wreck or under the terrain; dipping from
   dry land; the pitch never restored.
10. **Under water look:** the sky through the sea from below; the bed's edge visible; the plugin above water changing
    a pixel; WebGL2 stalls on instance uploads; night too dark.
11. **The springs look and rules:** the town's water taking the springs' profile; a soaker on the rim mis-detected;
    floating or neck-deep soakers; walking closed in the Eye; Low floating water or holes.
12. **Nav:** the S1 pier reachable and leavable, no trap at its end, the jetties; the springs route clear of the
    tomb nests (no point within 85 m of an aggressive home).
13. **Hitches and compiles:** the first cast, the first surface crossing, the first view of the pools, a login at the
    springs or under water, the bed regions streaming in, the S1 → springs walk; leaks on world → select → world × 3.
14. **Black WebGPU frame / validation:** the underwater plugin + the ocean's under branch + the springs + the town +
    trees in one view; `?gpuLimits=default`; a 16-varying adapter.
15. **GC:** heap growth per 400 frames in the busy beach and the diver scene against the plaza's; any per-frame
    allocation in the four parts.
16. **Low changed** by any item (the Low guard plus a pixel diff of the plaza and a field with nobody fishing).
17. **Protocol:** any `stats` / `statsDelta` with a wave-13 key failing to parse on the client; an old client on the
    new server for one move.
18. **Migration:** 10 → 13 on a copy of a schema-10 DB with the three real accounts' shape; a rollback note.
19. **Editor water:** a pond with no shore, a pond across a path, a "No swimming here" pond, incremental vs full
    `swim.bin`.
20. **Deploy path:** the deploy list (new files, three migrations, the backup first, `swim.bin` and `springs.json`
    present, the content folders shipped).

### 6.8 F-13: fixers

One fixer per file set (the owning lane's files, or I-13 for seam files), each fix with the test H-13 wrote; no fixer
edits another's files. Fixes that change a frame cost are re-measured on the affected LAB-13 scene before G-13; a fix
that changes the export runs X3.

### 6.9 G-13: the final gate

A re-bench of every §5.4 scene on the final tree and export (X2 or X3), on a quiet machine, under the GPU lock;
`work/tmp/w13-lab/budgets.md` updated with "final gate" numbers; G1–G8 judged (§5.5). The suite, typecheck and the
Low guard green. Any G1 miss → §7 cuts, then G-13 again.

### 6.10 V-13: the independent verify

A fresh agent that built nothing in this wave:

- re-reads this plan, the four specs and the diff, checks each never-cut item (§7) is present and each decision of §2
  is implemented as written (file owners respected: `git log --stat` per lane);
- re-runs the suite and typecheck, re-derives three G-13 cells under the GPU lock (the S1 busy beach Medium WebGPU, the
  shrine with 20 divers on WebGL2, the beach GPU p50 for G6);
- plays the cross-item list of §6.5 on a private server, and lands three fish with the replay accepting them;
- checks the Meshy ledger against NIGHT_LOG and the deploy list against `deploy/`;
- reports [confirmed] / [failed] per item to the lead; nothing ships on a [failed] never-cut item.

---

## 7. Scope-cut order (cut from the top; one list for the wave)

Each item names its spec's cut. Items marked **ask first** are cut only after telling the user.

1. The Sea Dragon's shadow (UNDERWATER cut 1).
2. The dusk manta (UNDERWATER cut 2).
3. The Campfire Kit and the `fire` entity (FISHING cut 1; cooking stays at the fixed spots).
4. SOAK_LEAN (HOT_SPRINGS cut 2); the optional Low pool water (HOT_SPRINGS cut 1).
5. The springs intro quest JG_S01 (HOT_SPRINGS cut 3).
6. Caustics from above water on High (UNDERWATER cut 3).
7. Steam on Medium halved to 60 puffs, **only on a G6 miss** (HOT_SPRINGS cut 10).
8. Other players' lines (viewers see rods and poses) (FISHING cut 2); other players' bubbles (UNDERWATER cut 4).
9. The river jetties' edge patch (FISHING cut 3).
10. The cranes and bird perches at the springs (HOT_SPRINGS cut 4); the jellies' night glow (UNDERWATER cut 5).
11. Ripples and wake for swimmers (keep the enter/exit splash) (SWIMMING cut 6).
12. The records board and its notices (FISHING cut 4).
13. SWIM_FAST (SWIM played 1.25× with a bonus) (SWIMMING cut 2).
14. The pier drop-in and ladders (in and out over the shore only) (SWIMMING cut 1).
15. Reef plants (keep seagrass and kelp), then kelp (UNDERWATER cuts 7, 8); crabs (cut 9); the common turtle and ray,
    keeping the Jade Tortoise (cut 10).
16. The Meshy hero → the bpy tortoise with a tuned palette (UNDERWATER cut 11).
17. The fishing quests (recipes unlock at fishing levels 3 and 7) (FISHING cut 5); the EAT clip (cut 6); FISH_STRIKE
    (cut 9).
18. The pavilion (HOT_SPRINGS cut 5); the friend boost (cut 6).
19. SWIM_ENTER / SWIM_EXIT → 0.25 s blends (SWIMMING cut 4).
20. God rays on Medium, then plankton on Medium (UNDERWATER cuts 14, 15).
21. The gatherables (kelp and urchin nodes) (UNDERWATER cut 12); cooking batches (FISHING cut 11).
22. Bottle letters 24 → 8 (FISHING cut 7); trophy sizes (cut 8).
23. Bed regions → the field skin (UNDERWATER cut 6).
24. The 150 m sea band: swimming inside the rectangle plus the dive zone (SWIMMING cut 5).
25. The sealed coffer and the key tie-in (keep the daily coffer) (UNDERWATER cut 13).
26. The tea shop (the attendant sells return scrolls only), then the attendant (a signpost) (HOT_SPRINGS cuts 7, 8);
    the bubbling loop (cut 9); the synthesized underwater bed sound (UNDERWATER cut 16).
27. The tomb moat's species, box and shard (the hook moves to wave 14) (FISHING cut 10).
28. **Ask first:** diving and breath (surface swimming only; the camera still dips; UNDERWATER's coffer and clams
    switch to their S-BREATH fallback) (SWIMMING cut 3).
29. **Ask first:** the S1 pier (S-DECK); the Jangan Ferry pier remains the user's "pier" (FISHING cut 12).

If G1 still misses on the 20-character water scenes after the cuts that touch them (7, 8, 11, 15, 20), the crowd
budget's wave-11 levers apply (as at the plaza), and the numbers go to the user.

**Never cut:**

- **Fishing with rare catches:** the catch mini-game with the server's replay; fishing at S1, the moat, the river and
  the ferry pier; the legendary, treasure and the bottle easter egg (≥ 8 letters); the fishing level; FISH_IDLE,
  CAST, REEL, CATCH and FAIL on both skeletons; the anti-bot and economy rules (FISHING §8.4); fishing on Low.
- **Cooking with small buffs:** cooking at the town stove with the small buffs of FISHING §7.2 in the shared
  refreshment slot (D6, D36).
- **Swimming with its animations and server rules:** SWIM and SWIM_IDLE on both skeletons; the depth rule and the swim
  layer on the server; the locks; monsters out of the water; the 1.2 m wade line (no gap band); the editor's
  "swimmable, not walkable" with the same builder; the band rule on every preset; the exit rule (SW-D25) and the
  evade rule (SW-D23); the Low path.
- **The underwater scenery with sea life:** the underwater state with absorption on every preset; the surface from
  below (Snell's window on Medium+, two-tone on Low); a bed under the dive zone; caustics under water on Medium+; one
  fish school that flees; the Dragon King's shrine with its daily coffer; the giant clams; the Jade Tortoise sighting
  with its fishing tie-in.
- **The hot springs with the rest bonus:** the place on the real map with three pools and their water; the steam on
  Medium and up; soaking; the persisted Rested pool with its cap, daily budget and anti-AFK rule; the HUD's rested
  segment; the trail fix (D20).
- **Everywhere:** the Low guard; ≤ 16 WebGL2 units; ≤ 15 varyings + `front_facing`; no new varying; no GLSL on WebGPU;
  0 WebGPU validation errors; **G1**; G6; G7; G8; the three migrations with the backup.

---

## 8. What the user must provide or approve

**To start: nothing.** Every tool is installed, nothing is downloaded, and every item has a default.

1. **The preview sheet** `work/tmp/w13-preview.png` (Dropbox `wave13/w13-preview.png`): the fishing mini-game and the
   cast clip, the swim cycle and the waterline camera, the underwater prototype, the hot springs render, the budgets.
   **Default:** build as shown (the springs with paler jade water and darker night steam than the prototype's).
2. **Meshy for the Jade Tortoise:** ≤ 40 credits early in the build (J1 + J2), ≤ 130 in the worst case, cap 400, of
   1,840; every job logged. **Default:** run under the standing permission ("we can use meshy if needed", NIGHT_LOG
   13:56). Then **pick the tortoise** on one sheet (bpy / J1 / J2 at 2.5 m and 10 m under water). **Default:** J1 if it
   passes the painterly rule, else the bpy turtle.
3. **The look sheets after step 2:** the clip GIF pages (fishing, swim, SOAK; man and woman), the underwater sheet
   (noon, dusk, night, looking up, the wreck, the shrine, the school, the tortoise), the springs at noon and night, the
   S1 pier at dusk. **Default:** the gates decide; a sheet you do not answer ships once its gates pass.
4. **After the build, about 35 minutes of play** (PLAYTEST.md gets the list): fish the moat for ten minutes with a
   trackpad, take a friend to the S1 pier at dusk (fish, cook, eat), swim off S1 and cross the lake, dive to the
   shrine (coffer, clam, tortoise or `/sea spawn tortoise`), soak 10 minutes at the springs with a friend and hunt.
   Say what feels slow or fiddly (swim speed 0.6 × run, the fight's timing, the springs' walk). **Default:** the
   build's numbers.
5. **Optional: write some of the 24 bottle letters.** **Default:** Claude writes all 24.
6. **On a Mac in Safari, land three fish** (the server must accept the replays). **Default:** ship on the arithmetic
   rule and the Chrome/Node evidence.
7. **The springs on your map:** the springs change regions 172,90 and 173,90 of the World Editor's layers (D27). If you
   have edited those two regions yourself by then, your edits win where they overlap. **Default:** go ahead.
8. **The deploy OK for wave 13** (a new one; it needs wave 12 first or together). **Default:** nothing deploys until
   you say so. It adds three database migrations (a named backup first), ≈ +4–5 MB on the server, and ≈ +3 MB of
   downloads for a player who does everything.

**To know (not to decide):** on a base M1 Mac, a crowd of friends at the S1 beach, the shrine or the springs will run
below 60 fps (the beach alone is 11–15 ms there); each feature adds ≤ 0.3–0.7 ms of that. A few friends, or the moat
and river spots, are fine. The performance pass after wave 13 is the fix.

---

## 9. Risks

| Risk | Default handling |
|---|---|
| Wave 12 slips or changes the editor, nav or render seams this wave builds on | step 0 waits for its final commit; the pre-start art and keying run meanwhile; SW-E and HS-E re-read wave 12's files there |
| The busy S1 beach or the soak crosses 16.7 ms on Medium (20 characters, a later page) | LAB-13 against G-12; the zero-allocation rule; cuts 7, 8, 11, 15, 20; the wave-11 crowd levers |
| Safari's JavaScriptCore disagrees with V8 on a fishing replay | the arithmetic rule + a lint test; user check 6; the server accepts a replay within ≤ 2 steps and logs it (FISHING R1) |
| Swimming opens land and monsters past the cap | SW-D25, the converter's closed-shore report, H-13 lens 6 |
| Kills across water (EXP farming) | SW-D23, H-13 lens 7 |
| Three migrations in one deploy | one owner (W13-SV), a step test 10 → 13 on a temp copy, a named backup first (D44) |
| WebGL2 stalls on per-frame instance uploads (the prototype's +1.8 ms) | upload on change; LAB-13's life on / off row; double-buffer the boids if they stall |
| Longer shader compiles from the underwater plugin text on every PBR material | warm-up at world load; LAB-13's warm-up row against G-12 |
| The springs read as a swimming pool (cyan) or the night steam glows | the paler jade profile, night steam at the terrain's night brightness; G5 |
| The Meshy tortoise is off-style or too heavy | the gate (≤ 3k triangles, ≤ 1.5 MB, painterly); one retry; the bpy fallback; cut 16 |
| The female clips need more than a transfer | per-skeleton key files (the jump's route); both keyed and checked in the pre-start |
| A nest patch row is lost in a content merge | the route test at every checkpoint (G7) |
| The editor's water rule and the converter disagree | one builder, an incremental = full byte test (G7), SW-E's Publish rows |
| Players find the springs' walk too far | the overnight soak makes one trip a session enough; the 20 % cap pays for the walk (HOT_SPRINGS §5.3); a sedan chair is Q2 |
| The legendary feels out of reach | odds, pity and Easy timing are content; the first week's `/fish stats` |

## 10. Open questions (each has a default, so nobody waits)

| # | Question | Default | Who settles it |
|---|---|---|---|
| Q1 | Swim speed 0.6 × run (3.3 m/s)? | yes; one constant | the user at play check 4 |
| Q2 | A paid sedan chair to the springs (≈ 1,000 gold)? | no: walk or ride (6.7 / 3.7 min), return scroll home | the user |
| Q3 | Is 20 % of a level per 20 h, at +50 %, the right Rested size? | yes; wave 14 re-tunes | the user |
| Q4 | Easy fishing timing on by default? | off; the lost-legendary toast suggests it once | the user after play check 4 |
| Q5 | Should the legendary be tradable? | no | the user |
| Q6 | Server-wide notices for fishing records and the legendary? | yes, one chat line each | the user |
| Q7 | Open the far banks (1.2 km², 121 nests of level 19–30) to swimmers? | no; wave 14 decides (`openShore`) | the user, in wave 14 |
| Q8 | Town ponds swimmable? | yes, not fishable (D35) | the user |
| Q9 | Is night diving too dark (4 % of noon, glowing jellies, two lanterns)? | ship it; the night check decides a lift | the user |
| Q10 | Should rain and storms make the sea murkier (× 1.2 / × 1.6)? | yes | UW-R |
| Q11 | A second dive site at the Jangan Bay mouth? | deferred | the user |
| Q12 | The Tortoise's Calm (+10 % EXP for 15 min) and the necklace's stats | these values unless BALANCE moves them | BALANCE in wave 14 |
| Q13 | Armour hidden while soaking? | no in v1 | the user |
| Q14 | Bottle letters in other languages? | English only | — |
| Q15 | Merge `swim.bin` and `fishing/water.bin` later? | no (D18) | I-13 |

---

## 11. Hooks for wave 14 (The Climb: levels 1–20 re-tuned, the Qin-Shi Tomb, nemesis monsters, the storm Qilin, the death penalty)

Nothing here is designed; each is a seam wave 14 can use without a migration or a protocol change.

- **Every number is content:** fishing (species, weights, prices, XP curve, rules, recipes, buff values), the springs'
  `rest` block (`capFrac` per level band, `bonusMul`, fills, idle, window), the sea (loot, windows, the level gate,
  the blessing), swimming (`content/swim/swim.json`). Bonuses are percentages or fractions of a level, so a new level
  curve scales them; a curve change **clamps the Rested pool at login**.
- **One kill-EXP order** (D6) in W13-SV's modifier list: wave 14's **death penalty** (from level 15, 1–20 % of the
  current bar on a death to monsters or bosses, NIGHT_LOG 22:51) takes EXP from the bar, never from the Rested pool or
  the refreshment (D36); nemesis or Qilin kills can be excluded from the meal, Calm and Rested by `mealEligible`,
  `restEligible` (one predicate each).
- **The tomb's doorstep:** the tomb moat's Quicksilver Eel and its broth (abnormal-state resistance +20 %, for the
  tomb's statuses), the Tomb Offering Box and its **Tomb Seal Shard**, the bottle letter about "rivers of quicksilver",
  the shrine stele's rumour line; the Dragon Pearl as a crafting item.
- **The storm Qilin's slot:** `seaEventsAt` already reads the broadcast weather (the Sea Dragon's storm slot); the
  `fishCaught {player, species, kg, body}` event on the module bus ("a storm stirs the bay").
- **Monsters and water:** `waterborne` (and a future `amphibious`) in `content/swim/swim.json`, with the rule that a
  waterborne monster must be fightable from where players can be; `events.json` `mobs: []` reserved under the sea;
  `openShore` rows for the far banks once their levels fit the new curve.
- **Per world:** the swim layer is per world, so a flooded hall in the Qin-Shi Tomb gets its own `swim.bin` from the
  same builder; `swimMul` / `breathMul` can become level rewards or skills.
- **Safe places:** the springs' zone is exported as a **sanctuary polygon** (no event spawns, no paths), so the
  hangout stays safe in every event.
- **The climb models** (`restsim2.py`, FISHING §10.2) take the per-level tables as input; wave 14 re-runs them on its
  curve.

## 12. Deferred

- **Not this wave:** a second dive site (Jangan Bay); hostile monsters under water; combat while swimming; horse
  swimming; a visual buoy line; a split waterline view; drowning; a sedan chair; Low pool water; the retail Hotan pool
  particles; the bed's world-wide sand-ripple pass outside the dive zone; trading the legendary.
- **After wave 13 (the user's order):** the performance pass (character batching, animation LOD, GC: BACKLOG item 9,
  the only fix for the 20-player lines and the M1 crowds), then waves 14 (The Climb), 15 (Wardrobe), 16 (Faces &
  Hair), 17 (Arsenal) as recorded in PROJECT_STATUS and NIGHT_LOG 22:49.
- **Still in the queue from waves 10–12** (WAVE_PLAN8 §11): the sky upgrade, the intro and login scene, the dodge
  roll, pets / friends / mail, the remaining texture batches, WebGPU snapshot rendering, KTX2 terrain arrays,
  production asset versioning.

## 13. Housekeeping

- The four specs stay the detailed design; this plan's decisions override them where they differ (D1–D30 in
  particular: the seven step-0 agents, the migration numbers, the kill-EXP order, the one owner per shared module, the
  40 m nests patch, the ladders in `piers.json`, FS-M folded into UW-D, the editor's water rule as SW-E, the reused
  fail reasons, the springs' layers merged without waiting for the user's first edit). I-13 marks the overridden
  passages in the specs.
- No lane commits; the lead integrates each step. No lane starts or stops the user's dev servers (:5180, :7000,
  :5173); private servers on free ports with temp DB copies only; at most one browser tab per lane, closed when done;
  every in-browser timing under the GPU lock on a quiet machine (3 runs, median).
- Every Meshy job is a NIGHT_LOG row: what, credits, result. The build's Meshy cap is 400 (D31). This plan spent 0
  credits and read the balance once (1,840 at 09:32:04Z).
- Scratch used by this plan: `work/tmp/w13-plan/budget.py` (the §5.2 and §6.2 arithmetic),
  `work/tmp/w13-plan/make_preview.py` (the preview sheet), `work/tmp/w13-preview.png`. No timing was taken for this
  plan: every frame number is a spec's measurement or a projection from one, and LAB-13 measures them.
