# Game protocol and content contracts

This document covers protocol v1 (`PROTOCOL_VERSION = 1`) between the browser client and the authoritative server, and the content files they share.

The types are the source of truth; this document explains the rules around them:

- `packages/shared/src/protocol.ts`: messages and shared constants.
- `packages/shared/src/validate.ts`: runtime validators for every frame.
- `packages/shared/src/content.ts`: content file shapes (`/out/data/*.json`).
- `packages/shared/src/content-check.ts`: runtime checks for content records.

For the transport, accounts and GM basics, see `apps/server/README.md`. This document adds the gameplay layer: monsters, combat, stats, death, loot, inventory, shops and the gameplay GM commands. Every gameplay addition is **additive**. Older messages are unchanged, and new fields are optional unless a new message introduces them.

## 1. Server authority

The server runs one simulation for players, monsters, NPCs and ground items. AI is its own module. The client is a view plus an intent sender.

- **The client sends intents only.**
  - Intents are `moveTo`, `attack`, `stopAction`, `pickup`, `respawn`, `statUp`, the `item*` and `shop*` requests, `useSkill`, and the wave 3 requests (`skillLearn`, `masteryUp`, `buffCancel`, `hotbarSet`, `npcTalk`, `npcClose`, the `storage*` requests) and the wave 4 `quest*` and `party*` requests (section 11).
  - The client never sends a position it is at, damage, HP, EXP, gold, an item it received, or a slot's contents.
- **The server decides everything that matters.** This covers positions (x/z; y is presentation), paths, ranges, attack timing, hit/miss/crit, damage, HP/MP, death, EXP/SP, level, loot rolls, item ownership, inventory contents, prices and stat totals.
  - The client may predict, for example by starting an attack animation, but must accept the server's answer.
- **Every gameplay request gets exactly one `actionResult`.**
  - `ok: true` means the request was accepted. Its effects arrive as their own messages: `combat`, `inventoryUpdate`, `statsDelta`, `despawn`, and so on.
  - `ok: false` means nothing changed, and `reason` (an `ActionFailReason`) says why.
  - A client can match results to requests per type in order (FIFO), because each connection is handled in order.
- **Frames are validated strictly.**
  - Client → server frames need exact key sets. Optional keys are listed per type, and numbers are bounded integers where applicable.
  - Any other frame gets `error bad_request` and counts as a strike toward the 20-strike disconnect (close 4008). One strike is forgiven every 3 s, so only sustained abuse closes the socket.
  - Server → client parsing checks every known field and drops unknown keys, so additive server changes do not break older clients.
- **Rate limits.**
  - The global budget stays at 20 msg/s (burst 40) per connection, with frames of at most 1024 bytes.
  - `CLIENT_RATE_LIMITS` also sets a per-type budget for every gameplay request, for example `attack` 5/s (burst 10) and `itemMove` 10/s (burst 20).
  - A request over its type budget is answered with `actionResult {ok: false, reason: 'rate_limited'}`. It is not a strike (a player mashing a key); frames over the global budget are.
  - GM commands keep their own budget of 5/s (burst 20).
- **Content is referenced by CodeName128** (`MOB_CH_MANGNYANG`, `ITEM_ETC_HP_POTION_01`). File paths never appear in gameplay or saved data.
- **The level cap is config** (`LEVEL_CAP`, default 20).
  - Content data covers every level. The server simply does not grant EXP past the cap.
  - The server should not spawn content above the cap unless a GM asks.

## 2. Entities

Every visible thing is an `EntityState` in `worldEnter.entities`, `spawn`, `despawn`, `move`, `stop`, `warp` and `entityUpdate`. These are the same messages players already use. Entity ids are runtime ids, unique across kinds while the entity exists.

| kind | `model` (CodeName128) | fields used |
|---|---|---|
| `player` | character model `CHAR_CH_*` | `weapon` (always present), `level`, `hp/maxHp`, `state`, `equip` (visible item codes), `invisible` (GM) |
| `mob` | `MobDef.code` (`MOB_*`) | `level`, `hp/maxHp`, `state`, `variant` (absent = normal), `move` |
| `npc` | `NpcDef.code` (`NPC_*`) | `name`; `level` 0 |
| `item` | `ItemDef.code`; gold piles use `ITEM_ETC_GOLD_01..03` | `count` (for gold, the amount), `plus`, `owner` + `ownerUntil`, `expiresAt`; `level` 0 |

- `EntityState.weapon` became optional because only players have one. The validator still requires it for `kind: 'player'`. `isPlayerEntity(e)` narrows the type.
  - **Compatibility note:** `apps/game/src/world/entities.ts:129` passes `state.weapon` to `catalog.weapon()`. It now needs `state.weapon ?? <default>` or an `isPlayerEntity` guard. It is left for the game-client wave, which rebuilds that screen.
- **Mobs move** with the same `move`/`stop` messages as players, and use `warp` for leash resets if needed.
- **Death.**
  - A dead mob gets `entityUpdate {id, hp: 0, state: 'dead'}`, usually implied by `combat.killed`.
  - It stays as a corpse for a short server-defined time, then `despawn`.
  - The nest respawns a new mob, with a new id, after `respawnSec`.
- **`entityUpdate`** now also carries `hp`, `maxHp` and `state`. It covers HP changes outside combat (regeneration, potions, GM heal), death and revival. It goes to everyone who sees the entity.
- **Interest management.** For now, "everyone who sees" means everyone in the world, as for players today. A later view-distance filter only changes who receives `spawn`/`despawn`.

## 3. Combat (auto-attack)

1. The client sends `attack {target}`. The server checks:
   - the target exists and is visible;
   - the target is a mob, since PvP is not in scope; otherwise `invalid_target`;
   - the target is alive; otherwise `target_dead`;
   - the attacker is alive; otherwise `dead`;
   - the attacker is not in a safe zone where combat is disallowed (`safe_zone`).

   Then it answers `actionResult {re: 'attack', ok: true}`.
2. If the target is out of reach, the server moves the attacker toward it and broadcasts ordinary `move` messages.
   - Reach is `distance ≤ weapon range + attacker radius + target radius`. For players, weapon range is `ItemDef.range` of the equipped weapon (bare hands: 1 m). For mobs, it is `MobDef.attackRange`.
   - While the target moves, the server re-issues the chase.
3. In reach, the server stops the attacker (`stop` with the yaw facing the target). Then it swings every attack interval:
   - for a player, the weapon's basic-attack `SkillDef.cooldownMs`, or a server default until skills are exported;
   - for a mob, `MobDef.attackIntervalMs`.

   Each swing is one `combat {attacker, target, hits[], killed?}` sent to viewers of either entity.
   - Each hit carries `outcome` (`hit`, `crit`, `miss` or `block`), `damage` (0 for miss/block) and `hp`, the target's HP after that hit.
   - Multi-hit basic attacks (sword/blade: 2) send several hits in one message. The client shows hit *i* at the *i*-th type-1 event of the attack clip (research report §5.6: never all at once).
   - The server applies the damage at swing time. The client-side delay is presentation only.
4. Auto-attack continues until one of these happens:
   - the target dies or despawns;
   - the attacker sends `moveTo`, `stopAction`, another `attack` or `pickup`;
   - the attacker dies;
   - the target leashes out of reach for good (`unreachable`).
5. **Mob AI** (server module) uses the same combat path.
   - Aggressive mobs (`NestDef.tactics.aggressive`) acquire players within `sightRange`. A champion uses its retail champion tactics, which are always aggressive, so a champion of a passive mob (Mangyang, Big-Eyed Ghost, Weasel, Water Ghost) attacks on sight too, with the nest's sight; `MobDef.championAggressive: false` (no champion tactics linked) keeps it passive. Giants and uniques keep the nest's tactics. A GM who turns a nest's `aggressive` off also sets its champion chance to 0 to make it fully passive (`ai.ts` `mobAggressive`).
   - Every mob retaliates when hit.
   - A mob chases at `runSpeed`, gives up past `leashRange` from its nest, walks home and regenerates.
6. **Damage and hit formulas** are server code.
   - The reference is research report §4.5: hit balance and the damage pipeline from the decompiled server, with base stats from textdata.
   - The client never needs them.

**Kill rewards.** The killer gets `statsDelta {stats: {exp, sp, spExp, ...}, gain: {exp, spExp, from: mobId}}`.
- EXP is `MobDef.exp` times the variant multiplier, a server config.
- SP-EXP is `MobDef.spExp`, or the server rule when absent (default: equal to EXP). Every 400 SP-EXP (`CHARACTER_RULES.spExpPerSp`) becomes 1 SP.
- Loot spawns as item entities (section 6).

## 4. Stats, levelling and stat points

- **Snapshot and deltas.**
  - `stats {stats: PlayerStats}` is the full snapshot. It is sent right after `worldEnter`, after every level-up and after respawn.
  - `statsDelta {stats: Partial<PlayerStats>, gain?}` is sent for everything else: HP/MP changes of your own character, EXP, SP and gold.
  - Only your own client receives these. Others see your HP through `entityUpdate`/`combat`.
- **PlayerStats** holds:
  - `level`, `exp` (into the current level) and `expToNext` (`levels.json[level].exp`, 0 at the cap);
  - `sp`, `spExp`;
  - `hp/maxHp`, `mp/maxMp`;
  - `str`, `int`, `statPoints`, `gold`;
  - the derived totals `physAttack`, `magAttack` (min/max), `physDefence`, `magDefence`, `hitRate` and `parryRate`.
- **Level-up** (server-side). This follows the SRO rules (`CHARACTER_RULES`):
  - each level gives +1 STR, +1 INT and +3 stat points;
  - HP and MP refill;
  - EXP overflow carries over, possibly across several levels at once;
  - no EXP is gained at `LEVEL_CAP`.

  The server broadcasts `levelUp {id, level}` to viewers (for the effect) and `entityUpdate {id, level, maxHp, hp}`, and sends the new `stats` to the owner.
- **`statUp {stat: 'str' | 'int', points}`** spends free points, with `points` from 1 to 1000. The server answers `no_points` when the character has fewer free points. Accepted requests are followed by a `stats` or `statsDelta` with the new totals.
- **New characters** start at level 1 with STR 20, INT 20, full HP/MP, 0 gold, a 48-slot bag, and their starter weapon (the `*_DEF` item of their `StarterWeapon`) equipped.
  - Max HP/MP use the §4.5 formula `1.02^(lvl−1) × STR × 10` (and the same with INT), plus equipment.
  - Stats are persisted by the server.

## 5. Death and respawn

- A player at 0 HP gets `entityUpdate {id, hp: 0, state: 'dead'}`, sent to everyone including the player, and all actions stop.
- While dead, every request except `respawn`, `chat`, `ping`, `leaveWorld`, `gm`, `npcClose` and `hotbarSet` (wave 4 adds `questAbandon`, `partyLeave`, `partyRespond`, `partyKick`, `partyLeader` and `partySettings`) is answered `dead`.
- **Resurrection** (a friendly skill, wave 3) is not a respawn: the player gets `entityUpdate {id, state: 'alive', hp, maxHp}` and `stats`, and no `warp`. The client closes its death overlay on its own `state: 'alive'`.
- **`respawn`** is answered `not_dead` when the character is alive. Otherwise the server:
  - revives the player at the town return point: the world spawn (`SPAWN_X/Z`) until return points exist;
  - restores full HP/MP;
  - sends `actionResult ok`, then `warp {id, pos, yaw}` and `entityUpdate {state: 'alive', hp, maxHp}` to viewers;
  - sends `stats` to the owner.
- There is no EXP loss or item drop on death in the level 1–20 loop. vSRO's death drop starts at level 10 with a 5% chance; the server can add it later behind config.
- Logging out while dead saves the character as dead at its position. It re-enters dead at the same spot and can respawn.

## 6. Ground items and loot

- **Spawning.** On a kill, the server rolls the mob's `DropTable`:
  - gold with `gold.chance`, the amount uniform in `gold.amount`;
  - each group with its `chance`, then one entry by `weight`, then a stack size in `count`.

  Each result becomes an `item` entity near the corpse, with:
  - `owner` = the killer's entity id;
  - `ownerUntil` = now + `ITEM_OWNER_MS` (30 s);
  - `expiresAt` = now + `ITEM_EXPIRE_MS` (120 s). At that time the server despawns it.
