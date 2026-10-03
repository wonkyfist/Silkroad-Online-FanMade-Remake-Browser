# Wave plan 2: waves 7B and 8 (cross-spec decisions, unified protocol, lanes)

This plan merges four verified specs into one build order:

- docs/UI.md: the UI rework (kit, retail layout, every window);
- docs/EFFECTS.md: retail animations and effects (skills, hits, drops, level-up, idle, emotes, ambient);
- docs/SYSTEMS_COMBAT.md: horses, monster skills, durability and repair, alchemy, Berserk;
- docs/SYSTEMS_SOCIAL.md: player trade, stalls, guilds.

It does three things:

- it settles every place where those specs disagree, point at each other in a circle, or leave a file with two owners or none (§2);
- it merges their wire additions into one collision-free protocol list per wave (§3);
- it cuts **wave 7B** (UI rework + animations/effects) and **wave 8** (the systems, built on the new kit) into steps and lanes that own disjoint files (§4–§6).

When this plan and a spec disagree, **this plan wins**. The specs stay the detailed design of each lane; a lane reads its spec section and this plan's row for it.

**Tags.**

- **[confirmed]**: checked in the code or data at HEAD `f5fa4c2` (2026-09-28, "Wave 7A fixes"), or in the four specs as verified.
- **[likely]**: strong evidence, not proven.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this plan makes.

**Repo state when this was written [confirmed].**

- HEAD `f5fa4c2`. `git status` shows only the four untracked spec docs. The uncommitted edits the specs warn about (in `gameplay.ts`, `npc.ts`, `gm.ts`, `hud/index.ts`, `hud/player.ts`, `screens/world.ts`, `entities.ts`, `style.css`, `convert/data/npcs.ts`) were committed in `f5fa4c2`. Every seam step starts from that commit or later; spec line numbers drift, so **every hook is found by its quoted code, not its line number**.
- Schema **v7**: `apps/server/src/db.ts` has 7 `MIGRATIONS`, `SCHEMA_VERSION = MIGRATIONS.length`; the comment "8: reserved for a late wave-4 need" was never used. `apps/server/test/modules-w4.test.ts:158` asserts `SCHEMA_VERSION` 7.
- 1,554 tests, typecheck clean (commit message of `f5fa4c2`).

---

## 0. Summary

1. **Two waves, in this order.**
   - **Wave 7B** = docs/UI.md + docs/EFFECTS.md. The UI kit and export land first, then the HUD and window migrations; the effects lanes run beside them. Protocol changes are small (EFFECTS P1, P3, P4).
   - **Wave 8** = docs/SYSTEMS_COMBAT.md + docs/SYSTEMS_SOCIAL.md, every new window built on the kit from day one.
2. **The order flips one assumption of the system specs.** SOCIAL and COMBAT assumed their client seams land *before* the UI migration lanes (UI-H, UI-W). With 7B first, the UI lanes instead **build the wave-8 mount points into the migrated files** (§4.1: player-frame hosts, target-action registry, NPC-service registry, shop footer, slot decorators, bag-slot marks, option rows, chat kinds, cursor kinds). Wave 8 then touches almost no UI file.
3. **Protocol first, then seams, then lanes** (the docs/WAVE_PLAN.md method). Each wave has one protocol step, one server-seam pass and one client-seam pass. Only those steps edit the dispatch points of the hot files; lanes edit hot files only at the hook lines listed here.
4. **Migrations.** Wave 7B adds none. Wave 8 adds **v8 (combat and items)** and **v9 (social)**, both in the wave-8 foundation commit; `SCHEMA_VERSION` becomes 9 (§2.6).
5. **One protocol list per wave** (§3), checked against `protocol.ts` and each other: no name collides. `busy` already exists and is never re-added (D10).
6. **Every lane owns its files.** Where two specs claimed a file, §2 names the one owner; where both disowned it (the damage-number sprites), §2 assigns it.
7. **Never cut:** the kit and its export, the retail scale, the window chrome, the wave-8 mount points, weapon trails, the drop models, the mob-attack presentation path, monster skills, durability and repair, trade and its inventory lock, `role-policy.test.ts`.

### 0.1 Where each user request lands

