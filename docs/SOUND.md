# Sound

This document covers the retail client's sound effects and ambience, how the client data wires them to animations,
combat, UI and places, what we ship to the browser, and the runtime that plays them. It ends with a build plan.

Tags: **[confirmed]** checked in the vSRO 1.188 data or in our code; **[likely]** strong evidence, not proven;
**[unknown]** open. Numbers come from one-off census scripts run on `work/extracted/` (2026-09-27); the export tool
(§4) re-measures them into `sound/index.json` `report`.

> **Fact-check pass (2026-09-27).** Every number, path, id and hook point below was re-measured against
> `work/extracted/`, `work/out/data/*.json` and the current code. Corrected items: the other-mob folder totals (§1.1),
> Music.pk2 size (§1.1), the Jangan BSR census and event counts (§2.1), the non-existent `sound\` path prefix (§2.1),
> effectsound row/object counts, volumes and `blank` values (§2.2), the stage-row count (§2.3), footstep `event2`
> casing (§2.4), PUNCH hit rows (§2.6), gzip numbers and the preload size (§3, §5.4), `characters.json` field names
> (§4.1), and several runtime hook details (§5.6-§5.11, §6: clip restarts, DIE1, handedness, gold-drop hook, missing
> hook points). Corrections are marked *(fact-check)*.

Nothing here touches the wire protocol. Sound is decided entirely on the client, from messages that already exist
(`combat`, `levelUp`, `spawn`, `actionResult`, `move`) and from the SKILLS.md §10.2 `cast` message once it lands.

---

## 0. Decisions in one screen

| Topic | Decision |
|---|---|
| Source | `Data.pk2` `prim/snd/**` (2,159 PCM WAVs). Wiring: BSR sound sets (per animation clip), `effectsound.txt` (hits, voices, UI, items, skill overrides, footstep surfaces), `skilleffect.txt` cols 26/27 (buff/force stage sounds), `regioninfo.txt` + `effectenvsnd.txt` (music and ambience per area). |
| Scope | Jangan only: the 26 Chinese player models, the 32 Jangan mobs, the 46 NPCs, the Chinese skills, UI/items, the 22 footstep files, Jangan town/field ambience. About 590-600 files, ~29 MB PCM (589 / 28.95 MB in the author's run; a fact-check recount of the §4.2 union rules gives 603 / 29.30 MB). |
| Format | **Ogg Opus, mono, 48 kbps** (ambience 64 kbps), encoded by `ffmpeg` (8.1.1 with libopus, on PATH on the dev box). 3.93 MB for the whole Jangan set (13.6% of PCM). Fallback without ffmpeg: trimmed mono PCM `.wav` (~29 MB). |
| Export | `packages/convert/src/tools/export-sound.ts` → `work/out/sound/<folder>/<name>.ogg`, `work/out/sound/index.json`, `work/out/sound/model/<CodeName128>.json`. Served at `/out/sound/` like `/out/music/`; deploy already syncs `work/out`. `optimize-out` copies it unchanged. |
| Keys | Content is keyed by **CodeName128** (`CHAR_CH_MAN_ADVENTURER`, `MOB_CH_MANGNYANG`, `SKILL_CH_SWORD_SMASH_A`) and by clip names exactly as the sidecars name them (`ATTACK1_sword_base_01`). Files are keyed by their lower-case path under `prim/snd` without extension (`player/mvwalkgrass`). |
| Runtime | Own thin WebAudio layer in `apps/game/src/audio/**` (not Babylon AudioEngineV2, §5.1). Buses master → music / sfx / ui / ambient, volumes in `localStorage`. Lazy fetch + decode cache, voice limiter, `PannerNode` spatial sfx heard from the player, animation-synchronized clip tracks polled from the playing `AnimationGroup`, footstep surface from the terrain tile type or "object floor", town/field ambience next to the existing town/field music, mute while the tab is hidden. |
| Protocol | No additions. |

---

## 1. What the retail client has

### 1.1 Where the files are [confirmed]

- **Sound effects:** `Data.pk2` → `prim/snd/<folder>/*.wav`. 2,159 files, 173.7 MB, 3,073 s (51 min). Every file is a
  RIFF/WAVE. There are no sound files in `Media.pk2`, `Map.pk2` or `Particles.pk2`.
- **Music:** `Music.pk2` root, 45 `.ogg` files (60.1 MB = 57.3 MiB, measured on `work/extracted/Music`) *(fact-check: was 58.8 MB)*, including 7 Korean-named files (`장안.ogg`, `장안필드.ogg`, ...).

| Folder | Files | MB | Seconds | Contents |
|---|---:|---:|---:|---|
| `player` | 388 | 9.26 | 206 | Footsteps `mv{walk,run}<surface>`; weapon swings `bat<weapon>swing*`; weapon hits `bat<weapon>hit{1,2}{n,b,a}`, `batcrihit`, blocks `batblock*`; Chinese voices `vcm_*` (male) / `vcf_*` (female) with costume letters `at`..`gt`; European `vum_*`/`vuf_*` |
| `monster` | 427 | 24.70 | 559 | Chinese/West China/Taklamakan mobs, `<prefix>_<mob>_{walk,shout,moan,die,thud,stand,...}` (`cm_mang_*` = Mangnyang) |
| `skill` | 74 | 6.44 | 135 | Chinese skills `csk_<line>_*` (`csk_sword_swing_a`, `csk_sword_hit_c`, `csk_cold_binghon`) |
| `skill2` | 166 | 11.52 | 240 | European skills `usk_*` |
| `ui` | 78 | 5.04 | 98 | `uibutton_{a,b}`, `uiwinopen/close`, `error`, `biff`, `itlevelup`, `itpickup`, `itgold`, equip sounds `it<type>`, `itpotiondrink`, quest, alchemy, gacha |
| `env` | 37 | 16.69 | 290 | Ambient loops and one-shots: `day_wind`, `day_bird01..05`, `night_*`, desert winds, sea |
| `common` | 47 | 2.80 | 53 | Shared swings `swordswing*`, explosions, buff stingers |
| `emoticon` | 40 | 1.06 | 24 | Emote voices, sit/stand |
| `cos` | 113 | 5.35 | 113 | Pets, horses, transport animals |
| `mob_god`, `mob_sd`, `mob_roc`, `mob_fort`, `tq_mob`, `am_mob`, `ca_mob`, `eu_mob`, `event_mob` | 724 | 83.3 | 1,214 | Other regions' mobs (out of scope) *(fact-check: was 1,189 / 107.8 / 1,772, which does not sum to 2,159)* |
| `etc`, `event`, `firework`, `avatar`, `bldg` | 65 | 7.6 | 142 | Rain/lightning, events, fireworks |

### 1.2 Formats [confirmed]

All 2,159 are format tag 1 (integer PCM). No ADPCM, no MP3-in-WAV.

| Channels | Rate | Bits | Files | MB |
|---|---:|---:|---:|---:|
| mono | 22,050 | 16 | 1,487 | 82.4 |
| mono | 44,100 | 16 | 333 | 58.2 |
| mono | 24,000 | 16 | 320 | 21.2 |
| stereo | 22,050 | 16 | 8 | 6.7 |
| stereo | 44,100 | 16 | 4 | 4.3 |
| mono | 44,100 | 24 | 4 | 0.9 |
| mono | 22,050 / 11,025 | 8 | 3 | 0.05 |

988 files carry extra chunks (`LIST`, `cue `, `bext`, `JUNK`, `smpl`, `CDif`...). Browsers ignore them, and the
exporter drops them. The longest file is `env/hellfire.wav` (60 s); in scope the longest are
`skill/csk_heal_buhwal_a.wav` (11.8 s) / `_b` (11.1 s) when the resurrection skill is exported, `env/day_bird04.wav`
(10.1 s) and `env/night_wind.wav` (9.2 s). The `env/day_wind.wav` loop is 6.0 s (mono 22.05 kHz).

### 1.3 Music (already shipped) [confirmed]

- `packages/convert/src/tools/export-ui.ts` copies `maintheme_cut.ogg`, `jangan_town.ogg`, `jangan_field.ogg` from
  `work/extracted/Music` (else `Music.pk2`) to `work/out/music/` unchanged and lists them in `work/out/ui/index.json`
  `music` (`{ jangan_town: 'music/jangan_town.ogg', ... }`). They are Ogg Vorbis, 44.1 kHz stereo, ~64 kbps.
- `apps/game/src/audio.ts` `Music` plays them with `HTMLAudioElement`, unlocks on the first `pointerdown`/`keydown`,
  cross-fades over 900 ms and remembers mute in `localStorage['sro.muted']`.
- `apps/game/src/screens/world.ts` `updateMusic()` already switches `jangan_town` / `jangan_field` with the town safe area
  (`world/jangan/zones.ts` `townAt`, 8 m hysteresis), about once a second.

Sound follows the same conventions: exported under `work/out/sound/`, listed in its own manifest, served from `/out/`,
never bundled into `apps/game`.

---

## 2. How the retail data references sounds

Five sources, each covering a different trigger:

| Trigger | Source |
|---|---|
| Something happens inside an animation clip (footstep, swing, shout, moan, death voice, body thud, pickup) | BSR sound sets, per model and clip, with a key time (§2.1) |
| A hit lands on a victim, a crit, a block | `effectsound.txt` `SND_DMG` / `SND_CRIDMG` / `SND_BLOCKING` rows (§2.2, §2.6) |
| A skill stage starts (buff lands, force charge loop) | `skilleffect.txt` skilleffectset cols 26/27 SndBegin/SndEnd (§2.3) |
| Footstep surface | `effectsound.txt` `PLAYER SND_WALK1/SND_RUN1` rows by tile type (§2.4) |
| UI, items, level up | `effectsound.txt` `UI` / `ITEM` rows (§2.2) |
| Area music and ambience | `regioninfo.txt` + `effectenvsnd.txt` (§2.5) |

### 2.1 BSR sound sets [confirmed]

`packages/formats/src/bsr.ts` already parses them (ModData tag `sound` = `0x00050000`, `BsrModDataSound`).

- A BSR's mod palette has **system sets** and **ani sets**. A set holding a `sound` mod has `sets[]` of
  `{ name, tracks: { path, keyTimeMs, event }[] }` (null slots where `hasValue` = 0).
- **Ani sets** (`type` SIMPLE) are keyed by **(aniGroup name, ResourceAnimationType)**: set name `'sword'` +
  `animationType` 2 (ATTACK1) = the tracks of the sword group's ATTACK1 clip. The sound mod inside holds one inner
  set named `'default'` [confirmed on chinaman_adventurer, mangnyang].
- **LOCOMOTION system sets** are keyed by **BAN base name** (`'chinaman_bogy_runforward'`), for costume-specific
  walk/run clips (chinaman_adventurer.bsr carries 28 of them, for the other costumes' BANs).
- `path` is a Data.pk2 path (`prim\snd\player\mvrunground.wav`). *(fact-check)* No track in any of the 5,563 BSRs
  has a `sound\` prefix (every path starts `prim\snd\`), despite the comment in `bsr.ts`; the resolver may still
  strip one defensively. The real path defects are wrong folders (`prim\snd\swing\...`) and missing files. `keyTimeMs`
  is from the clip start at speed 1. `event` names the slot (`snd_walk1`, `snd_swing_s1`, `voc_shout2`, ...); it is the
  lower-case form of the `effectsound.txt` handle (`SND_WALK1`, `SND_SWING_S1`, `VOC_SHOUT2`).
- The sound mod also carries a config block: `flags` 0x90 or 0xC0, `int6` 3, `float0` 10, `float1` 100 on every
  Jangan model. 0x10/0x40/0x80 read like DirectSound `CTRL3D/CTRLPAN/CTRLVOLUME`, and 10/100 like min/max distance
  (units unknown). [unknown] Not used; §5.6 picks its own distances.

**Census.**

*(fact-check: the Jangan column was re-measured. The 104 codes of `characters.json` (26), `mobs.json` (32) and
`npcs.json` (46) use 100 distinct BSRs: 26 + 30 + 44. The old column (120 BSRs, 76 / 13,598 / 438 / 232 / 36) could not
be reproduced. The all-BSR column reproduces exactly.)*

| | All 5,563 BSRs | Jangan scope (26 players, 32 mob codes, 46 NPCs: 100 distinct BSRs) |
|---|---:|---:|
| BSRs with sound | 398 | 56 |
| Tracks (non-empty) | 30,866 | 12,511 |
| Empty slots | 858 | 378 |
| Distinct files | 1,230 | 219 |
| Files that do not exist at the stored path | 87 | 31 |
| ... of which fixed by the unique-basename fallback (files / track refs) | 28 / 539 | 10 / 64 |
| ... still unresolved (files / track refs) | 59 / 884 | 21 / 292 |

The unresolved paths are of three kinds:
1. A wrong folder whose basename is unique elsewhere (`prim\snd\swing\swordswing1.wav` → `common/swordswing1.wav`,
   `swing\batspearswing1.wav` → `player/`). A unique-basename fallback fixes them (numbers above).
2. Files that simply do not exist (`monster/cm_mang_moan2.wav` on Mangnyang DAMAGE2, `wchina_jombie_*` on Hyungno,
   `cm_yeoha_*`, `cm_tombstone_shout`, `player/vcf_at_shout1_b` / `vcf_at_shout2_a`, `skill/csk_bow_swing_a`,
   `dd.wav`). Dropped and listed in the report.
3. Typos (`mvfrunground`). Dropped.

**Event names** in scope (counts, re-measured): `snd_swing_s1` 5,036, `voc_shout2` 1,522, `snd_swing_s2` 1,522,
`snd_run` 870, `snd_swing1` 776, `voc_shout1` 573, `snd_walk1` 455, `snd_swing2` 439, `snd_walk` 431, `snd_run1` 255,
`voc_emo` 194, `voc_moan` 112, `snd_swing_s` 104, `voc_death` 55, `snd_death` 53, empty 52, `snd_blocking` 26,
`snd_pickup` 26, `snd_stand` 6, `snd_shout1/2` 1 each, `voc_moan1/2` 1 each. Across all BSRs the rarer names also
occur: `snd_run2/3`, `snd_walk2/3`, `snd_stand1..3`, `snd_swing3/4`, `snd_death1/2`, `snd_swing_1`, `snd_swign1/2`,
`snd_helf`, `snd_find`, `voc_shout`, `voc_shot2`, `snd_down`, `voc_down`. They collapse to the `SoundHandle` kinds of
§4.3 (`snd_down`/`voc_down`/`snd_stand3` → `other`/`idle` as the table there says).

**Joining tracks to our clips** [confirmed on chinaman_adventurer and mangnyang]. Sidecars (`work/out/<cat>/<path>.json`)
list every clip in `animations[]` as `{ name, group, type, typeName, ban, banName, durationMs, fps, cyclic, keys,
walkLength, events, trackedJoints, partial? }` (the join uses `name`, `group`, `type`, `banName`). For each sidecar clip:
1. a LOCOMOTION system set whose name equals `banName` wins [likely: it is the more specific key];
2. otherwise the ani set with `name === group` and `animationType === type`;
3. otherwise no tracks.

Example: chinaman_adventurer's `RUN` clip (default group, ban `chinaman_fighter_runforward`) has no LOCOMOTION set,
so it takes the default group's RUN set: `mvrunground` at 289 and 619 ms. The sidecar's type-2 (footstep) events are
293/625 ms, so the two sources agree to a few ms. (For WALK they differ more: BSR 347/899 ms vs sidecar events
406/932 ms; the BSR times are what we play.)

### 2.2 effectsound.txt [confirmed]

Two copies exist: `Media.pk2 resinfo/effectsound.txt` (3,010 data rows with a `.wav`) and
`server_dep/silkroad/textdata/effectsound.txt` (5,647 uncommented rows with a `.wav` and ≥ 11 cells, 292 objects;
the author's first count was 5,645 / 293; 905 lines are `//` comments). Both are CP949 (the textdata decoder
already handles it). The textdata copy is a later revision: it fixes `cm_Mang_moan.wav` (missing) to
`cm_Mang_moan1.wav` and adds rows. **Use the textdata copy** [likely the one current clients read; both are
parsed, textdata wins per (object, handle, skill, event1..3)].

Columns (tab-separated, the first cell is empty): `object, handle, skill_ID, event1, event2, event3, blank, folder,
filename, volume, description`. `-` = none. Rows starting `//` are comments.

| object | Meaning | Jangan examples |
|---|---|---|
| `UI` | Interface | `SND_BUTTON_CLICK` uibutton_a / uibutton_b; `SND_WINDOW_OPEN/CLOSE`; `SND_ERROR` error; `SND_WARNING` biff; `SND_LEVUP` event1 `CHINESS` itlevelup; `SND_POTION` itpotiondrink; `SND_REVIVE` itrevive; `SND_QUEST` questopen; `SND_QUEST_END` itquest; `SND_REPAIR` itrepair_a..c |
| `ITEM` | Items | `SND_EQUIP` by item kind in event1 (`SWORD`, `BLADE`, `SPEAR`, `TBLADE`, `BOW`, `SHIELD`, `HELM`, `BREASTPLATE`, `CUISSE`, `PAULDRONS`, `GAUNTLET`, `GREAVE`, `CAP`, `ROBE`, `GLOVES`, `SHOES`, `RING`, `NECKLACE`, `EARRING`, `POTION`, `SCROLL`, `QUICKSLOT`, ...); `SND_DROPITEM` `GOLD` itgold; `SND_PICKUP` itpickup |
| `PLAYER` | Any player | Footsteps by surface (§2.4); `SND_DMG` by weapon (§2.6); `SND_CRIDMG` batcrihit; `SND_BLOCKING`; skill rows with `skill_ID` = a skill group (`SKILL_CH_SWORD_SMASH_A`: `SND_SWING_S1` csk_sword_swing_b, `SND_DMG` csk_sword_hit_c) |
| `PCM_<COSTUME>` / `PCF_<COSTUME>` | Chinese male/female voice sets | `PCM_ADVENTURER`: `VOC_MOAN` NORMAL vcm_AT_moan1_a / CRITYCAL vcm_AT_moan1_c; `VOC_DEATH` vcm_AT_die_a..c; `SND_DEATH` cm_Beye_thud; `VOC_SHOUT1` a..c; `VOC_SHOUT2` a..c; `VOC_AVOID` a..c; `VOC_SITDOWN/STANDUP` |
| `MOB_<NAME>` | A mob family | `MOB_MANGNYANG`: `VOC_MOAN` cm_Mang_moan1; `VOC_DEATH` cm_Mang_die; `SND_DEATH` cm_Beye_thud; `SND_WALK1/RUN1` cm_Mang_walk; per attack skill `SND_SWING1`, `VOC_SHOUT1`, `SND_DMG` |
| `COS_*` | Pets and mounts | out of scope |

**Object names from CodeName128** [confirmed for every Jangan code]:
- `CHAR_CH_MAN_<X>` → `PCM_<X>`, `CHAR_CH_WOMAN_<X>` → `PCF_<X>`; `NECROMENCER` is spelled `NECROMANCER` on the
  voice side (`CHAR_CH_WOMAN_NECROMENCERB` → `PCF_NECROMANCERB`).
- `MOB_<CH|WC>_<NAME>[_CLON]` → `MOB_<NAME>` (`MOB_CH_MANGNYANG` → `MOB_MANGNYANG`, `MOB_WC_HYEONGCHEON` →
  `MOB_HYEONGCHEON`, `MOB_CH_TIGER_CLON` → `MOB_TIGER`). All 32 Jangan mob codes map to an existing object.

`volume` *(fact-check)* is 100 on 4,096 rows and 80 on 1,509, with outliers 30, 40, 50, 60 (21 rows), 70, 90, 99,
one 200 and two `-`. Our cue `gain` = volume / 100 clamped to 0..1 (`-` → 1). `blank` is 0 on 5,536 rows and 1..23 on
about 110 others (1, 2, 3, 5 most often) [unknown meaning]; not used. Several rows are duplicated with a different `event2` label but the Korean
description tells them apart (§2.4).

### 2.3 skilleffect.txt stage sounds [confirmed]

skilleffectset cols 26/27 (SndBegin/SndEnd, SKILLS.md §7.1) are `none` or a `skill\<file>.wav`. 290 `SKILL_CH_*`
stage rows carry a sound (34 distinct files; 985 rows of all races) *(fact-check: was 268)*. In the first playable slice (SKILLS.md §10.4):

| Skill group | Phase | Col 26 |
|---|---|---|
| `SKILL_CH_SWORD_SMASH_A` (Strike Smash) | SHOT | none |
| `SKILL_CH_SWORD_CHAIN_A` (Illusion Chain) | SHOT ×3 | none |
| `SKILL_CH_SWORD_GEOMGI_A` (Soul Cut Blade) | SHOT | none |
| `SKILL_CH_COLD_GIGONGTA_A` (Ice River Force) | ACT_S | `skill\csk_cold_gigong_hand.wav` |
| `SKILL_CH_COLD_GANGGI_A` (Weak Guard of Ice) | READY / ACT_S | `skill\csk_cold_ready.wav` / `skill\Csk_Cold_Binghon.wav` |
| `SKILL_CH_WATER_HEAL_A` (Heal - Medical Hand) | READY / ACT_S | `skill\csk_heal_ready.wav` / `skill\csk_heal_jehwang.wav` |

SndEnd is `none` on all of them. The weapon skills get their sound from the clip tracks (§2.1) plus the
`effectsound.txt` skill rows (`SND_SWING_S*`, `SND_DMG`). This fills the "`sound` in fx/skills.json" follow-up of
SKILLS.md §7.2 without touching `fx/skills.ts`: the sound export reads the table itself through the existing
`skillEffectSections()`.

### 2.4 Footstep surfaces [confirmed data, likely semantics]

- Every Chinese player walk/run clip names the neutral file `mvwalkground` / `mvrunground`. The surface is chosen at
  run time [likely]: `effectsound.txt` has `PLAYER SND_WALK1` / `SND_RUN1` rows with `event1 = FIELD` and
  `event2` = a surface.
- The `event2` values are the `TILE2D_TYPES` of `packages/formats/src/tile2d.ts` (tile2d.ifo `type`) in upper case
  (`DIRT`, `DEEPWATER`, `LONGGRASS`; match case-insensitively): Dirt, Sand, Ashfield, Stone, Metal, Wood, Mud, Water,
  DeepWater, Snow, Grass, LongGrass, Forest, Cloud. The world manifest
  already carries `tiles[].typeName` for footsteps.
- Jangan uses 5 of them. Tile textures in the manifest: **Dirt 14, Stone 11, Grass 10, Water 6, Mud 2**.
- The table's `event2` column has copy-paste errors (WALK: ice under `FOREST`, desert under `CLOUD`; RUN: three
  `CLOUD` rows for cloud, ice and desert), so the mapping
  below follows the Korean description column. The RUN rows name `mvWalk*` files, but `mvrun*` files exist for 9
  surfaces. We use `mvrun<suffix>` when it exists, else `mvwalk<suffix>` [likely; the BSR's own `mvrunground` shows the
  run variant is intended].

| Surface | Description | Walk file | Run file |
|---|---|---|---|
| Dirt | 흙바닥 dirt | `player/mvwalkground` | `player/mvrunground` |
| Sand | 모래 sand | `player/mvwalkgravel` | `player/mvrungravel` |
| Ashfield | 화산재 ash | `player/mvwalkgrass` | `player/mvrungrass` |
| Stone | 딱딱한바닥 hard floor | `player/mvwalkhground` | `player/mvrunhground` |
| Metal | 자갈 gravel | `player/mvwalkgravel` | `player/mvrungravel` |
| Wood | 나무 wood | `player/mvwalkhwood_a`, `_b` | `player/mvrunhwood` |
| Mud | 진흙 mud | `player/mvwalkmud` | `player/mvrunmud` |
| Water | 얕은물 shallow water | `player/mvwalkmud` | `player/mvrunmud` |
| DeepWater | 깊은물 deep water | `player/mvwalkwater` | `player/mvrunwater` |
| Snow | 설원 snow | `player/mvwalksnow` | `player/mvrunsnow` |
| Grass, LongGrass | 풀숲 grass | `player/mvwalkgrass` | `player/mvrungrass` |
| Forest | 우거진풀숲 | `player/mvwalkcloud` | `player/mvruncloud` |
| Cloud | 구름 | `player/mvwalkcloud` | `player/mvruncloud` |
| *(desert, ice rows)* | 사막 / 얼음 | `player/mvwalksand` / `player/mvwalkice` | walk file |

- **Object floors** (the Jangan plaza, bridges, building floors) have no material in the data we parse [unknown]. The
  plaza is an object navmesh surface over sunken terrain (`world/jangan/heights.ts`) [confirmed]. Object floors use
  **Stone** (`mvwalkhground` / `mvrunhground`). A per-model override (`/bridge|wood/` → Wood) is left for later.
- **Mobs** with their own walk file keep it (`cm_mang_walk`); substitution applies only to tracks whose file matches
  `^player/mv(walk|run)`.
- All 22 `mv*` files are always exported, even though the BSRs only name `mvwalkground`/`mvrunground`.

### 2.5 Music and ambience per area [confirmed data]

- `Data.pk2 regioninfo.txt` (CP949) lists areas: `#TOWN\t<Korean name>` or `#FIELD\t...`, then region rows
  `<x> <z> ALL` or `<x> <z> RECT a b c d`. Two more copies exist (`Data.pk2 shader/regioninfo.txt`, older/smaller, and
  `Media.pk2 server_dep/silkroad/textdata/regioninfo.txt`); the Jangan rows are identical in the root and textdata
  copies [confirmed]. **장안 (Jangan) town**: 12 rows, x 167..169 × z 96..99; the z = 96 and 99
  rows are `RECT` [unknown semantics]. **장안필드 (Jangan field)**: 171 region rows.
- `Media.pk2 server_dep/silkroad/textdata/effectenvsnd.txt` (CP949; the resinfo copy is an older subset) has 51
  `<1> <area name>` blocks, each with a music file and `<2> 낮` (day) and `<2> 밤` (night) layer lists:
  `<3> "<file>.wav" <min>~<max>`. `0~0` = continuous loop; otherwise a one-shot repeated every min..max seconds [likely].

The Korean area names are the join key, matched **exactly**: both files also have fortress-war twins `요새_장안` /
`요새_장안필드` (regions around x 69..73, z 67..70) with the same layers, so a substring match on `장안` is wrong. Jangan:

| Area | Music | Day layers | Night layers |
|---|---|---|---|
| 장안 → `JANGAN_TOWN` | `Jangan_Town.ogg` | `day_wind` loop; `day_bird01` 15-30 s, `day_bird02` 10-20, `day_bird03` 20-40, `day_bird04` 25-30, `day_bird05` 10-20, `day_wind02` 20-50 | `night_wind` loop; `night_bird01` 20-35, `night_bird02` 15-40, `night_bird03` 40-50, `night_bird04` 40-50, `night_bird05` 30-40, `night_insect01` 10-20, `night_insect02` 10-20, `night_insect03` 30-50 |
| 장안필드 → `JANGAN_FIELD` | `Jangan_Field.ogg` | same as town | same as town |

The game renders a fixed noon (`world/jangan/ground.ts` `timeOfDay: 0.5`), so only the day set plays until a day
cycle exists. Town vs field reuses the existing safe-area test (§1.3); `regioninfo` regions go into the index for
reference only.

### 2.6 Hit sounds [confirmed data]

The BSR has swings, not impacts. Impacts come from `effectsound.txt` `SND_DMG`, played on the victim when the hit
lands. Lookup order:
1. `PLAYER SND_DMG skill_ID = <skill group>` (Strike Smash → `skill/csk_sword_hit_c`);
2. `PLAYER SND_DMG skill_ID = SKILL_CH_<FAMILY>_BASE` for basic attacks, where FAMILY is SWORD (sword and blade),
   SPEAR (spear and glaive), BOW;
3. `PLAYER SND_DMG event1 = <weapon>` (SWORD, BLADE, SPEAR, BOW, PUNCH, ...);
4. for mob attacks, `MOB_<NAME> SND_DMG skill_ID = <mob skill>`.

The six Chinese weapon rows (SWORD, BLADE, SPEAR, BOW and the `SKILL_CH_*_BASE` rows) are `hit1n, hit1b, hit1a,
hit2n, hit2b, hit2a`: **1 = weak (약), 2 = strong (강); n = normal target (일반), b = big (대형), a = armoured (갑옷)**
(from the descriptions and the commented-out CLAW rows that spell NORMAL/BIG/ARMOR in `event3`; live rows all say
`NORMAL` there). *(fact-check)* **PUNCH is the exception:** its three "strong (강)" rows reuse the `batPunchHit1{N,B,A}`
files, so the file name alone would leave `PUNCH.strong` empty. The exporter therefore reads strength from the
description (`(약)` / `(강)`) and the class from `(일반)` / `(대형)` / `(갑옷)`, falling back to the file name
(`/hit([12])([nba])\.wav$/i`). European rows (`TSWORD`, `DAGGER`, ...) use a different `#1/#2/CRITYCAL` pattern and
are out of scope. The client picks weak on `hit`, strong on `crit`, plus the `SND_CRIDMG` layer
(`player/batcrihit`) on `crit`. Target class: `n`, except `b` for giant mobs or mobs with `radius ≥ 1.2 m`
[design choice; no class column is known]. `block` plays `PLAYER SND_BLOCKING` (`player/batblock1`, crit
`batblock2`). `miss` plays the victim's `VOC_AVOID` voice when it is a player.

### 2.7 Worked examples

Times are ms from the clip start at speed 1. "Clip" names are the sidecar names.

1. **Blade player walking and running on the plaza stone** (`CHAR_CH_MAN_ADVENTURER`, blade: base clips come from the
   default group because `FAMILY_CLIP.blade` is null in `three/models.ts`).
   - `WALK`: tracks `snd_walk1` at 347 and 899 ms, file `player/mvwalkground` [confirmed]. The plaza is an object floor →
     Stone → `player/mvwalkhground` at each track.
   - `RUN`: `snd_run1` at 289 and 619 ms, `player/mvrunground` → Stone → `player/mvrunhground`.
2. **The same on grass** (outside the plaza, terrain tile `c_grass_fld_*`, typeName Grass): `player/mvwalkgrass` at
   347/899 ms; `player/mvrungrass` at 289/619 ms.
3. **Blade basic attack hitting a Mangnyang.** Per SKILLS.md §6 the blade fights with the sword group:
   `ATTACK1_sword_base_01` (1,133 ms, hit events 200/566): `player/batswordswing1` at 185, `player/batswordswing2` at
   559, `player/vcm_at_shout1_a` at 186 and 561 [confirmed]. At each hit (per `combat.hits[i]` at hit event i):
   `SKILL_CH_SWORD_BASE` `SND_DMG` → `player/batswordhit1n` (hit) or `player/batswordhit2n` + `player/batcrihit`
   (crit), positioned at the Mangnyang, which plays its DAMAGE1 track `monster/cm_mang_moan1` at 0 (effectsound
   `VOC_MOAN` gives the same file). Note: the game currently plays the *default* group's ATTACK1..4 for blades (punch
   clips with `player/batpunchswing`), see Risks.
4. **A Mangnyang attacking** (`MOB_CH_MANGNYANG`, skill `MSKILL_CH_MANGNYANG_ATTACK01`, clip `ATTACK1`, 1,666 ms, hit
   event 651): `player/battswordswing1` at 607 (`snd_swing1`), `monster/cm_mang_shout` at 603 (`voc_shout1`)
   [confirmed]. At the hit on the player: `MOB_MANGNYANG SND_DMG` → `player/battswordhit2n`; the victim's DAMAGE1
   track `player/vcm_at_moan1_a` (chinaman). `ATTACK2` (2,566 ms, hits 821/1381): `player/bataxeswing1` 734,
   `player/bataxeswing2` 1,359, `monster/cm_mang_shout` 732 and 1,357; hits → `player/bataxehit2n`.
5. **A Mangnyang dying** (`DIE1`, 1,833 ms): `monster/cm_mang_die` at 0 (`voc_death`), `monster/cm_beye_thud` at 1,503
   (`snd_death`) [confirmed]. `DAMAGE2` names `cm_mang_moan2`, which does not exist (dropped).
6. **Picking up gold.** When the drop appears (`spawn` of an `ITEM_ETC_GOLD_*` entity): `ITEM SND_DROPITEM GOLD` →
   `ui/itgold` at the drop. On `actionResult {re: 'pickup', ok: true}`: `ITEM SND_PICKUP` → `ui/itpickup` (the retail
   PICK clip carries the same file at 0 ms; the game does not play PICK).
7. **Level up:** `UI SND_LEVUP CHINESS` → `ui/itlevelup` (5.4 s, non-spatial for yourself, spatial for others).
8. **UI button click:** `UI SND_BUTTON_CLICK` → `ui/uibutton_a` (the second row, `uibutton_b`, for toggles/tabs).
   Window open/close `ui/uiwinopen` / `ui/uiwinclose`; error toast `ui/error`.
9. **Jangan town ambience:** music `music/jangan_town.ogg` (already playing) + `env/day_wind` looped + birds
   (`env/day_bird01` every 15-30 s, ..., `env/day_wind02` every 20-50 s).
10. **Strike Smash** (`SKILL_CH_SWORD_SMASH_A_01`, clip `SKILL_1_skill_ch_sword_smash_a`, 1,433 ms, hit event 410):
    clip tracks `skill/csk_sword_swing_a` at 415 (`snd_swing_s1`) and `player/vcm_at_shout2_c` at 416
    (`voc_shout2`) [confirmed]. `effectsound.txt` has `PLAYER SND_SWING_S1 SKILL_CH_SWORD_SMASH_A` →
    `skill/csk_sword_swing_b`: the skill row replaces the clip's file for that handle, keeping the clip's time
    [unknown which one retail plays; a single exporter constant `SKILL_ROWS_OVERRIDE_CLIP = true` makes it a one-line
    A/B]. At the hit: `SND_DMG` → `skill/csk_sword_hit_c` on the victim. No stage sounds (cols 26/27 `none`).

---

## 3. Format and encoding

**Browser decode.** `AudioContext.decodeAudioData` handles PCM WAV in every browser, and Ogg Opus in Chrome/Edge and
Firefox [likely]. Safari's Ogg support is version-dependent [unknown]; the friends play on desktop Chrome/Edge/Firefox,
and the music is already Ogg Vorbis.

**Encoders available without npm dependencies** [confirmed]: `ffmpeg` 8.1.1 (gyan.dev full build, WinGet) is on PATH on
the dev box, with `libopus`, `libvorbis`, `libmp3lame`, `aac`, `flac`. No `oggenc`/`opusenc`/`sox`/`lame`. `sharp` has no
audio. The mini PC does not encode (assets are built on the dev box and synced), so its ffmpeg does not matter.

**Measured** on the Jangan set (589 files, 28.95 MB PCM), mono:

| Encoding | Size | Notes |
|---|---:|---|
| PCM WAV as is | 28.95 MB | gzip -6 only gets ~12% (player folder: 9.26 → 8.19 MB, re-measured; *fact-check: was "~18%, 10.0 → 8.2"*) |
| Ogg Vorbis q3 (player folder only) | 3.5 MB of 9.26 | author's measurement, not re-run [likely]; ~4 KB of Vorbis headers per file dominates short sounds |
| **Ogg Opus 48 kbps (ambience 64 kbps)** | **3.93 MB** | 59 s to encode serially; `uibutton_a` 4,394 → 799 B, `itlevelup` 238,622 → 34,731 B (both re-encoded with the command below: identical) [confirmed] |

**Decision.**
- Ship `.ogg` Opus: `ffmpeg -v error -y -i <trimmed.wav> -ac 1 -c:a libopus -b:a 48k -vbr on -application audio <out.ogg>`;
  `env/*` at 64k. (`decodeAudioData` resamples every buffer to the `AudioContext` rate anyway, so the mixed source
  rates need no handling.)
- Before encoding, the exporter trims trailing silence: samples after the last one above -60 dBFS
  (|s| > 32 on 16-bit) are cut, keeping a 20 ms tail. Leading silence is **never** trimmed, because key times are
  relative to the clip, not the sound. Stereo is downmixed to mono except for `env/*` loops. The trimmed PCM goes
  to ffmpeg over a temp file in the OS temp dir.
- `--codec wav` (automatic when `ffmpeg -version` fails or `--ffmpeg <path>` / `SRO_FFMPEG` points nowhere): write the
  trimmed mono 16-bit PCM WAV instead. `index.codec = 'wav'`. The server's on-the-fly gzip should then include
  `.wav` (hook, §6).
- `--also-wav` writes both, for a Safari fallback: the index gains `wavFallback: true` and the runtime picks `.wav`
  when `canPlayType('audio/ogg; codecs=opus')` is `''`.
- Incremental: `work/out/sound/.cache.json` maps `<src path>` → `{ size, mtimeMs, sha1, bitrate, out }`; unchanged
  files are skipped unless `--force`.
- **optimize-out:** no change. `sound/**` falls under "everything else is copied unchanged"
  (`packages/convert/src/optimize/run.ts`). `--precompress` skips types outside `optimize/measure.ts` `COMPRESSIBLE`
  (a separate set from the server's), so `.ogg`/`.wav` get no `.br`, while `index.json` and `model/*.json` do. The
  game reads sound from `/out/sound/` like music, so out-opt is only a mirror (deploy syncs both `out` and `out-opt`,
  `deploy/config.sh` `DEPLOY_ASSET_TREES`; ~4 MB twice is fine).
- `.cache.json` is a dot-file: `deploy/assets.ts` skips dot-files, so it is never deployed [confirmed].

---

## 4. Export: `packages/convert/src/tools/export-sound.ts`

```sh
pnpm tsx packages/convert/src/tools/export-sound.ts [--scope jangan|all] [--codec opus|wav] [--also-wav] [--force] [--ffmpeg <path>]
```

### 4.1 Inputs [confirmed paths]

- `work/extracted/Data/prim/snd/**` when present, else `openArchive('Data').read('prim/snd/...')`
  (`node-io.ts`), the same pattern as `export-ui.ts` music.
- `Media.pk2 server_dep/silkroad/textdata/effectsound.txt`, `effectenvsnd.txt`, `skilleffect.txt`
  (`decodeTextdata()`); `Media.pk2 resinfo/effectsound.txt` as the fallback copy.
- `Data.pk2 regioninfo.txt` (root copy; see §2.5 for the other two).
- BSRs *(fact-check: `characters.json` is a plain array with top-level `bsr`/`sidecar`, not `model.*`)*:
  `work/out/data/characters.json` (`[].code`, `[].bsr`, `[].sidecar`), `mobs.json` (`entries[].code`,
  `entries[].model.bsr`, `.model.sidecar`), `npcs.json` (`entries[].code`, `.model.bsr`, `.model.sidecar`). BSR paths
  are relative to Data.pk2 (`res/char/china/chinaman_adventurer.bsr`). Clip names from the matching sidecar
  (`work/out/<sidecar without /out/>`, e.g. `/out/char/china/chinaman_adventurer.json`).
- Skills: `work/out/data/skills.json` (`entries[]`, 180 rows; each has `code` and `group`, e.g.
  `SKILL_CH_SWORD_SMASH_A_01` → `SKILL_CH_SWORD_SMASH_A`, `SKILL_CH_SWORD_BASE_01` → `SKILL_CH_SWORD_BASE`) for the
  group list of Chinese skills, and the mob attack codes from `mobs.json` `entries[].skills` (Mangnyang:
  `MSKILL_CH_MANGNYANG_ATTACK01`, `..._ATTACK02`).

### 4.2 Outputs

```
work/out/sound/index.json                    SoundIndex (below)
work/out/sound/model/<CodeName128>.json      ModelSounds, one per player/mob/NPC code with at least one track
work/out/sound/<folder>/<name>.ogg           e.g. sound/player/mvwalkgrass.ogg, sound/monster/cm_mang_die.ogg
work/out/sound/.cache.json                   encoder cache (not read by the game)
```

`scope jangan` exports the union of: every resolved BSR track of the in-scope models; the effectsound rows of `UI`,
`ITEM`, `PLAYER` (generic rows and `SKILL_CH_*` rows), the 26 `PCM_/PCF_` objects and the 32 mapped `MOB_` objects;
skilleffect cols 26/27 of `SKILL_CH_*`; the 22 `mv*` files; the Jangan ambience. `scope all` takes every object and
every area (about 1,300 files [likely, estimate]; `prim/snd` holds 2,159 in total).

### 4.3 The index contract: `packages/shared/src/sound.ts` (new, node-free)

It lives in `@sro/shared` so the exporter (relative import, as `data/content.ts` does) and the game use the same types
and validator.

```ts
export const SOUND_INDEX_FORMAT = 'sro-sound'
export const SOUND_MODEL_FORMAT = 'sro-sound-model'

export type SoundCategory = 'music' | 'sfx' | 'ui' | 'ambient'
export type SoundCodec = 'opus' | 'wav'
/** tile2d.ifo surface types (TILE2D_TYPES) that effectsound.txt keys footsteps by. */
export type SoundSurface =
  | 'Dirt' | 'Sand' | 'Ashfield' | 'Stone' | 'Metal' | 'Wood' | 'Mud' | 'Water' | 'DeepWater'
  | 'Snow' | 'Grass' | 'LongGrass' | 'Forest' | 'Cloud'
