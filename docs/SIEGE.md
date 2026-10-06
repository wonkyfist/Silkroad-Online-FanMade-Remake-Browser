# Siege of Jangan: destructible walls, wall-breakers jailed by Hunters

**Status (2026-10-05): spec only, nothing built.** Written at HEAD `fdfcb04`. Builds on the storm series
(docs/WEATHER.md §2.7 `LightningService.onStrike`, §13 `TornadoService.onTornado`) and borrows the event, settings and
admin patterns of docs/PLAY_THE_BOSS.md.

> **Trello card (player-facing summary)**
> - Jangan's outer walls can now be damaged, section by section: cracked, breached, then rubble.
> - Storms chip and crack the stone, but lightning alone never brings a wall down.
> - **Siege of Jangan**: bandit armies march on the town. Sappers blow holes in the wall, the Warlord leads the last
>   wave, and the Town Bell must not fall. Defend, repair under fire, earn Siege Seals and the "Defender of Jangan" title.
> - A breach is a real hole: monsters walk in, and the ground behind it is no longer safe until it is repaired.
> - Walls mend slowly on their own; Master Mason Ko speeds it up with your gold and stone, or grab a Mason's Kit.
> - Players can blow up a wall with a Thunder Keg, but the whole server is warned and you become **WANTED**.
> - Become a **Hunter** (Captain Yun, west gate): only Hunters may fight the Wanted, catch them and claim the bounty.
> - Caught wall-breakers sit in the Garrison Stockade for 2 hours, then 4, 8, 16... for each repeat offence.

**The user's decisions (not re-opened here).** The outer walls become destructible in segments with damage stages
(intact → cracked → breached → rubble) and repair. Lightning only chips and cracks, never breaches. Monsters damage
walls during a "Siege of Jangan" event (monster armies attack, players defend). Players can break walls with siege
items; that triggers a server-wide notice, the wall-breaker becomes Wanted, and Hunters (the Hunter/Thief/Trader job
system, not built yet; idea card "Trade runs: the Trader, Hunter & Thief job war") hunt them down and jail them for a
couple of hours, more for each repeat offence. A breach lets monsters into town (safe-area rules change while
breached). Repair: slowly on its own, and/or by player donations of gold and materials to builder NPCs.

