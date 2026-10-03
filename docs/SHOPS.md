# NPCs, shops, consumables and storage (vSRO 1.188, Jangan, level cap 20)

This spec covers the Jangan NPCs and what they offer, the four Jangan shops and their goods, NPC dialogs, consumables (potions, pills, return scrolls), the storage keeper, and the economy and abuse rules. It ends with the protocol additions and a build plan in parallel lanes.

It is a spec, not code. Everything here follows `docs/PROTOCOL.md`:

- the server is authoritative;
- client frames are validated strictly;
- every gameplay request gets exactly one `actionResult`, in FIFO order;
- changes to protocol v1 are additive;
- content is referenced by CodeName128 ids.

The message and type names defined in `docs/SKILLS.md` §10.2 are reused where needed and never redefined: `useSkill`, `skillLearn`, `masteryUp`, `buffCancel`, `hotbarSet`, `skills`, `skillsUpdate`, `cast`, `castEnd`, `effectAdd`, `effectRemove`, `HotbarEntry` and `EffectState`.

## Status tags

- **[confirmed]**: checked in our export (`work/out/data/*.json`), the client textdata (`Media.pk2 server_dep/silkroad/textdata`), or our code.
- **[likely]**: consistent with the data and with vSRO behaviour as commonly documented, but not verified against a retail capture.
- **[unknown]**: nothing in our data settles it. A config value or rule stands in for it.
- **[decision]**: a design choice for this project, not a claim about retail.

## Sources

- **Export:** `work/out/data/npcs.json` (46 records), `shops.json` (4), `items.json` (514), `towns.json`, `levels.json`, and `export-report.json`, whose `shopsDroppedGoods` lists the goods left out of scope.
- **Client tables:** refshopgroup, refmappingshopgroup, refmappingshopwithtab, refshoptab, refshoptabgroup, refshopgoods, refscrapofpackageitem, refpricepolicyofitem, itemdata_*.txt, npcchat.txt, `textquest_speech&name.txt`, textuisystem.txt, teleportdata.txt and levelgold.txt. All are UTF-16LE.
- **Code:** `apps/server/src/{gameplay,inventory,db,world,connection,formulas}.ts`, `packages/shared/src/{protocol,validate,content}.ts`, `packages/convert/src/data/{items,npcs}.ts`, and `apps/game/src/hud/*`.

## 0. What exists today [confirmed]

The protocol and the server already have part of this:

| Piece | State |
|---|---|
| `shopBuy {npc, item, count}` / `shopSell {npc, bag, count?}` | Implemented in `gameplay.ts` (`shopNpc`, `shopBuy`, `shopSell`). They check `NPC_INTERACT_RANGE` = 8 m (centre to centre) and use `ItemDef.price` / `sellPrice`, inside `store.inventoryTx`. |
| `itemUse {bag}` | Implemented in `gameplay.ts` `itemUse`. It handles HP/MP (flat and %) and `cooldownGroup`, with a 1000 ms default (`formulas.ts` `POTION_COOLDOWN_MS`). The return scroll teleports **instantly** and is refused in combat, because the cast is not simulated. Pills answer `not_usable`. |
| NPC entities | Spawned in `Gameplay.start` from npcs.json (`world.ts` `Npc {kind, id, code, name, pos, yaw}`), and sent as `EntityState {kind: 'npc'}`. |
| Client | Content tables load npcs and shops (`apps/game/src/content/gameplay.ts`). The HUD already reports `shopBuy`/`shopSell` failures (`hud/index.ts` `OWN_REQUESTS`). **There is no NPC dialog, shop window or storage window.** The mock server (`net/mock.ts`) handles shopBuy/shopSell/itemUse. |
| Durability | `ItemStack.durability?` and the `items.durability` column exist, with null meaning full. Nothing ever lowers it (§2.6). |
| Storage | Nothing exists. |

Small defects found while reading, which the build plan fixes:

1. `shopBuy` caps `count` at `def.maxStack * 48`, which hard-codes the bag size.
2. `addGold` silently clamps at `MAX_GOLD` (`inventory.ts`), so a sale at the cap loses gold.
3. Shops sell items above `LEVEL_CAP`: the degree-3 chest pieces need level 21.
4. The return scroll is instant.
5. Pills can never be used.

## 1. Jangan NPCs

### 1.1 The data chain [confirmed]

- `npcs.json` NpcDef comes from `npcpos.txt` (placements), characterdata (code, name, model), refregion (the CHINA continent) and teleportdata (the `teleport` role).
- `roles`:
  - `shop` comes from the refshop chain;
  - `storage` is set for the WAREHOUSE codes;
  - `teleport` comes from teleportdata.
- Positions are glTF metres in the manifest frame, where +x is east and +z is **south**.
- The town return point is `towns.json` JANGAN `spawn` = (96.9, −3.317, −136.9), from teleportdata `GATE_CH` (region 25000, (969, 0, 1369)). The world manifest's own `spawn` is the same GATE_CH point (y −3.26) [confirmed `work/out/world/jangan/manifest.json`], and the server's spawn order (`apps/server/src/content.ts`) is SPAWN_X/Z env → manifest spawn → towns.json → region centre, so `Gameplay.townPoint()` lands there unless SPAWN_X/Z is set [confirmed].
- The safe area is the box centred on (82.7, −198.8) with half extents 256.0 × 178.7 m.

**Greetings.**

