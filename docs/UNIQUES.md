# Unique monsters as world bosses: Tiger Girl first (wave 11)

**Status (2026-10-01, I-11): built and integrated in wave 11** (commits 19770ea, 9b661fb, f156783 and the I-11 commit);
not deployed. WAVE_PLAN7's decisions (§2, D1–D33) override this spec where they differ: the notice dispatch lives in
`app.ts` + `hud/unique-notice.ts` (D8), the chat line and the town alarm in the world screen (D9, through
`worldUniqueNotice`), the server seams in W11-SV's files and the module in `apps/server/src/uniques.ts` (D16). I-11
checked it on a private server (a temp copy of the database rolled back to schema 9): migration 10, `/unique list` and
`spawn here`, a 4-bot party kill (both notices, the row, the drops), restarts while waiting and while alive, the
generic `/kill`, `UNIQUES=off`. Measured costs: Dropbox `wave11/budgets.md`.

**Status (2026-10-01): design, fact-checked.** Nothing in `packages/`, `apps/`, `content/` or `deploy/` was changed. The
prototype, scripts and images are in `work/tmp/uniques/`; the fact-check's scripts are in `work/tmp/uniques/factcheck/`.
The fact-check (Appendix B) re-derived every [confirmed] claim and corrected the doc in place: the migration is **10**
(not 19), the label height is **≈ 3.0 m** (not 4.0), the death clip is **cut by the 3 s corpse** unless uniques linger,
the LOD lockstep is **not** given by the existing horse path, the gear table dropped **grade C (level 21–26) items that
nobody at the level-20 cap can wear**, the summon bands are the data's **80/60/40**, the fight budget now uses the
**measured** wave-10r numbers including a server-wide gathering, and several server seams the lanes need were missing.

The user's words (wave 11):

> Tiger Girl is a unique monster, in retail unique monsters are world bosses so she needs announcement upon spawn etc.
> Also shes riding a tiger, the tiger doesnt show up in game, so she looks likes shes floating. Fix her.

This spec:

- finds how retail puts Tiger Girl on her tiger, shows her rendered correctly on it with both models animated together,
  and says exactly what the converter and the client must change (§2);
- designs the unique system, retail-style: which uniques we include, the spawn rules and their persistence, the
  server-wide announcements, loot and EXP, her behaviour in the fight, the map, Berserk, GM commands and the quest
  hook (§3);
- balances her against our level-20 band (§4);
- lists the protocol and the migration (§5), budgets per preset (§6), the prototype (§7), lanes (§8), the scope-cut
  order (§9), risks (§10), decisions (§11), what the user must provide (§12) and open questions (§13).

**Tags.** **[confirmed]**: checked in the code, the data or a measurement, and the text says how. **[likely]**: strong
evidence, not proven. **[projected]**: computed from a measurement or the data, not measured on that setup.
**[unknown]**: open; a default is given. **[decision]**: a choice this spec makes (the user delegated every choice; each
is the option Claude would mark "(Recommended)").

**Sources read.** docs/BACKLOG.md, docs/WAVE_PLAN6.md (the planning and budget format), docs/RENDER.md,
docs/GRASS_LIFE.md, docs/SOUND.md, docs/SYSTEMS_COMBAT.md, docs/QUESTS.md (§1.6 encounters, §3 "The Tiger's Shadow"),
docs/PLAYTEST.md, docs/BALANCE.md, docs/MOVEMENT.md. Code at HEAD `f56d175` plus the polish workflow's working tree:
`apps/server/src/{spawner,gameplay,ai,mob-skills,berserk,party,chat,gm,config,db,world-clock}.ts`,
`apps/server/src/quests/encounter.ts`, `apps/game/src/world/{entities,mount-view}.ts`,
`apps/game/src/three/models.ts`, `apps/game/src/world/fx/anchors.ts`, `apps/game/src/world/jangan/minimap.ts`,
`apps/game/src/hud/target.ts`, `packages/formats/src/bsr.ts`, `packages/convert/src/fx/skilleffect.ts`,
`packages/convert/src/gltf/output.ts`, `packages/convert/src/data/{nests,port-source}.ts`. Data: `work/out/data/*.json`,
`work/out/mob/china/{tigerwoman,bluetiger,tiger}.{glb,json}`, `work/out/fx/skills.json`, the retail client's
`Media/resinfo/skilleffect.txt`, `server_dep/silkroad/textdata/characterdata_*.txt` and `itemdata_*.txt` (extracted in
`work/extracted/`), and the third-party port's `uniques.json` (data only, never its code).

---

## 0. Summary

