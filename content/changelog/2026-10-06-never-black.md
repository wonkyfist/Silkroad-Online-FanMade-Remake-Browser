---
id: 2026-10-06-never-black
date: 2026-10-06T01:00
title: October 6: No more stuck black screens
summary: If your browser's graphics hiccup, the game now switches to a safer graphics mode by itself, and if the browser itself stops showing 3D, it tells you exactly how to fix it. Plus a new Graphics mode option.
---
## The game fixes itself when graphics hiccup

Sometimes a browser's graphics crash, for example when your PC runs low on memory or other programs are using the graphics card heavily. Before, the game could stay **black** after that.

- If the graphics device stops responding, the game now **reloads straight back to where you were** in a safer graphics mode (**WebGL2**), with no login or character select.
- The game also **checks that its picture really reaches your screen**. If the 3D view stays black during the day, it switches to the safer mode by itself (once, so it never gets stuck reloading).

## When the browser itself stops showing 3D

If the browser stops showing 3D content altogether, no game can draw in it until its graphics restart. The game now **tells you what to do** instead of leaving you on a black screen:

- **Open the game in another browser**, such as Microsoft Edge, or
- in **Chrome**, press **Shift+Esc**, select **GPU Process** and click **End process**, then reload the game. Your other tabs stay open.

You can open this help anytime: **Esc → Screen black?**, or the **Screen black?** link on the login screen.

## New option: Graphics mode

**Options → Graphics → Graphics mode**: **Automatic** (the default), **WebGPU** or **WebGL2 (compatibility)**. If your PC often has graphics trouble, choose WebGL2. The change applies after a reload, and the game offers to reload for you.
