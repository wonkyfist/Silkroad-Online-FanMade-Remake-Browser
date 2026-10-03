# UX gap audit (client polish, levels 1-20)

This document compares the current game client and server with what a player expects from vSRO 1.188 up to level 20. The goal is a game that feels complete and polished to the user's friends, not a tech demo. It lists every gap with a priority, an effort, the files involved and the lane that owns it. It ends with a build plan for two client-polish lanes that do not overlap the other lanes of this wave.

It is a spec, not code. Other lanes are designing skills, shops, sound (+ skill VFX), fields, and quests/party/GM editors right now. Their gaps are listed here so nothing falls between lanes, but they are **referenced, not redesigned**.

## Status tags

- **[confirmed]**: checked in the code (file and function named), in the client data under `work/extracted`, or seen in the running mock client.
- **[likely]**: the data or strong memory of SRO agrees, but it is not proven.
- **[unknown]**: a rule we pick; keep it in config or in one constant.

## Method

- Code read at `7f2cb98` plus the working tree of the integrating agent (`apps/game/src/**`, `apps/server/src/**`, `packages/shared/src/{protocol,validate,content}.ts`). Fact-checked again against HEAD `3afb304`: at that point `apps/` had no uncommitted edits (only `packages/nav` did), so every hook point below was re-read in committed code.
- The mock client (`http://localhost:5180/?mock=1&auto=1`) was run in the 800×450 browser pane: character select, world entry and the HUD. The console was read. Vite hot reloads from the integrating agent returned the page to character select twice, so no combat was observed live. Combat was audited from the code.
- SRO behaviour comes from the client's own text and layouts:
  - `Media/server_dep/silkroad/textdata/textuisystem.txt` (UTF-16): key captions (`UIIT_STT_TOGGLE_*`, `UIIT_CTL_SIT`, `UIIT_CTL_AUTOGET_TT`), key help (`UIIT_STT_INPUT_TTDESC_01..31`), chat commands (`UIIT_STT_CHAT_COMMAND_*`) and option captions;
  - `Media/resinfo/ifoption*.txt`;
  - the interface art folders under `Media/interface/`.

Effort: **S** ≤ 2 h, **M** ≤ 1 day, **L** > 1 day. Priority: **P0** makes the game feel broken, **P1** is expected by an SRO player, **P2** is nice to have.

Lane names used below:

- **skills**: docs/SKILLS.md §10: skill window, hotbar, buffs, casting presentation.
- **shops**: NPC talk, shop and sell windows.
- **sound**: SFX, ambience, the mixer, skill VFX.
- **fields**: the living world (grass and plants).
- **quests/party/editors**: quests, the party, GM owner editors.
- **UX-A / UX-B**: the two lanes proposed in §8.

The file names of the other lanes' specs are not known yet [unknown]. Cross-references use the lane name.

---

## 1. Baseline: what already works

