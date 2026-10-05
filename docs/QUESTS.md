# Quests, party and GM content editors

This spec covers three roadmap items that share one server model:

1. **Custom quests**: a data-driven quest engine authored by us (the user says retail SRO "majorly lacks" quests), with its client (NPC markers, quest dialog, quest log, tracker, minimap hints).
2. **Party**: up to 8 players, SRO-like EXP and loot sharing, a party HUD, party chat and minimap markers.
3. **GM content editors**: in-game windows to place spawns and NPCs and to edit quests, stored as server-side override files layered over the exported data, with hot reload and audit.

It ends with the protocol additions (§6) and a build plan in parallel lanes (§7). The first questline, **"The Tiger's Shadow"** (levels 1-20, 31 quests + 4 dailies), is in `content/quests/jangan.json` and is described in §3.

It is a spec, not code. It follows `docs/PROTOCOL.md` (strict validators, additive v1 changes, one `actionResult` per request, per-type rate limits, the `t` discriminator) and does not reuse any name defined in `docs/SKILLS.md` §10.2.

## Status tags

- **[confirmed]**: checked in the repo code or in `work/out/data` (the numbers below come from scratch scripts run over the exports).
- **[likely]**: consistent with the data and code, not proven.
- **[unknown]**: not decided by any source. A rule is picked and kept in server config.

## 0. Facts this design rests on

