# Balance: levelling 1 → 20 around Jangan

What a typical character's climb to the level cap costs in kills, hours, gold, potions and skill points, computed with the server's own formulas over the real exports (`work/out/data`, play export `jangan-fields`) and the questline (`content/quests/jangan.json`). It ends with the broken spots I looked for, the bugs this pass fixed, and the rate knobs with recommended values.

Status tags as in the other docs: numbers marked **[model]** come from the simulation described in §1. Everything else is read straight from data or code.

## 0. Summary

- **At the default rates (all 1)**, a solo blade or glaive player who plays frugally reaches level 20 in about **28–30 hours of grinding** (2,580 kills) plus about **2.5–3 hours of questline walking and talking**. "Frugally" means attack skills without the imbue, a potion only in an emergency, and sitting out the rest to regenerate. A player who keeps the imbue up and drinks HP and MP potions needs about **6 hours of grinding**, but spends about **3× the gold** that monsters drop. **[model]**
- **The quests give 30.4 % of the 1 → 20 EXP** (341,400 of 1,124,480), inside the QUESTS §3.4 target of 20–35 %. From level 8 on, every level is 30–33 %. Levels 1–5 are about 53 % on purpose (the tutorial).
- **Skill points are plentiful.** 2,530 SP by level 20 (1,957 from kills and 573 from quests). The P0 skills plus three masteries at 20 cost 1,930 SP.
- **Gold is plentiful for gear and tight for potions.** Quest gold (115,900) alone pays for the best shop weapon, armour and accessories along the way (58,770). Frugal play ends at level 20 with about 300,000 gold spare. Potion-fed play runs about 415,000 short at GOLD_RATE 1.
- **Every level from 1 to 19 has its own monster** reachable on foot. No quest sends you to monsters far above its level. No usable item is priced beyond reach. Potions are cheap at level 1: a herb costs about two Mangyang kills of gold.
- **Difficulty spikes:** Bandit (level 16, `JG_021`: kill 20) and White Tiger (level 18, `JG_023`). Both are aggressive, hit every 1.5 s, and take 40–60 % of a level-appropriate character's HP per kill. Both are killable at their level with about half an HP potion per kill (§6).
- **Two formula bugs fixed** (§8): Tomb Stone Ghost and Tomb Stone did 1 damage per hit, and magical damage used the STR balance instead of the INT balance.
- **Knobs added** (§7): `EXP_RATE`, `SP_RATE` and `DROP_RATE` are new. `GOLD_RATE` existed but was never applied, and is now applied in `rollDrops`. All four default to 1. **Recommended for the friends server: 3 / 3 / 3 / 2.** That gives about 9 hours of frugal grinding, or about 2 hours potion-fed, and potion-fed play stops losing gold.

## 1. The model and its assumptions

Sources, all used as they are in the running server:

| What | Where |
|---|---|
| Max HP/MP `1.02^(L−1) × STR (INT) × 10` | `apps/server/src/formulas.ts` `maxHpFor`, `maxMpFor` |
| Player attack, defence, hit/parry, balance `stat / (4L + 28)` | `formulas.ts` `playerCombatStats`, `balanceRatio` |
| Hit roll, damage pipeline, miss/block/crit, level-difference bonus | `formulas.ts` `rollSkillHit`, `damageRoll`, `hitBalance`, `missChance`, `levelDiffBonus` |
| Imbue component | `formulas.ts` `imbueDamage` (via `skills/engine.ts` `imbue`) |
| Monster stats and champion ×2 HP, ×2 EXP, ×1.2 attack | `mobs.json`, `formulas.ts` `mobCombatStats`, `VARIANT_RULES` |
| Kill EXP = SP-EXP = `MobDef.exp × variant` | `gameplay.ts` `killExp` (no mob has `spExp`) |
| Level curve, 400 SP-EXP per SP, +1 STR +1 INT +3 points per level | `levels.json`, `progression.ts` `gainExp`, `CHARACTER_RULES` |
| Mastery cost `levels[L].masterySp`; skill rows `sp`, `masteryLevel` | `skills/learn.ts`, `skills.json` |
| Drops: gold chance × amount, one roll per item group | `drops.json`, `gameplay.ts` `rollDrops` |
| Regeneration 3 % of max HP/MP per 2 s, after 5 s out of combat | `formulas.ts` `REGEN` |
| Potions, 1 s cooldown per group | `items.json` `use`, `POTION_COOLDOWN_MS` |
| Quest EXP, SP (`sp × 400` SP-EXP), gold, items | `quests/rewards.ts` `turnInGain`, `content/quests/jangan.json` |
| Which nests spawn (reachable on foot, level ≤ `MOB_LEVEL_MAX`) | a real `startServer` on `jangan-fields`: 700 nests, 6,083 monsters |

**The character.** Male, heavy armour. Every stat point goes into STR, so STR = 20 + 4(L−1) and INT = 20 + (L−1): the usual melee build, and the one the balance ratio rewards. It fights one monster at a time and takes 5 s to walk to the next one and pick up the loot.

**Weapons.** The blade uses `SKILL_CH_SWORD_BASE_01` (2 hits × 60 %, every 1.2 s). The glaive uses `SKILL_CH_SPEAR_BASE_01` (1 hit × 117 %, every 1.166 s).

**Gear.**
- "Quest gear": the starter weapon and the heavy `_DEF` set, plus every quest reward at the level the questline hands it out (weapon 01_C at 5, 02_A at 9, 02_B at 11, 02_C at 14, 03_A at 17, 03_B at 19; armour pieces and accessories as in QUESTS §3.3).
- "Shop gear", the default in the tables: on top of that, the best shop item (grade A, degrees 1–3) for every slot where it beats what the character wears. §5 counts what that costs.

