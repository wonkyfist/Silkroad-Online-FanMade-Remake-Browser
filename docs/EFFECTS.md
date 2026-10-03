# Animations and effects spec (vSRO 1.188, Jangan, level cap 20)

This spec covers everything the retail client animates or decorates with an effect, and how our client does it
today: skill clips and effect stages (every Chinese line of `skills.json` and the basic attacks), hits, statuses,
buffs, mob attacks, spawn and death, gold and item drops, pickups, consumables, level-up, idle and emote clips, the
target circle, world ambient effects, and the visual hooks of the new systems (Berserk, alchemy, horses, stalls).
It ends with a build plan.

It is a spec, not code. It builds on docs/SKILLS.md §5-§7 (timing model, clip resolution, skilleffect columns) and
does not repeat them. Protocol additions follow docs/PROTOCOL.md: additive, optional fields, CodeName128 ids, the
server decides and the client presents.

## Status tags

- **[confirmed]**: read from the 1.188 files (`work/extracted`, the pk2s through `pnpm sro`) or from our code at the
  cited line, in this session.
- **[likely]**: the data points this way and nothing contradicts it, but no capture of the retail client proves it.
- **[unknown]**: not settled by the data. The spec picks a default ("our rule") and names how to settle it.

## Sources

| Tag | Source | What it gives |
|---|---|---|
| SE | `Media.pk2 server_dep/silkroad/textdata/skilleffect.txt` (UTF-16LE, 9,082 lines; the exporter's source) | `#section characterInfo` (l.1-1394), `skillaniset2` (l.1395), `skilleffectset` (l.3890) |
| SE-R | `Media.pk2 resinfo/skilleffect.txt` (CP949, 5,244 lines) | Same sections plus `#section light` (LIGHT_1..8). Older and shorter; the SYSTEM_* rows checked here are identical in both [confirmed]. Which one the 1.188 client reads is [unknown]; we keep SE and take `light` from SE-R |
| BSR | `Data.pk2 res/**.bsr` mod palettes (`packages/formats/src/bsr.ts` `modPalette`) | Effects bound to a model: `systemSets` by name (`ambient`, `status_bad_burn`, `system_appear`, ...) and `aniSets` bound to a clip, each with particles `{efp, bone, position, birthTimeMs, night}` |
| ITEM | `itemdata_*.txt` col 52 AssocFileObj128, col 53 AssocFileDrop128 | Ground model of every item (already exported as `ItemDef.dropModel`) |
| OPT | `Media.pk2 resinfo/itemoptionefp.txt` (1,316 rows), `itemrare.txt`, `itemoption.txt` | Enhancement (+N) and Seal-of-Star glows on weapons/shields |
| UI | `Media.pk2 interface/hitcount/*.ddj` (52 files [confirmed, fact-check]), `effect/select_01..04.ddj` (128×128) | Damage number sprites, selection circles |
| PRT | `Particles.pk2` (2,086 `.efp`; 2,079 of them compiled to `work/out/fx/efp/*.json` by `export-fx.ts` [confirmed count]) | Programs, textures (`textures/mirage_texture_*.ddj` weapon trails are **not** exported) |
| CODE | `apps/game/src/**`, `packages/fx/**` at commit 3937b5e, line numbers re-read in the **working tree** on 2026-09-28 (other lanes are editing `entities.ts`, `models.ts`, `screens/world.ts`, `gameplay.ts`; anchor every hook by its symbol, the numbers drift) | Today's behaviour |

Reference images kept for the build lanes (scratch, `work/tmp/effects/`):
`select_01.png` (white) `select_02.png` (green) `select_03.png` (blue) `select_04.png` (orange) selection circles;
`hitsheet.png` (hitcount_1, hitcount_enemy_1, hitcount_player_1, critical, critical_enemy, miss_enemy, miss_player,
blocking_enemy); `mirage_sheet.png` (trail textures normal, smash, chain, knockdown, cold, fire, lightning).

No source code was copied. GPL/unlicensed tools were not consulted for this spec.

---

## 0. Summary: what is wrong today, by how much it shows

| # | Gap | Where | Size |
|---|---|---|---|
| 1 | No weapon trails ("mirage"): every melee swing, skill and imbued hit in retail leaves a textured afterimage | `skill-fx.ts` has none; the weapon's `ai_start`/`ai_end` bones are dropped by the converter | Very visible, every fight |
| 2 | Ground items are placeholder cylinders/boxes with a light beam, spinning and bobbing; retail uses per-category drop models (`drop_ch_money_small/normal/large`, `drop_ch_equip`, `drop_ch_bag`, ...) with their own sparkle `.efp` and a toss clip | `world/drops.ts` | Very visible; the glbs are already exported and unused |
| 3 | Mob attacks show no spark, no blood, no projectile and the wrong clip (ATTACK1..n cycled, not the skill's clip) | `entities.ts:385` (`EntityView.attack`), `features/skills.ts:379` (mob `combat` carries no `skill`) | Every hit taken |
| 4 | Level-up, potions, return scroll, spawn use procedural or no effects; retail has `system_levelup.efp`, `item_hpotion.efp`, `item_returnscroll*.efp`, `system_apear.efp` | `effects.ts:81`, nothing for the rest | Visible |
| 5 | Damage numbers are DOM text; retail uses `hitcount_*` sprites (white/red digits, "Critical", "miss", "Block") | `hud/effects.ts` | Visible |
| 6 | Target ring is a torus + disc; retail projects `select_0N.ddj` on the ground | `effects.ts:132` | Visible |
| 7 | Skill-specific stage gaps: nocked arrow, arrow model and arrow force glow, White Hawk, DefenseEfp on shield buffs, heal/cure/resurrect target effect, force casts hiding the weapon, duplicated caster rows on AoE, hit points inside big bodies | `skill-fx.ts` (§2.4 M2-M10) | Per skill |
| 8 | No blood (`hit_2_redblood/greenblood/stone`), no hit light flash, no block effect or DEFENCE clip | §3.1 | Every hit |
| 9 | Idle is STAND1 forever: no NPC STAND2 variants, no combat stance (ATTREADY), no sit, no emotes, no pickup clip | `entities.ts:465` and `:513` (literal `play('STAND1')`), `models.ts:51` | Town feel |
| 10 | Status visuals on mobs use the player files and guessed anchors; retail binds them per mob model (BSR sets) | `skill-fx.ts:90` | Small |
| 11 | World objects' effects (torches, night lamps, the blacksmith's chimney smoke, waterfalls, portal stones) are not drawn | `packages/world-render` | Town feel |

The skill **clips** themselves are right: every one of the 34 active Chinese lines plus the 3 weapon basic attacks
resolves to the retail clip on both genders (§2.3), and the phase timing matches SKILLS.md §5.1 [confirmed].

---

## 1. How the retail client drives animation and effects

### 1.1 Three data paths

1. **skilleffect.txt** (SE) drives anything that is an action: skills, basic attacks, mob attacks, and the
   `SYSTEM_*` pseudo-skills (level-up, potions, return scroll, appear, Berserk, quest marks) [confirmed: the SYSTEM rows
   are in SE l.3310-3330 and l.8205+].
2. **The model's BSR mod palette** drives what belongs to a model: a drop's sparkle (`ambient` set), a mob's status
   visuals (sets named `status_bad_burn`, `status_bad_eshock`, `status_bad_frostbite`, `status_bad_icing_on/off`,
   `status_bad_poison`, `system_appear`), clip-timed particles (the pipe smoke `npc/npc_chinasystem_shaman_pipesmoke.efp`:
   the shaman on `Bone09` at 3,206 ms of STAND2, the kisaeng2/kisaeng6 NPCs on `Bone01` at 2,240 / 2,732 ms of
   STAND2; each also has an ATTREADY-bound copy, a clip these NPCs do not export), and world objects' fires and lamps
   (`night` flag = `bytes[1]`) [confirmed: §3, fact-check re-parsed the BSRs].
3. **resinfo tables** drive item glows: `itemoptionefp.txt` (enhancement), `itemrare.txt` (Seal items) [confirmed].

### 1.2 skilleffect columns our export drops

`packages/convert/src/fx/skills.ts` exports the columns listed in SKILLS.md §7.1 [confirmed]. These are dropped and
this spec needs them:

**skillaniset2** (0-based columns; header row l.1396):

| Col | Name | Values on our rows | Meaning | Tag |
|---|---|---|---|---|
| 3 | Priority | 0; 2 on the three imbues | A higher-priority trail/DamageEfp replaces the basic attack's while it is active (imbue trail over the weapon trail) | likely |
| 5 | Hide Weapon | 1 on **12** groups ≤ cap [confirmed, fact-check]: Weak Guard of Ice, Cold wave - Arrest, Crystal Wall, Snow Shield, Must - Piercing Force, Shock Lion Shout, Flame body, Basic Fire protection and the 4 Water skills. 0 on Fire Shield, Grass Walk, the imbues and every weapon line | Weapon (and shield) meshes hidden for the action | confirmed data, likely meaning |
| 15 | Trail length | 80 sword basic, 120 spear basic and weapon skills, 160 imbues, 0 none | Afterimage lifetime in ms | unknown unit (ms is our rule) |
| 16 | Trail colour ARGB | `64,255,255,255` sword basic, `100,…` spear basic, `150,…` chain, `200,…` skills, `200,255,128,0` fire imbue | Multiplies the texture | likely |
| 17 | Trail op | `ONE` on player rows and the bandit-archer MSKILL rows; `INVSRCALPHA` on the other Jangan MSKILL rows (all of which have length 0, so no trail) [confirmed] | Additive / alpha blend | likely |
| 18 | Trail texture | `mirage_texture_{normal,smash,chain,knockdown,cold,fire,lightning,hwan}.ddj` | Particles `textures/`; U = age (fresh at u=0), V = blade (tip at v=0) (see `mirage_sheet.png`) | confirmed files, likely layout |
| 22 | Light effect | `LIGHT_1` basic attacks; `LIGHT_2..6` skills; `none` on Weak Guard, Crystal Wall, Must - Piercing, Grass Walk, the Fire buffs, White Hawk and the Water skills | A point light at the hit: SE-R `#section light` (l.715-724): `LIGHT_n TYPE POINT ARGB TIME RANGE ATTEN` (all 300 ms, range 1000, att 0.2; colours 1 white, 2 purple 83,11,79, 3 green 28,255,28, 4 red 255,28,28, 5 yellow-green 163,255,44, 6 yellow, 7 blue, 8 orange) [confirmed rows]. RANGE unit [unknown]: 1000 file units = 100 m by the decimetre rule, too large for a hit flash; our rule 10 m | likely |
| 23 | Skill Object | `none` on our rows; `res\etc\capture_trap.bsr` on SYSTEM_TRAP | A model placed by the skill | confirmed |
| 24 | Waist twist | `Roll` bow shots and the mob archers; `Yaw` Cold wave - Arrest | The spine turns toward the target | likely |
| 25 | Is attack skill | 1 attacks | — | confirmed |
| 26 | Bleeds | 1 on every row | Landed hits play the victim's BloodType effect | likely |

**skilleffectset** (header l.3891). Counts are over the 987 **uncommented** `SKILL_CH_*` rows, all levels and
masteries [confirmed, fact-check]. SE also holds `//`-commented rows whose group sits in col 1 (e.g. a dead
`SKILL_CH_SPEAR_SPIN_A ACT_L spear_spin_keep_a.efp` at l.4131): every parser must skip lines starting with `//`
(the v1 exporter does), or counts and stages go wrong.

| Col | Name | Values seen on Chinese rows (count) | Meaning | Tag |
|---|---|---|---|---|
| 5 | DamageType | `NOR\|CRI\|HWAN` (one cell) on DMG rows, `none` otherwise | Which hit outcomes the row plays for; every row ≤ cap plays for all | confirmed |
| 6 | Scale | `none` (players), `MOB_BASE` (mob rows, quest marks), `CHAR_BASE` (Berserk; also the Tiger Girl howl row) | Effect scaled by the carrier: MOB_BASE = characterInfo Size / 2 [unknown divisor; our rule: `clamp(size/2, 0.7, 2.5)`] | likely |
| 7 | ID | 0 (696), 1 (281), 2 (10) | Loop identity; `Kill` and `Trade` refer to it | likely |
| 8 | Attach | 0 on every row | — | confirmed |
| 9 | Trade | 1 on 12 flight rows (and mob archer/tombstone/yeoha flights) | The flight takes over the looping row with the same ID (the nocked arrow leaves the hand; the charged orb flies) | likely |
| 10 | Kill | 0 (878), 1 (104), 2 (5) | Playing the row ends the caster's live rows with ID = Kill | likely |
| 11 | CreateCnt | 1 (981); 2-5 on 6 rows | [unknown]; ignored | — |
| 12 | Fade | `0,0` (825), `500,500` (55), `10,500` (25), `500,0` (17), `300,300` (15), `200,0` (14), `30,30` (12), `300,0` (12), `0,-1` (12) | Fade-in, fade-out ms of the row's instance; `-1` = keep until it ends by itself | likely |
| 15 | Param | `0,0,0`; `40,0,0` (31), `60,0,0` (5), `100,0,0` (6), `50,0,0` (1) on flight rows | Param[0] = arc height of MOV_UPR in dm | likely |
| 16 | Act Option | `false,0,0,0,0,false` (969); `true,…` on 18 rows, **none ≤ cap**: 15 SHOT Kill rows of Cold `BINGPAN_A..E` (`true,<deg>,50,10,3000,true` and variants) and 3 rows of `LIGHTNING_GYEONGGONG_B/D` (`true,0,0,10,1000,false`) | [unknown]; ignored | confirmed data |
| 19 | StartBone `*` | quest marks and capture mark (`0,5,0`), helper mark (`0,13,0`), guild war mark (`0,16,0`) | "Above the head": the model top + offset | likely |

**characterInfo** (not exported at all; cols 0-12): `ResourceFileID` (CodeName128), `ResourceTypeName`, `Size` (m),
`Ride Type`, `ride` (model a mob sits on: Tiger Girl `res\mob\china\bluetiger.bsr`), `Die Bsr` (model swapped in at
death: Mangnyang `res\mob\common\mangnyang_die.bsr`, Tombstone `res\mob\common\tombstone_die.bsr`), `Die Effect`,
`DamageBone`, `DamagePos` (dm, model-local), `BloodType` (`hit_2_redblood`, `hit_2_greenblood`, `hit_2_stone`,
`hit_2_ice`, ...), `Dead Effect`, env flag, ranged-target offset [confirmed columns and rows].

Jangan rows [confirmed]:

| Code | Size | DamagePos | BloodType | Die Bsr / ride |
|---|---|---|---|---|
| every `CHAR_CH_*` (26 rows) | 2 | 0,13,-2 | hit_2_redblood | — |
| NPCs (`NPC_CH_*`) | 0.7-3.8 | 0,13,-2 | none, except 7 fortress/quest NPCs (`NPC_CH_FORTRESS_*`, `NPC_CH_QT_FLAMEMASTER(_COS)`): hit_2_redblood | — |
| MOB_CH_MANGNYANG | 1.5 | 0,10,-6 | redblood | mangnyang_die.bsr |
| MOB_CH_BIGEYEGHOST(_CLON) | 1.6 | 0,9.1,-5 | greenblood | — |
| MOB_CH_GYO(_CLON) | 1.2 | 0,9.1,-6.8 | redblood | — |
| MOB_CH_WATERGHOST(_CLON) | 1.3 | 0,10,-7 | greenblood | — |
| MOB_CH_STONEGHOST(_CLON) | 1.5 | 0,11,-7 | stone | — |
| MOB_CH_TOMBSTONE(_CLON) | 3 | 0,14,-5 | stone | tombstone_die.bsr |
| MOB_CH_YEOHA(_CLON) | 2.1 | 0,10,-6 | redblood | — |
| MOB_CH_BANDIT(_CLON), BANDITARCHER(_CLON) | 1.7 / 1.8 | 0,10,-4 | redblood | — |
| MOB_CH_TIGER(_CLON), WHITETIGER(_CLON) | 1.5 | 0,11,-13 | redblood | — |
| MOB_CH_CHAKJI(_CLON) | 2 | 0,13,-5.5 | greenblood | — |
| MOB_CH_TIGERWOMAN | 2.8 | 0,15,-30 | redblood | ride bluetiger.bsr |

### 1.3 Coordinates [confirmed rule, likely handedness]

Offsets are decimetres in the model's own frame: `(x, y, z)` → glTF metres `(0.1x, 0.1y, −0.1z)`, so a negative z is
in front (`parseOffset`, `skill-fx.ts:113`). Strike Smash's slash at `0,10,-13` sits 1.0 m up, 1.3 m in front
[likely: matches the swing]. The force "assist motion" circles at `0,0,4` land 0.4 m **behind** the caster by this
rule [unknown: verify in the lab, §2.5]. DamagePos uses the same frame, rotated by the **victim's** yaw.
Offsets scale with the carrier's root scale (players' Height) [likely].

