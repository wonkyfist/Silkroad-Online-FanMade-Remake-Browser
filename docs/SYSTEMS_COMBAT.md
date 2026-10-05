# Combat and item systems: horses, monster skills, durability and repair, alchemy, Berserk

This is the design for five systems the user asked for:

1. horses from the Stable-keeper;
2. monster skills;
3. repair and durability at the Blacksmith;
4. alchemy (+N item enhancement);
5. the Berserk gauge.

It follows the house pattern (docs/WAVE_PLAN.md): protocol → seams → lanes with disjoint files → integration → adversarial hunt → fix. §8 is the build plan.

**Status tags**, as in the other docs:
- **[confirmed]** read from our client data or our code during this pass;
- **[likely]** strong indirect evidence (client strings, file names, the research report);
- **[unknown]** not found; the value given is a server rule we choose, and it is a config knob.

**Sources:**
- client textdata: `work/extracted/Media/server_dep/silkroad/textdata/*.txt` (UTF-16LE, except `effectsound.txt`, which is an 8-bit Korean code page; the numbers below were read from UTF-8 copies of them);
- the exports under `work/out` (`data/*.json`, `fx/`, `sound/`, `mob/`, `char/`);
- the research report `Silkroad_Research_Report.md` ("RR", §4.5 table);
- the third-party port's JSON, read as data only (`…/Random SRO Browser Remade/server/data/drops.json`).

No GPL, AGPL or unlicensed code was copied. The column numbers are 0-based textdata columns, as in docs/DATA.md.

**Reference PNGs** for the UI lanes are in `work/tmp/systemsA/ref/` (listed in §9).

---

## 0. Summary

| System | Retail data we have | What we build | Main risk |
|---|---|---|---|
| **Horses** | Red Horse `ITEM_COS_C_HORSE1`: requires level 10, 1,200 gold, summons `COS_C_HORSE1` (level 20, 983 HP, run 90 units/s = 9 m/s, 1.8× a player). Sold by `STORE_CH_STABLE` at Stable-keeper Machun. The client strings give the riding rules. [confirmed] | A `cos` entity you summon from the item, ride, park, dismiss and heal. Hits on a rider land on the horse. No attacks or skills while mounted. Persisted per character. | Rider pose and saddle offset (`cart` clips on the `saddle` bone) must be checked by eye. |
| **Monster skills** | Every in-world mob has 1–7 `MSKILL_*` rows with damage %, hit count, cast time, cooldown, range, `AI_AttackChance` (col 66), statuses (`ps`, `zb`, `bu`), areas (`efr`), animations (`ANI_ATTACK1..3`) and effects. [confirmed] Three `_clon` models lack the `ATTACK3` clip their special row names (§2.1). [confirmed] | A `MobSkills` module. Mobs pick skills by weight, cast with real timing (dodgeable releases), hit areas, apply statuses, and send `cast`/`combat` so the client plays the right clip and effects. | Retail skill percents raise mob damage 1.0–2.8× (§2.6). The default mode `relative` keeps today's balance. |
| **Durability and repair** | Durability rolls (cols 63/64), `Cost_Repair` (col 27), `CanRepair` (col 22) and the repair strings are exported or confirmed. The wear rate is not in the data. [confirmed / unknown] | Weapons wear on hits dealt, armour on hits taken. At 0 an item is broken: no stats, and a broken weapon cannot attack. Repair (single item and all) at the Blacksmith and the Protector Trader. | The wear rate is our knob (§3.2). |
| **Alchemy** | Elixirs `ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_{WEAPON,SHIELD,ARMOR,ACCESSARY}_A` with the item types they fit, and Lucky Powder `…PROB_UP_A_01..12` matched to the item degree. Per-plus bytes are packed in Param2–4. Jinjin sells the powders. The fail strings exist. [confirmed] | Server-timed fuse (3 s), success from the packed bytes, failure resets to +0 (never destroys), stats + `perPlus × N`. An Alchemy window. Elixirs drop at an authored rate. | The packed-byte reading is [likely], not confirmed (§4.3). |
| **Berserk** | 0–5 points, Tab activates, no gain while active, damage probably ×2, speed 200 % ("SPDU 200"). Gauge and effect art exist. [confirmed / likely] | Points on kills, the 5-orb gauge, `berserk` request, 60 s of ×2 damage and ×2 speed, aura, hair and hit effects. | Duration and point rate are [unknown] knobs. |

**Reused as is:**
- `Gameplay.dealHits` (every hit);
- `formulas.rollSkillHit`;
- `skills/targeting.ts` `selectTargets`;
- `skills/timing.ts` `projectileOf` / `arrivalAt`;
- the `EffectTable` status rules;
- the item transaction layer (`store.inventoryTx`);
- the NPC service model (`NpcDialogs.requireService`);
- the client `cast` presentation (`world/skills-view.ts`) and `skill-fx.ts`;
- the KeyMap;
- the sound cues that already exist (`ui.repair`, `ui.eqbreak`, `ui.eqdanger`, `ui.elixir_use/success/failure/destroy`, `item.dropElixir`, `ui.cos_summon`) [confirmed in `work/out/sound/index.json`].

---

## 1. Horses (Stable-keeper Machun, `NPC_CH_HORSE`)

### 1.1 Retail data

| Item | Code | Name | TypeID | Req. level | Price / sell | Stack | Param1 | Icon / drop model |
|---|---|---|---|---|---|---|---|---|
| horse | `ITEM_COS_C_HORSE1` (id 2137) | Red Horse | 3/3/3/2 | **10** (col 33, type 1 at col 32) | 1,200 / 360 | 50 | Desc `COS_C_HORSE1` (the COS it summons) | `cos\item_cos_c_scroll.ddj` / `item\etc\drop_scroll.bsr` |
| horse | `ITEM_COS_C_HORSE2` | Shadow Horse | 3/3/3/2 | 30 | 2,100 | 50 | `COS_C_HORSE2` | out of scope (above the cap) |
| horse | `ITEM_COS_C_HORSE3` | Dragon Horse | 3/3/3/2 | 45 | 3,000 | 50 | `COS_C_HORSE3` | out of scope |
| horse potion | `ITEM_ETC_COS_HP_POTION_01` | Recovery Kit (small) | 3/3/1/4 | 0 | 190 / 91 | 50 | Param1 360 HP | `item\etc\cos_hp_potion_01.ddj` |
| horse potion | `ITEM_ETC_COS_HP_POTION_02` | Recovery Kit (large) | 3/3/1/4 | 0 | 400 / 184 | 50 | 660 HP | `cos_hp_potion_02.ddj` |
| horse potion | `ITEM_ETC_COS_HP_POTION_03` | Recovery Kit (x-large) | 3/3/1/4 | 0 | 720 / 317 | 50 | 1,110 HP | `cos_hp_potion_02.ddj` |

All [confirmed] against itemdata. The shop prices match `refpricepolicyofitem` (`PACKAGE_ITEM_COS_C_HORSE1` 1,200; the three kits 190 / 400 / 720) [confirmed].

**The horse itself** (characterdata, TypeID 1/2/3/1) [confirmed]:

| Code | Level (57) | MaxHP (59) | Walk / run (46/47) | BCRadius (50) | PAR/MAR (73/74) | ER (75) | HR (77) | Model (52) | Icon (54) |
|---|---|---|---|---|---|---|---|---|---|
| `COS_C_HORSE1` | 20 | 983 | 45 / 90 units/s = 4.5 / **9.0 m/s** | 12 → 1.2 m | 20 / 20 | 65 | 65 | `res/cos/c_horse1.bsr` | `cos\cos_c_horse1.ddj` |

- A player's run speed is 50 units/s (`CHAR_CH_MAN_ADVENTURER` col 47), so the Red Horse runs **1.8×** as fast [confirmed].
- The port's `mounts.json` (speedU 13.5, reqLevel 20) is its own invention. Ignore it.

**The shop.** `refshopgroup` maps `GROUP_STORE_CH_STABLE` → `NPC_CH_HORSE`, and `refmappingshopgroup` maps it → `STORE_CH_STABLE` [confirmed]. Tabs [confirmed `refshoptab`/`refshopgoods`]:
- `STORE_CH_STABLE_TAB1` "SN_TAB_VEHICLE": HORSE1..3 and DHORSE1;
- `TAB2` "SN_TAB_CART": trade transports (out of scope);
- `TAB3` "SN_TAB_PET": empty in this client;
- `TAB4` "SN_TAB_CURE": `ETC_COS_HP_POTION_01..03` and pet items.

Within the level cap we sell TAB1 `ITEM_COS_C_HORSE1` and TAB4 `ITEM_ETC_COS_HP_POTION_01..03`.

**Retail rules from client strings** (textuisystem, English column) [confirmed that the strings exist; that the 1.188 server enforces each one is [likely]]:

| String id | Text | Our rule |
|---|---|---|
| `UIIT_MSG_STRGERR_CANT_SUMMON_MULTIPLE_COSOBJ` | Cannot summon more than one transport. | One horse per character. |
| `UIIT_MSG_CMSERR_CANT_GETOFF_FROM_RUNNING_HORSE` | Cannot step down while the transport is moving. | Dismount only while stopped. |
| `UIIT_MSG_SKILL_USE_FAIL_CANT_USESKILL_IN_RIDESTATE` | Cannot use the skill while on the vehicle… | No skills or attacks mounted. |
| `UIIT_MSG_COS_CAN_NOT_RIDE_BATTLE` | Cannot board a transport for 20 seconds after the end of combat. | 20 s combat lockout on summon and ride. |
| `UIIT_MSG_CMSERR_TOO_FAR` | Cannot board because you are too far from the transport… | Walk to the horse first (2 m). |
| `UIIT_MSG_COS_HIGHER_LEVEL_REQUIRED_TO_USE_THISITEM` | You must be level 5 or higher to use summon items. | Covered by the item's req. level 10. |
| `UIIT_MSG_FLEAMARKET_ERR_CANT_OPEN_MARKET_IN_RIDESTATE` | Cannot open the shop while boarding… | Stalls (other spec) refuse while mounted. |
| `UIIT_KEY_COS_DISMOUNT` / `UIIT_KEY_COS_RETURN` | `/dismount`, `/unsummon` | Chat commands. |
| `UIIT_STT_COS_HEAL` / `UIIT_MSG_COS_HEALING` | Cure the transport / Will you recover the stamina of your transport? | Not built. The Recovery Kits cover healing. |

### 1.2 Models, animations, sounds

- **The horse model.** `res/cos/c_horse1.bsr` [confirmed]: material `prim/mtrl/cos/c_horse_1.bmt`, meshes `c_horse_part1/2.bms`, skeleton `prim/skel/cos/c_horse.bsk`. Clips `c_horse_stand01`, `_walk`, `_run`, `_die`, `_die_loop`, `_damage01` (converted as STAND1, WALK, RUN, DIE1, DIE1_RM or DIE2, DAMAGE1).
  - It is **not converted yet** (`work/out/cos/` does not exist).
  - The exporter lane converts it with `pnpm sro convert res/cos/c_horse1.bsr` → `/out/cos/c_horse1.glb` + `.json` (a run, no code change). `ModelRef` is set only when the glb exists (docs/DATA.md "Models"). `packages/convert/src/gltf/output.ts` `PRESETS` belongs to EFFECTS lane FX-X (`PRESETS.fx`), so this spec does not edit it.
  - characterInfo row `COS_C_HORSE1` (skilleffect.txt): size 2.5, damage point `0,14,-3.6`, blood `hit_2_redblood`, no ride model [confirmed].
- **The rider.** Every Chinese player BSR carries a `cart` animation group [confirmed in `work/out/char/china/chinaman_adventurer.json`]:
  - `STAND1_cart_stand01` (`prim/ani/char/china/man/cart_stand01.ban`, 2,666 ms, cyclic);
  - `WALK_cart_walk` and `RUN_cart_walk` (`cart_walk.ban`, 1,333 ms, cyclic).

  The BSR maps both WALK and RUN to `cart_walk.ban`. A `cart_run.ban` exists in `prim/ani/char/china/man/` and `…/woman/`, but no player BSR references it [confirmed: extracted Data and the BSR strings]; the MR-C lane may load it as the RUN clip if `cart_walk` looks wrong at 9 m/s. The `cart` group is the rider pose on any COS [likely: "cart" is the COS riding state, and trade transports are ridden too].
- **Attach point.** The horse skeleton has a bone named **`saddle`** [confirmed in `c_horse.bsk`]. The rider root is parented to `saddle` [likely]. The vertical offset must be checked by eye (§8 check H3).
- **Mount and dismount.** There are no retail clips for them [confirmed absent]. Presentation rule: a 250 ms tween of the rider root between the ground point beside the horse and the saddle, plus the `ui.cos_summon` cue on summon.
- **Horse sounds** (`effectsound.txt`, rows `COS_C_HORSE`) [confirmed]:
  - `SND_STAND` `COS\COS_Horse_Stand.wav`;
  - `VOC_MOAN` `COS_Horse_Moan1/2.wav` (normal / critical hit);
  - `VOC_DEATH` `COS_Horse_Die.wav`, `SND_DEATH` `COS_Horse_Thud.wav`;
  - `SND_WALK1` `player\mvWalkHground.wav`, `SND_RUN1` `COS\COS_Horse_Run.wav`.

  They are **not exported yet**: `work/out/sound/cos/` holds only a wolf. The exporter lane adds `cos.horse.{stand,moan,moanCrit,die,thud,run}` cues (`packages/convert/src/sound/build.ts`).
- **Icons.** `icon/cos/cos_c_horse1.ddj` (32×32, the horse face for the HUD frame) [confirmed]; `interface/playerminiinfo/pmi_pet_face.ddj` (28×28) and `pmi_pet_hp.ddj` (112×8) are the retail COS frame pieces [confirmed; that retail uses them for horses is likely: `UIIT_STT_GAMESET_TTDESC_01` "Display the status of COS such as Pet, Vehicles"].

### 1.3 Rules (server)

**State.** A horse is a `Cos` entity: `kind: 'cos'`, `model: 'COS_C_HORSE1'`, `owner` (the player's entity id), `ownerChar`, `hp`/`maxHp`, `rider: number | null`. The player carries `mount: number | null`.
- `apps/server/src/world.ts` knows only `Player | Mob | GroundItem | Npc` today [confirmed: `Entity` union, `addEntity(e: Mob | GroundItem | Npc)`, `allEntities()`, `baseState()`]. A `Cos` needs a seam there (F6-FS, §6.4): the union, a `cos` map filled by `addEntity`/`removeEntity`, `allEntities()` and a `baseState` branch. Nothing in this spec's first draft owned `world.ts`.
- Interest management reads `positionAt(e)` [confirmed]. A ridden horse therefore shares its rider's `MoveState` (`cos.move = rider.move`, `cos.pos` copied on stop and warp), so view range and despawn stay right mid-move.

**Summon.** `itemUse {bag}` on an item whose `use.summon` is set. Checks, in order:

1. Alive (`dead`).
2. `p.progress.level ≥ def.reqLevel` (`requirements`).
3. No horse summoned (`cos_active`).
4. Not in combat: `now − p.lastCombatAt ≥ COS_COMBAT_LOCK_MS` (20,000) (`in_combat`).
5. Not busy (skill action or return-scroll cast, `busy`).
6. The player stops (a halt, as a skill start does).

Then:
- Take 1 item (one `inventoryTx`).
- Create the horse at the player's position with full HP (`CosDef.hp`) and mount the player at once.
- Summon works in towns [decision; retail allows riding in town, likely].
- The item is **consumed**. Horses in vSRO are consumable scrolls [likely].

**Mounted.**
- `p.mount = cos.id`, `cos.rider = p.id`.
- Move speed: `p.speedMul` = GM speed × `CosDef.runSpeed / PLAYER_RETAIL_RUN` (9.0 / 5.0 = **1.8**; `PLAYER_RETAIL_RUN` is a new constant, `CHAR_CH_*` col 47 = 50 units/s) through the SkillEngine mod-provider seam (§6.4). Today `SkillEngine.applySpeed(p, buff)` already folds the GM speed and `1 + speedPct/100` into `p.speedMul` [confirmed `skills/engine.ts` applySpeed]; the mount factor needs a new multiplicative `ModStat` in `skills/mods.ts` (F6-FS). Skill speed buffs (`hste`, Grass Walk) do **not** apply while mounted [decision]. The world speed is `MOVE_SPEED` 5.5 m/s, so a mounted player moves at 9.9 m/s, not retail's 9.0.
- `p.radius` becomes `max(player radius, CosDef.radius)` (1.2 m), so mobs stop at the horse's flank.
- The horse entity is not broadcast `move`s. Its position is the rider's: the server keeps `cos.pos = positionAt(rider)` on every move, stop and warp of the rider. Clients draw a ridden horse under its rider (§1.5).

**Refused while mounted**, reason `mounted`:
- `attack` and `useSkill` ("Cannot use the skill while on the vehicle");
- `storageOpen` is allowed; `shopBuy` / `shopSell` are allowed;
- `pickup` is **allowed** [decision; retail unknown];
- `itemUse` of potions, pills and return scrolls is allowed, except horse summon items (`cos_active`);
- `alchemyReinforce` and `berserk` are refused (`mounted`).

**Damage while mounted.**
- `Gameplay.dealHits` redirects any hit whose target is a mounted player to the horse (§6.4 seam `mounts.redirect`): `combat.target` = the horse id, and the horse's HP goes down.
- Statuses of those hits land on the **rider** (the horse has no effect table) [decision].
- Mob AI keeps targeting the player id. Nothing in `ai.ts` changes.
- **DoT ticks are not redirected.** Burn and poison ticks also go through `dealHits` (`SkillEngine.tickEffect`, with `{skill}` as extra) [confirmed `skills/engine.ts` tickEffect], so the redirect cannot tell them apart today. The F6-FS seam adds `dot?: true` to `dealHits`' `extra`, set only by `tickEffect`; the redirect and the armour wear (§3.2) skip hits with `extra.dot`.

**Horse death.** HP 0 →
- `entityUpdate {id: cos, hp: 0, state: 'dead'}`, then `despawn` after `CORPSE_MS`;
- the rider is dismounted in place (`entityUpdate {id: p, mount: null}`) with the system line "Your horse has died.";
- the saved row is deleted.

**Dismount.** `mountDismount`. Refused `not_mounted` without a mount, and `moving` while `p.move` is set. When accepted:
- the horse stays parked where it stands (`cos.rider = null`);
- the rider is placed 1.2 m to the horse's left (`stop {id, pos, yaw}`; a navmesh `place()` of that point, else the horse's own point);
- speed and radius return to normal.

