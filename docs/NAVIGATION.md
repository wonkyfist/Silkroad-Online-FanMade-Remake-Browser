# Navigation spec (vSRO 1.188)

How the original client and server decide where a character can stand and walk: the terrain navmesh, the object navmeshes, which surface a character is on, its height, and what stops a move. It ends with the design for `@sro/nav`, the shared package for the browser client, the viewer and the Node server.

This is a spec, not code. Parsers live in `packages/formats` (`nvm.ts`, `bms.ts`, `bsr.ts`, `cpd.ts`, `obji.ts`) and return raw file-space values: left-handed, Y up, 1 unit = 1 dm. The only conversion to glTF/Babylon space is `packages/convert/src/gltf/space.ts`: position `0.1 · (x, y, −z)` (see `CONVENTIONS.md`, `TERRAIN.md`).

## Status tags

- **[confirmed]**: sources agree **and** a check against the real 1.188 bytes under `work/extracted` agrees. Where possible the check uses independent ground truth: render geometry, the minimap, or cross-file references.
- **[likely]**: one or more sources say so, most often OpenSRO's reverse-engineering notes, which cite native function addresses. The data does not contradict it, but it cannot prove it either.
- **[unknown]**: the sources disagree or say nothing.

## Sources

| Tag | Source | Use |
|---|---|---|
| OR | openroad `docs/formats/{nvm-jmxvnvm,bms-jmxvbms,ainavdata}.md`, `docs/adrs/adr-0007-stateful-nav-location.md`, `client/src/plugins/nav/*`, `client/src/assets/nvm/*` | GPL, read only. A **reimplementation** with its own heuristics (`MAX_STEP_UP`, `OBJECT_BLOCK_Y_BAND`, `STAND_TOLERANCE`), which its ADR says are not native. Useful for its corpus measurements. |
| RS | RSBot `Library/RSBot.NavMeshApi` (C#: `NavMeshManager`, `Terrain/NavMeshTerrain`, `Object/NavMeshObj`, `Terrain/NavMeshInstObj`, `Edges/NavMeshEdgeFlag`) | Read only. A bot's raycast/height library. A second, independent implementation. |
| OS | OpenSRO `apps/server/internal/game/world/movement/{clip,navowner,objectnav,objectnav_collision,objectnav_links,terrain_object_cells,contact_response,vertex_direction,monster_navigation,monster_route}.go`, `…/world/simulation/navowner.go`, `apps/client-next/src/engine/foundation/navigation/*`, `…/movement/navigation/navigation.ts` | AGPL, read only, nothing copied. It cites native addresses from HLIL of SR_GameServer and SRO_Client (for example `QueryMovement 0x98B300`, `FindNavCell 0x99FD90`, `sub_428930`, `sub_403fb0`, `45c1b0`). Its client targets a different protocol version (opcode 0x7738), but the navmesh code is version-independent. |
| SK | skrillax `crates/silkroad-navmesh` (Rust) | Read only. Terrain height map only; objects are loaded but unused. |
| SD | SilkroadDoc wiki JMXVNVM, EdgeFlag, NavMeshObj, AINavData | Reference. |
| DATA | Our own measurements over `work/extracted/Data/navmesh/*.nvm` and the BMS/BSR files. Scratch scripts, since deleted. | Ground truth. |

No source code was copied. Everything below is re-stated behaviour and our own measurements.

## 1. The model in brief

- **Two layers.**
  - The *terrain navmesh* is one `.nvm` per 1920 × 1920 region. It holds rectangular cells (open or closed), a 97 × 97 height grid and ice planes.
  - The *object navmeshes* are triangle meshes stored inside the collision `.bms` of placed buildings, plazas, bridges, stairs, walls and props.
- **Surface ownership.** A character's position carries the surface it stands on: terrain, or one triangle cell of one object instance. Height is always read from that surface. The terrain is **not consulted** while you stand on an object.
- **One straight chord per move.** The destination is the click. The walk follows a straight line from the stored source cell and stops at the **first blocking edge**, with no slide and no path-finding. Surfaces change only when the chord crosses edges:
  - terrain → object: an object's *outline* edge crossed from outside whose flag lets you in;
  - object → terrain: an *open* outline edge (flag 0);
  - object → object: a *linked* global edge.
- **Height does not decide the surface while walking.** A nearest-height rule is used only when a position has no retained surface: login, teleport, spawn.
- **No step-up or step-down limit**, and no slope limit. Walls are edges, not heights. The data puts open edges where the surfaces meet at the same height: the median gap is 0.06 m.

## 2. Terrain navmesh (.nvm)

The layout is in `packages/formats/src/nvm.ts` (header comment and corpus test). The facts that matter for navigation:

- **Cells are axis-aligned rectangles**, not tiles. They are stored open first: `cells[0 .. openCellCount)` are walkable and the rest are solid. **[confirmed]**
  - Jangan 168×97 has 73 cells, 71 of them open; 168×98 has 334.
  - The 96 × 96 tile map gives each 20-unit tile's cell.
  - Tile flag bit 0 is set exactly when that cell is closed (5,040/5,040 files).
  - The walkability test is `cellIndex < openCellCount`. **[confirmed]**
- **Edges.**
  - Internal edges have flag 4 (passable) or flag 2 (blocked, `cells[1] = −1`: open cell against void).
  - Global edges (flag 8) join regions and are never blocked.
  - The directional block bits never matter on terrain: every blocked terrain edge borders void (OR measurement, consistent with our parse). **[confirmed]**
  - The cell test and the edge test are equivalent. Use the cell test, which also catches a start inside a closed cell.
- **Height.** Use the 97 × 97 grid (equal to the `.m` grid), split along the (minX, minZ)–(maxX, maxZ) diagonal: `nvmTerrainHeightAt`. **[confirmed for rendering and object placement, TERRAIN.md §1.3]**
  - OR, RS, SK and OS-server all use bilinear interpolation instead.
  - OS notes that the client samples the triangle split and that its own bilinear server is an approximation.
  - The two differ by at most `|h00 + h11 − h10 − h01| / 4`. Over the 9 Jangan regions that is p50 0.0003 m, p99 0.23 m, max 2.1 m on cliffs.
  - Use the triangle split everywhere, so that feet sit on the rendered ground. **[likely native client]**
- **Planes.**
  - 6 × 6 blocks of 320 units, with type 0 none, 1 water, 2 ice, 3 water+ice.
  - Where the type has bit 2 (ice), the standable height is `max(terrain, planeHeight)`. OS cites `404EE9` (client) and `9A12B9` (server). RS, OR and our `nvmHeightAt` agree. **[likely]**
  - Water is **not** a walking surface and not a blocker. You walk on the river bed, submerged; only closed cells stop you.
  - Measured over the 5 × 5 regions around Jangan: tiles 5–10 units under a water plane are closed 6.4% of the time, and 25–55 units deep only 0–1.1%. **[confirmed: the data]**
- **Object instance list and per-cell object lists.** See §4.

## 3. Object navmesh (BMS navmesh section)

### 3.1 Which mesh

- An object's navmesh is the navmesh section of its **collision mesh**:
  - `.bsr` collision section → `.bms` path (`BsrResource.collision.meshPath`);
  - for a `.cpd`, its `collisionPath` `.bsr`, then that BSR's collision mesh.
- RS loads exactly this. OS walks the render meshes that carry a nav section, which gives the same result here. **[confirmed]**
- Jangan (the 9 regions 167–169 × 96–98): all 547 nav instances resolve to exactly one navmesh, and that mesh is always both the collision mesh and one of the render meshes.
- `Data/navmesh/object.ifo` is byte-identical to `Map/object.ifo`. The `.nvm` object `objId` indexes it.

### 3.2 Layout

The layout is parsed by `readNavMesh` in `bms.ts`. **[confirmed]**, EOF-exact on the corpus.

```
vertices   u32 n;  n × (f32 x, y, z; u8 direction)        object-local file space
cells      u32 c;  c × (u16 v0, v1, v2; u16 flag; [u8 eventZone if navFlags & 2])
outline    u32 e;  e × (u16 vA, vB; u16 srcCell, dstCell; u8 flag; [u8 eventZone if navFlags & 1])
inline     u32 e;  same record
events     [u32 k; k × lpString name  if navFlags & 4]
grid       f32 originX, originZ; u32 width, height, count; count × (u32 m; m × u16 outline edge)
```

- **Cells are triangles.**
  - All 6,013 cells in the 5 × 5 area wind with `cross(b − a, c − a).y > 0`, the same as render triangles. **[confirmed]**
  - A cell's surface is the plane through its three vertices. The height at (x, z) is the barycentric Y. **[confirmed]**
  - At the lead's test point, gate cell 85 gives −32.61. The gate's render meshes (`cj_jang_gate06/07/08.bms`) give −32.6 at the same XZ. Along three rays from the fountain, nav and render heights agree to 0.1 at every sample.
  - The cell `flag` is 0 in every cell (OR: 50,279 sampled; us: 6,013).
- **Outline edges** form the mesh boundary.
  - `dstCell = 0xFFFF` (none) in every one (OS: 29k+; us: 6,771). "Outside" is always the dst side.
  - `srcCell` is the cell inside.
- **Inline edges** join two cells of the same mesh (`srcCell`, `dstCell`).
- **Edge vertex order** is not tied to a side. The src cell lies left of vA→vB in 5,219 outline edges and right in 1,552. Find the inside by testing the src cell's centroid (RS, OS do the same). **[confirmed]**
- **Vertex direction byte** is an outward boundary direction quantized to 256 steps: angle = `i · 2π/256`, direction `(cos, −sin)` in (x, z) (RS normal cache, OS `43EC80`). **[likely]**
  - It points outward from the edge's cell for 92% of outline edge vertices.
  - It is used only for the exact native nudge when a contact is outside every cell. We do not need it.
- **Events.** Named event zones: dungeon doors, fortress structures (`STRUCTURE_POS_BJ_DEFENSIVE_09` on `cj_pal_guard_dan`/`cj_pal_side_dan` in Jangan).
  - The per-cell or per-edge byte holds the event index in its low 6 bits and trigger flags in its high 2 bits.
  - Only two objects in the Jangan 5 × 5 area carry any. Ignore them outdoors for now.
- **Grid.** An outline-edge lookup grid.
  - Origin = the nav vertex bounding-box minimum, cell size 100 units (OR: 2,103/2,103).
  - The count rule is inconsistent, so do not index into it. Build our own broad phase (§9.3). **[confirmed by OR; our gate: 1058 × 1319 units → 11 × 14]**

### 3.3 Edge flags

The same bits are used by terrain edges (SD EdgeFlag, `NVM_EDGE_FLAG` in `nvm.ts`). Their meaning on object edges:

| Bit | Name | On inline edges | On outline edges |
|---|---|---|---|
| 1 | BlockDst2Src | blocks leaving the dst cell | blocks **entering from outside** (outside = dst) |
| 2 | BlockSrc2Dst | blocks leaving the src cell | blocks **leaving the object** |
| 4 | Internal | set on every inline edge, never on an outline edge | never set |
| 8 | Global | never set | object-to-object seam; passable only through a `.nvm` link (§4.3) |
| 16 | Underpass ("Railing" in RS) | rare (flag 20) | **pass under from outside; a railing from inside** |
| 32 | Entrance | not seen outdoors | dungeon (obsolete) |
| 128 | Siege | 135 = 7 + siege | 131 = blocked + siege: attacks pass, walkers do not |

Measured values:

- Jangan 5 × 5 area (715 instances):
  - outline {0: 438, 3: 6,234, 8: 6, 16: 63, 131: 30};
  - inline {4: 5,290, 7: 255, 20: 71, 135: 18}.
- Whole corpus (OR): outline {3: 66,119, 131: 5,276, 0: 2,164, 8: 1,602, 16: 566, 128: 54, 144: 52, 24: 8, 136: 4, 32: 2}.
- Only 26 of the corpus's roughly 209k inline edges are one-way (OR).

**Underpass [confirmed].** The 63 Jangan underpass edges are the tops of the city walls at y ≈ 219 (21.9 m above the ground) on `cj_w`, `cj_s` and `cj_e`.

- We cast every terrain-walkable straight crossing through the three gate objects: 84, 92 and 84 chords.
- Every one crosses underpass edges.
- None is blocked by an elevated edge alone.
- 54, 64 and 50 respectively are blocked by ground-level flag-3 edges: the towers and walls.
- So the rule "outline edges are tested against terrain walkers with no height test, underpass excluded" lets you walk through the gate arches and keeps you out of the masonry. That is exactly the authored intent. OR, RS and OS all read the flag this way.

## 4. Object instances

### 4.1 Where the instances come from

- The `.nvm` object list holds **exactly the `.o2` placements whose object has a collision navmesh**. **[confirmed]**
  - Jangan's 9 regions have 1,862 unique `.o2` placements, of which 547 have a navmesh.
  - The 9 `.nvm` lists hold 547 unique instances (key = (regionId, localUid)).
  - None is missing, none is extra, and none differs in objId or yaw.
- Each record holds: `objId`, position, `type`, `yaw`, `localUid`, `isBig`, `isStruct`, `regionId` (the owner) and links.
- The world id is `regionId << 16 | localUid` (RS `WorldUID`).

### 4.2 Transform

- Positions in a `.nvm` are relative to **that file's** region. An object owned by a neighbour appears in every region it reaches into, with coordinates outside 0..1920 (`nvm.ts`).
  - In Jangan, 545 instances are owned by the 9 regions, 2 come from neighbours, and 3 are `isBig`.
  - Deduplicate on (regionId, localUid).
  - `isBig` only says that the object spills beyond its region. Nothing special happens in navigation, because the spill-over copies already list it.
- **Object-local → world** (file space; X, Z are region-local or world, the same frame as the position):
  - c = cos yaw, s = sin yaw
  - world = (px + c·x − s·z, py + y, pz + s·x + c·z)
  - local = (c·dx + s·dz, Y − py, −s·dx + c·dz), with (dx, dz) = world − (px, pz)
  - This is the TERRAIN.md §6.2 yaw rule, with Y untouched. RS builds the matrix `RotationY(−yaw) · T` and OS inverts the same formula. **[confirmed]**
  - Independent check: nav cells transformed this way coincide with the gate's render floor (§3.2), and their outlines coincide with the building footprints on the minimap.
- In glTF, place the instance exactly as its render glb (`TERRAIN.md` §8.4): `T(0.1·(X, y, −Z)) · R_Y(+yaw)`.

### 4.3 Per-cell object lists and links

- **Terrain cell object lists** (`NvmCell.objects`) are the terrain → object broad phase. **[confirmed]**
  - The native terrain walker tests only the objects listed in the terrain cells it traverses. OS cites `404510` and `428300`; RS uses the same cell instance lists.
  - In Jangan, for all 600 (instance, region) pairs, every terrain cell that the instance's navmesh overlaps lists it. In 171 pairs the list also names cells it does not touch.
  - So the lists are a safe superset. A geometric broad phase that is at least as conservative gives the same answers.
- **Links** (`NvmObject.links`: linkedObject, linkedObjectEdge, edge) join an outline edge of one object to an outline edge of another **object**. They never join an object to the terrain. **[confirmed]**
  - Corpus: 1,804 link records, of which 1,524 are all −1 (unused slots).
  - The other 280 are real. Both ends are global-flagged outline edges in 276 of them: 264 are 8 ↔ 8, 8 are 24 ↔ 24 and 4 are 136 ↔ 8. The remaining 4 have a flag-3 end (8 ↔ 3).
  - In Jangan there are 6 links, all in 168×98: the palace south bridge chain `cj_pal_south_brid02/03/04` and `cj_pal_south_buildan01`.
  - Crossing a linked edge moves the walker into the target object's cell, which is the `srcCell` of the target edge (RS, OS). **[likely]**
  - An unlinked global edge blocks. **[likely: OS; RS would let a terrain walker enter through it; rare]**

## 5. Which surface, and what height

### 5.1 The position carries its surface

- A position is `{ region, x, y, z, owner }`, where `owner` is the terrain or `(instance, cell)`. **[likely: OS HLIL]**
  - OS: every server object holds `pNavCell` and `pNavMeshInst` next to (region, x, y, z) at `CGObj+0x7C`.
  - OS: `QueryMovement 0x98B300` starts every ordinary move from the **stored** source cell and writes the cell it reached back into the destination.
  - RS keeps the same `(Cell, Instance)` pair in its `NavMeshTransform`.
- **The height is always the owner's surface at (x, z):**
  - object: the cell plane (§3.2);
  - terrain: the triangle-split grid with the ice lift (§2).
- **Keep the owner across moves; never re-guess it from y.**
  - Wire coordinates are int16, and OS records a real failure when the surface was re-guessed.
  - Hotan gate: a deck at 243.99 arrives as y = 243, the terrain there is 243.04, and a re-guess dropped players under the deck.
  - When a retained cell no longer contains (x, z) after a sub-unit quantization, first try its edge neighbours, then clamp into the cell (OS).
  - A small overlap can arise from float noise at edges. Keep the owned cell and clamp; do not switch surfaces.

### 5.2 Positions with no retained surface

This covers login, teleport, spawn, warp and server corrections. **[likely: OS `FindNavCell 0x99FD90` via `CheckPointValid 0x98B1D0`; RS `ResolveCellAndHeight`; the two describe the same rule independently]**

1. Compute the terrain height at (x, z), with the ice lift.
2. For every object listed in the terrain cell containing (x, z), find each triangle of its navmesh that contains (x, z) in XZ, and take its plane height.
3. Choose the candidate with the smallest `|candidate − y|`. The comparison is strict `<`, so **the terrain wins ties**.
4. Rewrite y to the chosen height.
5. On the terrain, a start in a closed cell is invalid (RS). The server then relocates the character (OS "stranded spawn").

There is no clearance condition. OS notes that stair decks can lie below the height map. The spawn/teleport y must therefore be close to the intended surface. Server-side we always know it.

### 5.3 Overlapping surfaces

- **Plaza above terrain (Jangan).**
  - The gate/plaza object `cj_jang_gate.bsr` is sunk into a hidden terrain depression. At the test point, terrain is −47.9 and the plaza is −32.6.
  - Its outer diagonal edges are open (flag 0) and meet terrain at −33.2 (dy 0.6).
  - A character walking in from the streets crosses an open outline edge and becomes owned by the plaza. From then on the terrain below is irrelevant.
- **Bridges over water.** The deck owns the walker between its open end edges. The sides are either
  - flag 3 (blocked both ways: `cj2_brg`, deck 0.3–4.7 m above an open river bed, so a walker on the bed cannot pass under it), or
  - flag 16 (walk under from below, railing from above: the high city-wall walkways).
- **Multi-storey buildings.**
  - Each storey is part of one mesh, or of linked meshes.
  - Stairs are sloped triangles; inline edges connect them.
  - Storeys are told apart by the owned cell, never by height.
  - Two floors at the same XZ are different cells, reachable only by walking through the mesh topology.
- **Underpasses.** The terrain walker ignores flag-16 outline edges, so it passes beneath. A walker on the object stops at them.

### 5.4 Transitions and step heights

- Surfaces change only through the edge crossings in §6.
- **There is no step-up or step-down limit and no slope test in the native walk.** **[likely: OS says no Y gate exists in `404510`/`428300`; RS has none]**
  - The only "height" in collision is which surface you own.
  - OR's `MAX_STEP_UP`, `STAND_TOLERANCE` and `OBJECT_BLOCK_Y_BAND` are its own inventions; its ADR says so.
- What the data gives: open outline edges sit where object and terrain meet.
  - Across the 1,266 samples (3 per open edge, in the Jangan 9 regions), the gap to the nearest other surface just outside is p50 0.06 m and p90 0.77 m.
  - The larger gaps are stair sides: parts of the gate's stairs, 0.8–1.6 m above terrain. Walking off them drops you to the terrain.
  - In the original, the character snaps to the new surface. We may animate the snap, but we must not refuse it.

## 6. Movement and collision

### 6.1 What a click does

- The client sends the destination. The move is **one straight chord** from the current position (and its retained cell) to the destination.
  - The server runs the same walk (`CGObj_MoveTo 0x485740` → `QueryMovement 0x98B300`) and stores the end point and the cell reached (OS).
  - The client runs the same walk locally (OS "client-replicated hard stop").
  - Other clients receive the resulting destination (vSRO 1.188 `0xB021`, RS; int16 region-local coordinates).
- **The walk stops at the first blocking contact.** **[likely: OS for server and client; RS returns `Collision` with the hit point]**
  - Nothing slides along the wall. Nothing re-plans.
  - Outdoor players never path-find: OS keeps a single clipped segment for click-to-move, and path-finding exists only for AI (§7).
  - OS's client computes a slide normal only for skill displacement (dash-type skills), never for ground clicks.
- **Stop point.** The hit point on the edge, moved at most **0.2 units** toward the centroid of the cell the walker is in (`45c1b0`). On terrain: the chord point just short of the closed cell (OS pulls back 0.01).
  - The character then stands still at that point. In game you run into the wall and stop.
- **Continuation legs.** A walk that changes surface (exit to terrain, entry into an object, link) continues toward the **original destination** from the transition point, in a new leg.
  - The native limit is 6 legs (`98B636`/`412230`). A 7th fails the move.
  - A leg that ends within 5 units (squared distance < 25) of the destination ends the move.
  - Region crossings re-express the destination in the new region (`412230`).
- A destination further than 1920 units in x or z is rejected (OS `regionMoveAllowed`). Clicks are always closer.

### 6.2 The terrain walker (owner = terrain)

Walk the chord in XZ. The **earliest** of these events ends the leg. **[likely: OS, RS; the no-Y rule confirmed by §3.3's gate test]**

1. **Entering a closed terrain cell**, or leaving the loaded world: stop just before it.
   - Test cell openness along the chord with a tile DDA that does not squeeze through diagonal corners (OS checks both side tiles at an exact corner).
2. **Crossing an object outline edge from outside.** Objects come from the terrain cells the chord passes through (§4.3). The approach side is the side of the chord start relative to the edge line, compared with the src cell centroid.
   - flag & 16: ignore (pass under).
   - flag & 1 (3 and 131 in practice): **blocked** (building walls, fences, props).
   - flag & 8: blocked unless linked (OS). **[unknown for terrain walkers; very rare]**
   - otherwise (flag 0; 128 without block bits): **enter**. The owner becomes `(instance, srcCell)`, the entry point moves 0.2 into that cell, and a new leg continues on the object.
   - **There is no height test.** An object's wall blocks a terrain walker whatever its Y. Elevated walkways that you should pass under are authored with flag 16.
3. No event: arrive. The height is the terrain at the destination.

A start inside a closed terrain cell never blocks the first step out (OS: "the player must always be able to leave"). Treat it as a server-side rescue case.

### 6.3 The object walker (owner = object cell)

Walk the chord through the mesh cell by cell, in object-local XZ (`sub_428930`). OS and RS describe the same walk. **[likely]**

1. In the current triangle, find the edge the chord leaves through. If the destination is inside the triangle, **arrive**: height = the cell plane.
2. **Inline edge**, leaving from `srcCell`: blocked if flag & 2. Leaving from `dstCell`: blocked if flag & 1. Otherwise move into the neighbour cell and repeat.
   - In practice, flag 7 or 135 blocks both ways (pillars and islands inside a floor), and flag 4 passes.
3. **Outline edge** (always leaving the object):
   - flag == 0: **exit to terrain**. The owner becomes terrain, and a new leg continues from just outside the edge (OS: mirror of the 0.2 nudge). If the terrain there is a closed cell, the terrain leg stops at once.
   - flag & 8 with a `.nvm` link for this edge: enter the linked object's target-edge cell and continue.
   - anything else (3, 131, 16, 8 unlinked, 128 per OS): **blocked**. Underpass (16) is exactly the railing that keeps you on a bridge or wall walkway.
4. **Other objects are not consulted while you stand on an object** (RS delegates the whole raycast to the owning mesh; OS skips edges of meshes that do not own the walker at that point of the chord). **[likely]**
   - This is safe because props that stand on a floor are part of its mesh: islands with blocked inline edges, like the 16 flag-7 edges of the gate.
   - OR decided the opposite for its own reasons (walls of other objects always apply). If a real case shows a prop you walk through, add other objects' flag & 1 outline edges as blockers. That is the conservative fallback.

### 6.4 What counts as blocked (summary)

- Terrain: closed cells (equivalently, flag-2 internal edges).
- Object inline edges: the side bits (1 and 2).
- Object outline edges:
  - from inside, everything except flag 0 and a linked global edge;
  - from outside, flag & 1 (and unlinked 8); flag 16 is ignored.
- Nothing else blocks:
  - water planes (walk on the bed; the ice lifts the height);
  - slopes and cliffs, except through closed cells;
  - height differences.
- Players do not collide with each other or with monsters: no source models entity-entity collision. **[likely]** OS also has authored circle obstacles (`452d10`) for objects with an `object.ifo` flag; this is outside this spec's scope. **[unknown]**

### 6.5 Server validation

- The server trusts nothing but the destination. It re-runs the walk from its own stored position and cell, and commits the clipped end point and the owner it reached.
  - Interpolated positions during the move come from the chord and the owner spans recorded for it.
- Stop, turn, death and sit settle at the live point and keep the owner that the walk had there.
- Relocations that do not walk (warp, recall, revive, pet follow) drop the owner and use §5.2. **[likely: OS]**
- Speed: the server times the segment at walk or run speed and broadcasts speed changes. The client never extrapolates past the committed end point.

## 7. Monsters

- **Same engine.** Monster moves, wander targets and chase steps go through the same move test and clip (OS: monster planning calls the same clip; population creation tests spawn candidates with the same move-test result bits, `5F6EB0`).
  - Monsters keep a surface owner exactly like players, and their heights come from it. **[likely]**
- **Outdoors there is no native path-finding data.**
  - `Data/navmesh/ainavdata_*.dat` exists only for the 18 dungeon regions 32769–32786 (0x8001–0x8012). It holds precomputed cell-to-cell edge and block-to-block subgoal tables (OR `ainavdata.md`). **[confirmed: file list]**
  - So an outdoor monster moves in straight clipped segments and can be stopped by walls. That is the long-known "mob stuck behind an obstacle" behaviour.
  - OS adds a bounded A*-style local detour for AI, but labels it its own policy, not native.
- Recommendation for the monster milestone:
  - use the same `move()` as players;
  - pick wander and chase targets as straight chords;
  - accept a clipped result as the new position;
  - add a small, explicit detour (a few probe chords) only as a later improvement, marked non-native.

## 8. Jangan data (regions 167–169 × 96–98)

All numbers are from `work/extracted` (vSRO 1.188).

- **Nav-bearing instances:** 547 unique (545 owned by these regions, 2 by neighbours, 3 `isBig`) out of 1,862 placements, using 135 distinct objIds.
  - Per `.nvm` file, including spill-over copies: 167×96 39, 167×97 90, 167×98 114, 168×96 30, 168×97 62, 168×98 122, 169×96 17, 169×97 93, 169×98 33.
  - Links exist only in 168×98 (6).
  - The 5 × 5 area around them has 715 instances.
- **Central plaza and fountain:** `res\bldg\china\jangan01\cj_jang_gate.bsr` (objId 587).
  - Placement: region 0x61A8 (168×97), uid 19458, position (1008.22, −33.07, 845.48), yaw 3.1319.
  - Collision/nav mesh: `prim\mesh\bldg\china\jangan01\cj_jang_gate06.bms`, with 134 vertices, 180 cells, 88 outline edges (72 open, 16 flag 3) and 226 inline edges (210 flag 4, 16 flag 7). No events.
  - Referenced by 43 terrain cells of 168×97.
  - Nav levels (world y): plaza **−32.6** (−3.26 m), stair landings −17/−16.5, street level +1/+1.5, with sloped stair triangles between them.
  - **Plaza surface:** −32.61 at the lead's test point, glTF (100.84, −71.5) = region-local (1008.4, 715), cell 85. The render floor there is −32.6. The terrain there is −47.91, which is the bug: the character is 1.53 m too low.
  - **Fountain terrace and basin:** a regular octagon of 16 **blocked outline edges (flag 3)** around (979, 856), radius about 100 units (10 m), at y −32.6.
    - It is a hole in the plaza mesh: no nav cell lies inside it.
    - The render inside is the pond fence `cj_jang_pondfen*.bms` (rim −25.2/−10.9) and the pool at −42.9. The terrain below the hole (−54.4) is open, which is why a terrain-only walker enters the basin.
    - **The basin interior is not walkable.** A walker on the plaza stops at the octagon. A terrain walker cannot reach the hole at all: every approach first enters the plaza through its open outer edges.
  - Other blocking edges of the gate mesh: the 16 flag-7 inline edges enclose four 55 × 80 islands on the east and west street-level wings (x ≈ 1437–1494 and 462–520). These are solid blocks on the gate's side wings.
  - Open outline edges:
    - the octagon's four outer diagonals, which meet terrain at −33.2 (dy about 0.6);
    - the ends of the four arms, which meet the streets (dy about 0.3–1.5);
    - some stair sides (dy up to 2.5 m; walking off them drops you).
  - Nearby props, each a 2-cell quad with all 4 outline edges flag 3 (solid from outside), listed in the terrain cells: 8 `cj_field_lamp` and 4 `cj_jang_gaobj01`, all outside the plaza outline.
- **Prototype walks with the rules of §6** (scratch implementation, brute force; region-local file units):

| Walk | Result |
|---|---|
| plaza (1008.4, 715) → fountain centre (979, 856) | stops at (999.6, 757.3), y −32.61, blocked by octagon edge 48 (flag 3) |
| plaza west arm (700, 856) → east arm (1300, 856) | stops at the fountain octagon (882.4, 856), y −32.61 |
| plaza (1008.4, 715) → (1500, 300) | exits through open diagonal edge 49 at (1214, 541); deck −32.6 meets terrain −33.2; arrives on terrain |
| terrain (1300, 450) → plaza (1008.4, 715) | enters through edge 49 (terrain −33.2); arrives on cell 85 at −32.61 |
| terrain (200, 700) → (1700, 700) | enters the plaza at (588, 700), exits at (1360, 700), then is stopped by the wall of `cj_luxury.bsr` at (1543, 700) |

## 9. Recommended design for `@sro/nav`

Environment-neutral: no `node:*` imports, and it depends only on `@sro/formats`. It works in raw file space, with world coordinates = `1920·(rx, rz) + local`, float64. The viewer converts with `space.ts` at the boundary. It is deterministic, so the server and client compute the same results.

### 9.1 Data model

```ts
// Built once per object resource (shared by all its instances).
interface ObjectMesh {
  key: string                    // collision .bms path
  vx: Float32Array; vy: Float32Array; vz: Float32Array   // SoA vertices (local)
  tri: Uint16Array               // 3 per cell
  // Per cell side k (0..2, edge tri[k] -> tri[(k+1)%3]): what lies across it.
  // >= 0: neighbour cell; -1: outline edge; plus the edge's flag and outline index.
  across: Int32Array             // 3 per cell
  sideFlag: Uint8Array           // 3 per cell: flag of that edge as seen when LEAVING this cell
                                 // (inline: resolved to 'blocked' by the side bits; outline: raw flag)
  outline: { a: Uint16Array; b: Uint16Array; cell: Uint16Array; flag: Uint8Array }
  bounds: [minX, minZ, maxX, maxZ, minY, maxY]
  cellGrid: CellGrid             // our own uniform grid (e.g. 50-100 u) -> cell ids, for point location
}
interface ObjectInstance {
  id: number                     // regionId << 16 | localUid
  mesh: ObjectMesh
  px: number; py: number; pz: number; cos: number; sin: number   // world file space
  worldBounds: [minX, minZ, maxX, maxZ]
  links: Map<number /*own outline edge*/, { target: ObjectInstance; edge: number }>
}
interface TerrainRegion {
  id: number; ox: number; oz: number        // 1920 * (rx, rz)
  nvm: NvmFile                              // heights, tileCells, openCellCount, planes
  cellObjects: ObjectInstance[][]           // per terrain cell, resolved from NvmCell.objects
}
type Owner = { kind: 'terrain' } | { kind: 'object'; inst: ObjectInstance; cell: number }
interface NavPos { x: number; y: number; z: number; owner: Owner }   // world file space
```

- **Build step.** For each region `.nvm` of the streamed window:
  - resolve `objects[i].objId` through `object.ifo` → `.bsr`/`.cpd` → collision `.bms` → `parseBms().navMesh`, caching by path;
  - make an instance keyed by (regionId, localUid), dedup across regions, with position = file region origin + stored position;
  - map every cell's object indices to instances;
  - resolve links after all instances of the window exist. A link's `linkedObject` indexes the same file's object list.
- **File loading is the caller's job.** The package takes a `(path) => Uint8Array | undefined` callback. Node, the browser and tests each supply their own.
- **Packaged data for the browser.** A converter step (`packages/convert/src/world`) can precompute a compact per-region binary: the terrain arrays already in `NavmeshBin`, plus instance records and a de-duplicated mesh table. That avoids shipping BSR/BMS parsing to the client. Keep the in-memory model above identical, so the same code runs on both sides.

### 9.2 API

```ts
class NavWorld {
  constructor(load: (pk2Path: string) => Uint8Array | undefined)
  addRegion(rx: number, rz: number): void          // idempotent; builds instances, links
  removeRegion(rx: number, rz: number): void
  /** §5.2: no retained surface (spawn, teleport, correction). null if no data or closed cell. */
  locate(x: number, z: number, y: number): NavPos | null
  /** Height of the owned surface at (x, z); re-validates/clamps the owner (§5.1). */
  heightAt(pos: NavPos, x: number, z: number): { y: number; owner: Owner } | null
  /** §6: straight chord from pos toward (x, z), stopping at the first blocking contact. */
  move(from: NavPos, toX: number, toZ: number): MoveResult
  /** Debug/overlays: edges and cells near a point, in world file space. */
  debugGeometry(x0: number, z0: number, x1: number, z1: number): DebugGeometry
}
interface MoveResult {
  end: NavPos                    // clipped destination with its owner and y
  blocked: boolean               // true if clipped short of (toX, toZ)
  hit?: { kind: 'terrain' | 'object'; inst?: number; edge?: number; flag?: number }
  spans: { from: number; to: number; owner: Owner }[]   // chord fractions -> owner, for y while moving
  legs: number
}
```

**Per-frame height while moving.**

- Sample the chord at fraction t, pick the owner from `spans`, and read that surface's height.
- Do not call `locate` per frame. Its nearest-y rule is for teleports only, and it would drop you under decks.
- The viewer's player then becomes:
  - on click: `result = nav.move(pos, click)`;
  - each frame: advance along from → `result.end` at `RUN_SPEED`, with y from `spans`;
  - on arrival: `pos = result.end`.

**Server.**

- Keep `NavPos` per entity. On a move request, call `move(stored, dest)`, commit `end`, and broadcast `end`.
- Monsters call the same `move`.

### 9.3 Algorithms

- **`locate`**
  1. Take the terrain region and cell. If the cell is closed, the terrain is not a candidate.
  2. Take the terrain height with the ice lift.
  3. For each instance in that terrain cell's list: transform to local, reject by bounds, then look up candidate triangles in `cellGrid`, test containment and take the plane y.
  4. Choose by min |Δy|, with the terrain winning ties.
- **`move`**, legs 1..6: while the owner is the terrain, run the terrain walker; while it is an object, run the object walker; a transition starts a new leg.
  - **Terrain walker** (§6.2):
    - a supercover DDA over 20-unit tiles to find the first closed tile;
    - the candidate instances are the union of `cellObjects` for the terrain cells the chord crosses, gathered at tile resolution;
    - an outline-edge intersection in each candidate's local frame, using a per-instance outline broad phase (a bounding-box reject, then `cellGrid` restricted to outline edges);
    - choose the smallest t, and apply the flag rules.
  - **Object walker** (§6.3):
    - walk the triangles through `across`. Each step is 3 segment tests; stairs of 20–200 cells stay trivial;
    - at an exact vertex hit, prefer the edge with the larger exit parameter and break ties deterministically (native gives shared vertices to one oriented edge, OS `43BA6D`).
  - **Contact response:**
    - stop at the hit point plus min(0.2, distance) toward the current cell's centroid;
    - on an exit, continue from the hit point plus 0.2 beyond the edge;
    - on an entry, start from the hit point plus 0.2 toward the entered cell's centroid;
    - arrive when the remaining distance² is below 25.
- **Precision.** Use float64 for the walk and round only at the protocol boundary: int16 for the wire; the viewer keeps floats.
  - `NavPos.owner` survives the rounding through the §5.1 clamp.
- **Cross-region.** Work in world file space, which avoids re-expressing coordinates per region. Regions matter only for looking up terrain arrays and cell lists.
  - Choose the region by `floor(x / 1920)`. A point exactly on a border belongs to the higher region; the native nudge moves such points 0.01 inside, RS `Break()`.

### 9.4 Performance notes

- **Memory and build.** Jangan's 5 × 5 area has 715 instances over about 150 distinct meshes. One `ObjectMesh` per resource: kilobytes each, well under 1 MB in total. Build `across` with one hash of sorted vertex pairs per mesh, once.
- **Cost per `move`.** A few hundred tile steps, plus outline tests for the instances in the crossed cells (typically under 20, each culled by bounds), plus a few dozen triangle steps. This is microseconds-scale in JS: fine for per-click use on the client, and for hundreds of monsters per tick on the server.
- **`heightAt` with a retained cell** is O(1): one barycentric evaluation. Only `locate` scans. Cache `locate` results per (instance, grid cell).
- **No allocation in the hot path.** Preallocate scratch vectors. Instances are immutable once built, so the server can share them across worker threads by rebuilding per thread, or by using SharedArrayBuffer-backed typed arrays later.
- **Streaming.** A region's instances hold references to neighbours only through links, and links stay within one `.nvm` file. Unloading a region drops its instances. An entity whose owner instance disappeared drops to `locate`.

### 9.5 Tests (Vitest, against the real client, skipped without config)

- **Plaza:**
  - `locate(1008.4 + 168·1920, 715 + 97·1920, y = −33)` gives the gate at cell 85 and y −32.61;
  - with y = −47.9 it gives the terrain (the nearest-y rule).
- The §8 walk table, as exact expectations: stop points within 0.3 units, owners, and flags.
- **City gates:** straight terrain chords through the west, south and east gate arches arrive; chords into the towers are blocked by flag-3 edges, not by the flag-16 walkway edges.
- **Palace bridge chain (168×98):** a walk across `cj_pal_south_brid02` → `brid03` → `brid04` uses the links, keeps an object owner the whole way, and never touches the terrain.
- **Invariants over the Jangan 5 × 5 area:**
  - every open outline edge exits to terrain or is linked;
  - `move` from any open-edge midpoint back inward re-enters the same object;
  - `heightAt(owner)` equals the render-mesh height, where a render triangle exists within 0.2 units above or below, for sampled cells.
- **Independent ground truth**, where possible: compare against render geometry (as in §3.2) and the minimap (building footprints), not against the navmesh itself.

## 10. Open questions

- **Terrain height interpolation on the server** (bilinear or triangle split). It matters only for byte-exact server heights; use the triangle split. **[unknown]**
- **Terrain walkers and unlinked global (8) or siege-only (128) outline edges:** OS blocks both, RS lets them through. They are rare: 6 edges of flag 8 in the Jangan area, all linked. **[unknown]**
- **Whether other objects' outline edges ever apply while you stand on an object** (§6.3.4). Native evidence (OS, RS) says no. Revisit if a prop proves walk-through.
- **Event zones** (dungeon doors, fortress structures) and the circle obstacles of `452d10` are out of scope outdoors.
- **Exact native float behaviour** (f32 stores, the vertex-direction nudge for outside contacts). OS reproduces it for byte-exact contacts. We accept differences of 0.2 units or less.

## 11. Reachability

`@sro/nav` labels every walkable place with a **walkable component**: the places the walker can get from each to the other, over any number of moves. The server uses it to refuse placements the walker could never leave or reach. Code: `packages/nav/src/reach.ts`; tests: `packages/nav/test/reachability.test.ts`.

### 11.1 What a component is

- **Places.** Every object navmesh cell, and every **terrain face**: the open terrain cut by the outline edges the terrain walker tests (all outline edges except flag 16). Terrain cells alone are not enough: under the Jangan plaza one open `.nvm` cell runs from the streets, under the plaza, into the fountain hole.
- **Transitions** are exactly the walker's (§6), read from `world.ts`:
  - terrain → terrain: through any boundary no edge covers, both ways; across an outline edge crossed **from its inside**, one way only. `terrainLeg` skips edges the chord leaves (`ldx·onx + ldz·onz <= 0`), so you walk out of any footprint;
  - terrain → object: an outline edge crossed from outside that lets the walker in (not flag & 1; flag & 8 only when linked) enters its src cell;
  - object → object: inline sides that do not block leaving the cell; linked flag-8 outline sides;
  - object → terrain: a flag-0 side exits 0.2 units outside the side, onto whatever terrain face that point lies in (on an open tile).
- **Directed, so components are strongly connected components.** One-way transitions are everywhere, because the terrain under any footprint walks out and nobody walks in. Undirected labels are wrong: the terrain under the plaza reaches both the streets and the fountain hole, which would merge the hole with the town. `componentReaches(a, b)` answers the one-way question on the condensation.
- Not transitions: `settle()` re-celling (only for points more than 1e-3 outside their cell, which the walker never produces), and the first-step escape out of a closed tile (closed tiles are not places, so `componentOf` is -1 there).

### 11.2 How it is built

- Built at run time, on first use, from `NavData`. Neither the nav.bin format nor the existing APIs change.
- Each open 20-unit tile crossed by edges is split by the edges' lines into convex pieces: a line arrangement per tile, float64, tile-local.
- Pieces sharing a boundary that no edge covers are joined (union-find) into faces. Covered boundaries become one-way or entering links by the edges' inward normals and flags. Exits land on the faces the 0.2-offset side touches.
- Tarjan's algorithm gives the components. Ids are by area, largest first.
- Tolerances sit at float-noise level (1e-9 to 1e-6 units). A covering edge counts 1e-6 past its ends, so two walls meeting at a corner leave no false gap.
- **Checks** (`reachability.test.ts`, plus scratch runs):
  - Soundness: no random walk ever ends in a component its start cannot reach. The test runs 20,000 walks plus reverse sampling from every component; scratch runs added 1.2M chained walks.
  - Tightness: every terrain link the graph derives is walked by the real walker. 137k probes, 0 disagreements.
- **Cost (Jangan, 9 regions).**
  - Build: 140–170 ms cold, 75–100 ms warm (tsx on the dev PC).
  - Memory: 3.8 MB of typed arrays, about 4.9 MB retained.
  - Size: 102k terrain pieces (9,239 cut tiles), 965 faces, 5,155 object cells, 30.5k transitions, 1,569 components.
  - No cache is needed.
- **API** (`NavWorld`; `NavGltf` mirrors the point queries in metres):
  - `componentOf(p)`, `sameComponent(a, b)`, `componentReaches(from, to)`;
  - `componentInfo(id)`, `components()`, each a `NavComponent` with area, cells, faces, bounds, sample, exits and entries;
  - `componentSample(id)`, `locateIn(x, z, yHint, component)`, `reachStats()`.

### 11.3 Jangan census (current walker)

- **Town component (#0):** 271,393 m², containing the spawn, the plaza, the streets and the gates. Everything below is outside it.
- **Traps: 9 components, 419 m².** The town can walk in; nothing walks back out.
  - the fountain basin, 314.7 m²;
  - a pocket at `cj_rich2_rounddam`, 63.4 m²;
  - pockets at `cj_weapon` (15.9 m²), the monster-stadium doors (9.6, 9.1 and 6.3 m²) and `cj_rich2` (0.5 m²);
  - 2 slivers under 0.01 m².
- **Walk-out only: 758 components, 49,729 m².** Terrain under footprints: houses, props, trees, stalls and the city-wall bodies. You can leave, but nobody can walk in.
- **Isolated: 801 components, 76,358 m².**
  - 661 sealed object meshes: the city-wall walkways `cj_s`, `cj_e` and `cj_w` (8,000–10,000 m² each), roofs and props;
  - 137 enclosed terrain pockets: palace and temple courtyards, the inner yards of `cj_mili_ration`, and bridge-wall pockets.
- **All 9 traps come from one walker quirk** **[confirmed on the data]**:
  - An exit nudge (0.2 along the side normal) taken within about 1 cm of a sharp reflex corner of a walkable object lands on the terrain *under* that object. Examples are gate cells 149 and 151 at glTF (60.24, −71.92) and (60.52, −99.96).
  - The terrain walker then ignores the object's edges, which it crosses from inside, so the next click can walk under the plaza into the fountain basin.
  - The same quirk puts the under-floor terrain of the plaza and other buildings into the town component.
  - Native code uses a per-vertex nudge direction here (§3.2), which we do not reproduce.
  - Proposed fix: refuse an exit whose landing lies inside, or within 1e-3 of, the exiting object's own footprint, and stay on the object like a closed-tile exit. `reach.ts` must mirror the change by skipping exit landings on terrain pieces entirely inside the footprint.
  - With the fix the census has **0 traps**, and the town component shrinks to 259,224 m² because the under-floor terrain drops out. The random-walk soundness still holds.

### 11.4 The server rule (to be wired into `apps/server`)

- **Player placement** (relog restore, GM teleport, respawn) is valid only if the position's component is the **town spawn's component**.
  - Otherwise, use the nearest point within 10 m (rings of 1 m) that has a surface in that component: `locateIn(x, z, yHint, town)`.
  - Otherwise, use the town spawn.
- **Relocation height hint.** While the corner quirk stands, the terrain under the plaza belongs to the town component. A relocation should therefore pass the highest surface (`yHint = +∞`), so that someone rescued from the basin stands on the plaza rather than 1.5 m under it.
- **Nest spawn points** must lie in the town's component as well. All 8 nests inside the exported Jangan regions do.

## 12. Wave 12: map edits and the walking rebuild (docs/WORLD_EDITOR.md §6.3, docs/WAVE_PLAN8.md §2.5, D40)

- **The nav rule** (`packages/shared/src/world-edits/nav-rule.ts`, one pure function for the editor's red tiles, the
  converter's nav step and the tests): a 2 m tile touching a vertex an edit moved by more than 5 cm **closes** when it
  is open, its slope after the edit is over 0.7 (35°) and the edit made it steeper by more than 0.05 (retail's own
  steep open tiles stay as they are); an open tile under **new** water deeper than 1.2 m closes (until swimming); a
  closed tile **never opens by itself**; the editor's Walkable overrides apply last. Heights in metres; the nav's file
  units are metres × 10. The converter writes the result into the region's `.nvm` (the closed cell and the blocked
  tile flag, as the coast's `navgen.ts` does), so the server and the client read the same walking map.
- **Object footprints follow the objects** (S-NAV, `packages/nav/src/instances.ts`): instances are keyed
  `regionId << 16 | uid`; an edit removes, replaces in place (a move: same id and slot, new transform) or appends (an
  editor add, uid 0xE000–0xEFFF, with the model's collision record). Linked instances (the palace bridge pieces) are
  never edited. `NavWorld.editInstances` applies an edit in place (the editor's preview); `nav.bin` and
  `nav-objects.bin` are spliced by WE-I's incremental convert. The footprint stays unscaled (D17).
- **The Publish checks** (`packages/convert/src/world/edits/checks.ts`, before = the live `nav.bin`, after = the
  staging one): no new trap (enclosed open areas), every nest, NPC, gate, place and probe the town reached is still
  reachable, the gates and roads still reach each other both ways — each of these **stops** a Publish; ground cut off,
  props floating or buried on moved ground, footprint overlaps and the per-region budgets warn. I-12's run on the real
  export (a hill, a painted path, three planted trees, a moved lantern) read 15 traps before and after, 63 of 63 points
  still reachable, 14 gate pairs connected, `nav.bin` 2,233 → 2,236 object instances (the three trees' footprints), all
  checks in 3.0 s; a walking client on the private test server went up and over the new hill and back.
