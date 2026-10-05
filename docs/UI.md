# UI rework: a retail-faithful interface (spec)

The user finds the current UI "weird" and "not good" and wants it reworked, using Silkroad's own interface art where it helps. This spec:

1. audits the UI as it is today (seen in the browser, and in the code);
2. lists the retail vSRO 1.188 interface art and layout data that we can use;
3. designs the new UI: screen layout, every window, type, colour, scale, tooltips, drag and drop, cursors;
4. defines a component kit (`apps/game/src/ui/kit/**`) with the exact retail slices;
5. plans the migration window by window, and ends with a build plan (lanes, owned files, hooks, tests, checks).

It is a spec only. No code under `apps/`, `packages/`, `deploy/` or `content/` was changed while writing it.

## Status tags

- **[confirmed]**: checked in the retail files (`work/extracted/Media/**`), in our code (file and symbol named), or seen in the running client.
- **[likely]**: the data points this way, but it is not proven.
- **[unknown]**: a choice we make; keep it in one constant.

## Method

- **Retail census.** Every `.ddj` under `Media/interface/{underbar, playerminiinfo, targetwindow, minimap, quick_slot, chattingwnd, mainpopup, system, frame, ifcommon, skill, party, quest, stall, exchange, alchemy, guild, option, messagebox, npc, store, inventory, equipment, character, item_number, hitcount, game, animal, quickparty, durabilityerror, make, recycle, image, guide, timer}` was decoded (2,119 textures). Numbered contact sheets and size tables were made, and the key pieces were looked at one by one. The layout files `Media/resinfo/*.txt` (247 files) were parsed. So were `Media/config/define.txt`, `Media/fonts/*` and `Media/cursor/*`.
- **Current client.** I read `apps/game/src/ui/*`, `hud/*`, `world/chat.ts`, `world/jangan/minimap.ts`, `quests/*`, `gm/window.ts`, `screens/*`, `style.css` and the per-lane `*-style.ts` sheets.
- **Live look.** A throwaway account was registered on the local dev server `http://localhost:5180`. I went through login, register, the server list, character create, character select, loading, the world HUD, and every window (I, C, S, Q, P, H, Esc menu, Options, M, chat). I looked at 1024×768 (the pane), 1280×720 and 1920×1080. I also ran a small script in the page that counts the fonts, sizes and colours in use. The account's credentials are in `work/tmp/ui/test-account.txt`.
- Scratch tools (not product code) are in `work/tmp/ui/*.ts`. §12 lists the reference images that were kept.
- **Fact-check pass (after the first draft).** Every resinfo rect was re-read with a parser that **honours the `#ifdef`s of `Media/config/define.txt`** (the draft's `work/tmp/ui/resinfo.ts` keeps the *last* value of a property, which is the `#else` branch inside an `#ifdef … #else … #endif`). That changed the trade window (365×500, not 254×361), the shop (254×370), the chat input rect, and a few more; each fix is marked "(fact-check)". Code references were re-read against the working tree of 2026-09-28 (other lanes are editing `hud/index.ts`, `hud/player.ts`, `hud/skills*.ts`, `screens/world.ts`, `style.css`).

---

## 0. Summary of decisions

1. **One look: the vSRO 2009 in-game UI.** `Media/config/define.txt` defines `UI_UPDATE_2009_FIRST` [confirmed], so the client we copy uses these parts:
   - the "new" underbar `underbar/ub_new_mainbar2` (800×68, with the MENU tab);
   - the 236-px target windows and the player frame from the atlas `ifcommon/window_all.ddj`;
   - `frame/mframe_wnd_` as the frame of every main window.
2. **Native pixels, one scale.** The whole in-game UI is laid out in retail pixels, inside one layer with CSS `zoom: var(--ui)`. `--ui` is a step (1, 1.25, 1.5, 2, 2.5, 3) and is **never below 1** on a desktop-sized screen. Today it is 0.80 at 1024×768 and 0.84 at 1280×720 [confirmed], which shrinks the art and turns 12-px text into 9–10 px.
3. **One kit.** Every window, button, tab, gauge, slot, list, scroll bar, input, checkbox, slider and tooltip is built from `ui/kit/**`. Each control has exact retail skins and the hover, press and disabled states. No window draws its own chrome and no lane writes colours by hand.
4. **Frames become single images.** The exporter composes each 8-piece retail frame into one nine-slice PNG. The kit draws it with CSS `border-image`: one element instead of nine, and the scaling is crisp.
5. **Retail screen layout.**
   - Top-left: the player frame, with buffs to its right and party frames under it.
   - Top-centre: the target window.
   - Top-right: the minimap in its retail plate, with the area name and coordinates inside the plate. The quest tracker sits under it.
   - Bottom-centre: one underbar with 10 quick slots, the mouse slot, SP and level, a 10-segment EXP bar, and the character, inventory and skill buttons plus the MENU popup.
   - Bottom-left: the chat in its retail box.
   - The casting bar sits above the underbar, at the retail offset (y = 606 at 768, i.e. H − 162).
6. **Retail window model.**
   - Character (C), Inventory (I), Skill (K; S until MV-WASD made it walk back), Party (P) and Quest (Q) become tabs of one **Main window** (`GDR_MAINPOPUP`, 388×408), with the retail side tab strip. The Inventory tab shows the equipment panel and the bag side by side.
   - NPC, storage, shop, trade, stall, alchemy, guild, options, system, world map and GM stay separate windows, each in `mframe`.
   - Every window keeps today's behaviour: the same data, intents and tests.
7. **Type and colour from the retail data.**
   - Labels `#EFDAA4`, values `#FFFFFF`, level/SP `#FFD953`, button text `#FEFBD8`. These are the most used `FontColor`s in resinfo [confirmed].
   - Fonts: body 12 px in the client's own basic font, which the exporter repairs by subsetting it; titles in the English font; everything with a 1-px dark outline.
8. **Live English text everywhere** (i18n unchanged). Art with baked text stays banned, except where the baked text is already English and matches (`MENU ▲`, which is baked into `ub_new_mainbar2`, `ub_new_mainbar3` and `ub_new_menu*`; the slot digits 1–0 in `ub_new_mainbar2`; `ADD`; `UP`).
9. **Order.** The export and kit lanes come first. They only add new files, so they do not collide with the lanes now adding horses, trade, stalls, alchemy, guilds and the berserk gauge. Those lanes build their new windows with the kit. Then three migration lanes move the HUD, the windows and the outer screens.

---

## 1. What looks wrong today (audit)

Screenshots were taken at 1024×768 unless noted. "Code" names the cause.

| # | What the user sees | Code / cause | Tag |
|---|---|---|---|
| A1 | **Everything is small and soft.** At 1024×768 the art draws at 80%. At 1280×720 it draws at 84%, and 12-px text becomes about 10 px. At 1920×1080 it is 125.6%, a non-integer scale that blurs the pixel art. | `app.ts updateScale()`: `min(w/1280, h/860)` clamped to 0.7–1.6, times `settings.ui.scale`. Measured `--ui`: 0.800 at 1024×768, 0.837 at 1280×720, 1.256 at 1920×1080. | [confirmed] |
| A2 | **Fonts fall back.** Only "SRO English" loads, and the page gets the `fonts-fallback` class. Body text is Tahoma, and many labels use the rounded **title** font at 10 px. One HUD screen uses **19 font/size/colour combinations**. Near-duplicate creams and golds are everywhere: `#fff3c4 #ffd35a #cdbb90 #cfe3ff #b9ad8f #f3d58a #ffe9a6 #d8d0b8 #efe6cf`. | `ui/fonts.ts`: Chrome rejects `basic.ttf` and `chat.ttf` (UX_GAPS L2). Colours are hand-written per lane: `style.css` (2,524 lines on 2026-09-28, and growing: other lanes are editing it) plus 10 injected sheets (43 KB) from `hud/*-style.ts`, `quests/style.ts`, `world/*style.ts`, `gm/editors/style.ts`. | [confirmed, measured in page] |
| A3 | **Two visual languages in the world.** | The Esc menu uses login-screen buttons (`outer/button`) on an outer window. Options tabs and value buttons are CSS brown and red pills. Party mode buttons are red CSS pills. The target's "Invite" is a floating outer-style button. HUD windows use `int_window_`. Retail uses `mframe`/`sframe` and `com_button` in the game, and outer art only before login. | [seen] |
| A4 | **Windows have no title bar.** The title floats on a thin 16-px border, and every window looks like the bag's inner box. | `hud/window.ts HudWindow`: every window passes `frame: 'inventory/int_window_'` or `'frame/frameg01_wnd_'` with `fill: com_bg_tile_d`. Retail main windows use `frame/mframe_wnd_`, which has a 36-px title strip and a gold rim. | [confirmed] |
| A5 | **The HUD is loose parts.** | The hotbar is its own box, and a media query moves it to the bottom right at ≤ 1300 px (`@media (max-width: 1300px)`, `hud/skills-style.ts:78–80`; fact-check). The EXP bar is a separate thin box. The menu is a row of round buttons at the bottom right. Retail puts all of this in **one** 800×68 underbar. | [seen, confirmed] |
| A6 | **Windows open on top of each other.** Quests (`at [0.3,0.3]`) covers Skill (`[0.7,0.35]`), and Party (`[0.3,0.3]`) and Key help (`[0.5,0.35]`) overlap. | `at` fractions per window, with no cascade. | [seen] |
| A7 | **The Character window holds the equipment**, drawn around an SVG silhouette. Retail has equipment on the Inventory tab, next to the bag, and stats on the Character tab. | `hud/character.ts FIGURE_SVG`. Retail: `ifmainpopup.txt` puts `GDR_EQUIPMENT` (198,41,178,355) next to `GDR_INVENTORY` (13,63,176,333). | [confirmed] |
| A8 | **Old target window.** | `hud/target.ts` draws `targetwindow/tw_type1` (200×72). With `UI_UPDATE_2009_FIRST` the client uses the 236-wide `window_all` regions (§2.7). | [confirmed] |
| A9 | **Text does not fit.** | "Femal(e)" is clipped on the character-create sex button. "Character Select" overflows its Esc-menu button. The inventory help line wraps to two lines inside the window. | [seen] |
| A10 | **The chat is a plain box.** It is an rgba panel with a 1-px gold border that fades out completely, with CSS tabs and a bare input line. | `style.css .chat*`, `world/ux-world-style.ts .chat-tabs`. The retail `chattingwnd/chat_window_big` (400×168, with its scroll column and input bar) and `chat_tab` are exported but unused. Of the lamps only `chat_lamp_all` is exported today (`export-ui.ts` SELECTION `chat_(window|tab|scroll|arrow|lamp_all)`). | [confirmed] |
| A11 | **Minimap text sits outside the frame.** The area name and coordinates are in large gold text **under** the frame, and the frame's top plate is empty. | `world/ux-world-style.ts .hud-minimap-area`. Retail `ifminimap.txt`: name at (12,9,104,12), X at (8,32), Y at (67,32), inside the plate. | [confirmed] |
| A12 | **Tooltips are a flat list of lines.** They have no sections or separators, and the colours are ad hoc. | `hud/slots.ts Tooltip`, `hud/items.ts tooltip()` (the data and order are good). | [confirmed] |
| A13 | **States are inconsistent.** Some buttons have focus and press art. CSS pills have their own hover colours. Nothing uses the retail disabled art (`com_button_disable`). | `ui/art.ts button()`. | [confirmed] |
| A14 | **The login register field is narrower than the others.** The "Create a new account" hint sits on a floating gradient bar under the window. | `screens/login.ts`. | [seen] |
| A15 | **The character stands in a T-pose** in select, create and world. This is animation, not UI; reported to the animation lane. | — | [seen] |
| A16 | **The layout is fragile.** | Positions are hand-coupled: `left: calc(8px + 228px * var(--ui))` (`hud/ux-style.ts:11` hard-codes the player-frame width), `top: calc(8px + 80px * var(--ui))` in `party.ts` (CSS line 269 and inline at line 491) and `skills-style.ts:113`, the same 228-px coupling in `world/features/map.ts:45` (`.fld-stream-stats`), and a `bottom: calc(52px * var(--ui) + 12px)` media query for the chat (`hud/ux-style.ts:190`). | [confirmed] |
| A17 | **No retail cursor** (the OS arrow). The client has `Media/cursor/cursor_normal1.tga` (the flame hand). | — | [confirmed] |
| A18 | **Damage numbers are DOM text.** | Retail digit art `interface/hitcount/*` is unused (UX_GAPS H6). | [confirmed] |
| A19 | **The "Sound: Off" corner button** sits in the minimap's corner on every screen. | `main.ts` corner block (the sound lane owns the mute). | [seen] |

What is **good** and stays: the art pipeline (`ui/art.ts` manifest, the `bakedText` guard), live i18n text, the item tooltip data and order, the window drag and remembered positions, the KeyMap, and the outer screens' use of the retail resinfo layouts.

---

## 2. Retail census (vSRO 1.188)

### 2.1 Where the art is

`Media.pk2` is already extracted to `work/extracted/Media/` [confirmed]. The in-game interface is in `interface/<folder>/*.ddj`. File counts:

| Folder | Files | What |
|---|---:|---|
| `ifcommon` | 585 | Shared controls and the `window_all` atlas. Note the stray duplicates in `ifcommon/ifcommon/`. |
| `frame` | 174 | 8-piece window frames |
| `underbar` | 93 | Quick-slot bar (old and 2009) |
| `skill` | 89 | Skill window: tabs, mastery bar, level digits |
| `alchemy` | 86 | Alchemy windows and effects |
| `guild` | 160 | Guild and community |
| `stall` | 58 | Stall |
| `chattingwnd` | 59 | Chat |
| `hitcount` | 52 | Damage digits (player / enemy / plain / shadow), critical, block, miss |
| `quest` | 47 | Quest window |
| `equipment` | 45 | Equipment panel and slot silhouettes |
| `quick_slot` | 42 | Extra quick-slot bars |
| `playerminiinfo` | 39 | Player frame, gauges, berserk art, low-HP effects |
| `party` / `quickparty` | 37 / 18 | Party window and frames |
| `messagebox` | 38 | Dialogs, rebirth box |
| `option` | 56 | Options window |
| `targetwindow` | 26 | Target gems, icons, gauges |
| `minimap` | 25 | Minimap plate, signs, buttons |
| `store` / `exchange` / `npc` | 23 / 4 / 13 | Shop tabs (incl. the stable), trade, NPC talk |
| `animal` | 27 | Horse/pet (COS) control |
| `durabilityerror` | 2 | Broken and warning icons |
| `item_number` | 10 | 8×8 stack-count digits |
| `worldmap` | 5,063 | Map tiles and buttons (already used by the world map) |

Almost all in-game art is **textless** (tabs are icon-only; `stall/*`, `skill/*_tab_*`, `str_*` checked by eye) [confirmed for the folders looked at]. The exceptions carry **English**: `underbar/ub_new_menu*` ("MENU ▲"), `ub_new_mainbar2` (slot digits 1–0 **and** the "MENU ▲" tab, baked in at about x 686–751, y 1–20), `ub_new_mainbar3` (the same "MENU ▲" tab, no digits), `skill/skl_button_add` ("ADD"), `skl_button_up` ("UP") [confirmed by eye on the decoded textures, fact-check]. The Korean/Vietnamese baked text is in the outer screens (`bakedText` in `export-ui.ts`) and `character/chr_window` [confirmed].

### 2.2 Layout data (resinfo)

`Media/resinfo/*.txt` is ASCII. Each control is a `NAME:CClass { … }` block of typed properties: `Rect=RECT,"x,y,w,h"`, `DDJ=STRING,"interface\\…"`, `Text=STRING,"UIIT_…"`, `FontColor=COLOR,"A,R,G,B"`, `FontIndex`, `Style`, `UV_LT/UV_RB=POINT,"u,v"` [confirmed]. Things a reader must know:

- **Frame prefixes.** A `DDJ` that ends in `_` names an 8-piece frame (`CIFFrame`, `CIFSubFrame`, `CIFStretchWnd`): `<prefix>{left_up,mid_up,right_up,left_side,right_side,left_down,mid_down,right_down}.ddj` [confirmed].
- **`#ifdef` can sit inside a control block**, around a single property. For example, `iftw_commonenemy.txt` has `GDR_TWCE_TEXT_ID Rect` 34,10,170,12 under `UI_UPDATE_2009_FIRST` and 137 wide otherwise [confirmed]. A parser must honour the defines in `Media/config/define.txt` (22 lines; `UI_UPDATE_2009_FIRST`, `RENEWAL_SHOP_SYSTEM`, `APPLY_EXCHANGE_UPDATE_1TH`, `EUROPE_SYSTEM`, …) [confirmed].
- **Coordinate space.** In-game top-level rects (`ginterface.txt`) are laid out for **1024×768** [likely]. The evidence: underbar at (112,684,800,52), so it is centred at 512; the minimap at x 892. The outer screens use 1600×1200 (`export-ui.ts` header) [confirmed]. The client re-anchors to the screen edges [likely].
- **`FontIndex`**: 0 is used 3,547 times, 2 is used 156 times (buff digits, small), 1 is used 30 times (the HP/MP numbers); 3, 4 and 7 appear 2, 2 and 3 times [confirmed counts]. Pixel sizes are not in the data [unknown]; §4.3 fixes them.
- **Atlas UVs.** Controls drawn from `ifcommon/window_all.ddj` (1024×512) take their region from the UV rect, in 0..1 of the atlas [confirmed]. §2.7 lists them.

### 2.3 Window chrome families (8-piece frames)

The piece sizes are the native sizes of left_up / mid_up / right_up / side / mid_down / corners-down [confirmed]. The "Used by" column comes from resinfo.

| Family (prefix) | Pieces (px) | Look | Used by (resinfo) |
|---|---|---|---|
| `frame/mframe_wnd_` | lu 40×68, mu 128×68, ru 40×68, ls/rs 40×128, ld 40×48, md 128×48, rd 40×48 | **Main window**: 36-px title strip with a gold rim, dark marble body, thin gold border | Main popup 388×408, system 214×245, options 386×413 (`ifsystemwnd.txt` `GDR_OPTION`), NPC 386×451, storage 254×317, shop **254×370** (`CIFStoreForPackage`: `RENEWAL_SHOP_SYSTEM` and `RESTORE_SOLDITEM_INSHOP` are both defined), trade **365×500** (`APPLY_EXCHANGE_UPDATE_1TH` + `UI_UPDATE_2009_FIRST`; 254×361 is the no-define branch), stall 467×490, world map 652×424, community/guild 477×393, quest info 315×142 (`ginterface.txt`) [confirmed, define-aware parse, fact-check] |
| `frame/sframe_wnd_` | lu 16×36, mu 128×36, ru 16×36, ls/rs 16×128, ld/rd 16×16, md 128×16 | **Sub-panel** with a **blue** title strip (section caption) | Quest list 365×355, party 364×303, player info 364×356, storage items 236×241, trade halves **346×141** (fact-check), action |
| `inventory/int_window_` | all 16×16 (mid_down 24×16) | Inner framed box | Bag 176×308, shop items 236×219, system inner 180×185, stall inner 447×440, option pages 364×313 at (11,62) |
| `equipment/equip_window_` | corners 12×12, edges 64×12 / 12×64 | Thin inner frame | Equipment 178×355, skill 364×333, community pages 451×320 |
| `frame/frameg01_wnd_` | corners 16×16, edges 96×16 / 16×96 | Grey frame | Guild frame 440×211 and 19 others |
| `frame/frameg_wnd_` | corners 24×16, edges 128×16 / 24×52 | Grey frame, wide sides | 11 uses |
| `messagebox/msgbox2_window_` | lu/ru 16×40, mu 64×40, sides 16×64, bottom 16×16 / 64×16 | **Dialog** with a title strip | Skill practice box, guild dialogs, whole-chat, item-mall confirm (327×155) |
| `npc/npc_conversation_window_` | corners 20×20, edges 128×20 / 20×128 | Heavy black-rimmed text box | NPC talk 364×391 inside the NPC window |
| `frame/frame_tooltip_` | all 8×8 | Navy-blue rim | Tooltips [likely: no resinfo file names it; the tooltip is drawn by code] |
| `frame/frame_msg_` | all 4×4 | Thin black box | Text fields in dialogs |
| `ifcommon/com_blacksquare_` | all 4×4 | Black inset box | Trade model views, input frames |
| `ifcommon/lattice_window/com_lattice_outline_` | all 4×4 | Lattice outline | Around every slot grid |
| `ifcommon/com_bar01_…04_` | 3-slice: left 4 / mid 24 / right 4, height 24 (bar04: 48) | Row bars; `com_bar01select_*` has an orange outline (the selected row); `bar02` is blue | Lists (120 uses) |

**Body fill.** `mframe_wnd_`'s pieces carry the body texture near their edges, and the centre is filled with a tile [likely]. `ifmainpopup.txt` puts `com_bg_tile_a` at (40,154,308,124). Composed with `com_bg_tile_a`, the frame matches the look by eye (`work/tmp/ui/ref/frame-mframe-int.png`). Inner areas use `com_bg_tile_b` (options, system, party, trade), `com_bg_tile_c` (quest separators, storage), `com_bg_tile_d` (skill, NPC talk, equipment) and `com_bg_tile_e` (4×4 near-black, text fields) [confirmed].

### 2.4 Controls (ifcommon and others)

Most have `_focus` (hover), `_press` and `_disable` variants [confirmed], with gaps the kit must tolerate (fact-check): the tab textures have `_on`/`_off`/`_disable` but no `_focus`; `com_scroll_button` has only `_press`; `com_casting_cancel` has only `_press`; `com_red_button`/`com_green_button` have no `_disable`. Seen in `work/tmp/ui/ref/kit-controls.png`: normal is tan, focus is orange, press is dark red, disable is grey.

| Control | Texture(s) | Size | Notes |
|---|---|---|---|
| Button, standard | `ifcommon/com_button{,_focus,_press,_disable}` | 76×24 | The resinfo default for OK/Cancel/Repair (`ifmessagebox.txt`, `ifstore.txt`). Rivets in the corners. |
| Button, medium | `com_mid_button*` | 88×24 | World map "Auto move". Also `com_mid_button02` (112×24, plus `_ani`) and `com_mid_button03` (96×28). |
| Button, small | `com_m_button*` 52×20, `com_m_button02*` 56×24, `com_m_button03*` 96×24, `com_s_button*` 44×20 | — | — |
| Button, system | `system/sys_button*` | 152×24 | System window rows (`ifsystemwnd.txt`, x 31, pitch ~33) |
| Button, colour | `com_red_button` 56×24, `com_green_button` 56×24, `com_blu_button` 40×24 | — | Accept/decline |
| Close | `com_windowclose*` 16×16; `com_d_windowclose*` 16×16 (dark) | — | Target close at (176,9) in a 196-wide window |
| Tabs | `com_tab_{on,off}` 60×24 (on = cyan, off = navy); `com_tab2_*` 60×24 (pink/purple); `com_long_tab_*` 72×24; `com_short_tab_*` 56×24; `com_sub_tab01_*` 68×28 (orange/black); `com_sub_tab02_*` 68×28; `com_new_tab_{on,off}_{left,mid,right}` 12×24 (**3-slice, any width**) | — | Skill tabs are icon art: `skill/skl_*_tab_{on,off}` 60×24, 68×28, 76×28 |
| Checkbox | `com_checkbutton_{off,on}` 16×16 (`_on` is a red tick); `com_checkbutton02_*` 12×12; `com_checkbutton03_*` 16×16 | — | `ifcheckbox.txt` |
| Radio | `com_radiobutton_{off,on,press}` 16×16 | — | — |
| Vertical scroll | up `chattingwnd/chat_arrow_up*` 16×16 at (0,-16); down `chat_arrow_down*` 16×16; thumb `ifcommon/com_scroll_button*` 16×16; track `com_scroll_bar` 16×16 (tiled) | — | `ifverticalscroll.txt` |
| Slider | prev `com_left_bigarrow` 24×24 at (2,2), next `com_right_bigarrow` at (125,2), thumb `com_scroll_button` at (24,4) | — | `ifsliderctrl.txt`; options volume uses `option/opt_volume2_{prev,next,thumb}*` |
| Spin | `com_left_arrow*` / `com_right_arrow*` 16×16 at (0,0) and (34,0), text (16,4,18,12) | — | `ifspincontrol.txt` (storage pages) |
| Plus / minus | `com_plus_button*`, `com_minus_button*` 20×20; `com_plus_smallbutton` 16×16 | — | Stat points: `GDR_PI_BTN_ADDHP` (62,109) |
| Money | `com_moneybutton*` 20×20 | — | Inventory gold (12,310); storage (78,286) |
| Slot | lattice cell `lattice_window/com_lattice_{left,right}_{up,down}` 36×36 (equipment silhouettes `equipment/equip_slot_*` are 40×40, weapon/shield 56×56, behind 32×32 slots); hover and select `com_item_select` 32×32; item signs `com_itemsign{,_plus,_magic,_rare,_skill,_unipue}` 12×12; broken `icon/icon_item_broken`; warning `icon/icon_item_warning`; disabled `icon/icon_disable` | — | Slot grid pitch 36 (bag lattice 18,13 → 144×288 = 4×8) |
| Stack digits | `item_number/item_number_{0-9}` | 8×8 | Bottom-right of the slot |
| Casting bar | `com_casting_window` 192×36; gauges `com_casting_gauge_{skill,health,return,spool,collection,recallguild}` 184×8, plus `_bright` 192×16; cancel `com_casting_cancel` 20×20 | — | `ifdelayinfo.txt`: name (0,7,167,12), cancel (171,4), gauge (6,27,184,8); board at (416,606) |
| Notice banner | `com_notice_corner` 40×8, `com_notice_edge` 4×8, `com_notice_edge2` 40×8 (also `com_warning_*`, `com_quest_*`) | — | Top-centre notices |
| Tooltip | `frame/frame_tooltip_*` 8×8 ×8; also `com_tooltip_corner` 8×8 and `com_tooltip_edge` 8×4 | — | — |

### 2.5 HUD pieces

| Piece | Retail data | Tag |
|---|---|---|
| **Player frame** `GDR_PLAYER_MINI_INFO` (4,7,212,70) | Atlas region (741,0,212,70). Portrait (15,7,48,48). Name (71,4,93,15). Level (168,7,37,15) `#FFD953`. HP gauge (79,25,124,12) `pmi_hp` and MP (79,41,124,12) `pmi_mp`. HP and MP text over the gauges (79,26) / (79,42), FontIndex 1. Stat+ button `com_plus_button` (150,3,16,16). Info button `pmi_button` (41,56,20,20). Party-leader mark (53,12). Race mark (53,41,24,24). Low-HP effects `pmi_hp_cha_effect_caution` (75,25,128,32, Style 512). Select glow `pmi_select` (-4,-3,220,80). **Berserk**: 5 orbs `pmi_jahwan` 8×8 at (7,13) (4,28) (7,43) (17,54) (31,60), button `pmi_jahwan_button` (16,-5,20,20), face glow `pmi_jahwan_face` (15,7,48,48), frame glow `pmi_jahwan_glow` (-4,-3,220,80). Pet/horse mini info (53,55,154,40), atlas (867,71). | [confirmed] |
| **Buffs** `GDR_MAGICSTATEBOARD` (220,10,160,40) | 10 blessing icons 20×20 at x = 0,21,…,168, y = 0, each with a time gauge (x,20,20,4) `icon/stateodd/s_stateodd_time_gauge`. 10 curses at y = 27, gauges at y = 47. Digits FontIndex 2. | [confirmed] |
| **Target window** `GDR_TARGETWINDOW` (442,10) | 2009 variants, 236 wide (atlas regions §2.7). Monster: gem (8,5,20,20), name (34,10,170,12), HP gauge `tw_hp` (14,37,168,4). Special monster (champion/giant/unique…) is 236×78: level (10,56,30,16), variant icon (65,54,16,16), level text (85,56,168,12). Player: 236×35. Buffs `GDR_TW_BUFF` at (0,37). Close (176,9). Gems `tw_gem_{weak2,weak1,normal,strong1,strong2,npc,player,animal,wanted_rank}`; icons `tw_icon_{normal,champion,giant,titan,elite,unique}`. | [confirmed]; the gauge y inside the 236 art is [likely] |
| **Minimap** `GDR_MINIMAP` (892,6,140,184) | Plate `mm_window`. Area name (12,9,104,12) `#EFDAA4`. X (8,32,56,11), Y (67,32,56,11). Map circle alpha `mm_alpha` (14,57,105,105). Zoom in `mm_zoomin` (107,136,20,20), zoom out `mm_zoomout` (90,152,20,20). World-map button `mm_map_button` (99,47,24,24). Signs `mm_sign_*` (8×8 monster/npc/party/otherplayer/animal, 12×12 unique, 16×16 character/location/questnpc/partyarrow, 32×32 questarrow). | [confirmed] |
| **Underbar (2009)** | `ub_new_mainbar2` 800×68 (digits 1–0 and the "MENU ▲" tab baked in) and `ub_new_mainbar3` (MENU tab, no digits). Rows 0–6 are transparent except the tab (x ≈ 686–751, y ≈ 1–20); the bar body starts at y = 7 [confirmed, alpha scan, fact-check]. `ginterface.txt` still places the old 800×52 bar `ub_window_01` at (112,684), i.e. H − 84 at 768; no resinfo file lays out the 2009 bar, so its screen y is [unknown] (client code). Decorations `ub_new_deco_left/right` 76×64. **EXP band:** 10 segments of 76 px at x = 19 + 78·i, y ≈ 59, 8 px high, filled with `ub_new_exp_bar` 76×8. The dividers were measured at x = 95/96, 173/174 … 797. SP-EXP gauge `ub_new_sp_bar` 176×8 in the left box. Mouse "M" slot. Page arrows `ub_up_arrow`/`ub_down_arrow` 20×12 with the page digit between. Right panel: `ub_new_character`, `ub_new_inventory`, `ub_new_skill`, `ub_new_mall` (32×32 each, 4 states). MENU tab `ub_new_menu` 78×24 opens a list of `ub_new_menu_button` rows (124×20) with `ub_new_icon_*` icons (20×20): action, alchemy, apprenticeship, collection, commu, guild, making, pt, ptm, quest, recovery, stall, stallnet, system. The old layout (`ifunderbar.txt`, no `#ifdef`): slots 1–10 are 32×32 at x = 289 + 36·i, y = 11; an extra slot `GDR_TMPQS_0` at (238,11); SP gauge `ub_sp_bar` (17,11,144,8); EXP text (18,31,198,12); page arrows (652,9) / (652,33); MENU button `ub_menu_button` (688,−17,60,56) [confirmed]. The 2009 slot frames sit at the same 36-px pitch (measured on the art, §4.5) [likely]. | Textures and the measured band: [confirmed]. The positions of the 2009 parts other than the band come from the image [likely]; the build lane measures them against the texture (§4.5). |
| **Chat** `GDR_CHAT_BOARD` | Box pieces `chat_window` (up/mid/down strips of 381 wide). Tab lamps (4×8) at x = 50/101/152/203/254 on y = 6 (all/party/guild/ally/apprentice). Lists (27,28,365,343). Scroll (0,36,16,308). Input `GDR_CHAT_INPUTBOX` **(38,378,360,20)** under `UI_UPDATE_2009_FIRST` ((18,378,381,20) is the `#else`; fact-check), drawn from atlas (18,15,381,20). Background strips `chat_window` up (18,21,381,4) / mid (18,25,381,348) / down (18,373,381,4). Size button `chat_zoom` (0,378). Whisper-list button (15,0). Hide-tabs button (30,0). Mode button `chat_order_button` (18,378,20,20). Mode list `GDR_CHAT_MODE_VIEW_WND` (0,0,136,20) (2009 only). The one-piece `chat_window_{small,medium,big}` are 400×20/112/168; `chat_tab` 52×20; `chat_long_tab` 100×20. | [confirmed] |
| **System messages** `GDR_SYSTEM_MESSAGE_VIEW` (0,552,350,126) | A separate log box with a filter button (`chat_filter_button`) and a size button. | [confirmed] |
| **Party frames** `GDR_QUICKPARTYBOARD` (4,137) | **7** slots `GDR_QPB_SLOT_0..6` (the other members of an 8-player party), 122×40 from atlas (741,71), stacked 44 px apart (slot 6 at y = 264). Plus `quickparty/qpt_*`: face 28×28, `qpt_hp`/`qpt_mp` 76×4, far-away faces. | [confirmed] |
| **Casting bar** `GDR_DELAY_GAUGE_BOARD` (416,606,192,112) | See §2.4. | [confirmed] |
| **Durability** `GDR_EQUIP_DUR_ERROR_WND` (615,5,277,32) and `GDR_EQUIP_STATE_WND` (824,74,68,96) | Error icons 32×32 stacked 35 px apart (`ifdurabilityerr.txt`), `durabilityerror/broken`, `warning` 128×64. The equipment-state figure uses `ifcommon/com_re_{arms,avatar,shield,sword}{,_r,_y}` 68×96 overlays (red = broken, yellow = low). | [confirmed] |
| **Damage digits** | `hitcount/hitcount{,_player,_enemy}_{0-9}` 36×60, `_shadow`, `critical*` 96×24, `blocking*` 104×40, `miss_{enemy,player}` 60×28, `resist` 280×100 | [confirmed] |

### 2.6 Palette and fonts

`FontColor` census over all resinfo files (ARGB → hex) [confirmed counts]:

| Count | Colour | Role (from where it is used) |
|---:|---|---|
| 3069 | `#FFFFFF` | Values, default text |
| 133 | `#EFDAA4` | **Labels** (stat names, minimap area, alchemy title) |
| 124 + 7 | `#FFF5DA` / `#FEF5DA` | Button text |
| 71 | `#FEFBD8` | Button text (dialogs, store) |
| 42 | `#FFF7CA` | Captions |
| 25 | `#FFEF99` | Highlight, chat option board |
| 25 | `#FFD953` | **Level, skill points, pet level** |
| 24 | `#FFF9D4` | Captions |
| 13 | `#FFE27B` | Headings |
| 12 + 11 | `#2C0F01` / `#3D2200` | Dark ink on paper (`gd_paper_02`, quest paper) |
| 11 | `#FFFF00` | Warnings |
| 9 | `#97E0FF` | Mastery totals (light blue) |
| 9 | `#EF99FF` | Pink (apprentice, chat option) |
| 6 | `#FFFF94` | Party names |
| — | `#FFF57A`, `#FFBA4D` | Party lamp, guild lamp |

**Fonts** (`Media/fonts`) [confirmed]:

- `영문서체.ttf` → `english.ttf`: Arial Rounded MT Bold, 242 glyphs.
- `기본서체.ttf` → `basic.ttf`: TaeUtum, 13,588 glyphs, TrueType, locFormat 1.
- `채팅서체.ttf` → `chat.ttf`: SeUtum, the light cut of TaeUtum.

Chrome's font sanitiser (OTS) rejects `basic` and `chat`. The table directory header is off (UX_GAPS L2): 13 tables, `searchRange` 48 / `entrySelector` 3 / `rangeShift` 128, where 128 / 3 / 80 are expected; `english.ttf` (14 tables incl. `kern`) is correct [confirmed, fact-check]. Recent OTS versions only warn about and fix a bad `searchRange`, so the header alone may not be the cause [likely]. Their `loca` is monotonic and inside `glyf` (checked with `work/tmp/ui/fontcheck.ts`), so the fault is probably one glyph's data or the hinting programs (`fpgm`/`prep`/`cvt `) [likely]. `0.dat`, `i.dat` and `y.dat` are small `JMXVIMG` bitmaps, not font data [confirmed header].

### 2.7 The `window_all` atlas

These are all the resinfo uses of `ifcommon/window_all.ddj`, as pixel rects in the 1024×512 atlas [confirmed, `work/tmp/ui/atlas.ts`]. The 2009 (`UI_UPDATE_2009_FIRST`) ones are marked ★.

| Atlas rect (x,y,w,h) | Used by | Export key (new) |
|---|---|---|
| 741,0,212,70 | Player frame `GDR_PLAYER_MINI_INFO` | `ifcommon/wa_pmi` |
| 741,453,236,36 ★ | Target: monster (`GDR_TW_COMMONENEMY`, rect 236×51) | `ifcommon/wa_tw_enemy` |
| 741,374,236,78 ★ | Target: special monster | `ifcommon/wa_tw_special` |
| 504,367,236,35 ★ | Target: player | `ifcommon/wa_tw_player` |
| 543,210,196,58 | Target: job player (both variants) | `ifcommon/wa_tw_job` |
| 741,321,236,51 | Target: fortress structure | — |
| 543,0,196,51 / 543,52,196,78 / 543,289,196,36 | Pre-2009 target windows | — |
| 741,71,122,40 | Party frame slot `GDR_QPB_SLOT_n` | `ifcommon/wa_party_slot` |
| 867,71,154,40 | Pet/horse mini info | `ifcommon/wa_pet` |
| 18,15,381,20 | Chat input box | `ifcommon/wa_chat_input` |
| 401,0,141,153 | System-message filter board | `ifcommon/wa_sysmsg_filter` |
| 741,166,141,153 | Whisper list | `ifcommon/wa_whisper_list` |
| 401,154,135,189 | Player-frame stat panel (`GDR_PMI_STA_CINFOBG`) | `ifcommon/wa_pmi_stats` |

### 2.8 Cursors

The pk2 holds only `Media/cursor/cursor_normal1.tga`: 32×32, 32-bit, uncompressed true-colour (type 2), image descriptor 0x08 (8 alpha bits, bit 5 clear = **bottom-up**, origin bottom-left; fact-check: the draft said top-down; `work/tmp/ui/tga.ts` does flip it correctly); a flame-coloured pointing hand [confirmed header bytes]. The hotspot is near (2,2) [likely]. The attack, talk, pick-up and other cursors are not in any pk2 and not in the client folder (`silkroad.exe` is the launcher; `sro_client.exe` is absent) [confirmed]. So we have no retail source for them [unknown].

### 2.9 Not available / unknown

- The pixel sizes behind FontIndex 0/1/2 [unknown].
- Retail item-name colours per rarity: textdata does not state them, and `itemrare.txt` only lists codes [unknown]. §4.8 picks colours.
- The exact 2009 underbar positions apart from the EXP band [likely, measured in §4.5].

---

## 3. Design principles

1. **Retail pixels.** Each HUD piece and window is laid out in native pixels, with the rects from resinfo wherever they exist. A human only designs what retail does not have.
2. **One scale layer.** The in-game UI containers get `zoom: var(--ui)`: today these are `.hud-root` (created in `hud/index.ts createHud`, appended to `#ui`) and a new `.world-ui` wrapper for the chat, minimap, perf and help elements that `screens/world.ts` appends to `.screen.world` (lines 203–219, 375). Children are positioned in native px. There is no `calc(… * var(--ui))`, and no per-element `transform: scale`. **Screen-projected elements stay outside the zoomed layer** (or divide their px by `--ui`): `.entity-labels`, nameplates, and the damage `Floaters` (`hud/effects.ts:70` translates by projected screen px) [confirmed code, fact-check].
3. **Live text, retail chrome.** Words come from i18n. Frames, buttons, tabs, gauges and slots come from art.
4. **Tokens, not literals.** Colours, fonts and spacing are CSS custom properties defined once (§4.3–4.4). A lane that needs a new colour adds a token.
5. **Nothing is lost.** Every current window keeps its data flow, intents, key bindings and tests. Only the view layer moves to the kit.

---

## 4. The design

### 4.1 UI scale

```ts
// apps/game/src/ui/kit/scale.ts
export const UI_STEPS = [1, 1.25, 1.5, 2, 2.5, 3] as const
export type UiScaleMode = 'auto' | (typeof UI_STEPS)[number]
/** Auto: the largest step with 1280×800 native px of room; never below 1 unless the viewport is smaller than 1024×700. */
export function autoScale(vw: number, vh: number): number {
  const fit = Math.min(vw / 1280, vh / 800)
  if (vw < 1024 || vh < 700) return Math.max(0.75, Math.min(1, Math.floor(Math.min(vw / 1024, vh / 700) * 8) / 8))
  let s = 1
  for (const step of UI_STEPS) if (step <= fit + 1e-6) s = step
  return s
}
export function uiScale(mode: UiScaleMode, vw: number, vh: number): number
/** `pixelated` when scale × devicePixelRatio is a whole number, else `auto` (bilinear). */
export function artRendering(scale: number, dpr: number): 'pixelated' | 'auto'
```

| Viewport (CSS px) | Auto `--ui` | Native room | Tag |
|---|---|---|---|
| 1024×768 (retail) | 1 | 1024×768 | [unknown] rule, [confirmed] arithmetic |
| 1280×720 / 1366×768 | 1 | 1280×720 / 1366×768 | |
| 1920×1080 | 1.25 | 1536×864 | |
| 2560×1440 | 1.5 | 1707×960 | |
| 3840×2160 (4K, DPR 1) | 2.5 | 1536×864 | |
| 4K laptop at DPR 2 (1920×1080 CSS) | 1.25; 1.25 × 2 = 2.5 device px per art px is not whole, so `artRendering` returns `auto` (bilinear, slightly soft art); text is vector and sharp | 1536×864 | |
| 900×600 (small window) | 0.75 (the code: `floor(min(900/1024, 600/700) × 8) / 8` = 6/8; fact-check, the draft said 0.875) | 1200×800 | |
| Phone landscape 844×390 | 0.75 | ~1125×520: the HUD still fits, windows scroll | |

- The Options "UI scale" becomes a select: Auto, 100%, 125%, 150%, 200%, 250%, 300%. New setting `ui.scaleMode` (default `'auto'`). The old `ui.scale` multiplier is ignored and dropped from Options [unknown].
- `document.documentElement.style.setProperty('--ui', …)` and `--art-rendering` are set from `app.ts updateScale()` (today lines 94–97: `min(w/1280, h/860)` clamped 0.7–1.6 × `settings.ui.scale`). The `settings.onChange` listener at `app.ts:87–90` that re-dispatches `resize` compares `s.ui.scale`; it must compare `s.ui.scaleMode` instead. The kit CSS applies `image-rendering: var(--art-rendering)` to art.
- Outer screens (login … loading) keep their own letterbox layout, but use the same `--ui` steps instead of `min(w/1280, h/860)`.

### 4.2 Screen layout (world HUD)

All positions are in native px inside the zoomed layer, where `W×H` is the viewport divided by `--ui`. Anchors keep the retail offsets [confirmed rects; anchoring rule likely].

| Element | Anchor | Position / size | Source |
|---|---|---|---|
| Player frame | top-left | (4,7), 212×70 | `GDR_PLAYER_MINI_INFO` |
| Berserk orbs and button | on the player frame | §2.5 rects | `ifplayerminiinfo.txt` |
| Horse/pet frame | on the player frame | (53,55), 154×40, shown while mounted | `GDR_PMI_PET_MINI_INFO` |
| Buffs / debuffs | top-left | (220,10); 2 rows of 10 × 21 px | `GDR_MAGICSTATEBOARD` |
| Party frames | top-left | (4,137); 122×40 slots, 44-px pitch, 7 slots | `GDR_QUICKPARTYBOARD` |
| Target window | top-centre | x = (W−236)/2, y = 10; buffs under it at +37 | `GDR_TARGETWINDOW` is at x = 442 at 1024, which is **not** centred (centre + 48 for the 236-wide art) [confirmed]; centring is our [decision] |
| Durability warnings | top-centre-right | (W−409, 5), 277×32 | `GDR_EQUIP_DUR_ERROR_WND` (615 at 1024) |
| Equipment state figure | top-right | (W−200, 74), 68×96, only when something is worn down | `GDR_EQUIP_STATE_WND` |
| Minimap | top-right | (W−132, 6), 140×184 | `GDR_MINIMAP` (892 at 1024 → W − 132). The 140×184 texture `mm_window` has opaque content only in (0,0,129,172), so the plate ends 3 px from the right edge [confirmed, fact-check: the draft's W−144 left a 15-px gap] |
| Quest tracker | top-right | right edge at W−4, top y = 196, width 200 | new [unknown] (under the minimap, as in retail's quest notify area) |
| Notices / area banner | top-centre | y = 96, `com_notice_*` frame, max width 480 | [unknown] |
| Casting bar | bottom-centre | x = (W−192)/2, y = H−162 | `GDR_DELAY_GAUGE_BOARD` (416,606) at 1024×768: 416 = (1024−192)/2, 606 = 768 − 162 [confirmed, fact-check: the draft's H−112 was invented] |
| Level-up banner, centre messages | centre | y = H·0.30 | today's `LevelUpBanner` / `HudMessages` |
| Underbar | bottom-centre | x = (W−800)/2, y = H−68; decorations at −76 and +800 | x from `GDR_UNDERBAR` (112 at 1024) [confirmed]; y = H−68 flush with the bottom is our [decision] (retail places the old 52-px bar at 684 = H−84; the 2009 bar's y is not in the data) |
| Chat | bottom-left | x = 0, width 400; bottom = H−72 (above the underbar) unless W ≥ 1752, then bottom = H−4 beside the underbar's left decoration (fact-check: the draft's W ≥ 1280 threshold overlaps the bar, whose left decoration starts at (W−800)/2 − 76 = 164 at W = 1280; 400 ≤ (W−800)/2 − 76 needs W ≥ 1752) [decision] | `GDR_CHAT_BOARD` (0,546,399,398) at 1024×768 [confirmed rect] |
| System messages | bottom-left | 350×126, above the chat, off by default (Options) | `GDR_SYSTEM_MESSAGE_VIEW` |
| FPS overlay | top-left | (4, 80), under the player frame | UX_GAPS H1 |
| Damage numbers | world space | `hitcount` digits (§4.10) | |

**Collision rule.**

- Below W = 1752 the chat sits above the underbar, so it never covers it; at W < 1180 its width becomes 300 to leave room for windows [decision].
- The underbar with both decorations needs W ≥ 952 ((W−800)/2 − 76 ≥ 0).
- Below W = 952 the underbar decorations hide.
- Below W = 800 the underbar shows 8 slots and a page arrow [unknown].

### 4.3 Typography

| Token | Font | Size / line (native px) | Colour | Effect | Used for |
|---|---|---|---|---|---|
| `--t-title` | English (Arial Rounded MT Bold) | 12/14 | `#FFF7CA` | 1-px outline `#000` | Window titles in the mframe strip, centred |
| `--t-caption` | English | 11/13 | `#FFFFFF` | outline | sframe blue strips, tab labels |
| `--t-label` | basic | 12/15 | `#EFDAA4` | 1-px shadow | Field labels |
| `--t-value` | basic | 12/15 | `#FFFFFF` | shadow | Values, list text |
| `--t-level` | English | 12/14 | `#FFD953` | outline | Level, skill points, gold amount |
| `--t-gauge` | basic, bold | 11/12 | `#FFFFFF` | 1-px outline (FontIndex 1) | HP/MP/EXP numbers on gauges |
| `--t-small` | basic | 10/11 | `#FFFFFF` | outline | Buff timers, slot counts when digits art is off |
| `--t-button` | basic | 12/24 (centred) | `#FEFBD8`; disabled `#8A8A8A` | shadow | Button text |
| `--t-chat` | chat | 12/15 | per kind (§4.4) | shadow | Chat lines |
| `--t-body` | basic | 12/16 | `#FFFFFF` | shadow | Dialog and NPC text |
| `--t-paper` | basic | 12/16 | `#3D2200` | none | Text on paper (NPC quest paper `guide/gd_paper_02`) |

- Outlines use `text-shadow: 1px 0 #000, -1px 0 #000, 0 1px #000, 0 -1px #000` (the retail look) [likely]; shadows use `0 1px 1px #000`.
- **Font repair (export).** A new `packages/convert/src/tools/font-subset.ts` (TypeScript, no dependency) writes `basic.ttf` and `chat.ttf` as Latin subsets:
  - it keeps U+0020–007E, U+00A0–00FF, U+2013/2014/2018/2019/201C/201D/2022/2026/20AC and `.notdef`;
  - it copies only those simple glyphs, remapped;
  - it drops `fpgm`/`prep`/`cvt ` and zeroes every glyph's `instructionLength`;
  - it writes `cmap` format 4, `hmtx`, `loca` (long), `maxp`, `post` format 3, `head`, `hhea`, `OS/2` and `name`, with a correct table directory and checksums.

  Acceptance: `new FontFace(...).load()` resolves in Chrome for both, and the page loses `fonts-fallback`. If the subset still fails, the stacks fall back to `Tahoma, Verdana, sans-serif` (today's behaviour).
- **Fit rules.**
  - Buttons size to their text: min width = skin width, then +8 px padding each side (§5.3).
  - Labels that can overflow (names, item names) use `text-overflow: ellipsis` plus a `title` attribute.
  - Numbers use `font-variant-numeric: tabular-nums`.
  - No text is ever clipped by fixed art. The new i18n budget test (§8) checks it for the fixed-width places.

### 4.4 Colour tokens

Defined once in `ui/kit/tokens.ts` (as CSS on `:root`) [confirmed values from §2.6 unless marked]:

```css
--c-text: #ffffff;  --c-label: #efdaa4;  --c-level: #ffd953;  --c-button: #fefbd8;  --c-button-off: #8a8a8a;
--c-caption: #fff7ca;  --c-highlight: #ffef99;  --c-heading: #ffe27b;  --c-mastery: #97e0ff;  --c-party-name: #ffff94;
--c-warn: #ffff00;  --c-bad: #ff4a3d /*[unknown]*/;  --c-good: #7cff6b /*[unknown]*/;  --c-ink: #3d2200;
--c-chat-all: #ffffff;  --c-chat-party: #fff57a;  --c-chat-guild: #ffba4d;  --c-chat-whisper: #ef99ff;
--c-chat-system: #ffd953 /*[unknown]*/;  --c-chat-notice: #ffff00;  --c-chat-gm: #7fd3ff /*[unknown]*/;  --c-chat-error: #ff6a5a /*[unknown]*/;
--c-hp: #d8262c; --c-mp: #2c56d8 /*only for no-art fallbacks*/;
```

The chat party and guild colours are the `FontColor`s of the lamp statics in `ifchatviewer.txt` (party `#FFF57A`, guild `#FFBA4D`) [confirmed values; that the chat lines use them is likely]. The whisper pink `#EF99FF` is the chat-option colour [likely]. Add `--c-chat-stall: #c6b6ff` [unknown] for the stall channel.

**Conflict to settle at integration (fact-check).** `docs/SYSTEMS_SOCIAL.md` §9.1 ("Chat channels") picks guild `#f5c26b` and stall `#c6b6ff` for `world/chat.ts`. One value must win: the default here is that `world/chat.ts` reads `var(--c-chat-guild)` / `var(--c-chat-stall)` and the token keeps the retail lamp colour `#ffba4d`; the social lane then writes no hex of its own.

### 4.5 Underbar (quick slots, EXP, SP, menu)

One component, `hud/underbar.ts`, replaces `hud/hotbar.ts`'s box, `ExpBar` and `MenuBar`'s row. The hotbar **model** (`hotbar-model.ts`), keys, cooldowns and drag stay unchanged.

| Part | Rect in the 800×68 bar | Art | Tag |
|---|---|---|---|
| Background | 0,0,800,68 (body from y = 7; the MENU tab is baked into rows 1–20) | `ub_new_mainbar2` (default key labels 1–0); `ub_new_mainbar3` + live key labels when bindings are custom | [confirmed] |
| Decorations | −76,4 and 800,4 (76×64) | `ub_new_deco_left/right` | [likely] |
| Level box | about 1,50,18,18 (bottom-left square) | Live text `Lv` + number, `--t-level` | [likely] |
| SP-EXP gauge | the upper thin slot of the left box, about 15,25,176,8 | `ub_new_sp_bar` 176×8 | [likely] |
| SP text | the lower field of the left box, about 15,36,180,16 | "SP 1,234", `--t-level`; tooltip `hud.spExp` (today's) | [likely] |
| Mouse slot "M" | frame 206,13,42,42; icon well 211,18,32,32 (`underbar-layout.ts` MOUSE_SLOT / MOUSE_SLOT_ICON) | Retail GDR_TMPQS_0, "Mouse quickslot" (UIIT_STT_MOUSE_RIGHT_BUTTON; retail's input option chose the wheel or the right button for it). Ours: a skill or potion dragged onto it is used by the **middle mouse button** in the world, like its key (world/features/skills.ts); right-click or a drag off the bar clears it; it swaps with hotbar slots. A left click on the slot does not use it (only the wheel does). The server keeps it per character as slot `MOUSE_SLOT` (40) beside the 40 hotbar slots (migration 11); an entry an older client left in localStorage `sro.hotbar.mouse` is handed to the server once (`hud/mouse-slot.ts`) | [confirmed] art and retail text; storage is our rule |
| Quick slots 1–0 | 10 × 32×32 icons in the art's cells (pitch 36; first cell frame about x 257, y 15) | Icons 32×32; cooldown sweep and number from today's `Hotbar` | [likely] |
| Page arrows and page | about 626,16 / 626,40 (20×12) with the page digit between | `ub_up_arrow*`, `ub_down_arrow*`; pages = F1–F4 (`HOTBAR_PAGE_KEYS`, 4 × 10 = `HOTBAR_SLOTS` 40) | [likely] |
| Right panel | the box about 652,14,136,40 | Buttons `ub_new_character` (C), `ub_new_inventory` (I), `ub_new_skill` (S) (32×32, 4 states) inside it; tooltips carry the key | [likely] |
| MENU tab | about 680,0,78,24, laid over the tab baked into the bar | `ub_new_menu*` (78×24, 4 states): opens the menu popup | [likely] |
| EXP band | segment i at (19 + 78·i, 59, 76, 8), i = 0..9 | `ub_new_exp_bar` fill; segment i fills `clamp(f·10 − i, 0, 1)` with f = EXP fraction 0..1; text "12.34%" centred over the band on hover, and always in the level box tooltip | [confirmed measured] |

- **Measure, don't guess.** The "about" rects above were re-read by eye at 2× on the decoded texture during the fact-check (the draft's page-arrow, right-panel and MENU values were in the coordinates of the 960-px composite `ref/underbar-new.png`, not of the 800-px bar, and the SP rows were 11 px too high). The underbar lane runs `work/tmp/ui/measure.ts` (or its own copy) to find the cell borders in `ub_new_mainbar2`: scan rows and columns for the bright rims. It records the final rects as constants in `hud/underbar-layout.ts`, with a unit test that checks the ten slot rects are 36 apart.
- **Menu popup** (MENU tab or the Menu key). A column above the tab, drawn with the `frame/ub_new_wnd_*` frame (all eight pieces 20×20; no resinfo file names it, so the frame choice is [likely]). Rows are `ub_new_menu_button` (124×20) with an icon and live text.
- **Two registries exist today and both stay (fact-check; the draft merged them):**
  - `hud/menubar.ts` `MenuBar.register(entry: MenuBarEntry)` (`hud.menubar`; entries `{id, art, label, toggle, isOpen, order?, hotkey?}`; orders used: Character 10, Inventory 20, Skill 30, Quest 40, Party 50, Options 90). This feeds the **MENU popup** rows. Additive: `MenuBarEntry.icon?: string` (the `ub_new_icon_*` key; default from a small id → icon map).
  - `hud/menu-items.ts` `registerMenuItem(item: MenuItem)` (entries `{id, label, order, run(ctx), when?}`; Options 10, Key help 20, Sound 30, Character select 80, Log out 85, Back to game 90). This feeds the **System window** (Esc), which `screens/world.ts openMenu` (line 809) renders from `menuItems()`.

  Rows of the MENU popup:

  | Row | Icon | Opens |
  |---|---|---|
  | Character | `ub_new_character` | Main window, Character tab |
  | Inventory | `ub_new_inventory` | Main window, Inventory tab |
  | Skills | `ub_new_skill` | Main window, Skill tab |
  | Quests | `ub_new_icon_quest` | Main window, Quest tab |
  | Party | `ub_new_icon_pt` | Main window, Party tab |
  | Guild | `ub_new_icon_guild` | Guild window (guild lane) |
  | Stall | `ub_new_icon_stall` | Open a stall (stall lane) |
  | Alchemy | `ub_new_icon_alchemy` | Alchemy (alchemy lane) |
  | Action | `ub_new_icon_action` | Actions: sit, emotes (later) |
  | Options | `ub_new_icon_system` | Options |
  | System | `ub_new_icon_system` | System window (Esc) |

  A row without a registered window stays hidden (today's rule: `MenuBar.refresh` hides the bar while it has no entries).

### 4.6 Windows

**Window model.**

- `kit/Window` = `mframe_wnd_` frame + title strip (live title, drag handle, the full strip 36 px high) + `com_windowclose` at (w−28, 10) [likely] + body inset (16, 44, 16, 16).
- Windows cascade: a new window opens at the last opened window's position + (24,24), clamped to the screen. Remembered positions (`sro.hud.<id>`) still win.
- Esc closes the top window (today's behaviour).

**Main window** (`hud/main-window.ts`, new; `GDR_MAINPOPUP` 388×408, `mframe`):

- A side tab strip `mainpopup/main_systab_02` (texture 48×328, rect 48×326) at (−42,55) (`GDR_MAINPOPUP_LEFT_DECO_STATIC`). Buttons `main_sysbutton_{character,inventory,skill,action,party,quest,apprenticeship}` (28×28) at (−36, 78 + 42·k), k = 0..6 in that order [confirmed `ifmainpopup.txt`, fact-check: the draft named `main_systab` 48×284 at (−42,73) and y = 96 + 42·k]. We show Character, Inventory, Skill, Party and Quest; Action and Apprenticeship stay hidden until they exist.
- The page area is (13,38) or (13,63), per `ifmainpopup.txt`.
- Keys C/I/S/P/Q open the main window on that tab. Pressing the key of the tab already shown closes the window.
- Today's window classes become **pages**: their `body` moves into the tab page, and their public API (`open`, `close`, `toggle`, `isOpen`) keeps working by mapping to "main window on tab X" (see §7). `hud.openInventory()` for shops and storage opens the Inventory tab.

Per window (the source rects are retail; our content keeps today's data):

| Window | Frame / size | Layout (native px) | From today |
|---|---|---|---|
| **Inventory tab** | page 364×357 in the main window | Bag panel (13,63,176,333): `int_window_` 176×308, lattice outline (15,10,146,290), lattice (18,13,144,288) = 4 × 8 slots of 36; money strip `int_window_downbox` (0,305,176,28) with `com_moneybutton` (12,310) and live gold text right-aligned. Equipment panel (198,41,178,355): `equip_window_`, tile `com_bg_tile_d` (12,12,154,331), 13 slots with silhouettes `equip_slot_{helm,mail,shoulderguard,gauntlet,pants,boots,weapon 56×56,shield 56×56,earring,necklace,l_ring,r_ring,…}`, rotate buttons (54/81/96, 327), character preview in the middle (a small second Babylon view later; the silhouette until then). **48 bag slots** for a new character stay (the bag can grow to `MAX_BAG_SIZE` 96, `packages/shared/src/protocol.ts`); the 4×8 lattice pages (32 per page, up to 3 pages) or grows [unknown]. The help text line is removed; its text moves to the bag tooltip. | `hud/inventory.ts` (slots, drag, split, drop), the `hud/character.ts` equipment slots |
| **Character tab** | page (13,38,364,356) in `sframe_wnd_` | Retail `ifplayerinfo.txt`: tile `com_bg_tile_d` (16,26,332,37) with name, level, guild. Stats block `com_bg_tile_b` (16,75,332,173): STR/INT with `com_plus_button` (62,109)/(62,138), HP/MP, attack/defence/hit/parry rows (label `--t-label` left, value right). Job area (16,260,332,60) empty [unknown]. Stat points and SP show `--c-level`. | `hud/character.ts` stats and `statUp` (Ctrl 10 / Alt all kept) |
| **Skill tab** | page (13,63,364,333) in `equip_window_` | Tabs row (27,12,319,17 on `com_bg_tile_d`): mastery icon tabs `skill/skl_*_tab_{on,off}`. Board `int_window_` (6,29,351,270): mastery header `skl_mastery_subject` 352×44 with the level and `skl_mastery_levelup` (UP) button; skill rows (icon 32, name `--t-value`, level `skl_lv_number_*` digits, `skl_button_add`). Bottom box `skill/skl_wnd_box`: "Skill points" `#FFD953` (14,311), value (86,311); "Mastery total" `#97E0FF` (183,311) / (293,311). | `hud/skills.ts` rows, locking, tooltips, drag to the hotbar |
| **Quest tab** | page in `sframe_wnd_` 365×355, caption "Quest list" | List rows 27 px with `com_bg_tile_c` separators (every 27 px from y = 52); detail on the right half; `qst_*` art for colour bars (`qst_colorbar_{green,red,blue}` 220×20) [likely]. The tracker stays a HUD element (§4.2). | `quests/log.ts` |
| **Party tab** | page (13,38,364,337); `sframe_wnd_` 364×303, caption "Party" | Member rows `party/pt_slot` 360×36: face (9,33,28,28), name (71,32) `#FFFF94`, level, guild, HP `pt_hp` / MP `pt_mp` 136×4. Mode lines EXP/Items with `com_diamond`. Buttons `com_button` Invite (56,339), Settings (143,339), Match (230,339). Ours: Invite (the selected player), Settings, and Leave in Match's slot (party matching is not built). Settings and a click on a mode line open the party setting box (`ifsetpartymode.txt`: "Set the party properties.", EXP and item radio groups in `msgbox_blackbox_03` panels, Yes/No; `MessageBox.choose`), which also opens before every invitation that starts a party. | `hud/party.ts PartyWindow`, `ui/kit/dialog.ts` |
| **NPC dialog** | `mframe` 386×451 | Talk box `npc_conversation_window_` (11,48,364,391), tile `com_bg_tile_d` (20,20,324,351), text (23,23,302,343) `--t-body`. Options are underlined rows (hover `--c-highlight`). Quest text on `guide/gd_paper_02` in `--t-paper`. Title = NPC name. | `hud/npc-dialog.ts`, `quests/dialog-panel.ts` |
| **Shop** | `mframe` 254×370 (`CIFStoreForPackage`; fact-check) | Tabs `store/str_*_tab` or `com_tab` with live text (56×24) at y = 38 [likely: tabs are not in `ifstore.txt`]. Items frame `int_window_` (9,60,236,219), lattice outline (18,68,218,182), lattice (21,71,216,180) = 6 × 5, page spin (102,254,50,16). Buy-back row: `com_redeem_window` 188×40 at (57,285) with its label at (7,300). Detail tile `com_bg_tile_a` (40,279,174,54). **Repair** / **Repair all** `com_button` (86,332) / (166,332) [confirmed `ifstore.txt`]: built by the repair lane (`hud/repair.ts`, docs/SYSTEMS_COMBAT.md lane DR) and mounted in a footer host that `ShopWindow` exposes. **Stable-keeper**: the same window with the `str_stable01..04_tab` icon tabs (56×24). | `hud/shop.ts`, `shop-logic.ts` |
| **Storage** | `mframe` 254×317 | `sframe_wnd_` (9,38,236,241), caption "Stored items"; lattice (21,71,216,180) = 6 × 5; page spin (102,254,50,16); money row `store/str_slot_01` (9,283,236,24) with `com_moneybutton` (78,286). | `hud/storage.ts` |
| **Trade** (new, trade lane) | `mframe` **365×500** (fact-check: `APPLY_EXCHANGE_UPDATE_1TH` + `UI_UPDATE_2009_FIRST` are both defined; the draft used the no-define 254×361 branch; docs/SYSTEMS_SOCIAL.md §1 agrees) | Two `sframe_wnd_` halves (9,38,**346**,141) partner and (9,182,**346**,141) you. Lattice outlines (18,69,218,74) / (18,213,218,74), lattices (21,72,216,72) / (21,216,216,72) = 6 × 2 each (slots at 21 + 36·i, y 72/108 and 215/251). Gold `exchange/exc_box` 108×20 at (71,152) / (71,296), money buttons `com_moneybutton_disable` (40,152) / `com_moneybutton` (40,296), gold label (181,156) / (181,300). Separator lines `exc_sub_window_line` (14,146,226,4) / (14,290,226,4). Character views `com_blacksquare_` + `com_bg_tile_e` 100×104 at (247,70) / (247,214), `ch_red` 128×128 over the partner view (the "locked" effect), `ch_line` 8×116 at (238,61) / (238,205). Message box `frame_msg_` (10,339,345,95) with `com_bg_tile_e` (14,342,337,87) and `com_bg_tile_a` strips (24,315,310,29) / (24,426,310,32). **Two** buttons, `com_button`: exchange/confirm (96,450) and Cancel (193,450) [all confirmed, define-aware]. | new |
| **Stall** (new, stall lane) | `mframe` 467×490 | Inner `int_window_` (11,39,447,440) on `com_bg_tile_b` bands (27,55,415,53) / (27,324,415,34). Title row `stall/stl_slot_01` 308×28 at (48,50) with `stl_titlebutton` (22,51). Item list `GDR_STALL_DISPLAY` (22,108,423,216) in `equip_window_`: slot cells 208×44 (`stl_slot_02`/`_05`) in two columns, each with icon (3,3,32,32), name (46,6,132,14), amount (42,26,41,12), price (86,26,114,12), edit button `stl_edit_button` 24×24 at (183,0) (`ifstallslot.txt`). Greeting `stl_slot_03` 400×28 at (48,327) with `stl_wordbutton` (22,328). Chat module (22,357,423,110) in `equip_window_`. State button `com_button` (369,51); "Operating" label on `stl_slot_04` (350,85) with the state icon (354,88) [confirmed, fact-check: the draft used `stl_slot_03` as the item rows]. Tabs `stl_sale_tab` / `stl_purchase_tab` (80×24) exist but are not placed by `ifstall.txt` [unknown]. Price entry: `MessageBox.count`/`prompt`. | new |
| **Alchemy** (new) | `GDR_ALCHEMYBOX` rect 376×152 with `alchemy/alcm_window_1` (texture 376×172) + a sub-panel at (0,150) (`alcm_window_*`, 376×148…228) | Close `alcm_windowclose` (350,15). Title (10,20) `#EFDAA4`. Drag area (10,0,355,42). Reinforce sub-panel (coordinates relative to it): equipment slot (58,74), material slots at x 164/212/260/308 (y 74), process button `alcm_button_01` (104×28) at (136,178), deco (13,27,128,128). These are `ifnewalchemybox.txt` / `ifnewalchemyreinforce.txt`; the older `ifalchemyreinforce.txt` has y 56 and `alcm_button` 112×28 at (132,143); which file set 1.188 loads is [unknown]. docs/SYSTEMS_COMBAT.md §4.7 uses **three** slots (Equipment, Elixir, Lucky Powder): map them to the equipment slot, slot 164 and slot 212, and hide 260/308 [decision]. Effects `alcm_effect_{prepare,success,fail_1}` 256×256 on the slot. | new |
| **Guild** (new) | `mframe` 477×393 (the community window) | Page `equip_window_` (13,61,451,320). Tabs `guild/gil_{info,note,cut,friend}_tab` 72×24; member list `com_bar01_` rows plus `gil_bar02_{select,deselect}` 312×24; frame `frameg01_wnd_` (6,103,440,211). | new |
| **Options** | `mframe` 386×413 [confirmed `ifsystemwnd.txt` `GDR_OPTION`, fact-check] | Tabs `com_long_tab` 72×24 with live text (Graphics / Interface / Controls / Audio) [likely]; each page is an `int_window_` (11,62,364,313) (`GDR_OPTION_WND_*`); groups in `opt_inner_box_` frames on `com_bg_tile_b` (27,130,332,230); rows = label + control (kit Radio/Checkbox/Slider/Select); buttons Default (29,379), OK (113,379), Cancel (197,379), Apply (281,379) `com_button`. | `hud/options.ts` (settings rows unchanged) |
| **System (Esc)** | `mframe` 214×245 | Inner `int_window_` (17,45,180,185) + `com_bg_tile_b`. `sys_button` rows 152×24 at x 31, y 58/92/125/159/192: the `menuItems()` of `hud/menu-items.ts` in order (today Options, Key help, Sound, Character select, Log out; "Back to game" (`resume`, order 90) becomes the close button). More than five rows grow the window by 33 px each [decision]. | `screens/world.ts openMenu` (line 809) |
| **Message boxes** | `msgbox2_window_` | Body tile `com_bg_tile_b` (16,40,284,122) (so about 300 wide) [confirmed]; the box sizes are set by code [unknown]: simple 300×140, count 300×180. Simple: text row (0,52,240,14), Yes (72,99) / No (152,99). Count (`MsgBoxDivideCount`): item frame `msgbox_itemwindow` 48×48 at (18,44) with the icon at (25,51), name board `msgbox_iteminfo_3` (73,44,212,48), "Current" (34,106) + amount (105,106), "Divide" label `#EFDAA4` (153,106), the amount field `messagebox/msgbox_quantity` 42×24 at (223,102), OK (71,143) / Cancel (151,143) [confirmed, fact-check: the draft's `frame_msg_` field belongs to `MsgBoxInsertMsg`, the text prompt: `frame_msg_` (9,66,400,28) + `com_bg_tile_e`]. Rebirth: `messagebox/msgbox_rebirth` + `msgbox_rebirth_button`. Party invite: the simple box plus a 30-s gauge `com_casting_gauge_skill` [unknown]. | `ui/chrome.ts dialog`, `hud/index.ts askCount`, `hud/death.ts`, `hud/party-invite.ts` |
| **World map** | `mframe` 652×424 | Buttons `wmap_button_world` (590,10,16,16), `wmap_button_windowsize` (608,10,16,16), "Auto move" `com_mid_button` drawn at 96×28 (543,43) hidden. | `world/map/worldmap.ts` |
| **Key help** | `mframe` 340×420 | `sframe_wnd_` sections per group; rows label/value. | `hud/keyhelp.ts` |
| **Sound** | `mframe` 300×260 | Sliders `opt_volume2_*`. | `hud/sound-settings.ts` (sound lane) |
| **GM window** | `mframe` any size (resizable) | Tabs `com_new_tab_*` (3-slice, any width, live text), two rows; lists `com_bar01_`; inputs `frame_msg_` + `com_bg_tile_e`. The `outer/unity_window` look goes away. | `gm/window.ts`, `gm/editors/*` |

### 4.7 Outer screens

The outer screens keep their retail resinfo layouts (`pstitle`, `pscharacterselect`, `pscharactercreatechina`). The changes:

1. **Scale.** Use the §4.1 steps. The login window draws at 100% on 1024×768.
2. **Login.**
   - All three fields are the same width (the register "Confirm" field today is narrower).
   - The mode hint "Create a new account" becomes a caption inside the window (`--t-caption`), not a floating bar.
   - Buttons use `outer/button` with live text and fit (§4.3).
3. **Server list.** Unchanged art. Rows get `com_bar01select_*` highlight on the selected server.
4. **Character create.**
   - The sex buttons (`outer/man_*`, `woman_*`) show only the art, with the live label **beside** them, so "Female" never clips.
   - Slider value dots use `outer/slider*`.
   - The description card uses `frame/frame_tooltip_`.
5. **Character select.** The info box uses the retail `outer/explain-window`. HP/MP bars use `outer/hp`/`mp`.
6. **Loading.** Unchanged; the tip uses `--t-body`.
7. **Corner mute button.** It moves to the bottom-right of the outer screens' black bar. In the world it goes to the MENU popup and Options (the sound lane agrees; its API is unchanged).

### 4.8 Tooltips

`kit/Tooltip` uses the frame `frame/frame_tooltip_` (8×8 pieces) with a body of `rgba(0,0,0,0.82)` [unknown]. Padding is 8 px, max width 260 px. It shows 250 ms after hover and hides at once. Placement is below-right of the cursor (+16,+16), flips at the screen edges, and never covers the hovered slot.

**Item tooltip layout.** This is a view of today's `ItemCatalog.tooltip()` lines, with `cls` mapped to sections:

```
[Name]                         --t-title; colour by class: normal #FFFFFF, +N #FFD953 "(+N)" suffix,
                               magic/blue options #50CEFA, rare (SoX) #FFD953 with com_itemsign_rare  [unknown colours]
[Type · Slot · 3rd degree]     --t-label
───────────── (com_grayline 256×4, scaled to width)
[Phy. atk. 21 ~ 23]            --t-value  (stat lines)
[Durability 38 / 40]           --t-value; ≤ 25% → --c-warn; 0 → --c-bad and "Broken"
[Blue options]                 #50CEFA (alchemy lane adds lines with cls 'magic')
─────────────
[Required level 12]            --t-label; unmet → --c-bad
[Male only] [Chinese]          --t-label; unmet → --c-bad
─────────────
[Sell price 1,234 gold]        --c-level
[Right click: equip]           --t-small #B0B0B0 (hint)
```

- `TooltipLine.cls` gains `'magic' | 'sep' | 'price' | 'warn'`. This is additive; old classes map as before.
- **Skill tooltip:** name + level, then type (active/passive art `skill/skl_text_{active,passive}`), MP cost, cooldown, cast range, description, requirements, and "Next level" in `--c-mastery`.
- **Simple tooltips** (buttons, gauges): one or two lines, no separators.

### 4.9 Slots and drag and drop

`kit/Slot` (36×36 cell, 32×32 icon at +2,+2). States:

| State | Visual | Tag |
|---|---|---|
| Empty | Lattice cell art (from the lattice background) | [confirmed] |
| Hover | `com_item_select` 32×32 over the icon | [confirmed art] |
| Pressed / picked up | Icon at 40% opacity in the slot; a 32×32 ghost follows the cursor (offset −16,−16), opacity 0.85 | [unknown] |
| Valid drop target under the ghost | `com_item_select` + a 1-px `#FFD953` inner line | [unknown] |
| Invalid target | The ghost gets `icon/icon_disable` over it | [likely] |
| Blocked (cannot use) | Red wash `com_red_tile` at 45% over the icon (UX W3's `blocked`) | [likely] |
| Cooldown | Clockwise dark sweep (today's) + remaining seconds `--t-small` | [confirmed today] |
| Stack count | `item_number_{0-9}` digits right-aligned at the bottom-right (+1 px inset); falls back to `--t-small` text | [confirmed art] |
| +N / magic / rare | `com_itemsign_plus` / `_magic` / `_rare` 12×12 at the top-left | [confirmed art] |
| Broken / low durability | `icon/icon_item_broken` / `icon_item_warning` overlay | [confirmed art] |
| New item (UX W5) | Soft pulse of `com_item_select` until hovered | [unknown] |

Drop on the world (outside every window): the cursor shows the drop hint and a count dialog opens (today's). Drag from a skill row or a bag slot to the underbar: the target cells highlight while dragging.

### 4.10 Damage numbers, cursors, sounds

- **Damage numbers are owned by the effects lane, not by this spec** (fact-check): docs/EFFECTS.md lane FX-C3 owns the new `hud/hitcount.ts` (sprite digits) and the `Floaters` switch in `hud/effects.ts` (same `add(at, amount, kind)` API), with its own digit-colour mapping (docs/EFFECTS.md §3: `hitcount_enemy_*` = damage dealt to you [likely]). This spec only exports the art (`interface/hitcount/*`, UI-X) and asks for:
  - digits at 50% (18×30 per digit) [unknown];
  - the option "Damage numbers" (today) stays;
  - the floaters stay outside the zoomed layer (§3.2).
- **Cursors** (`kit/cursor.ts`):
  - normal = `cursor_normal1` (exported to `ui/cursor/normal.png`), hotspot (2,2) [likely];
  - attack, talk and pick-up have no retail source (§2.8). We build them from the same hand PNG plus a small overlay drawn from retail icons: attack `targetwindow/tw_icon_normal` (16×16) at (16,16); talk `chattingwnd/chat_command_button`'s glyph [unknown]; pick-up `ifcommon/com_moneybutton` [unknown];
  - set by `document.body.dataset.cursor` from `setHovered(v)` in `screens/world.ts` (line 419; it already toggles the canvas class `hover-target`), by entity kind (monster → attack, NPC → talk, ground item → pick-up);
  - the repair lane's hammer cursor (docs/SYSTEMS_COMBAT.md §3.4, `hud/repair.ts`) is one more kind, `setCursor('repair')`; there is no retail hammer cursor either, so it reuses the hand plus an overlay [unknown];
  - `cursor: url(...) 2 2, auto`, at 1× only, because browsers do not scale CSS cursors with zoom.
- **Sounds.** Kit buttons, tabs and checkboxes call `gameAudio()?.ui('ui.click')`. Windows play open and close sounds (today's `HudWindow` does). `data-sfx="none"` opts out. The sound lane owns the ids.

### 4.11 Keyboard and focus

- Every kit control is a real `<button>`, `<input>` or `role`'d element, with a visible focus ring: 1-px `#FFD953` outline inside the art.
- Tab order is per window. Enter triggers the primary button; Esc closes the window.
- Game keys stay off while an input has focus (today's `isTypingTarget`).

---

## 5. The component kit (`apps/game/src/ui/kit/**`)

### 5.1 Files

| File | Exports | Notes |
|---|---|---|
| `kit/index.ts` | re-exports | The only import path lanes use: `import { Window, Button } from '../ui/kit/index.ts'` |
| `kit/tokens.ts` | `ensureKitStyles()`, `TOKENS` | The one injected stylesheet `#kit-styles`: tokens (§4.3/4.4) and component CSS |
| `kit/scale.ts` | `UI_STEPS`, `autoScale`, `uiScale`, `artRendering` | Pure (tested) |
| `kit/skins.ts` | `SKINS` (§5.2), `skin(art, name)` | Maps component skins to art keys and slice insets |
| `kit/nine.ts` | `nineSlice(el, art, frameKey)`, `nineSliceGeometry(pieces)` | Uses the exported `.9.png` + `border-image`; falls back to 8 pieces (today's `ui/frame.ts`) when only pieces exist |
| `kit/frame.ts` | `Frame` | Any family, any size |
| `kit/window.ts` | `Window` (supersedes `hud/window.ts HudWindow`) | Title strip, close, drag, remembered position, cascade, z-order, Esc |
| `kit/main-window.ts` | `MainWindow`, `MainTab` | §4.6; pages registered by id |
| `kit/section.ts` | `Section` | `sframe_wnd_` sub-panel with a blue caption strip |
| `kit/button.ts` | `Button` | Skins: `std`, `mid`, `small`, `system`, `red`, `green`, `icon`; states from art; auto-fit width |
| `kit/tabs.ts` | `TabBar`, `Tab` | Skins: `tab`, `long`, `short`, `sub`, `flex` (3-slice `com_new_tab_*`), `icon` (e.g. `skl_*_tab`) |
| `kit/gauge.ts` | `Gauge` | Art fill clipped by value (`pmi_hp`, `tw_hp`, `pt_hp`, `ub_new_sp_bar`, casting), optional text, segmented mode (EXP band) |
| `kit/slot.ts` | `Slot`, `SlotGrid` | Supersedes the view part of `hud/slots.ts SlotView` (same public API: `set`, `setCooldown`, `setBlocked`…) |
| `kit/tooltip.ts` | `Tooltip` (re-exports `TooltipLine` from `hud/items.ts`, where it lives today) | §4.8; one shared instance per HUD; supersedes `hud/slots.ts Tooltip` |
| `kit/list.ts` | `List<T>` | Rows on `com_bar01_`; selected row `com_bar01select_`; virtualised over 200 rows |
| `kit/scroll.ts` | `ScrollArea` | Native overflow scrolling, hidden native scrollbar, retail bar (arrows, `com_scroll_bar` track, `com_scroll_button` thumb) driven from `scrollTop` |
| `kit/input.ts` | `TextInput`, `NumberInput` | `frame_msg_` frame + `com_bg_tile_e` body; `NumberInput` has the spin arrows |
| `kit/check.ts` | `Checkbox`, `Radio`, `RadioGroup` | `com_checkbutton_*`, `com_radiobutton_*`; label to the right |
| `kit/slider.ts` | `Slider` | `ifsliderctrl.txt` layout |
| `kit/select.ts` | `Select` | A button showing the value and a popup `List` [unknown look: `chat_command_button`'s drop arrow] |
| `kit/icon.ts` | `Icon` | Item and skill icons from the icon index (today's `ItemCatalog` icons) |
| `kit/label.ts` | `Label`, `Value`, `Row` | Text styles by token |
| `kit/dialog.ts` | `MessageBox.confirm/count/prompt/info` | `msgbox2_window_`; supersedes `ui/chrome.ts dialog` in game (outer screens may keep theirs) |
| `kit/notice.ts` | `Notice` | `com_notice_*` framed top-centre banner; `ui/notice.ts NoticeBanner` (exists today) becomes a thin wrapper of it |
| `kit/cursor.ts` | `setCursor(kind)` | §4.10 |

### 5.2 Skins (exact art)

```ts
// kit/skins.ts: keys are art-manifest keys (paths under Media/interface without extension)
export const FRAMES = {
  main:    { prefix: 'frame/mframe_wnd_',                   fill: 'ifcommon/bg_tile/com_bg_tile_a', title: 36, inset: [44, 16, 16, 16] },
  section: { prefix: 'frame/sframe_wnd_',                   fill: 'ifcommon/bg_tile/com_bg_tile_b', title: 22, inset: [30, 10, 10, 10] },
  inner:   { prefix: 'inventory/int_window_',               fill: 'ifcommon/bg_tile/com_bg_tile_d', inset: [10, 10, 10, 10] },
  panel:   { prefix: 'equipment/equip_window_',             fill: 'ifcommon/bg_tile/com_bg_tile_d', inset: [12, 12, 12, 12] },
  grey:    { prefix: 'frame/frameg01_wnd_',                 inset: [14, 14, 14, 14] },
  dialog:  { prefix: 'messagebox/msgbox2_window_',          fill: 'ifcommon/bg_tile/com_bg_tile_b', title: 30, inset: [40, 16, 16, 16] },
  talk:    { prefix: 'npc/npc_conversation_window_',        fill: 'ifcommon/bg_tile/com_bg_tile_d', inset: [20, 20, 20, 20] },
  tooltip: { prefix: 'frame/frame_tooltip_',                inset: [8, 8, 8, 8] },
  field:   { prefix: 'frame/frame_msg_',                    fill: 'ifcommon/bg_tile/com_bg_tile_e', inset: [4, 4, 4, 4] },
  black:   { prefix: 'ifcommon/com_blacksquare_',           fill: 'ifcommon/bg_tile/com_bg_tile_e', inset: [4, 4, 4, 4] },
  lattice: { prefix: 'ifcommon/lattice_window/com_lattice_outline_', inset: [3, 3, 3, 3] },
  menu:    { prefix: 'frame/ub_new_wnd_',                   inset: [8, 8, 8, 8] },
} as const
export const BUTTONS = {
  std:    { key: 'ifcommon/com_button',       w: 76,  h: 24, slice: 6 },
  mid:    { key: 'ifcommon/com_mid_button',   w: 88,  h: 24, slice: 6 },
  small:  { key: 'ifcommon/com_m_button',     w: 52,  h: 20, slice: 5 },
  tiny:   { key: 'ifcommon/com_s_button',     w: 44,  h: 20, slice: 5 },
  system: { key: 'system/sys_button',         w: 152, h: 24, slice: 6 },
  red:    { key: 'ifcommon/com_red_button',   w: 56,  h: 24, slice: 6 },
  green:  { key: 'ifcommon/com_green_button', w: 56,  h: 24, slice: 6 },
} as const // states: key, `${key}_focus`, `${key}_press`, `${key}_disable`
export const TABS = {
  tab:   { on: 'ifcommon/com_tab_on',       off: 'ifcommon/com_tab_off',       w: 60, h: 24 },
  long:  { on: 'ifcommon/com_long_tab_on',  off: 'ifcommon/com_long_tab_off',  w: 72, h: 24 },
  short: { on: 'ifcommon/com_short_tab_on', off: 'ifcommon/com_short_tab_off', w: 56, h: 24 },
  sub:   { on: 'ifcommon/com_sub_tab02_on', off: 'ifcommon/com_sub_tab02_off', w: 68, h: 28 },
  flex:  { on: 'ifcommon/com_new_tab_on_',  off: 'ifcommon/com_new_tab_off_',  h: 24, caps: 12 }, // left/mid/right
  chat:  { on: 'chattingwnd/chat_tab',      off: 'chattingwnd/chat_tab',       w: 52, h: 20 },
} as const
export const GAUGES = {
  hp: 'playerminiinfo/pmi_hp', mp: 'playerminiinfo/pmi_mp', targetHp: 'targetwindow/tw_hp', npcHp: 'targetwindow/tw_hp_npc',
  partyHp: 'party/pt_hp', partyMp: 'party/pt_mp', quickHp: 'quickparty/qpt_hp', quickMp: 'quickparty/qpt_mp',
  exp: 'underbar/ub_new_exp_bar', spExp: 'underbar/ub_new_sp_bar', cast: 'ifcommon/com_casting_gauge_skill',
  buffTime: 'icon/stateodd/s_stateodd_time_gauge', petHp: 'playerminiinfo/pmi_pet_hp', petHgp: 'playerminiinfo/pmi_pet_hgp',
} as const
```

- **Button slices.** `slice` is the `border-image-slice` in px for stretching a fixed-size button: corners and rivets keep their size, the middle stretches. The slice values are [likely] (rivets are about 4–5 px in); the kit lane checks them by eye at 3×.
- **Gauges** draw the fill art at native size, clipped with `clip-path: inset(0 X 0 0)` where X = (1−value)·100%. The fill is never stretched.

### 5.3 Component contracts (TypeScript)

```ts
export interface WindowOptions {
  id: string                    // remembered position key sro.hud.<id>
  title: string                 // live text (i18n)
  width: number; height: number // native px
  frame?: keyof typeof FRAMES   // default 'main'
  at?: [number, number]         // default: cascade
  closable?: boolean            // default true
  resizable?: { minW: number; minH: number } // GM window
}
export class Window {
  readonly root: HTMLElement; readonly body: HTMLElement
  constructor(art: Art, parent: HTMLElement, opts: WindowOptions)
  open(): void; close(): void; toggle(): void; readonly isOpen: boolean; raise(): void; readonly z: number
  setTitle(text: string): void
  onOpen?(): void; onClose: (() => void) | null
  dispose(): void
}
export interface ButtonOptions { label: string; skin?: keyof typeof BUTTONS; minWidth?: number; primary?: boolean; disabled?: boolean; title?: string; sfx?: string | 'none' }
export function button(art: Art, opts: ButtonOptions, onClick: () => void): HTMLButtonElement & { setDisabled(v: boolean): void; setLabel(s: string): void }
export class TabBar<Id extends string> { constructor(art: Art, skin: keyof typeof TABS, tabs: { id: Id; label?: string; icon?: string; title?: string }[]); readonly root: HTMLElement; value: Id; onChange: (id: Id) => void; setHidden(id: Id, hidden: boolean): void }
export class Gauge { constructor(art: Art, fill: string, opts?: { w?: number; h?: number; text?: 'none' | 'value' | 'percent'; segments?: { n: number; pitch: number; x0: number } }); set(value: number, max: number): void; readonly root: HTMLElement }
export class Slot { /* view only; today's SlotView API kept */ set(stack: ItemStack | null, blocked?: boolean): void; setCooldown(readyAt: number, totalMs: number): void; setSigns(s: { plus?: number; magic?: boolean; rare?: boolean; durability?: 'ok' | 'low' | 'broken' }): void; readonly root: HTMLElement }
export class Tooltip { show(lines: TooltipLine[], x: number, y: number): void; move(x: number, y: number): void; hide(): void }
export const MessageBox: {
  confirm(o: { title?: string; text: string; ok?: string; cancel?: string }): Promise<boolean>
  count(o: { title?: string; text: string; max: number; initial?: number }): Promise<number | null>
  prompt(o: { title?: string; text: string; maxLength: number; initial?: string }): Promise<string | null>
}
```

**Behaviour rules** (all [unknown] choices unless retail):

- A button measures its label with a shared `CanvasRenderingContext2D.measureText` in the button font. Width = max(skin.w, text + 16).
- Tabs never shrink below skin width; the `flex` skin fits any label.
- A disabled control uses the `_disable` art, gets `aria-disabled="true"`, and eats clicks.
- Every kit element gets `pointer-events: auto`, and pointer events inside kit windows never reach the world (today's rule).

### 5.4 Asset export (what the kit needs)

`packages/convert/src/tools/export-ui.ts` grows:

1. **SELECTION additions** (folder → include regex):
   - `interface/frame`: `/^(mframe_wnd|sframe_wnd|frameg01_wnd|frameg_wnd|frame_tooltip|frame_msg|frame_sub|ub_new_wnd)_/`
   - `interface/messagebox`: `/^(msgbox2_window_|msgbox_window_|msgbox_rebirth|msgbox_quantity)/`
   - `interface/npc`: `/\.ddj$/`
   - `interface/equipment`: `/\.ddj$/`
   - `interface/inventory`: `/\.ddj$/`
   - `interface/ifcommon`: `/^com_(tab|tab2|long_tab|short_tab|sub_tab0\d|new_tab)_|^com_(checkbutton|radiobutton|plus|minus|moneybutton|item_select|itemsign|grayline|diamond|pt_leader|casting_|red_button|green_button|blu_button|left_bigarrow|right_bigarrow|re_|kindred_china|job_|redeem_window|red_tile|green_tile)/`
   - the stray duplicates in `interface/ifcommon/ifcommon/` need no rule: `Pk2Archive.list(folder)` is non-recursive by default (`packages/formats/src/pk2.ts:202`) [confirmed]
   - `interface/underbar`: `/^ub_(new_|up_arrow|down_arrow|slot_arrow)/`
   - `interface/mainpopup`: `/\.ddj$/`
   - `interface/minimap`: `/\.ddj$/`
   - `interface/playerminiinfo`: `/\.ddj$/`
   - `interface/targetwindow`: `/\.ddj$/`
   - `interface/party`: `/\.ddj$/`
   - `interface/quickparty`: `/\.ddj$/`
   - `interface/skill`: `/^skl_/`
   - `interface/quest`: `/^qst_/`
   - `interface/store`: `/\.ddj$/`
   - `interface/stall`: `/\.ddj$/`
   - `interface/exchange`: `/^(exc_|ch_line)/`
   - `interface/alchemy`: `/^alcm_(window|button|tab|slot|lamp|menu|effect_(prepare|success|fail_1|stuff)|windowclose)/`, **exclude `/\s/`** (fact-check: `alcm_window_ processing .ddj` and `alcm_window_quick mastery.ddj` have spaces in their names; `export-icons.ts` excludes `\s` for the world map for the same reason). If the new reinforce panel `alcm_window_quick mastery` is wanted, export it under a derived key without the space.
   - `interface/guild`: `/^gil_/`
   - `interface/option`: `/^opt_/`
   - `interface/hitcount`: `/\.ddj$/`
   - `interface/item_number`: `/\.ddj$/`
   - `interface/durabilityerror`: `/\.ddj$/`
   - `interface/animal`: `/^am_/`
   - `interface/chattingwnd`: the whole folder
   - `interface/guide`: `/^gd_paper/`
   - `icon` (this is `Media/icon/`, not under `interface/`; the key keeps the `icon/` prefix because `exportImage` only strips `interface/`): `/^(icon_disable|icon_item_broken|icon_item_warning|icon_item_select)\.ddj$/`, and folder `icon/stateodd`: `/^s_stateodd_time(0[12])?_gauge\.ddj$/` [confirmed files]
   - `effect` (for docs/EFFECTS.md, which asks the owner of `export-ui.ts` to add it): `/^select_0[1-4]\.ddj$/` → `ui/effect/select_0N.png`

   Europe and Islam variants stay excluded (`/eu_|europe|islam/`). Rough cost: 1,400 PNGs, about 12 MB before `optimize-out` [likely].
2. **Nine-slice sheets.** For every `FRAMES` prefix, write `ui/<prefix>9.png` (for example `ui/frame/mframe_wnd_9.png`). Layout:
   - Columns = [max(lu,ls,ld).w | M | max(ru,rs,rd).w], where M = lcm(mu.w, md.w) capped at 256 (tiles repeated to fill).
   - Rows = [top | S | bottom], where S = lcm(ls.h, rs.h) capped at 256.
   - Record the slice insets in the manifest: `images[key9] = { …, nine: { top, right, bottom, left } }`, a new optional field on `UiImage`.
   - The optional body fill is **not** baked in; the kit draws it with `border-image` `fill` off and a separate background.
3. **Atlas crops.** For every row of §2.7 with an export key, write the crop as an image with `derived: { from: 'ifcommon/window_all', note: 'atlas x,y,w,h' }`.
4. **Fonts.** Run `font-subset.ts` on basic and chat (§4.3). `english.ttf` is copied as today.
5. **Cursor.** Write `Media/cursor/cursor_normal1.tga` as `ui/cursor/normal.png` (TGA type 2, 32-bit; origin by descriptor bit 5; **our file has bit 5 clear, so rows are bottom-up and must be flipped**; fact-check) and `images['cursor/normal']`.
6. **Baked-text audit.** New images are textless except `underbar/ub_new_menu*`, `ub_new_mainbar2`, `ub_new_mainbar3`, `skill/skl_button_add*`, `skl_button_up*`, `skl_levelup`, `skl_mastery_levelup` (English). They are **not** put in `BAKED_TEXT` (that would make `Art.has()` return false: `has(key)` is `images[key] && !bakedText[key]`, `ui/art.ts:77`). Instead the manifest gains an additive `englishText?: Record<string, string>` (key → the English text), for the audit and the i18n test; `has()` is unchanged (fact-check: the draft's `bakedText` `lang: 'en'` does not fit, because `bakedText` is `Record<string, string>`).

---

## 6. What each current file becomes

| Today | Becomes | Kept |
|---|---|---|
| `hud/window.ts HudWindow` | Thin subclass or alias of `kit/window.ts Window` (same constructor shape, `frame` string → skin name map) | `open/close/toggle/isOpen/z/raise/onOpen/onClose`, `sro.hud.<id>` positions |
| `ui/frame.ts` | Used only as the 8-piece fallback inside `kit/nine.ts` | — |
| `ui/art.ts` | + `UiImage.nine`, + `UiManifest.englishText`, + `hasAny()` | Every current method; `has()` unchanged |
| `ui/chrome.ts` | Outer screens only (bars, caption, anchor, dialog); in game `kit/dialog.ts` | — |
| `ui/fonts.ts` | Unchanged API; the exported fonts load now | — |
| `hud/player.ts PlayerFrame, ExpBar` | PlayerFrame on the atlas `wa_pmi`, exposing two mount points for other lanes: `berserkHost` (the orbs, button and glows at the §2.5 rects, filled by `hud/berserk.ts` of docs/SYSTEMS_COMBAT.md §5.3) and `petHost` at (53,55,154,40) (filled by `hud/mount-frame.ts`, SYSTEMS_COMBAT lane MR-C); ExpBar logic → `hud/underbar.ts` | `expPercent`, `spExpFraction`, `spExpTooltip`, `spGained`, `spGainedText`, `portraitKey`, `lowHp` |
| `hud/hotbar.ts` | View → `hud/underbar.ts`. The `Hotbar` is constructed in `world/features/skills.ts:135` (not in `createHud`), so it mounts into a slot host that the underbar exposes (`hud.underbar.slots`) | `hotbar-model.ts`, key handling, `IconDrag`, cooldown code |
| `hud/menubar.ts` | Registry kept; view → the underbar right panel + MENU popup | `MenuBar.register` / `MenuBarEntry` API (+ optional `icon`) |
| `hud/menu-items.ts` | Unchanged; the System window renders `menuItems()` | `registerMenuItem` / `MenuItem` / `MenuContext` |
| `hud/target.ts` | 2009 atlas windows (`wa_tw_enemy/special/player`) | `TargetInfo`, `setActions` and the `addTargetAction` registry that docs/SYSTEMS_SOCIAL.md §9.1 adds (Invite / Exchange / Guild invite → kit buttons **inside** the window's right side), effects |
| `hud/buffs.ts` | Positions from `GDR_MAGICSTATEBOARD`, gauge art | Logic |
| `hud/party.ts` `PartyFrame` (the quick frames; there is no `PartyFrames` class) | Atlas `wa_party_slot` + `qpt_*` art at (4,137); `PartyWindow` → Main window Party tab | Logic, menus (`PartyBook`, `partyRows`, `memberMenu`, `PartyMenu`) |
| `hud/inventory.ts` + `hud/character.ts` | Main window Inventory tab (bag + equipment) and Character tab (stats) | Slots, drag, split, statUp |
| `hud/skills.ts` | Main window Skill tab | Rows, locking, drag |
| `quests/log.ts` | Main window Quest tab; `quests/tracker.ts` re-anchored | Logic |
| `hud/npc-dialog.ts`, `quests/dialog-panel.ts` | NPC window (mframe + talk frame) | Logic |
| `hud/shop.ts`, `hud/storage.ts` | mframe windows per §4.6 | Logic |
| `hud/options.ts`, `hud/keyhelp.ts`, `hud/sound-settings.ts` | Kit windows and controls | Settings rows, bindings |
| `world/chat.ts` | Retail chat box (`chat_window` pieces, `chat_tab`, lamps, `wa_chat_input`, retail scroll) | Kinds, prefixes, history, whisper |
| `world/jangan/minimap.ts` | Area name and X/Y inside the plate; buttons at retail rects | Tiles, dots, zoom |
| `world/map/worldmap.ts` | mframe 652×424 | Logic |
| `gm/window.ts`, `gm/editors/*` | Kit window (resizable) + flex tabs + list + inputs | Commands, editors |
| `hud/effects.ts` | **Not this spec**: docs/EFFECTS.md FX-C3 swaps `Floaters` to `hud/hitcount.ts` sprites. `LevelUpBanner` / `HudMessages` (same file) only get token colours, through CSS in the kit sheet | Floater timing |
| `hud/item-cast.ts` + the `.npc-cast` CSS in `hud/npc-ui.ts:64–73` | Casting bar on `com_casting_window` + `com_casting_gauge_*` at the §4.2 anchor | `ItemCastBar` API (`start`, `update`, `end`, `reset`) |
| `screens/world.ts openMenu` | System window (`sys_button` rows from `menuItems()`) | Actions |
| `style.css`, `*-style.ts` | In-game rules move into `kit/tokens.ts` and one stylesheet per lane's component; `style.css` keeps base, outer screens and fallbacks | — |

---

## 7. Migration plan (window by window)

The order puts user-visible wins first. Each step keeps every test green.

1. **Kit + export** (lanes UI-X, UI-K). Nothing visible changes yet, except:
   - the fonts now load;
   - the scale steps are on, so UI is 100% at 1024×768 (the biggest single improvement, A1).
2. **Window chrome.** `HudWindow` delegates to `kit/Window`. Every window at once gets the mframe title strip, close button and cascade (A4, A6). One file change plus the skin map.
3. **Underbar.** Quick slots + EXP + SP + menu in one bar (A5).
4. **Player frame, target, buffs, party frames, minimap text, casting bar.** The HUD top row (A8, A11).
5. **Chat.** Retail box and tabs (A10).
6. **Main window.**
   - Inventory + equipment + character + skill + party + quest become tabs (A7).
   - The keys keep working. `hud.toggleInventory()`, `toggleCharacter()` and the quest/party/skill toggles map to tabs.
   - Placeholder windows (`world/features/placeholder.ts`) register as tabs, or as menu rows for their future windows.
7. **NPC dialog, shop, storage, system menu, options, key help, sound, world map, message boxes.** Retail frames and kit controls (A3, A9, A13).
8. **Tooltips, slot states, drag visuals, damage digits, cursor** (A12, A17, A18).
9. **Outer screens** (A14; login, create and select fit fixes).
10. **GM window and editors** (last; only staff see them).

The new-system windows (trade, stall, alchemy, guild, stable, repair, berserk, horse frame) are built with the kit from the start by their own lanes, using the §4.6 layouts. They never go through the old `HudWindow` look.

---

## 8. Tests

All new tests are pure (node, vitest), matching the existing suite, which has no DOM environment.

| Test file | Checks |
|---|---|
| `apps/game/test/ui-kit.test.ts` | `autoScale` (the §4.1 table rows; never < 1 at ≥ 1024×700); `uiScale('auto' | step)`; `artRendering(1.5, 1) === 'auto'`, `artRendering(1, 2) === 'pixelated'`; `nineSliceGeometry` (mframe pieces → insets 68/40/48/40); the `SKINS` keys are well-formed. When `work/out/ui/index.json` exists, every `FRAMES/BUTTONS/TABS/GAUGES` key and its `_focus/_press` variants exist in it (skipped otherwise, like the corpus tests). |
| `apps/game/test/ui-layout.test.ts` | Pure layout functions: `hudAnchors(W, H)` returns the §4.2 rects; nothing overlaps at 1024×768, 1280×720, 1536×864 (1920 at 1.25) and 952×700; the chat never covers the underbar; the underbar slot rects are 36 apart; the EXP segment fills for 0, 5, 12.34, 99.99 and 100 %. |
| `apps/game/test/ui-text-fit.test.ts` | i18n budget: every string used as a fixed-width label fits its skin, at a conservative 6.6 px/char in the 12-px basic font. Examples: `com_button` 76 − 16 = 60 → ≤ 9 chars or it auto-grows, so the test asserts the auto-grow path is used; system rows (152 − 16) → ≤ 20 chars; tab labels (`com_long_tab` 72 − 16 = 56) → ≤ 8 chars. Tooltip line classes map to styles. The `englishText` images are the only art with text. |
| `apps/game/test/tooltip-model.test.ts` | `ItemCatalog.tooltip()` output unchanged for today's fixtures, plus the new `sep`/`price`/`magic` lines in the right order |
| `packages/convert/test/font-subset.test.ts` | The subsetter on a tiny synthetic TTF: table directory `searchRange`/`entrySelector`/`rangeShift` correct, checksums correct, `loca` monotonic, the cmap maps `A`..`z` and `é`, and no `fpgm`/`prep`/`cvt `. On the real `basic.ttf` when present: glyph count < 400 and every Latin-1 code point is mapped. |
| `packages/convert/test/export-ui-kit.test.ts` (new; there is no export-ui test today) | Nine-slice composition of a synthetic 8-piece frame (sizes, lcm tiling); atlas crop rect maths (UV → px, e.g. `0.72363,0.8847..0.9541,0.9550` → 741,453,236,36); the TGA decode of a 2×2 fixture in **both** origins (descriptor 0x08 bottom-up and 0x28 top-down) |
| Existing tests | `hud.test`, `skills.test`, `shop.test`, `storage.test`, `party.test`, `quests.test`, `ux-shell.test`, `ux-world.test`, `worldmap.test`, `gm.test`, `sp-hud.test` pass unchanged. Where a test imports a view class, the class keeps its name as an alias. |

---

## 9. Build plan

**Constraint.** Other lanes are editing the game right now: horses, monster skills, trade and stalls, durability and repair, alchemy, guilds, berserk, skill animation, drop effects. So:

- the kit and the export land first, as **new files only**;
- the feature lanes build their new windows on the kit;
- the migration lanes run after those feature lanes have merged their HUD hooks. Otherwise both edit `hud/index.ts` and `screens/world.ts`.

### 9.1 Lanes

**UI-X: export (first; one agent; ~0.5 day)**

- **Owns:**
  - `packages/convert/src/tools/export-ui.ts` (SELECTION incl. the `interface/hitcount` and `effect/select_0N` globs that docs/EFFECTS.md §5.4 asks the owner of this file for, nine-slice sheets, atlas crops, cursor, `englishText`);
  - new `packages/convert/src/tools/font-subset.ts`, `packages/convert/src/tga.ts` (no TGA reader exists in `packages/formats` or `packages/convert` today [confirmed]);
  - tests `packages/convert/test/font-subset.test.ts` and `packages/convert/test/export-ui-kit.test.ts`.
- **Hooks:**
  - `packages/convert/src/tools/export-icons.ts HUD_SELECTION`: no change; its keys stay, and `index.json` wins on collisions (`mergeManifests`, `ui/art.ts:40`) [confirmed].
  - `packages/convert/src/optimize/run.ts`: probably no change: it rewrites only `world/**.png` to WebP and copies other files as they are [likely, `run.ts:87,200–209`]; check that `work/out-opt/ui/**` and `fonts/**` appear after a run.
- **Run:**
  ```
  pnpm tsx packages/convert/src/tools/export-ui.ts --force
  pnpm tsx packages/convert/src/tools/optimize-out.ts run
  ```
  (`optimize-out.ts` needs the `run` subcommand; without it it prints usage.) Then deploy the assets with `pnpm run deploy -- --assets-only` (docs/DEPLOY.md; there is no `--no-restart` flag).
- **Done when:** `work/out/ui/index.json` has every §5.2 key; `frame/mframe_wnd_9.png` looks right at 3× (checked by eye with the Read tool); Chrome loads `basic.ttf`/`chat.ttf` (the page has no `fonts-fallback` class).

**UI-K: kit (first, parallel with UI-X; one agent; ~1 day)**

- **Owns:** `apps/game/src/ui/kit/**` (all §5.1 files), new `apps/game/src/i18n/en-ui.ts` (the kit's and the rework's strings: scale options, "Separate windows", MENU rows…), `apps/game/test/ui-kit.test.ts`, `apps/game/test/ui-text-fit.test.ts`.
- **Hooks (small, exact):**
  - `apps/game/src/ui/art.ts`: add `nine?: {top,right,bottom,left}` to `UiImage` and `englishText?: Record<string, string>` to `UiManifest` (additive; `has()` unchanged; the `hud.test` `mergeManifests` test still passes; `mergeManifests` merges `englishText` like `bakedText`).
  - `apps/game/src/app.ts updateScale()` (lines 94–97): body → `uiScale(settings.get().ui.scaleMode ?? 'auto', innerWidth, innerHeight)`; set `--ui` and `--art-rendering`; call `ensureKitStyles()` once in the constructor; the `settings.onChange` check at line 89 compares `ui.scaleMode`.
  - `apps/game/src/settings.ts`: add `ui.scaleMode: UiScaleMode` (default `'auto'`) to the type, `DEFAULTS` and the sanitiser (today `ui.scale` is parsed at line 115 with `UI_SCALE_MIN` 0.8 / `UI_SCALE_MAX` 1.4). `ui.scale` stays in the type, unused.
  - `apps/game/src/hud/options.ts`: the `ui.scale` row (line 140) becomes a select row for `ui.scaleMode`, and the `ALWAYS` set (line 205) names `ui.scaleMode`.
  - `apps/game/src/hud/window.ts`: `HudWindow` becomes a subclass of `kit/Window`. The constructor maps `frame: 'inventory/int_window_' | 'frame/frameg01_wnd_'` → skin `'main'`, so every window gets the mframe chrome in one change (migration step 2). The `.hud-window-body` class is kept so the lanes' CSS still applies. `load()`/`applyPosition()` switch from "× --ui" to native px inside the zoomed layer.
  - `apps/game/src/params.ts`: `kit: boolean` from `?kit=1`; `apps/game/src/main.ts`: when `params.kit`, show `kit/gallery.ts` instead of the splash (3 lines; `main.ts` is also touched by docs/EFFECTS.md for its fx lab, so the integrator merges).
  - `apps/game/src/i18n/en.ts`: one import + spread line for `enUi` (as for `enSkills`, `enShops`…).
  - The in-game layer gets `zoom: var(--ui)` (§3.2). This touches `hud/index.ts` (`.hud-root`) and `screens/world.ts` (a `.world-ui` wrapper around `chat.root`, `perf.root`, `help` and `minimap.root`; `.entity-labels` stays outside), and removes every `--ui` rule. The full list on 2026-09-28 (fact-check; the draft named `world/ux-world-style.ts`, which has none, and missed several): `style.css` (19 uses), `hud/menubar.ts:38`, `hud/npc-ui.ts:65`, `hud/party-invite.ts:48`, `hud/party.ts:269,271,491`, `hud/skills-style.ts:74,75,80,113,114`, `hud/ux-style.ts:11,190,193`, `quests/style.ts:76`, `world/features/map.ts:45`. `hud/effects.ts:70` (floaters) and `screens/charselect.ts:298` (outer, world-projected) keep their own scale. **Coordinate this one** (see the conflict note below): it is a mechanical search-and-replace of `scale(var(--ui))` and `calc(Npx * var(--ui))`.
- **Done when:**
  - the unit tests pass;
  - the kit gallery page `http://localhost:5180/?kit=1` renders every control in every state, at 1×, 1.25× and 2×. It is a dev-only screen registered from `main.ts` behind the `kit` param, in the kit's own file `kit/gallery.ts`.

**UI-H: HUD (after UI-K; one agent; ~1.5 days)**

- **Owns:**
  - new `hud/underbar.ts`, `hud/underbar-layout.ts`, `hud/hud-layout.ts` (the `hudAnchors(W,H)` of §4.2, which also gives the durability, pet-frame and berserk anchors to the combat lanes);
  - `hud/player.ts` (incl. the `berserkHost` / `petHost` mount points), `hud/target.ts`, `hud/buffs.ts`, `hud/menubar.ts` (view), `hud/hotbar.ts` (view parts), `hud/perf-overlay.ts` (position);
  - `world/chat.ts`, `world/ux-world-style.ts`, `world/jangan/minimap.ts`;
  - the `PartyFrame` class in `hud/party.ts` (fact-check: the draft called it `PartyFrames`), `quests/tracker.ts` (position only);
  - `apps/game/test/ui-layout.test.ts`.
  - **Not** `hud/effects.ts` / `hud/hitcount.ts`: docs/EFFECTS.md FX-C3 owns the damage numbers (fact-check: the draft gave `hud/effects.ts` to UI-H).
- **Hooks:**
  - `hud/index.ts createHud()` (line 137 ff.): construct `Underbar` instead of `ExpBar` (line 159) and place the pieces from `hudAnchors`; expose `hud.underbar`.
  - `world/features/skills.ts:135` (`new Hotbar({…})`): pass `hud.underbar.slots` as the parent (one line; the file is also on docs/EFFECTS.md's list, so the integrator merges).
  - `world/features/quests.ts:416` (`tracker.setTop(…)`): the top comes from `hudAnchors` (one line).
  - `screens/world.ts setHovered` (line 419): calls `setCursor(kindOf(v))`.
  - The casting bar: the `.npc-cast` CSS block in `hud/npc-ui.ts:64–73` (the rest of `npc-ui.ts` is UI-W's) and, if needed, the markup in `hud/item-cast.ts` (the SHOPS-wave file, now idle).
  - `hud/ux-style.ts` lines 8–22 and 188–195 (perf overlay and the small-screen chat rule) are UI-H's; the rest of the file is UI-W's.
- **Done when:** the layout test passes; screenshots at 1024×768, 1280×720 and 1920×1080 match §4.2 (the user checks below).

**UI-W: windows (after UI-K; can run parallel with UI-H; one agent; ~2 days)**

- **Owns:**
  - new `hud/main-window.ts`;
  - `hud/inventory.ts`, `hud/character.ts`, `hud/skills.ts`, `hud/skills-style.ts`, `hud/slots.ts` (view parts → kit `Slot`, `Tooltip`);
  - `hud/npc-dialog.ts`, `hud/npc-ui.ts` (all but the `.npc-cast` block), `hud/shop.ts` (incl. a footer host for the repair lane's buttons), `hud/storage.ts`, `hud/options.ts` (rest; an additive row-registration API is welcome, docs/SYSTEMS_SOCIAL.md §5.7 asks for one), `hud/keyhelp.ts`, `hud/ux-style.ts` (all but the UI-H lines), `hud/ux-shell.ts` (it registers the Character/Inventory menubar entries and wires `inventory`/`character` windows: the tab mapping lands here), `hud/death.ts`, `hud/party-invite.ts`;
  - the `PartyWindow` class in `hud/party.ts`; `quests/log.ts`, `quests/dialog-panel.ts`, `quests/style.ts`;
  - `world/map/worldmap.ts`, `world/features/placeholder.ts`;
  - `apps/game/test/tooltip-model.test.ts`.
- **Hooks:**
  - `hud/index.ts`: the `toggleInventory`/`toggleCharacter`/`openInventory` bodies (lines 492–503) → `mainWindow.show(tab)`, plus the `askCount` (line 192) → `MessageBox.count`.
  - `hud/items.ts`: `TooltipLine.cls` (line 16, today `'title' | 'title-plus' | 'type' | 'stat' | 'req' | 'bad' | 'hint' | 'desc'`) gains `'magic' | 'sep' | 'price' | 'warn'` (additive; the durability lines of docs/SYSTEMS_COMBAT.md §3.4 land in the same function first).
  - `hud/slots.ts`: the view moves to kit `Slot` **after** the combat lane's `SlotDecorator` seam lands there (SYSTEMS_COMBAT §3.4: "the UI rework owns slot markup"); the kit `Slot.setSigns({durability})` is the decorator's target.
  - `screens/world.ts openMenu` (line 809) → the System window.
  - `hud/sound-settings.ts` belongs to the sound lane: UI-W only swaps its base class and controls, in one small commit, and tells the sound lane.
- **Done when:** every window in §4.6 marked "from today" is migrated, the old tests pass, and the user checks below pass.

**UI-O: outer screens (after UI-K; small; ~0.5 day)**

- **Owns:** `screens/login.ts`, `screens/servers.ts`, `screens/charselect.ts`, `screens/charcreate.ts`, `screens/loading.ts`, and the outer-screen sections of `style.css`.
- **Hooks:** `main.ts` corner block (mute position only; the sound lane agrees).
- **Done when:** A9 and A14 are gone and the login draws at 100% at 1024×768.

**UI-G: GM window (last; small)**

- **Owns:** `gm/window.ts`, `gm/editors/style.ts`.
- **Done when:** the GM window uses the kit window, flex tabs, lists and inputs, and `gm.test` and `editors.test` pass.

**Feature lanes (not UI lanes, for reference).** They use the kit and the §4.6 layouts:

| Lane (spec) | Builds (their owned files; fact-check: the draft named files those specs do not use) |
|---|---|
| trade TR-C (docs/SYSTEMS_SOCIAL.md) | `hud/trade.ts`, `hud/trade-state.ts`, `hud/trade-request.ts`, `world/features/trade.ts` |
| stall ST-C (SYSTEMS_SOCIAL) | `hud/stall.ts`, `hud/stall-state.ts`, `world/features/stall.ts` |
| guild GU-C (SYSTEMS_SOCIAL) | `hud/guild.ts`, `hud/guild-state.ts`, `hud/guild-invite.ts`, `world/features/guild.ts` |
| alchemy AL (docs/SYSTEMS_COMBAT.md) | `hud/alchemy.ts`, `world/features/alchemy.ts` |
| horse MR-C (SYSTEMS_COMBAT) | `hud/mount-frame.ts` (mounted in `PlayerFrame.petHost`), `world/features/mount.ts`, `world/mount-view.ts`; the stable tabs are ordinary `STORE_CH_STABLE` shop tabs in `hud/shop.ts` |
| repair DR (SYSTEMS_COMBAT) | `hud/repair.ts` (Repair / Repair all in the shop footer host, hammer cursor), `world/features/durability.ts` (warnings at the `hudAnchors` durability rect, the slot decorator) |
| berserk (SYSTEMS_COMBAT §5.3) | `hud/berserk.ts` (drawn into `PlayerFrame.berserkHost`), `world/features/berserk.ts` |

Each registers its MENU popup row through `hud.menubar.register(…)` (a `MenuBarEntry`; e.g. the stall's "Stall" row, SYSTEMS_SOCIAL §9.3), an Esc/System row (rare) through `registerMenuItem`, and its key through the KeyMap.

### 9.2 Conflict notes

- `hud/index.ts`, `screens/world.ts`, `style.css` and `hud/player.ts` are hot files. UI-H and UI-W each touch `hud/index.ts` in **different functions** (UI-H: construction and placement; UI-W: the toggles and `askCount`). The integration agent merges them.
- The `zoom` change (UI-K) edits many style sheets by one pattern. Do it in one commit, **after** the current feature lanes merge, and before UI-H and UI-W start.
- If a feature lane lands a window on the old `HudWindow` before UI-K, it still gets the new chrome through the `HudWindow` subclass (step 2). Nothing breaks.
- **Other specs touching the same files (fact-check):**
  - docs/EFFECTS.md: `hud/effects.ts` + new `hud/hitcount.ts` (theirs), `export-ui.ts` (ours; we add their globs), `screens/world.ts`, `main.ts`, `world/features/skills.ts` (shared, hook lines only).
  - docs/SYSTEMS_SOCIAL.md: `hud/target.ts` + `hud/index.ts` (`addTargetAction`), `world/chat.ts` (`ChatKind` += `'guild' | 'stall'`, `ChatTab` += `'guild'`), `hud/npc-dialog.ts` (`registerNpcService`), `screens/world.ts` (`beforeGroundMove`). These land **before** UI-H / UI-W take the files over.
  - docs/SYSTEMS_COMBAT.md: `hud/slots.ts` (`SlotDecorator`), `hud/items.ts` (durability lines), `hud/index.ts` (registers `AlchemyWindow`, `MountFrame`, `BerserkGauge`, the repair buttons). UI-H must ship `berserkHost` / `petHost` and UI-W the shop footer host; until then those lanes mount beside the player frame / at the bottom of the shop body.

### 9.3 User-visible checks (for the user, after each lane)

1. **Scale.** At 1024×768 the UI draws at 100%: the player frame is 212 px wide, and 12-px text is crisp. At 1920×1080 (Auto) it is 125%. Options → Interface → UI scale offers Auto / 100–300%.
2. **Fonts.** Labels read in the client's own font, not Tahoma: the devtools "Rendered fonts" shows SRO Basic.
3. **Top-left** shows the retail player frame (portrait, name, level in gold, HP/MP with numbers), buffs to its right, and party frames under it.
4. **Top-centre** shows the target window in the 236-px 2009 frame. Champions and giants show the variant icon and level row. "Invite" for players sits inside the window.
5. **Top-right** shows the minimap with "Jangan" and the X/Y coordinates **inside** the top plate, the zoom and map buttons on the plate, and the quest tracker under it.
6. **Bottom-centre** shows one bar: 10 quick slots with key numbers, the M slot, SP, level, a 10-segment EXP bar under the slots, character/inventory/skill buttons, and MENU (opens the list: Character, Inventory, Skills, Quests, Party, Options, System…).
7. **Bottom-left** shows the retail chat box with tabs, a scroll bar and the input line. It never covers the bar at 1280×720.
8. **I** opens the main window on Inventory, with equipment on the right and the bag on the left. **C** switches it to Character, and **S** to Skills. The side buttons switch tabs, and pressing I again closes it.
9. Every window has the gold-rimmed title strip, a close button, and opens without covering the previous one.
10. **Esc** opens the System window with five long buttons; "Character select" fits.
11. Hovering a sword shows the tooltip: the name, a line, the stats, a line, the requirements (red if unmet), a line, and the sell price in gold.
12. Dragging an item shows a ghost icon. Valid targets glow, and the source slot dims.
13. The mouse pointer is the flame hand.
14. Hitting a monster shows the retail digit art; crits show "CRITICAL" (delivered by the effects lane, docs/EFFECTS.md FX-C3; listed here because it is part of the look).
15. On the login and create screens, "Female" is not clipped and the register fields are the same width.

---

## 10. Open questions (each has a default)

| # | Question | Default |
|---|---|---|
| 1 | The Main window model hides the inventory when the skill tab is shown, as retail does. Some players like both open. | Retail tabs. Options → Interface → "Separate windows" (off) re-opens the pages as their own mframe windows [unknown]. |
| 2 | 48 bag slots (up to `MAX_BAG_SIZE` 96) in a 4×8 retail lattice. | Pages of 32 with the spin control, as storage does [unknown]. |
| 3 | Auto scale at 1080p: 1.25 (soft art) or 1.0 (crisp, small). | 1.25; the user can pick 100%. |
| 4 | System messages panel (retail separate box) or the chat's System tab (today). | Keep the System tab; the retail panel is off by default. |
| 5 | Attack, talk and pick-up cursors have no retail source. | Hand + small overlay (§4.10), or the plain hand for all. |
| 6 | Item name colours by rarity. | §4.8 values; revisit with the alchemy lane (blue options). |

## 11. Risks

- **The font subset may still fail OTS.** Mitigation: Tahoma/Verdana fallback, as today, which is readable.
- **The 2009 underbar positions are measured from art, not from data.** Mitigation: the measurement script and the layout test; the old `ifunderbar.txt` slot rects are the fallback.
- **The `zoom` property** is supported in Chrome and Edge, and in Firefox since 126 [likely]. Babylon picking is unaffected (the canvas is outside the zoomed layer). Every drag and positioning code that mixes `clientX` with `style.left` must divide by `--ui`. Today's `HudWindow.applyPosition` multiplies instead; the kit Window replaces it.
- **Hot-file collisions with the feature lanes** (§9.2). Mitigation: the kit is new files only, and the migration runs after those lanes merge.
- **Asset size grows by about 12 MB of PNG.** Mitigation: `optimize-out` and HTTP caching; only the frames in use are loaded.
- **Zoom and screen-projected elements** (fact-check). Anything placed at projected screen px (damage floaters, `.entity-labels`, nameplates, the charselect info card) is wrong by a factor `--ui` inside a zoomed container. Mitigation: keep them outside `.hud-root` / `.world-ui`; `ui-layout.test.ts` cannot catch this (no DOM), so it is a user check at 1920×1080 (125%).
- **Resinfo `#ifdef`s.** A parser that ignores them silently takes the `#else` values (this is how the first draft got the trade window and the chat input wrong). Mitigation: the exporter and any layout tool resolve the defines of `Media/config/define.txt` (22 lines) first.
- **Pk2 names with spaces** (`alcm_window_quick mastery.ddj`, `wmap_button_automatic .ddj`). Mitigation: exclude `\s` or re-key.

## 12. Reference files kept (`work/tmp/ui/`)

| Path | What it is for |
|---|---|
| `ref/frame-mframe-int.png` | The main window frame (`mframe_wnd_`, 388×408, filled with `com_bg_tile_a`), the main popup side tab strip (composed with `main_systab`; retail uses `main_systab_02` at (−42,55), §4.6), and the bag frame (`int_window_` + `int_window_downbox`): the target look of windows (§4.6) |
| `ref/frame-small.png` | `sframe_wnd_` (blue caption strip), `msgbox2_window_`, `frame_tooltip_`, `npc_conversation_window_`, `frameg_wnd_`, `frameg01_wnd_` composed at real sizes |
| `ref/frames-all.png` | 18 frame families composed side by side (overview) |
| `ref/kit-controls.png` | The controls at 2×: `com_button`, `com_m_button`, `com_mid_button`, `com_s_button` in normal/focus/press/disable; all tab pairs; `com_new_tab` 3-slice; checkbox, radio, scroll, arrows, close, plus/minus, money, item select and signs; `com_bar01..03`; lattice cells; tooltip and notice pieces; casting and fatigue gauges; bg tiles a–d (§2.4, §5.2) |
| `ref/underbar-new.png` | The 2009 underbar `ub_new_mainbar2` (digits) and `mainbar3` with the decorations (§4.5) |
| `ref/underbar-new-left-3x.png` | The left third at 3×: the SP slot, level box, M slot and first quick slot, for measuring (§4.5) |
| `ref/hud-atlas-preview.png` | `window_all` atlas regions with gauges: player frame, 2009 target windows, party slot, pet frame, chat input, old `tw_type1` |
| `ref/hud-layout-1024x768-mock.png` | The proposed world HUD at 1024×768, 100%, built only from retail pieces (§4.2) |
| `ref/atlas/wa_*.png` | Every `window_all` region used by resinfo, named by its atlas rect (§2.7); `wa_0_0_1024x512.png` is the whole atlas |
| `ref/cursor_normal1.png` | The retail flame-hand cursor (§2.8) |
| `ref/interface-sizes.tsv` | Path, width and height of all 2,119 decoded interface textures (`worldmap` is not in it) |
| `sheets/<folder>_<n>.png` + `.txt` | Numbered contact sheets of every folder listed in the Method (number → path and size in the `.txt`), for browsing art quickly |
| `*.ts` | Scratch tools: `convert-all.ts` (sheets), `resinfo.ts` (dump a resinfo file; **does not resolve `#ifdef`**, it keeps the last value, i.e. the `#else` branch; use it with care), `atlas.ts` (atlas regions), `compose*.ts` / `kit.ts` / `underbar.ts` / `layout-mock.ts` (reference composites), `measure.ts` (EXP band geometry), `fontcheck.ts` (TTF tables), `tga.ts` (cursor) |
| `test-account.txt` | The throwaway local test account used for the screenshots (local dev server only) |
