# @sro/game: browser game client

The Silkroad-style front end: logo splash, login/register, server select, character select, character
creation, loading screen and the world with the first gameplay loop (monsters, combat, EXP and levels, loot,
inventory and equipment, death and respawn; see "Gameplay"). It is plain DOM/CSS UI over one Babylon.js canvas.
The renderer uses WebGPU when available and falls back to WebGL2 (`?engine=webgl` forces WebGL2).

Content is referenced by CodeName128 ids such as `CHAR_CH_MAN_ADVENTURER`, never by file paths.
`src/content/catalog.ts` maps ids to converted assets under `/out/`, so the art can be swapped later.

## Setup (one time)

```sh
# 1. Convert the Chinese player models and the five starter weapons.
#    The full list is under "Assets" below. The chinaman/chinawoman adventurers alone are enough to start.
pnpm sro convert res/char/china/chinaman_adventurer.bsr res/char/china/chinawoman_adventurer.bsr \
  res/item/china/weapon/sword_01.bsr res/item/china/weapon/blade_01.bsr res/item/china/weapon/spear_01.bsr \
  res/item/china/weapon/tblade_01.bsr res/item/china/weapon/bow_01.bsr

# 2. Export the original UI art, the resinfo layouts, the music, the camera data and the client fonts
#    to work/out/ui, work/out/music and work/out/fonts. Re-run it after pulling: it also writes the textless
#    art variants and the baked-text list the English UI depends on.
pnpm tsx packages/convert/src/tools/export-ui.ts        # --force rewrites existing PNGs and fonts

# 3. Gameplay content and HUD art (optional: the client and the mock fall back to builtin stand-ins).
#    packages/convert exports work/out/data/*.json (mobs, items, drops, npcs, shops, levels; docs/PROTOCOL.md
#    section 12). Then the item/skill icons and the HUD textures:
pnpm tsx packages/convert/src/tools/export-icons.ts     # work/out/icons + work/out/ui/hud.json; --force, --no-ui, --no-icons
```

Nothing from the client is copied into `apps/game` or its build output. The Vite dev and preview servers
serve `work/out` at `/out/` straight from disk, the same way the viewer does.

## Run

```sh
pnpm --filter @sro/game dev          # http://localhost:5180 (or: pnpm game)
pnpm --filter @sro/server dev        # the game server on :7000; Vite proxies /api and /ws to it
```

- **Server address.** Set `SRO_SERVER=http://host:port` to proxy to a server other than `http://localhost:7000`.
- **Output directory.** `SRO_OUT_DIR` overrides the `/out/` directory.
- **Build.** `pnpm --filter @sro/game build` writes `apps/game/dist`. That build contains code only; `/out/` must still be served next to it.

## URL parameters

| Param | Effect |
|---|---|
| `?mock=1` | Uses an in-browser mock server (`src/net/mock.ts`) instead of `/api` + `/ws`. Accounts, characters and their progress (level, EXP, inventory) persist in this browser's localStorage (`sro.mock.db`). The world has three wandering bots that chat now and then, monster nests, a potion merchant and the whole gameplay loop (see "Gameplay"). **F8** in the world simulates a network drop, which exercises reconnect. |
| `?mock=1&auto=1` | Registers or logs in as `tester`/`tester`, picks the first online server and lands on character select. Use it for quick visual checks. |
| `?skip=1` | Skips the logo splash. |
| `?engine=webgl` | Forces WebGL2 (wins over Options → Graphics → Graphics mode and the tab's fallback). |
| `?mock=1&gm=1` | Every mock account is a Game Master (admin), so the GM window and slash commands can be tried offline (see "GM"). Bots can be summoned, kicked and levelled. |
| `?mute=1` | Starts with the music muted. The mute toggle in the top-right corner is remembered either way. |

## Graphics problems (a black 3D view)

The 2026-10-05 incident: Chrome's GPU process crashed (low RAM, other GPU-heavy programs open) and the 3D view stayed
black while the HUD worked. What the client does about it:

- **Which renderer a load starts** (`src/gpu-loss.ts` `engineChoice`): `?engine=webgl`, then Options → Graphics →
  **Graphics mode** (Automatic / WebGPU / WebGL2 (compatibility), stored in `sro.settings`, applies after a reload and
  offers "Reload now", which goes straight back into the world), then this tab's WebGL2 fallback (sessionStorage
  `sro.gpu.webgl`), then WebGPU. Automatic also runs WebGL2 when the WebGPU adapter is a fallback/software one
  (SwiftShader, Microsoft Basic Render Driver: `src/engine.ts` `isSoftwareAdapter`). Choosing a mode in Options clears
  the tab's fallback. The engine in use shows in the stats line (Ctrl+Shift+F) and in Options ("Renderer").
