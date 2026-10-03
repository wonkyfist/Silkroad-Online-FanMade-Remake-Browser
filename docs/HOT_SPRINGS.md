# Hot springs (wave 13): Jade Mist Springs

The user, verbatim (wave 13):

> Hot springs: a relaxing spot in the mountains where resting builds bonus EXP for your next session, and a natural
> hangout for chatting.

The same wave adds fishing and cooking, swimming, and underwater scenery (their own specs; WAVE_PLAN9 merges the four).
Wave 14 ("The Climb") re-tunes levels 1–20 and adds the Qin-Shi Tomb dungeon, nemesis monsters and a storm Qilin. This
spec leaves hooks for it (§5.7) and designs none of it.

**What this spec builds:** **Jade Mist Springs** (玉雾温泉), three steaming pools on a forested mountain shelf above
the south-east sea, reached on foot from Jangan through the S1 beach pass. It has rocks, stone lanterns and a
bath attendant with a tea awning. Players soak in the water (a sitting pose in the pool), and soaking builds a
**Rested** bonus that the server keeps: **+50 % EXP and SP-EXP from monsters until it is used up. It holds up to 20 %
of the current level, fills in 15 minutes of soaking (or overnight if you log out in the water), and fills at most
once a day.** The place also has warm ambience for chatting (water, wind, birds, insects at night, fireflies, longer
chat bubbles), and a shop of small tea buffs.

**The user delegated every decision.** Each choice below is the option this spec would mark "(Recommended)". Each is
written as a decision with a one-line reason (§11). Only what truly needs the user is in §12 and §13, each with the
default used meanwhile. **Delegation is not a deploy OK.**

**Tags** (as in WAVE_PLAN8):

- **[confirmed]**: checked in the code or data of the working tree on 2026-10-02, or measured by this spec's scripts
  or prototype (§9). Each one says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived), not measured on that setup.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this spec makes. The user may overrule it.

**Repo state when this was written** [confirmed: `git log`, `git status`, 2026-10-02 ≈ 08:15 UTC]: HEAD `cb65112`
("Wave 11 G1 rescue ..."), and **wave 12 is building in the working tree** (63 changed paths, uncommitted:
`apps/game` settings and Options, `apps/server/src/gm.ts`, `packages/convert/src/{cli, world/convert-world}.ts`, ...).
This spec edits none of it. Its scratch is `work/tmp/hot-springs/`: the site census (`census.py`, `site.ts`,
`site2.py`), the walking routes (`route.ts`, `flood.ts`), the maps (`mapcrop.py`, `routemap.py`, `local.ts`,
`local.py`), the climb model (`restsim.py`) and the prototype (`lab/`).

**Sources read:** docs/BACKLOG.md, WAVE_PLAN8.md (the format), COAST.md (+5 m sea, S1, the S1 link, the coast's
nav), WORLD_EDITOR.md (the layers, water and nav rules, sound zones, lights), MOVEMENT.md (server-authoritative
movement, the jump, the lock table), GRASS_LIFE.md (life: birds, butterflies, fireflies, dragonflies),
TOWN_LIFE.md (SIT_CHAIR, the steam layer, lanterns), SOUND.md, QUESTS.md, SYSTEMS_COMBAT.md, BALANCE.md, FIELDS.md,
DEPLOY.md. Code: `apps/server/src/{posture, progression, gameplay, db, chat, connection, nav, item-use}.ts`,
`packages/shared/src/protocol.ts`, `packages/world-render/src/{water, town/fx, pbr/water-town-plugin, objects,
terrain-edit}.ts`, `packages/convert/src/tools/{export-moves, town-clips}.ts`. Data: `work/out/world/jangan-fields/
{manifest, ambient}.json`, `nav.bin`, the terrain bins, `work/out/data/{nests, npcs, shops, items, zones}.json`,
`work/out/sound/index.json`, `content/coast/coast.json`.

**Fact-check (2026-10-02 ≈ 09:00–09:30 UTC, adversarial pass; corrections applied in place, marked *(fact-check)*):**

