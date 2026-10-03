# Wave plan 5: wave 11, "gameplay and screens"

This plan merges three fact-checked specs into one build order:

- **docs/MOVEMENT.md**: jump and dodge roll, with new animations keyed in Blender on the retail skeletons;
- **docs/SCREENS.md**: the real-time intro, the login and server-select backdrop, and character select and create on
  staged world scenes (the retail Constantinople spots, or Jangan);
- **docs/PETS_SOCIAL.md**: the item-pickup pet, the attack pets, the friends list with blocking, and mail with items
  and gold.

It does five things:

- it settles every place where the three specs touch the same file, name the same seam differently, or miss a seam
  that the code needs (§2);
- it merges their wire additions and the one database migration into one collision-free list (§3);
- it builds **seams first** (§4): three foundation agents put every cross-lane hook into the shared files, so the
  lanes own disjoint files;
- it gives the lanes, the merge order, the integration checklist and a **three-lens hunt** (movement exploits,
  economy and dupes through pets and mail, UI and flow) (§6–§8);
- it merges the scope-cut orders (§9), the needs from the user (§10), the risks (§11) and the open questions (§12).

When this plan and a spec disagree, **this plan wins**. The specs stay the detailed design of each lane; a lane reads
its spec sections and this plan's row for it.

**Tags.**

- **[confirmed]**: checked in the code or data at HEAD `85e2e14` (the check is named), or measured by a spec's
  prototype and re-checked by its fact-check.
- **[likely]**: strong evidence, not proven.
- **[projected]**: a cost scaled from a measurement, not measured on that hardware.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this plan makes.

D-numbers (D1…) in this plan are local to wave 11. Where a spec's text quotes an older plan's D-number (for example
the D25 `startUnblended` rule), it means that older plan.

**Repo state when this was written [confirmed: `git log`, `git status`, `ls docs`].**

- HEAD `85e2e14` ("Backlog: user-confirmed order: wave 10 sky + sea + new 3D trees, wave 11 gameplay and screens").
- The wave-9 release workflow has uncommitted edits. The ones this wave touches:
  - `apps/game/src/settings.ts`, `rollout.ts`, `screens/charselect.ts`, `screens/charcreate.ts`,
    `three/backdrop.ts`, `three/actor-textures.ts`, `three/remaster*.ts`, `deploy/config.sh`;
  - new untracked `three/studio-env.ts` and `studio-env.test.ts`.
- **Wave 10 is designed but not built.** docs/SKY2.md, docs/COAST.md and docs/TREES.md exist; docs/WAVE_PLAN4.md
  does not yet.
- Database schema **v9**: `db.ts` has 9 `MIGRATIONS`, and `SCHEMA_VERSION = MIGRATIONS.length`. **Wave 10 adds no
  migration**: a grep of COAST/SKY2/TREES for "migration", "MIGRATIONS" and "db.ts" finds nothing. So wave 11's one
  migration is **v10**.
- Protocol v1, additive. **No name any of the three specs adds exists today.** A script grepped `protocol.ts` for
  `t: '<name>'` for each of the 37 new message names (every name in §3.2 except the reused `itemUse`, whose change is
  a new field), and for each of the 12 new fail reasons: 0 hits. `gm.ts` has 26 commands and none is named `pet`,
  `pets`, `mail` or `friends`.
- Line numbers drift: **every hook is found by its quoted code, not its line number.**

---

## 0. Summary

1. **One wave, three parts, one foundation.** The specs proposed seven seam lanes between them:
   - MOVEMENT's one seams agent;
   - SCREENS' SCR-P and SCR-S;
   - PETS_SOCIAL's PS-P, PS-FS and PS-FC.

   This plan replaces them with **three foundation agents** (D1):
   - **W11-P**: shared protocol, validators, content types, the mocks and the fail-reason strings;
   - **W11-FS**: every server seam and the v10 migration;
   - **W11-FC**: every client seam.

   After them, the lanes own disjoint files.
2. **The fact-checks moved several seams, and this plan's own check found five more.** They are all server or client
   gaps that only appear once the three parts are read together (§2.1):
   - pets need `World.walkEntity` to accept a `Cos`, and `World.tick` to finish arrivals for unridden `Cos`
     [confirmed: both are `Player | Mob` today];
   - mob skills must be able to target a pet [confirmed: `MobSkills.swing/strike/rollHits/land` take a `Player`], in
     the same function where the roll's `evading()` check goes;
   - the i18n files register in `en.ts`, not `i18n/index.ts` [confirmed];
   - the 12 new fail reasons need their text lines in the same step that adds them, or `hud.test.ts` fails
     [confirmed: `hud.test.ts` "has a line for every refusal reason"].
3. **Protocol (§3):** protocol stays v1, and every addition is additive.
   - Movement: 2 requests (`jump`, `roll`), 1 event (`jump`), `MoveState.style`.
   - Screens: `ServerInfo.clock`/`weather`.
   - Pets and social: 19 requests, 16 server messages, 2 `EntityState` fields, `itemUse.pet`, 12 fail reasons, 4 GM
     commands and 2 CLI verbs.
   - One migration, **v10**: 7 tables plus a column.

   Server and client deploy together (new fail reasons).
4. **No new 3D models in wave 11.** The user's relayed line "New 3D models for TREE'S only for time being" is
   wave 10's (docs/TREES.md), as BACKLOG already routes it [confirmed]. Wave 11 keeps to it (D21):
   - pets use their retail models and clips;
   - the stages use retail or Jangan scenery;
   - the movement work is **animation** on the retail skeletons, not geometry.
5. **Budgets (§5):**
   - **Movement** costs no GPU. With 20 actors jumping without a break it costs +0.47 ms p95, or +0.70 ms p95 with
     the arm layer [confirmed: MOVEMENT's NullEngine bench].
   - **Pets** are the only new per-frame cost of note: 0.115–0.30 ms per pet at Medium WebGPU [projected]. Other
     players' pets are therefore capped per preset at Low / Medium / High / Ultra = **4 / 4 / 2 / 12** (D33; PETS §0
     item 9 still says 4 / 4 / 4 / 12, which is stale).
   - **Outer screens** are separate scenes, measured at 4.1–4.5 ms p95 CPU on the dev PC [confirmed: SCREENS pass 2].
   - The whole-game gate is Medium < 16.7 ms p95 in the crowd with pets at the cap and 5 jumping bots, on both APIs.
     It is projected at 15.2–16.4 ms on WebGPU: it passes, but narrowly. The pet cap, which is config, is the lever.
6. **Two release points** (D34), each deployed only on the user's go:
   - **R1** = movement + pets, friends and mail (the migration v10);
   - **R2** = screens, which wait on wave 10's re-export and on stage A's data.
7. **Never cut** (§9):
   - server authority for the roll;
   - the lock rules;
   - real scenery behind every outer screen;
   - the pet roster model and the exact party-loot rule for the pickup pet;
   - mail with items and gold in conditional immediate transactions;
   - the v10 migration and its upgrade test;
   - the conservation fuzz;
   - the Low guard.

### 0.1 Where each user request lands

The user's order (verbatim): *"Gameplay and screens: Jump and dodge roll, with new animations made in Blender. The
proper intro, login scene, and retail character select/create scenes. Things SRO has that we haven't built: the
item-pickup pet, attack pets, and a friends list and mail."* Relayed alongside: *"as well as New 3D models for TREE'S
only for time being."*

| User request | Where | Lanes |
|---|---|---|
| Jump and dodge roll | MOVEMENT §4 | W11-P/FS/FC seams, MV-P, MV-C |
| "with new animations made in Blender" | MOVEMENT §2–§3 (route A: hand-keyed bpy scripts, prototyped) | MV-A |
| The proper intro | SCREENS §5.1: a 25 s real-time flight over Jangan (retail has no movie [confirmed]) | SCR-R, SCR-I |
| Login scene | SCREENS §5.2: a slow Jangan drift that replaces the wave-1 placeholder plaza | SCR-L |
| Retail character select / create scenes | SCREENS §1.4, §6: the `cameradata.txt` spots in Constantinople (stage A), with Jangan (stage B) as the fallback | SCR-X, SCR-R, SCR-SEL, SCR-CRE, SCR-E |
| Item-pickup pet, attack pets | PETS_SOCIAL §2 | PS-X, PET-S, PET-C |
| Friends list | PETS_SOCIAL §3 | FR-S, CM-C |
| Mail | PETS_SOCIAL §4 | ML-S, CM-C |
| "New 3D models for TREE'S only for time being" | **wave 10** (docs/TREES.md, BACKLOG "Next") [confirmed]; wave 11 adds no geometry (D21); the intro's shot 1 and stage B frame the new trees (D17) | — |

---

## 1. Lane ids

