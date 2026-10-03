# The Storm Qilin (wave 14, "The Climb")

The user, verbatim (wave 14):

> A storm beast: during thunderstorms, a lightning Qilin appears on the mountain peaks for a short time, a rare chase
> across the map.

The same wave re-tunes levels 1–20 (rates back to ×1 with a new curve, ~40 h to the cap), adds the Qin-Shi Tomb group
dungeon, nemesis monsters and the death penalty after level 15 (the user's rule #13). Those are their own specs. This
one designs the Qilin and leaves seams where it touches them (§6.6).

**What this spec builds, in one paragraph.** When the seeded weather rolls a thunderstorm and someone of level 15 or more
is in the world, a **Storm Qilin** descends in a lightning bolt on one of **six Thunder Seats**: real, walkable summits
of the Jangan map (the highest is Tiger's Crown, 232 m, South-Tiger Mt.). Everyone in the world reads "The Storm Qilin
has descended on Tiger's Crown!", and a bolt strikes that summit every 12–20 s, visible from across the map. The Qilin
holds the storm for as long as it is out. When a hunter comes within 40 m, it rears and **bolts away in lightning** to a
neighbouring seat that no hunter guards. It does this twice, shedding a Thunderscale each time, then it is
**cornered**. A group that splits up to guard the seats can corner it sooner. Cornered, it stands its ground and waits
up to 5 min for the group to gather. Then comes a **short, flashy fight**: a level-20 unique with 29,936 HP, three
lightning volleys of telegraphed bolts, and an enrage. A group of 3–4 at level 20 needs about 2 min, a pair about 3.5 min.
A solo player does not win: it ascends 5 min after the first hit, and it takes less damage while only one player fights
it (the lone-hunter rule, §5.1). Without that rule, a flawless level-20 glaive solo would win (§5.2). When it falls, the
clouds part. The group gets gold, a cap-wearable item, 10 % of a level's EXP each, Storm Horn Fragments (five make the
**Storm Qilin mount**, a 3 % direct drop too), the **Stormchaser** title and **Thunderscales**, the lightning material
that wave 17's weapons will use. On the real
schedule this happens **about 1.6 times a week** while the friends play.

**The user delegated every decision.** Each choice is the option this spec would mark "(Recommended)", written as a
decision with a one-line reason (§14). Only what truly needs the user is in §15/§16, each with the default used.
Delegation is not a deploy OK.

**Tags:**

- **[confirmed]**: checked in the code or data of the working tree on 2026-10-02, or measured by this spec's scripts.
  Each one says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived), not measured on that setup.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this spec makes.

**Repo state** [confirmed: `git log -1`, `git status`, 2026-10-02]: HEAD `2b7450b` ("Wave 12 step 0: seams …"), and
wave 12 is building in the working tree (49 changed paths). This spec edits nothing in `packages/`, `apps/`, `content/`
or `deploy/`. All of its scratch is in `work/tmp/qilin/` (Appendix A). No GPU timing was taken, so the GPU lock was not
used. No Meshy credits were used (§7). No browser was opened.

**Fact-checked 2026-10-02** (an adversarial pass that re-ran `storms.ts`, `chase.ts` and `sim.ts --qilin`, and added
`sim-fc.ts`, `expshare.ts`, `seatcheck.ts` and `release.ts`). It corrected the spec in place, and the corrections are
listed in §0.2. It also read the sibling wave-14 specs written at the same time: docs/CLIMB.md (the curve, the
10 %-a-kill budget, the achievements and titles), NEMESIS.md (S-ELIG, S-DEATH) and TOMB_DUNGEON.md (titles, the door).
Nothing outside this doc and `work/tmp/qilin/` was touched. No GPU timing was taken, no browser was opened, and Meshy
was not used.

**Sources read:** docs/WEATHER.md (the state machine, schedule, lightning wire, bolt, presets), UNIQUES.md (the world-boss
module this extends), BALANCE.md, SYSTEMS_COMBAT.md, SKILLS.md, FIELDS.md, QUESTS.md, PLAYTEST.md, WAVE_PLAN9.md (the
format), HOT_SPRINGS.md (§5.7 hooks, the sanctuary), FISHING.md (§10.4 hooks, authored items), EFFECTS.md (the ground
decal), MOVEMENT.md (mounts). Code: `apps/server/src/{weather, uniques, modules, mounts, gameplay, nav, config, db}.ts`,
`packages/shared/src/{weather, protocol, content}.ts`, `packages/world-render/src/weather/{rain, presets, index}.ts`,
`apps/game/src/world/features/weather.ts`, `apps/game/src/world/effects.ts`. Data: `work/out/data/{mobs, nests, cos,
levels, zones, items}.json`, `work/out/world/jangan-fields/manifest.json` + `nav.bin` (through `MeshNav.load`), the
retail `characterdata_*.txt`, `textdata_object.txt`, `textdataname.txt` and `Particles/**` in `work/extracted/`.

---

## 0. Summary

1. **Trigger** [decision; schedule measured, §2]:
   - **When:** at the start of every **scheduled storm** (the wave-9 weather state `storm`, never the `rain` that only
     has some lightning), if ≥ 1 player of level ≥ 15 is in the world and the Qilin has not come in the last 20 h.
   - **Rarity:** at most once per storm.
   - **Measured on the live seed (1), over a year:** the real `WeatherSchedule` gives **2.13 storms a day**, 8.4 min
     median.
   - **Projected for the friends:** with evening play (§2.2), that is **≈ 1.6 appearances a week**.
2. **It holds the storm** [decision]. The weather module gets an "event hold" (a seam, §9.2). The storm lasts as long as
   the Qilin is out, at most 30 min. After a kill the sky clears (cloudy, then clear, for 15 min). After an escape the
   weather returns to whatever the schedule says by then: at 25–30 min that is mostly overcast (53–60 %), then rain
   (27–36 %), and another storm 6–9 % of the time [confirmed: `release.ts`, seed 1, a year]. The cooldown stops a
   second Qilin.
3. **Omen and announcement** [decision]:
   - **The omen:** a world-positioned bolt hits the Qilin's seat every 12–20 s. Thunder follows by distance.
   - **The announcement:** a world line on every change: descended, bolted toward …, cornered, defeated, ascended.
   - **Why both:** a sky omen alone fails on a 3.6 km map during an 8-min storm. On Low/Medium the weather bolt is not even
     drawn [confirmed: `presets.ts` `bolt: false`].
4. **Six Thunder Seats** [confirmed on the nav, §3; image `work/tmp/qilin/qilin-map.png`]: walkable summits in the
   town spawn's walkable component, found by a census of 40 summits:
   - Tiger's Crown, 232 m;
   - Yeoha Spire, 195 m;
   - White Tiger Ridge, 175 m;
   - Ye Crag, 121 m;
   - Tomb Cliff, 147 m;
   - Hill of Ye, 62 m.

   Ten flight edges join them, with measured walking routes of **0.93–2.34 km** (2.8–7.1 min on foot, 1.6–3.9 min on
   the Red Horse). Two higher peaks were rejected, with reasons: the Qin-Shi ridge has a single 2–3 m-wide approach, and
   the Lake Forest summit cannot be reached.
5. **The chase** [decision; simulated, §4; sketch `work/tmp/qilin/qilin-rules.png`]:
   - **Spooking:** a hunter within 40 m spooks it.
   - **Flights:** it has **2 flights** a visit, to a neighbour seat that no hunter guards (a player within 80 m), chosen
     away from the hunters.
   - **Cornered:** with no flights left, or every neighbour guarded, it is cornered and stands for up to 5 min.
   - **Restless:** after 8 min unhunted it moves on by itself.
   - **The window:** 20 min from the omen to being cornered.
   - **Simulated:** mounted groups corner it in **100 %** of runs, median **8–12 min**. A lone rider does too (median
     11 min). Players on foot manage 50–71 %. Guarding saves 2–3 min but costs regrouping.
   - **Mounts are allowed.** They are retail's chase tool, and attacks are refused while mounted, so riders dismount to
     fight [confirmed: `mounts.ts`]. The Red Horse needs level 10 and costs 1,200 gold, so every hunter can ride.
