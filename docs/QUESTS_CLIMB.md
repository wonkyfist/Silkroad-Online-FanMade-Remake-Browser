# The Climb's quests (levels 1–25): "The Storm Anchors"

The user's words, verbatim:

> Re-create all quests from level 1-25. Make them fun, and unique. Unique and creative experiences with the quest. Use
> all features we created and make quests out of it as well. Combine it with the CLIMB phase.

This spec **replaces every quest in `content/quests/jangan.json`** with a new questline for the level-25 Climb
(docs/CLIMB.md, rebased to 25 on 2026-10-08). It owns the story, the 48 quests and 4 dailies, their steps, the
features each one uses, the rewards inside the Climb's EXP budget, and the engine work the quests need. CLIMB.md owns
the curve, the bands, the monsters, the gear tiers and the build order (CLIMB §20 places this spec's work in layers).

**The user delegated every decision.** Choices are written as **[decision]** with a one-line reason.

**Tags** (as in CLIMB.md): **[confirmed]** checked in the code or data on 2026-10-08 (each says how); **[projected]**
computed by `work/tmp/climb25/`; **[decision]** a choice made here; **[unknown]** open, with the default.

**The high country (2026-10-10).** Jangan is an island in the open sea (docs/COAST.md §4.1, CLIMB D52): the far bank
across the strait is gone, and B7/B8 live on the island's own heights, **the Ferry Heights** (the ferry landing and
the ridge above it, North-Tiger Mt.'s north-west) and **the Sea Cliffs** (the west rim over the sea). Act V's quests
keep their ideas and move there: no ferry crossing, the beacon lights the old pier for the fishing boats, the miners,
hives and Hyungno dead are on the Ferry Heights, Hyeongcheon's lair is on the Sea Cliffs' south-west crest.

**Design only.** No file under `packages/`, `apps/`, `content/` or `deploy/` was changed. Scratch:
`work/tmp/climb25/quests25.ts` (the reward table of §5).

**The world these quests live in** [decision, from the brief]: the world map shows **only the Jangan region, surrounded
by ocean**; Donwhang is gone. No quest points outside the island: every location is in the Jangan fields, on the
**Ferry Heights** (the ferry landing and the ridge above it) or on the **Sea Cliffs** (the island's west rim), inside
the play bounds *(2026-10-10; was the far bank of the river and the Canyon Mouth, now open sea)*. The story turns the
map change into its first scene.

---

## 0. Summary

1. **One story, five acts, 31 main quests**, from the millet fields to the Tiger Queen at 24 (§2). The night the sea
   swallowed the western road, Jangan became an island, and the storms doubled. The cause is a ring of **storm
   anchors**: tiger-bone talismans that grave robbers dig out of the old tombs and sell to **Heukpung, the Black
   Wind**, whose bandits want Jangan's walls down; behind him, on the sea cliffs at the island's west end, **Hyeongcheon,
   the Canyon Lord**,
   gathers the anchors to call one great storm and wake the **Tiger Girl at her full strength**.
2. **17 side quests and 4 dailies** that each turn one built feature into a scene (§3): alchemy, stalls, guilds,
   horses, Berserk, parties, storms, lightning rods, the tornado, Master Mason Ko's walls, Thunder Kegs, Hunters and the
   Stockade, the Siege of Jangan, Play the Boss, winter snowballs and the Ice Yeti, the Tomb, the Qilin and nemeses.
3. **No "kill 10 X" filler.** Every quest has a twist: follow a fleeing weasel to its den, tail a masked buyer through
   town without being seen, see through a tiger's eyes for four minutes, plant copper rods and wait for a storm to
   charge them, run into a tornado on purpose, catch an outlaw for the Stockade, defuse three fuses against the clock.
4. **The quest EXP stays inside the Climb's budget** (§5): 50 / 35 / 30 / 25 / 20 % of each level's bar by band, **376,671 EXP, 24 %
   of the curve** (≈ 23 % of what a friend earns, with re-earned penalty losses); event-gated and seasonal quests pay a percentage of the level instead, outside the budget,
   so a week without a storm or a siege never slows anyone.
5. **Engine work is named and sized** (§6): one generic quest-event feed (E1) does most of it; eleven smaller pieces add
   conditions, snares, scorch pickables, player lightning rods, a quest outlaw, a tail, a spirit walk, practice kegs,
   charged drops, a bell toll and ambushes. **About 13 agent-days**, cuttable from the top (§7).
6. **Which quests go** (§1): all 35 quests of "The Tiger's Shadow" (JG_001–026, JG_S01–S05, JG_R01–R04) and the 13
   planned-but-unbuilt CLIMB quests (JG_X01, JG_X07, JG_X10–X21). Their best ideas are kept and re-cast.

---

## 1. What goes

[confirmed: `content/quests/jangan.json` read on 2026-10-08: 31 quests and 4 dailies; CLIMB §8.2's 13 new quests were
never built: no `JG_X` id in the file]

| Old quest(s) | Fate | Where its idea lives now |
|---|---|---|
| JG_001 Welcome to Jangan, JG_S05 Dressed for the Road | removed | CQ_01 "Salt on the Wind" |
| JG_002 Pests in the Millet, JG_003 Herbs and Hides | removed | CQ_02 "The Fat Thief of the Millet" |
| JG_004 The Boy Who Hears Everything | removed | Sochil returns in CQ_04, CQ_28 |
| JG_005 Eyes in the Grass, JG_006 Ash Beads | removed | CQ_03 "Lanterns for the Lost" |
| JG_007 A Blade Worth Carrying | **kept in spirit** (same giver and reward tier) | CQ_05 |
| JG_008 The Stolen Seal | removed | the Jade Seal story is dropped for the storm anchors |
| JG_009 The Exorcist Beyond the Wall | **kept in spirit** | CQ_09 |
| JG_010 Salt for the Swamp, JG_011 Drowned Lanterns, JG_012 What the Water Remembers | removed | CQ_10, CQ_11 (healers, the swamp vision) |
| JG_013 Grave Matters, JG_014 Talismans of Bone | removed | CQ_13, CQ_15 (the talismans become storm anchors) |
| JG_015 Tracks in Yeoha's Forest | **kept in spirit** | CQ_19 |
| JG_016 Cut the Supply Line, JG_017 Hwajung's Missing Caravan | removed | CQ_21 (saltpeter), CQ_39 (the silk run) |
| JG_018 Fengil's Lost Patrol, JG_019 Stripes on the Road | removed | CQ_30 |
| JG_020 The Masked Buyer | **kept in spirit** | CQ_28 (now a tail) |
| JG_021 Storm the Stronghold, JG_022 The Cipher of Bones | removed | CQ_34 |
| JG_023 Fangs for a Bell, JG_024 The Bell-Maker's Price | removed | CQ_33 (the Town Bell) |
| JG_025 Night on Tiger Mountain, JG_026 Dawn over Jangan | removed | CQ_46 "Night of the Tiger Queen" |
| JG_S01 A Letter from Afar, JG_S02 Mrs Jang's Order, JG_S03 Juho's Wager, JG_S04 Strings for a Zither | removed | Juho's wager returns as CQ_20 (Berserk) |
| JG_R01–R04 (dailies) | removed | CQ_R1–R4 |
| CLIMB JG_X01, X07, X10–X21 (planned) | superseded | the bounties are CQ_07, 17, 25, 29, 34, 43, 45; the penalty intro CQ_26; the ferry CQ_37 |
| TOMB_DUNGEON's JG_T01 "The Emperor's Door" | **kept** (TOMB_DUNGEON's) | between CQ_29 and CQ_36, at 16 |

Locations `LOC_*` and quest items `QITEM_*` of the old file are reused where they fit (the millet fields, the swamp
heart, the Old Tiger Shrine, the Robbers' Camp, the Tiger Mountain Shrine); the new file adds its own.

---

## 2. The story

- **Act I, "Salt on the Wind" (1–5, the Millet Fields).** The newcomer arrives the morning after the sea rose: the
  western road is under water and Jangan is an island. Chief Hwangno: "Now we only have ourselves." Fat Mangyang raid
  the last of the millet, ghosts wander with lanterns, weasels steal everything that shines, and Old Scar the Weasel
  King rules the Hill of Ye.
- **Act II, "The Drowned and the Storm" (6–10, Lake, Swamp, Old Graves).** Exorcist Miaoryeong reads thunder in your
  palm. The Drowned Magistrate holds court in the swamp. Priest Kushyan reads the tiger-bone talismans robbed from the
  old graves: they are **storm anchors**, and someone is planting them in a ring around Jangan.
- **Act III, "Robbers, Graves and a Licence" (11–15, Yeoha's Forest, the Tomb Approach).** The robbers who dig the
  anchors also smuggle saltpeter for Thunder Kegs. Gwangmu the Robber Chief falls. At 15 the ancestors warn you that
  death now costs, and Captain Yun hands you a Hunter's licence.
- **Act IV, "The Black Wind" (16–20, the Tiger Mountains, the Tomb).** You tail the masked buyer to the Stronghold:
  Heukpung, the Black Wind, buys anchors and kegs to break Jangan's walls. A shaman's brew lets you see through a
  tiger's eyes and find the Tiger Girl's den. Heukpung falls; his war plan names a buyer on the western heights.
- **Act V, "The Canyon Lord" (20–24, the Ferry Heights, the Sea Cliffs).** The old ferry landing becomes the last camp
  of the climb. The Hyungno dead march on the ridge above it under Mo-Dun; on the Sea Cliffs, **Hyeongcheon** holds the
  anchors. When he falls the
  storms break, and the Tiger Girl, freed of the anchors' leash, wakes at full strength: the **Night of the Tiger
  Queen**, the climb's last quest, at 24, for a party.

**Cast** [confirmed: `work/out/data/npcs.json`, `packages/shared/src/siege-*.ts`]: Soldier Fengil, Chief Hwangno,
Bagger Sochil, Priest Jeonghye, Priest Kushyan, Blacksmith Chulsan, Herbalist Yangyun, Exorcist Miaoryeong, Merchant
Associate Hwajung, Hunter Associate Gwakwi, Juho, General Sonhyeon, Guild Manager Leebaek, Stable-keeper Machun,
Ferry Ticket Seller Doji, Specialty Trader Seopok (under the Stronghold), Event So-Ok, Master Mason Ko, Captain Yun, Warden Bae.
**New NPCs** [decision: a retail model each, no new art]:

| New NPC | Model | Where | Why |
|---|---|---|---|
| **Scholar Ha-yeon, the Weather-Watcher** | Gisaeng Ahjin (`NPC_CH_KISAENG3`), a parasol prop if the wardrobe lane has one | on the town's north wall walk, by a brazier | the storm quests' giver: she measures lightning, tornadoes and the Qilin |
| **Boatman Sagong** | Doji (`NPC_CH_FERRY`) | the ferry landing's old pier, by Chau (−1887, 31) *(2026-10-10; was the far bank's landing)* | Act V's quest hub: the boatman who stayed when the sea took the far bank |
| **Slippery Dok** (quest outlaw) | Bandit Subordinate (`MOB_CH_BANDIT_CLON`) | spawned by CQ_27 | the Hunter's first catch (E6) |
| **The Masked Buyer** (walking NPC) | Bandit (`MOB_CH_BANDIT`), non-hostile | spawned by CQ_28 | the tail (E7) |
| Quest monsters: **Gwiggi the Fat** (Mangyang champion), **the Lantern-Eater** (Big-Eyed Ghost champion), **the Banner-Bearer** (Hyungno Ghost Soldier elite), **the spirit tiger** (Young Tiger) | retail models and variants | encounters | |

---

## 3. The quests

Each quest: id, level, kind, giver → turn-in, the pitch (the experience), the steps (existing objective types:
`kill`, `collect`, `talk`, `deliver`, `have`, `reach`, `useItem` with an encounter [confirmed: `QUEST_OBJECTIVE_TYPES`
in `packages/shared/src/quests.ts`]; new ones marked **E…**, §6), the features it uses, the rewards (EXP, SP and gold
in §5) and its engine needs. "**Data only**" means a content row in the quest file and nothing else. Monster codes are
the Climb's derived rows (CLIMB §2.2); the quest engine matches a derived kill by its base (CLIMB §8.1, D11).

### Act I: "Salt on the Wind" (levels 1–5, the Millet Fields)

#### CQ_01 "Salt on the Wind" (1, main) — Soldier Fengil → Chief Hwangno
- **Pitch.** Fengil, red-eyed from a night on the wall, hands you his spyglass: "Go to the south beach and look west.
  Then tell the Chief what you saw." From the sand you see sea where the Donwhang road used to be. The Chief takes it
  quietly: "Then we only have ourselves. Good. We were always enough." The first quest *is* the new map.
- **Steps.** `reach` Jangan South Beach (S1, against the town wall); `useItem` Fengil's Spyglass there (a centre-screen
  vision: "Where the road ran yesterday, the sea rolls grey to the horizon."); `talk` Hwangno.
- **Uses.** The island map and the coast. **Rewards.** 5 HP Recovery Herbs, 2 Return Scrolls. **Data only.**

#### CQ_02 "The Fat Thief of the Millet" (1, main) — Chief Hwangno
- **Pitch.** The Mangyang have found the last millet. The Chief gives you a sack of spoiled seed as bait: put it down
  in the field and out waddles **Gwiggi the Fat**, a champion Mangyang twice the size of the others, with four
  hangers-on, carrying the village's seed pouch in its cheeks.
- **Steps.** `useItem` Bait Sack at the millet fields (`LOC_MILLET_FIELDS`) → encounter: Gwiggi (Mangyang 1, champion
  variant, `hpMul` 0.8) + 4 Mangyang; `collect` the Seed Pouch (Gwiggi 100 %); `talk` Hwangno.
- **Uses.** Encounters, the champion variant (the newcomer meets a "big one" safely). **Rewards.** Choice of a degree-1
  grade-A weapon (T1). **Data only.**

#### CQ_03 "Lanterns for the Lost" (2, main) — Priest Jeonghye
- **Pitch.** The small ghosts of the grassland drift in threes (the **pack** role: hit one, its friends come). Jeonghye
  needs their ash for a lantern that calls the lost home; light it at the field shrine and something hungry comes for
  the light: **the Lantern-Eater**.
- **Steps.** `collect` 6 Ghost Ash (Small-Eyed Ghost 2, 40 %); `useItem` Ash Lantern at the southern grassland
  (`LOC_SOUTH_GRASS`) → encounter: the Lantern-Eater (Big-Eyed Ghost 3, champion, `hpMul` 0.7); `talk` Jeonghye.
- **Uses.** Pack pulls (CLIMB §2.3), an encounter. **Rewards.** Ring 01_A. **Data only.**

#### CQ_04 "Follow the Runner" (3, main) — Bagger Sochil
- **Pitch.** Sochil's mother's hairpin was stolen by a weasel. "Don't kill it! Hit it till it runs, and **follow it
  home**." Old Weasels flee at 25 % HP (the **coward** role); the den on the Hill of Ye is where every runner goes.
  You dig out the hoard while its guards come at you.
- **Steps.** `reach` the Weasel Den (a new location on the Hill of Ye, near `LOC_OLD_SHRINE`); `useItem` Sochil's Spade
  there → encounter: 3 Old Weasels 4 (they flee and call; the lesson); `collect` the Hairpin (the den chest, 100 % from
  the encounter); `talk` Sochil.
- **Uses.** The coward role and its call for help. **Rewards.** Earring 01_A, 300 gold. **Data only** (the roles are
  CLIMB's CL-R).

#### CQ_05 "A Blade Worth Carrying" (4, main) — Blacksmith Chulsan
- **Pitch.** The old favourite, kept: Chulsan forges your first real weapon from weasel claws. New twist in the text:
  weasels that run take their claws with them, so finish them before 25 %.
- **Steps.** `collect` 8 Weasel Claws (Old Weasel 4 and Weasel 5, 45 %); `talk` Chulsan.
- **Uses.** Cowards. **Rewards.** Weapon or shield choice 01_C (T2). **Data only.**

#### CQ_06 "The First Glow" (4, side) — Blacksmith Chulsan
- **Pitch.** "A blade that never glowed was never loved." Chulsan gives you an Elixir and a pinch of Lucky Powder:
  reinforce your new weapon at the alchemy window. Success gives the first faint **+1 glow** everyone can see; failure
  is part of the lesson, and Chulsan laughs and pays you anyway.
- **Steps.** Grants Elixir (Weapon) ×1 and Lucky Powder (1st) ×1 on accept; **E1** `event alchemyAttempt` ×1 (any
  result) on a weapon; `talk` Chulsan.
- **Uses.** Alchemy +1–7 and the weapon glow. **Rewards.** Gold (the elixir is the real gift). **Engine.** E1.

#### CQ_07 "The Weasel King" (5, main, party) — Soldier Fengil
- **Pitch.** Old Scar (MB1, level 6) rules the Old Tiger Shrine and runs when hurt, calling his court. Fengil gives
  you two **Weasel Snares**: throw one when he turns to flee and he goes nowhere. Bring a friend.
- **Steps.** Grants 2 Weasel Snares; `kill` Old Scar (MB1); `talk` Fengil.
- **Uses.** The first band mini-boss (CLIMB §2.5), parties (`party: true`), a snare (stun on a monster). **Rewards.**
  Necklace 01_A, 10 HP Potions (Small). **Engine.** E3 (snares on monsters).

#### CQ_08 "Snowball Diplomacy" (3+, side, **winter only**) — Event So-Ok
- **Pitch.** Every December the town divides into the Plaza Gang and the Gate Gang. So-Ok wants a peace treaty signed
  in snow: land ten snowball hits on anyone (players or monsters), then open a Holiday Gift Box and bring her what was
  inside.
- **Steps.** **E1** `event snowballHit` ×10; **E1** `event giftOpened` ×1; `talk` So-Ok. Offered only in the snow season
  (**E2** `season: 'winter'`); a quest taken in season can be finished after it.
- **Uses.** Winter: snowballs, gift boxes (WINTER §13.2, §13.5). **Rewards.** 5 % of the level (outside the budget),
  5 Ginger Teas. **Engine.** E1, E2.

### Act II: "The Drowned and the Storm" (levels 6–10)

#### CQ_09 "The Exorcist Beyond the Bridge" (6, main) — Priest Jeonghye → Exorcist Miaoryeong
- **Pitch.** Jeonghye swallows her pride and sends a letter to her rival. Miaoryeong reads your palm instead of the
  letter: "Thunder follows you. When the sky turns, look at the little cloud by your map." It teaches the storm
  forecast icon before the first storm finds you.
- **Steps.** `deliver` Jeonghye's Letter to Miaoryeong (on the river bridge's town end); `talk` Miaoryeong (the storm
  lesson). **Uses.** Storms (WEATHER §12.1, the forecast). **Rewards.** 2 Return Scrolls. **Data only.**

#### CQ_10 "Salt for the Swamp" (6, main) — Exorcist Miaoryeong
- **Pitch.** The Water Ghosts **heal** their slaves (the healer role: a 1.4 s cast, 12 % HP). Miaoryeong: "Break their
  prayer. A stun, a knockdown, anything." You learn to interrupt.
- **Steps.** **E1** `event healInterrupted` ×3 (any healer-role monster, from CLIMB's roles module); `kill` 10 Water
  Ghost Slaves 6; `talk` Miaoryeong.
- **Uses.** The healer role. **Rewards.** Armour 01_SA_C. **Engine.** E1 (one emit in `climb/roles.ts`).

#### CQ_11 "Drowned Lanterns" (7, main) — Exorcist Miaoryeong
- **Pitch.** Lanterns drowned with the old magistrate's court still glow in the Water Ghosts. Float them on the heart of
  the swamp and the water shows you the court: a magistrate in rotting silk, still passing sentences on the drowned.
- **Steps.** `collect` 6 Drowned Lanterns (Water Ghost 7, 45 %); `useItem` at the swamp heart (`LOC_SWAMP_HEART`) →
  vision + encounter: 3 Water Ghost Slaves; `talk` Miaoryeong. **Uses.** An encounter, the story. **Rewards.** Armour
  01_HA_C. **Data only.**

#### CQ_12 "Thunder Moss" (7, side, **storm**) — Herbalist Yangyun
- **Pitch.** "Where lightning kisses the ground, a blue moss grows for a minute and dies." During a storm, go **toward**
  the strikes: each ground strike in the fields leaves a scorched patch with glowing Thunder Moss for 90 s, visible
  only to players on this quest. Pick three. The danger is the point: you are wet, and wet players take more from
  lightning.
- **Steps.** **E4** `collect` 3 Thunder Moss from scorch patches; `talk` Yangyun.
- **Uses.** Storms, real lightning strikes (WEATHER §2.7, §12.2 "Wet"). **Rewards.** 6 % of the level (outside the
  budget), 5 Vigor Potions (Medium). **Engine.** E4.

#### CQ_13 "Grave Rubbings" (8, main) — Exorcist Miaoryeong
- **Pitch.** Take rubbings of three gravestones at the Old Graves while Tomb Stone Ghosts shoot at you from 10 m. The
  text teaches the line-of-sight pull: step behind a stone and the caster walks to you.
- **Steps.** `useItem` Rubbing Paper at three graves (three objectives, three new locations in the Chinese Tomb); `kill`
  6 Tomb Stone Ghosts 8; `talk` Miaoryeong.
- **Uses.** The ranged and caster roles. **Rewards.** Earring 01_C. **Data only.**

#### CQ_14 "First Stall" (8, side) — Merchant Associate Hwajung
- **Pitch.** "Selling is a skill too." Hwajung lends you a stall sign: open a stall in the market and keep it open for
  ten minutes. If anyone buys anything, she doubles your take.
- **Steps.** **E1** `event stallOpenMinutes` ×10 (inside town); `talk` Hwajung. A sale while it counts pays a bonus
  (**E1** `event stallSale`, optional reward line).
- **Uses.** Stalls (wave 8). **Rewards.** Gold. **Engine.** E1.

#### CQ_15 "The Bone Talismans" (9, main) — Priest Kushyan
- **Pitch.** Grave robbers left tiger-bone talismans scattered at the Old Graves. Kushyan, a scholar from the vanished
  west, holds one to the sky and the hair on your arm rises: "These are anchors. Someone is pinning the storms to
  Jangan." The act's turn.
- **Steps.** `collect` 6 Bone Talismans (Stone Ghost 9 and Tomb Stone 9, 35 %); `talk` Kushyan.
- **Uses.** Story. **Rewards.** Weapon or shield choice 02_A (T3). **Data only.**

#### CQ_16 "Stone for the Wall" (9, side) — Master Mason Ko
- **Pitch.** Ko needs stone for the walls the storms keep cracking. Bring six Stone Blocks (the Stone Ghosts drop them),
  then take a Mason's Kit to any cracked wall segment and work it once. If every wall is whole, Ko waves it off: "Then
  keep the kit for the day they aren't."
- **Steps.** `deliver` 6 Stone Blocks (the siege item, `Stone Ghost 8 %`) to Ko; **E1** `event masonKitWork` ×1 (one
  10 s kit channel on a segment below 100 %; the step completes itself while no segment is below 100 %, **E1**
  `autoIf: 'noDamagedWall'`); `talk` Ko.
- **Uses.** The Siege walls, repair, Ko (SIEGE §2.4). **Rewards.** 1 Mason's Kit, gold. **Engine.** E1.

#### CQ_17 "Court of the Drowned" (10, main, party) — Exorcist Miaoryeong
- **Pitch.** The Drowned Magistrate (MB2, level 10) sentences anyone who enters the heart of the swamp. Miaoryeong:
  "Kill his healers first, or he will never die." His adds are Water Ghosts that heal him.
- **Steps.** `kill` the Drowned Magistrate (MB2); `talk` Miaoryeong.
- **Uses.** A band mini-boss, healer adds. **Rewards.** Armour 02_AA_B, an Ancestor's Incense is *not* given yet
  (penalty starts at 15). **Data only.**

#### CQ_18 "A Horse Named Trouble" (10, side) — Stable-keeper Machun
- **Pitch.** Machun's fastest horse bites everyone but the rider. A letter must reach Juho at the south camp in four
  minutes: ride, don't walk. Fall off (dismount) and the clock does not stop.
- **Steps.** `have` a horse summon item (the Red Horse, level 10, 1,200 gold) or **E2** `mounted`; `reach` Juho's camp
  with **E2** `{ mounted: true, withinSec: 240 }` from accepting the step; `talk` Juho.
- **Uses.** Horses (wave 8). **Rewards.** 2 Recovery Kits (large), 600 gold (half the horse back). **Engine.** E2.

### Act III: "Robbers, Graves and a Licence" (levels 11–15)

#### CQ_19 "Tracks in Yeoha's Forest" (11, main) — Hunter Associate Gwakwi
- **Pitch.** Gwakwi reads tracks like letters. Follow three track marks in order through Yeoha's Forest (the hint moves
  to the next mark as you reach one) to a clearing where the Decayed Yeoha keep their packs alive.
- **Steps.** `reach` ×3 track marks (new locations, in order); `kill` 8 Decayed Yeoha 10 (healers); `talk` Gwakwi.
- **Uses.** Healer packs. **Rewards.** Armour 02_SA_B. **Data only.**

#### CQ_20 "Juho's Wager" (11, side) — Juho
- **Pitch.** Juho bets you a purse you can't kill ten bandits **inside one Berserk**. When the gauge is full, go.
- **Steps.** **E1** `event berserkKill` ×10 (kills while Berserk is active; any monster of level ≥ the player − 3);
  `talk` Juho. **Uses.** Berserk. **Rewards.** Gold, a Lucky Powder (1st). **Engine.** E1.

#### CQ_21 "Cut the Saltpeter Line" (12, main) — General Sonhyeon
- **Pitch.** The robbers carry saltpeter (the Thunder Keg material) to **Old Fang the Fence**. Take five sacks. Fang
  meets you on the road and offers double for them; Sonhyeon offers his old ring. The reward is your choice, and the
  dialog remembers it ("Fang tells everyone you're reasonable." / "Sonhyeon nods at you in the street.").
- **Steps.** `collect` 5 Saltpeter Sacks (Bandit Subordinate 11, Bandit Archer 12, 40 %); `talk` Sonhyeon.
- **Uses.** The siege law's lore (Thunder Kegs, the Fence), cowards and archers. **Rewards.** Choice: Ring 02_B
  (Sonhyeon) or 2 × the gold (Fang's purse). **Data only.**

#### CQ_22 "A Banner to Stand Under" (12, side) — Guild Manager Leebaek
- **Pitch.** "Nobody climbs alone forever." Join a guild, or found one, and bring Leebaek its name.
- **Steps.** **E1** `event guildJoined` ×1 (or founded); `talk` Leebaek. **Uses.** Guilds. **Rewards.** Gold.
  **Engine.** E1.

#### CQ_23 "Lanterns at the Graves" (13, main) — Exorcist Miaoryeong
- **Pitch.** The Tomb Approach: the Qin-Shi graveyard where stone packs wander and Tomb Keepers heal them. Light three
  grave lanterns; each one wakes two Grave Stone Ghosts. Gather the Keepers' ash: the anchors were dug up here.
- **Steps.** `useItem` Grave Lantern at three graves (three locations in the Tomb Approach) → each an encounter of 2
  Grave Stone Ghosts 12; `collect` 6 Keeper's Ash (Tomb Keeper 14, 50 %); `talk` Miaoryeong.
- **Uses.** Band B4. **Rewards.** Armour 02_LA_B. **Data only.**

#### CQ_24 "The Lightning Catcher" (13, side, **storm**) — Scholar Ha-yeon (new NPC)
- **Pitch.** Ha-yeon wants to bottle lightning. Plant three Copper Rods on three hilltops she marks. When the next storm
  comes, lightning prefers tall things (WEATHER §2.7), and your rods are now the tallest things up there: when one is
  struck, its Thunder Jar fills. Bring her one full jar. Standing next to your rod in a storm is a very bad idea, and
  very tempting.
- **Steps.** `useItem` Copper Rod at three hilltops (three objectives) → **E5** each places a rod (3 h, listed in the
  rod index with the owner); **E1** `event rodStruck` ×1 (one of your rods struck); `talk` Ha-yeon.
- **Uses.** Lightning and its rods (WEATHER §2.7). **Rewards.** 8 % of the level (outside the budget), Lucky Powder
  (2nd). **Engine.** E5, E1.

#### CQ_25 "Gwangmu's Last Raid" (14, main, party) — General Sonhyeon
- **Pitch.** Gwangmu the Robber Chief (MB3, level 14) runs when the fight turns, back into his camp, calling archers.
  Captain Yun lends you two **Hunter's Nets**: the snare that holds a Wanted player now holds a robber too.
- **Steps.** Grants 2 Hunter's Nets (quest copies); `kill` Gwangmu (MB3); `talk` Sonhyeon.
- **Uses.** A band mini-boss (coward), the Hunter's Net (SIEGE §7, §8.4). **Rewards.** Weapon or shield choice 02_C
  (T4). **Engine.** E3.

#### CQ_26 "The Ancestors Watch" (15, main) — Exorcist Miaoryeong
- **Pitch.** From 15, death costs (CLIMB §6: 1–20 % of the bar). Miaoryeong lights incense at the ancestral altar of the
  Old Graves and the ancestors speak in her voice: they will spare you, twice. You leave with two Ancestor's Incense
  and the rules said plainly.
- **Steps.** `useItem` Incense Stick at the ancestral altar (a Chinese Tomb location) → vision (the penalty, the grace,
  the Incense, explained); `talk` Miaoryeong.
- **Uses.** The death penalty and the Incense. **Rewards.** 2 Ancestor's Incense. **Data only** (the items are CL-K's).

#### CQ_27 "Licence to Hunt" (15, main) — Captain Yun → Warden Bae
- **Pitch.** Yun signs your Hunter's licence (the quest pays its 10,000 gold back) and gives you a first warrant: he
  lets **Slippery Dok**, a convicted fence-runner, out of the Stockade "by accident". Dok runs. The minimap pings his
  last position every minute (like a real Wanted); net him, beat him down, and he is **subdued, not killed**, and wakes
  in the Garrison Stockade behind Warden Bae's fence, where he heckles you for the next hour ("I'll be back, Hunter!").
  No player is ever made Wanted by this quest.
- **Steps.** **E1** `event hunterLicensed` ×1; `useItem` Yun's Warrant at the Stockade → **E6** spawns Slippery Dok
  (Bandit Subordinate model, level 15, coward with a long flight, pings for the quest holder); **E1** `event
  outlawSubdued` ×1; `talk` Warden Bae.
- **Uses.** Hunters, the Net, pings, the Stockade (SIEGE §8). **Rewards.** The licence refund (10,000 gold), Hunter's
  Net ×1, armour 02_BA_B. **Engine.** E1, E6.

#### CQ_48 "Unfinished Business" (15+, side, **nemesis**) — Hunter Associate Gwakwi
- **Pitch.** A monster that killed you has a name now (NEMESIS). Gwakwi: "Don't let it grow fat on your name." Kill your
  own nemesis.
- **Steps.** **E1** `event nemesisSlain` (own) ×1; `talk` Gwakwi. Offered only to a character with a living nemesis.
- **Uses.** NEMESIS. **Rewards.** 5 % of the level (outside the budget). **Engine.** E1. **Depends on NEMESIS being
  built**; cut otherwise.

### Act IV: "The Black Wind" (levels 16–20)

#### CQ_28 "The Masked Buyer" (16, main) — Bagger Sochil
- **Pitch.** Sochil points: "Him. The one in the mask. He buys talismans." The buyer walks out of the market, through
  the west gate and up the Stronghold road. **Tail him**: stay between 8 and 40 m behind for three minutes. Closer and
  he turns ("Do I know you?") and the tail restarts from the market; farther and you lose him. At the end of the road
  he hands a talisman to a bandit and you hear the name: **Heukpung**.
- **Steps.** `talk` Sochil → **E7** `tail` the Masked Buyer (lane from the market to the Stronghold road; 8–40 m for
  180 s, restarts on fail); `talk` Sochil.
- **Uses.** A new stealth mechanic on the siege lanes' walker. **Rewards.** Armour 03_AA_A (T5). **Engine.** E7.

#### CQ_29 "The Gate Warden" (16, main, party) — Exorcist Miaoryeong
- **Pitch.** Before the Qin-Shi Tomb's doors stands the Gate Warden (MB4, level 16), a giant stone ghost whose two Tomb
  Keepers heal it. Break it and the doors answer: TOMB_DUNGEON's attunement quest JG_T01 opens.
- **Steps.** `kill` the Gate Warden (MB4); `talk` Miaoryeong. Unlocks JG_T01 "The Emperor's Door" (TOMB_DUNGEON).
- **Uses.** A band mini-boss, the Tomb's door. **Rewards.** Ring 03_A, 1 Ancestor's Incense. **Data only.**

#### CQ_30 "Stripes in the Storm" (17, main) — Hunter Associate Gwakwi
- **Pitch.** The lodge needs eight tiger pelts. In a storm, tigers call their packs (WEATHER §12.2 "Packs") and a tiger
  struck by lightning becomes **charged** (§12.4): it hits harder, arcs to your friends, and its pelt comes off
  striped with blue: a **Storm-Striped Pelt** counts as three. Hunt in fair weather and it's a chore; hunt in a storm
  and it's a gamble.
- **Steps.** `collect` 8 Tiger Pelts (Tiger 14, Black Tiger 17, 45 %; a charged one drops a Storm-Striped Pelt, worth 3,
  **E10**); `talk` Gwakwi.
- **Uses.** Storm packs, storm-charged monsters. **Rewards.** Weapon or shield choice 03_A (T5). **Engine.** E10.

#### CQ_31 "Defuse Drill" (17, side) — Captain Yun with Master Mason Ko
- **Pitch.** Yun and Ko run a drill: three practice kegs, fuses lit, fifteen seconds each. Defusing is a 3 s cast that
  damage breaks. Ko's apprentices throw pebbles at you "for realism". A practice keg that goes off knocks you down and
  stings (10 % HP), never kills.
- **Steps.** `useItem` Practice Keg Crate at the drill yard by the Stockade → **E9** three practice kegs with 15 s
  fuses and two Bandit Subordinate "pebble throwers" (1 damage); **E1** `event kegDefused` ×3 (practice kegs count;
  real kegs in a siege count too); `talk` Yun.
- **Uses.** Thunder Kegs and defusing (SIEGE §7.1). **Rewards.** Gold, 2 Mason's Kits. **Engine.** E9, E1.

#### CQ_32 "Through the Tiger's Eyes" (18, main) — Exorcist Miaoryeong
- **Pitch.** The Play-the-Boss moment of the climb. Miaoryeong's brew sends your spirit into a young tiger for four
  minutes. Your body sits in a trance by her fire. You run on four legs through the Tiger Mountains (pounce, roar, slink
  low), past bandit scouts who scream and scatter, to the den where the Tiger Girl sleeps chained by an anchor. Roar
  at the den mouth and wake up gasping.
- **Steps.** `useItem` Tiger Brew at Miaoryeong's fire → **E8** spirit walk: you steer a private Young Tiger (Play the
  Boss's pilot link; the kit's Pounce and Fear Roar; 240 s; nobody can attack it, it attacks nothing but the scouts it
  roars at); **E1** `event spiritReach` at the Tiger Den (a new location by Tiger Girl's camp on North-Tiger Mt.);
  `talk` Miaoryeong.
- **Uses.** Play the Boss's pilot link, controlled-entity camera and kit (PLAY_THE_BOSS §0). **Rewards.** Armour
  03_FA_A, Earring 03_A. **Engine.** E8 (the largest piece). **Fallback if cut:** the brew shows a vision and the step
  is `reach` the Tiger Den in person (data only).

#### CQ_33 "A Voice for the Bell" (18, side) — Blacksmith Chulsan
- **Pitch.** The Town Bell on the plaza, the siege's last line, is cracked. Chulsan re-casts its voice with white tiger
  fangs, grumbling all the way. Then you ring it, and the whole server hears it toll three times.
- **Steps.** `collect` 8 White Fangs (White Tiger 18, 45 %); `deliver` them to Chulsan; `useItem` Bell Hammer at the
  Town Bell → **E11** a three-toll bell sound and a chat line for everyone ("{name} rang the Town Bell. Jangan
  answers."); `talk` Chulsan.
- **Uses.** The siege's Town Bell (SIEGE §6.3) and its alarm sound. **Rewards.** Necklace 03_A. **Engine.** E11.

#### CQ_34 "The Black Wind" (19, main, party) — General Sonhyeon
- **Pitch.** Heukpung, the Black Wind (MB5, level 19), holds the Stronghold's hall with archers on the walls. His war
  plan, written on a tiger hide, shows Jangan's walls with three crosses, and a seal from the western heights.
- **Steps.** `kill` Heukpung (MB5); `collect` Heukpung's War Plan (100 %); `talk` Sonhyeon.
- **Uses.** A band mini-boss for a duo or more. **Rewards.** Weapon or shield choice 03_B (T6). **Data only.**

#### CQ_35 "Hold the Walls" (19+, side, **siege**) — General Sonhyeon
- **Pitch.** When the Siege of Jangan comes (weekly, SIEGE §6.7), be on the walls: earn 100 contribution points
  (sappers killed, kegs defused, wall repaired, damage dealt). Win or lose, Sonhyeon remembers who stood.
- **Steps.** **E1** `event siegePoints` ≥ 100 in one siege; `talk` Sonhyeon.
- **Uses.** The Siege of Jangan. **Rewards.** 10 % of the level (outside the budget), 2 Siege Seals. **Engine.** E1.

#### CQ_36 "Into the Emperor's Tomb" (20, main, party) — Exorcist Miaoryeong
- **Pitch.** The anchors were made in the tomb. Clear its first wing with a party and bring back an Anchor Mould.
- **Steps.** **E1** `event tombWingCleared` ≥ 1 (TOMB_DUNGEON); `collect` the Anchor Mould (the wing's chest);
  `talk` Miaoryeong. **Fallback if the Tomb is not built:** `kill` 3 elite leaders of the Tomb Approach camp (CLIMB
  §2.3), the mould drops from the third.
- **Uses.** The Qin-Shi Tomb (TOMB_DUNGEON). **Rewards.** Armour 03_HA_A. **Engine.** E1 (or data only with the
  fallback).

#### CQ_37 "The Ferryman's Beacon" (20, main) — Ferry Ticket Seller Doji → Boatman Sagong
- **Pitch.** *(2026-10-10: the far bank is gone; was "The Ferryman's Fee".)* Heukpung's buyer camps on the heights
  above the old ferry. Doji has not sailed since the sea took the far bank; he gives you a lantern. Climb to the Ferry
  Heights' lookout and see the Hyungno fires on the ridge, then light the beacon on the old pier so the fishing boats
  find the landing at night, and meet Sagong, the boatman who never left.
- **Steps.** `reach` the Ferry Heights' lookout (CLIMB §2.1, GM `tp ferry-heights`); `useItem` Ferry Lantern at the pier
  beacon (the landing, by Chau); `talk` Sagong.
- **Uses.** The high country's first view. **Rewards.** 1 Ancestor's Incense, the W15-C Ferryman's coat when the wardrobe
  lands (CLIMB §4.3). **Data only.**

#### CQ_47 "The Yeti's Tooth" (20+, side, **winter only**) — Event So-Ok
- **Pitch.** The Ice Yeti (re-tuned to 25, CLIMB §2.6) comes down from the north-west hills in the snow season. Be in
  the fight that brings her down: So-Ok wants a tooth for the plaza's ice lantern.
- **Steps.** `kill` the Ice Yeti (credit by her damage map, as any unique); `talk` So-Ok. **E2** `season: 'winter'`.
- **Uses.** The Ice Yeti, warmth (fires matter in a long fight). **Rewards.** 8 % of the level (outside the budget), 3
  Holiday Gift Boxes. **Engine.** E2.

### Act V: "The Canyon Lord" (levels 21–24, the Ferry Heights, the Sea Cliffs)

#### CQ_38 "Miners on the Heights" (21, main) — Boatman Sagong
- **Pitch.** The Chakji Workers dig iron for the anchors in the Ferry Heights' slopes. They run when hurt and call
  **two** friends (B7's coward rule). Sagong: "Stun the runner, or you'll be fighting the whole mine."
- **Steps.** `collect` 8 Chakji Iron Shards (Chakji Worker 19, Chakji 20, 45 %); `talk` Sagong.
- **Uses.** Cowards that call two. **Rewards.** Armour 03_LA_A. **Data only.**

#### CQ_39 "The Silk Run" (21, side) — Merchant Associate Hwajung → Specialty Trader Seopok
- **Pitch.** With the western road gone, Seopok pays triple for silk at his post under the Stronghold. Carry three
  bolts on horseback from town up the north-west road and over the Ferry Heights' shoulder. Halfway, thieves who heard
  about the silk spring an ambush.
- **Steps.** Grants 3 Silk Bolts (bound); `reach` the ambush point on the Ferry Heights' road **E12** → encounter: "road thieves", 3 Chakji 20
  and 1 Chakji Worker 19 (it runs and calls, so the silk is at risk until you stun it); `deliver` 3 Silk Bolts to Seopok
  with **E2** `mounted: true`.
- **Uses.** Horses, trade (the old caravan story), the high country. **Rewards.** Gold (the big gold reward of the act),
  a Vigor Potion (X-Large) stack. **Engine.** E12, E2.

#### CQ_40 "Smoke the Hives" (22, main) — Boatman Sagong
- **Pitch.** Ghost Bugs and Devil Bugs nest in mounds along the Ferry Heights' ridge. Drop a smoke pot on each of three mounds and
  five bugs boil out at once: the glaive's area Arts (CLIMB §5) were made for this.
- **Steps.** `useItem` Smoke Pot at three hive mounds (three locations) → each an encounter of 5 bugs (Ghost Bug 21 ×3,
  Devil Bug 22 ×2); `talk` Sagong.
- **Uses.** Packs, area skills. **Rewards.** Ring 03_B. **Data only.**

#### CQ_41 "The Tornado Chaser" (22, side, **storm**) — Scholar Ha-yeon
- **Pitch.** Ha-yeon needs a reading from *inside* the funnel. When a lightning tornado touches down, run at it: stay
  within 40 m for 20 s (it pulls and throws, 22 % HP a throw: WEATHER §13), or get thrown once and come down with a
  Whirlwind Feather in your fist.
- **Steps.** **E1** `event tornadoNear` ≥ 20 s **or** `event tornadoThrown` ×1 (one objective, either counts); `talk`
  Ha-yeon.
- **Uses.** The lightning tornado (rare: about 30 % of storms; none in winter). **Rewards.** 8 % of the level (outside
  the budget), title "Stormrunner" (CLIMB §7.3). **Engine.** E1.

#### CQ_42 "Hyungno Bells" (23, main) — Priest Kushyan
- **Pitch.** The Hyungno Shamans of the Sea Cliffs keep the dead soldiers on the Ferry Heights on their feet with bells.
  Take eight bells, ring them at the Hyungno cairn on the ridge top after dark, and the dead line up for inspection:
  their **Banner-Bearer** steps out to answer the challenge.
- **Steps.** `collect` 8 Shaman's Bells (Hyungno Shaman 24, 50 %, the Sea Cliffs); `useItem` the bells at the cairn (the Ferry Heights' top) with **E2**
  `when: 'night'` → encounter: the Banner-Bearer (Hyungno Ghost Soldier 23, elite variant) + 2 Hyungno Soldiers 23;
  `talk` Kushyan.
- **Uses.** Healers, an elite, night. **Rewards.** Armour 03_BA_B (wearable at 23). **Engine.** E2.

#### CQ_43 "Mo-Dun's War Camp" (23, main, party) — General Sonhyeon (by Sagong)
- **Pitch.** Mo-Dun the Hyungno Warlord (MB7, level 23) drills the dead on the Ferry Heights for a march down on the
  landing and the town. Break the camp (CLIMB §2.5: the ridge top).
- **Steps.** `kill` Mo-Dun (MB7); `talk` Sagong. **Uses.** A band mini-boss for 3–4. **Rewards.** Weapon or shield
  choice 03_C (T7). **Data only.**

#### CQ_44 "The Qilin's Shadow" (23+, side, **storm**) — Scholar Ha-yeon
- **Pitch.** When a storm breaks, a lightning Qilin lands on a summit and bolts between peaks when hunters come close
  (STORM_QILIN). Ha-yeon only wants a sighting: get within 60 m of it once.
- **Steps.** **E1** `event qilinSighted` ×1; `talk` Ha-yeon. **Uses.** The storm Qilin. **Rewards.** 6 % of the level
  (outside the budget), the first step of the "Stormchaser" title. **Engine.** E1. **Depends on STORM_QILIN being
  built**; cut otherwise.

#### CQ_45 "The Canyon Lord" (24, main, party) — Priest Kushyan
- **Pitch.** On the Sea Cliffs' south-west crest, 120 m over the open sea where the Donwhang road once ran,
  **Hyeongcheon** (MB8, level 25, CLIMB §2.5, GM `tp canyon-lord-lair`)
  holds the anchors in a ring of earth spirits. A party of four; his Canyon Taoists heal him. When he falls, the storm
  anchor breaks and every player online sees the sky flash.
- **Steps.** `kill` Hyeongcheon (MB8); `collect` the Storm Anchor (100 %); `talk` Kushyan.
- **Uses.** The climb's last mini-boss. **Rewards.** Necklace 03_B. **Data only.**

#### CQ_46 "Night of the Tiger Queen" (24, main, party) — Priest Jeonghye → Chief Hwangno
- **Pitch.** With the anchor broken, the leash on the Tiger Girl is gone and she wakes at full strength (level 25,
  CLIMB §2.6). The climb ends where Jangan's oldest fear lives: be in the party that brings her down, in the wild or on
  a **Night of the Tiger** when a player steers her (Play the Boss) and the hunters win. Then walk back to the Chief,
  who first told you "we only have ourselves", and hear him say the rest.
- **Steps.** `kill` Tiger Girl (`MOB_CH_TIGERWOMAN`; credit by the damage map, so a Play the Boss win counts);
  `talk` Hwangno.
- **Uses.** Tiger Girl at 25, Play the Boss. **Rewards.** **A rare weapon:** choice of the five Seal of Star weapons
  or the shield (`ITEM_CH_*_03_A_RARE`; the rarity lane's rows), the title "Climber" when 25 is reached (CLIMB §7.3).
  **Data only.**

### Dailies

| Id | Levels | Giver | Pitch | Steps | Reward |
|---|---|---|---|---|---|
| CQ_R1 "Millet Watch" | 1–9 | Fengil | the fields' patrol | `kill` 20 monsters of B1/B2 (any listed code) | 5 % of the level, potions |
| CQ_R2 "Bandit Bounty" | 10–19 | Sonhyeon | a price on every robber | `kill` 25 Bandits, Subordinates, Archers or Bowmen | 5 % of the level, gold |
| CQ_R3 "The Bounty Board" | 20–25 | Sonhyeon | CLIMB §7.2's board at 25 | `kill` today's mini-boss (one of MB5, MB7, MB8, drawn daily) and one elite camp leader of B8 | 5 % of the level (SP-EXP at 25), Incense 10 %, elixir chance |
| CQ_R4 "Storm Hunt" | 10–25 | Ha-yeon | charged monsters drop better loot | **E1** `event chargedKill` ×5 during a storm | 4 % of the level, a Lucky Powder |

---

## 4. Features used (the coverage check)

| Feature | Built? [confirmed: `apps/server/src`, 2026-10-08] | Quests |
|---|---|---|
| Island map, coast | the map change is the parallel task; the coast exists | CQ_01 |
| Encounters, champions, elites | yes (quest engine, variants) | CQ_02, 03, 04, 11, 23, 40, 42 |
| Climb roles: pack, healer, ranged, coward | **no** (CLIMB CL-R) | CQ_03, 04, 05, 10, 13, 19, 38 |
| Band mini-bosses MB1–MB8 | **no** (CLIMB CL-D/CL-SV) | CQ_07, 17, 25, 29, 34, 43, 45 |
| Death penalty, Incense | **no** (CLIMB CL-K) | CQ_26 |
| Parties | yes (`party.ts`) | every boss quest |
| Alchemy and glow | yes (`alchemy.ts`) | CQ_06 |
| Stalls, trade | yes (`social/stall.ts`, `trade.ts`) | CQ_14, CQ_39 |
| Guilds | yes (`social/guild.ts`) | CQ_22 |
| Horses | yes (`mounts.ts`) | CQ_18, CQ_39 |
| Berserk | yes (`berserk.ts`) | CQ_20 |
| Storms, packs, charged monsters | yes (`storm/`) | CQ_09, 12, 30, R4 |
| Lightning and rods | yes (`lightning/`) | CQ_12, CQ_24 |
| Lightning tornado | yes (`storm/tornado.ts`) | CQ_41 |
| Walls, Mason Ko, kits, blocks | yes (`siege/walls.ts`, `repair.ts`) | CQ_16 |
| Thunder Kegs, defusing | yes (`siege/keg.ts`) | CQ_31 |
| Hunters, Net, pings, Stockade | yes (`siege/hunters.ts`, `jail.ts`) | CQ_25, CQ_27 |
| Siege of Jangan, Town Bell | yes (`siege/event.ts`) | CQ_33, CQ_35 |
| Play the Boss | yes (`pilot/`) | CQ_32 (its pilot link), CQ_46 (a Night of the Tiger counts) |
| Tiger Girl | yes (`uniques.ts`) | CQ_32, CQ_46 |
| Winter: snowballs, gifts, Ice Yeti, warmth | yes (`winter-play/`) | CQ_08, CQ_47 |
| Qin-Shi Tomb | **no** (TOMB_DUNGEON) | JG_T01, CQ_36 (with a fallback) |
| Nemesis | **no** (NEMESIS) | CQ_48 (cut if not built) |
| Storm Qilin | **no** (STORM_QILIN) | CQ_44 (cut if not built) |
| Fishing, hot springs, swimming | **no** (no code) | none [decision: no quest waits on unbuilt wave 13; add when it lands] |

---

## 5. Rewards and pacing [projected: `pnpm tsx work/tmp/climb25/quests25.ts`, on the cap-25 curve of CLIMB §3.2]

- **The budget:** each level's quests share **questShare(L) × the level's bar**: 50 % at 1–5, 35 % at 6–10, 30 % at
  11–15, 25 % at 16–20, 20 % at 21–24 [decision: the cap-20 shares, extended by one step; the cap is earned in the
  field]. Inside a level, quests split it by weight (a main quest 1.0–1.3, a short or side quest 0.5–0.7).
- **Event-gated and seasonal quests pay a share of the level** (`expPctOfLevel`, 5–10 %), outside the budget [decision:
  a storm, a tornado, a siege or December may not come in time; the climb's pace must not depend on them, so they are
  bonuses like the dailies].
- **SP** = max(1, round(EXP / 600)) (QUESTS §3.4's rule). **Gold** = 60 × level² × weight, rounded to 50 [decision:
  ≈ the old line's doubled late gold, CLIMB §4.5; it pays the X-Large potions of 21–24].
- **Items** as written per quest: one tier step per act, the weapon choices at 4 (T2), 9 (T3), 14 (T4), 17 (T5), 19
  (T6), 23 (T7) and the **Seal of Star weapon at 24**.

| Id | Lv | Kind | Title | EXP | SP | Gold |
|---|---|---|---|---|---|---|
| CQ_01 | 1 | main | Salt on the Wind | 387 | 1 | 100 |
| CQ_02 | 1 | main | The Fat Thief of the Millet | 503 | 1 | 100 |
| CQ_03 | 2 | main | Lanterns for the Lost | 1,350 | 2 | 250 |
| CQ_04 | 3 | main | Follow the Runner | 1,980 | 3 | 550 |
| CQ_08 | 3 | side | Snowball Diplomacy (winter) | 198 (5 % of the level, outside the budget) | 1 | 300 |
| CQ_05 | 4 | main | A Blade Worth Carrying | 1,823 | 3 | 1,250 |
| CQ_06 | 4 | side | The First Glow | 982 | 2 | 650 |
| CQ_07 | 5 | main | The Weasel King | 3,860 | 6 | 1,500 |
| CQ_09 | 6 | main | The Exorcist Beyond the Bridge | 1,060 | 2 | 1,100 |
| CQ_10 | 6 | main | Salt for the Swamp | 2,545 | 4 | 2,600 |
| CQ_11 | 7 | main | Drowned Lanterns | 4,725 | 8 | 2,950 |
| CQ_12 | 7 | side | Thunder Moss (storm) | 810 (6 % of the level, outside the budget) | 1 | 1,750 |
| CQ_13 | 8 | main | Grave Rubbings | 4,013 | 7 | 4,600 |
| CQ_14 | 8 | side | First Stall | 2,007 | 3 | 2,300 |
| CQ_15 | 9 | main | The Bone Talismans | 4,731 | 8 | 5,850 |
| CQ_16 | 9 | side | Stone for the Wall | 2,759 | 5 | 3,400 |
| CQ_17 | 10 | main | Court of the Drowned | 6,274 | 10 | 7,800 |
| CQ_18 | 10 | side | A Horse Named Trouble | 2,896 | 5 | 3,600 |
| CQ_19 | 11 | main | Tracks in Yeoha's Forest | 5,987 | 10 | 8,700 |
| CQ_20 | 11 | side | Juho's Wager | 3,493 | 6 | 5,100 |
| CQ_21 | 12 | main | Cut the Saltpeter Line | 7,962 | 13 | 10,350 |
| CQ_22 | 12 | side | A Banner to Stand Under | 3,318 | 6 | 4,300 |
| CQ_23 | 13 | main | Lanterns at the Graves | 13,260 | 22 | 10,150 |
| CQ_24 | 13 | side | The Lightning Catcher (storm) | 3,536 (8 % of the level, outside the budget) | 6 | 6,100 |
| CQ_25 | 14 | main | Gwangmu's Last Raid | 15,450 | 26 | 11,750 |
| CQ_26 | 15 | main | The Ancestors Watch | 5,960 | 10 | 8,100 |
| CQ_27 | 15 | main | Licence to Hunt | 11,920 | 20 | 16,200 |
| CQ_48 | 15 | side | Unfinished Business (nemesis) | 2,980 (5 % of the level, outside the budget) | 5 | 8,100 |
| JG_T01 | 16 | main | The Emperor's Door (TOMB_DUNGEON's) | 3,963 | 7 | 9,200 |
| CQ_28 | 16 | main | The Masked Buyer | 6,606 | 11 | 15,350 |
| CQ_29 | 16 | main | The Gate Warden | 6,606 | 11 | 15,350 |
| CQ_30 | 17 | main | Stripes in the Storm | 13,167 | 22 | 20,800 |
| CQ_31 | 17 | side | Defuse Drill | 6,583 | 11 | 10,400 |
| CQ_32 | 18 | main | Through the Tiger's Eyes | 14,368 | 24 | 23,350 |
| CQ_33 | 18 | side | A Voice for the Bell | 8,382 | 14 | 13,600 |
| CQ_34 | 19 | main | The Black Wind | 26,250 | 44 | 21,650 |
| CQ_35 | 19 | side | Hold the Walls (siege) | 10,500 (10 % of the level, outside the budget) | 18 | 13,000 |
| CQ_36 | 20 | main | Into the Emperor's Tomb | 19,063 | 32 | 24,000 |
| CQ_37 | 20 | main | The Ferryman's Beacon | 11,438 | 19 | 14,400 |
| CQ_47 | 20 | side | The Yeti's Tooth (winter) | 9,760 (8 % of the level, outside the budget) | 16 | 14,400 |
| CQ_38 | 21 | main | Miners on the Heights | 16,706 | 28 | 26,450 |
| CQ_39 | 21 | side | The Silk Run | 11,694 | 19 | 18,500 |
| CQ_40 | 22 | main | Smoke the Hives | 33,600 | 56 | 29,050 |
| CQ_41 | 22 | side | The Tornado Chaser (storm) | 13,440 (8 % of the level, outside the budget) | 22 | 17,400 |
| CQ_42 | 23 | main | Hyungno Bells | 20,100 | 34 | 31,750 |
| CQ_43 | 23 | main | Mo-Dun's War Camp | 20,100 | 34 | 31,750 |
| CQ_44 | 23 | side | The Qilin's Shadow (storm) | 12,060 (6 % of the level, outside the budget) | 20 | 19,050 |
| CQ_45 | 24 | main | The Canyon Lord | 22,182 | 37 | 34,550 |
| CQ_46 | 24 | main | Night of the Tiger Queen | 26,618 | 44 | 41,450 |

**Totals:** EXP 376,671 (24.2 % of 1->25 1,555,570), SP 630; event/seasonal % quests 53,284 if all done; gold 574,950
- band 1-5: 8 quests (6 main, 2 side), share 50 %
- band 6-10: 10 quests (6 main, 4 side), share 35 %
- band 11-15: 10 quests (6 main, 4 side), share 30 %
- band 16-20: 11 quests (7 main, 4 side), share 25 %
- band 21-24: 9 quests (6 main, 3 side), share 20 %
- 48 CQ quests + JG_T01 (TOMB_DUNGEON's, counted in the level-16 budget) + 4 dailies.

---

## 6. New engine work (everything else is data)

| # | Piece | What | Where | Quests | Size |
|---|---|---|---|---|---|
| **E1** | **Quest events** | A new objective type `event {name, count, filter?}` and one seam `QuestService.note(p, name, n = 1, tags?)`; ≈ 20 one-line emits: `alchemyAttempt` (alchemy.ts), `berserkKill` (berserk.ts / mobDied), `stallOpenMinutes`, `stallSale` (stall.ts), `guildJoined` (guild.ts), `healInterrupted` (climb/roles.ts), `rodStruck` (lightning/rods), `tornadoNear`, `tornadoThrown` (storm/tornado.ts), `chargedKill` (storm/service.ts), `masonKitWork`, `kegDefused`, `siegePoints` (siege/*), `hunterLicensed`, `outlawSubdued` (siege/hunters.ts), `snowballHit`, `giftOpened` (winter-play/*), `spiritReach` (E8), `tombWingCleared` (TOMB), `qilinSighted` (QILIN), `nemesisSlain` (NEMESIS); an `autoIf` predicate list (`noDamagedWall`). Validator, wire label, tracker text | `packages/shared/src/quests.ts`, `apps/server/src/quests/engine.ts`, the modules | 15 | 2 days |
| **E2** | **Objective conditions** | `when: {night?, storm?, season?: 'winter', mounted?, withinSec?}` on `reach`/`useItem`/`deliver`, and `season` on a quest's offer; read from the world clock, the storm status, the winter gate and the mount | quests.ts, engine.ts | CQ_08, 18, 39, 42, 47 | 1 day |
| **E3** | **Snares on monsters** | A quest item (Weasel Snare, the quest copy of the Hunter's Net) uses `hunterNet`'s stun on a monster within 12 m and ends a coward's flight; never on a unique | item-use.ts, siege/hunters.ts (shared helper) | CQ_07, 25 | 0.5 day |
| **E4** | **Scorch pickables** | A landed ground strike during a storm leaves a pickable Thunder Moss for 90 s, sent only to players holding CQ_12 (a quest-scoped ground item) | lightning/service.ts `onStrike` + quests | CQ_12 | 0.5 day |
| **E5** | **Player lightning rods** | A Copper Rod use places a rod (owner, 3 h, a 4 m model prop: a retail spear or banner) into `rodIndex`; a strike on it emits `rodStruck` to the owner; at most 3 per player | lightning/rods.ts, a client prop | CQ_24 | 1 day |
| **E6** | **Quest outlaw** | An encounter mob with `outlaw: {fleeSec, pingSec}`: flees in long legs, pings its position to the quest holder's minimap (the Hunter ping path), and at 0 HP is **subdued** (no death, no loot) and appears for 60 min as a non-combat NPC inside the Stockade with bark lines | quests/encounter.ts, siege/jail.ts (NPC placement), client pings | CQ_27 | 1.5 days |
| **E7** | **Tail** | A walking non-hostile NPC on an authored lane (the siege lanes' mover, `world.moveEntity` per leg) and an objective `tail {npc, lane, minM, maxM, sec}` checked at 2 Hz; restart on fail | quests, siege/lanes.ts helper | CQ_28 | 1.5 days |
| **E8** | **Spirit walk** | Play the Boss's pilot link on a private quest mob: spawn a Young Tiger at the player, attach the link (the player's body in trance at the fire), the kit subset (Pounce, Fear Roar), 240 s, untargetable by players, `spiritReach` at a location; detach on time, death of the body or logout | pilot/ (steer, kit, a `private` session), quests | CQ_32 | 3 days |
| **E9** | **Practice kegs** | Keg entities with `practice: true`: no wall damage, a 10 % HP non-lethal blast, defuse emits `kegDefused` | siege/keg.ts | CQ_31 | 0.5 day |
| **E10** | **Charged drops** | `collect.from[]` gains `chargedItem?, chargedCount?`: a storm-charged monster drops the better item | quests engine | CQ_30 | 0.3 day |
| **E11** | **Bell toll** | `useItem` on the Town Bell plays the siege alarm toll to everyone and a chat line; 10 min cooldown server-wide | siege/event.ts helper | CQ_33 | 0.2 day |
| **E12** | **Ambush on reach** | `reach` may carry an `encounter` (as `useItem` does) | quests | CQ_39 | 0.3 day |
| **E13** | **Migration of quest state** | §8 | db.ts migration + login step | all | 0.5 day |
| | | | | | **≈ 13.3 agent-days** |

Climb engine the quests rely on (CLIMB's lanes, not counted above): the roles (CL-R), the seven mini-bosses MB1–MB8 (CL-D,
CL-SV), the penalty and Incense (CL-K), the high country's notices (CLIMB §2.7), the titles (CL-U).

---

## 7. Scope cuts (cut from the top; each cut has a data-only fallback)

1. **E8 spirit walk** → CQ_32 becomes a vision + `reach` the den in person.
2. **E7 tail** → CQ_28 becomes `reach` four checkpoints along the Stronghold road within 4 min (E2 `withinSec`).
3. **E6 quest outlaw** → CQ_27's outlaw is a normal coward encounter; killing him gives "Dok's Confession", delivered to
   Bae.
4. **E5 rods, E4 scorch** → CQ_24 and CQ_12 are dropped (side quests).
5. **E9, E11, E12** → CQ_31 needs real kegs (siege only, made event-gated), CQ_33 skips the toll, CQ_39 loses the
   ambush.
6. **Unbuilt siblings**: CQ_44 (Qilin) and CQ_48 (nemesis) wait for their waves; CQ_36 uses its fallback until the Tomb.

**Never cut:** E1 (half the quests stand on it), the 31 main quests, the reward budget.

---

## 8. Live characters [decision]

- **Old quests**: every JG_* row leaves the file. A quest **done** stays in `char_quests` history (no effect). A quest
  **in progress** is cancelled at the first login after the deploy; its quest items leave the bag; the player gets the
  old quest's gold reward with a system line ("Your old errands are settled. The town has new troubles.") [decision:
  simple and never a loss].
- **New main quests below the character's level are marked done without rewards**, so a level-18 character starts at
  the first open main quest of their level band (Act IV) instead of facing 25 low quests [decision: the main chain
  is a `requires` chain; side quests stay open, and their EXP at a high level is small by construction].
- **Level-20 characters** (the old cap) start Act V's first quest after CQ_37 is auto-marked (CQ_37 stays open for
  them: the lookout and the beacon) [decision: the high country is their new content].
- One migration step (E13), next to CLIMB's `curve_version` (CLIMB §9).

---

## 9. Tests (content and engine)

- `quests-content-check`: every objective's mobs exist (derived codes or bases), every hint location is inside the
  play bounds **and inside the Jangan region** (x ≥ the bounds' west edge, region x 156; no location in a removed
  area), every kill target is ≤ quest level + 3 (the bosses' party quests excepted, `party: true`), the EXP sum per
  level equals the budget ± rounding (§5), every `requires` chain reaches CQ_46.
- E1: each emit fires once per real action (no double count from retries), `autoIf` resolves on accept and on login.
- E2: a night step outside the night answers `wrong_time` with the time it opens; `withinSec` restarts on fail.
- E6: the outlaw never dies, never drops loot, never leaves the play bounds, despawns if its holder logs out for 10 min.
- E7: closer than `minM` restarts; the walker never stops in a wall (the siege lanes' boot walk check).
- E8: the body in trance takes damage normally (and the walk ends if it dies); a disconnect detaches; the tiger cannot
  hurt a player.