**Skills, bought greedily as SP arrives.**
- Blade: the weapon mastery (Bicheon) and Cold, each up to the character level, then every level of Strike Smash, Illusion Chain, Soul Cut Blade and Ice River Force (the P0 attack skills of SKILLS §10.4).
- Glaive: Heuksal + Cold with Wolf Bite Spear, Dancing Demon Spear, Soul Spear – Move and Ice River Force.
- SP at the start of level L = the kill SP-EXP of levels 1 … L−1 / 400, plus the quest SP of those levels.
- Buffs (Weak Guard of Ice, +2 % PD) and passives are left out: they are small at these levels.

**Three play styles**, each simulated as one hour of fighting with HP and MP carried from kill to kill:
- **frugal**: attack skills but no imbue; an HP potion below 30 % HP; after a kill, sit to full when HP < 50 % or MP < 25 %.
- **potion-fed**: imbue always up, skills on cooldown, an HP potion below 50 %, an MP potion whenever a skill lacks MP; no sitting.
- **resting**: imbue and skills, no potions, sit to full whenever low. It is dominated by the other two and left out of the tables.

In all three, potions are the tier that fits the level: Herb (L1–5), Small (6–10), Medium (11–15), Large (16–20).

**Target monster.** For each level, the one with the most EXP per hour among those from 3 levels below to 2 above, with no deaths in the hour.

**Left out of the model:**
- adds from aggressive nests;
- giants (1 %, `GIANT_PCT`), which are party monsters;
- navmesh detours;
- players doing several things at once;
- the level-difference miss for monsters above you, which *is* in (`MISS_PER_LEVEL_ABOVE`).

**Reproduce.** Scratch scripts in `work/tmp/balance/` (gitignored), run with `pnpm tsx` / `pnpm exec node`:
- `nests.ts` starts a real server on a temp DATA_DIR and dumps the live nests;
- `sim.ts --magicfix` runs the model (wave 8: monster skills on; `--nomobskills` for the wave-7A basic attack, `--out=<file>` names the output);
- `summary.cjs`, `doc.cjs` and `questwalk.cjs` print the tables.

## 2. Monsters by level (what actually spawns on `jangan-fields`)

"Nearest" is the straight-line distance from the town gate (96.9, −136.9) to the closest live nest.

| Lv | Monster | HP | Attack | Every | PD | EXP | Nests | Monsters | Nearest | Main zones |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Mangyang | 54 | 17-19 | 3 s | 7 | 24 | 55 (0 aggr.) | 825 | 269 m | Grassland, Hill of Ye Mt. |
| 2 | Small-Eyed Ghost | 55 | 21-23 | 2 s | 9 | 47 | 37 (0 aggr.) | 382 | 434 m | Grassland, Lake Forest |
| 3 | Big-Eyed Ghost | 85 | 25-29 | 1.5 s | 9 | 71 | 37 (0 aggr.) | 368 | 375 m | Lake Forest, Hill of Ye Mt. |
| 4 | Old Weasel | 83 | 30-34 | 2 s | 12 | 94 | 41 (0 aggr.) | 406 | 368 m | Hill of Ye Mt., Lake Forest |
| 5 | Weasel | 119 | 35-40 | 2 s | 12 | 118 | 30 (0 aggr.) | 291 | 375 m | Hill of Ye Mt., Swamp area |
| 6 | Water Ghost Slave | 114 | 41-47 | 2 s | 15 | 141 | 20 (0 aggr.) | 200 | 394 m | Swamp area |
| 7 | Water Ghost | 156 | 47-54 | 2 s | 15 | 165 | 31 (0 aggr.) | 312 | 369 m | Swamp area, Lake Forest |
| 8 | Tomb Stone Ghost | 204 | magic 74-83 | 2.5 s | 15 | 188 | 35 (0 aggr.) | 176 | 688 m | Qin-Shi Tomb entrance, Chinese Tomb |
| 8 | Broken Stone Ghost | 204 | 53-62 | 1.5 s | 22 | 188 | 30 (30 aggr.) | 150 | 698 m | Qin-Shi Tomb entrance, Hill of Ye Mt. |
| 9 | Tomb Stone | 194 | magic 84-94 | 2.5 s | 22 | 212 | 35 (35 aggr.) | 244 | 866 m | Chinese Tomb, Lake Forest |
| 9 | Stone Ghost | 194 | 60-70 | 2.5 s | 22 | 212 | 36 (36 aggr.) | 200 | 666 m | Qin-Shi Tomb entrance, Chinese Tomb |
| 10 | Decayed Yeoha | 249 | 67-79 | 2.5 s | 26 | 235 | 28 (0 aggr.) | 278 | 599 m | Yeoha's Forest, Grassland |
| 10 | Yeoha | 249 | 67-79 | 2.5 s | 22 | 235 | 26 (26 aggr.) | 258 | 640 m | Yeoha's Forest, North-Tiger Mt. |
| 11 | Bandit Subordinate | 310 | 71-84 | 1.5 s | 29 | 259 | 23 (0 aggr.) | 218 | 1,057 m | South-Tiger Mt., North-Tiger Mt. |
| 12 | Bandit Archer | 324 | 77-92 | 2.5 s | 29 | 282 | 29 (29 aggr.) | 177 | 993 m | Bandit's Stronghold, South-Tiger Mt. |
| 13 | Young Tiger | 387 | 85-101 | 1.5 s | 29 | 306 | 29 (0 aggr.) | 232 | 707 m | North-Tiger Mt., Yeoha's Forest |
| 14 | Tiger | 509 | 87-104 | 1.5 s | 35 | 329 | 34 (34 aggr.) | 272 | 1,050 m | North-Tiger Mt., South-Tiger Mt. |
| 15 | Bandit Bowman | 514 | 94-113 | 2.5 s | 44 | 353 | 11 (0 aggr.) | 77 | 1,274 m | South-Tiger Mt., North-Tiger Mt. |
| 16 | Bandit | 755 | 102-123 | 1.5 s | 51 | 376 | 60 (60 aggr.) | 502 | 1,384 m | South-Tiger Mt., Bandit's Stronghold |
| 17 | Black Tiger | 749 | 111-133 | 1.5 s | 42 | 400 | 24 (24 aggr.) | 194 | 1,379 m | North-Tiger Mt., South-Tiger Mt. |
| 18 | White Tiger | 809 | 120-143 | 1.5 s | 55 | 423 | 30 (30 aggr.) | 240 | 1,536 m | North-Tiger Mt., South-Tiger Mt. |
| 19 | Chakji Worker | 958 | 129-154 | 2 s | 59 | 447 | 8 (0 aggr.) | 80 | 1,402 m | Jangan Ferry, North-Tiger Mt. |
| 20 | Tiger Girl (unique) | 598,720 | 181-217 | 3 s | 42 | 451,200 | 11 nests, one alive at a time, respawn 3–6 h | 1 | 1,322 m | Bandit's Stronghold, Tiger Mts |