1. **The tiger is a second model that retail names in data, and we already convert it.** The retail client's
   `Media/resinfo/skilleffect.txt` (the "characterInfo" table) has the row
   `MOB_CH_TIGERWOMAN … ride = res\mob\china\bluetiger.bsr` [confirmed: line 298 of the extracted file]. Our converter
   already parses that column (`skilleffect.ts` `CharacterInfoRow.ride`), already exports `bluetiger.glb` (it is on
   `output.ts`'s extra list, and is in `work/out-opt`, 86 KB brotli), and already writes
   `characters.MOB_CH_TIGERWOMAN.ride` into `work/out/fx/skills.json` [confirmed]. The client reads that field
   (`fx/anchors.ts readCharacters`) and **never uses it** [confirmed: no other reader]. That is the whole bug.
2. **How they fit together** [confirmed in the prototype]: the "Blue Tiger" (white-striped, 3.2 m tall, 7 m long) has a
   `saddle` joint; the woman's clips put her pelvis at her glb origin, sitting astride. Her glb root sits on the saddle
   joint with the saddle's **full** transform (position and rotation), and both play the clip of the same animation type
   at the same time. Their walk, run, attack 1/3, damage, die, die loop and help clips have identical lengths, so they
   were authored together; at the end of DIE1 she is thrown and lies beside the dead tiger. Shots and a GIF: §7.
   The tiger's strides match **her** speeds exactly (WALK 34.66 dm per 1,733 ms = 2.0 m/s = her `walkSpeed`; RUN 81 dm
   per 900 ms = 9.0 m/s = her `runSpeed`) [confirmed: both sidecars' `walkLength` and mobs.json]: the tiger is the mover
   retail authored for her, so its feet will not slide.
3. **Fix:** the converter writes `ride {model: {bsr, glb, sidecar}, joint: 'saddle'}` on her `MobDef` in `mobs.json` (a
   sibling of `championModel`; a few lines); the client gets a ridden-mob composite (one new file plus seams in
   `CharacterActor` and `EntityView`) that loads the ride, seats the rider each frame and mirrors every clip call. The
   server keeps her corpse 8 s instead of 3 s so the death (5.5 s) plays out (§2.3 step 5). No new art, no Blender.
4. **She does spawn today, but as a plain mob.** The lead's premise "no nest, never spawns" is wrong for this tree:
   `work/out/data/nests.json` holds her **11 retail nests**, all in one `uniqueGroup`, and a dry run of the real
   `Spawner` with the real navmesh accepts all 11 [confirmed: `work/tmp/uniques/why-no-tiger.ts`]. What is missing is
   everything that makes her a world boss: no announcement, a respawn timer kept only in memory (so every server
   restart spawns her again at once), full retail HP (598,720) that no party in our band can take down, summons off,
   and a drop table that is a normal mob's.
5. **The unique system** [decision]: a server module `uniques.ts` owns every unique group; it does not use the
   Spawner. It keeps one row per unique in SQLite (**migration 10**; the server has 9 today), rolls one of the 11 retail
   camps per spawn, respawns 3–6 h after a kill (retail's window), first spawn 10–30 min after a fresh start, and comes
   back 1–2 min after a restart that interrupted her. Every player in the world sees **"Tiger Girl has appeared! Area:
   North-Tiger Mt."** and **"Mei has defeated Tiger Girl!"** (or "Mei's party …") in the existing top-centre notice
   banner's queue, with a chat line and a sound.
6. **Roster** [decision]: Tiger Girl only. Our client data has three other field uniques at level ≤ 45: Cerberus
   (24, Constantinople), Captain Ivy (30, Samarkand) and Uruchi (40, Donwhang) [confirmed: characterdata rarity 3]. None
   lives on our map, and the system is data-driven so one can be added later.
7. **The fight** (a party of 4 level-20 friends in about 5 minutes, a solo player never): HP ×0.08 (47,898), full
   attack, her retail skills (the wave-8 monster-skill system), summon waves of White and Black Tigers at the data's
   **80 / 60 / 40 %** HP bands (retail's own row names say so) capped at 4 adds alive, an enrage at 20 % HP, and a
   **fury after 10 minutes** in one fight (damage ×2) that makes a solo kill impossible. A reset (leash 50 m, the retail
   tactics) brings her back to full and despawns her adds.
8. **Rewards:** the existing EXP and loot rules (damage shares, party share mode, top-damage group owns the loot),
   451,200 EXP (retail, untuned), a full Berserk gauge (already in `berserk.ts`), and a **unique drop table** of ours:
   gold, 3 degree-3 items **wearable at the level cap** (grade A/B, required level ≤ `LEVEL_CAP`) with +0 to +3, elixirs,
   Lucky Powder, and a 20 % chance of one Seal of Star degree-3 item.
9. **Budgets:** the tiger adds 3 draws (+3 shadow) and one 35-joint skeleton on one mob in the world: ≤ 0.1 ms CPU when
   she is in view, 0 otherwise. A party of 4 at her camp projects to ≈ 7 ms (WebGPU) / ≈ 5 ms (WebGL2) p95 on Medium;
   the honest worst case is the **whole server (20 players) answering the announcement**, ≈ 14 / ≈ 9 ms on Medium
   (passes G1, thin) and ≈ 19 ms on High WebGPU (misses 60 fps, like the measured crowd + 20 bots; BACKLOG item 9)
   [projected from the measured wave-10r gate, §6]. Nothing new is downloaded at start; the tiger is 86 KB br on first
   sight.
10. **Nothing blocks the start.** The user checks the look (`work/tmp/uniques/tigergirl_ride.gif`) and, after the build,
    one party kill with friends.

### 0.1 Where each user request lands

| User request (verbatim fragment) | Where | Lanes |
|---|---|---|
| "shes riding a tiger, the tiger doesnt show up in game … Fix her" | §2: `mobs.json` `MobDef.ride`; the ridden-mob composite; the 8 s unique corpse | U-CV, U-RC, U-SEAM-S |
| "in retail unique monsters are world bosses" | §3.2 spawn rules, §3.6 behaviour, §4 balance | U-S |
| "she needs announcement upon spawn etc." | §3.3 notices (appear, defeated), banner, chat, sound | U-P, U-S, U-H |
| "etc." (what a world boss needs besides the notice) | §3.4 loot, §3.5 EXP and credit, §3.7 map, §3.8 Berserk, §3.9 GM, §3.10 the questline | U-S, U-H, U-Q |

---

## 1. Today [confirmed unless tagged]

| Fact | How it was checked |
|---|---|
| `MOB_CH_TIGERWOMAN` "Tiger Girl": level 20, rarity unique, HP 598,720, attack 181–217, PD 42 / MD 51, radius 2.8, run 9 m/s, aggressive, EXP 451,200, scale 100 | `work/out/data/mobs.json` |
| Her model `res/mob/china/tigerwoman.bsr`: 7 meshes (1,487 vertices), a 69-joint skeleton (`Bip03` biped with ponytail chains, `Bone01-12`, `wand_bone`), 14 clips. Bind pose: a standing woman 2.11 m tall in a T-pose. No quadruped mesh, no attach list, no second resource in the BSR | the sidecar, the per-mesh bounds of the glb (`work/tmp/uniques/glbinfo.py`), and every printable string of the 3,975-byte BSR |
| Her BSR's sound palette uses `cm_bluetiger_stand`, `cm_bluetiger_walk` (4 footfalls per RUN cycle), `cm_bluetiger_shout_a`, `cm_bluetiger_find`: a quadruped's sounds | the BSR strings; `work/out/sound/model/MOB_CH_TIGERWOMAN.json` already carries them |
| The link to the tiger: `skilleffect.txt` line 298, `MOB_CH_TIGERWOMAN  MOB_TIGERWOMAN  2.8  none  res\mob\china\bluetiger.bsr  …  0,15,-30  hit_2_redblood` (columns `ResourceFileID, ResourceTypeName, Size, Ride Type, ride, …`). A binary search of every extracted file finds `bluetiger` referenced only there (and by the tiger BSRs' own sounds) | `grep -a` over `work/extracted` |
| `bluetiger.bsr`: 3 meshes (692 vertices, 824 triangles), 35 joints (`Bip02` quadruped with `HorseLink` legs, a 5-bone tail and a **`saddle`** joint under `Bip02 Spine1`), 13 clips, one 256×512 DXT1 texture. No characterdata row uses it: it exists only as Tiger Girl's ride. Its 14th clip is a **retail typo**: the BSR names `bluetiger_stnad01.ban`, which is not in the PK2 (the converter warns), so the tiger has no STUN clip in retail either | `work/out/mob/china/bluetiger.json` (stats, warnings); the BSR's strings (fact-check) |
| The tiger's strides equal Tiger Girl's speeds: WALK `walkLength` 34.66 dm per 1,733 ms = 2.0 m/s (`walkSpeed` 2), RUN 81 dm per 900 ms = 9.0 m/s (`runSpeed` 9); the woman's clips have `walkLength` 0 | both sidecars; mobs.json (fact-check) |
| Converted already: `work/out/mob/china/bluetiger.glb` (988 KB raw) and `work/out-opt/mob/china/bluetiger.glb.br` (86 KB; the optimised glb is 101 KB with its texture as a 64 KB **WebP**, decoded to RGBA8 on the GPU, not DXT1); `work/out/fx/skills.json` `characters.MOB_CH_TIGERWOMAN.ride = {glb: /out/mob/china/bluetiger.glb, sidecar: …}` | `ls`; the json; the glb's JSON chunk (fact-check) |
| Other characterInfo rows with a `ride`: `MOB_OA_URUCHI` (`uruchidragon.bsr`), `MOB_KK_ISHADE*` (`RT_FIXED`) and `MOB_RM_TAHOMET`/`MOB_QT_01_TAHOMET` (`RT_DUMMY`). None is in our mobs.json, so Tiger Girl is the only ride the converter writes today; Uruchi would need the same composite if it is ever added | `skilleffect.txt` rows with column 5 ≠ `none` (fact-check) |
| The client reads `ride` (`apps/game/src/world/fx/anchors.ts readCharacters`) and nothing uses it | `grep -rn "\.ride\b" apps/game/src` |
| Her 11 retail nests (ids 5656–5659, 5903–5909) are in `nests.json`, `enabled: true`, `uniqueGroup: MOB_CH_TIGERWOMAN`, respawn 10,800–21,600 s, sight 14 m, leash 50 m. Their `inConvertedRegion: false` flag is stale (817 of 825 nests carry it) and nothing reads it | the json; `grep inConvertedRegion apps/server/src` finds nothing |
| The `Spawner` already supports unique groups (one living mob per group, a random nest per spawn). A dry run with the real export and the jangan-fields navmesh accepts all 11 nests, at `MOB_LEVEL_MAX` 25 and 0 | `work/tmp/uniques/why-no-tiger.ts` |
| The group's respawn timer lives in memory only; `fill()` at server start spawns the group at once. So every restart spawns Tiger Girl immediately | `spawner.ts` `fill`, `died`, `pending` |
| The camps lie in three zones: Bandit's Mountain Stronghold (5656–5659), North-Tiger Mt. (5903–5906), South-Tiger Mt. (5907–5909) | `GameData.zoneName` in `work/tmp/uniques/dryrun.ts` |
| Monster skills (wave 8): her rows ATTACK01 (melee, 2 hits, aiChance 100), ATTACK02 (melee, 300 %, aiChance 30, a 4 m area hitting up to 5), ATTACK03 (ranged 15 m curse, 367 % magic, the `zombie` status, aiChance 10) and SUMMON01–04 (White and Black Tigers; aiChance 80 / 60 / 40 / 0, used as HP bands). Retail's own Korean row names in skilleffect.txt are "호녀 80% / 60% / 40% / 00% 이상 소환" (Tiger Woman, summon at 80 / 60 / 40 / 0 %), so the bands our code already uses are retail's. Summons are off by default (`MOB_SUMMONS=0`, cap 6 per summoner); summons are nest-less mobs that give their normal EXP and loot | `work/out/data/skills.json`; `mob-skills.ts`; `config.ts`; skilleffect.txt lines 1808–1811 decoded as cp949 (fact-check) |
| The quest finale JG_025 already summons a private Tiger Girl with the Binding Bell (`hpMul 0.05` = 29,936 HP, `attackMul 0.8`, `expMul 0.1`, 600 s); "the roaming retail Tiger Girl also counts" for its kill objective. The bell is rung at `LOC_TIGER_SHRINE` (−1001, 600), **the position of camp 5906** | `quests/encounter.ts`; `content/quests/jangan.json`; docs/QUESTS.md §1.6 |
| A mob corpse is removed `CORPSE_MS` = 3,000 ms after death and fades for 0.9 s on the client; her DIE1 lasts 5,533 ms, so today's death is cut at ≈ 3.9 s, while the tiger is still rearing (§2.3 step 5) | `formulas.ts`, `gameplay.ts` corpse sweep, `entities.ts` `FADE_S`; the DIE1 samples in `factcheck/die.py` |
| The kill path (`Gameplay.mobDied`) rolls `this.data.drops.get(m.def.code)`, spawns every drop with `plus` 0, calls `m.damage.clear()` and only then the modules' `mobDied(m, now, credit)` hook; a GM kill (`rewards` false) returns before any hook | `gameplay.ts` lines ≈ 1000–1030 |
| The server database has **9 migrations** (`SCHEMA_VERSION = MIGRATIONS.length` = 9; a temp copy of `work/server/game.db` has `user_version` 9) | `db.ts`; `pnpm tsx` print; sqlite on a copy (fact-check) |
| A unique kill fills the Berserk gauge | `berserk.ts` (`unique: HWAN_MAX`) |
| The minimap draws the retail unique sign (`mm_sign_unique`) for a unique in range; the target window uses the special frame and the `tw_icon_unique` icon and a pink name (`var(--c-unique, #ff9cf0)`: the variable has no definition, the fallback is what shows) | `world/jangan/minimap.ts`; `hud/target.ts`; both pngs in `work/out/ui/` |
| The only server-wide message is the GM `notice` (`{t:'notice', text, from?}`): `app.ts` shows it in the app-wide `NoticeBanner` (`ui/notice.ts`: one queue, 6–20 s by length, on every screen, the lobby included) and `screens/world.ts` adds the chat line | `protocol.ts`; `apps/game/src/app.ts`; `ui/notice.ts`; `screens/world.ts` |
| Her drop table (the port's) is a normal mob's: potions at 0.2–2.5 % and degree-3 gear at 0.03 % each | `work/out/data/drops.json` |
| docs/BALANCE.md §8 records "the field Tiger Girl … cannot be killed by 2–4 friends. That is retail, and a decision, not a bug", and §9 lists her as an observation for the owner. This spec is that follow-up | docs/BALANCE.md |

**What the user sees today** [likely]: the woman alone, in her riding pose, with her pelvis at the mob's ground point
(`EntityView` puts the actor root at `heightAt(x, z)`, and her root is her pelvis) and nothing under her (the "before" figure at the left of `work/tmp/uniques/shots/01_before_after.png`). In game, where her
feet and hips land depends on the actor's grounding; the user reads it as floating [unknown: not reproduced in the game
this wave, because the prototype answers the question].

---

## 2. The tiger fix

### 2.1 How retail composes her [confirmed unless tagged]

- **The link is data, not the BSR.** characterInfo's `ride` column names the model the character sits on. Only Tiger
  Girl has one among our mobs. The `Ride Type` column is `none`.
- **The seat is the ride's `saddle` joint.** The tiger's rest `saddle` is at (0, 2.60, 0) m with identity rotation in
  model space; in its clips it moves with the back (STAND1 1.84–2.12 m, WALK 2.13–2.32 m, RUN 2.45–3.18 m pitched −23°
  to +11°, ATTACK1 pitched up to 57° as the tiger rears) [confirmed: `factcheck/seat.py`, 40 samples per clip].
- **The rider is authored relative to that joint.** In her stand, walk and attack 1–2 clips `Bip03` (her pelvis) stays
  within 4 mm of her glb origin with a constant rotation, feet about 0.5 m below and 0.45 m to each side (astride). The
  clips that move the pelvis are RUN (≤ 0.14 m: her bob), DAMAGE1 (≤ 0.13 m: a jolt), ATTACK3 (up to 1.53 m: the leap off
  the saddle and back) and DIE1 / DIE1_RM (≈ 0.6 m: thrown to the ground beside the tiger) [confirmed: `factcheck/seat.py`].
  So her origin is the saddle.
- **Position and rotation, not position alone.** With the full saddle transform she leans with the tiger's back at a
  run and, at the end of DIE1, is thrown to the ground beside it. With position only she sits bolt upright and, after
  the death, pokes out of the dead tiger's flank (`work/tmp/uniques/cmp_seat_modes.png`, left column full, right column
  position only; `cmp_die_end.png`). The horse `RideLink` (`mount-view.ts`) uses position only, because a player's cart
  clips are not authored on the horse; this composite must not copy that choice.
- **The clips pair by animation type.** Same length (ms) for WALK 1,733, ATTACK1 2,500, DAMAGE1 966, DIE1 5,533, RUN 900,
  DAMAGE2 1,866, ATTACK3 5,000, DIE1_RM 333, HELP 3,733. Different: STAND1 (woman 2,666 / tiger 5,333), STAND2
  (5,333 / 2,666), ATTACK2 (4,000 / 3,333), FIND (3,333 / 3,066); STUN exists only on the woman (her STAND1 file; the
  tiger's STUN is retail's missing `stnad01` typo, §1). In every mismatched pair the woman's clip is the longer or the
  looping one, so the leader (the woman) always ends last.
  Looping the idles at their own lengths looks right because her pose is relative to the saddle (she follows whatever
  the tiger does); a one-shot that ends first holds its last frame until the other ends [confirmed by eye in the
  filmstrip; whether retail pairs STAND1 with STAND1 or by length is unknown and does not show].
- **Timing events** stay on the woman: her sidecar's hit events (ATTACK1 at 1,109 and 1,379 ms, ATTACK2 at 930,
  ATTACK3 at 341 and 3,004) drive the server's cast timing already; the tiger's clips carry none.
- **Sounds** need no change: her BSR's sound palette is the tiger's (§1).
- **Damage point:** characterInfo `DamagePos 0,15,-30` dm is already read by `damagePoint` in the entity's frame
  [confirmed: `anchors.ts`]. `dmToMetres` mirrors Z (file space is left-handed), so it is **1.5 m up and 3.0 m forward**,
  not back: the tiger's head and chest (its mesh reaches z +2.9 m) [confirmed: `anchors.ts dmToMetres`, the bind
  bounds]. Hit effects therefore land on the tiger's face, where melee players stand; that is what retail authored and
  needs no change.

### 2.2 What the converter must change (lane U-CV) [decision]

1. **`packages/convert/src/data/mobs.ts`:** for a mob whose characterInfo row has `ride`, write
   `ride = { model: { bsr, glb, sidecar }, joint: 'saddle' }` on its `MobDef` in `mobs.json` (the same `/out/…` paths
   `skills.json` uses), a sibling of the existing `championModel`. The joint name is checked against the ride's skeleton
   at convert time; a ride without a `saddle` joint is a converter warning and no `ride` field. Today that yields
   exactly one entry, Tiger Girl's (the other characterInfo rides, §1, belong to mobs we do not export).
2. **`packages/shared/src/content.ts` + `content-check.ts`:** `MobDef.ride?: { model: ModelRef; joint: string }`,
   optional (older exports keep loading). [Fact-check: the doc said `MobModel.ride`; there is no `MobModel` type. A
   mob's `model` is the shared `ModelRef` that NPCs, items and horses also use, so the ride goes on `MobDef`, the
   `championModel` pattern, and `ModelRef` stays untouched.]
3. **Nothing else.** `bluetiger.glb` is already exported and optimised; it stays on `output.ts`'s extra list so a
   re-convert keeps it. **Why `mobs.json` and not the fx index** [decision]: the actor loader reads `catalog.mob(code)`
   before the fx index is guaranteed to be loaded, and the ride is part of the model, not of an effect; `skills.json`
   keeps its copy for the fx code.
4. Re-convert: `pnpm sro convert` of the data step only (mobs.json); no glb changes, so the optimizer is not re-run. The
   two notice sounds (§3.3) also need the **sound export** re-run (`tools/export-sound.ts` encodes the files the cue
   table references to Opus with the local ffmpeg; nothing is downloaded).

### 2.3 What the client must change (lane U-RC) [decision]

A **ridden-mob composite**, in a new file `apps/game/src/world/ride-mob.ts`, plus seams in `three/models.ts` and
`world/entities.ts` (and one server seam for the corpse, step 5):

1. **Load:** when `EntityView.load` builds a mob actor and `catalog.mob(code).ride` exists, it also loads the ride glb
   (same loader, same cache, same texture path, same material decorators) as a second `CharacterActor`, in the same
   `load()` so both compile their shaders in the same frame. **The woman stays `EntityView.actor` (the leader)**: her
   sidecar carries the hit events, `nextAttackClip`, the clip info and the sound palette that the attack timing and the
   sound runtime read. The ride's root takes the place `EntityView.load` gives the leader's root today (parent =
   entity root, scale, yaw); the rider's root hangs under a **seat** node.
2. **Seat every frame:** the seat copies the `saddle` joint's world matrix (decomposed: scaling, rotation, position)
   after `scene.animate()` and before the active-mesh evaluation, i.e. in the world screen's frame tick (it runs on
   `scene.onBeforeRenderObservable`, after the animations, where `features/mount.ts onFrame` seats the horse rider), with
   the ancestor chain's world matrices recomputed first (`mount-view.ts worldPoint`), or it reads last frame's saddle
   [confirmed: Babylon 9.28 `scene.pure.js` render order: `onBeforeAnimations` → `animate()` → camera update →
   `onBeforeRender` → render targets (the shadow maps) → the camera pass with its active-mesh evaluation, so a seat set in
   `onBeforeRender` is what the shadows and the main pass both draw; `screens/world.ts` registers the tick on `onBeforeRenderObservable`].
   **Animation LOD is not shared by the existing path** [fact-check]: `ModelLibrary.lodActors` marks a carrier only for an
   actor with `lodFull` (the player's own character), so a mob's rider and ride would each run their own `lodTick` with
   their own interval (their bind heights differ: 2.11 m vs 3.24 m) and skip different frames. The seam therefore adds
   **`lodLeader: CharacterActor | null`** on `CharacterActor`: a follower copies the leader's skip decision each frame
   (`lodSkip`, `lodNext`), and the leader is the ride (the bigger one); culling likewise uses the composite's sphere on
   the ride and sets the rider's `offscreen` from it, so a catch-up (`lodCatchUp`) steps both.
3. **Mirror the clips:** a `CharacterActor` seam `companion: CharacterActor | null` (new). Every clip entry point of the
   leader is applied to the companion with the companion's own clip of the same name: `play(base, force, speed,
   fromFrame)`, `playAction(group, speed)` (mapped by `group.name`), `hurt()`, `die(instant, clip)`, `revive()`,
   `cancelAction`, `stop`, plus `setOpacity`, `setHighlight`, `setEnabled` and `dispose`. **Not mirrored but redirected**:
   `setYaw` and the root scale act on the ride's root only (the rider already inherits them through the seat; mirroring
   would turn and scale her twice). Fallbacks: STUN → STAND1; a missing name → the companion keeps its current base
   clip. **The companion never resumes on its own**: its `playAction` end observer does not restart its base (or the
   tiger would go back to STAND1 0.7 s before she finishes ATTACK2); a one-shot that ends first holds its last frame, and
   the leader's own resume calls `companion.play(...)`.
4. **Sizes from the composite:** the label height, pick cylinder and culling sphere come from the composite, measured
   once in its STAND1 pose from both actors' skinned meshes relative to the ride's root (the `measurePose` technique;
   the leader's own `measurePose` would measure from her root, which now sits on the saddle), and handed to the leader
   through a height hook so `EntityView.height` (which reads `actor.height`) picks it up; not from the bind poses (her bind pose is a standing
   T-pose, 2.11 m above her pelvis, which seated on the 2.60 m rest saddle would give ≈ 4.5 m). Skinned STAND1 extents:
   rider top 2.59–2.94 m, tiger top 2.32–2.51 m, horizontal reach 4.0 m (the tail) [confirmed: `factcheck/skin.py`, the
   real glbs skinned in numpy over 12 samples]; so `standingHeight` ≈ **3.0 m** and the label sits at ≈ 3.2 m. [The
   original "≈ 4.0 m, test ≥ 3.8 m" put the name a metre above her head.] The culling sphere uses the tiger's bind
   extent (z −4.08..+2.91 m, top 3.23 m) plus 1.5 m for the rider's RUN and ATTACK3 peaks (rider top up to 4.4 m); the
   pick cylinder uses the mob radius 2.8 m (already) and the 3.0 m height.
5. **Death:** the corpse fade and the removal act on both actors. DIE1 then DIE1_RM (the loop) play on both, which
   leaves her lying beside the tiger, **but only if the corpse lives long enough** [fact-check]: the server removes a
   corpse `CORPSE_MS` = 3 s after death and the client fades it for 0.9 s, while DIE1 lasts 5.5 s. At 3.0–3.9 s the tiger
   is still rearing (its top at 2.8–3.1 m) and she is mid-fall (rider 0.2–2.4 m); she reaches the ground at ≈ 4.5 s
   [confirmed: `factcheck/die.py`]. So the server keeps a unique's corpse **8 s** (`UniqueDef.corpseSec`, a per-mob
   override of the corpse sweep in `gameplay.ts`, lane U-SEAM-S): the death plays out and she lies beside the tiger for
   ≈ 2.5 s before the fade [decision]. The override is keyed by mob code from `content/uniques.json`, so the Binding
   Bell's Tiger Girl gets the same 8 s.
6. **Everything else is untouched:** the hit point, the target frame, the name label's element (only its height
   changes, step 4), the minimap sign, and the server apart from the corpse time.
   The quest encounter's Tiger Girl (same mob code) gets the tiger too.
7. **Classic (Low):** the same composite; it is three meshes. No preset turns it off.

### 2.4 Tests for the fix

- Converter: a characterInfo row with `ride` → `mobs.json` `MobDef.ride` with `joint: 'saddle'`; a ride glb without the
  joint → a warning and no field; the real export has exactly one ride (Tiger Girl).
- Client (NullEngine, the real glbs): after `play('RUN')` and one frame, the rider's `Bip03 Pelvis` world position is
  within 0.15 m of the saddle's, and the rider's root rotation equals the saddle's world rotation within 1e-4
  (the prototype measured 0.003–0.12 m, the fact-check 0.138 m at the top of her RUN bob); the companion's current clip
  is RUN; STUN plays STAND1 on the tiger; ATTACK2 on the leader leaves the tiger holding its last frame from 3,333 to
  4,000 ms and both resume the base together; `setYaw(1)` turns the ride's root and leaves the rider's root rotation
  relative to the seat unchanged; with the animation LOD on and the camera far away, the two actors skip exactly the
  same frames over 300 frames; `dispose()` disposes both; the label height is 2.8–3.4 m.
- Server: a unique's corpse is removed after `corpseSec` (8 s), a normal mob's still after 3 s.
- A visual check in the viewer (§7) is the user's check, not a test.

---

## 3. The unique system

### 3.1 Which uniques [decision: Tiger Girl only, a data-driven list]

| Unique | Level | HP (retail) | Home | In our world? | Verdict |
|---|---|---|---|---|---|
| Tiger Girl `MOB_CH_TIGERWOMAN` | 20 | 598,720 | Tiger Mountains, Jangan (11 camps) | yes | **in** |
| Cerberus `MOB_EU_KERBEROS` | 24 | 693,072 | Constantinople (13 camps) | no | out: not our map or band |
| Captain Ivy `MOB_AM_IVY` | 30 | 1,094,835 | Samarkand / Asia Minor (8 camps) | no | out |
| Uruchi `MOB_OA_URUCHI` | 40 | 1,779,528 | Donwhang (11 camps) | no | out (Donwhang is not playable; the coast's land bridge only points toward it) |
| Winter event uniques (`MOB_EV_WINTER_*`, levels 20–40) | 20+ | – | event | no | out (events are not in scope) |

[confirmed: `characterdata_*.txt` rows with rarity 3, service 1, level ≤ 45, without the fortress, quest, `_L2`/`_L3`
and event variants; homes from the port's `uniques.json` and `all-nests.json`]. Re-homing Cerberus into the Jangan fields
as a second boss would be invented content; it is §13 Q3, default no. The system reads `content/uniques.json`, so a
second unique is a content change plus its model check.

### 3.2 Spawn rules [decision]

| Rule | Value | Why |
|---|---|---|
| Camps | the 11 retail nests of her `uniqueGroup` (§1), **re-read from `data.nests` at every roll** (so the GM spawn editor's `content/nests.override.json`, `/nest` and `content reload nests` apply; a disabled or removed camp drops out), each placed on the navmesh at spawn (a camp that will not place is skipped and logged) | retail positions; all 11 place today [confirmed: dry run re-run in the fact-check; no override touches them] |
| Which camp | uniform random over the placeable camps, a new roll each spawn | retail behaviour as the port documents it (`uniques.json`: "the scheduler rolls ONE camp uniformly per spawn") |
| Alive at once | at most 1 | retail |
| Respawn | uniform 180–360 min after the kill, from the nest's `respawnSec` [10,800, 21,600] | retail window (nests.json and the port agree) |
| First spawn on a fresh database | uniform 10–30 min after the server starts | friends online in the evening see her the first night; not at once, so a restart is not a free boss |
| Server restart while she waits | the saved due time is kept (if it passed during the downtime: 1–2 min after the boot) | no free respawn from a restart |
| Server restart while she is alive | she comes back 1–2 min after the boot, at a new random camp, at full HP | simplest honest rule; her old fight cannot be restored |
| A GM despawn (`/unique kill`, `/unique despawn`, or the generic GM `/kill <id>` on her) | as a kill without rewards: the normal 3–6 h timer (`/unique timer` can shorten it). The generic `/kill` runs no module hook (§1), so the module notices her death or removal in its own `tick` (her mob gone or `ai === 'dead'`), the way `mob-skills.ts` notices a summoner killed by a GM | predictable; no state lost to a path without hooks |
| Persistence | SQLite table `uniques` (**migration 10**, §5.2): `code, phase ('waiting' or 'alive'), due_at, camp, spawns, last_killer, last_killed_at`; written on spawn, death and GM changes only | survives restarts and backups with the rest of the world |
| Owner of the unique groups | the new `uniques` module; the Spawner refuses any nest with a `uniqueGroup` **in `Spawner.refusal`** when the module is on (`UNIQUES=on`, the default), so the live nest edits (`updateNest`, used by `/nest` and `content reload nests`) never re-attach one either; `UNIQUES=off` keeps today's behaviour | one owner per piece of state (WAVE_PLAN6 §2.2) |
| The quest encounter | unchanged: the Binding Bell's Tiger Girl is private, not announced, not counted against "one alive". The bell's shrine is camp 5906's spot, so both can stand there at once (§10) | a quest must not wait 3–6 h for a world boss |
| GM `spawn MOB_CH_TIGERWOMAN` | unchanged: a plain test mob, not announced, not tracked | test tool |

**The dry run** (`work/tmp/uniques/dryrun.ts`, the scheduler as a pure state machine on the real camps, zones and
navmesh; its log uses a draft wording, §3.3 has the final one) [confirmed]:

```
T+  0.39 h  NOTICE  Tiger Girl has appeared in Bandit's Mountain Stronghold.   [camp 5659]
T+  0.60 h  NOTICE  Wonkyfist has defeated Tiger Girl!   [next spawn T+ 5.50 h]
T+  2.60 h  (server restart; row reloaded: phase waiting, due T+ 5.50 h)
T+  5.50 h  NOTICE  Tiger Girl has appeared in South-Tiger Mt..   [camp 5909]
…
T+ 12.00 h  (server restart while alive)
T+ 12.02 h  NOTICE  Tiger Girl has appeared in Bandit's Mountain Stronghold.   [camp 5657]
```

It caught one bug to design out: two zone names end with a full stop ("North-Tiger Mt.", "South-Tiger Mt."), so the
sentence must not add a second one. The text keys below put the area last, where no full stop follows, so the area is
shown **as is** ("Area: North-Tiger Mt.", the same spelling as the minimap and the HUD) [fact-check: the earlier
"the formatter strips a trailing '.'" would print "Mt" without its abbreviation dot; dropped]. Zone names come from
`GameData.zoneName` at spawn time, so the polish workflow's zone-name changes flow through (its current change only
names coast regions [confirmed: the working-tree diff of `packages/convert/src/data/zones.ts`]).

### 3.3 Announcements [decision]

- **Who:** every player in the world (not the lobby, not the character screens), the moment it happens. No late
  replay on login (retail has none); `/unique list` is the GM's view.
- **Wire:** a new server message `uniqueNotice` (§5.1) with the event, the mob code, the area and the killer, so the
  client builds the sentence from i18n keys (the English-UI rule: live text only) and picks the style and sound. The
  GM `notice` stays as it is.
- **Text (en):**
  - appear: **"Tiger Girl has appeared! Area: North-Tiger Mt."** (`unique.appeared`, `{name} has appeared! Area: {area}`;
    without a zone name: `{name} has appeared!`);
  - kill, solo: **"Mei has defeated Tiger Girl!"** (`unique.defeated`);
  - kill, party: **"Mei's party has defeated Tiger Girl!"** (`unique.defeatedParty`);
  - the credit goes to the **loot-owner group** (the party or solo player with the most damage, exactly the group that
    `party.killShares` / `soloShares` makes the loot owner); the named player is that group's top-damage member, and
    the "party" form is used when the group is a party. Not the last hit: the last hit is luck, and retail's own rule is
    unknown [unknown]. [Fact-check: "the top-damage dealer" alone is not the loot rule: a solo player with 40 % of the
    damage beats each member of a party holding 60 %, yet the party owns the loot; the notice would have named the
    wrong side.] Because `Gameplay.mobDied` clears `m.damage` before the modules' hook (§1), the kill path passes the
    owner group to the module (a U-SEAM-S seam, §8.1).
- **UI:** the existing app-wide `NoticeBanner` (`ui/notice.ts`, framed by the `com_notice_*` pieces), shown through
  **its one queue** with a `kind: 'unique'` option (the unique's name in the unique pink `#ff9cf0`, its own title,
  8 s), so a unique notice and a GM notice queue behind each other instead of two banners overlapping at the top
  centre; plus a chat line on the `notice` channel colour [fact-check: the doc's separate `hud/unique-notice.ts` banner
  would overlap the GM banner, which `app.ts` shows on every screen]. The banner is only fed while in the world (the
  server sends `uniqueNotice` to world sockets only).
