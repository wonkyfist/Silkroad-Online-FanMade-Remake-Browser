# The Climb (wave 14): levels 1–20 redesigned

The user's words, verbatim:

> Silkroad Online retail never made level 1-20 fun. It just wasnt part of their plans since level 20 was never a cap.
> So let's make it fun. We adjust monster's levels and difficulty, also unique monster's. ... Level 20 should be
> difficult to reach since its a level cap. Currently is not difficult because retail never made it to be, but is also
> boring because again retail never meant for you to take long to get to 20.

> after level 15 if player dies they loose a random % from 1% to 20%

Defaults Claude proposed and the user kept: **about 40 hours of real play to reach 20; solo-friendly to about 15, the
Tomb and the big bosses need a group; rates back to ×1 with the new curve.** New clothing and weapon art come in waves
15 and 17: this spec defines the **gear tiers** with existing items and leaves **named slots** those waves fill.

This spec is one of four wave-14 specs. It owns **the level bands, the re-levelled roster and its behaviours, the
band mini-bosses and the uniques' re-tune, the EXP curve and the rates, the gear tiers and drops, the skill Arts and
SP pacing, the death penalty, the post-cap goals, the questline pacing and the migration of live characters**. The
siblings own the rest: **docs/TOMB_DUNGEON.md** (the Qin-Shi Tomb dungeon, band B6 here), **docs/NEMESIS.md**
(nemesis monsters) and **docs/STORM_QILIN.md** (the storm Qilin). WAVE_PLAN10 merges the four. Where this spec gives a
sibling a number (the Tomb's EXP budget, the penalty's rule for a nemesis kill), it is a budget the sibling may tune,
named as such.

**The user delegated every decision.** Wherever there is a choice, this spec takes the option it would mark
"(Recommended)" and writes it as a decision with a one-line reason (§14). Only what truly needs the user is in §15 and
§16, each with the default used meanwhile.

**Tags:**

- **[confirmed]**: checked in the code or data of the working tree on 2026-10-02, or measured by this spec's
  simulation (`work/tmp/climb/`, run 5, seed 1188); each says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement or the model under stated assumptions, not observed in play.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this spec makes. The user may overrule it.

**Every balance number here comes from a simulation**, not a guess: `work/tmp/climb/` extends `work/tmp/balance/sim.ts`
(BALANCE §1) with re-levelled monsters, monster roles, multi-monster pulls, parties, skill tiers, the curve solver and a
Monte Carlo of whole climbs (§13). The model was first checked against BALANCE's own result: today's frugal blade,
1 → 20 grind, **29.8 h against BALANCE §3's 28.0 h** (the new engine adds 1–3 s of slack per pull) [confirmed:
`pnpm tsx work/tmp/climb/validate.ts frugal`, re-run by the fact-check on 2026-10-02; the first draft printed 30.0].

**Design only.** No file under `packages/`, `apps/`, `content/` or `deploy/` was changed. No download, no Meshy job,
no GPU timing (nothing here draws), no browser, no server started. Scratch: `work/tmp/climb/`.

**Fact-check (2026-10-02).** An adversarial pass re-derived every [confirmed] claim: it re-ran `climb.ts` (byte-identical
to run 5 apart from the timestamp, `out-verify.txt`), `validate.ts`, `roster.ts` and `tiers.ts`, and added
`fc-*.ts` checks in the same folder (§13.1). It fixed the doc in place. The main corrections, each marked *(fact-check
Fn)* where it lands:

| # | Finding | Fix |
|---|---|---|
| F1 | **Mentoring (D23) was a power-levelling engine.** With a capped member's weight at 0, a level-20 farming alone hands its whole kill stream to a friend standing within 60 m: **4.4× a level-1's own solo EXP/h, 1.8× at 8, 1.4× at 12–15, 1.2× at 17** [confirmed: `fc-powerlevel.ts`] | §7.1: the capped member's weight stays 0, but a kill pays the party pool × the **uncapped members' share of the damage, at least 25 %**: a pure carry drops to 0.26–1.09× (0.35× at 12–15) |
| F2 | **Both ferry sellers stand on the town's bank.** Doji and Chau are both in the town's walkable component 0; the far bank is component 1 [confirmed: `fc-nav.ts` on `jangan-fields` `nav.bin`] | §2.7: a far-bank ferryman (an authored NPC row on Doji's model) for the way back; landing candidates found |
| F3 | **The area remap leaves 3 derived rows with no nest** (Broken Stone Ghost 8, Restless Tomb Stone 15, Powder Ghost 19), the Robbers' Camp with 17 matching monsters for the 11–12 spot, and **≈ 1,245 monsters with no row in their area's band** (B5 alone 402: Bandit Subordinates, Young Tigers, Yeoha) [confirmed: `fc-remap.ts`] | §2.2: a fallback rule, per-nest overrides, two new B5 rows |
| F4 | **JG_013 (level 9) sends players to the Qin-Shi gate**, which becomes B4 (12–14, aggressive packs); §8.1's "levels move by at most one" was wrong (Chakji Worker moves by 2, JG_013's targets by 4–6) [confirmed: `jangan.json` hints `LOC_QIN_GATE`] | §8.1: JG_013's hints move to the Chinese Tomb |
| F5 | **Rebirth refund + the nemesis refund paid more than the loss** (100 % + 50 %) | §6.3: refunds of one death never exceed its loss; `penaltyRefunded` event |
| F6 | **Combat logout dodged the penalty**: closing the tab removes the character at once (`connection.ts` `leaveWorld`) [confirmed: read] | §6.1: a 10 s combat linger |
| F7 | The springs' 7.5-min trip (HOT_SPRINGS §5.3) was not charged | §3.3: with it the same curve gives **41.6 h** (soaker 37.2 h) [confirmed: `fc-climb.ts`]; the curve is kept |
| F8 | D10 contradicted NEMESIS (nemesis kills eligible for Rested and meals) and the Qilin's EXP pool breaks the "≤ 10 % of a level" budget in a duo | §3.5 aligned with the siblings |
| F9 | The mini-bosses need three uniques-module features that do not exist (area notices, an adds table, authored camps) and no lane owned `uniques.ts` [confirmed: `uniques.ts` header, `content.ts` `UniqueDef`] | §2.5, §17 CL-SV |
| F10 | T6 (03_B) has only 3 of 7 armour pieces wearable at ≤ 20, so its 4/6 set bonus was unreachable [confirmed: items.json] | §4.1, §4.2: a family is a degree |
| F11 | Smaller numbers: DPS index 0.85–1.32 after the band factor; two B1 attack rows; gold net/h negative at 8 and 12; worst penalty roll 2.3 h; SP ≈ 3,430; quest share 27 % of the curve; the run takes ≈ 40 s; title "Stormchaser"; B4 aggressive nests 43–47 m from B1/B2 nests | in place |

---

## 0. Summary

1. **Today the climb is short and skill does not matter** (§1). At the live rates (×3), a bot friend of mixed skill
   reaches 20 in **≈ 15 h of real play** (10.4 h of hunting + ≈ 3 h of questline + town time); a novice takes 16.0 h,
   a good player 14.2 h, and **nobody dies** at their level's own monsters except the level-16 Bandit and the
   level-18 White Tiger spikes [confirmed: the model, run 5]. Monsters come one at a time, the best EXP is 2–3 levels
   below you, gear is one shop tier, and SP is surplus from level 11. The far bank (90 nests, levels 19–24) is closed:
   no ferry.
2. **Seven bands drawn from the real map** (§2, `climb-bands-map.png`): **B1 the Millet Fields 1–5** (Grassland, Hill
   of Ye Mt.), **B2 Lake, Swamp and the Old Graves 5–10**, **B3 Yeoha's Forest 9–13**, **B4 the Tomb Approach 12–15**
   (the Qin-Shi Tomb's graveyard), **B5 the Tiger Mountains 14–18** (with the Bandit Stronghold), **B6 the Qin-Shi Tomb
   15–20** (the instanced group dungeon of TOMB_DUNGEON.md) and **B7 the Far Bank 17–20** (Jangan Ferry and the
   Western China fields, **opened by a ferry and re-levelled down from 19–24**). The user's example put the coast at
   17–20, but the coast lies around town or outside the play bounds (COAST §G1, S1 is next to the town wall); the far
   bank is the real, unused, high-level land.
3. **34 re-levelled monsters with roles, not just HP** (§2.2–§2.4): every field monster gets a band level on a
   standard-monster curve fitted to retail (HP, attack, defence, hit), its damage per second normalised into 0.85–1.2 ×
   standard before the band's attack factor (0.85–1.32 after it, *fact-check F11*), and one or two **roles**: **pack** (linked pulls of 2–3), **ranged** (archers and casters at 10–15 m),
   **healer** (12 % HP every 7 s, interruptible), **coward** (flees at 25 % HP and returns with help). Elite camps
   (a ×10-HP leader) for groups, and a **level-difference EXP rule** so the level's own monsters are worth hunting.
   Result: **skill matters**: at 14–17 a novice dies 2.5 times an hour at the level's own monsters, an average player
   1.2, a good one never; at 18–19 the novice 2.8, the others 0.25 (`climb-skill.png`) [confirmed: the model].
4. **One mini-boss per band, six in all** (§2.5), named elites on the wave-11 uniques module with local announcements
   and 20–75 min respawns: **Old Scar** (6), **the Drowned Magistrate** (10), **Gwangmu the Robber Chief** (14),
   **the Gate Warden** (16), **Heukpung the Black Wind** (18), **Mo-Dun the Hyungno Warlord** (20). The first four
   are soloable at their level; Heukpung needs a good player or a duo, Mo-Dun a duo or more [confirmed: 200 fights
   each]. **Tiger Girl** stays the level-20 capstone, re-tuned to BALANCE's U-BAL (`hpMul` 0.16, fury ×3).
5. **The curve** (§3, `climb-curve.png`): a new `levels` table, 1 → 20 = **1,464,406 EXP at ×1** (retail 1,124,480;
   the live ×3 is effectively 374,826). Solved from target hours per level, smoothed, then calibrated by Monte Carlo
   so the **mixed-play friend's median is 39.9 h** (p10 36.9, p90 43.7). **Solo only: 48.1 h. Mostly grouped:
   36.6 h.** The **last three levels are 21 of the 40 hours**; 19 → 20 alone is 9.6 h. Wave 13 is in the totals: the
   springs' Rested pool gives 13 % of the climb's EXP and dishes ≈ 4 %; without them the same friend needs 50.2 h;
   a friend who soaks every night needs 34.3 h. Charging the springs' 7.5-min trip per soaking session (HOT_SPRINGS
   §5.3) moves the mix to **41.6 h** and the soaker to 37.2 h, still the user's "about 40" (*fact-check F7*). Quests
   are 27 % of the curve (26 % of the EXP a friend actually earns, which includes re-earning penalty losses).
   **Rates go to ×1**.
6. **Gear tiers** (§4): seven tiers from retail degrees and grades (shop grade A as the floor, grades B/C from drops,
   quests and mini-bosses, the 126 wearable **Seal of Star** rows as the post-cap hunt), cheap **set bonuses** (4/6
   pieces of one family; 3/5 Seal of Star items), named empty slots **W15-A…D** and **W17-A…C** for the Wardrobe and
   Arsenal waves, drops per band, and a gold economy that pays the late potion bill through the questline (gold ×2 at
   11–19), the mini-bosses and the Tomb.
7. **Skill Arts** (§5): at weapon mastery 10, 15 and 20 the player picks one of two **Arts** per line (24 in all:
   three weapon trees and one force tree), number-only changes to existing skill rows (damage, cooldown, targets,
   stun length, MP): **no new animation**. SP-EXP stays equal to kill EXP: 3,329 SP at 20 from kills and quests
   (≈ 3,430 with the Rested SP-EXP and re-earned penalty losses) against 2,950 for the P0 build plus every Art tier.
8. **The death penalty, as the user asked** (§6): from level 15, a death to a monster or a boss (nemesis, Qilin and
   dungeon bosses included) takes a random **1–20 % of the current level's EXP bar**, never below the bar's start (no
   de-level), never in a duel or the arena, with a clear message. Two safeguards the model showed are needed: a
   **10-minute grace** (a second death within 10 min of a penalised one costs nothing) and a **protective
   consumable**, the **Ancestor's Incense** (never sold; quests, mini-bosses, the Tomb). A friend's **Soul Rebirth
   Art refunds half** the loss. Cost in the model: the mixed friend dies 3.3 times on the climb and loses 76,940 EXP
   (2.2 h); without the grace, novices spiralled (a death every 20 min at 3–5 deaths/h) [confirmed: runs 2–5].
9. **Post-cap** (§7): Seal of Star hunts, the mini-boss and Tiger Girl rotations, the Tomb's weekly loot, the Art
   tier 20, **mentoring** (a capped member no longer takes the party's EXP, but a kill it makes alone pays the party
   only 25 %: no power-levelling, *fact-check F1*), and an **achievements and titles** hook that NEMESIS and
   STORM_QILIN also use.