- **Lost device** (`src/gpu-loss.ts`): the first lost WebGPU device reloads straight back into the world on WebGL2 for
  the rest of the tab; a lost WebGL2 context is restored in place or reloaded after 6 s; 4 losses in 10 min stop with a
  Reload button.
- **Black output** (`src/gpu-watchdog.ts`): during normal play the drawn frame is read back as 8×8 pixels every few
  seconds (2 s right after entering, a teleport, a graphics rebuild or the tab coming back; 15 s later on; nothing while
  loading or hidden). Three empty samples in a row (any time of day), or three pure-black ones while the sun is up, move
  a WebGPU tab to WebGL2 once per tab session (`sro.gpu.switched`); after that, or on WebGL2, the game shows the
  "3D view is black" help. `__sroBlackWatch.probe()` in the console logs what the next frame's readback sees.
- **What no page can detect**: Chrome's compositor dropping a correctly drawn canvas (software compositing after a
  GPU-process crash: both WebGPU and WebGL2 black, the readback still fine). The help covers it on request:
  Esc → **Screen black?**, and the **Screen black?** link on the login screen (`src/gpu-help.ts`). It says to open the
  game in another browser (Edge), or press Shift+Esc in Chrome → "GPU Process" → End process, then reload (other tabs
  stay open).

## Screens (`src/screens/*`, state machine in `src/app.ts`)

1. **Splash.** The "SILKROAD ONLINE" wordmark fades in and out, in the place and size of `outer/logo-big`. A click or key press skips it.
   - The main theme (`maintheme_cut.ogg`) starts on the first user gesture, because browsers block autoplay.
2. **Login.**
   - Art: `outer/login_window` with the original control rects from `resinfo/pstitle.txt`, the `blackbar_up_18` / `blackbar_down_notext` bars, the wordmark in the place of `outer/logo`, and the `login_deco_gradation` message strip for inline errors.
   - **Register** switches the third row to a password confirmation, because there is no website. After registering, the client logs in automatically.
   - **Remember** stores the username in localStorage (`sro.username`).
3. **Server select.**
   - Lists `GET /api/servers` in `outer/serverchange_window`, the client's textless server-list frame, laid out like `pstitle.txt` section UnityServer (title "Server List" as live text, Server / Players column heads). The row art is `server_select` / `server_rollover`. The list refreshes every 10 s.
   - Selecting a server opens the WebSocket and sends `hello`. The client waits for `welcome`, then shows character select.
4. **Character select.**
   - Up to 4 characters stand in a row on a lantern-lit plaza, playing STAND1, under a slow camera drift.
   - Clicking a character selects it: a gold ring appears and the `outer/info` panel floats above it with name, weapon, town, level and full HP/MP gauges. Double-click or Enter starts.
   - **Start** enters the world.
   - **Create** opens creation. It is disabled when all slots are used.
   - **Delete** opens the `warning_delete` dialog. You confirm by typing the exact name.
   - **Back** closes the session and returns to server select.
   - While models load, `loading/loading_charactercustom` is shown with a progress bar.
5. **Character creation.**
   - `outer/customize_window` (resinfo `pscharactercreatechina.txt`) holds:
     - the name field, with a live `nameCheck` 400 ms after typing (or via **Check**);
     - male/female buttons (`man_on`/`woman_off` art);
     - a **Model** carousel of the selectable Chinese models;
     - a **Weapon** carousel (sword/blade/spear/glaive/bow);
     - static Race/Town/Level rows.
   - The preview rotates on a pedestal in front of the `back_image` calligraphy. Hold the rotate buttons or left-drag to turn it; the zoom button frames the face.
   - The weapon hangs from the item's own attach bone, read from the sidecar `attachBone`: `Bip01 R HandMid` for sword/blade/spear/glaive and `Bip01 L Hand` for bow. It uses the SRO socket rule from docs/CONVENTIONS.md: only the bone's bind-pose world rotation is cancelled.
   - Weapon families with their own clips use them (for example `RUN_spear_run_fighter` and `STAND1_spear_stand_city_fighter` for spear/glaive, `RUN_bow_run_fighter` for bow).
   - **Create** opens the `warning_create` confirmation, sends `charCreate`, and returns to select with the new character highlighted.
