---
id: 2026-10-05-play-the-boss
date: 2026-10-05T15:00
title: October 5: Play the Boss, the black-screen fix and more
summary: Once a week one player becomes Tiger Girl while everyone else hunts her. The game now recovers by itself from a graphics reset, a memory leak is gone, and there is a long list of fixes and wishes from your feedback.
hero: oct5-boss-hud.jpg
---
## Play the Boss: the Night of the Tiger

Once a week the **Night of the Tiger** begins. A call goes out to everyone online, players of **level 20 and up** volunteer, and one of them is drawn to *become* **Tiger Girl**. Everyone else hunts her. The more hunters really fight her, the stronger she grows, so a big crowd gets a real fight.

![A banner announces the call](img/oct5-boss-call.jpg "1. The call: every player sees the banner with the draw timer and how many have volunteered. If you can't volunteer yet, it tells you why.")
![The volunteer who is drawn gets the offer](img/oct5-boss-offer.jpg "2. The one who is drawn has 30 seconds to accept, or the next volunteer is drawn.")

- While you play her, your own character rests safely in a trance in town.
- **Her kit:** Claw, Sweep, Curse, Pounce, Fear Roar, Call the Pack and Stalk, on keys **1 to 7**. Walk with **WASD** or a click, hold **Q** to taunt.
- **Boss HUD:** how long you must survive, how many hunters you have downed, and who is hunting you right now.
- Step away from the keyboard and her own AI takes over until you are back.

![Playing Tiger Girl](img/oct5-boss-hud.jpg "3. You are Tiger Girl: the survive timer, hunters downed and who is hunting you sit at the top; her skills at the bottom.")
![The result window](img/oct5-boss-end.jpg "4. When the hunt ends, everyone sees how it went and who was Tiger Girl.")

> Staff schedule the weekly night and can start a call by hand, so watch the chat and the notices for the next one.

## The black-screen fix

Some of you saw the game turn black and stay black. We found **two causes** and fixed both:

- **Graphics card resets.** If your graphics card ever reset, the 3D view never came back. Now a short notice appears, the game reloads itself and puts you **straight back where you stood**: no login, no character select. If it happens a second time, the game switches to the safer WebGL2 renderer on its own.
- **A memory leak.** While grinding monsters the game grew by about 60 MB a minute, which could end in a black screen after a long session. It is gone: in a 12-minute test memory now stays flat (about 320 MB instead of climbing past 1 GB).

![The reset notice](img/oct5-gpu-notice.jpg "A graphics reset now shows a short notice while the 3D view is restored...")
![Back in the same spot](img/oct5-gpu-recovered.jpg "...and you are back on the same spot, no login needed.")

## Weapon glow +1 to +7

Enhanced weapons finally look the part. From **+1** a soft shimmer, then a glow and a pulse, up to the original's bursts of light at **+7**. Everyone around you sees it, and it stays light on Classic graphics.

![Weapon glow from +0 to +7](img/oct5-weapon-glow.jpg "The same blade from +0 to +7.")

## Also in this update

- **Auto potion** (Options → Controls): drinks an HP potion below 50 % and an MP potion below 30 % (both adjustable), and can cure bad states with Universal Pills.
- **Mouse-wheel quick slot:** the "M" slot works. Drag a skill or a potion onto it, then click the mouse wheel in the world to use it. It is saved with your character.
- **Giant monsters** are twice the size, with a hit area that grows with them.
- **Champions attack on sight**, even those of passive monsters, like the original.
- **Party setup like the original:** the party type is asked when you invite, Invite / Settings / Leave are in the party window (P), and the original chat commands work.
- **Alchemy window fixes:** it no longer hides under the inventory, cancelling is clean, and there is a hint for worn items.
- **Garment rule:** Garment can't be mixed with Protector or Armor, as in the original. Sets you already wear are kept.
- **Sounds are back:** imbue hits, the accessory "ding", Berserk hits, quests, revival, rare drops and more.
- **Quiet town:** the crowd voices really stop when the town crowd is turned off.
- **Skills window** shows your skills the first time you open it.
- **"Can't walk here" switch** (Options → Controls) hides that warning and its sound.

## Fixes you can see

- **Classic (Low) graphics:** more than 400 trees and objects were invisible but still blocked your way. They are drawn again.
- **Character select:** the info box now sits beside your character, never over it.
- **Exorcist Miaoryeong** waits on the town end of the river bridge, no longer inside a bush.

![Classic graphics before and after](img/oct5-classic-before-after.jpg "Classic graphics: before, invisible trees still blocked you; now every blocking tree is drawn.")
![Character select](img/oct5-charselect.jpg "Character select: the info box beside your character.")
![Exorcist Miaoryeong on the bridge](img/oct5-exorcist.jpg "Exorcist Miaoryeong on the river bridge.")

## For staff

A new web **admin panel** that works on phones too: accounts, items with their icons, drops, NPCs and spawns, quests, events (including the Night of the Tiger), settings, an audit log, and a switch to open or close registration.
