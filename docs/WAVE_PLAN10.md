# Wave plan 10: wave 14, "The Climb" (levels 1–20 re-made, the Qin-Shi Tomb, nemesis monsters, the storm Qilin, rule #13)

This plan merges four fact-checked specs into one build order for wave 14:

- **docs/CLIMB.md** (the spine): seven bands drawn from the real map (B1 1–5 … B7 the Far Bank 17–20), 36 derived
  monsters on a standard curve with four data-driven roles (pack, ranged, healer, coward) and elite camps, a
  level-difference EXP rule, six band mini-bosses on the uniques module, Tiger Girl at BALANCE's U-BAL tuning as the
  capstone, a new `levels` table at ×1 rates, seven gear tiers from retail rows with set bonuses and named slots for
  waves 15 and 17, 24 number-only Arts, the user's death penalty (rule #13) with its grace, Incense, refunds and combat
  linger, post-cap goals (mentoring, achievements and titles, a bounty board), the questline re-paced with 13 new
  quests, the ferry to the far bank, and the migration of live characters.
- **docs/TOMB_DUNGEON.md** (band B6): the retail tomb interior (floors 1, 5, 6) as a lazily loaded `qin-tomb` export,
  instanced as 6 far-apart slots in the one World, three wings by band (15–16, 17–18, 19–20) with puzzles and three
  telegraphed bosses, personal chests with the in-band Emperor's Favour, lamps, the dark boss lamp, one live instance
  per character.
- **docs/NEMESIS.md**: a field monster that kills a player becomes that player's persisted, named nemesis ("Mangyang
  the Pixi-Slayer"), returns 20–40 min later one rank stronger, grows by distinct accounts and time, is calibrated per
  kind to group sizes, drops better loot, and refunds half of the rule-#13 loss it took when avenged.
- **docs/STORM_QILIN.md**: at the start of a scheduled storm a level-20 lightning Qilin lands on one of six real
  summits, bolts between them when hunters close in, is fought as a short telegraphed group boss with a lone-hunter
  rule, pays 10 % of each hunter's own bar, fragments, Thunderscales and a mount.

The user's words, verbatim:

> Silkroad Online retail never made level 1-20 fun. It just wasnt part of their plans since level 20 was never a cap.
> So let's make it fun. We adjust monster's levels and difficulty, also unique monster's. ... Level 20 should be
> difficult to reach since its a level cap. Currently is not difficult because retail never made it to be, but is also
> boring because again retail never meant for you to take long to get to 20.

> The Qin-Shi Tomb as the 15-20 group dungeon: the centrepiece of the new 1-20 journey.

> Nemesis monsters: a monster that kills a player levels up, gets a name and a title ('Mangyang the Pixi-Slayer'), and
> comes back stronger with better loot. Revenge becomes personal.

> A storm beast: during thunderstorms, a lightning Qilin appears on the mountain peaks for a short time, a rare chase
> across the map.

> after level 15 if player dies they loose a random % from 1% to 20%

Defaults Claude proposed and the user kept: about **40 hours** of real play to reach 20; solo-friendly to about 15,
the Tomb and big bosses need a group; rates back to **×1** with the new curve. New clothing and weapon art come in
waves 15 and 17; this wave defines the **gear tiers** and leaves **named slots** (§10).

**The user delegated every decision.** Wherever there is a choice, this plan takes the option it would mark
"(Recommended)" and writes it as a decision with a one-line reason (§2). Only what truly needs the user is left in §11
and §13, each with the default used meanwhile. **Delegation is not a deploy OK:** wave 14 deploys only after a **new
OK from the user** (D50). It also changes the live rates from ×3 to ×1, which is the user's call at deploy time.

This plan does what WAVE_PLAN9 did for wave 13:

- it settles every place where the four specs would give a file or a piece of state two owners (§2), with **one owner
  per shared module**: the spawner and nests, the uniques module, levels and EXP, drops and items, skills, the death
  path, the instances, the migrations, the wire, the client spine (§2.1, §2.2);
- it fixes the format additions (three migrations, the wire, the second world export, the content folders) in one list
  (§3);
- it lands **the seams first** (§4), on disjoint files, before any lane;
- it puts **the balance data and the simulation early**: CLIMB's content files are written in the pre-start, and this
  plan has already re-run the climb model with the three siblings' EXP on top (§5). That re-run moved the curve: the
  siblings' rewards took 5.8 h out of the 40, so levels 13–19 cost ≈ 18 % more (D30);
- it holds the sum against the server budget on the N100 (a dungeon instance, nemeses, the Qilin, the far bank) and
  the client's G1 (§6);
- it orders the lanes, the re-converts, the integration, a **balance soak with bots**, the bench, a hunt with lenses
  (balance exploits included), the fixers, a final gate and an independent verify (§7), migrates the 3 live accounts
  without loss (§8), and gives one scope-cut order with a never-cut list (§9), the named slots (§10), what the user
  approves (§11), risks (§12), open questions (§13), hooks and the deferred list (§14).

When this plan and a spec disagree, **this plan wins**. The specs stay the detailed design of each lane; a lane reads
its spec sections and this plan's row for it.

**Tags** (as in WAVE_PLAN9):

- **[confirmed]**: checked in the code or data of the working tree on 2026-10-02, measured by a spec's prototype and
  re-derived by its fact-check, or computed by this plan's own scripts. Each one says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived), or the output of a balance model; not
  observed in play.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this plan makes. The user may overrule it.

**Repo state when this was written [confirmed: `git log`, `git status`, `pnpm tsx` on `db.ts`, 2026-10-02].**

- HEAD `2b7450b` ("Wave 12 step 0: seams …"). **Wave 12 is building in the working tree, uncommitted** (95 changed
  paths: `packages/world-render`, `packages/convert` trees and edits, `packages/texpipe`, `content/trees`, …).
  **Wave 13 is designed (WAVE_PLAN9) and builds next.** Wave 14 builds on wave 13's final commit (D1).
- The four specs are in `docs/` (untracked) and fact-checked. This plan edits none of them.
- **The database is at schema 10** (`SCHEMA_VERSION = MIGRATIONS.length` = 10, read through `pnpm tsx`); wave 13 takes
  11–13 (WAVE_PLAN9 D5); wave 14 takes **14–16** (D5).
- Code facts this plan leans on, re-read: `playerDied(p: Player, now: number)` has no killer (`gameplay.ts` 1129, its
  callers 1012 and 1299); `Uniques.tracked` is private (`uniques.ts` 531); `World.warp` clamps to the world bounds
  (`world.ts` 469–477); `nav.ts` `setHome` takes one point (257); `connection.ts` `leaveWorld` removes the character at
  once (136, 243–245); no `telegraph` and no player `title` in `protocol.ts` (only `stallText.title`).
- **Meshy: 0 credits** were spent by the four designs and this plan; the build plans **0** (D49). No download.
- This plan's scratch: `work/tmp/w14-plan/merged.ts` (the merged balance re-run: it extends CLIMB's model, which
  extends `work/tmp/balance/sim.ts`; output `merged.json`), `budget.py` (the §6 and §7.2 arithmetic),
  `make_preview.py` (the preview sheet `work/tmp/w14-preview.png`, also in Dropbox `wave14/w14-preview.png`).

---

## 0. Summary

1. **Four items, one seam step.** Seven foundation agents run first, in parallel, on disjoint files, from the
   **wave-13 final commit** (after G-13 and V-13; D1): **W14-PR** (the wire for all four specs, one telegraph message
   for the Tomb and the Qilin), **W14-CL** (`packages/shared/src/climb.ts`: `deriveMobs`, the standard curve, the
   level rule, the penalty maths), **W14-SV** (the server spine: the death path, the EXP hooks, the loot chain, `Mob.tag`,
   `levelAdd`, per-area clamping, the linger hook, the mentoring rule, all three migrations, config and GM rows),
   **W14-SP** (the spawner, nav and uniques spine: the remap, release/pause, two home components, the composite nav,
   every uniques-module addition), **W14-CV** (the converter spine: the second export command, the authored merge
   extended to mobs/skills/cos, the extra-mobs list), **W14-WR** (the interior branch and the beacon slot in
   world-render) and **W14-G** (the game spine: the stage origin and switch, the nameplate lines, the notice events,
   the client content load). Work that needs no shared file starts **at once, while waves 12 and 13 build**: CLIMB's
   content files, the DOF reader and the tomb export, the Qilin's art, the nemesis re-calibration (§7.0).
2. **One owner per shared module** (§2.1): the spawner and nests → **W14-SP** (then frozen; the remap data is
   **CL-D**'s); the uniques module → **W14-SP** (then frozen; `content/uniques.json` **CL-D**); levels and EXP →
   **W14-CL** (maths) + **CL-D** (`content/climb/levels.json`) + **W14-SV** (the hooks); drops and items → **W14-CV**
   (the merge) with one writer per item and drop file; skills → **CL-A** only; the death path → **W14-SV** (seam) +
   **CL-K** (the penalty module); the instances → **TB-S** (module) on **W14-SV**'s clamp, **W14-SP**'s composite nav
   and **W14-G**'s stage origin; the migrations → **W14-SV**; `weather.ts` → **QL-W**; `jangan.json` → **CL-Q**;
   `npcs.override.json` → **CL-S**.
3. **Formats (§3):** three migrations (**14** CLIMB: `characters.curve_version/title/arts` + `char_achievements`;
   **15** TOMB: `tomb_progress`; **16** NEMESIS: `nemeses`, `nemesis_victims`, `nemesis_accounts`), all landed by
   W14-SV in step 0; the Qilin needs none (a row in the wave-11 `uniques` table). Additive wire (protocol v1). A second
   world export, `qin-tomb`, loaded on the first entry (≈ 10–13 MB [projected]). Content under
   `content/{climb, tomb, events, nemesis.json, items, mobs, skills, cos, quests, npcs}`.
4. **Balance, merged (§5)** [projected: `merged.ts`, 400 bot friends per profile, CLIMB's model on the server's own
   formulas]: on CLIMB's run-5 curve, the Tomb's daily Favour (−4.6 h), the Qilin (−1.5 h) and the nemesis refund
   (−0.7 h) take the mixed friend from **41.8 h to 36.0 h**. **Decision D30: levels 13–19 cost more on a ramp (×1.18
   at 15–19), 1 → 20 = 1,679,506 EXP**: the mixed friend's median is **40.1 h** (seeds 7 and 42: 40.0, 39.9; p10 36.8,
   p90 43.6), levels 15 → 20 take 27.8 h, solo-only 57 h, mostly grouped 35.6 h. The Tomb's trash EXP knob becomes
   per wing (I 1.8, II 3.2, III 2.2) so a repeat run pays 0.9–1.15× CLIMB's solo hour (D31).
5. **Budgets (§6):** **server on the N100, 4 tomb parties + 8 field bots + 8 nemeses + a Qilin event ≈ 5 ms mean,
   ≈ 10 ms p99 of the 100 ms tick** [projected: TOMB's measured 1.43 / 2.72 ms dev PC × 2.5 + the others' projected
   shares]; memory 750 → ≈ 820–850 MB. **Client G1:** the tomb's interiors are cheaper than the field (≈ 4–7 ms
   WebGPU Medium [projected]); nemeses ≤ +0.15 ms; the Qilin ≤ 0.2 ms plus its crowd; CLIMB ≈ 0; the far bank and the
   summit view are **[unknown]** and get LAB rows. Every existing LAB scene unchanged.
6. **Order (§7):** pre-start (new files only) → step 0 seams → step 1 the lanes in parallel → checkpoint **X1** (the
   `qin-tomb` export, the merges, the derived roster live, **BAL-1**: the climb model, the tomb sim and the nemesis
   calibration re-run on the real content files) → step 2 the dependent lanes → **X2** → **I-14** integration →
   **BAL-14** balance soak with bots → **LAB-14** + **S-14** (server bench) → **H-14** hunt (24 lenses, balance
   exploits included) → **F-14** fixers → **G-14** final gate → **V-14** independent verify → the user's checks →
   **deploy only on the user's new OK**.
7. **Never cut** (§9): the re-levelled bands with real difficulty (roster, roles, level rule, mini-bosses MB3–MB7,
   Tiger Girl as capstone), the EXP curve to ≈ 40 h at ×1, **the user's death penalty exactly as stated** (15+, 1–20 %
   of the current bar, never a de-level, never duels or the arena, monsters and bosses only, the message), the Tomb
   (instanced, 2–4 at 15+, Wings I and III at least, telegraphs, chests, lamps), nemeses (the user's title form,
   persistence, comes back stronger, better loot, the refund), the storm Qilin (the storm trigger, peaks, the chase,
   the group fight), the migration without loss, G1.
8. **What the user must do (§11):** nothing blocks the start; no download, no Meshy. Look at the preview sheet; after
   the build, ≈ 2 h of play checks; confirm the penalty's three safety nets; give the **deploy OK**, which includes a DB
   backup, three migrations, and the live rates from ×3 to ×1.

### 0.1 Where each user request lands

| User request (verbatim fragment) | Where | Lanes |
|---|---|---|
| "We adjust monster's levels and difficulty" | CLIMB §2.1–§2.4: seven bands, 36 derived monsters, four roles, elite camps, the level rule | W14-CL, W14-SP (remap), CL-D, CL-R |
| "also unique monster's" | CLIMB §2.5–§2.6: six band mini-bosses, Tiger Girl at U-BAL; the Tomb's three bosses; the Qilin | W14-SP (uniques), CL-D, TB-B, QL-S |
| "Level 20 should be difficult to reach" | §5: the merged curve (40.1 h, 15 → 20 = 27.8 h); CLIMB §2.4 deaths at 14+; rule #13; the in-band Favour | CL-D, BAL-1, BAL-14 |
| "but is also boring" | CLIMB roles, gear tiers, Arts, bounties, post-cap goals; the Tomb's puzzles; nemeses; the Qilin | all |
| "The Qin-Shi Tomb as the 15-20 group dungeon" | TOMB §2–§7 | TB-* |
| "the centrepiece of the new 1-20 journey" | the questline enters the Tomb at 15 (JG_X15), its story at 17 and 19 (JG_T02, JG_T03); its chests carry the band's best gear | TB-Q, TB-L, CL-Q |
| "a monster that kills a player levels up, gets a name and a title" | NEMESIS §2.1–§2.4, §3.1 | NM-* |
| "comes back stronger with better loot" | NEMESIS §2.3, §4, §5.2 | NM-S, NM-B |
| "Revenge becomes personal" | NEMESIS §2.5 (the refund), §3.3–§3.4 (notices, the near hint) | NM-S, NM-C |
| "during thunderstorms, a lightning Qilin appears on the mountain peaks for a short time" | STORM_QILIN §2–§3 | QL-W, QL-S, QL-Q |
| "a rare chase across the map" | STORM_QILIN §4 | QL-S, QL-C |
| "after level 15 if player dies they loose a random % from 1% to 20%" | CLIMB §6 as built by CL-K; every sibling's deaths count (D10) | W14-SV, CL-K |
| (defaults) ≈ 40 h, solo to ≈ 15, groups for the Tomb and big bosses, ×1 | §5; D30; D50 | CL-D, BAL-14 |
| new clothing and weapon art in waves 15 and 17 | §10: the named slots and the items banked now | CL-D, TB-L, QL-Q |
| standing goal "at least 60 fps" | §6.2–§6.5: G1 with five new scenes and two [unknown] rows | LAB-14, G-14 |

### 0.2 What the specs' fact-checks changed, and this plan takes as given [confirmed: each spec's fact-check section]