| Fact | Tag |
|---|---|
| Client frames are capped at 1024 bytes (`MAX_CLIENT_MESSAGE_BYTES`); HTTP bodies at 4096 (`game.ts MAX_BODY_BYTES`). A whole quest definition does not fit in one WS frame, so the quest editor uses HTTP (§5.4). | confirmed |
| `/api/logout` already authenticates with `Authorization: Bearer <token>`; the client's `net/api.ts` can send it. | confirmed |
| In production the service runs with `ProtectSystem=strict` and only `DATA_DIR` (`/var/lib/silkroad`) writable (apps/server/README.md). Editor overrides must live under `DATA_DIR`, never in the repo checkout. | confirmed |
| `items.json` has **no** quest items (categories: gold, potion, pill, scroll, ammo, weapon, shield, armor, accessory). The client's itemdata does have `ITEM_QNO_CH_*` quest items with icons (`qno_ch_smith_1.ddj`, `etc_bell_curse.ddj`, ...). | confirmed |
| 46 NPCs in `npcs.json`, all in world `jangan`, most inside the town; codes in §3.2. Four stand outside today's 9 converted regions (`inConvertedRegion: false`): the two ferry ticket sellers, `NPC_CH_SPECIAL2` and `NPC_CH_SHAMAN` (Exorcist Miaoryeong, at (-561.7, -274.2), region 165,98, zone "Grassland"). | confirmed |
| `Gameplay.start()` places an NPC only where `nav.locate`/`nav.place` finds ground (`if (!at) continue`), so **Miaoryeong is not in the game today**. Every quest she gives or takes (JG_009-JG_013, JG_022, JG_023) waits for the wider world. | confirmed (code) / likely (that the navmesh lookup fails outside the 9 regions) |
| The currently converted world (9 regions, x 167-169, z 96-98, glTF x ∈ [-192, 384], z ∈ [-384, 192]; glTF +x = east, +z = south) contains nests of **only one mob, `MOB_CH_MANGNYANG`**: 8 of the 825 nests in `nests.json` (`inConvertedRegion: true`), 120 mobs. Every other questline mob spawns outside it. The wider world is the fields lane's job: docs/FIELDS.md exports regions X 155-175 × Z 89-103 (293 active regions measured on 155-174) as a new folder `work/out/world/jangan-fields`. It is not built yet. | confirmed |
| Tiger Girl (`MOB_CH_TIGERWOMAN`): level 20 unique, 598,720 HP, 451,200 EXP (no `spExp`, so SP-EXP = EXP), 11 nests in one `uniqueGroup`, respawn 10,800-21,600 s (3-6 h). Her data's basic attack `MSKILL_CH_TIGERWOMAN_ATTACK01` hits 2 times for 181-217, with a 3 s cooldown (`attackIntervalMs` 3000). Today's server swings mobs once per `attackIntervalMs` with **1** hit (`Gameplay.attack`: `{hits: 1, pct: 100}` for mobs). One of her 11 nests is exactly at the questline's Tiger Mountain Shrine (-1001, 600). | confirmed |
| Levelling from 1 to 20 takes 1,124,480 EXP (`levels.json` rows 1-19). Mob EXP is about 23.5 × level (Mangyang 24, Yeoha 235, Chakji 470). | confirmed |
| Kill EXP is shared by damage among players still in the world (`gameplay.ts shareRewards`); loot belongs to the top damage dealer for 30 s. | confirmed |
| At `LEVEL_CAP`, `gainExp` discards EXP but still adds SP-EXP. | confirmed |
| DB migrations are an append-only array in `db.ts` (4 so far). The skills lane and the shops lane (docs/SHOPS.md §5.2) also append one each, so every lane takes the next free index at merge time. | confirmed |
| `store.inventoryTx(characterId, fn, extra?)` exists: `extra` runs in the same SQLite transaction after the draft is written, only when `fn` succeeded. `Gameplay.afterInventory()` is `private` today (the shops lane also needs it public). `Gameplay.reward()` saves progress by itself, outside any inventory transaction. | confirmed |
| `gm.ts spawn` counts every living mob with `nest === null` against `GM_SPAWN_TOTAL_MAX` (300). Nest-less encounter mobs would count too unless that loop skips them. | confirmed |
| The chat validator accepts server channels `'local' \| 'system'` only; an unknown channel fails the whole frame on an older client. Client and server deploy together here, so adding `'party'` is acceptable. | confirmed |
| Hotkeys in use: I and C (`hud/index.ts`), Enter, Esc, F8/F9 (`screens/world.ts`, `gm/window.ts`). The UX lane (docs/UX_GAPS.md §4.1, from the client's own captions) assigns **Q** to the quest window and **P** to the party window, through one KeyMap. That KeyMap (`hud/keys.ts`), the MenuBar (`hud/menubar.ts`), `ChatBox.registerPrefix` and `HudMinimap.addMarkerSource` are **UX-lane proposals: none of them exists in the code yet**. **L** is unbound in our client and becomes an alias of Q; in SRO's captions L is Academy (out of scope). | confirmed |
| docs/SHOPS.md (in progress) owns the NPC talk flow: `npcTalk {npc}` → the server walks the player to 3 m → `npcDialog {npc, code, services}`, where `services` may contain `'quest'` "when the quest module reports one". The client window is `hud/npc-dialog.ts` `NpcDialogWindow` (callbacks `onShop`, `onStorage`, `onEnd`, plus `addTalkOption(npcCode, {label, run})` for this lane). None of these files exists yet (`apps/server/src/npc.ts`, `hud/npc-dialog.ts`). | confirmed (spec) |

---

## 1. Quest engine

### 1.1 Where content lives

| Path | What | Written by |
|---|---|---|
| `content/quests/*.json` (repo, new top-level `content/`) | Our authored questlines (`QuestFile`). In git: original writing plus CodeName128 ids, no retail data. | Us (Claude/the user), by hand |
| `DATA_DIR/content/quests/<QUEST_ID>.json` | GM edits made in game (one `QuestFile` per edited quest). | The quest editor (§5) |
| `DATA_DIR/content/history/` | The previous version of every override file, before each write (last 100 kept). | The editors |

`CONTENT_DIR` (env, default `<repo>/content`) points at the repo folder. Loading order: every repo file (alphabetical), then every override file; a later quest, item or location with the same id replaces the earlier one [rule].

### 1.2 Schema (`packages/shared/src/quests.ts`, new, environment-neutral)

The authoritative TypeScript is in §6.1. In short:

- **`QuestFile`** `{schema: 1, kind: 'quests', id, title, world, notes?, items: QuestItemDef[], locations: QuestLocation[], quests: QuestDef[]}`.
- **`QuestItemDef`** `{code: 'QITEM_*', name, description?, iconItem?, maxStack?}`. Quest items are **our** codes. `iconItem` names a client item (`ITEM_QNO_CH_SMITH_1`) whose icon the client borrows; without it the client uses a generic scroll icon.
- **`QuestLocation`** `{id: 'LOC_*', name, x, z, radius}` in glTF metres (world manifest frame). Used by `reach`, `useItem` and as minimap hints.
- **`QuestDef`**:
  - `id` (`JG_001`), `title`, `chapter` (quest log group), `kind` (`main | side | repeatable`), `summary` (one line for the log);
  - `level` (offered from), `maxLevel?` (not offered above);
  - `giver`, `turnIn`: NPC codes (`NpcDef.code`, or an authored `NPCX_*` NPC from §5.3);
  - `requires?.quests`: quests that must be completed first;
  - `repeat?`: `{reset: 'daily'}` or `{cooldownSec}` (only for `kind: 'repeatable'`);
  - `party?`: "group recommended" badge; also shares `useItem` credit (§1.6);
  - `giveOnAccept?`: quest items handed over on accept (letters, the bell);
  - `objectives`: 0-8 entries (an empty list = "report to the turn-in NPC");
  - `rewards`: `{exp, expPctOfLevel?, sp, gold, items?, choice?}`;
  - `dialog`: `{offer, progress, complete}` in English;
  - `disabled?`, `rev?` (server-assigned on each GM edit).
- **Objectives** (each has a stable `id` like `hides`, an optional `label`, `hint` location and `after` objective id):

  | type | Fields | Completes when |
  |---|---|---|
  | `kill` | `mobs: string[]`, `count` | `count` kills of any listed mob credited to you (§1.5) |
  | `collect` | `item: QITEM`, `count`, `from: {mob, chance}[]` | you hold `count` of the quest item; each credited kill of a listed mob rolls `chance` |
  | `talk` | `npc`, `text` | you pick the quest topic in that NPC's dialog (`questTalk`) |
  | `deliver` | `npc`, `item` (QITEM or ItemDef code), `count`, `text` | you hand the items over in that NPC's dialog (`questTalk`); they are removed |
  | `have` | `item` (ItemDef code), `count`, `consume?` | your bag holds `count` (live count); taken at turn-in when `consume` |
  | `reach` | `location` | you stand within the location's radius |
  | `useItem` | `item: QITEM`, `location`, `consume?`, `text?`, `encounter?` | you use the quest item inside the radius (`questUseItem`); may spawn an encounter |

  `after: '<objective id>'` gates an objective: it counts nothing until that one is complete (the finale kill only counts after the bell is rung).
- **Reward codes** may contain two tokens, expanded per character at turn-in by the shared `expandRewardCode()`:
  - `{G}`: `M` or `W`, from the character model (`CHAR_CH_WOMAN_*` = W);
  - `{ARMOR}`: `CLOTHES`, `LIGHT` or `HEAVY`, from the equipped chest item's `armorType` (garment, protector, armor), else the creation `outfit`.

  The validator expands all six variants and requires each to exist in `items.json`. `ITEM_CH_{G}_{ARMOR}_02_BA_A` therefore gives a woman in protector gear `ITEM_CH_W_LIGHT_02_BA_A` [confirmed: every armour piece has the same `reqLevel` across gender and class, e.g. `02_BA_A` is level 13 in all six].
- **Dialog text** is content (in the quest file), not UI copy, so it does not go into `i18n/en.ts`. It may contain `{name}` (the character name). Every string is at most 1,200 code points; control and bidi characters are stripped; the client renders it as text only (`textContent`, never HTML).

**Validation** (`validateQuestFile(json, refs?)` in shared, run by the server at load and by the editors): exact types and bounds; unique ids; `after`/`hint`/`location` references resolve inside the file set; `giveOnAccept` covers every quest item a `deliver`/`useItem` needs; no `requires` cycles. With `refs` (known mob, item and NPC codes and the level cap) it also checks every code and every token expansion. Problems are `{path, message, severity}`. Errors drop the quest (the load report lists them, like `gamedata.ts`); warnings are logged. The content checker `apps/server/test/quests-check.ts` (`pnpm tsx apps/server/test/quests-check.ts`; run by `quests-content-check.test.ts`) runs the reference part of these checks on `jangan.json` against the exports: codes, token expansions, `giveOnAccept` coverage, `after`/`hint`/`location` ids, and the level and reward rules. It reports 0 errors, also after the fact-check edits [confirmed]. It does not check types, bounds or `requires` cycles; lane A's validator does.

### 1.3 Quest lifecycle (server)

```
            questAccept                     all objectives done              questTurnIn
 offered ───────────────► active ──────────────────────────────► ready ─────────────────► done
    ▲                       │  ▲ (a `have` count drops, a def edit)  │                        │
    │   questAbandon        │  └────────────────────────────────────┘                        │
    └───────────────────────┘                                                                │
    ▲                                              repeatable: reset (daily) / cooldown       │
    └─────────────────────────────────────────────────────────────────────────────────────────┘
```

**Offered** (computed, never stored) when all of these hold: not disabled; `level ≤ character level ≤ maxLevel`; every `requires` quest done; not active; not done, or repeatable and available again.

**`questAccept {npc, quest}`**, checked in order (each failure is an `actionResult` reason):
1. The NPC entity exists and was sent to you (`not_found`), is within `NPC_INTERACT_RANGE` 8 m (`too_far`), and its identity is the quest's `giver` (`not_found`).
2. The quest exists and is offered: level/prerequisites (`requirements`), already active (`quest_active`), done and not repeatable or not yet reset (`quest_done`, `cooldown`).
3. Fewer than `MAX_ACTIVE_QUESTS` (10) active (`quest_log_full`).
4. Then: insert the state, grant `giveOnAccept`, evaluate `have` and `reach` at once, answer `ok`, send `questUpdate {event: 'accepted'}`.

**`questTurnIn {npc, quest, choice?}`**: NPC checks as above but against `turnIn`; status `ready` (`not_complete`); `choice` required and in range when `rewards.choice` is non-empty (`choice_required`, `invalid_slot`); the reward items must fit the bag (`inventory_full`, nothing changes). Everything happens in **one SQLite transaction** (`store.inventoryTx(..., extra)`): take `have`-consume items, add reward items and gold, delete the state and the quest items, upsert `quest_done`, and save the progress (EXP/SP applied to a copy with `gainExp`). `Gameplay.reward()` cannot be called for this as it is: it runs `gainExp` and `saveProgress` itself, outside the transaction [confirmed]. Lane B therefore splits it into "compute" (`gainExp` on a copy, done inside `extra`) and "announce" (a new `applyProgress(p, next, levels, gain)` that sets `p.progress` and sends `statsDelta`/`levelUp`/`entityUpdate`/`stats`, called after the commit); `reward()` becomes compute + save + announce, and kill rewards behave exactly as before. Then the effects are sent: `actionResult ok`, `questUpdate {event: 'completed'}`, `inventoryUpdate`, `statsDelta {gain: {exp, spExp, quest}}` and, on level-up, the usual `levelUp`/`entityUpdate`/`stats`.

**EXP and SP rewards.**
- EXP = `rewards.exp` + `expPctOfLevel` % × `levels[level].exp` of the character's level at turn-in (repeatables use only the percentage). Here and in §3.4, `levels[L]` means the `levels.json` row whose `level` is L (array index L − 1), i.e. `GameData.expToNext(L)`, the EXP from L to L + 1.
- SP is granted as `sp × 400` SP-EXP through `gainExp`, so the existing SP-EXP path stays the only one.
- At `LEVEL_CAP` the EXP would be lost; the rule `QUEST_CAP_EXP_TO_SPEXP` (default on) adds it as SP-EXP instead [rule].

**`questAbandon {quest}`**: deletes the state and that quest's quest items; despawns an encounter only this player owns. Main quests can be taken again from the giver. A disabled quest stays in the log (its progress is kept) with the note "withdrawn"; it can be abandoned but not turned in.

**Repeatables.** `quest_done.times` and `last_at` are kept. `reset: 'daily'` makes a quest available again after the next `QUEST_DAILY_RESET_HOUR` (default 4, server local time) following `last_at` [rule]. `cooldownSec` makes it available at `last_at + cooldownSec`. The server sends `availableAt` so the client can grey the marker.

**No failure states.** No timers or escort failures in v1: fewer ways to lose progress for a small group of friends.

### 1.4 Persistence (SQLite, next migration)

The SQL lives in `apps/server/src/quests/store.ts` as `QUEST_MIGRATION` and is appended to `MIGRATIONS` in `db.ts` (append only; whichever of skills/quests lands second takes the next index):

```sql
-- quests: per-character state (docs/QUESTS.md §1.4)
CREATE TABLE quest_state (
  character_id INTEGER NOT NULL REFERENCES characters(id),
  quest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'ready')),
  rev INTEGER NOT NULL DEFAULT 0,            -- QuestDef.rev the counts belong to
  counts TEXT NOT NULL DEFAULT '{}',         -- JSON {objectiveId: count}; collect counts are derived from quest_items
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (character_id, quest)
);
CREATE TABLE quest_done (
  character_id INTEGER NOT NULL REFERENCES characters(id),
  quest TEXT NOT NULL,
  times INTEGER NOT NULL DEFAULT 1 CHECK (times >= 1),
  last_at INTEGER NOT NULL,
  PRIMARY KEY (character_id, quest)
);
-- The quest bag: quest items belong to one active quest and vanish with it.
CREATE TABLE quest_items (
  character_id INTEGER NOT NULL REFERENCES characters(id),
  quest TEXT NOT NULL,
  code TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 1),
  PRIMARY KEY (character_id, quest, code)
);
```

`store.quests` (from `questStore(db)`) exposes `load(characterId) → {active, done, items}`, `accept(...)`, `saveCounts(characterId, quest, counts, status)` (written when a count changes; the tick loop is single-threaded, so one small UPDATE per kill is cheap), `addItem`, `removeQuest`, and `turnIn(...)` (called inside `inventoryTx`'s `extra`).

### 1.5 Evaluation hooks (server)

The engine is `apps/server/src/quests/engine.ts` (`QuestEngine`), owned by `Gameplay` (`this.quests`). It keeps a runtime `QuestLog` per player (`active: Map<id, ActiveQuest>`, `done: Map<id, {times, lastAt}>`, `items`) and indexes built by `QuestBook` (`quests/book.ts`): `byGiver`, `byTurnIn`, `killIndex: mob → [quest, objective]`, `dropIndex: mob → [quest, objective, item, chance]`.

| Hook (in `gameplay.ts`) | Engine call | What happens |
|---|---|---|
| `sendEnter(p)`, after `inventory` (and after the skills lane's `skills`) | `quests.enter(p)` | Load the log, re-map old `rev`s (§5.4), send `quests`. |
| `forget(p)` | `quests.leave(p)` | Drop the runtime log (the DB is already current). |
| `request()` switch: `questAccept`, `questTurnIn`, `questAbandon`, `questTalk`, `questUseItem` | `quests.request(p, msg, answer)` | §1.3, §1.6. Exactly one `actionResult`. |
| `mobDied(m, now, rewards)` when `rewards` is true, after the EXP shares | `quests.onKill(m, credit, now)` | For each credited player and each active quest in `killIndex[m.def.code]`: +1 unless gated by `after` or full. For `dropIndex`: roll `chance` per player and objective; on success +1 quest item, a system chat line ("Mangyang Hide (3/6)"). Status becomes `ready` when every objective is full. |
| `tickPlayer(p, now)`, after its `if (p.dead) return` line; the engine throttles itself to every 500 ms per player with an open `reach` objective | `quests.onMove(p, now)` | XZ distance (`world.positionAt`) to each open `reach` location. Dead players are skipped by `tickPlayer` [confirmed]. |
| `afterInventory(p, draft)` | `quests.onInventory(p)` | Recount `have` objectives (they can drop back: `ready` → `active`). |
| `mobDied` for an encounter mob; the despawn timer in `tick` | `quests.onEncounterEnd(m)` | Frees the encounter slot. |

**Kill credit** (`credit`, a `Set` of player ids): every player with damage on the mob who is still in the world and alive [rule; note that kill EXP still reaches a dead damage dealer today, see the comment in `reward()`, so dropping "alive" here would match EXP], plus, for players in a party, every party member eligible for the EXP share (online, alive, within `PARTY_SHARE_RANGE` 60 m of the corpse), whatever the party's EXP mode. Before the party lane lands, `credit` is the key set of `shareRewards()`. GM `kill` gives no credit (no rewards), like EXP today.

**Quest drops never touch the ground.** They go straight into the quest bag of each credited player who needs them, so loot rules and `inventory_full` never block a quest, and party members each roll for themselves.

### 1.6 `talk`, `deliver`, `useItem` and encounters

- **`questTalk {npc, quest, objective}`**: NPC range and identity (`not_found`, `too_far`), the objective is a `talk`/`deliver` for that NPC, open, and not gated (`requirements`). `deliver` then takes the items (quest bag, or the bag through `inventoryTx` for an ItemDef code; missing → `not_complete`). The client shows `objective.text` as the NPC's line.
- **`questUseItem {quest, objective}`**: the objective is a `useItem` whose quest item you hold (`not_found`); you are alive and within the location radius (`wrong_place`). It completes (the item is taken when `consume`), and `text` is shown as a centre-screen "vision". For a `party: true` quest it also completes for every party member within 60 m of you who has the quest active.
- **Encounters** (`useItem.encounter`): spawn `count` mobs of `mob` on open ground within 8 m of the user (`nav.place`), not tied to a nest:
  - HP = `def.hp × VARIANT_RULES[variant].hp × hpMul`; attack × `attackMul`; kill EXP × `expMul`. `createMob()` gets an optional `tuning` argument, and the Mob an optional `encounter {quest, owners: Set<characterId>, despawnAt}` field.
  - One live encounter per quest per owner group (the party, or the player alone). While it lives, another use answers `cooldown` ("It is already here."). If it despawns unkilled after `despawnSec`, or is killed by anyone (even when the owners got no credit), the item can be used again after `cooldownSec`, as long as a later objective is still open. The cooldown belongs to the character: abandoning and re-accepting the quest does not reset it (abandoning a live encounter that only you own despawns it and starts the cooldown). A GM `/kill` of the encounter mob ends the encounter with no cooldown (W4-fix).
  - Anyone may fight it; credit follows the normal kill rules. Encounter mobs do not count toward `GM_SPAWN_TOTAL_MAX`. That needs a one-line hook: `gm.ts spawn` counts every living `nest === null` mob today, so its loop must skip `m.encounter` [confirmed].
  - With `nest: null`, `createMob()` gives the mob GM-spawn tactics: roam 5 m, sight 15 m, leash 40 m, and `aggressive` from the MobDef. The Tiger Girl's is `true` [confirmed].
- The finale's Tiger Girl encounter uses `hpMul 0.05` (29,936 HP), `attackMul 0.8`, `expMul 0.1` (45,120 EXP), 600 s. These are tuning knobs: player damage at level 19-20 is not measured yet [unknown]. The roaming retail Tiger Girl also counts once the bell has been rung.

### 1.7 Limits and config

| Name | Default | Where |
|---|---|---|
| `MAX_ACTIVE_QUESTS` | 10 [rule] | shared constant (the client shows "10/10") |
| `MAX_QUEST_OBJECTIVES` / `MAX_REWARD_CHOICES` | 8 / 8 | shared |
| Quest bag | 8 codes per quest, stack ≤ `maxStack` (default 99) | shared validator |
| `QUEST_DAILY_RESET_HOUR` | 4 | env / config.ts |
| `QUEST_CAP_EXP_TO_SPEXP` | 1 | env / config.ts |
| `QUEST_REACH_CHECK_MS` | 500 | engine constant |
| `CONTENT_DIR` | `<repo>/content` | env / config.ts |

---

## 2. Quest client

New folder `apps/game/src/quests/`. All UI captions are keys in `i18n/en.ts` (§2.7); quest text comes from the quest file.

### 2.1 Data

- **`catalog.ts` `QuestCatalog`**: `GET /api/quests` (Bearer token) returns `{rev, files}`, the merged quest files (repo + overrides). It is fetched after `worldEnter` and again on `contentChanged {kind: 'quests'}`. It indexes quests by giver and turn-in NPC and resolves items, locations and names.
- **`state.ts` `QuestState`** listens to `quests` / `questUpdate` (full replace per quest) and keeps `active`, `done`, `availableAt`. It exposes `markFor(npcIdentity, level)`, `topicsFor(npc)`, `tracked()`, and change events for the log, tracker, markers and minimap.
- **NPC identity** = `EntityState.npc ?? EntityState.model` (authored NPCs send `npc`, §5.3).
- **Reward expansion** uses the shared `expandRewardCode()` with the gender from the own model and the armour class from `hud.inventory` (equipped chest), so the dialog shows exactly the item the server will give.

### 2.2 NPC markers

`quests/markers.ts` computes one mark per NPC in view and calls `EntityView.setQuestMark(mark | null)`. That is the only hook in `world/entities.ts`: one `span.entity-quest-mark` placed above the name label and moving with it.

| Mark | Glyph | Colour | When (highest wins) |
|---|---|---|---|
| `ready` | ? | gold | an active quest whose `turnIn` is this NPC is `ready` |
| `talk` | … | gold | an open `talk`/`deliver` objective targets this NPC |
| `available` | ! | gold | a main/side quest from this NPC is offered |
| `repeatable` | ! | blue | a repeatable from this NPC is offered |
| `progress` | ? | grey | an active quest turns in here but is not ready |
| `soon` | ! | grey | a quest from this NPC unlocks within 2 levels (hover tooltip "Requires level N") |

Marks are recomputed on quest events, on level changes and when NPCs spawn, never per frame.

### 2.3 Quest section of the NPC dialog

The shops lane owns the NPC talk flow and window (docs/SHOPS.md §3, §8.3). Quests plug into it in two places:

- **Server: the `'quest'` service.** The shops lane's `apps/server/src/npc.ts` (`NpcDialogs.talk`) asks `gameplay.quests.hasTopics(p, npcCode)`. It returns true when that NPC has an offered, ready, in-progress or talk/deliver topic for this character, and then `'quest'` goes into `npcDialog.services` (one hook line in a shops-lane file). The dialog then shows the option `npc.option.quest` first, above Shop/Storage. That caption key belongs to the shops lane: docs/SHOPS.md §3.2 gives it the text "Talk to this person." (retail WND_TALKSTART), while docs/UX_GAPS.md §9 item 2 quotes "Talk about a quest." The shops lane's text wins; this lane does not redefine the key.
- **Client: the quest section.** Clicking that option calls `NpcDialogWindow.onQuest` (a callback like `onShop`/`onStorage`; if the shops lane ships only `addTalkOption(npcCode, {label, run})`, the adapter registers one option per topic on each `npcDialog` and removes them on close). The quest lane then lists the NPC's topics and pages through them. The pages render in a quest-owned panel docked over the dialog body (`quests/dialog-panel.ts`), which closes with the dialog (`npcDialogClose`). So the shops window needs no quest code.

The contract lives in `apps/game/src/quests/dialog.ts`. If the host's API differs, only this small adapter changes:

```ts
export interface NpcDialogContext { npcId: number; npcCode: string; npcName: string }
export interface NpcDialogPager { show(page: NpcDialogPage): void; back(): void; close(): void }
export interface NpcDialogPage {
  title: string
  paragraphs: string[]                 // plain text, {name} already filled
  objectives?: string[]                // "Mangyang slain 3/8"
  rewards?: { exp: number; sp: number; gold: number; items: RewardView[]; choice: RewardView[]; chosen?: number }
  buttons: { label: string; kind?: 'primary' | 'normal'; disabled?: boolean; onClick(): void }[]
}
export interface RewardView { code: string; name: string; icon: string | null; count: number }
export interface NpcDialogTopic {
  key: string                          // 'quest:JG_003'
  label: string                        // quest title
  icon: 'quest-available' | 'quest-ready' | 'quest-progress' | 'quest-talk' | 'quest-repeatable'
  order: number
  open(pager: NpcDialogPager): void
}
export function questTopics(ctx: NpcDialogContext, quests: QuestState, catalog: QuestCatalog): NpcDialogTopic[]
```

Pages:
- **Offer**: title, `dialog.offer`, objectives, rewards (choice shown as selectable slots), buttons Accept / Decline.
- **Progress**: `dialog.progress`, the live counts, button Close.
- **Talk/deliver**: the objective's `text`; the button (Continue / Hand over) sends `questTalk`.
- **Complete**: `dialog.complete`, rewards; Complete is disabled until a choice is picked when there is one. It sends `questTurnIn`.

Results arrive FIFO as `actionResult`; failures are toasts via `actionFailText()`. Walking to the NPC is the host's business (`npcTalk` walks to 3 m; quest requests are checked at 8 m, like shop requests).

### 2.4 Quest log window (Q, alias L)

`quests/log.ts`, a `HudWindow` (id `quests`, about 520 × 420):
- Left: active quests grouped by `chapter`, a "10/10" counter, and a "Show completed" toggle.
- Right: title, level, giver → turn-in names, summary, objectives with counts (✓ when full), quest items (icon × count), rewards, and buttons **Track** (per-viewer, stored in `localStorage` `sro.quests.tracked`) and **Abandon** (confirmation dialog; sends `questAbandon`).
- `useItem` objectives show a **Use** button, enabled when you are inside the radius (client-side hint; the server decides).

### 2.5 Tracker and notifications

- **Tracker** (`quests/tracker.ts`): below the minimap on the right, up to 5 tracked quests (new quests are tracked automatically). One line per open objective ("Water Ghost Slave 7/12"), "Return to Exorcist Miaoryeong" when ready, and a Use button for `useItem`. Clicking a line opens the log.
- **Notifications** (through `hud.toast` / `HudMessages`; sounds come later from the sound lane):
  - accepted: "Quest accepted: Pests in the Millet";
  - quest-item drop: loot style "Mangyang Hide (3/6)";
  - objective full: "Mangyang slain 8/8";
  - ready: "Quest complete. Return to Village Chief Hwangno.";
  - completed: a banner like the level-up one, then the usual EXP/item lines;
  - `useItem` text: a centre-screen line lasting 6 s, also in chat as a system line.

### 2.6 Minimap

Quest markers go through the UX lane's `HudMinimap.addMarkerSource()` (docs/UX_GAPS.md M2; `MinimapMarker` already exists in `@sro/world-render`). The quest source returns:
- **areas**: translucent gold circles for the `hint`/`location` of open objectives of tracked quests. This needs one optional field on the marker, `radius` (metres, drawn as a circle), which is the only change asked of that API;
- **pins**: the `mm_sign_questnpc` icon (or a gold ringed dot before M2 lands) for NPCs where a tracked quest is `ready` or has a `talk`.

Party members come from the party lane's own source (§4.5).

Off-map targets draw as an edge arrow [rule]. The client has the art for all of these: `interface/minimap/mm_sign_questnpc.ddj`, `mm_sign_questarrow.ddj`, `mm_sign_party.ddj` and `mm_sign_partyarrow.ddj` are in the Media archive (`pnpm sro ls Media interface/minimap`) but are not exported yet [confirmed]. Today's `MinimapMarker` (`packages/world-render/src/minimap.ts`) is `{x, z, color, size?}`, a dot only [confirmed].

### 2.7 i18n keys (`apps/game/src/i18n/en-quests.ts`, spread into `en.ts`)

Following docs/UX_GAPS.md §6 item 5, each lane keeps its strings in its own file and adds one spread line (`...enQuests,`) to `en.ts`.

`quest.log.title` "Quests", `quest.log.count` "{n}/{max}", `quest.log.empty` "No quests. Look for ! above people in town.", `quest.log.completed` "Show completed", `quest.track`, `quest.untrack`, `quest.abandon`, `quest.abandonConfirm` "Abandon {title}? Quest items will be lost.", `quest.use` "Use", `quest.accept` "Accept", `quest.decline` "Decline", `quest.complete` "Complete", `quest.continue` "Continue", `quest.handOver` "Hand over", `quest.rewards` "Rewards", `quest.choose` "Choose one:", `quest.exp` "{n} EXP", `quest.sp` "{n} SP", `quest.gold` "{n} gold", `quest.objective.kill` "{mob} slain {n}/{count}", `quest.objective.collect` "{item} {n}/{count}", `quest.objective.talk` "Talk to {npc}", `quest.objective.deliver` "Bring {item} to {npc}", `quest.objective.have` "{item} {n}/{count}", `quest.objective.reach` "Go to {place}", `quest.objective.useItem` "Use {item} at {place}", `quest.returnTo` "Return to {npc}", `quest.toast.accepted`, `quest.toast.ready`, `quest.toast.completed`, `quest.withdrawn` "This quest was withdrawn by a Game Master.", `quest.requiresLevel` "Requires level {level}", `quest.partyRecommended` "Group recommended", `quest.daily` "Daily", `quest.availableIn` "Available again in {time}", plus `action.fail.<reason>` for every new reason of §6.3.

### 2.8 Mock server

`net/mock.ts` / `mock-rules.ts` get a subset: accept, kill and collect counting on mock kills, turn-in with EXP and gold. The quest UI can then be exercised offline (optional, same lane).

---

## 3. The Jangan questline: "The Tiger's Shadow"

File: `content/quests/jangan.json`. 31 quests (25 main, 6 side) and 4 daily repeatables, 21 quest items and 17 locations. Validated against the exports: 0 errors [confirmed]. The fact-check added two hint locations, `LOC_ARCHER_CAMP` and `LOC_TIGER_SLOPE`; see the hint notes under §3.3.

### 3.1 Story

The temple's **Jade Tiger Seal**, which kept the spirit of Tiger Mountain asleep, has been stolen. The dead are restless; grave robbers are digging tiger-bone talismans out of the old tombs; bandits sell the bones to a masked buyer. She turns out to be the **Tiger Girl**, a woman who once made a bargain with the tiger spirit and never got her body back.

- **Act I, A Stranger at the Gate (levels 1-5).** The newcomer meets the town, from Soldier Fengil at the gate to Chief Hwangno. Sochil the beggar boy trades gossip for a meat bun. Ghosts in the southern grass lead to Priest Jeonghye and her confession: the Seal is gone. A silk pouch of tiger-bone dust at the old shrine shows this was no common thief.
- **Act II, The Restless Dead (6-10).** Jeonghye swallows her pride and sends you to her rival, the sharp-tongued Exorcist Miaoryeong, outside the west wall. The swamp's drowned lanterns show a vision of masked robbers and a woman whose shadow has a tail. The Qin-Shi tomb guardians are awake. Priest Kushyan, a scholar from the far west, reads the talismans: keys to wake the Tiger of the Mountain. The hunters find the robbers' camp in Yeoha's Forest.
- **Act III, The Bandit Road (11-16).** General Sonhyeon takes over. You cut the bandits' supply line, recover Hwajung's silk, find Fengil's lost patrol (a callback to the first quest) and calm the maddened tigers. Sochil hears of a ledger. The quiet WalYoung reads its moon cipher, and the army storms the Bandit's Mountain Stronghold.
- **Act IV, The Tiger Girl (17-19, climax at level 19-20).** The buyer is "the Daughter of the Mountain". Miaoryeong has a Binding Bell cast from white tiger fangs and chakji iron by Chulsan the smith, who grumbles all the way. You ring it at the Tiger Mountain Shrine with your friends, defeat the Tiger Girl and bring the Seal home. Jeonghye: "Nothing on that mountain sleeps forever." The epilogue at Chief Hwangno pays off the first scene.
- **Side stories:** Fengil's tip that sends a newcomer to Mrs Jang and Chulsan before the first real fight; Chulsan's first real weapon; Flora's apology (with a poem) to Ishyak, the merchant she owes money, who stands a few steps away (32 m); Mrs Jang's winter linings; Juho's bet that he can out-kill you; So-Ok's zither strung with tiger whiskers.

### 3.2 Cast (real Jangan NPC codes [confirmed in npcs.json])

| NPC code | Name (client) | Role in the story | Position (x, z) |
|---|---|---|---|
| `NPC_CH_SOLDIER_EM2` | Soldier Fengil | first contact at the gate; loses his patrol | 93.8, -190.3 |
| `NPC_CH_CHEF` | Village Chief Hwangno | dry old chief; first and last scene | 277.0, -143.3 |
| `NPC_CH_POTION` | Herbalist Yangyun | salves, daily reeds | 158.4, -140.7 |
| `NPC_CH_BEGGARBOY` | Bagger Sochil | street kid, trades rumours for food | -53.4, -54.4 |
| `NPC_CH_PRIEST` | Buddhist Priest Jeonghye | keeper of the stolen Seal | 258.0, -290.1 |
| `NPC_CH_SMITH` | Blacksmith Chulsan | weapons; casts the Binding Bell | 33.3, -140.7 |
| `NPC_CH_SHAMAN` | Exorcist Miaoryeong | lives outside the wall; knows tiger lore; keeps watch at the west river bridge since the yeoha took her hut | -419, -314, on the bridge deck (repo override; export -561.7, -274.2) |
| `NPC_CH_INDIA` | Buddhist Priest Kushyan | reads the bone talismans | 261.2, -205.7 |
| `NPC_CH_GENARAL_SW` | Hunter Associate Gwakwi | hunters' lodge; tigers | -32.0, -232.0 |
| `NPC_CH_GENARAL` | General Sonhyeon | the garrison; bandit war | -133.2, -222.0 |
| `NPC_CH_DOCTOR` | Merchant Associate Hwajung | lost silk caravan | 176.1, -35.8 |
| `NPC_CH_MOONSHADOW` | WalYoung | reads the moon cipher | 277.9, -106.9 |
| `NPC_CH_GENARAL_BO` | Juho | mercenary with a wager | -42.9, -344.0 |
| `NPC_CH_KISAENG1` | Gisaeng So-Ok | zither strings | -101.8, -62.1 |
| `NPC_CH_EUROPE` / `NPC_CH_ISLAM` | Adventurer Flora / Islam Merchant Ishyak | the letter (they stand 32 m apart) | 167.1, -26.1 / 167.1, -58.1 |
| `NPC_CH_ARMOR` | Protector Trader Mrs Jang | weasel pelts | 33.2, -108.5 |

Antagonist: `MOB_CH_TIGERWOMAN` (Tiger Girl, level 20 unique).

### 3.3 Quests

Mob levels follow the name; drop chances in brackets. "armour" rewards are `ITEM_CH_{G}_{ARMOR}_<piece>`, adapted to the character (§1.2). A weapon choice offers the sword, blade, spear, glaive and bow of that tier plus the shield.

| Id | Title | Lv | Giver → turn-in | Objectives | Rewards |
|---|---|---|---|---|---|
| JG_001 | Welcome to Jangan | 1 | Fengil → Hwangno | report | 60 EXP, 1 SP, 100 gold, 5 HP Recovery Herb |
| JG_002 | Pests in the Millet | 1 | Hwangno | kill 8 Mangyang 1 | 120 EXP, 1 SP, 150 gold, 5 MP Recovery Herb |
| JG_003 | Herbs and Hides | 2 | Yangyun | collect 6 Mangyang Hide (Mangyang 50%) | 200 EXP, 1 SP, 150 gold, choice 10 HP or 10 MP herbs |
| JG_S05 | Dressed for the Road (side) | 1 | Fengil → Chulsan | talk to Mrs Jang | 40 EXP, 1 SP, 300 gold |
| JG_004 | The Boy Who Hears Everything | 2 | Hwangno | deliver the Meat Bun to Sochil | 120 EXP, 1 SP, 200 gold, Ume Copper Ring, 2 Return Scroll |
| JG_005 | Eyes in the Grass | 3 | Sochil → Jeonghye | kill 10 Small-Eyed Ghost 2, 5 Big-Eyed Ghost 3 | 450 EXP, 1 SP, 300 gold, armour 01_AA_B (lv 3) |
| JG_006 | Ash Beads | 3 | Jeonghye | collect 8 Ghost Ash (Small-Eyed 35%, Big-Eyed 50%) | 350 EXP, 1 SP, 300 gold, Ume Copper Earring |
| JG_007 | A Blade Worth Carrying (side) | 4 | Chulsan | collect 8 Old Weasel Claw (Old Weasel 45%) | 700 EXP, 1 SP, weapon/shield choice 01_C (lv 5) |
| JG_008 | The Stolen Seal | 5 | Jeonghye | reach the Old Tiger Shrine; kill 10 Weasel 5; collect 1 Torn Silk Pouch (Weasel 25%) | 1,400 EXP, 2 SP, 800 gold, Ume Copper Necklace, 10 HP Potion (S) |
| JG_009 | The Exorcist Beyond the Wall | 6 | Jeonghye → Miaoryeong | deliver Jeonghye's Letter to Miaoryeong | 600 EXP, 1 SP, 500 gold, 2 Return Scroll |
| JG_010 | Salt for the Swamp | 6 | Miaoryeong | kill 12 Water Ghost Slave 6; bring 5 HP Potion (S) (consumed) | 1,400 EXP, 2 SP, 700 gold, armour 01_SA_C |
| JG_011 | Drowned Lanterns | 7 | Miaoryeong | collect 8 Drowned Lantern (Water Ghost 40%) | 1,800 EXP, 3 SP, 800 gold, choice 15 HP or 15 MP Potion (S) |
| JG_012 | What the Water Remembers | 7 | Miaoryeong | use Spirit Salt at the Heart of the Swamp | 1,500 EXP, 3 SP, 800 gold, armour 01_FA_C and 01_HA_C (lv 8), 20 HP Potion (S) |
| JG_013 | Grave Matters | 9 | Miaoryeong → Kushyan | kill 10 Tomb Stone Ghost 8, 8 Broken Stone Ghost 8 | 6,000 EXP, 10 SP, 1,500 gold, Pear Copper Earring |
| JG_014 | Talismans of Bone | 10 | Kushyan | collect 6 Tiger-Bone Talisman (Stone Ghost 35%) | 3,600 EXP, 6 SP, 1,500 gold, weapon/shield choice 02_A |
| JG_S01 | A Letter from Afar (side) | 6 | Flora → Ishyak | deliver Flora's Letter | 700 EXP, 1 SP, 1,000 gold, 10 Vigor Herb |
| JG_S02 | Mrs Jang's Order (side) | 8 | Mrs Jang | collect 10 Weasel Pelt (Weasel 40%) | 3,950 EXP, 7 SP, 600 gold, armour 02_SA_A |
| JG_015 | Tracks in Yeoha's Forest | 10 | Gwakwi → Sonhyeon | reach the Robbers' Camp; kill 8 Yeoha 10, 8 Decayed Yeoha 10 | 5,400 EXP, 9 SP, 3,000 gold, armour 01_BA_C, Pear Copper Necklace |
| JG_016 | Cut the Supply Line | 11 | Sonhyeon | kill 15 Bandit Subordinate 11 | 10,500 EXP, 18 SP, 3,500 gold, weapon/shield choice 02_B |
| JG_017 | Hwajung's Missing Caravan | 12 | Hwajung | collect 6 Stolen Silk Bolt (Bandit Archer 35%, Subordinate 25%) | 8,500 EXP, 14 SP, 5,000 gold, Hades Silver Ring |
| JG_S03 | Juho's Wager (side) | 12 | Juho | kill 20 Bandit Archer 12 | 6,000 EXP, 10 SP, 2,500 gold, Hades Silver Earring |
| JG_018 | Fengil's Lost Patrol | 13 | Fengil | reach the ambushed camp; collect 4 Patrol Tag (Young Tiger 35%) | 18,500 EXP, 31 SP, 5,000 gold, armour 02_BA_A |
| JG_019 | Stripes on the Road | 14 | Gwakwi | kill 12 Tiger 14, 8 Young Tiger 13 | 15,000 EXP, 25 SP, 5,500 gold, weapon/shield choice 02_C |
| JG_S04 | Strings for a Zither (side) | 14 | So-Ok | collect 8 Tiger Whisker (Tiger 40%, Young Tiger 30%) | 8,500 EXP, 14 SP, 3,000 gold, Hades Silver Necklace |
| JG_020 | The Masked Buyer | 15 | Sochil → WalYoung | kill 10 Bandit Bowman 15; collect 1 Bandit Ledger (Bowman 20%) | 29,000 EXP, 48 SP, 7,000 gold, Inferno Silver Ring, Special Return Scroll |
| JG_021 | Storm the Stronghold | 16 | Sonhyeon | kill 20 Bandit 16; reach the Stronghold | 38,500 EXP, 64 SP, 8,000 gold, armour 03_AA_A |
| JG_022 | The Cipher of Bones | 17 | WalYoung → Miaoryeong | kill 12 Black Tiger 17 | 48,500 EXP, 81 SP, 9,000 gold, weapon/shield choice 03_A |
| JG_023 | Fangs for a Bell | 18 | Miaoryeong → Chulsan | talk to Jeonghye; collect 8 White Tiger Fang (White Tiger 35%) | 59,500 EXP, 99 SP, 10,000 gold, armour 02_BA_C, Mercury Gold Earring |
| JG_024 | The Bell-Maker's Price | 19 | Chulsan | collect 8 Chakji Iron Shard (Chakji Worker 40%) | 30,000 EXP, 50 SP, 10,000 gold, Venus Gold Ring |
| JG_025 | Night on Tiger Mountain (party) | 19 | Chulsan → Jeonghye | use the Binding Bell at the Tiger Mountain Shrine (spawns Tiger Girl); after it: kill Tiger Girl 20, collect the Jade Tiger Seal (100%) | 36,000 EXP, 60 SP, 15,000 gold, weapon/shield choice 03_B |
| JG_026 | Dawn over Jangan | 19 | Jeonghye → Hwangno | report | 6,000 EXP, 10 SP, 20,000 gold, Mercury Gold Necklace, armour 03_HA_A |
| JG_R01 | Grassland Patrol (daily) | 1-9 | Fengil | kill 20 of Mangyang / Small-Eyed / Big-Eyed Ghost / Old Weasel / Weasel | 5% of level EXP, 2 SP, 200 gold, 5 HP Herb |
| JG_R02 | Reeds for the Remedy (daily) | 6-14 | Yangyun | collect 10 Swamp Reed (Water Ghost Slave / Water Ghost 40%) | 4% of level EXP, 5 SP, 500 gold, 5 HP Potion (M) |
| JG_R03 | Bandit Bounty (daily) | 11-20 | Sonhyeon | kill 25 bandits of any rank | 5% of level EXP, 15 SP, 3,000 gold |
| JG_R04 | Pelts for the Lodge (daily) | 14-20 | Gwakwi | collect 10 Tiger Pelt (any tiger 35%) | 5% of level EXP, 15 SP, 2,500 gold, 5 Vigor Potion (M) |

Prerequisites [confirmed in the file]: 001 → 002 → {003, 004}; 001 → S05; 004 → 005 → 006 → 008 → 009 → 010 → 011 → 012 → 013 → 014 → 015 → 016 → {017, 018}; 018 → 019 → 020 → ... → 026. JG_003 and JG_017 are side branches of the main line: nothing requires them. Sides need only their level (JG_S05 also needs JG_001). Each daily unlocks with the quest that opens its hunting ground: R01 after JG_002, R02 after JG_010, R03 after JG_016, R04 after JG_019.

**Hint locations** [confirmed: distance from each hint to the nearest `nests.json` nest of each listed mob, scratch script]. Most hints sit on a nest of the objective's mob (0-67 m). Fact-check fixes:
- JG_017 and JG_S03 pointed at `LOC_BANDIT_TRAIL`, which has no Bandit Archer within 640 m. Both now use the new `LOC_ARCHER_CAMP` (-690, 1170), where archers are 15 m away and subordinates 35 m (region 164,90, "South-Tiger Mt.").
- JG_019, JG_S04 and JG_R04 pointed at `LOC_PATROL_AMBUSH`, which has no Tiger within 129 m. They now use the new `LOC_TIGER_SLOPE` (-1070, 220; Tiger 39 m, Young Tiger 80 m; "North-Tiger Mt."). JG_018 keeps the ambush camp.
- JG_S02 pointed at `LOC_EAST_GRASS`, where only Old Weasels (30 %) live: 10 / 0.3 ≈ 33 kills, over the 30-kill rule. It now uses `LOC_OLD_SHRINE` (Weasel 40 %: 25 kills).
- W4 CT playtest on jangan-fields (work/tmp/quests/check.ts, navmesh rules): JG_014 now drops only from Stone Ghosts (35 %), JG_024 only from Chakji Workers (40 %), JG_S02 only from Weasels (40 %). Three locations moved so that every daily mob has a reachable nest within 150 m of its hint: `LOC_EAST_GRASS` (572, 167) for JG_R01 and JG_007, `LOC_ARCHER_CAMP` (-1081, 1145) for JG_R03, JG_017 and JG_S03, `LOC_WHITE_TIGERS` (-1486, 521) for JG_R04 and JG_023. JG_025's kill and seal objectives hint at `LOC_TIGER_SHRINE`. The next line is the earlier fact-check, kept for history.
- NEWPLAYER playtest (apps/server/test/soak/newplayer.ts, a real-speed bot): "a nest within 150 m" still left five objectives whose minimap circle held none of their mobs, so a player searched the circle and found nothing. The rule is now that the nests the server spawns with centres at least 10 m inside the circle keep at least 6 of the objective's mobs alive at once (encounter kills excepted; apps/server/test/quests-hunting-grounds.test.ts). Five locations moved or grew: `LOC_SOUTH_GRASS` (167, 362) r90 (JG_005 Big-Eyed Ghosts: 0 → 10), `LOC_SWAMP_HEART` (-370, -400) r80 (JG_010 Water Ghost Slaves: 0 → 10; it is now the swamp north-east of Miaoryeong's hut, a 250 m walk from her instead of 720 m, which saves six long legs in JG_010-JG_012; JG_010's text says "north-west of town"), `LOC_QIN_GATE` (614, -626) r90 (JG_013 Tomb Stone Ghosts 4 → 8, Broken Stone Ghosts 0 → 10; JG_014 Stone Ghosts 5 → 10), `LOC_YEOHA_CAMP` (-723, -88) r60 (JG_015 Decayed Yeoha: 0 → 10), `LOC_TIGER_SLOPE` (-1075, 225) r90 (JG_019 Young Tigers: 0 → 8). Each stays in its zone, on open home ground, with a walkable route from the town spawn.
- PACE (the questline decisions 7-10 of docs/PLAYTEST.md §12, approved after the NEWPLAYER bot):
  - **Return Scrolls early:** JG_004 now also gives 2 Return Scrolls (`ITEM_ETC_SCROLL_RETURN_01`, 5,000 gold each in the shop); Hwangno says so. JG_009 still gives 2 more.
  - **Miaoryeong moved** from (-561.7, -274.2), 38 m from the centre of an aggressive Yeoha 10 camp (nest 2128, roam 70 m: she stood 32 m inside its circle), to (-410, -300) at the east end of the west river bridge, facing the road to town (yaw 1.571). The export cannot be edited, so the move is a repo override, `content/npcs.override.json` (§5.1). The spot is in the town spawn's walkable component; the nearest aggressive roam circle is 63 m away (the same Yeoha camp) and no nest roams over her (Mangyang 8 m, Decayed Yeoha 21 m). It is on the road from town to the swamp: 535 m from the town spawn (5 legs) and 109 m from `LOC_SWAMP_HEART`, which was 258 m. A pure 80 m south-east move is not possible, because it lands inside the same camp; every spot within about 115 m that clears the 25 m rule is north, west or across the river. JG_009, JG_010 and JG_015 name the bridge instead of her hut; JG_012 now says the tombs are east of her. **2026-10-05:** moved 17 m onto the bridge deck itself, (-419, -314, y 8.65), same facing: wave 12's plants put a large bush over the bank spot so she stood inside it; the nearest aggressive roam circle is still 61 m away. `quests-hunting-grounds.test.ts` checks that every quest NPC outside town stands at least 25 m outside every aggressive roam circle.
  - **Qin-Shi Tomb:** JG_013 is now level 9 and JG_014 level 10. Their mobs are 8-9, so they are at or below the quest level. EXP stays inside the §3.4 bands: JG_S02 moves 9 → 8 with 3,950 EXP (it fills level 8 and gives a level-9 shell before the tomb), JG_013 gets 6,000 EXP and JG_015 5,400. JG_012 now also gives a head piece (`ITEM_CH_{G}_{ARMOR}_01_HA_C`, lv 8) and 20 HP Recovery Potion (S). The tomb is a grid of 25 aggressive 5-packs (Broken Stone Ghost 8 and Stone Ghost 9, about 60 m apart), and no approach avoids them (a route probe that avoided aggressive roam circles still walked 326 m inside them). So the entrance pack 25 m from `LOC_QIN_GATE` (nest 5416, 5 Broken Stone Ghosts, a JG_013 target) is made non-aggressive in `content/nests.override.json`, and JG_013 tells the player to start with that salted pack and fight the others from a group's edge.
  - **Fengil's tip:** the new side quest JG_S05 "Dressed for the Road" (level 1, after JG_001) runs from Fengil to a talk with Mrs Jang, then turns in at Chulsan: 40 EXP, 1 SP and 300 gold, enough for a first cloth piece. Hwangno's JG_001 complete text tells the player to listen to Fengil (Fengil gives JG_001 but does not speak its complete text).
- Earlier (superseded by the line above): JG_014 lists Tomb Stone as a source, but Tomb Stones live in the "Chinese Tomb" zone about 1 km south-east of `LOC_QIN_GATE`. At the hint only Stone Ghosts drop talismans (6 / 0.3 = 20 kills). JG_024 lists Chakji, but they are about 550 m from `LOC_CHAKJI_ROAD`. Chakji Workers are at the hint (8 / 0.35 ≈ 23 kills). `LOC_EAST_GRASS` lies in the zone "Hill of Ye Mt.", not a grassland zone.

**Content rules the file follows** (and the validator warns about): quest mobs are at most 3 levels above the quest level (except the unique finale; dailies stay inside their level window, and the checker's only warnings are JG_R01 Weasel lv 5 and JG_R03 Bowman 15 / Bandit 16, which are allowed by that exception); reward items have `reqLevel ≤ quest level + 2`; a collect objective needs about 30 kills at most at its best source near the hint (count / chance; the worst is JG_R04 at 10 / 0.35 ≈ 29); every quest item a quest hands in is granted by `giveOnAccept`.

### 3.4 EXP balance (the math)

Target: quests give roughly 20-35 % of the EXP needed to reach 20. Levelling 1 → 20 takes Σ `levels[1..19].exp` = **1,124,480 EXP** [confirmed]. Each non-repeatable quest of level L gives a share of `levels[L].exp`, so that the quests of each level add up to about 30 % of that level from level 8 on (early levels are over-fed on purpose: it's the tutorial and costs little).

| Level | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| levels[L].exp | 118 | 470 | 1,058 | 1,880 | 2,938 | 5,640 | 9,048 | 13,160 | 17,978 | 23,500 | 34,898 | 47,940 | 62,628 | 78,960 | 96,938 | 127,840 | 161,798 | 198,810 | 238,878 |
| quest EXP at L | 220 | 320 | 800 | 700 | 1,400 | 2,700 | 3,300 | 3,950 | 6,000 | 9,000 | 10,500 | 14,500 | 18,500 | 23,500 | 29,000 | 38,500 | 48,500 | 59,500 | 72,000 |
| share | 186 % | 68 % | 76 % | 37 % | 48 % | 48 % | 36 % | 30 % | 33 % | 38 % | 30 % | 30 % | 30 % | 30 % | 30 % | 30 % | 30 % | 30 % | 30 % |

- **Total: 342,890 quest EXP = 30.5 % of 1,124,480.** The other ~70 % comes from kills; a same-level kill gives about 23.5 × L EXP, so level 19 → 20 still needs about 360 Chakji-level kills besides the quests.
- **Repeatables** give 4-5 % of the current level's EXP each, once a day. Their level windows overlap for at most three at once, so they add at most 14 % of a level per day (at level 14). They are the "catch-up" lever and sit outside the 30 %.
- **SP:** `sp = max(1, round(exp / 600))`, **576 SP** in total [confirmed]. Kill SP-EXP equals kill EXP (no mob has `spExp`, and `mobDied` uses `spExp ?? exp`), at 400 SP-EXP per SP. Quest EXP gives no SP-EXP. So if kills supply the other ~783,080 EXP to level 20, they give about 1,960 SP, and the quests add about +29 %. (The earlier "+20 % over ~2,800 SP" counted all 1,124,480 EXP as kill EXP.)
- **Gold:** 116,200 in total, about one tier of weapon plus armour upgrades beyond the reward items; the shops lane's prices stay meaningful.
- The finale's encounter adds 45,120 kill EXP (shared by the party).

### 3.5 Playability now

> Superseded (wave 4): the play export is `jangan-fields` (307 regions). Every quest NPC is placed (Miaoryeong included) and every objective mob has a reachable nest within 150 m of its hint [confirmed by work/tmp/quests/check.ts and apps/server/test/quests-content.test.ts]. The text below describes the 9-region town export.

Only Mangyang spawn inside the currently converted 9-region world [confirmed]. Today JG_001-JG_004 and the patrol daily (JG_R01, where Mangyang count) are playable, and so is the side quest JG_S01: Flora and Ishyak both stand in town and it only needs level 6. Miaoryeong is not placed today (§0), so the JG_009 → JG_013 chain stops at its first step even with stand-in nests. Everything else needs the wider world export: the fields lane (docs/FIELDS.md) covers the grassland, swamp, Ye Mountain, the tombs, Yeoha's Forest, the Tiger Mountains, the stronghold and the western ferry road. Every questline mob nest and every quest location lies inside regions x 156-174 × z 90-102, and FIELDS.md's playable set covers that span [confirmed from the nest positions; the `region` field matches `168 + floor(x/192)`, `97 + floor(-z/192)`]. Until that lands:
- a GM can place stand-in nests near town with the spawn editor (§5.2) to test later quests;
- `/api/quests` still serves the whole file, and quests whose mobs are never spawned are simply slow, not broken.

All reach and use locations (`LOC_OLD_SHRINE`, `LOC_SWAMP_HEART`, `LOC_YEOHA_CAMP`, `LOC_PATROL_AMBUSH`, `LOC_STRONGHOLD`, `LOC_TIGER_SHRINE`) sit within 1 m of a retail nest centre (spawnable ground) [confirmed position; walkability likely, to check in game with `tp`]. The hint-only locations are near nests but not on them.

---

## 4. Party

### 4.1 Model (`apps/server/src/party.ts`, runtime only: a restart dissolves parties)

```ts
interface Party {
  id: number                         // runtime id
  leader: number                     // characterId
  members: number[]                  // characterIds, join order (max PARTY_MAX = 8)
  exp: PartyExpMode                  // 'free' | 'share'
  items: PartyItemMode               // 'free' | 'share'
  rrIndex: number                    // round-robin cursor for 'share' loot
  offlineSince: Map<number, number>  // characterId -> ms (grace)
}
class PartyManager {
  byChar: Map<number, Party>; invites: Map<number /*target charId*/, { from: number; exp; items; expiresAt: number }>
  invite(p, target, opts): Result; respond(p, inviterEntity, accept): Result; leave(p): Result
  kick(p, charId): Result; setLeader(p, charId): Result; settings(p, exp?, items?): Result
  online(p): void; offline(charId, now): void; tick(now): void   // vitals, invite expiry, offline grace
  killShares(m, now): { shares: Map<playerId, { exp: number; spExp: number }>; credit: Set<playerId>; lootOwners: LootPlan }
}
```

**Rules**
- **Invite.** Invite a player you have been sent (`not_found`), not yourself (`invalid_target`), who is not in a party (`in_party`) and has no pending invite (`cooldown`). If you are in a party you must be its leader (`not_leader`), and it must have room (`party_full`). The invite expires after 30 s (`PARTY_INVITE_MS`); the inviter then gets `partyEvent 'expired'`. A new party takes the invite's `exp`/`items` modes (defaults `share`/`free`).
- **Respond.** Accept or decline the pending invite from `inviter` (`no_invite`). On accept the party is created if needed, and everyone gets `party`.
- **Leave.** You leave; a leaving leader passes the lead to the earliest-joined online member. A party left with one member is disbanded (`partyEvent 'disbanded'`, then `party: null`).
- **Kick** (leader only, not yourself), **leader transfer** (leader only, target online), **settings** (leader only).
- **Disconnect** marks the member offline (`entity: null`, `partyEvent 'offline'`). It is removed after `PARTY_OFFLINE_GRACE_MS` 120 s unless it enters the world again [rule].

### 4.2 EXP share (SRO-like; the exact vSRO formula is [unknown], this rule is ours)

For a kill with EXP E and SP-EXP S (`MobDef.exp × VARIANT_RULES[variant].exp × encounter.expMul`):

1. **Damage groups.** Each player with damage on the mob who is still in the world belongs to group g: its party, or itself when solo. D_g = the group's damage; E_g = E × D_g / ΣD (same for S).
2. **Solo, or party in `free` mode:** member i gets E_g × d_i / D_g. This is exactly today's `shareRewards`.
3. **Party in `share` mode:**
   - eligible M_g = members online, alive and within `PARTY_SHARE_RANGE` = 60 m (XZ) of the corpse, plus every alive damage dealer of g; n = |M_g|;
   - pool = E_g × (1 + 0.1 × (n − 1)) (party bonus: ×1.7 for 8 [rule]);
   - member i gets **pool × Lᵢ / Σ L_j** (weighted by character level).

   Example [computed]: levels 10, 10 and 12 kill a Yeoha (235 EXP) → pool 282 → 88, 88 and 106 EXP.
4. **Quest credit** (§1.5) = every alive damage dealer ∪ M_g of every party group (whatever the EXP mode).

`party` variant mobs (`VARIANT_RULES.party`: HP ×10, EXP ×5 [confirmed]) need no special casing.

### 4.3 Loot

The group with the most damage decides.
- **`free`** (or solo): owner = top damage dealer (today's rule). The item also carries `ownerParty`, so every member of that party may pick it up during the 30 s owner window.
- **`share`**: each dropped item is assigned round-robin to the next member of M_g (`rrIndex`); only that member may pick it up for 30 s, then anyone. The pickup rights follow the Items mode at the moment of the drop: a later mode switch changes nothing for items already on the ground (W4-fix). **Gold** in share mode is split evenly at pickup among the members within 60 m of the picker; the remainder goes to the picker.

`EntityState.ownerParty?` lets the client label an item "yours" for party members. `GroundItem` gets `ownerParty: number | null`, and `pickupProblem()` accepts owner or ownerParty.

### 4.4 Party chat

- `chat {text, channel: 'party'}` (a new optional key) goes to the online members as `chat {channel: 'party', fromId, from, text}` and pays the chat budget.
- The client maps a line starting with `#` to the party channel through the UX lane's `ChatBox.registerPrefix('#', send)` (docs/UX_GAPS.md C4; the client's own help line is "Party chat [#what you want to say]" [confirmed there]) and shows party lines in the party colour.
- Not in a party: `error bad_request` "You are not in a party." (chat is not an `actionResult` request).
- **Merge with the UX lane's whisper** (docs/UX_GAPS.md §5.1): the merged client shape is `{t: 'chat'; text: string; to?: string; channel?: 'local' | 'party'}`, and `to` together with `channel: 'party'` is `error bad_request`. UX plans a new `apps/server/src/chat.ts` called from `connection.ts case 'chat'`; party routing goes there if it lands first. Today `'local'` chat is world-wide (`world.broadcast`) [confirmed].

### 4.5 Client

- **`hud/party.ts` PartyFrame**, left side under the player frame, one row per member:
  - name and level; a crown for the leader; HP (red) and MP (blue) bars;
  - dimmed when offline or out of the 60 m share range; a skull when dead.
  - Left click targets the member when its entity is visible. Right click opens a menu: Whisper (later), Make leader and Kick (leader only), Leave (self).
  - A small header shows the modes ("EXP: Share · Items: Free") with a settings popover for the leader.
- **Invite.** A "Invite to party" button in the target frame for player targets (`hud/target.ts`), and the same entry on right-click of a player in the world. **P** (through the KeyMap, `hud/keys.ts`) toggles a party window with the same list plus the Leave button. The party and quest windows also register their buttons on the UX lane's MenuBar (`hud/menubar.ts` `register({id, art: 'mainpopup/main_sysbutton_party' | '..._quest', label, toggle, isOpen})`).
- **Forming a party (2026-10 playtest pass, retail `ifparty.txt` / `ifsetpartymode.txt`).** The P window has Invite (the selected player), Settings and Leave. An invitation that starts a party (target-window Invite, the window's Invite, or the retail chat commands `/party name` and `/InviteToParty name`; without a name, the current player target) first opens the party setting box: EXP Individual/Shared and Items Free-for-all/Shared, pre-set to the last choice (remembered per browser); cancelling it sends nothing. The leader's Settings (or a click on a mode line) opens the same box and sends one `partySettings` with what changed. `/LeaveTheParty` leaves, `/BanishFromParty name` kicks. There is still no right-click menu on players in the world (open question q37).
- **Invite popup** (`hud/party-invite.ts`): "{name} (Lv {level}) invites you to a party. EXP: {exp}. Items: {items}." with Accept and Decline and a 30 s countdown, dismissed on `partyEvent 'expired'`.
- **Minimap:** a marker source (`HudMinimap.addMarkerSource`) with members' `pos` from `partyVitals` (`mm_sign_party`, or a dot in the party colour before M2), drawn even outside the view range.
- **World labels:** party members' names in the party colour (`EntityView` class `party`; UX_GAPS §6 proposes `#9ae6ff` [unknown]).
- **i18n:** `party.*` keys (`party.invite`, `party.invited`, `party.accept`, `party.decline`, `party.leave`, `party.kick`, `party.makeLeader`, `party.mode.exp.free|share`, `party.mode.items.free|share`, `party.event.joined|left|kicked|leader|declined|expired|disbanded|offline|online|settings`, `party.full`, `party.offline`, `party.outOfRange`), and `chat.channel.party`.

---

## 5. GM content editors

Available to accounts with role `gm` or `admin` (`isStaff`). An optional `EDITOR_ROLE=admin` limits them to admins. **No role is ever changed**: nothing here writes `accounts.role`, and `apps/server/test/role-policy.test.ts` keeps passing (its static scan covers the new files automatically [confirmed: it walks `apps/server/src`]).

### 5.1 Override files (under `DATA_DIR/content/`)

| File | Format | Layered over |
|---|---|---|
| `nests.override.json` | `NestOverrideFile` (§6.4) | `OUT_DIR/data/nests.json` |
| `npcs.override.json` | `NpcOverrideFile` (§6.4) | `OUT_DIR/data/npcs.json` |
| `quests/<QUEST_ID>.json` | a `QuestFile` with one quest (plus the items and locations it adds) | `CONTENT_DIR/quests/*.json` |
| `history/<file>.<ISO time>.json` | the previous version, copied before each write (last 100 per file) | — |

- **Writes** are atomic: write `x.tmp`, fsync, rename. Every file carries `rev` (incremented per write) and `updatedAt`.
- **Layering at load** (`gamedata.ts` for nests/NPCs, `quests/book.ts` for quests): apply `remove`, then `patch` by id, then `add`.
  - Authored nests get ids ≥ 1,000,000 and `provenance: 'authored'`.
  - Authored NPCs have codes `NPCX_*` with a `base` NPC code for the model.
  - Invalid override records are skipped with a log line, never fatal.
- **Repo overrides** (PACE): `CONTENT_DIR/nests.override.json` and `CONTENT_DIR/npcs.override.json` (the repo's `content/`, committed and deployed with the code) use the same formats. `layerRepoOverrides` (`editors/overrides.ts`, called by `game.ts` just before `layerContentOverrides`) reads only their `patch` records, plus `remove` for nests. Authored `add` records are logged and ignored. The result becomes the base that the GM files layer over, so the editors show these changes as the export and a GM can still move or re-patch the same NPC or nest. Today they hold Miaoryeong's spot and the sleeping Qin-Shi entrance pack (§3.3). `quests-check.ts` applies the NPC patches too.
- **Promotion to the repo:** the owner CLI `pnpm content export [--out content/]` (`apps/server/src/cli/content.ts`, optional lane E2) writes the merged overrides as reviewable JSON (for example `content/spawns/jangan.json` and `content/quests/<id>.json`), ready to commit. Nothing in game writes the repo.

### 5.2 Spawn editor (gm commands, fit in 1 KB frames)

New `COMMANDS` entries in `gm.ts`. They use the same role check, audit (`gm_audit` rows, command `nest`), 5/s budget and slash form (`/nest add MOB_CH_GYO 10 40`). Every write updates `nests.override.json` and the live spawner at once.

| Command | Effect | `data` |
|---|---|---|
| `nest near [radius=150]` | Nests with a centre within radius of you | `{nests: GmNestInfo[]}` |
| `nest add <mob> [count=5] [radius=30] [respawnSec=30]` | New authored nest at your position (spawn radius = radius; tactics copied from the mob's first retail nest, else passive with sight 10 m and leash 50 m) | `{nest}` |
| `nest move <id>` | Moves the centre to your position | `{nest}` |
| `nest set <id> <field> <value>` | field: `mob`, `count` (1-50; all enabled authored nests together hold at most `NEST_AUTHORED_MOBS_MAX` = 1,000 monsters, checked by `add`, `set` and at load), `radius` (2-200), `spawnradius`, `respawn` (`min-max` s, 1-86,400), `aggressive` (on/off), `champion` (0-100), `enabled` (on/off) | `{nest}` |
| `nest remove <id>` | Authored: deleted. Exported: added to `remove` | `{id}` |
| `nest undo` | Restores the latest history copy of the file | `{rev}` |

**Live effect** (new `Spawner` methods, pure bookkeeping as today):
- `addNest(def)` fills it at once.
- `updateNest(id, patch)`: a new count spawns the difference or despawns idle extras (no loot); a new mob despawns and refills; radius/tactics apply to living mobs.
- `removeNest(id)` despawns its mobs.
- Nest respawn timers are unaffected elsewhere. The spawner's `inWorld` check applies to added nests (`ok: false` "not on open ground").

**Live preview** (client, lane F): while the **Spawns** tab is open, the GM window polls `nest near` every 2 s and draws each nest as two ground rings (roam radius, spawn radius) with a floating label "MOB name ×count (alive)". The selected nest is highlighted. Buttons: Add here, Move here, Set fields (a small form), Remove. The mob picker reuses `GM_QUICK_MOBS` and the mobs catalog (search by name or code).

### 5.3 NPC editor

| Command | Effect | `data` |
|---|---|---|
| `npc near [radius=60]` | NPCs near you | `{npcs: GmNpcInfo[]}` |
| `npc add <base code> <name...>` | New authored NPC `NPCX_<n>` at your position and yaw, looking like `base` (any NPC code in npcs.json) | `{npc}` |
| `npc move <code>` / `npc face <code>` | To your position / to your yaw | `{npc}` |
| `npc rename <code> <name...>` | Display name (≤ 32 code points, cleaned) | `{npc}` |
| `npc shop <code> <shop id \| none>` | Attaches a `shops.json` shop | `{npc}` |
| `npc remove <code>` | Authored: deleted. Exported: `hidden: true` | `{code}` |

- The server `Npc` entity gains `model` (base code) and keeps `code` as its identity. `World.state()` sends `model: base` and, only when they differ, `npc: code` (new optional `EntityState.npc`).
- Spawn and despawn follow interest management, as for any entity.
- Quest `giver`/`turnIn` may name `NPCX_*` codes. Removing an NPC that a quest uses warns in `gmResult` but is allowed (those quests become unobtainable until fixed; the quest editor shows it).

### 5.4 Quest editor (HTTP, because a quest is larger than 1 KB)

Routes in `game.ts` → `apps/server/src/editors/quest-api.ts`.
- **Auth:** `Authorization: Bearer <session token>`; the role is re-read from the DB on every call; staff only (403 `forbidden`, audited as denied). The same origin check as `/api/*`.
- **Limits:** bodies ≤ 32 KB on `/api/gm/*` only (today one `MAX_BODY_BYTES` = 4096 applies to every route, so `readJson(req)` gains a limit argument); 2 req/s (burst 10) per account.
- **CORS:** when `CORS_ORIGIN` is set, `game.ts` answers preflights with `Access-Control-Allow-Methods: GET, POST, OPTIONS` [confirmed]. Add `PUT, DELETE`, or the dev client on another origin cannot call PUT/DELETE.

| Route | Body → answer | Effect |
|---|---|---|
| `GET /api/quests` (any logged-in account) | → `ApiQuestCatalog` (ETag `"q<rev>"`) | The merged catalog the client uses |
| `GET /api/gm/quests` | → `ApiGmQuestList` | Every quest with its source (`repo`/`override`), rev, disabled flag and issues |
| `POST /api/gm/quests/validate` | `ApiGmQuestPut` → `ApiGmQuestResult` | Validation only (shared validator + server refs) |
| `PUT /api/gm/quests/:id` | `ApiGmQuestPut` → `ApiGmQuestResult` (422 with issues, 409 when `baseRev` is stale) | Writes `quests/<id>.json`, hot-reloads, broadcasts `contentChanged` |
| `DELETE /api/gm/quests/:id` | → `ApiGmQuestResult` | Removes the override: the repo version returns, or the quest disappears |
| `POST /api/gm/quests/:id/disable` / `enable` | → `ApiGmQuestResult` | Writes `disabled: true/false` into the override |

Every write adds a `gm_audit` row: command `questput` / `questdel` / `questoff` / `queston`, args `[id, String(rev)]`, result "ok" or the first error.

**Hot reload** (`QuestBook.replace(def)`):
1. Rebuild the indexes, bump the catalog `rev`, and send `contentChanged {kind: 'quests', rev}` to everyone in the world.
2. Re-map active states whose `rev` changed: keep the counts of objective ids that still exist (clamped to the new counts), drop the others, recompute `status`, and remove quest items no longer referenced by the quest. Affected players get `questUpdate {event: 'changed'}`.
3. A removed or disabled quest stays in logs as "withdrawn" (§1.3).

**Client (lane F), a Quest Editor window** (`gm/editors/quest-editor.ts`, opened from a GM window tab "Quests"):
- Left: a quest list with filters (chapter, source, issues).
- Right: a form over the schema:
  - identity and level fields; giver/turn-in pickers (NPC search, or "pick the NPC I'm targeting");
  - the prerequisites multi-select;
  - an **objectives list** (add/remove/reorder; a type selector swaps the fields; mob and item pickers with search; the location picker offers "use my position" (radius field) or an existing `LOC_*`; `after` is a dropdown of the earlier objective ids);
  - a **rewards** editor (EXP with a "suggest" button that fills 15 % of `levels[level].exp`; SP from EXP/600; items and choice with a gender/armour preview of `{G}`/`{ARMOR}`);
  - three dialog text areas with a live preview in the NPC dialog page style.
- Buttons: **Validate** (POST validate; issues are listed and clicking one focuses the field), **Save & reload** (PUT), **Revert to repo** (DELETE), **Disable/Enable**.
- New quest items and locations are edited inline and sent in the PUT body's `items`/`locations`.

---

### 5.5 Wave 11: conditional NPC lines (lane U-Q; docs/UNIQUES.md §3.10)

A quest file may carry `lines` (at most 64): `{id, npc, text, textNoArea?, when}`. While `when` holds, the NPC's
`npcDialog` carries the line after its greeting (`npcDialog.lines`, at most 8 lines of at most 300 characters). The
only condition today is `{uniqueAlive: <mob code>}` (the uniques module says that field unique is alive; never with
`UNIQUES=off`). `{area}` in `text` is the unique's area name ("North-Tiger Mt."); without an area, `textNoArea` is shown,
or the line is skipped. `content/quests/jangan.json` gives Gwakwi and Jeonghye one rumour line each about Tiger Girl.
The quest validator checks the id rule, the NPC code, the text bound and the condition; the engine evaluates the lines
on each `npcTalk` (no client cache, no new message).

## 6. Protocol additions (v1, additive)

### 6.1 Shared quest content types (`packages/shared/src/quests.ts`, new)

```ts
export const QUEST_FILE_SCHEMA = 1
/** Quest ids: JG_001. Quest items: QITEM_*. Locations: LOC_*. Authored NPCs: NPCX_*. Objective ids: lower-case. */
export const QUEST_ID = /^[A-Z][A-Z0-9_]{1,63}$/
export const QUEST_ITEM_CODE = /^QITEM_[A-Z0-9_]{1,64}$/
export const QUEST_LOCATION_ID = /^LOC_[A-Z0-9_]{1,64}$/
export const AUTHORED_NPC_CODE = /^NPCX_[A-Z0-9_]{1,64}$/
export const OBJECTIVE_ID = /^[a-z][a-z0-9_]{0,23}$/
export const MAX_ACTIVE_QUESTS = 10
export const MAX_QUEST_OBJECTIVES = 8
export const MAX_REWARD_CHOICES = 8
export const MAX_QUEST_TEXT = 1200
export const MAX_QUEST_TITLE = 60

export type QuestKind = 'main' | 'side' | 'repeatable'
export type ArmorClassToken = 'CLOTHES' | 'LIGHT' | 'HEAVY'

export interface QuestFile {
  schema: typeof QUEST_FILE_SCHEMA
  kind: 'quests'
  /** Questline id = file stem ('jangan'); override files use the quest id. */
  id: string
  title: string
  world: string
  notes?: string
  items: QuestItemDef[]
  locations: QuestLocation[]
  quests: QuestDef[]
  /** Server-assigned on override files. */
  rev?: number
  updatedAt?: string
}

export interface QuestItemDef {
  code: string
  name: string
  description?: string
  /** A client item code whose icon is borrowed (ITEM_QNO_CH_*); absent = generic quest icon. */
  iconItem?: string
  /** Default 99. */
  maxStack?: number
}

export interface QuestLocation {
  id: string
  name: string
  /** glTF metres, world manifest frame. */
  x: number
  z: number
  /** Metres, 5..200. */
  radius: number
}

export interface QuestDef {
  id: string
  title: string
  chapter?: string
  kind: QuestKind
  /** Offered from this character level (1..LEVEL_CAP). */
  level: number
  /** Not offered above this level. */
  maxLevel?: number
  /** NPC identity codes (NpcDef.code or NPCX_*). */
  giver: string
  turnIn: string
  requires?: { quests?: string[] }
  /** Only for kind 'repeatable'. */
  repeat?: { reset: 'daily' } | { cooldownSec: number }
  /** Group recommended; also shares useItem completion with party members within 60 m. */
  party?: boolean
  summary: string
  giveOnAccept?: QuestItemGrant[]
  /** 0..MAX_QUEST_OBJECTIVES; [] = report to turnIn. */
  objectives: QuestObjective[]
  rewards: QuestRewards
  dialog: QuestDialog
  disabled?: boolean
  /** Server-assigned edit revision. */
  rev?: number
}

export interface QuestItemGrant {
  item: string
  count: number
}

interface ObjectiveBase {
  id: string
  /** Log/tracker line; default generated from the type (i18n quest.objective.*). */
  label?: string
  /** Location id drawn on the minimap as a hint. */
  hint?: string
  /** Objective id that must be complete before this one counts. */
  after?: string
}

export type QuestObjective =
  | (ObjectiveBase & { type: 'kill'; mobs: string[]; count: number })
  | (ObjectiveBase & { type: 'collect'; item: string; count: number; from: { mob: string; chance: number }[] })
  | (ObjectiveBase & { type: 'talk'; npc: string; text: string })
  | (ObjectiveBase & { type: 'deliver'; npc: string; item: string; count: number; text: string })
  | (ObjectiveBase & { type: 'have'; item: string; count: number; consume?: boolean })
  | (ObjectiveBase & { type: 'reach'; location: string })
  | (ObjectiveBase & { type: 'useItem'; item: string; location: string; consume?: boolean; text?: string; encounter?: QuestEncounter })

export type QuestObjectiveType = QuestObjective['type']

export interface QuestEncounter {
  mob: string
  count: number
  /** Multipliers over MobDef × VARIANT_RULES (defaults 1). */
  hpMul?: number
  expMul?: number
  attackMul?: number
  /** Unkilled encounter mobs despawn after this. */
  despawnSec: number
  /** Before the item can summon again after a despawn (default 60). */
  cooldownSec?: number
}

export interface QuestRewards {
  exp: number
  /** Extra EXP: this percent of levels[character level].exp at turn-in (repeatables). */
  expPctOfLevel?: number
  /** Skill points (granted as sp × 400 SP-EXP). */
  sp: number
  gold: number
  items?: RewardItem[]
  /** Pick exactly one (questTurnIn.choice). */
  choice?: RewardItem[]
}

export interface RewardItem {
  /** ItemDef code; may contain {G} and {ARMOR} (expandRewardCode). */
  item: string
  /** Default 1. */
  count?: number
}

export interface QuestDialog {
  offer: string
  progress: string
  complete: string
}

export interface QuestRefs {
  mobs: ReadonlySet<string>
  items: ReadonlySet<string>
  npcs: ReadonlySet<string>
  levelCap: number
}

export interface QuestIssue {
  path: string
  message: string
  severity: 'error' | 'warning'
}

/** Structural + reference validation (refs optional: the client editor has only some). Never throws. */
export declare function validateQuestFile(json: unknown, refs?: QuestRefs): { file: QuestFile | null; issues: QuestIssue[] }
export declare function validateQuestDef(def: unknown, scope: { items: ReadonlySet<string>; locations: ReadonlySet<string>; quests: ReadonlySet<string> }, refs?: QuestRefs): QuestIssue[]
/** 'ITEM_CH_{G}_{ARMOR}_02_BA_A' -> 'ITEM_CH_W_LIGHT_02_BA_A'. */
export declare function expandRewardCode(code: string, who: { gender: 'male' | 'female'; armor: ArmorClassToken }): string
/** Every expansion of a templated code (6 for {G}+{ARMOR}), for validation. */
export declare function rewardCodeVariants(code: string): string[]
/** EXP a turn-in gives at `level`. */
export declare function questRewardExp(r: QuestRewards, level: number, expToNext: (level: number) => number): number
```

### 6.2 Messages (`packages/shared/src/protocol.ts`)

```ts
// ---- client -> server (additions to ClientMessage) ----
  /** Quests (docs/QUESTS.md §1). Every one is answered by exactly one actionResult. */
  | { t: 'questAccept'; npc: number; quest: string }
  | { t: 'questTurnIn'; npc: number; quest: string; choice?: number }
  | { t: 'questAbandon'; quest: string }
  /** Completes a talk/deliver objective at that NPC. */
  | { t: 'questTalk'; npc: number; quest: string; objective: string }
  /** Uses the quest item of a useItem objective at your position. */
  | { t: 'questUseItem'; quest: string; objective: string }
  /** Party (docs/QUESTS.md §4). `exp`/`items` set the modes when this invite creates the party. */
  | { t: 'partyInvite'; target: number; exp?: PartyExpMode; items?: PartyItemMode }
  | { t: 'partyRespond'; inviter: number; accept: boolean }
  | { t: 'partyLeave' }
  | { t: 'partyKick'; member: number }
  | { t: 'partyLeader'; member: number }
  | { t: 'partySettings'; exp?: PartyExpMode; items?: PartyItemMode }
// `chat` gains an optional key (absent = 'local'):
  | { t: 'chat'; text: string; channel?: 'local' | 'party' }

// ---- server -> client (additions to ServerMessage) ----
  /** Own quest log, after `inventory` (and the skills lane's `skills`) in the enter-world sequence. */
  | { t: 'quests'; active: QuestProgress[]; done: QuestDoneEntry[]; rev: number }
  /** One quest changed. progress null = no longer active (completed/abandoned); `done` set on completion. */
  | { t: 'questUpdate'; quest: string; event: QuestEvent; progress: QuestProgress | null; done?: QuestDoneEntry; objective?: string }
  /** Authored content changed (GM editors): refetch /api/quests, or expect spawn/despawn for nests/NPCs. */
  | { t: 'contentChanged'; kind: ContentChangeKind; rev: number }
  | { t: 'partyInvited'; inviter: number; name: string; level: number; exp: PartyExpMode; items: PartyItemMode; expiresInMs: number }
  /** Full party state on any membership/leader/mode change; null = you are not in a party. */
  | { t: 'party'; party: PartyState | null }
  /** Changed member vitals, at most every 500 ms (positions at 1 Hz). */
  | { t: 'partyVitals'; members: PartyVitals[] }
  | { t: 'partyEvent'; event: PartyEventKind; name: string }
// `chat.channel` gains 'party' (the UX lane adds 'whisper'): 'local' | 'system' | 'whisper' | 'party'.

// ---- data ----
export interface QuestProgress {
  quest: string
  /** QuestDef.rev the counts were made for. */
  rev: number
  status: 'active' | 'ready'
  /** objective id -> count (collect: quest items held; talk/reach/useItem: 0 or 1). */
  counts: Record<string, number>
  /** This quest's quest items. */
  items: { code: string; count: number }[]
  acceptedAt: number
  /** Server ms an encounter of this quest despawns, while one lives. */
  encounterUntil?: number
}
export interface QuestDoneEntry {
  quest: string
  times: number
  lastAt: number
  /** Repeatables: server ms it can be taken again. */
  availableAt?: number
}
export type QuestEvent = 'accepted' | 'progress' | 'objective' | 'ready' | 'completed' | 'abandoned' | 'changed'
export const QUEST_EVENTS: readonly QuestEvent[] = ['accepted', 'progress', 'objective', 'ready', 'completed', 'abandoned', 'changed']
export type ContentChangeKind = 'quests' | 'nests' | 'npcs'

export type PartyExpMode = 'free' | 'share'
export type PartyItemMode = 'free' | 'share'
export const PARTY_MODES: readonly PartyExpMode[] = ['free', 'share']
export const PARTY_MAX = 8
/** Metres (XZ) from a kill within which party members share EXP, quest credit and 'share' loot. */
export const PARTY_SHARE_RANGE = 60
export const PARTY_INVITE_MS = 30_000
export interface PartyState {
  id: number
  /** characterId of the leader. */
  leader: number
  exp: PartyExpMode
  items: PartyItemMode
  members: PartyMember[]
}
export interface PartyMember {
  characterId: number
  name: string
  model: string
  level: number
  /** Runtime entity id, null while offline. */
  entity: number | null
  hp: number
  maxHp: number
  mp: number
  maxMp: number
  dead?: boolean
  /** [x, z] metres; absent while offline. */
  pos?: [number, number]
}
export interface PartyVitals {
  characterId: number
  entity?: number | null
  level?: number
  hp?: number
  maxHp?: number
  mp?: number
  maxMp?: number
  dead?: boolean
  pos?: [number, number]
}
export type PartyEventKind = 'joined' | 'left' | 'kicked' | 'leader' | 'declined' | 'expired' | 'disbanded' | 'offline' | 'online' | 'settings'

// ---- extensions of existing shapes ----
// EntityState: npc?: string        authored NPC identity (NPCX_*) when it differs from `model` (the base look)
//              ownerParty?: number items: members of this party share the owner window
// StatGain:    quest?: string      the EXP came from turning in this quest
// GameplayRequest += 'questAccept' | 'questTurnIn' | 'questAbandon' | 'questTalk' | 'questUseItem'
//                  | 'partyInvite' | 'partyRespond' | 'partyLeave' | 'partyKick' | 'partyLeader' | 'partySettings'
//   (GAMEPLAY_REQUESTS extended the same way, so connection.ts routes them to gameplay with no new switch case)

// ---- GM editor data (gmResult.data of `nest`/`npc` commands) ----
export interface GmNestInfo {
  id: number; mob: string; mobName: string; level: number
  x: number; z: number; radius: number; spawnRadius: number
  count: number; alive: number; respawnSec: [number, number]
  aggressive: boolean; enabled: boolean
  source: 'export' | 'patched' | 'authored'
}
export interface GmNpcInfo {
  code: string; base: string; name: string; x: number; z: number; yaw: number
  entity: number | null; shop?: string; hidden?: boolean
  source: 'export' | 'patched' | 'authored'
}

// ---- HTTP (quest catalog and editor) ----
export interface ApiQuestCatalog { rev: number; files: QuestFile[] }
export interface ApiGmQuestList {
  rev: number
  quests: { id: string; title: string; file: string; source: 'repo' | 'override'; rev: number; disabled: boolean; issues: QuestIssue[] }[]
}
export interface ApiGmQuestPut { quest: QuestDef; items?: QuestItemDef[]; locations?: QuestLocation[]; baseRev?: number }
export interface ApiGmQuestResult { ok: boolean; rev: number; issues: QuestIssue[] }
```

### 6.3 Validators, reasons and rate limits

**`validate.ts`, client → server** (strict key sets; `?` optional):

| t | required | optional | bounds |
|---|---|---|---|
| `questAccept` | `npc`, `quest` | — | `npc` int 0..MAX_ID; `quest` ≤ 64 chars matching `QUEST_ID` |
| `questTurnIn` | `npc`, `quest` | `choice` | `choice` int 0..`MAX_REWARD_CHOICES − 1` |
| `questAbandon` | `quest` | — | |
| `questTalk` | `npc`, `quest`, `objective` | — | `objective` matches `OBJECTIVE_ID` |
| `questUseItem` | `quest`, `objective` | — | |
| `partyInvite` | `target` | `exp`, `items` | `target` int 0..MAX_ID; modes ∈ `PARTY_MODES` |
| `partyRespond` | `inviter`, `accept` | — | `inviter` = the inviter's **entity** id from `partyInvited` (int 0..MAX_ID, like `partyInvite.target`); `accept` boolean |
| `partyLeave` | — | — | |
| `partyKick` / `partyLeader` | `member` | — | characterId int 1..MAX_SAFE_INTEGER |
| `partySettings` | — | `exp`, `items` | at least one present |
| `chat` (extended) | `text` | `channel` | `'local' \| 'party'` |

**Server → client** parsers for every new message check every field the client uses and drop unknown keys (`questUpdate.progress` may be `null`; `counts` values are ints ≥ 0; `party` may be `null`).

**`ActionFailReason` +=** `'quest_log_full' | 'quest_active' | 'quest_done' | 'not_complete' | 'choice_required' | 'wrong_place' | 'not_in_party' | 'not_leader' | 'party_full' | 'in_party' | 'no_invite'` (and `ACTION_FAIL_REASONS`). Reused: `not_found`, `too_far`, `requirements`, `cooldown`, `inventory_full`, `invalid_slot`, `invalid_target`, `dead`, `rate_limited`.

**`CLIENT_RATE_LIMITS` +=**

| t | perSecond | burst |
|---|---|---|
| `questAccept`, `questTurnIn`, `questTalk` | 5 | 10 |
| `questAbandon`, `questUseItem` | 2 | 5 |
| `partyInvite`, `partyLeave` | 1 | 3 |
| `partyRespond`, `partyKick`, `partyLeader`, `partySettings` | 2 | 5 |

All of them stay under the global 20 msg/s. Party chat pays the chat budget (1/s, burst 5). GM editor commands pay the GM budget (5/s, burst 20). `/api/gm/*` has its own per-account budget of 2/s (burst 10).

**Enter-world sequence:** `worldEnter` → `stats` → `inventory` → `skills` (skills lane) → `quests` → `party` (only when in one).

### 6.4 Override file formats (server-only, `apps/server/src/editors/overrides.ts`)

```ts
export interface NestOverrideFile {
  schema: 1; kind: 'nests-override'; world: string; rev: number; updatedAt: string
  /** Authored nests: NestDef with id >= 1_000_000, provenance 'authored', source {file, by, at}. */
  add: AuthoredNest[]
  patch: { id: number; mob?: string; x?: number; z?: number; y?: number; count?: number; radius?: number; spawnRadius?: number;
           respawnSec?: [number, number]; aggressive?: boolean; championPct?: number; enabled?: boolean }[]
  remove: number[]
}
export type AuthoredNest = Omit<NestDef, 'provenance' | 'source'> & {
  provenance: 'authored'
  source: { file: 'nests.override.json'; by: string /* account */; at: string /* ISO */ }
}
export interface NpcOverrideFile {
  schema: 1; kind: 'npcs-override'; world: string; rev: number; updatedAt: string
  add: { code: string /* NPCX_* */; base: string; name: string; x: number; z: number; y?: number; yaw: number; shop?: string }[]
  patch: { code: string; name?: string; x?: number; z?: number; y?: number; yaw?: number; shop?: string | null; hidden?: boolean }[]
}
```

`NestDef.provenance` widens from `typeof PROVENANCE_PORT` to `Provenance` (which already includes `'authored'` [confirmed, `content.ts`]); readers ignore it. **But** `content-check.ts checkNestDef` enforces `oneOf('provenance', [PROVENANCE_PORT])` [confirmed]. So either authored nests are validated by `editors/overrides.ts` with their own check (preferred: `nests.json` stays port-only), or `checkNestDef` takes an option that allows `'authored'`.

---

## 7. Build plan

Lanes can run in parallel after lane A, which is small and lands first (or each lane adds its own block of A under a clearly marked comment, merging protocol.ts/validate.ts hunks in order). "Hook" means a few lines in a shared file; everything else is a new file owned by the lane.

### Lane A: shared contracts (first, ~1 h)

- **Owns:** `packages/shared/src/quests.ts` (new: §6.1 types, validators, `expandRewardCode`, `rewardCodeVariants`, `questRewardExp`); `packages/shared/test/quests.test.ts` (validator units; loads `content/quests/jangan.json` and requires 0 errors structurally; with `work/out/data` present also against refs, else skipped); `packages/shared/test/protocol-quests.test.ts` (every new client frame: valid, missing key, extra key, out-of-range; server frames round trip).
- **Hooks:**
  - `protocol.ts`: union members, the §6.2 types and constants, `GAMEPLAY_REQUESTS`, `ACTION_FAIL_REASONS`, `CLIENT_RATE_LIMITS`, chat channel, `EntityState.npc`/`ownerParty`, `StatGain.quest`;
  - `validate.ts`: `CLIENT_KEYS`, `CLIENT_OPTIONAL_KEYS`, the switch cases on both sides, `entity()` and `statGain()` extras;
  - `index.ts` exports `quests.ts`;
  - `content.ts`: `NestDef.provenance: Provenance` (leave `content-check.ts checkNestDef` port-only; see §6.4).
- **Check:** `pnpm vitest run packages/shared/test` and `pnpm typecheck` are green.

### Lane B: quest engine (server)

- **Owns:**
  - `apps/server/src/quests/book.ts`: load `CONTENT_DIR/quests/*.json` + `DATA_DIR/content/quests/*.json`, validate with GameData refs, indexes, `replace()`/`remove()` for hot reload, `catalog()` for `/api/quests`;
  - `engine.ts` (`QuestEngine`: §1.3, §1.5, §1.6);
  - `store.ts` (`QUEST_MIGRATION`, `questStore(db)`);
  - `rewards.ts` (turn-in transaction, token expansion with the character's gender/armour);
  - `encounter.ts` (spawn, ownership, despawn).
- **Hooks:**
  - `db.ts`: append `QUEST_MIGRATION` to `MIGRATIONS`; add `quests: questStore(db)` to the returned store;
  - `gameplay.ts`:
    - constructor: `this.quests = new QuestEngine(this)`;
    - `request()` switch: the 5 quest cases → `this.quests.request(p, msg, answer)`;
    - `mobDied()`: one line `this.quests.onKill(m, credit, now)` after the shares (credit = the `shares` keys until lane D);
    - `tickPlayer()`: `this.quests.onMove(p, now)` after the `if (p.dead) return` line;
    - `sendEnter()`: `this.quests.enter(p)`; `forget()`: `this.quests.leave(p)`;
    - `afterInventory()`: `this.quests.onInventory(p)`;
    - `createMob(..., tuning?)`: the encounter multipliers;
    - `reward()` split into compute + `applyProgress(p, next, levels, gain)` (announce), so a turn-in can save progress inside `inventoryTx`'s `extra` and announce after the commit (§1.3); `gain.quest` set for quest EXP;
    - `afterInventory()` made callable by the engine (it is `private` today; the shops lane needs the same change, so land it once);
    - `tick()`: encounter despawn;
  - `world.ts`: `Mob.encounter?`; `Npc.model?`; `state()` emits `npc` when `model !== code`;
  - `gm.ts`: the `spawn` command's alive counter skips `m.encounter` mobs (one condition);
  - `config.ts`: `CONTENT_DIR`, `QUEST_DAILY_RESET_HOUR`, `QUEST_CAP_EXP_TO_SPEXP`;
  - `game.ts`: `GET /api/quests` (Bearer);
  - `npc.ts` (shops lane file, when it exists): push `'quest'` into `services` when `this.gameplay.quests.hasTopics(p, npc.code)` (the engine method returns true for any offered, ready, in-progress or talk/deliver topic).
- **Tests:**
  - `apps/server/test/quests.test.ts` (synthetic fixtures in `test/fixtures.ts`): accept reasons; kill counting with `after`; drop rolls with a seeded rng; talk/deliver; reach via moves; useItem range and encounter spawn, despawn and re-summon; `have` recount; turn-in transaction (choice required, `inventory_full` leaves everything unchanged, `{G}`/`{ARMOR}` expansion for a woman in protector gear); daily reset at 04:00; abandon removes quest items; hot-reload re-map keeps matching objective counts; level-cap EXP → SP-EXP;
  - `apps/server/test/quests-e2e.test.ts` (real sockets: enter → `quests`, accept → kill via GM `spawn` + `attack` → `questUpdate` → turn-in → `statsDelta.gain.quest`);
  - `apps/server/test/quests-content.test.ts` (loads `content/quests/jangan.json` against `work/out/data`; skips when missing);
  - `role-policy.test.ts` stays green.
- **How to check:** `pnpm vitest run apps/server/test/quests*.test.ts`. Then in game (needs lane C's dialog and the shops lane's talk window; before those, the e2e test is the check): make a new character, walk to Soldier Fengil north of the spawn and accept "Welcome to Jangan"; talk to Chief Hwangno and complete it (EXP and 5 herbs arrive); accept "Pests in the Millet", kill 8 Mangyang south of town, turn in. `/setlevel <you> 19` plus `/item`/`tp` let a GM jump ahead.

### Lane C: quest client UI

- **Owns:** `apps/game/src/quests/catalog.ts`, `state.ts`, `markers.ts`, `dialog.ts` (the §2.3 section and its adapter), `dialog-panel.ts` (the quest pages), `log.ts` (Q/L window), `tracker.ts`, `format.ts` (objective lines, reward views, `{name}` fill), `quests.css` (or a block in `style.css`), `apps/game/src/i18n/en-quests.ts`.
- **Hooks:**
  - `hud/index.ts`: create QuestState, QuestLog and Tracker; keys Q and L through the KeyMap (`hud/keys.ts`; a direct listener if the KeyMap has not landed); MenuBar button; `OWN_REQUESTS` += quest requests;
  - `screens/world.ts`: pass entities to `markers.ts` on spawn/despawn/level change; `contentChanged` → `catalog.refresh()`;
  - `world/entities.ts`: `setQuestMark(mark)` + one span;
  - `world/jangan/minimap.ts`: `addMarkerSource(questMarkers)` and the optional `radius` on markers;
  - `hud/npc-dialog.ts` (shops lane): set `onQuest` (or `addTalkOption`) to open the quest section;
  - `apps/server/src/npc.ts` (shops lane, done by lane B): `'quest'` in `services` when `gameplay.quests.hasTopics(p, code)`;
  - `i18n/en.ts`: one line `...enQuests,`;
  - message builders: quest intents live in a quest-owned module (`quests/intents.ts`, same style as `hud/intents.ts`: each builder returns a message that passes `parseClientMessage`, or null). Nothing is sent from `screens/world.ts`, so `test/world.test.ts`'s send rule is untouched;
  - optional `net/mock.ts` subset.
- **Tests:** vitest units for `state.ts` (marker priority table, availability with prerequisites/level/dailies), `format.ts` (objective lines, template expansion) and `dialog.ts` (page selection per state), with the protocol validators on recorded frames.
- **How to check:**
  - a gold ! floats above Soldier Fengil for a new character; the dialog offers the quest; after accepting, the tracker shows the objective and the ! turns into a grey ? over Hwangno, then gold ? when ready;
  - Q (or L) opens the log with chapters; Abandon asks first;
  - the minimap shows the millet-field circle while "Pests in the Millet" is tracked;
  - the completion banner appears on turn-in.

### Lane D: party (server + client)

- **Owns:** `apps/server/src/party.ts` (PartyManager, `killShares()` pure function, loot plan, vitals), `apps/server/test/party.test.ts` (units: invite/respond/leave/kick/leader/settings reasons, offline grace, the §4.2 formula with the worked example, round-robin loot, gold split), `apps/server/test/party-e2e.test.ts` (two clients: invite → accept → both get `party`; kill → both get EXP in share mode; party chat reaches only members), `apps/game/src/hud/party.ts`, `apps/game/src/hud/party-invite.ts`.
- **Hooks:**
  - `gameplay.ts`:
    - `mobDied()`: replace the `shareRewards(...)` call with `this.party.killShares(m, now)` (shares, credit, loot owners), and pass the per-drop owner to `spawnGroundItem`;
    - `pickupProblem()`: `ownerParty`; `pickUp()`: gold split;
    - `request()`: 6 party cases;
    - `tick()`: `this.party.tick(now)`;
  - `world.ts`: `GroundItem.ownerParty`, `state()`;
  - `connection.ts`: `chat` with `channel: 'party'` (or UX's `apps/server/src/chat.ts` if it has landed; one merged `CLIENT_KEYS.chat` with UX's `to`, §4.4); `leaveWorld` → `party.offline` (`dispose()` already calls `leaveWorld(false)` [confirmed]); `enterWorld` → `party.online`;
  - client:
    - `hud/index.ts`: create the PartyFrame; key P through the KeyMap; MenuBar button; `OWN_REQUESTS`;
    - `hud/target.ts`: Invite button for players;
    - `world/chat.ts`: `ChatBox.registerPrefix('#', ...)` and the party colour;
    - `world/jangan/minimap.ts`: a party marker source (`addMarkerSource`);
    - `world/entities.ts`: `party` label class;
    - `i18n/en-party.ts` + one spread line in `en.ts`.
- **Cross-lane:** the skills lane's friendly `party` target group (docs/SKILLS.md: `targets.groups` `party`, and the self/party heal of the first slice) needs `PartyManager` membership; export a `sameParty(a, b)` helper for it.
- **How to check:** open two browsers with two characters; target the other and click Invite; accept in the popup. Both party frames show HP/MP bars and a crown. Kill Mangyang with one: both get EXP (share). Type `#hello`: only the party sees it. Walk 100 m apart: the other's bar dims and the minimap still shows its marker. Leave: the frames clear.

### Lane E: GM editors (server)

- **Owns:** `apps/server/src/editors/overrides.ts` (file formats, atomic write, history, layering helpers), `nest-edit.ts` (`nest` subcommands), `npc-edit.ts` (`npc` subcommands), `quest-api.ts` (the §5.4 routes), `apps/server/test/editors.test.ts` (layering order, id allocation, history and undo, validation errors, 409 on a stale `baseRev`, audit rows written), `apps/server/test/editors-e2e.test.ts` (a GM adds a nest → mobs spawn near it; a player gets `forbidden` and a strike; PUT a quest as player → 403; PUT as GM → `contentChanged` reaches a player socket); optional `apps/server/src/cli/content.ts` (`pnpm content export`).
- **Hooks:**
  - `gm.ts`: `COMMANDS.nest`, `COMMANDS.npc`, `COMMANDS.content` (`content reload [quests|nests|npcs]`) delegating to the editors (help text included);
  - `spawner.ts`: `addNest`, `updateNest`, `removeNest`;
  - `gamedata.ts`: apply the override files after loading `nests.json`/`npcs.json`;
  - `gameplay.ts`: `placeNpc(def)` / `removeNpc(code)` extracted from `start()`; `despawnNestMobs(nest)`;
  - `game.ts`: route `/api/gm/*` with the 32 KB limit (a limit argument on `readJson`), and `PUT, DELETE` in the CORS `Access-Control-Allow-Methods` line;
  - optional E2: a `content` script in the root `package.json` and `apps/server/package.json` (like `gm`) for `pnpm content export`;
  - lane B's `QuestBook.replace()`/`remove()`.
- **How to check:** as a GM (`pnpm gm grant <you>`), type `/nest add MOB_CH_GYO 8 25`: weasels appear around you; relog or restart the server: they are still there. `/nest near` lists it; `/nest set <id> count 3` removes five; `/nest remove <id>` clears them. `pnpm gm audit` lists every call. `/npc add NPC_CH_SMITH Old Smith Bo` puts a second smith at your feet.

### Lane F: GM editors (client)

- **Owns:** `apps/game/src/gm/editors/spawns.ts` (Spawns tab: near list, forms, add/move/remove buttons), `nest-rings.ts` (Babylon ground rings and labels for nests near the GM, disposed with the tab), `npcs.ts` (NPCs tab), `quest-editor.ts` + `quest-form.ts` (the §5.4 window), `api.ts` (Bearer calls to `/api/gm/quests*`).
- **Hooks:** `gm/window.ts` (register three tabs; open the Quest Editor window); `gm/commands.ts` (builders `nestNear`, `nestAdd`, ... that pass the shared validator); `i18n/en.ts` (`gm.editor.*`).
- **Tests:** units for the form ↔ `QuestDef` mapping (a round trip of every quest in `jangan.json` gives the same JSON) and for command building.
- **How to check:**
  - the Spawns tab shows rings around nearby nests; Add here draws a new ring and the mobs appear within a second;
  - in the Quest Editor, change JG_002's count from 8 to 3 and Save: a player with the quest active sees "3/3" (ready) in the tracker without relogging; Revert to repo brings back 8;
  - Validate on a quest with a misspelled mob code highlights that field.

### Order and merge points

1. **A** first.
2. **B**, **D** and **E** in parallel. B and D both touch `mobDied()`: B adds one line that consumes `credit`, D replaces the share computation that produces it. Whichever lands second rebases a 5-line hunk.
3. **C** after B's messages exist (it can start against the mock).
4. **F** after E.
5. The fields lane's wider world makes Acts II-IV playable; no code dependency.

---

## 8. Open questions

1. **Tiger Girl tuning.** The encounter's `hpMul 0.05` / `attackMul 0.8` guess at level-20 party damage. Measure with the skills wave (4 players, level 20, Bicheon/Cold mix) and adjust in the quest file, not in code.
2. **vSRO party EXP formula.** The level-weighted share with a +10 %/member bonus is ours. If the owner remembers the retail feel (for example weighting by level²), it is one function (`killShares`).
3. **Daily reset hour and timezone** of the mini PC (default 04:00 server local time).
4. **Export `ITEM_QNO_*` icons.** `iconItem` needs the client's quest item icons in `/out/icon/`, and `items.json` has no quest items today [confirmed; why the exporter leaves them out is not checked]. A small convert change (icons only, no items.json entries) makes quest items look native; until then a generic icon is used.
5. **Who may edit.** Default: any `gm`. Should spawn/NPC/quest editing be `admin`-only (`EDITOR_ROLE=admin`) so trusted-but-casual GMs cannot reshape the world?
6. **Quest sharing in a party** (`questShare`: offer your quest to members in range) is left for later; the finale already shares its bell credit.
7. **Player slash commands** (`/invite <name>`, `/leave`): today every slash line from a player is refused as a GM command. A small player-command table in `connection.ts` would need its own audit decision.
8. **Party persistence across a server restart** (currently dissolved) is fine for a handful of friends [rule]; revisit if restarts become frequent.
9. **Quest key: Q or L?** The task asks for L; the client's own captions (docs/UX_GAPS.md §4.1) say Q, and L is SRO's Academy key. This spec binds both to the quest window; drop L if the owner prefers the retail layout.
10. **Cross-lane hooks to confirm with the shops lane:** `NpcDialogWindow.onQuest` (or a disposer returned by `addTalkOption`), and the one `hasTopics` call in `npc.ts`. docs/UX_GAPS.md §6 item 2 already expects quests as a server-side `'quest'` service.
