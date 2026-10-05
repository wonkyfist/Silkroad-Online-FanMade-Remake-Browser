# Game data export

`pnpm tsx packages/convert/src/tools/export-data.ts` turns two inputs into JSON files under `work/out/data/` (served at `/out/data/`):

- **Our vSRO 1.188 client.** This is the textdata in Media.pk2, the navmesh in Data.pk2, and icons. It is authoritative for stats, levels, EXP, items, skills, NPC positions, shops and models.
- **The third-party port's server data.** These are JSON files only, under `…/Random SRO Browser Remade/server/data`. They supply the server-only vSRO tables that the client lacks: nests (Tab_RefNest/Hive/Tactics), drop chains, and a few flags. We never copy or run the port's code.

The record shapes are defined in `packages/shared/src/content.ts`. The server rules are in `docs/PROTOCOL.md`. This document covers sources, column meanings, provenance, coordinate frames and the formulas I had to assume.

The files contain retail data. They stay under `work/`, which is gitignored.

```sh
pnpm tsx packages/convert/src/tools/export-data.ts                 # everything, icons included
pnpm tsx packages/convert/src/tools/export-data.ts --no-icons      # skip the PNG icons
  --port-data <dir>   the port's server/data folder (default: sro.config.json "portDataDir", else
                      <parent of clientDir>/Random SRO Browser Remade/server/data)
  --world <name>      world manifest whose frame positions use (default jangan)
  --check             exit 1 when a referenced model is not converted
```

The run prints the frame derivation, the terrain evidence, the record counts and any missing models. It also writes the full report to `work/out/data/export-report.json`.

## Files

Counts are from the 2026-09-28 export.

| File | Records | Sources | Provenance |
|---|---|---|---|
| `characters.json`, `weapons.json`, `strings.json`, `levels.json` | 26 / 5 / … / 30 | client (unchanged; `data/game-data.ts`) | client |
| `mobs.json` | 32 | client characterdata, skilldata (default skills), string tables. Aggression and variants come from the port | client; port fields listed in `fieldSources` |
| `nests.json` | 825 | port `spawns.json` `jangan_province`, all `enabled: true` | port |
| `all-nests.json` | 7,350 | port `spawns.json`, every province. Only `jangan_province` is enabled | port |
| `items.json` | 525 (wave 8: + the Red Horse, 3 Recovery Kits, 4 `_A` elixirs, Lucky Powders 1st-3rd) | client itemdata and string tables | client |
| `skills.json` | 237 (wave 8: + 57 monster MSKILL rows, `mob: true`) | client skilldata (plaintext `skilldata_*.txt`), skilleffect `skillaniset2`, string tables | client |
| `masteries.json` | 7 | client skillmasterydata and skilldata | client |
| `npcs.json` | 46 | client npcpos, characterdata, refregion and teleportdata. Facing comes from the port | client; yaw listed in `fieldSources` |
| `shops.json` | 5 (wave 8: + `STORE_CH_STABLE`, Machun) | client refshopgroup → refmappingshopgroup → refmappingshopwithtab → refshoptab → refshopgoods → refscrapofpackageitem | client |
| `cos.json` | 1 (the Red Horse, `COS_C_HORSE1`) | client characterdata of the summon item's COS (wave 8, `data/cos.ts`) | client |
| `drops.json` | 32 tables, 953 groups | port `drops.json` and `itemmap-tam.json`. Gold amounts come from client `levelgold.txt` | port |
| `towns.json` | 1 (Jangan) | client teleportdata and refregion. The safe box comes from the port `safe-areas.json` | mixed, per field |
| `export-report.json` | – | frame fit, terrain evidence, counts, models, skipped drops | – |

- **Wrapper.** Every content file except `levels.json` is a `ContentFile` wrapper: `{schema: 1, kind, generatedAt, sources, entries}`.
- **Self-check.** Before anything is written, the exporter runs `checkContentFile` on every file, and it aborts on any problem.
- **Extra keys.** Records carry extra keys beyond `content.ts`, for example `attacks`, `championModel`, `rolls`, `perPlus`, `reinforcePct`, `params`, `enabled`, `inConvertedRegion` and `uniqueGroup`. Readers ignore unknown keys.

## Provenance rules

