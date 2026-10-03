# Fishing and cooking (FISHING)

**Status:** design for wave 13 (2026-10-02). Nothing under `packages/`, `apps/`, `content/` or `deploy/` was edited (the
wave-12 build owns them while this is written). The prototypes live in `work/tmp/fishing/`. WAVE_PLAN9 merges this spec
with SWIMMING, UNDERWATER and HOT_SPRINGS; where WAVE_PLAN9 decides differently, the plan wins.

**Fact-check (2026-10-02, adversarial pass).** Every [confirmed] claim was re-derived; the scripts are in
`work/tmp/fishing/factcheck/` (`windows.mts`, `humans.mjs`, `easy_fix.mjs`, `legend.mjs`, `s1pier.mts`,
`s1shore.mts`, `jetties.mts`, `grid.mts`, `grid44.mts`, `placements.mts`). What changed, each marked *(fact-check)* where
it lands: the strike window no longer leaks the fish's class at the cast (§4.2); the "casual" player model was the
"hold" model in disguise, so a real attentive-player table replaces it (§4.5); "Easy timing" as first written made the
legendary *harder* and is re-tuned (§4.6); Golden Grain becomes a groundbait, because one grain per cast made the
legendary cost ≈ 70 Golden Koi (§3.3, §5.4); the pity arithmetic, the twilight/rain window, the full-moon nights and
rain are now measured (§5.3, §5.4); the daily cap counts casts, not catches (a bot could cut every common line and
never reach it), and spot fatigue is personal (a group of friends on the pier fished it out in ≈ 4 minutes) (§8.4);
the S1 pier starts on dry sand and is ≈ 62 m long, and its end is ≈ 1.6 m deep, not "the deep spot" (§2.2); S-DECK
cannot use the World Editor's uid range (the wave-12 registry throws) (§2.2); the water grid's 3-bit body channel
could not hold 9 values (§8.5); "the town box" would have closed the nearest moat spots (§2.1); the retail jetties are
9, not 6 (§1); seams with SWIMMING (swim/breath dishes, pier ladders and piles) and UNDERWATER (shared species ids,
the Rusty Bronze Key, the Jade Tortoise window, kelp and urchin) were missing (§5, §7.2, §15.3); rods cast no shadows
(High has 3 cascades, and the crowd budget limits characters' cascades); the clip pack is ≈ 220 KB per skeleton, not
160; an M1 at the 20-angler pier will not hold 60 fps (§11.2).

The user's words, verbatim:

> Fishing off the beaches and the pier with rare catches and cooking for small buffs.

The same wave adds swimming ("Swimming in the sea, with a swim animation"), underwater scenery and life, and the hot
springs (their own specs). Wave 14, *The Climb*, re-tunes levels 1–20, adds the Qin-Shi Tomb dungeon, nemesis monsters
and a storm Qilin: this spec leaves hooks for it (§10.4) and designs none of it.

**The user delegated every decision.** Wherever there is a choice, this spec takes the option it would mark
"(Recommended)" and writes it as a decision with a one-line reason (§12). Only what truly needs the user is in §13 and
§14, each with the default used meanwhile.

**Tags** (as in WAVE_PLAN8):

- **[confirmed]**: checked in the code or data of the working tree on 2026-10-02, or measured by this spec's prototypes.
  Each one says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived), not measured on that setup.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this spec makes. The user may overrule it.

**Repo state when this was written [confirmed: `git log`, `git status`, 2026-10-02 ≈ 04:00].** HEAD `cb65112` (the
wave-11 G1 rescue); waves 10 + 11 are live (PROJECT_STATUS 04:05); wave 12 is building in another workflow.
HOT_SPRINGS.md is written and names three seams this spec owns (S-ITEMS, S-SHOP, S-BUFF, §15.3).

---

## 0. Summary

1. **Where:** eight fishing waters, all found by a survey of the live export and its navmesh, not by hand
   [confirmed: `work/tmp/fishing/spots/survey.mts`, every 4 m point of the playable area that the town can walk to,
   with dry feet or a wade ≤ 0.5 m, and water ≥ 1.2 m deep 6–12 m away]. The Jangan **moat** is 99 m from the town gate,
   the **river** west of town 494 m, the **swamp** pools, the field **ponds**, the **ferry basin** with the retail
   **Jangan Ferry pier** (walkable and reachable today), the **tomb moat**, **Jangan Bay** and the sea at **S1 South
   Beach**. Map: `work/tmp/fishing/out/fishing_spots_map.png`.
2. **The pier:** the retail Jangan Ferry pier is fishable as it is. **A new S1 pier** (≈ 62 × 4 m, wooden, our own
   Blender model, from the dry sand at z ≈ 1274 to z ≈ 1336) goes out from the South Beach. It needs one new converter
   seam, **S-DECK** (an authored walkable deck in the navmesh), because the retail jetties are fenced on every side
   [confirmed: all 9 `cj_ferry_private01/02` decks are their own nav component that neither reaches nor is reached by
   the town's, and no walk off them ends in the town's component, `factcheck/jetties.mts`].
3. **The rod is a new prop, not a retexture** [decision]: three Blender-built rods (Bamboo, Willow, Black Lacquer),
   ≤ 200 triangles each, held in the right hand on the weapon's socket while the weapon is hidden. Retail has no rod,
   reel or line [confirmed: no fishing item, icon or model in `itemdata*.txt` or `icon/item/etc`].
4. **The catch mini-game** (prototype, playable: `work/tmp/fishing/minigame/index.html`): click the water to cast, wait
   through the nibbles, strike when the float plunges (a ring shrinks over a 0.80 s window, the same for every fish so
   the cast reveals nothing *(fact-check)*), then **hold to reel, let go on a run** while a tension gauge at the
   casting-bar spot shows slack, working, heavy and snap zones. Six fight classes, three rods, ten fishing levels.
   Holding the button lands small and medium fish; strong fish and up punish a held button and need the rhythm: an
   attentive player who lets go on the warnings lands 93–96 % of strong and 87–92 % of heavy fish, a button-holder 0–16 % and 0 %
   [confirmed: `tune.mjs` and `factcheck/humans.mjs`, 400 fights per row, §4.5].
5. **Server authority without lag:** the server rolls the catch, the bite timing and the fight seed; the client plays
   the fight locally and sends only the steps at which the button changed; the server **re-runs the fight** from its
   seed and refuses any outcome it cannot reproduce [confirmed: every prototype fight's replay was identical; a replay
   costs 17–20 ns per step, ≤ 0.1 ms for the longest fight: `bench.mjs`]. The simulation uses only `+ − × /`, so
   Chrome, Safari and Node agree to the bit [likely: ECMAScript fixes the basic operations to IEEE 754; §4.4].