6. **The fight** [decision; simulated with the server's own formulas, §5]:
   - **Stats:** a level-20 unique on Tiger Girl's level-20 attack line and rows, **29,936 HP** (her HP × 0.05).
   - **Volleys:** at 75 / 50 / 25 % it skips 15–25 m (a warp; the 2.5 s gap is players closing in) and calls
     **3 telegraphed bolts on every player** (1.5 s ground circles, then a bolt for ≈ 160 damage each when not dodged
     [projected]).
   - **Enrage** at 20 % (×1.25).
   - **Ascends 5 min after the first hit.**
   - **Lone hunter** (added by the fact-check): while only one player has hit it in the last 30 s, it takes ×0.6
     damage.
   - **Time to kill:**

     | Group | Time | Wins |
     |---|---|---|
     | 4 × L20 | 1.8 min | 100 % |
     | 3 × L20 | 2.4 min | 100 % |
     | 2 × L20 | 3.6 min | 100 % |
     | 2 × L18 | 4.5 min | 92 % |
     | 4 × L15 | 4.2 min | 47 % (a death in 96 % of runs) |
     | solo L20, uptime 0.7 | — | 0 % (it ascends with ≈ 30 % HP left) |
     | solo L20 glaive, flawless (uptime 1.0) | 4.7 min | 97 % without the lone-hunter rule, **0 % with it** (57 % HP left) |
7. **Rewards** [decision, §6]:
   - **The loot-owner group:** gold, one cap-wearable degree-3 item (+0…+3), an elixir, and a **3 % Storm Qilin Bridle**.
   - **Every credited hunter of level 15 or more:** **10 % of their own current level's EXP bar** (and as much SP-EXP),
     paid by the module whatever the party size. That is CLIMB §3.5's cap for a single kill, ≈ 0.4–1.2 h of hunting.
     Also **1 Storm Horn Fragment** (bound), **2–3 Thunderscales**, and the **Stormchaser** title on the first credited
     kill, through CLIMB's achievements. A hunter who died in the fight still counts.
   - **Each flight** sheds a Thunderscale on the ground, so the chase pays even without a kill.
   - **The mount:** five fragments buy the **Storm Qilin** mount at the Jangan stable keeper, through a repeatable
     deliver quest. It is cosmetic in power: Red Horse speed, more HP, and a reusable bridle.
   - **Thunderscales** are wave 17's lightning-weapon material: a named slot, banked now.
8. **The model** [confirmed: converted and rendered, §7; `work/tmp/qilin/qilin-look.png`]:
   - **Retail has no qilin:** no "qilin/kirin" in the text data. The four Qin-Shi guardians are the four symbols.
   - **The boss:** the retail **Demon Horse** (鬼生馬, `mob/wchina/demonhorse`). It has 14 clips, including ATTACK1,
     DOWN and STUN. It gets a texture-level storm recolour (its red wounds become glowing cyan cracks, its gold talismans
     stay gold) and a small horn built in bpy on the head joint.
   - **The mount:** the retail **Unicorn** (獨角獸, `cos/c_unicorn`), which has the Red Horse's skeleton, so the rider
     seat and clips work unchanged. It gets the same palette.
   - **Meshy:** 0 credits.
9. **Effects:** world-positioned bolts on every preset (a small "beacon bolt" pool beside the weather's camera-relative
   bolt), the retail lightning-step and thunder-hit particles (`lightning_bobeop_move_*`, `lightning_chundung_hit_*`,
   converted already), ground telegraphs through the existing `TargetDecal`, and the existing thunder sounds. The screen
   flash honours `reduceFlashing`.
10. **Costs** [projected, §10]:
    - **Server:** one mob and a 1 Hz scan of ≤ 20 players against 6 seats: ≈ 0 ms on the N100. About 60–160 small
      messages per event, mostly beacon bolts (§10.1), under 10 KB per client. No migration: the event is one row in
      the wave-11 `uniques` table, and titles are CLIMB's.
    - **Client:** ≤ 0.2 ms during the event (one 35-joint mob, ≤ 3 beacon bolts of 15 quads, ≤ 12 decals for 1.5 s).
      The crowd at the fight is the cost that matters, the same as UNIQUES' gathering. A party of 4–8 holds 60 fps on
      Medium everywhere. 20 players hold only on the dev PC (≈ 14 ms) and miss on a gaming laptop or an M1 (UNIQUES
      §6, projected there). The far view from a summit is not measured [unknown] (§10.2).
    - **Download:** ≈ +0.15 MB brotli on first sight (the two glbs).
11. **Nothing blocks the start.** The user judges the look (`qilin-look.png`) and the seat map, and after the build plays
    one GM-started event with friends (§11.4).

### 0.1 Where each part of the request lands

| The request | Where | Lanes |
|---|---|---|
| "during thunderstorms" — the trigger and frequency (storm length, chance, at most once per storm) | §2 | QL-S, QL-W |
| "appears on the mountain peaks" — the peaks, real and reachable | §3 | QL-Q |
| "for a short time" | §2.3 (window, hold), §4.3 | QL-S, QL-W |
| "a rare chase across the map" — flees, teleports in lightning, cornering, mounts | §4 | QL-S, QL-C |
| (task) the fight: a short, flashy boss, level ~18–20 | §5 | QL-S, QL-Q |
| (task) the rewards: a mount or cosmetic, a title, lightning materials for wave 17 | §6 | QL-Q, QL-S (the title through CLIMB's achievements) |
| (task) the model: a retail qilin, a recolour or Meshy | §7 | QL-A |
| (task) the effects: lightning from the weather system | §8 | QL-C, QL-R |
| (task) server and client cost | §10 | all |

### 0.2 Fact-check corrections (2026-10-02)

The fact-check re-ran the scripts. `storms.ts` reproduced 2.13 storms a day, an 8.4-min median and 1.59 appearances a
week. `chase.ts` reproduced every row of §4.2. `sim.ts --qilin` reproduced every row of §5.2. The six seats re-placed on
the nav at the listed heights, at the listed distances from Tiger Girl's camps (`seatcheck.ts`). The glb sizes, joints
and clips matched the sidecars. The following claims were wrong or missing, and the spec now says otherwise:

| # | What the draft said | What is true [how] | Fixed in |
|---|---|---|---|
| F1 | "A solo player never wins" | A flawless level-20 glaive solo wins 97 % (uptime 1.0), and 92 % at uptime 0.85 with Berserk. A blade solo with Berserk at uptime 1.0 wins 99 % [confirmed: `sim-fc.ts --qilin --fc`, 200 fights a case]. Added the lone-hunter rule (×0.6 damage taken): every solo case drops to 0 %, with ≥ 57 % HP left. Groups are unaffected. | §5.1, §5.2, D31 |
| F2 | EXP pool of half a level-19 bar "adds only a few percent to the climb" | On CLIMB's curve (L19 bar 351,000) half a bar is 57,000 each in a party of 4 (≈ 2 h of hunting at L16–18) and 96,500 each in a duo (≈ 3.5 h) for a 15-min event, 37–62 % of an L16 bar. A regular would save ≈ 4.2 h of the 27.5-h band from 15 to 20 [projected: `expshare.ts`]. That breaks CLIMB §3.5's budget: "a single kill pay at most 10 % of a level". Now the row pays no EXP, and the module pays each credited hunter **10 % of their own bar**: ≈ 0.4–1.2 h of hunting, 3.8 % of the band (1.4 h) for a regular [projected: `expshare.ts`]. EXP_RATE applies (×1 with the climb). | §6.1, D17 |
| F3 | Red Horse "is the level-20 horse" [likely] | The cos row is level 20, but the item `ITEM_COS_C_HORSE1` needs **level 10** and costs **1,200** gold [confirmed: `items.json`]. Every level-15+ hunter can ride, so the on-foot rows of §4.2 are the exception. | §4.2 |
| F4 | "Attacks already force a dismount" (D10) | Attacks and skills are **refused** while mounted. The rider must dismount to fight, and hits on a rider land on the horse [confirmed: `mounts.ts` header]. | D10 |
| F5 | The town alarm "does not ring" (D28) | `town-sound.ts` 180 starts the alarm on **every** `uniqueNotice` `appeared`. `uniqueNoticeText` prints the "defeated" sentence for any event that is not `appeared`. `UNIQUE_CUES` `satisfies Record<event, …>`, so new events fail the build until added [confirmed: code]. QL-C now owns those two files. | §8.4, §11.2 |
| F6 | `reduceFlashing`: "the bolt is drawn with no screen flash" | Today `reduceFlashing` removes the bolt entirely and quarters the flash [confirmed: `en-weather.ts`, `rain.ts` header, `features/weather.ts` 268]. With it, the beacon is now a steady glow column that does not strobe. | §8.1 |
| F7 | The 3 % bridle "not scaled by DROP_RATE", "the wave-11 resolver as is" | The resolver applies GOLD_RATE and DROP_RATE to every table [confirmed: `uniques.ts` header]. The bridle is now rated like everything else: 6 % at today's DROP ×2, 3 % at the climb's ×1. | §6.1, D16 |
| F8 | The skip is "2.5 s untargetable" | No mob has an untargetable state [confirmed: grep of `apps/server/src`]. The skip is a `warp`, and the gap is the 3–4 s that players need to close 15–25 m. There is no new combat seam. | §5.1, D13 |
| F9 | Credit to "every credited hunter" | Today's credit drops players who are **dead** at the kill, and party share mode skips them [confirmed: `party.ts` `killShares`]. A death in the fight would cost the fragment as well as rule #13's EXP. The module now pays its per-hunter rewards from the kill's damage map, dead or alive. It also requires level ≥ 15, so a level-1 alt in the party cannot farm fragments. | §6.1, D32 |
| F10 | "Within 60 m" listed the nests without consequence | Aggressive packs reach every western seat's fight circle: Ye Crag sits **46 m** from a Tiger (14) nest centre, and White Tiger Ridge is in reach of White Tiger (18) and Black Tiger (17) packs [confirmed: `seatcheck.ts`, leash 80 m from the centre]. The sim has no adds. Added the summit clearing: normal mobs there are despawned and their nests paused while it stands. | §4.1, D30 |
| F11 | Wave 14 seams were generic, and QL-T built its own title system | NEMESIS S-ELIG names `Mob.tag = 'event'`. Rule #13 needs NEMESIS/CLIMB's S-DEATH seam (the cause reaches the modules), so volley damage must go through `Gameplay.dealHits` with the Qilin as the attacker. **CLIMB §7.3 already designs the wave's achievements and titles** (`EntityState.title`, a `qilinCaught` bus event, a "Storm-Rider" row), and TOMB_DUNGEON grants first-kill titles too. QL-T is dropped, and QL-S emits `qilinCaught`. | §6.4, §6.6, §11 |
| F12 | The Demon Horse sounds are "already in `work/out/sound/monster/`" | Only `wcm_dhorse_thud` is exported. Retail has five more in `work/extracted/Data/prim/snd/monster/` (`die`, `moan1/2`, `shout_a/b`) [confirmed: ls]. QL-A adds them to the sound export. No download is needed. | §8.4, QL-A |
| F13 | The 20-player crowd "≈ 14 ms Medium, under 16.7" | That is the dev PC only. UNIQUES §6 projects that 20 players miss on Medium on a gaming laptop or an M1. ≤ 8 players hold (≈ 13 ms). | §10.2 |
| F14 | After an escape "the storm breaks into the scheduled rain" | At release (25–30 min) the schedule is overcast 53–60 %, rain 27–36 % and storm 6–9 % [confirmed: `release.ts`]. | §2.3 |
| F15 | The 4 × L15 party was not simulated, though level 15 is the trigger level | 47 % win, a death in 96 % of runs, 2.4 deaths a fight [confirmed: `sim-fc.ts`]. Each player loses ≈ 6.2 % of an L15 bar to rule #13 per fight, against 10 % × 47 % = 4.7 % gained: **net negative EXP at 15**, positive from 16 [projected: `expshare.ts`]. | §5.2, R10 |
| F16 | Minor | The Demon Horse's "14 clips" include two root-motion copies (`DIE1_RM`, `DOWN_RM`). Its RUN clip is authored for 7.5 m/s (retail run 75), so at 12 m/s it slides unless played ×1.6. The boss is 2.2 m tall, shorter than the 2.5 m Unicorn mount. | §7.2 |

---

## 1. Today [confirmed unless tagged]

| Fact | How it was checked |
|---|---|
| The weather is one server-authoritative state (`clear … storm, fog`) on a seeded Markov schedule; `storm` is entered only from `rain` (20 %), dwells 5–12 min and leaves to `rain` (70 %) or `overcast` (30 %); lightning is rolled at 5/min in a storm (0.3/min in rain of intensity ≥ 0.8), ≥ 4 s apart | `packages/shared/src/weather.ts` `WEATHER_NEXT`, `WEATHER_DWELL_MIN`, `WEATHER_PARAMS`; `apps/server/src/weather.ts` `rollLightning` |
| A strike is `{t:'lightning', at, distM 300..3000, bearing}`, **cosmetic and camera-relative**: each client draws it `distM` toward `bearing` from its own camera | `protocol.ts` line 692; `rain.ts` `buildBolt(cam, …)` |
| The weather bolt mesh (11 segments + a 4-quad fork, additive) is drawn on **High and Ultra only** | `world-render/src/weather/presets.ts` (`bolt: false` on low/medium) |
| A GM hold (`/weather storm 30`) exists and marks the sync `gm: true`; there is no non-GM hold | `weather.ts` `hold`, `target()` |
| The wave-11 `uniques` module owns world bosses: spawn rules, `uniqueNotice` (`appeared` / `defeated`) to every world socket, a loot table of its own with gear pools `reqLevel ≤ LEVEL_CAP`, `MobTuning`, enrage and fury through `Mob.damageMul`, the `uniques` SQLite table (migration 10) | `apps/server/src/uniques.ts` header; `protocol.ts` 709–718 |
| Modules get `tick`, `mobDied(m, now, credit, owner)`, `playerDied`, `forget`; any entity can be moved with `warp {id, pos, yaw}` | `apps/server/src/modules.ts`; `protocol.ts` 503–507 |
| Horses: Red Horse `COS_C_HORSE1`, run 9 m/s = ×1.8 the player (5.5 m/s → 9.9 m/s); its summon item needs level 10 and costs 1,200 gold, and one is consumed per summon; summoning is refused in combat; attacks and skills are refused while mounted; hits on a rider land on the horse | `work/out/data/cos.json`, `items.json` (`ITEM_COS_C_HORSE1`); `mounts.ts` header |
| Mobs have no untargetable state; `Mob` has `damageMul`, `corpseMs`, `encounter`, `tuning` | grep of `apps/server/src`; `world.ts` 145–156 |
| The client's town alarm starts on every `uniqueNotice` `appeared` | `apps/game/src/world/features/town-sound.ts` 180 |
| `mobs.json` holds 32 mobs; none is a horse-like beast. The client's retail data has **no qilin**: no "qilin", "kirin" or "girin" in `textdata_object.txt` / `textdataname.txt`; the Qin-Shi "guardians" are the four symbols (Black Tortoise, "Blue Hawk", Blue Dragon, White Tiger) | the json; `grep -i` over the decoded UTF-16 text |
| Horse-like retail models: `mob/wchina/demonhorse.bsr` (**Demon Horse 鬼生馬**, levels 25–26), `cos/c_unicorn.bsr` (**Unicorn 獨角獸**, a level-75 mount, run 12 m/s), `cos/c_pegasus`, `cos/c_dhorse1..` (Ironclad Horse 鐵甲蛟龍馬), `mob/casia/peryton` | `characterdata_*.txt` model column; names from `textdata_object.txt` |
| Retail lightning particles, converted: the Chinese lightning force's `skill/china/lightning_bobeop_move_a/b` (the "lightning step"), `lightning_chundung_hit_a..f` (thunder hits), `hiteffect/hit_4_lightning_*`, and `map/lightning.efp`; not converted: the `lightning_ganggi_*` aura family and the guild tower light | `work/extracted/Particles/**` vs `work/out/fx/efp/**` (67 lightning efps, 6 without a json) |
| A ground decal that conforms to the terrain exists (`TargetDecal`, `ClickMarker`) | `apps/game/src/world/effects.ts` 399, 451 |
| Wave 13 adds **authored items** (`content/items/*.json`, merged into `items.json` by the data export) | docs/FISHING.md §3.4, D22, lane FS-I |
| Retail EXP to the next level: L15 96,938 · L16 127,840 · L17 161,798 · L18 198,810 · L19 238,878 (wave 14's climb replaces the curve) | `work/out/data/levels.json` |

---

## 2. Trigger, frequency and duration

### 2.1 The storm on the real schedule [confirmed: `work/tmp/qilin/storms.ts`]

The script walks the real `WeatherSchedule` (`packages/shared/src/weather.ts`, imported, not copied) for 365 days from
2026-10-01. It uses seed 1, the server default; the live seed is in `silkroad.local.env` on the mini PC and was not
read (§15).

| | Seed 1 | Seed 7 (control) |
|---|---|---|
| Storms | **777 = 2.13 a day** (1.26 % of the time) | 757 = 2.07 a day |
| Length p10 / p50 / p90 | **5.7 / 8.4 / 11.4 min** | 5.6 / 8.6 / 11.3 min |
| Gap between storms p10 / p50 / p90 / max | 0.4 / 6.9 / 28.5 / 74.8 h | 0.4 / 6.3 / 28.8 / 94.0 h |
| Next state | rain 73 %, overcast 27 % | — |
| Starts by hour | flat (24–42 per UTC hour) | — |
| Evenings 19–23 UTC with a storm | **29 %** (one every 3.4 evenings) | 23 % |

WEATHER.md §2.3 measured 0.9 % storm time over 60 days. The year-long walk gives 1.26 %; the difference is the sample
length, and both are "rare".

### 2.2 The trigger [decision]

| Rule | Value | Why |
|---|---|---|
| What triggers | the start of a **scheduled** `storm` segment (the moment the server's weather target becomes `storm`) | the user's words; rain with stray lightning is common (3.6 spells a day of intensity ≥ 0.8) and would make the beast ordinary |
| Who must be online | ≥ 1 player of level ≥ 15 in the world (GMs in `/unique quiet` do not count) | no wasted event on an empty server; level 15 is where the climb's late band and the death penalty begin |
| Chance | **100 %** when the rules pass | the schedule already makes it rare; a dice roll on top would make it a coin flip whether the friends ever see it |
| At most | **once per storm**, and **not within 20 h** of the last appearance (persisted) | "at most once per storm"; the cooldown spreads it over the week |
| GM | `/qilin summon [seat]` starts one at once (holds a storm for it); `/weather storm` alone does **not** summon | testable without waiting; a GM-held storm stays a plain storm |
| WEATHER=off or QILIN=off | never | the owner's switches |

**Projected rate** [projected: `storms.ts` policy table, on the 365-day schedule with an online model of the 3 friends
playing 19–23 UTC on 4 of 7 evenings plus weekend afternoons]:

- **Storms with players online:** 119 a year.
- **No cooldown:** 2.3 appearances a week.
- **6 h cooldown:** 1.7 a week.
- **20 h cooldown: 1.6 a week (chosen).**
- **A 50 % chance plus the 20 h cooldown:** 0.9 a week.

So a regular sees it about once or twice a week. A friend who plays one evening a week sees it about one week in three.

### 2.3 Duration [decision; simulated in §4]

- **Appearance to cornered:** ≤ 20 min.
- **Cornered, waiting for the first hit:** ≤ 5 min.
- **The fight:** ≤ 5 min. **Worst case: 30 min**; typical 12–17 min for a mounted party (§4.3).
- **The storm hold:** the weather module holds `storm` for the whole event through a non-GM **event hold** (§9.2). The
  median storm is 8.4 min, shorter than any chase, so without the hold the beast would be chased under a clearing sky.
- **The ending:**
  - **Kill:** hold `cloudy` for 1 min, then `clear` for 15 min. The sky opens as the reward moment.
  - **Ascend:** release to the schedule. At a typical 25–30 min that is overcast 53–60 %, rain 27–36 % and another
    storm 6–9 % [confirmed: `release.ts`]. The 20 h cooldown means a scheduled storm right after brings no second Qilin.
  - **The storm-start rule reads the schedule, not the target.** While the hold is in place the target never changes,
    so `stormStarted` fires from the schedule's segments.
  - **Fishing sees the held storm** [likely: FISHING reads the weather state]. Storm-bonus fish (the Snakehead, the
    Dragon Gate Carp) get ≈ 15 more storm minutes per event, about +0.15 % of the time at 1.6 events a week. The
    clear sky after a kill removes rain for 15 min. Both are accepted.

---

## 3. The Thunder Seats [confirmed on the server nav; map `work/tmp/qilin/qilin-map.png`]

### 3.1 The census (`work/tmp/qilin/peaks.ts`)

**Method:**

- **Grid:** every 4 m cell of the playable set (156–174 × 90–102) is placed on the server nav (`MeshNav.load(['work/out'],
  'jangan-fields')`, `place` + `inHome`): 389,157 walkable cells.
- **Summit test:** a summit is a walkable cell that is the highest walkable cell within 160 m and stands ≥ 30 m above the
  lowest walkable cell within 320 m.
- **Scores:** each summit gets its prominence, its "room" (walkable cells within 25 m and within 6 m of its height), its
  view (the share of 48 bearings at 200/400 m where the ground lies ≥ 30 m lower), and the nests within 60 m.
- **Result:** 40 summits (`peaks4.txt`).

### 3.2 The six seats [decision]

| # | Seat | Position (x, z) | Height | Prominence | Room | View | Zone (region) | Within 60 m | From a Tiger Girl camp |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Tiger's Crown** | −814, 890 | 231.7 m | 229 m | 18/22 | 1.00 | South-Tiger Mt. (163,92) | Bandit Archer 12, Bandit 11 | 338 m |
| 2 | **Yeoha Spire** | −714, 494 | 195.1 m | 199 m | 17/20 | 0.98 | Yeoha's Forest (164,94) | Yeoha 10 | 306 m |
| 3 | **White Tiger Ridge** | −1690, 230 | 174.9 m | 195 m | 19/21 | 0.94 | North-Tiger Mt. (159,95) | Tiger 14, White Tiger 18 | 263 m |
| 4 | **Ye Crag** | −994, −214 | 120.7 m | 166 m | 4/13 | 0.79 | Yeoha's Forest (162,98) | Yeoha 10, Tiger 14 | 814 m |
| 5 | **Tomb Cliff** | 726, 1130 | 147.2 m | 143 m | 21/26 | 0.96 | Chinese tomb (171,91) | none | 1,708 m (234 m from the springs' centre) |
| 6 | **Hill of Ye** | 1018, 346 | 62.5 m | 55 m | 15/29 | 0.77 | Hill of Ye Mt. (173,95) | Gyo 5, Tomb Stone 9 | 2,035 m |

**Why these:**

- **The high west** (seats 1–3) is the level 15–20 country, where the hunters already are.
- **Ye Crag** links the west to the north-west.
- **Tomb Cliff and Hill of Ye** carry the chase "across the map", east of the town.
- Every seat is ≥ 260 m from a Tiger Girl camp, so the two world bosses never share a summit.
- Tomb Cliff stands 234 m from the springs' centre, outside the sanctuary polygon (HOT_SPRINGS §5.7) [likely: the pools
  span ≈ 60 m].
- **Ye Crag's summit is narrow** (4 of 13 cells flat; the true top at 152.7 m is not walkable). Its fight spreads over
  the slope, and its "seat point" is the nav point. The alternative, if the playtest dislikes it, is the 107 m knoll at
  (−706, −338), which has room 13/13 and 310 m between the two (§13 R4).

**Rejected peaks [confirmed]:**

| Peak | Why it was rejected |
|---|---|
| **Qin-Shi Watch** (1222, −946), 178 m | Reachable by one narrow path only. Grid searches on the nav find a route from the town (2.36 km, 7.2 min) only at 2–3 m cells, never at 4–6 m. The way to Hill of Ye is 5.1 km / 15.5 min, round the south. It is also the Qin-Shi Tomb dungeon's front yard (its own wave-14 spec). |
| **Lake Forest Crag** (22, 1102), 136 m | The best route ends 105 m short of the summit, so it is not reachable from the town's component. |
| Two South-Tiger tops (−1214, 1342) 192 m and (−2258, 1342) | On the playable edge. |
| The Bandit Stronghold top (−1390, 786) | A Tiger Girl camp, 4 m from the nest ring. |
| The Springs Cliff (1054, 1126), 162 m | 110 m above the sanctuary. |
| North Tomb Ridge (954, −1146) | On the map edge. |

### 3.3 The flight graph and its walking legs [confirmed: `routes.ts` (a Dijkstra on a 3 m grid of nav-placed cells, every edge checked with `nav.walk`) and `route1.ts` (the hot-springs router at 2–4 m)]

| Edge | Walk | On foot (5.5 m/s) | Red Horse (9.9 m/s) |
|---|---|---|---|
| Crown – Spire | 0.93 km | 2.8 min | 1.6 min |
| Crown – Crag | 1.34 km | 4.1 | 2.3 |
| Spire – Crag | 1.35 km | 4.1 | 2.3 |
| Ridge – Crag | 1.37 km | 4.2 | 2.3 |
| Crown – Ridge | 1.41 km | 4.3 | 2.4 |
| Spire – Ridge | 1.59 km | 4.8 | 2.7 |
| Hill – Tomb | 1.67 km | 5.1 | 2.8 |
| Crown – Tomb | 2.22 km | 6.7 | 3.7 |
| Crag – Hill | 2.25 km | 6.8 | 3.8 |
| Spire – Hill | 2.34 km | 7.1 | 3.9 |

**Neighbours:**

- Crown: Spire, Ridge, Crag, Tomb;
- Spire: Crown, Ridge, Crag, Hill;
- Ridge: Crown, Spire, Crag;
- Crag: Crown, Spire, Ridge, Hill;
- Tomb: Crown, Hill;
- Hill: Spire, Crag, Tomb.

**From the town** (the spawn gate): Hill 1.15 km, Crag 1.18–1.37, Crown 1.63–1.73, Spire 1.70–1.95, Tomb 1.96, Ridge
2.31–2.65.

**From the hunting grounds:** the North-Tiger hunters (−1550, 423) are 0.38 km from Ridge and 1.0 km from Crag and
Crown. The South-Tiger hunters (−1440, 1083) are 0.76 km from Crown.

The two routers agree within 16 %. The thin passages that decide the rejected peaks show up as grid-size sensitivity, so
**the lane re-checks every edge with the server's own path query** (QL-Q test, §11).

---

## 4. The chase [decision; simulated: `work/tmp/qilin/chase.ts`]

### 4.1 The rules (sketch: `work/tmp/qilin/qilin-rules.png`)

| State | Rule |
|---|---|
| **Descend** | It lands on the chosen seat in a bolt. The seat is random, Tiger's Crown weighted ×2, and never a seat with a player within 150 m (no landing on someone's head). If every seat has one (campers), it takes the seat whose nearest player is farthest away. A world line: "The Storm Qilin has descended on Tiger's Crown! (South-Tiger Mt.)". The beacon: a world-positioned bolt hits the seat every 12–20 s while it is there. |
| **Summit clearing** | On every landing (descend, flight, restless move), the bolt clears the summit. Every nest whose leash ring (80 m from its centre) reaches 60 m of the seat point loses its living **normal** monsters (despawned, no loot, no EXP) and stops respawning until the Qilin leaves the seat. That is 0–6 nests a seat (none at Tomb Cliff) [confirmed: `seatcheck.ts`]. Never touched: uniques, nemesis monsters (`Mob.tag`), quest encounters and players' pets. Reason: aggressive packs (Tiger 14 at 46 m from Ye Crag; White Tiger 18 and Black Tiger 17 within reach of the Ridge) would join every fight, and the §5 numbers have no adds. Seam: `Spawner.pause(nestIds, untilMs)`. |
| **Grazing** | It is passive. It idles (STAND1) and walks slowly within 10 m of the seat point. Its sight is 40 m. |
| **Spooked** | A hunter (any player, mounted or not) comes within **40 m**. If it has flights left **and** a neighbour seat is **unguarded** (no player within 80 m of it): it rears (ATTACK1, 3 s), sprints 2 s away from the hunter (12 m/s on the nav), and vanishes in a bolt. It sheds a **Thunderscale** on the ground where it stood (§6.2). |
| **Flight** | It reappears 3 s later in a bolt at the unguarded neighbour whose **nearest player is farthest** away (ties random). A line: "The Storm Qilin bolts toward Yeoha Spire!". **2 flights** per event. Server: `warp` of the same entity, so the client keeps its state. |
| **Restless** | No player within 150 m for **8 min**: it moves to a random neighbour. This is free (no flight spent) and announced the same way. |
| **Cornered** | It has no flights left, or every neighbour is guarded. A line: "The Storm Qilin is cornered on Hill of Ye!". It stands its ground for **up to 5 min**: aggressive only within 12 m, so the group can gather. The first hit starts the fight. Nobody hits it within 5 min: it ascends. |
| **Window** | **20 min** from the descent to being cornered, or it ascends. |
| **Ascend** | A column of bolts, the line "The Storm Qilin ascends into the clouds…", and the storm breaks into the scheduled rain. Thunderscales already shed stay on the ground (2 min, like any drop). No loot, no penalty. |

**Why these rules:**

- **"Corner it" has two honest paths.** Wear it out by chasing (two flights), or out-think it by guarding its escape
  seats with a split group.
- **The flight rule is readable.** It runs away from the nearest hunter, so a party can predict it and plan the guards.
- **The beacon and the lines answer "where is it now?"** Without them nobody finds it.
- **Spooking needs no combat**, so mounted riders can scout. Hits on a mount already land on the horse (`mounts.ts`).

### 4.2 Tuning by simulation [confirmed: runs of `chase.ts`, 2,000 events per case, on the §3.3 legs]

**The model:**

- **Hunters:** 1–4 players start where level 15–20 players are (the two Tiger Mt. hunting grounds) or in the town.
- **Reaction:** they react in 20–90 s to the descent (finish the fight at hand, mount) and 5–20 s to a flight line.
- **Speed:** they ride at 9.9 m/s if they have a horse, else run at 5.5 m/s.
- **Strategies:** "together" (everyone goes to the Qilin) or "split" (one spooks, the others guard the neighbours it
  would pick).
- **Re-routes:** a hunter re-routed mid-leg continues from the nearer end of that leg.

**First draft** (3 flights, a 25-min window, restless after 4 min, a 3-min stand):

- Only **44–64 %** of mounted groups cornered it. The restless timer fired while hunters were still riding in, and the
  third flight pushed the corner past 20 min.
- Split groups were rarely together at the fight: 0–35 %.

**Chosen** (2 flights, 20-min window, restless after 8 min, a 5-min stand):

| Case | Cornered | Corner at p10 / p50 / p90 (min) | Fight starts (p50) | Group complete at the fight |
|---|---|---|---|---|
| 1 rider, from the hunt | 100 % | 9.7 / 11.1 / 14.3 | 11.1 | — |
| 1 on foot, from the hunt | 66 % | 15.0 / 17.8 / 19.6 | 17.8 | — |
| 2 riders together, from the hunt | 100 % | 9.4 / 10.9 / 14.0 | 11.4 | 100 % |
| 2 riders split, from the hunt | 100 % | 7.4 / 8.5 / 14.3 | 13.0 | 53 % |
| 2 on foot together, from the hunt | 71 % | 14.5 / 17.6 / 19.2 | 18.2 | 100 % |
| 3 riders together, from town | 100 % | 10.8 / 11.4 / 12.0 | 11.9 | 100 % |
| 3 riders split, from the hunt | 100 % | 6.5 / 8.2 / 13.4 | 12.5 | 72 % |
| 4 (2 riding) together, from the hunt | 100 % | 8.8 / 9.9 / 11.2 | 13.5 | 74 % |
| 4 riders split, from the hunt | 100 % | 6.0 / 7.9 / 11.4 | 11.9 | 77 % |

**Reading:**

- **Riding:** a mounted group always gets its fight in about 10–13 min.
- **On foot:** players on foot lose the race a third of the time. But the Red Horse's item needs only level 10 and costs
  1,200 gold [confirmed: `items.json`], so every hunter of level 15 or more can ride. Walking is the exception: a horse
  killed on the way, or a summon refused in combat.
- **Splitting:** it corners the beast 2–3 min sooner. But the guards then ride back to the fight, so the 5-min stand is
  what keeps the group together. A cleverer chase, not a free one.
- **The whole event:** with the fight (§5), a mounted party of 3–4 is done in **≈ 12–17 min**, a duo in ≈ 15–18 min.

### 4.3 What the model leaves out [unknown]

- **Getting lost.** Hunters in the model know the way; real ones may not. The world map pin (§8.4) is the mitigation.
- **Monsters on the way.** All legs cross aggressive nests of levels 5–18. At level 18–20 they are speed bumps, but a
  level-15 rider may be dismounted by a White Tiger [likely].
- **Other players in the way.** A player who happens to stand near a seat guards it without knowing.
- **Campers.** A group can park on seats during rain, hoping for a storm. Landing avoids occupied seats, and a camper
  next to its landing seat closes that escape. This is the guard rule played early. It is accepted as clever play,
  because storms are not announced in advance (rain turns to storm 20 % of the time).

---

## 5. The fight [decision; simulated: `work/tmp/qilin/sim.ts --qilin`]

### 5.1 The beast

| Field | Value | Source / why |
|---|---|---|
| Code, name | `MOB_CH_STORM_QILIN`, "Storm Qilin" | ours (authored mob row, §9.3) |
| Level, rarity | 20, `unique` | the band's top; uses the unique frame, the minimap sign and the pink name already in the client [confirmed: UNIQUES §3.7] |
| Stat line | Tiger Girl's level-20 line: attack 181–217 physical, PD 42 / MD 51, hit/parry 65 | the only level-20 unique line in the data; **wave 14's climb re-tunes level-20 monsters, and the Qilin follows it** (§6.6) |
| HP | **29,936** (her 598,720 × 0.05, the same as the JG_025 bell's Tiger Girl) | §5.2 |
| Rows | her ATTACK01 (melee, 2 hits), ATTACK02 (4 m stamp, ≤ 5 targets), ATTACK03 (15 m ranged curse); **no summons**; authored copies `MSKILL_CH_STORM_QILIN_*` that play the Demon Horse's ATTACK1 (its only attack clip) with the retail lightning hit particles | the wave-8 monster-skill system as is |
| Speed | walk 2 m/s, run **12 m/s** (the retail Unicorn's run); its RUN clip is authored for 7.5 m/s, so the client plays it ×1.6 | faster than a horse in the 2-s sprint and the skips; it never paths far |
| Leash | 40 m from the seat point; every hunter more than 40 m away for 20 s → it ascends, **once it has lost ≥ 10 % HP**. Before that, a leash sends it back to its cornered stand at full HP: the stand's 5-min clock keeps running, and the fight clock is cleared | no reset-and-retry loop once the fight is real; one player's tap-and-run cannot end the event for a group still riding in |
| Volleys | at **75 / 50 / 25 % HP**: it **skips** 15–25 m to a nav point on the seat (a `warp` with the `lightning_bobeop_move` effect; no untargetable state exists or is added, and the 2.5 s gap is players closing the distance), then calls **3 bolts on every player within 30 m**: each a 3 m ground circle for 1.5 s at the player's position when called, then a bolt (400 % of its own row-0 hit, as magic, dealt through `Gameplay.dealHits` with the Qilin as the attacker so rule #13 sees a monster death) on whoever is still inside | the "flashy" part, readable and dodgeable |
| Lone hunter | while only **one** player has hit it in the last 30 s, it takes damage ×**0.6** (`loneDamageMul`) | the sim shows that a flawless capped solo wins without it (§5.2); a group never sees it |
| Enrage | ≤ 20 % HP: damage ×1.25, a line to players within 60 m | as Tiger Girl |
| Ascend | **5 min after the first hit**: it leaves, no loot | the anti-solo rule; kinder than a fury that kills |
| Stuns, knockdowns | as any mob (it has DOWN, DOWN_UP and STUN clips) | retail parity with uniques (UNIQUES §3.6) |
| Corpse | 6 s (DIE1 is 1.4 s, then the body fades into sparks) | |

### 5.2 Balance [confirmed: `sim.ts --qilin`, 200 fights per case]

**The model** (`sim.ts` is a fork of `work/tmp/balance/sim.ts`, unchanged except a `def`, a volley model and an ascend
timer, made by `patch_sim.py`):

- the server's formulas (`formulas.ts`, `mob-skills.ts` `pickRow`/`mobHitPct`, `skills/timing.ts`);
- level-20/18/16 blade and glaive builds with shop gear and the SP plan;
- potions on their 1 s cooldown;
- uptime 0.7 (realistic), 50 % of non-tanks inside the stamp, and players who dodge 60 % of telegraphed bolts (30 % for
  "careless").

**Chosen tuning** (HP ×0.05, bolts 400 % × 3 at 75/50/25, ascend 300 s):

| Group | Win | Time to kill p10/p50/p90 | Runs with a death | HP potions (all) | Bolt damage taken per player |
|---|---|---|---|---|---|
| 4 × L20 | 100 % | 1.8 / 1.8 / 1.9 min | 0 % | 13 | 567 |
| 3 × L20 | 100 % | 2.4 / 2.4 / 2.5 | 1 % | 15 | 570 |
| 2 × L20 | 100 % | 3.5 / 3.6 / 3.7 | 1 % | 19 | 576 |
| 1 × L20 (blade / glaive) | **0 %** (it ascends with 30 / 28 % HP left) | — | 0 % | 20 | ≈ 370 |
| 4 × L18 | 100 % | 2.2 / 2.3 / 2.4 | 12 % | 21 | 717 |
| 3 × L18 | 99 % | 2.9 / 3.0 / 3.2 | 14 % | 23 | 706 |
| 2 × L18 | 92 % | 4.3 / 4.5 / 4.6 | 11 % | 28 | 711 |
| 4 × L16 | 100 % | 2.5 / 2.6 / 3.2 | **43 %** | 29 | 859 |
| 2 × L16 | 17 % | 4.8 / 4.9 / 5.0 | 43 % | 38 | 768 |
| 2 × L20, uptime 0.5 | 62 % | 4.8 / 4.9 / 5.0 | 1 % | 25 | 587 |
| 3 × L20 careless (dodge 0.3) | 100 % | 2.4 | 1 % | 17 | 1,002 |
| 4 × L20 + Berserk | 100 % | 0.9 | 1 % | 7 | 565 |

**Fact-check cases** [confirmed: `sim-fc.ts --qilin --fc`, same tuning, 200 fights each; `fc-qilin-h*.json`]:

| Case | Win | Time to kill p50 | Runs with a death | Deaths a fight |
|---|---|---|---|---|
| 1 × L20 glaive, uptime 1.0 | **97 %** | 4.7 min | 1 % | 0.01 |
| 1 × L20 glaive, uptime 0.85 + Berserk | **92 %** | 4.7 | 1 % | 0.01 |
| 1 × L20 blade, uptime 1.0 + Berserk | **99 %** | 4.1 | 1 % | 0.01 |
| 1 × L20 blade, uptime 0.85 + Berserk | 40 % | 4.9 | 1 % | 0.01 |
| 1 × L20 or L18, either build, **lone-hunter ×0.6** (run as HP ×0.0833) | **0 %** (57–67 % HP left) | — | ≤ 5 % | — |
| 4 × L15 | 47 % | 4.2 | **96 %** | 2.37 |
| 4 × L15 careless (dodge 0.3) | 4 % | 4.4 | 100 % | 3.38 |
| 4 × L16 careless | 84 % | 3.2 | 88 % | 1.78 |

**Reading:**

- **Short and flashy:** 2–4 min for the groups it is meant for.
- **It needs a group, but only with the lone-hunter rule.** At the sim's realistic uptime (0.7) a solo player at the cap
  ends at 30 % HP when it ascends. A flawless one (uptime 0.85–1.0, Berserk) wins 92–99 %. The ×0.6 lone-hunter rule
  puts every solo case at 0 % and leaves groups untouched. A duo at 18 just makes it; a duo at 16 mostly does not.
- **Level 15 is the trigger, not the target.** A 4 × L15 party wins half the time and nearly always loses someone.
  Each player loses ≈ 6.2 % of an L15 bar to rule #13 per fight (mean 10.5 % a death, CLIMB's 10-min grace ignored)
  against 10 % on a win, 4.7 % on average [projected: `expshare.ts`]. **A level-15 party loses EXP on average**, and
  the loot, fragments and scales are what it fights for. At 16 it pays: 4 × L16 lose ≈ 1.5 % and gain ≈ 10 %. The
  notice shows its level (20), and the chase's shed scales pay without a fight. The trigger stays at 15, where rule
  #13 and the late band begin, because the chase alone is worth joining.
- **Level 15–16 parties win but die:** a death in 43 % of 4 × L16 runs. That is where the user's death penalty (rule
  #13, from level 15) bites, as the user wants the late band to be.
- **The volleys:** they cost an attentive player ≈ 40 % of a level-20 HP bar over the fight, a careless one ≈ 72 %. The
  danger is real but survivable with potions.
- **The +20 % control** (HP ×0.06, `qilin-h0.06-a1-b400.json`) pushes 2 × L18 to 1 % and 2 × L20 at uptime 0.5 to 0 %.
  So 0.05 is the right side of "a duo can do it".
- **The sim is a model.** It does not move players, so the stamp and the dodge rates are assumptions [projected]. It has
  no nest adds, which the summit clearing (§4.1) makes true in the game. It has no mixed-level groups. The
  knobs are in the content file (§9.3). The first GM-started event with the friends is the real measurement (§11.4).

---

## 6. Rewards [decision]

### 6.1 The kill

**The loot-owner group** (the existing rule: the party or solo player with the most damage owns the drops for 30 s; share
or free mode inside a party [confirmed: UNIQUES §3.4]):

| Group | Chance | What |
|---|---|---|
| Gold | 100 % | 2 piles of 1,500–3,000 |
| Gear | 100 %, 1 roll | one degree-3 item from the unique gear pool: required level ≤ `LEVEL_CAP`, the highest wearable grade, +0 55 % / +1 25 % / +2 15 % / +3 5 % (the wave-11 resolver as is); the climb's gear tiers (its own spec) decide which grade that is |
| Elixir | 100 % | one Elixir (Weapon 40 / Protector 40 / Shield 10 / Accessory 10) |
| **Storm Qilin Bridle** | **3 %**, rated by DROP_RATE like every unique table (the resolver as is: 6 % at today's ×2, 3 % at the climb's ×1) | the mount itself (§6.3) |

**Every credited hunter** (level ≥ 15, and a player who dealt ≥ 1 % of its HP, or a member of that player's party
within 60 m at the kill). **Dead or alive:** the module reads the kill's damage map (`KillOwner.damage`), not today's
`credit` set, which drops players who are dead at the kill [confirmed: `party.ts` `killShares`]. Every reward below,
EXP included, is paid by the module, so a death in the fight costs rule #13's EXP but not the reward.

- **EXP:**
  - **The rule:** each credited hunter gets **10 % of their own current level's bar** in EXP, and the same amount of
    SP-EXP, times EXP_RATE / SP_RATE (×1 with the climb). The authored row's `exp` is **0**, so the core kill path pays
    nothing and the party shares do not apply. A capped (level-20) hunter gets the SP-EXP only.
  - **Why 10 %:** CLIMB §3.5 budgets "a single kill pay at most 10 % of a level" for the Qilin and nemeses. A flat
    share of one's own bar respects that cap at every level and every party size. The draft's pool (half the L19
    bar, split by the party rules) paid a duo of L16s 62 % of a bar, ≈ 3.5 h of hunting for a 15-min event, because
    `killExp` has no level-difference rule and `partyPool` adds 10 % per member [confirmed: `gameplay.ts` 196, `party.ts`
    100–108].
  - **What it is worth** [projected: `expshare.ts` on CLIMB's curve, `climb.json` of 2026-10-02 10:25]: L15 12,000
    (0.44 h of hunting), L16 15,500 (0.57 h), L17 20,100 (0.69 h), L18 26,400 (0.86 h), L19 35,100 (1.16 h). A regular
    who makes every appearance gains ≈ 42,000 over the band from 15 to 20: 3.8 % of it, ≈ 1.4 h of the 27.5 h. Level 20
    stays hard to reach. CLIMB's Monte Carlo can include it as a flat bonus.
  - **Not boosted** by the springs' Rested pool or FISHING's meals: the module's payment is not kill EXP, and
    `restEligible` and `mealEligible` also return false for this mob (the hooks of HOT_SPRINGS §5.7 and FISHING §10.4).
- **1 Storm Horn Fragment:** bound to the character, stack 5.
- **2–3 Thunderscales:** tradeable.
- **The title "Stormchaser"** on the first credited kill (§6.4).
- **The defeat line:** "Mei's party has defeated the Storm Qilin!" (the wave-11 `uniqueNotice` defeat, §9.1).

### 6.2 The chase

- **Each flight sheds 1 Thunderscale** where the Qilin stood: a normal ground drop, free for all, gone in 2 min. A chase
  that fails still pays 0–2 scales, and a solo rider has a reason to chase.
- **Restless moves shed nothing**, so idling never farms scales.

### 6.3 The mount: the Storm Qilin

| | Value | Why |
|---|---|---|
| Model | the retail Unicorn with the storm texture (§7) | its skeleton is the Red Horse's (`c_horse.bsk`), so the rider seat, the clips and the mount code work as they are [confirmed: both sidecars] |
| How | **5 Storm Horn Fragments** delivered to the Jangan stable keeper (a repeatable `deliver` quest, "The Bridle of Storms") → a bound **Storm Qilin Bridle**; or the 3 % drop (tradeable) | about 3 weeks for a regular at 1.6 events a week [projected]; luck can shortcut it |
| Speed, HP | run 9 m/s (the Red Horse's), HP 1,500 (Red Horse 983) | a trophy, not a power gap; the climb's travel times stay what the climb spec measures |
| Summon | the bridle is **not consumed**: it summons the Qilin mount; if the mount dies, the bridle has a 10-min cooldown | the only perk: no horse purchases. Needs a `reusable` flag in `mounts.ts` (seam, §9.2) |
| Level | required level 15 | the Qilin's band |
| Look | a faint cyan trail in rain or storm (the beacon-bolt material on 6 ribbon quads behind it) | cut 2 |

### 6.4 The title

**"Stormchaser"**, shown under the name. There is no player title system today [confirmed: `protocol.ts` has only
stall and guild titles]. **CLIMB §7.3 designs one for the whole wave:** an `achievements.ts` module with
`content/climb/achievements.json`, `char_achievements`, `characters.title` and `EntityState.title`. Its events come in
from the module bus, and its first 20 titles include one for STORM_QILIN through a `qilinCaught` event [confirmed:
CLIMB.md §7.3]. So this spec builds **no title system**. The draft's QL-T lane is dropped. Instead:

- **QL-S emits `qilinCaught {charId, kill: true}`** on the module bus for every credited hunter (and `kill: false` for a
  hunter who saw it cornered but did not get the kill, should CLIMB want a "chased" count).
- **The title is CLIMB's achievement row** (`event {name: 'qilinCaught', n: 1}`). The two drafts name it differently:
  CLIMB says "Storm-Rider", this spec says "Stormchaser". **Default: "Stormchaser"**, because the user's word is "chase"
  and "Storm-Rider" reads as the mount's owner. WAVE_PLAN10 settles it in that one data row.
- TOMB_DUNGEON's first-kill titles ("Tamer of the West Wind", its `tomb_progress.titles` flags) belong in the same
  achievements table. That is a merge for WAVE_PLAN10, and nothing in this spec waits on it.

The nemesis spec's monster titles ("Mangyang the Pixi-Slayer") are names of monsters, not this. Without CLIMB's
achievements, the first kill is just a chat line and an entry in `/qilin stats`.

### 6.5 Thunderscales and wave 17 [decision: a named slot]

- **Now:** `ITEM_ETC_STORM_SCALE` "Thunderscale", stack 50, tradeable, sells for 50 gold. The tooltip says "Crackles
  with a storm that has not ended. A weaponsmith may know its use." It does nothing else.
- **Wave 17 (Arsenal)** owns its use: lightning-element weapons and their rarity effects. Its content file reads the
  same item code, so no migration is needed.
- **The rate:** a regular who joins the chase and the kill gains ≈ 3–5 scales a week [projected: 1.6 events × (2–3 +
  ≈ 1 shed)]. Wave 17 prices its recipes with that rate.

### 6.6 Seams with the rest of wave 14 [decision]

| Topic | Rule |
|---|---|
| **The climb's re-tune** | The Qilin's row names Tiger Girl's level-20 line as its base. If the climb re-tunes level-20 monsters or player power, the integration re-runs `pnpm tsx work/tmp/qilin/sim.ts --qilin` on the new tables and sets `hpMul` / bolt % / `loneDamageMul` so that the targets hold: 3 × L20 in 2–3 min, 2 × L20 in ≤ 4 min, solo impossible even when flawless (uptime 1.0 + Berserk, both builds). It also sets the EXP pool from the final L19 bar. If the climb re-levels the nests near the seats, the summit clearing still removes them. |
| **The death penalty (rule #13)** | Dying to the Qilin or its bolts is a death to a boss: the penalty applies from level 15. It needs the S-DEATH seam that NEMESIS and CLIMB share (the cause reaches the modules), so every Qilin hit, volleys included, goes through `Gameplay.dealHits` with the Qilin as the attacker. The **weather's ambient strikes never damage** (they stay cosmetic). The death line names the "Storm Qilin". CLIMB's 10-min grace (a second death soon after costs nothing) applies as for any boss. |
| **Nemesis** | The Qilin never becomes a nemesis. It is already a named world boss, and a killer that comes back stronger would break its tuning. It sets `Mob.tag = 'event'`, NEMESIS's S-ELIG seam, and its `rarity` is `unique`. Either excludes it. |
| **Rested / meals** | Wave 13's `restEligible(mob)` and `mealEligible(p, mob)` hooks (HOT_SPRINGS §5.7, FISHING §10.4) must exist first. QL-S depends on wave 13's S-REWARD step. |
| **Tiger Girl** | They are independent. No seat is within 260 m of her camps. Both can be alive at once. |
| **The Qin-Shi Tomb** | Untouched: its ridge was rejected as a seat (§3.2). |
| **Springs / fishing hooks** | `restEligible` and `mealEligible` are false for the Qilin (§6.1). Tomb Cliff stays outside the sanctuary. |

---

## 7. The model [confirmed: converted and rendered]

### 7.1 What retail offers

**Conversion:** `pnpm sro convert res/mob/wchina/demonhorse.bsr res/cos/c_unicorn.bsr res/cos/c_pegasus.bsr
res/cos/c_dhorse1.bsr res/mob/casia/peryton.bsr res/cos/c_horse1.bsr --out work/tmp/qilin/models`. All six were valid
(0 validator errors), converted in 0.4 s. **Renders:** Blender 5.2, `blender/render_models.py`, with the RUN clip at
25 %. The sheet is `work/tmp/qilin/model-candidates.png`.

| Candidate | Mesh | Joints | Clips | Look | Verdict |
|---|---|---|---|---|---|
| **Demon Horse** `mob/wchina/demonhorse` | 495 v / 760 t, 1 texture 512×256 | 35 | **14**: STAND1, WALK, RUN, ATTACK1, DAMAGE1/2, DIE1, DOWN, DOWN_UP, DOWN_DAMAGE, DOWN_DIE, STUN | a gaunt dark horse, spiky mane, exposed red wounds, ropes and gold paper talismans | **the boss**: a mob rig with every clip a fight needs |
| **Unicorn** `cos/c_unicorn` | 524 v / 738 t | 33 (`c_horse.bsk`) | 6 (mount set) | a white horned horse | **the mount**: the Red Horse's skeleton, so the rider works as is |
| Peryton `mob/casia/peryton` | 986 v | 44 | 14 | a red winged stag-bird | too far from a qilin |
| Pegasus, Ironclad Horse | 1,108–1,212 v | 41–63 | 6 | winged / armoured horse | Western or military; heavier |

### 7.2 The Storm Qilin look (`work/tmp/qilin/qilin-look.png`)

**The texture recolour** (`recolour.py`, a pure texture edit, so the build ships a texture and not a shader):

- The Demon Horse's saturated red wounds (11,000 of 131,072 texels, picked by hue) become **electric cyan**, and an
  **emissive mask** makes them glow.
- The gold talismans stay gold, faintly emissive.
- The grey hide and the mane become indigo slate.

It reads as "a thunder beast under seals", which suits a Chinese storm spirit.

**The horn:** a slim gold cone (8 sides, 0.45 m) parented to `Bip01 Head`. bpy builds it into the glb, so the build's
`build.py` produces one skinned glb with the horn weighted 100 % to the head joint.

**The mount:** the Unicorn with the same recolour (body tint 0.62, 0.70, 0.95). Its brown harness becomes cyan.

**What the art lane polishes** [decision]:

- the emissive strength in-game (the PBR path's emissive is untested on mobs, §13 R3);
- a gold mane variant if the user prefers more "qilin" than "storm";
- the horn's angle;
- **its size:** the Demon Horse is 2.2 m tall, shorter than the 2.5 m Unicorn mount and a mounted player [confirmed:
  sidecar `heightM`]. The mob row's `scale` goes to ≈ 140 so that it reads as a boss;
- **its run:** the RUN clip is authored for the retail 7.5 m/s, so it plays ×1.6 at the Qilin's 12 m/s.

The "14 clips" count includes two root-motion copies (`DIE1_RM`, `DOWN_RM`). There are 12 distinct actions [confirmed:
sidecar].

No Meshy: retail gives a full rig and clips, and a new mesh would need new clips. **0 of the 40 allowed credits** were
used.

**Download** [confirmed sizes of the raw glbs, projected compression]: the boss glb is 623 KiB raw and the mount 369 KiB.
Through the optimiser (WebP textures) they come to ≈ 70–90 KB brotli each, by the ratio measured for the Blue Tiger in
UNIQUES (988 KB → 86 KB br).

---

## 8. Effects and sound

### 8.1 World-positioned bolts on every preset [decision; seam QL-R]

The weather's bolt is camera-relative and High/Ultra-only (§1). The Qilin's bolts are information, so they must be in
the right place on every preset:

- **The wire:** `lightning` gains optional `x`, `y`, `z` (a world point) and `kind: 'qilin'` (§9.1). The server rolls
  these strikes itself: the beacon, the flights, the volleys, the ascend.
- **world-render:** `weather` exposes `strikeAt(x, y, z, opts)`. A small **beacon bolt pool** (3 meshes of the same
  15-quad ribbon and material as `rain.ts`'s bolt, built at the world point instead of the camera) is enabled on
  **every preset, Low included**, and drawn only within the fog end + 200 m.
- **Flash and thunder:** the flash direction comes from the camera to the point, the thunder delay is `distance / 343`
  (the existing audio path, `prepareThunder(distM)`), and the flash is scaled by distance.
- **reduceFlashing:** today `ui.reduceFlashing` quarters the flash and **removes the bolt** (the bolt only draws while
  the flash is bright) [confirmed: `en-weather.ts`, `rain.ts` header, `features/weather.ts` 268]. A strobing beacon
  would undo that, so with the setting on the beacon is a **steady glow column** at the seat (the same ribbon, constant
  alpha, a 1.5 s fade in and out), with no flash and no flicker.
- **The weather preset Off** (graphics) still draws Qilin beacons, because the event needs them. A server with
  WEATHER=off has no storms, so it never has a Qilin.

### 8.2 Particles (retail, converted already) [confirmed: the efp jsons exist]

| Moment | Effect |
|---|---|
| Descend / reappear | `skill/china/lightning_bobeop_move_a` at the seat + a beacon bolt |
| Rear and vanish (flight), skip | `lightning_bobeop_move_b` + a bolt |
| Volley bolt impact | `lightning_chundung_hit_a..c` (rotating) at the circle centre |
| Its melee hits on a player | `hit_4_lightning_hit_a` |
| Idle on the seat | the Demon Horse's own `dust_demonhorse_*` + a faint `lightning_ganggi_keep_a` aura (not converted yet: QL-A adds it to the fx export; cut 3) |
| Defeat | `lightning_chundung_hit_f` + the clouds parting (the weather hold, §2.3) |

### 8.3 Telegraphs

- **What:** each volley bolt is a **3 m ground circle** for 1.5 s at the player's position when called. It reuses
  `TargetDecal` (the terrain-conforming disc of EFFECTS §5.4) with a cyan tint and a fill that grows to the strike.
- **Who sees them:** every player within 120 m (`qilinVolley`, §9.1).
- **Count:** ≤ 4 players × 3 = 12 circles, alive 1.5 s.

### 8.4 HUD, map, sound

- **Notices:** the wave-11 `NoticeBanner` queue with the unique style for descend, cornered and defeated. Flights and
  restless moves are chat lines only (no banner spam).
- **The town alarm:** it does **not** ring for the Qilin. It is a sky event, not a raid. Today the alarm starts on
  **every** `uniqueNotice` `appeared` [confirmed: `town-sound.ts` 180], so QL-C makes it skip the Qilin's mob code.
  QL-C also gives `uniqueNoticeText` its three new sentences (today any event other than `appeared` prints "defeated")
  and gives `UNIQUE_CUES` its three new cues (its `satisfies Record<event, string>` fails the build until it has them)
  [confirmed: `hud/unique-notice.ts`].
- **The world map (M) and the minimap:** a lightning pin at the current seat while it is out. The lines already name
  the seat, so the pin hides nothing, and it fixes "getting lost" (§4.3).
- **Sound:**
  - the existing `lightning1..3` thunder for the bolts (exported in wave 9);
  - the Demon Horse's own palette for the rear and the hits. Only `wcm_dhorse_thud` is exported today. The retail
    `die`, `moan1`, `moan2`, `shout_a` and `shout_b` are in `work/extracted/Data/prim/snd/monster/` [confirmed: ls],
    and QL-A adds them to the sound export;
  - `ui.uniqueAppear` / `ui.uniqueDown` (wave 11) for the descend and defeat banners.

  Nothing new to record, and nothing to download.

---

## 9. Protocol, content and persistence (protocol v1, additive)

### 9.1 `packages/shared/src/protocol.ts`

```ts
// lightning: optional world point + kind (absent = today's cosmetic, camera-relative strike)
| { t: 'lightning'; at: number; distM: number; bearing: number; x?: number; y?: number; z?: number; kind?: 'qilin' }

// uniqueNotice: three more events (wave 14); `area` = the seat name, `to` = the next seat on 'fled'
export type UniqueNoticeEvent = 'appeared' | 'defeated' | 'fled' | 'cornered' | 'ascended'
| { t: 'uniqueNotice'; event: UniqueNoticeEvent; mob: string; name: string; area?: string; to?: string; by?: string; party?: boolean; roar?: boolean; at?: number; seat?: [number, number] }

// a volley's telegraphs, to players within 120 m of the Qilin
| { t: 'qilinVolley'; id: number; strikeAt: number; r: number; points: [number, number][] }

// EntityState (players): title?: string   (CLIMB §7.3's, not this spec's)
```

Validators go in `validate.ts`. The mock server (`net/mock.ts`) answers `/qilin summon` so QL-C works without the real
server. A `lightning` with `x/z` from an older server never comes, and an older client ignores the new fields
(additive).

### 9.2 Server seams

| File | Seam | Owner |
|---|---|---|
| `apps/server/src/weather.ts` | `eventHold(tag, kind, untilMs, transitionMs)` / `releaseHold(tag, then?: {kind, minutes}[])`: a hold that is not `gm`, below a GM hold in priority; `stormStarted` event (the target becomes a scheduled `storm`) to listeners | QL-W |
| `apps/server/src/uniques.ts` | export the drop-table resolver, the notice sender and the row I/O (`UniqueRow`); the Qilin's row lives in the same `uniques` table (`phase` waiting/alive, `due_at` = the 20 h cooldown end, `spawns`, `last_killer`) → **no migration** | QL-S |
| `apps/server/src/mounts.ts` | `CosItem.reusable` (not consumed; cooldown after the mount dies) | QL-S |
| `apps/server/src/spawner.ts` | `pause(nestIds, untilMs)` / `resume(nestIds)`: no respawn while paused (the summit clearing, §4.1); a GM `/nest` edit wins | QL-S |
| `apps/server/src/world.ts` | `Mob.tag?: 'event' \| …`, NEMESIS's S-ELIG seam (one owner: whichever lane lands first; the other reuses it) | QL-S / NEMESIS |
| `apps/server/src/gameplay.ts` | NEMESIS/CLIMB's S-DEATH seam (the death cause reaches `playerDied`); the Qilin uses it, it does not build it | CLIMB |
| `apps/server/src/gameplay.ts` | register the `qilin` module after `uniques`; `restEligible`/`mealEligible` predicates (wave 13) list the code | QL-S |
| `apps/server/src/config.ts` | `QILIN=on\|off` (default on; off when `UNIQUES=off`) | QL-S |
| `apps/server/src/gm.ts` | `/qilin summon [seat] \| status \| ascend \| cooldown <h \| clear> \| stats` | QL-S |

### 9.3 Content (ours)

- **`content/events/storm-qilin.json`:**
  - the trigger (`minLevel` 15, `cooldownH` 20, `chance` 1);
  - the seats (names, x/z, weights) and the edges;
  - the chase knobs (`spookM` 40, `guardM` 80, `flights` 2, `restlessMin` 8, `windowMin` 20, `standMin` 5);
  - the fight knobs (`tuning.hpMul` 0.05, volleys `[75, 50, 25]`, `bolts` 3, `boltPct` 400, `circleM` 3, `telegraphMs`
    1500, `skipM` [15, 25], enrage, `ascendS` 300, `leashM` 40, `leashAscendAfterPct` 10, `loneDamageMul` 0.6,
    `loneWindowS` 30);
  - the summit clearing (`clearM` 60);
  - the hold (`maxMin` 30, `afterKill` cloudy 1 min → clear 15 min);
  - the rewards (`expOwnBarPct` 10, `spOwnBarPct` 10, the drop table, `fragments` 1, `scales` [2, 3], `shedPerFlight` 1,
    `bridleChance` 0.03, `creditMinLevel` 15, `creditMinDamagePct` 1).

  `content-check.ts` rules:
  - every seat places on the nav, in the home component, ≥ 150 m from a unique camp, outside every sanctuary polygon;
  - every edge has a nav route ≤ 2.6 km;
  - the graph is connected.
- **Authored rows** through wave 13's merge (`packages/convert/src/data/authored.ts`, extended to mobs, skills and cos):
  - `content/mobs/storm.json` (`MOB_CH_STORM_QILIN`);
  - `content/skills/storm.json` (3 `MSKILL_CH_STORM_QILIN_*` rows, copies of Tiger Girl's with the clip and effects);
  - `content/cos/storm.json` (`COS_C_STORM_QILIN`);
  - `content/items/storm.json`: `ITEM_ETC_STORM_SCALE`, `ITEM_ETC_STORM_HORN` (bound, stack 5), `ITEM_COS_C_STORM_QILIN`
    (the bridle; the dropped one tradeable, the quest one bound: two codes).
- **The quest:** "The Bridle of Storms" in `content/quests/jangan.json` (repeatable `deliver` 5 horns → bridle) at the
  stable keeper (`chinashop_stableman`).

### 9.4 Persistence

- **The event:** one `uniques` row (`MOB_CH_STORM_QILIN`).
- **A restart during an event** ends it quietly. The hold is in memory and ends with the restart, and the row keeps the
  cooldown. A restart is not a free beast.
- **Titles:** none here. CLIMB's `char_achievements` + `characters.title` hold them (§6.4).
- **Items** use the existing inventory.

---

## 10. Costs

### 10.1 Server [projected from the code paths]

| Item | Cost |
|---|---|
| Idle (no event) | a listener on the weather's storm start: 0 |
| During the event | one mob through the normal mob paths; a 1 Hz check of ≤ 20 players against ≤ 6 seats and the Qilin (≈ 150 distance tests); the beacon strike every 12–20 s; volleys 3 per fight; the summit clearing (a scan of ≈ 825 nests on each of ≤ 3 landings, then fewer mobs alive). ≈ 0 against the server tick on the N100 [projected] |
| Messages | per event ≈ 50–150 `lightning` (the beacon every 12–20 s, all clients, ≈ 40 B each), 3–6 `uniqueNotice`, 3 `qilinVolley` (local), the mob's normal updates: < 10 KB per client per event |
| DB | the `uniques` row on descend, kill and ascend: 3 writes per event |

### 10.2 Client [projected; not measured, no GPU lock taken]

| Item | Draws | Frame cost (Medium, 1080p) |
|---|---|---|
| The Qilin mob (35 joints, 495 v, 1 texture + emissive) | 2 (+2 shadow) | ≤ 0.05 ms CPU (the Blue Tiger's measured class: UNIQUES §6) |
| Beacon bolts (≤ 3 alive, 15 additive quads each, 1–2 s) | ≤ 3 | ≈ 0 (WEATHER §8 could not resolve the rain/bolt cost above ±0.06 ms) |
| Telegraph decals (≤ 12 for 1.5 s, 3 times a fight) | ≤ 12 (or 1 instanced) | ≤ 0.1 ms while shown |
| Retail particles (bobeop, chundung) | the efp system's own budget (EFFECTS) | ≤ 0.1 ms during a skip or volley |
| **The crowd at the fight** | — | the real cost. A party of 4–8 holds on every target machine (≤ 8 players ≈ 13 ms Medium on a laptop or an M1). 20 players at one seat: ≈ 14 ms WebGPU / ≈ 9 ms WebGL2 p95 on Medium **on the dev PC**, but **≈ 20 ms on a mid desktop, a gaming laptop or an M1: misses** (UNIQUES §6's tables, projected there). The event adds ≤ 0.2 ms to that |
| **The summit view** | — | [unknown] The seats have the widest views on the map (view score 0.77–1.00). A summit may see more terrain, objects and far trees inside the fog end than a valley camp. Nothing has measured it. The integration takes one GPU-locked Medium timing on Tiger's Crown (3 runs, median) |

The event's own cost is ≤ 0.2 ms, so the standing goal (60 fps on Medium) holds for the friends' real group sizes
(3 accounts today, cap ≈ 20). A 20-player gathering misses on Medium on weaker GPUs and on High everywhere. That is the
known BACKLOG item 9, not new here, and the summit view is the one new unknown.

### 10.3 Download and memory

- **Download:** the boss and mount glbs, ≈ 0.15 MB brotli on first sight [projected, §7.2].
- **Memory:** the beacon pool is 3 × 60 vertices.
- **VRAM:** ≈ +1 MB (two 512×256 textures plus the emissive mask).

---

## 11. Lanes

### 11.1 Seams first (one agent, before the lanes)

**QL-0 (formats):**

- **Files:** `packages/shared/src/protocol.ts` (§9.1), `validate.ts`, `content.ts` (`StormEventDef`, the authored mob,
  skill and cos kinds), `content-check.ts` rules, `index.ts` exports, `docs/PROTOCOL.md` rows.
- **Tests:** validators accept and reject; the content checks on a fixture.
- **Effort:** 0.5 day.

### 11.2 Lanes (after QL-0; disjoint files)

| Lane | Files (owned) | Seams it needs | Tests | Effort |
|---|---|---|---|---|
| **QL-W** weather hold | `apps/server/src/weather.ts` (the event hold, the storm-start listener) | none | hold below a GM hold; release sequences; restart drops it; `storm` start fires once per segment | 0.5 d |
| **QL-S** the module | `apps/server/src/qilin.ts` (new), seams in `uniques.ts` (exports), `mounts.ts` (`reusable`), `spawner.ts` (`pause`/`resume`), `gameplay.ts` (register, eligibility predicates), `config.ts`, `gm.ts`; `Mob.tag` shared with NEMESIS S-ELIG | QL-0, QL-W; wave 13's S-REWARD (`restEligible`/`mealEligible`); CLIMB/NEMESIS's S-DEATH | a scripted event on the real nav: trigger rules (level, cooldown, once per storm, the schedule's storm start under a hold); landing (occupied seats skipped, all occupied → farthest); the summit clearing (normal mobs gone, nests paused and resumed, nemesis and uniques untouched); the flight choice (guarded seats, farthest from hunters); cornered by exhaustion and by guards; restless; window and ascend; leash before and after 10 % HP; lone-hunter ×0.6 on and off; volleys (telegraph → hit only inside, through `dealHits`); loot and credit (a dead hunter keeps the fragment, a level-1 alt gets none); the death-penalty hook sees a monster death; no nemesis | 3 d |
| **QL-Q** content | `content/events/storm-qilin.json`, `content/{mobs,skills,cos,items}/storm.json`, the quest in `content/quests/jangan.json`, the authored-merge extension in `packages/convert/src/data/authored.ts` | QL-0, wave 13's FS-I | every seat places and every edge routes on `jangan-fields` (the server's own router); merge round trip; the quest validates | 1 d |
| **QL-A** art | `packages/convert/src/tools/qilin/` (the recolour as a converter step + `build.py` for the horn), the two outputs under `work/out/{mob/event, cos}`, item icons (rendered from the glbs), the five missing `wcm_dhorse_*` sounds in the sound export's list | none | the glbs validate (0 errors), the horn is weighted to the head, the mount's rig equals the Red Horse's; the five sounds exported | 1 d |
| **QL-R** render | `packages/world-render/src/weather/beacon.ts` (new), one export in `weather/index.ts` | none | `strikeAt` builds at a world point on every preset; culled past fog + 200 m; no flash with reduceFlashing | 0.5 d |
| **QL-C** client | `apps/game/src/world/features/qilin.ts` (new): notices, chat lines, the seat pin on the map and minimap, telegraph decals, the volley and flight effects, the emissive on the mob material, the ×1.6 run playback; `hud/unique-notice.ts` (three sentences, three cues); `world/features/town-sound.ts` (the alarm skips the Qilin); `net/mock.ts` | QL-0, QL-R; serialise `unique-notice.ts` with NEMESIS's NM-C (it also uses the unique banner) | the mock event end to end; decals expire; the pin follows flights; the town alarm stays silent for the Qilin and still rings for Tiger Girl; a `fled` notice never reads "defeated"; the reduceFlashing beacon is steady | 1.5 d |

### 11.3 Integration

- **Effort:** ≈ 0.5 d, by the wave's lead.
- **The run:** a private server on a free port with a temp copy of `work/server/game.db`.
- **The checks:**
  - `/qilin summon`, then 2–4 bots: descend, a flight, cornered, the fight, the kill, the loot, the lines, the sky
    clearing;
  - an ascend by timeout;
  - a restart mid-event;
  - `QILIN=off`;
  - the re-run of `sim.ts --qilin` and `sim-fc.ts --qilin --fc` on the climb's tables (§6.6), and of `expshare.ts` on
    its final curve;
  - one GPU-locked Medium timing on Tiger's Crown during an event (the summit view, §10.2; 3 runs, median).
- **Total:** ≈ 7.5–8.5 agent-days. The draft's QL-T lane (1 d) is gone: CLIMB §7.3 owns titles.

### 11.4 User checks

1. **The look:** `work/tmp/qilin/qilin-look.png` (the beast and the mount). Is it a qilin enough, or more gold?
2. **The seats:** `work/tmp/qilin/qilin-map.png`. Do these summits feel right?
3. **After the build:** one GM-started event with friends. Is the chase fun at 2 flights? Does the fight last "a short
   time"?

---

## 12. Scope-cut order (cut from the top)

1. **The title row** (CLIMB's achievements data): the first kill becomes a chat line and a `/qilin stats` entry.
2. **The mount's rain trail.**
3. **The idle aura** (`lightning_ganggi_keep`).
4. **Shed Thunderscales on flights:** kills still pay scales.
5. **Restless moves:** it waits on its seat until spooked, or the window ends.
6. **The summit clearing** (the spawner's `pause`): the packs at Crown, Spire, Ridge and Crag join fights, so the §5
   numbers turn optimistic for level 15–18 parties. The first event measures it.
7. **The guard rule:** only exhaustion corners it (2 flights). A simpler but less clever chase.
8. **The horn:** recolour only.
9. **The mount** (fragments and bridle). Scales, EXP and loot remain; the mount moves to wave 15 (Wardrobe), which owns
   cosmetics.

Never cut: the storm trigger, the beacon bolts on every preset, the announcements, the fight's ascend rule and the
lone-hunter rule (together they make it a group boss), and the credit rule (a dead hunter keeps the fragment).

---

## 13. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Narrow passages: two of the 40 summits failed on route width; a seat edge could be impassable in the real game (objects, steep cells the grid missed). Wave 12's World Editor can edit the nav and the summits (`world-edits/nav-rule.ts` is changing now) | QL-Q's test routes every edge with the server's router; the content check runs on every content reload, so an editor change that cuts a seat off fails loudly |
| R2 | Players never see it (storms at other hours) | the 20 h cooldown is the only limiter; the GM can summon; §16 Q1 can raise `WEATHER_RAIN_SCALE` |
| R3 | The emissive mask on the mob's PBR material does not glow on the Classic path (Low) | Low shows the recolour without glow (still cyan); QL-C checks both paths |
| R4 | Ye Crag's narrow summit makes the fight awkward | the 107 m knoll at (−706, −338) is the drop-in replacement (content only) |
| R5 | The sim's dodge and stamp rates are guesses | knobs in the content file; first event = measurement (§11.4) |
| R6 | The authored Qilin rows play the Demon Horse's single ATTACK1 for three rows; a row whose timeline is longer than the 1.0 s clip may freeze on the last frame [unknown: the client's clip pick for mob rows was not traced] | QL-A/QL-C check in the mock; fallback: the rows' action times set to the clip's length |
| R7 | A crowd of 20 at one summit: misses on High, and on Medium on weaker GPUs (F13) | the known BACKLOG item 9; parties of 4–8 hold on Medium everywhere; the summit view is measured at integration |
| R8 | Grief: a player taps the cornered Qilin to start its 5-min fight clock, then leaves, before the group arrives | the leash ascends only after it has lost ≥ 10 % HP; before that it goes back to its stand at full HP, the stand clock keeps running and the fight clock is cleared. A friends-only server makes this rare |
| R9 | The summit clearing despawns a pack someone was hunting | at most 3 landings an event, ≈ 1.6 events a week; the bolt and the world line explain it; nemesis monsters are never touched |
| R10 | Level-15 players join a fight they lose half the time, and lose EXP on average to rule #13 (F15) | the notice shows level 20; the chase pays scales without a fight; the fight still pays loot and fragments; the 4 × L15 numbers are in §5.2 for the user's playtest |

---

## 14. Decisions (each with its reason)

| # | Decision | Reason |
|---|---|---|
| D1 | Trigger at the start of a scheduled `storm` only | the user's "during thunderstorms"; rain with stray lightning is too common |
| D2 | 100 % chance, ≥ 1 player of level ≥ 15 online, at most once per storm, 20 h cooldown | the schedule already makes it rare (1.6 a week projected); no empty-server events |
| D3 | Both a sky omen (world-positioned beacon bolts) and world lines | an 8-min storm on a 3.6 km map is unfindable by omen alone; Low/Medium do not draw the weather bolt |
| D4 | The Qilin holds the storm (event hold), max 30 min; after a kill the sky clears | the median storm (8.4 min) is shorter than a chase; the clearing sky is the reward moment |
| D5 | Six seats: Tiger's Crown, Yeoha Spire, White Tiger Ridge, Ye Crag, Tomb Cliff, Hill of Ye | the highest walkable, prominent summits in the town's component, spread west to east, away from Tiger Girl and the springs |
| D6 | Reject the Qin-Shi ridge and the Lake Forest crag | a single narrow approach / not reachable |
| D7 | Spook at 40 m; flee to the unguarded neighbour farthest from the nearest hunter | readable and predictable, so a party can plan |
| D8 | 2 flights, 20-min window, restless after 8 min, 5-min stand | the simulated mounted groups corner it 100 %, median 8–12 min; 3 flights / 4 min did not |
| D9 | Guarding (a player within 80 m) closes a seat | the second, cleverer way to corner it |
| D10 | Mounts allowed | retail's chase tool; attacks and skills are refused while mounted, so riders dismount to fight (fact-check F4) |
| D11 | Flights are `warp`s of the same entity | the protocol has it; the client keeps the actor |
| D12 | Level 20 unique on Tiger Girl's level-20 line, HP ×0.05 (29,936), no summons | the only level-20 unique line; 2–4 min for its groups |
| D13 | Three volleys (75/50/25) of 3 telegraphed bolts per player, 400 %, after a skip that is a plain `warp` (no untargetable state) | "flashy" and dodgeable; ≈ 40 % of an HP bar for an attentive player; no new combat seam (F8) |
| D14 | Ascends 5 min after the first hit (no fury) | with D31, a solo player cannot win; a lost fight ends the event without a death spiral |
| D15 | Leash 40 m; leaving the fight = ascend once it has lost ≥ 10 % HP; before that, back to the stand at full HP | no reset-and-retry farming, and one player's tap cannot end the event (R8) |
| D16 | Loot owner: gold, 1 cap-wearable item, an elixir, 3 % bridle, all rated by GOLD_RATE/DROP_RATE as any table | a rare treat beside Tiger Girl's richer table; the resolver stays as is (F7) |
| D17 | Every credited hunter: **10 % of their own bar** in EXP and SP-EXP (paid by the module; the row's `exp` is 0), 1 bound fragment, 2–3 scales, the title (CLIMB's achievement) | CLIMB §3.5's single-kill cap at every level and party size; the draft's half-bar pool paid a duo of L16s 62 % of a bar (F2) |
| D18 | Each flight sheds a Thunderscale | the chase pays even without a kill |
| D19 | The mount: 5 fragments at the stable keeper (or 3 % drop), Red Horse speed, reusable bridle | a trophy over ≈ 3 weeks of play, not a speed advantage |
| D20 | Thunderscales are a named wave-17 material, banked now | the user asked for lightning materials for wave 17 |
| D21 | The model: the retail Demon Horse with a storm texture and a bpy horn; the mount: the retail Unicorn, same palette | full clip sets; the Unicorn shares the horse rig; no Meshy |
| D22 | World-positioned beacon bolts on every preset, a separate pool from the weather bolt | the event is gameplay information |
| D23 | Telegraphs reuse `TargetDecal` | the existing terrain-conforming disc |
| D24 | The death penalty applies; nemesis, Rested and meal bonuses do not | the user's rule names bosses; fixed rewards keep the tuning |
| D25 | Its state lives in the wave-11 `uniques` table; no migration at all (titles are CLIMB's) | one owner for world bosses' persistence |
| D26 | A new `qilin` module beside `uniques`, reusing its loot, notice and row code | different trigger and AI, same boss plumbing |
| D27 | `uniqueNotice` gains `fled`, `cornered`, `ascended` | one notice path, one i18n family |
| D28 | The town alarm does not ring for the Qilin (`town-sound.ts` skips its code) | a sky event, not a raid; today the alarm rings on every `appeared` (F5) |
| D29 | A lightning pin on the map at its current seat | the lines already name it; it fixes getting lost |
| D30 | The summit clearing: on each landing, the nests that reach 60 m of the seat lose their living normal monsters and pause until it leaves (never uniques, nemeses or encounters) | aggressive packs reach every western seat (Ye Crag sits 46 m from a Tiger nest), and the fight's tuning has no adds (F10) |
| D31 | Lone hunter: ×0.6 damage taken while only one player has hit it in the last 30 s | a flawless capped solo wins 92–99 % without it and 0 % with it; groups never see it (F1) |
| D32 | Per-hunter rewards come from the damage map, dead or alive, level ≥ 15, ≥ 1 % of its HP (or the party within 60 m) | a death in the fight should not also cost the fragment; level-1 alts cannot farm fragments (F9) |
| D33 | All six seats occupied at the descent: it lands where the nearest player is farthest | the landing rule always has an answer; camping is clever play, not a block |
| D34 | With `reduceFlashing`, the beacon is a steady glow column, with no flash and no flicker | the setting promises no strobing bolts, and the beacon is still needed as gameplay information (F6) |

---

## 15. Needs from the user (each with the default used if there is no answer)

| # | Need | Default |
|---|---|---|
| N1 | Judge the look (`work/tmp/qilin/qilin-look.png`): storm-blue with gold talismans, or more gold ("classic qilin")? | storm-blue as shown |
| N2 | The live `WEATHER_SEED` / `WEATHER_RAIN_SCALE` in `silkroad.local.env` (not read: it is on the mini PC) | seed 1, scale 1 (the server defaults); any seed gives ≈ 2.1 storms a day (seed 7: 2.07) |

Nothing else blocks the build.

---

## 16. Open questions (each has a default, so nobody waits)

| # | Question | Default |
|---|---|---|
| Q1 | Should storms be more frequent so the friends see it more often? | no: 1.6 a week projected; `WEATHER_RAIN_SCALE` 2 would roughly double storms (and rain) if the first month shows too few |
| Q2 | Should the Qilin appear for a lone level-15+ player, who cannot win the fight (D31)? | yes: the chase and shed scales are still a treat, and friends may join; the lines tell everyone |
| Q3 | A second storm beast (fire, wind) later? | no; the module is data-driven (`content/events/*.json`) if the user asks |
| Q4 | Should the mount be faster than the Red Horse? | no (D19) |
| Q5 | The title's name: "Stormchaser" (this spec) or "Storm-Rider" (CLIMB §7.3's draft row)? | "Stormchaser"; CLIMB's achievements system owns titles, so this spec builds none |
| Q6 | Does the bridle trade? | the dropped bridle trades, the quest one is bound |

---

## Appendix A: scratch files (`work/tmp/qilin/`)

| File | What |
|---|---|
| `storms.ts`, `storms.json`, `storms-seed7.json` | storm statistics on the real `WeatherSchedule` and the trigger-policy table (§2) |
| `peaks.ts`, `peaks.json`, `peaks4.json`, `peaks4.txt`, `grid*.json` | the summit census on the server nav (8 m and 4 m grids) (§3.1) |
| `routes.ts`, `routes.json`, `sites.json` | Dijkstra on a 3 m grid of nav-placed cells, every edge checked with `nav.walk` (§3.3) |
| `route1.ts`, `leg-*.json`, `route-*.json`, `legs.jsonl`, `final-sites.json` | the hot-springs router (copied, start snapping added) for the eastern legs and the rejected peaks |
| `chase.ts`, `chase-f*.json` | the chase rules and their simulation (§4) |
| `sim.ts` (made by `patch_sim.py` from `work/tmp/balance/sim.ts`), `qilin-h*.json` | the fight simulation on the server formulas (§5); `qilin-h0.05-a1-b400.author.json` is the draft's run, kept for comparison |
| `sim-fc.ts`, `fc-qilin-h*.json` | fact-check: `sim.ts` plus a `--fc` case list (flawless solos, Berserk, 4 × L15, careless L16); run `--qhp=0.0833` for the lone-hunter ×0.6 equivalent (§5.2) |
| `expshare.ts` | fact-check: the EXP pool on CLIMB's draft curve and the party rules, and rule #13's expected loss per fight (§6.1) |
| `seatcheck.ts` | fact-check: the seats re-placed on the nav, distances to Tiger Girl's camps, the springs and the tomb door, and the nests that reach each fight circle (§4.1) |
| `release.ts` | fact-check: the scheduled weather when the event hold is released (§2.3) |
| `models/` | the six candidate glbs, converted with `pnpm sro convert … --out work/tmp/qilin/models` |
| `blender/render_models.py`, `blender/render_qilin.py`, `blender/*.png` | candidate and look renders (Blender 5.2, headless) |
| `glbtex.py`, `recolour.py`, `tex/` | texture extraction and the storm recolour + emissive mask |
| `map.py` → **`qilin-map.png`** | the seats, edges and measured routes on the retail minimap tiles |
| `rules.py` → **`qilin-rules.png`** | the chase and fight rules as a state sketch, with the simulated numbers |
| **`model-candidates.png`**, **`qilin-look.png`** | the retail candidates, and the chosen look (boss and mount) |