**Ride again.** `mountRide {cos}`. Checks: own parked horse (`not_found` otherwise), alive, not in combat (`in_combat`), not busy. When farther than `COS_BOARD_RANGE` (2 m) the server walks the player there with `Gameplay.approach()` [confirmed public], then mounts. The walk is a new `PlayerAction {kind: 'board'; cos: number; chaseAt: number; chaseTo: [number, number] | null}`: the `PlayerAction` union lives in `world.ts` [confirmed], so it is an F6-FS seam line; `mounts.ts` runs it from its `tickPlayer` hook, as `npc.ts` runs `'talk'`.

**Dismiss.** `mountDismiss` (also `/unsummon`) removes the horse, ridden or parked, and deletes the saved row. The horse is gone.

**Parked horses** are ignored by mob AI and cannot be attacked by players (no PvP). They are dismissed when:
- the owner is farther than `COS_PARK_RANGE_M` (60 m);
- the owner warps (return scroll, respawn, GM tp);
- the owner leaves the world while it is parked.

A **ridden** horse warps with its rider (return scroll, GM tp, summon).

**Healing.** `itemUse` of a Recovery Kit (`use.target: 'mount'`, `use.hp`) heals the own horse, ridden or parked within 30 m. `not_usable` "You have no horse." when none. Cooldown group `cos_hp` (1 s, the potion rule). Horses do **not** regenerate [decision; retail unknown].

**Death of the rider.** Only DoT statuses can reach a mounted rider. If one kills the rider: dismount, then the normal death. The parked horse is dismissed at respawn (a warp).

**Logout and persistence.** DB table `char_mount (character_id PK, code, hp, mounted)`, written on summon, damage (throttled: at most every 5 s and on logout), dismount and ride.
- On enter-world with a saved row: the horse is created next to the player, mounted when `mounted = 1` (it does not count as a new summon, and the lockout does not apply).
- A saved parked horse is re-created parked.

**GM.** `/horse [cos code]` summons without an item (level and lockout ignored). `/horse off` dismisses.

### 1.4 Protocol

See §7.1–7.3:
- `EntityKind` `'cos'`;
- `EntityState.mount`, `EntityState.rider`;
- `entityUpdate.mount` / `rider`;
- requests `mountRide`, `mountDismount`, `mountDismiss`;
- reasons `mounted`, `not_mounted`, `moving`, `in_combat`, `cos_active`.

Summon and healing reuse `itemUse`.

**Message order on summon:**
1. `actionResult {re:'itemUse', ok}`;
2. `inventoryUpdate`;
3. `spawn {entity: cos}` to viewers;
4. `entityUpdate {id: p, mount: cos}` and `entityUpdate {id: cos, rider: p}`;
5. `stats` (speed and radius are not in stats, so it is only needed if stats changed).

### 1.5 Client

- **Catalog.** `catalog.cos(code)` → `{glb: '/out/cos/c_horse1.glb', sidecar, radius, name, icon}` from `cos.json`.
- **View.** A `cos` EntityView loads the horse GLB.
  - While `rider` is set, its root follows the rider's interpolated position and yaw each frame. It is **not** moved by its own messages.
  - The horse plays STAND1 / WALK / RUN from the rider's motion (same speed thresholds as the player's own locomotion).
  - The rider's actor switches to the `cart` animation group (`STAND1_cart_stand01`, `RUN_cart_walk`) and is parented to the horse's `saddle` bone. On dismount it returns to its default group.
- **Clicking.**
  - Clicking your own parked horse sends `mountRide`. The cursor is the NPC talk cursor (a hand).
  - Clicking another player's horse does nothing.
  - Clicking a monster while mounted:
    1. the client sends `stopAction`, then `mountDismount` (only when not moving; otherwise it stops first and dismounts on the `stop`), then `attack`;
    2. the server answers each in order.
- **HUD.** A horse frame under the player frame, only while you own a horse: the 28×28 face (`cos_c_horse1` icon), an HP bar (`pmi_pet_hp` style), and buttons **Dismount/Ride** and **Dismiss** (dismiss asks first). The Recovery Kit hotbar slot targets the horse through `itemUse`.
- **Keys.** None by default. `/dismount` and `/unsummon` are typed in chat, and the client maps them to the requests. **There is no client slash-command hook today**: every `/…` line is sent as chat, and the server runs it as a GM command (`connection.ts` slash branch → `runGm`), which a player's account is refused [confirmed]. The shared client-seam pass therefore adds `WorldFeature.onChatCommand?(text: string): boolean` (true = consumed, nothing sent) in `world/features.ts`, called from the chat send path in `screens/world.ts`. EFFECTS FX-C2 needs the same hook for `/sitdown` and the emote commands.
- **Sound.** The cues from §1.2 on the horse view: run loop while moving mounted, moan on damage, die/thud on death, `ui.cos_summon` on summon.

---

## 2. Monster skills

### 2.1 What the data holds [confirmed]

- **`MobDef.skills`**: characterdata `DefaultSkill_1..10`, cols 83–92.
- **`MobDef.attacks`**: already exported for each skill (castMs, actionMs, cooldownMs = max(col 14, col 15), range, damage). It is not in the `MobDef` TypeScript type yet.

**The server today** swings every mob with **one hit at 100 %** of the first skill's flat range, every `attackIntervalMs` (`Gameplay.attack` → `rollSkillHit(att, def, {pct: 100})`). It ignores:
- the other skills;
- percents and hit counts (`mc`);
- cast times;
- areas and statuses.

Full table of the 24 in-scope mobs (skilldata, `parseSkillParams`).
- Columns: w = `AI_AttackChance` (col 66); cast/action/cooldown in ms (cols 12, 13, max(14, 15)); range in m (col 21 × 0.1).
- `AI_SkillType` (col 67) is 80 on every row [unknown meaning]. `Param1` (col 68) is 1 on ranged rows.

| Mob (lv) | Skill | w | att: kind, %, flat | hits (mc) | cast / action / cd | range | extra |
|---|---|---|---|---|---|---|---|
| Mangyang (1) | `MSKILL_CH_MANGNYANG_ATTACK01` | 100 | 5, 200, 17–19 | 1 | 0 / 2400 / 3000 | 1.0 | clip ATTACK1 |
| | `…_ATTACK02` | 100 | 5, 100, 17–19 | 2 | 0 / 2500 / 3000 | 1.0 | ATTACK2 |
| Small-Eyed Ghost (2) | `MSKILL_CH_BIGEYEGHOST_CLON_ATTACK01` | 100 | 5, 133, 21–23 | 1 | 0 / 1300 / 2000 | 0.4 | |
| Big-Eyed Ghost (3) | `MSKILL_CH_BIGEYEGHOST_ATTACK02` | 100 | 5, 100, 25–29 | 1 | 0 / 1200 / 1500 | 0.4 | |
| Old Weasel (4) | `MSKILL_CH_GYO_CLON_ATTACK01` | 100 | 5, 133, 30–34 | 1 | 0 / 1300 / 2000 | 0.7 | |
| Weasel (5) | `MSKILL_CH_GYO_ATTACK02` | 100 | 5, 67, 35–40 | 2 | 0 / 1700 / 2000 | 0.7 | |
| Water Ghost Slave (6) | `…WATERGHOST_CLON_ATTACK01` / `_ATTACK03` | 100 / 100 | 5, 133 / 167, 41–47 | 1 | 0 / 1666 (1866) / 2000 (2500) | 1.6 | ATTACK1 / ATTACK3 |
| Water Ghost (7) | `…WATERGHOST_ATTACK01` | 100 | 5, 133, 47–54 | 1 | 0 / 1666 / 2000 | 1.6 | |
| | `…WATERGHOST_ATTACK02` "poison gas" | **10** | 9, **0**, 0–0 | 1 | **1196** / 2470 / 4000 | 1.6 | `ps` [34, 100, 16]: poison, level 34, 100 %, 16 per tick; effect `monster/skill_waterghost_gas_shot.efp` at `bone_smoke` on SHOT events 1–3 |
| Broken Stone Ghost (8) | `…STONEGHOST_CLON_ATTACK02` | 100 | 5, 100, 53–62 | 1 | 0 / 1000 / 1500 | 1.0 | |
| Tomb Stone Ghost (8) | `…TOMBSTONE_CLON_ATTACK01` | 100 | **10** (magic), 167, 74–83 | 1 | **1265** / 735 / 2500 | **10** | ranged force (Param1 1): a **projectile**, `AT_MOV_1TAR MOV_STRAIGHT,0,200,200` (20 m/s) from bone `fire01`, `monster/skill_tombstone_ghost_shot.efp` → `…_ghost_hit.efp`, sounds `Cm_Tomb_Force1_Swing/Hit.wav` |
| Stone Ghost (9) | `…STONEGHOST_ATTACK01` | 100 | 5, 83, 60–70 | 2 | 0 / 2200 / 2500 | 1.0 | |
| Tomb Stone (9) | `…TOMBSTONE_ATTACK02` | 100 | 10, 167, 84–94 | 1 | 1265 / 735 / 2500 | 10 | ranged force, projectile as above with `skill_tombstone_force_shot/hit.efp`, `Cm_Tomb_Force2_*.wav` |
| Decayed Yeoha (10) | `…YEOHA_CLON_ATTACK01` / `_ATTACK02` | 100 / 100 | 5, 167 / 83, 67–79 | 1 / 2 | 1070 / 830; 0 / 1900 / 2500 | 0.7 | |
| Yeoha (10) | `…YEOHA_ATTACK01` / `_ATTACK03` | 100 / 100 | 5, 167, 67–79 / **10**, 167, 94–105 | 1 | 1070 / 830; **1184** / 816 / 2500 | 0.7 / **10** | ATTACK03 is a ranged force: a projectile (`MOV_STRAIGHT` 200) from `effect_bone` to `Bip01`, `skill_yeoha_force_shot/hit.efp`, `Cm_Yeoha_Curse.wav` |
| Bandit Subordinate (11) | `…BANDIT_CLON_ATTACK01` / `_02` | 100 / 100 | 5, 100 / 67, 71–84 | 1 / 2 | 0 / 1100 (1500) / 1500 (2000) | 1.1 | |
| Bandit Archer (12) | `…BANDITARCHER_ATTACK01` | 100 | 6 (ranged), 167, 77–92 | 1 | **1383** / 617 / 2500 | **13** | arrow `res/mob/china/banditarcher_arrow.bsr` from `Bip01 R Hand`, `MOV_UPR` 400→400 units/s; `mirage_bow_normal.efp`; hit `hit_3_bow.efp` |
| Young Tiger (13) | `…TIGER_CLON_ATTACK02` | 100 | 5, 100, 85–101 | 1 | 0 / 1000 / 1500 | 0.9 | |
| Tiger (14) | `…TIGER_ATTACK01` / `_02` | 100 / 100 | 5, 50 / 100, 87–104 | 2 / 1 | 0 / 1500 (1000) / 1500 | 0.9 | |
| Bandit Bowman (15) | `…BANDITARCHER_CLON_ATTACK01` / `_02` | 100 / 100 | 6, 167 / 200, 94–113 | 1 | 1383 / 617 / 2500; **1556** / 944 / 3000 | 13 / 15 | `_02` "power shot": `mirage_bow_critical.efp` |
| Bandit (16) | `…BANDIT_ATTACK02` / `_03` | 100 / 100 | 5, 100, 102–123 / **9**, 133, **139–160** | 1 | 0 / 1100 / 1500; 0 / 1300 / 2000 | 0.4 | `_03` "fire strike": hit `hit_4_fire_hit_a.efp` |
| Black Tiger (17) | `…WHITETIGER_CLON_ATTACK01` | 100 | 5, 50, 111–133 | 2 | 0 / 1500 / 1500 | 0.4 | |
| | `…WHITETIGER_CLON_ATTACK03` "howl" | 100 | 9, **200**, 151–173 | 1 | **1044** / 1456 / 3000 | 0.4 | **`efr` [1, 1, 20, 5, 0, 24]: circle of 2 m around itself, 5 targets**; effect `monster/skill_whitetiger_howling.efp` at `Bip02 Spine1`. Its clip `ANI_ATTACK3` **does not exist** on `whitetiger_clon.bsr` (clips: ATTACK1 only) [confirmed sidecar] |
| White Tiger (18) | `…WHITETIGER_ATTACK01` / `_02` | 100 / 100 | 5, 50 / 100, 120–143 | 2 / 1 | 0 / 1500 (1000) / 1500 | 0.9 | |
| Chakji Worker (19) | `…CHAKJI_CLON_ATTACK01` / `_03` | 100 / 100 | 5, 133, 129–154 | 1 | 0 / 1266 / 2000; 1145 / 855 / 2000 | 0.4 | |
| Chakji (20) | `…CHAKJI_ATTACK01` / `_02` | 100 / 100 | 5, 133 / 67, 138–166 | 1 / 2 | 0 / 1266 (1733) / 2000 | 2.4 | |
| **Tiger Girl (20, unique)** | `…TIGERWOMAN_ATTACK01` | 100 | 5, 100, 181–217 | 2 | **1109** / 1391 / 3000 | 2.8 | clip ATTACK1, hit events 1109 / 1379 ms |
| | `…TIGERWOMAN_ATTACK02` "howl" | **30** | 9, **300**, 281–321 | 1 | 0 / 4000 / 4500 | 2.8 | **`efr` [1, 1, 40, 5, 0, 24]: 4 m circle around herself, 5 targets**; `skill_tigerwoman_howling.efp` |
| | `…TIGERWOMAN_ATTACK03` "curse" | **10** | **10** (magic), **367**, 281–321 | 1 | **3003** / 1997 / 5500 | **15** | `zb` [72, 100]: zombie, level 72, 100 %; `skill_tigerwoman_curse_motion/shot/hit.efp`; sound `monster\Cm_TigerWoman_Magic.wav` |
| | `…TIGERWOMAN_SUMMON01..04` | 80 / 60 / 40 / 0 | — | — | 0 / 0 / 500 | 0 | `ssou` [refObjId, rarity, min, max]×n: White Tiger (1953) and Black Tiger (1952). The Korean skill names say "summon at 80 % / 60 % / 40 % / 00 % 이상", so col 66 is the HP-% band here, not a weight [likely]. Groups [confirmed]: 01 = 3–6 WT + 3–6 BT (rarity 0); 02 = 01 + 2–4 WT and 2–4 BT of rarity 1; 03 = 3–6 WT r0, 1–2 WT r4, 3–6 BT r0, 2–4 BT r6; 04 = 3–6 WT r6, 1–2 WT r4, 3–6 BT r6, 1–2 BT r4. |