- **Client data wins.** Monster stats, levels, EXP, items, skills, NPC positions and shop stock come from the client.
  - Where the port has the same value, it agrees. For example, Mangnyang's HP 54, PD 7, MD 10, ER/HR 27, EXP 24 and attack 17–19 appear in the port's `mobs.json` too.
- **Port records are tagged.** Every record derived from the port carries `provenance: 'vsro-server-db via third-party port'`. This covers nests and drop tables.
- **Port fields are named.** Single port-sourced fields inside client records are named in `fieldSources`: mob `aggressive` and `variants`, and NPC `yaw`.
- **Other fields are named too.** Any field filled by a formula or a default also says so in `fieldSources`.

## Coordinate frames

All positions are in the **world (manifest) frame**, as defined by `work/out/world/jangan/manifest.json` `space`:

- glTF metres: x is east, y is up, z is **south**.
- The origin is the south-west corner of region (168, 97).
- Region-local file units (lx, h, lz) in region (rx, rz) map to `[192 (rx − 168) + 0.1 lx, 0.1 h, −(192 (rz − 97) + 0.1 lz)]`.
- The mapping goes through `gltf/space.ts` `toGltfPosition` (`data/frame.ts`).
- Other provinces in `all-nests.json` use the **same** frame, with the same origin. They are simply far away (Constantinople is about 17 km west).

### The port frame (derived, not assumed)

**Anchors.** The anchors are NPCs placed by both the port and the client:

- the port's `npcshops.json` placements, matched by `sroCode`;
- the port's `teleporters.json`, matched by teleport code → teleportdata AssocRefObjId;
- in both cases, only where the client's `npcpos.txt` places that NPC exactly once.

**Fit.** The fit is `port = s · game + b` per axis. Game metres are the SRO world coordinates: X = 192 (rx − 135) + lx/10 and Y = 192 (rz − 92) + lz/10.

**Result.** 57 anchors in 5 provinces:

- The least-squares fit gives s = 1.500000 on both axes, with offsets of 0.0002 and 0.0000.
- The rounded frame `s = 1.5, b = 0` reproduces the **55 inliers** with an RMS of 0.3 mm and a maximum of 0.5 mm.
- Two anchors are outliers, and the fit drops and reports them: the Donwhang ferry sellers `GATE_NPC_WC_FERRY` (20.5 m off) and `…_FERRY2` (11.7 m off). The port moved them.
- So `port = 1.5 × game metres`.
  - Equivalently, port units = file units × 0.15. This matches the port's `modelmap.json` scale of 0.15.
  - Its `*U` distance fields (sight range, trace boundary, speeds) use the same unit.
  - Port heights `y` are metres × 1.5 as well.

**Terrain check.** Every nest centre of every province was placed on the client's own navmesh terrain (Data.pk2 `navmesh/nv_<region>.nvm`):

| Zone | Nests | On an open cell | \|terrain − y/1.5\| median / p90 / max |
|---|---|---|---|
| jangan_province | 825 | 824 | 0.003 / 0.011 / 0.55 m |
| donwhang_province | 772 | 772 | 0.002 / 0.010 / 0.18 m |
| hotan_province | 1491 | 1491 | 0.003 / 0.010 / 0.17 m |
| europe_province | 1318 | 1318 | 0.002 / 0.007 / 0.13 m |
| samarkand_province | 2944 | 2937 | 0.002 / 0.013 / 0.17 m |

For comparison, I measured three wrong frames with a scratch script (not part of the exporter):

| Wrong frame | Nests on an open cell | Height within 1 m |
|---|---|---|
| Port y read as metres | – | 7 % |
| x/z not divided by 1.5 | 91 % of the 39 % that land on a region at all | 2 % |
| z mirrored | 90 % | 3 % |

**Other port fields.** Distances are port units divided by 1.5, which gives metres:

- radius 75 → 50 m and spawnRadius 60 → 40 m. In raw vSRO units these are 500 and 400, which are round numbers.
- sightRangeU 17.3 → 11.53 m, which is 15 + nSightRange 100 units.
- traceBoundaryU 75 → 50 m.

**Jangan coverage.** Of the 825 Jangan nests, **8 lie inside the 9 converted regions** (167–169 × 96–98). All 8 are Mangnyang nests south of the town wall, with 120 mobs in total. The other **817 are outside** and wait for the field conversion. `inConvertedRegion` on each record says which is which.

