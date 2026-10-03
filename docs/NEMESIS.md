# Nemesis monsters (wave 14, The Climb)

The user, verbatim (wave 14):

> Nemesis monsters: a monster that kills a player levels up, gets a name and a title ('Mangyang the Pixi-Slayer'),
> and comes back stronger with better loot. Revenge becomes personal.

The same wave re-tunes levels 1–20 (docs/CLIMB.md), adds the Qin-Shi Tomb group dungeon (docs/TOMB_DUNGEON.md), the
storm Qilin (docs/STORM_QILIN.md) and the user's death penalty (rule #13: from level 15 a death to a monster costs a
random 1–20 % of the current level's EXP bar; CLIMB owns it). WAVE_PLAN10 merges the four specs.

**What this spec builds.** When a field monster kills a player (level 3 or more, who fought back), **it becomes that
player's nemesis** (the user's words; the caps below are the limiter, fact-check F1). It gloats, slips away, and
**comes back 20–40 minutes later** near the place it won. It returns one rank stronger than its kind, with a name plate
such as **"Mangyang the Pixi-Slayer"**, a larger body, a red glow, and its own loot. It is **persisted** (restarts keep
it), roams a 25 m circle around its victory spot, and anyone can hunt it. **Its victim's group gets the personal
reward**: **half** of the EXP the death penalty took on deaths to it comes back to the victim (**"you took back 620
EXP"**; F4), and the kill is announced. It **grows** when it kills an account it has never killed before (up to rank V,
which needs a party of four; F2) or when it is left unavenged (one rank per 48 hours, up to rank III). It **retires**
after 7 days without a kill, or when all its victims are 8 levels past it. Caps: **one living nemesis per account** (as
its first victim), a **2-hour online cooldown** after yours ends, **2 per area, 8 in the world**. Victims and their
party and guild get the notices. Victims also get a **"your nemesis is near"** hint and a minimap marker within 120 m.
From rank III ("Notorious") the whole server hears about it.

**Fact-checked** 2026-10-02 ≈ 10:20–11:00 UTC by a second agent: every [confirmed] claim was re-derived, the week
model was re-run on CLIMB's draft death rates, and the fixes are listed in §18 (F1–F26). The biggest: with CLIMB's
draft deaths (≈ 0.1 per hour, almost all at level 14+), the first draft's 30 % roll gave the live server **one
nemesis every ~2 weeks**, so the roll is now 100 % (F1).

**The user delegated every decision.** Each choice below is the option this spec would mark "(Recommended)". Each is
written as a decision with a one-line reason (§12). Only what truly needs the user is in §13 and §14, each with the
default used meanwhile. **Delegation is not a deploy OK.**

**Tags** (as in WAVE_PLAN8/9):

- **[confirmed]**: checked in the code or data of the working tree on 2026-10-02, or measured by this spec's scripts.
  Each one says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived), not measured on that setup.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this spec makes. The user may overrule it.

**Repo state when this was written** [confirmed: `git log -1`, `git status`, 2026-10-02 ≈ 10:00–10:30 UTC]: HEAD
`2b7450b` ("Wave 12 step 0: seams …"). The wave-12 build is editing the working tree (45 changed paths). This spec
edits none of it. Its scratch is `work/tmp/nemesis/` (Appendix).

**Sources read:** docs/WAVE_PLAN9.md (the format, §11 hooks for wave 14), BALANCE.md, UNIQUES.md, SYSTEMS_COMBAT.md,
SKILLS.md, QUESTS.md, FIELDS.md, PLAYTEST.md, HOT_SPRINGS.md and FISHING.md (S-REWARD, `restEligible` /
`mealEligible`, D36), PETS_SOCIAL.md (friends list, not built), EFFECTS.md, UI.md, BACKLOG.md. Code:
`apps/server/src/{gameplay, uniques, spawner, modules, ai, formulas, world, db, party, config, gm}.ts`,
`social/guild.ts`, `packages/shared/src/protocol.ts`, `apps/game/src/world/{entities, features/berserk}.ts`,
`apps/game/src/world/map/worldmap.ts`, `apps/viewer/src/fx/main.ts`. Data: `work/out/data/{mobs, items, skills,
levels, drops}.json`, `work/out/fx/index.json`, `work/out/world/jangan-fields/{manifest.json, worldmap.png}`,
`work/tmp/balance/live-nests.json` (the 700 live nests), `content/quests/jangan.json`. The CLIMB draft's bands
(`work/tmp/climb/design.ts`, read 10:20 UTC, still being written) [likely]. The fact-check also read docs/CLIMB.md,
docs/TOMB_DUNGEON.md and docs/STORM_QILIN.md, which appeared during it (§18 F22–F26).

---

## 0. Summary

- **Rules (§2):**
  - **Who can become a nemesis.** A normal or champion monster of an open-world nest. Not uniques, mini-bosses,
    Tomb instance monsters, the Qilin, quest encounters, GM spawns or summoned adds.
  - **What death can make one.** The monster must land the killing hit while alive. The victim must be level 3 or
    more and must have dealt at least **10 % of its max HP** to it (or, when an add landed the blow, to the pack member
    they fought: F9). The spot must be outside the town circle and the springs' sanctuary. If other players are still
    fighting it, the grudge waits for that fight to end; if they kill it, nothing is born (F8).
  - **The roll and the caps.** **Every** eligible death (`chance` 1.0 in content; F1). Blocked when: the account
    already has a living nemesis as first victim; the account is in its **2 h online cooldown**; the area holds 2; the
    world holds 8.
  - **What happens next.** It ranks up to I, gloats (3 s), leaves (smoke), and comes back after 20–40 min near the
    spot (home = that spot, within 100 m of its birth spot; roam 25 m, leash 50 m).
  - **How it grows.** +1 rank per kill of an account it has **never** killed, up to **V** (F2). Unavenged, +1 rank per
    **48 h**, up to **III**.
  - **How it ends.** Slain (avenged or not). Retired after **7 days** without a player kill. Retired when every
    victim is 8+ levels above it. Retired when its first victim is deleted.
- **Power (§4)** [confirmed: `calibrate.ts`, 22 kinds × 5 ranks, 80 fights per point, the server's formulas]. Each
  monster kind gets its own rank tuning, so every rank means the same thing everywhere:
  - **I:** solo, about **4 HP potions**.
  - **II:** solo wins **~70 %** with 10 potions (calibration n = 80: 68 %, 55–90; re-measured at n = 400: **72 %,
    58–82**, F15); a duo is safe.
  - **III:** a duo, about 4 potions each; solo **0 %**.
  - **IV:** a duo wins **70 %** (n = 400: 69 %, 61–83), a trio is safe.
  - **V:** a trio wins **76 %** (n = 400: 78 %, 70–83), a party of four is safe.
  - The multipliers per rank (median): HP **×7.2 / ×11.4 / ×14.2 / ×19.8 / ×25.9**, attack
    **×1.77 / ×2.31 / ×2.65 / ×3.35 / ×4.12**, level +rank. (The calibration ran **unclamped**; the band-ceiling clamp
    and CLIMB's 7 Far Bank kinds are NM-B's to add, F10, F11.)
- **Rewards (§5).**
  - **EXP:** kill EXP × the rank's HP multiplier, capped at 10 % of a level per group member (CLIMB §3.5, F25), and
    outside Rested and meals (CLIMB D10, F24). A nemesis fight pays **1.1–1.4×** grinding the same kind, per minute
    and per player [confirmed: `econ.ts`, re-run identical]; **1.1–1.25×** with the cap [projected: `check/tenpct.py`].
  - **Loot:** 2–6 gold piles, 1–5 extra rolls of the kind's table, and a **band gear piece** (25 % at I … 100 % at V)
    with plus levels up to **+3**. Rank V also gets a **10 %** chance at a Seal-of-Star row: always below Tiger Girl's
    20 % and +3 (F3).
  - **Vengeance:** **half** of the EXP the death penalty took on deaths to it goes back to each victim who is in the
    killing group (F4). That group is the damage map or the loot-owner party, online.
  - **A deliberate farm loop** earns **about 1 % of the same 2 hours' grinding EXP** [confirmed: `econ.ts`, EXP only];
    feeding a nemesis to rank V takes ≥ 4 days and never outdrops Tiger Girl (§2.8 A13).
- **A week of play (§10)** [projected: `week.ts --climb=mix`, 300 simulated weeks per row, on CLIMB's **draft**
  death rates (`work/tmp/climb/out/climb.json`, 06:25 local); the first draft's own 1 death/h assumption is a row of
  §10.3]:

  | Players | Born per week | Alive on average | A rank III+ appears |
  |---|---|---|---|
  | 3 (the live accounts) | 1.5 | 0.12 | 1 % of weeks (16 % of months) |
  | 8 | 3.9 | 0.32 | 4 % of weeks |
  | 20 | 9.6 | 0.64 | 8 % of weeks |

  Most nemeses are avenged within the same evening or the next: median life **2–3 h**. Almost all are born at level
  14+, where CLIMB's deaths are (tigers, bandits, the Far Bank).
- **Cost.**
  - **Server** [confirmed: `cost.ts` re-run 3× on the dev PC; N100 ×2.5 [projected]]:
    - A birth, a kill or an end is one SQLite transaction of **33–48 µs** median (p99 0.4–2 ms: WAL checkpoints on a
      busy PC), on a few events per evening.
    - The near-hint pass is **0.9–1.6 µs** per 2 s for 20 players × 8 nemeses.
    - At most 8 extra monsters join the 6,083 in the world.
    - 2,000 nemesis rows take 652–672 KiB.
  - **Client** [projected]: no new asset.
    - The look reuses existing pieces: the kind's champion model (2 of CLIMB's Far Bank kinds have none: F11), a
      scale factor, two retail EFP loops (7 + 16 batches, seen in the fx viewer, §3.2), one more nameplate line and
      one minimap marker.
    - Gate: **+≤ 0.15 ms p95** with two nemeses on screen (LAB row, §11).