- **Sound:** `ui.uniqueAppear` = the retail `snd/ui/alarm_sound.wav` (4.9 s, 24 kHz mono); `ui.uniqueDown` =
  `snd/ui/eventcomplete.wav` (3.1 s, 22 kHz mono). Both exist in the client [confirmed: `work/extracted/Data/prim/snd/ui/`,
  wav headers] and are neither in the sound index nor encoded in `work/out/sound/ui/` yet [confirmed: the index's 98
  cues and 599 files]; U-CV adds the two cues and the sound export encodes them (§2.2 step 4). No retail table names
  either file [confirmed: no hit in `Media/resinfo` or `server_dep/.../textdata`], so which file retail used for this is
  unknown; the user judges by ear (§12).
- **Players near her** (within 120 m of the camp) also hear her own roar (`cm_bluetiger_find`, already in her sound
  palette) once at the spawn [decision; cut 5].

### 3.4 Loot [decision]

The unique drop table lives in `content/uniques.json` (ours, editable without code) and **replaces** her `drops.json`
row for the field unique; the quest encounter keeps the normal row (it is a story fight, not the boss's loot).

| Group | Chance | What | Notes |
|---|---|---|---|
| Gold | 100 % | 3 piles of 2,000–4,000 | ≈ 9,000 per kill, about one degree-3 shop item; BALANCE §5 says gold is tight for potions |
| Gear | 100 %, rolled 3 times | one degree-3 item (weapons, shield, armour of both sexes, accessories) **whose required level is ≤ the server's `LEVEL_CAP`** (20 today), the highest wearable grade weighted 60 % and the one below 40 %, plus +0 (55 %), +1 (25 %), +2 (15 %), +3 (5 %) | the band's best. [Fact-check: degree-3 grade C needs level 21–26 (weapons and the shield 21, armour 21–26, accessories 21–25) and some grade B armour 21–23 [confirmed: items.json `reqLevel` by grade letter], so the doc's "B 60 % / C 40 %" made ≥ 40 % of the gear unwearable at the cap. At cap 20 the pool is weapons and shield A (16) / B (18), armour and accessories A and B up to 20.] `spawnGroundItem` takes a `plus`, but the kill path passes 0 today (§1): a U-SEAM-S seam |
| Elixirs | 100 %, rolled 2 times | Elixir (Weapon) 40 %, (Protector) 40 %, (Shield) 10 %, (Accessory) 10 % | wave-8 alchemy items [confirmed in items.json] |
| Lucky Powder | 50 % | Lucky Powder (3rd) ×1–2 | alchemy |
| Potions | 100 % | 10 HP Recovery Potion (Large) + 10 MP (Large) | a thank-you for the potions the fight cost |
| Seal of Star | 20 % | one degree-3 `_A_RARE` item (Seal of Star) of the same wearable pool (required level ≤ `LEVEL_CAP`) | needs U-CV to export the degree-3 `_RARE` rows (they exist in the retail itemdata, e.g. `ITEM_CH_BLADE_03_A_RARE` in `itemdata_5000.txt` / `_30000.txt` [confirmed: UTF-16 text search]; none is in our `items.json` [confirmed]) and the item name colour; cut 3 drops it and keeps a +4 instead |

- **Who gets it:** today's rules, unchanged [confirmed: `party.ts killShares`, `gameplay.ts soloShares`]: the group
  (party or solo player) with the most damage owns every drop for the 30 s owner window; inside a party, share mode
  hands drops round-robin to the eligible members (within 60 m), free mode lets any member pick up. No new rule.
- Drops land in a ring of **2.5–4 m** around the corpse's root through the existing `dropPoint` (a straight walk on the
  navmesh), instead of today's 1–1.5 m, because of the count and the tiger's bulk [decision; cosmetic]. [Fact-check:
  the doc centred the ring on `DamagePos`, but that is client fx data the server does not load, and it points 3 m
  forward (§2.1), not to the body's centre; a wider ring around the root is the same result without a new data path.]
- **Economy** [projected]: besides ≈ 9,000 gold, the two elixirs sell to a shop for 10,000 each and the Lucky Powder
  (3rd) for 3,773 [confirmed: items.json `sellPrice`], so a kill is worth ≈ 30,000 gold to a party that sells. At one kill
  per 3–6 h per server that is a modest, rare injection; GOLD_RATE does not touch item sell prices.

### 3.5 EXP and credit [decision: today's rules]

- 451,200 EXP and as much SP-EXP, retail, **not tuned down** with her HP (§4.3 says why), shared by damage between
  groups and, inside a share-mode party, by level with the party bonus (`levelShares`, `PARTY_EXP_BONUS`)
  [confirmed: `party.ts`]. EXP_RATE / SP_RATE apply.
- Quest kill credit: today's `mobDied` credit, so the field Tiger Girl counts for JG_025's kill objective (QUESTS §1.6).
- Summoned adds give their normal EXP and loot while she lives; when she dies or resets they leave with her, without
  corpse or loot [confirmed: `mob-skills.ts`].

### 3.6 Behaviour [decision]

| Topic | Rule | Source |
|---|---|---|
| Aggro | aggressive, sight 14 m (her nest tactics) | nests.json [confirmed] |
| Leash | 50 m from the camp she spawned at; past it she runs home ignoring everyone, then **resets**: full HP, summons despawn, bands re-arm, the damage table and the fury timer clear | nests.json `leashRange` 50 [confirmed]; the AI's `return` state already regenerates to full [confirmed: `ai.ts`] |
| Out-of-combat regen | the normal mob regen while idle | `regenMob` [confirmed] |
| Skills | her retail rows through the wave-8 system (`MOB_SKILL_DAMAGE=relative`): ATTACK01 71 %, ATTACK02 (4 m area) 21 %, ATTACK03 (15 m curse + `zombie`) 7 % and as the ranged special against a kiting player | `mob-skills.ts` [confirmed] |
| Summons | **on for uniques only** (a per-unique switch in `content/uniques.json`; the global `MOB_SUMMONS` stays 0): SUMMON01 at 80 %, SUMMON02 at 60 %, SUMMON03 at 40 %: the bands `mob-skills.ts` already reads from the rows' `aiChance`, and retail's own row names ("summon at 80 / 60 / 40 %"); SUMMON04 has aiChance 0 = off. Each wave is clipped to **normal-variant** White Tiger (18) and Black Tiger (17) only, **2 per wave**, **4 alive at most**. [Fact-check: the doc used the port's 80 / 55 / 30, which the port itself calls "INTERIM … unmeasured"; the data's bands need no band config at all.] | the retail waves hold 6–12, 10–20 and 9–18 tigers with champions, giants and elites [confirmed: skills.json `summon` min/max and rarity bytes 0 / 1 / 4 / 6], which would wipe a level-20 party (BALANCE: one White Tiger costs a level-18 player 57 % HP) |
| Enrage | at ≤ 20 % HP: damage ×1.25, once per life; an area line "Tiger Girl is enraged!" to players within 60 m | the user asked for one; ours, mild. [Fact-check: "ATTACK03's cooldown halved" dropped: ATTACK03 is picked at aiChance 10, so its cooldown is rarely what limits it, and a per-row cooldown modifier is one more seam for no visible effect] |
| Fury (anti-solo) | 10 min after the fight started (first damage since the last reset), damage ×2 until she resets or dies; an area line "Tiger Girl grows furious!" | a party of 4 kills her in ≈ 4–6 min (§4); one or two players cannot finish in 10 min. [Fact-check: "attack interval ×0.75" dropped: `mob-skills.ts use()` sets the next swing at the longest of the clip's cast + action, the row's cooldown and the mob's interval, so ATTACK01 (2,500 ms of clip, 3,000 interval) could only drop to 2,500 ms, and a faster swing than the clip would cut her client animation] |
| Damage modifiers (enrage, fury) | one per-mob outgoing-damage multiplier (`Mob.damageMul`, default 1) read where `mob-skills.ts` scales a row's percent (next to `MOB_DAMAGE_RATE`); every mob swing already goes through `mob-skills.ts` (`Gameplay.swing` → `mobSkills.swing`) [confirmed]; the uniques module sets it | a U-SEAM-S seam (`mob-skills.ts`, `world.ts` `Mob`); nothing else in combat changes |
| Reset detection | the module watches her `ai` in its tick: `return` (leash, or no one left) → despawn her adds, re-arm, clear the fury clock; home again (`Gameplay.restored` already refills HP) | no AI change [confirmed: `ai.ts goHome` clears `m.damage`; `mob-skills.ts` re-arms bands only at full HP and idle] |
| Stuns and knockdowns | as any mob (no immunity) | retail uniques are not immune as far as we know [unknown]; §13 Q5 |
| Variant | `unique` (`VARIANT_RULES.unique` = ×1 HP, EXP and attack) with a server tuning `hpMul 0.08`, `attackMul 1.0`, `expMul 1.0` (the encounter's `MobTuning` path in `createMob`) [confirmed: `formulas.ts`, `gameplay.ts createMob`] | §4 |
| Corpse | stays 8 s (`corpseSec`), not 3 s, so DIE1 (5.5 s) ends with her on the ground (§2.3 step 5) | the look the user asked for, to the end |

### 3.7 Map and minimap [decision]

- **No world-map marker** and no position in the notice beyond the zone: finding her is the hunt.
- **Minimap:** the retail unique sign when she is in minimap range, which the minimap already draws for any unique
  [confirmed: `minimap.ts`]. Nothing to build.
- **Target window:** the special frame, `tw_icon_unique` and the pink name [confirmed: `target.ts`]. Nothing to build.

### 3.8 Berserk [confirmed, nothing to build]

A unique kill fills the gauge for every credited player (`berserk.ts`, `unique: HWAN_MAX`). Berserk during the fight
(×2 damage for 60 s) is part of the balance below.

### 3.9 GM commands (`/unique`) [decision]

| Command | Does |
|---|---|
| `/unique list` | every unique: alive (camp, zone, HP %, fight time, attackers) or waiting (due in h:mm, last killer and time) |
| `/unique spawn <name or code> [here \| camp <id>]` | spawns it now, announced, as the real field unique (the `here` form at the GM's position for tests); refused while one is alive |
| `/unique kill <name>` | kills it without rewards; **not announced**, logged; the timer runs (3–6 h); the generic `/kill <id>` on her has the same effect (§3.2) |
| `/unique despawn <name>` | removes it silently; the timer runs |
| `/unique timer <name> <minutes \| now \| clear>` | sets the due time (now = next tick); `clear` = a new roll of the 3–6 h window |
| `/unique quiet <on \| off>` | GM-local: the GM's own client does not show unique banners (for testing in a busy world) |

Every command goes through the GM audit log (`gm_audit`) like the others [confirmed: the table exists].

### 3.10 The questline hook [decision: light]

- **Kept:** JG_025's Binding Bell encounter (private, weaker, not announced), and its kill objective also accepting the
  field Tiger Girl [confirmed: QUESTS §1.6].
- **Added (optional, cut 1):** while the field Tiger Girl is alive, Hunter Associate Gwakwi and Priest Jeonghye add one
  rumour line to their dialog, "The Daughter of the Mountain was seen near {area}." A content-only change through the
  quest engine's dialog conditions plus one server fact (`uniqueAlive(code)` → area).
- **Not done:** blocking the bell while the field unique lives (it would stall the questline for hours), and a new
  quest for the field kill.

---

## 4. Balance (docs/BALANCE.md) [projected unless tagged]

### 4.1 Party damage

- BALANCE §3 (the finale model): 4 level-19 players kill the bell's 29,936-HP Tiger Girl in about 3 minutes, i.e.
  **≈ 165 damage/s** for the party, the tank losing about 30 HP/s at `attackMul 0.8` [confirmed: BALANCE §3, a model].
- BALANCE §6: a level-20 blade with skills kills a Chakji Worker (958 HP, PD 59) in 19.9 s, a glaive in 17.9 s:
  **≈ 48–54 damage/s** each against a higher PD than hers (42) [confirmed: BALANCE §6, a model]. Four players: ≈ 190–215.
- Berserk (×2 for 60 s, one gauge per player at most) adds ≈ +10 % over a 5-minute fight.
- So a party of 4 level-20 friends does **≈ 165–215 damage/s**, a solo player ≈ 50.

### 4.2 Her HP, time to kill, and the fury

| Group | Damage/s | HP ×0.08 = 47,898 | + the 3 waves of 2 adds (≈ 20 s each to clear with 4) | Before the fury (10 min)? |
|---|---|---|---|---|
| 4 × level 20 | 165–215 | 3.7–4.8 min | **≈ 4.5–6 min** | yes |
| 3 × level 20 | 125–160 | 5.0–6.4 min | ≈ 6–7.5 min | yes |
| 2 × level 20 | 85–105 | 7.6–9.4 min | ≈ 9–11 min | at the edge: a strong duo with Berserk and potions may win, most lose |
| 1 × level 20 | ≈ 50 | 16 min | ≈ 18 min | **no**: the fury at 10 min (×2 damage, faster swings) kills a solo player [projected] |

`hpMul 0.08` [decision] puts the party of 4 in "a few minutes" (the user's own wording in the brief). It is a knob in
`content/uniques.json`; the first party kill with the friends is the real measurement (§12).

### 4.3 Her damage and the party's survival

- At `attackMul 1.0` the tank takes ≈ 38 HP/s (scaled from 30 HP/s at 0.8), against 1,398 max HP at level 20 (BALANCE
  §6). A Large HP potion heals 570 with a 1 s cooldown [confirmed: items.json], so the tank drinks about one potion every
  15 s: ≈ 20 potions over 5 minutes (8,000 gold, paid back by the gold groups in §3.4).
- ATTACK02 (21 % of her swings) hits up to 5 players within 4 m: melee players spread around her take it too; a ranged
  player stays outside 4 m. ATTACK03's curse (7 %) reaches 15 m.
- The adds (2 per wave) are the party's real test: a White Tiger alone costs a level-18 player 57 % HP (BALANCE §6).
  Two at a time, with three friends free to peel, is survivable; six would not be.
- Enrage at 20 % (×1.25) lands in the last ≈ 45 s of a party kill: a push, not a wall.

### 4.4 Rewards against the band

- EXP: 451,200 × (1 + 0.1 × 3) = 586,560 for a share-mode party of 4 alone on her, split by level: ≈ 146,600 each at
  equal levels [confirmed: `party.ts` `PARTY_EXP_BONUS` 0.1, pool = exp × (1 + 0.1 × (n − 1))]: about 61 % of level
  19 → 20 (238,878 EXP to level) [confirmed: BALANCE §3 table]. At the cap, EXP is not kept and the SP-EXP becomes
  ≈ 367 SP each (SP-EXP = EXP when `spExp` is absent; 400 SP-EXP per SP). [Fact-check: the doc said ≈ 135,000 and
  ≈ 340 SP.] Not tuned down: one kill per 3–6 h per server is the rarest reward in the game.
- Gear: three degree-3 items wearable at the cap with up to +3, elixirs and a 20 % Seal of Star: the best items in our
  band, at a rate of a few per evening for the whole server.
- Gold ≈ 9,000 per kill, against ≈ 8,000 of potions the tank drinks: a wash in gold alone; the elixirs and the powder
  add ≈ 24,000 if sold (§3.4), which is the reward, not a leak.

---

## 5. Protocol and migration (protocol v1, additive)

### 5.1 `packages/shared/src/protocol.ts` additions

```ts
/** Server → client, world sockets only: a unique monster appeared or was defeated (docs/UNIQUES.md §3.3). */
| { t: 'uniqueNotice'; event: 'appeared' | 'defeated'; mob: string; name: string; area?: string; by?: string; party?: boolean }
```

- `name` is the mob's English name (the client localises by `mob` when it has the code, else shows `name`).
- `area` is absent when the camp has no zone name; `by` and `party` only on `defeated` (`by` = the loot-owner group's
  top-damage member, `party` = that group is a party; absent for a GM kill, which is not announced anyway).
- Validator in `validate.ts`; the mock server (`net/mock.ts`) emits it for `/unique spawn` so the HUD lane can work
  without the real server.
- GM: the `unique` command and its usage string join the GM help list (no protocol change: GM commands are chat).
- Content: `packages/shared/src/content.ts` `UniqueDef` (§5.3) and `MobDef.ride` (§2.2), each with `content-check.ts`
  rules.

### 5.2 Migration 10 (`apps/server/src/db.ts`)

```sql
CREATE TABLE uniques (
  code TEXT PRIMARY KEY,              -- MOB_CH_TIGERWOMAN
  phase TEXT NOT NULL,                -- 'waiting' | 'alive'
  due_at INTEGER NOT NULL DEFAULT 0,  -- ms epoch of the next spawn while waiting
  camp INTEGER,                       -- nest id of the current or last camp
  spawns INTEGER NOT NULL DEFAULT 0,
  last_killer TEXT,
  last_killed_at INTEGER
);
```

One row per unique, written on spawn, death and GM changes only (a few writes per day). The migration number is
whatever is next when the lane merges: today `MIGRATIONS` holds **9** entries (`SCHEMA_VERSION` 9, and the user's
`work/server/game.db` is at `user_version` 9) [confirmed in the fact-check: `pnpm tsx` printing `SCHEMA_VERSION`, and
sqlite on a temp copy of game.db; the doc's "18 … migration 19" was wrong], so this is **migration 10**. The polish
workflow's working tree does not touch `db.ts` [confirmed: `git diff --stat`]; the integration renumbers if another
lane lands one first.

### 5.3 `content/uniques.json` (new, ours) [decision]

```json
{
  "schema": 1,
  "kind": "uniques",
  "uniques": [
    {
      "mob": "MOB_CH_TIGERWOMAN",
      "world": "jangan",
      "camps": "uniqueGroup",
      "respawnMin": [180, 360],
      "firstSpawnMin": [10, 30],
      "restartSpawnMin": [1, 2],
      "tuning": { "hpMul": 0.08, "attackMul": 1.0, "expMul": 1.0 },
      "summons": { "on": true, "perWave": 2, "maxAlive": 4, "variants": ["normal"] },
      "enrage": { "hpPct": 20, "damageMul": 1.25 },
      "fury": { "afterSec": 600, "damageMul": 2.0 },
      "corpseSec": 8,
      "announce": { "appear": true, "defeat": true, "roarRadiusM": 120 },
      "drops": "UNIQUE_TIGERWOMAN"
    }
  ],
  "dropTables": { "UNIQUE_TIGERWOMAN": { "groups": [ "… §3.4 as DropTable groups (rollDrops format) plus a plus-level table; the gear group names a pool rule (degree 3, reqLevel ≤ LEVEL_CAP) resolved at server start …" ] } }
}
```

The summon bands are not in the file: they are the rows' own `aiChance` (80 / 60 / 40), as today.

`camps: "uniqueGroup"` reads the 11 nests from `nests.json` by the mob's group; an explicit list of nest ids is also
accepted (for a later unique). The server validates the file at start (unknown mob, no camps, bad ranges: a startup
error, like the other content files).

---

## 6. Budgets (WAVE_PLAN6 §5 format)

### 6.1 What the wave adds per preset

| Preset | The tiger composite | Notices | The fight |
|---|---|---|---|
| Low (Classic) | on: +3 meshes (no shadows on Low) | banner + chat + sound | boss + ≤ 4 adds |
| Medium (default) | on: +3 draws, +3 shadow casters | as Low | as Low |
| High | as Medium | as Low | as Low |
| Ultra | as Medium | as Low | as Low |

### 6.2 Budgets and honest costs (1080p) [projected unless tagged]

Baselines: the **measured** wave-10r final gate (the wave-10 `budgets.md`, not included in this repository;
dev PC Ryzen 5 9600X + RX 9060 XT, frame p95) [confirmed there]: Medium fields-night 5.1 / 3.9 ms (WebGPU / WebGL2),
crowd (20 mobs) 5.2 / 3.7, crowd + 20 jumping bots 13.4 (repeats 13.0–15.1) / 8.5; High WebGPU plaza 5.2, crowd 7.5,
crowd + 20 bots 17.1–19.3 (High misses 60 fps there; its jump costs nothing, the 20 extra players do). From those, the
measured marginal cost per character on the dev PC [fact-check, derived from the gate's own pairs]: **a mob ≈ 0.08 ms**
(WebGPU Medium; 0.045 WebGL2 Medium; 0.115 WebGPU High), **a player ≈ 0.41 ms** (0.24 WebGL2 Medium; ≈ 0.57 WebGPU
High: a dressed player is ≈ 8 draws plus shadows). The tiger composite is costed as one more mob (3 meshes, 692
vertices, 35 joints [confirmed: sidecar]), ≤ 0.1 ms. High's fields scene was not benched; it is projected as Medium's ×
the measured High / Medium plaza ratio (1.44 WebGPU, 1.18 WebGL2).

[Fact-check: the doc compared the fight with "the 20-mob crowd ≈ 6–8 ms" (WAVE_PLAN6's pre-gate projection) and called
it lighter because it has fewer characters. Players cost ≈ 5× a mob, so 4 players + 5 mobs in the fields (≈ 7 ms) is
heavier than the 20-mob crowd (5.2 ms): the old pass line "fight p95 ≤ the crowd's" would fail by construction. And a
server-wide announcement exists to gather players, so the real worst case is the crowd + bots shape, not 9 characters.]

**Frame p95 on the dev PC, wave 10r gate → the Tiger Girl fight at a camp, WebGPU / WebGL2, ms:**

| Preset | Fields, she is in view, idle | Party of 4 (boss + tiger + ≤ 4 adds) | 8 players | 20 players (the whole server answers the notice) | Pass line |
|---|---|---|---|---|---|
| Low | + ≤ 0.1 | below Medium (Low crowd + 20 bots measured 9.4 ms p95 on WebGPU, I-10R) | below Medium | ≈ 9–10 | pass |
| **Medium (default)** | 5.1 / 3.9 → + ≤ 0.1 | **≈ 7.2 / ≈ 5.1** | ≈ 8.9 / ≈ 6.1 | **≈ 13.8 / ≈ 9.0** (measured shape: 13.0–15.1 / 8.5–9.4) | **G1 < 16.7: pass** (thin, ≈ 3 ms, at 20 players on WebGPU) |
| High | ≈ 7.4 / ≈ 4.6 → + ≤ 0.12 | ≈ 10.4 / ≈ 6.0 | ≈ 12.7 / ≈ 7.2 | **≈ 19.5 / ≈ 10.8: misses 60 fps on WebGPU** (as the measured crowd + 20 bots, 17.1–19.3) | G2 is a plaza / crowd gate; reported, not gated |
| Ultra | as High + SSR | not a default | | | not a default |

| Preset | Draws added (main + shadow) | GPU | Mid desktop (CPU ×1.5) | Laptop / M1 | VRAM | Download |
|---|---|---|---|---|---|---|
| Low | +3 | ≈ 0 | ≈ 0 | ≈ 0 | + ≈ 0.7 MB (the 256×512 texture ships as WebP in the optimised glb [confirmed] and is decoded to RGBA8 + mips [likely]; the doc's "0.1 MB DXT1" was the source format); buffers ≈ 0.05 MB | + 86 KB br on first sight of her (bluetiger.glb.br) [confirmed size]; 0 at start |
| Medium | +3 + 3 | ≤ 0.05 ms | the composite + ≤ 0.15 ms CPU; party of 4 ≈ 11 ms: holds 60; **20 players ≈ 20 ms: misses** | as mid desktop or worse: **20 players misses**, ≤ 8 players ≈ 13 ms holds | as Low | as Low |
| High / Ultra | +3 + 3 | ≤ 0.05 ms | party of 4 ≈ 15–16 ms: at the line | party of 4 misses on a laptop | as Low | as Low |

Honestly:

- **Nothing is added where she is not.** One unique, in the Tiger Mountains, at most one alive. The plaza, the town,
  the beach and the stage are untouched; the composite itself is ≤ 0.1 ms in view.
- **The cost of a world boss is the players it gathers, not the boss.** The announcement brings people to one spot. A
  party of 4 to 8 holds 60 fps on Medium on every target machine. If the whole server (cap ≈ 20) gathers, Medium on
  the dev PC holds (≈ 14 ms WebGPU, ≈ 9 ms WebGL2), High on WebGPU misses, and Medium on a gaming laptop or a base M1
  misses. That is the known cost of 20 player characters (wave-10r gate, BACKLOG item 9: character batching and LOD),
  not a cost this spec adds; nothing in this spec can lower it [projected]. The summon cap (4) keeps the boss's own
  share small; the retail waves (up to 20 tigers per wave) would add ≈ 1.6 ms more on Medium WebGPU.
- **The notices are DOM** (a banner a few times a day): 0 ms in the frame.
- **Server:** the scheduler is O(uniques) per tick (1) and writes the DB a few times a day: ≤ 0.01 ms per tick. Twenty
  players on one boss is the same combat load as any 20-player fight.
- **First sight** [likely]: the tiger's material (skinned, alpha-tested, two-sided, 35 bones) is a new shader and
  pipeline variant, as for any monster type seen the first time; loading it in the same `load()` as the rider puts the
  compile in her own first frame instead of a second hitch.

### 6.3 Per-lane budgets (dev PC, 1080p; GPU timings under the GPU lock)

| Lane | Budget |
|---|---|
| U-RC | the composite: ≤ 0.1 ms CPU p95 per ridden mob in view (seat + mirrored clips), 0 when culled; first sight: the ride glb load ≤ 30 ms main-thread (it shares the loader cache), no frame > 33 ms when she streams in |
| U-S | ≤ 0.01 ms server CPU per tick for the scheduler; a spawn ≤ 1 ms (navmesh place + createMob); summons as the existing path |
| U-H | banner show/hide ≤ 0.2 ms (the existing `NoticeBanner` node per notice) |
| Fight scene (I-11 bench) | at a camp, Medium p95 < 16.7 ms on both backends with **20 bots** + boss + 4 adds, and ≤ 9 ms with 4 bots; High reported (expected to miss 60 fps on WebGPU at 20 bots, like the crowd + bots) |

---

## 7. The prototype

### 7.1 What was built [confirmed]

- `work/tmp/uniques/proto/` (`index.html`, `main.ts`, `vite.config.ts`): a Babylon 9.28 page (the viewer's
  `node_modules`, WebGL2, right-handed like the game) that loads `bluetiger.glb` and `tigerwoman.glb` from `work/out`,
  seats the rider on a node copying the `saddle` joint's world matrix each frame (full or position-only, switchable),
  and plays the same animation type on both, posed deterministically (`renderAt(type, ms)`), with a shot endpoint. Run
  on a private vite at :5196 (stopped afterwards), one browser tab at 1920×1080 (closed).
- `work/tmp/uniques/why-no-tiger.ts`: the Spawner dry run on the real export and navmesh (§1).
- `work/tmp/uniques/dryrun.ts`: the unique scheduler as a pure state machine on the real camps, zone names and navmesh,
  with a restart and the respawn window (§3.2).
- `work/tmp/uniques/glbinfo.py`, `pose.py`: glb mesh bounds and joint world positions per clip and time (the facts in
  §2.1).

### 7.2 Results

- **She sits on the tiger, in sync, in every clip** (`filmstrip_ride.png`: STAND1, WALK, RUN, ATTACK1–3, DIE1, six
  frames each). Probe: the rider's pelvis stays within 0.003 m of the saddle in STAND1, WALK and ATTACK1, and within
  0.12 m in RUN and DIE1 (her own bob and fall, authored) [confirmed: `proto.probe`].
- **ATTACK3 is a leap:** she jumps off the saddle, casts in the air above the tiger and lands back on it. That is
  authored relative to the saddle and works with no special case.
- **DIE1:** the tiger rears and rolls on its side; she is thrown and ends lying on the ground beside it
  (`cmp_die_end.png`). Full transform is required (§2.1).
- **Before / after:** `shots/01_before_after.png` (left, the woman alone as the game draws her; right, on the tiger).

### 7.3 Images (all in `work/tmp/uniques/`)

| File | Shows |
|---|---|
| `shots/01_before_after.png` | today (left) vs fixed (right), STAND1 |
| `shots/02_stand_three_quarter.png` | the fixed model, three-quarter front |
| `filmstrip_ride.png` | 7 clips × 6 frames, both models in sync |
| `tigergirl_ride.gif` | WALK, RUN, ATTACK1, ATTACK3, DIE1 animated (161 frames) |
| `cmp_seat_modes.png` | full transform (left) vs position only (right): RUN and DIE1 |
| `cmp_die_end.png` | the end of DIE1 from two sides |

### 7.4 Limits

- The prototype is not the game's actor code: no PBR, no animation LOD, no blend between clips (it poses frames). The
  blend between base and action clips is the client lane's work and test.
- No in-game shot of today's "floating" look (§1, [unknown]); the prototype's "before" is the same glb with the same clip.
- No GPU timing was taken (no lock needed): the budgets are projections from the wave-10r gate.
- The prototype plays DIE1 to its end; the game removes a corpse after 3 s (§2.3 step 5), which the prototype does not
  model. The fact-check did not re-run the browser prototype: it re-derived the seat, the extents and the death poses
  by skinning the real glbs in numpy (`work/tmp/uniques/factcheck/{seat,extent,skin,die}.py`, on the prototype's
  `pose.py` sampler) and found the prototype's numbers within a few centimetres.

---

## 8. Lanes

### 8.1 Seams first (one agent each, disjoint files)

| Seam | Files | What |
|---|---|---|
| U-P | `packages/shared/src/{protocol,validate,content,content-check}.ts`, `apps/game/src/net/mock.ts` | `uniqueNotice`; `MobDef.ride`; `UniqueDef` and the `uniques.json` checker; the mock's `/unique spawn` |
| U-CV | `packages/convert/src/data/mobs.ts` (+ its test), `packages/convert/src/sound/build.ts` cue table, optionally `data/items.ts` | `MobDef.ride` (§2.2); the two sound cues (the sound export then encodes them); (cut 3) the degree-3 `_RARE` items |
| U-SEAM-S | `apps/server/src/spawner.ts` (`skipUniqueGroups` option **inside `refusal`**, so `updateNest` honours it), `config.ts` (`UNIQUES` on/off), `db.ts` (migration 10), `world.ts` (`Mob.damageMul`, `Mob.corpseMs`), `gameplay.ts` (register the module; `createMob` already takes `tuning`; the kill path: a drop-table override for a mob, drops that carry a `plus`, the loot-owner group handed to the module **before** `m.damage.clear()`, the corpse sweep reading `m.corpseMs ?? CORPSE_MS`), `mob-skills.ts` (a per-mob summon policy hook: on, per-wave clip, cap, variants; `damageMul` where a row's percent is scaled) | the server seams, additive. [Fact-check: the kill-path, damage, corpse and config seams were missing; without them U-S cannot name the killer (the damage map is already empty in the `mobDied` hook), drop +N items, enrage or keep the corpse] |
| U-SEAM-C | `apps/game/src/three/models.ts` (`companion` and `lodLeader` on `CharacterActor`, the companion's suppressed self-resume, composite extents), `apps/game/src/world/entities.ts` (ride load hook; `setYaw` and the root scale on the ride's root) | the client seams |

### 8.2 Lanes (after the seams)

| Lane | Owns | Depends on | Tests |
|---|---|---|---|
| **U-RC** ridden mob | `apps/game/src/world/ride-mob.ts` (new) | U-SEAM-C, U-CV | §2.4 NullEngine tests on the real glbs; a mob without a ride is unchanged (snapshot of the actor's nodes) |
| **U-S** uniques module | `apps/server/src/uniques.ts` (new), `apps/server/src/gm.ts` (the `unique` command row only), `content/uniques.json` (new) | U-P, U-SEAM-S | scheduler: first spawn window, respawn window, restart while waiting (due time kept, overdue → 1–2 min), restart while alive, at most one alive, camp roll uniform over placeable camps, a non-placeable or GM-disabled camp skipped; announce on spawn and kill (solo, party, the loot-owner group named when a solo player out-damages each party member but not the party, GM kill silent, generic `/kill` noticed by the tick); reset on leash (HP, adds, bands, fury); enrage once; fury after 600 s of fight time with a fake clock; summon clip (2 per wave at 80/60/40 %, ≤ 4 alive, normal only); drop table override (field unique only, encounter keeps the normal row; every gear drop's `reqLevel` ≤ `LEVEL_CAP`; plus levels reach the ground item); corpse kept 8 s; `/unique` commands and audit rows; `UNIQUES=off` = today's Spawner behaviour; a `/nest` edit or `content reload nests` never gives the Spawner a unique nest |
| **U-H** notices | `apps/game/src/ui/notice.ts` (a `kind: 'unique'` option on the one `NoticeBanner` queue), `apps/game/src/app.ts` (the `uniqueNotice` case next to `notice`), `apps/game/src/i18n/en-unique.ts` (new), the chat line in `screens/world.ts` | U-P | text keys (an area ending in "." printed as is; party form); a GM notice and a unique notice queue, never overlap; the sound cue names; the banner shows the unique pink and its title |
| **U-Q** quest hook (optional) | `content/quests/jangan.json` (two dialog lines), the `uniqueAlive` fact in the quest engine's condition list | U-S | the line shows only while she lives, with the area |
| **U-BAL** balance pass | `work/tmp/balance/sim.ts` extended with the boss fight (scratch), docs/BALANCE.md §8/§9 update | U-S | the §4.2 table re-derived by the model; then the friends' kill (§12) |

### 8.3 Integration (I-11, the wave's lead)

- Re-convert the data step (mobs.json) and check `ride` on Tiger Girl only; re-run the sound export and check the two
  new cues resolve to encoded files.
- A private server on a temp copy of `work/server/game.db`: `/unique spawn tiger here`, `/unique list`, kill with
  4 bots (the soak harness) and read the notices, the DB row (migration 10 applied) and the drops (all wearable at the
  cap); restart the server in both phases; a generic GM `/kill` on her starts the timer.
- Bench the fight at a camp on Medium and High, both backends, under the GPU lock: 4 bots + boss + 4 adds (Medium
  ≤ 9 ms) and **20 bots** + boss + 4 adds (Medium < 16.7 ms; High reported). The old line "≤ the crowd's p95" is
  dropped (§6.2).
- The scenes of WAVE_PLAN6's LAB list are unaffected (she is not in them); the Tiger corner scene (156.0, 90.0) gains
  her only if she is spawned there.

### 8.4 User checks

1. Open `work/tmp/uniques/tigergirl_ride.gif` and `filmstrip_ride.png`: is this the Tiger Girl you remember?
2. After the build, in game: a GM `/unique spawn tiger here`; walk around her; let her chase you (run), attack, die
   (the death plays to the end: she is thrown and lies beside the tiger before the corpse fades).
3. With friends: wait for (or GM-spawn) the real one; the banner and sound on spawn; a party kill in about 5 minutes;
   the defeat banner with the right name; the drops.

---

## 9. Scope-cut order (cut from the top)

1. U-Q, the rumour dialog lines.
2. `/unique quiet` (GM-local banner mute).
3. The Seal of Star drop and the `_RARE` export (a +4 degree-3 item instead).
4. The enrage line and the enrage itself (the fury stays).
5. The roar for players near the camp.
6. The chat line (the banner and sound stay).
7. Summons for uniques (she fights alone; `hpMul` rises to 0.10 to keep ≈ 5 min).

**Never cut:** the tiger composite with the full saddle transform, its LOD lockstep and the 8 s unique corpse (without
them the fix the user asked for looks broken at a distance or ends mid-fall); one alive, the camps, the 3–6 h window and
its persistence across restarts; the appear and defeat banners with the sound; the fury (no solo kill); the leash reset;
the unique drop table's gold, gear wearable at the cap and elixirs; Medium at 60 fps (G1).

---

## 10. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| The client actor's clip blending (cross-fade between base and action) makes the two models drift by a frame or two at transitions | medium | the companion is driven by the same calls in the same frame, with the same blend speed; the §2.4 test checks the clip names after each call; a drift of one blend window is invisible at her size [likely] |
| Animation LOD skips the tiger's and the rider's pose updates on different frames (the existing carrier rule only covers a `lodFull` rider, the player's own character) | high without the seam [confirmed: `models.ts lodActors`] | the `lodLeader` seam (§2.3 step 2): the rider copies the ride's skip decision; a §2.4 test runs 300 far frames |
| The death is cut mid-fall (corpse removed at 3 s, DIE1 is 5.5 s) | certain without the seam [confirmed: `CORPSE_MS`] | `corpseSec` 8 for uniques (§2.3 step 5) |
| The whole server answers the notice and 20 players fight her: Medium on a gaming laptop or an M1 and High on WebGPU drop under 60 fps | medium (cap ≈ 20; friends are usually 4–8) | nothing this spec can lower (it is the cost of 20 player characters, BACKLOG item 9); the I-11 bench measures it with 20 bots and reports it (§6.2) |
| The field boss rolls camp 5906, the Binding Bell's shrine: a quest party may meet the world boss and its own private Tiger Girl at once | low (1 camp in 11, while a party is on the last step) | accepted: both are killable and either counts for JG_025; the module does not exclude the camp (retail has it) [decision] |
| Fury griefing: someone tags her and stays near, so the fury clock (first damage since the last reset) runs before the real party arrives | low (a friends server) | she resets as soon as no attacker is within the leash, which clears the clock; a GM `/unique despawn` + `timer` covers abuse |
| Summoned adds give their normal EXP and loot, and a reset re-arms the bands: a party could pull her to 40 %, leash-reset her and repeat for 6 adds per cycle | low (≈ 2,500 EXP per cycle, less than the tigers nearby) | accepted; the adds despawn on reset (§3.6) |
| The 4-player kill takes much longer or shorter than §4 projects | medium | `hpMul` is content; the friends' first kill is the measurement; BALANCE gets the number |
| Players pull her into the level-16 grounds or toward town | low | the 50 m leash from her camp; the camps are ≥ 1 km from town |
| A restart storm (deploys) spawns her repeatedly | low | the alive-at-restart rule brings her back once with full HP at a new camp; a waiting timer is kept |
| The polish workflow edits `gameplay.ts`, `mob-skills.ts`, `models.ts`, `entities.ts` or adds a migration | medium | every seam is additive and re-read at merge time (WAVE_PLAN6's rule); at fact-check time its working tree touches none of `gameplay.ts`, `mob-skills.ts`, `spawner.ts`, `db.ts`, `models.ts`, `entities.ts`, `app.ts`, `ui/notice.ts` [confirmed: `git status`] |
| The sound files are wrong for the moment | medium | two cue names; the user judges by ear, the files swap in the cue table |

---

## 11. Decisions (each with its reason)

- **D-U1** The tiger is retail's `bluetiger.bsr`, linked by characterInfo `ride`: it is the only link in the data and the
  clips match it frame for frame.
- **D-U2** The rider sits on the `saddle` joint with its full world transform: position-only puts her upright on a
  leaning tiger and through the dead tiger's flank.
- **D-U3** Clips pair by animation type, each looping at its own length, a one-shot holding its last frame: the woman's
  pose is relative to the saddle, so the mismatched idles look right and nothing needs re-timing.
- **D-U4** The converter puts `ride {model, joint}` on the `MobDef` in `mobs.json`, beside `championModel`: the actor
  loader reads the mob catalog, not the fx index, and the shared `ModelRef` stays untouched.
- **D-U5** The composite lives in a new client file with a `companion` seam on `CharacterActor`: one owner, and the
  horse `RideLink` stays as it is.
- **D-U6** A new server module owns unique groups; the Spawner skips them: one owner per piece of state.
- **D-U7** Tiger Girl only: the other field uniques up to level 45 live in places we do not have.
- **D-U8** Respawn 3–6 h, first spawn 10–30 min, restarts keep the timer: retail's window, and no free boss from a
  restart.
- **D-U9** State in SQLite (migration 10, the next after today's 9): survives restarts and backups with the characters.
- **D-U10** A typed `uniqueNotice`, not the GM `notice`: localised text, its own style and sound.
- **D-U11** The defeat notice names the loot-owner group (its top-damage member, and "'s party" for a party): exactly the
  group that owns the drops, so the banner and the loot never disagree.
- **D-U12** Sounds `alarm_sound.wav` (appear) and `eventcomplete.wav` (defeat): retail UI sounds that fit; the user
  judges.
- **D-U13** No world-map marker; the minimap's unique sign in range: finding her is the hunt.
- **D-U14** HP ×0.08 (47,898), attack ×1, EXP ×1: a party of 4 in ≈ 5 min, the reward stays rare and big.
- **D-U15** Summons on for uniques only, 2 normal tigers per wave at the rows' own 80/60/40 % bands, ≤ 4 alive: the
  retail waves would wipe our band, and the bands are retail's (their row names) and already what the code reads.
- **D-U16** An enrage at 20 % (damage ×1.25) and a fury at 10 min (damage ×2), both through one per-mob damage
  multiplier: the user asked for an enrage; the fury makes a solo kill impossible without hurting a party; interval and
  cooldown changes are dropped because the clip lengths bound the swings anyway.
- **D-U17** Our own unique drop table (gold, three +0–+3 degree-3 items wearable at the level cap, elixirs, Lucky
  Powder, potions, 20 % Seal of Star): the port's table is a normal mob's, and an item nobody can wear is no reward.
- **D-U18** Loot and EXP use today's rules (top-damage group owns the loot; party share modes; damage shares): already
  built and tested.
- **D-U19** The quest's bell encounter stays separate and silent; the field unique also counts for JG_025: the questline
  never waits for a world boss.
- **D-U20** GM `/unique list|spawn|kill|despawn|timer|quiet`: everything a test or an event needs; the generic `/kill`
  on her is noticed by the module's tick.
- **D-U21** A unique's corpse stays 8 s (not 3 s): her 5.5 s death plays out and ends with her on the ground beside the
  tiger, the picture the user asked for.
- **D-U22** The rider follows the ride's animation-LOD decision (`lodLeader`): the existing carrier rule only covers the
  player's own character, and two independent LOD clocks would desync the pair at a distance.
- **D-U23** The unique notice goes through the existing `NoticeBanner` queue with its own style: one queue, so it never
  overlaps a GM notice.

## 12. Needs from the user (each with the default used if there is no answer)

1. **The look:** `work/tmp/uniques/tigergirl_ride.gif`. Default: build it as shown.
2. **The notice sounds** by ear after the build (`alarm_sound.wav` on appear, `eventcomplete.wav` on defeat). Default:
   those two.
3. **One party kill with friends** after the build, to set `hpMul` (default 0.08, ≈ 5 minutes for 4).

## 13. Open questions (each has a default, so nobody waits)

| # | Question | Default |
|---|---|---|
| Q1 | Should the defeat notice name the last hitter instead of the loot-owner group? | the loot-owner group (it owns the drops) |
| Q2 | Should a player who logs in while she is alive be told? | no (retail has no replay) |
| Q3 | Add a second boss by re-homing Cerberus (24) into the Jangan fields? | no |
| Q4 | Announce the bell encounter's Tiger Girl too? | no (it is a private story fight) |
| Q5 | Are uniques immune to stun and knockdown? | no immunity (as any mob) until a retail source says otherwise |
| Q6 | Respawn window shorter for a small private server (e.g. 1–2 h)? | retail 3–6 h; a GM `/unique timer` covers events |
| Q7 | Keep camp 5906 (the Binding Bell's shrine) in the roll, where the world boss and a quest party's private Tiger Girl can meet? | keep it (retail has it; either kill counts for JG_025) |

---

## Appendix A: scratch files (`work/tmp/uniques/`)

| File | Purpose |
|---|---|
| `proto/index.html`, `proto/main.ts`, `proto/vite.config.ts` | the ride prototype (§7) |
| `why-no-tiger.ts` | the Spawner dry run on the real export and navmesh (§1) |
| `dryrun.ts` | the unique scheduler dry run (§3.2) |
| `glbinfo.py`, `pose.py` | glb bounds and per-clip joint positions (§2.1) |
| `shots/` | raw frames (1920×1080 and the GIF's 768×432) |
| `filmstrip_ride.png`, `tigergirl_ride.gif`, `cmp_seat_modes.png`, `cmp_die_end.png` | the images in §7.3 |
| `factcheck/seat.py`, `extent.py`, `skin.py`, `die.py` | the fact-check: saddle heights and pitch per clip, joint extents, numpy-skinned composite extents (label, cull), the DIE1 poses at the corpse removal |
| `factcheck/budgets_section.md` | the source of §6.2 as rewritten by the fact-check |

## Appendix B: fact-check (2026-10-01)

Every [confirmed] claim was re-derived from the code at `f56d175` plus the polish working tree, the data in `work/out`,
the extracted client files and Babylon 9.28's source; the two dry runs (`why-no-tiger.ts`, `dryrun.ts`) were re-run
(all 11 camps place at `MOB_LEVEL_MAX` 25 and 0; the same timeline). Nothing outside this doc and
`work/tmp/uniques/factcheck/` was written; no server, browser or GPU run was needed (the budgets are re-projected from
the measured wave-10r gate).

**Corrected in place:**

| # | Was | Is | How it was checked |
|---|---|---|---|
| F1 | migration 19 ("the list holds 18") | **migration 10** (9 today) | `SCHEMA_VERSION` printed with `pnpm tsx`; `user_version` 9 on a temp copy of game.db |
| F2 | label ≈ 4.0 m, test ≥ 3.8 m | ≈ 3.0 m (rider top 2.59–2.94 m in STAND1), test 2.8–3.4 m | numpy skinning of both glbs (`factcheck/skin.py`) |
| F3 | DIE1 ends with her beside the tiger | true only if the corpse lives ≥ 5.5 s; it is removed at 3 s (+0.9 s fade): mid-fall. Unique corpse 8 s added | `CORPSE_MS`, `FADE_S`; `factcheck/die.py` |
| F4 | the horse's every-frame path makes LOD skip "both or neither" | it only covers a `lodFull` rider (the player); a `lodLeader` seam added | `ModelLibrary.lodActors`, `CharacterActor.lodTick` |
| F5 | the mirrored calls | + `hurt`, `die`, `revive`, `cancelAction`; `setYaw` and root scale redirected to the ride; the companion never self-resumes | `models.ts`, `entities.ts` call sites |
| F6 | `MobModel.ride` | `MobDef.ride {model: ModelRef, joint}` (no `MobModel` type; `ModelRef` is shared) | `packages/shared/src/content.ts` |
| F7 | gear B 60 % / C 40 % | only items with `reqLevel` ≤ `LEVEL_CAP` (grade C needs 21–26) | items.json `reqLevel` by grade |
| F8 | summon bands 80/55/30 (the port's) | 80/60/40: the rows' `aiChance`, what the code reads, and retail's own row names | skilleffect.txt cp949 names; `mob-skills.ts`; the port's comment calls its bands interim |
| F9 | defeat names "the top-damage dealer" = the loot rule | names the loot-owner group (they differ when a solo player out-damages each party member); the kill path must pass it before `m.damage.clear()` | `gameplay.ts` kill path; `soloShares` / `killShares` |
| F10 | fury "attack interval ×0.75", enrage "ATTACK03 cooldown ½" | damage only; the swing is bounded by the clip | `mob-skills.ts use()` `nextSwingAt` |
| F11 | `DamagePos` 3 m back, on the flank; the drop ring centred on it | 3 m **forward** (Z mirrored): the tiger's head; the drop ring stays on the root (2.5–4 m) | `anchors.ts dmToMetres`; the server has no characterInfo |
| F12 | fight "lighter than the 20-mob crowd", ≈ 6–8 ms Medium; pass line "≤ crowd" | players cost ≈ 5× a mob: party of 4 ≈ 7.2 / 5.1 ms, 20 players ≈ 13.8 / 9.0 ms Medium, ≈ 19.5 ms High WebGPU (misses); bench with 20 bots | the wave-10r gate's measured pairs |
| F13 | VRAM ≈ 0.1 MB (DXT1) | ≈ 0.7 MB (WebP → RGBA8) | the optimised glb's image entry |
| F14 | EXP ≈ 135,000 each, ≈ 340 SP | ≈ 146,600 each (×1.3 party pool / 4), ≈ 367 SP | `party.ts` `PARTY_EXP_BONUS` |
| F15 | saddle "RUN up to 2.87 m, pitched about 23°"; "only DAMAGE1 and DIE1_RM move the pelvis" | RUN 2.45–3.18 m, −23° to +11°; RUN, DAMAGE1, ATTACK3 (the leap) and DIE1 move it | `factcheck/seat.py` |
| F16 | the area's trailing "." stripped | printed as is (it ends the sentence) | the text keys |
| F17 | a separate unique banner | the existing `NoticeBanner` queue with a unique style (no overlap with GM notices) | `ui/notice.ts`, `app.ts` |
| F18 | the Spawner "skips" unique nests (an option) | the skip lives in `Spawner.refusal`, so `/nest` and `content reload nests` keep it; camps re-read per roll; a generic `/kill` noticed by the tick | `spawner.ts updateNest`; `editors/live.ts`; `gm.ts kill` |
| F19 | the sound cues only | the sound export must also encode the two wavs | `work/out/sound/index.json`; `sound/encode.ts` |
| F20 | (new facts) | the tiger's strides equal her walk / run speeds; its STUN clip is a retail typo; the bell's shrine is camp 5906; Uruchi and three others also have characterInfo rides | sidecars; the BSR strings; jangan.json; skilleffect.txt |

**Re-confirmed as written:** skilleffect.txt line 298 and its columns; `bluetiger` referenced nowhere else but its own
files; `skilleffect.ts` parsing `ride`; `bluetiger.glb` on `output.ts`'s extra list and 86,312 bytes br; the client's
only reader of `ride` (`anchors.ts`); Tiger Girl's mobs.json row (level 20, HP 598,720, attack 181–217, PD 42 / MD 51,
radius 2.8, run 9, EXP 451,200); 7 meshes / 1,487 vertices / 69 joints / 14 clips and 3 meshes / 692 vertices / 35
joints / 13 clips; the clip lengths in §2.1; the hit events; her 11 nests (ids, respawn 10,800–21,600 s, sight 14 m,
leash 50 m); the three zone names; the in-memory group timer; ATTACK01–03 and SUMMON01–04 rows; summons off (cap 6);
the encounter's tuning; the Berserk unique fill; the minimap and target-window unique art; the GM `notice` as the only
broadcast; the drop table being a normal mob's; `VARIANT_RULES.unique` ×1; `ai.ts goHome` clearing the damage table;
Babylon 9.28's render order; the HP ×0.08 arithmetic and the §4.2 time-to-kill table; items (Large HP 570 HP, 1 s
cooldown; the four elixirs; Lucky Powder (3rd)); the `_RARE` rows in the retail itemdata and not in items.json; the
two wav files.
