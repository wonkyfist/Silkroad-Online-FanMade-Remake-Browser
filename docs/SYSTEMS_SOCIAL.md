# Social systems: player trade, stalls, guilds

This spec designs three systems for the friends server: the retail **exchange** (player-to-player trade), **stalls** (player shops) and **guilds**. It follows docs/PROTOCOL.md conventions (intents only, one `actionResult` per request, strict client frames, per-type budgets) and the build method of docs/WAVE_PLAN.md: protocol step, seam steps, lanes with disjoint files, integration, adversarial hunt, fixes.

**Tags.**

- **[confirmed]**: checked in the code at HEAD `3937b5e` (2026-09-28), in `work/out/data`, or in the retail client files (`Media.pk2` resinfo layouts, `textuisystem.txt`, `itemdata_*.txt`).
- **[likely]**: strong evidence, not proven.
- **[unknown]**: open.
- **[decision]**: a choice this spec makes.

**Line numbers** were re-checked against the working tree (HEAD `3937b5e` plus uncommitted edits) in a fact-check pass on 2026-09-28. At that time `git status` showed other agents' uncommitted edits in files the seam steps touch: `apps/server/src/{gameplay,npc,gm,game,progression}.ts`, `apps/game/src/hud/{index,player,skills}.ts`, `apps/game/src/screens/world.ts`, `apps/game/src/i18n/en.ts`, `apps/game/src/style.css` and `packages/convert/src/data/{npcs,frame,port-source}.ts`. The seam steps find their hook points by the quoted code, not by line number.

**Sibling specs of the same wave** (written in parallel; this spec was reconciled with them in the fact-check pass):

- `docs/SYSTEMS_COMBAT.md`: horses, monster skills, durability and repair, alchemy, Berserk. Its foundation step **F6-FS** (§8) owns `protocol.ts`, `validate.ts`, `content.ts`, `db.ts`, `config.ts` and the one-line seams in `gameplay.ts`, `npc.ts` and `gm.ts`. Its exporter lane **EXP** owns `packages/convert/src/data/items.ts`.
- `docs/EFFECTS.md`: skill, drop and posture visuals. Its seam step **FX-0** (§6.1) owns `apps/game/src/three/models.ts` and the seam lines of `apps/game/src/world/entities.ts`, including `EntityView.idle` and `KEEP_CLIPS += VENDOR01`. It also adds `sit`/`emote` requests (P4).
- `docs/UI.md`: the UI rework. **UI-X** owns `packages/convert/src/tools/export-ui.ts`. **UI-K** owns the new component kit `apps/game/src/ui/kit/**`. **UI-H** later owns `hud/target.ts` and `world/chat.ts`. **UI-W** later owns `hud/npc-dialog.ts`, `hud/inventory.ts`, `hud/options.ts` and `hud/party-invite.ts`. UI.md §9 says the migration lanes run **after** the feature lanes have merged their HUD hooks.

**Reference files kept for the build lanes** (under `work/tmp/systemsB/`):

- `retail-layouts.txt`: every control of `ifexchange.txt`, `ifstall.txt`, `ifstallslot.txt`, `ifguild.txt`, `ifguildmemberslot.txt`, `ifguildgrantpower.txt` and `ifguildnotifywrite.txt` (name, class, id, rect, DDJ, text key). It is produced by `dump-if.ts` (`pnpm tsx work/tmp/systemsB/dump-if.ts ifexchange.txt ...`).
  - **Caveat (fact-check):** `dump-if.ts` tags whole-control `#ifdef`s but not `#ifdef`s around a single property. For those it keeps the **last** value, which is the `#else` (no-define) branch. `ifexchange.txt` has seven such rects, and the client's `define.txt` turns both of its defines on [confirmed]. The rects of the actual 1.188 layout are: Confirm `GDR_EXCHANGE_BUTTON_EXCHANGE` (96,450,76,24), Cancel `GDR_EXCHANGE_BUTTON_CANCEL` (193,450,76,24), subframes (9,38,346,141) and (9,182,346,141), gold tiles `NORMALTILE_OTHER` (25,72,225,91) and `NORMALTILE_MY` (25,215,225,92), divider `NORMALTILE_BG` (40,179,285,3). The dump is right for the stall and guild files, which have no `#if` at all [confirmed].
- `ui-strings-social.tsv`: 464 English retail strings (CodeName128 → English) about exchange, stalls and guilds. It is filtered from `textuisystem.txt` column 8.
- `png/`: the retail art the windows need, decoded with `packages/convert/src/tools/ddj2png.ts`:
  - exchange: `exc_box.png`, `ch_line.png`, `exc_sub_window_line.png`;
  - stall: `stl_slot_01..05.png` (308×28, 208×44, 400×28, 96×24, 208×44), `stl_condition_icon_01/02.png`, `stl_titlebutton.png`, `stl_wordbutton.png`, `stl_edit_button.png`, `stl_color_select.png`, `sell_masgbox_iteminfo.png`, and the wooden booth texture `booth.png` (`Data/prim/mtrl/avatar/booth.ddj`, 128×128). `ifstall.txt` names `stl_condition_icon_1.ddj`, which does not exist; the folder has `stl_condition_icon_01.ddj` and `_02.ddj` [confirmed];
  - guild: `gil_contact_on/off.png`, `gil_sysbutton_guild.png`, `gil_namewindow.png`, `gil_windo01.png`;
  - action icons: `icon_cha_exchange.png`, `icon_cha_shop.png`, `icon_cha_sit.png`.

**Scope.**

- In scope: exchange, stalls with their own chat (P2), guilds with ranks and permissions, a guild notice, guild chat, the guild name on nameplates, a member list with online status, and disbanding.
- Out of scope:
  - retail features that need systems we do not have: guild storage (retail needs guild level 2 [confirmed `UIIT_MSG_GUILD_WAREHOUSE_LIMIT`]), guild levels and GP, unions/alliances, guild wars, the guild crest, and mercenaries;
  - stall extras: the stall network (`WARENETWORK`), avatar booths (`booth_mob_*`) and offline stalls.

---

## 0. Summary

1. **Exchange.**
   - One trade per player. A requests a trade with B within 10 m, and B accepts.
   - Both get a window with 12 item slots and one gold field per side [confirmed `ifexchange.txt`: `GDR_EXCHANGE_MY_SLOT_200..211`, `GDR_EXCHANGE_OTHER_SLOT_100..111`, `GDR_EXCHANGE_BUTTON_MONEYBTN`].
   - The deal takes two steps. **Lock** freezes your own offer. When both sides are locked, **Accept**. When both have accepted, the server swaps everything in **one SQLite transaction** over both characters' rows.
   - Any change to one offer clears the other side's lock. Moving, fighting, dying, warping or leaving cancels the trade.
2. **Stalls.**
   - In a town safe area, a player creates a stall with a title and up to 10 listings (bag slot, count, price 1..1,000,000,000 [confirmed `UIIT_MSG_FLEAMARKET_ERR_INVALID_PRICE`]).
   - The player sits, and a sign with the title floats over the name.
   - Up to 8 visitors [confirmed `UIIT_MSG_FLEAMARKET_ERR_MARKET_FULL`] browse, and buy a whole listing in one transaction. The gold goes straight into the owner's bag.
   - The owner switches between *Modify* (listing edits allowed, no sales) and *Open* (sales allowed, no edits). A purchase carries the code, count and price the buyer saw, so a price change during a purchase fails safely.
   - Stalls are runtime only. They close on logout, warp, death or restart.
3. **Guilds.**
   - Created at Guild Manager Leebaek (`NPC_CH_GENARAL_SP`, Jangan (-89.3, -249.0) [confirmed `npcs.json`]) for gold and a minimum level. Both are config knobs.
   - Names: 2–12 characters, a leading letter [retail "2~12 English letters" confirmed `UIIT_MSG_GUILDERR_INVALID_GUILDNAME_LEN`], unique regardless of case.
   - One Master. Members carry retail-style permission flags (Join = invite, Withdraw = kick, Notice, Title [confirmed `ifguildgrantpower.txt` column labels]) and an optional title.
   - Guild chat uses channel `'guild'` with the `@` prefix [confirmed `UIIT_CTL_CHATMENU_GUILD` "@Guild"]. The guild name shows on nameplates.
   - The guild window (key **U** [confirmed `UIIT_STT_TOGGLE_GUILD` "Guild ( U )"]) shows members with online status.
   - Stored in SQLite: tables `guilds` and `guild_members`, plus a `social_log` for trades and stall sales.
4. **One new migration.** It takes the next free index when the foundation step lands it: v8 if this spec lands alone, since the schema is v7 today [confirmed `db.ts` has 7 `MIGRATIONS`; the comment reserves 8 for a late wave-4 need that never came]. docs/SYSTEMS_COMBAT.md §6.2 adds one too, so in a merged wave the integrator numbers them (v8, v9). See §7.
5. **New generic seams.**
   - Server: `GameplayModule.gate()`, a veto hook that locks a trading or stalling player's inventory against every other request (§2.3).
   - Client: an NPC-service handler registry (only the guild uses it), an additive target-action API, a bag-slot lock marker and a ground-click veto (§9.1).
   - Correction from the fact-check: SYSTEMS_COMBAT does **not** use the NPC-dialog registry (repair buttons live in the shop window, horses are bought in the stable shop) [confirmed SYSTEMS_COMBAT §1.5, §3.4]. The idle-clip override belongs to EFFECTS FX-0 (`EntityView.idle`) [confirmed EFFECTS §6.1], so this spec asks FX-0 for one more idle value instead of building its own (§4.3).

---

## 1. Retail reference

| Fact | Source | Tag |
|---|---|---|
| Exchange window: 12 own slots (2 rows × 6, 32 px, pitch 36) and 12 partner slots, a gold box each (`exc_box.ddj` 108×20), a money button for your own gold (`com_moneybutton.ddj`; `com_moneybutton_disable.ddj` on the partner side), buttons **Confirm** (`UIIT_CTL_CONFIRM`) and **Cancel**. Partner on top, you below. | `resinfo/ifexchange.txt` | confirmed |
| Exchange window size **365×500** (`mframe_wnd_`, caption `UIIT_STT_EXCHANGE`). `ginterface.txt GDR_EXCHANGE` has 365×500 under `APPLY_EXCHANGE_UPDATE_1TH` + `UI_UPDATE_2009_FIRST`, 363×363 with only the first, and 254×361 with neither. Both defines are on in `Media/config/define.txt`. So the vSRO 1.188 window also has the two character views (`com_blacksquare_` 100×104 at (247,70) and (247,214), `ch_red.ddj` 128×128 over the partner view) and a text box `frame_msg_` (10,339,345,95). (docs/UI.md §4.6 says 254×361; that is the no-define branch.) | `ginterface.txt`, `define.txt`, `ifexchange.txt` | confirmed |
| Exchange strings: "Applied for the exchange. Will you accept it?" (`UIIT_MSG_DEAL_ASK`); "Applying for a trade to [%s]." (`UIIT_MSG_DEAL_ASKING`); "Waiting for other player's approval." (`UIIT_MSG_EXCHANGE_AGREEMENT_WAIT`); "The exchange has been canceled."; "Cannot exchange because [%s]'s inventory is full."; "Cannot add the selected item because the exchange window is full."; "Trade cannot be carried out because there is no item to be traded."; "The selected item cannot be traded."; "You started to exchange with [%s]." / "Exchanging with [%s] is completed." | `textuisystem.txt` | confirmed |
| Chat commands `/Exchange`, `/trade`, `/Stall`, `/guild`, `/g`, `/join`, and the "@Guild" chat menu. | `UIIT_STT_CHAT_COMMAND_*`, `UIIT_CTL_CHATMENU_GUILD` | confirmed |
| Two-step confirm: Confirm locks, then the exchange completes once both approve. | the one Confirm button plus the "Waiting for other player's approval" string | likely |
| Whether retail lets a player walk while the exchange window is open. | none | unknown |
| Exchange request range and expiry time. | none | unknown |
| Item flag `CanTrade` is column 16 (0-based) of `itemdata_*.txt` (the column before `CanSell` 17, which our exporter already reads). Over the nine `itemdata_<n>.txt` files, 2,038 of 11,914 service rows are 0: event items (`ITEM_EVENT_*`), quest items (`ITEM_QNO_*`), trade goods (`ITEM_ETC_TRADE_*`) and the `*_DEF` creation defaults. Potions, scrolls and shop weapons are 1. | checked rows: `ITEM_ETC_HP_POTION_01` 1, `ITEM_ETC_SCROLL_RETURN_01` 1, `ITEM_CH_SWORD_01_A` 1, `ITEM_QNO_CH_SMITH_1` 0, `ITEM_CH_SWORD_01_A_DEF` 0 (fact-check scan of all nine files, CanTrade = column 16) | confirmed |
| **Effect on our export:** `work/out/data/items.json` holds 514 items. 25 of them have `CanTrade` 0, and all 25 are `*_DEF` starter items (the 6 starter weapons and shield, 18 starter armour pieces, `ITEM_ETC_AMMO_ARROW_01_DEF`). `items.json` has **no** `ITEM_QNO_*` or `ITEM_ETC_TRADE_*` rows. Our quest items are `QITEM_*` in the quest bag. So in practice `canTrade` makes the **starter kit** untradable and unlistable, as in retail. | fact-check scan of `items.json` against itemdata | confirmed |
| Stall window 467×490 (`ginterface.txt GDR_STALL`). Title line with a change-title button, owner greeting line with an edit button, a scrolling list of slot rows (icon, name, amount, price, modify button), and a chat module at the bottom. The Open/Modify button is `GDR_BTN_TRADINGSTATE` (`com_button` at (369,51)). "Operating" (`UIIT_STT_TRADING_NOW`) is a static label on `stl_slot_04` at (350,85) with the state icon beside it, not a button. | `ginterface.txt`, `ifstall.txt`, `ifstallslot.txt` | confirmed |
| 10 stall slots. | The 423×216 list area (`CIFScrollManager`) fits 2 columns (a divider tile at x 226) × 5 rows of `stl_slot_02` rows (208×44). It is a scroll manager, so more rows could scroll. | likely |
| Stall strings: default title "[%s]'s stall." (`UIIT_STT_STALL_DEFAULT_TITLE`); default greeting "Welcome to [%s]'s stall."; Open / Modify / "Modifying"; "The shop is under construction." (host modifying); "The member limit(8) has been reached."; "Can set the value only from 1 to 1 billion gold."; "Cannot open a new shop whithout the registered goods."; "[%s]bought item [%s]." (owner notice); "[%s]has left the shop."; "Cannot buy due to insufficient gold"; "Cannot buy due to insufficient space in your inventory"; "You cannot use the stall during the battle.". | `textuisystem.txt` | confirmed |
| Stall colour choice ("Select the color of the stall.") and avatar booths (`Data/prim/mesh/avatar/booth_mob_*.bms`, item `.bsr`s). | textdata, Data.pk2 | confirmed (out of scope) |
| A plain wooden booth mesh `prim/mesh/avatar/booth.bms` (1,938 bytes; texture `prim/mtrl/avatar/booth.ddj` 128×128, `png/booth.png`; there is no `booth.bmt`) is the **shared base part of every avatar booth**: all four booth `.bsr`s list it as a mesh, next to their own mesh (`res/avatar/booth_mob_{bigeyeghost,earthghost,mangyang}.bsr`, `booth_special_monster_01.bsr`, and the same four under `res/item/avatar/`). (The first draft said no `.bsr` references it; that was wrong.) Whether a stall **without** an avatar booth draws it is unknown. | `grep -F "booth.bms" Data/res` (fact-check) | confirmed file and references; default use unknown |
| Stalls only in towns in retail. | Only the stall *network* says "can only be used in town" (`UIIT_MSG_WARENETWORK_USE_CITY`), and "during the battle" suggests stalls also exist outside town. | unknown → decision: town only (§4.1) |
| Stall persists after logout. | "The shop is closed." when the host left (`UIIT_MSG_FLEAMARKET_ERR_HOST_LEFT`) | likely: no persistence |
| Guild creation costs gold: "If you pay 0.5 million gold, [%s] guild will be created." Refused when the level is too low (value not in the client). | `UIIT_MSG_GUILD_QUESTION_CREATE`, `UIIT_MSG_GUILDERR_TOO_LOW_CREATOR_LEVEL` | confirmed string; level unknown (level 20 [likely] from memory) |
| Guild name "must consist of 2~12 English letters"; "The selected guild name already exsists."; one guild per character ("More than one guild cannot be organized."). | `UIIT_MSG_GUILDERR_*` | confirmed |
| Rejoin penalty 72 h after leaving; no new guild for 15 days after disbanding. | `UIIT_MSG_GUILD_QUESTION_EXIT2`, `UIIT_MSG_GUILD_ERROR_CREATE_BREAK_RENEW` | confirmed |
| Ranks: Guild Master, Vice Master, Member (`UIIT_STT_GUILD_LEADER/STAFF`, `UIIT_STT_GUILDSMAN`). The master grants per-member rights in columns Join / Withdraw / Name / Storage / Notice (`UIIT_STT_ENLIST_AUTHORITY`, `UIIT_STT_REMOVE_AUTHORITY`, `UIIT_STT_TITLE`, `UIIT_STT_STORAGEROOM`, `UIIT_MSG_NOTIFY`). Members can get a title ("Grant name", "Enter the title to address [%s]"). "You are the leader of the guild and you cannot be banned". | `ifguildgrantpower.txt`, `ifguild.txt` command buttons 101–106, `textuisystem.txt` | confirmed |
| Guild window: the guild page of the **community window** (`GDR_COMMUNITY`, `mframe_wnd_` 477×393, caption `UIIT_STT_COMMUNITY`). Header (`gil_windo01.ddj` 588×108 texture) with name, level, master, member count, GP gauge; notice box (title and contents, edit button `stl_edit_button`); member list rows (on/off lamp `gil_contact_on/off.ddj` 12×16, race mark, name, level, grade, donated GP); sort buttons; command buttons 101–106 labelled "Join" (`UIIT_STT_GUILD_JOIN`), "Grant authority" (`UIIT_CTL_AUTHORITY_GRANT`), "Withdraw" (`UIIT_STT_GUILD_EXPULSION`, i.e. ban), "Leave" (`UIIT_STT_GUILD_EXIT`), "Grant name" (`UIIT_STT_GUILD_NAME_GRANT`), "Position allocating" (`UIIT_CTL_GUILD_POSITION_GRANT`). | `ginterface.txt`, `ifguild.txt`, `ifguildmemberslot.txt`, `textuisystem.txt` | confirmed |
| Guild Manager NPC in Jangan: `NPC_CH_GENARAL_SP` "Guild Manager Leebaek". It has no roles in `npcs.json` today. | `work/out/data/npcs.json` | confirmed |
| Guild window key U; "Display Guild Name" option (`UIIT_STT_GUILDVIEW_SIGN`). | `textuisystem.txt` | confirmed |
| Where the guild name sits on the nameplate (above or below the name). | none | unknown → decision §5.7 |
| Stall pose clips. Every Chinese player sidecar has `SIT_DOWN` (1,666 ms, one-shot), `SIT` (2,666 ms loop), `STAND_UP` (1,600 ms, one-shot) and `VENDOR01` (13,333 ms loop, `chinaman_vendor01.ban`), all in the `default` pack group that `ensureClips` always loads for players. `KEEP_CLIPS` keeps the SIT clips and drops `VENDOR01` today. docs/EFFECTS.md §3.12 names `VENDOR01` as the retail stall loop [likely]. | `work/out/char/china/chinaman_adventurer.json`, `three/models.ts:51` | clips confirmed; which one retail plays for a stall: likely VENDOR01 |