- **Levels 21–30** (`MOB_WC_*`) also have rows (`bu` burn [74, 10, 27] on Gun Powder, `efr` target circles on the Earth Taoist). They are above the cap and spawn only with `MOB_LEVEL_MAX` > 20.
- **Animations** [confirmed, `skilleffect.txt` skillaniset2 col 9 and the converted sidecars]. Every MSKILL attack row names one SHOT clip, `ANI_ATTACK1`, `ANI_ATTACK2` or `ANI_ATTACK3` (SUMMON rows: none). The clip's type-1 events are the damage moments, and they match the data: Mangyang ATTACK2 hits at 821 / 1381 ms (mc 2); Bandit Archer ATTACK1 at 1383 = castMs; Tiger Girl ATTACK1 at 1109 / 1379 = castMs, mc 2; Tiger Girl ATTACK3 at 341 / 3004 (castMs 3003).
  - The row number is **not** the clip number: `CHAKJI_ATTACK01` → ANI_ATTACK2, `CHAKJI_ATTACK02` → ANI_ATTACK1, `BANDIT_ATTACK02` → ANI_ATTACK1, `TOMBSTONE_ATTACK02` → ANI_ATTACK1 [confirmed]. Always read the aniset.
  - **Missing clips** [confirmed sidecars]: `whitetiger_clon.bsr` has only ATTACK1 (Black Tiger howl wants ATTACK3); `waterghost_clon.bsr` has no ATTACK3 (Water Ghost Slave `_ATTACK03`); `chakji_clon.bsr` has no ATTACK3 (Chakji Worker `_ATTACK03`). The client falls back to the mob's first ATTACK clip and shows the hit at `castMs` (or at once). `whitetiger.bsr` does have ATTACK3 (event 1324), but no White Tiger row uses it.
- **Hit effects**: skillaniset2 DamageEfp (col 14): `hiteffect/hit_3_normal.efp`, `hit_3_hand.efp`, `hit_3_bow.efp`, `hit_4_fire_hit_a.efp`.
- **Blood**: characterInfo col 9 per mob, `hit_2_redblood` or `hit_2_greenblood`.
- **Every effect file named above is already converted** under `work/out/fx/efp/` [confirmed]. `res/mob/china/banditarcher_arrow.bsr` is not converted; it exists in Data.pk2 (432 bytes) but not in the local `work/extracted` copy [confirmed `pnpm sro ls Data res/mob/china`]. EFFECTS FX-X converts it (`PRESETS.fx`).

### 2.2 Choosing a skill (server rule)

When the AI swings (`AiHost.swing(m, target)`, which today fires when `now ≥ m.nextSwingAt` and the target is in primary reach), `MobSkills.swing` picks:

1. **Candidates**: the mob's attack rows (not SUMMON). Each must be:
   - off its own cooldown (per mob, per skill: `m.skillReadyAt[code]`);
   - within reach, `row.range + m.radius + target.radius` (the target radius includes a horse, §1.3).
2. **Weighted pick** by `aiChance` (col 66): Tiger Girl 100 : 30 : 10 → 71 % / 21 % / 7 % when all are ready; Water Ghost 100 : 10 → 91 % / 9 % [decision; col 66 read as a weight, likely]. Rows with weight 0 are never picked.
3. **Fallback**: none ready → the primary (first) row, even on cooldown. A mob never stands idle in reach, as today.
4. **Timing**: `m.nextSwingAt = now + max(castMs + actionMs, cooldownMs)`, `skillReadyAt[code] = now + cooldownMs`, and `busyUntil = now + castMs + actionMs`.
   - `Mob` (world.ts) has neither field today [confirmed]. `MobSkills` keeps them in its own `Map<mobId, {skillReadyAt, busyUntil, cast?}>`, cleared on despawn, so `world.ts`' `Mob` type is not touched.
   - `Gameplay.tick` skips `thinkMob` while `now < m.busyUntil`: a mob stands still during its attack, as retail mobs do.
   - The AI's own `nextSwingAt` assignment (ai.ts) stays; MobSkills overwrites it after the pick.

**Ranged specials** (Tiger Girl curse 15 m, Yeoha force 10 m).
- A new optional `AiHost.ranged?(m, target, dist): boolean` is called in `thinkMob`'s chase branch before re-planning a chase.
- It returns true (and casts) when a **non-primary** row with reach ≥ dist is ready and wins its own chance roll (`aiChance`% per check, at most once per `CHASE_REPLAN_MS`).
- So the Tiger Girl curses a kiting player instead of only running after them.

**Summons** (`SUMMON01..04`) are **phase 2, off by default** (`MOB_SUMMONS=0`).
- When on: each band fires once when the mob's HP first falls to or below its value (80/60/40/0). What "이상" (at or above) means for the bands in retail, and when band 0 fires, is [unknown]. With our reading (a threshold crossed downwards) band 0 would fire only at 0 HP, so it is treated as off [decision].
- It spawns `min..max` of each `ssou` group (refObjId → mob code via characterdata id; the rarity byte maps through `MOB_RARITY` in `packages/convert/src/data/mobs.ts`: 0 normal, 1 champion, 4 giant, 6 elite [confirmed mapping in code; semantics likely]) around the caster as GM-style non-nest mobs, capped by `MOB_SUMMON_CAP` (default 6), all targeting the summoner's current target. Summons belong to their summoner: when she dies or leaves the world, her live summons leave with her (no corpse, no loot) [decision, W8-fix], so a respawned summoner never stacks a second capful at one spot.
- The finale encounter (docs/QUESTS.md JG_025) uses `hpMul 0.05` [confirmed `content/quests/jangan.json`]. `createMob` scales **maxHp** by `hpMul` and starts the mob at full HP [confirmed `gameplay.ts` createMob], so she starts at 100 % of a smaller pool and bands 1–3 would all fire as she is hurt: up to 12 + 20 + 18 = 50 tigers in retail numbers, band 3 alone bringing 1–2 giant White Tigers and 2–4 elite Black Tigers (66 if band 0 counted too). That is far too much for a party of friends, so the cap matters.

### 2.3 Release and hits

- **castMs = 0.** Roll and apply at once, as today, but with the row's percent and hits (§2.6 mode). The client shows each hit at the clip's i-th type-1 event (`hitCues`, already how skill `combat` works).
- **castMs > 0.** Send `cast` now. At `now + castMs` (the release), the target must still be alive, visible and within `row.range + radii + MOB_RELEASE_SLACK_M`:
  - melee (range < 3 m): slack **1 m**, so stepping away dodges;
  - ranged: slack **3 m**.

  Otherwise `castEnd {reason: 'target_lost'}`. A mob stunned, frozen or knocked down before the release sends `castEnd {reason: 'interrupted'}` (`SkillEngine.held(m)`).
- **Damage roll.** `rollSkillHit(mobStats', target.combat, spec)` per hit:
  - `mobStats'` = the mob's `CombatStats` with `physAttack` or `magAttack` replaced by the row's flat [min, max] × `VARIANT_RULES[variant].attack` × `tuning.attackMul`;
  - `spec = {pct, magic: kind === 10 || kind === 8}`;
  - att kinds 5 (melee), 6 (ranged) and 9 (physical AoE) are physical [confirmed kinds; 9 "physical AoE" likely].
  - A row with `pct 0` and a status (Water Ghost gas) is a pure debuff: one empty hit carries the status, like `SkillEngine.rollHits` does for Cold wave - Arrest. Note that `rollHits` takes that path only when `row.damage` is **absent** [confirmed], while the exporter's `skillDamage()` returns `{physPct: 0, magPct: 0, flat: [0, 0], hits: 1}` for `att [9, 0, 0, 0, 100]` [confirmed `mobs.json` shape]. `MobSkills` must treat `pct 0 && flat [0, 0]` as "no damage" itself (or `buildMobSkills` drops the `damage` of such rows).
- **Areas.** `efr` rows go through `selectTargets(area, caster, primary, candidates)`. The candidates are **players**: attackable (`AiHost.target`), within `area.distance + 3` m, not in a safe zone. The primary target is first. Secondary targets take `reductionPct` less (0 on every mob row).
- **Projectiles.** Rows whose hit cue has a `projectile` hold the rolled hits and apply them at `arrivalAt(releaseAt, distance, proj)` (`skills/timing.ts`, speed in dm/s) [confirmed signature]. That is the Bandit Archer and Bowman (`MOV_UPR` 400 = 40 m/s) **and** the Tomb Stone Ghost, Tomb Stone and Yeoha `_ATTACK03` force bolts (`MOV_STRAIGHT` 200 = 20 m/s) [confirmed skilleffect rows; col 16 FlyingSpeed is 400 on all five]. `combat.at` tells clients the landing time, as for player bows.
- **Statuses.** `rollStatuses(row, target, hit)` then `applyStatus(source, target, roll, now)` (both made public on `SkillEngine`, §6.4). Our rule stands: an abnormal state needs `status.level ≥ target.level`. Water Ghost poison is level 34 and Tiger Girl's zombie is level 72, so both apply to players ≤ 20. Burn and poison tick through the existing `STATUS_RULES` (5 s, 1 s ticks, damage = arg 3: poison 16 per tick).
- **Messages.** One `cast` per use (castMs > 0 **or** a row with its own presentation, meaning always), then `combat {attacker: m, target, hits, skill: row code, instance}` per target through `Gameplay.dealHits`, so the damage share, retaliation, horse redirect, player death and durability loss (§3) stay on one path.

### 2.4 Content and export

**skills.json gains the MSKILL rows** of every mob in mobs.json. They are the same `SkillDef` shape: `mastery: null`, no `ui` (hidden), `kind` `'attack'` or `'debuff'`, `animation {shot: 'ATTACK1'}`, `hitCues`, `damage`, `area`, `statuses`, and cooldown = max(col 14, col 15). Plus:

```ts
// packages/shared/src/content.ts, SkillDef additions (all optional)
/** Monster row (MSKILL_*): never learnable or usable by players (SkillEngine.plan already refuses mastery null). */
mob?: true
/** skilldata AI_AttackChance (col 66): weight of the pick on attack rows; the HP-% band on SUMMON rows. */
aiChance?: number
/** 'ssou' records of a SUMMON row: [refObjId, rarity byte, min, max] resolved to mob codes. */
summon?: { mob: string; rarity: number; min: number; max: number }[]
```

- `MobDef` gets the already-exported `attacks?: MobAttack[]` in its type (documentation only; the server reads skills.json).
- **fx index**: the MSKILL groups of exported mobs go into `work/out/fx/skills.json` (today only `CHINESE_MASTERIES`), with their `clips`, `damage` efp and `stages` (bones, offsets, `AT_*`, `MOV_*`, sounds). **EFFECTS owns this**: its FX-X lane rewrites `packages/convert/src/fx/skills.ts` as the v2 builder that already includes "every `MSKILL_*` in `MobDef.skills`" (docs/EFFECTS.md §5.1). This spec only depends on it.
- **Models**: `res/mob/china/banditarcher_arrow.bsr` (the arrow mesh of the `AT_MOV_1TAR` stage) is in EFFECTS' `PRESETS.fx` (docs/EFFECTS.md §5.3). Not converted here.

### 2.5 Client

- `world/skills-view.ts` already plays a `cast`:
  - READY / WAIT / SHOT from `SkillDef.animation`;
  - hits at `hitCues`;
  - `castEnd` cancels.

  Today it falls back for mobs "without skill data" [confirmed `skills-view.ts:134`]. With MSKILL rows in skills.json, mob casts take the same path. The `SHOT` type is `ATTACK1..3`; the mob actor has those clips except the three `_clon` gaps of §2.1, which fall back to ATTACK1.
- **Ownership:** `world/skills-view.ts` and `world/skill-fx.ts` belong to EFFECTS lane FX-C1 in this wave (docs/EFFECTS.md §6.4, "Mob attacks … play its stages; ranged mob rows fly"). The mob-cast items below are handed to FX-C1 as its requirements; this spec owns no edit in those two files (§8, lane MS-C).
- `world/skill-fx.ts` plays the fx index stages for any caster:
  - `AT_ONE_FOLLOW` effects on the caster's bone (`bone_smoke`, `Bip02 Spine1`);
  - `AT_MOV_1TAR` projectiles (the bandit arrow mesh);
  - `AT_TARGET MOV_STRAIGHT` (the Tiger Girl curse hits);
  - the DamageEfp on each hit, and the mob's blood efp.

  The lane checks that caster-kind assumptions (players only) are removed.
- Sounds: the stage `SndBegin` keys (e.g. `monster/cm_tigerwoman_magic`) through the existing sound cue path for skills.
- Nothing new in the HUD. Status icons (poison, zombie) already show through `effectAdd`.

### 2.6 Damage scale: `MOB_SKILL_DAMAGE` (config, default `relative`)

Retail percents change today's balance (docs/BALANCE.md was tuned with 100 % × 1 hit). Per mob, expected damage per swing relative to today, weighted by `aiChance` (the flat midpoint scales it too) [model, computed from the table above]:

| Mob | ×/swing | Mob | ×/swing | Mob | ×/swing |
|---|---|---|---|---|---|
| Mangyang 1 | 2.00 | Tomb Stone 9 | 1.67 | Bandit 16 | 1.38 |
| Small-Eyed Ghost 2 | 1.33 | Yeoha 10 | 1.97 | Black Tiger 17 | 1.83 |
| Weasel 5 | 1.34 | Bandit Archer 12 | 1.67 | White Tiger 18 | 1.00 |
| Water Ghost Slave 6 | 1.50 | Tiger 14 | 1.00 | Chakji 20 | 1.33 |
| Tomb Stone Ghost 8 | 1.67 | Bandit Bowman 15 | 1.83 | Tiger Girl 20 | 2.80 |

The Qin-Shi Tomb (Tomb Stone Ghost 8, Tomb Stone 9) would hit 1.67× harder, against the user's request to make the level-8 tomb *less* punishing.