| User request | Where | Status |
|---|---|---|
| Game speed (EXP 3×, SP 3×, gold 3×, drops 2× on the mini PC) | `EXP_RATE`, `SP_RATE`, `GOLD_RATE`, `DROP_RATE` knobs [confirmed `config.ts:213-216`] | Knobs exist; set in the mini PC's env file (docs/DEPLOY.md). Not a lane. |
| Questline pacing (Return Scrolls, Miaoryeong, Qin-Shi Tomb, Fengil's tip) | Wave 7A | Shipped in `f5fa4c2` [confirmed commit message] |
| NPC facing, storage chest model, SP on level-up | Wave 7A | Shipped in `f5fa4c2` |
| Player skills: proper animation and effect placement | Wave 7B, EFFECTS lanes FX-X, FX-C1 (+ H1/H2 harness) | §5 |
| SRO effects for everything (coins, floor items, …) | Wave 7B, FX-C2, FX-C3 | §5 |
| Rework the whole UI with SRO's own art | Wave 7B, UI-X, UI-K, UI-H, UI-W, UI-O, UI-G | §5 |
| Monster skills | Server: wave 8 MS-S. Client presentation: wave 7B FX-C1 (D4) | §5, §6 |
| Horses, repair and durability, alchemy, Berserk | Wave 8 (COMBAT lanes) | §6 |
| Player trade, stalls, guilds | Wave 8 (SOCIAL lanes) | §6 |

---

## 1. How to read the lane ids

| Id | Wave | From spec | What |
|---|---|---|---|
| W7-F | 7B | EFFECTS FX-0 (+ its §4 protocol) | Protocol P1/P3/P4 and the client animation seams |
| UI-X, UI-K, UI-H, UI-W, UI-O, UI-G | 7B | UI.md §9 | Export, kit (+ zoom commit), HUD, windows, outer screens, GM |
| FX-X, FX-S, FX-C1, FX-C2, FX-C3, FX-I | 7B | EFFECTS §6 | Export, server, skill/combat fx, world/system fx, feedback widgets, lab |
| I7B, H7B | 7B | — | Integration, adversarial hunt |
| W8-F | 8 | COMBAT F6-FS + SOCIAL SOC-P + SOC-FS | Protocol, content types, migrations v8/v9, server seams |
| W8-FC | 8 | COMBAT F6-FC + SOCIAL SOC-FC (reduced) | Client seams not already built in 7B |
| EXP | 8 | COMBAT EXP + SOCIAL SOC-X | Exporter |
| MS-S, MR-S, MR-C, DR, AL, BZ | 8 | COMBAT §8 | Monster skills (server), horses, durability/repair, alchemy, Berserk |
| TR-S, ST-S, GU-S, TR-C, ST-C, GU-C | 8 | SOCIAL §10 | Trade, stall, guild (server and client) |
| I8, H8 | 8 | — | Integration, adversarial hunt |

Dropped lane ids: COMBAT **MS-C** (folded into FX-C1, D4), COMBAT **F6-FC**'s `onChatCommand` (D9), SOCIAL **SOC-X** (folded into EXP, D29), UI.md's `effect/select_0N` export line (D3).

---

## 2. Conflicts and gaps across the specs, with decisions

### 2.1 File ownership

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| D1 | Wave order vs the specs' seam order | SOCIAL §10 ("SOC-FC runs before UI-H/UI-W"), COMBAT §6.5 (combat lanes mount "beside" until UI lands), UI.md §9 ("migration after the feature lanes merge") | Three specs assumed the systems land first; the user's order is UI + effects first | **7B before 8** [decision]. The UI migration lanes (UI-H, UI-W) and the kit (UI-K) build the wave-8 mount points listed in §4.1 as part of their migration, each with a unit test. Wave-8 lanes use them and edit no migrated UI file except the hook lines in §6. |
| D2 | Damage-number sprites (`hud/effects.ts` `Floaters` → new `hud/hitcount.ts`) | UI.md §4.10 gives them to EFFECTS FX-C3; EFFECTS §6.6 gives them to UI-H | **Both specs disown the file** | **FX-C3 owns** new `hud/hitcount.ts` and the `Floaters` class in `hud/effects.ts` (same `add(at, amount, kind)` API), with EFFECTS §3.1's rules (18×30 digits, white dealt / red taken / `_player` other, "Critical" / miss / block tags, heals stay green DOM text) [decision]. `LevelUpBanner` / `HudMessages` in the same file are not edited; they take kit token colours through CSS. UI-X exports `interface/hitcount/*.ddj` (52 files) to `ui/hitcount/*.png`. Floaters stay outside the zoomed layer (UI.md §3.2). |
| D3 | Selection-circle textures `effect/select_01..04.ddj` | UI.md §5.4 (UI-X → `ui/effect/select_0N.png`), EFFECTS §5.4 (FX-X `export-fx.ts` → `/out/fx/tex/ui/select_0N.png`) | Two exporters, two paths | **FX-X** exports them through `export-fx.ts` to `/out/fx/tex/ui/select_0N.png` [decision]; UI-X drops its `effect` glob. The consumer (FX-C3 `TargetDecal`) is an fx lane. |
| D4 | Mob attacks on the client (`world/skills-view.ts`, `world/skill-fx.ts`) | COMBAT MS-C (folded into FX-C1), EFFECTS FX-C1 ("after MS-C") | EFFECTS orders FX-C1 after MS-C, but MS-C no longer exists and its server half is wave 8 | **FX-C1 (7B) owns both files and the whole mob presentation** [decision]: mob `cast` + `combat {skill, instance}` through the player path, clip from `SkillDef.animation` when the data row exists, else from the fx index v2 MSKILL group's clips; stages, DamageEfp, blood, Trade flights, the bandit arrow; the three `_clon` clip gaps fall back to ATTACK1 (COMBAT §2.1); `combat` with `skill` but no `instance` → `EntityView.attack(target, hits, now, {clip})`; no `skill` → today's cycle. It is tested with synthetic mob messages. Wave 8 **MS-S** owns `apps/game/test/mob-skill-view.test.ts` (a test-only file) as the acceptance check against the real rows. |
| D5 | `packages/convert/src/fx/skills.ts`, `gltf/output.ts` `PRESETS` | COMBAT EXP (MSKILL groups, arrow preset) vs EFFECTS FX-X ("EXP first") | EXP is wave 8; FX-X is 7B | **FX-X owns both in 7B** and builds the MSKILL and SYSTEM groups of fx index v2 itself (EFFECTS §5.1). `PRESETS.fx` lists `res/mob/china/banditarcher_arrow.bsr` once. In wave 8, EXP converts its models by running `pnpm sro convert …` (COMBAT §8 EXP), with no `output.ts` edit. |
| D6 | MSKILL rows in the **data** `skills.json` (`SkillDef.mob`, `aiChance`, `summon`) | COMBAT §2.4 | Needed by the server | Wave 8 **EXP** (`packages/convert/src/data/skills.ts` `buildMobSkills`). The 7B client does not need them (D4 fallback). |
| D7 | Idle override (`EntityView` idle) | EFFECTS §6.1 ("reuse SOC-FC's `setIdle`"), SOCIAL §4.3 ("use FX-0's `EntityView.idle`"), COMBAT §6.5 ("the `setIdle` both add") | **Circular**: each spec says the other builds it; none does | **W7-F builds it** in `world/entities.ts` [decision]: `EntityView.setIdle(kind: IdleKind, transition?: 'play')` with `type IdleKind = 'stand' \| 'combat' \| 'sit' \| 'vendor'`. `stand` = STAND1, `combat` = ATTREADY (family clip), `sit` = SIT_DOWN once → SIT loop, leaving plays STAND_UP; `vendor` = SIT_DOWN once → `VENDOR01` loop when the actor has it, else SIT. It replaces the literal `play('STAND1')` at `entities.ts:465` and `:513` [confirmed]. `KEEP_CLIPS` (`models.ts:51`) adds `VENDOR01` with EFFECTS' list. Priority when several apply (client rule): stall (`vendor`) > posture `sit` > combat stance > `stand`. |
| D8 | Horse view and rider pose | COMBAT §6.5 (`registerEntityKind`, clip-group switch, parent-to-bone "on the same API") | `models.ts:53` `SKIP_PACKS = /^(cart\|avatar)/` **never loads the `cart` pack group** [confirmed], so the rider clips cannot play; no spec noticed | **W8-FC** adds, in one pass: `registerEntityKind(kind, factory)` in `entities.ts`; in `models.ts` `CharacterActor.useClipGroup(group: 'default' \| 'cart'): Promise<void>` (loads a skipped pack on demand; the startup filter stays) and `CharacterActor.attachTo(node: TransformNode \| null)` (parent to a bone, e.g. the horse's `saddle`) [decision]. MR-C uses them from `world/mount-view.ts`. |
| D9 | Chat slash commands (`/dismount`, `/unsummon`, `/sitdown`, emotes, `/trade`, `/stall`, `/guild`, `@`) | COMBAT §1.5 ("no client slash hook; add `WorldFeature.onChatCommand`"), EFFECTS FX-C2 (`/sitdown`), SOCIAL (`/guild`, `@`) | COMBAT's premise is wrong: `ChatBox.registerPrefix(prefix, fn)` exists and runs before the GM path [confirmed `world/chat.ts:245`, used by `features/party.ts:433` and `features/ux-world.ts:149`] | **No `onChatCommand` seam** [decision]. Features call `ctx.chat.registerPrefix(...)`. `matchPrefix` needs a space or end after a word prefix [confirmed `chat.ts:56-66`], so `/no` never catches `/notice`. Prefixes: FX-C2 `/sitdown`, `/hi`, `/laugh`, `/greeting`, `/yes`, `/rush`, `/joy`, `/no`; MR-C `/dismount`, `/unsummon`; TR-C `/trade`, `/exchange`; ST-C `/stall`; GU-C `/guild`, `/g`, `/join`, `@`. None equals a GM command (§3.6). |
| D10 | `busy` | EFFECTS §4 ("not in `ActionFailReason`; the first foundation adds it"), COMBAT §7.4 / SOCIAL §2.2 ("reused") | EFFECTS' claim is wrong | `busy` **exists** [confirmed `protocol.ts:693` in `ACTION_FAIL_REASONS`]. Nobody adds it. |
| D11 | `hud/items.ts` tooltip | UI-W (`TooltipLine.cls` += `'magic' \| 'sep' \| 'price' \| 'warn'`), COMBAT DR (durability line changes) | Two lanes, one function | 7B: **UI-W** adds the classes and the section layout (UI.md §4.8). Wave 8: **DR** owns the durability hunk of `tooltip()` (full stack shows "max / max", ≤ `DUR_WARN_PCT` → `warn`, 0 → `bad` + "(broken)", broken stats struck through) [decision]. |
| D12 | `hud/slots.ts` overlays for broken/low items, `+N` signs | COMBAT §3.4 (`Slot.setOverlay` request to UI-K), UI.md §4.9 (`Slot.setSigns({durability})`) | Two API names for one thing | **One API**: kit `Slot.setSigns({plus?, magic?, rare?, durability?: 'ok' \| 'low' \| 'broken'})` (UI-K) and a registry `registerSlotDecorator(fn: (stack: ItemStack, def: ItemDef \| undefined) => Partial<SlotSigns>): () => void` in `hud/slots.ts` (UI-W), applied on every bag, equipment, storage, shop and hotbar slot render [decision]. `plus` comes from `stack.plus` built in; DR registers the durability decorator in wave 8. `setOverlay` is not built. |
| D13 | Repair buttons | COMBAT §3.4 (`ShopWindow.addFooterButton`, and DR registering `'repair'` in the NPC-service registry), SOCIAL §0 ("COMBAT does not use the registry") | Two routes | Retail puts Repair / Repair all in the shop window [confirmed `ifstore.txt` via UI.md §4.6]. **The shop footer only** [decision]: UI-W builds `ShopWindow.addFooterButton(opts: {id, label, when(services): boolean, onClick})`; DR adds the two buttons when the dialog's `services` include `'repair'`. The server lists `'repair'` in `npcDialog.services` (so `requireService(p, npc, 'repair')` works), but the client dialog shows **no** separate "Repair" option: `dialogOptions()` treats `'repair'` as a hidden service. |
| D14 | NPC-service handlers (`'guild'`) | SOCIAL §9.1 (`registerNpcService`, `OPTION_KEY.guild`, `dialogOptions` order) | Adding `'guild'` to `NpcService` breaks the client typecheck (`OPTION_KEY: Record<NpcService, StringKey>` [confirmed per SOCIAL §6]) | **UI-W (7B)** builds `registerNpcService(service: string, fn)`, makes `OPTION_KEY` a `Partial<Record<string, StringKey>>` pre-filled with `guild: 'npc.option.guild'`, and makes `dialogOptions()` keep services that have a registered handler (after the fixed order) and drop hidden ones (`'repair'`) [decision]. W8-F still runs `pnpm typecheck` and fixes any exhaustive-switch break it finds with the smallest edit. |
| D15 | Target-window actions (Invite, Exchange, Guild invite) | SOCIAL §9.1 (`Hud.addTargetAction`, change `features/party.ts:416/:476`) | `target.setActions` replaces the list, so a second feature wipes Invite [confirmed per SOCIAL] | **UI-H (7B)** builds `Hud.addTargetAction(a: TargetAction): () => void` and `Hud.refreshTargetActions()` (buttons drawn **inside** the 236-px target window, UI.md §6) and converts the two party lines [decision]; `setTargetActions` stays as a deprecated alias for one wave. |
| D16 | Bag-slot lock marks during a trade or stall | SOCIAL §9.1 (`Hud.markBagSlots`) | The inventory refresh wipes direct `set(…, true)` calls [confirmed per SOCIAL] | **UI-W (7B)** builds `Hud.markBagSlots(key: string, slots: ReadonlySet<number>): void` (empty set clears), OR-ed into each bag slot's `blocked` on every render. |
| D17 | Player-frame mount points (Berserk orbs, horse frame) and HUD anchors | COMBAT §5.3 (`PlayerFrame.orbSlot()`), UI.md §6 (`berserkHost`, `petHost`) | Two names | **UI-H (7B)**: `PlayerFrame.berserkHost: HTMLElement` (orbs, button and glows at the `ifplayerminiinfo.txt` rects) and `PlayerFrame.petHost: HTMLElement` at (53,55,154,40), plus `hudAnchors(W,H)` rects `durability` (W−409, 5, 277×32) and `equipState` (W−200, 74, 68×96) [decision; `orbSlot` is not built]. |
| D18 | "Display Guild Name" option | SOCIAL §5.7 (no options API → a guild-window footer checkbox) | Workaround | **UI-W (7B)** builds `registerOptionRow(page: 'graphics' \| 'interface' \| 'controls' \| 'audio', row)` in `hud/options.ts`; GU-C adds the row in Options → Interface [decision]. |
| D19 | Chat kinds `'guild'`, `'stall'`, the guild tab, colours | SOCIAL §9.1 (edits `world/chat.ts`), UI.md §4.4 (tokens) | `chat.ts` is UI-H's in 7B; adding `case 'guild'` before the union has it is a TS error | **UI-H (7B)** makes the channel → kind mapping a string-keyed table pre-filled with `guild → 'guild'`, `stall → 'stall'`, adds `ChatKind` `'guild' \| 'stall'`, a `'guild'` tab hidden until `chat.setTabVisible('guild', true)`, and colours from tokens: `--c-chat-guild: #ffba4d` (retail lamp colour) and `--c-chat-stall: #c6b6ff` [decision; SOCIAL's `#f5c26b` is dropped]. The guild nameplate line uses a new token `--c-guild-name: #8fd18f` (UI-K). |
| D20 | MENU popup rows | UI.md §4.5 (`MenuBar.register` + `MenuBarEntry.icon`), COMBAT §4.7 ("MENU row through `registerMenuItem`") | COMBAT used the wrong registry | MENU popup rows use `hud.menubar.register({… , icon})` (UI-H adds `icon`); `registerMenuItem` feeds only the System (Esc) window [confirmed UI.md §4.5]. Rows: Guild (GU-C), Stall (ST-C), Alchemy (AL), Action (FX-C2). |
| D21 | Cursors | UI.md §4.10 (`setCursor(kind)`), COMBAT §3.4 (hammer) | — | UI-K's `kit/cursor.ts` `setCursor(kind: 'normal' \| 'attack' \| 'talk' \| 'pickup' \| 'repair')`; `'repair'` is included in 7B so DR only calls it. |
| D22 | `i18n` files | COMBAT (one `en-systems-combat.ts` for five lanes), SOCIAL (three files), UI (one `en-ui.ts`) | A shared file breaks the one-owner rule | Per lane [decision]. 7B: UI-K creates `en-ui.ts` (its own), plus empty `en-ui-hud.ts` (UI-H) and `en-ui-windows.ts` (UI-W) and their spread lines; FX-C2 `en-fx.ts` (sit, emotes, Action window). Wave 8: W8-F creates `en-fail-w8.ts` with an `action.fail.<reason>` line for all 22 new reasons (`apps/game/test/hud.test.ts:276` requires a line per reason [confirmed]); W8-FC creates `en-mount.ts` (MR-C), `en-durability.ts` (DR), `en-alchemy.ts` (AL), `en-berserk.ts` (BZ), `en-trade.ts`, `en-stall.ts`, `en-guild.ts`, each with its spread line in `i18n/en.ts`. |
| D23 | `canTrade` exporter line | SOCIAL §8 (request to EXP), COMBAT §8 EXP | Owner | **EXP** adds `if (r.cells[16]?.trim() === '0') def.canTrade = false` in `packages/convert/src/data/items.ts` `buildItemDef` and owns `packages/convert/test/data-cantrade.test.ts` [decision]. |
| D24 | UI art the social windows need | SOCIAL §8 (`ch_red.ddj` request), UI.md §5.4 | — | UI-X widens `interface/exchange` to `/^(exc_\|ch_)/` in 7B, so `ch_red`/`ch_line` are exported with the rest. |
| D25 | "T-pose" in select, create and world | UI.md A15 ("reported to the animation lane") | EFFECTS has no item for it: **unowned** | **FX-C2** reproduces and fixes it in 7B [decision; cause unknown]. If the cause is in `screens/charselect.ts` / `charcreate.ts` (UI-O's files), FX-C2 hands UI-O a one-line fix. |

### 2.2 Wire and data conflicts

| # | Topic | Problem | Decision |
|---|---|---|---|
| D26 | Berserk carrier | COMBAT: `EntityState.berserkMs` + `CombatHit.hwan`; EFFECTS §3.9 (original): an `EffectState` with `SYSTEM_CH_HWANMODE` (already aligned in its fact-check) | `berserkMs`, `CombatHit.hwan`, `PlayerStats.hwan` [decision]. No fake skill row. Visual placement follows the **retail rows** (EFFECTS §3.9: ACT_S on `Bip01`, ACT_L `system_hwan_keep` on `Bip01 Spine` + `system_hwan_keep_s` on six limb bones, DEACT at the root), not COMBAT §5.3's "looped on the root". FX-C2 (7B) ships `SystemFx.play(key: SystemFxKey, phase: 'start' \| 'loop' \| 'end', view): FxHandle` with `SYSTEM_CH_HWANMODE` in the key union; BZ (8) calls it. |
| D27 | Reserved names from docs/WAVE_PLAN.md §2.5 | That plan reserved `EntityState.sitting`, `EntityState.berserk`, `PlayerStats.berserk`/`berserkUntil`, server `berserkUpdate`, reason `not_repairable` | Released and replaced [decision]: `sitting` → `EntityState.posture`; `berserk` field → `berserkMs`; `PlayerStats.berserk*` → `hwan`; `berserkUpdate` → `entityUpdate.berserkMs`; `not_repairable` → reuse `not_usable`. The reserved **message** names `sit` and `berserk` are used as reserved. `questShare` stays reserved. |
| D28 | Stall pose vs posture | SOCIAL: pose from `EntityState.stall`; EFFECTS: `posture` from `sit` | Both kept: `stall` → `setIdle('vendor')`; `posture 'sit'` → `setIdle('sit')` (D7 priority). The social gate refuses `sit` for a stall owner; a stall owner's position is locked anyway. |
| D29 | "Cannot use the stall during battle" | SOCIAL §2.2: `busy`, or `in_combat` if COMBAT lands in the same step | Same step (W8-F) → **`in_combat`**, when `now − p.lastCombatAt < REGEN.outOfCombatMs` (5,000 ms [confirmed `formulas.ts:293`]) [decision]. Horses keep their own 20 s (`COS_COMBAT_LOCK_MS`). |
| D30 | `sit` refusals before `in_combat` exists | EFFECTS P4 lists `dead`, `busy` | 7B: `dead`, `busy` (moving, an action, a skill action, an item cast, or combat within 5 s). W8-F switches the combat case to `in_combat` (one line in `apps/server/src/posture.ts`, listed hook) and the mounts gate refuses `sit` with `mounted`. |
| D31 | `EntityState.owner` on a horse | COMBAT reuses `owner` (today: the item-pickup owner's entity id [confirmed `protocol.ts`]) | Kept [decision]: for `kind: 'cos'`, `owner` = the owning player's entity id; `ownerUntil` is never set on a cos. The doc comment of `owner` is widened. |
| D32 | `chat` `to` + channel rule | SOCIAL §5.3: `validate.ts:317` rejects `to` only with `'party'` [confirmed per SOCIAL] | W8-F changes it to `m.to !== undefined && m.channel !== undefined && m.channel !== 'local'` → `bad_request`. |
| D33 | `PlayerStats.hwan` and the client parser | COMBAT §7.1: `playerStats()` walks `PLAYER_STAT_KEYS` and drops unknown keys; a full `stats` must carry every key | `hwan` goes into `PLAYER_STAT_KEYS` (0..5). W8-F makes `Gameplay.stats(p)` always send it (0 until BZ lands) **and** adds `hwan: 0` to the mock's stats builder in `net/mock.ts`, or the offline client drops `stats`. |
| D34 | Berserk points at enter-world | COMBAT §5.2: "Berserk loads the points in `enter`"; but `sendEnter` sends `stats` **before** the modules' `enter` [confirmed `gameplay.ts:575-578`] | `Berserk.points(p)` reads through a per-character cache filled from the store on first use (the SOCIAL guild-decorator pattern), not from `enter` [decision]; the first `stats` is right. |
| D35 | Enter-world order | SOCIAL §5.4, COMBAT §6.4 | `worldEnter` → `stats` (with `hwan`) → `inventory` → modules' `enter` in registration order: `skills` → `quests` → `party`? → mounts (`spawn {cos}` + `entityUpdate {mount}` pair when a saved horse exists) → `guild`? (§3.2.8). |
| D36 | Emote clip mapping | EFFECTS §3.12 (from the `.ban` names) | Hi = `EMOTION01`, Greeting = `EMOTION02` (pokun), Rush = `03`, Joy = `04`, No = `05`, Yes = `06`, Laugh = `07`; `EMOTION08` unused [likely]. |
| D37 | Keys | Sit N (EFFECTS), guild U (SOCIAL), Berserk Tab (COMBAT) | All free today [confirmed: bound keys are c, f, f8, f9, g, h, home, i, m, p, q/l, s/k, z]. The KeyMap already calls `preventDefault` and skips typing targets [confirmed per COMBAT `hud/keys.ts:112-115`]. |
| D38 | Chat colours | D19 | Tokens only; lanes write no hex. |
| D39 | Trade window size | UI.md (fixed to 365×500 in its fact-check), SOCIAL §1 | **365×500** (`APPLY_EXCHANGE_UPDATE_1TH` + `UI_UPDATE_2009_FIRST`), buttons Confirm (96,450) / Cancel (193,450) [confirmed in both verified specs]. The two character views stay empty name plates in the first build. |
| D40 | Alchemy slots | COMBAT §4.7: 3 slots; retail reinforce panel: 1 + 4 | Equipment → the equipment slot; Elixir → slot x 164; Lucky Powder → slot x 212; slots 260 / 308 hidden (UI.md §4.6) [decision]. |
| D41 | Rate limits of the new requests | COMBAT: 2/s burst 5 each; SOCIAL §2.6; EFFECTS P4 | As the specs; merged table §3.5. |
| D42 | GM command names | COMBAT: `horse`, `hwan`, `dur`, `plus`, `mobskill`; SOCIAL: `guilds` (not `guild`) | All new; none collides with the 18 commands (`help who where tp summon kick notice setlevel speed invis heal spawn item skill nest npc content kill`) [confirmed `gm.ts:148-399`] or with a client prefix (D9). |

### 2.3 Items touched by several systems (inventory, durability, alchemy, trade, stall, storage, horses)

The rule that holds everything together: **the server is single-threaded and every item change is one synchronous SQLite transaction** (`store.inventoryTx`, SOCIAL's `pairTx`) [confirmed per SOCIAL §2.4]. On top of that, three locks give clean refusals instead of late failures:

1. **Social gate (SOCIAL §2.3)**, an allowlist while a trade window is open or a stall exists.
2. **Mount gate** (new, D43).
3. **Alchemy soft lock** (new, D44).

| # | Interaction | Decision |
|---|---|---|
| D43 | **Mounts gate.** COMBAT refuses some requests "while mounted" from inside other modules, and requests from 7B/SOCIAL (`sit`, `emote`, `stallCreate`) cannot know about horses | The mounts module implements the W8 `gate` hook: while mounted it refuses `sit`, `emote`, `stallCreate`, `alchemyReinforce`, `berserk` with `mounted` [decision]. `attack` / `useSkill` keep COMBAT's seam checks (`attackRequest`, `plan`, `tickAction`). `tradeRequest` / `tradeRespond` while mounted are **allowed** (no position change; a trade cancels on any move anyway). |
| D44 | **Alchemy soft lock.** COMBAT §4.4 says no lock is needed because the finish re-validates; true for safety, but a trade or stall opened mid-fuse fails late | While a fuse is pending, the alchemy module's `gate` refuses `tradeRequest`, `tradeRespond` (the gate sees only the type, not `accept`; a pending invite simply expires after 30 s), `stallCreate`, `itemMove`, `itemSplit`, `itemEquip`, `itemUnequip`, `itemDrop`, `shopSell`, `storageDeposit`, `repair` with `busy` [decision]; the horse modules refuse a summon or `mountRide` with `busy` while a fuse is pending (D43 holds in both orders; W8-fix). The finish-time re-check (code + plus) stays. Moves, attacks, skills and NPC talk still **cancel** the fuse (COMBAT §4.4), they are not refused. |
| D45 | Alchemy while trading or stalling | `alchemyReinforce` / `alchemyCancel` are outside the social allowlist → `trading` / `stalling` [confirmed SOCIAL §2.3]. |
| D46 | Repair while trading or stalling | `repair` is outside the allowlist → refused. So an offered or listed item cannot change durability. Worn items wear in combat, but a trade cancels on `attack`/`useSkill` and a stall owner cannot attack, and only **equipped** items wear (COMBAT §3.2), while trades and stalls move **bag** items. |
| D47 | Durability and `+N` in trades, stalls and storage | `ItemStack.durability` and `plus` travel with the stack [confirmed per COMBAT §6.2 and SOCIAL §4.4]. The trade commit snapshot and the stall `Listing` snapshot compare `code`, `count`, `plus` and `durability`. Broken items (0) may be traded, listed and stored; the tooltip shows "(broken)" (D11). Storage and buyback keep durability (DR regression test). |
| D48 | Broken items and alchemy / equip | `alchemyReinforce` on a broken item → `broken`; `itemEquip` of a broken item → `broken` (in `inventory.ts equipItem`); a broken worn item gives no stats and no `perPlus` (COMBAT §3.2, §4.2). |
| D49 | Horse items | `ITEM_COS_C_HORSE1` and the Recovery Kits are ordinary bag items (`canTrade` 1 [likely; they are not `_DEF` rows]); they can be traded, listed and stored. The `cos` entity itself is never an item and never tradable. Summon or ride while berserk → `berserk_active` [decision: avoids stacking ×1.8 and ×2 speed]; Berserk while mounted → `mounted` (COMBAT). A stall cannot be opened while mounted (D43). |
| D50 | `canTrade` | `def?.canTrade === false` refuses `tradeOffer` and `stallItem` with `not_usable`; a missing def refuses too. In practice only the 25 `*_DEF` starter items are affected [confirmed SOCIAL §1]. |
| D51 | Elixir drops and `dropFrom` share one loop | FX-S (7B) edits `mobDied`'s `spawnGroundItem` call for `dropFrom`; W8-F adds `drops.push(...this.alchemy.extraDrops(m))` just above it. 7B lands first; W8-F rebases. Authored elixirs get `droppedAt`/`dropFrom` like any drop. |
| D52 | `item-use.ts` | FX-S (7B) adds the P3 `itemEffect` broadcast after a successful potion/pill/vigor use; W8-F adds the mounts dispatch line (`use.summon \|\| use.target === 'mount'`) before the return-scroll branch. A Recovery Kit sends `itemEffect` with the horse's id (`SYSTEM_COS_HPPOTION` visual, EFFECTS §3.16) [decision]. |

### 2.4 Numbers and config (consolidated)

All knobs are optional `ServerConfig` fields read with an env name, the `goldRate` pattern [confirmed `config.ts:213`]. Wave 7B adds none.

| Env | Field | Default | Range | Spec |
|---|---|---|---|---|
| `COS_COMBAT_LOCK_MS` | `cosCombatLockMs` | 20000 | 0..600000 | COMBAT §1.3 |
| `COS_PARK_RANGE_M` | `cosParkRangeM` | 60 | 5..500 | COMBAT §1.3 |
| `MOB_SKILL_DAMAGE` | `mobSkillDamage` | `relative` | relative / retail / flat | COMBAT §2.6 |
| `MOB_DAMAGE_RATE` | `mobDamageRate` | 1 | 0..10 | COMBAT §2.6 |
| `MOB_SUMMONS` / `MOB_SUMMON_CAP` | `mobSummons` / `mobSummonCap` | 0 / 6 | 0..1 / 0..30 | COMBAT §2.2 |
| `DUR_WEAPON_LOSS_PCT` / `DUR_ARMOR_LOSS_PCT` / `DUR_SHIELD_LOSS_PCT` | `dur*LossPct` | 5 / 5 / 10 | 0..100 | COMBAT §3.2 |
| `DUR_WARN_PCT` | `durWarnPct` | 10 | 0..100 | COMBAT §3.2 |
| `ALCHEMY_RATE` | `alchemyRate` | 1.5 | 0..10 (chance clamped to 100) | COMBAT §4.3 |
| `ALCHEMY_MAX_PLUS` | `alchemyMaxPlus` | 10 | 1..12 | COMBAT §4.3 |
| `ALCHEMY_FUSE_MS` | `alchemyFuseMs` | 3000 | 0..30000 | COMBAT §4.4 |
| `ALCHEMY_DESTROY` | `alchemyDestroy` | 0 | 0..1 | COMBAT §4.3 |
| `ALCHEMY_ANNOUNCE_FROM` | `alchemyAnnounceFrom` | 7 | 0..12 (0 = off) | COMBAT §4.4 |
| `ELIXIR_DROP_PCT` / `ELIXIR_DROP_MIN_LEVEL` | `elixirDropPct` / `elixirDropMinLevel` | 0.8 / 5 | 0..100 / 1..120 | COMBAT §4.5 |
| `HWAN_KILL_PCT` | `hwanKillPct` | 12 | 0..100 | COMBAT §5.2 |
| `HWAN_DURATION_MS` | `hwanDurationMs` | 60000 | 1000..600000 | COMBAT §5.2 |
| `GUILD_CREATE_LEVEL` | `guildCreateLevel` | 10 | 1..300 | SOCIAL §10.2 |
| `GUILD_CREATE_GOLD` | `guildCreateGold` | 10000 | 0..MAX_GOLD | SOCIAL §10.2 |
| `GUILD_MAX_MEMBERS` | `guildMaxMembers` | 50 | 2..100 | SOCIAL §10.2 |
| `GUILD_REJOIN_HOURS` / `GUILD_RECREATE_DAYS` | `guildRejoinHours` / `guildRecreateDays` | 0 / 0 | 0..720 / 0..60 | SOCIAL §10.2 |
| `STALL_TOWN_ONLY` | `stallTownOnly` | 1 | 0..1 | SOCIAL §10.2 |

Balance note: `MOB_SKILL_DAMAGE=relative` keeps today's damage per primary swing, so the eased level-8 Qin-Shi Tomb (wave 7A) stays eased; I8 re-runs the docs/BALANCE.md model (COMBAT §2.6).

### 2.5 Server module registration order (wave 8)

`this.modules` in the `Gameplay` constructor [confirmed today: `[skills, npcs, shops, storage, itemUses, quests, party]`, `gameplay.ts:242`] becomes:

```
[skills, npcs, shops, storage, itemUses, quests, party,
 posture,                                   // 7B, FX-S
 mobSkills, mounts, durability, repairs, alchemy, berserk,   // 8, W8-F
 trade, stalls, guilds]                     // 8, W8-F
```

- `gate` is asked in this order; the first `Fail` wins (SOCIAL §2.3). A module is never asked about its own `handles`. A throwing `gate` is logged and **allows**.
- `enter` runs in this order (D35).

### 2.6 Migrations

| Version | Wave | Contents | Landed by |
|---|---|---|---|
| v8 | 8 | combat and items: `characters.hwan_points` (0..5), table `char_mount` (COMBAT §6.2, verbatim) | W8-F |
| v9 | 8 | social: `guilds`, `guild_members`, `characters.guild_left_at`, `characters.guild_disbanded_at`, `social_log` and their indexes (SOCIAL §7, verbatim) | W8-F |

- Both are inline in `db.ts` `MIGRATIONS` (the migration-7 pattern; statements live in `social/guild-store.ts` and in the mounts/berserk modules) [confirmed per SOCIAL §7].
- `apps/server/test/modules-w4.test.ts:158` changes `toBe(7)` to `toBe(9)` in the same commit.
- Wave 7B adds no migration. Posture, stalls and trades are runtime only. No lane other than W8-F appends a migration.

---

## 3. Unified protocol additions

All of it is **additive v1**: `PROTOCOL_VERSION` stays 1. New client frames have strict key sets; every new `GameplayRequest` gets exactly one `actionResult`, a `GAMEPLAY_REQUESTS` entry and a `CLIENT_RATE_LIMITS` row; server → client parsers drop unknown keys; new enum values (`EntityKind 'cos'`, chat channels, reasons) make an older client drop the frame, so server and client deploy together, as in every wave.

### 3.1 Wave 7B (landed by W7-F)

```ts
// ================= packages/shared/src/protocol.ts — WAVE 7B (docs/EFFECTS.md §4) =================

export type EmoteKind = 'hi' | 'laugh' | 'greeting' | 'yes' | 'rush' | 'joy' | 'no'
export const EMOTE_KINDS: readonly EmoteKind[] = ['hi', 'laugh', 'greeting', 'yes', 'rush', 'joy', 'no']
export type Posture = 'sit' | 'stand'

export interface EntityState {
  /* existing fields */
  // ---- wave 7B additions (docs/WAVE_PLAN2.md §3.1) ----
  /** Items: server ms the item reached the ground (fresh drops play the toss; docs/EFFECTS.md §3.6). */
  droppedAt?: number
  /** Items: where it was thrown from (the corpse point); absent for player drops. */
  dropFrom?: Vec3
  /** Players: 'sit' while sitting; absent = standing. */
  posture?: 'sit'
}

// ClientMessage (both are GameplayRequests: one actionResult each)
  | { t: 'sit'; on: boolean }
  | { t: 'emote'; emote: EmoteKind }

// ServerMessage
  /** A consumable's visual for viewers of `id` (the user included), after a successful potion, herb, pill,
   *  vigor or (wave 8) horse Recovery Kit use. `id` is the entity the effect plays on. Not sent for return scrolls. */
  | { t: 'itemEffect'; id: number; item: string }
  /** An emote of `id`, to its viewers (the sender included). */
  | { t: 'emote'; id: number; emote: EmoteKind }
// entityUpdate gains: posture?: Posture   ('stand' = cleared)

// GameplayRequest += 'sit' | 'emote'   (GAMEPLAY_REQUESTS too)
// CLIENT_RATE_LIMITS: sit { perSecond: 2, burst: 4 }, emote { perSecond: 1, burst: 3 }
```

- **Refusals.** `sit`: `dead`, `busy` (moving, an action, a skill action, an item cast, combat within 5 s). `emote`: `dead`, `busy` (moving, a skill action, an item cast). `sit {on:false}` while standing is `ok` (idempotent).
- **Standing up.** `moveTo`, `attack`, `useSkill`, `pickup`, `npcTalk` and damage taken stand the player up: `entityUpdate {id, posture: 'stand'}` to viewers. Nothing regenerates faster while sitting (no rule today).
- **Emote while sitting** stands the player up first [decision].
- **Server `emote`** reuses the client `t`, as `chat` does. `itemEffect.item` is a CodeName128 (`ITEM_*`); the client maps it through `ItemDef` (EFFECTS §4 "Client mapping").
- **Validator** (`validate.ts`): the two client frames; `itemEffect`, `emote`; `EntityState.droppedAt` (int ≥ 0), `dropFrom` (Vec3), `posture` (`'sit'` only); `entityUpdate.posture` (`'sit' | 'stand'`).
- **Collisions:** `sit`, `emote`, `itemEffect`, `posture`, `droppedAt`, `dropFrom`, `EmoteKind`, `Posture` are unused in `protocol.ts` [confirmed per EFFECTS §4 fact-check] and in the wave-8 list below.

No other wave-7B change touches the wire. The UI rework is client-only; its contracts are client settings and art-manifest fields (§3.7).

### 3.2 Wave 8 (landed by W8-F)

#### 3.2.1 Constants and types

```ts
// ================= packages/shared/src/protocol.ts — WAVE 8 =================

// ---- combat and items (docs/SYSTEMS_COMBAT.md §7) ----
export type EntityKind = 'player' | 'mob' | 'npc' | 'item' | 'cos'

/** A repair target: one equipment slot or one bag index. */
export type RepairRef = { equip: EquipSlot } | { bag: number }
export type AlchemyOutcome = 'success' | 'fail' | 'cancelled'
export const HWAN_MAX = 5

// ---- social (docs/SYSTEMS_SOCIAL.md §2.1) ----
export const TRADE_SLOTS = 12
export const TRADE_RANGE = 10
export const TRADE_BREAK_RANGE = 15
export const TRADE_REQUEST_MS = 30_000
export const STALL_SLOTS = 10
export const STALL_VISITORS_MAX = 8
export const STALL_RANGE = 10
export const STALL_BREAK_RANGE = 15
export const STALL_PRICE_MAX = 1_000_000_000
export const STALL_TITLE_MAX = 32
export const STALL_GREETING_MAX = 80
export const STALL_NPC_CLEARANCE = 3
export const STALL_SPACING = 1.5
export const GUILD_NAME = /^[A-Za-z][A-Za-z0-9]{1,11}$/
export const GUILD_TITLE_MAX = 12
export const GUILD_NOTICE_TITLE_MAX = 32
export const GUILD_NOTICE_MAX = 240
export const GUILD_INVITE_MS = 30_000
export const GUILD_MEMBERS_MAX = 100
export const GUILD_MANAGER_NPCS: readonly string[] = ['NPC_CH_GENARAL_SP']

export type GuildRank = 'master' | 'member'
export const GUILD_RANKS: readonly GuildRank[] = ['master', 'member']
export type GuildPerm = 'invite' | 'kick' | 'notice' | 'title'
export const GUILD_PERMS: readonly GuildPerm[] = ['invite', 'kick', 'notice', 'title']

export interface TradeItem { stack: ItemStack; bag?: number }          // `bag` only on your own side
export interface TradeSide { items: (TradeItem | null)[]; gold: number; locked: boolean; accepted: boolean } // length TRADE_SLOTS
export interface TradeState { partner: number; name: string; level: number; mine: TradeSide; theirs: TradeSide }
export type TradeEndReason = 'done' | 'cancelled' | 'declined' | 'expired' | 'moved' | 'too_far' | 'dead' | 'left' | 'failed'

export interface StallListing { stack: ItemStack; price: number; bag?: number }   // `bag` only in the owner's view
export interface StallView {
  owner: number; name: string; title: string; greeting: string
  state: 'modify' | 'open'
  items: (StallListing | null)[]                  // length STALL_SLOTS
  visitors: number                                // 0..STALL_VISITORS_MAX
}
export type StallEndReason = 'closed' | 'left' | 'too_far'

export interface GuildMember {
  characterId: number; name: string; model: string; level: number
  rank: GuildRank; perms: GuildPerm[]; title: string
  online: boolean; lastSeen: number; joinedAt: number
}
export interface GuildState {
  id: number; name: string; master: number; createdAt: number
  notice: { title: string; text: string; at: number }
  maxMembers: number
  members: GuildMember[]                          // 1..GUILD_MEMBERS_MAX
}
export type GuildEventKind = 'created' | 'joined' | 'left' | 'kicked' | 'master' | 'disbanded' | 'declined' | 'expired'
  | 'online' | 'offline' | 'notice' | 'perms' | 'title'
```

#### 3.2.2 Existing types extended

```ts
export interface EntityState {
  /* existing + wave 7B fields */
  // ---- wave 8 additions (docs/WAVE_PLAN2.md §3.2) ----
  /** Players: entity id of the horse being ridden; absent = on foot. */
  mount?: number
  /** Cos: entity id of its rider; absent = parked. For kind 'cos', `owner` = the owning player's entity id and
   *  `hp`/`maxHp` = the horse's HP (D31). */
  rider?: number
  /** Players: Berserk time left at send time (ms, 1..600000); absent = not berserk. */
  berserkMs?: number
  /** Players: the stall title (0..STALL_TITLE_MAX code points); present = a stall exists. */
  stall?: string
  /** Players: the guild name (2..12); absent = none. */
  guild?: string
}
// entityUpdate gains: mount?: number | null, rider?: number | null, berserkMs?: number (0 = ended),
//                     stall?: string ('' = closed), guild?: string ('' = none)

export interface CombatHit { /* existing */ hwan?: true }      // the attacker was in Berserk
export interface PlayerStats { /* existing */ hwan?: number }  // 0..5; in PLAYER_STAT_KEYS (D33)

export interface WorldInfo {
  /* existing: name, serverTime, tickRate, levelCap? */
  alchemyRate?: number                                 // ALCHEMY_RATE, for the success preview
  alchemyMaxPlus?: number                              // 1..12
  social?: { guildCreateGold: number; guildCreateLevel: number }
}

export type NpcService = 'shop' | 'storage' | 'repair' | 'quest' | 'guild'     // NPC_SERVICES too
export type ChatChannel = 'local' | 'system' | 'whisper' | 'party' | 'guild' | 'stall'
export type ChatSendChannel = 'local' | 'party' | 'guild' | 'stall'            // CHAT_SEND_CHANNELS too
```

#### 3.2.3 Client → server (34 new `GameplayRequest`s)

```ts
// combat and items (docs/SYSTEMS_COMBAT.md §7.2)
  | { t: 'mountRide'; cos: number }
  | { t: 'mountDismount' }
  | { t: 'mountDismiss' }
  | { t: 'repair'; npc: number; items?: RepairRef[] }                  // 1..16 refs; absent = repair all
  | { t: 'alchemyReinforce'; item: number; elixir: number; powder?: number }   // bag indexes, all distinct
  | { t: 'alchemyCancel' }
  | { t: 'berserk' }
// trade (docs/SYSTEMS_SOCIAL.md §3.4)
  | { t: 'tradeRequest'; target: number }
  | { t: 'tradeRespond'; from: number; accept: boolean }
  | { t: 'tradeOffer'; bag: number; count?: number }
  | { t: 'tradeTake'; slot: number }                                   // 0..TRADE_SLOTS-1
  | { t: 'tradeGold'; amount: number }                                 // 0..MAX_GOLD, the new amount
  | { t: 'tradeLock' }
  | { t: 'tradeAccept' }
  | { t: 'tradeCancel' }
// stall (§4.2)
  | { t: 'stallCreate'; title: string }
  | { t: 'stallItem'; slot: number; bag: number; count: number; price: number }
  | { t: 'stallItemRemove'; slot: number }
  | { t: 'stallText'; title?: string; greeting?: string }             // at least one key
  | { t: 'stallOpen'; open: boolean }
  | { t: 'stallClose' }
  | { t: 'stallVisit'; owner: number }
  | { t: 'stallLeave' }
  | { t: 'stallBuy'; owner: number; slot: number; code: string; count: number; price: number }
// guild (§5.4)
  | { t: 'guildCreate'; npc: number; name: string }
  | { t: 'guildDisband'; npc: number }
  | { t: 'guildInvite'; name: string }
  | { t: 'guildRespond'; guild: number; accept: boolean }
  | { t: 'guildLeave' }
  | { t: 'guildKick'; member: number }
  | { t: 'guildPerms'; member: number; perms: GuildPerm[] }
  | { t: 'guildTitle'; member: number; title: string }
  | { t: 'guildNotice'; title: string; text: string }
  | { t: 'guildMaster'; member: number }
// chat: channel may be 'guild' | 'stall'; `to` with any channel other than 'local' → error bad_request (D32)
```

Bounds are the specs' (COMBAT §7.2, SOCIAL §6): ints `cos`, `npc`, `target`, `from`, `owner` 0..MAX_ID; `bag`, `item`, `elixir`, `powder` bag indexes; `count` 1..MAX_ITEM_COUNT; `price` 1..STALL_PRICE_MAX; `member`, `guild` 1..MAX_SAFE_INTEGER; strings bounded in code points; `perms` unique; `stallBuy.code` CodeName128; `RepairRef` strict `{equip}` xor `{bag}`.

#### 3.2.4 Server → client

```ts
  | { t: 'alchemyStart'; item: number; readyInMs: number }             // 0..30000
  | { t: 'alchemyResult'; item: number; code: string; outcome: AlchemyOutcome; plus: number }   // plus 0..255
  | { t: 'tradeRequested'; from: number; name: string; level: number; expiresInMs: number }
  | { t: 'trade'; trade: TradeState }
  | { t: 'tradeEnd'; reason: TradeEndReason; name?: string; message?: string }
  | { t: 'stall'; stall: StallView | null; reason?: StallEndReason }
  | { t: 'stallSold'; slot: number; buyer: string; code: string; count: number; price: number }
  | { t: 'guildInvited'; guild: number; name: string; from: string; expiresInMs: number }
  | { t: 'guild'; guild: GuildState | null }
  | { t: 'guildMember'; member: GuildMember }
  | { t: 'guildMemberRemoved'; characterId: number }
  | { t: 'guildEvent'; event: GuildEventKind; name: string }
// extended use: cast / castEnd / combat may come from a mob id (mob skills send skill, instance, at, aoe);
// combat hits may carry hwan; stats / statsDelta carry hwan; chat may carry channel 'guild' | 'stall'
```

#### 3.2.5 New `ActionFailReason` values (22)

| Combat and items (COMBAT §7.4) | Social (SOCIAL §2.2) |
|---|---|
| `mounted`, `not_mounted`, `moving`, `in_combat`, `cos_active`, `broken`, `nothing_to_repair`, `alchemy_mismatch`, `max_plus`, `berserk_not_ready`, `berserk_active` | `trading`, `stalling`, `stall_changed`, `stall_full`, `stall_closed`, `not_in_guild`, `in_guild`, `no_permission`, `guild_full`, `name_taken`, `bad_name` |

- All go into `ACTION_FAIL_REASONS` and into `apps/game/src/i18n/en-fail-w8.ts` (D22) in the W8-F commit.
- `name_taken` also exists as an `ErrorCode` (charCreate); the two unions are separate [confirmed per SOCIAL §2.2].
- Reused: `not_found`, `too_far`, `dead`, `busy`, `invalid_target`, `invalid_slot`, `invalid_count`, `not_usable`, `not_enough_gold`, `gold_limit`, `inventory_full`, `requirements`, `cooldown`, `no_invite`, `not_complete`, `wrong_place`, `rate_limited`.

#### 3.2.6 `whileDead` additions

`mountDismiss`, `alchemyCancel`, `tradeCancel`, `tradeRespond` (a decline; an accept answers `dead`), `stallClose`, `stallLeave`, `guildRespond`, `guildLeave`, `guildKick`, `guildPerms`, `guildTitle`, `guildNotice`, `guildMaster`.

#### 3.2.7 Message order (each request's `actionResult` first)

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
| trade accept / change | `actionResult` → `trade` to both |
| final trade accept | `actionResult` → each side's `inventoryUpdate`, `statsDelta` → `tradeEnd done` (both) |
| `stallBuy` | buyer: `actionResult` → `inventoryUpdate` → `statsDelta {gold}`; owner: `inventoryUpdate` → `statsDelta {gold}` → `stallSold` → system line; all: `stall` |
| `sit` (7B) | `actionResult` → `entityUpdate {posture}` to viewers |
| `emote` (7B) | `actionResult` → `emote` to viewers |

#### 3.2.8 Enter-world order

`worldEnter` (self carries `stall`/`guild` from decorators; `posture` absent; `mount` absent) → `stats` (with `hwan`) → `inventory` → `skills` → `quests` → `party` (if in one) → horse (`spawn {cos}` + `entityUpdate` pair, if a saved horse exists) → `guild` (if in one). Tested in I8 (flow 1).

### 3.3 Content additions (not wire; `packages/shared/src/content.ts`)

| Wave | Addition | From |
|---|---|---|
| 8 | `ItemCategory` += `'alchemy'` | COMBAT §6.3 |
| 8 | `ItemUse.summon?: string`, `ItemUse.target?: 'mount'` | COMBAT §6.3 |
| 8 | `ItemDef.perPlus?`, `ItemDef.reinforce?: {kind, targets?, degree?, rates}` (powder degree from Param1, never `ItemDef.degree`) | COMBAT §6.3, §4.1 |
| 8 | `ItemDef.canTrade?: boolean` (absent = allowed) | SOCIAL §8 |
| 8 | `CosDef`, `CONTENT_FILES.cos = 'cos.json'` | COMBAT §6.3 |
| 8 | `SkillDef.mob?: true`, `aiChance?`, `summon?` | COMBAT §2.4 |
| 8 | `MobDef.attacks?` (type only; already exported) | COMBAT §2.4 |
| 8 | `NpcDef.roles` may hold `'repair'` (Smith, Armor) | COMBAT §3.3 |
| 7B | `work/out/fx/skills.json` v2 (`version: 2`, additive: v1 readers keep working), model sidecars `particles?` / `dummies?` | EFFECTS §5.1-§5.2 |
| 7B | `work/out/ui/index.json`: `UiImage.nine?`, `UiManifest.englishText?`, atlas crops as `derived` images | UI.md §5.4 |

### 3.4 Collision check [confirmed against `protocol.ts` at `f5fa4c2` and the four specs]

| New name | Namespace | Clashes with | Verdict |
|---|---|---|---|
| `emote` | client and server `t` | — (same name both ways, like `chat`) | ok |
| `sit`, `berserk` | client `t` | docs/WAVE_PLAN.md §2.5 reservation | used as reserved |
| `repair` | client `t` | `NpcService 'repair'` (a value, other namespace) | ok |
| `stall`, `guild`, `trade` | server `t` | `EntityState.stall`/`guild` fields (other namespace) | ok |
| `name_taken` | `ActionFailReason` | `ErrorCode 'name_taken'` (separate union) | ok |
| `owner` on a cos | existing field | item pickup owner | reused with the same meaning "a player's entity id" (D31) |
| `mount`, `rider`, `berserkMs`, `posture`, `droppedAt`, `dropFrom`, `hwan` | fields | — | ok |
| `in_combat`, `busy` | reasons | `busy` exists | `busy` not re-added (D10) |
| every wave-8 request and reason | — | each other (COMBAT §7.2 and SOCIAL §6 cross-checked) | ok |

### 3.5 Rate limits (`CLIENT_RATE_LIMITS`, per second / burst)

| Types | Budget |
|---|---|
| `sit` | 2 / 4 |
| `emote` | 1 / 3 |
| `mountRide`, `mountDismount`, `mountDismiss`, `repair`, `alchemyReinforce`, `alchemyCancel`, `berserk` | 2 / 5 |
| `tradeRequest`, `stallCreate`, `stallClose`, `guildCreate`, `guildDisband`, `guildInvite`, `guildLeave`, `guildNotice`, `guildMaster` | 1 / 3 |
| `tradeRespond`, `tradeLock`, `tradeAccept`, `tradeCancel`, `stallText`, `stallOpen`, `stallVisit`, `stallLeave`, `guildRespond`, `guildKick`, `guildPerms`, `guildTitle` | 2 / 5 |
| `tradeGold`, `stallBuy` | 5 / 10 |
| `tradeOffer`, `tradeTake`, `stallItem`, `stallItemRemove` | 10 / 20 |

Guild and stall chat pay the existing chat bucket (`conn.takeChat()`).

### 3.6 Chat prefixes and GM commands

| Line typed | Handled by | Sends |
|---|---|---|
| `/sitdown` | FX-C2 | `sit {on: !sitting}` |
| `/hi` `/laugh` `/greeting` `/yes` `/rush` `/joy` `/no` | FX-C2 | `emote` |
| `/dismount`, `/unsummon` | MR-C | `mountDismount`, `mountDismiss` |
| `/trade`, `/exchange` | TR-C | `tradeRequest {target}` (the current player target) |
| `/stall` | ST-C | opens the stall setup |
| `/guild <name>`, `/g <text>`, `/join`, `@<text>` | GU-C | `guildInvite`, guild chat, accept the pending invite, guild chat |
| `/horse`, `/hwan`, `/dur`, `/plus`, `/mobskill`, `/guilds` | server GM path (staff only, audited) | — |

A client prefix always wins over the GM path [confirmed `chat.ts` "before the default path"], so no GM command may share a client prefix: none does (D42).

### 3.7 Client-only contracts (wave 7B)

- Setting `ui.scaleMode: 'auto' | 1 | 1.25 | 1.5 | 2 | 2.5 | 3` (localStorage `sro.settings`; the old `ui.scale` stays in the type, unused) (UI.md §4.1).
- Art manifest: `UiImage.nine`, `UiManifest.englishText`, the `window_all` atlas crops (UI.md §5.4).
- `TooltipLine.cls` += `'magic' | 'sep' | 'price' | 'warn'` (UI.md §4.8).
- Kept APIs (tests stay green): `registerMenuItem`, `MenuBar.register` (+ `icon`), `KeyMap`, `HudWindow` (a kit `Window` subclass), `SlotView` (kit `Slot`), `hud.openInventory` / `toggleInventory` / `toggleCharacter` (mapped to Main-window tabs), `hud.routeBagAction`, `hud.claimRequests`, `hud.layer`.

---

## 4. Seams

### 4.1 Wave-8 mount points built in wave 7B

Each is built by the named 7B lane as part of its migration, exported from the file it owns, and covered by a unit test in that lane. Wave-8 lanes only call them.

| # | API | File | 7B lane | Wave-8 user | Test |
|---|---|---|---|---|---|
| M1 | `PlayerFrame.berserkHost`, `PlayerFrame.petHost` (53,55,154,40) | `hud/player.ts` | UI-H | BZ, MR-C | `ui-layout.test.ts`: host rects |
| M2 | `hudAnchors(W,H).durability`, `.equipState` | `hud/hud-layout.ts` | UI-H | DR | `ui-layout.test.ts` |
| M3 | `Hud.addTargetAction(a): () => void`, `Hud.refreshTargetActions()`; party converted | `hud/index.ts`, `hud/target.ts`, `world/features/party.ts` (2 lines) | UI-H | TR-C, GU-C | `ui-layout.test.ts` or `party.test.ts`: two actions coexist |
| M4 | Chat channel → kind table with `guild`, `stall`; `ChatKind` += `'guild' \| 'stall'`; hidden `'guild'` tab + `setTabVisible`; token colours | `world/chat.ts` | UI-H | GU-C, ST-C | `ux-world.test.ts` extension |
| M5 | `MenuBarEntry.icon?: string` | `hud/menubar.ts` | UI-H | GU-C, ST-C, AL, FX-C2 | `hud.test.ts` |
| M6 | `ShopWindow.addFooterButton({id, label, when(services), onClick}): () => void` | `hud/shop.ts` | UI-W | DR | `shop.test.ts` (model-level) |
| M7 | `registerNpcService(service, fn)`; tolerant `OPTION_KEY` (pre-filled `guild`); `dialogOptions()` keeps registered services, hides `'repair'` | `hud/npc-dialog.ts`, `hud/shop-logic.ts` | UI-W | GU-C | `shop.test.ts`: `dialogOptions(['shop','repair','guild'])` with a `guild` handler → shop, guild |
| M8 | `Hud.markBagSlots(key, slots)` | `hud/index.ts`, `hud/inventory.ts` | UI-W | TR-C, ST-C | survives an inventory refresh (DOM-free model) |
| M9 | `registerSlotDecorator(fn)` + kit `Slot.setSigns({plus, magic, rare, durability})` | `hud/slots.ts`, `ui/kit/slot.ts` | UI-W, UI-K | DR | `ui-kit.test.ts` |
| M10 | `registerOptionRow(page, row)` | `hud/options.ts` | UI-W | GU-C | `ux-shell.test.ts` extension |
| M11 | `TooltipLine.cls` additions | `hud/items.ts` | UI-W | DR, AL | `tooltip-model.test.ts` |
| M12 | `setCursor(kind)` incl. `'repair'` | `ui/kit/cursor.ts` | UI-K | DR | `ui-kit.test.ts` |
| M13 | `MessageBox.confirm/count/prompt` | `ui/kit/dialog.ts` | UI-K | all wave-8 windows | `ui-kit.test.ts` (logic) |
| M14 | `EntityView.setIdle(kind)` incl. `'vendor'`; `KEEP_CLIPS` += `VENDOR01` | `world/entities.ts`, `three/models.ts` | W7-F | ST-C | `seams-fx.test.ts` |
| M15 | `SystemFx.play(key, phase, view)` incl. `SYSTEM_CH_HWANMODE`, `SYSTEM_PET_APPEAR`, `SYSTEM_COS_HPPOTION` | `world/fx/system-fx.ts` | FX-C2 | BZ, MR-C | `system-fx.test.ts` |
| M16 | kit `Window`, `Section`, `Button`, `TabBar`, `Gauge`, `Slot`, `List`, `TextInput`, `NumberInput` | `ui/kit/**` | UI-K | all wave-8 windows | `ui-kit.test.ts` |

### 4.2 Wave-8 server seams (W8-F)

COMBAT §6.4 and SOCIAL §10.2 verbatim, merged. The ones that decide ownership:

| Seam | Where | What |
|---|---|---|
| `gate?(p, t, now): Fail \| null` | `modules.ts` `GameplayModule`; `gameplay.ts` `gateFor()` called in `request()` right after the dead check and in `onMoveTo()` after `if (p.dead) return false` [confirmed `gameplay.ts:591-593`] | SOCIAL §2.3; a throwing gate is logged and allows |
| Modules | `gameplay.ts` constructor | the §2.5 list; stub modules answer `not_implemented` |
| Mob swing, mob busy, `AiHost.ranged?` call | `gameplay.ts` `swing` / `tick`; `ai.ts` chase branch | COMBAT §6.4 (MS-S owns the `ranged` body in `ai.ts`) |
| Hit redirect, `extra.dot`, wear | `gameplay.ts dealHits`; `skills/engine.ts tickEffect` | COMBAT §6.4 |
| Worn stats (`perPlus × plus`, broken skipped) | `formulas.ts playerCombatStats` | COMBAT §6.4 |
| `addModProvider`; public `applyStatus` / `rollStatuses`; mount speed `ModStat` | `skills/engine.ts`, `skills/mods.ts` | COMBAT §6.4 |
| Refusals `mounted` / `broken` | `attackRequest`, `tickAction` (before `this.attack(p, t, now)`), `SkillEngine.plan` | COMBAT §6.4 |
| Item-use dispatch | `item-use.ts` after the cooldown check (D52) | COMBAT §6.4 |
| Equip check | `inventory.ts equipItem` | COMBAT §6.4 |
| NPC services | `npc.ts` `has()` cases `'repair'` (roles) and `'guild'` (`GUILD_MANAGER_NPCS`); `servicesOf` += `'repair'`, `'guild'` | COMBAT §6.4, SOCIAL §6 |
| Cos entity, `'board'` action | `world.ts` | COMBAT §6.4 |
| World info | `connection.ts` `worldEnter.world` | `alchemyRate`, `alchemyMaxPlus`, `social` |
| Stats | `Gameplay.stats(p)` | `hwan` (D33, D34) |
| Extra loot | `mobDied`, above FX-S's line | D51 |
| Chat branches | `chat.ts routeChat` | `'guild'` → `guilds.chat`, `'stall'` → `stalls.chat` (party-branch shape) |
| GM | `gm.ts COMMANDS` | `horse`, `hwan`, `dur`, `plus`, `mobskill` (bodies in the modules), `guilds` (`social/gm-guild.ts`) |
| Posture `in_combat` | `posture.ts` (7B file) | D30, one line |
| Decorators | `world.decorators.push` from the stall and guild modules | no `world.ts` edit for them |

### 4.3 Wave-8 client seams (W8-FC)

Only what 7B did not already build:

| Seam | File |
|---|---|
| `WORLD_FEATURES` += `mountFeature`, `berserkFeature`, `durabilityFeature`, `alchemyFeature`, `tradeFeature`, `stallFeature`, `guildFeature` (append-only) and their stubs | `world/features.ts`, `world/features/{mount,berserk,durability,alchemy,trade,stall,guild}.ts` |
| `registerEntityKind(kind, factory)` | `world/entities.ts` (D8) |
| `CharacterActor.useClipGroup('cart')`, `attachTo(node)` | `three/models.ts` (D8) |
| `WorldFeature.beforeGroundMove?(): boolean` and its two call sites | `world/features.ts`, `screens/world.ts` (the pointer `moveTo`), `world/move-feedback.ts` (hold-to-move) [the only two `moveTo` senders, confirmed per SOCIAL §9.1] |
| `approachThen(ctx, entityId, range, run): () => void` | new `world/approach.ts` |
| `catalog.cos(code)` stub (returns null) | `content/catalog.ts` |
| i18n stubs and spread lines (D22) | `i18n/en.ts`, `i18n/en-{mount,durability,alchemy,berserk,trade,stall,guild}.ts` |
| Mock extension lines (optional) | `net/mock/index.ts`, `net/mock/{trade,stall,guild}.ts` |

---

## 5. Wave 7B: UI rework + animations and effects

### 5.0 Step order, dependencies and concurrency

```
T0 ─┬─ W7-F   protocol P1/P3/P4 + client animation seams (one agent)         ~0.5 day
    ├─ UI-X   export: frames, controls, atlas crops, fonts, cursor, hitcount   ~0.5 day (no app deps)
    ├─ UI-K   kit files (new files only), then the zoom commit               ~1 day
    └─ FX-X   fx index v2, sidecar particles/dummies, trails, select, PRESETS.fx   ~1 day (no app deps)
T+0.5d ── W7-F lands ─┬─ FX-S   server: droppedAt, itemEffect, posture module
                      ├─ FX-C1  skill and combat presentation (critical path)
                      ├─ FX-C2  world/system fx, drops, idle, posture, ambient
                      ├─ FX-C3  target decal, click marker, hitcount sprites
                      └─ FX-I   lab (fxlab flag, H2)
T+1d ── UI-K kit files land; FX-C2/FX-C3 screens/world.ts hunks land;
        then UI-K's zoom commit (one commit) ─┬─ UI-H  HUD (+ M1–M5)
                                              ├─ UI-W  windows (+ M6–M11)
                                              └─ UI-O  outer screens
T+3d ── UI-G  GM window (last)
T+3.5d ── I7B integration → H7B hunt → fixes
```

- **Start order when agents are limited:** W7-F, UI-K, UI-X, FX-X; then FX-C1, FX-C2, FX-S; then UI-W, UI-H; then FX-C3, UI-O, FX-I; UI-G last.
- **Hard dependencies:**
  - FX-S, FX-C1, FX-C2, FX-C3, FX-I → W7-F;
  - FX-C1 / FX-C2 in-game checks → FX-X output (they start on v1 data and hand-made fixtures, EFFECTS §6);
  - FX-C3 hitcount sprites → UI-X (`ui/hitcount/*.png`); target decal → FX-X (`fx/tex/ui/select_0N.png`);
  - UI-H, UI-W, UI-O → UI-K (kit + zoom commit); their visual checks → UI-X;
  - UI-K's zoom commit → FX-C2's and FX-C3's `screens/world.ts` hunks merged (so it rebases once);
  - FX-C2's Action window → UI-K (kit window) and UI-H's M5 (`MenuBarEntry.icon`; without it the row uses the default icon map);
  - UI-G → UI-W (kit windows proven).
- **Merge order for the hot files of 7B** (each hunk anchored by quoted code):

  | File | Order of hunks |
  |---|---|
  | `apps/game/src/screens/world.ts` | FX-C2 (remove the `levelUpColumn` call in `case 'levelUp'`) → FX-C3 (`new TargetDecal`, `ClickMarker` in place of the inline torus) → UI-K (`.world-ui` wrapper around chat, perf, help, minimap; `.entity-labels` outside) → UI-H (`setHovered` → `setCursor`) → UI-W (`openMenu` → System window) |
  | `apps/game/src/hud/index.ts` | UI-K (`.hud-root` zoom; no `--ui` math) → UI-H (construction, placement from `hudAnchors`, `hud.underbar`, M3) → UI-W (toggles → `mainWindow.show(tab)`, `askCount` → `MessageBox.count`, M8) |
  | `apps/game/src/main.ts`, `params.ts` | UI-K (`?kit=1` gallery) and FX-I (`?fxlab=1`), append-only; integrator merges |
  | `apps/game/src/world/features/skills.ts` | FX-C1 owns it; UI-H's one hook line (`new Hotbar({…})` parent → `hud.underbar.slots`) is merged by FX-C1 |
  | `apps/game/src/world/features.ts` | FX-C2 appends `fxWorldFeature`, `postureFeature` |
  | `apps/game/src/i18n/en.ts` | UI-K (three spread lines: `en-ui`, `en-ui-hud`, `en-ui-windows`), FX-C2 (`en-fx`), append-only |
  | `apps/game/src/style.css` | UI-K (the `--ui` rules, `:root`), then by section: UI-H (HUD: chat, minimap, hotbar, EXP, menubar), UI-W (windows), UI-O (outer screens); dead rules are deleted by the lane that migrates the component |
  | `apps/server/src/gameplay.ts` | FX-S only (`spawnGroundItem` body + `from?` argument, its call in `mobDied`, the `posture` module in the constructor list) |

### 5.1 W7-F: protocol and animation seams (one agent, first)

**Owns:**

- `packages/shared/src/protocol.ts`, `validate.ts`: §3.1 exactly;
- new `packages/shared/test/wave7b.test.ts`;
- `docs/PROTOCOL.md`: §11 rows "Wave 7B" (`sit`, `emote`, `itemEffect`, `posture`, `droppedAt`, `dropFrom`); §5's dead list is unchanged;
- `apps/game/src/three/models.ts` (seam lines): `KEEP_CLIPS` += `PICK|DEFENCE|DAMAGE2|STAND3|STAND4|TURN_[LR]|REVIVAL|VENDOR01` (with `(_.*)?`) and mob `HELP|FIND`; `CharacterActor.setWeaponVisible(on)`, `weaponDummy(name)`, `playOverlay(type)`, `idleVariants()`, `onClip?`, `die(instant, clip?)` then `DIE1_RM` (EFFECTS §6.1);
- `apps/game/src/world/entities.ts` (seam lines): `EntityView.attack(target, hits, nowMs, opts?: {clip?})`; `EntityView.setIdle(kind: IdleKind)` (D7) replacing the two literal `play('STAND1')` calls;
- new `apps/game/src/world/fx/types.ts` (`FxStageV2`, `FxSkillV2`, `FxCharacterInfo`, `SystemFxKey` incl. `SYSTEM_CH_HWANMODE`, `SYSTEM_PET_APPEAR`, `SYSTEM_COS_HPPOTION`, `FxLabEntry`, `IdleKind`);
- `apps/game/src/net/mock.ts`: `not_implemented` placeholders for `sit`/`emote` in its `Record<ClientMessage['t'], …>` tables, and nothing else.

**Tests:**

- `wave7b.test.ts`: both client frames accepted with exact keys, rejected with an extra key, a bad emote, a non-boolean `on`; `itemEffect` / `emote` round trips; `EntityState.droppedAt`/`dropFrom`/`posture` kept; `entityUpdate.posture 'stand'` kept; every `GameplayRequest` has a `CLIENT_RATE_LIMITS` row;
- `apps/game/test/seams-fx.test.ts`: `KEEP_CLIPS` keeps the new names; `setWeaponVisible` toggles every worn mesh; `attack({clip})` plays that clip; `setIdle('vendor')` falls back to SIT when `VENDOR01` is missing.

**Check:** `pnpm vitest run packages/shared/test apps/game/test/seams-fx.test.ts` and `pnpm typecheck` green; nothing visible changes.

### 5.2 UI-X: UI export (first, parallel)

As docs/UI.md §9.1 UI-X, with these changes:

- **Owns:** `packages/convert/src/tools/export-ui.ts`; new `packages/convert/src/tools/font-subset.ts`, `packages/convert/src/tga.ts`; tests `packages/convert/test/font-subset.test.ts`, `packages/convert/test/export-ui-kit.test.ts`.
- **SELECTION** as UI.md §5.4, plus `interface/hitcount` (D2), plus `interface/exchange` widened to `/^(exc_|ch_)/` (D24); **minus** the `effect/select_0N` line (D3).
- Cursor TGA flipped (bottom-up); `englishText` manifest field (not `bakedText`).
- **Run:** `pnpm tsx packages/convert/src/tools/export-ui.ts --force`, then `pnpm tsx packages/convert/src/tools/optimize-out.ts run`; assets deploy with `pnpm run deploy -- --assets-only`.
- **Done when:** every UI.md §5.2 key and `ui/hitcount/*.png` exist; `frame/mframe_wnd_9.png` looks right at 3× (Read tool); Chrome loads `basic.ttf`/`chat.ttf` (no `fonts-fallback` class).

### 5.3 UI-K: kit and the zoom commit

As docs/UI.md §9.1 UI-K, with these additions:

- **Owns:** `apps/game/src/ui/kit/**` (UI.md §5.1 incl. `gallery.ts`), `apps/game/src/i18n/en-ui.ts` and the two empty files `en-ui-hud.ts` (handed to UI-H) and `en-ui-windows.ts` (handed to UI-W), `apps/game/test/ui-kit.test.ts`, `apps/game/test/ui-text-fit.test.ts`.
- **Hooks:** `ui/art.ts` (`UiImage.nine`, `UiManifest.englishText`, `hasAny()`); `app.ts updateScale()` and the `settings.onChange` comparison (`ui.scaleMode`); `settings.ts` (`ui.scaleMode`); `hud/options.ts` (the scale row only); `hud/window.ts` (`HudWindow` extends kit `Window`: every window gets the mframe chrome and cascade at once); `params.ts` + `main.ts` (`?kit=1`); `i18n/en.ts` (three lines).
- **Mount points:** M9 (kit `Slot.setSigns`), M12 (`setCursor` incl. `'repair'`), M13 (`MessageBox`), M16 (the kit). Token `--c-guild-name` (D19) and the chat tokens of UI.md §4.4 with `--c-chat-stall`.
- **The zoom commit** (one commit, after FX-C2/FX-C3's `screens/world.ts` hunks merge, before UI-H/UI-W start): `zoom: var(--ui)` on `.hud-root` and a new `.world-ui` wrapper; remove every `scale(var(--ui))` and `calc(Npx * var(--ui))` in the files UI.md §9.1 lists (`style.css`, `hud/menubar.ts`, `hud/npc-ui.ts`, `hud/party-invite.ts`, `hud/party.ts`, `hud/skills-style.ts`, `hud/ux-style.ts`, `quests/style.ts`, `world/features/map.ts`). Floaters, `.entity-labels`, nameplates and `screens/charselect.ts:298` stay outside or keep their own scale.
- **Done when:** the unit tests pass; `http://localhost:5180/?kit=1` renders every control in every state at 1×, 1.25× and 2×; at 1024×768 the in-game UI draws at 100 %.

### 5.4 UI-H: HUD

As docs/UI.md §9.1 UI-H, with: **not** `hud/effects.ts` / `hud/hitcount.ts` (FX-C3, D2), and the mount points M1–M5.

- **Owns:** new `hud/underbar.ts`, `hud/underbar-layout.ts`, `hud/hud-layout.ts`; `hud/player.ts`, `hud/target.ts`, `hud/buffs.ts`, `hud/menubar.ts`, `hud/hotbar.ts` (view), `hud/perf-overlay.ts` (position); `world/chat.ts`, `world/ux-world-style.ts`, `world/jangan/minimap.ts`; the `PartyFrame` class in `hud/party.ts`; `quests/tracker.ts` (position); `hud/ux-style.ts` lines for the perf overlay and small-screen chat rule; the `.npc-cast` block of `hud/npc-ui.ts` and `hud/item-cast.ts` (casting bar at H−162); `i18n/en-ui-hud.ts`; `apps/game/test/ui-layout.test.ts`.
- **Hooks:** `hud/index.ts createHud()` (construction, placement, `hud.underbar`, M3); `world/features/skills.ts` Hotbar parent (merged by FX-C1); `world/features/quests.ts` `tracker.setTop` (one line); `world/features/party.ts` (two lines, M3); `screens/world.ts setHovered` → `setCursor`.
- **Done when:** the layout test passes; user checks 1, 3–7, 13 of UI.md §9.3 pass; M1–M5 tests pass.

### 5.5 UI-W: windows

As docs/UI.md §9.1 UI-W, with the mount points M6–M11.

- **Owns:** new `hud/main-window.ts`; `hud/inventory.ts`, `hud/character.ts`, `hud/skills.ts`, `hud/skills-style.ts`, `hud/slots.ts` (view + M9 registry), `hud/items.ts` (M11 only), `hud/npc-dialog.ts` (+ M7), `hud/shop-logic.ts` (M7 only), `hud/npc-ui.ts` (except `.npc-cast`), `hud/shop.ts` (+ M6), `hud/storage.ts`, `hud/options.ts` (except UI-K's scale row; + M10), `hud/keyhelp.ts`, `hud/ux-style.ts` (except UI-H's lines), `hud/ux-shell.ts`, `hud/death.ts`, `hud/party-invite.ts`, `hud/sound-settings.ts` (base class only); the `PartyWindow` class; `quests/log.ts`, `quests/dialog-panel.ts`, `quests/style.ts`; `world/map/worldmap.ts`, `world/features/placeholder.ts`; `i18n/en-ui-windows.ts`; `apps/game/test/tooltip-model.test.ts`.
- **Hooks:** `hud/index.ts` toggles and `askCount`, M8; `screens/world.ts openMenu` → System window.
- **Main window** as UI.md §4.6 (C/I/S/P/Q as tabs; Inventory = equipment + bag; bag pages of 32 with the spin control).
- **Done when:** every "from today" window of UI.md §4.6 is migrated; old tests pass (view classes keep their names as aliases); user checks 2, 8–12 of UI.md §9.3 pass; M6–M11 tests pass.

### 5.6 UI-O: outer screens, and UI-G: GM window

- **UI-O** as UI.md §9.1 (`screens/login.ts`, `servers.ts`, `charselect.ts`, `charcreate.ts`, `loading.ts`, the outer sections of `style.css`; hook: the mute button position in `main.ts`). Takes a one-line fix from FX-C2 if the T-pose cause is in its screens (D25).
- **UI-G** as UI.md §9.1 (`gm/window.ts`, `gm/editors/style.ts`), last.

### 5.7 FX-X: effects export

As docs/EFFECTS.md §6.2, with D3 and D5:

- **Owns:** new `packages/convert/src/fx/skilleffect.ts`, `packages/convert/src/fx/model-fx.ts`; `packages/convert/src/fx/skills.ts` (v2 builder **including the MSKILL and SYSTEM groups**); `packages/convert/src/tools/export-fx.ts` (trail textures, `select_0N` → `/out/fx/tex/ui/`, v2 index); `PRESETS.fx` in `packages/convert/src/gltf/output.ts` (arrows, `banditarcher_arrow`, whitehawk, the missing drop models, die BSRs; quest marks not listed, §8 Q13); tests `packages/convert/test/fx-skilleffect.test.ts`, `packages/convert/test/fx-skills-v2.out.test.ts`.
- **Hook:** the sidecar writer in `packages/convert/src/gltf/convert.ts` (`particles` via `toGltfPosition`; `dummies`; the `skeleton:` line).
- **Done when:** EFFECTS §6.2's test list passes; `/out/fx/skills.json` has `version: 2` and the Jangan MSKILL groups; `pnpm sro convert` of the fx preset writes the new glbs.

### 5.8 FX-S: effects server

As docs/EFFECTS.md §6.3 (registration in the `Gameplay` constructor list, not `modules.ts`).

- **Owns:** the body of `spawnGroundItem` (+ optional `from?: Vec3`) and its `mobDied` call in `apps/server/src/gameplay.ts`; the `itemEffect` broadcast in `apps/server/src/item-use.ts`; new `apps/server/src/posture.ts` (`sit`, `emote`; stand-up on `moved`, `stopped`, damage); its line in the module list; `apps/server/test/posture.test.ts`.
- **Tests:** `droppedAt` = the kill tick; `dropFrom` = the corpse point; `itemEffect` reaches viewers only; `sit` refused while moving (`busy`) and dead; `moveTo` stands up (`entityUpdate posture 'stand'`); emote budget.

### 5.9 FX-C1: skill and combat presentation (critical path)

As docs/EFFECTS.md §6.4 (M1–M22), with D4:

- **Owns:** `apps/game/src/world/skill-fx.ts`, `apps/game/src/world/skills-view.ts`, `apps/game/src/world/features/skills.ts`, `packages/fx/**`; new `world/fx/trail.ts`, `world/fx/anchors.ts`, `world/fx/fx-model.ts`, `world/fx/hit-light.ts`; tests `apps/game/test/skill-fx.test.ts` (extended), `apps/game/test/effects-retail.test.ts` (H1) + `apps/game/test/fixtures/effects-golden.ts`.
- **Mob presentation (the former MS-C list, D4):** mob casters through the `cast` path; clip from `SkillDef.animation` or the fx index v2 group; MSKILL stages on mob bones; DamageEfp and blood per mob; the bandit arrow model; Tomb Stone Ghost / Tomb Stone / Yeoha force bolts; the `_clon` ATTACK3 gaps → ATTACK1 with the hit shown at `castMs`; `combat` without `instance` → `attack({clip})`; without `skill` → today's cycle. Unit tests use synthetic mob `cast` / `combat` messages (Mangyang ATTACK2 hits at 821 / 1381 ms; Black Tiger howl on ATTACK1).
- **Berserk hook:** hits with `hwan: true` use the HWAN DamageEfp and trail (priority 10); in 7B nothing sends `hwan`, so it is tested with a synthetic hit.
- **Done when:** H1 passes on the real exports; EFFECTS §6.8 checklist items 1–12 pass in the browser.

### 5.10 FX-C2: world, system effects, drops, idle, posture

As docs/EFFECTS.md §6.5, plus D25 and M15:

- **Owns:** `apps/game/src/world/drops.ts` (rewrite behind the `DropVisual` API); new `world/fx/system-fx.ts` (M15), `world/fx/model-particles.ts`, `world/idle.ts`, `world/features/fx-world.ts`, `world/features/posture.ts` (N key, `/sitdown`, the emote prefixes via `ctx.chat.registerPrefix`, and the **Action** MENU row + a small kit window with Sit and 7 emotes, D20); `i18n/en-fx.ts`; `packages/world-render/src/ambient-fx.ts` + its hook in `packages/world-render/src/objects.ts`; tests `apps/game/test/drops.test.ts`, `system-fx.test.ts`, `idle.test.ts`, `packages/world-render/test/ambient-fx.test.ts`.
- **Hooks:** `world/features.ts` (two append lines); `screens/world.ts` (remove the `levelUpColumn` call); `i18n/en.ts` (one line).
- **Also:** reproduce and fix the T-pose (D25).
- **Done when:** EFFECTS §6.8 items 13–17 and 20 pass; the T-pose is gone in select, create and world.

### 5.11 FX-C3: target decal, click marker, damage numbers

As docs/EFFECTS.md §6.6, with D2 (the hitcount sprites come back to FX-C3):

- **Owns:** `apps/game/src/world/effects.ts` (`TargetDecal` replacing `TargetRing` with the same API, `ClickMarker`; `levelUpColumn` may be deleted once FX-C2's call is gone); new `apps/game/src/hud/hitcount.ts`; the `Floaters` class in `apps/game/src/hud/effects.ts`; the marker/ring lines of `screens/world.ts`; tests `apps/game/test/target-decal.test.ts`, `apps/game/test/hitcount.test.ts`.
- **Done when:** EFFECTS §6.8 items 18–19 pass; UI.md §9.3 check 14 passes; the "Damage numbers" option still turns them off.

### 5.12 FX-I: lab

As docs/EFFECTS.md §6.7: new `apps/game/src/debug/fx-lab.ts`, the `fxlab` flag in `params.ts` (mock only), one line in `main.ts`. Runs H2 (`await __sroFxLab.runAll()`, `__sroFxLab.report()`) in its own Browser-pane tab (explicit `tabId`; the pane is shared).

### 5.13 Tests and gates (wave 7B)

- Per lane: `pnpm vitest run <its tests>` and `pnpm typecheck` before handing over.
- New test files: `packages/shared/test/wave7b.test.ts`, `apps/game/test/{seams-fx,ui-kit,ui-text-fit,ui-layout,tooltip-model,skill-fx (ext),effects-retail,drops,system-fx,idle,target-decal,hitcount}.test.ts`, `apps/server/test/posture.test.ts`, `packages/convert/test/{font-subset,export-ui-kit,fx-skilleffect,fx-skills-v2.out}.test.ts`, `packages/world-render/test/ambient-fx.test.ts`.
- Existing tests pass unchanged (UI.md §8 list; view classes keep their names as aliases).

### 5.14 I7B: integration (one agent, after the lanes merge)

**Gates:** `pnpm typecheck`; `pnpm test` (all vitest, `role-policy.test.ts` unchanged); `pnpm --filter @sro/game build`; `pnpm --filter @sro/viewer build`.

**Headless flows** in new `apps/server/test/wave7b-e2e.test.ts` (the `wave3-e2e` pattern, `jangan-fields`):

1. Kill a GM-spawned Mangyang: the gold / item `spawn` carries `droppedAt` (the kill tick ±1) and `dropFrom` (the corpse point).
2. Drink an HP potion: a second client in view gets `itemEffect {id, item}`; a third out of view does not.
3. `sit {on:true}` → `entityUpdate posture 'sit'` to the viewer; `moveTo` → `posture 'stand'`; `sit` while moving → `busy`; `emote 'hi'` → `emote` to viewers; the 4th emote in 1 s → `rate_limited`.
4. A late joiner sees `posture: 'sit'` in the spawn.
5. Abuse: every new client type with an extra key → `bad_request` + strike.

**Retail harness:** run H1 (`pnpm vitest run -t retail`) and H2 (FX lab) and record the report in the review notes.

**Browser checklist** (tell the user): EFFECTS §6.8 items 1–20 and UI.md §9.3 checks 1–15, at 1024×768, 1280×720 and 1920×1080, plus:

- the wave-8 mount points exist but show nothing (no Berserk orbs, no horse frame, no repair buttons, no Guild tab);
- screen-projected elements (damage numbers, nameplates, entity labels) sit on their targets at 125 % (UI.md §11 zoom risk);
- the T-pose is gone.

**Performance (N100):** trails, hit lights (≤ 4), ambient particles (≤ 40 within 60 m), drop sparkles (≤ 30), the 7.2 s level-up program: record FPS with 5 players on the N100 profile; each has a quality switch (EFFECTS §7).

### 5.15 H7B: adversarial-hunt lenses (wave 7B)

- **Effect leaks:** 1,000 casts per line with random cancels; no leaked instances, no stuck loops (`SkillFx.stats.started === disposed`).
- **Hidden weapons:** Hide Weapon restored on every end path (castEnd, death, a replaced action, despawn, warp).
- **Mid-flight deaths:** a mob dying during an arrow flight; a carrier despawning mid-loop; enter-view during a cast.
- **Drops:** 50 drops at once (frame time); a drop whose `dropModel` glb is missing (fallback); fresh vs old drops at enter-view.
- **Posture:** `sit` spam at the budget; sit then attack (stands up, no stuck SIT); sit during a return-scroll cast (`busy`); death while sitting; emote during a skill.
- **UI zoom:** every drag and position that mixes `clientX` with `style.left` divides by `--ui` (windows, drag ghosts, tooltips, context menus) at 1.25 and 2.
- **Keyboard:** Esc closes the top window only; game keys stay off in inputs (chat, count box, GM window).
- **Fonts:** the subset fails OTS → the Tahoma fallback still lays out (ui-text-fit budget).
- **Tabs model:** C/I/S/P/Q from every state (open, other tab, closed); shop and storage open the Inventory tab; placeholder tabs.
- **Mount points:** each M1–M16 works with nothing registered (no empty buttons, no exceptions).

### 5.16 Scope-cut order (wave 7B)

Cut from the top:

1. UI-G (the GM window keeps its old look).
2. FX-I H2 in the browser (keep H1).
3. World ambient effects (`ambient-fx.ts`).
4. M13 waist twist, M17 bone-rotation rule, DAMAGE2, NPC idle variants and fidgets.
5. The Action MENU window (keep N and the chat commands).
6. Attack/talk/pick-up cursor overlays (keep the flame hand for all).
7. UI-O (keep UI-K's scale fix on the outer screens).
8. Hit lights (M12), blood (M11).
9. Sit and emotes (P4 whole; the protocol stays, unused).
10. The Main-window tabs (keep separate windows with the mframe chrome; UI.md open question 1's "Separate windows" becomes the only mode).

**Never cut:** UI-X (incl. fonts and hitcount art), UI-K (kit, scale, chrome, zoom), the underbar, the player/target/minimap HUD, the wave-8 mount points M1–M16, weapon trails, the drop models, the mob-attack presentation path, level-up / potion / return-scroll effects, the hitcount digits, H1.

---

## 6. Wave 8: combat, item and social systems (on the kit)

### 6.0 Entry criteria, step order and dependencies

**Entry:** wave 7B gates green; the mount points M1–M16 merged with their tests; `work/out/fx/skills.json` v2 with the MSKILL groups exported.

```
T0 ── W8-F   protocol + content types + migrations v8/v9 + server seams + stubs (one agent)   ~1.5 days
      (EXP may start once W8-F's content.ts types are committed, ~T+0.5d)
T+0.5d ─ W8-FC client seams (after W8-F's protocol commit)                                     ~0.5 day
T+1.5d ── seams land ─┬─ MS-S  monster skills (server)            (critical: "combat feels flat")
                      ├─ DR    durability + repair
                      ├─ TR-S  trade server   ── TR-C trade client
                      ├─ MR-S  horses server  ── MR-C horses client (after EXP converts c_horse1)
                      ├─ AL    alchemy
                      ├─ BZ    Berserk
                      ├─ ST-S  stall server   ── ST-C stall client
                      └─ GU-S  guild server   ── GU-C guild client
T+4d ── I8 integration → H8 hunt → fixes
```

- **Start order when agents are limited:** W8-F → W8-FC, EXP → MS-S, DR, TR-S, TR-C → MR-S, MR-C, AL, BZ → ST-S, ST-C → GU-S, GU-C.
- **Hard dependencies:**
  - every app lane → W8-F (server) and W8-FC (client);
  - EXP → W8-F's `content.ts`; MS-S, MR-S, AL need EXP's data for their e2e (unit tests use fixtures);
  - MR-C's in-game check → EXP's `pnpm sro convert res/cos/c_horse1.bsr` (+ the hair and elixir drop models);
  - ST-S uses TR-S's `pairTx` (if TR-S has not landed, ST-S codes to the SOCIAL §2.4 signature);
  - client lanes' in-game checks → their server lanes.
- **Hot files in wave 8** are edited only by W8-F / W8-FC; lanes touch them only at the hook lines named in their row.

### 6.1 W8-F: foundation (protocol, content, migrations, server seams; one agent)

This is COMBAT F6-FS + SOCIAL SOC-P + SOC-FS as **one** agent, so the exhaustive `NpcService` switch, `OPTION_KEY`, `ACTION_FAIL_REASONS` i18n lines and `SCHEMA_VERSION` test stay green together.

**Owns:**

- shared: `packages/shared/src/protocol.ts`, `validate.ts` (§3.2 incl. D32, D33, `worldInfo()`), `content.ts` (§3.3), `content-check.ts`; new `packages/shared/test/wave8.test.ts`;
- `docs/PROTOCOL.md`: §11 wave-8 rows, a new §12 "Combat and items", §13 "Social: trade, stalls, guilds"; "Content files" becomes §14 and "Open points" §15;
- server: `db.ts` (v8, v9, D34 cache source), `config.ts` (§2.4), `modules.ts` (`gate`), `gameplay.ts` (§2.5 list, `gateFor`, the §4.2 seams), `world.ts` (Cos, `'board'`), `inventory.ts` (`equipItem` broken), `skills/mods.ts`, `skills/engine.ts`, `ai.ts` (the `ranged?` call only), `item-use.ts` (dispatch line), `npc.ts`, `formulas.ts`, `gm.ts` (six command entries), `chat.ts` (two branches), `connection.ts` (world info), `posture.ts` (D30 line);
- stubs: `apps/server/src/{mob-skills,mounts,durability,repair,alchemy,berserk}.ts`, `apps/server/src/social/{trade,trade-rules,pair-tx,stall,stall-rules,guild,guild-rules,guild-store,gm-guild}.ts`;
- client (compile-only): new `apps/game/src/i18n/en-fail-w8.ts` + its line in `i18n/en.ts`; `net/mock.ts` (`not_implemented` placeholders for the 34 types, and `hwan: 0` in the mock stats, D33); any exhaustive-switch break found by `pnpm typecheck` (expected: none, thanks to M4/M7);
- tests: `apps/server/test/migrate-wave8.test.ts` (v7 → v9 on a temp `DATA_DIR`; columns and indexes exist), `apps/server/test/formulas-wave8.test.ts` (`perPlus × plus`; broken items skipped), `apps/server/test/social-seams.test.ts` (gate order, own-handles exemption, allowlist refuses an unknown future type, a throwing gate allows, a gated `moveTo` leaves the position unchanged), `apps/server/test/modules-w4.test.ts:158` (7 → 9).

**`wave8.test.ts`:** every new client frame round-trips with exact keys; each bound ±1; code-point limits with astral characters; `RepairRef` xor; `perms` duplicates rejected; `stallText {}` rejected; `chat {to, channel:'guild'}` rejected; `alchemyReinforce` with a repeated bag index rejected; server messages parse; wrong `items` length rejected; `null` kept; `''` kept on `entityUpdate`; `stats.hwan` kept and required in a full `stats`; `CombatHit.hwan` kept; `EntityKind 'cos'` accepted; `GUILD_NAME` cases (SOCIAL §10.1); every `GameplayRequest` has a rate-limit row.

**Done when:** every existing test passes unchanged; the new tests pass; nothing visible changes (every new request answers `not_implemented`).

### 6.2 W8-FC: client seams

**Owns:** §4.3: `world/features.ts` (seven lines + `beforeGroundMove`), the seven feature stubs, `world/entities.ts` (`registerEntityKind`), `three/models.ts` (`useClipGroup`, `attachTo`; `SKIP_PACKS` stays for startup), `screens/world.ts` + `world/move-feedback.ts` (`beforeGroundMove` calls), new `world/approach.ts`, `content/catalog.ts` (`cos()` stub), `i18n/en.ts` (seven lines) + the seven `en-*.ts` stubs, `net/mock/index.ts` + optional mock stubs.

**Tests:** new `apps/game/test/seams-w8.test.ts`: `approachThen` (arrival runs once; another click cancels; timeout); an unregistered entity kind is ignored and a registered one builds its view; `beforeGroundMove` true suppresses the `moveTo`; `useClipGroup('cart')` requests the cart pack once.

### 6.3 EXP: exporter

COMBAT §8 EXP + D6 + D23:

- **Owns:** `packages/convert/src/data/items.ts` (scope, classification, `reinforce`, `use.summon`, `use.target`, elixir `_b` icon fallback, typed `perPlus`, **`canTrade`**), new `packages/convert/src/data/cos.ts`, `packages/convert/src/data/skills.ts` (`buildMobSkills`), `packages/convert/src/data/npcs.ts` (`'repair'` role on `NPC_CH_SMITH`, `NPC_CH_ARMOR`), `packages/convert/src/data/content.ts` (`cos.json`, MSKILL rows), `packages/convert/src/sound/build.ts` (cues `cos.horse.{stand,moan,moanCrit,die,thud,run}`, `berserk.start` / `berserk.end`); tests `packages/convert/test/data-systems-combat.test.ts`, `packages/convert/test/data-cantrade.test.ts`.
- **Runs (no code):** `pnpm sro convert res/cos/c_horse1.bsr res/item/etc/drop_reinforce_recipe.bsr res/item/etc/drop_reinforce_prob_up.bsr res/char/china/chinaman_hwan_hair.bsr res/char/china/chinawoman_hwan_hair.bsr`; `pnpm tsx packages/convert/src/tools/export-data.ts`; `pnpm tsx packages/convert/src/tools/export-sound.ts`.
- **Not owned:** `fx/skills.ts`, `gltf/output.ts` (FX-X, 7B).
- **Tests:** COMBAT §8 EXP's list, plus `canTrade: false` on exactly the 25 `*_DEF` items and absent on `ITEM_CH_SWORD_01_A`.
- **Also check** the `ui.eqbreak` / `ui.eqdanger` file mapping by ear (COMBAT §3.1; they may be swapped).

### 6.4 Combat lanes

| Lane | Owns | Hook points (only these lines outside owned files) | Tests | User checks |
|---|---|---|---|---|
| **MS-S** | `apps/server/src/mob-skills.ts`; the `ranged` hook body in `apps/server/src/ai.ts`; `apps/server/test/mob-skills.test.ts`; `apps/game/test/mob-skill-view.test.ts` (acceptance of FX-C1's path on the real rows, D4) | none beyond W8-F's seams | COMBAT §8 MS-S list (pick frequencies 71/21/7 % ± 2; projectile arrival; `target_lost`; `interrupted`; howl area; gas 0 damage + poison; `relative` / `retail` numbers; busy window) | COMBAT §8.1 M1–M4 |
| **MR-S** | `apps/server/src/mounts.ts` (incl. its `gate`, D43, and the `berserk_active` summon/ride refusal, D49); `apps/server/test/mounts.test.ts` | — | COMBAT §8 MR-S list + the mounts gate (sit, emote, stallCreate, alchemyReinforce, berserk → `mounted`) | H1, H2, H4, H5 (server half) |
| **MR-C** | `apps/game/src/world/features/mount.ts` (click-to-ride, dismount-then-attack, `/dismount`, `/unsummon`, sounds), new `world/mount-view.ts` (registers `'cos'`, `useClipGroup('cart')`, `attachTo(saddle)`), new `hud/mount-frame.ts` (kit, mounted in `PlayerFrame.petHost`), the `cos()` body in `content/catalog.ts`, `i18n/en-mount.ts`; `apps/game/test/mount.test.ts` | none | intent sequence; the view follows the rider; the frame shows HP | COMBAT §8.1 H1–H5 |
| **DR** | `apps/server/src/durability.ts`, `apps/server/src/repair.ts`, new `apps/game/src/hud/repair.ts` (footer buttons via M6, hammer via M12, confirm via M13), `apps/game/src/world/features/durability.ts` (M9 decorator, M2 warning icon), `i18n/en-durability.ts`; tests `apps/server/test/durability.test.ts`, `repair.test.ts`, `apps/game/test/repair.test.ts` | the durability hunk of `hud/items.ts tooltip()` (D11) | COMBAT §8 DR list + D47 (storage/buyback keep durability) | COMBAT §8.1 D1–D4 |
| **AL** | `apps/server/src/alchemy.ts` (incl. its soft-lock `gate`, D44, and `extraDrops`), new `apps/game/src/hud/alchemy.ts` (kit, UI.md §4.6 layout, D40), `apps/game/src/world/features/alchemy.ts` (`hud.routeBagAction` for elixir/powder right-click, MENU row), `i18n/en-alchemy.ts`; tests `apps/server/test/alchemy.test.ts`, `apps/game/test/alchemy.test.ts` | none | COMBAT §8 AL list + D44 (trade request during a fuse → `busy`) + D48 | COMBAT §8.1 A1–A5 |
| **BZ** | `apps/server/src/berserk.ts` (D34 cache), new `apps/game/src/hud/berserk.ts` (orbs in `PlayerFrame.berserkHost`), `apps/game/src/world/features/berserk.ts` (Tab via `hud.keys`, `SystemFx.play('SYSTEM_CH_HWANMODE', …)`, hwan hair through `@sro/appearance`), `i18n/en-berserk.ts`; tests `apps/server/test/berserk.test.ts`, `apps/game/test/berserk.test.ts` | none | COMBAT §8 BZ list + D34 (first `stats` after relog carries the saved points) | COMBAT §8.1 B1–B4 |

### 6.5 Social lanes

| Lane | Owns | Hook points | Tests | User checks |
|---|---|---|---|---|
| **TR-S** | `apps/server/src/social/trade.ts`, `trade-rules.ts`, `pair-tx.ts`; tests `apps/server/test/trade.test.ts`, `trade-rules.test.ts` | module hooks only (`gate`, `moved`, `stopped`, `playerDied`, `warped`, `forget`, `tick`) | SOCIAL §10.5 + D47 (snapshot compares `plus` and `durability`) + D50 | SOCIAL §10.10 1–5 |
| **ST-S** | `apps/server/src/social/stall.ts`, `stall-rules.ts`; test `apps/server/test/stall.test.ts` | module hooks; `world.decorators.push`; `pairTx` | SOCIAL §10.6 + D29 (`in_combat` within 5 s of combat) | 6–9 |
| **GU-S** | `apps/server/src/social/guild.ts`, `guild-store.ts`, `guild-rules.ts`, `gm-guild.ts`; tests `apps/server/test/guild.test.ts`, `guild-store.test.ts` | module hooks; decorator; `requireService('guild')`; `inventoryTx` in `try/catch` for the UNIQUE error | SOCIAL §10.7 incl. the restart test | 10–15 |
| **TR-C** | `hud/trade.ts` (kit, 365×500, D39), `hud/trade-state.ts`, `hud/trade-request.ts`, `world/features/trade.ts` (M3 Exchange action, M8 marks, `/trade`), `i18n/en-trade.ts`, `net/mock/trade.ts`; test `apps/game/test/trade.test.ts` | none | SOCIAL §10.8 TR-C | 1–5 |
| **ST-C** | `hud/stall.ts` (kit, 467×490), `hud/stall-state.ts`, `world/features/stall.ts` (`setIdle('vendor')` from `EntityState.stall`, `setBadge('stall', …)`, `beforeGroundMove`, MENU row, `/stall`), `i18n/en-stall.ts`, `net/mock/stall.ts`; test `apps/game/test/stall.test.ts` | none | SOCIAL §10.8 ST-C | 6–9 |
| **GU-C** | `hud/guild.ts` (kit, 477×393 community window), `hud/guild-state.ts`, `hud/guild-invite.ts`, `world/features/guild.ts` (U key, M3 Guild-invite action, M7 `'guild'` service, M4 tab, M10 option row, `setBadge('guild', …)`, prefixes), `i18n/en-guild.ts`, `net/mock/guild.ts`; test `apps/game/test/guild.test.ts` | none | SOCIAL §10.8 GU-C | 10–15 |

**Gate allowlists (SOCIAL §2.3, completed with waves 7B and 8):**

| State | Allowed besides the module's own `handles` | Everything else |
|---|---|---|
| trade window open | chat, `stopAction`, `hotbarSet`, `statUp`, `skillLearn`, `masteryUp`, `buffCancel`, `party*`, `guild*` (not create), `storageOpen`, `npcClose`, `emote` [decision: harmless], `mountDismiss` [decision: removes a horse, touches no bag] | refused `trading`; `moveTo`, `attack`, `useSkill`, `npcTalk` **cancel** the trade and pass |
| stall exists | chat, `stall*` (own), `stopAction`, `hotbarSet`, `statUp`, `skillLearn`, `masteryUp`, `buffCancel`, `party*`, `guild*` (not create), `mountDismiss` | refused `stalling` (incl. `sit`, `emote`, `repair`, `alchemy*`, `mountRide`, `mountDismount`, `berserk`, `moveTo` dropped) |

### 6.6 Tests and gates (wave 8)

- Per lane: `pnpm vitest run <its tests>` and `pnpm typecheck`.
- New test files: `packages/shared/test/wave8.test.ts`; `apps/server/test/{migrate-wave8,formulas-wave8,social-seams,mob-skills,mounts,durability,repair,alchemy,berserk,trade,trade-rules,stall,guild,guild-store}.test.ts`; `apps/game/test/{seams-w8,mob-skill-view,mount,repair,alchemy,berserk,trade,stall,guild}.test.ts`; `packages/convert/test/{data-systems-combat,data-cantrade}.test.ts`; plus I8's e2e and H8's abuse files.

### 6.7 I8: integration (one agent)

**Gates:** `pnpm typecheck`; `pnpm test` (all vitest; `role-policy.test.ts` unchanged; `modules-w4.test.ts` at 9); `pnpm --filter @sro/game build`.

**Headless flows** (`jangan-fields`, the `wave3-e2e` pattern):

- `apps/server/test/combat-e2e.test.ts` (COMBAT §8 I6): summon a horse at level 10, ride toward Tiger Mountain, dismount, fight a Black Tiger (`MOB_CH_WHITETIGER_CLON`, the howl lands on everyone within 2 m), break a sword with `/dur`, repair it at Chulsan, enhance it to +2 (seeded rng), `/hwan 5` → `berserk` → doubled damage, speed back after 60 s (fake clock in units).
- `apps/server/test/social-e2e.test.ts` (SOCIAL §10.9): full exchange; stall create/list/open/visit/buy; guild create/invite/chat/relog; restart → guild present, stall gone.
- **New cross-system flows** in `apps/server/test/wave8-cross-e2e.test.ts`:
  1. enter-world order with a saved horse and a guild (§3.2.8), and `stats.hwan` equal to the saved points (D34);
  2. trade a +3 sword at 10/76 durability: it arrives +3 at 10/76; the same trade after the owner repairs it mid-window → the repair is refused (`trading`), D46;
  3. list a broken sword in a stall and buy it: the buyer gets durability 0; `itemEquip` → `broken`;
  4. start a fuse, then `tradeRequest` → `busy`; `moveTo` → `alchemyResult cancelled`, nothing consumed (D44);
  5. mounted: `stallCreate` → `mounted`, `sit` → `mounted`, `tradeRequest` → ok (D43);
  6. while trading: `alchemyReinforce`, `repair`, `mountRide`, `berserk`, `sit` → `trading`; `emote` → ok;
  7. summon while berserk → `berserk_active` (D49);
  8. a Recovery Kit → `itemEffect {id: <cos id>}` to viewers (D52);
  9. a mob-skill `cast` from a Tomb Stone Ghost reaches a client, then `combat {instance}` at `at` (projectile), and FX-C1's client path consumes it (MS-S `mob-skill-view.test.ts` green on the real rows).
- **Balance:** re-run the docs/BALANCE.md model in `relative` mode; update its §6 table; confirm the level-8 tomb damage per swing equals the 7A numbers.
- **Docs:** PROTOCOL.md (already by W8-F; fix drift), PLAYTEST.md gains "Combat and items" (COMBAT §8.1) and "Social" (SOCIAL §10.10) sections.

**Browser checklist** (tell the user; two accounts for social): COMBAT §8.1 H1–H5, M1–M4, D1–D4, A1–A5, B1–B4; SOCIAL §10.10 1–15; plus: the horse frame sits in the player frame's pet area; the Berserk orbs arc around the portrait; Repair / Repair all sit in the Blacksmith's shop footer; the Guild row, Stall row and Alchemy row appear in the MENU popup; Exchange and Guild invite sit inside the target window next to Invite.

### 6.8 H8: adversarial-hunt lenses (wave 8)

One agent reads, writes `BUG:` tests (the `abuse-party.test.ts` convention) in `apps/server/test/abuse-combat.test.ts` and `apps/server/test/abuse-social.test.ts`, then files fixes.

- **Horses:** dismount-while-moving in one tick; riding into a safe zone to dodge; redirect with a dead or despawned horse; a DoT tick on a mounted rider (must hit the rider); the `cos` entity at view range while ridden (`positionAt` mid-move); a GM-invisible player's horse; a relog with a parked horse far away.
- **Monster skills:** a mob despawning mid-cast (`castEnd`, no crash); a target warping during a projectile flight; summons with `MOB_SUMMONS` on and the cap; a stunned mob at release; the busy window vs leash/retreat.
- **Durability:** DB write volume (one write per point lost, not per hit); a broken weapon in an auto-attack loop started before it broke; repair spam at the budget; repairing the same slot twice in one request; a ring alone → `nothing_to_repair`.
- **Alchemy:** the same bag index twice; swapping the item during the fuse (re-validation); `ALCHEMY_RATE` > 100 % clamp; a fuse at logout / death / warp; the soft lock vs trade and stall (D44).
- **Berserk:** toggled at death; activation mid-skill; points gained while active (none); relog keeps points (D34).
- **Trade:** SOCIAL T1–T15 plus party gold share during a trade; a pickup walk completing during a trade and changing an offered stack (commit fails, nothing moves); a partner going GM-invisible; rate-limit floods not striking the socket.
- **Stall:** SOCIAL S1–S13 plus a return scroll while stalling (gated); GM `tp` of a stall owner (closes); a buyer's stale price after Modify.
- **Guild:** SOCIAL G1–G11 plus `/guilds info X` reaches the GM path and `/guild Bob` sends `guildInvite`.
- **Gate:** every wave-7B and wave-8 request type in each locked state (trading, stalling, mounted, fuse pending) gets the documented answer; a new request type added in the future is refused by default (allowlist).
- **Cross-system item states:** D43–D52 as abuse cases (the §6.7 cross flows, randomised order, 1,000 iterations with a seeded rng; inventory invariants: no duplicated item ids, gold conserved across a trade and a stall sale, `social_log` totals match).

### 6.9 Scope-cut order (wave 8)

Cut from the top:

1. Mock extensions (`net/mock/*`).
2. Stall chat (P2), guild notice and titles, the alchemy announce line.
3. Mob summons (already off) and the ranged `AiHost.ranged?` special.
4. Horse sounds, parked-horse persistence (a relog dismisses the horse), the horse frame's Dismiss button (keep `/unsummon`).
5. Guild permissions beyond the master (only the master invites and kicks); the guild-name option row.
6. The hwan hair model (keep the aura).
7. Guilds, the whole system (the protocol stays; the stub module answers `not_implemented`; party chat covers group talk).
8. Stalls.
9. Horses.
10. Alchemy (keep `perPlus` in the formula).

**Never cut:** W8-F and W8-FC, monster skills (the user's "combat feels flat"), durability and repair, trade and the gate, Berserk (small), `role-policy.test.ts`.

---

## 7. Risks

1. **Mount points built one wave early (D1).** UI-H/UI-W build M1–M16 without their consumers. Mitigation: each has a unit test that exercises it like the consumer will; I7B checks each works with nothing registered; wave-8 lanes report a missing capability as a one-line request to the integrator instead of editing the UI file.
2. **The zoom commit** touches many style files at once. Mitigation: one commit, after FX-C2/FX-C3's `screens/world.ts` hunks, before UI-H/UI-W start; every drag/position path divides by `--ui` (H7B lens).
3. **FX-C1 builds the mob path before the server sends it (D4).** Mitigation: synthetic mob messages in 7B; MS-S's `mob-skill-view.test.ts` on the real rows in wave 8; the no-`skill` fallback keeps today's cycle.
4. **`screens/world.ts` and `hud/index.ts`** are edited by five 7B lanes. Mitigation: the merge order in §5.0; hunks anchored by quoted code; lanes use `WorldFeature` hooks and `ctx.addAttachment` wherever they can.
5. **The cart pack (D8).** The rider pose depends on loading a pack group skipped at startup; if `cart_walk` looks wrong at 9 m/s, MR-C loads `cart_run.ban` (COMBAT §1.2) or falls back to SIT on the saddle.
6. **The social gate** is a new cross-cutting veto; a bug blocks unrelated requests. Mitigation: allowlist table (§6.5), a throwing gate allows and logs, a test per locked type, H8's full matrix.
7. **Monster-skill balance.** Retail percents would make mobs 1.0–2.8× harder; `relative` keeps today's totals, but wind-ups and dodges change the feel of fights (COMBAT §2.6). I8 re-runs BALANCE; the Qin-Shi Tomb stays eased.
8. **N100 performance.** Trails, hit lights, ambient particles, drop sparkles, the level-up program (7B) and horses, auras and more entities (8). Each has a quality switch; W5-P's measurement method applies at I7B and I8.
9. **Font subsetter vs Chrome OTS.** Fallback Tahoma/Verdana (today's look).
10. **Deploy.** About 12 MB more UI PNG before `optimize-out`, new fx glbs, the horse and hair glbs; server and client deploy together (new enum values). Deploy with `pnpm run deploy` (assets with `-- --assets-only`); docs/DEPLOY.md.
11. **Shared Browser pane.** Several agents drive it; every browser check targets an explicit `tabId` (UI.md risk).
12. **Economy.** Alchemy at `ALCHEMY_RATE` 1.5, elixir drops at 0.8 % × `DROP_RATE`, guild creation at 10,000 gold, player trade and stalls moving gold between friends: watch in the first playtest.

---

## 8. Open questions (collected; each has a default so nobody waits)

| # | Question | Default |
|---|---|---|
| Q1 | Main window: retail tabs hide Inventory while Skills are shown | Retail tabs; Options → Interface "Separate windows" (off) (UI.md Q1) |
| Q2 | 48 bag slots in a 4×8 lattice | Pages of 32 with the spin control (UI.md Q2) |
| Q3 | Auto UI scale at 1920×1080 | 1.25; the user can pick 100 % (UI.md Q3) |
| Q4 | System messages: retail panel or the chat System tab | The chat tab; the panel off (UI.md Q4) |
| Q5 | Attack/talk/pick-up/repair cursors (no retail art) | The flame hand + small overlays (UI.md Q5, D21) |
| Q6 | Item name colours by rarity / +N / blue options | UI.md §4.8 values; revisit with alchemy (UI.md Q6) |
| Q7 | The 2009 underbar rects besides the EXP band | Measured by UI-H into `underbar-layout.ts` |
| Q8 | Which skilleffect the client reads (server_dep vs resinfo) | server_dep; `light` from resinfo (EFFECTS §7) |
| Q9 | Bone-anchored effects: caster facing or bone rotation (M17) | Yaw only; the lab shows both |
| Q10 | Trail length unit (80/120/160) | Milliseconds |
| Q11 | DamagePos frame | Victim-local |
| Q12 | Combat-stance (ATTREADY) timeout | 5 s |
| Q13 | Quest marks: DOM badges or retail `ex_mark_*.bsr` models | DOM badges this wave; models not in `PRESETS.fx` |
| Q14 | Selection circle colours; a click marker at all | 04 orange hostile, 02 green NPC/party, 03 blue player, 01 white item; the shrinking green marker |
| Q15 | When DAMAGE2 / REVIVAL / TURN play | Not played (cut item 4) |
| Q16 | Ground-item tint for someone else's item; drop yaw | Label class `owned` only; seeded yaw by entity id |
| Q17 | Tiger Girl rides `bluetiger.bsr`: how the rider attaches | Not drawn this wave |
| Q18 | Rider pose: `cart` clips on the `saddle` bone | Yes; fallback SIT on the saddle (COMBAT Q1) |
| Q19 | Alchemy byte order (big-endian per-plus percentages) | Big-endian; `ALCHEMY_RATE` 1.5 covers it |
| Q20 | Berserk duration, damage, speed, points per kill | 60 s, ×2, ×2, 12 % per normal kill (knobs) |
| Q21 | Durability wear rate; repair price formula | 5 % / 5 % / 10 %; `ceil(repairCost × missing / max)` |
| Q22 | `AI_AttackChance` meaning; col 67 | Weight on attack rows, HP band on SUMMON rows; col 67 unused |
| Q23 | Enchant glow per +N | Not wired |
| Q24 | Do mobs target a parked horse, or the rider | Rider; the ridden horse absorbs; parked horses ignored |
| Q25 | Elixir quest rewards (Act II–IV finales) | A request to the quest content owner; not in these waves |
| Q26 | Retail `_A` elixir drops from level-15+ mobs | Kept (port mapping), plus the authored 0.8 % |
| Q27 | Both Chulsan and Mrs Jang repair every item | Yes |
| Q28 | Retail exchange range, expiry, walking with the window open, unlock on partner change | 10 m, 30 s, any move cancels, always unlock |
| Q29 | Guild creation level and gold (retail: likely 20, 500,000) | 10 and 10,000 (knobs); ask the user |
| Q30 | Guild rejoin / recreate penalties | Off (knobs); ask the user |
| Q31 | Stalls outside towns | Town safe areas only (`STALL_TOWN_ONLY`) |
| Q32 | 10 stall slots | 10 [likely] |
| Q33 | Stall pose VENDOR01 or SIT; the wooden `booth.bms` | VENDOR01 with SIT fallback (the user checks by eye); no booth |
| Q34 | Guild name position on nameplates | A line above the name, `--c-guild-name` |
| Q35 | `emote` and `mountDismiss` allowed while trading | Yes (§6.5) |
| Q36 | Summon or ride while berserk | Refused `berserk_active` (D49) |
| Q37 | Emote while sitting | Stands up first |
| Q38 | A potion's `itemEffect` for a horse Recovery Kit | Sent with the horse's id (D52) |
| Q39 | Cause of the T-pose in select/create/world (UI.md A15) | FX-C2 investigates (D25) |