---

## 2. Skills

### 2.1 The model (SKILLS.md §5-§7, plus what this spec adds)

- **Clips**: aniGroup (SWORD/SPEAR/BOW/DEFAULT) then `default`; READY for `preparingMs`, WAIT looped for `castMs`,
  SHOT for `actionMs` (or cast + action without a prepare) [confirmed; `skills-view.ts:89` implements it].
- **Stage start** = phase start + the clip's N-th type-1 event (`startEvent`), 0 = phase start [confirmed].
- **Anchors by ActType** (retail rule, our reading):

| ActType | Where | Follows | Tag |
|---|---|---|---|
| `AT_ONE_FOLLOW` | caster root or StartBone, + StartOffset in caster-local | the bone position every tick; rotation = caster facing rolled by col 24 / `SCT_RUT` | likely (rotation from the bone itself: unknown) |
| `AT_LOOP` | same | same; lives until its phase ends, a Kill row with its ID plays, a Trade flight takes it, or (ACT_L) the buff ends | likely |
| `AT_DMG_POS` | the victim's DamagePos (characterInfo), + StartOffset in attacker-facing frame | fixed where it started | likely |
| `AT_TARGET` | the target's root + StartOffset; with a MOV_* it falls from StartOffset to TargetOffset | fixed | likely |
| `AT_MOV_1TAR` / `SPLASH` / `OPTION` | flies from StartBone (+offset) to the target root + TargetOffset at MovTypeSpeed dm/s after `delay`; MOV_UPR arcs Param[0] dm; MOV_PIERCE continues past the target to max range | position; SCT_ARROW = oriented along the flight | likely |
| `AT_SOURCE` | the caster's root (capture rows) | fixed | likely |

- **DMG rows** play at the moment their hit shows (the ActionPlayer's cue time), not with their phase [confirmed code,
  likely retail]. A DMG row anchored on the **caster** (FOLLOW/LOOP) plays **once per cast and cue**, not once per
  victim [our rule, see M8]. A DMG row anchored on the victim plays on every victim of the cue (AoE) [likely].
- **Per hit, in this order** (retail feel, our rule for the order): DMG rows → DamageEfp spark at DamagePos →
  BloodType effect at DamagePos (landed hits, `bleeds` = 1) → LIGHT_n flash → victim reaction clip → number.
- **Trail**: while an attack's SHOT phase plays (basic attacks: the whole ATTACKn clip), the weapon leaves an
  afterimage between its `ai_start` and `ai_end` dummies (§2.6).

### 2.2 Per line: retail clips and stages

The "Row" of the basic-attack table is the skilldata code the server sends (`*_BASE_01`, `SKILL_PUNCH_01`); the
skillaniset2 row is keyed by its Basic_Group (`SKILL_CH_SWORD_BASE`, `SKILL_CH_SPEAR_BASE`, `SKILL_CH_BOW_BASE`,
`SKILL_PUNCH`, SE l.1405-1408) [confirmed].
Clip names are the slim-pack names the game resolves (`CharacterActor.skillClip`, `models.ts:770`). "ev" lists the clip's sorted type-1
event times; stage "@eN" = at event N, "@0" = phase start. Offsets raw (dm, §1.3). `DMG` = a DMG-event row.
Effects are Particles keys (`skill/china/…`, `hiteffect/…`). Every row below is [confirmed] from SE and the sidecars
unless tagged. "Today" names the mismatch ids of §2.4.

**Basic attacks**

| Weapon | Row | Clips (per family) | Cadence | DamageEfp | Trail | Light / twist | Today |
|---|---|---|---|---|---|---|---|
| Sword, blade | SKILL_CH_SWORD_BASE_01 | `ATTACK1..4_sword_base_0N` 1,133 ms, ev ~200 / ~566 (2 hits) | 1,200 | hit_3_normal | 80, `64,255,255,255`, normal | LIGHT_1 | M1 M9 M11 M12 |
| Spear, glaive | SKILL_CH_SPEAR_BASE_01 | `ATTACK1..4_skill_ch_spear_base_a..d` 1,133-1,166, ev 338/352/299/549 | 1,166 | hit_3_normal | 120, `100,…`, normal | LIGHT_1 | M1 M9 M11 M12 |
| Bow | SKILL_CH_BOW_BASE_01 | `ATTACK1_skill_ch_bow_normal` 766, ev 445 | 840 | hit_3_bow | none; arrow tail `skill/china/mirage_bow_normal.efp` | LIGHT_1, Roll | M3 M9 M11 M13 |
| Fist | SKILL_PUNCH_01 | default `ATTACK1..4` 533-566 | 1,500 | hit_3_hand | none | LIGHT_1 | M9 M11 |

The bow basic attack has **no** skilleffectset rows [confirmed]: the arrow flight is a client rule. Our rule: the
2 Arrow Combo row shape (`cha_arrow_normal.bsr` from `Bip01 R Hand`, MOV_UPR 500 dm/s, SCT_ARROW) at clip event 1.
Today it flies a streak from `Bip01 L Hand` (`skill-fx.ts:848`).

**Bicheon** (sword, blade)

| Line | Clip (length, ev) | Stages | Aniset | Today |
|---|---|---|---|---|
| Strike Smash `SWORD_SMASH_A` | sword `SKILL_1_skill_ch_sword_smash_a` 1,433, ev 410 | SHOT@e1 FOLLOW root so=0,10,-13 rot 1035 (315°) `hiteffect/hit_1_cut_smash`; DMG@e1 DMG_POS `hit_1_cut_critical` SCT_RUT,315 | dmg hit_3_critical; trail 120 `200,…` smash; LIGHT_4 | M1 M9 M11 M12 |
| Illusion Chain `SWORD_CHAIN_A` (3 segments) | sword `SKILL_2_skill_ch_sword_chain_a` 2,033, ev 211/428/1038, played once | SHOT@e1/e2/e3 FOLLOW `hit_1_cut_chain` so 0,10,-11 / 0,11,-9 / 0,11,-10, rot 765/990/765; DMG@e1/e2/e3 DMG_POS `hit_1_cut_critical` RUT 45/270/45 | hit_3_critical; trail 120 `150,…` chain; LIGHT_2 | M1 M9 M11 M12 M23 |
| Castle Shield `SWORD_SHIELD_A` | none (0/0 action) | ACT_S FOLLOW root `sword_shield_motion_a`; ACT_L LOOP root `sword_shield_keep_a` | LIGHT_4 | OK |
| Soul Cut Blade `SWORD_GEOMGI_A` | sword `SKILL_5_…_geomgi_a` 1,133, ev 86/341 | SHOT@e1 FOLLOW `Bip01 R Hand` `sword_knockdown_wait_a`; DMG@e2 MOV_1TAR root so=0,10,0 → to 0,10,0, MOV_STRAIGHT 300 dm/s `sword_geomgi_shoot_a` | dmg `skill/china/sword_geomgi_hit_a`; trail smash; LIGHT_3 | M1 M10 M11 |
| Blood Blade Force `SWORD_KNOCKDOWN_A` | sword `SKILL_6_…_knockdown_a` 1,866, ev 466/753 | SHOT@e1 FOLLOW R Hand `sword_knockdown_wait_a`; SHOT@e2 FOLLOW so 0,13,-9 rot 870 (150°) `hit_1_cut_downattack`; DMG@e2 DMG_POS `hit_1_cut_critical` RUT 150 | hit_3_normal; trail knockdown; LIGHT_4 | M1 M9 M11 M22 |
| Flower Bloom Blade `SWORD_DOWNATTACK_A` | sword `SKILL_7_…_downattack_a` 1,933, ev 697 | DMG@e1 DMG_POS so 0,0,-9 `hit_1_pierce_smash` RUT 630 | hit_3_critical; trail knockdown; LIGHT_4 | M1 M9 (offset ignored) M11 M22 |
| Glacial Flame Bicheon Force `SWORD_SHIELDPD_A` | default `SKILL_5` 2,000, ev 900/1100 | SHOT@0 FOLLOW so -1,17,2 `sword_shieldpd_ready_a`; @e1 same so `…_ready_b`; @e2 so 0,10,8 `sword_special_force_a` | LIGHT_6 | OK |
| Shield Protection (passive) | — | — | — | OK |

**Heuksal** (spear, glaive)

| Line | Clip | Stages | Aniset | Today |
|---|---|---|---|---|
| Wolf Bite Spear `SPEAR_PIERCE_A` (pierce 2) | spear `SKILL_1_…_pierce_a` 1,500, ev 566 | DMG@e1 FOLLOW `Bip01 R Hand` rot 450 (90°) `spear_pierce_shoot_a` | hit_3_critical; trail smash; LIGHT_4 | M1 M8 M9 M11 |
| Bloody Fan Storm `SPEAR_SPIN_A` | none | ACT_S root `spear_shield_motion_a`; ACT_L root `spear_shield_keep_a` | LIGHT_5 | OK |
| Dancing Demon Spear `SPEAR_FRONTAREA_A` (3 targets) | spear `SKILL_3_…_frontarea_a` 2,100, ev 863 | SHOT@e1 FOLLOW so 0,9,-14 rot 990 (270°) `hit_1_cut_split`; DMG@e1 DMG_POS `hit_1_cut_critical` RUT 270 (every victim) | hit_3_normal; trail knockdown; LIGHT_3 | M1 M9 M11 |
| Soul Spear - Move `SPEAR_STUN_A` | spear `SKILL_5_…_stun_a` 2,500, ev 1127 | DMG@e1 DMG_POS `hit_1_cut_critical` RUT 270; STUN clip + stun loop on the victim | hit_3_critical; trail smash; LIGHT_4 | M1 M9 M11 |
| Ghost Spear - Petal `SPEAR_ROUNDAREA_A` (5 targets) | spear `SKILL_6_…_roundarea_a` 2,100, ev 250 | DMG@e1 FOLLOW `Bip01` `spear_roundarea_shoot_a`; SHOT@e1 (not DMG) DMG_POS `hit_1_cut_critical` RUT 270 on the main target | hit_3_critical; trail knockdown; LIGHT_3 | M1 **M8** M9 M11 |
| Cheolsam Force (passive) | — | — | — | OK |

**Pacheon** (bow)