- **Wire (§8):** one optional `EntityState.nemesis` and one `nemesisNotice` message. **Persistence (§7.2):** one
  migration with three tables. **Lanes (§15):** NM-S (server, 3 d), NM-P (shared and content, 0.5 d), NM-C (client,
  2 d), NM-B (re-calibration on CLIMB's roster, 0.75 d), about 6.25 days.

### 0.1 Where each part of the request lands

| The request | Where |
|---|---|
| "a monster that kills a player levels up" | §2.1–2.3 (birth), §4 (ranks, levels clamped to the band ceiling) |
| "gets a name and a title ('Mangyang the Pixi-Slayer')" | §3.1 (the user's form exactly at ranks I–II; a given name from rank III) |
| "comes back stronger" | §2.3 (leaves, returns 20–40 min later near the spot), §2.4 (growth), §2.7 (restarts) |
| "with better loot" | §5.2 |
| "Revenge becomes personal" | §2.5 (vengeance and the EXP refund), §3.3 (notices to the victim and their friends), §3.4 (the near hint) |
| a visual tell (scale, aura, name colour) | §3.2 |
| persists, roams near where it won, hunted by friends, retires | §2.3, §2.5, §2.6, §7.2 |
| chance per kill, caps, growth, anti-grief, party vengeance, announcements, near hint | §2, §3.3, §3.4, §2.8 |
| data and migration, loot and EXP, death penalty, server and client cost | §7, §5, §6, §7.5, §9 |
| PROTOTYPE: a week of play (counts, power curve) | §10, `work/tmp/nemesis/` |

---

## 1. What exists to build on [confirmed: read in the code and data, 2026-10-02]

| Fact | Where | What it means here |
|---|---|---|
| `Gameplay.dealHits(a, target, …)` is the one path for basic attacks, skills, DoT ticks and mob swings; on a player kill it calls `playerDied(t, now)` **without the killer** | `gameplay.ts` 988–1013, 1129–1137 | Seam **S-DEATH** (§7.1): the cause must reach the modules. CLIMB's death penalty needs the same seam. |
| `playerDied` clears every mob's `target` that pointed at the player but keeps its `damage` map; a mob without a target goes home, and `goHome` clears the map | `gameplay.ts` 1129–1136, `ai.ts` `goHome` | The 10 % damage check reads `m.damage` inside the hook, before the AI's next think. |
| Kill rewards: `mobDied` → `party.killShares` or `soloShares` → `reward()` (EXP_RATE/SP_RATE) → `uniques.drops(m)` may replace the loot → hook `mobDied(m, now, credit, owner)` with `KillOwner {player, party, damage}` | `gameplay.ts` 1023–1074, `modules.ts` 36–40, 102–107 | The nemesis module plugs into the **same loot seam** as uniques (a `drops(m)` provider) and reads the kill's group from `KillOwner`. |
| `createMob(def, variant, x, z, y, nest, now, surface, tuning)`; `MobTuning {hpMul, attackMul, expMul}`; `killExp` = `def.exp × variant × tuning.expMul` | `gameplay.ts` 500–545, `world.ts` 167–172 | Rank power = MobTuning (no new combat code). The level offset needs `Mob.level` + `combat.level` set after creation (one line, §7.1). |
| `mobCombatStats(def, variant, attackMul)` puts `def.level` into `combat.level`. The level difference gives +3 % damage per level (max 30 %) and +2 % miss per level | `formulas.ts` 76–79, 200–220, 238–243 | A nemesis's +rank levels count in combat. The calibration includes them. |
| Uniques: a module with its own rng, a persisted row (`uniques`, migration 10), restart rules, `uniqueHome(camp)`, `nestSpawnPoint`, notices to all players except quiet GMs, `/unique` GM verbs, its own drop table via `rollUniqueDrops` and `gearPool` | `uniques.ts` | The **template** for the nemesis module: same shape, same seams, reused helpers (`gearPool`, `rollUniqueDrops`, `hmm`, the quiet flag). |
| Spawner: `died(id)` schedules a nest's replacement; `forget(id)` drops a mob **without** one | `spawner.ts` 199–232 | A promoted mob leaves its nest. The nest must still get its replacement: new `Spawner.release(id, now)` = `died` without the corpse (§7.1). |
| Mob `EntityState` is built once for every viewer (`world.ts` 640–645): name, model, level, variant | `world.ts` | No per-viewer state. "Is this my nemesis?" goes in a **victim name list** on the state (§8). |
| The client label shows `name`, `Lv`, "(Champion)" for a variant, a level-band colour, and a `.unique` class | `apps/game/src/world/entities.ts` 276–316 | A `.nemesis` class and a subtitle line (§9). |
| Every field kind of jangan-fields has a `championModel` except the two Tomb kinds | `mobs.json` (22 kinds in live nests) | The nemesis wears the champion model (§3.2). |
| Retail EFP keep loops exist and play in the fx viewer: `system/system_hwan_keep.efp` (22 nodes, 7 batches), `monster/god/skill_flame_crazy_keep_body.efp` (30 nodes, 16 batches) | `work/out/fx/index.json`; the fx viewer `apps/viewer/fx.html`, private vite on :5391, read from its stats panel | The aura (§3.2). No new art. |
| Party and guild exist (party chat, guild chat, online members); **no friends list** (PETS_SOCIAL is designed, not built: no `friends` table in `db.ts`) | `party.ts`, `social/guild.ts`, `db.ts`, BACKLOG | "Friends" = party + guild now, plus the friends list when it lands (a seam, §7.1). |
| **No PvP**: attacking a player is refused (`invalid_target`, "no PvP") | `gameplay.ts` 796, `skills/engine.ts` 310 | "Never duels or the arena" holds by construction; the S-DEATH cause still says `player` for when it comes. |
| Schema 10 now; wave 13 takes migrations 11–13 | `db.ts`, WAVE_PLAN9 D5 | This spec's migration is the next number WAVE_PLAN10 assigns (§7.2). |
| WAVE_PLAN9 §11 leaves for wave 14: the S-REWARD kill-EXP order, `restEligible(mob)` / `mealEligible(p, mob)`, the death penalty takes EXP from the bar only (D36), the springs' **sanctuary polygon** | WAVE_PLAN9 | Nemesis kills are eligible for Rested and meals (§5.1). No birth inside the sanctuary (§2.1). |
| 11 areas with live nests (Grassland 80 nests … Jangan Ferry 13); the nearest nest centre is 269 m from the town spawn, none overlaps the 200 m circle | `live-nests.json` by `zone`, `dist` − `radius` (fact-check) | The per-area cap counts the client's area name at the home point (`GameData.zoneName`). The town rule costs no field death today. |
| **CLIMB's draft death rates** (the mixed solo/party profile): ≈ **3.3 deaths in the whole 40 h climb**, ≈ 0.1 per hunting hour, almost all at level 14+ (0.1 deaths in levels 1–13); solo players 9.5 | `work/tmp/climb/out/climb.json` `mc.mix.deathsAt` / `perLevel` (re-generated 10:36 UTC with the same numbers); docs/CLIMB.md §6.4 (written during the fact-check: "the mix friend dies 3.3 times on the whole climb") [confirmed: both] | Births follow deaths: the first draft's 1 death/h assumption was ~10× CLIMB's. F1. |
| CLIMB's draft also adds band **B7, the Far Bank** (17–20): 7 kinds from Chakji and Western China rows (Ghost Bug, Devil Bug, Powder Ghost, Hyungno ×2); `MOB_WC_HYUNGNO` and `MOB_WC_HYUNGNO_CLON` have **no** `championModel`; mini-boss MB1 is "**Old Scar**, the Weasel King" | `work/tmp/climb/design.ts`; `mobs.json` | The calibration's 22 kinds miss them (F11); the name pools must not reuse a mini-boss's name (F12). |
| CLIMB's draft kill-EXP rule: a monster above you gives +5 % per level (max +15 %), two or more below you −15 % per level (floor 10 %) | `design.ts` `levelDiffExp` | A nemesis's +rank levels add up to +15 % EXP on top of §5.1 [projected]. |
| The Tomb's instances are **slots in the same world** (far-apart areas ≥ 400 m on the one navmesh), not separate worlds | `work/tmp/tomb/instance-cost.ts` header; docs/TOMB_DUNGEON.md §2 and §3.6 (6 slots, a shared navmesh, `Mob.instance?: number`) [confirmed] | "Not a Tomb instance" cannot be a world check: the Tomb module must flag its monsters (S-ELIG, F6). |
| `Uniques.tracked(m)` is **private**; there is no `isTracked` | `uniques.ts` | S-ELIG adds a public `isTracked(m)` (one line). F7. |
| `content reload` takes only `nests | npcs | quests | all`; uniques.json is read at start only | `editors/live.ts` `CONTENT_USAGE` | No live reload of `content/nemesis.json` either (§7.3, F16). |
| The server ticks at **10 Hz** (`TICK_HZ` 10: a 100 ms budget) | `config.ts` | §7.5's ratio. |
| No drowning, no death by water (SWIMMING SW-D18); a monster never acquires a swimmer and a mob shot across water evades (SW-D23) | SWIMMING.md | A swimmer can drop a nemesis's aggro like any leash; it returns home and regenerates (today's rule). |

---

## 2. The rules

### 2.1 Who can become a nemesis, and from which deaths [decision]

A player's death creates a nemesis only if **all** of these hold. The checks are server-side, in the `playerDied`
hook, with the cause (S-DEATH):

1. **The cause is a monster's hit** (S-DEATH's `killer` is a Mob), landed by a monster that is **alive** at that moment.
   A DoT tick from a monster counts as that monster. A GM `/kill`, a fall (none exists yet) or anything else does not;
   drowning never kills (SWIMMING SW-D18).
2. **The monster can be one:**
   - it belongs to an open-world nest (`m.nest` set and tracked by the Spawner);
   - it is **not a Tomb instance monster**. The Tomb's instances are slots in the same world [confirmed: TOMB_DUNGEON §2, F6], so this is
     the Tomb's `Mob.instance` (its slot id, TOMB_DUNGEON S-HOOK, §3.6), never a world or area check;
   - it is the `normal` or `champion` variant;
   - its MobDef rarity is `normal`;
   - it is not already a nemesis (that is §2.4);
   - it carries no event or encounter flag (the Qilin, quest encounters, summoned or called adds, uniques, CLIMB's
     mini-bosses and elite camps).
3. **The victim:**
   - is level **3** or more (the first 15 minutes are grudge-free);
   - is not a GM in invisible mode;
   - **dealt at least 10 % of the killer's max HP** to it (`m.damage.get(p.id) ≥ 0.1 × m.maxHp`). Standing still and
     dying makes no nemesis.
   - **The pack rule** (F9): when the killer fails that check (an add finished you), the grudge goes to the monster of
     the same fight the victim hurt most, if that one passes the check, is alive, eligible, and within 20 m. CLIMB's
     draft hunts in packs (`roles: ['pack']` on most kinds), so "an add landed the blow" is a common death, and
     "the pack that beat you" is still the story. The title and the lines name that monster.