10. **The questline** (§8): the 35 quests of "The Tiger's Shadow" keep their order; their EXP is rewritten as a share
    of the new curve (50 % at 1–5, 35 % at 6–10, 30 % at 11–15, 25 % at 16–19), gold ×2 at 11–19, and 13 new quests
    fill the new bands (the Tomb Approach, the ferry, the far bank, the six bounties, the penalty's intro; the Tomb's
    entry quest is TOMB_DUNGEON's JG_T01).
11. **Migration** (§9): one migration and a login step keep every live character's **level, bar fraction, SP, skills,
    items and quests**; EXP is converted by fraction of the bar, never down a level; characters at 15+ get two
    Incense; everyone gets the title "Pioneer". The rates change is one line in the mini PC's `silkroad.local.env`
    at deploy, with the user's OK.

### 0.1 Where each part of the request lands

| Request (verbatim fragment or task item) | Where |
|---|---|
| "We adjust monster's levels and difficulty" | §2.1–§2.4: bands, the re-levelled roster, roles, elite camps, the level rule |
| "also unique monster's" | §2.5 the six band mini-bosses; §2.6 Tiger Girl as the capstone |
| "Level 20 should be difficult to reach" | §3: the last three levels are 53 % of the climb; §2.4 the late bands' deaths; §6 the penalty |
| "is also boring" | §1.4 today's boredom, measured; §2.3 roles; §4 tiers; §5 Arts; §7 goals at the cap |
| (a) bands by area, packs, ranged, healers, flee and call, elite camps, a mini-boss per band | §2 |
| (b) EXP curve and rates, ~40 h, last levels hardest, groups a little faster, wave 13 in the totals | §3 |
| (c) gear tiers, set bonuses, named slots for waves 15 and 17, drops per band | §4 |
| (d) skill ranks or choices, SP pacing | §5 |
| (e) the death penalty (#13), a protective consumable | §6 |
| (f) post-cap goals | §7 |
| (g) questline pacing | §8 |
| (h) migration of the 3 live accounts | §9 |
| Prototype: bots with real skills, time per level solo/group, deaths/h, gold/h, charts | §13, `work/tmp/climb/out/` |

---

## 1. Today [confirmed unless tagged]

### 1.1 Every area and its nests

From `work/out/data/nests.json` (825 Jangan nests), `zones.json` (area names by region) and the live nest list of a
real server start (`work/tmp/balance/live-nests.json`, 700 nests spawned) [confirmed: `work/tmp/climb/survey.ts`].
"Nearest" is the closest nest to the town gate (96.9, −136.9).

| Area | Regions (x × z) | Nests (spawned) | Monsters | Aggressive nests | Levels | Nearest | Monsters by kind |
|---|---|---|---|---|---|---|---|
| Grassland | 165–170 × 94–98 | 80 (80) | 1,057 | 2 | 1–10 | 269 m | Mangyang 735, Small-Eyed Ghost 202, Big-Eyed Ghost 40, Old Weasel 10, Yeoha 70 |
| Hill of Ye Mt. | 170–173 × 95–99 | 76 (76) | 728 | 7 | 1–9 | 368 m | Old Weasel 276, Weasel 251, Big-Eyed 90, Mangyang 60, stone ghosts 41 |
| Swamp area | 165–170 × 99–100 | 56 (56) | 555 | 1 | 5–10 | 369 m | Water Ghost 300, Water Ghost Slave 200, Weasel 40 |
| Lake Forest | 165–170 × 92–95 | 66 (66) | 647 | 7 | 1–10 | 444 m | Big-Eyed 238, Small-Eyed 170, Old Weasel 120, tombstones 40, Yeoha 28 |
| Enterance of Qin-Shi Tomb | 171–174 × 100–102 | 76 (75) | 365 | 54 | 8–9 (+30) | 666 m | Stone Ghost 135, Broken Stone Ghost 130, Tomb Stone Ghost 98 |
| Yeoha's Forest | 163–164 × 93–99 | 55 (55) | 515 | 21 | 10–16 | 707 m | Decayed Yeoha 210, Yeoha 160, Young Tiger 96, Tiger 24 |
| Chinese Tomb | 171–173 × 92–94 | 45 (45) | 312 | 35 | 8–9 | 866 m | Tomb Stone 216, Tomb Stone Ghost 60, Stone Ghost 36 |
| North-Tiger Mt. | 156–162 × 93–97 | 102 (102) | 823 | 78 | 10–20 | 1,106 m | Tiger 184, Black Tiger 162, White Tiger 136, Young Tiger 128, Bandit 68, … Tiger Girl 4 camps |
| South-Tiger Mt. | 156–164 × 90–92 | 82 (82) | 687 | 55 | 10–20 | 1,196 m | Bandit 214, Bandit Subordinate 148, White Tiger 88, Bandit Archer 74, Bandit Bowman 70, … Tiger Girl 3 |
| Jangan Ferry | 157–161 × 96–97 | 13 (13) | 122 | 6 | 14–19 | 1,402 m | Chakji Worker 70, Tiger 24, Bandit 20, White Tiger 8 |
| Western China Ferry | 156–161 × 98–100 | **35 (0)** | 347 | 21 | 19–22 | 1,473 m | Chakji 180, Chakji Worker 130, Devil Bug 27, Ghost Bug 10 |
| Western China Main Road | 157–161 × 100–102 | **37 (0)** | 343 | 24 | 19–24 | 1,538 m | Ghost Bug 100, Devil Bug 91, Chakji 87, Hyungno Ghost Soldier 46 |
| Bandit's Mountain Stronghold | 159–161 × 91–92 | 50 (50) | 284 | 50 | 12–20 | 1,595 m | Bandit 192, Bandit Archer 80, Tiger Girl 4 |
| Western China Ruins | 157–159 × 102 | **18 (0)** | 162 | 10 | 21–24 | 1,863 m | Hyungno Ghost Soldier 90, Hyungno Ghost 45, Ghost Bug 27 |
| Earth Ghost Canyon, Entrance-WC Donwhang | 155–156 × 97–102 | 34 (0) | 209 | 27 | 24–30 | 2,313 m | Earth Ghost, Meek Gun Powder, Earth Taoist (outside the bounds or above `MOB_LEVEL_MAX`) |

- **The far bank is closed.** The 90 nests of the three Western China areas (852 monsters) are skipped as "unreachable
  on foot from town" [confirmed: BALANCE §2, DEPLOY.md's startup line "91 unreachable … no ferry teleport yet"; the
  live list has 0 of them]. The spawner and the server's placements accept only the town spawn's walkable component
  (`apps/server/src/nav.ts` `setHome`, `home`) [confirmed: read]. **The far bank is one walkable component (id 1)**,
  and it also holds Earth Ghost Canyon and the Donwhang entrance (Earth Ghost 27, Earth Taoist 30, Meek Gun Powder 27,
  9 Hyungno Ghosts 24); the town, the Tiger Mountains, the Stronghold and Jangan Ferry are component 0 [confirmed:
  `fc-nav.ts`, `fc-nav2.ts` on the `jangan-fields` `nav.bin`].
- **The coast is not a band.** S1 (Jangan South Beach) is against the town wall and the rest of the coast lies in the
  export ring outside the play bounds (COAST §G1) [confirmed: COAST.md]; no nest is on a beach [confirmed: survey].

### 1.2 The curve, kill EXP, quests, rates

- **The curve**: `levels.json` 1 → 20 = **1,124,480 EXP** (118 … 238,878) [confirmed: data].
- **Kill EXP** = `MobDef.exp × variant` (`gameplay.ts` `killExp`), and retail's monster EXP is 23.5 × level for every
  Jangan monster (24, 47, 71 … 447) [confirmed: mobs.json]. **No penalty for monsters below you** [confirmed:
  `killExp` has no level term].
- **SP-EXP = kill EXP** (no mob has `spExp`; `CHARACTER_RULES.spExpPerSp` 400) [confirmed: BALANCE §4, content.ts].
- **Quests**: 35 quests; the non-repeatable ones give 342,890 EXP (30.5 %), 576 SP and 116,200 gold
  [confirmed: QUESTS §3.4; gold summed from `content/quests/jangan.json`].
- **Rates**: the live server runs EXP/SP/GOLD ×3 and DROP ×2 in the mini PC's `~/silkroad/silkroad.local.env`
  (DEPLOY.md "Game rates") [confirmed: the task brief; the file is on the mini PC, not in the repo].
- **Party**: a pool of `exp × (1 + 0.1 × (n − 1))` split by level weight among members within 60 m
  (`party.ts` `partyPool`, `levelShares`, `PARTY_SHARE_RANGE`) [confirmed: read].

### 1.3 How fast a bot reaches 20 today [confirmed: the model, `climb.ts` §1, run 5]

Bot players (blade and glaive, BALANCE's character), the **typical** policy (skills, the imbue in multi-monster pulls,
an HP potion under 40 %, MP potions in packs, sitting when low), three skill tiers (§2.4), 1-h sessions at the best
retail monster from 3 levels below to 2 above, the live ×3 rates, the questline's EXP, 3 h of questline walking and
15 % town time.

| | Novice | Average | Good | Mix (25/50/25) |
|---|---|---|---|---|
| Hunting hours 1 → 20 | 11.3 | 10.4 | 9.7 | 10.4 |
| **Real play to 20** | **16.0 h** | **15.0 h** | **14.2 h** | **15.0 h** |
| Deaths per hour at the chosen spot | 0 | 0 | 0 | 0 |

At the level's own monster (one at a time), deaths are zero everywhere except Bandit 16 (novice 0.96/h) and White
Tiger 18 (novice 0.49/h); damage per fight is 2–25 % of HP below 14 (`climb-skill.png`, pale bars).

### 1.4 What makes it boring, measured

| Symptom | Measure [confirmed: the model unless noted] |
|---|---|
| Skill barely matters | A novice earns 77–93 % of a good player's EXP per hour from level 6 on, and dies ≈ never |
| The best EXP is below you | At 8–19 the best spot is 2–3 levels below (Stone Ghost 9 at 10–12, Black Tiger 17 at 19), as BALANCE §3 found |
| One monster at a time | No links, no adds beyond a 3–15 % aggressive neighbour, no healers, no fleeing, no ranged threat in practice |
| Fast | 15 h to the cap at ×3 (the user: "retail never meant for you to take long to get to 20") |
| Gear is one shop tier | Shops sell only grade A of each degree (10/10 of each grade-A set; 0 of grades B and C) [confirmed: `shops.json` vs `items.json`, `tiers.ts`]; grades B/C and the Seal of Star rows exist but come from nowhere but Tiger Girl |
| SP is surplus | 2,530 SP at 20 against a 1,930 build, no constraint after 11 (BALANCE §4) |
| The map dead-ends | 90 high-level nests closed across the river; nothing to chase at the cap but Tiger Girl every 3–6 h |

---

## 2. The bands and the monsters (a)

### 2.1 The bands [decision]

`work/tmp/climb/out/climb-bands-map.png` shows every nest coloured by its band.

| Band | Name | Levels | Areas | Distance from the gate | Character |
|---|---|---|---|---|---|
| **B1** | The Millet Fields | 1–5 | Grassland, Hill of Ye Mt., the Lake Forest's north | 270–450 m | The tutorial: singles and small herds; the first runners at 4–5 |
| **B2** | Lake, Swamp and the Old Graves | 5–10 | Lake Forest, Swamp area, Chinese Tomb (south-east) | 370–870 m | The first healers (Water Ghost) and casters (tombstones) |
| **B3** | Yeoha's Forest | 9–13 | Yeoha's Forest, the Robbers' Camp, the forest edge of the Grassland | 700–900 m | Packs that heal, robbers that run and shout, archers |
| **B4** | The Tomb Approach | 12–15 | Enterance of Qin-Shi Tomb | 680 m | The graveyard of the dungeon: aggressive stone packs, keepers that heal them; the Gate Warden at the doors |
| **B5** | The Tiger Mountains | 14–18 | North- and South-Tiger Mt., Bandit's Mountain Stronghold | 1.1–1.6 km | Tigers in pairs, bandits that shout, archers on the walls; Tiger Girl's 11 camps |
| **B6** | The Qin-Shi Tomb | 15–20 | the instance behind the Tomb doors | 680 m (door) | The group dungeon: TOMB_DUNGEON.md owns it; this spec gives its EXP and loot budget (§3.5, §4.4) |
| **B7** | The Far Bank | 17–20 | Jangan Ferry, Western China Ferry, Main Road, Ruins | 1.4–1.9 km | The cap's fields: Western China's monsters brought down to 17–20, opened by the ferry (§2.7) |

- **Why these lines:** levels follow distance from town on the real map (the town sits in B1; B2 rings it at
  370–870 m; B3 and B4 are 700 m west and north-east; B5 and B7 are past 1.1 km), every band keeps its retail
  monsters (players recognise them), and the bands overlap by 1–2 levels so a player never runs out of at-level
  monsters [confirmed: the roster below has a monster at every level 1–20]. The distance rule is approximate: the
  Tomb Approach (B4, nearest nest 666 m) is nearer than the Chinese Tomb (B2, 866 m), and **its aggressive nests come
  within 47 m of a B1 nest and 43 m of a B2 nest** (10 and 5 of its 53 aggressive nests within 100 m) [confirmed:
  `fc-borders.ts` over the live nests]. *(fact-check F11)*
- **The B4 border is passive** [decision]: the B4 nests within 100 m of a B1 or B2 nest (≈ 15) lose `aggressive` in
  `bands.json`, so a level-3 player at the Hill of Ye sees a level-13 pack before it sees them. Reason: today those
  nests are level 8–9; at 12–15 with links, an aggressive edge would kill every newcomer who strays.
- **Earth Ghost Canyon and the Donwhang entrance stay closed** (levels 27–30, partly outside the bounds): their
  models are free for TOMB_DUNGEON's interior and NEMESIS [decision].
- **The coast**: S1 stays a safe hangout (fishing, swimming); the springs' sanctuary polygon stays spawn-free
  (HOT_SPRINGS §5.7) [decision].

### 2.2 The roster [decision; numbers confirmed: `work/tmp/climb/roster.ts`]

Every monster becomes a **derived** monster: a new code (`MOB_CL_*`) on a retail base (model, skills, clips), with:

- **HP** × `std.hp(new) / std.hp(base level)` and **attack** × `std.atk(new) / std.atk(base level)`, where `std` is a
  quadratic fit of ln HP and ln attack over the retail normal monsters of levels 1–24 [confirmed: `lib.ts` `std`];
- **damage per second normalised** into 0.85–1.2 × standard (attack row × attack multiplier ÷ the longest of interval,
  clip and cooldown) before the band attack factor below, so 0.85–1.32 × after it [confirmed: `roster.ts` "DPS idx"
  column; *fact-check F11*: the draft said 0.85–1.2 for the final value], so a monster's speed stays (tigers hit small
  and often) but no single monster is a spike: the roles make the difficulty;
- **defence** shifted by the standard curve's difference, **hit and parry** = 25 + 2 × level, **absorb** = level (the
  retail rules, exact for every Jangan monster) [confirmed: mobs.json];