/** What a clip track does; derived from the BSR event name (raw kept in ClipTrack.raw). */
export type SoundHandle =
  | 'step_walk'   // snd_walk, snd_walk1..3
  | 'step_run'    // snd_run, snd_run1..3
  | 'swing'       // snd_swing1..4, snd_swing_s, snd_swing_s1/_s2, snd_swing_1, snd_swign1/2
  | 'shout'       // voc_shout, voc_shout1/2, voc_shot2, snd_shout1/2
  | 'moan'        // voc_moan, voc_moan1/2
  | 'death_voice' // voc_death
  | 'death_thud'  // snd_death, snd_death1/2
  | 'block'       // snd_blocking
  | 'pickup'      // snd_pickup
  | 'idle'        // snd_stand, snd_stand1/2
  | 'emote'       // voc_emo
  | 'alert'       // snd_find, snd_helf
  | 'other'       // '' and anything else

/** One encoded file. Key in SoundIndex.files: lower-case path under prim/snd without extension ('player/mvwalkgrass'). */
export interface SoundFile {
  /** Relative to /out/ ('sound/player/mvwalkgrass.ogg'). */
  url: string
  /** Relative to /out/, present only with --also-wav. */
  wav?: string
  /** Duration after trimming. */
  ms: number
  channels: 1 | 2
  bytes: number
}

