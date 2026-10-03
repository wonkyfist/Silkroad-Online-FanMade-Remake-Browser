# Wave plan: waves 3–5 (cross-spec decisions, unified protocol, lanes)

This document combines five specs into one build order: docs/SKILLS.md §10, docs/SOUND.md, docs/FIELDS.md, docs/SHOPS.md, docs/QUESTS.md (with `content/quests/jangan.json`) and docs/UX_GAPS.md. It does three things:

- it settles the places where those specs disagree or leave a gap (§1);
- it merges their wire additions into one protocol list (§2);
- it splits waves 3, 4 and 5 into lanes that own disjoint files (§3–§6).

When this plan and a spec disagree, this plan wins. The specs remain the detailed design for each lane.

**Tags.**

- **[confirmed]**: checked in the code or data at HEAD `3afb304` (2026-09-27), or in `work/out/data`.
- **[likely]**: strong evidence, not proven.
- **[unknown]**: open.
- **[decision]**: a choice this plan makes.

**Repo state when this was written [confirmed]:**

- `git status` shows the integrating agent's uncommitted edits in:
  - `apps/server/src/connection.ts` (the saved-position log line);
  - `apps/server/src/nav.ts`;
  - `packages/nav/src/{gltf,world}.ts`;
  - `docs/NAVIGATION.md`;
  - new files `packages/nav/src/reach.ts` and `packages/nav/test/reachability.test.ts`.
- **The wave 3 seam step (W3-FS) must start from that agent's commit.** Lanes that touch none of those files can start before it.

---

## 0. Summary

1. **Protocol first, then seams, then lanes.**
   - Each wave begins with one protocol step (P): shared types, validators, shared tests and docs/PROTOCOL.md.
   - Next come two seam steps (FS server, FC client). They put every contended one-line hook into the shared files at once and create a stub for each lane's module.
   - Lanes then mostly edit files they own. The seams are listed in §3.
2. **Hot files are touched once.** The FS/FC steps are the only planned editors of the dispatch points in `gameplay.ts`, `connection.ts`, `screens/world.ts`, `hud/index.ts`, `world/entities.ts`, `hud/slots.ts`, `hud/intents.ts`, `world/intents.ts`, `config.ts`, `db.ts` (migrations), `i18n/en.ts` and `net/mock.ts`. After that, a lane may touch a shared file only at the hook points this plan lists for it.
3. **Migrations are numbered now.** The current schema is **v4** (4 `MIGRATIONS` entries) [confirmed `apps/server/src/db.ts`].
   - v5 skills and v6 storage, both landed by W3-FS.
   - v7 quests, landed by W4-FS.
   - v8 is reserved for a late wave-4 need. No other lane appends a migration.
4. **Wave 3 (tonight):**
   - SKILLS: server engine and client. All 41 Chinese skill lines up to mastery 20, plus the basic attacks, in three priority tiers (§4.3).
   - NPC dialog, shops and consumables; storage is the first thing cut if time runs short.
   - SOUND: export and runtime.
   - FIELDS: area export, streaming, server, and the world map.
   - UX P0/P1: lanes UX-A and UX-B.
5. **Wave 4:** quests and "The Tiger's Shadow", party, GM content editors, remaining UX.
6. **Wave 5:** living world (grass and plant scatter, visual only) and skill VFX polish.
7. **No role logic changes anywhere.** `apps/server/test/role-policy.test.ts` must pass at every integration.

---

## 1. Conflicts and gaps across the specs, with decisions

Each row names the specs involved, the problem and the decision. "FS"/"FC" are the wave's seam steps (§3); the other lane ids are defined in §4/§5.

### 1.1 NPCs, shops, quests

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| 1 | Quest entry in the NPC dialog | SHOPS §3.1/§8.3 (`addTalkOption` on the client), UX_GAPS §6.2 (server `'quest'` service), QUESTS §2.3 (supports both) | Two mechanisms | **Server-side only** [decision]. `npcDialog.services` contains `'quest'` when `QuestEngine.hasTopics(p, npcCode)` is true (wave 4). `NpcDialogWindow` gets an `onQuest(ctx)` callback slot in wave 3 (no-op until wave 4). `addTalkOption` is **dropped**. QUESTS' `quests/dialog.ts` adapter calls `onQuest`. |
| 2 | Caption of the quest option | SHOPS §3.2 "Talk to this person." (retail WND_TALKSTART), UX_GAPS §6.2 "Talk about a quest." | Two texts for one key | `npc.option.quest` = **"Talk to this person."** (SHOPS; retail string) [decision]. UX_GAPS §6.2 is superseded. |
| 3 | Talk walk distance | SHOPS 3 m walk / 8 m service; UX_GAPS "walk into 8 m" | Mismatch | SHOPS wins: `NPC_APPROACH_RANGE = 3` for the walk, `NPC_INTERACT_RANGE = 8` for every service check. If the walk is blocked within 8 m, the dialog still opens (SHOPS §3.1 caveat). |
| 4 | Quest items vs inventory and storage | QUESTS §1.5 (separate quest bag), SHOPS §5.1 (`category: 'quest'` not storable) | Overlap in rules | Quest items (`QITEM_*`) live only in the `quest_items` table and never enter the bag, storage, shops or the ground. SHOPS' `category === 'quest'` / `canStore === false` refusals stay as future-proofing: no exported item has that category [confirmed]. `have`/`deliver` objectives on real `ItemDef` codes use the bag. A deposit, sale or drop fires `inventoryChanged` → `quests.onInventory` recount, which is the intended `ready → active` path. |
| 5 | Level cap on the client | SHOPS §2.4 (the client does not know `config.levelCap`) | Gap | Add `WorldInfo.levelCap?: number` (§2.1) [decision]. The shop filter uses it, falling back to `DEFAULT_LEVEL_CAP`. It is sent in `worldEnter.world`. |

### 1.2 Skills, items and combat

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| 6 | Skill window key | SKILLS §10.3 **K**, UX_GAPS §4.1 **S** (the client caption "Skill ( S )" [confirmed there]) | Mismatch | **S**, with **K** as an alias [decision]. There is no WASD, so S is free. |
| 7 | Hotbar item entries vs `itemUse` | SKILLS §10.2 `HotbarEntry {kind:'item', code}`; SHOPS §4.5 | Undefined server rule | `hotbarSet` with `kind: 'item'` is accepted only when `data.item(code)?.use` exists (a consumable). Otherwise `not_usable`. The entry holds a **code**. Pressing it sends `itemUse {bag}` for the lowest bag index holding the code; with none, the slot greys out. There is no server-side "use by code" [decision]. |
| 8 | Cooldown bookkeeping | SKILLS §10.1 (cooldowns per group, "saved with their ready time"); SHOPS §4.1 (`Player.cooldowns` for items, runtime only); UX_GAPS §6.1 (no `hud/cooldowns.ts`) vs SHOPS §8.3.4 (skills owns `hud/cooldowns.ts`) | Two maps, persistence mismatch, disputed client module | **Server:** item groups stay in `Player.cooldowns` [confirmed field]. Skill cooldowns live in the skill engine's own map, keyed by **characterId**, so they survive a relog but not a server restart. There is no DB table [decision; deviates from SKILLS "saved"]. **Client:** one `CooldownClock` (`apps/game/src/hud/cooldowns.ts`), created by W3-FC, with keys `skill:<group>` and `item:<cooldownGroup>`. Hotbar, bag slots and skill window all read it. |
| 9 | Timed actions that exclude each other | SKILLS (skill action, queue of one), SHOPS §4.3 (return-scroll `itemCast`, `busy`), SHOPS §3.1 (talk walk interrupts the return cast) | No combined rule | See the rules after this table. |
| 10 | Basic attacks | SKILLS §10.4 ("basic attacks move onto `skills.json`"); today `BASIC_ATTACK` in `formulas.ts` with the same numbers (sword 2 × 60 %, 1200 ms) [confirmed] | Two sources | The basic-attack branch in `Gameplay.tickPlayer`/`attack()` stays. It reads `hits`/`pct`/interval from the weapon's `SKILL_CH_*_BASE_01` row when present, else `BASIC_ATTACK` (lane SK-S). Imbues and passive mods apply to basic hits. `combat.skill` is set to the base row code. |
| 11 | `combat.skill` row vs group | SOUND §5.9 (effectsound uses the **group**) | Mapping | The wire keeps the **row** code (`SKILL_CH_SWORD_SMASH_A_01`). Clients map it to its group through `skills.json` `group` [confirmed field]. |
| 12 | Ammunition | SKILLS §1.4 (`cnsm`, `no_ammo`) | Today bows never consume arrows [confirmed: no ammo code in `apps/server/src`] | Engine path and tests are built. Config `SKILL_AMMO` (default **0** = off) decides whether bow skills and bow basic attacks take 1 arrow from the bag [decision; friends first, open question §8]. |
| 13 | Friendly targets before parties exist | SKILLS `targets.groups` party/ally; QUESTS §7 lane D `sameParty` | Party is wave 4 | Wave 3: friendly skills (heal, buff-other, resurrect) may target **any visible player** (there is no PvP). Wave 4 adds `sameParty()` only for the `party`-only area heals [decision]. |
| 14 | Resurrection vs respawn UI | SKILLS `WATER_RESURRECTION_A`; PROTOCOL §5 (respawn = warp) | Gap: the client hides the death box only on respawn | The resurrected player gets `entityUpdate {id, state:'alive', hp, maxHp}` and `stats`. There is no warp. The client's death overlay also closes on its own `state: 'alive'` (SK-C owns that line in `hud/index.ts` `setPlayer` or `world.ts` `onEntityUpdate`; see §4.2). |
| 15 | Damage accounting for skill hits | SKILLS (skill hits "as auto-attack does"); QUESTS (credit from `m.damage`) | Must share one path | SK-S extracts `Gameplay.dealHits(a, t, hits, extra, now)` from `attack()`. Basic attacks, skills, imbues, DoT ticks and mob skills all go through it. `retaliate`/`m.damage`/`mobDied`/`playerDied` therefore stay the one path for EXP, loot and quest credit. |

**Rules for decision 9 [decision].**

- One timed action at a time per player: a skill action (prepare, cast, action), an item cast, or a talk walk.
- These **interrupt** an item cast (`itemCastEnd interrupted`): `moveTo`, `attack`, `useSkill`, `pickup`, `npcTalk`, death.
- `stopAction` ends it as `cancelled`.
- `itemUse` of a return scroll while a skill action runs → `busy`.
- `useSkill` during an item cast interrupts the cast, then proceeds.
- Damage never interrupts an item cast. Skill actions follow SKILLS §10.1 interrupts.

### 1.3 Client files several lanes want

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| 16 | Blade animation clips | SOUND §7 (`FAMILY_ATTACK.blade = /^ATTACK\d$/` plays default punches [confirmed `three/models.ts:63`]); SKILLS §6 (sword group covers blades) | Wrong clips and wrong swing sounds | SK-C fixes `FAMILY_ATTACK.blade`/`FAMILY_PACK.blade` → the sword group. It also widens `KEEP_CLIPS`, which today drops `SKILL_*` and `DOWN*`/`STUN*` clips [confirmed `models.ts:46`]. |
| 17 | `three/models.ts` co-edited | SOUND (`clipCursors`, `run`/`silent`, export `KEEP_CLIPS`); SKILLS (clip tables, phase playback) | Two lanes, one class | Disjoint hunks: **SND-C** owns `clipCursors()`, the `run` counters in `play`/`playAction`/`hurt`, `silent` in `die`, and the `KEEP_CLIPS` export keyword. **SK-C** owns `KEEP_CLIPS`'s regex, `FAMILY_ATTACK`/`FAMILY_PACK`, and a new `playSkill(phases)` method. SK-C lands first if both are ready; SND-C rebases. |
| 18 | `world/entities.ts` co-edited | SOUND (EntityContext audio, per-view sound), UX-B (band classes, `[GM]` span, `setGm`), QUESTS (`setQuestMark`), party (`party` class), SKILLS (effect loops on carriers) | Five lanes | W3-FC adds generic APIs (§3.3): `EntityView.setLabelClass`, `EntityView.setBadge`, and `EntityContext.attachments` (per-view attachments with update/dispose). Lanes use these and do not edit `entities.ts`, except UX-B's `refreshLabel` band hunk (it replaces `mobTone`). |
| 19 | `hud/slots.ts` co-edited | UX-A W3 (`blocked`), SHOPS lane E (`setCooldown`), SKILLS (drag to hotbar) | Three lanes | W3-FC adds `SlotView.set(stack, blocked = false)` and `SlotView.setCooldown(readyAt, totalMs)` (overlay CSS included). After that, only SK-C edits `slots.ts` (drag source for the hotbar). |
| 20 | Esc menu (`openMenu`) | UX-A (Options, Key help), SOUND (Sound) | Two lanes, one fixed 212 × 180 window [confirmed] | W3-FC turns `openMenu` into a list read from `hud/menu-items.ts` (`registerMenuItem({id, label, order, run})`). UX-A registers Options (10) and Key help (20). SND-C registers Sound (30). The built-in Character select / Logout / Resume stay at 80–90. |
| 21 | Audio settings and the corner button | UX_GAPS §4.3 (corrected), SOUND §5.2/§5.12 | Already reconciled in UX_GAPS | SOUND owns `audio/settings.ts` (`sro.audio.v1`, `sro.muted`), `hud/sound-settings.ts` and the corner mute button. UX-A's "remove the engine badge" (L3) moves to SND-C, which owns the corner block in `main.ts`. Options → Audio opens SOUND's window through `openSoundSettings()`. |
| 22 | World map (M) | UX_GAPS M3 (`hud/worldmap.ts`, UX-B) vs FIELDS lane 4 (`world/map/worldmap.ts`) | Two owners; UX's "minimap atlas" does not exist when streaming | **FLD-C owns the whole world map**: the window, the `m` key, zones, hunting clusters and the `worldmap.png` transform [decision]. UX-B drops M3 and keeps the minimap (M1 coordinates, zoom, area label; M2 `addMarkerSource`). The minimap's map button calls `hud.openWorldMap?.()`, which FLD-C sets. |
| 23 | Zone name under the minimap | UX_GAPS M1, FIELDS lane 4 (the HUD has no location text today [confirmed in FIELDS]) | Two owners | UX-B draws it in `world/jangan/minimap.ts` (which it owns). The text comes from FLD-C's `world/map/zones.ts` `zoneAt(x, z)`, falling back to town/field. |
| 24 | Level-band colours used by two lanes | UX-B nameplates (F2), FLD-C hunting labels | Shared pure function | W3-FC creates `apps/game/src/world/level-band.ts` with `levelBand()` (UX_GAPS §4.2 thresholds). Both lanes import it. |
| 25 | `hud/target.ts` co-edited | UX-B (gems, variant icon), SKILLS (effects row), party (Invite button, wave 4) | Three lanes | Hunks: UX-B inside `TargetFrame.set()` for the gem and icon; SK-C adds a `setEffects(list)` method plus its row element in the constructor. Wave 4's Invite button is added by PT-C as a new method, `setActions(...)`. |
| 26 | Key handling | UX_GAPS §4.1 KeyMap (UX-A), FIELDS (`k === 'm'` in `hud/index.ts`), SKILLS (1–0, F1–F4, K), QUESTS (Q, L, P) | Every lane wants keys | W3-FC creates `hud/keys.ts` (the UX_GAPS §4.1 contract verbatim) and moves `i`/`c` into it. Every lane registers through `hud.keys`; nobody adds a `keydown` listener. UX-A owns `keys.ts` after W3-FC. |
| 27 | Buff bar vs party frame placement | SKILLS §10.3 (bar under the HP/MP gauges), QUESTS §4.5 (party frame under the player frame) | Layout collision | The buff bar sits directly under the player frame. The party frame (wave 4) sits under the buff bar and moves down 28 px when the bar has icons. The quest tracker goes under the minimap block (zone label, then coordinates, then tracker) [decision]. |