6. **Loading.** The `loading/loading_zangan` palace band, cropped to x < 752 so the baked-in logo is left out, with the `loading_form` frame, the `gauge_loading` bar and a live "Now Loading..." caption. It tracks the real glb download and parse progress of every character in the `worldEnter` snapshot.
7. **World.** Monsters, combat, the HUD and its windows are described under "Gameplay".
   - **Scene and entities.**
     - A 2 km neutral ground plane with a 2 m / 10 m grid, at the spawn height (`src/world/ground.ts`). Gameplay code reads the ground only through `WorldGround.heightAt(x, z)` and `isGround(mesh)`, so the Jangan terrain replaces it in that one place.
     - Players, monsters, NPCs and ground items come from `worldEnter`, `spawn` and `despawn`, each with its model (and weapon) and a DOM name label.
   - **Movement.**
     - Left-click on the ground sends `moveTo`. The client never predicts; it plays the server's `move` (`MoveState`).
     - Moves are interpolated linearly from `from` to `to` at `speed`, using server time. Server time is `Date.now()` plus the offset estimated from `ping`/`pong` (lowest round trip of the last 8 samples), seeded from `worldEnter.world.serverTime`.
     - Clips: RUN at 3.2 m/s or faster, WALK below that, STAND1 when idle. `stop` snaps the position and yaw.
   - **Camera and input.**
     - MMO orbit camera: right-drag rotates, the wheel zooms, and the camera follows your character.
     - Enter opens chat (Enter sends, Esc cancels).
   - **HUD.** `src/hud` (see "Gameplay"); the top right shows engine, fps, ping and player count.
   - **Esc menu:** *Character select* sends `leaveWorld` and waits for `worldLeft`; *Logout* closes the socket and returns to login.
   - **Music:** `jangan_town.ogg`.
   - **GM accounts:** F9 GM window, slash commands, Ctrl + click teleport (see "GM").

**Reconnect.** When the socket drops, the session retries with backoff (0.5, 1, 2, 4, 8, 10, 10, 10 s) and resends `hello` with the same token. A banner shows while it retries.
- On success, the screens re-sync: character select re-requests `charList`, and the world re-sends `enterWorld` and rebuilds the entities from the new snapshot.
- An `unauthorized` reply to `hello`, such as an expired token, returns to login with a message.

## GM (Game Master)

GM accounts get an in-game GM window and slash commands. Players never see either: no window, no F9 hint.
The server side (roles, commands, audit log) is described in `apps/server/README.md`, section "GM".

**Making yourself a GM.** Register in the game as usual, then on the machine that runs the server:

```sh
pnpm gm grant <username>                 # role gm
pnpm gm grant <username> --role admin    # admin: also outranks gms (a gm cannot kick or summon an admin)
pnpm gm revoke <username>                # back to player
pnpm gm list                             # every gm/admin account
pnpm gm audit                            # the last GM commands, including refused ones
```

The change reaches a connected player within about a second (`role` message): the chat says
"You are now a Game Master (GM)..." and the F9 hint appears; a revoke closes the window again.
Without a server, `?mock=1&gm=1` makes every mock account an admin, and the mock implements the same commands.

**Keys.**

| Key | Effect |
|---|---|
| **F9** | Opens or closes the GM window (also typed in chat as `/gm`). |
| **Ctrl + left click** | Teleports you to the clicked ground point. |
| Enter / Esc in a window field | Enter runs the field's action; Esc leaves the field. |

**GM window** (`src/gm/window.ts`). The client's textless `outer/unity_window` frame, drawn as a 9-slice
(25 px brass header, 3 px border, translucent body), with `ifcommon` buttons, tabs, check box and the
`outer/slider` thumb; all text is live English (`gm.*` in `src/i18n/en.ts`).
Drag it by the header; its position and last tab are stored in localStorage (`sro.gm.window`).

