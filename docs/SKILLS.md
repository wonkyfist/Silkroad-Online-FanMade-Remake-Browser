# Skills and masteries spec (vSRO 1.188, Chinese, level cap 20)

This document covers how Chinese masteries and skills work, how the client data encodes them, and how they map to character animations, effects and icons. It ends with the plan for the skills wave: the server skill engine, the protocol additions, the client windows and a first playable slice.

It is a spec, not code. The data comes from `work/out/data/skills.json` and `masteries.json`, written by `packages/convert/src/data/skills.ts` (tests: `packages/convert/test/data-skills.test.ts`). Effects come from `work/out/fx/skills.json` (`packages/convert/src/fx/skills.ts`), and the runtime is `@sro/fx`. Animations come from the converted character sidecars (`work/out/char/china/*.json`).

## Status tags

- **[confirmed]**: checked against the real 1.188 rows under `work/extracted` or the converted clips. Most of these checks are repeated in `data-skills.test.ts`.
- **[likely]**: the data agrees and a source or the in-game text says so, but it is not proven.
- **[unknown]**: not decided by the data. Pick a rule and keep it in server config.

## Sources

| Tag | Source | Use |
|---|---|---|
| DATA | `Media.pk2 server_dep/silkroad/textdata`: `skilldata_*.txt` (plaintext twins of the `*enc` files), `skillmasterydata.txt`, `skillgroup.txt`, `skilleffect.txt`, `textdata_equip&skill.txt`, `textuisystem.txt`, `leveldata.txt` | Ground truth |
| CLIP | `work/out/char/china/chinaman_adventurer.json`: BSR aniGroups, clip lengths and type-1 hit events | Timing evidence |
| RR | Research report §4.3, §4.5, §5 (`Silkroad_Research_Report.md`) | Column names, the timing model, the network hit model |
| UI | `textuisystem.txt` `PARAM_*` tooltip captions (`PARAM_FZ` Freezing, `PARAM_ONFF_CONSUME_MP` "Every %d second %d MP will be consumed", `PARAM_NUMBER_OF_PERSON`, ...) | Tag names |

No source code was copied. Scratch scripts used for the measurements were deleted.

## 1. Masteries and skill points

### 1.1 The seven Chinese masteries [confirmed]

| Code | id | Tab / page | Weapons (cols 8-10) | Lines (GroupNum) | Skills ≤ 20 (rows) |
|---|---|---|---|---|---|
| BICHEON | 257 | weapon / 0 | sword, blade | 9 | 43 |
| HEUKSAL | 258 | weapon / 1 | spear, glaive | 8 | 27 |
| PACHEON | 259 | weapon / 2 | bow | 9 | 27 |
| COLD | 273 | force / 0 | — | 8 | 23 |
| LIGHTNING | 274 | force / 1 | — | 7 | 18 |
| FIRE | 275 | force / 2 | — | 8 | 19 |
| FORCE (Water) | 276 | force / 3 | — | 8 | 22 |