---

## 2. Shared model

### 2.1 Constants (`packages/shared/src/protocol.ts`)

```ts
// ---- social systems (docs/SYSTEMS_SOCIAL.md) ----
export const TRADE_SLOTS = 12                 // per side [confirmed ifexchange.txt]
export const TRADE_RANGE = 10                 // m: request, accept, lock, accept [decision]
export const TRADE_BREAK_RANGE = 15           // m: an open trade ends beyond this [decision]
export const TRADE_REQUEST_MS = 30_000        // like PARTY_INVITE_MS [decision]
export const STALL_SLOTS = 10                 // [likely]
export const STALL_VISITORS_MAX = 8           // [confirmed string]
export const STALL_RANGE = 10                 // m: visit and buy [decision]
export const STALL_BREAK_RANGE = 15           // m: a visitor farther than this leaves [decision]
export const STALL_PRICE_MAX = 1_000_000_000  // [confirmed string]
export const STALL_TITLE_MAX = 32             // code points [decision]
export const STALL_GREETING_MAX = 80          // code points [decision]
export const STALL_NPC_CLEARANCE = 3          // m from any NPC entity [decision]
export const STALL_SPACING = 1.5              // m from another stall owner [decision]
export const GUILD_NAME = /^[A-Za-z][A-Za-z0-9]{1,11}$/   // 2..12 [confirmed length; letters+digits is a decision]
export const GUILD_TITLE_MAX = 12             // code points [decision]
export const GUILD_NOTICE_TITLE_MAX = 32      // code points [decision]
export const GUILD_NOTICE_MAX = 240           // code points; keeps guildNotice under the 1024-byte frame [decision]
export const GUILD_INVITE_MS = 30_000
export const GUILD_MEMBERS_MAX = 100          // parser bound; the live cap is config GUILD_MAX_MEMBERS
export const GUILD_MANAGER_NPCS: readonly string[] = ['NPC_CH_GENARAL_SP']   // [confirmed npcs.json]

export type GuildRank = 'master' | 'member'
export const GUILD_RANKS: readonly GuildRank[] = ['master', 'member']
/** Retail rights columns Join / Withdraw / Notice / Name (Storage is out of scope). */
export type GuildPerm = 'invite' | 'kick' | 'notice' | 'title'
export const GUILD_PERMS: readonly GuildPerm[] = ['invite', 'kick', 'notice', 'title']
```

### 2.2 New `ActionFailReason` values

| Reason | Used by | Meaning |
|---|---|---|
| `trading` | gate, trade | You (or the other player) have an exchange open. |
| `stalling` | gate, trade, stall | You run a stall (the inventory is locked), or the other player does. |
| `stall_changed` | `stallBuy` | The listing differs from what the buyer saw (code, count, plus, durability or price). Nothing happened. |
| `stall_full` | `stallVisit` | 8 visitors already. |
| `stall_closed` | `stallBuy`, `stallVisit` | No such stall, or it is being modified ("under construction"). |
| `not_in_guild` | guild | You are not in a guild. |
| `in_guild` | guild | You, or the invitee, are in a guild already. |
| `no_permission` | guild | Your rank or rights do not allow it. |
| `guild_full` | guild | The member cap is reached. |
| `name_taken` | `guildCreate` | A live guild has that name (case-insensitive). |
| `bad_name` | `guildCreate` | The name fails `GUILD_NAME`, or it is reserved or blocked (§5.2). |

Reused reasons (all already in `ACTION_FAIL_REASONS` [confirmed `protocol.ts`]): `not_found`, `too_far`, `invalid_target`, `invalid_slot`, `invalid_count`, `not_usable` (non-tradable item; the message says so), `not_enough_gold`, `gold_limit`, `inventory_full`, `requirements` (level), `cooldown` (rejoin/recreate penalty, pending request), `no_invite`, `not_complete` (`tradeAccept` before both locks, `stallOpen` with no listing), `wrong_place` (stall outside town), `busy`, `dead`, `rate_limited`.

- `busy` for "You cannot use the stall during the battle." becomes `in_combat` if docs/SYSTEMS_COMBAT.md §7.4 (which adds `in_combat` for the horse lockout) lands in the same protocol step [decision].
- The new `ActionFailReason` `name_taken` is a separate union from the existing `ErrorCode` `'name_taken'` (charCreate) [confirmed both types in `protocol.ts`/`validate.ts`]. Nothing collides; the client just needs a `fail.name_taken` line of its own.
- None of the 11 new reasons collides with SYSTEMS_COMBAT §7.4 (`mounted`, `not_mounted`, `moving`, `in_combat`, `cos_active`, `broken`, `nothing_to_repair`, `alchemy_mismatch`, `max_plus`, `berserk_not_ready`, `berserk_active`) [confirmed].

The client parser rejects unknown reasons (`oneOf(o, 'reason', ACTION_FAIL_REASONS)` [confirmed `validate.ts:958`]), so server and client deploy together, as in every wave.

### 2.3 The inventory lock (server seam `gate`)

Trade and stall safety rest on one rule: **while a player has a trade window open or runs a stall, nothing but the social module may change that player's bag or gold through a request.** Commit-time re-validation (§3.5, §4.5) is the second line of defence, for changes that do not come from requests (party gold share, GM `item`).

The seam is `apps/server/src/modules.ts`, owned by SOC-FS:

```ts
export interface GameplayModule {
  // ...
  /**
   * Social wave: a veto asked before any module (or the core) handles a request of `p`, and before a client moveTo.
   * Return a Fail to refuse (it becomes that request's actionResult; a refused moveTo is dropped without a message),
   * null to let it through. Never asked for the module's own `handles`. Asked in registration order; the first Fail wins.
   */
  gate?(p: Player, t: GameplayRequest | 'moveTo', now: number): Fail | null
}
```

Hook points in `apps/server/src/gameplay.ts` (SOC-FS):

- `request()`: right after the dead check (`if (p.dead && !mod?.whileDead?.includes(msg.t)) return answer(fail('dead'))` [confirmed line 618 of the working tree]), add `const veto = this.gateFor(p, msg.t, mod, now); if (veto) return answer(veto)`.
  - `gateFor` loops over `this.modules` except `mod`, the module that handles `msg.t`. Core requests (`CORE_REQUESTS`, `mod` undefined) are asked of every module.
  - `respawn` is answered before routing [confirmed line 616], so the gate never blocks it.
- `onMoveTo()`: after `if (p.dead) return false` and before `p.action = null`, add `if (this.gateFor(p, 'moveTo', null, now)) return false`. connection.ts then skips `world.moveTo` [confirmed `connection.ts:222` `if (this.game.gameplay.onMoveTo(this.player)) this.game.world.moveTo(...)`]. No message is sent, as for a dead player today.

**The lock is an allowlist, not a blocklist** [decision, fact-check]. The same wave adds more requests that touch the bag, gold or position: `repair`, `alchemyReinforce`, `alchemyCancel`, `mountRide`, `mountDismount`, `mountDismiss`, `berserk` (SYSTEMS_COMBAT §7.2) and `sit`, `emote` (EFFECTS §4 P4). A blocklist would let them through by default. So each social module's `gate` lets through only the "Allowed" set below plus its own `handles` (exempt anyway), and refuses **everything else** with its reason. A request type added later is then locked until someone allows it on purpose. The rows below list the known refusals only as examples and test cases.

**Locked request sets** [decision]:

| State | Refused (reason) | Ends the state instead | Allowed |
|---|---|---|---|
| trade window open (either phase) | `itemMove`, `itemSplit`, `itemEquip`, `itemUnequip`, `itemUse`, `itemDrop`, `pickup`, `shopBuy`, `shopSell`, `shopBuyback`, `storageDeposit`, `storageWithdraw`, `storageMove`, `storageGold`, `questAccept`, `questTurnIn`, `questTalk`, `questUseItem`, `stallCreate`, `stallBuy`, `stallVisit`, `guildCreate` → `trading` | `moveTo`, `attack`, `useSkill`, `npcTalk` cancel the trade (the `moved` / `stopped` hooks, and a gate that returns null after cancelling) | chat, `stopAction`, `hotbarSet`, `statUp`, `skillLearn`, `masteryUp`, `buffCancel`, `party*`, other `guild*`, `storageOpen`, `npcClose`, `trade*` |
| stall exists (modify or open) | everything in the row above, plus `moveTo` (dropped), `attack`, `useSkill`, `npcTalk`, `tradeRequest`, `tradeRespond` → `stalling` | none | chat, `stall*` (own stall), `stopAction`, `hotbarSet`, `statUp`, `skillLearn`, `masteryUp`, `buffCancel`, `party*`, `guild*` except create |

- A stall **visitor** is not locked. Buying is one atomic request.
- `stallBuy` while trading is refused, because trading locks the bag.
- Sibling requests: while trading or stalling, `repair`, `alchemy*`, `mount*`, `berserk`, `sit` and `emote` fall outside the allowlist and are refused (`trading` / `stalling`). The stall owner's pose comes from the stall, not from `sit` (§4.3).
- Paths that change the bag **without** a request stay possible: a pickup walk or talk walk already running when the trade opened, party share loot and gold, GM `item`. The commit-time snapshot check (§3.5, §4.5) covers them. Opening a trade does not clear `p.action` [decision: the snapshot is enough].

### 2.4 Two-character transaction (`apps/server/src/social/pair-tx.ts`, lane TR-S)

```ts
/**
 * One SQLite transaction over two characters' inventories: loads both (store.loadInventory), lets `fn` change both
 * drafts, writes both (store.writeDraft) and runs `extra` (the social_log insert) only when fn succeeded. A throw
 * rolls everything back. better-sqlite3 is synchronous and the server is one process, so no other request runs in
 * between [confirmed inventory.ts header].
 */
export function pairTx<T>(store: Store, a: number, b: number,
  fn: (da: InvDraft, db: InvDraft) => Result<T>, extra?: (value: T) => void): { result: Result<T>; da: InvDraft; db: InvDraft }
```

- It uses only `store.db`, `store.loadInventory` and `store.writeDraft`, which are all exposed [confirmed `db.ts` return object; `writeDraft` is documented "no transaction of its own: call it inside one"]. The pattern is `storage-db.ts storageTx` [confirmed line 69].
- Note the difference from `store.inventoryTx(characterId, fn, extra?: () => void)` [confirmed `db.ts:415`]: there `extra` takes no argument. `pairTx` passes the value on purpose.
- `a === b` throws: a caller bug, never a player path.
- The stall lane uses the same helper for purchases.