- **EXP** = 23.5 × level (retail's rule) and **gold** = the standard gold of the level × the band's gold factor;
- a **band attack factor**: B1 1.0, B2 1.05, B3 1.1, B4 1.05, B5 1.05, B6 1.15, B7 1.05 (tuned in §2.4).

| Band | Code | Base (retail) | Name | Lv | Roles | HP | Hit (attack row × multiplier) | EXP |
|---|---|---|---|---|---|---|---|---|
| B1 | MOB_CL_MANGNYANG_1 | Mangyang 1 | Mangyang | 1 | — | 54 | 24–27 / 3.0 s | 24 |
| B1 | MOB_CL_SMALLEYE_2 | Small-Eyed Ghost 2 | Small-Eyed Ghost | 2 | pack | 55 | 21–23 / 2.0 s | 47 |
| B1 | MOB_CL_BIGEYE_3 | Big-Eyed Ghost 3 | Big-Eyed Ghost | 3 | pack | 85 | 23–27 / 1.5 s | 71 |
| B1 | MOB_CL_OLDWEASEL_4 | Old Weasel 4 | Old Weasel | 4 | coward (calls 1) | 83 | 30–34 / 2.0 s | 94 |
| B1 | MOB_CL_WEASEL_5 | Weasel 5 | Weasel | 5 | coward (1), pack | 119 | 35–40 / 2.0 s | 118 |
| B2 | MOB_CL_WGSLAVE_6 | Water Ghost Slave 6 | Water Ghost Slave | 6 | pack | 114 | 2.0 s | 141 |
| B2 | MOB_CL_WATERGHOST_7 | Water Ghost 7 | Water Ghost | 7 | healer | 156 | 2.0 s | 165 |
| B2 | MOB_CL_BROKENSTONE_8 | Broken Stone Ghost 8 | Broken Stone Ghost | 8 | pack | 204 | 1.5 s | 188 |
| B2 | MOB_CL_TOMBGHOST_8 | Tomb Stone Ghost 8 | Tomb Stone Ghost | 8 | ranged caster (10 m) | 204 | 2.5 s | 188 |
| B2 | MOB_CL_STONEGHOST_9 | Stone Ghost 9 | Stone Ghost | 9 | pack | 194 | 2.5 s | 212 |
| B2 | MOB_CL_TOMBSTONE_9 | Tomb Stone 9 | Tomb Stone | 9 | ranged, healer | 194 | 2.5 s | 212 |
| B3 | MOB_CL_YEOHA_10 | Yeoha 10 | Yeoha | 10 | pack | 249 | 2.5 s | 235 |
| B3 | MOB_CL_DECAYED_10 | Decayed Yeoha 10 | Decayed Yeoha | 10 | healer | 249 | 2.5 s | 235 |
| B3 | MOB_CL_BANDITSUB_11 | Bandit Subordinate 11 | Bandit Subordinate | 11 | coward (calls 1) | 310 | 1.5 s | 259 |
| B3 | MOB_CL_ARCHER_12 | Bandit Archer 12 | Bandit Archer | 12 | ranged (13 m) | 324 | 2.5 s | 282 |
| B3 | MOB_CL_YOUNGTIGER_12 | Young Tiger 13 | Young Tiger | 12 | pack | 334 | 1.5 s | 282 |
| B3 | MOB_CL_YEOHA_13 | Yeoha 10 | Elder Yeoha | 13 | pack (HP ×1.1) | 433 | 2.5 s | 306 |
| B4 | MOB_CL_GRAVESTONE_12 | Broken Stone Ghost 8 | Grave Stone Ghost | 12 | pack | 388 | 1.5 s | 282 |
| B4 | MOB_CL_SENTINEL_13 | Stone Ghost 9 | Tomb Sentinel | 13 | pack | 361 | 2.5 s | 306 |
| B4 | MOB_CL_KEEPER_14 | Tomb Stone Ghost 8 | Tomb Keeper | 14 | ranged, healer | 518 | 2.5 s | 329 |
| B4 | MOB_CL_RESTLESS_15 | Tomb Stone 9 | Restless Tomb Stone | 15 | ranged caster | 477 | 2.5 s | 353 |
| B5 | MOB_CL_TIGER_14 | Tiger 14 | Tiger | 14 | pack | 509 | 1.5 s | 329 |
| B5 | MOB_CL_BOWMAN_15 | Bandit Bowman 15 | Bandit Bowman | 15 | ranged (13–15 m) | 514 | 2.5 s | 353 |
| B5 | MOB_CL_BANDIT_16 | Bandit 16 | Bandit | 16 | coward (calls 1) | 755 | 1.5 s | 376 |
| B5 | MOB_CL_BLACKTIGER_16 | Black Tiger 17 | Black Tiger | 16 | pack | 660 | 1.5 s | 376 |
| B5 | MOB_CL_WHITETIGER_17 | White Tiger 18 | White Tiger | 17 | pack | 717 | 1.5 s | 400 |
| B5 | MOB_CL_ARCHER_17 | Bandit Archer 12 | Stronghold Archer | 17 | ranged | 641 | 2.5 s | 400 |
| B7 | MOB_CL_CHAKJIWORKER_17 | Chakji Worker 19 | Chakji Worker | 17 | coward (calls 1–2) | 757 | 2.0 s | 400 |
| B7 | MOB_CL_CHAKJI_18 | Chakji 20 | Chakji | 18 | pack | 823 | 2.0 s | 423 |
| B7 | MOB_CL_GHOSTBUG_18 | Ghost Bug 21 | Ghost Bug | 18 | pack | 796 | 1.5 s | 423 |
| B7 | MOB_CL_DEVILBUG_19 | Devil Bug 22 | Devil Bug | 19 | pack | 866 | 1.5 s | 447 |
| B7 | MOB_CL_POWDER_19 | Meek Gun Powder 27 | Powder Ghost | 19 | ranged caster (13 m) | 701 | 3.5 s | 447 |
| B7 | MOB_CL_HYUNGNO_19 | Hyungno Ghost Soldier 23 | Hyungno Ghost Soldier | 19 | pack | 842 | 2.0 s | 447 |
| B7 | MOB_CL_HYUNGNOSHAMAN_20 | Hyungno Ghost 24 | Hyungno Shaman | 20 | healer | 916 | 2.0 s | 470 |

- **Every level 1–20 has a field monster**, and 13–19 have two or more [confirmed: the table]. (B1 attack rows of
  Mangyang and Big-Eyed Ghost corrected to the multiplied values: `roster.ts`; *fact-check F11*.)
- **Where they live:** the nests keep their places; a per-area remap (`content/climb/bands.json`, §10.2) turns each
  retail code into its derived code in that area (a Stone Ghost nest at the Chinese Tomb becomes Stone Ghost 9; one
  at the Qin-Shi entrance becomes Tomb Sentinel 13). The Grassland's forest-edge Yeoha nests join B3; the Lake
  Forest's level-1–4 nests join B1 [decision].
- **A pure area remap does not produce this roster** *(fact-check F3)* [confirmed: `fc-remap.ts` over the 825 nests
  and the model's `ROSTER`]:
  - **three rows would have no nest and one spot almost none**: Broken Stone Ghost 8 (no Broken Stone Ghost lives in a B2 area: 130 are
    at the Qin-Shi entrance, 20 on the Hill of Ye), Restless Tomb Stone 15 (no Tomb Stone lives at the Qin-Shi
    entrance), Powder Ghost 19 (Meek Gun Powder lives only at the Donwhang entrance and Earth Ghost Canyon), and the
    Robbers' Camp (Yeoha's Forest holds 10 Bandit Subordinates, 7 Bandit Archers, 8 Bandits: 25 monsters for the
    model's level-11–12 spot, an elite camp and MB3);
  - **≈ 1,245 monsters have no row in their area's band**: the Lake Forest's 558 low monsters and the Grassland's 70
    forest-edge Yeoha (both covered by the exceptions above), **B5's 402** (Bandit Subordinate 11 ×208, Young
    Tiger 13 ×136, Yeoha 10 ×58), the Hill of Ye's 41 stone ghosts, Jangan Ferry's 52 (Bandit, Tiger, White Tiger),
    Yeoha's Forest's 32 (Bandit, Tiger), the Swamp's 50 (Weasel, Decayed Yeoha), 10 Chakji Workers on North-Tiger Mt.
- **The remap rules that close the gaps** [decision; CL-D's data, tested by a content check that every live nest
  resolves to a derived row of its band or a named fallback]:
  1. **Fallback:** a retail code with no row in its area's band takes the row of the same base in the nearest band by
     level (the Hill of Ye's stone ghosts become B2's 8–9 rows; Jangan Ferry's Bandits, Tigers and White Tigers keep
     B5's 16/14/17 rows; Yeoha's Forest's 8 Bandits become Bandit Subordinate 11, its 24 Tigers Young Tiger 12).
  2. **Two new B5 rows** so the Tiger Mountains are not full of level-11 fodder: **Bandit Subordinate 15**
     (`MOB_CL_BANDITSUB_15`, coward) and **Young Tiger 14** (`MOB_CL_YOUNGTIGER_14`, pack); B5's Yeoha become Elder
     Yeoha 13. The roster is 36 rows. Both are on the standard curve with the same roles as their B3 siblings, so
     the model's B5 numbers hold [likely: the B5 spots already mix a coward and packs at 14–16].
  3. **Per-nest overrides** in `bands.json` (`nests: {id: derivedCode}`) where the model's spot needs a monster the
     area lacks: one in three Chinese Tomb Tomb Stone nests → Broken Stone Ghost 8; half the Qin-Shi entrance's Tomb
     Stone Ghost nests → Restless Tomb Stone 15 (and the rest Tomb Keeper 14); the Robbers' Camp gets the Yeoha's
     Forest nests nearest to it as Bandit Subordinate 11 / Bandit Archer 12 (2:1, to about 40 monsters; CL-D picks
     the ids on the map);
     Powder Ghost 19 comes from the Donwhang entrance's 21 Meek Gun Powder if they lie inside the play bounds, else
     from one in five Ruins Hyungno nests. The Donwhang entrance's 9 Hyungno Ghosts 24 become Hyungno Shaman 20; its
     Earth Ghosts and Taoists stay empty (above `MOB_LEVEL_MAX`).
  4. **NEMESIS stores retail codes** (NEMESIS §7 "the CLIMB migration table"): the remap is (area, retail code) →
     derived code, plus overrides by nest id, so NEMESIS maps a stored nemesis through its nest, not by code alone.
- **Champions** stay at 10 % per nest (retail) and giants at `GIANT_PCT` 1 % [confirmed: BALANCE §9; nests.json
  `championPct`].
- **Names**: retail names wherever a monster keeps its look; eight new names where one model lives at two levels
  (Grave Stone Ghost, Tomb Sentinel, Tomb Keeper, Restless Tomb Stone, Stronghold Archer, Hyungno Shaman, Powder
  Ghost, Elder Yeoha) [decision].

### 2.3 Roles: the behaviours [decision; each is a server rule and a test]

| Role | Rule | Who | What it asks of the player |
|---|---|---|---|
| **pack** | When one member is hit or aggroes, up to 2 nest-mates within 12 m join after 0.5–2 s (`link {radiusM 12, max 2}`) | ghosts, slaves, stone packs, Yeoha, tigers, Chakji, bugs, Hyungno | Pull from the edge; AoE (glaive) shines; a bad pull is 3 |
| **ranged** | Attacks from its row's range (10–15 m); keeps distance: steps back once per 6 s when a melee player is within 4 m | archers, bowmen, tombstones, Keeper, Powder Ghost | Close in or line-of-sight pull it (around a rock or tree it walks into melee); the blade's Soul Cut Blade (12 m) |
| **healer** | Every 7 s, if an ally within 15 m is under 70 % HP, a 1.4 s cast (its own attack clip, READY+SHOT) heals the most hurt ally for 12 % of its max HP; a stun or knockdown cancels the cast | Water Ghost, Decayed Yeoha, Tomb Stone, Tomb Keeper, Hyungno Shaman | Kill the healer first, or interrupt it (Soul Spear – Move, Blood Blade Force) |
| **coward** | Under 25 % HP, 60 % flee: run away from the attacker for 5 s at its run speed (no attack); if alive at the end, it shouts (area line "… calls for help!") and 1 (B7 Chakji Worker: 1–2) idle monster of its nest joins 3 s later; a helper never flees | Weasels, Bandit Subordinates, Bandits, Chakji Workers | Burst it before 25 %, stun it, or hit it at range; chasing with melee loses about half the hits |
| **elite camp** | One leader of the `elite` variant (×10 HP, ×5 EXP, ×1.5 attack: `VARIANT_RULES.elite` [confirmed: formulas.ts]) with 2–3 guards; respawn 10–15 min; 30 % chance of one tier item (§4.4) | Robbers' Camp (B3), Tomb Approach (B4), Stronghold yard (B5), Ruins war camp (B7) | Groups of 2–4 |

- **Level-difference EXP** (new rule): a monster 2 or more levels below you pays −15 % per level from the second
  (2 below 85 %, 3 below 70 %, … floor 10 %); one above you pays +5 % per level (at most +15 %) [decision: the level's
  own monsters must be worth the danger, or players farm two levels down as today; tested in the model].
- **Everything is data**: roles, link radius, flee share, call count, heal size and period live in
  `content/climb/roster.json` and `roles.json` (§10.2), so tuning is a content edit.

### 2.4 Difficulty, measured [confirmed: `work/tmp/climb/tune.ts` 3–4 h sessions and `climb.ts` run 5]

**Skill tiers** (the bots): novice (72 % uptime, kills the healer first 30 % of the time, uses control on a runner or
healer 30 %, chases at 30 % uptime, line-of-sight pulls 10 %, bigger pulls, drinks below 30 % after 1.0 s, at most 4
HP potions a pull); average (85 %, 70 %, 65 %, 45 %, 45 %, as drawn, below 40 % after 0.5 s, 6 a pull); good (95 %,
95 %, 95 %, 60 %, 85 %, smaller pulls, below 50 % after 0.15 s, 12 a pull).

At the level's own spot, solo, per hour (blade and glaive averaged; `climb-skill.png`):

| Levels | Spot | Damage per pull (avg) | Deaths/h novice / average / good | Novice EXP/h as % of good |
|---|---|---|---|---|
| 1–5 | the fields | 12–31 % | 0.1 / 0 / 0 (today 0 / 0 / 0) | 50 % (today 44 %) |
| 6–9 | swamp, old graves | 18–44 % | 0 / 0 / 0 | 78 % (today 80 %) |
| 10–13 | Yeoha, robbers, cubs | 36–61 % | 0.12 / 0 / 0 | 87 % (today 84 %) |
| 14–17 | Tomb Approach, tigers, bowmen, stronghold | 60–122 % | **2.5 / 1.2 / 0** (today 0.2 / 0 / 0) | 76 % (today 86 %) |
| 18–19 | ferry, ruins | 79–124 % | **2.8 / 0.25 / 0.25** (today 0.25 / 0 / 0) | 85 % (today 88 %) |

- **Solo-friendly to about 15**: below 14 an average player does not die at the level's own monsters; from 14 a
  careless one does, and the death penalty starts at 15 [confirmed].
- **Potions matter from 14**: an average player drinks 0.7–1.8 HP and 0.4–1.2 MP potions per pull at 14–20, against
  0.1–0.7 below [confirmed].
- **Damage per pull** is the average player's, at the level's own spot (`tune.ts` with the final band factors).
- **What the model leaves out** (they make real play harder, not easier): terrain and line of sight, aggressive
  neighbours walking into a fight beyond the pull table, lag, players fighting each other's pulls. The first playtest
  replaces the tiers' numbers (§15 U3).

### 2.5 The band mini-bosses [decision; fights confirmed: `climb.ts` §5, 200 fights per row, run 5]

Named elites on the **wave-11 uniques module** (`apps/server/src/uniques.ts`, data-driven `content/uniques.json`): one
alive at a time each, a fixed spot, **area announcements** (players within 300 m and the band's zone, not the whole
server), respawn as listed, the same reset rules as Tiger Girl (leash, regen, adds despawn). Each is a derived
monster at `hp`× and `atk`× of its band's normal, with HP-band adds (the existing summon mechanism, clipped like hers).

| Id | Name | Base model | Lv | HP | EXP | Adds | Where | Respawn |
|---|---|---|---|---|---|---|---|---|
| MB1 | Old Scar, the Weasel King | Weasel (champion skin) | 6 | 2,004 | 1,692 | 2 Weasels at 50 % | Hill of Ye Mt., the Old Tiger Shrine | 20–30 min |
| MB2 | The Drowned Magistrate | Water Ghost (champion skin) | 10 | 4,141 | 3,290 | 2 Water Ghosts at 70 %, 2 Slaves at 35 % | the Heart of the Swamp | 25–40 min |
| MB3 | Gwangmu the Robber Chief | Bandit Subordinate (champion skin), coward | 14 | 6,752 | 4,935 | 2 Archers at 75 %, 2 Subordinates at 40 % | the Robbers' Camp | 30–45 min |
| MB4 | The Gate Warden | Stone Ghost (giant scale) | 16 | 9,793 | 6,016 | 2 Tomb Keepers (healers) at 60 % | before the Qin-Shi Tomb doors | 30–45 min |
| MB5 | Heukpung, the Black Wind | Bandit (champion skin) | 18 | 15,454 | 7,614 | 2 Stronghold Archers at 80 %, 2 Bandits at 50 % | the Stronghold's hall | 40–60 min |
| MB7 | Mo-Dun, the Hyungno Warlord | Hyungno Ghost Soldier (giant scale) | 20 | 16,905 | 9,400 | 1 Shaman at 70 %, 2 Soldiers at 40 % | the Ruins' war camp (far bank) | 45–75 min |

| Fight (win % / median time / deaths per fight / potions, whole party) | MB1 | MB2 | MB3 | MB4 | MB5 | MB7 |
|---|---|---|---|---|---|---|
| Solo, its level, average | 100 / 2.1 min / 0 / 8 | 100 / 2.9 / 0 / 15 | 100 / 5.9 / 0 / 27 | 100 / 9.0 / 0 / 33 | **0** | **0** |
| Solo, its level, good | 100 / 1.5 / 0 / 6 | 100 / 2.2 / 0 / 11 | 100 / 4.0 / 0 / 19 | 100 / 5.7 / 0 / 21 | 92 / 9.1 / 0.09 / 44 | **0** |
| Duo, its level, average | 100 / 0.9 | 100 / 1.0 | 100 / 2.0 | 100 / 3.1 | 100 / 5.4 / 0 / 30 | 100 / 6.9 / 0 / 36 |
| Party of 4, its level | 100 / 0.5 | 100 / 0.4 | 100 / 0.6 | 100 / 1.2 | 100 / 2.3 / 0 / 18 | 100 / 3.2 / 0 / 21 |

- **The curve of the bosses matches the user's split**: MB1–MB4 are solo content at their level (MB4 costs a solo
  player ≈ 33 potions, ≈ 13,000 gold: worth a friend), MB5 needs a good player or a duo, MB7 a duo or more, and Tiger
  Girl a party of 3–4 (BALANCE §8.1) [confirmed: the table; BALANCE §8.1].
- **Rewards** (§4.4): one band-tier item (+0–2) always, a 25 % Ancestor's Incense, an elixir 20 %, and from MB4 up
  a 3–5 % Seal of Star item; kill counts feed titles (§7.3).
- **More mini-uniques? Six, no more** [decision: one per field band is the "~5 levels" the user asked for; the Tomb's
  bosses are TOMB_DUNGEON's, the Qilin is STORM_QILIN's, nemeses are NEMESIS's: four sources of named monsters is
  plenty for a friends' server]. Retail's other uniques (Cerberus 24, Captain Ivy 30, Uruchi 40) do not live on this
  map (UNIQUES §0.6) and are not imported.
- **Model limits**: adds join 1.5 s after their HP band, the boss's own skills are its retail rows (the wave-8
  system), no enrage or fury on the six (they are short fights by design).
- **What the uniques module must gain** *(fact-check F9)* [confirmed: `apps/server/src/uniques.ts` header and
  `packages/shared/src/content.ts` `UniqueDef`]: today a unique's notices go to **every** world socket
  (`announce {appear, defeat, roarRadiusM}`), its adds come only from **its base's own retail summon rows**
  (`summonPolicy`: the rows' 80/60/40 % bands), its camps are **nest ids** (`'uniqueGroup' | number[]`), and it
  spawns as the plain variant with `MobTuning`. The six need: (1) `announce.scope: 'area'` (300 m + the zone);
  (2) an `adds: [{code, n, atPct}]` table, used instead of the summon rows when present; (3) one **authored camp
  nest** each (a nest row in `bands.json`, merged into `data.nests` at load, so `camps: [id]` works unchanged);
  (4) `look: 'champion' | 'giant'` (the model and scale only, not `VARIANT_RULES`' HP/EXP multipliers, which
  `hp`/`exp` already carry). These are code in `uniques.ts` and `content.ts`, owned by CL-SV (§17); STORM_QILIN's
  QL-S also edits `uniques.ts` (exports), a shared-module owner WAVE_PLAN10 must settle.

### 2.6 Tiger Girl: the capstone [decision]

- **Level 20, the world boss of the Tiger Mountains**, unchanged in kind (UNIQUES): 11 camps, 3–6 h respawn, the
  world-wide announcement.
- **Tuning**: `content/uniques.json` still reads `hpMul` 0.08 and fury ×2 [confirmed: read]; BALANCE §8.1 recommended
  **`hpMul` 0.16 and fury ×3** so a party of 4 needs ≈ 6 min at 70 % uptime and a solo player is stopped
  [confirmed: BALANCE §8.1, `boss-rec.txt`]. Wave 14 applies that recommendation: she is the cap's party test. The
  player model at 20 is unchanged by this spec (same formulas, gear tiers ≥ BALANCE's shop gear), so BALANCE's fight
  numbers stand [likely: our tier-6 weapon is the 03_B row, a little stronger than BALANCE's 03_A; the party is
  faster, not slower].
- **Her adds** come from the White and Black Tigers: they now resolve to the re-levelled derived codes (White Tiger
  17, Black Tiger 16) through the same remap [decision: her summon rows name retail codes; the remap is applied to
  summons too].
- **Her EXP** (451,200, retail) is SP-EXP at the cap; the quest encounter JG_025 (level 19, `hpMul` 0.05) keeps its
  tuning.
- **Loot** gains the Seal of Star roll the wave-11 table already has (20 %) and the W17-B legendary's first hook
  (§4.5).

### 2.7 Opening the far bank [decision]

- **The ferry**: the two retail ticket sellers, **Doji** (−1307.8, −176.1) and **Chau** (−1887.0, 31.3), get a
  "Cross the river (200 gold)" dialog line that warps the player to a landing on the far bank (a server `warp` with
  the normal teleport rules) [confirmed: their positions in npcs.json]. **Both stand on the town's bank** (walkable
  component 0, the same as the town) *(fact-check F2)* [confirmed: `fc-nav.ts`], so the way back needs a seller on the
  far bank: **a far-bank ferryman**, an authored NPC row on Doji's model at the landing, with "Cross back (200
  gold)" [decision: no retail NPC stands in component 1]. **Open to every level, with a warning line below 17**
  ("The far bank is no place for the green, traveller."); JG_X07 "The Ferryman's Fee" (§8) makes the crossing free
  [decision: swimmers can cross anyway (below), so a level gate on the ferry only adds friction].
- **The landings** [confirmed: `fc-nav.ts`, a 4 m grid search for the nearest component-1 point]: 235 m south of Chau
  at (−1923, −201) and 325 m from Doji at (−1540, −404); CL-S picks the final points (open ground, no nest within
  40 m).
- **The nav**: the server's placement and spawn rule accepts **two home components**, the town's (0) and the far
  bank's (1) (`nav.ts` `setHome` becomes a list, the far bank found from a landing point in
  `content/climb/bands.json`) [decision: the smallest change; the walker already walks any component]. Component 1
  also holds Earth Ghost Canyon and the Donwhang entrance (§1.1): their nests stay empty by `MOB_LEVEL_MAX` or the
  remap (§2.2), but the land is walkable once the far bank is home.