Every level from 1 to 19 has at least one monster type. The thinnest is level 19 (Chakji Worker: 80 monsters in 8 nests), which is fine for a few friends. Its other 14 nests, and all 27 nests of the level-20 Chakji, are among the 91 nests the server skips as unreachable on foot: west of the river, regions 156–161 × 98–102. Nothing but the unique is level 20. At the cap no EXP is kept anyway, and quest EXP turns into SP-EXP (`QUEST_CAP_EXP_TO_SPEXP`).

## 3. Levelling 1 → 20 (blade, shop gear) [model]

"Quest EXP" is the non-repeatable quests of that level (QUESTS §3.4). "Kills" and "hours" are the grind for the rest of the level at the best monster.

| Lv | EXP to next | quest EXP | quest share | frugal: best mob | EXP/h | kills | hours | potion-fed: best mob | EXP/h | kills | hours |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 118 | 180 | 153 % | Small-Eyed Ghost 2 | 10,377 | 0 | 0.00 | Big-Eyed Ghost 3 | 17,423 | 0 | 0.00 |
| 2 | 470 | 320 | 68 % | Small-Eyed Ghost 2 | 12,702 | 3 | 0.01 | Old Weasel 4 | 20,117 | 2 | 0.01 |
| 3 | 1,058 | 800 | 76 % | Small-Eyed Ghost 2 | 14,988 | 5 | 0.02 | Old Weasel 4 | 23,794 | 3 | 0.01 |
| 4 | 1,880 | 700 | 37 % | Small-Eyed Ghost 2 | 17,048 | 25 | 0.07 | Old Weasel 4 | 24,204 | 13 | 0.05 |
| 5 | 2,938 | 1,400 | 48 % | Old Weasel 4 | 25,926 | 16 | 0.06 | Water Ghost Slave 6 | 41,786 | 11 | 0.04 |
| 6 | 5,640 | 2,700 | 48 % | Water Ghost Slave 6 | 25,793 | 21 | 0.11 | Water Ghost Slave 6 | 54,800 | 21 | 0.05 |
| 7 | 9,048 | 3,300 | 36 % | Water Ghost Slave 6 | 27,706 | 41 | 0.21 | Water Ghost Slave 6 | 77,126 | 41 | 0.07 |
| 8 | 13,160 | 4,000 | 30 % | Water Ghost Slave 6 | 27,055 | 65 | 0.34 | Tomb Stone 9 | 102,510 | 39 | 0.09 |
| 9 | 17,978 | 6,000 | 33 % | Water Ghost Slave 6 | 26,927 | 85 | 0.44 | Tomb Stone 9 | 111,433 | 51 | 0.11 |
| 10 | 23,500 | 7,500 | 32 % | Water Ghost 7 | 29,064 | 87 | 0.55 | Tomb Stone 9 | 116,430 | 69 | 0.14 |
| 11 | 34,898 | 10,500 | 30 % | Stone Ghost 9 | 28,162 | 106 | 0.87 | Tomb Stone 9 | 122,254 | 105 | 0.20 |
| 12 | 47,940 | 14,500 | 30 % | Tomb Stone 9 | 30,086 | 146 | 1.11 | Yeoha 10 | 128,622 | 128 | 0.26 |
| 13 | 62,628 | 18,500 | 30 % | Yeoha 10 | 29,965 | 168 | 1.47 | Yeoha 10 | 129,477 | 172 | 0.34 |
| 14 | 78,960 | 23,500 | 30 % | Bandit Archer 12 | 30,006 | 180 | 1.85 | Bandit Archer 12 | 136,099 | 176 | 0.41 |
| 15 | 96,938 | 29,000 | 30 % | Bandit Archer 12 | 29,676 | 216 | 2.29 | Bandit Archer 12 | 138,001 | 219 | 0.49 |
| 16 | 127,840 | 38,500 | 30 % | Young Tiger 13 | 31,656 | 292 | 2.82 | Young Tiger 13 | 140,270 | 292 | 0.64 |
| 17 | 161,798 | 48,500 | 30 % | Tiger 14 | 27,528 | 312 | 4.12 | Tiger 14 | 135,351 | 320 | 0.84 |
| 18 | 198,810 | 59,500 | 30 % | Bandit Bowman 15 | 26,323 | 395 | 5.29 | Bandit Bowman 15 | 131,432 | 395 | 1.06 |
| 19 | 238,878 | 72,000 | 30 % | Black Tiger 17 | 26,287 | 417 | 6.35 | Black Tiger 17 | 117,492 | 417 | 1.42 |
| **1→20** | **1,124,480** | **341,400** | **30.4 %** | | | **2,579** | **28.0** | | | **2,471** | **6.2** |

**Glaive.** 29.7 h frugal and 6.2 h potion-fed. The spear basic attack (117 % every 1.166 s) roughly matches the blade's 2 × 60 % every 1.2 s. Dancing Demon Spear and Soul Spear – Move make up for Illusion Chain.

