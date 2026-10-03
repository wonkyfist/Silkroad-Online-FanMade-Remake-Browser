# Pets, friends list and mail (wave 11, part "social")

This spec designs three things the user asked for in wave 11 ("Things SRO has that we haven't built: the item-pickup
pet, attack pets, and a friends list and mail"):

- **Pets**: the item-pickup ("grab", retail "Ability Pet") pet and the attack ("Growth Pet") pets, as character-owned
  summons (COS) next to the wave-8 horse (docs/SYSTEMS_COMBAT.md §1, `apps/server/src/mounts.ts`).
- **Friends list**: add, remove, block, online status, whisper integration.
- **Mail**: text plus items and gold to online or offline players, expiry, anti-dupe transactions in the existing
  inventory model, and GM moderation.

It follows the method of docs/SYSTEMS_SOCIAL.md and docs/WAVE_PLAN3.md: retail facts first, then rules, protocol,
persistence, UI, abuse cases, budgets, lanes with disjoint files, gates, and a scope-cut order. It is design only;
docs/WAVE_PLAN5.md merges it with docs/MOVEMENT.md and docs/SCREENS.md into one build order.

**Tags.**

- **[confirmed]**: checked in the code at HEAD `85e2e14` (2026-09-29), in `work/out/data`, in the retail client files
  (`work/extracted/Media`, `work/extracted/Data`), or measured; each says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: a cost scaled from a measurement, not measured on that hardware.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this spec makes.

**Repo state [confirmed, `git log`, `git status`].** HEAD `85e2e14` ("Backlog: user-confirmed order: wave 10 sky +
sea + new 3D trees, wave 11 gameplay and screens"). The release workflow has uncommitted edits in `apps/game`
(`rollout.ts`, `settings.ts`, `screens/charcreate.ts`, `screens/charselect.ts`, `three/{actor-textures,backdrop,
remaster,remaster-switch}.ts` and tests), `deploy/config.sh` and some docs [confirmed `git status` at the fact-check,
2026-09-29]; this spec's seams touch none of those files. The
database schema is **v9** (`db.ts` has 9 `MIGRATIONS`; 8 = horses/Berserk, 9 = guilds/social log). Protocol v1,
additive. `tickHz` defaults to 10 (`config.ts`, `TICK_HZ`).

**The user's standing art rule [confirmed, BACKLOG "Next (user-confirmed order)"].** "New 3D models for TREE'S only
for time being": buildings stay retail, and so do pets. **Every pet in this spec uses its retail model and clips.**
No new geometry and no Blender work is planned here. Pet textures can join a later 9B B4 actor batch (local upscale,
UV-exact) if the user wants.

**Reference files kept for the build lanes** (`work/tmp/pets-social/`, data only, made by this spec):

- `retail-layouts-cos.txt`, `retail-layouts-social.txt`: every control of `ifcos*.txt`, `ifpetminiinfo.txt`,
  `ifcommunity.txt`, `iffriend*.txt`, `ifletter*.txt`, `ifmultiletter.txt`, `ifblocking.txt`,
  `ifwhisperblockingslot.txt` (name, class, id, rect, DDJ, text key), from `work/tmp/systemsB/dump-if.ts`. None of
  these files has a per-property `#ifdef`, and only the two blocking pages have whole-control ones
  (`CHATTING_BLOCKING_SYSTEM`, `WHISPER_BLOCKING_SYSTEM`, both on in `define.txt`) [confirmed by reading the dump].
- `ui-strings-pets-social.tsv`: 523 English retail strings (key → English) about COS, pets, letters, friends and
  blocking, filtered from `textuisystem.txt` column 8.
- `cos-items.tsv`, `cos-chars.tsv`: every `COS`/`PET` row of `itemdata_*.txt` and every `COS_*` row of
  `characterdata_*.txt` with the columns this spec uses (`scan_cos.py`).
- `pet-clips.txt`, `pet-models.tsv`: the animation groups, clips and durations of 10 pet BSRs, from
  `@sro/formats` `parseBsr`/`parseBan` (`pet-clips.ts`, run with `pnpm tsx`).

---

## 0. Summary

1. **Pets are a roster, not items [decision].** A pet summon scroll is used once. That **adopts** the pet into the
   character's pet roster (table `char_pets`) and consumes the scroll. From then on the pet is bound to the
   character: it is summoned and dismissed from the pet window, never traded, and it keeps its level, EXP, HP,
   hunger, name and bag in the database.
   - This matches the retail line "It cannot be exchanged or dropped after the first summons."
     (`UIIT_MSG_PET_CANNOT_BE_MOVED`) [confirmed string].
   - It avoids giving inventory items an identity. Our items have none: `writeDraft` deletes and re-inserts rows, so
     row ids change on every move [confirmed `db.ts writeDraft`]. Tying a pet to a movable item would need a new
     item-serial column across `items`, `storage_items`, trade, stalls and mail. That is the biggest dupe risk in
     this wave, so it is avoided.
2. **Pickup pet.**
   - It follows its owner and runs to ground items within **12 m** of the owner that the owner may take now (the
     same `pickupProblem` rule, so party loot rules hold). Filters are the retail ones: grab on/off, "my items only"
     or "all items", and gold / equipment / other [confirmed `ifcossetup.txt` + strings].
   - Loot goes into the **owner's bag**. When the bag is full it goes into the **pet bag** (28 slots). When both are
     full, grabbing switches off with the retail line.
   - It cannot be attacked and does not fight.
3. **Attack pet.**
   - It follows, assists (attacks what the owner attacks), defends (attacks what attacks the owner), or stays
     passive. It swings its retail per-level attack skill.
   - It levels 1–20 on the player EXP table, never above its owner's level.
   - It has HP and retail hunger (HGP: below 30 % its stats halve). It dies, and it comes back with Grass of Life or
     after a 10-minute wait.
   - Its damage counts as the owner's for EXP, loot and quests.
4. **Where pets come from** (there is no item mall):
   - the empty retail **Pet** tab of Stable-keeper Machun's shop (`STORE_CH_STABLE_TAB3` "SN_TAB_PET" [confirmed
     `refshoptab.txt`]), with custom gold prices;
   - a level-5 custom quest that gives a first pickup pet;
   - the retail pet-care goods, added to the Cure tab. The HGP potion and Grass of Life are in the retail TAB4
     [confirmed `refshopgoods.txt`].
5. **Friends.**
   - Retail-style: a request to an online player, accept or decline, mutual friendship.
   - Cap 50. Online and level shown, with "Friend [%s] has logged on/off." lines [confirmed strings].
   - A Whisper button that pre-fills `/w name`.
   - A **block list** that silences whispers, friend requests, mail, and party, guild and trade invites from those
     characters.
6. **Mail** (retail "Msg" letters, extended with attachments).
   - A subject, a body of up to 300 code points, up to **5 item stacks** and gold, to any live character, online or
     offline.
   - Postage is a gold sink. The mailbox cap is 50. Mail expires after 30 days, and unclaimed attachments go back to
     the sender.
   - Every send and every take is **one immediate SQLite transaction** with conditional updates, so nothing can be
     duplicated or lost, even against the offline `gm` CLI process. Every mail request only reaches the requester's
     own mail.
   - Attachments are sent and taken in town only.
7. **GM moderation**: `/mail` (list, return, delete, system send with items, mute), `/friends <name>`, `/pet`, and
   a `mail_log` of every mail movement. A mail body is shown to GMs only when the recipient reported it (or to
   admins), and every read is audited.
8. **One migration** (v10 if this spec lands alone; the WAVE_PLAN5 integrator numbers it after any sibling
   migration). It adds `char_pets`, `pet_items`, `friends`, `char_blocks`, `mail`, `mail_items` and `mail_log`, plus
   `characters.mail_muted_until`.