### 2.5 Text fields

- Stall title and greeting, guild titles and the guild notice pass through `cleanChat` (control and bidi characters stripped, trimmed [confirmed `connection.ts:68`]), imported the way `gm.ts` does [confirmed `gm.ts:14`].
- Code-point limits are checked after cleaning.
- The 1024-byte client frame limit is in UTF-8 bytes [confirmed `parseClientMessage`], not code points. A `guildNotice` with 32 + 240 astral code points is about 1,150 bytes and is refused as `error bad_request`. The guild window therefore counts UTF-8 bytes (`utf8Length`, exported by `validate.ts`) and stops input at 900 bytes for the whole frame [decision].
- The client renders every one of these strings with `textContent`, never HTML.

### 2.6 Rate limits (`CLIENT_RATE_LIMITS`)

| Types | per second / burst |
|---|---|
| `tradeRequest`, `stallCreate`, `stallClose`, `guildCreate`, `guildDisband`, `guildInvite`, `guildLeave`, `guildNotice`, `guildMaster` | 1 / 3 |
| `tradeRespond`, `tradeLock`, `tradeAccept`, `tradeCancel`, `stallText`, `stallOpen`, `stallVisit`, `stallLeave`, `guildRespond`, `guildKick`, `guildPerms`, `guildTitle` | 2 / 5 |
| `tradeGold`, `stallBuy` | 5 / 10 |
| `tradeOffer`, `tradeTake`, `stallItem`, `stallItemRemove` | 10 / 20 |

Guild and stall chat pay the existing chat bucket (`conn.takeChat()` [confirmed `chat.ts`]).

### 2.7 Allowed while dead (`whileDead`, as decision 36 did for party)

`tradeCancel`, `tradeRespond` (a decline; an accept while dead answers `dead`), `stallClose`, `stallLeave`, `guildRespond`, `guildLeave`, `guildKick`, `guildPerms`, `guildTitle`, `guildNotice`, `guildMaster`.

---

## 3. Player trade (exchange)

### 3.1 Flow