/** A playable choice: one of `files` at random, at `gain` (effectsound volume / 100). */
export interface SoundCue {
  files: string[]
  gain: number
  category: SoundCategory
}

export interface ClipTrack {
  /** From the clip start at speed 1. */
  ms: number
  handle: SoundHandle
  /** BSR event name as stored ('snd_swing_s1'). */
  raw: string
  /** SoundIndex.files key. */
  file: string
}

/** sound/model/<code>.json */
export interface ModelSounds {
  format: typeof SOUND_MODEL_FORMAT
  version: 1
  code: string
  bsr: string
  /** Keyed by sidecar clip name ('ATTACK1_sword_base_01'); tracks sorted by ms. */
  clips: Record<string, ClipTrack[]>
}

export type HitClass = 'n' | 'b' | 'a'
/** SND_DMG files by strength (1 weak, 2 strong) and target class; any may be missing. */
export interface HitSet {
  weak: Partial<Record<HitClass, string>>
  strong: Partial<Record<HitClass, string>>
  gain: number
}

export interface SkillSounds {
  /** effectsound PLAYER rows for this skill group: handle raw name ('snd_swing_s1') -> files. */
  swing?: Record<string, string[]>
  dmg?: HitSet | string[]
  /** skilleffect cols 26/27, in table order. */
  stages?: Array<{ phase: string; startEvent: number; begin: string | null; end: string | null }>
}

