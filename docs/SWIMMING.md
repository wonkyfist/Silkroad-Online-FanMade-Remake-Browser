# Swimming (wave 13)

The user's words for this item, verbatim:

> Swimming in the sea, with a swim animation.

Wave 13 also has "Fishing off the beaches and the pier with rare catches and cooking for small buffs" (docs/FISHING.md),
"Under water scenery, life, and events" (docs/UNDERWATER.md) and "Hot springs: a relaxing spot in the mountains where
resting builds bonus EXP for your next session, and a natural hangout for chatting" (docs/HOT_SPRINGS.md). This spec
owns **the water rule, the swimmer, the swim layer, the server's movement in water, the camera at the waterline and the
swim clips**. It hands the underwater *look* (fog colour, caustics, light, life, the underside of the sea) to
UNDERWATER through one seam (§9.4), and gives FISHING, HOT_SPRINGS and wave 14 ("The Climb") their hooks (§12).

**The user delegated every decision.** Where there is a choice this spec takes the option it would mark
"(Recommended)" and writes it as a decision with a one-line reason (§18). Only what truly needs the user is in §19 and
§20, each with the default that is built meanwhile. Delegation is not a deploy OK: wave 13 ships only after the user's
own OK, like waves 11 and 12.

**Tags.**

- **[confirmed]**: checked in the code or data of the working tree on 2026-10-02 (HEAD `cb65112`; the tree was clean
  when the reads were made, and wave 12's build began editing `apps/game` during this spec), or
  measured by this spec's prototype; each says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived), not measured on that setup.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this spec makes (§18). The user may overrule it.

**Design only.** Nothing under `packages/`, `apps/`, `content/` or `deploy/` was edited (wave 12 is building there).
The prototype, its scripts and shots are in `work/tmp/swimming/` (appendix A). Meshy: **0 credits** spent; swimming
makes no 3D model.

**Fact-checked (2026-10-02, adversarial pass).** Every [confirmed] claim was re-derived; the census and the round trip
re-ran to the same numbers. Twenty-two corrections are folded into the text below and listed in §22 with how each was
checked. The biggest: swimming as first written would have **opened 1.2 km² of land with level 19–30 monsters that no
player can reach today** (§3.3); the camera could **never** go under water with the game's pitch limit (§9.2); the
fog swap and the split pass collided with UNDERWATER's underwater state and the post stack's hitch rules (§9.3); a
bow across a river was a free kill (§8.1). The extra scripts are in `work/tmp/swimming/factcheck/`.

---

## 0. Summary

1. **One depth rule, one constant.** `SWIM_DEPTH_M = 1.2`: water up to 1.2 m deep is **waded** (walked, on the nav, at
   the normal speed, with splashes); deeper water is **swum** (on a new *swim layer*, at the surface, at swim speed).
   It is the same 1.2 m line WORLD_EDITOR D30 already draws for new water, and it is about mid-chest on a default
   character, whose neck stands ≈ 1.45 m above his feet [likely: the swim keyer floats the neck 0.03–0.15 m over a
   1.40 m waterline, §4.3]. The coast's knee-deep rule (0.4 m,
   `NAV_KNEE_DEEP_M`) moves to the same 1.2 m, so the beach and the swim water meet with no gap (§2.4).
2. **The task's premise needed a correction** [confirmed: §1.1]. Retail does **not** block deep water: players walk on
   river and lake beds under up to 58 m of water today (≈ 1.0 km² of open bed deeper than 1.2 m inside the bounds, of
   which 0.82 km² lies in the town's walkable component [confirmed: `factcheck/bed-comp.ts` on `MeshNav`]).
   What *is* closed is the coast's own sea deeper than 0.4 m (S1's strip, the S2 patch) and, by WORLD_EDITOR D30, new
   editor water deeper than 1.2 m. Swimming replaces all three: **deep water becomes "swimmable, not walkable"
   everywhere**, retail beds included.
3. **The swim layer** is its own small raster (2 bits per 2 m nav tile: none / wade / swim / swim + dive), built by
   one pure function from the same inputs as the coast and the nav (terrain heights, the retail water planes, the
   coast field's sea mask, the editor's water layer) and written as `swim.bin` (≈ 9 KB brotli for the classes of the 101 water
   regions inside the bounds [confirmed: prototype encode, classes only]). The server walks it; the client predicts with it; the
   converter's full build, the coast pass and the editor's Publish all call the same builder, so they always agree.
   **`nav.bin` keeps its format**; the walker treats a swim tile as closed for walking.
4. **Where you can swim.** Every connected deep-water body of at least 300 m² with a way out (smaller retail slivers
   stay bed-walked as today, §2.1) inside the playable rectangle, plus **the sea up to 150 m past the bounds**
   (0.51 km² of it deeper than 1.2 m and connected to ground a player stands on; beds ≤ 20.6 m, all over emitted
   terrain) [confirmed: `domain.ts`, `factcheck/reach-out.ts`], **plus UNDERWATER's dive zones** (its S1 zone runs
   216 m out, §3.1). Past that a soft wall: "The current is too strong to swim further out." **A swimmer climbs out
   only onto ground the town already reaches on foot**: land outside the rectangle, and 1.2 km² of in-bounds land
   that no player can reach today, stay closed (§3.3).
5. **Swim clips on both skeletons, through the Blender moves pipeline.** Five clips per skeleton: `SWIM_IDLE` (tread),
   `SWIM` (breaststroke), `SWIM_FAST` (crawl), `SWIM_ENTER` and `SWIM_EXIT`, keyed by an extension of the town keyer
   (whole-body pitch about the chest, leg abduction, a floating root on a fixed waterline). **The prototype keyed SWIM
   and SWIM_IDLE on the male skeleton and re-expressed them with the production MV-A functions**: STAND1 control within
   0.0011° and 8e-7 m, pack vs Blender within 1.7e-5 m, loops closed to 1e-7 m, 47 channels, 0 joints unmapped in the
   game renderer, 31.8 KB brotli for both clips [confirmed: `pack.ts`, `roundtrip.json`, the S1 page]. GIF:
   `work/tmp/swimming/shots/swim_cycle_male.gif`.