How to read it:
- **Frugal play spends 65–80 % of its time sitting.** The regeneration rule refills 1.5 % of max HP/MP per second after 5 s out of combat, so a full refill takes about 72 s. Skills cost 20–130 MP against a pool of 200–570. The potion-fed player trades that time for gold (§5).
- **The best EXP per hour comes from monsters 2–3 levels *below* you** from level 8 on. Kill EXP has no level-difference penalty (`killExp`), and lower monsters die in 2–4 s. At-level monsters give 50–95 % of the best rate (§6).
- **The early levels are the questline.** Levels 1–5 need about 115 grind kills in total, and the quest kill objectives (JG_002, JG_003, JG_005, JG_006) already provide them. A player who does the quests reaches level 6 in 30–45 minutes, walking included.
- **The questline itself:** 47.6 km of straight-line walking between givers, hint locations and turn-ins (`questwalk.cjs`). At `MOVE_SPEED` 5.5 m/s that is about 2.4 h, or about 3 h with navmesh detours and dialog. Its kill and collect objectives, about 390 kills, are part of the grind above, not extra. The finale encounter (JG_025, Tiger Girl at `hpMul` 0.05 = 29,936 HP, attack × 0.8) takes about 3 minutes for 4 level-19 players, with the tank taking about 30 damage/s. Solo it is about 11 minutes and about 36 Large HP potions.

### 3.1 Quest EXP share per band

| Band | Level EXP needed | Quest EXP | Share |
|---|---|---|---|
| 1–5 | 6,464 | 3,400 | 53 % (tutorial, over-fed on purpose) |
| 6–10 | 69,326 | 23,500 | 34 % |
| 11–15 | 321,364 | 96,000 | 30 % |
| 16–19 | 727,326 | 218,500 | 30 % |
| **1–19** | **1,124,480** | **341,400** | **30.4 %** |

That is inside the QUESTS §3.4 target (20–35 %) in every band from level 6 on. Quest kill objectives add their own kill EXP on top, about 390 of the 2,580 kills (15 %). The dailies (4–5 % of a level each, once a day) sit outside the 30 %.

## 4. Skill points [model]

- **SP income.** Kill SP-EXP equals kill EXP, and every 400 SP-EXP is 1 SP.
  - Kills supply 783,080 EXP to level 20, so 1,957 SP.
  - The quests give 573 SP directly (as `sp × 400` SP-EXP).
  - Total at level 20: **2,530 SP**.
- **Cost of a full P0 build.**
  - Three masteries to 20: 3 × 334 = 1,002 SP.
  - Every level of the six P0 skills up to mastery 20: 928 SP (Strike Smash 150, Illusion Chain 148, Soul Cut Blade 145, Ice River Force 150, Weak Guard of Ice 175, Heal – Medical Hand 160).
  - Total: **1,930 SP**. A character ends at 20 with about 600 SP to spare, or enough for most of a fourth line.

| Level | SP owned | Blade: Bicheon / Cold and what is learned (greedy) | Glaive: Heuksal / Cold |
|---|---|---|---|
| 5 | 10 | 4 / 4, no skill yet (Strike Smash needs mastery 5) | 4 / 4 |
| 6 | 16 | 5 / 5, Strike Smash 1 | Wolf Bite Spear 1 |
| 7 | 28 | 6 / 6, + Ice River Force 1 | + Ice River Force 1 |
| 8 | 48 | 7 / 7, Strike Smash 2, Illusion Chain 1 | Wolf Bite 2 |
| 10 | 118 | 10 / 10, Smash 3, Chain 2, Ice River 3 | + Dancing Demon Spear 1 |
| 12 | 250 | 12 / 12, 44 SP spare (enough for Force 12 and Heal: 80 SP by level 13) | 44 spare |
| 14 | 499 | 14 / 14, + Soul Cut Blade 1, 140 spare | + Soul Spear – Move 1 |
| 16 | 894 | 16 / 16, 325 spare | 316 spare |
| 20 | 2,530 | 20 / 20, all four attack lines maxed, 1,269 spare | 1,248 spare |

SP is **not a constraint** past level 11. Before that, the first attack skill arrives at level 5–6, when mastery 5 becomes affordable (7 SP for the mastery plus 2 for the skill). The one catch: SP comes from *kills*. A rate change that means fewer kills (`EXP_RATE` > 1) must raise `SP_RATE` by the same factor, or players reach 20 with about half the SP (§7).

## 5. Gold: income, potions, gear, drops

### 5.1 What a kill is worth (`drops.json`, `rollDrops`)

Gold drops with a 70 % chance, between the table's min and max. Item value is the expected sell price of the item groups.

| Monster (lv) | Gold roll | Gold/kill | Item sell value/kill | Potions/kill | Equipment drop | EXP |
|---|---|---|---|---|---|---|
| Mangyang (1) | 28-59 | 30 | 7 | 0.042 | 1.39 % | 24 |
| Big-Eyed Ghost (3) | 35-74 | 38 | 10 | 0.042 | 1.22 % | 71 |
| Weasel (5) | 42-88 | 46 | 11 | 0.042 | 1.09 % | 118 |
| Water Ghost (7) | 49-103 | 53 | 11 | 0.042 | 1.09 % | 165 |
| Stone Ghost (9) | 56-118 | 61 | 13 | 0.042 | 0.94 % | 212 |
| Bandit Subordinate (11) | 63-132 | 68 | 15 | 0.042 | 0.87 % | 259 |
| Young Tiger (13) | 70-147 | 76 | 23 | 0.042 | 0.77 % | 306 |
| Bandit Bowman (15) | 77-162 | 84 | 24 | 0.042 | 0.77 % | 353 |
| Black Tiger (17) | 84-176 | 91 | 35 | 0.042 | 0.69 % | 400 |
| Chakji Worker (19) | 91-191 | 99 | 45 | 0.042 | 0.65 % | 447 |