1. **Request.** A sends `tradeRequest {target}` (B's entity id). Checks, in order:
   - `invalid_target` (yourself; not a player);
   - `not_found` (unknown, not in `p.known`, or `!world.canSee`);
   - `dead` (A); `invalid_target` "X is dead." (B);
   - `trading` / `stalling` (A or B busy; the message names who);
   - `cooldown` (B already has a pending request from anyone);
   - `too_far` (distance > `TRADE_RANGE`).

   On success: A gets `actionResult ok`. B gets `tradeRequested {from: A.id, name, level, expiresInMs: TRADE_REQUEST_MS}`. A pending request is stored under B's characterId, one per invitee, like party invites [confirmed pattern `party.ts invites`].
2. **Answer.** B sends `tradeRespond {from, accept}`. `no_invite` when nothing is pending or `from` is not the requester's current entity id.
   - Decline: `actionResult ok`, and A gets `tradeEnd {reason: 'declined', name: B}`.
   - Accept: every §3.1 check is re-run for both sides (distance, busy, dead). A failure answers B with it and sends A `tradeEnd {reason: 'failed', message}`. On success, both get `trade {trade: TradeState}` and a system line "You started to exchange with [X]." (retail string).
3. **Edit (phase `open`).** Each side runs `tradeOffer`, `tradeTake` and `tradeGold`. The rules are in §3.3. Every accepted change sends the new `trade` state to both.
4. **Lock.** `tradeLock` freezes your side. The partner sees "locked".
5. **Accept (phase `locked`, both sides locked).** `tradeAccept` marks your side accepted, and the partner sees "Waiting for other player's approval." (retail). When both have accepted, the server commits (§3.5).
6. **Commit.**
   - Success: each side gets `inventoryUpdate` (+ `statsDelta {gold}`, through `afterInventory`), then `tradeEnd {reason: 'done', name: partner}` and the line "Exchanging with [X] is completed.".
   - Failure: `tradeEnd {reason: 'failed', message}` to both, with the reason named ("[X]'s inventory is full.", "[X] cannot hold more gold.", "An item in the exchange changed."). Nothing moved.
7. **Cancel.** `tradeCancel` works at any time before the commit. The canceller gets `ok` and both get `tradeEnd {reason: 'cancelled', name: canceller}`.

### 3.2 State (server, runtime only)

```ts
// apps/server/src/social/trade-rules.ts (pure; unit-tested without a server)
export interface TradeOffer { bag: number; code: string; count: number; plus: number; durability: number | null }
export interface TradeSideState { characterId: number; items: (TradeOffer | null)[]; gold: number; locked: boolean; accepted: boolean }
export interface TradeSession { id: number; a: TradeSideState; b: TradeSideState; openedAt: number }
export type TradeStep = Result<'changed' | 'commit' | 'noop'>
export function offer(s: TradeSession, side: 'a' | 'b', inv: InvState, bag: number, count: number | undefined, def: ItemDef | undefined, partnerFree: number): TradeStep
export function take(s: TradeSession, side: 'a' | 'b', slot: number): TradeStep
export function setGold(s: TradeSession, side: 'a' | 'b', inv: InvState, amount: number): TradeStep
export function lock(s: TradeSession, side: 'a' | 'b'): TradeStep
export function accept(s: TradeSession, side: 'a' | 'b'): TradeStep       // 'commit' when both accepted
export function commitDrafts(s: TradeSession, da: InvDraft, db: InvDraft, defs: Defs): Result<{ aGot: InvItem[]; bGot: InvItem[] }>
```

### 3.3 Rules [decision unless tagged]

- **Offer** `tradeOffer {bag, count?}`:
  - `invalid_slot`: the bag slot is empty, out of range, or already offered. One offer per bag slot, so the same stack can never count twice.
  - `invalid_count`: `count` (default: the whole stack) must satisfy 1 ≤ count ≤ stack count.
  - `not_usable` "The selected item cannot be traded." (retail `UIIT_MSG_STRGERR_CANNOT_BE_TRADED`): `ItemDef.canTrade === false`, the new field in §8. Today that means the `*_DEF` starter kit (§1).
  - `inventory_full` "Cannot add the selected item because the exchange window is full." (retail `UIIT_MSG_STRGERR_TRADE_BAY_FULL`): all 12 slots are taken.
  - `inventory_full` "Cannot add the selected item to the exchange window because the other player's inventory is full." (retail `UIIT_MSG_STRGERR_NOT_ENOUGH_OPPONENT_INV_SPACE`): the soft check fails. The partner must have `freeSlots + partnerOfferedStacks ≥ myOfferedStacks + 1`. This is only an early warning; the commit decides, and a commit failure uses "Cannot exchange because [%s]'s inventory is full." (`UIIT_MSG_INVENTORY_FULL_TARGET`).
  - `trading` "Your offer is locked.": your side is locked.
  - Success fills the first empty trade slot with a snapshot `{bag, code, count, plus, durability}`.
- **Take** `tradeTake {slot}`: `invalid_slot` when the slot is empty; `trading` when locked.
- **Gold** `tradeGold {amount}` sets the offered gold (not a delta): `not_enough_gold` when amount > bag gold; `trading` when locked. 0 clears it.
- **Anti-bait rule:** any accepted offer, take or gold change by one side sets `locked = false` and `accepted = false` on **the other side**. A locked side cannot change its own offer, so once both are locked, neither offer can change before the commit.
- **Lock** `tradeLock`: `trading` "Already locked." when locked. `too_far` when the partner is more than `TRADE_RANGE` away.
- **Accept** `tradeAccept`:
  - `not_complete` "Both sides must confirm first." until both are locked;
  - `not_usable` "There is nothing to trade." when both sides are empty (items and gold) (retail string);
  - `too_far` when out of range.
- **Ends** (the server sends `tradeEnd` to both, and the pending request map is cleaned):

  | Event | `reason` |
  |---|---|
  | A client `moveTo` of either (module `moved` hook), `attack`, `useSkill` or `npcTalk` (gate cancels then allows) | `moved` |
  | Tick: distance > `TRADE_BREAK_RANGE` | `too_far` |
  | `playerDied` | `dead` |
  | `warped` (return scroll, respawn, GM tp/summon) | `moved` |
  | `forget` (leave world, disconnect) | `left` |
  | The other side's `tradeCancel` | `cancelled` |
  | Commit failure | `failed` |
  | Request timeout or decline (before open) | `expired` / `declined` |

### 3.4 Messages

```ts
// client -> server (all GameplayRequest; one actionResult each)
| { t: 'tradeRequest'; target: number }                 // player entity id
| { t: 'tradeRespond'; from: number; accept: boolean }  // requester's entity id from tradeRequested
| { t: 'tradeOffer'; bag: number; count?: number }      // bag index; count 1..MAX_ITEM_COUNT (default: whole stack)
| { t: 'tradeTake'; slot: number }                      // own trade slot 0..TRADE_SLOTS-1
| { t: 'tradeGold'; amount: number }                    // 0..MAX_GOLD, the new offered amount
| { t: 'tradeLock' }
| { t: 'tradeAccept' }
| { t: 'tradeCancel' }

// server -> client
| { t: 'tradeRequested'; from: number; name: string; level: number; expiresInMs: number }
| { t: 'trade'; trade: TradeState }                     // full state after every change (both sides)
| { t: 'tradeEnd'; reason: TradeEndReason; name?: string; message?: string }

export interface TradeItem { stack: ItemStack; bag?: number }   // `bag` only on your own side (to dim that bag slot)
export interface TradeSide { items: (TradeItem | null)[]; gold: number; locked: boolean; accepted: boolean } // items.length === TRADE_SLOTS
export interface TradeState { partner: number; name: string; level: number; mine: TradeSide; theirs: TradeSide }
export type TradeEndReason = 'done' | 'cancelled' | 'declined' | 'expired' | 'moved' | 'too_far' | 'dead' | 'left' | 'failed'
```

**Message order** (after each request's `actionResult`, as in docs/SHOPS.md §7.3):

- accept → `trade` to both;
- change → `trade` to both;
- final accept → own `inventoryUpdate`, `statsDelta` (both players), then `tradeEnd done` (both).

### 3.5 Commit (`TradeService.commit`, lane TR-S)

```text
pairTx(store, a.characterId, b.characterId, (da, db) => commitDrafts(s, da, db, defs), (v) => log('trade', ...))
commitDrafts:
  1. for each side: for each offer: slot = d.bag[offer.bag]
       - must exist with code, plus and durability equal to the snapshot and count >= offer.count, else fail('not_found', 'An item in the exchange changed.')
       - takeFromBag(d, offer.bag, offer.count)                       [inventory.ts, confirmed]
  2. gold: each side's bag gold must be >= its offered gold (else not_enough_gold);
     net_a = b.gold - a.gold, then addGold(da, net_a, {strict: true}) (gold_limit names the side); same for b
  3. putBack(db, def, item) for every item a gave; putBack(da, def, item) for every item b gave   [inventory.ts, confirmed]
     inventory_full names the receiving side
  4. return both lists (for the log)
```

- Items are taken from both bags before anything is put back, so slots freed by one's own offer count for incoming items.
- Stackables merge on `putBack`. Worn or non-stackable items keep their `plus` and `durability` [confirmed `putBack` semantics].
- After the commit: `g.afterInventory(pa, da)` and `g.afterInventory(pb, db)`. These make `inventoryUpdate` and `statsDelta {gold}`, and fire `inventoryChanged`, so quests recount `have` objectives [confirmed].

### 3.6 Trade abuse cases (each becomes a test, §10)

| # | Attack | Defence |
|---|---|---|
| T1 | Bait and switch: B swaps a +5 blade for a +0 blade after A locked. | A's lock clears on any change by B, and A must lock again seeing the new offer. Once both are locked, both offers are frozen. |
| T2 | Offer an item, then drop, sell, deposit, move, equip or use it. | Gate: `trading`. Commit also checks the snapshot. |
| T3 | Offer the same stack twice (two offers of one bag slot) to exceed its count. | One offer per bag slot (`invalid_slot`). |
| T4 | Two trades at once to duplicate. | One trade per player (`trading`). One pending request per invitee (`cooldown`). |
| T5 | Disconnect or crash in the middle. | Runtime session; `forget` cancels. The commit is one transaction, so it is either all or nothing. |
| T6 | Gold overflow on the receiver. | `addGold` strict with the net amount → `gold_limit`, nothing moves. |
| T7 | Offer more gold than held, then spend it (e.g. at a shop). | `tradeGold` checks. Shops are gated while trading. The commit re-checks. |
| T8 | Party gold share or GM `item` changes the bag mid-trade. | The commit uses snapshots. A changed slot fails the trade; extra gold is harmless. |
| T9 | Accept spam, or accept before both are locked. | `not_complete`, and a 2/5 budget. |
| T10 | Trade from far away or behind an invisible GM. | `known` + `canSee` + range at request, accept, lock and accept; tick break at 15 m. |
| T11 | Non-tradable items (in our export: the 25 `*_DEF` starter items; retail also quest items and trade goods, which we do not export). | `canTrade === false` → `not_usable`. Quest-bag items (`QITEM_*`) never reach the bag anyway (decision 4 [confirmed WAVE_PLAN]). The test uses `ITEM_CH_SWORD_01_A_DEF`. |
| T12 | Request spam at a friend. | 1/3 budget. A second request to the same invitee → `cooldown`. |
| T13 | Trade while dead, or dying mid-trade. | `dead`; `playerDied` → `tradeEnd dead`. |
| T14 | Commit with an empty trade. | Refused (`not_usable`). |
| T15 | A stale `from` in `tradeRespond` after a relog (new entity id). | `no_invite`. Invites end on `forget` of either side. |

---

## 4. Stalls

### 4.1 Rules [decision unless tagged]

- **Where.**
  - Inside a town safe area only: `g.data.inSafeArea(g.config.world, x, z)` [confirmed `gamedata.ts:257`; the core calls it this way for `safe_zone`, `gameplay.ts` `attackRequest`]. Else `wrong_place` "Stalls can only be opened in town.".
  - More than `STALL_NPC_CLEARANCE` (3 m) from every NPC entity, so NPCs stay clickable (`wrong_place` "Too close to [NPC name].").
  - More than `STALL_SPACING` (1.5 m) from another stall owner (`wrong_place`).
  - Retail allowed stalls elsewhere [unknown]. Town only keeps mobs from killing sitters, which this game has no need for.
- **Who.** Alive, not trading (`trading`), no stall already (`stalling`), not in combat within the last 5 s (`busy`, or `in_combat` per §2.2, with the retail line "You cannot use the stall during the battle." `UIIT_MSG_FLEAMARKET_ERR_NOT_BATTLE_FMARKET`; uses `p.lastCombatAt` [confirmed field, set by `gameplay.ts` on both attacker and target of a hit]).
- **Create** `stallCreate {title}`:
  - the server halts the owner (`world.halt` [confirmed]), clears `p.action`, and cancels an item cast (`g.itemUses.cancel(p, 'interrupted')` [confirmed pattern in npc.ts]);
  - the stall starts in state `modify` with no listings;
  - the owner gets `stall {stall}`, and viewers get `entityUpdate {id, stall: title}` (the sign appears).
  - An empty `title` after cleaning is replaced by "[Name]'s stall." (retail default). The greeting defaults to "Welcome to [Name]'s stall." (retail).
- **List** `stallItem {slot, bag, count, price}` (state `modify` only, else `stalling` "Switch to Modify first."):
  - replaces listing `slot` (0..9);
  - `invalid_slot`: empty bag slot, or the bag slot is already listed in another stall slot;
  - `invalid_count`: count > stack count;
  - `not_usable`: `canTrade === false`;
  - `invalid_count` "1 to 1,000,000,000 gold.": price outside 1..`STALL_PRICE_MAX`. The validator bounds it too.
  - A listing stores the snapshot `{bag, code, count, plus, durability, price}`.
- **Unlist** `stallItemRemove {slot}` (modify only).
- **Texts** `stallText {title?, greeting?}` (either state; visitors see the update).
- **Open / Modify** `stallOpen {open}`:
  - `open: true` needs at least one listing (`not_complete` "Cannot open a new shop whithout the registered goods." (retail));
  - `open: false` returns to modify, and visitors see "The shop is under construction." (retail).
  - Visitors stay connected across the switch.
- **Close** `stallClose`, or automatically on:

  | Event | Visitors' `stall: null` reason |
  |---|---|
  | `stallClose` | `closed` |
  | `forget` (leave world) | `left` |
  | `playerDied` | `closed` |
  | `warped` | `closed` |

  Viewers get `entityUpdate {id, stall: ''}`. Nothing is persisted: listings are references into the owner's bag and nothing moved [decision; retail likely the same].
- **Visit** `stallVisit {owner}`:
  - `not_found` (unknown, not `known`, not visible, or no stall);
  - `invalid_target` (your own stall);
  - `too_far` (> `STALL_RANGE`);
  - `stall_full` (8 visitors).
  - The visitor gets `stall {stall}`, in either state: in `modify` the buy buttons are off.
  - The owner sees the visitor count go up.
  - A visitor visits one stall at a time; a new visit leaves the old one.
- **Leave** `stallLeave`. The server also ends a visit when:

  | Event | `reason` |
  |---|---|
  | The visitor moves farther than `STALL_BREAK_RANGE` (tick) | `too_far` |
  | The visitor dies or warps | `left` |
  | The owner closes | `closed` |

  The visitor gets `stall {stall: null, reason}`.
- **Buy** `stallBuy {owner, slot, code, count, plus?, durability?, price}` buys **the whole listing** [decision; retail likely]:
  - `stall_closed` when the stall is not `open`, or `not_found`;
  - `stall_changed` when the listing's code, count, plus, durability or price differ from the request;
  - `invalid_target` for your own stall;
  - `too_far`;
  - then the transaction (§4.5).
  - Success: the buyer gets `actionResult ok`, `inventoryUpdate`, `statsDelta {gold}`.
  - The owner gets `inventoryUpdate`, `statsDelta {gold}`, `stallSold {slot, buyer, code, count, price}` and the retail line "[Buyer]bought item [Item]." in `system` chat.
  - All visitors and the owner get the new `stall` state, with the listing removed.
- **Earnings.** The gold goes straight into the owner's bag gold (strict `gold_limit` → refused as `gold_limit` "The seller cannot hold more gold."). No tax [decision].
- **Stall chat (P2).** `chat {channel: 'stall', text}` goes to the stall the sender owns or visits: the owner and every visitor, as `{channel: 'stall', fromId, from, text}`. `error bad_request` when the sender has none. Retail has a chat module in the stall window [confirmed `GDR_STALL_CHAT`].

### 4.2 Messages

```ts
// client -> server
| { t: 'stallCreate'; title: string }                  // 0..STALL_TITLE_MAX code points ('' = default title)
| { t: 'stallItem'; slot: number; bag: number; count: number; price: number }   // slot 0..9, count 1..MAX_ITEM_COUNT, price 1..STALL_PRICE_MAX
| { t: 'stallItemRemove'; slot: number }
| { t: 'stallText'; title?: string; greeting?: string } // at least one key
| { t: 'stallOpen'; open: boolean }
| { t: 'stallClose' }
| { t: 'stallVisit'; owner: number }                    // owner's entity id
| { t: 'stallLeave' }
| { t: 'stallBuy'; owner: number; slot: number; code: string; count: number; plus?: number; durability?: number; price: number }

// server -> client
| { t: 'stall'; stall: StallView | null; reason?: StallEndReason }   // full view on every change (owner and visitors)
| { t: 'stallSold'; slot: number; buyer: string; code: string; count: number; price: number }  // owner only

export interface StallListing { stack: ItemStack; price: number; bag?: number }   // `bag` only in the owner's own view
export interface StallView {
  owner: number; name: string; title: string; greeting: string
  state: 'modify' | 'open'
  items: (StallListing | null)[]      // length STALL_SLOTS
  visitors: number                    // 0..STALL_VISITORS_MAX
}
export type StallEndReason = 'closed' | 'left' | 'too_far'

// EntityState (players) addition, set by a world decorator:  stall?: string   (the title; present = a stall exists)
// entityUpdate addition:                                     stall?: string   ('' = closed)
```

`EntityState.stall` makes late joiners see the sign. The stall module pushes a decorator (`g.world.decorators.push(...)`), as `skills/engine.ts:134` does [confirmed]. No `world.ts` edit is needed.

### 4.3 Sitting

- Server: the owner is halted, and moves are refused by the gate.
- Client:
  - The idle is hard-coded to `STAND1` today [confirmed `entities.ts:448` `else this.actor.play('STAND1')`]. docs/EFFECTS.md FX-0 (§6.1) already adds the override: `EntityView.idle: 'stand' | 'combat' | 'sit'`, plus `KEEP_CLIPS += VENDOR01`. This spec does **not** add its own `setIdle` [fact-check: two seams on the same line would collide].
  - Request to FX-0 (one line in its union and one clip mapping): add `'vendor'` to `EntityView.idle`. It plays `SIT_DOWN` once (`CharacterActor.playAction`, which exists [confirmed `models.ts:751`]), then loops `VENDOR01` when the actor has it, else `SIT`. Leaving `'vendor'` plays `STAND_UP` once. If FX-0 has not landed when ST-C starts, ST-C uses `'sit'` from FX-0's union; if FX-0 is not in this wave at all, the one-line idle override moves into the merged client seam step (§10.3).
  - Which of `VENDOR01` and `SIT` retail shows is [likely VENDOR01, EFFECTS §3.12]. The user check (§10.10 no. 6) settles it by eye.
  - The stall pose is driven by `EntityState.stall`, not by EFFECTS' `posture` field. A stall owner's `sit` request is refused by the gate (§2.3).
- The wooden `booth.bms` is **not** drawn in the first build. It is the base mesh of the avatar booths (§1), but whether a plain stall shows it is unknown. §11 has it as a polish option.

### 4.4 Stall state (server, runtime only)

```ts
// apps/server/src/social/stall-rules.ts (pure)
export interface Listing { bag: number; code: string; count: number; plus: number; durability: number | null; price: number }
export interface Stall { owner: number /*entity*/; characterId: number; title: string; greeting: string; state: 'modify' | 'open';
  items: (Listing | null)[]; visitors: Set<number> /*entity ids*/; openedAt: number }
export function list(s: Stall, inv: InvState, slot: number, bag: number, count: number, price: number, def: ItemDef | undefined): Result<undefined>
export function buyDrafts(l: Listing, buyer: InvDraft, owner: InvDraft, def: ItemDef): Result<InvItem>
```

### 4.5 Purchase transaction

```text
pairTx(store, buyer.characterId, owner.characterId, (dBuyer, dOwner) => buyDrafts(listing, dBuyer, dOwner, def), (item) => log('stall', ...))
buyDrafts:   (parameter names: `do` is a reserved word in TypeScript, so never name a draft `do`)
  1. dOwner.bag[l.bag] must hold code/plus/durability === snapshot and count >= l.count, else fail('stall_changed')   (defence in depth)
  2. addGold(dBuyer, -l.price)  -> not_enough_gold ("Cannot buy due to insufficient gold", UIIT_MSG_FLEAMARKET_ERR_NOT_ENOUGH_GOLD)
  3. addGold(dOwner, +l.price, {strict: true}) -> gold_limit ("The seller cannot hold more gold.")
  4. item = takeFromBag(dOwner, l.bag, l.count); putBack(dBuyer, def, item) -> inventory_full ("Cannot buy due to insufficient space in your inventory")
```

Then the listing is set to `null`, followed by `afterInventory` for both and the messages in §4.1.

### 4.6 Stall abuse cases

| # | Attack | Defence |
|---|---|---|
| S1 | The owner raises the price while a buyer clicks. | Edits only in `modify`, where buying is refused (`stall_closed`). `stallBuy` carries the shown stack (code, count, plus, durability; D47) and price → `stall_changed`, so a Modify swap to a lower +N or a broken copy at the same price is refused too (W8-fix). The client names +N and "(broken)" in the question and sends nothing when the listing changed while the box was open. |
| S2 | The owner moves, sells, drops or deposits a listed item, so the listing points at a different item. | Gate `stalling` blocks every bag request of the owner. The commit re-checks the snapshot. |
| S3 | Two buyers, one listing. | Requests are serialised. The second gets `stall_changed` or `not_found` (listing null). |
| S4 | The same bag slot listed twice to sell it twice. | One listing per bag slot (`invalid_slot`). |
| S5 | Buying from yourself; self-dealing to launder gold. | `invalid_target`. Two characters of one account are never online together [confirmed `connection.ts` replaces the previous socket]. |
| S6 | Gold overflow on the owner, or not enough gold on the buyer. | Strict `gold_limit`; `not_enough_gold`. Nothing moves. |
| S7 | Stall spam blocking NPCs or the spawn. | NPC clearance 3 m and spacing 1.5 m. Town only. One stall per player. |
| S8 | Offensive or oversize titles. | `cleanChat` and length limits. The GM `kick` exists, and a GM `stalls close <name>` command is P2 (§10). It is named `stalls`, not `stall`: the client's `/stall` chat prefix claims `/stall …` lines before the GM path, so a GM command named `stall` could never be typed. |
| S9 | 9th visitor; visit spam. | `stall_full`; 2/5 budget. |
| S10 | Listing non-tradable items. | `not_usable`. |
| S11 | The owner disconnects mid-purchase. | The purchase is one message-handler run. `forget` closes the stall between requests only. |
| S12 | The owner walks away to escape a buyer's pending request. | The owner cannot move (gate). A buyer farther than 10 m gets `too_far`. |
| S13 | A visitor buys during a trade. | The gate refuses `stallBuy` while trading. |

---

## 5. Guilds

### 5.1 Model

- A guild has a unique name (case-insensitive among live guilds), one **master** (`rank 'master'`), members (`rank 'member'`), each member's `perms: GuildPerm[]`, and a `title` (0..12 code points; retail "Grant name").
- It also has a notice (`title` ≤ 32 and `text` ≤ 240 code points; retail "Guild notice").
- The master implicitly has every permission. Only the master can grant permissions, hand over the mastership, or disband.
- "Vice Master" in the retail UI is a rank label [confirmed string]. Here a member with all four permissions shows as **Vice Master** in the member list [decision]; there is no separate rank.
- Member cap: config `GUILD_MAX_MEMBERS`, default **50** [decision; retail level-1 guild ≈ 15 [likely], which is irrelevant with no guild levels].

### 5.2 Rules [decision unless tagged]

- **Create** `guildCreate {npc, name}`:
  - the NPC must be a live NPC whose identity is in `GUILD_MANAGER_NPCS` within `NPC_INTERACT_RANGE` (8 m) (`not_found` / `too_far`), through `g.npcs.requireService(p, npc, 'guild', now)` [confirmed helper];
  - `in_guild`: already in one;
  - `requirements` "Requires level N.": level < config `GUILD_CREATE_LEVEL` (default **10**; retail 20 [likely]);
  - `bad_name`: fails `GUILD_NAME`, or matches the reserved list (`isReservedName` in `connection.ts` [confirmed exported], e.g. GM, Admin);
  - `name_taken`;
  - `cooldown`: disbanded within `GUILD_RECREATE_DAYS` (config, default **0**; retail 15 [confirmed]);
  - `not_enough_gold`: gold < config `GUILD_CREATE_GOLD` (default **10,000** [decision: at GOLD_RATE 3 a level-10 character has tens of thousands; retail "0.5 million" [confirmed string]]).
  - One transaction: `store.inventoryTx(p.characterId, d => addGold(d, -cost), () => insert guild + master row)`. The `extra` callback runs in the same transaction, after the write [confirmed `db.ts:415`], so the gold and the guild are all or nothing. A UNIQUE violation inside `extra` throws out of `inventoryTx` itself (it does not catch) and rolls back. The guild module wraps the call in `try/catch` and maps `SQLITE_CONSTRAINT_UNIQUE` to `name_taken`, the way `createCharacter` does [confirmed `db.ts` `createCharacter`]. Any other error is rethrown.
  - Then: `guild` state to the creator, `entityUpdate {id, guild: name}` to viewers, and `guildEvent created`.
- **Invite** `guildInvite {name}` (a character name; members are often far apart, and retail has `/guild <name>` [confirmed command strings]):
  - `not_in_guild`;
  - `no_permission` (not master, and no `invite`);
  - `not_found`: not online (`world.byName`), or an invisible GM seen by non-staff, the whisper rule [confirmed `chat.ts`];
  - `in_guild`: the invitee is in a guild;
  - `guild_full`;
  - `cooldown`: the invitee has a pending invite, or left a guild less than `GUILD_REJOIN_HOURS` ago (config, default **0**; retail 72 h [confirmed]);
  - `dead` for a dead invitee is not checked, since invites are bookkeeping.
  - The invitee gets `guildInvited {guild, name: guildName, from, expiresInMs: GUILD_INVITE_MS}` ("Do you want to join [%s]guild?", retail).
- **Respond** `guildRespond {guild, accept}`:
  - `no_invite` when nothing is pending, or the id differs;
  - accept re-checks the cap, `in_guild` and the penalty, then inserts the member row;
  - `guildEvent joined {name}` goes to all online members, the full `guild` to the joiner, `guildMember` to the others, and `entityUpdate guild` to viewers;
  - decline → the inviter gets `guildEvent declined`.
- **Leave** `guildLeave`:
  - the master cannot leave while other members exist (`no_permission` "Pass on the mastership or disband the guild first.");
  - a master who is alone leaves = disband;
  - otherwise the member row is deleted, `guild_left_at` is set, and the rest get `guildEvent left` and `guildMemberRemoved`.
- **Kick** `guildKick {member}` (characterId):
  - `no_permission` (not master, and no `kick`);
  - `invalid_target`: the master can never be kicked (retail "You are the leader of the guild and you cannot be banned"), and neither can yourself;
  - a member with `kick` cannot kick another member who also has `kick` (`no_permission`);
  - `not_found`.
  - Kicked members get no rejoin penalty [decision].
  - Works on offline members too.
- **Permissions** `guildPerms {member, perms}`: master only. Replaces the member's list. It cannot target the master.
- **Title** `guildTitle {member, title}`: master, or `title` permission. `''` clears it. The text is cleaned and must be ≤ 12 code points after cleaning (`bad_name` otherwise).
- **Notice** `guildNotice {title, text}`: master, or `notice` permission. It is stored with `notice_at`, and members get `guildEvent notice` plus the state. Retail shows it at login: "Guild post "%s"" [confirmed `UIIT_MSG_GUILD_CONNECT_NOTICE`].
- **Mastership** `guildMaster {member}`: master only. The target must be a member (it may be offline [decision]). Ranks swap. The old master keeps all four permissions. Everyone gets `guildEvent master {name}`.
- **Disband** `guildDisband {npc}`: master only, at the Guild Manager (retail menu "Disband the guild" [confirmed `UIIT_CTL_GUILD_BREAK`]).
  - One transaction: `guilds.disbanded_at = now`, delete all member rows, set `characters.guild_disbanded_at` on the master.
  - Online members get `guildEvent disbanded` and `guild: null`; viewers get `entityUpdate {id, guild: ''}` for each online member.
  - The name becomes free again (the partial unique index, §7).
- **Deleted characters.** At server start, and whenever a guild is loaded, members whose character has `deleted_at IS NOT NULL` are removed.
  - A deleted master passes the mastership to the member who joined earliest; a guild left empty is disbanded.
  - This keeps `connection.ts charDelete` untouched [decision].

### 5.3 Guild chat

- `chat {channel: 'guild', text}` (client prefix `@`) goes to every online member as `{t: 'chat', channel: 'guild', fromId, from, text}`.
- `error bad_request "You are not in a guild."` when the sender is in none, the party-chat pattern [confirmed `chat.ts`].
- `ChatSendChannel` gains `'guild'` (and `'stall'`, P2). `ChatChannel` gains `'guild'` and `'stall'`.
- `to` together with `channel: 'guild' | 'stall'` is `bad_request`, like party. **The validator does not do this today**: `validate.ts:317` rejects only `m.to !== undefined && m.channel === 'party'` [confirmed]. The protocol step changes it to `m.channel !== undefined && m.channel !== 'local'`.
- Server routing: `chat.ts routeChat` handles only `channel === 'party'` and `to` today [confirmed]. It gains two branches of the party branch's shape (§10.2).

### 5.4 Messages

```ts
// client -> server
| { t: 'guildCreate'; npc: number; name: string }      // name matches GUILD_NAME
| { t: 'guildDisband'; npc: number }
| { t: 'guildInvite'; name: string }                   // CHARACTER_NAME
| { t: 'guildRespond'; guild: number; accept: boolean }
| { t: 'guildLeave' }
| { t: 'guildKick'; member: number }                   // characterId 1..MAX_SAFE_INTEGER
| { t: 'guildPerms'; member: number; perms: GuildPerm[] }   // unique, subset of GUILD_PERMS (0..4 entries)
| { t: 'guildTitle'; member: number; title: string }   // 0..GUILD_TITLE_MAX code points
| { t: 'guildNotice'; title: string; text: string }    // 0..32 / 0..240 code points
| { t: 'guildMaster'; member: number }

// server -> client
| { t: 'guildInvited'; guild: number; name: string; from: string; expiresInMs: number }
| { t: 'guild'; guild: GuildState | null }             // full state: enter-world (when in one) and structural changes
| { t: 'guildMember'; member: GuildMember }            // one member added or changed (online/offline, level, perms, title, rank)
| { t: 'guildMemberRemoved'; characterId: number }
| { t: 'guildEvent'; event: GuildEventKind; name: string }

export interface GuildMember {
  characterId: number; name: string; model: string; level: number
  rank: GuildRank; perms: GuildPerm[]; title: string
  online: boolean
  lastSeen: number        // characters.last_played (ms); 0 = never [confirmed column]
  joinedAt: number
}
export interface GuildState {
  id: number; name: string; master: number /*characterId*/; createdAt: number
  notice: { title: string; text: string; at: number }
  maxMembers: number
  members: GuildMember[]  // 1..GUILD_MEMBERS_MAX
}
export type GuildEventKind = 'created' | 'joined' | 'left' | 'kicked' | 'master' | 'disbanded' | 'declined' | 'expired'
  | 'online' | 'offline' | 'notice' | 'perms' | 'title'

// EntityState (players) addition, via a world decorator:  guild?: string   (the guild name; absent = none)
// entityUpdate addition:                                 guild?: string   ('' = none)
```

- **Enter-world sequence:** `worldEnter` → `stats` → `inventory` → `skills` → `quests` → `party` (if in one) → `guild` (if in one) [decision: modules' `enter` runs in registration order [confirmed `gameplay.ts sendEnter`]; the guild module registers after party]. If SYSTEMS_COMBAT's modules register in the same step, the guild still comes after party; their `enter`s (Mounts) may come before or after, since they send different messages.
- The member's own `entityUpdate guild` is not needed, because the decorator already put `guild` in `worldEnter.self` and in the spawns. `worldEnter.self` is built by `world.state(this.player)` **before** `sendEnter` runs the modules' `enter` [confirmed `connection.ts` `enterWorld`], so the decorator cannot rely on `enter`. It looks the guild up in the guild store itself, cached per characterId. The first `state()` call for the new player then already carries it.
- **Level changes.** The guild module's `tick` compares each online member's level with the last one sent, at most every 2 s, and sends `guildMember` to the guild. No new hook is needed.
- **Online/offline.** `enter` sends `guildMember {online: true}` plus `guildEvent online`. `forget` sends `online: false` with `lastSeen = now`.

### 5.5 Guild persistence

See §7. Statements live in `apps/server/src/social/guild-store.ts` (`openGuildStore(store)`, the `openStorageStore` pattern [confirmed]).

### 5.6 Guild abuse cases

| # | Attack | Defence |
|---|---|---|
| G1 | Squatting a name that differs only in case. | `UNIQUE INDEX guilds_name_live ON guilds(name COLLATE NOCASE) WHERE disbanded_at IS NULL`. |
| G2 | Offensive names. | `GUILD_NAME` (letters/digits only), `isReservedName`, a GM `guilds rename <old> <new>` and `guilds disband <name>` (§10). The GM command is `guilds`, because the client claims `/guild …` for invites (§9.4). |
| G3 | Invite spam or harassment. | 1/3 budget. One pending invite per invitee. Invitees can ignore; invites expire in 30 s. |
| G4 | A member with kick rights kicks the master, or other officers. | Refused (`invalid_target` / `no_permission`). |
| G5 | Leave and rejoin to reset something. | Nothing depends on join time except display. The rejoin penalty is config. |
| G6 | Create-gold race (two creates, one gold). | One transaction per create. Requests are serialised; the second sees `in_guild`. |
| G7 | Guild chat eavesdropping, i.e. lines reaching non-members. | Recipients come from the member table only. Tests assert that non-members get nothing. |
| G8 | A stale client acts on a guild after being kicked. | Every request re-reads membership from the module's map, which is loaded from the database. |
| G9 | Disband with online members, nameplates stale. | Disband sends `entityUpdate guild ''` for every online member. |
| G10 | Mastership to a deleted or non-member character. | `not_found`. Deleted characters are pruned. |
| G11 | Oversized notice frames. | The validator enforces code-point bounds. The frame limit is 1024 bytes [confirmed PROTOCOL §1]. |

### 5.7 Nameplate

- The guild name is drawn **above** the character name, in a smaller line and a distinct colour (`#8fd18f`) [decision; retail position unknown]. It uses `EntityView.setBadge('guild', name, 'guild-line')` [confirmed API], and the lane's CSS makes `.badge-guild` a block line.
- The option "Display Guild Name" (`UIIT_STT_GUILDVIEW_SIGN`) is a checkbox in the guild window's footer. `hud/options.ts` has **no** registration API: `optionRows(host)` builds a fixed table [confirmed `options.ts:87`], and UI-W will own that file. A later Options → Interface row is a request to UI-W. The value is stored in `localStorage['sro.showGuild']`, default on, with every read and write in `try/catch`.
- The stall sign (`setBadge('stall', title, 'stall-sign')`) sits above the guild line. It is a framed plate styled after `stl_slot_01.png` / `sell_masgbox_iteminfo.png`.
- The UI rework spec may restyle both lines. They keep their badge keys.

---

## 6. Protocol summary (additive, protocol v1)

- **`GameplayRequest` additions (27):**
  - `tradeRequest`, `tradeRespond`, `tradeOffer`, `tradeTake`, `tradeGold`, `tradeLock`, `tradeAccept`, `tradeCancel`;
  - `stallCreate`, `stallItem`, `stallItemRemove`, `stallText`, `stallOpen`, `stallClose`, `stallVisit`, `stallLeave`, `stallBuy`;
  - `guildCreate`, `guildDisband`, `guildInvite`, `guildRespond`, `guildLeave`, `guildKick`, `guildPerms`, `guildTitle`, `guildNotice`, `guildMaster`.

  They also go in `GAMEPLAY_REQUESTS` and `CLIENT_RATE_LIMITS` (§2.6).
- **`CLIENT_KEYS` / `CLIENT_OPTIONAL_KEYS`** in `validate.ts` [confirmed names, lines 96 and 150]: exact key sets as in §3.4, §4.2 and §5.4.
  - Ints: `target`, `from` and `owner` 0..MAX_ID; `bag` a bag index; `slot` 0..TRADE_SLOTS−1 or 0..STALL_SLOTS−1; `count` 1..MAX_ITEM_COUNT; `amount` 0..MAX_GOLD; `price` 1..STALL_PRICE_MAX; `member` 1..MAX_SAFE_INTEGER; `guild` 1..MAX_SAFE_INTEGER.
  - Strings are bounded in code points (`[...s].length`).
  - `stallText` needs at least one key.
  - `guildPerms.perms` has unique entries from `GUILD_PERMS`.
  - `stallBuy.code` matches the CodeName128 rule.
- **Server → client parsers:**
  - `TradeSide.items` and `StallView.items` must have exactly `TRADE_SLOTS` / `STALL_SLOTS` entries;
  - `trade` without `trade`, and `stall` or `guild` without their key, are rejected; `null` is kept (the party pattern [confirmed PROTOCOL §11]);
  - `EntityState.stall` and `EntityState.guild` are strings of 0..32 and 0..12 code points; `entityUpdate.stall` / `guild` keep `''`.
- **New chat values:** `ChatSendChannel` += `'guild' | 'stall'`, `ChatChannel` += `'guild' | 'stall'`.
- **No name collisions** with the sibling specs [confirmed by reading them]: SYSTEMS_COMBAT adds `mount*`, `repair`, `alchemy*`, `berserk` and `alchemyStart`/`alchemyResult`, the `EntityState`/`entityUpdate` fields `mount`, `rider`, `berserkMs` and `WorldInfo.alchemyRate`/`alchemyMaxPlus`. EFFECTS adds `sit`, `emote`, `itemEffect`, `posture`, `droppedAt` and `dropFrom`. This spec's `trade*`/`stall*`/`guild*` types, `stall`/`guild` fields and `WorldInfo.social` touch none of them. `worldInfo()` in `validate.ts:863` gains one `if (o.social !== undefined)` line next to theirs.
- **NPC services:** `NpcService` += `'guild'` (and `NPC_SERVICES`). `'repair'` is already in the union [confirmed `protocol.ts:915`]; SYSTEMS_COMBAT turns it on and adds no `'stable'` service (horses are sold in the stable shop) [confirmed SYSTEMS_COMBAT §1, §6.4].
  - Server `npc.ts`: `has()` is a `switch` over every `NpcService` with no `default` [confirmed], so adding `'guild'` to the union breaks the server typecheck until `has()` gets `case 'guild': return GUILD_MANAGER_NPCS.includes(npc.code)` (`npc.code` is the NPC identity [confirmed `world.ts` `Npc.code`]). The server `servicesOf` list `['shop', 'storage', 'quest']` [confirmed `npc.ts:135`] becomes `[..., 'guild']` (and `'repair'` from SYSTEMS_COMBAT).
  - Client: `OPTION_KEY: Record<NpcService, StringKey>` in `hud/npc-dialog.ts` [confirmed line 56] needs a `guild` key or the client typecheck breaks. `dialogOptions()` in `hud/shop-logic.ts:114` filters by a fixed order `['shop', 'storage', 'quest']` [confirmed], so without adding `'guild'` there the option is silently dropped. Both edits belong to the same step as the protocol change.
- **docs/PROTOCOL.md** gets a section "Social: trade, stalls, guilds" before "12. Content files" [confirmed PROTOCOL.md sections 1–13]. It carries §2.2's reasons, the message tables above, the budgets, the enter-world line and the message order. The sibling specs add sections too, so the section numbers are set once, when the merged protocol step edits PROTOCOL.md.

---

## 7. Persistence (one migration)

The migration is appended by the server seam step (§10.2). Its number is the next free index at landing time: **v8** if this spec lands alone, since the schema is v7 [confirmed `MIGRATIONS.length === 7`; `SCHEMA_VERSION = MIGRATIONS.length`]. SYSTEMS_COMBAT §6.2 appends one too; the integrator orders them. It is never renumbered after it ships.

- `apps/server/test/modules-w4.test.ts:158` asserts `expect(SCHEMA_VERSION).toBe(7)` [confirmed]. The step that appends the migration updates that line (to the new total) in the same commit.

```sql
-- vN: social systems (docs/SYSTEMS_SOCIAL.md §7): guilds, guild members, penalties, trade/stall log
CREATE TABLE guilds (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE,
  master_id INTEGER NOT NULL REFERENCES characters(id),
  notice_title TEXT NOT NULL DEFAULT '',
  notice_text TEXT NOT NULL DEFAULT '',
  notice_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  disbanded_at INTEGER
);
-- Unique among live guilds, case-insensitive; a disbanded guild frees its name (the characters_name_live pattern).
CREATE UNIQUE INDEX guilds_name_live ON guilds(name COLLATE NOCASE) WHERE disbanded_at IS NULL;
CREATE TABLE guild_members (
  character_id INTEGER PRIMARY KEY REFERENCES characters(id),   -- one guild per character
  guild_id INTEGER NOT NULL REFERENCES guilds(id),
  rank TEXT NOT NULL CHECK (rank IN ('master', 'member')),
  perms INTEGER NOT NULL DEFAULT 0 CHECK (perms BETWEEN 0 AND 15),  -- bit i = GUILD_PERMS[i]
  title TEXT NOT NULL DEFAULT '',
  joined_at INTEGER NOT NULL
);
CREATE INDEX guild_members_guild ON guild_members(guild_id);
-- Penalty clocks (config GUILD_REJOIN_HOURS / GUILD_RECREATE_DAYS; NULL = never)
ALTER TABLE characters ADD COLUMN guild_left_at INTEGER;
ALTER TABLE characters ADD COLUMN guild_disbanded_at INTEGER;
-- Every completed exchange and stall sale (GM audits; never read by gameplay)
CREATE TABLE social_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('trade', 'stall')),
  a_char INTEGER NOT NULL,           -- trade: requester; stall: buyer
  b_char INTEGER NOT NULL,           -- trade: accepter;  stall: owner
  a_gold INTEGER NOT NULL DEFAULT 0, -- gold a gave
  b_gold INTEGER NOT NULL DEFAULT 0, -- gold b gave
  a_items TEXT NOT NULL DEFAULT '[]', -- JSON ItemStack[] a gave
  b_items TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX social_log_at ON social_log(at);
CREATE INDEX social_log_a ON social_log(a_char);
CREATE INDEX social_log_b ON social_log(b_char);
```

- **Persistence of each system:**
  - Trades and stalls are runtime state. They never survive a relog or a restart, and nothing about them needs a table except the log.
  - Guilds are fully persistent.
- **Save cycle.** Gold changes go through `inventoryTx` / `pairTx`, which write `characters.gold` in the same transaction [confirmed `writeDraft`]. The periodic character save touches only position and vitals [confirmed `saveCharacter`], so it cannot overwrite gold.
- The migration SQL is written **inline in `db.ts`'s `MIGRATIONS` array**, and the statements live in `apps/server/src/social/guild-store.ts`. That is what the code actually does for quests: migration 7 is inline with the comment "Statements live in quests/store.ts" [confirmed `db.ts:148`]. QUESTS.md §1.4 planned a `QUEST_MIGRATION` export, but it was never built [confirmed: no `QUEST_MIGRATION` in `apps/`]. Inline SQL also avoids a `db.ts` → `social/guild-store.ts` → `db.ts` import cycle.

---

## 8. Content and converter

- **`ItemDef.canTrade?: boolean`** (`packages/shared/src/content.ts`, next to `canSell`/`canDrop` at line 316, whose comment already says "client: CanTrade/CanSell/CanDrop flags; absent = allowed" [confirmed]): client itemdata column 16, `CanTrade`; absent = allowed [confirmed column values, §1].
  - Exporter: **`packages/convert/src/data/items.ts`**, `buildItemDef`, lines 182–184, where `canSell` (col 17) and `canDrop` (col 20) are read [confirmed]. The first draft named `tools/export-data.ts`; that tool only calls the builders. The new line is `if (r.cells[16]?.trim() === '0') def.canTrade = false`.
  - `items.ts` is owned by SYSTEMS_COMBAT's lane **EXP** in the same wave [confirmed SYSTEMS_COMBAT §8]. So the one line is a request to EXP (or to the merged foundation step); SOC-X owns only its test (§10.4).
  - Regenerate with `pnpm tsx packages/convert/src/tools/export-data.ts` (not `pnpm sro`, whose commands are `info|ls|cat|extract|census`).
  - Server rule: `def?.canTrade === false` refuses offers and listings. A missing def refuses too (`not_usable`), since an unknown item is never tradable [decision].
- **UI art.** The in-game HUD art is exported by `packages/convert/src/tools/export-icons.ts HUD_SELECTION` into `work/out/ui/hud.json`, and the outer-screen art by `export-ui.ts SELECTION` into `index.json`. The client's `Art` merges both [confirmed `ui/art.ts`]. Neither covers `interface/exchange`, `interface/stall` or `interface/guild` today [confirmed].
  - docs/UI.md §5.4 (lane **UI-X**, owner of `export-ui.ts`) already adds `interface/stall` (`/\.ddj$/`), `interface/exchange` (`/^(exc_|ch_line)/`) and `interface/guild` (`/^gil_/`). That covers everything §9 uses except `exchange/ch_red.ddj` (the lock glow; optional). **This spec adds no exporter lines of its own**; SOC-X only sends UI-X the `ch_red` request.
  - Action icons: no exporter covers `icon/action/` [confirmed: `export-icons.ts` exports item, quest-item and skill icons only; UI-X's `icon` line takes four `icon_item_*`/`icon_disable` files]. The menu art the stall and guild entries need is UI.md's underbar MENU icons `ub_new_icon_stall` / `ub_new_icon_guild` (UI-X exports `interface/underbar` `ub_new_*`). `icon_cha_exchange/shop/sit` are therefore not needed; the target-window Exchange button is a text button.

---

## 9. Client design

### 9.1 Client seams (SOC-FC, one pass)

| Seam | File | Change |
|---|---|---|
| Feature list | `apps/game/src/world/features.ts` | Append `tradeFeature`, `stallFeature`, `guildFeature` to `WORLD_FEATURES` [confirmed list, 8 entries today]. SYSTEMS_COMBAT F6-FS appends four more there; one step writes all of them. |
| Additive target actions | `apps/game/src/hud/index.ts`, `hud/target.ts` | `Hud.addTargetAction(a: TargetAction): () => void` keeps a registry and calls `target.setActions(all)`; `Hud.refreshTargetActions()` re-runs the `show` checks. `world/features/party.ts:416` (`hud.setTargetActions?.(actions)`) and `:476` (`hud.setTargetActions?.([])`) switch to `addTargetAction` once plus `refreshTargetActions()` in `syncActions` [confirmed lines]. Otherwise the Exchange/Guild invite buttons would wipe Invite [confirmed `setActions` replaces]. `TargetAction` already has `show(target)` and `run(target)` [confirmed `target.ts:31`]. UI-H later owns `target.ts` and keeps `setActions` (UI.md §6). |
| NPC service handlers | `apps/game/src/hud/npc-dialog.ts`, `hud/shop-logic.ts` | `OPTION_KEY` gains `guild: 'npc.option.guild'` (a `Record<NpcService, …>`: the typecheck needs it). `choose()` falls back to `registerNpcService(service, fn)` (a Map; returns an unregister). The `quest` path (`setNpcQuestHandler`) stays. `dialogOptions()`'s order list gains `'guild'` (and `'repair'` if SYSTEMS_COMBAT wants it in the dialog). Only the guild uses the registry in this wave (§0 item 5). UI-W later owns `npc-dialog.ts`. |
| Bag slot lock marks | `apps/game/src/hud/index.ts`, `hud/inventory.ts` | `Hud.markBagSlots(key: string, slots: ReadonlySet<number>): void` (empty set clears). The inventory window ORs every key's slots into its own `blocked` flag on each render. It is needed because `SlotView.set(stack, blocked)` [confirmed `slots.ts:115`] is driven by the inventory window's own refresh, which would wipe a trade lane's direct `hud.bagSlot(i).set(…, true)` on the next `inventoryUpdate`. UI-W later owns `inventory.ts` and keeps the call. |
| Stall idle pose | none here | Uses EFFECTS FX-0's `EntityView.idle` plus the `'vendor'` value requested in §4.3. SOC-FC does **not** edit `entities.ts` or `models.ts` (FX-0 owns their seam lines; SYSTEMS_COMBAT's MR-C also edits `entities.ts`). |
| Ground-click veto | `apps/game/src/screens/world.ts` (the pointer handler before `send(intents.moveTo(p.x, p.z))` [confirmed line 966]), `world/move-feedback.ts` hold-to-move (`this.deps.send(intents.moveTo(p.x, p.z))`, line 115 [confirmed]) | `WorldFeature.beforeGroundMove?(): boolean` (true = consumed). These are the only two client senders of `moveTo` [confirmed by grep]. The stall feature consumes it while stalling and toasts "Close your stall first." (§2.3), so move-feedback never reports a false "blocked path". |
| Approach helper | new `apps/game/src/world/approach.ts` | `approachThen(ctx, entityId, range, run): () => void`. It sends one `moveTo` to a point `range − 2` m short of the target, then runs `run()` on arrival (checked per frame), and gives up after 10 s, on another ground/entity click, or on target despawn. Trade and stall features use it on `too_far`, so the server needs no walk action [decision]. |
| Chat channels | `apps/game/src/world/chat.ts` | `ChatKind` += `'guild' \| 'stall'`, `ChatCategory` += `'guild'`, `ChatTab`/`CHAT_TABS` += `'guild'` (stall lines show in All) [confirmed the three types at lines 27–31]. `chatLineFor` gains the two cases, like `party` at line 137. Colours: guild `#ffba4d` (docs/UI.md §4.4 `--c-chat-guild`, the retail guild lamp), stall `#c6b6ff` [decision]. UI-H later owns `chat.ts` and keeps kinds and prefixes (UI.md §6). |
| i18n | new `apps/game/src/i18n/en-trade.ts`, `en-stall.ts`, `en-guild.ts` + three import/spread lines in `i18n/en.ts` | Keys in §9.5. One file per lane, like `en-party.ts` [confirmed pattern], so the lanes never share a file. |
| Mock server | new `apps/game/src/net/mock/trade.ts`, `stall.ts`, `guild.ts` + three lines in `net/mock/index.ts` `DEFAULT_MOCK_EXTENSIONS` [confirmed list] | Offline answers for UI work (the `mock/party.ts` pattern [confirmed]). |

### 9.2 Exchange window (lane TR-C)

Files: `hud/trade.ts` (DOM), `hud/trade-state.ts` (DOM-free model), `hud/trade-request.ts` (popup), `world/features/trade.ts`.

- **Framework.** Built on UI.md's kit (`ui/kit/Window`, `button`, `MessageBox.count/prompt/confirm`, `Slot`; UI.md §5.3) when lane UI-K has landed. UI.md §7 asks the new-system windows to use the kit from the start. If UI-K has not landed, it is built on `HudWindow` + `frame()` + `art.button` like `party-invite.ts` [confirmed pattern]; UI-K later turns `HudWindow` into a kit subclass, so nothing breaks.
- **Layout** (retail `ifexchange.txt` rects; retail window **365×500** with the two defines on [confirmed §1]; the first draft's "≈ 250 × 360" was the no-define branch). The 254-wide left part holds the slots and gold. The right column (x 247–347) holds the two 100×104 character views, which we leave empty or fill with a name plate in the first build [decision]. The two subframes are 346 wide with the defines on. The text box (10,339,345,95) shows the retail status lines ("Waiting for other player's approval.", "The other player changed the offer.") instead of the chat log. **Confirm is at (96,450) and Cancel at (193,450)**, below the text box. The y 328 in `retail-layouts.txt` is the no-define value (see the caveat under the reference files) [confirmed raw `ifexchange.txt`]:
  - Partner block on top: name and level; 12 slots in 2 rows × 6 at (21 + 36·i, 72 / 108); gold box `exc_box` at (71, 152); a lock badge "Locked" or "Accepted" over the block when the partner locked (the retail `ch_red` 128×128 glow sits over the partner's character view; our first build uses a simple red border [decision]).
  - Own block below, the same at y 215 / 251, gold box at (71, 296) with the money button (`com_moneybutton`) opening a number prompt.
  - Buttons at y 450: **Confirm** at x 96 (label cycles: "Confirm" → "Waiting…" while you are locked and the partner is not → "Exchange" when both are locked → "Waiting for other player's approval." after your accept) and **Cancel**.
- **Putting items in:**
  - drag a bag slot onto the window: `addSlotDropTarget` [confirmed `slots.ts:82`];
  - right-click a bag slot while the window is open: `hud.routeBagAction` [confirmed];
  - shift+click on a stack asks for a count.
  - Offered bag slots are dimmed through `hud.markBagSlots('trade', slots)` (§9.1), fed from `mine.items[].bag`. Calling `SlotView.set(stack, true)` directly would be undone by the inventory window's next refresh [confirmed `inventory.ts:139`].
- **Taking back:** right-click your own trade slot.
- **Tooltips:** the item tooltip (`items.tooltip`) on hover of either side, so +N and durability are visible before accepting (T1).
- **Change flash:** when the partner's offer changes after you locked, your lock resets. The window flashes the partner block and adds a system line "The other player changed the offer." [decision].
- **Starting a trade:**
  - the target window's **Exchange** action on player targets (`hud.addTargetAction`, shown when the target is another live player);
  - the chat commands `/exchange` and `/trade` [confirmed retail command strings] act on the current player target. They are client prefixes (`chat.registerPrefix`), which run before the default path that would send `/…` lines to the server as GM commands [confirmed `chat.ts submit`, `connection.ts` slash branch];
  - on `too_far` → `approachThen(ctx, id, TRADE_RANGE, resend)`.
- **Request popup:** "[Name] (Lv N) applied for an exchange. Will you accept it?" with Accept and Decline and a countdown, the `party-invite.ts` pattern.
- `hud.claimRequests([...trade types])` so failures toast [confirmed API].

### 9.3 Stall windows (lane ST-C)

Files: `hud/stall.ts` (owner and visitor views of one window class), `hud/stall-state.ts`, `world/features/stall.ts`.

- **Opening a stall:** the entry "Stall" (retail `UIIT_CTL_OPEN_STORE`) in the menu bar (`hud.menubar.register` [confirmed `menubar.ts:85`]; UI.md turns the bar into the underbar MENU popup with the `ub_new_icon_stall` icon and keeps the `MenuBar` API) and the chat command `/stall` [confirmed string] → a prompt "Enter the name of the stall." (retail `UIIT_STT_INSERT_STALL_NAME`), pre-filled with the default title → `stallCreate`.
- **Owner window** (retail `ifstall.txt`; window 467×490 [confirmed `ginterface.txt`]):
  - title row with the change-title button (`stl_titlebutton`) and the state button **Open / Modify** (`GDR_BTN_TRADINGSTATE`, labels `UIIT_STT_START_STALL` / `UIIT_STT_END_STALL`), plus the "Operating" label (`stl_slot_04`) and state icon (`stl_condition_icon_01/02`);
  - 10 slot rows in 2 columns (`stl_slot_02` background 208×44): icon, name, amount, price, edit button (`stl_edit_button`);
  - greeting row (`stl_slot_03`, 400×28) with its edit button (`stl_wordbutton`);
  - visitor count;
  - the chat area (P2);
  - **Close stall** button.
- **Listing (modify mode):** drag a bag stack onto a slot row, or right-click it (`routeBagAction`), then a price prompt (and a count prompt for stacks) → `stallItem`. The price field shows thousands separators and refuses 0.
- **Visitor window:** the same layout, read-only. Each listing has a **Buy** button that sends `stallBuy` with the shown code, count and price (the S1 guard), after a confirm "Buy [item] ×N for P gold?".
  - In modify state: "The shop is under construction." and the buttons are disabled.
- **Visiting:** clicking a player whose view has `stall` set targets them and sends `stallVisit` through the `clickEntity` hook [confirmed `WorldFeature.clickEntity`] (with `approachThen` on `too_far`). Right-click on such a player does nothing special.
- **Sign and pose:**
  - `onEntityAdded` and `onMessage(entityUpdate)` read `stall`;
  - `v.setBadge('stall', title, 'stall-sign')` [confirmed `setBadge(key, text, cls)` at `entities.ts:167`] and `v.idle = 'vendor'` (FX-0 seam, §4.3);
  - clearing: `setBadge('stall', null)`, `v.idle = 'stand'`.
- **Owner's own ground clicks:** `beforeGroundMove` → consumed, toast "Close your stall first."
- **Sale notice:** `stallSold` → system line (retail wording) + the existing gold cue: `gameAudio()?.ui('item.dropGold')` (the sound feature already plays `item.dropGold` for gold drops and `item.pickup` via `audio.ui` [confirmed `world/features/sound.ts:133,137`]).

### 9.4 Guild window (lane GU-C)

Files: `hud/guild.ts`, `hud/guild-state.ts`, `hud/guild-invite.ts`, `world/features/guild.ts`.

- **Key U** (`keys.register({id: 'window.guild', keys: ['u'], label: 'keys.window.guild', group: 'windows', run})`, the `hud/index.ts:444` shape; `u` is free [confirmed: the registered keys are c, i, s/k, q/l, p, m, g, h, z, f, f8, f9, home]). Menu entry with `gil_sysbutton_guild` (UI.md: `ub_new_icon_guild` in the MENU popup).
- **Layout** (retail: the guild page of the community window, `mframe` **477×393** [confirmed `ginterface.txt GDR_COMMUNITY`; UI.md §4.6 agrees]; the `ifguild.txt` rects sit inside it, frame `frameg01_wnd_` (6,103,440,211)):
  - header (`gil_windo01`): guild name, master, member count "n / max";
  - notice box (title and text, edit button when allowed);
  - member list sorted by online first, then rank, then level (sort buttons Name / Level / Rank). Row: lamp `gil_contact_on/off`, name, level, rank label (Master / Vice Master / Member) or title, and "Last seen 2 d ago" for offline members;
  - command buttons: **Invite** (a name prompt; prefilled with the current player target), **Rights** (four checkboxes; master only), **Kick**, **Leave**, **Title**, **Hand over** (master only). Each is shown only when allowed.
- **Not in a guild:** the window shows "You do not belong to a guild. Guild Manager Leebaek in Jangan can create one."
- **Guild Manager dialog:** `registerNpcService('guild', ctx => ...)` shows:
  - "Create a new guild": a name prompt, then a confirm "Will you pay N gold and create [Name]?" (retail wording with the configured cost). The create cost and level travel in `WorldInfo.social?: {guildCreateGold, guildCreateLevel}` (`worldEnter.world`), so the prompt is exact [decision];
  - "Disband the guild" (master only), with a confirm that repeats the retail warning.
- **Target window:** a **Guild invite** action on player targets not in a guild, when you may invite.
- **Invite popup:** "[From] invites you to join [Guild]." Accept / Decline, 30 s.
- **Chat:** `chat.registerPrefix('@', rest => send chat {channel: 'guild'})` [confirmed `registerPrefix`; `#` is party, `/w` `/r` are whisper; `@` is free]. Commands `/guild <name>`, `/g <name>` and `/join <name>` = invite (all three are retail `UIIT_STT_CHAT_COMMAND_GUILD_INVITE*` strings). `matchPrefix` needs whitespace after an alphanumeric prefix [confirmed `chat.ts:56`], so `/g` does not swallow `/guilds …` (the GM command, §10.7).
- **Nameplates:** §5.7. "Display Guild Name" is a checkbox in the guild window's footer [confirmed: `hud/options.ts` has no registration API].
- **Login notice:** the retail line `Guild post "<title>"` in the system channel when `guild` arrives with a non-empty notice.

### 9.5 i18n keys (`en-trade.ts`, `en-stall.ts`, `en-guild.ts`; retail text where it exists)

The i18n files are **flat** objects of dotted keys (`'keys.window.party': 'Party'` [confirmed `en-party.ts`], merged by spreads in `en.ts` [confirmed lines 8–30]). The groupings below are key prefixes, not nested objects: `trade.title` is the key `'trade.title'`.

- `trade.*`:
  - `title` "Exchange", `request` "{name} (Lv {level}) applied for an exchange. Will you accept it?";
  - `asking` "Applying for a trade to {name}.", `started` "You started to exchange with {name}.", `done` "Exchanging with {name} is completed.";
  - `cancelled` "The exchange has been canceled.", `waiting` "Waiting for other player's approval.";
  - `confirm` "Confirm", `exchange` "Exchange", `locked` "Locked", `changed` "The other player changed the offer.";
  - `end.<reason>` for each `TradeEndReason`;
  - `fail.<reason>` for each reason a trade request can return.
- `stall.*`:
  - `title` "Stall", `defaultTitle` "{name}'s stall.", `defaultGreeting` "Welcome to {name}'s stall.";
  - `enterName` "Enter the name of the stall.", `enterGreeting` "Enter the owner's greeting for the stall.";
  - `open` "Open", `modify` "Modify", `modifying` "Modifying", `underConstruction` "The shop is under construction.";
  - `bought` "{buyer} bought item {item}.", `buyConfirm` "Buy {item} ×{count} for {price} gold?";
  - `full` "The member limit(8) has been reached.", `priceRange` "Can set the value only from 1 to 1 billion gold.", `nothing` "Cannot open a new shop without the registered goods.";
  - `closeFirst` "Close your stall first.", `townOnly` "Stalls can only be opened in town.".
- `guild.*`:
  - `window` "Guild", `master` "Guild Master", `vice` "Vice Master", `member` "Member", `notice` "Notice";
  - `create` "Create a new guild", `disband` "Disband the guild", `enterName` "Enter your guild name";
  - `createConfirm` "Will you pay {gold} gold and create {name}?", `created` "{name} guild has been created.";
  - `invited` "Do you want to join {name} guild?";
  - `joined` "{name} has joined your guild.", `left` "{name} has left the guild.", `kicked` "{name} has been banned from the guild";
  - `disbanded` "{name} guild has been disbanded.", `nameRule` "Guild name must consist of 2~12 English letters.";
  - `taken` "The selected guild name already exists.";
  - `rights.invite` "Join", `rights.kick` "Withdraw", `rights.notice` "Notice", `rights.title` "Name";
  - `notInGuild` "You do not belong to a guild.", `post` "Guild post \"{title}\"", `lastSeen` "{time} ago", `online` "Logging".
- `npc.option.guild` "Create or manage a guild." [decision; the other options are sentences, e.g. `'npc.option.shop': 'Trade in the shop.'` [confirmed `en-shops.ts:8`]].
- `chat.guildFrom` "(Guild) {name}: ", `chat.stallFrom` "(Stall) {name}: " (the `'chat.partyFrom': '(Party) {name}: '` format [confirmed `en-ux-world.ts:14`]), `chat.tab.guild` "Guild".
- `keys.window.guild` "Guild" (key labels carry no key: `'keys.window.party': 'Party'` [confirmed]).
- `action.fail.<reason>` lines for the 11 new reasons: the HUD toast looks up `` `action.fail.${reason}` `` and falls back to the server `message` or `action.fail.generic` when the key is missing [confirmed `hud/index.ts:131-134`; today's lines live in `en.ts:371+`]. `en.ts` itself is not touched beyond the import lines; each lane's file adds only its own reasons (trade: `trading`; stall: `stalling`, `stall_changed`, `stall_full`, `stall_closed`; guild: the other six). The `trade.fail.*` / `end.*` keys above are for the trade window's own lines.

---

## 10. Build plan

The order follows docs/WAVE_PLAN.md: **SOC-P → SOC-FS + SOC-FC (parallel) → lanes (parallel) → integration → adversarial hunt → fixes.**

**Merging with the sibling specs (fact-check).** The same files are claimed by SYSTEMS_COMBAT's foundation **F6-FS** (protocol.ts, validate.ts, content.ts, db.ts, config.ts, gameplay.ts, npc.ts, gm.ts, features.ts) and by EFFECTS' **FX-0** (protocol.ts, validate.ts, models.ts, entities.ts). If the three specs run in one wave:

- SOC-P and SOC-FS are **not separate agents**. Their edits are a checklist that the one foundation agent (F6-FS) applies in the same pass, so the exhaustive `NpcService` switch, `OPTION_KEY` and `SCHEMA_VERSION` test stay green together (§6).
- SOC-FC stays its own small client step. It runs after the foundation and **before** UI.md's migration lanes UI-H and UI-W. Those lanes later own `hud/target.ts`, `world/chat.ts`, `hud/npc-dialog.ts` and `hud/inventory.ts` and keep these seams (UI.md §6, §9).
- SOC-FC does not touch `entities.ts` or `models.ts`: the stall pose uses FX-0's `EntityView.idle` (§4.3).
- SOC-X shrinks to one test file plus two one-line requests (§10.4).
- If this spec runs alone, SOC-P, SOC-FS and SOC-FC are three agents as written. SOC-FC then also adds the minimal `EntityView.idle` override itself (`entities.ts:448` plays `this.idle` instead of `'STAND1'`).

Every lane runs `pnpm test` (vitest) on its tests and `pnpm typecheck` (`tsc -p tsconfig.json --noEmit`) [confirmed root `package.json` scripts] before handing over.

### 10.1 SOC-P: protocol (shared)

- **Owns** (edits; merged into F6-FS in a joint wave): `packages/shared/src/protocol.ts`, `packages/shared/src/validate.ts` (including the `chat` `to` + channel rule at line 317 and `worldInfo()` at line 863), `packages/shared/src/content.ts` (`ItemDef.canTrade`), new `packages/shared/test/social-protocol.test.ts`, `docs/PROTOCOL.md` (a "Social" section before "Content files").
- **Adds:**
  - §2.1 constants;
  - §2.2 reasons (+ `ACTION_FAIL_REASONS`);
  - §3.4, §4.2 and §5.4 types and messages;
  - `GameplayRequest` / `GAMEPLAY_REQUESTS`, `CLIENT_RATE_LIMITS` (§2.6);
  - `ChatSendChannel` / `ChatChannel` / `CHAT_*` arrays;
  - `NpcService += 'guild'`;
  - `EntityState.stall?`, `EntityState.guild?`, `entityUpdate.stall?`, `entityUpdate.guild?`;
  - `WorldInfo.social?: {guildCreateGold: number; guildCreateLevel: number}`.
- **Tests:**
  - every new client frame round-trips through `parseClientMessage`: exact keys, extra key → reject, each bound (±1), code-point limits with astral characters, `perms` duplicates rejected, `stallText {}` rejected, `chat {to, channel:'guild'}` rejected;
  - every server message parses; wrong `items` length rejected; `null` kept; `''` kept on `entityUpdate`;
  - `GUILD_NAME` accepts `Ab`, `Tigers2`, `A12345678901` and rejects `1ab`, `a`, `abc_def`, 13 characters, and non-ASCII names.

### 10.2 SOC-FS: server seams

- **Owns** (edits, hook points only; merged into F6-FS in a joint wave):
  - `apps/server/src/modules.ts`: `gate?` in `GameplayModule`. (F6-FS says "nothing new" there; this is the one addition.)
  - `apps/server/src/gameplay.ts`:
    - `private gateFor(p, t, mod, now)`: loops the modules, catches a throwing `gate` like `fanOut` does [confirmed `modules.ts fanOut`], logs it and **allows**;
    - the two call sites (§2.3): `request()` after line 618, `onMoveTo()` after `if (p.dead) return false`;
    - `readonly trade: TradeService`, `readonly stalls: StallService`, `readonly guilds: GuildService`, constructed after `this.party = new PartyManager(this)` [confirmed line 239];
    - `this.modules = [this.skills, this.npcs, this.shops, this.storage, this.itemUses, this.quests, this.party, this.trade, this.stalls, this.guilds]` [confirmed line 242], with F6-FS's six modules placed per its own spec (any order after `party` works for social).
  - `apps/server/src/db.ts`: append the social migration **inline** to `MIGRATIONS` (§7).
  - `apps/server/test/modules-w4.test.ts:158`: `SCHEMA_VERSION` 7 → the new total (one line).
  - `apps/server/src/chat.ts`: `if (msg.channel === 'guild')` → `conn.game.gameplay.guilds.chat(self, text)`, and `'stall'` → `stalls.chat`, with the party branch's shape (`not_in_world`, `takeChat()`, then `bad_request` when the call returns false) [confirmed `chat.ts:17-24`]. The `to` + channel rule is the validator's (§5.3).
  - `apps/server/src/npc.ts`: `has()` gets `case 'guild': return GUILD_MANAGER_NPCS.includes(npc.code)`; the `servicesOf` list at line 135 gains `'guild'`.
  - `apps/server/src/gm.ts`: `guilds: { usage: GUILDS_USAGE, about: ..., run: runGuildsCommand }` in `COMMANDS` (imported from `social/gm-guild.ts`) [confirmed `COMMANDS` table at line 148; `skill` → `gm-skill.ts` is the pattern]. Not `guild` (§5.6 G2).
  - `apps/server/src/config.ts`: optional `ServerConfig` fields with env names, the `goldRate?`/`expRate?` style [confirmed]: `guildCreateLevel?` (`GUILD_CREATE_LEVEL`, default 10, 1..300), `guildCreateGold?` (`GUILD_CREATE_GOLD`, 10000, 0..MAX_GOLD), `guildMaxMembers?` (`GUILD_MAX_MEMBERS`, 50, 2..100), `guildRejoinHours?` (`GUILD_REJOIN_HOURS`, 0, 0..720), `guildRecreateDays?` (`GUILD_RECREATE_DAYS`, 0, 0..60), `stallTownOnly?` (`STALL_TOWN_ONLY`, 1, 0..1). These are next to F6-FS's §6.1 knobs.
  - `apps/server/src/connection.ts`: `worldEnter.world.social` beside `levelCap` [confirmed line 443].
  - `apps/game/src/hud/npc-dialog.ts` (`OPTION_KEY.guild`) and `hud/shop-logic.ts` (`dialogOptions` order), **only** if SOC-FC does not land in the same commit. Otherwise the client typecheck breaks between steps (§6).
- **Creates stubs** (the lanes fill them): `apps/server/src/social/{trade.ts, trade-rules.ts, pair-tx.ts, stall.ts, stall-rules.ts, guild.ts, guild-rules.ts, guild-store.ts, gm-guild.ts}`. Each stub module has `name` and `handles`, and its `request()` answers `not_implemented`, so routes and tests run. The directory is new; no sibling spec uses `apps/server/src/social/` [confirmed].
- **Tests:**
  - new `apps/server/test/social-seams.test.ts` (not `modules.test.ts`, which other agents are editing now): gate order, own-handles exemption, allowlist refusal of an unknown future type, a throwing gate allows, and the moveTo drop leaves the position unchanged;
  - migration from v7 (or the current previous version) on a temp `DATA_DIR`. In a joint wave this extends SYSTEMS_COMBAT's `apps/server/test/migrate-wave6.test.ts`; alone, it is a new `migrate-social.test.ts`. `role-policy.test.ts` must still pass (it scans `src/` for SQL writing `accounts.role`; the social SQL never does).

### 10.3 SOC-FC: client seams

- **Owns** (all under `apps/game/src/`; the seam lines of §9.1):
  - `world/features.ts`: three feature lines, beside F6-FS's four;
  - `hud/index.ts`: `addTargetAction`, `refreshTargetActions` and `markBagSlots` on `Hud`. This is a hot file: other agents have uncommitted edits in it now, and UI-H/UI-W edit it later;
  - `hud/target.ts`: nothing, or a one-line export if needed; `setActions` stays;
  - `hud/inventory.ts`: OR the `markBagSlots` sets into the `blocked` flag at line 139;
  - `world/features/party.ts`: the two lines 416 and 476;
  - `hud/npc-dialog.ts` (`OPTION_KEY.guild`, `registerNpcService`) and `hud/shop-logic.ts` (`dialogOptions` order);
  - `screens/world.ts` and `world/move-feedback.ts` (`beforeGroundMove`; `screens/world.ts` also has other agents' uncommitted edits now);
  - new `world/approach.ts`;
  - `world/chat.ts` (kinds, category, tab, `chatLineFor` cases);
  - `i18n/en.ts` (three import and spread lines);
  - `net/mock/index.ts` (three lines).
  - Stubs: `world/features/{trade,stall,guild}.ts`, `i18n/en-{trade,stall,guild}.ts`, `net/mock/{trade,stall,guild}.ts`.
  - **Not** `world/entities.ts` or `three/models.ts` (FX-0 owns them; §4.3), unless this spec runs alone (§10 intro).
- **Tests:** new `apps/game/test/social-seams.test.ts`:
  - `approachThen`: arrival runs once; another click cancels; timeout;
  - `npc-dialog` registry: an unknown service is ignored; the handler is called with ctx; `dialogOptions(['guild'])` keeps `'guild'`;
  - `addTargetAction`: the party Invite and trade Exchange coexist;
  - `markBagSlots` survives an inventory refresh (a DOM-free check on the inventory model, if the window class is not constructible in node; the suite has no DOM environment [confirmed UI.md §8]).

### 10.4 SOC-X: converter

- **Owns:** new `packages/convert/test/data-cantrade.test.ts` only. It calls `buildItemDef` (exported by `packages/convert/src/data/items.ts` [confirmed; imported by `data-builders.test.ts:7`]) on fixture rows with `CanTrade` 0 and 1.
- **Requests (one line each, not owned):**
  - to SYSTEMS_COMBAT lane **EXP** (owner of `packages/convert/src/data/items.ts`): `if (r.cells[16]?.trim() === '0') def.canTrade = false` beside lines 183–184;
  - to UI.md lane **UI-X** (owner of `export-ui.ts`): extend its `interface/exchange` include to `/^(exc_|ch_)/`, so `ch_red.ddj` is exported too. The stall and guild folders are already in UI-X's list (§8).
- **Check:** after `pnpm tsx packages/convert/src/tools/export-data.ts`, `work/out/data/items.json` has `canTrade: false` on exactly the 25 `*_DEF` rows (e.g. `ITEM_CH_SWORD_01_A_DEF`, `ITEM_ETC_AMMO_ARROW_01_DEF`) and none on `ITEM_CH_SWORD_01_A`. After UI-X's run, `work/out/ui/{exchange,stall,guild}/` exist.

### 10.5 TR-S: trade server

- **Owns:** `apps/server/src/social/trade.ts`, `social/trade-rules.ts`, `social/pair-tx.ts`, tests `apps/server/test/trade.test.ts`, `trade-rules.test.ts`.
- **Hook points used:** `gate` (§2.3 trade row), `moved`, `stopped`, `playerDied`, `warped`, `forget`, `tick` (request expiry, distance break at 1 Hz), `request`. It also uses `g.afterInventory` [confirmed public] and `store.loadInventory` / `writeDraft`.
- **Tests:**
  - rules: every row of §3.3 (offer bounds, one offer per slot, lock freezes, a partner change clears the lock, accept only when both are locked, empty trade);
  - `commitDrafts`: plain swap; stack merge; +N and durability kept; items freed by one's own offer make room; `inventory_full` names the side; strict `gold_limit` on the net amount; snapshot mismatch → fail with both drafts unchanged;
  - `pairTx`: rollback on throw (both inventories and the log untouched);
  - module (Gameplay harness on FlatNav like `party.test.ts` [confirmed]): request/decline/expire; accept re-check; each end reason (move, distance, death, warp, forget); every locked request type answers `trading`; `social_log` row written.

### 10.6 ST-S: stall server

- **Owns:** `apps/server/src/social/stall.ts`, `social/stall-rules.ts`, tests `apps/server/test/stall.test.ts`.
- **Hook points used:** `gate` (§2.3 stall row), `playerDied`, `warped`, `forget`, `tick` (visitor distance), `request`, `world.decorators.push` (`stall` title), `g.data.inSafeArea`, `g.world.npcs` (clearance), `world.halt`, `g.itemUses.cancel`, `pairTx` (from TR-S; if TR-S has not landed, ST-S takes the §2.4 signature as given).
- **Tests:** §4.1 rules; S1–S13; decorator output; `entityUpdate stall` on create and close; visitor cap; buy in `modify` → `stall_closed`; owner `moveTo` dropped (the position does not change); stall chat to the owner and visitors only.

### 10.7 GU-S: guild server

- **Owns:** `apps/server/src/social/guild.ts`, `social/guild-store.ts` (statements only; the SQL text is in `db.ts`, §7), `social/guild-rules.ts`, `social/gm-guild.ts`, tests `apps/server/test/guild.test.ts`, `guild-store.test.ts`.
- **Hook points used:** `enter` (state after party), `forget`, `tick` (invite expiry, level sync every 2 s), `request`, `world.decorators.push` (`guild`), `g.npcs.requireService(p, npc, 'guild', now)` [confirmed `npc.ts:142`], `store.inventoryTx(..., extra)` [confirmed; wrap it in `try/catch` for the UNIQUE error, §5.2], `isReservedName` [confirmed export `connection.ts:61`].
- **GM command** `guilds` (not `guild`: the client claims `/guild …` for invites): `info <name>`, `rename <old> <new>`, `disband <name>`, `kick <guild> <character>`. Staff only; every call is written to `gm_audit` by the existing `runGm` path [confirmed `gm.ts` header].
- **Tests:**
  - store: create, insert and unique NOCASE; disbanded names reusable; deleted-character pruning with master handover; perms bitmask round trip;
  - rules: each §5.2 refusal; the penalty clocks with the config set;
  - module: guild chat reaches members only; nameplates (`entityUpdate guild`) on join/leave/kick/disband; the enter-world order; a relog keeps membership;
  - a **restart test**: the guild persists, and a trade or stall does not.

### 10.8 TR-C, ST-C, GU-C: client lanes

| Lane | Owns | Tests (vitest, DOM-free models) |
|---|---|---|
| TR-C | `hud/trade.ts`, `hud/trade-state.ts`, `hud/trade-request.ts`, `world/features/trade.ts`, `i18n/en-trade.ts`, `net/mock/trade.ts`; test `apps/game/test/trade.test.ts` | The state model applies `trade` / `tradeEnd`. The button label cycles (§9.2). The `markBagSlots('trade', …)` set follows `mine.items[].bag`. A partner change after lock flags "changed". `/trade` with no player target → a toast. |
| ST-C | `hud/stall.ts`, `hud/stall-state.ts`, `world/features/stall.ts`, `i18n/en-stall.ts`, `net/mock/stall.ts`; test `apps/game/test/stall.test.ts` | Owner vs visitor view. Buy sends exactly the shown code, count and price. Modify state disables Buy. Price parsing (separators, 0 refused, > 1e9 refused). The sign and `idle` are set and cleared from `EntityState` / `entityUpdate`. |
| GU-C | `hud/guild.ts`, `hud/guild-state.ts`, `hud/guild-invite.ts`, `world/features/guild.ts`, `i18n/en-guild.ts`, `net/mock/guild.ts`; test `apps/game/test/guild.test.ts` | Member sort (online, rank, level). The Vice Master label rule. Buttons shown per rank and perms. `guildMember` upsert and `guildMemberRemoved`. The `@`, `/guild`, `/g`, `/join` prefixes. The "Display Guild Name" toggle hides `.badge-guild`. The notice editor's UTF-8 byte cap (§2.5). |

Every file in this table is new, and none appears in the owned lists of SYSTEMS_COMBAT §8, EFFECTS §6 or UI.md §9.1 [confirmed by reading them]. UI.md §9.1 lists `hud/trade.ts`, `hud/stall.ts` and `hud/guild.ts` as these feature lanes' files. The client test files do not exist today [confirmed `apps/game/test/`]. The windows use the kit if UI-K has landed (§9.2).

### 10.9 Integration and adversarial hunt

- **Integration (one agent):**
  - merge;
  - `pnpm test` (vitest, whole repo) and `pnpm typecheck` [confirmed root scripts];
  - `role-policy.test.ts` and `modules-w4.test.ts` (the `SCHEMA_VERSION` line);
  - a WS e2e `apps/server/test/social-e2e.test.ts` with two clients on synthetic content (the `Client` helper [confirmed `helpers.ts`]): full exchange; stall create/list/open/visit/buy; guild create/invite/chat/relog; then server restart → guild present, stall gone.
- **Adversarial hunt** (`apps/server/test/abuse-social.test.ts`, the `abuse-party.test.ts` convention: "BUG:" tests reproduce real defects [confirmed]): T1–T15, S1–S13, G1–G11, plus:
  - interleavings with party gold share during a trade;
  - `itemUse` of a return scroll while stalling (gated);
  - GM `tp` of a stall owner (closes);
  - a trade partner going invisible (GM) (cancel on `canSee` loss at tick) [decision];
  - rate-limit floods not striking the socket;
  - sibling requests while trading or stalling: `repair`, `alchemyReinforce`, `mountRide`, `berserk`, `sit`, `emote` all answer `trading` / `stalling` (the allowlist, §2.3);
  - a pickup walk that completes during a trade and fills the offered slot's stack → the commit fails with "An item in the exchange changed." and nothing moves;
  - a GM typing `/guilds info X` reaches the GM command, and a player typing `/guild Bob` sends `guildInvite`, not a GM command.

### 10.10 User-visible checks (browser, two accounts; docs/PLAYTEST.md gains a "Social" section)

1. Stand near a friend in Jangan, target them, and click **Exchange**. They see the request popup with a 30 s countdown. After Accept, both see the exchange window with the partner on top.
2. Drag a potion stack and a weapon into your side, and type 500 gold. Your friend sees them (hover shows +N). Their Confirm stays available.
3. Press Confirm: your side shows *Locked*. Your friend changes their offer: your lock drops with "The other player changed the offer.".
4. Both Confirm, then both press Exchange: the items and gold swap, both bags update at once, and "Exchanging with X is completed." appears.
5. During a trade, try to drop or sell the offered item: refused, "You are trading.". Walk away: the trade ends for both.
6. Open the menu entry **Stall**, name it, list two items with prices, and press **Open**. You sit down (the `VENDOR01` loop, or `SIT` as the fallback; say which looks right), and a sign with the title floats over your name for everyone. Clicking the ground does nothing but "Close your stall first.". Try to list your starter sword: "The selected item cannot be traded.".
7. Your friend clicks you: the stall window opens with the greeting. They buy one listing: their gold drops and the item arrives. You get "[Friend] bought item [Item]." and the gold.
8. Switch to **Modify**: your friend sees "The shop is under construction." and cannot buy. Change a price, **Open** again: they see the new price.
9. Log out while stalling: the sign disappears for your friend, and their stall window closes.
10. At Guild Manager Leebaek (`NPC_CH_GENARAL_SP` at (-89, -249), about 50 m from General Sonhyeon (-133, -222) and from Hunter Associate Gwakwi (-32, -232) [confirmed `npcs.json`]; GM shortcut `/tp -89 -245`), choose **"Create or manage a guild." → Create a new guild**, enter a name, and confirm the cost. The guild name now shows over your head for everyone.
11. Press **U**: the guild window shows you as Guild Master. Invite your friend by name. They accept, and appear in the list with a green lamp and their level.
12. Type `@hello`: only guild members see it, in the guild colour and tab.
13. Your friend logs out: their lamp goes grey with "Last seen". Restart the server: the guild, members, notice and titles are still there.
14. Grant your friend **Join** rights: they can invite. Try to kick the master from their account: refused.
15. Disband at Leebaek: the name vanishes from both nameplates, and the window says you are in no guild.

---

## 11. Open questions and risks

- **Open questions:**
  - Retail exchange range, whether movement is allowed with the window open, and whether a partner's change unlocks your side [unknown]. This spec's rules are the safe reading.
  - Retail guild creation level and cost for vSRO 1.188 [unknown/likely]. The config defaults (10, 10,000) are tuned for the friends server's economy (docs/BALANCE.md: about 300,000 spare gold at level 20 frugal, at rate 1 [confirmed]).
  - Does a plain retail stall (no avatar booth) draw `booth.bms`? It is the shared base of the four avatar booths (§1). If it does, convert it through one of those `.bsr`s (e.g. `res/avatar/booth_mob_mangyang.bsr`, taking only the `booth.bms` part with `booth.ddj`) and attach it with an `EntityAttachment` in the stall feature (`ctx.addAttachment` [confirmed `features.ts`]) [unknown].
  - `VENDOR01` or `SIT` for the stall pose (§4.3) [likely VENDOR01]; the user check settles it.
  - The guild-name line position on nameplates (§5.7) [unknown]; the UI rework may move it.
  - Resolved in the fact-check: `hud/options.ts` has no registration API (the toggle lives in the guild window footer, §5.7). No exporter covers `icon/action`, and none is needed (§8).
  - docs/UI.md §4.6 gives the trade window as 254×361; the retail window with the client's active defines is 365×500 (§1). UI.md's owner should take the 365×500 layout, or keep 254×361 on purpose and drop the character views. This spec works with either.
- **Risks:**
  - The gate is a new cross-cutting veto. A bug there can block unrelated requests. Mitigations: the table in §2.3 is explicit, `gateFor` catches module throws like `fanOut` [confirmed pattern] and **allows** on a throw (logging it), and every locked type has a test.
  - Stall visits and trades rely on client-side approach walking. A client that never walks just gets `too_far`, which is harmless.
  - Guild state frames (up to 100 members × ~150 bytes ≈ 15 KB) are server → client only. The 1024-byte limit applies to client frames [confirmed PROTOCOL §1, `MAX_CLIENT_MESSAGE_BYTES`].
  - Hot files shared with other lanes: `hud/index.ts`, `screens/world.ts`, `gameplay.ts`, `npc.ts`, `gm.ts`, `features.ts` and `i18n/en.ts` all have other agents' uncommitted edits now, and SYSTEMS_COMBAT F6-FS, EFFECTS FX-0 and UI.md UI-H/UI-W edit them later. Mitigations: the seam steps are line-sized and quoted by code, the social lanes own only new files, and the merged foundation step applies all three specs' seams in one pass.
  - The allowlist gate (§2.3) refuses any request type that did not exist when it was written. That is intended, but a sibling lane landing a harmless new request (for example `emote`) must add it to the social allowlist on purpose, or players cannot emote while trading.