Three modes:
- **`relative`** (default): each row's pct becomes `100 × pct / (primaryPct × primaryMc)`, then is applied `mc` times as usual. So the primary row's whole swing (all its hits) totals today's 100 % × 1 hit, and the other rows keep their retail ratio to it: Mangyang's double slash 2 × 50 %; Tiger Girl howl 1.5× and curse 1.84× magic (her primary is 100 % × 2); Black Tiger howl 2× on a 2 m area (primary 50 % × 2).
  - Correction to the first draft, which divided by the primary pct only: that made every primary with `mc 2` (Black Tiger, Tiger, White Tiger, Stone Ghost, Weasel, Tiger Girl) swing for 2× today's damage, and gave the specials 3×, 3.67× and 4×.
  - The row's own flat range still applies (§2.3 `mobStats'`), so a special with a higher flat (Tiger Girl howl and curse 281–321 against 181–217) hits about 1.5× harder again [model].
- **`retail`**: raw percents (the table above).
- **`flat`**: every row at 100 % × `mc`.

A multiplier `MOB_DAMAGE_RATE` (default 1) applies after the mode. The balance lane re-runs `docs/BALANCE.md` §6 in `relative` mode as part of this wave.

---

## 3. Durability and repair

### 3.1 Data [confirmed]

- **Durability roll** (itemdata cols 63/64), exported as `ItemDef.stats.durability`:
  - Copper Sword 62–76, Infantry Bronze Sword 67–81, Spiritual Sharp Sword 75–91;
  - Copper Shield 46–56, Copper Armor 48–59, Cotton Suit 39–48, Copper Bow 47–58.
  - Accessories have **none** (and `canRepair: false`).
- **`repairCost`** (Cost_Repair col 27): Copper Sword 198 (price 890), Infantry Bronze Sword 577 (3,500), Spiritual Sharp Sword 1,207 (38,750), Copper Shield 110, Copper Armor 116, Copper Bow 218.
- **`canRepair`** (col 22): true on weapons, shields and armour.
- **Client strings** (textuisystem):
  - `UIIT_CTL_REPAIR` "Repair", `UIIT_CTL_REPAIR_ALL` "Repair all";
  - `UIIT_MSG_MSGBOX_REPAIR_ITEM` "Repair all equipment in the inventory and weaponry slots.";
  - `UIIT_MSG_STRGERR_THERE_IS_NO_ITEM_TO_REPAIR` "No item needs repairing.";
  - `UIIT_MSG_STRGERR_NOT_ENOUGH_REPAIR_GOLD` "Cannot repair due to insufficient gold";
  - `UIIT_MSG_STRGERR_CANNOT_BE_REPAIRED` "The selected item is unrepairable.";
  - **`UIIT_SKILL_USE_FAIL_BROKEN_WEAPON` "Cannot attack because the weapon is broken"**;
  - **`UIIT_MSG_STRGERR_CANT_EQUIP_RAZED_ITEM` "Cannot equip a broken item."**;
  - `PARAM_DUR` "Durability", `PARAM_MAX_DURABILITY` "Maximum durability".
- **Shop group names** say who repairs: `SN_STORE_SMITH_GROUP1` "Purchase/ Sell/ Repair Chinese Weapon"; `SN_STORE_ARMOR_GROUP1/2` "Purchase/ Sell/ Repair Chinese Male/Female Protector". The accessory store has no repair.
- **Sound**: cue `ui.repair` (`SND_REPAIR` `ui\itRepair_a/b/c.wav`) exists. The break and warning sounds are `work/out/sound/ui/itembreak.ogg` and `ui/itemdanger.ogg` (not `common/`), and **cues already exist**: `ui.eqbreak` and `ui.eqdanger` [confirmed `work/out/sound/index.json`]. No new cues are needed. Note that the index maps `ui.eqbreak` → `ui/itemdanger` and `ui.eqdanger` → `ui/itembreak` [confirmed]: the DR lane checks by ear which file is which and, if the mapping is crossed, reports it to the sound exporter's owner.
- **UI art**:
  - `interface/durabilityerror/broken.ddj` (32×32, a translucent red square: the slot overlay of a broken item);
  - `interface/durabilityerror/warning.ddj` (128×64 sheet: 17 non-empty 16×16 cells, 16 red glow frames growing then fading plus a last outline cell, in rows of 8: the low-durability pulse) [confirmed images; frame use likely].
- **Not in the data** [unknown]:
  - how fast items wear;
  - the retail repair-price formula;
  - whether broken armour keeps any stats.

### 3.2 Rules (server; knobs in `config.ts`)

**Instance durability.**
- `ItemStack.durability` (absent = full).
- Max = the **top of the def's roll** (`stats.durability[1]`) [decision]. SHOPS §2.6 gives a bought item the package `Data` durability (62 for the Copper Sword, the bottom of its 62–76 roll) and a looted one the top, but stores both as `null` (full) [confirmed docs/SHOPS.md §2.6]. With `null` = full = the roll top, a bought Copper Sword effectively has 76; the package value is not modelled. The client tooltip already reads max as `stats.durability[1]` [confirmed `hud/items.ts:171`].
- Items without `stats.durability` never wear.

**Wear**, applied inside `Gameplay.dealHits` through the durability seam (§6.4):
- **Weapon**: each landed player hit (outcome `hit` or `crit`, player → mob) has `DUR_WEAPON_LOSS_PCT` = **5 %** to cost the equipped weapon 1 point (one landed hit in 20 on average).
- **Armour**: each landed hit on a player (outcome `hit`/`crit`, damage > 0) picks one random worn armour piece with durability and has `DUR_ARMOR_LOSS_PCT` = **5 %** to cost it 1. Hits redirected to a ridden horse do not wear the rider's armour. DoT ticks (`extra.dot`, §1.3) wear nothing.
- **Shield**: each `block` has `DUR_SHIELD_LOSS_PCT` = **10 %** to cost 1.
- **Death** costs nothing [decision].

At those rates a Copper Sword (76) lasts about 1,500 landed hits, which is several hundred kills. With ~860 kills from level 1 to 20 at EXP_RATE 3, a player repairs 2–6 times on the way [model].

**Write path.**
- Loss goes through `store.inventoryTx` for the one equip slot.
- The player gets `inventoryUpdate {equip: [{slot, item}]}` (the integer changed).
- When it reaches 0, also `stats` (the recompute) and the system line "Your [item] is broken." with the `ui.eqbreak` cue.
- Low warning: when durability falls to ≤ `DUR_WARN_PCT` (10 %) of max for the first time, the system line "Your [item] is almost broken." with the `ui.eqdanger` cue.

**Broken (0).**
- `playerCombatStats` skips the item's stats and its `perPlus`: `combatFor` passes stacks and the formula filters on `durability === 0`.
- A broken weapon: `attack` and every **weapon** `useSkill` (rows with `weapons.length > 0`, and basic attacks) are refused with **`broken`**. Force-only skills that need no weapon still work [decision]. An auto-attack in progress stops with the system line from `UIIT_SKILL_USE_FAIL_BROKEN_WEAPON`. The auto-attack swing happens in `Gameplay.tickAction` (`if (now >= p.nextSwingAt) … this.attack(p, t, now)`) [confirmed], so that is where the check goes (a seam line, §6.4); refusing only the `attack` request would not stop a swing loop that started before the weapon broke.
- `itemEquip` of a broken item → `broken` ("Cannot equip a broken item."). Unequipping is always allowed. The equip rule lives in the pure `equipItem(d, bag, slot, {level, gender}, lookup)` of `apps/server/src/inventory.ts` [confirmed], called from `Gameplay.request` case `'itemEquip'`.

**Selling** does not scale with durability or plus (SHOPS §2.6 decision stands).

### 3.3 Repair

- **Where.** `NpcDialogs.has(p, npc, 'repair')` is true for NPCs whose `NpcDef.roles` include `'repair'`. The exporter sets it on `NPC_CH_SMITH` and `NPC_CH_ARMOR` (from the store-group strings above).
  - Either NPC repairs **every** repairable item [decision; the retail per-NPC split is unknown].
  - `servicesOf` adds `'repair'` to the dialog list. Today `has()` has a `case 'repair': return false` and `servicesOf` filters `['shop', 'storage', 'quest']` [confirmed `npc.ts:127`, `:135`]; `NpcService` already includes `'repair'` [confirmed `protocol.ts:915`]. SOCIAL's FS pass edits the same list (`'guild'`), so both land in one pass.
  - The exporter's roles code is in `packages/convert/src/data/npcs.ts` (`roles.push('shop' | 'teleport' | 'storage')`) [confirmed `:181-194`]; that file has uncommitted edits in the working tree right now (the NPC-facing fix), so the EXP lane rebases on them.
- **Request.** `repair {npc, items?}`.
  - `items` absent = repair all: every bag and equip item with durability < max.
  - Otherwise a list of `{equip: EquipSlot} | {bag: number}` (1–16 entries).
- **Validation, in order:**
  1. `requireService(p, npc, 'repair')` (`not_found` / `too_far`);
  2. dead → `dead`;
  3. each listed ref must hold an item (`invalid_slot`) that is repairable (`not_usable`, "The selected item is unrepairable.");
  4. nothing damaged → `nothing_to_repair`;
  5. gold < total → `not_enough_gold`. All or nothing.
- **Cost per item** [unknown retail formula; decision]: `ceil(repairCost × (max − cur) / max)`. A broken Copper Sword costs 198. A Copper Sword at 70/76 costs 16.
- **Effect.** One `inventoryTx`: durability → `null` (full) and gold −total. Then `actionResult ok` → `inventoryUpdate {bag?, equip?, gold}` → `stats` when a broken worn item came back → the `ui.repair` cue on the client (on its own `actionResult ok`).

### 3.4 Client

- **Tooltip** (`hud/items.ts`): the "Durability cur / max" line **already exists** for a stack with `durability` set (`item.durability`, max = `stats.durability[1]`); a full stack (absent) shows the roll range instead (`item.durabilityRange`, e.g. "62–76"), and the `+N`-adjusted stat ranges (`plus × perPlus`) exist too [confirmed `hud/items.ts:167-172`]. New: a full stack shows "max / max", the line turns red at ≤ 10 %, "(broken)" at 0, and the stats of a broken item are struck through. `hud/items.ts` is hooked by UI lane UI-W (`TooltipLine.cls` additions), so the DR lane asks UI-W for a `bad` class on that line rather than editing the file.
- **Slots** (a `SlotDecorator` seam; the UI rework owns slot markup: `hud/slots.ts` view parts → `ui/kit/slot.ts`, lanes UI-K/UI-W in docs/UI.md §9.1). The seam `Slot.setOverlay(kind: 'broken' | 'warning' | null)` is a request to UI-K; DR only calls it:
  - broken → the `broken.png` red overlay;
  - ≤ 10 % → the `warning.png` pulse (the 16 glow cells of the sheet at 12 fps).
  - The equipment window and the hotbar show both.
- **HUD warning.** While any worn item is ≤ 10 % or broken, a small equipment-warning icon next to the player frame (tooltip lists the items).
- **NPC dialog.** The client drops `'repair'` today: `dialogOptions()` orders only `['shop', 'storage', 'quest']` [confirmed `hud/shop-logic.ts:115`] and `NpcDialog.choose()` has no repair branch [confirmed `hud/npc-dialog.ts:149`]. The shared client-seam pass adds `'repair'` to that order and the NPC-service handler registry that SOCIAL §9.1 defines (`registerNpcService(service, fn)`); DR registers `'repair'`, which opens the NPC's shop window with the repair buttons.
- **Shop window** of a repairing NPC (`hud/shop.ts` belongs to UI-W; the buttons come through a `ShopWindow.addFooterButton()` hook requested from UI-W, and the logic lives in DR's `hud/repair.ts`):
  - **Repair** toggles a hammer cursor: clicking a bag or equipment item sends `repair {npc, items: [ref]}`.
  - **Repair all** shows "Repair all equipment in the inventory and weaponry slots.", the total (client-side preview from the catalog formula), Confirm / Cancel.
  - Both are disabled with the tooltip "No item needs repairing." when nothing is damaged.

---

## 4. Alchemy (+N enhancement)

### 4.1 Items [confirmed itemdata; names from textdata_object]

| Code | Name | TypeID | Class (61) | Price / sell | Stack | Param1 (targets) | Param2 / 3 / 4 (per plus, packed) | Drop model |
|---|---|---|---|---|---|---|---|---|
| `ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A` (3675) | Elixir(Weapon) | 3/3/10/1 | 1 | 50,000 / 10,000 | 1 | 0x06000000 → TypeID3 **6** (weapons) | 0x19140F0A, 0x0A0A0A0A, 0x0A050505 (Desc "1,2,3,4" / "5,6,7,8" / "9,10,11,12") | `item\etc\drop_reinforce_recipe.bsr` |
| `…RECIPE_SHIELD_A` (3676) | Elixir(Shield) | 3/3/10/1 | 1 | same | 1 | 0x04000000 → **4** (shields) | same | same |
| `…RECIPE_ARMOR_A` (3677) | Elixir(Protector) | 3/3/10/1 | 1 | same | 1 | 0x01020300 → **1, 2, 3** (garment, protector, armour) | same | same |
| `…RECIPE_ACCESSARY_A` (3678) | Elixir(Accessory) | 3/3/10/1 | 1 | same | 1 | 0x05000000 → **5** (accessories) | same | same |
| `ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_01` (3683) | Lucky Powder(1st) | 3/3/10/2 | **1** | 5,250 / 1,313 | 50 | 1 (degree) | 0x321E1408, 0x08080808, 0x08080808 | `item\etc\drop_reinforce_prob_up.bsr` |
| `…PROB_UP_A_02` / `_03` | Lucky Powder(2nd) / (3rd) | 3/3/10/2 | 2 / 3 | 9,844 / 15,094 | 50 | 2 / 3 | same bytes | same |

Out of scope:
- the `_B` elixirs ("Intensifying Elixir", class 2, an "advanced elixir" applied once: `UIIT_MSG_REINFORCERR_ALREADY_DONE`; sold only in the arena shop `STORE_BATTLE_ARENA_CH_TAB2`);
- Lucky Magic Powder `PROB_UP_B_*`;
- magic and attribute stones (`ARCHEMY_MAGICSTONE_*`, `ATTRSTONE_*`), elements and rondos;
- `MAGICSTONE_LUCK/SOLID/ATHANASIA/ASTRAL`.

Elixir CanUse (col 24) is 0 (not "used" from the bag) [confirmed].

**Three data traps** [confirmed]:
- **Missing icon.** The four `_A` elixirs name icon `item\etc\archemy_reinforce_recipe_a.ddj` (col 54), which is **not in Media.pk2**: `icon/item/etc/` holds only `archemy_reinforce_recipe_{b,weapon_b,shield_b,armor_b,accessary_b}.ddj` [confirmed `pnpm sro ls Media icon/item/etc`]. The exporter writes `icon: null` for them unless it maps them to a fallback; the EXP lane uses the matching `_b` icon per kind (`recipe_weapon_b` for WEAPON_A, …) with a `fieldSources.icon` note [decision]. The powder icon `archemy_reinforce_prob_up_a.ddj` exists.
- **Powder degree.** `ItemDef.degree` is `ceil(ItemClass col 61 / 3)` [confirmed `content.ts`, `packages/formats/src/textdata.ts:484`], so Lucky Powder 1st/2nd/3rd (classes 1/2/3) all get **degree 1**. The powder's own degree is its Param1 (col 118) = 1/2/3 (equal to its class). The export stores it as `reinforce.degree` (§6.3), and the server compares `powder.reinforce.degree === item.degree`, never `powder.degree`.
- **Drop models not converted.** `res/item/etc/drop_reinforce_recipe.bsr` and `drop_reinforce_prob_up.bsr` exist [confirmed Data] but `work/out/item/etc/` has only the 7 ground models of docs/DATA.md; the EXP lane converts both with `pnpm sro convert`.

**Client strings that define the flow** (textuisystem) [confirmed]:
- `UIIT_STT_ALCHEMYBOX_REINFORCE_ITEM` "Equip Enhance";
- `UIIT_STT_ALCHEMYBOX_REINFORCE_TEXT` "when equipment and elixir are combined, the equipment is usually strengthened with + options. … Warning: All used items will be disappeared.";
- `UIIT_STT_ALCHEMYBOX_COMPOUND` "Fuse";
- `UIIT_MSG_ALCHEMY_CANCELED_COMPOUND` "Fusing has been cancelled.";
- `…REINFORCERR_RECIPE_NOT_LOADED` "Cannot reinforce without Elixir.";
- `…RECIPE_MISMATCH` "Cannot use a Elixir that is different from equipment's type.";
- `…EQUIPCLASS_MISMATCH_PROB_UP` "The level of the powder of luck and the equipment is different.";
- `…ONLY_EQUIPITEM_CAN_BE_REINFORCED`, `…LOAD_EQUIP_FIRST`, `…FAIL` "The alchemy enhancement has failed.";
- `…FAIL_RESULT_OPTLV_ZERO` "The enhancement level on the equipment is gone, because the alchemy enhancement failed.";
- `…FAIL_RESULT_OPTLV_DOWN`, `…FAILDOWN_DURABILITY`, `…BREAKDOWN` "The item has been destroyed…";
- `…SUCCESS` "Success! Endurability has been changed to [%d].";
- `…CANNOT_USE_ALCHEMY_AT_FLEAMARKET`, `…CANNOT_TRADE`.

**Retail rules** (RR §4.5, official iSRO pages, high): failure at +0…+4 resets to +0; from +5 it resets **and** lowers max durability or destroys the item. Lucky Powder must match the degree. The fuse delay is 3 s (vSRO-ServerAddon default "fuse delay 3", high).

### 4.2 Stats per plus [confirmed columns; linear formula likely]

itemdata has per-plus increments, exported as `ItemDef.perPlus` (not yet in the TypeScript type):

| Item | perPlus |
|---|---|
| Copper Sword | physAttack 2.4, magAttack 4.1 |
| Spiritual Sharp Sword | 4.7 / 8.1 |
| Copper Armor | physDefence 0.4, magDefence 0.5 |
| Copper Shield | 0.3 / 0.5 |
| rings | absorb 0.23 |
| earrings | absorb 0.25 |

Also parryRate (col 70) and hitRate (col 115) where non-zero.

Rule: a worn item at +N adds `perPlus[k] × N` to its stat k. Attacks add to both ends of the range. The addition happens in `playerCombatStats` from `stack.plus`, which today ignores plus [confirmed code: `worn` passes `stack` but the loop reads only `def.stats`].

`ItemDef.reinforcePct` (attack or defence reinforcement from STR/INT, cols 82–85, 105–112) is a separate retail mechanic. It stays unused [decision].

### 4.3 Success rate

**The packed bytes.** Read big-endian (the first byte is plus 1 of the "1,2,3,4" group), they are [likely per-plus success/bonus percentages]:

| Target plus | +1 | +2 | +3 | +4 | +5 | +6 | +7 | +8 | +9 | +10 | +11 | +12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Elixir A (all four) | 25 | 20 | 15 | 10 | 10 | 10 | 10 | 10 | 10 | 5 | 5 | 5 |
| Lucky Powder A (all degrees) | 50 | 30 | 20 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 |
| **Sum (elixir + matching powder)** | **75** | **50** | **35** | **18** | 18 | 18 | 18 | 18 | 18 | 13 | 13 | 13 |

- Big-endian gives a falling curve.
- The Elixir B and Powder B rows fall the same way: 50 / 40 / 30 / 19–20, then 17–20, then 10–12.
- Little-endian would give a *rising* chance, which no enhancement system has.
- RR says Param2–4 hold "lucky powder/elixir per-level bytes", with byte order unverified.

**Rule.** `chance = min(100, (elixir[N] + (powder degree == item degree ? powder[N] : 0)) × ALCHEMY_RATE)`, for target plus N = current + 1.
- `ALCHEMY_RATE` defaults to **1.5** for the friends server: 100 / 75 / 53 / 27 / 27… with powder. Retail = 1.
- The roll is `rng() × 100 < chance`.

**Caps and failure.**
- Cap `ALCHEMY_MAX_PLUS` = **10** [decision].
- Failure → plus **0**. Durability and max durability are unchanged, and nothing is destroyed at any plus (`ALCHEMY_DESTROY` off; retail destroys or lowers durability from +5).
- Success → plus + 1, durability unchanged.
- The elixir and the powder are consumed either way.

### 4.4 Flow (server module `alchemy.ts`)

1. **`alchemyReinforce {item, elixir, powder?}`** (bag indexes). Validation, each an `actionResult` reason:
   - alive (`dead`);
   - not mounted (`mounted`);
   - not busy: no running alchemy, skill action or item cast (`busy`);
   - `item` is weapon, shield, armour or accessory equipment in the **bag** (`invalid_slot` / `not_usable` "Items that are not equipments can not be reinforced."; worn items must be unequipped first [likely retail]);
   - not broken (`broken`);
   - `elixir` is an elixir whose `reinforce.targets` contains `item.typeId[2]` (`alchemy_mismatch` + message `RECIPE_MISMATCH`);
   - `powder`, if sent, is a powder whose `reinforce.degree === item.degree` (`alchemy_mismatch` + `EQUIPCLASS_MISMATCH_PROB_UP`; see §4.1 "Powder degree");
   - plus < cap (`max_plus`).
2. Accept: `actionResult ok`, then `alchemyStart {item, readyInMs: ALCHEMY_FUSE_MS}` (3,000). The server keeps `{item: {slot, code, plus}, elixir: {slot, code}, powder?, endsAt}`. **Nothing is consumed yet.**
3. **Cancels**: `alchemyCancel`, `moveTo`, `attack`, `useSkill`, `npcTalk`, death, warp and logout. Each sends `alchemyResult {outcome: 'cancelled'}`; nothing changes.
   - Modules only see other modules' requests through hooks (`moved`, `stopped`, `tickPlayer`, `playerDied`, `warped`, `forget`) [confirmed `modules.ts` ModuleHook]. `alchemy.ts` detects the cancels the way `item-use.ts` does for the return scroll: `moved` → cancel; `tickPlayer` → cancel when `p.action !== null` (attack, pickup, talk, skill walk) or `g.skills.busy(p)` [confirmed pattern `item-use.ts:177`].
4. At `endsAt` (tick), in **one `inventoryTx`**:
   - re-check that each slot still holds the same code (and plus for the item). Otherwise `cancelled`;
   - take the elixir and 1 powder;
   - roll;
   - set `plus`.

   Then send `inventoryUpdate`, `alchemyResult {item, code, outcome, plus}`, and the system line: success "Success! [Copper Sword] is now +3." / failure "The alchemy enhancement has failed. The enhancement level on the equipment is gone.".
5. **Chat broadcast** on success at +7 or higher (optional, `ALCHEMY_ANNOUNCE_FROM` = 7): "[name] enhanced [item] to +7!".

No other module needs a lock: step 4 re-validates.

### 4.5 Where elixirs come from (level ≤ 20)

- **Retail drops** (port `_RefDropClassSel_Reinforce` chain, provenance port) [confirmed in port data]:
  - `elixir_weapon/armor/shield/accessory`, **0.0226 % each** per kill (`chance` 0.00022575);
  - only mobs level ≥ 15: Bandit Bowman 15, Bandit 16, Black Tiger 17, White Tiger 18, Chakji Worker 19, Chakji 20, Tiger Girl 20 (`dt_banditarcher_clon`, `dt_bandit`, `dt_whitetiger_clon`, `dt_whitetiger`, `dt_chakji_clon`, `dt_chakji`, `dt_tigerwoman`).
  - **Which elixir is [unknown].** The port's `itemmap-tam.json` maps `elixir_*` to the `_A` codes (3675–3678) [confirmed], so our drops builder emits `_A`. But every one of these drop entries carries the port's own note `vSRO RECIPE_*_B (grup 2) -> jw tek elixir kademesi`: its source rows were the **`_B`** (Intensifying) elixirs, folded into one tier [confirmed]. Retail may not drop `_A` elixirs from these mobs at all. We keep the `_A` mapping as a design choice (provenance port).

  All four together are 0.09 % per kill, so about one elixir per 550 kills of those mobs at DROP_RATE 2 (the first draft said 1,000). They join `drops.json` automatically once the codes are in `items.json` (the drops builder keeps only exported codes).
- **Authored supplement** (server config, provenance `authored`): every kill of a mob of level ≥ `ELIXIR_DROP_MIN_LEVEL` (5) rolls `ELIXIR_DROP_PCT` = **0.8 %** for one elixir, weighted weapon 40 / armour 40 / shield 10 / accessory 10. It is owned like any loot (party rules apply) and is multiplied by `DROP_RATE`.
  - Expected by level 20 at the recommended rates: about 860 kills → ~7 × 2 = ~14 elixirs [model].
- **Lucky Powder**: Grocery Trader Jinjin's retail Alchemy tab `STORE_CH_ACCESSORY_TAB3` (`SN_TAB_ALCHEMY`) lists `PROB_UP_A_01..10` [confirmed]. The export keeps `_01.._03` **by code** (`PROB_UP_A_0[1-3]`): the degree limit alone would not do it, since powders `_04.._09` (classes 4–9) get `ItemDef.degree` 2–3 and pass `MAX_ITEM_DEGREE` 3 [confirmed `items.ts isExportedItem`]. The same tab's speed potions, rondos and `ARCHEMY_ETC_02` stay out.
- **Quests**: a request to the quest content owner (not edited here). Add one weapon elixir to the Act II and Act III finales, an armour elixir to Act IV, and 5 Lucky Powders of the matching degree alongside.

### 4.6 Visuals and sounds

- **Retail alchemy window art** (`interface/alchemy/`) [confirmed images]:
  - `alcm_window_reinforcement.ddj` (376×192): the rune circle with 4 gem sockets on the left, and 4 slots on the right (equipment, elixir, powder, a spare) with silhouettes;
  - `alcm_window_1.ddj` (376×172 parchment for the description);
  - `alcm_slot_open.ddj` (48×48);
  - `alcm_button*.ddj` (112×28 with focus, press and disable);
  - `alcm_effect_prepare.ddj`, `alcm_effect_success.ddj`, `alcm_effect_fail_1.ddj`: 256×256 sheets of 4×4 frames of 64×64 played over the circle.
- **Sounds** [confirmed cues]: `ui.elixir_use` when the fuse starts, `ui.elixir_success`, `ui.elixir_failure`; `ui.elixir_destroy` stays unused.
- **Ground items**: elixirs use `res/item/etc/drop_reinforce_recipe.bsr` and powders `drop_reinforce_prob_up.bsr` (itemdata col 53) [confirmed], plus the drop cue `item.dropElixir` [confirmed cue]. Neither model is converted yet (§4.1). Their ground sparkle comes from the model's own particle set through EFFECTS §5.2 sidecar `particles`, played by EFFECTS lane FX-C2, which owns `world/drops.ts` (rewrite). `work/out/fx/efp/item/drop_archemy.json` exists [confirmed], but EFFECTS' preset lists `drop_archemy*.bsr`, which no in-scope item names in col 53; whether that efp belongs to our drop models is [unknown]. This spec does not edit `world/drops.ts`.
- **Weapon glow by plus**: `system/system_enchant_a_01`, `_b_01`, `system_enchantbow_a_01` and `system_enchantshield_a_01` exist [confirmed files]. EFFECTS §3.10 maps them by weapon family from `itemoptionefp.txt` (bones `ai_end` / `ai_start` / `Bone01`); from which plus they show is still [unknown] (col 5 is 8 on every row). **Wired 2026-10-05** as a glow per + level from +1 (+7 adds retail's glint run): EFFECTS §3.10 "Ours", `apps/game/src/three/weapon-glow.ts`.

### 4.7 Client

**Alchemy window** `hud/alchemy.ts`. It opens by:
- right-clicking an elixir or powder in the bag;
- the inventory's Alchemy button (the inventory becomes a Main-window tab owned by UI-W, docs/UI.md §9.1: a request to UI-W; until then a MENU row through `registerMenuItem`);
- the keyboard: none by default.

The window is built on the UI kit (`ui/kit/window.ts`, docs/UI.md §7 "new-system windows") and constructed by `world/features/alchemy.ts` on `hud.layer`, as the party and quest features do [confirmed `world/features/party.ts:371`]; no `hud/index.ts` edit.

Layout, after the retail window:
- **Slots**: Equipment, Elixir, Lucky Powder. Drag from the bag, or right-click a bag item while the window is open.
- **Info**: the item's name `+N → +N+1`, the success % (client preview from the same formula and `ALCHEMY_RATE`, which `worldEnter.world` sends as `alchemyRate`), and the warning line from `REINFORCE_TEXT`.
- **Buttons**: **Fuse** (disabled until valid) and **Cancel** (during the fuse). Fuse sends `alchemyReinforce`, and `alchemyStart` plays `alcm_effect_prepare` for `readyInMs`.
- **Result**: `alchemyResult` plays the success or fail sheet and cue. The equipment slot then shows the new `+N`. Failed slots keep the item; the elixir and powder slots empty.

Item names show `+N` wherever items appear (bag, tooltip, ground labels: `itemLabel` already handles `plus`).

---

## 5. Berserk (Hwan)

### 5.1 What is known

| Fact | Source | Status |
|---|---|---|
| 5 points ("Berserker marbles") from hunting; full gauge → press **Tab** → "your power and agility are increased substantially" | texthelp `SRO_GGW_EVE_WHANMODE`, `SRO_MSGTIP_52` "If you press [TAB] key with berserker gage full, then berserker mode is activated.", `SRO_GGW_BO_INTKEY` "[Tab]key - Berserker mode" | confirmed |
| Points 0–5, entered at 5, **no gain while in berserk** | RR §4.5 (RSBot, decomp `ModifyBerserkPoints`) | confirmed (high) |
| Damage ×2 | RR: BodyMode 1 sets hit flag 0x04; damage × (2.0 + param) | likely (RR rates it low) |
| Speed 200 % | `_RefHWANLevel` community template `SPDU` = 200 | likely |
| Duration | not found | unknown |
| Points per kill | not found | unknown |
| Items that are refused while berserk | `UIIT_MSG_QUEST_ERR_USE_WHANITEM`, `UIIT_MSG_HWAN_FAIL_OVERLAP_1` "Cannot be used in berzerk mode." | confirmed strings (which items: unknown; none in our scope) |

**Art** [confirmed files]:
- `interface/playerminiinfo/pmi_window.ddj` (220×76: the retail player frame with **5 orb sockets** arcing around the face);
- `pmi_jahwan.ddj` (8×8 orb);
- `pmi_jahwan_glow.ddj` (256×128 glow when full);
- `pmi_jahwan_burn.ddj` (128×64 while active);
- `pmi_jahwan_button*.ddj` (20×20 Berserk button: normal, focus, press);
- `pmi_jahwan_face.ddj` (48×48);
- `interface/image/guide_whanmode.ddj`: the retail guide, 5 pink orbs, then a character wrapped in red flame with wild red hair.

**Effects** [confirmed converted; placement from skilleffect `SYSTEM_CH_HWANMODE` rows]:
- `system/system_hwan_motion.efp` (ACT_S, activation burst on `Bip01`; uses the `levelup03` mesh) with sound `player\hwanchange.wav`;
- `system/system_hwan_keep.efp` (ACT_L loop on `Bip01 Spine`, script `SCT_MAT,64,16,0,140,32,0,1000`) and `system_hwan_keep_s.efp` (ACT_L loops on both upper arms, `Bip01 L HandMid`, `Bip01 R Finger2` and both calves; script `SCT_CHAR_SCALE,1.1,1000`: the character grows to 1.1× [likely]);
- `system/system_hwan_disappear.efp` (DEACT, end) with sound `player\hwanreturn.wav`;
- `hiteffect/hit_4_hwan.efp` (the aniset DamageEfp while berserk), weapon trail 160 `200,255,255,255` `mirage_texture_hwan.ddj`.
- `hwanchange.wav` / `hwanreturn.wav` exist in `Data/prim/snd/player/` but are **not exported** (`work/out/sound/player/` has only `bathwanhit`, `bathwancrihit`) [confirmed]: the EXP lane adds cues `berserk.start` / `berserk.end`.
- EFFECTS §3.9 describes the same rows and suggests carrying Berserk as an `EffectState` with skill `SYSTEM_CH_HWANMODE`. This spec keeps `EntityState.berserkMs` (no fake skill row; §5.2) and asks EFFECTS FX-C2's `world/fx/system-fx.ts` for a `play('SYSTEM_CH_HWANMODE', view)` / `stop()` API, which `world/features/berserk.ts` calls. The two specs must agree on this in the FC pass.

**Hair models** [confirmed files; likely use]: `res/char/china/chinaman_hwan_hair.bsr`, `chinawoman_hwan_hair.bsr`, and clip `prim/ani/char/china/man/hwan_hair.ban` (also under `woman/`). Not converted yet (`work/out/char/china/` has none) [confirmed]; the EXP lane runs `pnpm sro convert` on both.

**Sounds** [confirmed exported]: `effectsound` PLAYER `SND_DMG` / `SND_CRIDMG` event `HWAN` → `player/bathwanhit.ogg`, `bathwancrihit.ogg`; `SND_SWING3 HWAN` per weapon → `hwswordswing` (sword, blade), `hwbladeswing` (spear, glaive), `hwbowswing` (bow).

`battle/hwan_{b,r}{c,s,w}{s,m,b}.efp` use `exp.png` / `sp.png` textures. They are the EXP / SP gain orbs, **not** Berserk [likely]; note for the VFX spec.

### 5.2 Rules (server module `berserk.ts`)

**State.** Points 0–5 (persisted: `characters.hwan_points`) and `berserkUntil` (runtime; logout ends berserk). `Player` (world.ts) has no such fields [confirmed]; `berserk.ts` keeps both in its own map keyed by player id, loads the points in `enter` and drops them in `forget`, and `Gameplay.stats(p)` reads `this.berserk.points(p)`.

**Gain** (hook `mobDied(m, now, credit)`): for each credited player who is alive, not berserk and below 5:

| Mob variant | Points |
|---|---|
| normal | 1 with `HWAN_KILL_PCT` = **12 %** |
| champion | 1 (always) |
| giant, elite, party | 2 |
| unique | 5 (fills) |

[decision; retail unknown.] Normal kills alone fill the gauge in about 40 kills.
- The owner gets `statsDelta {stats: {hwan}}`. Party members roll each for their own credit.
- GM `/kill` (rewards off) gives nothing.

**Activation.** `berserk {}`. Validation:
- alive (`dead`);
- `hwan === 5` (`berserk_not_ready`);
- not berserk (`berserk_active`);
- not mounted (`mounted`) [decision].

A running skill action is **not** interrupted; berserk is instant.

**Effect**, for `HWAN_DURATION_MS` = **60,000** [unknown; config]:
- `hwan = 0`;
- physical and magical damage **+100 %** (the mods `physDamagePct`/`magDamagePct` +100 → ×2 in `damageRoll` step "× (1 + pct/100)");
- move speed **+100 %** (`speedPct` +100, stacking additively with Grass Walk as other speed mods do);
- through the SkillEngine mod-provider seam (§6.4), then `refresh(p)` → `stats`.

**End.** At `berserkUntil`, or on death, warp to town or logout: mods off, `refresh` → `stats`, `entityUpdate {berserkMs: 0}`.

**Messages.**
- Activation: `actionResult ok` → `entityUpdate {id, berserkMs: 60000}` to viewers → `statsDelta {hwan: 0}` → `stats`.
- Hits dealt while berserk carry `CombatHit.hwan?: true` (optional flag), so clients pick the HWAN hit effect and sound without tracking state.

### 5.3 Client

- **Gauge** (`hud/berserk.ts`, drawn on the player frame by the UI rework's frame component; `hud/player.ts` belongs to UI-H, and docs/UI.md §9.1 schedules "the orbs and button in `hud/player.ts` (after UI-H)", so BZ asks UI-H for a `PlayerFrame.orbSlot()` mount point and keeps its code in `hud/berserk.ts`):
  - 5 orbs (`pmi_jahwan` pips) arcing around the portrait, lit up to `stats.hwan`;
  - each new point flashes that orb;
  - at 5, the ring pulses with `pmi_jahwan_glow` and the Berserk button (`pmi_jahwan_button`) appears;
  - while active, `pmi_jahwan_burn` and a 60 s countdown ring around the portrait.
- **Key.** `hud.keys.register({id: 'combat.berserk', keys: ['tab'], group: 'combat', label: 'key.berserk', run: send berserk})`. The KeyMap itself calls `ev.preventDefault()` on every matched keydown and skips typing targets and open modals [confirmed `hud/keys.ts:112-115`], so Tab neither moves DOM focus nor fires from chat; the run needs nothing extra. Tab is not bound today [confirmed]. The button click sends the same request. A refusal shows the reason line ("Your Berserk gauge is not full.").
- **World** (`world/features/berserk.ts`, an entity attachment on players with `berserkMs > 0`):
  - `system_hwan_motion` once at activation (on `Bip01`);
  - `system_hwan_keep` looped on `Bip01 Spine` and `system_hwan_keep_s` on the six limb bones for the duration (§5.1);
  - the hwan hair mesh replaces the hair slot (after the equipment compose path: `@sro/appearance`);
  - `system_hwan_disappear` at the end.

  Hits with `hwan: true` play `hit_4_hwan` plus `player/bathwanhit` (`bathwancrihit` on crit), and the attacker's swing uses the HWAN swing sound. Late joiners read `EntityState.berserkMs`.

---

## 6. Shared pieces

### 6.1 Config knobs (`apps/server/src/config.ts`, env names, defaults)

| Knob | Default | Range | § |
|---|---|---|---|
| `COS_COMBAT_LOCK_MS` | 20000 | 0–600000 | 1.3 |
| `COS_PARK_RANGE_M` | 60 | 5–500 | 1.3 |
| `MOB_SKILL_DAMAGE` | `relative` | relative / retail / flat | 2.6 |
| `MOB_DAMAGE_RATE` | 1 | 0–10 | 2.6 |
| `MOB_SUMMONS` / `MOB_SUMMON_CAP` | 0 / 6 | 0–1 / 0–30 | 2.2 |
| `DUR_WEAPON_LOSS_PCT` / `DUR_ARMOR_LOSS_PCT` / `DUR_SHIELD_LOSS_PCT` | 5 / 5 / 10 | 0–100 | 3.2 |
| `DUR_WARN_PCT` | 10 | 0–100 | 3.2 |
| `ALCHEMY_RATE` | 1.5 | 0–10 | 4.3 |
| `ALCHEMY_MAX_PLUS` | 10 | 1–12 | 4.3 |
| `ALCHEMY_FUSE_MS` | 3000 | 0–30000 | 4.4 |
| `ALCHEMY_DESTROY` | 0 | 0–1 | 4.3 (1 = retail: from +5 a failure destroys the item with 10 % chance; phase 2) |
| `ELIXIR_DROP_PCT` / `ELIXIR_DROP_MIN_LEVEL` | 0.8 / 5 | 0–100 / 1–120 | 4.5 |
| `HWAN_KILL_PCT` | 12 | 0–100 | 5.2 |
| `HWAN_DURATION_MS` | 60000 | 1000–600000 | 5.2 |

### 6.2 Database (one append-only migration, numbered by the integrator after any other wave-6 migrations)

```sql
-- combat & items (docs/SYSTEMS_COMBAT.md §6.2)
ALTER TABLE characters ADD COLUMN hwan_points INTEGER NOT NULL DEFAULT 0 CHECK (hwan_points BETWEEN 0 AND 5);
CREATE TABLE char_mount (
  character_id INTEGER PRIMARY KEY REFERENCES characters(id),
  code TEXT NOT NULL,                 -- CosDef.code, e.g. COS_C_HORSE1
  hp INTEGER NOT NULL CHECK (hp >= 1),
  mounted INTEGER NOT NULL DEFAULT 1 CHECK (mounted IN (0, 1))
);
```

Durability and plus already live in `items.durability` / `items.plus` and `storage_items` [confirmed].

### 6.3 Content additions (`packages/shared/src/content.ts`, all additive)

```ts
export type ItemCategory = /* existing */ | 'alchemy'