- **Gold per kill** grows only from 30 to 99 across 1–19. EXP per kill grows 18×, so gold per *hour* stays flat at about 6,000–12,000 (frugal) and about 27,000–35,000 (potion-fed kills faster).
- **Drops are pocket money.** Items are 15–30 % of income, mostly potions and a rare piece of degree-appropriate equipment (about 1 in 100 kills).
- **Sell prices are 35–48 % of the buy price.** No item sells for more than it costs, so there is no buy-sell loop.

### 5.2 Potions

- **Price.** HP/MP Herb 60 (heals 120), Small 110 (220), Medium 200 (370), Large 400 (570), X-Large 600 (820). About 0.5–0.7 gold per HP.
- **Level 1.** A herb costs about 2 Mangyang kills of gold. A new character starts with 0 gold, but JG_001 pays 100 gold and 5 herbs, and levels 1–5 need almost no potions (§6). **Potions are affordable at level 1.**
- **Frugal play** at the best monster (§3) needs almost no potions. Against at-level monsters from level 14 on it drinks 0.2–0.6 HP potions per kill. At Bandit (16) and White Tiger (18) that is about 200 gold of potions per kill, more than the kill drops.
- **Potion-fed play** drinks 0.4 (level 3) to 2.9 (level 18) potions per kill. Most of it is MP for the imbue (52–149 MP every 5 s).

Potion-fed, per hour:

| Levels | Gold/h | Items/h | Potions/h | GOLD_RATE that breaks even |
|---|---|---|---|---|
| 1–7 | 8,500–27,000 | 2,000–6,000 | 6,600–24,000 | ≤ 0.8 (already affordable) |
| 8–15 | 26,000–32,000 | 5,700–7,700 | 50,000–73,000 | 1.5–2.1 |
| 16–19 | 27,000–35,000 | 9,000–10,700 | 125,000–173,000 | 3.3–6.1 |

### 5.3 Gear prices vs income

- **Shop prices.** Degree 1: 310–990. Degree 2 (level 8–13): 1,000–4,500. Degree 3 (level 16–20): 5,250–17,000. The dearest usable pieces are the Mercury Gold Necklace (level 20, 16,250) and the degree-3 spear and glaive (17,000).
- **Above the cap.** The three degree-3 chests are level 21 and cost 22,750. `Shops` already hides goods above `LEVEL_CAP` (`shop.ts`), so nobody can buy an item they can never wear.
- **Best-in-slot cost.** Buying the best shop item for every slot where it beats the quest rewards costs **58,770 gold** over 1 → 20. It is spent at levels 1, 8, 10–12, 16–19. The questline pays **115,900 gold**.
- **Frugal totals.** Drops bring about 244,000 more, and the potion bill is near 0. The character ends at 20 with about 300,000 gold after all that gear, enough for a second weapon family or party potions.
- **Potion-fed totals.** Potions cost about 712,000 against about 241,000 of drops. That is about **415,000 short** at GOLD_RATE 1, and the gap is almost all at levels 16–19.
- **Quest gear alone** falls behind at level 16: Bandits kill a quest-geared character in half of the fights (§6). Buying the degree-3 weapon at 16 (15,250–17,000) fixes it, and the quest gold alone covers it.

## 6. Difficulty curve [model]

One fight from full HP against the level's own monster, shop gear, skills as SP allows (imbue included, no potions). "TTK" is time to kill, and the bracket is basic attacks only. "Damage" is the share of max HP lost. "Deaths" are per fight.

**Wave 8 re-run (monster skills, `MOB_SKILL_DAMAGE=relative`).** Monsters now swing their MSKILL rows (apps/server/src/mob-skills.ts): each swing picks a row by `aiChance`, waits out its wind-up, and the next swing comes after the longest of the row's cast + action, its cooldown and the monster's attack interval. In `relative` mode a monster's first row hits what its old basic attack hit; its other rows scale from there (a two-hit row splits the damage, a howl or heavy swing hits harder). The model (`sim.ts`, now with the rows; `--nomobskills` reproduces the wave-7A table exactly) gives the table below.
- **Unchanged:** levelling 1 → 20 still takes 28.0 h frugal and 6.2 h potion-fed (blade), 29.6 h / 6.2 h glaive; levels 1–15 move by at most a few points.
- **The level-8 Tomb Stone Ghost** does 50.9 damage per swing to a level-8 blade in shop gear, against 50.8 with the wave-7A basic attack (20,000 rolls each): the same, as MS-S intends.
- **Harder at 16 and 17:** the Bandit's ATTACK03 (flat 139–160, 133 %) hits about 2× its normal swing, and the Black Tiger's howl (flat 151–173, 200 %) about 3×. Damage per fight rises from 41 % to 52 % (Bandit, blade) and from 30 % to 43 % (Black Tiger); deaths stay about where they were (10 % Bandit, 0 % Black Tiger). `MOB_DAMAGE_RATE` (default 1) scales every monster hit if this is too much.
- Horses, durability, alchemy and Berserk are not in the model: +N gear and Berserk (×2 damage for 60 s) only make fights easier; durability costs a little gold (a broken Copper Sword repairs for 198).