| From | Change | Where it lands here |
|---|---|---|
| CLIMB F1 | Mentoring: a capped member's weight 0 **and** a kill pays the party pool × the uncapped members' damage share, floor 25 % | W14-SV (`party.ts`), D33 |
| CLIMB F2 | Both ferry sellers are on the town's bank; a far-bank ferryman; any level may cross (warning below 17) | CL-S |
| CLIMB F3 | The area remap needs a nearest-band fallback, per-nest overrides and two new B5 rows (36 rows) | W14-SP (the mechanism), CL-D (the data) |
| CLIMB F4 | JG_013's hints move to the Chinese Tomb | CL-Q |
| CLIMB F5, NEMESIS F23 | `penaltyRefunded`; all refunds of one death capped at its loss | CL-K, NM-S; D9 |
| CLIMB F6 | The 10 s combat linger at 15–19 | W14-SV (hook), CL-K (rule) |
| CLIMB F7 | The springs' trip charged: run 5's curve gives 41.6 h | §5 (this plan's base row charges it: 41.8 h) |
| CLIMB F8, NEMESIS F24 | The two docs crossed on nemesis Rested eligibility | **D23: nemesis and Qilin kills are not eligible** |
| CLIMB F9 | Four uniques-module additions (area notices, an adds table, authored camps, `look`) | W14-SP |
| CLIMB F10 | A set family is a degree (any grade) | CL-A |
| TOMB F1, F2 | Per-area `World.clamp`; a client stage origin | W14-SV, W14-G; D17, D18 |
| TOMB F3 | Fury at 9 / 10 / 12 min | TB-B; re-checked at BAL-1 |
| TOMB F4, F10 | Favour bands without overlap; a per-level % table (10.7 / 7.7 / 6.1 / 5.4 / 3.5 %) | TB-S; in §5's re-run |
| TOMB F5–F7 | Dark boss lamp; one live instance per character; joiners re-checked, chests need presence at the pull | TB-S |
| TOMB F8 | The NPC is **Tomb Steward Baek** (MB4 stays "the Gate Warden") | D27 |
| TOMB F9 | One `trashExpMul` knob, set by the merged re-run | **D31: per wing 1.8 / 3.2 / 2.2** |
| TOMB F11, NEMESIS F6/F26 | `Mob.tag = 'instance'`, not `Mob.instance` | D8 |
| TOMB F12 | The Tomb's entry quest is **JG_X15** in `content/quests/tomb.json` | D26 |
| TOMB F13 | W15-A is CLIMB's six-piece slot (shown as the Terracotta Regalia); the Broken Hilt is the hilt of W17-B | §10 |
| NEMESIS F1–F4 | Chance 1.0; rank once per account ever; Seal only at V (10 %, ≤ +3); refund 50 % | NM-S, NM-P |
| NEMESIS F8, F9, F21 | Pending grudge; the pack rule; home drift ≤ 100 m | NM-S |
| NEMESIS F25 | A nemesis kill pays at most 10 % of a level per member | NM-S |
| QILIN F1 | The lone-hunter rule (×0.6 damage taken while one player hits it) | QL-S |
| QILIN F2 | EXP = 10 % of each credited hunter's own bar (the row's `exp` is 0) | QL-S; in §5's re-run |
| QILIN F5 | `town-sound.ts` rings on every `appeared`; `UNIQUE_CUES` fails the build until new events are added | W14-G (D19) |
| QILIN F9 | Per-hunter rewards from the damage map, dead or alive, level ≥ 15 | QL-S |
| QILIN F10 | The summit clearing (`Spawner.pause`) | W14-SP (seam), QL-S |
| QILIN F11 | No QL-T: titles are CLIMB's achievements; QL-S emits `qilinCaught` | CL-U; D28 |

### 0.3 Meshy and downloads

No item of this wave needs Meshy: the Tomb is retail geometry, the nemesis look is retail champion models and EFPs,
the Qilin is a retail Demon Horse with a texture recolour and a bpy horn, CLIMB adds no art [confirmed: each spec's
ledger, 0 credits]. **Build cap 40, planned 0** (D49); nothing is downloaded (the retail tomb, the Demon Horse sounds
and every particle are already in `work/extracted` or `work/out`).

---

## 1. Lane ids

| Id | Step | From spec | What |
|---|---|---|---|
| **W14-PR** | 0 | all four (CLIMB S-TITLE, TOMB S-WIRE, NEMESIS §8, QILIN QL-0) | `packages/shared/src/{protocol, validate, content, quests, content-check, index}.ts`: every wave-14 wire addition, content types, PROTOCOL.md |
| **W14-CL** | 0 | CLIMB CL-P (minus the wire) | `packages/shared/src/climb.ts` (new): `deriveMobs`, the standard curve, the level-difference factor, the penalty roll, set counting; the `content/climb/*.json` checks |
| **W14-SV** | 0 | CLIMB CL-SV (part), NEMESIS step 0, TOMB S-HOOK, QILIN seams | the server spine: `gameplay.ts`, `modules.ts`, `world.ts`, `party.ts`, `connection.ts`, `db.ts`, `config.ts`, `gm.ts` |
| **W14-SP** | 0 | CLIMB CL-SV (part), NEMESIS S-RELEASE/S-ELIG, TOMB S-NAV, QILIN `pause`/exports/`reusable` | `spawner.ts`, `nav.ts`, `composite-nav.ts` (new), `game.ts` (load), `uniques.ts`, `mounts.ts` |
| **W14-CV** | 0 | TOMB TB-CV (hooks), QILIN QL-Q/QL-A (hooks) | `packages/convert`: the `sro convert-dungeon` command slot, manifest fields, `data/authored.ts` extended to mobs/skills/cos, the extra-mobs hook in the mob export, sound export rows |
| **W14-WR** | 0 | TOMB TB-R (hook), QILIN QL-R (hook) | `packages/world-render`: the `manifest.interior` branch in `world.ts` with an interior part stub, the beacon slot in `weather/index.ts`, budget and warm-up registrations |
| **W14-G** | 0 | TOMB S-STAGE, NEMESIS/CLIMB/QILIN client seams | `apps/game`: stage host + stage origin, the client content load with `deriveMobs`, feature and i18n registrations, the nameplate extra-lines hook, `hud/unique-notice.ts` + `town-sound.ts`, the mock server fields |
| CL-D, CL-R, CL-K, CL-A, CL-Q, CL-S, CL-U, CL-G | 1 (CL-D: pre-start) | CLIMB §17.2 | data, roles, penalty, Arts + sets, quests, ferry + far bank, achievements + titles, client |
| TB-CV, TB-S, TB-M, TB-B, TB-P, TB-L, TB-Q | 1 (TB-CV: pre-start) | TOMB §16.2 | converter, module, monsters, bosses, puzzles, loot, story |
| TB-TG, TB-R, TB-G | 2 | TOMB §16.2 | telegraph decals (for the Qilin too), interior render, game |
| NM-P, NM-S, NM-C | 1 | NEMESIS §15.2 | shared + content, server, client |
| NM-B | pre-start (scratch) + 2 | NEMESIS §15.2 | the per-kind calibration on CLIMB's roster |
| QL-W, QL-S, QL-Q, QL-A, QL-R, QL-C | 1 (QL-A: pre-start) | STORM_QILIN §11.2 | weather hold, module, content, art, beacon render, client |
| **BAL-1** | X1 | this plan §5.4 | the three models re-run on the real content files |
| **I-14** | 3 | the specs' integration rows | integration, re-converts, docs, the deploy list |
| **BAL-14** | 3 | CLIMB §17.3, TOMB X1 bot run, QILIN §11.3 | the balance soak with bots on a private server |
| **LAB-14**, **S-14** | 3 | TOMB §10.3/§16.3, NEMESIS §11, QILIN §10.2, CLIMB §11 | the client bench and the server bench |
| **H-14**, **F-14**, **G-14**, **V-14** | 3 | — | the hunt, fixers, final gate, independent verify |

**Dropped or folded ids:** CL-P (→ W14-PR + W14-CL); CL-SV (→ W14-SV + W14-SP; its uniques and spawner work to
W14-SP); TOMB's S-NAV/TB-NAV (→ W14-SP), S-HOOK (→ W14-SV), S-WIRE (→ W14-PR), S-STAGE (→ W14-G); NEMESIS's step-0
list (→ W14-PR, W14-SV, W14-SP); QL-0 (→ W14-PR); QL-T (dropped by its fact-check; CL-U owns titles).

---

## 2. Conflicts and gaps across the specs, with decisions