export interface ItemUse {
  /* existing fields */
  /** Horse items: the CosDef code summoned (itemdata Param1 Desc, e.g. COS_C_HORSE1). */
  summon?: string
  /** Recovery Kits: 'mount' = the effect applies to the user's horse, not the user. Absent = self. */
  target?: 'mount'
}

export interface ItemDef {
  /* existing fields */
  /** +1 increments (itemdata cols 67, 70, 73, 78, 81, 99, 104, 115): added x plus to the worn item's stat. */
  perPlus?: Partial<Record<'physAttack' | 'magAttack' | 'physDefence' | 'magDefence' | 'parryRate' | 'physAbsorb' | 'magAbsorb' | 'hitRate', number>>
  /**
   * Alchemy materials (TypeID 3/3/10/x). elixir: `targets` = equipment TypeID3 it fits (Param1 bytes, zero bytes dropped);
   * powder: `degree` = Param1 (col 118, 1..12), compared with the equipment's ItemDef.degree. The powder's own
   * ItemDef.degree is ceil(class/3) = 1 for the 1st-3rd powders and must not be used. `rates[i]` = percent for target
   * plus i + 1 (Param2-4 bytes, big-endian, 12 values).
   */
  reinforce?: { kind: 'elixir' | 'powder'; targets?: number[]; degree?: number; rates: number[] }
}