| Lv | Monster (lv) | Player HP | TTK blade (basic only) | Damage blade | Deaths blade | TTK glaive | Damage glaive | Deaths glaive | Frugal: HP potions/kill | Potion-fed: potions/kill |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Mangyang (1) | 200 | 5.2 s (5.1 s) | 2 % | 0 % | 4.8 s | 2 % | 0 % | 0.00 | 0.04 |
| 2 | Small-Eyed Ghost (2) | 244 | 4.9 s (4.9 s) | 4 % | 0 % | 4.4 s | 4 % | 0 % | 0.00 | 0.09 |
| 3 | Big-Eyed Ghost (3) | 291 | 8.3 s (8.5 s) | 17 % | 0 % | 7.4 s | 15 % | 0 % | 0.04 | 0.47 |
| 4 | Old Weasel (4) | 339 | 9.0 s (8.9 s) | 16 % | 0 % | 7.7 s | 14 % | 0 % | 0.00 | 0.42 |
| 5 | Weasel (5) | 389 | 7.0 s (7.0 s) | 16 % | 0 % | 6.1 s | 14 % | 0 % | 0.03 | 0.50 |
| 6 | Water Ghost Slave (6) | 441 | 4.1 s (6.4 s) | 10 % | 0 % | 3.9 s | 10 % | 0 % | 0.00 | 0.37 |
| 7 | Water Ghost (7) | 495 | 3.7 s (9.3 s) | 8 % | 0 % | 4.0 s | 9 % | 0 % | 0.04 | 0.59 |
| 8 | Broken Stone Ghost (8) | 551 | 2.3 s (9.7 s) | 7 % | 0 % | 3.8 s | 13 % | 0 % | 0.01 | 0.71 |
| 9 | Stone Ghost (9) | 609 | 3.0 s (10.4 s) | 9 % | 0 % | 4.1 s | 10 % | 0 % | 0.00 | 0.96 |
| 10 | Yeoha (10) | 669 | 4.1 s (12.7 s) | 9 % | 0 % | 4.1 s | 9 % | 0 % | 0.02 | 1.12 |
| 11 | Bandit Subordinate (11) | 731 | 4.2 s (14.8 s) | 12 % | 0 % | 3.7 s | 10 % | 0 % | 0.01 | 0.79 |
| 12 | Bandit Archer (12) | 795 | 5.6 s (17.4 s) | 9 % | 0 % | 5.1 s | 7 % | 0 % | 0.01 | 0.83 |
| 13 | Young Tiger (13) | 862 | 6.2 s (17.5 s) | 16 % | 0 % | 5.9 s | 15 % | 0 % | 0.03 | 1.28 |
| 14 | Tiger (14) | 931 | 8.3 s (20.7 s) | 24 % | 0 % | 8.7 s | 26 % | 2.3 % | 0.19 | 1.66 |
| 15 | Bandit Bowman (15) | 1,002 | 8.7 s (29.0 s) | 13 % | 0 % | 7.6 s | 11 % | 0 % | 0.00 | 1.65 |
| **16** | **Bandit (16)** | 1,076 | 12.5 s (25.6 s) | **52 %** | **10 %** | 15.5 s | **61 %** | **10.3 %** | 0.49 | 2.40 |
| **17** | **Black Tiger (17)** | 1,153 | 11.1 s (23.3 s) | **43 %** | **0 %** | 11.6 s | **46 %** | **0 %** | 0.17 | 2.24 |
| **18** | **White Tiger (18)** | 1,232 | 20.8 s (37.8 s) | **57 %** | **11.3 %** | 19.3 s | **51 %** | **6.7 %** | 0.56 | 2.70 |
| 19 | Chakji Worker (19) | 1,313 | 22.4 s (45.1 s) | 43 % | 0 % | 20.8 s | 39 % | 0 % | 0.00 | 2.55 |
| 20 | Chakji Worker (19) | 1,398 | 19.9 s (41.9 s) | 30 % | 0 % | 17.9 s | 27 % | 0 % | 0.00 | 2.40 |

**The curve is flat and gentle from 1 to 15.** At-level kills take 3–9 s and cost 7–26 % HP. Skills start to matter at level 6 and triple the kill speed by level 10.

**Two spikes, both from retail data.**
- **Bandit (16):** 755 HP, 102–123 attack every 1.5 s, PD 51, and all 60 nests aggressive. It hits about 1.8× as hard per second as Bandit Bowman (15).
- **White Tiger (18):** 809 HP, 120–143 attack every 1.5 s, PD 55, aggressive.

The deaths in the table come from running out of MP mid-fight with the imbue on. With half an HP potion per kill (frugal), or MP potions, nobody dies. With quest gear only (degree-2 weapon at 16), a Bandit kills the character in about half the fights and costs 1.65 Large potions per kill. So **JG_021 "Storm the Stronghold" (kill 20 Bandits at 16) is the hardest solo step of the questline**: buy the degree-3 weapon first, or go as a party.

**Above your level** (death chance per fight from full HP, blade, shop gear):
- 1 level up: 0–12 %.
- 2 up: 0–25 % below level 10, 20–78 % from 13 on.
- 3 up: about 100 % from level 12 on (Bandit, Black Tiger, White Tiger, Chakji Worker).

The quests never ask for that. The level-difference miss (+2 % per level) and the defence scaling make 3 levels up a wall, which is the SRO feel.

## 7. Rates (`apps/server/src/config.ts`, documented in `apps/server/README.md` and `docs/DEPLOY.md`)

| Env | Default | Applied in | Multiplies | Not affected |
|---|---|---|---|---|
| `EXP_RATE` | 1 | `Gameplay.mobDied`, every share of a kill (solo and party) | kill EXP | quest EXP, dailies |
| `SP_RATE` | 1 | same place | kill SP-EXP | quest SP |
| `GOLD_RATE` | 1 | `rollDrops` | the dropped gold amount | quest gold, shop prices, sell prices |
| `DROP_RATE` | 1 | `rollDrops` | each item group's chance (at most 100 %) | gold, quest item drops (their objective's own chance) |

All four accept a number from 0 to 1000; anything else stops startup with a message naming the variable (`config.ts` `num`).

What a rate does to the model:
- **EXP_RATE r** divides the kills and grind hours by r. The quests still give 341,400 of the 1,124,480 EXP (30.4 %), because the level curve does not change.
- **SP_RATE** should equal EXP_RATE. SP comes from kills: EXP_RATE 3 alone leaves 1,226 SP at level 20 instead of 2,530, less than the P0 build's 1,930.
- **GOLD_RATE g** scales the gold part of income. The potion-fed break-even values are in §5.2.