### 1.4 Chat, networking, server infrastructure

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| 28 | Chat shape | UX_GAPS §5.1 (`to`, `'whisper'`), QUESTS §4.4 (`channel: 'party'`) | Both edit `CLIENT_KEYS.chat` and the same server `oneOf` | **The merged shape lands once, in wave 3 (W3-P):** client `{t:'chat'; text; to?; channel?: 'local'\|'party'}`, server `ChatChannel = 'local'\|'system'\|'whisper'\|'party'` plus `to?`. `to` together with `channel:'party'` → `error bad_request`. |
| 29 | Chat routing module | UX-B `apps/server/src/chat.ts` | Party also needs it | W3-FS creates `chat.ts` with `routeChat(conn, msg, text): boolean`, called in `connection.ts case 'chat'` **before** the slash branch [confirmed: slash text today goes to `runGm`]. It also adds `Connection.takeChat()` (`chatBucket` is private [confirmed]). UX-B implements whisper. In wave 3, `channel:'party'` answers `error bad_request "You are not in a party."`; PT-S replaces that branch in wave 4. |
| 30 | Client `sendChat` prefixes | UX-B (`/w`, `/r`), QUESTS (`#` party) | Same parser | UX-B implements `ChatBox.registerPrefix(prefix, fn)` in wave 3 (in `world/chat.ts`, which it owns). PT-C registers `#` in wave 4. |
| 31 | Minimap markers | QUESTS §2.6 (radius circles), §4.5 (party pins); UX_GAPS M2 | API needed early | UX-B lands `HudMinimap.addMarkerSource(fn): () => void` in wave 3. A marker is `{x, z, color, size?, radius?, icon?}`: `radius` in metres draws a circle, `icon` is an art path. |
| 32 | `ServerInfo.world` dropped by the client parser | FIELDS §6.1 (fact-check) | `validate.ts serverInfo()` rebuilds the object [confirmed in FIELDS verify] | W3-P adds the optional `world` to `serverInfo()` plus a test. |
| 33 | `MAX_GOLD` location | SHOPS §6 | Moves to shared | W3-P adds `MAX_GOLD` to `protocol.ts`. W3-FS makes `inventory.ts` import and re-export it, and adds `addGold(d, n, {strict})`. |
| 34 | Private `Gameplay` methods | SHOPS §8.2 (afterInventory, toTown), QUESTS (afterInventory), approach widened to NPCs | Several lanes need the same change | W3-FS makes `approach` (target type `Mob \| GroundItem \| Npc`), `afterInventory`, `toTown`, `invOp`, `setVitals` and `refresh` public, once. |
| 35 | Death / warp / move / stop fan-out | SHOPS (close dialog, cancel cast), SKILLS (clear effects, interrupt), QUESTS (encounters), party (vitals) | Many one-liners in the same methods | `GameplayModule` hooks (§3.1): `playerDied`, `warped`, `moved`, `stopped`, `inventoryChanged`, `mobDied`, `enter`, `forget`, `tickPlayer`, `tick`. W3-FS wires each **once**, including `warped(p, 'gm')` in `gm.ts` `tp`/`summon` [confirmed: they call `world.warp` directly]. |
| 36 | Requests allowed while dead | PROTOCOL §5 (`respawn` only), SHOPS (`npcClose`), QUESTS (abandon/leave) | Per-module lists | `GameplayModule.whileDead`. Wave 3: `npcClose`, `hotbarSet`. Wave 4: `questAbandon`, `partyLeave`, `partyRespond`, `partyKick`, `partyLeader`, `partySettings`. |
| 37 | `EntityState` decorations on the server | SKILLS (`effects`), UX-B (`gm`), QUESTS (`npc`), party (`ownerParty`) | All edit `World.state()` | W3-FS adds `World.decorators: ((e, s) => void)[]`, run at the end of `state()`. Each lane registers its decorator from its own module. |
| 38 | `net/mock.ts` (1,645 lines [confirmed]) | Every client lane wants mock support | Hot file | W3-FC adds `MockServer.extensions: MockExtension[]` (§3.4). Mock support goes in lane-owned `net/mock/<lane>.ts` and is **optional**, first to cut. The real-server e2e tests are the truth. |
| 39 | i18n | UX_GAPS §6.5 (per-lane spread files) | `en.ts` churn | W3-FC creates empty `i18n/en-{skills,shops,sound,fields,ux,ux-world}.ts` and their spread lines. W4-FC does the same for `en-{quests,party,editors}.ts`. Lanes edit only their own file. |

### 1.5 Quests, party, fields and editors (wave 4)

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| 40 | Party EXP share vs quest EXP | QUESTS §4.2, §1.3 | Interaction | Party modes affect **kill** EXP/SP-EXP only. Quest turn-in EXP/SP/gold is per player and never shared. Quest **kill credit** = alive damage dealers ∪ every party member eligible for the share (online, alive, within 60 m of the corpse), whatever the mode. At the cap, quest EXP becomes SP-EXP (`QUEST_CAP_EXP_TO_SPEXP`); kill EXP at the cap keeps today's rule (discarded, SP-EXP kept [confirmed QUESTS §0]). |
| 41 | `mobDied` edited by party and quests | QUESTS §7 order note | 5-line hunk conflict | W4-FS writes the seam: `const { shares, credit, lootOwners } = this.party?.killShares(m, now) ?? soloShares(m, …)`, then the reward loop, then `modules.mobDied(m, now, credit)` (quests consume `credit` there). PT-S fills `killShares`; QS-S only implements `mobDied` in its module. |
| 42 | Turn-in transaction vs `reward()` | QUESTS §1.3 (reward saves outside the transaction) | Needs a split | W4-FS splits `reward()` into `computeReward(p, exp, spExp)` → `next` and `applyProgress(p, next, levels, gain)`. `reward()` = compute + save + apply, so behaviour is unchanged. |
| 43 | Authored NPC identity | QUESTS §5.3 (`EntityState.npc`) | Wave 4 | `npc?` is added in W4-P. NPC identity on the client = `state.npc ?? state.model`. The NPC dialog (wave 3) already sends `npcDialog.code`; W4 makes `code` the authored identity. |
| 44 | `NestDef.provenance` vs `content-check.ts` | QUESTS §6.4 (`checkNestDef` is port-only [confirmed there]) | Validation | `checkNestDef` stays port-only. `editors/overrides.ts` validates authored nests with its own check (ED-S). |
| 45 | World id vs export folder | FIELDS §0.3; QUESTS (`QuestFile.world: 'jangan'`) | Naming | The world **id** stays `jangan` everywhere (nests, NPCs, quests, saves, `tp jangan`). The export **folder** (`WORLD_EXPORT`, `ServerInfo.world`, `WorldInfo.name`) is `jangan-fields`. Quest locations are glTF metres in the same frame (origin 168,97) [confirmed FIELDS §0.1], so they stay valid. |
| 46 | Quest playability depends on the fields | QUESTS §3.5 (only JG_001–004, R01, S01 playable in 3×3; Miaoryeong not placed [confirmed]) | Cross-wave dependency | Wave 4 runs **on the `jangan-fields` export**. It is a wave-4 entry criterion (§5.0). If fields is cut, wave 4 ships Act I plus the GM spawn editor for stand-in nests. |
| 47 | Quest key L | QUESTS open question 9 | Retail L = Academy | Q is the quest window; L stays an alias as QUESTS specifies [decision; cheap to drop]. |
| 48 | Editor role | QUESTS §5 (`EDITOR_ROLE`) | Open | Default `gm` [decision]. `EDITOR_ROLE=admin` is available. Roles are never changed in game. |
| 49 | Sit, Berserk | UX_GAPS §5.3/§5.4 (reserved) | Names reserved | They are **not** in waves 3–4. The names `sit`, `berserk`, `EntityState.sitting`, `EntityState.berserk`, `PlayerStats.berserk*` stay reserved (§2.5). |
| 50 | Streaming vs graphics settings | FIELDS §3.10 (radii chosen at load), UX_GAPS R5 (live quality) | Live change | FLD-R adds `RegionStreamer.setSettings(partial)`. UX-A's `settings.onChange` calls it through `world.stream?.setSettings(STREAM_DEFAULTS[preset])`. Sight range scales `drawDistance` only. |
| 51 | Sound surface probe on streamed regions | SOUND §5.8 (WorldRegions lookups), FIELDS §3 (regions come and go) | Missing region | `SurfaceProbe` treats an absent region as `Dirt` and never caches region objects across frames (SND-C test). |
| 52 | `ground.ts` edits | FIELDS lane 4 (stream options, live `isGround`), UX-A (quality default from settings) | Two lanes | FLD-C owns `world/jangan/ground.ts`. UX-A's single line (`quality: opts.quality ?? urlQuality() ?? settings.get().graphics.preset`) is a listed guest hook. |

---

## 2. Unified protocol additions (waves 3–4)

All of it is **additive v1**: `PROTOCOL_VERSION` stays 1, and old messages are unchanged.

- New client messages have strict key sets.
- Every new `GameplayRequest` gets exactly one `actionResult` (FIFO, as today) and a `CLIENT_RATE_LIMITS` row.
- Server → client parsers drop unknown keys.
- New enum **values** on an existing field (chat channel) make an older client drop that frame with a console warning [confirmed UX_GAPS §5]. The client is served by the same server, so they deploy together.

No name below collides with an existing `protocol.ts` name [confirmed against the file], and the SKILLS §10.2 names are used exactly as defined there.

### 2.1 Wave 3 (landed by W3-P)

```ts
// ================= packages/shared/src/protocol.ts — WAVE 3 =================

// ---- constants ----
export const MAX_GOLD = 9_999_999_999                 // moved from apps/server/src/inventory.ts (re-exported there)
export const HOTBAR_SLOTS = 40                        // 4 pages x 10 (keys 1-0, pages F1-F4)
export const MAX_EFFECTS_PER_ENTITY = 32
export const STORAGE_SIZE_DEFAULT = 150
export const MAX_STORAGE_SIZE = 180
export const BUYBACK_SLOTS = 5
export const NPC_APPROACH_RANGE = 3                   // NPC_INTERACT_RANGE (8) stays the service range
export type MasteryCode = 'BICHEON' | 'HEUKSAL' | 'PACHEON' | 'COLD' | 'LIGHTNING' | 'FIRE' | 'FORCE'
export const MASTERY_CODES: readonly MasteryCode[] = ['BICHEON', 'HEUKSAL', 'PACHEON', 'COLD', 'LIGHTNING', 'FIRE', 'FORCE']

// ---- skills (docs/SKILLS.md §10.2, verbatim names) ----
export interface HotbarEntry { kind: 'skill' | 'item'; code: string }
/** Abnormal states and crowd control (the convert SkillStatus['status'] union, moved to shared). */
export type SkillStatusKind = 'freeze' | 'frostbite' | 'shock' | 'burn' | 'poison' | 'zombie' | 'darkness' | 'stun' | 'knockdown' | 'knockback'
export const SKILL_STATUS_KINDS: readonly SkillStatusKind[] = ['freeze', 'frostbite', 'shock', 'burn', 'poison', 'zombie', 'darkness', 'stun', 'knockdown', 'knockback']
export interface EffectState {
  instance: number
  skill?: string                 // source skill row code (icon, ACT_L effects)
  status?: SkillStatusKind
  level?: number
  remainingMs: number            // 0 = until cancelled (toggles); passives are never sent
  source?: number                // caster entity id
}
export type CastEndReason = 'interrupted' | 'cancelled' | 'target_lost'
export const CAST_END_REASONS: readonly CastEndReason[] = ['interrupted', 'cancelled', 'target_lost']
export type EffectRemoveReason = 'expired' | 'replaced' | 'cancelled' | 'cured' | 'death'
export const EFFECT_REMOVE_REASONS: readonly EffectRemoveReason[] = ['expired', 'replaced', 'cancelled', 'cured', 'death']
export interface SkillCooldown { group: string; readyInMs: number }

// ---- NPC / shop / storage / consumables (docs/SHOPS.md §7, verbatim) ----
export type NpcService = 'shop' | 'storage' | 'repair' | 'quest'
export const NPC_SERVICES: readonly NpcService[] = ['shop', 'storage', 'repair', 'quest']
export type NpcCloseReason = 'closed' | 'too_far' | 'dead' | 'warp' | 'gone'
export const NPC_CLOSE_REASONS: readonly NpcCloseReason[] = ['closed', 'too_far', 'dead', 'warp', 'gone']
export type ItemCastEndReason = 'done' | 'cancelled' | 'interrupted'
export const ITEM_CAST_END_REASONS: readonly ItemCastEndReason[] = ['done', 'cancelled', 'interrupted']
export type StorageGoldDir = 'deposit' | 'withdraw'
export interface AccountStorage { size: number; slots: (ItemStack | null)[]; gold: number }   // not `Storage` (DOM type)
export interface StorageSlotUpdate { slot: number; item: ItemStack | null }
export interface BuybackEntry { item: ItemStack; price: number }

// ---- chat (merged UX whisper + party channel, decision 28) ----
export type ChatChannel = 'local' | 'system' | 'whisper' | 'party'
export type ChatSendChannel = 'local' | 'party'

// ---- ClientMessage additions ----
  | { t: 'skillLearn'; skill: string }
  | { t: 'masteryUp'; mastery: MasteryCode }
  | { t: 'buffCancel'; skill: string }
  | { t: 'hotbarSet'; slot: number; entry: HotbarEntry | null }
  | { t: 'npcTalk'; npc: number }
  | { t: 'npcClose' }
  | { t: 'storageOpen'; npc: number }
  | { t: 'storageDeposit'; npc: number; bag: number; count?: number; to?: number }
  | { t: 'storageWithdraw'; npc: number; slot: number; count?: number; bag?: number }
  | { t: 'storageMove'; npc: number; from: number; to: number }
  | { t: 'storageGold'; npc: number; dir: StorageGoldDir; amount: number }
  | { t: 'shopBuyback'; npc: number; index: number }
// changed (optional keys added): 'chat'
  | { t: 'chat'; text: string; to?: string; channel?: ChatSendChannel }
// unchanged, now implemented: { t: 'useSkill'; skill: string; target?: number }

// ---- ServerMessage additions ----
  // enter-world, after `inventory`
  | { t: 'skills'; masteries: Record<MasteryCode, number>; skills: string[] /* highest learned row per group */;
      hotbar: (HotbarEntry | null)[] /* length HOTBAR_SLOTS */; cooldowns?: SkillCooldown[] }
  | { t: 'skillsUpdate'; masteries?: Partial<Record<MasteryCode, number>>; learned?: string[]; hotbar?: { slot: number; entry: HotbarEntry | null }[] }
  | { t: 'cast'; id: number; skill: string; instance: number; target?: number; instant?: boolean; prepareMs: number; castMs: number; actionMs: number }
  | { t: 'castEnd'; id: number; instance: number; reason: CastEndReason }
  | { t: 'effectAdd'; id: number; effect: EffectState }
  | { t: 'effectRemove'; id: number; instance: number; reason?: EffectRemoveReason }
  | { t: 'npcDialog'; npc: number; code: string; services: NpcService[] }
  | { t: 'npcDialogClose'; npc: number; reason: NpcCloseReason }
  | { t: 'storage'; storage: AccountStorage }
  | { t: 'storageUpdate'; slots?: StorageSlotUpdate[]; gold?: number }
  | { t: 'buyback'; entries: BuybackEntry[] }
  | { t: 'itemCooldown'; group: string; readyInMs: number; totalMs: number }
  | { t: 'itemCast'; id: number; item: string; castMs: number }
  | { t: 'itemCastEnd'; id: number; item: string; reason: ItemCastEndReason }
// changed: server chat
  | { t: 'chat'; channel: ChatChannel; fromId?: number; from?: string; to?: string; text: string }

// ---- extensions of existing shapes (all optional) ----
// ServerInfo:   world?: string                         (FIELDS: export folder, e.g. 'jangan-fields'; absent = 'jangan')
// WorldInfo:    levelCap?: number                      (decision 5: config.levelCap)
// EntityState:  effects?: EffectState[]                (late joiners see buffs/statuses)
//               gm?: true                              (players; display only — UX_GAPS §5.2)
// entityUpdate: gm?: boolean
// combat:       instance?: number; at?: number; aoe?: true      (`skill` now set, row code)
// CombatHit:    status?: SkillStatusKind; down?: true; pos?: Vec3

// ---- GameplayRequest / GAMEPLAY_REQUESTS += ----
  | 'skillLearn' | 'masteryUp' | 'buffCancel' | 'hotbarSet'
  | 'npcTalk' | 'npcClose' | 'storageOpen' | 'storageDeposit' | 'storageWithdraw' | 'storageMove' | 'storageGold' | 'shopBuyback'

// ---- ActionFailReason / ACTION_FAIL_REASONS += ----
  | 'not_learned' | 'not_enough_mp' | 'wrong_weapon' | 'no_ammo' | 'cant_act' | 'no_sp' | 'mastery_cap'   // skills
  | 'gold_limit' | 'storage_full' | 'busy'                                                               // shops/consumables
// 'not_implemented' stays in the union (older clients), but useSkill no longer returns it.
```