- skillmasterydata columns: 0 id, 2 name key, 3 GroupNum (skill lines on the page), 5 tab caption key (`UIIT_CTL_WEAPON_SKILL` "Weapon", `UIIT_CTL_FORCE_SKILL` "Force"), 6 Type (0 weapon tab, 1 force tab), 7 SkillToolTipType (0 weapon, 1 force, 2 Force/Water: "skills whose effect does not grow with the level", per the Korean header), 8-10 weapon TypeID4s, 11/12 mastery icon and focus icon.
- `skillgroup.txt` names each line: Service, Korean name, MasteryID, row (= the skills' UI column), description key (`UIIT_STT_MASTERY_GROUP_VI_0`), line icon (`skillgroup\china\pack_sword_smash.ddj`). It is not exported yet (see §10.6).
- The skill window has two tabs, Weapon and Force, with one page per mastery. Every skill row carries its placement (§3.1, cols 57-60).

### 1.2 Mastery levels

- **Cap per mastery = character level** [likely: vSRO rule, and nothing in the data contradicts it]. With `LEVEL_CAP` 20, every mastery stops at 20.
- **Total cap.** RR §4.4 gives 330 for Chinese characters in vSRO 1.188. Seven masteries at 20 total 140, so the total cap never applies below level 47. Keep it as config (`CH_MASTERY_TOTAL = 330`) anyway.
- **Cost.** Raising a mastery to level L costs `levels.json[L].masterySp` SP (leveldata col 2, Exp_M) [likely; the reading "from L to L+1" would need a row 0, which does not exist]. Raising one mastery from 0 to 20 costs **334 SP**:

  | L | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 |
  |---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
  | SP | 1 | 1 | 1 | 2 | 2 | 4 | 5 | 6 | 7 | 9 | 12 | 15 | 18 | 21 | 24 | 30 | 35 | 41 | 47 | 53 |

- **SP income.** Kills give SP-EXP, and 400 SP-EXP become 1 SP (`CHARACTER_RULES.spExpPerSp`, PROTOCOL §3). Learning every skill up to mastery 20 costs 413 (Lightning) to 756 (Bicheon) SP per mastery, plus the 334 for the mastery itself.
- **Withdrawal** (the `UIIT_STT_SKILL_LEV_POINT_RECOVER*` strings) is out of scope for the first slice.

### 1.3 Learning a skill [confirmed from the data layout]

- Each skill **level is its own row**, with its own code (`SKILL_CH_SWORD_SMASH_A_01` … `_08`), `sp` (col 46) and required mastery level (col 36). Rows of one skill share `group` (Basic_Group, col 5) and differ in `skillLevel` (Basic_Level, col 7).
- **Learning level N** needs:
  - level N − 1 of the same group, when N > 1;
  - the mastery at or above that row's `masteryLevel`;
  - `sp` free SP;
  - the prerequisites of cols 40-45 (skill group + level).
  
  Prerequisites start with the B tier (Strike Smash B at mastery 27 needs group 174, Strike Smash A, at level 9). **Below mastery 20 no row has one**, so the first slice can ignore them. The exporter still resolves them into `requires`.
- **Tiers.** A line (UI column) holds tiers A, B, C… (UI row 0, 1, 2). A higher tier is a new group with its own levels.
- **Chain segments** after the first have `sp` 0 and no UI placement (255). They are learned with the head.

### 1.4 Requirements to use a skill [confirmed columns, likely semantics]

| Column / param | Meaning | Examples |
|---|---|---|
| 50/51 ReqCast_Weapon1/2 (TypeID4; 255 = any) → `weapons` | Equipped weapon must be one of these | Bicheon attacks: sword, blade. All force skills: any |
| `reqi` [TypeID3, TypeID4] → `requiresItem` | Item that must be equipped | Castle Shield, Shield Protection, Fire Shield, Glacial Flame Bicheon Force: 4/1 (Chinese shield). Demon Soul Arrow: 6/6 (bow) |
| `reqc` [1] → `requiresTargetState` | The target must be knocked down | Flower Bloom Blade |
| `cnsm` [4, 1, 1] → `consumes` | Uses 1 arrow per cast (TypeID 3/3/4/1) | Pacheon attacks and the bow basic attack |
| 53 Consume_MP → `mp`; 52 HP; 54/55 HP/MP ratio (%) | Cost, paid when the action is accepted | Strike Smash L1 19 MP |
| 38/39 ReqCommon_Str/Int | Stat requirement | 0 on every row ≤ 20 |
| 20 Action_InTown | Allowed in town | 0 on every row ≤ 20 (the server's safe-zone rule decides) |

## 2. Skill kinds

`kind` is a new exported field (§3.2). The old `category` (melee / ranged / buff / passive) is kept.

| kind | Rule | Rows ≤ 20 | Examples | Engine behaviour |
|---|---|---|---|---|
| attack | an `att` record, activity 2 | 79 | Strike Smash, Illusion Chain, Soul Cut Blade, Shock Lion Shout | Damage on the target (and the area); may inflict statuses |
| imbue | an `att` record, activity 1 | 24 | Ice River Force, Thunder Tiger Force, River Fire force | Instant, no action. For `durationMs` (5 s), the caster's hits add the imbue's magical damage and roll its statuses |
| buff | none of the others | 40 | Weak Guard of Ice, Grass Walk, Castle Shield, Crystal Wall (toggle) | Timed modifier on self or a friendly target |
| debuff | hits enemies without `att` | 3 | Cold wave - Arrest | Projectile carrying statuses |
| heal | `heal` | 13 | Self Breathe Heal, Heal - Medical Hand | HP/MP now |
| cure | `curt`/`curl` | 5 | Force Cure - Poison | Removes abnormal states |
| resurrect | `resu` | 2 | Soul Rebirth Art | Targets a corpse (`targets.deadBody`) |
| passive | activity 0 or Param1 4 | 14 | Shield Protection, Cold Armor, Force Increasing | Permanent modifier while learned (and while `requiresItem` holds) |

**Crowd control** comes as statuses on attacks (§4): knockdown (`ko`, Blood Blade Force), stun (`st`, Soul Spear - Move), freeze/frostbite (Cold imbue, Arrest), shock (Lightning imbue), burn (Fire imbue). Knockback (`kb`) first appears at mastery 41. **AoE** is the `efr` record (§4.2): Dancing Demon Spear, Ghost Spear - Petal, Autumn Wind - Flame, Shock Lion Shout, Thunder Tiger Force (chain) and Wolf Bite Spear (pierce).

### 2.1 The skill lines up to mastery 20 [confirmed, from skills.json]

Timing is `castMs/actionMs/cooldownMs` for level 1 (§5). MP is level 1 → the highest level ≤ 20. Clips are READY WAIT SHOT.

**Bicheon** (sword/blade)

| Name | Group | Kind | Mastery levels of its rows | Timing | MP | Range m | Clips |
|---|---|---|---|---|---|---|---|
| Strike Smash | `SWORD_SMASH_A` | attack | 5, 7, 9, 11, 13, 15, 17, 19 | 411/1022/3000 | 19→53 | weapon | SKILL_1 |
| Illusion Chain | `SWORD_CHAIN_A` | attack, chain ×3 | 7 … 19 | 0/428/8000 | 32→75 | weapon | SKILL_2 |
| Castle Shield | `SWORD_SHIELD_A` | buff (shield) | 10, 13, 16, 19 | 0/0/60000 | 25→46 | — | — |
| Shield Protection | `SWORD_PASSIVE_A` | passive (shield) | 10, 20 | — | 0 | — | — |
| Soul Cut Blade | `SWORD_GEOMGI_A` | attack, projectile | 14, 16, 18, 20 | 341/792/4000 | 34→49 | 12 | SKILL_5 |
| Blood Blade Force | `SWORD_KNOCKDOWN_A` | attack + knockdown | 19 | 759/1107/4000 | 79 | weapon | SKILL_6 |
| Flower Bloom Blade | `SWORD_DOWNATTACK_A` | attack on knocked-down targets | 19 | 698/802/4000 | 70 | weapon | SKILL_7 |
| Glacial Flame Bicheon Force | `SWORD_SHIELDPD_A` | buff (shield) | 20 | 1300/700/180000 | 98 | — | SKILL_5 (default group) |

**Heuksal** (spear/glaive)

| Name | Group | Kind | Mastery levels | Timing | MP | Clips |
|---|---|---|---|---|---|---|
| Wolf Bite Spear | `SPEAR_PIERCE_A` | attack, pierce 2 targets | 5 … 19 | 568/1032/4000 | 29→84 | SKILL_1 |
| Bloody Fan Storm | `SPEAR_SPIN_A` | buff (MD) | 7 … 19 | 0/0/60000 | 20→46 | — |
| Dancing Demon Spear | `SPEAR_FRONTAREA_A` | attack, 1 m around target, 3 targets | 10 … 20 | 862/1138/3000 | 61→118 | SKILL_3 |
| Cheolsam Force | `SPEAR_PASSIVE_A` | passive (HP) | 10, 20 | — | 0 | — |
| Soul Spear - Move | `SPEAR_STUN_A` | attack + stun | 14 … 20 | 1128/1372/4000 | 92→133 | SKILL_5 |
| Ghost Spear - Petal | `SPEAR_ROUNDAREA_A` | attack, 2 m around caster, 5 targets | 19 | 0/2200/5000 | 140 | SKILL_6 |

**Pacheon** (bow)

| Name | Group | Kind | Mastery levels | Timing | MP | Clips |
|---|---|---|---|---|---|---|
| Anti Devil Bow - Missile | `BOW_CRITICAL_A` | attack, charged | 5 … 19 | prep 670, 300/530/4000 | 21→60 | READY01 WAIT01 SKILL_40 |
| 2 Arrow Combo | `BOW_CHAIN_A` | attack, `mc` 2 hits | 7 … 19 | 440/560/4000 | 15→36 | SKILL_2 |
| White Hawk Summon | `BOW_CALL_A` | buff (hit rate) | 10 … 19 | 0/1000/1000 | 51→93 | SKILL_3 |
| Mind Concentration | `BOW_PASSIVE_A` | passive (hit rate) | 10, 20 | — | 0 | — |
| Autumn Wind - Flame | `BOW_PIERCE_A` | attack, projectile pierce 3 | 14 … 20 | prep 670, 300/530/5000 | 50→72 | READY01 WAIT01 SKILL_40 |
| Demon Soul Arrow | `BOW_NORMAL_A` | buff (range) | 19 | 0/0/5000 | 77 | — |

**Cold**

| Name | Group | Kind | Mastery levels | Timing | MP | Clips |
|---|---|---|---|---|---|---|
| Ice River Force | `COLD_GIGONGTA_A` | imbue (freeze 5 %, frostbite 25 %) | 5 … 19 | 0/0/5000 | 52→149 | — |
| Weak Guard of Ice | `COLD_GANGGI_A` | buff (PD) | 8 … 20 | prep 1000, 1000/1000/2000 | 72→164 | READY04 WAIT04 SKILL_4 |
| Cold Armor | `COLD_PASSIVE_A` | passive (PD) | 10, 20 | — | 0 | — |
| Cold wave - Arrest | `COLD_GIGONGJANG_A` | debuff, projectile, frostbite 100 %, range 15 | 12, 15, 18 | 0/1000/4000 | 98→146 | SKILL_2 |
| Crystal Wall | `COLD_BINGBYEOK_A` | buff, toggle, absorbs physical damage | 17, 20 | prep 1000, 1000/1000/10000 | 165→197 | READY04 WAIT04 SKILL_4 |
| Snow Shield - Novice | `COLD_SHIELD_A` | buff (damage → MP) | 20 | 0/1000/180000 | 98 | SKILL_3 |

**Lightning**

| Name | Group | Kind | Mastery levels | Timing | MP | Clips |
|---|---|---|---|---|---|---|
| Thunder Tiger Force | `LIGHTNING_GIGONGTA_A` | imbue (shock 20 %, chains to 2 targets within 3.5 m) | 5 … 19 | 0/0/5000 | 52→149 | — |
| Must - Piercing Force | `LIGHTNING_GWANTONG_A` | buff (force damage +%) | 8, 11, 14 | prep 1000, 1000/1000/3000 | 72→113 | READY04 WAIT04 SKILL_4 |
| Heaven's Force | `LIGHTNING_PASSIVE_A` | passive (parry) | 10, 20 | — | 0 | — |
| Grass Walk - Flow | `LIGHTNING_GYEONGGONG_A` | buff (move speed +20 %), instant | 12, 15, 18 | 0/0/2000 | 98→146 | — |
| Shock Lion Shout | `LIGHTNING_CHUNDUNG_A` | attack, force, 2 m around target, 3 targets, range 15 | 17, 19 | 0/1000/4000 | 117→131 | SKILL_3 |

**Fire**

| Name | Group | Kind | Mastery levels | Timing | MP | Clips |
|---|---|---|---|---|---|---|
| River Fire force | `FIRE_GIGONGTA_A` | imbue (burn 25 %) | 5 … 19 | 0/0/5000 | 52→149 | — |
| Fire Shield - Phoenix | `FIRE_SHIELD_A` | buff (shield: abnormal-state power −%) | 8 … 20 | 0/2000/5000 | 72→164 | SKILL_5 |
| Flame Devil Force | `FIRE_PASSIVE_A` | passive (damage +%) | 10, 20 | — | 0 | — |
| Flame body - Wisdom | `FIRE_GONGUP_A` | buff (physical damage +%) | 12, 18 | prep 1000, 1000/1000/5000 | 98→146 | READY03 WAIT03 SKILL_3 |
| Basic Fire protection | `FIRE_GANGGI_A` | buff (MD) | 17, 19 | prep 1000, 1000/1000/5000 | 137→155 | READY04 WAIT04 SKILL_4 |

**Force** (Water)

| Name | Group | Kind | Mastery levels | Timing | MP | Clips |
|---|---|---|---|---|---|---|
| Self Breathe Heal | `WATER_SELFHEAL_A` | heal self | 5 … 19 | prep 1000, 1/1000/2100 | 16→46 | READY04 SKILL_4 |
| Force Cure - Poison | `WATER_CURE_A` | cure, range 15 | 8 … 20 | prep 1000, 1/1000/2100 | 29→66 | READY01 SKILL_1 |
| Force Increasing | `WATER_PASSIVE_A` | passive (MP) | 10, 20 | — | 0 | — |
| Heal - Medical Hand | `WATER_HEAL_A` | heal target, range 15 | 12 … 20 | prep 1000, 1000/1000/3000 | 74→123 | READY01 WAIT01 SKILL_1 |
| Soul Rebirth Art | `WATER_RESURRECTION_A` | resurrect, 10 % HP/MP | 17, 20 | prep 1000, 2000/1000/4000 | 137→164 | READY01 WAIT01 SKILL_1 |

**Basic attacks** are skills too: `SKILL_CH_SWORD_BASE_01` (1200 ms, `mc` 2 hits × 60 %), `SPEAR_BASE_01` (1166 ms, 117 %), `BOW_BASE_01` (840 ms, 84 %, uses arrows) and `SKILL_PUNCH_01` (1500 ms, 150 %). Their `castMs` is 0 and `cooldownMs` equals `actionMs`: the repeat cadence [confirmed; RR §5.5].

## 3. skilldata columns and the exported fields

### 3.1 Columns [confirmed against rows; names from RR §4.3 and the vSRO _RefSkill order]

| Col | Name | Exported as | Notes |
|---|---|---|---|
| 1 / 2 / 3 / 5 / 7 | ID, GroupID, Basic_Code, Basic_Group, Basic_Level | `id`, —, `code`, `group`, `skillLevel` | |
| 8 | Basic_Activity | `kind`, `instant` | 0 passive, 1 instant (the three imbues and Grass Walk), 2 action |
| 9 | Basic_ChainCode | `chainNext`, `chainRoot`, `chainIndex` | ID of the next segment |
| 10 | Basic_RecycleCost | — | 99999999 on learnable rows |
| 11 | PreparingTime | `preparingMs` | = READY clip length (§5) |
| 12 | CastingTime | `castMs` | Release |
| 13 | ActionDuration | `actionMs` | Recovery |
| 14 | ReuseDelay | `cooldownMs` | |
| 15 | CoolTime | (mobs) | Monster rows only |
| 16 | FlyingSpeed | — | 0/400 flag (RR §5.5) |
| 17 | Action_Interruptable | — | 0 on every Chinese row ≤ 20 (as are 20, 38/39, 48/49) |
| 18 | Action_Overlap | `overlap` | Low byte: buff stacking class (every imbue is 1, Weak Guard of Ice 2, Basic Fire protection 3, Flame body 4, Must - Piercing 5, Grass Walk 6, Crystal Wall 11, Fire Shield 16, White Hawk 18, Demon Soul Arrow 19; Castle Shield 0x4F, Bloody Fan Storm 0x51). The high byte is set, and unique, on attack skills (0x02 Strike Smash … 0x3C Shock Lion Shout) and on the two instant shield/spin buffs. Meaning of the high byte: [unknown] |
| 19 | Action_AutoAttackType | `autoAttack` | 1 on melee attacks (auto-attack resumes after the skill) [likely]; 2 on Soul Cut Blade, Flower Bloom Blade, White Hawk, Demon Soul Arrow [unknown] |
| 20 | Action_InTown | — | 0 |
| 21 | Action_Range | `range` (m) | 0 = the weapon's reach |
| 22 | Target_Required | `targets.required` | |
| 23-25 | TargetType_Animal/Land/Building | — | Animal 1 on targeted skills |
| 26-32 | TargetGroup_Self, Ally, Party, Enemy_M, Enemy_P, Neutral, DontCare | `targets.groups` | `self`, `ally`, `party`, `enemy_mob`, `enemy_player`, `neutral`, `any` |
| 33 | TargetEtc_SelectDeadBody | `targets.deadBody` | Soul Rebirth Art |
| 34-37 | mastery 1/2, levels | `mastery`, `masteryLevel` | |
| 38/39 | ReqCommon_Str/Int | `reqStr`, `reqInt` | |
| 40-45 | ReqLearn_Skill1-3 (GroupID), levels | `requires` | |
| 46 | ReqLearn_SP | `sp` | |
| 47 | ReqLearn_Race | — | 3 on basic attacks, 0 otherwise |
| 48/49 | Req_Restriction1/2 | — | 0 |
| 50/51 | ReqCast_Weapon1/2 | `weapons` | |
| 52-55 | Consume_HP, MP, HPRatio, MPRatio | `hp`, `mp`, `hpPct`, `mpPct` | |
| 57-60 | UI_SkillTab, Page, Column, Row | `ui` | Tab 0 weapon / 1 force; page = mastery in the tab; column = skill line (skillgroup row); row = tier (A 0, B 1, C 2); 255 = hidden |
| 61 / 62 / 64 | UI_IconFile, UI_SkillName, UI_SkillToolTip_Desc | `icon`, `name`, `description` | |
| 66 / 67 | AI_AttackChance, AI_SkillType | — (mobs) | See §9 |
| 68 | Param1 | `category` | 0 melee, 1 ranged/projectile, 3 buff, 4 passive |
| 69-117 | FourCC records | `params` (raw) + decoded fields | §4 |

### 3.2 skills.json record [confirmed]

The old fields are unchanged (`SkillDef` in `packages/shared/src/content.ts`). Every new field is additive and optional unless marked; `SkillExtras` in `skills.ts` is the reference.

| Field | Type | Present | Source |
|---|---|---|---|
| `kind` | `'attack' \| 'imbue' \| 'buff' \| 'debuff' \| 'heal' \| 'cure' \| 'resurrect' \| 'passive'` | always | §2 |
| `targets` | `{required, groups[], deadBody?}` | always | cols 22-33 |
| `description` | string | when the string exists | col 64 |
| `instant` | `true` | activity 1 | col 8 |
| `ui` | `{tab: 'weapon'\|'force', page, column, row}` | shown skills | cols 57-60 |
| `aniGroup` | `'SWORD'\|'SPEAR'\|'BOW'\|'DEFAULT'` | when skillaniset2 has a row | skilleffect |
| `hitCues` | `{phase, event, projectile?: {move, delayMs, speed}}[]` | damage skills | skilleffectset DMG Event rows (§5.3) |
| `durationMs` | number | `dura` | §4 |
| `area` | `{shape, distance, maxTargets, reductionPct, targetMask, raw}` | `efr` | §4.2 |
| `statuses` | `{status, level, chancePct, durationMs?, extra?}[]` | status params | §4.1 |
| `heal` | `{hp, hpPct, mp, mpPct}` | `heal` | |
| `toggle` | `{intervalMs, mp}` | `onff` | Crystal Wall: 41 MP every 5 s |
| `requiresItem`, `requiresTargetState`, `consumes` | | `reqi`, `reqc`, `cnsm` | §1.4 |
| `hpPct`, `mpPct`, `reqStr`, `reqInt`, `overlap`, `autoAttack` | number | non-zero | cols 54, 55, 38, 39, 18, 19 |
| `chainRoot`, `chainIndex` | string, 1-based | chain segments | col 9, walked from the head |

**Fixes in this wave** (exporter, schema-compatible):

- `category` of enemy-targeted skills without `att` (Cold wave - Arrest) was `buff`; it is now `ranged`, because the skill has its own Range.
- `category` of force attacks with their own Range (Shock Lion Shout, 15 m) was `melee`; it is now `ranged`.
- Detail-only callers keep the old answers (`skillCategory(detail)`).

**masteries.json additions:** `tab`, `page`, `lines`, `tabName`, `icon`, `iconFocus` (`/out/icon/skillmastery/china/mastery_sword.png`). The export returns the icon paths in `SkillsResult.icons`.

## 4. FourCC parameters

A record is a lower-case FourCC tag followed by its arguments (`parseSkillParams`, DATA.md). The table covers every tag used by the Chinese rows ≤ 20 (and the mob rows of §9). Argument meanings were read from how the values change across levels and tiers, and from the tooltip captions.

| Tag | Args | Meaning | Status |
|---|---|---|---|
| `att` | kind, %, flat min, flat max, %2 | Damage. Kind 5 melee, 6 ranged (physical), 9 physical AoE (mobs), 8 imbue and 10 force (magical). % of the attacker's attack power | confirmed (RR) |
| `mc` | 2, N | N hits in one result | confirmed (RR) |
| `getv` | `MAAT` | On every attack; meaning [unknown], ignore | — |
| `dura` | ms | Duration of the buff, or the imbue window (5000). Force buffs grow with the mastery level of the row: 335294 ms at mastery 8 → 395798 ms at mastery 20 (+5042 ms per mastery level) | confirmed values; PARAM_DURA |
| `efr` | 1, shape, distance (dm), max targets, reduction %, target mask | Area (§4.2) | likely |
| `fz` / `fb` | level, chance % | Freeze / frostbite | likely (PARAM_FZ/FB) |
| `es` | level, chance %, effect % | Electric shock: lowers parry (`DE_UIIT_MSG_STATE_SKILL_CURSING_ES`); the 3rd arg is 50 on every row | likely |
| `bu` | level, chance %, damage | Burn; the 3rd arg grows 1 → 96 with the tier | likely |
| `st` | duration ms, chance %, level | Stun (5000 ms, 20 %, level 2 on Soul Spear - Move) | likely |
| `ko` | level, chance % | Knockdown (Blood Blade Force: 19, 50) | likely (PARAM_KO) |
| `kb` | distance or level, chance % | Knockback (mastery ≥ 41) | unknown |
| `da` | % | Down-attack damage on knocked-down targets (125) | likely (PARAM_DA) |
| `reqc` | 1 | Target state required (knocked down) | likely |
| `reqi` | TypeID3, TypeID4 | Required equipped item | confirmed (shield, bow) |
| `cnsm` | TypeID3, TypeID4, count | Ammunition used | likely |
| `cr` | %, 0 | Critical rate bonus (Anti Devil Bow 20) | likely |
| `heal` | hp, hp %, mp, mp % | Heal | confirmed |
| `resu` | level limit?, ? | Resurrection (27, 1 → 30, 2) | unknown args |
| `curt` / `curl` / `rcur` | mask, level / ... / count | Cure abnormal states ("Randomly cures 2 bad statuses" → `rcur` 2) | likely |
| `defp` | PD, MD | Defence buff. Castle Shield 48 → 87, Bloody Fan Storm MD 37 → 87, Weak Guard of Ice 2 → 5, Cold Armor 2 → 5 (the small ones are probably %) | unit unknown |
| `dru` | phys %, mag % | Damage increase (Flame body 3, Must - Piercing 0/3, Flame Devil Force 1) | likely |
| `hste` | % | Movement speed (Grass Walk 20 → 26) | likely (PARAM_HSTE) |
| `hr` / `er` | value | Hit / parry rate (White Hawk 9 → 13, Heaven's Force 9 → 13) | likely |
| `br` | %, level | Block rate (Shield Protection 15) | likely |
| `hpi` / `mpi` | value | Max HP / MP increase (102 → 197) | likely |
| `ru` | value | Range up (Demon Soul Arrow 20) | unit unknown |
| `onff` | interval ms, MP | Toggle upkeep (PARAM_ONFF_CONSUME_MP) | confirmed |
| `pw` | type, amount, 0, level | Damage-absorbing wall (Crystal Wall: 7, 824 → 983; Fire wall: 11) | likely |
| `bgra` | state mask, %, 0 | Lowers incoming abnormal-state power (Fire Shield 63, 18 → 30) | likely |
| `dgmp` | % | Damage taken from MP instead of HP (Snow Shield 20) | likely |
| `spda` | shield PD −%, phys attack +% | Glacial Flame Bicheon Force (17, 27) | likely |
| `tant` | value | Cold wave - Arrest (118 → 175) and the Force cancel line. Probably taunt/aggro | unknown |
| `ssou` | refObjId, 0, min, max (×2) | Monster summon (Tiger Girl: 3-6 of ids 1953 and 1952) | likely |
| `zb` | level, chance % | Zombie (Tiger Girl's force attack) | likely |

### 4.1 Statuses

`statuses` normalises `fz fb es bu ps zb dn st ko kb` into `{status, level, chancePct, durationMs?, extra?}`.

- The server rolls `chancePct` per hit and per target.
- A status resists when the target's level is too high. RR §4.5 gives the damage-over-time rule: effective level = (100 − resist %)/100 × skill level − target reduction, dropped if ≤ 0 [low confidence].
- The first slice uses `level ≥ target level` as the gate. Durations of fz/fb/es/bu are not in the params; use config (freeze 2 s, frostbite 5 s, shock 5 s, burn 5 s in 1 s ticks) [unknown].

### 4.2 Areas (`efr`) [likely]

| shape (arg 1) | Name | Rows | Meaning |
|---|---|---|---|
| 1 | `caster` | Ghost Spear - Petal (2 m, 5 targets), Force cure area (20 m, 8), bow/sword specials (radius = Range) | Circle around the caster |
| 2 | `target` | Dancing Demon Spear (1 m, 3), Shock Lion Shout (2 m, 3), Pacheon area arrow (4 m, 4), Cold/Fire force AoE (6-7 m, 5) | Circle around the primary target |
| 3 | `pierce` | Wolf Bite Spear (2 targets) | Melee line through the target |
| 4 | `projectile_pierce` | Autumn Wind - Flame (3), spear throw, Cold ice-floor | The projectile passes through targets on its line |
| 6 | `chain` | Thunder Tiger Force (3.5 m, 2), Lightning storm (10 m), chain heal (30 m) | Jumps from the target to the nearest others |

- `distance` is arg 2 × 0.1 m. For the pierce shapes the meaning is unconfirmed; use the skill range, or the weapon reach plus 2 m, as the line length.
- `maxTargets` includes the primary target; 0 = unlimited (Detect).
- `reductionPct` (0-80) shrinks on the higher tiers of the pierce lines (35 → 25 → 20). Read it as the damage reduction on secondary targets [unknown].
- `targetMask` repeats the target-group bits: 1 self, 2 ally, 4 party, 8 enemy mob, 16 enemy player. It is 24 on attacks and 5 or 7 on party heals.

## 5. Timing: prepare, cast, action

### 5.1 The model [confirmed against the clips]

Research report §5.5 left open whether PreparingTime is used. The converted clips settle it: every phase clip lasts exactly as long as its column.

| Skill | prep / cast / action (ms) | Clip (aniGroup) | Clip length | Damage event |
|---|---|---|---|---|
| Strike Smash | 0 / 411 / 1022 | SKILL_1 (sword) | 1433 = 411 + 1022 | type-1 @ 410 |
| Soul Cut Blade | 0 / 341 / 792 | SKILL_5 (sword) | 1133 = 341 + 792 | 2nd event @ 341 (DMG cue event 2) |
| Blood Blade Force | 0 / 759 / 1107 | SKILL_6 (sword) | 1866 = 759 + 1107 | 2nd event @ 753 |
| Soul Spear - Move | 0 / 1128 / 1372 | SKILL_5 (spear) | 2500 = 1128 + 1372 | @ 1127 |
| Wolf Bite Spear | 0 / 568 / 1032 | SKILL_1 (spear) | 1500 (1600) | @ 566 |
| Glacial Flame Bicheon Force | 0 / 1300 / 700 | SKILL_5 (default) | 2000 = 1300 + 700 | — |
| Anti Devil Bow - Missile | **670** / 300 / 530 | READY01 666, WAIT01 (loop), SKILL_40 533 | READY = prep, SHOT = action | SHOT @ 32 |
| Heal - Medical Hand | **1000** / 1000 / 1000 | READY01 1000, WAIT01 (loop), SKILL_1 1000 | READY = prep, SHOT = action | — |

The rule that follows:

1. **t0** = the server accepts the action. The cost is paid and the cooldown starts (col 14).
2. With `preparingMs > 0` (the charged skills: bow shots and most force casts):
   - READY plays for `preparingMs`;
   - WAIT loops for `castMs`;
   - **release at t0 + preparingMs + castMs**;
   - SHOT plays for `actionMs`.
3. Without it, SHOT plays from t0 and **release is at t0 + castMs**, which equals the damage event's keytime to within 12 ms (tested).
4. **The action ends** at t0 + preparingMs + castMs + actionMs. The caster cannot start another action before that. Moving cancels it before the release (§6.1).
5. The **cooldown** runs from t0 for `cooldownMs`, per skill group (every level of a skill shares it).
6. **Instant skills** (activity 1) have no action. They apply at t0, do not interrupt the current action, and only arm the cooldown.

`castMs` of 1 (Self Breathe Heal, Force Cure) means "no WAIT". In SRO, "cast time" in tooltips is this prepare + cast.

### 5.2 Multi-hit, chains, basic attacks

- **`mc` hits** (2 Arrow Combo, the sword basic attack): the server rolls every hit at release and sends them in one `combat` message.
  - The client shows hit *i* at the *i*-th damage cue (2 Arrow Combo: SHOT events 1 and 2 at 440 and 790 ms), or else at the *i*-th type-1 event of the clip.
  - This is the existing auto-attack rule (PROTOCOL §3).
- **Chains** (Illusion Chain):
  - Each segment is its own row and its own action: segment 1 has 0/428, segment 2 0/612, segment 3 0/993, for 2033 ms, which is the SKILL_2 clip length.
  - The client plays the clip **once**; segment *i*'s damage shows at hit event *i* (211, 428, 1038 ms). The exporter gives each segment its own cue (`hitCues` = [event i]).
  - The server runs segment i + 1 automatically when segment i's action ends, as long as the target is alive and in reach. Only the head costs MP and arms the cooldown (the other segments have 0/0).
  - If the target dies, the chain ends and auto-attack continues on the next target the player picks.
- **Basic attacks** use the weapon's `_BASE_01` row: action = cooldown = cadence, damage at the clip's hit events, alternating ATTACK1..4.

### 5.3 Damage cues and projectiles [confirmed]

`hitCues` comes from skilleffectset rows with **DMG Event** (col 4) = TRUE:

- `event` is StartEvent (col 3): N = the N-th type-1 event of that phase's clip, 0 = the phase start.
- A cue whose ActType is `AT_MOV_*` is a projectile. `MovTypeSpeed` = `MOV_<STRAIGHT|UPR|PIERCE>,<delay ms>,<speed>,<speed>`. Examples: arrows 500, Soul Cut Blade 300, Cold wave 200.
- The **speed unit** is taken to be dm per second (arrows 50 m/s, Cold wave 20 m/s) [likely].
  - At 15 m, Cold wave flies 0.75 s. That matches the 0.43-0.98 s deferral that RR §5.6 measured on the wire for charged and targeted skills.
- The server applies projectile damage at release + delay + distance / speed. The client plays the flight with the same numbers.

## 6. Animations

- **Groups.** A character BSR has one aniGroup per weapon family: `default`, `sword` (sword and blade), `spear` (spear and glaive), `bow`, plus cart/avatar groups. The sidecar lists every clip with `group`, `typeName`, `durationMs`, `cyclic` and `events`.
- **skillaniset2** (skilleffect, keyed by Basic_Group) gives:
  - AniGroup (col 6) → `aniGroup`;
  - READY/WAIT/SHOT (cols 7-9) → `animation`, with `ANI_` dropped: `SKILL_1`, `READY04`, `ATTACK1,ATTACK2,...`.
- **Resolve a clip** in the skill's `aniGroup` (lower-cased) first, then in `default`.
  - Force skills use `DEFAULT`, so they keep the weapon in hand and play `READY04`/`WAIT04`/`SKILL_4` from the default group.
  - The same `SKILL_5` is Soul Cut Blade in the sword group and Glacial Flame Bicheon Force in the default group.
- **Events.** Type 1 = hit, type 2 = footstep. Events are stored in authoring order: sort by time before indexing (RR §5.3). Some clips have hit events that are not damage (Soul Cut Blade's event 1 at 86 ms is the swing effect); `hitCues` says which one is.
- **No clip.** The instant skills (activity 1) have no clip; they only play effects (ACT_S/ACT_L) and do not stop the current action.
  - Castle Shield, Bloody Fan Storm and Demon Soul Arrow are activity 2 but have neither a clip nor a cast/action time (0/0). Treat them as zero-length actions: they apply at t0 and end at once.
- **Partial clips.** DAMAGE and DEFENCE are overlay clips (`partial: true`, CONVENTIONS "Partial clips"); the reaction to a hit layers over the current clip.
- **Crowd-control clips** exist in the default group: `DOWN`, `DOWN_DAMAGE`, `DOWN_UP`, `DOWN_DIE`, `STUN`. Mobs have their own sets; check the mob sidecar and fall back to DAMAGE1.

## 7. Effects

### 7.1 skilleffect.txt [confirmed columns]

**skillaniset2** (one row per Basic_Group):

| Col | Field |
|---|---|
| 0 | Service |
| 2 | SkillID (Basic_Group) |
| 3 | Priority |
| 5 | Hide Weapon |
| 6 | AniGroup |
| 7-9 | READY / WAIT / SHOT |
| 13 | DefenseEfp |
| 14 | DamageEfp (the hit spark on the victim: `hiteffect\hit_3_critical.efp`) |
| 15-18 | Weapon trail: length, ARGB colour, op, texture (`mirage_texture_smash.ddj`) |
| 20 / 21 | Arrow tail / arrow force `.efp` |
| 22 | Light effect (`LIGHT_1`…`LIGHT_7`) |
| 24 | Waist twist (none, Roll, Yaw, Pitch) |
| 25 | "Is an attack skill" |
| 26 | Bleeds |

**skilleffectset** (many rows per group; a row starting with `-` continues the group above):

| Col | Field |
|---|---|
| 1 | SkillEffectID |
| 2 | Phase: READY, WAIT, SHOT, ACT_S (buff starts), ACT_L (loops while the buff lasts), DEACT (buff ends) |
| 3 | StartEvent |
| 4 | DMG Event |
| 5 | DamageType list `NOR\|CRI\|HWAN` |
| 6 | Scale (`CHAR_BASE`/none) |
| 7 | ID (1 on READY loops) |
| 8 | Attach |
| 9 | Trade |
| 10 | Kill (1 on the heal SHOT row: it ends the READY loops) [likely] |
| 11 | CreateCnt |
| 12 | Fade |
| 13 | ActType: `AT_ONE_FOLLOW`, `AT_LOOP`, `AT_DMG_POS`, `AT_TARGET`, `AT_MOV_1TAR` |
| 14 | MovTypeSpeed |
| 15 | Param |
| 16 | Act Option |
| 17/18 | Object folder + name: `.efp`, or a `.bsr` (arrow, `whitehawk.bsr`) |
| 19-22 | StartBone, StartOffset, TargetBone, TargetOffset |
| 23 | ObjName2 (impact `.efp`) |
| 24 | Rotate |
| 25 | Script (`SCT_RUT,<deg>`, `SCT_ARROW`, `SCT_MAT,…`, `SCT_CHAR_SCALE,…`) |
| 26/27 | SndBegin / SndEnd (`.wav`) |

**Col 24 is a rotation, not a delay** [likely]. RR §5.4 left this open. On the slash rows it is 720 + the angle of the paired `SCT_RUT,<angle>` DMG row:

- Strike Smash 1035 ↔ `SCT_RUT,315`;
- Illusion Chain 765 ↔ 45 and 990 ↔ 270;
- Blood Blade Force 870 ↔ 150.

The nocked arrow's 90 (openroad) fits too. Lafa2K and Archive Explorer's "delay" reading does not fit these rows.

### 7.2 Runtime

- `work/out/fx/skills.json` (`sro-fx-skills` v1) already lists, per group:
  - the clips;
  - `defense`/`damage`/`arrowTail`/`arrowForce` effect keys;
  - every stage row (phase, startEvent, actType, move, effect, bones, offsets, effect2, rotate, script);
  - `effects[key].url`.
- Since wave 5 (W5-V) each stage record also carries `dmg` (col 4), `kill` (col 10) and `sound` `{begin, end}` (prim/snd keys). Damage rows play with their shown hit (`SkillFx.hit`), not with their phase; an older skills.json without `dmg` still plays every row with its phase.
- Play a stage with `@sro/fx`:

  ```ts
  new FxInstance(lib, await lib.load(key), { pose: nodePose(bone, root), loop: actType === 'AT_LOOP' })
  ```

  - Start it at phase start + keytime[startEvent].
  - `AT_ONE_FOLLOW` follows the start bone (or the character root when there is no bone).
  - `AT_DMG_POS` plays at the victim's damage position (skilleffect characterInfo `DamageBone`/`DamagePos`).
  - `AT_TARGET` plays on the target.
  - `AT_MOV_1TAR` flies from the start bone to the target at the speed above, then plays `effect2`.
  - `AT_LOOP` rows stay until the phase ends, or until the buff ends for ACT_L.
- **Buff visuals:** ACT_S once when the buff lands, ACT_L looped on the carrier for its duration (for everyone who sees it), DEACT when it ends.
- Imbues show ACT_S/ACT_L on `Bip01 R Finger2` while the 5 s window is open.

## 8. Icons and UI art

- **Skill icons:** `/out/icon/skill/china/<line>_<tier>.png`, one per group (all levels share it). The exporter writes them (`SkillDef.icon`; null when Media.pk2 lacks the file).
  - Buffs show the same icon in the buff bar.
- **Mastery icons:** `/out/icon/skillmastery/china/mastery_<sword|spear|bow|cold|lightning|fire|water>[_focus].png`. The paths are in `SkillsResult.icons`.
  - `content.ts` does not yet add them to `report.icons`, so `export-data.ts` would not write them; they were written once for this wave (§10.6).
- **Line icons:** `icon\skillgroup\china\pack_*.ddj` (skillgroup.txt), not exported yet.
- **Skill window art:** Media `interface/skill/`:
  - tabs `skl_ch_icon1/2_tab_{on,off,disable}`, `skl_<mastery>_tab_*`;
  - buttons `skl_button_up`/`skl_button_add` (+ focus/press);
  - the slot overlays `skill_charge.ddj`, `skill_delay.ddj` (cooldown sweep) and `skill_using.ddj`.

  Layouts: resinfo `ifskill.txt`, `ifskill_mastery.txt`, `ifskill_group.txt`, `ifskill_slot.txt`, `ifskillboard.txt`.
- **Quick-slot art:** Media `interface/quick_slot/`; layouts in resinfo `ifextquickslot.txt`.
- All UI captions stay live English text in `apps/game/src/i18n` (for example "Weapon", "Force", "Mastery level", "Required skillpoint"). Skill and mastery names and descriptions come from the data.

## 9. Mob skills

- **Data.** `MobDef.skills` lists the default skills (characterdata cols 83-92). `MobDef.attacks` gives each one's damage and timing (`mobs.ts` `mobAttack`).
  - Mob rows use CoolTime (col 15) for the repeat and have `castMs` 0 or a real cast: Tiger Girl ATTACK01 is 1109/1391, and ATTACK03 is a 3003 ms force cast at 15 m.
- **Choice.** Col 66 `AI_AttackChance` is the weight or probability of using a skill: Tiger Girl 100 / 30 / 10 for her three attacks [likely].
  - On the SUMMON rows the value is 80 / 60 / 40 / 0, which reads like HP-% thresholds for summoning adds [unknown].
  - Col 67 is 80 on every mob row [unknown].
- **Shapes seen on mob rows:**
  - `att` kind 9 with `efr` [1, 1, 40, 5, 0, 24]: Tiger Girl ATTACK02 hits up to 5 targets within 4 m of herself;
  - `mc` [2, 2]: two hits;
  - `zb`: zombie;
  - `ssou`: summon 3-6 each of two monster ids.
- **Engine.** Mobs go through the same skill engine as players (§10.1): they pick a skill by chance when its cooldown is ready and the target is in its range, otherwise they use their first attack. They pay no MP.
  - Summons need an entity spawner hook and are out of scope for the first slice.
- **Animations.** Mob skills map to mob clips through skillaniset2 as for players (the Monster Skill sections), and the fx index covers only the Chinese masteries today. Until the mob index exists, play `ATTACK1`/`ATTACK2` and the type-1 events.

## 10. Implementation plan (next wave)

### 10.1 Server skill engine (`apps/server/src/skills.ts`, driven by `Gameplay.tick`)

**State per character** (persisted in SQLite, new tables):

- `masteries(char_id, code, level)`;
- `skills(char_id, grp, level)`: the highest learned level per group;
- `hotbar(char_id, slot 0..39, kind, code)`.

**Runtime state per entity** (player or mob):

- `action`: the running skill instance, or null. It holds id, skill code, target, t0, releaseAt, endAt, chain position and projectile timers;
- `cooldowns: Map<group, readyAt>`;
- `effects: Map<instanceId, Effect>`, where Effect = `{skill, kind: 'buff'|'debuff'|'status'|'imbue'|'toggle', overlapClass, mods, until, tickAt?}`;
- `imbue`: an Effect reference or null.

**Validation** (`useSkill {skill, target?}`), in order; each failure is an `actionResult` reason:

1. The skill is known (`not_found`) and learned: the character's level for the group is at least `skillLevel` (`not_learned`). Clients send the code of any learned level; the server uses the highest learned level.
2. Not dead (`dead`); not stunned or frozen (`cant_act`).
3. Weapon: `weapons` is empty or contains the equipped weapon type (`wrong_weapon`). `requiresItem` is equipped (`requirements`). Ammunition is in the bag (`no_ammo`).
4. Cooldown ready (`cooldown`); MP ≥ `mp` + `mpPct` × maxMp (`not_enough_mp`).
5. Target: when `targets.required`, the target exists, is visible and matches `targets.groups`:
   - enemies: mobs only, since PvP is out of scope;
   - self / party / ally: players;
   - `deadBody` for resurrection.

   Otherwise `invalid_target` / `target_dead`. When the skill has no target, the target is the caster. Enemy skills also need the non-safe-zone rule (`safe_zone`).
6. Busy: another action is running. Queue one skill, as SRO does: it starts when the current action ends (at most one queued; a newer request replaces it).

**Range.** Reach = (`range` > 0 ? `range` : weapon reach) + both radii. Out of reach, the server walks the caster toward the target with the auto-attack chase (PROTOCOL §3), then starts the skill.

**Start.** Pay MP, arm the cooldown, compute t0 / releaseAt / endAt (§5.1), broadcast `cast`, and stop auto-attack for the duration. Instant skills apply now, send `cast` with `instant: true`, and leave the current action alone.

**Tick** (10 Hz; timers are absolute server ms, so late ticks catch up):

- **At release**, resolve targets:
  - no `area`: the primary target;
  - `caster` / `target`: every valid entity within `distance` of the centre, nearest first, up to `maxTargets`, always including the primary;
  - `pierce` / `projectile_pierce`: entities within 1 m of the caster → target segment, extended to the line length, nearest first;
  - `chain`: from the primary, repeatedly the nearest not-yet-hit valid entity within `distance` of the last one.

  Then roll `hits` (`mc` N, else 1) per target with the §4.5 pipeline (`formulas.ts`) and skill % = `physPct`/`magPct`; secondary targets take `reductionPct` less (config). Roll `statuses` per target and hit. Send one `combat` per target (all sharing `instance`), then apply HP, deaths and rewards as auto-attack does.
- **Projectile cues** delay the application by delay + distance / (speed / 10) seconds. Hold the rolled results and apply and send them at arrival (`combat.at` tells the client when; RR §5.6 `0xB071`).
- **At endAt:** a chain goes on to the next segment (`chainNext`) while the target is alive and in reach; otherwise the action ends, the queued skill starts, and auto-attack resumes when `autoAttack` = 1 and the target still lives.
- **Interrupts:** `moveTo`, `stopAction`, death, stun, knockdown and freeze cancel an action before release: no refund, and the cooldown stays (SRO behaviour [likely]). After release the action cannot be cancelled. Send `castEnd {reason}`.

**Imbues.** Instant. While active (5 s), every hit the caster lands, basic or skill, adds a second magical component rolled from the imbue's `att`, and rolls its statuses; a `chain` area bounces that component. A new imbue replaces the old one (overlap class 1).

**Buffs / debuffs model.** Effect = `{instance, skill, source, carrier, mods: StatMod[], until}`.

- A new effect removes any effect on the carrier with the same overlap class (`overlap & 0xFFFF`, when non-zero) or the same group.
- `mods` come from a tag table (`defp` → PD/MD, `dru` → damage %, `hste` → speed %, `hr`, `er`, `br`, `hpi`, `mpi`, `ru`, `spda`, `dgmp`, `bgra`, `pw`), applied in `playerCombatStats` as a last step. The derived stats change, so `stats` is re-sent.
- Toggles (`onff`) drain MP every `intervalMs` and end at 0 MP; using the skill again ends it.
- Passives are permanent mods, rebuilt on login and on learn.
- Statuses are effects with a tick (burn damage every 1 s) or a state (`stun`/`freeze` block actions and movement; `knockdown` too, until the DOWN_UP clip ends, about 2 s [unknown]).
- Death clears everything except passives. Logout drops buffs, debuffs and imbues too (simplest; cooldowns are saved with their ready time).

**Learning** (`skillLearn`, `masteryUp`):

- Validate the SP, the mastery cap (≤ level; total ≤ 330) and the §1.3 rules.
- Answer `actionResult`, then `skillsUpdate` and `statsDelta {sp}`.
- A GM command `skill <code|all> [level]` fills a test character; its role checks and audit are as in PROTOCOL §10.

**Mobs.** `ai.ts` picks from `MobDef.attacks` with the §9 rule and calls the same `startSkill`, without MP or learning. Basic mob attacks move onto this path once it is stable, so one path remains.

### 10.2 Protocol additions (v1, additive)

Client → server (strict keys; `?` optional):

| t | fields | Notes |
|---|---|---|
| `useSkill` (exists) | `skill: CodeName128`, `target?: int` | Now implemented. Using a toggle that is on turns it off |
| `skillLearn` | `skill: CodeName128` | The row to learn next (`..._02` after `_01`) |
| `masteryUp` | `mastery: MasteryCode` | +1 level |
| `buffCancel` | `skill: CodeName128` | Right-click on your own buff icon |
| `hotbarSet` | `slot: 0..39`, `entry: {kind: 'skill'\|'item', code: CodeName128} \| null` | Saved server-side per character |

Rate limits: `useSkill` 5/s (burst 10, exists); `skillLearn`/`masteryUp` 5/s (burst 10); `hotbarSet` 10/s (burst 20); `buffCancel` 5/s.

Server → client:

```ts
// after `inventory` in the enter-world sequence
| { t: 'skills'; masteries: Record<MasteryCode, number>; skills: string[] /* highest learned code per group */;
    hotbar: (HotbarEntry | null)[] /* 40 */; cooldowns?: { group: string; readyInMs: number }[] }
| { t: 'skillsUpdate'; masteries?: Partial<Record<MasteryCode, number>>; learned?: string[]; hotbar?: { slot: number; entry: HotbarEntry | null }[] }
// begin: everyone who sees the caster (0xB070 begin)
| { t: 'cast'; id: number; skill: string; instance: number; target?: number; instant?: boolean;
    prepareMs: number; castMs: number; actionMs: number }
// action closed early (interrupted / cancelled / target lost); normal ends need no message
| { t: 'castEnd'; id: number; instance: number; reason: 'interrupted' | 'cancelled' | 'target_lost' }
// effects on an entity: buffs, debuffs, statuses, imbues, toggles (viewers of the carrier)
| { t: 'effectAdd'; id: number; effect: EffectState }
| { t: 'effectRemove'; id: number; instance: number; reason?: 'expired' | 'replaced' | 'cancelled' | 'cured' | 'death' }

interface HotbarEntry { kind: 'skill' | 'item'; code: string }
interface EffectState {
  instance: number
  skill?: string        // buff/debuff/imbue source skill (icon, ACT_L effects)
  status?: SkillStatus['status'] // abnormal state or crowd control
  level?: number
  remainingMs: number   // 0 = until cancelled (toggles, passives are not sent)
  source?: number       // caster entity id
}
```

Extensions of existing messages:

- `combat`: `instance?: number` (links to `cast`), `at?: number` (server ms the hits land, for projectiles), `aoe?: true` (a secondary target). `skill` is now set.
- `CombatHit`: `status?: SkillStatus['status']` (applied by this hit), `down?: true` (the hit knocked down), `pos?: Vec3` (knockback landing point).
- `EntityState`: `effects?: EffectState[]`, so late joiners see buffs and statuses. `state` keeps `LifeState`; knocked-down and stunned are effects, not life states.
- `PlayerStats` is unchanged; buffs change the derived totals, and the server re-sends `stats`.
- `ActionFailReason` += `'not_learned' | 'not_enough_mp' | 'wrong_weapon' | 'no_ammo' | 'cant_act' | 'no_sp' | 'mastery_cap'`. Remove `not_implemented` from `useSkill` once live.
- `MAX_COMBAT_HITS` stays 16. AoE sends one `combat` per target.
- `MasteryCode` = `'BICHEON' | 'HEUKSAL' | 'PACHEON' | 'COLD' | 'LIGHTNING' | 'FIRE' | 'FORCE'`.

The client matches `actionResult` FIFO as today. `cast` for your own character follows `actionResult ok`.

### 10.3 Client

**Content.** A `SkillCatalog` over skills.json and masteries.json:

- by code and by group;
- `maxLearned(group)`;
- `nextRow(group)`;
- the tooltip lines. i18n captions plus data: name, level, description, MP, cast time (prep + cast), cooldown, range, the damage "% + flat" and the statuses.

**Skill window (K)**, `apps/game/src/hud/skills.ts`:

- two tabs (Weapon, Force);
- one page per mastery, with the icon, name and level, a `+` button (`masteryUp`), the SP cost of the next level and the free SP;
- the grid of skill lines: `ui.column` × `ui.row` (tiers). Each cell shows the icon, the learned level / max level ≤ mastery, and an up button (`skillLearn`) when `nextRow` is learnable; greyed out when locked, with the reason in the tooltip;
- drag an icon to the hotbar.

Reuse `hud/window.ts` and `slots.ts`, and the interface/skill art (§8).

**Hotbar**, `hud/hotbar.ts`:

- 10 visible slots bound to keys 1-0, plus pages F1-F4 (4 × 10 = 40 slots, SRO's quick-slot layout);
- drag and drop from the skill window and the inventory (potions);
- right-click clears a slot;
- every change sends `hotbarSet`; the server's `skills`/`skillsUpdate` is the source of truth;
- cooldown sweep from `cooldownMs`, starting at our own `cast`; MP-short and wrong-weapon slots are greyed out;
- pressing a slot sends `useSkill {skill, target: selected}` (or `itemUse`).

**Casting presentation**, `world/skills-view.ts`, an ActionPlayer (RR §5.8):

- On `cast`:
  - look up the def;
  - resolve the clips through `aniGroup` → default;
  - play READY for `prepareMs`, WAIT (loop) for `castMs`, SHOT, or SHOT only;
  - schedule the fx stages of `fx/skills.json` for that phase at keytime[startEvent] through `@sro/fx`;
  - face the target.
- On `combat` with `instance`: queue the hits and show hit *i* at `hitCues[i]` (projectile: at `at`, with the flight effect), falling back to the clip's type-1 events.
  - Show the DamageEfp spark and the damage number on the victim, and the victim's DAMAGE overlay, or the DOWN/STUN clips for `down`/`status`.
- Chains: segment *i*'s `cast` does not restart the clip when the same clip is already playing for the previous segment of the same `chainRoot`.
- `castEnd` stops the clip (back to STAND/ATTREADY) and the loops.

**Buff icons:** a bar under the HP/MP gauges with the icons and remaining time, and a tooltip. Right-click on your own buff sends `buffCancel`. ACT_L loops run on every carrier we see, and `effectRemove` stops them. The target window shows the target's effects too.

The mock server (`apps/game/src/net/mock.ts`) gets the same engine subset, so the UI can be tested offline.

### 10.4 First playable slice

Six skills, chosen to exercise every engine path at levels a new character reaches:

| # | Skill | Mastery | Exercises |
|---|---|---|---|
| 1 | Strike Smash (`SKILL_CH_SWORD_SMASH_A_01..08`) | Bicheon 5 | Basic attack skill: cast/action timing, MP, cooldown, levels |
| 2 | Illusion Chain (`SWORD_CHAIN_A_1S..3S`) | Bicheon 7 | Chain segments, one clip, cue i per segment |
| 3 | Soul Cut Blade (`SWORD_GEOMGI_A`) | Bicheon 14 | Own range (12 m), projectile at 30 m/s, damage cue event 2 |
| 4 | Ice River Force (`COLD_GIGONGTA_A`) | Cold 5 | Instant imbue, 5 s window, freeze/frostbite statuses on the carrier's hits |
| 5 | Weak Guard of Ice (`COLD_GANGGI_A`) | Cold 8 | READY/WAIT/SHOT, timed buff (~5.6 min) with stat mods, ACT_S/ACT_L effects, buff icon |
| 6 | Heal - Medical Hand (`WATER_HEAL_A`) | Force 12 | Friendly targeting (self/party), 15 m range, prepare + cast, heal |

Plus the weapon basic attacks moving onto `skills.json` (`SKILL_CH_*_BASE_01`).

**Stretch goals:** Blood Blade Force + Flower Bloom Blade (knockdown → down attack), Dancing Demon Spear (AoE around the target), Thunder Tiger Force (chain area).

**Server tests** (vitest, synthetic world):

- validation reasons;
- MP and cooldown per group;
- timing (release at prep + cast, end at + action, ±1 tick);
- chain progression and abort on target death;
- projectile delay;
- imbue adds a magical component and replaces an older imbue;
- buff overlap replacement and expiry;
- learn/mastery SP and caps;
- `apps/server/test/role-policy.test.ts` keeps passing (the new GM command goes through the same role checks).

**Client check:** in the browser, learn the six skills with the GM command, bind them to 1-6, and cast each on a Mangnyang. Watch the clip, the effect at the cue, the number at the hit event, the cooldown sweep and the buff icon with its timer.

### 10.5 Order of work (lanes)

1. **shared:** protocol types and validators (§10.2), `SkillDef` gaining the §3.2 fields as optional properties, `MasteryDef` gaining tab/page/icon.
2. **server:** DB tables, `skills.ts` engine, learn/mastery/hotbar handlers, GM `skill` command, imbue/buff mods in `formulas.ts`.
3. **client:** SkillCatalog, skill window, hotbar, ActionPlayer + fx cues, buff bar, mock server subset.
4. **convert (optional):** `dmg`/`kill`/`sound` in `fx/skills.json`; mob `AI_AttackChance` in `MobDef.attacks[].chance`; skillgroup.txt line names/icons; mastery icons into `report.icons`.

### 10.6 Open questions

- PreparingTime vs the first-slice feel. The model above follows the clips; confirm on a capture of one charged force skill (RR §5.5 open point).
- `efr` args 4/5 on pierce shapes, the `reductionPct` meaning, `kb` args, `tant`, `resu` args, and the `defp` units. Tooltips in the real client show the resolved numbers; one screenshot per skill settles them.
- Status durations for fz/fb/es/bu (not in the params).
- Cols 18 (high byte) and 19 (value 2).
- Mob col 66/67 semantics and summon thresholds.
- `export-data.ts` does not yet write the mastery icons (`content.ts` builds `report.icons` from skills only). They were written once by this lane and survive re-exports (existing PNGs are kept). Wire `SkillsResult.icons` into `report.icons` to make it reproducible.
- `docs/DATA.md` §Skills describes the old field set; it should link here for the additions.