| EXP / SP / GOLD / DROP | Frugal grind 1 → 20 | Potion-fed grind 1 → 20 | Potion-fed gold after shop gear | Frugal gold after shop gear |
|---|---|---|---|---|
| 1 / 1 / 1 / 1 (default, retail) | 28.0 h | 6.2 h | −415,000 | +301,000 |
| 2 / 2 / 2 / 1 | 14.0 h | 3.1 h | −85,000 | +274,000 |
| **3 / 3 / 3 / 2 (recommended)** | **9.3 h** | **2.1 h** | **+42,000** | **+283,000** |
| 5 / 5 / 5 / 2 | 5.6 h | 1.2 h | +123,000 | +269,000 |

Add about 3 h of questline walking and talking to every row. **Recommended for the friends server: `EXP_RATE=3 SP_RATE=3 GOLD_RATE=3 DROP_RATE=2`.**
- A real player mixes the two styles, so level 20 takes about 6–10 hours with the full story: a few evenings.
- The SP curve of §4 is unchanged.
- Potion-fed play stops losing money.
- The questline's 30 % share and its level gating are unchanged.
- Equipment drops rise from about 1 in 100 kills to about 1 in 50.

Beyond 5×, the questline walking (3 h) is most of the game, and levels 16–19 pass in under an hour each.

## 8. Broken-spot check and fixes

| Check | Result |
|---|---|
| A level band with no suitable monster reachable on foot | **None.** Every level 1–19 has a live, reachable monster type (§2). The 91 unreachable nests (west of the river, no ferry) hold Western China monsters of levels 21–30, the level-20 Chakji and 14 of the 22 Chakji Worker nests. Level 19 is therefore thin (8 nests, 80 monsters) but playable. |
| A quest whose monsters are far above its level | **None.** Every objective monster is at most 3 levels above its quest (the content checker enforces it: `apps/server/test/quests-check.ts`, `quests-content-check.test.ts`). The unique finale is party content by design. The dailies JG_R01 (Weasel 5 in 1–9) and JG_R03 (Bandit 16 in 11–20) accept lower monsters too. |
| An item nobody can afford | **None.** The dearest usable shop item is 17,000, against 115,900 quest gold. Level-21 chests are hidden by `Shops` (reqLevel ≤ LEVEL_CAP). |
| Potions too expensive for a level-1 economy | **No.** A herb costs 2 Mangyang kills of gold. JG_001 gives 5 herbs and 100 gold, and levels 1–5 need almost no potions. |
| A monster that cannot be killed without dying at its level | **Tomb Stone Ghost (8) and Tomb Stone (9) were the opposite: harmless** (bug 1 below). Bandit (16) and White Tiger (18) are spikes but killable with about 0.5 HP potions per kill (§6). The field Tiger Girl (level 20 unique, aggressive) is a world boss from wave 11, tuned for a party of 4 level-20 players and closed to a solo player by the fury (§8.1). |

**Bug 1, fixed: monsters with only a magical attack did 1 damage.**
- Tomb Stone Ghost and Tomb Stone have `physAttack` [0, 0] and `magAttack` 74–83 / 84–94 in `mobs.json`. Their only attack is a 10 m force skill.
- `Gameplay.attack` rolled every monster swing as a physical hit, so their attack power was 0 and every hit landed on the pipeline's 1-damage floor (step 9 of `damageRoll`). They could not hurt anyone, and JG_013 / JG_014 at the tombs were free.
- Fix: `formulas.ts` `attacksMagically(stats)` (no physical attack, some magical attack). `Gameplay.attack` rolls those swings with `magic: true`, magic attack against magic defence.
- After the fix they take 7–10 % of an at-level character's HP per kill, in line with their physical neighbours.
- Regression test: `apps/server/test/balance.test.ts`.

**Bug 2, fixed: magical damage used the STR balance.**
- The research report §4.5 gives physical balance from STR and magical balance from INT, both `stat / (4L + 28)`. `damageRoll` multiplied every hit, magical ones too, by the STR ratio.
- The result: an all-STR character's imbue hit about 2.4× too hard at level 20 (0.89 instead of 0.36), and an INT force build's spells were crushed.
- Fix: `CombatStats.magBalance` (players: INT ratio; absent = `balance`, so monsters and old callers are unchanged), used for magical hits and imbues.
- Effect on the model: potion-fed blade grinding went from 5.3 h to 6.2 h. Frugal play (no imbue) is unchanged.
- Tests: `balance.test.ts`, "magical damage uses the INT balance".

**Knob fix:** `GOLD_RATE` existed in `config.ts` but nothing read it. It is now applied in `rollDrops`, beside the new `DROP_RATE`, and `EXP_RATE`/`SP_RATE` in `mobDied`. Tests: `balance.test.ts`, "rate knobs".

### 8.1 The Tiger Girl world boss (wave 11) [model]