| Id | Step | From spec | What |
|---|---|---|---|
| W11-P | 0 | MOVEMENT seams (protocol part), SCR-P (shared part), PS-P | Shared protocol, `movement.ts`, validators, content types, mocks, `en-fail-w11.ts`, PROTOCOL.md |
| MV-A | 0 → 2 | MOVEMENT MV-A | Blender pipeline and the 6 clips (data; starts at once, no code dependency) |
| SCR-X | 0 (after wave 10's converter) | SCREENS SCR-X | Stage A export `stage-cs` and `--keep-within` |
| W11-FS | 1 | MOVEMENT server seams, SCR-P (server part), PS-FS | Every server seam, the v10 migration, `Store.immediate` |
| W11-FC | 1 | MOVEMENT client seams (reduced, D9), SCR-S, PS-FC | Every client seam |
| PS-X | 1 | PETS PS-X | Converter: pet families, pet items, shop tabs, cues, UI row; the data runs |
| MV-P | 2 | MOVEMENT MV-P (server module only) | `apps/server/src/movement.ts` |
| MV-C | 2 | MOVEMENT MV-C | Client movement |
| PET-S, FR-S, ML-S | 2 | PETS | Server pets, friends, mail |
| PET-C, CM-C | 2 | PETS | Client pets; community pages |
| SCR-R, SCR-E | 2 | SCREENS | Stage runtime; the viewer stage editor |
| SCR-I, SCR-L, SCR-SEL, SCR-CRE | 3 | SCREENS | Intro; login and servers; select; create |
| MV-L | 3, optional | MOVEMENT MV-L | Viewer lists the movement clips |
| I11 | 4 | I11-MV + I-SCR + I11S | Integration (one agent) |
| H11-M, H11-E, H11-U | 4 | the three specs' hunt lenses, merged | Hunts: movement exploits; economy and dupes; UI and flow |

**Dropped ids:**

- **SCR-P**: split between W11-P and W11-FS (D19).
- **SCR-S**: now in W11-FC.
- **PS-P, PS-FS, PS-FC**: now W11-P, W11-FS and W11-FC.
- **I11-MV, I-SCR, I11S**: merged into I11.
- **H-SCR, H11S**: merged into the three H11 hunts.

---

## 2. Conflicts and gaps across the specs, with decisions

### 2.1 Architecture and file ownership

| # | Topic | Specs | Problem | Decision |
|---|---|---|---|---|
| D1 | Seam agents | MOVEMENT §8.1 (one seams agent); SCREENS §12.2 (SCR-P, SCR-S); PETS §11.0 (PS-P, then PS-FS + PS-FC) | Seven agents would edit `protocol.ts`, `validate.ts`, `gameplay.ts`, `world.ts`, `alchemy.ts`, `en.ts` and `features.ts` in parallel. All three specs ask the wave plan to merge them. | **W11-P** (step 0, one agent) owns every shared-package edit plus the client mocks and the fail-reason strings. **W11-FS** and **W11-FC** (step 1, in parallel: server and client files are disjoint) own every server and client seam. After step 1, **no lane edits** any file in §4's three tables. The one exception is MV-C's own edits to `three/models.ts` and `world/entities.ts` (D9). |
| D2 | `packages/shared/src/{protocol,validate,content,index}.ts` | all three | Three additive lists in one union | **W11-P** writes §3 in full. It also writes `packages/shared/src/movement.ts` **complete** (pure constants and `rollDir`/`rollTarget`, MOVEMENT §5), so MV-P does not touch shared code. |
| D3 | `gameplay.ts` module list | MV-P (Movement), PETS (Pets, Friends, Mail after `guilds`, before `weather`) | Two registrations in one array; registration order = enter-world, hook and gate order [confirmed: the comment above `this.modules`] | **One edit by W11-FS:** `… this.trade, this.stalls, this.guilds, this.movement, this.pets, this.friends, this.mail, this.weather`. Movement sends nothing on `enter`. `askGates` returns the first veto and skips the module that handles the request [confirmed: `modules.ts askGates`], so Movement's position only decides which refusal text wins when two gates refuse. Pets, Friends and Mail keep PETS' enter order (`… guild → pets → friends → mailCount → weather`, §3.6). |
| D4 | `world.ts` | MV-P (`walkEntity` gains `style`, `startDelayMs`); PETS (`Cos` gains `role`, `petId`, `petName`, `combat`; the `EntityState` decorator) | Same class, and two **gaps** in PETS' seam list [confirmed]: (a) `walkEntity(p: Player \| Mob, …)`, so a pet cannot walk; (b) `World.tick` calls `arrive()` only for `players` and `mobs`, so a walking pet would never get its `stop` or stand at its end point | **W11-FS, one edit.** `walkEntity(p: Player \| Mob \| Cos, x, z, speed, now, opts?: { style?: 'roll'; startDelayMs?: number })` (`startedAt = now + startDelayMs`; `style` rides the existing `{ ...p.move }` spreads). `tick` also runs `arrive(c)` for every `Cos` with `rider === null` and a move. A ridden horse shares its rider's move object [confirmed: `mounts.ts` `c.move = rider.move`] and is skipped. The `Cos` fields and the `EntityState.pet`/`petName` decorator as PETS §8.2. |
| D5 | `mob-skills.ts` | MV-P (`evading()` in `strike`, MOVEMENT fact-check); PETS (mobs fight back against pets, §2.3) | PETS §8.2 widens `ai.ts` and `gameplay.ts` only. But every mob swing with attack rows goes `Gameplay.swing` → `MobSkills.swing(m, target: Player)` → `strike(…, primary: Player, …)` → `rollHits(…, t: Player)` → `land(…, t: Player)` [confirmed: signatures]. **A mob could not swing at a pet at all.** | **W11-FS, one edit.** `swing`, `strike`, `rollHits` and `land` take `Player \| Cos` as the primary. AoE secondaries stay players (`playersNear`). Status rolls are skipped for a `Cos` (pets take no statuses in v1, PETS Q12). The `evading(p, now)` call is made only when the target is a `Player` (a stub that returns false until MV-P). The `rows.length === 0` fallback `g.attack(m, target)` widens with `Gameplay.attack` (PETS §2.3). |
| D6 | `alchemy.ts` | MV-P (`FUSE_CANCELLERS += 'jump'`); PETS (`FUSE_LOCKED += mailSend, mailTake, petItem`) | Two one-line edits in one file | **W11-FS**, both. **`'roll'` is not added** [decision]: the roll cancels a fuse only through `onMoveTo` at its step 3, after the dry run. So a roll refused as `unreachable` leaves the fuse alone. A jump cancels a fuse even when the jump is then refused (MOVEMENT Q12, accepted). |
| D7 | `mounts.ts` | MV-P (`MOUNTED_REFUSED += jump, roll`); PETS (nothing: the kit keeps `target: 'mount'`) | — | **W11-FS**: the one list edit. |
| D8 | `connection.ts` | MV-P (pass `msg.x, msg.z` to `onMoveTo`); PETS (the enter-world order "if not module-driven") | — | **W11-FS**: only `gameplay.onMoveTo(this.player, now, { x: msg.x, z: msg.z })`. Enter-world **is** module-driven (`this.hook('enter', p, now)` in registration order [confirmed: `gameplay.ts`]), so pets need no `connection.ts` edit. |
| D9 | `three/models.ts`, `world/entities.ts` | MOVEMENT (movement pack, `KEEP_CLIPS`, `playMove`, arm layer; the roll-style branch, jump echo); SCREENS (guessed "screens edit models.ts"); PETS (first draft: pet dispatch) | MOVEMENT asked for empty hooks here so other wave-11 lanes could merge | **MV-C is the only wave-11 editor of both files.** SCREENS does not edit `models.ts` (POSE/STAND3/WALK already pass `KEEP_CLIPS` [confirmed: SCREENS §6.1]). The pet view dispatches in `world/mount-view.ts` (PETS fact-check). So W11-FC **does not** add MOVEMENT's empty `playMove`/`movementClip` hooks or the `entities.ts` branch; MV-C writes them directly. |
| D10 | i18n registration and the fail-reason lines | MOVEMENT (MV-C edits `i18n/index.ts`); PETS (PS-FC registers `en-pets/friends/mail` in `i18n/index.ts`); SCREENS (SCR-S edits `en.ts`) | (a) Feature string files are imported and spread in **`i18n/en.ts`**, not `index.ts` [confirmed: `en.ts` imports `enWeather`, `enSky`, …; `index.ts` only imports `en`]. (b) `apps/game/test/hud.test.ts` asserts a non-generic `action.fail.<reason>` line for **every** `ACTION_FAIL_REASONS` entry [confirmed], so the 12 new reasons break the suite the moment W11-P adds them | **W11-P** writes `i18n/en-fail-w11.ts` (all 12 lines, retail wording where PETS lists it) and its import and spread in `en.ts`, in the same change as the reasons. **W11-FC** (later, sequential) adds `en-movement.ts`, `en-screens.ts` (SCREENS §8 keys; a file of its own instead of editing `en.ts` directly), `en-pets.ts`, `en-friends.ts`, `en-mail.ts` and their spreads. After W11-FC, lanes edit only their own `en-*.ts`. |
| D11 | `settings.ts` | SCR-S (`ui.intro`, `ui.introSeen`); PETS ("Hide other players' pets" row) | The release in flight is editing `settings.ts` now [confirmed: `git status`] | **W11-FC, after the release commits:** `ui.intro: 'first' \| 'always' \| 'never'` (default `'first'`), `ui.introSeen: boolean`, and `ui.hideOtherPets: boolean` (default false), each normalised like `ui.reduceFlashing` with old saves tested. No lane edits `settings.ts` afterwards. |
| D12 | `hud/options.ts` | SCREENS (the intro row), PETS (PS-FC owns "one row", on a "Game page") | **There is no Game page**: `OptionsTab` is `graphics \| interface \| controls \| audio` [confirmed: `hud/options.ts` `registered`] | **Nobody edits `hud/options.ts`.** Both rows go through `registerOptionRow('interface', …)` from the lane's own file, the GU-C/WX-C precedent [confirmed: `features/guild.ts`, `features/weather.ts`]: SCR-I registers "Play the intro" from `screens/intro.ts`; PET-C registers "Hide other players' pets" from `world/features/pets.ts`. |
| D13 | Mocks | MV-P edits `net/mock.ts` and `net/mock/*`; PS-P adds `net/mock/{pets,friends,mail}.ts` | Two lanes on the mock | **W11-P** writes four per-feature mocks, `net/mock/{movement,pets,friends,mail}.ts`, and their lines in `net/mock/index.ts` `DEFAULT_MOCK_EXTENSIONS` [confirmed pattern: 9 existing lane mocks]. The core `net/mock.ts` is untouched: an extension's `handle` sees every validated message [confirmed: `mock.ts` comment on `MockExtension`]. The mock sends no `ServerInfo.clock` (stages use their fallback, SCREENS §9). |
| D14 | `world/features.ts` | MV-C (register `movementFeature`), PETS (`petsFeature`, `communityFeature`) | One list | **W11-FC** registers all three as no-op stubs from their own files (`features/movement.ts`, `features/pets.ts`, `features/community.ts`). The lanes then own those files. |
| D15 | Menubar and the community window | PETS (a letter icon with the unread count; the guild window becomes the community host; the menubar item is renamed "Community") | `MenuBarEntry` has no badge field [confirmed: `hud/menubar.ts`] | **W11-FC:** `MenuBarEntry.badge?: () => number`; the `registerCommunityPage` registry in `hud/guild.ts` (Guild and Notice unchanged); the label change in `world/features/guild.ts` (key U stays); `hudAnchors().petColumn` in `hud/hud-layout.ts`; the `cos` factory dispatch plus `registerPetView` in `world/mount-view.ts` (PETS fact-check: `registerEntityKind` keeps one factory per kind [confirmed]). |
| D16 | The Blender tooling home | MOVEMENT (`packages/convert/tools/blender/moves/`, next to COAST's CST-B); wave 10 has **two** homes itself: COAST CST-B `packages/convert/tools/blender/*.py`, TREES TR-A `packages/convert/src/trees/blender/*.py`, and both add `blenderExe` to `SroConfig` in `node-io.ts` [confirmed: COAST.md lane table, TREES.md F17] | Three proposals | **MV-A follows the home WAVE_PLAN4 settles.** Default: `packages/convert/tools/blender/moves/`, reading `SroConfig.blenderExe`. If wave 10 has not landed the key when MV-A starts, MV-A adds it with the same name and default (the standard 5.2 install path), in `node-io.ts` and `sro.config.example.json`. |
| D17 | Wave-10 hand-offs | SCREENS §12.10, MOVEMENT §2.2 | Wave 11 builds on wave 10's output | **Entry criterion: wave 10 is integrated.** SCR-X rebases on CST-C's `convert-world.ts`/`cli.ts`. SCR-E authors the intro and stage-B keys on the **re-exported** `jangan-fields` (coast, new trees). Shot 1 and stage B frame the new trees; if trees slip, they use today's trees. I11 **re-measures the budget baseline** on the post-wave-10 build before any lane gate (TREES gates the trees at CPU ≤ +0; SKY2 at +0.03–0.07 ms CPU [confirmed: their budget tables]). |
| D18 | The wave-9 release in flight | SCREENS §12.2 fact-check | It edits `settings.ts`, `screens/charselect.ts`, `screens/charcreate.ts` and `three/backdrop.ts`, and adds `three/studio-env.ts` | W11-FC, SCR-SEL, SCR-CRE and I11's deletions start **only after the release is committed**, and re-read those files then. SCR-SEL/SCR-CRE drop the `StudioEnvironment` call on the stage path; I11 deletes `studio-env.ts` and its test if nothing else imports them. |
| D19 | `ServerInfo.clock/weather` | SCR-P (shared + server + tests) | One lane across two foundation areas | The shared part (types, `serverInfo()` validator with `optionalField` + `clockState`/`weatherSync`) goes to **W11-P**. The server fill in `game.ts` `serverInfo()`, which feeds both `GET /api/servers` and the lobby `welcome` [confirmed: SCREENS fact-check], goes to **W11-FS**. The tests move with them. |
| D20 | Immediate transactions | PETS §4.1, §6.2 (ML-S and PET-S both need `.immediate()` and `SQLITE_BUSY*` → `busy`) | Two lanes would write the same helper | **W11-FS** adds `Store.immediate<T>(fn: () => T): T` (better-sqlite3 `db.transaction(fn).immediate()`), which throws a typed `BusyError` on `SQLITE_BUSY*`, plus a helper that answers `fail('busy')` for it. PETS' prototype showed that the deferred form throws `SQLITE_BUSY_SNAPSHOT` against a second connection [confirmed: `work/tmp/pets-social/busy-snapshot.ts`]. |
| D21 | The relayed "new 3D models for trees only" | all three (each routed it to wave 10) | — | **No new geometry in wave 11** [decision, following the user's line]. Pets use their retail BSRs (PS-X). The Blender work is animation keys on the retail skeletons, with only our JSON deltas committed (MOVEMENT §2.2). Stage A is retail Constantinople; stage B is Jangan. Pet textures may join a later B4 upscale batch (PETS N8). |

### 2.2 Where the parts meet at run time

| # | Topic | Decision |
|---|---|---|
| D22 | Roll and pets | A roll runs `g.onMoveTo`, which fans out `moved` [confirmed: MOVEMENT §4.3 step 3]. A following pet re-plans on its own cadence: owner more than 3 m from the pet's goal, at most every 500 ms (PETS §2.2). It reads the owner's live point, which holds at `from` during the wind-up because `livePoint` clamps elapsed time at 0 [confirmed: MOVEMENT §4.1]. Nothing collides, so a pet never blocks a roll (MOVEMENT Q3). |
| D23 | Requests during a roll | Movement's busy list stays MOVEMENT's: `attack`, `useSkill`, `pickup`, `npcTalk`, `mountRide`, `sit`, and its own `jump`/`roll`. **Pet, friend and mail requests are allowed during a roll** [decision]: they are window actions, and each has its own checks (`mailSend`/`mailTake` need town, `petSummon` refuses a skill cast). `petAttack` during a roll is allowed: it orders the pet, not the owner. |
| D24 | Invulnerability frames and pets | `Movement.evading()` guards **players only** (D5). A mob skill on a pet never becomes `miss` because of a roll. |
| D25 | Pet moves carry no style | Pets walk with `walkEntity(…)` without `opts`. `MoveState.style` is only ever `'roll'` on a player. The validator drops any other value (MOVEMENT §5). |
| D26 | The pickup pet and the Auto Looting key | Both take ground items through `pickUpFor` / `pickUp` on a single-threaded server, and a ground item is removed after its commit [confirmed: PETS §2.5]. The roll's busy list refuses the **hand** `pickup` during a roll; the pet's grab is not a request and continues. |
| D27 | Movement clips on the stages | The movement pack loads with the `default` pack wherever an actor is built, so the select and create stages fetch it too: ≤ ~55 KB per skeleton [projected, MOVEMENT §7], cached for the world. Select keeps `POSE`/`STAND3`. There is no jump button on the stages (§12 PQ5). |
| D28 | Pets on the character stages | Not in this wave (SCREENS §12.4). |
| D29 | `ServerInfo` in `welcome` | The lobby socket gets one clock snapshot in `welcome` but never the `worldClock` message. `world-clock.test.ts` (lobby sockets get no `worldClock`) stays green [confirmed: SCREENS §9]. A bad clock drops only the clock, never the `welcome`. |
| D30 | Fail reasons | Only PETS adds reasons (12, §3.4). MOVEMENT and SCREENS reuse existing ones. `pet_active` ("Cannot summon a pet any more.") stays separate from the existing `cos_active` ("You already have a horse." [confirmed: `en-fail-w8.ts`]): the texts differ, and a player may have a horse and a pet out together. |
| D31 | Chat commands | The client registers `/friend`, `/f` and `/mute` (CM-C, via `ChatBox.registerPrefix`). Checks [confirmed]: no existing prefix user takes those words (`registerPrefix` users: `@`, `/g`, `/guild`, `/join`, the mount, posture, emote and stall commands, `/trade`, `/exchange`, `#`, `/w`, `/whisper`, `/r`, `/re`, `/reply`); none equals one of the 26 GM command names; `matchPrefix` needs a space or the end of the line after `/friend`, so the GM `/friends <char>` is not caught. **Nobody registers `/pet`** (it would swallow the GM `/pet`, PETS fact-check). Movement adds no chat command. |
| D32 | Keys | Space = jump and V = roll (MV-C) [confirmed free: MOVEMENT §6.3]. Insert / PgUp / Del are the pet command bar keys, registered only while a pet is summoned (PET-C) [confirmed free: no registration uses them]. PgUp is also in `WIDGET_KEYS`, so a focused kit slider or list keeps it [confirmed: `hud/keys.ts`]. U stays the Community window (was Guild). The "Space on a focused button" risk is MV-C's (MOVEMENT §6.3). |
| D33 | Pet caps and the combined frame budget | Other players' pets drawn: Low / Medium / High / Ultra = **4 / 4 / 2 / 12**, with ranges 40 / 50 / 60 / 80 m (PETS §10 and N7). PETS §0 item 9 still says 4 / 4 / 4 / 12; that line is stale, §10 wins. The caps live in one client table (`PET_DRAW_CAPS`, PET-C). They are the first lever if the whole-game gate (§5.3) misses: Medium goes to 2 before any feature is cut. |
| D34 | Release points | **R1** = movement + pets, friends and mail: server, client, migration v10, the PS-X data and the MV-A packs. **R2** = screens: the stage runtime, the intro, the outer screens and the `stage-cs` pack. Each needs the user's go (the wave-9 precedent). R2 waits on wave 10's re-export (D17) and on SCR-X's data; R1 does not. If both are ready together they ship together. |
| D35 | Deploying a schema change | A v9 server refuses a v10 database (`migrate()` throws "database schema v… is newer than this server" [confirmed: `db.ts`]). So there is no rollback to R0 without the backup. **Before R1: copy the live database file while the server is stopped** (DEPLOY.md gets the step). H11-E runs the v9 → v10 upgrade on a read-only copy of the live file, never the live file (PETS H11S). |

### 2.3 Corrections to the specs found by this plan

| Spec | Says | Correction [confirmed: how] |
|---|---|---|
| PETS §8.2 (`world.ts` row) | Only `Cos` fields and the decorator | `walkEntity` must accept a `Cos`, and `World.tick` must run `arrive()` for unridden `Cos` (D4) [`world.ts` `walkEntity(p: Player \| Mob, …)`, `tick` loops over `players` and `mobs` only] |
| PETS §8.2 (seam list) | `ai.ts` and `gameplay.ts` widen to `Cos` | `mob-skills.ts` must widen too (D5) [`MobSkills.swing(m, target: Player, now)`, `strike(…, primary: Player, …)`] |
| PETS §8.5, §11.1 PS-FC; MOVEMENT §8.1 MV-C | Register the string files in `i18n/index.ts` | `en.ts` imports and spreads them (D10) [`en.ts`, `index.ts`] |
| PETS §5.7 | New reasons, strings in the lanes | The 12 lines must land with the reasons (W11-P), or `hud.test.ts` fails (D10) [`hud.test.ts` "has a line for every refusal reason"] |
| PETS §8.5 | Options row on the "Game page"; PS-FC owns `hud/options.ts` | There is no Game page; the row goes on Interface via `registerOptionRow` (D12) [`OptionsTab`] |
| PETS §8.5 | `hud/menubar.ts`: a letter icon with the count | Needs a new `badge` field on `MenuBarEntry` (D15) [`MenuBarEntry` has none] |
| PETS §0 item 9 | Pet caps 4 / 4 / 4 / 12 | 4 / 4 / 2 / 12 as in §10 and N7 (D33) [the doc's own §10] |
| MOVEMENT §8.1 | `net/mock.ts` + `net/mock/*` | A per-feature `net/mock/movement.ts` only (D13) |
| MOVEMENT §8.1 | Seams-first adds empty hooks in `models.ts` and `entities.ts` | Unneeded: MV-C is the only wave-11 editor of both (D9) |
| SCREENS §12.2 | "MOVEMENT and PETS_SOCIAL also add to `app.ts`, `en.ts`, `settings.ts`" | Neither edits `app.ts`. Only this plan's `ui.hideOtherPets` joins `settings.ts` (D11). Both add string files through `en.ts` (D10) |

---

## 3. Unified protocol additions and the migration (protocol v1, additive)

W11-P lands §3.1–§3.5. W11-FS lands §3.6–§3.8.

### 3.1 New shared module `packages/shared/src/movement.ts` (pure; W11-P writes it complete)

```ts
export const JUMP_COOLDOWN_MS = 1000
export const ROLL_DISTANCE_M = 4
export const ROLL_WINDUP_MS = 100
export const ROLL_TRAVEL_MS = 600
export const ROLL_SPEED = ROLL_DISTANCE_M / (ROLL_TRAVEL_MS / 1000)   // 6.67 m/s
export const ROLL_RECOVER_MS = 150
export const ROLL_COOLDOWN_MS = 3000
export const ROLL_MIN_M = 0.5
export function rollDir(yaw: number): [number, number]                 // yaw 0 = +Z (yawTowards convention)
export function rollTarget(x: number, z: number, yaw: number, dist?: number): [number, number]
```

### 3.2 `protocol.ts` additions

```ts
// ---- wave 11 (docs/WAVE_PLAN5.md §3) ----
// SCREENS §9
export interface ServerInfo { /* … */ clock?: WorldClockState; weather?: WeatherSync }
// MOVEMENT §5
export interface MoveState { /* … */ style?: 'roll' }                 // absent = walk/run; older clients drop it
// PETS §5.3
export interface EntityState { /* … */ pet?: PetKind; petName?: string } // kind 'cos' only
// PETS §5.1: PET_ROSTER_MAX 4, PET_NAME, PET_BAG_MAX 140, PET_HGP_MAX 10_000, FRIEND_MAX 50, BLOCK_MAX 100,
//   FRIEND_REQUEST_MS 30_000, MAIL_ITEMS_MAX 5, MAIL_SUBJECT_MAX 32, MAIL_BODY_MAX 300, MAILBOX_MAX 50,
//   MAILBOX_LIST_MAX 100; PetKind, PetMode, PetLife, PetGrab, PetState, PetSlot, FriendEntry, BlockEntry,
//   MailHeader, MailFull — verbatim from PETS_SOCIAL §5.1.
```

**Client → server** (every one a `GameplayRequest`, answered by exactly one `actionResult`):

| Message | Part | Notes |
|---|---|---|
| `{ t: 'jump' }` | movement | cosmetic; the server position never changes |
| `{ t: 'roll'; yaw: number }` | movement | yaw finite, normalised to (−π, π], else `error bad_request`; the server picks the endpoint |
| `{ t: 'itemUse'; bag: number; pet?: number }` | pets | **additive field** on an existing request |
| `petSummon`, `petDismiss`, `petMode`, `petAttack`, `petGrab`, `petName`, `petRelease`, `petItem` | pets | PETS §5.2 shapes |
| `friendRequest`, `friendRespond`, `friendRemove`, `blockAdd`, `blockRemove` | friends | PETS §5.2 |
| `mailList`, `mailRead`, `mailSend`, `mailTake`, `mailDelete`, `mailReport` | mail | PETS §5.2 (`mailSend.items` ≤ 5, distinct bag slots) |

Lists: `GAMEPLAY_REQUESTS` gains `'jump'`, `'roll'` and `...PET_REQUESTS`, `...FRIEND_REQUESTS`, `...MAIL_REQUESTS`
(new exported lists).

**Server → client:**

| Message | Part | Sent |
|---|---|---|
| `{ t: 'jump'; id: number; at: number }` | movement | to every viewer, the jumper included (`broadcastAbout`, the `emote` precedent); a client `jump` next to a server `jump` follows the `emote` precedent |
| `pets`, `petUpdate`, `petBag`, `petBagUpdate`, `petEvent` | pets | PETS §5.3 |
| `friends`, `friendAsked`, `friendUpdate`, `friendRemoved`, `blockUpdate`, `friendEvent` | friends | PETS §5.3 |
| `mailCount`, `mailbox` (`mails` ≤ `MAILBOX_LIST_MAX`, plus `total`, `cap`), `mail`, `mailNew`, `mailRemoved` | mail | PETS §5.3 |

- A roll is **not** a new server message. It is an ordinary `move` with `style: 'roll'`, `startedAt = now + 100`
  and speed 6.67, followed by the usual `stop`.
- Late joiners get it through `EntityState.move`, because `baseState` spreads `p.move` [confirmed: MOVEMENT §4.3].
- `combat.attacker` may be a pet's `cos` id (PETS §5.3).

### 3.3 `content.ts` additions (PETS §5.4)

- `ItemUse`:
  - `pet?: string` and `petKind?`: the family code this item adopts;
  - `hgp?: number`: the HGP potion;
  - `revive?: number`: Grass of Life, as an HP fraction.
  - `target` stays `'mount'` for the Recovery Kits.
- `CosDef`:
  - `role?: 'ride' | 'attack' | 'pickup'` (absent = ride);
  - `levels?: CosLevel[]`;
  - `bag?: number`.

### 3.4 Validators, rate limits, fail reasons (`validate.ts`, `protocol.ts`)

- **Validators.**
  - `moveState()` rebuilds the object from its fields [confirmed: MOVEMENT §5], so the `style` pass-through is added
    there. It covers `move` and `EntityState.move` alike, and an unknown style drops the field but keeps the move.
  - The entity parser gains `pet` and `petName`. The server-to-client parser drops unknown keys [confirmed: PETS
    §5.3], so without them a pet would arrive as a plain horse.
  - `serverInfo()` parses `clock` and `weather` through `optionalField` + `clockState` / `weatherSync`, so a bad
    value drops only that field (D19).
  - `mailbox.mails` is bounded by `MAILBOX_LIST_MAX` (100), not by `MAILBOX_MAX`.
  - Every pets/social shape is checked as in PETS §5.2 and §5.3.
- **`CLIENT_RATE_LIMITS`** (per second / burst):

  | Types | Rate |
  |---|---|
  | `jump`, `roll` | 2 / 3 |
  | `mailSend`, `friendRequest`, `blockAdd`, `petName`, `petRelease`, `mailReport` | 1 / 3 |
  | `petSummon`, `petDismiss`, `friendRespond`, `friendRemove`, `blockRemove`, `mailTake`, `mailDelete`, `petGrab`, `petMode` | 2 / 5 |
  | `mailList`, `mailRead`, `petAttack` | 4 / 8 |
  | `petItem` | 10 / 20 |

  A per-type refusal is `rate_limited`, never a strike [confirmed: MOVEMENT §4.2].
- **New `ActionFailReason` values (12, PETS §5.7):** `pet_active`, `pet_dead`, `pet_level`, `pet_full`,
  `pet_not_empty`, `blocked`, `friend_full`, `already_friend`, `mailbox_full`, `mail_refused`, `mail_attachments`,
  `muted`.
  - Their English lines go in `apps/game/src/i18n/en-fail-w11.ts` (D10).
  - Movement and screens reuse `dead`, `cant_act`, `busy`, `cooldown`, `unreachable`, `mounted`, `stalling` and
    `trading`.
  - `bad_request` is an `ErrorCode`, never an action answer [confirmed: PETS fact-check].

### 3.5 Request routing: whileDead, gates and locks (one table for the whole wave)

| Request | whileDead | Trade (`TRADE_ALLOWED`) | Stall (`STALL_ALLOWED`) | Mounted (`MOUNTED_REFUSED`) | Alchemy | During a roll (Movement gate) |
|---|---|---|---|---|---|---|
| `jump` | no (`dead`) | refused `trading` | refused `stalling` | refused `mounted` | `FUSE_CANCELLERS` (cancels) | refused `busy` inside Movement's `request` |
| `roll` | no | refused | refused | refused | cancels only through `onMoveTo` (D6) | refused `busy` |
| `petDismiss`, `petGrab`, `petMode`, `petName` | yes | allowed | allowed | allowed | — | allowed |
| `petRelease` | yes | refused | refused | allowed | — | allowed |
| `petSummon`, `petAttack` | no | refused | refused | allowed (PETS Q11) | — | allowed (D23) |
| `petItem` | no | refused | refused | allowed | `FUSE_LOCKED` | allowed |
| `friendRequest`, `friendRespond`, `friendRemove`, `blockAdd`, `blockRemove` | yes | allowed | allowed | allowed | — | allowed |
| `mailList`, `mailRead`, `mailDelete`, `mailReport` | yes | allowed | allowed | allowed | — | allowed |
| `mailSend`, `mailTake` | no | refused | refused | allowed | `FUSE_LOCKED` | allowed |
| `itemUse` (+`pet`) | as today | as today | as today | as today | as today | allowed |
| `moveTo` (not a request) | — | ends the trade (`moved`) | refused (stall owner) | — | cancels | **deferred** (`deferMove` before the gates, MOVEMENT §4.3) |

- The **allowlist guard test** (W11-FS) enumerates `GAMEPLAY_REQUESTS` and asserts two things. Every new type is
  either in both allowlists or refused while trading and stalling. Every new bag-changing type is in `FUSE_LOCKED`,
  which is a denylist and so locks nothing by default [confirmed: PETS fact-check].
- The whileDead entries above must each be in their module's `handles`. `modules.ts` throws otherwise [confirmed:
  `whileDead ${t} is not in its handles`].

### 3.6 Enter-world order and GM

- **Enter order:** `… party → guild → pets → friends → mailCount → weather`. It is driven by module registration
  (D3). Movement sends nothing at enter.
- **GM commands** (`gm.ts` `COMMANDS`, audited, all matching `/^[a-z]{1,16}$/`):
  - `pet` (adopt/summon/level/exp/hgp/kill/revive);
  - `pets <char>`;
  - `mail` (list, read, return, delete, restore, send, mute, unmute, log; roles as PETS §4.3; a body travels only in
    `gmResult.data`);
  - `friends <char>`.

  Movement and screens add no command, and `/speed` does not affect the roll.
- **Offline CLI** (`apps/server/src/cli/gm.ts`): `mail list`, `mail return`.

### 3.7 Server config (`apps/server/src/config.ts`, all optional)

- **Movement:** `ROLL_IFRAME_MS` (0).
- **Pets, friends, mail** (PETS §8.4):
  - `PET_ROSTER_MAX` 4, `PET_GRAB_RADIUS_M` 12, `PET_GRAB_SCAN_MS` 250, `PET_BAG_SLOTS` 28, `PET_LEASH_M` 30,
    `PET_FOLLOW_REPLAN_MS` 500;
  - `PET_EXP_RATE` 1, `PET_DAMAGE_RATE` 1, `PET_DEATH_EXP_PCT` 5, `PET_REVIVE_WAIT_MIN` 10;
  - `PET_HGP_DRAIN_MS` 1500 (0 = no hunger), `PET_HGP_POTION` 2500, `PET_SUMMON_COOLDOWN_MS` 10000;
  - `FRIEND_MAX` 50, `BLOCK_MAX` 100;
  - `MAILBOX_MAX` 50, `MAIL_POSTAGE` 50, `MAIL_POSTAGE_PER_STACK` 20, `MAIL_EXPIRE_DAYS` 30, `MAIL_SEND_PER_HOUR` 30,
    `MAIL_TOWN_ONLY` 1.
- **Screens:** none.
- DEPLOY.md lists them all (I11).

### 3.8 Database: migration **10** (the only one in the wave)

Migration 10 is PETS_SOCIAL §6.1, verbatim, appended to `MIGRATIONS` by W11-FS. Wave 10 adds no migration (see Repo
state), so the number is 10.

| Table / column | Holds | Key constraints |
|---|---|---|
| `char_pets` | the roster: kind, family, adopting item, name, level, exp, hp, hgp, `dead_at`, `summoned`, mode, grab JSON, `bag_size`, `released_at` (soft delete) | kind ∈ attack/pickup; level 1..255; hgp 0..10000; `bag_size` 0..140 |
| `pet_items` | the pickup pet's bag (mirrors `storage_items`) | `UNIQUE (pet_id, slot)`, count ≥ 1 |
| `friends` | mutual rows (both directions inserted in one transaction) | PK (character, friend), no self |
| `char_blocks` | block list | PK, no self |
| `mail` | header and body, gold, `sent_at`, `expires_at` (NULL = a returned mail holding attachments), `read_at`, `return_of`, `reported_at`, `deleted_at` | gold ≥ 0; indexes on `to_char`, `from_char`, expiry |
| `mail_items` | up to 5 stacks per mail | PK (mail, slot), slot 0..4 |
| `mail_log` | every mail movement, never read by gameplay | kind ∈ send/take/return/expire/delete/report/gm_* |
| `characters.mail_muted_until` | GM mail mute | — |

- **`social_log` is not reused**: its `kind` CHECK allows only trade and stall, and SQLite cannot alter a CHECK
  [confirmed: PETS §6.1].
- Movement needs no table: cooldowns are not persisted (WAVE_PLAN.md decision 8). Screens need none.
- **Upgrade test** (W11-FS): a v9 database with rows in every table migrates to v10 with nothing changed; the new
  CHECKs reject bad rows; an older server refuses v10 (D35).

### 3.9 Collision check [confirmed: script over `protocol.ts` at `85e2e14`; `gm.ts` command list]

- 0 of the 37 new message names and 0 of the 12 new fail reasons exist today.
- `ServerInfo` has only `world?` beyond its base fields.
- `MoveState` has no `style`, and `EntityState` has no `pet` or `petName`.
- The GM names `pet`, `pets`, `mail` and `friends` are free among the 26 commands.
- Server-message names and GM command names are separate namespaces, so a `pets` message next to a `pets` GM command
  is fine.

---

## 4. Seams (three foundation agents; every edit is additive; the Low guard stays green)

### 4.1 W11-P: shared, mocks, fail strings (step 0, one agent)

| File | Edit |
|---|---|
| `packages/shared/src/protocol.ts` | §3.2 and §3.4 in full: types, constants, the three request lists, `GAMEPLAY_REQUESTS`, server messages, the 12 reasons, the rate limits |
| `packages/shared/src/movement.ts` (new, complete) | §3.1 |
| `packages/shared/src/validate.ts` | §3.4 validators |
| `packages/shared/src/content.ts` | §3.3 |
| `packages/shared/src/index.ts` | exports |
| `apps/game/src/net/mock/{movement,pets,friends,mail}.ts` (new) + `net/mock/index.ts` (4 lines) | movement: echo `jump`, answer `roll` with a `style: 'roll'` move; pets: a wolf following; friends: two fake friends; mail: a box of 3 (PETS §8.1) |
| `apps/game/src/i18n/en-fail-w11.ts` (new) + `en.ts` (import + spread) | the 12 lines (D10) |
| `docs/PROTOCOL.md` | §11 "Wave 11": the three parts' messages, the routing table §3.5, the GM rows |

**Tests:**

- `packages/shared/test/movement.test.ts` (MOVEMENT §8.2):
  - `rollDir(0)` = +Z and `rollDir(π/2)` = +X;
  - `rollTarget` distance 4;
  - `MoveState.style` is kept, and an unknown style is dropped while the move is kept.
- `packages/shared/test/w11-protocol.test.ts`:
  - every new message round-trips;
  - rejections: a NaN yaw, a bad `part`, 6 items, duplicate slots, `PET_NAME`, a 301-code-point body, an unknown
    reason, `mailbox` with 101 headers;
  - `itemUse` with and without `pet`;
  - `EntityState.pet`/`petName` survive the parser.
- `packages/shared/test/server-info.test.ts` (SCREENS): with and without `clock`/`weather`, a bad clock is dropped
  alone, and older payloads are accepted.
- The existing `apps/game/test/hud.test.ts` stays green (D10).
- `pnpm typecheck`.

### 4.2 W11-FS: server seams and the migration (step 1, one agent)

| File | Seam (found by quoted code) | For |
|---|---|---|
| `db.ts` | migration 10 (§3.8); `Store.immediate` + `BusyError` (D20) | PETS |
| `world.ts` | `walkEntity(p: Player \| Mob \| Cos, …, opts?)` with `style` and `startDelayMs`; `tick` arrives unridden `Cos`; `Cos.role` (default `'ride'`), `petId`, `petName`, `combat`; `EntityState` decorator writes `pet`/`petName` (D4) | MOVEMENT + PETS |
| `connection.ts` | `gameplay.onMoveTo(this.player, now, { x: msg.x, z: msg.z })` (D8) | MOVEMENT |
| `gameplay.ts` | Register `movement`, `pets`, `friends`, `mail` as empty modules in the D3 order. `onMoveTo(p, now, target?)` asks `this.movement.deferMove(p, x, z, now)` (a stub that returns false) before the gates. `dealHits`/`attack` accept a `Cos` attacker (`lastCombatAt`, `hwanHits` false, no durability wear, `broadcastAboutEither`). The `cos` target branch dispatches on `role` (`'ride'` → `mounts.hitCos`, else `pets.hitCos`, a stub). `creditOf(a)` wherever `m.damage` is written. `mobDied` passes `shares`. `pickupProblem` becomes public `mayPickUp(owner, item, { ignoreFull })`, and `pickUpFor(owner, item, opts)` is the single pickup path (the hand pickup calls it with `into: 'bag'`). `swing(m, target: Player \| Cos)` | MOVEMENT + PETS |
| `modules.ts` | `mobDied?(m, now, credit, shares?)` | PETS |
| `ai.ts` | `AiHost.target/swing/ranged` accept `Player \| Cos`; `retaliate(m, creditId, damage, notice, targetId = creditId)`; `nextTarget` stays player-only | PETS |
| `mob-skills.ts` | `Player \| Cos` primary in `swing`/`strike`/`rollHits`/`land`; no statuses on a `Cos`; `g.movement.evading(p, now)` on player targets (stub false) (D5) | PETS + MOVEMENT |
| `mounts.ts` | `MOUNTED_REFUSED += 'jump', 'roll'` | MOVEMENT |
| `alchemy.ts` | `FUSE_CANCELLERS += 'jump'`; `FUSE_LOCKED += 'mailSend', 'mailTake', 'petItem'` (D6) | both |
| `item-use.ts` | the optional `pet` of the request. Dispatch: `use.pet` → `pets.adopt`; `use.hgp`, `use.revive`, or `'mount'` **with** a `pet` → `pets.useItem`; otherwise the horse as today | PETS |
| `chat.ts` | `blocked(fromChar, toChar)` hook in `whisper()` → the existing "not online" answer | PETS |
| `party.ts`, `social/guild.ts`, `social/trade.ts`, `social/stall.ts` | one `isBlocked` call on invite, request and trade; `TRADE_ALLOWED` and `STALL_ALLOWED` gain the §3.5 "allowed" types | PETS |
| `game.ts` | `serverInfo()` fills `clock` and `weather` (D19) | SCREENS |
| `config.ts` | §3.7 keys | all |
| `gm.ts`, `cli/gm.ts` | the `pet`, `pets`, `mail`, `friends` rows and the two CLI verbs, with runners imported from the lanes' files (stubs answering "not built") | PETS |

**Tests:**

- `apps/server/test/migration-v10.test.ts` (§3.8).
- `seams-w11-server.test.ts`:
  - a `Cos` walks with `walkEntity` and gets its `stop` on arrival; a ridden horse gets no stop of its own;
  - a roll-style walk broadcasts `move.style` and `startedAt = now + delay`;
  - `onMoveTo` passes the target to `deferMove`;
  - a stub `Cos` attacker credits its owner in `m.damage` while the mob targets the `Cos`;
  - a mob skill row swings at a `role: 'attack'` `Cos`, and that hit never reaches `mounts.hitCos`;
  - `mobDied` hooks receive `shares`;
  - `pickUpFor(into: 'bag')` equals the old pickup;
  - a stub `isBlocked` turns a whisper into `error not_found`;
  - a kit with no `pet` still heals the horse;
  - `ServerInfo` in `welcome` carries the clock, and a malformed clock still lets the login through
    (`servers-clock.test.ts`, SCREENS §12.6).
- **Allowlist guard** (§3.5).
- **The whole server suite unchanged.**

### 4.3 W11-FC: client seams (step 1, one agent; after the wave-9 release is committed, D18)

| File | Edit | For |
|---|---|---|
| `app.ts` | `ScreenParams.intro`, `App.stage: StageHost` | SCREENS |
| `main.ts` | register `intro`, drop `splash` from the start (the `splash` screen stays registered until SCR-I deletes it) | SCREENS |
| `params.ts` | `skipIntro` (= today's `skipSplash`: `?skip=1`, mock + auto) | SCREENS |
| `settings.ts` | `ui.intro`, `ui.introSeen`, `ui.hideOtherPets` (D11) | SCREENS + PETS |
| `stage/types.ts` (new), `stage/host.ts` (new stub that throws "not built") | `StageDef`, `StageHost`, `Stage` (SCREENS §4.1, §4.3) | SCREENS |
| `i18n/en-{movement,screens,pets,friends,mail}.ts` (new) + `en.ts` spreads | keys only (D10) | all |
| `world/features.ts` + `features/{movement,pets,community}.ts` (new stubs) | register three features (D14) | MOVEMENT + PETS |
| `hud/guild.ts` | `registerCommunityPage({ id, label, build })` over the existing `TabBar`; Guild and Notice registered as today; strip widened to 451 px | PETS |
| `world/features/guild.ts` | menubar label "Community" (key U unchanged) | PETS |
| `hud/menubar.ts` | `MenuBarEntry.badge?: () => number` (D15) | PETS |
| `hud/hud-layout.ts` | `hudAnchors().petColumn` (two 154×40 frames under the player frame) | PETS |
| `world/mount-view.ts` | `cos` factory: `state.pet ? petView(state, ctx) : new HorseView(state, ctx)`; `registerPetView(factory)` | PETS |

**Not edited by W11-FC** (D9, D12):

- `three/models.ts` and `world/entities.ts` (MV-C only);
- `hud/options.ts` (rows go through `registerOptionRow`);
- `net/mock.ts` (W11-P uses per-feature mocks).

**Tests:**

- `apps/game/test/seams-w11-client.test.ts`:
  - `intro` is registered, and `?skip=1` / `?auto=1` go to login;
  - the three `ui.intro` values and the seen flag round-trip;
  - old saves normalise;
  - Guild and Notice are still the first two community tabs, and a registered page appears;
  - a `cos` state without `pet` still makes a `HorseView`;
  - a menubar entry with a badge renders its count;
  - `hudAnchors` snapshot with `petColumn`.
- The existing guild, mount and settings tests unchanged; `pnpm typecheck`.
- **User check:** nothing changes on screen, except the menubar caption "Community".

---

## 5. Presets and budgets

### 5.1 What the wave adds, per part (no new shaders, defines, render targets or post passes)

| Part | GPU | CPU | Download | Network |
|---|---|---|---|---|
| Movement | 0 [confirmed by design: animation groups and messages only] | Idle 0.022 ms per full-rate actor. 20 actors jumping every 1.3 s: +0.20 / +0.47 ms mean / p95, or +0.44 / +0.70 ms with the arm layer [confirmed: `work/tmp/movement/factcheck/bench-anim.ts`, NullEngine, dev PC] | ≤ ~55 KB per skeleton, so ≤ ~110 KB for both [projected; JUMP alone 18.0 KB brotli, confirmed] | `jump` ~41 B per viewer; a roll = one `move` + one `stop` |
| Pets | ≤ 0.1–0.2 ms mid (Medium–High), own pets cast shadows only within 50 m | 0.115–0.30 ms per pet at Medium WebGPU [projected from the measured crowd slope, PETS §10]; others' pets capped (D33) | 6 families' glbs + textures, ~1–3 MiB each [likely; PS-X measures] | a following pet ≤ 2 `move`/s per viewer; `petUpdate` HP ≤ 2 Hz |
| Friends, mail | 0 | 0 per frame; the community window builds ≤ 8 ms on open | ~0 | one `friendUpdate` per enter/leave per online friend; mail on demand |
| Screens (separate scenes; the world is not loaded) | stage ≈ world Medium/High | stage A select with 4 characters: WebGL2 High 3.3 / 4.5 ms, WebGPU Medium 2.7 / 4.1 ms CPU p50 / p95 [confirmed: SCREENS pass 2, 1920×1080, filter on] | stage A +20–30 MB once [projected, r = 150 m]; the intro needs the town's regions first (≈ 50–80 MB on a first visit, the world's anyway) [projected] | `ServerInfo` +~200 B in `welcome` |

### 5.2 The merged table (WAVE_PLAN3 §5.2 format; 1080p; dev PC = Ryzen 5 9600X + RX 9060 XT; "mid" CPU = ×1.5, also Apple M1-class [projected])

The base numbers are the wave-9 release gate (`work/tmp/w9-finish/budgets.md`) [confirmed]. **I11 re-measures them on
the post-wave-10 build first** (D17). The movement column uses 5 friends jumping at a normal rate
(≈ 1 jump per 3 s each), bounded above by the bench's 20 non-stop jumpers.

| Preset | Base crowd p95 (dev, WebGPU / WebGL2) | + pets at the cap (own 2 + others') [projected] | + movement (5 jumpers; bound 20 non-stop) | World crowd p95 after (dev) [projected] | Mid CPU after [projected] | GPU added (mid) | Outer screens CPU p95 (dev) |
|---|---|---|---|---|---|---|---|
| Low (Classic) | 4.2 / 4.2 | 6 pets: +0.03–0.24 | ≤ +0.1 (≤ +0.70) | ~4.4–4.6 / same | ~6.6–7 | < 0.05 ms | A select WebGL2 4.7 [confirmed, pass 1] |
| Medium (default) | 14.4 / 11.3 | 6 pets: +0.7–1.8 (WebGPU), +0.6–1.4 (WebGL2) | ≤ +0.1 (≤ +0.70) | **~15.2–16.3** / ~12.0–12.8 | ~23–24 WebGPU / ~18–19 WebGL2: the crowd **already** misses 60 fps on mid CPUs at the base (21.6 / 17.0), and wave 11 must not widen that by more than ~1.9 ms | ≤ 0.1 ms | WebGPU 4.1 (filter on), WebGL2 4.9 (filter off) [confirmed, pass 2] |
| High | 21.5 (cut 4) / 16.0 | 4 pets: +0.7–1.4 | ≤ +0.1 (≤ +0.70) | ~22.3–23.0 / ~16.8–17.5: High already misses (BACKLOG item 9) | not a default | ≤ 0.15 ms | WebGL2 4.5, WebGPU re-measured by SCR-R |
| Ultra | 22.9 | 14 pets: +2.0–4.3 | ≤ +0.1 | not a default | — | ≤ 0.2 ms | — |

What it means, honestly:

- **Medium on WebGPU is the tight line.** The crowd base is 14.4 ms; the pets at the cap take it to ~15.1–16.2 and
  normal jumping adds ≤ 0.1. That passes 16.7 ms p95, with 0.4–1.5 ms to spare [projected].
  - The first lever is the Medium pet cap, which is config (D33): 4 → 2 removes ~0.2–0.6 ms.
  - The arm layer (MOVEMENT cut 2) halves the jump cost, but jumping is not the cost that matters here.
- **WebGL2 Medium keeps a wide margin** (~12–13 ms).
- **High stays over budget** because of the CPU draw cost (the wave-9 gate). Wave 11 adds at most ~1.5 ms there and
  does not try to fix it.
- **Outer screens are far inside the budget on the dev PC.** The watch items are the intro's flight over the town
  (≤ 300 draws at Medium, SCREENS §11) and WebGPU's CPU cost per draw.
- **Server:**
  - a roll costs two `nav.walk` calls (≤ 0.2 ms);
  - the pets tick adds ≤ 0.3 ms per world tick with 40 summoned pets;
  - a mail or friend transaction ≤ 2 ms, and the expiry sweep ≤ 20 ms per 200-row slice [projected: PETS §10].

### 5.3 Per-lane budgets (dev PC, 1080p; min of 5 runs; **GPU lock** for every in-browser frame measurement; NullEngine benches need no lock)

| Lane | Budget |
|---|---|
| MV-C | 0 ms CPU delta at rest (the feature flag A/B); ≤ +0.8 ms CPU p95 with 20 bots jumping every 1.3 s; clip load ≤ 30 ms main thread once per skeleton; first gate: re-run `bench-anim.ts` on the real clips |
| MV-P | a roll ≤ 0.2 ms server CPU |
| MV-A | each clip's pack ≤ 60 KB raw; the STAND1 round-trip control ≤ 0.1° / 1e-5 m |
| PET-C | 6 pet actors (two 4-mesh pickup pets) add ≤ 1.2 ms CPU p50 and ≤ 1.8 ms frame p95 on Medium, WebGPU and WebGL2; it reports the measured cost per pet, which sets `PET_DRAW_CAPS`; 0 allocations per frame in the follow and interpolation path |
| PET-S | `worstTickMs` +≤ 0.3 ms with 40 summoned pets grabbing in a 20-mob fight |
| CM-C | the window opens ≤ 8 ms with 50 friends and 50 mails; 0 per frame when closed |
| ML-S | send/take ≤ 2 ms; sweep ≤ 20 ms per slice; the conservation fuzz passes |
| SCR-R | a stage with 4 equipped characters, weather off and at half rain: CPU p95 ≤ 7 ms at Medium; ≤ 9 ms (WebGL2) / ≤ 10 ms (WebGPU) at High; a cached stage's `enter()` ≤ 1.5 s |
| SCR-I | every intro shot ≤ 300 draws at Medium / 450 at High, CPU p95 ≤ 8 ms at Medium; no frame > 50 ms after the logo beat |
| SCR-L | the login drift adds ≤ 0.2 ms CPU; server select reloads nothing |
| SCR-SEL / SCR-CRE | a slot or outfit swap: ≤ 1 frame > 33 ms; the create turntable at 60 fps |
| SCR-X | the `stage-cs` pack ≤ 30 MB out-opt (r = 150 m; r = 120 m if over) |
| **Whole game (I11)** | **Medium p95 < 16.7 ms** in the 20-mob crowd with 6 pets at the Medium cap and 5 bots jumping, on WebGPU and WebGL2. High crowd p95 ≤ the post-wave-10 baseline + 1.5 ms. The outer screens hold 60 fps p95 at the first-run preset. World → select → world three times: the heap grows ≤ 10 MB on WebGL2; on WebGPU it may keep **one** stage `World` (LEAK-2) but grows ≤ 10 MB between the 2nd and 3rd trip |

---

## 6. Wave 11: steps and lanes

### 6.0 Entry criteria and step order

**Entry:**

- wave 10 is integrated (WAVE_PLAN4's I10 done);
- the wave-9 release is committed;
- I11 has re-measured the §5.2 base on that build under the GPU lock (`work/tmp/w11/baseline.md`).

MV-A and PS-X are data lanes; they may start as soon as their own inputs exist (D16, D17).

```
step 0:  W11-P  |  MV-A (clips; runs through step 2)  |  SCR-X (after wave 10's converter)
step 1 (after W11-P):   W11-FS  |  W11-FC  |  PS-X
step 2 (after step 1):  MV-P | MV-C | PET-S | FR-S | ML-S | PET-C | CM-C | SCR-R | SCR-E
step 3 (after SCR-R):   SCR-I | SCR-L | SCR-SEL | SCR-CRE | (MV-L, optional)
step 4:  I11 (integration), then H11-M | H11-E | H11-U (read-only hunts), then I11 fixes
```

- **Why W11-P goes first alone.** W11-FS and W11-FC both need the new types, and W11-P also edits `en.ts`, which
  W11-FC edits after it. W11-P is small: about half a day [projected].
- **File disjointness.**
  - W11-FS and W11-FC are disjoint (server vs client).
  - PS-X touches only `packages/convert` and data.
  - SCR-X edits `packages/convert/src/world/*` and `cli.ts` (`--keep-within`).
  - PS-X edits the data readers (`src/data/*`), the shops builder, the sound index and `export-ui.ts`, and runs
    `pnpm sro convert`. It does **not** edit `cli.ts` [PETS §8.3].
  - MV-A edits `cli.ts` (`pnpm sro moves`) and `optimize/run.ts`.
  - **So `cli.ts` has two editors (SCR-X, MV-A).** SCR-X's flag lands first, and MV-A rebases its verb on it
    [decision].
- **Soft dependencies are data, not files.**
  - MV-C runs on the mock with placeholder clips until MV-A's packs land.
  - PET-C needs PS-X's converted pets.
  - SCR-SEL needs SCR-X's pack for stage A, and falls back to stage B until then.
  - SCR-E authors the Jangan keys after the wave-10 re-export.
- **Every lane** runs `pnpm vitest run <its tests>` and `pnpm typecheck` before hand-off, plus the whole suite and the
  Low guard (`packages/world-render/test/seams-classic.test.ts`). **Nobody commits; the lead integrates.**

### 6.1 Lane table

| Lane | Owns (new files unless marked) | Uses seams | Tests | User check | Depends on |
|---|---|---|---|---|---|
| **MV-A** Blender clips | `packages/convert/tools/blender/moves/{key_moves,extract_deltas}.py` (D16), `packages/convert/src/tools/export-moves.ts` (re-expression + pack writer), `content/moves/{jump,jump_run,roll}.json` (deltas, both skeletons), `packages/convert/test/moves.test.ts`; edits `cli.ts` (`pnpm sro moves`, after SCR-X), `optimize/run.ts` (pass-through + meshopt of the `movement` packs), `docs/ASSETS.md` §5.3 | `SroConfig.blenderExe` | MOVEMENT §8.2 convert list (re-expression identity on a synthetic chain; pack joint names and rest TRS; no XZ root travel; durations; the real STAND1 control ≤ 0.1° when `work/out` exists) | the GIFs: three clips, male and female, sword and spear. First polish: take-off at ~200 ms, the push toe-roll, the arms (MOVEMENT §11 item 1) | none |
| **MV-P** server movement | `apps/server/src/movement.ts` (the module: `handles ['jump','roll']`; the §4.3 order: checks → dry-run `nav.walk` → `g.onMoveTo` → `walkEntity(…, { style, startDelayMs })` → state + cooldown; `deferMove`; the busy gate; the roll end in `tickPlayer`, and the early end on halt, `stopAction`, warp or death; `evading()` with `ROLL_IFRAME_MS`), `apps/server/test/movement.test.ts` | `walkEntity` opts, `onMoveTo` target, `deferMove`, `evading()` in `mob-skills.ts`, `MOUNTED_REFUSED`, `FUSE_CANCELLERS` | MOVEMENT §8.2 server list in full (wall stop = the `moveTo` end point; < 0.5 m refused with the running move untouched and no `stop`; a stun or `stopAction` drops the deferred move; the locks refuse without ending the trade; the cooldowns; a jump never changes `pos`/`move`; Tiger-Girl-like ATTACK01 dodged, a `castMs 0` row not; iframes 0 vs 250) | with MV-C | W11-FS |
| **MV-C** client movement | `world/features/movement.ts` (Space/V, intents, prediction, the click buffer, the self root easing, toasts), `i18n/en-movement.ts` (keys from W11-FC); edits `three/models.ts` (movement pack + index, `KEEP_CLIPS`, `playMove`, the masked arm layer, blend speeds 0.25 / 0.12 with the base's speed restored), `world/entities.ts` (the style-`roll` branch seeked on the server clock; ignore the own echo and own roll move when predicted), `world/intents.ts`, `hud/cooldowns.ts` (`move:roll`), `hud/keyhelp.ts`, `audio/entity.ts` or `audio/cues.ts` (synthetic tracks from the index events) | the feature registration, the mock | `apps/game/test/movement.test.ts` (MOVEMENT §8.2 client list, including "a moving entity keeps JUMP_RUN and ROLL", which pins `MOVE_CANCELS`; Space on a focused button jumps and does not click; a missing pack falls back to RUN) | MOVEMENT §9 items 2–5 | W11-FC; MV-A for the look |
| **PS-X** pet data | `packages/convert/src/data/{cos,items}.ts`, the shops builder's `CUSTOM_GOODS`, `src/sound/build.ts` (cue rows), `src/tools/export-ui.ts` (`interface/pet` row); runs: 6 BSRs, icons, sounds | §3.3 content types | `packages/convert/test/cos-pets.test.ts` (wolf levels 1–20; rabbit bag 28 and `role: 'pickup'`; horse unchanged; 6 pet items; kits unchanged; the Stable tabs and prices) | `/out/cos/p_wolf_01.glb` in the viewer with its 14 clips | W11-P |
| **PET-S** server pets | `apps/server/src/pets/{pets,pets-store,pet-ai,pet-grab,pet-bag,pet-rules,gm-pet}.ts` | `Cos` walks and arrivals (D4), the `Cos` union in `ai.ts`, `mob-skills.ts` and `gameplay.ts`, split `retaliate`, `creditOf`, `mobDied` shares, `mayPickUp`/`pickUpFor`, item-use dispatch, `Store.immediate`, GM rows | PETS §11.1 PET-S list (adopt; caps; every §2.4 refusal; follow; leash; one grab test per §2.5 row; bag-then-pet-bag-then-off; pauses; the fetch race; the modes; owner credit; retaliation on the pet then the owner; EXP cap; hunger; death and revive; logout restore; GM `pet`), plus: **a mob skill row lands on a pet** (D5) and **a pet's follow move ends with a `stop`** (D4) | as a GM `/pet COS_P_WOLF 5` and `/pet COS_P_RABBIT` | W11-FS, PS-X data |
| **FR-S** server friends | `apps/server/src/social/{friends,friends-store,friend-rules,gm-friends}.ts` | chat `blocked` hook, `isBlocked` calls, allowlists | PETS FR-S list | two accounts: lamps, whisper from the list, block | W11-FS |
| **ML-S** server mail | `apps/server/src/social/{mail,mail-store,mail-rules,gm-mail}.ts`, the CLI runner | gates, `inSafeArea`, `isBlocked` (duck-typed until FR-S merges), `Store.immediate`, `FUSE_LOCKED` | PETS ML-S list: every §4.1 rule; abuse cases 1–14c; expiry and return; a box above 50 lists within the parser bound; the CLI return next to a live store; **the 10,000-step conservation fuzz** (with PET-S's bag once merged) | mail potions + gold to an offline friend; they take all | W11-FS |
| **PET-C** client pets | `world/{pet-view,features/pets}.ts`, `hud/{pet-frame,cos-window,cos-command,pet-state}.ts`; `PET_DRAW_CAPS`; the Interface row via `registerOptionRow` (D12); keys Insert/PgUp/Del while a pet is summoned | `registerPetView`, `petColumn`, `ui.hideOtherPets` | PETS PET-C list + the §5.3 bench gate, reporting the cost per pet | frames, COS window, grab settings, modes, keys, hide others' pets | W11-FC, PS-X runs |
| **CM-C** community pages | `hud/{friends,friends-state,mail,mail-state,mail-compose,block}.ts`, `world/features/community.ts` (`/friend`, `/f`, `/mute`; the message wiring; the menubar badge) | `registerCommunityPage`, `MenuBarEntry.badge`, `ChatBox.registerPrefix` | PETS CM-C list (the compose byte counter stops at 900; the town flag; the postage line) + the **chat-prefix guard** (no client prefix equals a GM command name) | Friends, Messages, Block pages; compose, read, reply, take, delete, report | W11-FC |
| **SCR-X** stage A export | `WORLD_PRESETS['stage-cs']` (x 77–79, z 105–107), `--keep-within` (`cli.ts`, `world/keep-within.ts`), the deploy include list, `keep-within.test.ts`; the data run + `optimize-out` | — | SCREENS §12.6 | the pack size vs §5.3 | wave 10's converter (D17) |
| **SCR-R** stage runtime | `apps/game/src/stage/{host,stages,camera-path,slots,key-light}.ts` (replaces the stub); tests `stage-host`, `stages`, `camera-path` | `App.stage`, `stage/types.ts`, `WorldGraphics` reuse, `runFirstRun` before the first `enter()` | SCREENS §12.6 (reuse and dispose; `update` before the first render; a non-empty active-mesh list with the filter on; Low stays Classic; the aspect-fit slot rule at 4:3, 16:10, 16:9 and 21:9; file yaws 0 → 0, 270 → π/2) | — | W11-FC |
| **SCR-E** stage editor | `apps/viewer/src/world/stage-editor.ts`, one `?stage=` hook in `world/main.ts`, one panel slot in `world.html` | `stage/types.ts` | — | authors the Jangan keys after wave 10's re-export | W11-FC |
| **SCR-I** intro | `screens/intro.ts` (replaces `splash.ts`, deleted), `stage/intro-path.ts`, `intro.test.ts`; the "Play the intro" row via `registerOptionRow('interface', …)` | `ui.intro`, `ui.introSeen`, `en-screens.ts` | SCREENS §12.6 intro list (the click gate; skip; first-only; the seen flag never set on the 10 s fallback; music once) | SCREENS §12.8 items 1–2 | SCR-R |
| **SCR-L** login + servers | edits `screens/login.ts`, `screens/servers.ts` (backdrop only), a CSS vignette; deletes `screens/title.ts` | `App.stage` | — | §12.8 item 3 | SCR-R |
| **SCR-SEL** select | edits `screens/charselect.ts` (drops `StudioEnvironment` on the stage path) | `App.stage`, `stage.slots()` | — | §12.8 item 4 | SCR-R, SCR-X data (else stage B) |
| **SCR-CRE** create | edits `screens/charcreate.ts` (stage, turntable, the 2D `back_image` panel), `.create-backimage` CSS | `App.stage` | — | §12.8 item 5 | SCR-R |
| **MV-L** (optional) | `apps/viewer` animation panel lists `movement.json` clips | — | — | — | MV-A |

---

## 7. I11: integration checklist (one agent)

1. **Entry.**
   - Check the release commit and wave 10's I10.
   - Re-measure the §5.2 base under the GPU lock: plaza, gate, fields and crowd, at Medium and High, on both APIs.
     Write `work/tmp/w11/baseline.md`.
2. **Merge W11-P.** Run the suite and record the test count.
3. **Merge W11-FS and W11-FC.** Run the suite, typecheck, the Low guard, the allowlist guard and both seams tests.
4. **Data runs** (no code):
   - PS-X's 6 pets, icons, sounds and the Stable tabs;
   - MV-A's `pnpm sro moves` + `optimize-out`;
   - SCR-X's `stage-cs` + `optimize-out`.

   Record the sizes against §5.1 and §5.3.
5. **Merge the server lanes: MV-P → FR-S → ML-S → PET-S.** Run the suite after each. After PET-S, re-run ML-S's
   conservation fuzz with the pet bag.
6. **Merge the client lanes: MV-C → CM-C → PET-C → SCR-R → SCR-E → SCR-L → SCR-SEL → SCR-CRE → SCR-I** (then MV-L).
   Run the suite and the Low guard after each.
7. **Two clients** (WebGPU and `?engine=webgl`) against the dev server:
   - jump and roll seen from both sides;
   - a roll into the city wall;
   - Tiger Girl ATTACK01 dodged;
   - adopt a Rabbit and a Wolf; grab rules in a party;
   - friends and block;
   - mail to an offline character;
   - the GM `/pet`, `/pets`, `/mail`, `/friends`;
   - `/time 18:30`, then log out to select: the stage sky follows.
8. **R1 candidate:** the full suite, typecheck, and the budgets for the world (§5.3 whole-game line, MV-C, PET-C). Any
   miss goes to §9, the pet cap first (D33).
9. **R2 candidate:** the outer-screen flow on both APIs, the SCR budgets, and world → select → world three times (the
   heap rule).
10. **Docs:**
    - PROTOCOL.md §11 (done in W11-P; update it);
    - DEPLOY.md: the config keys, `stage-cs` in the include list, and the D35 database backup step;
    - PLAYTEST.md: the MOVEMENT §9, SCREENS §12.8 and PETS §11.2 checks;
    - ASSETS.md: the movement packs, `stage-cs`, `out/cos/p_*`, `out/ui/pet/`;
    - DATA.md: the pet families and the Stable custom goods;
    - SOUND.md: the pet cues and the movement synthetic tracks;
    - `apps/game/README.md`: correct the backdrop investigation;
    - BACKLOG: items 5 and 8 and the wave-11 line done; the open item "memory growth world → select" closed or
      re-stated from H11-U's measurement.
11. **Deletions:**
    - `three/backdrop.ts`, except `newScene`;
    - `three/studio-env.ts` + test, if nothing imports them (D18);
    - `screens/splash.ts` and `title.ts` (by their lanes; I11 checks);
    - scratch: `work/tmp/screens/out/` (132 MB), after SCR-X ships the real export; `work/tmp/movement/`, after MV-A
      has ported `key_jump.py`/`make_pack.py` (the `.blend` and glbs are retail data and private);
      `work/tmp/pets-social/`, after the lanes.
12. **Hand-off to the hunts** (§8). Then fix, and run the suite again.

---

## 8. H11: the three-lens hunt (read-only; findings become tests, then I11 fixes)

Each hunt reads the merged code, writes failing tests or reproductions, and hands them to I11. Hunts run in parallel
and touch no production file.

### 8.1 H11-M: movement exploits

1. **Nav escapes.** Roll at:
   - the gate stairs' open sides;
   - the city wall;
   - the coast bounds line (wave 10's ~2 m water);
   - a region border;
   - a closed cell;
   - object outlines.

   The roll's end must equal a `moveTo` to the same target, and the jump never moves the entity.
2. **Travel and kiting.** Roll chained with running, a roll every 3.0 s, and a roll + `moveTo` spam at the rate
   limit. Rolling everywhere must stay slower than running (4 m in 850 ms vs 4.675 m). The cooldown holds across a
   relog within 3 s: cooldowns are not persisted, so check what a relog does [unknown; default: a relog resets it,
   accepted, since a relog costs far more than 3 s].
3. **Deferral abuse.**
   - A roll, a queued `moveTo`, then a warp, a stun, a death or `stopAction`: an early end drops the deferred move.
   - A roll while stunned is refused (`cant_act`), and so is a jump.
   - The known gap: `moveTo` is accepted while stunned today (MOVEMENT Q9, left).
4. **Locks.**
   - A stall owner's and a trader's roll: refused, and the trade is not ended.
   - A mounted jump or roll: refused.
   - A roll to break a return-scroll cast: allowed, the same as a click.
   - A roll to cancel a skill's post-release action: the same as a click; check that no new animation cancel exists.
5. **Dodge rules.**
   - Tiger Girl ATTACK01 is dodged; ATTACK02 (cast 0) and ATTACK03 (ranged, 3 m slack) are not.
   - Arrows and bolts are not dropped by a 4 m roll.
   - `ROLL_IFRAME_MS` 0 means no `miss` ever comes from a roll.
   - A mob skill aimed at a **pet** is never turned into `miss` by the owner's roll (D24).
6. **Spam and older clients.**
   - Jump/roll at the rate limit are `rate_limited`, never strikes.
   - An older client drops the `jump` frame with a warning, and shows a style-less roll as a fast slide.
7. **Client state.**
   - No T-pose when ATTACK replaces JUMP.
   - The own echo does not restart a predicted clip.
   - The arm-layer clones are disposed with the actor (a leak check).
   - A roll from a run at +200 ms RTT eases instead of snapping.

### 8.2 H11-E: economy and dupes through pets and mail

1. **Conservation.** Re-run ML-S's fuzz after every merge from step 5 on, with the pet bag and the grab in the
   operation mix. Item counts per code and total gold must be conserved, except the explained sinks (postage,
   buyback, drops and pickups).
2. **Mail races.**
   - A double take in one tick.
   - A take while the gm CLI returns the same mail (the immediate transactions).
   - A take with a full bag (all or nothing).
   - A send with a stale slot, an over-count or a duplicate slot.
   - The starter kit, an equipped item, a pet-bag item or a quest item as an attachment.
   - A crash injected after the bag write.
3. **Ownership.** Guessing mail ids and roster ids of another character: `not_found` for `mailRead`, `mailTake`,
   `mailDelete`, `mailReport`, every `pet*` request and `itemUse {pet}`.
4. **Grab rules.**
   - Another player's owner window.
   - A share-mode item assigned to someone else.
   - A free-mode teammate's item with scope `mine`.
   - Through a wall or floor.
   - Two pets on one item.
   - A grab during a trade or stall (paused).
   - Party gold split near the grabbing member.
5. **Pet bag.**
   - `petItem` with a stale slot.
   - A move during a dismiss.
   - Release with items.
   - Release while summoned.
   - Pet-bag items sold, dropped, traded, listed, mailed, stored or used: all refused.
6. **Locks as dupes.**
   - The allowlist guard (a new type reachable while trading or stalling).
   - `FUSE_LOCKED` drift (a new bag-changing type missing).
   - `mailSend`/`mailTake`/`petItem` during a fuse: `busy`.
7. **Farming and sinks.**
   - Pet EXP only while summoned, alive, within 60 m and in the credit.
   - The free quest Rabbit on alts (accepted, PETS 27a).
   - Postage and Grass of Life prices against BALANCE §5.
   - `MAX_GOLD` overflow on a take: `gold_limit`, and the mail keeps the gold.
8. **Privacy and moderation.**
   - `/mail read` never writes a body into `gm_audit` or the server log.
   - The block list hides presence and whispers.
   - An invisible GM never shows online, and neither do their pets.
   - The v9 → v10 upgrade runs on a **read-only copy** of the live database, never the live file (D35).

### 8.3 H11-U: UI and flow

1. **The outer-screen flow.**
   - The intro is skipped mid-load.
   - The first visit falls back after 10 s: the seen flag stays unset.
   - Logout from select; session expiry on create.
   - A server without `clock`; mock mode.
   - The tab is hidden during the intro: no double music.
   - `?skip=1` and `?auto=1`.
2. **Black or sky-only stages** on every preset × API, including `?gpuLimits=default`; the active-mesh list is never
   empty.
3. **Hitches.**
   - No shader compile after the logo beat.
   - No define change when the stage clock moves.
   - A stage switch compiles nothing twice.
   - No frame > 50 ms in the intro.
4. **Leaks.** World → select → create → select → world ×3, covering:
   - the stage `World`, night lights, the key light, post pipelines, actors, observers;
   - the movement arm-layer clones;
   - pet views (a pet despawn disposes its meshes);
   - community windows.

   Apply the §5.3 heap rule, including WebGPU LEAK-2.
5. **Readability and framing.**
   - Names, the info window and buttons at the brightest and darkest stage times.
   - The four slots inside the frame minus the retail bars at 4:3, 16:10, 16:9 and 21:9.
   - `reduceFlashing`.
6. **Input.**
   - Space on a focused HUD button.
   - Space and V while typing in chat or the mail compose window.
   - Insert/PgUp/Del with and without a summoned pet, and PgUp on a focused slider.
   - U opens Community.
   - `/friend` vs `/friends` vs the GM `/pet`.
7. **Windows.**
   - The community window with 50 + 50 rows.
   - The mail compose byte counter at 900 bytes with CJK and emoji.
   - Attachments disabled outside town.
   - The pet frames with 0, 1 and 2 pets.
   - The badge after a CLI return (the `dataVersion` poll).
8. **Low / WebGL2 / Safari.**
   - Low shows the Classic path on every outer screen.
   - The WebGL2 sampler counts on the stages.
   - Safari WebGPU and WebGL2 on an Apple Silicon Mac (a friend).

---

## 9. Scope-cut order (cut from the top; one list for the wave)

The order keeps what the user asked for by name (Blender animations for jump and roll, the retail select and create
scenes, both pet kinds, friends, mail) until last, and cuts polish first.

1. MOVEMENT cut 1: per-family roll variants (not in v1; listed so nobody adds them late).
2. PETS cut 1: pet naming.
3. PETS cut 2: the idle emotion and the PICK client cue.
4. SCREENS cut 1: the server clock and weather on the stages (fixed 17:00, clear).
5. SCREENS cut 2: the selected character's step-forward and `POSE`.
6. PETS cut 3: mail Report and the GM "reported" body access (GMs see headers only; admins keep `mail read`).
7. MOVEMENT cut 4: the HUD roll cooldown ring (the toast stays).
8. SCREENS cut 3: intro shots 1 and 2 (the flight starts at the gate: 14 s).
9. SCREENS cut 4: the stage editor SCR-E (keys typed from the viewer's camera readout).
10. PETS cuts 4–5: the Three Footed Crow, then the Monkey, Squirrel and Raccoon dog (the Wolf and the Rabbit stay).
11. MOVEMENT cut 2: the masked weapon-arm layer (it affects every player; it also halves the jump's CPU).
12. SCREENS cut 5: the face key light (stage times clamped to 08:00–17:30).
13. PETS cut 6: hunger (HGP).
14. PETS cut 7: the Block **page** (blocking stays through `/mute` and a friend-row menu).
15. MOVEMENT cut 3: JUMP_RUN.
16. PETS cut 8: the death EXP loss and the free-revive wait.
17. MOVEMENT cut 5: client prediction, the self root easing and the click buffer.
18. PETS cut 9: the pet bag (loot goes to the owner's bag only).
19. PETS cut 10: the attack modes beyond assist.
20. MOVEMENT cut 6: separate female authoring (the male keys re-run on the female skeleton).
21. PETS cut 11: the custom pet quest (pets from the shop only).
22. SCREENS cut 6: **stage A → stage B** for select and create (no new export or download). It sits this late
    because "retail character select/create scenes" is the user's own wording.
23. PETS cut 12: mail expiry and returns (GM `/mail return` stays).
24. SCREENS cut 7: the intro flight → the logo beat plus the login drift, still real Jangan through the wave-9
    renderer.
25. SCREENS cut 8: the create stage → create on the select spot.
26. MOVEMENT cut 7: the dodge roll as a whole (ship the jump only).

**Before any of these,** a budget miss in the world first lowers the Medium pet draw cap (D33). A miss on the outer
screens first re-frames the offending shot or lowers the stage's draw distance (SCREENS §11).

**Never cut:**

- **Movement:**
  - server authority: the jump never moves the entity, and the roll is walked on the navmesh;
  - the lock rules;
  - the validators and rate limits;
  - the cooldowns;
  - the re-expression step and its control test;
  - no per-frame cost at rest.
- **Screens:**
  - the placeholder plaza is gone from every outer screen;
  - real scenery through the wave-9 renderer on the player's preset;
  - the Low path;
  - the live English UI and the retail layouts;
  - intro skip;
  - the leak and disposal tests.
- **Pets and social:**
  - the roster model;
  - the pickup pet with the exact party-loot rule and its pauses;
  - the attack pet with follow, assist, owner credit, levels ≤ the owner's, death and Grass of Life;
  - the pet draw caps;
  - friends: add, remove, online status and the whisper button; blocking whispers;
  - mail with items and gold, its immediate conditional transactions and `mail_log`;
  - GM `mail list`/`return`/`send`;
  - the conservation fuzz.
- **Wave:**
  - the three foundation lanes;
  - the v10 migration and its upgrade test;
  - the allowlist and chat-prefix guards;
  - the Low guard;
  - the database backup before R1 (D35).

---

## 10. What the user must provide or approve

**To start wave 11: nothing to download, buy or upload.** Every part uses the retail data, tools already installed
(Blender 5.2, Node, the converter) and our own code. The defaults below are what Claude builds if there is no
answer.

**Approvals and taste calls (each has a default):**

| # | Part | Need | Default |
|---|---|---|---|
| U1 | Movement | Route A (hand-keyed bpy in Blender) and the prototype's look: `work/tmp/movement/out/jump.gif`, `jump_filmstrip.png` | Yes, route A. First polish: take-off at ~200 ms, the push toe-roll, the arms; then the other clips |
| U2 | Movement | **Mocap downloads** (route B) | **None needed.** If route A is rejected, Claude asks separately, naming the library, licence and size of each download |
| U3 | Movement | AI motion (route C) or a Blender MCP to watch the keying live | Neither; headless scripts only |
| U4 | Movement | Keys | Space = jump, V = roll toward the cursor |
| U5 | Movement | Roll numbers | 4 m, 0.85 s in all (0.1 s wind-up), 3 s cooldown, no invulnerability frames |
| U6 | Movement | Jumping everywhere, the town included | Yes, with a 1 s cooldown |
| U7 | Screens | **Stage for select/create** (`work/tmp/screens/overview.png`): A = retail Constantinople (castle gate; +20–30 MB once) or B = Jangan palace steps. And: do you remember a stone castle gate behind the characters in retail? | A |
| U8 | Screens | The intro | 25 s real-time flight over Jangan at golden hour, skippable, first visit only |
| U9 | Screens | Intro captions | None |
| U10 | Screens | Time on the character stages | The server's time and weather, clamped to dusk at night |
| U11 | Screens | Music | `maintheme_cut` on every outer screen |
| U12 | Pets | **Pet design choices:** which pets and prices; the free quest pet | Grey Wolf 30,000, Three Footed Crow 45,000, Rabbit 5,000, Monkey/Squirrel/Raccoon dog 8,000 in Machun's Pet tab; Grass of Life 5,000; a level-5 quest gives a Rabbit |
| U13 | Pets | Retail's 28-day pet rental timer | No expiry |
| U14 | Pets | Hunger (HGP) | On, gentle: 30 % after ~2.9 h summoned; a potion restores 25 % |
| U15 | Pets | Reviving a dead attack pet | Both: a free revive after 10 minutes at 30 % HP, or Grass of Life at once at 50 % |
| U16 | Pets | Retail models only ("new 3D models for trees only for now") | Retail models and clips; pet textures may join a later B4 batch |
| U17 | Mail | **Mail limits:** attachments in town only; caps; postage | Attachments sent and taken in town, text anywhere; 50 mails per box, 5 stacks per mail, 30-day expiry with returns, postage 50 + 20 per stack, ≤ 30 sends per hour, ≤ 10 unread from one sender |
| U18 | Mail | May GMs read mail text? | Only mail the recipient reported, plus admins; every read audited |
| U19 | Friends | Caps | 50 friends, 100 blocks; removal is mutual |
| U20 | All | Other players' pets drawn per preset | 4 / 4 / 2 / 12 (Low / Medium / High / Ultra); Medium back to 8 only if PET-C measures ≤ 0.12 ms per pet |
| U21 | All | **Release go for R1 and R2** (D34), including the database backup before R1 (D35) | Claude prepares each release and asks; nothing deploys without a yes |
| U22 | All | **A playtest** with a second account or friends: the pet and mail checks, the roll's feel over Tailscale (the friends' RTT is unknown), a Mac (Safari) and a gaming laptop through the outer screens with the fps overlay | After I11, one session per release point |

**Nothing needs Meshy, Higgsfield or any upload in this wave.** No retail file leaves the PC. The Blender `.blend` and
glb files that hold the retail skeleton stay in `work/` (MOVEMENT §2.2).

---

## 11. Risks

- **Merge risk sits in the foundation.** W11-FS rewrites `walkEntity`, the mob-skills target type and the `dealHits`
  union in one pass. Mitigation: the whole server suite must stay unchanged at W11-FS hand-off, plus the seams test
  with a stub `Cos` attacker and target.
- **The Medium crowd with pets is tight** (15.2–16.3 ms projected, against 16.7). Mitigation: PET-C measures the real
  cost per pet; the cap is config (D33); the whole-game gate runs on both APIs.
- **Mid-CPU friends already miss 60 fps in the 20-mob crowd at Medium on WebGPU** (the ×1.5 projection of today's 14.4
  ms). Wave 11 does not fix that; BACKLOG item 9 does. Wave 11's rule is to add ≤ ~1.9 ms there.
- **The retail reading of `cameradata.txt` is inferred** without `sro_client.exe` (SCREENS §14). The user's memory
  (U7) settles it, and stage B is always there.
- **Wave-10 churn.** Camera keys authored too early end up under the new beach or inside new trees; so do jump and
  roll checks at the coast. D17 orders the work after wave 10's re-export, and `stages.test.ts` flags keys under the
  ground.
- **First-visit download** for the intro (≈ 50–80 MB of the town) at an unknown mini-PC upload rate. The logo beat
  and music stay up; the seen flag is set only when the flight plays.
- **WebGPU Effect retention** (LEAK-2) may keep the first stage `World` alive for the page's life. The heap rule
  allows one; the perf lane owns a real fix.
- **The roll's feel over Tailscale** is [unknown] (RTT). A 100 ms wind-up covers RTT ≤ 200 ms, and 150 ms covers
  300 ms (MOVEMENT Q7).
- **Space on a focused `<button>`** [unknown per browser]: MV-C blurs the focus and pins it with a test.
- **The v10 migration is one-way** for a v9 server (D35): the backup is the rollback.
- **Two Blender homes in wave 10** (D16) may still be unsettled when MV-A starts. It follows WAVE_PLAN4, and the
  default costs one folder move.
- **SQLite busy errors** between the server and the offline CLI: immediate transactions answer `busy`, never a
  second copy (PETS prototype).
- **Pet balance** (a level-20 wolf ≈ 45 raw DPS [projected]) is unknown until `sim.ts` runs with a pet;
  `PET_DAMAGE_RATE` is the knob.

---

## 12. Open questions (each has a default, so nobody waits)

Plan-level questions first. The spec-level questions below them keep their spec numbers and defaults, and the per-spec
lists stand as written.

| # | Question | Default |
|---|---|---|
| PQ1 | One release, or R1 (movement + social) before R2 (screens)? | Two release points; together if both are ready (D34) |
| PQ2 | Does a relog reset the 3 s roll cooldown? (Cooldowns are not persisted.) | Yes, accepted: a relog costs far more than 3 s |
| PQ3 | Does the roll pass through pets? | Yes; nothing collides (MOVEMENT Q3) |
| PQ4 | Should the selected character's pet stand beside it on the select stage? | Not this wave (D28) |
| PQ5 | A "try jump" on the select stage? | No |
| PQ6 | Mail and pet requests while mounted | Allowed (not in `MOUNTED_REFUSED`); the attack pet only defends while its owner rides (PETS Q11) |
| PQ7 | Where does the Movement module sit in the gate order? | After `guilds`, before `pets` (D3); only the refusal text can differ |
| PQ8 | Does a refused roll cancel an alchemy fuse? | No: `'roll'` is not in `FUSE_CANCELLERS` (D6). A jump does, even when refused (MOVEMENT Q12) |
| MOVEMENT Q1 | Roll direction | Toward the cursor; the facing when the cursor is not on the ground |
| MOVEMENT Q2 | Rolling in water after the coast wave | Allowed, with a splash |
| MOVEMENT Q4 | Mounted horse jump | Not in v1 |
| MOVEMENT Q5 | Nameplate and camera follow the jump height | No |
| MOVEMENT Q6 | Real vertical jumps over low fences | Never in v1; a later spec |
| MOVEMENT Q7 | The friends' RTT | A 100 ms wind-up, 150 ms after the feel check if needed |
| MOVEMENT Q8 | Female `Bone01`/`Bone02` | Not keyed |
| MOVEMENT Q9 | `moveTo` while stunned (a gap today) | Left; jump and roll check `held` themselves |
| MOVEMENT Q11 | `stopAction` cuts a roll short | Yes |
| SCREENS Q1 | What the `cameradata.txt` yaw measures | file 0 → 0, file 270 → π/2, pinned by a test |
| SCREENS Q3 | Retail slot layout and select animation | A 1.3 m arc of four, aspect-fitted; the selected one steps forward and plays `POSE` |
| SCREENS Q5 | Hand the stage `World` to the world screen | No this wave; a BACKLOG item 9 candidate |
| SCREENS Q6 | The active-mesh filter on stages | On (it measured cheaper) |
| SCREENS Q7 | European characters on select | No; Chinese only |
| SCREENS Q8 | A "replay intro" link on login | No; Options only |
| PETS Q1 | Grab radius | 12 m from the owner |
| PETS Q2 | Base pet bag | 28 slots, knob up to 140 |
| PETS Q3 | Grab into the character bag or the pet bag first | Character bag first |
| PETS Q4 | Aggressive mobs acquire pets on sight | No; only by retaliation |
| PETS Q5 | Pet EXP share | 100 % of the owner's kill share, capped at the owner's level |
| PETS Q7 | Friend removal | Mutual |
| PETS Q8 | Unique pet names | No |
| PETS Q9 | Pickup pets attackable | No |
| PETS Q10 | Pets on owner death | Dismissed, not dead; re-summon after respawn |
| PETS Q12 | Pet statuses and knockdown | None in v1 (D5 skips status rolls on a `Cos`) |
| PETS Q13 | Pet damage balance | `PET_DAMAGE_RATE` 1; tuned after `sim.ts` |
| PETS Q14 | Community tab style | Text tabs on `com_long_tab`, like Guild and Notice |
| PETS Q15 | `/pet` on the client | Never; the GM command keeps it (D31) |
| The relayed trees line | Scope of "new 3D models for trees only" in wave 11 | No geometry in wave 11 (D21); the trees are wave 10's |

---

## 13. Housekeeping

- The scratch the lanes port from stays until the port lands (§7 item 11):
  - `work/tmp/movement/`: the prototype and fact-check benches. The `.blend` and glbs are retail data and private.
  - `work/tmp/screens/`: the prototype, shots and 132 MB of scratch conversions.
  - `work/tmp/pets-social/`: retail layouts, strings, COS tables, `busy-snapshot.ts`.
- New scratch for this wave goes under `work/tmp/w11/` (the baseline and the hunt reproductions).
- Every in-browser frame measurement takes the GPU lock: `mkdir work/tools/gpu.lock`, then write `<label> <time>` to
  `owner`, and remove only a lock you created.
- A lane uses at most one browser tab of its own, closed when done, and never touches the shared dev servers (the
  SCREENS prototype's incident with another lane's tab).
- `work/tmp/w9-user-decisions.md` is the user's file: read it; append only what the user says, and only on the user's
  request.
- No lane commits; the lead integrates each step as in waves 7B–9.

---

## Appendix A: how this plan was checked (2026-09-29, HEAD `85e2e14`)

| Claim | How |
|---|---|
| DB v9; wave 10 adds no migration | `grep MIGRATIONS db.ts` (9 comments `// 1` … `// 9`); grep of COAST/SKY2/TREES for migration, `MIGRATIONS` and `db.ts`: 0 hits |
| No merged name collides | shell loop over the 37 new message names and 12 reasons against `protocol.ts`: 0 hits; `gm.ts` command keys listed (26) |
| Module order and gate semantics | `gameplay.ts` `this.modules = [...]`; `modules.ts` `askGates` (first veto returns; the requesting module is skipped) |
| Enter-world is module-driven | `gameplay.ts` `this.hook('enter', p, now)` |
| `walkEntity` and `tick` exclude `Cos` | `world.ts` `walkEntity(p: Player \| Mob, …)`, `tick` → `arrive` over `players` and `mobs` |
| Mob skills are `Player`-only | `mob-skills.ts` `swing(m, target: Player, now)`, `strike(…, primary: Player, …)`, `rollHits(…, t: Player, …)`, `land(…, t: Player, …)`; `gameplay.ts` `swing(m, target: Player)` |
| `FUSE_CANCELLERS`, `FUSE_LOCKED`, `MOUNTED_REFUSED`, `TRADE_ALLOWED`, `STALL_ALLOWED` contents | read in `alchemy.ts`, `mounts.ts`, `social/trade.ts`, `social/stall.ts` |
| i18n registration in `en.ts` | `en.ts` imports `enWeather`, `enSky`, … and spreads them; `i18n/index.ts` imports only `en` |
| A line per fail reason is required | `apps/game/test/hud.test.ts` "has a line for every refusal reason" |
| Options pages | `hud/options.ts` `registered: { graphics, interface, controls, audio }`; `registerOptionRow` users: `features/guild.ts`, `features/weather.ts` |
| Menubar has no badge | `hud/menubar.ts` `MenuBarEntry` fields |
| Keys free / taken | every `keys: [...]` registration listed (u, tab, z, s/k, q/l, p, n, m, i, home, h, g, f9, f8, f, c, hotbar keys, camera arrows); `WIDGET_KEYS` includes `pageup` |
| Chat prefixes | every `registerPrefix(` call listed outside `chat.ts` |
| Mock pattern | `net/mock/index.ts` `DEFAULT_MOCK_EXTENSIONS` (9 lane mocks) |
| Release in flight | `git status --short` (the modified and untracked files in "Repo state") |
| Wave 10 Blender homes | COAST.md CST-B row; TREES.md F17 and TR-A row |
| Budget bases | `work/tmp/w9-finish/budgets.md` tables; MOVEMENT §7; SCREENS §11; PETS §10; TREES §3.9; SKY2 "Whole wave" |