| # | The claim | What the check found | Fixed in |
|---|---|---|---|
| F1 | `rest` / `restToday` join `PLAYER_STAT_OPTIONAL_KEYS` as plain integers | `validate.ts` parses **every** optional key with `int(o, k, 0, HWAN_MAX)`, and `HWAN_MAX = 5` [confirmed: `validate.ts` 979, `protocol.ts` 1524]. A `stats` with `rest: 900` would **fail to parse** and drop the whole message. The loop needs a per-key bound table (SWIMMING adds two keys too) | §7.1, HS-P |
| F2 | SIT_CHAIR puts the hips on a seat 0.45 m above the feet | The keyer measured **seatZ 0.537 m, hip joints 0.611–0.626 m** [confirmed: `work/out/moves/*/town/town_keys.json` `seat`]. At the 0.4 m shore ledge the seat would sit 0.14 m **above** the water: an "invisible chair". The client now sinks a soaker to one hip line per pool, and the server's soak window needs 0.3 m of water | §4.1, §6.5, §8, HS14 |
| F3 | Moving nests 2060 / 1911 25 m north clears the trail "by 8–9 m plus the sight range" | A mob picks a target within its sight **and** within `leashRange` of its home, and `leashRange = max(50, radius + 10) = 80 m`; it roams up to 70 m from home [confirmed: `ai.ts` 154–160, `gameplay.ts` 521–523]. After 25 m the trail is **78–79 m** from both homes, inside the 80 m gate [confirmed: `route-town.json` vs the shifted centres]. **40 m** puts it at 93–94 m. The shifted centres place on the nav with their whole spawn circle walkable [confirmed: `nestshift.ts`]. Both nests are level 9 (not 8/9) | §0, §2.4, HS3 |
| F4 | The casual friend reaches 20 9–13 % sooner (cap 10 %) | `restsim.py` reproduces its own numbers, but it **charges no time for the trip** to the springs. With the trip (walk 6.7 min + a 30 s return scroll ≈ 7.5 min a session), 10 % nets **1.5–2.5 %** for the casual frugal player and **−4…−9 %** for potion-fed play [confirmed: `restsim2.py`]: the bonus did not pay for the walk. The cap is now **20 %**: net **8.6–9.2 %** (frugal 1–2 h a day) | §0, §5, HS16–HS19, Q1 |
| F5 | One cap per day = at most 10 % of a level per real day; soaking never beats hunting | A 20 h window allows two caps inside 24 h at a window boundary and 1.2 a day sustained. At levels 16–19 a full pool is worth more than 15 min of frugal hunting (10 %: 8–18 min; 20 %: 16–36 min) [confirmed: arithmetic on the BALANCE tables] | §5.2, §5.3 |
| F6 | Rested is the only EXP effect (HS26); S-REWARD is one springs call | FISHING's dishes give **kill EXP +5 / +10 %** in the shared refreshment slot (FISHING D20: `base × (1 + meal) + rested`) and FISHING puts a cooking spot by the tea awning [confirmed: `docs/FISHING.md` §7]. S-REWARD becomes a modifier list in that order; S-REGEN factors multiply | §4.5, §6.1, HS26, HS-E |
| F7 | Lit PBR puffs +1.2–1.7 ms vs unlit +0.07 ms | The two rows differ in size too (lit ≤ 4.2 m, unlit ≤ 2.6 m). At the **same 2.6 m** the lit material costs **+0.85–0.91 ms** and the unlit one **+0.0–0.06 ms** (the doc's own table). The conclusion stands. Not re-run: the GPU lock was held by T12-A from 08:57Z; the bench ran with the CPU at 18–30 % (the rule is < 15 %), no `log.json` was saved, and only WebGPU was measured | §0, §3.2, §9.3, HS9 |
| F8 | 20 friends on High ≈ 17–19 ms | By the doc's own method (High 20-player plaza 19.4 − High crowd 10.7 = 8.7 ms for 20 players, + the springs on High ≈ 3–4), the High scene is **≈ 12–15 ms** [projected], under 16.7. High's SSR runs only in rain (puddles > 0.1); Ultra always [confirmed: `render/post.ts`] | §10.1, §10.2 |
| F9 | SWIMMING's swim threshold "≈ 1.3 m or more" | `SWIM_DEPTH_M = 1.2` [confirmed: `docs/SWIMMING.md` §0] | §2.5 |
| F10 | Migration 11 | UNDERWATER also claims migration 11 (`sea_claims`); FISHING takes "the next after HOT_SPRINGS'" [confirmed: the specs]. WAVE_PLAN9 numbers them; no test hard-codes 11 | §6.2 |
| F11 | Bowl heights 56.5–57.5 m | Over x 932–980 × z 1158–1182: p5 56.6, median 57.1, p90 58.6 m (the edges climb to 62 m) [confirmed: `local.json`] | §0, §2.2 |
| F12 | Macs | Macs play on Medium (WAVE_PLAN8 F21) and the M1 beach view is projected at 11–15 ms GPU; the springs (the sea in view) with 20 soaking friends and the steam come to **≈ 13–17 ms on an M1** [projected], at the line | §10.3, §16 |
| F13 | The nests patch through the GM Spawns tab | The tab writes `DATA_DIR/content/nests.override.json` on the host; the repo's `content/nests.override.json` (layered first, `game.ts` 173–176; `patch` rows take a position, `nest-edit.ts` 255) ships with the build and is tested [confirmed] | §2.4, HS-E |
| F14 | `lab/out/log.json` | Not there; the measurements exist only in §9.3 | §9.3, appendix |
| F15 | The springs set the ripple points and swap the profile | Wave 11's town FX writes the whole ripple list **every frame at any distance** (`town/fx.ts` 441–457), so a second writer is overwritten; a null profile or a 0 ↔ some point count flips a define and recompiles the water [confirmed: `water-town-plugin.ts` 196–225]. S-WATER becomes per-source lists and profiles merged by the renderer, never null, both defines warmed at load | §3.1, HS-W |
| F16 | Town and springs never in one view "(ring B ≈ 255 m)" | Ring B is the grass meadow ring, not a view radius; regions load within 320–480 m and unload beyond 460–660 m [confirmed: `stream.ts` 59–63], so the claim holds for the right reason | §3.1 |

**Confirmed again by the fact-check** (re-derived, not copied): the posture rules, the `sit` rate limit, REGEN, the reward path and the rates, 10 migrations, `BUBBLE_MS` 5 s / 80 chars, the puff caps and the `steam` kind, `RIPPLE_POINTS_MAX` 8 and `WATER_PROFILES = ['town']`, the 32 m water blocks and the profile weight (b), the region / block arithmetic (rx = 168 + ⌊x / 192⌋, rz = 97 + ⌊−z / 192⌋: the bowl is in 172,90 / 173,90, block (0,5) of 173,90 is x 960–992 × z 1152–1184) and its flood (≈ 640 m² below 57.75 m), the 2.20 km route and its timings (MOVE_SPEED 5.5), nests 2060 and 1911, `cj_field_lamp` (model 213) with its night emitter, every retail prop in the manifest, `NPC_CH_KISAENG3`, the return scroll (5,000 gold, 30 s cast, `use.returnToTown` handled in `item-use.ts`), the zone names, the `env/` sounds, the climb tables of `restsim.py`, and the wave-11 budgets quoted in §10.2.

---

## 0. Summary

1. **The place: a mountain shelf on the south-east ridge** (regions 172–173 × 90, centre ≈ (955, 57, 1180) glTF m).
   It is a natural bowl at ≈ 56.5–58 m (median 57.1 m) under a 60–160 m cliff, with a spur that looks south over the sea 50 m below.
   It is in the town spawn's walkable component [confirmed: `MeshNav.inHome`, `site.ts`]. The nearest nest ring is
   200 m away [confirmed: `site.ts`, every nest of `nests.json`]. It is the best-scoring quiet high spot among 23,364
   walkable sample points of the playable area (§2.1). On foot from the town plaza it is **2.2 km, ≈ 6.7 min** (≈ 3.7 min on a horse). The way
   goes through the south gate, the passive Lake Forest and the coast's S1 link over the south wall. From the S1
   beach it is **0.5 km, 1.5 min** [confirmed: grid search on the server nav, `route.ts`].
2. **One monster spot on the way, fixed with a nests patch:** the trail through the S1 link crosses the edges of
   two aggressive level-9 nests (Stone Ghost 2060, Tomb Stone 1911) by 16–17 m [confirmed: `route.ts`]. Their
   centres move **40 m** north (rows in the repo's `content/nests.override.json`), which puts the trail outside their
   80 m leash gate; 25 m did not *(fact-check F3)*. This also fixes the S1 beach for fishing (§2.4).
3. **Three pools:** the **Jade Pool** (main soak, ≈ 20 × 13 m, surface 57.25 m), the **Sea-view Pool** on the spur
   (≈ 13 × 10 m, 55.35 m) and the **Spring's Eye** (≈ 6 m, 57.75 m). The Eye is the hot source: it steams the most and
   nobody can stand in it. Basins are carved with the World Editor's height layer (≤ 1.2 m cuts, ≤ 1 m rims). Paint,
   grass masks, rocks, stone lanterns, the tea awning and the walkable override are also World Editor layers. The water
   is **the springs feature's own surfaces** at each pool's own level. It is not editor water, because the editor's
   32 m one-level water blocks would flood the sloping shelf [confirmed: the block arithmetic over the height table,
   §2.5]. Pools stay ≤ 1.0 m deep, so walking stays open and swimming never starts there.
4. **The look:** milky jade water (the wave-11 water profile plugin gains a `springs` profile, with no new shader).
   Steam is a lazier, larger puff kind, drawn **unlit with a sky-tinted colour**: the prototype measured wave 11's
   lit PBR puffs at +0.85–0.91 ms GPU close up at the same 2.6 m size (+1.2–1.7 ms at 4.2 m), and the unlit ones at
   +0.0–0.07 ms *(fact-check F7)*. It is ≤ 120 puffs on Medium, one draw,
   in the zone only. Stone lamps carry the retail night glow and the night-light pick [confirmed: `ambient.json` model
   213 `cj_field_lamp`]. One small bpy-built wooden pavilion over the Jade Pool, and fireflies and dragonflies through
   GRASS_LIFE's habitats. The prototype shows it in the real renderer (§9).
5. **Soaking** = the existing `sit` request inside a soak pool. The server knows the pools from the same content file,
   so there is **no new request and no new posture**. Clients play a **SOAK** clip (wave 11's SIT_CHAIR keys re-packed
   into the player movement pack; the client sinks a soaker to one hip line per pool, so the seat is always under
   the water and the shoulders above it *(fact-check F2)*). HP/MP regeneration is ×3 while soaking.
6. **Rested EXP (server-side, persisted):** a per-character pool in EXP.
   - Cap: 20 % of the current level's EXP-to-next *(fact-check F4: 10 % did not pay for the trip)*.
   - Bonus: +50 % kill EXP and kill SP-EXP (after `EXP_RATE`/`SP_RATE`), paid from the pool. Quest EXP is never
     boosted.
   - Fill: a full pool takes 15 min of soaking (+25 % per other soaker in the same pool, up to +50 %). Logging out in
     the water fills it at the overnight rate (8 h for a full pool). An idle soaker (no input for 10 min) also drops to
     the overnight rate.
   - **At most one full pool per 20 h**, persisted.
   - **The climb model** at the recommended rates (3/3/3/2), **with the trip counted** (≈ 7.5 min a session: the
     walk to the springs to log out in the pool and a return scroll in the morning): a casual frugal friend who plays
     1–2 h a day reaches 20 **8.6–9.2 % sooner** (16–19 % before the trip). A 4 h session gains ≈ 3 %, and potion-fed
     play loses 3–6 % to the walk: for them the springs are a social stop, not an EXP gain [model: `restsim2.py` on
     `restsim.py`'s BALANCE §3 tables] *(fact-check F4)*.
7. **Hangout:** the zone name "Jade Mist Springs" on entering, chat bubbles that stay 8 s and keep 2 lines, the
   music at 35 %, and an area bed (day wind and birds, night wind, insects and night birds, from retail `env/*`)
   plus a new bubbling-water loop. Bath Attendant Yunhua (an authored NPC on a retail gisaeng model) sells three teas
   (small 30-min buffs, doubled while soaking) and return scrolls. A one-step intro quest from the town herbalist is
   optional (cut 3).
8. **Formats:**
   - Wire, all additive and optional: `PlayerStats.rest?`, `PlayerStats.restToday?`, `StatGain.rest?`. No new message
     or request.
   - Migration: one `ALTER TABLE characters` (4 columns).
   - Content and manifest: one content file `content/springs/jade-mist.json`, copied into the export, and
     `manifest.springs?`.
   - Server config: no new key; the knobs are in the content file, so wave 14 re-tunes data, not code.
9. **Budgets (§10):**
   - G1: Medium < 16.7 ms holds with margin. The springs view with 20 soaking friends is ≈ 9–12 ms WebGPU Medium
     [projected].
   - High: the same view ≈ 12–15 ms [projected *(fact-check F8)*]; an M1 on Medium ≈ 13–17 ms GPU, at the line
     [projected *(F12)*].
   - Prototype (§9.3): the springs scene itself benches at **1.35–1.7 ms** per frame and the steam at **+0.07 ms**
     GPU at the worst close-up (unlit) [confirmed by the author's WebGPU bench; WebGL2 not measured].
   - Memory: VRAM ≈ +2–4 MB.
   - Download: ≈ +1.0 MB the first time a player goes there.
   - Server: ≈ 0 (one check per soaker per second, ≤ 1 DB write per 30 s per soaker).
10. **Never cut (§15):** the place on the real map with its three pools and steam, soaking, the server-side
    persisted Rested pool with its cap and daily budget, the anti-AFK rule, and the HUD's rested segment.

### 0.1 Where each part of the request lands

| User request (verbatim fragment) | Where | Lanes |
|---|---|---|
| "Hot springs" / "a relaxing spot in the mountains" | §2: Jade Mist Springs on the south-east ridge shelf; §3: pools, steam, rocks, lanterns, pavilion | HS-E, HS-W, HS-B |
| "resting builds bonus EXP for your next session" | §5: the Rested pool; online soak, overnight soak; cap, daily budget, anti-AFK | HS-P, HS-S, HS-G |
| "a natural hangout for chatting" | §4: chat bubbles, ambience, music, capacity for 20, the attendant and teas | HS-G, HS-SND, HS-E |
| (task) "sitting/soaking animations" | §4.1: SOAK = SIT_CHAIR keys in the player movement pack | HS-A |
| (task) "server rules, anti-AFK, protocol, migration" | §5.4, §6, §7 | HS-S, HS-P |
| (task) "leave hooks for wave 14" | §5.7 | HS-P, HS-S |
| standing goal "at least 60 fps" | §10 | LAB-HS |

---

## 1. What exists to build on [confirmed: read in the code and data, 2026-10-02]

- **Sitting.** `apps/server/src/posture.ts` handles `sit {on}`:
  - refused while moving, acting, casting, or within 5 s of a hit (`in_combat`);
  - anything that moves or acts stands the player up;
  - viewers get `entityUpdate {posture}`, and late joiners get `EntityState.posture: 'sit'`;
  - posture is runtime only (a relog stands everyone up);
  - rate limit `sit {2/s, burst 4}` (`CLIENT_RATE_LIMITS`).
- **EXP.** `Gameplay.mobDied` pays each share `reward(p, round(exp × EXP_RATE), round(spExp × SP_RATE), mob)`.
  `computeReward` → `gainExp` (`progression.ts`), then `store.saveProgress`, then `statsDelta {stats, gain}` with
  `StatGain {exp, spExp, from?, quest?}`. Quest turn-ins use the same `gainExp` path unrated. At the cap no EXP is
  kept and SP-EXP still counts.
- **Rates on the friends' server:** DEPLOY.md recommends `EXP_RATE=3 SP_RATE=3 GOLD_RATE=3 DROP_RATE=2` in
  `silkroad.local.env` (BALANCE §7) [likely deployed: the file lives on the mini PC, not read here].
- **Regeneration:** 3 % of max HP/MP per 2 s pulse after 5 s out of combat (`formulas.ts REGEN`).
- **Persistence:** SQLite, append-only `MIGRATIONS` in `db.ts`, `PRAGMA user_version`; 10 migrations today
  (10 = `uniques`). `characters.last_played` is written with the position save.
- **Optional stats:** `PLAYER_STAT_OPTIONAL_KEYS = ['hwan']`, which is the precedent for optional `PlayerStats` keys.
  *(fact-check F1)* The parser bounds **every** optional key by `HWAN_MAX` (5) (`validate.ts` 979), so a new key needs
  a per-key bound first (§7.1).
- **Chat bubbles:** a speaker's last local line floats over the name tag for 5 s (`BUBBLE_MS`, 80 chars;
  `apps/game/src/world/features/ux-world.ts`).
- **Steam:** wave 11's `town/fx.ts` puff layer.
  - Lit PBR, thin-instanced camera quads, one draw.
  - Caps: 120 puffs on Medium, 160 on High, 200 on Ultra, 0 on Low.
  - Its `steam` kind is food-stall steam: 2.6 s life, 0.16 → 0.8 m.
  - Emitters come from placements by model rule within 90 m of the focus.
- **Water profiles:** `pbr/water-town-plugin.ts`.
  - Ripple points: at most 8.
  - Per-region profiles: a colour, turbidity and reflection on region water whose vertex colour b = 1.
  - `WATER_PROFILES = ['town']`: "One slot this wave".
- **Water blocks:** the water is per 32 m block: a flat plane at the block's height, with alpha from the depth (full
  at 3 m), one mesh per region (`water.ts`). The editor's Water tool sets block levels; new water deeper than 1.2 m
  closes walking (WORLD_EDITOR D30).
- **The terrain lattice is 2 m** (97 × 97 per 192 m region). The World Editor's height layer is a per-region delta
  (LA16, 1/256 m steps).
- **Night lamps:** `cj_field_lamp` (model 213) carries a `townLamp` night emitter `map/cj_pal_lamp_orange.efp` at
  1.73 m (`ambient.json`). `cj_pal_lamp` (173) and `cj_lamp01` (127) carry orange glows too. Editor-placed lamps
  join the night-light pick (8 lights on Medium) and the ground splat on every preset (WORLD_EDITOR §4.9).
- **Life:** GRASS_LIFE's `World.life` has `addSpecies` / `addHabitat` (the coast registers gulls with them).
  Fireflies spawn near trees and water at night; dragonflies over inland water.
- **Sound:** retail `env/` exports day/night wind, `day_bird01–05`, `night_bird01–05` and `night_insect01–03`
  [confirmed: `work/out/sound/env/`]. The wave-11 town fountain is a synthesized loop (`town/fountain`, cue
  `town.fountain`). World Editor sound zones add at most 2 loops (WE-R).
- **NPCs and shops:**
  - The GM NPC editor can `add <base code> <name>` an authored `NPCX_<n>` on a retail model and give it an
    existing shop (`npc-edit.ts`).
  - Shops come from the retail export (5 stores).
  - **There is no authored-shop or authored-item file today.** Fishing needs both too (§7.5).
- **Player clips:** the movement pack `char/_anims/<skel>/movement.glb` has the kinds JUMP, JUMP_RUN and
  JUMP_RUN_FIST, keyed in headless Blender by `pnpm sro moves` (`export-moves.ts`, MV-A).
- **SIT_CHAIR** is keyed today only as a town VAT clip (`content/moves/<skel>/town/sit_chair.json` →
  `town_clips.glb`). Its measured seat is **0.537 m** above the feet and the hip joints 0.611 m (woman) / 0.626 m
  (man) [confirmed: `town_keys.json` `seat`] *(fact-check F2)*.
- **The S1 pocket.** S1, the walkable south beach, is reachable on foot only through the coast's in-bounds link
  over the south wall (`coast.json openTiles`, "S1 link over the south ridge"). The springs shelf is inside the same
  pocket.
- **Zone names:** regions 172,90 and 173,90 are named "Jangan South Beach" (`zones.json`, from the coast).
- **Meshy:** the balance is **1,840 credits** [confirmed: read through the repo's `MeshyClient`,
  `work/tmp/trees/w12/meshy/balance.ts`, 08:08 UTC; the key never printed; not re-read by the fact-check, which spent
  nothing either]. This design spent **0**.

---

## 2. The place

### 2.1 How the site was chosen [confirmed: scripts in `work/tmp/hot-springs/`]

The requirements: reachable on foot, scenic, in the mountains, not on a monster path. The method:

1. `census.py`, per playable region (x 156–174 × z 90–102): height mean/max/relief, the nest load (the sum of the
   `count` of every nest whose ring touches the region, any level), the open-nav share, and the distance from the
   south gate (96.9, −136.9).
2. `site.ts` on the **server's own nav** (`MeshNav.load` of `nav.bin`, home component = the town spawn's), every 8 m:
   - walkable terrain in the home component;
   - flatness: the height range on a 12 m disc;
   - "overlook": the share of points 60–150 m away that lie 15 m or more below;
   - "walls": the share that lie 25 m or more above;
   - the clearance to the nearest nest ring (any level).

   23,364 points pass the walkable test.
3. A score of overlook + 0.6 × walls + height / 120. Candidates must clear every nest ring by 50 m or more, rise 15 m or
   more above the sea, and keep the height range on the 12 m disc within 4–5 m (`site2.py`).
4. Minimap crops with the nests drawn (`mapcrop.py`), and walking routes on the nav (`route.ts`: a 3 m grid, every
   edge a real `nav.walk` leg, aggressive nest rings penalised).

| Candidate | Where (glTF m, y) | Score | Nearest nest ring | From the gate | Verdict |
|---|---|---|---|---|---|
| **South-east ridge shelf** (172–173,90) | (976, 57, 1192) | **0.63** (best) | 215–230 m (Tomb Stone L9) | 1.6 km straight, **2.2 km walked** | **Chosen**: a bowl under the cliff, the sea below to the south, forest around |
| East coast terrace (174,91–92) | (1328, 35, 976) | 0.30–0.35 | 164–211 m | 1.6 km | lower, no backdrop, next to the tomb's east nests |
| North cove (170,102) | (560, 12, −1104) | 0.28 | 200 m | 1.1 km | a valley mouth at 5–12 m by the north sea; the Qin-Shi tomb's ghosts 200 m east |
| River cliff (164,100) | (−720, 2, −752) | 0.57 | 211 m | 1.0 km | rejected on the map: a river bed (the "overlook" is the river) |
| West valley (163,101) | (−928, −28, −872) | 0.38 | 263 m | 1.3 km | rejected: river bed under retail water |

Nothing quieter and higher lies within 1.3 km of the town. The Tiger Mountains and Yeoha's Forest are monster
ground (FIELDS §1.2), and the high ground of the Hill of Ye Mt. is nest-dense. The chosen shelf is the only high,
quiet, flat spot with a mountain backdrop and a view [confirmed: the table above, every playable region].

### 2.2 The site [confirmed: the height table of `local.ts` (2 m), `hs-local.png`]

- **The bowl:** heights ≈ 56.5–58 m over x 932–980 × z 1158–1182 (p5 56.6, median 57.1, p90 58.6 m; the north and
  west edges climb to 62 m) *(fact-check F11)*. North, the slope climbs to 60–80 m within 25 m, then
  to a closed cliff (100–160 m). The shelf is in **regions 172,90 (x < 960) and 173,90**.
- **The spur:** 55–56.5 m, running south-east from (975, 1195) to (990, 1230). Below it the ground falls to the sea
  (17–45 m at z 1248, the +5 m sea and the coast's beach beyond).
- **The arrival:** from the west, along the ridge from the S1 beach, over a 62–63 m saddle at x 880–905. The route
  descends into the bowl at (940, 1186).
- **Quiet:** no nest ring within 200 m [confirmed]. The nearest are the Chinese Tomb's level-8/9 nests north of the
  wall, on the other side of the cliff.

![The route from the town to the springs](../work/tmp/hot-springs/hs-route.png)

*`hs-route.png`: the route from the plaza (top) through the south gate, the passive Lake Forest (yellow rings) and
the S1 link over the south wall, past the aggressive tomb nests (red), to the springs (right circle). The S1 beach
place is the left circle.*

### 2.3 Getting there [confirmed: `route.ts` on `nav.bin`, 3 m grid; times at MOVE_SPEED 5.5 m/s]

| From | Walked | On foot | On a horse (×1.8) | Climb |
|---|---|---|---|---|
| Town plaza | 2.20 km | **6.7 min** | 3.7 min | 250 m |
| S1 beach (`beach-south`) | 0.51 km | **1.5 min** | 0.9 min | 78 m |

- **There is no teleport [decision]:** the walk is part of the place. A return scroll (sold at the springs, §4.5)
  takes players back. *(fact-check F4)* The trip is the real price of Rested: ≈ 7.5 min a session (the walk there to
  log out in the pool, the scroll's 30 s cast at the next login, 5,000 gold ≈ 8–17 min of frugal gold at
  `GOLD_RATE` 3), or ≈ 13.4 min walking both ways. §5.3 sizes the pool against it. The town has no player teleport service today [confirmed: no travel service in `npc.ts`].
  A paid "sedan chair" from town is an open question (§13 Q2).
- **Finding it:**
  - a world-map label and a minimap icon (from the content file);
  - a stone lamp every ≈ 40 m along the last 500 m from the beach (editor placements);
  - two signposts, at the S1 link and at the beach;
  - the GM place `jade-mist-springs` for `/tp`.

### 2.4 The one monster spot on the way, and the fix [confirmed: `route.ts`]

The safest route the search finds still crosses two aggressive nest rings at the S1 link, at (551–605, 974):

| Nest | Mob | Centre | Radius | Count | Aggressive, sight | The trail inside the ring by |
|---|---|---|---|---|---|---|
| 2060 | Stone Ghost (L9) | (605.6, 920.9) | 70 m | 9 | yes, 11.5 m | 16.8 m |
| 1911 | Tomb Stone (L9) | (551.3, 919.8) | 70 m | 7 | yes, 9.5 m | 15.7 m |

- **How a nest picks a walker** [confirmed: `ai.ts` 154–160, `gameplay.ts` 521–523]: an idle aggressive mob takes a
  player within its sight range **and** within `leashRange` of its home (the nest centre), with
  `leashRange = max(tactics 50, radius + 10) = 80 m`; it roams anywhere within the 70 m radius. So the walker is safe
  only beyond **80 m** from the centre. Today the trail passes 53–54 m from both centres.
- **Fix [decision] *(fact-check F3: 25 m left the trail at 78–79 m, inside the 80 m gate)*:** move both centres
  **40 m north** (−z) with two `patch` rows (`{ id, x, z }`) in the repo's **`content/nests.override.json`** (layered
  before the GM files, `game.ts` 173–176), not through the GM tab's host-side file, so the change ships with the build
  and the route test sees it. The trail is then **93–94 m** from both centres, 13 m past the gate
  [confirmed: `route-town.json` against the shifted centres]. The new centres place on the nav and their 60 m spawn
  circles stay walkable and in the town's component [confirmed: `nestshift.ts`]. Count, level and zone stay the same,
  the tomb keeps its level-9 content, and the S1 beach (fishing's main spot) is fixed for every low-level visitor.
- The rest of the route crosses only passive level 1–5 nests (Mangyang, Big-Eyed Ghost, Water Ghost) [confirmed],
  which never attack first.
- **Seam:** the same patch is in the fishing spec's S1 needs. WAVE_PLAN9 names one owner (default: HS-E, §14).

### 2.5 The layout [decision; the numbers are the prototype's, §9]

| Pool | Centre (x, z) | Size (ellipse) | Surface | Depth | Use | Region / 32 m block |
|---|---|---|---|---|---|---|
| **Jade Pool** | (951, 1170) | 20 × 13 m, turned −9° | 57.25 m | 0.95 m centre, 0.4 m at the shore ledge | main soak, ≈ 20 seats | 172,90 / 173,90 (it crosses x = 960) |
| **Sea-view Pool** | (983, 1211); HS-E moves it ≈ 3 m south-east (§9.4 item 4) | 13 × 10 m, +14° | 55.35 m | 0.95 m | soak with the sea view, ≈ 10 seats | 173,90 |
| **Spring's Eye** | (963, 1155.5) | 6.4 × 5.2 m | 57.75 m | 0.7 m | the hot source: the most steam and bubbles; **nobody stands in it** (walk layer force-closed + its rocks) | 173,90 |
| Tea awning (`cj_resta01_tent`) and two tables | (929, 1173–1182) | – | ground | – | the attendant, the tables; FISHING's springs cooking spot beside it (one row, HS-E) *(fact-check F6)* | 172,90 |
| Pavilion (bpy, §3.4) | over the Jade Pool's north shore | 6 × 4 m roof | – | – | shade, the hero shot | 172,90 |

- **Capacity:** the Jade Pool's seat ring is ≈ 52 m around, so 20 bathers fit at 2.5 m spacing, plus ≈ 10 in the
  Sea-view Pool. **All 20 friends fit at once** [projected: perimeter arithmetic].
- **Constraint 1, the 2 m lattice** [confirmed: format.ts]. A basin is drawn by its lattice vertices. Pool edges are
  soft polygons with 2 m steps, so pools are 10 m or more across, and rocks along the rim hide the steps (the
  prototype's look, §9).
- **Constraint 2, one water level per 32 m block** [confirmed: arithmetic]. The Jade Pool's east part and the Eye
  share block (0,5) of region 173,90. That block's ground lies below 57.75 m over x 960–992 × z 1164–1184 (56.4–57.5
  m in the height table), so an editor water plane at the Eye's level would flood 600 m² of the shelf. At the Jade
  Pool's level it still floods the low ground east of the pool (56.4–57.1 m). **So the springs draw their own water
  surfaces** (§3.1): one level per pool, any shape, no flooding, and no editor water block.
- **Walking [decision]:**
  - The pools' floors stay open. The basin walls are ≤ 0.95 m over 2 m (slope ≤ 0.48) and the rims ≤ 1 m over 2 m,
    both under the nav rule's 0.7 [confirmed: rule in WORLD_EDITOR D40].
  - The pools are not editor water, so the "deeper than 1.2 m closes" rule never applies.
  - The Eye's tiles are force-closed in the walk layer.
  - The editor's Publish rebuilds the nav and runs its reachability checks. New probes: the three pools and the tea
    awning.
- **Swimming** never starts in a pool [decision]: the pools are ≤ 1.0 m deep, below SWIMMING's `SWIM_DEPTH_M = 1.2`
  (wade up to 1.2 m) *(fact-check F9)*. The swim check also ignores springs surfaces, which are not
  `water` blocks.
- **Fishing** is refused in the springs ("The hot water has no fish."): the fishing spec's water query sees no
  `water` block there, and its message names the springs zone (seam, §7.5).

---

## 3. The look

### 3.1 The water [decision]

- **Surfaces:** a triangle-fan polygon per pool, from `content/springs/jade-mist.json`. It is merged into **one mesh
  for the three pools**, drawn with the PBR water material of `world-render/src/water.ts`. That is the same
  material, plugins and shader as region water, so **no new shader variant**.
  - The vertex colours follow the region water's layout: depth (r, `encodeWaterDepth`), the calm wave type (g), and
    b = 1 for the profile.
  - **Seam S-WATER:** `WaterRenderer.addSurface(id, mesh data)` / `removeSurface(id)` (W11-S's file; one function
    each).
- **The `springs` profile:** `WATER_PROFILES = ['town', 'springs']`.
  - Values: colour ≈ linear (0.27, 0.57, 0.50) (milky jade), turbidity 0.55, reflection 0.55, so the floor is hidden
    and the bathers' lower bodies fade into the milky water.
  - The plugin keeps **one** profile uniform set. **The active profile follows the focus:** the town's within the
    town box, the springs' within the springs zone. The two are 2.2 km apart, never in one view: regions load within
    320 / 400 / 480 m (Low / Medium / High) and unload beyond 460–660 m [confirmed: `stream.ts` 59–63], so the town's
    water is never loaded while the springs are *(fact-check: the first draft cited the grass ring B's 255 m, which is
    not a view radius)*. So no shader change [decision]. A test checks that the swap happens on entering the zone and
    never inside the town box.
- **Ripples:**
  - 3 ripple points: the Eye's boil (radius 1.2 m, strength 0.8), the Jade Pool's inflow, and one slow ring per pool.
  - Each bather adds a faint ring every few seconds while moving in the water: nearest first, within the shared 8.
  - The town's points are out of range there.
- **One writer per water uniform** *(fact-check: a seam collision)*. Wave 11's town FX calls
  `WaterRenderer.setRipplePoints(pts)` **every frame, at any distance**, with a fixed 8-entry list (strength 0 out of
  range), so the define never flips [confirmed: `town/fx.ts` 441–457, 561–600]; a springs call would be overwritten
  the next frame. And `setProfile(null)` or a 0 ↔ some change of the point count flips `SRO_WATER_PROFILE` /
  `SRO_WATER_POINTS` and recompiles the water material [confirmed: `water-town-plugin.ts` 196–225]. So S-WATER is:
  - `setRipplePoints(source, list)` per source ('town', 'springs'); the renderer merges the sources nearest the focus
    first into its 8 slots and always passes 8 entries;
  - the active profile is chosen by the renderer from per-source profiles and the focus (the town's inside the town
    box, the springs' inside the springs zone), and is **never null** once one exists (the swap writes values only);
  - both defines are on in the warm-up's compile of the water material at world load, so a player who logs in at the
    springs (the overnight soak) compiles nothing on arrival; a test walks town → springs → town and counts zero
    `markAllDefinesAsDirty` calls.
- **Warm tint:** the warmth comes from the steam and the lamps, not from the water colour. A warm-orange water reads as
  dirty; the prototype's milky jade reads as hot-spring water [decision, §9 shots].

### 3.2 Steam [decision]

- **A new puff kind, `springSteam`, on its own unlit mesh** (seam S-PUFF: `town/fx.ts` exports its pure puff maths
  `puffAt` with a `PuffKind` parameter table that the springs extend, and its puff texture; nothing else in the town
  part changes).
  - The material is **unlit with a uniform colour**: the sky's ambient plus the sun's colour × 0.6, set once a second
    by the springs part, times the puff texture and the per-instance alpha. It is not wave 11's lit PBR puff material.
    The prototype measured that one at **+0.85–0.91 ms GPU** at the close-up with the same ≤ 2.6 m puffs (+1.2–1.7 ms
    at ≤ 4.2 m) and the unlit one at **+0.0–0.07 ms** (§9.3, §9.4 item 2) [confirmed by the author's WebGPU bench;
    WebGL2 [projected] the same order] *(fact-check F7)*.
  - One thin-instanced draw, only while the zone is within 90 m. One small shader, compiled at world load through a
    warm-up hook.
  - The parameters are the prototype's (size capped at 2.6 m after the measurement):

| Kind | Life | Rise | Drift | Size | Peak alpha | Per emitter |
|---|---|---|---|---|---|---|
| `steam` (wave 11, stalls) | 2.6 s | 0.45 m/s | 0.12 + 0.8 × wind | 0.16 → 0.8 m | 0.45 | 6 |
| **`springSteam`** (new) | 7.5 s | 0.30 m/s | 0.12 + 0.7 × wind | 0.9 → 2.6 m (√age) | 0.15 | 8 |

- **Emitters:** 9 over the Jade Pool, 6 over the Sea-view Pool, 5 over the Eye (the Eye's 1.25× denser and larger).
  That makes 20 emitters × 8 = **160 puffs**. The preset caps trim them nearest-first: **Medium ≤ 120, High 160, Ultra
  160, Low 0** [decision].
- **Weather and time:** `steamGain` is 1.0 at day, 1.25 at dawn and dusk (sun below 15°), 1.5 at night and in rain,
  and 0.7 in a wind above 8 m/s, when the steam tears away faster (drift × 1.5). It never draws when the zone is out
  of the 90 m FX range.
- **Night:** the uniform colour follows the sky (dark blue-grey at night), and puffs within 6 m of a lit lamp take a
  warm tint from it. That is a per-emitter colour set once a second, not per-pixel lighting.
- **Low (Classic):** no puffs (the Low guard). Low gets one retail effect instead: if the Hotan pool particle
  (`res/nature/particle/oas_hot_pool0{1,2}_*.bsr`, compounds `oas_hot_pool01/02.cpd` [confirmed: exist in the
  extracted Data]) reads as a glint or vapour, it is placed as an ambient model [unknown: not decoded; default: Low
  shows the dry basins, rocks and lamps only, HS28].

### 3.3 Rocks, lamps, paint, grass [decision; all World Editor layers, no new art]

- **Rocks:** `cj_graveyard_rock02` (2.8 m) along the rims, `cj_rich_stone01/02` (garden stones) at the seats, and
  `stone_field04` (3.7 m) and `stone_field02` (6.3 m) boulders behind the Eye and at the cliff foot. All are retail
  models in the export [confirmed: manifest]. They are sunk 0.4–1.8 m so they read as bedrock.
- **Lamps:** 7 `cj_field_lamp` stone lamps (the arrival path, the pools, the awning) and 8 more along the trail from
  the beach. Each carries the retail night glow and joins the night-light pick (Medium 8 lights) and the ground splat
  on every preset [confirmed: `ambient.json` 213].
- **Paint:** rock and pebble tiles on the basins and rims, and a gravel path from the saddle. These are tiles of the
  editor's palette (the 108 remastered tiles of TERRAIN_TEX), chosen in the editor.
- **Grass mask:** 0 inside the basins and on the paths (the editor's grass layer), so no grass grows through the
  water [decision; the prototype shows why: grass blades on a pool floor read through 16 % transparency].
- **Trees:** the shelf's existing pines and maples stay. The new species (wave 12) draw them. Two or three pines are
  added at the cliff foot as wave-12 carriers.

### 3.4 The pavilion: built by script, not Meshy [decision]

- **One small open pavilion** (≈ 6 × 4 m roof on four posts, curved Chinese eaves, retail roof-tile and wood
  textures) over the Jade Pool's north shore. It is **built by a bpy script** in Blender 5.2 headless, the TREES
  route.
  - It gives a hero silhouette, the shade a real onsen has, and a roof the rain can drum on.
  - The retail set has no pavilion of this kind [confirmed: `object.ifo` searched for pavilion, jeongja, gazebo,
    bath and shrine names].
- **Meshy is not planned** (0 credits). The wave-12 bake-off showed that the bpy route wins for stylised props that
  must use the retail texture style (WAVE_PLAN8 §0.3). **Contingency: ≤ 60 credits** (two image-to-3D jobs) only if
  the bpy pavilion fails the user's look check twice. Each job is logged in NIGHT_LOG. The balance is 1,840.
- **Budget:** ≤ 2,500 triangles, one material set (2 textures, retail-size), and a nav footprint (posts only;
  walkable under).

### 3.5 Life [decision; GRASS_LIFE kinds, no new draws]

- **Fireflies** at night: a habitat at the pools and the awning, 30–50 within 40 m (GRASS_LIFE's 60–120 elsewhere,
  fewer here so the lamps stay the light).
- **Dragonflies** over the pools by day: a habitat (they skip the Eye).
- **Butterflies:** the shelf's meadow.
- **Birds:** a perch list (the pavilion ridge, the awning, the big rocks), and a sparrow ground flock on the gravel.
- **A pair of white cranes:** the egret species (GRASS_LIFE §5.3) scaled 1.3×, standing at the Sea-view Pool's
  outflow at dawn, flushing when a player comes within 9 m.
- **Gulls** fly over from the coast's habitat (no change).
- **Cost:** all of these are client-only, from existing kinds (≤ 1 draw per kind when present).

### 3.6 Weather and the sky

- **Rain:** the pavilion and awning give shelter (WEATHER's `sroShelter` for perches). Rain rings on the pools come
  from the water material's existing rain chunk, and the steam thickens (×1.5).
- **Night:** the lamps, fireflies, steam lit by the lamps, and the stars over the sea. This is the hero time for
  friends hanging out after a session.
- **Golden hour:** the pools face south-west over the sea, so the late sun is low over the water.

---

## 4. The hangout

### 4.1 Soaking [decision]

- **Soak** = the existing `sit {on: true}` while the player stands **inside a soak pool**. That is the pool's
  polygon in x/z, with y between surface − 1.3 m and **surface − 0.3 m** (at least 0.3 m of water: the outer lip of
  the shore ledge is a plain sit) *(fact-check F2)*. It uses **no new request, no new posture value and no new
  message**.
  - Server and client read the same pools from the content file (§7.3).
  - The server's posture rules apply unchanged: sitting is refused while moving, acting or in combat; anything active
    stands the player up.
  - `/sit` and the sit key work as everywhere.
- **The clip, SOAK:** the player movement pack gains the kind **SOAK**.
  - Its keys are **wave 11's SIT_CHAIR** (hands on knees, a seat **0.537 m** above the feet, hip joints 0.61–0.63 m
    [confirmed: `town_keys.json` `seat`; the first draft said 0.45 m]), re-packed through the MV-A pipeline into
    `char/_anims/<skel>/movement.glb` for both skeletons (`europeman_skel` / `europewoman_skel` serve every Chinese
    model, MOVEMENT §1).
  - **The soak line** *(fact-check F2)*: with the feet on the floor, the seat would sit at surface − 0.41 m at the
    pool's 0.95 m centre but 0.14 m **above** the water on the 0.4 m shore ledge (an "invisible chair"). So the client
    draws every soaker with the seat at **surface − 0.45 m** (`soakSeatM` in the content file), whatever the floor
    under them: at the centre that lowers the body 4 cm, on the ledge 0.59 m, and the feet and shins pass into the
    basin floor, which hides them (terrain is opaque; the milky water hides the rest). The water line sits at the
    chest; the shoulders and head stay above it. It is a visual offset only (the server position is the floor, as
    for every entity), applied in the springs feature's clip pick with a 0.3 s ease on sit and stand.
  - A slow breathing layer and a head turn every 6–10 s are keyed on top (≤ 4 s loop, the MV-A checks).
  - Clients pick SOAK for a sitter inside a soak pool, and the retail SIT elsewhere.
- **SOAK_LEAN (optional, cut 2):** leaning back with the arms on the rim. A new keyed clip, picked for a soaker
  within 0.8 m of the rim, facing in.
- **In the water standing:** the walk and run clips play unchanged. The water hides the legs, so no wading clip is
  needed [decision].
- **Regeneration:** HP/MP regen pulses at **×3** while soaking (9 % per 2 s; the 5 s out-of-combat rule unchanged).
  Bathers recover from empty in ≈ 29 s instead of ≈ 73 s (5 s + 12 or 34 pulses of 2 s), a small comfort with no risk,
  since no monster is near. S-REGEN multiplies every provider's factor (soak 3 × a regen tea or dish 1.2 = 3.6)
  *(fact-check F6)*.
- **The Eye:** it is closed to walking. A click on it says "Too hot to bathe in. The attendant boils eggs in it."

### 4.2 Chat and presence [decision]

- **Chat bubbles in the springs zone:** they stay **8 s** (5 s elsewhere) and keep the **last 2 lines** stacked
  (client only: `ux-world.ts` reads the zone).
- **Zone name:** "Jade Mist Springs" fades in on entering (the zone banner), and the minimap title shows it. The
  regions keep their zone name "Jangan South Beach" outside the springs polygon.
- **Emotes:** an emote stands a soaker up (the existing rule). They sit back with one key. Upper-body emotes in the
  water need a layering system the game does not have; that is out of scope.
- **Soaking friends:** each other soaker in the same pool adds +25 % to the fill rate, up to +50 % (§5.2). The rested
  tooltip shows "Soaking with 2 friends: rest fills 50 % faster."

### 4.3 Sound [decision]

- **An area bed by polygon** (seam S-AREA: SOUND's area layers gain an override area when the listener is inside a
  springs zone, beside the zone-name lookup).
  - **Day:** `env/day_wind` loop at −6 dB; one-shots `day_bird01–05` every 15–40 s.
  - **Night:** `env/night_wind` loop; `night_insect01–03` every 10–30 s, `night_bird01–05` every 30–60 s (the
    JANGAN_TOWN row's timings, SOUND §5.10).
  - The coast's surf (`audio/coast.ts`) stays, far below.
- **Bubbling water:** a new synthesized loop `springs/bubble` (≈ 12 s, 64 kbps mono, ≈ 100 KB), made like wave 11's
  fountain loop (a low gurgle: band-passed noise bursts with random bubble pops). It plays as a World Editor sound
  zone (WE-R runtime) at each pool. The Eye is the loudest. ≤ 2 zone loops at once (the WE-R cap) [decision].
- **Music:** the field music fades to 35 % in the springs zone over 4 s.
- **Soak in and out:** a soft splash one-shot (the jump's `jump_land` pitched down and filtered: no new file) when a
  bather sits and stands in a pool.

### 4.4 The attendant [decision]

- **Bath Attendant Yunhua**, an authored NPC (`NPCX_` via the GM NPC editor's `add`) on the retail gisaeng model
  `NPC_CH_KISAENG3` [confirmed: the model exists, `npcs.json`], at the tea awning (929, 1176).
- **Greeting lines** use the wave-11 conditional lines (QUESTS §5.5):
  - day: "Welcome, traveller. The water is warm, and the tea is warmer.";
  - night: "Mind the steps, the lamps are low. Soak as long as you like.";
  - fully rested: "You already glow like a lantern. Come back tomorrow, the springs will wait."
- **Services:** shop and talk. The talk option explains rest in two sentences (i18n).

### 4.5 The tea shop [decision]

The `STORE_SPRINGS` shop:

| Item | Price | Effect | Notes |
|---|---|---|---|
| Jasmine Tea | 300 | HP/MP regeneration out of combat +20 %, 30 min | **doubled to 60 min if drunk while soaking** |
| Ginseng Tea | 300 | Max HP +3 %, 30 min | as above |
| Chrysanthemum Tea | 300 | Max MP +3 %, 30 min | as above |
| Return Scroll (`ITEM_ETC_SCROLL_RETURN_01`, retail) | 5,000 | to town | the retail item and price [confirmed: `items.json`] |

- **No EXP effect from any tea:** Rested is the springs' only EXP effect. *(fact-check F6)* It is not the wave's
  only one: FISHING's dishes give kill EXP +5 / +10 % in the same slot, combined once in S-REWARD as
  `base × (1 + meal) + rested(base)` (FISHING D20), so a dish never drains the pool faster.
- **No gold loop:** every authored tea sells back for at most 30 % of its price (the retail ratio: the return scroll
  is 5,000 / 1,500 [confirmed: `items.json`]); a rule of S-ITEMS' validator.
- **One refreshment slot:** a tea and a cooked dish from the fishing spec share it (the newest replaces). Small buffs
  never stack with each other [decision; seam S-BUFF, owner per WAVE_PLAN9].
- **Seams:**
  - The teas are **authored items** (codes `ITEM_SPR_TEA_JASMINE`, `..._GINSENG`, `..._CHRYS`).
  - `STORE_SPRINGS` is an **authored shop**.
  - Both formats are new and shared with the fishing spec (S-ITEMS, S-SHOP): WAVE_PLAN9 names one owner and one file
    each.
  - Icons: the retail herb and potion icons recoloured by script (no new art).

### 4.6 The intro quest (optional, cut 3) [decision]

- **"A Warm Welcome" (JG_S01), level 5+.** Herbalist Yangyun (`NPC_CH_POTION`) asks you to deliver a bundle of
  herbs to Yunhua at the springs.
- **Reward:** 3 Jasmine Teas, 500 EXP and 2,000 gold, plus the world-map marker (it is visible from the start anyway).
- **Engine:** QUESTS' `deliver` objective. The EXP is negligible against the 1,124,480 of the climb.
- It is the discoverability hook: the questline never sends players to the south-east.

---

## 5. Rested EXP: the rules

### 5.1 The pool [decision]

- **`rest`**: a per-character pool in **EXP**, persisted. It is shown on the EXP bar (§8.3).
- **Cap** = `capFrac(level) × expToNext(level)` with `capFrac` = **0.20 for every level 1–19** (a table in the content
  file, `rest.capFrac: [[1, 0.20]]`, so wave 14 can shape it by level band). *(fact-check F4: the first draft's 0.10
  nets 1.5–2.5 % once the trip is counted, §5.3.)*
- At the level cap (`expToNext` = 0) the cap is 20 % of the last level's EXP-to-next.
- **The bonus:**
  - When a kill share pays `e` EXP and `s` SP-EXP (after `EXP_RATE` / `SP_RATE`), the bonus is
    `b = min(rest, round(0.5 × e))` EXP, and `s × b / e` SP-EXP. Then `rest −= b`.
  - The pool drains by the EXP bonus.
  - **At the level cap,** where EXP is not kept, the bonus is `b = min(rest, round(0.5 × s))` on SP-EXP only, and
    `rest −= b`.
- **What gets the bonus:** every kill share that pays EXP: solo, party shares, and the unique's share, capped by the
  pool. **Not:** quest turn-ins, GM kills (they pay nothing), or anything without EXP.
- **What it means in play:** a full pool of P EXP boosts the next 2P of monster EXP, so the bar shows a shaded
  segment 3P long (§8.3). At level 15 (P = 19,388) on the recommended rates that is ≈ 26 min of frugal hunting or
  ≈ 6 min of potion-fed hunting [model: BALANCE §3 rates × 3: 89,028 and 414,003 EXP/h].
- **Below level 11 the pool is small in time:** a full pool saves ≤ 3 min of frugal hunting there (levels pass in
  minutes); the springs pay from level 11 on (5–36 min saved) [confirmed: arithmetic on the BALANCE tables]. Low
  levels come for the place and the friends.
- **Levelling up** keeps the pool as it is. The pool is never larger than the old cap, which is below the new one.
  **A level-curve change** (wave 14) clamps the pool to the new cap at login.

### 5.2 Filling it [decision]

| How | Rate | Notes |
|---|---|---|
| **Soaking, awake** | full pool in **15 min** (1/900 of the cap per second) | +25 % per other soaker in the same pool, max +50 % (10 min with 3 or more) |
| **Soaking, idle** (no input for 10 min) | the overnight rate | the soaker "dozes off"; the bubble shows "z"; any input wakes them |
| **Overnight**: logged out while soaking | full pool in **8 h** of real time offline (counted at the next login, up to 24 h) | the logout must happen while soaking; a disconnect counts as a logout |
| Anywhere else | 0 | |

- **The daily budget:** all filling together (soak, idle, overnight) adds **at most one full cap per springs day**.
  A springs day is a 20 h window from the first fill in it, persisted. After the window the budget resets.
  - "The springs have given you all they can today. Come back after HH:MM."
  - One cap per window means **at most 20 % of a level of bonus EXP per character per 20 h window**, whatever the
    rates *(fact-check F5)*: 1.2 caps per 24 h sustained, and at most two caps inside one 24 h span (one just before a
    window ends, one just after).
  - **Windows and the overnight credit:** a credit counted at login is split at the old window's end, and the part
    after it opens the next window **at the old window's end** (or at `rest_soak_at` when no window was open), never
    at the login time; so the result does not depend on when the player logs in [decision; a §6.5 test].
- **"Awake"** = any client request or chat line in the last 10 minutes (`Player.lastInputAt`, seam S-INPUT: set by
  `connection.ts` on every message except ping, pong and keep-alives).

### 5.3 The climb model: why 20 % and +50 % [model: `work/tmp/hot-springs/restsim.py`, `restsim2.py`]

The method:

- BALANCE §3's per-level tables (blade, shop gear; frugal and potion-fed EXP/h; quest EXP interleaved; 3 h of
  questline walking).
- Sessions of a fixed length. **Each session starts with a full pool** (the player slept in the pool since the last
  one; one session a day, so the daily budget allows it).
- The pool is spent at the hunting rate × 0.5.
- *(fact-check F4)* **The trip is charged** (`restsim2.py`, the same model and tables): every session pays ≈ 7.5 min
  that is not hunting (the walk to the springs to log out in the pool, ≈ 6.7 min from the plaza, and the return
  scroll's 30 s cast at the next login). The first draft (`restsim.py`) charged nothing, and its 10 % cap then netted
  only 1.5–2.5 % for the casual friend and **lost** 4–9 % for potion-fed play: the bonus did not pay for the walk.

Time to level 20, the speed-up from Rested at **20 % × +50 %**, net of the 7.5 min trip (gross, without the trip, in
brackets):

| Rates | Style | Base | 1 h a day | 1.5 h | 2 h | 4 h |
|---|---|---|---|---|---|---|
| **3 (recommended)** | frugal | 12.3 h | **9.2 %** (19.4) | **8.9 %** (16.2) | **8.6 %** (13.0) | 2.8 % (5.8) |
| **3 (recommended)** | potion-fed | 5.1 h | −5.8 % (6.2) | −4.8 % (2.9) | −3.5 % (3.9) | −2.8 % (2.7) |
| 1 (retail) | frugal | 31.0 h | 17.7 % (28.0) | 19.7 % (26.3) | 19.7 % (24.4) | 15.2 % (17.4) |
| 1 (retail) | potion-fed | 9.2 h | 3.5 % (13.7) | 4.4 % (11.4) | 2.9 % (8.2) | 2.3 % (5.8) |

The variants (rates 3, frugal, net of the 7.5 min trip; 1 h / 1.5 h / 2 h a day):

| Cap × bonus | Net speed-up | Verdict |
|---|---|---|
| 10 % × +50 % (the first draft) | 2.5 / 2.3 / 1.5 % | rejected: the trip eats the bonus; a friend who walks both ways (13.4 min) **loses** 5–7 % |
| 15 % × +50 % | 6.1 / 6.4 / 5.2 % | rejected: barely worth the walk |
| **20 % × +50 % (chosen)** | **9.2 / 8.9 / 8.6 %** | the casual friend gains about one evening over the climb, after paying for the walk |
| 25 % × +50 % | 10.0 / 10.8 / 10.3 % | rejected: little more for the walker, while a friend already at S1 (a 1.5 min trip) gains 14–19 % |
| 25 % × +100 % (WoW-like "double EXP") | – | rejected: used up in minutes when potion-fed, too strong for the S1 regular (gross 20.9 % at 1.5 h) |

With a shorter trip (the S1 fisher, 1.5 min) 20 % nets 12–17 %; walking both ways (13.4 min) nets −1…+4 %
[confirmed: `restsim2.py`]. A cheaper way home is Q2.

How to read it:

- **It favours the casual friend who hunts frugally.** A short session spends most of a full pool, so the 1–2 h/day
  player gains ≈ 9 % net, a 4 h session ≈ 3 %, and potion-fed play loses a little to the walk (for them the springs
  are a social stop). Nobody's climb breaks.
- **When soaking beats hunting** *(fact-check F5)*: a full pool saves ≤ 3 min of frugal hunting below level 11,
  5–13 min at 11–15 and 16–36 min at 16–19. So at levels 16–19 a 15 min online soak once a day is worth more than
  15 min of frugal hunting: that is the reward the user asked for, and the daily budget bounds it to one pool per
  20 h, so "AFK in the pool" earns nothing past it and a "soak, hunt, soak" loop is impossible. The overnight soak
  (logging out in the pool) is the efficient way, and costs no play time beyond the walk.
- **At rates 1 the effect is larger** (a slower climb has more daily sessions to boost). The friends' server runs
  rates 3 [likely], and wave 14's re-tune owns both knobs (§5.7).

### 5.4 Anti-AFK and abuse [decision; each is a server rule and a test]

| Abuse | Rule |
|---|---|
| A character left in the pool for hours | Idle after 10 min drops to the overnight rate. The daily budget caps everything. A full pool simply stops filling ("You are fully rested"). |
| An input bot keeping a soaker "awake" | Gains at most one cap a day, the same as an honest soaker. |
| Relogging, or a server restart, to reset the budget | `rest_day_start` / `rest_day_used` are persisted. A relog keeps the window. |
| Logging out in the pool for days | Overnight credit counts at most 24 h back and is bounded by the daily budget: at most one cap. |
| Changing the clock | The server's clock only (`Date.now()` on the server). The client sends no time. |
| Alts | Each character has its own pool and budget, which cannot be traded. Rest on an alt helps only that alt. |
| A party member parked in the springs | The bonus applies only to the owner's own kill share; party shares reach only members within `PARTY_SHARE_RANGE` 60 m of the kill [confirmed: `party.ts` 494, `protocol.ts` 1382] and no nest is within 200 m, so a soaker earns nothing from others' kills. |
| Combat soak (pulling a mob into the pool) | No nest within 200 m; a hit stands the soaker up (the posture rule); sitting is refused within 5 s of combat. |
| Standing on the rim but "in" the polygon | y must lie between surface − 1.3 and surface − 0.3 (`soakMinDepthM`): a player on a raised rim stone or the outer lip of the ledge is above it *(fact-check F2)*. |
| Teleporting into the pool (GM) | GMs are trusted. `/rest` is audited (§6.4). |
| Spam sit/stand to "re-enter" | The fill state is a per-player soak start time. Re-sitting does not reset anything, and the sit rate limit (2/s) stands. |
| The Rested bonus on a unique kill (451,200 EXP) | Capped by the pool: at most 20 % of a level. |

### 5.5 Edge cases [decision]

- **Death:** a dead player keeps the pool. A dead party member gets no kill share at all (`party.ts` 492), so no
  bonus either *(fact-check: the first draft said the shares still pay)*.
- **GM setlevel:** the pool is clamped to the new cap if it is above it. The daily budget is untouched.
- **A level-up while soaking:** the next fill second uses the new cap.
- **Rest fill and the cap's level:** each second adds `capFrac × expToNext(current level) / 900`, while the pool is
  below the current cap and the day's budget lasts.
- **The day's budget** is stored in basis points of "one full cap" (0–10,000), so it does not depend on the level the
  filling happened at.
- **Stats:** `rest` and `restToday` are in the full `stats` and in a `statsDelta` when they change. While soaking,
  the change is sent at most every 5 s (or at a whole-percent step).

### 5.6 Why not other designs [decision]

- **A rested pool anywhere you log out** (classic MMO inns): the user asked for the springs to be the place. One
  place gives friends a reason to meet there at the end of a session.
- **A time-limited buff** ("+50 % for 30 min"): it wastes itself while a player walks, chats or shops. The EXP pool
  pays exactly what it promises, whenever the player hunts.
- **Bigger, rarer pools** (a weekly 50 %): they reward planning, not relaxing. The daily small pool fits casual play.

### 5.7 Hooks for wave 14 (The Climb) [decision; none designed here]

- **All knobs are content data:** `rest.capFrac` (a per-level-band table), `bonusMul`, `soakFillS`,
  `overnightFillS`, `idleS`, `dayWindowS`, `dayFills`, `friendBoost`, `friendBoostMax`, `regenMul`. Wave 14 re-tunes
  numbers, not code.
- **`restEligible(mob)`:** a server hook (default: every mob that pays EXP). Wave 14 can exclude nemesis monsters,
  dungeon bosses or the storm Qilin with one predicate.
- **A curve change clamps the pool at login** (§5.1), so re-tuning `levels.json` cannot leave a pool above its cap.
- **`springs.zone` is exported as a sanctuary polygon** (`content/springs/*.json` `zone`). Wave 14's event spawner
  (the storm Qilin, nemesis wanderers) can read it as a no-spawn, no-path area: the springs stay a safe hangout in
  every event.
- **The climb model** (`restsim.py`) takes the per-level tables as input. Wave 14 re-runs it on its new curve and
  re-picks `capFrac`.

---

## 6. Server

### 6.1 The module [decision]

`apps/server/src/springs.ts`, a `GameplayModule` that handles no request. Registered after `posture`.

- **Data:** `SpringsSite[]` from the world export's `springs.json` (§7.3). Without the file the module is inert: no
  rest, no soak, the same bytes on the wire [test].
- `soakPoolAt(x, y, z)` → a pool or null (point in polygon, y window). This pure function lives in `@sro/shared`
  (`springs.ts`) and is shared with the client.
- **`tickPlayer(p, now)`, once per second per player** (cheap: a bounding box test first):
  - soaking = `posture.isSitting(p) && soakPoolAt(p.pos)`;
  - a soak start time and the count of soakers per pool;
  - the fill: rate × (1 + boost) × (awake ? 1 : the overnight factor), bounded by the cap and the day's budget;
  - regen ×3 through the regen pulse's multiplier hook (seam S-REGEN: the player pulse in `gameplay.ts` ≈ 1252–1255
    multiplies `REGEN.playerPct` by the product of the modules' per-player factors, default 1; `REGEN` in
    `formulas.ts` is a constant table and stays one *(fact-check: the pulse lives in `gameplay.ts`)*);
  - `statsDelta` every 5 s or on a whole-percent step;
  - toasts are client-side, from the stats.
- **Seam S-REWARD:** `Gameplay.mobDied` asks the modules for kill modifiers before `reward`, in the loop over the
  shares (`gameplay.ts` ≈ 1050, after `EXP_RATE` / `SP_RATE`). *(fact-check F6)* It is one list of modifiers for
  every module, not a springs-only call: the springs' `killBonus(p, e, s, mob, now)` → `{ rest, restSp }` computed on
  the rated base `e`, and FISHING's meal `round(meal × e)` on the EXP only; the share pays
  `e + meal + rest` (FISHING D20). The reward then carries `gain.rest`. One owner writes it (step 0).
- **Login:** `playerEntered`.
  1. If `rest_soak_at` is set, credit `min(now − rest_soak_at, 24 h)` at the overnight rate within the day's budget,
     then clear it.
  2. Clamp the pool to the cap.
  3. Send the full stats.
- **Logout:** `forget` / the save path. `rest_soak_at = now` if the player was soaking, else NULL. Saved with the
  position.
- **Saves:** the pool with `saveProgress` after every kill (the same statement, one more column). The fill state at
  most every 30 s while it changes, and at logout.

### 6.2 Persistence: migration 11 (or the next free number; WAVE_PLAN9 orders the wave's migrations) [decision]

*(fact-check F10)* UNDERWATER also claims migration 11 (`sea_claims`), and FISHING takes the one after this spec's.
WAVE_PLAN9 numbers the three; the statement below is written against "the next free number", and no test hard-codes
11 (the migration test steps from the wave's base version to `SCHEMA_VERSION`).

```sql
-- 11: hot springs rest (docs/HOT_SPRINGS.md §5, §6.2)
ALTER TABLE characters ADD COLUMN rest_exp INTEGER NOT NULL DEFAULT 0 CHECK (rest_exp >= 0);
ALTER TABLE characters ADD COLUMN rest_day_start INTEGER NOT NULL DEFAULT 0;      -- ms epoch; 0 = no window open
ALTER TABLE characters ADD COLUMN rest_day_used INTEGER NOT NULL DEFAULT 0
  CHECK (rest_day_used BETWEEN 0 AND 10000);                                        -- basis points of one full cap
ALTER TABLE characters ADD COLUMN rest_soak_at INTEGER;                             -- ms epoch of a logout while soaking
```

- Additive. Old rows read as an empty pool and a fresh day. The `migrate()` test builds the wave's base version and steps to `SCHEMA_VERSION`.
- **Back up the DB before the deploy**, as every migration wave does (DEPLOY.md).

### 6.3 Content on the server

- The server reads `springs.json` from the world export folder (`OUT_DIR/world/<world>/springs.json`, the
  manifest's `springs` entry), next to `nav.bin`. A missing file means inert.
- `validateSprings` (shared) runs at startup. An invalid file logs and disables the springs; it never stops the
  server.

### 6.4 GM [decision]

- **`/rest [name] [info | full | clear | set <percent> | day reset]`:** reads or sets a character's pool and day
  budget, with a `gm_audit` row and a reply naming the numbers.
- **`/tp jade-mist-springs`:** the GM place, from `manifest.places`.

### 6.5 Server tests (HS-S)

- **The pure rules** (`springs-rest.test.ts`):
  - the fill (15 min for a full cap; ×1.25, ×1.5 with friends; the idle switch at 10 min);
  - the cap per level, the day budget (one cap per 20 h, persisted across a relog), overnight (8 h = full;
    24 h back maximum; the budget bounds it);
  - the bonus (`min(rest, 0.5 e)`, SP-EXP proportional, SP only at the cap, quest EXP untouched, a GM kill pays
    nothing);
  - the clamp after a curve change;
  - the overnight credit split at a window's end, the next window opening there (not at login) *(fact-check F5)*;
  - the kill order with a meal: `e + round(meal × e) + rest`, the pool draining on `e` only (FISHING D20).
- **Soak geometry:** inside, outside, on the rim stone (y above the window), on the outer ledge with < 0.3 m of water
  (a plain sit), the Eye (not soakable).
- **The nests patch:** `route.ts` ported: no point of the town → springs and town → S1 routes within 85 m of an
  aggressive nest's home (the 80 m leash gate + 5 m) *(fact-check F3)*.
- **Integration on a real `startServer`** with a temp DATA_DIR and a fixture `springs.json`:
  - sit in the pool → rest grows → `statsDelta.rest`;
  - a hit → stands up → stops;
  - logout while soaking → login 8 h later (clock injected) → full;
  - the second day's fill refused until the window ends.
- **Migration:** the wave's base version → `SCHEMA_VERSION`, and `rest_*` defaults on old rows (no hard-coded 11).
- **Abuse,** one per row of §5.4.

---

## 7. Formats

### 7.1 Wire (`packages/shared/src/protocol.ts`; additive, protocol v1) [decision]

```ts
interface PlayerStats {   /* ...today's fields... */
  /** Wave 13 (HOT_SPRINGS §5): the Rested pool in EXP (0 = none). Absent (older servers) = 0. */
  rest?: number
  /** Wave 13: what is left of today's springs budget, basis points of one full pool (0..10000). */
  restToday?: number
}
export const PLAYER_STAT_OPTIONAL_KEYS = ['hwan', 'rest', 'restToday']
interface StatGain {      /* ...today's fields... */
  /** Wave 13: the Rested bonus inside `exp` (EXP; at the cap, inside `spExp`). */
  rest?: number
}
```

- Validators: `rest` and `restToday` are integers in `[0, 2^31)`, `restToday ≤ 10000`, and `StatGain.rest ≤ exp`
  (`validate.ts`).
- *(fact-check F1)* **The optional-key parser needs a per-key bound first.** Today `playerStats()` parses every key of
  `PLAYER_STAT_OPTIONAL_KEYS` with `int(o, k, 0, HWAN_MAX)` and `HWAN_MAX = 5` [confirmed: `validate.ts` 979,
  `protocol.ts` 1524], so `rest: 900` would throw and the whole `stats` / `statsDelta` would be rejected. S-STATS
  replaces the loop with a bound table (`PLAYER_STAT_OPTIONAL_BOUNDS = { hwan: [0, HWAN_MAX], rest: [0, 2^31 − 1],
  restToday: [0, 10000], ... }`), shared with SWIMMING's two keys; a validator test sends `rest` above 5.
- **No new message and no new request.** Soaking is `sit` (§4.1). The mock server (`apps/game/src/net/mock/`)
  gains the rest fields so the client UI can be built offline.
- **An old client on a new server** ignores the new keys [confirmed: `playerStats()` drops unknown keys and
  `statGain()` reads only `exp`, `spExp`, `from`, `quest`]. Server and client deploy together (WAVE_PLAN7 D32), and friends reload the page.

### 7.2 Server config

No new key. Every knob is in the content file (§5.7). `EXP_RATE` / `SP_RATE` apply before the bonus.

### 7.3 Content: `content/springs/jade-mist.json` (shared by the converter, the server and the client) [decision]

```jsonc
{
  "format": "sro-springs", "version": 1,
  "id": "jade-mist", "name": "Jade Mist Springs",
  "zone": [[880, 1140], [1010, 1140], [1015, 1240], [880, 1215]],         // sanctuary + ambience polygon (glTF x, z)
  "place": { "x": 940, "z": 1184 },                                        // GM tp + world-map label
  "pools": [
    { "id": "jade", "poly": [[...]], "surfaceM": 57.25, "floorM": 56.30, "soak": true },
    { "id": "sea",  "poly": [[...]], "surfaceM": 55.35, "floorM": 54.40, "soak": true },
    { "id": "eye",  "poly": [[...]], "surfaceM": 57.75, "floorM": 57.05, "soak": false, "hot": true }
  ],
  "profile": { "color": [0.27, 0.57, 0.50], "turbidity": 0.55, "reflection": 0.55 },
  "steam": { "kind": "springSteam", "perPool": { "jade": 9, "sea": 6, "eye": 5 }, "eyeWeight": 1.6 },
  "ripples": [{ "x": 963, "z": 1155.5, "radiusM": 1.2, "strength": 0.8 }],
  "sound": { "bed": "springs", "loops": [{ "cue": "springs.bubble", "x": 963, "z": 1155.5, "radiusM": 25 }] },
  "music": { "gain": 0.35 },
  "bubbles": { "ms": 8000, "lines": 2 },
  "life": { "fireflies": 40, "dragonflies": true, "cranes": { "x": 990, "z": 1222 } },
  "rest": {
    "capFrac": [[1, 0.20]], "bonusMul": 0.5, "soakFillS": 900, "overnightFillS": 28800, "overnightBackS": 86400,
    "idleS": 600, "dayWindowS": 72000, "dayFills": 1, "friendBoost": 0.25, "friendBoostMax": 0.5, "regenMul": 3,
    "statsEveryS": 5, "saveEveryS": 30, "soakMinDepthM": 0.3, "soakSeatM": 0.45
  }
}
```

- **Validator:** `validateSprings` in `packages/shared/src/springs.ts`.
  - Polygons are simple, have 3–64 points and lie inside the zone.
  - `floorM < surfaceM`, and `surfaceM − floorM ≤ 1.0` (the swim threshold's guard).
  - Every rate is positive, `capFrac` is sorted, and at least one pool is `soak`.
- **The pool polygons are generated** by the authoring lane from the carved basin: the waterline is the iso-line of
  the edited heights at `surfaceM`, simplified to ≤ 48 points (`work/tmp/hot-springs/` script → content). This keeps
  water, terrain and the soak test in agreement.

### 7.4 Manifest and export

- `manifest.springs?: string` (the file name in the world folder). The converter copies and validates
  `content/springs/*.json` into `work/out/world/<world>/springs.json` (one file holding the sites list).
- `manifest.places` gains `jade-mist-springs`.
- The pavilion glb is appended as a manifest model (the trees' precedent). The editor places it from its library.
- Old exports validate (the field is optional).

### 7.5 Seams shared with the other wave-13 specs (WAVE_PLAN9 names one owner each) [decision: the defaults below]

| Seam | What | Shared with | Default owner |
|---|---|---|---|
| S-ITEMS | authored items (codes, names, icons, price, `use`) in one content file + its validator + the export | fishing (fish, dishes, bait) | the fishing spec's items lane |
| S-SHOP | authored shops (`STORE_*`, tabs, items) given to authored NPCs | fishing (the tackle shop) | the same lane |
| S-BUFF | a "refreshment" buff slot: one food or drink buff at a time, a new `ItemUse` kind | fishing's cooking | the fishing spec's cooking lane |
| S-MOVES | movement pack kinds: SOAK (here), SWIM_* (swimming) in `export-moves.ts` | swimming | one MV lane for the wave |
| S-STATS | `PLAYER_STAT_OPTIONAL_KEYS`, `StatGain` additions | swimming (breath?), fishing | the wave's protocol seam agent |
| S-WATERQ | "is this water, how deep, which kind" for swim and fish checks: the springs surfaces answer `springs` and never swim or fish | swimming, fishing | the swimming spec's water lane |
| The S1 trail nest patch | §2.4 | fishing (S1 beach) | HS-E |
| Migration number | `rest_*` columns | any other wave-13 migration | WAVE_PLAN9 orders them |

---

## 8. Client

### 8.1 world-render: the springs part [decision]

`packages/world-render/src/springs/{index, surfaces, steam}.ts`: `World.springs` (PBR only; null on Classic, the Low
guard).

- **Surfaces:** builds the pools' merged surface from `springs.json` through S-WATER, sets the `springs` profile and
  the ripple points while the focus is in the zone (S-WATER's profile swap), and drops them outside 300 m.
- **Steam:** its own unlit thin-instanced puff mesh (S-PUFF's `puffAt` and texture), with `steamGain` and the
  uniform colour from the sky and the weather each second.
- **Life:** registers the habitats (fireflies, dragonflies, the crane pair, perches) with `World.life`.
- **Warm-up:** the water material is compiled for the region water, **with the town plugin's two defines on**
  (§3.1, *fact-check F15*: a login at the springs must not attach the plugin or flip a define on arrival). The unlit
  puff shader is registered with `warmup-hooks.ts` (H-lens: no compile on arrival).
- **Low (Classic):** nothing from this part. The editor's height, paint and placement layers still apply on Low
  (they are the map). Low players see the basins as dry hollows with the rocks and lamps [decision; seam test in the
  Low guard]. *(fact-check)* With no water drawn, Low skips the soak line (§4.1): a soaker sits on the basin floor
  with the retail SIT, never sunk into dry ground. Optional (cut 1): Low draws the same surfaces with its Classic
  water shader (and then the soak line applies).

### 8.2 apps/game: the springs feature [decision]

`apps/game/src/world/features/springs.ts`, registered in `features.ts`:

- **The clip choice:** a sitter whose position is in a soak pool plays SOAK (`soakPoolAt` from `@sro/shared`).
  Others' bathers are seen the same way, since the server sent their posture.
- **The soak line** *(fact-check F2)*: a soaker's model is drawn with SOAK's seat at `surface − soakSeatM` (0.45 m),
  a vertical visual offset eased over 0.3 s on sit and stand (§4.1); the name tag and the chat bubble follow the
  head.
- **Zone enter and leave:** the banner, the minimap title, the music gain, the bubble timing (`ux-world.ts` reads the
  feature's `inZone`), and the audio area override (S-AREA).
- **Toasts** (i18n `springs.*`, from the stats changes):
  - "You sink into the warm water. Rest builds while you soak.";
  - "You are fully rested.";
  - "The springs have given you all they can today. Come back after {time}.";
  - "You slept by the springs: Rested +{pct}%." (at login);
  - "Rested used up."
- **The Eye's click line**, and the attendant through the normal NPC dialog.

### 8.3 HUD: the rested segment [decision]

- **The EXP bar** shows a light-jade segment from the current EXP to `exp + 3 × rest` (capped at the bar's end), and
  a small steaming-cup icon at its left while `rest > 0`.
- **Tooltip:** "Rested: monsters give +50 % EXP for the next {3×rest} EXP ({rest} bonus left). The springs can still
  warm you for {min} min today."
- **The floating gain text** shows the bonus apart: "+180 EXP (+60 rested)".
- **Accessibility:** the segment uses a pattern (diagonal hatching) as well as colour.

### 8.4 Client tests (HS-G)

- **The clip pick:** in a pool → SOAK; on the rim or the ledge's outer lip → SIT; standing → the walk clips.
- **The soak line:** the seat at surface − 0.45 m on the 0.4 m ledge and at the 0.95 m centre (± 1 cm); the offset
  eases out on stand.
- **The zone:** bubbles 8 s and 2 lines inside, 5 s and 1 line outside.
- **The music gain** and its restore.
- **The EXP bar segment arithmetic** (incl. the cap, a level-up, `rest` absent = 0).
- **i18n:** every key in `en-springs.ts`.
- **Mock-server rest fields.**

---

## 9. The prototype

### 9.1 What was built [confirmed: `work/tmp/hot-springs/lab/`]

`springs-lab.ts` is a page in the viewer root (a private Vite on :5331, stopped afterwards), copied from the World
Editor prototype's set-up. It runs `loadWorld` (the real wave-10/11 world: PBR, streaming, batching, grass and life,
the ocean, the sky) at the site, WebGPU, Medium, 1920 × 1080, scaling 1, with a 60 Hz timer pump because the pane is
hidden. On top of that:

1. **The three basins carved into the live terrain heights** (the World Editor prototype's lattice functions: a bowl
   to 0.95 m with a 0.4 m ledge to the shore, and a rim 0.25–0.3 m above the water fading out over 0.45 radii). Normals
   are re-baked and the grass re-filled.
2. **Water discs** at each pool's own level. These are prototype-only, with their own `PBRMaterial` (milky jade, alpha
   0.84, roughness 0.07, a procedural normal map scrolling). Production uses the region water material with the
   `springs` profile (§3.1).
3. **The steam:** camera-facing thin instances with the `springSteam` kind of §3.2 (20 emitters, 160 puffs). It was
   first drawn with the **town's own lit puff material** (`createFxMaterials` from `town/fx.ts`, sizes to 4.2 m), then
   with an unlit test material (sizes to 2.6 m) once the bench showed the cost (§9.3).
4. **Retail props through `World.objects.load`** (the game's material path, region −1): rim rocks, boulders, 7 stone
   lamps, the tea awning and two tables.
5. **NPC stand-ins** (gisaeng and herbalist glbs with their idle): the attendant at the awning, and three
   "bathers" lowered to soak depth. **They are stand-ins: the SOAK clip is a lane (HS-A).**
6. **Warm point lights** at the lamps for the night shot. They are prototype-only: production uses the night-light
   container fed by the lamps' retail emitters.

### 9.2 Shots [confirmed: `work/tmp/hot-springs/lab/out/`]

![The prototype](../work/tmp/hot-springs/hs-prototype-sheet.png)

*`hs-prototype-sheet.png`: (1) the arrival from the west path at golden hour, with the Jade Pool under the cliff, the
awning, the tables, stone lamps, the Sea-view Pool on the spur and the sea at the right; (2) the Jade Pool by day;
(3) night; (4) the Jade Pool at night.* The single shots are `hs-01-arrive-golden.png`, `hs-02-jade-pool-day.png`,
`hs-03-eye-day.png`, `hs-04-arrive-night.png` and `hs-05-jade-pool-night.png`. The earlier tuning shots (`w-*`,
`hs-close-*`) are kept for the record.

### 9.3 Measurements

**Method** [confirmed]:

- WebGPU, Medium, 1920 × 1080, device pixel ratio 1, the GPU lock held (08:40–08:50 UTC).
- The CPU was at 18–30 %, almost all of it the app's own panes; no build and no other GPU job. *(fact-check F7,
  F14)* That is above the wave's "under ≈ 15 % for 30 s" rule, no `log.json` was written (the numbers below exist
  only here), and only WebGPU was benched; WebGL2 numbers in §10 are [projected]. The fact-check did not re-run it
  (the GPU lock was held by T12-A from 08:57Z); the LAB rows of §10.5 re-measure every view on both backends.
- The lab's `bench()` (`apps/viewer/src/world/lab-bench.ts`'s method):
  - the pump is paused;
  - 120 frames are rendered back to back, plus one GPU wait, 3 runs; **wall** is the minimum per frame (the pipelined
    cost, max of CPU and GPU);
  - **GPU** is the WebGPU main-pass timestamp, the median of 20 frames;
  - **draws** is the engine counter.
- These are bench frame costs, not p95. The LAB measures p95 (§10.5).

| View | Steam | Wall ms | GPU pass ms | Draws |
|---|---|---|---|---|
| Arrival (≈ 30 m), day | town PBR puff material, 160 puffs | 1.67 | 1.44 | 80 |
| Arrival, day | none | 1.36 | 1.11 | 79 |
| Arrival, day | PBR, 160, water hidden | 1.67 | 1.44 | 77 |
| **Arrival, day** | **unlit puff material, 160 puffs, ≤ 2.6 m** | **1.35** | **1.11** | 80 |
| Arrival, night | PBR, 160 | 1.69 | 1.44 | 80 |
| Overview (62 m), day | unlit, 160 / none | 1.68 / 1.67 | 1.44 / 1.44 | 56 |
| Sea-view Pool, day | unlit, 160 | 1.36 | 1.11 | 30 |
| **Jade Pool close-up (17 m, the worst overdraw)** | none | 1.50–1.52 | 1.25–1.31 | 59 |
| Jade Pool close-up | PBR, 160 puffs, ≤ 4.2 m | 2.55–2.57 | **2.43–3.02 (+1.2–1.7)** | 60 |
| Jade Pool close-up | PBR, 80 / 60 puffs, ≤ 4.2 m | 2.43 / 2.01 | 2.49 / 1.97 | 60 |
| Jade Pool close-up | PBR, 160 / 80 puffs, ≤ 2.6 m | 2.17 / 1.89 | 2.16 / 1.77 | 60 |
| **Jade Pool close-up** | **unlit, 160 puffs, ≤ 2.6 m** | **1.58** | **1.31 (+0.0–0.06)** | 60 |

*(fact-check F7)* Compare like with like: at ≤ 2.6 m the lit PBR material costs **+0.85–0.91 ms** (2.16 vs 1.25–1.31)
and the unlit one **+0.0–0.06 ms**; the +1.2–1.7 ms is lit **and** larger (≤ 4.2 m). The conclusion is the same.

### 9.4 What the prototype showed (each is a rule above)

1. **The place reads as a hot spring in the game's own look.** The bowl under the cliff, the sea beyond and the
   lamps are there with no new art except the water and the steam [confirmed: shots 1–4].
2. **The steam's cost is per-pixel PBR shading, not the puff count.** Close up, the wave-11 lit PBR puff material costs
   **+1.2–1.7 ms GPU** on the dev GPU for 160 puffs up to 4.2 m and **+0.85–0.91 ms** at the same 2.6 m, which is
   ≈ 8–19 ms on a base M1 (×9–11, WAVE_PLAN8 §5.2). That fails G6. The same 2.6 m quads in an unlit material with a
   uniform tint cost **+0.0–0.07 ms**.
   **So the springs steam is unlit and "uniform-lit"** [decision, §3.2]: the colour is the sky's ambient and sun
   colour, set once a second, times the puff texture and the instance alpha.
   - It is the springs part's own thin-instanced mesh: +1 draw in the zone only.
   - It reuses `town/fx.ts`'s puff maths and texture.
   - The size is capped at 2.6 m.
   - The same finding applies to wave 11's stall steam close up. That steam is small (≤ 0.8 m), so it is noted for the
     wave's perf lens, not changed here. *(fact-check)* Wave 11's lit `smoke` kind is the big one (0.6 → 3.6 m,
     18 per emitter [confirmed: `town/fx.ts` 102]); the same lens should time a chimney close-up.
3. **Grass and flowers grow through the pools** (shot 2: flower sprites on the water). The grass mask (§3.3) is
   required, not a nicety [confirmed].
4. **The 2 m lattice is coarse but hidden** by rim rocks and the milky water. The carve cut ≤ 1.0–1.9 m and filled
   ≤ 1.1 m [confirmed: the lab's `carveLog`: Jade 50 vertices lowered and 38 raised; Sea-view 29 and 9; Eye 6 and 4].
   The Sea-view Pool sits on a slightly higher spot than the census grid showed (a 1.88 m cut). **HS-E moves it ≈ 3 m
   south-east, to a cut of 1.2 m or less.**
5. **One rock model repeated reads as teeth** (`w-hero-t68.png`). Rims need mixed models, sunk 1.5–2.3 m, with varied
   yaw and the wave-12 placement scale (0.8–1.2).
6. **The prototype's own water material is too bright at night** (shot 4). It has no night handling. Production uses
   the region water material, which already follows the sky (§3.1).
7. **NPC glbs drew untextured** through the plain glTF loader (the game's actor path converts their materials), so
   the stand-ins wear a flat material. **They give the scale, not the look.** SOAK is a lane (HS-A).
8. **The water is cheap:** hiding the three water meshes changed nothing measurable (1.67 vs 1.67 ms; 3 draws).
9. *(fact-check, from the sheet)* **Two look risks the shots show.** (a) The prototype's water reads **swimming-pool
   cyan**, not milky jade (shots 2 and 4); the production profile (linear 0.27, 0.57, 0.50 ≈ sRGB 0.56, 0.78, 0.73)
   is paler and greener, and has not been seen in the game yet. (b) At night the unlit steam reads as **glowing
   pale-blue blobs** (shot 4): an unlit colour does not follow the scene's exposure the way lit terrain does. The night
   colour is therefore the sky ambient × the terrain's own night brightness (the value the terrain plugin already
   uses), warmed within 6 m of a lit lamp, and the LAB's night rows (§10.5) include a side-by-side with the town's
   night stall steam. Both are part of the user's look check (§12 item 1).

---

## 10. Budgets (WAVE_PLAN8 §5 format; 1080p)

### 10.1 What the springs add per preset

| Preset | Pools | Steam | Props and lamps | Life | Sound | Rest and HUD |
|---|---|---|---|---|---|---|
| Low (Classic) | dry basins (the map layers), no water | none | rocks, lamps (retail glow + night splat), awning, tables, pavilion | none (Low has no life) | the area bed and the bubble loop | everything (server-side) |
| **Medium (default)** | the springs surfaces on the region water material, the `springs` profile, ripples | unlit puffs **≤ 120**, ≤ 2.6 m, +1 draw in the zone | as Low, in the region batch; lamps in the 8-light pick | fireflies ≤ 40, dragonflies, perches, cranes | as Low | as Low |
| High | as Medium (+ SSR in rain only: High gates it on puddles > 0.1 [confirmed: `render/post.ts`]) | ≤ 160 | as Medium; 32 lights | as Medium | as Low | as Low |
| Ultra | as High (+ SSR always) | ≤ 160 | 64 lights | as High | as Low | as Low |

### 10.2 Frame p95 on the dev PC (WebGPU / WebGL2, ms)

Baselines are the **wave-11 rescue re-bench** (Dropbox `wave11/budgets.md`, 2026-10-02 01:45–03:05, p95, median of 3)
[confirmed]. The springs rows are projected from the prototype's bench (§9.3) and wave 11's measured character costs.

| Scene | Medium | High | Pass line |
|---|---|---|---|
| Every existing LAB scene (plaza, crowd, fields, meadow, the fights) | **unchanged**: the springs draw nothing beyond 300 m (the town is 2.2 km away), and the server rules cost no frame | unchanged | G1 / G2 as wave 11 |
| Beach (beach-south), 1.7 / 1.1 | ≈ 1.7–1.9 / 1.1–1.3 (the springs are 0.5 km away, outside the FX and life ranges; the pavilion and lamps may draw as far objects) [projected] | – | pass |
| **The springs, nobody there** (the arrival view) | **≈ 1.8–2.6 / ≈ 1.3–1.9** (bench 1.35–1.68 ms × a bench-to-p95 ratio of ≈ 1.3–1.5) [projected] | ≈ 3–4 [projected] | pass, far under |
| **The springs, 20 friends soaking** (G1's new thin scene) | **≈ 9–12 / ≈ 6.5–8.5** [projected: the springs ≈ 2–2.6, plus 20 characters ≈ +6.6 WebGPU / +4.2 WebGL2. That is the rescue's 20-player plaza (14.9 / 10.3) minus its 20-monster crowd (8.3 / 6.1, i.e. plaza noon 7.2 / 5.0 + the 20-mob share ≈ 1.1; the first draft kept the mob share in the WebGL2 figure, so its 6.5–8.5 is the conservative end); soaking characters are the same draws and skinning. The 20-player cost is CPU (G-11: CPU p95 15.8–16.6 against GPU 2.2 ms), and on G-11's slower day the same arithmetic gives ≈ 9.7–11.2: 16.8–17.7 − 9.1 + 2–2.6] | **≈ 12–15** *(fact-check F8; the first draft said 17–19)* [projected: the High 20-player plaza 19.4 − the High crowd 10.7 = 8.7 for 20 players, + the springs on High ≈ 3–4, + ≈ 1 of page-history spread] | **G1 < 16.7: pass with ≈ 5 ms spare; High also under 16.7** (High is gated only at the plaza and crowd, G2) |
| The springs at night, 20 friends | as above + ≤ 0.2 (fireflies; the 8-light pick already runs) | – | pass |

### 10.3 Draws, GPU, CPU, memory, download, server

| Preset | Draws added (the springs view) | GPU added (dev) | CPU | Laptop / M1 | VRAM | Download |
|---|---|---|---|---|---|---|
| Low | the props in the region batch (+0–3), the attendant (1 actor) | ≈ 0 | 0 | 0 | ≈ +1 MB (the pavilion) | ≈ +0.6 MB on the first visit |
| **Medium** | water 1 (merged pools; the prototype drew 3) + steam 1 + life ≤ 2 when present + the props ≈ **+6–10 in the zone, 0 elsewhere** | water ≈ 0 (not measurable); steam **+0.07 ms at the worst close-up** (unlit, 160) [confirmed: §9.3] | steam update ≤ 0.02 ms (160 puffs, pure maths) [projected]; the zone checks ≤ 0.01 ms | M1 GPU **≈ +0.7 ms at the close-up**, ≈ 0 at the arrival view [projected ×9–11]: G6 pass | **+2–4 MB** (pavilion ≤ 1 MB, the bubble loop decoded ≈ 2.3 MB of float PCM, surfaces < 0.1 MB) | **≈ +1.0 MB** on the first visit: pavilion 0.3–0.6, `springs/bubble` ≈ 0.1, `springs.json` 5 KB, two edited regions ≈ 0.3 (WORLD_EDITOR F23/F24) |
| High / Ultra | as Medium, steam ≤ 160 | as Medium | as Medium | – | as Medium | as Medium |
| Server | – | – | a µs-scale check per online player per second; one point-in-polygon per soaker per second | – | ≈ 0 | ≈ 0 on disk (5 KB + the migration's 4 columns) |
| Network | – | – | – | – | – | a `statsDelta` (≈ 60 B) every 5 s per soaker |

*(fact-check F12)* **Macs:** friends on Macs play on Medium (WAVE_PLAN8 F21), and a base M1 runs the beach view at
≈ 11–15 ms GPU [projected there]. The Sea-view Pool looks over the same sea; add the steam (+0.7) and 20 soaking
characters (their GPU share at the plaza is ≈ +0.16 ms on the dev GPU, ≈ +1.5 ms on an M1) and the springs come to
**≈ 13–17 ms on an M1** [projected], at the 16.7 line. No Mac was measured. The LAB row 2 view is the one to take to a
Mac when one is at hand; the levers, in order, are cut 10 (half the Medium puffs), the Mac's render scale (Medium on
an iGPU already starts below 1), and the ocean's own presets.

### 10.4 Per-lane budgets (dev PC, 1080p, the GPU lock for every in-browser timing)

| Lane | Budget |
|---|---|
| HS-W surfaces | 1 draw for all pools; no new water shader variant (`material-budgets.test.ts`); the profile swap ≤ 0.05 ms, only on a zone change |
| HS-W steam | ≤ +0.15 ms GPU at the Jade Pool close-up on WebGPU Medium; ≤ 0.02 ms CPU per frame; puffs ≤ the preset cap; 0 when the zone is out of range; its one small unlit shader compiled at world load (warm-up hook) |
| HS-W life | 0 new draw kinds; fireflies ≤ 40 in the zone |
| HS-S | the springs tick ≤ 20 µs per frame for 20 players (server); ≤ 1 DB write per 30 s per soaker; `killBonus` ≤ 5 µs |
| HS-G | the HUD segment redraws only on a stats change; no per-frame DOM write |
| HS-SND | ≤ 2 zone loops + the area bed (1 loop) + ≤ 1 one-shot at a time |
| HS-B pavilion | ≤ 2,500 triangles, ≤ 2 textures at retail size, ≤ 0.6 MB optimized |
| HS-E site | each touched region stays under the editor's guardrails (WORLD_EDITOR §7.2: object triangles warn at 60 k, placements 400, separate draws 12) |

### 10.5 LAB rows and gates (added to the wave's LAB and gate)

LAB scenes (the wave-11 / wave-12 method: the production bundle on a private preview, a private server on a temp DB
copy, 400 frames, p95, 3 runs, both backends, Medium first, then High):

1. The springs, the arrival view: noon, golden hour, night.
2. **The springs with 20 bots soaking** (the soak harness sits 20 bots in the two pools), noon and night. This is the
   new G1 scene.
3. The Jade Pool close-up, steam on and off: the G6 view.
4. Walking S1 → the springs: the hitch watchdog (no frame over 16.7 ms as the zone, the profile and the steam come in).

Gates:

- **G1:** Medium p95 < 16.7 ms on both backends in rows 1–2.
- **G4:** 0 WebGPU validation errors, no shader compile on arrival, the Low guard green, `material-budgets` green.
- **G6 (Mac margin):** the dev GPU p50 at the close-up grows by ≤ 0.15 ms with the steam on (the unlit material
  measured +0.07). A miss halves the Medium puffs (cut 10).
- **G-HS (rules):** the §6.5 tests and one play-through, all green. The play-through is: soak 15 min → full, hunt →
  bonus shown, logout in the pool → login 8 h later (clock injected) → no more than the day's budget.

---

## 11. Decisions (each the recommended option; the user delegated)

| # | Decision | Reason (one line) |
|---|---|---|
| HS1 | The site is the south-east ridge shelf (172–173,90), ≈ (955, 57, 1180) | The best-scoring quiet, high, walkable spot in the playable area; a cliff behind and the sea in front (§2.1) |
| HS2 | Reached on foot through the S1 link; no teleport | The walk is part of a destination; the town has no travel service, and adding one is out of scope (§13 Q2); the Rested size pays for the walk (§5.3) |
| HS3 | Nests 2060 and 1911 move **40 m** north (two `patch` rows in the repo's `content/nests.override.json`) | The only aggressive spot on the trail; 40 m puts the trail past the nests' 80 m leash gate (25 m did not, *fact-check F3*); one data edit also fixes the S1 beach for fishing (§2.4) |
| HS4 | Three pools: Jade (soak), Sea-view (soak), the Eye (hot, closed) | 30 seats hold all 20 friends; the Eye gives a source and the strongest steam without a "boiling" rule |
| HS5 | Basins, rims, paint, grass masks, props, lamps and the walk override are World Editor layers | Wave 12's tool for map changes; nav, Publish checks and baked shadows come for free |
| HS6 | The water is the springs' own surfaces on the region water material, not editor water blocks | One level per 32 m block would flood the sloping shelf (§2.5); the same material means no new shader |
| HS7 | A `springs` water profile; the one profile uniform follows the focus | Town and springs are 2.2 km apart, never in one view; zero shader change |
| HS8 | Pools ≤ 1.0 m deep; swimming and fishing never start there | Keeps walking open, keeps the soak test simple, and keeps the springs out of the swim and fish rules |
| HS9 | A new `springSteam` puff kind on its own unlit, sky-tinted mesh (≤ 120 / 160 puffs, ≤ 2.6 m, +1 draw in the zone) | Measured (WebGPU): lit PBR puffs cost +0.85–0.91 ms GPU close up at 2.6 m (+1.2–1.7 at 4.2 m; ≈ 8–19 ms on an M1); unlit +0.0–0.07 ms |
| HS10 | Stone lamps `cj_field_lamp` with their retail night glow | They light the night through the existing pick and splat, Low included |
| HS11 | A bpy-built pavilion, Meshy planned at 0 (≤ 60 contingency) | The retail set has none; bpy won the wave-12 bake-off for styled props |
| HS12 | Life from GRASS_LIFE kinds (fireflies, dragonflies, perches, a crane pair) | Atmosphere with no new draw kind |
| HS13 | Soak = `sit` inside a soak pool; no new request, posture or message | The posture rules already do everything soaking needs; server and client share the pool test |
| HS14 | SOAK clip = SIT_CHAIR keys in the player movement pack, drawn with the seat at surface − 0.45 m (a client offset); SOAK_LEAN optional | SIT_CHAIR's seat is 0.537 m above the feet, so on the 0.4 m ledge it would float above the water; one hip line per pool keeps the chest at the waterline everywhere *(fact-check F2)* |
| HS15 | Regen ×3 while soaking | A small comfort that suits a bath, with no combat effect |
| HS16 | Rested = an EXP pool: cap **20 %** of a level, +50 % kill EXP and SP-EXP, quest EXP untouched | Pays exactly what it promises, whenever the player hunts; quests keep their share; 20 % because 10 % did not pay for the walk *(fact-check F4)* |
| HS17 | Fill: 15 min soaking, +25 %/friend (max +50 %); overnight 8 h; idle = overnight rate | A 15-min chat fills it; friends together fill it faster; AFK earns no more than logging out |
| HS18 | At most one full pool per 20 h, persisted | Bounds the bonus to 20 % of a level per window (1.2 pools a day sustained) at any rate, and kills every loop |
| HS19 | Net of the ≈ 7.5 min trip: casual frugal 1–2 h/day climbs ≈ 9 % faster at rates 3; 4 h ≈ 3 %; potion-fed −3…−6 % (a social stop) | Helps casual friends most after paying for the walk, and leaves wave 14's climb intact (§5.3, `restsim2.py`) |
| HS20 | Every knob is content data; `restEligible`, the pool clamp and the sanctuary polygon are wave-14 hooks | Wave 14 re-tunes data, not code |
| HS21 | Wire: `PlayerStats.rest?`, `restToday?`, `StatGain.rest?`, with a per-key bound table for the optional keys | Optional keys, the `hwan` precedent; no new message; today's parser bounds every optional key by `HWAN_MAX` 5 *(fact-check F1)* |
| HS22 | Migration: four `characters` columns | The pool and the day budget must survive relogs and restarts |
| HS23 | `content/springs/jade-mist.json` copied into the export; `manifest.springs?` | One file read by the converter, the server and the client: no disagreement on where the water is |
| HS24 | Chat bubbles 8 s and 2 lines in the zone; music at 35 %; an area bed of retail `env/*` sounds plus a synthesized bubbling loop | A calm place to talk, made from what exists |
| HS25 | Bath Attendant Yunhua on a retail gisaeng model; three teas (300 g), return scrolls | A face for the place, small buffs, and the way home |
| HS26 | Teas share one refreshment slot with cooking; no EXP effect from any tea; kill EXP = `base × (1 + meal) + rested(base)` (FISHING D20) | Small buffs stay small; Rested is the springs' only EXP effect and a dish never drains it faster *(fact-check F6)* |
| HS27 | The intro quest JG_S01 (optional) | The questline never points south-east; one delivery makes the place known |
| HS28 | Low shows the basins, rocks and lamps (the map layers), not the water or the steam | The Low guard; the map stays consistent across presets |
| HS29 | GM `/rest` and the place `jade-mist-springs` | Testing the rules needs a way to set and read the pool, audited |
| HS30 | The springs' layers go into the main export at the wave-13 checkpoint, after wave 12's release and the user's own first map edits | Respects WAVE_PLAN8 D37 ("the first real map edit is the user's"); per-region layers merge |

---

## 12. Needs from the user

Nothing blocks the build. The defaults are used unless the user says otherwise:

1. **Look at the prototype shots** (§9.2) and say if the place feels right. *Default: build it as shown, with the
   paler jade water and the darker night steam of §9.4 item 9 (the prototype's cyan water and glowing night puffs are
   known misses).*
2. **After the build, soak once with a friend** (10 minutes): walk there from town, sit in the Jade Pool, watch the
   rested segment fill, hunt, and see "+… (rested)". *Default: the lead's own play test stands in until then.*
3. **The deploy OK for wave 13** (a migration, so a DB backup comes first). *Delegation is not a deploy OK.*

No download is needed. No Meshy credits are planned.

## 13. Open questions (each with the default used meanwhile)

| # | Question | Default |
|---|---|---|
| Q1 | Is 20 % of a level per day, at +50 %, the right size for the friends? (Wave 14 re-tunes anyway.) | 20 % × +50 %, one fill per 20 h (net ≈ 9 % sooner to 20 for a casual friend after the walk) |
| Q2 | Should the town get a paid "sedan chair" to the springs (one way, ≈ 1,000 gold), or the attendant a cheap ride home? It would cut the daily trip from ≈ 7.5 min to ≈ 2 and lift a casual friend's net gain from ≈ 9 % to ≈ 12–16 % (§5.3) | No: walk or ride (6.7 / 3.7 min), and a return scroll home; the 20 % cap already pays for the walk. A yes costs a new `NpcService`, a request and a warp (≈ 0.5–1 agent-day) |
| Q3 | Should logging out anywhere in town also give a little rest (for example a quarter rate)? | No: the springs are the place |
| Q4 | The name: "Jade Mist Springs" (玉雾温泉)? | Yes |
| Q5 | Should soaking also need the bather to be "dressed down" (armour hidden while soaking)? | No in v1. Equipment shows as worn (the water hides most of it); a cosmetic bath robe could come later |
| Q6 | Should the Eye scald a player who forces in (a GM, or a nav bug)? | No: it is closed to walking, and a click explains why |
| Q7 | Should Low draw the pools' water too (with its Classic water shader)? | No in v1: Low shows the dry basins, rocks and lamps (HS28); cut 1 is the optional Low water. The retail Hotan pool particles (`oas_hot_pool0{1,2}`) stay undecoded [unknown] |

## 14. Lanes

### 14.1 Step order (inside wave 13; WAVE_PLAN9 merges it with fishing, swimming and underwater)

```
step 0 (seams, with the wave's other seams):  HS-P (shared: springs.ts, protocol fields, validators)
                                             | the seam lines in other owners' files: S-WATER (water.ts), S-PUFF (town/fx.ts),
                                               S-REWARD + S-INPUT + S-REGEN (gameplay.ts, connection.ts), S-AREA (audio area)
step 1:  HS-S (server module, migration, GM) | HS-W (world-render springs part) | HS-A (SOAK clip, Blender) | HS-B (pavilion, Blender)
         | HS-SND (bubble loop, area row) | HS-E (authoring the site in the editor; nests patch; NPC; shop/items via S-ITEMS/S-SHOP)
step 2:  HS-G (game feature, HUD, toasts, i18n) | HS-Q (optional quest)
         ── the wave's convert + optimize checkpoint (the springs' regions, springs.json, the pavilion model) ──
step 3:  the wave's integration → LAB (§10.4) → hunt (lenses: §14.3) → fixers → gate → verify → the user's checks
```

### 14.2 The lanes

Effort is in agent-days (≈ ½ day per agent session).

| Lane | Owns (files) | Seams it uses | Tests | User check | Effort |
|---|---|---|---|---|---|
| **HS-P** shared | `packages/shared/src/springs.ts` (types, `validateSprings`, `soakPoolAt`, the pure rest maths: fill, cap, bonus, day budget, overnight, clamp); the `PlayerStats` / `StatGain` / `PLAYER_STAT_OPTIONAL_KEYS` lines and validators in `protocol.ts` / `validate.ts` (S-STATS, with the wave's protocol seam owner), **the per-key bound table that replaces the `HWAN_MAX` loop** (*fact-check F1*) | – | `springs-rest.test.ts` (every rule of §5 incl. the model's numbers on a fixture curve), `springs-geometry.test.ts`, validator rejects, a `stats` with `rest` above 5 parses | – | 1 |
| **HS-S** server | `apps/server/src/springs.ts` (module: tick, login and logout, `killBonus`, saves), migration 11 in `db.ts` (the statement and the `CharacterRow` fields only), `saveProgress` + `rest_exp`, `/rest` in `gm.ts` (one row), the mock server's rest fields | S-REWARD (the kill-modifier list in `gameplay.ts`, shared with FISHING, *F6*), S-INPUT (`connection.ts` sets `lastInputAt`), S-REGEN (the per-player factor in `gameplay.ts`'s regen pulse) | §6.5 in full (rules, geometry, the real-server integration, the migration from the wave's base version, one abuse test per §5.4 row) | `/rest info` | 2.5 |
| **HS-W** world-render | `packages/world-render/src/springs/**` (surfaces, steam emitters and gain, ripples, life habitats, `World.springs` slot) | S-WATER (`WaterRenderer.addSurface/removeSurface`, `WATER_PROFILES += 'springs'`, the focus profile swap, per-source ripple points and profiles with both defines kept on, *fact-check*), S-PUFF (`puffAt` with an extensible kind table, the puff texture export), `World.life.addHabitat` | define-off strings unchanged; no surface without `springs.json`; the profile swaps on entering, never in the town box; puffs ≤ the preset cap; Classic: `World.springs` null (Low guard) | night and day at the pools | 2 |
| **HS-A** SOAK clip | `content/moves/<skel>/soak.json` (+ `soak_lean.json` optional), the SOAK kind row in `export-moves.ts` (S-MOVES, the wave's MV owner) | the MV-A pipeline | the MV-A checks (control ≤ 0.1°, contacts, loop closes, ≤ 60 KB); the seat height within 2 cm of SIT_CHAIR's | the clip GIFs, man and woman | 1 |
| **HS-B** pavilion | `packages/convert/tools/blender/springs/pavilion.py`, the model's content entry (the trees' manifest-append path) | Blender 5.2 headless (bmesh) | ≤ 2,500 triangles, retail-size textures, a footprint (posts only), validator | a turntable sheet | 1 |
| **HS-SND** sound | `springs/bubble` loop (the wave-11 synth tool), the `springs.bubble` cue, the `springs` area row (day/night beds, one-shot timings) | S-AREA | the cue exists; area intervals; ≤ 2 zone loops | listen at the Eye at night | 0.5 |
| **HS-E** the site | the World Editor layers for regions 172,90 and 173,90 (heights, paint, grass masks, walk override, placements: rocks, lamps, awning, tables, pavilion, pines; probes), `content/springs/jade-mist.json` (polygons generated from the carved heights by a script), the nests patch (two `patch` rows moving 2060 and 1911 40 m north in `content/nests.override.json`, *fact-check F3*), the NPC `add`, the shop and teas through S-ITEMS / S-SHOP rows, FISHING's springs cooking-spot row by the awning (*F6*) | the editor (wave 12), the GM Spawns/NPC tabs, the fishing spec's item/shop formats | Publish passes (no traps, every probe reachable, guardrails); `validateSprings`; the route test (`route.ts` ported: the town → the springs ≤ 2.4 km, no route point within 85 m of an aggressive nest's home, i.e. outside the 80 m leash gate) | walk from town to the springs | 2 |
| **HS-G** game | `apps/game/src/world/features/springs.ts` (incl. the soak line: the seat at surface − 0.45 m, *fact-check F2*), the EXP bar segment and tooltip (`hud/`), toasts, `i18n/en-springs.ts`, the bubble timing hook in `ux-world.ts` (2 lines), the music gain | S-AREA, `soakPoolAt` | §8.4 | the 10-minute soak | 1.5 |
| **HS-Q** quest (optional) | the JG_S01 row in `content/quests/jangan.json` (via the quest editor) | QUESTS `deliver` | the quest validator; reachability of the giver and the target | – | 0.25 |
| **LAB-HS** | the springs rows in the wave's LAB (§10.4) | – | – | – | in the wave LAB |

**Total ≈ 11.75 agent-days** [projected: the sum].

### 14.3 Hunt lenses for the springs (added to the wave's hunt)

1. Can a player earn more than one cap per 20 h window by any order of soak, idle, logout, relog or restart (incl. an
   overnight credit that straddles a window's end)?
2. Does any path give Rested EXP to quest turn-ins, GM kills or another player's share?
3. Does any shader compile when the player first sees the pools or the steam (incl. a login at the springs, and the
   town FX's per-frame `setRipplePoints`)?
4. Does the town's water ever take the springs' profile (or the reverse)?
5. Is a soaker on the rim stones mis-detected as soaking?
6. Does walking stay open everywhere in the pools, and closed in the Eye?
7. Does the HUD segment overflow at the level cap or after a level-up?
8. Does Low show floating water, holes or steam anywhere?
9. *(fact-check)* Can a level-9 tomb mob pick a walker anywhere on the S1 trail after the nests patch?
10. *(fact-check)* Does any `stats` / `statsDelta` carrying `rest` or `restToday` fail to parse on the client?
11. *(fact-check)* Does a soaker on the shore ledge float (the seat above the water) or sink to the neck at the centre?

## 15. Scope-cut order (cut from the top) and never-cut

1. The optional Low surfaces (Classic water on the pools).
2. SOAK_LEAN (SOAK only).
3. The intro quest JG_S01.
4. The crane pair and the bird perches (fireflies and dragonflies stay).
5. The pavilion (rocks and the awning remain the dressing).
6. The friend boost (+25 %/friend): one fill rate.
7. The tea shop: the attendant sells return scrolls only, and the teas wait for S-ITEMS / S-SHOP.
8. The attendant NPC (a signpost explains the springs).
9. The bubbling loop (the area bed only).
10. Steam on Medium halved (60 puffs), only on a G6 miss.

**Never cut:** the place on the real map with its three pools and their water, the steam on Medium and up, soaking,
the server-side persisted Rested pool with its cap, daily budget and anti-AFK rule, the HUD's rested segment, the
trail fix (HS3), and the gates of §10.5.

## 16. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Wave 12's editor slips or changes its layer format | HS-E cannot author the site | HS-E writes the same layer files with a script (the prototype's carve maths) through the editor's validators; the converter pass is the same |
| The S1 link changes in a coast re-convert | The springs become unreachable | HS-E's route test runs at every checkpoint; the editor's probes include the springs |
| The water profile swap shows on the town's water at a boundary | Wrong colour at the pond | A test pins the swap to the zone polygons (2.2 km apart) |
| SIT_CHAIR's pose in the pool reads as "sitting on air" (its seat is 0.537 m up, *fact-check F2*), worst on the 0.4 m ledge where the profile's turbidity is still fading in (`PROFILE_SHORE_M` 0.6) | Odd look | The soak line (the seat at surface − 0.45 m everywhere, §4.1) and the 0.3 m soak minimum; turbidity 0.55 hides the rest; SOAK_LEAN is the fallback pose |
| Players find 6.7 min too far, or the daily 5,000-gold scroll too dear | The springs stay empty; Rested nets ≈ 0 for anyone who walks both ways (§5.3) | The overnight soak makes one trip per session enough; the 20 % cap pays for a 7.5 min trip. Q2's sedan chair is **not** one line: it needs a new `NpcService` value, a request and a server warp (≈ 0.5–1 agent-day) *(fact-check)* |
| The rates on the live server differ from 3 | The speed-up differs (≈ 18–20 % net at rates 1, frugal) | The table in §5.3 covers rates 1; wave 14 owns the knob |
| Steam overdraw on an M1 at the close view | GPU time on Macs (the springs ≈ 13–17 ms on an M1, *F12*) | G6 measures it; cut 10 |
| The water reads cyan or the night steam glows (shots 2 and 4) | The place looks like a swimming pool / blue blobs | §9.4 item 9: the paler jade profile, night steam at the terrain's night brightness; the LAB night rows and the user's look check |
| Another wave-13 spec picks a different shape for authored items, shops or buffs | The teas wait | Cut 7 keeps the springs whole without them |
| A nest patch row is lost in a content merge, or the tomb nests are re-tuned in wave 14 | Level-9 aggro on the S1 trail again | The route test (§6.5: no route point within 85 m of an aggressive home) runs at every checkpoint *(fact-check F3)* |
| A new optional `PlayerStats` key lands without the bound table | Every `stats` with `rest > 5` fails to parse: no HUD updates at all | S-STATS lands the bound table first, with a test sending `rest` above 5 *(fact-check F1)* |

## Appendix: scratch files (`work/tmp/hot-springs/`)

| File | What |
|---|---|
| `census.py` | per-region heights, nest load, open nav, distance |
| `site.ts`, `sites.json`, `site2.py` | the 8 m candidate scan on the server nav and its ranking |
| `route.ts`, `route-town.json` | the grid route search on `nav.walk` legs (town → springs, S1 → springs) |
| `flood.ts` | the 2 m flood fill that showed the shelf connects (the 6 m grid missed the S1 link) |
| `mapcrop.py`, `routemap.py`, `local.ts`, `local.py` | the minimap crops, the route map, the 2 m height and nav table |
| `restsim.py` | the climb model of §5.3 |
| `lab/` | the prototype: `vite.config.mjs` (:5331), `springs-lab.ts`, `out/` (shots; no `log.json` was written, *fact-check F14*) |
| `restsim2.py` | *(fact-check F4)* the climb model with the trip charged per session, and the cap variants of §5.3 |
| `nestshift.ts` | *(fact-check F3)* the shifted nest centres on the server nav (placement and spawn-circle walkability) |