- **Deaths on the far bank** return the player to town, so each costs a crossing (200 gold, or a swim) on top of the
  walk; the model's death walks are straight lines and miss this [projected: ≈ 1–2 deaths there per climb, a few
  hundred gold].
- **Swimming** (wave 13): SWIMMING keeps swimmers off shores outside the town's component and names `openShore` as
  the wave-14 hook [confirmed: WAVE_PLAN9 §0.2 F8]. With the far bank re-levelled, the far bank's shore rows are
  opened: **a player can swim across**, which is a fine adventure at 17–20 and harmless below (the far bank's
  monsters are 17–20 and aggressive; a level-8 swimmer will die and learn) [decision].
- **The component ids are known (0 and 1); the final landing points and the `openShore` rows are CL-S's** (a nav
  query on the real `nav.bin`, §17). The far bank's frame time is **[unknown]**: nobody has walked or measured it
  (CL-S runs the GPU-lock fps check there, §11).

---

## 3. The EXP curve and the rates (b)

### 3.1 How the curve was made [confirmed: `climb.ts` §3–§4]

1. **Target hours per level** for the mixed friend: geometric, ratio 1.255 a level, normalised to 40 h, so the last
   three levels are about half of the climb (20.0 of 40 h; `design.ts` `targetHours`, whose comment says 40 %:
   *fact-check F11*).
2. **EXP per hour per level** from the simulation of the new roster (§2.4), the "mix" friend: skill 25/50/25; solo
   time split between the level's own spot (novice 25 %, average 50 %, good 70 %, never one where that player dies
   more than once an hour) and the safest best spot; group time (10 % below 6, 20 % at 6–9, 30 % at 10–14, 50 % at
   15–19; novices +15 %) half as a duo, half as a party of 4.
3. **Solve** each level: `exp = hunting hours × EXP/h × (1 + meal) / (1 − quest share − rested share + penalty
   share)`, with the questline's walking and 15 % town time taken out of the hours first.
4. **Smooth** ln(exp) with a cubic in level (least squares), so every level costs more than the last.
5. **Calibrate** the scale by Monte Carlo (200 friends, 4 rounds) until the mix friend's median is 40 h; then run
   400 friends per profile (§3.3).

### 3.2 The new `levels` table [decision; the numbers confirmed: run 5]

| Lv | Today (retail ×1) | **New (×1)** | × | Quest EXP (share) | Target h | Model h (mix) | Cumulative | Today ×3 h |
|---|---|---|---|---|---|---|---|---|
| 1 | 118 | **796** | 6.75 | 398 (50 %) | 0.14 | 0.19 | 0.2 | 0.16 |
| 2 | 470 | **1,400** | 2.98 | 700 | 0.17 | 0.18 | 0.4 | 0.16 |
| 3 | 1,058 | **2,340** | 2.21 | 1,170 | 0.22 | 0.20 | 0.6 | 0.16 |
| 4 | 1,880 | **3,750** | 1.99 | 1,875 | 0.27 | 0.24 | 0.8 | 0.18 |
| 5 | 2,938 | **5,790** | 1.97 | 2,895 | 0.34 | 0.27 | 1.1 | 0.18 |
| 6 | 5,640 | **8,630** | 1.53 | 3,020 (35 %) | 0.43 | 0.46 | 1.5 | 0.21 |
| 7 | 9,048 | **12,500** | 1.38 | 4,375 | 0.54 | 0.52 | 2.1 | 0.26 |
| 8 | 13,160 | **17,500** | 1.33 | 6,125 | 0.68 | 0.67 | 2.7 | 0.30 |
| 9 | 17,978 | **24,000** | 1.33 | 8,400 | 0.85 | 0.78 | 3.5 | 0.35 |
| 10 | 23,500 | **32,300** | 1.37 | 11,305 | 1.07 | 1.02 | 4.5 | 0.39 |
| 11 | 34,898 | **42,800** | 1.23 | 12,840 (30 %) | 1.34 | 1.30 | 5.8 | 0.53 |
| 12 | 47,940 | **55,900** | 1.17 | 16,770 | 1.68 | 1.52 | 7.4 | 0.65 |
| 13 | 62,628 | **72,400** | 1.16 | 21,720 | 2.11 | 1.80 | 9.1 | 0.76 |
| 14 | 78,960 | **93,300** | 1.18 | 27,990 | 2.65 | 2.34 | 11.5 | 1.03 |
| 15 | 96,938 | **120,000** | 1.24 | 36,000 | 3.32 | 3.11 | 14.6 | 1.15 |
| 16 | 127,840 | **155,000** | 1.21 | 38,750 (25 %) | 4.17 | 4.34 | 18.9 | 1.41 |
| 17 | 161,798 | **201,000** | 1.24 | 50,250 | 5.23 | 5.50 | 24.4 | 1.79 |
| 18 | 198,810 | **264,000** | 1.33 | 66,000 | 6.56 | 6.16 | 30.6 | 2.21 |
| 19 | 238,878 | **351,000** | 1.47 | 87,750 | 8.24 | 9.56 | 40.1 | 3.10 |
| **1 → 20** | **1,124,480** | **1,464,406** | 1.30 | **398,333 (27 %)** | 40.0 | 40.1 | | 15.0 |

- **Why the new curve is only 1.3× retail at ×1**: the re-levelled roster and the level rule make the level's own
  monsters the best EXP, so a ×1 hour now earns 27–31k EXP at 11–19, about what today's ×1 earns two levels down
  (BALANCE §3: 26–30k frugal). The length comes from leaving ×3: the live climb is effectively 374,826 EXP; the new
  one is **3.9×** that in EXP and **2.7×** in hours (15 → 40 h).
- **The first levels are longer than retail's** (796 EXP for level 1 is ≈ 11 minutes with the first quests) so the
  tutorial is not over before the player has fought a pack; levels 1–5 still take about an hour.
- **`masterySp` is unchanged** (SKILLS §1.2: 334 SP per mastery to 20); only the `exp` column changes.

### 3.3 Time to 20 by play style [confirmed: Monte Carlo, 400 friends per profile, run 5; `climb-mc.png`, `climb-hours.png`]

| Profile | p10 | **Median** | p90 | Novice / average / good (median) | Deaths on the climb | EXP lost to the penalty | Last 3 levels |
|---|---|---|---|---|---|---|---|
| **Mix** (the design target) | 36.9 h | **39.9 h** | 43.7 h | 41.8 / 40.0 / 37.6 | 3.3 | 76,940 | 21.2 h |
| Solo only | 43.1 | **48.1** | 57.6 | 48.1 / 50.5 / 45.5 | 9.5 | 234,853 | 29.3 h |
| Mostly grouped (80 % from 6) | 34.2 | **36.6** | 40.6 | 40.2 / 36.5 / 34.6 | 1.2 | 24,691 | 18.7 h |
| Mix, always the safest spot | 35.0 | 39.0 | 43.4 | 41.9 / 39.3 / 35.6 | 2.4 | 59,013 | 20.3 h |
| Mix, soaks every night (wave 13) | 32.2 | 34.3 | 36.9 | 36.0 / 34.1 / 32.6 | 2.7 | 62,728 | 17.6 h |
| Mix, no springs and no meals | 45.6 | 50.2 | 54.9 | 51.9 / 50.4 / 46.3 | 4.3 | 102,608 | 27.9 h |
| Mix without the death penalty | | 37.7 | | | | | |
| *Fact-check F7:* mix, the springs' 7.5-min trip charged per soaking session, same curve | 38.5 | **41.6** | 45.7 | 44.0 / 41.4 / 39.5 | 3.2 | 76,496 | 22.2 h |
| *F7:* soaks every night, trip charged | 34.8 | 37.2 | 40.0 | 39.1 / 36.8 / 34.9 | 2.5 | 54,258 | 19.0 h |
| *F7:* solo only, trip charged | 44.8 | 50.2 | 61.0 | | 9.4 | 244,154 | 31.0 h |

- **The springs' trip** *(fact-check F7)* [confirmed: `FIXED=1 pnpm tsx work/tmp/climb/fc-climb.ts`,
  `out-fc-trip-fixed.txt`]: the model's 15 % overhead is town time; HOT_SPRINGS §5.3 charges ≈ 7.5 min per soaking
  session (the walk to log out in the pool and the return scroll). Charged on top, the same curve gives 41.6 h for
  the mix friend and 37.2 h for the nightly soaker (whose real saving over "no wave 13" is then 13 h, not 16 h).
  Re-calibrating with the trip would shrink the curve 3.4 % (1,414,419 EXP; `out-fc-trip-recal.txt`). **The curve is
  kept** [decision: 39.9–41.6 h brackets the user's "about 40", and whether a player walks to the springs only to
  log out, or passes by anyway, is unknown until play].
- **Group play is a little faster per hour, and much safer**: per member, a duo or party earns 0.9–1.2× a solo
  player's EXP per hour below 14 and **1.12–1.34× at 14–18** (1.44× at 19, where the far bank's soloing is hardest)
  [confirmed: run 5, average tier, against the average player's solo mix of half at-level, half best spot; against
  the best solo spot alone it is 1.05–1.24× at 14–18 and 1.39× at 19, `out/climb.json`]. The bigger gap in whole climbs (36.6 vs 48.1 h) is mostly **deaths**: a solo-only
  friend dies 9.5 times and loses 16 % of a climb's EXP to the penalty.
- **The last levels are the hardest**: 17 → 20 is 21.2 of 40 h, 19 → 20 alone 9.6 h (the model's 19 is longer than the
  8.2 h target because its at-level spot, the Ruins, is the deadliest of the climb).
- **Skill is worth about 10 %** in a whole climb (good 37.6 vs novice 41.8 h, mix), and more solo.

### 3.4 Rates [decision]