**NPC facing.** `yaw = π − rotY`. This assumes the port's rotY turns a +Z-facing model in its (x east, z north) frame. It is **unverified**, because no client table stores NPC facing. 13 of 46 NPCs have a port placement within 1 m. The rest get yaw 0.

## Monsters (`mobs.json`)

The export includes every code in the Jangan nests: 32 monsters, levels 1–30. These cover the `_CLON` variants and the unique Tiger Girl, as well as the Western China mobs (MOB_WC_*) that spawn in the Jangan province.

**characterdata columns.** I checked each column against MOB_CH_MANGNYANG and against the port's values:

| Col | Field | Col | Field |
|---|---|---|---|
| 1 | ID | 59 / 60 | MaxHP / MaxMP |
| 2 | CodeName128 | 71 / 72 | PD / MD → `physDefence` / `magDefence` |
| 4 | OrgObjCodeName128 (base code of `_CLON` rows) | 73 / 74 | PAR / MAR → `physAbsorb` / `magAbsorb` |
| 5 | NameStrID128 → English name | 75 | ER → `parryRate` |
| 9–12 | TypeID (monsters 1/2/1/x) | 76 | BR → `blockRate` |
| 15 | Rarity (0 normal, 1 champion, 3 unique, 4 giant, …) | 77 | HR → `hitRate` |
| 46 / 47 | Speed1 / Speed2 in units/s → walk / run m/s ×0.1 (Mangnyang 8/22 → 0.8/2.2) | 78 | CHR → `critRate` |
| 48 | Scale % | 79 | ExpToGive → `exp` |
| 50 | BCRadius units → `radius` ×0.1 | 80–82 | resist bytes, KO class, KO recovery ms (raw) |
| 52 | AssocFileObj128 → model | 83–92 | DefaultSkill_1…10 (skilldata IDs) |
| 57 | Lvl | 93 | 1 on `_CLON` rows. **Not** an aggressive flag |

**Attack.**

- `physAttack` (or `magAttack` for 'att' kinds 8/10) is the flat min/max of the **first default skill's** `att` record. Mangnyang: MSKILL_CH_MANGNYANG_ATTACK01 → 17–19.
- `attackRange` is that skill's Range (col 21) ×0.1.
- `attackIntervalMs` is max(ReuseDelay col 14, CoolTime col 15).
- `attacks[]` lists every default skill with damage and timing, including uniques' summon skills.
- The fallback formula (2×level to 3×level, marked in `fieldSources`) is used by none of the 32 mobs.

**Models.**

- Normally the model is col 52.
- `_CLON` rows have no model. They take their base code's (col 4) `<name>_clon.bsr` sibling when Data.pk2 has one (for example `bigeyeghost_clon.bsr`), else the base model (`hyungno.bsr` for MOB_WC_HYUNGNO_CLON).
- `championModel` is the `<name>_champ.bsr` sibling when it exists.

**Aggression and variants.**

- `aggressive` is true when all of the mob's nests (in any province) have port `aggressTypeRaw 0`. The port's own mobs.json labels those "aggressive" and the 1s "passive", consistently for all 32 mobs.
  - 0 = aggressive is confirmed by the data's own shape: Tiger Girl and every champion tactics row are 0; the starter mobs (Mangyang, Big-Eyed Ghost, Weasel, Water Ghost) and the variants the client names "Young Tiger", "Bandit Subordinate", "Meek Gun Powder" are 1. Every mob has one tactics row for all its nests.
  - Jangan: 398 of the 825 nests and 16 of the 32 mobs are aggressive (sight 9.5–11.5 m, Tiger Girl 14 m). The repo's `content/nests.override.json` turns nest 5416 (the tomb entrance pack) passive, so 397 play aggressive. `apps/server/test/aggro.test.ts` pins the set.
- `championAggressive` (passive mobs only): true when the port's mobs.json links champion tactics (`combat.championTacticsId`, vSRO dwChampionTacticsID; every champion tactics row has btAggressType 0), false when it links none. In Jangan only the four starter mobs link one. Absent (exports before the field) counts as true. The champion tactics' own sight is not in the port data, so champions use the nest's.
- `variants` comes from the port's mobs.json `variants.champion/giant`. Retail has no champion/giant multipliers in its data, so those stay server config.
- The port's authored defaults are champion 10 % with ×2 HP/EXP, and giant 3 % with ×8 HP/EXP.