- `npcchat.txt` maps each NPC code to the string ids `SN_<code>_BS` and `SN_<code>_PS`.
- The English text of `_BS` is in `textquest_speech&name.txt`: column 8 (0-based) of the row whose column 1 is the id.
- All 46 Jangan NPCs have an npcchat row; 45 have a `_BS` string (NPC_BATTLE_ARENA_MANAGER has none, and NPC_CH_WAREHOUSE_M's is just "...") [confirmed]. No `_PS` strings exist for the Jangan NPCs [confirmed]. This is a gap in the export: strings.json holds only character-creation strings (plus the starter `_DEF` item names), so the greetings must be exported (§7.5).

### 1.2 Every Jangan NPC

Distances and bearings are measured from the town return point (0° = north, 90° = east).

| Code | English name | Where (x, z) | From spawn | Role | vSRO offers [confirmed from refshop chain / greeting] | Our plan [decision] |
|---|---|---|---|---|---|---|
| NPC_CH_SMITH | Blacksmith Chulsan | (33.3, −140.7) | 64 m W | blacksmith | STORE_CH_SMITH "Purchase/ Sell/ Repair Chinese Weapon": weapons, shields, arrows; repair | Shop (+ Repair later) |
| NPC_CH_ARMOR | Protector Trader Mrs Jang | (33.2, −108.5) | 70 m WSW | armour trader | STORE_CH_ARMOR: group 1 "…Chinese Male Protector", group 2 "…Female Protector": Armor / Protector / Garment tabs each; repair | Shop (+ Repair later) |
| NPC_CH_POTION | Herbalist Yangyun | (158.4, −140.7) | 62 m E | herbalist | STORE_CH_POTION "Purchase/ Sell recovery liquid medicine": HP/MP potions, universal pills (+ random cure, detect and Hwan scrolls, all out of scope) | Shop |
| NPC_CH_ACCESSORY | Grocery Trader Jinjin | (165.9, −107.8) | 75 m ESE | accessory / goods | STORE_CH_ACCESSORY "Purchase/ Sell Chinese Goods": rings/earrings/necklaces, return scrolls, an Alchemy tab (elixir-luck items, speed potions, Rondo: out of scope) | Shop |
| NPC_CH_WAREHOUSE_W | Storage-keeper Sansan | (98.0, −98.9) | 38 m S | storage keeper + honor shop | Storage ("It is best to travel light…"); also GROUP_STORE_CH_HONOR2 → STORE_CH_HONOR2 (same honor goods as M; dropped from the export) | **Storage** |
| NPC_CH_WAREHOUSE_M | Storage-keeper Wangu | (98.1, −98.9) | 38 m S | storage keeper + honor shop | Storage; GROUP_STORE_CH_HONOR → STORE_CH_HONOR "Purchase/ Sell Honor Items": degree-8 `*_08_{A,B,C}_RARE_HONOR` weapons (req. level 62 / 66 / 70) and `ITEM_ETC_ARCHEMY_MAGICSTONE_REPAIR_08`. Greeting is "...". His model is the big chained storage chest with him sitting in front of it; Sansan sits on top of it (§1.3) | **Storage** (§1.3) |
| NPC_CH_HORSE | Stable-keeper Machun | (32.9, −45.1) | 112 m SW | stable keeper | STORE_CH_STABLE: horses, trade transports, transport potions (all dropped from the export) | Talk only (future: mounts) |
| NPC_CH_SPECIAL | Specialty Trader Jodaesan | (176.0, −48.0) | 119 m SE | special goods | STORE_CH_SPECIAL: trade goods ITEM_ETC_TRADE_CH_01..04 (trade runs) | Talk only |
| NPC_CH_DOCTOR | Merchant Associate Hwajung | (176.1, −35.8) | 128 m SE | trader guild | STORE_CH_TRADER: trader job gear | Talk / quest giver |
| NPC_CH_GENARAL_SW | Hunter Associate Gwakwi | (−32.0, −232.0) | 160 m NW | hunter guild | STORE_CH_HUNTER: hunter job gear | Talk / quest giver |
| NPC_CH_GENARAL_SP | Guild Manager Leebaek | (−89.3, −249.0) | 217 m NW | guild manager | STORE_CH_GUILD: crests, guild soldiers, recall | Talk only |
| NPC_CH_FORTRESS_OFFICIAL | Jangan Fortress Clerk | (156.9, −303.5) | 177 m NNE | fortress war | STORE_CH_OFFICIAL: fortress items | Talk only |
| NPC_CH_SOLDIER_EM1 / EA2 / WE1 / SO1 | Soldier Choiyoung / Sangnam / Hogang / Jingyo [Teleport] (the client string for EA2 is misspelt "Solder Sangnam [Teleport]"; npcs.json keeps it) | gates N/E/W/S | 54–262 m | gate teleporters | Teleports to other towns; EM1 also offers "Reverse Return" at level ≤ 20 | Talk only (Jangan-only world) |
| NPC_CH_SOLDIER_EM2 / EA1 / WE2 / SO2 | Soldier Fengil / Iyang / Jowi / Dangsam | beside the teleporters | | guards | Flavour ("This is where His Majesty resides…") | Talk |
| NPC_CH_FERRY, NPC_CH_FERRY2 | Ferry Ticket Sellers Doji / Chau | (−1307.8, −176.1), (−1887.0, 31.3) | 1.4 / 2.0 km W | ferry | River crossing (teleport) | Talk only |
| NPC_CH_SPECIAL2 | Specialty Trader Seopok | (−1494.9, 808.4) | 1.9 km SW (thief den) | bandit trade | STORE_CH_SPECIAL2: trade goods 05..07 | Talk only |
| NPC_CH_TICKET, NPC_CH_LOTTERY, NPC_CH_BIGMAN | Ticket Seller Gyoun, Lottery Seller Wangwon, Casino Guardian Huhoan | (210–243, −75…−91) | 122–158 m ESE | arena / lottery / casino | Dead content ("no competition is scheduled") | Talk |
| NPC_BATTLE_ARENA_MANAGER | Arena Manager | (85.8, −85.4) | 53 m S | battle arena | Arena registration (no `_BS` greeting in the client: the generic line is shown) | Talk |
| NPC_CH_GACHA_OPERATOR, NPC_CH_GACHA_MACHINE | Magic POP Guide Gori, Magic POP | (97.7, −72.8), (161.3, −119.3) | 64–67 m | gacha (silk) | Magic POP cards | Talk |
| NPC_CH_EVENT_KISAENG1 | Event So-Ok | (110.2, −85.4) | 53 m S | events | "Did you come to join in the event?" | Talk; good host for custom events |
| NPC_CH_CHEF | Village Chief Hwangno | (277.0, −143.3) | 180 m E | quest | Missing children story | **Custom quest giver** |
| NPC_CH_BEGGARBOY | Bagger Sochil | (−53.4, −54.4) | 171 m WSW | quest | Kidnapped-friend story | Custom quest giver |
| NPC_CH_GENARAL, NPC_CH_GENARAL_BO | General Sonhyeon, Juho | (−133.2, −222.0), (−42.9, −344.0) | 245–250 m NW | quest | Ghosts outside, bandit raids | Custom quest givers |
| NPC_CH_PRIEST, NPC_CH_INDIA | Buddhist Priests Jeonghye, Kushyan | (258.0, −290.1), (261.2, −205.7) | 178–222 m NE | quest / flavour | Scriptures | Custom quest givers |
| NPC_CH_ISLAM, NPC_CH_EUROPE | Islam Merchant Ishyak, Adventurer Flora | (167.1, −58.1), (167.1, −26.1) | 106–131 m SE | quest / flavour | Travellers | Custom quest givers |
| NPC_CH_KISAENG1..6 | Gisaeng So-Ok, Juju, Ahjin, Mihyang, Juyeong, Yumi | west quarter | 145–246 m W | flavour (KISAENG6 also `teleport`) | Flavour dialogue | Talk / quest |
| NPC_CH_MOONSHADOW | WalYoung | (277.9, −106.9) | 183 m E | quest | Qin Shi story | Custom quest giver |
| NPC_CH_SHAMAN | Exorcist Miaoryeong | (−561.7, −274.2) | 673 m W, outside town | quest | Yin/yang imbalance | Custom quest giver |

- **Counts.** There are 46 NPCs. 42 are inside the converted regions (DATA.md) [confirmed]. The two ferries, SPECIAL2 and the shaman stand outside the safe area; the south soldiers stand just outside its box [confirmed by the box test].
- **Where to buy.** The four shops that matter (Smith, Armor, Potion, Accessory) and the storage keeper are all within 75 m of the return point [confirmed].
- **Quest givers.** "Quest giver" is a [decision] for the custom-quest wave, and the retail quests are not ported. Only some of them use `chinaquest_*` BSRs (PRIEST, CHEF, DOCTOR, GENARAL, GENARAL_BO/_SW/_SP, and FORTRESS_OFFICIAL); BEGGARBOY, INDIA, ISLAM, EUROPE, KISAENG1..6 and MOONSHADOW use `chinaetc_*`, and SHAMAN uses `chinasystem_shaman` [confirmed npcs.json `model.bsr`].

### 1.3 The storage chest: Wangu and Sansan [confirmed data, decision]

NPC_CH_WAREHOUSE_M and _W stand about 4.5 cm apart in npcpos ((98.080, −98.913) vs (98.035, −98.919)) [confirmed]. Both are storage keepers, and **both** map to an honor shop (M → STORE_CH_HONOR, W → STORE_CH_HONOR2, same tab group STORE_CH_HONOR_GROUP1; goods need level 62–70, so both stores are dropped from the export) [confirmed refshopgroup / refmappingshopgroup]. M's greeting is empty ("...") and W's is a real storage line.

They are not duplicates [confirmed glb]. Wangu's `chinasystem_warehousekeeper.bsr` is the Jangan storage chest: meshes `ChinaSystem_WarehouseKeeper_box` and `_chain` (a 1.8 × 1.9 × 1.9 m chained chest, 0.3–2.2 m behind his feet) and a man sitting on the ground in front of it. Sansan's `chinasystem_warehousekeeper_woman.bsr` is bound 2.4 m up and her STAND1 seats her on top of that chest. With Wangu hidden (the wave-3 decision) the chest was invisible and Sansan sat on thin air. Both models are in work/out and work/out-opt.

**Decision (revised):** both are placed. `HIDDEN_NPCS` in `apps/server/src/npc.ts` stays as the mechanism but is empty. Both offer the storage service (roles `storage`), so clicking Wangu, Sansan or the chest opens the storage dialog; the client gives an NPC whose bind pose reaches more than 1 m from its feet a second pick box over that footprint (`EntityView.fitModelPick`), so the whole chest is clickable. The facing comes from the port's zone list like every other NPC (§1.4): Wangu yaw −2.742 and Sansan −3.125, both facing north onto the plaza with the chest against the fountain.

### 1.4 NPC facing [confirmed data, verified layout]

No client table stores NPC facing. The export takes it from the third-party port's placements: `npcshops.json` `shops[].placements`, `zones.<province>.npcs[]` (all 38 Jangan NPCs, read since this fix; before it only the 6 shops and 4 teleport soldiers had a facing and the other 30 faced south) and `teleporters.json`. `data/npcs.ts matchFacing` matches a record by client code within 2 m, else by position within 1 m. `data/frame.ts portYawToWorld`: yaw = π − rotY (yaw 0 faces world +z = south). Only NPC_CH_EVENT_KISAENG1 and NPC_BATTLE_ARENA_MANAGER are missing from the port and keep yaw 0. `packages/convert/test/data.corpus.test.ts` checks the result against the town layout: everyone around the storage fountain faces outwards, the eight gate soldiers face into town, and the herbalist, grocer and stable-keeper face the street with their building behind them.

## 2. Shops

### 2.1 The data chain [confirmed]

```
refshopgroup      GROUP_STORE_CH_POTION  -> NPC_CH_POTION                 (group -> NPC)
refmappingshopgroup GROUP_STORE_CH_POTION -> STORE_CH_POTION              (group -> store)
refmappingshopwithtab STORE_CH_POTION    -> STORE_CH_POTION_GROUP1        (store -> tab group; the ARMOR store has GROUP1 = male, GROUP2 = female)
refshoptabgroup   STORE_CH_POTION_GROUP1 -> SN_STORE_POTION_GROUP1        ("Purchase/ Sell recovery liquid medicine": the NPC menu line)
refshoptab        STORE_CH_POTION_TAB1   -> group STORE_CH_POTION_GROUP1, name SN_TAB_POTION ("Potion")
refshopgoods      STORE_CH_POTION_TAB1   -> PACKAGE_ITEM_ETC_HP_POTION_01, slot 0   (col 4 = slot index in the tab grid)
refscrapofpackageitem PACKAGE_ITEM_ETC_HP_POTION_01 -> ITEM_ETC_HP_POTION_01, Data (col 6: durability for equipment, e.g. 62 for the Copper Sword)
refpricepolicyofitem PACKAGE_ITEM_ETC_HP_POTION_01 -> PaymentDevice 1 (gold), Cost 60
itemdata          ITEM_ETC_HP_POTION_01 -> Price col 26 = 60, SellPrice col 31 = 21, MaxStack col 57 = 50
```

- **The price.** The refpricepolicyofitem `Cost` equals itemdata `Price` (col 26) for every shop good checked: blade/sword 890 and 3500, ring 365, HP herb 60, return scrolls 5000 and 10000, pill 36, arrow 2. So `ItemDef.price` is the buy price [confirmed].
- **What the export keeps.** `shops.json` records `{id, npcs, tabs: {name, items, reqGender?}[], provenance: 'client'}`. `reqGender` is present on the six armour tabs [confirmed], but `ShopDef` in `content.ts` does not declare it: an additive type gap. Tabs keep slot **order** but not the slot **index**, so the gaps left by dropped goods close up. That is harmless.

**Gaps in the export:**

1. The tab-group line is not exported: "Purchase/ Sell/ Repair Chinese Male Protector" (SN_STORE_ARMOR_GROUP1/2). The client shows "Male" / "Female" from `reqGender` instead.
2. Stores whose goods are all out of scope are dropped: STABLE, SPECIAL, SPECIAL2, TRADER, HUNTER, GUILD, OFFICIAL, HONOR and HONOR2. `export-report.json` `shopsDroppedGoods` lists every one.
3. The package `Data` (shop durability) is not exported.
4. Greetings are not exported (§1.1).
5. itemdata `Cost_Repair` (col 27), `KeepingFee` (col 30), `CanRepair` (col 22) and `CanUse` (col 24) are not exported; §2.6 and §5.3 use them.
6. `cureLevel` **is** exported on the five pills (items.json, from Param1), but `ItemDef` in `content.ts` does not declare it: the same kind of additive type gap as `reqGender` (§7.5) [confirmed].
7. `CanDrop` (col 20) is not a boolean in the data: ordinary items carry 3, the `_DEF` starter items 0. The exporter maps only `'0'` to `canDrop: false` [confirmed `packages/convert/src/data/items.ts`].

### 2.2 STORE_CH_POTION: Herbalist Yangyun [confirmed]

One tab, "Potion". Every item has MaxStack 50, level 0, and no gender or race restriction.

| Slot | Code | English name | Effect (itemdata Param1-4) | Price | Sell |
|---|---|---|---|---|---|
| 0 | ITEM_ETC_HP_POTION_01 | HP Recovery Herb | +120 HP | 60 | 21 |
| 1 | ITEM_ETC_HP_POTION_02 | HP Recovery Potion (Small) | +220 HP | 110 | 39 |
| 2 | ITEM_ETC_HP_POTION_03 | HP Recovery Potion (Medium) | +370 HP | 200 | 70 |
| 3 | ITEM_ETC_HP_POTION_04 | HP Recovery Potion (Large) | +570 HP | 400 | 140 |
| 4 | ITEM_ETC_HP_POTION_05 | HP Recovery Potion (X-Large) | +820 HP | 600 | 210 |
| 5–9 | ITEM_ETC_MP_POTION_01..05 | MP Recovery Herb / Potion (Small..X-Large) | +120 / 220 / 370 / 570 / 820 MP | 60 / 110 / 200 / 400 / 600 | 21 / 39 / 70 / 140 / 210 |
| 10–14 | ITEM_ETC_CURE_ALL_01..05 | Universal Pill (small, medium, large), Special Universal Pill (small, medium) | Cures abnormal states up to cure level 36 / 68 / 108 / 172 / 228 (Param1, `cureLevel`) | 36 / 90 / 150 / 260 / 370 | 17 / 41 / 66 / 109 / 148 |

- Dropped (out of scope): CURE_RANDOM_01..04, DETECT_01..04 and SECOND_HWAN_SCROLL_01..04 [confirmed in the report].
- The export also has consumables that no Jangan shop sells: HP/MP/Vigor grains (`*_SPOTION_01`, +25%), the vigor potions `ITEM_ETC_ALL_POTION_01..05`, and `ITEM_ETC_SCROLL_RETURN_03` (Instant Return Scroll). They can only come from drops, quests or GMs [confirmed].

### 2.3 STORE_CH_SMITH: Blacksmith Chulsan [confirmed]

All items are Chinese and unisex. Weapons and shields have MaxStack 1; arrows have 250.

| Tab | Code | English name | Req. level | Price | Sell | Durability (roll) |
|---|---|---|---|---|---|---|
| Weapon | ITEM_CH_SWORD_01_A / 02_A / 03_A | Copper Sword / Infantry Bronze Sword / Bloody Sharp Sword | 1 / 8 / 16 | 890 / 3500 / 15250 | 427 / 1470 / 5490 | 62–76 (01) |
| Weapon | ITEM_CH_BLADE_01_A / 02_A / 03_A | Copper Blade / Infantry Hand Blade / Mhong tribe Cutting Blade | 1 / 8 / 16 | 890 / 3500 / 15250 | 427 / 1470 / 5490 | |
| Weapon | ITEM_CH_SPEAR_01_A / 02_A / 03_A | Crescent / Infantry Long Pike / Vicious Snake Spear | 1 / 8 / 16 | 990 / 3750 / 17000 | 475 / 1575 / 6120 | |
| Weapon | ITEM_CH_TBLADE_01_A / 02_A / 03_A | Glaive / Bronze Glaive / Merchant's Hook Glaive | 1 / 8 / 16 | 990 / 3750 / 17000 | 475 / 1575 / 6120 | |
| Weapon | ITEM_CH_BOW_01_A / 02_A / 03_A | Copper Bow / Infantry Bronz Bow / Strong Iron Bow | 1 / 8 / 16 | 990 / 3750 / 17000 | 475 / 1575 / 6120 | |
| Shield | ITEM_CH_SHIELD_01_A / 02_A / 03_A | Copper Shield / Bronze Shield / Infantry Iron Shield | 1 / 8 / 16 | 495 / 1750 / 8500 | 238 / 735 / 3060 | |
| Goods | ITEM_ETC_AMMO_ARROW_01 | Arrow | 0 | 2 each | 1 | |

The spellings "Infantry Bronz Bow" and "Mhong tribe Cutting Blade" come from the client strings. Keep them.

### 2.4 STORE_CH_ARMOR: Protector Trader Mrs Jang [confirmed]

There are six tabs, in this order: male Armor, male Protector, male Garment, female Armor, female Protector, female Garment. Each tab holds 6 slots × 3 degrees.

- Prices, sell prices and level requirements are **identical** across the three classes and both genders.
- Names are the same for male and female.
- MaxStack is 1. Items are Chinese only, male-only or female-only.

| Slot | Code pattern | Deg 1: level / price / sell | Deg 2: level / price / sell | Deg 3: level / price / sell |
|---|---|---|---|---|
| head | `ITEM_CH_{M,W}_{HEAVY,LIGHT,CLOTHES}_0d_CA_A` | 1 / 405 / 194 | 11 / 2000 / 840 | 19 / 12250 / 4410 |
| shoulders | `…_SA_A` | 1 / 335 / 161 | 9 / 1250 / 525 | 17 / 7000 / 2520 |
| chest | `…_BA_A` | 1 / 520 / 250 | 13 / 4500 / 1890 | **21** / 22750 / 8190 |
| legs | `…_LA_A` | 1 / 430 / 206 | 12 / 3000 / 1260 | 20 / 15250 / 5490 |
| hands | `…_AA_A` | 1 / 310 / 149 | 8 / 1000 / 420 | 16 / 5250 / 1890 |
| feet | `…_FA_A` | 1 / 380 / 182 | 10 / 1500 / 630 | 18 / 9750 / 3510 |

Names by class (head, shoulders, chest, legs, hands, feet):

- **Armor (HEAVY):**
  - degree 1: Copper Crown, Shoulder, Armor, Hose, Bracer, Footgear;
  - degree 2: Infantry Bronze …;
  - degree 3: Oh Scale ….
  - Durability at degree 1 is 48–59.
- **Protector (LIGHT):**
  - degree 1: Cloth Coronet, Shell, Lamellar, Tasset, Glove, Boots;
  - degree 2: Small Quilting …;
  - degree 3: Oh Iron ….
  - Durability at degree 1 is 44–53.
- **Garment (CLOTHES):**
  - degree 1: Cotton Hood, Talisman, Suit, Trousers, Wristlet, Shoes;
  - degree 2: Small Linen …;
  - degree 3: Sungdo Silk ….
  - Durability at degree 1 is 39–48.

**Above the cap.** The three degree-3 chest pieces need level 21, which is above `LEVEL_CAP` 20 [confirmed].

**Decision:** the shop filter hides goods whose `reqLevel > LEVEL_CAP`.
- On the server the cap is `this.config.levelCap` (env `LEVEL_CAP`, default `DEFAULT_LEVEL_CAP` = 20 from `@sro/shared`) [confirmed `apps/server/src/config.ts`]; there is no `LEVEL_CAP` constant in the server code. The server refuses the hidden goods with `not_found`.
- The client does not learn the server's cap today (`WorldInfo` is `{name, serverTime, tickRate}`) [confirmed], so the client filter uses `DEFAULT_LEVEL_CAP` (the mock already does: `net/mock-rules.ts` `LEVEL_CAP`). If the server runs with a different `LEVEL_CAP`, the client list and the server rule disagree until an optional `WorldInfo.levelCap` is added [decision; not in this wave].
- A `LEVEL_CAP` raise brings them back with no data change.

### 2.5 STORE_CH_ACCESSORY: Grocery Trader Jinjin [confirmed]

| Tab | Code | English name | Req. level | Price | Sell | Stack |
|---|---|---|---|---|---|---|
| Accessory | ITEM_CH_RING_01_A / 02_A / 03_A | Ume Copper / Devildom Silver / Mercury Gold Ring | 1 / 8 / 16 | 365 / 1250 / 6250 | 175 / 525 / 2250 | 1 |
| Accessory | ITEM_CH_EARRING_01_A / 02_A / 03_A | … Earring | 1 / 10 / 18 | 395 / 1750 / 10250 | 190 / 735 / 3690 | 1 |
| Accessory | ITEM_CH_NECKLACE_01_A / 02_A / 03_A | … Necklace | 1 / 12 / 20 | 460 / 3250 / 16250 | 221 / 1365 / 5850 | 1 |
| Goods | ITEM_ETC_SCROLL_RETURN_01 | Return Scroll | 0 | 5000 | 1500 | 50 |
| Goods | ITEM_ETC_SCROLL_RETURN_02 | Special Return Scroll | 0 | 10000 | 3000 | 50 |

- The "Alchemy" tab (SN_TAB_ALCHEMY) was dropped whole: `ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_01..10`, `ARCHEMY_ETC_02`, `ARCHEMY_POTION_SPEED_05/11` and `ARCHEMY_RONDO_01/02`.
- **Speed potions are not level-appropriate.** `ITEM_ETC_ARCHEMY_POTION_SPEED_05` costs 149,650 gold and `_11` costs 447,120 (itemdata col 26). Each casts a skill (`SKILL_ETC_ARCHEMY_POTION_SPEED_05_01`) [confirmed]. **Decision:** no speed items in this wave. They fit the skills wave's buff engine (`effectAdd`), exported as items whose `use.skill` names the buff.

### 2.6 Sell price, buyback and repair

**Sell price [confirmed column].**

- Selling pays itemdata `SellPrice` (col 31), exported as `ItemDef.sellPrice`, per unit.
- There is no single fraction. The ratio falls with value: sword 427/890 = 48%, 1470/3500 = 42%, 5490/15250 = 36%; HP herb 21/60 = 35%; return scroll 1500/5000 = 30%.
- The `_DEF` starter items have `sellPrice` 1, and the default arrow has 0. They are sellable (CanSell col 17 = 1) but not droppable (CanDrop col 20 = 0) [confirmed].
- Whether retail scales the sell price by durability or +N is [unknown]. **Decision:** `sellPrice × count`, with no scaling.

**Buyback [confirmed exists in the client].** The strings are `UIIT_STT_RE_BUY_OBJECT` "Buy back" and `UIIT_MSG_ERROR_RE_BUY_OBJECT_CANT`.

**Decision:**
- Each character keeps its **last 5 sales** in server memory: `BUYBACK_SLOTS` = 5 [likely retail size].
- The buyback price is exactly the gold paid for that sale.
- The list is cleared on logout and on server restart [likely retail: cleared on logout].
- A buyback puts the stack back into the bag exactly: code, count, plus and durability.

**Repair / durability.**

The client data supports repair:
- `Cost_Repair` (col 27): Copper Sword 198, Bronze 577, Bloody Sharp 950; Copper Armor 116;
- `CanRepair` (col 22) = 1 on weapons and armour, 0 on accessories and consumables;
- the strings "Repair", "Repair all" and "Cannot repair due to insufficient gold" [confirmed].

Our model:
- `InvItem.durability` / `ItemStack.durability` exist, and null means full [confirmed].
- Nothing lowers durability, and no stat penalty exists [confirmed].
- How fast retail wears items (per hit / per hit taken) and its exact repair formula are [unknown].

**Decision: defer durability wear and repair.** The Smith and Armor dialogs do not list "Repair" yet. When it is built, the minimal model is:

- **Buying and loot.** A bought item gets the package `Data` durability, a looted item the top of its roll, and both store it as `null` (full) until damaged.
- **Wear.**
  - Weapons lose 1 per `DUR_WEAPON_HITS` = 20 landed hits.
  - Each worn armour piece loses 1 per `DUR_ARMOR_HITS` = 20 hits taken, chosen at random.
  - Both numbers are [unknown] and are server config.
- **At 0.** The item is "broken": its stats are skipped in `playerCombatStats`, and the tooltip says so (`UIIT_MSG_STRGERR_EQUIP_BROKEN`).
- **Repair at Smith/Armor.** The cost is `ceil(Cost_Repair × (max − cur) / max)` [unknown formula]. There is a "Repair all" request `repair {npc}`, and no per-item request. It adds the service `'repair'`.

## 3. Interaction model

### 3.1 Flow

1. **Click.** Left-click on an NPC in the world (`apps/game/src/screens/world.ts` click handler) selects it (target frame, neutral ring) and sends `npcTalk {npc: id}`.
2. **Server validation** (`apps/server/src/npc.ts` `NpcDialogs.talk`; `NpcService` is the name of the service-kind type in §7.1, not a class). Each failure is one `actionResult`:
   - dead → `dead`;
   - the entity is not an NPC, or not in `p.known` → `not_found`;
   - a return-scroll cast is running → the talk walk interrupts it (§4.3). This is not a failure.
   - Distance d (centre to centre, `world.distance`):
     - d ≤ `NPC_INTERACT_RANGE` (8 m) [confirmed constant]: `actionResult ok`, then `npcDialog` at once;
     - otherwise: `actionResult ok`, and the server walks the player with `PlayerAction {kind: 'talk', npc, chaseAt, chaseTo}` through the existing `approach()` until d ≤ `NPC_APPROACH_RANGE` (3 m), then halts the player facing the NPC (`this.world.halt(p, now, yawTowards(...))`, as the attack branch does; this sends `stop`) and sends `npcDialog`.
   - An unreachable NPC ends the action silently, as pickup does. **Caveat [confirmed code]:** player moves are straight walks that stop at the first blocking navmesh edge (`world.walkEntity`), and `approach()` sets `p.action = null` when a re-plan cannot move. Shop NPCs that stand behind a counter can therefore end the walk short of 3 m. Rule: when the talk action ends (the action was cleared by `approach()`) while d ≤ `NPC_INTERACT_RANGE`, open the dialog anyway; only a walk that ends farther than 8 m is silent (a system line "You cannot get there." via `action.fail.unreachable` is optional) [decision].
3. **Session.** The server keeps `talk: Map<playerId, {npc: number, openedAt: number}>` in `npc.ts`. **One dialog at a time**: a new `npcTalk` replaces the old one, and the server sends `npcDialogClose {reason: 'closed'}` for the old NPC.
4. **Dialog.** `npcDialog {npc, code, services}`. `services` is computed by the server:
   - `'shop'` when `data.shopOf(code)` exists and has at least one good at or below the cap;
   - `'storage'` when `NpcDef.roles` includes `storage`;
   - `'repair'` never, until §2.6 is built;
   - `'quest'` when the quest module reports one (future).
   - An NPC with no services still gets a dialog: greeting plus "End conversation".
5. **Close.**
   - The client sends `npcClose` from the close button, "End conversation", Escape or opening another NPC. The server answers `actionResult ok` and drops the session.
   - The server closes on its own with `npcDialogClose {npc, reason}` when:
     - `too_far`: at the 10 Hz tick, distance > `NPC_INTERACT_RANGE`, i.e. the player walked away;
     - `dead`: the player died;
     - `warp`: respawn or return scroll (both go through `Gameplay.toTown`). GM `tp`/`summon` call `world.warp` directly from `gm.ts` and bypass `toTown`, so they close with `too_far` on the next tick unless `gm.ts` also calls the close hook (optional one-liner) [confirmed code];
     - `gone`: the NPC despawned (GM NPC editor, later).
   - Closing the dialog also closes its shop/storage windows on the client.
6. **Services are also range-checked per request.** `shopBuy`, `shopSell`, `shopBuyback` and `storage*` keep the stateless `NPC_INTERACT_RANGE` check against the NPC id they carry [decision].
   - They do **not** require an open dialog session. The existing e2e tests and the mock stay valid, and nothing is gained: the session is UI state; the distance is the rule.
   - The shop window may stay open only while the dialog is open (client rule).

**Why 3 m and 8 m [decision].** Walking to 3 m then allowing services up to 8 m gives 5 m of slack, so small moves near the counter never close the window. The existing 8 m constant stays the one authority for "in range". The third-party port has only **one** radius per NPC (`interact-radii.json`: 129 NPC codes, values 15 / 15.25 / 18.25 / 22.75 in the port's own units, scale [unknown]) [confirmed, read as data only]; it is not a two-radius scheme, so it does not back this choice.

**Cross-lane note.** docs/UX_GAPS.md §9 (item 2) asks the shops lane to expose `addTalkOption(npcCode, {label, run})` on the talk window for the quests lane, and describes the walk as "into NPC_INTERACT_RANGE (8 m)". This spec keeps the 3 m walk and adds that client hook to `NpcDialogWindow` (§8.3) so quest options can be added without a server `'quest'` service until the quest module exists.

### 3.2 Dialog window content (client)

- **Title:** the NPC's English name (`EntityState.name`).
- **Portrait:** none for now [decision]. The NPC model is visible in the world.
- **Greeting:** `NpcDef.greeting` (§7.5), falling back to the i18n line `npc.greeting.default`: "Greetings, traveller."
- **Options:** one line per service, captions from `apps/game/src/i18n/en.ts`. Shop, storage and end follow the retail strings `UIIT_STT_NPC_CHATTING_WND_{SHOP,STOREHOUSE,TALKEND}` [confirmed textuisystem]. Retail has **no** dialog line for repair (repair is the "Repair" / "Repair all" buttons, `UIIT_CTL_REPAIR` / `UIIT_CTL_REPAIR_ALL`, in the shop window) and no quest-specific line; the closest is `UIIT_STT_NPC_CHATTING_WND_TALKSTART` "Talk to this person." [confirmed]. So:

| Service | i18n key | Text | Source |
|---|---|---|---|
| shop | `npc.option.shop` | Trade in the shop. | retail WND_SHOP |
| storage | `npc.option.storage` | Deposit into storage. | retail WND_STOREHOUSE |
| repair | `npc.option.repair` | Repair equipment. | ours [decision]; later a "Repair all" button in the shop window instead |
| quest | `npc.option.quest` | Talk to this person. | retail WND_TALKSTART |
| (always) | `npc.option.end` | End conversation. | retail WND_TALKEND |

- **Choosing an option:**
  - shop: the shop window opens next to the inventory, and the inventory opens too. Browsing needs no round trip (PROTOCOL §8).
  - storage: the client sends `storageOpen {npc}`, and the server answers `actionResult` then `storage`. The storage window and the inventory open.
  - end: `npcClose`.

## 4. Consumables

### 4.1 HP/MP potions and grains [confirmed amounts, unknown cooldown]

- `ItemDef.use` comes from itemdata Param1-4: HP flat, HP %, MP flat, MP %.
- The groups come from TypeID4 (1 hp, 2 mp, 3 vigor): `cooldownGroup` 'hp', 'mp' or 'vigor' [confirmed export].
- **Heal.** `hp' = min(maxHp, hp + use.hp + use.hpPct × maxHp / 100)`, and the same for MP. This is already in `gameplay.ts`.
- **Cooldown.** The client data carries no potion cooldown. Only some other items name a `COOLTIME:0x…` group in their params, e.g. DETECT_01 `COOLTIME:0x000000C8` [confirmed]. Keep `POTION_COOLDOWN_MS` = 1000 per group [unknown retail; rule].
  - HP, MP and vigor are separate groups, so an HP potion and an MP potion can be used in the same second [decision; retail unknown].
  - Today the server arms `p.cooldowns` (`world.ts` `Player.cooldowns: Map<string, number>`) with group `use.cooldownGroup ?? def.code`, and uses `POTION_COOLDOWN_MS` only when the item has an HP/MP effect and no `use.cooldownMs` [confirmed `gameplay.ts itemUse`]. The skills wave keeps its per-group cooldowns in the same kind of map (SKILLS §10.1); item groups ('hp', 'mp', 'vigor', 'cure', item codes) and skill groups must not share names.
- **New `itemCooldown {group, readyInMs, totalMs}`** is sent to the user after every accepted use that armed a cooldown. The hotbar and the inventory draw the sweep from it, not from the item data, because the server's default is not in items.json. Exporter §7.5 also writes `use.cooldownMs: 1000` with a `fieldSources` note, so tooltips can show it.
- **Allowed at any time while alive:** during combat, during a return-scroll cast, and inside town.

### 4.2 Universal pills [confirmed data; behaviour waits for statuses]

- `use: {cooldownGroup: 'cure'}` and `cureLevel` (Param1: 36 / 68 / 108 / 172 / 228).
- Until the skills wave adds statuses (`EffectState.status`), a pill answers `not_usable` with the message 'nothing to cure'. It is **not consumed** [decision].
- Once statuses exist: remove every status effect on the user whose level ≤ `cureLevel`, sending `effectRemove {reason: 'cured'}` from SKILLS §10.2. Consume one pill and arm 'cure' with 1000 ms. With nothing to cure it still answers `not_usable`, so no waste.

### 4.3 Return scrolls [confirmed data; likely timings]

| Code | Name | Param1 (cast) | Sold in Jangan |
|---|---|---|---|
| ITEM_ETC_SCROLL_RETURN_01 | Return Scroll | 30000 ms | Accessory, 5000 |
| ITEM_ETC_SCROLL_RETURN_02 | Special Return Scroll | 15000 ms | Accessory, 10000 |
| ITEM_ETC_SCROLL_RETURN_03 | Instant Return Scroll | 5000 ms | no (drops / quests / GM) |

The rows have Param3 desc `RESURRECT`, which the exporter uses to classify them [confirmed]. Reading Param1 as the cast time is the exporter's interpretation [likely].

- **Destination.** The town return point: `towns.json` JANGAN `spawn`, which equals `Gameplay.townPoint()` today. Both come from GATE_CH [confirmed]. vSRO sends you to your last "recall point" (`UIIT_CTL_RECALL_POSITION`); with Jangan as the only town, that is always Jangan [decision].
- **Server flow** (`apps/server/src/item-use.ts` `ItemUses`, §8.1):
  1. Validate:
     - alive;
     - the slot holds a return scroll;
     - no cast running (`busy`);
     - the group cooldown is ready (`cooldown`). Return scrolls export no `cooldownGroup` and no `cooldownMs` [confirmed items.json], so the group is the item code and nothing is ever armed; this check is a no-op for them today.
     - Remove today's "not in combat" refusal: the cast time is now the protection.
  2. Answer `actionResult ok`. Broadcast `itemCast {id, item, castMs}` to viewers, the user included. Store `{item, bag, startPos, endsAt}`. The item is **not consumed yet**.
  3. Each tick (10 Hz), **interrupt** with `itemCastEnd {reason: 'interrupted'}` when any of these holds:
     - the player moved more than 0.3 m from `startPos`, or has a `move` (click-to-move, attack chase, talk walk, GM tp, knockback);
     - the player died. `tickPlayer` returns at once for a dead player (`if (p.dead) return`) [confirmed], so the death interrupt must not rely on a tick placed after that line: `playerDied` calls `this.itemUses.cancel(p, 'interrupted')` directly (§8.2 hook 8);
     - `p.action` is not null (attack, pickup or talk started);
     - a skill action started (skills-wave predicate `skills.busy(p)`).

     `stopAction` ends the cast with reason `cancelled`.
     - **Taking damage does NOT interrupt** [likely retail: the cast bar keeps running under attack]. Using potions does not interrupt.
  4. At `endsAt`, in one `inventoryTx`, take 1 from `bag` if it still holds the same code, else from the lowest bag slot holding that code.
     - If none is left (sold, dropped or stored during the cast): `itemCastEnd {reason: 'cancelled'}` and no teleport.
     - Otherwise: `inventoryUpdate`, then `itemCastEnd {reason: 'done'}`, then `toTown(p)` (warp to viewers), then `npcDialogClose {reason: 'warp'}` if a dialog was open.
  5. The scroll's own cooldown: none in the data (no `COOLTIME` desc on the return scrolls; Param2 is 1 and Param3 is −1 with desc `RESURRECT`) [confirmed itemdata]. No cooldown is armed and no `itemCooldown` is sent for it [decision].
- **Consume at completion [decision]**, so a cancelled cast costs nothing. The retail rule is [unknown]. This is safe because the take happens inside the completion transaction.
- **Client.** `itemCast` for self shows a cast bar ("Returning to town… 30 s", `hud/item-cast.ts`). For other players it shows a small particle loop (optional: the effect of `SKILL_ETC_RETURN`, if any, is [unknown]). `itemCastEnd` hides the bar; `cancelled`/`interrupted` shows the toast "The use of return scroll has been canceled." (retail text `UIIT_MSG_RETURN_CANCLE` [confirmed]).

### 4.4 Arrows [confirmed]

`ITEM_ETC_AMMO_ARROW_01` (stack 250, 2 gold) and `_DEF` have no `use`, and `itemUse` answers `not_usable`.

Consuming arrows per bow shot belongs to the skills wave (`no_ammo`, SKILLS §10.1). Until then, bows need no arrows [confirmed, current behaviour].

### 4.5 Hotbar items (depends on SKILLS §10.2 `hotbarSet` / `HotbarEntry`)

- A hotbar entry `{kind: 'item', code}` references a **code, not a bag slot**, so it survives moves.
- **Pressing it:** the client finds the lowest bag index holding `code` and sends `itemUse {bag}`. With none, the slot is greyed out and nothing is sent.
- **Display:**
  - the total count of `code` in the bag (from `InventoryState`);
  - the cooldown sweep from `itemCooldown` of the entry's `use.cooldownGroup`;
  - a cast-bar highlight while an `itemCast` for that code runs.
- There is no new server message: SKILLS §10.2 `hotbarSet` accepts `kind: 'item'`. It is **not in `protocol.ts` yet** [confirmed]; it lands with the skills lane. The server checks only that `code` is an item in items.json.
- Retail-style auto-potion is not in scope [decision].

## 5. Storage (storage keeper)

### 5.1 Rules

- **Per account** [likely: vSRO keeps the chest per user account, shared by all characters of that account on the shard]. **Decision: per account.** Deleting a character keeps the storage, and alts can share items. Friends cannot share: there is no guild storage.
- **Safe for concurrency.** One account has at most one connection (`connection.ts` `hello` closes the previous socket, and `Connection.close` → `dispose` → `leaveWorld` runs synchronously, so the old player has left the world before the new login proceeds [confirmed]), and one connection has at most one player in the world. So two characters of the same account never use storage at the same time. Every storage request still runs in one SQLite transaction that re-reads the rows.
- **Size.** `STORAGE_SIZE_DEFAULT` = 150 slots [likely retail default; nothing in our data states it]. The protocol maximum is `MAX_STORAGE_SIZE` = 180 (retail expansions add 30: `UIIT_STT_STORAGE_EXPANSION_WAREHOUSE_ADDITION_ITEM_USE` "Personal Storage will be expended to 30 rooms permanently…" [confirmed string]; whether one expansion is the retail limit is [unknown]). There is no expansion item in this wave.
- **Gold storage.** A separate `storage_gold` per account, capped at `MAX_GOLD` [likely retail].
- **Storage fee.**
  - itemdata `KeepingFee` (col 30) [confirmed column; semantics likely]: HP herb 1, HP (X-Large) 11, Copper Sword 21, Bloody Sharp Sword 275, Oh Scale Armor 410, Mercury Gold Ring 113, Return Scroll 75, arrows 0.
  - **Decision:** charge `keepFee × count` gold from the **bag** gold on deposit. Withdrawing is free, and moving and gold deposits are free.
  - `STORAGE_FEE=0` turns it off (server config).
  - Until the exporter writes `ItemDef.keepFee`, the fee is 0.
- **What can be stored.** Anything except `category: 'quest'` items and items with `canStore === false` (a future authored flag) → `not_usable`. `'quest'` is a declared `ItemCategory`, but no exported item has it today (items.json categories: gold, potion, pill, scroll, ammo, weapon, shield, armor, accessory) [confirmed], so this rule is for the custom-quest wave. Starter `_DEF` items can be stored [decision]. Equipped items cannot be stored: deposits take a bag index only.
- **Stacking.** Storage stacks like the bag, with the same `stackable()` rule (same code, same plus, durability null, `maxStack` > 1). `stackable` is module-private in `apps/server/src/inventory.ts` today [confirmed]; the storage lane needs it exported (a one-word hook, §8.2).
- **Browsing.** `storageOpen` is required first. It sends the snapshot, which is why storage is not "browse without a round trip" like shops.

### 5.2 Database (next free migration; do not renumber other lanes' migrations)

```sql
-- storage (docs/SHOPS.md §5): account-wide chest and its gold
CREATE TABLE storage_items (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  slot INTEGER NOT NULL CHECK (slot >= 0),
  code TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 1),
  plus INTEGER NOT NULL DEFAULT 0 CHECK (plus >= 0),
  durability INTEGER,
  UNIQUE (account_id, slot)
);
CREATE INDEX storage_items_account ON storage_items(account_id);
ALTER TABLE accounts ADD COLUMN storage_gold INTEGER NOT NULL DEFAULT 0 CHECK (storage_gold >= 0);
ALTER TABLE accounts ADD COLUMN storage_size INTEGER NOT NULL DEFAULT 150 CHECK (storage_size BETWEEN 1 AND 180);
```

- `storage_items` is a separate table from `items`, so an item row has exactly one home.
- A move between them is a delete in one table and an insert in the other, inside one transaction. It can never duplicate.

### 5.3 Server transaction

`apps/server/src/storage.ts` holds the pure rules:

- `StorageDraft` mirrors `InvDraft`: slots, gold, `touched`, `updates()`;
- `deposit(inv: InvDraft, st: StorageDraft, bag, count?, to?, fee)`;
- `withdraw(inv, st, slot, count?, bag?)`;
- `moveStored(st, from, to, defs)`;
- `goldIn(inv, st, amount)` and `goldOut(inv, st, amount)`.

`apps/server/src/storage-db.ts` holds the database side:

- `openStorageStore(store)` → `{load(accountId), storageTx(characterId, accountId, fn)}`;
- `storageTx` runs `store.db.transaction(() => { const inv = new InvDraft(store.loadInventory(cid)); const st = new StorageDraft(load(aid)); const r = fn(inv, st); if (r.ok) { store.writeDraft(cid, inv); writeStorage(aid, st) } })()`.

The one `db.ts` hook is exposing the existing internal `writeDraft` on the returned store object (§8.2).

`accountId` is looked up once per player through `store.characterById(p.characterId).account_id` (`characterById` is `SELECT *` on `characters`, which has `account_id`) [confirmed] and cached in `storage-db.ts` (`Map<playerId, accountId>`, cleared in `forget`), so `Player` needs no new field. (`Connection.accountId` also exists in `connection.ts`, but `Gameplay.request` only receives the `Player`.) `inventoryTx` is itself a `db.transaction` [confirmed]; `storageTx` calls `loadInventory`/`writeDraft` directly inside its own transaction, as sketched, rather than wrapping `inventoryTx`.

## 6. Economy and abuse rules

All the rules below are server-side, inside `inventoryTx` / `storageTx`. Requests are processed in order per connection, the server is one Node process, and better-sqlite3 is synchronous. So every request is all-or-nothing, and no two requests interleave [confirmed architecture: `inventory.ts` header, `db.ts` `inventoryTx`].

| Rule | Value / behaviour | Where |
|---|---|---|
| Gold cap (bag and storage) | `MAX_GOLD` = 9,999,999,999 (moves from `inventory.ts` to `@sro/shared` protocol.ts) [confirmed current value]. A sale or storage withdrawal that would pass it fails with **`gold_limit`**, and nothing changes: `addGold(d, n, {strict: true})`. Loot pickups (and GM `item ITEM_ETC_GOLD_*`) keep the current clamping `addGold`, since losing overflow loot gold is harmless. | shop.ts, storage.ts |
| Buy count | 1..`MAX_ITEM_COUNT` (10,000) on the wire. The server also requires count ≤ `maxStack × bagSize` (replacing the hard-coded 48), then all-or-nothing `addItem`. | validate.ts, shop.ts |
| Buy cost | `price × count` as an integer. The largest sold price is 22,750 (the level-21 chests, if the cap is raised); × `MAX_ITEM_COUNT` 10,000 = 2.3e8, well inside 2^53. `not_enough_gold` when gold < cost. | shop.ts |
| Buy filter | The good is in that NPC's shop **and** `reqLevel ≤ LEVEL_CAP` → else `not_found`. There is no level or gender check at purchase: retail sells anything, and wearing is checked at `itemEquip` [likely]. | shop.ts |
| Sell | Only bag slots, so equipped items cannot be sold [confirmed shape]. `canSell === false` or `category === 'quest'` → `not_usable`. The price is `sellPrice × count`. | shop.ts |
| Double sell of one slot | The second request finds the slot empty or smaller → `invalid_slot` / `invalid_count`. It is covered by a test. | shop.ts |
| Sell during a return cast | Allowed. The cast re-checks the scroll at completion (§4.3). | item-use.ts |
| Buyback | 5 per character, in memory. The entry is removed **before** the item is added, in the same synchronous call, so a double buyback of one index fails with `not_found`. Its price is exactly what the sale paid. It needs gold and bag room (`not_enough_gold`, `inventory_full`). | shop.ts |
| Storage quantities | `count` 1..stack; `slot` 0..`storage_size − 1` (else `invalid_slot`); `amount` 1..`MAX_GOLD`. | storage.ts |
| Storage full | **`storage_full`**: neither an empty slot nor room on a mergeable stack. | storage.ts |
| Deposit fee | `keepFee × count` from bag gold, checked before the move (`not_enough_gold`). | storage.ts |
| Range | Every shop or storage request carries `npc`, which must be a live NPC within 8 m with that service → `not_found` / `too_far`. | npc.ts |
| Dead | Every request except the PROTOCOL §5 list → `dead`. That list gains `npcClose`, which is harmless. | gameplay.ts (existing) |
| Rate limits | Per type (§7.2). Over budget → `rate_limited` (not a strike since the W3 fix pass; the global budget still strikes). | protocol.ts |
| Audit | Buy, sell, buyback and storage write no audit rows. GM `item` stays audited (PROTOCOL §10). A future GM command `storage <player>` (read-only) goes through the same role checks. **No in-game role change is added**, and `apps/server/test/role-policy.test.ts` must keep passing. | — |

**Gold flow at levels 1–20 [confirmed data, decision on tuning].**

- Mobs drop gold with chance 0.7 (drops.json), and the amount comes from levelgold: 28–59 at level 1, 95–198 at level 20.
- Buying a full degree-3 set costs 12,250 + 7,000 + 15,250 + 5,250 + 9,750 = 49,500 for armour (the chest is capped out), plus 15,250–17,000 for a weapon and 6,250 + 10,250 + 16,250 = 32,750 for one ring, earring and necklace (39,000 with the second ring slot filled; +8,500 for a shield). That is about 100–115k gold [confirmed arithmetic].
- `GOLD_RATE` (new server config, default 1) multiplies dropped gold if the friends find it slow. It goes in `formulas.ts`/`rollDrops` and is a later tuning knob, not needed for this wave.

## 7. Protocol additions (v1, additive)

### 7.1 Types (`packages/shared/src/protocol.ts`)

```ts
// ---- NPC / shop / storage / consumable additions (docs/SHOPS.md) ------------------------------------

/** What an NPC dialog offers; the server decides per NPC (docs/SHOPS.md §3.1). */
export type NpcService = 'shop' | 'storage' | 'repair' | 'quest'
export const NPC_SERVICES: readonly NpcService[] = ['shop', 'storage', 'repair', 'quest']

/** Why a dialog closed without the client asking. */
export type NpcCloseReason = 'closed' | 'too_far' | 'dead' | 'warp' | 'gone'
export const NPC_CLOSE_REASONS: readonly NpcCloseReason[] = ['closed', 'too_far', 'dead', 'warp', 'gone']

export type ItemCastEndReason = 'done' | 'cancelled' | 'interrupted'
export const ITEM_CAST_END_REASONS: readonly ItemCastEndReason[] = ['done', 'cancelled', 'interrupted']

export type StorageGoldDir = 'deposit' | 'withdraw'

/**
 * Account storage, in full (after storageOpen). `slots.length === size`; null = empty.
 * Not named `Storage`: that would shadow the DOM `Storage` type (localStorage) in every client module that imports it.
 */
export interface AccountStorage {
  size: number
  slots: (ItemStack | null)[]
  gold: number
}

export interface StorageSlotUpdate {
  slot: number
  item: ItemStack | null
}

/** One recent sale that can be bought back, oldest first. `price` = what the sale paid. */
export interface BuybackEntry {
  item: ItemStack
  price: number
}

// ClientMessage additions
  /** Talk to NPC entity `npc` (walks there first when farther than NPC_INTERACT_RANGE). */
  | { t: 'npcTalk'; npc: number }
  /** Close the open NPC dialog (and its shop/storage windows). */
  | { t: 'npcClose' }
  /** Open the storage of the storage keeper `npc`: answered by `storage`. */
  | { t: 'storageOpen'; npc: number }
  /** Bag -> storage. `count` default: all; `to` default: merge, then the first empty slot. Fee: ItemDef.keepFee x count. */
  | { t: 'storageDeposit'; npc: number; bag: number; count?: number; to?: number }
  /** Storage -> bag. `count` default: all; `bag` default: merge, then the first empty bag slot. */
  | { t: 'storageWithdraw'; npc: number; slot: number; count?: number; bag?: number }
  /** Storage slot -> storage slot: move / merge / swap, like itemMove. */
  | { t: 'storageMove'; npc: number; from: number; to: number }
  /** Move gold between the bag and storage. */
  | { t: 'storageGold'; npc: number; dir: StorageGoldDir; amount: number }
  /** Buy back entry `index` of the `buyback` list (0 = oldest). */
  | { t: 'shopBuyback'; npc: number; index: number }

// ServerMessage additions
  /** An NPC dialog opened (after npcTalk ok, once in range). The greeting text comes from npcs.json (NpcDef.greeting). */
  | { t: 'npcDialog'; npc: number; code: string; services: NpcService[] }
  /** The server closed the dialog (walked away, died, warped, NPC gone, or replaced by another npcTalk). */
  | { t: 'npcDialogClose'; npc: number; reason: NpcCloseReason }
  /** Account storage snapshot (after storageOpen ok). */
  | { t: 'storage'; storage: AccountStorage }
  /** Changed storage slots and the new storage gold if it changed (bag side: the usual inventoryUpdate). */
  | { t: 'storageUpdate'; slots?: StorageSlotUpdate[]; gold?: number }
  /** This character's buyback list, in full: after every shopSell / shopBuyback, and after npcDialog of a shop NPC. */
  | { t: 'buyback'; entries: BuybackEntry[] }
  /** An item cooldown group was armed (own client only): e.g. { group: 'hp', readyInMs: 1000, totalMs: 1000 }. */
  | { t: 'itemCooldown'; group: string; readyInMs: number; totalMs: number }
  /** Someone started a timed item use (return scroll); viewers of `id`, the user included. */
  | { t: 'itemCast'; id: number; item: string; castMs: number }
  /** A timed item use ended; 'done' comes before the resulting warp. */
  | { t: 'itemCastEnd'; id: number; item: string; reason: ItemCastEndReason }

// GameplayRequest / GAMEPLAY_REQUESTS additions (answered by actionResult)
  | 'npcTalk' | 'npcClose' | 'storageOpen' | 'storageDeposit' | 'storageWithdraw' | 'storageMove' | 'storageGold' | 'shopBuyback'

// ActionFailReason / ACTION_FAIL_REASONS additions
  /** Gold would pass MAX_GOLD (sale, storage withdrawal). */
  | 'gold_limit'
  /** No room in storage. */
  | 'storage_full'
  /** Another timed action is running (a second return scroll). */
  | 'busy'

/** Most gold a character (bag) or an account storage can hold. (Moved from apps/server/src/inventory.ts.) */
export const MAX_GOLD = 9_999_999_999
/** Storage slots of a new account, and the most the protocol allows. */
export const STORAGE_SIZE_DEFAULT = 150
export const MAX_STORAGE_SIZE = 180
/** Recent sales kept for buyback per character. */
export const BUYBACK_SLOTS = 5
/** Metres: npcTalk walks the player to this distance before the dialog opens (services work up to NPC_INTERACT_RANGE). */
export const NPC_APPROACH_RANGE = 3
```

The `ItemStack` shape is reused for storage slots, so `plus` and `durability` travel unchanged.

### 7.2 Validators and rate limits (`packages/shared/src/validate.ts`, `protocol.ts`)

Strict key sets (`?` = optional key):

| t | required | optional | bounds |
|---|---|---|---|
| `npcTalk` | `t, npc` | — | npc int 0..MAX_ID |
| `npcClose` | `t` | — | — |
| `storageOpen` | `t, npc` | — | |
| `storageDeposit` | `t, npc, bag` | `count, to` | bag: bag index; count: 1..MAX_ITEM_COUNT; to: 0..MAX_STORAGE_SIZE−1 |
| `storageWithdraw` | `t, npc, slot` | `count, bag` | slot: 0..MAX_STORAGE_SIZE−1; bag: bag index |
| `storageMove` | `t, npc, from, to` | — | storage indexes |
| `storageGold` | `t, npc, dir, amount` | — | dir ∈ {'deposit', 'withdraw'}; amount int 1..MAX_GOLD |
| `shopBuyback` | `t, npc, index` | `code` | index 0..BUYBACK_SLOTS−1; `code` (CodeName128) must match the entry, else `not_found` |

- Server → client parsing:
  - `storage.slots` is a list of `itemOrNull` (length ≤ MAX_STORAGE_SIZE);
  - `services` and `reason` use `oneOf` their lists;
  - `entries` is ≤ BUYBACK_SLOTS;
  - `readyInMs`, `totalMs` and `castMs` are ints 0..600,000.
- The largest client frame, `storageDeposit` with every key, is under 100 bytes. The 1024-byte cap is unchanged.
- **Compatibility:** `actionResult.re` parsing uses `GAMEPLAY_REQUESTS`. An older client never sends the new requests, so it never receives an unknown `re`. It can, however, receive new server message **types** it does not know: `itemCast`/`itemCastEnd` are broadcast to every viewer. `parseServerMessage` fails an unknown `t` ("unknown message type") [confirmed `validate.ts`], and `apps/game/src/net/wire.ts` logs and drops such frames [confirmed], so an older client only prints a console warning. The client is served by the same server, so in practice both update together.

`CLIENT_RATE_LIMITS` additions:

| t | perSecond | burst |
|---|---|---|
| npcTalk | 2 | 5 |
| npcClose | 5 | 10 |
| storageOpen | 2 | 5 |
| storageDeposit, storageWithdraw, storageMove | 10 | 20 |
| storageGold | 5 | 10 |
| shopBuyback | 5 | 10 |

The existing `shopBuy`/`shopSell` (5/10) and `itemUse` (5/10) are unchanged.

### 7.3 Message order (each request's `actionResult` comes first, as today)

- `npcTalk` in range: `actionResult ok` → `npcDialog` (+ `buyback` when the NPC has a shop).
- `npcTalk` far: `actionResult ok` → `move`s → `stop` → `npcDialog`.
- `shopSell` ok: `actionResult ok` → `inventoryUpdate {bag, gold}` → `statsDelta {gold}` → `buyback`.
- `storageOpen` ok: `actionResult ok` → `storage`.
- `storageDeposit` ok: `actionResult ok` → `inventoryUpdate {bag, gold?}` → (`statsDelta {gold}` when a fee was paid) → `storageUpdate {slots}`. The bag messages come from the existing `afterInventory`, which sends `statsDelta {gold}` right after `inventoryUpdate` [confirmed], so `storageUpdate` is sent after it returns.
- `itemUse` potion: `actionResult ok` → `inventoryUpdate` → `itemCooldown` → `statsDelta {hp|mp}` (+ `entityUpdate` to viewers).
- `itemUse` return scroll: `actionResult ok` → `itemCast` (viewers) … then either:
  - `inventoryUpdate` → `itemCastEnd done` → `warp` → (`npcDialogClose warp`); or
  - `itemCastEnd interrupted|cancelled`.

### 7.4 Enter-world sequence

Unchanged: `worldEnter` → `stats` → `inventory` (→ `skills` in the skills wave). Storage and buyback are sent only on demand. Item cooldowns are runtime-only and reset on relog [decision; they are at most 1 s].

### 7.5 Content additions (additive fields; `packages/shared/src/content.ts`, exporter)

```ts
// ItemDef (optional; absent = 0 / allowed)
  /** Storage fee per unit (client itemdata KeepingFee col 30). */
  keepFee?: number
  /** Repair cost of a fully broken item (client itemdata Cost_Repair col 27); 0/absent = not repairable. */
  repairCost?: number
  /** client itemdata CanRepair col 22 (0 = false). */
  canRepair?: boolean
  /** Authored: false = cannot go into storage (quest items). */
  canStore?: boolean
// ItemUse
  // cooldownMs is now written for potions/pills: 1000, fieldSources['use.cooldownMs'] = 'rule: POTION_COOLDOWN_MS (no client column)'
// NpcDef
  /** English greeting (npcchat.txt SN_<code>_BS -> textquest_speech&name.txt col 8); absent = generic line. */
  greeting?: string
// ItemDef (already exported for the five pills, missing from the type)
  /** Universal pills: highest abnormal-state level cured (client itemdata Param1: 36 / 68 / 108 / 172 / 228). */
  cureLevel?: number
// ShopDef.tabs[i]
  /** Armour tabs: the gender the tab group sells for (refshoptabgroup GROUP1 = male, GROUP2 = female). Already exported. */
  reqGender?: 'male' | 'female'
```

`content-check.ts` accepts the new optional fields: numbers ≥ 0, booleans, a string of at most 2000 characters.

## 8. Server and client modules

### 8.1 New server modules (owned by the implementing lanes)

| File | Contents |
|---|---|
| `apps/server/src/npc.ts` | `HIDDEN_NPCS`. `class NpcDialogs {talk(p, npcId, answer), close(p, answer), closeFor(p, reason: NpcCloseReason) /* server-side close: dead, warp, gone */, opened(p, npc) /* the talk walk arrived: session + npcDialog (+ buyback) */, tick(p, now) /* too_far auto-close */, forget(p), servicesOf(npc): NpcService[], requireService(p, npcId, service): Result<Npc> /* live, within NPC_INTERACT_RANGE, has the service */}`. |
| `apps/server/src/shop.ts` | `class Shops {buy(p, npcId, code, count, answer), sell(p, npcId, bag, count, answer), buyback(p, npcId, index, answer), forget(p), sendBuyback(p)}`: logic moved out of `gameplay.ts` `shopNpc/shopBuy/shopSell`, plus the cap filter, `maxStack × bagSize`, the strict gold cap and the buyback list `Map<characterId, BuybackEntry[]>`. |
| `apps/server/src/storage.ts` | Pure rules: `StorageDraft`, `deposit`, `withdraw`, `moveStored`, `goldIn`, `goldOut` (unit-testable like `inventory.ts`). |
| `apps/server/src/storage-db.ts` | `openStorageStore(store)`: load, write and `storageTx`, and the account-id cache. It also serves requests: `class StorageService {open, deposit, withdraw, move, gold}`, which sends `storage`/`storageUpdate`/`inventoryUpdate`. |
| `apps/server/src/item-use.ts` | `class ItemUses {use(p, bag, answer) /* potions, pills, return cast */, tick(p, now), cancel(p, reason), forget(p)}`: replaces `Gameplay.itemUse`, and sends `itemCooldown`, `itemCast` and `itemCastEnd`. |

### 8.2 Hook points in shared server files (small, exact)

**`apps/server/src/gameplay.ts`:**

1. The constructor creates `this.npcDialogs`, `this.shops`, `this.storage` and `this.itemUses` with the deps they need (world, data, store, config, and `afterInventory` / `toTown` / `stats` as callbacks). Make `afterInventory` and `toTown` non-private: rename them to public, or pass them as closures.
2. `start()`: `if (HIDDEN_NPCS.includes(n.code)) continue` in the NPC loop.
3. The `request()` switch:
   - `case 'itemUse': return this.itemUses.use(p, msg.bag, answer)`;
   - `case 'shopBuy'`/`'shopSell'` go to `this.shops`;
   - new cases `npcTalk`, `npcClose`, `storageOpen`, `storageDeposit`, `storageWithdraw`, `storageMove`, `storageGold` and `shopBuyback`, one line each;
   - `case 'stopAction'` also calls `this.itemUses.cancel(p, 'cancelled')`.
4. The `request()` dead check: add `npcClose` next to `respawn`, so closing works while dead.
5. `tickPlayer(p, now)`: its first line is `if (p.dead) return` [confirmed]; add `this.npcDialogs.tick(p, now); this.itemUses.tick(p, now)` right after it (dead players need neither: hook 8 handles death). Add an `else if (a?.kind === 'talk')` branch next to the `'pickup'` branch: look up `this.world.npcs.get(a.npc)` (gone → `p.action = null`); when `this.approach(p, npc, NPC_APPROACH_RANGE, a, now)` returns true, `p.action = null`, `this.world.halt(p, now, yawTowards(...))`, then `this.npcDialogs.opened(p, npc)`; when `approach()` itself cleared `p.action` (blocked walk) and `world.distance(p, npc, now) ≤ NPC_INTERACT_RANGE`, also call `opened` (§3.1 caveat).
6. `approach()` signature: `t: Mob | GroundItem | Npc` (`world.positionAt` already takes any `{pos, move?}`) [confirmed].
7. `forget(p)`: call `forget(p)` on the four modules.
8. `playerDied(p)`: `this.npcDialogs.closeFor(p, 'dead'); this.itemUses.cancel(p, 'interrupted')`. (`gmKill` also goes through `playerDied` [confirmed].)
9. `toTown(p)`: `this.npcDialogs.closeFor(p, 'warp')`, after the `world.warp` call (so `warp` precedes `npcDialogClose`, as §7.3 says).
10. Delete the old `itemUse`, `shopNpc`, `shopBuy` and `shopSell` bodies.

Ownership of these lines (so three lanes do not edit the same line): lane A owns hooks 2, 4, 5 (the `npcDialogs.tick` call and the talk branch), 6, 8 (`closeFor`), 9 and the shop part of 3 and 10; lane B owns its five storage cases in 3 and its line in 1 and 7; lane C owns the `itemUse`/`stopAction` parts of 3, the `itemUses.tick` call in 5, the `cancel` call in 8, and the `itemUse` part of 10. Each lane adds its own constructor line in 1 and its own `forget` call in 7.

**`apps/server/src/world.ts`:** `PlayerAction` gains `| { kind: 'talk'; npc: number; chaseAt: number; chaseTo: [number, number] | null }`.

**`apps/server/src/db.ts`:**

1. Append the §5.2 migration to `MIGRATIONS`.
2. Expose `writeDraft` in the returned object (one line).
3. Nothing else: storage statements live in `storage-db.ts` and use `store.db.prepare`.

**`apps/server/src/inventory.ts`:** `MAX_GOLD` is imported from `@sro/shared` (re-exported for old imports). `addGold(d, amount, opts?: {strict?: boolean})`: strict fails with `gold_limit` (lane A). `export` on the private `stackable()` (lane B, one word).

**`apps/server/src/gm.ts` (optional, lane A):** `tp`/`summon` call `world.warp` directly; add the dialog close there if `warp` (not `too_far`) should be the reason.

**`apps/server/src/connection.ts`:** no change. `isGameplay(msg)` and the per-type buckets are driven by `GAMEPLAY_REQUESTS` and `CLIENT_RATE_LIMITS`.

**`apps/server/src/config.ts`:** `STORAGE_FEE` (default 1 = on). `GOLD_RATE` is optional and later.

### 8.3 Client windows and hook points

**New files:**

| File | Contents |
|---|---|
| `apps/game/src/hud/npc-dialog.ts` | `class NpcDialogWindow extends HudWindow`: title (NPC name), greeting paragraph, option buttons (§3.2). `show(npcId, code, services)`, `hide()`, and callbacks `onShop`, `onStorage` and `onEnd`. Also `addTalkOption(npcCode, {label, run})` for the quests lane (docs/UX_GAPS.md §9 item 2). Frame: the inventory frame pieces used by `HudWindow`. |
| `apps/game/src/hud/shop.ts` | `class ShopWindow extends HudWindow`, about 330 × 420 px. Features: <ul><li>tab strip (ShopDef tabs; armour tabs filtered by the player's gender, with a Male/Female toggle; the reqLevel > cap filter);</li><li>a 6-column goods grid of icons (`ItemCatalog`) with the item tooltip plus "Price: {gold}";</li><li>buy by right-click or double-click; stackables open `askCount` (max = min(maxStack × free room, floor(gold / price), MAX_ITEM_COUNT));</li><li>a "Buy back" tab listing the `buyback` entries (right-click → `shopBuyback`);</li><li>sell by dragging a bag item onto the window, or right-clicking a bag item while the shop is open (stackables: `askCount` for the count; confirm dialog for items worth ≥ 1000 gold);</li><li>live gold display.</li></ul> Pure helpers (no DOM) go in `hud/shop-logic.ts` for tests: `visibleTabs(shop, gender, cap, items)`, `maxAffordable(def, gold, inv)`. |
| `apps/game/src/hud/storage.ts` | `class StorageWindow extends HudWindow`: a 10 × 15 grid of storage slots (scrolling; 150 slots) using `slots.ts` SlotView; gold line with Deposit/Withdraw buttons (`askCount` up to bag gold / storage gold); drag bag→storage (`storageDeposit` with `to`), storage→bag (`storageWithdraw` with `bag`), storage→storage (`storageMove`); right-click a bag item → deposit, right-click a stored item → withdraw; the fee is shown in the tooltip ("Storage fee: {gold}"). State: `StorageState` (like `InventoryState`) fed by `storage`/`storageUpdate`. |
| `apps/game/src/hud/item-cast.ts` | Cast bar: `start(item, castMs)`, `end(reason)`, a centred progress bar with the item name and seconds left. |

**Hook points in shared client files:**

1. **`apps/game/src/screens/world.ts`**, in `clickEntity` [confirmed name]: today it calls `setTarget(v)` and then returns unless `v.kind === 'mob'`. Add after `setTarget(v)`: `if (v.kind === 'npc') { if (!selfView()?.dead) send(intents.npcTalk(v.id)); return }`. The world screen builds its messages with `intents` from **`apps/game/src/world/intents.ts`** (checked by `test/world.test.ts`), not with the HUD's `intent` object, so the `npcTalk` builder goes there (`npcTalk: (npc: number): ClientMessage => ({ t: 'npcTalk', npc: id(npc) })`). Its failures are handled in world.ts `onActionResult` (a `case 'npcTalk'` toast, like `attack`), so `npcTalk` is **not** added to the HUD's `OWN_REQUESTS`. Also: the `Escape` branch (today `menu → clearTarget → openMenu`) closes the NPC dialog first (`hud.closeNpc()`). Other players' `itemCast` / `itemCastEnd` may start or stop a small effect on that entity (optional).
2. **`apps/game/src/hud/index.ts`:**
   - create the three windows and the cast bar;
   - subscribe to `npcDialog`, `npcDialogClose`, `storage`, `storageUpdate`, `buyback`, `itemCooldown`, `itemCast` (self) and `itemCastEnd`;
   - add the new request types except `npcTalk` to `OWN_REQUESTS` (today `itemMove … shopBuy, shopSell` [confirmed]);
   - `Hud` gains `closeNpc()` and `readonly npcOpen: boolean`;
   - inventory right-click routing (`useIntent`): if the storage window is open → deposit; else if the shop window is open → sell; else the current use/equip.
3. **`apps/game/src/hud/intents.ts`:** add to the `intent` object the builders `npcClose`, `storageOpen`, `storageDeposit`, `storageWithdraw`, `storageMove`, `storageGold`, `shopBuy`, `shopSell` and `shopBuyback` (none exist yet, including `shopBuy`/`shopSell` [confirmed]), each returning a validator-clean message or null.
4. **`apps/game/src/hud/slots.ts`:** an optional cooldown sweep overlay per slot (`setCooldown(readyAt, totalMs)`). **Conflict:** docs/UX_GAPS.md (W4, §9 item 1) assigns one shared cooldown clock, `hud/cooldowns.ts`, to the skills lane, feeding both hotbar and bag sweeps, and its UX-A lane and the skills lane also edit `slots.ts`. So the item sweep feeds that clock (`itemCooldown` → `cooldowns.set(group, readyAt, totalMs)`) instead of a private `hud.itemCooldowns` map, and the `slots.ts` overlay is written once, by whichever lane lands first, with the others reusing it.
5. **`apps/game/src/i18n/en.ts`:**
   - `npc.greeting.default`, `npc.option.*`;
   - `shop.title`, `shop.tab.male`, `shop.tab.female`, `shop.tab.buyback`, `shop.price`, `shop.sellConfirm`, `shop.buyCount`;
   - `storage.title`, `storage.gold`, `storage.deposit`, `storage.withdraw`, `storage.fee`;
   - `cast.return`, `cast.cancelled` ("The use of return scroll has been canceled.");
   - `action.fail.gold_limit`, `action.fail.storage_full`, `action.fail.busy`.
6. **`apps/game/src/net/mock.ts`** (with its rule helpers in `net/mock-rules.ts`): add `npcTalk`/`npcClose`/`storage*`/`shopBuyback` and the return cast, so the UI can be tested offline (this mirrors the server rules loosely). The mock's existing `shopBuy`/`shopSell`/`itemUse` cases are around `mock.ts` lines 1328–1380 [confirmed].
7. **`apps/game/src/world/intents.ts`:** the `npcTalk` builder (hook 1).

## 9. Build plan

The lanes can run in parallel once lane S (shared) lands. S is small and should go first, or be done by whichever lane starts first. Every lane runs `pnpm typecheck` and its tests. **Nobody edits another lane's owned files.** Shared files get only the hook lines listed in §8.2 and §8.3.

### Lane S: shared protocol (first, about 1 hour)

- **Owns:** `packages/shared/src/protocol.ts` (the §7.1 additions, `CLIENT_RATE_LIMITS` rows); `packages/shared/src/validate.ts` (the client and server message validators of §7.2); `packages/shared/src/content.ts` (the §7.5 optional fields); `packages/shared/src/content-check.ts` (accept them); `docs/PROTOCOL.md` (§8 rewritten to point here, plus the §11 table rows).
- **Tests:** `packages/shared/test/shops.test.ts`:
  - every new client frame accepted with exact keys;
  - rejected with an extra key, a missing key, a negative or fractional number, `amount` 0, `amount` > MAX_GOLD, `dir` 'steal', `index` 5, and a storage slot of 180;
  - server frames round-trip, with unknown keys dropped;
  - `storage.slots` longer than 180 rejected.
- **Check:** `pnpm vitest run packages/shared/test`.

### Lane A: server NPC dialogs + shops (after S)

- **Owns:** `apps/server/src/npc.ts`, `apps/server/src/shop.ts`, and the new tests.
- **Hooks:** `gameplay.ts` §8.2, the lane-A lines listed under "Ownership of these lines" (it creates only its own modules; lanes B and C add their one-liners in the same switch); `apps/server/src/world.ts` `PlayerAction` 'talk'; `inventory.ts` `addGold` strict + `MAX_GOLD` import; optionally `gm.ts` (close on `tp`/`summon`).
- **Tests:**
  - `apps/server/test/npc-shop.test.ts`, units over a synthetic world (fixtures.ts):
    - talk in range → `npcDialog` with the right services;
    - talk at 30 m → walks, then dialog;
    - auto-close at 8.1 m; close on death and on warp;
    - a second talk replaces the first (close + open);
    - hidden NPC not spawned;
    - buy filter above the cap → `not_found`;
    - count > maxStack × bagSize → `invalid_count`;
    - exact gold arithmetic; `inventory_full` leaves gold unchanged;
    - sell at MAX_GOLD − 1 → `gold_limit`, nothing changes;
    - buyback restores the exact stack and gold, keeps 5 entries (the 6th pushes out the oldest), and is empty after `forget`.
  - **Abuse tests:**
    - two `shopSell` of the same slot back to back → second `invalid_slot`;
    - sell with `count` > stack → `invalid_count`;
    - sell a quest item / `canSell: false` → `not_usable`;
    - buy from an NPC without a shop → `not_found`;
    - buy from a shop NPC 9 m away → `too_far`;
    - a `shopBuyback` index twice → second `not_found`;
    - `npcTalk` on a mob / an item / a player id → `not_found`;
    - talk walk blocked short of 3 m but within 8 m → the dialog still opens.
  - Extend `apps/server/test/gameplay-e2e.test.ts` with one socket-level round: talk → dialog → buy → sell → buyback. The rate-limit check also goes here, because the per-type buckets live in `connection.ts`, not in `Gameplay` [confirmed]: 11 `shopBuy` sent back to back → the 11th `rate_limited` plus a strike (burst 10; spread over a full second, about 15 would pass because the bucket refills 5/s).
- **How the user checks it:**
  0. New characters start with 0 gold (`characters.gold` defaults to 0 [confirmed]). Kill a few mobs first, or use a GM account: `/item ITEM_ETC_GOLD_01 5000` adds 5000 gold (PROTOCOL §10).
  1. Log in and walk to the Herbalist (62 m east of spawn).
  2. Click him: the character walks up and a dialog opens with his greeting and "Trade in the shop."
  3. Buy 10 HP Recovery Herbs (600 gold) and see them in the bag and the gold drop.
  4. Sell 5 back: gold rises by 105.
  5. Open "Buy back" and buy them back for 105.
  6. Walk away: the dialog and shop close by themselves.

### Lane B: server storage (after S; parallel with A)

- **Owns:** `apps/server/src/storage.ts`, `apps/server/src/storage-db.ts`, and the new tests.
- **Hooks:** `db.ts` (append the migration, expose `writeDraft`); `gameplay.ts` (five one-line switch cases, its constructor line and `forget` call); `inventory.ts` (`export` on `stackable`); `config.ts` `STORAGE_FEE`.
- **Tests:**
  - `apps/server/test/storage.test.ts`, pure units on `StorageDraft`: deposit merge / split / empty slot, withdraw into a chosen bag slot, move/merge/swap, the fee arithmetic, `storage_full`, and the gold in/out caps.
  - db tests on a temp `DATA_DIR`:
    - the migration applies on an existing database at the previous schema version (v4 today: `MIGRATIONS` has 4 entries [confirmed]; higher if the skills/party migrations land first);
    - an item is never in both tables after any sequence;
    - a throw inside `fn` rolls back both tables;
    - storage survives character deletion (deletion is a soft delete, `softDeleteCharacter` sets `deleted_at` [confirmed], so this mainly checks that storage is keyed by account, not character);
    - two characters of one account see the same chest.
  - **Abuse tests:**
    - deposit the same bag slot twice → second `invalid_slot`;
    - withdraw from slot 179 of a 150-slot storage → `invalid_slot`;
    - `storageGold withdraw` more than stored → `not_enough_gold`;
    - `storageGold deposit` more than carried → `not_enough_gold`;
    - withdrawal that would pass MAX_GOLD → `gold_limit`;
    - deposit a quest item → `not_usable`;
    - storage request 9 m from the keeper, or at the Smith → `too_far` / `not_found`;
    - deposit while dead → `dead`;
    - a relog on another socket mid-sequence cannot duplicate (connection replaced; the final DB state has one row per item).
- **How the user checks it:**
  1. Walk to Storage-keeper Sansan (38 m south of spawn) and click her, then "Deposit into storage."
  2. Drag a sword into storage: the fee (21; the starter `_DEF` sword also has KeepingFee 21 [confirmed]) is taken. This needs lane F's `keepFee` export; before that the fee is 0.
  3. Deposit 1000 gold.
  4. Log out, log in with another character of the same account, open storage: the sword and the gold are there.
  5. Withdraw both.

### Lane C: server consumables (after S; parallel with A and B)

- **Owns:** `apps/server/src/item-use.ts` and the new tests.
- **Hooks:** `gameplay.ts` (the `itemUse` and `stopAction` cases, `tickPlayer`, `forget`; delete the old `itemUse`); `formulas.ts` unchanged (it reuses `POTION_COOLDOWN_MS`).
- **Tests:** `apps/server/test/item-use.test.ts`, a synthetic world with a controlled clock:
  - HP herb heals min(120, missing) and arms 'hp' for 1000 ms, then `itemCooldown {group: 'hp', readyInMs: 1000}`;
  - a second use at +999 ms → `cooldown`; at +1000 ms → ok;
  - an MP potion is usable at the same time;
  - a grain heals 25%;
  - a pill → `not_usable` and is not consumed;
  - return scroll 01: `itemCast castMs 30000`; no warp at 29.9 s; warp at 30 s; exactly one scroll consumed; `itemCastEnd done` comes before `warp`;
  - moving at 10 s → `interrupted`, no scroll consumed;
  - taking a mob hit does not interrupt;
  - a second return use during a cast → `busy`;
  - selling the scroll stack mid-cast → `itemCastEnd cancelled`, no warp;
  - `stopAction` → `cancelled`;
  - death → `interrupted`;
  - the return scroll works in combat (the old refusal is gone).
- **How the user checks it:**
  1. Buy a Return Scroll at the Grocery Trader and walk out of town.
  2. Use it: a 30 s bar appears. Moving cancels it with "The use of return scroll has been canceled."
  3. Use it again and wait: you land at the town spawn.
  4. Drink potions in a fight: an HP potion and an MP potion can be chained 1 s apart, and the slot shows the sweep.

### Lane D: client NPC dialog + shop (after S; can use the mock)

- **Owns:** `apps/game/src/hud/npc-dialog.ts`, `apps/game/src/hud/shop.ts`, `apps/game/src/hud/shop-logic.ts`, and `apps/game/test/shop.test.ts`.
- **Hooks:** `screens/world.ts` (`clickEntity` NPC branch, `onActionResult` `npcTalk` case, Escape); `world/intents.ts` (`npcTalk` builder); `hud/index.ts` (create the windows, subscriptions, `OWN_REQUESTS`, right-click routing); `hud/intents.ts` (builders); `i18n/en.ts` (keys); `net/mock.ts` (`npcTalk`/`npcClose`/`shopBuyback`).
- **Tests:**
  - `shop.test.ts`: `visibleTabs` (a male sees the male tabs first, the cap filter drops the level-21 chests); `maxAffordable` (gold-bound, room-bound, stack-bound);
  - every intent builder output passes `parseClientMessage` (the `npcTalk` one in `apps/game/test/world.test.ts`, next to the other world intents);
  - `apps/game/test/i18n.test.ts` keeps passing: every new key exists.
- **How the user checks it:** as lane A, in the browser. Also:
  - the armour trader shows Armor / Protector / Garment for your gender, with a Male/Female switch, and no level-21 chest;
  - hovering a good shows its stats and price;
  - right-clicking a bag item with the shop open sells it (asks for the count on stacks).

### Lane E: client storage + cast bar + cooldown sweep (after S; parallel with D)

- **Owns:** `apps/game/src/hud/storage.ts`, `apps/game/src/hud/storage-state.ts`, `apps/game/src/hud/item-cast.ts`, and `apps/game/test/storage.test.ts`.
- **Hooks:** `hud/index.ts` (storage window, cast bar, `itemCooldown` → the shared cooldown clock); `hud/slots.ts` (the cooldown overlay, only if the skills/UX-A lanes have not added it); `i18n/en.ts`; `net/mock.ts` (storage and the return cast).
- **Coordination:** the skills lane owns `hud/cooldowns.ts` (docs/UX_GAPS.md W4, §9 item 1) and `hud/hotbar.ts`, which consumes HotbarEntry `kind: 'item'` (§4.5). This lane feeds `itemCooldown` into that clock and does not edit hotbar.ts or cooldowns.ts. If the clock has not landed, it keeps a temporary `Map<group, {readyAt, totalMs}>` behind the same `set/get` shape and swaps to the clock once it lands.
- **Tests:** `storage.test.ts`: `StorageState` applies a snapshot and updates idempotently; drag rules bag↔storage map to the right intents; `storageGold` amounts are bounded.
- **How the user checks it:** as lanes B and C, in the browser, including the cast bar counting down and the potion sweep on inventory slots.

### Lane F: exporter additions (optional, parallel; `packages/convert`)

- **Owns:** `packages/convert/src/data/items.ts` (keepFee col 30, repairCost col 27, canRepair col 22, `use.cooldownMs` 1000 with its `fieldSources` note for potions and pills) and `packages/convert/src/data/npcs.ts` (a greeting per NPC from npcchat + `textquest_speech&name.txt`; `client-source.ts` today reads only `CONTENT_STRING_TABLES = ['textuisystem.txt', 'textdataname.txt']` [confirmed], so the speech table and `npcchat.txt` (cols: service, NPC code, `_BS` id, `_PS` id [confirmed]) must be added there; `packages/convert/src/data/client-source.ts` is part of this lane's owned files).
- **Tests:** `packages/convert/test/data-builders.test.ts` (synthetic rows: keepFee/repairCost read, a greeting resolved, the `...` greeting kept); `data.corpus.test.ts` (Herbalist greeting starts "With consistent patients"; Copper Sword keepFee 21, repairCost 198).
- **Check:** re-run the export (`pnpm tsx packages/convert/src/tools/export-data.ts --no-icons`), and see `npcs.json` greetings and the new item fields.

### Order and merge notes

1. S first.
2. A, B, C, D and E in parallel, with F anytime.
3. A, B and C all touch the same `gameplay.ts` `request()` switch. Each adds only its own `case` lines and its module construction line, so merges are line-local.
4. The storage migration takes the **next free index at merge time**. If the skills or party lane lands a migration first, renumber by appending; never edit an applied migration.

## 10. Open questions

- **Return scroll timings.** Are 30 / 15 / 5 s (Param1) the retail cast times, and does retail consume the scroll at start or at completion? One capture of a retail return settles both.
- **Potion cooldown.** Is it 1 s per group? Do HP and vigor share a group? The client data has none.
- **Storage.** Is it per account (as specified) and 150 slots? Does retail charge `KeepingFee` per unit or per stack?
- **Buyback.** Does retail hold 5 entries, and does the list clear on logout?
- **Durability wear rate and repair formula** (the `Cost_Repair` scaling), before building §2.6.
- **Selling a +N item.** Should the price scale? Irrelevant until enhancement exists.
- **Gold rate.** Is levelgold × 0.7 enough to afford degree-3 gear by level 20? Decide after the friends play; `GOLD_RATE` is the knob.
- **NPC yaw.** It is unverified (DATA.md open point). A dialog does not need NPCs to face the player; optional client-side turn-to-face.
