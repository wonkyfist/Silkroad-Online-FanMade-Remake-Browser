# Morning playtest checklist

Good morning! Everything below exists and passed its tests overnight.

**Already checked in a real browser (WebGPU) overnight:**
- the fields streaming in;
- the world map (M) and the minimap;
- the new HUD, the skill window (S);
- clicking an NPC (Storage-keeper Sansan): her dialog and the storage window;
- the grass and plants: the shaders compiled and rendered with no errors.

**Not yet seen in a browser:** the quest UI (markers, log, tracker), party frames, the GM editor tabs, and the skill effects. Your eyes are the last check there. Tick things off in any order. If something looks wrong, note the step number (for example "C4") and move on.

**Where things are:** game http://localhost:5180, server http://localhost:7000 (`/health`), asset viewer http://localhost:5173. The server plays the fields export (`jangan-fields`: 307 regions, about 6,083 monsters).

## 0. Before you start (2 minutes)

1. **Check the server is current.** The dev server restarts itself when code changes; it last restarted at about 08:00 and loaded the latest quest file (six hunting spots moved overnight). It does *not* restart when only `content/quests/jangan.json` changes, so after editing that file, type `/content reload quests` as a GM (or restart the server window).
2. **Make yourself a GM** (once per account), from `C:\dev\silkroad`: `pnpm gm grant <username>`. The [GM] tag shows within about a second. `pnpm gm list` shows every GM, `pnpm gm audit` shows the last GM commands, and `pnpm gm revoke <username>` takes the role away. Only this CLI can grant roles; nothing in the game can.
3. Hard-refresh the game (Ctrl+F5). Keep the browser console (F12) open, and turn on the FPS counter with Ctrl+Shift+F.
4. **Grass:** its WebGPU shaders compiled and rendered fine overnight (about 3,000 plants around town, no errors); WebGL2 has not been tried. Walk out of the south gate. If the screen goes black or glitchy, or the console shows WGSL or pipeline errors, set Options → Graphics → "Grass & plants" to **Off** and tell me. If you can, try both renderers (Options → Graphics shows which one is running).

## 1. Getting started

1. **Register** a new account on the login screen, then **Create** a character: check the name (3-12 letters, digits or _), pick sex, model and weapon (sword, blade, spear, glaive or bow). The race is Chinese and the town is Jangan.
2. The character list shows the level and area. Click **Start**. The loading screen shows rotating tips, and you appear on the Jangan plaza.
3. Press **H** for the key help. On your first few visits, a hint for it shows at the bottom of the screen.
4. Press **Esc** for the menu: Options, Key Help, Sound, Fullscreen, Character Select, Log Out. **F5** in the world takes you back to character select without logging in again.
5. Stop the server for about 10 s: the HUD dims and shows "Reconnecting...", then recovers.

## 2. World and map

1. Walk out of any gate. The land, trees and monsters keep streaming in with no loading screen, and the area name under the minimap changes from Jangan to field names.
2. **M** (or the map button on the minimap) opens the world map: area names, your arrow, NPC dots and hunting labels. The wheel zooms, left-drag pans, right-click re-centres on you, and Esc or M closes it.
3. The minimap +/- buttons and the wheel zoom it, and the zoom survives a reload. Under the map: the area name and SRO coordinates.
4. Monster name colours follow level: level-1 Mangyang are yellow; `/spawn MOB_CH_GYO_CLON 3` gives orange names and `/spawn MOB_CH_WATERGHOST 3` red ones. Crowded name tags stack or fade instead of piling up.
5. `/tp` alone lists the places you can jump to: `jangan`, `spawn`, `grassland`, `hill-of-ye-mt`, `yeohas-forest`, `north-tiger-mt`, `south-tiger-mt`, `bandits-mountain-stronghold`, `lake-forest`, `swamp-area`, `chinese-tomb`, `enterance-of-qin-shi-tomb`, `jangan-ferry`, `western-china-ferry`, plus the town spots, beaches and boss camps of §7 "Teleport places". After `/tp north-tiger-mt`, `/where` names the area, and the land fills in within a second or two.
6. Die in the fields (`/spawn MOB_CH_TIGER 3` at level 1 does the job): the camera pulls back, and you respawn at the town gate. Below 25 % HP the screen edges pulse red.

## 3. Combat and skills