**`packages/shared/src/content.ts` additions (W3-P):**

- `SkillDef` gains the SKILLS §3.2 fields as optional properties. Their types move from `packages/convert/src/data/skills.ts` `SkillExtras`, and convert then imports them from shared:
  - `group`, `kind`, `targets`, `description`, `instant`, `ui`, `aniGroup`, `hitCues`, `durationMs`, `area`, `statuses`, `heal`, `toggle`;
  - `requiresItem`, `requiresTargetState`, `consumes`;
  - `hpPct`, `mpPct`, `reqStr`, `reqInt`, `overlap`, `autoAttack`, `chainRoot`, `chainIndex`, `params`.

  `skills.json` already carries `group`, `kind`, `targets`, `ui`, `aniGroup`, `hitCues`, `overlap`, `autoAttack` and `params` [confirmed: 180 rows, kinds attack 79 / buff 40 / imbue 24 / passive 14 / heal 13 / cure 5 / debuff 3 / resurrect 2].
- `MasteryDef` gains `tab`, `page`, `lines`, `tabName`, `icon` and `iconFocus` [confirmed in masteries.json].
- `ItemDef` gains `keepFee?`, `repairCost?`, `canRepair?`, `canStore?` and `cureLevel?` (SHOPS §7.5).
- `NpcDef` gains `greeting?`. `ShopDef.tabs[i]` gains `reqGender?`.
- `ZoneDef` and `ZONES_FILE = 'zones.json'` (FIELDS §6.2), using the TOWNS_FILE pattern, **not** `CONTENT_FILES` [decision, per the FIELDS fact-check].
- `content-check.ts` accepts the new optional fields.

**Validators (`validate.ts`, W3-P).** Strict client key sets, `?` = optional:

| t | required | optional | bounds |
|---|---|---|---|
| `skillLearn` | t, skill | — | `codeName` |
| `masteryUp` | t, mastery | — | oneOf `MASTERY_CODES` |
| `buffCancel` | t, skill | — | `codeName` |
| `hotbarSet` | t, slot, entry | — | slot int 0..39. `entry` is `null` or strict `{kind, code}`: kind oneOf `['skill','item']`, code `codeName` |
| `npcTalk` | t, npc | — | int 0..MAX_ID |
| `npcClose` | t | — | — |
| `storageOpen` | t, npc | — | |
| `storageDeposit` | t, npc, bag | count, to | bag `bagSlot`; count 1..MAX_ITEM_COUNT; to 0..179 |
| `storageWithdraw` | t, npc, slot | count, bag | slot 0..179 |
| `storageMove` | t, npc, from, to | — | 0..179 |
| `storageGold` | t, npc, dir, amount | — | dir oneOf; amount int 1..MAX_GOLD |
| `shopBuyback` | t, npc, index | — | 0..BUYBACK_SLOTS−1 |
| `chat` (changed) | t, text | to, channel | `to`: `str(3..12)` matching `CHARACTER_NAME`; `channel` oneOf `['local','party']` |

Server parsers:

- `skills.hotbar.length === 40`; `skills.skills` ≤ 512; masteries values int 0..300;
- `cast` ms ints 0..600,000;
- `effects` ≤ `MAX_EFFECTS_PER_ENTITY`; `remainingMs` int 0..86,400,000;
- `storage.slots` ≤ 180; `entries` ≤ 5; `castMs`/`readyInMs`/`totalMs` 0..600,000;
- `chat.channel` oneOf the four channels;
- `serverInfo()` keeps `world` (a string ≤ 64 matching `/^[a-z0-9-]+$/`);
- `worldInfo` keeps `levelCap` (int 1..300).

**Rate limits (`CLIENT_RATE_LIMITS` +=, W3-P):**

| t | perSecond | burst |
|---|---|---|
| skillLearn, masteryUp | 5 | 10 |
| buffCancel | 5 | 10 |
| hotbarSet | 10 | 20 |
| npcTalk | 2 | 5 |
| npcClose | 5 | 10 |
| storageOpen | 2 | 5 |
| storageDeposit, storageWithdraw, storageMove | 10 | 20 |
| storageGold | 5 | 10 |
| shopBuyback | 5 | 10 |

`useSkill` (5/10), `itemUse` and `shop*` are unchanged. Chat, including whisper and party, keeps its 1/s burst-5 bucket. The global limit stays 20 msg/s, burst 40.

**Enter-world sequence (wave 3):** `worldEnter` (with `world.levelCap`, `self.effects`) → `stats` → `inventory` → `skills`.

- Storage, buyback and item cooldowns are sent only on demand.
- Order is fixed by module registration (§3.1).

**Message order additions:**

- As SHOPS §7.3.
- Skills (SKILLS §10.2): `actionResult ok` → `cast` → (`statsDelta {mp}`) → `combat {instance}`… A queued skill gets its `actionResult ok` at request time and its `cast` when it starts.
- Learning: `actionResult ok` → `skillsUpdate` → `statsDelta {sp}` (→ `stats` when passives change the totals).

### 2.2 Wave 4 (landed by W4-P)

```ts
// ================= packages/shared/src/quests.ts (new) — WAVE 4 =================
// The whole of docs/QUESTS.md §6.1, verbatim: QUEST_FILE_SCHEMA, QUEST_ID, QUEST_ITEM_CODE, QUEST_LOCATION_ID,
// AUTHORED_NPC_CODE, OBJECTIVE_ID, MAX_ACTIVE_QUESTS (10), MAX_QUEST_OBJECTIVES (8), MAX_REWARD_CHOICES (8),
// MAX_QUEST_TEXT (1200), MAX_QUEST_TITLE (60), QuestKind, ArmorClassToken, QuestFile, QuestItemDef, QuestLocation,
// QuestDef, QuestItemGrant, QuestObjective (kill|collect|talk|deliver|have|reach|useItem), QuestObjectiveType,
// QuestEncounter, QuestRewards, RewardItem, QuestDialog, QuestRefs, QuestIssue,
// validateQuestFile(), validateQuestDef(), expandRewardCode(), rewardCodeVariants(), questRewardExp().

// ================= packages/shared/src/protocol.ts — WAVE 4 =================
export type PartyMode = 'free' | 'share'
export type PartyExpMode = PartyMode
export type PartyItemMode = PartyMode
export const PARTY_MODES: readonly PartyMode[] = ['free', 'share']
export const PARTY_MAX = 8
export const PARTY_SHARE_RANGE = 60
export const PARTY_INVITE_MS = 30_000
export const PARTY_OFFLINE_GRACE_MS = 120_000
export interface QuestProgress { quest: string; rev: number; status: 'active' | 'ready'; counts: Record<string, number>; items: { code: string; count: number }[]; acceptedAt: number; encounterUntil?: number }
export interface QuestDoneEntry { quest: string; times: number; lastAt: number; availableAt?: number }
export type QuestEvent = 'accepted' | 'progress' | 'objective' | 'ready' | 'completed' | 'abandoned' | 'changed'
export const QUEST_EVENTS: readonly QuestEvent[] = ['accepted', 'progress', 'objective', 'ready', 'completed', 'abandoned', 'changed']
export type ContentChangeKind = 'quests' | 'nests' | 'npcs'
export const CONTENT_CHANGE_KINDS: readonly ContentChangeKind[] = ['quests', 'nests', 'npcs']
export interface PartyMember { characterId: number; name: string; model: string; level: number; entity: number | null; hp: number; maxHp: number; mp: number; maxMp: number; dead?: boolean; pos?: [number, number] }
export interface PartyState { id: number; leader: number; exp: PartyExpMode; items: PartyItemMode; members: PartyMember[] }
export interface PartyVitals { characterId: number; entity?: number | null; level?: number; hp?: number; maxHp?: number; mp?: number; maxMp?: number; dead?: boolean; pos?: [number, number] }
export type PartyEventKind = 'joined' | 'left' | 'kicked' | 'leader' | 'declined' | 'expired' | 'disbanded' | 'offline' | 'online' | 'settings'
export const PARTY_EVENT_KINDS: readonly PartyEventKind[] = ['joined', 'left', 'kicked', 'leader', 'declined', 'expired', 'disbanded', 'offline', 'online', 'settings']

// ---- ClientMessage additions ----
  | { t: 'questAccept'; npc: number; quest: string }
  | { t: 'questTurnIn'; npc: number; quest: string; choice?: number }
  | { t: 'questAbandon'; quest: string }
  | { t: 'questTalk'; npc: number; quest: string; objective: string }
  | { t: 'questUseItem'; quest: string; objective: string }
  | { t: 'partyInvite'; target: number; exp?: PartyExpMode; items?: PartyItemMode }
  | { t: 'partyRespond'; inviter: number; accept: boolean }        // inviter = entity id from partyInvited
  | { t: 'partyLeave' }
  | { t: 'partyKick'; member: number }                              // characterId
  | { t: 'partyLeader'; member: number }                            // characterId
  | { t: 'partySettings'; exp?: PartyExpMode; items?: PartyItemMode }

// ---- ServerMessage additions ----
  | { t: 'quests'; active: QuestProgress[]; done: QuestDoneEntry[]; rev: number }
  | { t: 'questUpdate'; quest: string; event: QuestEvent; progress: QuestProgress | null; done?: QuestDoneEntry; objective?: string }
  | { t: 'contentChanged'; kind: ContentChangeKind; rev: number }
  | { t: 'partyInvited'; inviter: number; name: string; level: number; exp: PartyExpMode; items: PartyItemMode; expiresInMs: number }
  | { t: 'party'; party: PartyState | null }
  | { t: 'partyVitals'; members: PartyVitals[] }
  | { t: 'partyEvent'; event: PartyEventKind; name: string }

// ---- extensions (optional) ----
// EntityState: npc?: string (authored identity NPCX_* when ≠ model); ownerParty?: number (items)
// StatGain:    quest?: string

// ---- GameplayRequest += ----
  | 'questAccept' | 'questTurnIn' | 'questAbandon' | 'questTalk' | 'questUseItem'
  | 'partyInvite' | 'partyRespond' | 'partyLeave' | 'partyKick' | 'partyLeader' | 'partySettings'
// ---- ActionFailReason += ----
  | 'quest_log_full' | 'quest_active' | 'quest_done' | 'not_complete' | 'choice_required' | 'wrong_place'
  | 'not_in_party' | 'not_leader' | 'party_full' | 'in_party' | 'no_invite'

// ---- GM editor data and HTTP (QUESTS §6.2, verbatim) ----
export interface GmNestInfo { id: number; mob: string; mobName: string; level: number; x: number; z: number; radius: number; spawnRadius: number; count: number; alive: number; respawnSec: [number, number]; aggressive: boolean; enabled: boolean; source: 'export' | 'patched' | 'authored' }
export interface GmNpcInfo { code: string; base: string; name: string; x: number; z: number; yaw: number; entity: number | null; shop?: string; hidden?: boolean; source: 'export' | 'patched' | 'authored' }
export interface ApiQuestCatalog { rev: number; files: QuestFile[] }
export interface ApiGmQuestList { rev: number; quests: { id: string; title: string; file: string; source: 'repo' | 'override'; rev: number; disabled: boolean; issues: QuestIssue[] }[] }
export interface ApiGmQuestPut { quest: QuestDef; items?: QuestItemDef[]; locations?: QuestLocation[]; baseRev?: number }
export interface ApiGmQuestResult { ok: boolean; rev: number; issues: QuestIssue[] }
// NestDef.provenance widens to Provenance (checkNestDef stays port-only; decision 44).
```