| Area | What exists | Where |
|---|---|---|
| Boot | Boot text; fatal error `<pre>`; WebGPU → WebGL2 fallback; engine badge and music toggle in the top-right corner | `main.ts`, `engine.ts` [confirmed] |
| Splash | Wordmark fade; any key or click skips; `?skip=1` | `screens/splash.ts` [confirmed] |
| Login | Login/register toggle; remember username (`sro.username`); Enter submits; errors via `describeError` | `screens/login.ts` [confirmed] |
| Server select | List refreshed every 10 s; status and players; Enter connects | `screens/servers.ts` [confirmed] |
| Character select | 4 slots on the plaza; info window; delete requires typing the name; Enter starts | `screens/charselect.ts` [confirmed, seen] |
| Character create | Name check; model, height, volume, cloth and weapon sliders; confirm dialog | `screens/charcreate.ts` [confirmed] |
| Loading | Full-screen picture with gauge; world 72% and entity models 28% of the bar | `screens/loading.ts`, `world.ts showLoading` [confirmed] |
| Player frame | Portrait; name and level; HP/MP gauges with numbers; low-HP class; `+` button when stat points are free | `hud/player.ts PlayerFrame` [confirmed] |
| EXP bar | Level; EXP % with two decimals and numbers; SP and SP-EXP; gold; "+EXP" gains rising | `hud/player.ts ExpBar` [confirmed] |
| Target window | `tw_type1` frame; kind gem; name; level; HP bar and numbers; dead state | `hud/target.ts` [confirmed] |
| Combat feedback | Attack clips with hit *i* at the *i*-th clip event; DAMAGE1 overlay; DIE1; floating numbers (hit, crit, miss, block, taken, heal); target ring; hover highlight | `world.ts onCombat`, `world/entities.ts`, `hud/effects.ts` [confirmed] |
| Level up | Light column; centre banner with "Press C"; chat line; mob tones refreshed | `world.ts 'levelUp'`, `hud/effects.ts LevelUpBanner` [confirmed] |
| Death | Desaturate; rebirth box with "Return to town"; "killed by X" chat line; re-enabled after a refusal | `hud/death.ts`, `world.ts onSelfDeath` [confirmed] |
| Loot | Click a ground item → `pickup`, and the server walks you there; "obtained" centre lines; ownership tint; labels within 22 m | `world.ts clickEntity`, `hud/index.ts announceGains`, `world/entities.ts` [confirmed] |
| Inventory (I) | 48-slot lattice; drag and drop move/merge/swap; shift-drag split with count; drag outside to drop with count confirm; right-click use/equip; tooltips (type, degree, stats, +N, durability, use, requirements with red when unmet, sell price) | `hud/inventory.ts`, `hud/intents.ts`, `hud/items.ts` [confirmed] |
| Character (C) | 12 equipment slots around an SVG figure; status list; STR/INT `+` (shift = 5) → `statUp`; the server has `stat_points` (`db.ts` migration, `gameplay.ts` statUp) | `hud/character.ts`, `apps/server/src/gameplay.ts:545` `statUp()` [confirmed] |
| Windows | Draggable; position remembered (`sro.hud.<id>`); z-order; Esc closes the top window; clicks never reach the world | `hud/window.ts` [confirmed] |
| Chat | One input (Enter/Esc); 120-line log; kinds local/system/self/error/gm/notice; slash lines go to the server as GM commands | `world/chat.ts`, `apps/server/src/connection.ts` chat case [confirmed] |
| Minimap | Client minimap tiles, north up, round; mob/NPC/player/item dots; wheel zoom (5 steps) | `world/jangan/minimap.ts` [confirmed, seen] |
| Esc menu | Character select / Logout / Resume | `world.ts openMenu` [confirmed] |
| Camera | Right-drag rotate; wheel zoom 2.5–40 m; beta limits; ground collision; smooth follow | `world.ts buildWorldScene`, `world/jangan/camera.ts` [confirmed] |
| Click to move | Green torus marker that grows and fades in 0.8 s | `world.ts showMarker` [confirmed] |
| Music | jangan_town / jangan_field by town area with 8 m hysteresis; cross-fade; mute remembered | `audio.ts`, `world.ts updateMusic` [confirmed] |
| Network | Reconnect with backoff (8 tries; `RECONNECT_DELAYS_MS` sums to 45.5 s of waiting, plus each attempt's connect time); banner; `enterWorld` re-sent on resume; fatal close codes (replaced, kicked, expired, version) return to login with a message | `net/session.ts`, `app.ts onSessionStatus` [confirmed] |
| Server | Regeneration out of combat; safe zone; potions with cooldown group; return scroll; one socket per account | `apps/server/src/gameplay.ts` [confirmed] |

The base is solid. Most of what is missing is polish around it, plus the systems that other lanes own.

---

## 2. Top of the list

What a friend notices in the first five minutes, in order:

1. **No skills, hotbar or potions on keys** (P0, the skills lane). The only attack is left-click auto-attack. Potions work only by right-clicking them in the bag.
2. **No sound effects** (P0, the sound lane). Swings, hits, level-up, pickup and UI clicks are all silent; only the music plays.
3. **Clicking an NPC only targets it** (P0, the shops lane). The Herbalist cannot sell a potion.
4. **Name tags pile up** over mob packs (UX-B, P0). Ten `Mangyang Lv 1` labels overlap into an unreadable block [confirmed, seen in the mock]. The display name is "Mangyang" (`mobs.json` `MOB_CH_MANGNYANG`), and the label reads `Lv 1` (`world.level`) [confirmed]. Inside the playable 3×3 Jangan regions, the only nests are 8 Mangyang nests of 15 mobs each (`nests.json` entries with `inConvertedRegion: true`) [confirmed], so packs of level-1 Mangyangs are what friends see first.
5. **Tech-demo overlays** (UX-A, P0):
   - the `WebGPU | fps | ping | N online | draws` line, in dark text (`#3d3a30`) at `right: 8px; top: 30px`. It sits between the corner badge (`top: 6px`) and the top of the minimap (`top: 48px`) [confirmed `style.css .hud-stats`, `minimap.ts`]; the author saw it crowd the minimap in the 800×450 pane [seen];
   - the engine badge and "Music: Off" corner button;
   - one long help string along the bottom right.
6. **No options window** (UX-A, P0). There is no volume, quality, fullscreen or UI scale setting. Quality is only the `?quality=` URL parameter (`world/jangan/ground.ts urlQuality`), although `World.setQuality()` in `packages/world-render/src/world.ts` can already change it live [confirmed].
7. **The body and chat fonts fail to load** (UX-A, P1). Chrome rejects `basic.ttf` and `chat.ttf` ("OTS parsing error: bad table directory searchRange … glyf: Failed to parse table"), so labels and chat fall back to Georgia serif [console, seen by the author]. The header part is [confirmed]: both files have 13 tables with `searchRange` 48 and `rangeShift` 128, where the spec values are 128 and 80. `english.ttf` (14 tables, 128/96) is valid. OTS normally only warns about a bad searchRange. The fatal part is most likely the `glyf` table [likely], so fixing the header alone may not be enough.
8. **A browser refresh logs you out** (UX-A, P1). Refresh returns to splash and login, because the token is kept only in memory (`app.token`) [confirmed].
9. **Chat is one channel with no whisper and no input history** (UX-B, P1). "Local" chat is actually world-wide (`world.broadcast` in `connection.ts`) [confirmed].
10. **No world map (M), no minimap zoom buttons or coordinates, and no level-difference colours** beyond red and yellow (UX-B, P1).

---

## 3. Gap list by area

Columns: ID, gap, priority, effort, files, owner.

### 3.1 Login flow and error states

| ID | Gap | P | E | Files | Owner |
|---|---|---|---|---|---|
| L1 | **Refresh keeps you logged in.** After login, put `{token, expiresAt, username}` in `sessionStorage['sro.session']` (per tab, gone when the tab closes). On boot, when it exists and is not expired: skip the splash, `openSession`, and go to charselect (or to server select when the connect fails). Logout clears it. A stale token clears it too: the server answers the `hello` with `error {code: 'unauthorized', re: 'hello'}`, and `session.ts` closes with reason `'unauthorized'` [confirmed]. `expiresAt` exists only in `screens/login.ts enter()` (`res.expiresAt`), so it has to be kept on `App` there [confirmed]. Browsers copy `sessionStorage` when a tab is duplicated [likely], so a duplicated tab resumes the same token and replaces the first tab's socket (close 4000). That is acceptable. | P1 | S | new `net/resume.ts`; hooks in `main.ts`, `screens/login.ts enter()` (store `expiresAt`), `screens/servers.ts connect()` (after `app.setSession`), `app.ts logout()` and `app.ts onSessionStatus` | UX-A |
| L2 | **Fonts fail to decode** (see §2 item 7). Quick fix: end the `--font-body`/`--font-chat` stacks in a clean sans (`Tahoma, Verdana, 'Segoe UI', sans-serif`) instead of Georgia. Root cause: the export copies the TTFs as-is (`export-ui.ts exportFonts`) [confirmed]. The table directory is wrong [confirmed, see §2 item 7], and `glyf` is probably malformed too [likely]. Re-emitting only the header may not be enough. Rebuild the fonts in the export: subset them to Latin-1 with a font tool, which rewrites `glyf`/`loca`, or ship a web fallback font. Whichever fix is chosen, verify it in Chrome. | P1 | S (fallback), M (re-export) | `apps/game/src/style.css` lines 7–9 (`:root` stacks); `packages/convert/src/tools/export-ui.ts` FONTS | UX-A |
| L3 | **Engine badge and music toggle** sit top-right on every screen. Move the engine name into the options' About line and drop the badge. The mute button belongs to the sound lane: docs/SOUND.md §5.12 turns the corner button into the master mute (`corner.soundOn/Off`, `localStorage['sro.muted']`) [confirmed in SOUND.md]. UX only removes the badge and does not move or hide the mute. | P1 | S | `main.ts` corner block (badge only); new `hud/options.ts` | UX-A |
| L4 | **Title backdrop is a synthetic plaza of red pillars** (`three/backdrop.ts buildPlaza`), not Jangan. The original login flies over a real scene (`Media/config/option.txt IntroName = "script\intro\roc.txt"` [confirmed]). Loading Jangan behind login also warms the asset cache, so entering the world gets faster. | P2 | M | `screens/title.ts`, `screens/charselect.ts`, `world/jangan/ground.ts` | later (art upgrade) |
| L5 | **Loading screen has no tips.** Add a rotating tip line (keys, stat points, potions) from `i18n`. | P2 | S | `screens/loading.ts` | UX-A |
| L6 | **Stale client after a deploy.** Before its 4002 close, the server sends `error {code: 'version_mismatch', message: 'server speaks protocol v1', re: 'hello'}`. `session.ts` ends the session on that handshake error with `message: msg.message`, so the login screen shows the raw server text, not `net.versionMismatch` [confirmed `net/session.ts` handshake branch, `connection.ts hello()`]. Map `reason === 'version_mismatch'` to "A new version is available: reload" and add a Reload button. | P2 | S | `app.ts onSessionStatus`, `screens/login.ts` | UX-A |
| L7 | Character select has no "last played" preselect across reloads. Remember the last character id in `localStorage['sro.lastChar']`. | P2 | S | `screens/charselect.ts` | UX-A |

### 3.2 HUD

| ID | Gap | P | E | Files | Owner |
|---|---|---|---|---|---|
| H1 | **Dev stats line visible to players**, drawn at `right: 8px; top: 30px` in dark text just above the minimap [confirmed, `style.css .hud-stats`, seen]. Move it to a `PerfOverlay` that is hidden by default: Options → Interface → "Show FPS", or `Ctrl+Shift+F` (a binding with `mods`, §4.1, because the KeyMap skips other chords). Place it top-left under the player frame, in light text on a shade. | P0 | S | new `hud/perf-overlay.ts`; hook in `world.ts` (the `stats` element and the `statT` block) | UX-A |
| H2 | **Help string** (`world.help`, 153 characters [confirmed]) overlaps the chat and EXP bar at small widths [confirmed, seen]. Replace it with `H: help` (hidden after the first 3 sessions) and a Key help window (H). | P0 | S | `world.ts` (`help` element), `hud/index.ts` (helpKeys), new `hud/keyhelp.ts` | UX-A |
| H3 | **System menu bar is missing.** SRO has the bottom-right system buttons, and their art is exported but unused: `mainpopup/main_sysbutton_{character,inventory,skill,quest,party,action}` [confirmed in `work/out/ui/hud.json`]. Build a `MenuBar` of buttons that toggle windows. A window lane registers its button, and a button without a registered window stays hidden. Add an Options button using `system/sys_button` (exported by `export-ui` into `work/out/ui/index.json`, not `hud.json` [confirmed]; whether it looks like a gear is [unknown]). | P1 | S | new `hud/menubar.ts`; hook in `hud/index.ts` | UX-A |
| H4 | **Target window shows no level difference or variant.** The art exists: `targetwindow/tw_gem_{weak2,weak1,normal,strong1,strong2}`, `tw_icon_{normal,champion,giant,titan,elite,unique}` and `tw_type1..4` [confirmed]. Pick the gem by level band (§4.2) and show the variant icon. NPCs keep `tw_gem_npc` and `tw_hp_npc`. `MobVariant` also has `'party'`, which has no `tw_icon_*`, so it shows no icon [confirmed `content.ts MOB_VARIANTS`]. At levels 1–20 the nest mobs list only `normal`/`champion`/`giant` variants, plus the unique Tiger Girl [confirmed `mobs.json`], so titan and elite icons appear only through GM `spawn`. | P1 | S | `hud/target.ts` (`set()`; `TargetInfo` + `band`, `variant`); `world.ts targetInfo()` | UX-B |
| H5 | **Berserk (Hwan) gauge missing.** See §4.5 for the decision: in scope as P2, after skills. Art: `playerminiinfo/pmi_jahwan*` [confirmed exported]. | P2 | M | `hud/player.ts`; server (§5.4) | later wave (after skills) |
| H6 | **Damage numbers are DOM text** (hit white, crit orange with "CRITICAL", miss/block grey, taken red, heal green) [confirmed]. SRO draws them with digit art: `interface/hitcount/hitcount_{0-9}`, `_enemy_`, `_player_`, `critical_*`, `blocking_*` [confirmed, not exported]. | P2 | M | `hud/effects.ts Floaters`; `packages/convert/src/tools/export-icons.ts HUD_SELECTION` + `interface/hitcount` | UX-A (P2 tail) |
| H7 | **Low-HP warning.** `.low-hp` exists [confirmed], but the `pmi_hp_effect_caution*` art is unused. Pulse it, plus a red vignette at ≤ 25% HP. Sound: the sound lane's heartbeat/alarm, if any. | P2 | S | `hud/player.ts`, `hud/ux-style.ts` | UX-A |
| H8 | **Area banner.** SRO names the area you enter. We have town rectangles (`world/jangan/zones.ts`). Show "Jangan" / "Jangan Outskirts" [unknown name] in fading centre text when `townAt` changes, reusing the music hysteresis. | P2 | S | `world.ts updateMusic` hook → `hud` banner | UX-B |
| H9 | **Buff bar and effect icons** under the gauges; target effects. | P1 | — | skills lane file, name not fixed (SKILLS.md §10.3 only says "a bar under the HP/MP gauges") [unknown] | skills |
| H10 | **Hotbar / quick slots** (1–0, F1–F4), including potions and cooldown sweeps. | P0 | — | `hud/hotbar.ts` (skills) | skills |
| H11 | **Party member frames** under the player frame. | P1 | — | party | party |
| H12 | **Quest tracker** (right side). | P1 | — | quests | quests |
| H13 | **EXP gain in chat.** SRO echoes gains in the system log [likely]. Add "You gained X EXP and Y SP-EXP", off by default (option). The HUD has no chat reference; `world.ts` owns `chat` and already receives `statsDelta` with `gain` [confirmed]. | P2 | S | `screens/world.ts` `case 'statsDelta'`: `if (msg.gain && settings.get().ui.expInChat) chat.add('system', …)` | UX-B |

### 3.3 Windows

| ID | Gap | P | E | Files | Owner |
|---|---|---|---|---|---|
| W1 | **Options window (Esc → Options).** SRO has Audio (BGM / FX / Environment volume, "Off" [confirmed `ifoption_audio` keys `UIIT_STT_BGMSETTING/EFFSETTING/ENVIRONMENT/SOUND_ELEMINATE`]), graphics quality (High/Med/Low [confirmed `UIIT_STT_GRAPHIC_QUALITY_*`]), sight range (4 steps [confirmed `UIIT_STT_SIGHT_{VERY_SMALL,SMALL,LARGE,VERY_LARGE}`]), camera views (Free / Third person / Quarter [confirmed]), name view, mouse and shortcut settings. Tabs, settings and storage: §4.3. **Audio is not in the UX store.** docs/SOUND.md owns the volumes (`audio/settings.ts`, `localStorage['sro.audio.v1']`) and its own window (`hud/sound-settings.ts`, opened by a "Sound" button in the Esc menu). The Options Audio tab is just a button that opens that window. | P0 | M | new `settings.ts`, `hud/options.ts`; hooks §8 | UX-A |
| W2 | **Key help window (H).** It lists every binding from the KeyMap (§4.1), grouped. SRO has a help window (`UIIT_STT_INPUT_TTDESC_08` "Opens the help window" [confirmed]; the key letter is not in the text [unknown] → H). | P1 | S | new `hud/keyhelp.ts` | UX-A |
| W3 | **Unusable items are not marked in the bag.** SRO tints items you cannot equip red [likely]. `SlotView` gets a `blocked` class when `reqLevel > level`, `reqGender` does not match, or `race === 'europe'`. The tooltip compares only the level: `bad` when `level < reqLevel`. It lists gender without checking it and always marks europe `bad` [confirmed `items.ts tooltip`, lines 174–181]. So `canUse` must derive gender from the model code (`CHAR_CH_MAN_*`/`CHAR_CH_WOMAN_*`; the HUD keeps `model`). `items.json` has only `race` `china` and `any` [confirmed], so the europe rule never fires today. `SlotView.set(stack)` has no player context [confirmed], so the flag is passed in: `set(stack, blocked = false)`. It is computed in `InventoryWindow.render()/update()`, and the bag re-renders when the level changes. | P1 | S | `hud/slots.ts SlotView.set`, `hud/inventory.ts` render/update, `hud/items.ts` (export a `canUse(def, stats, model)`) | UX-A |
| W4 | **Potion cooldowns in the bag.** Items sharing a `use.cooldownGroup` should show the sweep after use. SHOPS.md already designs this: the new `itemCooldown {group, readyInMs, totalMs}` message, `SlotView.setCooldown(readyAt, totalMs)` in `hud/slots.ts`, and `hud.itemCooldowns: Map<group, {readyAt, totalMs}>` for the skills lane's hotbar (SHOPS.md §4.1, §8.3 item 4, Lane E) [confirmed in SHOPS.md]. | P1 | — | `hud/slots.ts` (shops lane E) | shops (lane E); UX adds nothing |
| W5 | **New-item highlight.** Items that arrived since the bag was last opened glow until hovered. | P2 | S | `hud/inventory.ts`, `hud/inventory-state.ts` | UX-A |
| W6 | **Equipment view figure** is a flat SVG outline [confirmed `character.ts FIGURE_SVG`]. SRO shows the character [likely]. Render a small second Babylon view or a snapshot of the self actor. | P2 | L | `hud/character.ts` | later (art upgrade) |
| W7 | **Stat allocation shortcuts.** `+` is 1, and shift is 5 [confirmed]. Add Ctrl = 10 and Alt = all, mirroring the SRO convention in `UIIT_STT_GNGWC_ABILITY_UP_TOLLTIP` ("Ctrl + Right-Click adds 10 … Alt + Right-Click enters the maximum" [confirmed]). One request each; `points` ≤ `MAX_STAT_POINTS_PER_REQUEST`. | P2 | S | `hud/character.ts plusButton` | UX-A |
| W8 | **Item destroy.** Not a vSRO action for normal items [likely]; you drop them. Dropping exists with confirmation [confirmed]. No gap. | — | — | — | — |
| W9 | **Rarity colours** (SoX gold/blue). No rare item exists up to level 20: 0 `*RARE*` codes in `items.json` [confirmed]. Normal items stay white; a +N item gets a light-blue title. | P2 | S | `hud/items.ts tooltip`, `hud/ux-style.ts` | UX-A |
| W10 | **Skill window (S).** SKILLS.md §10.3 says "Skill window (K)", but SRO's key is **S**: `UIIT_STT_TOGGLE_SKILL` "Skill ( S )" [confirmed]. Recommend S, with K as an alias. | P0 | — | `hud/skills.ts` | skills |
| W11 | NPC talk window, shop, sell (drag to shop), repair. Designed in docs/SHOPS.md (`npcTalk`, `npcDialog`, `hud/npc-dialog.ts`, `hud/shop.ts`) [confirmed]. | P0 | — | shops | shops |
| W12 | Party window (P), quest window (Q), GM editors. | P1 | — | respective lanes | quests/party/editors |

### 3.4 Chat

| ID | Gap | P | E | Files | Owner |
|---|---|---|---|---|---|
| C1 | **Input history.** Up and Down recall the last 30 sent lines, per session. | P1 | S | `world/chat.ts` | UX-B |
| C2 | **Whisper.** `/w name text` and `/whisper name text` [confirmed as SRO chat commands `UIIT_STT_CHAT_COMMAND_WHISPER1..5`]. `/r text` or `/reply text` answers the last whisperer [confirmed: `…REPLY1..4` = `/Reply`, `/r`, `/re`, `/R`]. The client parses these before the GM path. No GM command is named `w`, `r`, `re`, `whisper` or `reply` [confirmed: server `gm.ts COMMANDS` and `mock.gm.help`]. Protocol: §5.1. Lines are pink/violet, `To name:` / `From name:` (`UIIT_CHATERR_WHISPER_TO_MESSAGE` "TO" and `UIIT_CHATERR_WHISPER_FROM_MESSAGE` "FROM" [confirmed]). | P1 | M | `world/chat.ts`; new `apps/server/src/chat.ts`; shared protocol/validate | UX-B |
| C3 | **Tabs.** All / Whisper / Party / System filter the log. The client-side kind is already on each line. Art: `chattingwnd/chat_tab`, `chat_window*`, scroll arrows [confirmed exported by `export-ui` into `work/out/ui/index.json`, unused]. | P1 | S | `world/chat.ts`, `hud/ux-style.ts` | UX-B |
| C4 | **Party chat.** SRO types `#text` (`UIIT_MSG_CHATWND_HELP_PARTYMSG` "Party chat [#what you want to say]" [confirmed]). ChatBox exposes `registerPrefix('#', send)` and the party lane registers it. | P1 | — | party | party |
| C5 | **Scroll-back.** The log is capped at 120 lines and scrolls to the bottom on every line [confirmed]. Do not jump while the user is scrolled up; show "new messages ↓". Mouse-wheel over the log must not zoom the camera (it does not; the DOM eats it [likely]). | P1 | S | `world/chat.ts` | UX-B |
| C6 | **"Local" is world-wide.** `connection.ts` broadcasts to `game.world` [confirmed]. For a handful of friends this is a feature. Keep it and label the tab "All". A range-limited local chat would be `VIEW_RANGE`; it is not needed now. | — | — | — | decision |
| C7 | **Clickable names.** Click a name in chat to start `/w name `. Shift-click an item in the bag to link it `[Item Name]`. Item links need a protocol field [unknown]; P2, later. | P2 | S (names) | `world/chat.ts` | UX-B |
| C8 | **Chat bubbles** over heads (`ifchatbubblewindow` exists [confirmed resinfo]). Show the last line for 5 s above the speaker's name tag. | P2 | S | `world/nameplates.ts` | UX-B |
| C9 | **Timestamps and fading.** The log fades to transparent after 10 s idle and returns on hover or while typing. | P2 | S | `world/chat.ts` | UX-B |

### 3.5 Minimap and world map

| ID | Gap | P | E | Files | Owner |
|---|---|---|---|---|---|
| M1 | **Zoom buttons, coordinates and area name** on the minimap. Art: `minimap/mm_window`, `mm_zoomin*`, `mm_zoomout*`, `mm_map_button*`, `mm_sign_*` [confirmed in `Media/interface/minimap`, not exported]. SRO shows world coordinates. Formula [likely]: `X = (rx − 135)·192 + lx`, `Y = (rz − 92)·192 + lz` in metres. Our origin is the south-west corner of region (168, 97), id 25000, and glTF z points south (manifest `space.originRegion`, `axes.north = [0,0,-1]` [confirmed]). So `X = 6336 + x` and `Y = 960 − z`. The manifest spawn (96.9, −136.9) reads (6432.9, 1096.9) ≈ (6433, 1097) [math confirmed; the formula itself is likely]. | P1 | S | `world/jangan/minimap.ts`; `export-icons.ts HUD_SELECTION` + `interface/minimap` | UX-B |
| M2 | **Marker icons** instead of dots (`mm_sign_{monster,npc,otherplayer,party,questnpc,unique,character}`). Uniques get their own icon. Party and quest markers come from those lanes through `HudMinimap.addMarkerSource()`. | P2 | S | `world/jangan/minimap.ts` | UX-B |
| M3 | **World map (M).** SRO has "the whole map" (`UIIT_STT_INPUT_TTDESC_21` [confirmed]; the letter is [likely] M). For Jangan-only, draw the whole minimap atlas at fit scale in a HudWindow: player arrow, NPC names (shop NPCs labelled by their shop), a town outline, and mob nest areas with level ranges (from `nests.json` [confirmed exported]; SRO lists "6 lv. higher monsters" `UIIT_STT_WORLDMAP_LEVEL_MONSTER_LIST` [confirmed]). The world today is only 9 regions (x 167–169, z 96–98, a 576 m square), and its only nests are the 8 Mangyang (Lv 1) nests [confirmed `manifest.json`, `nests.json` `inConvertedRegion`]. The map lists whatever nests the server actually spawns, so it grows with the world. Click-to-walk is P2: it walks a straight line, and the server stops at the first obstacle. | P1 | M | new `hud/worldmap.ts` | UX-B |
| M4 | **Minimap zoom persistence.** Keep the zoom in `settings.ui.minimapZoom`. | P2 | S | `world/jangan/minimap.ts` | UX-B |

`world-render` Minimap can drive a second canvas without changes. `attach(canvas)` swaps the target [confirmed `packages/world-render/src/minimap.ts`], so the world map attaches, renders and re-attaches the HUD canvas at ≤ 4 Hz while it is open. `Minimap` keeps one `ctx`, and `HudMinimap.update()` never re-attaches, so the re-attach must happen synchronously in the same call [confirmed]. `toPx(x, z)` is affine at 1/0.75 px per metre (`M_PER_PX = 0.75`), so a map click inverts as `x = (px − toPx(0, 0)[0])·0.75`, `z = (py − toPx(0, 0)[1])·0.75` [confirmed].

### 3.6 Controls and camera

| ID | Gap | P | E | Files | Owner |
|---|---|---|---|---|---|
| K1 | **One KeyMap.** Today each module listens on `window` itself (`world.ts`: Enter, Esc, F8, F9; `hud/index.ts`: I, C, Esc in capture). Skills adds 1–0, F1–F4 and S/K; party P; quests Q; and so on. Conflicts and "typing in chat triggers a window" bugs follow. Replace them with one registry (§4.1). | P0 | S | new `hud/keys.ts`; hooks `hud/index.ts`, `world.ts` | UX-A |
| K2 | **SRO key table** (§4.1): C, I, S, Q, P, M, H, G, N, T, Esc, Enter, 1–0, F1–F4. | P1 | — | per lane | all |
| K3 | **Auto-loot (G).** SRO "Auto Looting (G)" grabs items around you (`UIIT_CTL_AUTOGET_TT` [confirmed]). Pick the nearest free item (`EntityView.itemFree(now)` [confirmed]) within 15 m [unknown] and send `pickup`. **`actionResult ok` does not mean it was picked up.** Out of `PICKUP_RANGE` (2 m), the server answers `ok` when the walk starts. The item arrives later as `inventoryUpdate` plus the item's `despawn`. A failure on arrival is only a system `chat` line ("Could not pick up X: …"), and a new `pickup` or `moveTo` replaces the walk [confirmed `gameplay.ts pickupRequest`, tick `pickup` branch]. So advance to the next item on that item's `despawn`, or after a 6 s timeout [unknown]. Stop on an `actionResult` failure (`inventory_full`, `not_owner`, …) or after 8 items per press. Gold first. Hold G to keep looting. No protocol change. | P1 | S | new `world/autoloot.ts`; hook `world.ts` | UX-B |
| K4 | **Hold to move.** With the left button held on the ground, re-send `moveTo` to the cursor every 250 ms while the point moved > 1 m (≤ 4 msg/s against the 20/s connection budget, burst 40; `moveTo` has no per-type limit in `CLIENT_RATE_LIMITS` [confirmed]). SRO keeps walking while the button is held [likely]. | P1 | S | new `world/move-feedback.ts`; hook the `world.ts` pointer observer (+ POINTERUP) | UX-B |
| K5 | **Blocked-path feedback.** The server walks a straight line and stops at the first blocking edge (`apps/server/README.md` "Navigation" [confirmed]). The player just stops short, with no reason. There are two cases [confirmed `world.ts walkEntity`]: (a) the walk is clipped, and our own `move.to` differs from the requested point by > 1.5 m; (b) the walk is refused or blocked at once, so no `move` arrives at all (only a `stop`, and only if we were moving). Detect (b) by "no own `move` within 400 ms of the request" [unknown timeout]. In both cases, turn the marker red at the requested point, draw a short dashed line to the real stop, and show `action.fail.unreachable` ("You cannot get there." [confirmed en.ts]) at most once per 2 s. A pathfinding follow-up is possible with `packages/nav/src/reach.ts` (the integrating agent's reachability components) [unknown]. | P1 | S | `world/move-feedback.ts`; hook `world.ts` `case 'move'` | UX-B |
| K6 | **Camera keys.** Arrow Left/Right rotate at 90°/s, Up/Down zoom [likely SRO]. The arrows are free: `buildWorldScene` removes Babylon's `ArcRotateCameraKeyboardMoveInput` [confirmed]. Home resets behind the character. Invert-Y and rotation speed are options. Middle-drag also rotates. | P1 | S | new `world/camera-keys.ts`; hook `world.ts` (camera passed in) | UX-B |
| K7 | **Camera modes** Free / Third person / Quarter view [confirmed strings]. Third person follows yaw; Quarter view is a fixed 45° pitch and fixed alpha. | P2 | S | `world/camera-keys.ts` | UX-B |
| K8 | **Nearest-monster key.** SRO has no Tab targeting; Tab is reserved for Berserk (§4.5). Offer Z: cycle the nearest living mobs within 25 m, sorted by distance, not attacking. This is our addition and can be switched off. | P2 | S | `world/autoloot.ts` (shares the nearest query) | UX-B |
| K9 | **WASD.** Not SRO [likely]. Emulating it with `moveTo` 3 m ahead every 200 ms is possible but fights the navmesh. Out of scope; say so in the key help. | — | — | — | decision |
| K10 | **Context cursors.** The only cursor change is `pointer` on hover [confirmed `world/style.ts`]. Use sword (mob), hand (item), speech bubble (NPC) and no-entry (unreachable) as inline SVG data-URI cursors. The client has just `Media/cursor/cursor_normal1.tga` [confirmed]. | P2 | S | `hud/ux-style.ts`, `world.ts setHovered` (sets `data-hover=kind`) | UX-B |
| K11 | **Sit (N).** SRO "Sit down (N)"; sitting raises HP/MP recovery (`UIIT_STT_INPUT_TTDESC_24` [confirmed]). The SIT, SIT_DOWN and STAND_UP clips are already kept (`three/models.ts KEEP_CLIPS` [confirmed]). Protocol and server: §5.3. | P2 | M | server `gameplay.ts` regen, `world/entities.ts` clip choice | later wave (after shops) |

### 3.7 Feel: animation, sound, effects, names

| ID | Gap | P | E | Files | Owner |
|---|---|---|---|---|---|
| F1 | **Name-tag clutter** (§2 item 4). Add screen-space de-cluttering (§4.4): priority order, vertical nudge, fade, and cap. | P0 | M | new `world/nameplates.ts`; hook `world.ts` frame loop after `updateLabel` | UX-B |
| F2 | **Mob name colours by level difference.** Today it is red when the mob is higher, else yellow (`entities.ts mobTone` [confirmed]). Use five bands matching the target gems (§4.2). | P1 | S | `world/nameplates.ts`; `entities.ts refreshLabel`; `world/style.ts` | UX-B |
| F3 | **GM tag.** A GM's name should read `[GM] Name` in a distinct colour, as in SRO, where GMs carry `[GM]` [likely]. Clients cannot know: `EntityState` has no role [confirmed]. Add `EntityState.gm` (§5.2). Display only; no role change is involved, so `role-policy.test.ts` is unaffected. | P1 | S | shared protocol, `apps/server/src/world.ts state()` + `setStaff`, `world/nameplates.ts` | UX-B |
| F4 | **Combat idle stance.** After a swing the character snaps back to STAND1. SRO holds the weapon stance for a few seconds [likely]: play ATTREADY (already kept, `KEEP_CLIPS` [confirmed]) for 5 s [unknown] after the last attack or hit. | P2 | S | `world/entities.ts update()` idle choice | skills (their ActionPlayer owns clip choice) |
| F5 | **Emotes (A action window).** Keep EMOTION01–08, WAIT01–04 (`KEEP_CLIPS` [confirmed]). A local-only emote needs a broadcast to be seen by others [unknown protocol]. | P2 | M | later | later |
| F6 | **Sound: SFX, ambience, UI clicks, level-up, pickup, footsteps.** The client data has `effectsound.txt` and `effectenvsnd.txt` [confirmed]. | P0 | — | sound | sound |
| F7 | **Skill VFX, hit sparks (DamageEfp).** | P1 | — | sound (VFX) / skills | sound, skills |
| F8 | **Grass and plants** (living world). | P2 | — | fields | fields |
| F9 | **Pickup feedback.** Only the centre "obtained" line exists [confirmed]. The item should fly toward the bag icon or bounce, and the sound lane plays a coin/item sound. | P2 | S | `world/drops.ts`, `hud/index.ts announceGains` | UX-B (sound: sound lane) |
| F10 | **Death camera.** The screen desaturates [confirmed]. Also pull the camera back slowly and hide name tags other than the killer's. | P2 | S | `world.ts onSelfDeath` | UX-B |
| F11 | **Hit-stop and shake.** A tiny camera shake on crits taken, off by option. | P2 | S | `world/camera-keys.ts` | UX-B |

### 3.8 Robustness and performance

| ID | Gap | P | E | Files | Owner |
|---|---|---|---|---|---|
| R1 | **Reconnect.** It exists [confirmed], but HUD windows stay interactive while the session is `reconnecting`, and each click toasts `net.notConnected`. Dim the HUD (`body.net-down`) and ignore clicks on the world while reconnecting. | P1 | S | `app.ts showBanner` sets the class; `hud/ux-style.ts` | UX-A |
| R2 | **Multiple tabs.** A second login kicks the first (close 4000). The first tab goes to login, but it shows the server's raw close reason "replaced by a new login", not `net.replaced`. `session.ts` prefers `info.reason || fatal.message` [confirmed `net/session.ts` onClose, `connection.ts hello()`]. Swap the order for every fatal code except `kicked`, so the i18n text wins, and word it "You logged in from another window." Settings and window positions are shared via localStorage, which is fine. | P2 | S | `net/session.ts` (1 line), `i18n` | UX-A |
| R3 | **Resize.** Handled: `engine.resize`, the `--ui` clamp 0.7–1.6, and window re-clamping [confirmed]. Small viewports (≤ 900 px wide) crowd the minimap, stats and help [confirmed, seen]. Fixed by H1/H2 plus a `@media (max-width: 900px)` rule that shrinks the minimap to 128 px. | P1 | S | `hud/ux-style.ts` | UX-A |
| R4 | **Resolution scale.** Both engines are created with `adaptToDeviceRatio: true` [confirmed `engine.ts`], so a HiDPI laptop renders at 2× device pixels. Add Options → Graphics → Resolution (100 / 75 / 50%) → `engine.setHardwareScalingLevel(1 / (window.devicePixelRatio * resolution))`. `adaptToDeviceRatio` means a level of `1 / devicePixelRatio`, so 100% keeps today's behaviour. Re-apply on `resize` and on DPR changes, in case Babylon resets it [likely]. This is the biggest single FPS lever for friends on laptops. | P1 | S | `settings.ts` apply; hook `main.ts` after `createEngine` | UX-A |
| R5 | **Quality preset** only via `?quality=` [confirmed `world/jangan/ground.ts urlQuality`]. Wire `settings.graphics.preset` into `loadJangan({quality})` for the first load. It also applies **live**: `World.setQuality(q: WorldQuality \| QualitySettings)` sets the object draw range, the animated objects and the water (`QUALITY_PRESETS`: drawDistance 0.6 / 1 / 1.4) [confirmed `packages/world-render/src/world.ts:340`]. Sight range folds into the same call: `world.setQuality({...QUALITY_PRESETS[preset], drawDistance: QUALITY_PRESETS[preset].drawDistance * SIGHT_MUL[sight]})`. When the fields lane's region streaming lands (docs/FIELDS.md, `STREAM_DEFAULTS[quality]`, chosen at load), its radii may still need a re-entry [likely]. | P1 | S | hook `world/jangan/ground.ts` (one line: `opts.quality ?? urlQuality() ?? settings.get().graphics.preset`); hook `screens/world.ts` (after `jangan = g`: apply once and subscribe `settings.onChange` → `g.world.setQuality(qualityFor(settings.get()))`) | UX-A |
| R6 | **Fullscreen.** A button in Options and the Esc menu (`document.documentElement.requestFullscreen()` needs a user gesture; the button click is one). F11 already works (browser). | P1 | S | `hud/options.ts` | UX-A |
| R7 | **Mobile/touch.** Not needed, but do not break it. Tap to move works (Babylon POINTERDOWN button 0 [likely]). There is no camera rotation on touch, and windows overflow below 700 px. Add a two-finger rotate (P2) and keep `--ui` ≥ 0.7. Verify that the world loads on a phone without an exception. | P2 | S | `world/camera-keys.ts` | UX-B |
| R8 | **Background tab.** The render loop keeps running in hidden tabs (Babylon stops rAF, but timers and the socket continue [likely]). No gap. After a long hidden period, re-seed the clock on `visibilitychange` (the next pong does it [confirmed `ServerClock`]). | — | — | — | — |
| R9 | **HMR reload in dev** drops you to character select (seen). Dev only; L1 makes it cheaper. | — | — | — | — |

---

## 4. Decisions

### 4.1 Keys (one KeyMap, SRO letters)

SRO's own captions (`textuisystem.txt`, English column) [confirmed unless noted]:

| Key | SRO meaning | Ours today | Plan | Owner |
|---|---|---|---|---|
| C | Character | ✔ | keep | UX-A (moves into KeyMap) |
| I | Inventory | ✔ | keep | UX-A |
| S | Skill | — | skill window; **K as alias** (SKILLS.md §10.3 says K) | skills |
| Q | Quest | — | quest window | quests |
| P | Party | — | party window | party |
| A | Action (emotes, sit) | — | P2 | later |
| N | Sit / Stand | — | P2 (§5.3) | later |
| G | Auto Looting | — | K3 | UX-B |
| T | Auto Potion | — | P2 (after hotbar) | skills (later) |
| U | Guild / Community | — | out of scope | — |
| Y, E, F, D, L, F10 | Alchemy, Party matching, Stall network, Title, Academy, Item Mall | — | out of scope | — |
| H | Help [likely; the caption has no letter] | — | Key help (W2) | UX-A |
| M | World map [likely] | — | M3 | UX-B |
| Esc | Option (`UIIT_STT_TOGGLE_OPTION` "Option ( ESC )"; also `UIIT_STT_TOGGLE_SYSTEM` "System ( Esc )") | cancels a drag → closes a modal → closes the top window (HUD capture listener) → closes the menu → clears the target → Esc menu (world listener) [confirmed] | keep that order. SHOPS.md inserts "close the NPC dialog (`hud.closeNpc()`)" before clearing the target. The menu gains Options and Key help | UX-A |
| Enter | Chat [likely] | ✔ | keep; Up/Down history while typing | UX-B |
| 1–0, F1–F4 | Quick slots and pages | — | hotbar | skills |
| Tab | Berserk [likely] | — | reserved until Berserk ships | later |
| ←→↑↓ | Camera [likely] | — | K6 | UX-B |
| Z | (ours) nearest monster | — | K8, P2 | UX-B |
| F9 | (ours) GM window | ✔ | keep, staff only | editors |
| F8 | (ours) mock network drop | ✔ | keep, mock only | — |

**KeyMap contract** (`apps/game/src/hud/keys.ts`, UX-A):

```ts
export type KeyGroup = 'windows' | 'combat' | 'movement' | 'camera' | 'chat' | 'gm' | 'debug'

export interface KeyBinding {
  /** Stable id, e.g. 'window.inventory', 'loot.auto', 'hotbar.1'. */
  id: string
  /** Matched against KeyboardEvent.key, lower-cased for letters: 'i', 'g', 'f1', 'arrowleft', 'escape', '1'. */
  keys: string[]
  /** Key-help caption (i18n key). */
  label: StringKey
  group: KeyGroup
  /** Also fires on key repeat (camera keys, hold-G). Default false. */
  repeat?: boolean
  /** Fires on keyup too (hold-to-loot, camera). */
  up?: (ev: KeyboardEvent) => void
  /** Only active when this returns true (e.g. staff for F9, mock for F8). */
  when?: () => boolean
  /** Required modifiers (e.g. ['ctrl', 'shift'] for the FPS toggle). Without it, any Ctrl/Alt/Meta chord is skipped. */
  mods?: ('ctrl' | 'shift' | 'alt')[]
  run(ev: KeyboardEvent): void
}

export class KeyMap {
  /** Returns an unregister function. A second binding on the same key logs a warning; the later one wins. */
  register(b: KeyBinding): () => void
  list(): readonly KeyBinding[]
  /** One capture-phase window listener: skips typing targets (INPUT/TEXTAREA/contentEditable), chords a binding did not declare in `mods`, and open modals. */
  attach(target: Window): void
  /** The listener body, exposed so tests can feed plain `{key, repeat, ctrlKey, …, target}` objects (Node has no KeyboardEvent, and no DOM library is installed). */
  handle(ev: Pick<KeyboardEvent, 'key' | 'repeat' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'target' | 'type' | 'preventDefault'>): void
  dispose(): void
}
```

- `Escape` and `Enter` stay special: Esc runs the HUD's close-top-window chain first (as today in `hud/index.ts`), then the world's target/menu.
- Other lanes call `hud.keys.register(...)` from their own modules. None of them adds a `window` keydown listener of its own.

### 4.2 Level bands: mob colours and target gems [thresholds unknown, our rule]

The server's level-difference bonus is 3% per level, capped at 30% (`apps/server/src/formulas.ts levelDiffBonus` [confirmed]). It applies only when the attacker is higher, and it feeds the hit-balance roll and the damage (`formulas.ts` lines 192, 217). The band thresholds below are not derived from it; they are our rule [unknown].

```ts
// apps/game/src/world/nameplates.ts
export type LevelBand = 'weak2' | 'weak1' | 'normal' | 'strong1' | 'strong2'
/** d = mob level − own level. */
export function levelBand(mobLevel: number, selfLevel: number): LevelBand {
  const d = mobLevel - selfLevel
  return d <= -6 ? 'weak2' : d <= -3 ? 'weak1' : d <= 2 ? 'normal' : d <= 5 ? 'strong1' : 'strong2'
}
```

| Band | d | Name colour | Target gem |
|---|---|---|---|
| weak2 | ≤ −6 | `#a0a0a0` grey | `targetwindow/tw_gem_weak2` |
| weak1 | −5..−3 | `#8fe08a` green | `tw_gem_weak1` |
| normal | −2..+2 | `#ffe066` yellow (today's "warm") | `tw_gem_normal` |
| strong1 | +3..+5 | `#ffa04a` orange | `tw_gem_strong1` |
| strong2 | ≥ +6 | `#ff5a48` red (today's "hot") | `tw_gem_strong2` |

- Uniques keep `#ff9cf0` and show `tw_icon_unique`.
- Variants show `tw_icon_{champion,giant,titan,elite}`.
- `mobTone()` in `entities.ts` is replaced by `levelBand()`; the `.hot`/`.warm` classes become `.band-<band>`. Today `.warm` has no CSS rule: yellow is the default `.kind-mob .name` colour, and only `.hot` and `.unique` are styled [confirmed `world/style.ts`]. No test imports `mobTone` [confirmed].

### 4.3 Settings (client only, per viewer)

- `apps/game/src/settings.ts` is owned by UX-A.
- It is stored in `localStorage['sro.settings']`, and every read and write is wrapped in try/catch.
- Defaults apply when storage is missing or blocked.
- It holds no audio settings. `sro.muted` stays with the sound lane (below).

```ts
export interface Settings {
  v: 1
  // No `audio` section: docs/SOUND.md §5.2 owns volumes and mute (audio/settings.ts, 'sro.audio.v1', 'sro.muted').
  graphics: {
    preset: 'low' | 'medium' | 'high'   // WorldQuality; applies live via World.setQuality (world-render world.ts:340)
    resolution: 1 | 0.75 | 0.5          // fraction of device pixels (engine.setHardwareScalingLevel(1 / (dpr * resolution)))
    sight: 0 | 1 | 2 | 3                // very narrow .. very broad: SIGHT_MUL 0.6/0.8/1/1.4 [unknown], multiplied into the preset's drawDistance
  }
  ui: {
    scale: number                       // 0.8..1.4, multiplies the viewport --ui
    showFps: boolean                    // PerfOverlay
    names: { players: boolean; mobs: boolean; npcs: boolean; items: 'always' | 'near' | 'hover' }
    damageNumbers: boolean
    expInChat: boolean                  // H13
    minimapZoom: number                 // 0..4
    helpHintSessions: number            // H2: count of sessions the "H: help" hint was shown
  }
  controls: {
    holdToMove: boolean                 // K4, default true
    cameraSpeed: number                 // 0.5..2
    invertY: boolean
    cameraMode: 'free' | 'third' | 'quarter'
    nearestTargetKey: boolean           // K8, default true
  }
}

export const settings: {
  get(): Settings
  set(patch: DeepPartial<Settings>): void   // validates ranges, saves, notifies
  onChange(fn: (s: Settings, prev: Settings) => void): () => void
}
```

**Contract with the sound lane (corrected after docs/SOUND.md landed).** SOUND.md designs its own `AudioSettings` store: `apps/game/src/audio/settings.ts`, `localStorage['sro.audio.v1']` with `{master, music, sfx, ui, ambient, muteHidden}`, plus `sro.muted` kept as the master mute. It also designs its own window (`hud/sound-settings.ts`) and UI click sounds (`audio/ui-sounds.ts`, a delegated `click` listener) [confirmed in SOUND.md §5.2, §5.11, §5.12]. So UX does not store audio, does not migrate `sro.muted`, does not create a `ui-sound.ts` stub, and does not edit `audio.ts` or the corner mute. Options → Audio opens SOUND's window. The earlier UX idea of one store for both lanes is withdrawn [decision].

**Options window** (`hud/options.ts`, HudWindow `id: 'options'`, ~360×300, frame `frame/frameg01_wnd_`; the `interface/option/opt_*` art is optional P2):

| Tab | Rows |
|---|---|
| Audio | One "Sound settings…" button that opens SOUND.md's `hud/sound-settings.ts` window (its sliders, mute and background mute) |
| Graphics | Quality Low/Medium/High (live); Resolution 100/75/50%; Sight range (4 steps); Fullscreen button; the engine name (WebGPU/WebGL2) as a read-only line |
| Interface | UI scale; show names (players / monsters / NPCs / items always-near-hover); damage numbers; EXP in chat; show FPS |
| Controls | Hold to move; camera speed; invert Y; camera mode; nearest-monster key; a "Key help" button |

Buttons: Default / Close. Changes apply live, as in SRO's Apply-Cancel-Confirm without the Apply step.

### 4.4 Name tags (nameplates)

The label DOM stays in `EntityView` (`label`, `nameEl`, `levelEl`, `hpEl` [confirmed]; only `label` is public, the other three are `private`, so a GM span or level hiding goes through new `EntityView` methods). A new `NameplateLayout` in `world/nameplates.ts` runs once per frame after the `updateLabel` loop:

1. **Collect** the visible labels with their screen rect (`getBoundingClientRect` is too slow per frame; use the `translate` already computed plus a cached width and height, re-measured when the text changes).
2. **Priority**, highest first:
   1. hovered;
   2. target;
   3. self;
   4. party (later);
   5. players;
   6. NPCs;
   7. mobs attacking me;
   8. mobs by distance;
   9. items by distance.
3. **Place** greedily. When a rect overlaps an already placed one, nudge it up in 14 px steps (at most 3). If it still overlaps, hide it: `opacity: 0` with a 150 ms fade, so there is no flicker.
4. **Cap** at 24 visible mob labels and 12 item labels. Beyond 25 m, mobs show only the name (no level); the HP bar shows only when damaged, as today.
5. Respect `settings.ui.names`.
6. **GM tag.** `<span class="gm">[GM]</span>` before the name when `state.gm`, with the name in `#7fd3ff` and bold [unknown colour].

It is pure layout, testable without DOM: `layout(items: {id, x, y, w, h, prio}[]) → {id, dy, visible}[]`.

### 4.5 Berserk (Hwan) gauge: decision

- **It exists in vSRO at these levels** [likely]. The player mini-info art has the gauge (`pmi_jahwan`, `_burn`, `_glow`, `_button*`, `_face` [confirmed exported]). `effectsound.txt` has HWAN hit and swing sounds (`batHwanHit.wav`, `HWSwordSwing.wav` [confirmed]). The key help says the gauge is "on the upper left corner" and used by clicking its button when full (`UIIT_STT_INPUT_TTDESC_07` [confirmed]).
- **Decision: in scope, P2, as its own small wave after skills.**
  - It changes damage and speed. That belongs in the skills lane's stat-mod/effect pipeline (`formulas.ts` last step, SKILLS.md §10.1 "Buffs / debuffs model"), so building it before that pipeline exists would mean building it twice.
  - The protocol shapes are reserved in §5.4 so nobody else takes the names.
- **Numbers** [all unknown; server config]:
  - `BERSERK_MAX = 5` orbs;
  - +1 orb per kill of a mob with `levelBand ≥ normal`, and 0 for weaker mobs;
  - the gauge decays by 1 orb per 60 s out of combat;
  - active 30 s;
  - +100% damage and +50% move speed while active;
  - the gauge is 0 after use.

  Tune them by feel with the user.

---

## 5. Proposed protocol additions (v1, additive)

- All of these follow PROTOCOL.md: strict client key sets (optional keys listed), a per-type rate limit, and exactly one `actionResult` for gameplay requests.
- Server → client parsers drop unknown keys, so new optional fields (`to`, `gm`) are harmless to older clients. A new **value** of an existing enum is not. The client's `chat` parser checks `channel` with `oneOf(['local','system'])` (`validate.ts:553`), so an older client drops a `channel: 'whisper'` frame with a console warning (`net/wire.ts`) [confirmed]. That is harmless here, but it is one more reason to ship server and client together. The party lane edits the same `oneOf` line (`'party'`).
- No name collides with SKILLS.md §10.2 (`useSkill`, `skillLearn`, `masteryUp`, `buffCancel`, `hotbarSet`, `skills`, `skillsUpdate`, `cast`, `castEnd`, `effectAdd`, `effectRemove`, `HotbarEntry`, `EffectState`).

### 5.1 Whisper (UX-B, P1)

```ts
// packages/shared/src/protocol.ts — ClientMessage: `chat` gains an optional recipient (strict keys: text, to?)
| { t: 'chat'; text: string; to?: string }            // to: a character name, CHARACTER_NAME rule (3–12)

// ServerMessage: `chat` gains the 'whisper' channel and `to`
export type ChatChannel = 'local' | 'system' | 'whisper'   // 'party' is added by the party lane
| { t: 'chat'; channel: ChatChannel; fromId?: number; from?: string; to?: string; text: string }
```

- **Coordination with docs/QUESTS.md §4.4.** The party lane also extends the client `chat` with `channel?: 'local' | 'party'` and the server `chat.channel` with `'party'` [confirmed in QUESTS.md]. The merged client shape is `{t: 'chat'; text: string; to?: string; channel?: 'local' | 'party'}`, and `to` together with `channel: 'party'` is answered `error bad_request`. Both lanes edit the same `CLIENT_KEYS.chat`, the same `oneOf` line and the same `connection.ts` case, so land the shared part once.
- **Validator** (`validate.ts`):
  - client `chat`: `CLIENT_KEYS.chat` becomes `['t', 'text', 'to', 'channel']` (with the party lane); `to` is optional, `str(v, 'to', 12, 3)` (signature `str(o, k, max, min)` [confirmed]) and must match `CHARACTER_NAME`;
  - server `chat`: `channel` is `oneOf(['local','system','whisper'])` and `to` is optional.
- **Server** (new `apps/server/src/chat.ts`, called from `connection.ts` `case 'chat'`):
  - When `to` is present, the whisper is routed **before** the slash-command branch. Today every `/`-text runs as a GM command, so a whisper that starts with `/` must not reach `runGm` [confirmed `connection.ts` case 'chat']. Look the recipient up with `world.byName(to)` (case-insensitive; exists [confirmed `world.ts:354`]).
  - Recipient offline, or an invisible GM when the sender is not staff (`world.canSee(sender, recipient)` is false [confirmed `world.ts canSee`]): answer `error {code: 'not_found', re: 'chat', message: '<name> is not online.'}`. This follows today's convention: `chat` is not a `GameplayRequest` and answers through `error`, as its rate limit does. `screens/world.ts` already prints `error` frames with `re: 'chat'` into the chat log [confirmed].
  - Otherwise send `{t:'chat', channel:'whisper', fromId, from, to, text}` to the recipient and echo the same message to the sender.
  - It spends the same chat bucket (1/s, burst 5) as today.
  - Whispering yourself answers `error bad_request`.
  - The same control and bidi stripping applies.
- **Client:**
  - `world/intents.ts` `intents.chat(text, to?)` builds the message; `world.test.ts` requires every `send(...)` in `screens/world.ts` to go through `intents.*` or `gm.*` [confirmed];
  - `/w`, `/W`, `/whisper name text` → `{t:'chat', text, to: name}`;
  - `/r`, `/R`, `/re`, `/reply text` → `to = lastWhisperFrom`, or the local line "Nobody has whispered you yet.";
  - these commands are intercepted before the GM path.
- **Mock** (`net/mock.ts`): bots answer whispers with a canned line, so the mock exercises it.

### 5.2 GM tag on entities (UX-B, P1)

```ts
// EntityState (players only)
/** Present (true) while the account is gm/admin. Display only ([GM] tag). */
gm?: true

// ServerMessage entityUpdate gains:
gm?: boolean        // false clears the tag (role revoked by the owner CLI)
```

- **Server:**
  - `world.ts state(e)`: player branch `if (e.staff) s.gm = true`. `Player.staff` is set at `world.add({... staff: isStaff(this.role)})` on enter and updated by `connection.ts applyRole` → `world.setStaff` [confirmed].
  - `world.setStaff(viewer, staff, now)` (the real parameter names; it returns early when unchanged [confirmed]): after the loop, `this.broadcastAbout(viewer, {t: 'entityUpdate', id: viewer.id, gm: staff})`. That reaches the player itself and every client that has it [confirmed `broadcastAbout`]. The server's role poll runs every `rolePollMs` = 1000 ms [confirmed `config.ts`].
  - No new way to change a role. The owner CLI stays the only one; `apps/server/test/role-policy.test.ts` is untouched and must keep passing. Its static scan looks for `setRole(` and for SQL that writes `accounts.role` under `apps/server/src`; `setGm`/`gm` fields do not match it [confirmed].
- **Client:**
  - `EntityView.setGm(on)`;
  - `world.ts onEntityUpdate` passes `msg.gm`;
  - nameplates add `[GM]`.

### 5.3 Sit (reserved; P2, a later wave)

```ts
| { t: 'sit'; on: boolean }            // ClientMessage; GameplayRequest += 'sit'; CLIENT_RATE_LIMITS.sit = { perSecond: 2, burst: 4 }
// EntityState (players): sitting?: true    entityUpdate: sitting?: boolean
```

- Server:
  - `sit {on: true}` stops movement and auto-attack and sets sitting;
  - any `moveTo`, `attack`, `useSkill`, `pickup` or `itemUse` stands the player up first;
  - taking a hit stands them up;
  - sitting doubles the regen pulse [unknown multiplier] and also works in combat [unknown];
  - failures: `dead`.

### 5.4 Berserk (reserved; P2, after skills)

```ts
// PlayerStats gains (optional, own client only):
berserk?: number                        // gauge 0..BERSERK_MAX
berserkUntil?: number                   // server ms the active phase ends; absent = not active
| { t: 'berserk' }                      // ClientMessage (no fields); GameplayRequest += 'berserk'; rate 2/s burst 4
// EntityState (players): berserk?: true    entityUpdate: berserk?: boolean   (aura + HWAN sounds for viewers)
```

Failures reuse existing reasons: `not_usable` (the gauge is not full, or already active) and `dead`.

---

## 6. Cross-lane notes

1. **Skills: the S key.** Use S for the skill window, as SRO does (`UIIT_STT_TOGGLE_SKILL` "Skill ( S )"), with K as an alias. The hotbar registers 1–0 and F1–F4 through the KeyMap (§4.1). Item cooldown sweeps (bag and hotbar) come from the shops lane: SHOPS.md's `itemCooldown` message, `SlotView.setCooldown` and `hud.itemCooldowns` (W4). The skills lane's own skill cooldowns stay in its hotbar. UX proposes no separate `hud/cooldowns.ts`.
2. **Shops and quests: one NPC talk window.** This is already designed in docs/SHOPS.md §3 and §8.3 [confirmed]. Clicking an NPC sends `npcTalk {npc}`, and the server walks the player to `NPC_APPROACH_RANGE` (3 m; services work up to `NPC_INTERACT_RANGE` = 8 m). The server then sends `npcDialog` with the NPC's services, and `hud/npc-dialog.ts` shows them. Quests plug in as a server-side service (`npc.option.quest`, "Talk about a quest."), not through a client `addTalkOption`. `Media/resinfo/if_npcwindow.txt` and `if_npctalk.txt` exist [confirmed]. The world hook is SHOPS.md's one line in `clickEntity`; UX adds none.
3. **Party.**
   - Chat `#` prefix → `ChatBox.registerPrefix` (C4);
   - `chat.channel` += `'party'`;
   - minimap markers through `HudMinimap.addMarkerSource`;
   - name tags get priority 4 and colour `#9ae6ff` [unknown].
4. **Sound.**
   - docs/SOUND.md owns volumes, mute, the sound window and UI clicks: `audio/settings.ts`, `hud/sound-settings.ts`, and `audio/ui-sounds.ts` as a delegated `click` listener on `<button>`s. So UX windows get click sounds for free when they use `art.button()` / real buttons [confirmed in SOUND.md §5.11].
   - Both lanes add a button to `world.ts openMenu()`: SOUND adds "Sound", UX adds "Options" and "Key help". Merge them into one list: Options, Key help, Sound, Character select, Logout, Resume. The window is 212 × 180 today [confirmed], so it grows to about 212 × 290.
5. **i18n.** `en.ts` is shared by every lane. To avoid merge fights, each lane adds its strings in its own file (`i18n/en-ux.ts`, `i18n/en-ux-world.ts`, `i18n/en-skills.ts`, …) and adds one spread line in `en.ts`: `...enUx,`. `StringKey` still types everything, because `satisfies` keeps the literal keys.
6. **Art export.** `packages/convert/src/tools/export-icons.ts HUD_SELECTION` is shared. Each lane appends its own lines:
   - UX-B: `{ folder: 'interface/minimap', include: /^mm_/ }` and `{ folder: 'interface/worldmap', include: /^wmap_(button|direction|icon|monster_icon|name)/, exclude: /\s/ }`. The client has a stray `wmap_button_automatic .ddj` with a space in its name [confirmed];
   - UX-A (P2): `{ folder: 'interface/hitcount', include: /\.ddj$/ }`;
   - skills: `interface/skill`, `interface/quick_slot`.

   Re-run `pnpm tsx packages/convert/src/tools/export-icons.ts` after pulling.
7. **world.ts** is the hottest shared file. The integrating agent was editing it during the audit; at HEAD `3afb304` it is committed and clean. The SHOPS and skills lanes also hook it. Every hook below is at most a few lines and anchored by the surrounding code, not by line numbers.
8. **CSS.** New modules inject their own style block, as `world/style.ts` does (`ensureWorldStyles`), instead of editing `style.css`. The only `style.css` edit is L2's three font-stack lines.

---

## 7. Priority summary

| P | UX-A | UX-B | Other lanes |
|---|---|---|---|
| P0 | H1 stats overlay, H2 help line, W1 options, K1 KeyMap | F1 name-tag clutter | skills: H10 hotbar and W10 skill window; sound: F6; shops: W11 |
| P1 | L1 refresh resume, L2 fonts, L3 corner, H3 menu bar, W2 key help, W3 unusable tint, R1 reconnect dim, R3 small screens, R4 resolution, R5 quality, R6 fullscreen | H4 target gems, F2 level bands, F3 GM tag, C1 history, C2 whisper, C3 tabs, C5 scroll-back, M1 minimap+, M3 world map, K3 G loot, K4 hold to move, K5 blocked feedback, K6 camera keys | skills: H9 buffs; shops: W4 item cooldown sweep; party: H11, C4; quests: H12; sound: F7 |
| P2 | L5–L7, H6, H7, W5, W7, W9, R2 | H8, H13, C7–C9, M2, M4, K7, K8, K10, F9–F11, R7 | H5/§5.4 Berserk, K11/§5.3 Sit, F4 stance, F5 emotes, L4 backdrop, W6 figure |

---

## 8. Build plan

There are two lanes. They can run in parallel with each other and with skills, shops, sound, fields and quests/party/editors. Both lanes:

- create new modules;
- touch shared files only at the hook points listed;
- write tests with vitest (`pnpm vitest run apps/game/test/<file>`);
- run `pnpm typecheck`.

**Ordering inside the wave:** UX-A lands `hud/keys.ts`, `settings.ts` and the `hud/index.ts` hook first (≈ 1 h). UX-B codes against the §4.1/§4.3 interfaces from the start. Until they land, UX-B registers its keys through a temporary local listener behind `if (!hud.keys)`.

### Lane UX-A: HUD shell, settings and robustness

**Owned files (new):**

- `apps/game/src/settings.ts`: the Settings store (§4.3), `applyGraphics(engine)` (resolution) and `qualityFor(s): QualitySettings` (preset × sight, from `QUALITY_PRESETS` of `@sro/world-render`).
- `apps/game/src/hud/keys.ts`: KeyMap (§4.1).
- `apps/game/src/hud/options.ts`: Options window (W1, R6).
- `apps/game/src/hud/keyhelp.ts`: Key help (W2), built from `keys.list()`.
- `apps/game/src/hud/menubar.ts`: system buttons (H3). `register({id, art, label, toggle, isOpen})`.
- `apps/game/src/hud/perf-overlay.ts`: FPS/ping/draws (H1). It takes the numbers `world.ts` already computes.
- `apps/game/src/hud/ux-style.ts`: injected CSS (menu bar, options, perf overlay, `body.net-down`, `.slot.blocked`, the small-screen media rule).
- `apps/game/src/net/resume.ts`: `saveSession`, `loadSession`, `clearSession` over `sessionStorage` (L1).
- `apps/game/src/i18n/en-ux.ts`: strings.
- `apps/game/test/ux-shell.test.ts`.

**Hook points in shared files:**

- `apps/game/src/i18n/en.ts`: one line `...enUx,` at the top of the `en` object, plus the import.
- `apps/game/src/hud/index.ts`:
  - create `const keys = new KeyMap()` and `keys.attach(window)`;
  - move the `i`/`c` branches of the capture keydown handler into `keys.register(...)`, keeping the Esc chain in place;
  - construct `MenuBar` (register inventory and character);
  - add `keys`, `menu`, `openOptions()` to the returned `Hud` (the "extras" section);
  - remove `helpKeys`.

  About 25 lines.
- `apps/game/src/screens/world.ts`:
  - `openMenu()`: add Options and Key help buttons. SOUND.md adds "Sound" to the same list, so the window grows from 212 × 180 to about 212 × 290 (§6.4);
  - replace the `stats` element and its text assignment in the `statT` block with `perf.update({engine, fps, ping, players, draws, mock})`;
  - replace the `help` element's text with the H2 hint;
  - register F9 and F8 in `hud.keys` instead of the local keydown branches (keep the Enter and Esc handling where it is);
  - after `jangan = g` in the `loadJangan(...).then`: `g.world.setQuality(qualityFor(settings.get()))` and a `settings.onChange` subscription removed in `dispose()` (R5, sight range).

  About 25 lines.
- `apps/game/src/app.ts`:
  - `updateScale()` multiplies by `settings.get().ui.scale` and subscribes to settings;
  - `showBanner()` toggles `document.body.classList` `net-down`;
  - `logout()` and the `unauthorized` branch call `clearSession()`.

  About 8 lines.
- `apps/game/src/main.ts`:
  - `applyGraphics(engineResult.engine)` after `createEngine`;
  - remove the engine badge from the corner (L3; the mute button is the sound lane's, and SOUND.md also edits this block);
  - before `app.go(...)`, try `loadSession()` → `openSession` → `app.setSession` → `app.go('charselect')`.

  About 12 lines.
- `apps/game/src/screens/login.ts` `enter()`: `app.tokenExpiresAt = res.expiresAt` (`ApiLoginResponse.expiresAt` [confirmed `protocol.ts`]). 1 line, plus 1 field on `App`.
- `apps/game/src/screens/servers.ts` `connect()`: after `app.setSession(session)`, `saveSession({token: app.token, username: app.username, expiresAt: app.tokenExpiresAt})`. 1 line.
- `apps/game/src/net/session.ts` onClose: prefer `fatal.message` over the server's close reason, except for `kicked` (R2). 1 line.
- `apps/game/src/world/jangan/ground.ts`: `quality: opts.quality ?? urlQuality() ?? settings.get().graphics.preset`. 1 line. Sight range needs no loader change: `World.setQuality(QualitySettings)` takes a custom `drawDistance` [confirmed], applied from `world.ts` (above).
- `apps/game/src/hud/slots.ts` `SlotView.set(stack, blocked = false)` + `hud/inventory.ts` `render()`/`update()` pass `canUse(...)` from `hud/items.ts`. `hud/index.ts setPlayer` calls `invWin.render()` when the level changed (W3). About 12 lines. The skills lane (drag to the hotbar) and shops lane E (`setCooldown`) also touch `slots.ts`, so keep the edit inside `SlotView.set`.
- `apps/game/src/style.css` lines 7–9: sans-serif font fallbacks (L2).
- `packages/convert/src/tools/export-ui.ts` (L2 root cause, optional): re-emit the fonts sanitised. Guard with a test that the TTF table directory is valid: `searchRange = 16·2^floor(log2 numTables)` (13 tables → 128, `rangeShift` = 16·13 − 128 = 80). A valid header alone does not prove Chrome accepts `glyf`, so also check in the browser.

**Tests (`apps/game/test/ux-shell.test.ts`, DOM-free like `hud.test.ts`; no happy-dom or jsdom is installed, and adding one would be a package change):**

- **settings:**
  - defaults when storage throws;
  - range clamping (scale 0.8–1.4, cameraSpeed 0.5–2, minimapZoom 0–4);
  - corrupt JSON → defaults;
  - onChange fires with prev/next.
- **KeyMap** (through `handle()` with plain event objects):
  - letters are case-insensitive;
  - a `mods` binding fires only with its chord, and other chords are skipped;
  - typing targets are ignored;
  - `when` gating;
  - a duplicate key warns and the later one wins;
  - unregister works;
  - repeat is off by default.
- **resume:**
  - an expired token is not used;
  - `clearSession` on logout;
  - storage throwing → null.
- **perf overlay:** hidden unless `showFps`.
- **canUse:** level, gender (from the model code) and race rules against `ItemDef` samples.
- **quality:** `qualityFor(settings)` multiplies the preset's `drawDistance` by the sight step.

**How to check it (browser, `pnpm --filter @sro/game dev`, real server or `?mock=1`):**

1. Enter the world. There is no stats text under the minimap and no long help line. A small "H: help" hint sits above the EXP bar. Press H: the key list shows C, I, H, G, M, Esc, Enter and F9 (GM only).
2. The bottom-right menu bar shows Character, Inventory and Options. Each click toggles its window.
3. Esc with nothing open opens the menu with Options, Key help, (Sound, from the sound lane), Character select, Logout and Resume. Options → Interface → Show FPS: the FPS overlay appears, and the choice survives a reload. Options → Audio opens the sound lane's window once that lane lands.
4. Options → Graphics → Resolution 50%: the image softens and the FPS rises (turn on Interface → Show FPS to see it). Quality Low: distant buildings disappear at once and animated objects stop, with no re-entry needed. Sight range Very narrow shortens it further. Fullscreen enters fullscreen.
5. Options → Interface → UI scale 1.3: every window and the HUD grow.
6. Press F5 in the world. The page returns to character select without the login screen. Log out, then press F5: you get the login screen.
7. Hold a level-5 item at level 1 (20 items in `items.json` have `reqLevel` 5 [confirmed]): its bag slot is tinted red, and the tint clears once you reach level 5.
8. Stop the server for 10 s. The HUD dims and world clicks do nothing. When the server returns, the dim clears and "Reconnected." is shown.
9. In Chrome DevTools, the console no longer shows the font fallback warning (after the export fix), or the body text is a clean sans (after the fallback fix).

### Lane UX-B: world feel, chat and maps

**Owned files (new unless noted):**

- `apps/game/src/world/nameplates.ts`: `levelBand()`, the `NameplateLayout` (§4.2, §4.4) and GM tag rendering helpers.
- `apps/game/src/world/autoloot.ts`: `nearestFreeItem()`, `nearestMobs()`, and the G loop over pickup results (K3, K8).
- `apps/game/src/world/move-feedback.ts`: hold-to-move (K4), the blocked-path marker and message (K5).
- `apps/game/src/world/camera-keys.ts`: arrows, Home, camera modes, touch two-finger rotate (K6, K7, R7).
- `apps/game/src/hud/worldmap.ts`: the M window (M3).
- `apps/game/src/world/chat.ts` (**existing, owned by this lane**): tabs, history, whisper and reply parsing, `registerPrefix`, scroll-back, fading, name click (C1–C3, C5, C7, C9).
- `apps/game/src/world/jangan/minimap.ts` (**existing, owned by this lane**; the integrating agent had a pending diff there during the audit, but it is clean at HEAD `3afb304`, so rebase on whatever is current). docs/QUESTS.md §2.6 and §4.5 call `HudMinimap.addMarkerSource()` (with an optional marker `radius`) from this file, so land that API first: zoom buttons, coordinates, area label, marker sources, click → world map (M1, M2, M4).
- `apps/game/src/i18n/en-ux-world.ts`: strings.
- `apps/server/src/chat.ts`: whisper routing (§5.1).
- Tests:
  - `apps/game/test/ux-world.test.ts`;
  - `apps/server/test/whisper.test.ts`;
  - `apps/server/test/gm-tag.test.ts`;
  - the validator cases in `packages/shared/test/` (the existing validate test file; add cases only).

**Hook points in shared files:**

- `packages/shared/src/protocol.ts`:
  - client `chat` gets `to?`;
  - `ChatChannel` and server `chat` get `to?`;
  - `EntityState.gm?`;
  - `entityUpdate.gm?`.

  About 8 lines.
- `packages/shared/src/validate.ts`: `chat` client (optional `to`, CHARACTER_NAME); server `chat` channel list plus `to`; `EntityState.gm`; `entityUpdate.gm`. About 10 lines.
- `apps/server/src/connection.ts` `case 'chat'`: right after the empty-text check and **before** the `text.startsWith('/')` branch, `if (msg.to !== undefined) return handleWhisper(this, msg.to, text)` (from `chat.ts`; it takes the chat bucket itself). `chatBucket` is `private`, so either pass a `take: () => boolean` or add a small public `takeChat()` on `Connection`. 2–4 lines.
- `apps/server/src/world.ts`: `state(e)` player branch `gm` (1 line); `setStaff()` broadcasts `entityUpdate {id, gm}` (2 lines).
- `apps/game/src/world/intents.ts`: `chat: (text, to?) => to ? {t: 'chat', text, to} : {t: 'chat', text}`. 1 line.
- `apps/game/src/net/mock.ts`: whisper echo and the bot reply; `gm: true` on the mock self when `?gm=1`. About 15 lines.
- `apps/game/src/i18n/en.ts`: one line `...enUxWorld,`.
- `apps/game/src/world/entities.ts`:
  - `refreshLabel()`: replace the `hot`/`warm` classes with `band-${levelBand(...)}`;
  - add `gm` span handling and `setGm(on)`;
  - delete `mobTone` (update `world.test.ts` if it imports it).

  About 12 lines.
- `apps/game/src/world/style.ts`: the band colours and the `.gm` tag CSS (it is already a world-owned injection). About 8 lines.
- `apps/game/src/hud/target.ts`:
  - `TargetInfo` gets `band?: LevelBand` and `variant?: MobVariant`;
  - `set()` chooses the gem (`tw_gem_${band}`) and shows a `tw_icon_${variant}` element placed at [176, 4, 20, 20] [unknown rect; measure on the texture].

  The skills lane adds an effects row to the same window, so keep this inside `set()` and the constructor. About 12 lines.
- `apps/game/src/screens/world.ts`:
  - `targetInfo()`: add `band` and `variant`;
  - the frame loop: after the two `updateLabel` loops, `nameplates.layout(entities.values(), fading, target, hovered)`;
  - the pointer observer: POINTERDOWN on ground → `moveFeedback.begin(p)`, plus POINTERUP → `moveFeedback.end()`;
  - `case 'move'` for `selfId` → `moveFeedback.onSelfMove(msg.move)`;
  - `case 'chat'`: pass `msg.channel`, `msg.to` and `msg.from` to `chat.add` (the whisper kind);
  - `onEntityUpdate`: `if (msg.gm !== undefined) e.setGm(msg.gm)`;
  - `case 'statsDelta'`: `if (msg.gain && settings.get().ui.expInChat) chat.add('system', t('chat.expGain', …))` (H13; the HUD has no chat);
  - `case 'despawn'`: `autoLoot.onDespawn(msg.id)` (K3 advances on the picked item's despawn);
  - register G, Z, M, the arrows and Home through `hud.keys`;
  - construct `CameraKeys(camera)`, `AutoLoot({send: msg => send(msg), …})` and `WorldMap(...)` next to the minimap creation. AutoLoot builds its pickups with `intents.pickup`, and `world.test.ts` only allows `send(msg)` or `send(intents.*)` in world.ts [confirmed].

  About 35 lines in total.
- `packages/convert/src/tools/export-icons.ts HUD_SELECTION`: the minimap and worldmap lines (§6.6).

**Tests:**

- `ux-world.test.ts`:
  - `levelBand` boundaries (−6, −5, −3, −2, +2, +3, +5, +6);
  - `NameplateLayout`: a hovered or targeted label is never hidden; overlapping mobs are nudged, then hidden; the cap is respected;
  - `nearestFreeItem`: skips owned items before `ownerUntil`, prefers gold, respects the radius;
  - the AutoLoot loop: `actionResult ok` does not advance; the item's despawn or the timeout does; a failed `actionResult` stops it;
  - chat parsing: `/w Name hi` → `{to: 'Name', text: 'hi'}`; `/r` with and without a last sender; `/w` with a bad name → a local error; other slash lines still go to the GM path;
  - history: Up/Down cycling, capped at 30;
  - minimap coordinates: `(97, −137)` → `(6433, 1097)`.
- `whisper.test.ts` (real server on an ephemeral port, as the other server tests do):
  - A whispers B → both receive `channel: 'whisper'`, and C receives nothing;
  - offline target → `error not_found re: 'chat'`;
  - whispering yourself → `bad_request`;
  - a whisper whose text starts with `/` is delivered, not run as a GM command;
  - the rate limit is shared with chat;
  - a non-staff whisper to an invisible GM → `not_found`.
- `gm-tag.test.ts`:
  - a GM-granted account (via the DB, as `role-policy.test.ts` sets roles) appears with `gm: true` in `worldEnter.entities` of another client;
  - revoke through the CLI path (`store.setRole` in the test, then wait for the 1 s role poll) → `entityUpdate {gm: false}`;
  - `role-policy.test.ts` still passes unchanged.

**How to check it:**

1. Walk to a Mangyang pack (the only nests in the playable area). The labels no longer overlap: nearer ones stay, farther ones fade. Hover one and its label always shows.
2. Mob names are coloured by level. At level 1, level-1 Mangyangs are yellow. Nothing above level 1 spawns in the playable area, so as a GM type `/spawn MOB_CH_WATERGHOST` (Water Ghost, Lv 7 [confirmed `mobs.json`]): it is red, and `/spawn MOB_CH_GYO_CLON` (Old Weasel, Lv 4) is orange. Target one: the target window gem changes, and a champion (10% of Mangyangs, `championPct` [confirmed `nests.json`]) shows its icon.
3. Kill a few mobs, then press G. You walk to and pick up gold first, then items, one after another. With a full bag, you get one "inventory full" line and looting stops.
4. Hold the left mouse button and sweep the cursor: you keep walking toward it. Click inside a building wall: the marker turns red, a dashed line shows where you will stop, and "You cannot get there." appears once.
5. The arrow keys turn and zoom the camera, and Home puts it behind you.
6. Press M: the Jangan map opens with your arrow, NPC names and hunting areas with level ranges. Click the minimap's map button to open the same window. The minimap `+`/`−` buttons zoom, and the coordinates read about 6433, 1097 at the spawn.
7. Chat: type `/w <friend> hi`. They see "From you: hi" in pink, and you see "To friend: hi". They type `/r yo` and you receive it. Whisper someone offline: "X is not online." Up recalls your last line. The Whisper tab shows only whispers.
8. Grant a friend GM with `pnpm gm grant <account username>` (the CLI takes the account name, not the character name [confirmed `apps/server/src/cli/gm.ts` USAGE]; on the mini PC use `pnpm deploy:gm`). Their name tag shows `[GM]` for everyone within about a second (role poll 1000 ms). Revoke it and the tag disappears.
