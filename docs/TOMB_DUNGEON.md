# The Qin-Shi Tomb: the 15–20 group dungeon (wave 14, "The Climb")

The centrepiece of the new 1–20 journey. This spec designs the tomb from the retail data we already have: the
**interior of the vSRO 1.188 client** (six floors, 59 MB of meshes, lightmaps and navmeshes), the **retail tomb
monsters** (`MOB_TQ_*`, 64 rows with models and clips), and our own server, client and balance model.

The user's words, verbatim:

> The Qin-Shi Tomb as the 15-20 group dungeon: the centrepiece of the new 1-20 journey.

> Silkroad Online retail never made level 1-20 fun. [...] So let's make it fun. We adjust monster's levels and
> difficulty, also unique monster's. [...] Level 20 should be difficult to reach since its a level cap.

> after level 15 if player dies they loose a random % from 1% to 20% (rule 13)

Defaults the user kept: about 40 hours of real play to reach 20; solo-friendly to about 15, **the Tomb and the big
bosses need a group**; rates back to x1 with the new curve. New clothing and weapon art come in waves 15 and 17, so
this wave leaves **named slots** for them.

**The user delegated every decision.** Wherever there is a choice this spec takes the option it would mark
"(Recommended)" and writes it as a decision with a one-line reason (§13). Only what truly needs the user is in §14
and §15, each with the default used meanwhile.

**Design only.** This spec edits nothing in `packages/`, `apps/`, `content/` or `deploy/` (wave 12 is building there).
Its prototypes and measurements are in `work/tmp/tomb/` (Appendix A). Meshy: **0 credits** spent (nothing needed it;
no NIGHT_LOG row). No download.

**Tags** (as in WAVE_PLAN9):

- **[confirmed]**: checked in code or data of the working tree on 2026-10-02, or measured by this spec's prototype; each
  says how.
- **[likely]**: strong evidence, not proven.
- **[projected]**: computed from a measurement (scaled, summed or derived), or the output of the balance model.
- **[unknown]**: open; the default is given.
- **[decision]**: a choice this spec makes (§13 lists them all).

**Coordination with the other wave-14 specs.** The re-tuned level curve, the field monsters' new levels, the gear
tiers and the death penalty (docs/CLIMB.md), nemesis monsters (docs/NEMESIS.md, which already excludes Tomb instance
monsters, its N1) and the storm Qilin (docs/STORM_QILIN.md) are designed in sibling specs written at the same time.
This spec does not wait for them: every tomb reward is written as **a fraction of the current level's bar** or as
**"hours of frugal field grinding at your level"**, so it re-scales with any curve, and every tomb monster is
**derived from the field curve at its level** (§5.2), so it follows the re-tune. The numbers below use today's curve
(`levels.json`) and today's monsters; WAVE_PLAN10 (the wave-14 build plan) re-runs `sim-tomb-fc.ts` on the merged curve
(one command, §6.5).

**Fact-check (2026-10-02, §19).** An adversarial pass re-derived the [confirmed] claims and the balance and changed
this spec in place. The main changes: the NPC is now the **Tomb Steward**, because CLIMB's mini-boss MB4 is "the Gate
Warden" at the same door. The fury moves to **9 / 10 / 12 min**, so the three friends at the bottom of each band no
longer meet it. Lamps go **dark during a boss fight**, which matches the sim and stops corpse-run zerging under CLIMB's
10-minute grace. Each character is bound to **one live instance**. Tomb space needs **two spatial changes**: per-area
clamping in `World`, and a client stage origin for float32 precision. The tiers, set slot, legendary hook, quest id,
titles, `Mob.tag` and the trash-EXP budget now follow CLIMB.md and NEMESIS.md, which were written alongside this spec.

---

## 0. Summary

1. **The retail tomb interior exists in our client data and we can use it.** `dungeoninfo.txt` names six floors
   (`Dungeon\china\jinsi_floor01..06.dof`); Data.pk2 holds all six DOF layouts, **920 meshes (59 MB), 849 lightmaps
   (23 MB), 134 materials (7.5 MB)** and a navmesh on the floor meshes, with the retail teleport gates as navmesh
   events [confirmed: extracted files, `work/tmp/tomb/dof_parse.py`, `floor_nav.ts`, `bms_ext.ts`; re-run by the
   fact-check: 849 lightmap files, 23 MB, 59 MB of meshes]. We have no DOF reader yet; this spec's scratch parser
   (heuristic: it finds blocks by their `.bsr` path strings) reads every block of all six floors (declared = found,
   1/20/89/87/23/5 blocks [confirmed: re-run]). The retail tomb is **built at field scale**: floor 1 is one hall of 0.66 × 1.18 km, floor 3 spans
   4.4 km [confirmed: block AABBs and navmesh, 1 unit = 1 dm as `gltf/space.ts` says].
2. **Instanced, by slots** [decision]: each party gets its own copy of the tomb, leased from **6 pre-placed slots** in
   a far "tomb space" (10 km apart). Spatial separation does what an instance system would otherwise need a plane id
   for: interest management, monster AI and every area attack work unchanged, because no two copies are ever within
   view range. The navmesh is shared (one copy, routed by a `CompositeNav` with a per-slot offset). **Two spatial
   changes are still needed** (fact-check F1, F2): `World.clamp` clamps every warp and move to the field export's
   bounds today, so it must clamp per area (field or slot). The client must also render a slot relative to its
   origin, because at 40–100 km Babylon's float32 matrices step 4–8 mm.