**Validators (W4-P):**

- QUESTS §6.3 verbatim: `questAccept [t,npc,quest]`; `questTurnIn` optional `choice` 0..7; `questAbandon`; `questTalk [t,npc,quest,objective]`; `questUseItem`; `partyInvite` optional `exp`/`items`; `partyRespond [t,inviter,accept]`; `partyLeave`; `partyKick`/`partyLeader [t,member]` (int 1..MAX_SAFE_INTEGER); `partySettings` (at least one of `exp`/`items`).
- `quest` matches `QUEST_ID`. `objective` matches `OBJECTIVE_ID`.
- Server parsers: `questUpdate.progress` nullable; `counts` values ints ≥ 0; `party` nullable; members ≤ 8.

**Rate limits (W4-P):**

| t | perSecond | burst |
|---|---|---|
| questAccept, questTurnIn, questTalk | 5 | 10 |
| questAbandon, questUseItem | 2 | 5 |
| partyInvite, partyLeave | 1 | 3 |
| partyRespond, partyKick, partyLeader, partySettings | 2 | 5 |

- GM editor commands keep the GM bucket (5/s, burst 20).
- `/api/gm/*` has its own per-account budget: 2/s, burst 10, bodies ≤ 32 KB.

**Enter-world (wave 4):** `worldEnter` → `stats` → `inventory` → `skills` → `quests` → `party` (only when in one).

### 2.3 HTTP additions

| Wave | Route | Auth | Notes |
|---|---|---|---|
| 4 | `GET /api/quests` → `ApiQuestCatalog` (ETag `"q<rev>"`) | Bearer | QS-S |
| 4 | `GET /api/gm/quests`, `POST /api/gm/quests/validate`, `PUT/DELETE /api/gm/quests/:id`, `POST /api/gm/quests/:id/disable\|enable` | Bearer + staff (re-read from the DB) | ED-S; `readJson` gains a limit argument (`MAX_BODY_BYTES` 4096 is global today [confirmed QUESTS §0]); CORS methods add `PUT, DELETE` |

### 2.4 Content and config (not wire)

- **Wave 3 content:** `work/out/sound/index.json` + `sound/model/*.json` (`packages/shared/src/sound.ts`, SOUND §4.3, verbatim). `data/zones.json`. The optional manifest fields `bounds`, `stream`, `places` (FIELDS §3.9). New `items.json`/`npcs.json` fields (SHOPS lane F).
- **Wave 3 config** (all added by W3-FS in `apps/server/src/config.ts`):

  | Setting | Default |
  |---|---|
  | `WORLD_EXPORT` → `worldExport` | `WORLD` |
  | `NEST_COUNT_SCALE` → `nestCountScale` | 1, clamped 0.1..1 |
  | `STORAGE_FEE` → `storageFee` | 1 |
  | `SKILL_AMMO` → `skillAmmo` | 0 |
  | `GOLD_RATE` → `goldRate` | 1; read by `rollDrops` later, no lane needs it tonight |

- **Wave 4 config** (W4-FS):

  | Setting | Default |
  |---|---|
  | `CONTENT_DIR` | `<repo>/content` |
  | `QUEST_DAILY_RESET_HOUR` | 4 |
  | `QUEST_CAP_EXP_TO_SPEXP` | 1 |
  | `EDITOR_ROLE` | `gm` |

### 2.5 Reserved, not built in waves 3–4

- Client messages: `sit`, `berserk`, `questShare`.
- Server message: `berserkUpdate`.
- `EntityState.sitting`, `EntityState.berserk`.
- `PlayerStats.berserk`, `PlayerStats.berserkUntil`.
- `ActionFailReason` `'not_repairable'`, and the `'repair'` service handler: the `NpcService` value exists, and the server never offers it.

---

## 3. Seams (the contracts the FS/FC steps land)

The seam steps also **move existing code into the new module files unchanged**, so behaviour and tests stay green before any lane starts:

| From | To |
|---|---|
| `Gameplay.itemUse` | `apps/server/src/item-use.ts` `ItemUses.use` |
| `shopNpc`/`shopBuy`/`shopSell` | `apps/server/src/shop.ts` `Shops` |
| `useSkill`'s `not_implemented` answer | `apps/server/src/skills/engine.ts` `SkillEngine.request` |

Stub modules for new features answer `fail('not_implemented')` and do nothing else.

### 3.1 Server: `apps/server/src/modules.ts` (new, W3-FS)

```ts
import type { ClientMessage, GameplayRequest } from '@sro/shared'
import type { Result } from './inventory.ts'
import type { Mob, Player } from './world.ts'

export type GameplayMessage = Extract<ClientMessage, { t: GameplayRequest }>   // moved from gameplay.ts:60
export type Answer = (r: Result<unknown> | true) => void
export type WarpReason = 'town' | 'gm'

export interface GameplayModule {
  readonly name: string
  /** Request types this module answers. Gameplay routes them here; the module answers exactly once. */
  readonly handles?: readonly GameplayRequest[]
  /** Of `handles`, those accepted while the player is dead (PROTOCOL §5 allowlist extension). */
  readonly whileDead?: readonly GameplayRequest[]
  request?(p: Player, msg: GameplayMessage, answer: Answer, now: number): void
  /** Enter-world, after `inventory`, in registration order (skills, then wave 4 quests, party). */
  enter?(p: Player, now: number): void
  moved?(p: Player, now: number): void             // an accepted client moveTo (Gameplay.onMoveTo)
  stopped?(p: Player, now: number): void           // stopAction (after the built-in halt)
  tickPlayer?(p: Player, now: number): void        // alive players only, after the built-in attack/pickup branches, before regen
  tick?(now: number): void                         // once per server tick, after mobs
  playerDied?(p: Player, now: number): void
  warped?(p: Player, reason: WarpReason, now: number): void   // toTown (respawn, return scroll) or GM tp/summon
  inventoryChanged?(p: Player): void               // end of Gameplay.afterInventory
  mobDied?(m: Mob, now: number, credit: ReadonlySet<number>): void  // after rewards; credit = player ids
  forget?(p: Player): void
}
```

**W3-FS edits in `apps/server/src/gameplay.ts`.** It is the only lane that edits these lines tonight:

- **Constructor:**
  - `this.skills = new SkillEngine(this)`, `this.npcs = new NpcDialogs(this)`, `this.shops = new Shops(this)`, `this.storage = new StorageService(this)`, `this.itemUses = new ItemUses(this)`;
  - `this.modules = [this.skills, this.npcs, this.shops, this.storage, this.itemUses]`;
  - `this.routes: Map<GameplayRequest, GameplayModule>`, built from `handles`. It throws on a duplicate.
- **`request()`:**
  - `const mod = this.routes.get(msg.t)`;
  - the dead check becomes `if (p.dead && msg.t !== 'respawn' && !mod?.whileDead?.includes(msg.t))`;
  - `if (mod) return mod.request!(p, msg, answer, now)` runs before the switch;
  - the switch keeps `attack`, `stopAction` (+ `modules.stopped`), `pickup`, `statUp`, `itemMove/Split/Equip/Unequip/Drop` and `respawn`.
- **Fan-out calls:**
  - `sendEnter` → `modules.enter`;
  - `forget` → `modules.forget`;
  - `onMoveTo` → `modules.moved`;
  - `tickPlayer` → `modules.tickPlayer` before `regenPlayer`;
  - `tick` → `modules.tick`;
  - `playerDied` → `modules.playerDied`;
  - `toTown` → `modules.warped(p, 'town')`;
  - `afterInventory` → `modules.inventoryChanged`;
  - `mobDied` → `modules.mobDied(m, now, new Set(shares.keys()))` when `rewards` is true.
- **Visibility:** `approach` (widened to `Mob | GroundItem | Npc`), `afterInventory`, `toTown`, `invOp`, `setVitals` and `refresh` become public.

**Other W3-FS edits:**

- `world.ts`:
  - `PlayerAction` += `{ kind: 'talk'; npc: number; chaseAt: number; chaseTo: [number, number] | null }` and `{ kind: 'skill'; skill: string; target: number; chaseAt: number; chaseTo: [number, number] | null }`;
  - `World.decorators: ((e: Entity, s: EntityState) => void)[]`, run at the end of `state()`.
- `gm.ts`: `tp`/`summon` call `game.gameplay.warped(p, 'gm', now)` (the one-liner that fans out to `modules.warped`).
- `connection.ts`:
  - `case 'chat'`: after the empty check and before the slash branch, `if (routeChat(this, msg, text)) return`;
  - public `takeChat(): boolean`;
  - worldEnter `world.levelCap: this.game.config.levelCap`.
- `inventory.ts`: import and re-export `MAX_GOLD`; `addGold(d, n, opts?: {strict?: boolean})`; `export` `stackable`.
- `db.ts`: migrations v5 and v6 (below); expose `writeDraft`.
- `config.ts`: the wave-3 settings of §2.4.
- New stub files, each exporting a class that implements `GameplayModule` (bodies as described at the top of §3):
  - `apps/server/src/skills/engine.ts` (`SkillEngine`);
  - `apps/server/src/npc.ts` (`NpcDialogs`, `HIDDEN_NPCS`);
  - `apps/server/src/shop.ts` (`Shops`);
  - `apps/server/src/storage-db.ts` (`StorageService`);
  - `apps/server/src/item-use.ts` (`ItemUses`);
  - `apps/server/src/chat.ts` (`routeChat`).

**Migrations (W3-FS appends, in this order; the final SQL is theirs to adjust before merge, never after):**

```sql
-- 5: skills and masteries (docs/SKILLS.md §10.1; docs/WAVE_PLAN.md decision 8: cooldowns are not persisted)
CREATE TABLE char_masteries (
  character_id INTEGER NOT NULL REFERENCES characters(id),
  code TEXT NOT NULL,
  level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 300),
  PRIMARY KEY (character_id, code)
);
CREATE TABLE char_skills (
  character_id INTEGER NOT NULL REFERENCES characters(id),
  grp TEXT NOT NULL,                    -- skills.json `group`, e.g. SKILL_CH_SWORD_SMASH_A
  level INTEGER NOT NULL CHECK (level >= 1),
  PRIMARY KEY (character_id, grp)
);
CREATE TABLE char_hotbar (
  character_id INTEGER NOT NULL REFERENCES characters(id),
  slot INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 39),
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'item')),
  code TEXT NOT NULL,
  PRIMARY KEY (character_id, slot)
);
-- 6: account storage (docs/SHOPS.md §5.2, verbatim)
CREATE TABLE storage_items ( ... as SHOPS §5.2 ... );
CREATE INDEX storage_items_account ON storage_items(account_id);
ALTER TABLE accounts ADD COLUMN storage_gold INTEGER NOT NULL DEFAULT 0 CHECK (storage_gold >= 0);
ALTER TABLE accounts ADD COLUMN storage_size INTEGER NOT NULL DEFAULT 150 CHECK (storage_size BETWEEN 1 AND 180);
-- 7 (wave 4, W4-FS): quest_state, quest_done, quest_items (docs/QUESTS.md §1.4, verbatim)
-- 8: reserved
```

Lanes write their statements against these tables in their own files (`skills/store.ts`, `storage-db.ts`, `quests/store.ts`) through `store.db.prepare`.

### 3.2 Client: `apps/game/src/world/features.ts` (new, W3-FC)

```ts
export interface WorldFeatureContext {
  readonly app: App
  readonly session: Session
  readonly scene: Scene
  readonly hud: Hud
  readonly keys: KeyMap
  send(msg: ClientMessage): void                // builders must pass parseClientMessage (lane tests)
  selfId(): number | null
  view(id: number): EntityView | undefined
  views(): IterableIterator<EntityView>
  target(): EntityView | null
  setTarget(v: EntityView | null): void
  serverNow(): number
  world(): JanganGround | null                  // loaded world-render handle (null while loading)
}
export interface WorldFeature {
  onMessage?(msg: ServerMessage): void          // after world.ts handled it
  onCombatHit?(msg: Extract<ServerMessage, { t: 'combat' }>, index: number): void   // when hit `index` is shown
  onFrame?(now: number, dt: number): void
  onTownChange?(inTown: boolean): void          // from updateMusic()
  clickEntity?(v: EntityView): boolean          // true = consumed (before the default target/attack)
  escape?(): boolean                            // after HUD windows, before clearing the target
  onEntityAdded?(v: EntityView): void
  onEntityRemoved?(v: EntityView): void
  dispose?(): void
}
export type WorldFeatureFactory = (ctx: WorldFeatureContext) => WorldFeature
/** One line per lane; W3-FC writes all wave-3 lines, W4-FC appends wave 4's. */
export const WORLD_FEATURES: readonly WorldFeatureFactory[] = [
  skillsFeature,      // world/features/skills.ts   (SK-C)
  npcFeature,         // world/features/npc.ts      (NPC-C)
  soundFeature,       // world/features/sound.ts    (SND-C)
  uxWorldFeature,     // world/features/ux-world.ts (UX-B)
  mapFeature,         // world/features/map.ts      (FLD-C)
]
```

**W3-FC edits in `apps/game/src/screens/world.ts`:**

- build the context and the features once the HUD exists;
- call `onMessage` at the end of `onMessage`;
- extract `presentHit(msg, i)` from `onCombat`'s per-hit `timeline.after` callback and call `onCombatHit` there;
- call `onFrame` in the frame observer;
- call `onTownChange` in `updateMusic`;
- run `clickEntity` first in `clickEntity`;
- run `escape` in the Esc chain;
- call `onEntityAdded`/`onEntityRemoved` in `addEntity`/`removeEntity`;
- call `dispose` in the screen's `dispose`.

`openMenu` renders `menuItems()`. About 40 lines in total.

**`world/entities.ts` (W3-FC):**

- `EntityContext` += `attachments: readonly ((v: EntityView) => EntityAttachment | null)[]`, with

  ```ts
  interface EntityAttachment {
    loaded?(): void
    update?(now: number, dt: number): void
    dispose(): void
  }
  ```

  The constructor runs each factory. `load()` calls `loaded`, `update()` calls `update`, and `dispose()` calls `dispose`.
