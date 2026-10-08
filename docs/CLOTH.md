# Cloth physics on garments (wave 14, Wardrobe)

The user, verbatim (wave 14):

> Is it possible to add physics to the clothings? Especially garmet since is supposed to be a garmet.

**Numbering.** The user swapped the two next waves (2026-10-03: "Lets make wave 15 actually wave 14, and current wave
14 make it wave 15"): **wave 14 is now Wardrobe** (this spec and its siblings: civilian clothes for the townsfolk, new
clothing, dyes, the character-cost foundation) and **wave 15 is The Climb** (docs/CLIMB.md, docs/WAVE_PLAN10.md, still
written as "wave 14" there until the wave plan renumbers them). CLIMB §4.3's named gear slots keep their ids
**W15-A..D** in this spec (they are ids, not wave numbers); they are this wave's armour and civilian sets.

**What this spec builds.** Long garments swing. **Spring-bone chains** are added to the retail garments that hang below
the waist (robes, long skirts, front and back panels, tails, sashes, hat tassels; capes for the new clothing), on the
retail Chinese skeletons of both sexes. The chains are made **offline by an auto-rig** in the converter (no hand
rigging per item; Blender only for an optional fix-up pass), simulated **on the CPU, in a fixed 60 Hz step** (verlet
chains with a ring between neighbours, collision capsules on the thighs and calves, a tether to the animated pose),
**only for characters within 20 m** and a per-preset count, and **off on Low** (Low loads today's files unchanged). The
GPU sees the same draw calls and the same 4 bone influences per vertex as today; the chains are extra bones.

**The biggest finding** [confirmed: `work/tmp/cloth/survey.json`]: **the retail client already had cloth.** 155 meshes in
the Chinese item and character folders and `res/npc/npc` carry a BMS cloth section (pinned and free vertices, distance edges, a per-vertex
max distance, a parameter block), and most of their BSRs carry the `dyVertex` modifier (134 of the 143; but 22 other
`dyVertex` BSRs have no cloth mesh and 9 cloth BSRs have no `dyVertex`, so the BMS section, not the flag, is the
test). In the levels-1–20 gear, **three garments
have it on their skirt panels** (the man's `clothes_03` apron, the woman's `clothes_01` and `clothes_03` skirt panels)
and **eleven hats** on their tassels and plumes. Our converter reads the section and drops it, so those panels are rigid
today: they stick out behind a running character like boards (the prototype's top row). The auto-rig uses the retail
pinned/free split where it exists, so the retail artists' intent comes back.

**The user delegated every decision.** Each choice below is the option this spec would mark "(Recommended)", written as
a decision with a one-line reason (§12). Tags: **[confirmed]** measured or read in code/data here, **[likely]**,
**[projected]** a model or arithmetic, **[unknown]**.

**Fact-check (2026-10-03, adversarial pass; scratch in `work/tmp/clothfc/`).** Every [confirmed] claim was re-derived
from the code, the survey JSON, the retail BMS files (`probe.ts` re-run on the three in-game panels), the glbs and a
re-run of the sim bench. The doc was fixed in place; what changed:

| # | Claim as written | Finding | Fixed in |
|---|---|---|---|
| F1 | Non-sim cloth wearers go **kinematic**; Medium = 5 sim + 15 kinematic "at ≈ 15 Hz" = +0.25–0.35 ms | Wrong for the gate scene. Within `CLOSE_M` = 15 m the crowd budget sets no rate floor, and ANIM_LOD's size rule keeps a 1.8 m figure at full rate to ≈ 15 m (`fullSize` 0.12); the LAB plaza puts the 20 bots on an 8 m ring (`w11-rescue/harness.ts`). So the 15 kinematic actors update **every frame**: 15 × 20–35 µs = 0.3–0.53 ms on top of the sim, **≈ 0.5–0.8 ms total, over the spec's own 0.35 ms gate on paper**. A kinematic chain with follow 1 also only reproduces the retail look the plain glb already gives for free | §6.5 now: sim actors (and a 2-actor warm buffer) wear the cloth glb; **everyone else wears today's plain glb** (zero cost, still mergeable); a single-garment swap on promotion. §7 costs redone |
| F2 | The rig is per item ("one row per garment mesh") | The prototype's robe re-weights **two items**: 167 vertices of `clothes_08_la` **and** 11 of `clothes_08_ba` (`proto-rigs.json`); players mix chest and leg items freely. A per-item rig would give each item its own chains (two sims, two 91-bone skeletons) or a seam at the waist | §4.5 new: a **chain set** per set and sex, owned by one item, used by the others only when the owner is worn |
| F3 | Leg poke-through is a residual "at the jump's widest kick (t = 1.83 s)" | Understated. In `cloth-proto.gif` the shins and the `clothes_08_fa` boots cross the robe's surface in **most RUN frames** (frames 18–66 and 96–114 viewed) and through the whole jump. Causes: collision is **particle vs capsule only**, and 12 chains round a ≈ 0.35 m hem leave ≈ 18 cm between neighbours, wider than a calf; no foot capsule; the hem tether (0.45 m) is shorter than a full stride | §6.2: edge-vs-capsule test, particle radius from the ring gap, foot capsules; §9.2, §17 |
| F4 | Volume untouched (CL-D6) | `setVolume` scales Pelvis (0.90–1.08) and Thigh (0.90–1.15) skin matrices radially (`packages/appearance/src/scale.ts`, `models.ts` `setSkeletonVolume`), only for vertices weighted to those bones. Chain-weighted cloth would not widen with the hips and the thigh capsules would be too thin: body through the robe at high Volume | §6.6: the chain rest ring and the capsules scale with the actor's Volume factors; a test |
| F5 | Seam "`equipment.ts`: the dress plan picks `model.cloth`" | `apps/game/src/three/equipment.ts` only fetches the manifest. The dress plan is `@sro/appearance` `composeEquipment` (`BoundItem`), loaded by `ModelLibrary.dress()` in `models.ts`, which **does not fetch skinned items' sidecars** (only sockets') | §5.2: the cloth block goes in the cloth glb's root-node extras (no extra request); §11 seams renamed |
| F6 | Retail parameters `deformationMode` 1, `fallingSpeed` 7.9–13.5, `elasticity` 0.64–0.85, `movementFactor` 2–15 | All 155: mode 0–1, fallingSpeed 2.2–17.9, elasticity 0.39–0.95, movementFactor 2–27; the 14 in-game meshes: mode 1, 9.3–17.9, 0.61–0.95, 4–8 | §1.3 |
| F7 | `maxDistance` "0 at the waist to 0.20 at the hem on every panel looked at" | True for both `clothes_03_ba_2s`; `clothes_01_ba_2s` (woman) reaches **1.0** at its hem, the survey's max is 1.0. The rig's use is relative, so the design holds | §1.3 |
| F8 | JUMP and JUMP_RUN apex 1.61 m | JUMP 1.61 m, JUMP_RUN 1.48 m (`Bip01` translation keys in `movement.glb`); both crouch to 0.66 / 0.84 m first, so the hem meets the ground plane | §1.1 |
| F9 | Run 4.2 m/s, a tick = 7 cm | The server's run is 5.5 m/s (MOVEMENT `moveSpeed`), so a tick is ≈ 9 cm | §6.4 |
| F10 | `[confirmed: check.png iterations]` | No `check.png` exists in `work/tmp/cloth/`; only the final sheet and GIF | §6.3 |
| F11 | Wind from "the weather's `sroWind`" | `sroWind` is a shader function. The CPU value is `WeatherUniforms.wxB` (direction x/z, strength 0–1) | §6.4 |
| F12 | "LAB-14 measures" the second skeleton | LAB-14 is TOMB_DUNGEON's LAB; it is LAB-CL1 | §7 |
| F13 | W15-A "Terracotta Regalia … the clothes set is a robe" | CLIMB §4.3 names it **Tomb Warden's set** ("Terracotta Regalia" is TOMB_DUNGEON's proposed display name) and does not say what shape the clothes set is | §2.5 |
| F14 | `poseOverrides` list | The character clips also have `DOWN_DIE`, `DOWN_DAMAGE`, `DOWN_UP` (`chinaman_adventurer.json`) | §5.1 |
| F15 | Costs read as universal | They are Node on a Ryzen 5 9600X. BATCHING F20 uses ×1.5–2 for mid desktops and gaming laptops; at a 30 fps frame the sim runs 2 ticks a frame. The frame is CPU-bound and its p95 is GC-driven (`wave11/budgets.md`), so per-frame allocation matters more than µs | §7 |
| F16 | WebGL2 High unaffected | WebGL2 High plaza is 8.2 ms against G2's ≤ 8 already; +0.4–0.6 ms of High cloth makes that G2 miss wider (G2 does not block a release) | §10 LAB-CL2 |
| F17 | `cloth-proto.gif` timing | 147 frames for 4.9 s, but each frame is stored at 30 ms (GIF centiseconds), so it plays ≈ 10 % fast: the swing looks slightly livelier than it is | §13 user check |