6. **What bites:** 19 species by water, time of day, weather, moon and bait (the sea fish share their ids with
   UNDERWATER's schools); junk; three treasure boxes; UNDERWATER's Rusty Bronze Key; **24 messages in bottles** (a
   cosmetic easter egg with a collection); and **one legendary, the Dragon Gate Carp** (river and ferry basin, Golden
   Grain groundbait scattered, fishing level 7; best at dawn or dusk in the rain). Expect ≈ 3 h of eligible fishing per
   bite at ordinary hours (≈ 1 h if every cast fell in the twilight-rain window, which is only ≈ 25 real minutes a
   day), then a 50–75 s fight that a good player wins 22–51 % of the time with the best rod (63–72 % with Easy
   timing) [projected: `factcheck/legend.mjs`, `humans.mjs`, `easy_fix.mjs`] (§5).
7. **Fishing level 1–10** from fishing XP only (≈ 50 min to level 4, ≈ 4.6 h to 7, ≈ 12.5 h to 10 [projected]):
   it unlocks rods, baits and the legendary, and gives small reel and line bonuses. **Fishing gives no character EXP
   or SP** [decision: the climb's arithmetic stays where BALANCE and HOT_SPRINGS put it, and AFK fishing cannot level].
8. **Animations, keyed headless in Blender on both skeletons through the moves pipeline:** FISH_IDLE, FISH_CAST,
   FISH_STRIKE, FISH_REEL, FISH_LETGO, FISH_CATCH, FISH_FAIL, COOK, EAT (§6). **Prototype:** one keyed cast/reel clip
   on the male skeleton, 6 s, 181 frames, feet planted within 0.01 mm, hands on the rod within 2.4 cm
   [confirmed: `key_fish.py` run], GIF `work/tmp/fishing/out/fish_cast_reel.gif`.
9. **Cooking:** 12 dishes and one bait recipe at a stove in town, the six gate braziers, campfires at both piers, the
   hot springs and a portable Campfire Kit. Dishes give **one small timed buff in the shared refreshment slot**
   (HOT_SPRINGS' teas use the same slot): out-of-combat regeneration +20/+35 %, move speed +5 %, kill EXP +5/+10 %,
   abnormal-state resistance +10/+20 %, max HP/MP +2–3 %, defence +3 %, and SWIMMING's hooks: swim speed +10 %, dive
   breath +30 % *(fact-check)*. No dish changes damage, attack speed or
   in-combat healing, so combat is never trivialised (§7, §10).
10. **No gold farm:** ≈ 1,450 gold per hour of fishing against 6,000–12,000 for frugal grinding at rate 1; ≈ 2,300
    against 18,000–36,000 at the recommended `GOLD_RATE` 3 (fish are vendor sales, which no rate multiplies)
    [projected, §10.1]; every dish sells for less than its ingredients; personal spot fatigue, a daily soft cap on
    casts and an idle rule bound bots (§8.4).
11. **Cost:** **+4 draws** however many people fish (rods, lines and floats are each one instanced draw, the water
    rings one more; +1 per species being held up at a catch for 1.5 s; rods cast no shadows), ≤ 0.1 ms CPU with 20
    lines, nothing on any frame where nobody fishes (the Low guard). Download ≈ +0.6–1.0 MB, lazily, the first time you
    or someone near you fishes (§11).
12. **What the user must do:** nothing blocks the start. Look at the GIF and play the prototype page (§13). Optionally
    write some of the bottle letters. No download, **0 Meshy credits** for this design and 0 planned for the build.

### 0.1 Where each request lands

| Request (verbatim fragment) | Where | Lanes |
|---|---|---|
| "Fishing off the beaches" | §2.1: S1 South Beach, Jangan Bay, the river mouth; plus the moat, river, swamp, ponds, tomb moat | FS-W, FS-C |
| "and the pier" | §2.2: the retail Jangan Ferry pier (as is) and a new S1 pier (S-DECK) | FS-D |
| "rare catches" | §5.4–§5.7: the legendary, three treasures, 24 bottle letters, four rare fish, trophy sizes, records | FS-C, FS-S |
| "cooking for small buffs" | §7: stations, recipes, the refreshment slot (S-BUFF) | FS-K, FS-S |
| (task) the rod, the cast, a skill-based catch mini-game readable on a laptop and a Mac | §3.2, §4 | FS-A, FS-G, FS-P |
| (task) species by place, time of day, weather and bait | §5.2–§5.3 | FS-C, FS-P |
| (task) fishing skill/level | §5.8 | FS-S |
| (task) cast, wait, reel, catch, fail on both skeletons | §6 | FS-A |
| (task) server rules, anti-bot, inventory, no gold exploit | §8 | FS-S |
| (task) the UI in the retail 2009 kit, the sounds | §9.2, §9.4 | FS-G, FS-SND |
| (task) balance against BALANCE, hooks for wave 14 | §10 | FS-S, FS-C |

### 0.2 The prototypes [confirmed: each run 2026-10-02]

| What | Files | Result |
|---|---|---|
| Where can a player fish? | `spots/survey.mts` (the server's own `MeshNav` on `work/out/world/jangan-fields`, the coast field, the manifest's water planes), `spots/map.py`, `spots/jetty.mts`, `spots/jetty2.mts` | 9,636 fishable 4 m points by water; distances; the reachable ferry pier; the fenced jetties. `out/fishing_spots_map.png` |
| The catch mini-game | `minigame/sim.js` (the pure simulation), `minigame/index.html` (playable), `minigame/tune.mjs` (four player models × 18 rows × 400 fights), `minigame/bench.mjs` (the replay's cost), `minigame/serve.py` | playable at any frame rate; every replay identical; catch-rate table §4.5; `out/minigame_states.png` |
| One keyed cast/reel clip | `blender/key_fish.py` (extends the repo's town keyer, read-only), `blender/keys/fish_cast_reel.json` | 181 frames on `europeman_skel`; `out/fish_cast_reel.gif`, `out/fish_cast_reel_filmstrip.png` |

![The cast and reel, keyed in Blender](../work/tmp/fishing/out/fish_cast_reel_filmstrip.png)

---

## 1. What exists today [confirmed unless tagged]

| Topic | What is there | How checked |
|---|---|---|
| Water | Sea level +5 m (COAST). The sea is wherever the coast field's R channel says so (`coast/field.png`, 4 m/texel; G = distance to shore, B = depth). Retail rivers, the lake and ponds are 32 m water planes per region block (`manifest.regions[].blocks[].water.heightM`): +5 m for rivers, the swamp and the ferry basin; −2 m for the Jangan moat; −3.3 … −0.3 m for the town's ponds | `probe.mts` (field orientation), `survey.mts` |
| Walking in water | Retail walks river beds under water (NAVIGATION §2). WORLD_EDITOR D30: new water deeper than 1.2 m closes walking until swimming exists; SWIMMING changes deep water to "swim" this wave | WORLD_EDITOR §4.8 |
| Piers | `cj_ferry01` (the Jangan Ferry, 92 × 54 m) has a walkable deck in the town's component. **Nine** `cj_ferry_private01/02` jetties *(fact-check: the first count said six)*: three on the river 500–550 m west of the town gate ((−455, −28), (−412, −255), (−407, −237)), two at x ≈ −1,390 ((−1379, −213), (−1403, −199)) and four by the ferry; they have deck navmeshes (8–11 cells) but are **closed on every side**: each deck is its own component, unreachable from and to the town's | `jetty.mts`, `jetty2.mts`; re-run `factcheck/jetties.mts` (all 9 placements of the manifest) |
| Bridges | `cj_bridge_btree`, `cj_stoneb_alpha` (river), `cj2_brg_*` (moat), `cj_pal_south_brid*` (palace ponds) are walkable and over water: natural fishing spots | `survey.mts` (cells on objects) |
| Items | 678 items in `work/out/data/items.json`; **no fish, bait, rod or food** anywhere in `itemdata*.txt`. Retail event icons that fit dishes and catches exist: `e060125_ricedumplingsoup`, `e060209_{white,pink}_dumpling`, `e050918_{ricedrink,songpyon}`, `e050715_icedvermicelli_*`, `e050618_treasurebox`, `etc_box_*`, `etc_key_*`, `etc_letter_yellow`, `material_bottle`, `etc_net_yellow`, `etc_scale_{blue,silver}`, `etc_crabskin_orange`, `e051003_{garlic,mugwort}`, `e060411_egg`, `etc_seed_shine` | grep over itemdata, `ls Media/icon/item/etc` (1,070 files) |
| Authored content | `Provenance` already has `'authored'`; quest items (`QITEM_*`) and authored NPCs (`NPCX_*`) exist; **no authored item or shop file** (HOT_SPRINGS §2.3 found the same) | `packages/shared/src/content.ts`, `quests.ts` |
| NPCs | 46 Jangan NPCs. Shops: smith, armour, stable, accessory (`Grocery Trader Jinjin`, tabs Accessory / Goods / Alchemy), potion. Two ferry ticket sellers (Doji, Chau) | `npcs.json`, `shops.json` |
| Buffs | `EffectTable` (skills): buffs replace by overlap class or group; `EffectState` carries a skill code. Stat mods include `speedPct`, `maxHp`, `maxMp`, `physDefencePct`, `magDefencePct`, `statusResistPct`; modules add mods through `SkillEngine.addModProvider` (the mount uses it) | `skills/effects.ts`, `skills/mods.ts`, `mounts.ts` |
| Regeneration | 3 % of max HP/MP per 2 s pulse, after 5 s out of combat (`formulas.ts REGEN`). HOT_SPRINGS adds a per-player multiplier (S-REGEN) | `formulas.ts` |
| Kill EXP | `Gameplay.mobDied` → `killExp` × `EXP_RATE`; HOT_SPRINGS adds S-REWARD (`killBonus`) before `reward` | `gameplay.ts`, HOT_SPRINGS §6 |
| Quests | Objectives `kill`, `collect`, `talk`, `deliver`, `have`, `reach`, `useItem`; `have`/`deliver` work on any item in the bag | `quests.ts` |
| Clock and weather | 120 real minutes per game day, night ×0.4 faster; one global weather schedule `clear / cloudy / overcast / rain / storm / fog` (zone climates only tint the client); `moonState(days)` gives the moon's lit fraction. At `WEATHER_RAIN_SCALE` 1 and seed 1: rain 10.5 %, storm 1.3 %, fog 3.3 % of the time [confirmed: `factcheck/windows.mts`, a year of the shared `WeatherSchedule` sampled every 30 s] | `world-clock.ts`, `weather.ts`, `config.ts W9_DEFAULTS` |
| Animation tooling | `key_moves.py` (the jump), `key_town.py` (town loops with a socket prop: the broom). The town keyer only makes **loops** (cyclic Catmull-Rom). Both skeletons, both packs, `blenderExe` | `packages/convert/tools/blender/**` |
| Sounds | Retail candidates: `common/batbowswing*` (a cast whoosh), `player/mv{walk,run}water` (splashes), `env/dd_bobble_01/02` (bubbles, out of today's scope), `firework/campfire.wav` (out of scope), `ui/itembreak` (a snap), `ui/itfly_box`, `ui/itfly_rarebox`, `common/obj_boxopen` *(fact-check: not `ui/`)*, `ui/itscroll`, `ui/itpotiondrink`, `ui/eventcomplete`, `ui/gacha_win`. No reel click or line whine: synthesized offline like the town's (`town-synth.ts`) | `ls Data/prim/snd/**` |
| Town cooking | "No cook smoke" in town today; TOWN_LIFE added smoke on chimneys and steam over food stalls, and a `pot` prop (`models/town/props/pot@s130.glb`); six `cj_enter_fire` braziers stand at the west, north and east gates | TOWN_LIFE §1, §5.2; manifest placements |

---

## 2. Where to fish

### 2.1 The waters [confirmed: `survey.mts`, `map.py`; distances are straight lines from the town gate (96.9, −136.9)]

| Water (`body`) | Fishable 4 m points | Nearest | Depth in reach (median / p90) | Character |
|---|---|---|---|---|
| **Jangan moat** (`moat`) | 2,065 | 99 m | 2.3 / 2.4 m | Outside the walls, all round the town; bridges at every gate. The beginners' water |
| **Field ponds** (`pond`) | 774 | 323 m | 2.0 / 12.2 m | Eight ponds in the grassland, Lake Forest and the Chinese Tomb fields |
| **Swamp pools** (`swamp`) | 3,518 | 461 m | 1.8 / 7.2 m | North of town: dead trees, mud, night fish |
| **The river** (`river`) | 1,170 | 494 m | 3.6 / 6.9 m | West of town, north to south; two walkable bridges; the legendary's home |
| **Ferry basin** (`ferry`) | 1,054 | 787 m (the pier ≈ 2.0 km) | 3.8 / 8.0 m | The big +5 m water west: brackish, deep; the retail Jangan Ferry pier |
| **Tomb moat** (`tomb`) | 364 | 1,029 m | 3.0 / 3.5 m | North-east, at the Qin-Shi tomb's entrance: eerie, night and fog |
| **Jangan Bay** (`bay`) | 17 | 1,046 m | 3.6 / 7.1 m | A short stretch of the north sea shore |
| **The sea** (`sea`) | 333 | 1,347 m | 2.0 / 10.7 m | S1 South Beach and the south river mouth; the new S1 pier |
| *Town ponds* | *341* | — | — | *Inside the walls: closed ("The guards frown on fishing in the palace gardens.") [decision: the town is the hangout, not a fishing hole]* |

![Where to fish](../work/tmp/fishing/out/fishing_spots_map.png)

- **The rule, as the server applies it** [decision]: the cast's target is water of a fishing body, ≥ 1.0 m deep, 4–16 m
  from the angler (horizontal), and the angler stands on ground or a deck, or wades ≤ 0.5 m. Not while swimming,
  mounted, dead, stunned, trading, stalling, or casting a skill; never into the `town` body (the palace ponds) or the
  hot springs' pools (their surfaces answer `springs`, HOT_SPRINGS §7.5). *(fact-check)* The closure is by **body**,
  not by the port's `safeArea` town box (centre (82.7, −198.8), half extents 256 × 178.7 m, DATA §353): that box holds
  281 of the 2,065 moat points, among them the nearest one (99 m from the gate, by Ahn's bridge) [confirmed:
  `shore.json` against the box]. Fishing inside the no-combat box is fine; only the Campfire Kit uses the box.
- **Depth matters:** a target ≥ 4 m deep raises the strong and heavy fish ×1.3 [decision: casting to the deep water is
  a positioning skill]. *(fact-check)* The deep spots are the river, the ferry basin (its pier) and the swamp and pond
  holes; **S1 has none**: the sea is 1.6 m deep at the S1 pier's end and 1.9 m at the bounds line [confirmed: coast
  field + nav terrain, `factcheck/s1pier.mts`]. The pier's draw at S1 is the walk out, the sunset and the company.
- **The water query (S-WATERQ, owned by SWIMMING's water lane):** "is this point water, which kind, how deep". Fishing
  adds one channel, the **body** id of the table above, from a small rules file `content/fishing/bodies.json` (the town
  box, the class rules of `map.py` turned into rectangles and region lists, and any override). Client and server read
  the same baked grid (§8.5), so the cursor never promises a cast the server refuses.

### 2.2 The piers

| Pier | State | Plan |
|---|---|---|
| **Jangan Ferry pier** (`cj_ferry01`, (−1904, 8, 16), region 158,97) | Walkable deck, in the town's component, 66 fishable points on the deck [confirmed] | Fish from it as it is. A campfire cook spot at its foot (§7.1) |
| **River jetties** (`cj_ferry_private01/02`, (−455, 6, −28), (−412, 6, −255) and (−407, 4, −237)) | Deck navmesh, fenced on all sides [confirmed: `jetty2.mts`, `factcheck/jetties.mts`] | Open the landward outline edge of each through S-DECK's edge patch [decision; cut 3]. Which outline edge faces the bank is [unknown] until FS-D reads the instance; if none does, they stay scenery |
| **S1 pier (new)** | — | *(fact-check: was ≈ 36 m from z ≈ 1300, but z 1300 is already 0.4–0.5 m under water: the deck would start in the sea, on a tile today's knee-deep rule closes, with a 1.3–1.5 m pop up from the bed)* **≈ 62 × 4 m from the dry sand at z ≈ 1274 to z ≈ 1336 near x ≈ 470**: the landward end rests on the sand ≈ 0.8 m above sea level (the sand is +0.76 m at z 1274; the waterline is at z ≈ 1287), 8 m inside the bounds line z = 1344, **≈ 1.6 m of water at the end** [confirmed: `factcheck/s1shore.mts`, `s1pier.mts`]; planks, posts, a rope rail, a bench and a lantern at the end. **Our own Blender model** (≤ 1,600 triangles, the town props' painted-texture method; a tiling plank strip keeps the longer deck cheap) and an **authored deck navmesh** (S-DECK) [decision] |

**S-DECK** (lane FS-D, a converter seam): today every walkable object comes from a retail `.bms`. S-DECK adds
**authored nav models**: a deck is a list of convex cells (the plank rectangles) with outline edges, where the landward
edge is open (flag 0: the walker steps from the beach onto the deck and back) and the others block (the rail). The
converter appends the model and its instance to `nav.bin`, `nav-objects.bin` and the region's nav chunk. *(fact-check)*
**Not with an editor uid:** wave 12's S-UID registry (`packages/convert/src/world/uids.ts`) makes any non-editor source
that lands in 0xE000–0xEFFF an error, and a nav instance id is `regionId << 16 | uid`, so the uid must be 16-bit. S-DECK
takes a new source **`content` = 0xF000–0xF0FF**, carved out of the coast's reserved, unused 0xF000–0xFFFF (step 0
adds the row and its disjointness test; WAVE_PLAN9 may pick another free 16-bit band). The editor can still move the
pier: a move keeps its key, as for retail objects. The same seam carries an **edge patch** list (`{region, uid, edge,
flag}`) for the river jetties. *(fact-check: SWIMMING §5.5 and §12.1 ask the pier for two more things)* the deck model
also lists its **piles as solids** (SWIMMING's `insideSolid` keeps a swimmer out of them; the swimmer passes under the
deck), and `piers.json` places the pier's **ladders** as SWIMMING `exits` rows (`content/swim/swim.json`), one at the
end and one at each side 20 m out. Tests: walk on and off; reached from the town; no trap; the deck's height equals the
model's planks within 2 cm; the landward edge meets the sand within 5 cm (the nav has no step limit, so a gap would be
a visible pop, NAVIGATION §5.4); a swimmer cannot enter a pile; the S1 Publish check of WORLD_EDITOR passes.

- Why not a retail jetty at S1: the retail decks are fenced (above), and a terrain causeway would show an earth ridge
  under the planks.
- Why not the World Editor's placements: D37 of WAVE_PLAN8 keeps the editor's layers for the user's own edits; the pier
  is content, placed by `content/fishing/piers.json` through the converter, and the editor can still move it.

### 2.3 Spots and the hangout

The piers, the moat bridges and the S1 beach are where friends will sit and chat. Spot fatigue is personal (§8.4), so a
group fishing side by side never fishes a spot out for each other *(fact-check)*. Each pier end gets a bench (`SIT` on
it uses the town's SIT_CHAIR clip) and a lantern (a night-light point), and S1 gets a campfire spot (§7.1). HOT_SPRINGS'
Jade Mist Springs are 0.5 km from the S1 beach (HOT_SPRINGS §1): the S1 outing (fish, cook, soak) is one trip.

**S1's trail** crosses two aggressive level-8/9 nest rings; HOT_SPRINGS' nests patch (moving nests 2060 and 1911 25 m
north) fixes it for both specs [confirmed there: `route.ts`]. Owner HS-E; fishing depends on it.

---

## 3. Gear and items

### 3.1 The authored item format (S-ITEMS, owned by lane FS-I) [decision]

- **One content file per feature:** `content/items/fishing.json` (this spec) and `content/items/springs.json`
  (HOT_SPRINGS), each a `ContentFile<ItemDef>` with `provenance: 'authored'`. Codes are CodeName-style and may not
  collide with retail: fishing uses `ITEM_FSH_*` (fish, gear, junk, treasure), `ITEM_ING_*` (ingredients) and
  `ITEM_FOOD_*` (dishes); the springs use `ITEM_SPR_*`; UNDERWATER's reserved `ITEM_ETC_SEA_*` codes (the Rusty Bronze
  Key, Kelp, Sea Urchin, pearls) go in `content/items/sea.json` through the same merge *(fact-check: UNDERWATER §2.2)*.
- **Merged by the converter's data export** into `work/out/data/items.json` (one line in `data/items.ts` calling the
  new `data/authored.ts`), so the server and the client read one file, as today [likely: `hud/items.ts` and the server
  both load `/out/data/items.json`]. A collision with a retail code, a missing icon or a price that sells above its buy
  price is a converter error.
- **Additive `ItemDef` fields:** `category` gains `'fish' | 'food' | 'ingredient' | 'tool'` (retail categories unchanged);
  `use.meal?: string` (a dish: its refreshment row, §7.3), `use.campfire?: true` (the kit), `tool?: { kind: 'rod';
  rod: 'bamboo' | 'willow' | 'lacquer'; level: number }`, `bait?: { id; level }`, `fish?: { species }`.
- **Icons:** dishes and treasures reuse retail event icons by path (§1). Fish, rods, bait and ingredients get new 32 × 32
  icons rendered by Blender from the same meshes the game shows (the fish of §6.6), in the retail icon style (a soft
  dark frame, 2× rendered and downsampled) [decision: no new art tool, consistent with the 3D].
- **Authored shops (S-SHOP, same lane):** `content/shops/fishing.json`: `STORE_FSH_TACKLE` (rods, bait, the Campfire Kit)
  and `STORE_FSH_KITCHEN` (ingredients), given to two authored NPCs (§3.4). The format: `{id, npcs, tabs:[{name, items}]}`
  as the retail `shops.json`; merged the same way.

### 3.2 Rods [decision]

| Rod | Code | Fishing level | Price | Line strength | Reel (m/s) | Length | Look |
|---|---|---|---|---|---|---|---|
| Bamboo Rod | `ITEM_FSH_ROD_BAMBOO` | 1 | 300 | 1.00 | 1.25 | 2.4 m | natural bamboo, cord wraps |
| Willow Rod | `ITEM_FSH_ROD_WILLOW` | 4 | 3,000 | 1.07 | 1.35 | 2.7 m | dark willow, a brass ferrule |
| Black Lacquer Rod | `ITEM_FSH_ROD_LACQUER` | 7 | 15,000 | 1.14 | 1.45 | 3.0 m | black lacquer, red silk wraps, a jade butt cap |

- **A tool in the bag, not equipment** [decision]: double-click it (or its hotbar slot) to take it up: the character's
  weapon and shield hide (the skills' Hide Weapon rule, EFFECTS #5) and the rod appears in the right hand on the
  weapon socket. Reason: no gear swap before or after fishing, and a fight interrupts fishing cleanly.
- **The models** are bmesh in Blender (FS-A's `props.py`): a tapered shaft in 6-sided segments, a small side reel (a
  short cylinder with a crank), guides as tiny rings, ≤ 200 triangles each, one shared 128² painted atlas. The rod's
  **bend** is a vertex shader parameter (a quadratic bend toward the line, the prototype's curve, §6.3), so a hooked
  fish bends it without a skeleton.
- Prices sit between the degree-2 and degree-3 weapons (BALANCE §5.3: 1,000–17,000), a meaningful but small purchase
  at the recommended `GOLD_RATE` 3.

### 3.3 Bait [decision]

| Bait | Code | Price | Fishing level | Favours |
|---|---|---|---|---|
| (none: a bare hook) | — | — | 1 | small fish and junk only (junk ×3), bites 1.5× slower |
| Earthworm | `ITEM_FSH_BAIT_WORM` | 2 | 1 | freshwater fish, catfish |
| Dough Ball | `ITEM_FSH_BAIT_DOUGH` | 2 | 1 | the carps, the Golden Koi |
| River Shrimp | `ITEM_FSH_BAIT_SHRIMP` | 3 | 1 | sea fish, mandarin fish, sea bass |
| Glowworm Lure | `ITEM_FSH_BAIT_GLOW` | 8 | 3 | night fish (catfish, hairtail, snakehead, the eel) |
| Golden Grain (groundbait) | `ITEM_FSH_BAIT_GOLDEN` | cooked, not sold | 7 | scattered, not hooked: 10 minutes of legendary eligibility and rare fish ×1.5 for the scatterer's casts within 20 m of the scatter point |

One hook bait per cast, taken when the cast is accepted; stacks of 200 (Golden Grain 20). The bait is chosen in the
fishing window's bait slot (§9.2), defaulting to the last used.

**Golden Grain is a groundbait** *(fact-check)*. As first written it was a hook bait eaten by every cast, and every
eligible cast needed one. A bite needs ≈ 340 eligible casts on average (§5.4), so one bite cost ≈ 340 grains, or
≈ 68 Golden Koi at 5 grains a Koi. A Koi is ≈ 2.5 % of daytime moat catches, ≈ 2.7 an hour, so that was ≈ 25 h of
Koi fishing per bite. Now a grain is **used** from the bag in stance (a 1 s throw, golden flecks on the water drawn by
the rings draw, +0 draws). For 10 minutes the scatterer's own casts within 20 m of the point are legendary-eligible,
on top of the hook bait they use. Rare fish are ×1.5 there too. A new scatter replaces the old one. A bite then costs
≈ 19 grains (≈ 4 Koi, ≈ 1.5 h of daytime moat fishing). The server keeps `{x, z, until}` per player; it is not saved.

### 3.4 Two authored NPCs [decision]

- **Old Fisherman Ahn** (`NPCX_FISHER`, on a retail old-man model; which base codes the NPC editor's `add` accepts is
  [unknown], the default is the event grandfather of TOWN_LIFE §3.1): on the south moat bridge, ≈ 120 m from the spawn.
  Sells the tackle shop, gives the fishing quests (§7.6), shows the server's records board.
- **Cook Mei** (`NPCX_COOK`): at the town stove (§7.1). Sells the kitchen shop, gives the cooking quest.
- Both are NPC-editor rows (`npcs.override.json`), placed by lane FS-C, with English greeting and flavour lines in the
  quest file's NPC block (QUESTS §5.5).

### 3.5 The item list (content/items/fishing.json) [decision; prices in gold]

| Group | Items | Stack | Sell | Trade |
|---|---|---|---|---|
| Rods (3) | §3.2 | 1 | 40 % of price | yes |
| Bait (5) | §3.3 | 200 / 20 | 1 (Golden Grain 0) | yes |
| Fish (19) | §5.2 | 50 | §5.2 (trophies ×2 at the moment of the catch: a separate `…_TROPHY` code) | yes, except the Dragon Gate Carp |
| Junk (3) | Old Boot, Driftwood, Rusty Coin | 50 | 1 / 1 / 5 | yes |
| Ingredients (12) | Salt 8, Rice 10, Ginger 10, Scallion 8, Chili 12, Vinegar 10, Sugar 12, Sesame Oil 20, Flour 10 (vendor); Waterweed, River Snail, Mud Crab (caught); Wild Mushroom, Wild Herbs (monster drops, §7.4) | 50 | 40 % of price (caught: 2) | yes |
| Dishes (12) + Golden Grain | §7.2 | 20 | ≤ 80 % of the ingredients' sell value | yes (the Feast: no) |
| Treasure (3) | Sunken Coffer, Silted Strongbox, Tomb Offering Box | 10 | 0 (open it) | yes |
| UNDERWATER's key | the Rusty Bronze Key (`ITEM_ETC_SEA_BRONZE_KEY`, defined in `content/items/sea.json`; opens UNDERWATER's sealed coffer) | 10 | 0 | yes |
| Bottles (24 letters) | `ITEM_FSH_BOTTLE` (opens to a letter, then a `Letter` item for reading again) | 1 | 0 | no |
| Trophy | Ship in a Bottle (all 24 letters) | 1 | 0 | no |
| Kit | Campfire Kit (`ITEM_FSH_CAMPFIRE`) | 10 | 60 | yes |

---

## 4. The catch mini-game

### 4.1 The flow

| Phase | The player | The screen | The server |
|---|---|---|---|
| **Stance** | uses the rod (bag or hotbar) | rod in hand, FISH_IDLE; over valid water the cursor is a hook; over anything else the normal cursor | `fishStance` is client-side only (no message) |
| **Cast** | clicks the water 4–16 m away (or Space: casts 9 m straight ahead) | FISH_CAST; the line flies in an arc; plop | validates (§2.1), takes the bait, **rolls the catch** (§5.1) and the bite schedule; answers `fishCast` with the schedule |
| **Wait** | waits; may stop (Esc, move) | FISH_IDLE; the float bobs on the water (on the ocean it rides the CPU wave query, COAST §8.4); **nibbles** dip it with a tick sound (0–3, fake) | — |
| **Bite** | strikes (Space, a click, or the mouse button) within the window | the float plunges, a splash, a ring shrinks round it over the window (0.80 s for every fish, 1.2 s with Easy timing) and "Strike!" | — |
| **Strike** | — | FISH_STRIKE (a sharp lift) | checks the strike step (§4.4), answers `fishHook` with the fight seed and the class numbers (never the species) |
| **Fight** | holds to reel, lets go on runs and in the red, avoids slack | FISH_REEL while held, FISH_LETGO while not; the rod bends with the tension; the tension gauge (§9.2); a fish shadow darts; a run is announced 0.30–0.60 s ahead by a splash, a "!" and a whine | — |
| **End** | — | landed: FISH_CATCH (the fish held up, its name and weight over it); else FISH_FAIL with the reason | replays the fight from its seed and the reported button changes; awards the catch, the XP, records |

An early strike (on a nibble or on nothing) spooks the fish: the cast is lost, the bait spent. A late strike misses.
Moving, attacking, using a skill, mounting, taking damage, or a warp ends fishing at once (the fish escapes; a fight
in progress counts as `escaped`).

### 4.2 The bite schedule [decision; prototype `biteSchedule`]

- The wait is 3–12 s (uniform), ×1.5 with a bare hook; 0–3 nibbles before it. Steps count from the arrival of the
  `fishCast` answer, so the 1.4 s cast animation and the line's flight are part of the wait.
- **The strike window is 0.80 s for every fish** (1.2 s with Easy timing) *(fact-check)*. The first version used a
  window per fight class (0.95 s small … 0.50 s legendary) and sent it in `fishCast`. That told a modified client the
  class the moment the cast was accepted. It could `fishStop` and recast every 1.5 s until the window read 0.50 s
  (the legendary) or 0.60 s (a rare fish): about 20× the honest rate of rare rolls. The difficulty of rare fish now
  lives only in the fight, and the class is revealed at the hook (`fishHook`). The wait and the nibbles are drawn from
  a seed stream separate from the catch roll, so they carry no information either.
- **The schedule is sent with the cast**, so the bite never waits for the network: a 150 ms ping costs the angler
  nothing [decision: fairness to friends on distant connections beats hiding the timing from bots; bots are bounded by
  §8.4 instead].

### 4.3 The fight simulation (`packages/shared/src/fishing/sim.ts`, from `work/tmp/fishing/minigame/sim.js`) [decision]

60 fixed steps per second, independent of the frame rate. State: tension T, line out D (m), fish stamina S (1 → 0).

- **Runs:** every `runEvery` s (random in the class range) the fish runs for `runLen` s at `runPower` × its pull; a
  run is announced `tele` s before.
- **Pull** = `power × (run ? runPower : 1) × (0.4 + 0.6 S)`: a tired fish still pulls at 40 %.
- **Tension** follows a target with a lag: held, `(pull × 0.95 + 0.3) / strength` at rate 4/s; released,
  `pull × 0.3 / strength` at 2.2/s. Strength = the rod's × (1 + 1 % per fishing level above 1).
- **Line:** held, reels in at the rod's speed (× 0.25 in a run) × (1 + 1.5 % per level); the fish takes `takes × pull`
  m/s (× 0.2 while held).
- **Stamina** drains with tension, `(0.3 + 1.4 T) / stamina` per s; slack (T < 0.15) lets it recover a little.
- **Ends:** **snapped** after 0.25 s at full tension; **unhooked** after 1.6 s of slack (T < 0.08); **landed** when
  the line is ≤ 1.2 m; **ran** when 14 m more line than the cast is out; **escaped** after 90 s.

The fight classes [decision; tuned with `tune.mjs`]:

| Class | Fish | Power | Stamina (s) | Runs every (s) | Run ×, length (s) | Warning (s) |
|---|---|---|---|---|---|---|
| small | Crucian Carp, Loach, Mullet, Silver Sardine; junk | 0.34 | 5 | 4.0–7.0 | 2.2, 0.6 | 0.60 |
| medium | Common / Grass Carp, Yellow Croaker, Silver Pomfret, Coral Snapper; treasure | 0.46 | 8 | 3.0–5.5 | 2.6, 0.7 | 0.55 |
| strong | Mandarin Fish, Sea Bream, Hairtail | 0.56 | 12 | 2.6–4.6 | 2.7, 0.8 | 0.50 |
| heavy | Catfish, Sea Bass | 0.64 | 16 | 2.4–4.2 | 2.8, 0.9 | 0.45 |
| rare | Snakehead, Golden Koi, Quicksilver Eel, Moon Pufferfish | 0.72 | 24 | 2.2–3.8 | 3.0, 1.0 | 0.38 |
| legendary | Dragon Gate Carp | 0.84 | 36 | 1.8–3.2 | 3.1, 1.2 | 0.30 |

The strike window is the same 0.80 s for every class (§4.2, *fact-check*); the prototype's per-class `bite` numbers
are not used.

A treasure box or a bottle fights as `medium` with no runs ("snagged on something heavy"); junk as `small`.

### 4.4 Authority: the server's replay [decision]

1. **Cast:** the server rolls everything (§5.1) and sends `{castId, bite, nibbles}` (the window is the fixed 0.80 s, or
   1.2 s with Easy timing, so nothing in the answer depends on the roll *(fact-check)*).
2. **Strike:** the client sends `{castId, step}` (its own step count since the plop). The server accepts
   `bite + 6 ≤ step ≤ bite + window` (6 steps = 100 ms, the human floor) and a wall-clock arrival no earlier than
   `(step − 30) / 60` s after the cast was accepted; then sends `{castId, seed, class numbers, rod, level, easy}`.
3. **Report:** the client sends `{castId, toggles[], steps}`: the steps at which the button changed (sorted, the first
   a press, ≤ 512 entries) and the step it ended at. The server **re-runs the fight** and accepts the outcome only if
   it is identical at the same step, and if the report arrives no earlier than `(steps − 30) / 60` s and no later than
   `steps / 60 + 15` s after the hook. Anything else counts as `escaped` (no penalty, logged for `/fish stats`).
4. **Why this is safe enough:** an outcome needs a button sequence that really lands the fish, played in real time; a
   bot could compute one from the seed, which the daily soft cap and the idle rule bound (§8.4). For a friends' server
   that is the right trade [decision].
5. **Cross-engine determinism:** the simulation uses only `+ − × /`, comparisons and a 32-bit integer RNG (`Math.imul`,
   `>>>`); never `Math.sin/exp/pow`, which ECMAScript leaves "implementation-approximated". V8 (Chrome, Node) and
   JavaScriptCore (Safari) therefore agree bit for bit [likely: the language rule; Chrome and Node confirmed identical
   by every prototype replay; a Safari check is user check 4, §13].
6. **Cost:** 17–20 ns per step on the dev PC, so ≈ 0.1 ms (5,400 steps) for a 90 s fight [confirmed: `bench.mjs`,
   2,000 replays per class; re-run by the fact-check: 16.6–20.5 ns per step].

### 4.5 How hard it is [confirmed: `tune.mjs`, 400 fights per row, cast 10 m; the fishing level is the rod's unlock level]

Four player models: **expert** (0.25 ± 0.12 s reactions, lets go on warnings and runs, reels below 70 % tension, saves
a slack line, looks away 6 % of the time), **casual** (0.35 s, ignores warnings, lets go only after 0.3 s in the red),
**hold** (never lets go) and **afk** (never presses). Landed %, mean fight length:

| Rod | small | medium | strong | heavy | rare | legendary |
|---|---|---|---|---|---|---|
| Bamboo (1): expert | 100 %, 8.5 s | 100 %, 10.0 s | 98 %, 14.4 s | 90 %, 21.3 s | 74 %, 37.4 s | 1 % |
| Bamboo: casual / hold | 100 % / 100 % | 100 % / 100 % | 0 % / 0 % | 0 % | 0 % | 0 % |
| Willow (4): expert | 100 %, 7.2 s | 100 %, 8.3 s | 100 %, 10.8 s | 95 %, 16.0 s | 81 %, 28.0 s | 52 %, 74.8 s |
| Willow: casual / hold | 100 % | 100 % | 0 % | 0 % | 0 % | 0 % |
| Black Lacquer (7): expert | 100 %, 6.3 s | 100 %, 7.3 s | 100 %, 8.4 s | 98 %, 11.9 s | 85 %, 20.8 s | 62 %, 53.9 s |
| Black Lacquer: casual / hold | 100 % | 100 % | 16 % | 0 % | 0 % | 0 % |
| any rod: afk | 0 % | 0 % | 0 % | 0 % | 0 % | 0 % |

- A beginner who just holds the button lands the common fish; the strong fish and up need the rhythm; the legendary
  needs a good rod and a good angler.
- *(fact-check)* **The "casual" rows are the "hold" rows.** The casual model lets go after 0.3 s of red seen through a
  0.35 s delay, but the line snaps after 0.25 s at full tension, so it never lets go in time. Its numbers equal
  "hold" in every row of `tune.mjs` (re-run: identical to the table above). The table therefore said nothing about a
  real, attentive player. `factcheck/humans.mjs` adds that player: they let go when they see a warning, a run or a
  red bar, reel again when the bar is under 70 %, with a reaction R (±25 % jitter) and a 1.2 s look-away started at
  0.08 per second (≈ 9 % of the time) (400 fights per cell, landed %):

| Rod (level) | R | small | medium | strong | heavy | rare | legendary |
|---|---|---|---|---|---|---|---|
| Bamboo (1) | 0.3 s | 100 | 100 | 94 | 92 | 67 | 0 |
| Bamboo (1) | 0.4 s | 100 | 100 | 93 | 89 | 58 | 0 |
| Bamboo (1) | 0.5 s | 100 | 100 | 93 | 88 | 30 | 0 |
| Willow (4) | 0.3 / 0.4 / 0.5 s | 100 | 100 | 94 / 94 / 93 | 91 / 89 / 87 | 78 / 73 / 50 | 27 / 7 / 1 |
| Black Lacquer (7) | 0.3 / 0.4 / 0.5 s | 100 | 100 | 96 / 95 / 95 | 91 / 90 / 88 | 80 / 77 / 59 | **51 / 22 / 2** |

- So: every attentive player lands the strong and heavy fish ≈ 9 times in 10 with any rod, and the rare fish need
  quick eyes or a better rod. The legendary depends steeply on reaction time, because its 0.30 s warning is shorter
  than most reactions: **≈ 20–50 % with the Black Lacquer Rod for a good player, near 0 for a slow one** (the former
  "≈ 30–45 %" was a guess). Easy timing (§4.6) lifts the slow player to ≈ 55 %. [confirmed for the models; how real
  hands map onto R is user check 2 and LAB-13's play session.]
- The losses are mostly snaps (holding into a run), which the gauge and the whine announce.

### 4.6 Readable on a laptop and a Mac [decision]

- **Inputs are holds and single presses**, never fast taps or precise aiming: Space, the left mouse button or a
  trackpad click-and-hold (no force touch), and a gamepad button when gamepads exist. The cast target is any point of
  valid water; Space casts 9 m straight ahead for players who prefer the keyboard.
- **The gauge** is 520 × 26 native px at the casting-bar spot (UI §0: `--ui` never below 1), with zones told apart by
  pattern as well as colour (slack dotted, snap hatched), the needle's colour, and the words SLACK / SNAP; the fish's
  stamina as ten pips (shape, not colour).
- **Sound carries the same information:** the reel clicks while held, a line whine rises with tension from 70 %, a
  distinct "warn" chirp precedes a run, a bite has its own splash and bell: playable eyes-off the gauge.
- **Frame-rate and latency proof:** the fixed 60 Hz simulation plays the same at 30 or 144 fps (input is sampled every
  frame, so 33 ms granularity at 30 fps), and runs on the client, so ping never reaches the fight.
- **"Easy timing"** (Options → Interface): warnings **0.15 s** earlier, twice the snap grace, **6 m more line and 30 s
  more** before a fish runs or tires, and a 1.2 s strike window. The server's replay applies the same flag, so it is an
  honest assist; it changes nothing else (no reward penalty) [decision]. *(fact-check)* The first numbers (warnings
  0.25 s earlier, snap grace ×2, nothing else) made the legendary **harder**. A player who lets go for the whole
  longer warning holds too little, and the fish runs or the 90 s clock ends. With the Willow Rod the rate fell from
  27 % to 1 % (R 0.3 s), with snaps turning into `ran`/`tired` [confirmed: `factcheck/easy_why.mjs`]. Warnings only
  0.10 s earlier still lost the Willow at R 0.3 (27 → 17 %). The chosen set improves every cell of
  `factcheck/easy_fix.mjs` (variant B). Black Lacquer legendary: 51 → 72 % (R 0.3), 22 → 63 % (R 0.4), 2 → 55 %
  (R 0.5). Willow legendary: 27/7/1 → 44/37/24 %. Heavy and rare fish gain 3–33 points. Most friends will likely
  switch it on, and the legendary's odds (§5.4) assume they may: the chase is in the bite, not the fight.
- The strike ring is drawn in screen space round the float's projection, ≥ 60 px at the start, so it reads at any zoom.

### 4.7 What others see

Viewers within 60 m get `fishing {id, s, at, fish?, kg?}` with `s` = `cast | bite | fight | land | fail | stop`: the
rod and the stance; the cast's line to `at`; the float; the plunge and splash at the bite; a taut line, a bent rod,
REEL/LETGO alternating and splashes during the fight (their timing is the viewer's own cosmetic randomness: the fight's
input is never broadcast); the fish held up at `land`, with its name and weight in a bubble.

![Prototype states](../work/tmp/fishing/out/minigame_states.png)

---

## 5. What bites

### 5.1 The roll (`packages/shared/src/fishing/roll.ts`, pure, shared) [decision]

At the cast the server builds a weight table for the angler's water, time and conditions, then rolls once:

1. **Outcome group:** treasure (§5.5), bottle (§5.6), UNDERWATER's Rusty Bronze Key (sea, bay and ferry basin 1 in
   200 catches, the river 1 in 400, nowhere else; none after the daily cap) *(fact-check: UNDERWATER §2.2 asked for it
   and left the rate to this spec)*, junk (6 %, ×3 on a bare hook), else a fish.
2. **Fish:** each species row has a base weight per body; multiplied by its time (dawn 05–07, day 07–17, dusk 17–19,
   night 19–05, game hours = the clock's solar time), weather, moon and bait factors, × 1.3 for strong and heavy fish
   in ≥ 4 m of water, × the level's rare factor for rare fish (§5.8), × 1.5 for rare fish inside a Golden Grain
   scatter (§3.3), × 2 for rare fish within 80 m of the Jade Tortoise's path during its window (UNDERWATER §6.3, the
   shared `seaEventsAt(clock)`, no message) *(fact-check)*, × 0.5 for rare fish in a personally fished-out spot (§8.4).
3. **The legendary** is rolled first and separately (§5.4).
4. **Size:** uniform in the species' range, skewed by `u^1.6` (big fish are rarer); the top 5 % is a **trophy**
   (the `…_TROPHY` item, ×2 sell, a toast) [decision].

`/fish odds` (GM) prints the table at the GM's spot, so the numbers are checkable in game. The content lives in
`content/fishing/species.json` (rows) and `rules.json` (the time windows, factors, caps): wave 14 re-tunes data, not code.

### 5.2 The species [decision]

Base weights per body (moat / pond / swamp / river / ferry / tomb / bay / sea); "×" are multipliers when the condition
holds. Sell is at an average size; XP is fishing XP (§5.8).

*(fact-check)* **One species list with UNDERWATER.** UNDERWATER (§2.2, D-U21) keeps `content/sea/species.json` (owner
UW-L) and promises "the fish you catch are the fish you see". Its schools are silver sardine, golden-line bream, coral
snapper, reef dwellers and sea bass, and the first version of this table had no sardine and no snapper. So the
sea rows here use UNDERWATER's ids. **Sea Bream** is UNDERWATER's `golden_line_bream` (the shared display name is
WAVE_PLAN9's call; default "Sea Bream") and **Sea Bass** is its sea bass. **Silver Sardine** (#4) and **Coral
Snapper** (#9) are added. The blue-tang-like reef dwellers stay a sight only (they hide in the rocks). Fishing's rows
(weights, classes, prices, XP) live in `content/fishing/species.json`, keyed by those ids. Freshwater species are
fishing-only rows.

| # | Species | Class | Waters (base weight) | Time | Weather / moon | Bait | Size (kg) | Sell | XP |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Crucian Carp | small | moat 40, pond 40, swamp 25, river 30 | any | — | worm, dough ×1.5 | 0.2–0.8 | 3 | 10 |
| 2 | Loach | small | swamp 30, pond 20, moat 10 | any | rain ×2 | worm ×2 | 0.05–0.2 | 2 | 8 |
| 3 | Mullet | small | ferry 30, bay 25, sea 20, river 5 | any | — | any | 0.3–2 | 4 | 10 |
| 4 | Silver Sardine *(fact-check: UNDERWATER's schools)* | small | sea 20, bay 15 | day ×1.5 | — | shrimp | 0.05–0.15 | 2 | 8 |
| 5 | Common Carp | medium | moat 30, pond 25, river 20, swamp 10 | day, dusk ×1.3 | — | dough ×2 | 1–6 | 8 | 18 |
| 6 | Grass Carp | medium | river 15, pond 15 | day ×1.5 | — | dough | 1.5–8 | 9 | 18 |
| 7 | Yellow Croaker | medium | sea 25, bay 20, ferry 15 | day | — | shrimp ×2 | 0.3–1.5 | 10 | 18 |
| 8 | Silver Pomfret | medium | sea 20, bay 15 | day ×1.5 | clear, cloudy | shrimp | 0.3–1.2 | 12 | 18 |
| 9 | Coral Snapper *(fact-check: UNDERWATER's reef dwellers)* | medium | sea 8 | dawn, dusk ×1.5 | — | shrimp ×1.5 | 0.4–2 | 14 | 18 |
| 10 | Mandarin Fish | strong | river 10, ferry 6 | dawn, dusk ×2 | — | shrimp ×2 | 0.5–3 | 18 | 30 |
| 11 | Sea Bream (shared id `golden_line_bream`) | strong | sea 12, bay 10 | dawn, dusk ×2 | — | shrimp ×1.5 | 0.5–3 | 20 | 30 |
| 12 | Hairtail | strong | sea 10, ferry 4 | night ×3 | — | glowworm ×2 | 0.3–1.5 | 16 | 30 |
| 13 | Catfish | heavy | swamp 10, river 8, moat 8 | night ×3 | rain ×1.5 | worm, glowworm ×2 | 2–12 | 30 | 45 |
| 14 | Sea Bass | heavy | ferry 10, bay 10, sea 8 | dusk ×1.5 | rain, storm ×2 | shrimp | 1–7 | 35 | 45 |
| 15 | Snakehead | rare | swamp 2 | night ×2 | storm ×3 | glowworm ×2 | 1–6 | 90 | 80 |
| 16 | Golden Koi | rare | moat 1.5 | day | clear ×1.5 | dough ×2 | 1–4 | 120 | 80 |
| 17 | Quicksilver Eel | rare | tomb 3 | night ×2 | fog ×3 | worm, glowworm | 0.5–2.5 | 150 | 80 |
| 18 | Moon Pufferfish | rare | sea 1.5, bay 1.5 | night | moon lit ≥ 0.85 ×6, else ×0.3 | shrimp | 0.3–1.5 | 200 | 80 |
| 19 | **Dragon Gate Carp** | legendary | river, ferry | dawn, dusk ×3 | rain, storm ×3 | Golden Grain scattered (§3.3), any hook bait | 12–25 | — | 400 |

Caught ingredients ride the junk group: Waterweed (every water), River Snail (swamp, pond, moat), Mud Crab (sea, bay,
ferry), each 30 % of the junk rolls [decision: the stew and soup recipes need them, §7.2].

The tomb moat has only Crucian Carp (weight 20), Catfish (8) and the Quicksilver Eel: a deliberately strange water at
the dungeon's door (§10.4).

### 5.3 Time, weather and moon, in numbers [confirmed: `factcheck/windows.mts`, one year of the shared clock (`solarTime`, night ×0.4) and `WeatherSchedule` (seed 1, rain scale 1) sampled every 30 s]

*(fact-check: the first version's twilight, window and moon numbers were estimates, two of them wrong.)*

- Dawn and dusk are 2 game hours each, **≈ 8.5 real minutes each** per 2-hour day (14.2 % of the time together; the
  speed-up trims the twilight a little too).
- Rain 10.5 %, storm 1.3 %, fog 3.3 %, night 31 % of the time.
- **Full-moon nights (lit ≥ 0.85) are a quarter of all nights**, not "one evening in four real days": the lit fraction
  stays ≥ 0.85 for ≈ 7.5 consecutive game days (≈ 15 real hours) of every 29.5 (59 real hours), so ≈ 8 % of all time is
  a full-moon night. The Moon Pufferfish is therefore a regular night catch for a quarter of the nights, which is
  still special (×6 against ×0.3) and keeps the +10 % EXP dish (Moonlight Fugu) obtainable without luck.
- **The legendary's best window** (twilight in rain or storm) is **1.7 % of the time**: ≈ 3.8 windows per real day,
  median 8.5 minutes, ≈ 25 real minutes a day in all. One hour of fishing inside it takes ≈ 59 real hours of
  calendar. Its odds outside the window are a third (twilight or wet alone) or a ninth, never zero (§5.4).

### 5.4 The legendary: the Dragon Gate Carp [decision]

The carp that leaps the Dragon Gate becomes a dragon (the old Chinese legend; the bottle letters and Ahn tell it).

- **Eligible cast:** the river or the ferry basin, inside one's own live Golden Grain scatter (§3.3), fishing level ≥ 7,
  under the daily cap (§8.4).
- **Odds per eligible cast:** 1 in 1,200, × 3 at dawn or dusk, × 3 in rain or storm (1 in 133 with both).
- **Pity:** every eligible cast without it adds 1/240,000 to the next one's base odds (the condition factors multiply
  it too), reset on the bite [decision: no guaranteed bite, but a long unlucky streak shortens]. *(fact-check: the
  first text said "after ≈ 600 casts the odds have doubled"; 1/1,200 ÷ 1/240,000 = 200, so they double after **200**
  casts and are ×4 after 600. The numbers are kept, because with the pity counted the chase is already the intended
  length; the old "≈ 1 bite per 11 h" ignored the pity.)*
- **In practice** at ≈ 110 casts per hour [projected: §10.1; expectations from `factcheck/legend.mjs`]:
  ≈ **456 eligible casts (≈ 4.1 h) per bite at base odds**, ≈ **340 (≈ 3.1 h) for casts spread over the day's hours
  and weather** (the time-average factor is 1.59 from the windows of §5.3), and ≈ 100 (≈ 0.9 h) if every cast fell in
  the twilight-rain window, which nobody can arrange (≈ 25 minutes a day). That is ≈ 19 Golden Grain (≈ 4 Golden Koi)
  per bite. Then the fight: 22–51 % for a good player with the Black Lacquer Rod, 63–72 % with Easy timing (§4.5,
  §4.6). So **≈ 5–15 h of river fishing per landed legendary**, spread over evenings, the daily cap included: rare, a
  story, never impossible.
- **When landed:** a server-wide notice ("Ahn Yu: Lili has landed the Dragon Gate Carp! 18.4 kg."), the `ui.legendary`
  cue (`ui/gacha_win`), +400 fishing XP, the journal page. The fish cannot be sold or traded (a trophy); it can be
  cooked into the Dragon Gate Feast (§7.2), which feeds the whole party.

### 5.5 Treasure [decision]

| Box | Waters | Rate (per catch) | Opens to (each × `GOLD_RATE` / `DROP_RATE` like dropped loot) |
|---|---|---|---|
| Sunken Coffer | sea, bay, ferry | 1 in 150 | gold 300–900; 25 %: 3–5 potions of the angler's tier; 15 %: an elixir or Lucky Powder (SYSTEMS_COMBAT §4.5's level-20 pool); 10 %: one equipment roll of the angler's degree (the unique drop table's `pool` form) |
| Silted Strongbox | river, moat, swamp | 1 in 250 | gold 150–500; 25 %: potions; 8 %: one equipment roll |
| Tomb Offering Box | tomb | 1 in 200 | gold 200–600; 20 %: an elixir; **a Tomb Seal Shard** (a curio, sell 50; the wave-14 hook, §10.4) |

Field ponds have no treasure. A box is opened with a 1.5 s cast (`common/obj_boxopen`). Treasure stops for the day after
the daily soft cap (§8.4).

### 5.6 Messages in a bottle [decision]

- **Where:** sea, bay and ferry basin 1 in 250 catches; the river 1 in 600 (bottles float to the sea); nowhere else.
- **What:** one of **24 letters** (`content/fishing/letters.json`), never a repeat until a character has all 24. Opening
  the bottle (`ui/itscroll`) shows the letter on the retail parchment (`guide/gd_paper_02`) and keeps a `Letter` item to
  read again; the journal's Letters page tracks 0/24.
- **The letters:** about a third lore (the Silk Road, the ferrymen, Jangan's founding, the emperor's tomb "and its rivers
  of quicksilver"), a third hints (where the Golden Koi feed, "when rain falls at first light the river remembers the
  Dragon Gate", the moon and the pufferfish), a third people (a ferryman's love letter, a merchant's IOU, a child's
  drawing of a fish described in words, a soldier's homesick note). The user may write some of their own (§13).
- **All 24:** a **Ship in a Bottle** trophy item, a journal page and a server notice. **Purely cosmetic** [the task's
  "message in a bottle as a cosmetic easter egg"].

### 5.7 Records and the journal

- **Per character:** the count and the best weight per species, the first-catch time, the letters, the legendary
  count (`fishing.journal`, §8.6).
- **Server-wide:** the top 3 weights per species (`fishing_records`). A new species record posts one chat line from
  Ahn; Ahn's dialog has a **Records** board; the journal shows "Server record: 9.4 kg (Lili)".
- **The journal window** (J, §9.2): Fish (a 19-slot grid: icon, caught / not yet, best weight, the hint line), Letters,
  Records, Fishing level and perks.

### 5.8 The fishing level [decision]

| Level | Total XP | Unlocks and perks |
|---|---|---|
| 1 | 0 | Bamboo Rod, worm, dough, shrimp |
| 2 | 300 | — |
| 3 | 900 | Glowworm Lure |
| 4 | 2,000 | Willow Rod |
| 5 | 3,800 | rare fish ×1.1 |
| 6 | 6,500 | trophy chance ×1.25 |
| 7 | 11,000 | Black Lacquer Rod; the legendary is eligible; rare ×1.2 |
| 8 | 16,500 | rare ×1.3 |
| 9 | 23,000 | treasure ×1.2 |
| 10 | 30,000 | "Master Angler" (a server notice); trophy chance ×1.5 |

Every level above 1 also gives +1 % line strength and +1.5 % reel speed (the simulation, §4.3): small on purpose, so
skill decides and levels help. XP per catch: §5.2; junk 2, a treasure box 25, a bottle 25. Pace: ≈ 2,400 XP per hour
[projected: 110 catches/h, a typical mix] → level 4 in ≈ 50 min, 7 in ≈ 4.6 h, 10 in ≈ 12.5 h.

---

## 6. Animations

### 6.1 The clips [decision]

Keyed headless in Blender 5.2 on **both skeletons** (`europeman_skel` for all 13 male models, `europewoman_skel` for
all 13 female ones), 30 fps, full-body on the STAND1 base with both feet planted (the keyer's `fixed` lock):

| Clip | Kind | Length | Events | What it shows |
|---|---|---|---|---|
| FISH_IDLE | loop | 4.0 s | — | rod held at ≈ 35°, butt at the belly, the left hand on the butt; a small bob and a weight shift |
| FISH_CAST | one-shot | 1.4 s | release at 0.95 s (the line leaves) | rod up and back over the right shoulder, the body turns, a forward whip, follow-through, settle to IDLE |
| FISH_STRIKE | one-shot | 0.4 s | — | a sharp lift of the rod to ≈ 60° |
| FISH_REEL | loop | 1.0 s | crank clicks ×4 | the rod at 45–55°, the left hand cranking 2½ turns per second |
| FISH_LETGO | loop | 1.0 s | — | the rod held high and bent, the body leaning back, the left hand off the crank |
| FISH_CATCH | one-shot | 2.2 s | fish appears at 0.4 s, hides at 1.9 s | the line lifted; the fish taken in the left hand and held up beside the face; stowed |
| FISH_FAIL | one-shot | 1.3 s | snap at 0.05 s | the rod springs back, the shoulders drop, a head shake, back to IDLE |
| COOK | loop | 2.0 s | stir taps | a ladle in the right hand stirring a pot at hip height, the left hand steadying it |
| EAT | one-shot | 1.6 s | — | a bowl in the left hand, chopsticks to the mouth twice |

Clips blend 0.2 s from the weapon idle (whatever the stance) into FISH_IDLE; REEL ↔ LETGO cross-fade 0.12 s as the
button changes.

### 6.2 The pipeline (the moves pipeline, extended) [decision]

```
content/moves/<skel>/fishing/<clip>.json       key poses (text, committed, no retail data)
        │  Blender 5.2 headless: packages/convert/tools/blender/fishing/key_fish.py <char.glb> <keys-dir> <out> <prefix>
        │  (reuses key_town.py's TownRig, the reach solver and the planted feet, and key_moves.py's limb maths)
        ▼
work/out/moves/<skel>/fishing/fish_blender.glb   + fish_keys.json (per-frame feet, reach errors, the socket frame)
        │  pnpm sro moves --fishing   (packages/convert/src/tools/fish-clips.ts: the town-clips maths)
        ▼
work/out/char/_anims/<skel>/fishing.glb + fishing.json   (the pack format, docs/ASSETS.md §5.3) → optimize-out → out-opt
```

What `key_fish.py` adds to the town keyer (all proven by the prototype except the first):

1. **One-shot clips:** `loop: false` interpolates with a clamped (not cyclic) Catmull-Rom and holds the last key; the
   last frame equals FISH_IDLE's frame 0 for the clips that return to it.
2. **A keyed rod direction** per key (`rod: [pitch, yaw, bend]`): the right hand (the socket bone) turns every frame so
   the rod's frame-0 axis in the hand's frame points along it (the broom's `axis` rule with a keyed direction).
3. **The left hand on the rod** (`lrod: [along, right, up]` from the grip): the butt for the cast, a circle round the
   reel for the crank.
4. **Props for COOK and EAT:** a ladle (right hand) and a bowl (left hand) through the town keyer's existing socket
   `steady` rule.

The rod, ladle and bowl are sockets on `Bip01 R Hand` / `Bip01 L Hand`, the same mechanism as the broom (TOWN_LIFE
§3.1); `fishing.json` carries each clip's socket frame-0 offset (`town-clips.ts` already computes this).

### 6.3 The prototype [confirmed: `work/tmp/fishing/blender/key_fish.py`, 2026-10-02]

- **One loop on `chinaman_adventurer.glb`**: wait → nibble → strike → reel (4 crank turns, the lure from 10 m to 2 m)
  → lure out → back-cast → loaded → whip → release → the line's flight → splash → settle → wait. 6.0 s, 181 frames.
- **Measured:** both feet planted within 0.01 mm and sliding at most 0.04 mm per frame; the right wrist within 3.1 mm
  of its keyed point; the left hand within 2.4 cm of the rod everywhere (the crank's lowest point, 4 frames). The first
  version had the left hand 10 cm off (the butt inside the hip at the wait pose); moving the grip 6 cm forward and
  shrinking the crank circle fixed it, recorded in the key file.
- **Rendered** in Workbench from two views with the rod drawn from the socket bone, a bending curve, the line, the float
  and the lure's flight arc: `out/fish_cast_reel.gif` (91 frames, 1.3 MB) and the filmstrip above.
- **What the build polishes** (the jump's lesson, MOVEMENT §3.2): the back-cast reads short because the tip leaves the
  side view (a wider camera in the review), the release could snap 2 frames earlier, and the female keys need their own
  grip and crank offsets (her shoulders are narrower; the sweep's keys transferred unchanged, the fishing ones get a
  check of the reach errors first).
- **Cost:** ≈ 1.5 min of Blender per clip set on the dev PC without rendering, ≈ 2 min with 182 renders.

### 6.4 Size and loading [projected from the shipped movement pack: 3.83 s of clips in 56.7 KB brotli]

9 clips per skeleton (14.9 s of full-body animation at 30 fps) ≈ **200–230 KB brotli per skeleton** *(fact-check: the
first figure, 150–170 KB, was not scaled by length; the shipped movement pack holds 3.83 s in 56.7 KB brotli in
`out-opt`, ≈ 14.8 KB per second [confirmed: `ls -la`, `movement.json` durations])*; loaded on first need (you take up a rod, or a fisher comes
within 60 m), never at world entry.

### 6.5 The other players' clips

A viewer plays the same clips from `fishing` events (§4.7); the catch pose shows the species' fish (§6.6) in the left
hand. On Low (Classic) the clips play the same.

### 6.6 The fish you hold up (S-FISHMESH) [decision]

The 19 species (plus the junk, a box and a bottle) are small meshes (≤ 400 triangles), painted with vertex colours, the
fin weight in the alpha: exactly UNDERWATER's bpy creature method (`work/tmp/underwater/creatures.py`). **One
generator builds both specs' creatures** (seam S-FISHMESH, default owner UNDERWATER's creatures lane): fishing supplies
the freshwater shape-and-palette rows in `content/fishing/species.json` (the sea species' rows are UNDERWATER's `content/sea/species.json`, §5.2); UNDERWATER's fish schools may show the local water's
species. The same renders make the inventory icons (§3.1).

---

## 7. Cooking

### 7.1 Where [decision]

A player cooks within 4 m of a **cook spot** (`content/fishing/cook-spots.json`, positions checked by the server):

| Spot | Where | Look |
|---|---|---|
| **Cook Mei's stove** | the restaurant front (`cj_resta01`; the exact spot is the lane's, off the town graph's paths by TOWN_LIFE's 0.4 m rule) | a new stove prop (bmesh, ≤ 300 triangles, the town props' method) with TOWN_LIFE's `pot`, the retail fire effect and the town's steam puffs |
| **The six gate braziers** | `cj_enter_fire` at the west, north and east gates [confirmed positions] | as they are |
| **Pier campfires** | the foot of the Jangan Ferry pier, the S1 beach by the pier | the retail brazier model with its fire, `firework/campfire.wav` |
| **The hot springs** | by the tea awning (one row added by HOT_SPRINGS' HS-E) | its own |
| **A Campfire Kit** | anywhere outdoors, outside the town's safe-area box (DATA §353), not in water | a small log pile (bmesh, ≤ 200 triangles) with the retail fire effect; burns 3 minutes; anyone within 4 m can cook; one per player; a server entity (§8.2) |

### 7.2 Recipes and dishes [decision]

One refreshment buff at a time (§7.3). Durations count while online only.

| # | Dish | Ingredients | Buff | Duration | Recipe from | Icon (retail) |
|---|---|---|---|---|---|---|
| 1 | Grilled Fish Skewer | 1 small fish + Salt | out-of-combat HP & MP regeneration +20 % | 20 min | known | `e060209_white_dumpling` (re-tinted) |
| 2 | Fish Congee | 1 small or medium fish + Rice + Ginger | out-of-combat MP regeneration +35 % | 30 min | known | `e060125_ricedumplingsoup` |
| 3 | Sweet-and-Sour Carp | Common or Grass Carp + Vinegar + Sugar | kill EXP +5 % | 30 min | known | new render |
| 4 | Pan-fried Hairtail | Hairtail + Salt + Sesame Oil | move speed +5 % (on foot), **swim speed +10 %** (SWIMMING's `swimMul`: turns on the crawl, `SWIM_FAST`) *(fact-check: SWIMMING §5.4/§12.1 expects a swim dish)* | 30 min | known | new render |
| 5 | Mushroom and Snail Hotpot | 2 River Snail + Wild Mushroom + any fish | physical defence +3 %, regeneration +20 % | 30 min | known | `e050715_icedvermicelli_tepid` |
| 6 | Herb-Steamed Croaker | Yellow Croaker + Wild Herbs + Ginger | abnormal-state resistance +10 %, max MP +3 %, **dive breath +30 %** (SWIMMING's `breathMul`: 30 → 39 s) *(fact-check: SWIMMING §6's hook)* | 30 min | known | new render |
| 7 | Steamed Mandarin Fish | Mandarin Fish + Ginger + Scallion | out-of-combat HP regeneration +35 %, max HP +2 % | 30 min | quest JG_F02 | new render |
| 8 | Spicy Catfish Stew | Catfish + Chili + Waterweed | abnormal-state resistance +10 %, magic defence +3 % | 30 min | quest JG_F02 | `e050715_icedvermicelli_cool` (re-tinted) |
| 9 | Sea Bream and Crab Soup | Sea Bream + Mud Crab (or UNDERWATER's Sea Urchin) + Waterweed (or Kelp) | out-of-combat HP & MP regeneration +35 % | 40 min | quest JG_F02 | `e060125_ricedumplingsoup` (re-tinted) |
| 10 | Moonlight Fugu | Moon Pufferfish + Sesame Oil + Scallion | kill EXP +10 % | 45 min | quest JG_F03 | new render |
| 11 | Quicksilver Eel Broth | Quicksilver Eel + Ginger + Wild Herbs | abnormal-state resistance +20 % | 45 min | quest JG_F03 | new render |
| 12 | **Dragon Gate Feast** | Dragon Gate Carp + 5 Rice + 2 Sesame Oil | **the whole party within 30 m**: kill EXP +10 %, move speed +5 % | 60 min | the legendary itself | new render |
| — | Golden Grain (bait ×5) | 2 Rice + Sugar + Golden Koi | — | — | quest JG_F03 | `etc_seed_shine` |

- Moonlight Fugu has a 5 % "numb lips" moment when eaten: a laugh emote and a chat line, nothing else (cosmetic).
- *(fact-check: UNDERWATER §6.2/§6.4)* UNDERWATER's gathered **Kelp** counts as Waterweed in every recipe, and its **Sea
  Urchin** as Mud Crab. That is one alternative-ingredient rule in `recipes.json`, and it gives the dives a use in the
  kitchen with no new dish.
- Eating while swimming is allowed (SWIMMING §7) with no EAT clip; the buff applies at once.
- Recipes "from quest JG_F0x" are known when that quest is completed (the cooking module reads the quest state; the
  QUESTS reward format has no recipe field, and none is added) *(fact-check: `QuestRewards` holds exp, sp, gold,
  items, choice)*.
- Cooking takes **2.5 s per dish** (the casting bar, COOK, the sizzle loop), up to 10 in a row; moving or any action
  stops the batch after the current dish; it always succeeds [decision: no failure roll, the fun is in the fishing].

### 7.3 The refreshment slot (S-BUFF, owned by lane FS-K) [decision]

- **One slot per character**, shared by dishes and HOT_SPRINGS' teas: a new one replaces the old (a confirm box when the
  old one has more than 5 minutes left).
- **On the server:** an effect of kind `buff`, group `refreshment`, in the skills' `EffectTable` (so the stats, the buff
  bar and `buffCancel` work unchanged); `EffectState` gains `item?: string` (the dish's code, for the icon and the
  tooltip). The stat mods come through `SkillEngine.addModProvider`; regeneration through S-REGEN's multiplier
  (HOT_SPRINGS §6); kill EXP through S-REWARD (`killBonus`, one call for every module).
- **Persisted:** `characters.refresh_item` and `refresh_left_ms`, saved at logout and every 30 s, restored at login
  (time only runs online); **kept through death** [decision: a meal is not magic, and the values are small].
- **EXP order** (with HOT_SPRINGS' Rested): `exp = base × (1 + meal) + rested`, where Rested is computed on the base
  and drains on the base [decision: the springs' pool never drains faster because of a dish]. EXP is never kept above
  the level cap (as today), and no dish touches quest EXP. *(fact-check: the order has to be written into S-REWARD.)*
  HOT_SPRINGS §6 defines S-REWARD as one call, `springs.killBonus(p, exp, spExp, mob, now)`, which takes `e` after
  `EXP_RATE`. If the meal were applied first, Rested would be computed on the boosted value and drain faster. So
  `gameplay.ts` calls the springs with `e` (rated, no meal) and then adds `round(meal × e)` to the EXP only (dishes
  never touch SP). Any other EXP percentage this wave adds the same way, for example UNDERWATER's "Tortoise's Calm"
  +10 %: `exp = e × (1 + meal + calm) + rest(e)`. The S-REWARD owner writes it once, with a test for the order.

### 7.4 Ingredients [decision]

- **Kitchen shop** (Cook Mei): Salt 8, Rice 10, Ginger 10, Scallion 8, Chili 12, Vinegar 10, Sugar 12, Sesame Oil 20,
  Flour 10 (Flour is for wave 14's dumplings; listed now so the shop's layout is final).
- **Caught:** Waterweed, River Snail, Mud Crab (§5.2).
- **Monster drops** (a new item group in `drops.json` through `DROP_RATE`): **Wild Mushroom** from Decayed Yeoha and
  Yeoha (6 %), **Wild Herbs** from Old Weasel and Weasel (6 %) [decision: two links back to the fields, at levels 4–10].

### 7.5 The cooking window (the retail 2009 kit)

`mframe` 386 × 413 like the Options window: a recipe list on the left (`com_bar01_` rows: the dish icon, its name,
"×N can be cooked"; unknown recipes greyed with their hint), the selected recipe on the right (its buff and duration,
the ingredient slots with have / need counts in `--c-label` / `--c-text`, red when short), a quantity spin box
(`msgbox_quantity`) and **Cook** / **Cook all** buttons (`com_button`). Opens when you talk to Cook Mei or click a
cook spot (a stove, a brazier, a campfire) within 4 m.

### 7.6 Three short quests (QUESTS engine; `content/quests/fishing.json`) [decision; cut 5]

| Quest | Giver | Level | Objective | Reward |
|---|---|---|---|---|
| JG_F01 "A Line in the Water" | Ahn | 3+ | `have` 3 Crucian Carp | 20 Earthworms, 300 gold; the journal opens |
| JG_F02 "Cook Mei's Kitchen" | Mei | 5+ | `deliver` 1 Grilled Fish Skewer and 1 Fish Congee | recipes 7–9 |
| JG_F03 "The Dragon Gate" | Ahn | 10+, fishing 7 | `deliver` a Mandarin Fish, a Catfish, a Sea Bream | recipes 10, 11 and Golden Grain; 3 Golden Grain; the legend's hint page |

No quest EXP beyond 500 / 1,500 / 3,000 (negligible against the 1,124,480 of the climb, BALANCE §3).

*(fact-check)* JG_F03's "fishing 7" needs a new additive quest field, `requires.fishing?: number`. Today `requires`
holds only `quests` (`packages/shared/src/quests.ts`). The field is checked by the quest engine through a hook the
fishing module answers. It is a step-0 row with the QUESTS checker (FS-C). If it is cut, JG_F03 is offered from
level 10 and Ahn refuses the turn-in below fishing 7 with a dialog line.

---

## 8. Server

### 8.1 The modules [decision]

- **`apps/server/src/fishing/`**: `module.ts` (a `GameplayModule`: the requests of §8.2; its `gate` never refuses, but
  ends fishing on `jump`, `useSkill`, `attack`, `mountRide` and any `itemUse` other than food or Golden Grain; moves
  end it through the `moved`, `stopped`, `playerDied` and `warped` hooks. *(fact-check)* There is no damage hook:
  `tickPlayer` ends fishing when `p.lastCombatAt` (set by damage dealt or taken, `world.ts`) is later than the cast),
  `roll.ts`
  (calls the shared roll), `replay.ts` (the shared sim), `journal.ts` (XP, levels, records, letters), `limits.ts`
  (§8.4), the `/fish` rows.
- **`apps/server/src/cooking.ts`**: cook casts (the item-use cast pattern: interrupted by moves and actions), spots,
  the Campfire Kit entity.
- **`apps/server/src/refreshment.ts`** (S-BUFF): the slot, the mod provider, `killBonus`, the regen multiplier,
  persistence; HOT_SPRINGS' teas call it.

### 8.2 Protocol (additive, protocol v1) [decision]

Requests (each answers one `actionResult`):

| Request | Fields | Rate limit |
|---|---|---|
| `fishCast` | `x, z` (the target), `bait?: string` | 1/s, burst 2 |
| `fishStrike` | `castId, step` | 2/s |
| `fishReport` | `castId, steps, toggles: number[]` (≤ 512, sorted) | 1 per cast |
| `fishStop` | — | 4/s |
| `cook` | `recipe, count (1..10), spot?: string` | 2/s |
| `cookCancel` | — | 4/s |
| `fishJournal` | — | 1 per 2 s |

Events: `fishCast {castId, at, bite, nibbles}` and `fishHook {castId, fight}` (to the angler; no class-dependent field
before the hook, §4.2);
`fishDone {castId, outcome, item?, kg?, trophy?, xp, level?, record?, letter?}`; `fishing {id, s, at, fish?, kg?}` (to
viewers within 60 m); `fishJournal {…}`; `cookDone {recipe, made}` (the cast itself reuses `itemCast`); the Campfire
Kit's fire as an entity of a new kind `fire` (`EntityState.kind`), 3-minute life. New `ActionFailReason`s:
`not_water`, `no_rod`, `rod_level`, `bait_level`, `fished_out` (a soft warning, not a refusal), `wrong_cast`,
`not_cook_spot`, `missing_ingredient`, `recipe_unknown`; the existing `too_far` and `inventory_full` are reused
*(fact-check: both already exist in `protocol.ts`; the first text listed `too_far` as new and used a `bag_full` that
does not exist)*. Stats: `fishingLevel`, `fishingXp` join
`PLAYER_STAT_OPTIONAL_KEYS` (S-STATS, HOT_SPRINGS §7.5).

### 8.3 Validation [decision]

- `fishCast`: the rod in the bag, its level met; the bait's level met and one in the bag; the target per §2.1 (the baked
  water grid, §8.5); a free bag slot for the rolled item (else `inventory_full` before anything is taken); not during
  another cast; the last outcome ≥ 1.5 s ago. A cast stopped before its bite holds the line until its bite step has
  passed (the next cast is refused `wrong_cast` until then), so a re-cast never buys a fresh roll faster than an honest
  wait *(fact-check)*. If the bag fills during the wait or the fight, the catch drops at the angler's feet as an
  owner-protected ground item (the loot rule) instead of being lost *(fact-check)*.
- `fishStrike` / `fishReport`: §4.4.
- `cook`: within 4 m of a spot (or a live campfire); the recipe known; the ingredients present for `count`; bag room
  for the output.
- Gates: dead, mounted, swimming (SWIMMING's state), stunned, trading, stalling, casting a skill → refused; a module
  `gate` from the trade / stall locks already refuses unknown requests by default (wave 8's allowlist), so fishing is
  added to no allowlist [decision: you cannot fish while trading].

### 8.4 Anti-bot and economy limits [decision]

| Rule | Value | Why |
|---|---|---|
| Server rolls, replay, wall-clock floor | §4.4 | no outcome without real-time play |
| **Spot fatigue** (personal) | an angler's own ≥ 60 catches within 30 m of one spot in 60 min (≈ 33 min of steady fishing): rare ×0.5 for that angler there, bites unchanged, a hint "The fish here are wary."; it clears after 20 min away or 30 m off | rare hunters move around. *(fact-check: the shared rule, ≥ 30 catches by all players within 30 m in 30 min, fished a spot out in ≈ 4 minutes for four friends on one pier, 4 × 110 catches/h, and punished the hangout it was meant to keep lively)* |
| **Daily soft cap** | after **400 accepted casts** in a real day (server-local midnight): no treasure, no bottles, no key, rare ×0.5, no legendary; common fish go on | a bot farms nothing of value; a 3-hour evening (≈ 330 casts) stays under it. *(fact-check: it counted 200 **catches**; a bot can `fishStop` every hooked common fish, whose class `fishHook` reveals, and land only rare fish and boxes, so it never reached a catch cap. Casts cannot be dodged. 200 catches was also ≈ 1.8 h, short of one evening with friends)* |
| **Idle rule** | 40 min of fishing without a move ≥ 10 m or a chat line (S-INPUT's `lastInputAt` minus fishing requests): bites stop ("The fish have lost interest. Stretch your legs.") | no all-night AFK fishing |
| One line per player | — | — |
| No character EXP or SP | — | the climb stays BALANCE's and HOT_SPRINGS' |
| Dish sell ≤ 80 % of the ingredients' sell; shop sell ≤ 48 % of buy | — | no buy-cook-sell loop |
| Treasure gold × `GOLD_RATE`, items × `DROP_RATE` | as monster loot | one economy |
| `/fish stats <name>` | casts, catches and escapes per hour, replay refusals | spot a bot by eye |

### 8.5 The water grid [decision]

The converter bakes **`world/<export>/fishing/water.bin`**: one byte per 2 m cell over the playable area plus a 16 m
ring (the cast's reach: from the S1 pier's end a cast south crosses the bounds line z = 1344 after 8 m; a grid that
stops at the bounds refused it) *(fact-check)*. The playable part is 1,824 × 1,248 = 2.28 MB raw, mostly zero. Each
byte is **4 bits body** (0 = none, 1 = town, 2 = springs, 3–10 = the eight waters of §2.1, 11 = editor water, the
rest spare) and **4 bits depth** in 0.5 m steps (0–7.5 m; the rules need 0.5, 1.0 and 4.0 m). *(fact-check: the first
layout's 3-bit body could not hold the eight waters plus none/town/springs.)* Measured on a prototype bake of the
playable part: **38.6 KB brotli** (q11), 334,593 water cells [confirmed: `factcheck/grid44.mts`; the 3+5-bit layout
was 54 KB, `grid.mts`]. It is built from S-WATERQ's surfaces (the coast field, the water planes, the terrain heights,
the springs' surfaces) plus `content/fishing/bodies.json`, **after** wave 12's world-edits pass (step 6). A pond the
user adds in the World Editor is body 11 and is fishable like a field pond (its depth rules are WORLD_EDITOR D30 and
SWIMMING §2.5). The server loads the grid at start (≈ 2.3 MB in memory); the client fetches it the first time it takes
up a rod and uses it for the cursor. SWIMMING's `swim.bin` has 2-bit classes and per-block surfaces but no depth or
body, so it does not replace this grid. WAVE_PLAN9 may merge the two files; the bytes are the same either way.

### 8.6 Persistence (the next migration after HOT_SPRINGS'; WAVE_PLAN9 numbers them) [decision]

```sql
-- fishing and cooking (docs/FISHING.md §8.6)
CREATE TABLE fishing (
  character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  xp INTEGER NOT NULL DEFAULT 0,
  casts INTEGER NOT NULL DEFAULT 0,
  catches INTEGER NOT NULL DEFAULT 0,
  day_key TEXT,                              -- the real (server-local) day of day_casts
  day_casts INTEGER NOT NULL DEFAULT 0,      -- the daily soft cap counts accepted casts (§8.4, fact-check)
  legend_casts INTEGER NOT NULL DEFAULT 0,   -- eligible casts since the last legendary bite (the pity)
  letters INTEGER NOT NULL DEFAULT 0,        -- bitmask of the 24 letters
  journal TEXT NOT NULL DEFAULT '{}'         -- species -> {n, bestG, firstAt}
);
CREATE TABLE fishing_records (
  species TEXT NOT NULL, character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  grams INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (species, character_id)
);
CREATE INDEX fishing_records_top ON fishing_records(species, grams DESC);
ALTER TABLE characters ADD COLUMN refresh_item TEXT;          -- S-BUFF (teas too)
ALTER TABLE characters ADD COLUMN refresh_left_ms INTEGER;
```

Saved: the fishing row on every catch (one statement), the refreshment at logout and every 30 s while it runs. Back up
the DB before the deploy, as every migration wave does.

### 8.7 GM commands (`/fish …`, one row in `gm.ts` dispatching to the module)

`/fish level <n>`, `/fish xp <n>`, `/fish give <species> [kg]`, `/fish odds` (the roll table here and now),
`/fish legend` (the next eligible cast bites the legendary), `/fish letter <n>`, `/fish stats <name>`, `/fish records
reset <species>`.

---

## 9. Client

### 9.1 world-render: `World.fishing` (`packages/world-render/src/fishing/**`) [decision]

| Piece | Draws | How |
|---|---|---|
| Rods | **1** | one mesh, thin instances; per-instance matrix from the hand bone each frame (characters are node skeletons, `models.ts` joint lookup, so the bone's world matrix is on the CPU), colour and length per rod type, the bend in the vertex shader |
| Lines | **1** | one dynamic ribbon mesh holding every line within 40 m (12 camera-facing segments each, a sag from the tension), CPU-updated |
| Floats | **1** | thin instances; height from the water grid, on the ocean + the CPU wave query (COAST §8.4) |
| Rings and splashes | **1** | thin-instanced alpha quads (plop, nibble, bite, runs, landing); ≤ 64 live |
| The fish held up | +1 per species on display, for 1.5 s | the species glb attached to the left hand at FISH_CATCH; *(fact-check)* species are different meshes, so simultaneous catches of different fish are separate draws: ≤ 3 at once in practice, ≤ 20 in the worst case; LAB-13 scene 1 counts them |
| COOK / EAT props | per actor, while used | the ladle, bowl and pot as sockets (the broom's path) |

- **Created lazily** when the first rod appears; disposed when nobody fishes for 60 s. With nobody fishing nothing exists,
  so **the Low guard and every bench scene are unchanged** [decision].
- Materials: on PBR presets the shared foliage/prop plugin's simple lit path; on Low an unlit colour material. All
  register with the warm-up hooks (no compile on the first cast) and the material-budgets test (no new varying).
- Shadows: **none** [decision, *fact-check*]. The first version had rods cast on High and Ultra as "one caster draw".
  But a caster is drawn once per cascade (Medium 2, High 3, Ultra 4: `render/shadows.ts`). And the G1 rescue's crowd
  budget limits each character's cascades (`setCharacterCascades`), which one thin-instanced rod mesh cannot follow
  per instance: rods would throw shadows for characters that throw none. A 2–3 cm rod's shadow is invisible at play
  distance anyway.
- **No per-frame allocation** in the fishing part (the line ribbon writes into a preallocated Float32Array, the rod
  matrices into the thin-instance buffer) *(fact-check: the wave-11 rescue left the 20-player G1 miss on GC spikes,
  budgets.md "Rescue re-bench"; this part must add none)*.

### 9.2 HUD (`apps/game/src/hud/fishing/**`, the retail 2009 kit)

- **The tension gauge** in the casting-bar place (UI §0, item 5): a `com_casting_gauge`-style frame, 520 × 26 native px,
  the zones and needle of §4.6, tension %, line metres, ten stamina pips, the hint line. Shown only while fishing.
- **The strike ring and "!"** in screen space over the float (the prototype's design).
- **The bait slot**: a small `msgbox_itemwindow` frame left of the gauge while in stance; click to pick a bait from the bag.
- **The catch toast**: the item card (icon, name, weight, "Trophy!" / "New record!" / "New species!") for 3 s.
- **The journal** (J: free today [confirmed: no `'j'` binding anywhere in `apps/game/src`; the single-letter bindings
  are C, F, G, H, I, M, N, P, U, Z plus the main window's tabs]): `mframe` 386 × 413 with
  `com_long_tab` tabs Fish / Letters / Records / Level (§5.7).
- **The cooking window**: §7.5.
- **The buff bar**: the dish's icon with the remaining time (`EffectState.item`).
- **Options → Interface**: "Easy fishing timing" (§4.6).
- Strings in `i18n/en-fishing.ts` (live English text, UI §0 item 8).

### 9.3 Input (`apps/game/src/fishing/input.ts`)

In stance: a click on valid water casts; a click on land walks (and leaves the stance); a click on a monster attacks
(and leaves it); Space casts ahead, strikes, and holds to reel; Esc leaves. **The jump is suppressed in stance**
[decision: Space belongs to the line while fishing]: a Space binding with `when: inStance`, registered after
`movement.jump`, wins while it matches (the KeyMap takes the latest matching binding, `hud/keys.ts`), so `movement.ts`
is not touched; a `jump` request that still arrives ends fishing on the server (§8.1). Out of stance nothing changes.

### 9.4 Sounds (cue table in the sound build; synthesized files from `packages/convert/src/sound/fishing-synth.ts`, seeded, offline) [decision]

| Cue | Source |
|---|---|
| `fishing.cast` | retail `common/batbowswing3.wav` (pitch 0.8) |
| `fishing.plop`, `fishing.nibble` | synthesized (a filtered noise burst, a soft tick) |
| `fishing.bite` | retail `player/mvrunwater.wav` + a small synthesized bell |
| `fishing.reel` (loop while held), `fishing.strain` (a whine from 70 % tension, pitch with T), `fishing.warn` (a chirp) | synthesized |
| `fishing.snap` | retail `ui/itembreak.wav` |
| `fishing.splash` (runs, landing) | retail `player/mvwalkwater.wav` / `mvrunwater.wav` |
| `fishing.land` | retail `ui/itfly_box.wav`; rare: `ui/itfly_rarebox.wav`; legendary: `ui/gacha_win.wav` + `ui/eventcomplete.wav` |
| `fishing.bottle` / `fishing.treasure` | retail `ui/itscroll.wav` / `common/obj_boxopen.wav` |
| `cooking.sizzle` (loop), `cooking.done` | synthesized; retail `ui/itpotion.wav` |
| `cooking.fire` (loop at spots and campfires) | retail `firework/campfire.wav` (added to the export scope with `env/dd_bobble_01/02`) |
| `food.eat` | retail `ui/itpotiondrink.wav` |

All on the effects bus except the fire (ambient); ≤ 3 fishing voices per player in view, ≤ 6 in all, others culled at
30 m (SOUND §5.5's rules).

---

## 10. Balance

### 10.1 Gold [projected, BALANCE §5 as the yardstick]

- ≈ 110 landed catches per hour of fishing (cast 1.4 s + wait 7.5 s mean + strike + fight 6–12 s + catch 2.2 s + a
  little walking ≈ 25–32 s per cycle, minus misses).
- Fish sell ≈ 9 gold on average for the typical mix → ≈ 1,000 gold/h (vendor sales: `GOLD_RATE` does not touch them,
  BALANCE §7); treasure ≈ 0.7 Sunken Coffer an hour at sea or ferry (110 / 150) at ≈ 600 gold × `GOLD_RATE` →
  **≈ 1,450 gold/h at rate 1, ≈ 2,300 at the recommended rate 3**; bait costs ≈ 300/h. *(fact-check: the first text
  rounded the boxes up to 1 an hour, giving 1,600 / 2,800.)*
- Frugal grinding makes 6,000–12,000 gold/h at rate 1 and three times that at rate 3, because `GOLD_RATE` multiplies
  dropped gold (BALANCE §5.1, §7). *(fact-check: the first text set fishing at rate 3 against grinding at rate 1.)*
  **Fishing is a pastime, not a gold farm**; the rare fish (90–200 gold) and the trophies are pocket money.

### 10.2 Time and the climb [projected on BALANCE §3's model]

- **Regeneration dishes** (+20 % / +35 % out of combat): frugal play sits 65–80 % of its time, so a +20 % dish cuts the
  sitting by ≈ 17 % and the frugal climb by ≈ 11–14 %; +35 % cuts it by ≈ 26 % and the climb by ≈ 17–21 % (the
  sitting share is 65–80 %, so the range, not one number *(fact-check)*). Potion-fed play
  (no sitting) gains nothing.
- **EXP dishes** (+5 % / +10 %): the grind time falls by ≈ 5 % / ≈ 9 %; the questline's 30 % share is untouched.
- **One slot** means at most one of these at a time: **≤ 21 % less time for frugal play, ≤ 9 % for potion-fed**, and
  no change in time-to-kill, damage taken, deaths or the spikes at Bandit (16) and White Tiger (18) (BALANCE §6).
- **Move speed +5 %**: ≈ 9 minutes off the questline's 3 hours of walking.
- **Resistances, defence +3 %, max HP/MP +2–3 %**: smaller than one degree of gear (BALANCE §5.3), the size of the
  P0 buffs BALANCE leaves out as "small at these levels".
- **Upkeep**: ≈ 40–80 gold of ingredients per 30 minutes, trivial next to potions.

### 10.3 Rates

`EXP_RATE`, `SP_RATE`, `GOLD_RATE`, `DROP_RATE` keep their meaning: fishing XP has no rate knob (content data instead);
treasure follows `GOLD_RATE`/`DROP_RATE`; the meal's EXP bonus multiplies the rated kill EXP.

### 10.4 Hooks for wave 14 (The Climb) [decision; nothing designed here]

- **All numbers are content:** species, weights, sizes, prices, XP curve, rules, recipes and buff values in
  `content/fishing/*.json`; wave 14 re-tunes data, not code. Buffs are percentages, so a new level curve scales them.
- **The fishing level is separate from the character level**, so the 1–20 re-tune cannot break it.
- **`fishingEligible(p)` and `mealEligible(p, mob)` hooks** (default true): wave 14 can exclude nemesis kills or the
  storm Qilin from the meal's EXP bonus with one predicate (HOT_SPRINGS' `restEligible` pattern).
- **The tomb moat** is the dungeon's doorstep: the Quicksilver Eel and its broth (abnormal-state resistance +20 %, for
  the tomb's zombie and poison statuses), the Tomb Offering Box and its **Tomb Seal Shard** curio, and the bottle
  letter about "rivers of quicksilver": wave 14 may turn the shards into a key or a quest without a migration (the item
  exists).
- **A catch event** on the module bus (`fishCaught {player, species, kg, body}`): a storm-Qilin or nemesis event can
  listen (e.g. "a storm stirs the bay") without touching the fishing module.
- **Kill EXP order** `base × (1 + meal) + rested` is written once in S-REWARD; wave 14's death penalty (from level 15)
  and any new bonus slot in there.

---

## 11. Budgets (WAVE_PLAN8 §5 format; 1080p)

### 11.1 What fishing adds per preset

| Preset | Visuals | When nobody fishes |
|---|---|---|
| Low (Classic) | rods, lines, floats, rings with unlit materials; the clips; the cooking props | **nothing** (lazy part: the Low guard stays green) |
| **Medium (default)** | as Low with the lit prop path; floats ride the worker-FFT ocean's CPU query | nothing |
| High | as Medium; rods cast shadows | nothing |
| Ultra | as High | nothing |

### 11.2 Frame, draws, memory, download [projected unless tagged]

Baselines: the wave-11 rescue re-bench (NIGHT_LOG 03:15, quiet machine, 3 runs): WebGPU Medium 20-player plaza
14.9 ms p95, Tiger Girl with 20 players 14.0–15.0 as the first fight on a page but 16.3–17.3 later on the same page
(G1 red, GC suspected), every other Medium scene ≤ 10.1 (WebGL2 Medium worst 11.6), WebGPU High plaza 9.7 / crowd
10.7, WebGL2 High plaza 8.2 [confirmed there: budgets.md; *fact-check: the first text left out the red Tiger Girl
line*]; wave 12's projections on top (WAVE_PLAN8 §5.2: plaza 20 players ≈ +0.3 ms; the M1 beach 11–15 ms is the
tight spot, G6).

| Preset | Plaza noon, 20 players + crowd (G1's thin scene) | **S1 pier at dusk, 20 players fishing** (new LAB scene) | Beach noon | Pass line |
|---|---|---|---|---|
| Low | unchanged | ≈ 6–8 ms | unchanged | pass |
| **Medium** | unchanged (no fishing water in the plaza's view; the palace ponds are closed) | ≈ 9–13.5 WebGPU / ≈ 7–11 WebGL2: the beach's 1.7 ms (measured) + the 20 players' ≈ 6.6 ms (the plaza's crowd 8.3 → G1 scene 14.9, measured) + dusk lights and fishing (≤ 0.3 ms); the wave-11 page-history effect (+2–3 ms on a later scene) would still leave it under the line, thinly | 1.5–1.8 → + ≤ 0.05 with one angler | **G1 < 16.7 everywhere** (dev PC) |
| High | unchanged | ≈ 14–17 WebGPU (the 20-character High miss of every wave, reported not gated) | + ≤ 0.1 | G2 unchanged |

| Preset | Draws added (all anglers together) | CPU (dev) | GPU (dev) | Laptop / M1 | VRAM | Download |
|---|---|---|---|---|---|---|
| Low | +4 (+1 per species on display for 1.5 s at a catch) | ≤ 0.1 ms with 20 lines (bone reads + 240 ribbon vertices) | ≤ 0.02 ms | CPU × 1.4–2 ≈ ≤ 0.2 ms | ≤ 3 MB | **≈ +0.6–1.0 MB, lazily** *(fact-check: was 0.6)*: fishing pack ≈ 200–230 KB per skeleton (one, or both when both genders fish nearby), water grid ≈ 40–60 KB [measured 38.6 KB for the playable part], fish meshes ≈ 200 KB, props ≈ 40 KB, icons ≈ 50 KB, sounds ≈ 150 KB (Opus) |
| **Medium** | +4 | ≤ 0.1 ms | ≤ 0.05 ms (alpha rings) | M1 GPU ≤ 0.3 ms | ≤ 3 MB | as Low |
| High | +4 (no casters, §9.1) | ≤ 0.1 ms | ≤ 0.05 ms | as Medium | ≤ 3 MB | as Low |
| Server | — | a replay ≤ 0.1 ms [confirmed: `bench.mjs`]; the module ≤ 0.02 ms per angler per tick; the water grid 2.3 MB in memory | — | — | — | **deploy ≈ +1 MB** |

What this means: fishing costs a frame almost nothing; the S1 pier scene is expensive only because 20 characters are
expensive (the performance pass's item, BACKLOG 9). G1 holds on Medium on the dev PC [projected]; LAB-13 measures it.
*(fact-check)* **Not on a base M1:** WAVE_PLAN8 puts the M1 at 11–15 ms on the empty beach, so the S1 pier with a
crowd of friends will run below 60 fps on a base M1 Mac whatever fishing does (fishing's own share there is
≤ 0.3 ms). A handful of anglers is the realistic S1 evening, and the performance pass (character batching, BACKLOG 9)
is the fix, not this wave. The user should hear this plainly (§13).

### 11.3 Per-lane budgets (dev PC, 1080p; the GPU lock for every in-browser timing)

| Lane | Budget |
|---|---|
| FS-R | ≤ 4 draws for any number of anglers (+1 per species held up), no shadow casters; ≤ 0.1 ms CPU with 20 active lines; 0 allocations per frame (a heap-snapshot test over 600 frames with 20 lines); 0 shader compiles after the warm-up; nothing created while nobody fishes |
| FS-G | the gauge and overlays ≤ 0.05 ms main thread while fishing; 0 when not; the simulation ≤ 0.02 ms per frame |
| FS-S | a replay ≤ 0.2 ms; `tickPlayer` ≤ 0.02 ms per angler; the water grid loads in ≤ 50 ms at start |
| FS-A | per clip: feet planted ≤ 1 mm, slide ≤ 1 mm/frame, hands on the rod ≤ 3 cm (≤ 2.5 cm on ≥ 95 % of frames), loops seamless; pack ≤ 240 KB brotli per skeleton |
| FS-D | the deck model ≤ 1,600 triangles, batched with the region (+0 draws); the deck nav round trip bit-exact; Publish checks green |
| FS-SND | ≤ 0.05 ms main thread; ≤ 6 fishing voices |
| FS-W | `water.bin` ≤ 80 KB brotli (measured 38.6 KB for the playable part); client lookup O(1) |

### 11.4 LAB-13 scenes (fishing's share)

1. **The S1 pier at dusk with 20 bots fishing** (casting, fighting, landing on a loop; the GM `/fish` tools drive them),
   Medium and High, both backends; the G1 line.
2. The beach at noon with one angler (the G6 Mac-margin view of WAVE_PLAN8 §5.5: ≤ +0.15 ms dev GPU p50).
3. The moat at the south gate with 5 anglers and the town in view.
4. The cooking spot at the restaurant with 6 cooks (steam, fire, COOK clips).
5. The Low guard (no angler: pixel-identical plaza and field) and a Low run of scene 1.

---

## 12. Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | Fish in eight waters found by the nav survey; the palace ponds inside the walls are closed (by body, D34) | §2.1: data, not guesses; the town stays the hangout |
| D2 | The retail Jangan Ferry pier as is; a new S1 pier (≈ 62 m, from the dry sand) with an authored deck (S-DECK, uid source `content` 0xF000–0xF0FF) | the user's "pier"; the retail jetties are fenced; S1 is the user's beach |
| D3 | Open the two river jetties with S-DECK's edge patch (if a landward edge exists) | a pier 500 m from town for beginners |
| D4 | The rod is a new Blender prop (three), carried as a bag tool; the weapon hides | retail has none; no gear swapping |
| D5 | Cast by clicking the water (Space: straight ahead) | SRO is click-driven; trackpad-friendly |
| D6 | Hold to reel, let go on runs; six fight classes | readable, holds only, skill shows from strong fish up |
| D7 | The bite schedule goes with the cast; one 0.80 s strike window for every fish | ping never costs a bite, and the cast reveals nothing about the catch (fact-check) |
| D8 | The client plays the fight; the server replays it from its seed | authority with no lag; ≤ 0.1 ms per replay |
| D9 | The simulation uses basic arithmetic only | bit-identical on Chrome, Safari and Node |
| D10 | "Easy timing" (warnings +0.15 s, snap grace ×2, +6 m line, +30 s, 1.2 s strike) is an honest assist, applied by the server too | accessibility without a penalty; re-tuned so it helps in every measured case (fact-check) |
| D11 | 19 species (sea ids shared with UNDERWATER), junk, 3 treasures, UNDERWATER's key, 24 bottle letters, 1 legendary | the user's "rare catches", with variety by place and hour |
| D12 | The legendary: a Golden Grain groundbait scatter, fishing 7, river or ferry; ×9 at twilight in rain; a soft pity (1/240,000 a cast, ×2 after 200) | a chase with a story, ≈ 3 h of eligible fishing per bite, never impossible; a grain per cast cost ≈ 70 Koi a bite (fact-check) |
| D13 | Fishing level 1–10 from fishing XP; no character EXP or SP | the climb's arithmetic stays in one place |
| D14 | Personal spot fatigue, a daily soft cap of 400 casts on rare rolls, an idle rule | bound bots without bothering humans; casts cannot be dodged by cutting lines, and friends never fish a spot out for each other (fact-check) |
| D15 | Treasure follows GOLD_RATE / DROP_RATE | one economy |
| D16 | Cooking at stoves, braziers, pier campfires, the springs and a Campfire Kit | "in town and at camps"; friends cook together |
| D17 | Cooking always succeeds, 2.5 s per dish, batches of 10 | the fun is in the fishing |
| D18 | One refreshment slot shared with the teas; persisted, online time only, kept through death | HOT_SPRINGS' S-BUFF; small values |
| D19 | Buffs only touch out-of-combat regen, speed, kill EXP, resistances, defence and max HP/MP by small amounts | "small buffs" that never trivialise combat |
| D20 | Kill EXP = base × (1 + meal) + rested | the springs' pool unaffected; one formula |
| D21 | The Dragon Gate Feast feeds the party; the legendary cannot be sold or traded | a social trophy, not gold |
| D22 | Authored items and shops in `content/items/*.json` and `content/shops/*.json`, merged by the data export (S-ITEMS, S-SHOP) | one file for server and client; the springs share it |
| D23 | Two authored NPCs: Ahn (moat bridge) and Mei (the stove) | discoverable at the town's door |
| D24 | Three short quests unlock the later recipes | a gentle tutorial and a reason to explore |
| D25 | Clips keyed in Blender with a `key_fish.py` that extends the town keyer (one-shots, a keyed rod, the left hand on the rod) | proven by the prototype; one tooling home |
| D26 | Fish meshes from UNDERWATER's bpy creature generator (S-FISHMESH) | one look, one tool |
| D27 | Rods, lines, floats and rings each one instanced draw; created lazily; no shadow casters; no per-frame allocation | +4 draws for any crowd; the Low guard; no GC (fact-check) |
| D28 | A baked 2 m water grid (4-bit body, 4-bit depth, the playable area + a 16 m ring), shared by client and server | the cursor and the server agree; 38.6 KB brotli measured (fact-check) |
| D29 | Space is the line in stance (no jump) | one button, no accidents |
| D30 | Sounds: retail first, the rest synthesized offline with a seed | no download; reproducible |
| D31 | Meshy: 0 credits in the design, 0 planned for the build | the trees' bake-off showed Meshy loses to bpy for small stylised props; the fish follow UNDERWATER's bpy route |
| D32 | The tomb moat, the eel, the box and its shard as wave-14 hooks | a doorstep, not a design |
| D33 | Not while swimming, mounted, trading or stalling; damage ends fishing | clean state rules |
| D34 | Fishing is closed by water body (the palace ponds, the springs), not by the town's safe-area box | the box holds the nearest moat spots (fact-check) |
| D35 | One species list with UNDERWATER (`content/sea/species.json` ids for sea fish; Silver Sardine and Coral Snapper added) | "the fish you catch are the fish you see" (fact-check) |
| D36 | The Rusty Bronze Key: sea, bay and ferry 1 in 200 catches, river 1 in 400; the Jade Tortoise window doubles rare fish within 80 m | UNDERWATER's tie-ins, rates set here (fact-check) |
| D37 | Swim and breath on two existing dishes (Hairtail swim +10 %, Croaker breath +30 %); Kelp and Sea Urchin as alternative ingredients | SWIMMING's `swimMul`/`breathMul` hooks and UNDERWATER's gathering get a use without new dishes (fact-check) |
| D38 | The pier carries solid piles and SWIMMING `exits` ladders | swimmers pass under the deck, climb back up (fact-check) |

---

## 13. Needs from the user

1. **Look at the cast/reel GIF** (`work/tmp/fishing/out/fish_cast_reel.gif`). **Default:** build the clips in this style.
2. **Play the prototype page** for two minutes (serve `work/tmp/fishing/minigame` locally and open `index.html`; a
   laptop trackpad is the best test). **Default:** these numbers.
3. **Optional: write a few bottle letters** (a line or a paragraph each, any tone; in-jokes about the friends welcome).
   **Default:** all 24 written by Claude.
4. **One check on a Mac in Safari** after the build: land three fish; the replay must accept them. **Default:** ship on
   the language rule (§4.4) and the Chrome/Node evidence.
5. **The deploy OK** for wave 13, as every wave. **Default:** nothing deploys until you say so.

Nothing else: no download, no Meshy, no account.

**To know (not to decide)** *(fact-check)*: on a base M1 Mac the S1 beach alone is projected at 11–15 ms
(WAVE_PLAN8 §5.2), so a crowd of friends fishing at the S1 pier will run below 60 fps there until the performance
pass. Fishing itself adds ≤ 0.3 ms. A few anglers, or the moat and river spots, are fine.

## 14. Open questions (each has a default, so nobody waits)

| # | Question | Default | Who settles it |
|---|---|---|---|
| Q1 | The S1 pier's look | ≈ 62 × 4 m from the dry sand: wooden planks, square posts, a rope rail, two ladders, a bench and a lantern at the end; retail painted palette | the user at the review sheet |
| Q2 | Fishing in the town's palace ponds | closed | the user |
| Q3 | Should the refreshment survive death and logout | yes (paused offline) | the user |
| Q4 | May the legendary be traded | no | the user |
| Q5 | Server-wide notices for records and the legendary | yes, one chat line each | the user |
| Q6 | Fishing gives character EXP | no | the user |
| Q7 | The journal's key | J (free today), plus a MENU entry | FS-G with the key help |
| Q8 | The tomb moat before wave 14 | open | WAVE_PLAN9 |
| Q9 | The river jetties' landward edge | open them if one edge faces the bank | FS-D |
| Q10 | The Campfire Kit's fire as a server entity (a new `EntityState.kind`) | yes; cut 1 if the seam is costly | WAVE_PLAN9 |
| Q11 | Golden Grain only from cooking | yes | the user |
| Q12 | The bottle letters in other languages | English only (UI rule) | — |
| Q13 | Easy timing on by default? *(fact-check)* | off by default, one click in Options; the catch toast of a lost legendary suggests it once | the user after user check 2 |
| Q14 | The Rusty Bronze Key's rate (UNDERWATER Q10) *(fact-check)* | sea/bay/ferry 1 in 200 catches, river 1 in 400 | WAVE_PLAN9 with UNDERWATER |

---

## 15. Lanes

### 15.1 Step order (inside wave 13; WAVE_PLAN9 merges it)

```
step 0 (the wave's seam agents): protocol + validate rows (§8.2); ItemDef/EffectState additions; S-ITEMS/S-SHOP formats
        and the data-export merge; S-REWARD / S-REGEN / S-INPUT (HOT_SPRINGS' seams, one owner); the convert pass slot
        for S-DECK and the S-UID `content` row; S-WATERQ (SWIMMING) + the body channel slot; the moves pack kind
        `fishing`; the World part slot `World.fishing`; the sound cue rows; `requires.fishing` in the quest schema
step 1: FS-P (shared fishing: sim, roll, content types, validators) | FS-I (items, shops, icons) | FS-C (content rows,
        NPCs, quests, letters) | FS-A (clips, both skeletons; props) | FS-M (species rows → S-FISHMESH) | FS-D (decks, the
        S1 pier model) | FS-W (bodies, the grid) | FS-SND
step 2: FS-S (server modules, migration rows) | FS-K (cooking + S-BUFF) | FS-R (render part) | FS-G (client, HUD)
step 3: the wave's integration, LAB-13 (§11.4), the hunt (§15.4), fixers, the final gate, the independent verify
```

### 15.2 The lanes

Effort in agent-days.

| Lane | Owns (files) | Seams it uses | Tests | User check | Effort |
|---|---|---|---|---|---|
| **FS-P** shared | `packages/shared/src/fishing/**` (`sim.ts` from the prototype, `roll.ts`, `types.ts`, `validate.ts`, `recipes.ts`) | step 0 protocol rows | `fishing-sim.test.ts` (recorded toggle fixtures → the same outcome and step; no `Math.` transcendental in the file, a lint test; the four player models' bands of §4.5 within ±5 points); `fishing-roll.test.ts` (100k rolls per body within ±2 % of the weights; legendary eligibility; pity; caps) | — | 1.5 |
| **FS-I** items + shops (S-ITEMS, S-SHOP) | `packages/convert/src/data/authored.ts` (new), one line in `data/items.ts` and `data/shops.ts`, `content/items/fishing.json`, `content/shops/fishing.json`, `content/items/icons/**`, the icon renders (`tools/blender/fishing/icons.py`) | step 0 formats | merge: a retail collision, a missing icon, a sell above buy are errors; the springs' file merges too; `items.json` round trip | open the shops | 1.5 |
| **FS-C** content | `content/fishing/{species,bodies,rules,recipes,letters,cook-spots,piers}.json`, `content/quests/fishing.json`, the two NPC rows (GM tool → `npcs.override.json`), the `drops.json` ingredient group (through the converter's drops override) | FS-P validators; QUESTS checker | `quests-content-check` green; every species reachable in some water; every recipe's ingredients obtainable | read three letters | 1.5 |
| **FS-A** animations + props | `content/moves/<skel>/fishing/*.json` (9 × 2), `packages/convert/tools/blender/fishing/{key_fish.py, props.py}`, `packages/convert/src/tools/fish-clips.ts`, the `pnpm sro moves --fishing` flag | step 0 pack kind; `blenderExe` | per clip §11.3's numbers from `fish_keys.json`; the pack index; retarget 0 unmapped joints on all 26 bodies | the GIF sheet per skeleton | 3 |
| **FS-M** fish meshes | `content/fishing/species.json` shape rows (with FS-C), the catch-display glbs via S-FISHMESH | UNDERWATER's generator | 19 species + 5 extras ≤ 400 triangles; icons rendered | the fish sheet | 0.5 |
| **FS-D** decks (S-DECK) + the S1 pier | `packages/convert/src/world/decks.ts` (new pass), the nav append, `tools/blender/fishing/pier.py`, `content/fishing/piers.json` (with the pier's SWIMMING `exits` rows) | step 0 pass slot; the S-UID `content` row (0xF000–0xF0FF); WORLD_EDITOR's Publish checks; SWIMMING's `insideSolid` | walk on/off; reach from town; no trap; deck height ±2 cm; the landward edge on the sand ±5 cm; piles solid to a swimmer; the ladders reach the deck; the jetty edge patch; byte-identical export without `piers.json`; a uid outside `content` throws | walk to the end of the S1 pier | 2.5 |
| **FS-W** water bodies | the body channel of S-WATERQ's grid (`packages/convert/src/world/fishing-water.ts` or SWIMMING's file per WAVE_PLAN9), `bodies.json` rules | S-WATERQ; runs after the world-edits pass | the survey's counts within ±5 % per body; the palace ponds answer `town`, the springs `springs`; the moat inside the safe-area box stays fishable; an editor pond answers 11; a cast from the S1 pier's end over the bounds line is water | — | 0.5 |
| **FS-S** server | `apps/server/src/fishing/**`, the migration's statements in `db.ts` (rows only), `gm.ts` `/fish` row | S-REWARD, S-INPUT, S-STATS; FS-P | real-server integration: cast → strike → report → item; every §4.4 refusal; bag full; bait taken; gates; caps; fatigue; idle; records; migration vN−1 → vN; one abuse test per §8.4 row | `/fish odds` at the moat | 3 |
| **FS-K** cooking + S-BUFF | `apps/server/src/{cooking, refreshment}.ts`, the campfire entity | S-REGEN, S-REWARD, `addModProvider`; HOT_SPRINGS' teas | recipes, spots, cancel on move, batch; the slot (replace, persist, death, login); EXP order with Rested; the Feast's party share | cook at the stove | 2 |
| **FS-R** render | `packages/world-render/src/fishing/**` | `World.fishing` slot; warm-up hooks; COAST's wave query | the Low guard; nothing created at count 0; 4 draws with 20 anglers; material budgets; no new varying | watch a friend fish | 1.5 |
| **FS-G** client | `apps/game/src/fishing/**`, `apps/game/src/hud/fishing/**`, `i18n/en-fishing.ts`, `world/features/fishing.ts`, `audio/fishing.ts` | the HUD kit; FS-P; FS-R | the input map (stance, cast, strike, hold); the replay of a played fight in a test page; the gauge at UI scales 1–3 | the ten-minute session | 3 |
| **FS-SND** sound | `packages/convert/src/sound/fishing-synth.ts`, the cue rows, the scope additions | the sound build | same seed → same bytes; cue table resolves | listen at the pier | 0.5 |

Totals ≈ **21.5 agent-days**, most of them parallel [projected].

### 15.3 Seams shared with the other wave-13 specs (WAVE_PLAN9 names one owner each)

| Seam | What fishing needs | Default owner |
|---|---|---|
| S-ITEMS, S-SHOP | the authored item and shop files and their merge | **FS-I** (HOT_SPRINGS agrees) |
| S-BUFF | the refreshment slot | **FS-K** (HOT_SPRINGS agrees) |
| S-REWARD, S-REGEN, S-INPUT | the meal's EXP, regen multiplier, idle rule | HOT_SPRINGS' step-0 agent |
| S-STATS | `fishingLevel`, `fishingXp` | the wave's protocol seam agent |
| S-WATERQ | water kind and depth; fishing adds the body channel | SWIMMING's water lane |
| S-FISHMESH | the species meshes | UNDERWATER's creatures lane |
| S-MOVES | the `fishing` pack kind beside SOAK and SWIM_* | the wave's MV lane |
| S-DECK | authored walkable decks | **FS-D** (SWIMMING may want ladders off the pier later) |
| The S1 trail nests patch | HOT_SPRINGS §2.4 | HS-E |
| Migration numbers | `fishing`, `fishing_records`, `refresh_*` | WAVE_PLAN9 |
| S-UID `content` row *(fact-check)* | 0xF000–0xF0FF for authored decks (piers) | the wave's convert seam agent (step 0) |
| Sea species ids *(fact-check)* | `content/sea/species.json` ids for the sea fish (§5.2) | UNDERWATER's UW-L |
| S-REWARD order *(fact-check)* | springs on the rated `e`, then the meal (and any other EXP %) on `e` | HOT_SPRINGS' step-0 agent |
| SWIMMING `exits` and solids *(fact-check)* | the pier's ladders and piles | FS-D writes them, SWIMMING's lane reads them |
| `requires.fishing` *(fact-check)* | JG_F03's fishing-level gate | FS-C with the QUESTS checker |

### 15.4 Hunt lenses (added to the wave's hunt)

1. **Replay forgery:** a report with an impossible sequence, early, late, duplicated, for another cast; a strike before
   the bite; toggles unsorted or over 512; *(fact-check)* any field of `fishCast` that differs by the rolled class (a
   re-roll oracle); `fishStop` + re-cast before the bite step; cutting every hooked common line to dodge the daily cap.
2. **Desync:** a fight played at 30 fps and 144 fps, in a background tab, across a GC pause, on Safari.
3. **Economy:** buy-cook-sell loops; treasure at rates 1 and 5; a bot at the daily cap.
4. **State:** fishing then mounting, trading, swimming, warping, dying, logging out mid-fight; a full bag at the catch.
5. **The meal slot:** tea replaces dish and back; death; relog; the Feast on a party member far away.
6. **Low and the benches:** no angler = no change; 20 anglers = 4 draws; no compile at the first cast.
7. **Nav:** the S1 pier deck reachable and leavable; no trap at its end; the jetties.

### 15.5 User checks (after the build)

1. Fish the moat with a trackpad for ten minutes: cast, nibbles, strikes, a strong fish.
2. Take a friend to the S1 pier at dusk: both fish, see each other's lines, cook at the campfire, eat.
3. Read a bottle letter (GM `/fish letter 3`) and open a treasure box (`/fish give`).
4. On a Mac in Safari: land three fish.

---

## 16. Scope-cut order (cut from the top)

1. The Campfire Kit (the new `fire` entity); cooking stays at the fixed spots.
2. Others see your line (viewers see the rod and the poses; your own line only).
3. The river jetties' edge patch.
4. The server-wide records board and its notices (the journal keeps your own).
5. The fishing quests (the recipes unlock at fishing levels 3 and 7 instead).
6. The EAT clip (dishes eat instantly with the drink sound).
7. Bottle letters 24 → 8 (the collection reward at 8).
8. Trophy sizes (fish have no weight; records off).
9. FISH_STRIKE (CAST's end covers it).
10. The tomb moat's species, box and shard (the hook moves to wave 14).
11. Cooking batches (one dish per click).
12. **Ask first:** the S1 pier (S-DECK); the Jangan Ferry pier remains the user's "pier".

**Never cut:** the catch mini-game with the server's replay; fishing at S1, the moat, the river and the ferry pier; the
legendary, treasure and the bottle easter egg (at ≥ 8 letters); the fishing level; FISH_IDLE, CAST, REEL, CATCH and
FAIL on both skeletons; cooking at the town stove with the small buffs of §7.2 in the shared slot; the anti-bot and
economy rules of §8.4; fishing on Low; the Low guard; G1.

---

## 17. Risks

| Risk | Default handling |
|---|---|
| Safari's JavaScriptCore disagrees with V8 on a replay | basic-arithmetic rule + a lint test; user check 4; if one appears, the server accepts the client's outcome when its own replay differs by ≤ 2 steps and logs it |
| Players find the fight too hard on a trackpad | "Easy timing"; the class numbers are content; LAB-13's play session |
| S-DECK takes longer than planned | cut 12 (ask first); fish from the S1 beach and the ferry pier |
| The female clips need more than a reach check | per-skeleton key files (the jump's route) |
| Bots | §8.4; `/fish stats`; a friends' server |
| The meal slot conflicts with the teas' design | one owner (FS-K) for S-BUFF; HOT_SPRINGS' rules adopted |
| The 20-player pier scene misses G1 | it is the characters' cost (BACKLOG 9); fishing adds ≤ 0.3 ms; the performance pass follows this wave |
| A base M1 at the S1 pier with friends *(fact-check)* | below 60 fps (the beach alone is 11–15 ms on an M1); told to the user (§13); the performance pass |
| The legendary feels out of reach *(fact-check)* | `factcheck/legend.mjs` and `humans.mjs` give ≈ 5–15 h per landed fish; the odds, pity and Easy timing are content; LAB-13's play session and the first week's `/fish stats` |
| Fishing feels like a chore | XP pace, no character EXP, generous commons, the social spots |

---

## Appendix A: scratch files (`work/tmp/fishing/`)

| File | What |
|---|---|
| `spots/probe.mts` | the coast field's orientation |
| `spots/survey.mts` → `shore.json` | the fishable-point survey (the server's `MeshNav`) |
| `spots/map.py` → `out/fishing_spots_map.png`, `classes.json` | the body classes and the map |
| `spots/jetty.mts`, `spots/jetty2.mts` | the piers' walkability and reach |
| `minigame/sim.js` | the fight simulation and the replay |
| `minigame/index.html` (+ `serve.py`, 127.0.0.1:5198, stopped) | the playable prototype (the expert bot button, a manual pump for hidden tabs) |
| `minigame/tune.mjs`, `minigame/bench.mjs` | §4.5's table, the replay's cost |
| `blender/key_fish.py`, `blender/keys/fish_cast_reel.json` | the keyer extension and the key poses |
| `blender/out/fish.blend` (holds the retail mesh: stays in `work/`), `fish_keys.json` | the keyed clip and its measurements |
| `blender/frames/**` → `out/fish_cast_reel.gif`, `out/fish_cast_reel_filmstrip.png` | the renders |
| `out/minigame_states.png` | the four prototype states |
| `factcheck/windows.mts` | a year of the clock and weather: twilight, rain, the twilight-rain window, full-moon nights |
| `factcheck/humans.mjs`, `easy_why.mjs`, `easy_fix.mjs`, `sim_easy.js` | attentive-player catch rates; why the first Easy timing hurt; the re-tuned Easy timing |
| `factcheck/legend.mjs` | the legendary's expected casts with the pity |
| `factcheck/s1pier.mts`, `s1shore.mts` | the depth along the S1 pier line and the waterline |
| `factcheck/jetties.mts`, `placements.mts` | all 9 retail jetties' reach; braziers, piers, restaurant placements |
| `factcheck/grid.mts`, `grid44.mts` | the water grid's measured size (3+5 and 4+4 bits) |

Run notes: `pnpm tsx work/tmp/fishing/minigame/tune.mjs`; Blender: `"C:\Program Files\Blender Foundation\Blender
5.2\blender.exe" --background --factory-startup --python work/tmp/fishing/blender/key_fish.py -- <abs char.glb>
<abs keys.json> <abs out> chinaman --render <abs frames>` (absolute paths: Blender resolves a relative render path
against the drive root).

## Appendix B: Meshy ledger

**0 credits** spent by this design; no job, so no NIGHT_LOG row. The build plans 0 (D31).