- `EntityView.setLabelClass(cls: string, on: boolean)`.
- `EntityView.setBadge(key: string, text: string | null, cls?: string)`: one span per key, placed before the name, used by `[GM]`, quest marks and party.
- `EntityView.state` (readonly getter) and `EntityView.actor` (getter), if not already public.

**HUD (`hud/index.ts`, W3-FC). `Hud` gains:**

- `readonly keys: KeyMap`;
- `readonly cooldowns: CooldownClock`;
- `readonly layer: HTMLElement`, the parent for new windows;
- `claimRequests(types: readonly GameplayRequest[]): void`, which extends `OWN_REQUESTS`;
- `routeBagAction(fn: (bag: number) => boolean): () => void`, a right-click routing stack with the last registered checked first; storage → shop → default use/equip;
- `openWorldMap?: () => void`, set by FLD-C.

`i`/`c` move into `keys`. `helpKeys` stays until UX-A replaces it.

**New W3-FC files** (owned afterwards by the lane in brackets):

| File | Contents | Owner after W3-FC |
|---|---|---|
| `hud/keys.ts` | KeyMap, UX_GAPS §4.1 verbatim | UX-A |
| `hud/cooldowns.ts` | `class CooldownClock { set(key, readyAtMs, totalMs); get(key): {readyAt, totalMs} \| null; remaining(key, now): number; onChange(fn): () => void }` | SK-C |
| `hud/menu-items.ts` | `registerMenuItem({id, label: StringKey, order, run, when?})`, `menuItems()` | UX-A |
| `hud/menubar.ts` | `register({id, art, label, toggle, isOpen})`, minimal render | UX-A |
| `world/level-band.ts` | `levelBand()`, `LevelBand`, UX_GAPS §4.2 | UX-B |
| `world/features/*.ts` | five stubs returning `{}` | their lanes |
| `i18n/en-{skills,shops,sound,fields,ux,ux-world}.ts` | empty `{} satisfies Partial<Record<string,string>>`, plus spread lines in `en.ts` | their lanes |

**`hud/slots.ts` (W3-FC):** `SlotView.set(stack, blocked = false)` and `SlotView.setCooldown(readyAt: number, totalMs: number)` (a conic-gradient overlay in injected CSS).

**Intents (W3-FC):** every wave-3 builder, each returning a `parseClientMessage`-clean message or null.

- `hud/intents.ts` `intent`: `skillLearn`, `masteryUp`, `buffCancel`, `hotbarSet`, `useSkill`, `npcClose`, `storageOpen`, `storageDeposit`, `storageWithdraw`, `storageMove`, `storageGold`, `shopBuy`, `shopSell`, `shopBuyback`.
- `world/intents.ts` `intents`: `npcTalk`, `chat(text, to?, channel?)`.
- Tests are added to `apps/game/test/world.test.ts` and `hud.test.ts`.

### 3.3 Mock extension (W3-FC, `net/mock.ts`)

```ts
export interface MockExtension {
  handle?(ctx: MockContext, conn: MockConn, msg: ClientMessage): boolean   // true = handled (must send its own actionResult)
  tick?(ctx: MockContext, now: number): void
  enter?(ctx: MockContext, conn: MockConn): void
}
// MockServer constructor option `extensions?: MockExtension[]`; the default list lives in net/mock/index.ts.
```

- `MockContext` exposes the existing `result()`, `send`, `snapshot`, `dist` and the sim entities.
- Lane mocks live in `net/mock/{skills,npc,ux}.ts` and are **optional**.

---

## 4. Wave 3 (tonight, first)

### 4.0 Step order, dependencies and concurrency

```
T0 ─┬─ W3-P  protocol (shared)                               ~1 h
    ├─ SND-X sound export (convert)                          starts now (no app deps)
    ├─ FLD-X fields export (convert) → then FLD-S             starts now
    └─ FLD-R world-render streaming (+ nav hook)             starts now (coordinate packages/nav/src/world.ts)
T+1h ── W3-P lands ─┬─ W3-FS server seams                    ~1–1.5 h  (after the integrator's commit)
                    └─ W3-FC client seams                    ~1–1.5 h  (parallel with W3-FS)
T+2.5h ── seams land ─┬─ SK-S  skills server      (critical path)
                      ├─ SK-C  skills client      (critical path)
                      ├─ NPC-S npc/shops/consumables server
                      ├─ NPC-C npc/shop/storage/cast-bar client
                      ├─ SND-C sound runtime       (can start at T+1h on a fixture index; hooks after W3-FC)
                      ├─ UX-A  shell/settings/robustness
                      ├─ UX-B  world feel/chat/minimap (+ server chat.ts, GM tag)
                      ├─ FLD-C game integration + world map (after FLD-R API, FLD-X data or stubs)
                      └─ ST-S  storage server      (first to cut)
T+6.5h ── W3-I integration review (one agent; §4.5)
```

- **If agents are limited, start them in this order:**
  1. SK-S, SK-C, NPC-S, NPC-C;
  2. SND-C, UX-A;
  3. FLD-C, UX-B;
  4. ST-S.
- The convert lanes (SND-X, FLD-X, FLD-R) do not block anyone: consumers use fixtures or stubs.
- **Hard dependencies:**
  - every app lane → W3-FS/FC;
  - SK-C's in-game check → SK-S;
  - NPC-C → NPC-S (and ST-S for storage);
  - FLD-C → FLD-R (API) and FLD-X (data);
  - FLD-S → FLD-X (export on disk);
  - SND-C's in-game check → SND-X.

### 4.1 W3-P: protocol (first, one agent)

**Owns:**

- `packages/shared/src/{protocol.ts, validate.ts, content.ts, content-check.ts, index.ts}`;
- new `packages/shared/test/wave3.test.ts`;
- `docs/PROTOCOL.md`: §8 and §9 rewritten to point at SHOPS and SKILLS; §11 rows for every §2.1 message; §5's dead list gains `npcClose` and `hotbarSet`.

`packages/shared/src/sound.ts` is **not** in scope; SND-X owns it and adds its own `index.ts` export line after W3-P lands.

**Work:** §2.1 exactly. Also move `SkillStatus`/`SkillKind`/`SkillExtras` field types into `content.ts`; `packages/convert/src/data/skills.ts` then imports them (a one-line import hook in convert).

**Tests** (`wave3.test.ts`):

- every new client frame is accepted with exact keys, and rejected with an extra key, a missing key, a fractional or negative number, or a bad enum;
- `hotbarSet` with `entry: {kind:'item', code:'X', extra:1}` → rejected;
- `chat` with `to` and with `channel`, with a bad name (`'ab'`, `'1abc'`);
- server round trips, with unknown keys dropped;
- `welcome.server.world` and `worldEnter.world.levelCap` are kept; a malformed `world` is rejected;
- `skills.hotbar` of length 39 is rejected;
- `effects` longer than 32 is rejected;
- every `GameplayRequest` has a `CLIENT_RATE_LIMITS` row.

**Check:** `pnpm vitest run packages/shared/test` and `pnpm typecheck` are green. Typecheck fails in app code only where `Record<ClientMessage['t'], …>` tables (for example `mock.ts`) need new keys. W3-P adds `not_implemented` placeholders there, and nothing else.

### 4.2 W3-FS and W3-FC: seams (two agents, parallel, after W3-P)

**W3-FS** owns §3.1:

- `apps/server/src/modules.ts`;
- the listed hunks in `gameplay.ts`, `world.ts`, `gm.ts`, `connection.ts`, `inventory.ts`, `db.ts` and `config.ts`;
- stubs: `skills/engine.ts`, `npc.ts`, `shop.ts`, `storage-db.ts`, `item-use.ts`, `chat.ts`;
- test `apps/server/test/modules.test.ts`:
  - routing covers every wave-3 `GameplayRequest` exactly once;
  - a dead player's `npcClose` passes and `shopBuy` gets `dead`;
  - `moved`/`stopped`/`playerDied`/`warped('gm')` fan out;
  - a decorator's field appears in `state()`;
  - migration v4→v6 on a copy of a v4 database.

  The existing tests (`gameplay-units`, `gameplay-e2e`, `wave2-e2e`, `role-policy`) stay green with **unchanged** behaviour.

**W3-FC** owns §3.2–§3.3:

- `world/features.ts` and the stubs;
- the listed hunks in `screens/world.ts`, `world/entities.ts`, `hud/index.ts`, `hud/slots.ts`, `hud/intents.ts`, `world/intents.ts`, `i18n/en.ts`, `net/mock.ts`;
- new `hud/keys.ts`, `hud/cooldowns.ts`, `hud/menu-items.ts`, `hud/menubar.ts`, `world/level-band.ts`, the i18n files and `net/mock/index.ts`;
- tests in `apps/game/test/seams.test.ts`:
  - KeyMap per UX_GAPS §8 UX-A (fed through `handle()`);
  - CooldownClock (set, remaining, change events);
  - `levelBand` boundaries;
  - menu items in order;
  - `routeBagAction` stack order;
  - every new intent builder passes `parseClientMessage`.

  The existing `world.test.ts` send rule still passes.

**User check after both land:** nothing visible changes except that I and C still work, and the Esc menu looks the same.

### 4.3 SK-S: skills server engine

**Owns (new):**

- `apps/server/src/skills/engine.ts`: `SkillEngine implements GameplayModule`. Handles `useSkill`, `skillLearn`, `masteryUp`, `buffCancel`, `hotbarSet`; `whileDead: ['hotbarSet']`.
- `apps/server/src/skills/`:
  - `book.ts`: `SkillBook` over `skills.json`/`masteries.json`: by code and group, `maxLearned`, `nextRow`, `chain`;
  - `learn.ts`: SP, mastery cap ≤ level, total ≤ `CH_MASTERY_TOTAL` 330, costs from `levels.json` `masterySp`;
  - `store.ts`: SQL on the v5 tables;
  - `timing.ts`: t0, releaseAt, endAt, chains, projectile arrival;
  - `targeting.ts`: `efr` shapes caster, target, pierce, projectile_pierce, chain; nearest first; `maxTargets`;
  - `effects.ts`: the Effect model, overlap classes, the mod tag table, toggles, statuses, DoT ticks;
  - `mods.ts`: `StatMod` application for `playerCombatStats`;
  - `gm-skill.ts`: the GM `skill <code|all> [level]` command body.
- `apps/server/test/skills-{book,learn,engine,effects,e2e}.test.ts`.

**Also owns:** `apps/server/src/formulas.ts` (imbue component, mods step, `reductionPct`, `da`, `cr`).

**Hook points (exact):**

- `gameplay.ts`:
  - extract `dealHits(a, t, hits: CombatHit[], extra: {skill?, instance?, at?, aoe?}, now)` from the body of `attack()` (decision 15). `attack()` calls it;
  - in the attack branch of `tickPlayer`, the interval and hit table come from `this.skills.basicFor(p)`;
  - `refresh()` / `combatFor()` apply `this.skills.modsFor(p)`: passives, buffs and the move-speed multiplier into `p.speedMul` (combined with GM speed);
  - `createMob`: mob skill state (stretch).
- `world.ts`: register the `effects` decorator from `engine.ts`, not in `world.ts`. **No `world.ts` edit.**
- `gm.ts`: one `COMMANDS.skill` entry delegating to `skills/gm-skill.ts`. Same role checks and audit as every GM command (PROTOCOL §10).
- `ai.ts` (**P2 stretch**): mobs pick from `MobDef.attacks` and call `engine.startMobSkill`.

**Skill coverage (41 lines + basics) [confirmed from `skills.json` groups and params]:**

- **P0: the SKILLS §10.4 slice and the core paths** (must ship):
  - basics `SKILL_CH_{SWORD,SPEAR,BOW}_BASE`, `SKILL_PUNCH`;
  - `SWORD_SMASH_A` (single hit);
  - `SWORD_CHAIN_A` (chain ×3);
  - `SWORD_GEOMGI_A` (own range 12 m, projectile);
  - `COLD_GIGONGTA_A` (imbue with fz/fb);
  - `COLD_GANGGI_A` (READY/WAIT/SHOT, timed `defp` buff);
  - `WATER_HEAL_A` (friendly target heal).
- **P1: the same engine paths across the other lines** (should ship):
  - attacks: `SPEAR_PIERCE_A` (pierce), `SPEAR_FRONTAREA_A` (target area), `SPEAR_ROUNDAREA_A` (caster area), `SPEAR_STUN_A` (stun), `BOW_CRITICAL_A` (prepare + `cr`), `BOW_CHAIN_A` (`mc` 2), `BOW_PIERCE_A` (projectile pierce), `SWORD_KNOCKDOWN_A` (`ko`), `SWORD_DOWNATTACK_A` (`reqc` + `da`), `LIGHTNING_CHUNDUNG_A` (force target area);
  - imbues: `LIGHTNING_GIGONGTA_A` (chain bounce), `FIRE_GIGONGTA_A` (burn DoT);
  - `COLD_GIGONGJANG_A` (debuff projectile; `tant` = the mob targets the caster [decision]);
  - `WATER_SELFHEAL_A`;
  - the 7 passives: `SWORD_PASSIVE_A` (br + reqi shield), `SPEAR_PASSIVE_A` (hpi), `BOW_PASSIVE_A` (hr), `COLD_PASSIVE_A` (defp), `LIGHTNING_PASSIVE_A` (er), `FIRE_PASSIVE_A` (dru), `WATER_PASSIVE_A` (mpi);
  - buffs with plain mods: `SPEAR_SPIN_A` (defp MD), `LIGHTNING_GWANTONG_A` (dru), `LIGHTNING_GYEONGGONG_A` (hste), `FIRE_GONGUP_A` (dru), `FIRE_GANGGI_A` (defp MD), `BOW_CALL_A` (hr), `SWORD_SHIELD_A` (defp + reqi shield).
- **P2: special mods** (cut first within skills):
  - `COLD_BINGBYEOK_A` (`onff` toggle + `pw` absorb wall);
  - `COLD_SHIELD_A` (`dgmp`: part of the damage from MP);
  - `FIRE_SHIELD_A` (`bgra`: lower incoming status chance);
  - `BOW_NORMAL_A` (`ru`: range +);
  - `SWORD_SHIELDPD_A` (`spda`);
  - `WATER_CURE_A` (`curt`/`curl`/`rcur`);
  - `WATER_RESURRECTION_A` (`resu`, decision 14);
  - mob skills in `ai.ts`.
- **Units still [unknown]** (SKILLS §10.6): `defp` values < 20 are treated as % and ≥ 20 as flat [decision]; `ru` is taken as metres × 0.1. Status durations come from config: freeze 2 s, frostbite 5 s, shock 5 s, burn 5 s at 1 s ticks, knockdown 2 s.