export interface VoiceSet {
  /** effectsound object ('PCM_ADVENTURER', 'MOB_MANGNYANG'). */
  object: string
  moan: { normal: string[]; crit: string[] }
  deathVoice: string[]
  deathThud: string[]
  shout1: string[]
  shout2: string[]
  avoid: string[]
  gain: number
}

export interface MobSounds extends VoiceSet {
  walk: string[]
  /** Per mob skill (MSKILL_*): swing/shout/dmg rows. */
  attacks: Record<string, { swing?: string[]; shout?: string[]; dmg?: string[] }>
}

export interface AmbientLayer {
  file: string
  /** true: continuous loop ('0~0'); false: one-shot every everyS[0]..everyS[1] seconds. */
  loop: boolean
  everyS: [number, number]
}

export interface AreaSound {
  /** Area name as in regioninfo/effectenvsnd ('장안'). */
  source: string
  kind: 'town' | 'field'
  /** ui/index.json music key ('jangan_town') or null when not exported. */
  music: string | null
  day: AmbientLayer[]
  night: AmbientLayer[]
  /** regioninfo ALL/RECT rows as region ids (z << 8 | x); informational. */
  regions: number[]
}

export interface SoundIndex {
  format: typeof SOUND_INDEX_FORMAT
  version: 1
  generator: string
  generatedAt: string
  codec: SoundCodec
  wavFallback: boolean
  files: Record<string, SoundFile>
  /** Logical cues: 'ui.click', 'ui.click2', 'ui.windowOpen', 'ui.windowClose', 'ui.error', 'ui.warning',
   *  'ui.levelUp', 'ui.potion', 'ui.revive', 'ui.questOpen', 'ui.questDone', 'item.pickup', 'item.dropGold',
   *  'item.equip.<KIND>' (effectsound ITEM SND_EQUIP event1), 'hit.crit', 'block.normal', 'block.crit'. */
  cues: Record<string, SoundCue>
  steps: {
    walk: Partial<Record<SoundSurface, string[]>>
    run: Partial<Record<SoundSurface, string[]>>
    /** Surface used on navmesh object floors. */
    objectFloor: SoundSurface
  }
  /** Generic weapon hits: 'SWORD' 'BLADE' 'SPEAR' 'BOW' 'PUNCH' ... (PLAYER SND_DMG event1). */
  hits: Record<string, HitSet>
  /** SKILL_CH_* groups (and SKILL_CH_<FAMILY>_BASE). */
  skills: Record<string, SkillSounds>
  /** By CodeName128: CHAR_CH_* -> its PCM_/PCF_ voice set. */
  voices: Record<string, VoiceSet>
  /** By CodeName128 (MOB_CH_MANGNYANG, MOB_CH_TIGER_CLON, ...). */
  mobs: Record<string, MobSounds>
  /** CodeName128 -> 'sound/model/<code>.json' (players, mobs, NPCs with at least one track). */
  models: Record<string, string>
  /** 'JANGAN_TOWN', 'JANGAN_FIELD' (id = the music file stem upper-cased). */
  areas: Record<string, AreaSound>
  report: {
    sourceFiles: number
    sourceBytes: number
    outBytes: number
    tracks: number
    unresolved: Array<{ path: string; from: string[] }>
    notExported: string[]
  }
}