**Not in the data.**

- `spExp` is absent. The server rule applies (default: equal to `exp`).
- Uniques: nests of a unique mob carry `uniqueGroup` (Tiger Girl: 11 camps with respawn 10800–21600 s). The server should keep at most one alive per group and roll one camp per spawn, as the port's `uniques.json` scheduler does.

## Nests (`nests.json`, `all-nests.json`)

Each port nest becomes a `NestDef` with these fields:

| Field | Source |
|---|---|
| `id` | nestId |
| `mob` | vsroCode (checked against mobs.json) |
| `x`, `z`, `y`, `region` | frame above |
| `radius`, `spawnRadius` | ÷1.5 |
| `count` | port value |
| `respawnSec` | respawnDelaySec |
| `championPct` | port value |
| `tactics` | `{id: tacticsId, aggressive: aggressTypeRaw === 0, sightRange: sightRangeU/1.5, leashRange: traceBoundaryU/1.5, raw}` |
| `source` | the raw port position and zone |
| `level` | the port's level, for information |

- Jangan alone has 7,156 mobs alive at full counts. If that is too dense for a small group, apply a per-nest count scale in server config; the data keeps retail counts.
- `world` is `jangan` for the Jangan province and `<province>` for the others. Every province uses the jangan manifest frame.

## Items (`items.json`)

**Scope.**

- **Chinese equipment** (TypeID 3/1, Country 0) of degree 1–3:
  - codes `ITEM_CH_{SWORD,BLADE,SPEAR,TBLADE,BOW,SHIELD,EARRING,NECKLACE,RING}_NN_{A,B,C}`;
  - garment/protector/armour `ITEM_CH_{M,W}_{CLOTHES,LIGHT,HEAVY}_NN_<part>_{A,B,C}` for both genders;
  - the creation defaults `*_DEF`.
- **Consumables:**
  - HP/MP/vigor potions and grains (`ITEM_ETC_{HP,MP,ALL}_{,S}POTION_NN`);
  - universal pills (`CURE_ALL`);
  - return scrolls 01–03;
  - arrows;
  - the three gold piles.