**Tests (vitest, synthetic world via `test/fixtures.ts`):**

- **Validation reasons** in SKILLS §10.1 order: `not_found`, `not_learned`, `dead`, `cant_act`, `wrong_weapon`, `requirements`, `no_ammo` with `SKILL_AMMO=1`, `cooldown`, `not_enough_mp`, `invalid_target`/`target_dead`, `safe_zone`.
- **Timing:**
  - release at prepare + cast, end at + action, ±1 tick;
  - chain progression, and abort on target death (`castEnd target_lost`);
  - projectile `combat.at` = delay + distance / speed.
- **AoE:**
  - `maxTargets` includes the primary; secondaries get `aoe: true` and `reductionPct` applied;
  - pierce line;
  - chain bounce.
- **Imbue:** adds a magical component to a **basic** hit, rolls statuses, and a new imbue replaces the old (`effectRemove replaced`).
- **Buffs:** overlap replacement, expiry → `effectRemove expired` + `stats`, `buffCancel`, toggle drain to 0 MP.
- **Passives:** `stats` totals after learn; `hpi` raises `maxHp`.
- **Crowd control:** a stunned mob does not act; a knocked-down target enables `DOWNATTACK`, and it fails `invalid_target` otherwise.
- **Learning:** `masteryUp` costs 1,1,1,2,… (SKILLS §1.2); the cap ≤ level (`mastery_cap`); `no_sp`; `skillLearn` needs the previous row.
- **Hotbar:** persisted; `kind:'item'` accepted only for usable items (decision 7).
- **Interrupts:** `moveTo`/`stopAction` before release → `castEnd interrupted|cancelled`, and the cooldown stays; after release, nothing is interrupted.
- **Effects:** a late joiner gets `EntityState.effects`; death clears everything except passives.
- **`skills-e2e.test.ts`** (real sockets):
  - enter → `skills` after `inventory`;
  - GM `skill all` → `skillsUpdate`;
  - `useSkill SMASH` on a spawned Mangyang → `actionResult` → `cast` → `combat {instance, skill}`;
  - 11 `useSkill` back to back → `rate_limited`.
- `role-policy.test.ts` stays green.

**User check:** these need SK-C.

1. As a GM, `/skill all` (or `/sp 5000` if SK-S adds it to its own command), then learn masteries in the skill window.
2. Put Strike Smash, Illusion Chain, Soul Cut Blade, Ice River Force, Weak Guard of Ice and Heal on keys 1–6. Cast each on a Mangyang: the MP drops, the cooldown sweeps, the damage numbers appear at the hit, and the buff icon counts down.

### 4.4 SK-C: skills client

**Owns (new):**

| File | Contents |
|---|---|
| `apps/game/src/content/skills.ts` | `SkillCatalog`: by code and group, `maxLearned`, `nextRow`, tooltip lines |
| `hud/skills.ts` | Skill window (S, alias K; two tabs, one page per mastery, `+` and up buttons, drag source) |
| `hud/hotbar.ts` | 40 slots, keys 1–0, pages F1–F4, drag from the skill window and inventory, right-click clears, sends `hotbarSet`/`useSkill`/`itemUse` |
| `hud/buffs.ts` | Buff bar under the player frame; right-click → `buffCancel` |
| `world/skills-view.ts` | `ActionPlayer`: `cast` → READY/WAIT/SHOT; `combat {instance}` hits at `hitCues`/`at`; `castEnd`; chain continuity |
| `world/skill-fx.ts` | `@sro/fx` stage scheduling from `/out/fx/skills.json` [confirmed file exists]; ACT_L loops as `EntityAttachment`s |
| `world/features/skills.ts` | The WorldFeature |
| `i18n/en-skills.ts` | Strings |
| `net/mock/skills.ts` | Optional |
| `apps/game/test/skills.test.ts` | Tests |

**Also owns** after W3-FC: `hud/cooldowns.ts` and `hud/slots.ts` (drag source).

**Hook points:**

- `content/gameplay.ts` `ContentTables`: add `skills` and `masteries` (both already in `CONTENT_FILES` [confirmed]).
- `three/models.ts`: `KEEP_CLIPS` regex += `SKILL_\d+|READY\d+|WAIT\d+|SHOT|DOWN\w*|STUN\w*`; `FAMILY_ATTACK.blade`/`FAMILY_PACK.blade` → sword; new `CharacterActor.playSkill(phases, speed)` (decision 17).
- `hud/target.ts`: `setEffects(list)` and its row.
- `screens/world.ts` `onCombat`: when `msg.instance` is set, hand the message to `ActionPlayer` instead of the default timeline. The ActionPlayer calls `presentHit(msg, i)` (W3-FC) at each cue. About 4 lines.
- The death overlay closes on the own `entityUpdate {state:'alive'}` (decision 14). 1–2 lines in `screens/world.ts` `onEntityUpdate`.
- `hud.keys` registrations (`s`, `k`, `1`–`0`, `f1`–`f4`), from its own files.
- Sound: call `gameAudio()?.skillStage(...)` and `EntitySound.setSkill(group)` when present (SOUND §5.9). This is a guarded call; the lane does not import sound internals.

**Tests:**

- `SkillCatalog` over a `skills.json` fixture: `nextRow`, the locked reason, the tooltip numbers of Strike Smash L1 (19 MP, 411/1022/3000);
- hotbar model: page switching, item entries resolving to the lowest bag index, greyed without the item or MP, the cooldown key names;
- `ActionPlayer` timeline with a fake clock: READY→WAIT→SHOT durations; hit *i* at `hitCues[i]`; a projectile at `at`; `castEnd` stops;
- a chain does not restart the clip;
- every builder passes `parseClientMessage`.

**User check:** as SK-S, plus:

- S (and K) opens the window;
- dragging an HP potion onto slot 0 and pressing 1 drinks it, with the sweep;
- blades now swing a sword instead of punching.

### 4.5 NPC-S: NPC dialogs, shops and consumables (server; SHOPS lanes A and C)

**Owns:**

- `apps/server/src/npc.ts`: `NpcDialogs` (handles `npcTalk`, `npcClose`; `whileDead: ['npcClose']`; `tickPlayer` runs the `talk` action and the `too_far` auto-close; `playerDied` → close `dead`; `warped` → close `warp`, for both town and GM; `forget`); `HIDDEN_NPCS = ['NPC_CH_WAREHOUSE_M']`; `servicesOf`; `requireService`; `onQuest` service hook (a `topics?: (p, code) => boolean` callback, wired in wave 4).
- `apps/server/src/shop.ts`: `Shops` (`shopBuy`/`shopSell`/`shopBuyback`, the cap filter with `config.levelCap`, `maxStack × bagSize`, strict gold, 5-entry buyback).
- `apps/server/src/item-use.ts`: `ItemUses` (`itemUse`; `moved`/`stopped`/`playerDied`/`tickPlayer`; the §1 decision-9 exclusions; `itemCooldown`/`itemCast`/`itemCastEnd`).
- Tests: `apps/server/test/{npc-shop,item-use}.test.ts`.

**Hook points:**

- `gameplay.ts` `start()`: skip `HIDDEN_NPCS` (1 line).
- `gameplay-e2e.test.ts`: append one round (talk → dialog → buy → sell → buyback, and the 11× `shopBuy` rate-limit check).
- **No other shared edits**: routing, death and warp come from the seams.

**Tests:** SHOPS §9 lanes A and C lists, verbatim. Also:

- a `useSkill` during a return cast → `itemCastEnd interrupted`;
- a return-scroll use during a skill action → `busy`.

**User check:** SHOPS lane A steps 0–6 and lane C steps 1–4. The e2e test uses Return Scroll 03 (5 s) for the timing.

### 4.6 NPC-C: NPC dialog, shop, storage, cast bar (client; SHOPS lanes D and E)

**Owns (new):**

- `hud/npc-dialog.ts`: `NpcDialogWindow` with `onShop`, `onStorage`, `onEnd`, `onQuest` (decision 1);
- `hud/shop.ts`, `hud/shop-logic.ts`;
- `hud/storage.ts`, `hud/storage-state.ts`;
- `hud/item-cast.ts`;
- `world/features/npc.ts`: `clickEntity` for NPCs → `npcTalk`; Escape closes the dialog; `itemCooldown` → `hud.cooldowns.set('item:'+group, …)`; right-click routes through `hud.routeBagAction`;
- `i18n/en-shops.ts`;
- `net/mock/npc.ts` (optional);
- `apps/game/test/{shop,storage}.test.ts`.

**Hook points:** none beyond the seams. `hud.claimRequests([...])` is called from the feature.

**Tests:** SHOPS §9 lanes D and E, plus the `npcTalk` builder already tested by W3-FC.

**User check:** the SHOPS lane D and E checks in the browser:

- Herbalist dialog with his greeting (after SHOPS lane F; this plan folds lane F into SND-X's agent, see §4.8), or the generic line;
- the armour trader's gender tabs;
- the return-scroll bar;
- the potion sweep on bag slots.

### 4.7 ST-S: storage (server; SHOPS lane B; first to cut)

**Owns:** `apps/server/src/storage.ts` (pure rules), `apps/server/src/storage-db.ts` (`StorageService`: `storageOpen`, `storageDeposit`, `storageWithdraw`, `storageMove`, `storageGold`), and `apps/server/test/storage.test.ts`.

**Hook points:** none. Migration v6, `writeDraft`, `stackable` and `storageFee` come from W3-FS.

**Tests:** SHOPS §9 lane B, verbatim. The migration test runs from **v5** to v6 on a temp `DATA_DIR`.

**User check:** SHOPS lane B steps 1–5.

**If cut:** the dialog never offers `'storage'` (`servicesOf` checks `this.storage.enabled`), and NPC-C's storage window stays unreachable.

### 4.8 SND-X: sound export (+ SHOPS lane F exporter additions)

**Owns:**

- `packages/shared/src/sound.ts` (+ one `index.ts` export line, after W3-P);
- `packages/convert/src/sound/*`, `packages/convert/src/tools/export-sound.ts`;
- `packages/convert/test/sound{,.out}.test.ts`;
- **SHOPS lane F**, sequentially after the sound export: `packages/convert/src/data/{items,npcs,client-source}.ts` (keepFee col 30, repairCost col 27, canRepair col 22, `use.cooldownMs` 1000, NPC greetings) and its tests.

**Hooks:**

- `apps/server/src/static.ts` `COMPRESSIBLE += '.wav'`;
- `apps/game/vite.config.ts` MIME `.wav`;
- `docs/ASSETS.md` §2 row.

**Tests and check:** SOUND §6 lane 1 and SHOPS lane F, verbatim. Expect about 590–600 files and 29 MB → about 4 MB of Opus, with about 21 unresolved paths.

After this lane, re-run `export-data --no-icons` and `export-sound`.

### 4.9 SND-C: sound runtime

**Owns:**

- `apps/game/src/audio/**` (SOUND §5.14; `audio.ts` becomes a re-export);
- `hud/sound-settings.ts`;
- `world/features/sound.ts`;
- `i18n/en-sound.ts`;
- `apps/game/test/audio.test.ts`.

**Hook points** (the seams replace most of SOUND §6 lane 2's list):

- `main.ts`: create `GameAudio`, the `gameAudio()` accessor, install `ui-sounds`, and the **corner block**: master mute + L3 engine-badge removal (decision 21).
- `app.ts`: `audio` constructor field, appended last.
- `three/models.ts`: the SND-C hunks of decision 17.
- `hud/window.ts`: open/close cues and `data-sfx="none"` on the close button.
- `hud/index.ts` `toast(…,'error')` → `ui.error`, and the equip cue in `applyInventoryUpdate` (2 lines).
- Everything else goes through the feature:
  - `onCombatHit` → `audio.hit`;
  - `onMessage` handles `levelUp`, `spawn` gold, `actionResult` pickup;
  - `onFrame` → `setListener`;
  - `onTownChange` → `setArea`;
  - an `EntityAttachment` per view for clip sounds, registered through `ctx.attachments` from `features/sound.ts`, which W3-FC wires;
  - `registerMenuItem({id:'sound', order: 30})`.

**Tests and check:** SOUND §6 lane 2, verbatim. Add a `SurfaceProbe` case for a missing streamed region → Dirt (decision 51).

### 4.10 FLD-X, then FLD-S: fields export, then server (one agent, sequential)

**FLD-X owns** FIELDS lane 1's files:

- `packages/convert/src/world/{convert-world,manifest,nav,worldmap,places}.ts`;
- `data/zones.ts`;
- the `export-data.ts` `--zones-world` hook;
- the `cli.ts` usage line;
- `packages/convert/test/world-stream.test.ts`.

**Extra, for the cut plan (§7):** also export a preset `jangan-near` (regions 166–170 × 95–99, non-streamed).

**FLD-S owns** `apps/server/test/fields.test.ts`. Hooks, per FIELDS lane 3:

- `game.ts` lines 133/144/169;
- `content.ts` `resolveWorld(outDir, folder, override, id = folder)`;
- `connection.ts` worldEnter `name` (the literal W3-FS already touched for `levelCap`);
- `gamedata.ts` `zones.json` + `zoneAt`;
- `spawner.ts` `NEST_COUNT_SCALE`;
- `apps/server/README.md`, `docs/DEPLOY.md`.

`config.ts` and the validator are already done by W3-FS / W3-P.

**Tests and check:** FIELDS lanes 1 and 3, verbatim. The numbers are the fact-checked ones: 307 regions, 2,281 object instances, ≥ 700 nests, > 6,500 mobs.

### 4.11 FLD-R: `@sro/world-render` streaming

**Owns:**

- FIELDS lane 2's files: `packages/world-render/src/{stream,region-chunk,model-cache,tile-atlas}.ts` (new), and edits to `world.ts`, `terrain.ts`, `objects.ts`, `water.ts`, `regions.ts`, `minimap.ts`, `nav.ts`, `assets.ts`, `materials.ts`, `textures.ts`, `index.ts`;
- tests.

**Also:** `RegionStreamer.setSettings(partial)` (decision 50).

**Hooks:**

- `packages/nav/src/world.ts`: `addRegion`/`removeRegion` **only**, after the integrator's commit. The reachability work there is theirs.
- `apps/viewer/src/world/main.ts`: `?stream=`.

**Tests and check:** FIELDS lane 2, verbatim.

### 4.12 FLD-C: game integration and the world map

**Owns:**

- `apps/game/src/world/map/{worldmap,hunting,zones}.ts`;
- `world/features/map.ts`: key `m` via `hud.keys`, `hud.openWorldMap`, `setFocus` on `worldEnter`/self `warp`, stream stats for UX-A's perf overlay;
- `i18n/en-fields.ts`;
- `apps/game/test/worldmap.test.ts`;
- `world/jangan/ground.ts` (decision 52), including the live `isGround` fix.

**Hooks:**

- `screens/world.ts`: the `loadJangan` call passes `focus` and `world` from `app.session.server?.world ?? 'jangan'`; the loading screen awaits `stream.whenReady`. About 4 lines.
- `world/jangan/heights.ts`: the `navCovers` guard on `selfMove`.

**Tests and check:** FIELDS lane 4, verbatim. The **M** window is here (decision 22).

### 4.13 UX-A: HUD shell, settings, robustness

**Owns:**

- after W3-FC: `hud/keys.ts`, `hud/menu-items.ts`, `hud/menubar.ts`;
- new: `settings.ts`, `hud/options.ts`, `hud/keyhelp.ts`, `hud/perf-overlay.ts`, `hud/ux-style.ts`, `net/resume.ts`, `i18n/en-ux.ts`, `apps/game/test/ux-shell.test.ts`.

**Hooks** (UX_GAPS §8 UX-A, minus what the seams did):

- `screens/world.ts`: the `stats` element → `perf.update`; the `help` element → the H hint; F9/F8 into `hud.keys`; `setQuality(qualityFor(...))` + `settings.onChange` → also `world.stream?.setSettings`.
- `app.ts`: `updateScale`, `showBanner` net-down, `clearSession`.
- `main.ts`: `applyGraphics`, the resume attempt. **Not** the corner block.
- `screens/login.ts`: `tokenExpiresAt`.
- `screens/servers.ts`: `saveSession`.
- `net/session.ts`: the close reason.
- `world/jangan/ground.ts`: the one guest line.
- `hud/inventory.ts`: pass `canUse(...)` to `SlotView.set`.
- `hud/items.ts`: `canUse`.
- `style.css` lines 7–9: fonts.
- `registerMenuItem` for Options and Key help.

**Scope:** P0 H1, H2, W1, (K1 done by W3-FC); P1 L1, L2, H3, W2, W3, R1, R3, R4, R5, R6. L3 moved to SND-C.

**Tests and check:** UX_GAPS §8 UX-A, verbatim.

### 4.14 UX-B: world feel, chat, minimap (+ whisper and GM tag on the server)

**Owns:**

- `world/nameplates.ts`, `world/autoloot.ts`, `world/move-feedback.ts`, `world/camera-keys.ts`;
- `world/features/ux-world.ts`;
- the existing `world/chat.ts` and `world/jangan/minimap.ts`;
- after W3-FC: `world/level-band.ts`;
- `i18n/en-ux-world.ts`;
- `apps/server/src/chat.ts` (after the W3-FS stub);
- `net/mock/ux.ts` (optional);
- tests: `apps/game/test/ux-world.test.ts`, `apps/server/test/{whisper,gm-tag}.test.ts`.

**Hooks:**

- `apps/server/src/world.ts` `setStaff()`: broadcast `entityUpdate {id, gm}` (2 lines). The `gm` decorator is registered from `chat.ts` or a small `gm-tag.ts` it owns.
- `world/entities.ts` `refreshLabel()`: the `band-*` classes replace `hot`/`warm`; delete `mobTone`.
- `world/style.ts`: band and `.gm` CSS.
- `hud/target.ts` `set()`: gem and variant icon.
- `screens/world.ts`: `targetInfo()` gains `band`/`variant`; the pointer observer calls `moveFeedback` begin/end. About 6 lines; the rest goes through the feature.
- `packages/convert/src/tools/export-icons.ts` `HUD_SELECTION`: the minimap and worldmap lines.

**Scope:**

- P0 F1;
- P1 H4, F2, F3, C1, C2, C3, C5, M1 (with the FLD-C `zoneAt` label), M2 (`addMarkerSource` + `radius`/`icon`, decision 31), K3, K4, K5, K6, `registerPrefix` (decision 30);
- M3 moved to FLD-C.

**Tests and check:** UX_GAPS §8 UX-B, verbatim, minus the M-window step.

### 4.15 Wave 3 integration review (W3-I, one agent, after the lanes merge)

**Gates:**

1. `pnpm typecheck`.
2. `pnpm test` (all of vitest, including `role-policy.test.ts` unchanged).
3. `pnpm --filter @sro/game build`.

**Headless flows against the real server.** Use a temp `DATA_DIR`, `WORLD_EXPORT=jangan` first and then `jangan-fields`, and WebSocket clients built from `apps/server/test/helpers.ts`. Put them in a new `apps/server/test/wave3-e2e.test.ts`:

1. **Enter:** `worldEnter` (with `world.levelCap` and `self.effects`) → `stats` → `inventory` → `skills` (hotbar length 40), in order. `welcome.server.world` survives `parseServerMessage`.
2. **Learn:** GM `skill all`, or SP then `masteryUp BICHEON` ×5 → SP spent 1+1+1+2+2 = 7. `skillLearn SKILL_CH_SWORD_SMASH_A_01`. `hotbarSet 0 skill`. Relog → the hotbar persists.
3. **Cast:** `useSkill` on a GM-spawned Mangyang (outside the safe area) → `actionResult ok` → `cast` (prepare/cast/action from the row) → `statsDelta.mp` → `combat {instance, skill: …_01}`. Then:
   - a second use within 3 s → `cooldown`;
   - `moveTo` during the prepare of a charged skill (`BOW_CRITICAL`) → `castEnd interrupted`.
4. **Chain, imbue, buff:**
   - Illusion Chain → 3 `combat` messages sharing `instance` chains;
   - Ice River Force → `effectAdd` on self, and the next basic attack's damage > the base range;
   - Weak Guard of Ice → `effectAdd` + `stats` PD up; `buffCancel` → `effectRemove cancelled` + PD back;
   - a second client entering later sees `effects` on the caster.
5. **Heal and resurrect (P2):** a 2nd player at partial HP → `Heal - Medical Hand` raises it. If P2 landed, kill the 2nd player (`gm kill`) and resurrect → `entityUpdate state alive`.
6. **NPC and shop:**
   - `npcTalk` on the Herbalist from 30 m → `move`… `stop` → `npcDialog {services:['shop']}` + `buyback`;
   - `shopBuy` 10 `ITEM_ETC_HP_POTION_01` (HP Recovery Herb) [confirmed code];
   - `shopSell` 5 → `buyback` list; `shopBuyback 0` → gold back exactly;
   - `tp` 20 m away → `npcDialogClose too_far`;
   - `NPC_CH_WAREHOUSE_M` (Wangu and the storage chest) is spawned next to Sansan (decision 8, revised).
7. **Consumables:**
   - an HP potion → `itemCooldown {group:'hp'}`; a second within 1 s → `cooldown`;
   - `ITEM_ETC_SCROLL_RETURN_03` → `itemCast 5000`; `moveTo` → `itemCastEnd interrupted` and the scroll is kept;
   - again, wait 5 s → `inventoryUpdate` → `itemCastEnd done` → `warp` to the GATE_CH town point.
8. **Storage** (if ST-S landed): `storageOpen` at Sansan → deposit a sword + 1000 gold. A second character of the same account withdraws both. A deposit at the Smith → `not_found`.
9. **Chat:**
   - whisper A→B arrives at B and echoes to A, and C gets nothing;
   - `/`-text whisper delivered, not run as GM;
   - `channel:'party'` → `error bad_request`;
   - GM grant through the DB → `[GM]` `gm: true` in the entities of others within the 1 s role poll; revoke → `entityUpdate gm:false`.
10. **Fields** (`WORLD_EXPORT=jangan-fields`):
    - log `307 regions`, ≥ 700 nests, > 6,500 mobs;
    - `tp north-tiger-mt` works; `tp jangan` still lands at the town;
    - death → respawn at GATE_CH;
    - 10 idle clients plus 2 fighting for 10 s: mean tick < 10 ms. Record max/p99 in the review notes for the N100 projection.
11. **Abuse:**
    - every new client type with an extra key → `bad_request` + strike;
    - `hotbarSet` slot 40 → `bad_request`;
    - `storageGold` 0 → `bad_request`;
    - `useSkill` of an unlearned skill → `not_learned`.

**Manual browser checks (list them for the user in the morning):** the "how to check" lists of SK-C, NPC-C, SND-C, FLD-C, UX-A and UX-B. Run once on `?mock=1` if the mocks landed, and once on the real server.

**Fix-forward rule:** the reviewer fixes integration bugs in the seam files and in any lane's files. A behaviour decision it cannot make goes into §8 of this doc.

**W3-I results (2026-09-28).** All gates green: `pnpm typecheck`, `pnpm test` (112 files, 1,196 tests, `role-policy.test.ts` unchanged), `pnpm --filter @sro/game build`, `pnpm --filter @sro/viewer build`. `apps/server/test/wave3-e2e.test.ts` runs flows 1–9 and 11 on both `jangan` and `jangan-fields`, plus flow 10 on `jangan-fields` (21 tests). Adjustments to the flow text above:

- Flow 6 talks to the Herbalist from the town spawn (62 m, not 30 m). Walking 20 m away closes the dialog with `too_far`; a GM `tp` closes it with `warp` (NPC-S's server-side close reason).
- Flow 4's PD check dresses the caster in degree-2 heavy armour first: Weak Guard of Ice is +2–5 % PD, which rounds to nothing on the starter clothes (§8 question 20).
- Flow 10 uses the adjusted fields numbers (≥ 690 nests, > 5,500 monsters; the export spawns 700 / about 6,080). Tick time with 10 idle and 2 fighting clients (skills and basic attacks) at 20 Hz on the desktop: mean 1.0 ms, p99 2.8–4.0 ms, max 7–9.3 ms.
- **The export for play is now `jangan-fields`.** `loadConfig` defaults `WORLD_EXPORT` to `jangan-fields` when `OUT_DIR/world/jangan-fields/` exists (world `jangan`), so the dev server plays the fields. The production deploy writes `WORLD_EXPORT=jangan-fields` (`deploy/config.sh` `DEPLOY_WORLD_EXPORT`) once the assets are on the mini PC. Tests that assert on the town export are pinned to it (helpers' `testConfig` has no `worldExport`).

---

## 5. Wave 4 (next)

### 5.0 Entry criteria

- The wave 3 gates are green.
- Wave 4 content work runs on the **`jangan-fields`** export (decision 46).
- If FIELDS was cut: Act I only, plus GM stand-in nests.

### 5.1 Steps

```
W4-P  protocol (quests.ts, §2.2, docs/PROTOCOL.md, shared tests)           ~1 h
W4-FS server seams (after W4-P):
      - migration v7;
      - reward() split into computeReward/applyProgress (decision 42);
      - mobDied credit seam with an optional `party` (decision 41);
      - module registration: quests, party;
      - whileDead additions;
      - config (CONTENT_DIR, QUEST_*, EDITOR_ROLE);
      - game.ts readJson(limit) + CORS PUT/DELETE;
      - gm.ts spawn counter skips `m.encounter`;
      - npc.ts `topics` callback wired to quests.hasTopics;
      - World decorator slots for `npc` / `ownerParty`;
      - createMob(…, tuning?);
      - stubs: quests/{engine,book,store,rewards,encounter}.ts, party.ts, editors/{overrides,nest-edit,npc-edit,quest-api}.ts
W4-FC client seams (parallel):
      - WORLD_FEATURES += quests, party, editors;
      - i18n spread en-{quests,party,editors}.ts;
      - intents for every wave-4 request (in quests/intents.ts and hud/intents.ts);
      - Hud.menubar registrations: Q (alias L), P
Lanes (parallel after the seams):
  QS-S  quest engine (server)            QUESTS lane B   (critical path)
  QS-C  quest UI (client)                QUESTS lane C
  PT-S  party server                     QUESTS lane D, server half
  PT-C  party client                     QUESTS lane D, client half
  ED-S  GM editors server                QUESTS lane E
  ED-C  GM editors client                QUESTS lane F   (after ED-S)
  CT    content + tuning                 new: playtest jangan.json on jangan-fields, fix LOC_* on the new navmesh,
                                         export ITEM_QNO_* icons (packages/convert export-icons HUD/QNO line)
  UX-R  remaining UX (P1 leftovers + chosen P2): H13 EXP in chat, C7–C9, M4, K7, K8 (Z nearest), K10, F9–F11,
        R2, R7, L5–L7, H6, H7, W5, W7, W9
W4-I  integration review
```

### 5.2 Lane ownership (wave 4)

Owned files are as in QUESTS §7. The changes from QUESTS §7 are listed per lane.

- **QS-S** owns:
  - `apps/server/src/quests/{book,engine,store,rewards,encounter}.ts`;
  - `apps/server/test/quests{,-e2e,-content}.test.ts`.

  Hooks: none beyond the W4 seams, apart from `world.ts` `Mob.encounter?`/`Npc.model?`. Its `mobDied` module hook consumes `credit`.
- **QS-C** owns:
  - `apps/game/src/quests/{catalog,state,markers,dialog,dialog-panel,log,tracker,format,intents}.ts`, `quests.css`;
  - `i18n/en-quests.ts`;
  - `world/features/quests.ts`;
  - tests.

  Hooks:
  - markers use `EntityView.setBadge('quest', …)`, so there is **no `entities.ts` edit**;
  - the minimap uses UX-B's `addMarkerSource`;
  - the dialog uses `NpcDialogWindow.onQuest`.
- **PT-S** owns `apps/server/src/party.ts` (PartyManager, `killShares`, `sameParty`) and `apps/server/test/party{,-e2e}.test.ts`. Hooks:
  - `apps/server/src/chat.ts`: replace the party-refusal branch (≈ 5 lines);
  - `connection.ts` `leaveWorld`/`enterWorld`: `party.offline`/`online` (2 lines);
  - `gameplay.ts` `pickupProblem` (`ownerParty`) and `pickUp` (gold split) (≈ 6 lines);
  - SK-S's friendly-target check calls `sameParty` for `party`-only areas (1 line in `skills/targeting.ts`, by PT-S with SK-S's consent in review).
- **PT-C** owns `hud/party.ts`, `hud/party-invite.ts`, `world/features/party.ts`, `i18n/en-party.ts` and tests. Hooks:
  - `hud/target.ts` `setActions` (Invite);
  - `ChatBox.registerPrefix('#')`;
  - `addMarkerSource` (party pins);
  - `setLabelClass('party')`.
- **ED-S** owns `apps/server/src/editors/*`, `apps/server/test/editors{,-e2e}.test.ts` and the optional `cli/content.ts`. Hooks:
  - `gm.ts` `COMMANDS` `nest`/`npc`/`content` (3 lines);
  - `spawner.ts` `addNest`/`updateNest`/`removeNest`;
  - `gamedata.ts` override layering;
  - `gameplay.ts` `placeNpc`/`removeNpc` extracted from `start()`;
  - `game.ts` `/api/gm/*` routes (the `readJson` limit comes from the seam).
- **ED-C** owns `apps/game/src/gm/editors/*`. Hooks: `gm/window.ts` tabs, `gm/commands.ts` builders, `i18n/en-editors.ts`.
- **CT** owns `content/quests/jangan.json` (any GM-verified fixes), `work/tmp/quests/check.ts` (kept; referenced by QUESTS.md) and, with the ED lane's consent, `content/spawns/*` promotions. It edits no code except one `HUD_SELECTION` line for the `ITEM_QNO_*` icons in `export-icons.ts`.
- **UX-R** owns the UX-A/UX-B files after wave 3, plus new files per item. Its hooks are the ones UX_GAPS lists for each item.

### 5.3 Tests and user checks (wave 4)

The lists in QUESTS §7 apply verbatim per lane. Additions:

- QS-S: kill credit through `modules.mobDied`, with and without a party.
- PT-S: `killShares` example 10/10/12 + Yeoha 235 → 88/88/106; share mode loot round robin; the gold split.
- CT: every `LOC_*` passes `nav.locate` on `jangan-fields`; every objective mob has a nest within 150 m of its hint (the rule used in the QUESTS fact-check).

### 5.4 Wave 4 integration review (W4-I)

**Gates:** as W3-I. Headless flows go in `apps/server/test/wave4-e2e.test.ts`:

1. Enter → `… skills → quests` (→ `party` when in one).
2. **Act I:**
   - accept JG_001 at Soldier Fengil (`npcDialog.services` contains `'quest'`);
   - `questTalk` at Hwangno → turn in → `statsDelta.gain.quest = 'JG_001'` and 5 herbs;
   - JG_002: GM-spawn 8 Mangyang, kill them → `questUpdate progress`… `ready` → turn in.
3. **Collect with quest items:** the drop goes to the quest bag (no ground item); `questAbandon` removes the quest items.
4. **`have` recount:** deposit (or sell) the item → `ready → active`.
5. **Daily:** turn in `JG_R01`, advance the clock past 04:00 → available again.
6. **Encounter** (`jangan-fields`): JG_025 `questUseItem` at `LOC_TIGER_SHRINE` → Tiger Girl spawns with `hpMul` HP; a second use → `cooldown`; GM `spawn` count unaffected.
7. **Party:**
   - invite → accept → both get `party`;
   - share-mode kill → both get EXP per the formula;
   - `#hi` reaches only the party;
   - kill credit for a member within 60 m who did no damage;
   - disconnect → `offline`, then removal after 120 s (fake clock in the unit tests).
8. **Editors:**
   - GM `/nest add MOB_CH_GYO 8 25` → mobs appear; restart → still there; `/nest undo`;
   - `PUT /api/gm/quests/JG_002` with count 3 → `contentChanged` + `questUpdate changed` → "3/3 ready";
   - as a player → 403 and an audit row;
   - `role-policy.test.ts` unchanged.
9. **Abuse:** extra keys on every wave-4 type; `partyKick` by a non-leader → `not_leader`; `questTurnIn` without `choice` when choices exist → `choice_required`.

---

## 6. Wave 5 (living world + skill VFX polish)

There are no protocol changes: visual only.

- **W5-G grass and plant scatter:**
  - owns new `packages/world-render/src/scatter.ts` + `scatter-assets.ts`, and a density table by tile type (the same `tile2d` `TILE2D_TYPES` words SOUND §2.4 maps to surfaces: Grass, LongGrass, Forest dense; Dirt, Sand sparse; Stone, Water none);
  - thin instances per streamed region chunk (created in `RegionStreamer` commit jobs and disposed with the region);
  - `QualitySettings.scatter` (off / low / medium / high); settings row in UX-A's Options;
  - wind sway in the vertex shader;
  - N100 budget: ≤ 1.5 ms/frame at medium.
  - Hooks: `world-render/src/stream.ts` (a `scatter` job type), `world.ts` quality plumbing, `apps/game/src/hud/options.ts` (one row).
  - Tests: deterministic placement per region seed; no instances on road/stone/water tiles; disposal with the region.
  - Art: retail grass/flower meshes if the export has them [unknown: needs a census of `prim/mtrl` / `res/bldg` grass]; else simple procedural cards.
- **W5-V skill VFX polish:**
  - owns `apps/game/src/world/skill-fx.ts` and `packages/fx/**`;
  - work: SKILLS §7: skilleffect stages (READY / SHOT / ACT_S / ACT_L / DMG), projectiles (Soul Cut Blade, arrows), hit sparks (DamageEfp), status loops (freeze, burn, shock, stun stars), buff ACT_L loops on carriers, imbue weapon glows;
  - convert `fx/skills.json` gains `dmg`/`kill`/`sound` (SKILLS §10.5 item 4);
  - tests: stage schedule from `hitCues` with a fake clock; no leaks after 1,000 casts (disposed-mesh counter).
- **W5-P N100 performance pass:**
  - measure on the mini PC: `worstTickMs`, and client FPS with 5 players on an N100 laptop profile;
  - apply the FIELDS §4.4 server options only if needed; client LOD/scatter caps.
- **W5-I integration review:** the wave-3/4 e2e tests plus a visual checklist.

---

## 7. Risks and the order to cut scope

### 7.1 Risks

1. **Seam steps are the bottleneck.** If W3-FS/FC slip, every app lane waits.
   - Mitigation: the convert lanes (SND-X, FLD-X, FLD-R) start at T0.
   - SND-C and SK-C can build their pure modules (catalog, driver, ActionPlayer, voices) on fixtures before the seams land.
2. **`gameplay.ts` refactor risk (W3-FS).** Moving `itemUse`/shop bodies and adding module routing could change behaviour.
   - Mitigation: move the code unchanged, and do not start lanes until the existing `gameplay-*`, `wave2-e2e` and `review` tests are green.
3. **Integrator overlap.** The integrating agent has uncommitted edits in `connection.ts`, `nav.ts` and `packages/nav` [confirmed].
   - W3-FS and FLD-R's nav hook start after that commit.
   - No lane edits `packages/nav/src/reach.ts`.
4. **Skills breadth.** 41 lines is a lot for one server lane. The P0/P1/P2 tiers are the in-lane cut order, and unknown units (`defp`, `ru`, status durations) are config.
5. **Streaming unknowns** (FIELDS §8): partial texture-array upload, main-thread tile decode, skinned clone cost.
   - The fallback is the `jangan-near` 5×5 non-streamed preset: about 28 MB on the wire, which is what the streaming window loads at Jangan [likely, from FIELDS §2.3].
6. **N100 performance** is projected, not measured (FIELDS: ×2.5).
   - New per-frame work: nameplate layout, sound polling, streaming jobs, fx.
   - W3-I records tick and frame numbers; W5-P acts on them.
7. **`world.ts` hunks outside the seams** (SK-C `onCombat`, UX-B pointer and `targetInfo`, FLD-C `loadJangan`, UX-A stats/help/quality) can still conflict textually. Each is ≤ 6 lines, anchored by code rather than line numbers. Merge order: SK-C, UX-A, UX-B, FLD-C.
8. **Opus in Safari, loop seams, left/right panning.** See SOUND §7. The friends are assumed to use Chrome, Edge or Firefox.
9. **Economy feel.** The return scroll is now a 30 s cast, potions have a 1 s cooldown, and new characters start with 0 gold. `GOLD_RATE` is the knob; a playtest decides.
10. **Gameplay changes friends will notice:**
    - the return scroll works in combat but takes 30 s;
    - blades swing swords;
    - skills cost MP.

    Put these in the morning notes.
11. **Deploy size.** About 650 MB of fields assets plus about 4 MB of sound on the first deploy (FIELDS). Tailnet sync time is [unknown].
12. **Role policy.** The GM `skill` command and the editors must go through the existing role checks. `role-policy.test.ts` is a gate at every review.

### 7.2 Scope-cut order

Cut from the top.

**Wave 3:**

1. Mock extensions (`net/mock/*`).
2. ST-S storage and the storage UI path (the dialog stops offering storage).
3. Buyback (the server keeps no list; the tab is hidden).
4. UX-B K4, K5, K6 (hold-to-move, blocked feedback, camera keys) and C3/C5 (chat tabs, scroll-back).
5. SK-S P2 lines (special mods, cure, resurrect, mob skills).
6. The FLD-C world map window. Keep streaming and the minimap zone label.
7. SND-C ambience and remote-player spatial polish. Keep UI, hit, step and level-up sounds.
8. UX-A R3, R4, R6 (small screens, resolution, fullscreen) and H3 (menu bar).
9. SK-S P1 lines, keeping at least one area attack and one passive per mastery.
10. **Last resort:** streaming. Ship `jangan-near` (5×5, non-streamed) with the server on the matching export.

**Never cut:** the seams, the P0 skills slice with the hotbar, the NPC dialog with buy/sell and potions, basic sound, the UX P0s, `role-policy.test.ts`.

**Wave 4:**

1. ED-C (editors client; the GM uses slash commands).
2. The quest editor over HTTP (repo file edits only).
3. Party share-mode loot round robin and the gold split (keep EXP share).
4. Dailies (R01–R04).
5. The Tiger Girl bell encounter (JG_025 falls back to "kill Tiger Girl").
6. UX-R.

**Never cut:** the quest engine and Act I, the party invite + EXP share + party chat, and the `nest` GM editor.

---

## 8. Open questions (collected; each has a default so nobody waits)

| # | Question | Default used tonight |
|---|---|---|
| 1 | Arrow consumption for bows (retail: yes) | `SKILL_AMMO=0`, off |
| 2 | Skill cooldown persistence across a server restart | Not persisted; only across a relog in the same process |
| 3 | `defp` / `ru` units; status durations; `reductionPct` meaning | `defp` < 20 = %; `ru` × 0.1 m; config durations; `reductionPct` = secondary-target damage reduction |
| 4 | S vs K for the skill window | S, with K as an alias |
| 5 | Return scroll: 30/15/5 s, consumed at completion | As SHOPS |
| 6 | Potion cooldown 1 s per group | As SHOPS |
| 7 | Storage per account, 150 slots, fee per unit | As SHOPS |
| 8 | Hide `NPC_CH_WAREHOUSE_M` | Revised: placed. It is the storage chest Sansan sits on, not a duplicate (docs/SHOPS.md §1.3) |
| 9 | Party EXP formula (level-weighted + 10 %/member) | As QUESTS |
| 10 | Quest daily reset hour / timezone of the mini PC | 04:00 server local |
| 11 | Editor role | `gm` |
| 12 | Q and L both bound | Yes |
| 13 | Monster density on the fields | `NEST_COUNT_SCALE=1` (retail counts) |
| 14 | Unnamed regions in the HUD label | Nearest named zone within one region, else "Unknown area" |
| 15 | Safari support | Not a target; `--also-wav` exists |
| 16 | Buyback cleared on logout | Yes (memory only) |
| 17 | GM tag visible to everyone | Yes (SRO shows [GM]) |
| 18 | Refresh resume via `sessionStorage` token | Yes (private tailnet) |
| 19 | Retail grass/flower meshes for wave 5 | Census first; procedural cards otherwise |
| 20 | `defp` buffs (Weak Guard of Ice +2–5 %) show no PD change on starter armour (14 PD stays 14) | Keep percent (question 3); the gain shows with better armour |
| 21 | Default world export for play | `jangan-fields` (W3-I); `WORLD_EXPORT=jangan` in `silkroad.local.env` goes back to the town map |
| 22 | Friendly skill (heal, cure) with a monster selected | Lands on the caster (SK-S; retail unconfirmed) |
| 23 | A potion used at full HP | Consumed (unchanged; retail unconfirmed) |
| 24 | Monster skills (mobs.json `attacks`) | Not built in wave 3; monsters keep the basic attack (formula and `AI_AttackChance` unconfirmed) |
| 25 | World-map hunting labels for the 91 nests the server does not spawn (Western China, across the river) | Still labelled (the client has no reachability data) |
| 26 | Character-select location and the "Welcome to ..." line use the zone name ("Grassland") | Yes |
| 27 | A pickup within reach during a return-scroll cast | Does not interrupt it (only a pickup walk does) |
| 28 | Party share mode: EXP for a dead damage dealer; who may pick up share-mode gold in the owner window | No EXP for the dead in share mode (free mode and solo keep the damage share); any member may take party gold, which is split at pickup (PT-S) |
| 29 | An offline party leader during the 120 s grace | Keeps the lead; it passes on only when the member is removed (PT-S) |
| 30 | Tiger Girl encounter tuning (hpMul 0.05 = about 30k HP, attackMul 0.8, expMul 0.1) | As authored; not measured against real level-19 damage (estimate: about 3 min solo, under 1 min for 3-4). A playtest decides |
| 31 | A GM command to complete or reset a quest (`/quest`) | None yet; the tests write `quest_done` rows. Needs a gm.ts entry if the GMs want it |
| 32 | ED-C polls `nest near` (every 2 s for 14 s after an edit or a 25 m move, else every 10 s); each poll is a gm_audit row and a log line | As ED-C; an audit exemption for read-only `near` calls is a server option |
| 33 | Skill VFX choices: status anchors (stun/darkness over the head, freeze at the feet, ...), imbue glow colours, bow basic arrow speed 50 m/s, darkness → `status_bad_blind.efp` | As W5-V; the bow basic damage number shows at release, 0.1-0.3 s before the arrow lands |
| 34 | Grass on the grass tiles inside Jangan (plaza corner squares, garden lawns) | Grass grows there (they are Grass tiles with no object floor); check on screen that nothing pokes through decoration |
| 35 | Grass default on the N100 | `graphics.scatter = auto` (follows the graphics preset: medium → medium). Chunk build is 1.5-2.4 ms on the desktop (NullEngine), one chunk per frame at most; if the N100 hitches while walking, W5-P time-slices it or defaults the N100 to low |
| 36 | Storage-keeper Sansan's body may hover about 1.2 m (converted STAND1 root height) | Her name tag is fixed (UX-R); the body is a converter question, to check in the browser |
| 37 | Party invite by right-clicking a player in the world; minimap edge arrows for off-map party members and quest targets | Not built: invite from the target window only; no edge arrows |
| 38 | Esc with a party invite open | Does not decline it (Esc clears targets and windows first) |
| 39 | Server-side English lines: quest drop '<item> (n/goal)', share-mode gold 'You received N gold (party share from X).' | Kept server-side (like the other system lines); move to client i18n if a translation ever matters |
| 40 | H6 damage numbers in the game's digit art | Not done (needs `interface/hitcount` in export-icons HUD_SELECTION) |