### 2.1 Architecture and file ownership

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| D1 | When wave 14 starts | all four | Waves 12 and 13 are not committed; wave 14 needs wave 13's S-REWARD list, `restEligible`/`mealEligible`, the authored-items merge, `openShore`, the Tomb Seal Shard | **Step 0 starts from the wave-13 final commit (after G-13 and V-13)** [decision]; every seam agent re-reads its files there. **At once, before it, new files only:** CL-D's `content/climb/*.json` (a new folder), TB-CV's `packages/formats/src/dof.ts` and `packages/convert/src/dungeon/**` (new) writing to a scratch output, QL-A's `packages/convert/src/tools/qilin/**` (new), NM-B's calibration in scratch on CL-D's roster. Reason: no seam rebased onto an uncommitted tree (WAVE_PLAN9 D1); the long converter and data items leave the critical path. |
| D2 | **The wire** (`protocol.ts`, `validate.ts`, `content.ts`, `quests.ts`, `content-check.ts`) | CLIMB S-TITLE, TOMB S-WIRE, NEMESIS §8, QILIN §9.1 | Four specs add to the same files | **W14-PR lands every addition in one commit (§3.1)**; afterwards only I-14 edits them. Each spec's own shared file (`climb.ts` W14-CL, `nemesis.ts` NM-P, `tomb-beam.ts` TB-P) is its owner's. Reason: one agent for the wire (WAVE_PLAN9 D2). |
| D3 | **Telegraphs** | TOMB §5.7 (`telegraph`, a pooled decal), QILIN §8.3/§9.1 (`qilinVolley`, `TargetDecal`) | Two messages and two decal paths for the same idea | **One `telegraph` message** (shapes `circle`, `cone`, `line`, `ring`, plus `points?` for several circles of one radius) **and one client pool** (`apps/game/src/world/telegraph.ts`, TB-TG, ≤ 12 live); `qilinVolley` is dropped and QL-C calls TB-TG's pool [decision]. Both modules hit through `Gameplay.dealHits` with the boss as the attacker, testing the **server position at release**, and the client draws shapes 0.3 m larger. Reason: one wire name, one fairness rule, one draw budget. |
| D4 | **The server spine** (`gameplay.ts`, `modules.ts`, `world.ts`, `party.ts`, `connection.ts`, `config.ts`, `gm.ts`) | all four | Every spec wants these files | **W14-SV lands every hook in step 0** (§4.3); afterwards only I-14 edits them. Reason: one owner per spine file. |
| D5 | **Migrations** | CLIMB (one), TOMB (one), NEMESIS (one), QILIN (none) | Three numbers to assign after wave 13's 11–13 | **14 = CLIMB** (`characters.curve_version`, `title`, `arts`; `char_achievements`), **15 = TOMB** (`tomb_progress`), **16 = NEMESIS** (`nemeses`, `nemesis_victims`, `nemesis_accounts`), verbatim from the specs, all landed by **W14-SV** in step 0 [decision]. The Qilin's state is a row in the wave-11 `uniques` table. Tests step from 13 to `SCHEMA_VERSION`. Reason: the order of dependence (achievements first; the nemesis tables reference characters and accounts only); one writer of `db.ts`. |
| D6 | **The spawner and nests** | CLIMB S-REMAP + overrides + fallback + authored camp nests + the far bank home; NEMESIS S-RELEASE + `tracks`; QILIN `pause`/`resume` | Three specs edit `spawner.ts` | **W14-SP owns `spawner.ts` in step 0** and lands all of it: the remap at nest load and for summons (`(area, retail code) → derived code`, then `nests: {id: code}` overrides, then the nearest-band fallback), authored nest rows merged into `data.nests` at load (the mini-bosses' camps), `release(id, now)`, `tracks(id)`, `pause(ids, untilMs)`/`resume(ids)` (a GM `/nest` edit wins) [decision]. With `content/climb/` absent the spawner behaves as today (a byte-identical spawn test). Afterwards only I-14 edits it; **CL-D owns the data** (`content/climb/bands.json`). Reason: one owner for the module every other spec leans on. |
| D7 | **The uniques module** | CLIMB F9 (area notices, `adds`, authored camps, `look`), NEMESIS (`isTracked`, reuse of `gearPool`/`rollUniqueDrops`), QILIN (exports: resolver, notice sender, row I/O), TOMB (the Ward charm: −10 % damage from one mob code to a holder) | Four specs edit `uniques.ts`; CLIMB F9 found no owner | **W14-SP owns `uniques.ts` and `UniqueDef` in step 0** and lands all four sets [decision]; afterwards it is frozen (I-14 only). `content/uniques.json` (Tiger Girl's U-BAL tuning, the six mini-bosses) is **CL-D**'s. The Qilin's state row is QL-S's at runtime; its def is authored content (`content/mobs/storm.json`, QL-Q). Reason: one owner of the boss plumbing. |
| D8 | **Eligibility flags** | NEMESIS S-ELIG (`Mob.tag`), TOMB (`Mob.instance` → tag), QILIN (`'event'`) | Two names for the tomb flag | **`Mob.tag?: 'boss' \| 'event' \| 'elite' \| 'encounter' \| 'summon' \| 'instance'`** in `world.ts` (W14-SV); the Tomb sets `'instance'`, the Qilin `'event'`, the uniques module `'boss'` for its mobs, elite-camp leaders `'elite'`, summoned adds `'summon'`; `Mob.instance` is not added [decision]. Reason: one field every module reads. |
| D9 | **The death path** | CLIMB S-DEATH (`playerDied(p, now, killer)`, `penaltyTaken`, `penaltyRefunded`, the linger), NEMESIS (records the loss net of refunds), TOMB (`respawnPoint`), QILIN (its hits through `dealHits`) | Four users of one function | **W14-SV lands** `playerDied(p, now, killer)` with the killer passed from every caller (melee, skill, DoT tick → its caster, `gmKill` → `'gm'`), the module hook's third argument, the `respawnPoint?(p)` module hook, and a `leaveWorld` linger hook in `connection.ts`. **Module order in `playerDied`:** `penalty` (CL-K) → `nemesis` → `tomb` → `achievements` [decision]. **Respawn:** the first module that returns a point (the tomb's lamp), else town. **CL-K owns** the penalty rule, the grace, the Incense, the refunds, the linger predicate and the two bus events; **every refund of one death** (Soul Rebirth, the nemesis) is capped at its loss through `penaltyRefunded`. Reason: one seam, one order, no refund above the loss. |
| D10 | **What rule #13 counts** | CLIMB §6.1, TOMB §3.6, NEMESIS §6, QILIN §6.6 | Each sibling restated it | **One rule, CL-K's:** levels 15–19, a death whose killer is a monster or a boss (field monsters, champions, giants, elites, mini-bosses, uniques, nemeses, the Qilin and its volleys, tomb monsters, bosses and their traps and pools), 1–20 % of the current bar (server RNG), never below the bar's start, on death (so a resurrection can refund), never a duel, arena, GM kill or sanctuary death, at 20 nothing; the message and the party line verbatim from CLIMB §6.1 [the user's rule; decision on the details]. Reason: the user's rule stays one plain rule. |
| D11 | **The kill EXP order** | CLIMB S-EXP (level factor), WAVE_PLAN9 D6 (meal, Calm, Rested), NEMESIS (×hpMul, 10 % cap), QILIN (module pays 10 % of own bar), TOMB (Favour, trash ×mul) | Five sources on one kill | **`e = rated(def.exp × variant × tuning.expMul × levelFactor(playerLevel, mobLevel))`** per share (the factor per member, inside `e`), then WAVE_PLAN9's `e + round((meal + calm) × e) + rest(e)` when the predicates allow. **Module payments outside S-REWARD:** the Emperor's Favour and the Qilin's share are rated by `EXP_RATE` (and the Qilin's SP-EXP by `SP_RATE`), never Rested or meals; the nemesis refund is **not** rated (it returns EXP that was taken); quest EXP as today. The nemesis cap (10 % of a level per member) is applied after the level factor. Written once in W14-SV's hooks [decision]. Reason: one formula; each sibling's number keeps its meaning. |
| D12 | **Levels and EXP** | CLIMB §3 (the table), TOMB (bands of the bar), QILIN (own bar), NEMESIS (caps by level) | The curve is read by five modules | **`content/climb/levels.json` is the one table** (CL-D; the D30 rows); `GameData.expToNext` reads it when present, else `work/out/data/levels.json`; the client's skill window reads the same file. The maths (level rule, standard curve, penalty roll) is **W14-CL**'s pure `climb.ts`; `TYPICAL_SP_BY_LEVEL` is regenerated from the table by CL-D's script. Reason: every bar-fraction reward follows one curve. |
| D13 | **Skills** | CLIMB S-ARTS (`skills/engine.ts`), TOMB (boss specials), QILIN (volleys), authored MSKILL rows | Only CLIMB needs the engine | **CL-A is the only lane that edits `apps/server/src/skills/**`** (one Art-mod lookup per resolved row, two conditional branches for Executioner and Pinning Shot). Boss specials and volleys are **module scripts** through `dealHits`, not skill rows. The Tomb's `MOB_TQ_*` MSKILL rows come through TB-CV's extra-mobs list, the Qilin's three rows through the authored merge (`content/skills/storm.json`) [decision]. Reason: one owner of the engine; no special in the skill tables. |
| D14 | **Items, drops and the authored merge** | CLIMB (Incense, slot rows, drops.json), TOMB (tokens, Hilt, Vial, Seal, chests), NEMESIS (loot via uniques helpers), QILIN (scales, horn, bridles, a drop table; the merge extended to mobs/skills/cos) | Wave 13's `data/authored.ts` merges items, shops, NPC defs only | **W14-CV extends `data/authored.ts`** to `content/{mobs, skills, cos}/*.json` in step 0 (a retail-code collision, a missing model or icon are errors, as for items). **One writer per file:** `content/items/climb.json` (Incense, the bounty items, the quest curios) **CL-D**; `content/climb/slots.json` (W15/W17 rows, `enabled: false`) **CL-D**; `content/items/tomb.json` (Regalia tokens, the Hilt, the Vial, the Seal) **TB-L**; `content/items/storm.json` + `content/{mobs, skills, cos}/storm.json` **QL-Q**. **Drop tables:** `content/climb/drops.json` CL-D, `content/tomb/loot.json` TB-L, the nemesis per-band tables in `content/nemesis.json` NM-P (rolled by NM-S), the Qilin's in `content/events/storm-qilin.json` QL-Q. **The loot chain** in `gameplay.ts` (W14-SV): `uniques.drops(m) ?? qilin.drops(m) ?? nemesis.drops(m) ?? normal` [decision]. Reason: one merge, one writer per file, one provider order. |
| D15 | **Navigation and the far bank** | CLIMB S-NAV2 (two home components), TOMB S-NAV (`composite-nav.ts`, the tomb's home) | Two specs touch `nav.ts` | **W14-SP owns `nav.ts`** (the home becomes a list of components, read from `content/climb/bands.json` landing points and from the tomb's manifest), the new **`composite-nav.ts`** (routes by x: below `TOMB_X0` the field mesh, above it the tomb mesh with x − slot origin; tomb surface keys prefixed `tomb:`) and its load in `game.ts` [decision]. Reason: one owner of walking rules. |
| D16 | **Instances** | TOMB §2.2 | Slots in one World need three seams | **TB-S owns `apps/server/src/tomb/**`** (lease, lifecycle, entry rules, lamps, chests, the Favour); it stands on W14-SV's per-area clamp, W14-SP's composite nav, W14-G's stage origin and W14-PR's `ServerInfo.dungeons`. No other lane creates instances. Reason: the instance rules live in one module. |
| D17 | **Per-area clamping** | TOMB F1 | `World.warp`/`moveEntity` clamp to the field's bounds | **W14-SV** in `world.ts`: `World` holds a list of areas (the field plus one rectangle per slot from the `qin-tomb` manifest); a move is clamped into the area of the mover's position, a warp into the area of its target; a saved position in tomb space is restored inside its slot before the tomb's `enter` hook warps it to the Steward [decision]. With no dungeon loaded, byte-identical (a test). Reason: tomb space does not work without it. |
| D18 | **The client spine** | TOMB S-STAGE, NEMESIS NM-C (`entities.ts`, banner reuse), CLIMB CL-G (title line, content load), QILIN F5 (`unique-notice.ts`, `town-sound.ts`) | Three lanes want `entities.ts`; two want the notice files | **W14-G lands in step 0:** the stage switch by position and the **stage origin** (`toLocal`/`toWire` at the network boundary; the field keeps origin 0), the client content load running `deriveMobs`, a **nameplate extra-lines hook** in `world/entities.ts` (a title line, a subtitle line, a class, a colour override, pips), the new `uniqueNotice` events with their cues and a **town-alarm skip list** (the Qilin's code) in `hud/unique-notice.ts` and `world/features/town-sound.ts`, the feature stubs (`climb`, `tomb`, `telegraph`, `nemesis`, `qilin`) and i18n files registered, the mock server's wave-14 fields [decision]. Afterwards CL-G, NM-C, QL-C, TB-G and TB-TG own only their own files. Reason: WAVE_PLAN9 D26's rule. |
| D19 | **The world-render spine** | TOMB TB-R (interior profile), QILIN QL-R (beacon) | `world.ts` and `weather/index.ts` | **W14-WR lands** the `manifest.interior` branch in `world.ts` (no sky, sun, shadows, ocean, terrain, grass, weather or night splat; an interior part stub; the far plane at the fog end), a `beacon` slot exported from `weather/index.ts`, the new define sets in `material-budgets.test.ts` and warm-up hooks [decision]. TB-R then owns `interior.ts` and the quicksilver material, QL-R `weather/beacon.ts`. Reason: one agent on the world object. |
| D20 | **The converter spine** | TOMB TB-CV, QILIN QL-A/QL-Q | `cli.ts`, the mob export, the sound list, the merge | **W14-CV lands** the `sro convert-dungeon <name>` command slot, `manifest.interior` and `manifest.slots`, the extra-mobs hook in the mob export (the `MOB_TQ_*` bases and their MSKILL rows), the authored merge extension (D14), the five `wcm_dhorse_*` sound rows [decision]. TB-CV owns `packages/formats/src/dof.ts` and `packages/convert/src/dungeon/**`; QL-A owns `packages/convert/src/tools/qilin/**`. With the new inputs empty the field export is byte-identical (G7). |
| D21 | **The weather** | QILIN QL-W (`eventHold`, `stormStarted`) | Fishing and the sea read the weather | **QL-W is the only lane that edits `apps/server/src/weather.ts`**; the event hold sits below a GM hold; `stormStarted` reads the schedule, not the held target [decision]. Fishing and the sea read the state unchanged (a held storm adds ≈ 0.15 % storm time, accepted by QILIN §2.3). |
| D22 | **Quests** | CLIMB CL-Q (`jangan.json`: EXP, gold, 13 new quests, JG_013), TOMB TB-Q (JG_X15, JG_T02, JG_T03), QILIN QL-Q ("The Bridle of Storms" in `jangan.json`) | Two writers of `jangan.json` | **CL-Q is the only writer of `content/quests/jangan.json`** and of the quest engine's base-code match; **TB-Q** writes `content/quests/tomb.json` (JG_X15, JG_T02, JG_T03); **QL-Q** writes `content/quests/storm.json` ("The Bridle of Storms", moved out of `jangan.json`) [decision]. The engine loads every `content/quests/*.json` [confirmed there: TOMB §8]; a check refuses an id defined twice. Reason: one writer per file. |
| D23 | **Rested and meals for nemesis and Qilin kills** | CLIMB D10 after F8 (nemesis eligible), NEMESIS §5.1 after F24 (not eligible), QILIN (not eligible) | The two fact-checks crossed | **Neither nemesis nor Qilin kills are eligible** (`restEligible`/`mealEligible` false); mini-bosses, Tiger Girl and tomb kills are [decision]. Reason: both are fixed rewards with a 10 %-of-a-level cap that a +50 % Rested share would break; the Rested pool is a daily budget, so nothing is lost, only spent elsewhere. |
| D24 | **NPCs** | CLIMB (the far-bank ferryman, Doji/Chau lines), TOMB (Steward Baek, the shade, six steles), QILIN (the stable keeper's quest line) | `content/npcs.override.json` and authored NPC defs | **CL-S is the single writer of `content/npcs.override.json`** (TB-Q hands its rows); authored `NpcDef` rows go through the merge in `content/npcs/climb.json` (CL-S) and `content/npcs/tomb.json` (TB-Q); dialogs live in each module [decision]. Reason: wave 13's single-writer rule for placements. |
| D25 | **The title system** | CLIMB §7.3, TOMB (first kills), NEMESIS (Avenger), QILIN (Stormchaser) | One system | **CL-U's `achievements.ts`** is the only title system; the siblings emit bus events (`tombBossSlain`, `nemesisSlain`, `qilinCaught`, `penaltyTaken`, `fishCaught`); `EntityState.title` (W14-PR); migration 14 [decision]. |
| D26 | **The Tomb's entry quest id** | CLIMB §8.2 ("JG_X15 = TOMB's JG_T01"), TOMB F12 (JG_X15 in `tomb.json`) | Two names | **JG_X15 "The Emperor's Door"**, defined once in `content/quests/tomb.json` (TB-Q); CL-Q leaves the id out of `jangan.json` [decision]. |
| D27 | **Names** | TOMB F8, QILIN Q5, CLIMB W15-A | Three naming clashes | The NPC is **Tomb Steward Baek**; MB4 stays **the Gate Warden**; the title is **"Stormchaser"**; W15-A shows in play as the **Terracotta Regalia** (CLIMB's row name "Tomb Warden's set" would collide with MB4) [decision]. NM-P's content check refuses a nemesis given name equal to any boss name. |
| D28 | **QL-T** | QILIN F11 | Dropped | No second title lane; QL-S emits `qilinCaught {charId, kill}` (D25). |

### 2.2 State ownership (one source of truth each)

| State or module | Produced by | Consumed by | Owner lane |
|---|---|---|---|
| The levels table (D30 rows), `masterySp` | `content/climb/levels.json` | `GameData.expToNext`, the client, the Favour and Qilin shares, the nemesis cap, the penalty | **CL-D** (data), **W14-CL** (format, maths) |
| Derived monsters (`MOB_CL_*`), the standard curve | `packages/shared/src/climb.ts` `deriveMobs` over `content/climb/roster.json` | the server's `GameData`, the client's content load, TB-M (the tomb's numbers), NM-B (calibration) | **W14-CL** (function), **CL-D** (roster) |
| The remap (area × retail code → derived; nest overrides; fallback; passive B4 border; authored camp nests; landing points) | `content/climb/bands.json` | `spawner.ts` (nests and summons), `nav.ts` (homes), NEMESIS (maps stored kinds through the nest) | **CL-D** (data), **W14-SP** (mechanism) |
| Roles (link, spacing, heal, flight, call) | `content/climb/roles.json` | `apps/server/src/climb/roles.ts` via the `ai.ts` hook | **CL-R** |
| The penalty state (`Player.penaltyLoss`, the refunded sum, the grace clock, the linger) | `apps/server/src/climb/penalty.ts` | NEMESIS (the record), TOMB (wipe counters), the client banner | **CL-K** |
| Arts chosen, set counts | `characters.arts`; `apps/server/src/climb/{arts, sets}.ts` | the skill engine lookup, a mod provider | **CL-A** |
| Achievements, the chosen title | `char_achievements`, `characters.title`; `achievements.ts` | `EntityState.title`, the character window | **CL-U** |
| Instances (slots, leases, lamps, timers, the one-live-instance binding) | `apps/server/src/tomb/**`, runtime only | the client HUD (`tombState`), the Steward | **TB-S** |
| Wing unlocks, chest lockouts | `tomb_progress` (migration 15) | the Steward's picker, the chests, the Favour | **TB-S** |
| Nemesis rows, victims, cooldowns | migration 16; `apps/server/src/nemesis/**` | the nameplates (`EntityState.nemesis`), notices, refunds, achievements | **NM-S** |
| The Qilin's cooldown and phase | the `uniques` row `MOB_CH_STORM_QILIN` | `qilin.ts`, `/qilin` | **QL-S** |
| The weather event hold | `weather.ts` | the Qilin, every client | **QL-W** |
| Telegraph shapes on the wire and on screen | `telegraph` (W14-PR); `world/telegraph.ts` | TB-B, QL-S (server); every client | **W14-PR** (wire), **TB-TG** (pool) |
| The stage origin | `apps/game` network boundary (`toLocal`/`toWire`) | every position in and out | **W14-G** |
| `Mob.tag`, `MobTuning.levelAdd`, the area list | `world.ts` | every module | **W14-SV** |
| Spawner pause/release/tracks | `spawner.ts` | QL-S (summit clearing), NM-S (promotion) | **W14-SP** |
| The kill EXP order and the provider chains | `gameplay.ts` | every module | **W14-SV** |

### 2.3 Cross-feature behaviour

| # | Topic | Problem | Decision |
|---|---|---|---|
| D29 | Nemeses and the Tomb, the Qilin, the springs | Births in special places | No nemesis from a `Mob.tag` monster (instance, event, boss, elite, summon, encounter), within 200 m of the town spawn, or in the springs' sanctuary polygon; the Qilin's summit clearing never touches nemeses or uniques (NEMESIS §2.1, QILIN D30). |
| D30 | **The curve with the siblings' rewards** | §5: the run-5 curve gives the mixed friend 36.0 h with the Favour, the Qilin and the refund | **Levels 1–12 keep CLIMB's rows; 13–19 are scaled on a ramp (13 ×1.06, 14 ×1.12, 15–19 ×1.18): 13: 76,800 · 14: 105,000 · 15: 142,000 · 16: 183,000 · 17: 238,000 · 18: 312,000 · 19: 415,000; 1 → 20 = 1,679,506** [decision; projected: `merged.ts`, mixed median 40.1 h]. Reason: the user's "about 40 h" with every wave-14 reward on; the new rewards all live at 15+, so the levels around them carry the cost, and the ramp keeps every level 1.29–1.37× the last (no wall at 15). |
| D31 | **The Tomb's trash EXP** | TOMB F9: one knob for CLIMB's target (a repeat run ≈ 1.0–1.15× the solo hour) | **`trashExpMul` per wing: I 1.8, II 3.2, III 2.2** [decision; projected: `merged.ts` on `tomb-sim-fc.json`: a repeat run then pays 0.89–1.15× CLIMB's average solo hour at 15–16, 1.04× at 17–18, 1.09× at 19]. Reason: Wing II's 4 km of arms halves its kill density; one number per wing hits the target where one number for all cannot (0.65–1.28× today). |
| D32 | **The Favour on the new curve** | The table was "20 minutes of CLIMB's hours" | **The % table stays** (15: 10.7 %, 16: 7.7 %, 17: 6.1 %, 18: 5.4 %, 19: 3.5 % of the bar); D30's curve is fitted with it in place, so it is ≈ 20–28 minutes of hunting on the new bars [decision]. Reason: the fit is the contract; one table, no second model. |
| D33 | **Mentoring in the Tomb and at the Qilin** | CLIMB F1's damage-share rule | **Everywhere**: a capped member's level weight is 0 and the party's pool is × the uncapped members' damage share (floor 25 %); the Qilin pays its own share per hunter and is outside this; the Tomb's Favour is per character and in band only [decision]. Reason: no carry engine anywhere (TOMB `--fc`: a carried 15 earns 18–37 %/h of its bar, at or below the frugal field). |
| D34 | **Deaths in the Tomb** | TOMB §3.6, CLIMB grace | Rule #13 unchanged; revive at the last lit lamp; the boss court's lamp is dark during its fight; a wipe resets the boss; the grace makes a second wipe within 10 min free (TOMB D20). |
| D35 | **The Qilin at level 15** | QILIN F15: a 4 × L15 fight is net negative EXP under rule #13 | **The trigger stays at 15** and the notice shows the Qilin's level (20); the chase pays shed scales without a fight [decision, QILIN R10]. Reason: the chase is the event; the user check judges it. |
| D36 | **Telegraph latency** | TOMB D17/D18, QILIN volleys | Every special ≥ 1.2 s of wind-up (the Qilin's circles 1.5 s), hits at release on the server position, decals 0.3 m larger. |
| D37 | **The summit clearing** | QILIN D30 | Nests reaching 60 m of a seat lose their living normal monsters and pause while it stands (W14-SP's `pause`); a nemesis, a unique and an encounter are never touched. |
| D38 | **The springs and the Tomb's moat** | Wave 13's hooks | The Tomb Seal Shard has two sinks (5 shards → the Vault's Seal, or → an Ancestor's Incense at Miaoryeong); the Quicksilver Eel broth (−20 % abnormal) helps against the Viper; the springs' sanctuary stays spawn- and seat-free. |
| D39 | **Two refunds of one death** | CLIMB F5, NEMESIS F23 | Capped at the loss (D9); the nemesis records the loss **net** of a Soul Rebirth refund. |
| D40 | **The far bank and swimmers** | CLIMB D7, wave 13's `openShore` | `content/swim/swim.json`'s `openShore` rows for the far bank are written by **CL-S** this wave (SW-C owned the file in wave 13) [decision]; any level may cross by ferry or swimming; a death there returns to town. |

### 2.4 Balance (merged)

| # | Topic | Decision |
|---|---|---|
| D41 | Rates | `EXP_RATE = SP_RATE = GOLD_RATE = DROP_RATE = 1` on the live server from the deploy, with the user's OK (CLIMB D9); the knobs stay for tests and GM weekends. |
| D42 | Tiger Girl | `hpMul` 0.16, fury ×3 (U-BAL) as the capstone; her summons resolve through the remap (CLIMB §2.6). |
| D43 | The nemesis chance | **1.0** stays (NEMESIS N4); the merged re-run has 2.9 deaths per mixed climb (CLIMB's 3.3), so births fall ≈ 12 % [projected: linear in deaths], to ≈ 1.3 a week at 3 players; NM-B re-runs `week.ts` at BAL-1 with Q8's rule (above ~5 a week → 0.5). |
| D44 | SP at 20 | SP-EXP stays = kill EXP (CLIMB D17). On the D30 curve a mixed friend ends with **≈ 3,600 SP** (≈ 2,620 from kills and Rested, ≈ 200 from the Qilin's SP-EXP, ≈ 760 from quests) against 2,950 demanded by the P0 build and two Art trees [projected: arithmetic on `merged.json`]: ≈ 630 spare. Kept: SP stays a choice. |
| D45 | Gold | Unchanged levers (band factors 1.0–2.6, quest gold ×2 at 11–19, chest gold ≈ a run's potions). The merged friend hunts **27.8 h** from 15 to 20 against CLIMB's 29.8 h [projected: `merged.ts`], so the late potion bill does not grow; BAL-14 checks nobody is stuck in T3 gear at 17. |

### 2.5 Data, content, tools and delivery

| # | Topic | Decision |
|---|---|---|
| D46 | Re-converts | Two lead checkpoints under the convert lock: **X1** after step 1 (the `qin-tomb` export from TB-CV, the authored merge with `content/{items, mobs, skills, cos, npcs}` of wave 14, the Qilin glbs and sounds, the extra-mobs list, `optimize-out run --only world/qin-tomb/,mob/,cos/,data/,sound/`); **X2** after step 2 (a full re-convert and optimize). Checks at each: with wave 14's inputs empty the field export equals wave 13's for every untouched file (G7); the tomb nav routes every lamp to its boss; every Qilin seat places in the home component and every edge routes; every live nest resolves to a derived row of its band (CL-D's check); X3 only for F-14 fixes that change an export. |
| D47 | The GPU queue | WAVE_PLAN8 D27's lock and rule (mkdir must succeed; owner "label time"; only the creator removes it). Priority: bench timings (LAB-14, G-14, V-14) > review renders (Qilin look in game, tomb interiors) > anything else. A wave-14 GPU item waits behind any wave-12/13 holder. Blender (the Qilin horn) needs no lock. |
| D48 | Downloads and uploads | **None.** |
| D49 | Meshy | **Cap 40, planned 0.** The only foreseeable use is a gold-mane Qilin if the user rejects storm-blue *and* the recolour cannot reach it; one NIGHT_LOG row per job, through `MeshyClient`, the key never printed. |
| D50 | **The deploy of wave 14** | **A new OK from the user is required** [decision]; "make all decisions" is not a deploy OK. After the OK: a **named DB backup** (three migrations, schema 13 → 16), the **migration dry run on a copy of the live DB** (§8.3; it stops on any loss), one `pnpm run deploy` (code and assets, the `qin-tomb` export included), **the rates line in `~/silkroad/silkroad.local.env` changed to ×1** (a deploy never touches that file: a manual step in the checklist), a health check (schema 16, the far bank's nests spawned, the `qin-tomb` nav loaded, the six mini-bosses and the Qilin rows in `/unique`), the "reload the page" note. Wave 14 deploys after waves 12 and 13 (its base) or together with them, never before. |
| D51 | Stale clients | Additive wire; an old client ignores `title`, `nemesis`, `telegraph`, the new notice events (the deploy restarts the server and forces a reconnect). |
| D52 | Scratch and docs | I-14 updates docs (§7.6) and deletes the specs' large scratch only after the owning lane ports its method (the images the user reviewed are kept). |

### 2.6 Numbers and config (consolidated)

| What | Value | Source |
|---|---|---|
| Bands | B1 1–5, B2 5–10, B3 9–13, B4 12–15, B5 14–18, B6 Tomb 15–20, B7 Far Bank 17–20 | CLIMB D1 |
| Curve 1 → 20 (×1) | 796 · 1,400 · 2,340 · 3,750 · 5,790 · 8,630 · 12,500 · 17,500 · 24,000 · 32,300 · 42,800 · 55,900 · **76,800 · 105,000 · 142,000 · 183,000 · 238,000 · 312,000 · 415,000** = 1,679,506 | D30 |
| Level rule | −15 %/level from 2 below (floor 10 %), +5 %/level above (max +15 %) | CLIMB D4 |
| Quest EXP share | 50 / 35 / 30 / 25 % of each level by band (of the D30 rows); gold ×2 at 11–19 | CLIMB D11 |
| Rule #13 | 15–19; 1–20 % of the current bar; grace 10 min; Incense (bound, ≤ 5, never sold); Rebirth refund 50 % (100 % with the Art); linger 10 s | CLIMB §6; D9, D10 |
| Tomb | slots 6 × 10 km at `TOMB_X0` 40 km; party 2–4, all 15+; cap 120 min, close 10 min empty; chests 20 h; Favour 10.7 / 7.7 / 6.1 / 5.4 / 3.5 %; bosses 26k / 32k / 46k HP, fury 9 / 10 / 12 min; `trashExpMul` 1.8 / 3.2 / 2.2 | TOMB; D31, D32 |
| Nemesis | chance 1.0; level ≥ 3, ≥ 10 % of its HP; caps 1/account, 2 h online cooldown, 2/area, 8/world; return 20–40 min; refund 0.5; EXP cap 10 % of a level | NEMESIS |
| Qilin | storm start, ≥ 1 player 15+, cooldown 20 h; 6 seats, 2 flights, window 20 min, stand 5 min, restless 8 min; HP ×0.05 (29,936); volleys 75/50/25 %, 3 × 400 % bolts; ascend 300 s; lone-hunter ×0.6; 10 % of own bar | QILIN |
| Migrations | 14 CLIMB, 15 TOMB, 16 NEMESIS | D5 |
| Config | `NEMESIS=on`, `QILIN=on` (off with `UNIQUES=off`); rates ×1 at deploy | D41, D50 |
| Meshy | cap 40, planned 0 | D49 |

---

## 3. Formats and content (additive)

### 3.1 Wire (`packages/shared/src/protocol.ts`, `validate.ts`; W14-PR; protocol v1, additive)

```ts
// --- CLIMB (S-TITLE)
EntityState.title?: string                          // players; <= 32 code points
PlayerStats.arts?: string                            // the chosen Art ids (bounded table, WAVE_PLAN9 S-STATS)
stats.penalty?: { graceUntil?: number; incense?: number }
{ t: 'penaltyTaken'; pct: number; loss: number; protectedBy?: 'incense' | 'grace'; killer?: string }   // to the victim
{ t: 'penaltyRefunded'; amount: number; by: 'rebirth' | 'nemesis' }
{ t: 'artPick'; tree: string; tier: 10 | 15 | 20; art: 'A' | 'B' }  { t: 'artReset'; tree: string }   // 1/s
{ t: 'titleSet'; id: string | null }                                                                      // 1/s
// --- TOMB (S-WIRE) and the Qilin's volleys (D3)
{ t: 'telegraph'; id: number; src: number; shape: 'circle' | 'cone' | 'line' | 'ring'; x: number; z: number;
  r: number; r2?: number; deg?: number; yaw?: number; len?: number; w?: number; ms: number;
  points?: [number, number][] }                     // points: several circles of radius r (the Qilin's volley)
{ t: 'tombState'; wing: 1 | 2 | 3; slot: number; endsAt: number; lamps: number[]; seals?: number; chests?: Record<string, number> }
{ t: 'tombEnter'; wing: 1 | 2 | 3 }  { t: 'tombJoin' }  { t: 'tombLeave' }                                 // 1/s
ServerInfo.dungeons?: { world: string; x0: number; stride: number; count: number }[]
// --- NEMESIS
EntityState.nemesis?: { rank: 1|2|3|4|5; sub: string; victims: string[]; given?: true }    // per-key bounds
{ t: 'nemesisNotice'; event: NemesisNoticeEvent; name: string; mob: string; rank: number; area?: string; victim?: string;
  by?: string; party?: true; avenged?: true; exp?: number; dir?: number; distM?: number; state?: 'away'|'alive'; at?: number }
// --- QILIN
lightning: + x?, y?, z?, kind?: 'qilin'             // a world point; absent = today's camera-relative strike
UniqueNoticeEvent = 'appeared' | 'defeated' | 'fled' | 'cornered' | 'ascended';  uniqueNotice: + to?, seat?
// ActionFailReason: reuse `requirements` (with the message) for every tomb and ferry refusal; new: 'tomb_full', 'tomb_bound'
```

- **No `qilinVolley`** (D3). The validators bound every new object (the per-key bound table of WAVE_PLAN9 D2);
  `NEMESIS_NOTICE_EVENTS` and the widened `UNIQUE_NOTICE_EVENTS` are exported lists.
- `packages/shared/src/content.ts`: `UniqueDef` gains `announce.scope?: 'area'`, `adds?: {code, n, atPct}[]`,
  `look?: 'champion' | 'giant'`; `StormEventDef`; `MobDef` rows accepted from authored content (`provenance:
  'authored'`); the tomb's content types (`TombFile`, `TombMonsterRow`, `TombBossDef`, `TombLootDef`); the climb types
  re-exported from `climb.ts`. `quests.ts`: an objective's `mob` also matches a derived code by its base (the type
  says so; the engine's match is CL-Q's).
- **Name check** [confirmed: grep of `protocol.ts` at HEAD]: no `telegraph`, `title` on players, `nemesis`, `tomb*`,
  `penalty*`, `art*` exists; W14-PR re-greps at the wave-13 commit.
- docs/PROTOCOL.md gains "Rule #13", "Titles and Arts", "The Tomb", "Nemeses", "The storm Qilin" (W14-PR).

### 3.2 Migrations (`apps/server/src/db.ts`; W14-SV; D5)

```sql
-- 14: The Climb (docs/CLIMB.md §10.1)
ALTER TABLE characters ADD COLUMN curve_version INTEGER NOT NULL DEFAULT 0;   -- 0 old curve; 1 EXP converted; 2 grants delivered (§8)
ALTER TABLE characters ADD COLUMN title TEXT;
ALTER TABLE characters ADD COLUMN arts TEXT;                                   -- JSON {tree: {10: 'A', 15: 'B', 20: null}}
CREATE TABLE char_achievements (
  char_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  id TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, done_at INTEGER,
  PRIMARY KEY (char_id, id));
-- 15: the Qin-Shi Tomb (docs/TOMB_DUNGEON.md §11.2, verbatim): tomb_progress(character_id, wings, chest_general, chest_viper, chest_tiger)
-- 16: nemeses (docs/NEMESIS.md §7.2, verbatim): nemeses, nemesis_victims, nemesis_accounts + their indexes
```

Old rows read as `curve_version` 0 (converted at the first login, §8), no title, no Arts, no tomb progress (Wing I
open), no nemesis. The migration test steps a schema-13 temp DB (a copy of `work/server/game.db` taken through wave
13's migrations) to 16. **Back up the DB before the deploy** (D50).

### 3.3 World export and manifest (W14-CV, TB-CV)

```ts
// work/out/world/qin-tomb/manifest.json (a second export; the field's manifest is unchanged)
manifest.interior: true
manifest.slots: { x0: 40000; stride: 10000; count: 6; floors: { 1: [x, z], 5: [x, z], 6: [x, z] } }
// models (floor blocks merged per material), lightmaps, nav.bin of floors 1, 5, 6; props from the DOF object lists
```

Download ≈ 10–13 MB on the first entry, cached [projected: TOMB §10.1]; the field export unchanged. The data export
gains the `MOB_TQ_*` bases and their MSKILL rows (extra-mobs list), the authored mobs, skills, cos and items of wave 14;
the sound export the five Demon Horse cues; `mob/event/` and `cos/` the Qilin and its mount (≈ 0.15 MB brotli).

### 3.4 Content

| Path | Owner | Validator |
|---|---|---|
| `content/climb/{levels, roster, bands, roles, arts, sets, slots, penalty, achievements, drops}.json` | CL-D (arts.json **CL-A**, achievements.json **CL-U**) | W14-CL's checks; CL-D's "every live nest resolves" |
| `content/uniques.json` (Tiger Girl's tuning, six mini-bosses) | CL-D | `checkUniquesFile` (+ `adds`, `look`, `scope`) |
| `content/quests/jangan.json` | CL-Q | the QUESTS checker; the hint-level test |
| `content/quests/tomb.json` | TB-Q | the QUESTS checker; one id across files |
| `content/quests/storm.json` | QL-Q | the QUESTS checker |
| `content/items/climb.json` | CL-D | `data/authored.ts` |
| `content/items/tomb.json`, `content/tomb/loot.json` | TB-L | `data/authored.ts`, the tomb checks |
| `content/tomb/{tomb, monsters, bosses}.json` | TB-S (tomb.json), TB-M (monsters.json), TB-B (bosses.json) | the tomb checks |
| `content/nemesis.json` | NM-P (rows), NM-B (`kinds`) | `checkNemesisFile` |
| `content/events/storm-qilin.json`, `content/{items, mobs, skills, cos}/storm.json` | QL-Q | `content-check.ts` rules (seats place, edges route, graph connected) |
| `content/npcs.override.json`, `content/npcs/climb.json` | CL-S | the NPC override loader |
| `content/npcs/tomb.json` | TB-Q | the authored merge |
| `content/swim/swim.json` (`openShore` for the far bank) | CL-S | SW-P's validator |

### 3.5 Settings, config, GM

- No new client setting.
- Server config: `NEMESIS=on|off`, `QILIN=on|off` (W14-SV). Rates by the existing env keys (D41).
- GM rows (W14-SV lands the dispatch; the modules answer): `/climb mob`, `/penalty test`, `/incense`, `/arts reset`,
  `/title`, `/ferry` (CLIMB §10.4); `/tomb spawn | slots | close | reset <char>` (TOMB; `/spawn MOB_TQ_*` refused);
  `/nemesis list | info | spawn | rank | return | kill | retire | clear | quiet` (NEMESIS §7.4); `/qilin summon | status
  | ascend | cooldown | stats` (QILIN §9.2). Every command audited.

---

## 4. Seams (step 0; seven agents; every edit additive; the Low guard stays green)

All seven start from the wave-13 final commit (D1) and re-read every file they touch. With wave 14's content folders
empty and both new config keys off, the server's rewards, spawns and saves and the client's frames are byte-identical
to wave 13's (each agent has a test for it).

### 4.1 W14-PR: the wire and shared content (one agent; effort M, 1.5 days)

§3.1 in one commit, the bound entries first; the content types; `index.ts` exports for `climb`, `nemesis`,
`tomb-beam`; PROTOCOL.md. **Tests:** every new request and event round-trips through the validators; unknown fields
dropped; `EntityState.nemesis` and `telegraph` bounds (a 9th victim, a 13-point volley, a negative radius rejected);
the widened notice events (old values still parse); an old frame without the new fields parses unchanged.

### 4.2 W14-CL: the climb maths (one agent; effort S, 0.5 day)

`packages/shared/src/climb.ts`: `deriveMobs(base, roster)`, the standard curve (the quadratic fit of ln HP and ln
attack over retail normals 1–24, CLIMB `lib.ts` `std`), the DPS normalisation, `levelFactor(pl, ml)`, the penalty roll
`(rng) → {pct, loss}` with the never-a-de-level clamp, the set counter (a family is a degree), the checks of every
`content/climb/*.json`. **Tests:** golden rows (CLIMB §2.2's table: Mangyang 1 54 HP, Tiger 14 509 HP, Hyungno Shaman
20 916 HP); the level factor's table; the roll never below the bar's start; `deriveMobs` identical on server and
client fixtures.

### 4.3 W14-SV: the server spine (one agent; effort M, 2 days)

D4, D5, D8, D9, D11, D14 (the chain), D17, D33:

- `gameplay.ts`: `playerDied(p, now, killer)` from every caller; the level factor hook per share (default 1); the loot
  provider chain; `MobTuning.levelAdd` (`mob.level = mob.combat.level = def.level + levelAdd`); module registrations
  (`penalty`, `climb` roles hook, `achievements`, `nemesis` after `uniques`, `tomb`, `qilin` after `uniques`) as inert
  stubs; `respawnPoint` consulted before town; a `killShares` hook for the damage-share pool.
- `modules.ts`: the hook signatures (`playerDied` third argument, `respawnPoint?`, `drops?`).
- `world.ts`: `Mob.tag`, the area list and per-area clamp.
- `party.ts`: the mentoring rule (capped weight 0; pool × uncapped damage share, floor 25 %; the capped member's SP-EXP
  share by today's weights) behind `content/climb/` being present.
- `connection.ts`: the `leaveWorld` linger hook (a module predicate returns a delay in ms; default 0).
- `db.ts`: migrations 14–16, the row fields, the `saveProgress` extras for `title`, `arts`, `curve_version`.
- `config.ts` (`NEMESIS`, `QILIN`), `gm.ts` rows (§3.5; a stub answers "not built yet").

**Tests:** a kill with no module and no climb content = wave 13's `StatGain` exactly; the killer reaches the hook on
melee, skill, DoT and GM paths; a warp to x = 45 km with a slot area lands there, without it on the field's edge; a
pure carry pays 25 % (CLIMB §7.1's table within ±0.02); the linger keeps a socket-closed character for the predicate's
time; migration 13 → 16 on a temp copy keeps every row; the whole server suite.

### 4.4 W14-SP: the spawner, nav and uniques spine (one agent; effort M, 2 days)

D6, D7, D15: the remap at nest load and for summons, the overrides, the fallback, authored nest rows, `release`,
`tracks`, `pause`/`resume`; `nav.ts` home list; `composite-nav.ts` and its load in `game.ts`; `uniques.ts`: `isTracked`,
the exports (resolver, notice sender, row I/O), `announce.scope: 'area'` (300 m + the zone), `adds`, camps by authored
nest, `look`, the per-holder damage multiplier hook (the Ward charm); `mounts.ts` `CosItem.reusable` with a
10-minute cooldown after the mount dies. **Tests:** with `content/climb/` absent the 700 live nests spawn as today
(codes and positions byte-identical); a fixture remap with an override and a fallback; a release schedules the
replacement; a paused nest does not respawn and resumes; two home components accept a far-bank placement; a composite
move in slot 3 equals the same move in slot 0 offset and never crosses `TOMB_X0`; an area-scoped notice reaches only
players within 300 m or in the zone; `adds` replaces the summon rows; Tiger Girl's existing tests unchanged.

### 4.5 W14-CV: the converter spine (one agent; effort S, 1 day)

D14, D20: `sro convert-dungeon` on a stub, `manifest.interior` and `manifest.slots`, the extra-mobs hook, the
authored merge for mobs, skills and cos, the sound rows. **Tests:** the field export byte-identical with the new inputs
empty (G7); an authored mob colliding with a retail code is an error; the extra-mobs list adds rows only for listed
codes; old manifests validate.

### 4.6 W14-WR: the world-render spine (one agent; effort S, 0.5 day)

D19: the `interior` branch in `world.ts` with an interior part stub (nothing created that the profile turns off), the
beacon slot, the define sets in `material-budgets.test.ts`, the warm-up hook entries. **Tests:** a field world
unchanged (the Low guard, `seams-classic`, the wave-13 suites); an interior world creates no sky, ocean, terrain, grass
or weather and disposes cleanly; the far plane follows the fog end.

### 4.7 W14-G: the game spine (one agent; effort M, 1.5 days)

D18: the stage switch by position (`ServerInfo.dungeons`), the stage origin pair at the network boundary (spawn, move,
warp, telegraph, ground items, outgoing `moveTo` and targets), the content load with `deriveMobs`, the nameplate
extra-lines hook, the five notice events and cues with the alarm skip list (the Qilin's code), the feature stubs and
i18n files, the mock server's wave-14 fields. **Tests:** a skinned character at x ≈ 90 km renders identically to x 0
(the stage origin); a `fled` notice never reads "defeated"; the town alarm silent for a listed code and still ringing
for Tiger Girl; `UNIQUE_CUES` satisfies the widened record; the whole `apps/game` suite.

---

## 5. Balance: the merged re-run, the curve, the soak

### 5.1 What was run [confirmed: `pnpm tsx work/tmp/w14-plan/merged.ts`, 400 bot friends per row, seed 1188]

`merged.ts` is CLIMB's Monte Carlo (`work/tmp/climb/fc-climb.ts`, which runs on `work/tmp/climb/lib.ts`, the
extension of `work/tmp/balance/sim.ts` with the server's `formulas.ts`, `mob-skills.ts` and `skills/timing.ts`),
reading CLIMB's run-5 session tables (`climb.json`: every level × skill tier × solo / duo / party of 4 at every spot)
and adding the three siblings' EXP:

- **the springs' trip** charged (CLIMB F7), in every row;
- **the Favour** (TOMB §3.4's table): once per session-day in the wing's band (15–16, 17–18, 19), when the friend's
  group runs the Tomb that day (probability = the profile's group share at 15–19: mix 0.5, grouped 0.8, solo 0); the
  run's 19 / 39 / 17 minutes are party-of-4 hunting;
- **the Qilin** (QILIN §6.1): 1.6 appearances a week over 7 sessions a week (0.23 a session at 15+, grouping profiles
  only), 15 minutes, joined 50 % at 15 and 80 % above, won 47 / 70 / 85 / 95 / 100 % at 15–19 and a death 0.59 / 0.15 /
  0.10 / 0.05 / 0.03 times per fight (QILIN §5.2's tables), paying 10 % of the own bar on a win;
- **the nemesis refund** (NEMESIS §5.3): half the loss of 43 % of penalised deaths comes back at the next session
  (≈ 21 % of all rule-13 losses, `week.ts`'s share).

The base row reproduces CLIMB F7: mix 41.8 h (CLIMB: 41.6 h; a different random path) [confirmed: the run].

### 5.2 Results [projected: `merged.json`]

| Profile (median h; p10 / p90) | CLIMB alone, trip charged | + Favour, Qilin, refund (run-5 curve) | **D30 curve, everything on** |
|---|---|---|---|
| **Mix** (the target) | 41.8 (38.4 / 45.2) | **36.0** (33.7 / 39.0) | **40.1 (36.8 / 43.6)**; seeds 7 / 42: 40.0 / 39.9 |
| Solo only (no Tomb, no Qilin) | 51.4 | 48.8 | 57.2 |
| Mostly grouped | 38.2 | 32.6 | 35.6 |
| Mix, soaks every night | 37.2 | 33.2 | 36.7 |
| Mix, no springs or meals | 50.3 | 41.3 | 46.1 |

| Mix, one effect at a time (run-5 curve) | Median | Saved |
|---|---|---|
| Favour only | 37.2 h | 4.6 h |
| Qilin only | 40.3 h | 1.5 h |
| Nemesis refund only | 41.1 h | 0.7 h |
| All three, the Favour halved | 37.3 h | — |

On the D30 curve, the mixed friend: levels 15 → 20 **27.8 h**, the last three levels 19.9 h; **2.9 deaths** in the
climb, 69,028 EXP lost to rule #13 and 12,993 refunded by nemeses; the Favour pays 130,499 EXP and the Qilin 80,754
over the climb (≈ 8 % and 5 % of the curve) [projected].

**Reading.** The siblings' rewards are each modest, but together they took 5.8 h out of the 40. Halving the Favour
alone would leave 37.3 h; scaling every level would also lengthen 1–12, where none of the new rewards act. **D30** keeps
1–12 and ramps 13–19, so each new reward stays as its fact-checked spec tuned it and the climb stays the user's "about
40". The cost lands where the user wants it: solo-only climbing past 15 is slow (57 h), a group at 15–20 is the way
(35.6 h), and one death at 19 now costs ≈ 43,600 EXP on average and 83,000 at worst (≈ 1.5 h and ≈ 2.8 h of hunting at
the mix friend's ≈ 30k EXP/h) [projected: arithmetic].

### 5.3 The Tomb's trash EXP (D31) [projected: `merged.ts` on `work/tmp/tomb/tomb-sim-fc.json`]

| Case (in band, today's `trashExpMul` 2.0) | Tomb EXP/h per member | CLIMB average solo hour | Ratio | After D31 |
|---|---|---|---|---|
| Wing I 4 × 15 | 27,262 | 27,426 | 0.99 | 0.89 (1.8) |
| Wing I 4 × 16 | 34,597 | 27,120 | 1.28 | 1.15 (1.8) |
| Wing II 4 × 17 | 18,409 | 28,459 | 0.65 | 1.04 (3.2) |
| Wing II 4 × 18 | 19,154 | 29,672 | 0.65 | 1.04 (3.2) |
| Wing III 4 × 19 | 25,010 | 25,351 | 0.99 | 1.09 (2.2) |

The tomb sim's trash EXP is on its own field fit (369 at 16), the same scale as CLIMB's standard 23.5 × level (376)
[confirmed: TOMB §5.2], so the ratios hold on the derived roster; BAL-1 re-runs the tomb sim on the real content files.

### 5.4 BAL-1: the re-runs at checkpoint X1 (effort 1 day; the lead or one agent)

With the real `content/climb/*.json`, `content/tomb/*.json`, `content/nemesis.json` and `storm-qilin.json` in place:

1. CLIMB's model on the files (CL-D's test: §3.2's rows within 2 %), then `merged.ts` with the files' numbers: the mix
   median must sit in **38–42 h**, 15 → 20 in 26–30 h; outside it, CL-D moves the 15–19 scale (one number).
2. `sim-tomb-fc.ts --tomb --n=100` and `--fc` on the derived curve: in-band clears ≥ 98 % for 4, ≥ 96 % for the band
   floor trio at 60 % uptime with ≤ 10 % of wins after the fury, repeat runs 0.9–1.15× the solo hour (D31), duos below a
   band top and solos still fail.
3. NM-B's calibration on the derived roster, levels clamped to the band ceilings, the Far Bank's 7 kinds included,
   n = 400 (LAB-NM4: the rank targets ±10 points); `week.ts --climb=<the merged profile>` for Q8's chance rule.
4. `sim.ts --qilin` and `sim-fc.ts --qilin --fc` with the final level-20 numbers: 3 × L20 in 2–3 min, 2 × L20 ≤ 4 min,
   every solo 0 %.
5. Results to `work/tmp/w14-bal/bal1.md` (Dropbox `wave14/bal1.md`).

### 5.5 BAL-14: the balance soak with bots (after I-14; effort 1.5 days)

On a private server (a free port, a **temp copy** of `work/server/game.db`, throwaway GM accounts), the soak bot
(`apps/server/test/soak/`) extended with CLIMB's three skill tiers:

| Run | What | Pass |
|---|---|---|
| Field 14–19 | 6–8 bots of the three tiers, 2 h, at the §2.4 spots of CLIMB, the far bank included | deaths/h, EXP/h, potions, calls and heals per hour within ×1.5 of CLIMB §2.4; nobody in T3 gear at 17 |
| Tomb | four bots per wing at the band floor and top, 3 runs each | clears and times within ×1.5 of TOMB §6.2; the Favour paid once per 20 h in band; no chest for a late joiner |
| Nemesis | a forced death (≥ 10 % damage dealt) → away → return → hunt → refund; a pack death; a pending grudge | NEMESIS §2's rules; the refund net of a Rebirth refund |
| Qilin | `/qilin summon`, 4 bots on horses: chase, cornered, fight, kill; an ascend; a lone bot | the lone bot never wins; credit to a dead bot; scales on flights |
| Rule #13 | deaths at 14, 15, 19, 20; a second death inside 10 min; an Incense; a closed socket at 5 % HP | CLIMB §6's table exactly; the message text |
| Server | all of the above at once | dev PC tick p95 < 2 ms, p99 < 5 ms; `worstTickMs` < 20 ms |

The numbers go to `work/tmp/w14-bal/soak.md` and to the user with the play checks (§11).

---

## 6. Budgets

### 6.1 What the wave adds per preset

| Preset | CLIMB | Tomb | Nemesis | Qilin |
|---|---|---|---|---|
| Low (Classic) | the title line; nothing else drawn | the interior on Classic (lightmaps, fog); telegraphs as unlit outlines | the label, the scale; no aura | the mob, the beacon (a steady column with reduceFlashing), telegraph outlines |
| **Medium** | ≈ 0 (≤ 20 title lines, pulls of 2–3 monsters inside the field's budget) | the interior profile, 8 flame lights, ≤ 12 telegraph decals | the Berserk glow (7 batches) at I–II, + the flame shroud (16) at III+ | ≤ 3 beacon bolts, ≤ 12 decals, retail lightning particles |
| High / Ultra | as Medium | as Medium + the existing High extras | as Medium | as Medium |

### 6.2 Server budget on the N100 [projected: `budget.py`; TOMB §9.1 measured on the dev PC × 2.5, FIELDS' factor]

| Server state | Dev PC mean / p99 | N100 mean / p99 | Share of the 100 ms tick (p99) |
|---|---|---|---|
| Field, nobody (measured) | 0.24 / 0.65 ms | 0.6 / 1.6 ms | 1.6 % |
| 2 tomb parties + 8 field bots at 14–19 + 8 nemeses + a Qilin event | 1.74 / 3.69 | 4.3 / 9.2 | 9.2 % |
| **4 tomb parties + 8 field bots + 8 nemeses + a Qilin event** | **2.06 / 4.05** | **5.1 / 10.1** | **10.1 %** |
| All 6 slots + the rest | 2.20 / 4.20 | 5.5 / 10.5 | 10.5 % |

- The parts: the tomb slots (measured 1.43 / 2.72 ms with 4 fighting parties on the live field [confirmed:
  `instance-cost-field.json`]); CLIMB's roles and the far bank's 852 mostly dormant monsters ≤ 0.2 ms (CLIMB §12); 8
  nemeses and their 1.6 µs near pass ≈ 0 (NEMESIS §7.5, measured); the Qilin ≈ 0.02–0.1 ms (QILIN §10.1); 8 field
  bots fighting ≈ 0.45 / 0.9 ms (TOMB's first slot, which woke the field around it) [projected].
- **Spikes:** TOMB's slots-only run had single 15–65 ms ticks (≈ 160 ms on the N100) that the field run did not
  [confirmed there]; the likely cause is GC or a synchronous SQLite write [likely]. **Line: `worstTickMs` < 50 ms on
  the N100** (FIELDS §4.4), read by S-14 with 4 parties, the far bank awake and a nemesis birth; an instance's
  creation tick (40–55 `createMob` calls) is **[unknown]** and measured there.
- **Memory:** 750 MB today → **≈ 820–850 MB** (the far bank +62–90 MB, slots and the tomb nav ≤ 5 MB, nemeses and
  content ≤ 3 MB) [projected: `budget.py`], of ≈ 16 GB.
- **Database:** three migrations; nemesis rows ≈ 0.3 MB a year; achievements ≈ 30 rows per character.
- **Network:** ≈ 10 KB/s per fighting tomb party (measured), < 10 KB per client per Qilin event, a handful of
  nemesis notices an evening.

### 6.3 Client G1 [projected unless tagged; dev PC = Ryzen 5 9600X + RX 9060 XT, Chrome, 1080p, p95]

Baselines are G-13's measured numbers when they exist (WAVE_PLAN9 §5.2's projections until then).

| Scene (Medium) | WebGPU / WebGL2 | Pass line | Source |
|---|---|---|---|
| **Tomb Wing I formation fight, 4 players** | ≈ 4–6 / 3–5 ms | G1 < 16.7 | TOMB §10.3 (the floor-1 hall: 101 meshes, merged per material by TB-CV, far plane at the fog) |
| Tomb Wing II hub + an arm, quicksilver | ≈ 4–6 / 3–5 | G1 | TOMB §10.3 |
| **Tomb Wing III: SoHaow, 4 players, adds, 12 telegraphs** | ≈ 5–7 / 4–6 | G1 | TOMB §10.3 |
| **The Qilin fight, 8 players at Tiger's Crown in a storm** | ≈ 9–12 + the summit view **[unknown]** | G1 | QILIN §10.2 (≤ 8 players ≈ 13 ms on a laptop or M1, UNIQUES §6); LAB-14 measures the summit |
| Two nemeses (I and III) in a B5 pack fight | the same scene with champions + ≤ 0.15 | LAB-NM1 | NEMESIS §11 |
| **The far bank landing, 4 players, a Mo-Dun fight** | **[unknown]**, field-like | G1 | CLIMB §11: nobody has walked or measured it |
| Every existing LAB-13 scene (plaza, Tiger Girl, beach, springs, …) | unchanged (G3) | + 0.2 ms | 0 new draws in those scenes |

What it means, honestly:

- **The tomb is cheaper than the field** (no terrain, grass, ocean, sky or shadow map; 40–95 k triangles against the
  plaza's 183 k) [projected]; its risks are the floor-1 hall's draw count and the lightmaps' VRAM (≈ 20–30 MB), and
  **the field rebuild on every exit** (**[unknown]**; over 10 s, the field stage stays resident and disabled).
- **The Qilin's own cost is ≤ 0.2 ms**; the crowd is the cost, as at Tiger Girl. A 20-player gathering at a summit
  misses 60 fps on Medium on weaker GPUs and on High everywhere: the known BACKLOG item 9, not new here.
- **Two places nobody has measured**: the far bank and the summit view. Both are LAB-14 rows; a miss goes to the render
  lanes (or the cut list), not to the design.
- **The old red line** (Tiger Girl with 20 players later on a page) is not changed by this wave; her U-BAL tuning makes
  the fight longer for parties, not bigger.

### 6.4 LAB-14 and S-14 method

**LAB-14** (the client): the production bundle on a private `vite preview` (a free port, stopped after), a private
server on a temp copy of `game.db` with GM bots (the LAB-13 harness + the soak bots), 1920 × 1080, DPR 1, a 60 Hz timer
pump, 400 uncapped frames after streaming idles, **3 runs, median**, the GPU lock held, a quiet machine (CPU < 15 % for
30 s), at most one browser tab, closed after. Scenes, Medium on both backends, then High:

1. The three tomb scenes of §6.3 (`/tomb` bots in slot 0 **and** slot 5: the stage origin).
2. The Qilin at Tiger's Crown in a held storm with 8 bots, and the summit view with nobody (noon, storm).
3. The far bank landing with 4 bots and Mo-Dun (`/ferry`).
4. LAB-NM1: two nemeses vs two champions.
5. The stage switch field → tomb → field × 3: the time (pass ≤ 10 s on the dev PC, else the field stays resident) and
   VRAM after the third trip (no growth > 10 MB).
6. The LAB-13 list re-run (G3).
7. Walks with the hitch watchdog: town → the tomb door → Wing I; town → the ferry → the far bank; the first telegraph,
   the first beacon bolt, the first nemesis aura: no shader compile.

**S-14** (the server): the real modules on a private in-process server (TOMB's `instance-cost.ts` method, a temp
`DATA_DIR`): 4 tomb parties in their wings with telegraphs and puzzles, 8 field bots at 14–19 with the far bank awake,
8 nemeses, a Qilin event with the summit clearing; 600 ticks after a JIT warm-up; tick mean / p50 / p99 / max, heap,
messages and KB/s; the instance-entry tick; a nemesis birth's DB write. ×2.5 for the N100.

Results: `work/tmp/w14-lab/budgets.md` (Dropbox `wave14/budgets.md`).

### 6.5 The gates

- **G1:** Medium p95 < 16.7 ms on both backends in every LAB-14 scene with every feature on.
- **G2:** High as in wave 13 (the plaza and the crowd lines); the 8-player Qilin and the tomb on High reported.
- **G3:** no existing scene slower than G-13 by more than + 0.2 ms (Medium) / + 0.3 ms (High).
- **G4:** the Low guard; `material-budgets.test.ts`; 0 WebGPU validation errors; no compile on the first telegraph,
  beacon or aura, or on entering the tomb; 0 allocations per frame in the telegraph pool, the beacon and the nemesis
  feature.
- **G5 (look):** the Qilin in game (storm-blue or the user's pick), a rank I and a rank III nemesis, the three tomb
  wings at their lamps.
- **G6 (server):** S-14 on the dev PC p99 ≤ 5 ms with §6.2's load (≈ 12.5 ms on the N100); `worstTickMs` < 50 ms
  projected for the N100; memory < 900 MB.
- **G7 (data):** with wave 14's inputs empty, the field export equals wave 13's; every live nest resolves; every seat
  routes; the tomb nav routes every lamp to its boss; the migration 13 → 16 keeps every row and every bar fraction
  (§8); the curve sums to D30's 1,679,506.
- **G8 (balance and authority):** BAL-14's rows pass; every abuse test of CLIMB §17.3, TOMB §16.3, NEMESIS §2.8
  (A1–A15) and QILIN §11.2 green.

A feature that breaks G1 on a preset ships off on that preset or is cut (§9). G4, G6, G7 and G8 block the release until
fixed or cut; G5 blocks the item until the user's look passes (the default ships if the user does not answer).

---

## 7. Steps and lanes

### 7.0 Step order and concurrency

```
(now)      wave 12 builds; then wave 13 builds, gates, verifies (WAVE_PLAN9)
pre-start  NEW FILES ONLY, no shared file, no work/out writes (scratch outputs under work/tmp/w14-*):
           CL-D content/climb/*.json + the remap ids on the map + the generated drops.json
           TB-CV packages/formats/src/dof.ts + packages/convert/src/dungeon/** -> work/tmp/w14-tomb/qin-tomb (a scratch export)
           QL-A packages/convert/src/tools/qilin/** (recolour, horn) -> scratch glbs; icons
           NM-B the calibration on CL-D's roster in scratch (work/tmp/w14-nm/)
step 0:    W14-PR | W14-CL | W14-SV | W14-SP | W14-CV | W14-WR | W14-G      -- all from the wave-13 final commit
step 1:    climb:   CL-D (moves its files in) | CL-R | CL-K | CL-A | CL-Q | CL-S | CL-U
           tomb:    TB-CV (into the real converter) | TB-S | TB-M | TB-B | TB-P | TB-L | TB-Q     (server lanes on fixtures)
           nemesis: NM-P | NM-S
           qilin:   QL-W | QL-S | QL-Q | QL-A | QL-R
           -- checkpoint X1: merge; convert (qin-tomb + data + qilin + sounds) + optimize; BAL-1 (§5.4); a bot run of Wing I --
step 2:    CL-G | TB-R | TB-G | TB-TG | NM-C | NM-B (into the content file) | QL-C ; review renders on the GPU queue
           -- checkpoint X2: full re-convert + full optimize --
step 3:    I-14 -> BAL-14 -> LAB-14 + S-14 -> H-14 -> F-14 -> G-14 -> V-14 -> the user's checks -> deploy only on the new OK
```

Critical path [projected]: step 0 (≈ 2 agent-days, parallel) → TB-CV's export (≈ 4, mostly in the pre-start) and
TB-S/TB-B (≈ 2.5) → X1 → TB-G (2.5) → I-14 → BAL-14 → LAB-14 → H-14 → F-14 → G-14 → V-14.

### 7.1 The GPU queue

| Slot | When | Job (owner, label) | Length |
|---|---|---|---|
| Q0 | pre-start / step 1 | the Qilin and mount turntables in game colours (QL-A), the tomb interior first frames in the viewer (TB-CV) | ≈ 10–20 min each |
| Q1 | step 2 | review shots: the three wings at their lamps, the Qilin at a seat in a storm, rank I/III nemeses (G5) | ≈ 20 min each |
| Q2 | step 3 | LAB-14 (§6.4) | ≈ 3 h |
| Q3 | step 3 | G-14, then V-14's three cells | ≈ 1.5 h + 20 min |

Bench slots pre-empt everything not yet started; no wave-14 slot runs while wave 12 or 13 holds the lock.

### 7.2 The lanes

Effort: agent-days. Every lane re-reads its files at the wave-13 final commit. Lanes own only the files listed.

| Lane | Owns (files) | Seams it uses | Tests | User check | Effort |
|---|---|---|---|---|---|
| **CL-D** data | `content/climb/{levels, roster, bands, roles, sets, slots, penalty, drops}.json` (levels = D30 rows; bands with overrides, the fallback table, the passive B4 border, six authored camp nests, landing points), `content/uniques.json` (Tiger Girl U-BAL + six mini-bosses with `scope`, `adds`, `look`), `content/items/climb.json`, the `TYPICAL_SP_BY_LEVEL` generator | W14-CL, W14-SP | CLIMB's model on the files within 2 %; `fc-remap.ts` on the files: no unmapped live nest, no derived row without monsters; BAL-1 step 1 | — | 1 |
| **CL-R** roles | `apps/server/src/climb/roles.ts`, the `ai.ts` hook | W14-SV registration, roles.json | link, spacing, heal cast and interrupt, flight and call, helpers never flee, elite camps; 200 awake monsters perf test | — | 2 |
| **CL-K** rule #13 | `apps/server/src/climb/penalty.ts`, the Incense item behaviour, the linger predicate | W14-SV (S-DEATH, linger hook), W14-CL (roll) | D10's table; 15–19 only; never a de-level; grace (started by an Incense burn, never restarted by a grace death); Incense bound, ≤ 5 owned; refunds capped (Rebirth + nemesis); GM kills excluded; the messages verbatim; a closed tab at 5 % HP still dies | `/penalty test 13` on self | 1 |
| **CL-A** Arts and sets | `apps/server/src/skills/engine.ts` (the lookup), `apps/server/src/climb/{arts, sets}.ts`, `content/climb/arts.json` | W14-SV (stats), W14-CL (sets) | every Art on its row; Executioner and Pinning Shot branches; respec cost; set counts by degree | pick an Art, respec | 2 |
| **CL-Q** quests | `content/quests/jangan.json` (EXP shares of D30, gold ×2 at 11–19, 13 new quests, JG_013's hints), the quest engine's base-code match | W14-PR (`quests.ts`) | `quests-content-check`; each kill hint's area holds that base within quest level + 3; the EXP sum = 25–50 % shares of D30 ± rounding; JG_X15 absent | read JG_X01 | 1.5 |
| **CL-S** ferry and far bank | `apps/server/src/npc.ts` (ferry dialog), `content/npcs.override.json` (single writer), `content/npcs/climb.json`, `content/swim/swim.json` `openShore` rows | W14-SP (homes), D24, D40 | the warp both ways; the warning below 17; free after JG_X07; 852 monsters spawn, Earth Ghost Canyon empty; the swim exit there; the GPU-lock fps check at the landing (LAB-14 row 3) | cross the river | 1 |
| **CL-U** achievements and titles | `apps/server/src/achievements.ts`, `content/climb/achievements.json` (CLIMB's 20 + "Tamer of the West Wind") | W14-SV (migration 14), bus events | counters, persistence, `EntityState.title`, `titleSet`; every sibling event lands a row | choose "Pioneer" | 1 |
| **CL-G** client | `apps/game/src/world/features/climb.ts`, the Arts row in the skill window, the title line via the hook, the penalty banner and the EXP bar flash, item tooltips (sets, Incense), mini-boss map icons, `i18n/en-climb.ts` | W14-G | UI tests; the mock server | the death banner | 2 |
| **TB-CV** converter | `packages/formats/src/dof.ts`, `packages/convert/src/dungeon/**`, the extra-mobs list content | W14-CV | DOF round-trip (6 floors declared = found); the nav places the lamps and routes lamp → boss (edges welded at 0.5 dm); per-material merge ≤ 30 static draws per block; byte-identical field export | a viewer walk of Wing I (Q6 scale) | 4 |
| **TB-S** module | `apps/server/src/tomb/{tomb, slots, content, lockout}.ts`, `content/tomb/tomb.json` | W14-SV (clamp, respawnPoint, migration 15), W14-SP (composite nav), W14-PR | entry rules (each refusal); lease/close/timers; join re-checks; one live instance per character; lamps and the dark boss lamp; chest credit at the pull; lockout; Favour table and bands; restart → Steward | the Steward's refusals | 2.5 |
| **TB-M** monsters | `apps/server/src/tomb/monsters.ts`, `content/tomb/monsters.json` (`trashExpMul` per wing, D31) | W14-CL (`deriveMobs`) | rows = the standard curve × role; `Mob.tag = 'instance'`; formations; runners; bombers; `/spawn MOB_TQ_*` refused | — | 2 |
| **TB-B** bosses | `apps/server/src/tomb/bosses.ts`, `content/tomb/bosses.json` | W14-PR (telegraph) | each special inside/outside at release; bands fire once; the Ward and jewels; enrage; fury 9 / 10 / 12; reset on leash/wipe | — | 2.5 |
| **TB-P** puzzles | `apps/server/src/tomb/puzzles.ts`, `packages/shared/src/tomb-beam.ts` | W14-PR | every rolled layout solvable; wrong orders reset; plates silence traps 6 s; seals open the door | — | 2.5 |
| **TB-L** loot | `apps/server/src/tomb/loot.ts`, `content/tomb/loot.json`, `content/items/tomb.json` | W14-SP (`gearPool`), W14-CV (merge) | chest per character; lockout; class filter; rows by required level (no BA, no `_C_RARE`, ≤ 20); Star chance; SoHaow's Incense; the Vault consumes a Seal | open a chest | 1 |
| **TB-Q** story | `content/quests/tomb.json`, `content/npcs/tomb.json`, the steles' dialogs; rows handed to CL-S | — | the quest checker; JG_X15 once; the Steward ≥ 40 m from MB4's camp and every aggressive roam circle | read a stele | 1 |
| **TB-TG** telegraphs | `apps/game/src/world/telegraph.ts` (pool ≤ 12, `points` circles) | W14-PR, W14-G (stage origin) | fill over `ms`; removed at release; Low outline only; 0 allocations | — | 1 |
| **TB-R** render | `packages/world-render/src/interior.ts`, the quicksilver material | W14-WR | interior profile; the field frame byte-identical when not inside | — | 2 |
| **TB-G** game | the tomb HUD, the Steward dialog, the loading text, `world/features/tomb.ts`, the map's floor plan | W14-G (stage), TB-TG | stage swap both ways; a relog into tomb space; slot 5 = slot 0 on screen; minimap hidden inside | one run per wing | 2.5 |
| **NM-P** shared + content | `packages/shared/src/nemesis.ts`, `content/nemesis.json` (rows; `kinds` from NM-B) | W14-PR | content coverage; generator determinism and ≤ 48 code points; boss-name check | — | 0.5 |
| **NM-S** server | `apps/server/src/nemesis/**` | W14-SV (S-DEATH, chain, levelAdd, tag), W14-SP (release, tracks, isTracked) | NEMESIS §15.2's list in full, A1–A15 | `/nemesis spawn … rank 3 here`, hunt it | 3 |
| **NM-C** client | `apps/game/src/world/features/nemesis.ts`, `i18n/en-nemesis.ts`, the grudge list, the minimap claw (via the hook) | W14-G | NEMESIS §15.2's client list | see rank I and III | 2 |
| **NM-B** balance | `apps/server/scripts/nemesis-calibrate.ts`, the `kinds` rows | CL-D's roster | LAB-NM4 at n = 400; `week.ts` with the merged profile; Q8's rule | — | 0.75 |
| **QL-W** weather hold | `apps/server/src/weather.ts` (only owner) | — | hold below a GM hold; release sequences; restart drops it; `stormStarted` once per segment from the schedule | — | 0.5 |
| **QL-S** module | `apps/server/src/qilin.ts` | W14-SV, W14-SP (exports, pause, reusable), QL-W | QILIN §11.2's list (trigger, landing, clearing, flights, cornered, restless, window, leash, lone hunter, volleys through `dealHits`, credit, no nemesis) | a GM-started event | 3 |
| **QL-Q** content | `content/events/storm-qilin.json`, `content/{items, mobs, skills, cos}/storm.json`, `content/quests/storm.json` | W14-CV (merge) | seats place, edges route on the server router, graph connected; merge round trip; the quest validates | the seat map | 1 |
| **QL-A** art | `packages/convert/src/tools/qilin/**`, the outputs under `work/out/{mob/event, cos}`, icons | W14-CV (sound rows) | glbs validate; the horn weighted to the head; the mount's rig = the Red Horse's | the look | 1 |
| **QL-R** render | `packages/world-render/src/weather/beacon.ts` | W14-WR | `strikeAt` at a world point on every preset; culled past fog + 200 m; reduceFlashing steady | — | 0.5 |
| **QL-C** client | `apps/game/src/world/features/qilin.ts`, `i18n/en-qilin.ts` (sentences and cue names into W14-G's tables) | W14-G, TB-TG, QL-R | the mock event end to end; the seat pin follows flights; the alarm silent for it | — | 1.5 |

Totals [projected: `budget.py`]: step 0 ≈ 9, climb ≈ 11.5, tomb ≈ 21, nemesis ≈ 6.25, qilin ≈ 7.5, balance ≈ 2.5,
integration to verify ≈ 10: **≈ 68 agent-days**, most of them in parallel lanes.

### 7.3 Seams each lane may not cross

- After step 0 no lane edits the W14-* files: `packages/shared/src/{protocol, validate, content, quests, content-check,
  index, climb}.ts`; `apps/server/src/{gameplay, modules, world, party, connection, db, config, gm, spawner, nav,
  composite-nav, game, uniques, mounts}.ts`; `packages/convert/src/{cli, data/authored}.ts` and the mob export hook;
  `packages/world-render/src/{world, weather/index}.ts`; `apps/game/src/{stage/host, screens/world, world/entities,
  hud/unique-notice, world/features/town-sound, world/features, net/mock}.ts`. A lane that needs more asks I-14, which
  adds the seam in its own commit.
- One owner per shared module after step 0: `skills/**` **CL-A**; `weather.ts` **QL-W**; `ai.ts` hook body **CL-R**;
  `jangan.json` **CL-Q**; `npcs.override.json` and `swim.json`'s `openShore` **CL-S**; `content/uniques.json` and
  `content/climb/` **CL-D**; the telegraph pool **TB-TG**; the tomb module **TB-S** (its sub-files TB-M, TB-B, TB-P,
  TB-L).
- No lane edits wave 12's or 13's files outside the W14-* seams. No lane writes `work/out/` outside the convert lock;
  no lane starts or stops the user's dev servers (:5180, :7000, :5173); private servers on free ports with temp DB
  copies only; at most one browser tab per lane, closed when done.

### 7.4 Merge order and checkpoints (I-14)

1. Step 0: W14-PR → W14-CL → W14-CV → W14-SV → W14-SP → W14-WR → W14-G. Suite + typecheck; record the test count.
2. Climb: CL-D → CL-R → CL-K → CL-A → CL-U → CL-Q → CL-S → (X1) → CL-G.
3. Tomb: TB-CV → TB-M → TB-S → TB-B → TB-P → TB-L → TB-Q → (X1 + the Wing I bot run) → TB-TG → TB-R → TB-G.
4. Nemesis: NM-P → NM-S → (X1, BAL-1 step 3) → NM-B → NM-C.
5. Qilin: QL-W → QL-Q → QL-A → QL-S → QL-R → (X1) → QL-C (after TB-TG).

The chains touch disjoint files after step 0 and may interleave; inside a chain the order is fixed. After every merge:
the Low guard, typecheck, `material-budgets.test.ts` if a material or define changed.

### 7.5 Cross-feature tests I-14 adds

- **A death's whole path:** a level-16 player killed by a pack's add with ≥ 10 % dealt to the pack leader → the
  penalty (message, bar flash, party line) → a nemesis born on the leader → a friend's Soul Rebirth refunds 50 % →
  avenged later: the refund is half of the net loss; the sum of refunds never exceeds the loss.
- **The EXP order (D11):** a level-17 player kills a level-15 monster with a meal and Rested: the level factor (0.85)
  inside `e`, then the meal and Rested; a nemesis kill takes neither; the Qilin's share and the Favour are unrated
  by meals and Rested; the nemesis refund is unrated.
- **Mentoring:** a level-20 player solos while a level-8 friend stands by: 25 % of the pool; the same in Wing I.
- **The Tomb's spatial seams:** warp a party into slot 5; a relog there lands at the Steward; a telegraph and a ground
  item in slot 5 draw at the right place; Return Scroll out; the field stage back; VRAM steady.
- **The remap and nemeses:** a nemesis row stored as a retail code maps through its nest after the remap.
- **The Qilin and the world:** the summit clearing pauses the nests near Ye Crag and never despawns a nemesis there;
  the storm hold shows on fishing's state; Tiger Girl and the Qilin alive at once.
- **Titles:** Pioneer (migration), Stormchaser, Tamer of the West Wind, Avenger each land through their event.
- **Empty content:** with every wave-14 folder empty, the field export and the server's spawns equal wave 13's (G7).

### 7.6 I-14: integration checklist (the lead)

1. Merge per §7.4; suite, typecheck and the Low guard after each merge.
2. X1 and X2 (D46) under the convert lock with their checks; BAL-1 at X1.
3. A scripted play-through on a private server (temp DB copy): a character 1 → 5 in B1 (packs, a coward), a GM jump to
   14 in B4 (healer first), 15 with JG_X01 (2 Incense), a death, Wing I with three bots, a Qilin event, a nemesis born
   and avenged, the ferry to the far bank, Mo-Dun with a duo.
4. Two browser clients (WebGPU and `?engine=webgl`) in the same tomb slot and at the same Qilin seat.
5. BAL-14 (§5.5), LAB-14 + S-14 (§6.4); a G1 miss goes to §9 before release.
6. Shots for the user (Dropbox `wave14/`): the three wings, a boss telegraph, the Qilin in a storm, rank I and III
   nemeses, the far bank, the death banner.
7. Docs: BALANCE.md (the D30 curve, rates, the merged hours), QUESTS.md (the rewrite, 13 + 3 + 1 quests, base-code
   match), UNIQUES.md (mini-bosses, the module additions, the Qilin), SKILLS.md (Arts), SYSTEMS_COMBAT.md (roles, rule
   #13, telegraphs), FIELDS.md (bands, the far bank), NAVIGATION.md (two homes, the composite nav), RENDER.md (the
   interior profile, the beacon), PROTOCOL.md, DEPLOY.md (three migrations, the dry run, the rates line), PLAYTEST.md
   (§11's checks), BACKLOG (wave 14 done, §14), each spec's status; mark the passages this plan overrides (D3, D22,
   D23, D26, D27, D30, D31, the migration numbers).
8. Scratch: keep every image the user reviewed; delete the prototypes' large outputs after the owning lane ports them.

### 7.7 H-14: the hunt (read-only; findings become tests, then F-14 fixes)

The specs' own lenses stand. H-14 runs these with all four items on, each by a separate agent or pass:

1. **Power-levelling:** a capped mentor carrying a newcomer in the field, in Wing I, at the Qilin (D33).
2. **Rule #13 dodges:** a closed tab at low HP, a lost socket, a return-to-town before death, a death inside a
   sanctuary, a GM kill, a fall; a death just after a level-up (accepted, CLIMB §6.4).
3. **Refund loops:** die to your nemesis beside a Rebirth healer, then avenge (A15); two refunds above the loss.
4. **Incense:** duplicated, banked in storage past 5, traded, fed by a capped friend, from shards and the Vault both.
5. **Grace abuse:** boss zerging inside 10 min (the dark lamp), a chain of deaths burning more than one Incense.
6. **Tomb farming:** reset farming by re-entry (one live instance), slot hoarding, a late joiner's chest, the Favour out
   of band or twice a day, a carried 15 in Wing III, leash-reset add farming.
7. **Nemesis farming:** alts feeding ranks, a rank V in a day, a nemesis walked into a lower band (drift ≤ 100 m), one
   born in town, the springs or the Tomb.
8. **Qilin farming:** a level-1 alt collecting fragments, tap-and-run to end the event, a solo kill (lone hunter), a
   GM-held storm summoning it, a restart for a free beast.
9. **Field farming:** two levels down (the level rule), mini-bosses' adds, a coward kited forever, an endless healer
   loop, the B4 border camping newcomers, a bounty camped by a capped player.
10. **The ferry:** used to escape a fight; a far-bank landing inside a nest's roam.
11. **Quests after the migration:** a done quest turned in again for the new EXP; JG_013 sending a 9 into B4.
12. **The migration:** run twice (`curve_version`), a level-20 character, a character mid-quest, a full bag at the
    Incense grant.
13. **The spatial seams:** a position used without the stage origin; a warp clamped to the field; a move crossing
    `TOMB_X0`; a tomb surface key restored in the field.
14. **Telegraphs:** a hit outside the shape; a dodge on screen that the server counts as a hit beyond 0.3 m.
15. **The weather hold:** a GM hold over the event hold; fishing during a held storm; a second Qilin in the next storm.
16. **Notices:** the town alarm for the Qilin; a nemesis notice storm at boot; "defeated" for a flight.
17. **Spawns:** the remap leaving an unmapped nest or a derived row without monsters; the summit clearing leaving a
    nest paused.
18. **The far bank:** the 852 monsters awake with nobody near (dormancy); Earth Ghost Canyon spawning.
19. **Gold at ×1:** a solo player stuck in T3 gear at 17; a trio losing money in the Tomb every run.
20. **Server spikes:** an instance's creation tick; a nemesis birth's write; GC with 4 parties inside.
21. **Hitches:** the first telegraph, beacon, aura, tomb entry; leaks on tomb ↔ field × 3.
22. **Low changed** by any item (the Low guard and a pixel diff of the plaza with nobody titled).
23. **Protocol:** an old client on the new server for one move; every new message through the validators at their
    bounds.
24. **Deploy path:** the deploy list (the `qin-tomb` export, three migrations, the backup, the dry run, the rates line).

### 7.8 F-14, G-14, V-14

- **F-14:** one fixer per file set (the owning lane's files, or I-14 for seam files), each fix with the test H-14 wrote;
  a fix that changes a frame cost is re-measured on its LAB-14 scene; one that changes an export runs X3.
- **G-14:** a re-bench of every §6.4 scene and S-14 on the final tree and export, quiet machine, GPU lock; BAL-14's
  server row again; `budgets.md` gets "final gate" numbers; G1–G8 judged.
- **V-14:** a fresh agent that built nothing in this wave re-reads this plan, the four specs and the diff; checks each
  never-cut item and each decision of §2 (file owners: `git log --stat` per lane); re-runs the suite, typecheck and
  `merged.ts` on the shipped content (the mix median in 38–42 h); re-derives three G-14 cells (Wing III WebGPU Medium,
  the Qilin scene on WebGL2, S-14's p99); plays §7.5 on a private server; checks the migration dry run on a copy of a
  schema-13 DB; reports [confirmed] / [failed] per item. Nothing ships on a [failed] never-cut item.

---

## 8. The migration of the 3 live accounts

### 8.1 What is kept [decision; CLIMB §9]

Level, **the bar's fraction**, SP and SP-EXP, masteries and skills, stat points, items, gold, quests done and in
progress, the Rested pool (clamped at login by wave 13's rule), the refreshment, fishing, mounts, guild, everything
else. **Nothing is lost, and nobody loses a level.**

### 8.2 The conversion (W14-SV's login step, CL-D's table; tested by W14-SV and V-14)

- **`curve_version` 0 → 1 at the first login after the deploy:** `exp_new = floor(exp_old / oldNeed(L) ×
  newNeed(L))`, kept below `newNeed(L)`; `oldNeed` = `work/out/data/levels.json` (retail, as the live server uses it),
  `newNeed` = D30's rows. At 20 nothing changes. The title **"Pioneer"** is granted (CL-U's row). One transaction.
- **`curve_version` 1 → 2: grants.** Characters at **15+** receive **2 Ancestor's Incense** into the bag, else into
  storage; if both are full, the grant waits (`curve_version` stays 1) and is retried at each login with a line ("Your
  ancestors left you two incense sticks; make room in your bag"); below 15, 1 → 2 at once [decision: no mail module
  exists (CLIMB Q5), and the EXP step must never run twice].
- A quest **done** under the old numbers stays done; an **in-progress** quest pays the new numbers when turned in.
- The live rates change from ×3 to ×1 at the same deploy (D41), so the converted bar fills at ×1 from then on.

### 8.3 Proving it before the deploy

1. **Tests** (W14-SV): a schema-13 temp copy with characters at levels 1, 6, 11, 15, 19 and 20 at 0 %, 37 % and 99.9 %
   of their bars, one mid-quest, one with a full bag: after login every level is equal, every bar fraction equal to
   within 1 EXP, every item and quest row identical, the Incense delivered or pending, a second login changes nothing.
2. **The dry run at deploy** (`apps/server/scripts/climb-migrate-dryrun.ts`, W14-SV): on a **copy** of the live DB on
   the mini PC, after the named backup, it runs migrations 14–16 and the conversion, prints each character's level and
   bar % before and after, and exits non-zero on any level change, any fraction off by more than 0.01 %, or any row
   count change outside the new tables. The deploy stops on a non-zero exit.
3. **The live accounts' levels are [unknown] here** (the live DB is on the mini PC); the dry run's printout is the
   first time anyone sees them, and NM-B re-runs `week.ts` with them (NEMESIS Q6).

---

## 9. Scope-cut order (cut from the top; one list for the wave) and never-cut

Each item names its spec's cut. Items marked **ask first** are cut only after telling the user. A cut that removes EXP
(the Favour, the Qilin, the far bank) triggers a `merged.ts` re-run and, if the mix median leaves 38–42 h, a 15–19
re-scale (D30).

1. The Tomb's Treasure Vault (TOMB cut 1; shards keep the Incense trade).
2. The Qilin mount's rain trail (QILIN cut 2); its idle aura (cut 3).
3. The nemesis grudge list (NEMESIS cut 1); the minimap claw (cut 2).
4. CLIMB's set bonuses (cut 2).
5. The Tomb's Statue Room (TOMB cut 4: the second seal from the mirrors' second beam).
6. The Qilin's shed scales on flights (QILIN cut 4).
7. The level-20 bounty board and the weekly MB7 quest (CLIMB cut 3).
8. Horses inside the Tomb (TOMB cut 3).
9. The nemesis flame shroud at III+ (NEMESIS cut 3).
10. The Qilin's restless moves (QILIN cut 5).
11. The achievements and titles module (CLIMB cut 1, TOMB cut 2, QILIN cut 1): the bus events stay; titles move to a
    later wave; "Pioneer" waits for it.
12. The pits' pressure plates (TOMB cut 5); the trap gallery's plates and lever (cut 6).
13. Nemesis given names at III+ (NEMESIS cut 4); the Qilin's horn (QILIN cut 8).
14. CLIMB's Arts (cut 5; SP as today; the Rebirth refund stays 50 %).
15. Nemesis time growth (NEMESIS cut 5).
16. Half the new quests (CLIMB cut 6; keep JG_X01, the ferry quest, JG_X15).
17. The Qilin's guard rule (QILIN cut 7).
18. SoHaow's Ward and jewels (TOMB cut 7).
19. The Qilin's summit clearing (QILIN cut 6; the first events measure the adds).
20. The nemesis Seal of Star at V (NEMESIS cut 6).
21. Mini-bosses MB1 and MB2 (CLIMB cut 7).
22. The Qilin mount (QILIN cut 9; it moves to wave 15).
23. **Ask first:** the ferry and the far bank (CLIMB cut 4; B7 falls back to Jangan Ferry's 13 nests and B5's top; the
    curve re-run).
24. **Ask first:** Wing II as a whole (TOMB cut 8: Wing I + Wing III, Wing III's band widens to 17–20).

If G1 still misses after the cuts that touch the scene (2, 8, 9, 13, 18), the crowd levers of wave 11 apply and the
numbers go to the user.

**Never cut:**

- **The re-levelled bands with real difficulty:** the seven bands, the derived roster, the four roles and elite camps,
  the level rule, mini-bosses MB3–MB7, Tiger Girl at U-BAL as the capstone, the gear tiers' drops.
- **The EXP curve to ≈ 40 h** at ×1 (D30, checked by BAL-1 and V-14), the rates change with the user's OK.
- **The user's death penalty exactly as stated:** 15+ (to 19), a random 1–20 % of the current level's bar, monsters
  and bosses only (nemesis, Qilin, Tomb included), never a de-level, never duels or the arena, the clear message; with
  the grace, the Incense, the linger and the refund cap (the user confirms these three nets, §11).
- **The Tomb:** instanced slots, entry 2–4 at 15+, Wings I and III at least, telegraphs with banner lines, personal
  chests and the in-band Favour, lamps with the dark boss lamp, one live instance per character, per-area clamping
  and the stage origin, the interior profile.
- **Nemeses:** the user's title form, persistence, the return stronger, better loot, eligibility and caps, the
  once-per-account rank rule, the refund, the pending grudge, the victim notices and the near hint, the calibration
  contract.
- **The storm Qilin:** the storm trigger, the six seats, the chase with flights, the beacon on every preset, the
  announcements, the ascend and lone-hunter rules, the credit rule.
- **Everywhere:** the migration without loss (with the dry run), the S-DEATH seam, the Low guard, G1, G4, G6, G7, G8.

---

## 10. Named slots for waves 15 and 17

Every slot is a row in `content/climb/slots.json` with `enabled: false` (CL-D), so drop tables and quests can name it
now and nothing drops until its wave fills it with art [decision: CLIMB §4.3]. Items that bank the reward now are real
items this wave.

| Slot | Wave | What | Tier / level | Source | Stat budget | Banked now |
|---|---|---|---|---|---|---|
| **W15-A** Terracotta Regalia (CLIMB's "Tomb Warden's set"; D27) | 15 Wardrobe | heavy, light and clothes sets, 6 pieces (head, shoulders, chest, hands, legs, feet), req ≤ 20 | T6–T7 / 18–20 | the Qin-Shi Tomb only | = Seal of Star B per piece + the SoS set bonus | **Terracotta Regalia tokens** (TB-L: 25 / 35 / 50 % per chest, 50 % from the Vault; stackable, bound, kept); wave 15 adds the Steward's exchange |
| **W15-B** Tiger-Hunter's set | 15 | the three classes | T5 / 16 | Tiger Mountains drops, MB5, Tiger Girl | = 03_A per piece + the family bonus | — |
| **W15-C** Ferryman's coat and hat | 15 | civilian clothes | any | the ferry quest JG_X07, then the far bank's vendor | cosmetic | the quest names the slot |
| **W15-D** Millet Farmer's clothes | 15 | civilian clothes | any | a B1 quest reward | cosmetic | — |
| (W15, cut 22 only) the Storm Qilin mount | 15 | a cosmetic mount | 15 | 5 Storm Horn Fragments or the 3 % bridle | Red Horse speed | **Storm Horn Fragments** (bound, stack 5) if the mount is cut |
| **W17-A** Qilin-touched weapons | 17 Arsenal | five weapon families with a lightning rarity effect | T7 / 20 | crafted from **Thunderscales** | = SoS B + 5 % | **Thunderscales** (`ITEM_ETC_STORM_SCALE`, tradeable, ≈ 3–5 a week for a regular) |
| **W17-B** Tiger Girl's Fang | 17 | the talking legendary weapon, its own skill | T7+ / 20 | a long quest begun by a **Tiger Fang Shard** (Tiger Girl 5 %) and completed with the **Broken Hilt of the Emperor** (SoHaow 2 %) | = SoS B + 10 % | **both curios drop this wave** (bound; "It hums when you hold it.") |
| **W17-C** The Robber Chief's Hook | 17 | a glaive with a rarity effect | T4 / 14 | MB3 1 % | = 02_C + 15 % | — |
| (later crafting) Quicksilver Vial, Dragon Pearl | — | curios | — | the Viper's chest 20 %; FISHING | — | yes |

Wave 16 (Faces & Hair) gets no slot from this wave.

---

## 11. What the user must provide or approve

**To start: nothing.** Every tool is installed, nothing is downloaded, no Meshy credit is planned, every item has a
default.

1. **The preview sheet** `work/tmp/w14-preview.png` (Dropbox `wave14/w14-preview.png`): the band map, the hours chart
   (today vs the plan), the Tomb's three wings and its bosses, a nemesis example and its power ladder, the Qilin's six
   seats and its look. **Default:** build as shown.
2. **Confirm the death penalty's three safety nets** around rule #13: the **10-minute grace**, the **Ancestor's Incense**
   (never sold, bound, at most 5), the **10 s combat linger** when a tab closes mid-fight. **Default:** all on.
3. **The Qilin's look:** storm-blue with gold talismans (as shown) or more gold. **Default:** storm-blue.
4. **After the build, about 2 hours of play** (PLAYTEST.md gets the list): one evening at 14–17 with a friend (the Tomb
   Approach, the Tiger Mountains, one mini-boss); one Tomb wing per band (≈ 20 + 40 + 20 min, or the wing of your
   band); one GM-started Qilin with friends; meet a rank-I and a rank-III nemesis. Say "too easy / too hard / too long"
   per item. **Default:** the models' numbers stand; every knob is content.
5. **The deploy OK for wave 14** (a new one; it needs waves 12 and 13 first or together). It includes a **named DB
   backup**, the **migration dry run** on a copy of the live DB (it shows your characters' levels and bars before and
   after; nothing is lost), three migrations, ≈ +10–13 MB of assets (the Tomb downloads on first entry), and **changing
   the live rates from ×3 to ×1** in `silkroad.local.env`. **Default:** nothing deploys until you say so.

**To know (not to decide):** with every wave-14 reward on, the simulated mixed friend reaches 20 in ≈ 40 h, a friend
who never groups in ≈ 57 h, a friend who mostly groups in ≈ 36 h; a death at 19 costs on average ≈ 1.5 h of hunting
and at worst ≈ 2.8 h. Two places have no frame measurement yet (the far bank, the view from a summit); the bench
measures them before anything ships.

---

## 12. Risks

| Risk | Default handling |
|---|---|
| Waves 12 or 13 slip, or change the seams wave 14 builds on (S-REWARD, the authored merge, `openShore`) | step 0 waits for wave 13's final commit; the pre-start runs meanwhile on new files |
| The models' skill tiers are wrong; real friends die more (no terrain, line of sight or lag in any model) | every number is content; BAL-14 and the user's evening re-tune band attack and pull sizes first; `penalty.json` can narrow the range only with the user's say (it is their rule) |
| The siblings' rewards and the D30 curve drift apart in play (the Favour's value depends on sessions per day) | BAL-1's re-run on the real files; the 15–19 scale is one number; the first month's `/climb stats` |
| Rule #13 feels cruel at 19 on the longer bars (≈ 2.8 h worst roll) | the grace, the Incense, the refunds, groups; the message names the exact loss; the user's evening check |
| Solo-only friends find 15–20 too long (≈ 46 h of the 57) | by design ("the Tomb and big bosses need a group"); the D30 ramp is one table; reported to the user (§11) |
| The tomb's float32 shimmer or a raw position path | the stage origin (W14-G), the slot-5 test, hunt lens 13 |
| The field rebuild after every tomb exit is slow | LAB-14 times it; over 10 s the field stays resident (TOMB §10.1) |
| Tick spikes on the N100 (GC, SQLite) | S-14 reads `worstTickMs` with the full load; not tomb-specific |
| The far bank or the summit view misses 60 fps | LAB-14 rows; the render lanes own the fix; cut 23 (ask first) for the ferry |
| Nemeses too rare (few deaths) or too common | chance and caps are content; NM-B's Q8 rule with the live levels |
| The uniques module grows four ways at once in step 0 | one agent (W14-SP), Tiger Girl's existing tests, a frozen file after step 0 |
| Three migrations in one deploy | one owner, the step test 13 → 16, the dry run, the named backup |
| Name collisions (Warden, Old Scar, Stormchaser) | D27; NM-P's boss-name check |

## 13. Open questions (each has a default, so nobody waits)

| # | Question | Default | Who settles it |
|---|---|---|---|
| Q1 | The live accounts' levels | unknown here; the dry run prints them; the migration covers any level | the deploy |
| Q2 | Should solo-only climbing past 15 be faster than ≈ 46 h? | no: the user's "groups for the Tomb and big bosses"; one table if the user says so | the user after play |
| Q3 | Halve the Favour instead of lengthening 13–19? | no (D30): each sibling keeps its tuning | the user |
| Q4 | Should a nightly soaker's 36.7 h be trimmed (`capFrac` 0.15 at 15–19)? | no | the user |
| Q5 | The live `WEATHER_SEED` / `WEATHER_RAIN_SCALE` | seed 1, scale 1 (≈ 2.1 storms a day for any seed) | read at deploy |
| Q6 | The Incense icon | the nearest retail scroll or talisman icon | CL-D |
| Q7 | Should the Qilin trigger at 16 instead of 15 (net negative EXP at 15)? | no (D35) | the user after the event |
| Q8 | Tomb deaths cheaper than rule #13? | no (TOMB Q1): the rule as written | — |
| Q9 | 5-player tomb parties; a solo 20 in Wing I | no; no (TOMB Q2, Q3) | — |
| Q10 | Nemesis given names English or Chinese-style | English (NEMESIS Q3) | the user |
| Q11 | Duels or an arena later | the penalty already excludes them | a later wave |
| Q12 | Does the Qilin's dropped bridle trade? | the dropped one trades, the quest one is bound (QILIN Q6) | — |

---

## 14. Hooks and deferred

**Hooks left for later waves** (each a seam, no migration needed):

- **Wave 15 (Wardrobe):** the W15 slots (§10), the Regalia tokens' exchange, the Storm Qilin mount if cut, civilian
  clothes as quest rewards already named.
- **Wave 17 (Arsenal):** Thunderscales, the Tiger Fang Shard and the Broken Hilt (W17-B), the Robber Chief's Hook
  (W17-C); weapon rarity effects can reuse the nemesis aura path (SystemFx loops).
- **The Tomb:** floors 2–4 (the teleport maze, two labyrinths), the sealed south arm, the three sleeping guardians,
  SoSo the Black Viper and ShinMoo: a hard mode or a 21+ tomb.
- **The Qilin's module is data-driven** (`content/events/*.json`): a second storm beast is content.
- **The penalty's events** (`penaltyTaken`, `penaltyRefunded`) and the achievements bus serve any later system.

**Deferred:** a mail module (the Incense grant uses the bag); duels and an arena; Earth Ghost Canyon and the Donwhang
entrance (27–30); exporting retail B-tier skills; the performance pass after wave 13 (BACKLOG item 9, the only fix for
20-player crowds at a summit or Tiger Girl); still queued from earlier waves (WAVE_PLAN9 §12).

## 15. Housekeeping

- The four specs stay the detailed design; this plan's decisions override them where they differ (D3 one telegraph,
  D5 the migration numbers, D6/D7 the spawner and uniques owner, D22 the quest files, D23 eligibility, D26 JG_X15, D27
  the names, D30 the curve rows 13–19, D31 the per-wing trash multiplier). I-14 marks the overridden passages.
- No lane commits; the lead integrates each step. No lane starts or stops the user's dev servers (:5180, :7000,
  :5173); private servers on free ports with temp DB copies only; at most one browser tab per lane, closed when done;
  every in-browser timing under the GPU lock on a quiet machine (3 runs, median).
- Every Meshy job is a NIGHT_LOG row (D49). This plan spent 0 credits, downloaded nothing, opened no browser, took no
  GPU lock and started no server.
- Scratch used by this plan: `work/tmp/w14-plan/merged.ts` → `merged.json` (§5; ≈ 2 s:
  `pnpm tsx work/tmp/w14-plan/merged.ts`), `work/tmp/w14-plan/budget.py` (§6.2, §7.2), `work/tmp/w14-plan/make_preview.py`
  → `work/tmp/w14-preview.png`. No frame timing was taken for this plan: every frame number is a spec's measurement or
  a projection from one, and LAB-14 measures them.