| Tab | What it does | Sends |
|---|---|---|
| Players | Online players (name, role badges, level, position, region) from `who`. **Refresh**; per row **Go to**, **Summon**, **Kick** (a dialog confirms and takes an optional reason). Clicking a row picks the player for Self > Set level. The list refreshes after summon, kick, setlevel and teleports. | `who`, `tp @<name>`, `summon <name>`, `kick <name> [reason]` |
| Teleport | X / Z fields (metres, world frame) with **Teleport** and **My position**; **Places**: **Jangan** plus any place the server lists; **Cursor**: the ground point under the mouse, **Teleport here** and **Copy to X/Z**. | `tp <x> <z>`, `tp <place>`, `tp` (place list) |
| Broadcast | Announcement to everyone on the server, up to 300 characters (Ctrl+Enter sends). Everyone sees a banner at the top of the screen, on every screen including the lobby, and a `[Notice]` line in chat. | `notice <text>` |
| Self | Move speed slider x0.5 to x5 (**Apply**, **Normal**); **Invisible to players** (other GMs still see you, drawn faded); **Set level** of a picked or typed character, 1 to 20, offline characters too; **Heal** a named player or **Heal me** (full HP/MP, revives in place). | `speed <m>`, `invis on\|off`, `setlevel <name> <level>`, `heal [name]` |
| Spawn | Monster code field with suggestions from `mobs.json` (name and level), count 1 to 50, quick picks Mangnyang / Tiger / Tiger Girl; **Kill** an entity id, or **Kill target** (your current attack target). | `spawn <code> [n]`, `kill [id]` |
| Items | Item code field with suggestions from `items.json`, amount, and quick picks (potions, 1000 gold, return scrolls, the five weapons, arrows, shield, armour, rings). | `item <code> [n]` |
| Log | Every command the window or chat sent and each `gmResult`, with the time. **Clear** empties it. Kept for the page's lifetime. | |

The status line at the bottom of the window shows the last result or input error.
Input is checked before sending (`src/gm/commands.ts`): names follow the character-name rule, coordinates
must be numbers, levels 1 to 20, speed 0.5 to 5, notices at most 300 characters (split into arguments
of at most 100 characters that the server joins back with spaces). The server checks everything again.

**Chat.** A line starting with `/` is sent as ordinary chat; the server runs it as a GM command and never
broadcasts it. Replies (`gmResult`) appear as `[GM] ...` lines (blue, failures red; `help` and `who` are multi-line).
`/gm` alone opens the window locally. For a player, any slash line gets "Unknown command. Slash commands are for Game Masters."

| Command | Effect |
|---|---|
| `/help` | Lists the commands. |
| `/who` | Online players with position and region. |
| `/where [player]` | Position of a player (yourself without a name). |
| `/tp <x> <z>` · `/tp <place>` · `/tp <player>` · `/tp` | Teleport to coordinates, a place (`jangan`, `spawn`, ...), a player (`@Name` forces a player); `/tp` alone lists the places. |
| `/summon <player>` | Brings a player next to you. |
| `/kick <player> [reason]` | Disconnects a player; their client returns to login with "You were disconnected by a Game Master: <reason>" and does not reconnect. |
| `/notice <text>` | Server-wide announcement. |
| `/setlevel <player> <1-20>` | Sets and saves a character's level; labels update live. |
| `/speed <0.5-5>` · `/speed` | Your move speed multiplier (until you leave the world). |
| `/invis on\|off` | Invisible to players until you leave the world. |
| `/spawn <mob code> [1-50]` | Spawns monsters around you (not tied to a nest, no respawn), e.g. `/spawn MOB_CH_MANGNYANG 5`. Codes are case-insensitive. |
| `/item <item code> [n]` | Puts items in your bag; `/item ITEM_ETC_GOLD_01 1000` adds gold. |
| `/kill [entity id]` | Kills an entity, or your current attack target. No EXP or loot. |
| `/heal [player]` | Full HP/MP for you or a player; also revives in place. |

A chat line is at most 100 characters; use the Broadcast tab for longer notices.

**Messages the client handles** (protocol v1 GM additions, all screens that care):
- `welcome.role`, `worldEnter.role`, `role`: `Session.role`; the world shows or removes the GM window and hint.
- `notice`: banner (`src/ui/notice.ts`, queued, click to dismiss) plus a chat line in the world.
- `warp`: snaps the entity and cancels its interpolation; for yourself the camera jumps with you and the stub ground re-centres.
- `entityUpdate`: level and name labels (and the HUD for yourself); `invisible` fades the model and label for GM viewers.
  Players get `despawn` / `spawn` instead, which the world already handles.