**Tags.** **[confirmed]**: read in the code or data, or measured with a read-only script on the export (the text
names the file or the script's finding). **[likely]**: strong evidence, not proven. **[decision]**: a choice this spec
makes, with its reason. **[unknown]**: open; the default used is given. **[projected]**: computed from confirmed
numbers, not measured.

**Sources read.** docs/PLAY_THE_BOSS.md, WEATHER.md (§2.7, §13), WORLD_EDITOR.md (§4.7, §6.3), NAVIGATION.md
(underpass), PLAYTEST.md (places), CLIMB.md, TEXPIPE.md, SCREENS.md. Code: `apps/server/src/{nav,places,gamedata,
gameplay,item-use,db}.ts`, `lightning/{rods,select,service}.ts`, `storm/{tornado,schedule,service}.ts`,
`admin/routes.ts`, `pilot/hunt.ts`; `packages/nav/src/{data,world}.ts`; `packages/shared/src/{protocol,tornado}.ts`,
`world-edits/walk.ts`; `packages/world-render/src/{objects,nav}.ts`. Data: `work/out/world/jangan-fields/
{manifest.json, nav.bin, models/bldg/china/jangan_enter/*.glb}`, `work/out/data/{towns,mobs,items,nests}.json`,
`content/places.json`, `work/extracted/Data/prim/snd`. Scripts (scratch, read-only): wall placements and glb mesh
stats from the manifest; nav instances along the wall band; straight-walk probes across every 2 m of each wall; an
open-ground map of the west camp.

---

## 0. Summary

1. **Four retail walls become 33 segments** (N 10, S 9, W 7, E 7; ≈ 48 m each). Gatehouses and corner towers stay
   indestructible. Each segment is cut in Blender into **thirds** (≈ 16 m): a **breach** removes the middle third, a
   **rubble** collapse removes all three. Stage meshes are variants of the cut retail meshes (no new shaders).
2. **Integrity** per segment runs from 100 % down to −50 %: intact > 70 %, cracked > 0 %, breached > −50 %, rubble at
   −50 %. Lightning and tornado wear stop at a floor of 35 % (never below cracked). Only siege monsters, kegs and GMs
   can push a segment through 0.
3. **Nav at runtime**: the converter splits the retail wall collision navmeshes into per-third instances and lists,
   per third, the terrain tiles a gap must open (the wall's footprint and the ditch rims in front of it). Server and
   client apply the same two cheap seams in `@sro/nav`: a per-instance **disabled mask** and a **tile override**
   layer. Both sides derive the nav from the segment states alone, so prediction matches.
4. **Safe area**: one seam in `GameData.inSafeArea` subtracts **breach zones** (a 50 m radius inside the gap; 80 m
   during a siege). Every one of the ~20 safe-area callers follows automatically.
5. **Siege of Jangan** (a GameplayModule `siege`): warning, three waves along authored lanes, sappers, stone rams,
   archers, the **Bandit Warlord** in wave 3, the **Town Bell** on the plaza as the loss objective. Gates are
   **warded** against siege monsters (a mob-only clip), so walls matter. Scaled by the number of defenders.
6. **Siege items**: Thunder Keg (players, breaks walls, Wanted), Mason's Kit (repair at the wall), Stone Block and
   Saltpeter (materials). Kegs are character-bound, level 18+, one plant per account per 30 min.
7. **Wanted**: whoever's blast takes a segment through 0 is the wall-breaker; damage-dealers of the last 10 min are
   accomplices. Server-wide notice at the plant and at the breach. The server alone sets Wanted, so false reports
   cannot exist.
8. **Minimal job system**: a **Hunter licence** (level 15, 10,000 gold, Captain Yun at the west gate) and an
   **on-duty** toggle. One PvP rule function `pvpAllowed(a, b)`: an on-duty Hunter and a Wanted player may fight each
   other, nobody else. The table is where Trader and Thief rows go later.
9. **Capture**: a Wanted player brought to 0 HP by Hunters is **subdued**, not killed, and warped to the **Garrison
   Stockade** (the open ground by the west wall's military camp, inside the safe area). Sentences 2 / 4 / 8 / 16 / 24 h
   by offence count (per account, one level forgiven per 30 clean days), real time, offline included.
10. **Repair**: +1 % per 10 min on its own; donations queue work that Master Mason Ko's builders apply at ≤ 1 %/min
    per segment; a Mason's Kit adds 1 % per 10 s channel at the wall, siege included.
11. **Three migrations** (17 walls, 18 siege, 19 jobs and law), a settings patch over `content/siege/jangan.json`, an
    admin page, GM commands `siege`, `wall`, `law`.
12. **Effort ≈ 45 agent-days** over 7 layers (0–6); walls you can see break and walk through are playable after ≈ 12.

---

## 1. Today [confirmed unless tagged]

| Fact | Where |
|---|---|
| The outer wall is **four single placements**: `res\bldg\china\jangan_enter\cj_n.bsr` (556 × 21 × 20 m, **22 triangles**, 2 meshes), `cj_s` (556 × 39 × 32 m, 1,647 tris, 9 meshes: `CJ_s_wall01/02/03/04/05`, `door`, `roof`, `stair`, `alpha`), `cj_w` and `cj_e` (33 × 39 × 440 m, ≈ 2,350 tris, 14 meshes each, including the SW `CJ_ws_*` and SE `CJ_se_*` corner pieces). Static, `big` flag, group 2, one lightmap per mesh | `manifest.json` placements 2050 (N), 43009 (S), 40962 (W), 45058 (E); glb JSON chunks |
| Placement centres (glTF m): N (86, −396), S (86, 16), W (−177, −188), E (349, −188); yaw 0 | manifest |
| The wall texture `cj_wall01` is 256 × 512 DXT1 and tiles along ≈ 1.4 km of wall | TEXPIPE.md O1 |
| Collision: one solid nav instance per side: `cj_w_stair.bms` (262 cells, 228 outline edges, all blocking), `cj_s_stair.bms` (134 / 142), `cj_e_stair.bms` (269 / 249), `cj_n_wall01.bms` (2 cells, 4 edges). **No links**: the wall walk (19.5–22 m up) is unreachable for walkers | `nav.bin` instances 977, 1009, 1054, 1801 (`MeshNav.isSolid`) |
| **Gates**: straight walks cross only at the W gate (z ≈ −186…−174), the E gate (z ≈ −176…−164) and the S gate (x ≈ 83…115, between pillars). The north side has **no opening**; the "north-gate" place is the palace gate inside | probe walks every 2 m; `content/places.json` note |
| A **ditch** runs outside the W, E and S walls: closed terrain tiles on both rims, an open floor at −4 m (≈ 8 closed samples per crossing line); the N side has ≈ 16 (a wider closed band) | probe scan (`terrainOpen`) |
| Terrain under the wall body is partly **open** (the wall's nav outline does the blocking) and partly closed (E and N) | probe scan |
| The safe area is one rectangle: centre (82.7, −198.8), half 256.0 × 178.7 → x −173.3…338.7, z −377.5…−20.2. The wall's inner faces lie on or just inside it, the outer faces 15–28 m outside | `work/out/data/towns.json`, `GameData.inSafeArea` |
| `inSafeArea` is called from ~20 places (attack gates, mob targeting, skills, lightning, tornado, stalls, winter play, Play the Boss) | grep `inSafeArea` |
| No PvP: `attackRequest` answers `invalid_target 'no PvP'` for a player target | `gameplay.ts attackRequest` |
| Mobs have **no pathfinding**: a move is one straight navmesh chord clipped at the first blocking edge | `nav.ts walk`, `ai.ts` |
| `NavWorld.editInstances` can remove/move/add instances (rebuilds every object; never edits links; returns a remap) | `packages/nav/src/world.ts` |
| The World Editor's Walkable brush is a **build-time** override (`walk/<x>_<z>.png`, applied by the converter's nav step); "a forced-open tile takes an open neighbour's cell"; force-open is refused under a collision footprint's box | WORLD_EDITOR.md §4.7, `nav-edit.ts`, `world-edits/walk.ts` |
| Rendering: static models are thin instances per region chunk or region batch; `WorldObjects.setEditorOwned(pred)` already lets one owner keep placements out of their region and draw them itself (the World Editor uses it) | `world-render/src/objects.ts` |
| Lightning: rods include **wall-walk points every 12 m** on `cj_[nsew]` (386 wall points world-wide); a wall strike has kind `wall`, radius 3 m around the impact on the wall walk; wall walks are the only targets inside a safe area. `onStrike` fires at `warn` and `land` | `lightning/rods.ts`, `select.ts`, `service.ts` |
| Tornado: paths stay ≥ `townMarginM` 90 m from a safe area; `onTornado` fires at `warn`, `lift`, `end` with the whole `TornadoState` (path, timeline) | `packages/shared/src/tornado.ts`, `storm/tornado.ts` |
| Timed item casts exist (the return scroll: interruptible by moving, attacking, warps, death) | `item-use.ts` |
| Associates (party, guild, same account, same IP) and `playerDied(p, now, killer?)` exist from Play the Boss | `pilot/hunt.ts isAssociate`, `modules.ts` |
| Admin route groups: `registerAdminRouteGroup({prefix, handle})`; `siege` is not a reserved prefix | `admin/routes.ts` |
| Migrations: 16 today (next is **17**) | `db.ts` |
| Retail sounds that fit (not exported yet): `bldg/common/structure_dmg.wav`, `structure_destroy.wav` (fortress war), `common/explode_bomb1..4.wav`, `common/stone_bomb.wav`, `env/bell towel 3.wav`; exported: `town/hammer_1..3`, `monster/cm_gstone_thud_a/b` | `work/extracted/Data/prim/snd`, `work/out/sound` |
| Retail art that helps: fortress-war structures with `_dmg` variants (`artifact/guild/fort_stone/*_dmg.bsr`), broken ruin towers and walls already in the export (`w_cd_tower_broken01..03`, `w_cd_castle_wall00..07`) | `work/extracted`, manifest |
| Mobs near Jangan for an army: Bandit (lv 16), Bandit Archer (12), Stone Ghost (9), Tiger (14), White Tiger (18), Chakji (20) (retail levels; CLIMB re-levels them). No siege items exist in `items.json` | `work/out/data/{mobs,nests,items}.json` |
| Open ground for a jail: x −172…−100, z −320…−290 is clear terrain, north of the west camp (tents, catapults, tables at z −285…−262), inside the safe area | open-ground scan |

---

## 2. The walls

### 2.1 Segment plan [decision]

Segments are cut at the wall texture's repeat (so a cut never splits a stone course mid-tile) nearest to the target
length of 48 m. The gatehouses (the `door`, `roof`, `stair`, `alpha` meshes and the wall around the arch) and the two
south corner pieces stay whole and indestructible: they anchor the silhouette and keep three known ways in.

| Side | Wall run (glTF m) | Not destructible | Segments | ≈ length |
|---|---|---|---|---|
| N | x −173…345 at z ≈ −396 | none (no gate) | **N1–N10** | 52 m |
| S | x −182…345 at z ≈ 16 | gatehouse x ≈ 60…140 [likely] | **S1–S5** (west), **S6–S9** (east) | 48 / 51 m |
| W | z −406…31 at x ≈ −177 | SW corner (`CJ_ws_*`), gatehouse z ≈ −220…−140 [likely] | **W1–W4** (north), **W5–W7** (south) | 47 / 45 m |
| E | z −406…32 at x ≈ 349 | SE corner (`CJ_se_*`), gatehouse z ≈ −210…−130 [likely] | **E1–E4** (north), **E5–E7** (south) | 49 / 42 m |
| | | | **33** | |

Each segment has thirds `a`, `b` (middle), `c`. Ids: `N1`…`E7`; a third is `N1b`. The final ends come out of the cut
tool (§3) and are written to `content/siege/jangan.json`; this table is the target.

### 2.2 Integrity and stages

Integrity `ip` is an integer in [−0.5 × max, max]; `max` = 20,000 per segment [decision: one number per segment;
percentages are what players see]. The stage is a pure function `wallStage(ip, max)` in
`packages/shared/src/siege.ts`:

| Stage | Integrity | Looks | Blocks | Safe area behind |
|---|---|---|---|---|
| intact | > 70 % | the cut retail mesh | yes | safe |
| cracked | 0 % < ip ≤ 70 % | crack variant (texture), two stages of cracks (≤ 70 %, ≤ 35 %), chipped crenels | yes | safe |
| breached | −50 % < ip ≤ 0 % | middle third collapsed: broken edges on `a` and `c`, a rubble pile in the gap | **gap of ≈ 16 m** | breach zone unsafe |
| rubble | ip = −50 % | all three thirds down: rubble mound over the whole segment | **gap of ≈ 48 m** | breach zone unsafe (wider) |

Repair climbs the same scale: a rubble segment shows **scaffolding** over `a`/`c` once ip > −50 % (it is "breached"
again, the middle stays open), and the wall closes when ip rises above **+5 %** [decision: a 5 % hysteresis so a
segment hovering at 0 does not flip the nav every hit]. Going down, it breaks at 0.

### 2.3 Damage sources

| Source | Damage | Floor | When |
|---|---|---|---|
| Lightning strike of kind `wall` landing within a segment's span | 3–5 % (seeded by the strike) | **35 %** (never below cracked) | any storm; `onStrike` `land` |
| Tornado near the wall | 1 % per 10 s while the funnel is within 120 m of a segment's outer face | **35 %** | from `onTornado` (`warn` gives the path and timeline; the siege module samples it on its own tick) |
| Siege raider's swing (bandit, tiger) | 40 ip (0.2 %) | −50 % | siege only; when no defender is within 15 m |
| Stone ram (Stone Ghost giant) | 300 ip (1.5 %) every 3 s | −50 % | siege only |
| Sapper's keg | 5,000 ip (25 %) | −50 % | siege only; defusable |
| Bandit Warlord's swing | 600 ip (3 %) | −50 % | siege wave 3 |
| Player Thunder Keg | 12,000 ip (60 %) | −50 % | any time; **makes the planter Wanted if it crosses 0** (§7) |
| GM `wall` | set any value | – | audited |

[decision] Lightning and tornado share one "natural wear" floor: they leave scars and keep repair work alive between
sieges, but never open a hole (the user's rule). A cracked wall is also a hint to players that a keg there breaches.

### 2.4 Repair

| Way | Rate | Cost | Notes |
|---|---|---|---|
| Natural | +1 % per 10 min | – | not during a siege; rubble to closed (+5 %) ≈ 9.2 h, to intact ≈ 20 h |
| Donations to **Master Mason Ko** (new NPC by the south gate) | queued; builders apply ≤ 1 %/min per segment, all damaged segments in parallel, worst first | 1 % = 2,000 gold, or 2 Stone Blocks | the donor picks a segment or "where it is needed"; refunds never; donations stop at 100 % (excess stays queued for the next damage, capped at 50 %) |
| **Mason's Kit** at the wall | +1 % per 10 s channel | 1 kit (1,500 gold at Ko's shop) | within 8 m of the segment, either side; interrupted by damage, moving or a warp; allowed during a siege (repair under fire) |
| GM / admin | any | – | audited |

### 2.5 What a breach changes

- **Nav**: the third's nav instances are disabled and its breach tiles forced open (§4). Anyone walks through.
- **Safe area**: a **breach zone** (a circle of 50 m, 80 m during a siege, centred 10 m inside the gap's middle)
  is no longer safe: mobs may target players there, players may fight there, stalls refuse to open there.
- **Looters** (outside a siege): each breached segment gets a temporary nest of 3 Bandits at the gap (respawn 5 min,
  leash = the breach zone), removed when it closes. This is "monsters walk into town" between sieges [decision].
- **Lightning**: a wall-walk rod over a breached third is skipped (its top is gone); strikes there land as ground.
- **Notices**: the first breach of a segment is a server-wide notice (§9.6); repairs that close it are a chat line.

---

## 3. Assets: cutting the retail walls in Blender

The walls are low-poly (22 to 2,363 triangles a side) with tiled textures, so cutting is cheap and lossless.

### 3.1 Pipeline (one script, `tools/blender/siege_cut_walls.py`, run by the user's Blender 5.2; output committed under `content/siege/models/`)

1. **Import** the four converted glbs (`models/bldg/china/jangan_enter/cj_{n,s,w,e}.glb`) in their placement frame
   (all yaw 0 [confirmed]).
2. **Cut planes**: per side, vertical planes perpendicular to the wall at the segment and third ends from
   `jangan.json` (`bisect` with fill, so every cut face is capped; caps take `cj_wall02` (the wall core) with planar
   UVs at the wall's texel density). UV0 and the lightmap UV1 of the retail faces are kept untouched, so a third
   reuses the retail lightmap texture with no seam.
3. **Variants per third** (glb per third and variant; ≤ 1,500 triangles each):
   - `intact`: the cut retail piece;
   - `crack1`, `crack2`: the same mesh with `cj_wall01_crack1/2` (the retail texture with painted crack overlays, 2
     new textures, same size, run through texpipe) and the crenel tops chipped (a few vertices pulled);
   - `broken_l`, `broken_r` (for `a`, `c` when `b` is gone): a jagged break edge on the gap side (boolean with a
     displaced cutter, capped);
   - `scaffold`: a timber frame from retail props' wood texture (`cj_jang_pondfen` style), 200 triangles.
4. **Debris chunks** for the collapse animation: the middle third fractured into 10–14 convex chunks (Cell Fracture
   add-on), exported as one glb with one node per chunk.
5. **Rubble**: two mound meshes (16 m and 48 m long, ≤ 2.5 m high) built from scaled, re-textured pieces of the
   export's `w_cd_castle_wall0x` and `w_cd_tower_broken0x` with `cj_wall01/02`, plus loose blocks; one shared glb per
   length.
6. **Check**: the union of a segment's three `intact` boxes equals the retail box over that span (±0.3 m); triangle
   counts; every mesh has UV1; written to a report.

Budget: 99 thirds × ≈ 6 variants + 33 debris sets + 2 rubble ≈ 4 MB of glb [projected from the retail 3.0 MB for the
four walls], loaded only near Jangan.

### 3.2 Converter step (`packages/convert/src/world/siege/walls.ts`)

- **Nav split**: clip each retail wall collision navmesh (`cj_{w,s,e}_stair.bms`, `cj_n_wall01.bms`) by the same
  vertical planes into per-third `NavModel`s and add them as `NavInstance`s with ids in a reserved uid range
  (`0xF000 | n` of the wall's region); the cut edges are outline edges flagged blocking; the indestructible parts
  (gatehouses, corners) become their own instances. The four retail wall instances are dropped from `nav.bin` and
  `nav-objects.bin`. Gate: probe walks over all 2 m crossings must give the same result as the retail nav (§14).
- **Breach tiles**: per third, the 2 m terrain tiles to force open when it is gone: those under its collision
  footprint, plus a corridor (the third's width, 30 m out and 10 m in) across the ditch rims, minus sea tiles and
  minus tiles under any other collision footprint (`walkRefusals` rules 2–3). Probe: a straight walk from 10 m inside
  to 30 m outside through the gap's middle must succeed with the third gone; a third whose probe fails is reported
  and the corridor widened by 2 m steps (≤ 3), else the converter stops.
- **Output** `work/out/world/jangan-fields/siege/walls.json`: per third its instance ids, breach tiles (region, tile
  index), assault point (outer face, ground), inner rally point, span on the wall walk (for rods). Server and client
  read it; `content/siege/jangan.json` names the segments and links to it.

---

## 4. Runtime nav

### 4.1 Two seams in `@sro/nav` (`NavWorld`)

| Seam | Does | Cost |
|---|---|---|
| `setInstanceEnabled(index, on)` | a disabled instance is skipped by bucket queries (locate, walk, solid index); `reachCache = null` | O(1) + the next reach rebuild |
| `setTileOverride(regionId, tile, mode: 'open' \| 'closed' \| null)` | `tileState` consults an override map first; a forced-open closed tile takes an open neighbour's cell (the converter's rule, shared from `nav-edit.ts`); `reachCache = null` | O(1) per tile |

[decision] Not `editInstances`: it rebuilds all 2,243 instances and remaps positions; the mask is O(1) and nobody can
stand on a wall third (no links [confirmed]). `MeshNav`'s `SolidIndex` gets the same mask (a disabled solid stops
covering). `world-render/src/nav.ts` (client) exposes both.

### 4.2 One rule for both sides

`wallNav(state) → {disabled: instanceIds[], open: tiles[]}` in `packages/shared/src/siege.ts` from the segment stages
and `walls.json`: a third is down when its segment is breached (`b`) or rubble (`a`, `b`, `c`). The server applies it
on every stage change; the client applies it on `walls` / `wallUpdate`, so KeyMover prediction and the server walk
agree. A body standing in a gap when it closes is re-placed with `place(x, z, y, 6)` (the existing rescue).

### 4.3 Gate wards (mob-only) [decision]

During a siege the three gates are warded: a short line across each arch (from `jangan.json`). A **siege mob's**
walk (march, chase, flee) that crosses a ward line is clipped there (`World.walkEntity`, mobs with `m.siege` set, one
segment-intersection test per walk against three lines). Players pass freely ("the guards open for their own").
Without this the army walks in by the gates and the walls never matter.

---

## 5. Server design

### 5.1 Module and files

`apps/server/src/siege/`: `walls.ts` (WallService: state, damage, stages, repair, nav apply, persistence),
`event.ts` (the siege state machine, waves, lanes, objectives, rewards), `army.ts` (siege mob behaviour), `keg.ts`
(Thunder Keg and sapper kegs), `law.ts` (wanted, capture, jail), `jobs.ts` (Hunter licence and duty), `store.ts`
(SQL), `settings.ts`, `admin.ts`, `gm.ts`. Two GameplayModules: `walls` (always on with a mesh nav and a
`walls.json`) and `siege` (event + law + jobs), registered after `lightning` and `tornado`.

### 5.2 Seams elsewhere

| File | Seam | Why |
|---|---|---|
| `packages/nav/src/world.ts`, `apps/server/src/nav.ts` | §4.1 | gaps |
| `gamedata.ts` | `inSafeArea` also returns false inside an `unsafeAt(x, z)` predicate the walls module sets (breach zones); the town rectangle stays content | one seam for ~20 callers |
| `world.ts` | `Mob.siege?: SiegeMobState`; `walkEntity` asks `siege.clip(m, from, to)` for mobs with `m.siege`; `EntityState.wanted`, `hunter`, `jailed` | wards; markers |
| `gameplay.ts` | `attackRequest`, skill targeting and `attackable`: a player target is allowed when `pvpAllowed(p, t)` (§8.3); `dealHits` player → player uses `pvpDamage`; at 0 HP a Wanted target hit by a Hunter goes to `law.subdue` instead of death | the only PvP |
| `formulas.ts` | `pvpDamage` = the player → mob formula against the target's player defence × `pvpMul` 0.5 | captures take time |
| `ai.ts` | `thinkMob` skips mobs whose `m.siege.mode` is `march` / `assault` (the army drives them) | lanes |
| `item-use.ts` | item `use.kind: 'keg' \| 'masonKit'` routed to the siege module (a timed cast, as the return scroll) | plant / repair |
| `lightning/service.ts` | none: the module subscribes `onStrike`; `select.ts` asks `walls.rodUp(x, z)` to skip downed rods | chips |
| `storm/tornado.ts` | none: `onTornado` | wear |
| `connection.ts` / gates | jailed players' requests refused (`jailed`) except the list in §8.5; their `moveTo` clamped into the stockade | jail |
| `progression.ts` (death penalty) | no EXP loss for a PvP death (Hunter or Wanted) | fairness |

### 5.3 State and persistence

The walls module keeps 33 `{id, ip, stage, queued, lastCause, lastAt}` in memory, writes a row on every stage change
and at most every 30 s per segment otherwise, and restores them at boot (the nav is applied before the first player
enters). The siege module persists its phase like `pilot_events` (§10). Repair and damage events go to `wall_log`.

---

## 6. The Siege of Jangan

### 6.1 States

```
idle ── schedule / GM / admin ──► warning (10 min) ──► wave1 ──► wave2 ──► wave3 (+Warlord) ──► ended
                                                       ▲ each wave starts at its time or when the last is 80 % dead
ended: won (Warlord dead) | lost_bell | lost_time | cancelled | restart
```

### 6.2 Phases

| Phase | Starts / lasts | Server | Everyone sees |
|---|---|---|---|
| warning | 10 min before wave 1 | picks 2 of 4 approaches (seeded: W road, S fields, E road, N fields); spawns the musters ≥ 350 m out | the alarm bell (3 tolls), banner "Scouts report an army marching on Jangan from the west and south!", countdown; chat lines at 10, 5, 1 min |
| wave 1 | t = 0 | per approach: 12 raiders + 2 sappers march their lane | siege HUD: wave, timer, bell HP, wall strip |
| wave 2 | t + 8 min | per approach: 14 raiders, 6 archers, 3 sappers, 2 stone rams | |
| wave 3 | t + 16 min | the **Bandit Warlord** (one approach), 10 elite raiders, 2 rams per approach | banner "The Bandit Warlord leads the final assault!" |
| ended | Warlord killed (**won**); the Town Bell destroyed (**lost_bell**); t + 35 min with the Warlord alive (**lost_time**) | rewards (§6.6); living siege mobs flee to their lanes and despawn in 60 s; breaches stay | result banner + chat line, top defenders named |

### 6.3 Lanes and behaviour

- **Lanes** (`jangan.json`): per approach, waypoints from the muster to an assault point at each of its segments,
  and from each gap's inner rally point to the plaza. At boot every leg is checked with a straight `nav.walk` (all
  walls intact and with that segment down); a failing leg is logged and the lane dropped (as the tornado path is
  checked) [decision: authored, not pathfound; mobs have no pathfinding today].
- **March**: formation (3 abreast, 2.5 m spacing) at walk speed; the module moves them (`world.moveEntity` per leg).
- **Engage**: a player within 15 m of a marching mob → normal `thinkMob` chase with home = the nearest lane point and
  leash 40 m; back to the lane when no target.
- **Assault**: at its assault point, a raider swings at the wall (its ATTACK01 `cast` toward the wall point, §9) when
  no defender is within 15 m; a sapper plants (8 s, killable) then a 12 s fuse (defusable, §7.1); a ram hits every 3 s.
  Archers stand 25 m out and shoot defenders.
- **Breach**: when its segment is down, the mob takes the inner lane to the plaza and attacks the **Town Bell**, or
  defenders on the way. Mobs never use gates (wards).
- **Town Bell**: a static attackable structure entity (a `Mob` with a stone-bell model, `ai: 'none'`, immune to
  players, 30,000 HP, no regen) at the plaza (97, −63); lost → `lost_bell`. Restored to full at the end.

### 6.4 Scaling

N = players level ≥ 10 within 600 m of the town centre, sampled at each wave start. s = clamp(N / 5, 1, 6)^0.8.
Raider, archer and sapper counts × s (rounded); rams and the Warlord do not multiply; the Warlord's HP =
60,000 × s^0.9.

| Defenders N | s | Wave 1 per approach (raiders / sappers) | Warlord HP |
|---|---|---|---|
| 1–5 | 1.00 | 12 / 2 | 60,000 |
| 10 | 1.74 | 21 / 3 | 98,600 |
| 20 | 3.03 | 36 / 6 | 162,400 |
| 30+ | 4.19 | 50 / 8 | 218,600 |

[projected] With 30 defenders the server holds ≈ 2 × (50 + 14 + 8 …) ≈ 150 siege mobs at the peak; §15 gates it.

### 6.5 Roster (from existing mob defs; variants already exist)

| Role | Def | Variant | Notes |
|---|---|---|---|
| raider | `MOB_CH_BANDIT`, `MOB_CH_TIGER` | normal | elite raiders in wave 3: `champion` |
| archer | `MOB_CH_BANDITARCHER` | normal | |
| sapper | `MOB_CH_BANDIT` | normal, 60 % HP, 0.8 × speed, a keg on its back (client prop) | |
| stone ram | `MOB_CH_STONEGHOST` | `giant` | |
| Warlord | `MOB_CH_BANDIT` | a `content/uniques.json`-style entry `SIEGE_BANDIT_WARLORD` (name, hpMul, scale 1.6) | not a world unique: no timer, only the siege spawns it |

Siege mobs give 50 % EXP and no item drops (they drop Saltpeter at 2 %) [decision: a siege is not a farm].

### 6.6 Rewards and failure

Contribution points: 1 per 100 damage to siege mobs, 20 per sapper killed before planting, 30 per keg defused, 10 per
1 % repaired with a kit, 5 per 2,000 gold donated (≤ 50 per siege), 15 per Bell repair hit. Associates and AFK
(< 20 points) get nothing.

| Outcome | Gold | Siege Seals | Title |
|---|---|---|---|
| won | 50 × points (≤ 30,000) | points / 50 (≤ 10) | "Defender of Jangan" to the top 3 and to anyone ≥ 300 points (permanent, `EntityState.honor`) |
| lost | 25 % of that | 0 | – |

Seals buy Mason's Kits, Stone Blocks, a Hunter's Net (§8.4), later cosmetics, at Ko and Captain Yun.
**Failure** [decision]: no shop or town penalty; the breaches stay open, looters move in (§2.5), and the notice says so.
Repairing becomes the community's job.

### 6.7 Schedule, restarts

- Weekly slots in the admin panel (default Sunday 20:00, server time zone, **disabled** until the user enables it),
  plus GM/admin start. A slot with fewer than 5 eligible players online is skipped and logged.
- Not during a Night of the Tiger hunt (the later one waits 30 min) [decision: one big event at a time].
- Restart: warning → resumes with ≥ 3 min left; a wave phase → `restart` (no rewards, siege mobs gone; wall states
  persisted as they were).

---

## 7. Siege items

| Item | Get | Cost | Use | Limits |
|---|---|---|---|---|
| **Thunder Keg** | crafted by **Old Fang the Fence** (new NPC, a bandit-side camp ≈ 600 m west of town, outside the safe area) | 50,000 gold + 3 Saltpeter | plant at a segment's **outer** foot (within 6 m of the outer face, outside the safe area): 5 s timed cast, then a 15 s fuse; 60 % damage | level 18; ≥ 10 h `played_ms`; character-bound (no trade, stall, storage, drop); carry ≤ 2; one plant per **account** per 30 min; refused for an on-duty Hunter and while jailed |
| **Mason's Kit** | Ko's shop | 1,500 gold | §2.4 | stack 20 |
| **Stone Block** | Stone Ghost drops (8 %), Ko's shop (1,200) | – | donation material (2 = 1 %) | stack 50 |
| **Saltpeter** | Bandit and Bandit Archer drops (2 %), siege mobs (2 %) | – | keg material | stack 50 |
| **Hunter's Net** | Captain Yun for 2 Siege Seals or 8,000 gold | – | a Hunter's thrown snare at a Wanted player within 12 m: 2 s root (existing `root`-like status), 60 s cooldown | Hunters on duty only |

### 7.1 The keg in the world

At the plant the keg becomes a small entity (id, model, position) everyone in range sees with a burning fuse; the
server sends `keg {fuseEndsAt}`. **Defuse**: any player (not the planter's associates) clicks it: a 3 s cast within
3 m, interrupted by damage. Blast: wall damage to the segment whose span contains the keg; players and mobs within
6 m take 25 % of max HP (hazardHit, cause `keg`, non-lethal for players) and a 1.5 s knockdown. Sapper kegs work the
same.

---

## 8. Wanted, Hunters and the jail (the minimal job system)

### 8.1 From a blast to Wanted

1. **Plant** (player keg): notice to every world socket "Someone is planting a Thunder Keg at Jangan's West wall!"
   (no name: the planter can still be stopped), the keg on the minimap for everyone within 300 m.
2. **Blast** that takes the segment's integrity to ≤ 0: the **wall-breaker** is the planter of that keg. Every other
   player whose keg damaged that segment in the last 10 min is an **accomplice**.
3. Notice "**<Name> has breached Jangan's West wall! A bounty of 20,000 gold is posted.**" (server-wide, NoticeBanner
   `kind: 'siege'`), chat line, alarm bell.
4. A blast that does not breach: no Wanted, but the damage is remembered for 10 min (step 2) and logged.

**Wanted** (warrant): bounty = 20,000 × min(offence, 4) (accomplice: half, half the sentence). A red **WANTED** label
line over the character for everyone; on-duty Hunters get a `wantedPing` (a circle of 80 m around a point ≤ 50 m from
the target) every 60 s, and see the Wanted on their minimap within 120 m. The warrant **lapses** after 2 h of the
Wanted's **online** time without capture: no jail, no bounty paid, but the offence still counts [decision: escaping is
part of the game; the clock only runs online so logging off cannot outwait it]. During a siege the sentence and the
bounty are ×2 ("treason") [decision].

### 8.2 Hunters

- **Licence** from **Captain Yun** (new NPC by the west gate, x ≈ −145, z ≈ −200): level ≥ 15, 10,000 gold, not
  Wanted, no offence in the last 30 days. Permanent unless revoked (a GM, or the Hunter breaks a wall: revoked for
  30 days).
- **On duty** (toggle at Yun or a HUD button, only in a safe area and out of combat): a blue Hunter badge on the
  label; sees pings; may fight the Wanted. **Off duty** is refused for 2 min after the last PvP hit (no escaping a
  fight).
- **Rank** 1–5 by captures (1, 3, 10, 25, 60): a label title and later the Trader-escort tie-in; no stat bonuses.

### 8.3 The PvP rule (`packages/shared/src/law.ts pvpAllowed(a, b)`)

| Attacker | Target | Allowed | Where |
|---|---|---|---|
| on-duty Hunter | Wanted (not an associate of the Hunter) | yes | anywhere but the stockade, including the safe area [decision: town cannot be a permanent sanctuary] |
| Wanted | on-duty Hunter | yes | same |
| anyone | anyone else | no (today's `no PvP`) | – |

Later rows (not built): Thief vs Trader on a trade run, Hunter vs Thief, Trader's escort. Damage between players uses
`pvpDamage` (§5.2). Skills with area effects hit only bodies `pvpAllowed` lets them hit. Party heals and buffs are
unchanged.

### 8.4 Capture

A Wanted at 0 HP from a Hunter's hit (or a Hunter's DoT) is **subdued**: HP set to 1, a 3 s bound pose (`subdued`
status: no actions), then `World.warp` to the stockade + `Gameplay.warped(p, 'gm')`. No death, no EXP loss, no item
drop [decision: the jail is the penalty]. The bounty is split among the Hunters (not associates of the Wanted) who
dealt ≥ 10 % of the Wanted's max HP in the last 90 s, by damage; the same Hunter account capturing the same Wanted
account again within 7 days gets 0 gold (still counts as a capture). If the Wanted dies to a monster or lightning the
warrant stays. **Combat logout**: a Wanted who disconnects within 30 s of a Hunter's hit is captured on the spot
(sentence served from the next login if the clock is `online`), bounty to those Hunters.

### 8.5 The Garrison Stockade

- **Where**: x −165…−135, z −318…−296 (30 × 22 m of open terrain north of the west camp, inside the safe area
  [confirmed open]). A `jail` place in `content/places.json`. The fence, the gate, a watch-tower and benches are
  World Editor placements of retail props (`cj_mili_smallwall`, `w_cd_mc_bari_body`, tents, `cj_table`): no new art.
  The fence's collision keeps visitors out except through a 3 m gate where **Warden Bae** (NPC) stands; visitors may
  walk up to the bars.
- **Holding**: the prisoner's `moveTo` targets are clamped into the stockade rectangle (as Play the Boss clamps the
  hunt circle) [decision: no sealed nav component, so `MeshNav.place`'s home-component rule needs no exception].
- **Can**: walk, sit, emote, all chat channels, look at the inventory and equipment, party chat, talk to Warden Bae
  (time left, offence, rules), **chores** (§ below).
- **Cannot** (`jailed` refusal): attack, skills, items except food and potions, return scrolls, teleports, mount,
  trade, stall, storage, shops, quest turn-ins, keg, Hunter duty, Play the Boss, siege rewards.
- **Chores**: break a rock at the pile (10 s channel) = −1 min, up to 25 % of the sentence [decision: something to
  do, and a reason to stay online].
- **Clock**: **real time**, offline included [decision: a couple of real hours is the user's intent; `sentenceClock:
  'online'` is a setting]. On login while serving: placed in the stockade.
- **Sentences** (per **account**, so alts share the record):

| Offence | Sentence | Bounty |
|---|---|---|
| 1st | 2 h | 20,000 |
| 2nd | 4 h | 40,000 |
| 3rd | 8 h | 60,000 |
| 4th | 16 h | 80,000 |
| 5th+ | 24 h (cap) | 80,000 |

  One offence level is forgiven per 30 days without an offence. Accomplices: half (≥ 1 h). Treason ×2 (cap 24 h).
- **Release**: at the end, the character is warped to the stockade gate with 10 min of **pardon** (cannot be Wanted
  from old damage; not a Hunter target); chat "You have served your sentence."

### 8.6 Anti-abuse

| Abuse | Guard |
|---|---|
| alt breaks, friend hunts (bounty farm) | associates (party, guild, same account, same IP) cannot claim; 7-day pair rule; a keg (50,000 + materials) costs more than the bounty it creates |
| alts rotating offences | offences per account; keg needs level 18 + 10 h played; character-bound kegs; 30 min per-account plant cooldown |
| griefing Hunters | Hunters can only hit the Wanted; off-duty lock after PvP; licence revocable; no PvP EXP loss |
| hiding in town | the safe area does not protect the Wanted from Hunters |
| logging out | the warrant clock runs online only; combat logout = capture |
| false reports | impossible: the server alone issues warrants, from the blast it computed |
| camping the jail exit | 10 min pardon; release inside the safe area |
| kegs on the inner face / from town | plant only within 6 m of the outer face and outside the safe area |
| notice spam | at most one plant notice per segment per 2 min, one breach notice per segment per breach |
| siege sabotage | kegs during a siege count as treason (×2) |
| GM misuse | every `siege`, `wall`, `law` command and admin write audited |

### 8.7 How this grows into the trade-run job war (not built now)

`char_jobs` already has a `job` column (`hunter` now; `trader`, `thief` later) and a rank; `warrants.reason` takes
`'wall'` now and `'robbery'` later; `pvpAllowed` is one table. When trade runs land: a Thief who robs a caravan gets a
`robbery` warrant (same Wanted, ping, capture and jail), Traders can hire on-duty Hunters as escorts (a party flag),
and Hunter ranks gain trade-run perks. Nothing in this spec needs to be undone for that.

---

## 9. Client design

### 9.1 The walls feature (`apps/game/src/world/features/walls.ts`, `world/walls/`)

- Takes the four retail wall placements out of their regions through a generalised S-OBJ seam: `WorldObjects`
  `setEditorOwned` becomes a list of owners (`addOwner(pred)`), so the World Editor and the walls feature can both own
  placements [decision: a small change in `objects.ts`].
- Draws the 33 segments as its own meshes (thin instances per variant; three thirds per segment pick their variant
  from the stage), with the retail lightmaps and the world's object materials (Classic and PBR both, since the
  variants are only meshes and textures). Loaded when the camera is within 900 m of the town centre.
- Applies `wallNav` to the client nav on every change (§4.2).
- Gatehouses and corners are separate static glbs from the cut (always intact).

### 9.2 Visuals per event

| Event | Effect |
|---|---|
| chip (lightning, tornado, raider hit) | dust puff + 6–10 stone bits from the impact point (one thin-instanced debris pool), `structure_dmg` |
| stage → cracked (70 %, 35 %) | swap to `crack1` / `crack2`; a burst of dust along the segment |
| breach | the middle third swaps to its debris chunks: a 2.5 s fall (gravity, spin, ground bounce once), then sinks into the rubble mound; a dust cloud 20 m wide lingering 8 s; camera shake within 150 m (0.3 s); `structure_destroy` + `explode_bomb2`; the rubble pile appears under the dust |
| rubble | the same for `a` and `c`, then the long mound |
| repair | scaffold on, hammer sounds (`hammer_1..3`) every 2–4 s while builders or kits work; swaps back to `crack2` → `crack1` → `intact` on the way up |
| keg | a keg prop with a sparking fuse (existing spark fx), a ticking loop, the blast (`explode_bomb1`), a scorch decal for 2 min |

### 9.3 HUDs

- **Siege HUD** (top centre, under notices): wave n / 3, time left, Town Bell HP bar, a strip of 33 wall pips
  coloured by stage, "N defenders". The minimap and the world map draw the wall as segments coloured by stage, breach
  zones as red rings, kegs as blinking icons.
- **Wanted**: the label line "WANTED · 40,000" in red over the character; the Wanted player's own HUD shows "Wanted:
  1:42:10 until the warrant lapses" and the warning "Hunters can attack you anywhere".
- **Hunter**: duty toggle, rank, captures; ping circles on the minimap; the Wanted's minimap dot within 120 m.
- **Jail**: "Garrison Stockade · 1:47:33 left · offence 2" and the chores counter.
- Notices go through the existing NoticeBanner queue with `kind: 'siege'` (plant, breach, captured, siege phases).

### 9.4 Sounds (export added to the sound step; all retail)

| Use | File |
|---|---|
| wall chip | `bldg/common/structure_dmg.wav` |
| breach / collapse | `bldg/common/structure_destroy.wav` + `common/explode_bomb2.wav` |
| keg blast | `common/explode_bomb1.wav`, `common/stone_bomb.wav` |
| stone falls | `monster/cm_gstone_thud_a/b` (exported) |
| alarm bell | `env/bell towel 3.wav` (exported as `env/bell_towel_3.ogg`) |
| repair | `town/hammer_1..3` (exported) |

### 9.5 i18n (`apps/game/src/i18n/en-siege.ts`)

`siege.{phase,wave,bell,defenders,won,lost,warning,approach.*}`, `wall.{N1..E7 names via side},stage.*,repair.*`,
`keg.{plant,defuse,fuse,blast}`, `law.{wanted,lapse,captured,jail,chores,pardon,released}`,
`hunter.{licence,duty,rank,net}`, `notice.siege.*`, `fail.{jailed,not_hunter,wall_far,keg_limit}`.

---

## 10. Protocol (v1, additive) and migrations

### 10.1 Client → server (`GameplayRequest`s, answered by `actionResult`)

```ts
| { t: 'wallRepair'; seg: string }                             // Mason's Kit channel; 1/s
| { t: 'wallDonate'; npc: number; seg?: string; gold?: number; blocks?: number }   // 1/s
| { t: 'kegDefuse'; id: number }                               // 2/s
| { t: 'hunterDuty'; on: boolean }                             // 1/s
| { t: 'hunterLicence'; npc: number }                          // 1/s
| { t: 'hunterNet'; target: number }                           // 1/s
| { t: 'jailChore' }                                           // 1/s
// Keg plant: the existing itemUse {bag}; the server finds the segment from the player's position.
```

`ActionFailReason` += `'jailed' | 'not_hunter' | 'wall_far' | 'keg_limit'`.

### 10.2 Server → client

```ts
| { t: 'walls'; segs: WallSegView[] }                       // on enter-world and on bulk changes (GM, restore)
| { t: 'wallUpdate'; id: string; stage: WallStage; pct: number; at: number }    // ≤ 1/s per segment
| { t: 'wallFx'; id: string; kind: 'chip' | 'crack' | 'breach' | 'collapse' | 'repair'; x: number; y: number; z: number; at: number }
| { t: 'siegeEvent'; view: SiegeView }                      // world sockets, on change
| { t: 'keg'; id: number; seg: string; x: number; y: number; z: number; fuseEndsAt: number; sapper?: true }
| { t: 'kegEnd'; id: number; how: 'blast' | 'defused' | 'cancelled' }
| { t: 'siegeNotice'; event: 'plant' | 'breach' | 'captured' | 'lapsed' | 'phase'; wall?: string; name?: string; bounty?: number }
| { t: 'wantedPing'; id: number; x: number; z: number; r: number; at: number }   // on-duty Hunters
| { t: 'lawState'; wanted?: { bounty: number; lapseMs: number }; jail?: { until: number; offence: number; chores: number }; hunter?: { licensed: boolean; onDuty: boolean; rank: number; captures: number } }

type WallStage = 'intact' | 'cracked' | 'breached' | 'rubble'
interface WallSegView { id: string; stage: WallStage; pct: number; scaffold?: true }
interface SiegeView { id: number; phase: 'warning' | 'wave1' | 'wave2' | 'wave3' | 'ended'; startsAt?: number; endsAt?: number;
  approaches: string[]; bellPct?: number; defenders?: number; outcome?: 'won' | 'lost_bell' | 'lost_time' | 'cancelled' | 'restart' }
```

`EntityState` += `wanted?: number` (bounty, players), `hunter?: number` (rank, on duty), `jailed?: true`; the same on
`entityUpdate`. A siege mob's wall swing is today's `cast` with an additive `at?: Vec3` (a ground point instead of a
target). Validators in `validate.ts`; the mock server answers `/wall` for the client lane.

### 10.3 Migrations

```sql
-- 17 (layer 1): the walls
CREATE TABLE wall_segments (world TEXT NOT NULL, id TEXT NOT NULL, ip INTEGER NOT NULL, stage TEXT NOT NULL,
  queued INTEGER NOT NULL DEFAULT 0, last_cause TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (world, id));
CREATE TABLE wall_log (id INTEGER PRIMARY KEY, world TEXT NOT NULL, seg TEXT NOT NULL, at INTEGER NOT NULL,
  cause TEXT NOT NULL,            -- lightning, tornado, raider, ram, sapper, warlord, keg, natural, builders, kit, gm
  delta INTEGER NOT NULL, stage TEXT NOT NULL, character_id INTEGER, data TEXT NOT NULL DEFAULT '{}');
CREATE INDEX wall_log_at ON wall_log(at);

-- 18 (layer 4): the siege
CREATE TABLE siege_events (id INTEGER PRIMARY KEY, origin TEXT NOT NULL, phase TEXT NOT NULL, created_at INTEGER NOT NULL,
  wave1_at INTEGER, ended_at INTEGER, outcome TEXT, approaches TEXT NOT NULL, defenders INTEGER NOT NULL DEFAULT 0,
  breaches INTEGER NOT NULL DEFAULT 0, stats TEXT NOT NULL DEFAULT '{}');
CREATE TABLE siege_log (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES siege_events(id) ON DELETE CASCADE,
  at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');
CREATE TABLE siege_contrib (event_id INTEGER NOT NULL, character_id INTEGER NOT NULL, points INTEGER NOT NULL,
  gold INTEGER NOT NULL DEFAULT 0, seals INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (event_id, character_id));
CREATE TABLE siege_settings (code TEXT PRIMARY KEY, json TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL, updated_by INTEGER);

-- 19 (layer 5): jobs and the law
CREATE TABLE char_jobs (character_id INTEGER NOT NULL, job TEXT NOT NULL, rank INTEGER NOT NULL DEFAULT 1,
  points INTEGER NOT NULL DEFAULT 0, licensed_at INTEGER NOT NULL, revoked_until INTEGER, on_duty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (character_id, job));
CREATE TABLE warrants (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, character_id INTEGER NOT NULL,
  reason TEXT NOT NULL,           -- 'wall' now; 'robbery' later
  role TEXT NOT NULL,             -- 'breaker' | 'accomplice'
  wall TEXT, offence INTEGER NOT NULL, bounty INTEGER NOT NULL, treason INTEGER NOT NULL DEFAULT 0,
  issued_at INTEGER NOT NULL, online_ms_left INTEGER NOT NULL,
  status TEXT NOT NULL,           -- 'open' | 'captured' | 'lapsed' | 'pardoned'
  closed_at INTEGER, captors TEXT NOT NULL DEFAULT '[]');
CREATE INDEX warrants_open ON warrants(status, character_id);
CREATE TABLE jail_terms (character_id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, warrant_id INTEGER,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, served_ms INTEGER NOT NULL DEFAULT 0, chores INTEGER NOT NULL DEFAULT 0);
CREATE TABLE law_records (account_id INTEGER PRIMARY KEY, offences INTEGER NOT NULL DEFAULT 0, last_offence_at INTEGER);
```

---

## 11. Settings and the admin panel

### 11.1 Where [decision, as Play the Boss §6.1]

Defaults in `content/siege/jangan.json` (segments, lanes, places, roster, numbers), reviewed in git and checked at
start; a sparse DB patch `siege_settings` for the operator's live numbers and schedule, validated by the same checker
(`checkSiegeSettings` and `SIEGE_BOUNDS` in `packages/shared/src/siege.ts`).

### 11.2 Settings (editable defaults)

| Group | Field | Default | Bounds |
|---|---|---|---|
| walls | `maxIp`, `crackedPct`, `closePct`, `rubblePct` | 20,000, 70, 5, −50 | 1,000–200,000; 10–95; 0–30; −100–−10 |
| wear | `lightningPct` [lo, hi], `tornadoPctPer10s`, `tornadoReachM`, `naturalFloorPct` | [3, 5], 1, 120, 35 | 0–20; 0–10; 0–300; 0–95 |
| repair | `naturalPctPer10Min`, `goldPerPct`, `blocksPerPct`, `builderPctPerMin`, `kitPct`, `kitChannelS`, `kitPrice` | 1, 2,000, 2, 1, 1, 10, 1,500 | 0–10; 100–100,000; 1–20; 0–10; 0–10; 2–60; 0–100,000 |
| breach | `zoneM`, `siegeZoneM`, `looters`, `looterRespawnMin` | 50, 80, 3, 5 | 0–200; 0–300; 0–10; 1–60 |
| siege | `enabled`, `slots`, `warningMin`, `waveGapMin`, `durationMin`, `minPlayers`, `approaches` | false, `[{0, '20:00'}]`, 10, 8, 35, 5, 2 | –; 0–7 slots; 1–30; 3–30; 15–90; 0–100; 1–4 |
| army | wave tables (counts per role), `raiderIp`, `ramIp`, `sapperIp`, `warlordIp`, `warlordHp`, `scaleDiv`, `scaleCap`, `scaleExp`, `expMul` | §6.2, 40, 300, 5,000, 600, 60,000, 5, 6, 0.8, 0.5 | sane ranges |
| bell | `hp` | 30,000 | 1,000–500,000 |
| rewards | `goldPerPoint`, `goldCap`, `pointsPerSeal`, `sealCap`, `lossShare`, `titleTop`, `titlePoints`, `minPoints` | 50, 30,000, 50, 10, 0.25, 3, 300, 20 | 0–1,000,000 each |
| keg | `damagePct`, `plantS`, `fuseS`, `defuseS`, `cooldownMin`, `minLevel`, `minPlayHours`, `gold`, `saltpeter` | 60, 5, 15, 3, 30, 18, 10, 50,000, 3 | … |
| law | `bountyBase`, `bountyCapMul`, `wantedOnlineHours`, `accompliceWindowMin`, `sentencesH`, `forgiveDays`, `treasonMul`, `sentenceClock`, `choresCapPct`, `pardonMin`, `pairCooldownDays` | 20,000, 4, 2, 10, [2, 4, 8, 16, 24], 30, 2, 'real', 25, 10, 7 | … |
| hunter | `minLevel`, `licenceGold`, `cleanDays`, `offDutyLockMin`, `pingSec`, `pingR`, `senseM`, `pvpMul`, `ranks` | 15, 10,000, 30, 2, 60, 80, 120, 0.5, [1, 3, 10, 25, 60] | … |

### 11.3 Routes (`registerAdminRouteGroup({prefix: 'siege'})`, admin role, `gm_audit` per write)

| Method, path | Does |
|---|---|
| GET `/api/admin/siege` | walls (stage, %, queued), current event, next slot, settings `{defaults, patch, effective, rev, bounds}` |
| PUT `/api/admin/siege/settings` / POST `…/settings/reset` | patch with `baseRev` (409 stale, 422 issues) |
| POST `/api/admin/siege/start` `{warningMin?}` / `stop` | the event |
| POST `/api/admin/siege/wall` `{seg, pct}` / `{seg: 'all', repair: true}` | set or repair |
| GET `/api/admin/siege/events[/:id]` | log, contributors |
| GET `/api/admin/siege/law` | open warrants, jail terms, records, hunters |
| POST `/api/admin/siege/law/pardon` `{character}` / `jail` `{character, minutes, reason}` / `release` / `hunter` `{character, action: 'revoke' \| 'restore'}` | the law |

### 11.4 The panel page ("Siege of Jangan")

1. **Walls**: a top-down diagram of the four sides with the 33 segments coloured by stage and %, queued repair; click
   a segment to set its % or repair it; "Repair all".
2. **Now**: phase, countdown, approaches, defenders, Bell HP, Warlord HP; Start (warning minutes), Stop (confirm).
3. **Schedule** and **Numbers** (§11.2 groups as forms, per-field reset, bounds, inline 422s).
4. **Events**: date, origin, outcome, breaches, defenders, top contributors; detail with the log.
5. **Law**: open warrants (name, bounty, online time left), jailed (time left; release, add time), records (offences;
   forgive), Hunters (rank, captures; revoke).

---

## 12. GM commands (audited)

| Command | Does |
|---|---|
| `wall` | status of all 33 (stage, %) |
| `wall <seg> <pct>` / `wall <seg> intact\|cracked\|breached\|rubble` | set |
| `wall repair <seg\|all>` / `wall break <seg>` | full repair / breach now (as a GM cause, no Wanted) |
| `siege start [warningMin]` / `stop` / `status` / `wave <1-3>` / `warlord` | the event |
| `law wanted <name> [off]` / `law jail <name> <minutes> [reason]` / `law release <name>` / `law pardon <name>` / `law forgive <name>` | the law |
| `law hunter <name> licence\|revoke\|duty on\|off` | Hunters |

---

## 13. Balance defaults in one place [projected]

- Two player kegs breach an intact segment (60 + 60 > 100); one keg breaches a segment already at ≤ 60 %, which
  storms alone can bring a wall to over days. A breach costs a breaker ≥ 100,000 gold + 6 Saltpeter; the bounty is
  20,000–80,000.
- A wave-1 approach (12 raiders, 2 sappers) unopposed: sappers 2 × 25 % + raiders 12 × 0.2 % per 2 s ≈ 1.2 %/s → an
  intact segment breaches in ≈ 1 min after the sappers blow. Defended: kill the sappers (lane walk ≈ 2 min from the
  muster) and the raiders' 40 ip hits barely dent a wall.
- Rubble to closed by builders alone with enough donations: 55 % at 1 %/min ≈ 55 min, costing 110,000 gold; by nature
  alone ≈ 9 h.
- Capture: a Wanted lv 20 vs two Hunters at `pvpMul` 0.5 ≈ 20–40 s of fighting [projected from player → mob DPS ≈ 50/s,
  UNIQUES §4.1, and player HP ≈ 2,000 at level 20].

---

## 14. Tests

**Unit (vitest)**: `wallStage`, hysteresis at +5 %, floors (lightning and tornado never below 35 %, never breach);
repair (natural, queue, builder rate, kit cap, no repair during a siege by nature); `wallNav` (thirds per stage);
`@sro/nav` disabled mask and tile override (a disabled solid stops covering; forced-open tile takes a neighbour's cell;
reach cache invalidated); safe-area seam (a point in a breach zone is unsafe; outside it safe); gate ward clip;
`pvpAllowed` table exhaustively; sentences and forgiveness; bounty split and the 7-day pair rule; associates; lanes
validated (a broken leg is dropped); wave scaling table of §6.4 exactly; settings bounds and patch merge.

**Converter**: nav split: with every third enabled, 2,000 random chords near the walls give the same end point and
blocked flag as the retail nav (±1 cm); each third's breach probe walks through; triangle and bounds checks on the cut
glbs; `walls.json` schema.

**Integration (in-process server, bot clients)**: GM `wall break W3` → a bot walks through the gap, a second bot's
client-side prediction agrees; lightning at a wall chips to the floor and stops; a tornado path near the E wall wears
it; restart keeps the stages and the gap; keg: plant, notice, defuse by another bot; keg blast breaches → wanted notice,
WANTED label, a Hunter bot on duty attacks, 0 HP → subdued → stockade; jail refusals for each request; relog in jail;
sentence ends offline (real clock); combat logout = capture; warrant lapses after 2 h online (fast clock). A mini
siege with 3 bot defenders: lanes march, sappers plant, a breach, mobs reach the Bell, the Warlord dies → won and
rewards; a second run lost on the Bell.

**Abuse** (`abuse-siege.test.ts`): kegs from inside the town, on the inner face, from an alt below level 18, a third
keg carried, a second plant within 30 min on another character of the account; Hunter attacking a non-Wanted, an
off-duty Hunter, a Wanted attacking a non-Hunter; Hunter capturing an associate (no bounty); jailed player's
`moveTo` 200 m away (clamped), `itemUse` a return scroll, `trade`; `wallRepair` from 50 m; donation with negative gold.

**Client**: the walls feature hides the four retail placements and draws 33 segments; a stage change swaps variants;
the collapse animation ends in the rubble state with no leftover chunks; the nav in the client walks through a gap;
Classic and PBR both render a cracked variant (render-lab scene "south wall breach").

**Load**: `siege-load.ts` (soak style): 30 bot defenders and a scaled siege (≈ 150 mobs); pass: tick p99 < 50 ms and
the event-loop lag of today's Play the Boss load gate.

---

## 15. Build layers (each playable alone)

| Layer | Delivers | Gate |
|---|---|---|
| **0. Cut** | the Blender script and cut glbs (§3.1), the converter step (nav split, breach tiles, `walls.json`), `content/siege/jangan.json` segment table | the town looks identical with the cut models; nav equality test green; every breach probe walks |
| **1. Walls that break** | WallService (state, damage, stages, natural repair), migration 17, `@sro/nav` seams, `wallNav` on both sides, safe-area seam and breach zones, lightning and tornado wear, `walls`/`wallUpdate`/`wallFx`, the walls feature with stage swaps and basic dust, GM `wall` | **playable**: a GM breaks W3, everyone sees the hole and walks through it, the ground behind it is unsafe; storms crack walls |
| **2. Looks and sound** | crack variants, collapse animation, debris pool, scaffold, rubble mounds, camera shake, sounds export and wiring, minimap/world-map wall layer | the user's go/no-go on the collapse in the render lab |
| **3. Repair** | Master Mason Ko, donations and the builder queue, Mason's Kit, Stone Block drops, looters at breaches | a breached segment is closed by donations; looters appear and leave |
| **4. Siege event** | event state machine, lanes, roster, sappers and their kegs, rams, archers, Warlord, Town Bell, gate wards, scaling, rewards and title, schedule, migration 18, admin page (walls + event + settings), GM `siege` | **playable**: a GM-started siege with friends, won and lost once each; load gate |
| **5. Player kegs and Wanted** | Thunder Keg and Old Fang, Saltpeter, plant/defuse/blast, notices, warrants (wanted label, lapse), law records, migration 19 (all tables) | a keg breach names the breaker server-wide; the warrant lapses after 2 h online |
| **6. Hunters and the jail** | Captain Yun, licence, duty, ranks, `pvpAllowed` and `pvpDamage`, Hunter's Net, pings, capture and bounty, the Stockade (props via the World Editor, Warden Bae, clamp, chores), sentences and clock, admin Law tab, GM `law`, abuse tests | **the full loop**: break a wall, get hunted, sit 2 h, the second time 4 h |

---

## 16. Risks, open questions, effort

### 16.1 Risks

| Risk | Mitigation |
|---|---|
| The cut changes the town's look (UV or lightmap seams at cuts) | cuts at the texture repeat; UV0/UV1 untouched; layer 0's gate is a side-by-side render |
| The nav split leaks (a gap in the split outline lets walkers through an intact wall) | the 2,000-chord equality test and a walker fuzz along each wall (as I7B's walk fuzz) |
| The ditch: a gap's corridor may still be closed somewhere (the N side has a wider closed band) | per-third probe in the converter, corridor widening, a hard stop if it still fails |
| First PvP in the game: damage formulas, skills with areas, buffs, heals never met a player target | one `pvpAllowed` gate used by every targeting path; `pvpDamage` only Hunter ↔ Wanted; dedicated tests; `pvpMul` setting |
| ≈ 150 siege mobs + 30 players: tick time and broadcast load | the load gate of layer 4; caps on scaling (`scaleCap`); mobs outside every player's interest go dormant except marching ones (march by legs, one move per leg) |
| Gate wards feel odd (monsters stop at an open gate) | portcullis prop dropped in each arch during a siege (visual only), so the ward reads as a barred gate |
| The safe-area seam changes ~20 behaviours at once | it only ever removes safety inside breach zones; tests for attack, mob targeting, stalls, lightning, tornado in a zone |
| Real-time sentences can be served offline | it is the stated default; `sentenceClock: 'online'` is one setting away |
| Notice fatigue if kegs are cheap | keg cost, per-account cooldown, notice rate limits |
| Another lane takes migrations 17–19 | renumber at merge, as before |

### 16.2 Open questions (each with the default chosen)

1. Number of segments: **33** (~48 m, thirds of ~16 m); gatehouses and corners indestructible.
2. Can monsters use the gates during a siege? **No**: gate wards (mob-only); players pass.
3. Make the wall walk reachable (defenders on the walls, archers)? **No** in v1 (retail has no links up there);
   a later layer could add stair links.
4. Jail clock: **real time, offline included** (`sentenceClock` setting).
5. Uncaught Wanted: the warrant **lapses after 2 h of online time**; the offence still counts.
6. Can Hunters attack the Wanted inside the safe area? **Yes**, everywhere except the stockade.
7. Kegs during a siege: **allowed, ×2 sentence and bounty** ("treason").
8. Bail: **none** in v1; chores cut up to 25 %.
9. Offence record: **per account** (alts share it); one level forgiven per 30 clean days.
10. Accomplices (kegs on the same segment in the last 10 min): **Wanted at half bounty and half sentence**.
11. Siege failure: **no town penalty**; breaches stay open with looters until repaired.
12. Schedule: **weekly, Sunday 20:00 server time, disabled by default**; skipped below 5 eligible players; never
    during a Night of the Tiger.
13. Bounty source: **paid by the server** (the keg's 50,000 gold sink exceeds it); no player-posted bounties in v1.
14. Hunter licence: **level 15, 10,000 gold, 30 days clean**; on duty only from a safe area; off-duty locked 2 min
    after a PvP hit.
15. PvP death penalty: **none** (no EXP loss for Hunter or Wanted deaths; capture is not a death).
16. Lightning and tornado wear floor: **35 %** (deep cracks, never a breach).
17. Natural repair: **1 % per 10 min**, paused during a siege.
18. Looters outside a siege: **3 Bandits per breached segment**, respawn 5 min.
19. Who sees the Wanted: **everyone sees the label**; only on-duty Hunters get pings and the minimap dot.
20. NPC names and spots (Master Mason Ko at the south gate, Captain Yun at the west gate, Warden Bae at the stockade,
    Old Fang ≈ 600 m west): placeholders for the user to rename.

### 16.3 Effort (agent-days)

| Layer | Server | Client | Assets / converter | Tests | Total |
|---|---|---|---|---|---|
| 0. Cut | – | 0.5 | 3 | 1 | **4.5** |
| 1. Walls that break | 3.5 | 2.5 | – | 1.5 | **7.5** |
| 2. Looks and sound | – | 3 | 1 | 0.5 | **4.5** |
| 3. Repair | 2 | 1 | – | 1 | **4** |
| 4. Siege event | 6 | 3 | 0.5 | 2.5 | **12** |
| 5. Player kegs and Wanted | 2.5 | 1 | – | 1 | **4.5** |
| 6. Hunters and the jail | 4 | 2 | 0.5 (stockade props) | 2 | **8.5** |
| | | | | | **≈ 45** |

Walls players can break and walk through: after layers 0–1 (≈ 12 agent-days). The full wall-breaker → Hunter → jail
loop needs layers 0, 1, 5 and 6 (≈ 25), so it can ship before the siege event if the user prefers.