/** cos.json: ContentFile<CosDef> (kind 'cos'; CONTENT_FILES.cos = 'cos.json'). characterdata TypeID 1/2/3/1. */
export interface CosDef {
  /** client: CodeName128 (col 2), e.g. COS_C_HORSE1. */
  code: string
  id: number
  name: string | null
  /** client: Lvl (57), MaxHP (59). */
  level: number
  hp: number
  /** m/s (cols 46/47 x 0.1): 4.5 / 9.0 for the Red Horse. */
  walkSpeed: number
  runSpeed: number
  /** metres (BCRadius col 50 x 0.1). */
  radius: number
  physAbsorb: number
  magAbsorb: number
  parryRate: number
  hitRate: number
  model: ModelRef | null
  /** client: AssocFileIcon128 (col 54), e.g. /out/icon/cos/cos_c_horse1.png. */
  icon: string | null
}
```

`SkillDef` gains `mob`, `aiChance`, `summon` (§2.4). `MobDef` gains `attacks?` in its type. `NpcDef.roles` may hold `'repair'`. `perPlus` and `reinforcePct` are already in `items.json` [confirmed] but in neither `ItemDef` type [confirmed]; the client reads `perPlus` untyped today (`hud/items.ts:167`). `CONTENT_FILES` gains `cos: 'cos.json'`, and `ContentKind` follows from it.

### 6.4 Server seams (the foundation step adds them; lanes fill them)

| Seam | Where | What |
|---|---|---|
| Modules | `gameplay.ts` constructor | `this.mobSkills = new MobSkills(this)`, `this.mounts = new Mounts(this)`, `this.durability = new Durability(this)`, `this.repairs = new Repairs(this)`, `this.alchemy = new Alchemy(this)`, `this.berserk = new Berserk(this)` are added to `modules` (the `handles` of each route their requests). |
| Mob swing | `Gameplay.swing(m, target)` | `this.mobSkills.swing(m, target, this.now)` instead of `this.attack(m, …)`. Add `AiHost.ranged?(m, target, dist)` to ai.ts's chase branch. |
| Mob busy | `Gameplay.tick` mob loop | `if (this.mobSkills.busy(m, now)) continue` next to the `skills.held` check. |
| Hit redirect | `Gameplay.dealHits` top | `t = this.mounts.redirect(t, extra)` (a mounted player → its horse unless `extra.dot`; a `Cos` target branch applies HP and death). `dealHits`' `t` type widens to `Player \| Mob \| Cos`. |
| DoT flag | `dealHits` `extra` type + `SkillEngine.tickEffect` (`skills/engine.ts`) | `extra.dot?: true`, set only by the burn/poison tick call [confirmed that call passes `{skill}` today]. |
| Wear | `Gameplay.dealHits`, after the hits are applied | `this.durability.afterHits(a, t, hits, extra, now)` (skips `extra.dot`). |
| Worn stats | `Gameplay.combatFor` → `formulas.playerCombatStats(level, str, int, worn)` | `worn` already carries `stack`, but the loop reads only `def.stats` [confirmed `formulas.ts:122`]. The formula adds `perPlus × plus` and skips `durability === 0`. |
| Mod providers | `SkillEngine.modsFor(p)` | `sumMods([...passive, ...active, ...this.providers.flatMap((f) => f(p))])`, with `SkillEngine.addModProvider(fn: (p: Player) => StatMod[])` [confirmed `modsFor` = `sumMods([...passiveMods, ...activeMods])` today]. Mounts (speed: a new multiplicative `ModStat` in `skills/mods.ts`, folded in by `applySpeed`, and buff speed ignored while mounted) and Berserk register. |
| Status from others | `SkillEngine` | Today `private applyStatus(source, t, roll: StatusRoll, now)` and `private rollStatuses(row, t, hit)` [confirmed]. Both become public (same signatures; `applyStatusRoll` in the first draft is dropped). |
| Refusals | `Gameplay.attackRequest`, `Gameplay.tickAction` (the auto-attack swing) and `SkillEngine.plan` | `this.mounts.refuse(p, 'attack')` → `mounted`; `this.durability.refuse(p, 'attack' \| row)` → `broken`. One-line checks at the top of `attackRequest` and `plan`, and before `this.attack(p, t, now)` in `tickAction` (which then clears `p.action` and sends the broken-weapon line). |
| Item use | `ItemUses.use` (`item-use.ts:75`) | `if (use.summon \|\| use.target === 'mount') return this.g.mounts.useItem(p, def, bag, answer, now)`, after the cooldown check and before the `returnToTown` branch. EFFECTS FX-S also edits this file (the P3 `itemEffect` broadcast). |
| Equip check | `equipItem()` in `apps/server/src/inventory.ts` (called from `Gameplay.request` `'itemEquip'`) | Refuse `broken` when the bag item's `durability === 0` [the first draft named a non-existent `equip()` in gameplay.ts]. |
| NPC service | `npc.ts` `has(…, 'repair')`, `servicesOf` | `case 'repair'` returns true when the NpcDef roles include `'repair'` (today `return false`); `servicesOf`' list gains `'repair'` (SOCIAL adds `'guild'` to the same list). |
| Cos entity | `apps/server/src/world.ts` | `Entity` union += `Cos`; a `cos` map in `addEntity` / `removeEntity` / `allEntities`; a `baseState` branch (`kind: 'cos'`, `owner`, `hp`, `maxHp`, `rider`); `PlayerAction` += `{kind: 'board'; cos; chaseAt; chaseTo}`. Not in the first draft's owned lists. |
| Mob skill state | none | `MobSkills` keeps `skillReadyAt` / `busyUntil` / the pending cast in its own map (no `Mob` field). |
| Enter world | modules' `enter` | Mounts re-create the saved horse. Berserk loads the points (they go out in `stats`). |
| World info | `connection.ts:443` (`worldEnter.world`) | Adds `alchemyRate`, `alchemyMaxPlus` next to `levelCap`; SOCIAL adds `social` on the same line. |
| Stats | `Gameplay.stats(p)` | Adds `hwan: this.berserk.points(p)`. |
| Extra loot | `Gameplay.mobDied` after `rollDrops` | `drops.push(...this.alchemy.extraDrops(m))` (the authored elixir roll; `rollDrops` returns a plain array [confirmed]). EFFECTS FX-S edits the loop right below (`dropFrom`). |
| GM | `gm.ts` COMMANDS | `horse`, `hwan`, `dur`, `plus`, `mobskill` entries that call module functions (like `skill` → `gm-skill.ts`). None collides with the 18 existing commands [confirmed]. |

### 6.5 Client seams

These files are shared with SOCIAL (SOC-FC, docs/SYSTEMS_SOCIAL.md §9.1), EFFECTS (FX-0, docs/EFFECTS.md §6.1) and UI (UI-H/UI-W, docs/UI.md §9.1). Their seam lines land in **one shared client-seam pass** (§8 F6-FC), never from a feature lane.

| Seam | Where |
|---|---|
| Features | `world/features.ts` WORLD_FEATURES: `mountFeature`, `berserkFeature`, `durabilityFeature` (warnings and cursor), `alchemyFeature` (window wiring). SOC-FC appends its three in the same pass. |
| Chat commands | `world/features.ts` `WorldFeature.onChatCommand?(text): boolean` + one call in the `screens/world.ts` chat send path (§1.5; shared with EFFECTS `/sitdown`, emotes). |
| Entity kind | `world/entities.ts`: a factory registry `registerEntityKind('cos', factory)` so `world/mount-view.ts` supplies the horse view (the catalog `cos()` model, name label "Red Horse", HP bar for the owner only). The rider pose uses the idle override `EntityView.setIdle` that SOC-FC and EFFECTS FX-0 both add (`BaseClip` += `'SIT'`); horses need a clip-group switch (`cart`) and a parent-to-bone call on the same API. |
| Catalog | `content/catalog.ts`: `cos(code)`, loading `/out/data/cos.json`. |
| Mob casts | `world/skills-view.ts` and `world/skill-fx.ts` accept mob casters (§2.5). **Owned by EFFECTS FX-C1**, not by this spec. |
| NPC service | `hud/shop-logic.ts` `dialogOptions` order += `'repair'`; `hud/npc-dialog.ts` `choose()` → SOCIAL's `registerNpcService` registry (§3.4). |
| HUD | None in `hud/index.ts`: features build their windows on `hud.layer` and claim their `actionResult`s with `hud.claimRequests([...])` [confirmed pattern `world/features/party.ts:371`, `:435`]. The horse frame and Berserk orbs mount on UI-H's player frame; the repair buttons on UI-W's shop window (requests, §3.4, §5.3). |
| i18n | `i18n/en-systems-combat.ts` (new), merged in `i18n/en.ts` (one import line, as SOCIAL does for `en-social.ts`). |

---

## 7. Protocol additions (wave 6, `packages/shared/src/protocol.ts` + `validate.ts`)

Every addition is additive. The server and client deploy together, as in waves 3–5.

### 7.1 Types

```ts
export type EntityKind = 'player' | 'mob' | 'npc' | 'item' | 'cos'

export interface EntityState {
  /* existing fields */
  /** Players: entity id of the horse being ridden; absent = on foot. */
  mount?: number
  /** Cos: entity id of its rider; absent = parked. (`owner` = the owning player's entity id, `hp/maxHp` = horse HP.) */
  rider?: number
  /** Players: berserk time left at send time (ms, 1..600000); absent = not berserk. */
  berserkMs?: number
}

export interface CombatHit {
  /* existing fields */
  /** The attacker was in berserk (hit effect / sound). */
  hwan?: true
}