6. **Speed and breath.** Swim 0.6 × the run speed (3.3 m/s); `SWIM_FAST` plays whenever a swim-speed bonus (a FISHING
   dish, a GM `/speed`) lifts it by 10 % or more. **Breath only when diving** [decision]: Space while swimming dives (in
   water ≥ 2.5 m deep, to at most 15 m, which reaches UNDERWATER's reef and shrine), 30 s of breath, a bar on the HUD; at zero the swimmer surfaces on his own.
   **No drowning, no death by water** [decision].
7. **Not while swimming:** skills, auto-attack, mounting (a rider's horse stops at the edge), stalls, starting or
   keeping a trade, sitting, emotes, jumping (Space is the dive), fishing, dropping items. Allowed: moving, potions and
   food, the return scroll, chat, party, NPC talk in range, picking up within reach (§7).
8. **Monsters never enter swim water**, the 11 Water Ghost nests whose discs reach into it included (level 6–7,
   passive; they lose their spawn points in swim water) [confirmed: `census2.ts`, `mobs.json`]. Aggressive monsters do
   not pick a swimmer as a new target; a chaser stops at the edge, still hits a swimmer within reach, and gives up when
   the swimmer is out of reach (the existing unreachable-target rule of `ai.ts`). **A monster that water keeps from its
   attacker evades** (every hit misses, it walks home), so a bow across a river is not a free kill (§8).
9. **The camera.** The eye may go under water: in water the orbit's pitch limit opens past the horizontal (today's
   1.5 rad keeps the eye at least 0.28 m above a swimmer's waterline, so it could never dip) [confirmed: code, §9.2]. A
   **waterline band** of ±0.35 m around the local wave surface keeps the eye out of the 9 cm near-plane sliver
   [confirmed: the S1 page]; the eye crosses it in one frame. **No split pass and no fog swap of our own**: under
   water the look (fog, sky backdrop, the surface from below) is UNDERWATER's `World.underwater`, on every preset
   (§9.3, §9.4).
10. **Server-authoritative, additive protocol, no DB migration.** A move that crosses a shore becomes up to three
    chained legs in one `move` message (`MoveState.mode`, `MoveState.next`); one new request (`dive`), two new fail
    reasons (`swimming`, `too_shallow`), `EntityState.swim`. Saved positions on old beds are lifted to the surface on
    login (§11).
11. **Cost:** no new draw for a swimmer; a splash/ripple emitter pool (≤ 2 draws); **no new GPU pass**; ≈ 50–80 KB
    brotli per skeleton for the five clips, ≈ 15 KB for `swim.bin` [projected from measurements]. "20 friends swimming
    off S1" ≈ 8–10 ms p95 on Medium WebGPU (≈ 12.5 late in a session), ≈ 7 on WebGL2, ≈ 12–14 on High WebGPU
    [projected from the wave-11 rescue bench]. Nothing changes at the plaza, so G1's thin scene is untouched (§13).

---

## 1. What exists today

### 1.1 Water and walking: the census [confirmed: `work/tmp/swimming/census.ts` on `work/out/world/jangan-fields`]

Method: every 2 m nav tile of the 247 playable regions (X 156–174 × Z 90–102); ground = the mean of the tile's four
`nav.bin` heights; water surface = the coast field's sea mask (→ the sea level, +5 m) or the region block's retail
water plane; open = `tileCells < openCellCount`.

| Depth of water over the tile | Open (walkable) | Closed |
|---|---:|---:|
| dry | 6.65 km² | 1.11 km² |
| 0–0.6 m | 65.6 k m² | 21.7 k m² |
| 0.6–1.2 m | 59.9 k m² | 28.9 k m² |
| 1.2–1.6 m | 31.9 k m² | 16.9 k m² |
| 1.6–3 m | 59.9 k m² | 42.1 k m² |
| 3–10 m | 503 k m² | 70.8 k m² |
| deeper than 10 m (to 58.5 m) | 402 k m² | 35.5 k m² |

- **Retail water is walked on its bed.** 997 k m² of open bed lies under more than 1.2 m of retail water (the lake that
  opens into Jangan Bay, the western river, the south channel, the swamp ponds, the town's ponds). That is the retail
  rule (NAVIGATION §2: "Water is not a walking surface and not a blocker") [confirmed: data].
- **The coast's sea is closed past knee depth.** Of the S1 sea inside the bounds, every tile deeper than 0.6 m is
  closed (0.6–1.2 m: 24.3 k m² closed, 0 open) [confirmed: census `bySource.sea`], by `NAV_KNEE_DEEP_M = 0.4` in
  `packages/convert/src/world/coast/navgen.ts` (lines 23–24, "a height patch's sea more than knee-deep closes") [confirmed: code].
- **The editor closes new water deeper than 1.2 m** "until swimming exists (wave 13)" (WORLD_EDITOR §4.8, D30, D40)
  [confirmed: doc].
- **One flat surface per body.** Of 572 k pairs of adjacent tiles deeper than 1.2 m, none differs in water surface
  height: retail planes step only where the water is shallow or absent, and the lake meets the sea level without a
  step [confirmed: `factcheck/steps.ts`]. So a swimmer never drops a step between 32 m blocks.
- **Where the beds are.** 0.82 km² of the 1.0 km² of open deep bed is in the town's walkable component (`MeshNav`'s
  home, the only one players are placed in); the rest is in components nobody reaches today [confirmed:
  `factcheck/bed-comp.ts`].
- **Bodies.** The tiles deeper than 1.2 m form 152 four-connected bodies: 2 over 10,000 m² (the lake + rivers system,
  1.01 km²; the south channel, 89 k m²), 17 of 1,000–10,000 m² (swamp ponds, the lake south-east of town, the pond at
  (89, −372)), 20 of 300–1,000 m² (the palace pond at (98, −87), 608 m²), and **113 slivers under 300 m², 7.2 k m² in
  all** (deep holes along banks) [confirmed: `components.json`]. Map: `shots/inbounds-water-census.png` (blue = swim,
  open bed today; purple = swim, closed bed; light blue = wade; dark = closed dry).
- **Monsters in deep water.** Of the 805 in-bounds nests, 11 have a centre deeper than 1.2 m or a quarter of their spawn
  disc in it, **all of them `MOB_CH_WATERGHOST` / `_CLON`** in the swamp (centres 1.2–2.1 m deep; 8–69 % of each disc
  is swim water, the other ten under 36 %) [confirmed: `nests-in-water.json`]. Both are level 6–7, passive, reach
  1.6 m [confirmed: `work/out/data/mobs.json`].
- **The shores** [confirmed: `factcheck/banks.ts`, the 39 in-bounds bodies ≥ 300 m²]: of 9,559 swim-tile edges that
  touch open ground, 8,995 (94 %) touch wade water, 367 dry ground at most 0.6 m above the surface, and **197 (2 %) a
  dry bank more than 0.6 m high** (16 of them over 3 m). **Four bodies (1,920 m² at (89, −372), 1,072, 892 and 384 m²; 4.3 k m²) touch no open
  terrain at all**: their banks are closed tiles or object surfaces (quays), so nobody could climb out of them.
- **S1.** Along x = 480 (the `beach-south` place) the water reaches 1.2 m at z ≈ 1327 and the bounds line (z 1344) at
  ≈ 1.7 m; it is 13.1 m deep 186 m out [confirmed: `census2.ts` profile]. S1 reaches town through the coast's
  `openTiles` link over the south ridge [confirmed: `content/coast/coast.json`].

### 1.2 Beyond the bounds [confirmed: `work/tmp/swimming/domain.ts` on the coast field]

| Band past the playable rectangle | Sea | Deeper than 1.2 m | Bed over 12 m | Max bed | Without terrain | Without nav | N / S / E / W |
|---|---:|---:|---:|---:|---:|---:|---|
| 64 m | 0.22 km² | 0.21 | 0.01 | 20.6 m | 0 | 0.08 | 92 / 111 / 0 / 13 k m² |
| 100 m | 0.35 | 0.33 | 0.05 | 20.6 | 0 | 0.13 | 149 / 174 / 12 / 18 |
| **150 m** | **0.66** | **0.56** | **0.12** | **20.6** | **0** | **0.20** | **254 / 277 / 109 / 24** |
| 192 m | 0.96 | 0.83 | 0.21 | 28.0 | 0 | 0.26 | 354 / 367 / 208 / 30 |

Every sea texel within 192 m lies in an **emitted** region (terrain exists) but up to 0.26 km² of it in synthetic
regions **without nav**, so the swim layer cannot come from `nav.bin` alone there: it reads the terrain bins and the
coast field (§2.2). Map: `domain-map.png`.

**Fact-check: the table counts every sea texel, not what a swimmer reaches.** Of the 150 m band, 0.56 km² is deeper
than 1.2 m, and **0.51 km² of that is connected** (4-adjacent through deep sea) to in-bounds ground or water a player
can stand on: N 221 k, S 262 k, W 23 k, **E 0** of 50 k m² [confirmed: `factcheck/reach-out.ts`]. The north band
touches open in-bounds ground along the north bounds line, so it is a second sea coast to swim from, not only S1.

### 1.3 Movement, camera, ocean and sound

- **Movement** is click-to-move only; the server runs one straight `nav.walk` from its live point to the
  bounds-clamped target and stops at the first blocking edge; `move {from, to, speed, startedAt}` and `stop`; 10 Hz
  tick; 5.5 m/s [confirmed: `apps/server/src/world.ts` `walkEntity` 753–774, `clamp` 727–733 at HEAD; MOVEMENT §4.1]. The
  walk already returns multi-leg paths on object surfaces (`walk.legs`) [confirmed: world.ts 771]. The same
  `walkEntity` also runs every *approach* (walk to a mob to attack, to an item, to an NPC: `gameplay.ts` 1246,
  `npc.ts` 227) and every mob move [confirmed: code].
- **Locks** are module gates: `MOUNTED_REFUSED` (mounts.ts 60, now including `jump`), `STALL_ALLOWED` (social/stall.ts
  42), `TRADE_ALLOWED`, `FUSE_CANCELLERS` (alchemy.ts 41); modules register in `gameplay.ts` 341–351 with the jump's
  `movement` module last before uniques [confirmed: code].
- **Mob AI**: a chase whose move is refused at once drops the target (`ai.ts` 230–233); with no other attacker it goes
  `return`, where every hit on it misses until it is restored at home (`gameplay.ts` 981, the anti leash-kiting rule);
  leash by home distance [confirmed: code]. Mob moves are straight lines, never path-found [confirmed: `ai.ts`].
- **Client**: an entity's root sits on `WorldGround.heightAt` (`apps/game/src/world/entities.ts` 549); the camera is an
  ArcRotate (radius 2.5–40, beta 0.25–1.5, minZ 0.2, fov 0.85: `screens/world.ts` 122–128) whose target is the feet
  + 1.5 m × `heightScale` (`screens/world.ts` 781, 862), with a ground clamp that only shortens the radius
  (`world/jangan/camera.ts`) [confirmed: code].
- **Water queries exist**: `World.waterLevelAt(x, z)` (sea, else the retail plane; `packages/world-render/src/world.ts`
  795 at HEAD, 919 in wave 12's tree) and the ocean's
  `waveHeightAt(x, z)` (worker-FFT tile or Gerstner, attenuated in shallow water; `ocean/ocean.ts` 177) [confirmed:
  code; the prototype floats the swimmer on it].
- **Sounds**: retail has water footsteps (`player/mvwalkwater.ogg`, `mvrunwater.ogg`) and a `Water` step surface used
  by the jump; no swim sound exists [confirmed: `work/out/sound/index.json`].
- **The moves pipeline**: `content/moves/<skel>/*.json` → `packages/convert/tools/blender/moves/key_moves.py` (jump) and
  `tools/blender/town/key_town.py` (every-frame cyclic keys, used for the town clips) → `export-moves.ts` /
  `town-clips.ts` re-expression → packs [confirmed: code]. The swim keyer extends the town keyer (§4.2).

---

## 2. The water rule and the swim layer

### 2.1 Classes [decision SW-D1, SW-D2]

| Class | Depth `d` = surface − bed at the tile | Who moves there | How |
|---|---|---|---|
| none | `d ≤ 0` or no water | everyone | nav as today |
| **wade** | `0 < d ≤ 1.2` (`SWIM_DEPTH_M`), **or** any depth in a *retail* body under 300 m² or without a way out | players and monsters | nav as today (walk, run speed); splashes, water steps |
| **swim** | `d > 1.2` in a body ≥ 300 m² with a way out, the sea, or any editor water | **players only** | the swim walker; at the surface; swim speed |
| **swim + dive** | swim and `d ≥ 2.5` (`DIVE_MIN_DEPTH_M`) | players | as swim; Space dives (§6) |

- **Why 1.2 m:** it is the editor's existing line (D30), it puts the waterline at mid-chest (a waded tile never hides
  the head), and the coast's beach profiles reach it 30–40 m from the waterline at S1 (z 1290 → 1327), a natural
  "walk in, then swim" distance [confirmed: profile]. One constant in `packages/shared/src/swim.ts`, used by the
  converter, the coast navgen, the editor's nav rule, the server and the client.
- **Why 300 m²:** the 113 slivers below it are holes and bank pockets 2–17 m across; swimming three strokes across a
  hole in a river bank and walking on is noise. They keep the retail bed walk. **Pruning applies to retail water only**
  (its beds are open in `nav.bin`): a sea body is never pruned, and neither is editor water, whose tiles deeper than
  1.2 m the editor's nav rule closes (D30), so a pruned editor sliver would be neither walkable nor swimmable
  [fact-check]. The client lifts a waded character so
  his head stays out of a sliver up to 0.5 m deeper than the wade line (visual only, §10.1) [decision SW-D3].
- **Waves never change the class.** The class is geometry (the still surface); waves move only the drawn swimmer and
  the camera. So the server needs no hysteresis, and the client's visual transition uses the class boundary plus a
  0.15 m blend [decision].
- **The shore step and a way out** [decision SW-D24; fact-check]. A swimmer crosses from a swim tile to land (and from
  land into a swim tile) only over a tile edge whose land side is wade water or dry ground at most **0.6 m**
  (`SWIM_STEP_M`) above the still surface, and whose land side is in a walkable component the town reaches today
  (§3.3). Elsewhere the shore is a wall for the swim walker and for the walk → swim chain. 94 % of today's shore
  edges are wade and 98 % pass [confirmed: §1.1 shores]. A retail body with no passing edge (the four quay-bound
  bodies of §1.1, 4.3 k m²) stays **wade** (bed walk as today) instead of becoming a trap; the converter applies the
  same rule the editor's Publish stop does (§2.5).

### 2.2 The builder: one pure function

`packages/shared/src/swim.ts` (new, node-free):

```ts
export const SWIM_DEPTH_M = 1.2          // wade <= this < swim (WORLD_EDITOR D30's line)
export const SWIM_MIN_BODY_M2 = 300      // smaller deep bodies stay wade (retail bed walk)
export const DIVE_MIN_DEPTH_M = 2.5
export const SWIM_OUT_M = 150            // the sea past the playable rectangle that is swimmable
export const SWIM_WATERLINE_M = 1.4      // the swim clips' waterline above the feet line (× heightScale)
export type SwimClass = 0 | 1 | 2 | 3    // none, wade, swim, swim+dive
/** Per region: the 96 x 96 tile classes from the four tile-corner bed heights and the water surface over the tile. */
export function classifyRegion(input: SwimRegionInput): Uint8Array
export const SWIM_STEP_M = 0.6           // the highest dry shore a swimmer climbs out on (fact-check, SW-D24)
/** The 4-connected bodies of swim tiles across regions; retail bodies under SWIM_MIN_BODY_M2, and retail bodies with
 *  no exit onto a home-reachable component (SW-D24, §3.3), -> wade. Sea and editor bodies are never pruned. */
export function pruneBodies(layer: SwimLayerDraft, exits: SwimExitTest): void
```

Inputs, per region, all already in the converter at the nav step [confirmed: WORLD_EDITOR §6.3 names them]:

1. bed heights: the terrain bin of the region (in-bounds regions: equal to the nav heights, the coast rewrites all four
   copies, COAST §3.5; synthetic ring regions: the terrain bin only);
2. the water surface over each tile: the coast field's sea mask → `seaLevelM`; else the block's retail water plane
   (`blocks[].water`, kind `water`, not ice); else the editor's water layer (`content/world-edits/**`, WORLD_EDITOR
   §4.8);
3. the swim domain: the playable rectangle, plus sea tiles (field R ≥ 128) within `SWIM_OUT_M` of it;
4. overrides: `content/swim/swim.json` `noSwim` / `forceSwim` rectangles (authored, rare; the editor writes them, §2.5);
5. UNDERWATER's dive-zone polygons (its S-ZONES content) join the swim domain (§3.1);
6. the walkable components of the land nav (`NavReach`) and the town's home component, for the exit rule (§3.3).

**Where it runs.** In the converter, after the nav step and the coast pass, before the placement passes (the editor's
order, WORLD_EDITOR §6.3 step 4) [decision]. Output: `swim.bin` + `manifest.swim`. The **domain** alone (rectangle +
150 m of sea + the dive zones) is a function of the coast field and the zones, so it exists *before* terrain
emission: UNDERWATER's bed-region rule ("every region that touches a dive zone, dilated by 64 m") reads the domain,
not `swim.bin`, which avoids a converter cycle [fact-check].

### 2.3 Format [decision SW-D4]

```
swim.bin  "SRSW" u32 version=1, u32 regionCount, per region: u16 id (z<<8|x), u8 flags (bit0: has sea), u8 pad,
          f32 surface[36] (6 x 6 blocks, metres, NaN = none; the sea's tiles use seaLevelM), u8 classes[2304] (2 bits/tile),
          u8 noExit[1152] (1 bit/tile: a land tile next to swim water that fails SW-D24 / SW-D25; fact-check)
```

- Only regions with any water are listed: 101 inside the bounds, about 40–60 in the 150 m ring [projected from
  `domain.json`]. Measured for the in-bounds part: **232,704 B raw, 9,174 B brotli** [confirmed: `census.ts`
  `SWIMLAYER`; fact-check: that encode holds the class bytes only, three classes with no dive bit, and no region
  header or surfaces]; the header and surfaces add 148 B per region (≈ 15 KB raw for 101 regions); with the dive bit
  and the ring ≈ 15 KB brotli [projected].
- **One file for both sides**: the server reads it at boot next to `nav.bin`; the client fetches it once at world load
  (it is smaller than one nav chunk). No streaming [decision: 15 KB does not need chunks].
- `manifest.swim = { file: 'swim.bin', version: 1, swimDepthM: 1.2, outM: 150, sourceHash }` (additive; an old client
  ignores it).

### 2.4 What changes in the coast and the nav

- **The coast's knee-deep rule becomes the wade rule.** `NAV_KNEE_DEEP_M` (0.4) is replaced by `SWIM_DEPTH_M` (1.2) for
  the in-bounds height-patch sea (S1 and the S2 patch): those tiles open for walking down to 1.2 m, and deeper ones stay
  closed in `nav.bin` and become swim tiles. Without this, S1 would have a 0.4–1.2 m band that is neither walkable nor
  swimmable between the sand and the swim water [confirmed: census, 24.3 k m² of closed 0.6–1.2 m sea]. Outside the
  bounds the coast's openness rule changes the same way, but those tiles are still never walked (the land clamp,
  §3.2) [decision SW-D5].