3. **Three wings, three retail floors, three bosses** [decision]:
   - **Wing I, the Terracotta Road** (floor 1, levels 15–16): a 1 km processional hall, six terracotta formations,
     two pits whose pressure plates wake bomb ghosts, the **Bell Gate** puzzle, and **Tomb General Hyun** (17).
   - **Wing II, the Quicksilver Halls** (floor 5, levels 17–18): a hub on a quicksilver river and three arms with three
     trials (a **trap gallery**, the **Mirror Room**, the **Statue Room**) that light three seals, then **BeakYung the
     White Viper** (19). The fishing hook's Tomb Seal Shards open an optional **Treasure Vault**.
   - **Wing III, the Sanctum of the Four Guardians** (floor 6, levels 19–20): **SoHaow the White Tiger** (20), the
     guardian the Tiger Girl made her bargain with, with the **West Wind Ward** (strike the lit jewel) and Shadow Tigers.
     (The retail row is `MOB_TQ_EASTGUARDIAN`; the story calls him the West's tiger, as the myth does.)
   Floors 2–4 (the teleport maze and two 4 km labyrinths) are not used: they are hooks.
4. **Entry:** the retail tomb door at the north end of the plaza (`c_jin_ent02`, (864, −1070), reachable on foot
   [confirmed: `door_probe.ts`, re-run]), through an authored **Tomb Steward** (renamed from "Warden": CLIMB's MB4
   is "the Gate Warden" at this door); **party of 2–4, every member level 15+**, within 30 m. A first entry is the
   attunement quest, which is CLIMB's slot **JG_X15**. A later wing opens for a character once the boss before it
   died with them (§3). Each character is bound to **one live instance** at a time (§3.1).
5. **Balance from the simulation** (`work/tmp/tomb/sim-tomb-fc.ts`, the fact-checked fork of the balance model, 100
   runs per case, fury at 9 / 10 / 12 min) [projected]:
   - **In band, 4 players:** Wing I ≈ 19 min at 16 (boss 3.3 min), Wing II ≈ 39 min at 18 (boss 5.3 min),
     Wing III ≈ 17 min at 19 (boss 7.2 min); a full clear at 19–20 ≈ 68–73 min; 0.02–0.14 deaths per player per wing.
   - **3 players (the three friends today) clear every wing in band, but the band floor is hard:** Wing I at 3 × 15
     98 % (0.51 deaths each, about 5 % of a bar lost), Wing II at 3 × 17 100 % (0.30), Wing III at 3 × 19 100 % (21 min,
     0.21). At a first-run uptime of 60 %, Wing I at 3 × 15 drops to 85 %, so **a trio should wait for 16**.
   - **Duos:** Wing I at 16+ (2 × 15 clears 23 %). With the later fury, a duo at the top of a band can clear Wing II
     (2 × 18: 92 %) and Wing III (2 × 20: 99 %, 0.47 deaths each). A duo is still a group; a duo at 19 fails Wing III
     (6 %). A solo level 20 fails Wing III, and the entry rule forbids solo anyway. **Every boss needs MP potions**,
     like the Tiger Girl.
   - **EXP:** a repeat run gives about the frugal field rate per hour (Wing I 1.2×, Wing II 0.7×, Wing III 1.0×), so
     the tomb is not a farm. The **first run of each wing per 20 h** adds the boss chest's **Emperor's Favour** (20
     minutes of the climb at your level, only inside the wing's band), so the daily run is worth ≈ 1.2× (Wing II) to
     ≈ 2.2× (Wings I and III) the field for that hour. **Rule 13 bites:** a sloppy party (dodge 0.3) loses 0.6–3.5 % of a
     bar per wing to deaths, and a trio at a band floor loses 3–5 %. A party without MP potions loses every boss, and each wipe costs every member one
     penalised death (§3.6).
6. **Bosses readable in SRO's style:** every special is a red **ground telegraph** that fills over its wind-up
   (cone, circles, line, ring), with its own line in the top-centre notice banner; adds at HP bands; enrage at 20 %; a
   **fury** (damage ×3) at 9 / 10 / 12 minutes so a party out of band cannot grind a boss down (the author's 8 / 9 / 10
   left the three friends at each band floor 20–60 s from it at p90, §6.3). Telegraphs are new: one
   additive message and one client decal (§5.7).
7. **Loot:** a **personal chest** per boss per character per 20 h: the band's best gear (CLIMB's T5 at Wing I and T6
   at Wings II–III, chosen by required level and not by grade letter, +0..+3, 10–25 % Seal of Star T7), chest gold
   that pays a run's potions, a Tomb Seal Shard, an Ancestor's Incense from SoHaow (CLIMB §6.2), and **Terracotta
   Regalia tokens** for CLIMB's set slot **W15-A**, which wave 15 fills with art. A 2 % **Broken Hilt of the Emperor**
   is a component that wave 17 may use for CLIMB's **W17-B** legendary. It is not a second legendary (§7).
8. **Server cost, measured** with a scratch copy of the real server (in-process, ephemeral port, temp DATA_DIR):
   on top of the live field (6,083 monsters) each active slot (4 bots fighting, ≈ 145 monsters) adds
   **≈ 0.19 ms mean per tick** on the dev PC; **8 slots: 1.74 ms mean, 2.87 ms p99** against the 100 ms tick
   [confirmed: `instance-cost.ts`]; **≈ 4.3 / 7.2 ms on the N100** [projected ×2.5]; heap **+0.3–0.5 MB per slot**;
   ≈ 10 KB/s of JSON per slot [confirmed]. The slot count is not a server problem; it is capped at 6 for memory and
   sanity.
9. **Client:** the tomb is its own lazily loaded world export (`qin-tomb`, ≈ 10–13 MB [projected]) with an
   **interior** profile: no sky, sun, ocean, terrain, grass or weather; retail lightmaps; dark fog at 110 m; flame
   bowls as the light pick. Per frame ≈ 40–95 k triangles and 60–140 draws before merging, against the plaza's
   ≈ 183 k triangles on Medium: **≈ 4–7 ms WebGPU Medium** with a party and a boss [projected], well inside 60 fps.
   The slot is drawn relative to its origin (the stage origin, F2).
10. **Nothing blocks the start.** The user looks at the two images (`work/tmp/tomb/tomb_layout.png`,
    `tomb_bosses.png`) and, after the build, does one run per wing with the friends (§16.4).

### 0.1 Where each request lands

| Request (task text) | Where | Lanes |
|---|---|---|
| Survey: regions, the tomb keep (COAST), nests, monsters, an interior? | §1 | — |
| Instanced or open (justify) | §2 | TB-S, TB-NAV |
| Entry: party 2–4, level 15+, a key or a quest | §3.1–§3.3 | TB-S, TB-Q |
| Layout: wings, puzzle rooms (plates, mirrors, rotating statues, traps) | §4 | TB-CV, TB-P |
| Monster roster and mechanics per wing (retail tomb monsters, new behaviours) | §5.1–§5.3 | TB-CV, TB-M |
| 2–3 bosses readable in SRO's style (telegraphs, adds, enrage) | §5.4–§5.7 | TB-B, TB-TG |
| Loot (band's best gear, a tomb-only set slot for wave 15) | §7 | TB-L |
| Lockouts and timers | §3.4–§3.5 | TB-S |
| Story tie-in with "The Tiger's Shadow" | §8 | TB-Q |
| Server cost on the N100 (CPU, memory per instance), measured | §9 | — (G-14 re-measures) |
| Client: streaming an interior, lighting, the 60 fps budget | §10 | TB-CV, TB-R, TB-G |
| Prototype: layout map, boss sketch, server-cost measurement | Appendix A | — |
| "Level 20 should be difficult to reach" | §6 (EXP parity, the chest only in band, the fury, rule 13) | TB-S |
| Rule 13 (death penalty from 15) | §3.6 (tomb deaths count; revive at a lamp) | (the death-penalty lane) |

---

## 1. Survey: the tomb today

### 1.1 The overworld: the plaza, the keep, the nests [confirmed unless tagged]

- **Zones** (FIELDS.md §2.2): "Enterance of Qin-Shi Tomb" (client spelling), regions 171–174 × 99–102, 10 regions,
  365 monsters of levels 8–9 plus a skipped Hyeongcheon 30 pair; "Chinese Tomb", 171–173 × 92–94, 9 regions, 312
  monsters of 8–9. `/tp` places `enterance-of-qin-shi-tomb` (979, −768) and `chinese-tomb` (847, 742) [confirmed:
  `manifest.places`].
- **The plaza** (placements in `jangan-fields/manifest.json`): the outer gate `c_jin_enter01` at (860, −513); the moat
  walls `c_jin_wall` / `c_jin_bb_wall` along z ≈ −710…−727; the inner walls `c_jin_wall3_orwall(2)` at z ≈ −915; the
  tomb building `c_jin_ent01` at (863, −940); and **the tomb door `c_jin_ent02` at (864, −1070)** between the cliff
  meshes `c_jin_cliff_l` / `_r` (806 / 925, −1050). The retail exit gate `GATE_JINSI_OUT` lands at region 172,102
  local (960, 111, 1662) = (864, −1069) in world metres: the same door.
- **The tomb keep (COAST.md §3B.4):** the retail mountain north of the plaza (x 171.25–173.75 × 103) is kept
  bit-identical up to the crest + 24 m, so the view from the plaza keeps its 112–138 m backdrop; the beach N5 lies
  below its seaward face. The tomb's cliff meshes stand on unmoved ground. The tomb door is not affected.
- **Reachability:** the door, the ground in front of it, the plaza centre and the outer gate all place on the navmesh
  in the town's walkable component [confirmed: `door_probe.ts`, `MeshNav.place`; the door's own navmesh carries the
  player into the doorway at y 6].
- **Nests near the door:** two aggressive Stone Ghost (9) packs (5466, 5467) **34 m and 40 m from the Steward's spot**
  (864, −1040), which is 56 m and 62 m from the door itself; three more at ≈ 183 m; and **Hyeongcheon 30 × 2 (nest
  2065) 38 m behind the door** (68 m from the Steward), which the server skips today (`MOB_LEVEL_MAX` 25) [confirmed:
  `door_probe.ts` re-run; the probe's "from the door" column measures from (864, −1040)]. **After CLIMB** the plaza is
  band B4, "the Tomb Approach" (12–15): aggressive linked stone packs with healers, and the mini-boss **MB4 "the Gate
  Warden"** (16, a 30–45 min respawn) "before the Qin-Shi Tomb doors" (CLIMB §2.1, §2.5). CLIMB owns these nests. This
  spec asks that **nothing above level 20 spawns within 80 m of the door**, and that **MB4's camp and every aggressive
  roam circle stay ≥ 40 m from the Steward**, so a party gathering at him is not pulled (§11.4).
- **Hooks already in the tree:** the **tomb moat** fishing water (FISHING §2.1, `tomb`, 364 m²) with the Quicksilver
  Eel and its broth (abnormal-state resistance +20 %), the **Tomb Offering Box** and its **Tomb Seal Shard** curio
  (FISHING §5.6), a bottle letter about the emperor's "rivers of quicksilver" (FISHING §5.7), and the questline's
  Act II line "The Qin-Shi tomb guardians are awake" (QUESTS §3.1). JG_013 and JG_014 send level-9/10 players to the
  plaza today; the tomb door is shut to them.

### 1.2 The retail interior in the vSRO client [confirmed: extracted Data.pk2 and Media.pk2]

`Media/server_dep/silkroad/textdata/dungeoninfo.txt` lists the six floors (ids 2–7) next to the Donwhang cave and the
Egyptian dungeons. `teleportdata.txt` has 87 `GATE_JINSI_*` rows: `GATE_JINSI_IN` / `_OUT`, the floor-1 exit
`01x01_12`, **68 floor-2 gates** (`02xRR_DD`: room RR, door at DD o'clock: the retail teleport maze), five gates each on
floors 3 and 4, three on floor 5 and four "bldg" gates on floor 6. Dungeon regions are −32761…−32766 (0x8007…0x8002).

| Floor | Blocks (DOF) | Kinds of block | Extent | Nav triangles | Render triangles placed | Mesh MiB placed (unique) |
|---|---|---|---|---|---|---|
| 1 | 1 | one hall (nave, side pits, a north court) | 664 × 1,178 m | 2,496 | 94,817 | 8.5 (8.5) |
| 2 | 20 | rooms joined only by teleport gates | 4,010 × 1,644 m | 10,740 | 291,760 | 18.3 (2.3) |
| 3 | 89 | 7 rooms, 10 passage kinds | 4,396 × 4,414 m | 46,248 | 929,188 | 60.3 (18.5) |
| 4 | 87 | 5 rooms, 18 tunnel kinds, a warp room | 3,778 × 4,123 m | 41,231 | 622,275 | 56.1 (15.3) |
| 5 | 23 | a hub, four arms, four end rooms | 3,462 × 3,503 m | 14,951 | 202,287 | 17.1 (8.2) |
| 6 | 5 | a cross hall and four rooms 722 m out | 1,979 × 1,753 m | 3,183 | 92,638 | 6.3 (3.6) |

[confirmed: `dof_parse.py` (every declared block found), `floor_nav.ts` (BSR → meshes and navmesh, placed by block
position and yaw), `bms_ext.ts`; image `work/tmp/tomb/retail_floors.png`]

- **Format notes for the converter** [confirmed by the scratch parser]: `JMXVDOF 0101`, eight u32 section offsets after
  the signature; a block is `path (lpString .bsr), name (lpString, cp949), u32, position f32×3, yaw f32, u32 entrance,
  AABB f32×6, fog colours and ranges, …, objects`; an object is `u32, name, path, position, rotation f32×3, scale
  f32×3, u32, u32 index`. The link and connection sections (block adjacency) are **not parsed** [unknown]; the
  navmesh of each block's BMS carries the walkable cells and the gate events.
- **Lightmaps:** every floor mesh has a second UV set and its own lightmap DDJ (849 files) [confirmed]; our object
  pipeline already exports lightmapped objects (`work/out/world/jangan-fields/lightmaps/`) [confirmed: folder].
- **Props:** flame bowls and lanterns (`jinsi_flame_bowl/l/s`, `floor2_stonelantern`), quicksilver water planes
  (`jinsi_floor3_large/small_water`), floor 6's animated jewels (`jinsi_floor6_jewel(02).bsr` + `.ban`), the trap
  clip `jin_trap01_01.ban`, bells and dragons in floor 1's mesh names [confirmed: file names].
- **Scale:** characters are 18 units (1.8 m) and a floor-3 room is ≈ 450 m across in the same units. The retail tomb
  was built at field scale. The design uses this (big arenas, long processions) and limits walking by using only three
  floors, gates and horses (§4). A viewer walk confirms the feel (TB-CV check).

### 1.3 The retail tomb monsters [confirmed: `work/tmp/tomb/tq_mobs.py` over characterdata, `bsr_anims.ts`]

65 `MOB_TQ_*` rows (the author counted 64; the fact-check's re-count over every characterdata file, and the author's
own `tq_mobs.py` output, list 65), levels 30 (the bomb ghosts) and 81–100, all far above our cap. **Every model is complete in
Data.pk2: meshes and every clip** (15–19 clips each; the guardians and the Black Snake borrow the tiger, ladon, yeowa,
fw_taese and sealrocky clip sets). Their MSKILL rows exist (232 `MSKILL_TQ_*`, including six-row traps).

| Family (English names, textdata) | Codes | Retail level | Collision radius | Use here |
|---|---|---|---|---|
| Tomb Soldier / Warrior / Guard | `TOMBSOLDIER(_CLON,_CLON2)` | 81–83 | 1.6 m | Wing I melee |
| Tomb Archer / Bowman / Hunter | `TOMBARCHER*` | 84–86 | 1.6 m | Wing I ranged |
| Qin- / Shi- / Bloody Tombstone | `QINSHITOMBSTONE*` | 81–84 | 0.4 m | Wing I caster (stationary) |
| Baby / Bomb Stone Ghost | `SMALLSTONEGHOST`, `BOMBSTONEGHOST` | 30 | 0.5–1.0 m | Wing I pit bombers |
| Tomb Spirit / Ghost / Stone Ghost | `TOMBSTONEGHOST*` | 86–88 | 1.0 m | spare |
| Royal Soldier / Guard / Warrior | `ROYALSOLDIER*` | 88–90 | 1.7 m | Wings II–III melee |
| Tomb Bug / Beetle / Pest | `TOMBBUGGHOST*` | 90–92 | 3.0 m | Wing II swarms |
| Tomb Snake Slave / Snakeman / Servant | `SNAKESLAVE*` | 91–95 | 1.0 m | Wing II melee, Viper adds |
| Tomb Snake Woman / Lady / Mistress / Countess | `SNAKEWOMAN*` | 92–97 | 1.0 m | Wing II caster |
| Tomb Snake Demon / Devil / Soul | `SNAKEDEMON*` | 94–98 | 2.5 m | spare |
| Tomb Snake Worker / Master / Lord | `SNAKEMAN*` | 97–99 | 1.0 m | Wings II–III melee |
| Guardian of Treasure / Abundance | `TREASURE_GUARD(_CLON)` (rarity 6 elite) | 87, 97 | 1.6 m | the Treasure Vault |
| Tomb General Hyun / Bi / Ho / Jin | `TOMBGENERAL*` (rarity 8, scale 200) | 85–90 | 3.0 m | **Boss 1** |
| Snake General Ki / Jung / Yul / Hew | `SNAKEGENERAL*` (8, scale 200) | 95 | 2.8 m | spare (a later hard mode) |
| SoHaow The White Tiger | `EASTGUARDIAN` (8, scale 400, tiger clips) | 99 | 6.8 m | **Boss 3** |
| TaeHo The Blue Dragon, JeonUk The Black Tortoise, YumJae The Blue Hawk (retail textdata names; `WEST` is the dragon) | `WEST/NORTH/SOUTHGUARDIAN` | 98–99 | 2.1–9.0 m | sealed rooms (hooks) |
| BeakYung The White Viper | `WHITESNAKE` (**unique**, scale 160) | 100 | 8.0 m | **Boss 2** |
| SoSo The Black Viper (+ Scroll, Titan) | `BLACKSNAKE*` | 100 | 2.4 m | hook |
| ShinMoo The Man of Flames | `FLAMEMASTER` (a `.cpd` character) | 100 | 1.0 m | hook |
| Goon, Tae, Le, Jin, Son, Kam (the six trigrams) | `QINSHITRAP1-6`, `SNAKETRAP1-6` | 85, 95 | — | Wing II trap gallery |

The retail **server** spawn tables for the tomb are not in the client and not in the port data (`spawns.json` has
five provinces, none a dungeon) [confirmed]. Every placement in §4 is ours.

### 1.4 What our code has today [confirmed: read]

- **One `World`** (`apps/server/src/world.ts`) with one `NavProvider`, one tick (`TICK_HZ` 10), interest by distance
  (`VIEW_RANGE` 120 m + 10 m hysteresis). Idle monsters with no live player within view range + margin only regenerate
  (`gameplay.ts tick`): an empty part of the map costs one distance check per monster per tick.
- **The World clamps to the export's bounds** [confirmed by the fact-check: `world.ts` `warp()` and `moveEntity()` call
  `clamp()`, which clamps x/z to `bounds`, the field manifest's x −2304…1344, z −1152…1344]. A warp to x = 40 km
  today lands on the field's east edge. The interest grid (`updateInterest`, string keys) and `MAX_COORD` (1,000 km,
  `validate.ts`) have no limit that tomb space would hit [confirmed].
- **`MeshNav.place` keeps placements in the home component** (`setHome`, the town's walkable component) [confirmed:
  `nav.ts` 257–316]. CLIMB's seam S-NAV2 changes `setHome` to a list of components.
- **The navmesh walks object surfaces** (`packages/nav/src/world.ts`: terrain walker, object walker, linked global
  edges between objects); retail dungeon blocks are objects with navmeshes.
- **The client stage host loads a stage per world name** (`apps/game/src/stage/host.ts`: `useScene('stage:<world>')`,
  `resolveAssetBase(roots, worldName)`), so a second world export is a supported shape; switching worlds in play is
  not wired [likely].
- **Boss machinery from wave 11** (`uniques.ts`, `mob-skills.ts`): `Mob.damageMul` (enrage, fury), `MobTuning`
  (`hpMul`, `attackMul`, `expMul`), summons clipped by band, leash reset, the notice banner, an 8 s corpse. Quest
  encounters (`quests/encounter.ts`) already create owner-bound monsters with no nest.
- **No ground telegraph exists** (no `telegraph` in `packages/shared` or `apps/game`) [confirmed: grep].
- **Statuses:** `poison` (1 s ticks), `zombie`, `stun`, `knockdown` and others (`skills/effects.ts STATUS_RULES`).
- **Party:** up to 8 (`PARTY_MAX`), share/free EXP, round-robin loot (QUESTS §4).

---

## 2. Instanced or open [decision: instanced, by slots]

### 2.1 The choice

| | Open (retail-like, one shared tomb) | Instanced per party (chosen) |
|---|---|---|
| Group feel | parties meet, compete for packs and bosses; a boss is up for whoever is there | your party's run: the classic group dungeon |
| Puzzles | one shared state: a party solves what another left half-done, or finds it done | a fresh puzzle per run, solved by you |
| Bosses | on timers like the Tiger Girl; most nights no one sees one | every run ends at a boss |
| Rewards | first-come; a daily chest needs a lockout anyway | personal chests per 20 h |
| Server work | only more nests, in a separate area | a lease, lifecycle and per-slot spawning (§2.2); measured cost tiny (§9) |
| With 3 accounts | an empty tomb most of the time | the same as a full server |

**Reason:** the tomb's job is to be *the* group experience of 15–20 for a few friends; an open tomb would mostly be
empty and its bosses mostly dead. The cost of instancing is small once instances need no new spatial rules (§2.2).

### 2.2 How: slots in a far "tomb space" [decision]

- **Tomb space:** a strip of world coordinates far east of the export (x ≥ `TOMB_X0`, e.g. 40 km; the field export
  spans ≈ 3.5 km). **6 slots**, slot k at x = `TOMB_X0` + k × 10 km. Inside a slot the three floors sit side by side
  (floor 1 at +0, floor 5 at +3 km, floor 6 at +7.5 km). Copies are never within 9 km of each other.
- **Why slots, not a plane id:** a per-entity "plane" would have to be checked by interest management, monster target
  acquisition, `playersNear`, skill AoE targeting, monster AoE, ground items, party share range, the minimap… every
  spatial query, today and in every later lane. Distance already separates all of them. **No spatial *query* code
  changes** [decision]. Two pieces of position code do change (fact-check F1, F2):
  - **Per-area clamping (server).** `World.clamp` clamps to one rectangle, the field bounds. It becomes a list of
    areas (the field plus one rectangle per slot): a target is clamped into the area that holds the mover's current
    position, and a warp is clamped into the area that holds its target. The S-NAV seam owns this change in
    `world.ts`. Without it, a warp into tomb space is clamped back to the field's edge.
  - **The stage origin (client).** At x = 40–100 km, float32 world matrices step 4–8 mm (2⁻⁷ m at 65–131 km),
    which is enough for skinned characters and the floor decals to shimmer [likely]. The client therefore renders
    a slot **relative to its origin**: positions crossing the network boundary (spawn, move, warp, telegraph,
    ground items, and the outgoing moveTo or target point) have the slot origin subtracted on the way in and added
    on the way out, in one pair of functions owned by S-STAGE. The field keeps origin 0. Babylon's own large-world
    option is [unknown] for 9.28 and would change the engine for the field too, so it is not used.
- **Navigation:** one `MeshNav` for the tomb (the three floors' navmesh, ≈ 0.5 MB raw [confirmed: `navbytes.ts`,
  re-run: 124 + 252 + 121 KiB]), loaded once, with its own home component (the tomb's walkable mesh). A
  `CompositeNav` (a new file that delegates; `nav.ts` stays CLIMB's S-NAV2) routes a query by x: below `TOMB_X0` to
  the field mesh, above it to the tomb mesh with x − slot origin. Its `surfaceKey` prefixes tomb keys (`tomb:`), so a
  tomb surface can never be restored into the field. Moves never cross (only warps do). Memory: one copy, not six.
- **Lease:** the tomb module leases a free slot to a party at entry and returns it when the instance closes (§3.5). No
  free slot: the Steward says "The tomb is crowded, wait a moment" (6 parties = 24 players, more than the server's
  population).
- **Monsters:** created by the module through `gameplay.createMob` with `nest: null` (like encounters), **per wing on
  entering it** (≈ 40–55 monsters; not all three floors at once, so an entry tick stays small [unknown: G-14 reads
  the entry tick]). They carry NEMESIS's `Mob.tag = 'instance'` (S-ELIG), and the module keeps its own map from monster
  id to slot, so a closing instance despawns them. They never respawn, and they stay dormant until a player is in
  view (the existing rule).

---

## 3. Entry, lockouts, timers, deaths

### 3.1 The door and the Steward [decision]

- **Tomb Steward Baek**, an authored NPC (`NPCX_TOMB_STEWARD`, wearing an existing soldier model by the decision-43
  model override) at (864, −1040), 30 m in front of the door, out of the two Stone Ghost packs' roam (the TB-Q check
  moves him if a nest roams over him: the 25 m rule of QUESTS §3.3).
- The **party leader** talks to him: "Enter the Qin-Shi Tomb" → a wing picker (the wings every member has unlocked)
  → the module checks and warps the party to the wing's first lamp.
- **Requirements:** a party of **2–4**; every member **level 15+**, within 30 m of the Steward, alive, not in a
  trade, stall or duel; horses parked or ridden in (allowed, §4.5). A party of 5–8 must split. Refusals name the
  member and the rule ("Mei is level 14").
- **Join later:** a member of a party with a live instance (a relogger, a friend invited later while the party has
  < 4 inside) can talk to the Steward alone: "Join your party in the tomb" warps them to the last lit lamp. **The join
  re-checks every entry rule for the joiner** (level 15+, JG_X15, the wing unlocked, alive, not trading), so it is
  never a way around them [decision, fact-check F7]. A lamp in a boss court is dark during the fight (§3.6), so a
  joiner waits at the lamp before it.
- **One live instance per character** [decision, fact-check F6]. A character inside, or bound to an instance that has
  not yet closed, cannot start another. The leader's "Enter" with any bound member is refused: "Mei is still bound
  to another tomb run (it closes in 7 min)". Leaving, a Return Scroll or disbanding the party does not unbind;
  only the instance closing does (10 min empty, §3.5). Reasons: (1) a party cannot lease all 6 slots by entering and
  leaving, (2) "reset farming" of the packs nearest Lamp 1 costs a 10-minute wait per reset, which puts it at
  ≈ 8 % of a bar per hour at 16 [projected: two formations ≈ 2,230 EXP each per 13 min], below the frugal field's
  ≈ 23 %, and (3) re-forming the party under a new id changes nothing.

### 3.2 Key or quest [decision: a quest unlocks; no key per run]

- **No consumable key** for a normal run. Keys add friction for three friends and nothing the lockout does not
  already do.
- **The attunement quest** `JG_X15 "The Emperor's Door"` (level 15, after JG_020 "The Masked Buyer") is the first
  entry: every member needs it accepted or done. The id is **CLIMB's reserved slot** (CLIMB §8.2: JG_X15 "The Seal of
  the Doors", "the key to the Tomb (TOMB_DUNGEON owns the key's design)"). TB-Q writes it in `content/quests/tomb.json`,
  and CLIMB's quest lane leaves the id out of `jangan.json` (one id, one file) [decision, fact-check F12].
- **The Tomb Seal Shards** (FISHING's curio, 1 in 200 casts at the tomb moat via the Offering Box; also 2 % from tomb
  monsters and 1 per boss chest) are the optional key: **5 shards make a Tomb Seal** (combined at the Steward), which
  opens **the Treasure Vault** in Wing II for the whole party once (§4.3). The fishing hook becomes a reward, not a
  gate. **The shards have a second sink:** CLIMB §6.2 trades 5 shards for an Ancestor's Incense at Miaoryeong. Both
  stay; the player chooses between them (the Incense is the safer pick, the Vault the richer one).

### 3.3 Wing unlocks [decision]

A character unlocks Wing II by being credited with a Tomb General kill, Wing III with a White Viper kill (persisted,
§11.2). The Steward offers a wing only if every member has it. Reason: a level-18 party runs the wing of its band
without a 20-minute Wing I it has outgrown, and the band-locked Favour (§3.4) keeps the order meaningful.

### 3.4 Lockouts [decision: the chest, not the door]

- **Entry is never locked.** Friends can help a friend, practise, or run again.
- **Each boss chest is personal and opens once per character per 20 h** (the springs' "one fill per 20 h" rhythm,
  HOT_SPRINGS F5). A character inside the lockout sees the boss's ordinary drops (gold, trash loot, shards) but no
  chest. The UI shows each chest's lockout in the Steward's dialog ("Tomb General: ready / 13 h 20 min").
- The **Emperor's Favour** (the chest's EXP) pays only while the character's level is inside the wing's band
  (**Wing I 15–16, Wing II 17–18, Wing III 19–20**; at 20 it becomes SP-EXP like quest EXP at the cap). Reason: "Level
  20 should be difficult to reach": an out-of-band character cannot use an easy wing as a daily EXP fountain.
  **The bands do not overlap** [decision, fact-check F4]. The author's bands (15–17, 17–19, 19–20) paid two Favours a
  day at 17 and at 19, which made a 2 h/day friend climb ≈ 30 % faster at 17 and ≈ 25 % faster at 19. CLIMB §3.5
  says the Tomb's reward is "the loot, not speed". Without the overlap, the Favour saves a 2 h/day friend
  ≈ 4–5 h of CLIMB's 28.7 h from 15 to 20 [projected: the days spent at each level × the daily Favour × CLIMB's
  model hours]. CLIMB's merged re-run (WAVE_PLAN10) includes it in the 40 h.
- **The Favour is a per-level table of the bar, not a computed "minutes"** [decision, fact-check F10]: the server has
  no frugal-rate model. It is 20 minutes of CLIMB's planned climb at that level, ⅓ h ÷ CLIMB §3.2's model hours:
  **15: 10.7 %, 16: 7.7 %, 17: 6.1 %, 18: 5.4 %, 19: 3.5 %** of the bar (`favourPct` in `tomb.json`). On today's curve
  the sim's "20 minutes of frugal grinding" gives 10.1 / 7.7 / 5.7 / 4.7 / 3.7 %, nearly the same.
- **Who opens a chest** [decision, fact-check F7]: a party member who was **inside the instance when the boss was
  pulled** and is credited by the existing party rule (online, alive or dead in the arena, within 60 m of the corpse).
  A member who joins mid-fight gets the boss's ordinary drops but no chest, Favour or wing unlock that run.

### 3.5 Timers and lifecycle [decision]

| Timer | Value | What happens |
|---|---|---|
| Instance hard cap | 120 min from entry | a 5-minute warning, then everyone inside is warped to the Steward; the slot closes |
| Empty instance | 10 min with no member inside or online | closes (a relogger within 10 min returns to the last lamp) |
| After the wing's boss | the exit gate opens; 10 min to loot and leave, or descend (if the next wing is unlocked for all) | closes when empty |
| Server restart | instances are not persisted | a character saved in tomb space logs in at the Steward (§11.2) |

The full clear's p90 is 73–78 min (§6), so the 120-minute cap only stops a stalled party.

### 3.6 Deaths in the tomb, and rule 13 [decision]

- **Rule 13 applies unchanged, as CLIMB §6 builds it:** a death to a tomb monster or boss at levels 15–19 costs a
  random 1–20 % of the current bar, never a level, and nothing at 20 (no bar is kept at the cap). It comes with
  CLIMB's **10-minute grace** (a second death within 10 min of a penalised one is free), the **Ancestor's Incense** and
  the **Soul Rebirth refund** (50 %, only before the player revives) [confirmed: CLIMB §6.1–§6.3]. Trap statues,
  quicksilver pools and bomb blasts count as their monster's (CLIMB: "damage over time from a monster counts as the
  monster's").
- **Revive at the last lit lamp, not in town.** Each wing has 1–2 **lamps** (checkpoints with a 12 m safe circle, §4);
  "Revive" puts the player there at 50 % HP / MP, still in the instance. Reason: a death must hurt (rule 13) without
  also throwing the party's run away. A Return Scroll still works (to town; the instance keeps the slot for 10 min).
- **The boss court's lamp is dark while its boss is in a fight** [decision, fact-check F5]. A player who dies in a
  boss fight stays down until the fight ends (the kill or a wipe), unless a friend's Soul Rebirth raises them, which
  is the SRO way and CLIMB's refund. Without this rule, CLIMB's 10-minute grace turns a boss fight into a corpse run:
  after one penalised death, every further death costs nothing and the lamp is a short walk away. The sim already
  assumed it ("down until the fight ends").
- **A wipe** (every member in the fight dead) resets the boss (the leash rule: full HP, adds dismissed, the fury clock
  cleared), and the lamp relights. Each wipe costs each member one penalised death; a second wipe inside 10 min is
  free (the grace). A party that brought no MP potions loses every boss (§6.2), so **the Steward warns at entry** ("The
  guardians below outlast the unprepared: carry mana potions") and so does the shade at Lamp 1 [decision: the
  death penalty's feel; a warned loss reads as fair].
- **Tomb monsters never become nemeses** [decision]: an instance monster vanishes with its slot, so a nemesis made in
  the tomb could never be hunted. NEMESIS's eligibility (N1, seam S-ELIG) already excludes `Mob.tag = 'instance'`,
  and this spec uses that tag. The author's `Mob.instance` field is dropped (fact-check F11).

---

## 4. The layout

![layout](../work/tmp/tomb/tomb_layout.png)

`work/tmp/tomb/tomb_layout.png` draws the three floors from their navmesh with the design on top. Positions are
floor metres (block position + mesh); the build places by the same frame.

### 4.1 Wing I: the Terracotta Road (retail floor 1; monsters 15–16) [decision]

- **Arrival: Lamp 1** at the south door (z ≈ −345), a safe circle, and **the Steward's shade** (a ghostly copy of the
  Steward, the wing's story voice; §8). **Stele: the Emperor's edict** (lore).
- **The nave** (≈ 1 km north): six terracotta **formations** (F1–F6) on alternating sides of the road: 3 Tomb Soldiers
  + 2 Tomb Archers; F5–F6 swap an archer for a Qin-Tombstone caster. **Formation behaviour (new):** a formation wakes as
  one (one aggro pulls all five), the soldiers step forward and the archers hold 12 m back; a soldier at < 30 % HP
  calls the nearest sleeping soldier of the next formation (a "runner": kill it fast or fight two packs).
- **The pits:** two side pits (the black rectangles of the hall's navmesh) with **pressure plates** at their rims (a
  ground decal, cracks in the paving). Stepping on a plate wakes the pit: 3 Bomb Stone Ghosts and 2 soldiers climb out.
  The bombers run at the nearest player and **explode after 5–7 s** with a 4 m red circle (2 s telegraph). The pits
  are **optional**: a careful party walks the rim's plain stones and skips them (less EXP, faster).
- **The Bell Gate (puzzle):** the north court is shut by a bronze gate. Two bells hang beside it (floor 1's bell
  meshes); the stele shows a three-strike order ("low – high – low"), **rolled per instance**. Striking a bell is an
  interaction (2 s). A wrong strike wakes the last formation's runner pack and resets the sequence. Right: the gate
  opens, **Lamp 2** lights.
- **The court: Tomb General Hyun** (§5.4), then the **exit gate** (out, or down to Wing II).

### 4.2 Wing II: the Quicksilver Halls (retail floor 5; monsters 17–18) [decision]

- **Arrival: Lamp 3** at the hub, on the quicksilver river (the `large_water` plane with a mercury material: a
  silver, mirror-bright surface; the river is decoration, not swimmable).
- **Hub:** two packs (3 Royal Soldiers + 5 Tomb Beetles: the beetles swarm, low HP, low damage, many hits).
- **Three arms, three trials; each lights one seal on the north door.** Each end room has a **return gate** to the hub
  (the retail floor-5 gates), so a party walks each arm out once.
  - **West arm, the trap gallery:** the corridor is lined with **trap statues** (the retail `QINSHITRAP` / `SNAKETRAP`
    "monsters": static, untargetable, firing their MSKILL rows on a 3-beat rhythm: arrow volleys down a 4 m lane,
    flame jets, a stomp ring, each with its telegraph). **Pressure plates** silence the traps within 20 m for 6 s while
    someone stands on them; the far end has a **lever** that silences the gallery for good. The co-op version: one
    holds the plate, the others run, the last one through pulls the lever. Two snake packs (3 Snake Slaves + 1 Snake
    Woman) wait at the end.
  - **West room, the Mirror Room:** a quicksilver lamp throws a beam; **three bronze mirrors** on pedestals turn 45°
    per interaction (2 s); the beam (drawn by the client from the mirrors' yaws through one shared pure function) must
    reach the seal plaque. Two to three turns per mirror; the start yaws are rolled per instance from a list of
    solvable layouts. Lights **seal 1**.
  - **East arm and room, the Statue Room:** two packs (2 Royal Soldiers + 2 Snake Lords) on the way; in the room **four
    terracotta statues** (the Tomb Soldier model, frozen) stand on four glyphs of the Four Symbols (Tortoise, Dragon,
    Tiger, Bird). Each turns 90° per interaction; all four must face the direction their glyph names (north, east, west,
    south). A wrong full turn of all four does nothing; turning a statue twice in 3 s wakes it (a Royal Soldier fight:
    "the guardians do not like to be hurried"). Lights **seal 2**.
  - **The third seal** is the trap gallery's lever (above). **The south arm stays sealed** (a hook, §12).
- **The Treasure Vault** (optional, off the hub): a door that only a **Tomb Seal** (5 shards) opens; the **Guardian of
  Treasure** (an elite: ×4 HP) and a treasure coffer (§7.3).
- **North arm:** the **Seal Door** (three seals), the viper antechamber pack (2 Snake Slaves + 2 Snake Women), then
  **BeakYung the White Viper** in the north room (§5.5) and the **exit gate**.

### 4.3 Wing III: the Sanctum of the Four Guardians (retail floor 6; monsters 19–20) [decision]

- **Arrival: Lamp 4** in the **west room: the White Tiger's own room** (retail `jinsi_floor6_room01`), 722 m from the
  centre. The north, east and south rooms are the **sealed rooms of the other three guardians** (JeonUk the Black
  Tortoise, TaeHo the Blue Dragon, YumJae the Blue Hawk: the retail textdata names [confirmed]), each with a lore stele and its retail guardian standing behind a barrier,
  asleep: a hook for later.
- **The approach:** the west arm of the cross hall: two **sanctum guard** packs (2 Snake Lords + 2 Royal Soldiers),
  then **the guardian steps** (2 Snake Lords 20 + 2 Snake Women).
- **The centre hall: SoHaow the White Tiger** (§5.6), with **three guardian jewels** (floor 6's jewel model, as
  interactive props) **45 m** from the arena centre; then the exit gate.

### 4.4 Walking, and why only three floors [decision]

| Wing | Walk (approx.) | At 5.5 m/s | Puzzles | Packs | Boss |
|---|---|---|---|---|---|
| I | 1.0 km | 3 min | Bell Gate ≈ 1–2 min | 6 formations + 2 optional pits | General |
| II | ≈ 4.2 km (three arms out, gates back) | 13 min (≈ 7 on a horse) | trap gallery, mirrors, statues ≈ 7 min | 7 + the gallery (+ the Vault's guardian) | Viper |
| III | ≈ 0.8 km | 2.5 min | the jewels are in the fight | 3 | SoHaow |

Floors 2–4 are cut: the teleport maze (floor 2) is a fun idea that needs 68 gates and a map, and floors 3–4 are
4 km labyrinths of 87–89 blocks and 56–60 MB of placed meshes; they would double the download and the walking for no
new kind of play. They are hooks (§12).

### 4.5 Horses in the tomb [decision: allowed]

Wing II's arms are long and the retail floors were built for field speeds. Riding in is allowed; the existing mount
rules (dismount on attack, horses take damage) apply. The sim's walking times are on foot (the conservative case).

---

## 5. Monsters and bosses

### 5.1 Roster per wing [decision; levels assume the re-tuned field, §5.2]

| Wing | Monster (model) | Level | Role | Behaviour (new in bold) |
|---|---|---|---|---|
| I | Tomb Soldier (`TOMBSOLDIER_CLON2`) | 15–16 | soldier | **formations**, **runner call at 30 %** |
| I | Tomb Archer (`TOMBARCHER_CLON2`) | 15–16 | archer | holds 12 m back, retail arrow flight |
| I | Qin-Tombstone (`QINSHITOMBSTONE_CLON2`) | 16 | caster | stationary, magic force bolt (the retail Tombstone flight) |
| I | Bomb Stone Ghost (`BOMBSTONEGHOST`) | 15 | bomber | **runs at you and explodes: 4 m circle, 2 s telegraph** |
| II | Royal Soldier (`ROYALSOLDIER_CLON2`) | 17–18 | soldier | — |
| II | Tomb Beetle (`TOMBBUGGHOST_CLON2`) | 17–18 | swarm | **5–6 together, 45 % HP, 55 % damage** |
| II | Tomb Snake Slave (`SNAKESLAVE_CLON2`) | 17–18 | soldier | Viper adds |
| II | Tomb Snake Woman (`SNAKEWOMAN_CLON2`) | 18 | caster | **poison bolt** (`poison` status, the broth helps) |
| II | Tomb Snake Lord (`SNAKEMAN_CLON2`) | 18 | soldier | — |
| II | Trap statues Goon…Kam (`QINSHITRAP1-6`) | — | trap | **static, untargetable, rhythmic, silenced by plates and the lever** |
| II | Guardian of Treasure (`TREASURE_GUARD_CLON`) | 18 | elite | the Vault only |
| III | Tomb Snake Lord (`SNAKEMAN`) | 19–20 | soldier | — |
| III | Royal Warrior (`ROYALSOLDIER`) | 19 | soldier | — |
| III | Tomb Snake Woman | 19 | caster | poison |
| III | Shadow of the White Tiger (the `WHITETIGER` model, darkened) | 18 | soldier | SoHaow's adds |

### 5.2 Stats: the field curve at the level × a role [decision]

Retail tomb stats are useless here: levels 81–100, normal rows with 2,000–29,700 HP, and bosses with 6.2 M (the
General) to 184 M (the White Viper) HP [confirmed: `tq_mobs.py` re-run]. A tomb monster takes **only its model, clips and
MSKILL rows** from retail and its **numbers from our own field curve**:

- `curveAt(L)`: a least-squares log-linear fit through today's normal field monsters of levels 10–20 for HP, mean
  attack, PD, MD and EXP (`sim-tomb.ts curveAt`). At level 16 that is 625 HP, attack ≈ 123, PD 44, 369 EXP.
- **× the role:** soldier HP 1.3, attack 1.0, defence 1.1, EXP 2.0; archer 0.9 / 1.0 / 0.9 / 2.0; caster 0.8 / 1.1
  (magic) / 0.8 / 2.0; swarm 0.45 / 0.55 / 0.8 / 0.7; bomber 0.6 / 0.8 / 0.8 / 1.3; elite 4.0 / 1.3 / 1.2 / 5.0.
- The **attack interval** and the MSKILL rows' relative damage come from the field monster nearest the level (the
  wave-8 `relative` mode: the first row hits what the basic attack hits).
- **EXP ×2** of a field monster of the same level, because tomb monsters come in packs of 4–8 and the party splits
  the kill (×1.3 pool for 4, by level). The sim (§6) shows this lands at the frugal field rate per hour.
- **Reconciled with CLIMB's budget** (fact-check F9). CLIMB §3.5 gives the Tomb a budget it lets this spec tune:
  "trash pays **0.75 × the standard EXP**", for a run of ≈ **1.15× an average solo hour**. CLIMB's standard EXP
  (23.5 × level, 376 at 16) is the same scale as this spec's field fit (369 at 16) [confirmed: CLIMB §2.2, `curveAt`].
  The two multipliers differ by 2.7× because CLIMB models the tomb as a grind spot with continuous pulls, while this
  spec's sim walks the wing (walking, puzzles, rests, the boss), which roughly halves the kill density. **The target
  binds and the multiplier does not:** `trashExpMul` is one knob in `content/tomb/monsters.json`, and the merged re-run
  (§6.5) sets it so that a repeat run per member lands at 1.0–1.15× CLIMB's solo hour at that level. Today's value is
  2.0.
- **CLIMB's level-difference rule applies** (CLIMB D4: −15 % per level from 2 levels below, +5 % per level above, at
  most +15 %). An out-of-band character in Wing I earns less (a 19 gets 55–70 % per kill), and a carried character
  earns at most +15 %. CLIMB's mentoring (a level 20 has 0 weight in the party split) means a capped friend never
  takes a share. Neither is in the sim; both lower the out-of-band EXP the sim shows.

When the re-tune changes the field, the curve follows (the build computes it from `mobs.json` + the re-tune's
overrides at server start, through CLIMB's S-DERIVE standard curve; the content file stores roles, not numbers). The roster at today's curve
[projected: `tomb-sim.json`]: Tomb Soldier 15: 700 HP, attack 104–124, PD 44, 687 EXP; Royal Soldier 18: 1,090 HP,
143, PD 59, 848 EXP; Snake Lord 20: 1,465 HP, 165, PD 72, 975 EXP.

### 5.3 Pack rules [decision]

Packs are aggressive with sight 18 m, asleep until a player is in view (the dormancy rule), leash 50 m from their
post, and **link-pull** (one member aggroed pulls the pack). Packs do not respawn inside an instance. Aggro: melee
monsters go for whoever has the most threat (≈ the tank: the sim uses 65 %), ranged monsters pick at random.

### 5.4 Boss 1: Tomb General Hyun (17), Wing I [decision]

![bosses](../work/tmp/tomb/tomb_bosses.png)

Retail `MOB_TQ_TOMBGENERAL` (scale 200, halberd, 14 clips). **26,000 HP**, attack × 1.7 of the curve at 17, attack
interval 2.5 s. Corpse 8 s (his DIE1 plays out).

| Mechanic | Telegraph (wind-up) | Effect | Counter |
|---|---|---|---|
| Halberd Sweep, every 15 s | 120° cone, 8 m, in front (1.5 s: he raises the halberd) | 250 % of a swing | the tank stands at his flank; others never in front |
| Called Volley, every 21 s | 3 circles of 4 m on random players (2 s; archers on the walls shout "Loose!") | 160 % | step out |
| Terracotta Guard | — | 3 adds (2 soldiers + 1 archer) at 70 % and 40 % | peel them |
| Enrage | ≤ 20 % HP: notice "General Hyun roars a battle cry!" | damage ×1.25, volleys every 12 s | burn him |
| Fury | 9 min into the fight (fact-check: was 8) | damage ×3 | do not fight him out of band |

### 5.5 Boss 2: BeakYung the White Viper (19), Wing II [decision]

Retail `MOB_TQ_WHITESNAKE` (the one retail **unique** of the tomb; scale 160, 15 clips). **32,000 HP**, attack × 1.6.

| Mechanic | Telegraph | Effect | Counter |
|---|---|---|---|
| Quicksilver Spit, every 12 s | a 14 × 3 m line toward her target (1.2 s: her throat glows) | 180 % + `poison` 6 s; leaves a **quicksilver pool** for 20 s (2 % max HP per s inside) | sidestep; do not fight in pools; the Quicksilver Eel broth (−20 % abnormal) |
| Coil Burst, every 30 s | she dives into a pool (2 s untargetable), surfaces: a 6 m ring around that pool (2 s) | 320 % | run out of the ring she picked |
| Snake Slaves | — | 3 adds at 75, 50, 25 % (the last wave with a Snake Woman) | peel |
| Enrage / fury | ≤ 20 %: ×1.25 / 10 min: ×3 (was 9) | | |

### 5.6 Boss 3: SoHaow the White Tiger (20), Wing III [decision]

Retail `MOB_TQ_EASTGUARDIAN` "SoHaow The White Tiger" (scale 400, the tiger's 17 clips). **46,000 HP**, attack × 1.9.

| Mechanic | Telegraph | Effect | Counter |
|---|---|---|---|
| Pounce, every 14 s | a 5 m circle on **the farthest player** (1.5 s: he crouches; the banner names the target) | 220 %, then he fights there | the target moves; ranged players learn to stand mid-range |
| Tiger's Roar, every 24 s | a 10 m ring around him (2 s: he rears and inhales) | 280 % | everyone out, including the tank |
| Shadow Tigers | — | 2 adds at 80, 60 and 40 % | peel |
| **West Wind Ward** | at 66 % and 33 %: a pale wind around him; **one of three jewels lights up** | damage he takes ×0.25 | one player runs 45 m to the lit jewel and strikes it (3 s); the ward drops (≈ 14 s away from the fight) |
| Enrage / fury | ≤ 20 %: ×1.3 / 12 min: ×3 (was 10) | | |

Readability rule for all three [decision]: every special has (1) a wind-up clip from the retail set, (2) a red ground
telegraph that fills over the wind-up, (3) a banner line in the existing top-centre notice queue with the boss's name.
No mechanic kills without a telegraph; no telegraph is shorter than 1.2 s (the server tick is 100 ms; the client's
round trip is 30–80 ms for the friends).

### 5.7 The telegraph seam [decision]

- **Server:** a boss special is scripted in the tomb's boss module (not an MSKILL row): at the cast it broadcasts
  `telegraph {id, src, shape, x, z, r, r2?, deg?, yaw?, len?, w?, ms}` (shapes: `circle`, `cone`, `line`, `ring`); at
  release it collects the players whose **authoritative position at release time** (`world.positionAt`) lies inside
  the shape and rolls the hit through `gameplay.dealHits` with the special's percent (so armour, parry, statuses,
  durability and the death penalty all apply as to any hit).
- **Client:** a pooled ground decal (one draw per live telegraph: a projected quad with a fill-over-time shader,
  ≤ 8 live), placed on the floor's surface height. Low draws an unlit ring outline only.
- **Fairness:** the release test uses the server's position; a player who started moving out before the release and is
  still on the edge is hit. Shapes are drawn 0.3 m *larger* on the client than the server tests, so "I was out" is
  true on screen.

---

## 6. Balance (the simulation) [projected unless tagged]

### 6.1 The model

`work/tmp/tomb/sim-tomb.ts` is the author's fork of the balance model (`work/tmp/balance/sim.ts` lines 1–682 + its
sustained-grind `session`; the other wave-14 designers extend the shared file, so the tomb mode lives in the fork; the
formulas and character model are unchanged). `work/tmp/tomb/sim-tomb-fc.ts` is the fact-check's copy of it, with fury
knobs, band-floor cases and a per-attempt boss log; the model is the same. Both add a `--tomb` mode:

- **The party:** level-L blades and glaives in shop gear with the SP plan of BALANCE §4 (`kitAt`, `gearAt`,
  `playerStats`, `spAt`), skills and the imbue, a Large HP potion under 50 % HP, MP potions **in boss fights only**
  ("fed"); "frugal" drinks HP under 35 % and no MP. 70 % uptime (BALANCE §8.1's planning number); the fact-check adds
  60 % for a first run.
- **Packs:** all of a pack at once, melee aggro 65 % on the tank, ranged random, focus fire on the weakest; bombers
  explode after 5–7 s (dodged with the party's dodge chance).
- **Bosses:** the §5.4–§5.6 numbers: specials hit each player in them (a per-special "in the shape" chance) unless
  dodged (`dodge` 0.7 normal, 0.3 sloppy, 0.9 good), add waves at bands, the ward (the breaker leaves for 14 s, damage
  ×0.25 until then), enrage, fury. A boss that wins resets, and the party tries up to 3 times.
- **Between fights:** a player who dies stays down until the fight ends (the dark lamp, §3.6), then walks back 90 s
  and revives at 50 %. The party rests to 60 % (fed) or 80 % (frugal). Rule 13 is counted per death (uniform 1–20 %
  of the bar, mean 10.5 %).
- **Time:** walking at 5.5 m/s (§4.4), puzzles at fixed minutes, 8 s per pack for loot.
- **Field reference:** the same model's solo grind (`session`) at 15/17/19, best monster within −3…+2 levels.

Run: `pnpm tsx work/tmp/tomb/sim-tomb-fc.ts --tomb --n=100` (≈ 2 min), output `tomb-sim-fc-n100.txt`,
`tomb-sim-fc.json` [confirmed: a re-run gives identical output]. The attempt-level table is `... --fc --n=100`
(`tomb-sim-fc-attempts.txt`). Knobs: `--g-hp=`, `--v-hp=`, `--t-hp=`, `--g-fury= --v-fury= --t-fury=` (s),
`--wing=1|2|3`, `--debug --lvl=17` (one traced run). The author's `sim-tomb.ts --tomb --n=100` reproduces
`tomb-sim-n100.txt` byte for byte [confirmed: the fact-check re-ran it].

### 6.2 Results (100 runs per case, today's curve, rates x1, fury 9 / 10 / 12 min)

"Boss min" is the boss's total time over every attempt, including wiped ones. At level 20 rule 13 takes nothing
(CLIMB §6.1), so those rows show 0. The sim does not model CLIMB's grace, so the losses are an upper bound.

| Case | Clear | Run min p50 / p90 | Boss min | Deaths per player | EXP each (% of bar) | Rule-13 loss (% bar) | HP / MP pots each | Potion gold each |
|---|---|---|---|---|---|---|---|---|
| **Wing I 4 × 15** | 100 % | 24 / 27 | 5.9 | 0.30 | 11.4 | 3.2 | 42 / 35 | 15,400 |
| **Wing I 4 × 16** | 100 % | 19 / 21 | 3.3 | 0.06 | 8.6 | 0.6 | 15 / 19 | 13,800 |
| Wing I 4 × 17 | 100 % | 18 / 19 | 3.0 | 0.01 | 6.8 | 0.1 | 13 / 19 | 12,800 |
| Wing I 4 × 16 sloppy | 100 % | 19 / 21 | 3.3 | 0.06 | 8.6 | 0.6 | 18 / 19 | 14,800 |
| **Wing I 3 × 15 (band floor)** | 98 % | 28 / 39 | 8.6 | 0.51 | 14.0 | 5.4 | 72 / 51 | 24,700 |
| Wing I 3 × 15, uptime 60 % | 85 % | 31 / 43 | 12.2 | 1.04 | 14.4 | 11.0 | 98 / 60 | 31,700 |
| Wing I 3 × 16 | 100 % | 22 / 24 | 4.4 | 0.10 | 10.6 | 1.1 | 24 / 26 | 20,100 |
| Wing I 2 × 15 | **23 %** | 46 / 56 | 19.0 | 2.63 | — | 27.6 | — | — |
| Wing I 2 × 16 | 100 % | 27 / 37 | 7.8 | 0.23 | 14.3 | 2.4 | 54 / 43 | 38,700 |
| Wing I 1 × 20 (solo, not allowed) | 100 % | 29 / 29 | 6.7 | 0 | 9.8 | 0 | 64 / 44 | 43,500 |
| **Wing II 4 × 17** | 100 % | 40 / 43 | 6.3 | 0.14 | 7.6 | 1.4 | 38 / 37 | 29,800 |
| **Wing II 4 × 18** | 100 % | 39 / 40 | 5.3 | 0.04 | 6.2 | 0.4 | 31 / 31 | 24,900 |
| Wing II 4 × 18 sloppy | 100 % | 40 / 42 | 5.9 | 0.20 | 6.2 | 2.0 | 50 / 32 | 32,600 |
| **Wing II 3 × 17 (band floor)** | 100 % | 45 / 56 | 9.5 | 0.30 | 9.6 | 3.1 | 68 / 55 | 49,100 |
| Wing II 3 × 17, uptime 60 % | 99 % | 48 / 60 | 12.3 | 0.44 | 10.0 | 4.6 | 88 / 58 | 58,200 |
| Wing II 3 × 18 | 100 % | 43 / 46 | 7.0 | 0.08 | 7.7 | 0.8 | 50 / 42 | 36,500 |
| Wing II 2 × 18 | 92 % | 53 / 65 | 13.6 | 0.72 | 11.1 | 7.6 | 126 / 79 | 82,200 |
| Wing II 2 × 19 | 100 % | 46 / 47 | 8.8 | 0.05 | 8.8 | 0.5 | 78 / 54 | 52,700 |
| Wing II 1 × 20 (solo, not allowed) | 45 % | 69 / 81 | 22.1 | 2.13 | — | 0 | — | — |
| Wing III 4 × 18 (below band) | 100 % | 23 / 35 | 11.2 | 0.47 | 3.7 | 4.9 | 35 / 57 | 36,800 |
| **Wing III 4 × 19** | 100 % | 17 / 19 | 7.2 | 0.14 | 3.0 | 1.5 | 20 / 42 | 24,800 |
| Wing III 4 × 19 sloppy | 100 % | 19 / 21 | 8.1 | 0.33 | 3.0 | 3.5 | 28 / 43 | 28,600 |
| Wing III 4 × 19 good | 100 % | 15 / 17 | 6.0 | 0.03 | 3.0 | 0.3 | 14 / 42 | 22,400 |
| **Wing III 3 × 19 (band floor)** | 100 % | 21 / 24 | 10.0 | 0.21 | 3.7 | 2.2 | 36 / 57 | 37,300 |
| **Wing III 3 × 20** | 100 % | 19 / 22 | 8.4 | 0.08 | 3.1 | 0 | 27 / 50 | 30,700 |
| Wing III 2 × 19 | **6 %** | — | 25.7 | 2.90 | — | 30.4 | — | — |
| Wing III 2 × 20 | 99 % | 27 / 42 | 15.7 | 0.47 | 4.6 | 0 | 75 / 92 | 66,900 |
| Any wing, "frugal" (no MP pots) | **0 %** (the boss wins 3 times) | | | 3.00 | | 31.5 (≈ 21 with the grace) | | |
| Full clear 4 × 19 | 100 % | 70 / 73 | 2.2 / 4.2 / 7.3 | 0.15 | 12.8 | 1.6 | 51 / 82 | 53,400 |
| Full clear 4 × 20 | 100 % | 68 / 69 | 2.0 / 3.9 / 6.4 | 0.06 | 10.8 | 0 | 43 / 75 | 47,200 |
| Full clear 20/19/18/17 | 100 % | 75 / 77 | 2.4 / 4.6 / 8.3 | 0.28 | 12.8 | 3.0 | 55 / 89 | 57,700 |

[projected: `tomb-sim-fc-n100.txt`] Field reference (solo blade, shop gear, the same model) [projected]: frugal
**30 % / 17 % / 11 %** of the bar per hour at 15 / 17 / 19; potion-fed **142 % / 84 % / 49 %**.

**The fury, by attempt** (`tomb-sim-fc-attempts.txt` and `tomb-sim-fc-attempts-fury8-9-10.txt`, 100 runs each)
[projected]:

| Case | Fury 8 / 9 / 10 (author): winning attempt p50 / p90, wins after the fury, clear | Fury 9 / 10 / 12 (fact-check) |
|---|---|---|
| Wing I 3 × 15 | 6.2 / 7.5 min, 3 %, 98 % | 6.2 / 8.3 min, 1 %, 98 % |
| Wing II 3 × 17 | 7.7 / 8.8 min, 5 %, 98 % | 7.7 / 9.4 min, 5 %, 100 % |
| Wing III 3 × 19 | 8.8 / **9.3** min, 2 %, 99 % | 8.9 / 11.4 min, 3 %, 100 % |
| Wing II 3 × 17, uptime 60 % | 9.0 / 9.4 min, **56 %**, 90 % | 9.0 / 9.6 min, 3 %, 96 % |
| Wing III 3 × 19, uptime 60 % | 10.1 / 10.3 min, **72 %**, 82 % | 10.2 / 11.4 min, 2 %, 99 % |
| Wing II 2 × 18 | 10.5 / 11.4 min, 100 %, 27 % | 10.3 / 10.6 min, 93 %, 92 % |
| Wing III 2 × 20 | 11.9 / 13.2 min, 100 %, 5 % | 12.1 / 12.5 min, 72 %, 99 % |
| Wing III 2 × 19 | — | 13.6 / 13.7 min, 100 %, 4 % |

### 6.3 What it says

1. **The bands are right, and the band floor is the hard step.** In band, 4 players clear every wing with 0.01–0.14
   deaths each. The three friends clear every wing in band, but they die more at the band floor: 0.51 deaths each at
   Wing I 3 × 15 (98 %), 0.30 at Wing II 3 × 17 and 0.21 at Wing III 3 × 19. One level under Wing III's band (4 × 18)
   costs 0.47 deaths and 11 minutes on the boss.
2. **The author's fury was too tight for the binding case** (fact-check F3). At 8 / 9 / 10 min the three friends at
   each band floor won with only 20–60 s to spare at p90. At a first-run uptime of 60 %, 56 % (Wing II) and 72 %
   (Wing III) of their wins came after the fury, and Wing III cleared only 82 %. The model is optimistic about
   movement (§6.4), so the real margin is smaller still. At **9 / 10 / 12 min** the same cases win before the fury
   (≤ 5 % after it) and clear 96–100 %. The cost: a duo at the top of a band can now clear Wing II (2 × 18: 92 %) and
   Wing III (2 × 20: 99 %, mostly inside the fury, 0.47 deaths each). That is still a group, so it fits the user's
   "the Tomb needs a group". A duo below the top (2 × 19 at Wing III, 2 × 15 at Wing I) still fails.
3. **Repeat runs ≈ the frugal field rate**, not more: Wing I at 16: 8.6 % in 19 min = 27 %/h (frugal at 16 ≈ 23 %,
   1.2×); Wing II at 18: 9.5 %/h (frugal ≈ 14 %, 0.7×); Wing III at 19: 10.6 %/h (frugal ≈ 11 %, 1.0×). The tomb is fun
   and social, not an EXP farm. **Carrying is not a farm either** (`--fc`): a level 15 carried by three 20s through
   Wing III earns 18 % of its bar per hour (frugal 30 %) and dies 0.85 times a run. Carried by one 20 through Wing I,
   it earns 37 %/h, a little above the frugal field and far below a potion-fed hour (142 %). Mentoring and the level
   rule (§5.2) do not change that.
4. **The daily chest makes the first run worth it:** the Emperor's Favour (§3.4's table: 7.7 % at 16, 5.4 % at 18,
   3.5 % at 19) makes a first run worth ≈ 2.2× the frugal field rate for its hour at Wing I (16.3 % in 19 min),
   ≈ 1.2× at Wing II and ≈ 2.0× at Wing III. A friend who plays 2 h a day climbs **≈ 7–19 % faster**: ≈ 16–19 % at 15–16
   (Wing I), ≈ 7–9 % at 17–18 (the long Wing II) and ≈ 15 % at 19 (Wing III) [projected: 2 h = the day's first run
   plus field hunting for the rest]. With the author's overlapping bands it was ≈ 30 % at 17 and ≈ 25 % at 19, so
   the bands no longer overlap (§3.4). Reason for 20 minutes (not an hour): "Level 20 should be
   difficult to reach".
5. **Bosses demand MP potions** (frugal parties lose every boss), as the Tiger Girl does (BALANCE §8.1): the SRO boss
   feel. The potion bill per player per run at x1 is 13,000–25,000 gold for 4 in band, **37,000–58,000 for a trio at a
   band floor**, and 39,000–82,000 for a duo. The chest gold (§7.2) covers the 4-in-band case only, so a trio at the
   floor loses ≈ 25,000–35,000 gold on the run [projected]. Decision: kept, because gold is plentiful for frugal
   players (BALANCE: about 300,000 spare at 20) and the bill shrinks a level later.
6. **Rule 13 is real here:** a sloppy party gives back 0.6–3.5 % of a bar per wing to deaths, and a trio at the band
   floor gives back 3–5 %, as much as half of what the run earned. A frugal party that tries a boss three times
   without MP potions loses ≈ 21 % of a bar each (31.5 % without the grace); the Steward's warning (§3.6) is the
   answer. Good play (dodging) matters more than levels: the telegraphs carry the difficulty.
7. **The fury holds** at 9 / 10 / 12: in-band parties of 3–4 meet it in ≤ 5 % of wins. Duos at a band top meet it
   and mostly survive. Parties far under band (Wing III at 4 × 17: 34 %), duos below the band top, and solos lose.

### 6.4 Limits of the model

The model is optimistic about movement (everyone in range, instant retarget) and pessimistic about puzzles (fixed
minutes); it has no horses; the trap gallery is one beetle pack plus time (no trap damage); the pools and poison are
approximated (a damage-over-time on a hit). Wing III's walk is 0.6 km in the sim against ≈ 0.8 km in §4.4 (+40 s).
It models today's curve and today's field monsters, without CLIMB's level-difference rule, mentoring or the
10-minute grace; all three lower the numbers for out-of-band players and for deaths. The friends' first run per
wing is the real measurement, and the HP and fury knobs (`content/tomb/bosses.json`) scale time-to-kill linearly.

### 6.5 Re-running on the wave-14 curve

The tomb monsters derive from `mobs.json` (+ the re-tune's overrides) and the rewards are fractions of the bar, so
WAVE_PLAN10 re-runs `sim-tomb-fc.ts --tomb --n=100` and `--fc` after the re-tune lands. It checks the lines of §6.3:
the bands, parity with CLIMB's solo hour (which sets `trashExpMul`, §5.2), the chest's daily effect, and the fury
margin (the band-floor trio at 60 % uptime wins after the fury in ≤ 10 % of its wins). The Favour table follows
CLIMB's model hours, so it moves with the curve.

---

## 7. Loot

### 7.1 Gear tiers the tomb pays out [decision; CLIMB §4.1's tier names]

Items that exist today [confirmed by the fact-check over `items.json`]. **The grade letter does not fix the required
level; the slot does.** Degree-3 weapons, shields and rings need 16 (grade A), 18 (B) and 21 (C). Armour adds a
per-slot step: grade A is hands 16, shoulders 17, feet 18, head 19, legs 20 and **chest 21**; grade B is 18–23 and
grade C 21–26 (so `Oh Scale Casque` 19 and `Oh Scale Hose` 20 are **grade A** rows, `_HA_A` and `_LA_A`). Earrings
need 18 / 20 / 23 and necklaces 20 / 22 / 25. In the wave-11 **Seal of Star** `_RARE` rows, every weapon, shield and
ring needs 16, whatever its grade (`_B_RARE` and `_C_RARE` included), and armour keeps its grade-A level. The author's
"grade A = 16–17, grade B = 18–20" was wrong for armour. The tomb therefore picks rows **by required level** and uses
CLIMB's tier names:

| Tier (CLIMB §4.1) | Rows the chest may roll | Where |
|---|---|---|
| **T5** Tribal Iron / Scale | degree 3 rows with req 16–17 (grade A weapons, shields, rings, hands, shoulders), +0..+2 | General's chest |
| **T6** Kang Iron | degree 3 rows with req 18–20 (grade B weapons, shields and rings; grade A feet, head and legs; grade B hands, shoulders and feet; earrings, necklace A), +0..+3 | Viper's and SoHaow's chests |
| **T7** Seal of Star | the `_RARE` row of the rolled row (`X_A` → `X_A_RARE`, `X_B` → `X_B_RARE`, never `_C_RARE`), only when its req ≤ 20 | 10 % (General), 15 % (Viper), 25 % (SoHaow), replacing the plain roll |

No chest rolls a chest-armour (`BA`) piece, because every degree-3 one needs 21+. CLIMB's set bonus for Seal of Star
(3 / 5 pieces) makes the T7 roll worth chasing at the cap.

Gear is rolled **for the opener's class and sex** (the uniques' gear-pool resolver, `gearPool`, filtered to the
opener's weapon family and armour type, reusing UNIQUES §3.4's code path).

### 7.2 The boss chests (personal, once per character per 20 h) [decision]

| Chest | Gear | Gold (× GOLD_RATE) | EXP | Extras |
|---|---|---|---|---|
| General Hyun | 1 × T5 | 10,000–14,000 | Emperor's Favour (in band 15–16) | 1 Tomb Seal Shard; 25 %: a **Terracotta Regalia token**; 2 elixirs (degree 3) |
| White Viper | 1 × T6 | 18,000–24,000 | Emperor's Favour (17–18) | 1 shard; 35 % token; 20 % a **Quicksilver Vial** (crafting curio) |
| SoHaow | 1 × T6 (+1 minimum) | 22,000–30,000 | Emperor's Favour (19–20; SP-EXP at 20) | 1 shard; 50 % token; **1 Ancestor's Incense** (CLIMB §6.2: "the Tomb, 1 per full run"); 2 % the **Broken Hilt of the Emperor**; the achievement event for the **"Tamer of the West Wind"** title (CLIMB §7.3's title system) |

- **Gold pays the run's potions:** in band the bill is 13,800 (Wing I at 16), 24,900 (Wing II at 18) and 24,800
  (Wing III at 19) per player for a party of 4 (§6.2); the chest pays about that, so the **first run of the day breaks
  even** for 4, and repeats cost money. A trio at a band floor pays 25,000–58,000, so it loses money until a level
  later (§6.3 item 5). Trash gold (≈ 4,000–5,000 per wing for the whole party at x1 [projected from BALANCE §5.1's
  gold per kill]) is pocket money.
- **The boss's own drops** (gold piles, a trash-table item, shards) follow the party's loot rules as any monster.
- **A personal chest, not a group roll** [decision]: three friends never argue over one drop, and every member's
  lockout is its own.

### 7.3 The Treasure Vault (Wing II, the Tomb Seal) [decision]

The Guardian of Treasure (elite, 18) and a coffer for the party (party loot rules): 10,000–20,000 gold, 3 elixirs, 50 %
a Regalia token, 10 % a Star item. One Seal (5 shards) per vault, consumed at the door. Not locked out (the shards are
the limit: ≈ 1–2 per run).

### 7.4 Named slots for waves 15 and 17 [decision]

- **CLIMB's slot W15-A (wave 15, Wardrobe), shown in play as the Terracotta Regalia** [decision, fact-check F13].
  CLIMB §4.3 owns the slot table and already names the tomb's set: "W15-A Tomb Warden's set: heavy, light and clothes
  sets (6 pieces), T6–T7 / 18–20, the Qin-Shi Tomb only, = Seal of Star B per piece, with the SoS set bonus". The
  author's five-piece set at T18 stats did not match it. This spec follows CLIMB: **six pieces** (head, shoulders,
  chest, hands, legs, feet), one set per armour class, Seal-of-Star-B stats, required level ≤ 20, art by wave 15.
  "Terracotta Regalia" is this spec's proposed display name; wave 15 decides. This wave drops **Terracotta Regalia
  tokens** (a stackable curio, sell 0, cannot be traded, kept). CLIMB's `content/climb/slots.json` row (with
  `enabled: false`) is the item slot, and wave 15 adds a Steward exchange (tokens → a piece). Reason: no item exists
  without art; tokens bank the reward now.
- **The Broken Hilt of the Emperor (wave 17, Arsenal):** a curio from SoHaow (2 %), "It hums when you hold it."
  **CLIMB's W17-B, Tiger Girl's Fang, is the talking legendary weapon** (begun by a Tiger Fang Shard from the Tiger
  Girl). Two legendary weapons would compete, so the Hilt is offered to wave 17 as **the Fang's hilt**, a second
  component of the same quest: the tiger spirit's sanctum holds the hilt, the Tiger Girl the fang [decision,
  fact-check F13; wave 17 may decline and keep it a curio].
- **The Quicksilver Vial** (wave 13's cooking or a later alchemy use) and the **Dragon Pearl** (FISHING's crafting
  hook) stay curios until a crafting wave.

---

## 8. The story: "The Tiger's Shadow" goes underground [decision]

**The canon (QUESTS §3.1):** the temple's Jade Tiger Seal kept the spirit of Tiger Mountain asleep; grave robbers dug
tiger-bone talismans out of the old tombs; the masked buyer is the Tiger Girl, "a woman who once made a bargain with
the tiger spirit and never got her body back"; Act II says the Qin-Shi tomb guardians are awake.

**The tomb's answer:** the emperor buried four guardian spirits with him, one for each direction. The tiger spirit of
the mountain is **SoHaow, the White Tiger of the West**, the emperor's guardian, and the Jade Tiger Seal was cut from
the stone of its prison. The robbers' talismans are keys to that prison; the Daughter of the Mountain's bargain was made
at its door. Kill its shade in the sanctum and her hold weakens; the other three guardians still sleep.

Three quests (`content/quests/tomb.json`, a second quest file: the engine loads every `content/quests/*.json`
[confirmed: `quests/book.ts` `readdirSync`, alphabetical, a later id replaces an earlier one]). The first one uses CLIMB's
reserved id JG_X15 (§3.2), so the two specs cannot both define it:

| Id | Title | Lv | Giver → turn-in | Objectives | Reward |
|---|---|---|---|---|---|
| JG_X15 (CLIMB's slot) | The Emperor's Door | 15 (after JG_020) | WalYoung → Tomb Steward Baek | reach the tomb door; enter the tomb with a party; kill Tomb General Hyun | Emperor's Favour ×1, 30 SP, 5,000 gold, a Return Scroll; **unlocks the tomb** |
| JG_T02 | Rivers of Quicksilver | 17 | Baek → Priest Kushyan | light the three seals; kill BeakYung | 4 % of the bar, 40 SP, 8,000 gold, 2 Quicksilver Eel broths (wave 13's dish; 10 Large HP potions if cooking is not live) |
| JG_T03 | The Shadow in the Sanctum | 19 | Kushyan → Exorcist Miaoryeong | kill SoHaow the White Tiger | 4 % of the bar, 60 SP, 12,000 gold, **the White Tiger's Ward**, a curio: the Tiger Girl (`MOB_CH_TIGERWOMAN`, the JG_025 encounter **and the world boss**) deals −10 % damage to its holder |

- **The Steward's shade** speaks at each lamp (one line per wing: the edict, the river, the guardians).
- **Steles**: 6 lore steles (the edict, the builders, the mercury rivers, the four guardians, the bargain, a robber's
  scratched warning). Each is an interactable with a dialog page.
- **Into the finale:** JG_T03 is optional. Doing it first makes the Tiger Girl weaker against the holder (the Ward
  charm), which is the story's payoff ("her hold weakens"). The existing questline needs no edit. **Fact-check F14:**
  the author applied the charm only to the JG_025 encounter, but that fight is a 5 % HP, ×0.8 attack quest finale
  [confirmed: `jangan.json` JG_025 `encounter` `hpMul` 0.05, `attackMul` 0.8; CLIMB §2.6 keeps it], so −10 % meant
  nothing. The charm also works against the world boss (CLIMB's capstone, `hpMul` 0.16 and fury ×3), where a
  holder's party feels it. It is one damage multiplier on hits from that one mob code to a holder (the uniques
  module's hit path).
- **Hint locations:** `LOC_TOMB_DOOR` (864, −1040); the tomb's inner objectives are instance-only (`reach` in tomb
  space is checked by the module's own fact, `tombWing(p)`).

---

## 9. Server cost on the N100 [confirmed on the dev PC unless tagged]

### 9.1 The measurement

`work/tmp/tomb/instance-cost.ts`: a **private in-process copy** of the real server (`startServer` on port 0 with a
fresh temp `DATA_DIR`, `WORLD_EXPORT=jangan-fields`; no dev server touched; stopped and deleted after). Its timer is
stopped and the world is ticked by hand at 10 Hz of simulated time, so each tick's CPU is measured (`timedTick`). An
instance is emulated as the slot design builds it: an area ≥ 400 m from any other, **4 bot players (real database
characters) auto-attacking a 5-monster pack** (killed monsters replaced at once: steady combat; Bandit 16 as the
stand-in: aggressive, MSKILL rows), **≈ 140 more monsters asleep** 150–270 m away (the rest of the wing), bots healed
every 2 s, every outgoing message JSON-stringified. 600 ticks per row after a JIT warm-up; heap after two `gc()`.

| Server state | Players | Monsters | Tick mean | p50 | p99 | max | Messages/s | KB/s | Heap |
|---|---|---|---|---|---|---|---|---|---|
| **Field (live spawns), no players** | 0 | 6,083 | 0.24 ms | 0.23 | 0.65 | 0.89 | 0 | 0 | 39.4 MB |
| + 1 slot | 4 | 6,197 | 0.90 | 0.80 | 2.42 | 5.29 | 78 | 9.8 | 40.5 |
| + 2 slots | 8 | 6,342 | 1.11 | 1.00 | 2.36 | 4.46 | 202 | 26.2 | 41.0 |
| + 4 slots | 16 | 6,522 | 1.43 | 1.26 | 2.72 | 3.22 | 353 | 47.3 | 41.3 |
| + 6 slots | 24 | 6,795 | 1.57 | 1.38 | 2.87 | 3.49 | 489 | 63.6 | 41.8 |
| **+ 8 slots** | 32 | 6,951 | **1.74** | 1.59 | **2.87** | 3.13 | 608 | 77.4 | 42.0 |
| Slots only (no field), 6 slots | 24 | 712 | 0.34 | 0.30 | 1.03 | 1.61 | 348 | 42.6 | 35.4 |
| Slots only, 8 slots | 32 | 868 | 1.40 | 0.56 | 25.5 | **65.0** | 447 | 53.0 | 35.5 |

[confirmed: `instance-cost-field.json`, `instance-cost.json`; dev PC AMD Ryzen 5 9600X (FIELDS.md)]

### 9.2 Reading it

- **CPU:** the first active slot costs ≈ 0.66 ms (the woken field around it and the JIT), each further slot
  ≈ 0.13–0.2 ms mean. **Eight fighting parties plus the whole field: 1.74 ms mean, 2.87 ms p99**, 2.9 % of the 100 ms
  tick. On the N100 (×2.5, FIELDS.md's factor) **≈ 4.3 ms mean, ≈ 7.2 ms p99** [projected]. Inside the tomb the
  sleeping monsters are fewer than on the field, so the real cost is at most this.
- **Spikes:** the slots-only run had single ticks of 15–65 ms (at 1, 2, 4 and 8 slots); the field run, with the same
  code and more work, stayed under 5.3 ms [confirmed]. The likely cause is the garbage collector or a synchronous
  SQLite write (durability wear, inventory) landing in one tick [likely]; ×2.5 on the N100 a 65 ms spike is ≈ 160 ms:
  one late tick. G-14 watches `worstTickMs` in the performance log (FIELDS §4.4's 50 ms line) with 4 parties in the
  tomb; it is not a tomb-specific cost.
- **Memory:** **+0.3–0.5 MB of heap per slot** (≈ 145 monsters + 4 players) [confirmed]; the tomb navmesh once, ≈ 1–2 MB
  in memory from 0.5 MB raw [projected]; the content tables < 1 MB. Six slots: **< 5 MB**, against the server's
  ≈ 750 MB on the fields (PLAYTEST). Memory is not a reason to cap slots.
- **Network:** ≈ 10 KB/s per fighting party, ≈ 2.4 KB/s per player [confirmed], the same as a field fight.
- **Slots: 6** [decision]: 24 players in the tomb at once, more than the friends' server holds, with headroom; a
  content constant, not a resource limit.
- **What the measurement does not cover** [unknown, fact-check]: the bots fought Bandit 16 packs with no telegraphs,
  shape tests or puzzles, and no instance was *created* during the timed ticks. Creating a wing (≈ 40–55
  `createMob` calls and an interest refresh, §2.2) lands in one tick when a party enters. The bench with the real
  module (§16.3) times the entry tick and the boss specials; the line is FIELDS §4.4's `worstTickMs` 50 ms on the
  N100. The fact-check re-read both JSON files: the table matches them [confirmed].

---

## 10. The client: streaming an interior, lighting, the 60 fps budget

### 10.1 A second world export, loaded on demand [decision]

- **`qin-tomb`**, its own world export (manifest, models, lightmaps, navmesh), converted from floors 1, 5 and 6 by a new
  converter pass (TB-CV): the DOF reader (`packages/formats/src/dof.ts`, from `dof_parse.py`), the blocks as placed
  objects (the existing object → glb path, lightmaps included), the props from the DOF object lists, the navmesh from
  the BMS navmeshes, `manifest.interior = true`, and `manifest.slots {x0, stride, count, floors: {1: [x, z], 5: …}}`.
- **Download** ≈ 10–13 MB [projected]: unique meshes 20.3 MB raw BMS for the three floors (≈ 5–7 MB as compressed glb,
  BMS carries 44–52 bytes per vertex), textures ≈ 7.5 MB DDJ for all six floors (≈ 3–4 MB after texpipe), lightmaps
  3.6 MB (≈ 1.5–2 MB) [confirmed sizes: `navbytes.ts`, `du`]. Loaded **on the first entry** only, cached afterwards;
  the field export is untouched.
- **The switch:** the server warps the party into tomb space; the client sees the destination is inside
  `ServerInfo.dungeons[]` (`{world: 'qin-tomb', x0, stride, count}`, additive), shows the loading screen, asks the
  stage host for the `qin-tomb` stage **at its own origin**, sets the network boundary's **stage origin** to the slot
  origin (x0 + k × stride; §2.2, fact-check F2), and releases the field stage. Exit: the reverse, with origin 0.
  Expected 2–5 s on the dev PC (one stage build: no terrain, no grass, no ocean) [projected]; the first time includes
  the download.
- **The way back costs a full field build** [unknown, fact-check]: releasing the field stage means every exit (the
  exit gate, a Return Scroll, the 120-min cap) rebuilds the field and town stage, which is the world-entry load. No
  spec records that time on the friends' PCs. LAB-14 times it 3 times. If it is over 10 s, the field stage stays
  resident and disabled while inside, at the cost of its VRAM. LAB-14 also checks that VRAM after 3 round trips, which
  is already in §18.
- **The minimap and the world map** have nothing to show in tomb space: the interior profile hides the minimap, and
  the map button shows the wing's floor plan, drawn from the layout map's data (§4) [decision]. **Sound zones**
  (`sound-zones.ts`) find no zone there; the tomb's ambience bed replaces them (§10.2).

### 10.2 The interior profile [decision]

- **Off:** sky dome, sun and its shadows, clouds, ocean, terrain, grass, weather, the day clock and the night-light
  splat (a constant "inside" time).
- **On:** the retail **lightmaps** (the baked look of the original tomb) × a dark ambient; **dark exponential fog at
  ≈ 110 m** (the rooms are 200–500 m across; fog hides what the 120 m view range already does not send); the flame
  bowls, lanterns and quicksilver lamps as **emissive props**, with the **8 nearest** as point lights in the existing
  light pick (the springs' and town's pattern); one soft "carried lantern" fill on the camera target so faces read.
- **Water:** the quicksilver river and floor-6 pool use a mirror-bright metallic variant of the water material, no
  waves, no swimming (a `swim.bin` is not built for the tomb this wave).
- **Sound:** a tomb ambience bed (wind in the halls, distant bells, dripping), from the existing sound set (TB-G picks
  from `work/out/sound`; no new recording).

### 10.3 The 60 fps budget [projected]

| Scene (Medium) | Triangles drawn | Draws | Lights | Projection (WebGPU / WebGL2) |
|---|---|---|---|---|
| Field plaza (reference, WAVE_PLAN8) | ≈ 183 k | the field's | sun + 8 | the G1 line: < 16.7 ms p95 |
| Wing I hall, a formation fight | ≤ 95 k (one block, fogged) | 60–140 before merging | 8 | ≈ 4–6 / 3–5 ms |
| Wing II hub + an arm | 40–80 k (2–4 blocks in view) | 60–130 before merging | 8 | ≈ 4–6 / 3–5 ms |
| Wing III, SoHaow + 4 players + adds + telegraphs | 30–60 k + a scale-400 tiger | 60–120 | 8 | ≈ 5–7 / 4–6 ms |

- The interiors are **cheaper than the field**: no terrain, no grass, no ocean, no shadow map, no sky, fewer
  triangles and draws; characters and effects cost what they cost on the field. Even an N100-class iGPU at Classic
  should hold 30+ [projected].
- **Risks:** the floor-1 hall is **one** 95 k-triangle block of 101 meshes [confirmed: 101 `.bms` in `floor_01`]. Fog
  does not cull, and the hall's long wall meshes stay in the frustum, so most of the 101 draw. The author's 40–70
  draws counted too few. Two cheap fixes: the interior camera's far plane at the fog's end (≈ 130 m), and TB-CV
  merging each block's static meshes by material (the BATCHING pattern), which gives ≤ 30 static draws per block.
  Other risks: alpha meshes on floor 6 (`_alpha01..05`); lightmap texture memory (≈ 20–30 MB VRAM). LAB-14 benches
  the three scenes under the GPU lock (3 runs, median) before G-14.

---

## 11. Formats

### 11.1 Content files (new, ours) [decision]

- `content/tomb/tomb.json`: the slots (`x0`, `stride`, `count` 6), wings (floor, band, lamps, gates, the Steward's
  lines), packs (positions in floor metres, roles, monster bases), puzzles (bells, mirrors with their solvable layouts,
  statues, plates, traps, the lever), the timers, the chest lockout (20 h), the Favour (`favourPct` per level, §3.4;
  the wing bands without overlap).
- `content/tomb/monsters.json`: tomb monster rows: `{code: 'TOMB_SOLDIER_15', base: 'MOB_TQ_TOMBSOLDIER_CLON2', level,
  role}`, plus `trashExpMul` (2.0 today, set by the merged re-run, §5.2); numbers computed at start from the field
  curve through CLIMB's S-DERIVE (§5.2). The `MOB_TQ_*` bases (levels 81–100) are only bases: no nest names them, and
  a GM `/spawn MOB_TQ_*` would spawn the retail numbers, so the GM spawn command refuses `MOB_TQ_*` codes and
  `/tomb spawn <code>` spawns the derived row [decision].
- `content/tomb/bosses.json`: the three bosses (`base`, `hp`, `attackMul`, specials with shapes, wind-ups and percents,
  bands, ward, enrage, fury).
- `content/tomb/loot.json`: chests (tiers via the uniques' pool rules, gold, extras, chances), the vault, trash shard
  chance; the Regalia tokens. The W15-A set slot itself is CLIMB's `content/climb/slots.json` row (§7.4).
- `content/quests/tomb.json`: JG_X15 (CLIMB's id), JG_T02, JG_T03 and the steles' dialogs.
- **Converter inputs:** an extra-mobs list (the `MOB_TQ_*` bases and their MSKILL rows into `mobs.json` /
  `skills.json`; today the export is nest-driven) and the floors to export.

### 11.2 Database (one migration; the number WAVE_PLAN10 assigns after wave 13's 11–13)

```sql
CREATE TABLE tomb_progress (
  character_id INTEGER PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  wings INTEGER NOT NULL DEFAULT 1,          -- bit 0 Wing I (always), bit 1 Wing II, bit 2 Wing III
  chest_general INTEGER NOT NULL DEFAULT 0,  -- ms epoch the lockout ends (0 = ready)
  chest_viper INTEGER NOT NULL DEFAULT 0,
  chest_tiger INTEGER NOT NULL DEFAULT 0
);
```

The author's `titles` column is dropped (fact-check F15). Titles go through CLIMB §7.3's achievements module
(`char_achievements`, `characters.title`): the tomb emits `tombBossSlain {boss, players}` on the module bus, and
`content/climb/achievements.json` holds "Tomb-Sealer" (CLIMB's row) and "Tamer of the West Wind" (SoHaow's first
kill).

Instances are runtime only. A character saved in tomb space (a restart or a crash) is placed at the Steward on login
(one check in the module's `enter` hook). With per-area clamping (§2.2), the saved point is first restored inside its
slot's area and is then warped to the Steward. Without it, the login placement would clamp the point to the field's
east edge before the hook ran.

### 11.3 Wire (protocol v1, additive) [decision]

- Server → client: `telegraph {id, src, shape, x, z, r, r2?, deg?, yaw?, len?, w?, ms}` (§5.7); `tombState {wing, slot,
  endsAt, lamps, seals, chests?}` on entry and on change; boss lines through the existing notice banner (a `tomb` kind).
- Client → server: `tombEnter {wing}` (the Steward's dialog, leader only), `tombJoin`, `tombLeave`; puzzle props are
  NPC entities and use the existing `npcTalk` (a 2–3 s channel the module runs).
- `ServerInfo.dungeons?: {world, x0, stride, count}[]`; the existing `warp` moves the player (no new field: the client
  derives the stage from the position).

### 11.4 What the tomb asks of the other wave-14 specs

- **CLIMB (the re-tune):** nothing above level 20 spawns within 80 m of the door (Hyeongcheon 30, nest 2065, stays
  skipped; CLIMB's derived monsters are all ≤ 20). **MB4 "the Gate Warden"'s camp and every aggressive roam circle of
  band B4 stay ≥ 40 m from the Steward's spot (864, −1040)**, so a party gathering there is not pulled. The field
  curve the tomb derives from is CLIMB's S-DERIVE. CLIMB's quest lane leaves JG_X15 to `tomb.json`. CLIMB's
  achievements carry the tomb's titles. The trash-EXP budget is CLIMB §3.5's target (§5.2). The Favour is part of the
  40 h, ≈ 4–5 h for a 2 h/day friend (§3.4).
- **The death penalty (CLIMB §6):** tomb deaths count; the revive point is the module's `respawnPoint(p)` hook (one new
  `GameplayModule` hook, §16.1), which lands in `gameplay.ts` next to CLIMB/NEMESIS's S-DEATH, so the wave's step-0
  seam agent does both. The tomb may listen to `penaltyTaken` (CLIMB §6.5), but it does not need to.
- **Nemesis:** excludes `Mob.tag = 'instance'` monsters (NEMESIS S-ELIG, N1; §3.6).
- **The storm Qilin:** no weather inside. The Qilin's six seats are fixed field peaks (STORM_QILIN §3.2), none in tomb
  space. The nearest to the door is Hill of Ye (1018, 346), ≈ 1.4 km away; Qin-Shi Watch above the door was
  rejected. The Qilin therefore needs no tomb check. The author's
  "its spawner checks `x < TOMB_X0`" is dropped.
- **The gear tiers:** CLIMB's T5 / T6 / T7 names are used (§7.1), and the set slot is CLIMB's W15-A (§7.4).
- **Springs and fishing (wave 13):** tomb kills are ordinary kills for the Rested pool and meals; the chest's Favour is
  not a kill (no Rested or meal bonus) [decision: one fixed reward, easy to read].

---

## 12. Hooks left for later [decision]

- **Floors 2, 3 and 4:** the teleport maze and two labyrinths (a hard mode, or a levels 21+ tomb if the cap ever moves).
- **The sealed south arm** of Wing II and **the three sealed guardian rooms** of Wing III: JeonUk the Black Tortoise,
  TaeHo the Blue Dragon, YumJae the Blue Hawk (retail rows exist with models and clips).
- **SoSo the Black Viper** (with her retail Scroll and Titan forms) and **ShinMoo the Man of Flames**, and the four
  Snake Generals: a hard mode.
- **Wave 15:** the Terracotta Regalia set (tokens already banked). **Wave 16** (faces and hair): nothing. **Wave 17:**
  the Broken Hilt of the Emperor.

---

## 13. Decisions (each with its reason)

| # | Decision | Reason |
|---|---|---|
| D1 | Instanced per party | The tomb is the group experience; an open tomb on a 3–20 player server is mostly empty with its bosses dead (§2.1) |
| D2 | Instances as 6 far-apart slots in one World, not a plane id | No spatial *query* changes; interest, AI and AoE separate by distance. Only `World.clamp` (per area) and the client's stage origin change (§2.2, F1, F2) |
| D3 | One tomb navmesh routed per slot by a CompositeNav | One copy in memory; moves never cross areas |
| D4 | Use the retail interior (floors 1, 5, 6), not new geometry | The real tomb, 20 MB of finished art, lightmaps and navmesh; no level-building wave |
| D5 | Cut floors 2–4 | Twice the download and the walking for no new kind of play; hooks |
| D6 | Three wings by band (15–16, 17–18, 19–20), each with its boss | The climb's three steps; most evenings run one wing |
| D7 | Party of 2–4, all level 15+; no solo | The user's "the Tomb and big bosses need a group"; a duo can do Wing I at 16+ and Wings II–III at the band top, a trio at a band floor is the hard case (§6.3) |
| D8 | Entry by a quest (JG_X15, CLIMB's reserved id), no key per run | Friction for three friends buys nothing the lockout does not do |
| D9 | Tomb Seal Shards (5) open an optional Treasure Vault | Makes wave 13's fishing hook a reward, not a gate |
| D10 | A wing unlocks per character after the boss before it | Run the wing of your band; keeps the order meaningful |
| D11 | Entry never locked; personal boss chests once per 20 h | Friends can help and practise; the springs' 20 h rhythm |
| D12 | The Emperor's Favour = 20 min of CLIMB's climb at your level, as a per-level % table (10.7 / 7.7 / 6.1 / 5.4 / 3.5 % at 15–19), in the wing's own band only (15–16, 17–18, 19–20; no overlap) | First run ≈ 1.2–2.2× the field for that hour; a 2 h/day friend climbs ≈ 7–19 % faster, ≈ 4–5 h of the 40 h; no fountain for out-of-band characters and no double Favour at 17 and 19 ("difficult to reach"; CLIMB: "loot, not speed") |
| D13 | Trash EXP = `trashExpMul` (2.0 today) × the field curve, set by the merged re-run to CLIMB §3.5's target (1.0–1.15× a solo hour) | Repeat runs land at the field rate; one knob, one target shared with CLIMB (§5.2) |
| D14 | Tomb monsters: retail models, clips and MSKILL rows; numbers from the field curve × role | Follows the re-tune; no hand-tuned stat tables |
| D15 | Formation pulls, runners, bombers, swarms, casters, traps | New behaviours from roles, cheap in code (§5.1) |
| D16 | Bosses: General 26k, Viper 32k, SoHaow 46k HP; fury ×3 at **9 / 10 / 12 min** | The three friends at each band floor win before the fury even at 60 % uptime (the author's 8 / 9 / 10 left them 20–60 s); duos below a band top and solos are still stopped (§6.3, F3) |
| D17 | Every special has a wind-up clip, a ground telegraph ≥ 1.2 s and a banner line | "Readable in SRO's style"; no death without warning |
| D18 | Telegraph hits use the server position at release; the client draws 0.3 m larger | Authoritative and fair on screen |
| D19 | The West Wind Ward and the jewels (SoHaow) | The Four Guardians theme as a mechanic; one player's job, readable |
| D20 | Revive at the last lamp, but the boss court's lamp is dark during its fight; rule 13 as CLIMB §6 builds it (grace, Incense, refund); a wipe resets the boss | Deaths hurt without ending the run; no corpse-run zerg under the 10-min grace (F5) |
| D21 | Tomb monsters never become nemeses (NEMESIS's `Mob.tag = 'instance'`) | An instance monster vanishes with its slot; one tag, NEMESIS's S-ELIG (F11) |
| D22 | Horses allowed inside | The retail floors were built at field scale |
| D23 | Personal chests (gear for the opener's class) | No squabbles among three friends |
| D24 | Chest gold ≈ a run's potion bill | The first run breaks even at x1; repeats cost |
| D25 | Terracotta Regalia tokens now for CLIMB's W15-A slot (6 pieces, SoS-B stats); the set in wave 15 | No item without art; the reward is banked; one slot table (CLIMB §4.3) (F13) |
| D26 | The Broken Hilt offered to wave 17 as the hilt of CLIMB's W17-B (Tiger Girl's Fang) | One talking legendary, not two; the tiger spirit's sanctum holds its hilt (F13) |
| D27 | SoHaow is the tiger spirit of the questline; JG_T03's Ward makes the Tiger Girl (encounter and world boss) deal −10 % to its holder | Ties the dungeon to "The Tiger's Shadow" without editing the questline; the JG_025 encounter alone is a 5 % HP finale (F14) |
| D28 | `qin-tomb` is its own lazily loaded export with an interior profile | The field download and frame are untouched |
| D29 | Lightmaps + dark fog at 110 m + 8 flame lights | The retail baked look; cheap; the view range is 120 m anyway |
| D30 | 6 slots | 24 players in the tomb; measured cost is no limit (§9) |
| D31 | 120 min cap, 10 min empty close, no persistence of instances | The full clear's p90 is < 80 min; restarts are rare |
| D32 | The sim lives in a fork (`work/tmp/tomb/sim-tomb.ts`; the fact-checked `sim-tomb-fc.ts`) | `sim.ts` is shared with the sibling specs this wave |
| D33 | The NPC is the **Tomb Steward** Baek | CLIMB's MB4 is "the Gate Warden" at the same door, with a quest "The Warden Falls" (F8) |
| D34 | One live instance per character; a fresh one only after it closes | No slot hoarding, no free reset farming, party re-forms change nothing (F6) |
| D35 | A joiner passes every entry rule; a chest needs presence at the boss's pull | "Join later" is never a way around the rules or a free chest (F7) |
| D36 | Per-area `World.clamp`; the client renders a slot relative to its origin | Without them a warp into tomb space lands on the field's edge, and 40–100 km coordinates shimmer in float32 (F1, F2) |
| D37 | Chests roll rows by required level (CLIMB T5 / T6 / T7), never a `BA` chest piece, never a `_C_RARE` | Grade letters do not fix armour levels; every degree-3 chest piece needs 21+ (F16) |

## 14. Needs from the user (each with the default used if there is no answer)

1. **Look at the two images** (`work/tmp/tomb/tomb_layout.png`, `work/tmp/tomb/tomb_bosses.png`; also
   `retail_floors.png`). Default: build as drawn.
2. **After the build, one run per wing with the friends** (≈ 20 + 40 + 20 min, any evening; §16.4). Default: the
   sim's tuning stays until then.
3. Nothing else blocks the start; no download, no Meshy.

## 15. Open questions (each with its default)

| # | Question | Default |
|---|---|---|
| Q1 | Should tomb deaths cost less than rule 13's 1–20 %? | **No**: the rule as the user wrote it, with CLIMB's grace and Incense; the revive-at-lamp softens the run, not the EXP |
| Q2 | Allow 5-player parties (the server's party max is 8)? | **No**: 2–4; the bosses are tuned for 3–4 |
| Q3 | Should a solo level-20 player be allowed into Wing I (it can clear it)? | **No**: the group rule; Wing I is the 15–16 party's |
| Q4 | Is 20 minutes of Favour per wing per day the right size? | **Yes** until the friends' first week (≈ 4–5 h of the 40 h for a daily player); halving it is one table in `tomb.json` |
| Q5 | Use floor 2's teleport maze as a fourth, optional wing later? | Deferred (hook, §12) |
| Q6 | The scale of the retail rooms (450 m) feels right? | **Yes**, with fog and horses; a viewer walk (TB-CV) is the check |
| Q7 | Do the retail tomb monsters' 6–8 m bind-pose meshes look too big next to players? | Retail scale (`characterdata` Scale 100); the TB-CV viewer check may set a per-row display scale |

---

## 16. Lanes

### 16.1 Seams first (one agent each, disjoint files, after the wave-14 base commit)

| Seam | Owner | Files | What |
|---|---|---|---|
| S-NAV | TB-NAV | `apps/server/src/composite-nav.ts` (new; `nav.ts` itself is CLIMB's S-NAV2), `game.ts` (load), `world.ts` (`clamp` per area) | `CompositeNav` routing by x, tomb surface keys prefixed; loads the `qin-tomb` nav with its own home; `World` areas (field + slots) for clamping (F1) |
| S-HOOK | the wave's step-0 seam agent (with CLIMB/NEMESIS's S-DEATH and S-ELIG, same files) | `apps/server/src/modules.ts`, `gameplay.ts` (respawn) | `respawnPoint?(p): NavPoint \| null` module hook; the tomb uses NEMESIS's `Mob.tag = 'instance'` (no `Mob.instance` field) |
| S-WIRE | TB-W | `packages/shared/src/protocol.ts`, validators | `telegraph`, `tombState`, `tombEnter/Join/Leave`, `ServerInfo.dungeons` |
| S-STAGE | TB-G | `apps/game/src/stage/host.ts`, `screens/world.ts`, the net boundary's position helpers | the stage switch by position (`dungeons[]`); the **stage origin**: one `toLocal` / `toWire` pair for every position in and out (F2) |

### 16.2 Lanes

| Lane | Owns | Seams used | Tests | Effort |
|---|---|---|---|---|
| **TB-CV** converter | `packages/formats/src/dof.ts` (new), `packages/convert/src/dungeon/` (new), the extra-mobs list in the mob export | — | DOF fixture round-trip (all 6 floors: declared = found blocks); the export's nav places the four lamp points; manifest `interior`, `slots`; byte-identical field export | L |
| **TB-NAV** | S-NAV | — | a move inside slot 3 equals the same move in slot 0 offset; no move crosses `TOMB_X0`; place() in each slot; a warp into slot 5 is not clamped to the field; a tomb surface key never restores in the field | S |
| **TB-S** server module | `apps/server/src/tomb/` (new: `tomb.ts`, `slots.ts`, `content.ts`, `lockout.ts`), the migration row, `content/tomb/tomb.json` | S-HOOK, S-WIRE, S-NAV | entry rules (each refusal), lease/close/timers, join (re-checks every rule), one live instance per character (enter/leave/re-enter, disband and re-form), the lamp revive and the dark boss lamp, chest credit at the pull, chest lockout and the Favour table and bands, restart → Steward | M |
| **TB-M** monsters | `apps/server/src/tomb/monsters.ts`, `content/tomb/monsters.json` | CLIMB's S-DERIVE | the derived rows equal CLIMB's standard curve × the role (and `sim-tomb-fc.ts curveAt` on today's `mobs.json`); `Mob.tag = 'instance'` on every row; formation link-pull; the runner; bombers explode on their timer; GM `/spawn MOB_TQ_*` refused | M |
| **TB-B** bosses | `apps/server/src/tomb/bosses.ts`, `content/tomb/bosses.json` | S-WIRE | each special's shape test (inside/outside at release), bands fire once, the ward and jewel, enrage, fury, reset on leash | M |
| **TB-P** puzzles | `apps/server/src/tomb/puzzles.ts` (bells, mirrors + the shared beam function in `packages/shared/src/tomb-beam.ts`, statues, plates, traps, lever) | S-WIRE | every rolled layout is solvable; wrong orders reset; plates silence traps for 6 s; seals open the door | M |
| **TB-L** loot | `apps/server/src/tomb/loot.ts`, `content/tomb/loot.json`, the token and curio item rows | — | chest per character, lockout, class filter, rows by required level (never `BA`, never `_C_RARE`, req ≤ 20), the Star chance, SoHaow's Incense, the vault consumes a Seal | S |
| **TB-Q** story | `content/quests/tomb.json`, the Steward and steles (`content/npcs.override.json` rows) | — | the quest checker (0 errors); JG_X15 defined once across `content/quests/*.json`; the Steward ≥ 40 m from MB4's camp and every aggressive roam circle | S |
| **TB-TG** telegraphs (client) | `apps/game/src/world/telegraph.ts` (new), its i18n | S-WIRE | pool of 8, fill over `ms`, removed at release; Low outline only; zero per-frame allocation | S |
| **TB-R** render | `packages/world-render/src/interior.ts` (new: the profile switch), the quicksilver material | — | interior profile turns off sky/ocean/terrain/grass/weather; byte-identical field frame when not inside | M |
| **TB-G** game | S-STAGE, the tomb HUD (wing timer, seals, lamps), the Steward dialog, the loading screen text | S-WIRE | stage swap both ways; a relog into tomb space; the mock server's tomb door; a skinned character at slot 5 (x ≈ 90 km) renders identically to slot 0 (the stage origin); minimap hidden inside | M |

### 16.3 Order

Seams → TB-CV first (the export gates everything visible) with TB-S, TB-M, TB-B, TB-P, TB-L on fixtures in parallel →
X1 (the export + a server run of Wing I with bots) → TB-R, TB-G, TB-TG, TB-Q → I-14 integration → LAB-14 (three tomb
scenes, Medium + High, both backends, GPU lock) and the server bench (`instance-cost.ts` with the real module, 4
parties) → hunt (lenses: a telegraph that hits outside, a wipe that keeps adds, a chest twice in 20 h, a stage switch
that leaks the field's VRAM, a member left behind on a leader's leave, a slot not freed, a revive at a boss lamp
mid-fight, a second instance for one character, a join that skips a rule, a position used without the stage origin, a
warp clamped to the field) → fixers → G-14 → V-14.

### 16.4 User checks (after the build)

1. Walk the door with the friends; the Steward's refusals read right.
2. **Wing I at 15–16** (≈ 20 min): formations, the pits, the bells, the General's cone and volleys.
3. **Wing II at 17–18** (≈ 40 min): the trap gallery as a team, the mirrors, the statues, the Viper's spit and coil.
4. **Wing III at 19–20** (≈ 20 min): SoHaow's pounce, roar and the ward; the chest.
5. Say "too easy / too hard / too long" per wing; the knobs are in `content/tomb/*.json`.

## 17. Scope-cut order (cut from the top)

1. The Treasure Vault (the shards stay curios).
2. The titles and the White Tiger's Ward charm (JG_T03 still rewards gold and SP).
3. Horses inside (walk).
4. The Statue Room (Wing II's second seal comes from the mirrors' second beam).
5. The pits' pressure plates (the pits become plain packs).
6. The trap gallery's plates and lever (traps on a fixed rhythm only).
7. Wing III's ward and jewels (SoHaow keeps pounce, roar, adds, enrage).
8. Wing II as a whole (the tomb ships Wing I + Wing III: the Viper's chest moves to SoHaow, Wing III unlocks after the
   General, and its band widens to 17–20 with the Favour at 17–20).

**Never cut:** instancing (slots), the entry rules (2–4, 15+), the three-band structure with at least Wing I and
Wing III, ground telegraphs with banner lines, the personal chest lockout and the in-band Favour, the lamp revive with
rule 13 and the dark boss lamp, one live instance per character, per-area clamping and the stage origin (without them
tomb space does not work), the interior profile, G1 on Medium.

## 18. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| The DOF's unparsed link sections matter for nav (blocks joined by edges) | The party cannot walk from a room into a corridor | TB-CV welds coincident navmesh edges between blocks at export (0.5 dm) and tests every lamp-to-boss route |
| The retail scale feels empty | Boredom between packs | Fog at 110 m, horses, packs spaced ≤ 250 m (§4), the friends' run (§16.4) |
| Telegraph timing vs latency | "I was out" deaths | ≥ 1.2 s wind-ups, release on server position, client draws 0.3 m larger (D18) |
| The stage switch leaks memory | Tomb runs degrade the field frame | The field stage is released on entry; LAB-14 checks VRAM after 3 round trips |
| The re-tune moves the curve | Tomb EXP/difficulty drift | Everything derives from the curve; re-run `sim-tomb.ts` (§6.5) |
| Tick spikes (GC, SQLite) | One late tick on the N100 | Not tomb-specific; G-14 reads `worstTickMs` with 4 parties inside |
| Retail monster sizes (6–8 m) | Big monsters clip into corridors | They are the retail tomb's own rows in the retail rooms; viewer check (Q7) |
| A position path misses the stage origin (fact-check F2) | A character or decal 40–100 km away, or shimmering | One `toLocal` / `toWire` pair at the network boundary; TB-G's slot-5 test; the hunt lens "a position used raw" |
| The step-0 seams collide (`gameplay.ts`, `modules.ts`, `world.ts`, `nav.ts` are touched by CLIMB, NEMESIS and this spec) | Merge conflicts, a lost hook | One step-0 seam agent for S-DEATH, S-ELIG, S-HOOK and the `World` areas; `nav.ts` stays CLIMB's, and the tomb's nav is a new file |
| The field rebuild on every exit is slow on the friends' PCs [unknown] | A long loading screen after every run | LAB-14 times it; over 10 s, keep the field stage resident (§10.1) |

---

## 19. Fact-check log (2026-10-02)

An adversarial pass re-derived this spec's [confirmed] claims from code, data, client files and re-runs, and tried
to break the design. It edited only this doc and `work/tmp/tomb/`. It spent no Meshy credits, downloaded nothing,
and used no browser or GPU.

**Corrections (each is applied above):**

| # | Finding | How it was checked | Fix |
|---|---|---|---|
| F1 | "No spatial code changes" was false. `World.warp()` and `moveEntity()` clamp x/z to the field export's bounds, so a warp to x = 40 km lands on the field's east edge | `world.ts` `warp`, `clamp`; manifest bounds x −2304…1344 | Per-area clamping in S-NAV (§2.2, D36) |
| F2 | At 40–100 km, float32 world matrices step 4–8 mm; the client has no large-world handling | grep: no `useLargeWorldRendering`, floating origin or high-precision matrix in `apps/game` or `world-render`; float32 spacing arithmetic | A client stage origin at the network boundary (§2.2, §10.1, S-STAGE, D36) [likely visible without it] |
| F3 | The fury at 8 / 9 / 10 min left the three friends at each band floor 20–60 s from it at p90; at 60 % uptime, 56–72 % of their wins came inside the fury (Wing III cleared 82 %). The author's "boss 11.4 min" for 3 × 19 summed wiped attempts | `sim-tomb-fc.ts --fc` per-attempt log | Fury at 9 / 10 / 12; duos at a band top can now clear Wings II–III (§6.3, D16) |
| F4 | The overlapping Favour bands (15–17, 17–19, 19–20) paid two Favours a day at 17 and 19, which made a 2 h/day friend ≈ 25–30 % faster, against CLIMB's "loot, not speed". The author's "15–20 % faster" did not hold at 17–18 | arithmetic on the sim's rates | Bands without overlap; ≈ 7–19 %, ≈ 4–5 h of the 40 h (§3.4, D12) |
| F5 | The lamp revive allowed corpse runs inside a boss fight, made free by CLIMB's 10-minute grace; the sim had assumed the dead stay down | CLIMB §6.1; `sim-tomb.ts` `tombFight` | The boss court's lamp is dark during its fight (§3.6, D20) |
| F6 | Nothing stopped one party leasing every slot, or resetting the easy packs by re-entering | design read | One live instance per character (§3.1, D34) |
| F7 | "Join later" did not re-check the entry rules, and a late joiner could open a chest | design read | Joiners pass every rule; a chest needs presence at the pull (§3.1, §3.4, D35) |
| F8 | "Tomb Warden" collides with CLIMB's MB4 "the Gate Warden" at the same door (and its quest "The Warden Falls") | CLIMB §2.5, §8.2 | The NPC is the Tomb Steward (D33); MB4 stays ≥ 40 m away (§11.4) |
| F9 | Trash EXP ×2 contradicts CLIMB §3.5's "0.75 × standard"; both aim at ≈ the solo hour from different models | CLIMB §3.5, `climb/design.ts` `tombMob`; standard EXP 23.5 × L ≈ `curveAt` | One knob, `trashExpMul`, set to CLIMB's target by the merged re-run (§5.2, D13) |
| F10 | "20 minutes of frugal grinding" cannot be computed by the server | design read | A per-level % table from CLIMB's model hours (§3.4) |
| F11 | `Mob.instance` duplicates NEMESIS's `Mob.tag = 'instance'` (S-ELIG) | NEMESIS §2.1, S-ELIG | Use the tag (§3.6, D21) |
| F12 | JG_T01 duplicates CLIMB's reserved slot JG_X15 "the key to the Tomb" | CLIMB §8.2 | JG_X15, defined once in `tomb.json` (§3.2, §8) |
| F13 | The five-piece T18 Regalia set and the Broken Hilt as "the talking legendary" contradict CLIMB §4.3 (W15-A: 6 pieces, SoS-B stats; W17-B Tiger Girl's Fang is the legendary) | CLIMB §4.3 | Follow CLIMB; the Hilt becomes the Fang's hilt (§7.4, D25, D26) |
| F14 | JG_T03's −10 % charm applied only to the JG_025 encounter, a 5 % HP, ×0.8 attack finale, so it meant nothing | `jangan.json` JG_025; CLIMB §2.6 | It also applies to the world boss (§8, D27) |
| F15 | The `titles` column duplicated CLIMB §7.3's achievements and titles | CLIMB §7.3; STORM_QILIN F11 | Dropped; a bus event and achievement rows (§11.2) |
| F16 | "Grade A = req 16–17, grade B = 18–20" was wrong for armour (A spans 16–21 by slot; Casque 19 and Hose 20 are `_A` rows); `_B_RARE` and `_C_RARE` weapons need 16 | `items.json` tabulated by family, slot and grade | Chests roll by required level, CLIMB T5 / T6 / T7; never a `BA` piece or a `_C_RARE` (§7.1, D37) |
| F17 | 65 `MOB_TQ_*` rows, not 64; retail normal HP 2,000–29,700 (not 14,000–30,000); the guardian names are Blue Dragon and Blue Hawk (not Azure Dragon and Vermilion Bird) | re-count over every characterdata file; textdata | Text and images fixed (§1.3, §4.3) |
| F18 | The door probe's "from the door" distances are from the Steward's spot (864, −1040) | `door_probe.ts` re-run, arithmetic | §1.1 |
| F19 | The author's Wing I and Wing II claims: duos clear Wing I only at 16+ (2 × 15: 0 % at the author's fury); Wing II has 7 packs plus the gallery, not 9; Wing II repeats run at 0.7× the frugal rate, not 0.8× | sim re-run; arithmetic | §0, §4.4, §6 |
| F20 | The "40–70 draws" for the floor-1 hall ignored its 101 static meshes | 101 `.bms` in `floor_01` | Far plane at the fog and a per-material merge (§10.3) |
| F21 | The Qilin needs no tomb check: its six seats are fixed field peaks, the nearest 1.4 km from the door | STORM_QILIN §3.2 | §11.4 |

**Re-derived and confirmed as written:** the author's sim reproduces `tomb-sim-n100.txt` byte for byte; the DOF
census (1/20/89/87/23/5 blocks, declared = found; floor 6's rooms at ±722 m); 849 lightmap files (23 MB), 59 MB of
meshes, 101 floor-1 meshes; three-floor raw sizes (mesh 8.5 + 8.2 + 3.6 MiB, lightmaps 1.4 + 1.1 + 1.1 MiB, nav
124 + 252 + 121 KiB); 87 `GATE_JINSI_*` rows; the retail rarities and scales (General 85–90 rarity 8 scale 200,
SoHaow `EASTGUARDIAN` scale 400 with a 6.8 m collision radius, the White Viper unique, scale 160); the door and plaza
placing on the navmesh; `VIEW_RANGE` 120 + 10 m, the 10 Hz tick, dormancy at view + 30 m, `PARTY_MAX` 8, the party
pool ×(1 + 0.1(n − 1)) by level, `MobTuning`, `Mob.damageMul`, `gearPool`, poison's 1 s ticks, no `telegraph`
anywhere, quests loaded from every `content/quests/*.json`, `MAX_COORD` 1,000 km; the server-cost table against both
JSON files and FIELDS' ×2.5 N100 factor; the field-fit roster numbers; potion prices (Medium 200, Large 400); and
FISHING's tomb hooks (the moat, the eel and its broth at +20 %, the Offering Box at 1 in 200, the shard, the letter).

**Tried and not broken** [projected, `--fc`]: carrying a level 15 (18 %/h of its bar in Wing III, 37 %/h behind one
20 in Wing I) is not a farm; add-farming by leash resets (≈ 12 % of a bar per hour at 18) stays below the frugal
field; nemesis farming is impossible (instance tag); trash reset farming costs a 10-minute wait per reset under
F6; server load is small (§9), and the instance-creation tick is still to be measured.

---

## Appendix A: scratch files (`work/tmp/tomb/`)

| File | What |
|---|---|
| `dof_parse.py` → `dof_blocks.json` | JMXVDOF 0101 reader: blocks and objects of the six floors |
| `floor_nav.ts` → `floor_nav.json` | per block: BSR → meshes + navmesh, placed; nav and render triangle counts |
| `bms_ext.ts` → `bms_census.json` | mesh census per floor folder (vertices, triangles, lightmap UVs, navmesh, events) |
| `navbytes.ts` | raw navmesh, mesh and lightmap sizes of floors 1, 5, 6 |
| `tq_mobs.py` | the 65 `MOB_TQ_*` rows (level, HP, scale, collision, model) |
| `bsr_anims.ts`, `mob_ext.ts` | every tomb monster's meshes and clips present; bind-pose sizes |
| `door_probe.ts` | the door and plaza on the navmesh; nests near the door |
| `plot_floors.py` → **`retail_floors.png`** | the six retail floors, top-down |
| `layout_map.py` → **`tomb_layout.png`** | the layout map (prototype 1) |
| `boss_sketch.py` → **`tomb_bosses.png`** | the boss mechanic sketch (prototype 2) |
| `sim-tomb.ts` → `tomb-sim-n100.txt`, `tomb-sim.json` | the author's balance model tomb mode (fury 8 / 9 / 10; reproduced byte for byte) |
| `sim-tomb-fc.ts` → `tomb-sim-fc-n100.txt`, `tomb-sim-fc.json`, `tomb-sim-fc-attempts.txt` | the fact-check's copy: fury knobs (default 9 / 10 / 12), band-floor cases, per-attempt boss log, carry and duo cases (`--fc`) (§6) |
| `tomb-sim-fc-fury8-9-10.txt`, `tomb-sim-fc-attempts-fury8-9-10.txt` | the same runs at the author's fury, for comparison |
| `fc_patch*.py`, `fc_balance_section.md`, `TOMB_DUNGEON.before-factcheck.md` | the fact-check's edits to this doc and the doc as the author left it |
| `tomb_layout.author.png`, `tomb_bosses.author.png` | the author's images; the current ones carry the Steward, the retail guardian names and the 9 / 10 / 12 fury |
| `instance-cost.ts` → `instance-cost.json`, `instance-cost-field.json` | the server-cost measurement (prototype 3, §9) |