export interface PlayerStats {
  /* existing fields */
  /** Berserk points 0..5 (absent from older servers = 0). */
  hwan?: number
}
// validate.ts playerStats() walks PLAYER_STAT_KEYS and DROPS unknown keys [confirmed validate.ts:715-725]; a full `stats`
// must carry every listed key. So `hwan` goes into PLAYER_STAT_KEYS (the server always sends it) with a 0..5 bound,
// and combatHit() gains the `hwan` flag; otherwise the client never sees either.

/** A repair target. */
export type RepairRef = { equip: EquipSlot } | { bag: number }

export type AlchemyOutcome = 'success' | 'fail' | 'cancelled'
```

### 7.2 Client → server (each is a `GameplayRequest`: exactly one `actionResult`)

| t | fields | budget /s (burst) |
|---|---|---|
| `mountRide` | `cos: int` | 2 (5) |
| `mountDismount` | — | 2 (5) |
| `mountDismiss` | — | 2 (5) |
| `repair` | `npc: int`, `items?: RepairRef[]` (1..16; strict keys `{equip}` xor `{bag}`) | 2 (5) |
| `alchemyReinforce` | `item, elixir: bag index`, `powder?: bag index` (all distinct) | 2 (5) |
| `alchemyCancel` | — | 2 (5) |
| `berserk` | — | 2 (5) |

- `itemUse` is unchanged: it now also summons a horse and uses Recovery Kits.
- `whileDead`: `mountDismiss`, `alchemyCancel`.
- SOCIAL's inventory lock (`gate`, an allowlist, docs/SYSTEMS_SOCIAL.md §2.3) refuses all seven requests while the player trades (`trading`) or runs a stall (`stalling`). Nothing to build here; the H6 hunt checks it.
- Collisions: none of the seven names, the two server messages or the 11 reasons exists in `protocol.ts` today [confirmed], and none collides with SOCIAL's 27 requests / 11 reasons or EFFECTS' `sit`, `emote`, `itemEffect` [confirmed against both specs].

### 7.3 Server → client

| t | fields |
|---|---|
| `alchemyStart` | `item: bag index`, `readyInMs: 0..30000` |
| `alchemyResult` | `item: bag index`, `code: CodeName128`, `outcome: AlchemyOutcome`, `plus: 0..255` |
| `entityUpdate` (extended) | `mount?: int \| null` (null = dismounted), `rider?: int \| null`, `berserkMs?: 0..600000` (0 = ended) |
| `combat` (extended) | hits may carry `hwan: true`; mob skills now send `skill`, `instance`, `at`, `aoe` like player skills |
| `cast` / `castEnd` (extended use) | `id` may be a mob id (mob skills) |
| `statsDelta` / `stats` | `hwan` |
| `worldEnter.world` (extended) | `alchemyRate?: number` (the ALCHEMY_RATE, for the UI preview), `alchemyMaxPlus?: int` |

### 7.4 New `ActionFailReason` values

- `mounted`: not allowed while riding.
- `not_mounted`
- `moving`: dismount while moving.
- `in_combat`: the 20 s ride lockout.
- `cos_active`: a horse is already summoned.
- `broken`: a broken weapon or item.
- `nothing_to_repair`
- `alchemy_mismatch`
- `max_plus`
- `berserk_not_ready`
- `berserk_active`

Reused: `not_found`, `too_far`, `dead`, `busy`, `invalid_slot`, `not_usable`, `not_enough_gold`, `requirements`, `cooldown`, `rate_limited`. Clients show a localized line per reason (`i18n/en-systems-combat.ts`).

### 7.5 Message order (each request's `actionResult` first)

| Request | Order |
|---|---|
| summon (`itemUse`) | `actionResult` → `inventoryUpdate` → `spawn {cos}` → `entityUpdate {p.mount}` + `entityUpdate {cos.rider}` |
| `mountDismount` | `actionResult` → `stop {p}` → `entityUpdate {p.mount: null}` + `entityUpdate {cos.rider: null}` |
| `mountRide` (walk first) | `actionResult` → `move`s → `stop` → `entityUpdate` pair |
| `repair` | `actionResult` → `inventoryUpdate {bag?, equip?, gold}` → `stats`? |
| `alchemyReinforce` | `actionResult` → `alchemyStart` → (3 s) → `inventoryUpdate` → `alchemyResult` |
| `berserk` | `actionResult` → `entityUpdate {berserkMs}` → `statsDelta {hwan: 0}` → `stats` |
| mob skill | `cast` → (castMs) → `combat {instance}`×targets (at `at` for projectiles), or `castEnd` |

---

## 8. Build plan

Same shape as waves 3–5: **F6-FS** + **F6-FC** (foundation, serial) → lanes in parallel with disjoint files → **I6** integration → **H6** adversarial hunt → fixes.

**Wave-6 coordination** (three sibling specs are in flight: docs/SYSTEMS_SOCIAL.md, docs/EFFECTS.md, docs/UI.md). The shared files below get **one** protocol step, **one** server-seam pass and **one** client-seam pass for all four specs, as SOCIAL §10 already proposes. F6-FS/F6-FC are this spec's share of those passes, not separate agents editing the same files:
- protocol: `protocol.ts`, `validate.ts`, `content.ts` (SOC-P, FX-0, F6-FS);
- server seams: `gameplay.ts`, `modules.ts`, `db.ts`, `config.ts`, `npc.ts`, `gm.ts`, `connection.ts` (SOC-FS, F6-FS), `item-use.ts` (FX-S, F6-FS);
- client seams: `world/features.ts`, `world/entities.ts`, `three/models.ts`, `hud/npc-dialog.ts`, `hud/shop-logic.ts`, `screens/world.ts`, `i18n/en.ts` (SOC-FC, FX-0, F6-FC);
- UI-owned (never edited by this spec's lanes; requests only): `hud/player.ts`, `hud/shop.ts`, `hud/slots.ts`, `hud/items.ts`, `hud/inventory.ts`, `hud/index.ts`, `ui/kit/**` (UI-H, UI-W, UI-K);
- EFFECTS-owned (requests only): `world/skills-view.ts`, `world/skill-fx.ts` (FX-C1), `world/drops.ts`, `world/fx/system-fx.ts` (FX-C2), `packages/convert/src/fx/skills.ts`, `gltf/output.ts` `PRESETS` (FX-X);
- hot right now (uncommitted edits in the working tree, git status): `gameplay.ts`, `gm.ts`, `npc.ts`, `world/entities.ts`, `hud/index.ts`, `hud/player.ts`, `packages/convert/src/data/npcs.ts`. Every seam pass rebases on those first.
- Migration number: the schema is v7 [confirmed `db.ts` MIGRATIONS]; SOCIAL's and this spec's migrations are appended in landing order by the integrator.

Rules:
- Every lane runs `pnpm vitest run <its tests>` and `pnpm typecheck` (`tsc -p tsconfig.json --noEmit`, the repo script [confirmed package.json; docs/WAVE_PLAN.md uses it]) before handing over.
- Lanes never edit a file they do not own. A needed change in another file goes to the integrator (or the owning lane of a sibling spec) as a one-line request.

### F6-FS: server and shared foundation (this spec's share of the shared P + FS passes; about 1 day)

**Owns (seam lines only in shared files):**
- `packages/shared/src/protocol.ts`, `validate.ts`, `content.ts`, `content-check.ts` (§6.3, §7);
- `apps/server/src/db.ts` (the migration, and load/save of `hwan_points` and `char_mount`);
- `apps/server/src/config.ts` (the §6.1 knobs);
- `apps/server/src/world.ts` (the `Cos` entity and the `'board'` action, §6.4);
- `apps/server/src/inventory.ts` (`equipItem` broken check);
- `apps/server/src/skills/mods.ts` (the mount speed `ModStat`);
- `apps/server/src/connection.ts` (`worldEnter.world` fields);
- **one-line seams** in `gameplay.ts`, `ai.ts`, `skills/engine.ts`, `item-use.ts`, `npc.ts`, `formulas.ts`, `gm.ts` (§6.4);
- **stub modules**, each with `name`, `handles` and a `request()` answering `not_implemented`: `apps/server/src/{mob-skills,mounts,durability,repair,alchemy,berserk}.ts`.
- Not `modules.ts`: nothing changes there for this spec (SOC-FS adds `gate`).

**Tests:**
- `packages/shared/test/protocol-wave6.test.ts`: round-trip every new message, strict keys, bounds, `RepairRef` xor, the new reasons, `stats.hwan` kept (and required in a full `stats`), `CombatHit.hwan` kept;
- `apps/server/test/migrate-wave6.test.ts`: a v7 DB migrates; the columns exist;
- `apps/server/test/formulas-wave6.test.ts` (new): `perPlus × plus` and broken-item cases of `playerCombatStats`. There is no `formulas.test.ts` [confirmed]; today's formula tests live in `gameplay-units.test.ts` and `balance.test.ts`, which stay unchanged.

**Done when:** every existing test passes unchanged.

### F6-FC: client foundation (this spec's share of the shared client-seam pass with SOC-FC and FX-0)

**Owns (seam lines only):** `world/features.ts` (4 features + `onChatCommand`), `screens/world.ts` (the chat-command call), `world/entities.ts` (`registerEntityKind`; clip-group switch and parent-to-bone on the `setIdle` API that SOC-FC/FX-0 add), `hud/shop-logic.ts` + `hud/npc-dialog.ts` (`'repair'` through SOCIAL's `registerNpcService`), `i18n/en.ts` (one import line), `content/catalog.ts` (`cos()` returning null).
**Creates:** stubs `apps/game/src/world/features/{mount,berserk,durability,alchemy}.ts`, `apps/game/src/i18n/en-systems-combat.ts` (keys only).
**Tests:** `apps/game/test/seams-combat.test.ts` (new): a feature's `onChatCommand` consumes `/dismount`; an unregistered entity kind is ignored; `dialogOptions(['shop','repair'])` lists repair.

### Lane EXP: exporter (packages/convert)

**Owns:**
- `packages/convert/src/data/items.ts`: scope + classification;
- `packages/convert/src/data/cos.ts` (new);
- `packages/convert/src/data/skills.ts`: `buildMobSkills`;
- `packages/convert/src/data/npcs.ts`: the `'repair'` role;
- `packages/convert/src/data/content.ts`: wiring `cos.json` + the mob skill rows;
- `packages/convert/src/sound/build.ts`: cues `cos.horse.*` and `berserk.start` / `berserk.end` (`player\hwanchange.wav`, `hwanreturn.wav`). The break/warning cues already exist (`ui.eqbreak`, `ui.eqdanger`, §3.1);
- `packages/convert/test/data-systems-combat.test.ts` (new).
- **Not owned** (first draft): `fx/skills.ts` (EFFECTS FX-X builds the MSKILL groups) and `gltf/output.ts` (EFFECTS FX-X `PRESETS.fx` has the bandit arrow). Models are converted by running `pnpm sro convert res/cos/c_horse1.bsr res/item/etc/drop_reinforce_recipe.bsr res/item/etc/drop_reinforce_prob_up.bsr res/char/china/chinaman_hwan_hair.bsr res/char/china/chinawoman_hwan_hair.bsr` (no code change).
- **Shared line:** SOCIAL §8 wants `ItemDef.canTrade` from itemdata col 16 "in `export-data.ts`, where `canSell`/`canDrop` are read", but `canSell` is read in `data/items.ts:183` [confirmed]. That line therefore lands in this lane's `items.ts`: EXP adds it on SOCIAL's behalf, or the integrator sequences the two edits.

**Work:**
1. **Item scope.** Add `ITEM_COS_C_HORSE1`, `ITEM_ETC_COS_HP_POTION_0[1-3]`, `ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_(WEAPON|SHIELD|ARMOR|ACCESSARY)_A`, `ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_0[1-3]` to `CONSUMABLE_CODE`-style code patterns in `isExportedItem` (by code: the degree filter alone would let powders `_04.._09` through, §4.5).
   - Classification (`classifyItem`, `CONSUMABLE_BY_TID3` has no entry for 10 today [confirmed]): 3/3/10/x → `'alchemy'` with `reinforce` (Param1 bytes → `targets`, zero bytes dropped; powders: Param1 → `reinforce.degree`; Param2–4 big-endian → `rates[12]`); 3/3/3/2 → `'scroll'` (already `CONSUMABLE_BY_TID3[3]`) with `use.summon` = Desc1 (col 119, `COS_C_HORSE1`; col 118 Param1 is 0 on horses [confirmed]); 3/3/1/4 → `'potion'` with `use.hp` = Param1, `use.target 'mount'`, `cooldownGroup 'cos_hp'` (`POTION_GROUP_BY_TID4` has no 4 [confirmed]).
   - Elixir `_A` icons: map the missing `archemy_reinforce_recipe_a.ddj` to the per-kind `_b` icon (§4.1).
   - Put `perPlus` into the typed field (it is already written).
2. **`cos.json`** from characterdata `COS_C_HORSE1` (id 2191, TypeID 1/2/3/1; every COS row whose summon item is in scope).
3. **MSKILL rows** into `skills.json` (§2.4): `mob`, `aiChance`, `summon` resolved by characterdata id; `damage` dropped on `pct 0, flat 0-0` rows (§2.3).
4. **Shops.** `STORE_CH_STABLE` TAB1 + TAB4 and `STORE_CH_ACCESSORY` TAB3 (powders only) now survive the scope filter. `NPC_CH_HORSE` gets its shop.
5. **Roles.** `'repair'` on `NPC_CH_SMITH` and `NPC_CH_ARMOR`.
6. Re-run `pnpm tsx packages/convert/src/tools/export-data.ts` (icons included) [confirmed docs/DATA.md], `pnpm sro convert …` (the models above) and `pnpm tsx packages/convert/src/tools/export-sound.ts`. `drops.json` gains the port elixir entries (level-15+ mobs, `_A` codes through `itemmap-tam.json`; §4.5).

**Tests (asserting the numbers in this doc):**
- Red Horse: reqLevel 10, price 1200, `use.summon` `COS_C_HORSE1`;
- `cos.json` Red Horse: hp 983, runSpeed 9, radius 1.2;
- Elixir(Weapon) `reinforce.targets [6]`, `rates[0..3] = [25, 20, 15, 10]`, `rates[8..11] = [10, 5, 5, 5]`; Elixir(Protector) `targets [1, 2, 3]`; Lucky Powder(1st) `reinforce.degree 1`, `rates[0] = 50`; Lucky Powder(2nd) `reinforce.degree 2` while its `ItemDef.degree` is 1;
- Elixir icons are not null (the `_b` fallback);
- `MSKILL_CH_TIGERWOMAN_ATTACK02` `aiChance 30`, area caster 4 m 5 targets;
- `MSKILL_CH_WATERGHOST_ATTACK02` status poison level 34;
- Mangyang ATTACK02 `damage.hits 2`, `hitCues` 2;
- `STORE_CH_STABLE` has the Red Horse;
- `NPC_CH_SMITH` roles include `repair`;
- `drops.json` Bandit (16) contains `…RECIPE_WEAPON_A`.

**User-visible check:** none on its own. `pnpm sro …` export report lists the new counts.

### Lane MS-S: monster skills, server

**Owns:** `apps/server/src/mob-skills.ts`, `apps/server/src/ai.ts` (the `ranged` hook body), `apps/server/test/mob-skills.test.ts`.

**Work (§2.2–2.3, §2.6):**
- pick by weight with per-skill cooldowns;
- the busy window;
- releases with dodge slack;
- areas over players;
- projectiles;
- statuses via the now-public `skills.rollStatuses` / `skills.applyStatus`;
- the `MOB_SKILL_DAMAGE` modes;
- summons behind `MOB_SUMMONS`;
- `/mobskill <mob id> <skill code>` (forces the next swing; the command entry is F6-FS's `gm.ts` seam, the body lives in `mob-skills.ts`).

**Tests (fake host, seeded rng):**
- Tiger Girl's pick frequencies over 10,000 swings (71/21/7 % ± 2);
- a castMs 1383 archer shot lands at `at` = release + distance / 40 m/s; a Tomb Stone force bolt at release + distance / 20 m/s;
- stepping 2 m out of a melee cast's reach before release → `castEnd target_lost`;
- a stun before release → `interrupted`;
- the Black Tiger (`MOB_CH_WHITETIGER_CLON`) howl hits 3 players within 2 m and not one at 3 m;
- Water Ghost gas applies poison, 0 damage (its exported `damage` is all zeros, §2.3);
- `relative` mode: Mangyang ATTACK02 = 2 × 50 %; Black Tiger ATTACK01 = 2 × 50 % (today's total) and its howl = 1 × 200 %;
- `retail` mode: ATTACK01 = 200 %;
- the busy window stops the mob moving;
- a mounted target's hits land on the horse (with MR-S merged: in I6).

**User-visible checks (§8.1 M1–M4).**

### Lane MS-C: monster skills, client (folded into EFFECTS FX-C1)

The first draft gave this lane `world/skills-view.ts` and `world/skill-fx.ts`. EFFECTS lane FX-C1 owns both in the same wave (docs/EFFECTS.md §6.4) and already plans mob attacks with their aniset clip and stages. Two lanes cannot own them, so MS-C is **not a lane**: its items are FX-C1 requirements, delivered by the integrator as a list:
- mob casters through the `cast` path (READY/WAIT/SHOT from `SkillDef.animation`, `castEnd` cancels);
- stage effects on mob bones; the bandit arrow; the Tomb Stone and Yeoha force bolts (§2.1);
- blood efp per mob (skilleffect characterInfo col 9 via the fx index);
- the clip fallback for the three `_clon` gaps (§2.1);
- the fallback kept for combat without an instance.

**Owns:** `apps/game/test/mob-skill-view.test.ts` only, written against FX-C1's API after it lands: a mob `cast` + `combat {instance}` schedules the hits at the ATTACK2 events (821 / 1381 ms); `castEnd` stops the clip; a Black Tiger howl (no ATTACK3 on its model) plays ATTACK1 and still shows the hit.

### Lane MR-S: horses, server

**Owns:** `apps/server/src/mounts.ts`, `apps/server/test/mounts.test.ts`.

**Work (§1.3):**
- summon via `useItem`;
- ride (walks with `approach`), dismount, dismiss;
- the redirect;
- horse death;
- parked-horse rules;
- speed and radius via the mod provider;
- persistence (`char_mount`);
- Recovery Kits;
- `/horse`.

**Tests:**
- summon consumes one item and mounts (`EntityState.mount` set);
- summon at level 9 → `requirements`;
- within 20 s of combat → `in_combat`;
- a second summon → `cos_active`;
- attack while mounted → `mounted`;
- `mountDismount` while moving → `moving`;
- a mob's hit on a mounted player lowers the horse's HP, not the player's; a poison tick on the rider lowers the rider's HP (`extra.dot`);
- the horse dies at 0 → the player is dismounted;
- speed ×1.8 (a 9.9 m move takes 1 s at MOVE_SPEED 5.5);
- relog restores a mounted horse with the saved HP;
- the parked horse is dismissed at 61 m;
- a Recovery Kit heals 360.

### Lane MR-C: horses, client

**Owns:**
- `apps/game/src/world/features/mount.ts`;
- `apps/game/src/world/mount-view.ts` (new): horse view, rider parenting, `cart` group;
- `apps/game/src/hud/mount-frame.ts` (new, built on the UI kit; mounted under the player frame through a UI-H mount point, docs/UI.md §9.1 "the pet frame in `hud/player.ts` (after UI-H)");
- `apps/game/src/content/catalog.ts` (`cos()` body, after F6-FC's stub);
- `apps/game/test/mount.test.ts`.
- **Not** `world/entities.ts` (first draft): SOC-FC, EFFECTS FX-0/FX-C2 and the working tree all touch it. The horse view registers through F6-FC's `registerEntityKind('cos', …)` from `mount-view.ts`.

**Work (§1.5):** clicking your own horse sends `mountRide`; the auto dismount-then-attack sequence; the `/dismount` and `/unsummon` commands through `onChatCommand`; horse sounds.

**Tests:** the dismount-then-attack intent sequence; the horse view follows the rider; the frame shows HP.

**Checks H1–H5.**

### Lane DR: durability and repair (server + client)

**Owns:**
- `apps/server/src/durability.ts`, `apps/server/src/repair.ts`;
- `apps/game/src/hud/repair.ts` (new: buttons, hammer cursor, confirm);
- `apps/game/src/world/features/durability.ts` (warnings, the slot decorator registration, the `'repair'` NPC-service handler);
- `apps/server/test/durability.test.ts`, `apps/server/test/repair.test.ts`, `apps/game/test/repair.test.ts`.
- Requests, not edits: UI-K `Slot.setOverlay`; UI-W `ShopWindow.addFooterButton` and the tooltip `bad` class; F6-FS's `tickAction` / `equipItem` / `dealHits` seams.

**Work (§3.2–3.4).**

**Tests:**
- with the loss chance at 100 %, a weapon loses 1 per landed hit and never below 0;
- a miss costs nothing;
- at 0: `stats` drop the weapon's attack, `attack` → `broken`, a weapon skill → `broken`, a force skill still works; an auto-attack already running stops at its next swing;
- a poison tick wears no armour;
- equipping a broken item → `broken`;
- repair all at Chulsan: cost = Σ ceil(198 × missing / 76)…;
- not enough gold → nothing changes;
- a ring alone → `nothing_to_repair`;
- repair from 9 m → `too_far`;
- the Storage-keeper has no `'repair'` service;
- storage and buyback keep durability (regression).

**Checks D1–D4.**

### Lane AL: alchemy (server + client)

**Owns:** `apps/server/src/alchemy.ts`, `apps/game/src/hud/alchemy.ts` (new), `apps/game/src/world/features/alchemy.ts`, `apps/server/test/alchemy.test.ts`, `apps/game/test/alchemy.test.ts`.

**Work (§4.3–4.7):** includes the authored elixir drop (`extraDrops`), the ground-look request to EFFECTS FX-C2 (owner of `world/drops.ts`: drop models and their sidecar particles, §4.6), and `/plus <bag> <n>`.

**Tests:**
- success % table at `ALCHEMY_RATE` 1 (75 / 50 / 35 / 18 with a matching powder; 25 / 20 without);
- a degree-2 powder (`reinforce.degree 2`, `ItemDef.degree 1`) on a degree-1 sword → `alchemy_mismatch`; a 1st powder on it is accepted;
- the fuse is cancelled by a `moveTo`, and by an `attack` request (seen as `p.action` in `tickPlayer`);
- a weapon elixir on armour → `alchemy_mismatch`;
- a worn item → `invalid_slot`;
- a cancel during the fuse consumes nothing;
- moving the elixir away during the fuse → `cancelled`, nothing consumed;
- failure at +4 → +0, elixir and powder consumed;
- a +3 sword's `stats.physAttack` = base + 3 × 2.4 (rounded as `playerCombatStats` does);
- the cap: +10 → `max_plus`;
- the elixir drop rate over 100,000 simulated level-8 kills ≈ 0.8 % × DROP_RATE.

**Checks A1–A5.**

### Lane BZ: Berserk (server + client)

**Owns:** `apps/server/src/berserk.ts`, `apps/game/src/hud/berserk.ts` (new), `apps/game/src/world/features/berserk.ts`, `apps/server/test/berserk.test.ts`, `apps/game/test/berserk.test.ts`.

**Work (§5.2–5.3):** includes `/hwan <0-5>`. Requests, not edits: UI-H's player-frame orb mount point; EFFECTS FX-C2's `system-fx.ts` `SYSTEM_CH_HWANMODE` play/stop; the hwan hair through `@sro/appearance` once EXP has converted the two BSRs.

**Tests:**
- points by variant (unique fills);
- no gain while berserk;
- `berserk` at 4 → `berserk_not_ready`;
- activation zeroes the points and doubles a seeded hit's damage;
- speed ×2;
- the mods end at 60 s, and at death;
- Tab is registered as `combat.berserk` (the KeyMap test harness shows a Tab keydown in a chat input does nothing);
- a hit with `hwan: true` picks `hit_4_hwan`.

**Checks B1–B4.**

### I6: integration (one agent)

1. Merge the lanes and resolve the seam edits.
2. Run `pnpm test`, `pnpm typecheck` and a headless e2e on `jangan-fields` (`apps/server/test/combat-e2e.test.ts`, new, the `wave3-e2e` pattern): a bot summons a horse, rides to the Tiger Mountain, dismounts, fights a Black Tiger (`MOB_CH_WHITETIGER_CLON`, gets the howl), breaks and repairs a sword, enhances it to +2, fills Berserk with `/hwan 5` and activates it.
3. Re-run the docs/BALANCE.md model in `relative` mode and update its §6 table ("Difficulty curve").
4. Update PROTOCOL.md §11 (wave 6 rows) plus a new "Combat and items" section numbered after SOCIAL's §12 (content files move again), and PLAYTEST.md.
5. Hand EFFECTS FX-C1 the MS-C list, and check the three `_clon` fallbacks in the browser.

### H6: adversarial hunt (one agent, reads only, then files fixes)

Targets:
- dismount-while-moving races (`moveTo` + `mountDismount` in one tick);
- riding into a safe zone to dodge hits;
- a horse redirect with a dead or despawned horse; a DoT tick on a mounted rider (must hit the rider, not the horse);
- the `Cos` entity in interest management (spawn/despawn at view range while ridden, `positionAt` mid-move);
- repairing the same slot twice in one request;
- `alchemyReinforce` with the same bag index twice;
- swapping the target item during the fuse (re-validation);
- Berserk toggled at death;
- a GM-invisible player's horse;
- `ALCHEMY_RATE` > 100 clamp;
- mob summons with `MOB_SUMMONS` on and the cap;
- durability writes flooding the DB (one write per point lost only);
- a rate-limited `repair` spam;
- mob casts from a mob that despawns mid-cast (`castEnd`, no crash).

### 8.1 User-visible checks (for PLAYTEST.md)

**Horses (H):**
- **H1.** Stable-keeper Machun (`/tp 33 -45`) now has "Trade in the shop.": Red Horse 1,200 gold, Recovery Kits 190 / 400 / 720.
- **H2.** At level 10+, use the Red Horse from the bag: the horse appears under you, and you sit on it (`cart` pose) and run about twice as fast. At level 9 it is refused.
- **H3.** The rider sits in the saddle: not floating, not sunk. Stand, walk and run poses change with the horse's gait. The horse frame shows its HP.
- **H4.** Click a Mangyang while mounted: you step down and attack. Right after the fight, riding again is refused for 20 s ("Cannot board a transport for 20 seconds after the end of combat."). Walk away: the parked horse vanishes past 60 m.
- **H5.** Let a monster hit you while mounted: the horse's bar drops, yours does not. At 0 the horse dies and you land on your feet. A Recovery Kit heals the horse.

**Monster skills (M):**
- **M1.** Mangyang alternate a single chop (ATTACK1) and a double chop (ATTACK2, two numbers).
- **M2.** Bandit Archers draw for about 1.4 s, then an arrow flies and the number shows when it lands. Tomb Stone Ghosts (the level-8 Qin-Shi Tomb) wind up for about 1.3 s and throw a force bolt that you can see fly.
- **M3.** A Black Tiger's howl hits everyone within 2 m, with the howl effect around its chest (its model has no howl clip, so it plays its normal swipe). The Water Ghost's rare gas shows the green effect and a poison icon.
- **M4.** The Tiger Girl (`/spawn MOB_CH_TIGERWOMAN 1` with a GM) howls (area), curses from range (magic, zombie icon), and casts with a visible wind-up. Stepping out of melee during her 1.1 s wind-up makes the swing miss (`castEnd`).

**Durability (D):**
- **D1.** Tooltips show "Durability 76 / 76" (today a full item shows the roll range instead, see §3.4). After a long fight it drops.
- **D2.** `/dur weapon 0`: the weapon slot turns red, attacking says "Cannot attack because the weapon is broken", and the attack numbers in C fall.
- **D3.** At Blacksmith Chulsan or Mrs Jang, Repair all shows the total and repairs. A single repair with the hammer cursor works on a bag item.
- **D4.** A low item pulses red, and the warning icon appears by the player frame.

**Alchemy (A):**
- **A1.** Jinjin sells Lucky Powder (1st/2nd/3rd).
- **A2.** `/item ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A 5`, then right-click the elixir: the Alchemy window opens. Put a sword in, then a matching powder: the % shows.
- **A3.** Fuse: a 3 s spinning effect, then success (gold burst, sound) → "+1" on the sword and higher attack in C.
- **A4.** On a failure the sword returns to +0. The elixir and powder are gone either way.
- **A5.** Moving during the fuse cancels it and keeps everything.

**Berserk (B):**
- **B1.** Kill monsters: the orbs around the portrait fill one by one.
- **B2.** At 5 the ring glows, and Tab (or the button) activates it: red burst and aura, wild red hair, faster run, bigger numbers.
- **B3.** It ends after 60 s with the fade effect. The orbs are empty.
- **B4.** Tab with fewer than 5 orbs shows "Your Berserk gauge is not full."

---

## 9. Reference files kept (`work/tmp/systemsA/ref/`)

All are converted from Media.pk2 with `packages/convert/src/tools/ddj2png.ts`. They are references for the UI lanes; the game serves its own copies through the UI export.

| File | Source | Use |
|---|---|---|
| `alcm_window_reinforcement.png` | `interface/alchemy/alcm_window_reinforcement.ddj` 376×192 | Alchemy window layout |
| `alcm_window_1.png`, `alcm_window_2.png` | `…/alcm_window_1.ddj`, `…_2.ddj` | Description panel |
| `alcm_effect_prepare.png`, `alcm_effect_success.png`, `alcm_effect_fail_1.png` | `…/alcm_effect_*.ddj` 256×256 (4×4 frames) | Fuse and result sprite sheets |
| `alcm_slot_open.png`, `alcm_button.png` | `…/alcm_slot_open.ddj` 48×48, `alcm_button.ddj` 112×28 | Slots and buttons |
| `pmi_window.png` | `interface/playerminiinfo/pmi_window.ddj` 220×76 | Player frame with the 5 orb sockets |
| `pmi_jahwan.png`, `pmi_jahwan_glow.png`, `pmi_jahwan_burn.png`, `pmi_jahwan_face.png`, `pmi_jahwan_button.png` | `…/pmi_jahwan*.ddj` | Berserk orb, glow, active, button |
| `guide_whanmode.png` | `interface/image/guide_whanmode.ddj` 90×300 | What Berserk looks like (orbs → red aura and hair) |
| `broken.png`, `warning.png` | `interface/durabilityerror/*.ddj` (32×32, 128×64) | Broken overlay, low-durability pulse (16 glow cells of 16×16 plus an outline cell) |
| `cos_c_horse1.png`, `pmi_pet_face.png`, `pmi_pet_hp.png` | `icon/cos/cos_c_horse1.ddj`, `playerminiinfo/pmi_pet_*.ddj` | Horse frame |

---

## 10. Open questions

1. **Rider pose.** `cart` clips on the `saddle` bone are the likely retail rider pose. Only a render settles it (H3). If they look like a walking cart driver instead, the fallback is the `SIT` clip held on the saddle.
2. **Alchemy byte order.** Big-endian per-plus bytes (§4.3) are likely, not confirmed. A packet capture or a retail source of "+1 success with a matching powder" would settle it. `ALCHEMY_RATE` hides the risk.
3. **Berserk numbers.** Duration (60 s), damage ×2, speed ×2 and points per kill are knobs. A retail video with a timer would settle the duration.
4. **Durability wear rate and repair price formula** are ours (§3.2, §3.3).
5. **AI_AttackChance** (col 66) is read as a weight on attack rows and as an HP band on SUMMON rows. Col 67 (80 everywhere) is unexplained.
6. **Enchant glow** (`system_enchant_a_01` / `_b_01`): which plus shows which effect, if any.
7. **Horses and mobs.** Whether retail aggressive mobs target a parked horse, or a rider instead of the horse. Our rule: they hit the rider, and the horse absorbs.
8. **Quest rewards for elixirs.** The quest content owner decides (§4.5).
9. **Retail elixir drops.** The port's level-15+ drop entries come from `RECIPE_*_B` rows but are mapped to `_A` codes (§4.5). Whether retail drops `_A` elixirs there at all is unknown.
10. **Summon bands.** What "80 % 이상" means, and when band 0 fires (§2.2).
11. **Berserk on the wire.** `EntityState.berserkMs` (this spec) or an `EffectState` with skill `SYSTEM_CH_HWANMODE` (EFFECTS §3.9). The shared FC pass picks one before BZ and FX-C2 start.
12. **Break/warning sounds.** `ui.eqbreak` plays `itemdanger.ogg` and `ui.eqdanger` plays `itembreak.ogg` in today's index (§3.1): a crossed mapping or retail's own naming.