- `gmResult`: GM window log and status line, and a chat line (except the window's own list queries).
- Close code 4010 (kick): the session closes for good with the kick reason.

## Gameplay

The server decides everything (docs/PROTOCOL.md). The client sends intents only (`moveTo`, `attack`, `pickup`,
`stopAction`, `respawn`, `statUp`, `item*`, `shop*`) and draws what comes back. Every intent is built by a
function that is tested against the shared validator (`src/world/intents.ts`, `src/hud/intents.ts`, `src/gm/commands.ts`).

**Controls.**

| Input | Effect |
|---|---|
| Left click a monster | Selects it (red ring, target window) and sends `attack`. The server runs you into reach and auto-attacks until it dies or you move, attack something else or pick something up. |
| Left click a player / NPC | Selects it (blue / yellow ring). |
| Left click a ground item | `pickup`; the server walks you there first. |
| Left click the ground | `moveTo`; it also ends auto-attack. |
| Right drag / wheel | Rotate / zoom the camera. |
| **I** / **C** | Inventory / character window. |
| **Esc** | Cancels a drag, else closes a dialog, else closes the top window, else clears the target, else opens the menu. |
| Enter | Chat (slash commands for GMs, see "GM"). |

**What you see.**
- **Monsters.** Name labels are yellow, red when the monster out-levels you, pink for uniques; champions read "Name (Champion)". A small HP bar appears once one is damaged. Clips: STAND1, WALK or RUN by speed, one ATTACKn per swing, DAMAGE1 on hits, DIE1 held until the corpse fades out.
- **Combat.** The attacker turns and plays its next attack clip, and hit *i* lands at the clip's *i*-th hit event (sword and blade swing twice). Floating numbers appear when you are the attacker or the target: white hits, orange CRITICAL, grey MISS / BLOCK, red damage taken, and green heals (potions, at least 5% of max HP). A kill plays DIE1 with the last hit.
- **Levels.** EXP and SP-EXP from kills rise above the EXP bar. A level-up shows a golden light column (for other players too) and a LEVEL UP banner.
- **Loot.** Gold piles and item boxes with a light beam (red while another player owns it). A pickup shows "... obtained".
- **Death.** The screen turns grey and a message box offers **Return to town** (`respawn`).

**HUD** (`src/hud`). The art comes from `work/out/ui/hud.json`, written by `export-icons.ts`, and all text is live English.
- **Player frame** (top left, `playerminiinfo`): portrait, name, level, HP/MP gauges and a **+** when stat points are free.
- **EXP bar** (bottom centre): level, EXP %, SP, SP-EXP and gold.
- **Target window** (top centre, `targetwindow`): kind gem, name, level and HP.
- **Centre-screen lines** for loot and refused actions (one short line per `ActionFailReason`, `action.fail.*`).
- **Inventory (I):** 48 slots with icons from `/out/icons`, stack counts and SRO-style tooltips.
  - Drag bag to bag: `itemMove` (move, merge or swap).
  - Shift-drag onto an empty slot: a split dialog, then `itemSplit`.
  - Drag onto an equipment slot: `itemEquip`. Right click: equip or use.
  - Drag out of the window: a drop dialog, then `itemDrop`.
- **Character (C):** 12 equipment slots (drag to and from the bag; right click unequips) and a status list with STR/INT **+** buttons (`statUp`; Shift spends 5).
- Nothing changes locally. The windows redraw only from `inventory`, `inventoryUpdate`, `stats` and `statsDelta`. Window positions are remembered (`sro.hud.<id>`).

**Mock mode** (`?mock=1`, `src/net/mock.ts` and `src/net/mock-rules.ts`) implements every gameplay message.
- **Content.** The export under `/out/data`, when the dev server has it, over the authored stand-ins of `src/content/builtin.ts`, so it also works before the export exists. Monster models come from `mobs.json`, else from `/out/index.json` (`mob/china/mangnyang` becomes `MOB_CH_MANGNYANG`).
- **Around the spawn.** Six Mangnyangs straight ahead at (0, -24), five more at (-22, -32), and four aggressive Tigers at (24, -38). With the export the Tigers are level 14 and kill a new character quickly. The potion merchant stands at (4, 3).
- **Monsters** wander. Aggressive ones notice you within about 9 m. All of them fight back, chase, give up about 22-24 m from their nest, walk home and heal. A killed monster is replaced 6-15 s later.
- **Rules.** Hit, miss and crit; EXP and SP; level-ups (+1 STR, +1 INT, +3 stat points, refill) with `levels.json`; loot with 30 s owner priority and a 120 s lifetime.
- **New characters** start with their weapon equipped, 250 gold, potions, return scrolls, clothes, a second weapon, a shield and a ring. Potions share a 1 s cooldown and the return scroll takes up to 5 s. HP and MP regenerate out of combat.
- **Death** stops everything; **Return to town** revives you at the spawn.
- `useSkill` answers `not_implemented`, like the server. All randomness uses a fixed seed.
- Incoming frames are checked with the shared validator (bad ones get `error bad_request`). Outgoing ones are logged with `console.error` if invalid.

**Tests.** `test/gameplay-loop.test.ts` plays the whole loop headlessly through the Session and the mock, once with the builtin content and once with the real export when it exists:
- farm nest Mangnyangs to a level-up, and pick up the loot;
- equip through the HUD's intents;
- GM spawn, item, kill and heal;
- die and respawn;
- compare the HUD's inventory with a fresh server snapshot.

Every frame in both directions passes `parseClientMessage` / `parseServerMessage`.

## Code map

| Path | What |
|---|---|
| `src/main.ts` | Boots the engine, loads the catalog, UI manifest, game text and fonts, registers screens. |
| `src/i18n/en.ts` | Every user-visible string of the client (typed keys, `{name}` placeholders). |
| `src/i18n/index.ts` | `t(key, vars)` for UI copy; `gameText(id, fallback)` for the game's own English textdata (`/out/data/strings.json`). |
| `src/ui/fonts.ts` | Registers the client fonts from `/out/fonts/` with the FontFace API. |
| `src/ui/wordmark.ts` | The interim "SILKROAD ONLINE" wordmark (inline SVG, live text). |
| `src/app.ts` | Screen state machine, scene ownership (login and server select share one backdrop scene), session status banner, toasts. |
| `src/engine.ts` | WebGPU → WebGL2 selection (the same logic as apps/viewer, deliberately copied). |
| `src/net/api.ts` | HTTP API client (`/api/register`, `/api/login`, `/api/servers`) and `GameError`. |
| `src/net/wire.ts` | WebSocket wire (JSON frames). |
| `src/net/session.ts` | Handshake, typed `on` / `request`, ping/pong, reconnect. |
| `src/net/clock.ts` | `ServerClock`, `sampleMove`, yaw convention. |
| `src/net/mock.ts` | Protocol v1 implemented in the browser, including gameplay and the GM commands (`?gm=1`). |
| `src/net/mock-rules.ts` | The mock's character progress, derived stats, bag operations and loot rolls (authored formulas, seeded RNG). |
| `src/gm/commands.ts` | GM command builders (validated against the shared protocol limits) and `gmResult.data` readers. No DOM. |
| `src/gm/window.ts` | The in-game GM window. |
| `src/ui/notice.ts` | Server-wide announcement banner (GM `notice`), shown on every screen. |
| `src/content/catalog.ts` | CodeName128 → glb, from `/out/data/characters.json` (tolerant reader) with a fallback to `/out/index.json`; `mob()`, `npc()`, `item()` and `itemName()` over the gameplay tables. |
| `src/content/gameplay.ts`, `builtin.ts` | Gameplay content tables (mobs, items, drops, NPCs, shops, levels): the export merged over authored stand-ins that use real codes. |
| `src/hud/*` | The HUD (`createHud`): player frame, EXP bar, target window, floating numbers, banners, death box, the inventory and character windows, and their drag rules and intents. |
| `src/three/models.ts` | ModelLibrary (one AssetContainer per glb per scene; the stand/walk/run/emote, ATTACK1-4, DAMAGE1 and DIE1 clips are kept) and CharacterActor (instanced skeleton, per-instance animations, weapon socket attach). |
| `src/three/backdrop.ts` | Placeholder plaza backdrop, art planes, selection ring. |
| `src/world/*` | Entities (interpolation, clips, labels, pick cylinders), the ground (`WorldGround`), drop visuals, effects (target ring, level-up column), chat box and world intents. |
| `src/ui/*` | DOM helpers, original-art windows and buttons (`_focus` / `_press` states), bars and dialogs. |
| `test/*.test.ts` | Clock and interpolation, catalog parsing, mock server and session protocol flows, i18n, GM command construction and GM flows against the mock, HUD intents and inventory state, world intents and a mock session, and the full gameplay loop (`gameplay-loop.test.ts`). Every message is checked with `parseClientMessage` / `parseServerMessage`. Run with `pnpm vitest run apps/game/test`. |

**Conventions.**
- **Yaw.** Yaw is radians about +Y, and 0 faces +Z, the glTF front of the converted models. A right-handed rotation maps +Z to (sin yaw, 0, cos yaw), so yaw = `atan2(dx, dz)`.
- **Scene handedness.** Scenes use `useRightHandedSystem = true`, like the viewer, so glTF node transforms apply unchanged.

**UI scale.** The windows keep their native pixel sizes and original control rects, and are scaled together by `--ui`:
`clamp(0.7, min(vw/1280, vh/860), 1.6)`. The letterbox bars stretch to the viewport width.

## Assets

- **`work/out/ui/index.json`** is written by `export-ui.ts`.
  - `images[key]` gives `{ file, src, width, height, format, content }`, where `content` is the bbox of texels with alpha > 8.
  - `layouts` lists the parsed `resinfo/pstitle`, `pscharacterselect` and `pscharactercreatechina` files as JSON, with control name, class, DDJ, rect and text key per section.
  - `music` lists the copied tracks.
  - `backdrop` holds the parsed camera files, raw.
  - `fonts` lists the copied fonts (`fonts/english.ttf`, `basic.ttf`, `chat.ttf`) with their source, face and role.
  - `bakedText` lists the images with text baked in (see "English UI"). Derived textless images carry `derived: { from, note }`.
  - About 315 PNGs are exported: every `interface/outer` texture except the Europe/Islam variants, the loading pictures and gauges, `ifcommon` buttons/frames/tiles, chat, player mini-info, underbar and system buttons.
- **Characters** come from `/out/data/characters.json` when that file exists, since another part of this workflow exports it. The reader accepts:
  - an array, `{ characters: [...] }`, or an object keyed by CodeName128;
  - the code in `codeName128`, `codeName`, `code`, `id` or the key;
  - the glb in `glb`, `model.glb`, `asset.glb` or `file`;
  - gender in `gender` or `sex`;
  - selectability in `selectable`, `playable` or `creatable`.

  Models missing from it come from `/out/index.json` by file name: `char/china/chinaman_x` becomes `CHAR_CH_MAN_X`.
  - The selectable list is the 26 Chinese player models (refobjchar 1907–1932: 13 male, 13 female).
  - An unknown id falls back to the adventurer of the same gender, then to a capsule, so no player is ever invisible.
- **Starter weapons** map by family to the converted `item/china/weapon/{sword_01,blade_01,spear_01,tblade_01,bow_01}`.
- **Converting all 26 models:**
  `pnpm sro convert res/char/china/china{man_{adventurer,bogy,fighter,merchant,monk,monkey,necromancer,nobleboy,performer,priest,scholar,tattoo,warrior},woman_{adventurer,assassin,bogy,fighter,fox,kangsi,kisaeng,merchant,necromencerb,necromencerw,noblegirl,scholar,warrior}}.bsr`.
  Each model is about 11 MB, mostly animation.

## English UI

The reference client is the Vietnamese vSRO build, so some of its UI art has Vietnamese text baked in.
The rule in this client: **all UI text is live English text** in the client's own fonts. Images keep only textless frames and art.

- **Strings.** Every user-visible string is in `src/i18n/en.ts` and read through `t()`, including the mock server's messages.
  Content text comes from the game's own English textdata instead: persona names and stories from `characters.json` (UIO_NEWCHAR_*), item names from `weapons.json`, and race and weapon family names from `strings.json` via `gameText()`.
  Custom quest and NPC text can follow either path.
- **Fonts** (`Media/fonts`, copied to `work/out/fonts` with ASCII names by `export-ui.ts`):

  | File | Source | Face | Used for |
  |---|---|---|---|
  | `english.ttf` | 영문서체.ttf ("English font") | Arial Rounded MT Bold, 240 glyphs, Latin-1 | titles, buttons, captions, names, wordmark (`--font-title`) |
  | `basic.ttf` | 기본서체.ttf ("basic font") | Qnix TaeUtum, full ASCII | labels and body text (`--font-body`) |
  | `chat.ttf` | 채팅서체.ttf ("chat font") | Qnix SeUtum (light TaeUtum), full ASCII | chat (`--font-chat`) |

  Each stack ends in a system serif (Georgia, Times New Roman), which is used when a font does not load.
- **Guard.** `export-ui.ts` writes `bakedText` into `work/out/ui/index.json`, listing every exported image with text.
  `Art.has()` is false for those, so they cannot reach a screen. `Art.hasCropped()` is the one exception: a picture whose text area is cropped away.
- **Audit** of the images the screens use (everything else they use, such as windows, buttons, gauges, bars and arrows, has no text):

  | Image | Text | Replacement |
  |---|---|---|
  | `outer/logo-big`, `outer/logo` | Vietnamese logo "Con Duong To Lua Online" | wordmark (`src/ui/wordmark.ts`), same box |
  | `outer/text-characterselect` | "Chon nhan vat" | live caption "Select Character" |
  | `outer/text-custom` | "Tao nhan vat moi" | live caption "Create Character" |
  | `outer/server_window` | header "Danh sach may chu" | `outer/serverchange_window` (textless frame) + live "Server List" |
  | `outer/blackbar_down`, `outer/blackbar_down_copyright` | copyright line (Joymax / VDC-Net2E) | `outer/blackbar_down_notext`, derived by `export-ui.ts` (text pixels refilled from the rows above) |
  | `loading/nowloading` | "Dang tai..." | live "Now Loading..." |
  | `loading/loading_zangan` | Vietnamese logo, bottom right of the band | shown cropped to x < 752, right edge faded |
  | `loading/loading_default`, `loading_china_*`, `start_loading_*` | Vietnamese logo | not used; `loading_charactercustom` (no text) is the fallback |

  The calligraphy on `outer/back_image` and the `redbar_*` bars is decorative Chinese brushwork, not UI text, and stays.

## Login / character-select backdrop (investigation)

What the original client stages behind the outer screens, and what this client does for now:

- **`Map/camera_path.txt`** has 3 rows. Each reads as `region X, region Z, position x y z, rotation, time`:
  ```
   78, 70   662.02, 800.0, 415.39   1.570796, 0, 0, 2190.31
   78, 70   697.25, 800.0, 286.25   1.570796, 0, 0, 2190.31
   78, 70   629.74, 800.0, 336.14   1.570796, 0, 0, 2190.31
  ```
  - The field names match the client's GM camera editor (`resinfo/ifcameradatawnd.txt`): TIME, REGION_X/Z, POSITION_X/Y/Z, ROTATION_X/Y/Z/W.
  - The editor exposes ROTATION as 4 fields. Here the first is exactly π/2 and the last is 2190.3, which fits a per-key time in ms better than a quaternion component, so the exact rotation encoding is still open.
  - Positions are region-local file units: a region is 1920 units = 192 m, and y = 800 is 80 m above the region datum. All three keys sit in **region (78, 70)**, which exists in Map.pk2 as `Map/70/78.{m,o,o2,t}` with terrain and a few objects.
  - **Reading:** the title/login screen is a slow camera flight between these keys over a real map region, drawn by the normal world renderer.
- **`Media/config/cameradata.txt`** has a header `-1` and then two rows:
  ```
  79 107   1205 80 396   30 10   0 50
  77 105   1466 79 1488  30 10 270 50
  ```
  - Each row reads as region X/Z, a region-local position (y ≈ 80 = 8 m), then four numbers: probably distance, height, yaw in degrees (0 / 270), and field of view.
  - **Reading:** these are the staged scenes for character select and character creation. They are separate map regions (`Map/107/79`, `Map/105/77`, both with objects), where characters are placed at a fixed spot and viewed with a fixed camera.
- **2D art on top of the 3D stage** comes from `resinfo/pscharacterselect.txt` and `pscharactercreatechina.txt`:
  - the letterbox bars (`blackbar_*`, `redbar_*` for creation);
  - title captions (`text-characterselect`, `text-custom`);
  - the info window;
  - the loading pictures (`loading_charactercustom` while character select loads).
  - The layouts are authored in a 1600×1200 space (`GDR_FADE` / screen rects).
- **Next steps, once the Jangan world renderer lands:**
  1. Load regions (78, 70), (79, 107) and (77, 105) through it.
  2. Play `camera_path.txt` as a looping spline for the login backdrop.
  3. Place the character-select row and the creation pedestal at the `cameradata.txt` positions.
  4. Confirm the rotation, time and last-four-number semantics against the original client.
- **For now,** `src/three/backdrop.ts` draws a simple lantern-lit plaza with a drifting camera for login, server select and character select, and a dark pedestal stage with the calligraphy art for creation.

## Known gaps

- **Gameplay protocol gaps.**
  - A `pickup` superseded while walking (by `moveTo`, `attack` or `stopAction`) has no fitting `ActionFailReason`. The mock answers `unreachable` with the message "Pickup cancelled.", and the client stays quiet about pickups it superseded itself.
  - `ITEM_ETC_AMMO_ARROW_01` has no equipment slot in `items.json` (category `ammo`), so bows cannot take arrows yet. vSRO wears them in the shield slot.
  - Skills are declared only: `useSkill` answers `not_implemented`.

- **Server choice.** The server list is informational: protocol v1 has one `/ws` endpoint and `hello` carries no server id. With one server process this is fine. Multiple servers would need an additive `hello.server` field or per-server socket URLs.
- **Creation sliders.** The original creation window also has height/volume/protector sliders. This client uses those rows for Race/Town/Level text only.
- **Model cache.** Model containers are cached per scene and freed when the screen's scene is disposed. Browsing all 26 creation models keeps them all in memory until you leave creation.