4. **The place:**
   - the killer stands more than **200 m from the town spawn** (`setup.spawn`);
   - it is outside every sanctuary polygon (HOT_SPRINGS' springs);
   - its spot places on the navmesh within 15 m (`nav.place`). Otherwise the death counts for nothing.
5. **The caps** (§2.2) allow it.
6. **Nobody else is still fighting it** (F8). If another living player is in its damage map and within its leash
   when the victim falls, the grudge is **pending**: it is decided when that fight ends without the monster's death
   (it goes home, or 60 s pass with no living attacker). If the others kill it, the victim was avenged on the spot and
   no nemesis is born. Without this rule a friend's fight would end with the monster vanishing in smoke mid-swing,
   taking their damage (and EXP share) with it.

Then the content's `chance` roll (default **1.0**, F1) on the module's own random stream (as uniques.ts does, so
loading it never shifts the gameplay stream).

| Decision | Reason |
|---|---|
| Level ≥ 3, not 5 | The user's own example is a Mangyang (level 1–2). A first grudge at level 3–4 is a good early goal: rank I is calibrated to be beatable solo with the 5 starter herbs plus a few more. Under CLIMB's draft, deaths below level 14 are rare (0.1 in the whole 1–13 stretch), so most grudges come at 14+ [projected]. |
| 10 % of its HP, with the pack rule | Anti-farm (§2.8). It also keeps the story true: you fought it and lost. The pack rule keeps add deaths in. |
| Chance **1.0** (every eligible death), was 0.3 | The user's words ("a monster that kills a player levels up"). With CLIMB's draft deaths the 0.3 roll gave the 3 live accounts **0.44 births a week**; 1.0 gives **1.5** (≈ 8 a month), and when deaths run high (the first draft's 1/h) the per-account cap and cooldown bind: 7.2 a week at 3 players [projected: `week.ts`, §10.3]. |
| Pending while others fight | A party's fight is never cut short by a smoke exit; a friend who finishes the killer on the spot already avenged you. |

### 2.2 Caps [decision]

| Cap | Value | Effect when hit |
|---|---|---|
| Per account (as first victim) | **1 living nemesis** (`away` or `alive`) | No birth. Being killed again by your own nemesis is §2.4, not a birth. |
| Per account cooldown | **2 h of that account's online time** after its nemesis ends (slain, retired) | No birth. The online clock counts only in-world time, so logging out does not run it. |
| Per area | **2** (`away` + `alive`, by the area name at the home) | No birth. |
| World | **8** | No birth. |
| Repeat kills | A kill of an account it has **already killed** (ever, in its life) never raises its rank (F2; was "in the last 24 h") | Still recorded (EXP for the refund, the death count). |

Per account, not per character, because alts must not open a second grudge. The live server has 3 accounts. The caps
only make sense if they bind on 20. In `week.ts` on CLIMB's draft deaths they blocked 0.15 + 0.15 births per week at 3
players and 0.9 + 0.9 + 0.2 at 20; on the first draft's 1 death/h at 3 players, 6.4 + 5.5 [projected: §10.2, §10.3].

### 2.3 The moment, and "comes back" [decision]

1. **The kill.** The killing monster plays its retail victory clip if it has one (otherwise STAND), for **3 s**. The
   victim's death screen shows CLIMB's loss line, plus "**Mangyang is now your nemesis. It will be back.**".
2. **It leaves.** After the 3 s, a smoke burst (`dun/fire_down_smoke_02.efp` [likely; the lane picks it in the fx
   viewer]), and the entity is removed. State `away`. The nest gets its replacement through `Spawner.release`.
3. **It comes back** after **20–40 min** (uniform), at its **home** (the death spot placed on the navmesh), with:
   - full HP;
   - its rank tuning;
   - roam **25 m**, leash **50 m**, sight 14 m (as Tiger Girl's camp rule `uniqueHome`);
   - **aggressive** at rank III+ (ranks I–II keep their kind's choice).
   Its victims, their party and their guild get "**Mangyang the Pixi-Slayer has returned to the Hill of Ye Mt.**".
4. **Every later player kill** repeats 1–3: it gloats, leaves, and comes back 20–40 min later, at the spot of that
   kill (its home moves with its victories), with two limits (F21):
   - a kill while other players still fight it waits for that fight to end (§2.1 rule 6);
   - the home moves only if the new spot is **within 100 m of its birth spot, in the same area**, and outside the
     town circle and the sanctuary; otherwise it keeps its home. Without this, kills at the leash edge walk an
     aggressive rank III+ nemesis 50 m at a time into a lower band's fields, where new players feed it ranks.

| Decision | Reason |
|---|---|
| It leaves and comes back, instead of staying on the corpse | Without it, the victim walks back from town in 2–4 minutes and kills a rank-I monster still at the spot. That is a corpse run, not revenge. The wait builds anticipation, gives time to call friends, and is the user's "comes back". |
| 20–40 min | A friends' evening is 1–3 h (`week.ts` schedule), so it returns in the same session. `week.ts` with 30–90 min left more nemeses for "tomorrow" (median life 20 h vs 4.5 h, the first draft's runs) and fewer same-evening revenges. |
| Home = the latest victory spot within 100 m of its birth, roam 25 m | "Roams near where it won". The 50 m leash and the 100 m drift limit stop anyone from walking it to town or into another band. |

### 2.4 Growth [decision]

- **By kills.** Each player kill by a nemesis:
  - **+1 rank** (max **V**) unless it has **ever** killed that **account** before (F2);
  - adds the player as a victim (they get the refund and the notices too);
  - sets `last_kill_at`, the home and the return timer (§2.3).
  - Its **title keeps naming the first victim**. A second victim of another nemesis keeps their own grudge: the
    per-account birth cap only counts nemeses born from you.
- **By time.** Unavenged and alive, it gains **+1 rank every 48 h** since its last rank change, up to **III**. Kills
  can take it above III; time cannot.
- **Level.** `level = min(kind level + rank, band ceiling, LEVEL_CAP)`.
  - The band ceiling comes from CLIMB's bands. Draft: B1 5, B2 10, B3 13, B4 15, B5 18, B7 20 [likely].
  - Fallback: the highest normal level among the live nests of its area.
- **Rank names.** I–II "Grudge", III–IV "Notorious", V "Dread".

Why the repeat rule: a victim can't feed their own nemesis to rank V for its loot (§2.8). Why "ever" and not "in the
last 24 h" (F2): with a 24 h window the 3 live accounts reach III in an hour (A, B, C) and **V the next evening** (A
and B again), which made rank V a one-day loot farm at 25 % Seal of Star. With "ever", 3 accounts reach III by kills;
IV and V need a 4th or 5th account, or 96 h of time growth to III plus two more accounts (§2.8 A3, A13). Why time
growth: on a 3-account server, a second kill is rare: 0.09 rank-ups a week at 3 players, 1.0 a month [projected:
`week.ts --climb=mix`, §10.2]. An ignored grudge should get worse, and the user said "comes back stronger".

### 2.5 Hunting it: vengeance [decision]

- **Anyone can fight it.** It is a world monster: normal targeting, normal loot ownership (`killShares` /
  `soloShares`).
- **Vengeance.** On its death, the module takes the **killing group**. That is every player in its damage map who is
  in the world, plus every online member of the loot-owner party (`KillOwner.party`), so a victim who died in the
  fight still counts. Each victim in that group:
  - gets back **half of the EXP the death penalty took on deaths to this nemesis** (`refund` 0.5 × `exp_lost`, F4).
    It is paid through `reward()` **outside** the S-REWARD list: not rated, no meal, Calm or Rested share, and it
    never drains the Rested pool. Line: **"You took back 620 EXP from Mangyang the Pixi-Slayer."**;
  - is marked `avenged`;
  - adds one to their lifetime **Avenger** count. There is no counter column: it is `COUNT(*)` of their
    `nemesis_victims` rows with `avenged = 1` (F17). The module emits `nemesisSlain {char, nemesis, rank}` on the module bus, and
    CLIMB's achievements module (CLIMB §7.3) turns it into the "Avenger" title.
- **Not in the group.** Victims who were not there are told "Mangyang the Pixi-Slayer was slain by Dayan's party."
  They get no refund.
- **Party vengeance** is the rule above: a victim's party can avenge them while the victim walks back from town.
- **Notices** (§3.3) name the group by its top-damage member, as Tiger Girl's defeat does.

| Decision | Reason |
|---|---|
| Refund **50 %** of what it took (was 100 %), not a bonus | "Revenge becomes personal": take back what it stole, but rule #13 is the user's rule. With every eligible death making a nemesis (F1), a full refund would hand back **42 %** of all the EXP rule #13 takes on the live server (0.10 of 0.24 h per player-week); half hands back **21 %** (0.26 of 1.22 h per player-month) [projected: `week.ts --refund=1` vs `0.5`]. Bounded by the loss, so there is no net-gain loop (§2.8). |
| Victim must be in the group | The refund rewards doing it, with friends or alone. A stranger's kill is still announced to the victim. |
| No reservation for the victim | A world monster on a friends' server. A lockout would need instancing or a per-player entity, out of scale for ~4 births a week. |

### 2.6 Ending [decision]

| End | When | Who is told |
|---|---|---|
| **Slain** | It dies to players (§2.5) | Victims, their party and guild; the server from rank III |
| **Retired: time** | 7 days (real time) after its last player kill | Victims, at once if online, else at their next login (`nemesis_victims.told_end`) |
| **Retired: outgrown** | Every victim's character is ≥ 8 levels above its level (checked hourly and at login) | Victims |
| **Retired: orphan** | Its first victim's character is deleted (soft delete) | Nobody else (its title names a gone character) |
| **GM** | `/nemesis kill`, `retire`, `clear` | Silent, audited |

A retired or slain nemesis's row stays (state, `ended_how`, `slain_by`): that is the history for titles and the
grudge book. The account cooldown (§2.2) starts at any end.

A **deleted** victim who is not the first (soft delete, `characters.deleted_at`) leaves the live `victims` list at
once and no longer counts for the outgrown rule. Character names are unique only among live characters
(`characters_name_live`), so a new "Pixi" could otherwise see "YOUR NEMESIS" on an old grudge (F18).

### 2.7 Restarts [decision]

- At start the module loads `away` and `alive` rows of the world. An `alive` row spawns at once at its home with full
  HP. An `away` row keeps its `back_at`; one that is overdue returns **2–5 min after boot** (no notice storm at
  start).
- The time rules run on wall-clock times stored in the rows: retirement, growth, return. A clock step back can't make
  a timer longer than its rule allows: each is clamped to its window, like uniques' H11-CU-2 rule.
- The kind or nest of a row is gone (CLIMB's re-level renames the kinds, `MOB_CL_*`)? The kind is mapped through
  the CLIMB migration table (old code → new code). An unmapped row retires with `ended_how = 'content'`.

### 2.8 Anti-grief and abuse cases (each one a server test) [decision]

| # | The abuse | The rule that stops it | Test |
|---|---|---|---|
| A1 | Die on purpose to a weak monster to farm nemesis loot | 10 % damage requirement, 1 per account, 2 h online cooldown, 20–40 min away: at most one rank-I nemesis per ~2.5 h of the account's play (the roll is now 1.0, so this is the bound, F1). Its EXP is **~1 % of the same time grinding** [confirmed: `econ.ts`, median over 22 kinds, max 1.7 %; EXP only]; its loot is 2 gold piles, 2 table rolls and a 25 % +0/+1 band piece, against ~2.5 h of normal drops [projected: arithmetic]. Below 15 the death is free, at 15+ half of it comes back: never a net gain | birth refused at < 10 %; second birth refused while one lives; refused during cooldown |
| A2 | Feed your own nemesis to rank V for its loot (the refund softens deaths) | A repeat kill of an account it has ever killed never ranks it up (F2); time growth stops at III | 4 deaths of one account leave it at rank I |
| A3 | Alt or friend accounts feed it | The rank needs a kill of an account it has never killed. The 3 live accounts reach **III** by kills (birth A, then B, C). IV–V need a 4th/5th account, or 96 h unavenged (time growth to III) and then B and C. Alts also count against the per-account cap. (The first draft's 24 h window let 3 accounts reach V the next day: F2.) | rank by distinct accounts, over the nemesis's life |
| A4 | Lure a nemesis into town or onto other players | Leash 50 m from its home; no birth within 200 m of the town spawn or in a sanctuary | birth refused near town; leash returns it |
| A5 | Camp the return spot to kill-steal someone's nemesis | Allowed (a world monster), but the refund is the victim's group's only; the victim is told who did it | refund only to the group |
| A6 | Spam notices by dying repeatedly | Notices go out on births, rank changes, returns, ends; repeat kills that don't rank up send only the victim's own line | notice count per repeat kill = 1 |
| A7 | Exploit the refund (net EXP gain) | Refund = half the recorded `exp_lost` on deaths to that nemesis, once, at its death; deaths below 15 (and CLIMB's 10-min grace deaths) record 0 | no refund without a recorded loss; one refund per row |
| A8 | Make the world full of nemeses so others can't level | Caps 2 per area, 8 per world; retirement 7 d; outgrown rule | caps |
| A9 | A GM makes one for a friend | `/nemesis spawn` is audited; a GM-spawned nemesis has `born_by_gm` and gives **no refund and no Avenger credit** | GM spawn flag |
| A10 | Drag it into the Tomb or the Qilin event; make a Tomb monster a nemesis | Tomb monsters carry `Mob.instance` (TOMB_DUNGEON §3.6; the instances are slots of the same world, F6) and never qualify; a field nemesis leashes at 50 m from a field home, and the slots are ≥ 400 m apart; a nemesis is never an event creature | Tomb-tagged killer makes nothing |
| A11 | Log out to stop the time growth or the cooldown | Growth runs on real time (logging out does not help); the cooldown counts online time (logging out does not help either) | — |
| A12 | Kill it with an invisible GM for the refund | An invisible GM's damage **is** recorded (`retaliate(…, notice = false)` only stops the mob turning on them), so the module drops `staff` accounts from the vengeance group and from the refund | GM excluded |
| A13 | Friends feed a nemesis to rank V on purpose for its loot | Takes ≥ 4 days of real time on 3 accounts (A3); rank V's prize is +1..+3 with a 10 % Seal of Star (F3). Three fed rank-V kills in 4 days give ~3 band pieces and 0.3 Seals; Tiger Girl, hunted at every 3–6 h spawn over those 4 days, gives ~63 degree-3 pieces and ~4 Seals [projected: arithmetic on content/uniques.json] | loot table caps (+3, rare only at V) |
| A14 | Walk a nemesis, kill by kill, into a lower band's fields to grief new players (who then feed it ranks) | The home moves only within 100 m of its birth spot and inside the same area (§2.3, F21); leash 50 m | a kill 150 m from the birth spot keeps the old home |
| A15 | Die to your own nemesis beside a Rebirth healer, get raised with the loss refunded, then avenge for half of it again | The record is the loss **net of** the resurrection refund (`penaltyRefunded`, F23) | raised with 100 % back: nothing to refund |

---

## 3. Names, the look, and the voice

### 3.1 The name and the title [decision]

- **Ranks I–II:** `<Kind> the <Victim>-<Verb>`, the user's form exactly: **"Mangyang the Pixi-Slayer"**.
- **Ranks III–V ("Notorious"):** it earns a **given name** from its family's pool, and the kind moves to the
  subtitle: **"Blackhorn the Pixi-Slayer"**, subtitle "Mangyang · Nemesis III".
- **The title always names the first victim**: that is whose grudge it is.
- **The verb and the name pool belong to the family** (content, `rules.ts` `FAMILIES`):

| Family (code prefixes; CLIMB's `MOB_CL_*` map through their retail base) | Verb | Given names (sample) |
|---|---|---|
| Mangyang | Slayer | Blackhorn, Old Ram, Bramblewool, Grinhoof |
| Ghosts (Big/Small-Eyed, Water Ghosts) | Haunter | Hollow-Eye, Weeping Lamp, Drowned Wen |
| Weasels | Biter | Quickfang, Old Red, Needletooth |
| Tomb and stone ghosts | Breaker | Gravefist, Cracked Jaw, Dust-Crown |
| Yeoha | Bane | Pale Silk, Withered Bloom, Lady Ash |
| Bandit archers and bowmen | Hunter | Long-Bow Liu, Red Feather, One-Eye Hu |
| Bandits | Robber | Red Scarf, Iron Knuckle Ma, Old Knife Zhao |
| Tigers (all) | Mauler | Scarstripe, Old One-Ear, Ashclaw, Snowmaw |
| Chakji | Crusher | Iron Back, Mud-Hands, Big Shovel |
| Bugs (CLIMB's Far Bank: Ghost Bug, Devil Bug) | Stinger | Hollowwing, Black Needle, Ashsting |
| Hyungno (Far Bank) | Reaver | Iron Mask, Grey Banner, Bone Drum |
| Powder ghosts (Far Bank) | Burner | Cinder, Short Fuse, Red Spark |
| any other | Slayer | Grudge, Nameless, Old Spite |

- **Determinism.** The name is a pure function of the row's `seed` (mulberry32, as `@sro/shared`), so a restart makes
  the same name [confirmed: `rules.ts` `nemesisName`, 0.3 µs a call, `cost.ts`].
- **Length.** Character names are ≤ 12 characters [confirmed: `CHARACTER_NAME` regex]. The longest given-name plate
  is **39 characters** ("Iron Knuckle Ma the Abcdefghijkl-Robber"); at ranks I–II the kind's name leads, and CLIMB's
  longer names reach **45** ("Hyungno Ghost Soldier the Abcdefghijkl-Reaver") [confirmed: `check/names.ts` over the
  pools]. Both fit the 48-code-point wire bound; NM-C wraps the plate to two lines past 32 characters.
- **No leading "the" in a given name** (F12): "the Weeping Lamp the Pixi-Haunter" reads twice. And **no name a
  mini-boss, unique or the Qilin already uses** ("Old Scar" is CLIMB's MB1, the Weasel King; "the Last Warden" sat
  next to MB4, "The Gate Warden"): NM-P's content check rejects a pool entry equal to any authored boss name.
- **English UI.** The verbs and names are English; the strings live in the content file, not the client bundle.

### 3.2 The visual tell [decision; costs §9]

| Tell | Rule | Source |
|---|---|---|
| **Model** | The kind's **champion model** (`MobDef.championModel`) when it has one (20 of 22 jangan kinds [confirmed: `mobs.json`]); otherwise the normal one | existing assets |
| **Scale** | ×**1.10 / 1.15 / 1.20 / 1.25 / 1.30** by rank (`RANKS.scale`), on top of `MobDef.scale`; the pick proxy and label height follow (`EntityView.scale`) | client only |
| **Aura, ranks I–II** | `system/system_hwan_keep.efp` looped on the body (the red rage glow; 22 nodes, **7 batches** [confirmed by the first draft: fx viewer stats; the file is in `fx/index.json`, the batch count was not re-measured]) | retail EFP |
| **Aura, ranks III–V** | plus `monster/god/skill_flame_crazy_keep_body.efp` at EFP scale **0.5** (a flame shroud; 30 nodes, **16 batches** at scale 1 [confirmed by the first draft: fx viewer stats; not re-measured]) | retail EFP |
| **Name colour** | `--nemesis` blood orange (#ff784a) for everyone; **crimson (#ff4646) with a "YOUR NEMESIS" tag** for its victims; overrides the level-band colour | CSS |
| **Rank pips** | five small diamonds under the subtitle (filled = rank) | CSS |
| **Sound** | the kind's own roar row on return, if it has one (as Tiger Girl's `roar`); a short sting for the near hint (an existing UI sound) | existing assets |

Attachment: retail monster skeletons differ. SystemFx's anchor rule is the named bone, **else the root** (the feet)
[confirmed: `world/fx/anchors.ts` `jointPoint(view, bone) ?? rootPoint(view)`; the first draft said "the root at
0.5 × height", which is only the hit-point rule `0.55 × height` of the same file, F19]. So for a skeleton without
`Bip01 Spine1` the nemesis feature passes an offset of 0.5 × height itself; the lane checks three kinds.

Why reuse the Berserk glow: it already reads as "in a rage" to every player [decision]. A Berserk player and a
nemesis never look alike, because one is a monster with a red nameplate. The flame shroud only appears at rank III+,
at most once or twice a week (§10).

Mockup of the plates and lines: `work/tmp/nemesis/nemesis-look.png`.

### 3.3 Announcements [decision]

All lines are `chat` (channel `system`, or `party` / `guild` as noted) plus a `nemesisNotice` (§8) the client turns
into a toast or banner. Quiet GMs (`/nemesis quiet on`) skip them, as with uniques.

| Event | To | Text (EN) |
|---|---|---|
| **born** | the victim | "Mangyang has become your nemesis: **Mangyang the Pixi-Slayer**. It slinks away… it will be back within the hour." (and the death-screen line) |
| born | the victim's party (`party` channel) and online guild members (`guild` channel); friends when PETS_SOCIAL lands | "Mangyang the Pixi-Slayer killed Pixi on the Hill of Ye Mt. Avenge them!" |
| **returned** | victims, their party and guild | "Mangyang the Pixi-Slayer has returned to the Hill of Ye Mt." |
| **grew** (kill or time) | victims (+ the new victim's party and guild) | "Mangyang the Pixi-Slayer grows stronger (Nemesis II)." |
| becomes **III+** | **everyone** (a banner like the unique notice, without the alarm) | "Blackhorn the Pixi-Slayer is now Notorious on the Hill of Ye Mt." |
| **slain** | victims, their party and guild; **everyone** from rank III | "Pixi took their revenge on Mangyang the Pixi-Slayer!" / "Mangyang the Pixi-Slayer was slain by Dayan's party." |
| **refund** | each avenging victim | "You took back 620 EXP from Mangyang the Pixi-Slayer." (half of what it took) |
| **retired** | victims (now or at login) | "Mangyang the Pixi-Slayer has left the Hill of Ye Mt. It was never avenged." / "…has faded: you have outgrown it." |
| **near** | the victim (§3.4) | "Your nemesis is near: Mangyang the Pixi-Slayer (north-east, ~90 m)." |
| login | a victim with a living grudge | "Your nemesis, Mangyang the Pixi-Slayer, lurks on the Hill of Ye Mt." (or "…is away and will return soon.") |

The volume is small: **2.7 births, rank-ups and ends per week at 3 players, 18 at 20** [projected: `week.ts
--climb=mix`, mean over 300 weeks; F20: this counts the events, not the lines. Each birth also brings one "returned"
line per return, and each event goes to the victims' party and guild channels as well, so the chat lines are about 3×
that].

### 3.4 "Your nemesis is near", the minimap, the grudge list [decision]

- **Near hint.** Every 2 s the module checks each online victim against their living nemeses (§7.5: 1.6 µs per pass).
  - **Entering 120 m** sends one `near` notice, with the compass direction and the distance rounded to 10 m, and a
    short sting.
  - Hysteresis: the next hint needs leaving **150 m** and **10 min** since the last one.
  - The radius is above the 14 m aggro range and the ~60 m nameplate distance, so it warns before you see it.
- **Minimap.** For the victim **and the victim's party**, a red claw marker at the nemesis's position while it is
  within 120 m of the viewer.
  - It is sent as the entity itself: the client already has the entity within its interest range. Beyond that,
    nothing is sent; there is no tracking across the map.
- **World map and character window.** A **"Grudges"** list, filled from `nemesisNotice` and the login line:
  - name, rank, **area** (never a position);
  - state: lurking / away;
  - the EXP it holds for you.
- **Why only the area.** "Hunted by friends" is a short search in a known area. An exact marker would make it a
  fetch quest.

---

## 4. Power: the rank ladder and the calibration

### 4.1 What a rank means [decision: the targets; confirmed: the results]

Targets: a victim one level above the monster's kind (the typical victim: BALANCE §3 hunts 0–3 levels below),
shop gear, skills as their SP allows, MP potions as needed, 80 % uptime:

| Rank | Name | Target (who wins) | Result: median over 22 kinds (min–max) | HP potions per player (deep bag) | Fight |
|---|---|---|---|---|---|
| I | Grudge | **solo, ~4 HP potions** | solo with 10 potions: **100 %** (100–100) | solo 4.0 | 43 s solo |
| II | Grudge | **solo with 10 potions wins ~70 %** (bring a friend) | solo **68 %** (55–90); duo 100 % | solo 11.1, duo 2.5 | 73 s solo / 34 s duo |
| III | Notorious | **a duo, ~4 potions each**; solo loses | solo **0 %** (0–6); duo **100 %** (99–100) | duo 4.0 | 43 s duo |
| IV | Notorious | **a duo with 10 potions wins ~70 %**; a trio is safe | duo **70 %** (56–81); trio 100 % (99–100) | trio 3.8 | 46 s trio |
| V | Dread | **a trio with 10 potions wins ~75 %**; a party of four is safe | trio **76 %** (68–89); four **100 %** (95–100) | four 3.9 | 47 s four |

[confirmed: `work/tmp/nemesis/calibrate.ts` → `calibration.json`, `calibration.log`: per kind and rank, bisection on
the power `k`, 80 fights per evaluation, then checks of every group size. Chart: `nemesis-power.png`. The fact-check
recomputed every median from `calibration.json`, re-ran one kind (Young Tiger: same `k` at ranks I–III) and
re-measured the calibrated tunings at **n = 400** (`check/noise.ts`): rank I solo 100 %, II solo **72 % (58–82)**, III
duo 100 % (98–100), IV duo **69 % (61–83)**, V trio **78 % (70–83)**. The n = 80 ranges above are half sampling noise
(Young Tiger II solo: 89 % at n = 80, 79 % at n = 400), F15.]

**Two gaps NM-B closes** (F10, F11):
- The calibration ran with `level = kind + rank` **unclamped**. With CLIMB's ceilings (B1 5 … B7 20) a Weasel (5)
  never gains a level and a Chakji Worker (19) stops at 20, so those nemeses come out easier than calibrated (−3 %
  damage and +2 % misses per missing level). NM-B calibrates with the clamped level.
- CLIMB's draft roster has **7 Far Bank kinds** (B7) the 22-kind run does not cover, and those are where level 17–20
  players die. Two of them have no champion model (§3.2 falls back to the normal one).

### 4.2 The shape [decision]

- **`hpMul = 1 + 2k`, `attackMul = 1 + 0.25k`, `levelAdd = rank`**, on the kind's **normal** row. A champion that wins
  loses its champion multipliers and takes the rank's. One `k` per kind and rank, found by the calibration.
- **Medians:**

  | Rank | HP | Attack |
  |---|---|---|
  | I | ×7.2 (3.4–12.5) | ×1.77 |
  | II | ×11.4 (5.8–19.1) | ×2.31 |
  | III | ×14.2 (7.0–22.9) | ×2.65 |
  | IV | ×19.8 (10.4–31.9) | ×3.35 |
  | V | ×25.9 (11.6–41.5) | ×4.12 |

- **Low-level kinds get the biggest multipliers** (Mangyang I ×12.5 HP, ×2.4 attack), because a level-2 player's
  herbs heal 120 against a 20-damage swing. The level-14+ tigers and the Bandit need only ×3.4–4.5 at rank I (the Young
  Tiger 5.5, the bandit archers 7.5–8.0) [confirmed: `calibration.log`; the fact-check narrowed "tigers and bandits"].
- **One table across all kinds would not work.** Table "D" (`power.ts`, one multiplier table for every kind) gave
  rank III a 100 % solo win against a Weasel (and six other kinds) but 0 % against the Bandit, Black Tiger and White
  Tiger [confirmed: `power-D.json`, 10 potions; the first draft said 98 %]. That is why the
  tuning is **per kind**.

### 4.3 How the numbers ship [decision]

- `content/nemesis.json` `kinds: { <mob code>: [ {hpMul, attackMul}, ×5 ] }`, written by the calibration script.
  - A kind without a row uses the `default` row: the medians above, which are wrong for low levels, so a test
    requires a row for every eligible kind.
- **CLIMB re-levels and re-tunes every field monster (`MOB_CL_*` kinds) this same wave, so today's table is a
  placeholder.** Lane NM-B re-runs `calibrate.ts` on CLIMB's final `mobs.json`, its band atk multipliers and its
  difficulty roles (packs, healers, ranged), and writes the content. Then it re-runs `econ.ts` and `week.ts`.
  - The script moves from scratch to `apps/server/scripts/nemesis-calibrate.ts`, importing the server's formulas the
    way `work/tmp/balance/sim.ts` does.
  - It takes about **2.5 min** for 22 kinds on the dev PC [confirmed: the run's wall time].
- The targets (§4.1) are the contract. A unit test re-checks three kinds (one per band) at n = 200: rank I solo ≥ 95 %,
  rank III solo ≤ 15 % and duo ≥ 95 %, rank V four ≥ 95 %.
- NM-B bisects at n = 200 and writes the checks at n = 400 (F15): at n = 80 one kind of 22 (Big-Eyed Ghost, II solo
  58 % at n = 400) already sits outside LAB-NM4's ±10 points by noise and spread together. The run grows to ≈ 10 min.

---

## 5. Rewards

### 5.1 EXP [decision; confirmed: `econ.ts`]

- **Kill EXP = `MobDef.exp × hpMul(rank)`** (MobTuning `expMul = hpMul`), shared by the normal party rules, **capped
  so that each member of the rank's group gets at most 10 % of the bar at the kind's level + 1** (CLIMB §3.5 asks it
  of every nemesis and Qilin kill). Without the cap 27 of the 110 kind × rank kills broke it (Mangyang rank II: 32 %
  of a level-2 bar); with it the per-minute medians below barely move (II: 1.39 → 1.20×; the low kinds drop to
  0.5–0.8×, which their loot and the story carry) [projected: `check/tenpct.py` on CLIMB's curve, F25].
- EXP_RATE and SP_RATE apply as to any kill. **Rested, meals and Calm do not**: `restEligible` and `mealEligible`
  return **false** for nemeses (CLIMB D10: "their EXP is a reward of its own"; the first draft said true, F24).
- **Per minute and per player**, against grinding the same kind solo (TTK + 5 s walk, `sim.ts`'s TRAVEL_S):

  | Rank | Group | EXP (normal kills) | Fight | vs grinding (min–max) |
  |---|---|---|---|---|
  | I | solo | 7.2 | 43 s | **1.29×** (1.05–1.77) |
  | II | solo | 11.4 | 73 s | **1.39×** (1.11–1.91) |
  | III | duo | 14.2 | 43 s | **1.26×** (1.07–1.58) |
  | IV | trio | 19.8 | 46 s | **1.20×** (0.97–1.54) |
  | V | four | 25.9 | 47 s | **1.12×** (0.94–1.42) |

- CLIMB's draft level-difference rule (+5 % per level the monster is above you, max +15 %) adds up to +15 % on these
  ratios, because a nemesis is `kind + rank` levels [projected].
- A good minute, not a jackpot. A nemesis appears about once per ~25 h of a player's play on CLIMB's draft deaths
  (§10), so it adds **< 0.5 %** to anyone's EXP [projected: 7–26 kills' worth per ~25 h against thousands of kills of
  grinding].

### 5.2 Loot [decision]

The nemesis module is a loot provider like `uniques.drops(m)` (the same seam, asked after uniques). The gold piles,
the prize and the Seal are a `ResolvedDropTable` rolled with `rollUniqueDrops`; the kind's own table is the normal
`rollDrops` call made N times, plus `alchemy.extraDrops(m)` once (a provider replaces the whole loot, so the module
must add both itself) [confirmed: `gameplay.ts` 1057–1061]. GOLD_RATE, DROP_RATE and ALCHEMY_MAX_PLUS apply as for
uniques:

| Rank | Gold | The kind's own table | **The prize**: one piece of the band's gear tier | Plus on the prize | Seal of Star (wave-11 `_RARE` rows of the band) |
|---|---|---|---|---|---|
| I | 2 piles | rolled 2× | 25 % | +0 (75 %) / +1 (25 %) | — |
| II | 3 piles | 3× | 40 % | +0 (75 %) / +1 (25 %) | — |
| III | 4 piles | 4× | 60 % | +0 / +1 / +2 (2:2:1) | — |
| IV | 5 piles | 5× | 80 % | +1 / +2 (2:1) | — |
| V | 6 piles | 6× | 100 % | +1 / +2 / +3 (2:2:1) | **10 %** |

**Fact-check F3:** the first draft gave IV 10 % and V **25 %** Seal of Star with plus up to **+4**. Tiger Girl, the
world boss with 11 camps and a 3–6 h respawn, drops 20 % and at most +3 (`content/uniques.json`; UNIQUES §3.4 calls
hers "the best items in our" game). With DROP_RATE ×2 (the live rate until CLIMB's x1) a rank-V nemesis would have
been a coin flip for a Seal. Now the nemesis's ceiling is half hers and never a higher plus.

- "The band's gear tier" is CLIMB's gear tier of the band the nemesis lives in. It is a `gearPool` rule (degree, max
  `reqLevel`) per band in `content/nemesis.json`. Default until CLIMB lands: the degree whose `reqLevel` range covers
  the nemesis's level.
- Waves 15 and 17 add named slots (new armour, new weapons). The prize pool is the band's tier, so new rows join by
  content.
- **Loot lands in the unique ring** (2.5–4 m, H11-NL-6) so the bigger body does not hide it. Owner rules are the
  normal ones.

### 5.3 The vengeance refund [decision]

§2.5.

- **It pays back half of what was lost, never more.** `exp_lost` is the sum of the penalty amounts CLIMB's module
  reports on its `penaltyTaken {player, loss, killer}` event for deaths to that nemesis, **minus any resurrection
  refund** (CLIMB §6.3's Soul Rebirth: 50 %, 100 % with the Rebirth Art; F23); the refund is `refund` (0.5) × that.
- **Over a simulated month** on CLIMB's draft deaths, each of the 3 live players loses **1.22 h** of play to rule #13;
  **0.60 h** of it on deaths to nemeses, and **0.26 h** of that comes back [projected: `week.ts --climb=mix --days=28`,
  150 runs]. The first draft's "17.8 h lost a month" came from its own 1 death/h assumption, ~10× CLIMB's (F1, R1).
- **What it does to rule #13:** about a fifth of the penalty's total comes back (a full refund would be two-fifths).
  Rule #13 stays the user's plain rule on every death; the refund is a reward for a kill, paid later.

---

## 6. The death penalty (CLIMB, the user's rule #13)

- **A death to a nemesis is a death to a monster:** from level 15 the 1–20 % roll applies, nothing extra, nothing
  less [decision; the user's rule]. The death that **creates** a nemesis counts too: the penalty applies, and the
  amount is recorded on the new row (half of it is refundable). A **pending** grudge (§2.1 rule 6) keeps the amount
  in memory until it is decided.
- **Order inside `playerDied`:** CLIMB's penalty module is registered **before** `nemesis`; `penalty.apply` takes the
  EXP and emits `penaltyTaken {player, loss, killer}` (CLIMB §6.5), which the nemesis module records against the
  killer's row. One seam (S-DEATH, CLIMB's `playerDied(p, now, killer)`) serves both (F22).
- **A resurrection refund lowers the record** (F23). CLIMB §6.3 refunds 50–100 % of the loss when a friend's Soul
  Rebirth lifts the corpse before it returns to town. Without a correction a Rebirth healer and a nemesis make an EXP
  loop: die to it (−L), get raised (+L), avenge (+0.5 L): a net +5 % of a bar per death on average, one death per
  20–40 min return. CLIMB's penalty module emits `penaltyRefunded {player, amount}` (one line beside its refund), and
  the nemesis module subtracts it from the latest death's record.
- **Never a de-level,** and the refund can't be lost: a refund later at a higher level is just EXP, added normally
  (it may level them up).
- **At the cap (20)** the penalty does not apply (CLIMB: 15–19 only), so `loss = 0` and no refund (CLIMB decides what a death at 20 costs;
  the nemesis follows).
- **Grudge deaths never cost more than other deaths.** Considered: halving the penalty on a second death to your own
  nemesis the same day. Rejected: the refund already returns half of it, and rule #13 should stay one plain rule.
- **CLIMB's draft grace** (a death within 10 min of a penalised one costs nothing, `climb.ts` `PENALTY_GRACE_H`)
  and the **Ancestor's Incense** (CLIMB §6.2) report `loss = 0`, so they record nothing to refund.

---

## 7. Server

### 7.1 The module and the seams [decision]

`apps/server/src/nemesis/` (lane NM-S):

| File | Contents |
|---|---|
| `module.ts` | `class Nemeses implements GameplayModule` (`name = 'nemesis'`), registered **after `uniques`**, only when `NEMESIS=on` (config, default on). Hooks: `playerDied` (birth or growth), `mobDied` (vengeance, ends), `tick` (returns, growth, retirement, the near pass every 2 s, hourly outgrown check), `enter` (login lines, pending end notices), `forget`. Plus `drops(m)` (the loot provider) and `gm(…)`. |
| `rules.ts` | Eligibility, the caps, the rank-up rule, the level clamp, the power lookup: pure functions (unit tested). |
| `names.ts` | The generator (`rules.ts` `nemesisName` in the prototype). |
| `store.ts` | The prepared statements (§7.2). |
| `loot.ts` | The per-band drop tables, resolved at start like uniques' `resolveDropTable`. |

**Seams in other files** (one owner each; WAVE_PLAN10 assigns them to its step 0 like W13-SV):

- **S-DEATH (shared with CLIMB's penalty)** in `gameplay.ts` and `modules.ts`.
  **CLIMB's shape** (CLIMB §10.3, landed by CL-SV): `playerDied(p, now, killer)`; the attack path passes the
  attacker (a DoT tick passes its caster), `gmKill` (`gameplay.ts` 1299) passes `gm`. The first draft's own
  `DeathCause { …; expLost }` is dropped (F22): the loss reaches the nemesis through CLIMB's `penaltyTaken` event, and
  its `penaltyRefunded` twin (F23, one line in CL-K).
  - The hook signature in `modules.ts` gains the optional third argument. Existing modules (alchemy, berserk,
    item-use, mounts) ignore it.
- **S-LOOT** in `gameplay.ts` 1057: `const unique = this.uniques?.drops(m, now) ?? this.nemesis?.drops(m, now) ?? null`.
  Same shape, same ring rule (`unique ? 2.5 + …`), widened to "a module table".
- **S-RELEASE** in `spawner.ts`: `release(id, now)` = `died(id, now)`'s bookkeeping (the replacement is scheduled)
  for a mob that leaves its nest alive, and `tracks(id)` (is it a nest mob today; `byMob` is private).
- **S-LEVEL** in `world.ts` / `gameplay.ts`: `MobTuning.levelAdd?: number`. `createMob` sets
  `mob.level = mob.combat.level = def.level + levelAdd`, and the EntityState carries `level` as today.
- **S-NOTIFY**: the module's notice fan-out reuses `party.partyOf(p)` and `guilds.guildOf(p)` (online members). A
  `friendsOf(charId)` hook returns [] until PETS_SOCIAL lands.
- **S-ELIG** (with CLIMB, TOMB_DUNGEON and STORM_QILIN): a `Mob.tag?: 'boss' | 'event' | 'elite' | 'encounter' |
  'summon'` that those modules set, plus TOMB_DUNGEON's own `Mob.instance?: number` (its S-HOOK: the instances are
  slots of the same world, F6), or their existing flags (`encounter`). `Uniques` gains a public `isTracked(m)` (today
  `tracked` is private, F7). The nemesis eligibility reads
  `!m.tag && m.instance === undefined && !m.encounter && !uniques.isTracked(m) && spawner.tracks(m.id)`.
- **S-BANDS** (CLIMB's content): `bandAt(x, z)` or `bandOf(mobCode)` gives the band id, its level ceiling and its gear
  tier. Fallback (no CLIMB file): the area's highest live-nest level and the degree rule of §5.2.

### 7.2 Persistence: one migration (number from WAVE_PLAN10; after wave 13's 11–13) [decision]

The SQL is in `work/tmp/nemesis/rules.ts` `MIGRATION_SQL` (aligned with this block by the fact-check: no `variant`
column, `born_by_gm`, `told_end`, `birth_x/z` added, F14); the build copies it verbatim:

```sql
CREATE TABLE nemeses (
  id INTEGER PRIMARY KEY,
  world TEXT NOT NULL,
  mob TEXT NOT NULL,                    -- MobDef code (the kind)
  rank INTEGER NOT NULL DEFAULT 1 CHECK (rank BETWEEN 1 AND 5),
  level INTEGER NOT NULL,               -- base + rank, clamped to the band ceiling
  title TEXT NOT NULL,                  -- 'the Pixi-Slayer'
  given_name TEXT,                      -- from rank III ('Blackhorn')
  seed INTEGER NOT NULL,                -- the name generator's seed
  home_x REAL NOT NULL, home_y REAL NOT NULL, home_z REAL NOT NULL,  -- the latest victory spot (glTF m, on the navmesh)
  birth_x REAL NOT NULL, birth_z REAL NOT NULL,  -- where it was born: the home never drifts > 100 m from it (F21)
  zone TEXT NOT NULL DEFAULT '',        -- area name at home (caps, lines)
  nest INTEGER,                         -- the nest it came from (tactics template)
  state TEXT NOT NULL CHECK (state IN ('away', 'alive', 'slain', 'retired')),
  back_at INTEGER NOT NULL DEFAULT 0,   -- ms epoch it returns while away
  born_at INTEGER NOT NULL,
  last_kill_at INTEGER NOT NULL,
  grew_at INTEGER NOT NULL,
  kills INTEGER NOT NULL DEFAULT 1,
  born_by_gm INTEGER NOT NULL DEFAULT 0,
  ended_at INTEGER,
  ended_how TEXT,                       -- avenged | slain | retired | outgrown | orphan | content | gm
  slain_by TEXT
);
CREATE INDEX nemeses_live ON nemeses(world, state);
CREATE TABLE nemesis_victims (
  nemesis INTEGER NOT NULL REFERENCES nemeses(id) ON DELETE CASCADE,
  char_id INTEGER NOT NULL REFERENCES characters(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  first INTEGER NOT NULL DEFAULT 0,      -- 1: the death that made it
  deaths INTEGER NOT NULL DEFAULT 0,
  exp_lost INTEGER NOT NULL DEFAULT 0,   -- penalty EXP on deaths to it (the refund)
  last_died_at INTEGER NOT NULL,
  avenged INTEGER NOT NULL DEFAULT 0,
  told_end INTEGER NOT NULL DEFAULT 0,   -- the end notice was delivered
  PRIMARY KEY (nemesis, char_id)
);
CREATE INDEX nemesis_victims_char ON nemesis_victims(char_id);
CREATE INDEX nemesis_victims_account ON nemesis_victims(account_id, first);
CREATE TABLE nemesis_accounts (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
  cooldown_ms INTEGER NOT NULL DEFAULT 0  -- online ms left before a new birth
);
```

- **Writes only on events:** birth, kill, growth, return, end, and the cooldown. The cooldown counts down **in
  memory** while the account is in the world and is written at logout, at server stop and when it reaches 0 (F13: the
  first draft flushed it every 60 s, about 120 writes per ended nemesis, against its own "events only" rule and
  LAB-NM2). A crash keeps the last written value, so the cooldown can only come out longer, never shorter.
- **Migration of the live data:** the tables start empty. The 3 live accounts need nothing; a fresh account gets its
  `nemesis_accounts` row lazily.
- **Down-migration:** none, as the others are append-only.
- **Backups:** the deploy's named backup covers it.

### 7.3 Content: `content/nemesis.json` (server; the client reads only the families' strings through the wire) [decision]

```jsonc
{
  "chance": 1.0, "minVictimLevel": 3, "minDamageShare": 0.1, "packRadiusM": 20, "pendingSec": 60, "townRadiusM": 200,
  "caps": { "perAccount": 1, "perArea": 2, "world": 8, "cooldownOnlineMin": 120, "rankOncePerAccount": true },
  "timers": { "gloatSec": 3, "returnMin": [20, 40], "growEveryH": 48, "timeRankCap": 3, "retireAfterH": 168, "outgrownBy": 8, "bootReturnMin": [2, 5] },
  "home": { "roamM": 25, "leashM": 50, "sightM": 14, "aggressiveFromRank": 3 },
  "near": { "enterM": 120, "leaveM": 150, "repeatMin": 10, "everyMs": 2000 },
  "refund": 0.5,
  "ranks": [ { "scale": 1.1, "goldPiles": 2, "extraRolls": 1, "prizeChance": 0.25, "plus": [[0,3],[1,1]], "rare": 0 }, … ],
  "bands": { "B1": { "ceiling": 5, "gear": { "degree": 1, "maxReqLevel": 5 } }, … },
  "families": [ { "match": ["MOB_CH_MANGNYANG"], "verb": "Slayer", "names": ["Blackhorn", …] }, … ],
  "kinds": { "MOB_CH_MANGNYANG": [ { "hpMul": 12.48, "attackMul": 2.435 }, … ], … },
  "default": [ { "hpMul": 7.2, "attackMul": 1.77 }, … ]
}
```

- **Checked at start** by `checkNemesisFile` (in `@sro/shared` content-check, like `checkUniquesFile`): every known
  mob, ranks 1–5, ranges, families non-empty. A bad file fails the start.
- **Read at start only**, like `content/uniques.json` (F16): `content reload` takes `nests | npcs | quests | all` and
  nothing else today [confirmed: `editors/live.ts` `CONTENT_USAGE`]. A change needs a restart; living nemeses keep
  their rank and take the new tuning when they respawn.

### 7.4 GM [decision]

- `/nemesis list | info <id> | spawn <mob> [for <char>] [rank <1-5>] [here] | rank <id> <1-5> | return <id> | kill <id> | retire <id> | clear | quiet <on|off>`
- Every command is audited (`gm_audit`, as every GM command). A spawned nemesis has `born_by_gm = 1`: no refund, no
  Avenger credit.
- `/nemesis list` shows each nemesis's rank, area, state, timers and victims.

### 7.5 Server cost [confirmed: `cost.ts`, dev PC, first run plus 3 fact-check re-runs; projected ×2.5 on the N100]

| What | Measured (p50 / p99) | Frequency (`week.ts --climb=mix`, 20 players) | N100 [projected] |
|---|---|---|---|
| Birth transaction (row + first victim + account row) | 33–48 µs / 0.42–2.0 ms | 9.6 a week (≤ 44 at 1 death/h) | ≤ 0.12 / 5 ms |
| A nemesis kills a player (rank-up + victim upsert) | 32–40 µs / 0.45–1.9 ms | < 1 a week | same |
| Vengeance end (slain + victims + cooldown) | 34–46 µs / 0.46–1.9 ms | ~8 a week | same |
| Start-up load (8 live of 2,000 rows) | 20–31 µs / 60–143 µs | once per boot | < 0.4 ms |
| Near pass (20 players × 8 nemeses, hysteresis map) | **0.9–1.6 µs** / 6.6 µs | every 2 s | ~4 µs / 2 s |
| Name and title | 0.3 µs / 1.2 µs | per birth / growth | — |
| DB size | 652–672 KiB for 2,000 nemeses + 4,000 victim rows | ~500 rows a year at 20 players | < 0.3 MB a year |
| Simulation | ≤ 8 extra monsters (≤ 0.13 % of the 6,083 live) | always | — |

The p99 spread is SQLite's WAL checkpoints on a PC that was busy with another agent's GPU run during the re-runs (the
GPU lock was held by "T12-L crown A/Bs"); the first run's p99 was < 0.5 ms. The worst case, ~5 ms on the N100 for an
event that happens a few times an evening, is 5 % of one 100 ms tick (`TICK_HZ` 10; the first draft said 50 ms).
The per-tick cost (the near pass) stays ≪ 0.01 % of the tick [projected].

---

## 8. Formats: wire (additive, protocol v1) [decision]

- **`EntityState.nemesis?`**: `{ rank: 1..5; sub: string; victims: string[]; given?: true }`.
  - `sub` is the subtitle ("Mangyang · Nemesis III", ≤ 48 code points).
  - `victims` holds the names of the **live** characters it has killed (a deleted one drops out, §2.6), the latest
    8, ≤ 12 code points each. The client marks it "YOUR NEMESIS" and colours it crimson when its own name is listed.
  - `EntityState.name` carries the display name ("Mangyang the Pixi-Slayer", ≤ 48).
  - The validator (`validate.ts`) gets its own bounds for the object (per-key bounds, as the HOT_SPRINGS F1 fix-up
    asks).
- **`nemesisNotice`**:
  `{ t: 'nemesisNotice'; event: 'born' | 'returned' | 'grew' | 'notorious' | 'slain' | 'refund' | 'retired' | 'near' | 'login'; name: string; mob: string; rank: number; area?: string; victim?: string; by?: string; party?: true; avenged?: true; exp?: number; dir?: number; distM?: number; state?: 'away' | 'alive'; at?: number }`
  - `NEMESIS_NOTICE_EVENTS` lists the events, as `UNIQUE_NOTICE_EVENTS` does.
- **`entityUpdate`**: a `nemesis` change (rank-up while visible) sends the new `name` and `nemesis`.
- **No new request.** GM commands go through the existing `gm` path.
- **No new fail reason.**

---

## 9. Client (lane NM-C) [decision; costs projected]

| Part | Where | Cost |
|---|---|---|
| Nameplate: `.nemesis` / `.nemesis.mine` classes, the subtitle line, the five pips, the colour override, "YOUR NEMESIS" | `world/entities.ts` (`refreshLabel`, `displayName`), `style.css` | one more DOM line per visible nemesis |
| Model, scale | `entities.ts` (champion model when `state.nemesis`; `scale ×= RANK_SCALE[rank]`) | 0 (same draw as a champion) |
| Aura | a `nemesis` world feature (as `features/berserk.ts`): SystemFx loops on add, removed on despawn or death; off on Low; on High/Ultra as Medium | **7 batches** (I–II), **+16** (III–V) per visible nemesis [confirmed: fx viewer stats]; ≤ 2 visible in practice |
| Notices | `features/nemesis.ts`: chat lines, toasts; the banner (rank III+) reuses the unique banner component with its own strings and no town alarm | DOM only |
| Near hint | toast + sting + minimap claw marker (the map feature's marker API, `MapMarker`) | 1 DOM element |
| Grudges list | the character window (or a tab of the quest window; NM-C decides by the UI kit), filled from notices | DOM only |
| Death screen | one line under CLIMB's loss line, from the `born` notice | DOM only |
| i18n | `en-nemesis.ts` (the EN strings of §3.3; the names and verbs arrive in the wire) | — |

**Frame budget** [projected]:
- A nemesis costs what a champion of its kind costs, plus the aura. The Berserk SYSTEM rows already ship on the same
  SystemFx path; the flame shroud's 16 batches only show at rank III+.
- Gate (LAB row §11): **≤ +0.15 ms p95** for two nemeses (one rank I, one rank III) in view, WebGPU Medium, at the
  live-nest density, measured under the GPU lock (3 runs, median).
- The 60 fps goal stands; the 20-player scenes are dominated by players (BACKLOG item 9), not by this.

---

## 10. The prototype

### 10.1 What was built [confirmed: `work/tmp/nemesis/`]

| Script | What it does |
|---|---|
| `model.ts` | `work/tmp/balance/sim.ts`'s character and fight model as importable functions: gear, the SP plan, player stats, potions. It is copied, not imported, because sim.ts runs its whole model at import. Plus **`groupFight`**: one tuned monster against 1–4 players, using its MSKILL rows, the area rows and the level offset (sim.ts's `bossFight`, generalised). Same server formulas (`formulas.ts`, `mob-skills.ts`, `skills/timing.ts`). |
| `power.ts` | One multiplier table for all kinds (tables A–D): showed why one table fails (§4.2). |
| `calibrate.ts` | The per-kind calibration (§4): `calibration.json`, `calibration.log`. |
| `econ.ts` | EXP per minute against grinding, loot rolls, the farm loop (§5, §2.8): `econ.json`, `econ.log`. |
| `week.ts` | The agent model of a week (or a month) of play under §2's rules (§10.2): `week-p3/p8/p20.json`, `month-p3.json`, the sweeps `week-p3-<name>.json` (§10.3), the trace `trace-p3-month.txt`. The fact-check added `--climb=<profile>` (CLIMB's per-level death rates), `--repeat=life` and `--refund=`; the first draft's runs are in `first-draft/`. |
| `check/` | The fact-check's own scripts: `noise.ts` (the calibrated tunings at n = 400), `names.ts` (the longest plate), a one-kind re-calibration, three month traces. |
| `cost.ts` + `rules.ts` | The migration, the generator, the rank table; the server-cost bench (§7.5): `cost.log`. |
| `charts.py` | The four images below (PIL; no downloads). |

**The week model's inputs (assumptions, not measurements):**
- The play schedule: evenings 19–23 h ± 1 h; play on 60 % of weekdays (1–3 h) and 85 % of weekend days (2–5 h, plus an
  afternoon 40 % of the time).
- Parties: players within 5 levels group up half the time.
- The level curve: CLIMB's target of ~40 h to 20, as `hours(L) = A × 1.2^(L−1)`.
- Start levels for the 3 live accounts: 6, 11, 15 [unknown: their real levels after CLIMB's migration].
- Deaths per hour: **CLIMB's draft**, per level, from its Monte Carlo friends (`climb.json` `mc.mix`: deaths at that
  level ÷ hours at that level; the profile already mixes solo and party play) [likely: a draft]. The first draft's own
  guess (0.3 / 0.4 / 0.7 / 1.0 solo for levels < 5 / < 10 / < 15 / ≥ 15, ×0.6 in a party: ~10× CLIMB's) is a
  sensitivity row.
- Death sources:
  - 95 % (70 % at 15+, the Tomb's time) of deaths are to field monsters;
  - 85 % of those pass the 10 % damage check (with the pack rule) [unknown: CLIMB's packs decide it];
  - 2 % happen inside the town circle.
- Hunting: a victim online hunts their grudge half the hours, with a group of the rank's size or a 25 % solo gamble.
- Meetings: others meet it 25 % of the hours in its area.
- The fights' outcomes are calibrate.ts's win rates with 10 potions. A lost fight kills one of the group 60 % of the
  time.

### 10.2 A week of play [projected: `week.ts --climb=mix --chance=1 --repeat=life --refund=0.5`, 300 simulated weeks per row, seed 1]

| Per week (mean) | 3 players | 8 players | 20 players |
|---|---|---|---|
| Online hours per player | 13.3 | 13.4 | 13.3 |
| Deaths to monsters | 2.6 | 7.3 | 18.1 |
| Eligible deaths (§2.1) | 1.8 | 4.7 | 11.6 |
| **Nemeses born** | **1.5** | **3.9** | **9.6** |
| Blocked: the account has one | 0.15 | 0.4 | 0.9 |
| Blocked: 2 h cooldown | 0.15 | 0.4 | 0.9 |
| Blocked: area or world cap | 0.0 | 0.02 | 0.2 |
| Rank-ups (kills + time) | 0.09 | 0.3 | 0.6 |
| **Avenged** by a victim's group | **1.2** | **2.9** | **6.0** |
| Slain by others | 0.07 | 0.5 | 2.4 |
| Retired | 0.0 | 0.0 | 0.0 |
| Alive at a time (mean) | 0.12 | 0.32 | 0.64 |
| A week with no nemesis at all | 23 % | 1 % | 0 % |
| A rank III+ in the week | 1 % | 4 % | 8 % |
| Median life (born → end) | 2.8 h | 2.3 h | 2.0 h |
| Births + rank-ups + ends (the notice events) | 2.7 | 7.3 | 18.1 |
| DB writes | 2.8 | 7.6 | 18.5 |

**Over 4 weeks** at 3 players (150 runs, `month-p3.json`): about **8 nemeses** (2.7 per player), 0.23 alive on
average, median life 16 h (players are offline between evenings); a rank III+ appears in **16 %** of months, a rank V
in **1 %**: "Dread" is a legend. Each player loses 1.22 h of play a month to rule #13, 0.60 h of it to nemeses, and
gets 0.26 h back.

**One simulated month** at 3 players (`trace-p3-month.txt`, seed 12; names are placeholders; the model's "zone" is a
random nest of the victim's level, so the areas are only indicative):

```
d2 20:20 born     BANDITARCHER_CLON (L15) became Mei's nemesis in South-Tiger Mt. (Mei L15)
d2 21:00 slain    BANDITARCHER_CLON r1 slain by Pixi+Mei (hunt, avenged)
d6 20:40 born     BANDIT_CLON (L11) became Dayan's nemesis in North-Tiger Mt. (Dayan L14)
d8 20:50 grows    BANDIT_CLON grows to r2 (unavenged for 48 h)
d9 18:00 slain    BANDIT_CLON r2 slain by Dayan (hunt, avenged)
d10 21:10 born     BANDIT (L16) became Pixi's nemesis in South-Tiger Mt. (Pixi L17)
d10 22:00 slain    BANDIT r1 slain by Pixi (hunt, avenged)
…
d21 23:30 born     CHAKJI_CLON (L19) became Dayan's nemesis in Jangan Ferry (Dayan L20)
d23 23:40 grows    CHAKJI_CLON grows to r2 (unavenged for 48 h)
d25 23:50 grows    CHAKJI_CLON grows to r3 (unavenged for 48 h)
d27 21:00 slain    CHAKJI_CLON r3 slain by Pixi+Dayan+Mei (hunt, avenged)
```

That reads like the feature as intended, but rarer than the first draft promised: about **one grudge per player every
~1.5 weeks**, almost all from level 14 up, mostly settled the same or next evening, sometimes with friends. An ignored
grudge grows. The first draft's "one per player per week from level 3" needs the 1 death/h it assumed (row "First
draft's deaths" below).

### 10.3 Sensitivity (3 players, 300 weeks each) [projected: `week.ts` sweeps, files `week-p3-<name>.json`]

| Change (name) | Born | Alive (mean) | III+ in the week | EXP lost per player per week (to nemeses / refunded) |
|---|---|---|---|---|
| **Base** (CLIMB mix deaths, chance 1, rank once per account, refund 0.5) | 1.5 | 0.12 | 1 % | 0.24 h (0.12 / 0.05) |
| Chance 0.5 (`c05`) | 0.78 | 0.07 | 2 % | 0.22 h (0.06 / 0.02) |
| Chance 0.3, the first draft's (`c03`) | 0.44 | 0.04 | 1 % | 0.25 h (0.04 / 0.01) |
| Refund 1.0, the first draft's (`r1`) | 1.4 | 0.11 | 0 % | 0.24 h (0.12 / **0.10**) |
| 24 h repeat window, the first draft's (`rep24`) | 1.5 | 0.12 | 1 % | 0.24 h (0.12 / 0.05) |
| CLIMB's **solo** profile (`solo`, 2× the mix's deaths) | 2.4 | 0.18 | 2 % | 0.57 h (0.23 / 0.09) |
| CLIMB mix deaths ×2 (`d2`) | 2.5 | 0.23 | 4 % | 0.50 h (0.20 / 0.07) |
| **First draft's deaths** (1/h at 15+), chance 1 (`old`) | 7.2 | 0.78 | 15 % | 2.24 h (0.47 / 0.18) |
| First draft's deaths, chance 0.3 (`oldc03`) | 4.0 | 0.43 | 9 % | 2.31 h (0.28 / 0.11) |

- **Births follow deaths, which CLIMB sets.** On CLIMB's draft the per-account caps barely bind (0.3 blocked a week),
  so births scale with the chance; on the first draft's deaths the caps bind hard (6.4 + 5.5 blocked a week) and cap
  births at ~7 a week. Chance 1.0 is right for both.
- **The 24 h window barely shows in a week** (rank-ups are rare); its harm is the deliberate loop of §2.8 A3/A13.
- **The "EXP lost" column is the death penalty itself.** On CLIMB's draft it is 0.24 h per player-week, 2 % of play;
  CLIMB's own run puts rule #13 at 1–10 % of the time at levels 15–19 (`climb.json` `curve.rows[].lossFrac`). The
  first draft's "15–30 % of play time" was its own 1 death/h assumption (R1).

### 10.4 Images

| File | What |
|---|---|
| `work/tmp/nemesis/nemesis-power.png` | The rank ladder: win rate per group size with 10 potions, median and range over 22 kinds; the multipliers |
| `work/tmp/nemesis/nemesis-week.png` | Nemeses alive per hour over the week for 3 / 8 / 20 players, and the per-week outcomes |
| `work/tmp/nemesis/nemesis-map.png` | Where they are born: 50 simulated weeks of 8 players on the world map, coloured by the highest rank reached |
| `work/tmp/nemesis/nemesis-look.png` | A mockup of the nameplates (I as its victim sees it, III, V) and the lines |

---

## 11. Budgets and LAB rows (added to the wave's LAB and gate)

| Row | Measure | Pass |
|---|---|---|
| LAB-NM1 | Two nemeses in view (rank I + rank III, auras on), plaza-like density, WebGPU Medium and WebGL2 Medium, 1920×1080, GPU lock, 3 runs, median | ≤ +0.15 ms p95 vs the same scene with plain champions |
| LAB-NM2 | Server: 8 live nemeses + 20 bots on the private server (temp DB copy) for 10 min | tick p99 unchanged within noise (±0.2 ms); no DB write outside events |
| LAB-NM3 | Restart with 1 `alive` + 1 overdue `away` + 1 future `away` row | alive respawns at home, overdue returns in 2–5 min, future keeps `back_at`; no notice at boot |
| LAB-NM4 | The calibration contract (§4.3) on CLIMB's final roster (Far Bank kinds included, levels clamped to the band ceilings), checks at n = 400 | the targets of §4.1 within ±10 points |

---

## 12. Decisions (each the recommended option; the user delegated)

| # | Decision | One-line reason |
|---|---|---|
| N1 | Eligible: normal/champion open-world nest monsters only | Bosses, events and instances already have their own identity, and must not be farmed into something else. |
| N2 | Victim level ≥ 3 | The user's Mangyang example; the first 15 minutes stay free. |
| N3 | The victim must have dealt ≥ 10 % of its max HP | Anti-farm, and the story stays "you fought and lost". |
| N4 | **Every** eligible death (chance 1.0; was 30 %) | The user's words; on CLIMB's draft deaths 30 % gave the live server one nemesis every ~2 weeks, and when deaths run high the caps hold the ceiling (§10.3). |
| N5 | Caps 1 per account, 2 h online cooldown, 2 per area, 8 per world | Personal, alt-proof, never crowding the map. |
| N6 | It leaves after the kill and returns in 20–40 min at the victory spot | "Comes back"; no corpse-run revenge; same-evening hunts. |
| N7 | Home = latest victory spot (within 100 m of its birth, same area), roam 25 m, leash 50 m, aggressive from III | "Roams near where it won"; can't be dragged or walked into another band. |
| N8 | Growth: +1 per kill of an account it has **never** killed (was: not in the last 24 h) to V; +1 per 48 h unavenged to III | Stronger with kills; no self-feeding, and 3 friends can't feed it to V in a day; ignored grudges ripen. |
| N9 | Level = kind + rank, clamped to CLIMB's band ceiling | "Levels up within its band's ceiling". |
| N10 | Per-kind calibrated tuning with group-size targets (I solo … V four) | One table fails across kinds (§4.2); the ladder is readable: the plate tells you how many friends to bring. |
| N11 | Name: the user's "<Kind> the <Victim>-<Verb>" at I–II; a given name at III+; title always names the first victim | The example verbatim, plus notoriety you can see. |
| N12 | Family verbs (Slayer, Haunter, Biter, Breaker, Bane, Hunter, Robber, Mauler, Crusher; Stinger, Reaver, Burner for CLIMB's Far Bank) | Flavour at no cost. |
| N13 | Look: champion model, scale 1.10–1.30, Berserk red glow (I–II), + flame shroud at 0.5 (III–V), blood-orange name, crimson + "YOUR NEMESIS" for victims, rank pips | Reads at a glance with retail assets only. |
| N14 | Announcements: victim, party, guild (friends later); server-wide from III | Personal by default, a server story when notorious. |
| N15 | Near hint at 120 m (out at 150 m, 10 min repeat), minimap claw for victim and party, grudge list by area | Warns before you see it, never tracks across the map. |
| N16 | EXP = kill EXP × hpMul, capped at 10 % of a level per member, no Rested or meals; loot 2–6 gold piles, 1–5 extra rolls, a band gear prize 25–100 %, +0..+3, Seal of Star 10 % at V only (was +4 and 10–25 % at IV–V) | A good fight, never a farm (1.1–1.4× grinding per minute; farm loop ≈ 1 % of the EXP), and never above Tiger Girl's 20 % and +3. |
| N17 | Vengeance refund = **50 %** of the penalty EXP it took (was 100 %), for victims in the killing group, outside S-REWARD | "Take back what it stole", bounded by the loss, while rule #13 keeps ~80 % of its bite (a full refund would return 42 % of it). |
| N18 | A nemesis death is a normal monster death for rule #13 | The user's rule stays one plain rule. |
| N19 | Retire after 7 d without a kill, when outgrown by 8 levels, or when its first victim is deleted | The world forgets stale grudges. |
| N20 | Persist in 3 new tables; events-only writes | Survives restarts; costs nothing measurable. |
| N21 | One S-DEATH seam: CLIMB's `playerDied(p, now, killer)`; the loss from its `penaltyTaken` and `penaltyRefunded` events | One change to `playerDied` serves both; a resurrection refund can't be paid twice. |
| N22 | The loot provider seam shared with uniques; reuse `gearPool` / `rollUniqueDrops` (prize, gold, Seal) and `rollDrops` + `alchemy.extraDrops` (the kind's own table) | No second loot pipeline. |
| N23 | The calibration script moves to `apps/server/scripts/`; NM-B re-runs it on CLIMB's roster | CLIMB re-tunes every monster this wave. |
| N24 | `NEMESIS=on` config switch (default on); `/nemesis` GM verbs, audited | Same pattern as UNIQUES. |
| N25 | No new art, no Meshy (0 credits) | Retail EFPs and champion models cover the tell. |
| N26 | A grudge is **pending** while other players still fight the killer; killed on the spot = no nemesis | A friend's fight is never cut by a smoke exit; they already avenged you. |
| N27 | The **pack rule**: if an add landed the blow, the grudge goes to the pack member you hurt most (≥ 10 %, alive, ≤ 20 m) | CLIMB's packs make add deaths common; "the pack that beat you" is still the story. |
| N28 | Tomb monsters are excluded by TOMB_DUNGEON's `Mob.instance`, not a world check | The Tomb's instances are slots of the same world. |
| N29 | The online cooldown is kept in memory and written at logout, stop and 0 | Events-only writes; a crash only lengthens it. |
| N30 | No live reload of `content/nemesis.json` | Same as uniques.json; `content reload` has no such target. |
| N31 | Given names never start with "the" and never equal a boss's name | "the Weeping Lamp the Pixi-Haunter"; CLIMB's MB1 is "Old Scar". |

## 13. Needs from the user

- **Nothing blocks the build.**
- At the wave's user check, one look at a rank-I and a rank-III nemesis in game: the glow and the flame. Say if the
  Berserk glow is confusing (the fallback is the flame shroud on every rank, smaller).
- The deploy needs its own OK, as every wave.

## 14. Open questions (each with the default used meanwhile)

| # | Question | Default |
|---|---|---|
| Q1 | Should nemesis kills of **other** players announce to the whole server below rank III? | No: only victims, party, guild. |
| Q2 | Should the victim get a **short priority window** on their own nemesis after it returns (others can't damage it for 5 min)? | No: a world monster; the refund is the victim's group's only. |
| Q3 | Given names: English epithets ("Blackhorn") or Chinese-style ("Hei Jiao")? | English (the UI is English); the pools are content, easy to swap. |
| Q4 | Should time growth continue while **all** its victims are offline? | Yes (real time); the 7-day retirement bounds it. |
| Q5 | Does the friends list (PETS_SOCIAL, not built) get the "Avenge them!" line when it lands? | Yes, through the `friendsOf` hook; nothing until then. |
| Q6 | The live accounts' real levels after CLIMB's migration (the week model assumed 6/11/15) | The model's spread; NM-B re-runs `week.ts` with the real ones at deploy time. |
| Q7 | Should rule #13's loss come back in full when you avenge yourself (the first draft), or half? | Half (`refund` 0.5): rule #13 is the user's; a full refund returns 42 % of everything it takes. A content number, one line to change. |
| Q8 (cross-spec, CLIMB) | CLIMB's final death rates. The nemesis count follows them almost linearly | NM-B re-runs `week.ts --climb=<final profile>` before the deploy. If the 3 live accounts would see more than ~5 births a week, the chance drops to 0.5; below ~1 a week it stays 1.0. |

## 15. Lanes

### 15.1 Step order (inside wave 14; WAVE_PLAN10 merges it with CLIMB, TOMB_DUNGEON, STORM_QILIN)

1. **Step 0 (the wave's seam agent):** S-DEATH (shared with CLIMB), S-LOOT, S-RELEASE (`release` + `tracks`), S-LEVEL,
   S-ELIG flags (`Mob.tag`, `Uniques.isTracked`; `Mob.instance` is TOMB_DUNGEON's S-HOOK), CLIMB's `penaltyRefunded` event (one line in CL-K), the migration (numbered with the wave's
   others), the `NEMESIS` config key, the `/nemesis` GM row, the module stub
   registered after `uniques`, the protocol additions (types, validator, `NEMESIS_NOTICE_EVENTS`).
2. **NM-P** (shared + content), then **NM-S** and **NM-C** in parallel.
3. **NM-B** after CLIMB's roster lands (it re-tunes `kinds`), then LAB-NM1–4.

### 15.2 The lanes

| Lane | Owns | Seams used | Tests | User check | Effort |
|---|---|---|---|---|---|
| **NM-P** shared + content | `packages/shared/src/nemesis.ts` (types, `checkNemesisFile`, the generator, `NEMESIS_NOTICE_EVENTS`), `content/nemesis.json` (families, ranks, timers, bands placeholder, today's `kinds` from `calibration.json`) | protocol additions from step 0 | content check (every eligible kind has a row; ranges); generator determinism and length (≤ 48); validator bounds for `EntityState.nemesis` and `nemesisNotice` | — | 0.5 d |
| **NM-S** server | `apps/server/src/nemesis/**` | S-DEATH, S-LOOT, S-RELEASE, S-LEVEL, S-ELIG, S-BANDS, S-NOTIFY, uniques' helpers | real-server integration: birth → away → return → hunt → refund; every eligibility rule (§2.1); caps and cooldown (§2.2); growth by kills and time, the once-per-account rank rule (§2.4); the pending grudge and the pack rule (§2.1); the cooldown written only at logout, stop and 0; vengeance group incl. the dead party member and the excluded GM (§2.5); every end (§2.6); restarts (§2.7); **one abuse test per §2.8 row (A1–A15)**; the calibration contract on 3 kinds (§4.3); the loot table rolls and plus caps (≤ +3, Seal only at V); the 10 % EXP cap; `restEligible` / `mealEligible` false; the refund net of a Soul Rebirth refund | `/nemesis spawn Mangyang for <me> rank 3 here`, then hunt it | 3 d |
| **NM-C** client | `apps/game/src/world/features/nemesis.ts`, the nameplate changes in `entities.ts` + `style.css`, `i18n/en-nemesis.ts`, the grudges list, the minimap marker | `EntityState.nemesis`, `nemesisNotice`, SystemFx, MapMarker, the unique banner | label (mine / not mine, pips, colour, subtitle), scale and model choice, aura on/off by preset and on death, notices → chat/toast/banner, near toast, grudge list from notices, mock server (`net/mock.ts`) support for a nemesis | see a rank I and a rank III; the death-screen line; the near hint | 2 d |
| **NM-B** balance | `apps/server/scripts/nemesis-calibrate.ts` (from `work/tmp/nemesis/calibrate.ts` + `model.ts`), the `kinds` rows (every CLIMB kind, the Far Bank's 7 included), re-runs of `econ.ts` and `week.ts --climb=<final>` | CLIMB's final mobs, bands and death rates | LAB-NM4 (levels clamped to the band ceilings, checks at n = 400); the contract test; Q8's chance rule | — | 0.75 d |

**Total about 6.25 lane-days**, plus step 0's share (~0.5 d).

### 15.3 Hunt lenses (added to the wave's hunt)

- **A dead victim in the party gets the refund; a GM never does.** Avenge with the victim dead in town and in the
  party, then with an invisible GM hitting it.
- **A nemesis never appears inside the town circle, the springs or an instance.** Die at the town gate, in the
  springs, in the Tomb.
- **A restart during `away` does not shorten or lengthen the wait beyond its window**, and no notice fires at boot.
- **CLIMB's kind rename** (`MOB_CH_*` → `MOB_CL_*`) keeps living rows (the mapping table) or retires them with
  `content`.
- **The label never shows the wrong "YOUR NEMESIS"** after a relog, or after a victim's character is deleted and a
  new one takes the name (§2.6).
- **A party fight is never cut short.** Two players fight a field monster, one dies: it keeps fighting the other; if
  the other kills it, no nemesis; if the other runs, it is born when the monster gets home.
- **Rank by distinct accounts.** Three accounts feed one nemesis: it stops at III however many days pass between the
  kills.

## 16. Scope-cut order (cut from the top) and never-cut

1. The grudge list in the character window (the login line stays).
2. The minimap claw marker (the near toast stays).
3. The flame shroud at III+ (the glow stays on all ranks).
4. Given names at III+ (the user's form at every rank).
5. Time growth (kills only).
6. The Seal-of-Star chance at V.

**Never cut:**
- the user's title form ("Mangyang the Pixi-Slayer");
- persistence across restarts;
- the eligibility checks and caps (§2.1–2.2);
- the once-per-account rank rule;
- the vengeance refund (its size is content);
- the pending grudge (a friend's fight is never cut);
- the victim notices and the near hint;
- the calibration contract;
- the S-DEATH seam shared with the death penalty.

## 17. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **The death rate CLIMB lands at.** On CLIMB's draft (≈ 0.1 deaths/h, 3.3 in the whole climb for a mixed player) nemeses are rare: 1.5 a week for the live server, almost none below level 14. The first draft assumed 1 death/h (~10× more), so its "4 a week from level 3" and "rule #13 takes 15–30 % of play" do not hold | Chance 1.0 (F1); Q8's rule after NM-B re-runs `week.ts` on CLIMB's final rates; if CLIMB makes 1–13 deadlier, early grudges come back by themselves. |
| R2 | CLIMB's re-tuned monsters change every multiplier | NM-B re-calibrates; the targets are the contract (LAB-NM4). |
| R3 | The Berserk glow reads as "a berserk player" | User check; the fallback is the flame shroud at all ranks (scaled 0.4). |
| R4 | Retail skeletons without `Bip01 Spine1` put the aura in the wrong place | The anchor rule falls back to the **root (the feet)** [confirmed: `anchors.ts`]; the feature adds 0.5 × height itself; NM-C checks one beast, one ghost, one bandit. |
| R5 | Kill-stealing grudges on a busy night | Refund only for the victim's group; Q2 records the option of a priority window. |
| R6 | A notice storm at boot or after a long downtime | Boot returns spread over 2–5 min, silent; end notices are delivered once at login. |
| R7 | A wall-clock step back stretches a timer | Every timer is clamped to its window (as uniques' H11-CU-2). |
| R8 | CLIMB's packs: more deaths come from adds the victim never touched, so fewer pass the 10 % check (the model's 85 % is a guess) | The pack rule (§2.1); NM-B measures the pass rate in CLIMB's pack fights before the deploy. |
| R9 | The calibration's levels are unclamped and miss the Far Bank kinds | NM-B (F10, F11); `default` rows are refused by the content check. |
| R10 | Name collisions with CLIMB's mini-bosses, TOMB's bosses or the Qilin | NM-P's content check against every authored boss name (F12). |

## 18. Fact-check log (2026-10-02, second agent)

Every [confirmed] claim of the first draft was re-derived: the code facts against `gameplay.ts`, `spawner.ts`,
`uniques.ts`, `world.ts`, `formulas.ts`, `ai.ts`, `modules.ts`, `db.ts`, `config.ts`, `party.ts`, `social/guild.ts`,
`editors/live.ts`, `fx/anchors.ts`, `entities.ts`, `protocol.ts` (line numbers hold: 796, 988–1013, 1023–1074, 1057,
1129–1137, 1299); the data against `mobs.json` (20 of 22 kinds with a champion model), `live-nests.json` (700 nests,
6,093 nest monsters = 6,083 live with Tiger Girl's group spawning once, 11 areas), `fx/index.json` (the three EFPs
exist), `content/uniques.json`; the numbers by re-running `week.ts` (identical with the first draft's arguments),
`econ.ts` (identical), `cost.ts` (3×), one kind of `calibrate.ts`, the calibration medians from `calibration.json`,
and a new n = 400 check. Not re-measured: the fx viewer's batch counts (7 / 16) and the frame cost (the GPU lock was
held by another agent; LAB-NM1 measures it anyway).

| # | Finding | Fix |
|---|---|---|
| F1 | The week model assumed 0.3–1.0 deaths/h; CLIMB's draft has ≈ 0.1 (3.3 deaths in the 40 h climb, almost all at 14+). With the 30 % roll the live server would see **0.44 nemeses a week**, the first draft said 4.0 | Chance 1.0 (the user's words); §0, §2.1, §10 re-run on CLIMB's rates (`--climb=mix`) |
| F2 | The 24 h repeat window lets 3 accounts feed a nemesis to V in ~25 h; the draft's A3 claimed "IV at most" | Rank once per account over its life (§2.2, §2.4, A3) |
| F3 | Rank V's 25 % Seal of Star and +4 beat Tiger Girl (20 %, +3); ×2 at the live DROP_RATE | Seal only at V, 10 %; plus ≤ +3 (§5.2, `rules.ts` RANKS) |
| F4 | With every death making a nemesis, a 100 % refund returns 42 % of all rule-#13 losses | Refund 50 % (§2.5, §5.3, Q7) |
| F5 | "Rule #13 costs 15–30 % of play time" came from the draft's own death guess | CLIMB's run says 1–10 % at 15–19; R1 rewritten |
| F6 | The Tomb's instances are slots in the same world (`tomb/instance-cost.ts`, TOMB_DUNGEON §2), so "not a Tomb instance" can't be a world check | TOMB_DUNGEON's `Mob.instance` (S-ELIG, A10) |
| F7 | `uniques.isTracked(m)` does not exist (`tracked` is private) | Step 0 adds it |
| F8 | A monster that kills one of two fighting friends would vanish mid-fight, taking the other's damage | The pending grudge (§2.1 rule 6, N26) |
| F9 | CLIMB's draft fights in packs; the 10 % check on the killer drops add deaths | The pack rule (§2.1, N27); R8 |
| F10 | The calibration ran with unclamped levels | NM-B clamps (§4.1, LAB-NM4) |
| F11 | CLIMB's Far Bank adds 7 kinds the calibration and families miss; 2 have no champion model | NM-B, `rules.ts` families (Stinger, Reaver, Burner) |
| F12 | "Old Scar" is CLIMB's MB1; "the Last Warden" sat next to MB4; given names with "the" read twice ("the Weeping Lamp the Pixi-Haunter"); the longest plate is 39 (45 at ranks I–II with CLIMB's names), not "≤ 40" | Pools fixed, a content check against boss names (§3.1) |
| F13 | The cooldown flush every 60 s broke "events-only writes" | In memory, written at logout, stop and 0 (§7.2) |
| F14 | `rules.ts` had a `variant` column and a rank-I plus row that the doc did not; `cost.ts` inserted it | Aligned with §7.2, cost re-run |
| F15 | The n = 80 ranges were half noise (Young Tiger II solo 89 % → 79 % at n = 400); one kind would fail LAB-NM4 | n = 400 numbers in §0, §4.1; NM-B uses n = 200/400 |
| F16 | `content reload nemesis` does not exist | Start-only, like uniques.json (§7.3) |
| F17 | The Avenger counter had no column | Derived from `nemesis_victims.avenged`; the title through CLIMB §7.3's achievements (`nemesisSlain` event) |
| F18 | Names are unique only among live characters: a new "Pixi" could inherit "YOUR NEMESIS" | Deleted victims leave the list (§2.6, §8) |
| F19 | The aura anchor falls back to the root (feet), not 0.5 × height | §3.2, R4 |
| F20 | "Notices" counted events, not lines; the tick is 100 ms, not 50; the cost p99 is up to 2 ms on a busy PC; fight times 43/46/47 s | §3.3, §7.5, §4.1 |
| F21 | "Its home moves with its victories" had no bound: kills at the leash edge walk it 50 m at a time anywhere | Drift ≤ 100 m from the birth spot, same area (§2.3, A14) |
| F22 | CLIMB.md (written during this check) owns S-DEATH as `playerDied(p, now, killer)` plus a `penaltyTaken` event; the draft's `DeathCause.expLost` collided | Adopt CLIMB's shape (§6, §7.1) |
| F23 | CLIMB's Soul Rebirth refunds 50–100 % of the loss; with the nemesis refund on top, dying to your nemesis next to a Rebirth healer **gains** EXP | `penaltyRefunded` lowers the record (§5.3, §6, A15) |
| F24 | CLIMB D10 excludes nemesis kills from Rested and meals; the draft said they count | `restEligible` / `mealEligible` false (§5.1) |
| F25 | CLIMB §3.5 caps a nemesis kill at 10 % of a level; 27 of 110 kind × rank kills broke it | The EXP cap (§5.1) |
| F26 | TOMB_DUNGEON names the flag `Mob.instance` (its S-HOOK) | §2.1, S-ELIG |

---

## Appendix: scratch files (`work/tmp/nemesis/`)

| File | What |
|---|---|
| `model.ts` | The balance model as functions + `groupFight` |
| `power.ts`, `power-*.json` | One-table trials (A–D) |
| `calibrate.ts`, `calibration.json`, `calibration.log` | The per-kind calibration |
| `econ.ts`, `econ.json`, `econ.log` | Rewards vs grinding, the farm loop |
| `week.ts`, `week-p3/p8/p20.json`, `week-p3-<name>.json`, `month-p3.json`, `trace-p3-month.txt` | The week model (fact-check base), sweeps, a month trace |
| `first-draft/` | The first draft's week runs and traces (30 % chance, 1 death/h), kept for comparison |
| `check/` | The fact-check's scripts and outputs: `noise.ts`, `names.ts`, `cal-youngtiger.json`, three month traces |
| `rules.ts` | Migration SQL, families, generator, rank table |
| `cost.ts`, `cost.log` | The server cost bench (temp SQLite in the OS temp folder, deleted) |
| `charts.py`, `nemesis-*.png` | The images |
| `viewer.log` | The private fx viewer used to look at the aura candidates. It ran on :5391, was stopped, and the GPU lock was taken and released around it (10:09–10:16 UTC). |

Reproduce, from the repo root:
- `pnpm tsx work/tmp/nemesis/calibrate.ts` (≈ 2.5 min)
- `pnpm tsx work/tmp/nemesis/econ.ts`
- `cd work/tmp/nemesis && pnpm tsx week.ts --players=3 --runs=300 --climb=mix --chance=1 --repeat=life --refund=0.5
  --out=week-p3.json` (and `--players=8|20`, `--days=28 --runs=150`, `--deaths=`, `--seed=`, `--trace`; without
  `--climb` the first draft's death guess)
- `pnpm tsx work/tmp/nemesis/check/noise.ts --n=400` (≈ 30 s), `pnpm tsx work/tmp/nemesis/check/names.ts`
- `pnpm tsx work/tmp/nemesis/cost.ts`
- `python work/tmp/nemesis/charts.py`

Meshy: 0 credits. Downloads: none.