- **Left out:**
  - seal items (`_RARE`: the port's bronze/silver/gold drops);
  - European items;
  - cash items;
  - everything above degree 3. That data is still in the client, and raising `maxItemDegree` exports it.

**Typing.**

| TypeID | Meaning |
|---|---|
| 3/1/1–3/x | armour. TID3 1 garment (clothes), 2 protector (light), 3 armour (heavy). TID4 1 head, 2 shoulders, 3 chest, 4 legs, 5 hands, 6 feet |
| 3/1/4 | shield |
| 3/1/5/x | accessory: 1 earring, 2 necklace, 3 ring |
| 3/1/6/x | weapon: 2 sword, 3 blade, 4 spear, 5 glaive (TBLADE), 6 bow |
| 3/3/1–5 | potion / pill / scroll / ammo / gold |

**itemdata columns** (checked on the Copper Sword, Copper Armor, Copper Shield, Ume Copper Ring and HP Recovery Herb, and against the port's roll ranges):

| Col | Field |
|---|---|
| 14 | Country |
| 17 | CanSell |
| 20 | CanDrop |
| 26 / 31 | Price / SellPrice |
| 32–39 | ReqLevelType/ReqLevel pairs (type 1 = character level) |
| 52 / 53 / 54 | model / ground model / icon |
| 57 | MaxStack |
| 58 | ReqGender (0 f, 1 m, 2 any) |
| 59 / 60 | ReqStr / ReqInt |
| 61 | ItemClass → degree = ceil(/3) |
| 63/64 | durability |
| 65/66/67 | PD lower/upper/+per plus |
| 68/69/70 | parry |
| 71/72/73 | physical absorb |
| 74/75 | block |
| 76/77/78 | MD |
| 79/80/81 | magical absorb |
| 82–85 | PD/MD reinforce (0.1 %) |
| 86/87 | Quivered / ammo TID4 |
| 93 / 94 | TwoHanded / Range (units) |
| 95/96 | phys attack **min** roll |
| 97/98 | phys attack **max** roll |
| 99 | +per plus |
| 100–104 | the same for magic |
| 105–112 | attack reinforce (0.1 %) |
| 113/114/115 | HR |
| 116/117 | critical |
| 118, 120, 122, 124 | Param1–4 (with Desc strings in 119, 121, …) |

**Formulas and choices.**

- **Attack.** `stats.physAttack` / `magAttack` = [mean of the min roll, mean of the max roll]. For the Copper Sword that is [15.5, 17] from min 15–16 and max 16–18. The raw bounds are in `rolls`.
- **Other stats.** Every other `ItemStats` field is the [lower, upper] roll of one value.
- **Plus increments.** `perPlus` holds the per-plus increments.
- **Reinforce.** `reinforcePct` holds the STR/INT reinforcement percentages.
- **Potions.** `use.hp` = Param1, `hpPct` = Param2, `mp` = Param3, `mpPct` = Param4. `cooldownGroup` is `hp`, `mp` or `vigor`, by TID4.
  - The potion cooldown time is **not** in client data. The port uses 1000 ms per group; that is left to server config.
- **Return scrolls.** `use.returnToTown` is set, and `castMs` = Param1 (30000 / 15000 / 5000). The destination (Desc3 `RESURRECT`) is the player's recall point.
- **Pills.** `cureLevel` = Param1.
- **Gold.** `goldPileFrom` = Param1 (1 / 1000 / 10000). This is the smallest amount shown with that pile model.
- **Icons.** `icon` is `/out/icon/<AssocFileIcon128>.png`, decoded from Media.pk2 `icon/`. It is null when Media.pk2 has no such icon (`etc_gold.ddj` is missing).

## Skills and masteries (`skills.json`, `masteries.json`)

**Scope.**

- Rows `SKILL_CH_*` whose ReqCommon_Mastery1 (col 34) is one of the seven Chinese masteries: Bicheon 257, Heuksal 258, Pacheon 259, Cold 273, Lightning 274, Fire 275, Force 276.
- Only rows with ReqCommon_MasteryLevel1 (col 36) ≤ 20.
- Plus SKILL_PUNCH_01, for 180 rows in all.
- The plaintext `skilldata_*.txt` files are in this client. The `*enc` twins are not needed, so there is no decryption step.

**skilldata columns** (checked on SKILL_CH_SWORD_SMASH_A_01 and SKILL_CH_SWORD_BASE_01):

| Col | Field |
|---|---|
| 1 | ID |
| 2 | GroupID |
| 3 | Basic_Code |
| 5 | Basic_Group |
| 7 | Basic_Level |
| 8 | Basic_Activity (0 passive, 1 imbue, 2 action) |
| 9 | Basic_ChainCode, the ID of the next chain segment → `chainNext` |
| 11 | PreparingTime |
| 12 | CastingTime → `castMs` |
| 13 | ActionDuration → `actionMs` |
| 14 | ReuseDelay → `cooldownMs` |
| 15 | CoolTime (monster rows) |
| 16 | FlyingSpeed |
| 21 | Range → `range` ×0.1 |
| 34/35 | mastery |
| 36/37 | mastery level |
| 40–42 / 43–45 | prerequisite skill groups / levels → `requires` |
| 46 | SP |
| 47 | race |
| 50/51 | weapons (255 none) |
| 52/53 | HP/MP cost |
| 61 | icon |
| 62 | name key |
| 64 | description key |
| 68 | Param1 (0 melee, 1 ranged, 3 buff, 4 passive) |
| 69–117 | FourCC parameter records → `params` |

**Parameter parsing** (`parseSkillParams`):

- A value is a tag when it spells 3–4 lower-case characters (`att` = 0x617474), or when it is one of the known two-letter tags (`mc`, `ko`, `st`, `fz`, …).
- Two-letter FourCCs collide with ordinary values: 30000 ms spells `u0`. That is why only the known two-letter tags count.
- Upper-case FourCC arguments such as getv's `MAAT` stay arguments.
- The corpus test checks every exported `att` (5 args) and `mc` (2 args).

**Damage.** `damage` comes from `att` [kind, percent, flat min, flat max, percent2]:

- kinds 5 and 6 are physical (`physPct`); kinds 8 (imbue) and 10 (force) are magical (`magPct`);
- `flat` is [min, max];
- `hits` is the second argument of `mc` [2, N] (research report §4.3), with 1 as the default.

**Category.**

| Condition | Category |
|---|---|
| Activity 0, or Param1 4 | passive |
| Param1 3 | buff |
| Param1 1 | ranged |
| An `att` record | melee |
| Otherwise (heals, cures, shields) | buff |

**Animation.** `animation` comes from skilleffect.txt section `skillaniset2`, keyed by Basic_Group:

- READY/WAIT/SHOT are cols 7/8/9.
- `ANI_` is dropped, so the names match the converter's clip names (`SKILL_1`).
- Basic attacks list alternatives: `ATTACK1,ATTACK2,ATTACK3,ATTACK4`.

**Masteries.**

- `code` is BICHEON / HEUKSAL / PACHEON / COLD / LIGHTNING / FIRE / FORCE.
- `name` comes from skillmasterydata MasteryNameCode.
- `weapons` comes from skillmasterydata Weapon Type 1–3.
- `skills` are ordered by mastery level.
- Weapon basic attacks go into `ItemDef.basicAttack`: sword/blade → SKILL_CH_SWORD_BASE_01 (1200 ms, 2 hits of 60 %), spear/glaive → SPEAR_BASE (1166 ms), bow → BOW_BASE (840 ms).

## NPCs, shops and the town

**NPCs.**

- These are the `npcpos.txt` rows (characterdata ID, region, local x/y/z in units) whose region is in the CHINA continent of `refregion.txt`, which is the Jangan province. Town_Jangan is regions 167–169 × 97–98.
- There are 46 NPCs, and 42 of them are inside the converted regions.
- **Roles.**
  - `shop` comes from the refshop chain.
  - `teleport` means teleportdata AssocRefObjId is this NPC. `teleports` lists those codes.
  - `storage` is set for WAREHOUSE codes.
- Both storage keepers (M and W) stand 4 cm apart in npcpos. That is how the client data has them.

**Shops.**

- The client refshop chain: group → NPC, group → store, store → tab groups, tab → goods (slot order), package → item.
- Tabs keep only items in `items.json`. The armour tabs carry `reqGender`.
- This yields four Jangan shops: STORE_CH_SMITH, ARMOR, ACCESSORY and POTION.
- Stores whose goods are all outside the item scope are left out, and their NPCs lose the shop role: trade goods, stable, guild, honor, alchemy and detect items. The report lists every dropped item.

**`towns.json`.**

- `spawn` is the arrival point of teleport GATE_CH: teleportdata GenRegion 25000, (969, 0, 1369) → world (96.9, 0, −136.9). This is inside the town on an open navmesh cell. The server can use it as the new-character spawn, the respawn point and the return-scroll destination.
- `safeArea` is the port's Jangan town box, centre (82.7, −198.8) with half extents 256 × 178.7 m. It is the no-combat zone.
- `regions` are the Town_Jangan regions.

## Drops (`drops.json`)

One table per exported mob, from the port's drops.json. The port generated it from the vSRO chain (MonLevel → _RefDropClassSel_* → _RefDropItemGroup → weighted item) and multiplied its own rates in (`$oranlar`: goldRate 30, itemDropRate 1, rareDropRate 1). The export divides those back out.

**Gold.**

- `chance` is the port's gold.chance, which is 0.7 on every mob.
- `amount` is the client's `levelgold.txt` row for the mob level. levelgold is the client copy of _RefDropGold.
- Check: the port's amount ÷ 30 equals levelgold for **all 32 mobs**.

**Items.**

- Each port entry is an independent roll `p = chance / rate` and becomes one `DropGroup`.
- Port item ids map to client codes through `itemmap-tam.json`. Gendered armour maps to its male and female codes, with one pick at equal weight.
- `qty > 1` becomes `count`.
- **Skipped:** 11,453 entries whose item is not in items.json (European, seal, magic stones, degree > 3), and 416 that `itemmap-tam.json` does not map (mostly magic stones).
- The port's seal (bronze) entries are about 5× more likely than the ordinary ones. That ratio is suspicious. Because seals are out of scope, only the ordinary equipment rates remain.

## Models and icons

**Models.**

- `ModelRef` is `{bsr, glb, sidecar}`, and it is set only when the glb exists under `work/out`. Otherwise it is `null`, with a `fieldSources.model` note.
- `pnpm sro convert` converted every model the records reference. **None failed.**

| Group | Models |
|---|---|
| Monsters (including 16 `_champ` and 11 `_clon` looks) | 46 |
| Jangan NPCs | 44 |
| Chinese equipment (degree 1–3, both genders) and the 7 ground models (`drop_ch_equip`, `drop_ch_bag`, `drop_ch_acc`, `drop_scroll`, three money piles) | 133 (5 starter weapons were already converted) |

- Together with the 26 characters and 5 starter weapons, the exporter now reports 249/249 referenced models converted.
- Consumables have no object model. Their ground look is `dropModel`.

**Icons.** Icons are written once to `work/out/icon/…png`: 221 of the 222 referenced; `etc_gold.ddj` is not in Media.pk2. `--force-icons` rewrites them.

### Wave 8 additions (lane EXP)

- **Items.** `canTrade: false` when itemdata column 16 is 0 (exactly the 25 `*_DEF` starter items; absent = tradable). `perPlus` is typed. Elixirs and powders use the `'alchemy'` category with `reinforce {kind, targets?, degree?, rates}`: elixir targets from Param1's bytes, rates from Param2-4 read big-endian; a powder's degree from its Param1. The four `_A` elixirs name an icon Media.pk2 lacks and use their `_b` icon (noted in `fieldSources.icon`). The horse is a scroll with `use.summon`; Recovery Kits are potions with `use.target: 'mount'` and cooldown group `cos_hp`.
- **Monster skills.** 57 MSKILL rows join `skills.json` (`mob: true`, `aiChance` from column 66, grouped by their own code because Basic_Group is `xxx`). A row is `'ranged'` when Param1 is 1 or its reach is 3 m or more; Tiger Girl's four SUMMON rows are kind `'buff'` with a resolved `summon` list (the server picks them by `summon`, not by kind). The Water Ghost gas has no `damage` and is a `'debuff'`.
- **NPCs.** `'repair'` role on `NPC_CH_SMITH` and `NPC_CH_ARMOR`; Machun (`NPC_CH_HORSE`) sells `STORE_CH_STABLE`; Jinjin's accessory shop gains an Alchemy tab.
- **Drops.** The port's level-15+ elixir groups are mapped to the `_A` codes (chance 0.00022575 each, 15 mobs); the server adds its own `ELIXIR_DROP_PCT` roll (D51).
- **Models.** `/out/cos/c_horse1.glb` (with the `saddle` joint), the elixir and powder drop models, and the two static hwan hairs. `export-data.ts`'s "missing glbs" list does not include `models.cos` yet (the horse is listed in `export-report.json`).
- **Sounds.** `cos.horse.*`, `berserk.start` / `berserk.end`; `ui.eqbreak` / `ui.eqdanger` are swapped from retail's crossed table on purpose (`EQ_SOUNDS_BY_CONTENT` in `sound/build.ts`).

## Tests

| File | Covers |
|---|---|
| `packages/formats/test/textdata.test.ts` | the new column readers: monster stats, item stats, skill detail, npcpos, levelgold; FourCC decoding and the `u0` collision |
| `packages/convert/test/data-frame.test.ts` | the world frame and manifest rule; game ↔ file; the port-frame fit (exact, shifted, with a moved anchor, refusing bad input); port → world; yaw |
| `packages/convert/test/data-builders.test.ts` | items (scope, classification, stats, use), skills (category, damage, animations), clone/champion models, nest conversion, drops (rates, gold, gender split, skips) and the shop chain / NPC placement, all on synthetic rows |
| `packages/convert/test/data.corpus.test.ts` | the real export. It skips without the client or the port data. It checks the frame, the terrain evidence for every province, the content checks, the nests, the Mangnyang stats, items/shops/drops cross-references, the skills (including the parameter split), the NPC placement vs port, and the town spawn on open navmesh |

## Open points

- **NPC yaw convention.** The port's rotY → our yaw convention is unverified. The client has no facing data. Check it visually in the next game-client wave.
- **Uncertain values.** These need a capture or server config: potion cooldowns, champion/giant multipliers, `spExp`, and the unique "one alive per group" scheduling.
- **Unused columns.** The meanings of characterdata col 40 (tracks the level) and cols 80–82 are unconfirmed. They are kept raw and not used.
- **Mastery cap.** Skills stop at mastery level 20 (`maxMasteryLevel`). Re-export with a higher value when the level cap rises.