1. Click a Mangyang to walk over and attack. The cursor is a sword over monsters, a speech bubble over NPCs and a grab hand over items. **Z** targets the nearest monster, and pressing it again cycles through them. **G** picks up loot near you.
2. For a quick skill test: `/setlevel <you> 20`, then `/skill all`. Press **S** (or K) for the skill window. It has Weapon and Force tabs; locked rows explain why in their tooltip.
3. Drag skills onto keys **1-0**; **F1-F4** switch hotbar pages. Drag an HP potion onto a slot too. After a relog the hotbar is still there and cooldowns keep running.
4. Next to a Mangyang, cast each skill once and watch its effect: Strike Smash (slash, cut mark and spark exactly when the number shows), Illusion Chain (one mark per hit), Soul Cut Blade from about 10 m (the blade flies and lands with the number), Ice River Force (blue glow, ice at frozen mobs' feet), Weak Guard of Ice (aura while the buff lasts; right-click its buff icon to cancel it), Heal. After a few minutes of fighting there should be no leftover effects and no FPS drop.
5. Clicking the ground during a cast shows the red "canceled" bar. Holding a skill key with too little MP is refused, but does not disconnect you.
6. **Skill points come from SP EXP, not from levelling** (as in SRO). Every kill adds SP EXP (× SP_RATE): watch the thin yellow gauge under the EXP bar, whose tooltip reads "SP EXP n / 400" and your skill points. Every 400 SP EXP a gold "+1 SP" rises from the SP counter and chat says "You gained a skill point". The skill window (S) shows your free SP at the top. `/setlevel` now also grants the SP of the levels it raises (level 1 → 20: 2,530 SP). A character raised with `/setlevel` before this change has 0 SP: top it up with `/skill sp 2530` on that character (do not lower and re-raise it: spent stat points are kept on lowering, so the re-raise would give them twice).
7. **C** opens the character window. Put stat points in with the + buttons; Ctrl spends 10 at once and Alt spends all. Gear you cannot use is tinted red.
8. Two magic-only monsters, Tomb Stone Ghost (lv 8) and Tomb Stone (lv 9), used to deal 1 damage per hit. They now hit with magic. Check that they hurt: `/spawn MOB_CH_TOMBSTONE_CLON 1` and attack it.

## 4. NPCs, shops, storage and potions

Town NPCs, with `/tp x z` coordinates if you want to jump:

| NPC | What | `/tp` |
|---|---|---|
| Herbalist Yangyun | potions | `158 -141` |
| Blacksmith Chulsan | weapons, shields | `33 -141` |
| Protector Trader Mrs Jang | armour (Male/Female switch) | `33 -109` |
| Grocery Trader Jinjin | accessories, Return Scrolls | `166 -108` |
| Storage-keeper Sansan | storage (150 slots, per account) | `98 -99` |

1. Give yourself money with `/item ITEM_ETC_GOLD_01 50000`. Click Yangyun: you walk around the stalls and the dialog opens. Choose "Trade in the shop.": buy 10 HP herbs, sell 5, then buy them back from the buyback list.
2. Walk more than 8 m away: the shop windows close.
3. Drink two HP potions quickly: the second one is refused and the slot shows a cooldown sweep. An HP potion and an MP potion together both work.
4. **Return Scroll:** `/item ITEM_ETC_SCROLL_RETURN_03 3`, go outside town and use one. A 5 s bar appears; clicking to move cancels it and you keep the scroll. Use it again and stand still: you land at the town gate and exactly one scroll is used.
5. **Storage:** at Sansan choose "Deposit into storage.". Drag in an item (it costs a small fee) and deposit 1,000 gold. Then take both out on a second character of the same account.
6. Look at Sansan's body: it may float about 1.2 m off the ground (open question 36). Her name tag is fixed.
7. Pick something up: its icon flies to the inventory button, and new bag items glow until you hover them.

## 5. Quests: "The Tiger's Shadow"

34 quests: 25 main quests in four acts, 5 side quests and 4 dailies from the notice board. There is no GM command to skip or finish quests yet, so play Act I for real on a fresh character (about 40 minutes to level 6).

1. A gold **!** bobs over **Soldier Fengil**, about 50 m from where you appear (`/tp 94 -187`). Click him, choose "Talk to this person.", and accept "Welcome to Jangan". The offer page shows your name, the target and the rewards; hover the reward icons for tooltips.
2. Toasts appear, the tracker under the minimap lists the quest, and a gold **?** plus a minimap pin mark **Village Chief Hwangno** (`/tp 277 -143`). Turn it in: the "Quest Complete" banner shows, you get 60 EXP, 100 gold and 5 HP herbs, and the next offer ("Pests in the Millet") opens by itself.
3. Kill 8 Mangyang in the millet fields south of town (`/tp 109 132`). The tracker counts up to 8/8, then says whom to return to.
4. **Yangyun, "Herbs and Hides":** each hide shows "Mangyang Hide (n/6)" in chat and goes into the quest bag, never onto the ground. The Complete button stays grey until you pick one of the reward potions.
5. **Hwangno, JG_004:** the Meat Bun sits in the quest bag with a real icon. Hand it to Bagger Sochil (`/tp -53 -54`).
6. **Q** or **L** (or the menu-bar button) opens the quest log: quests grouped by act, an n/10 counter, Track/Untrack, "Show completed", and Abandon (it asks first). The tracker shows at most 5 quests, and your tracked choice survives a reload. The minimap draws gold circles on the areas of tracked objectives.
7. `/setlevel <you> 19` shows new **!** marks, plus grey ones on NPCs whose quests are up to 2 levels away.
8. Worth a look: the moved hunting spots, `/tp 167 362` (Southern grassland, big-eyed ghosts for JG_005) and `/tp -370 -400` (the swamp just north of Exorcist Miaoryeong for JG_010-012). Miaoryeong now stands at the east end of the west river bridge, `/tp -410 -300`, out of the Yeoha camp.
9. The daily JG_R01 (Fengil, after JG_002): once turned in, it answers "cooldown" until 04:00 server time.
10. **The finale (JG_025, Tiger Girl):** you can only get there by playing the whole chain. With a party at level 19, ring the Binding Bell at the Tiger Mountain Shrine (`/tp -1001 600`). One Tiger Girl appears at 5 % of her HP. A second ring answers "cooldown". After she dies, by anyone's hand, the bell waits about 120 s. After a GM `/kill` it works again at once.

Quick test trick: in the GM Quests editor you can lower an objective count (for example JG_002 from 8 to 3). "Revert to repo" undoes it.

## 6. Party with a friend

Use a second account in a private window, or a friend over Tailscale.

1. Target the other player and click **Invite** under the target window. The popup reads "A (Lv x) invites you to a party.", shows the EXP and Items modes, and counts down 30 s. Accept.
2. A member row appears under the buff bar (light-blue name, a crown on the leader, HP/MP bars). The name tag turns light blue, and a party pin shows on the minimap.
3. A line starting with `#` goes to party chat (`#hello`). Outside a party you get an error line instead.
4. Kill a mob while your friend stands nearby: both of you get EXP. If your friend has JG_002, their count goes up without dealing damage.
5. **P** opens the party window. Only the leader can switch the EXP and Items modes. Right-click a member row for Target, Whisper, Make leader, Kick and Leave.
6. With Items set to Shared, drops alternate between members and gold is split ("You received N gold (party share from A)"). Pickup rights are fixed when an item drops: switching modes later does not unlock someone else's item.
7. Close your friend's tab: their row dims and "went offline" appears. If they relog within 2 minutes, they are back in the party.
8. Whispers: `/w <name> hi` gives pink From/To lines, `/r` replies, and `/w Nobody hi` says "Nobody is not online.". The All / Whisper / Party / System tabs filter the chat, and clicking a name starts a whisper.

## 7. GM tools and editors

**F9** (or typing `/gm`) opens the GM window. The first row of tabs is Players, Teleport, Broadcast, Self, Spawn, Items and Log; the second row holds the editors: Spawns, NPCs and Quests. `/help` lists every command.

Commands that help with testing:

| Command | Does |
|---|---|
| `/tp <x> <z>` · `/tp <place>` · `/tp <player>` · `/tp npc <name>` | teleport (`/tp` alone lists the places by group; `/tp npc chulsan` lands next to Blacksmith Chulsan, any part of a name works, and a name that fits several NPCs lists them) |
| `/where [player]` · `/who` | position and area · everyone online |
| `/setlevel <player> <level>` | set a level (works offline too). Raising also gives the stat points and the SP a typical player has at that level (level 20: 2,530 SP); lowering keeps SP. The reply lists what changed. |
| `/skill all` · `/skill sp <n>` · `/skill cooldown` · `/skill reset` | skills and SP |
| `/item <code> [n]` | items into your bag; `ITEM_ETC_GOLD_01 <n>` gives gold |
| `/spawn <mob code> [n]` · `/kill [id]` | up to 50 monsters · kill your target (no loot or EXP) |
| `/heal [player]` · `/speed <0.5-5>` · `/invis on\|off` | full HP/MP (also revives) · run speed · hide from players |
| `/summon <player>` · `/kick <player>` · `/notice <text>` | bring a player · disconnect one · server announcement |
| `/nest near` · `/nest add <mob> [count] [radius]` · `/nest undo` | spawn editor (saved, survives restarts) |
| `/npc near` · `/npc add <base code> <name>` · `/npc undo` | NPC editor |
| `/content status` · `/content reload [nests\|npcs\|quests\|all]` | GM content overrides |
| `/horse [code]` · `/horse off` | summon a horse without the item (level and lockout ignored) · dismiss it (wave 8) |
| `/hwan <0-5>` · `/hwan stop` | set your Berserk points · end a running Berserk |
| `/dur <slot\|all> <n>` · `/plus <slot\|bag> <0-12>` | worn durability (0 = broken) · an item's +N |
| `/mobskill <mob id> [row]` | list a monster's skills, or make it use one now |
| `/guilds list\|info\|rename\|disband\|kick …` | guild admin (audited) |

1. **Spawns tab:** rings and labels appear on the ground. Add MOB_CH_MANGNYANG with count 8 and radius 25 using "Add here", and 8 appear. Set the count to 3 and five vanish. Undo twice, then Remove. In chat, `/nest add MOB_CH_GYO 8 25`, relog, and the nest is still there; `/nest undo` removes it. Authored nests are capped at 1,000 monsters in total.
2. **NPCs tab:** add NPC_CH_SMITH as "Old Smith Bo". Try Rename, "Face my way" and "Set shop", then Remove or Undo.
3. **Quests tab:** open JG_002, change the count from 8 to 3 and click "Save & reload". A second player at 3/8 sees their tracker turn ready without relogging. "Revert to repo" gives 8 again. A misspelled mob code plus Validate shows the problem with a red border. A stale second tab gets the "changed meanwhile" message.
4. As a plain player, `/nest near` answers "Unknown command", and `pnpm gm audit` lists the denied call.
5. With `/invis on`, monsters you hit neither fight back nor run home to heal (fixed at the final gate: before, a missed first swing reset the monster to full HP). This makes invisible quest testing easy.

### Teleport places

`/tp` alone lists every place by group, and the GM window's **Teleport** tab shows the same groups as buttons with a search box: type part of a name to filter, click a place to go there. **Go to NPC** (or Enter when no single place fits) runs `/tp npc <search>`.

| Group | Places |
|---|---|
| Town | `jangan` / `spawn` (the gate where you appear), `plaza` (south of the fountain), `storage`, `palace-steps`, `north-gate` (the palace's big gate at the north end of the plaza avenue: the town wall has no north opening), `south-gate`, `east-gate`, `west-gate`, `market`, `smith`, `stable`, `pond` (the temple pond) |
| Fields | `grassland`, `hill-of-ye-mt`, `yeohas-forest`, `north-tiger-mt`, `south-tiger-mt`, `bandits-mountain-stronghold`, `lake-forest`, `swamp-area`, `chinese-tomb`, `enterance-of-qin-shi-tomb`, `jangan-ferry`, `western-china-ferry` (now on its own area's near bank) |
| Coast | `jangan-south-beach` (also `beach-south`), `tomb-east-beach`, `qin-shi-tomb-beach`, `jangan-bay-shore`, `east-shelf-beach` (a cliff 30 m over the sea), `western-strait` (a ridge 108 m over the strait) |
| Bosses | `tiger-camp-1` … `tiger-camp-11`: Tiger Girl's eleven camps (`/unique` says which one she is at) |

Every place stands on open ground you can walk from town; the server checks each one at start and logs (and leaves out) any that fails. The other coast names (Tiger Beach, Tiger Cape, Tomb Ridge Beach, River Mouth, South-East Cape, Jangan Bay, Spur Cove, Canyon Beach) lie wholly in the sea ring outside the walkable world, and Earth Ghost Canyon, Okmungwan Field and the Western China areas lie across the river, so none of them has a place. The list lives in `content/places.json`; `pnpm --filter @sro/server places` re-checks it on the real export (`--write` re-snaps the computed rows).

## 8. Settings, sound and keys

1. **Options → Graphics:** quality Low/Medium/High, resolution, sight range, fullscreen, "Grass & plants" (Auto/Off/Low/Med/High; the choice survives a reload). Compare FPS with grass Off and Medium while walking, and watch for hitches as plants appear.
2. **Options → Interface:** Show FPS, UI scale, damage numbers, EXP gains in chat, and the name-tag toggles (players, monsters, NPCs, items: always, nearby or on hover).
3. **Options → Controls:** hold the button to keep walking, camera speed, invert Y, camera mode (Free, Third person, Quarter view), "Z targets the nearest monster", and camera shake on critical hits.
4. **Sound** (Esc → Sound, or Options → Audio): five sliders that persist, plus "mute when in background". Listen for town music with wind and birds, stone steps on the plaza and softer ones on grass, music that changes at the gate, and swing, hit, coin, drink and level-up sounds. Check that left and right are not swapped: a mob on your left should sound from the left.
5. **Keys:** I inventory, C character, S/K skills, Q/L quests, P party, M map, H key help, 1-0 hotbar, F1-F4 hotbar pages, Z nearest target, G loot, arrow keys and Home for the camera, Enter to chat (Up/Down recall sent lines), Esc to close, F9 for the GM window, Ctrl+Shift+F for FPS. There is no WASD: you click to move, as in Silkroad.

## 9. Combat and items (wave 8)

Use a GM character (`pnpm gm grant <username>`). The headless tests already ran every step below against the real server; what is left is how it looks, sounds and feels. The step ids match docs/SYSTEMS_COMBAT.md §8.1.

**Where things sit** (check once):
- the horse frame appears in the player frame's pet area, under the portrait, only while you own a horse;
- the five Berserk orbs arc around the portrait (left of and below it);
- Repair and Repair all sit in the Blacksmith's shop footer, beside Gold;
- the MENU popup (the underbar Menu button) has Guild (U), Alchemy and Stall rows (seen in the mock world);
- Exchange and Guild sit inside the target window next to Invite when you target another player (Guild only while you may invite and they are in no guild).

**Horses (H):**
1. **H1.** Stable-keeper Machun (`/tp 33 -45`) → "Trade in the shop.": the Red Horse costs 1,200 gold, and the Recovery Kits 190 / 400 / 720.
2. **H2.** On a level-9 character, right-click the Red Horse in the bag: refused. `/setlevel <you> 10`, then use it again (not within 20 s of a fight). The horse appears under you with a blue appear effect and the summon sound, one Red Horse leaves the bag, and you run about 1.8× as fast. GMs can also type `/horse`, and `/horse off` removes it.
3. **H3.** The rider sits in the saddle, not floating and not sunk. Standing, walking and running change with the horse's gait (the rider uses the retail "cart" clips; say if the run looks wrong at speed). Your name label sits just above your seated head, and the horse has no label of its own while ridden. The horse frame shows its face, "Red Horse", "Lv 20" and a thin HP bar (hover: "HP 983 / 983"), with Dismount/Ride and Dismiss buttons.
4. **H4.** Outside town, click a Mangyang while mounted: you step down and attack it. Right after the fight, riding again is refused: "Cannot board a transport for 20 seconds after the end of combat.". Dismount with the button or `/dismount` (only while standing still) and walk more than 60 m away: the parked horse vanishes with "Your horse went home.". While mounted, sit (N), emotes, opening a stall and skills are refused.
5. **H5.** Let a monster hit you while mounted: the horse's bar drops and yours does not, and the horse moans. At 0 HP the horse dies (death cry, then a thud), you land on your feet, the frame disappears, and chat says "Your horse has died.". Summon another, take some damage, and use a Recovery Kit: the horse heals and the potion effect plays on the horse. Relog while mounted: you come back on the horse with the same HP.

**Monster skills (M):**
6. **M1.** Mangyang outside the west gate alternate a single chop (one number) and a double chop (two numbers), standing still while they swing.
7. **M2.** Bandit Archers (level 12) draw for about 1.4 s, then the arrow flies and the number shows when it lands. At the Qin-Shi Tomb, Tomb Stone Ghosts (level 8) wind up for about 1.3 s and throw a force bolt you can watch fly. They hit about as hard as before (docs/BALANCE.md §6).
8. **M3.** A Black Tiger (level 17, `/tp north-tiger-mt`) sometimes howls after a short wind-up: the howl hits everyone within 2 m (bring a friend) and shows around its chest while it plays its normal swipe. It is the hardest hit of the Tiger Mountain (about 3× a swipe). The Water Ghost (level 7) sometimes releases a green gas: the number is 0, a poison icon appears, and the poison ticks 16.
9. **M4.** `/spawn MOB_CH_TIGERWOMAN 1`: her main attack has a visible 1.1 s wind-up (step out of melee during it and the swing misses, no number); she howls (area) and, when you run 8-15 m away, curses you from range (a magic hit and a zombie icon). `/mobskill <her id>` lists her rows; `/mobskill <her id> 3` makes her curse you now.

**Durability (D):**
10. **D1.** Hover your weapon: "Durability 76 / 76" (max / max, not a range). After a long fight it drops (about 1 point per 20 landed hits).
11. **D2.** `/dur weapon 0`: the weapon slot turns red, a red weapon icon appears in the strip left of the minimap, and the small armour figure below it shows the weapon red. The tooltip reads "Durability 0 / N (broken)" in red, with the stats struck through. Attacking says "Cannot attack because the weapon is broken" (toast and chat), and the attack numbers in C fall.
12. **D3.** Blacksmith Chulsan (`/tp 36 -136`) or Protector Trader Mrs Jang (`/tp 33 -106`): the dialog shows only "Trade in the shop.". In the shop, Repair and Repair all sit at the bottom right. Repair turns the cursor into a hammer (a drawn hammer on the hand): click the damaged item, hear the repair sound, and the gold drops by the price. Repair all asks "…Cost: N gold." first. With nothing damaged both buttons are dimmed ("No item needs repairing."). A broken Copper Sword costs 198.
13. **D4.** `/dur chest 3`: the chest slot pulses red, it joins the top strip, and the figure's torso turns yellow and blinks.
14. **Sounds, by ear:** breaking should play a crash (`ui.eqbreak`) and dropping to low a short buzz (`ui.eqdanger`). **The exporter swapped this pair on purpose**: retail's table points "item breaking" at itemdanger.wav and "breaking warning" at itembreak.wav, and the exporter measured the two files (itembreak = an 800 ms crash, itemdanger = a 400 ms low buzz) and gave each cue the file that sounds like its name. If retail's crossed mapping sounds more right to you, set `EQ_SOUNDS_BY_CONTENT = false` in packages/convert/src/sound/build.ts and re-run `pnpm tsx packages/convert/src/tools/export-sound.ts`.

**Alchemy (A):**
15. **A1.** Grocery Trader Jinjin's shop has an Alchemy tab with Lucky Powder (1st), (2nd) and (3rd).
16. **A2.** `/item ITEM_ETC_ARCHEMY_REINFORCE_RECIPE_WEAPON_A 5`, `/item ITEM_ETC_ARCHEMY_REINFORCE_PROB_UP_A_01 10`, `/item ITEM_CH_SWORD_01_A 1`. Right-click an Elixir (Weapon): the Alchemy window opens with it in place, and the inventory opens beside it. Right-click the Copper Sword (the rune circle, "Copper Sword +0 → +1"), then a Lucky Powder: "Success rate: 100%" in green. Items in the window show red-locked in the bag. MENU → Alchemy opens it too. A (2nd) powder on the Copper Sword, or the weapon Elixir on armour, shows a red line and greys out Fuse; a broken sword says it must be repaired.
17. **A3.** Fuse: a spinning effect for about 3 s, the button reads Cancel, then a golden burst and the success sound; "Success! Copper Sword is now +1." and the +1 sign on the sword. Equip it: the attack in C goes up.
18. **A4.** `/plus <bag index of the sword> 9` and fuse (about 19.5 %): usually the sword returns to +0 with the fail burst, and the elixir and powder are gone either way. A success at +7 or more is announced to everyone.
19. **A5.** Start a fuse and click the ground: "Fusing has been cancelled." and nothing is used up. During a fuse, dragging bag items, selling, or asking someone to trade is refused as busy.

**Berserk (B):**
20. **B4.** With an empty gauge press Tab: "Your Berserk gauge is not full." and nothing happens (Tab typed in the chat box does nothing).
21. **B1.** Kill monsters: about one normal kill in eight lights the next orb with a flash (champions 1, giants 2, a unique all 5). `/hwan 3` lights 3; hovering an orb shows "Berserk gauge 3 / 5".
22. **B2.** `/hwan 5`: the frame and face glow and a small Berserk button appears by the portrait. Tab (or the button): "Your power and agility are increased substantially!", a red burst and aura, the character grows slightly and gets the red hwan hair (not under a hat that hides hair), the orbs burn and a countdown ring runs round the portrait, you run twice as fast, your weapon leaves the red HWAN trail and the damage numbers about double. A second player sees the same; one arriving later sees it without the burst.
23. **B3.** After 60 s the fade plays, hair and size return, the orbs are empty, and chat says "Berserk mode has ended.". Death, a return scroll to town and logging out also end it (`/hwan stop` on demand). Relog with `/hwan 4`: the gauge shows 4 orbs at once. On a horse, Tab is refused.

## 10. Social (wave 8, two accounts)

A second account in a private window (or a friend). Both level 10+ for the guild steps; creating a guild costs 10,000 gold (`/item ITEM_ETC_GOLD_01 10000`). Step numbers match docs/SYSTEMS_SOCIAL.md §10.10.

**Exchange:**
1. Stand near your friend in Jangan, target them and click **Exchange** (or `/trade`). If you are too far, you walk up and it asks again; chat says "Applying for a trade to X.". They get a popup "X (Lv N) applied for an exchange. Will you accept it?" with a 30 s bar. After Accept both see the Exchange window (partner on top, you below), the inventory opens beside it, and chat says "You started to exchange with X.".
2. Drag a potion stack into your half, right-click a +N weapon, and click the coin button to type 500 gold. The offered bag slots turn red. Your friend sees them; hovering shows +N and durability. Starter (`_DEF`) items are refused: "The selected item cannot be traded.".
3. Press Confirm: your plate shows Locked and the button reads Waiting…. When your friend changes their offer, their half flashes, your lock drops, and "The other player changed the offer." appears.
4. Both Confirm, then both press Exchange: the items and gold swap, both bags update at once, and "Exchanging with X is completed." appears.
5. During an exchange, dropping or selling an offered item is refused ("Cannot do that during an exchange."); an emote still works. Walking away, dying, a return scroll or logging out ends it for both, with the reason.

**Stalls** (in town, at least 3 m from any NPC):
6. MENU → Stall (or `/stall`): a name prompt pre-filled with "[Name]'s stall.". The Stall window opens in Modifying with your inventory beside it. Right-click a potion stack, pick an amount and a price ("1234567" shows as 1,234,567; "250k" works; 0 and 2b are refused); the slot turns red. Press Open. You play the stall pose and a sign with the title floats over your name for your friend. Clicking the ground only says "Close your stall first.". Right after hitting a monster, opening a stall is refused ("You cannot use the stall during the battle."). **Say which pose looks right:** VENDOR01 (standing, one hand raised) or sitting.
7. Your friend clicks you or your sign: the stall window opens with the greeting. They buy a listing (coin or right-click → "Buy X xN for M gold?"): their gold drops and the item arrives with its +N and durability ("You bought …"); you get "[Friend] bought item [Item]." in chat, a centre notice and the coin sound.
8. Press Modify: your friend sees "The shop is under construction." and cannot buy. Change a price and Open again: they see the new price; a buy started at the old price is refused ("The item on sale has changed."). Stall chat (the line in the window) reaches only you and your visitors, in lilac.
9. Log out while stalling: the sign disappears for your friend and their window closes ("The shop is closed."). Walking more than 15 m away also closes a visitor's window.

**Guilds:**
10. Guild Manager Leebaek (`/tp -89 -245`) → "Guild services." → "Create a new guild.", enter a name, confirm "If you pay 10,000 gold, the <Name> guild will be created.". The guild name shows in green above your name for both of you, and chat gains a Guild tab.
11. Press **U**: the Guild window shows you as Guild Master, "1 / 50" and today's Founded date. Invite your friend (Invite, the Guild button in their target window, or `/guild FriendName`); they get a 30 s invitation (or type `/join`). After they accept, they show with a green lamp and their level.
12. `@hello` or `/g hello`: only guild members see it, in the guild colour and tab.
13. Your friend logs out: their lamp goes grey with "N min ago". Restart the server and log back in: the guild, members, notice and titles are all still there (the headless test restarts the server the same way).
14. Rights → tick all four for your friend → Confirm: they show as Vice Master and can invite. From their account, Kick stays greyed out on your (the master's) row. Title and the Notice pencil work; a new notice shows as Guild post "<title>" at the next login. Options → Interface → "Display guild names" hides the green line.
15. Disband at Leebaek ("Disband the guild."): the name vanishes from both nameplates, and the window says you do not belong to a guild. The same name can be created again. GM checks: `/guilds list`, `/guilds info <name>`, `/guilds rename <old> <new>`, `/guilds kick <guild> <character>`, `/guilds disband <name>` (each one is in `pnpm gm audit`).

## 11. Known limitations

- **Not built yet:** teleporters and ferries (the "[Teleport]" soldiers are just NPCs), arrow use for bows, damage numbers in the game's own digit art, avatar stall booths, guild levels and guild storage, and horse armour or horse regeneration. Wave 8 (horses, monster skills, durability and repair, alchemy, Berserk, exchange, stalls, guilds) is in: §9 and §10.
- **Wave 8, not seen in a browser against the real server yet:** everything in §9 and §10 ran headless (combat-e2e, social-e2e, wave8-cross-e2e) and in the lanes' own tabs; the two-account steps are yours. The HWAN hit sounds (bathwanhit) are not exported, so a Berserk hit sounds like a normal one.
- **Never seen in a browser:** the party frame and invite popup, the quest dialogs and tracker, the GM editor windows, and the skill effects' timing. (Grass rendered fine on WebGPU overnight.)
- **Performance:** grass cost on the N100 is unmeasured (estimated 4-6 ms on frames that build a chunk). Server memory is about 750 MB on the fields.
- **Pathing:** attack and talk walks go in a straight line. A monster behind a fence or rock can end the attack; walk around it and click again.
- **Map:** 91 nests west of the river cannot be reached on foot, so they do not spawn, but the world map still labels them. Level 19 is thin: only 8 of 22 Chakji Worker nests are on this side.
- **Pacing at rates 1:** reaching level 20 takes about 28 hours of grinding without potions. Walking is 53-72 % of quest time, and a new character starts with 0 gold (the first 5 herbs come from JG_001).
- **Difficulty spots:** the Qin-Shi Tomb (JG_013/014, now lv 9-10) is still a field of aggressive 5-packs; only the entrance pack is asleep (§12, decision 8). Bandits (lv 16, JG_021) and White Tigers (lv 18) take 40-60 % HP per kill. The field Tiger Girl (level-20 unique) roams the level 16-19 grounds.
- **Other:** Safari is not a target. Some server lines (quest drop counts, party gold share) are English-only. Weak Guard of Ice shows no PD change on starter armour (it adds a percentage).

## 12. Decisions waiting for you

Each one has a default already in place, so nothing is blocked.

**Balance and pacing** (docs/BALANCE.md)
1. **Game rates for the friends server.** Recommended: `EXP_RATE=3`, `SP_RATE=3`, `GOLD_RATE=3`, `DROP_RATE=2` in `~/silkroad/silkroad.local.env`, then restart the service. That is roughly 6-10 hours to level 20, a few evenings. Keep SP_RATE equal to EXP_RATE. *Default: all rates 1.*
2. Quest rewards are never affected by the rates. *Default: keep it that way.*
3. Magic damage now uses INT (retail-correct), so an all-STR character's imbue hits about 60 % less at level 20. *Default: keep.*
4. JG_021 asks a level-16 character for 20 aggressive Bandits. *Default: keep it (buy the degree-3 weapon or bring a party). Option: lower the count to about 12 in the Quests editor.*
5. The field Tiger Girl roams the level 16-19 grounds. *Default: keep. Option: disable her 11 nests in the Spawns editor.*
6. Out-of-combat regeneration (3 % per 2 s) is a server rule. *Default: keep it and use the rates.*

**Questline** (from the new-player bot's 5 hours of play)

7. ~~Walking is heavy, and Return Scrolls cost 5,000 gold.~~ **Done:** JG_004 now gives 2 Return Scrolls, and Chief Hwangno says so when you turn it in. The shop price is unchanged, and JG_009 still gives 2 more.
8. ~~The Qin-Shi Tomb wall at level 8.~~ **Done, all three options in small doses:**
    - JG_013 is now level 9 and JG_014 level 10. To keep the EXP curve, Mrs Jang's Order (JG_S02) moved to level 8 and gives a level-9 shell before the tomb.
    - JG_012 also gives a head piece for your armour type (level 8) and 20 HP Recovery Potions (Small).
    - The tomb is a grid of about 25 aggressive packs, and no path around them exists. The pack of Broken Stone Ghosts right at the entrance is now non-aggressive (`content/nests.override.json`), and Miaoryeong's JG_013 text says to start there and to fight the other groups from their edge.
    - Check: `/tp 614 -626`. The five Broken Stone Ghosts about 25 m north-west only fight back when hit. The other packs still attack on sight.
9. ~~Miaoryeong stands next to aggressive Yeoha.~~ **Done:** she moved to the east end of the west river bridge (`/tp -410 -300`), facing the road to town. The nearest aggressive camp's range is now 63 m away, and the swamp is 109 m away instead of 258 m. The move is 150 m east instead of 80 m south-east, because the Yeoha camp lies south-east of her old spot and 80 m that way lands inside it. The move is in the repo (`content/npcs.override.json`), so it ships with the code and needs no NPC editor on the mini PC. The quest texts now name the bridge instead of her hut. Her hut model stays where it was.
10. ~~Nothing sends new players to Mrs Jang or Chulsan before the level-8 jump.~~ **Done:** after JG_001, Fengil offers the side quest "Dressed for the Road" (JG_S05): talk to Mrs Jang, then turn it in at Chulsan, for 300 gold, enough for a first cloth piece. Chief Hwangno's JG_001 text now tells you to listen to Fengil.
11. Collect drop rates for JG_006 (ash) and JG_007 (claws) take 17-33 kills. *Default: leave them. Option: raise the chances to 0.5 and 0.55.*

**Tech**

12. Should the server's walker fix (stop at the edge of a rock that overlaps a fence) also go into the client's shared walker? *Default: server only. The client follows the server's move.*
13. Should the 20-minute soak test run before each deploy? *Default: manual (`pnpm tsx apps/server/test/soak/soak.ts`).*
14. The older open questions 1-40 are in docs/WAVE_PLAN.md §8. The ones worth a look after playing:
    - q30: the Tiger Girl encounter's tuning;
    - q31: a GM `/quest` command to finish or reset quests (it would make testing much faster);
    - q32: every read-only `nest near` poll writes an audit row;
    - q34: grass on the town lawns;
    - q35: the grass default on the N100;
    - q36: Sansan's body;
    - q37: right-click party invites and minimap edge arrows;
    - q38: Esc does not decline an invite.

## 13. The mini PC (already deployed)

Everything above is live at http://<SERVER_TAILNET_IP>:7000/: release 53b6a22, deployed at 08:14.
- The log shows "content quests: 34 quests, 21 quest items, 17 locations; 0 errors, 0 warnings" and the jangan-fields world (6,083 monsters).
- Each deploy saved a database backup first, in `~/silkroad-data/backups`.

1. Set the rates (decision 1) in `~/silkroad/silkroad.local.env`, then run `systemctl --user restart silkroad`. A bad value stops startup with a clear message in `journalctl --user -u silkroad`.
2. Play there with a friend: sections 1, 5 (steps 1-3) and 6 (steps 1-4). Then compare grass Off and Medium on the N100; if it hitches, set grass to Low there.
3. Later updates: `pnpm run deploy` from `C:\dev\silkroad`. It ships committed code only, backs up the database, and rolls back by itself if the health check fails.

## 14. Wave 9: sky, lighting, weather and textures

The new look is **on for everyone** (`apps/game/src/rollout.ts` `RENDER_ROLLOUT = 'on'`; your decision "Default Medium,
High optional"). A new player starts on **Medium**; High and Ultra are their own pick in Options. A friend who already
played keeps their saved quality: Medium (the old default, so most of them) now shows the new look, Low stays the
Classic look, High and Ultra stay. The "Modern graphics (preview)" row is gone. Step numbers are "W1" and so on.

**Before you start**
- The mini PC is served over **HTTPS** (`https://<your-machine>.<tailnet>.ts.net`, `tailscale serve`), so
  Chrome, Edge and Safari run **WebGPU** there; a browser without it runs WebGL2. Locally, http://localhost:5180 has
  WebGPU; `?engine=webgl` forces WebGL2. The engine in use shows in the stats line (Ctrl+Shift+F).
- To see what a brand-new player gets, use a fresh browser profile (or clear the site's storage): the first visit picks
  the quality for the computer.
- Make yourself a GM for the `/time` and `/weather` steps (§0 step 2), and run `/time reset` and `/weather auto` when
  you are done: the clock and the weather are shared by everyone on the server.

**The release**
1. **W1** A fresh profile: character select and the world open on **Medium** with the new look (the stats line says
   "PBR Medium"). On a laptop with Intel or AMD integrated graphics it is Medium at 75 % resolution with light
   weather; on a Retina Mac, Medium at 75 %. There is no "Modern graphics (preview)" row in Options → Graphics.
2. **W2** Options → Graphics → **Graphics quality**: Low (Classic), Medium, High, Ultra. Each change shows the
   preparing picture for a few seconds, then plays smoothly (no stutter while turning the camera). Low with **Sky
   style: Classic** and **Weather effects: Off** is the old look, all of it: the Classic materials, the retail sky at a
   fixed noon, no weather (not even the server's rain greying the sky), no clock by the minimap, and a note under the
   Sky row says so. Pick a weather level or the Modern sky and the time of day and the weather come back (still the
   Classic materials, no rebuild picture). A friend whose saved quality was **Low** keeps that old look: on their first
   visit after the update the game sets Sky style Classic and Weather effects Off for them once (they can change both
   back). `/time 22:00` must not darken their world while those two are set.
   - **W2b** Character select and character creation: the weapons read as lit metal (the Copper Blade is grey-silver
     steel on both screens and both engines, about as bright as on Low; never a black silhouette), and the hair stays
     dark (no grey sheen), skin and cloth no brighter or shinier than in the world. On Low the two screens are the old
     ones.

**Time of day**
3. **W3** The clock by the minimap runs: one game day is 2 real hours. `/time 18:30`: a golden dusk (not pink or
   magenta). `/time 22:00`: a navy night; the lanterns and lamps glow and light the ground around them, characters stay
   readable. `/time 12:00`: noon, close to the old look's brightness. `/time freeze` / `/time resume`.
4. **W4** The moon changes phase over about 30 game days (`/time 23:00` then `/time day 14`: the full moon).

**Weather**
5. **W5** `/weather rain 30 20`: clouds gather, then rain (thin slanted streaks), ground and roofs darken and shine,
   puddles grow over a few minutes on flat ground. Under a roof or a big tree the rain sound is muffled.
6. **W6** `/weather storm 30 10`: darker sky, stronger wind (trees and grass sway harder), lightning flashes with
   thunder a moment later (near thunder cracks, far thunder rumbles). Options → Interface → **Reduce flashing
   (lightning)** tones the flashes down.
7. **W7** With a friend (or a second browser): both of you see the same weather and time, and the same puddles; a
   friend who logs in mid-storm sees them too. `/weather fog`, `/weather clear`, `/weather auto` to end.
8. **W8** Options → Graphics → **Weather effects**: Off keeps only the cheap sky, fog and light changes (no rain
   streaks, no wet ground); Auto follows the quality.

**Remastered textures** (the 145 hero sets from the texture pipeline, and your 12 Meshy picks)
9. **W9** Options → Graphics → **Textures (applies after reload)**: Auto gives Medium the retail-size remaster, High
   the 2× sets (up to 1024) and Ultra up to 2048; Classic keeps the retail textures. Reload, then look at the plaza
   paving, the south gate wall, the palace trees and your character at character select: the sets swap in a moment
   after the retail textures show; nothing waits for them.
   - **W9b** The Meshy sets: a character in the starter garment (clothes_01) or the light armour (light_01) shows the
     Meshy brocade on the chest (and the legs of the man's garment and the woman's light armour); the six adventurer,
     fighter/assassin and "bogy" bodies show Meshy skin with your local face. Textures → Classic shows the retail ones
     again after a reload; `?remaster=0` in the address bar leaves only the Meshy sets out (the pipeline's sets stay).
10. **W10** Say if anything looks wrong on the remastered ground outside the south gate (large dark soil patches were
   seen there; the cause is not confirmed).

**Details**
11. **W11** Target a monster or an NPC: the highlight is a warm tint, not a white silhouette, day and night.
12. **W12** High and Ultra: soft contact shadows (SSAO) under objects; the sky and water must not turn black. If you see
    black sky, grass or water, say which preset and renderer.
13. **W13** Frame rate (Ctrl+Shift+F): the standing goal is 60 fps. Note the numbers on the plaza and in a crowd, per
    preset and renderer. If the game keeps dropping to a lower preset on its own, say so.

**Decisions waiting for you** (each has a default in place)
- **Release:** decided 2026-09-29, "Default Medium, High optional": the rollout is `'on'`, a new player starts on
  Medium, High and Ultra stay in Options. (Going back to the opt-in preview is one value in `rollout.ts`.)
- **Tone mapping:** PBR Neutral or ACES (Options → Graphics → Advanced → Tone mapping). *Default: Neutral.*
- **The HUD clock** by the minimap. *Default: shown (Options → Interface).*
- **SSAO on High:** kept on; its GPU cost is not measured yet. *Default: on (Options → Graphics → Advanced → Ambient occlusion).*

## 15. Wave 10: faster drawing, beaches, grass and wildlife, the jump, the character screens

Built overnight 2026-09-30/10-01 (docs/WAVE_PLAN6.md); nothing is deployed until you say so. Test it on this PC first.
Step numbers are "X1" and so on.

**Before you start**
- The map was re-converted (the coast moved terrain and the nav), so the local game server must be **restarted** once
  before you test (stop and start `pnpm dev` in apps/server, or restart the dev servers); a server still running the old
  map puts you at the old heights on the beaches. Then reload the page.
- Make yourself a GM for the `/tp`, `/time` and `/weather` steps, and run `/time reset` and `/weather auto` when done.
- The measured frame times are in `work/tmp/w10r/budgets.md` (and Dropbox `wave10\budgets.md`); the overview picture is
  Dropbox `wave10\overview.png`.

**Faster drawing (batching)**
1. **X1** Medium, the plaza by the dragon fountain: it plays smoothly. Options → Graphics → Advanced → **World
   batching** Off and On again: the picture looks the same (the regions rebuild for a moment); with it on the stats line
   (Ctrl+Shift+F) shows far fewer draw calls. Low is unchanged from before (no batching on Low).
2. **X2** High: the plaza and a crowd of monsters should now hold about 60 fps on this PC (the bench's numbers are in
   budgets.md). Say if any place stutters.

**Grass and wildlife**
3. **X3** Walk out of a gate into the meadows: dense, soft grass with flowers and no bare gaps between tufts; it
   thins out softly at roads and at the sand, never a hard straight edge. Options → Graphics → **Grass** (Auto, Off,
   Low, Medium, High) and **Wildlife** (On, Off). Low keeps the old retail grass.
4. **X4** By day: butterflies over the flowers, small birds that flush from the ground when you walk close, dragonflies
   near water. `/time 22:00`: fireflies. `/weather rain 30 10`: the animals take cover; they come back after it clears.

**Beaches and the sea**
5. **X5** `/tp beach-south`: the south beach. Sand between the grass and the sea, a ragged natural edge (no grey strip,
   no ruler-straight lines), waves with foam running up the sand, the sea out to the horizon. Look at it at noon, at
   night and in rain.
6. **X6** Walk there without GM: from the south gate it is about 2 km, roughly 6 minutes on foot, over the south ridge
   through a narrow pass (the route the server allows). A character logged out on the old beach strip logs back in on
   the sand.
7. **X7** The coast all round: the east beaches, the lowered Tiger coast in the south-west corner, the west coast and the
   land bridge west toward Donwhang (no way through yet). Ships on the horizon, gulls, the surf's sound near the water.

**The jump**
8. **X8** Space jumps, standing and while running (since the polish pass about twice as high: about 0.6 m, 0.7 s in
   the air); a friend sees your jump and you see theirs. On a horse: "You cannot
   jump on a horse." Jumping during a trade keeps the trade window open.

**Character select and create**
9. **X9** Log out to character select: your characters stand on the Jangan palace steps, at the server's time of day
   and weather (at night it holds a sunset look). Create: the camera turns to the creation spot, and the characters
   appear when it stops. The turns should be smooth now (the polish pass keeps the characters' shaders; the longest
   frame is about 30–70 ms); a new model on Create can take about a second to appear. The loading picture before the
   first select may stay a little longer while the GPU catches up. Say if anything still hitches. On Low the same steps
   in the Classic look.
10. **X10** Anything that looks wrong or runs slowly: note the place (`/where`) and the quality preset.

## 16. Wave 11: Tiger Girl on her tiger, and a town that lives

Built 2026-10-01 (docs/WAVE_PLAN7.md); nothing is deployed until you say so. Test it on this PC first.

**Before you start**
- Restart the local game server once (the map, the town files, `mobs.json` and the sounds were re-converted), then
  reload the page. Make yourself a GM for the `/unique`, `/tp` and `/time` steps.
- The frame times are in Dropbox `wave11\budgets.md`; the overview picture is `wave11\overview.png`, the Tiger Girl
  clip `wave11\tiger-girl.gif`.

**Tiger Girl, the world boss**
1. `/unique list` shows her timer. `/unique spawn tiger here` puts her on her Blue Tiger next to you: the pink "UNIQUE
   MONSTER" banner with the alarm sound, and a chat line "[Unique] Tiger Girl has appeared! Area: …". Walk round her:
   she sits on the saddle, turns with the tiger, and her name stands above both.
2. Fight her with friends (a party of four level-20 players takes about 5 minutes at `hpMul` 0.08; say if it is too
   fast or too slow). At 80 / 60 / 40 % she calls two tigers; below 20 % she enrages; after 10 minutes of fighting she
   gets furious. Lead her 50 m from her camp and she gives up and heals.
3. When she dies she falls beside the tiger and stays 8 s; the banner "<name>'s party has defeated Tiger Girl!" with the
   event-complete sound. The loot: three gold piles, three degree-3 items you can wear at level 20 (some +1 to +3),
   two elixirs, potions, sometimes Lucky Powder or a Seal of Star item.
4. She comes back on her own 3 to 6 hours later at one of her 11 camps (North-Tiger Mt., South-Tiger Mt., Bandit's
   Mountain); the timer survives a server restart. Gwakwi and Jeonghye mention her while she lives.
5. On Low (the Classic look) she rides the tiger too, and the banners show the same.

**The living town**
6. Medium, the plaza at noon: townsfolk walk, chat in rings, sit on benches and the fountain rim, sell at stalls,
   guards pair up at the gates, children run; chickens, cats and a dog; pigeons land away from the paths. Nobody pops
   in or slides. Options → Graphics → **Town life** (Auto, Off, Low, Full).
7. Click a walker: your character still walks there, and the person answers in a bubble. Vendors call out now and then.
8. Banners, flags and awnings sway in the wind; chimney smoke leans downwind; steam from the kitchens; leaves fall.
   At night the lanterns light the plaza and the market street, and lantern carriers walk the avenue at dusk.
9. Listen at the plaza (the crowd's murmur grows with the people near you), at the smith (the hammer by day), at the
   stable and the chickens, and the bell on every game hour (three strokes at 06:00 and 18:00). Say if a sound is
   wrong or too loud.
10. When Tiger Girl appears, the town reacts for a minute: walkers hurry indoors and the guards walk to the south gate.
11. Two friends at the plaza see the same person at the same spot at the same moment.
12. Anything that looks wrong or runs slowly: note the place (`/where`), the time and the quality preset.

## 17. Wave 12: your own map editor, upscaled ground, new trees

Built 2026-10-02 (docs/WAVE_PLAN8.md); nothing is deployed until you say so. Test it on this PC first.

**Before you start**
- Restart the local game server once (the map was re-converted with the new trees), then reload the page.
- The frame times are in Dropbox `wave12\budgets.md`; the overview picture is `wave12\overview.png`, the editor clip
  `wave12\editor.gif`, and the tree and terrain review pages are in `wave12\trees-b1` … `trees-b4` and the `terrain-*`
  pictures.

**The new trees and plants**
1. Medium, walk from the plaza out to the fields: maples, willows, pines, bushes, reeds, barley, flowers and dead
   trees are the new ones (round crowns, layered pines, weeping willows), at every distance, with no tree popping or
   doubling as you walk. They sway in the wind and bend harder in a storm.
2. Options → Graphics → **Trees**: New / Retail switches at once; Retail is the old look. On Low you always get the
   old trees.
3. Say if a family looks too dark, too bright or too blue next to the old one (the gate is ±10 % brightness; six
   families are still being tuned: the dry bushes, and the far view of the broadleaf, swamp, poplar, brushwood and
   stump families).

**The upscaled ground**
4. Medium, the plaza paving, a dirt road, a grass field, the rocks south-west of town, the beach: sharper ground that
   repeats less at a distance, the same colours as before. Low keeps the old ground.

**The World Editor** (about ten minutes; docs/EDITOR_GUIDE.md)
5. Start it from the desktop shortcut (or `pnpm editor`). Raise a hill, paint a path, plant three trees, move a
   lantern, press Ctrl + Z once, and revert one change from the Changes list. Save.
6. **Publish** and read the report (it takes about a minute), then **Test in game**: log in on the page it opens and
   walk your hill. Then **Go back** (or Keep, if you like it: Keep changes your local map and commits your layers).
7. Say what feels clumsy. Nothing here reaches the friends until you press **Deploy** after a Keep, and only after the
   wave's own deploy.

**Deploy**
8. The wave needs your new OK to deploy (the earlier OK covered waves 10 and 11 only). It adds about 210 MB on the
   server; High players on WebGPU use about 0.3 GB more video memory.
9. If a friend has a Mac or a gaming laptop, one run at the plaza and one in the fields would tell us more than the
   dev PC can (the Mac margin, G6).