/** Problems found in an index (empty = valid). Same style as validateWorldManifest. */
export declare function validateSoundIndex(v: unknown): string[]
/** Helpers shared by exporter and client. */
export declare function soundHandle(rawEvent: string): SoundHandle
export declare function mobSoundObject(code: string): string          // MOB_CH_TIGER_CLON -> MOB_TIGER
export declare function playerVoiceObject(code: string): string | null // CHAR_CH_WOMAN_NECROMENCERB -> PCF_NECROMANCERB
```

Size [likely, estimated]: `index.json` about 60 KB; `model/*.json` about 2-15 KB each (only clips with tracks). Both
compress well with gzip/brotli.

---

## 5. Runtime: `apps/game/src/audio/**`

### 5.1 WebAudio directly, not Babylon AudioEngineV2

`@babylonjs/core` 9.28.0 ships AudioEngineV2 (`CreateAudioEngineAsync`, `createSoundBufferAsync`, `StaticSound` with
`maxInstances`, buses, spatial with a listener attached to a node) [confirmed]. We still use a thin own layer:
- It must work before any scene exists (login/char-select UI clicks) and across scene swaps.
- The voice policy (§5.5) is global across categories and entities; Babylon limits instances per sound only.
- Its default "unmute" UI and per-sound async creation add nothing we need.
- The pure parts (resolution, limiter, scheduling, settings) run in vitest without a browser, behind a small
  `AudioBackend` interface; the WebAudio backend is the only browser-bound file.

The game does not create Babylon's legacy audio engine [confirmed]: `engine.ts` passes no `audioEngine` option to
`Engine`/`WebGPUEngine`, and Babylon 9.28 `Engines/engine.common.js` only calls `AudioEngineFactory` when
`creationOptions.audioEngine` is truthy (there is no default). So there is one `AudioContext`, ours.

### 5.2 Graph, categories, settings

```
AudioBufferSourceNode → GainNode (cue gain × random 0.9-1.0) → [PannerNode] → bus(sfx|ui|ambient) → master → destination
music: HTMLAudioElement (existing Music class), volume = master × music × 0.55
```

- `apps/game/src/audio/settings.ts`, `localStorage['sro.audio.v1']`:
  `{ master: 0.8, music: 0.55, sfx: 0.9, ui: 0.7, ambient: 0.6, muteHidden: true }`, each clamped to 0..1; reads
  and writes in try/catch. Bad or missing values fall back per field.
- `localStorage['sro.muted']` stays the **master mute** (the corner button, `?mute=1`), so old settings keep working.
- `Music` moves to `apps/game/src/audio/music.ts` and gains `setVolume(v)`; the constant `VOLUME` becomes the
  settings value.

### 5.3 Unlock and visibility

- The `AudioContext` is created lazily on the first `pointerdown`/`keydown` (capture), like `Music`. Cues before
  that are dropped.
- `document.visibilitychange`: when hidden and `muteHidden`, `ctx.suspend()` and pause the music; on visible,
  `ctx.resume()` and resume it. Ambient timers are based on `ctx.currentTime`, so they freeze with the context.

### 5.4 Loading and caching (`bank.ts`)

- `/out/sound/index.json` is fetched once at boot (next to `ui/index.json`). A missing index disables sfx with one
  console warning; the game runs silent.
- `load(fileId): Promise<AudioBuffer | null>`: fetch `/out/<url>` → `arrayBuffer` → `decodeAudioData`. One in-flight
  promise per id; at most 6 fetches at once.
- **Preload** at world enter: the UI cues, the 8 distinct Jangan footstep files (walk/run × Dirt, Stone, Grass, Mud;
  Water reuses `mvwalkmud`/`mvrunmud`), `hit.crit`, the self weapon's `HitSet`, `ui.levelUp`, `item.pickup`,
  `item.dropGold`, and the current area's loop: about 175 KB *(fact-check: re-encoded untrimmed with the §3 command,
  29 files = 176,364 B; was "10 files, ~120 KB")*. Trimming shaves a little; `itlevelup` alone is 34.7 KB.
- **Per model:** when an `EntityView` starts loading its model, `preloadModel(code)` fetches `sound/model/<code>.json`
  and then every file of its clips that are kept. `KEEP_CLIPS` in `three/models.ts` is a module-private `const` and
  today drops `SKILL_*` and `PICK` clips at load; either export it (a one-word hook) or have `bank.ts` keep its own copy
  of the regex. `SKILL_*` preloading only matters once the skills lane keeps those clips.
- **Late sounds are dropped:** a spatial sfx whose buffer is not decoded when it fires is skipped (the load continues
  for next time). UI cues wait up to 150 ms.
- **Cache:** decoded buffers (48 kHz float mono = 192 KB/s) under a 64 MB LRU budget; buffers in use by a playing
  voice are never evicted.

### 5.5 Voices (`voices.ts`, pure policy)

| Limit | Value |
|---|---|
| Total one-shot voices | 32 |
| Per bus | sfx 24, ui 4, ambient 6 (1 loop + 5 one-shots) |
| Same file playing at once | 4 (the 5th steals the oldest of that file) |
| Per entity | 2 sfx + 1 voice (shout/moan/death); a new voice replaces the entity's previous voice unless it is a death voice |
| Same entity + same file retrigger | ignored within 60 ms |
| Distance cull (from the listener) | footsteps of others 20 m, idle/emote 15 m, voices of others 30 m, everything else 40 m; your own sounds never |

Priority: yourself 3, your target 2, other players 1, mobs/NPCs 0; UI plays on its own bus. When the sfx bus is full,
the new sound steals the lowest priority, then the farthest, then the oldest voice; if the new sound ranks below all
of them it is dropped. Steals fade out over 30 ms to avoid clicks.

### 5.6 Spatial

- **Listener** at the local player's position + 1.6 m, oriented with the camera's yaw. This is the usual third-person
  MMO choice: your own footsteps stay centred while zooming, and panning follows the view.
- **Your own sounds** (and UI, level-up, pickup) are non-spatial, straight into the bus.
- **Others:** a `PannerNode` per voice, `panningModel 'equalpower'`, `distanceModel 'inverse'`, `refDistance 3`,
  `rolloffFactor 1.2` (gain = 3 / (3 + 1.2 (d − 3)) ≈ 0.26 at 10 m, 0.13 at 20 m) [confirmed math]. Note that
  `maxDistance` has no effect with the `inverse` model (the WebAudio spec uses it only for `linear`), so the 40 m
  cut-off is the §5.5 distance cull, not a panner setting. The position is set at start and, for voices longer than
  500 ms, every frame from the entity root.
- `setListener(pos, yaw)` is called once per frame from the world frame loop (`world.ts`
  `scene.onBeforeRenderObservable.add`, after the entity updates). The camera is an `ArcRotateCamera`: `camera.alpha`
  is the camera's azimuth around the target, **not** the view yaw (the view direction is `target − position`, i.e.
  alpha + π). Pass the forward vector (`camera.getForwardRay().direction` flattened to XZ) rather than raw `alpha`.
- **Handedness** [likely, verify by ear]: the world scene is Babylon's default left-handed system
  (`useRightHandedSystem` is only set in `three/backdrop.ts`), while the WebAudio panner derives "right" as
  forward × up in a right-handed frame. Feed WebAudio positions and orientation with **z negated** (sources and
  listener alike), or left/right come out swapped. The test: a Mangnyang on the screen's left must sound left.

### 5.7 Clip sounds in sync with animations (`clips.ts`)

Babylon clips from animation packs share `Animation` objects between actors (ASSETS.md §5.3), so animation events
cannot be attached to them. Instead each audible actor is **polled once per frame**:

- `CharacterActor` gets one read-only accessor (hook in `three/models.ts`):
  ```ts
  /** The full clip on top (the action if one plays, else the base clip, else DIE1 when dead) and the partial overlay. */
  clipCursors(): { top: ClipCursor | null; overlay: ClipCursor | null }
  interface ClipCursor {
    name: string
    ms: number      // (masterFrame - from) / (to - from) × clips.get(name).durationMs
    run: number     // increments on every start() of this layer's group (restart ≠ loop wrap)
    silent?: true   // DIE1 started with die(true): jump to the end, fire nothing
  }
  ```
  `masterFrame` comes from `group.animatables[0]`; `from`/`to`/`animatables` are `AnimationGroup` getters [confirmed
  in the 9.28 typings, `Animations/animationGroup.pure.d.ts` / `animatable.core.d.ts`].
  *(fact-check, current `CharacterActor` code)*:
  - `die()` stops everything, sets `current = null` and `action = null`, then starts DIE1 directly. So "top" must
    fall back to the playing `DIE1` group when `isDead`, or death voices/thuds never fire.
  - `die(true)` (entities that arrive dead, and `EntityView.load()` for a dead entity) plays DIE1 at speed 20; with
    plain cursor polling that fires the death cry and thud of every corpse in view on world enter. Mark it `silent`.
  - `playAction()` and `hurt()` stop and **restart** the same group (repeated ATTACK1 on a one-attack mob, DAMAGE1 on
    every hit, attack speed-ups). Name + `ms < lastMs` cannot tell that from a loop wrap and would fire the tail
    `(lastMs, duration]` of the aborted run (e.g. the second sword swing at 559 ms). The `run` counter (the actor's
    `actionSerial`, and a counter bumped in `hurt()`/`play()`) fixes it.
  - The overlay is not tracked by the actor today; `clipCursors()` finds it as the `DAMAGE1` group when it
    `isPlaying` and its sidecar clip is `partial`.
- `ClipSoundDriver` (pure) keeps `{ name, run, lastMs }` per layer. Each frame: if the name or `run` changed, fire
  tracks in `[0, ms]` (nothing when `silent`); if both are the same and `ms < lastMs` (a loop wrapped), fire
  `(lastMs, duration]` and `[0, ms]`; otherwise fire `(lastMs, ms]`. A jump of more than 1.5 × duration fires nothing
  (tab was hidden). Playback speed needs no special handling, because the cursor is in clip time.
- The same mechanism covers walk/run footsteps, attack swings and shouts, DAMAGE1 moans (overlay layer), DIE1
  voice + thud, SKILL_* clips of the skills lane, and emotes.
- Only actors within 40 m of the listener are polled (plus yourself).

**Track resolution** (`cues.ts`, pure), per fired track:

| handle | File played |
|---|---|
| `step_walk` / `step_run` | If `file` matches `^player/mv(walk\|run)`: `steps.walk/run[surfaceAt(entity)]` (random of the list), else `file` (mob walk). Skipped for other entities beyond 20 m. |
| `swing` | `skills[currentSkill].swing[raw]` when the entity is casting a skill with such a row and `SKILL_ROWS_OVERRIDE_CLIP`, else `file`. |
| `shout`, `moan`, `death_voice` | `file`. Players: 50% of shouts play (retail shouts on every swing, which is noisy with many players) [design]. |
| `death_thud`, `block`, `pickup`, `idle`, `emote`, `alert`, `other` | `file`. |

### 5.8 Footstep surface (`surface.ts`)

`surfaceAt(x, y, z): SoundSurface`, built from the loaded `@sro/world-render` `World`:
1. `terrainY` = `world.regions.heightAt(x, z)` (`packages/world-render/src/regions.ts` `WorldRegions`, public as
   `World.regions`; it wraps `terrainHeightAt()` of `packages/convert/src/world/format.ts` on the navmesh/terrain
   grid) [confirmed]. `null` outside the loaded regions → 'Dirt'.
2. If `y - terrainY > 0.25 m` → the entity stands on an object floor → `index.steps.objectFloor` ('Stone').
3. Else `world.regions.locate(x, z)` gives `{ data, lx, lz }` (file units, 10 per metre); the nearest vertex is
   gx = round(lx / 20), gz = round(lz / 20) (2 m spacing, 97 × 97) and its raw word is
   `data.terrain.textures[gz * 97 + gx] & 0x3ff` (tile2d id, `format.ts` header) → `world.manifest.tiles.find(t =>
   t.id === id).typeName` → surface; `null` or missing → 'Dirt'. Jangan's 43 manifest tiles are Dirt 14, Stone 11,
   Grass 10, Water 6, Mud 2 [confirmed, `work/out/world/jangan/manifest.json`].
4. For your own character, `EntityHeights` knows the retained nav surface exactly (`track.pos.surface.kind`; there
   is already a string getter `selfSurface` for the HUD); a small accessor `selfSurfaceKind(): 'terrain' | 'object' |
   null` replaces step 2 for self. `heights` is `null` without the real world.
5. Cache the answer per entity for 250 ms.

Without the real world (flat fallback ground) every surface is 'Dirt'.

### 5.9 Combat, loot and progression cues

- **Hit** (`world.ts` `onCombat`, inside the per-hit `timeline.after` callback, next to `v.hurt()`): call
  `audio.hit({ attacker, victim, skill: msg.skill, outcome: hit.outcome, clip })`.
  - Skill = `msg.skill` (`combat.skill?` exists in `protocol.ts` today and SKILLS.md §10.2 says it "is now set"),
    else `SKILL_CH_<FAMILY>_BASE` from the attacker's weapon family for players, else the mob attack whose index
    matches the clip (`ATTACK1` → `mob.skills[0]`, `ATTACK2` → `mob.skills[1]`) [likely; true for Mangnyang].
  - `msg.skill` is a **row** code (`SKILL_CH_SWORD_SMASH_A_01`, `SKILL_CH_SWORD_BASE_01`); effectsound `skill_ID` is
    the **group** (`SKILL_CH_SWORD_SMASH_A`). Map through `skills.json` `group` (the client's content catalog) before
    the lookup; mob skills (`MSKILL_*`) are used as is.
  - The per-hit callback today is `timeline.after(delays[i], ...)` in `onCombat` (next to `v.hurt()`); `outcome` is
    `HitOutcome` = `'hit' | 'crit' | 'miss' | 'block'` [confirmed].
  - File: §2.6 order. Mob attacks use `mobs[code].attacks[skill].dmg`, else the generic `PUNCH` set.
  - The victim's moan comes from its DAMAGE1 track when the actor plays DAMAGE1 (§5.7). A crit on a player also plays
    `voices[code].moan.crit` [design].
- **Death:** DIE1 tracks (§5.7); models without tracks fall back to `mobs[code].deathVoice` + `deathThud` at the
  time of `killView`.
- **Level up** (`case 'levelUp'`): `ui.levelUp`, non-spatial if `msg.id === selfId`, else spatial at the entity.
- **Gold drop** (`kind === 'item'` and `/^ITEM_ETC_GOLD_/.test(state.model)`): `item.dropGold` at the drop. Hook it
  in `onMessage` `case 'spawn'` (which only runs when `entered`), **not** in `addEntity`, which `onWorldEnter` also
  calls for the initial snapshot *(fact-check)*.
- **Pickup** (`onActionResult` `case 'pickup'` with `ok`): `item.pickup`.
- **Equip** (`apps/game/src/hud/index.ts` `applyInventoryUpdate`, where `change.equip.length` is non-zero; the
  message is `inventoryUpdate { equip?: EquipSlotUpdate[] }`): `item.equip.<KIND>` from the item's slot and
  weapon family (weapon → SWORD/BLADE/SPEAR/TBLADE/BOW; armour slot → HELM/BREASTPLATE/CUISSE/PAULDRONS/GAUNTLET/GREAVE;
  accessories → RING/NECKLACE/EARRING); unknown → `item.equip.METAL` [likely mapping]. *(§10.1: now played when the
  server accepts the own move/equip/unequip request, not on equip-slot updates.)*
- **Skills lane** (SKILLS.md §10.3 ActionPlayer): on `cast`, set the entity's `currentSkill` for §5.7 and call
  `audio.skillStage(entity, group, phase)` for READY/SHOT/ACT_S rows with a `begin` file; `effectAdd` of a buff plays
  its ACT_S `begin`.

### 5.10 Music and ambience per zone (`ambient.ts`)

- The existing `updateMusic()` in `world.ts` decides town or field. One added line calls
  `audio.setArea(inTown ? 'JANGAN_TOWN' : 'JANGAN_FIELD')`.
- `AmbientPlayer.setArea(id, time = 'day')`: cross-fades the loop layer over 1.5 s and reschedules one-shots. Each
  one-shot layer fires at `now + uniform(everyS)` s, then again after each play; gain 0.5..1.0 at random, stereo
  pan -0.6..0.6 at random (a `StereoPannerNode`, non-spatial).
- Music stays on `Music` (streamed `HTMLAudioElement`); its fade and the ambient fade run together.
- `setArea(null)` (leaving the world) fades ambience out; the title screens keep `maintheme_cut`.

### 5.11 UI sounds (`ui-sounds.ts`)

- One delegated listener installed in `main.ts`:
  `document.addEventListener('click', e => { const b = (e.target as Element).closest('button, [data-sfx]'); ... }, true)`.
  It plays `ui.<b.dataset.sfx ?? 'click'>` unless `b.disabled` or `data-sfx="none"`. `Art.button()` already makes
  real `<button>`s, so every screen gets clicks without per-button code.
- `hud/window.ts` `HudWindow.open()` / `close()` → `ui.windowOpen` / `ui.windowClose`. `HudWindow` is constructed
  with `(art, parent, opts)` and has no path to `app`; give `audio/index.ts` a module-level accessor
  (`gameAudio(): GameAudio | null`, set once by `main.ts`) rather than threading a new constructor argument through
  every window. Its title-bar close is itself a `<button class="hud-window-close">`: mark it `data-sfx="none"` so a
  click plays only `ui.windowClose`, not a click plus a close.
- `hud.toast(text, 'error')` → `ui.error` (inside the local `toast` of `hud/index.ts`; every `world.ts` failure toast
  goes through it).

### 5.12 Settings window (`apps/game/src/hud/sound-settings.ts`)

A small window from the Esc menu (a fourth button, "Sound", in `world.ts` `openMenu`, which today has three buttons in
a fixed 212 × 180 `art.window` with a 130 px button column: grow both by one button row): sliders for Master, Music,
Effects, Interface, Ambience (0-100) and a "Mute when the game is in the background" checkbox. Changes apply live and
persist (§5.2). New i18n keys in `apps/game/src/i18n/en.ts`:

```ts
'menu.sound': 'Sound',
'sound.title': 'Sound',
'sound.master': 'Master',
'sound.music': 'Music',
'sound.sfx': 'Effects',
'sound.ui': 'Interface',
'sound.ambient': 'Ambience',
'sound.muteHidden': 'Mute when the game is in the background',
'corner.soundOn': 'Sound: On',
'corner.soundOff': 'Sound: Off',
```

The corner button (`main.ts`, today `corner.musicOn` / `corner.musicOff` bound to `music.toggle()`) becomes the
master mute with the `corner.sound*` labels; remove the two `corner.music*` keys once unused.

### 5.13 Debug

`?sounddebug=1` logs every played cue (`[sfx] 12.345 MOB_CH_MANGNYANG ATTACK1 swing player/battswordswing1 d=6.2m`)
and every drop reason (not loaded, culled, stolen). `window.__sroAudio` exposes `{ voices, cached, bytes }` for the
console.

### 5.14 Module map

```
apps/game/src/audio/
  index.ts        GameAudio facade: create(), ui(), play(), hit(), skillStage(), setArea(), setListener(), preloadModel(), entity();
                  module accessor gameAudio() for code without an App (hud/window.ts)
  settings.ts     AudioSettings (localStorage 'sro.audio.v1', 'sro.muted'), change listeners
  backend.ts      AudioBackend interface + WebAudioBackend (the only file touching AudioContext/PannerNode)
  bank.ts         index + model JSON loading, fetch/decode, LRU
  voices.ts       VoicePolicy (pure): admit/steal/cull decisions
  clips.ts        ClipSoundDriver (pure): fired tracks between cursors
  cues.ts         pure resolution: steps by surface, hit sets, skill overrides, voice sets
  surface.ts      SurfaceProbe over world-render regions + manifest tiles
  ambient.ts      AmbientPlayer (area layers, timers on ctx time)
  entity.ts       EntitySound: per EntityView glue (driver + resolution + position)
  ui-sounds.ts    delegated click listener
  music.ts        Music (moved from apps/game/src/audio.ts, + setVolume)