- **EXP_RATE = SP_RATE = GOLD_RATE = DROP_RATE = 1** on the live server from the wave-14 deploy (one line each in the
  mini PC's `silkroad.local.env`; §9.4). The knobs stay (BALANCE §7) for tests and events, and a GM can still run a
  weekend at ×2.
- **Rates and the new tables are one decision**: the curve is calibrated at ×1; a server at ×3 with the new curve
  would reach 20 in ≈ 16 h [projected: hunting time ÷ 3, quests and town unchanged].

### 3.5 Wave 13 in the totals, and the knobs it hands this wave [confirmed: the model; decision on the knobs]

| Wave-13 source | In the model | Effect on the mix climb | Knob decision |
|---|---|---|---|
| Hot springs Rested (HOT_SPRINGS §5) | A full pool (20 % of the level) at the start of half the 1.5-h sessions, +50 % of kill EXP until drained | 13.1 % of the climb's EXP; a nightly soaker 22 % | **Keep `capFrac` 0.2 and `bonusMul` 0.5** for every level: the curve is calibrated with them; the nightly soaker's 34 h is the reward for a social habit |
| Dishes (FISHING §7.2) | +5 % kill EXP half the hunting time, +10 % 15 % of it | ≈ 4 % | **Keep** |
| Fishing | No character EXP (FISHING D13) | 0 | Keep: fishing time is extra play, outside the 40 h |
| `restEligible`, `mealEligible` | — | — | **The siblings decide their own kills** *(fact-check F8)*: NEMESIS §5.1 makes nemesis kills **eligible** and STORM_QILIN §6.1 makes the Qilin **not eligible**; this spec follows both (the Rested pool is a fixed daily budget, so eligibility moves when it is spent, not how much). **Include** mini-bosses, the Tomb and Tiger Girl |
| The curve change | — | — | The Rested pool is clamped to the new cap at login (HOT_SPRINGS §5.1), so the migration needs nothing more |

- **The Tomb's EXP budget for TOMB_DUNGEON** [decision, a budget the sibling may tune]: trash pays **0.75 × the
  standard EXP** of its level; a full run's EXP per member per hour ≈ **1.15× an average solo hour** at the same
  level (the model: duo 31.1k vs solo 27.4k at 15) [confirmed: `design.ts` `tombMob`, run 5]; the bosses' EXP on top
  is the Tomb doc's, and its reward is the loot (§4.4), not speed.
- **Nemesis and Qilin EXP** are their docs'; this spec asks only that a single kill pay a member at most **≈ 10 % of
  the level-19 bar in the intended group size** (so neither becomes the way to level) [decision]. *(fact-check F8)*
  NEMESIS pays 1.1–1.4× grinding the same kind (well inside). STORM_QILIN's pool is a quarter of the L19 bar
  (87,750): ≈ 28,500 each in a party of 4 (8 % of the L19 bar, inside) but ≈ 48,000 each in a duo (14 %) [projected:
  `partyPool` × level shares on STORM_QILIN §6.1's numbers]. Default: STORM_QILIN's pool stands (the Qilin is rare,
  a duo of level 20s barely wins it, and the climb-wide effect is ≈ 2 h by its own estimate); WAVE_PLAN10 re-runs
  `climb.ts` with it.

---

## 4. Gear tiers, drops and gold (c)

### 4.1 Tiers [decision; items confirmed: `work/tmp/climb/tiers.ts` over `items.json` and `shops.json`]

Prices are the heavy set (blade + 6 armour pieces + 3 accessories) at the shop price.

| Tier | Levels | Degree / grade | Required levels | Source | Weapon (blade, phys. attack) | Set price |
|---|---|---|---|---|---|---|
| **T1 Copper** | 1–4 | 1 / A (B from 3) | 1; 3–8 | A: shop. B: drops in B1, quests JG_005, JG_007 | Copper Blade 16.5–18.5; Short Copper 21–24 | 4,490; 11,780 |
| **T2 Long Copper** | 5–7 | 1 / C | 5–10 | drops in B1/B2, MB1, quests | Long Copper Blade 26–30 | 14,850 |
| **T3 Infantry / Bronze** | 8–11 | 2 / A, B | 8–13; 10–15 | A: shop. B: drops B2/B3, MB2, quests JG_014, JG_016 | Infantry 35–39.5; Lancer 41–47 | 23,000; 33,750 |
| **T4 Cavalry** | 12–15 | 2 / C | 13–18 | drops B3/B4, elite camps, MB3, quest JG_019 | Cavalry Hand Blade 50.5–58.5 | 66,750 |
| **T5 Tribal Iron / Scale** | 16–17 | 3 / A | 16–21 (chest 21) | shop; drops B5, MB4, quest JG_022 | Mhong tribe Cutting Blade 62–71.5 | 120,250 |
| **T6 Kang Iron** | 18–20 | 3 / B | 18–23 (wearable pieces ≤ 20) | drops B5/B7, the Tomb, MB5, MB7, quest JG_025 | Kang tribe Cutting Blade 70–81 | 172,500 |
| **T7 Seal of Star** | 16–20, the post-cap hunt | 3 / A, B `_RARE` | 16–21 (126 of 144 wearable at ≤ 20) | Tiger Girl 20 %, the Tomb's last boss, MB4–MB7 3–5 %, elite camps 0.5 % | Cutting Blade (SoS) 83.5–96 (A), **108.5–125 (B)** | n/a (not sold) |

- **Shops sell grade A only** (today's rule, kept): the shop is the floor of each tier and B/C are the reason to hunt
  [confirmed: shops sell 10/10 of each grade-A set, 0 of B/C].
- **Degree 3 arrives piece by piece** *(fact-check F10)* [confirmed: `items.json`, the seven armour codes HA, CA, SA,
  BA, LA, AA, FA per class]: 03_A's pieces need 16 (AA), 17 (SA), 18 (FA), 19 (HA, CA), 20 (LA) and 21 (BA, never at
  this cap), so T5 is one or two new pieces a level from 16 to 20; **03_B has only 3 pieces wearable at ≤ 20** (AA 18,
  SA 19, FA 20; HA/CA 21, LA 22, BA 23). T6 is therefore the 03_B weapon, shield and accessories plus 3 armour
  pieces over a 03_A base, and its "set price" counts pieces nobody here can wear. The model already equips by
  piece (`gearAt` takes the best row with `reqLevel` ≤ the level), so §2–§3 stand.
- **+N by alchemy** (wave 8) stacks on any tier; elixirs come from the mini-bosses, elite camps, the Tomb and Tiger Girl.
- **The tiers hit the curve**: a player in tier gear is the model's player (`lib.ts` `gearAt` picks the best row
  whose required level is ≤ the character's), so every number of §2–§3 assumes the tier is owned on time.

### 4.2 Set bonuses (cheap) [decision]

One mod provider (the refreshment slot's pattern, FISHING §7.3: a provider of stat mods, no new stat channel):

| Set | Pieces | Bonus |
|---|---|---|
| A **family** (the same degree, any grade and armour class: e.g. every `ITEM_CH_*_03_*`) | 4 | +3 % max HP |
| | 6 | +5 % max HP, +3 % physical and magical defence |
| **Seal of Star** (any `_RARE` items) | 3 | +5 % damage |
| | 5 | +8 % damage, +5 % max HP |

- **A family is a degree, not a degree and grade** *(fact-check F10)* [decision: with grades apart, the 03_B family
  could never reach 4 pieces at this cap, and mixing a hunted B piece into a shop A set should not break the bonus].
  The tooltip names the degree ("Iron set (4/6)"). `content/climb/sets.json` holds the rules.
- Size: smaller than one tier step (§4.1), bigger than a dish (FISHING D19), so a complete set feels like a goal and
  never like a requirement.

### 4.3 Named empty slots for waves 15 and 17 [decision: the names, tiers, sources and stat budgets; the art is theirs]

| Slot | Wave | What | Tier / level | Source | Stat budget |
|---|---|---|---|---|---|
| **W15-A** Tomb Warden's set | 15 Wardrobe | heavy, light and clothes sets (6 pieces) | T6–T7 / 18–20 | the Qin-Shi Tomb only (TOMB_DUNGEON's set slot) | = Seal of Star B per piece, with the SoS set bonus |
| **W15-B** Tiger-Hunter's set | 15 | the three classes | T5 / 16 | Tiger Mountains drops, MB5, Tiger Girl | = 03_A per piece + the family bonus |
| **W15-C** Ferryman's coat and hat | 15 | civilian clothes (no stats) | any | the ferry quest JG_X07, then the far bank's vendor | cosmetic |
| **W15-D** Millet Farmer's clothes | 15 | civilian clothes | any | B1 quest reward | cosmetic |
| **W17-A** Qilin-touched weapons | 17 Arsenal | the five weapon families, a lightning rarity effect | T7 / 20 | crafted from STORM_QILIN's materials | = SoS B + 5 % |
| **W17-B** Tiger Girl's Fang | 17 | the talking legendary weapon | T7+ / 20 | a long quest begun by a Tiger Girl drop (a "Tiger Fang Shard", 5 %) | = SoS B + 10 %, its own skill |
| **W17-C** The Robber Chief's Hook | 17 | a glaive with a rarity effect | T4 / 14 | MB3 1 % | = 02_C + 15 % |

Until the waves land, every slot is an `items.json`-style row in `content/climb/slots.json` with `enabled: false`, so
drop tables can name them now and nothing drops [decision].

### 4.4 Drops per band [decision; the numbers are content]

| Source | Equipment | Other |
|---|---|---|
| A normal kill | **2.0 %** one item of the band's tiers (grade weights: the shop grade 50 %, the higher 50 %), champions ×2 | potions as retail; gold (§4.6) |
| An elite camp leader | **30 %** one tier item (+0–1) | elixir 5 %, Seal of Star 0.5 % |
| A band mini-boss | **100 %** one tier item (+0–2) | Incense 25 %, elixir 20 %, Lucky Powder 20 %, Seal of Star 3 % (MB4) to 5 % (MB7) |
| Tiger Girl | unchanged (UNIQUES §3.4: 3 degree-3 items ≤ cap, +0–3; 20 % Seal of Star) | + Tiger Fang Shard 5 % (W17-B) |
| The Tomb | TOMB_DUNGEON owns it; budget: the last boss 25 % Seal of Star, **1 Incense in the personal chest** (TOMB_DUNGEON §3.4's 20 h chest lockout, so re-running the trash never farms it: *fact-check*), T6 items, W15-A | — |

`DROP_RATE` 1 then gives ≈ 1 tier item per 50 kills: ≈ 45–60 band drops over a 40 h climb [projected: the mix
friend's base kill EXP is ≈ 0.90 M (the MC's earned EXP minus quests, Rested and meals), at ≈ 300–400 EXP a kill
≈ 2,300–3,000 kills], plus ≈ 15 from mini-bosses and camps.

### 4.5 Gold [confirmed: the model, `climb-gold.png`; decision on the levers]

- **Monster gold** = the standard gold of the level (retail's 0.7 × [24.5 + 3.5 L, 51.5 + 7.4 L]) × the band factor:
  B1 1.0, B2 1.15, B3 1.25, B4 1.8, B5 2.4, B6 2.5, B7 2.6 [decision].
- **Solo, average, typical policy** (per hour): income 7–21k, potions 2–38k; **net −2k to +9k/h at 1–16 (negative at
  8, break-even at 12: the first healers and archers), −5k to −20k/h at 17–19** (Large potions at 400 gold, ≈ 1.4 HP
  + 1 MP per pull). Over the climb the solo average player ends ≈ −105k from hunting alone [confirmed: run 5 §6,
  `out-run5.txt` gold table; *fact-check F11*: the draft said +1k to +9k at 1–16].
- **What that leaves for gear** [projected: arithmetic]: hunting −105k + the doubled quest gold 219,700 ≈ +115k over
  the climb, against 147,740 for the three grade-A shop sets (T1 4,490 + T3 23,000 + T5 120,250). A solo-only player
  cannot buy every shop set and must wear drops (≈ 45–60, §4.4) for part of the climb; a grouping player drinks
  about half the potions. That is intended ("difficult"), and the soak (§17.3) checks that nobody is stuck in T3 gear
  at 17.
- **Who pays the late potion bill** [decision]: the **questline's gold ×2 at 11–19** (116,200 → 219,700 in total),
  the mini-bosses (one tier item each, sold or worn), the Tomb, Tiger Girl, and grouping (a party drinks less per
  member: ≈ 0.5 of the solo potion bill at 17–19 [likely: the party's deaths and pulls in the model]). Today's ×3 gold
  is what made potions free; at ×1 they are a real cost again, which is part of "difficult".
- **Prices unchanged**: potions, shop gear, repairs (BALANCE §5; the Large potion is the right price for the danger).

---

## 5. Skill Arts and SP pacing (d)

### 5.1 Arts [decision]

At mastery 10, 15 and 20 of each **weapon** mastery (Bicheon, Heuksal, Pacheon) and of **any force** mastery, the
skill window offers a choice of **two Arts**. One per tier is active; a respec at the skill trainer costs 10,000 gold
× the tier. Arts are **number changes on existing rows** read by the skill engine at cast time: no new skill row, no
new clip, no new effect (the existing effect plays).

| Tree | Tier (mastery, SP) | Art A | Art B |
|---|---|---|---|
| **Bicheon** (sword, blade) | 10 (60 SP) | **Heavy Smash**: Strike Smash +25 % damage, cooldown +1 s | **Swift Smash**: Strike Smash cooldown −1 s, −10 % damage |
| | 15 (150) | **Long Reach**: Soul Cut Blade range 12 → 16 m, +10 % damage (catches runners) | **Chain Momentum**: Illusion Chain's 3rd segment +50 % |
| | 20 (300) | **Executioner**: +30 % damage to targets under 30 % HP | **Flowing Steel**: basic attack 10 % faster |
| **Heuksal** (spear, glaive) | 10 | **Wide Bite**: Wolf Bite Spear pierces 3 | **Deep Bite**: Wolf Bite Spear +20 % damage |
| | 15 | **Demon's Reach**: Dancing Demon Spear hits 4 | **Iron Lung**: Cheolsam Force +5 % max HP more |
| | 20 | **Thunder Stun**: Soul Spear – Move stun +1 s | **Petal Storm**: Ghost Spear – Petal radius 2 → 3 m |
| **Pacheon** (bow) | 10 | **Steady Aim**: Anti Devil Bow – Missile +15 % critical | **Quick Draw**: 2 Arrow Combo cooldown −1.5 s |
| | 15 | **Flame Pierce**: Autumn Wind – Flame pierces 4 | **Hawk's Eye**: White Hawk Summon also +2 m range |
| | 20 | **Pinning Shot**: a bow hit ends a monster's flight (as a stun does) | **Demon Soul**: Demon Soul Arrow +10 % damage |
| **Force** (any force mastery) | 10 | **Deep Imbue**: the imbue's status chance ×1.5 | **Lean Imbue**: the imbue costs 25 % less MP |
| | 15 | **Mender**: Heal – Medical Hand +20 % | **Ward**: Weak Guard of Ice and Basic Fire protection +3 % defence |
| | 20 | **Rebirth**: Soul Rebirth Art refunds **all** of a friend's death-penalty loss (§6.3) | **Second Wind**: Self Breathe Heal cooldown −50 % |

- **Why choices, not ranks**: retail's B-tier rows start at mastery 27 (SKILLS §1.3) and are not exported (our
  `skills.json` stops at mastery 20 [confirmed: max `masteryLevel` 20]); exporting and re-gating them would be a
  converter change and new balance for every line. Arts reuse what exists and give the cap's player decisions
  [decision].
- **The roles meet the Arts**: runners (Long Reach, Pinning Shot, Thunder Stun), healers (Thunder Stun, Executioner),
  packs (Wide Bite, Demon's Reach, Petal Storm), the penalty (Rebirth).
- **Every named skill exists at mastery ≤ 20** [confirmed: `skills.json`: Strike Smash m5, Soul Cut Blade m14 (range
  12), Illusion Chain m7, Wolf Bite Spear m5, Dancing Demon Spear m10, Cheolsam Force m10, Soul Spear – Move m14,
  Ghost Spear – Petal m19, Anti Devil Bow – Missile m5, 2 Arrow Combo m7, Autumn Wind – Flame m14, White Hawk Summon
  m10, Demon Soul Arrow m19, Blood Blade Force m19, Heal – Medical Hand m12 (FORCE), Self Breathe Heal m5 (FORCE),
  Soul Rebirth Art m17 (FORCE)]. Two notes *(fact-check)*: **Ward** names Weak Guard of Ice (COLD m8) and Basic Fire
  protection (FIRE m17), so it only helps a player who also trains those; **Executioner** and **Pinning Shot** are
  conditions (target HP under 30 %; the coward's flight state), not plain row numbers: two small branches in the Art
  lookup (CL-A).

### 5.2 SP pacing [confirmed: `climb.ts` §7]

- **SP-EXP stays equal to kill EXP** (no `spExp` on the derived rows) [decision]. On the new curve that is **167 SP at
  10, 833 at 15 and 3,329 at 20** from kill and quest EXP alone (today's table: 118 / 676 / 2,530).
- **What a friend really has at 20 is a little more** *(fact-check F11)* [projected: arithmetic on the run-5 MC]: the
  Rested bonus pays SP-EXP too (WAVE_PLAN9 D6: `sp = s + rest_sp(s)`, meals are EXP only), and EXP the penalty takes
  is re-earned with fresh SP-EXP (the penalty takes EXP, never SP). The mix friend earns ≈ 1.54 M EXP in all (the
  curve + 76,940 lost), 26 % from quests, 13 % Rested, ≈ 2 % meals: ≈ 2,765 SP from kills and Rested + 664 from
  quests ≈ **3,430 SP**; a solo-only friend (234,853 lost) ≈ 3,800.
- **Demand at 20**: the P0 build 1,930 (BALANCE §4) + one weapon tree's Arts 510 + the force tree's 510 = **2,950**,
  leaving ≈ 380–480 (≈ 850 for a friend who died a lot) for a third line's first levels: SP is a choice again at the
  cap, not a surplus [projected].
- **The early game is not starved**: Strike Smash still arrives at 5–6 (9 SP), the first Art at 10 with 167 SP owned.
- `progression.ts` `TYPICAL_SP_BY_LEVEL` (GM setlevel's grant) is re-generated from the new curve (§10.3).

---

## 6. The death penalty (e) — rule #13

### 6.1 The rule [the user's rule; the defaults the brief records; decisions where marked]

| Part | Rule |
|---|---|
| **Who** | A player of **level 15–19**. At level 20 there is no bar to take from (EXP is not kept at the cap); nothing is taken [decision] |
| **What kills** | A **monster or boss**: field monsters, champions, giants, elites, mini-bosses, uniques, **nemeses**, the **storm Qilin**, the Tomb's monsters and bosses; damage over time from a monster counts as the monster's |
| **What never counts** | Duels and the arena (none exist yet; the rule names them so they never will), a GM kill (`gmKill`), a death inside a sanctuary (the springs; none possible today), a server-side rescue |
| **How much** | `pct` = a random whole number **1–20** (server RNG); `loss = min(exp, floor(pct / 100 × expToNext(level)))`: **never below the bar's start, never a de-level** |
| **When** | On death (not on "return to town"), so a resurrection can refund it (§6.3) |
| **Grace** | **A death within 10 minutes of a penalised death costs nothing** [decision: §6.4]. A death the Incense saved also starts the grace, so a chain of deaths burns one Incense, not a stack *(fact-check)*. A grace death never restarts the window (one penalty per 10 min at most) |
| **Protection** | An **Ancestor's Incense** in the bag burns instead (§6.2) |
| **Combat logout** | **A player who leaves the world (closed tab, lost socket, `leaveWorld`) within 10 s of taking monster damage stays in the world for 10 s more**, still targetable; dying then is a death like any other *(fact-check F6)* [decision]. Reason: `connection.ts` `leaveWorld` removes the character at once [confirmed: read], so without it closing the tab at 5 % HP dodges the penalty. The linger is skipped below level 15 (nothing to dodge) |
| **Message** | Centre banner and a system chat line: **"You have died. You lost 13 % of your experience (15,600 EXP)."**; the EXP bar flashes the lost segment red for 3 s. With Incense: **"The Ancestor's Incense burns away. Your experience is safe."** In grace: **"Your ancestors spare you this time (no experience lost)."** Below 15: no line [decision] |
| **Party view** | Party members see "Mei lost 13 % of her experience." in party chat (it is information friends want) [decision] |

### 6.2 The protective consumable: Ancestor's Incense [decision]

- **Yes, one exists**, because a rule that only takes is the kind friends quit over, and the model shows spirals
  (§6.4).
- **Never sold.** Sources: the penalty's intro quest JG_X01 at 15 (2), the mini-bosses (25 %), the Tomb (1 per full
  run), the dailies JG_R03 / JG_R04 at 15+ (10 %), and **5 Tomb Seal Shards** (FISHING's curio from the tomb moat)
  traded to Miaoryeong. **At most 5 owned per character (bag and storage together), bound**: no trade, stall or drop
  *(fact-check: "a stack of 5" alone allowed one stack per bag slot and a capped friend feeding the climbers)*. Extra
  Incense from a drop is not picked up ("You can carry no more incense."). The Tomb's Incense comes from its personal
  chest (20 h lockout, §4.4). The 5 Tomb Seal Shards compete with TOMB_DUNGEON's Treasure Vault (5 shards make a Tomb
  Seal, TOMB_DUNGEON §3.2): the player chooses, which is fine [decision].
- **Automatic**: burns on a penalised death (not in grace), one per death.
- **Data**: an authored item row (wave 13's FS-I authored-items mechanism), a retail incense or talisman icon
  [unknown: which icon; default the closest retail scroll icon].

### 6.3 Resurrection refunds [decision]

- A friend's **Soul Rebirth Art** (Force/Water mastery 17, `resurrect` rows, already in the skill engine
  [confirmed: `skills/engine.ts` `resurrect`]) on the corpse **before** it returns to town refunds **50 %** of the
  loss; with the **Rebirth** Art (§5.1), **100 %**. The refund is stored on the player until the return or the
  resurrection (`Player.penaltyLoss`, not persisted: a relog while dead forfeits the refund).
- **Refunds of one death never add up to more than its loss** *(fact-check F5)* [decision]: NEMESIS refunds half of
  the `exp_lost` it recorded from the death's `cause.expLost` (NEMESIS §2.5, §5); with the Rebirth Art's 100 % that
  paid 150 %. So a
  resurrection refund emits **`penaltyRefunded {player, amount}`**, NEMESIS subtracts it from that death's
  `exp_lost`, and the penalty module keeps a per-death "refunded" sum that caps every later refund at the loss.
- This is why groups, and healers in them, matter at 15–20.

### 6.4 What the model says [confirmed: runs 2–5]

- **Without the grace, novices spiral.** At the level's own spots of 15–20 a novice dies 3–5 times an hour (run 2) and
  each death takes 10.5 % of a bar on average: a novice who keeps fighting there loses EXP faster than they earn it
  (the run-2 novice median was 983 h). Two things stop it: **adaptive play** (the bots leave a spot that kills them
  more than once an hour, as people do) and the **10-minute grace**; with both, the mix friend's novice reaches 20 in
  41.8 h [confirmed: run 5].
- **Its cost**: the mix friend dies **3.3 times** on the whole climb and loses **76,940 EXP**, **2.2 h** (39.9 vs
  37.7 h without the penalty); a solo-only friend dies 9.5 times and loses 234,853 EXP (16 % of the climb's).
- **What it feels like**: one death costs on average 10.5 % of a bar, at 19 about **37,000 EXP ≈ 1 h 15 min** of
  hunting; the worst roll (20 %, 70,200 EXP) **≈ 2 h 20 min** *(fact-check F11: the draft said "about 2 h")*. That is
  a real sting and never a disaster, which is the user's intent [projected: 351,000 × 0.105 and × 0.20; the mix
  friend's 30,376 EXP/h at 19, run 5].
- **A property of "never a de-level"**: right after a level-up the bar is nearly empty, so a death then costs almost
  nothing; players may learn to try a boss just after levelling. That is acceptable (it rewards planning, and the
  grace already bounds repeated deaths) [decision: no extra rule].
- **Interactions**: a nemesis kill counts (NEMESIS's "revenge becomes personal"; that doc may offer a refund on
  avenging, a hook below); the Qilin counts; the Tomb counts (TOMB_DUNGEON decides wipes and lockouts).

### 6.5 Hooks for the siblings [decision]

- `penalty.apply(p, killer, now)` returns `{ pct, loss, protectedBy: 'incense' | 'grace' | null }` and emits
  `penaltyTaken {player, loss, killer}` on the module bus: **NEMESIS** may listen (e.g. "avenge your death: half the
  loss back when you kill the nemesis that took it"); **TOMB_DUNGEON** may listen (wipe counters).
- `penaltyEligible(killer)` is one predicate (monster or boss; not a player, not a GM).
- `penaltyRefunded {player, amount}` on a resurrection refund (§6.3), so the siblings' refunds stay within the loss.
- NEMESIS already uses this seam: it refunds half of the recorded loss on avenging and records 0 for grace deaths
  (NEMESIS §2.5, A7) [confirmed: NEMESIS.md].

---

## 7. At the cap (f)

### 7.1 Goals [decision]

| Goal | What | Cost to build |
|---|---|---|
| **Gear hunts** | T7 Seal of Star (126 wearable rows), the set bonuses, +N alchemy, the W15/W17 slots as those waves land | drops (§4.4), sets (§4.2) |
| **Bosses on a rotation** | Tiger Girl (3–6 h), six mini-bosses (20–75 min), the Tomb (TOMB_DUNGEON's lockout), the Qilin in storms, nemeses | existing modules + this wave's siblings |
| **The Art tier 20** | each tree's last choice, the respec | §5 |
| **SP into more lines** | ≈ 380–480 spare at 20 (§5.2), and at the cap every kill's EXP becomes SP-EXP (today's rule): about 75 SP an hour of hunting at 20 [projected: 30k EXP/h ÷ 400] | none |
| **Mentoring** | **A capped member's level weight in the EXP split is 0**, so a level-20 friend no longer takes the biggest share of a lower friend's EXP; **but the party's EXP from a kill is the pool × the uncapped members' share of the kill's damage, at least 25 %** *(fact-check F1)*; the capped member's SP-EXP share is computed with today's weights on the SP pool, separately (weight 0 would have given it nothing); the 20 earns "mentor" kill credit for a title | `party.ts` `killShares` (the damage map is already there) and the `levelShares` call [confirmed: the split is by level weight today, `party.ts` 100–109, 500–506] |

**Why the damage share** *(fact-check F1)* [confirmed: `pnpm tsx work/tmp/climb/fc-powerlevel.ts`, a level-20 good
player soloing every non-group spot, the carried friend's level rule applied, 2 h sessions, blade and glaive]:

| Carried friend's level | Best carry spot | Weight-0 rule: carried EXP/h | × the friend's own best solo | Today's weights | Damage share, floor 25 % |
|---|---|---|---|---|---|
| 1 | cubs (12–13) | 48,741 | **4.36×** | 0.21× | 1.09× |
| 5 | robbers (11–12) | 49,482 | **2.25×** | 0.45× | 0.56× |
| 8 | robbers | 49,773 | 1.81× | 0.52× | 0.45× |
| 12 | cubs | 41,507 | 1.40× | 0.52× | 0.35× |
| 15 | tigers | 37,469 | 1.37× | 0.59× | 0.34× |
| 17 | big cats | 34,776 | 1.19× | 0.55× | 0.30× |
| 19 | bugs | 29,667 | 1.13× | 0.55× | 0.28× |

With weight 0 alone, a capped friend who kills while a newcomer stands 60 m away would take that newcomer from 1 to
15 in about a third of the solo time, which empties "level 20 should be difficult to reach". With the damage share, a
pure carry pays less than hunting, while a friend who fights with the mentor keeps nearly all of their own damage's
EXP (a mentor tanking and the friend killing pays the friend ≈ 100 %) [decision].
| **Titles and achievements** | §7.3 | one module, one migration |
| **Fishing, the springs, the sea** | wave 13's pastimes and the legendary carp | exists |

### 7.2 Level-20 dailies [decision]

- **"The Bounty Board"** at Sonhyeon: one random band mini-boss a day (MB3–MB7), and one elite camp: gold, an elixir
  chance, Incense 10 %.
- The existing dailies keep their level windows (JG_R03 11–20, JG_R04 14–20) [confirmed: QUESTS §3.3].

### 7.3 Achievements and titles (the hook) [decision]

- **A small server module `achievements.ts`**: data in `content/climb/achievements.json` (`id`, name, title text or
  none, a condition: `killCount {mobs, n}`, `reachLevel`, `questDone`, `event {name, n}`), a persisted table
  `char_achievements (char_id, id, progress, done_at)` and a `title` column on `characters` (the chosen title).
- **The title is shown under the name** (`EntityState.title`, optional, additive) and in the character window.
- **Events from other modules**: `mobDied` (kill counts), `levelUp`, `questDone`, and the module bus events
  `penaltyTaken`, `fishCaught` (FISHING), `nemesisSlain` (NEMESIS), `qilinCaught` (STORM_QILIN).
- **The first 20** (data): "Pioneer" (a pre-Climb character, §9), "Climber" (reach 20), "Deathless" (15 → 20 with no
  penalised death), six "…-Breaker" titles (each mini-boss, 10 kills), "Tigerbane" (Tiger Girl), "Tomb-Sealer"
  (TOMB_DUNGEON), "Stormchaser" (STORM_QILIN's own name for it, §6.4 there; the draft here said "Storm-Rider"),
  "Avenger" (NEMESIS), "Mentor" (500 mentored kills), "Dragon Gate" (FISHING's legendary).
- **One title seam for the wave** *(fact-check)*: STORM_QILIN §6.4 builds no title system and uses this one;
  TOMB_DUNGEON's first-kill titles (`tomb_progress.titles`) belong in `char_achievements` (a WAVE_PLAN10 merge);
  NEMESIS §2.5 names a "`char_titles` table", which is this `char_achievements`.

---

## 8. The questline (g) [decision]

### 8.1 What changes in `content/quests/jangan.json`

- **Order and story unchanged** ("The Tiger's Shadow", JG_001 → JG_026, QUESTS §3).
- **EXP** = the quest's share of its level × the new curve: every quest keeps its fraction of its level's quest EXP,
  and the level's total becomes 50 % (1–5), 35 % (6–10), 30 % (11–15), 25 % (16–19) of the new `levels` row:
  **398,333 EXP in all (27 % of the climb)** [confirmed: §3.2]. A script rewrites the numbers (§17, CL-Q).
- **SP** = `max(1, round(exp / 600))` (QUESTS §3.4's rule, kept).
- **Gold** ×2 at 11–19 (§4.5).
- **Monsters**: objectives name the retail codes; the quest engine accepts a kill of the **derived** code by its
  `base` (one lookup) [decision: no rewrite of 35 objective lists, and a nest's remapped monster still counts]. The
  hunted kinds move by one or two levels (Young Tiger 13 → 12, Black Tiger 17 → 16, White Tiger 18 → 17, Chakji
  Worker 19 → 17), inside QUESTS' "≤ 3 levels above" rule [confirmed: the kill objectives of `jangan.json` vs §2.2;
  *fact-check F4*: the draft said "at most one"], **except where a quest's hint points into a re-banded area**:
- **JG_013 "Grave Matters" (level 9)** asks for 10 Tomb Stone Ghosts and 8 Broken Stone Ghosts with the hint
  `LOC_QIN_GATE` [confirmed: `jangan.json`]. The Qin-Shi gate becomes B4: its Broken Stone Ghosts are Grave Stone
  Ghosts 12 and its Tomb Stone Ghosts Tomb Keepers 14 / Restless Tomb Stones 15, aggressive and linked: 3–6 levels
  above a level-9 player, outside QUESTS' rule. **Fix** [decision]: JG_013's two hints move to the Chinese Tomb (B2's
  Tomb Stone Ghost 8 and the Broken Stone Ghost 8 nests of §2.2 rule 3), and its text says "the old graves" instead
  of "the Qin-Shi gate"; the Qin-Shi gate's story moves to JG_X12 at 13. The base-code match still lets a strong
  player finish it at the gate. CL-Q's test: every kill objective's hint area has a derived row of that base within
  the quest level + 3.
- **JG_024** (Chakji Iron Shards, level 19) needs Chakji Workers: the 13 Jangan Ferry nests on the town side stay, so
  it works before the ferry opens [confirmed: 70 Chakji Workers live there today].

### 8.2 New quests (13 + TOMB_DUNGEON's JG_T01) [decision: names and placement; the text is the content lane's]

| Id | Lv | Band | Title | Gist |
|---|---|---|---|---|
| JG_X10 | 6 | B1 | Old Scar | Bounty: kill the Weasel King (MB1) |
| JG_X11 | 10 | B2 | The Magistrate's Court | Bounty: the Drowned Magistrate (MB2) |
| JG_X12 | 13 | B4 | Lanterns at the Graves | Reach the Tomb Approach; kill 10 Grave Stone Ghosts; collect 6 Keeper's Ash |
| JG_X13 | 14 | B4 | The Keepers' Song | Collect 8 Keeper's Prayer Slips (50 % from Tomb Keepers; the text teaches "kill the healer first") |
| JG_X14 | 14 | B3 | Gwangmu's Last Raid | Bounty: the Robber Chief (MB3) |
| JG_X01 | 15 | — | The Ancestors Watch | Miaoryeong explains the penalty; gives 2 Ancestor's Incense |
| JG_X15 | 15 | B4 | (TOMB_DUNGEON's **JG_T01** "The Emperor's Door") | The Tomb's attunement quest, after JG_020; no key per run (TOMB_DUNGEON §3.2, D8). Counted here for pacing only; its text and rewards are TOMB_DUNGEON's |
| JG_X16 | 16 | B4 | The Warden Falls | Bounty: the Gate Warden (MB4) |
| JG_X07 | 17 | B7 | The Ferryman's Fee | Doji's errand; makes the crossing free (§2.7); the W15-C coat |
| JG_X17 | 17 | B7 | Chakji on the Far Bank | Kill 15 Chakji Workers (the text teaches "stun the runner") |

*(fact-check)* The draft's X13 ("killed under 30 % of the fight time") and X17 ("without letting 3 escape") needed
new objective types (a timed kill, a fail counter) that no lane builds; both now use the existing `collect` and
`kill` types [decision: the lesson lives in the text and the monsters' roles].
| JG_X18 | 18 | B5 | The Black Wind | Bounty: Heukpung (MB5) |
| JG_X19 | 18 | B7 | Bugs in the Granary | Kill 20 Ghost or Devil Bugs |
| JG_X20 | 19 | B7 | Hyungno Ashes | Collect 8 Shaman's Bells (Hyungno Shaman) |
| JG_X21 | 20 | B7 | Mo-Dun's War Camp | Bounty: Mo-Dun (MB7); repeatable weekly at 20 |

The new quests take their EXP from the same per-level shares (they are part of the 27 %, not on top) [decision].

### 8.3 Pacing across the bands [projected: the model's per-level hours]

| Band | Levels | Quests (old + new) | Real hours (mix) | Quest share of EXP |
|---|---|---|---|---|
| B1 | 1–5 | JG_001–008, S05, X10 | ≈ 1.1 | 50 % |
| B2 | 5–10 | JG_009–015, S01, S02, X11 | ≈ 3.4 | 35 % |
| B3/B4 | 10–15 | JG_016–020, S03, S04, X12–X16, X01 | ≈ 10.1 | 30 % |
| B5/B6/B7 | 15–20 | JG_021–026, X07, X17–X21, the Tomb's | ≈ 25.5 | 25 % |

---

## 9. Migration of live characters (h) [decision]

### 9.1 What is kept

Level, **the bar's fraction**, SP and SP-EXP, learned masteries and skills, stat points, items, gold, quests done and
in progress, the Rested pool (clamped at login, HOT_SPRINGS §5.1), mounts, guild, everything else. **Nothing is lost.**

### 9.2 The conversion

- On the first login after the deploy (`characters.curve_version` 0 → 1): `exp_new = floor(exp_old / oldNeed(L) ×
  newNeed(L))`, kept below `newNeed(L)`. At the cap, nothing.
- **A quest done under the old numbers stays done** (its old EXP is already in the level); an **in-progress** quest
  pays the new numbers when turned in [decision: the simplest honest rule; the difference is a few thousand EXP].
- Characters at **15+** receive **2 Ancestor's Incense** by system mail or in the bag (the bag if mail does not exist
  yet [confirmed: `apps/server/src/social/` holds guilds, stalls and trade, no mail]).
- Every pre-Climb character gets the title **"Pioneer"** (§7.3).
- The far bank opens; a character saved there cannot exist yet (it was unreachable) [confirmed: no live nest there].

### 9.3 The live accounts

- The three live accounts' levels are [unknown] here (the live database is on the mini PC; the dev `game.db` is not
  it). Whatever they are, the rule above keeps them; a level-20 character is unaffected except for the penalty-free
  cap, the Arts it can now buy, and mentoring.
- A **database backup** precedes the deploy (one migration; WAVE_PLAN9's rule) [decision].

### 9.4 The rates at deploy

The mini PC's `~/silkroad/silkroad.local.env` changes `EXP_RATE`, `SP_RATE`, `GOLD_RATE` to 1 and `DROP_RATE` to 1
(DEPLOY.md "Game rates"); a deploy never touches that file, so this is a manual step in the deploy checklist with the
user's OK [confirmed: DEPLOY.md line 172].

---

## 10. Formats and server

### 10.1 One migration [decision; the number is WAVE_PLAN10's]

The database is at schema 10; wave 13 takes 11–13 (WAVE_PLAN9 D5) [confirmed: `db.ts`, WAVE_PLAN9]. This spec adds
**one**: `characters.curve_version INTEGER NOT NULL DEFAULT 0`, `characters.title TEXT`, `characters.arts TEXT`
(JSON of the chosen Art per tree and tier), and the `char_achievements` table. The penalty state is runtime only.

### 10.2 Content (new, `content/climb/`) [decision]

| File | Holds | Read by |
|---|---|---|
| `levels.json` | the 20-row `exp` table (§3.2); `masterySp` copied from retail | server (`GameData.expToNext`), client (skill window) |
| `roster.json` | the derived monsters (§2.2): code, base, name, level, roles, hp/atk/exp/gold multipliers, call count | server and client (one shared pure function, §10.3) |
| `bands.json` | bands, per-area remaps (retail → derived), band attack and gold factors, the far bank's landing points, the elite camps | server |
| `roles.json` | link radius and size, flee share and time, heal size and period, call join delay | server |
| `arts.json` | the 24 Arts: tree, tier, cost, mods | server and client |
| `sets.json` | the set rules (§4.2) | server and client (tooltips) |
| `slots.json` | the W15/W17 slots, `enabled: false` | server |
| `achievements.json` | §7.3 | server and client |
| `penalty.json` | `fromLevel` 15, `pct` [1, 20], `graceMin` 10, `rezRefund` 0.5, `incense` item code, `stack` 5 | server |

Plus edits to existing content: `content/uniques.json` (Tiger Girl's tuning; six mini-boss entries with
`announce: 'area'`), `content/quests/jangan.json` (§8), the drop tables of the derived monsters (a generated
`content/climb/drops.json`), and the items (Incense, slot rows) through wave 13's authored-items mechanism.

### 10.3 Server seams [decision]

| Seam | Where | What |
|---|---|---|
| **S-DERIVE** | `packages/shared/src/climb.ts` (new, pure) | `deriveMobs(base: MobDef[], roster) → MobDef[]`, the standard curve, the normalisation; used by `GameData` and by the client's content loader so both see the same defs |
| **S-REMAP** | `apps/server/src/spawner.ts` (+ nests load) | nest `mob` remapped by area at load; summons remapped too |
| **S-ROLES** | `apps/server/src/ai.ts` + a new `apps/server/src/climb/roles.ts` | pack link, ranged spacing, healer casts, cowards' flight and call; one tick hook, data from `roles.json` |
| **S-EXP** | `gameplay.ts` `mobDied` / `killExp` | the level-difference factor per share (before the springs' and meals' order of WAVE_PLAN9 D6); the mentoring weight in `party.ts` |
| **S-DEATH** | `gameplay.ts` `playerDied(p, now, killer)` | the killer passed in (the attack path knows it; `gmKill` passes `gm`); the penalty module's hook |
| **S-ARTS** | `apps/server/src/skills/engine.ts` | one lookup of the caster's Art mods when a row resolves (damage %, cooldown, MP, targets, stun ms, range, heal %) |
| **S-NAV2** | `apps/server/src/nav.ts` | `setHome` takes a list of components (town + far bank) |
| **S-FERRY** | `apps/server/src/npc.ts` (dialog) | the ferry lines (both banks): gold, the warning below 17, the free crossing after JG_X07, warp |
| **S-SETS** | a mod provider (FISHING's S-BUFF pattern) | the set bonuses |
| **S-TITLE** | `protocol.ts` | `EntityState.title?`, `PlayerStats.arts?`, `stats.penalty?`, `penaltyTaken` and `penaltyRefunded` events, `artPick` / `artReset` / `titleSet` requests (additive, protocol v1) |

`progression.ts` `TYPICAL_SP_BY_LEVEL` is regenerated from the new curve (GM setlevel); `MOB_LEVEL_MAX` stays
`LEVEL_CAP + 5` (every derived monster is ≤ 20).

### 10.4 GM commands [decision]

`/climb mob <code>` (the derived def and its multipliers), `/penalty test <pct>` (applies to self, audited),
`/incense <n>`, `/arts reset <player>`, `/title <player> <id>`, `/ferry` (warp to the far landing), and the uniques
module's `/unique` lists the six mini-bosses too.

---

## 11. Client [decision]

- **Content**: the client loads `content/climb/{levels, roster, arts, sets, achievements}.json` and runs the shared
  `deriveMobs`, so a `MOB_CL_*` entity finds its base model, champion skin and clips [confirmed: the client resolves
  monsters by code from its own `mobs` table, `apps/game/src/content/gameplay.ts`].
- **New UI**: the Arts row in the skill window (two cards per tier, the cost, "respec at the trainer"), the title line
  under names and in the character window, the penalty banner and the EXP bar's red flash, the Incense count in the
  bag tooltip, the set line in item tooltips ("Cavalry set 4/6: +3 % max HP").
- **Monster behaviours need no new art**: a healer's cast plays its attack clip's READY and SHOT with the existing
  heal effect on the target; a coward's flight is a RUN; the shout is a chat line and an existing sound cue.
- **Budget**: no new draws, models or textures; mini-bosses use champion skins or the giant scale [confirmed: every
  base has `championModel` except the tombstones and Hyungno, which use the giant scale; re-checked in `mobs.json` by
  `fc-data.ts`]. Frame cost ≈ 0 [projected: a second nameplate line for titled players (≤ 20), the far ferryman NPC,
  and pulls of 2–3 monsters instead of 1 in view, all inside what the fields already draw]. **The far bank itself is
  [unknown]**: no one has measured frames there (its terrain, trees and grass come from the same export and wave-12
  passes); CL-S takes the GPU lock and measures it at Medium (3 runs, median) before the ferry ships, and if it misses
  60 fps it goes to the render lanes, not here.

---

## 12. Budgets

- **Server** (the N100): the role tick runs only for awake monsters (the AI already sleeps monsters with no player
  near: `DORMANT_MARGIN_M` [confirmed: `gameplay.ts` tick]); per awake monster one extra branch per tick and a 1 Hz
  check for healers and packs. The far bank adds 852 monsters (≈ +14 % over 6,083), mostly dormant; the wave-11
  numbers put the idle server at ≈ 750 MB [confirmed: DEPLOY.md]; **≈ +60–90 MB** and **< 0.2 ms per tick** with a
  handful of players there [projected: BALANCE/FIELDS' per-monster memory and the 6,083-monster load]. Cross-check *(fact-check)*: DEPLOY.md's 310 → 750 MB for the
  wave-10 fields' 6,083 monsters (plus their nav) is ≈ 72 KB a monster, so 852 more ≈ 62 MB [projected: arithmetic].
  The combat linger keeps at most a few characters 10 s longer; the damage-share pool reads the damage map
  `killShares` already walks: both ≈ 0 [projected].
- **Client**: 0 draws, 0 textures, ≈ +10 KB of content JSON (brotli) [projected].
- **Database**: one migration; achievements ≈ 30 rows per character.

---

## 13. The prototype [confirmed: `work/tmp/climb/`]

### 13.1 What was built

| File | What |
|---|---|
| `lib.ts` | The engine: the server's own `formulas.ts`, `mob-skills.ts` and `skills/timing.ts`; the standard-monster fit; `derive()`; the player (BALANCE's character, tier gear, the greedy skill plan with the glaive's AoE lines); the multi-monster `pull()` with roles, HP-band adds, potions with reaction time and caps |
| `session.ts` | A 1–4 h hunting session at a spot: pull sizes by skill and party, links and adds, rests, deaths and walks back, the party EXP pool, gold and potion costs |
| `design.ts` | The design numbers: bands, the roster, 23 spots, the six mini-bosses, target hours, quest shares, wave-13 bonuses, the penalty, the level rule |
| `climb.ts` | The runs: today, the new roster (20 levels × 3 tiers × solo/duo/party of 4 at every candidate spot), the curve solver and smoother, the calibration, the Monte Carlo of 400 friends per profile, the mini-bosses, gold, SP; writes `out/climb.json` |
| `validate.ts` | The check against BALANCE §3 (29.8 h vs 28.0 h, frugal blade, today) |
| `tune.ts`, `roster.ts`, `survey.ts`, `tiers.ts` | The tuning pass, the roster table, the area survey, the tier contents |
| `charts.py`, `chart_skill.py`, `bandmap.py` | The images (PIL; the minimap tiles of `jangan-fields`) |
| `out-run1.txt` … `out-run5.txt` | Every run's console output, in order (§13.3) |

| `fc-powerlevel.ts` | Fact-check F1: a capped mentor carrying a friend of each level (weight 0, today's weights, the damage-share rule) |
| `fc-nav.ts`, `fc-nav2.ts` | F2: walkable components of the ferry sellers and every far-bank nest; the nearest far-bank landing points |
| `fc-remap.ts`, `fc-survey.ts` | F3: which (area, code) pairs the area remap cannot map; monsters per kind and area |
| `fc-climb.ts` | F7: `climb.ts` with the springs' trip charged (`TRIP_MIN`, default 7.5) and `FIXED=1` to keep run 5's curve; writes `out/fc-climb.json`, console in `out-fc-trip-fixed.txt` / `out-fc-trip-recal.txt` |
| `fc-borders.ts` | B4/B5 aggressive nests' distance to lower bands |
| `fc-data.ts` | levels, mob EXP, Tiger Girl, champion models, quest totals and objectives, the Arts' skill rows |
| `out-verify.txt` | the fact-check's re-run of `climb.ts` (identical to run 5) |

Reproduce: `pnpm tsx work/tmp/climb/climb.ts` (≈ 40 s on this machine; the draft said 6 min), then
`python work/tmp/climb/charts.py`, `python work/tmp/climb/chart_skill.py`, `python work/tmp/climb/bandmap.py`.

### 13.2 Images (`work/tmp/climb/out/`)

| Image | Shows |
|---|---|
| `climb-bands-map.png` | Every Jangan nest on the minimap, coloured by band; Tiger Girl's camps; the six mini-bosses; the ferry |
| `climb-hours.png` | Cumulative real-play hours to each level: today ×3, and the new mix, solo-only and grouped medians |
| `climb-curve.png` | EXP per level: retail ×1, the effective ×3, and the new curve (log scale) |
| `climb-skill.png` | Deaths per hour and the novice/good EXP gap at the level's own monsters, today vs new, by level group |
| `climb-mc.png` | p10–p90 and medians of hours to 20 for six profiles |
| `climb-gold.png` | Gold, items and potions per hour of solo hunting, and the net |

### 13.3 How the design moved during the runs (each is a rule above)

1. Run 1 (potions off by a bug in the scratch engine, then fixed): at-level deaths of 2–12 an hour at 14–20 even for
   good players. **Lesson: raw numbers, not roles, were killing**: the DPS normalisation (§2.2) and smaller late
   pulls followed.
2. Tuning passes: band attack 1.25–1.3 → 1.05–1.15; cowards flee 60 % of the time and call one helper (two only on
   the far bank); novices react to low HP in 1 s and drink at most 4 potions a pull.
3. Run 2: the best-spot bot farmed two levels down with no deaths; **the level-difference rule** (−15 % per level from
   2 below) and the at-level share followed.
4. Run 2's Monte Carlo: **the novice death spiral** (median 983 h); **adaptive play and the 10-minute grace**
   followed (§6.4).
5. Runs 3–4: mini-bosses too hard at 14–20 (boss fights used the per-pull potion cap); the potion cap was lifted for
   boss fights and MB5/MB7 toned to ×1.1 attack; the Tomb's trash EXP set to 0.75 so groups stay "a little faster";
   band gold raised for 14–20.
6. Run 5 (final): the numbers of this spec.

### 13.4 Limits of the model

- No terrain, line of sight, pathing or aggressive neighbours beyond the pull tables; no lag. Real play is harder.
- Skill tiers are invented parameters (§2.4); the playtest replaces them.
- Parties are equal-level blades and glaives; no force healer is modelled (Rebirth and Mender would make groups safer).
- Mini-boss and Tomb fights are the same engine without positioning (BALANCE §8.1 used 70 % uptime for that; the
  tiers' uptime plays the same role here).
- The Tomb is modelled only as trash pulls at the band's level (TOMB_DUNGEON owns the real thing).
- Death walks are straight lines at 5.5 m/s from the town gate (the far bank's crossing is not charged, §2.7).
- The springs' trip is inside the 15 % overhead, not charged per session (§3.3 F7 rows charge it).
- Parties are equal-level: no mentor, no carried friend (`fc-powerlevel.ts` covers that case, §7.1).
- The spots' monster mixes assume §2.2's overrides exist on the map (fact-check F3).

---

## 14. Decisions (each the recommended option; the user delegated)

| # | Decision | Why |
|---|---|---|
| D1 | Seven bands from the map: B1 1–5, B2 5–10, B3 9–13, B4 12–15, B5 14–18, B6 (Tomb) 15–20, B7 the far bank 17–20 | Levels follow distance; retail monsters stay where players know them; the far bank is the unused high land, the coast is not |
| D2 | Derived monsters (new codes on retail bases) from a fitted standard curve, DPS normalised to 0.85–1.2 before the band factor (0.85–1.32 after); 36 rows with B5's Bandit Subordinate 15 and Young Tiger 14; an area remap with a nearest-band fallback and per-nest overrides (§2.2) | One model can live at two levels; no monster is a raw-number spike; a pure area remap left four rows without nests (fact-check F3) |
| D3 | Four roles (pack, ranged, healer, coward) + elite camps, all data | Difficulty that asks for skill (pull, target, interrupt, burst), not HP |
| D4 | Level-difference EXP: −15 %/level from 2 below, +5 %/level above (max +15 %) | Otherwise the bots (and players) farm two levels down safely |
| D5 | Six band mini-bosses on the uniques module, area-announced; no more mini-uniques | One per ~5 levels; the siblings add the Tomb bosses, the Qilin and nemeses |
| D6 | Tiger Girl takes BALANCE's U-BAL tuning (`hpMul` 0.16, fury ×3) as the capstone | Already measured: a party of 4 in ≈ 6 min, never solo |
| D7 | Open the far bank: the ferry dialog at Doji and Chau (200 gold, any level, a warning below 17, free after JG_X07), a far-bank ferryman for the way back, two home components (0 and 1), SWIMMING's `openShore` rows | 852 monsters and the cap's band, for two dialogs, one NPC row and one nav list; both retail sellers are on the town's bank and swimmers bypass any gate (fact-check F2) |
| D8 | The new `levels` table (1 → 20 = 1,464,406 at ×1), calibrated to a 40 h median | The user's 40 h; the model reaches 39.9 h |
| D9 | Rates to ×1 on the live server | The curve is calibrated at ×1 (the user kept this default) |
| D10 | Keep the springs' 20 % × +50 % and the dishes; nemesis kills eligible (NEMESIS §5.1), the Qilin not (STORM_QILIN §6.1) | The curve includes them; each sibling owns its own kills, and the daily pool bounds the total anyway (fact-check F8) |
| D11 | Quest share 50/35/30/25 % by band; quest gold ×2 at 11–19; objectives match derived codes by base | The cap earned in the field; pays the late potions; no rewrite of objectives |
| D12 | Seven gear tiers from retail degrees and grades; shop grade A only; B/C from hunting; Seal of Star as T7 | Uses what exists; makes drops matter |
| D13 | Set bonuses: a family is a degree (any grade), 4/6 pieces; Seal of Star 3/5; one mod provider | Cheap, data only; 03_B has only 3 pieces wearable at ≤ 20 (fact-check F10) |
| D14 | Named slots W15-A…D, W17-A…C as disabled rows | Drop tables and quests can name them now |
| D15 | Drops: 2 % band items per kill, 30 % elite leaders, 100 % mini-bosses | ≈ 45–60 band drops per climb, about 7–8 per tier |
| D16 | 24 Arts (two per tier at mastery 10/15/20, three weapon trees + force), number-only, respec for gold | Choices within the cap with no new clip; B-tier rows are not exported |
| D17 | SP-EXP stays = kill EXP (3,329 SP at 20 from kills and quests, ≈ 3,430 with Rested and re-earned losses) | The Arts make SP a choice again; no new rule |
| D18 | The penalty as the user wrote it, at 15–19, monsters and bosses only, on death, with the message | Rule #13 |
| D19 | A 10-minute grace after a penalised or Incense-saved death; it never restarts on a grace death | The model's novice spiral (run 2); one Incense per chain of deaths |
| D20 | Ancestor's Incense: never sold, bound, at most 5 owned (bag + storage), from quests, mini-bosses, the Tomb's chest, shards | Protection that must be earned and cannot be banked or fed by a capped friend |
| D21 | Soul Rebirth Art refunds 50 % (100 % with the Rebirth Art); all refunds of one death (rez, nemesis) capped at its loss via `penaltyRefunded` | Groups and healers matter at 15–20; no net-gain loop (fact-check F5) |
| D22 | No penalty at 20 (no bar to take) | The rule's own definition; the cap is not punished further |
| D23 | Mentoring: a capped member's level weight in the EXP split is 0, and a kill pays the party pool × the uncapped members' damage share (floor 25 %) | A level-20 friend helps instead of taking, without carrying a newcomer at 1.4–4.4× their solo speed (fact-check F1, `fc-powerlevel.ts`) |
| D24 | An achievements and titles module with 20 first entries, shared with the siblings | Post-cap goals and the siblings' rewards need one place |
| D25 | 13 new quests (six bounties, the Tomb Approach, the ferry, the far bank, the penalty's intro) plus TOMB_DUNGEON's JG_T01 in the pacing; existing objective types only; JG_013's hints move to the Chinese Tomb | Every band has story and a reason to go; no new quest-engine types; a level-9 quest never sends players into B4 (fact-check F4) |
| D26 | Migration by bar fraction; done quests stay done; 2 Incense at 15+; "Pioneer" | Nothing is lost; the change is visible and friendly |
| D27 | One migration (columns `curve_version`, `title`, `arts`; table `char_achievements`) | The smallest persistent footprint |
| D28 | The Tomb's EXP budget: trash 0.75 × standard; ≈ 1.15× a solo hour per member | "A little faster" in groups; loot is the reward |
| D29 | Band gold factors 1.0 → 2.6 | Potions at ×1 are a real cost; the late game must stay payable |
| D30 | Level-20 bounty board daily | A reason to log in at the cap |
| D31 | A 10 s combat linger when a player at 15–19 leaves the world within 10 s of monster damage | Closing the tab would otherwise dodge rule #13 (fact-check F6) |
| D32 | The B4 nests within 100 m of a B1/B2 nest are passive | Aggressive level-12–15 packs sit 43–47 m from newcomers' nests (`fc-borders.ts`) |
| D33 | Mini-bosses need four uniques-module additions (area notices, an adds table, authored camp nests, a look field), owned by CL-SV | The module today notifies everyone and summons only from retail rows (fact-check F9) |
| D34 | The curve stays at 1,464,406 although charging the springs' trip moves the mix to 41.6 h | 39.9–41.6 h brackets "about 40"; the trip's real cost is unknown until play (fact-check F7) |

## 15. Needs from the user

Nothing blocks the start; no download, no Meshy.

| # | What | When | Default if no answer |
|---|---|---|---|
| U1 | Look at `climb-bands-map.png` and `climb-hours.png` (2 min) | before the build | build as designed |
| U2 | The OK to set the live rates to ×1 and to deploy with one migration (a DB backup first) | at deploy | no deploy without it |
| U3 | **One evening of play at 14–17 with a friend** after the build (the Tomb Approach, the Tiger Mountains, one mini-boss): does it feel hard in a good way? | after the build | the model's numbers stand |
| U4 | Confirm the death penalty's additions: the **10-minute grace**, the **Incense** (bound, at most 5), and the **10 s combat linger** that stops a closed tab from dodging it | after reading §6 | all on |

## 16. Open questions (each with the default used meanwhile)

| # | Question | Default |
|---|---|---|
| Q1 | The live accounts' levels | Unknown here; the migration rule covers any level |
| Q2 | The far bank's final landing points | Components are known (town 0, far bank 1) and walkable candidates exist 235 m from Chau and 325 m from Doji (`fc-nav.ts`); CL-S picks the final points; the ferry is cut (cut 4) only if none is open ground |
| Q3 | The Incense icon | The nearest retail scroll or talisman icon |
| Q4 | Should a nightly soaker's 34 h be trimmed (`capFrac` 0.15 at 15–19)? | No: keep 0.2 |
| Q5 | Mail for the migration's Incense | Into the bag if no mail module exists |
| Q6 | A nemesis refund on avenging (NEMESIS's call) | NEMESIS decided half the recorded loss (NEMESIS §2.5); this spec caps all refunds of a death at its loss (`penaltyRefunded`) |
| Q7 | Duels or an arena in a later wave | The penalty already excludes them |

## 17. Lanes

### 17.1 Order

**Step 0 (seams, disjoint files):** CL-P (protocol + shared `climb.ts` + content types), CL-SV (the server spine:
S-REMAP, S-EXP, S-DEATH, S-NAV2, the migration, the GM rows, module stubs, the uniques additions and the combat
linger). **Shared files WAVE_PLAN10 must settle** (fact-check): `uniques.ts` (CL-SV here, STORM_QILIN's QL-S
exports, NEMESIS reuses its helpers), `connection.ts` (a wave-13 spine file; the linger), `party.ts` (CL-SV's
mentoring; NEMESIS reads `KillOwner`), the death path (CL-SV/CL-K, with NEMESIS's and STORM_QILIN's S-DEATH). **Step 1 (parallel):** CL-D, CL-R, CL-K,
CL-A, CL-Q, CL-S, CL-G, CL-U. **Then:** integration with the siblings (WAVE_PLAN10), a **balance soak** (bots on a
private server, §17.3), the hunt, fixers, gate, verify.

### 17.2 The lanes

| Lane | Files (owner) | Seams used | Tests | Effort |
|---|---|---|---|---|
| **CL-P** protocol and shared | `packages/shared/src/{climb.ts, protocol.ts (additions)}`, content types and checks | — | `deriveMobs` golden rows (the §2.2 table), the standard fit, content-check of every `content/climb/*.json` | 0.5 day |
| **CL-SV** server spine | `gameplay.ts` (killExp factor, `playerDied` killer), `spawner.ts` (remap by area + nest overrides + the fallback), `nav.ts` (home list), `db.ts` (the migration), `party.ts` (mentoring weight and the damage-share pool), `connection.ts` (the 10 s combat linger, D31), `uniques.ts` + `content.ts` `UniqueDef` (area notices, `adds`, authored camps, `look`: D33), `gm.ts` rows | S-* | the level rule, remap by area with overrides and fallback (every live nest resolves), the killer on every death path (melee, skill, DoT, GM), two home components, migration up/down, a pure carry pays 25 % (§7.1 table), a tab closed at low HP still dies, a mini-boss's notice reaches only its area | 2 days (was 1: the uniques and linger work) |
| **CL-D** data | `content/climb/{levels, roster, bands, roles, sets, slots, penalty}.json` (`bands.json` with the per-nest overrides, the passive B4 border and six authored camp nests), `content/climb/drops.json` (generated), `content/uniques.json` (Tiger Girl + six entries) | S-DERIVE | the climb model re-run on the files (the numbers of §3.2 within 2 %); `fc-remap.ts` on the files shows no unmapped live nest and no derived row without monsters | 1 day |
| **CL-R** monster roles | `apps/server/src/climb/roles.ts`, the `ai.ts` hook | S-ROLES | link, spacing, heal cast and interrupt, flight and call, helpers never flee, elite camps; a perf test with 200 awake monsters | 2 days |
| **CL-K** the penalty | `apps/server/src/climb/penalty.ts`, the Incense item | S-DEATH | 15–19 only, never a de-level, grace (started by an Incense burn, never restarted by a grace death), Incense (bound, ≤ 5 owned), refunds capped at the loss across rez and nemesis (`penaltyRefunded`), GM kills excluded, the messages, `penaltyTaken` | 1 day |
| **CL-A** Arts and sets | `skills/engine.ts` (the lookup), `apps/server/src/climb/{arts, sets}.ts`, `content/climb/arts.json` | S-ARTS, S-SETS | every Art's effect on its row, respec cost, set counts | 2 days |
| **CL-Q** quests | `content/quests/jangan.json` (EXP, gold), 13 new quests (JG_T01 is TOMB_DUNGEON's), JG_013's hints, the quest engine's base-code match | S-REMAP | `quests-content-check`, the hunting-grounds test on derived nests, the EXP sum = 398,333 ± rounding | 1.5 days |
| **CL-S** ferry and the far bank | `npc.ts` dialog, the far-bank ferryman NPC row, `bands.json` landing points, SWIMMING `openShore` rows | S-NAV2, S-FERRY | the warp both ways, the warning below 17, free after JG_X07, the far bank spawns (852 monsters; Earth Ghost Canyon empty), the swim exit there; a GPU-lock fps check on the far bank (Medium, 3 runs, median ≥ 60 fps) | 1 day |
| **CL-U** achievements and titles | `apps/server/src/achievements.ts`, `content/climb/achievements.json` | S-TITLE, the module bus | counters, persistence, titles in `EntityState` | 1 day |
| **CL-G** client | `apps/game`: content load, the Arts row, titles, the penalty banner and bar flash, tooltips, the mini-bosses' map icons | S-TITLE | UI tests; the mock server | 2 days |

### 17.3 The balance soak and the user checks

- **Soak** (after integration): a private server on a free port with a temp copy of `game.db`, 6–8 bots of the three
  tiers (the existing soak bot, `apps/server/test/soak/`) for 2 h at 14–19: deaths/h, EXP/h, potions, calls and heals
  per hour against §2.4 (within ×1.5), and the server's tick time (< 2 ms p95 with the far bank awake).
- **Hunt lenses**: farming a mini-boss's adds, kiting a coward forever, healer loops that never end, the ferry used to
  escape a fight, the Incense duplicated, a GM kill or a fall taking EXP, a quest done twice for the new EXP, and
  (fact-check) a capped mentor carrying a newcomer, a closed tab at low HP, a rez plus a nemesis refund paying more
  than the loss, an Incense stack in storage, a level-9 quest hint inside B4, a capped player camping a band
  mini-boss ahead of a bounty holder (default: no rule on a friends' server; the bounty credits every player in the
  damage map, so arriving early is enough).
- **User checks**: §15 U1–U4.

## 18. Scope-cut order (cut from the top) and never-cut

1. The achievements and titles module (keep the event hooks; titles later).
2. The set bonuses.
3. The level-20 bounty board and the weekly MB7 quest.
4. The ferry and the far bank (B7 falls back to the Jangan Ferry's 13 nests + B5's top; the curve is re-run).
5. The Arts (keep SP as today).
6. Half the new quests (keep the penalty's intro, the ferry if kept, the Tomb's key slot).
7. Mini-bosses MB1 and MB2 (keep MB3–MB7).

**Never cut:** the new curve and ×1 rates, the re-levelled roster with its four roles, the level rule, the death
penalty with its message, grace and Incense, Tiger Girl as the capstone, the gear tiers' drops, the migration without
loss.

## 19. Risks

| Risk | Mitigation |
|---|---|
| The model's skill tiers are wrong; real friends die more (no terrain in the model) | Every number is content; the soak and U3 re-tune band attack and pull sizes first |
| The penalty feels cruel | Grace, Incense, refunds; the message names the exact loss; `penalty.json` can lower the range in one edit |
| Healer and coward loops frustrate | Heal 12 % every 7 s is below an average player's damage; cowards flee once; the soak's lens |
| Groups too strong or too weak vs solo | The party bonus and the Tomb's 0.75 are knobs; the soak measures both |
| The far bank's nav has no walkable landing | Unlikely: candidates found (`fc-nav.ts`); else cut 4, B5 carries 17–18 |
| The far bank misses 60 fps | Unmeasured [unknown]; CL-S's GPU-lock check before the ferry ships; the render lanes own the fix |
| A capped friend power-levels a newcomer | The damage-share rule (§7.1, D23); the soak's lens |
| The remap's overrides drift from the model's spots | CL-D's content check (every derived row has monsters; every live nest resolves) |
| Server load with the far bank awake | Dormancy already exists; the soak measures it |
| Gold too tight at 17–19 | Quest gold and band factors are content; Large potion price is the last lever |
| The siblings' numbers (Tomb EXP, nemesis, Qilin) break the 40 h | The budgets of §3.5; WAVE_PLAN10 re-runs `climb.ts` with their tables |

## Appendix: scratch files (`work/tmp/climb/`)

`lib.ts`, `session.ts`, `design.ts`, `climb.ts`, `validate.ts`, `tune.ts`, `roster.ts`, `survey.ts`,
`survey-nests.json`, `tiers.ts`, `charts.py`, `chart_skill.py`, `bandmap.py`, `out/climb.json`, `out/*.png`,
`out-run1.txt` … `out-run5.txt`; the fact-check's `fc-powerlevel.ts`, `fc-nav.ts`, `fc-nav2.ts`, `fc-remap.ts`,
`fc-survey.ts`, `fc-climb.ts`, `fc-borders.ts`, `fc-data.ts`, `out-verify.txt`, `out-fc-trip-fixed.txt`,
`out-fc-trip-recal.txt`, `out/fc-climb.json`. No file outside `work/tmp/climb/` and this doc was written.