Confirmed as written: 1,570 survey rows, 155 cloth meshes in 143 BSRs (by BSR: man 44, woman 51, npc 28, character
20; by mesh 47 / 52 / 34 / 22, the 22 being 20 hair meshes and the priest's face twice); free vertices median 21, 10–90 %
9–48, max 117; no mesh weights `cloak01`–`04`; skeletons 43 / 45 joints in the stated order; the three in-game panels
(59 / 35 / 43 vertices, 20 / 25 / 15 free, hems 0.21 / 0.49 / 0.20 m), edges max/rest = 1.000; the 11 hats and the woman
helmets' 30 / 9 / 30 free; `bindSkinned`'s shared/linked paths, `lodSkeleton`, `setVolume` over worn skeletons;
`buildMerge` keys on the skeleton, so a cloth garment never merges; Babylon 9.28 `BonesPerMesh` only on the uniform
path; animations run before `onBeforeRenderObservable`, skeletons prepare after it; the prototype rigs (12 × 4 over
167 + 11 vertices, 4 × 4 over 30); the sim bench (re-run 3 × 5 × 10,000 ticks: **13.9–16.2 µs** median for 12 × 4, 4.4–4.9
µs for 4 × 4, on a machine at ≈ 60 % CPU from other work, so consistent with the author's 12.1 µs on a quiet one);
GIF 147 frames 500 × 694, 6.2 MB; `wave11/budgets.md` 14.9 / 17.2.

---

## 0. Summary

| Question | Answer |
|---|---|
| Which garments | **Tier A** (big, visible swing): robes, long skirts, long front/back panels and tails. **Tier B** (small): short skirts, short tunic hems, hat tassels and plumes. **Tier C** (none): trousers, armour plates, faulds. In the level-1–20 gear: 3 tier-A garments, 3 short skirts and 3 tunic-hem rings (tier B; two of them on the tier-A sets), 11 hats (tier B) (§2.3). The retail degree-4–10 robes and dresses (candidates for the wave's new clothing) are almost all tier A (§2.4). |
| How rigged | An **auto-rig in the converter** (`pnpm sro cloth`): chains placed on the garment's own surface (a closed **ring** round the hips, or an open **fan** over a panel), weights blended 2 chains × 2 segments, the waist band blended with the retail weights, retail pinned vertices kept byte for byte (§4). Per-garment specs in `content/cloth/rigs.json`; tuning in `content/cloth/tunes.json`. |
| Data | A second skinned glb per cloth garment, `<item>.cloth.glb`: the retail skeleton's joints, then the chain joints (`cloth_k_j`, children of the parent bone); its root-node extras (mirrored in the sidecar) carry a `cloth` block (chain set, rest positions, anchors, tune); a robe's chest and leg items share one chain set (§4.5). The equipment manifest gets an optional `model.cloth` (§5). |
| Runtime | `ClothSystem` in `apps/game`: per actor, the pure `cloth-sim.ts` step at a fixed 60 Hz, **rendered as a deviation from the animated pose** so the cloth never lags the body at any refresh rate (§6). Main thread (worker-ready module). The garment binds through `bindSkinned`'s existing "joints differ, link by name" path: its own skeleton, base joints linked to the actor, chain joints driven by the sim. |
| Who gets it | Own player, party, target, then the nearest, within 20 m, on screen and at full pose rate: **Medium 5, High 10, Ultra 20** actors wear the cloth glb and simulate (+ up to 2 "warm" actors, kinematic, so a rank change does not swap at once); **everyone else wears today's plain glb** (the retail look at zero cost; fact-check F1); **Low and Classic: off** (today's files). |
| Cost | Sim step **12.1 µs per robe per tick** in Node on the dev PC [confirmed: `proto.ts --bench`; re-run 13.9–16.2 µs on a loaded machine]; per simulated actor ≈ 35–55 µs a frame with the anchors, the chain writes and the garment's own skeleton [projected]. **Medium ≈ +0.22–0.35 ms CPU p95** on the dev PC (×1.5–2 on laptops), High +0.4–0.62, Ultra +0.75–1.17 [projected]. **0 extra draws** [confirmed by design: same meshes, same materials]; a cloth garment never joins a merge (`buildMerge` keys on the skeleton). |
| Gate | The 20-player WebGPU Medium plaza is at the line (wave11/budgets.md: 14.9 p95, Tiger Girl 17.2 fails). **Cloth on Medium ships only after the wave's character-cost foundation lands**, and only if `cloth on − cloth off ≤ 0.35 ms` CPU p95 and the scene stays < 16.7 ms on both backends (§10). |
| Prototype | `work/tmp/cloth/`: a robe (man, retail `clothes_08`) and the skirt panel (woman, `clothes_03_ba_2s`) on the retail skeletons running, jumping (JUMP_RUN), running and stopping, today vs chains: **`cloth-proto.gif`** (§9). |

### 0.1 Where each part of the request lands

| The user / the task | Where |
|---|---|
| "add physics to the clothings" | §6 the runtime, §4 the rig |
| "Especially garmet" | §2.3: the garment class gets tier A first (the retail cloth panels of `clothes_01`/`03`), then the robes of the new clothing |
| skirts, robe tails, sleeves, sashes, capes | §3 the chain kinds: ring, fan, tail, sleeve, sash, tassel, cape |
| both sexes, retail skeletons | §1.2: `europeman_skel` (43 joints) and `europewoman_skel` (45); the rig is per garment mesh, so per sex |
| cheap, deterministic, no jitter | §6.2 fixed step + deviation rendering, §6.4 the resets, §7 costs |
| only within ~20 m, off on Low | §6.5 tiers, §8 settings |
| "create more clothing" (siblings) | §11 seams: every new set ships with a `rigs.json` row; W15-A..D in §2.5 |

---

## 1. What exists to build on [confirmed: read in code and data, 2026-10-03]

### 1.1 The client

- **Equipment binding** (`apps/game/src/three/models.ts`, `bindSkinned`): a skinned item whose joint list equals the
  actor's (same names, same order) **shares the actor's skeleton**; otherwise **"else linked by name"**: the item keeps
  its own skeleton, each of its bones is `linkTransformNode`d to the actor joint of the same name, and the skeleton is
  registered with the animation LOD (`lodSkeleton`) and with Volume (`setVolume` loops over every worn skeleton). A
  cloth garment uses this second path with no new binding code: its extra chain joints simply have no actor joint to
  link to, so the cloth system drives them.
- **Bone storage**: Babylon 9.28 stores bone matrices in a texture when the skeleton supports it; `BonesPerMesh` is a
  define **only on the uniform path** (`materialHelper.functions.js` `PrepareDefinesForBones`). So more bones do not
  add shader variants on WebGPU or WebGL2 [confirmed: code read].
- **G1 rescue** (`world/crowd-budget.ts`, `setMergeParts`): merges the body glb's own parts only; worn items are
  separate draws already. Cloth does not touch the merge [confirmed: `buildMerge` reads `this.meshes`, not `worn`].
- **Animation LOD** (`ANIM_LOD`, `lodTick`): far, small or off-screen actors update their pose less often. The cloth
  tiers (§6.5) follow it.
- **The jump** (MOVEMENT, P-JUMP): the JUMP and JUMP_RUN clips lift `Bip01` themselves (apex 1.61 m for JUMP, 1.48 m
  for JUMP_RUN, after a crouch to 0.66 / 0.84 m) [confirmed: `movement.glb` Bip01 translation keys, re-read by the
  fact-check]. The cloth sees it as ordinary motion; the crouch puts a floor-length hem on the ground plane.
- **Dressing** (`ModelLibrary.dress()` → `applyDress`): the plan comes from `@sro/appearance` `composeEquipment`
  (`BoundItem`: code, slot, kind, glb, joints, meshes); skinned items load their glb only (no sidecar fetch; sockets
  fetch theirs for the trail dummies), and a re-dress removes and re-binds every worn item and rebuilds the merge
  [confirmed: `models.ts` `dress`, `applyDress`].
- **Volume** (`setVolume` → `setSkeletonVolume`): radial skin-matrix scales on `Bip01 Pelvis` (0.90–1.00 man,
  0.90–1.08 woman), both Thighs (0.90–1.15), Spine, Spine1, UpperArms (and the woman's `Bone01`), applied to every
  worn skeleton, and only to vertices weighted to those bones [confirmed: `packages/appearance/src/scale.ts`].

### 1.2 The skeletons

- `europeman_skel` 43 joints, `europewoman_skel` 45 (+ `Bone01` bust, `Bone02`) [confirmed: `equipment.json`]. Both
  carry a **4-bone `cloak01`–`cloak04` chain** that no Chinese item uses [confirmed: survey, no Chinese item mesh
  weights to it]. New capes (§3) can ride it for free.
- Pelvis at ≈ 1.00 m (man STAND1), legs `Bip01 L/R Thigh → Calf → Foot` (CHARACTER_SCALE E13) [confirmed].

### 1.3 The retail cloth data (the survey)

`work/tmp/cloth/survey.ts` read every BSR in `res/item/china/{man,woman}_item`, `res/char/china` and `res/npc/npc` and
every mesh they name (1,570 mesh rows, 0 parse errors) [confirmed].

- **The BMS cloth section** (`packages/formats/src/bms.ts` `readCloth`, already parsed): per vertex `maxDistance` and
  `pinned`; edges `(a, b, maxDistance)` whose max distance **equals the rest length** in every edge checked (ratio
  1.000 min/median/max, `probe.ts` on the man's and woman's `clothes_03_ba_2s` and the woman's `clothes_01_ba_2s`):
  inextensible links; a parameter block (all 155: `deformationMode` 0–1, `fallingSpeed` 2.2–17.9, `elasticity`
  0.39–0.95, `movementFactor` 2–27; the 14 in-game meshes: mode 1, 9.3–17.9, 0.61–0.95, 4–8). The parameter
  semantics are [unknown] (SilkroadDoc names only); `maxDistance` grows from the pinned waist (0) toward the hem
  (0.20 on both `clothes_03` panels, **1.0** on `clothes_01_ba_2s`; 0.05–1.0 over the survey), so it reads as **a
  relative mobility mask** [likely].
- **Who has it**: 155 meshes in 143 BSRs (by BSR: man items 44, woman items 51, `res/npc/npc` 28, Chinese characters 20,
  i.e. 20 hair meshes plus the priest's face). Pinned vertices
  carry ordinary skin weights; free vertices are typically 9–48 per mesh (10–90 %; median 21, 117 at most).
- **In-game gear (degrees 1–3)** with cloth: the man's `clothes_03_ba_2s` (a 59-vertex front apron, waist to 0.21 m,
  20 free), the woman's `clothes_01_ba_2s` (35 vertices, to 0.49 m, 25 free) and `clothes_03_ba_2s` (43 vertices, to
  0.20 m, 15 free); hats: man `clothes_03_ha`, `heavy_01/02/03_ha`, `light_01/02_ha`; woman `clothes_02_ha`,
  `heavy_01/02/03_ha`, `light_01_ha` [confirmed: `an2.txt`].
- **Today these panels are rigid**: their free vertices are mostly skinned 50/50 to `Pelvis` and a `Thigh` (some of the
  woman's `clothes_03` panel is Thigh-dominant), so the long panel swings like a board with one leg (prototype, top row).

Survey sheets (front and side, coloured by the dominant bone, retail cloth in red):
`work/tmp/cloth/survey_ingame.png` (degrees 1–3 and the avatars), `work/tmp/cloth/survey_retail_4_10.png`.

---

## 2. Which garments get chains

### 2.1 The tiers [decision]

| Tier | What | Chains | Why |
|---|---|---|---|
| **A** | Robes and long skirts reaching the calf or below; long front/back panels; coat tails; long sashes and ribbons | ring 10–12 × 4, fan 3–4 × 4, tail 1–2 × 4 | the visible win: these are rigid boards or tents today |
| **B** | Short skirts (hem above the knee), short tunic hems, hat tassels and plumes | ring 8 × 2, tassel 1–2 × 3 | small but cheap; the retail hats already mark them |
| **C** | Trousers, leg plates, faulds, shoulder plates, gloves, boots | none | they follow the limbs correctly already |

A tier-A garment keeps its retail weights above the waist band; only its hanging part moves to chains.

### 2.2 The rule the auto-rig applies

A garment mesh gets chains when (a) it has a retail cloth section (its free vertices define the region), or (b) it has
≥ 40 vertices below `pelvis − 0.15 m` that lie outside both thigh capsules at bind (hanging cloth, not a trouser leg).
`rigs.json` overrides either way. The class and kind come from the shape: closed round the hips → ring; one side →
fan or tail; hat → tassel [decision: reason: one rule covers the 18 in-game sets and the retail 4–10 catalogue with
no per-item hand work].

### 2.3 The level-1–20 gear (what players wear now) [confirmed: shapes from `survey_ingame.png`, `an3.txt`]

| Set (man / woman) | Pieces with cloth | Tier, kind | Chains (bones) |
|---|---|---|---|
| clothes_01 man | tunic hem to 1.02 m | C | – |
| clothes_01 woman | tunic to 0.75 m + **skirt panel `_2s` to 0.49 m (retail cloth)** | **A** fan + B hem ring | fan 4 × 3 + ring 8 × 2 (28) |
| clothes_02 man | tunic hem to 0.86 m | B ring | 8 × 2 (16) |
| clothes_02 woman | short top, trousers; hat `clothes_02_ha` (retail) | B tassel | 1 × 3 (3) |
| **clothes_03 man** | **front apron `_2s` to 0.21 m (retail cloth)**; hat `clothes_03_ha` (retail) | **A** fan + B tassel | fan 4 × 4 + tassel 2 × 3 (22) |
| **clothes_03 woman** | tunic to 0.73 m + **long skirt panel `_2s` to 0.20 m (retail cloth)** (prototyped) | **A** fan + B hem ring | fan 4 × 4 + ring 8 × 2 (32) |
| light_01–03 man | tassets follow thighs; hats `light_01/02_ha` (retail) | C + B tassel | 1–2 × 3 |
| light_01–03 woman | **short skirts** (hem 0.68–0.76 m); hat `light_01_ha` (retail) | B ring + tassel | 8 × 2 (+3) |
| heavy_01–03 man | leg plates; helmets `heavy_01/02/03_ha` (retail plumes) | C + B tassel | 2 × 3 |
| heavy_01–03 woman | leg plates; helmets `heavy_01/02/03_ha` (retail, 30 / 9 / 30 free) | C + B tassel | 2 × 3 |

So **the garment class is where the swing is** (the user's word): its degree-3 sets carry the long retail panels.

### 2.4 The retail catalogue (degrees 4–10, avatars) for the new clothing [confirmed: `survey_retail_4_10.png`]

- **Man `clothes_06`–`10`**: floor-length robes (hem 0.00–0.03 m) whose skirt is weighted to the legs (so they open
  into a tent when a leg swings: prototype, top-left), each with a retail-cloth front panel. **Tier A ring 12 × 4**
  (the prototype's robe is `clothes_08`).
- **Man `clothes_04`/`05`**: coats with back tails to 0.56–0.68 m. **Tier A tail 2 × 4**.
- **Woman `clothes_06`–`10`**: long dresses (hem 0.01–0.10 m), retail-cloth front panels. **Tier A ring 10 × 4**.
- **Woman `clothes_04`**: two long ribbons (retail cloth). **Tier A sash 2 × 4**.
- **Woman `light_04`–`10`**: short skirts. **Tier B ring 8 × 2**. `light_08_sa` (both sexes) has long shoulder
  streamers (retail cloth, 48–78 free): tier A sash.
- **Heavy 04–10**: plates. Tier C (helmet plumes tier B).
- **`avatar_trader_01`, `avatar_hunter_01`** (both sexes): long coats with retail cloth. Tier A ring.

Which of these the wave actually ships is the new-clothing spec's choice; every one it picks gets its `rigs.json` row
in the same lane (§11).

### 2.5 The named slots (CLIMB §4.3)

| Slot | What | Cloth |
|---|---|---|
| **W15-A** Tomb Warden's set (CLIMB §4.3; TOMB_DUNGEON's proposed display name "Terracotta Regalia"; heavy, light, clothes) | CLIMB does not fix the shape; if the new-clothing spec makes the clothes set a robe | tier A ring on the clothes set; plates C |
| **W15-B** Tiger-Hunter's set | three classes | the clothes set: tail or hem if its shape has one (auto rule) |
| **W15-C** Ferryman's coat and hat | civilian coat | tier A tail 2 × 4; the hat's brim cord tassel |
| **W15-D** Millet Farmer's clothes | civilian short tunic | tier B hem ring |

### 2.6 Not this wave [decision]

- **Hair** (20 retail hair meshes carry cloth: ponytails, braids): the same system can drive them (a tassel chain on
  `Bip01 Head`), but the user asked for clothes. A hook (§13), ≈ 0.5 day later.
- **The townsfolk crowd** (VAT): no live sim; a baked swing is lane CL-V, the first thing cut (§15).
- **Monsters and mounts**: none have garments.
- **Standing NPCs** (shopkeepers): they do not move; cloth off for NPC actors except the walking ones [decision:
  reason: no visible gain].

---

## 3. Chain kinds [decision]

All kinds use the same sim (§6); the kind only decides where the auto-rig puts the chains and which defaults apply.

| Kind | Placement | Parent | Default chains | Collides with |
|---|---|---|---|---|
| `ring` | closed loop round the hips, chain k at azimuth 2πk/K, joints on the garment's own surface from the waist band to the hem | `Bip01 Pelvis` | robe 12 × 4, dress 10 × 4, short skirt 8 × 2 | thighs, calves |
| `fan` | open row over a panel's azimuth arc (from its vertices), K ≥ 2 | `Bip01 Pelvis` | 4 × 4 (long), 4 × 3 | thighs, calves |
| `tail` | 1–2 chains down the back (or front) centre | `Bip01 Pelvis` (coats: `Bip01 Spine`) | 2 × 4 | thighs, calves |
| `sleeve` | 1–2 chains hanging from the forearm's lower side | `Bip01 L/R Forearm` | 2 × 2 per arm | – (cheap; no arm capsules) |
| `sash` | 1 chain per ribbon from its pinned end | the pinned vertices' bone | 1 × 4 each | thighs, calves |
| `tassel` | 1–2 chains on a hat or helmet's free vertices | `Bip01 Head` | 1–2 × 3 | – |
| `cape` | the skeleton's own `cloak01`–`04` (no new bones) for new capes; a 3 × 4 fan on `Bip01 Spine1` when wider | `Bip01 Spine1` | 1 × 4 / 3 × 4 | a back capsule (Spine1 → Pelvis) |

**Per-actor cap: 64 chain bones** (a robe 48 + a tassel 6 + sleeves 8 fits) [decision: reason: keeps the garment
skeleton under 110 bones and the per-actor cost bounded].

---

## 4. The auto-rig (converter) [decision; prototyped]

### 4.1 Where

`packages/convert/src/equipment/cloth-rig.ts` (new), run by **`pnpm sro cloth [--only <item>] [--sheet]`** after the
equipment export; it reads the retail BMS (for the cloth section) and the exported skinned glb, and writes
`<item>.cloth.glb` + the sidecar's `cloth` block next to the item. Deterministic (no randomness, sorted inputs); a
re-run with the same inputs is byte-identical (a test) [decision: reason: auto-rig in TS is testable, re-runs on every
convert, and needs no Blender on the build path; ~70 garment meshes by hand would not scale].

**Blender** is the optional fix-up pass (lane CL-B, cut first): `pnpm sro cloth --blend <item>` writes a `.blend` with
the garment and the chain armature; moved joints come back as `content/cloth/overrides/<item>.json` (joint positions
only; the weights are recomputed). Headless Blender 5.2, bmesh only, like the moves pipeline.

### 4.2 Placement and weights (as prototyped in `work/tmp/cloth/proto.ts` `autoRig`)

1. **Select** the region: the retail free vertices (a cloth section), else the vertices below `topY`
   (`pelvis − 0.04 m` by default; `rigs.json` can set it).
2. **Chains**: azimuths from the kind (§3); joint j of chain k sits at height `topY − (topY − hemY)·j/N` and at the
   **mean radius** of the selected vertices in that azimuth and height bin (fallback: a wider bin), so the chains follow
   the garment's flare.
3. **Weights**: by azimuth, the two neighbouring chains (linear); by height, the segment containing the vertex and its
   neighbour (½–1–½ across each joint, continuous); the top 4 influences, renormalised. **≤ 4 influences** (the same
   vertex format as today).
4. **The waist band**: the first 0.6 segment blends the retail weights into the chain weights (no seam at the belt).
   **Retail pinned vertices and everything above `topY` keep their retail weights byte for byte** (a test).
5. **Anchors** (§6.3): each chain joint stores the averaged retail weights of its 6 nearest garment vertices (≤ 2 bones
   kept), so the runtime can place the joint where the retail skinning would.
6. **Rest data**: segment lengths and ring gaps come from the bind positions; the retail `maxDistance` (if any) scales
   the per-level tether (relative: `tether_j × maxD(vertex) / max maxD`).

### 4.3 Checks (the CLI fails on any)

- every chain set has an `owner` whose worn-alone result passes the other checks, and every `uses` item's cloth glb
  names only joints of its owner's set (§4.5);
- every chain has ≥ 1 vertex with weight > 0.25 on it (no dead chains: the prototype's first woman ring had empty
  back chains, which is why a panel is a `fan`);
- the bind pose renders identical to the retail glb within 1 mm (weights change, bind positions do not);
- no chain joint inside a thigh capsule at bind;
- the `--sheet` render: every rigged garment front/side with its chains (a review image for the lane's user check).

### 4.5 Chain sets that span several items [decision; fact-check F2]

A robe is often two worn items: the prototype's `clothes_08` ring re-weights 167 vertices of the leg item `_la` **and**
11 of the chest item `_ba` (the tunic's hem below the band) [confirmed: `proto-rigs.json`], and players wear chest and
leg items of different sets.

- A **chain set** is keyed by set and sex (`man/clothes_08`). One item **owns** it (the one with the most hanging
  vertices: `_la` for the robes, `_ba` for the woman's panels); the set's other items **use** it.
- The owner's cloth glb carries the set's chain joints. A `uses` item's cloth glb carries only the chain joints it
  weights (often the top level only), with the **same names**.
- Runtime: one sim state per chain set per actor. The `ClothSystem` owns one `TransformNode` per chain joint (children of
  the actor's parent joint node) and registers them in the actor's joint map **before** `bindSkinned` runs, so every
  cloth glb's `cloth_*` bones link to them by name through the existing loop (§1.1): one sim, any number of items, no
  seam.
- A `uses` item loads its **cloth** glb only while its owner is worn and simulated; with another set's leg item it loads
  its plain glb (retail weights), which is today's look.
- `rigs.json` rows gain `"set": "man/clothes_08"` and `"role": "owner" | "uses"`.

---

## 5. Data formats [decision]

### 5.1 Authoring (`content/cloth/`)

```jsonc
// content/cloth/rigs.json: one row per garment mesh that gets chains (the auto rule fills the rest, §2.2)
{ "version": 1, "rigs": [
  { "item": "woman_item/clothes_03_ba", "mesh": "clothes_03_ba_2s", "kind": "fan", "K": 4, "N": 4, "tune": "panel" },
  { "item": "woman_item/clothes_03_ba", "mesh": "clothes_03_ba", "kind": "ring", "K": 8, "N": 2, "topY": -0.05, "tune": "hem" },
  { "item": "man_item/clothes_08_la", "mesh": "clothes_08_la", "kind": "ring", "K": 12, "N": 4, "tune": "robe", "set": "man/clothes_08", "role": "owner" },
  { "item": "man_item/clothes_08_ba", "mesh": "clothes_08_ba", "set": "man/clothes_08", "role": "uses" },
  { "item": "man_item/heavy_01_ha", "kind": "tassel", "K": 2, "N": 3, "tune": "tassel" }
]}
// content/cloth/tunes.json: per level j = 0..N (0 = the pinned root)
{ "version": 1, "tunes": {
  "robe":  { "stiffness": [0, 0.10, 0.07, 0.05, 0.04], "tether": [0, 0.10, 0.22, 0.34, 0.45],
             "follow": [0, 0.35, 0.5, 0.6, 0.6], "drag": 0.10, "gravity": 9.8, "radius": 0.025 },
  "panel": { "stiffness": [0, 0.10, 0.07, 0.05, 0.04], "tether": [0, 0.10, 0.20, 0.30, 0.40],
             "follow": [0, 0.3, 0.4, 0.5, 0.5], "drag": 0.10, "gravity": 9.8, "radius": 0.025 }
  // hem, tail, sleeve, sash, tassel, cape: same shape
}, "capsules": { "europeman_skel": { "thigh": 0.085, "calf": 0.06, "foot": 0.05 }, "europewoman_skel": { "thigh": 0.077, "calf": 0.054, "foot": 0.045 } },
   "poseOverrides": { "SIT": 1, "SIT_DOWN": 1, "STAND_UP": 1, "VENDOR01": 1, "DIE1": 1, "DOWN": 1, "DOWN_RM": 1,
                      "DOWN_DIE": 1, "DOWN_DAMAGE": 1, "DOWN_UP": 1 } }
```

`topY` in `rigs.json` is relative to the pelvis (metres). `poseOverrides` = clips during which the chains go
kinematic (follow 1, no sim) with a 0.3 s blend: sitting and lying poses fold the legs through any hanging cloth.

### 5.2 The exported garment

- **`/out/equipment/china/<sex>_item/<name>.cloth.glb`**: the retail mesh and materials **unchanged** (same images,
  so the wave's dyes apply as to the plain glb), a skin with the 43/45 retail joints **in the same order**, then the
  chain joints `cloth_<k>_<j>` (k chain, j 0..N−1 segment start), each a child of its parent bone, identity rotation at
  bind, inverse binds from their bind positions; JOINTS_0/WEIGHTS_0 rewritten for the rigged vertices only.
- **The `cloth` block** (version 1), in the cloth glb's root-node `extras` (Babylon's loader exposes it as
  `metadata.gltf.extras`), and mirrored in the sidecar for tools:
  `{ set, role, kind, parent, K, N, closed, tune, joints: [first chain joint index], bind: number[(N+1)·K·3],
  anchors: [[joint, weight, joint, weight] per chain joint], tetherScale?: number[], retail: { params?, freeVertices } }`
  [decision: reason: `dress()` fetches no sidecar for skinned items (fact-check F5), and one file keeps the glb and its
  rig atomic with no extra request].
- **Equipment manifest**: `items[].model.cloth?: { glb, sidecar }` (optional; absent = no cloth), typed in
  `packages/appearance/src/manifest.ts` `EquipmentModel` and carried by `compose.ts` `BoundItem.cloth?` (additive; the
  version check `isEquipmentManifest` ignores extra fields). Content check: the cloth glb's first 43/45 joints equal
  the plain glb's.
- Size: + the chain joints and the inverse binds (≤ 64 × 64 B) per garment; the cloth glbs exist only for rigged
  garments (≈ 20 in-game meshes now, + the new sets) ≈ +2–4 MB in `out/` before optimize [projected].

---

## 6. Runtime [decision; prototyped]

### 6.1 Modules

- **`apps/game/src/three/cloth-sim.ts`** (pure, no Babylon import; the prototype's `work/tmp/cloth/cloth-sim.ts` is
  its draft): `createState(rig)`, `targets(rig, state, …)`, `step(rig, state, capsules)`. Typed arrays only, **no
  allocation per tick**. It runs in a worker unchanged if ever needed.
- **`apps/game/src/three/cloth.ts`** (new): `ClothSystem`: creates an actor's chain `TransformNode`s (§4.5) and
  registers its cloth garments on dress (`applyDress` → `bindSkinned` sees `item.cloth`), picks each actor's tier every
  250 ms (§6.5), runs the ticks after the frame's animations and before skinning (`scene.onBeforeRenderObservable`,
  after `lodActors`; Babylon 9.28 animates before that observable and prepares skeletons after it [confirmed:
  `scene.pure.js` `render`]), writes the chain nodes (position and rotation local to the parent bone, with `.set`/
  `copyFrom` only: the frame's p95 is GC-driven, `wave11/budgets.md`), drops everything on `removeWorn`/dispose.
- **`models.ts` `dress()`** (the load) and **`@sro/appearance` `compose.ts`** (the plan): on PBR presets with cloth not
  off, a sim-tier actor's item loads `model.cloth.glb` instead of `model.glb`; on Low/Classic it never does (**the Low
  guard: Low loads byte-identical files and runs no cloth code**). `apps/game/src/three/equipment.ts` (the manifest
  fetch) is unchanged.
- **Single-garment swap** (new `CharacterActor.swapWorn(code, container)`): replaces one worn item's instance from a
  cached container without the full re-dress (which re-binds every item and rebuilds the merge). Used on tier changes
  (§6.5), at most one per actor per 250 ms plan and two per plan in all.

### 6.2 The step (as `cloth-sim.ts`)

Per actor per tick (fixed **1/60 s**): roots (j = 0) snap to their animated position; then for each particle, root to
tip: `x' = x + (x − x_prev)(1 − drag) + (want − x)·stiffness_j + g·dt²` where `want` = the simulated parent + the
animated rest offset (VRM spring-bone style); **segment length** restored; **2 ring passes** (neighbours at a level stay
within 0.6×–1.15× their rest gap: no tearing, no bunching); **capsule push-out** (thighs, calves, feet; a back capsule
for capes); length again; **tether** (|x − animated target| ≤ tether_j); a **ground plane** at the actor's feet + 1 cm.
Per-level stiffness falls toward the hem, tether grows: the waist is firm, the hem swings.

**Collision that actually holds the legs in** [decision; fact-check F3]. The prototype's sim tests **particles** against
capsules only (`cloth-sim.ts` `pushOut`); 12 chains round a ≈ 0.35 m hem sit ≈ 18 cm apart, wider than a calf, so a
shin passes **between** two particles and through the skinned cloth in most RUN strides [confirmed: `cloth-proto.gif`
frames 18–66, 96–114]. The shipped step adds, per tick: (1) the **ring edges** at each level and the **vertical
segments** tested against the leg capsules (closest point on the segment, both ends pushed by their weights), (2) a
**foot capsule** (`Foot → Toe0`, the boots stick out furthest), (3) the particle radius of a level at least half its
rest ring gap. The cost is ≈ 2× the capsule part of the step (≈ +3–5 µs for a 12 × 4 robe) [projected]. A hem that
cannot reach a kicked shin within its tether still lets it out *below* the hem, which is how a real robe looks; the
check is "no shin through the surface", not "no shin visible".

The prototype's `cloth-sim.ts` has neither the ground plane nor the `follow` blend (both live in `proto.ts`), so the
12.1 µs bench is the bare step plus pelvis-rigid targets.

### 6.3 Targets: the "follow" blend (the prototype's fix for legs through robes)

The animated target of a chain joint is `lerp(pelvisRigid, retailAnchor, follow_j)`: `pelvisRigid` moves with the
pelvis only, `retailAnchor` is where the retail weights put that point (it follows the legs). With `follow` 0 the
first prototype's robe hung straight while the legs kicked through its front; with 0.35–0.6 it moves with the stride
and still trails and swings [confirmed: the final `cloth-proto-sheet.png` and `cloth-proto.gif`; the intermediate
iterations were not kept]. The **kinematic
mode** (§6.5 warm actors, §6.4 pose overrides) is simply "x = target with follow 1": the retail look, no sim.

### 6.4 No jitter, no lag [decision]

- **Fixed step + deviation rendering**: the sim runs in world space at 60 Hz with an accumulator (≤ 2 ticks a frame;
  more is dropped, not queued). What is drawn each frame is `target_now + lerp(d_prev, d_last, α)`, where `d = x − target`
  at the last two ticks and `α` the accumulator fraction. The body moves every frame; the cloth's *deviation* is
  interpolated, so at 144 Hz nothing shakes, and at 5.5 m/s (the server's run) the cloth never trails the body by a
  tick's 9 cm
  [decision: reason: plain fixed steps lag or stutter at refresh rates ≠ 60; variable-dt verlet is not stable].
- **Determinism**: same inputs → same bytes (`Math.fround`-free float32 arrays, fixed order); a test steps 600 ticks
  twice and compares.
- **Resets**: a root jump > 1.5 m in one tick (teleport, rubber-band, a warp, a re-dress), a frame gap > 0.25 s
  (tab hidden), a tier change from warm (kinematic) → sim, or a plain → cloth swap: the particles snap to the targets (velocity 0).
- **Pose overrides** (§5.1): sitting, lying, dying, vendor → kinematic with a 0.3 s blend.
- **Mounted**: the robe hangs over the horse; capsules as usual; the hips' motion drives it.
- **Wind** (High/Ultra, scope-cut item): the weather's CPU wind (`WeatherUniforms.wxB`: direction x/z and strength
  0–1, the values the GPU's `sroWind` reads) adds `0.3 × wind × j/N` per particle; calm = none.

### 6.5 Tiers and counts [decision]

Every 250 ms (with the crowd plan, `PLAN_MS`) the system ranks actors that wear an item with a cloth glb: **own player,
party, target, then by distance**; an actor is a **sim** actor when within **20 m** of the camera target, on screen, at
full pose rate (in a crowd the budget floors others' rates beyond `CLOSE_M` = 15 m, so there sim reaches 15 m for
non-`keep` actors), and inside the preset's count; a 3 m distance hysteresis, as for the shadow casters, keeps the
rank stable.

- **Sim**: wears the cloth glb, simulates.
- **Warm** (the next 2 by rank, or a sim actor that just dropped out, for ≥ 2 s): keeps the cloth glb, chains
  **kinematic** (placed by the anchors at its pose rate), so a rank flicker costs no swap.
- **Plain** (everyone else): wears **today's plain glb** (retail weights): no skeleton of its own, no cloth code, and
  still mergeable by the wave's character-cost foundation [decision: reason: a kinematic chain at follow 1 only
  reproduces the retail look the plain glb already gives, and in the 20-player plaza every other player is within
  15 m and so updates every frame: 15 kinematic actors would cost 0.3–0.5 ms for no visible gain (fact-check F1)].
- Plain ↔ cloth is a **single-garment swap** (§6.1 `swapWorn`) from the cached container, loaded on first need; the
  cloth starts at its targets (a reset), so the swap shows no jump. Swaps are capped (2 per plan) and LAB-CL1 records
  the swap frame's cost.

| Preset | Sim actors | Warm | Notes |
|---|---|---|---|
| Low / Classic | 0 | 0 | today's glbs, no cloth code (Low guard) |
| Medium | **5** (own + 4) | 2 | Apple / iGPU default: 3 sim |
| High | **10** | 2 | wind on |
| Ultra | **20** | 2 | wind on |

### 6.6 What it does not change

Draw calls, materials, shader defines (bone texture path), vertex format (4 influences), shadows (the caster skins the
same bones), the part merge, picking, the network (cloth is local and cosmetic: no protocol change).

**What it must follow: Volume** [decision; fact-check F4]. `setVolume` scales the Pelvis and Thigh skin matrices
radially and reaches the cloth glb's own skeleton too (it loops over worn skeletons), but chain-weighted vertices are
not on those bones. So the `ClothSystem` scales each chain set's rest ring (bind radii about the pelvis axis) by the
actor's Pelvis factor and the thigh/calf capsule radii by its Thigh factor, re-applied on `setVolume`. Test: at Volume
0 and 4, the rigged garment's bind pose stays outside the scaled body within 1 cm.

**What it must not block: the character-cost foundation.** `buildMerge` keys on the skeleton, so a cloth garment
(own skeleton) never merges; under §6.5 only the ≤ 7 sim/warm actors wear one, so a foundation that merges worn items
per character still merges every plain-tier player. If the foundation instead extends each actor's skeleton, the chain
bones can be appended to it (§17's fallback) and the cloth glb shares it.

---

## 7. Costs [confirmed where tagged; dev PC = Ryzen 5 9600X + RX 9060 XT]

| Item | Number | Tag |
|---|---|---|
| Sim step, robe (12 × 4 = 48 particles, 4 capsules, 2 ring passes) | **12.1 µs / tick** (10.6 µs with 10 × 4) | [confirmed: `pnpm tsx work/tmp/cloth/proto.ts --bench`, Node 24, 10,000 ticks after 2,000 warm-up] |
| Anchors + bone matrices, prototype form (allocating Float64 matrices) | 48.7 + 23.6 µs | [confirmed, not representative] |
| Anchors + bone matrices, shipped form (2-bone anchors, float32 scratch, no allocation) | 6–10 µs | [projected: ≈ 60 joints × 2 transforms + 48 arc rotations] |
| Edge-vs-capsule collision and foot capsules (§6.2) | +3–5 µs a tick | [projected] |
| Babylon: the garment's own skeleton (≈ 91 bones prepared, a 5.8 KB bone texture upload) | 15–30 µs a frame | [projected; scaled from the rescue profile: skeleton prepare ≈ 10.7 % of active-mesh evaluation for ≈ 40 skeletons of 43 bones, `w11-rescue/bench.md`; LAB-CL1 measures] |
| **Per sim actor, per frame at 60 fps** | **≈ 35–55 µs** | [projected] |
| Per warm actor (kinematic, at its pose rate) | ≈ 20–35 µs per update | [projected] |
| Per plain actor | 0 (today's glb) | [confirmed by design] |
| ~~Medium as first written: 5 sim + 15 kinematic "at ≈ 15 Hz"~~ | the 15 update every frame within 15 m: **≈ 0.5–0.8 ms**, over the gate | [projected; fact-check F1] |
| **Medium** (5 sim + 2 warm), dev PC | **+0.22–0.35 ms CPU p95** | [projected] |
| High (10 + 2) / Ultra (20 + 2), dev PC | +0.4–0.62 / +0.75–1.17 ms | [projected] |
| Mid desktop or gaming laptop (BATCHING F20: CPU ×1.5–2) | Medium +0.33–0.7 ms; the Apple/iGPU default (3 sim) +0.2–0.45 ms | [projected] |
| A 30 fps frame (2 ticks a frame) | the sim part doubles (+12–16 µs per sim actor) | [projected] |
| A plain ↔ cloth swap (one garment instantiate, cached container) | one frame, ≈ 0.2–1 ms [unknown]; ≤ 2 per 250 ms | [unknown; LAB-CL1 records it] |
| GPU | ≈ 0 (same vertices, same influences) | [confirmed by design] |
| Memory | ≈ 1 KB of state per actor; + ≈ 100–200 KB per cloth glb loaded | [projected] |

**Why not a worker** [decision]: the work is 35–50 µs an actor; a worker adds a frame of latency, a transfer per frame,
and SharedArrayBuffer needs cross-origin isolation (COOP/COEP) the site may not have [unknown]. The module stays
worker-ready. **Why not GPU compute** [decision]: WebGPU only (WebGL2 parity is a G1 rule), and 48 particles do not fill
a dispatch.

---

## 8. Settings and UI [decision]

- `settings.ts`: `ClothSetting = 'auto' | 'off' | 'near' | 'full'` with `clothFor(s, e, gpu)` on the `townLifeFor`
  pattern: off on Classic (Low); `'auto'` = the preset's counts (§6.5), 3 on Apple/iGPU; `'near'` = own player + party
  only; `'full'` = the preset's counts on every device.
- **Options → Graphics → "Cloth physics"**: Auto / Off / Near / Full (live text, docs/UI.md rules), next to Town life.
  Live switch: off → on swaps the sim-tier actors' garments to the cloth glbs (one load each, `swapWorn`), on → off back
  to the plain ones; no leak (a test).
- Perf overlay: `cloth: sim n / kin m / µs`.

---

### 8.1 Interactions with the other wave-14 work

- **Dyes**: the cloth glb shares images and materials with the plain glb, so a dye mask applies identically [decision].
- **New clothing**: every new garment with a hanging part ships its `rigs.json` row and passes §4.3 in its own lane.
- **Townsfolk outfits**: VAT crowd; cloth only through CL-V (cut first).
- **Character-cost foundation**: §10's gate depends on it landing first.
- **Remaster sets** (Meshy textures, `out/remaster/`): texture-only; unaffected.

---

## 9. The prototype

### 9.1 What was built [confirmed: `work/tmp/cloth/`]

- `survey.ts` (the BSR/BMS survey → `survey.json`), `an1–3.py` (tables), `dump.ts` + `sheet.py` (the two survey
  sheets), `probe.ts` (one cloth mesh in detail).
- `eq.ts`: the retail `clothes_08` (man) and `clothes_03` (woman) ba/la/fa/aa as skinned glbs through the converter's
  own `convertSkinnedItem`, into `work/tmp/cloth/eq/` (scratch; nothing in `work/out` touched; also `conv/` from a
  `pnpm sro convert --out work/tmp/cloth/conv` check).
- `cloth-sim.ts`: the sim as it would ship (pure TS). `proto.ts`: the retail bodies, RUN and STAND1 from the character
  glbs, JUMP_RUN from the movement pack, the auto-rig, CPU skinning with the chain bones, a small software rasteriser
  (deterministic frames), 4.9 s at 30 fps, both rows. `gif.py`: the GIF and the still sheet.
- Rigs: the robe ring 12 × 4 (48 bones; 167 `clothes_08_la` + 11 `clothes_08_ba` vertices re-weighted); the skirt
  panel fan 4 × 4 (16 bones; 30 of `clothes_03_ba_2s`'s 43 vertices) [confirmed: `proto-rigs.json`].

### 9.2 What it shows

- **Top row (today)**: the robe's skirt is split between the two legs and opens into a tent at every stride and in
  the jump; the woman's long panel is a board fixed to her thigh.
- **Bottom row (chains)**: the robe hangs, trails behind the run, lifts and lags in the jump, settles in ≈ 1 s after
  the stop; the panel trails between the legs and floats in the jump. No jitter at 60 Hz ticks.
- **Weak spots found** (fed into the spec): legs poke through a robe's front in big strides when the chains are
  pelvis-rigid (improved by `follow`, §6.3); empty chains on a ring round a front-only panel (fixed: `fan` + the
  dead-chain check, §4.3).
- **Still visible in the final GIF** (fact-check F3): with `follow`, the back shin and the `clothes_08_fa` boot still
  cross the robe's surface in **most RUN frames**, and both lower legs in the jump (t = 1.83 s, 2.07 s, and the run at
  3.17 s) [confirmed: `cloth-proto.gif` frames 18–66 and 96–114, `cloth-proto-sheet.png`]. The cause is structural
  (particle-only collision with ≈ 18 cm between hem chains, no foot capsule), so §6.2's edge collision is part of CL-S,
  not a tuning item; the woman's panel shows no such problem. The prototype was not re-run with the fix [unknown until
  CL-S].
- Not in the prototype: Babylon, the deviation rendering (frames align to ticks), wind, sleeves, tassels, retail
  pinned flags (it selected by height).

### 9.3 Images

- **`work/tmp/cloth/cloth-proto.gif`** (147 frames, 500 × 694, 6 MB): the prototype. Its frames are stored at 30 ms
  (4.4 s of playback for 4.9 s of motion), so it plays ≈ 10 % fast.
- `work/tmp/cloth/cloth-proto-sheet.png`: 7 stills (stand, run, jump take-off, apex, landing, run, stopped).
- `work/tmp/cloth/survey_ingame.png`, `work/tmp/cloth/survey_retail_4_10.png`: the survey sheets.

---

## 10. Budgets and LAB rows (added to the wave's LAB and gate)

| Row | Measure | Gate |
|---|---|---|
| LAB-CL1 | Plaza, 20 players in robes and long skirts jumping (the harness's 8 m ring: everyone within 15 m), WebGPU and WebGL2 Medium, cloth Auto vs Off, 3 runs, median p95, GPU lock, quiet machine; also a walk-through of the crowd so ranks change (the swap frames) | `on − off ≤ 0.35 ms` CPU p95 **and** the scene < 16.7 ms on both backends (G1); the perf counter shows ≤ 5 sim + 2 warm, the rest plain. If the foundation has not brought the scene under ≈ 15.5 ms first, Medium ships with `'near'` (own + party) and the counts move to High [decision] |
| LAB-CL2 | Same, High and Ultra | on − off ≤ 0.7 / 1.3 ms. WebGL2 High plaza is already 8.2 ms against G2's ≤ 8 (`wave11/budgets.md`): record the widened G2 miss (G2 does not block a release) |
| LAB-CL3 | 144 Hz display (or a forced 7 ms frame): the own player running, the cloth-to-body gap | ≤ 1 cm; no visible shake in a 10 s capture |
| LAB-CL4 | Tiger Girl 20 attackers, Medium | no change in the fight's p95 beyond LAB-CL1's delta |
| LAB-CL5 | Low | byte-identical draw list and no cloth module loaded (the Low guard) |

---

## 11. Seams with the other lanes

- `models.ts` (`bindSkinned`, `removeWorn`, dispose, `setVolume`): **one hook** each (register/unregister with
  `ClothSystem`; the chain nodes go into the actor's joint map before `bindSkinned`); the linked-skeleton path already
  exists. Plus the new `swapWorn` (one garment) and, in `dress()`, the cloth-glb pick per item. Owner: the wave's
  game-spine seam agent; CL-G owns `cloth.ts`.
- `packages/appearance` (`manifest.ts` `EquipmentModel.cloth?`, `compose.ts` `BoundItem.cloth?`): additive; the same
  seam agent (the viewer and the converter tests call `composeEquipment` too and ignore the field).
  `apps/game/src/three/equipment.ts` is untouched.
- The character-cost foundation (sibling spec): it owns `buildMerge`/any worn-item merge; cloth needs only that a
  garment with its own skeleton stays a separate draw (already true: the merge key includes the skeleton).
- `settings.ts`, `hud/options.ts`, i18n: one row (the seam agent registers, CL-G fills).
- Converter: `cli.ts` gets the `cloth` verb line (the converter seam agent); `cloth-rig.ts` is CL-R's;
  `equipment/manifest.ts` gets the optional `model.cloth` (CL-R, additive, version unchanged).
- The new-clothing lanes add `rigs.json` rows for their garments (they own those rows; CL-R owns the file's format).

---

## 12. Decisions (each the recommended option; the user delegated)

| # | Decision | Reason |
|---|---|---|
| CL-D1 | Spring-bone chains, not per-vertex cloth | bones keep the GPU path, vertex format and draws unchanged; 16–48 particles per garment instead of hundreds of vertices |
| CL-D2 | An **auto-rig in the converter** (TS), Blender only as an optional fix-up | deterministic, testable, re-runs on every convert; ~20 meshes now and many more with the new clothing |
| CL-D3 | **Use the retail cloth data** (pinned/free, maxDistance) where present | the retail artists marked what should swing; it restores lost behaviour |
| CL-D4 | Tiers A/B/C and the kinds of §3; the level-1–20 table of §2.3 | the visible wins first; trousers and plates are already right |
| CL-D5 | A separate `<item>.cloth.glb`; Low and Classic load today's files | the Low guard stays green; one variant per rigged garment only |
| CL-D6 | Bind through the existing "joints differ → own skeleton, linked by name" path; the chain nodes are the `ClothSystem`'s, in the actor's joint map, so items of one chain set share one sim (§4.5) | no change to the body skeleton or the part merge; the path is tested. Volume needs the §6.6 scaling of the rest ring and capsules |
| CL-D7 | CPU, main thread, worker-ready pure module | 35–50 µs an actor; worker latency and COOP/COEP are not worth it; GPU compute would break WebGL2 parity |
| CL-D8 | Fixed 60 Hz step, deviation interpolation, resets, pose overrides | no lag behind the body and no shake at any refresh rate |
| CL-D9 | Targets = `lerp(pelvisRigid, retailAnchor, follow)` | the prototype: pelvis-rigid lets legs through the robe; retail-only is today's tent |
| CL-D10 | Capsules on thighs, calves and feet (+ a back capsule for capes), tested against the chain **edges**, not only the particles; a ground plane | particle-only collision let shins through the robe in most run strides (fact-check F3); arms not needed for sleeves |
| CL-D11 | 20 m range; counts Medium 5 / High 10 / Ultra 20 (+ 2 warm); own, party, target first; **everyone else wears the plain glb** | the people you look at swing; non-sim chains would cost 0.3–0.5 ms in the plaza to reproduce the plain glb's look (fact-check F1) |
| CL-D12 | Cap 64 chain bones per actor | bounded cost and skeleton size |
| CL-D13 | Options → Graphics → Cloth physics (Auto/Off/Near/Full), `clothFor` on the `townLifeFor` pattern | a known pattern; the player can turn it off |
| CL-D14 | Medium ships cloth only if LAB-CL1 passes after the foundation; else Medium = Near | G1 first (the standing goal) |
| CL-D15 | Hair, the crowd's baked swing, wind and the Blender round trip are hooks or the first cuts | the user asked for clothes; each is separable |
| CL-D16 | Shared images and materials between the plain and cloth glbs | dyes and remaster textures apply unchanged |
| CL-D17 | Cloth is local and cosmetic: no protocol or server change | nothing gameplay-relevant moves |
| CL-D18 | Chain sets span the items of one set (`owner`/`uses`, §4.5) | the robes are two worn items; one sim per robe, and mixed sets fall back to the plain glb |
| CL-D19 | The rig block rides in the cloth glb's extras | `dress()` fetches no sidecar for skinned items; one atomic file |
| CL-D20 | Chain rest ring and capsules scale with Volume | Volume widens hips and thighs only for vertices on those bones |

## 13. Needs from the user

- **None to start.** The look is the user's check (below), as for every wave.
- **User checks**: (1) `work/tmp/cloth/cloth-proto.gif`: is the swing the right amount (more, less)? (It plays about
  10 % fast, and the robe's shins still poke through while running: that is fixed in CL-S, not a tuning question.) (2) In the build:
  the own character in `clothes_03` and in a new robe, running and jumping in the plaza; Options → Cloth physics Off
  vs Auto.
- The wave's deploy OK, as always (cloth adds no migration).

## 14. Open questions (each with the default used meanwhile)

| # | Question | Default |
|---|---|---|
| Q1 | Should hair (ponytails, braids; 20 retail meshes with cloth) swing too? | Not this wave; the hook is ready (≈ 0.5 day) |
| Q2 | Swing amount: the prototype tune, or livelier/stiffer? | The prototype tunes (§5.1); one tuning pass in CL-L with before/after clips for the user |
| Q3 | Other players' cloth on Medium by default? | Yes, own + 4 nearest (Near if LAB-CL1 fails) |
| Q4 | The retail cloth parameters (`elasticity`, `fallingSpeed`, `movementFactor`) | Kept in the sidecar, not used; our tunes rule (their semantics are [unknown]) |

## 15. Lanes

### 15.1 Step order (inside wave 14; the wave plan merges it with the siblings)

Step 0 (seams): the `models.ts`/`equipment.ts`/`settings.ts`/`cli.ts` hooks by the seam agents. Step 1: CL-R and CL-S
in parallel (new files only), then CL-G. Step 2: CL-L (LAB and tuning, GPU queue), the new-clothing rows. Step 3: CL-V,
CL-B if not cut.

### 15.2 The lanes

| Lane | Files | Seams | Tests | User check | Effort |
|---|---|---|---|---|---|
| **CL-R** rig + export | `packages/convert/src/equipment/cloth-rig.ts` (new), `content/cloth/{rigs,tunes}.json` (new), the `cloth` verb body, `equipment/manifest.ts` (`model.cloth`, additive) | `cli.ts` line (seam agent) | `cloth-rig.test.ts`: ≤ 4 influences summing to 1; pinned and above-band vertices byte-identical to the plain glb; bind pose within 1 mm; no dead chain; first 43/45 joints equal; deterministic re-run; the §2.3 table's 20 meshes rig; the robe's `owner`/`uses` pair names the same chain joints; the rig block round-trips through the glb extras | the `--sheet` review image | M, 1.5 days |
| **CL-S** sim | `apps/game/src/three/cloth-sim.ts` (+ test) | none | `cloth-sim.test.ts`: determinism (600 ticks twice, same bytes); settles to the targets within 2 s at rest; no particle **and no ring/vertical edge** inside a leg or foot capsule after a step (a calf swept between two hem chains); tether held; teleport reset; no NaN on zero-length segments; no allocation per tick; plus the prototype re-rendered with the edge collision (the GIF's RUN frames, no shin through the surface) | the re-rendered GIF | S–M, 1.5 days |
| **CL-G** game | `apps/game/src/three/cloth.ts` (new), its registration, the options row text, perf overlay counter | `models.ts` (hooks, `swapWorn`, `dress()` pick), `@sro/appearance` (`cloth?`), `settings.ts` (seam agent) | `cloth.test.ts` (NullEngine): tiers and counts per preset (sim, warm, plain), own/party/target first, hysteresis (no swap churn at the rank edge), ≤ 2 swaps per plan; a plain actor has no cloth skeleton; one sim for the robe's two items; a `uses` item with another set's leg item loads its plain glb; Volume 0/4 keeps the bind outside the body; Low loads no cloth glb and no module; live Off ↔ Auto leaves nothing behind; no allocation per frame; the deviation render keeps the gap ≤ 1 cm at a 7 ms frame | own character in `clothes_03`, run/jump; Off vs Auto | M, 2.5 days |
| **CL-L** LAB + tuning | the LAB-CL1–5 rows in the wave's bench, `content/cloth/tunes.json` values | GPU queue | the LAB rows | before/after clips per tune | S–M, 1 day |
| **CL-W** wind + hats/sleeves | `cloth.ts` wind term; `rigs.json` rows for hats and sleeves | – | wind off = byte-identical step | – | S, 0.5 day |
| **CL-V** crowd baked swing | `packages/convert/src/town/vat.ts`: a generic 8 × 3 ring baked into each skeleton's VAT (the sim run over the loop, the seam blended) | TL-V's VAT format (+24 bones) | `town-vat.test.ts` still within 1/3 mm; VAT ≤ +2 MB | the plaza crowd in robes | M, 1.5 days |
| **CL-B** Blender fix-up | `pnpm sro cloth --blend`, `content/cloth/overrides/` | – | round trip keeps the weights rule | – | S, 0.5 day |

Effort without CL-V and CL-B: ≈ 7 agent-days (the fact-check's edge collision, chain sets, swap and Volume add ≈ 1);
with them ≈ 9.

### 15.3 Hunt lenses (added to the wave's hunt)

Legs through robes (run, jump, dodge, mounted); cloth after a teleport, a GM warp, a re-dress, a tab switch; 144 Hz
and 30 fps; sitting and vendor poses; a party of 8 in robes at the 20 m edge (tier flicker, swap churn); Volume 0 and 4 in a robe; a robe's leg item with another set's chest item; Low byte-identity.

## 16. Scope-cut order (cut from the top) and never-cut

1. CL-B (the Blender fix-up).
2. CL-V (the crowd's baked swing).
3. Wind (CL-W part).
4. Sleeves and tassels (CL-W rest).
5. Tier B short hems and short skirts.
6. Other players' sim (own player only; others plain).
7. Medium (High and Ultra only).

**Never cut**: Low off and byte-identical; the tier-A garment panels on the own player (the user's "garmet"); the
deviation rendering (no lag); the edge collision (§6.2); the LAB-CL1 gate.

## 17. Risks

| Risk | Odds | Effect | Answer |
|---|---|---|---|
| The 20-player Medium scenes cannot afford it | real (they sit at the line) | Medium cloth limited | CL-D14: Near on Medium until the foundation frees ≥ 1 ms |
| Legs through long robes | **certain today** in most run strides (the prototype, F3); likely only at extremes after the edge collision | a shin through the cloth | §6.2 edge-vs-capsule + foot capsules (CL-S, re-rendered GIF), `follow`, per-tune tether; the hunt lens |
| The garment's own skeleton costs more than projected | possible | +µs per sim actor | LAB-CL1 measures; only ≤ 7 actors carry one (§6.5); fallback: append the chain bones to the actor's skeleton (one skeleton, a bigger bone texture) |
| Swap frames (plain ↔ cloth) spike the p95 | possible in a moving crowd | a 0.2–1 ms frame per swap [unknown] | ≤ 2 swaps per plan, 3 m hysteresis, the warm buffer; LAB-CL1's walk-through measures it; else raise the warm count |
| Slower CPUs (friends' laptops, ×1.5–2) | likely | Medium cloth +0.33–0.7 ms | the Apple/iGPU default of 3 sim; `'near'` is one Options click; LAB on the dev PC only, so the gate keeps a margin |
| Retail cloth semantics misread | low | a panel's mobility mask wrong | only the pinned/free split is relied on; tunes are ours |
| Rig dead spots on odd shapes (avatars, ribbons) | likely for a few | a patch of cloth does not move | `--sheet` review, `rigs.json` overrides, CL-B |