| Line | Clip | Stages | Aniset | Today |
|---|---|---|---|---|
| Anti Devil Bow - Missile `BOW_CRITICAL_A` | bow `READY01_skill_ch_bow_ready` 666 → `WAIT01_skill_ch_bow_wait` (loop) → `SKILL_40_skill_ch_bow_shoot` 533, ev 32 | READY@0 LOOP ID1 `Bip01 R Hand` `cha_arrow_normal.bsr` rot 90 SCT_ARROW (nocked arrow); DMG@e1 SHOT MOV_1TAR R Hand → 0,10,0, STRAIGHT 500 `cha_arrow_normal.bsr` | hit_3_critical; tail `mirage_bow_critical`; force `force_bow_critical_a`; LIGHT_4, Roll | **M2 M3** M10 M13 |
| 2 Arrow Combo `BOW_CHAIN_A` | bow `SKILL_2_…_chain_a` 1,166, ev 440/790 | DMG@e1, DMG@e2 MOV_1TAR R Hand, MOV_UPR 500, `cha_arrow_normal.bsr` SCT_ARROW | hit_3_bow; tail `mirage_bow_chain`; force `force_bow_chain`; LIGHT_2, Roll | M3 M10 M13 |
| White Hawk Summon `BOW_CALL_A` | bow `SKILL_3_…_call_a` 1,166, ev 499 | ACT_L FOLLOW root so 0,20,0 `res\npc\animal\whitehawk.bsr` (STAND1/WALK/RUN clips) | — | **M4** |
| Autumn Wind - Flame `BOW_PIERCE_A` (pierce 3) | as Anti Devil Bow (READY01/WAIT01/SKILL_40) | DMG@e1 MOV_1TAR MOV_PIERCE 400 `cha_arrow_normal.bsr` SCT_ARROW (no nocked-arrow row) | hit_3_critical; tail `mirage_bow_gwantong`; force `force_bow_gwantong_a`; LIGHT_3, Roll | M3 M10 M13 M16 |
| Demon Soul Arrow `BOW_NORMAL_A` | none | ACT_S `Bip01 L Hand` `bow_range_motion_a`; ACT_L L Hand `bow_range_keep_a` | LIGHT_4 | OK |
| Mind Concentration (passive) | — | — | — | OK |

**Cold**

| Line | Clip | Stages | Aniset | Today |
|---|---|---|---|---|
| Ice River Force `COLD_GIGONGTA_A` (imbue) | none (instant) | ACT_S `Bip01 R Finger2` `cold_gigongta_motion_a`; ACT_L R Finger2 `cold_gigongta_keep_a` | priority 2; dmg `hit_4_cold_hit_a`; trail 160 `200,…` cold; LIGHT_2 | **M14** |
| Weak Guard of Ice `COLD_GANGGI_A` | default READY04 1,000 → WAIT04 → SKILL_4 1,000 ev 106 | READY@0 LOOP so 0,0,4 `cold_assist_motion_wait`; READY@0 LOOP R Hand, L Hand `cold_motion_keep`; SHOT@0 Kill 1; ACT_S/ACT_L `Bip01` `cold_ganggi_keep_a` | **hide weapon**; DefenseEfp `cold_ganggi_damage_a` | M5 M7 |
| Cold wave - Arrest `COLD_GIGONGJANG_A` | default SKILL_2 1,000, ev 96 | SHOT@e1 FOLLOW so 0,9,-6 `cold_attack_motion_shoot_a`; DMG@e1 MOV_1TAR so 0,9,-8 → 0,10,0 STRAIGHT 200 `cold_gigongjang_shot_a`, arrival `cold_gigongjang_hit_a` | hide weapon; LIGHT_2; Yaw twist | M7 M10 M13 |
| Crystal Wall `COLD_BINGBYEOK_A` (toggle) | READY04/WAIT04/SKILL_4 | READY loops as Weak Guard; SHOT@0 Kill 1; ACT_L root `cold_bingbyeok_keep_a` | hide weapon; DefenseEfp `hiteffect/hit_2_ice` | M5 M7 |
| Snow Shield - Novice `COLD_SHIELD_A` | default SKILL_3 1,000, ev 107 | SHOT@0 FOLLOW R Hand, L Hand `cold_motion_keep`; ACT_L root `cold_shield_keep_a` | hide weapon; DefenseEfp `cold_ganggi_damage_a`; LIGHT_2 | M5 M7 |
| Cold Armor (passive) | — | — | — | OK |

**Lightning**

| Line | Clip | Stages | Aniset | Today |
|---|---|---|---|---|
| Thunder Tiger Force `LIGHTNING_GIGONGTA_A` (imbue, chain) | none | ACT_S/ACT_L `Bip01 R Finger2` `lightning_gigongta_motion_a` / `_keep_a` | priority 2; dmg `hit_4_lightning_hit_a`; trail 160 lightning; LIGHT_5 | M14 |
| Must - Piercing Force `LIGHTNING_GWANTONG_A` | READY04/WAIT04/SKILL_4 | READY@0 LOOP R/L Hand `lightning_motion_keep`; WAIT@0 FOLLOW so 0,0,4 `lightning_assist_motion_wait`; SHOT@0 Kill 1 FOLLOW so 0,0,4 `lightning_gwantong_effect_a` | hide weapon | M7 |
| Grass Walk - Flow `LIGHTNING_GYEONGGONG_A` | none (instant) | ACT_S, ACT_L root `lightning_gyeonggong_keep_a` | — | OK |
| Shock Lion Shout `LIGHTNING_CHUNDUNG_A` (3 targets) | default SKILL_3 1,000, ev 107 | SHOT@e1 FOLLOW so 0,9,-6 `lightning_attack_motion_shoot_a`; DMG@e1 AT_TARGET so 0,10,0 `lightning_chundung_hit_a` (every victim) | hide weapon; dmg `hit_4_lightning_attack_a`; LIGHT_5 | M7 M9 (offset ignored) |
| Heaven's Force (passive) | — | — | — | OK |

**Fire**

| Line | Clip | Stages | Aniset | Today |
|---|---|---|---|---|
| River Fire force `FIRE_GIGONGTA_A` (imbue) | none | ACT_S/ACT_L R Finger2 `fire_gigongta_motion_a` / `_keep_a` | priority 2; dmg `hit_4_fire_hit_a`; trail 160 `200,255,128,0` fire; LIGHT_4 | M14 |
| Fire Shield - Phoenix `FIRE_SHIELD_A` | default SKILL_5 2,000, ev 900/1100 | SHOT@e1 FOLLOW `Bip01 L Hand` `fire_shield_effect_a` | DefenseEfp `fire_shield_damage_a` | M5 |
| Flame body - Wisdom `FIRE_GONGUP_A` | READY03/WAIT03/SKILL_3 | READY loops (so 0,0,4 wait circle, R/L Hand `fire_motion_keep`); SHOT@0 Kill 1; SHOT@e1 FOLLOW root `fire_gongup_effect_a` | hide weapon | M7 |
| Basic Fire protection `FIRE_GANGGI_A` | READY04/WAIT04/SKILL_4 | READY@0 LOOP ID1 so 0,0,4 wait circle (fade 500,500); READY@0 FOLLOW (one-shot) R/L Hand `fire_motion_keep`; ACT_S, ACT_L `Bip01` `fire_ganggi_keep_a`. **No SHOT Kill row**: the Kill 1 sits on the ACT_L row [confirmed], so the READY loop ends with its phase (today `startLoop` ignores `kill` on ACT_L rows, which is harmless here) | hide weapon; DefenseEfp `fire_ganggi_damage_a` | M5 M7 |
| Flame Devil Force (passive) | — | — | — | OK |

**Force** (Water)

| Line | Clip | Stages | Aniset | Today |
|---|---|---|---|---|
| Self Breathe Heal `WATER_SELFHEAL_A` | default READY04 1,000 → SKILL_4 1,000 | READY loops (wait circle, hands `water_motion_keep`); SHOT@e1 Kill 1; ACT_S `Bip01` `water_hpheal_effect_a` on the healed | hide weapon | **M6** M7 |
| Force Cure - Poison `WATER_CURE_A` | READY01 → SKILL_1 ev 202 | READY loops; SHOT@e1 Kill 1; ACT_S `Bip01` `water_cure_effect_a` on the target | hide weapon | M6 M7 |
| Heal - Medical Hand `WATER_HEAL_A` | READY01 → WAIT01 → SKILL_1 | as above; ACT_S `Bip01` `water_hpheal_effect_a` on the target | hide weapon | M6 M7 |
| Soul Rebirth Art `WATER_RESURRECTION_A` | READY01 → WAIT01 → SKILL_1 | as above; ACT_S root `water_resurrection_effect_a` on the corpse | hide weapon | M6 M7 |
| Force Increasing (passive) | — | — | — | OK |

### 2.3 Clip audit [confirmed]