The target (docs/UNIQUES.md §3.6, §4): **a party of 4 level-20 friends kills her in about 4.5–6 minutes, and a solo player is stopped by the fury.** The model (`pnpm tsx work/tmp/balance/sim.ts --boss`, 200 fights per row; the tables are in `work/tmp/balance/boss-spec.txt` and `boss-rec.txt`) runs the fight as the server does:
- **Her:** the `unique` variant with `content/uniques.json`'s `tuning`, her MSKILL rows picked by `aiChance` (71 / 21 / 7 %) with their wind-ups and cooldowns, `MOB_SKILL_DAMAGE=relative` times `Mob.damageMul`. ATTACK01 hits whoever holds her, ATTACK02 also each other player with a 50 % chance (melee players around her 4 m circle), ATTACK03 is the 15 m magic curse (the `zombie` status has no effect yet and is left out).
- **The summons:** the 80 / 60 / 40 % bands, each clipped to 2 normal adds (4 alive at most). The clip fills from the row's first group, so every wave is **2 White Tigers (level 18)**: 6 adds per fight.
- **Enrage and fury:** enrage ×1.25 once at 20 % HP; the fury ×`damageMul` from `afterSec` after the first hit. Both together multiply (an assumption about U-S's `damageMul`).
- **The party:** level-20 blades and glaives in shop gear with the §4 SP plan (2,530 SP). Skills and the imbue, a Large HP potion below 50 % HP and a Large MP potion when a skill is short of MP, each on its 1 s cooldown. Player 0 holds her, the others kill the adds first, and a solo player kills the adds first.
- **Uptime:** "ideal" is a perfect rotation with no walking. Real play loses time to positioning, target swaps and lag, so every group is also run at **70 % uptime**, the planning number.

**With the spec's tuning (`hpMul` 0.08 = 47,898 HP, fury ×2) the fight misses both targets:**
- 4 × 20 kills her in **2.2 min** ideal and 3.2 min at 70 % uptime: too short.
- A solo blade or glaive kills her in **8.4–9.2 min, before the fury**, in 99–100 % of fights, with about 40 Large HP potions.
- More HP alone is not enough: at `hpMul` 0.16 with the fury at ×2, 4–27 % of solo players still win in 16–17 min by drinking about 100 HP potions. ×2 turns her ≈ 44 HP/s on the tank into about 90, far less than a 570 HP potion every second can heal, and her biggest swing (about 500) rarely beats the 50 % potion line.

**Recommended tuning [decision, U-BAL]: `hpMul` 0.16 (95,795 HP) and `fury.damageMul` 3** (fury still at 600 s; `attackMul` 1, enrage, summons and rewards as in UNIQUES §5.3). Both are knobs in `content/uniques.json` (U-S's file).

| Group (level 20) | Ideal | 70 % uptime | 70 % + Berserk | Against the fury (10 min) | Deaths | Tank HP/s | HP / MP potions, whole party (70 %) |
|---|---|---|---|---|---|---|---|
| **4 players** | 4.1 min | **6.0 min** | 4.9 min | never met (50 % uptime: 8.4 min) | 0.01 | 41 | 39 / 146 |
| 3 players | 5.6 min | 8.0 min | 7.0 min | never met | 0.01 | 42 | 48 / 144 |
| 2 players | 8.3 min | wiped at 10.4 min | 4 % win | **at the edge**: a perfect duo finishes before it, a real one does not | 2.0 at 70 % | 44 | — |
| **1 player** | wiped at 10.4–10.5 min | wiped | wiped | **stopped**: 0 % wins in every variant, dead about 25 s after the fury with 35–58 % of her HP left | 1.0 | 46 | — |

- **The fury is what stops a solo player.** Without it the solo player wins in 16–17 min with about 75 HP and 130 MP potions (97–98 %). With it at ×3 her swings on a level-20 player average 260 (ATTACK01), 730 (ATTACK02) and 850 (ATTACK03), against 86 / 243 / 285 before it, and the 50 % potion line is not enough. A 100-potion budget or Berserk changes nothing.
- **A party of 4 never sees the fury**, even at 50 % uptime (8.4 min). Her damage on the tank is 41–46 HP/s, about 25 Large HP potions for the tank over 6 min. With ATTACK02 hitting everyone around her, the party's HP potions go from 26 to 37 (ideal), and nobody dies.
- **The fight needs MP potions.** About 37 Large MP potions each at 70 % uptime, about 18,500 gold of potions per player per kill with the HP ones. A party of 4 that saves its MP falls to about 103 damage/s on basic attacks and is wiped by the fury at 11.8 min. That is the SRO boss feel, and the kill pays it back: about 146,600 EXP each and the loot of UNIQUES §4.4.
- **The bell finale (JG_025: `hpMul` 0.05, attack ×0.8, no summons, no fury)** takes 1.3 min ideal and 1.8 min at 70 % for 4 level-19 players in this model. That is shorter than §3's "about 3 minutes", an older estimate made before this fight model existed. It is left as it is: it is a private, smaller encounter.
- **Before the friends' first kill, the model is the only measurement.** That kill (UNIQUES §12) is the check, and `hpMul` is the knob: time to kill scales with it linearly.

## 9. Observations left as they are (for the owner)

- **No EXP penalty for monsters below your level.** The best EXP per hour is 2–3 levels below from level 8 on (§3). Retail-like and harmless for a friends server.
- **Regeneration is slow.** 3 % per 2 s after 5 s out of combat (`REGEN`, a server rule, not retail), so frugal play sits 65–80 % of the time. The rates shorten the total, and the potion price is the other lever.
- **The field Tiger Girl roams the level 16–19 grounds.** From wave 11 she is a world boss: one at a time, respawn 3–6 h, announced to the whole server, aggressive, sight 14 m, leash 50 m. Players below the party band who meet her will die (her swings alone hit a level-20 player for 86–285). Leave her (retail flavour), or step back past the leash: she resets to full HP.
- **The boss fight's potion bill** is about 18,500 gold per player per kill at 70 % uptime (≈ 10 Large HP and 37 Large MP potions; the tank ≈ 25 HP). That is a lot at `GOLD_RATE` 1 and fine at the recommended 3; the kill's EXP and loot pay it back (§8.1). If the friends find it too dear, lower `hpMul`, not the fury.
- **The model is optimistic about damage.** It assumes everyone is in melee range at all times, which is why §8.1 plans on 70 % uptime. The first party kill with the friends replaces these numbers.
- **Giants (`GIANT_PCT` 1).** About 1 in 100 nest monsters is a giant: × 20 HP, × 2 attack, × 10 EXP. Near level 16–18 they are party targets.