- **Retail beds deeper than 1.2 m stay open in `nav.bin`** (the file is not rewritten) but the walker treats a swim tile
  as closed for walking (§5.2). Removing them from `nav.bin` would change 98 regions' chunks for nothing [decision].
- **Reachability is computed with swim tiles traversable for players and closed for monsters** (§2.5 checks, §8).
- **Where the mask lives** [fact-check]. The land walker's tile test is private to `NavWorld`
  (`packages/nav/src/world.ts` `tileState`, used by `terrainLeg`), so "a swim tile is closed for walking" is a small
  hook there: an optional per-world tile mask plus a per-call flag that ignores it (waterborne movers, a wave-14
  hook). `NavReach` gets the same mask for the monsters' components. Wave 12 is editing `world.ts` (`editInstances`,
  the editor's walk preview), so SW-P lands the hook after wave 12's final commit, and the editor's walk preview
  reloads the mask with the layer.
- **The leg seam.** A walk stopped by the mask ends `NAV_TILE_BACKOFF` short of the swim tile, on wade or dry
  ground; the swim walker accepts a start within that distance of a swim tile (its first step crosses the edge).

### 2.5 The world editor: "swimmable, not walkable"

WORLD_EDITOR D30 ("tiles under new water deeper than 1.2 m close until swimming exists") and D40 step 2 change as
follows [decision SW-D6; the edit lands with the editor lane of wave 13, not in wave 12's files]:

1. The nav rule keeps closing a tile under new water deeper than 1.2 m **for walking** (unchanged code path).
2. The editor's incremental convert calls the same `classifyRegion` + `pruneBodies` for every touched region and its
   neighbours (a body can cross a region border) and re-writes `swim.bin`; the full convert must produce the same bytes
   (a G7-style equality test).
3. The existing checks 2–4 ("nobody trapped", "everything that was reachable still is", gates and roads) run on the
   **player** graph (swim tiles traversable, the exit rule of SW-D24), so a new pond across a path does not stop the
   publish by itself; nests are checked on the **monsters'** graph (swim closed). Publish checks gain three rows:
   - **"A way out"** (stops the publish): every swim body inside the bounds has at least 4 m of shore that passes
     SW-D24 (wade, or dry ≤ 0.6 m above the surface, in the town's component) ("This pond has no shore you can climb
     out on");
   - **swim reachability** (warns): places that were reachable on foot and are now reachable only by swimming are
     listed (a new pond across a path);
   - **monsters** (warns): nests whose spawn disc is more than 25 % swim water.
4. The Water tool's panel shows the result live: "Swimmable (deeper than 1.2 m)" / "Wading" tinting on the pond, and a
   "No swimming here" toggle that writes `noSwim` for that block.

### 2.6 Migration

- **No DB migration** [decision SW-D7]. The swim state is derived from the position; nothing new is saved.
- **Saved positions.** A character saved on a retail bed under deep water (walking the lake floor today) logs in at
  that x, z **treading water at the surface** (`entryPoint`: if the saved tile is a swim tile, place at the surface
  with `swim = 'surface'`); one saved past the bounds in the swim band stays there. Covered by a server test row.
- **Data.** A re-convert ships `swim.bin`, the S1/S2 nav chunks with the 1.2 m wade line, and the manifest field. Like
  every world change it goes out with a server restart and the deploy note's "reload" (COAST §9.3).
- **An old client** (a page left open across the deploy) ignores `MoveState.mode` and draws a swimmer walking on the
  bed; the deploy restarts the server and forces a reconnect, so this lasts until the reload [likely].

---

## 3. The bounds: how far out to sea

### 3.1 The swim domain [decision SW-D8]

- **Inside the playable rectangle**: every swim body (§2.1).
- **Outside it**: sea tiles (field R ≥ 128) within **150 m** of the rectangle, connected to in-bounds water or ground.
  - 0.66 km² of sea texels, 0.56 km² deeper than 1.2 m, **0.51 km² of that connected** (N 221 k, S 262 k, W 23 k, E 0
    of 50 k m²) [confirmed: `domain.json`, `factcheck/reach-out.json`]; beds ≤ 20.6 m; every texel over emitted
    terrain, so the seabed is always there for UNDERWATER to draw [confirmed: `domain.json`].
- **Plus UNDERWATER's dive zones** [decision; fact-check]. UNDERWATER's default S1 zone is x 400–960, z 1290–1560
  (216 m past the bounds line), its shrine lamp stands at z 1520 (176 m out) and its reef is 8–14 m deep
  (UNDERWATER §2.1 S-ZONES, §3.3). A 150 m band alone would put the shrine behind the soft wall, so the domain is the
  band **∪ the zone polygons**, and `DIVE_MAX_M` is 15 m (§6). The zones are content (UNDERWATER's file); the
  builder reads them; the bed-region rule reads the domain (§2.2).
  - Why 150 m: the next step (192 m) adds beds to 28 m and 0.26 km² without nav for little more sea; 150 m is about
    40 s of swimming out from S1's bounds line, far enough to feel open water, near enough that the stream radius
    (400 m Medium) always holds the beach behind [projected].
- **The ocean's far cut is not the limit.** The CDLOD ocean draws to the fog cut (`fogCut`, ≤ 250 m fog end) and the
  coast field covers 576 m past the bounds [confirmed: `ocean.ts` 244, COAST §2.2], so a swimmer at the edge still sees
  sea all round.

### 3.2 The edge

- The swim walker stops at the domain edge (a blocking edge like any other) and the client shows **"The current is too
  strong to swim further out."** (at most once per 10 s) [decision].
- **Land outside the rectangle stays look-only** (COAST §9.4). A swimmer who reaches an outside beach stops at the
  water's edge with "You can't go ashore here." The land walker treats every tile outside the rectangle as closed; the
  swim walker treats an outside non-swim tile as closed.
- `World.clamp` changes for players only: a target is clamped to the **swim domain's box** (the rectangle + 150 m, grown to the dive zones) when
  the move starts in water or its straight line enters water; otherwise to the rectangle as today. The walkers then
  enforce the exact shape [decision SW-D9].
- No visual buoy line in v1 (no retail model; §20 Q6).

### 3.3 Swimming must not open land nobody reaches today [decision SW-D25; fact-check]

The first draft let a swimmer climb out on any walkable shore inside the rectangle. Measured on the server's own nav
(`MeshNav` components, the town spawn's home component, the shore rule of SW-D24), that **joins 61 walkable
components with 1.22 km² of land to the town**; of the 12 largest (1.21 km²) the town reaches none on foot today
(`componentReaches(home, c)` false for all; three small ones, 4.4 k m², reach the town one way) [confirmed:
`factcheck/swim-reach.ts`, `comp-reach.ts`]:

| Component | Land | Where (a sample point) | Reached today |
|---|---:|---|---|
| 1 | 0.995 km² | west of the lake system, around (−1259, −697) | no |
| 2 | 0.157 km² | the west bound, around (−2493, 383) | no |
| 5, 6 | 27 k, 24 k m² | (−579, 1347) on the south bound; (−955, −909) by the lake | no |
| 57 others | 15 k m² | banks and islands | no (3 one-way out) |

They hold **121 nests of level 19–30 monsters**: Chakji (20) and Chakji Worker (19), Hyungno Ghost Soldier (23) and
Ghost (24), Ghost Bug (21), Devil Bug (22), Earth Ghost (27), Meek Gun Powder (27), Earth Taoist (30)
[confirmed: `work/out/data/mobs.json`]. That is 18 % more playable land (home: 6.62 km²), past the level cap of about
20, opened by a movement feature; it is wave 14's question ("The Climb" re-tunes levels 1–20), not swimming's.

**The rule:** a swimmer may climb out only onto a component the town reaches today (`componentReaches(home, c)`,
which also keeps every saved position and placement inside `MeshNav`'s home pin). The shores of every other component
are walls to the swim walker, with "You can't go ashore here." (the outside-land toast). The builder computes the
list; SW-C's report prints it (area, sample point, nests and their levels), and a `content/swim/swim.json`
`openShore: [componentSample]` row opens one deliberately (a wave-14 hook). The lake, the rivers and the sea bands stay
fully swimmable; only the far banks stay closed.

---

## 4. The swim clips

### 4.1 The clip set [decision SW-D10]

| Kind | What | Length | Loop | Notes |
|---|---|---|---|---|
| `SWIM_IDLE` | treading water: upright, eggbeater legs, sculling hands | 1.6 s | yes | standing still in swim water; **prototyped (male)** |
| `SWIM` | heads-up breaststroke | 1.2 s | yes | every swim move; also under water while diving; **prototyped (male)** |
| `SWIM_FAST` | front crawl with a body roll | 1.0 s | yes | when the swim speed is ≥ 1.1 × the base (§5.4) |
| `SWIM_ENTER` | from a wading run: lean forward and push off into the first stroke | 0.6 s | no | the walk → swim leg boundary |
| `SWIM_EXIT` | feet find the bed, rise to standing, first wading step | 0.7 s | no | the swim → walk boundary |
| `DIVE` (optional) | duck dive: head down, hips up, one kick | 0.6 s | no | not needed: SWIM with the root pitched (§6); cut 3 drops diving |

- **Both skeletons**: `europeman_skel` and `europewoman_skel` (26 Chinese models; MOVEMENT §0). Ten clips (twelve with
  `DIVE`).
- **One set per skeleton, no per-weapon variants**: the weapon and shield are **hidden while swimming** (their
  attachment nodes `setEnabled(false)` on the actor; shown again on the exit leg) [decision SW-D11: a glaive or a bow
  through a stroke clips the body, and nobody fights in water].
- Retail has nothing to reuse: no Chinese `.ban` is a swim (MOVEMENT §1's 536-file inventory has no swim, wade or
  float) [confirmed: MOVEMENT §1.1].

### 4.2 The keyer: an extension of the town keyer

The prototype `work/tmp/swimming/key_swim.py` subclasses `key_town.TownRig` (every-frame cyclic Catmull-Rom keys,
absolute limb angles, open hands, the loop-frame copy) and adds three things [confirmed: it runs headless in Blender
5.2.2 in 11 s for two clips]:

1. **Leg abduction**: a fifth leg value, applied about the forward axis before the sagittal aim (as the arms do), for
   the frog kick's knees-out and the eggbeater.
2. **Whole-body pitch (and roll)**: after the body is posed upright, the root bone `Bip01` turns about the chest
   (`Bip01 Spine1`'s head) by `pitch` (and about the pelvis→neck axis by `roll` for the crawl). So every limb angle
   in the key file stays a **body-frame** angle: a horizontal swimmer is keyed like a standing man.
3. **Lock `float`**: no ground contacts; each frame the root is moved so `Bip01 Neck` sits `float` metres above a fixed
   waterline (`waterlineM` above the idle's feet line) and `Bip01 Spine` stays over the origin plus a fore-aft `surge`
   (the glide's push).

Key file schema (`content/moves/<skel>/swim/<clip>.json`; the prototype's are `work/tmp/swimming/keys/*.json`):

```
clip, kind (SWIM_IDLE | SWIM | SWIM_FAST | SWIM_ENTER | SWIM_EXIT | DIVE), fps 30, lastFrame, loop, waterlineM (1.40),
keys [{ f, pose, pitch, roll?, lean, side?, twist?, head, headYaw?, float, surge?,
        legs {L,R: [thigh, knee, foot, toe, abduct]}, arms {L,R: [swing, elbow, abduct]}, hands? {L,R: [open, palm]} }]
```

The non-looping ENTER/EXIT clips key from the RUN base at a named phase (the jump keyer's `RUN@<phase>` bases) for the
first frames and blend the float lock in (`floatWeight` per key, 0 = planted contacts, 1 = float) [decision; not
prototyped, §20 Q2].

### 4.3 The prototype result (male skeleton) [confirmed: `out/man/swim_keys.json`, `roundtrip.json`, the shots]

| Check | SWIM | SWIM_IDLE |
|---|---|---|
| Frames / length | 37 / 1.20 s | 49 / 1.60 s |
| Channels, raw bytes | 47, 27,380 B | 47, 36,260 B |
| Neck above the waterline | 0.03–0.13 m | 0.12–0.15 m |
| Head joint above the waterline | 0.04–0.15 m | 0.21–0.24 m |
| Deepest toe below it | 0.48 m | 1.29 m |
| Hands above it | −0.04 … +0.12 m (in and out of the water) | −0.06 … +0.04 m (sculling at the surface) |
| Loop closes | 1e-7 m, 8e-6° | 2e-8 m, 4e-6° |
| Root XZ excursion | 0.08 m (the surge) | 0.003 m |
| Largest joint turn per frame | **30.5° (L hand, frame 16)** | 8.2° |
| Pack vs Blender export | 1.7e-5 m | 1.7e-5 m |

- **The production checks pass** except the town keyer's 25°/frame flip limit on SWIM: the left hand's palm roll
  (−110° → −20° over five frames at the breathe pose) whips. Touch-up 1 for SW-A: spread the palm key over the pull
  (§20 Q3).
- STAND1 control through the same import/export: **0.0011°, 8.0e-7 m over 70 samples**; the pack: 90,420 B raw,
  **31,820 B brotli** for both clips [confirmed: `pack.ts`, `br.ts`].
- **In the game renderer**: the pack retargets onto `chinaman_adventurer.glb` by joint name with **0 unmapped**, plays
  at S1 on the real ocean (WebGPU Medium and WebGL2 Low) [confirmed: the S1 page HUD].
- **Look**: `shots/swim_cycle_male.gif` (side + three-quarter, 30 fps), `shots/swim_idle_male.gif` (front + side),
  `shots/swim_filmstrip_male.png` (six SWIM poses side and front, six SWIM_IDLE poses). The glide, the pull with high
  elbows, the breath with the chest up, the knees-out kick and the shoot read clearly; the tread's arms are wide (a
  touch-up: sculling closer to the body, §20 Q3).
- The female skeleton is not keyed in the prototype. The jump's standing key file transferred to her unchanged
  (MOVEMENT §3.3), and the swim clips have no ground contacts to break, so the same key files are expected to transfer
  [likely]; SW-A keys and checks both.

### 4.4 The production tool [decision SW-D12]

- `packages/convert/tools/blender/swim/key_swim.py` (the prototype, cleaned; imports `key_town` and `key_moves`) and
  `packages/convert/src/tools/swim-clips.ts` behind `pnpm sro moves --swim` (the `--town` precedent): keys both
  skeletons, re-expresses with `export-moves.ts`'s `retarget` / `reexpressClip` / `buildMovementPack`, runs the checks,
  writes `char/_anims/<skel>/swim.glb` + `swim.json` (`SwimIndex`: per kind the animation, duration, loop,
  `waterlineM`).
- **Checks** (exit 1 on a failure): the STAND1 control (0.1°, 1e-5 m); pack vs export (0.1 mm); loops close (0.1 mm,
  0.1°); no joint turns more than 25° between frames; the neck stays 0–0.2 m above the waterline on every looping
  frame; no toe deeper than 1.4 m under it; root XZ excursion ≤ 0.15 m; each clip ≤ 60 KB raw. The tread's toes reach
  1.29 m under the waterline [confirmed: §4.3], so in the shallowest swim water (1.2 m) they would touch the bed: the
  client lifts the root by any such overlap (≤ 0.1 m), which reads as toes brushing the sand.
- **A separate pack** (`swim.glb`, not inside `movement.glb`) so MV-A's file and checks stay untouched; it is fetched
  after `worldEnter` like the movement pack and only by the world screen (MOVEMENT §6.1's rule) [decision].
- Hand edits in the Blender UI are read back with `extract_deltas.py`'s approach (body-frame angles after removing the
  pitch) [likely: one function to add].

---

## 5. Movement in water (server)

### 5.1 The legs [decision SW-D13]

A `moveTo` from a player runs, in `World.walkEntity`. **Only a plain `moveTo` swims** [decision; fact-check]: the
approach moves that share `walkEntity` (to a mob to attack, to an item, to an NPC: `gameplay.ts` 1246, `npc.ts` 227)
and every mob move stay walk-only and stop at the shore, so an attack approach never ends in water where attacks are
refused (§7).

1. Classify the start: on a swim tile (and on the terrain surface, not an object deck) → **swim mode**, else walk.
2. Walk mode: the land walk as today, with **swim tiles closed** (and every tile outside the rectangle closed). If it
   stops on the edge of a swim tile, the edge passes the shore step (SW-D24) and the target lies further along the
   line, the leg ends at that edge point and a **swim leg** continues from it toward the target.
3. Swim mode: the **swim walker** (§5.2) from the live point toward the target; it stops at the first tile that is
   neither swim nor (for the exit) walkable wade/dry ground that passes SW-D24 and SW-D25. If it stops on the edge of
   such a tile inside the rectangle and the target lies further along, a **walk leg** continues.
4. At most **three legs** per move (walk → swim → walk crosses a river in one click). A fourth transition ends the move;
   the player clicks again (rare: an island in a lake).
5. The legs go out in **one** `move` message: `MoveState` gains `mode?: 'swim' | 'dive'` and `next?: MoveState` (§11).
   Each leg's `startedAt` is the previous leg's exact arrival time, so clients interpolate the chain with no pause; the
   server's `arrive` starts the next leg at that time (not at the tick), so server and clients agree to the
   millisecond.

### 5.2 The swim walker (`packages/nav/src/swim.ts`)

- A 2D DDA over the 2 m tile grid along the segment (the cell walker's method, NAVIGATION §6.2); passable while the
  tile class is swim (2 or 3) and inside the swim domain (an exit onto land is allowed unless the land tile's
  `noExit` bit is set: the builder bakes SW-D24 and SW-D25 into that bit, so neither walker asks the nav), and no **solid object** stands there at the surface height
  (`MeshNav.insideSolid(x, z, surface − 0.5)`: bridge piers, moored hulls, a pier's piles) [decision].
- Bridges and piers over water: a deck's object surface is above the swimmer; the swimmer passes under it (only solid
  footprints block) [decision: the 2D position under a deck is fine; the y differs by more than 2 m].
- Cost: a 100 m swim crosses ≈ 70 tiles, each a byte read and a grid lookup: microseconds [projected].
- The client's prediction guard (`navCovers`) and its click marker use the same walker on the same `swim.bin`.

### 5.3 Surfaces and heights

- `NavSurface` gains `{ kind: 'water' }`; `heightOn({kind:'water'}, x, z)` = the tile's still surface (the swim layer's
  block surface); `p.pos[1]` of a swimmer is the still surface. Waves are client-only [decision].
- `livePoint`, `standAt`, `halt` keep working: a swimmer's surface key is `'water'`.
- Teleports (`/tp`, warps) never place a player in water unless the target itself is a swim tile (`nav.place` with the
  mask finds the shore; a GM `/tp` onto open water starts treading).

### 5.4 Speeds [decision SW-D14]

| Mode | Speed | Clip |
|---|---|---|
| walk / wade | `moveSpeed × speedMul` (5.5 m/s) | the actor's RUN (WALK in town routes) + wade splashes |
| swim | `0.6 × moveSpeed × speedMul × swimMul` = **3.3 m/s** | `SWIM`, or `SWIM_FAST` when `speedMul × swimMul ≥ 1.1` |
| dive | `0.8 ×` the swim speed (2.6 m/s) | `SWIM` with the root pitched by the vertical speed |

- `swimMul` is a new per-player multiplier (1 by default) fed by effects (FISHING's dishes, §12.1; wave 14's hooks).
- **No wade slowdown** [decision]: one speed per walk leg keeps `MoveState` simple; wading reads through the splashes
  and the water steps.
- Why 0.6: a 30 m crossing takes 9 s instead of 5.5 s, a felt cost without being a chore; the 1 km lake crossing
  takes ≈ 5 min instead of 3 [projected arithmetic].

### 5.5 Getting in and out

- **From the shore**: walk in; the walk leg ends at the first swim tile; `SWIM_ENTER` plays over the first 0.6 s of the
  swim leg. **Out**: the swim leg ends at the first walkable tile; `SWIM_EXIT` plays over the first 0.7 s of the walk
  leg.
- **From a pier or a deck** (FISHING builds the pier): a click on swim water from an object surface within 4 m of its
  outline edge and at most 4 m above the water drops the player in: the server accepts the move as a `drop` leg (0.5 s,
  no nav edge check, the landing tile must be a swim tile) and `SWIM_ENTER` plays with a splash [decision SW-D15;
  cut 1].
- **Back onto a pier**: ladders: authored exit points `content/swim/swim.json` `exits: [{x, z, to: {x, y, z}}]`; a swim
  move that ends within 1.5 m of an exit continues as a 1.0 s `climb` leg to the deck point [decision; cut 1]. The
  FISHING spec places them with the pier.
- **Mounted**: a rider's walk leg stops at the swim edge, the move ends, toast "Your horse won't go into deep water."
  (no swim leg) [decision SW-D16]. Dismount first, then swim; the horse stays parked at the shore.
- **Logout in water**: the position is saved; login places the character treading at that spot (§2.6). A dive is not
  saved (surface on login).

---

## 6. Diving, breath, drowning

- **Breath only when diving** [decision SW-D17]. Surface swimming has no stamina, no breath, no timer: the friends
  swim as long as they like.
- **The dive.** Space while swimming sends `dive` (a toggle). Accepted on a swim + dive tile (≥ 2.5 m) when not on
  cooldown; refused `too_shallow` otherwise. The swimmer descends at 1.2 m/s toward the **dive line**
  `max(bed + 0.9 m, surface − 15 m)` (`DIVE_MAX_M` = 15: UNDERWATER's reef is 8–14 m deep and its shrine ≈ 13 m;
  10 m left both out of reach [fact-check]) and follows it while moving (rate-limited 1.2 m/s); Space
  again, or the end of breath, ascends at 1.8 m/s.
- **Breath:** 30 s (`DIVE_BREATH_MS`; `breathMul`, a FISHING dish hook). At the deepest line a diver is down after
  12.5 s and has 17.5 s at depth, over UNDERWATER's "no reward needs more than 15 s at depth" (S-BREATH); the ascent
  after the breath ends costs nothing [projected arithmetic]. A bar appears above the action
  bar while diving; it refills at 3 × the use rate at the surface. At zero: the server ends the dive, the client plays
  a short gasp at the surface, toast "Out of breath!", and the dive is on a 4 s cooldown. **No HP loss.**
- **No drowning, no death by water** [decision SW-D18]: a private friends' game; a drowning death would add a corpse in
  water, a revive-in-water rule and a fear of the sea for no gain. Breath is the only pressure, and it only limits a
  dive's length.
- **Authority**: the server keeps `p.swim = { mode: 'surface' | 'dive', diveAt, breathUntil }`; it computes when the
  diver is "down" (`diveAt + depth/1.2 m/s`) for UNDERWATER's interactions (e.g. "open the clam": within 3 m in XZ and
  down) and ends the dive at `breathUntil`. It exposes `swimDepthM(p, now)`, the diver's depth under the still
  surface from `diveAt`, the rates and the dive line under the live point: UNDERWATER's S-DEPTH asks for a server
  depth, and this gives it with no protocol field [fact-check: seam]. The vertical position itself is a client visual (§10.1): the server never
  needs a diver's exact y [decision].
- **Death while swimming** (a ranged monster at the shore): the DEAD clip plays and the body floats at the surface
  (root at surface − 0.3 m); "Revive here" revives treading; "Return to town" as today.

---

## 7. What is not allowed while swimming

The new `swim` gameplay module (`apps/server/src/swim.ts`) adds a gate, registered after `movement`, that refuses with
`swimming` [decision SW-D19]:

| Request | While swimming | Why |
|---|---|---|
| `useSkill`, `attack` | refused `swimming`; entering water stops auto-attack | no stance or weapon in water |
| `mountRide` / summon a horse | refused `swimming` | no horse in water (§5.5) |
| `stallCreate` | refused `swimming` | a stall needs ground |
| trade request / accept | refused `swimming`; **an open trade is cancelled** when either side's move enters swim water ("The trade was cancelled: you went into the water.") | the user's list; items should not change hands mid-swim |
| `sit`, `emote` | refused `swimming` | no clips |
| `jump` | refused `swimming` (Space sends `dive` instead on the client) | Space is the dive |
| fishing (FISHING's `fishCast`) | refused `swimming` | fish from land or the pier |
| drop an item | refused `swimming` | it would sink |
| `alchemyReinforce` | refused `swimming` | busy hands |
| moving, `dive` | allowed | |
| HP/MP potions, food (`itemUse`) | allowed | survival; cooking buffs (FISHING) |
| return scroll | allowed (the cast runs while treading) | a way home |
| chat, party, guild, whisper | allowed | a hangout |
| `npcTalk` | allowed in range | an NPC on the pier |
| `pickup` | allowed within reach (items never land in water, §8.3) | |

`FUSE_CANCELLERS` already cancels a fuse on `moveTo`; nothing to add [confirmed: alchemy.ts 41].

---

## 8. Monsters at the water's edge

### 8.1 Rules [decision SW-D20]

- **Monsters never enter swim tiles**: their walker is the land walker with swim tiles closed. A chase toward a swimmer
  stops at the edge.
- **In reach, they still hit**: a swimmer within a mob's reach (attack range + body radii, `ai.ts`'s `mobReach`) from
  the shore is attacked, ranged specials included (`AiHost.ranged`). Swimming near the shore is not a safe zone.
- **Out of reach, they give up**: the chase move is refused at once from the edge → `ai.ts` drops the target and takes
  the next or goes home (the existing branch at 230–233) [confirmed: code]. So a swimmer escapes a fight, as running
  past the leash does today; the mob returns home and regenerates as it does after any leash [likely: acceptable].
- **Aggressive monsters do not acquire a swimmer** as a new target (`playersNear` skips swimmers in the acquisition
  only) [decision: a wolf that charges a swimmer it can never reach only runs to the shore and back].
- **Water keeps a monster from its attacker → it evades** [decision SW-D23; fact-check]. Players attack from 18 m
  with a bow (weapon range 180 dm) and skills reach 15 m [confirmed: `weapons.json`, `skills.json`], and a mob's
  chase is a straight walk. Across a river, a pond or a lake arm the mob would run to the edge taking free hits, be
  refused, go home evading and come back restored, and a volley that kills it inside that window would be a free kill
  (a bot's dream, with level 19–30 monsters on the far banks, §3.3). So when a player damages a mob that is not in
  reach and whose **monsters' component does not contain the player while the players' graph does** (water is what
  separates them: one `NavReach` lookup per hit), the mob goes `return` at once: the hit misses, every later hit
  misses (the existing anti leash-kiting rule, `gameplay.ts` 981), and it is restored at home. Ranged specials of
  uniques are unaffected. A cliff between them is not changed (today's behaviour).
- **Waterborne monsters: a hook only, unused in wave 13** [decision; fact-check]. The first draft made the 11 Water
  Ghost nests waterborne. But a swimmer cannot attack (§7), so a Water Ghost following a player into swim water
  would fight an opponent who cannot answer. They are level 6–7 and passive, and 65–92 % of each spawn disc but one is
  wade or dry ground [confirmed: `nests-in-water.json`, `mobs.json`], so they stay land walkers and lose only their
  swim-water spawn points. The `waterborne` flag (`content/swim/swim.json`) stays for wave 14, with the rule that a
  waterborne monster must be fightable from where players can be.

### 8.2 Nests, NPCs and spawns

- The spawner places mobs only on walkable tiles: swim tiles are closed to the land placement, so no new mob spawns in
  water. Nests whose disc is partly water lose those spawn points (only the 11 Water Ghost nests; nest 1797 at (290, 475)
  keeps 31 % of its disc, the others 65–92 %).
- **No NPC stands in swim water** [likely: none of the town NPC points is in a body ≥ 300 m²; SW-C's report lists any].

### 8.3 Drops

Loot tosses land on walkable ground: the drop point search (`nav.place`) uses the mask, so an item dropped by a mob
killed at the edge lands on the bank, never on a swim tile [decision].

---

## 9. The camera at the waterline

### 9.1 What the prototype showed [confirmed: `swim-proto.ts` on the real renderer, S1, WebGPU Medium and WebGL2 Low]

- **Above water** (`shots/s1_above_webgpu_medium.png`): the swimmer floats on the FFT ocean's wave query, the body
  seen through the water, the beach and the ridge behind: it reads as swimming.
- **Under water** (`s1_under_side_webgpu_medium.png`, `s1_under_webgpu_medium.png`): the swimmer from the side and
  below, fogged by the path length in water. Finding for UNDERWATER: **the PBR ocean has no underside** (back faces are
  culled), so from below the sky shows through the surface; the Classic ocean on Low does draw its underside
  (`s1_under_side_webgl2_low.png`) [confirmed: the shots]. The look of the surface from below is UNDERWATER's (§9.4).
- **At the waterline** (`s1_waterline_webgpu_medium.png`, `s1_split_webgpu_medium.png`): with minZ 0.2 m and fov 0.85
  the near plane is only **±0.09 m** tall, so the split line jumps across the whole screen with a few centimetres of
  wave, and an eye exactly at the surface sees the sea edge-on (grazing: the seabed shows through a sheet of zero
  thickness) [confirmed: the shots and arithmetic: 0.2 × tan(0.425) = 0.091 m]. A camera must not *rest* in that band.

### 9.2 Rules [decision SW-D21, revised by the fact-check]

**Why the game camera could not dip at all** [confirmed: code + arithmetic]. The orbit's target is the feet + 1.5 m ×
`heightScale` (`screens/world.ts` 781, 862) and its pitch stops at `upperBetaLimit` 1.5 rad (86°), so the eye is
always at least `r × cos 1.5` = 0.07 r above the target. A swimmer's feet hang 1.40 m × `heightScale` under the
surface, so his target is ≈ 0.1 m over it and the eye at least 0.28 m over it (r ≥ 2.5 m); a wader's or a beach
walker's is higher still. The prototype page set the pitch directly with Babylon's default limit (π), which is why
its under-water shots exist (`swim-proto.ts` `eyeAt`).

1. **The pitch opens below the horizontal in water.** While the player is swimming, diving or wading deeper than 0.6 m,
   `upperBetaLimit` eases from 1.5 to **1.95 rad** (22° below the horizontal) over 0.3 s; on leaving the water it eases
   back, lifting an eye that is under. The ground clamp (`CameraGround`) still keeps the eye 0.6 m above the bed (it
   already reads the terrain, which is the bed). From dry land the camera stays above water (as today).
2. **The waterline band**: the eye is never left inside ±0.35 m of the local wave surface (`waveHeightAt(eye)`, smoothed
   by the swimmer's 0.15 s spring). When the player's pitch or zoom would put it there, **the pitch** is clamped to the
   band edge on the side the eye came from (the radius cannot do it: near the horizontal no radius moves the eye out
   of the band). It crosses when the requested pitch goes 3° past the far edge, and then **snaps across in one frame**
   (≈ 0.7 m of eye travel). On a swell the clamp moves the eye with the water: the camera bobs, it never flickers.
3. **No split pass** (fact-check). Attaching a post-process only near the surface would rebuild the
   `DefaultRenderingPipeline` chain and compile a pipeline at the worst moment (post.ts's hitch rules: "weather and time
   never change a define here"; SSR stays attached and uniform-gated for that reason); a permanently attached pass costs
   a full-screen read and write every frame (≈ 0.05 ms dev, ≈ 0.3–0.5 ms on a base M1, more than G6's 0.15 ms dev
   margin in the beach view) [projected]; and UNDERWATER already decided that no frame is split (S-UNDER). The
   one-frame snap plus UNDERWATER's 0.25 s blend of its uniforms hides the crossing.
4. **Diving** pulls the target down with the diver (target = the diver's head), so the camera follows under.
5. **Clicks on water** while swimming or wading: the picking ray first meets the water's still surface (the swim
   layer's plane), not the seabed, so a click lands where the player sees it; the click marker sits on the surface.

### 9.3 Under water: UNDERWATER's `World.underwater`, not a fog swap of our own [fact-check]

The first draft swapped "the scene fog" for the water's and said "every material already applies the scene fog". The
code says otherwise [confirmed: grep of `fogEnabled = false` / `applyFog = false`; line numbers of the working tree
on 2026-10-02, wave 12 is editing `terrain.ts` and `water.ts`]:

- the sky dome and the classic sky draw **no fog at all** (`sky/dome.ts` 70, 98; `sky/classic-sky.ts` 30, 37), so the
  sky stays bright behind a fogged world and through the PBR ocean's missing underside;
- the terrain's ShaderMaterial applies its own fog from `TerrainParams` (`terrain.ts` 579, 849–887); the ocean and the
  retail water planes compute fog in their shaders (`ocean.ts` 327, `water.ts` 358);
- PBR materials use the `SroFogPlugin` height fog with its own numbers, written each frame by `RenderPost`
  (`pbr/fog-plugin.ts`, `post.ts` 863).

UNDERWATER's `World.underwater` (UW-R, UNDERWATER §4.1) already does this properly on every preset: it suspends the
height fog, replaces the sky with a water-coloured backdrop, follows `scene.clearColor`, cuts `maxZ` to 90 m and
applies per-channel absorption, with "Low keeps its retail look with a fog swap". So SWIMMING draws nothing under
water and owns no fog code: no duplicate classifier, no second fog path, no `packages/world-render` file in SWIMMING's
lanes. **If UNDERWATER's state is not in the build** (its never-cut list keeps it), rule 1 above stays off: the
camera does not dip, and nothing else changes.

### 9.4 The hand-off to UNDERWATER (S-UNDER, S-DEPTH, S-ZONES, S-BUBBLES)

- **The eye rule** (S-UNDER): `World.underwater` classifies the eye; SWIMMING's camera keeps the eye out of the band
  (§9.2). UNDERWATER's 0.35 m and this spec's 0.35 m are the same constant (`SWIM_EYE_BAND_M` in
  `packages/shared/src/swim.ts`).
- **The swimmer** (client): `world.setSwimmer({ diving, headDepthM } | null)` each frame from `apps/game/src/world/swim/`,
  for life that reacts to a diver; the swim layer's `swimClassAt`, `waterSurfaceAt`, `bedAt` for anything else.
- **The depth** (S-DEPTH, server): `swimDepthM(p, now)` (§6); no protocol field.
- **The zones** (S-ZONES): UNDERWATER's polygons join the swim domain (§3.1); the dive class is `swim.bin`'s.
- **Bubbles** (S-BUBBLES): SWIMMING calls `world.sea.bubbles` on dive-in, every 3–5 s while down, and on the gasp.
- **SWIMMING owns** the band rule, the pitch opening, the dive camera, the breath bar. **UNDERWATER owns** everything
  drawn or heard under water.

---

## 10. Client (apps/game)

### 10.1 The swimmer

- **Height**: a swimmer's root y = the wave surface at his position (`waveHeightAt`, else `waterLevelAt` off the sea) −
  `SWIM_WATERLINE_M × heightScale(height)` (0.94–1.06), smoothed by a 0.15 s spring so waves rock rather than shake
  [confirmed: the prototype floats on `waveHeightAt` with the 1.40 m line; the smoothing is a decision].
- **Wading**: on the ground as today; a sliver deeper than the wade line (§2.1) lifts the root at most 0.5 m so the head
  stays out [decision].
- **Diving**: the root follows the dive line with a 1.2 / 1.8 m/s rate limit and pitches 25° nose-down while descending,
  0 level, 20° up while ascending (the SWIM clip's body turned by the actor root) [decision].
- **Clip choice** by the viewer: `SWIM_IDLE` standing in swim water; `SWIM` / `SWIM_FAST` moving (§5.4); `SWIM_ENTER`
  / `SWIM_EXIT` over the first part of the leg after a mode change; blends 0.25 s through the existing `playAction`
  path (MOVEMENT finding 3: never from the bind pose).
- **Weapons hidden** while in swim mode (§4.1).
- **Loading**: `char/_anims/<skel>/swim.glb` + `swim.json`, after `worldEnter`, once per skeleton, not awaited; a
  swimmer seen before it loads plays `SWIM_IDLE` → missing → the actor's STAND1 lifted to the waterline (a fallback,
  tested).

### 10.2 Splashes, ripples, sound

- **Effects** (EFFECTS.md's pooled sprite system): a ring ripple under every swimmer (one quad, alpha-faded), a splash
  burst on ENTER, EXIT, dive and surfacing, wake droplets at the stroke events (two per SWIM cycle), wading splashes at
  each footstep in wade water. Caps: 6 swimmers with ripples within 40 m, the rest get none; ≤ 2 emitter draws
  [decision; EFFECTS' caps].
- **Sound** (SOUND §5.7's clip tracks): strokes = the retail `mvwalkwater` / `mvrunwater` at 0.8× pitch on the stroke
  events; the splash on enter/exit/dive = `mvrunwater` doubled; footsteps in wade water already use the `Water`
  surface. No new recorded file; UNDERWATER owns the low-pass and the under-water ambience [decision SW-D22].

### 10.3 HUD and text (English UI, live text, docs/UI.md)

- The breath bar (diving only), and the toasts: "The current is too strong to swim further out." / "You can't go
  ashore here." / "Your horse won't go into deep water." / "You can't do that while swimming." (`swimming`) / "It's too
  shallow to dive here." (`too_shallow`) / "Out of breath!" / "The trade was cancelled: you went into the water."
- The key help: "Space: dive / surface (while swimming)".
- No new Options row: swimming has no setting [decision].

---

## 11. Protocol (additive, protocol v1)

`packages/shared/src/protocol.ts`:

```ts
export interface MoveState {
  from: Vec3; to: Vec3; speed: number; startedAt: number
  /** Wave 13: absent = walking/wading; 'swim' at the surface; 'dive' under it. */
  mode?: 'swim' | 'dive'
  /** Wave 13: the next leg (a shore crossed in one move), starting at this leg's arrival; at most 2 levels. */
  next?: MoveState
}
// EntityState (players): swim?: 'surface' | 'dive'   (present while in swim water, standing or moving)
//                        diveAt?: number              (server ms the dive began; late joiners and the breath bar)
// entityUpdate:          swim?: 'surface' | 'dive' | null, diveAt?: number
// ClientMessage (GameplayRequest): { t: 'dive' }      toggle; actionResult; CLIENT_RATE_LIMITS dive {perSecond: 2, burst: 3}
// ActionFailReason += 'swimming' | 'too_shallow'
// PlayerStats (own player): swimMul?: number, breathMul?: number   (PLAYER_STAT_OPTIONAL_KEYS; absent = 1)
```

- **Validators** (`validate.ts`): `mode` is one of the two strings; `next` is a `MoveState` with `startedAt ≥` the
  parent's and at most two levels deep; `swim`, `diveAt` typed; `dive` has no fields.
- **The breath end** needs no event: the diver's own client computes the bar from `diveAt`, `DIVE_BREATH_MS` and its
  own `breathMul`; the server's `entityUpdate swim: 'surface'` ends it. Fact-check: no effect-stat channel exists
  today (`speedMul` is a server field set by GM `/speed`, `world.ts` 559; `PLAYER_STAT_OPTIONAL_KEYS` holds only
  `hwan`, `protocol.ts` 1071), so `swimMul` and `breathMul` travel as two optional `PlayerStats` keys, the seam
  HOT_SPRINGS calls S-STATS (one protocol agent for the wave).
- **Older clients** ignore unknown optional fields (`mode`, `next`) [likely: unknown server frames are dropped with a
  warning, MOVEMENT §5 [confirmed there]; unknown fields of known frames are SW-P's validator test]; they draw a walking
  swimmer for one move at worst (§2.6).
- **Collision check** [confirmed: grep of `protocol.ts` at HEAD]: no `dive`, `swim` or `mode` name exists. FISHING,
  UNDERWATER and HOT_SPRINGS must not reuse `dive`, `swim`, `swimming` (the wave plan re-checks).
- docs/PROTOCOL.md gets a "Swimming" subsection.

---

## 12. Seams with the other wave-13 items and hooks for wave 14

### 12.1 FISHING

- `swimClassAt(x, z)` and `waterSurfaceAt(x, z)` (shared, from `swim.bin`) tell whether a cast lands on water; casts
  from swim mode are refused `swimming` (§7).
- **S-WATERQ** (FISHING's seam table names SWIMMING's water lane as its owner) [fact-check: seam]: `waterAt(x, z)` in
  `packages/nav/src/swim.ts` returns `{ kind: 'sea' | 'fresh' | null, surfaceY, depthM, swimClass }` from `swim.bin`'s
  block surfaces and the terrain height; `swim.bin` lists every in-bounds water region, so the answer covers all
  fishable water; the springs answer `null` (HOT_SPRINGS answers them first). FISHING's body channel (FS-W) is its
  own grid beside it, not a `swim.bin` field.
- FISHING lists ladders off the pier as "later" (its S-DECK row); SWIMMING's `exits` (§5.5) are cut 1, so they ship
  only if the pier lands in time.
- The pier: FISHING builds it (a placement with a collision navmesh: a deck surface and solid piles); SWIMMING's
  drop-in (§5.5) and `exits` ladders use it.
- Cooking buffs: `swimMul` (swim speed) and `breathMul` (dive breath) are server player fields sent as optional
  `PlayerStats` keys (§11); SWIMMING reads them, FISHING's dish effects write them and decides the dishes. A +10 % `swimMul` dish turns on the crawl (§5.4).

### 12.2 UNDERWATER

- §9.4's seams (S-UNDER, S-DEPTH via `swimDepthM`, S-ZONES, S-BUBBLES), the dive state (`EntityState.swim`, `diveAt`,
  the server's "down" test, §6), `swim.bin`'s classes (where a diver can go). The swim domain is over emitted terrain
  in the 150 m band; past it, UNDERWATER's bed regions (its zones dilated by 64 m) emit the bed (§2.2).
- Interactions under water (a clam, a chest) are UNDERWATER's requests; they check `p.swim.mode === 'dive'` and "down".
- UNDERWATER's sea creatures are client-side life, not server monsters; `waterborne` stays unused in wave 13 (§8.1).

### 12.3 HOT_SPRINGS

- A spring pool is **wade** water by construction (≤ 1.0 m deep is HOT_SPRINGS' rule, HS8), so no swimming and no lock in
  it; HOT_SPRINGS owns its soak posture and the bonus EXP. The springs' surfaces are their own, not retail or editor
  water, so the swim builder never sees them and `swimClassAt` answers none there (HOT_SPRINGS S-WATERQ answers
  `springs` first) [fact-check: seam].
- **S-MOVES** [fact-check: seam]: HOT_SPRINGS' table expects `SWIM_*` kinds in `export-moves.ts`. SWIMMING ships a
  separate `swim.glb` through `swim-clips.ts` and only *calls* `export-moves.ts`'s functions (SW-D12), so HS-A's SOAK
  is the only kind added to that file; WAVE_PLAN9 should record that.

### 12.4 QUESTS

- A `reach` objective may set `swim: true` (count only while swimming) for custom quests ("Swim out to the reef");
  the engine's throttled `reach` check already measures XZ distance [confirmed: `apps/server/src/quests/engine.ts`
  612–629, run from the module's `tickPlayer`; QUESTS.md calls it `quests.onMove`, a name the code does not use].
  Hook only.

### 12.5 Wave 14 ("The Climb") hooks, not designed here

- `swimMul`, `breathMul` as effect stats (level rewards, skills).
- `waterborne` (and a future `amphibious`: walks land *and* swims) for nemesis monsters and a storm Qilin over the sea.
- The swim layer is per world: a flooded hall in the Qin-Shi Tomb dungeon gets its own `swim.bin` from the same
  builder.

---

## 13. Budgets per preset (WAVE_PLAN8 §5 format; 1080p; dev PC Ryzen 5 9600X + RX 9060 XT)

### 13.1 What swimming adds per preset

| Preset | The swimmer | Under water / waterline | Effects | Data |
|---|---|---|---|---|
| Low (the Classic path, either backend) | the clips, floated on the Gerstner query | the band rule; the look is UNDERWATER's Low path | ripples and splashes (pooled sprites) | `swim.bin`, the swim pack |
| **Medium (default)** | as Low, on the worker-FFT query | the band rule; UNDERWATER's state; **no pass of our own** | as Low | as Low |
| High / Ultra | as Medium, GPU-FFT query tile | as Medium | as Low | as Low |

### 13.2 Costs

No timing was taken for this spec or its fact-check (the prototype page is not the production path); every time below
is [projected] from the measured pieces it names. LAB-13 measures them under the GPU lock.

| Preset | Draws added | GPU added (dev) | CPU added | Laptop / M1 | VRAM | Download |
|---|---|---|---|---|---|---|
| Low | 0 per swimmer (the same parts as a runner); ≤ 2 effect draws | ≈ 0 | the clip evaluation as any looping clip: 20 swimmers ≈ the jump bench's +0.2 ms mean (MOVEMENT §7); 2 wave queries + a spring per swimmer ≤ 20 µs | N100: unchanged class | ≈ 0.4 MB (the swim layer in JS memory, not GPU) | swim pack ≈ 50–80 KB brotli per skeleton (2 clips measured at 31.8 KB; 5.1 s of clips scale to ≈ 50 KB); `swim.bin` ≈ 15 KB |
| **Medium** | as Low | **0** (no split pass, §9.2) | as Low; the swim walker on the client predicts only on a click | M1: 0 GPU added; G6 unaffected | as Low | as Low |
| High / Ultra | as Medium | as Medium | as Medium | gaming laptop: as Medium | as Low | as Low |
| Server | — | — | the swim walker per water `moveTo`: microseconds; the water-evade check: one component lookup per player hit on a mob; breath: one check per diver per tick | — | `swim.bin` ≈ 0.4 MB in memory | deploy ≈ +0.2 MB |

**The new scene, "20 friends swimming off S1"** (re-derived from the wave-11 rescue bench, `wave11/budgets.md`,
commit cb65112; the first draft used BACKLOG's pre-rescue "≈ 580 draws for 20 characters", which the rescue's merged
parts, blobs and shadow-caster cap replaced):

| Backend, preset | Beach alone (p95, measured) | 20 players added (measured elsewhere) | 20 swimmers at S1 (p95) |
|---|---:|---:|---:|
| WebGPU Medium | 1.7 ms | +6.0 (Tiger Girl 4 → 20 players: 9.0 → 15.0) to +7.7 (plaza noon → 20-player plaza, with 20 monsters: 7.2 → 14.9) | **≈ 8–10 ms**; ≈ 9.5–12.5 late in a session (the rescue's 1.5–3 ms "second fight on a page" GC effect) [projected] |
| WebGL2 Medium | 1.1 ms | +5.3 (plaza 5.0 → 10.3; Tiger Girl 5.6 → 10.9) | **≈ 6.5–7.5 ms** [projected] |
| WebGPU High | not benched (≈ 2.5–3.5, the plaza's High/Medium ratio) | +9.7 (plaza High 9.7 → 20-player plaza High 19.4, reported) | **≈ 12–14 ms**; under 16.7 with less room [projected] |
| Under water, any preset | — | — | UNDERWATER's budget (its 45 m actor cull and 90 m far plane, its §9) |

What it means, honestly:

- **The thin scenes do not change.** G1's tightest scenes are the 20-player plaza and the 20-player boss fight (14.0–17.3
  ms p95 WebGPU Medium after the rescue, one still red at the line); they have no swim water, so swimming adds 0 there.
- **The swim scene passes G1 with margin on Medium**, because the beach is the lightest scene in the game (36 draws)
  and swimmers are ordinary characters under the rescue's crowd budget. The frame is CPU-bound there as at the plaza.
- **High is the tighter preset**, as it already is for every 20-player scene (the High 20-player plaza reads 19.4 ms,
  a known G2 non-blocker). Swimming does not change that picture; LAB-13 reports the S1 High row.
- **No new GPU work on any preset**: the split pass is gone (§9.2), the look under water is UNDERWATER's.
- Swimmers below the surface cast no shadow (UNDERWATER asks the same), a free saving SW-G takes [decision].

### 13.3 Per-lane budgets

| Lane | Budget |
|---|---|
| SW-C | `swim.bin` build ≤ 2 s for the whole export (with the component join of §3.3); an editor publish of one region ≤ 50 ms |
| SW-A | each clip ≤ 60 KB raw; the pack ≤ 100 KB brotli per skeleton |
| SW-S | `walkEntity` with three legs ≤ 50 µs; the evade check ≤ 2 µs per hit; no allocation per tick for divers |
| SW-G | per swimmer per frame ≤ 20 µs (two wave queries, the spring); the band rule ≤ 10 µs per frame |

### 13.4 Gates (added to the wave plan's list)

- **G1 unchanged** (no water at the plaza); LAB-13 adds the scene "S1 noon, 20 swimmers + 10 waders, camera at the
  waterline band" on both backends, Medium p95 < 16.7 ms, plus the High WebGPU row (reported).
- **G4**: no new shader and no new post-process from SWIMMING on any preset; `material-budgets.test.ts` unchanged; no
  shader compile when the camera crosses the surface (the crossing changes uniforms only).
- **G6 (Mac margin)**: SWIMMING adds 0 GPU; UNDERWATER's rows carry the under-water view.

---

## 14. Lanes

Wave 13 starts from the wave-12 final commit (WAVE_PLAN8 D1's rule). File ownership:

| Lane | Owns | Seams | Tests | User checks | Effort |
|---|---|---|---|---|---|
| **SW-P** (step 0) | `packages/shared/src/swim.ts` (constants incl. `SWIM_STEP_M`, `SWIM_EYE_BAND_M`, `classifyRegion`, `pruneBodies`, the exit test, types); `packages/nav/src/swim.ts` (decode `swim.bin`, `SwimLayer`, the swim walker); **a tile-mask hook in `packages/nav/src/world.ts` (`tileState` / `terrainLeg`, a per-call ignore flag) and in `reach.ts`**, landed after wave 12's final commit (wave 12 edits `world.ts`); `protocol.ts` / `validate.ts` additions (§11, incl. the two `PlayerStats` keys) | the shared seam every other lane reads; PROTOCOL.md's subsection; the S-STATS protocol agent (with HOT_SPRINGS, FISHING) | classify on fixtures (wade, swim, dive, retail-only sliver pruning, sea vs fresh, overrides, the 0.6 m shore step, a body with no way out stays wade); walker DDA (stops at land, at `noExit` shores, at the domain edge, at solid objects, passes under decks; starts within the walk's backoff); the land walker with the mask stops at swim tiles and ignores it with the flag; `swim.bin` round trip; validators | — | 2.5 d |
| **SW-C** | `packages/convert/src/world/swim/**` (build, write, report), the hook in `convert-world.ts` (via the lead, after the nav step), `NAV_KNEE_DEEP_M` → `SWIM_DEPTH_M` in `world/coast/navgen.ts` + `source.ts`, `manifest.swim` type, `content/swim/swim.json` (`noSwim`, `forceSwim`, `exits`, `openShore`, `waterborne`); the domain function UNDERWATER's bed-region rule reads (§2.2) | the world editor's incremental convert calls SW-C's builder (WORLD_EDITOR WE-N/WE-I, D30 change, §2.5); UNDERWATER's zone file (read) | determinism (two runs byte-identical); full = incremental for a touched region; S1 has no gap band (every sea tile ≤ 1.2 m open, > 1.2 m swim); **the component join (§3.3): no shore of a component the town does not reach today is an exit (1.2 km² stays closed), and the report lists them with their nests**; the four quay-bound bodies stay wade; the dive-zone union reaches z 1560 at S1; the report lists NPCs, places, nests and town-life graph edges in swim water | look at the swim map in the viewer (S2) | 3 d |
| **SW-A** | `packages/convert/tools/blender/swim/key_swim.py`, `packages/convert/src/tools/swim-clips.ts` (`pnpm sro moves --swim`), `content/moves/<skel>/swim/*.json` (5–6 clips × 2 skeletons) | the pack format (export-moves.ts functions, read-only) | the §4.4 checks on both skeletons | the GIF page (S3) | 3.5 d (the clips are art direction: ≈ 1–2 h each, as the jump's) |
| **SW-S** | `apps/server/src/swim.ts` (module: gate, `dive`, breath, `swimDepthM`, entry, trade cancel), the leg chain in `world.ts walkEntity` + `arrive` (a seam the lead lands; only a plain `moveTo` chains), `nav.ts` water surface + mask, `ai.ts` acquisition skip, the water-evade rule in `gameplay.ts`'s hit path (a seam the lead lands), `connection.ts entryPoint` water restore, `mounts.ts` edge stop | the jump's `movement` module untouched; FISHING's and UNDERWATER's modules read `p.swim` and `swimDepthM` | legs: walk→swim→walk across a river in one move, exact `startedAt` chaining, ≤ 3 legs; approach moves (attack, pickup, NPC) never swim; no exit onto a closed component or a > 0.6 m bank; clamp to the swim box only for water moves; the lock table (§7) row by row; mounted stop; dive accept/refuse/breath end/cooldown, 15 m line; a mob stops at the edge, hits in reach, drops when out of reach, never acquires a swimmer; **a mob shot across water evades (every hit misses, restored at home) while a cliff case is unchanged**; Water Ghosts stay out of swim tiles; login on an old bed → treading; logout while diving → surface | — | 4 d |
| **SW-G** | `apps/game/src/world/swim/**` (float, clip choice, transitions, weapons hidden, ripples/splashes, the `world.setSwimmer` and bubbles calls), the pitch opening and the band rule in `world/jangan/camera.ts` + the beta limit in `screens/world.ts`, water picking in `screens/world.ts`, the breath bar, `i18n` strings, the stroke/splash cues in `audio/` | UNDERWATER's `World.underwater` (read) and `setSwimmer` / `sea.bubbles` (UW-R / UW-L own them); `three/models.ts` loads `swim.glb` (MOVEMENT §6.1 pattern) | entity y on the surface ± the spring; clip choice table; fallback without the pack; the eye can reach −0.35 m under a swimmer and not from dry land; band hysteresis (no flicker over 600 frames of waves) and the one-frame snap; no post-process and no shader compile on a crossing; click lands on the surface; old-client fields ignored | S1 swim (S1), camera (S4) | 3.5 d |
| **LAB-13 rows** | the S1 swim scene in the wave lab | — | G1 rows (Medium, both backends) and the High WebGPU row (§13.4) | — | 0.5 d |

Total ≈ 17 agent-days (the fact-check's exit rule, evade rule and nav hook add ≈ 1.5 d, the dropped split pass and fog swap save ≈ 0.5 d); the critical path is SW-P → SW-S / SW-G (in parallel with SW-A and SW-C) → I-13.

---

## 15. Tests (summary; each lane's row above has its own)

- Shared: class boundaries at exactly 1.2 m and 2.5 m; a 299 m² retail body is wade, a 300 m² body swim; a body
  touching the sea, and any editor body, is never pruned; a 0.6 m bank is an exit and a 0.7 m bank is not; a retail
  body with no exit is wade.
- Server: the 3-leg crossing on a synthetic river fixture; a swim move toward the domain edge stops at 150 m with the
  toast flag; a land move never leaves the rectangle; `trade` cancelled on entering water, both sides told; a swimmer
  never climbs onto a component the home does not reach; an archer across a channel gets misses after the first hit
  and the mob is restored at home; an attack approach toward a mob across water stops at the shore.
- Converter: `swim.bin` byte-identical across two runs; the coast re-convert's S1 nav chunks open every sea tile ≤ 1.2 m;
  on the real export the report's closed-shore list holds components 1, 2, 5 and 6 of §3.3.
- Client: NullEngine tests for the float, the clip choice, the pitch opening (no dip from dry land), the band rule, no
  post-process added on any preset.
- Editor: a new pond 2 m deep in a test region produces swim tiles in both the incremental and the full build; a pond with
  no shore stops Publish.

---

## 16. User checks (about 10 minutes, after the build)

1. **S1 swim**: walk from town to S1, wade in, swim out, tread, swim back and walk out. Does it feel right? Speed?
2. **The clips**: the GIF page (male and female, all five clips) and the same in game.
3. **The lake**: cross the lake north of town; the river from bank to bank in one click.
4. **The camera**: dip the camera under while swimming and from chest-deep water; no flicker at the surface.
5. **Diving** (if not cut): dive off S1, run out of breath, surface.
6. **Limits**: swim out until "The current is too strong"; try to mount, attack, open a stall while swimming; swim to
   the lake's far north-west bank and see "You can't go ashore here."

---

## 17. Scope-cut order (cut from the top)

1. Pier drop-in and ladders (§5.5): in and out over the shore only.
2. `SWIM_FAST` (the crawl): `SWIM` played 1.25× faster with a bonus.
3. Diving and breath (§6): surface swimming only; the camera still dips under (UNDERWATER keeps its view from the
   surface; its clams and coffer then need a diving-free rule, its S-BREATH fallback).
4. `SWIM_ENTER` / `SWIM_EXIT`: 0.25 s blends between RUN and the swim clips.
5. The 150 m sea band (§3.1): swimming inside the rectangle (the lake, the rivers, S1's strip to the bounds line at
   ≈ 1.7 m) **plus UNDERWATER's dive zones**, which its content needs; the union's edge is the soft wall.
6. Ripples and wake (keep the enter/exit splash).

(The first draft's cut 3, the split pass, is gone from the design: §9.2.)

**Never cut**: the depth rule and the swim layer on the server (authoritative); `SWIM` and `SWIM_IDLE` on both
skeletons; the locks (§7); monsters kept out of the water; the coast's wade line at 1.2 m (no gap band); the editor's
"swimmable, not walkable" rule with the same builder; the band rule on every preset; the exit rule of §3.3 (no land opened that the town cannot reach); the water-evade rule
(§8.1); the Low path on both backends; G1.

---

## 18. Decisions

- **SW-D1** `SWIM_DEPTH_M` 1.2: wade up to it, swim past it. *The editor's existing line, mid-chest, one constant.*
- **SW-D2** Four classes in 2 bits (none, wade, swim, swim + dive at 2.5 m). *All a walker, a diver and a renderer need.*
- **SW-D3** Retail deep bodies under 300 m² stay wade (bed walk) with a visual lift; sea and editor bodies are never
  pruned. *113 slivers, 7.2 k m², are noise; an editor sliver would otherwise be neither walkable nor swimmable.*
- **SW-D4** A separate `swim.bin`, one file for server and client; `nav.bin` unchanged. *15 KB; no nav format change.*
- **SW-D5** The coast's knee-deep 0.4 m becomes 1.2 m. *Otherwise S1 has an unreachable band between sand and swim water.*
- **SW-D6** The editor's D30 becomes "swimmable, not walkable" with the same builder, a "way out" check and a "No
  swimming here" toggle. *The user's editor and the converter must agree.*
- **SW-D7** No DB migration; the swim state comes from the position; old bed positions lift to the surface. *Nothing
  new to persist.*
- **SW-D8** The sea up to 150 m past the bounds, plus UNDERWATER's dive zones, is swimmable (0.51 km² of connected
  deep sea in the band). *Open water over terrain everywhere, and UNDERWATER's shrine 176 m out stays reachable.*
- **SW-D9** The clamp uses the swim box only for moves in water; outside land stays look-only. *Keeps COAST §9.4.*
- **SW-D10** Five clips per skeleton (+ an optional DIVE). *Idle, two speeds, in and out.*
- **SW-D11** Weapons hidden while swimming; one clip set per skeleton. *No weapon clipping, half the clips.*
- **SW-D12** A separate `swim.glb` pack via `pnpm sro moves --swim`, keyed by an extension of the town keyer.
  *MV-A's files untouched; the prototype proved the route.*
- **SW-D13** Up to three chained legs in one `move` (`MoveState.next`). *A river crossed in one click, no pause.*
- **SW-D14** Swim 0.6 × run; dive 0.8 × swim; crawl at ≥ 1.1 × with a bonus; no wade slowdown. *Felt but not a chore.*
- **SW-D15** Pier drop-in and authored ladders. *FISHING's pier needs a way in and out.*
- **SW-D16** Horses stop at the water's edge. *No horse swim clip; retail never swam.*
- **SW-D17** Breath only when diving (30 s), to at most 15 m. *Surface swimming stays free; 15 m reaches UNDERWATER's
  reef with 17.5 s at depth.*
- **SW-D18** No drowning, no death by water. *A friends' game; breath only limits a dive.*
- **SW-D19** A `swim` module gate refuses skills, attack, mounts, stalls, trade (and cancels an open one), sit, emote,
  jump, fishing, drops, alchemy. *The user's list plus what has no clip.*
- **SW-D20** Monsters never swim (the Water Ghosts included; `waterborne` is a wave-14 hook), hit in reach, give up
  out of reach, never acquire a swimmer. *Clear rules from the existing AI; no fight a swimmer cannot answer.*
- **SW-D21** In water the pitch opens to 1.95 rad so the camera may go under; a ±0.35 m band clamps the pitch with
  hysteresis and a one-frame snap; no split pass, no fog swap, no depth pass (UNDERWATER's state draws the water).
  *Today's 1.5 rad limit kept the eye above water; a pass near the surface would hitch the post stack.*
- **SW-D22** Sounds from the retail water steps; no new recording. *No download; good enough for strokes.*
- **SW-D23** A monster that water keeps from its attacker evades (every hit misses, restored at home). *A bow across a
  river would otherwise be a free kill.*
- **SW-D24** A swimmer climbs out (or in) only over wade water or a bank at most 0.6 m high; a retail body with no
  such shore stays wade. *94 % of shores are wade; four quay-bound ponds would be traps.*
- **SW-D25** Swimmers climb out only onto components the town reaches today; `openShore` opens one on purpose.
  *Otherwise swimming opens 1.2 km² of land with level 19–30 monsters, wave 14's business.*
- **SW-D26** Only a plain `moveTo` swims; approach moves and mob moves stop at the shore. *An attack approach must
  not end in water where attacks are refused.*

## 19. Needs from the user

- **Nothing blocks the build.** No download, no Meshy credits (0 planned for swimming), no setting.
- **After the build**: the six checks of §16 (≈ 10 minutes) and the wave's deploy OK.

## 20. Open questions (each with the default that is built)

| # | Question | Default |
|---|---|---|
| Q1 | Swim speed 0.6 × run (3.3 m/s)? | yes; the user tunes it at check 1 (one constant) |
| Q2 | ENTER/EXIT keyed from RUN phases with a float blend (not prototyped) | as §4.2; if they fight the RUN cycles, cut 4's blends |
| Q3 | The two touch-ups (SWIM's left palm whip at 30.5°/frame; the tread's wide arms) | SW-A fixes both before the GIF page |
| Q4 | Town ponds (the palace pond, 608 m²) swimmable? | yes, one rule everywhere; the editor's "No swimming here" toggle flips one |
| Q5 | Should the crawl be the default fast-travel stroke instead of a buff effect? | no: breaststroke by default, crawl with a bonus |
| Q6 | A buoy line at the 150 m edge? | no (no model); the toast only; a Meshy buoy later if the user asks |
| Q7 | Do monsters regenerate when a swimmer escapes them? | yes, as after any leash (existing behaviour) |
| Q8 | Diving in fresh water (the lake) too? | yes wherever ≥ 2.5 m deep; UNDERWATER decides what is down there |
| Q9 | Open the far banks (1.2 km², 121 nests of level 19–30, §3.3) to swimmers? | no; they stay closed until wave 14 decides (one `openShore` row each) |
| Q10 | Should the evade rule also cover cliffs (a mob that cannot path to its attacker for any reason)? | no; water only, today's behaviour elsewhere is unchanged |

## 21. Risks

| Risk | Mitigation |
|---|---|
| Players relied on bed-walking across the lake and rivers (now slower swimming) | bridges remain; 0.6 × is felt, not punishing; Q1 tunes it |
| The leg chain desyncs a client (a dropped `next`) | `startedAt` exact chaining, validators, a resync `stop` at the final arrival as today |
| A swim body with no way out after an editor edit | the Publish "way out" stop (§2.5); converter report for retail data |
| The camera flickers at the surface in waves | band + hysteresis; a 600-frame NullEngine test with the worker-FFT waves |
| Monsters stuck at the shore in a pack | they drop the target and go home (existing branch) |
| The female clips need more than a transfer | SW-A keys both; the jump's standing clip transferred unchanged (MOVEMENT §3.3) |
| Swimming opens land and monsters past the cap | SW-D25 and the converter's closed-shore report; Q9 |
| Kills from across water (EXP farming, bots) | SW-D23; the SW-S test row |
| The nav hook collides with wave 12's `world.ts` edits | SW-P lands it after wave 12's final commit; one small optional mask |
| UNDERWATER's state is cut or late | the pitch does not open (§9.3): swimming works with the camera above water |

---

## 22. Fact-check (2026-10-02)

An adversarial pass re-derived every [confirmed] claim from the code at HEAD `cb65112` (plus wave 12's working tree
where it now differs), the export `work/out/world/jangan-fields`, and re-runs of `census.ts` and `br.ts` (same numbers:
the depth table, the 152 bodies, 101 regions / 232,704 B / 9,174 B, 90,420 / 31,820 B). No GPU timing was taken (the
corrections remove GPU work; they add none). New scripts: `work/tmp/swimming/factcheck/`.

| # | Claim in the first draft | Finding | How checked | Fixed in |
|---|---|---|---|---|
| F1 | "The orbit can go under water" | **Impossible with the game camera**: `upperBetaLimit` 1.5 and a target 1.5 m × hs over the feet keep the eye ≥ 0.28 m above a swimmer's waterline; the prototype had no limit | `screens/world.ts` 122–128, 781; `swim-proto.ts` `eyeAt` | §9.2, SW-D21 |
| F2 | The band adjusts "the radius (not the pitch)" | Near a level view no radius moves the eye out of the band; the pitch must | arithmetic on `e = t + r cos β` | §9.2 |
| F3 | "Every material already applies the scene fog" | The sky dome and classic sky draw no fog; terrain, ocean and retail water use their own fog; PBR uses the height-fog plugin | grep `fogEnabled = false` / `applyFog = false`; `fog-plugin.ts` | §9.3 |
| F4 | SWIMMING's own fog swap and `UnderwaterView` | Duplicates UNDERWATER's `World.underwater` (UW-R), which already suspends the fog, replaces the sky and covers Low | UNDERWATER §0, §2.1, §4.1 | §9.3, §9.4 |
| F5 | The split pass "only in the chain near the surface", ≤ 0.1 ms | Attaching a pass rebuilds the post chain and compiles (post.ts hitch rules); always attached it costs every frame, over G6's margin on an M1; it lives in `world-render`, outside SW-G | `post.ts` header and 744; WAVE_PLAN8 §5 G6 | §9.2, §13, cuts |
| F6 | The swim domain past the bounds is 0.66 km² | That is every sea texel; 0.56 km² is deeper than 1.2 m and 0.51 km² of that is connected (E side: 0) | `factcheck/reach-out.ts` | §0, §1.2, §3.1 |
| F7 | 150 m and a 10 m dive cover the sea | UNDERWATER's S1 zone runs to z 1560 (216 m), its shrine is at z ≈ 1520, its reef 8–14 m deep | UNDERWATER §2.1, §3.3 | §3.1, §6, SW-D8, SW-D17 |
| F8 | Climb out on any walkable shore | **Joins 1.22 km² of land the town cannot reach today (121 nests, level 19–30)** to the playable area | `factcheck/swim-reach.ts`, `comp-reach.ts` on `MeshNav` | §3.3, SW-D25 |
| F9 | Every body has a shore | Four bodies (4.3 k m²) touch no open terrain; 197 shore edges are dry banks over 0.6 m | `factcheck/banks.ts` | §1.1, §2.1, SW-D24 |
| F10 | "Monsters give up when out of reach" is enough | A bow (18 m) across water gets free hits while the mob runs to the edge; a kill in that window is free EXP | `ai.ts` 200–233, `gameplay.ts` 981, `weapons.json` | §8.1, SW-D23 |
| F11 | Water Ghosts "waterborne" | They would follow players into water where players cannot attack; level 6–7, passive, discs mostly dry | `nests-in-water.json`, `mobs.json` | §8.1, SW-D20 |
| F12 | Every `walkEntity` call chains legs | Attack, pickup and NPC approaches share `walkEntity`; an attack approach would end in water | `gameplay.ts` 1246, `npc.ts` 227 | §5.1, SW-D26 |
| F13 | "The walker treats a swim tile as closed" (no file named) | The tile test is private to `NavWorld`; a hook in `packages/nav/src/world.ts`, which wave 12 is editing | `world.ts` `tileState`, `git diff` | §2.4, SW-P |
| F14 | Slivers under 300 m² stay wade (all water) | An editor sliver is closed by D30, so it would be neither walkable nor swimmable | WORLD_EDITOR §6.3 | §2.1, SW-D3 |
| F15 | "20 swimmers ≈ 7–10 ms", from "≈ 580 draws" | 580 is pre-rescue; from the rescue bench: ≈ 8–10 ms (12.5 late) WebGPU Medium, ≈ 6.5–7.5 WebGL2, ≈ 12–14 High | `wave11/budgets.md` | §13.2 |
| F16 | `breathMul` "already received as effects" | No effect-stat channel exists; `PLAYER_STAT_OPTIONAL_KEYS` is `['hwan']` | `protocol.ts` 1071, `world.ts` 559 | §11, §12.1 |
| F17 | No server depth | UNDERWATER's S-DEPTH asks for one; `swimDepthM(p, now)` gives it without a protocol field | UNDERWATER §2.1 | §6, §9.4 |
| F18 | `swim.bin` 9,174 B brotli "for the layer" | Measured for the class bytes only (three classes, no dive bit, no header or surfaces) | `census.ts` `SWIMLAYER` | §0, §2.3 |
| F19 | Line numbers | `walkEntity` 753–774 and `walk.legs` 771 at HEAD; `waterLevelAt` is in `packages/world-render/src/world.ts`; the camera limits are in `screens/world.ts` | `git show HEAD:` | §1.3 |
| F20 | QUESTS' `quests.onMove` | The code's reach check is the engine's `tickPlayer` (`quests/engine.ts` 612–629) | grep | §12.4 |
| F21 | HOT_SPRINGS seams | S-MOVES expects `SWIM_*` in `export-moves.ts` (SWIMMING adds none); S-WATERQ: springs are not in `swim.bin` | HOT_SPRINGS §12 | §12.3 |
| F22 | Low = "Classic, WebGL2" | Low is the Classic path on either backend; Medium also runs on WebGL2 | `settings.ts` 811 | §13.1 |

**Confirmed as written**: the depth census and the S1 profile; the 152 bodies and 113 slivers; 1.0 km² of open deep bed
(0.82 km² of it in the town's component); one flat surface per body (0 steps in 572 k pairs); the 11 Water Ghost
nests; `NAV_KNEE_DEEP_M` 0.4 (`navgen.ts` 24, `source.ts` 143); the module gates (`mounts.ts` 60 with `jump`,
`stall.ts` 42, `alchemy.ts` 41, `gameplay.ts` 341–351); `ai.ts` 230–233; the near plane ±0.091 m; the clip round trip
(0.0011°, 1e-7 m loops, 30.5° palm turn, 31,820 B brotli); `mvwalkwater` / `mvrunwater` exist and no swim sound does;
no `dive`, `swim` or `mode` name in `protocol.ts`; `heightScale` 0.94–1.06; the stream radii (Low 320, Medium 400 m);
nothing needs a download; 0 Meshy credits.

---

## Appendix A. Scratch files (`work/tmp/swimming/`)

| File | What |
|---|---|
| `census.ts`, `census.json`, `components.json`, `census-map.png` (= `shots/inbounds-water-census.png`) | in-bounds water by depth and nav openness, bodies, the prototype swim-layer size |
| `census2.ts`, `nests-in-water.json` | nests in deep water; the S1 depth profile |
| `domain.ts`, `domain.json`, `domain-map.png` | the sea past the bounds by band |
| `keys/swim.json`, `keys/swim_idle.json` | the key-pose files |
| `key_swim.py` | the swim keyer (extends `key_town.py`); `--render` frames in EEVEE |
| `out/man/` | `swim_blender.glb`, `swim_keys.json`, `swim.blend`, the pack `swim.glb` + `swim.json`, `roundtrip.json` |
| `pack.ts`, `turn.ts`, `br.ts` | the re-expression and checks with the production MV-A functions; per-joint turns; brotli sizes |
| `vite.config.mjs`, `swim-proto.ts` | the S1 page (port 5296, stopped after use): the real renderer, the swimmer on `waveHeightAt`, the split pass |
| `frames/` | the Blender frames behind the GIFs |
| `factcheck/` | the fact-check (§22): `reach-out.ts` (the connected sea band), `banks.ts` (shore heights, bodies without a way out), `steps.ts` (surface steps), `bed-comp.ts` (which component the deep beds are in), `swim-reach.ts`, `comp-where.ts`, `comp-reach.ts` (the land swimming would open), each with its `.json` |
| `shots/` | `swim_cycle_male.gif`, `swim_idle_male.gif`, `swim_filmstrip_male.png`, `s1_above_webgpu_medium.png`, `s1_waterline_webgpu_medium.png`, `s1_split_webgpu_medium.png`, `s1_under_webgpu_medium.png`, `s1_under_side_webgpu_medium.png`, `s1_sheet_webgpu_medium.png`, `s1_above_webgl2_low.png`, `s1_under_side_webgl2_low.png`, `s1_sheet_webgl2_low.png`, `inbounds-water-census.png` (and two debug shots) |

Re-run: `"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup --python
work/tmp/swimming/key_swim.py -- work/out/char/china/chinaman_adventurer.glb work/tmp/swimming/keys
work/tmp/swimming/out/man chinaman swim,swim_idle [--render work/tmp/swimming/frames]`, then `pnpm tsx
work/tmp/swimming/pack.ts`; the page: `cd apps/viewer && pnpm exec vite --config ../../work/tmp/swimming/vite.config.mjs`
and open `http://127.0.0.1:5296/swim-proto?engine=webgpu&preset=medium`.
