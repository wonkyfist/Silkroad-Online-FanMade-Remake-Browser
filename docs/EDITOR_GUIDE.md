# The World Editor: a short guide

The World Editor is your own map editor for the Jangan fields. You can shape the ground, paint it, plant trees, and
place or move lanterns, stalls and rocks. Then you **Publish** the result to your PC's game and, when you are happy with
it, **Deploy** it to the friends' server. It runs only on this PC: players never get the editor, only the map you
publish. The design is in [WORLD_EDITOR.md](WORLD_EDITOR.md); this page is how to use it.

## Start and stop

- Double-click **Silkroad World Editor** (the shortcut in `work/editor/`; a copy on the Desktop works too), or run
  `pnpm editor` in `C:\dev\silkroad`. It opens `http://127.0.0.1:5185` in your browser.
- Close the black window to stop it. One editor at a time: a second tab opens read-only.
- Nothing you do reaches anyone until you Publish, and nothing reaches the friends until you Deploy.

## Moving around

| Do this | To |
|---|---|
| Right-drag | look around |
| Right-drag + W A S D, Q / E | fly, down / up |
| Middle-drag | pan |
| Mouse wheel | zoom |
| M | the map (click a spot to fly there) |
| F1 | the keys of the tool in hand |

## The tools

| Key | Tool | What it does |
|---|---|---|
| V | Move | Click an object to select it (Shift or Ctrl + click adds or removes, drag a box for many). W move, E turn, R resize, G snap to the ground, Del delete, Ctrl + C / V copy and paste. |
| O | Place | Pick a model or a tree in the library, click the ground to put it there. The wheel turns it, Shift + click keeps placing. Trees get a small random size and turn. |
| B / N | Raise / Lower | Drag over the ground. Shift reverses. `[` `]` brush size, `-` `=` strength. |
| S | Smooth | Rounds off bumps and steps. |
| F | Flatten | Flattens to the height where you start the drag (Alt + click picks a height). |
| J | Noise | Adds natural roughness. |
| P | Paint | Paints a ground texture (grass, sand, dirt, rock, road and paving: the remastered tiles). Shift + drag paints the original ground back; Alt + click picks the texture under the cursor. |
| H | Grass | Paints grass and flowers in or out. |
| Y | Walkable | Opens or closes ground for walking by hand. Pick Open, Close or Auto in the panel (Shift + drag does the other of Open / Close); `[` `]` brush size. Green tiles: ground you opened; bright red: ground you closed. |
| T | Routes | The town's walking routes and seats (the townsfolk follow them). |

The Water, Lights and Sound tools are shown dimmed: they come in a later step. Red tiles on the ground are places
nobody can walk (slopes steeper than 35° close by themselves, and a closed tile never opens by itself: after you
flatten a mountain, paint its ground open with Walkable). Ground outside the playable area, in the sea or under a
building or object can't be opened (the editor says so).

Trees: the editor plants the **new trees** (29 species). On Low graphics the game shows the old tree in the same spot.
A tree keeps between 85 % and 115 % of its size; buildings keep their size.

## Undo, revert, save

- **Ctrl + Z / Ctrl + Y**: undo and redo, as far back as the session goes.
- **The Changes list**: every change has a line; its button reverts that one change (and only that one). A region's
  menu reverts everything in that region.
- **Ctrl + S** (or the Save button) keeps your changes on this PC (in `content/world-edits/jangan-fields/`). The game
  does not see them yet.

## Publish

1. Click **Publish**. The editor builds the changed regions into a test copy of the map (your live map is not touched),
   rebuilds the walking map, and checks:
   - nobody gets trapped, and every nest, NPC, gate and place the town reached is still reachable (these two **stop**
     the Publish if they fail);
   - ground cut off, objects left floating or buried, overlaps, and the per-region budgets that keep 60 fps (these
     **warn**).
2. Read the report. It names each problem and the region it is in, with before / after pictures of your changes.
3. **Test in game** (optional): starts a private copy of the game with your edit. Log in as usual and walk it. It
   stops when you close the editor tab.
4. **Keep** puts the new map in place on this PC (every replaced file is backed up) and commits your layers to git.
   **Go back** throws the test copy away and changes nothing. A kept Publish can be undone.

A Publish of a few regions takes about a minute.

## Deploy

**Deploy** sends the kept map to the friends' server (the assets only, through the normal deploy). It refuses while a
Publish is open, while nothing new was kept, or while a game build is in progress (uncommitted converter code, or a
newer game version than the server runs): then the map goes out with the next release instead. The friends reload the
page to see it.

## If something goes wrong

- "Another World Editor holds the lock": the editor is already open; find its tab, or close the other window.
- A Publish stopped: read the first red line of the report, fix it (often: smooth a slope you raised too steeply, or
  move an object off a road), then Publish again.
- The editor keeps a journal of the session in `work/editor/`; your saved layers are in
  `content/world-edits/jangan-fields/`. Revert there with git if you ever need to.