```

---

## 6. Build plan

Two lanes. Lane 2 can start at once on a hand-written fixture index (a few entries of §4.3) while Lane 1 runs.

### Lane 1: sound export (convert + shared)

**Owned files (new):**
- `packages/shared/src/sound.ts`: §4.3 types, `SOUND_INDEX_FORMAT`, `validateSoundIndex`, `soundHandle`,
  `mobSoundObject`, `playerVoiceObject`, `STEP_SUFFIX` (surface → `[walk, run]` suffixes of §2.4).
- `packages/convert/src/sound/effectsound.ts`: `parseEffectSound(text): EffectSoundRow[]`
  (`{ object, handle, skill, event1, event2, event3, blank, file, volume, description }`), plus lookups by object/handle/skill.
- `packages/convert/src/sound/envsnd.ts`: `parseEffectEnvSnd(text): EnvArea[]`.
- `packages/convert/src/sound/regioninfo.ts`: `parseRegionInfo(text): RegionArea[]` (`RECT` args kept raw).
- `packages/convert/src/sound/resolve.ts`: `SoundResolver` (exact lower-case path, `sound\` prefix strip, unique
  basename fallback, unresolved report).
- `packages/convert/src/sound/tracks.ts`: `modelTracks(bsr: BsrResource, sidecarAnims, resolver): ModelSounds`
  (§2.1 join).
- `packages/convert/src/sound/pcm.ts`: WAV parse (fmt/data chunks, 8/16/24-bit), trailing-silence trim, downmix,
  16-bit mono WAV write.
- `packages/convert/src/sound/encode.ts`: ffmpeg detection and `spawnSync` encode, cache.
- `packages/convert/src/sound/build.ts`: assembles `SoundIndex` from all the above.
- `packages/convert/src/tools/export-sound.ts`: CLI (§4).

**Hook points (shared files, small):**
- `packages/shared/src/index.ts`: `export * from './sound.ts'`.
- `apps/server/src/static.ts` `COMPRESSIBLE`: add `'.wav'` (only matters for `--codec wav`; PCM gzips ~12%). Its
  `MIME` already has `.ogg` and `.wav` [confirmed].
- `apps/game/vite.config.ts` `MIME`: add `'.wav': 'audio/wav'` (it has `.ogg` but no `.wav` today [confirmed]; dev
  server; only for the wav fallback).
- `docs/ASSETS.md` §2 table "Everything else" row: mention `sound/`.

**Tests:**
- `packages/convert/test/sound.test.ts` (synthetic, no game data): effectsound row parsing (CP949 text with a comment,
  `-` cells, duplicate rows, textdata-over-resinfo precedence); effectenvsnd blocks (`0~0` loop, `15~30`); regioninfo
  `ALL`/`RECT`; resolver (exact, `sound\` prefix, unique basename, ambiguous basename → unresolved); `soundHandle` for
  every event name of §2.1 including the typos; `mobSoundObject`/`playerVoiceObject` for all special cases;
  `modelTracks` precedence (LOCOMOTION by ban over aniSet by group+type) on a synthetic `BsrResource`; PCM trim keeps
  leading silence and a 20 ms tail; hit-file name parsing (`hit2b` → strong/b).
- `packages/convert/test/sound.out.test.ts` (skips without `work/out/sound/index.json`): `validateSoundIndex` has no
  problems; every `files[*].url` (and `wav`) exists on disk with `bytes` equal to its size; every file id referenced from
  cues, steps, hits, skills, voices, mobs, areas and every `model/*.json` track exists in `files`; every code in
  `characters.json` has a voice set and a model entry; every Jangan mob code in `mobs.json` has `mobs[code]`; areas
  `JANGAN_TOWN` and `JANGAN_FIELD` exist with a loop layer; the 22 `mv*` files exist; `MOB_CH_MANGNYANG` `ATTACK1`
  has a `swing` track at 607 ms; `CHAR_CH_MAN_ADVENTURER` `RUN` has `step_run` tracks at 289 and 619 ms;
  `hits.PUNCH.strong` is non-empty (§2.6 PUNCH rows).
- A corpus-style check in the same file, skipped without `sro.config.json`: the census counts of §2.1 (398 / 30,866 /
  1,230, and 87 missing paths) for `--scope all` parsing (parse only, no encode). Needs the BSRs from
  `work/extracted/Data` or the pk2 (5,563 parses take ~1 min: give the test a generous timeout or gate it behind an
  env var).

**How the user checks it:**
1. `pnpm tsx packages/convert/src/tools/export-sound.ts` prints files, MB in/out, tracks and unresolved counts
   (expect about 590-600 files, 29 MB → 4 MB, about 21 unresolved BSR paths after the basename fallback plus any
   missing effectsound files).
2. Open `http://localhost:5173/out/sound/ui/itlevelup.ogg` (or `/out/sound/monster/cm_mang_die.ogg`) in the browser: it
   plays.
3. `pnpm vitest run packages/convert/test/sound.test.ts packages/convert/test/sound.out.test.ts` passes.

### Lane 2: sound runtime (game)

**Owned files (new):** everything in §5.14, `apps/game/src/hud/sound-settings.ts`, `apps/game/test/audio.test.ts`.
`apps/game/src/audio.ts` becomes `export * from './audio/music.ts'` (or is removed once its two importers change).

**Hook points (shared files, small, in this order):**
- `apps/game/src/main.ts`: create `GameAudio` after the `Promise.all([... Art.load() ...])`, pass it to `App`, set the
  `gameAudio()` accessor, install `ui-sounds`, corner button → master mute (`corner.soundOn/Off`). `main.ts` and
  `app.ts` are the only two importers of `apps/game/src/audio.ts` today [confirmed].
- `apps/game/src/app.ts`: `readonly audio: GameAudio` constructor field next to `music` (the constructor is positional:
  `new App(engine, kind, params, transport, catalog, art, music)`, so append it last).
- `apps/game/src/three/models.ts` `CharacterActor`: add `clipCursors()` (§5.7) plus the `run` counters in `play()`,
  `playAction()`, `hurt()` and the `silent` flag in `die(instant)`. About 25-30 lines, behaviour unchanged. Export
  `KEEP_CLIPS` (§5.4).
- `apps/game/src/world/entities.ts`: `EntityContext` gains `audio: GameAudio | null` and `surfaceAt?(x, y, z)`;
  `EntityView` creates `this.sound = ctx.audio?.entity(state)` in the constructor, calls
  `this.sound?.update(this.actor?.clipCursors(), this.root.position, now)` near the end of `update(now, dt)` (before
  the fade-out `return false`), calls `ctx.audio?.preloadModel(state.model)` at the top of `load()` (skip
  `kind === 'item'`), and `this.sound?.dispose()` in `dispose()`.
- `apps/game/src/world/jangan/heights.ts`: `selfSurfaceKind()` accessor next to the existing `selfSurface` getter (§5.8).
- `apps/game/src/screens/world.ts`:
  - the `ctx: EntityContext` literal (~l.287): add `audio: app.audio` and `surfaceAt` *(fact-check: missing before)*;
  - the frame observer (`scene.onBeforeRenderObservable.add`, ~l.892): `audio.setListener(selfPos, forward)` (§5.6:
    forward vector, not `camera.alpha`);
  - `onCombat` per-hit `timeline.after` callback (~l.464): `audio.hit(...)`;
  - `case 'levelUp'`: `audio.play('ui.levelUp', ...)`;
  - `onActionResult` `case 'pickup'` when `msg.ok`: `audio.play('item.pickup')`;
  - `onMessage` `case 'spawn'`: gold drop cue *(fact-check: not `addEntity`, which also runs for the enter snapshot)*;
  - `updateMusic()`: `audio.setArea(...)`;
  - `openMenu`: a "Sound" button opening `sound-settings.ts` (and a taller menu window);
  - screen `dispose()`: `audio.setArea(null)`.
- `apps/game/src/hud/window.ts`: `open()`/`close()` window cues via `gameAudio()`; `data-sfx="none"` on the close
  button. `apps/game/src/hud/index.ts`: `toast(..., 'error')` → `ui.error`, and `applyInventoryUpdate` equip changes
  → `item.equip.<KIND>` *(fact-check: the equip hook was missing from this list)*.
- `apps/game/src/i18n/en.ts`: the keys of §5.12; drop `corner.musicOn/Off` when unused.
- Skills lane (when its ActionPlayer lands): `entity.sound.setSkill(group | null)` on `cast`/action end, and
  `audio.skillStage(...)` (§5.9). Until then basic attacks already work through `onCombat` + §5.7.

**Tests (`apps/game/test/audio.test.ts`, node, no AudioContext):**
- `AudioSettings`: defaults, clamping, corrupt JSON, a throwing storage, `sro.muted` compatibility.
- `ClipSoundDriver`: plain advance, loop wrap, clip change, action → base return, a large jump fires nothing; RUN at
  289/619 fires twice per 800 ms loop; a restart of the same clip (new `run`) at 400 ms after 300 ms does **not** fire
  the tail of the old run; a `silent` DIE1 fires nothing.
- `cues.ts`: Stone/Grass/Water substitution for `player/mvrunground`; mob walk file kept; hit selection
  (hit → `hit1n`, crit → `hit2n` + crit layer, big mob → `b`); skill swing override on and off; unknown code → generic sets.
- `VoicePolicy`: bus caps, same-file cap steals the oldest, priority/distance steal order, per-entity voice replace
  (a death voice is not replaced), retrigger guard, distance culls, self never culled.
- `AmbientPlayer` scheduling with a seeded RNG and a fake clock: loop starts once, one-shots fall inside `everyS`, an
  area change cancels timers.
- `SurfaceProbe` on a synthetic 2×2-region world: tile type lookup, the object-floor threshold, missing tile → Dirt.
- A fixture `SoundIndex` passes `validateSoundIndex` (from `@sro/shared`).

**How the user checks it** (`pnpm dev`, log in, enter Jangan):
1. Click any button on the login screen: a soft click. Open and close the inventory: open/close sounds.
2. Stand in town: Jangan town music plus wind and birds every few seconds.
3. Walk on the plaza: hard-floor steps in time with the feet. Walk onto grass: grassy steps. Run: faster run steps.
4. Walk out of town: the music changes to the field track (as today) and the ambience continues without a gap.
5. Attack a Mangnyang with a blade: swing and shout on each swing, a cut sound on each hit (a heavier one on crits), the
   Mangnyang grunts; when it dies, its death cry and a thud about 1.5 s later.
6. Let a Mangnyang hit you: its cleaver swing, its shout, the hit, your character's grunt.
7. Pick up the gold it dropped: a coin sound when it drops, a pickup sound when you take it.
8. Level up (GM `/level` or kill enough): the level-up fanfare.
9. Esc → Sound: move the sliders; each category changes live and survives a reload. Switch to another tab: silence;
   switch back: sound resumes.
10. With another player nearby (a second browser), their footsteps and swings come from their side and fade with
    distance.

---

## 7. Open questions and risks

- **Blade clips.** `three/models.ts` `FAMILY_ATTACK.blade = /^ATTACK\d$/` and `FAMILY_PACK.blade = null` make blades play
  the default group's ATTACK clips, which are unarmed punches (`chinaman_a_handstraightl`) with `batpunchswing` tracks.
  SKILLS.md §6 says the sword group covers sword and blade. Sound follows whatever clip plays, so fixing the clip
  table (animation owner) also fixes the swing sounds.
- **Clip track vs effectsound skill row** for swings (Strike Smash `csk_sword_swing_a` vs `_b`) [unknown]; one constant.
- **Target class** (n/b/a) has no known data column [unknown]; the size heuristic is a guess.
- **`RECT` rows** in regioninfo [unknown]; town/field uses the existing safe area instead.
- **Opus in Safari** [unknown]; `--also-wav` is the escape hatch.
- **Opus loop seams:** `decodeAudioData` should honour Opus pre-skip for Ogg [likely], but a looped `day_wind` may click
  at the seam. If audible, export `env/*` loops as trimmed PCM WAV (1.5 MB for Jangan) or apply a 10 ms
  `loopStart`/`loopEnd` inset.
- **Shout spam:** retail shouts on every player swing; with several players in a fight this is loud. The 50% rule and
  the per-entity voice limit are design choices to tune by ear.
- **Sound config fields** in BSR sound mods (`flags`, `float0` 10, `float1` 100) [unknown]; possibly DirectSound 3D
  min/max distance.
- **Night ambience** is exported but unused until a day cycle exists.
- **Left/right swap** (§5.6): the world scene is left-handed; without the z flip every positioned sound pans to the
  wrong side. One ear test settles it.
- **Clip restarts and instant deaths** (§5.7): without the `run` counter and the `silent` flag, repeated attacks fire
  stale swing tails and every corpse screams on world enter. Both are covered by driver tests.
- **Shared-file churn:** `world.ts`, `entities.ts`, `models.ts`, `main.ts`, `hud/*` are being edited by other lanes;
  keep each hook a few lines and re-read the file before patching (line numbers above are from 2026-09-27).
- **NPC idle sounds** (`snd_stand`) are rare in scope (6 tracks) and play only within 15 m.
- **Scope growth:** `--scope all` is about 1,300 files; the Opus ratio (~14%) puts it near 20 MB.

---

## 8. Weather sounds (wave 9, docs/WEATHER.md §7.5)

The export adds 12 retail files in every scope, and their cues. The lists live in `packages/shared/src/sound.ts`
(`WEATHER_SOUND_FILES`, `WEATHER_CUES`, `thunderCue`, `addWeatherSounds`). The exporter calls `addWeatherSounds(plan)`
right after `planSoundIndex`. All 12 are ambient class: 64 kbps Opus, stereo kept (only the rain is stereo). The runtime
(`apps/game/src/audio/weather.ts`, WX-C) plays them on the ambient bus and scales the gain by rain, gust and distance,
so every cue has gain 1.

| File id | Retail (ffprobe) | Exported `ms` | Shape (RMS envelope) | Cue |
|---|---|---|---|---|
| `etc/rain1` | 2.32 s, 22.05 kHz stereo | 2,324 | flat at −22 dB: a clean loop | `weather.rain` |
| `etc/lightning1` | 6.19 s mono | 6,097 | cracks at once (−11 dB), decays | `weather.thunder.near` |
| `etc/lightning2` | 8.16 s mono | 8,058 | builds for 1.5 s, peaks at −5 dB | `weather.thunder.mid` |
| `etc/lightning3` | 11.80 s mono | 11,624 | early peak, then a long rumble | `weather.thunder.far` |
| `env/donhwang_wind04` | 20.72 s mono | 16,237 | three gusts with ~1 s silent dips, fades out | `weather.wind.gust` (W9F A5; was `weather.wind.strong`) |
| `env/dd_wind_01`, `_02` | 3.58 / 3.44 s mono | 3,578 / 3,440 | one swell each | `weather.wind.gust` |
| `env/donhwang_wind01`, `02`, `03`, `05` | 6.71 / 11.65 / 15.79 (44.1 kHz) / 2.26 s | 4,307 / 5,502 / 11,390 / 2,182 | one swell each, fading to silence | `weather.wind.gust` |
| `env/dd_mainwind` | 1.99 s mono | 1,990 | flat at −39 dB: a steady loop | `weather.wind.strong` (W9F A5) |

Measured 2026-09-28 on the export: 76.7 s of audio after trimming (94.6 s raw), 0.63 MB of Opus. The exporter trims
trailing silence from every file (`trimTrailingSilence`, |sample| ≤ 32), which cuts 2.4 to 6.2 s of silent tail
from the donhwang winds. Nothing here is in the retail effectsound or effectenvsnd tables, so the cue names are our
rule.

- **Light wind bed:** `env/day_wind` (6.0 s, the Jangan day loop), already exported by the area layers. It is not a
  weather cue.
- **Strong wind:** `donhwang_wind04` is not a steady loop. Looped alone, it pulses: gust, silence, gust (W9F A5: 39 %
  of it more than 30 dB under its mean, a 2.9 s dropout). So it is a `weather.wind.gust` one-shot now, and the
  strong-wind bed is the steady `dd_mainwind` (no window more than 30 dB down) in two voices at 0.98 and 1.02 playback
  rate 0.9 s apart (its 2 s loop's seam hidden like the rain's), lifted by `WEATHER_AUDIO.wind.bedGain` (×8, +18 dB:
  peak −9.7 dBFS, the old bed's level). Still a listening call; `apps/game/test/abuse-w9f-audio.test.ts` A5 guards the
  dropouts of whatever file the cue names.
- **Thunder:** `thunderCue(distM)` picks near below 800 m, mid below 2000 m, and far beyond. The file order follows
  the envelopes above but is not verified by ear. To reassign, edit `WEATHER_CUES`: the client takes the code's weather
  cues over the exported index's whenever the index has their files (`GameAudio.weatherCue`), so a reassignment among
  the 12 exported files needs no re-export; a new file does.
- **Better recordings** (optional): CC0 rain, thunder and wind supplied by the user go into `content/sound/` under the
  same cue names. Nothing is downloaded by the build.
- **Tests:** `packages/convert/test/sound-weather.test.ts` checks that the plan lists the 12 files, that the cues
  exist, and that the files survive `finishSoundIndex`. It also checks that the real export wrote
  `work/out/sound/etc/rain1.ogg` and the rest; that part skips without `sro.config.json` or an exported index.
- **Mirror:** as for every sound, the export mirrors the files to `work/out-opt/sound/`, so there is no
  `optimize-out` re-run.

### 8.1 Runtime (wave 9, `apps/game/src/audio/weather.ts`)

`WeatherAudio` (owned by GameAudio, driven every frame by the weather feature, `world/features/weather.ts`) plays on
the ambient bus. It hears the same frame the world renders: without the new look (the rollout gate) that is a clear
sky, so it stays silent. `graphics.weather` `off` is a render level and does not mute it (WEATHER.md: "off" keeps the
cheap sky, fog and light changes, and the sound).

| Sound | Rule (`WEATHER_AUDIO`) |
|---|---|
| Rain bed | `weather.rain` in two voices 1.1 s apart at 0.97 and 1.03 playback rate (hides the 2.3 s loop's seam); gain `0.8 × rain` |
| Shelter | a roof or canopy more than a head above the listener (the shelter map, `shelteredAt`): the rain bed −6 dB through a 900 Hz low-pass. Only at weather levels Medium and up: Low and Off build no shelter map (the Low preset, an integrated GPU on auto, Weather effects: Off), so there the bed stays unmuffled (W9F A2; the friends' discrete and Apple GPUs get Medium and up) |
| Strong wind | the `weather.wind.strong` bed (two voices, see §8) fades in between 6 and 10 m/s of gusting wind at `clamp(gust / 15)` × `bedGain`; the area's light bed (`env/day_wind`) keeps playing under it. A lull holds it at gain 0; it stops only after 12 s below the threshold, and every start begins at a random point of the file (W9F A1: in steady rain the gusts crossed 6 m/s every few seconds and restarted the file's opening 15 times in 2 minutes) |
| Gusts | `weather.wind.gust` one-shots above 9 m/s, every 5–12 s, up to 0.7 |
| Thunder | `thunderCue(distM)` (near < 800 m, mid < 2000 m, far beyond), gain `clamp(1.4 − distM / 2500, 0.25, 1)`, due `distM / 343` s after the flash on the server clock, panned toward the strike; one more than 3 s late is dropped. W9F A3: the three thunder files load once the rain reaches 0.4 (lightning only comes with rain:0.8 and up or a storm), and a thunder whose file is still loading plays when it arrives within 2.5 s instead of being lost. A4: without the new look a strike loads nothing |
| Birds | the area one-shots are muted while rain > 0.25 or wind > 10 m/s, and come back below 0.2 / 9 m/s |

Gains ramp over 0.4 s (re-sent only after a change of more than 0.01); beds fade in over 1.5 s and out over 2.5 s.
Tests: `apps/game/test/weather-feature.test.ts` (with a fake audio backend).

## 9. Wave 11: the town's sound and the unique cues (docs/TOWN_LIFE.md §6, docs/UNIQUES.md §3.3)

**The town bus** (`apps/game/src/audio/town.ts`, `TownAudio`; wired by `world/features/town-sound.ts`; everything on
the ambient bus, so the Ambient slider and mute apply):

- **The bed**: two 20 s seamless loops (`town.bed.calm`, `town.bed.busy`), cross-faded over 1.5 s by the folk within
  30 m: gain `smoothstep(0, 25, folk)` × 0.9, the busy loop taking over between 6 and 22 folk; at night (20:00–05:00)
  silent below 5 folk. The count is the crowd's own (`World.town.folkNear`, through the town feature); on Low, where no
  crowd draws, the pure schedule's estimate (`populationNear` / the district estimate) drives it, so the bed and the
  bell play on every preset.
- **The bell** (`town.bell`, retail `env/bell towel 3.wav`): once per game hour (three strokes at 06:00 and 18:00),
  heard town-wide (450 m, roll-off 60 m) from the tower's direction; never on a clock jump.
- **One-shots** (≤ 3 at a time, the bell aside; ≤ 3 loops): the vendor murmur when a vendor's call bubble starts, the
  smith's hammer (06:00–19:00, bursts every 14 s), horses, chickens, the dog (the pet wolf's voice pitched up), cats,
  donkeys and cows near their spots, the pigeons' wing claps when a flock takes off, and the fountain's splash loop
  (on within 25 m, off beyond 32 m). Each culls by its own distance. Night in town mutes the day one-shots and plays
  the night layers.
- **The synthesized files** (`packages/convert/src/sound/town-synth.ts`, seed `0x7a11`, 22,050 Hz): the two bed loops
  (granulated retail emote voices, no word survives), the fountain loop, the murmurs, hammer strokes, chickens, the
  dog and the wing claps: 20 files, made offline by the sound export (nothing downloaded; the same seed gives the same
  bytes). The retail `cos_horse_*`, `cos_cat_*`, `cos_wolf_01_*`, `cos_donkey_*` and `cos_cow_*` files are used as
  they are.

**The unique cues** (W11-CV's cue table, `packages/convert/src/sound/build.ts`): `ui.uniqueAppear` =
`ui/alarm_sound.wav` (the retail unique alarm) when the appear banner shows, `ui.uniqueDown` = `ui/eventcomplete.wav`
when the defeat banner shows. Both play on the UI bus when their banner reaches the screen (a banner queued behind a GM
notice waits with its cue) and never outside the world.

**Budgets met** (TL-S): ≤ 0.05 ms main thread per frame; the bed is its own loop voice beside the area loop.

> §10.5 (2026-10-05) changes this section's rule: the bed and the vendors' murmurs play only while the crowd draws
> townsfolk.

## 10. Missing-sound pass (2026-10-05): every retail cue group and its status

The user heard gaps: imbued hits had no element sound, and equipping an accessory had no "diiing". This pass compared
the retail sound events with the export and with what the client triggers. The retail sources are the effectsound.txt
rows (`UI`, `ITEM`, `PLAYER`, `PCM_`/`PCF_`, `MOB_`, `COS_`), skilleffect cols 26/27, the BSR clip tracks,
effectenvsnd and the files in `prim/snd`. Tests: `apps/game/test/audio-gaps.test.ts`,
`apps/game/test/town-crowd-sound.test.ts` and `packages/convert/test/sound-gaps.test.ts`. Each also checks the real
export when `work/out/sound` exists.

### 10.1 Status table

**Working** = played before this pass. **Fixed** = played since this pass. **Out of scope** = not played; the reason
is given.

| Cue group (retail source) | Status |
|---|---|
| Footsteps by surface (BSR `snd_walk*`/`snd_run*`, `PLAYER SND_WALK1/RUN1 FIELD`), jump steps | working |
| Weapon swings and shouts, skill clip swings (BSR tracks), skill swing rows (`SND_SWING_S*` override) | working |
| Skill stage sounds (skilleffect col 26: READY, WAIT, ACT_S, ACT_L, SHOT) | working. Col 27 (SndEnd) is `none` on every in-scope `SKILL_CH_` group |
| Hit impacts (`SND_DMG` per skill group, `SKILL_CH_<FAMILY>_BASE`, weapon rows, mob attack rows), `SND_CRIDMG` crit layer | working |
| **Imbue hits** (`PLAYER SND_DMG SKILL_CH_{COLD,LIGHTNING,FIRE}_GIGONGTA_*`: `csk_{cold,light,fire}_gigong_hit`) | **fixed**. The client never looked at the attacker's imbue. Every landed hit of an imbued attacker (basic or skill) now layers the imbue's SND_DMG on the weapon impact [likely: layered, as the imbue's DamageEfp is layered on the hit spark, EFFECTS.md M14] |
| Imbue activation (`SND_ACTIVATE`, ACT_S `csk_*_gigong_hand`) | working |
| **Berserk ('hwan') hits and swings** (`SND_DMG/SND_CRIDMG HWAN`, `SND_SWING3 HWAN <weapon>`) | **fixed**. They were exported as `hit.imbue`/`swing.imbue` (misnamed, with one swing cue for every weapon) and never played. Now `hit.hwan`, `hit.hwanCrit` and `swing.hwan.<WEAPON>`: a Berserk basic attack hits with `batHwanHit` (crit layer `batHwanCriHit`) and swings with the weapon's HWAN swing. Skill hits keep their own row [likely] |
| Berserk orb gained (`UI SND_HYAN` HyanGet) | **fixed** (plays when `stats.hwan` rises) |
| Berserk start / end (skilleffect `SYSTEM_CH_HWANMODE`) | working |
| **Shield buff hit** (`PLAYER SND_DDMG SKILL_CH_COLD_BINGBYEOK_*`, Ice Wall, level 17: `csk_cold_hosin_hit`) | **fixed**: a hit on a victim carrying the buff adds this layer |
| Hurt moans (BSR DAMAGE1 track), **crit moan** (`VOC_MOAN CRITYCAL`) | moans working; **crit moan fixed**. A player's crit cry was cut one frame later by the DAMAGE1 moan, and mobs had no crit cry. The hurt clip's moan after a crit is now the CRITYCAL file, for players and mobs |
| **Tombstone's force attacks** (`MOB_TOMBSTONE SND_SWING1 MSKILL_CH_TOMBSTONE_*`; its BSR has no attack tracks) | **fixed**: a mob attack clip without swing or shout tracks plays its attack's effectsound swing at the clip start |
| Death cry and thud (BSR DIE1 tracks, fallback `VOC_DEATH`/`SND_DEATH`) | working |
| Dodge voice (`VOC_AVOID`), block (`SND_BLOCKING` normal / bow) | working. `block.crit` / `block.bowCrit` (the strong block rows) are out of scope: the wire has no strong-block outcome |
| Sit / stand voices (`VOC_SITDOWN/STANDUP`), emote voices (`voc_emo`) | working through the SIT_DOWN, STAND_UP and EMOTION0x clip tracks (checked in code and data, not by ear in this pass) |
| Mob idle (`SND_STAND`), NPC idle tracks | working (STAND clip tracks) |
| Mob call for help (`MOB_TIGERWOMAN SND_HELP`) | out of scope: her BSR has no HELP track and the game has no help event |
| **Accessory equip** (`ITEM SND_EQUIP RING/NECKLACE/EARRING`: `itRing`) and every other equip | **fixed**, see the root cause below |
| Item put into a slot: bag moves, unequip, consumables (`SND_EQUIP POTION/SCROLL/HERB/QUIVER/MOBPIECE`) | **fixed**. SND_EQUIP is the "item placed" sound (the table has kinds nobody wears). Potions use POTION, cure pills HERB, scrolls SCROLL, arrows QUIVER; quest items MOBPIECE and alchemy items POTION [our rule for these two] |
| Quick slot icon placed (`SND_EQUIP QUICKSLOT`, retail file misspelled `itQuckicon`) | **fixed**. The path fix exports `ui/itquickicon`; it plays on a `skillsUpdate.hotbar` slot that gets an entry |
| Pickup (`SND_PICKUP`), gold drop (`SND_DROPITEM GOLD`), potion drink, level up, repair, durability warning/break | working |
| Rare drop (`SND_DROPITEM RARE`, a Seal of Star `_RARE` item), elixir drop (`ELIXIR`, alchemy items) | **fixed**. Other drops have no row (BOX and BAG are commented out in 1.188), so they are silent |
| Revival (`UI SND_REVIVE` itRevive) | **fixed**: your own in the interface, others' where they stand |
| Quest window / done (`UI SND_QUEST` QuestOpen, `SND_QUEST_END` ItQuest) | **fixed**: on `questUpdate` accepted / completed |
| Buttons, windows, error toast | working. `ui.click2` (the second click row) has no known retail trigger; `data-sfx="click2"` plays it |
| Warning beep (`UI SND_WARNING` Biff) | out of scope: no retail trigger in the data (the client exe decides, and we do not have it) |
| Alchemy: use, success, failure | working. `SND_ELIXIR_DESTROY` is out of scope: our alchemy never destroys an item |
| Horse (`COS_C_HORSE`), pet summon (`SND_COS_SUMMON`) | working. `SND_COS_UNSUMMON` is commented out in 1.188 |
| Gacha, sockets, set items (`SND_GACHA_*`, `SND_SOCKET_*`, `SND_SETITEM_*`) | out of scope: these systems are not in the game |
| Portal exit (`UI SND_WARP` Gatein) | out of scope: commented out in the 1.188 table |
| `ui/buf_disappear`, `ui/itfly`, `itfly_bag/box`, `countdown*` | out of scope: no row names them (hardcoded in the exe, or from later versions) |
| Music, area ambience, weather, coast, town bell/animals/fountain, unique notices | working (not changed) |
| **Townsfolk voices** (the town bed, the vendors' murmurs) | **fixed**, see §10.5 |
| European skills and voices, other regions' mobs and areas | out of scope (Jangan, Chinese characters) |

**The accessory root cause.** The equip sound played on any equip-slot change in `inventoryUpdate`, with the 150 ms
interface wait and nothing preloaded. Armour and weapons were still heard, because durability ticks are equip-slot
changes too: they played those sounds during fights, so the files were cached. Accessories have no durability, so
their file was never cached, and over the friends' link the first equip was dropped ("too late"). Now:
- every `item.equip.*` file is preloaded at world enter;
- the sound plays when the server accepts the own move, equip or unequip request, waiting up to 600 ms;
- durability ticks no longer play equip sounds.

### 10.2 Retail path fixes

`packages/convert/src/sound/resolve.ts` `RETAIL_PATH_FIXES` runs before the unique-basename fallback, and only when the
target file exists.
- Typos [confirmed]: `ui\itQuckicon` → `ui/itquickicon`, `mvfrunground` → `mvrunground`.
- The same sound under the folder's name [likely]: `skill\csk_bow_swing_a/_b` → `skill/csk_bow_swing`; Hyungno's
  `wchina_jombie_*` → `wcm_jombie_*`; `wcm_hchen_moan1` → `wcm_hchen_moan1_a`; `cm_yeoha_{die,shout}_a` →
  `cm_yeoha_{die,shout}`; `cara_bunwang_shout1` → `cara_bunwang_shout`; `cm_mang_moan2` → `cm_mang_moan1`.

The export's unresolved list went from 29 to 14. The rest are files that exist nowhere: `dd.wav`,
`cm_tombstone_shout`, three female avoid alternates, `vcf_at_shout1_b`/`shout2_a` on the male BSRs,
`csk_gwi_ilgyeo_swing`, `csk_hwa_jigong_swing`, `csk_pung_noeho_swing`, and one European file.

### 10.3 Runtime hooks

- `audio/cues.ts`: `hitSound` takes `imbue`, `hwan` and `guards`; `trackFile` takes `hwanSwing`; `equipKind` covers the
  consumables; new `placedItem`, `dropCue`, `isBasicGroup` and `hwanSwingCue`.
- `audio/carried.ts` `CarriedSkills`: the imbues and buffs per entity, from `EntityState.effects`, `effectAdd`,
  `effectRemove` and `despawn` (an imbue is skills.json kind `imbue`).
- `audio/index.ts`: `place(code)`, `drop(code, pos)`, and `preloadSkill(group)` (an imbue's files when it starts). The
  world-enter preload adds every `item.equip.*` cue and the §10 cues. In `hit()` only the impact counts against the
  victim's 2-sfx cap, so the layers (crit, imbue, shield) never steal the impact.
- `audio/entity.ts`: `setHwanSwing`, `critHit`, and the mob attack-start swing.
- `world/features/sound.ts`: the carried effects; Berserk (`EntityState.berserkMs`, `entityUpdate.berserkMs`,
  `CombatHit.hwan`); revival; the Berserk orb; quests; the quick slot; drops.
- `hud/index.ts`: the placement sound on the accepted own request (it replaces the equip-slot hook).

**Checked in the running game** (mock server, `?sounddebug=1` log):
- Equipping a ring and then a necklace logs `ui/itring` on the first equip.
- Thunder Tiger Force logs `csk_light_gigong_hand`. Each following basic hit logs `batswordhit1n`,
  `csk_light_gigong_hit` and the Mangnyang's moan.

Berserk, the shield buff, the crit moan, Tombstone, quests, revival and drops are covered by the tests only.

### 10.4 Exporting without ffmpeg

Asked for Opus on a machine without ffmpeg, `export-sound.ts` used to re-encode the whole tree as PCM WAV. Now it
keeps every cached `.ogg` and writes only the files that need encoding as trimmed PCM `.wav`.
- Each `SoundFile.url` names its own file, so a mixed tree plays. The server and Vite already serve `.wav`.
- The cache entries of those files say `wav`, so a later run with ffmpeg turns them into `.ogg`.
- This pass's export wrote 4 such files: `ui/itquickicon`, `skill/csk_bow_swing`, `monster/wcm_jombie_walk` and
  `monster/cara_bunwang_shout` (108 KB of PCM, mirrored to `work/out-opt/sound`).

### 10.5 The townsfolk's voices follow the drawn crowd

The user reported that with Town life off, the townsfolk could still be heard talking. Two sounds caused it, both by
design (WAVE_PLAN7 D23, H11 S3):
- §9's bed (granulated voices) followed the pure schedule's count on every preset;
- the built-in stall murmurs played whenever no crowd sent vendor calls.

Now `TownAudio.setCrowd(drawn)` gates both. The town feature (`world/features/town.ts`) reports whether the crowd draws
folk through `setTownCrowd` in `town-sound.ts`. The value is kept whichever feature starts first, and it is false until
a crowd reports, so Low has none.

Without a drawn crowd (Town life Off, switched live or at entry; Low; a crowd that draws nobody):
- the bed fades out over 1.5 s and no murmurs play;
- the schedule still counts (`folk`);
- the bell, the fountain, the smith's hammer, the animals and the night layers keep playing.

**Checked in the running game**, in the plaza at noon: with Full the bed plays (busy 1.0). With Off, set live and
also from world entry, the bed is 0, no loops play and no murmurs are heard in 25 s, while a dog still barks.

## 11. Siege of Jangan, the walls (docs/SIEGE.md §9.4, layer 2)

Every scope adds `SIEGE_SOUND_FILES` and `SIEGE_CUES` (packages/shared/src/sound.ts `addSiegeSounds`, called after the
town synthesis): the fortress war's `bldg/common/structure_dmg` and `structure_destroy`, `common/explode_bomb1/2`
and `common/stone_bomb` (new), plus the Stone Ghost's thuds, `env/bell towel 3` and the town hammer (already
exported). The cues are `siege.wall.chip`, `siege.wall.collapse`, `siege.wall.blast`, `siege.keg.blast`,
`siege.stone.fall`, `siege.bell` (ambient) and `siege.repair`. The client (`apps/game/src/world/walls/sound.ts`)
plays them 3D with each cue's own long roll-off, like the town bell. The 2026-10-06 export had no ffmpeg, so the five
new files are PCM .wav (528 KB, §10.4); a run with ffmpeg makes them .ogg.