9. **Budgets.** Pets are extra skinned actors, and the game is CPU-bound in draw submission. A pet has 3–4 meshes
   against the measured Mangnyang's 2 [confirmed, §10], so it costs up to about 2 mobs. Others' pets are therefore
   capped per preset (Low / Medium / High / Ultra: 4 / **4** / **4** / 12), drawn only within a range, and cast no
   shadow. Worst case at Medium (4 others' + own 2): +0.7–1.8 ms CPU [projected from the measured 20-mob crowd], so
   the crowd p95 stays at 15.1–16.2 ms. Friends and mail cost nothing per frame.
10. **Never cut** (§13): the roster model, the pickup pet with party loot rules, the attack pet (follow, assist,
    level, death and revive), friends (add, remove, online, whisper), block for whispers, mail with items and gold
    and its transactions, `mail_log`, GM return, the migration, and the budget caps.

---

## 1. Retail reference

### 1.1 Pet types and items [confirmed `itemdata_*.txt`, `scan_cos.py`]

Item TypeID (cols 9–12) `3/2/1/1` is an **attack (growth) pet** item, `3/2/1/2` a **pickup (ability) pet** item.
Param1 (col 118) is the rental time in minutes on pickup pets (40,320 = 28 days, 4,320 = 3 days) and −1 on attack
pets. Desc1 (col 119) is the COS code. Every pet item is Req. level 5 (cols 32/33) and stack 1.

| Item | Name | Kind | COS (Desc1) | Retail source | Gold price (col 26) | Model |
|---|---|---|---|---|---|---|
| `ITEM_COS_P_FLUTE` | Grey Wolf Summon Scroll | attack | `COS_P_WOLF_001` | **no shop** (not in `refshopgoods`) | 2,000,000 | `res/cos/p_wolf_01.bsr` |
| `ITEM_COS_P_FLUTE_WHITE` | White Wolf Summon Scroll | attack | `COS_P_WOLF_WHITE_001` | mall (`MALL_PET_A_GROWTH`) | 0 | `p_wolf_white_01.bsr` |
| `ITEM_COS_P_RAVEN_SCROLL` | Three Footed Crow Summon Scroll | attack | `COS_P_RAVEN_001` | mall | 0 | `p_raven01.bsr` |
| `ITEM_COS_P_JINN_SCROLL` | Genie Summon Scroll | attack | `COS_P_JINN_001` | mall list | 0 | `p_jinn.bsr` |
| bear / fox / penguin / kangaroo | … | attack | `COS_P_*_001` | mall | 0 | `p_*01.bsr` |
| `ITEM_COS_P_RABBIT_SCROLL` | Rabbit Summon Scroll | pickup | `COS_P_RABBIT` (3 days) | event | 0 | `p_rabbit.bsr` |
| `ITEM_COS_P_RABBIT_SCROLL_SILK` | Rabbit Summon Scroll | pickup | `COS_P_RABBIT` (28 d) | mall (`MALL_PET_B_SILK`) | 0 | same |
| `ITEM_COS_P_MYOWON_SCROLL` | Monkey Summon Scroll | pickup | `COS_P_MYOWON` | mall | 0 | `p_myowon.bsr` |
| `ITEM_COS_P_SEOWON_SCROLL` | Squirrel Summon Scroll | pickup | `COS_P_SEOWON` | mall | 0 | `p_seowon.bsr` |
| `ITEM_COS_P_RACCOONDOG_SCROLL` | Raccoon dog Summon Scroll | pickup | `COS_P_RACCOONDOG` | mall | 0 | `p_raccoondog.bsr` |
| `ITEM_COS_P_SPOT_RABBIT_SCROLL` | Spotted Rabbit Summon Scroll | pickup | `COS_P_SPOT_RABBIT` | mall | 0 | **none** (characterdata model `xxx`) |
| gold/pink pig, glider, cat, sylph, ghost, circus bear, snowman | … | pickup | … | mall / event | 0 | `p_*.bsr` |
| `ITEM_COS_P_HGP_POTION_01` | HGP Recovery Potion | care | Param1 10 | **Stable TAB4** | 1,000 / sell 480 | — |
| `ITEM_COS_P_REVIVAL` | Grass of life | care | — | **Stable TAB4** | 25,000 / 12,000 | — |
| `ITEM_COS_P_CURE_ALL_01/02` | Abnormal State Recovery Potion (S/M) | care | Param 36 / 68 | Stable TAB4 | 36 / 81 | — |
| `ITEM_ETC_COS_HP_POTION_01..03` | Recovery Kit (S/L/XL) | care | 360 / 660 / 1,110 HP | Stable TAB4 (exported) | 190 / 400 / 720 | — |
| `ITEM_MALL_PET_WATCH_*`, `ITEM_COS_P_EXTENSION*`, `ITEM_MALL_PET_SKILL_*`, `*_GROWTH_POTION` | bag extension, rental extension, pet skill, growth | mall | — | out of scope | — | — |

- The mall prices are in silk: 99 for attack pets, 88 for pickup pets [confirmed `refpricepolicyofitem.txt`
  type 2]. The only pet with a gold price is the Grey Wolf, and no shop sells it.
- `STORE_CH_STABLE_TAB3` "SN_TAB_PET" exists with no goods [confirmed `refshoptab.txt`, `refshopgoods.txt`]. Our
  export shows the stable with two tabs, Vehicle (Red Horse) and "Pill potion" (the three Recovery Kits); the pet
  care goods are filtered out today [confirmed `work/out/data/shops.json`, `items.json`: no `ITEM_COS_P_*` row].
- `CanTrade` (col 16) is 1 on every non-event pet item and 0 on the `ITEM_EVENT_*` copies [confirmed].

### 1.2 The pets themselves [confirmed `characterdata_*.txt`]

characterdata TypeID `1/2/3/3` is an attack pet (one row per level: col 4 = base code, col 6 = next level's code),
`1/2/3/4` a pickup pet (one row). Columns: 46/47 walk/run (dm/s), 50 BCRadius (dm), 52 model, 54 icon, 57 level,
59 MaxHP, 61 InventorySize, 67 CanControl, 71/72 PD/MD, 73/74 PAR/MAR, 75 ER, 77 HR, 83 DefaultSkill_1. Column 61
checked on a player: `CHAR_CH_MAN_ADVENTURER` = 45, and the trade horse `COS_T_HORSE1` = 33.

| Pet | Rows | HP L1 → L10 → L20 | Walk / run (m/s) | Radius (m) | PD/MD L1 → L20 | ER/HR L1 → L20 | Default skill |
|---|---|---|---|---|---|---|---|
| Grey Wolf (`COS_P_WOLF_001..020` …) | per level | 360 → 1,205 → 2,517 | 5.0/7.5, 5.5/8.3 (L10–19), 6.0/9.0 (L20) | 0.3 | 8/13 → 77/123 | 27/27 → 65/65 | `PSKILL_P_WOLF_01_ATTACK01` (L1) … `PSKILL_P_WOLF_020_ATTACK_01` (L20) |
| White Wolf (`COS_P_WOLF_WHITE_*`) | per level | same curve | same | 1.1–1.3 | same | same | `PSKILL_P_WOLF_WHITE_*` |
| Three Footed Crow (`COS_P_RAVEN_*`) | per level | same curve | 5.0/7.5 | 0.4 | same | same | `PSKILL_P_RAVEN_*` |
| Genie (`COS_P_JINN_*`) | per level | same curve | 5.0/7.5 | 0.4 | same | same | `PSKILL_P_JINN_01_ATTACK01` (id 20503) [fact-check: the draft said none] |
| Rabbit / Monkey / Squirrel / Raccoon dog / Gold Pig / Cat … | one | 109 | 5.0 / **12.0** | 0.4–1.1 | 7/10 | 27/27 | — |

- Pickup pets have **InventorySize 140** [confirmed col 61 on `COS_P_RABBIT`, `_MYOWON`, `_GOLDPIG`, `_CAT`]. The
  retail pet-bag lattice is 7 × 4 = **28 slots per page** with a page spinner (`GDR_COS_INV_LAT` 252×144 at a 36-px
  pitch, `GDR_COS_INV_SPIN_PAGE`) [confirmed `ifcosinventory.txt`]. The mall watches add 28 (`INC_INVENTORY_SIZE,
  …,28`) [confirmed]. So the base size is most likely one page (28) and 140 is the cap [likely].
- Column numbers in this section are 0-based, as in `scan_cos.py`. Col 83 holds the skilldata **numeric id**, not the
  code: wolf L1 = 3824 = `PSKILL_P_WOLF_01_ATTACK01`, L20 = 3843; raven L1 = 21270 [confirmed by re-reading
  skilldata_5000/25000 at the fact-check].
- The wolf's L1 attack skill has 'att' = [5 (physical), 104 %, 23, 25], L10 flat 76–88, L20 165–193 (skilldata cols
  70–73 after the `att` tag 6386804 at col 69). Cols 13/14/15 = 1,566 / 1,566 / 4,000 [confirmed values]. Our mob
  exporter turns such a row into `physAttack` = the flat min–max and `attackIntervalMs` = max(col 14, col 15)
  [confirmed `packages/convert/src/data/mobs.ts` + `buildMobSkills`], so read the same way the wolf swings for
  23–25 → 165–193 **once every 4.0 s** [likely: the retail interval of pet skills is not otherwise documented]. The
  lane reuses that reader.
- Pet EXP: leveldata column 1 (`Exp_C`) is the player EXP table. Retail pets level on the same table [likely].

### 1.3 Models and clips [confirmed `pet-clips.txt`, `@sro/formats parseBsr`]

| Model | Meshes | Clips (default group; ms) |
|---|---|---|
| `p_wolf_01` | 3 | STAND1 400, STAND2 2,500, STAND3 2,666, WALK 533, RUN 400, ATTACK1 2,000, DIE1 1,166, DIE1_RM 333, EMOTION01 4,233, DOWN / DOWN_RM / DOWN_DAMAGE / DOWN_UP / DOWN_DIE. **No DAMAGE clip.** |
| `p_raven01` | 3 | STAND1 2,000, STAND2 3,666, WALK 2,000, RUN 2,000, ATTACK1 1,666, DAMAGE1 666, DIE1 2,333, EMOTION01 6,000, DOWN set |
| `p_rabbit` | 4 | STAND1 3,333, WALK = RUN 400, **PICK 233**, EMOTION01 3,166 |
| `p_myowon` (monkey) | 4 | STAND1 4,000, WALK 666, RUN 466, PICK 233, EMOTION01 2,933 |
| `p_seowon` (squirrel) | 4 | STAND1 3,333, WALK 533, RUN 400, PICK 233, EMOTION01 1,600 |
| `p_raccoondog` | 4 | STAND1 1,066, WALK 533, RUN 400, PICK 233, EMOTION01 3,566 |
| `p_goldpig`, `p_gglider`, `p_cat`, `p_brownie` | 3 | the same pickup set (PICK 200–233) |

- "Meshes" is the BSR mesh list (`parseBsr().meshes`): wolf 3 (`p_wolf_01_part1/part2/2side_part2`), raven 3,
  rabbit 4, monkey 4. The 20-mob budget crowd is `MOB_CH_MANGNYANG`, whose glb has **2** meshes / 2 primitives, as
  does the horse [confirmed at the fact-check: `work/tmp/pets-social/check-meshes.ts` and the glb JSON of
  `work/out/mob/china/mangnyang.glb`]. So a pet is 1.5–2× a Mangnyang in draws (§10).
- Every referenced `.bms`/`.bmt`/`.bsk` exists in `work/extracted/Data` (`bsr_strings.py`, 0 missing).
- Only `c_horse1` is converted today (`work/out/cos/`).
- Icons exist in `Media/icon/cos/` (`cos_p_wolf_01`, `cos_p_raven`, `cos_p_rabbit`, `cos_p_myowon`, `cos_p_seowon`,
  `cos_p_raccoondog`, `item_cos_p_*`) [confirmed `ls`].
- Sounds [confirmed `effectsound.txt`]: `COS_P_WOLF1` has stand, moan, die, a thud, and a shout plus hit per attack
  skill. `COS_P_RAVEN1` has moan, die, a thud, and shout plus hit. No pickup pet has a row [confirmed by the filter].

### 1.4 Retail pet rules (strings) [confirmed that the string exists; that the 1.188 server enforces it is likely]

| String id | Text | Our rule |
|---|---|---|
| `UIIT_MSG_COSPETERR_CANT_PETSUM_BATTLE` | Cannot summon a pet during battle. | 20 s combat lockout (the horse's `cosCombatLockMs`) |
| `UIIT_MSG_COSPETERR_CANT_PETSUM_MAXSUM` | Cannot summon a pet any more. | One attack pet + one pickup pet summoned (+ the horse) |
| `UIIT_MSG_COSPETERR_CANT_PETSUM_HIGHLEVEL` | …its lvl is higher than yours. | Pet level ≤ owner level (also the EXP cap) |
| `UIIT_MSG_COSPETERR_CANT_DEACTIVATE_IN_DEADSTATE` | You cannot summon/unsummon when your character is dead. | Refused while dead |
| `UIIT_MSG_COSPETERR_CANT_PETRE_DEADPET` | Cannot restore a pet when it is dead. | Summoning a dead pet needs Grass of Life or the wait (§2.4) |
| `UIIT_MSG_COSPETERR_HGP_30LOW` | All stats are lowered by 50% when the pet's HGP is lower than 30%. | Kept |
| `UIIT_MSG_COSPETERR_HGPFULL_NODRINK` | …the pet is not hungry. | Kept |
| `UIIT_MSG_COSPETERR_CANT_PICKITEM1` / `…2` | …set OFF because the pet's / character's inventory is full… | Grab goes off only when **both** are full (§2.2) |
| `UIIT_MSG_COSPETERR_CANT_TRADE_SHOP` | You cannot trade items in the pet inventory directly with stores. | Pet bag never sells, trades, lists or mails |
| `UIIT_MSG_COSPET_LOST_EXP` / `GAIN_EXP` | You have lost / gained [%d] amount of pet experience. | Death EXP loss; gain lines (quiet by default) |
| `UIIT_STT_COSPET_MAKENAME`, `…_NOTREVISION_NAME`, `…PETNAME_SUMENESS` | Name your pet. / Cannot change … any more. / Name already exists. | Name once; not unique (§2.1) |
| `UIIT_STT_COSNEWUI_TECHNOLOGY_*`, `…PICKUP_*` | Autograb setting; Grab function ON/OFF; Target grab authority: my items / all items; Target item: Gold / Equipment / Other items | The grab settings |
| `UIIT_STT_COSNEWUI_INFO` / `SUMMONCANCEL` / `FOLLOW` | Information (Insert) / Unsummon (PgUp) / Follow (Del) | Keys of the pet command bar |
| `UIIT_STT_BLIND_ALLY_COS` | Hide Friends COS | Options row "Hide other players' pets" |
| `UIIT_STT_COSNEWUI_RENTTIME` | Rental period | Not used (no expiry, §2.1) |
| `SN_TAB_PET_GROWTH` / `_SILK` / `_STORES` | Growth Pet / Ability Pet / Pet Items | Names for the kinds |

### 1.5 Retail friends, letters and blocking

| Fact | Source | Tag |
|---|---|---|
| The community window (`GDR_COMMUNITY`, 477×393) has pages Guild (10), Guild relations (11), War state (12), **Friend (13)**, **Letter (14)**, **Blocking (15)**, each `equip_window_` at (13,61,451,320). | `ifcommunity.txt` | confirmed |
| Tab art: `guild/gil_{info,note,cut,friend,relationship,war}_tab_{on,off}` and sub-tabs `gil_{friend,block,whisper,…}_sub_tab_*`. All exported to `work/out/ui/guild/` (160 files). | `export-ui.ts` row `interface/guild`, `ls work/out/ui/guild` | confirmed |
| Friend page: frame `frameg01_wnd_` (6,6,440,308); list `com_blacksquare_` (14,18,333,282) with a scroll manager (17,43,328,256) under the sort header `gil_subj_button09` "Friends list" (67,21); side tile `com_bg_tile_b` (328,22,102,276); count "Friend n" (353,27)/(380,27); buttons `com_mid_button` at (352,55) "Whisper" (`UIIT_STT_GET_WHISPER`), (352,84) "Add friend", (352,113) "Delete friend". | `iffriend.txt` | confirmed |
| Friend row: lamp `gil_contact_on/off` (20,6), race mark `com_kindred_china16` (73,4,16,16), name (95,7,89,16). | `iffriendslot.txt` | confirmed |
| Letter page: the same frame and list; sort buttons "From" (17,21) and "Received time" (173,21) (`gil_subj_button10`); buttons (352,55) "Send msg", (352,84) "Read msg", (352,113) "Delete msg", (352,142) "Guild msg", (352,171) "Union msg"; count "Msg n". Row: race mark (22,4), sender (43,7,92,14), received time (162,7,140,15). | `ifletter.txt`, `ifletterslot.txt` | confirmed |
| Write and read letter: a `msgbox2_window_` 439×271. Write: "To" edit (110,56,170,20), contents edit (16,100,408,123), Send (140,234) / Cancel (228,234). Read: "From" (110,60), contents (16,100,408,123), Reply (94,234) / Delete (182,234) / Close (270,234). **No item or gold field.** | `ifletterwrite.txt`, `ifletterread.txt` | confirmed |
| Retail letters are **text only**; items and gold by mail are our extension. | the two layouts above | confirmed |
| Letter strings: "The note has been sent successfully."; "Insufficient note item" (retail letters cost a note item); "You cannot receive a note anymore because your box is full."; "You cannot send a note to the subject whose note box is full."; "Not a subscriber."; "You have a new message."; "Will you delete the note?"; "Msg block". | `UIIT_MSG_LETTER*`, `UIIT_STT_LETTER_BLOCK*` | confirmed |
| Friend strings: "Type character name that you want to add."; "[%s] proposed to make friends with you. Will you accept it?"; "The proposal to make friends was accepted/refused."; "…because the other player didn't respond."; "Cannot proceed to add friend because the other player is not a subscriber or disconnected to the server."; "You can't add anymore friends."; "The other player is already on the friend list."; "The other player is unable to add anymore friends."; "Friend [%s]has logged on./off."; chat `/friend`, `/f`, `/invite`. | `UIIT_MSG_FRIEND*`, `UIIT_STT_CHAT_COMMAND_FRIEND_*` | confirmed |
| Friend groups ("Unfiled", up to 20 groups) | `UIIT_*FRIEND_GROUP*` | confirmed; out of scope |
| Whisper block: `/mute`, "Blocked whisper from [%s].", "Block Whisper"; blocking slot = the friend slot. | `UIIT_STT_CHAT_COMMAND_WHISPER_BLOCK`, `ifwhisperblockingslot.txt` | confirmed |
| Friend cap, letter-box cap, letter expiry | none | unknown → §3, §4 |

---

## 2. Pets

### 2.1 Model and lifecycle [decision unless tagged]

- **Adopt.** `itemUse {bag}` on an item with `use.pet` set:
  - checks alive, the item's level (`requirements`), and the roster cap (`PET_ROSTER_MAX`, default 4 → `pet_full`);
  - in one transaction: take the item, insert a `char_pets` row (level 1, full HP, HGP 10,000, the kind's default
    settings), then summon it at once (§2.4).
  - The item is gone. The roster row records the item code for GMs.
- **Roster.** A character owns up to 4 pets, of either kind. At most one attack pet and one pickup pet are summoned
  at a time, plus the horse (`pet_active` "Cannot summon a pet any more.").
- **No rental expiry.** Retail pickup pets expire after 28 or 3 days. We have no mall and no way to renew, so the
  timer is dropped [decision; user question N2].
- **Ownership.** Every request that names a pet (`petX {pet}`, `itemUse {pet}`) resolves the id only among the
  requester's own rows (`character_id = me AND released_at IS NULL`); anything else is `not_found`.
- **Name.** Unnamed pets show their family name ("Wolf cub", "Rabbit"). `petName` sets it **once**, 2–12 letters or
  digits (the guild-name alphabet `GUILD_NAME`; `CHARACTER_NAME` differs: 3–12 and `_` [confirmed protocol.ts]),
  passed through `isReservedName` and `cleanChat`. Names are **not** unique; the
  retail uniqueness adds nothing on a friends server [decision].
- **Release.** `petRelease` deletes a stored (not summoned) pet whose bag is empty (`pet_not_empty`). The row gets
  `released_at` and is never read again. It is a soft delete, so a GM can restore it.
- **Deleted owner.** The rows stay (soft-deleted characters keep everything today). They are never loaded.

### 2.2 Pickup pet

**Following.**
- The pet stays 1.5–2.5 m behind and to the right of its owner.
- It re-plans a follow move only when the owner's live point is more than 3 m from the pet's goal, at most every
  500 ms (`PET_FOLLOW_REPLAN_MS`).
- It moves at its run speed (12 m/s for the retail pickup pets [confirmed col 47]).
- If it is more than `PET_LEASH_M` (30 m) from its owner, or cannot walk there (no navmesh path), it is placed next
  to the owner (a `warp`, like a mob's leash reset).
- A warp of the owner (return scroll, GM, respawn) carries it along.

**Grab scan.** Four times a second (`PET_GRAB_SCAN_MS` 250), when grabbing is on and the pet is not already
fetching, the server picks the **nearest** ground item that meets all of these:

1. It is within **`PET_GRAB_RADIUS_M` (12 m) of the owner** [unknown retail value; decision] and within 2 m of the
   height of the owner's surface, so the pet does not reach floors above or below.
2. It passes the settings:
   - gold / equipment / other, where equipment = `ItemDef.slot` set and other = the rest;
   - scope `mine`: `item.ownerChar` is the owner's character (a share-mode round-robin item assigned to the owner
     has exactly that owner [confirmed `party.ts killShares` → `lootOwners.next`]), or it is party gold of the
     owner's party within the window (`mayLoot` is true for gold in either mode). A free-mode teammate's item is
     **not** "mine" even though `mayLoot` lets a hand take it [fact-check: the draft's §2.5 row contradicted this];
   - scope `all`: also everything else rule 3 allows (free-mode teammates' items, items with no owner, items whose
     owner window has ended).
3. `Gameplay.pickupProblem(owner, item)` is null **ignoring `inventory_full`**. That is the exact player rule: the
   owner window (`ITEM_OWNER_MS` 30 s) and `PartyManager.mayLoot` (free-mode items and party gold during the window;
   in share mode, a round-robin item only goes to the member it was assigned to). A pet never takes what its owner
   could not take by hand [decision: the pet *is* the owner's hand].
4. It is reachable: `nav.walk` from the pet to the item ends within `PICKUP_RANGE` (2 m). Unreachable items are
   remembered for 10 s and skipped.
5. It is not already targeted by another pet (one fetcher per item; the first scan wins).

**Fetch.**
- The pet runs to the item. On arrival (within `PICKUP_RANGE` of the item) it plays PICK (233 ms), and then the
  server calls `Gameplay.pickUpFor(owner, item, {into: 'bag-then-pet', pet})` (seam, §8.2). That is the same code as
  a hand pickup, in one transaction:
  - **gold** → the owner's gold, with the share-mode party split (`goldSplit`) exactly as by hand;
  - **an item** → the owner's bag if it fits (`putBack`), else the pet bag (`StorageDraft` slots, the same
    stacking), else nothing.
- If neither fits, grabbing switches off, the owner gets the retail line (PICKITEM2), and `petUpdate {grab.on:
  false}` goes out.
- If the item vanished meanwhile (someone took it, or it expired), the fetch just ends.

**Pauses** (the scan skips; nothing is lost):
- the owner is dead, trading or running a stall (their bag is locked, SYSTEMS_SOCIAL §2.3), riding the horse while
  moving (`mounts.ridden(owner)` and a move in progress; a speed threshold would also catch speed buffs), or in a
  different world;
- the owner is in combat and the setting "pause in combat" is on (default off).

**Invulnerable.** Pickup pets cannot be attacked or targeted by mobs or players, and are not hit by AoE. Clicking
another player's pet does nothing [likely retail; decision].

**Pet bag** (`pet_items`, `bag_size` 28 [likely base]; knob `PET_BAG_SLOTS`, cap 140 [confirmed data cap]):
- `petItem {pet, from, to, count?}` moves items between the owner's bag and the pet bag, or within the pet bag, in
  one transaction (`petBagTx`, §6.2).
- The pet must be summoned and within 30 m. The retail window only opens for a summoned pet [likely].
- Allowed anywhere, and refused while trading or stalling (the gates).
- Items in the pet bag cannot be sold, dropped, traded, listed, mailed, stored or used. They must go to the bag
  first (`not_usable` "Move the item to your inventory first.").
- The bag keeps its items when the pet is dismissed, dies (pickup pets cannot die) or the owner logs out.

### 2.3 Attack pet

**Stats.**
- The per-level characterdata row gives HP, PD/MD, PAR/MAR, ER/HR and speeds.
- The per-level default skill gives damage (min–max, cast and cooldown).
- Low hunger: below 30 % HGP, every stat and damage × 0.5 [confirmed string, rule].
- `PET_DAMAGE_RATE` (default 1) scales pet damage for balance.

**Modes** (`petMode`; the command bar):
- `assist` (default): attacks the mob its owner attacks (auto-attack or a skill on a mob) and anything that attacks
  the owner.
- `defend`: only what attacks the owner or the pet.
- `passive`: follows only, and never attacks.
- `petAttack {pet, target}` orders one attack now (the command bar's Attack with a mob selected), in any mode but
  passive.

**AI** (server, `pet-ai.ts`, a small state machine like `ai.ts`):
- **follow**: as §2.2.
- **engage**: chase to `reach = skill range + both radii`, then swing at the skill's interval. It re-plans the chase
  like a mob (`CHASE_REPLAN_MS` 300 ms, 1 m slack).
- **disengage**: when the target dies or despawns, or the pet is more than `PET_LEASH_M` (30 m) from the owner. Then
  back to follow. Past 60 m, or on an owner warp, it is placed next to the owner.
- It never attacks players, NPCs, horses or other pets (no PvP), never enters a town safe area to fight
  (`inSafeArea`), and never starts a fight while the owner is dead.

**Combat seams.**
- A pet swing is `Gameplay.dealHits(pet, mob, hits, {skill}, now)` with the attacker union widened to include `Cos`
  (§8.2).
- The damage is **credited to the owner** in `Mob.damage` (keyed by the owner's player id), so EXP shares, loot
  owner, party rules and quest credit treat the pet's damage as the owner's.
- The `combat` message names the pet as attacker, so clients play the pet's attack clip and sounds.
- **The credit and the target are two ids** [fact-check]. Today `retaliate(m, attacker, damage, notice)` uses one id
  for both the `m.damage` credit and `m.target` [confirmed `ai.ts:88`]. The seam becomes
  `retaliate(m, creditId, damage, notice, targetId = creditId)`: a pet hit passes the owner's player id as credit
  and the pet's entity id as target, and `notice` = `!owner.invisible` (today `!a.invisible`, `gameplay.ts`).
- The rest of `dealHits` must accept a `Cos` attacker: `a.lastCombatAt`, `hwanHits(a)` (false for a pet),
  `durability.afterHits(a, …)` (no wear for a pet) and `broadcastAboutEither(a, t, …)` [confirmed call sites].
  `Gameplay.attack(a, t)` (mob swings) widens the same way. `Cos` gains `combat: CombatStats` for `rollSkillHit`.

**Mobs fight back.**
- A mob hit by a pet, with no current target, takes the **pet** as its target (`retaliate`, split as above).
- **Hits on a pet** need their own branch [fact-check]: `dealHits` sends *every* `cos` target to
  `mounts.hitCos` today (`if (to.kind === 'cos') return this.mounts.hitCos(…)` [confirmed `gameplay.ts`]), which is
  the horse's HP and death path. The seam dispatches on `to.role`: `'ride'` → `mounts.hitCos`, else
  `pets.hitCos`.
- If the pet dies or leaves, the mob switches to the next player in its damage map, which is the owner (the credit
  above). That is retail-like and needs no extra threat table.
- Aggressive mobs still acquire **players** only (`playersNear`) [decision].
- `AiHost.target(id)` and `swing` accept a `Player | Cos` (§8.2). Mob hits on a pet use the mob-vs-player formula
  with the pet's defences. Pets take no statuses and no knockdown in v1 [decision; cut the retail DOWN clips].

**EXP and levels.**
- On `mobDied`, if the owner is in `credit`, the summoned, alive attack pet within 60 m of the corpse gains
  `round(ownerShare.exp × PET_EXP_RATE)` pet EXP (default rate 1.0) [decision; retail ratio unknown].
  The `mobDied` module hook passes only `credit: ReadonlySet<number>` today [confirmed `modules.ts`], so the seam adds
  an optional fourth argument, the `shares` map `Gameplay.mobDied` already computes (additive; other modules ignore
  it).
- It levels on leveldata `Exp_C` (the player table, `levels.json`) [likely].
- It **never goes above its owner's level**. EXP past the owner-level threshold is discarded [decision; matches
  "its lvl is higher than yours"].
- It cannot pass `LEVEL_CAP`.
- Level-up swaps the stat row and the skill row, heals to full, and sends `petUpdate` plus a `petEvent 'levelUp'`.
  The client plays the retail level-up effect on the pet, if the effect lane has one [likely reuse of the player
  level-up FX].

**Hunger (HGP).**
- 0–10,000, shown as a gauge (`pt_hgp`, `pmi_pet_hgp` [confirmed art]).
- It drains 1 point per `PET_HGP_DRAIN_MS` (1,500 ms) **while summoned**, so 10,000 → 3,000 (30 %) takes about 2.9 h
  of summoned play [decision; user question N3].
- The HGP Recovery Potion (`itemUse {bag, pet}`) restores `PET_HGP_POTION` (2,500) [decision: Param1 10 is
  [confirmed] but its unit is [unknown]]. It is refused when HGP ≥ 9,500 ("…not hungry").
- At 0 the pet is not dismissed; it stays at × 0.5.

**HP.**
- The pet regenerates 1 % of max HP every 5 s out of combat [decision], so no pet stays half-dead forever.
- Recovery Kits heal it: `itemUse {bag, pet}`. The kits keep `use.target: 'mount'` (§5.4): `itemUse {bag}` with no
  `pet` keeps today's horse rule, and a `pet` field redirects the kit to that pet.

**Death.**
- At 0 HP: the corpse (DIE1 → DIE1_RM) despawns after `CORPSE_MS`. The row gets `dead_at = now` and `hp = 0`, and
  loses `PET_DEATH_EXP_PCT` (5 %) of its current level's requirement, never below the level's start [decision].
- The owner gets "Your pet has died." and "You have lost [n] amount of pet experience." [confirmed string].
- **Revive**: Grass of Life (`itemUse {bag, pet}` on a dead pet) sets it alive at 50 % HP. Or, after
  `PET_REVIVE_WAIT_MIN` (10 min), the next `petSummon` brings it back at 30 % HP for free [decision: the free wait
  keeps a friends server friendly; user question N4].

**Owner states.**
- Owner death: summoned pets of both kinds are dismissed. They keep their HP and are not dead, and can be summoned
  again after respawn [decision].
- Mounted: pets stay out. The attack pet may fight while its owner rides, in `defend` mode behaviour, since the owner
  cannot attack.
- Owner logout: summoned pets are saved with `summoned = 1` and come back at enter-world (like the horse row).

### 2.4 Summon and dismiss

**`petSummon {pet}`**, checks in order:
1. owner alive (`dead`);
2. the pet is in the roster and not released (`not_found`);
3. not already summoned (`pet_active`);
4. no other summoned pet of its kind (`pet_active`);
5. pet level ≤ owner level (`pet_level`);
6. not dead, or the wait is over, or it becomes alive now (`pet_dead` "Cannot restore a pet when it is dead.");
7. owner not in combat for 20 s (`in_combat`), not busy with a skill or cast (`busy`), not trading or stalling (the
   gates).

Then the pet entity spawns 1.5 m behind the owner: `actionResult` → `spawn {cos}` → `petUpdate {state:'summoned',
entity}`.

**Cooldown.** 10 s between summons of the same pet (`PET_SUMMON_COOLDOWN_MS`), against spam.

**`petDismiss {pet}`**: always allowed while alive (also in combat). It saves the row and despawns the pet.

### 2.5 Pets and the owner's party loot rules (explicit cases)

| Situation | Pickup pet of member A |
|---|---|
| A's own drop (A top damage, solo) | takes it at once |
| Party 'free', a drop owned by teammate B, within 30 s | scope `all` only (a hand pickup could, `mayLoot`); scope `mine` leaves it |
| Party 'share' (round robin), item assigned to A | takes it (its `ownerChar` is A) |
| Party 'share' (round robin), item assigned to B | never within the window; after 30 s only with scope `all` |
| Party gold, either mode | takes it; share-mode gold is split among members near **A** (`goldSplit`, as by hand) |
| Non-party player C's drop within the window | never (`not_owner`) |
| Any drop after its window | scope `all` only |
| A is trading or stalling | pauses |

The client's Auto Looting key G (`world/autoloot.ts`, 15 m, up to 8 items) keeps working next to a pet: its loop
advances when the item it walks to despawns, whoever took it [confirmed autoloot.ts header], and the server takes a
ground item once (single-threaded; `pickUp` removes the entity after the commit [confirmed]).

### 2.6 Where pets and pet goods come from

**Stable-keeper Machun** (`NPC_CH_HORSE`):
- **Pet tab** (`STORE_CH_STABLE_TAB3` "Pet", the retail empty tab), with custom gold prices through a new exporter
  table `CUSTOM_GOODS` (§8.3) [decision; user N1]:

  | Item | Price (default) | Why |
  |---|---|---|
  | `ITEM_COS_P_FLUTE` Grey Wolf | 30,000 | about 2.5–5 h of frugal gold at levels 8–15 (BALANCE §5.1: 6,000–12,000/h); about 1 h of the potion-fed *gross* 26–32k/h, which potions more than eat (§5.2) [fact-check: the draft cited only the gross] |
  | `ITEM_COS_P_RAVEN_SCROLL` Three Footed Crow | 45,000 | the Chinese-myth pet, a later goal |
  | `ITEM_COS_P_RABBIT_SCROLL_SILK` Rabbit | 5,000 | cheap entry grab pet |
  | `ITEM_COS_P_MYOWON_SCROLL` Monkey, `ITEM_COS_P_SEOWON_SCROLL` Squirrel, `ITEM_COS_P_RACCOONDOG_SCROLL` Raccoon dog | 8,000 each | cosmetic choice |

- **Cure tab** (retail TAB4 goods, retail prices unless noted): the three Recovery Kits (already sold),
  `ITEM_COS_P_HGP_POTION_01` (1,000), and `ITEM_COS_P_REVIVAL` Grass of Life at **5,000** instead of 25,000
  (25–50 min of frugal gold at 8–15) [decision]. The cure-all potions are **not** sold, because pets take no statuses in v1.

**Quest**: a new custom quest "A Friend That Fetches" (Machun, level 5, bring 10 Mangyang pelts or the like; the
quest lane authors it in `content/quests/jangan.json`) rewards `ITEM_COS_P_RABBIT_SCROLL_SILK`. So every friend gets
a pickup pet early, without gold [decision; user N1].

**Pet choice for "Chinese" flavour.** Retail pets are not race-bound (no `_CH_` in their codes) [confirmed]. The
set above keeps to animals that fit Jangan: wolf, the three-footed crow (Sanzuwu), rabbit, monkey, squirrel, raccoon
dog. The White Wolf, Genie, bear, fox, penguin, kangaroo, pigs, glider, cat, sylph, ghost, circus bear and snowman
stay out; GM `/pet` can still summon any exported family.

---

## 3. Friends list and blocking

### 3.1 Rules [decision unless tagged]

**Add.**
- `friendRequest {name}` needs the target **online** and visible to you. An invisible GM counts as offline for
  non-staff (`world.canSee`), and so does a target that blocks you ("…not a subscriber or disconnected…") [confirmed
  retail string; the block case is our privacy rule].
- One pending request per pair. It expires after 30 s ("…didn't respond").
- The target gets `friendAsked` and answers `friendRespond`.
- On accept, both directions are inserted in one transaction, and both sides get `friendUpdate` and a `friendEvent`.
- Refusals: `friend_full` (you have 50; `FRIEND_MAX`), the target's list full ("…unable to add anymore friends"),
  `already_friend`, `invalid_target` (yourself; `bad_request` is an `ErrorCode`, not an `ActionFailReason`
  [confirmed protocol.ts]), `blocked` (a character **you** blocked).
- `/friend name` and `/f name` in chat send the request [confirmed retail commands].

**Remove.** `friendRemove {characterId}` deletes both directions [decision: mutual, the retail request/accept
model]. The other side, if online, gets `friendRemoved`.

**Online status.**
- At enter-world the full `friends` list arrives (name, model for the race mark, level, online).
- On enter, leave or level-up of a character, every **online** friend gets `friendUpdate` and the line "Friend [x]
  has logged on/off." [confirmed strings]. There is no level-up module hook; the friends module polls online
  friends' levels in `tick` at most every 2 s, as the guild module already does [confirmed `social/guild.ts`
  header], so no seam is needed.
- Invisible GMs never show online to non-staff friends, and going invisible sends an "offline" update. Their pets
  hide with them for free: `world.canSee` hides any `cos` whose owner is an invisible GM [confirmed `world.ts`].

**Whisper integration.**
- The Whisper button fills the chat input with `/w <name> ` (UX_GAPS C2 syntax [confirmed]).
- Double-clicking an online friend does the same.
- Whisper lines from friends keep the whisper colour; no new channel.

**Block.**
- `blockAdd {name}` works on any live character, online or not (a DB name lookup). The cap is 100
  (`BLOCK_MAX`).
- Blocking a friend removes the friendship.
- A blocked character:
  - whispers you → **they** get "X is not online." (`not_found`, the existing offline answer, so the block is not
    revealed) [decision];
  - sends you a friend request → treated as offline;
  - mails you → refused `mail_refused` "That player does not accept your messages." A silent drop would lose
    attachments, so mail reveals the block [decision];
  - invites you to a party, guild or trade → answered as "declined" to them, with nothing shown to you.
- You whisper someone **you** blocked → refused "You have blocked X." as `error bad_request` [fact-check]. Chat is
  not a gameplay request: a whisper failure is an `error` message (offline = `error not_found`, yourself =
  `error bad_request` [confirmed `chat.ts`]), and the client parser only accepts known `ErrorCode`s
  [confirmed `validate.ts` `ERROR_CODES`], so a new `blocked` code there would be dropped. `blocked` stays an
  `ActionFailReason` for `friendRequest`, `mailSend` and invites to a character you blocked.
- Blocks cover whispers, requests, mail and invites, not local, party or guild chat lines [decision; the retail
  "Msg block" has the same scope].
- `blockRemove {characterId}`. `/mute name` adds a block [confirmed retail command `/mute`].

**Deleted characters** vanish from both lists on the next load (a join on `deleted_at IS NULL`, the guild prune
pattern).

### 3.2 Why a friends list on a 20-player server

Two uses: knowing who is on when you log in (the line and the lamps), and the one-click whisper. The block list is
the minimum moderation tool that does not need a GM.

---

## 4. Mail

### 4.1 Rules [decision unless tagged]

**Send** `mailSend {to, subject, body, gold, items: [{bag, count}] ≤ 5}`:

- `to`: a live character name (case-insensitive). Unknown or deleted → `not_found` "Not a subscriber." [confirmed
  string]. Yourself → `invalid_target`. Someone you blocked → `blocked`. Your own alts are allowed; storage is
  account-wide anyway.
- `subject` 0–32 and `body` 0–300 code points after `cleanChat`. At least one of subject, body, gold or items. The
  client caps the whole frame at 900 UTF-8 bytes, the SYSTEMS_SOCIAL §2.5 rule. So in practice a CJK or emoji body
  stops near 250 code points; English text reaches 300.
- `gold` 0..`MAX_GOLD`. Items are bag slots with a count (a partial stack splits). Equipped items, and items with
  `canTrade === false` (the starter kit, `*_DEF`), are refused `not_usable`. Pet-bag items can't be picked. The
  quest bag is separate and can't be picked either.
- **Postage** `MAIL_POSTAGE` = 50 gold + 20 per attached stack, a gold sink [decision]. GM system mail pays none.
- **Attachments only in town.** If gold > 0 or any item is attached, the sender must stand in a safe area
  (`data.inSafeArea`) → otherwise `wrong_place` "Attachments can only be sent in town." Text-only mail can be sent
  anywhere [decision; user N5].
- Recipient's box has fewer than `MAILBOX_MAX` (50) live mails → otherwise `mailbox_full` "You cannot send a note to
  the subject whose note box is full." [confirmed string].
- Not blocked by the recipient (`mail_refused`). Not muted by a GM (`muted`).
- Rate limits: the per-type bucket (§5.6) plus `MAIL_SEND_PER_HOUR` (30) per character, and at most 10 unread mails
  from one sender in one box, against flooding.
- The gates: trading or stalling refuse it (it is not in their allowlists); dead refuses it.
- **Transaction** (`mailTx`, §6.3): one SQLite transaction does all of this, or none of it:
  - take the items and `gold + postage` from the sender's `InvDraft`;
  - check the recipient's box count again inside it;
  - insert `mail` + `mail_items`;
  - insert `mail_log 'send'`.

  After the commit:
  - sender: `actionResult`, `inventoryUpdate` and `statsDelta`;
  - recipient, if online: `mailNew` and the line "You have a new message." [confirmed string].

**Ownership** [fact-check: the draft never said it]. `mailRead`, `mailTake`, `mailDelete` and `mailReport` resolve
`id` only among the requester's own live mails (`to_char = me AND deleted_at IS NULL`); any other id, including a
mail the requester sent, is `not_found`. Every conditional statement of a take or delete also carries
`AND to_char = ?`.

**Read and list.**
- `mailList` → `mailbox` (headers, attachments first, then newest first, up to `MAILBOX_LIST_MAX` 100, plus
  `total`). Returned mails ignore the 50 cap (below), so a box can hold more than 50; a parser bound of 50 would make
  the client drop the whole frame [fact-check].
- `mailRead {id}` → `mail` (body and attachments), and sets `read_at`.
- Allowed anywhere, while dead, and while trading or stalling (they are added to both allowlists, §8.2).

**Take.**
- `mailTake {id, part: 'all' | 'gold' | 0..4}`, in town only (`wrong_place`), not trading or stalling, not dead.
- `'all'` takes gold and every item or nothing (`inventory_full` if the bag cannot hold them all; `gold_limit` past
  `MAX_GOLD`).
- A slot number takes that one stack; `'gold'` takes the gold.
- **Transaction:** load the recipient's `InvDraft`; select the attachment rows; add them; then:
  - `DELETE FROM mail_items WHERE mail_id = ? AND slot = ?`, and each must report `changes === 1`;
  - `UPDATE mail SET gold = 0 WHERE id = ? AND gold = ?` must report `changes === 1`;
  - any other count throws and rolls back;
  - write the draft and insert `mail_log 'take'`.
- This is what makes a double take impossible, even when the offline `gm` CLI process (a second SQLite connection,
  §7) returns the same mail at the same moment.
- **Immediate transactions** [fact-check, confirmed by prototype]. The store's `db.transaction(fn)()` is a deferred
  `BEGIN` [confirmed `db.ts`; no `.immediate` anywhere in the server]. A deferred transaction that reads, then
  writes after another connection committed, throws `SQLITE_BUSY_SNAPSHOT` at once, and `busy_timeout` does not help
  (`work/tmp/pets-social/busy-snapshot.ts`: the deferred case threw `SQLITE_BUSY_SNAPSHOT`, the `.immediate()` case
  committed). Nothing is duplicated, but the request would fail with a server error. So `mailTx`, `takeTx`,
  `returnTx`, `petBagTx` and the CLI's return run as `.immediate()`, and a `SQLITE_BUSY*` answers `busy`.

**Delete.**
- `mailDelete {id}` soft-deletes (`deleted_at`) a mail with **no attachments left**. With attachments →
  `mail_attachments` "Take the items first." Retail asks "Will you delete the note?" [confirmed].

**Reply.** It is a client shortcut: it opens the compose window with `to` and "Re: subject".

**Report.**
- `mailReport {id}` sets `reported_at` and writes `mail_log 'report'`.
- Online GMs get a system line "Mail #id from X to Y was reported."
- A report makes the body readable to GMs (§4.3).

**Expiry** (the `tick` sweep every 10 min, in slices of ≤ 200 rows; also once at start):
- Every live mail has `expires_at = sent_at + MAIL_EXPIRE_DAYS` (30).
- At expiry, a mail **without** attachments is soft-deleted.
- A mail **with** attachments is **returned**: a new mail to the original sender ("Returned: subject", `return_of`,
  `from_char = NULL`, `from_name = the recipient`, **no expiry** while it holds attachments), moved in one
  transaction (the `mail_items` rows are re-pointed with conditional updates) with `mail_log 'return'`.
- Returns ignore the box cap. A returned mail never bounces again.
- If the sender is deleted, the return still goes to the deleted row, where a GM can find it (`/mail list`).
- **Recipient deleted** (soft delete of a character): its live mail is returned at the next sweep, the same way.

**Online push.** At enter-world the client gets `mailCount {unread}` (the letter icon on the menubar lights up). The
list itself is fetched on demand, so enter-world stays small. A return or send made by the `gm` CLI reaches online
players the way CLI role changes do: `game.ts refreshRoles` polls `store.dataVersion()` (`PRAGMA data_version`)
about once a second [confirmed `game.ts`, CLI header], but only for roles. So the mail module compares
`store.dataVersion()` in its own `tick` (≤ 1 Hz, no seam) and, when it changed, re-counts the unread mail of online
players and sends `mailCount`.

### 4.2 Attachments: the one place items live outside a bag

Every **persisted** item row lives in exactly one of these tables: `items` (bag/equip), `storage_items`,
`pet_items`, `mail_items` (plus `quest_items`, which never moves between them). Each move between them is one
transaction that deletes from one and inserts into the other. Ground items (`world.items`) and the shop buyback
list live in memory only [confirmed `shop.ts` header], so the fuzz counts drops, pickups and buybacks as explained
sources and sinks.

The build gets a **conservation test** (§12): a fuzz of 10,000 random operations over two characters, one pet and
the mail tables (trade, stall buy, storage, pet bag, mail send, take, return and expire, including forced throws
mid-transaction), with the sum of every item's count per code, and of all gold, checked after each step. Gold may
only drop by postage, the stall/trade rules, and GM actions. The WAVE_PLAN2 H8 hunt asked for this kind of
cross-table invariant [likely it helps here most].

### 4.3 GM moderation

`gm.ts` `COMMANDS` gains `mail` (role `gm`; some sub-commands `admin`); every run is audited (`gm_audit`):

| Sub-command | Role | Does |
|---|---|---|
| `mail list <char> [n]` | gm | Headers of a character's box and sent mail: id, from, to, subject, gold, stacks, dates, reported. **No body.** |
| `mail read <id>` | gm if reported, else admin | Shows the body (audited, with the reason "reported" or "admin"). The body goes out in `gmResult.data`, and `message` is only "Mail #id read (reason)" [fact-check]: `gm_audit.result` stores the runner's `message` (up to 1,000 characters) and the server log prints its first line [confirmed `gm.ts`], so a body in `message` would be copied into the audit table and the log. |
| `mail return <id>` | gm | Returns the mail (with its attachments) to the sender now. |
| `mail delete <id>` | admin | Soft-deletes; attachments go to a `mail_log 'gm_delete'` record that `mail restore` can re-send. |
| `mail restore <log id> <char>` | admin | Re-sends the items of a `gm_delete` record as system mail. |
| `mail send <char> [gold] [code count]… \| text` | gm | System mail ("GM"), e.g. compensation. No postage, no cap, no town rule. |
| `mail mute <char> [hours]` / `unmute` | gm | `characters.mail_muted_until`; a muted character cannot send (`muted`). |
| `mail log <char\|id> [n]` | gm | The `mail_log` rows. |

- `friends <char>`: a character's friends and blocks (gm).
- `pet …`: see §5.5.
- The offline CLI (`apps/server/src/cli/gm.ts`) gains `mail list` and `mail return` for when the server is down.
  They use the same conditional statements (§4.1), so they can run next to a live server.

---

## 5. Protocol (v1, additive; one foundation step lands all of it)

Collision check [confirmed `grep` of `protocol.ts` and `gm.ts` at `85e2e14`]:
- no request, message or GM command named `pet*`, `mail*`, `friend*` or `block*` exists;
- none of the new `ActionFailReason` values below exists in `ACTION_FAIL_REASONS`.

The sibling wave-11 specs (MOVEMENT, SCREENS) add their own names; WAVE_PLAN5 re-checks the union.

### 5.1 Constants and types (`packages/shared/src/protocol.ts`)

```ts
// ---- wave 11: pets, friends, mail (docs/PETS_SOCIAL.md) ----
export const PET_ROSTER_MAX = 4            // parser bound; live cap is config PET_ROSTER_MAX
export const PET_NAME = /^[A-Za-z][A-Za-z0-9]{1,11}$/
export const PET_BAG_MAX = 140             // [confirmed characterdata col 61]
export const PET_HGP_MAX = 10_000
export const FRIEND_MAX = 50               // parser bound; config FRIEND_MAX
export const BLOCK_MAX = 100
export const FRIEND_REQUEST_MS = 30_000
export const MAIL_ITEMS_MAX = 5
export const MAIL_SUBJECT_MAX = 32         // code points
export const MAIL_BODY_MAX = 300           // code points; the client also caps the frame at 900 UTF-8 bytes
export const MAILBOX_MAX = 50              // config MAILBOX_MAX: the cap for new (non-returned) mail
export const MAILBOX_LIST_MAX = 100        // parser bound of mailbox.mails (returns may exceed MAILBOX_MAX)

export type PetKind = 'attack' | 'pickup'
export type PetMode = 'assist' | 'defend' | 'passive'
export type PetLife = 'stored' | 'summoned' | 'dead'
export interface PetGrab { on: boolean; scope: 'mine' | 'all'; gold: boolean; equip: boolean; other: boolean; pauseInCombat: boolean }
export interface PetState {
  id: number              // char_pets.id: stable across sessions
  kind: PetKind
  family: string          // CosDef code of the family, e.g. COS_P_WOLF, COS_P_RABBIT
  name: string            // '' = unnamed (the client shows CosDef.name)
  level: number
  exp: number
  expToNext: number       // 0 at the cap or at the owner's level
  hp: number
  maxHp: number
  hgp?: number            // attack pets
  life: PetLife
  entity?: number         // the Cos entity id while summoned
  mode?: PetMode          // attack pets
  grab?: PetGrab          // pickup pets
  bagSize?: number        // pickup pets
  reviveAt?: number       // server ms a dead pet may be summoned for free
}
export type PetSlot = { bag: number } | { pet: number }
export interface FriendEntry { characterId: number; name: string; model: string; level: number; online: boolean }
export interface BlockEntry { characterId: number; name: string }
export interface MailHeader {
  id: number; from: string; system?: true; returned?: true; subject: string
  sentAt: number; expiresAt: number | null; read: boolean; gold: number; stacks: number
}
export interface MailFull extends MailHeader { body: string; items: (ItemStack | null)[] }   // length MAIL_ITEMS_MAX
```

### 5.2 Client → server (each a `GameplayRequest`, exactly one `actionResult`)

| Message | Notes |
|---|---|
| `{ t: 'itemUse'; bag: number; pet?: number }` | **additive field**: the roster id a kit, HGP potion or Grass of Life applies to |
| `{ t: 'petSummon'; pet: number }` / `{ t: 'petDismiss'; pet: number }` | §2.4 |
| `{ t: 'petMode'; pet: number; mode: PetMode }` | attack pets |
| `{ t: 'petAttack'; pet: number; target: number }` | a mob entity the owner knows |
| `{ t: 'petGrab'; pet: number; grab: PetGrab }` | pickup pets |
| `{ t: 'petName'; pet: number; name: string }` | once |
| `{ t: 'petRelease'; pet: number }` | stored and empty only |
| `{ t: 'petItem'; pet: number; from: PetSlot; to: PetSlot; count?: number }` | pet bag moves |
| `{ t: 'friendRequest'; name: string }` / `{ t: 'friendRespond'; characterId: number; accept: boolean }` | §3.1 |
| `{ t: 'friendRemove'; characterId: number }` | |
| `{ t: 'blockAdd'; name: string }` / `{ t: 'blockRemove'; characterId: number }` | |
| `{ t: 'mailList' }` / `{ t: 'mailRead'; id: number }` | |
| `{ t: 'mailSend'; to: string; subject: string; body: string; gold: number; items: { bag: number; count: number }[] }` | ≤ 5 items, distinct bag slots |
| `{ t: 'mailTake'; id: number; part: 'all' \| 'gold' \| number }` | |
| `{ t: 'mailDelete'; id: number }` / `{ t: 'mailReport'; id: number }` | |

New lists: `PET_REQUESTS`, `FRIEND_REQUESTS`, `MAIL_REQUESTS`, appended to `GAMEPLAY_REQUESTS`.

### 5.3 Server → client

| Message | When |
|---|---|
| `{ t: 'pets'; pets: PetState[] }` | enter-world (after `guild`), adopt, release |
| `{ t: 'petUpdate'; pet: number } & Partial<PetState>` | HP (throttled 500 ms like party vitals), HGP (every 10 % step), EXP (≤ 1 Hz), level, life, mode, grab, entity |
| `{ t: 'petBag'; pet: number; size: number; slots: (ItemStack \| null)[] }` | summon of a pickup pet, and after `petItem` from a fresh window |
| `{ t: 'petBagUpdate'; pet: number; slots: BagSlotUpdate[] }` | every bag change (a grab into the pet bag, `petItem`) |
| `{ t: 'petEvent'; pet: number; event: 'levelUp' \| 'died' \| 'expLost' \| 'hungry' \| 'grabOff' \| 'revived'; value?: number }` | lines and effects |
| `{ t: 'friends'; friends: FriendEntry[]; blocked: BlockEntry[] }` | enter-world |
| `{ t: 'friendAsked'; characterId: number; name: string; expiresInMs: number }` | incoming request |
| `{ t: 'friendUpdate'; friend: FriendEntry }` / `{ t: 'friendRemoved'; characterId: number }` | changes |
| `{ t: 'blockUpdate'; blocked: BlockEntry[] }` | block list changes |
| `{ t: 'friendEvent'; event: 'online' \| 'offline' \| 'added' \| 'declined' \| 'expired' \| 'removed'; name: string }` | lines |
| `{ t: 'mailCount'; unread: number }` | enter-world, and after read or take |
| `{ t: 'mailbox'; mails: MailHeader[]; total: number; cap: number }` | answer to `mailList` (after the actionResult); `mails` ≤ `MAILBOX_LIST_MAX` |
| `{ t: 'mail'; mail: MailFull }` | answer to `mailRead`, and after a take (the updated mail) |
| `{ t: 'mailNew'; mail: MailHeader }` / `{ t: 'mailRemoved'; id: number }` | arrival, delete, return |

- Pet entities are `kind: 'cos'` with `model` = the per-level CosDef code (e.g. `COS_P_WOLF_007`) and `owner`
  [confirmed `EntityState.owner` exists for cos]. Two optional additive fields:
  - `EntityState.petName?: string`, for the nameplate;
  - `EntityState.pet?: PetKind`. The client can tell a pet from a horse without the catalog. The server → client
    parser drops unknown keys [confirmed `validate.ts` header], so both fields must be added to the entity parser, or
    a pet arrives as a plain horse.
- `combat.attacker` may now be a cos id [decision; the client combat handler resolves any entity].

### 5.4 Content (`packages/shared/src/content.ts`, additive)

- `ItemUse.pet?: string`: the family code this item adopts (itemdata Desc1 → family), with `petKind`.
- `ItemUse.target` stays `'mount'` [fact-check: the draft added `'cos'` and re-exported the kits]. `item-use.ts`
  routes `use.summon || use.target === 'mount'` to `mounts.useItem` today [confirmed], so kits re-exported as
  `'cos'` would stop healing horses from the PS-X merge until the PS-FS merge (the merge order puts PS-X first).
  Instead `'mount'` keeps meaning "the own horse", and an `itemUse.pet` field redirects the kit to that pet.
- `ItemUse.hgp?: number` (HGP potion), `ItemUse.revive?: number` (Grass of Life: the HP fraction).
- `CosDef.role?: 'ride' | 'attack' | 'pickup'` (absent = `'ride'`, today's horses).
- `CosDef.levels?: CosLevel[]` for attack families: `{level, code, hp, pd, md, par, mar, er, hr, walkSpeed,
  runSpeed, skill: {min, max, castMs, cooldownMs, range}}`.
- `CosDef.bag?: number` (pickup: the base bag, default 28).
- `CosDef.clips?` stays in the sidecar, as for horses.

### 5.5 GM commands (`gm.ts` `COMMANDS`, role `gm`, audited)

- `pet <family> [level]`: adopt and summon without an item (roster cap ignored); `pet off`; `pet level <n>`;
  `pet exp <n>`; `pet hgp <n>`; `pet kill`; `pet revive`.
- `pets <char>`: list a character's roster.
- `mail …` (§4.3); `friends <char>` (§4.3).

### 5.6 Rate limits (`CLIENT_RATE_LIMITS`) and whileDead

| Types | per second / burst |
|---|---|
| `mailSend`, `friendRequest`, `blockAdd`, `petName`, `petRelease`, `mailReport` | 1 / 3 |
| `petSummon`, `petDismiss`, `friendRespond`, `friendRemove`, `blockRemove`, `mailTake`, `mailDelete`, `petGrab`, `petMode` | 2 / 5 |
| `mailList`, `mailRead`, `petAttack` | 4 / 8 |
| `petItem` | 10 / 20 |

- `whileDead`: `petDismiss`, `petGrab`, `petMode`, `petName`, `petRelease`, all friend and block requests,
  `mailList`, `mailRead`, `mailDelete`, `mailReport`.
- **Gates**: the trade `TRADE_ALLOWED` and stall `STALL_ALLOWED` sets gain `petDismiss`, `petGrab`, `petMode`,
  `petName`, the friend and block requests, `mailList`, `mailRead`, `mailDelete` and `mailReport` (read-only or
  social). Everything else new stays refused while trading or stalling, by the allowlist design [confirmed
  `trade.ts` `TRADE_ALLOWED`, `stall.ts` `STALL_ALLOWED`; the stall set is module-private, so the allowlist guard
  test asks `StallService.gate` rather than importing it].
- **The alchemy soft lock is a denylist** [fact-check]: `alchemy.ts` `FUSE_LOCKED` lists the bag-changing requests
  refused while a fuse runs (D44), so a new bag-changing request is *not* locked by default [confirmed]. Nothing
  dupes (the fuse re-checks its slots at completion [confirmed `Alchemy.complete`]), but for D44's "refused up front"
  the seam adds `mailSend`, `mailTake` and `petItem` to `FUSE_LOCKED`. MOVEMENT's MV-P edits `FUSE_CANCELLERS` in the
  same file; WAVE_PLAN5 orders the two one-line edits.

### 5.7 New `ActionFailReason` values

`pet_active`, `pet_dead`, `pet_level`, `pet_full` (roster), `pet_not_empty`, `blocked`, `friend_full`,
`already_friend`, `mailbox_full`, `mail_refused`, `mail_attachments`, `muted`.

Reused: `not_found`, `too_far`, `dead`, `in_combat`, `busy`, `requirements`, `not_usable`, `inventory_full`,
`gold_limit`, `not_enough_gold`, `invalid_slot`, `invalid_count`, `invalid_target`, `wrong_place`,
`rate_limited`, `bad_name`, `cooldown`, `no_invite`, `trading`, `stalling` [each confirmed in
`ACTION_FAIL_REASONS`]. `bad_request` is **not** an `ActionFailReason` (it is an `ErrorCode`), so no action answers
it [fact-check].

The client parser rejects unknown reasons, so server and client deploy together, as in every wave.

### 5.8 Enter-world order

`… party → guild → pets → friends → mailCount → weather`. All of these follow the modules' `enter` in registration
order (D35), and each comes after `inventory`. The three new modules register after `this.guilds` and before
`this.weather`, which is last today [confirmed `gameplay.ts` module list].

---

## 6. Persistence (one migration, append-only)

### 6.1 The migration (v10 alone; the integrator numbers it after sibling migrations)

```sql
-- 10: pets, friends, blocks, mail (docs/PETS_SOCIAL.md §6)
CREATE TABLE char_pets (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  kind TEXT NOT NULL CHECK (kind IN ('attack', 'pickup')),
  family TEXT NOT NULL,                    -- CosDef family code, e.g. COS_P_WOLF
  item TEXT NOT NULL,                      -- the adopting item code (GM audit)
  name TEXT NOT NULL DEFAULT '',
  level INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 255),
  exp INTEGER NOT NULL DEFAULT 0 CHECK (exp >= 0),
  hp INTEGER NOT NULL CHECK (hp >= 0),
  hgp INTEGER NOT NULL DEFAULT 10000 CHECK (hgp BETWEEN 0 AND 10000),
  dead_at INTEGER,                         -- NULL = alive
  summoned INTEGER NOT NULL DEFAULT 0 CHECK (summoned IN (0, 1)),
  mode TEXT NOT NULL DEFAULT 'assist' CHECK (mode IN ('assist', 'defend', 'passive')),
  grab TEXT NOT NULL DEFAULT '{}',         -- JSON PetGrab
  bag_size INTEGER NOT NULL DEFAULT 0 CHECK (bag_size BETWEEN 0 AND 140),
  created_at INTEGER NOT NULL,
  released_at INTEGER                      -- soft delete
);
CREATE INDEX char_pets_character ON char_pets(character_id);
CREATE TABLE pet_items (
  id INTEGER PRIMARY KEY,
  pet_id INTEGER NOT NULL REFERENCES char_pets(id),
  slot INTEGER NOT NULL CHECK (slot >= 0),
  code TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 1),
  plus INTEGER NOT NULL DEFAULT 0 CHECK (plus >= 0),
  durability INTEGER,
  UNIQUE (pet_id, slot)
);
CREATE TABLE friends (
  character_id INTEGER NOT NULL REFERENCES characters(id),
  friend_id INTEGER NOT NULL REFERENCES characters(id),
  since INTEGER NOT NULL,
  PRIMARY KEY (character_id, friend_id),
  CHECK (character_id <> friend_id)
);
CREATE INDEX friends_friend ON friends(friend_id);
CREATE TABLE char_blocks (
  character_id INTEGER NOT NULL REFERENCES characters(id),
  blocked_id INTEGER NOT NULL REFERENCES characters(id),
  since INTEGER NOT NULL,
  PRIMARY KEY (character_id, blocked_id),
  CHECK (character_id <> blocked_id)
);
CREATE INDEX char_blocks_blocked ON char_blocks(blocked_id);
CREATE TABLE mail (
  id INTEGER PRIMARY KEY,
  to_char INTEGER NOT NULL REFERENCES characters(id),
  from_char INTEGER REFERENCES characters(id),   -- NULL = system (GM, returns)
  from_name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  gold INTEGER NOT NULL DEFAULT 0 CHECK (gold >= 0),
  sent_at INTEGER NOT NULL,
  expires_at INTEGER,                            -- NULL = never (a returned mail holding attachments)
  read_at INTEGER,
  return_of INTEGER REFERENCES mail(id),
  reported_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX mail_to ON mail(to_char, deleted_at);
CREATE INDEX mail_from ON mail(from_char, sent_at);
CREATE INDEX mail_expiry ON mail(expires_at) WHERE deleted_at IS NULL;
CREATE TABLE mail_items (
  mail_id INTEGER NOT NULL REFERENCES mail(id),
  slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 4),
  code TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 1),
  plus INTEGER NOT NULL DEFAULT 0 CHECK (plus >= 0),
  durability INTEGER,
  PRIMARY KEY (mail_id, slot)
);
ALTER TABLE characters ADD COLUMN mail_muted_until INTEGER;
-- Every mail movement (GM audits and the conservation test; never read by gameplay)
CREATE TABLE mail_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('send', 'take', 'return', 'expire', 'delete', 'report', 'gm_send', 'gm_return', 'gm_delete', 'gm_restore')),
  mail_id INTEGER NOT NULL,
  a_char INTEGER,                 -- the actor (sender, taker)
  b_char INTEGER,                 -- the other side
  gold INTEGER NOT NULL DEFAULT 0,
  items TEXT NOT NULL DEFAULT '[]',  -- JSON ItemStack[] moved
  by_account INTEGER              -- GM account for gm_* rows
);
CREATE INDEX mail_log_mail ON mail_log(mail_id);
CREATE INDEX mail_log_at ON mail_log(at);
```

- **Why not reuse `social_log`.** Its `kind` CHECK allows only `'trade'` and `'stall'` [confirmed `db.ts`
  migration 9]. SQLite cannot alter a CHECK without rebuilding the table, and a new table is cheaper and safer
  [decision].
- **Why not a column on `items` for the pet bag.** `items` has `CHECK ((bag_slot IS NULL) <> (equip_slot IS
  NULL))` [confirmed], so a third place would need a table rebuild too. `pet_items` mirrors `storage_items`.
- **Upgrade test.** A v9 database with rows in every table migrates to v10 with nothing changed. `SCHEMA_VERSION`
  is the length of `MIGRATIONS`, and an older server refuses a newer database [confirmed `migrate()`].

### 6.2 Transactions

- `petBagTx(characterId, petId, fn(inv: InvDraft, bag: StorageDraft))`: the `storageTx` pattern [confirmed
  `storage-db.ts`] on `pet_items`. It reuses `StorageDraft`, `deposit`, `withdraw` and `moveStored` from
  `storage.ts` (gold unused).
- `pickUpFor` (the grab) = `inventoryTx` + an optional `petBagTx` branch, **in one transaction**:
  - the owner's draft first; if the item does not fit, the pet bag;
  - the ground item is removed from the world only after the commit, as a hand pickup does today [confirmed
    `pickUp`].
- `mailTx`: sender draft + `mail`/`mail_items` insert + `mail_log`, in one transaction. `takeTx`: recipient draft +
  conditional deletes and updates (§4.1) + `mail_log`. Both, `returnTx` and `petBagTx` run with `.immediate()`
  (§4.1): the existing `inventoryTx` is deferred, so these open their own immediate transaction and write the draft
  with the exported `writeDraft` inside it, the `storageTx` pattern [confirmed `db.ts`: `writeDraft` "call it inside
  one"].
- `returnTx`: conditional re-pointing, `UPDATE mail_items SET mail_id = :new WHERE mail_id = :old` inside the
  transaction that inserts the new mail and soft-deletes the old one with `WHERE deleted_at IS NULL` →
  `changes === 1`.
- **Friends**: one transaction per accept (both rows) or remove (both deletes).
- **Pets**: HP, EXP and HGP are saved at most every 5 s while they change, and on dismiss, death, level-up, logout
  and server stop (the horse's `SAVE_EVERY_MS` rule [confirmed `mounts.ts`]).

---

## 7. Abuse cases (each becomes a test, §12)

**Mail.**

1. Double take: two `mailTake {part:'all'}` in one tick, or a take while the gm CLI returns the same mail → exactly
   one succeeds, and the items exist once (the conditional updates).
2. Take with a full bag: nothing moves (all-or-nothing), `inventory_full`. The per-slot take still works for what
   fits.
3. Send, then crash mid-transaction (an injected throw after the bag write) → the bag and the mail tables are
   unchanged.
4. Send items the sender does not have (a stale slot, a count above the stack, a duplicate slot in `items`) →
   `invalid_slot` / `invalid_count`, and nothing moves.
5. Send the starter kit or an equipped item → `not_usable`. Pet-bag items can't be addressed.
6. Gold overflow: the recipient near `MAX_GOLD` → `gold_limit` on take; the mail keeps the gold.
7. Flooding: 31 mails in an hour → `rate_limited`; 11 unread from one sender in one box → `mailbox_full` for that
   sender; box at 50 → `mailbox_full`.
8. Blocked sender → `mail_refused`, nothing moves. Muted sender → `muted`.
9. Recipient deleted after the send → returned at the next sweep, and the items reach the sender.
10. Return ping-pong: a return never expires and never bounces, and the sender can always take it.
11. Oversized frame: a 300-code-point CJK body alone is about 900 bytes, so with the subject and the JSON it passes
    the 1,024-byte limit and is refused `error bad_request` [confirmed `parseClientMessage` counts UTF-8 bytes]. The
    compose window counts the whole frame (`utf8Length(JSON.stringify(msg))`, as `gm/commands.ts` does [confirmed])
    and stops typing at 900 bytes.
12. Script and control characters in the subject or body: `cleanChat` strips them, and the client renders with
    `textContent` only.
13. Trading or stalling: `mailSend`/`mailTake` refused by the gates; `mailRead` allowed.
14. Mail as a trade bypass for non-tradable items: blocked by `canTrade` (25 `*_DEF` starter items have
    `canTrade: false` [confirmed items.json]), and quest items are not in the bag.
14a. Reading, taking, deleting or reporting another character's mail by guessing ids → `not_found` (the ownership
    rule, §4.1).
14b. A GM `mail read` leaking the body into `gm_audit` or the server log → the body only travels in
    `gmResult.data` (§4.3).
14c. A `gm` CLI return racing a live take → the immediate transactions serialise them; the loser gets `busy` or
    `not_found`, never a second copy (§4.1; `busy-snapshot.ts`).

**Pets.**

15. A pet grabs an item its owner could not take (another player's window, a share-mode item for another member) →
    never (`pickupProblem` is the only rule).
16. A pet grabs through a wall or a floor → skipped by the reachability and height rules.
17. Two pets race for one item → one fetcher; the loser's scan moves on. The ground item is removed once (the
    commit order).
18. Grab while trading → paused, so no grab can land during a trade. There is no "at the same moment": the server
    is single-threaded, and a grab made before the trade opened is just part of the bag. Even if a grab did land,
    the commit re-checks each offered slot's code, plus, durability and a count ≥ the offer (SYSTEMS_SOCIAL §3.5
    [confirmed]); a grab only fills empty slots or tops up stacks, which that check allows, so the trade would
    simply go through [fact-check: the draft said the trade is refused].
19. Pet bag dupe: `petItem` with a stale slot, or a move while the pet is being dismissed → transactional; the
    dismiss does not touch the bag.
20. Release a pet with items → `pet_not_empty`. Release a summoned pet → refused `pet_active`.
21. Summon spam or summon in combat → cooldown / `in_combat`.
22. Pet level above owner (after a GM `setlevel` down) → summon refused `pet_level`, and EXP frozen.
23. Pet kill-stealing or dragging mobs across the map → the pet leash (30 m); mobs keep their own leash.
24. A pet attacks a player, an NPC or a horse → never (the target filter). Pets in the town safe area never start a
    fight.
25. Pet EXP farming by standing near a party → only while summoned, alive, within 60 m, and when the owner is in
    the kill credit.
26. Pet after owner logout → saved and despawned; no ghost entity (the `forget` hook). Two logins racing (a relog)
    → one pet entity (the horse's per-character map pattern [confirmed `mounts.ts`]).
27. Revive loop: Grass of Life on a live pet → `not_usable`; the free revive before `reviveAt` → `pet_dead`.
27a. Farming the free quest Rabbit on alts to sell the scrolls: the retail scrolls are tradable (`CanTrade` 1
    [confirmed]), but each alt must reach level 5, and a scroll is worth the 5,000-gold shop price, less than an
    hour of income. Accepted [decision]; the quest lane can give a `canTrade: false` copy if the user minds.
27b. Pet requests naming another character's roster id → `not_found` (the ownership rule, §2.1).

**Friends and blocks.**

28. A request to an invisible GM, or to a player who blocks you → "not online"; nothing reveals either.
29. Request spam → one pending request per pair, rate limit 1/s; blocked senders drop silently.
30. The friend cap on either side → `friend_full` / the retail "unable to add" line.
31. Presence leaks: an invisible GM never appears online; going invisible sends "offline".
32. Whisper to a blocker → "not online" (the existing `not_found`).

---

## 8. Build: seams and files

### 8.1 Shared (foundation step PS-P)

- `packages/shared/src/protocol.ts`, `validate.ts`, `content.ts`, `index.ts`: §5 in full, plus the validators with
  round trips.
- The mock server: new `apps/game/src/net/mock/{pets,friends,mail}.ts`, registered in `net/mock/index.ts` (the
  per-feature pattern of `net/mock/{guild,party,stall,trade}.ts` [confirmed `ls`]): pets (a wolf following), friends
  (two fake friends), and a mailbox of 3 mails, so the client lanes can build without the server.

### 8.2 Server seams (foundation step PS-FS; one agent; the lanes then own disjoint files)

| File | Seam (found by quoted code, not line number) |
|---|---|
| `apps/server/src/db.ts` | the migration (§6.1), appended |
| `apps/server/src/world.ts` | `Cos` gains `role: 'ride' \| 'attack' \| 'pickup'` (default `'ride'`), `petId?: number`, `petName?: string`, `combat?: CombatStats`; the `EntityState` decorator writes `pet`/`petName`; a `PlayerAction`-like `CosAction` type for pets (follow, engage, fetch) |
| `apps/server/src/ai.ts` | `AiHost.target(id): Player \| Cos \| undefined`, `swing(m, t: Player \| Cos)`, `ranged?(m, t: Player \| Cos, dist)`, `mobReach(m, t)` on a `Cos` radius; `retaliate(m, creditId, damage, notice, targetId = creditId)` (§2.3). `nextTarget` stays player-only: it walks `m.damage`, whose keys stay player ids [confirmed] |
| `apps/server/src/gameplay.ts` | `dealHits(a: Player \| Mob \| Cos, …)` and `attack(a, t)` widened (§2.3: `lastCombatAt`, `hwanHits`, `durability.afterHits`, `broadcastAboutEither`); the `cos` target branch dispatches on `role` (`'ride'` → `mounts.hitCos`, else `pets.hitCos`); a `creditOf(a)` (a pet → its owner's id) wherever `m.damage` is written; the `mobDied` hook gains the `shares` argument; `pickupProblem` made public as `mayPickUp(owner, item, {ignoreFull})`; `pickUpFor(owner, item, opts)` as the one pickup path (the hand pickup calls it with `into: 'bag'`); register the Pets, Friends and Mail modules after `guilds`, before `weather` |
| `apps/server/src/modules.ts` | `mobDied?(m, now, credit, shares?)` (additive) |
| `apps/server/src/alchemy.ts` | `FUSE_LOCKED` += `mailSend`, `mailTake`, `petItem` (§5.6) |
| `apps/server/src/item-use.ts` | `use(p, bag, answer, now)` gains the optional `pet` of the request; dispatch `use.pet` → `pets.adopt`; `use.hgp` / `use.revive`, or `use.target === 'mount'` **with** a `pet` → `pets.useItem`; `use.summon` or `'mount'` without a pet → the horse, as today |
| `apps/server/src/mounts.ts` | nothing (the kit keeps `target: 'mount'`; the pet redirect happens in `item-use.ts` before the mounts call) |
| `apps/server/src/chat.ts` | a `blocked(fromChar, toChar)` hook in `whisper()` → the existing "not online" answer; `/friend`, `/f`, `/mute` are client commands (below) |
| `apps/server/src/party.ts`, `social/guild.ts`, `social/trade.ts` | invite, request and trade from a blocked character → declined to the sender (one `isBlocked` call each); `TRADE_ALLOWED` gains the §5.6 read-only types |
| `apps/server/src/social/stall.ts` | `STALL_ALLOWED` gains the same |
| `apps/server/src/config.ts` | the knobs (§8.4) |
| `apps/server/src/gm.ts` | the `pet`, `pets`, `mail`, `friends` rows (runners in the lanes' files) |
| `apps/server/src/cli/gm.ts` | `mail list`, `mail return` (runner in ML-S's file) |
| `apps/server/src/connection.ts` | the enter-world order (§5.8), if not already module-driven [likely module-driven: guild is] |

### 8.3 Converter (lane PS-X, `packages/convert`)

- `src/data/cos.ts`:
  - pet families from characterdata `1/2/3/3` (levels folded into `levels[]`, the rows `_001`…`_020`, capped at
    `LEVEL_CAP`) and `1/2/3/4`;
  - `role`, `bag` (28), the attack skill numbers from skilldata (the MSKILL column reader);
  - in scope: `COS_P_WOLF`, `COS_P_RAVEN`, `COS_P_RABBIT`, `COS_P_MYOWON`, `COS_P_SEOWON`, `COS_P_RACCOONDOG`.
- `src/data/items.ts`: the six pet items with `use.pet`, `petKind`; `ITEM_COS_P_HGP_POTION_01` (`use.hgp`),
  `ITEM_COS_P_REVIVAL` (`use.revive 0.5`); the Recovery Kits stay as exported (`target: 'mount'` [confirmed
  items.json]).
- `src/data/shops` (the shops builder): a `CUSTOM_GOODS` table with `{shop, tab, name, items, price override}` for
  `STORE_CH_STABLE` TAB3 "Pet" and the two TAB4 additions (§2.6). `provenance: 'custom'` on those records.
- **Runs** (no code): `pnpm sro convert res/cos/{p_wolf_01,p_raven01,p_rabbit,p_myowon,p_seowon,p_raccoondog}.bsr`;
  the icons; the sound cues `cos.wolf.{stand,moan,die,thud,shout,hit}` and `cos.raven.{moan,die,thud,shout,hit}` in
  `src/sound/build.ts`.
- `src/tools/export-ui.ts`: one row `{ folder: 'interface/pet', include: /^pt_/ }` (gauges, `pt_messagebox`,
  `pt_stat_window`), plus the `animal/am_*` row that already exists [confirmed].

### 8.4 Config knobs (`apps/server/src/config.ts`, env names, defaults)

`PET_ROSTER_MAX` 4 · `PET_GRAB_RADIUS_M` 12 · `PET_GRAB_SCAN_MS` 250 · `PET_BAG_SLOTS` 28 · `PET_LEASH_M` 30 ·
`PET_FOLLOW_REPLAN_MS` 500 · `PET_EXP_RATE` 1 · `PET_DAMAGE_RATE` 1 · `PET_DEATH_EXP_PCT` 5 · `PET_REVIVE_WAIT_MIN` 10
· `PET_HGP_DRAIN_MS` 1500 (0 = no hunger) · `PET_HGP_POTION` 2500 · `PET_SUMMON_COOLDOWN_MS` 10000 · `FRIEND_MAX` 50
· `BLOCK_MAX` 100 · `MAILBOX_MAX` 50 · `MAIL_POSTAGE` 50 · `MAIL_POSTAGE_PER_STACK` 20 · `MAIL_EXPIRE_DAYS` 30 ·
`MAIL_SEND_PER_HOUR` 30 · `MAIL_TOWN_ONLY` 1.

### 8.5 Client seams (foundation step PS-FC; one agent)

| File | Seam |
|---|---|
| `apps/game/src/hud/guild.ts` | becomes the **community window** host: a `registerCommunityPage({id, label, build(host)})` registry over the existing `TabBar`, with Guild and Notice registered as today and nothing else changed. The existing tabs are **text** tabs on `com_long_tab` (`TabBar(art, 'long', …)` placed at (13,37,300,24) [confirmed `hud/guild.ts`]), so the new pages use text tabs too and the strip widens to 451 px. Key U stays; the menubar item is renamed "Community" |
| `apps/game/src/hud/hud-layout.ts` | `hudAnchors` gains a `petColumn` under the player frame (two 154×40 pet mini frames, `ifpetminiinfo.txt`) |
| `apps/game/src/hud/player.ts` | nothing: the horse keeps `petHost` |
| `apps/game/src/world/mount-view.ts` | the `cos` view dispatch [fact-check: the draft named `models.ts`/`entities.ts`]. `registerEntityKind` keeps **one** factory per kind and a later call replaces it [confirmed `entities.ts:648`], and mount-view registers `'cos'` → `HorseView` [confirmed `mount-view.ts:324`]. So the seam makes that factory `state.pet ? petViewFactory(state, ctx) : new HorseView(state, ctx)`, with a `registerPetView(factory)` hook PET-C fills; PET-C never calls `registerEntityKind('cos')` itself. Pet views reuse the `horseCatalog` trick (a `cos` code answers its cos.json model through `catalog.npc`) for the per-level codes |
| `apps/game/src/world/features.ts` | import and register the new `petsFeature` and `communityFeature` (stubs) [confirmed: every feature is imported there] |
| `apps/game/src/i18n/index.ts` | register `en-pets`, `en-friends`, `en-mail` |
| (no edit) `apps/game/src/world/chat.ts` | `ChatBox.registerPrefix(prefix, fn)` already exists [confirmed `chat.ts:448`; the horse's `/dismount` and `/unsummon` use it, `world/features/mount.ts`]. CM-C's feature registers `/friend`, `/f` and `/mute`. **Nobody registers `/pet`** [fact-check]: a prefix claims the line *before* the GM-command path [confirmed `ChatBox.submit`, `registerPrefix` doc], so a client `/pet` would swallow the GM command `/pet COS_P_WOLF 5` (§5.5). `/friends <char>` (GM) is safe: `matchPrefix` needs a space or the end after `/friend` [confirmed `matchPrefix`] |
| `apps/game/src/hud/options.ts` | `registerOptionRow` for "Hide other players' pets" (Game page) |
| `apps/game/src/i18n/` | new files `en-pets.ts`, `en-friends.ts`, `en-mail.ts` (retail strings from `ui-strings-pets-social.tsv` where they exist) |
| `apps/game/src/hud/menubar.ts` | a letter icon with the unread count (`mailCount`) |

---

## 9. UI on the retail kit (docs/UI.md)

All windows are kit windows (`ui/kit/window.ts`, 8-piece frames, live English text, `textContent` only). Rects are
the retail ones [confirmed §1.5 and `retail-layouts-cos.txt`], at the UI scale of UI.md §4.1.

### 9.1 Community window (key U, `mframe_wnd_` 477×393)

Tabs over the page `equip_window_` (13,61,451,320): **Guild**, **Notice** (existing), **Friends**, **Messages** and
**Block**, as text tabs on `com_long_tab` like the two existing ones [decision; fact-check: the draft proposed the
`gil_friend_tab`/`gil_note_tab`/`gil_cut_tab` icon tabs, which would mix two tab styles in one strip; the art stays
exported for Q14].

- **Friends page** (`iffriend.txt`):
  - the frame, the list and the side tile at the §1.5 rects;
  - rows are `gil_bar02` 24 px: lamp, race mark, name, and our addition, the level (right-aligned, `--c-level`);
  - buttons at (352,55) **Whisper**, (352,84) **Add friend** (a kit input dialog "Type character name…"), (352,113)
    **Delete friend** (confirm "Will you delete [%s] in the friends list?");
  - the count "Friend 12/50" at (353,27);
  - online first, then by name. Double-click whispers.
- **Messages page** (`ifletter.txt`):
  - rows: race mark, sender, received time ("Forenoon/Afternoon h:mm", the retail strings), plus a clip icon
    (`com_*` attachment mark) and bold when unread;
  - buttons **Send msg**, **Read msg**, **Delete msg**. Guild msg and Union msg are hidden (out of scope);
  - the count "Msg 7/50".
- **Block page** (`ifblocking.txt` / `ifwhisperblockingslot.txt`): the list, and **Add** / **Remove**.

### 9.2 Letter windows (`msgbox2_window_`)

- **Write** (`ifletterwrite.txt`, 439×271, extended to **439×335**):
  - "To" (110,56,170,20); **Subject** (our addition, a second line at y 78);
  - contents (16,100,408,123) with a byte counter;
  - then an attachment strip at y 232: 5 × 32-px slots on `com_blacksquare_`, the retail slot art. Drag from the
    bag, right-click to remove;
  - a gold box `exc_box` with `com_moneybutton` (the exchange window's gold art [confirmed exported]) and a postage
    line "Postage: 150 gold";
  - Send / Cancel move down 64 px.
  - Outside town, the strip is disabled with "Attachments can only be sent in town."
- **Read** (`ifletterread.txt`, extended the same way): From, subject, contents, the attachment strip (click a slot
  = take that stack; **Take all**), gold (click = take), then Reply / Delete / Close, plus a small **Report** text
  button.

### 9.3 Pet UI

- **Pet mini frames** (`ifpetminiinfo.txt`, 154×40 each [confirmed: the horse's frame uses the same 154×40 host,
  `hud/player.ts` `petHost` at (53,55)], stacked in `petColumn`): picture (4,4,32,32; the pet
  icon), name (44,7,73,13), level (118,7,34,13, `--c-level`), HP gauge `pmi_pet_hp` (41,23), HGP gauge
  `pmi_pet_hgp` (41,29; attack pets only), and the low-HP caution effect (`APPLY_UI_4TH`). Click opens the COS
  window. Dead: the picture is greyed, with the revive time.
- **COS window** (`ifcos.txt`, `int_window_` 331×314), three tabs:
  - **Basic Info** (`ifcosinfo.txt`):
    - name with **Create name** (`com_mall_button` (232,41)), only while unnamed;
    - the HP, HGP and EXP gauges (`pt_hp`, `pt_hgp`, `pt_exp` at (75,89/119/148,228,12)) with percentages;
    - Level, Hit ratio, Physical attack/defence, Parry, Magical attack/defence at the retail rects;
    - pickup pets show "<Stat does not exist.>" (`UIIT_MSG_COS_NOT_ABILITY`) [confirmed string].
  - **Inventory** (`ifcosinventory.txt`, pickup pets): the 7 × 4 lattice (41,59,252,144); the page spinner is shown
    only if `bagSize` > 28. The trade rows (gold total, trade level, "Sell all") are hidden (trade goods are out of
    scope).
  - **Setting** (`ifcossetup.txt`, pickup pets): Grab function ON/OFF; Target grab authority "Grab only my items" /
    "Grab all items"; Target item Gold / Equipment / Other items; our extra check "Pause while fighting"; OK /
    Cancel.
  - Attack pets show a **Mode** group (Assist / Defend / Passive) in the same Setting tab.
  - A **roster strip** at the top: up to 4 pet icons (summoned ones outlined with `cos_outline_2`), with Summon /
    Dismiss / Release buttons. It is custom, on retail slot art.
- **Command bar** (`ifcoscommand.txt`: `am_ctrl_tab` + open/close) next to the attack pet's mini frame: Attack,
  Follow, and the retail keys Insert (info), PgUp (unsummon), Del (follow) [confirmed strings], registered in
  `hud/keys.ts` only while a pet is summoned. They do not collide with today's bindings; the lane checks
  `keyhelp.ts`.
- **Nameplates**: "Name (Owner)" in the NPC-plate style, only within 20 m; `petName` when set.
- **Options**: Game → "Hide other players' pets" (default off). Hidden pets are not drawn at all (no mesh, no
  animation update).

### 9.4 Client views

- **`world/pet-view.ts`** (new):
  - generalises the horse's `mount-view.ts` pieces (catalog lookup, the glb, and the STAND1/WALK/RUN choice from
    speed);
  - adds ATTACK1 on the pet's `combat` swings, DIE1 → DIE1_RM, PICK when a grabbed item's `despawn` arrives within
    2.5 m of the pet (a client-only cue), and EMOTION01 when idle for 20 s (a charm, no server);
  - per-level model code → the same family glb (every wolf row uses `p_wolf_01` [confirmed]).
- The **wolf has no DAMAGE clip** [confirmed]: a hit on it shows the hit number and a 120-ms red tint instead.

---

## 10. Budgets (1080p, dev PC = Ryzen 5 9600X + RX 9060 XT, Chrome; WAVE_PLAN3 §5.2 format)

**Per-mob cost, the base of every row** [measured in `work/tmp/w9-finish/budgets.md`; re-derived at the
fact-check]. The 20-Mangnyang crowd vs the plaza, divided by 20:

| Preset (backend) | CPU p50 slope | frame p95 slope |
|---|---|---|
| Low (WebGPU) | 2.7 → 2.8 ms: 0.005 ms/mob | 3.8 → 4.2: 0.02 |
| Medium (WebGPU) | 9.5 → 11.8: **0.115** | 11.4 → 14.4: **0.15** |
| Medium (WebGL2, 40 vs 20 mobs) | 9.1 → 11.5: 0.12 | 11.3 → 13.4: 0.105 |
| High (WebGPU, after cut 4, today's High) | 15.2 → 18.8: 0.18 | 17.9 → 21.5: 0.18 |
| Ultra (WebGPU) | 17.1 → 19.9: 0.14 | 19.8 → 22.9: 0.155 |

[fact-check: the draft labelled frame p50 values (9.7 → 12.0) as CPU p50, applied p50 slopes to p95 rows, and used
the pre-cut High row.]

**A pet is 1–2 Mangnyangs.** The Mangnyang glb has 2 meshes; the wolf and raven have 3 and the pickup pets 4 (§1.3)
[confirmed mesh counts]. Part of an actor's cost is per actor (skeleton, animation), part per draw, so a pet is
costed between 1× the lowest slope and 2× the highest [projected]: at Medium WebGPU **0.115–0.30 ms per pet**. Pets
use the existing animation LOD (`ANIM_LOD`: 10–30 Hz by screen size, 10–20 Hz off screen [confirmed
`three/models.ts`]); the draft's own per-preset animation rates would have duplicated it.

| Preset | Others' pets drawn (max / range) | Pet shadow casters | Worst case: cap + own 2 [projected] | + GPU (mid) [projected] | Crowd p95 after (dev) [projected] |
|---|---|---|---|---|---|
| Low | 4 / 40 m | none (no CSM on Low [confirmed `quality.ts` `shadows: null`]) | 6 pets ≈ +0.03–0.24 ms CPU | < 0.05 ms | WebGPU 4.2 → ~4.3–4.5 ms |
| Medium | **4** / 50 m | own pets only, within 50 m (≤ 16 caster draws ≈ 0.1 ms, inside the slope) | 6 pets ≈ **+0.7–1.8 ms** (WebGPU) / +0.6–1.4 ms (WebGL2) | ≤ 0.1 ms | WebGPU 14.4 → **~15.1–16.2 ms** (pass < 16.7, thin at the top); WebGL2 11.3 → ~11.9–12.7 |
| High | **2** / 60 m | own pets only (the 50-m character rule [confirmed `3dad3ef`]) | 4 pets ≈ +0.7–1.4 ms | ≤ 0.15 ms | 21.5 → ~22.2–22.9 ms (High already misses; pets must not add > 1.5 ms) |
| Ultra | 12 / 80 m | all within 80 m | 14 pets ≈ +2.0–4.3 ms | ≤ 0.2 ms | not a default |

What the table means, honestly:

- **The cap is what keeps Medium at 60 fps.** The draft's Medium cap of 8 (10 pets) projects to +1.15–3.0 ms, a
  crowd p95 of 15.6–17.4 ms, which can fail; hence 4 [fact-check]. Without any cap, a party of 8 friends each with
  two pets (18 pets) adds 2.1–5.4 ms, a crowd p95 of 16.5–19.8 ms [projected].
- **The caps are config, not code**: the PET-C bench measures the real per-pet cost, and if it is ≤ 0.12 ms p95 at
  Medium WebGPU, the Medium cap may go back to 8 (the user's call, N7).
- **High is not made worse by more than the cap.** The High miss is the separate perf item (BACKLOG item 9).
- **Pets are never merged or instanced** in this wave; the perf pass may.
- **VRAM**: six pet families, about 1–3 MiB of retail textures each (the pet `.ddj` sizes, checked in PS-X) [likely],
  under 20 MiB in all.
- **Server**:
  - the pets tick ≤ 0.3 ms per world tick (10 Hz) with 40 summoned pets (`worstTickMs` +0.3);
  - the grab scan considers ≤ 50 ground items per pet per scan, through the world's item map filtered by distance
    first [projected];
  - mail and friend transactions ≤ 2 ms each on the WAL database; the expiry sweep ≤ 20 ms per 200-row slice.
- **Network**:
  - a following pet sends ≤ 2 `move`s per second per viewer (re-plan ≥ 500 ms, 3-m slack);
  - `petUpdate` HP ≤ 2 Hz;
  - presence: one `friendUpdate` per enter or leave per online friend.
- **UI**: the community window builds ≤ 8 ms on open (≤ 50 + 50 rows) and costs 0 per frame when closed. Pet mini
  frames update only on `petUpdate`.

**Per-lane gates** (each measured with the minimum of 5 runs, no other GPU page open, the GPU lock held):

| Lane | Gate |
|---|---|
| PET-C | 6 pet actors (the Medium cap: 4 others' + own 2, two of them 4-mesh pickup pets) in the plaza add ≤ 1.2 ms CPU p50 and ≤ 1.8 ms frame p95 on Medium WebGPU and WebGL2; it reports the measured cost per pet, which sets the caps (§10); 0 allocations per frame in the follow/interp path (heap snapshot diff) |
| PET-S | `worstTickMs` +≤ 0.3 ms with 40 summoned pets grabbing in a 20-mob fight (server bench) |
| CM-C | the window opens ≤ 8 ms with 50 friends and 50 mails; no per-frame cost when closed |
| ML-S | send/take ≤ 2 ms; sweep ≤ 20 ms per slice; the conservation fuzz (10,000 steps) passes |
| Whole game | Medium p95 < 16.7 ms in the crowd with the Medium cap of pets (6) on WebGPU and WebGL2 |

---

## 11. Lanes

### 11.0 Step order

```
step 0 (parallel):  PS-P (protocol, shared, mock)  |  PS-X (converter + export runs)
step 1 (parallel, after PS-P):  PS-FS (server seams + migration)  |  PS-FC (client seams)
step 2 (parallel, after step 1):  PET-S | FR-S | ML-S | PET-C | CM-C
step 3:  I11S (integration), H11S (adversarial hunt), fixes
```

In WAVE_PLAN5, PS-P/PS-FS/PS-FC merge with the MOVEMENT and SCREENS foundations into one P + FS + FC step. They
share `protocol.ts`, `validate.ts`, `gameplay.ts`, `db.ts` and `config.ts`.

### 11.1 Lane table

| Lane | Owns (files) | Seams it uses | Tests | User check | Depends on |
|---|---|---|---|---|---|
| **PS-P** | `packages/shared/src/{protocol,validate,content,index}.ts` (additive), new `apps/game/src/net/mock/{pets,friends,mail}.ts` + their line in `net/mock/index.ts`, `docs/PROTOCOL.md` (wave-11 subsection) | — | `packages/shared/test/pets-social-protocol.test.ts`: round trip of every new message; rejects (bad `part`, 6 items, duplicate slots, `PET_NAME`, 301-code-point body, unknown reason); `itemUse` with and without `pet` | none (no visible change) | — |
| **PS-X** | `packages/convert/src/data/{cos,items}.ts`, the shops builder's `CUSTOM_GOODS`, `src/sound/build.ts` (cue rows), `src/tools/export-ui.ts` (one row); runs: 6 BSRs, icons, sounds | — | `packages/convert/test/cos-pets.test.ts`: wolf levels 1–20 (HP 360/1,205/2,517, speeds, skill 23–25 → 165–193), rabbit bag 28 and role `pickup`, horse unchanged (`role` absent); `items`: 6 pet items with `use.pet`, kits unchanged (`target:'mount'`); `shops`: STABLE has tabs Vehicle, Pet, Pill potion (+HGP, Grass of Life) with the custom prices | `/out/cos/p_wolf_01.glb` opens in the viewer with its 14 clips | PS-P (types) |
| **PS-FS** | `apps/server/src/{db,world,ai,gameplay,modules,item-use,alchemy,chat,config,gm,connection}.ts` seam lines, `party.ts`/`social/{guild,trade,stall}.ts` (block calls + allowlists), `cli/gm.ts` (registration) | — | `apps/server/test/migration-v10.test.ts` (a v9 db with rows migrates unchanged; the new CHECKs reject bad rows); `seams-pets-social.test.ts` (a stub Cos attacker credits its owner in `m.damage` while the mob targets the Cos; a mob hit on a `role:'attack'` Cos does not reach `mounts.hitCos`; `mobDied` hooks receive `shares`; `pickUpFor(into:'bag')` equals the old pickup; a stub `isBlocked` turns a whisper into `error not_found`; the allowlists contain the §5.6 types; `FUSE_LOCKED` holds the three new types; a kit with no `pet` still heals the horse); **the whole server suite unchanged** | none | PS-P |
| **PS-FC** | `hud/guild.ts` (the page registry only), `hud/hud-layout.ts` (`petColumn`), `world/mount-view.ts` (the `cos` factory dispatch + `registerPetView`), `world/features.ts` (two stub features), `hud/options.ts` (one row), `hud/menubar.ts` (letter icon), `i18n/en-{pets,friends,mail}.ts` + `i18n/index.ts` | — | `apps/game/test/community-pages.test.ts` (Guild and Notice still the first two tabs; a registered page appears); `hud-layout` snapshot with `petColumn`; a `cos` state without `pet` still makes a `HorseView`; the existing guild and mount tests unchanged | the guild window looks exactly as before | PS-P |
| **PET-S** | new `apps/server/src/pets/{pets,pets-store,pet-ai,pet-grab,pet-bag,pet-rules,gm-pet}.ts` | `Cos.role`, `AiHost` union, split `retaliate`, `dealHits` union + `creditOf` + the role dispatch, `mobDied` shares, `mayPickUp`/`pickUpFor`, the item-use dispatch, config knobs, GM rows | `apps/server/test/pets-*.test.ts`: adopt (item consumed, row, summon); caps and every §2.4 refusal; follow re-plan cadence; leash warp; grab rules (§2.5 table, one test per row); bag-then-pet-bag-then-off; pauses (trading, dead); fetch race (§7.17); assist/defend/passive; credit to owner (EXP, loot owner, quest credit); a mob retaliates on the pet, then the owner; EXP cap at owner level; level-up swap; HGP drain and × 0.5; death, EXP loss, Grass of Life, free revive time; owner death dismisses; logout/enter restore; GM `pet` | as a GM: `/pet COS_P_WOLF 5`; the wolf follows, attacks your target and levels; `/pet COS_P_RABBIT`; it grabs your drops but not a friend's | PS-FS, PS-X data |
| **FR-S** | new `apps/server/src/social/{friends,friends-store,friend-rules,gm-friends}.ts` | chat `blocked` hook, `isBlocked` exports, gates | `apps/server/test/friends.test.ts`: request/accept/decline/expire; mutual rows; caps both sides; remove both ways; online/offline/level presence; invisible GM hidden; block effects (whisper, request, mail, party, guild, trade); prune of deleted characters | two accounts: add, see the lamp go on and off, whisper from the list, block, and the blocked whisper says "not online" | PS-FS |
| **ML-S** | new `apps/server/src/social/{mail,mail-store,mail-rules,gm-mail}.ts`; the CLI runner | gates, `inSafeArea`, `isBlocked` (from FR-S's export, duck-typed until merge, the `berserking` pattern [confirmed `mounts.ts`]) | `apps/server/test/mail-*.test.ts`: every §4.1 rule and refusal; §7 cases 1–14c one test each (ownership, audit redaction, CLI race); expiry and return; a box above 50 through returns lists without breaking the parser bound; deleted recipient; GM sub-commands and roles; CLI return next to a live store (two connections); **conservation fuzz** (§4.2) | two accounts: mail 3 potions + 500 gold to an offline friend; they log in, see the icon, take all; an old mail returns (GM `/mail return`) | PS-FS |
| **PET-C** | new `apps/game/src/world/{pet-view,features/pets}.ts`, `hud/{pet-frame,cos-window,cos-command,pet-state}.ts` | `petColumn`, the pet dispatch, options row, i18n | `apps/game/test/pet-state.test.ts` (roster book from `pets`/`petUpdate`; settings round trip); `pet-view` clip choice (speed → WALK/RUN, swing → ATTACK1, PICK cue); frames hidden with no pet; LAB-style bench: 6 pets in the plaza (§10 gate), reporting the cost per pet | the pet frames, COS window tabs, grab settings, mode buttons, keys; hide others' pets | PS-FC, PS-X runs |
| **CM-C** | new `apps/game/src/hud/{friends,friends-state,mail,mail-state,mail-compose,block}.ts`, `world/features/community.ts` (the `/friend`, `/f`, `/mute` prefixes and the message wiring) | the community page registry, menubar icon, `ChatBox.registerPrefix` | `friends-state` (sort, counts, presence updates), `mail-state` (headers, unread, take updates), `mail-compose` (byte counter stops at 900; town flag disables attachments; postage text) | the Friends, Messages and Block pages; compose, read, reply, take, delete, report | PS-FC |
| **I11S** | integration (merge order: PS-P → PS-X → PS-FS → PS-FC → FR-S → ML-S → PET-S → CM-C → PET-C) | — | the whole suite + typecheck after each merge; the §10 gates; PLAYTEST.md gains a "Pets, friends and mail" section; DEPLOY.md gains the knobs; DATA.md/ASSETS.md gain `out/cos/p_*`, `out/ui/pet/` | the §11.2 checks | all |
| **H11S** | reads only, then files fixes | — | the §7 list as lenses, plus: allowlist drift (a new request type reachable while trading); presence leaks; `combat.attacker` pointing at a despawned pet; `FUSE_LOCKED` drift (a new bag-changing type missing); a client chat prefix shadowing a GM command; enter-world order; the v9 → v10 upgrade on a copy of the live database (read-only copy, never the live file) | — | I11S |

### 11.2 User-visible checks (browser, two accounts; added to docs/PLAYTEST.md)

1. Buy a Rabbit at Machun's Pet tab; use the scroll; the rabbit appears and the scroll is gone. Kill Mangyangs: the
   rabbit runs to your drops and gold. A friend's drop stays (until 30 s pass with "Grab all items").
2. In a party with "share" items, the rabbit takes only your round-robin items. Party gold is split.
3. Fill your bag: the rabbit's bag fills next; then "The grab setting has been set OFF…".
4. Buy the Grey Wolf; it fights your target; its EXP bar moves; it stops at your level. Let it die; Grass of Life
   revives it; or wait 10 minutes.
5. Friends: add a friend; see "has logged on/off"; whisper from the list; block them; their whisper says "not
   online".
6. Mail: send items and gold to an offline friend in town (outside town, text only). They log in, see the icon,
   take all. A full bag refuses "Take all" but single stacks work.
7. GM: `/mail list <name>`, `/mail return <id>`, `/mail send <name> 1000 ITEM_ETC_HP_POTION_01 10 | Sorry for the
   downtime`.
8. Graphics: in the plaza with 5 friends and their pets on Medium (4 of the others' pets drawn, the cap), the perf
   overlay stays under 16.7 ms p95.

---

## 12. Tests and gates (summary)

- Every lane: its tests, `pnpm typecheck`, and the whole suite green at hand-off. Lanes do not run other lanes'
  benches.
- **Migration**: v9 → v10 on a fixture database with rows in every table; an older server refuses v10.
- **Conservation fuzz** (ML-S, with PET-S's bag): 10,000 random operations, including injected throws; item counts
  per code and total gold are conserved except for the explained sinks.
- **Allowlist guard**: a test enumerates `GAMEPLAY_REQUESTS` and asserts each new type is either in the trade and
  stall allowlists or refused while trading, and that every new bag-changing type is in `FUSE_LOCKED` (a denylist,
  so it does not lock new types by itself).
- **Chat-prefix guard**: no client `registerPrefix` word equals a GM command name (`COMMANDS` keys), so no GM command
  is shadowed.
- **Budget gates**: §10.
- **Low guard**: the wave-9 Low + classic sky + weather off regression test stays green (pets add no shader
  defines).

---

## 13. Scope-cut order (cut from the top)

1. Pet naming (unnamed pets show the family name).
2. The emotion idle and the PICK client cue.
3. Mail **Report** and the GM "reported" body access (GMs see metadata only; admins keep `mail read`).
4. The Three Footed Crow (the wolf stays the only attack pet).
5. Monkey, Squirrel and Raccoon dog (the Rabbit stays the only pickup pet).
6. Hunger (HGP): `PET_HGP_DRAIN_MS 0`, and the gauge and potion are hidden.
7. The Block **page** (blocking stays through `/mute name` and a friend-row menu).
8. The attack-pet death EXP loss and the free-revive wait (death then only needs Grass of Life; or the reverse, the
   user's pick).
9. The pet bag (loot goes to the owner's bag only; full = grab off).
10. Attack-pet modes beyond assist (defend/passive).
11. The custom pet quest (pets from the shop only).
12. Mail expiry and returns (mail waits forever; the sweep is off; GM `/mail return` stays).

**Never cut:** the roster model; the pickup pet with the exact party loot rule and the pauses; the attack pet with
follow, assist, owner credit, levels ≤ owner, death and Grass of Life; the budget caps; friends add/remove/online and
the whisper button; block for whispers; mail with items and gold, its conditional transactions and `mail_log`; GM
`mail list/return/send`; the migration; the conservation fuzz.

---

## 14. Needs from the user (each has a default, so nobody waits)

| # | Need | Default |
|---|---|---|
| N1 | Which pets to sell and at what price; the free pickup pet quest | Grey Wolf 30,000, Three Footed Crow 45,000, Rabbit 5,000, Monkey/Squirrel/Raccoon dog 8,000 at Machun's Pet tab; Grass of Life 5,000; a level-5 quest gives a Rabbit |
| N2 | Keep retail's pet rental timer (28 days)? | No expiry |
| N3 | Hunger (HGP) on or off, and how fast | On, gentle: 30 % after ~2.9 h summoned; a potion restores 25 % |
| N4 | Free revive after a wait, or Grass of Life only | Both: 10-minute free revive at 30 % HP, or Grass of Life at once at 50 % |
| N5 | Mail attachments town-only? | Yes for sending and taking attachments; text anywhere |
| N6 | May GMs read mail text? | Only mail the recipient reported (and admins, audited) |
| N7 | Caps and postage; how many other players' pets to draw | 50 friends, 100 blocks, 50 mails, 5 stacks per mail, postage 50 + 20 per stack; others' pets drawn 4 / 4 / 2 / 12 (Low / Medium / High / Ultra), raised on Medium to 8 only if the PET-C bench measures ≤ 0.12 ms per pet (§10) |
| N8 | Confirm retail pet models (your "new 3D models for trees only for now") | Retail models and clips; pet textures can join a later B4 upscale batch |
| N9 | A playtest session with a second account (or a friend) for §11.2 | After I11S |

---

## 15. Open questions (each has a default)

| # | Question | Default |
|---|---|---|
| Q1 | Retail grab radius | 12 m from the owner [unknown] |
| Q2 | Base pet bag: 28 (one lattice page) or 140 (characterdata) | 28, knob up to 140 [likely] |
| Q3 | Retail: does grabbed loot go to the character bag or the pet bag first? | Character bag first, then the pet bag [likely from PICKITEM1/2] |
| Q4 | Do aggressive mobs acquire pets on sight? | No: only by retaliation [decision] |
| Q5 | Pet EXP share | 100 % of the owner's kill EXP share, capped at the owner's level [unknown retail] |
| Q6 | HGP potion Param1 = 10: percent, thousands, or points? | Treated as unknown; restore 2,500 of 10,000 |
| Q7 | Friend removal one-sided or mutual? | Mutual [decision] |
| Q8 | Pet names unique like retail? | Not unique [decision] |
| Q9 | Pickup pets attackable? | No [likely retail] |
| Q10 | Pets on owner death | Dismissed (not dead), re-summon after respawn |
| Q11 | Pets while mounted | Allowed; the attack pet defends only |
| Q12 | Pet statuses and knockdown (retail DOWN clips) | None in v1 |
| Q13 | Pet damage balance: a level-20 wolf swings 165–193 (×104 % in the row) once per 4.0 s, about 45 raw damage per second before defence [projected from §1.2; its share of a player's DPS is unknown until `sim.ts` runs] | `PET_DAMAGE_RATE 1`; the balance lane re-runs `sim.ts` with a pet and tunes the knob |
| Q14 | Community window tabs for Friends / Messages / Block: text or the retail icon art | Text tabs on `com_long_tab`, like Guild and Notice today [confirmed `hud/guild.ts`]; the `gil_friend_tab` / `gil_note_tab` / `gil_cut_tab` art stays exported for a later look |
| Q15 | Chat commands `/friend`, `/f`, `/mute`, `/pet` vs GM command names | The client registers `/friend`, `/f` and `/mute` (`ChatBox.registerPrefix`, as `/dismount` does); none is a GM command today [confirmed `gm.ts` `COMMANDS`]. **`/pet` stays the GM command only** (§5.5): a client prefix runs before the GM path and would swallow it [fact-check, confirmed `ChatBox.submit`] |