- Items a player drops with `itemDrop` have no owner and the same expiry.
- **`pickup {id}`** is refused with:
  - `not_found` when the entity is not an item;
  - `not_owner` while someone else owns it;
  - `inventory_full` when neither a free slot nor a mergeable stack exists (gold always fits).

  Otherwise, when farther than `PICKUP_RANGE` (2 m), the server walks the player there first, then picks it up. On success it sends:
  - `actionResult ok`;
  - `despawn` to viewers;
  - `inventoryUpdate` (the bag slot, or `gold`) to the picker.

## 7. Inventory

- **Layout.** A bag of `bagSize` slots, 48 for a new character (`CHARACTER_RULES.bagSize`, protocol maximum `MAX_BAG_SIZE` 96), indexed from 0. There are 12 equipment slots (`EQUIP_SLOTS`): head, shoulders, chest, legs, hands, feet, weapon, shield, earring, necklace, ring1 and ring2. Gold is a number.
- **`ItemStack`** is `{code, count, plus?, durability?}`. `count` runs from 1 to `ItemDef.maxStack`.
- **Messages.**
  - `inventory {inventory}` is the full snapshot, sent right after `worldEnter` (after `stats`) and whenever the server thinks the client may be out of sync.
  - `inventoryUpdate {bag?: {slot, item|null}[], equip?: {slot, item|null}[], gold?}` sends only what changed.
  - `appearance {id, equip}` tells viewers when a player's visible equipment codes change. Players also carry `equip` in their `EntityState`.
  - Weapon glow (additive, optional): `appearance` carries `plus` and `EntityState` / `CharacterSummary` carry `equipPlus`, the +N (1..255) of the visible slots that have one (absent = all +0). A change of +N alone (alchemy, GM `plus`) sends an `appearance` too.
- **Requests.** Bag indexes run from 0 to `MAX_BAG_SIZE − 1`, and counts from 1 to `MAX_ITEM_COUNT`. The server checks every index against the real bag size.

| Request | Rule | Typical failures |
|---|---|---|
| `itemMove {from, to}` | Into an empty slot: move. Onto the same code with room: merge (the remainder stays). Otherwise: swap. | `invalid_slot` (empty `from`, `from === to`) |
| `itemSplit {from, to, count}` | `to` must be empty; `count` must be less than the stack. | `invalid_slot`, `invalid_count` |
| `itemEquip {bag, slot?}` | The item must be equipment whose `ItemDef.slot` fits `slot`. Rings go to `slot`, or the first free ring. Anything already in the slot swaps back into `bag`. A two-handed weapon also unequips the shield, and a shield is refused while a two-handed weapon is worn. Armour classes (retail): a garment piece is refused while a protector or armour piece is worn, and the other way round; protector and armour mix. Only the pieces that stay on count, so a character already wearing a mixed set keeps it (nothing is removed or deleted) and may swap any piece for one that agrees with the rest, but cannot add to the mix. Unequipping is always allowed. | `invalid_slot`, `requirements` (level, gender, race), `armor_mix` ("Armor and garment cannot be worn at the same time."), `inventory_full` |
| `itemUnequip {slot, bag?}` | Into `bag` (must be empty), or the first free slot. | `invalid_slot`, `inventory_full` |
| `itemUse {bag}` | Consumes one. It applies `ItemDef.use`: HP/MP at once, or a return scroll, which casts first and warps to the town point at the end (section 8, Consumables). Potions share `cooldownGroup`. | `not_usable`, `cooldown`, `busy`, `dead` |
| `itemDrop {bag, count?}` | Spawns an item entity at the player's feet with no owner. | `not_usable` (`canDrop: false`), `invalid_count` |

- Accepted requests are followed by an `inventoryUpdate`, plus `appearance`, `stats` or `statsDelta` when equipment or HP/MP changed.
- Equipment changes the derived stats. The server recomputes them and sends `stats`.

## 8. NPCs, shops, storage and consumables

The full design is [docs/SHOPS.md](SHOPS.md) (§3 interaction, §4 consumables, §5 storage, §7 protocol); [docs/WAVE_PLAN.md](WAVE_PLAN.md) §1–§2 settles where the specs disagree. In short:

- NPCs are `npc` entities. **`npcTalk {npc}`** walks the player to `NPC_APPROACH_RANGE` (3 m) when farther than `NPC_INTERACT_RANGE` (8 m), then opens the dialog: `npcDialog {npc, code, services}`. Every service checks the 8 m range (`too_far`). The server closes the dialog with `npcDialogClose {npc, reason}` when the player walks away, dies, warps, the NPC goes, or another `npcTalk` replaces it. `npcClose` closes it from the client (also accepted while dead).
- **`shopBuy {npc, item, count}`** / **`shopSell {npc, bag, count?}`** are unchanged: the range rule above, `not_found` for an item outside that NPC's shop, `not_enough_gold`, `inventory_full`, `not_usable` for `canSell: false`, and `gold_limit` when a sale would pass `MAX_GOLD`. Each sale adds to the character's `buyback` list (`BUYBACK_SLOTS` = 5, oldest first); **`shopBuyback {npc, index, code?}`** buys an entry back for what the sale paid. When `code` is sent it must be that entry's item code, else `not_found` (the game client sends it, so a double press before the new list cannot buy back the next entry).
- **Storage** is per account (`STORAGE_SIZE_DEFAULT` 150 slots, at most `MAX_STORAGE_SIZE` 180, plus gold). `storageOpen` answers with `storage`; `storageDeposit`/`storageWithdraw`/`storageMove`/`storageGold` answer `actionResult`, then `inventoryUpdate` (bag side) and `storageUpdate` (storage side). A deposit costs `ItemDef.keepFee × count` (config `STORAGE_FEE`); `storage_full` and `gold_limit` are the new refusals.
- **Consumables.** Potions arm an item cooldown group: `itemCooldown {group, readyInMs, totalMs}` (own client; runtime only). Return scrolls cast: `itemCast` → `itemCastEnd {reason}` (`done` comes before the warp). One timed action at a time: `busy` while a skill action runs; `moveTo`, `attack`, `useSkill`, `pickup`, `npcTalk` and death interrupt an item cast, `stopAction` cancels it, damage does not.
- **Message order** (each request's `actionResult` first): SHOPS §7.3.
- `MAX_GOLD` (9,999,999,999) is the most gold a bag or a storage holds; it lives in `protocol.ts`.

## 9. Skills and masteries

The full design is [docs/SKILLS.md](SKILLS.md) (§1 masteries and SP, §5 timing, §10 engine and protocol); [docs/WAVE_PLAN.md](WAVE_PLAN.md) decisions 6–15 settle the cross-spec points. In short:

- **Learning.** `masteryUp {mastery}` raises one of the seven `MASTERY_CODES` by one level (cap: the character level). `skillLearn {skill}` learns the next row of a line (SKILLS §1.3 rules). Typical refusals: `no_sp`, `mastery_cap`, `not_learned`, `requirements`. Both answer `actionResult ok` → `skillsUpdate` → `statsDelta {sp}` (→ `stats` when passives change the totals).
- **State.** Enter-world sends `skills {masteries, skills, hotbar, cooldowns?}` after `inventory`: the highest learned row per group, the `HOTBAR_SLOTS` (40) hotbar and the groups still cooling down. Skill cooldowns survive a relog but not a server restart; item cooldowns are runtime only.
- **Hotbar.** `hotbarSet {slot, entry}` stores `{kind: 'skill' | 'item', code}` or clears a slot (also while dead). An item entry is accepted only for a consumable (`ItemDef.use`; otherwise `not_usable`); pressing it sends `itemUse` for the lowest bag slot holding that code. Slot `MOUSE_SLOT` (40, right after the 40 hotbar slots) is the mouse quick slot: same entries and rules, stored per character (migration 11, `char_mouse_slot`), carried in the `skills` snapshot as `mouse` (absent = empty) and in `skillsUpdate.hotbar` as slot 40; only the middle mouse button uses it.
- **Using.** `useSkill {skill, target?}` is implemented: `actionResult ok` → `cast {id, skill, instance, target?, instant?, prepareMs, castMs, actionMs}` (to everyone who sees the caster) → `statsDelta {mp}` → `combat {instance, skill, ...}` per hit moment. A queued skill gets its `actionResult` at request time and its `cast` when it starts. An action that closes early sends `castEnd {reason}`. New refusals: `not_learned`, `not_enough_mp`, `wrong_weapon`, `no_ammo` (only when config `SKILL_AMMO` is on), `cant_act`, `cooldown`. `not_implemented` stays in the enum for older clients.
- **Effects.** Buffs, debuffs, imbues, toggles and statuses are `EffectState`s: `effectAdd {id, effect}` / `effectRemove {id, instance, reason?}` to viewers, and `EntityState.effects` (at most `MAX_EFFECTS_PER_ENTITY` = 32) for late joiners. `buffCancel {skill}` ends an own buff or toggle. Passives are never sent.
- **Combat extensions.** `combat.skill` is the skill **row** code (basic attacks: the weapon's `*_BASE_01` row; clients map it to its group through `skills.json`), `instance` links hits to a `cast`, `at` is the landing time of projectiles, `aoe` marks a secondary target. `CombatHit` gains `status`, `down` and `pos` (knockback landing point).
- The skill data contract is `SkillDef`/`MasteryDef` in `content.ts` (with the SKILLS §3.2 fields), using the timing model of research report §5.5: `preparingMs`, then `castMs` (the release), then `actionMs`; `cooldownMs` is the reuse delay per group.

## 10. GM commands (gameplay)

These reuse `gm {cmd, args}` / `gmResult {ok, cmd, message, data?}`, with the existing role checks, audit and budget.

| Command | Effect | `data` |
|---|---|---|
| `spawn <mob code> [n]` | Spawns `n` mobs (1–50, default 1) of that MobDef around you. They are not tied to a nest and do not respawn. | `{ids: number[]}` |
| `item <item code> [n]` | Puts `n` (default 1) of the item in your bag. For `ITEM_ETC_GOLD_*`, adds `n` gold. Followed by `inventoryUpdate`. | `{bag: BagSlotUpdate[]}` |
| `kill [entity id]` | Kills the entity (a mob, or a player the GM outranks), or your current attack target. Loot and EXP are **not** awarded. | `{id}` |
| `heal [player]` | Full HP/MP for yourself or the player. It also revives a dead player in place. Sends `entityUpdate` and `stats`. | `{id}` |

Codes are CodeName128 and are matched case-insensitively, then upper-cased. An unknown code answers `ok: false`.

## 11. Message reference (gameplay additions)

**Client → server** (strict key sets; `?` = optional key):

| t | fields |
|---|---|
| `attack` | `target: int ≥ 0` |
| `stopAction` | — |
| `useSkill` | `skill: CodeName128`, `target?: int` |
| `pickup` | `id: int` |
| `respawn` | — |
| `statUp` | `stat: 'str' \| 'int'`, `points: 1..1000` |
| `itemMove` | `from, to: bag index` |
| `itemSplit` | `from, to: bag index`, `count: 1..10000` |
| `itemEquip` | `bag: bag index`, `slot?: EquipSlot` |
| `itemUnequip` | `slot: EquipSlot`, `bag?: bag index` |
| `itemUse` | `bag: bag index` |
| `itemDrop` | `bag: bag index`, `count?: 1..10000` |
| `shopBuy` | `npc: int`, `item: CodeName128`, `count: 1..10000` |
| `shopSell` | `npc: int`, `bag: bag index`, `count?: 1..10000` |
| `skillLearn` | `skill: CodeName128` |
| `masteryUp` | `mastery: MasteryCode` (`MASTERY_CODES`) |
| `buffCancel` | `skill: CodeName128` |
| `hotbarSet` | `slot: 0..40` (40 = `MOUSE_SLOT`), `entry: {kind: 'skill' \| 'item', code: CodeName128} \| null` (strict keys inside `entry` too) |
| `npcTalk` | `npc: int` |
| `npcClose` | — |
| `storageOpen` | `npc: int` |
| `storageDeposit` | `npc: int`, `bag: bag index`, `count?: 1..10000`, `to?: 0..179` |
| `storageWithdraw` | `npc: int`, `slot: 0..179`, `count?: 1..10000`, `bag?: bag index` |
| `storageMove` | `npc: int`, `from, to: 0..179` |
| `storageGold` | `npc: int`, `dir: 'deposit' \| 'withdraw'`, `amount: 1..MAX_GOLD` |
| `shopBuyback` | `npc: int`, `index: 0..4`, optional `code: CodeName128` |
| `chat` (extended) | `text`, `to?: character name (CHARACTER_NAME)`, `channel?: 'local' \| 'party'`; `to` with `channel: 'party'` is rejected (`error bad_request`) |

Per-type budgets (`CLIENT_RATE_LIMITS`, per second / burst): `skillLearn`, `masteryUp`, `buffCancel` 5/10; `hotbarSet` 10/20; `npcTalk` 2/5; `npcClose` 5/10; `storageOpen` 2/5; `storageDeposit`, `storageWithdraw`, `storageMove` 10/20; `storageGold` 5/10; `shopBuyback` 5/10. `useSkill`, `itemUse` and `shop*` are unchanged. Chat (whisper and party included) keeps its 1/s burst-5 bucket.

**Server → client**:

| t | fields |
|---|---|
| `actionResult` | `re: GameplayRequest`, `ok`, `reason?: ActionFailReason`, `message?` |
| `combat` | `attacker`, `target`, `hits: {outcome, damage, hp}[]` (1–16), `skill?`, `killed?` |
| `stats` | `stats: PlayerStats` (all keys) |
| `statsDelta` | `stats: Partial<PlayerStats>`, `gain?: {exp, spExp, from?}` |
| `levelUp` | `id`, `level` |
| `inventory` | `inventory: {bagSize, bag: (ItemStack\|null)[bagSize], equip, gold}` |
| `inventoryUpdate` | `bag?`, `equip?`, `gold?` |
| `appearance` | `id`, `equip: {[EquipSlot]: item code}`, `plus?: {[EquipSlot]: 1..255}` (weapon glow) |
| `entityUpdate` (extended) | `hp?`, `maxHp?`, `state?`, `gm?: boolean` (wave 3; false clears the [GM] tag) |
| `EntityState` (extended) | `kind: 'player'\|'mob'\|'npc'\|'item'`, `weapon?`, `hp?`, `maxHp?`, `state?`, `variant?`, `count?`, `plus?`, `owner?`, `ownerUntil?`, `expiresAt?`, `equip?`, `equipPlus?` (players: +N of the visible slots, the weapon glow); wave 3: `effects?: EffectState[]` (≤ 32), `gm?: true` (players, display only) |
| `combat` (wave 3) | `skill` = row code, `instance?`, `at?` (server ms the hits land), `aoe?: true`; each hit may carry `status?: SkillStatusKind`, `down?: true`, `pos?: Vec3` |
| `skills` | `masteries: {[MasteryCode]: 0..300}`, `skills: string[]` (≤ 512, highest learned row per group), `hotbar: (HotbarEntry\|null)[40]`, `cooldowns?: {group, readyInMs}[]` |
| `skillsUpdate` | `masteries?` (only the changed ones), `learned?: string[]`, `hotbar?: {slot, entry}[]` |
| `cast` | `id`, `skill`, `instance`, `target?`, `instant?`, `prepareMs`, `castMs`, `actionMs` (ints 0..600000) |
| `castEnd` | `id`, `instance`, `reason: 'interrupted' \| 'cancelled' \| 'target_lost'` |
| `effectAdd` | `id`, `effect: {instance, skill?, status?, level?, remainingMs: 0..86400000, source?}` |
| `effectRemove` | `id`, `instance`, `reason?: 'expired' \| 'replaced' \| 'cancelled' \| 'cured' \| 'death'` |
| `npcDialog` | `npc`, `code`, `services: ('shop' \| 'storage' \| 'repair' \| 'quest')[]` ('repair' is reserved, never offered in waves 3–4); wave 11: `lines?: string[]` (≤ 8 × ≤ 300 characters, the conditional greeting lines that hold now; see Wave 11 below) |
| `npcDialogClose` | `npc`, `reason: 'closed' \| 'too_far' \| 'dead' \| 'warp' \| 'gone'` |
| `storage` | `storage: {size: 0..180, slots: (ItemStack\|null)[size], gold: 0..MAX_GOLD}` |
| `storageUpdate` | `slots?: {slot, item\|null}[]`, `gold?` |
| `buyback` | `entries: {item: ItemStack, price}[]` (≤ 5, oldest first) |
| `itemCooldown` | `group`, `readyInMs`, `totalMs` (ints 0..600000) |
| `itemCast` | `id`, `item`, `castMs` |
| `itemCastEnd` | `id`, `item`, `reason: 'done' \| 'cancelled' \| 'interrupted'` |
| `chat` (extended) | `channel: 'local' \| 'system' \| 'whisper' \| 'party'`, `to?` (whisper recipient). An older client drops a frame with a new channel value (console warning); server and client deploy together |
| `welcome.server` (extended) | `world?`: the world export folder (`/^[a-z0-9-]{1,64}$/`, e.g. `jangan-fields`; absent = `jangan`). The parser keeps it (docs/FIELDS.md §6.1) and rejects a malformed value |
| `worldEnter.world` (extended) | `levelCap?: 1..300` (config `LEVEL_CAP`; absent = `DEFAULT_LEVEL_CAP`) |

New `actionResult.reason` values (wave 3): `not_learned`, `not_enough_mp`, `wrong_weapon`, `no_ammo`, `cant_act`, `no_sp`, `mastery_cap` (skills); `gold_limit`, `storage_full`, `busy` (shops, storage, consumables).

**Enter-world sequence.** `worldEnter` (with `world.levelCap` and `self.effects`) → `stats` → `inventory` → `skills`. Then live messages follow. Storage, buyback and item cooldowns are sent only on demand.

### Wave 4: quests, party, GM content editors (docs/WAVE_PLAN.md §2.2, docs/QUESTS.md §6)

Quest content types and their validator live in `packages/shared/src/quests.ts` (`QuestFile`, `QuestDef`, `QuestObjective`, `validateQuestFile`, `validateQuestDef`, `expandRewardCode`, `rewardCodeVariants`, `questRewardExp`). Quest files are `content/quests/*.json` (repo) plus GM overrides under `DATA_DIR/content/quests/`.

**Client → server** (every one is a `GameplayRequest`: exactly one `actionResult`):

| t | fields |
|---|---|
| `questAccept` | `npc: int`, `quest: QUEST_ID` (`/^[A-Z][A-Z0-9_]{1,63}$/`) |
| `questTurnIn` | `npc: int`, `quest`, `choice?: 0..7` (index into `rewards.choice`; required when it has entries → else `choice_required`) |
| `questAbandon` | `quest` |
| `questTalk` | `npc: int`, `quest`, `objective: OBJECTIVE_ID` (`/^[a-z][a-z0-9_]{0,23}$/`) (a `talk`/`deliver` objective at that NPC) |
| `questUseItem` | `quest`, `objective` (a `useItem` objective; checked against your position) |
| `partyInvite` | `target: int` (player entity), `exp?`, `items?: 'free' \| 'share'` (the modes when this invite creates the party) |
| `partyRespond` | `inviter: int` (the inviter's entity id from `partyInvited`), `accept: boolean` |
| `partyLeave` | — |
| `partyKick`, `partyLeader` | `member: 1..MAX_SAFE_INTEGER` (characterId) |
| `partySettings` | `exp?`, `items?` (at least one) |

Per-type budgets: `questAccept`, `questTurnIn`, `questTalk` 5/10; `questAbandon`, `questUseItem` 2/5; `partyInvite`, `partyLeave` 1/3; `partyRespond`, `partyKick`, `partyLeader`, `partySettings` 2/5. Party chat (`chat {channel: 'party'}`) pays the chat budget; `error bad_request` when you are in no party. GM editor commands (`nest`, `npc`, `content`) pay the GM budget. `/api/gm/*` has its own per-account budget of 2/s (burst 10, `GM_API_RATE_LIMIT`) and accepts bodies up to 32 KB (`GM_API_MAX_BODY_BYTES`).

**Server → client**:

| t | fields |
|---|---|
| `quests` | `active: QuestProgress[]`, `done: QuestDoneEntry[]`, `rev` (the quest catalog revision) |
| `questUpdate` | `quest`, `event: 'accepted' \| 'progress' \| 'objective' \| 'ready' \| 'completed' \| 'abandoned' \| 'changed'`, `progress: QuestProgress \| null` (null = no longer active), `done?: QuestDoneEntry` (on completion), `objective?` |
| `contentChanged` | `kind: 'quests' \| 'nests' \| 'npcs'`, `rev` (GM edits: refetch `/api/quests`, or expect spawns/despawns) |
| `partyInvited` | `inviter` (entity id), `name`, `level`, `exp`, `items`, `expiresInMs` (`PARTY_INVITE_MS` 30 s) |
| `party` | `party: PartyState \| null` (full state on any change; null = not in a party) |
| `partyVitals` | `members: PartyVitals[]` (≤ 8; changed fields only, at most every 500 ms, positions at 1 Hz) |
| `partyEvent` | `event: 'joined' \| 'left' \| 'kicked' \| 'leader' \| 'declined' \| 'expired' \| 'disbanded' \| 'offline' \| 'online' \| 'settings'`, `name` |
| `EntityState` (extended) | `npc?` (NPCs: authored identity `NPCX_*` when it differs from `model`, the base look; identity = `npc ?? model`), `ownerParty?` (items: that party's members share the owner window) |
| `statsDelta.gain` (extended) | `quest?`: the EXP came from turning in this quest |

- `QuestProgress` = `{quest, rev, status: 'active' | 'ready', counts: {objectiveId: int ≥ 0} (≤ 8), items: {code, count}[] (≤ 8, the quest bag), acceptedAt, encounterUntil?}`. `QuestDoneEntry` = `{quest, times ≥ 1, lastAt, availableAt?}`.
- `PartyState` = `{id, leader (characterId), exp, items, members: PartyMember[] (1..8)}`; `PartyMember` = `{characterId, name, model, level, entity: int | null (null = offline), hp, maxHp, mp, maxMp, dead?, pos?: [x, z]}`. `PartyVitals` = `{characterId}` plus any changed `PartyMember` field.
- The parsers keep `progress: null` and `party: null`, and reject a `questUpdate` without `progress` or a `party` without `party`.

New `actionResult.reason` values (wave 4): `quest_log_full`, `quest_active`, `quest_done`, `not_complete`, `choice_required`, `wrong_place` (quests); `not_in_party`, `not_leader`, `party_full`, `in_party`, `no_invite` (party). Reused: `not_found`, `too_far`, `requirements`, `cooldown`, `inventory_full`, `invalid_slot`, `invalid_target`, `dead`, `rate_limited`.

Constants: `MAX_ACTIVE_QUESTS` 10, `MAX_QUEST_OBJECTIVES` 8, `MAX_REWARD_CHOICES` 8, `PARTY_MAX` 8, `PARTY_SHARE_RANGE` 60 m, `PARTY_INVITE_MS` 30 000, `PARTY_OFFLINE_GRACE_MS` 120 000.

**GM editor data and HTTP** (docs/QUESTS.md §5): `gmResult.data` of `nest` / `npc` commands carries `GmNestInfo` / `GmNpcInfo`. `GET /api/quests` (Bearer, ETag `"q<rev>"`) → `ApiQuestCatalog {rev, files: QuestFile[]}`. Staff only: `GET /api/gm/quests` → `ApiGmQuestList`; `POST /api/gm/quests/validate` and `PUT /api/gm/quests/:id` take `ApiGmQuestPut {quest, items?, locations?, baseRev?}` → `ApiGmQuestResult {ok, rev, issues}` (422 with issues, 409 on a stale `baseRev`); `DELETE /api/gm/quests/:id`; `POST /api/gm/quests/:id/disable|enable`. Editors never change roles.

**Enter-world sequence (wave 4).** `worldEnter` → `stats` → `inventory` → `skills` → `quests` → `party` (only when in one).

### Wave 7B: posture, emotes, consumable and drop visuals (docs/WAVE_PLAN2.md §3.1, docs/EFFECTS.md §4)

**Client → server** (both are `GameplayRequest`s: exactly one `actionResult`):

| t | fields |
|---|---|
| `sit` | `on: boolean` (sit down / stand up). Refused: `dead`; `busy` (moving, an action, a skill action, an item cast); `in_combat` (combat within 5 s, D30); `mounted` (on a horse); `stalling` / `trading` (their gates). `on: false` while standing is `ok` (idempotent) |
| `emote` | `emote: EmoteKind` (`'hi' \| 'laugh' \| 'greeting' \| 'yes' \| 'rush' \| 'joy' \| 'no'`, `EMOTE_KINDS`). Refused: `dead`; `busy` (moving, a skill action, an item cast). A sitting player stands up first |

Per-type budgets: `sit` 2/4; `emote` 1/3.

**Server → client**:

| t | fields |
|---|---|
| `itemEffect` | `id` (the entity the visual plays on), `item` (ItemDef code, `ITEM_*`): to viewers of `id`, the user included, after a successful potion, herb, pill or vigor use (wave 8: a horse Recovery Kit, with the horse's id). Not sent for return scrolls (`itemCast` covers them) |
| `emote` | `id`, `emote: EmoteKind`: to viewers of `id`, the sender included (the server reuses the client `t`, as `chat` does) |
| `entityUpdate` (extended) | `posture?: 'sit' \| 'stand'` (`'stand'` clears `EntityState.posture`) |
| `EntityState` (extended) | items: `droppedAt?` (server ms, an integer ≥ 0, when the item reached the ground: fresh drops play the toss), `dropFrom?: Vec3` (where it was thrown from, the corpse point; absent for player drops); players: `posture?: 'sit'` (absent = standing; late joiners see a sitter sitting) |

- **Standing up.** `moveTo`, `attack`, `useSkill`, `pickup`, `npcTalk` and damage taken stand a sitting player up: `entityUpdate {id, posture: 'stand'}` to viewers. Nothing regenerates faster while sitting.
- **Client mapping** (not wire): `itemEffect.item` → `ItemDef`: `cureLevel` set → the cure visual; else `use.cooldownGroup` `'hp'` → SYSTEM_HPPOTION, `'mp'` → SYSTEM_MPPOTION, `'vigor'` → SYSTEM_LIFE; else SYSTEM_HPPOTION when `use.hp`/`hpPct` is set, else none (docs/EFFECTS.md §4).
- The parsers keep the new fields and reject a bad `EmoteKind`, a `posture` other than `'sit'` on an entity (`'sit' \| 'stand'` on `entityUpdate`), a non-integer or negative `droppedAt`, and a `dropFrom` that is not a Vec3. An older client drops `itemEffect` / `emote` frames (unknown type).

### Wave 8: shared wire changes (docs/WAVE_PLAN2.md §3.2)

All additive, protocol v1; server and client deploy together (new enum values make an older client drop the frame). The requests and messages of each system are in §12 and §13.

| Where | Change |
|---|---|
| `EntityKind` | += `'cos'` (a horse). For a cos, `owner` = the owning player's entity id (no `ownerUntil`) and `hp`/`maxHp` = the horse's HP (D31) |
| `EntityState` (extended) | players: `mount?: int` (the horse ridden), `berserkMs?: 1..600000` (Berserk time left), `stall?: string` (0..32 code points: the stall title; present = a stall exists), `guild?: string` (0..12: the guild name); cos: `rider?: int` (absent = parked) |
| `entityUpdate` (extended) | `mount?: int \| null` (null = dismounted), `rider?: int \| null` (null = parked), `berserkMs?: 0..600000` (0 = ended), `stall?: string` (`''` = closed), `guild?: string` (`''` = none). The parser keeps `null`, `0` and `''` |
| `CombatHit` (extended) | `hwan?: true`: the attacker was in Berserk (direct hits; DoT ticks never carry it) |
| `PlayerStats` (extended) | `hwan?: 0..5` (Berserk points). Wave-8 servers always send it in a full `stats` (D33); the parser keeps it but does not require it (`PLAYER_STAT_OPTIONAL_KEYS`), so an older server's `stats` still parses |
| `worldEnter.world` (extended) | `alchemyRate?: number` (config `ALCHEMY_RATE`, 0..10), `alchemyMaxPlus?: 1..12`, `social?: {guildCreateGold: 0..MAX_GOLD, guildCreateLevel: 1..300}` |
| `NpcService` | += `'guild'` (the Guild Manager, `GUILD_MANAGER_NPCS`). `'repair'` is now offered by NPCs whose `NpcDef.roles` include `'repair'`; the client shows it as the shop window's Repair buttons, not a dialog option (D13). `npcDialog.services` has unique entries |
| `chat` (client) | `channel?: 'local' \| 'party' \| 'guild' \| 'stall'`; `to` with any channel other than `'local'` is rejected (`error bad_request`, D32). Guild and stall lines pay the chat budget; `error bad_request` when you have no guild / no stall |
| `chat` (server) | `channel` += `'guild' \| 'stall'` |
| `cast` / `castEnd` / `combat` | may come from a mob id (monster skills send `skill`, `instance`, `at`, `aoe` like player skills) |

New `actionResult.reason` values (wave 8, 22): `mounted`, `not_mounted`, `moving`, `in_combat`, `cos_active`, `broken`, `nothing_to_repair`, `alchemy_mismatch`, `max_plus`, `berserk_not_ready`, `berserk_active` (§12); `trading`, `stalling`, `stall_changed`, `stall_full`, `stall_closed`, `not_in_guild`, `in_guild`, `no_permission`, `guild_full`, `name_taken`, `bad_name` (§13). `name_taken` is also an `ErrorCode` (charCreate); the two unions are separate. `busy` already exists.

**The gate** (server, `GameplayModule.gate`). Before any request of a player is handled (after the dead check; `respawn` excepted), and before a client `moveTo`, every module except the one that handles the request may veto it; the first refusal wins and becomes the `actionResult` (a vetoed `moveTo` is dropped without a message). The trade and stall locks, the mounts module and the alchemy soft lock use it (docs/WAVE_PLAN2.md §2.3, §6.5). A locking module lets through only an allowlist, so a request type added later is refused by default.

**Enter-world sequence (wave 8).** `worldEnter` (self carries `stall`/`guild`; no `posture`, no `mount`) → `stats` (with `hwan`) → `inventory` → `skills` → `quests` → `party` (if in one) → horse (`spawn {cos}` + the `entityUpdate` pair, if a saved horse exists) → `guild` (if in one).

### Wave 9: world clock and weather (docs/WAVE_PLAN3.md §3, docs/SKY.md §2, docs/WEATHER.md §2–§4)

All additive, protocol v1; server and client deploy together, and a client still runs without the new fields (an older server: a local clock from noon, clear weather). **Client → server: nothing new**; the GM commands use the existing `gm` path and budget. The shared maths is pure and environment-neutral: `packages/shared/src/world-clock.ts` (`clockDays`, `clockAt`, `solarTime`, `phaseForSolarTime`, `sunDirection`, `moonState`, `sunriseSunset`, `formatClock`) and `packages/shared/src/weather.ts` (`WEATHER_PARAMS`, `blendWeather`, `WeatherSchedule` / `scheduleAt`, `stepSurface`, `flashAt`, `fogScale`, `ZONE_CLIMATE`, `mulberry32`).

**Server → client**:

| t | fields | sent |
|---|---|---|
| `worldEnter.world` (extended) | `clock?: WorldClockState`, `weather?: WeatherSync` | every enter (the late-joiner sync) |
| `worldClock` | `clock: WorldClockState` | after a GM `time` change, to sockets **with a player in the world** only (never the lobby); never periodic: clients extrapolate from the anchor with their server-time offset |
| `weather` | `weather: WeatherSync` | to every player in the world on each state change (schedule or GM), a GM `wind`/`wet` override, and a resync every 10 min |
| `lightning` | `at` (server ms), `distM: 100..3000`, `bearing: 0..2π` (radians, like `windDir`), `strike?: u32` (additive, storm series: the id of the placed `strike` it copies) | each strike, to every player in the world; thunder follows `distM / 343` s later. Since lightning strikes (below) it is sent **per player** with that player's own distance and bearing to the placed strike, so an older client still flashes and thunders the right way; a client that knows `strike` skips a `lightning` carrying `strike` |
| `strike` (storm series step 1, docs/WEATHER.md §2.7) | `strike: LightningStrike` | to every player in the world when a strike's telegraph begins (a harmless `sky` flash: when it flashes), and to a player entering while one is pending |
| `storm` (storm series step 2, docs/WEATHER.md §12) | `storm: StormStatus` | to every player in the world when the storm phase or an effect changes (at most once a second), and to a player entering unless all is calm (the client starts calm) |
| `stormArc` (docs/WEATHER.md §12.4) | `from`, `to` (player entity ids, ≥ 1), `at` (server ms), `mob?` (the charged monster) | a charged monster's hit arced from the player it hit to a player nearby; to the viewers of either. The damage follows as `combat` with `attacker: 0`, `cause: 'arc'` |
| `entityUpdate` / `EntityState` (extended) | `charged?: boolean` / `charged?: true` | a monster became storm-charged (true) or lost it (false: the storm ended, it died); late viewers see `charged: true` in its state |
| `tornado` (storm series step 3, docs/WEATHER.md §13) | `tornado: TornadoState` | to every player in the world at the warning (20 s before touchdown) and when it lifts early (`liftAt` set), and to a player entering while one is up |
| `tornadoEnd` (docs/WEATHER.md §13) | `id: 1..2³²−1`, `at` (server ms) | the tornado is gone (lifted away, `LIFT_MS` after its walk ended or it lifted); to every player in the world |
| `displace` (docs/WEATHER.md §13.4) | `id` (entity ≥ 1), `kind: 'pull' \| 'throw'`, `from`, `to` (Vec3, \|c\| ≤ 1e6), `at` (server ms), `ms: 1..10000`, `peakM?: 0..40` (throw: the apex above the line), `tornado?` (its id) | to the entity's viewers right after the `move` that carries it: a body drifting toward a tornado while standing (`pull`: slide it, no walking clip) or thrown by one (`throw`: an arc with a spin); the `stop` at the end comes as usual |
| `strike` (extended) | `strike.source?: 'tornado'` | a bolt thrown by a tornado (the client draws an arc from the funnel to it) |

- `WorldClockState` = `{anchorMs: int ≥ 0, anchorDays: 0..1e6, dayMs: int 60000..86400000, running: boolean, nightSpeedup: 0..0.6, declination: −23.44..23.44}`. Game days `= anchorDays + (serverNow − anchorMs) / dayMs` (frozen: `anchorDays`); the displayed clock is the solar time `t = p − k/2π · sin(2π(p − 0.5))` of the phase `p` (the night passes faster). The full moon is `moon16` (`moonState`, age 14.77).
- `WeatherSync` = `{start, dur: 0..600000, from, to: 'clear' | 'cloudy' | 'overcast' | 'rain' | 'storm' | 'fog' | 'snow' | 'blizzard' (the last two: winter, below), intensity: 0.4..1 (rain and snow; 1 otherwise), until, windDir: 0..2π (toward; 0 = +X east, π/2 = −Z north), windMs: 0..30, wet: 0..1, puddle: 0..1, at, seed: u32, gm?: true, fromVec?}`. Clients blend `from` → `to` over `start .. start + dur` (rain lags the clouds, fog creeps in) starting from their own current vector, and integrate `wet`/`puddle` forward from `at` with the same `stepSurface` as the server (puddles never above `wet + 0.1`), on the server clock rather than the frame times, so a slow load or a hidden tab does not leave one client's puddles behind the others (checked in I9A: a client, a late joiner and the server agree within 0.01). W9F: after a gap of more than 2 s between frames, or a jump of the server-clock estimate either way, the client re-derives the surface from the sync's own (`wet`, `puddle`, `at`) in 1 s steps along the blend, as the server ticks, instead of integrating the gap with the end of the blend (a stalled tab no longer runs ahead). `fromVec` (additive, W9F P1): the parameter vector the running transition started from (`cloud`, `cloudDark`, `cirrus`, `rain`, `gust`, `fog`, `sun`, `desat`, and winter's optional `snow`: 0..1; `windMs`: 0..30; `lightning`: 0..60 per min), sent while `start + dur` is ahead; a late joiner blends from it, so it sees what the players already there see when a change started mid-transition or from light rain. Absent (an older server, or no transition running): `P[from]` at intensity 1. A malformed `fromVec` is dropped on its own.
- `LightningStrike` = `{id: 1..2³²−1, at (server ms the bolt lands), warnAt? (server ms the telegraph began; ≤ at; absent for `sky`), kind: 'ground' | 'tree' | 'wall' | 'tower' | 'entity' | 'sky', pos: Vec3 (glTF m, |c| ≤ 1e6: the ground, a tree top, the wall walk, a tower top, an entity's feet; `sky`: a point in the cloud), groundY? (the ground under a tree or a tower), radiusM: 0..12 (0 = harmless: a sky flash or a safe area), seed: u32 (bolt shape and return strokes; every client draws the same bolt), target? (entity id it was aimed at)}`. Damage arrives as **`combat` with `attacker: 0`** (no entity: ids start at 1), **`cause: 'lightning'`** and **`strike: <id>`** (both additive, optional; `HAZARD_CAUSES` in `packages/shared/src/lightning.ts`), one hit per body, then the usual `statsDelta` / `entityUpdate` / death, and a stun as `effectAdd` (status `stun`, `source: 0`). An older client drops `cause`/`strike` and shows the hit as an attackerless hit (no attack clip), and drops `strike` frames as an unknown type (a `console.warn`); its flash and thunder come from the per-player `lightning`. The shared timing is `STRIKE_TELEGRAPH_MS` (1.2–1.8 s, `telegraphMs(seed)`), `strikeStrokes(seed)` (2–4 return strokes within 0.3–0.5 s), `strokeBrightness`, `strikeFlashPeak(distM)`, `STRIKE_RADIUS_M` and `STRIKE_VERTICAL_M`.
- `StormStatus` = `{phase: 'calm' | 'rain' | 'forecast' | 'storm', startsAt? (server ms the forecast storm breaks), endsAt? (server ms a storm event ends), effects: StormEffect[] (≤ 17), winter?: true (winter addition)}`, `StormEffect` = `{id: 'wet' | 'sight' | 'fire' | 'lightning' | 'cold' | 'mud' | 'wind' | 'night' | 'undead' | 'water' | 'critters' | 'packs' | 'bandits' | 'panic' | 'charged' | 'snow' | 'drifts' (the last two: winter), pct?: int −1000..1000}` (the change in percent, signed; the client's tooltip line is i18n `storm.effect.<id>`). An unknown phase or effect id rejects the frame. `HAZARD_CAUSES` gains `'arc'` (a charged monster's arc). The numbers are `STORM_TABLE` in `packages/shared/src/storm.ts`. An older client ignores `storm` and `stormArc` (unknown types, a `console.warn`), drops `charged`, and drops a `combat` with `cause: 'arc'` (an unknown cause).
- `TornadoState` = `{id: 1..2³²−1, seed: u32 (the funnel's look), warnAt ≤ touchAt ≤ endAt (server ms: the warning, touchdown, the end of its walk), liftAt? (server ms it began to lift early), path: Vec3[] (1..96 points on the ground, glTF m, |c| ≤ 1e6), speedMs: 0..20, pullM: 0..100, coreM: 0..100, strength: 0..2, area? (≤ 64 chars: the zone name at touchdown), gm?: true}`. It walks `path` from `touchAt` at `speedMs` until `min(liftAt, endAt)`, then rises over `LIFT_MS` (6 s); every client places it with `tornadoAt(state, serverNow)` (`packages/shared/src/tornado.ts`), so there is no per-step message. `HAZARD_CAUSES` gains `'tornado'` (its throw damage: `combat` with `attacker: 0`, `cause: 'tornado'`; with `killed: true` when a throw kills a body already low, `TORNADO_LETHAL`); its bolts are ordinary `strike`s with `source: 'tornado'` (their hits keep `cause: 'lightning'`). The numbers are `TORNADO_TABLE` (and STORM_TABLE `tornadoChance` / `tornadoStrength` / `tornadoLethal`, the `TORNADO_CHANCE` / `TORNADO_STRENGTH` / `TORNADO_LETHAL` knobs, admin "Weather and storms"). An older client ignores `tornado`, `tornadoEnd` and `displace` (unknown types), sees a thrown body as a fast plain `move`, drops `source`, and drops a `combat` with `cause: 'tornado'`.
- **Parsing.** A malformed `worldClock`, `weather`, `lightning`, `strike`, `storm`, `stormArc`, `tornado`, `tornadoEnd` or `displace` frame is rejected, so the client keeps its old state. A malformed `clock` or `weather` inside `worldEnter.world` drops **only that field** (console warning); every other optional field keeps the house rule (a bad value rejects the message).
- **Server.** The clock is anchored at 2026-01-01T00:00Z = day 0.3 with the config's `DAY_LENGTH_MIN`, `DAY_NIGHT_SPEEDUP`, `DAY_SEASON_DEG` (deterministic across restarts, no database); GM changes persist to `DATA_DIR/world-clock.json` (atomic write). The weather follows a seeded Markov schedule from 2026-01-01 (`WEATHER_SEED`, `WEATHER_RAIN_SCALE`; measured shares: clear 33 %, cloudy 31 %, overcast 22 %, rain 10 %, storm 1 %, fog 3 %), so a restart lands on the same state; GM holds live in memory. `WEATHER=off` sends a clear enter sync and nothing after it; `WEATHER=<state>` fixes one state. Lightning is a Poisson process at the blended rate (storm 5 per min; rain of intensity ≥ 0.8: 0.3 × intensity per min) times √(players in the world) (1..3), at least 4 s apart. Weather is cosmetic except **lightning, which strikes** (storm series step 1, docs/WEATHER.md §2.7): each roll is placed around a random living player (30 % a harmless sky flash, 50 % near them with a bias to tall things, 20 % 300–1800 m away), telegraphed 1.2–1.8 s, and everything standing in its radius when it lands (players and monsters; never inside a safe area) takes 38 % (centre) to 22 % (edge) of its max HP and a 1.5 s stun (newbies below level 10 × 0.6, strong monsters × 0.6, uniques and the Play the Boss body 3 % and never killed nor stunned). W9F: a server wall clock that steps back (an NTP step at boot, a manual change) moves the weather module's times by the same step (the transition keeps its progress, a hold its remaining time) and resyncs, instead of the module waiting for the old time; a GM clock change that would take the day count past 1,000,000 (or below 0) moves it by whole multiples of 2953 days (100 synodic months), keeping the time of day and the moon phase, where it used to clamp the day and land at 00:00. The client's server-clock estimate uses the page's monotonic clock (`performance.timeOrigin + performance.now()`, which pings carry as `clientTime`) and drops its older samples when a pong's offset jumps by more than its round trip can explain, so either clock stepping is corrected by the next pong.

**GM** (role `gm`, audited like every command; both are also typed in chat as `/time`, `/weather`):

| Command | Effect | `data` |
|---|---|---|
| `time` | "Day 12, 14:32, 1 day = 120 min, running, night ×0.4, season +12°" | `{clock, t, day}` |
| `time <hh:mm>` / `time day <n>` | Jump to that solar time today / to day `n` at the same time of day (the day also sets the moon phase) | same |
| `time length <1-1440 min>` / `time freeze` / `time resume` / `time night <0-0.6>` / `time season <deg>` | Re-anchored at now, so the time of day does not jump | same |
| `time reset` | Config defaults at the epoch anchor; deletes `world-clock.json` | same |
| `weather` | Status: state, blend, next change, wetness, puddles, wind | `WeatherSync` |
| `weather <state>[:intensity] [minutes] [transitionS]` | Hold a state for 1–1440 min (default 30), reached in 0–600 s (default 60); `rain:0.4`..`rain:1` sets the intensity. The schedule resumes after the hold | `WeatherSync` |
| `weather auto` | End a hold now; blend back to the schedule (or `WEATHER=<state>`) over 60 s | `WeatherSync` |
| `weather wind <0-30 m/s> [0-359°]` | Override the wind (degrees toward: 0 = east, 90 = north) until the next state change | `WeatherSync` |
| `weather wet <0-1> [puddle 0-1]` | Set the surface wetness and puddles now | `WeatherSync` |
| `storm [start [minutes] [forecastMinutes] \| forecast [minutes] \| stop \| preview \| charge [mob id]]` (docs/WEATHER.md §12.5) | The storm status and effects; a GM storm now or after a forecast; stop it (a tornado lifts too); preview a full storm's effects; charge a monster (during a storm) | `{status, env}` / the `StormEvent` |
| `storm tornado [here \| <player> \| stop]` (docs/WEATHER.md §13.1) | A lightning tornado now (20 s warning): alone, 110-220 m from you like a natural one; `here` on your spot; a name: drawn to that player; `stop` lifts it. One at a time; refused with `WEATHER=off` or where no path fits (towns, water, the world's edge) | the `TornadoState` |
| `weather strike [here | sky | tree | wall | tower | 100-3000 | at <x> <z> | <player>]` | One placed strike now (refused within 4 s of the last): alone, chosen around you like a scheduled one; `here` on your spot (you are hit unless you step out); `sky` a harmless flash; `tree`/`wall`/`tower` the nearest one within 400 m; a distance: a ground strike that far from you in a random direction; `at x z` that spot; a name: that player's spot. A strike whose ground lies in a safe area is harmless (radius 0). Without the lightning module (unit tests) the old cosmetic `strike [distM]` | the `LightningStrike` |

Every `time` change sends `worldClock`; every `weather` change sends `weather` (a strike sends `strike` and the per-player `lightning`). With `WEATHER=off` the `weather` changes are refused.

**Enter-world sequence (wave 9).** Unchanged; `worldEnter.world` carries `clock` and `weather`.

### Wave 10: the jump and the lobby's clock (docs/WAVE_PLAN6.md §3, docs/MOVEMENT.md §4–§5, docs/SCREENS.md §9)

All additive, protocol v1; no database migration, no new GM command, no new server config. Server and client deploy
together: an older server refuses the client's `jump` as an unknown request, and an older client drops the server
`jump` frame (unknown type, a `console.warn` in `net/wire.ts`).

**Jump.** Space plays a cosmetic, server-authoritative jump. It never changes the server position or the move: a
moving player keeps its `move` and the viewers play JUMP_RUN over it; a standing one plays JUMP. So a jump cannot cross a
wall, a blocked nav edge, the coast bounds line or a closed cell, by construction (no nav call is made). The timing
constants are in `packages/shared/src/movement.ts`.

| Direction | t | fields |
|---|---|---|
| client → server (a `GameplayRequest`: exactly one `actionResult`) | `jump` | none (any extra key is rejected) |
| server → client | `jump` | `id` (int, the jumper's entity id), `at` (finite server ms): to the viewers of `id`, **the jumper included** (reuses the client `t`, as `emote` does). No `EntityState` field: a late joiner never sees a jump in progress |

- **Refusals** reuse existing reasons, checked in this order: `dead`; the module gates (`mounted` on a horse; a running
  alchemy fuse is **not** cancelled by a jump, WAVE_PLAN6 D31; `stalling` for a stall owner); then `cant_act` while
  stunned, frozen or knocked down; `busy` during a skill action or a return-scroll cast (moving is **not** busy); and
  `cooldown` before `JUMP_COOLDOWN_MS` (1000 ms) has passed since the last accepted jump, with
  `JUMP_COOLDOWN_SLACK_MS` (150 ms) of slack for arrival jitter (the cooldown lives in the in-memory per-player map
  under `move.jump`). **Allowed** while moving, in combat, visiting a stall, in town and **in a trade** (the trade
  stays open; `TRADE_ALLOWED` += `jump`). A sitting player stands up first (`entityUpdate {posture: 'stand'}`).
- **Budget:** `jump` 2/s, burst 3 (`rate_limited` when over it).
- **Viewers** (client rules, not wire): a `jump` received later than `JUMP_LATE_DROP_MS` (600 ms) after `at` plays
  nothing; a late one seeks into the clip by at most `JUMP_MAX_SEEK_MS` (200 ms, the take-off: it may skip the crouch,
  never the air); the jumper's client, which predicts its own jump, ignores its echo within `JUMP_ECHO_WINDOW_MS`
  (600 ms).
- **Parsing.** The server `jump` needs an integer `id` ≥ 0 and a finite `at` ≥ 0, else the frame is rejected.
- **Mock** (`?mock=1`, `net/mock/movement.ts`): the same answer and broadcast, with `dead`, `mounted`, `stalling`,
  `busy` (a return-scroll cast) and `cooldown`; it does not simulate `cant_act` or a skill action's `busy`.

**The lobby's clock and weather.** `ServerInfo` (the `welcome.server` copy and `GET /api/servers`) gains two optional
fields, the same types `worldEnter.world` carries, so the character screens' sky matches the world's:

| Where | Change |
|---|---|
| `welcome.server` / `GET /api/servers` (extended) | `clock?: WorldClockState`, `weather?: WeatherSync`: the world's clock and weather when the lobby socket connects (a snapshot: a GM `time` change reaches a player on select only at the next `welcome` or at world entry). The lobby socket still never receives `worldClock` |

- **Parsing.** A malformed `clock` or `weather` inside `welcome.server` drops **only that field** (a console warning),
  never the whole `welcome`, so a bad value cannot lock players out at server select. Every other `ServerInfo` field
  keeps the house rule. Absent (an older server, the mock): the stage uses its own fallback time and clear weather.
- The client reads them from the validated `welcome` copy (`app.session.server`), not from the unvalidated
  `/api/servers` list, and evaluates the clock on the lobby socket's server-time offset.

### Wave 11: unique notices (docs/WAVE_PLAN7.md §3, docs/UNIQUES.md §3.3, §5)

All additive, protocol v1: **one server message, no client request**, no new fail reason, no rate-limit row,
`GAMEPLAY_REQUESTS` and `ServerInfo` unchanged. The town life of wave 11 adds **no** message: townsfolk are a pure
function of the server clock every client already has (`worldEnter.world.clock`, `worldClock`, the ping offset).
Server and client deploy together; an older client drops `uniqueNotice` (unknown type, a `console.warn` in
`net/wire.ts`), and a new client against an older server simply never sees one.

| Direction | t | fields |
|---|---|---|
| server → client (world sockets only) | `uniqueNotice` | `event` (`'appeared'` \| `'defeated'`), `mob` (the MobDef code, non-empty), `name` (the mob's English name, non-empty, ≤ 64), `area?` (the zone name at the camp, printed as is: "North-Tiger Mt."), `by?` and `party?` (defeated only: the loot-owner group's top-damage member, and whether that group is a party), `roar?` (appeared only, H11-NL-5: the player is within the unique's `announce.roarRadiusM` and hears her roar once), `at?` (H11-DET-1: the server ms when it happened, ≥ 0; the client starts the town's cosmetic alarm on it, so every friend's alarm starts on the same second; absent from older servers: the receipt time) |

- **Who gets it:** every player in the world at the moment it happens; never the lobby or the character screens, and
  no late replay on login (`/unique list` is the GM's view). A GM's `/unique quiet on` skips that GM's socket.
- **Text** (client i18n, live English only): appear "Tiger Girl has appeared! Area: North-Tiger Mt." (without an area
  "Tiger Girl has appeared!"); defeat "Mei has defeated Tiger Girl!", or "Mei's party has defeated Tiger Girl!" when
  `party`. The banner goes through the one `NoticeBanner` queue (a `kind: 'unique'` style), plus a chat line on the
  notice colour and the cues `ui.uniqueAppear` / `ui.uniqueDown`. The town plays a cosmetic 60 s alarm on `appeared`.
- **Parsing.** `event` must be one of the two values; `mob` and `name` non-empty strings; `area` and `by` optional
  strings; `party` an optional boolean; `by` or `party` on an `appeared` rejects the frame. Unknown keys are dropped.
- **GM** (chat commands, no protocol change): `/unique list | spawn <name|code> [here | camp <id>] | kill <name> |
  despawn <name> | timer <name> <min|now|clear> | quiet <on|off>`, every use in `gm_audit`. A generic GM `spawn` of a
  unique mob is a plain test mob, never announced.
- **Server:** migration 10 adds the table `uniques` (`code, phase, due_at, camp, spawns, last_killer,
  last_killed_at`); the config switch `UNIQUES=on|off` (off = today's Spawner).
- **Mock** (`?mock=1&gm=1`, `net/mock/uniques.ts`): `/unique spawn [name]` broadcasts `appeared` (area
  "North-Tiger Mt.") to the players in the world and, 20 s of mock time later, `defeated` with `by` = the GM and
  `party: true`; `/unique kill` defeats at once (solo form); `/unique list`. Only Tiger Girl; one alive.

**NPC rumour lines (wave 11, lane U-Q; docs/UNIQUES.md §3.10).** `npcDialog` gains `lines?: string[]` (at most
`MAX_NPC_DIALOG_LINES` = 8, each at most `MAX_NPC_DIALOG_LINE` = 300 characters; absent = none): the quest files'
conditional greeting lines that hold right now, shown after the NPC's greeting. The quest file (`QuestFile`) gains
`lines?: QuestDialogLine[]` (at most 64 per file): `{id, npc, text, textNoArea?, when}`, where `when` is one of
`QUEST_LINE_CONDITIONS` (today only `{uniqueAlive: <mob code>}`: that field unique is alive; never with
`UNIQUES=off`). `{area}` in `text` becomes the unique's area name; without one, `textNoArea` is shown (absent: the line
is skipped). Gwakwi and Jeonghye mention Tiger Girl while she lives (`content/quests/jangan.json`).

**Content (wave 11).** `MobDef.ride?: {model: ModelRef, joint}` (mobs.json; `checkMobRide`): the creature a mob rides,
from characterInfo's `ride` column (today only Tiger Girl on `bluetiger.glb`, joint `saddle`); absent in older
exports. `content/uniques.json` (`UniquesFile`, `checkUniquesFile`; the server's start check) and the two town files
(`TownFile` / `TownDressingFile`, `validateTownFile`) are in §14.

### Winter: the snow season (docs/WINTER.md)

All additive, protocol v1; server and client deploy together. **Client → server: nothing new.** The GM command `winter` uses the existing `gm` path. The shared maths is in `packages/shared/src/winter.ts` (`inSeason`, `nextSeasonChange`, `stepWinter`, `WINTER_RATES`, `FROST_ICE`, `WINTER_DEFAULTS`).

**Server → client:**

| t | fields | sent |
|---|---|---|
| `worldEnter.world` (extended) | `winter?: WinterSync` | every enter (the late-joiner state); a malformed value drops only that field |
| `winter` | `winter: WinterSync` | to every player in the world when the season begins or ends, after a GM `winter preview`, `winter cover` or `winter frost`, after an admin change of a winter setting, and every 10 min as a resync. A malformed frame is rejected |
| `weather` / `WeatherSync` (extended) | `from` / `to` may be `'snow'` or `'blizzard'`; `intensity` 0.4..1 also for `snow`; `fromVec.snow?: 0..1` (absent from an older server = 0) | as before. In season the server sends the schedule's rain as `snow` and its storms (and storm events) as `blizzard`; a GM hold is sent as typed |
| `storm` / `StormStatus` (extended) | `winter?: true` (the precipitation is snow, a storm is a blizzard); effect ids gain `'snow'` (no pct) and `'drifts'` (signed pct: run speed during a blizzard) | as before |

- `WinterSync` = `{season: boolean, cover: 0..1, frost: 0..1, at (server ms), strength: 0..1 (the admin snow strength), start: 'MM-DD', end: 'MM-DD' (inclusive; start > end wraps the new year), timeZone: string (1..64), preview?: true}`.
- Clients carry `cover` and `frost` forward from `at` with the shared `stepWinter`, under the blended weather they show and the sky's daylight, as they do the surface wetness. They ease what they draw toward each new message. `preview` draws cover = `strength` and frost = 1 and leaves the state alone.
- **Older clients** ignore `winter` (an unknown type) and drop `StormStatus.winter`. They reject a `weather` with an unknown kind and a `storm` with an unknown effect id (closed lists), like any closed-list addition. Server and client ship together.

**Server.** `apps/server/src/winter.ts` (GameplayModule `winter`, after `weather`) integrates the cover and the frost once a second. It saves them to `DATA_DIR/winter.json` (atomically) every 2 min while they change, and catches up after a restart along the weather schedule (at most 72 h). The config and admin knobs are `WINTER` (on), `WINTER_START` (`12-01`), `WINTER_END` (`01-15`), `WINTER_TZ` (the server's), `WINTER_STRENGTH` (1) and `WINTER_TORNADO` (off), all live in the admin panel (group "Winter season"; the panel gained a `text` setting type).

**GM** (role `gm`; also typed in chat as `/winter`):

| Command | Effect | `data` |
|---|---|---|
| `winter` | Season on or not, dates and time zone, days to the next change, cover, frost, snowfall, strength, preview, the tornado knob | `WinterSync` |
| `winter preview [on\|off]` | Every client draws the full season look; the season, its dates and the snow are unchanged | `WinterSync` |
| `winter cover <0-1>` / `winter frost <0-1>` | Set the snow now (it keeps building up or melting with the weather) | `WinterSync` |
| `weather snow[:0.4-1] [minutes] [transitionS]` / `weather blizzard ...` | Snow as a GM weather hold, any time of the year (it never changes the season) | `WeatherSync` |

### Admin panel: registration switch and bans (docs/ADMIN.md)

All additive, protocol v1. The panel's own HTTP API (`/api/admin/*`, `packages/shared/src/admin.ts`) is not part of
the game protocol; docs/ADMIN.md §3 lists it.

| Where | Change |
|---|---|
| `welcome.server` / `GET /api/servers` (extended) | `registration?: 'open' \| 'closed'`: whether `POST /api/register` accepts new accounts. Absent (older servers, the mock) = open. A bad value drops only that field, like `clock` |
| `POST /api/register` | 403 `forbidden` "Registration is closed on this server." while it is closed (checked before anything else) |
| `POST /api/login` | 403 `forbidden` "This account is banned: \<reason\>" for a banned account with the right password (no session); a ban also ends the account's sessions and closes its socket with 4010 |

The login screen asks `GET /api/servers` each time it opens and hides Register when every server says `closed`
(`registrationOpen` in `apps/game/src/net/api.ts`); a `forbidden` answer to a registration hides it too.

### Play the Boss, layers 1–5 (docs/PLAY_THE_BOSS.md §5)

All additive, protocol v1. Types, lists and the settings schema live in `packages/shared/src/pilot.ts`; protocol.ts
spreads them into its unions and lists. Every request is a GameplayRequest answered by one `actionResult`.

| Direction | Message / field | Notes |
|---|---|---|
| client → server | `pilotVolunteer {on}` | during a call only (else `no_event`): `on` volunteers this character (eligible; one entry per account, else `not_eligible` with a message), `false` withdraws it. The player also gets its own `huntEvent` (just before the answer). Accepted while dead. 1/s, burst 3 |
| client → server | `pilotAnswer {event, accept}` | only the offered account, inside `pilotOffer.expiresAt`; else `no_event`. 1/s, burst 3 |
| client → server | `pilotAct {ability, target?, x?, z?, repeat?}` | `ability` /^[a-z]{1,16}$/ (a kit id); `x`/`z` together; `repeat` on Claw = auto-claw. Fails: `no_event`, `not_found`, `cant_act`, `busy` (her cast window, or < 500 ms since the last act), `cooldown`, `no_charges`, `invalid_target`, `too_far` (more than 8 m past the reach), `safe_zone`. 5/s, burst 10 |
| client → server | `pilotTaunt {line}` | 0..15 on the wire, 0..7 used; 4 s cooldown (`cooldown`). 1/s, burst 2 |
| client → server | `pilotQuit` | her AI finishes; the reward is forfeit. 1/s, burst 2 |
| client → server | `moveTo`, `stopAction` | unchanged on the wire: while you pilot, the server steers her with them |
| server → client | `huntEvent {event: HuntEventView}` | every world socket, on changes (the hunters and volunteers counts at most every 2 s) and on enter-world; `pilot` only once `phase` is `ended`. Phase `call` (layer 4): `callEndsAt`, `volunteers`, `minLevel` (additive) and the recipient's own `you {volunteered, eligible, why?}`; phase `offer` after a call keeps `callEndsAt` and `volunteers` (the banner's "Drawing a volunteer…") |
| server → client | `pilotOffer {event, expiresAt, surviveMin, downsTarget, idleSec}` | the drawn (or GM / admin picked) player; a decline or a timeout after a call draws the next volunteer |
| server → client | `pilotStart {event, mob, kit, huntEndsAt, downsTarget, area, taunts, senseM, place}` | the pilot, after its interest moved to her (`mob` is spawned first); `event` 0 = a GM attach session (no timer, no downs) |
| server → client | `pilotState {steering, idleWarnAt?, hunting, downs, charges, ready, enraged?, stalkUntil?}` | the pilot, on change; `ready` = server ms per ability still cooling down |
| server → client | `pilotEnd {event, reason, gold?, honor?, downs?, steeredMs?}` | the pilot; then its view returns to the body |
| server → client | `huntPing {event, x, z, r, at}`, `huntTrail {points: [x, z, at][]}`, `huntRoar {bearing, distM, at}`, `huntTaunt {id, line}` | hunters (`huntTaunt`: her viewers) |
| `ActionFailReason` | `piloting`, `not_eligible`, `no_event`, `no_charges` | `piloting`: the body in a trance refuses everything but `stopAction` |
| `EntityState` / `entityUpdate` | `trance?`, `piloted?`, `honor?` | booleans on `entityUpdate` (`honor: ''` clears) |
| `cast` | `clip?` | the clip type of a server-built ability (`skill` `PILOT_TIGERWOMAN_POUNCE`, ...) |

Free chat from the pilot is refused with `error forbidden` (re `chat`); slash commands still run. The admin panel's
`/api/admin/boss/*` routes are listed in docs/PLAY_THE_BOSS.md §6.3 (all built: status, settings, start, pick, stop, events,
blocks, eligibility).

Layer 5 (big crowds) adds nothing on the wire: her max HP follows the hunters every 5 s and goes out as the existing
`entityUpdate {id, hp, maxHp}` to everyone who sees her (her HP keeps its fraction). Old clients ignore `minLevel`.

### "What's new": the update notes window (docs/CHANGELOG_WINDOW.md)

All additive, protocol v1. Types and the Markdown dialect live in `packages/shared/src/news.ts`; the seen mark is
migration 15 (`accounts.news_seen_date`, `accounts.news_seen_id`).

| Where | Change |
|---|---|
| `welcome` (extended) | `news?: number` (0..1000): how many published entries this account has not seen (at most `NEWS_UNSEEN_MAX` = 5). Absent = none, or an older server. The client fetches them only when it is above 0 |
| `GET /api/news` | Bearer (any account). `ApiNewsList {entries, unseen}`: every published entry (drafts never), newest first (date, then id), and the unseen ids, newest first. `Cache-Control: no-store`. 401 without a valid session |
| `POST /api/news/seen` | Bearer. Body `{id}` (`NEWS_ID`, no other keys, else 400). Everything up to and including that entry counts as seen for this account; the mark never moves back. Answers `ApiNewsSeenResponse {unseen}`; 404 for an unknown or draft id |
| `GET /api/news/img/<name>` | Public (no session), GET/HEAD. `<name>` must match `NEWS_IMAGE_NAME` (lower case `.jpg`/`.jpeg`/`.png`/`.webp`, no folders), looked up in `DATA_DIR/content/changelog/img`, then `CONTENT_DIR/changelog/img`. `Cache-Control: public, max-age=86400` + ETag; 404 for anything else |

**Unseen rule.** With a mark: the published entries newer than it. Without one (the account never pressed "Got it"): the
entries dated on or after the account's creation day (UTC), so a new player is not handed the whole history. A deploy
during play changes nothing for connected players: the window opens at the next login (the next `welcome` of a new
session); a reconnect of the same session does not open it again.

The admin panel's routes (`GET /api/admin/news`, `GET|PUT|DELETE /api/admin/news/<id>`, `POST /api/admin/news-images`)
are in docs/CHANGELOG_WINDOW.md §4.

## 12. Combat and items: horses, monster skills, durability and repair, alchemy, Berserk (docs/SYSTEMS_COMBAT.md, docs/WAVE_PLAN2.md §3.2)

**Client → server** (each is a `GameplayRequest`: exactly one `actionResult`):

| t | fields | budget /s (burst) |
|---|---|---|
| `mountRide` | `cos: int` (your own parked horse; the server walks you there first) | 2 (5) |
| `mountDismount` | — | 2 (5) |
| `mountDismiss` | — (allowed while dead) | 2 (5) |
| `repair` | `npc: int`, `items?: RepairRef[]` (1..16; each strictly `{equip: EquipSlot}` or `{bag: bag index}`); absent = repair everything damaged | 2 (5) |
| `alchemyReinforce` | `item`, `elixir: bag index`, `powder?: bag index` (all different) | 2 (5) |
| `alchemyCancel` | — (allowed while dead) | 2 (5) |
| `berserk` | — | 2 (5) |

`itemUse` is unchanged; it also summons a horse (`ItemUse.summon`) and uses Recovery Kits (`ItemUse.target: 'mount'`).

**Server → client**:

| t | fields |
|---|---|
| `alchemyStart` | `item: bag index`, `readyInMs: 0..30000` |
| `alchemyResult` | `item: bag index`, `code`, `outcome: 'success' \| 'fail' \| 'cancelled'`, `plus: 0..255` |

Plus the shared changes of §11 (wave 8): `EntityKind 'cos'`, `mount`/`rider`/`berserkMs`, `CombatHit.hwan`, `PlayerStats.hwan`, `worldEnter.world.alchemyRate`/`alchemyMaxPlus`, mob `cast`/`combat`.

**Rules in short** (the details are docs/SYSTEMS_COMBAT.md):

- **Horses.** Mounted: move speed × `CosDef.runSpeed / 5` (skill speed buffs ignored); `attack`, `useSkill`, `sit`, `emote`, `stallCreate`, `alchemyReinforce`, `berserk` refused `mounted`; hits on the rider land on the horse (DoT ticks excepted). Summon/ride refused `in_combat` within `COS_COMBAT_LOCK_MS` (20 s) of combat, `cos_active` with a horse out, `berserk_active` while berserk (D49), `busy` during a skill, an item cast or a pending alchemy fuse (D43/D44: no alchemy on horseback, either order). A GM's horse is invisible with its GM (only staff and the GM see it). A parked horse is dismissed beyond `COS_PARK_RANGE_M` (60 m) and when its owner warps or leaves (a ridden horse warps along and comes back mounted at the next login, with its saved HP). `mountDismount` while moving is refused `moving`; the rider steps 1.2 m to the horse's left. A Recovery Kit needs the own horse, ridden or within 30 m (`not_usable` "You have no horse." / `too_far`), and is used up even at full HP.
- **Monster skills.** A mob's swing picks one of its MSKILL rows by weight; `cast` → `combat {skill, instance}` per target (at `at` for projectiles), or `castEnd`. Damage scale `MOB_SKILL_DAMAGE` (`relative` by default) × `MOB_DAMAGE_RATE`.
- **Durability.** `ItemStack.durability` (absent = full = the top of `stats.durability`). Worn items wear in combat (5 % weapon per landed hit, 5 % armour per hit taken, 10 % shield per block). At 0 the item is broken: no stats and no `perPlus`; `attack` / weapon skills refused `broken`; `itemEquip` of a broken item refused `broken`. Repair at an NPC with the `'repair'` role: cost `ceil(repairCost × missing / max)`, all or nothing.
- **Alchemy.** Elixir (+ optional Lucky Powder of the equipment's degree) on a bag item: chance `min(100, (elixir + powder) × ALCHEMY_RATE)` %, success +1, failure +0, capped at `ALCHEMY_MAX_PLUS`. The fuse takes `ALCHEMY_FUSE_MS`; moving, attacking, skills, NPC talk, a pickup, a return-scroll cast, death, warp, an item leaving its slot and logout cancel it (nothing is consumed). While it runs, `tradeRequest`, `tradeRespond`, `stallCreate`, `itemMove`, `itemSplit`, `itemEquip`, `itemUnequip`, `itemDrop`, `shopSell`, `storageDeposit` and `repair` are refused `busy` (D44); a horse summon (`itemUse`) or `mountRide` is refused `busy` too (D43: no fuse on horseback). `alchemyCancel` answers `ok` even with no fuse running. The result line is the client's; the server only announces a success from `ALCHEMY_ANNOUNCE_FROM` (+7) to everyone. A worn item at +N adds `perPlus × N` to its stats.
- **Berserk.** Points 0..5 from kills (`HWAN_KILL_PCT` % per normal kill); at 5, `berserk` gives ×2 damage and ×2 speed for `HWAN_DURATION_MS`.

**Message order** (each request's `actionResult` first):

| Request | Order |
|---|---|
| horse summon (`itemUse`) | `actionResult` → `inventoryUpdate` → `spawn {cos}` → `entityUpdate {p.mount}` + `entityUpdate {cos.rider}` |
| `mountDismount` | `actionResult` → `stop {p}` → the `entityUpdate` pair with `null` |
| `mountRide` (walk first) | `actionResult` → `move`s → `stop` → the `entityUpdate` pair |
| Recovery Kit (`itemUse`) | `actionResult` → `inventoryUpdate` → `entityUpdate {cos.hp}` → `itemEffect {id: cos}` |
| `repair` | `actionResult` → `inventoryUpdate {bag?, equip?, gold}` → `stats` when a broken worn item came back |
| `alchemyReinforce` | `actionResult` → `alchemyStart` → (fuse) → `inventoryUpdate` → `alchemyResult` |
| `berserk` | `actionResult` → `entityUpdate {berserkMs}` → `statsDelta {hwan: 0}` → `stats` |
| mob skill | `cast` → (castMs) → `combat {instance}` per target (at `at` for projectiles), or `castEnd` |

**GM** (staff only, audited; none equals a client chat prefix): `horse [cos code] | horse off`, `hwan <0..5>`, `dur <slot|all> <n>`, `plus <slot|bag> <0..12>`, `mobskill <mob id> <MSKILL code>`.

## 13. Social: trade, stalls, guilds (docs/SYSTEMS_SOCIAL.md, docs/WAVE_PLAN2.md §3.2)

**Constants**: `TRADE_SLOTS` 12, `TRADE_RANGE` 10 m, `TRADE_BREAK_RANGE` 15 m, `TRADE_REQUEST_MS` 30 000; `STALL_SLOTS` 10, `STALL_VISITORS_MAX` 8, `STALL_RANGE` 10 m, `STALL_BREAK_RANGE` 15 m, `STALL_PRICE_MAX` 1 000 000 000, `STALL_TITLE_MAX` 32, `STALL_GREETING_MAX` 80 (code points), `STALL_NPC_CLEARANCE` 3 m, `STALL_SPACING` 1.5 m; `GUILD_NAME` `/^[A-Za-z][A-Za-z0-9]{1,11}$/`, `GUILD_TITLE_MAX` 12, `GUILD_NOTICE_TITLE_MAX` 32, `GUILD_NOTICE_MAX` 240, `GUILD_INVITE_MS` 30 000, `GUILD_MEMBERS_MAX` 100 (the live cap is config `GUILD_MAX_MEMBERS`), `GUILD_MANAGER_NPCS` `['NPC_CH_GENARAL_SP']`; `GuildRank` `'master' | 'member'`; `GuildPerm` `'invite' | 'kick' | 'notice' | 'title'`.

**Client → server** (each is a `GameplayRequest`; strings are bounded in code points):

| t | fields | budget /s (burst) |
|---|---|---|
| `tradeRequest` | `target: int` (a player entity) | 1 (3) |
| `tradeRespond` | `from: int` (the requester's entity id), `accept: boolean` (a decline is allowed while dead) | 2 (5) |
| `tradeOffer` | `bag: bag index`, `count?: 1..10000` (default: the whole stack) | 10 (20) |
| `tradeTake` | `slot: 0..11` | 10 (20) |
| `tradeGold` | `amount: 0..MAX_GOLD` (the new offered amount) | 5 (10) |
| `tradeLock`, `tradeAccept` | — | 2 (5) |
| `tradeCancel` | — (allowed while dead) | 2 (5) |
| `stallCreate` | `title: 0..32` (`''` = the default title) | 1 (3) |
| `stallItem` | `slot: 0..9`, `bag`, `count: 1..10000`, `price: 1..STALL_PRICE_MAX` | 10 (20) |
| `stallItemRemove` | `slot: 0..9` | 10 (20) |
| `stallText` | `title?: 0..32`, `greeting?: 0..80` (at least one) | 2 (5) |
| `stallOpen` | `open: boolean` | 2 (5) |
| `stallClose` | — (allowed while dead) | 1 (3) |
| `stallVisit` | `owner: int` | 2 (5) |
| `stallLeave` | — (allowed while dead) | 2 (5) |
| `stallBuy` | `owner: int`, `slot: 0..9`, `code: CodeName128`, `count`, `plus?: 0..255`, `durability?: number`, `price`: the listing's stack and price exactly as shown (ItemStack convention: `plus` absent = 0, `durability` absent = full), else `stall_changed` (S1, D47: a Modify swap to another +N or a broken copy at the same code, count and price is refused) | 5 (10) |
| `guildCreate` | `npc: int` (a Guild Manager), `name` (≤ 32; `GUILD_NAME` and the reserved names are the server's: `bad_name`) | 1 (3) |
| `guildDisband` | `npc: int` | 1 (3) |
| `guildInvite` | `name: CHARACTER_NAME` | 1 (3) |
| `guildRespond` | `guild: 1..MAX_SAFE_INTEGER`, `accept: boolean` | 2 (5) |
| `guildLeave` | — | 1 (3) |
| `guildKick`, `guildMaster` | `member: 1..MAX_SAFE_INTEGER` (characterId) | 2 (5) / 1 (3) |
| `guildPerms` | `member`, `perms: GuildPerm[]` (unique) | 2 (5) |
| `guildTitle` | `member`, `title: 0..12` (`''` clears) | 2 (5) |
| `guildNotice` | `title: 0..32`, `text: 0..240` (the 1024-byte frame limit still applies) | 1 (3) |

Allowed while dead: `tradeCancel`, `tradeRespond` (a decline; an accept answers `dead`), `stallClose`, `stallLeave`, `guildRespond`, `guildLeave`, `guildKick`, `guildPerms`, `guildTitle`, `guildNotice`, `guildMaster`.

**Server → client**:

| t | fields |
|---|---|
| `tradeRequested` | `from` (entity id), `name`, `level`, `expiresInMs` |
| `trade` | `trade: TradeState` (full state to both sides after every change; required, never null) |
| `tradeEnd` | `reason: 'done' \| 'cancelled' \| 'declined' \| 'expired' \| 'moved' \| 'too_far' \| 'dead' \| 'left' \| 'failed'`, `name?`, `message?` |
| `stall` | `stall: StallView \| null` (the stall you own or visit, after every change; null = left or closed), `reason?: 'closed' \| 'left' \| 'too_far'` |
| `stallSold` | owner only: `slot`, `buyer`, `code`, `count`, `price` |
| `guildInvited` | `guild` (id), `name`, `from`, `expiresInMs` |
| `guild` | `guild: GuildState \| null` (enter-world when in one, and structural changes) |
| `guildMember` | `member: GuildMember` (one member added or changed) |
| `guildMemberRemoved` | `characterId` |
| `guildEvent` | `event: 'created' \| 'joined' \| 'left' \| 'kicked' \| 'master' \| 'disbanded' \| 'declined' \| 'expired' \| 'online' \| 'offline' \| 'notice' \| 'perms' \| 'title'`, `name` |

- `TradeState` = `{partner (entity id), name, level, mine: TradeSide, theirs: TradeSide}`; `TradeSide` = `{items: (TradeItem | null)[12], gold, locked, accepted}`; `TradeItem` = `{stack: ItemStack, bag?}` (`bag` only on your own side).
- `StallView` = `{owner (entity id), name, title, greeting, state: 'modify' | 'open', items: (StallListing | null)[10], visitors: 0..8}`; `StallListing` = `{stack, price: 1..STALL_PRICE_MAX, bag?}` (`bag` only in the owner's view).
- `GuildState` = `{id, name, master (characterId), createdAt, notice: {title, text, at}, maxMembers, members: GuildMember[] (1..100)}`; `GuildMember` = `{characterId, name, model, level, rank, perms (unique), title, online, lastSeen, joinedAt}`.
- The parsers reject `items` arrays of the wrong length, a `trade` / `stall` / `guild` frame without its key, and keep `null`.

**The inventory lock.** While a trade window is open or a stall exists, only an allowlist of requests passes (chat, `stopAction`, `hotbarSet`, `statUp`, `skillLearn`, `masteryUp`, `buffCancel`, `party*`, `guild*` but create, `mountDismiss`, and the owner's own trade/stall requests; a trade also allows `storageOpen`, `npcClose`, `emote` and `stallLeave`); everything else is refused `trading` / `stalling` (docs/WAVE_PLAN2.md §6.5). Only a stall's owner is locked; its visitors are not. The trade module also asks the other modules' gates about the invitee (`tradeRespond`), so a busy partner (fusing, stalling) is refused with that module's reason. `moveTo`, `attack`, `useSkill` and `npcTalk` cancel a trade; a stall owner's `moveTo` is dropped. The commit re-checks every offered or listed stack (code, count, plus, durability). `ItemDef.canTrade === false` (or an unknown item) refuses `tradeOffer` and `stallItem` with `not_usable`.

**Trade details.** `tradeCancel` with no open window withdraws your pending request (the invitee gets `tradeEnd cancelled`), else `not_found`; the other trade requests without a window answer `not_found`. A request needs both players visible, alive, not trading and within `TRADE_RANGE`; one pending request per invitee (`cooldown`). The window closes on a move or warp (`moved`), death (`dead`), leaving (`left`; the leaver gets nothing), `TRADE_BREAK_RANGE` or the partner turning invisible (`too_far`, checked once a second). The final accept answers `ok`; a commit that then fails sends both `tradeEnd failed` with a message.

**Stall details.** `stallCreate` needs the town safe area (`STALL_TOWN_ONLY`), `STALL_NPC_CLEARANCE` from NPCs and `STALL_SPACING` from other stalls (`wrong_place` with the reason), and 5 s out of combat (`in_combat`, D29); creating one stops the owner, closes its NPC dialog and stands it up. Buying needs no open visit, only a visible stall within `STALL_RANGE`. The owner gets both `stallSold` and a system chat line ("X bought item Y."). A listing whose bag slot changed outside a request is withdrawn at the next buy (`not_found`).

**Message order**: trade accept / change → `actionResult` → `trade` to both; final accept → `actionResult` → each side's `inventoryUpdate`, `statsDelta` → `tradeEnd done` (both). `stallBuy` → buyer: `actionResult` → `inventoryUpdate` → `statsDelta {gold}`; owner: `inventoryUpdate` → `statsDelta {gold}` → `stallSold` → system line; everyone at the stall: `stall`.

**Persistence** (migration v9): `guilds`, `guild_members`, `characters.guild_left_at` / `guild_disbanded_at`, and `social_log` (every completed exchange and stall sale, for GM audits). Trades and stalls are runtime only. Migration v8 (§12) adds `characters.hwan_points` and `char_mount`.

**GM**: `guilds list | info <name> | rename <old> <new> | disband <name> | kick <guild> <character>` (named `guilds`: the client's `/guild` prefix claims `/guild …` lines). A GM disband or kick starts no penalty clock; kicking the master hands the mastership to the earliest joiner.

## 14. Content files (`work/out/data/`, served at `/out/data/`)

The exporter writes these files. The server and client read them with `contentEntries()` and may check them with `checkContentFile()`.

- Every file except `levels.json` is a `ContentFile<T>`: `{schema: 1, kind, generatedAt, sources[], entries[]}`.
- `levels.json` is a bare `LevelDef[]`, as the exporter already writes it.
- Readers ignore unknown keys.

| File | Record | Source |
|---|---|---|
| `mobs.json` | `MobDef` | client characterdata (TypeID 1/2/1/x): level, HP/MP, defences, HR/ER, EXP, speeds, scale, model; attack from the default skill's `att` param in skilldata |
| `nests.json` | `NestDef` | **port** `spawns.json` (Tab_RefNest/Hive/Tactics) |
| `items.json` | `ItemDef` | client itemdata (TypeID 3/x/x/x) + icons |
| `skills.json`, `masteries.json` | `SkillDef`, `MasteryDef` | client skilldata + skilleffect + skillmasterydata (docs/SKILLS.md §3) |
| `npcs.json` | `NpcDef` | client characterdata (TypeID 1/2/2/x) + npcpos.txt |
| `shops.json` | `ShopDef` | client refshop* tables; port `npcshops.json` only as a fallback |
| `drops.json` | `DropTable` | **port** `drops.json` (_RefDropGold, _RefMonster_AssignedItem(Rnd)Drop, _RefDropItemGroup, _RefDropClassSel_*) |
| `levels.json` | `LevelDef[]` | client leveldata.txt |
| `cos.json` | `CosDef` | wave 8: client characterdata (TypeID 1/2/3/1): the Red Horse `COS_C_HORSE1` (docs/SYSTEMS_COMBAT.md §6.3) |
| `towns.json`, `zones.json` | `TownDef`, `ZoneDef` (`checkZoneDef`) | ContentFile-shaped, not in `CONTENT_FILES`; zones: client textzonename.txt + refregion.txt (docs/FIELDS.md §6.2) |
| `world/<world>/town.json` | `TownFile` (`validateTownFile`, kind `'town'`) | wave 11: ours, `content/town/<town>.json` validated and copied by the converter (route graph, places with seats, folk, hour bands, English lines; docs/TOWN_LIFE.md §2.4); the client's pure schedule reads it |

- **Ours, not exports (wave 11).** `content/uniques.json` (`UniquesFile`: the world-boss uniques, their timers, tuning,
  summons, enrage, fury, corpse time, announcements and unique drop tables; `checkUniquesFile`, and the server refuses to
  start on a problem) and `content/town/<town>-dressing.json` (`TownDressingFile`, kind `'townDressing'`: props, banners,
  lamps' ambient rows, decals, crack-grass bands, the pond profile; applied by the converter only) are read from the
  repo, not served under `/out/data/`.
- **Field sources.** Every field in `content.ts` names its source: a client textdata column, or port data. A field filled any other way lists its source in `fieldSources`.
- **Client data is authoritative.** Monster stats, levels, EXP and models always come from our client. The port data only supplies what the client does not have: nests, tactics and drops.
- **Provenance.** Every record derived from the port carries `provenance: 'vsro-server-db via third-party port'` (`PROVENANCE_PORT`).
- **The port is data only.** Its data is read-only input. Its code is never copied or run.
- **Coordinates.**
  - `NestDef.x/z` are glTF metres in the world manifest frame (`docs/CONVENTIONS.md`, "World space").
  - The port stores positions in its own frame. The exporter converts them, keeps the raw values in `NestDef.source`, and must verify the transform against anchors present in both data sets (for example NPCs in port data vs `npcpos.txt`, or teleporters vs `teleportdata.txt`).
- **Units.** Distances are metres (textdata units × 0.1), times are ms, and speeds are m/s.

## 15. Open points

- Variant multipliers (champion, giant, party) for HP, EXP and drops are not in the client data; they are server config for now.
- `MobDef.spExp` and aggression flags need a source: tactics come from the port, and characterdata column 93 is unverified.
- characterdata columns after 60 follow the documented _RefObjChar order and still need checking against real rows (exporter).
- The player basic-attack interval waits for `skills.json` (weapon basic-attack `ReuseDelay`). Until then it is a server default per weapon type.