A scratch resolver (the game's rules: aniGroup → default, then the `KEEP_CLIPS` filter of `models.ts:51`) over every
level-1 row ≤ mastery 20 on `chinaman_adventurer` and `chinawoman_adventurer` found **0 problems**: every READY /
WAIT / SHOT resolves to the clip named in §2.2, each kept by `KEEP_CLIPS`, with lengths equal to the timing columns
(SKILLS.md §5.1). Fact-check re-read the man's sidecar: every clip length and event time in §2.2 matches.
The only clip-level issues are outside skills (§3.11-§3.12). `KEEP_CLIPS` today **drops** PICK, DEFENCE, DAMAGE2,
STAND3, STAND4, TURN_L/R, REVIVAL, VENDOR01 and the mob clips HELP/FIND; it **keeps but never plays** STAND2, SIT,
SIT_DOWN, STAND_UP, EMOTION01-08, ATTREADY, DIE1_RM (matched by `DIE1(_.*)?`), DOWN_DAMAGE and DOWN_DIE [confirmed].

### 2.4 Mismatches in today's skill presentation

| Id | Mismatch | Code | Fix (lane) |
|---|---|---|---|
| M1 | No weapon trail on any attack | — | `WeaponTrail` (§2.6), FX-C1 |
| M2 | READY `AT_LOOP` rows whose object is a `.bsr` (the nocked arrow) are skipped: `stageKey` returns null for non-flight `.bsr` rows and `scheduleStages` drops them | `skill-fx.ts:159`, `:180` | play `.bsr` objects as models (`FxModel`: the converted glb on the start bone, rot 90 about the forward axis), Trade into the flight, FX-C1 |
| M3 | Arrows are a procedural streak (`ArrowStreak`); the arrow model `res/item/china/weapon/cha_arrow_normal.bsr` is not drawn; the aniset **arrow force** effect (`force_bow_critical_a`, `force_bow_chain`, `force_bow_gwantong_a`) is never spawned (not even preloaded, `:716`) | `skill-fx.ts:270`, `:716`, `:891` | fly the arrow glb oriented along the velocity, the arrow tail `.efp` trailing it and the arrow force `.efp` on its head; imbued shots use `cha_arrow_cold/fire/lighting.bsr` [likely], FX-C1 |
| M4 | White Hawk's ACT_L `.bsr` (hawk circling 2 m above) is not shown | `skill-fx.ts:577` (`!st.effect` skip) | `FxModel` looping its WALK clip on a 1.2 m radius circle at +2.0 m [circle: our rule], FX-C1 |
| M5 | DefenseEfp never plays: a carrier of Weak Guard of Ice, Crystal Wall, Snow Shield, Fire Shield, Basic Fire protection shows nothing when hit | `FxSkill.defense` unused | on each landed hit on a victim that carries a buff with `defense`, play it at the victim's DamagePos (once per hit, highest-priority buff) [likely], FX-C1 |
| M6 | Heal/cure/resurrect ACT_S never plays: these kinds send no `effectAdd`, so `buffStart` is never called | `features/skills.ts:250` | at the release of a heal/cure/resurrect cast (ActionPlayer knows target and release), play the row's ACT_S on `a.target` unless a `castEnd` came first [our rule: no protocol], FX-C1 |
| M7 | The 12 casts with Hide Weapon = 1 (§1.2 col 5) keep the weapon visible | `models.ts` (`hangOnSocket`, l.665) | `CharacterActor.setWeaponVisible(false)` from the action start to its end/castEnd, FX-0 seam + FX-C1 |
| M8 | DMG rows anchored on the caster replay per victim: Wolf Bite Spear (2 targets) and Ghost Spear - Petal (5 targets) stack 2-5 copies | `skill-fx.ts:533-548` | key `(instance, cue)`; caster-anchored DMG rows play once, FX-C1 |
| M9 | Hit point = body centre at 0.55 × height (`bodyPoint`); retail uses the victim's DamagePos in its own frame (tiger 1.3 m in front of its root, Tiger Girl 3.0 m); the StartOffset of AT_DMG_POS rows (Flower Bloom 0,0,-9) and AT_TARGET rows (Shock Lion 0,10,0) is ignored | `skill-fx.ts:241`, `:534`, `:941` | `damagePoint(view)` from characterInfo (export §5.1), fallback 0.55 × height; add the row offset, FX-C1 |
| M10 | Flights end at `bodyPoint + 0.2 × TargetOffset.y`; retail aims at the target root + TargetOffset (0,10,0 = 1.0 m) [likely] | `skill-fx.ts:885-888` | end = target root + TargetOffset (victim-local), FX-C1 |
| M11 | No blood on landed hits (BloodType, bleeds = 1) | — | play `hiteffect/<BloodType>.efp` at DamagePos; `<BloodType>_down.efp` when the victim is knocked down [likely], FX-C1 |
| M12 | No LIGHT_n flash | — | one pooled Babylon `PointLight` per hit (colour/300 ms; range 10 m [our rule: the file's 1000 is in an unknown unit, §1.2], intensity ramp 1 → 0), characters only (the world has its own lights, `World.isolateLights`, `packages/world-render/src/world.ts:475`); off below quality "medium", FX-C1 |
| M13 | No waist twist (bow Roll, Cold wave Yaw) | — | [unknown magnitude]: our rule: rotate `Bip01 Spine1` toward the target by at most 30° during SHOT, after the clip is sampled; low priority, FX-C1 |
| M14 | Imbues draw two invented glow strips (`WeaponGlow`); retail shows the imbue's own trail (priority 2 replaces the weapon trail) and its DamageEfp on every imbued hit (`hit_4_cold_hit_a`, `hit_4_lightning_hit_a`, `hit_4_fire_hit_a`) | `skill-fx.ts:328`, `:594` | drop `WeaponGlow`; while the attacker carries an imbue effect (EffectBook), attack trails use the imbue's trail row and landed hits add its DamageEfp [likely], FX-C1 |
| M15 | ID/Kill/Trade/Fade/Param/Scale are not exported: Kill ends *all* earlier loops of the caster; Trade is not done (the mob archer's and Yeoha's charged object stays in the hand while a copy flies); fades are instant | `skill-fx.ts:872`, exporter | export v2 (§5.1); Kill by ID, Trade hands the live loop to the flight, fades per row, FX-X + FX-C1 |
| M16 | MOV_PIERCE (Autumn Wind) stops at the first target | `skill-fx.ts:873` | continue on the same line to the skill range, later victims' hits land as the arrow passes [likely], FX-C1 |
| M17 | Effect rotation ignores the start bone's rotation (yaw only); spear_pierce_shoot_a on R Hand rot 450 may need the hand's frame [unknown] | `skill-fx.ts:226` | decide in the lab (§2.5): compare screenshots of both rules against a retail capture; default stays yaw-only |
| M18 | Height and mob Size do not scale offsets or effects; MOB_BASE rows are not scaled | `skill-fx.ts:538` | offsets × root scale; MOB_BASE scale (§1.2), FX-C1 |
| M19 | Mob attacks: wrong clip, no spark/blood/projectile (see §3.4) | `entities.ts:385`, `features/skills.ts:381` | §3.4; the server part and the mob `cast` path are SYSTEMS_COMBAT's (lanes MS-S / MS-C); FX-C1 adds the retail stages on top |
| M20 | Knocked-down victims replay DOWN on every hit and die with DIE1; retail has `DOWN_DAMAGE` (hit while down) and `DOWN_DIE` (both already kept by `KEEP_CLIPS`, never played) | `features/skills.ts:211`, `models.ts:863` (`die`) | hit while down → DOWN_DAMAGE overlay; death while down → DOWN_DIE, FX-C1 (reactions) + FX-0 seam |
| M21 | Illusion Chain: the head's SHOT schedules all three slashes; if the chain breaks without a `castEnd`, slashes 2-3 still play | `features/skills.ts:190` | schedule segment i's non-DMG rows when segment i's `cast` arrives, FX-C1 |
| M22 | One-shot cap `ONE_SHOT_MS = 6000` with emission stopped 1.5 s early is fine for skills (all ≤ 3 s) but wrong for the system effects (level-up 7.2 s) | `skill-fx.ts:74`, `:989` | cap = program duration + FADE; SystemFx (§3) must not reuse the 6 s cap, FX-C1/FX-C2 |

### 2.5 Verification harness

Two parts. Both compare the game's behaviour with a **golden table computed from the data**, not with our own code.

**H1: headless, `apps/game/test/effects-retail.test.ts`** (skips when `work/out/fx/skills.json` v2,
`work/out/data/skills.json` or `work/out/char/china/chinaman_adventurer.{glb,json}` are missing, like the sound
`*.out.test.ts`):

- Golden builder `apps/game/test/fixtures/effects-golden.ts`: for every active level-1 row ≤ cap (the 34 lines + 3
  basic attacks) and both adventurer models, the expected phases `{phase, clipName, startMs, ms, loop}` (the §2.3
  resolver), and per stage row the expected `{key, atMs (phase start + event), anchor: 'bone'|'root'|'damagePos'|
  'target'|'flight', bone, offsetM (caster-local), roll, loop, killId, trade}`.
- Drive: NullEngine scene; load the real glb bytes with `LoadAssetContainerAsync(bytes, scene, {pluginExtension:
  '.glb'})` into a `CharacterActor` (the slim packs from `work/out-opt` when present); a caster at the origin facing
  +Z and a Mangnyang target 3 m ahead (or 12 m for ranged rows); fake clock; feed `cast` / `combat {instance}` built
  from the row (hits at the golden cue times) through `ActionPlayer` + `SkillFx` exactly as `features/skills.ts`
  wires them.
- A recording `FxLibrary` (programs registered as the synthetic plate of `skill-fx.test.ts`) logs every spawn with
  its key, local time, and the first `FxRootPose` sampled.
- Asserts per row:
  1. clip names and phase starts equal the golden (±1 frame, 34 ms);
  2. every stage key spawned at `atMs` ±34 ms, none extra (the M8 duplicate check: exactly one caster-anchored DMG
     spawn per cue with 3 victims);
  3. **anchor**: for bone anchors, the spawn position equals the joint's world position at that clip time + the
     offset turned by the caster yaw, within 1 cm; and over the next 5 ticks the pose moves with the joint (max
     deviation 1 cm): the "effect follows the bone" check;
  4. DMG_POS rows at the victim's DamagePos within 2 cm; flights end within 5 cm of target root + TargetOffset;
  5. loops end at their phase end / Kill id / Trade (instance disposed within FADE after that time);
  6. no leaks after all rows × 20 casts (`SkillFx.stats.started === disposed` after the drain).
- Runtime ~20 s; tag it `retail` so `pnpm vitest run -t retail` runs it alone.

**H2: in the browser, the FX lab** (`?mock=1&auto=1&gm=1&fxlab=1`, new `apps/game/src/debug/fx-lab.ts`):

- Exposes `window.__sroFxLab` with `learnAll()` (sends GM `/skill all`), `equip(family)`, `cast(code, target?:
  'self'|'nearest')`, `log(): FxLabEntry[]`, `clear()`.
  `FxLabEntry = { t: number; kind: 'clip'|'fx'|'hit'|'trail'|'number'; name: string; key?: string; bone?: string;
  pos?: [number,number,number]; local?: [number,number,number]; entity: number }` (local = caster-local metres).
- The log is fed by one optional hook: `SkillFx.onSpawn?(e)` and `CharacterActor.onClip?(name)` (FX-0 seam).
- Check procedure (§6.3) with the Browser pane: navigate, run `await __sroFxLab.runAll()` (casts every learned line
  on the nearest Mangnyang, 4 s apart), read `__sroFxLab.report()` (the H1 golden comparison run in the page) and
  take one screenshot per line at its first DMG cue for the visual checklist.

---

## 3. Everything else with retail animation or effects

### 3.1 Hits: spark, blood, light, reaction, numbers

| Item | Retail | Today | Gap |
|---|---|---|---|
| Spark | aniset DamageEfp of the attacking row at DamagePos: `hit_3_normal` (sword/spear basic), `hit_3_bow`, `hit_3_hand` (fist, mob paws), `hit_3_critical` (weapon skills), `hit_4_<element>_hit_a` (imbues) [confirmed rows] | `SkillFx.spark` at 0.55 × height, player attacks only | M9, mob attacks (§3.4) |
| Critical | Same spark; the number uses the `critical*.ddj` tag [confirmed files]; no crit-only DamageType rows ≤ cap [confirmed] | DOM "CRITICAL" text | sprite numbers (below) |
| Blood | `hiteffect/hit_2_<BloodType>` (+`_down` on downed victims) on landed hits [likely] | none | M11 |
| Victim clip | DAMAGE1 (partial overlay on most mobs/players), DAMAGE2 (the players and the 6 Jangan mob sidecars checked have one, 400-1,866 ms) [unknown when: our rule, crits and knockback], DOWN_DAMAGE while down | DAMAGE1 only (`models.ts:851-860`) | M20, DAMAGE2 [unknown] |
| Block | Shield bearer: DEFENCE partial clip (500 ms) + `system/ch_blocking.efp` at DamagePos [likely: the file name and the clip]; number `blocking_enemy/player` | "Block" text; DEFENCE is dropped by `KEEP_CLIPS` | E11 |
| Miss | No spark, no reaction; `miss_enemy`/`miss_player` sprite | "MISS" text | sprite |
| Numbers | `interface/hitcount/`: `hitcount_0..9` (white, 36×60), `hitcount_enemy_0..9` (red: damage dealt **to you** by enemies [likely]), `hitcount_player_0..9` (other players' damage [likely]), `*_shadow` variants, `critical(_enemy/_player/_shadow)` 96×24, `miss_enemy/_player` 60×28, `blocking(_enemy/_player/_shadow)` 104×40, `resist(_shadow)` [confirmed files] | `Floaters` DOM text | E10: a sprite renderer behind the same `Floaters.add(at, amount, kind)` API (`hud/effects.ts:41`); built by docs/UI.md lane UI-H (UI.md §4.10), not by an FX lane |

**Floating number rule** [our rule, retail-shaped]: digits drawn from the sprites at 0.5 scale (18×30 px per digit),
kerning −6 px, the shadow sprite under each glyph at +2/+2 px; rise 56 px over 1.2 s, crit 1.5 s with the "Critical"
tag above; white for damage you deal, red (`_enemy`) for damage you take, `_player` for another player's. Heals stay
green DOM text (no retail sprite) [confirmed: no heal sprite exists].

### 3.2 Statuses

| Status | Players (retail) | Mobs (retail) | Anchor | Today |
|---|---|---|---|---|
| burn | `battle/status_bad_burn` [likely] | the mob BSR set `status_bad_burn` → `monster/status_bad_burn.efp` at the model origin: every Jangan mob BSR **except `tombstone.bsr` and `tigerwoman.bsr`, which carry no particle sets at all** [confirmed, fact-check parsed all 23 `res/mob/china/*.bsr` that mobs.json references; `tiger(_clon).bsr` also lack the `system_appear` set] | origin (the program carries its height) [likely] | battle file at 0.35 × height for both |
| shock (`eshock`) | `battle/status_bad_eshock` | set `status_bad_eshock` → `monster/…` (same coverage as burn) | origin | same |
| frostbite | `battle/status_bad_frostbite` | set → `monster/…`; `waterghost.bsr` also has a set `mco_wrong_frostbite` whose `monster/mco_wrong_frostbite.efp` is **missing** from Particles (so is its `mco_sys_appear.efp`; and `msk_waterghost_gas.efp` of both waterghost BSRs) [confirmed]: use `status_bad_frostbite` | origin | same |
| freeze | `battle/status_bad_icing_on` → (hold) → `…_icing_off` | sets `status_bad_icing_on/off` | origin | on/off at feet |
| poison | `battle/status_bad_poison` | set `status_bad_poison` | origin | same |
| stun | `battle/status_bad_stun` over the head + STUN clip | **no set** on Jangan mobs → our rule: `monster/status_bad_stun.efp` over the head + STUN clip | head top | battle file at head |
| knockdown | DOWN → DOWN_RM (loop) → DOWN_UP | same clips | — | done (`features/skills.ts:210`) |

Rule: a mob's status visual = its BSR set named `status_bad_<kind>` when present (sidecar `particles`, §5.2), else
the player file; anchor at the model origin scaled by MOB_BASE, except stun (head top + 0.15 m) [likely]. A set whose
`.efp` is missing from Particles counts as absent.

**Always-on mob glows** (BSR `ambient` set, not drawn today) [confirmed]: `yeoha.bsr` and `yeoha_clon.bsr` carry
`monster/luster_green_ball.efp` on `effect_bone` and `monster/luster_green.efp` on `bone_brilliance_r` and
`bone_brilliance_l`. They play through the same sidecar `particles` path as the drops' sparkles (FX-C2
`model-particles.ts`). No other Jangan mob has an `ambient` set.

### 3.3 Buffs and imbues

- **ACT_S / ACT_L / DEACT**: done for buffs (`features/skills.ts:250`); DEACT rows exist only for Berserk ≤ cap
  [confirmed] → play DEACT on `effectRemove` when the group has one.
- **DefenseEfp** on hits taken while buffed: M5.
- **Imbues**: M14 (trail + DamageEfp instead of the invented glow).
- **Late joiners** see ACT_L loops (EffectState in `EntityState.effects`) [confirmed, done].

### 3.4 Mob attacks and mob skills (Jangan)

Retail: every mob attack is a `MSKILL_*` row with its own aniset (clip, DamageEfp, trail) and stages [confirmed rows
SE l.1962-2004, l.5695-5756]. The server today sends mob `combat` without `skill` (`Gameplay.attack`,
`gameplay.ts:801-809`), and the client cycles `ATTACK1..n` (`CharacterActor.nextAttackClip`, `models.ts:740-745`).
docs/SYSTEMS_COMBAT.md §2 and §7.3 own the monster-skill engine: mob skills arrive like player skills, as `cast`
(with a mob `id`) + `combat {skill, instance, at, aoe}`, and the MSKILL rows go into the data `skills.json`, so
`skills-view.ts` resolves the clip from `SkillDef.animation` (lane MS-C). This spec only adds the retail
presentation (stages, DamageEfp, blood, Trade, the arrow model) on that path:

| Mob | Skill → clip | Visual |
|---|---|---|
| Mangnyang | ATTACK01 → ATTACK1 (ev 651); ATTACK02 → ATTACK2 (ev 821/1381, 2 hits) | spark hit_3_normal |
| Bigeyeghost (+clon) | rows are `BIGEYEGHOST_CLON_ATTACK01` → ATTACK1 and `BIGEYEGHOST_ATTACK02` → ATTACK2 | hit_3_hand |
| Gyo (+clon) | `GYO_CLON_ATTACK01` → ATTACK1; `GYO_ATTACK02` → ATTACK2 (2 hits) | hit_3_normal |
| Waterghost (+clon) | ATTACK01 → ATTACK1; clon ATTACK03 → ATTACK3; **ATTACK02 poison gas** → ATTACK2 (3,666 ms, ev 1196/1685/2207): SHOT@e1/e2/e3 FOLLOW `bone_smoke` `monster/skill_waterghost_gas_shot.efp` (e2 is the DMG row); aniset DamageEfp `none` | hit_3_hand; gas stages |
| Stoneghost (+clon) | `STONEGHOST_ATTACK01` → ATTACK1 (2 hits); `STONEGHOST_CLON_ATTACK02` → ATTACK2 | hit_3_hand |
| Tombstone (+clon) | `TOMBSTONE_CLON_ATTACK01` / `TOMBSTONE_ATTACK02`, both → ATTACK1 (ev 1265): **two** SHOT@e1 AT_MOV_1TAR STRAIGHT 200 flights of `monster/skill_tombstone_{ghost,force}_shot.efp`: the first ID1, non-DMG, from bone `fire` to TargetOffset 2,10,0; the second DMG, Trade 1, from bone `fire01` to -2,8,0 (sound `monster\Cm_Tomb_Force{1,2}_Swing.wav`); arrival `…_hit.efp`; aniset DamageEfp `none` [confirmed, fact-check: not a LOOP row]. The mob has no DIE1 clip (it swaps to `tombstone_die.bsr`, §3.5) | 2 projectiles |
| Yeoha (+clon) | `YEOHA_ATTACK01` / `YEOHA_CLON_ATTACK01/02` melee; **`YEOHA_ATTACK03` curse** → ATTACK3 (ev 1185): SHOT@0 LOOP ID1 `effect_bone` `skill_yeoha_force_shot` then DMG@e1 MOV_1TAR STRAIGHT 200, Trade 1 → TargetBone `Bip01`, arrival `skill_yeoha_force_hit`, sound `monster\Cm_Yeoha_Curse.wav` | projectile |
| Bandit (+clon) | `BANDIT_CLON_ATTACK01/02` → ATTACK1/2 (02: 2 hits); `BANDIT_ATTACK02` → **ATTACK1** (2 hits); **`BANDIT_ATTACK03` fire force** → ATTACK3, DamageEfp `hit_4_fire_hit_a` | spark |
| Bandit archer (+clon) | `BANDITARCHER_ATTACK01` and `BANDITARCHER_CLON_ATTACK01/02` (→ ATTACK1/ATTACK1/ATTACK2): SHOT@0 LOOP ID1 R Hand `res\mob\china\banditarcher_arrow.bsr` rot 90 SCT_ARROW (nocked), DMG@e1 MOV_1TAR MOV_UPR 400, Param 50, ID1 + Trade 1; tail `skill\china\mirage_bow_normal.efp` (CLON_ATTACK02: `mirage_bow_critical`); DamageEfp `hit_3_bow`; trail length 120/140, op `ONE`; Roll | arrow model + tail |
| Tiger / White tiger (+clon) | ATTACK01 (2 hits) / ATTACK02; **WHITETIGER_CLON ATTACK03 howl** → ATTACK3, FOLLOW `Bip02 Spine1` `monster/skill_whitetiger_howling.efp` | hit_3_hand; howl |
| Chakji (+clon) | ATTACK01 → ATTACK2 (!), ATTACK02 → ATTACK1, clon ATTACK03 → ATTACK3 | hit_3_normal |
| Tiger Girl (unique) | ATTACK01 → ATTACK1 (ev 1109/1379); ATTACK02 howl → ATTACK2, `Bip02 Spine1` `skill_tigerwoman_howling`; ATTACK03 curse → ATTACK3 (ev 341/3004): SHOT@0 `skill_tigerwoman_curse_motion` + sound `monster\Cm_TigerWoman_Magic.wav`, @e2 `…_curse_shot` at so 3,13,-10, three AT_TARGET `…_curse_hit` at to ±10,0,0 / 0,0,10 (the middle one DMG); SUMMON01-04 → no clip, DamageEfp `hit_4_lightning_attack_a`; she **rides** `bluetiger.bsr` [confirmed ride column; how the rider is attached: unknown] | full |

Client rule: a mob `cast` + `combat {skill, instance}` (SYSTEMS_COMBAT §7.3) plays its clip through `skills-view.ts`
(lane MS-C) and its stages through the same `SkillFx` (the fx index carries the Jangan `MSKILL_*` groups, §5.1). A
mob `combat` with `skill` but **no** `instance` (fallback) resolves the aniset shot clip in the mob's `default` group
(`ANI_ATTACKn`) through the FX-0 seam `EntityView.attack(target, hits, now, {clip})`. Without `skill`, keep today's
cycle.

### 3.5 Spawn, death, corpse, despawn

| Event | Retail | Today | Gap |
|---|---|---|---|
| Player appears (enter, warp arrival, respawn) | `SYSTEM_APPEAR` ACT_S: `system/system_apear.efp` at the root, 4.45 s (89 ticks) [likely: which events trigger it] | nothing | E7 |
| Mob spawn | the model's set `system_appear` names `monster\system_appear.efp`, which **does not exist** in the 1.188 Particles.pk2 [confirmed] → mobs pop in [likely] | pop in | none; our rule: a 0.4 s opacity fade-in |
| Death | DIE1 once, then DIE1_RM loop (the "lying" rest clip, 166-333 ms) [likely]; knocked-down victims DOWN_DIE; Mangnyang and Tombstone swap to their `Die Bsr` model and play its DIE1 [likely]. `tombstone` has **no DIE1** in its own sidecar [confirmed], so without the swap it cannot play a death at all | DIE1 held on its last frame (`CharacterActor.die`, `models.ts:863`) | E8 |
| Corpse | server `CORPSE_MS = 3000` then `despawn` [confirmed `formulas.ts:308`] | fade 0.9 s after despawn (`FADE_S`, `entities.ts:27`) | our rule kept; retail fade length [unknown] |
| Death effect | characterInfo Die Effect / Dead Effect are `none` for every Jangan mob [confirmed] | — | none |

### 3.6 Gold and item drops

Retail [confirmed files; animation use likely]:

| Items | Drop model (col 53) | Attached effect (BSR `ambient`) | Clips |
|---|---|---|---|
| ITEM_ETC_GOLD_01 (< 1,000 gold) | `res/item/etc/drop_ch_money_small.bsr` | `system/item_drop_money.efp` (soft light billboard, 1.5 s loop) | none |
| ITEM_ETC_GOLD_02 (< 10,000) | `drop_ch_money_normal.bsr` | item_drop_money | none |
| ITEM_ETC_GOLD_03 | `drop_ch_money_large.bsr` | none | none |
| Weapons, armour, shields (456 of the 514 exported `ItemDef`s) | `drop_ch_equip.bsr` | `item_drop_equip.efp` (yellow twinkles `n-light-y`, 5 s) at raw (0, 0.05, 0) + `item_drop_acc.efp` at raw (0, 1.338, −0.025) | `ATTREADY` 1,333 ms one-shot (the toss) then `STAND1` 500 ms loop [confirmed clips in the exported sidecar; the use is likely] |
| Rings, earrings, necklaces (27) | `drop_ch_acc.bsr` | `item_drop_acc.efp` at raw (0, 1.024, 0) | ATTREADY / STAND1 |
| Potions, pills (25) | `drop_ch_bag.bsr` | `item_drop_use.efp` (red twinkles) | none |
| Return scrolls (3) | `drop_scroll.bsr` | none | none |
| Seal items (`*_RARE`, not ≤ cap today) | `drop_ch_equip_rare.bsr` / `drop_ch_acc_rare.bsr` | equip: `item_drop_equip_rare.efp` (swirl rings); acc: `item_drop_acc_rare.efp` + `item_drop_acc.efp` at raw (0, 1, 0) | none |
| Quest items (retail `ITEM_QNO_*`; our custom `ITEM_BANDIT_LEDGER`, …) | `drop_ch_quest.bsr` | `item_drop_use.efp` | none |
| Alchemy materials (alchemy spec) | `drop_archemy.bsr`, `drop_archemy_1.bsr`, `drop_archemy_bag.bsr` | only `drop_archemy_1` has one: `item/drop_archemy.efp` [confirmed]; the other two none | none |

Particle positions are raw BSR file units. By the converter's rule (1 unit = 1 dm, `UNIT_SCALE = 0.1`,
`packages/convert/src/gltf/space.ts:20`) the acc sparkle sits **0.13 m** (equip) / **0.10 m** (acc) above the origin,
not 1.3 m [likely: building BSRs in the same field hold values like 103 = 10.3 m, which only fit decimetres]. The
exporter converts them with `toGltfPosition` (§5.2).
Exported today [confirmed `work/out/item/etc/`]: `drop_ch_money_small/normal/large`, `drop_ch_equip`, `drop_ch_acc`,
`drop_ch_bag`, `drop_scroll` (7). `drop_ch_quest`, the `_rare` pair, `drop_archemy*` and `drop_trade` are not (§5.3).

- The server already maps the gold amount to `ITEM_ETC_GOLD_01..03` (`gameplay.ts:97`: < 1,000, < 10,000, else)
  and every `ItemDef` carries `dropModel` with an exported glb (514 / 514, all among the 7 models above) [confirmed].
  The client ignores both (`entities.ts:489` → `new DropVisual(...)`: cylinders, box, beam, spin, bob).
- **Orientation**: the drop glb upright, a random yaw per item id [unknown: our rule, seeded by the entity id so every
  viewer agrees]. No spin, no bob, no beam [likely].
- **Ownership** (someone else's item): retail tint [unknown]; our rule keeps today's cue as a label class
  (`owned`) only, no beam.
- **Toss**: when the item is fresh (P1 `droppedAt` within 1.5 s), it arcs from `dropFrom` (the corpse, +0.8 m) to its
  spot in 0.45 s (height 0.6 m), then plays ATTREADY once (equip/acc) [our rule for the arc; the clip is likely].
  Items already on the ground at enter-view skip it.
- **Hover**: today's highlight overlay stays.
- **Pickup**: the picker plays `PICK` (default group, 533 ms) facing the item [likely]; the item despawns; the icon
  fly (`pickup-fly.ts`) stays [our UX]. `PICK` is dropped by `KEEP_CLIPS` today [confirmed]. The only client signal
  of a successful pickup is the picker's own `actionResult {re: 'pickup', ok: true}` (`screens/world.ts:760`); other
  viewers just see `despawn`, which does not say who took it [confirmed]. So PICK plays for yourself only; showing it
  to others would need a new wire cue [unknown whether worth it; not in this wave].

### 3.7 Consumables and teleports

| Use | Retail SYSTEM row | Effect (anchor root) | Trigger today | Gap |
|---|---|---|---|---|
| HP potion / herb | SYSTEM_HPPOTION ACT_S FOLLOW | `system/item_hpotion.efp` 1.45 s | none for viewers; own heal number | P3 + play |
| MP potion | SYSTEM_MPPOTION | `system/item_mpotion.efp` | none | P3 |
| Vigor (HGP/"life") | SYSTEM_LIFE | `system/item_life.efp` | none | P3 |
| Universal pill | no SYSTEM row [confirmed]; `battle/status_cure_{blind,burn,eshock,frostbite,poison,zombie}.efp` exist; the pet row `STATUS_CURE_COS` (SE l.3331, l.8226) plays `skill/china/water_cure_effect_a.efp` [confirmed row] | [unknown]; our rule: `battle/status_cure_<kind>.efp` for the cured status, else `water_cure_effect_a` | none | P3 |
| Return scroll, reading | SYSTEM_RETURNSCROLL ACT_S **AT_LOOP** | `system/item_returnscroll.efp` (7.45 s loop) for the cast | `itemCast` (to viewers) → cast bar only | play on `itemCast`, stop on `itemCastEnd` |
| Return scroll, done | SYSTEM_RETURNSCROLLRESULT AT_LOOP | `system/item_returnscroll_use.efp` (2.5 s) at the old spot | `itemCastEnd done` → warp | play at the old position before the warp; `system_returnscroll_result.efp` at the arrival [unknown: no row references it; our rule] |

### 3.8 Level-up

Retail SYSTEM_LEVELUP ACT_S FOLLOW root: `system/system_levelup.efp` (20 nodes, 12 textures, 8 meshes, 7.2 s)
[confirmed: 144 frames at 20 fps in the compiled program]. Today: a procedural gold cylinder and torus for 2.2 s
(`levelUpColumn`, `effects.ts:82`, called from `screens/world.ts:691-695`) on `levelUp`. Replace with the
program on the entity's root (following it if it moves). The level-up sound is SOUND.md's.

### 3.9 Berserk (hwan) visuals: hook for the Berserk spec

SYSTEM_CH_HWANMODE [confirmed rows, aniset SE l.1399, stages l.3893-3901, every stage Scale `CHAR_BASE`]: ACT_S
`system/system_hwan_motion.efp` on `Bip01` + `player\hwanchange.wav`; ACT_L loops `system_hwan_keep.efp` on
`Bip01 Spine` (script `SCT_MAT,64,16,0,140,32,0,1000`: a material colour pulse [likely]) and `system_hwan_keep_s.efp`
on `Bip01 L UpperArm`, `Bip01 R UpperArm`, `Bip01 L HandMid`, `Bip01 R Finger2`, `Bip01 L Calf`, `Bip01 R Calf`;
the script `SCT_CHAR_SCALE,1.1,1000` sits on the L UpperArm row only (the character grows to 1.1× over 1 s, applied
once [likely]); DEACT `system_hwan_disappear.efp` at the root + `player\hwanreturn.wav`. Aniset: DamageEfp
`hiteffect/hit_4_hwan.efp`, trail 160 `200,255,255,255` `mirage_texture_hwan.ddj`, priority 10 (beats imbues). Gauge
gain: `battle/hwn_{red,blue,violet}_indraft.efp` and `battle/hwan_*` orbs [unknown mapping].

**Carrier (fact-check, aligned with docs/SYSTEMS_COMBAT.md §5.3 and §7):** Berserk is **not** an `EffectState`. The
server sends `EntityState.berserkMs` / `entityUpdate.berserkMs` and `CombatHit.hwan`; lane BZ owns
`apps/game/src/world/features/berserk.ts`, which calls FX-C2's `SystemFx.play('SYSTEM_CH_HWANMODE', phase, view)`
(`system-fx.ts`) for ACT_S / ACT_L / DEACT, and FX-C1's hit path picks the HWAN DamageEfp and trail when
`hit.hwan`. SYSTEMS_COMBAT §5.3 says "system_hwan_keep looped on the root"; the retail rows above (Spine + 6 bones)
win.

### 3.10 Item glows: hook for the alchemy spec

- **Enhancement** [what the table is for: likely the +N glow; from which plus: unknown; SYSTEMS_COMBAT §4.6 leaves it
  unwired this wave]: `itemoptionefp.txt` (CP949, 1,316 data rows + header) has **one row per item code, plain codes
  included** [confirmed, fact-check]: 528 plain (`ITEM_CH_SWORD_01_A`), 608 `_RARE`, 84 `_BASIC`
  (`ITEM_CH_SWORD_01_BASIC`), 72 `_RARE_HONOR`, 16 `_DEF`, 8 `_LEGEND`. So a plain code needs no fallback rule: look
  up its own code. Cols: 0 code, 1 particle, 2 scale % (40-320), 3 bone, 4 offset (`none` everywhere), 5 = 8 on every
  row (header `일괄확대수치(배)`, "bulk scale factor (×)": not a +level threshold; meaning [unknown]), 6 = 100 on every
  row, 7 = 90-160. Particles: `system/system_enchant_a_01.efp` (swords, spears: `ai_end`), `system_enchant_b_01.efp`
  (blades, glaives: `ai_start`), `system_enchantbow_a_01.efp` (bows: `Bone01` for `ITEM_CH_BOW_01_A`; `bow_01.bsk`
  has only Bone01/Bone02), `system_enchantshield_a_01.efp` (shields: `Bone01`); Europe adds harp/staff variants.
  `itemoption.txt` gives a type number per code [unknown use].
- **Seal (SOX)**: `itemrare.txt` → `system/system_raretype_{a,b}_step{1,2,3}.efp` on `ai_end`/`ai_start` [confirmed];
  none ≤ cap in our item set.
- These need the weapon dummies in the sidecar (§5.2).

### 3.11 NPCs

- **Idle** [confirmed, fact-check read all 46 npcs.json sidecars]: most Jangan NPCs have `STAND1` (loop) and a
  one-shot `STAND2` (2.3-8.3 s). Exceptions: `NPC_CH_KISAENG3`, `NPC_CH_KISAENG4` and `NPC_BATTLE_ARENA_MANAGER` have
  STAND1 only; `NPC_CH_GACHA_MACHINE` has no clips; `NPC_CH_BIGMAN`'s STAND1 is not flagged cyclic. The 8 soldiers
  (`NPC_CH_SOLDIER_*`) add **one-shot** `TURN_L` (3.3 s) / `TURN_R` (5.3 s); the Europe girl adds `STAND3`; Moonshadow
  adds `STAND3` and `STAND4` (plus WALK/RUN/ATTACK1). Today only STAND1 plays (`entities.ts:465`, `:513`; STAND3/4
  and TURN are dropped by `KEEP_CLIPS`). Retail plays a variant now and then [likely]; our rule: after each STAND1
  cycle, 20 % chance of one variant (uniform), never two in a row, seeded per entity.
- **Clip-bound particles** [confirmed BSR aniSets]: `npc/npc_chinasystem_shaman_pipesmoke.efp` on the shaman
  (`chinasystem_shaman.bsr`, `Bone09`, 3,206 ms into **STAND2**) and on the kisaeng2 / kisaeng6 NPCs (`Bone01`, 2,240 /
  2,732 ms into STAND2). Each BSR also binds a copy to ATTREADY, a clip these NPCs do not have. So the smoke shows only
  while the STAND2 variant plays: it depends on the idle-variant scheduler. Needs sidecar `particles` (§5.2).
- **Facing** and the storage keeper's missing model are other specs' items.

### 3.12 Players: stance, sit, emotes, turn

| Behaviour | Retail | Today | Gap |
|---|---|---|---|
| Combat stance | after an attack, idle = `ATTREADY_<family>` (sword/spear/bow groups have one) until 5 s without combat [likely; timeout unknown] | STAND1 | client-only |
| Idle fidget | `STAND3` partial (2.3-3.0 s) now and then [likely] | none | client-only |
| Sit | "Sit down (N)", `/SitDown` (`UIIT_CTL_SIT`, `UIIT_STT_CHAT_COMMAND_SITDOWN`) → SIT_DOWN 1,666 → SIT loop → STAND_UP 1,600 [confirmed strings and clips] | none | P4 |
| Emotes | Action window: Hi, Laugh, Greeting, Yes, Rush, Joy, No (`UIIT_CTL_EMOT_{GREETING,LAUGH,POKUN,YES,RUSH,JOY,NO}_TT`) [confirmed strings]. Mapping by the clips' `.ban` names [likely, fact-check; replaces the earlier guessed order]: Hi = `EMOTION01` `cm_emot_act_greeting` 2.3 s; Greeting (포권, the fist salute) = `EMOTION02` `cm_emot_act_pokun` 1.7 s; Rush = `EMOTION03` 3.1 s; Joy = `EMOTION04` 1.5 s; No = `EMOTION05` `…_no_tattoo` 3.3 s; Yes = `EMOTION06` `…_yes_tattoo` 3.3 s; Laugh = `EMOTION07` 3.7 s; `EMOTION08` `cm_emot_act_bow` 6.2 s has no UI entry (unused) | none | P4 |
| Turn in place | TURN_L/TURN_R when the yaw changes > 45° while standing [unknown]; on the player model both are the same `.ban` (`chinaman_a_standroll`, 1 s loop) | none | skip |
| Stall | docs/SYSTEMS_SOCIAL.md §4.3 decides: the owner plays SIT_DOWN → SIT (driven by `EntityState.stall`). `VENDOR01` (`chinaman_vendor01`, 13.3 s loop) exists but its use is [unknown] | dropped by `KEEP_CLIPS` | stall spec's |
| Revive | `REVIVAL` 1 s [unknown when] | none | skip |

### 3.13 Target circle and click marker

- **Target**: `Media effect/select_01..04.ddj` (128×128, four colours) projected flat on the ground under the target,
  radius = target radius + 0.25 m [confirmed textures; colour mapping unknown]. Our rule: 04 orange hostile mob,
  02 green NPC and party, 03 blue other player, 01 white ground item. Today: `TargetRing` torus + disc
  (`effects.ts:134`). The replacement is a ground decal (a disc mesh conforming to `heightAt`, 12 samples; alpha
  blend; slow spin 0.8 rad/s kept).
- **Click marker**: no retail asset identified [unknown]; our rule: the green `select_02` at 0.5 m radius shrinking
  and fading over 0.6 s (replaces the torus built inline in `screens/world.ts:295-301`).

### 3.14 Quest marks

Retail draws 3D marks from SYSTEM_EXCLAMATION_START/GOING/END and SYSTEM_QUEST_MARK rows: `res\etc\ex_mark_start.bsr`,
`ex_mark_going.bsr`, `ex_mark_end.bsr`, `system_questmonster_mark.bsr` at bone `*` + 0,5,0 [confirmed rows and
files]. Ours are DOM badges (`quests/markers.ts`). Whether to switch is the UI spec's call; the models are listed for
export (§5.3).

### 3.15 World ambient effects (Jangan)

The world objects of `jangan-fields` carry BSR `ambient` particles [confirmed, 444 object BSRs scanned]:

| Effect | Objects (count) | Night only |
|---|---|---|
| `map/frame.efp` torch/brazier fire | 31 (thief village, monastery door) + 6 day | 31 yes, 6 no |
| `map/cj_pal_lamp_orange_s`, `_red`, `_red_b`, `_light`, `map/light.efp` lamp glows | armour/stable/accessory shops, pub, restaurant, street stalls (~26) | yes, **except** the blacksmith's `cj_pal_lamp_red_b` / `cj_pal_lamp_orange_b` (3, on `cj_weapon.bsr` / `cj_weap_chimn.bsr`, flag 0: always on) [confirmed, fact-check of `res/bldg/china/jangan01`] |
| `map/oas_hot_etc_b.efp` smoke | `cj_weapon.bsr` (3), `cj_weap_chimn.bsr` (1) in `res/bldg/china/jangan01/` (the blacksmith) | no |
| `map/multigi`, `multugu-b`, `pajang`, `pokpopapyun`, `pokpomulbangul(-m)` water | waterfalls, water wheels | no |
| `map/cj_pal_potal_blue`, `w_cd_potal_blue_g`, `system/system_dungeonpotal` | portal stone, Qin-Shi tomb door | no |
| `map/w_cd_shri`, `frame2/3` | braziers, entrance fires | no |

Particle positions are in the building's file units (decimetres: the smoke on `cj_weapon.bsr` sits at raw y ≈ 81-98,
8-10 m up), converted like §5.2. Today none are drawn (`packages/world-render` has no particle path) [confirmed].
Night-only ones wait for a time-of-day (the world renders noon by default: `timeOfDay ?? 0.5` in
`packages/world-render/src/world.ts:352`, `apps/game/src/world/jangan/ground.ts:58`). **Weather**: vSRO 1.188 Jangan has no rain/snow
system in the data we export (environment.ifo is sky/fog/light only) [likely]; nothing to build.

### 3.16 New systems: animation hooks only

| System | Visual needs [tags] |
|---|---|
| Horses | docs/SYSTEMS_COMBAT.md §1 owns models, riding clips and the `cos` entity kind; this spec adds only SYSTEM_PET_APPEAR = `system/item_returnscroll.efp` (AT_LOOP) on summon and SYSTEM_COS_HPPOTION = `item_hpotion.efp` on a horse potion [confirmed rows] |
| Monster skills | §3.4 (engine and `cast` path: SYSTEMS_COMBAT §2) |
| Trade / stalls | SIT per SYSTEMS_SOCIAL §4.3; `booth.bms` not drawn there; VENDOR01 [unknown use] |
| Repair / durability | none in the world (UI only) [likely] |
| Alchemy | §3.10 glows; `drop_archemy*.bsr` drops |
| Guilds | none ≤ cap (guild war mark only) |
| Berserk | §3.9 |

---

## 4. Protocol additions (additive)

```ts
// packages/shared/src/protocol.ts

// P1: EntityState, items only (spawn of a fresh drop).
droppedAt?: number   // server ms the item hit the ground (spawnGroundItem time)
dropFrom?: Vec3      // where it was thrown from (the corpse point); absent for player drops

// P2: no new field here. docs/SYSTEMS_COMBAT.md §7.3 already specifies it: mob skills send `cast` (mob id) and
// `combat {skill: <MSKILL code>, instance, at, aoe}` like player skills. Nothing to add in FX-0.

// P3: a consumable's visual, to viewers of `id` (the user included), after a successful itemUse of a potion,
// herb, pill or vigor item. Not sent for return scrolls (itemCast covers them).
| { t: 'itemEffect'; id: number; item: string }

// P4: posture and emotes.
// ClientMessage:
| { t: 'sit'; on: boolean }                 // toggle sitting; moving, attacking or a skill stands you up
| { t: 'emote'; emote: EmoteKind }
// ServerMessage:
| { t: 'emote'; id: number; emote: EmoteKind }   // viewers of id
// EntityState (players): posture?: 'sit'; entityUpdate: posture?: 'sit' | 'stand'
export type EmoteKind = 'hi' | 'laugh' | 'greeting' | 'yes' | 'rush' | 'joy' | 'no'
export const EMOTE_KINDS: readonly EmoteKind[] = ['hi', 'laugh', 'greeting', 'yes', 'rush', 'joy', 'no']
// CLIENT_RATE_LIMITS: sit { perSecond: 2, burst: 4 }, emote { perSecond: 1, burst: 3 }
// GameplayRequest and GAMEPLAY_REQUESTS gain 'sit' | 'emote' (today's list, protocol.ts:585-599, has neither), so
// each gets exactly one actionResult. Refusals: 'dead', 'busy' (casting, trading, stalling, mounted).
// 'busy' is NOT in ActionFailReason today [confirmed protocol.ts]; SYSTEMS_COMBAT §7.4 and SYSTEMS_SOCIAL §2.2 also
// list it as "reused". The first wave-6 foundation to land adds it once; the others do not re-add it.
```

Rules: `sit` refused while moving/in combat/dead/mounted/stalling; sitting regenerates as the server's rules say
(none today). A `moveTo`, `attack`, `useSkill`, `pickup` or damage taken stands the player up (`entityUpdate posture
'stand'`). A stall owner sits because of `EntityState.stall` (SYSTEMS_SOCIAL §4.3), not `posture`; the client's idle
picks SIT when either is set. No name collides with protocol.ts or the two sibling specs [confirmed: `sit`, `emote`,
`itemEffect`, `posture`, `droppedAt`, `dropFrom` are unused]; server `emote` reuses the client `t` like `chat` does.

Client mapping (not wire): `itemEffect.item` → `ItemDef` (`packages/shared/src/content.ts`): `cureLevel` set →
our `status_cure` rule (pill); else `use.cooldownGroup` `'hp'` → SYSTEM_HPPOTION, `'mp'` → SYSTEM_MPPOTION,
`'vigor'` → SYSTEM_LIFE (the server's groups, `apps/server/src/item-use.ts:11`); anything else → SYSTEM_HPPOTION
when `use.hp`/`hpPct` is set, else none. Exported data today [confirmed `work/out/data/items.json`]: 6 potions each
in `hp`, `mp`, `vigor`; 5 pills (`category: 'pill'`, group `cure`, `cureLevel` set); 3 scrolls with no group.

---

## 5. Export additions

### 5.1 `work/out/fx/skills.json` v2 (`sro-fx-skills` version 2, additive: v1 readers keep working)

```ts
interface SkillEffectStageV2 extends SkillEffectStage {
  damageTypes: ('NOR' | 'CRI' | 'HWAN')[] | null  // col 5
  scale: 'CHAR_BASE' | 'MOB_BASE' | null           // col 6
  id: number                                       // col 7
  attach: number; trade: number                    // cols 8, 9
  createCount: number                              // col 11
  fade: { inMs: number; outMs: number }            // col 12 ("0,-1" -> outMs -1)
  param: [number, number, number]                  // col 15
  actOption: string                                // col 16, raw
  object: string                                   // already present; .bsr objects also get objectModel:
  objectModel?: { glb: string; sidecar: string } | null  // the converted glb of a .bsr object (arrows, hawk)
}
interface SkillEffectsV2 extends SkillEffects {
  priority: number; hideWeapon: boolean            // aniset cols 3, 5
  trail: { lengthMs: number; argb: [number, number, number, number]; op: 'ONE' | 'INVSRCALPHA'; texture: string | null } | null
  light: string | null                             // LIGHT_n
  twist: 'Roll' | 'Yaw' | 'Pitch' | null
  bleeds: boolean
  kind: 'player' | 'mob' | 'system'
}
interface FxSkillIndexV2 extends FxSkillIndex {
  version: 2
  lights: Record<string, { argb: [number, number, number, number]; timeMs: number; range: number; atten: number }>
  characters: Record<string, {                     // characterInfo, CodeName128 -> row
    size: number; damageBone: string | null; damagePos: [number, number, number]
    bloodType: string | null                       // effect key 'hiteffect/hit_2_redblood.efp'
    dieModel: { glb: string; sidecar: string } | null; ride: { glb: string; sidecar: string } | null
  }>
}
```

Groups: the Chinese masteries (as v1), plus every `MSKILL_*` in `MobDef.skills` of `mobs.json`, plus `SYSTEM_*`
rows. The MSKILL groups are **also** on SYSTEMS_COMBAT lane EXP's list (`packages/convert/src/fx/skills.ts`: MSKILL
groups); only one lane adds them: EXP adds them to v1 first, FX-X builds v2 on top (§6.2). `characters`: every
`CHAR_CH_*`, the `MOB_*` of `mobs.json` and the `NPC_*` of `npcs.json`. Trail textures `textures/mirage_texture_*.ddj`
are written to `fx/tex/textures/mirage_texture_*.png` by `export-fx.ts` (referenced keys only; `trail.texture` keeps
the Particles path `textures/mirage_texture_smash.ddj`, and the client URL is `/out/fx/tex/` + that path with `.ddj` →
`.png`, the rule the existing `fx/tex/textures/*.png` already follow).

### 5.2 Model sidecars

- `particles?: { set: string; kind: 'ambient' | 'status' | 'clip'; clip?: string; efp: string; bone: string | null;
  position: [number, number, number]; birthMs: number; night: boolean }[]` for every converted BSR with mod-palette
  particles (drops, mobs, NPCs, world objects). `efp` is the Particles key; `set` is the set name
  (`ambient`, `status_bad_burn`, …); `clip` is the aniSet's clip type for clip-bound sets. `position` is converted
  with `toGltfPosition` (`gltf/space.ts`: ×0.1, z mirrored), never copied raw (§3.6). Particles whose `.efp` is not in
  Particles.pk2 (`monster/system_appear.efp`, `mco_*`, `msk_waterghost_gas`) are dropped with a warning.
- `dummies?: Record<string, [number, number, number]>` for static resources with a skeleton (weapons, shields): the
  model-space glTF metres of each bone. Today the converter writes `joints: []` for them (`gltf/convert.ts:852`,
  `skin ? … : []`) [confirmed bones: `sword_01.bsk` and `spear_01.bsk` Bone01, Bone02, ai_start, ai_end;
  `blade_01.bsk` Bone01, ai_start, ai_end; `bow_01.bsk` and `shield_01.bsk` Bone01, Bone02 only (no trail dummies)].

### 5.3 Models to convert (a `fx` preset in `packages/convert/src/gltf/output.ts` `PRESETS`)

All files below exist in Data.pk2 [confirmed, fact-check; note the retail spelling `cha_arrow_lighting`].
`res/mob/china/banditarcher_arrow.bsr` is also in SYSTEMS_COMBAT lane EXP's preset: list it once.
`res/item/china/weapon/cha_arrow_normal.bsr`, `cha_arrow_{cold,fire,lighting,critical,chain}.bsr`,
`res/mob/china/banditarcher_arrow.bsr`, `res/npc/animal/whitehawk.bsr`, `res/item/etc/drop_ch_quest.bsr`,
`drop_ch_equip_rare.bsr`, `drop_ch_acc_rare.bsr`, `drop_archemy.bsr`, `drop_archemy_1.bsr`, `drop_archemy_bag.bsr`,
`drop_trade.bsr`, `res/mob/common/mangnyang_die.bsr`, `tombstone_die.bsr`, `res/etc/ex_mark_start.bsr`,
`ex_mark_going.bsr`, `ex_mark_end.bsr`, `system_questmonster_mark.bsr` (the last four only if the UI spec switches).

### 5.4 UI textures

- `Media interface/hitcount/*.ddj` (52) → `/out/ui/hitcount/*.png`: **docs/UI.md owns it** (§5.4 adds the
  `interface/hitcount` folder to `export-ui.ts` `SELECTION`, lane UI-X; §4.10 draws the digits in `hud/effects.ts`,
  lane UI-H). This spec only supplies the rules of §3.1.
- `Media effect/select_0{1..4}.ddj` → `/out/fx/tex/ui/select_0N.png`, written by `export-fx.ts` (FX-X) so that
  `export-ui.ts` (owned by UI-X) is not touched. UI.md does not export these [confirmed].

---

## 6. Build plan

Order (WAVE_PLAN shape): **FX-0 seams → FX-X, FX-S, FX-C1, FX-C2, FX-C3 in parallel → FX-I integration → hunt → fix**.
FX-C1/C2/C3 can start on v1 data and hand-made fixtures; they switch to v2 when FX-X lands.

**Cross-spec file map (fact-check).** Three sibling specs written in the same wave claim some of the same files.
The owned lists below are cut to stay disjoint; where a file is shared, the order is fixed here:

| File | Also claimed by | Rule |
|---|---|---|
| `packages/shared/src/protocol.ts`, `validate.ts` | SYSTEMS_COMBAT F6-FS, SYSTEMS_SOCIAL SOC-P | One protocol pass for the wave: the first foundation agent adds all three specs' types (P1, P3, P4 here), or FX-0 runs after them and appends. `busy` is added once (§4). |
| `apps/game/src/world/entities.ts`, `three/models.ts` | SOC-FC (`EntityView.setIdle`, `BaseClip += 'SIT'`), F6 (`kind: 'cos'`) | FX-0 **reuses** SOC-FC's `setIdle(clip, transition?)` and only widens the clip union with `'ATTREADY'`; it does not add a second `idle` field. Whichever FC lands first adds `setIdle`. |
| `apps/game/src/world/skill-fx.ts`, `skills-view.ts` | SYSTEMS_COMBAT lane MS-C (mob casters) | **MS-C first, FX-C1 after** (rebases on it). FX-C1 puts new logic in new `world/fx/*.ts` files and keeps `skill-fx.ts` edits to call sites. |
| `packages/convert/src/fx/skills.ts`, `gltf/output.ts` | SYSTEMS_COMBAT lane EXP (MSKILL groups, horse + `banditarcher_arrow` preset) | **EXP first**, then FX-X (v2 on top; the `fx` preset skips `banditarcher_arrow` if EXP's preset has it). |
| `apps/server/src/gameplay.ts`, `item-use.ts` | F6-FS one-line seams | FX-S after F6-FS; FX-S's edits are the two hook bodies named in §6.3 only. |
| `apps/game/src/hud/effects.ts`, `export-ui.ts` | docs/UI.md lanes UI-H, UI-X | **Given to the UI lanes**: damage-number sprites are UI-H's (UI.md §4.10). FX-C3 no longer owns `hud/hitcount.ts` or the `Floaters` switch. |
| `apps/game/src/screens/world.ts` | UI lanes, SOC-FC (ground-click veto) | FX lanes use `WorldFeature` hooks (`onMessage`, `onFrame`, `onEntityAdded`) and `ctx.addAttachment` instead; the only `world.ts` edits are FX-C3's marker/ring swap and FX-C2's removal of the `levelUpColumn` call (§6.5, §6.6). |
| `apps/game/src/world/features.ts` (`WORLD_FEATURES`) | SOC-FC, F6 | Append-only: one line per feature; the integrator merges. |
| `apps/game/src/world/drops.ts` | SYSTEMS_COMBAT §4.6 (alchemy drop sparkle) | FX-C2 owns it; alchemy drops come for free through `dropModel` + sidecar `particles` (`drop_archemy_1.bsr` carries `item/drop_archemy.efp`), so lane AL needs no edit. |

### 6.1 FX-0: protocol and seams (one agent, first, small)

Owned: `packages/shared/src/protocol.ts`, `packages/shared/src/validate.ts` (P1, P3, P4 types, validators, rate
limits, `GameplayRequest` += `'sit' | 'emote'`, `ActionFailReason` += `'busy'` unless a sibling foundation added it),
`apps/game/src/three/models.ts`, `apps/game/src/world/entities.ts` (seam lines only; see the cross-spec map above),
new `apps/game/src/world/fx/types.ts`.

Seam contents:
- `models.ts`: `KEEP_CLIPS` (l.51) adds `PICK|DEFENCE|DAMAGE2|STAND3|STAND4|TURN_[LR]|REVIVAL|VENDOR01` (with `(_.*)?`)
  and mob `HELP|FIND`; `CharacterActor.setWeaponVisible(on: boolean)` (hides worn weapon/shield/fallback meshes);
  `CharacterActor.weaponDummy(name: 'ai_start'|'ai_end'|string): TransformNode | null` (child nodes created from the
  sidecar `dummies` in `hangOnSocket`, l.665); `playOverlay(type: string)` (partial one-shots: DEFENCE, STAND3);
  `idleVariants(): string[]`; `onClip?: (name: string) => void` (lab hook); `die(instant, clip?: 'DIE1'|'DOWN_DIE')`
  (l.863) followed by DIE1_RM when present.
- `entities.ts`: `EntityView.attack(target, hits, nowMs, opts?: { clip?: string })` (l.385; a named clip instead of
  the cycle); the idle is SOC-FC's `EntityView.setIdle(clip, transition?)` with the clip union widened to
  `'STAND1' | 'SIT' | 'ATTREADY'` (no separate `idle` field). No drop slot: FX-C2 keeps `DropVisual`'s public API
  (constructor, `update`, `setPickable`, `dispose`), so `entities.ts:489` does not change, and sparkles/idle
  variants hang on views through `ctx.addAttachment` (`features.ts:58`), the existing attachment seam
  (`EntityAttachment`, `entities.ts:34`).
- `world/fx/types.ts`: `FxStageV2`, `FxSkillV2`, `FxCharacterInfo`, `SystemFxKey` union
  (`'SYSTEM_LEVELUP'|'SYSTEM_APPEAR'|'SYSTEM_HPPOTION'|'SYSTEM_MPPOTION'|'SYSTEM_LIFE'|'SYSTEM_RETURNSCROLL'|
  'SYSTEM_RETURNSCROLLRESULT'|'SYSTEM_CH_HWANMODE'`), `FxLabEntry`.
- Tests: `packages/shared` validator cases for the new messages; `apps/game/test/seams-fx.test.ts` (KEEP_CLIPS keeps
  the new names, `setWeaponVisible` toggles every worn mesh, `attack({clip})` plays that clip).

### 6.2 FX-X: export (convert)

Owned (new unless noted): `packages/convert/src/fx/skilleffect.ts` (parse all four sections: characterInfo, light
from SE-R, skillaniset2, skilleffectset, with every column), `packages/convert/src/fx/skills.ts` (v2 builder: mob and
SYSTEM groups, characters, lights, objectModel lookup), `packages/convert/src/fx/model-fx.ts` (BSR mod palette →
`particles`), `packages/convert/src/tools/export-fx.ts` (trail textures, select textures → `fx/tex/ui/`, v2 index),
`PRESETS.fx` in `packages/convert/src/gltf/output.ts` (l.12; after EXP's preset entry), tests
`packages/convert/test/fx-skilleffect.test.ts`, `packages/convert/test/fx-skills-v2.out.test.ts`.
Starts after SYSTEMS_COMBAT lane EXP has merged its MSKILL groups into `fx/skills.ts` (cross-spec map).
Hook points: `packages/convert/src/gltf/convert.ts` sidecar writer (`particles`, `dummies`; the `skeleton:` line,
l.851-853). No `export-ui.ts` edit (§5.4).

Tests: synthetic rows for every column (the `-` continuation rows, `//` commented rows skipped, `none`, `0,-1`
fades); v2 out-test: the 34 Chinese groups keep their v1 stages byte-equal; `SKILL_CH_SWORD_SMASH_A.trail =
{lengthMs:120, argb:[200,255,255,255], op:'ONE', texture:'textures/mirage_texture_smash.ddj'}`;
`COLD_GANGGI_A.hideWeapon === true`; exactly 12 groups ≤ cap have `hideWeapon`; `MSKILL_CH_TOMBSTONE_ATTACK02` has two
flight rows, the DMG one with `trade: 1`; `characters.MOB_CH_TIGER.damagePos` = [0,11,-13]; `characters.CHAR_CH_MAN_ADVENTURER.size`
= 2; the drop_ch_money_small sidecar has `particles[0].efp === 'system/item_drop_money.efp'`; the drop_ch_equip
sidecar's second particle position ≈ [0, 0.134, 0.0025] (converted, §5.2); the tombstone sidecar has no `particles`;
sword_01 has `dummies.ai_end`, bow_01 has none.
User check: `pnpm tsx packages/convert/src/tools/export-fx.ts` then open `/out/fx/skills.json` and see `version: 2`.

### 6.3 FX-S: server (small)

Owned (after F6-FS's seams, cross-spec map): in `apps/server/src/gameplay.ts`, the body of `spawnGroundItem` (l.449;
P1 `droppedAt`, plus an optional `from?: Vec3` argument) and its call in `mobDied` (corpse point `livePoint` l.895,
call l.898), plus one entry in the module list of the `Gameplay` constructor (`this.modules = [...]`, l.242; that is
where modules are registered, **not** `modules.ts`, which only defines `GameplayModule`/`buildRoutes`);
`apps/server/src/item-use.ts` (P3 `itemEffect` broadcast after a successful potion/pill use, next to the existing
`broadcastAbout(p, { t: 'itemCast', … })` pattern, l.139); new `apps/server/src/posture.ts` (P4 sit/emote module);
`apps/server/test/posture.test.ts`.
P2 (mob skills) is SYSTEMS_COMBAT's lane MS-S; until it lands, mob combat stays skill-less and the client keeps the
cycle.
Tests: `droppedAt` equals the kill tick; `itemEffect` reaches viewers and not strangers out of view; sit refused
while moving; `moveTo` stands up; emote rate limit.

### 6.4 FX-C1: skill and combat presentation (client)

Owned (starts after SYSTEMS_COMBAT lane MS-C has merged; cross-spec map): `apps/game/src/world/skill-fx.ts`,
`apps/game/src/world/skills-view.ts` (call sites only; MS-C's mob-caster path stays as it lands),
`apps/game/src/world/features/skills.ts`,
`packages/fx/**`, new `apps/game/src/world/fx/trail.ts` (`WeaponTrail`), new `apps/game/src/world/fx/anchors.ts`
(`damagePoint`, `stageAnchor`, MOB_BASE scale), new `apps/game/src/world/fx/fx-model.ts` (`.bsr` objects: arrows,
nocked arrow, hawk), new `apps/game/src/world/fx/hit-light.ts`, tests `apps/game/test/skill-fx.test.ts` (extend),
`apps/game/test/effects-retail.test.ts` + `apps/game/test/fixtures/effects-golden.ts` (H1).

Work: M1-M22 of §2.4 and §3.1-§3.4:
- `WeaponTrail`: one ribbon per attacking actor, sampled every frame between `weaponDummy('ai_start')` and
  `weaponDummy('ai_end')` world positions; keeps samples younger than `trail.lengthMs`; U = age/length, V = 0 tip /
  1 hilt; colour = argb/255; additive for `ONE`, alpha for `INVSRCALPHA`; texture `/out/fx/tex/<trail.texture>.png`;
  active from the SHOT start (basic: the ATTACKn start) to the clip end; the imbue's trail (priority 2) or Berserk's
  (10) replaces the row's while the attacker carries it. No dummies → no trail (fallback: skip, warn once).
- Hit path (`SkillFx.hit`): DMG rows (caster-anchored once per `(instance, cue)`) → DamageEfp at `damagePoint` →
  blood (`bleeds`, landed, BloodType, `_down` when knocked down) → DefenseEfp of the victim's shield buff → imbue
  DamageEfp → hit light.
- `.bsr` objects through `fx-model.ts` (loads `objectModel.glb` with the ModelLibrary): nocked arrow LOOP ID1, Trade
  into the flight; arrow flights draw the arrow glb + tail + force; hawk ACT_L.
- Mob attacks: the `cast` path (MS-C) plays the clip; FX-C1 adds the MSKILL stages, DamageEfp, blood, the
  tombstone/yeoha Trade flights and the bandit arrow model. Fallback when a mob `combat` has `skill` but no
  `instance`: `EntityView.attack(target, hits, now, {clip})` with the aniset clip.
- Berserk: when a hit carries `hwan: true` (SYSTEMS_COMBAT §7.1), the HWAN DamageEfp and trail (priority 10).
- Heal/cure/resurrect ACT_S on the target at the release (M6); Hide Weapon (M7) via `setWeaponVisible`; Kill/Trade/
  Fade by ID (M15); MOV_PIERCE (M16); DOWN_DAMAGE/DOWN_DIE (M20); chain slashes per segment (M21); per-program caps
  (M22); status visuals from mob BSR sets (§3.2).
- Lab hooks: `SkillFx.onSpawn?(e: FxLabEntry)`.

Tests: the existing skill-fx suite passes; new unit cases: caster-anchored DMG row plays once with 3 victims; Kill 1
ends only ID 1 loops; Trade moves the live loop into the flight (one instance, not two); DefenseEfp on a buffed
victim; heal ACT_S on the target at release and not after `castEnd`; trail samples cleared after `lengthMs`; H1.
User checks: §6.8 items 1-12.

### 6.5 FX-C2: world, system effects, drops, idle (client)

Owned: `apps/game/src/world/drops.ts` (rewrite behind the same `DropVisual` API, so `entities.ts` is untouched), new
`apps/game/src/world/fx/system-fx.ts` (`SystemFx.play(key: SystemFxKey, phase, view)` on top of `@sro/fx`:
level-up, appear, potions, return scroll; the Berserk rows are played by lane BZ's `world/features/berserk.ts`
through it), new `apps/game/src/world/fx/model-particles.ts` (sidecar `particles` → FxInstances on a model: drop
sparkles, NPC clip smoke, Yeoha's glow, mob status-set lookup; hung on views with `ctx.addAttachment`), new
`apps/game/src/world/idle.ts` (NPC variants, combat stance, fidget; an `EntityAttachment` calling `setIdle` /
`playOverlay`), new `apps/game/src/world/features/fx-world.ts` (a `WorldFeature`: `onMessage` for `levelUp` →
SystemFx, `itemEffect`, `itemCast`/`itemCastEnd`, `warp`/`worldEnter` appear, `emote`, and `actionResult {re: 'pickup', ok: true}` → PICK on yourself; `onFrame`),
new `apps/game/src/world/features/posture.ts` (sit key N, `/sitdown`, emote commands `/hi` …), one append-only
line each in `apps/game/src/world/features.ts` `WORLD_FEATURES`, the removal of the `levelUpColumn` call in
`screens/world.ts` (`case 'levelUp'`, l.691-695; its banner and sound stay), `packages/world-render/src/ambient-fx.ts`
(new) + hook in `packages/world-render/src/objects.ts` (world object particles, night flag vs `timeOfDay`), tests
`apps/game/test/drops.test.ts`, `apps/game/test/system-fx.test.ts`, `apps/game/test/idle.test.ts`,
`packages/world-render/test/ambient-fx.test.ts`. The death sequence (DIE1 → DIE1_RM, Die Bsr swap) goes through the
FX-0 `die(instant, clip)` seam, not an `entities.ts` edit.

Rules: §3.5-§3.8, §3.11-§3.12, §3.15. Drops: `ItemDef.dropModel` glb (gold by code), its sidecar particles, toss when
fresh (P1), ATTREADY then STAND1 for equip/acc, seeded yaw, no spin/bob/beam; the fallback for items without a
dropModel is `drop_ch_quest` (custom quest items) then today's box. SystemFx caps each program at its duration.
N100 budget: ≤ 40 ambient instances live (nearest first within 60 m), drops' sparkles ≤ 30.
7B-fix [our rules]: a fresh drop thrown from a victim still `dying` is held hidden at the corpse until the killing
blow is shown (1.5 s at most), so the loot never lands before the mob falls. Sparkle slots are handed out by
`DropAssets`: a freed slot (pickup) or a raised preset budget goes to the nearest drop still waiting, a lowered budget
stops the farthest. NPC/mob model ambient particles follow the preset's ambient cap too (none on Low). A move cuts
SIT_DOWN / STAND_UP / emotes / idle fidgets short (RUN at once), and a seated victim dies from the seat.

Tests: gold code → model path; fresh vs old drop (toss or not); level-up plays `system/system_levelup.efp` for 7.2 s
and disposes; return scroll loop starts on `itemCast` and stops on `itemCastEnd`; NPC variant scheduler never plays
two variants in a row (seeded); sit → SIT_DOWN, SIT loop, STAND_UP on `posture 'stand'`; night-only particles off at
noon.

### 6.6 FX-C3: combat feedback widgets (client)

Owned: `apps/game/src/world/effects.ts` (`TargetDecal` replacing `TargetRing`, l.134, with the same
`show(tone, radius)` / `hide()` / `update(dt, x, y, z)` / `dispose()` API; a `ClickMarker` class), the marker swap in
`screens/world.ts` (the torus is built inline at l.295-301 and driven at l.680, l.919-920 and l.1046-1048: those
lines become `ClickMarker` calls; the `new TargetRing(scene)` at l.232 becomes `new TargetDecal(scene)`), tests
`apps/game/test/target-decal.test.ts`. Textures: `/out/fx/tex/ui/select_0N.png` (§5.4).
Damage-number sprites are **not** FX-C3's: docs/UI.md lane UI-H owns `hud/effects.ts` (UI.md §4.10) and draws them
with §3.1's colour rules. FX-C3 lands its `world.ts` edit before or after the UI lanes' `world.ts` edits, never in
parallel (integrator's order).

### 6.7 FX-I: integration, lab, hunt

Owned: new `apps/game/src/debug/fx-lab.ts` (H2; the `debug/` folder is new), an `fxlab` flag in
`apps/game/src/params.ts` (`readParams`, mock only like `gm`), and its one-line registration in
`apps/game/src/main.ts` (which already calls `readParams()`, l.22).
Run H1 and H2, fix drift, then the adversarial hunt: 1,000 casts per line with random cancels (no leaks, no stuck
loops, no hidden weapons after `castEnd`), 50 drops at once (frame time), a mob dying mid-flight of an arrow, a
carrier despawning mid-loop, enter-view during a cast.

### 6.8 Visual checklist (user, in the browser)

Set up: `pnpm game`, `?mock=1&auto=1&gm=1`, `/skill all`, stand next to Mangnyangs south of Jangan.

1. Sword basic attack: a faint white trail follows the blade on each swing; a spark and a small red blood burst at
   the Mangnyang's chest, in front of it, not inside.
2. Strike Smash: the bright smash trail, the diagonal slash in front of you, a red light flash.
3. Illusion Chain: three slashes and three trails; stop the chain early (walk away): no leftover slashes.
4. Wolf Bite Spear on two mobs in a line: one thrust effect, two sparks.
5. Ghost Spear - Petal among 5 mobs: one spin effect around you (not five stacked).
6. Anti Devil Bow: an arrow sits on the string during the draw, leaves the hand as a real arrow with a trail and a
   glowing head, hits with a spark.
7. White Hawk Summon: a white hawk circles above your head while the buff lasts.
8. Weak Guard of Ice: your sword disappears during the cast and comes back; when a mob hits you, an ice shard effect
   shows on you.
9. Ice River Force: an icy blue trail on your swings and an ice burst on each hit; no glowing strips on the blade.
10. Heal - Medical Hand on a party member: the heal effect plays on them at the release.
11. Tombstone and Yeoha: their force attacks fly at you; the bandit archer's arrow leaves its hand.
12. Freeze a mob with Ice River Force: ice forms on it and breaks when it ends; stun: stars over the head.
13. Kill a Mangnyang: it falls, lies still, fades after about 3 s; gold drops as a coin pile with a soft glow (not a
    cylinder or a beam); equipment drops as a bundle that bounces once then twinkles yellow; potions twinkle red.
14. Pick up: your character bends down (PICK) and the icon flies to the bag.
15. Drink an HP potion: a red swirl on you; a friend sees it too.
16. Read a return scroll: the scroll effect loops while the bar fills; a flash where you stood; an appear effect in
    town.
17. Level up (GM `setlevel <you> <n+1>` from the GM window): the retail level-up column for about 7 s.
18. Target a mob: an orange ornate circle on the ground under it; an NPC: green; click the ground: a small green
    circle that shrinks.
19. Damage numbers (delivered by docs/UI.md lane UI-H with §3.1's rules): white retail digits on the mob, red digits
    on you, "Critical" and "miss" as images.
20. Town: the blacksmith's chimney smokes; the Herbalist and Blacksmith sometimes play their second idle; the shaman
    puffs pipe smoke when he plays his second idle (about 3 s into it); press N to sit and stand; `/hi` waves
    (EMOTION01).

---

## 7. Open questions and risks

- **Which skilleffect the client reads** (server_dep vs resinfo). The rows used here agree; if they diverge on a row,
  server_dep wins (the exporter's source).
- **Bone rotation vs caster facing** for bone-anchored effects (M17): settle with one retail capture of Wolf Bite
  Spear and Soul Cut Blade; the lab renders both rules.
- **Trail length unit** (80/120/160): ms is our rule; if trails look too short, try "number of samples at 60 Hz".
- **DamagePos frame**: victim-local is our rule; a capture of a tiger hit settles it.
- **Force circle offset** `0,0,4` lands behind the caster by the coordinate rule; check in the lab.
- **Emote clip mapping**: now taken from the `.ban` names (§3.12) [likely]; confirm in the viewer. The meaning of
  itemoptionefp col 5 (`8` on every row) is unknown; it is not a +level threshold (header: a scale factor).
- **Cross-spec order** (fact-check): FX-C1 after MS-C, FX-X after EXP, FX-S after F6-FS, one shared protocol pass,
  SOC-FC's `setIdle` reused (§6 map). If the integrator runs the waves in another order, these owned lists must be
  re-cut before any lane starts.
- **BSR particle units**: positions are treated as decimetres (the building evidence in §3.15); drop sparkles at
  0.1 m look right in the lab, 1.3 m would float over the model. Check both in the FX lab if a sparkle looks wrong.
- **Missing retail particles**: `monster/system_appear.efp`, `mco_sys_appear.efp`, `mco_wrong_frostbite.efp`,
  `msk_waterghost_gas.efp` are referenced by BSRs but absent from Particles.pk2; model-fx drops them with a warning.
- **Performance** on the N100: trails (one ribbon per swinging actor, ≤ 48 samples), hit lights (≤ 4 live, pooled),
  ambient particles (≤ 40) and drop sparkles (≤ 30) need the W5-P budget check; each has a quality switch.
  I7B: the switches are `apps/game/src/world/fx/quality.ts` (Options → Graphics → preset): high = trails, 2 hit
  lights, 40 ambient, 30 sparkles; medium = trails, lights, 20 ambient, 15 sparkles; low = no trails, no lights, no
  ambient, 8 sparkles. The level-up column and the other SYSTEM_* one-shots always play. Measured on the dev PC
  (JS frame time, 5 players + ~20 mobs in view): 6.7 ms idle, 8.7 ms mean / 10.7 ms p95 under constant skill spam,
  7.5 ms during the level-up column; ×2.5 for the N100 gives about 17 / 22 / 19 ms [projected, not measured there].
  G-11 (wave 11 final gate): `otherHits` caps the hit effects (DMG rows, spark, blood, defense and imbue bursts, the
  hit light) of fights the own character is not in at 12 live on Medium and 24 on High and Ultra; Low keeps no cap (the
  Low guard). A hit over the cap shows its numbers and sounds, not its effects; hits by or on the own character always
  play. Reason: 20 players at a world boss kept about 40 nine-emitter `hit_2_redblood` / `hit_3_normal` effects alive,
  about 9 ms of a Medium WebGPU frame on the dev PC (interleaved A/B: p95 26.1–26.8 ms capped, 33.7–36.3 uncapped).
- **Ownership overlap**: resolved in §6's cross-spec map: `hud/effects.ts` and `export-ui.ts` go to the UI lanes;
  FX's `screens/world.ts` edits shrink to the ring/marker swap (FX-C3) and one removed `levelUpColumn` call (FX-C2),
  with the rest done through `WorldFeature` hooks.
